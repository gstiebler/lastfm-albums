export const MIN_DISTINCT_TRACKS = 3;

export function normalizeName(s) {
  return String(s).trim().toLowerCase();
}

export function normalizeTrack(s) {
  return normalizeName(s)
    .replace(/\s*[(\[][^)\]]*remaster[^)\]]*[)\]]/g, '')
    .replace(/\s*[-–]\s*[^-–]*remaster[^-–]*$/, '')
    .trim();
}

export function albumKey(artist, album) {
  return `${normalizeName(artist)}\u0000${normalizeName(album)}`;
}

// Merge raw user.getRecentTracks entries into state {lastUts, plays}.
export function aggregate(state, scrobbles) {
  for (const s of scrobbles) {
    if (s['@attr']?.nowplaying) continue;
    const artist = s.artist['#text'];
    const album = s.album['#text'];
    if (!album) continue;
    const key = albumKey(artist, album);
    const entry = (state.plays[key] ??= { artist, album, tracks: {} });
    const track = (entry.tracks[normalizeTrack(s.name)] ??= { name: s.name, plays: 0 });
    track.plays++;
    state.lastUts = Math.max(state.lastUts, Number(s.date.uts));
  }
  return state;
}

// album.getInfo -> array of track names ([] when missing)
export function getTracklist(info) {
  const t = info?.tracks?.track;
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map((x) => x.name);
}

export function needsLookup(entry) {
  return Object.keys(entry.tracks).length >= MIN_DISTINCT_TRACKS;
}

// Returns {artist, album, heard, length, pct, full} or null if excluded.
export function computeAlbum(entry, tracklist) {
  if (!needsLookup(entry)) return null;
  const keys = new Set(tracklist.map(normalizeTrack));
  if (keys.size <= 1) return null;
  const counts = new Map();
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

export function sortAlbums(albums) {
  return [...albums].sort((a, b) =>
    b.pct - a.pct || b.length - a.length || b.full - a.full ||
    a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
}
