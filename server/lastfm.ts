import { createHash } from 'node:crypto';
import type { AlbumInfo, Scrobble } from './rank.ts';

export type LastfmError = Error & { code?: number };
export type Session = { name: string; key: string };
type Params = Record<string, string | number>;

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
export function sign(params: Params, secret = process.env.LASTFM_SHARED_SECRET): string {
  const str = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHash('md5').update(str + secret).digest('hex');
}

// Last.fm transient errors: 8 operation failed, 11 service offline, 16 temporarily unavailable, 29 rate limit; plus HTTP 5xx.
const isTransient = (code: number) => [8, 11, 16, 29].includes(code) || code >= 500;
const RETRIES = 4;

async function call(method: string, params: Params, signed = false): Promise<any> {
  const all: Params = { method, ...params, api_key: process.env.LASTFM_API_KEY! };
  if (signed) all.api_sig = sign(all);
  const url = new URL(API);
  url.search = new URLSearchParams({ ...all, format: 'json' }).toString();
  for (let attempt = 1; ; attempt++) {
    await throttle();
    const res = await fetch(url);
    const data = await res.json().catch(() => ({ error: res.status, message: `HTTP ${res.status}` }));
    if (!data.error) return data;
    if (attempt > RETRIES || !isTransient(data.error)) {
      throw Object.assign(new Error(`Last.fm: ${data.message}`), { code: data.error });
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// Exchanges a web-auth token for a session: {name, key}.
export async function getSession(token: string): Promise<Session> {
  return (await call('auth.getSession', { token }, true)).session;
}

// Fetches all scrobbles newer than `from` (uts). Calls onPage(scrobbles, page, totalPages) per page.
// With `sk` the calls are signed as that user (needed for profiles hiding recent listening).
export async function getRecentTracks(
  user: string,
  from: number | undefined,
  onPage: (scrobbles: Scrobble[], page: number, totalPages: number) => void,
  sk?: string,
): Promise<void> {
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
export async function getAlbumInfo(artist: string, album: string): Promise<AlbumInfo | null> {
  try {
    return (await call('album.getInfo', { artist, album, autocorrect: 1 })).album;
  } catch (err) {
    if ((err as LastfmError).code === 6) return null;
    throw err;
  }
}
