const API = 'https://ws.audioscrobbler.com/2.0/';
const INTERVAL_MS = 220; // < 5 req/s

// Single shared throttle: every call waits for its slot.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

async function call(method, params) {
  await throttle();
  const url = new URL(API);
  url.search = new URLSearchParams({
    method, ...params, api_key: process.env.LASTFM_API_KEY, format: 'json',
  });
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = new Error(`Last.fm: ${data.message}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

// Fetches all scrobbles newer than `from` (uts). Calls onPage(scrobbles, page, totalPages) per page.
export async function getRecentTracks(user, from, onPage) {
  const params = { user, limit: 200, ...(from && { from }) };
  let page = 1;
  let totalPages = 1;
  do {
    const data = await call('user.getRecentTracks', { ...params, page });
    totalPages = Number(data.recenttracks['@attr'].totalPages);
    onPage(data.recenttracks.track ?? [], page, totalPages);
    page++;
  } while (page <= totalPages);
}

// Returns album.getInfo `album` object, or null when Last.fm doesn't know it (error 6).
export async function getAlbumInfo(artist, album) {
  try {
    return (await call('album.getInfo', { artist, album, autocorrect: 1 })).album;
  } catch (err) {
    if (err.code === 6) return null;
    throw err;
  }
}
