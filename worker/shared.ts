import { DurableObject } from 'cloudflare:workers';
import type { Session } from '../shared/lastfm.ts';
import type { Env } from './env.ts';

// Album cache entry (null = Last.fm doesn't know the album).
export type AlbumCacheEntry = { tracks: string[]; image: string; url: string } | null;

// Single instance: album.getInfo cache shared by all users, and sign-in sessions.
export class SharedDO extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec('CREATE TABLE IF NOT EXISTS albums (key TEXT PRIMARY KEY, info TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, name TEXT, key TEXT, created INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)');
    if (!this.sql.exec("SELECT 1 FROM migrations WHERE id = 'retry-empty-albums'").toArray().length) {
      // One-off: misses/empty tracklists cached before the base-name fallback get looked up again.
      this.sql.exec("DELETE FROM albums WHERE info = 'null' OR json_array_length(info, '$.tracks') <= 1");
      this.sql.exec("INSERT INTO migrations VALUES ('retry-empty-albums')");
    }
  }

  // Returns only the cached keys (misses are cached as null).
  getAlbums(keys: string[]): Record<string, AlbumCacheEntry> {
    const found: Record<string, AlbumCacheEntry> = {};
    for (const k of keys) {
      const row = this.sql.exec('SELECT info FROM albums WHERE key = ?', k).toArray()[0];
      if (row) found[k] = JSON.parse(row.info as string);
    }
    return found;
  }

  putAlbums(entries: Record<string, AlbumCacheEntry>): void {
    for (const [k, info] of Object.entries(entries)) {
      this.sql.exec('INSERT OR REPLACE INTO albums VALUES (?, ?)', k, JSON.stringify(info));
    }
  }

  getSession(sid: string): Session | null {
    const row = this.sql.exec('SELECT name, key FROM sessions WHERE sid = ?', sid).toArray()[0];
    return row ? { name: row.name as string, key: row.key as string } : null;
  }

  putSession(sid: string, name: string, key: string): void {
    this.sql.exec('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?)', sid, name, key, Date.now());
  }

  deleteSession(sid: string): void {
    this.sql.exec('DELETE FROM sessions WHERE sid = ?', sid);
  }
}
