import { createHash } from 'node:crypto';
import type { AlbumInfo, Scrobble } from './rank.ts';

export type LastfmError = Error & { code?: number };
export type Session = { name: string; key: string };
// `fetches` counts HTTP attempts (retries included), so callers can stay under a subrequest budget.
export type Config = { apiKey: string; secret: string; fetches?: number };
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
export function sign(params: Params, secret: string): string {
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

async function call(cfg: Config, method: string, params: Params, signed = false): Promise<any> {
  const all: Params = { method, ...params, api_key: cfg.apiKey };
  if (signed) all.api_sig = sign(all, cfg.secret);
  const url = new URL(API);
  url.search = new URLSearchParams({ ...all, format: 'json' }).toString();
  for (let attempt = 1; ; attempt++) {
    await throttle();
    cfg.fetches = (cfg.fetches ?? 0) + 1;
    const res = await fetch(url);
    const data: any = await res.json().catch(() => ({ error: res.status, message: `HTTP ${res.status}` }));
    if (!data.error) return data;
    if (attempt > RETRIES || !isTransient(data.error)) {
      throw Object.assign(new Error(`Last.fm: ${data.message}`), { code: data.error });
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// Exchanges a web-auth token for a session: {name, key}.
export async function getSession(cfg: Config, token: string): Promise<Session> {
  return (await call(cfg, 'auth.getSession', { token }, true)).session;
}

// Fetches one page of scrobbles between `from` and `to` (uts; `from` optional). Pass a fixed `to` so pages stay stable.
// With `sk` the call is signed as that user (needed for profiles hiding recent listening).
export async function getRecentTracksPage(
  cfg: Config,
  user: string,
  page: number,
  { from, to, sk }: { from?: number; to: number; sk?: string },
): Promise<{ tracks: Scrobble[]; totalPages: number }> {
  const params = { user, limit: 200, to, page, ...(from && { from }), ...(sk && { sk }) };
  const data = await call(cfg, 'user.getRecentTracks', params, Boolean(sk));
  // Last.fm returns a single object (not an array) when the page has one track.
  return { tracks: [data.recenttracks.track ?? []].flat(), totalPages: Number(data.recenttracks['@attr'].totalPages) };
}

// Returns album.getInfo `album` object, or null when Last.fm doesn't know it (error 6).
export async function getAlbumInfo(cfg: Config, artist: string, album: string): Promise<AlbumInfo | null> {
  try {
    return (await call(cfg, 'album.getInfo', { artist, album, autocorrect: 1 })).album;
  } catch (err) {
    if ((err as LastfmError).code === 6) return null;
    throw err;
  }
}
