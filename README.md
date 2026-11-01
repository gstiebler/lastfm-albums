# Album Grid

See which albums you listened to in full. Enter a Last.fm username and get a grid of album covers ranked by how much of each album you heard.

## Sorting

- **Most plays** (default): % of the album's tracks you played, then album length (longer first), then full plays (play count of the least-played track you heard).
- **Recently completed**: % heard, then the date of the album's least recently played song (newest first).

A date range (From / To) limits the ranking to plays within those dates. Username, dates and sort are kept in the URL, so grids can be shared.

Excluded: singles (tracklist of 1 track), albums without a tracklist on Last.fm, and albums with fewer than 3 different tracks played.

## Setup

Requires Node 26+.

1. Create a Last.fm API account at https://www.last.fm/api/account/create (callback URL can be empty).
2. Create `.env` in the project root:
   ```
   LASTFM_API_KEY=...
   LASTFM_SHARED_SECRET=...
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## Running

Development (API server with `--watch` + Vite dev server, which proxies API and sign-in routes):
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```
The server listens on `PORT` (default 3000) and serves the built app from `dist/`.

Checks:
```bash
npm test
npm run typecheck
```

## Private profiles

Profiles with "Hide recent listening information" enabled can't be read anonymously. Those users click **Sign in with Last.fm**; their history is then fetched with their session, and their grid is visible only to them.

## How it works

- `server/` — Node HTTP server in TypeScript (run directly by Node, no build). Fetches scrobbles (`user.getRecentTracks`) and tracklists/covers (`album.getInfo`), throttled to under 5 requests/s with retries on transient errors.
- `web/` — React + Vite frontend.
- `cache/` — scrobbles per user (refreshed incrementally on each visit), album info shared across users, and sign-in sessions. Delete it to start fresh.

The first load for a large history takes a while (about 13 minutes for 60k scrobbles); later loads only fetch new scrobbles. See [docs/design.md](docs/design.md) for details.
