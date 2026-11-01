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

export type SortMethod = 'plays' | 'recent';

export function normalizeName(s: string): string {
  return String(s).trim().toLowerCase();
}

export function normalizeTrack(s: string): string {
  return normalizeName(s)
    .replace(/\s*[(\[][^)\]]*remaster[^)\]]*[)\]]/g, '')
    .replace(/\s*[-–]\s*[^-–]*remaster[^-–]*$/, '')
    .trim();
}

export function albumKey(artist: string, album: string): string {
  return `${normalizeName(artist)}\u0000${normalizeName(album)}`;
}

// Merge raw user.getRecentTracks entries into state {version, lastUts, plays}.
export function aggregate(state: ScrobbleState, scrobbles: Scrobble[]): ScrobbleState {
  for (const s of scrobbles) {
    if (s['@attr']?.nowplaying) continue;
    const artist = s.artist['#text'];
    const album = s.album['#text'];
    if (!album) continue;
    const key = albumKey(artist, album);
    const entry = (state.plays[key] ??= { artist, album, tracks: {} });
    const track = (entry.tracks[normalizeTrack(s.name)] ??= { name: s.name, times: [] });
    const uts = Number(s.date!.uts);
    track.times.push(uts);
    state.lastUts = Math.max(state.lastUts, uts);
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

// Returns {artist, album, heard, length, pct, full, completedAt} or null if excluded. Counts only plays within `range`.
export function computeAlbum(entry: AlbumPlays, tracklist: string[], range: Range = {}): AlbumResult | null {
  const { from = -Infinity, to = Infinity } = range;
  const inRange = Object.entries(entry.tracks)
    .map(([tk, t]) => [normalizeTrack(tk), t.times.filter((u) => u >= from && u <= to)] as const)
    .filter(([, times]) => times.length > 0);
  if (inRange.length < MIN_DISTINCT_TRACKS) return null;
  const keys = new Set(tracklist.map(normalizeTrack));
  if (keys.size <= 1) return null;
  const counts = new Map<string, number>();
  const last = new Map<string, number>();
  for (const [k, times] of inRange) {
    if (!keys.has(k)) continue;
    counts.set(k, (counts.get(k) ?? 0) + times.length);
    last.set(k, Math.max(last.get(k) ?? -Infinity, ...times));
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

export function sortAlbums<T extends Pick<AlbumResult, 'artist' | 'album' | 'pct' | 'length' | 'full' | 'completedAt'>>(
  albums: T[],
  method: SortMethod = 'plays',
): T[] {
  return [...albums].sort((a, b) =>
    b.pct - a.pct ||
    (method === 'recent' ? b.completedAt - a.completedAt : b.length - a.length || b.full - a.full) ||
    a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
}
