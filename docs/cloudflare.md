# Album Grid on Cloudflare (free plan) — design

Goal: public deployment that costs $0, including when nobody uses it for a month. Replaces the Node server (`server/server.ts`); ranking, Last.fm client and frontend stay.

## Free-plan limits that shape the design (checked 2026-10-31)
| Limit | Free | Consequence |
|---|---|---|
| Worker CPU per request | 10 ms | Worker only routes; all real work runs in a Durable Object |
| Durable Object CPU per request | 30 s | Ranking (current `rank.ts`, in JS) runs inside the DO |
| Subrequests per invocation | 50 (D1 queries count) | Fetch Last.fm in chunks of 40 calls per alarm, then re-arm the alarm |
| DO alarm wall time | 15 min | Chunks are short, far below this |
| DO requests | 100k/day (alarms included) | Fine: 60k-scrobble user ≈ 50 alarms + polls |
| DO rows written | 100k/day | **Don't store one row per scrobble** (60k user = 60k+ writes). Store one row per Last.fm page (≤200 scrobbles) → ~300 rows |
| D1 rows written / read | 100k / 5M per day | Album cache: 1 row per album |
| Storage | 5 GB DO, 500 MB per D1 DB | Plenty |
| Over a limit | Errors, never billing | Worst case: the app errors until 00:00 UTC |

## Architecture
```
browser ──> Worker (static assets + /api routing, ~no CPU)
              │  idFromName(lowercase user)
              ├──> UserDO (one per Last.fm user, SQLite storage)
              │       alarm loop: user.getRecentTracks / album.getInfo
              │       ranking + album details in memory (rank.ts)
              └──> D1 "albumgrid": albums (shared cache), sessions
```

### Worker (`worker/index.ts`)
- Static assets: `dist/` via Workers static assets (`assets.directory`, SPA fallback).
- Same routes as today, same request/response shapes, so the frontend doesn't change:
  - `POST /api/grid/:user`, `GET /api/grid/:user?from&to&sort`, `GET /api/grid/:user/album?key&from&to` → forwarded to the user's DO along with the signed-in session (`{name, key}` or null).
  - `GET /login`, `GET /callback`, `GET /api/me`, `POST /logout`.
- Callback URL built from the request origin (`https://…/callback`). Cookie `sid`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1y`.

### UserDO (`worker/user.ts`)
SQLite tables:
- `meta(k, v)`: `lastUts`, `status`, `progress`, `error`, `private`, `sk` (session key used for a private user's fetch), `to` (the fixed `to` of the running fetch), `page`, `pages`.
- `pages(id INTEGER PRIMARY KEY, data TEXT)`: compact scrobbles of one Last.fm page, `[[artist, album, track, uts], …]`.

Flow:
1. `POST` → same guards as today (running → reuse; private and requester isn't owner → reuse). Otherwise store `to = now`, `page = 1`, status `running`, `setAlarm(now)`.
2. `alarm()` runs up to 40 Last.fm calls, saves progress, re-arms `setAlarm(now)` until done:
   - phase `scrobbles`: `from = lastUts + 1`, pages 1..N (Last.fm returns newest first; the fixed `to` keeps pages stable). One `pages` row per page.
   - phase `albums`: aggregate all `pages` rows (rank.ts `aggregate`), compute `needsLookup` keys, read cached ones from D1 in one query (`WHERE key IN (SELECT value FROM json_each(?))`), call `album.getInfo` for the misses, write them to D1 in one `batch()` per alarm.
   - done: set `lastUts`, status `done`.
   - error: status `error` + message/code (17 shows the sign-in link as today).
3. `GET` grid / album: if done, rank in memory (aggregate cached in the DO instance while it is alive; rebuilt from `pages` + D1 after eviction). 403 for private when requester isn't owner; 404/400 as today.
4. Refresh: next `POST` fetches only `from = lastUts + 1` (new `pages` rows appended).

Throttle: 220 ms between calls inside the DO (each user's fetch is sequential). No global rate limiter: Workers use many egress IPs, and Last.fm error 29 is already retried with backoff. Add a global limiter DO only if 29s show up.

### D1 (`worker/schema.sql`)
```sql
CREATE TABLE albums (key TEXT PRIMARY KEY, info TEXT);          -- album.getInfo result, null for misses
CREATE TABLE sessions (sid TEXT PRIMARY KEY, name TEXT, key TEXT, created INTEGER);
```

### Code reuse
- `server/rank.ts`: unchanged (moved to `shared/` or imported as-is).
- `server/lastfm.ts`: keep; API key/secret passed in from `env` instead of `process.env`. MD5 for `api_sig` via `node:crypto` (`nodejs_compat` flag).
- `server/server.ts`: deleted, replaced by the Worker + DO. No local Node server anymore; one code path.
- `web/`: unchanged except the poll interval 1s → 2s.

## Config / dev / deploy
- `wrangler.jsonc`: `main: worker/index.ts`, `compatibility_flags: ["nodejs_compat"]`, `assets` (`dist`, SPA), DO binding `USER` + SQLite migration (`new_sqlite_classes: ["UserDO"]`), D1 binding `DB`.
- Secrets: `LASTFM_API_KEY`, `LASTFM_SHARED_SECRET` via `wrangler secret put`; locally in `.dev.vars` (gitignored, you create it, same two lines as `.env`).
- Scripts: `dev` = `vite build --watch` + `wrangler dev`, `deploy` = `vite build && wrangler deploy`, `db:init` = `wrangler d1 execute albumgrid --file worker/schema.sql`. `test`/`typecheck` stay.
- Steps that need you (interactive or account-level): create a free Cloudflare account, `npx wrangler login`, `wrangler d1 create albumgrid`, `wrangler secret put` ×2. URL: `https://album-grid.<your-subdomain>.workers.dev` (custom domain optional).
- Data: no migration; each user refetches on first visit (yours ≈ 13 min, once).

## Tests
- Existing `rank`/`lastfm` tests keep running with `node --test`.
- DO logic tested locally with `wrangler dev` against joanofarctan (public) end to end.

## Non-goals
Paid plan features, Queues, KV, a global rate limiter (until needed), migrating local `cache/`.
