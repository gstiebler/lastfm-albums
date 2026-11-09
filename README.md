# Album Grid

See which albums you listened to in full. Enter a Last.fm username and get a grid of album covers ranked by how much of each album you heard.

## Sorting

- **Most plays** (default): % of the album's tracks you played, then album length (longer first), then full plays (play count of the least-played track you heard).
- **Recently completed**: % heard, then the date of the album's least recently played song (newest first).
- **By artist**: albums grouped by artist, artists with the most songs heard first (summed over their albums), albums within an artist in *Most plays* order.

A date range (From / To) limits the ranking to plays within those dates. Username, dates and sort are kept in the URL, so grids can be shared.

Click an album to open a details panel with its tracklist: play count and last played date per track (within the selected date range), unplayed tracks dimmed, and a link to the album on Last.fm. Close it with Esc, the × button or by clicking outside.

The **Debug** button lists your latest scrobbles with the reason each does or doesn't appear in the grid (`GET /api/grid/:user/debug?n=`).

Excluded: singles (tracklist of 1 track), albums without a tracklist on Last.fm, and albums with fewer than 3 different tracks played.

## Setup

Requires Node 26+ and a free Cloudflare account (see [docs/cloudflare.md](docs/cloudflare.md)).

1. Create a Last.fm API account at https://www.last.fm/api/account/create (callback URL can be empty).
2. Install dependencies and log in to Cloudflare:
   ```bash
   npm install
   npx wrangler login
   ```
3. Create `.dev.vars` (gitignored) in the project root for local development:
   ```
   LASTFM_API_KEY=...
   LASTFM_SHARED_SECRET=...
   ```

## Running

Development (Vite rebuild on change + `wrangler dev` on http://localhost:8787):
```bash
npm run dev
```

Deploy (to `https://album-grid.<your-subdomain>.workers.dev`):
```bash
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_SHARED_SECRET
npm run deploy
```

Checks:
```bash
npm test
npm run typecheck
```

## Private profiles

Profiles with "Hide recent listening information" enabled can't be read anonymously. Those users click **Sign in with Last.fm**; their history is then fetched with their session, and their grid is visible only to them.

## How it works

- `worker/` — Cloudflare Worker routing requests to Durable Objects: one `UserDO` per Last.fm user (fetches scrobbles and album info in alarm chunks, stores them in SQLite, ranks in memory) and one `SharedDO` (album cache and sign-in sessions). Runs on the free plan.
- `shared/` — ranking (`rank.ts`) and the Last.fm client (`lastfm.ts`, throttled to under 5 requests/s with retries on transient errors).
- `web/` — React + Vite frontend.

The first load for a large history takes a while (about 13 minutes for 60k scrobbles); later loads only fetch new scrobbles. See [docs/design.md](docs/design.md) for details.
