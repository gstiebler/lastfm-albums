# Album Grid — design

Web app: enter a Last.fm username, see a grid of album covers ranked by how completely you listened to each album.

## Source
Last.fm only. Public scrobbles, no user login. Server holds `LASTFM_API_KEY` (from `.env`, loaded with `node --env-file=.env`). The key never reaches the browser.

## Ranking
Per album (key: normalized artist + album name):
1. **% heard** = tracks of the album's tracklist you played ≥1 time ÷ tracklist length. Desc.
2. **Tracklist length**, desc (longer albums first on ties).
3. **Full plays** = play count of the least-played track among the tracklist tracks you played. Desc.

Matching played tracks to tracklist: by normalized track name (lowercase, trimmed, strip common suffixes like " - remastered 2011", " (remastered)"; keep it small).

Excluded:
- Albums whose tracklist has ≤ 1 track (singles). *(Last.fm has no album type; call: tracklist length ≤ 1 = single.)*
- Albums with no tracklist on Last.fm (can't compute %).
- Albums with fewer than `MIN_DISTINCT_TRACKS = 3` distinct tracks played — not looked up, to limit API calls (a heavy user has ~17k albums, most with 1 track played).

## Last.fm API
- `user.getRecentTracks` (`limit=200`, `page`, `from`) — full scrobble history. Skip the `@attr.nowplaying` entry. Fields: `artist['#text']`, `album['#text']`, `name`, `date.uts`.
- `album.getInfo` (`artist`, `album`, `autocorrect=1`) — `tracks.track` (array, or single object when 1 track, or absent), `image[]` (use `extralarge`, may be empty string).
- Rate limit: stay ≤ 5 req/s overall.
- Errors from Last.fm (e.g. error 6 user not found) bubble up to the UI as a message.

## Server (Node, no dependencies)
- `node:http` serving `public/` static files plus:
  - `POST /api/grid/:user` — starts (or reuses running) job, returns `{status}`.
  - `GET /api/grid/:user` — `{status: 'running', progress: {phase, done, total}}` | `{status: 'done', albums: [...]}` | `{status: 'error', message}`.
- In-memory job map. Disk cache in `cache/` (gitignored):
  - `cache/users/<user>.json` — scrobbles aggregated as `{lastUts, plays: {albumKey: {artist, album, tracks: {trackKey: {name, plays}}}}}`. On refresh, fetch only scrobbles with `from = lastUts + 1`.
  - `cache/albums.json` — `album.getInfo` results keyed by albumKey, shared across users (store misses too).

## Frontend (`public/`, vanilla HTML/CSS/JS)
- Username input + button, progress line while running (polling every 1s).
- Responsive grid of covers in rank order. Each tile: cover (placeholder if none), album, artist, `% · n tracks · ×full plays`. Link to the album's Last.fm page.
- Username in URL (`?user=`) so grids are shareable.

## Code layout
- `src/rank.js` — pure: normalize, aggregate scrobbles, match tracklist, compute metrics, sort. Unit tested with `node --test`.
- `src/lastfm.js` — API client + throttle.
- `src/server.js` — HTTP + jobs + cache.
- `package.json` scripts: `start` = `node --env-file=.env src/server.js`, `test` = `node --test`.

## Non-goals
Spotify, user login, a database, frameworks, build step.
