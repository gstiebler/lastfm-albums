import { DurableObject } from 'cloudflare:workers';
import { getRecentTracksPage, getAlbumInfo } from '../shared/lastfm.ts';
import type { Config, LastfmError, Session } from '../shared/lastfm.ts';
import { aggregate, albumKey, scrobbleReason, getTracklist, needsLookup, computeAlbum, albumTracks, extraTracks, normalizeTrack, sortAlbums } from '../shared/rank.ts';
import type { AlbumResult, Aliases, Range, Scrobble, ScrobbleState } from '../shared/rank.ts';
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
type Compact = [artist: string, album: string, track: string, uts: number];

const fail = (code: number, message: string): Reply => ({ code, body: { status: 'error', message } });
const ok = (body: Record<string, any>): Reply => ({ code: 200, body });

const compact = (tracks: Scrobble[]): Compact[] =>
  tracks.filter((s) => !s['@attr']?.nowplaying).map((s) => [s.artist['#text'], s.album['#text'], s.name, Number(s.date!.uts)]);
const expand = (rows: Compact[]): Scrobble[] =>
  rows.map(([artist, album, name, uts]) => ({ artist: { '#text': artist }, album: { '#text': album }, name, date: { uts: String(uts) } }));

// One instance per Last.fm user (lowercase name). Fetches in alarm chunks; ranks in memory.
export class UserDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  matches?: Record<string, Aliases>; // manual matches per albumKey, lazily loaded
  data?: Data; // aggregated scrobbles + album cache; rebuilt from storage after eviction

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, data TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS matches (album TEXT, played TEXT, track TEXT, PRIMARY KEY (album, played))');
  }

  private get<T>(k: string): T | undefined {
    const row = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? JSON.parse(row.v as string) ?? undefined : undefined;
  }

  private set(values: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(values)) this.sql.exec('INSERT OR REPLACE INTO meta VALUES (?, ?)', k, JSON.stringify(v ?? null));
  }

  private isOwner(session: Session | null): boolean {
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

  async start(user: string, session: Session | null): Promise<{ status: Status | undefined }> {
    const status = this.get<Status>('status');
    const isOwner = session?.name.toLowerCase() === user.toLowerCase();
    if (status === 'running' || (this.get('private') && !isOwner)) return { status };
    const lastUts = this.get<number>('lastUts');
    const resume = status === 'error' && this.get<Progress>('progress')?.phase === 'albums'; // scrobbles already stored
    this.set({
      status: 'running', message: null, code: null, user, private: isOwner, sk: isOwner ? session!.key : null,
      ...(!resume && {
        page: 1, pages: 1, to: Math.floor(Date.now() / 1000), from: lastUts ? lastUts + 1 : null,
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
      if (this.get<Progress>('progress')!.phase === 'scrobbles') await this.fetchScrobbles(cfg);
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
    this.set({ end: end + page - 1 });
    this.data = undefined;
    this.set({ progress: { phase: 'albums', done: 0, total: (await this.todo()).length } });
  }

  private async fetchAlbums(cfg: Config): Promise<void> {
    const { state, cache } = await this.load();
    const todo = await this.todo();
    const { total } = this.get<Progress>('progress')!;
    const fetched: Record<string, AlbumCacheEntry> = {};
    try {
      for (let i = 0; i < todo.length && cfg.fetches! + CONCURRENCY <= BUDGET; i += CONCURRENCY) {
        const group = todo.slice(i, i + CONCURRENCY);
        const rs = await Promise.allSettled(group.map(([, e]) => getAlbumInfo(cfg, e.artist, e.album)));
        rs.forEach((r, j) => {
          if (r.status !== 'fulfilled') return;
          const info = r.value;
          fetched[group[j][0]] = info && {
            tracks: getTracklist(info),
            image: info.image?.find((i) => i.size === 'extralarge')?.['#text'] || '',
            url: info.url,
          };
        });
        const bad = rs.find((r) => r.status === 'rejected');
        if (bad) throw bad.reason; // successes are still saved in finally
      }
    } finally {
      Object.assign(cache, fetched);
      await shared(this.env).putAlbums(fetched);
    }
    const left = todo.length - Object.keys(fetched).length;
    this.set({ progress: { phase: 'albums', done: total - left, total } });
    if (!left) this.set({ status: 'done', lastUts: state.lastUts });
  }

  // Albums that need an album.getInfo lookup and aren't cached yet.
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
    return (this.data = { state, cache: await shared(this.env).getAlbums(keys) });
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
      const aliases = this.aliases(key);
      return ok({ status, album: { artist: entry.artist, album: entry.album, image: info.image, url: info.url, tracks: albumTracks(entry, info.tracks, range, aliases),
        extra: extraTracks(entry, info.tracks, range, aliases), editable: this.isOwner(session) } });
    }
    const sort = q.sort ?? 'plays';
    if (sort !== 'plays' && sort !== 'recent' && sort !== 'artist') return fail(400, 'Invalid sort');
    const albums: GridAlbum[] = [];
    for (const [key, e] of Object.entries(state.plays)) {
      const info = cache[key];
      const r = info && computeAlbum(e, info.tracks, range, this.aliases(key));
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
      const reason = pending ? 'fetch not finished' : scrobbleReason(album, state.plays[key], cache[key], key in cache, track, this.aliases(key));
      return { uts: Number(s.date!.uts), artist, album, track, pending, reason };
    });
    const meta = Object.fromEntries((['status', 'progress', 'message', 'code', 'user', 'lastUts', 'from', 'to', 'end', 'page', 'pages'] as const).map((k) => [k, this.get(k) ?? null]));
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
}
