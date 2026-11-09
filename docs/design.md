# Album Grid — design

Web app: enter a Last.fm username, see a grid of album covers ranked by how completely you listened to each album.

## Source
Last.fm only. Public scrobbles need no login. The Worker holds `LASTFM_API_KEY` and `LASTFM_SHARED_SECRET` (`.dev.vars` locally, `wrangler secret put` when deployed); they never reach the browser.

Profiles that hide recent listening fail with Last.fm error 17. "Sign in with Last.fm" (web auth) lets users see their own grid: scrobble calls are then signed (`api_sig`, `sk`) with their session key.

## Ranking
Per album (key: normalized artist + album name). Two sort methods, user-selected (`sort=plays|recent`):

- `plays` (default): % heard desc, tracklist length desc, full plays desc, then artist/album.
- `recent`: % heard desc, **completedAt** desc, then artist/album.

Metrics:
1. **% heard** = tracks of the album's tracklist you played ≥1 time ÷ tracklist length. Desc.
2. **Tracklist length**, desc (longer albums first on ties).
3. **Full plays** = play count of the least-played track among the tracklist tracks you played. Desc.
4. **completedAt** (unix seconds) = for the played tracklist tracks counted in heard, take each track's most recent in-range play; completedAt is the minimum of those (the last-played time of the least recently listened song). Later = completed more recently.

Only plays within the optional date range `[from, to]` (inclusive, unix seconds) count: heard, % heard, full plays and the min-distinct rule below are all computed from in-range plays. Tracklist length and the other exclusions are unchanged.

Matching played tracks to tracklist: by `normalizeTrack` (`rank.ts`; `normalizeName` still builds the album key). Order: strip suffixes (remaster in brackets/after a dash, `(feat. X)`, `[ft. X]`, `(featuring X)`, `(with X)`, ` - feat. X`, trailing ` feat./ft./featuring X`), then drop accents (NFKD), remove apostrophes, `&` → ` and `, other non-letter/digit runs → one space, trim; empty result falls back to `normalizeName`. Idempotent. Live/remix/mono/edit/etc. and an unbracketed "with" are NOT stripped (distinct songs).

Manual matches: the profile owner can map a played track that isn't on the tracklist to a tracklist track (album panel, "Played, not on tracklist"). Per user, per album, persisted in `UserDO`; applied through `aliases` (normalized played → normalized tracklist name) in `computeAlbum`/`albumTracks`: mapped plays merge into the tracklist track (counts summed, last = max) and distinct tracks are counted after aliasing. `extraTracks` lists played, non-tracklist entries (with the mapped `track` or null) for the panel.

Excluded:
- Albums whose tracklist has ≤ 1 track (singles). *(Last.fm has no album type; call: tracklist length ≤ 1 = single.)*
- Albums with no tracklist on Last.fm (can't compute %).
- Albums with fewer than `MIN_DISTINCT_TRACKS = 3` distinct tracks played in range. Lookups (`needsLookup`) use all-time distinct tracks, so they don't depend on the range and the album cache stays valid; this limits API calls (a heavy user has ~17k albums, most with 1 track played).

## Last.fm API
- `user.getRecentTracks` (`limit=200`, `page`, `from`) — full scrobble history. Skip the `@attr.nowplaying` entry. Fields: `artist['#text']`, `album['#text']`, `name`, `date.uts`.
- `album.getInfo` (`artist`, `album`, `autocorrect=1`) — `tracks.track` (array, or single object when 1 track, or absent), `image[]` (use `extralarge`, may be empty string).
- Rate limit: stay ≤ 5 req/s overall.
- Errors from Last.fm (e.g. error 6 user not found) bubble up to the UI as a message.

## Server (Cloudflare Worker + Durable Objects)
Runs on the Workers free plan; limits and rationale in [cloudflare.md](cloudflare.md). TypeScript bundled by wrangler; relative imports use `.ts`.
- `worker/index.ts` routes, with static assets from `dist/` (SPA fallback; the Worker only runs first for `/api/*`, `/login`, `/callback`, `/logout`):
  - `POST /api/grid/:user` — starts (or reuses running) fetch, returns `{status}`.
  - `GET /api/grid/:user?from=&to=&sort=` — `{status: 'running', progress: {phase, done, total}, albums?: [...]}` (`albums` only in the `albums` phase: the grid from the albums looked up so far, same range/sort handling as done) | `{status: 'done', albums: [...]}` | `{status: 'error', message, code?}`. `from`/`to` are optional unix seconds (inclusive); when done, the ranking is computed per request in memory (no Last.fm calls). Non-numeric values → 400. `sort` is `plays` (default) or `recent`; anything else → 400. Albums carry `completedAt` and `key` (the albumKey).
  - `GET /api/grid/:user/album?key=<albumKey>&from=&to=` — `{status: 'done', album: {artist, album, image, url, tracks: [{name, plays, lastPlayed|null}]}}`, tracks in tracklist order (`albumTracks` in `rank.ts`; duplicate normalized names once), plays/dates limited to the range. Same 403 privacy rule and from/to validation as the grid; 404 if never fetched, unknown/uncached key, or still fetching scrobbles (allowed while looking up albums).
  - `POST /api/grid/:user/match` body `{key, played, track|null}` — owner only (403 otherwise); 404 unknown/uncached album, 400 if `played` wasn't played on the album or `track` isn't on its tracklist; `track: null` removes the mapping. Returns `{status: 'ok'}`. The album detail also returns `extra: [{name, plays, track|null}]` and `editable` (viewer is the owner).
  - Sign-in: `GET /login` → 302 to Last.fm auth with `cb=<origin>/callback`; `GET /callback?token=` → `auth.getSession`, random `sid` cookie (HttpOnly, Secure, 1 year), `{name, key}` stored in `SharedDO`, redirect to `/?user=<name>`; `GET /api/me` → `{name}` | `{name: null}`; `POST /logout` → 204.
- `UserDO` (`worker/user.ts`), one per lowercase username, SQLite: `meta(k, v)` (status, progress, error, private, sk, cursor) `matches(album, played, track)` (manual matches, one row per mapping, raw names) and `pages(id, data)` (one row per Last.fm page of compact scrobbles). `POST` sets the cursor and arms an alarm; each alarm makes at most 40 Last.fm fetches (free plan: 50 subrequests per invocation) and re-arms itself: first scrobble pages (`from = lastUts + 1`, fixed `to`), then `album.getInfo` for albums that need a lookup (most distinct tracks played first, so the best-heard albums appear first), cached in `SharedDO` (`getAlbums`/`putAlbums`, misses stored too). The aggregated state and album cache live on the instance and are rebuilt from storage after eviction. A failed fetch becomes `status: 'error'` with `message` and `code`; a retry after an album-phase error resumes without refetching scrobbles.
- A fetch started by a session whose name equals the requested user runs with that session key and is `private`: `GET` returns 403 to anyone else. Error 17 on an unsigned request reaches the UI as `code: 17` (UI shows the sign-in link).
- `SharedDO` (`worker/shared.ts`), single instance: `albums(key, info)` and `sessions(sid, name, key, created)`, exposed as RPC methods.

## Frontend (`web/`, Vite + React + TypeScript)
`npm run build` emits `dist/`, served by the Worker as static assets. In dev, `vite build --watch` rebuilds `dist/` while `wrangler dev` serves everything on :8787.
- Header: "Sign in with Last.fm" link, or "Signed in as <name> · Sign out".
- Username input + button, progress line while running (polling every 2s with the current from/to/sort); during the album lookup phase the poll response carries the partial grid, which is rendered under the progress line.
- Responsive grid of covers in rank order. Each tile: cover (placeholder if none), album, artist, `% · n tracks · ×full plays` (for `recent` sort, the completedAt date via `toLocaleDateString()` replaces `×full`). Tiles are buttons; clicking opens the album panel.
- Album panel (`AlbumPanel`): native `<dialog>` via `showModal()` (centered, max 520px, scrollable body; full screen at ≤600px). Closes on Esc, backdrop click, or ×. Header = cover, artist, album, tile stats line; body = tracklist (number, name, `×N`, last played date; unplayed dimmed with "—") fetched from the album endpoint with the current from/to; "Loading…" while fetching, errors shown inline; footer link "Open on Last.fm ↗".
- "From" / "To" `<input type="date">` next to the username form; either may be empty. Changing them re-ranks immediately via `GET` (no Last.fm calls). Dates are converted to unix seconds in the browser's local timezone; `to` covers the whole day.
- "Sort" `<select>` ("Most plays" = `plays`, "Recently completed" = `recent`) next to the dates; changing it re-ranks via `GET`.
- URL `?user=&from=YYYY-MM-DD&to=YYYY-MM-DD&sort=recent` (empty/default ones omitted), read on load, so grids are shareable.

## Code layout
- `shared/rank.ts` — pure: normalize, aggregate scrobbles, match tracklist, compute metrics, sort. Unit tested (`test/*.test.ts`, `node --test`).
- `shared/lastfm.ts` — API client + throttle; key/secret passed in as config.
- `worker/` — `index.ts` (routing, sign-in), `user.ts` (`UserDO`), `shared.ts` (`SharedDO`), `env.ts`.
- `web/` — `index.html`, `src/main.tsx`, `App.tsx`, `components/` (`AlbumTile`, `AuthStatus`), `style.css`. Vite config at the root (`root: 'web'`, output `dist/`).
- `wrangler.jsonc` — Worker, assets, Durable Object bindings and migration.
- `package.json` scripts: `dev` (vite build --watch + wrangler dev), `build`, `deploy`, `test`, `typecheck` (root tsconfig for shared/test, `worker/tsconfig.json`, `web/tsconfig.json`).

## Non-goals
Spotify, an external database, a local Node server.
