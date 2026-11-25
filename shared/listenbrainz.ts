import type { Config } from './lastfm.ts';
import type { Scrobble } from './rank.ts';

const API = 'https://api.listenbrainz.org/1';
const PAGE = 1000; // max listens per request
const RETRIES = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// GET json; 429 waits X-RateLimit-Reset-In and retries, 5xx retries with backoff. Counts attempts in cfg.fetches.
async function get(cfg: Config, path: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    cfg.fetches = (cfg.fetches ?? 0) + 1;
    const res = await fetch(`${API}${path}`);
    if (res.ok) return res.json();
    const retry = res.status === 429 || res.status >= 500;
    if (attempt > RETRIES || !retry) {
      const body: any = await res.json().catch(() => ({}));
      console.error('ListenBrainz call failed', { path, attempts: attempt, status: res.status, message: body.error });
      throw new Error(`ListenBrainz: ${body.error ?? `HTTP ${res.status}`}`);
    }
    await sleep(res.status === 429 ? Number(res.headers.get('X-RateLimit-Reset-In') ?? 1) * 1000 : 2000 * attempt);
  }
}

// One page of listens, newest first, with `from` <= listened_at < `maxTs` (`from` optional; inclusive like Last.fm's).
// Next page: pass `oldest` as maxTs. `last` = no more pages.
export async function getListensPage(
  cfg: Config,
  user: string,
  { from, maxTs }: { from?: number; maxTs: number },
): Promise<{ tracks: Scrobble[]; oldest: number; last: boolean }> {
  const q = new URLSearchParams({ count: String(PAGE), max_ts: String(maxTs), ...(from && { min_ts: String(from - 1) }) }); // min_ts is exclusive
  const listens: any[] = (await get(cfg, `/user/${encodeURIComponent(user)}/listens?${q}`)).payload.listens;
  const tracks = listens.map(({ listened_at, track_metadata: m }): Scrobble => ({
    artist: { '#text': m.artist_name },
    album: { '#text': m.release_name ?? '' },
    name: m.track_name,
    date: { uts: String(listened_at) },
    mbid: m.mbid_mapping?.recording_mbid,
    releaseMbid: m.mbid_mapping?.release_mbid,
  }));
  return { tracks, oldest: Math.min(...listens.map((l) => l.listened_at)), last: listens.length < PAGE };
}
