export const MIN_DISTINCT_TRACKS = 3;

// Raw user.getRecentTracks entry (only the fields we use).
export type Scrobble = {
  artist: { '#text': string };
  album: { '#text': string };
  name: string;
  date?: { uts: string };
  '@attr'?: { nowplaying?: string };
};

export type AlbumPlays = { artist: string; album: string; tracks: Record<string, { name: string; times: number[] }> };
export type ScrobbleState = { version: 2; lastUts: number; plays: Record<string, AlbumPlays> };

// album.getInfo `album` object (only the fields we use).
export type AlbumInfo = {
  url: string;
  image?: { size: string; '#text': string }[];
  tracks?: { track?: { name: string } | { name: string }[] };
};

// Inclusive unix-seconds bounds; a missing bound is unbounded.
export type Range = { from?: number; to?: number };

export type AlbumResult = {
  artist: string;
  album: string;
  heard: number;
  length: number;
  pct: number;
  full: number;
  completedAt: number; // unix seconds: last play of the least recently played matched track
};

export type SortMethod = 'plays' | 'recent' | 'artist';

export function normalizeName(s: string): string {
  return String(s).trim().toLowerCase();
}

// Strips remaster/feat suffixes, accents and punctuation; idempotent. Live/remix/mono etc. stay distinct.
export function normalizeTrack(s: string): string {
  const n = normalizeName(s)
    .replace(/\s*[(\[][^)\]]*remaster[^)\]]*[)\]]/g, '')
    .replace(/\s*[(\[]\s*(?:feat|ft|featuring|with)\b[^)\]]*[)\]]/g, '')
    .replace(/\s*[-–]\s*[^-–]*remaster[^-–]*$/, '')
    .replace(/\s*[-–]\s*(?:feat|ft|featuring)\b.*$/, '')
    .replace(/\s+(?:feat|ft|featuring)\b.*$/, '')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return n || normalizeName(s);
}

// Manual matches: normalized played name -> normalized tracklist name.
export type Aliases = Record<string, string>;
const keyOf = (tk: string, aliases: Aliases = {}) => aliases[normalizeTrack(tk)] ?? normalizeTrack(tk);

export function albumKey(artist: string, album: string): string {
  return `${normalizeName(artist)}\u0000${normalizeName(album)}`;
}

// Merge raw user.getRecentTracks entries into state {version, lastUts, plays}.
export function aggregate(state: ScrobbleState, scrobbles: Scrobble[]): ScrobbleState {
  for (const s of scrobbles) {
    if (s['@attr']?.nowplaying) continue;
    const artist = s.artist['#text'];
    state.lastUts = Math.max(state.lastUts, Number(s.date!.uts)); // all scrobbles, so the next refresh doesn't refetch album-less ones
    const album = s.album['#text'];
    if (!album) continue;
    const key = albumKey(artist, album);
    const entry = (state.plays[key] ??= { artist, album, tracks: {} });
    const track = (entry.tracks[normalizeTrack(s.name)] ??= { name: s.name, times: [] });
    const uts = Number(s.date!.uts);
    track.times.push(uts);
  }
  return state;
}

// album.getInfo -> array of track names ([] when missing)
export function getTracklist(info?: Pick<AlbumInfo, 'tracks'> | null): string[] {
  const t = info?.tracks?.track;
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((x) => x.name);
}

export function needsLookup(entry: AlbumPlays): boolean {
  return Object.keys(entry.tracks).length >= MIN_DISTINCT_TRACKS;
}

// Why a scrobble does or doesn't contribute to the grid (mirrors needsLookup/computeAlbum).
export function scrobbleReason(album: string, entry: AlbumPlays | undefined, info: { tracks: string[] } | null | undefined, cached: boolean, track: string, aliases: Aliases): string {
  if (!album) return 'no album tag';
  if (!entry || !needsLookup(entry)) return `fewer than ${MIN_DISTINCT_TRACKS} distinct tracks (${entry ? Object.keys(entry.tracks).length : 0})`;
  if (!cached) return 'album lookup pending';
  if (!info) return 'album not found on Last.fm';
  const keys = new Set(info.tracks.map(normalizeTrack));
  if (keys.size <= 1) return 'empty tracklist';
  if (!keys.has(keyOf(track, aliases))) return 'track not on tracklist';
  return 'in grid';
}

// Returns {artist, album, heard, length, pct, full, completedAt} or null if excluded. Counts only plays within `range`.
export function computeAlbum(entry: AlbumPlays, tracklist: string[], range: Range = {}, aliases: Aliases = {}): AlbumResult | null {
  const { from = -Infinity, to = Infinity } = range;
  const inRange = new Map<string, number[]>();
  for (const [tk, t] of Object.entries(entry.tracks)) {
    const times = t.times.filter((u) => u >= from && u <= to);
    const k = keyOf(tk, aliases);
    if (times.length) inRange.set(k, [...(inRange.get(k) ?? []), ...times]);
  }
  if (inRange.size < MIN_DISTINCT_TRACKS) return null;
  const keys = new Set(tracklist.map(normalizeTrack));
  if (keys.size <= 1) return null;
  const counts = new Map<string, number>();
  const last = new Map<string, number>();
  for (const [k, times] of inRange) {
    if (!keys.has(k)) continue;
    counts.set(k, times.length);
    last.set(k, Math.max(...times));
  }
  if (counts.size === 0) return null;
  return {
    artist: entry.artist,
    album: entry.album,
    heard: counts.size,
    length: keys.size,
    pct: counts.size / keys.size,
    full: Math.min(...counts.values()),
    completedAt: Math.min(...last.values()),
  };
}

export type TrackResult = { name: string; plays: number; lastPlayed: number | null };

// Tracklist in album order with in-range play count and last play; duplicate normalized names appear once.
export function albumTracks(entry: AlbumPlays, tracklist: string[], range: Range = {}, aliases: Aliases = {}): TrackResult[] {
  const { from = -Infinity, to = Infinity } = range;
  const plays = new Map<string, number[]>();
  for (const [tk, t] of Object.entries(entry.tracks)) {
    const k = keyOf(tk, aliases);
    plays.set(k, [...(plays.get(k) ?? []), ...t.times.filter((u) => u >= from && u <= to)]);
  }
  const seen = new Set<string>();
  const result: TrackResult[] = [];
  for (const name of tracklist) {
    const k = normalizeTrack(name);
    if (seen.has(k)) continue;
    seen.add(k);
    const times = plays.get(k) ?? [];
    result.push({ name, plays: times.length, lastPlayed: times.length ? Math.max(...times) : null });
  }
  return result;
}

export type ExtraTrack = { name: string; plays: number; track: string | null };

// Played tracks (with in-range plays) that aren't on the tracklist; `track` is the tracklist name a manual match maps it to.
export function extraTracks(entry: AlbumPlays, tracklist: string[], range: Range = {}, aliases: Aliases = {}): ExtraTrack[] {
  const { from = -Infinity, to = Infinity } = range;
  const keys = new Set(tracklist.map(normalizeTrack));
  const result: ExtraTrack[] = [];
  for (const [tk, t] of Object.entries(entry.tracks)) {
    const k = normalizeTrack(tk);
    const plays = t.times.filter((u) => u >= from && u <= to).length;
    if (!plays || keys.has(k)) continue;
    const target = aliases[k];
    result.push({ name: t.name, plays, track: (target && tracklist.find((n) => normalizeTrack(n) === target)) || null });
  }
  return result.sort((a, b) => b.plays - a.plays);
}

export function sortAlbums<T extends Pick<AlbumResult, 'artist' | 'album' | 'heard' | 'pct' | 'length' | 'full' | 'completedAt'>>(
  albums: T[],
  method: SortMethod = 'plays',
): T[] {
  const byAlbum = (a: T, b: T, m: 'plays' | 'recent') =>
    b.pct - a.pct ||
    (m === 'recent' ? b.completedAt - a.completedAt : b.length - a.length || b.full - a.full) ||
    a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album);
  if (method !== 'artist') return [...albums].sort((a, b) => byAlbum(a, b, method));
  const score = new Map<string, number>();
  for (const a of albums) score.set(normalizeName(a.artist), (score.get(normalizeName(a.artist)) ?? 0) + a.heard);
  return [...albums].sort((a, b) => {
    const ka = normalizeName(a.artist);
    const kb = normalizeName(b.artist);
    return score.get(kb)! - score.get(ka)! || ka.localeCompare(kb) || byAlbum(a, b, 'plays');
  });
}
