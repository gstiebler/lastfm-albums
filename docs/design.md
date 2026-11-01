# Album Grid — design

Web app: enter a Last.fm username, see a grid of album covers ranked by how completely you listened to each album.

## Source
Last.fm only. Public scrobbles need no login. Server holds `LASTFM_API_KEY` and `LASTFM_SHARED_SECRET` (from `.env`, loaded with `node --env-file=.env`); they never reach the browser.

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

Matching played tracks to tracklist: by normalized track name (lowercase, trimmed, strip common suffixes like " - remastered 2011", " (remastered)"; keep it small).

Excluded:
- Albums whose tracklist has ≤ 1 track (singles). *(Last.fm has no album type; call: tracklist length ≤ 1 = single.)*
- Albums with no tracklist on Last.fm (can't compute %).
- Albums with fewer than `MIN_DISTINCT_TRACKS = 3` distinct tracks played in range. Lookups (`needsLookup`) use all-time distinct tracks, so they don't depend on the range and the album cache stays valid; this limits API calls (a heavy user has ~17k albums, most with 1 track played).

## Last.fm API
- `user.getRecentTracks` (`limit=200`, `page`, `from`) — full scrobble history. Skip the `@attr.nowplaying` entry. Fields: `artist['#text']`, `album['#text']`, `name`, `date.uts`.
- `album.getInfo` (`artist`, `album`, `autocorrect=1`) — `tracks.track` (array, or single object when 1 track, or absent), `image[]` (use `extralarge`, may be empty string).
- Rate limit: stay ≤ 5 req/s overall.
- Errors from Last.fm (e.g. error 6 user not found) bubble up to the UI as a message.

## Server (Node, no runtime dependencies)
TypeScript run directly by Node (type stripping, no build step; erasable syntax only, relative imports use `.ts`).
- `node:http` serving the built frontend from `dist/` plus:
  - `POST /api/grid/:user` — starts (or reuses running) job, returns `{status}`.
  - `GET /api/grid/:user?from=&to=&sort=` — `{status: 'running', progress: {phase, done, total}}` | `{status: 'done', albums: [...]}` | `{status: 'error', message}`. `from`/`to` are optional unix seconds (inclusive); when done, the ranking is computed per request from the job's in-memory state + album cache (no Last.fm calls, no file reads). Non-numeric values → 400. `sort` is `plays` (default) or `recent`; anything else → 400. Albums carry `completedAt` and `key` (the albumKey).
  - `GET /api/grid/:user/album?key=<albumKey>&from=&to=` — `{status: 'done', album: {artist, album, image, url, tracks: [{name, plays, lastPlayed|null}]}}`, tracks in tracklist order (`albumTracks` in `rank.ts`; duplicate normalized names once), plays/dates limited to the range. Built from job state + album cache (no Last.fm calls). Same 403 privacy rule and from/to validation as the grid; 404 if no job, job not done, or unknown key.
- Sign-in: `GET /login` → 302 to Last.fm auth with `cb=<origin>/callback`; `GET /callback?token=` → `auth.getSession`, random `sid` cookie (HttpOnly, 1 year), sessions `{name, key}` persisted in `cache/sessions.json`, redirect to `/?user=<name>`; `GET /api/me` → `{name}` | `{name: null}`; `POST /logout` → 204.
- A job started by a session whose name equals the requested user runs with that session key and is `private`: `GET` returns 403 to anyone else. Error 17 on an unsigned request reaches the UI as `code: 17` (UI shows the sign-in link).
- In-memory job map, keyed by lowercase username; a finished job keeps its loaded `state` and album `cache`. Disk cache in `cache/` (gitignored):
  - `cache/users/<user>.json` — scrobbles aggregated as `{version: 2, lastUts, plays: {albumKey: {artist, album, tracks: {trackKey: {name, times: [unix seconds of each play]}}}}}`. A file without `version: 2` is discarded (full refetch). On refresh, fetch only scrobbles with `from = lastUts + 1`.
  - `cache/albums.json` — `album.getInfo` results keyed by albumKey, shared across users (store misses too).

## Frontend (`web/`, Vite + React + TypeScript)
`npm run build` emits `dist/`, served by the server. In dev, `vite` serves `web/` and proxies `/api`, `/login`, `/callback`, `/logout` to the server on :3000 (no `changeOrigin`, so the Last.fm callback URL and cookie use the vite origin).
- Header: "Sign in with Last.fm" link, or "Signed in as <name> · Sign out".
- Username input + button, progress line while running (polling every 1s).
- Responsive grid of covers in rank order. Each tile: cover (placeholder if none), album, artist, `% · n tracks · ×full plays` (for `recent` sort, the completedAt date via `toLocaleDateString()` replaces `×full`). Tiles are buttons; clicking opens the album panel.
- Album panel (`AlbumPanel`): native `<dialog>` via `showModal()` (centered, max 520px, scrollable body; full screen at ≤600px). Closes on Esc, backdrop click, or ×. Header = cover, artist, album, tile stats line; body = tracklist (number, name, `×N`, last played date; unplayed dimmed with "—") fetched from the album endpoint with the current from/to; "Loading…" while fetching, errors shown inline; footer link "Open on Last.fm ↗".
- "From" / "To" `<input type="date">` next to the username form; either may be empty. Changing them re-ranks immediately via `GET` (no Last.fm calls). Dates are converted to unix seconds in the browser's local timezone; `to` covers the whole day.
- "Sort" `<select>` ("Most plays" = `plays`, "Recently completed" = `recent`) next to the dates; changing it re-ranks via `GET`.
- URL `?user=&from=YYYY-MM-DD&to=YYYY-MM-DD&sort=recent` (empty/default ones omitted), read on load, so grids are shareable.

## Code layout
- `server/rank.ts` — pure: normalize, aggregate scrobbles, match tracklist, compute metrics, sort. Unit tested (`test/*.test.ts`, `node --test`).
- `server/lastfm.ts` — API client + throttle.
- `server/server.ts` — HTTP + jobs + cache.
- `web/` — `index.html`, `src/main.tsx`, `App.tsx`, `components/` (`AlbumTile`, `AuthStatus`), `style.css`. Vite config at the root (`root: 'web'`, output `dist/`).
- `package.json` scripts: `dev` (server + vite), `build`, `start` = `node --env-file=.env server/server.ts`, `test`, `typecheck` (root tsconfig for server/test, `web/tsconfig.json` for the frontend).

## Non-goals
Spotify, a database, a build step for the server.
