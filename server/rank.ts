export const MIN_DISTINCT_TRACKS = 3;

// Raw user.getRecentTracks entry (only the fields we use).
export type Scrobble = {
  artist: { '#text': string };
  album: { '#text': string };
  name: string;
  date?: { uts: string };
  '@attr'?: { nowplaying?: string };
};

export type AlbumPlays = { artist: string; album: string; tracks: Record<string, { name: string; plays: number }> };
export type ScrobbleState = { lastUts: number; plays: Record<string, AlbumPlays> };

// album.getInfo `album` object (only the fields we use).
export type AlbumInfo = {
  url: string;
  image?: { size: string; '#text': string }[];
  tracks?: { track?: { name: string } | { name: string }[] };
};

export type AlbumResult = {
  artist: string;
  album: string;
  heard: number;
  length: number;
  pct: number;
  full: number;
};

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

// Merge raw user.getRecentTracks entries into state {lastUts, plays}.
export function aggregate(state: ScrobbleState, scrobbles: Scrobble[]): ScrobbleState {
  for (const s of scrobbles) {
    if (s['@attr']?.nowplaying) continue;
    const artist = s.artist['#text'];
    const album = s.album['#text'];
    if (!album) continue;
    const key = albumKey(artist, album);
    const entry = (state.plays[key] ??= { artist, album, tracks: {} });
    const track = (entry.tracks[normalizeTrack(s.name)] ??= { name: s.name, plays: 0 });
    track.plays++;
    state.lastUts = Math.max(state.lastUts, Number(s.date!.uts));
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

// Returns {artist, album, heard, length, pct, full} or null if excluded.
export function computeAlbum(entry: AlbumPlays, tracklist: string[]): AlbumResult | null {
  if (!needsLookup(entry)) return null;
  const keys = new Set(tracklist.map(normalizeTrack));
  if (keys.size <= 1) return null;
  const counts = new Map<string, number>();
  for (const [tk, t] of Object.entries(entry.tracks)) {
    const k = normalizeTrack(tk);
    if (keys.has(k)) counts.set(k, (counts.get(k) ?? 0) + t.plays);
  }
  if (counts.size === 0) return null;
  return {
    artist: entry.artist,
    album: entry.album,
    heard: counts.size,
    length: keys.size,
    pct: counts.size / keys.size,
    full: Math.min(...counts.values()),
  };
}

export function sortAlbums<T extends Pick<AlbumResult, 'artist' | 'album' | 'pct' | 'length' | 'full'>>(albums: T[]): T[] {
  return [...albums].sort((a, b) =>
    b.pct - a.pct || b.length - a.length || b.full - a.full ||
    a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
}
