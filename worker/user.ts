import { DurableObject } from 'cloudflare:workers';
import { getRecentTracksPage, getAlbumInfo } from '../shared/lastfm.ts';
import type { Config, LastfmError, Session } from '../shared/lastfm.ts';
import { getListensPage } from '../shared/listenbrainz.ts';
import { getRelease } from '../shared/musicbrainz.ts';
import { aggregate, albumKey, scrobbleReason, getTracklist, needsLookup, computeAlbum, albumTracks, extraTracks, normalizeTrack, sortAlbums, cacheKey, releaseOf, recordingAliases, countedTracks } from '../shared/rank.ts';
import type { AlbumPlays, AlbumResult, Aliases, Range, Scrobble, ScrobbleState } from '../shared/rank.ts';
import { shared } from './env.ts';
import type { Env } from './env.ts';
import type { AlbumCacheEntry } from './shared.ts';

const BUDGET = 40; // Last.fm fetches per alarm; the free plan allows 50 subrequests per invocation
const CONCURRENCY = 3; // parallel Last.fm calls; the throttle in shared/lastfm.ts still caps the request rate
type Status = 'running' | 'done' | 'error';
type Progress = { phase: 'scrobbles' | 'albums'; done: number; total: number };
type Data = { state: ScrobbleState; cache: Record<string, AlbumCacheEntry> };
type GridAlbum = AlbumResult & { key: string; image: string; url: string };
type Reply = { code: number; body: Record<string, any> };
type Source = 'lm' | 'lb'; // Last.fm | ListenBrainz
// mbid, releaseMbid: ListenBrainz only (trailing ones omitted when absent)
type Compact = [artist: string, album: string, track: string, uts: number, mbid?: string, releaseMbid?: string];

const fail = (code: number, message: string): Reply => ({ code, body: { status: 'error', message } });
const ok = (body: Record<string, any>): Reply => ({ code: 200, body });

const compact = (tracks: Scrobble[]): Compact[] =>
  tracks.filter((s) => !s['@attr']?.nowplaying).map((s) => {
    const row: Compact = [s.artist['#text'], s.album['#text'], s.name, Number(s.date!.uts)];
    if (s.releaseMbid) row.push(s.mbid ?? '', s.releaseMbid);
    else if (s.mbid) row.push(s.mbid);
    return row;
  });
const expand = (rows: Compact[]): Scrobble[] =>
  rows.map(([artist, album, name, uts, mbid, releaseMbid]) => ({
    artist: { '#text': artist }, album: { '#text': album }, name, date: { uts: String(uts) }, mbid: mbid || undefined, releaseMbid,
  }));

// Tracklist entry from a Last.fm album.getInfo result.
const lastfmEntry = (info: Awaited<ReturnType<typeof getAlbumInfo>>): AlbumCacheEntry =>
  info && { tracks: getTracklist(info), image: info.image?.find((i) => i.size === 'extralarge')?.['#text'] || '', url: info.url };

// One instance per user and source: Last.fm name lowercased, ListenBrainz `lb:` + name lowercased. Fetches in alarm chunks; ranks in memory.
export class UserDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  matches?: Record<string, Aliases>; // manual matches per albumKey, lazily loaded
  overrides?: Record<string, { artist: string; name: string }>; // owner-chosen Last.fm album per albumKey, lazily loaded
  ignoredTracks?: Record<string, Set<string>>; // normalized tracklist tracks that don't count, per albumKey, lazily loaded
  data?: Data; // aggregated scrobbles + album cache; rebuilt from storage after eviction

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, data TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS matches (album TEXT, played TEXT, track TEXT, PRIMARY KEY (album, played))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS overrides (album TEXT PRIMARY KEY, artist TEXT, name TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS ignored (album TEXT, track TEXT, PRIMARY KEY (album, track))');
  }

  private get<T>(k: string): T | undefined {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v as string) ?? undefined : undefined;
  }

  private set(values: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(values)) this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', k, JSON.stringify(v ?? null));
  }

  private isLb = () => this.get<Source>('source') === 'lb';

  // ListenBrainz has no login here: anyone may edit a ListenBrainz profile's matches (owner's choice).
  private isOwner(session: Session | null): boolean {
    if (this.isLb()) return true;
    return !!session && session.name.toLowerCase() === this.get<string>('user')?.toLowerCase();
  }

  private aliases(key: string): Aliases {
    if (!this.matches) {
      this.matches = {};
      for (const r of this.sql.exec('SELECT album, played, track FROM matches').toArray()) {
        let album = r.album as string;
        const [artist, name] = album.split('\u0000');
        const key = albumKey(artist, name);
        if (key !== album) {
          this.sql.exec('UPDATE OR REPLACE matches SET album = ? WHERE album = ? AND played = ?', key, album, r.played);
          album = key;
        }
        (this.matches[album] ??= {})[normalizeTrack(r.played as string)] = normalizeTrack(r.track as string);
      }
    }
    return this.matches[key] ?? {};
  }

  private override(key: string) {
    if (!this.overrides) {
      this.overrides = {};
      for (const r of this.sql.exec('SELECT album, artist, name FROM overrides').toArray()) this.overrides[r.album as string] = { artist: r.artist as string, name: r.name as string };
    }
    return this.overrides[key];
  }

  private ignored(key: string): Set<string> {
    if (!this.ignoredTracks) {
      this.ignoredTracks = {};
      for (const r of this.sql.exec('SELECT album, track FROM ignored').toArray()) (this.ignoredTracks[r.album as string] ??= new Set()).add(r.track as string);
    }
    return (this.ignoredTracks[key] ??= new Set());
  }

  private cacheKeyOf = (key: string, e: AlbumPlays) => cacheKey(key, e, this.override(key));

  // Manual matches of this (Last.fm) instance, to seed a ListenBrainz instance.
  exportMatches(): { album: string; played: string; track: string }[] {
    return this.sql.exec('SELECT album, played, track FROM matches').toArray() as any;
  }

  async start(user: string, session: Session | null, source: Source = 'lm'): Promise<{ status: Status | undefined }> {
    const status = this.get<Status>('status');
    const lb = source === 'lb';
    const isOwner = !lb && session?.name.toLowerCase() === user.toLowerCase(); // a ListenBrainz profile is never private
    if (status === 'running' || (this.get('private') && !isOwner)) return { status };
    if (lb && !this.get('matchesCopied')) {
      for (const m of await this.env.USER.get(this.env.USER.idFromName(user.toLowerCase())).exportMatches()) {
        this.sql.exec('INSERT OR IGNORE INTO matches VALUES (?, ?, ?)', m.album, m.played, m.track);
      }
      this.matches = undefined;
      this.set({ matchesCopied: true });
    }
    const lastUts = this.get<number>('lastUts');
    const resume = status === 'error' && this.get<Progress>('progress')?.phase === 'albums'; // scrobbles already stored
    this.set({
      status: 'running', message: null, code: null, user, source, private: isOwner, sk: isOwner ? session!.key : null,
      ...(!resume && {
        page: 1, pages: 1, maxTs: null, to: Math.floor(Date.now() / 1000), from: lastUts ? lastUts + 1 : null,
        progress: { phase: 'scrobbles', done: 0, total: 1 },
      }),
    });
    if (!resume) this.data = undefined;
    await this.ctx.storage.setAlarm(Date.now());
    return { status: 'running' };
  }

  async alarm(): Promise<void> {
    const cfg: Config = { apiKey: this.env.LASTFM_API_KEY, secret: this.env.LASTFM_SHARED_SECRET, fetches: 0 };
    try {
      if (this.get<Progress>('progress')!.phase === 'scrobbles') await (this.isLb() ? this.fetchListens(cfg) : this.fetchScrobbles(cfg));
      if (this.get<Progress>('progress')!.phase === 'albums') await this.fetchAlbums(cfg);
    } catch (err) {
      this.set({ status: 'error', message: (err as Error).message, code: (err as LastfmError).code });
      return;
    }
    if (this.get<Status>('status') === 'running') await this.ctx.storage.setAlarm(Date.now());
  }

  private async fetchScrobbles(cfg: Config): Promise<void> {
    const end = this.get<number>('end') ?? 0; // page ids <= end are committed; this fetch writes end + page
    const [user, from, to, sk] = (['user', 'from', 'to', 'sk'] as const).map((k) => this.get<any>(k));
    let page = this.get<number>('page')!;
    let pages = this.get<number>('pages')!;
    while (page <= pages && cfg.fetches! + CONCURRENCY <= BUDGET) {
      const n = page === 1 ? 1 : Math.min(CONCURRENCY, pages - page + 1); // page 1 first: it tells us totalPages
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => getRecentTracksPage(cfg, user, page + i, { from, to, sk })));
      rs.forEach((r, i) => this.sql.exec('INSERT OR REPLACE INTO pages VALUES (?, ?)', end + page + i, JSON.stringify(compact(r.tracks))));
      pages = rs[n - 1].totalPages;
      page += n;
      this.set({ page, pages, progress: { phase: 'scrobbles', done: page - 1, total: pages } });
    }
    if (page <= pages) return;
    await this.scrobblesDone(end + page - 1);
  }

  // ListenBrainz: pages go backwards from `to` via max_ts, so they are sequential; the total is unknown (shown as done + 1).
  private async fetchListens(cfg: Config): Promise<void> {
    const end = this.get<number>('end') ?? 0;
    const [user, from, to] = (['user', 'from', 'to'] as const).map((k) => this.get<any>(k));
    let page = this.get<number>('page')!;
    let maxTs = this.get<number>('maxTs') ?? to + 1; // max_ts is exclusive
    while (cfg.fetches! < BUDGET) {
      const r = await getListensPage(cfg, user, { from, maxTs });
      this.sql.exec('INSERT OR REPLACE INTO pages VALUES (?, ?)', end + page, JSON.stringify(compact(r.tracks)));
      page++;
      if (r.last) return this.scrobblesDone(end + page - 1);
      maxTs = r.oldest;
      this.set({ page, maxTs, progress: { phase: 'scrobbles', done: page - 1, total: page } });
    }
  }

  private async scrobblesDone(end: number): Promise<void> {
    this.set({ end });
    this.data = undefined;
    this.set({ progress: { phase: 'albums', done: 0, total: (await this.todo()).length } });
  }

  private async fetchAlbums(cfg: Config): Promise<void> {
    const { state, cache } = await this.load();
    const todo = await this.todo();
    const { total } = this.get<Progress>('progress')!;
    const fetched: Record<string, AlbumCacheEntry> = {}; // by albumKey
    try {
      for (let i = 0; i < todo.length && cfg.fetches! + CONCURRENCY <= BUDGET; i += CONCURRENCY) {
        const group = todo.slice(i, i + CONCURRENCY);
        const rs = await Promise.allSettled(group.map(([k, e]) => this.lookup(cfg, k, e)));
        rs.forEach((r, j) => {
          if (r.status === 'fulfilled') fetched[group[j][0]] = r.value;
        });
        const bad = rs.find((r) => r.status === 'rejected');
        if (bad) throw bad.reason; // successes are still saved in finally
      }
    } finally {
      Object.assign(cache, fetched);
      await shared(this.env).putAlbums(Object.fromEntries(Object.entries(fetched).map(([k, v]) => [this.cacheKeyOf(k, state.plays[k]), v])));
    }
    const left = todo.length - Object.keys(fetched).length;
    this.set({ progress: { phase: 'albums', done: total - left, total } });
    if (!left) this.set({ status: 'done', lastUts: state.lastUts });
  }

  // The override's Last.fm album if set; else the MusicBrainz release when the listens carry one (falling back to Last.fm if it's unknown there), else Last.fm.
  private async lookup(cfg: Config, key: string, e: AlbumPlays): Promise<AlbumCacheEntry> {
    const o = this.override(key);
    if (o) return lastfmEntry(await getAlbumInfo(cfg, o.artist, o.name));
    const mbid = releaseOf(e);
    return (mbid && (await getRelease(cfg, mbid))) || lastfmEntry(await getAlbumInfo(cfg, e.artist, e.album));
  }

  // Manual matches over automatic recording-id aliases.
  private effective(key: string, entry: AlbumPlays | undefined, info: AlbumCacheEntry | undefined): Aliases {
    return { ...recordingAliases(entry, info), ...this.aliases(key) };
  }

  // Albums that need a tracklist lookup and aren't cached yet.
  private async todo() {
    const { state, cache } = await this.load();
    const distinct = (e: { tracks: object }) => Object.keys(e.tracks).length;
    return Object.entries(state.plays).filter(([k, e]) => needsLookup(e) && !(k in cache)).sort(([, a], [, b]) => distinct(b) - distinct(a)); // most-heard first
  }

  private async load(): Promise<Data> {
    if (this.data) return this.data;
    const state: ScrobbleState = { version: 2, lastUts: 0, plays: {} };
    for (const row of this.sql.exec('SELECT data FROM pages WHERE id <= ? ORDER BY id', this.get<number>('end') ?? 0)) {
      aggregate(state, expand(JSON.parse(row.data as string)));
    }
    const keys = Object.entries(state.plays).filter(([, e]) => needsLookup(e)).map(([k]) => k);
    const found = await shared(this.env).getAlbums(keys.map((k) => this.cacheKeyOf(k, state.plays[k])));
    const cache: Record<string, AlbumCacheEntry> = {}; // by albumKey
    for (const k of keys) if (this.cacheKeyOf(k, state.plays[k]) in found) cache[k] = found[this.cacheKeyOf(k, state.plays[k])];
    return (this.data = { state, cache });
  }

  // GET /api/grid/:user (album=false) or /api/grid/:user/album (album=true).
  async read(session: Session | null, album: boolean, q: { key: string | null; from: string | null; to: string | null; sort: string | null }): Promise<Reply> {
    const status = this.get<Status>('status');
    if (!status) return fail(404, 'No job for this user');
    if (this.get('private') && !this.isOwner(session)) return fail(403, 'This profile is private');
    const progress = this.get<Progress>('progress');
    const partial = status === 'running' && progress?.phase === 'albums'; // album cache is usable while looking up
    if (album && status !== 'done' && !partial) return fail(404, 'Job not done');
    if (status === 'running' && !partial) return ok({ status, progress });
    if (status === 'error') return ok({ status, message: this.get('message'), code: this.get('code') });
    const range: Range = {};
    for (const k of ['from', 'to'] as const) {
      if (q[k]) range[k] = Number(q[k]);
      if (Number.isNaN(range[k])) return fail(400, `Invalid ${k}`);
    }
    const { state, cache } = await this.load();
    if (album) {
      const key = q.key ?? '';
      const entry = state.plays[key];
      const info = cache[key];
      if (!entry || !info) return fail(404, 'Unknown album');
      const aliases = this.effective(key, entry, info);
      const ignored = this.ignored(key);
      const tracks = albumTracks(entry, info.tracks, range, aliases).map((t) => ({ ...t, ignored: ignored.has(normalizeTrack(t.name)) }));
      return ok({ status, album: { artist: entry.artist, album: entry.album, image: info.image, url: info.url, tracks,
        extra: extraTracks(entry, info.tracks, range, aliases), editable: this.isOwner(session),
        override: this.override(key) ? { artist: this.override(key).artist, album: this.override(key).name } : null } });
    }
    const sort = q.sort ?? 'plays';
    if (sort !== 'plays' && sort !== 'recent' && sort !== 'artist') return fail(400, 'Invalid sort');
    const albums: GridAlbum[] = [];
    for (const [key, e] of Object.entries(state.plays)) {
      const info = cache[key];
      const r = info && computeAlbum(e, countedTracks(info.tracks, this.ignored(key)), range, this.effective(key, e, info));
      if (r) albums.push({ ...r, key, image: info.image, url: info.url });
    }
    return ok({ status, ...(partial && { progress }), albums: sortAlbums(albums, sort) });
  }

  // GET /api/grid/:user/debug: job meta + the latest n scrobbles with the reason each is (not) in the grid.
  async debug(session: Session | null, n: number): Promise<Reply> {
    const status = this.get<Status>('status');
    if (!status) return fail(404, 'No job for this user');
    if (this.get('private') && !this.isOwner(session)) return fail(403, 'This profile is private');
    const end = this.get<number>('end') ?? 0;
    const rows = [...this.sql.exec('SELECT id, data FROM pages')].flatMap((r) =>
      expand(JSON.parse(r.data as string)).map((s) => ({ s, pending: (r.id as number) > end })));
    rows.sort((a, b) => Number(b.s.date!.uts) - Number(a.s.date!.uts));
    const { state, cache } = await this.load();
    const scrobbles = rows.slice(0, Math.min(Math.max(n, 1), 1000)).map(({ s, pending }) => {
      const [artist, album, track] = [s.artist['#text'], s.album['#text'], s.name];
      const key = albumKey(artist, album);
      const reason = pending ? 'fetch not finished' : scrobbleReason(album, state.plays[key], cache[key] && { tracks: countedTracks(cache[key].tracks, this.ignored(key)) }, key in cache, track, this.effective(key, state.plays[key], cache[key]));
      return { uts: Number(s.date!.uts), artist, album, track, pending, reason };
    });
    const meta = Object.fromEntries((['status', 'progress', 'message', 'code', 'user', 'source', 'lastUts', 'from', 'to', 'end', 'page', 'pages'] as const).map((k) => [k, this.get(k) ?? null]));
    return ok({ status: 'ok', meta, scrobbles });
  }

  // POST /api/grid/:user/match: map a played track to a tracklist track (null removes the mapping). Owner only.
  async match(session: Session | null, b: { key: string; played: string; track: string | null }): Promise<Reply> {
    if (!this.isOwner(session)) return fail(403, 'Only the profile owner can edit matches');
    const { state, cache } = await this.load();
    const entry = state.plays[b.key];
    const info = cache[b.key];
    if (!entry || !info) return fail(404, 'Unknown album');
    const played = normalizeTrack(b.played);
    if (!(played in entry.tracks)) return fail(400, 'Unknown played track');
    if (b.track !== null && !info.tracks.includes(b.track)) return fail(400, 'Unknown tracklist track');
    const aliases = this.aliases(b.key);
    if (b.track === null) {
      this.sql.exec('DELETE FROM matches WHERE album = ? AND played = ?', b.key, b.played);
      delete aliases[played];
    } else {
      this.sql.exec('INSERT OR REPLACE INTO matches VALUES (?, ?, ?)', b.key, b.played, b.track);
      (this.matches![b.key] ??= {})[played] = normalizeTrack(b.track);
    }
    return ok({ status: 'ok' });
  }

  // POST /api/grid/:user/ignore: mark a tracklist track as not counting toward the album's completion (ignored false undoes). Owner only.
  async ignore(session: Session | null, b: { key: string; track: string; ignored: boolean }): Promise<Reply> {
    if (!this.isOwner(session)) return fail(403, 'Only the profile owner can edit matches');
    const { cache } = await this.load();
    const info = cache[b.key];
    if (!info) return fail(404, 'Unknown album');
    if (!info.tracks.includes(b.track)) return fail(400, 'Unknown tracklist track');
    const track = normalizeTrack(b.track);
    if (b.ignored) {
      this.sql.exec('INSERT OR IGNORE INTO ignored VALUES (?, ?)', b.key, track);
      this.ignored(b.key).add(track);
    } else {
      this.sql.exec('DELETE FROM ignored WHERE album = ? AND track = ?', b.key, track);
      this.ignored(b.key).delete(track);
    }
    return ok({ status: 'ok' });
  }

  // POST /api/grid/:user/override: use another Last.fm album's tracklist for this album (artist/album null resets). Owner only.
  async setOverride(session: Session | null, b: { key: string; artist: string | null; album: string | null }): Promise<Reply> {
    if (!this.isOwner(session)) return fail(403, 'Only the profile owner can edit matches');
    const { state, cache } = await this.load();
    const entry = state.plays[b.key];
    if (!entry) return fail(404, 'Unknown album');
    if (b.artist !== null && b.album !== null) {
      const cfg: Config = { apiKey: this.env.LASTFM_API_KEY, secret: this.env.LASTFM_SHARED_SECRET, fetches: 0 };
      const info = lastfmEntry(await getAlbumInfo(cfg, b.artist, b.album));
      if (!info || info.tracks.length <= 1) return fail(400, 'Album not found on Last.fm (or no tracklist)');
      const o = { artist: b.artist, name: b.album };
      await shared(this.env).putAlbums({ [cacheKey(b.key, entry, o)]: info });
      this.sql.exec('INSERT OR REPLACE INTO overrides VALUES (?, ?, ?)', b.key, o.artist, o.name);
      this.override(b.key); // ensure loaded
      this.overrides![b.key] = o;
      cache[b.key] = info;
    } else {
      this.sql.exec('DELETE FROM overrides WHERE album = ?', b.key);
      this.override(b.key); // ensure loaded
      delete this.overrides![b.key];
      const k = this.cacheKeyOf(b.key, entry);
      const found = (await shared(this.env).getAlbums([k]))[k];
      const info = found !== undefined ? found : await this.lookup({ apiKey: this.env.LASTFM_API_KEY, secret: this.env.LASTFM_SHARED_SECRET, fetches: 0 }, b.key, entry);
      if (found === undefined) await shared(this.env).putAlbums({ [k]: info });
      cache[b.key] = info; // default tracklist again, looked up now if it wasn't cached
    }
    this.sql.exec('DELETE FROM matches WHERE album = ?', b.key);
    delete this.matches?.[b.key];
    this.sql.exec('DELETE FROM ignored WHERE album = ?', b.key);
    delete this.ignoredTracks?.[b.key];
    return ok({ status: 'ok' });
  }
}
