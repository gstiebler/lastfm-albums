import { createHash } from 'node:crypto';

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

// Last.fm api_sig: md5 of sorted key+value pairs (no format/callback) + shared secret.
export function sign(params, secret = process.env.LASTFM_SHARED_SECRET) {
  const str = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5').update(str + secret).digest('hex');
}

async function call(method, params, signed = false) {
  await throttle();
  const all = { method, ...params, api_key: process.env.LASTFM_API_KEY };
  if (signed) all.api_sig = sign(all);
  const url = new URL(API);
  url.search = new URLSearchParams({ ...all, format: 'json' });
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) {
    const err = new Error(`Last.fm: ${data.message}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

// Exchanges a web-auth token for a session: {name, key}.
export async function getSession(token) {
  return (await call('auth.getSession', { token }, true)).session;
}

// Fetches all scrobbles newer than `from` (uts). Calls onPage(scrobbles, page, totalPages) per page.
// With `sk` the calls are signed as that user (needed for profiles hiding recent listening).
export async function getRecentTracks(user, from, onPage, sk) {
  // Fixed `to` keeps pages stable if the user scrobbles while we paginate.
  const params = { user, limit: 200, to: Math.floor(Date.now() / 1000), ...(from && { from }) };
  let page = 1;
  let totalPages = 1;
  do {
    const data = await call('user.getRecentTracks', { ...params, page, ...(sk && { sk }) }, Boolean(sk));
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
