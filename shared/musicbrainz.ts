import type { Config } from './lastfm.ts';
import type { AlbumEntry } from './rank.ts';

const API = 'https://musicbrainz.org/ws/2/release';
const INTERVAL_MS = 1100; // MusicBrainz allows ~1 req/s
const RETRIES = 4;

// Single shared throttle: every call waits for its slot.
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

// Tracklist, recording ids and cover of a release, or null on 404. 5xx (incl. 503 rate limiting) is retried.
export async function getRelease(cfg: Config, mbid: string): Promise<AlbumEntry | null> {
  for (let attempt = 1; ; attempt++) {
    await throttle();
    cfg.fetches = (cfg.fetches ?? 0) + 1;
    const res = await fetch(`${API}/${mbid}?inc=recordings&fmt=json`, { headers: { 'User-Agent': 'album-grid/1.0' } });
    if (res.status === 404) return null;
    if (res.ok) {
      const r: any = await res.json();
      const tracks: any[] = r.media.flatMap((m: any) => m.tracks);
      return {
        tracks: tracks.map((t) => t.title),
        recordings: tracks.map((t) => t.recording.id),
        image: r['cover-art-archive']?.front ? `https://coverartarchive.org/release/${mbid}/front-250` : '',
        url: `https://musicbrainz.org/release/${mbid}`,
      };
    }
    if (attempt > RETRIES || res.status < 500) throw new Error(`MusicBrainz: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}
