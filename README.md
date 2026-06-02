# Estimathon — Cloudflare (Workers + Durable Objects)

Real-time multiplayer Estimathon. The host drives from one screen (cast it to a TV);
players join on their phones over the room code. State lives in a single Durable Object
per room (authoritative, strongly consistent), pushed to everyone over WebSockets.

## Deploy (≈5 minutes)

You need Node 18+ installed. Then:

```bash
npm install
npx wrangler login      # one-time, opens a browser to authorize your Cloudflare account
npm run deploy          # builds the app + deploys; prints your https://estimathon.<you>.workers.dev URL
```

Open the URL, tap **Host a game**, read out the 4-letter code, and players join at the
same URL. That's it.

Later changes (e.g. editing a question) are just an edit + `npm run deploy` again.
To verify a build without deploying: `npm run check` (runs `wrangler deploy --dry-run`).

## How it works

- **`src/worker.ts`** — the Worker entry plus the `Room` Durable Object. One DO instance
  per room code holds all state and the connected WebSockets (hibernatable, so idle rooms
  cost nothing). It validates every intent, mutates state, and broadcasts. Scoring happens
  here, so it's authoritative.
- **`src/bank.js`** — the question bank **with answers** and the scoring. Server-only:
  the client bundle never imports it, so answers can't be read from the browser. Clients
  receive only question text plus a coarse mode hint until reveal.
- **`src/shared.js`** — answer-free helpers shared by client and server (formatting,
  magnitude scale, proximity metric, round metadata).
- **`src/client/`** — the React UI. Connects to `/room/:code/ws`, renders server state,
  sends intents. Auto-reconnects with backoff; the host token + room code are saved in
  `localStorage`, so a refresh on any device resumes with no retyping.

## Config notes

- `wrangler.jsonc` uses `new_sqlite_classes` for the DO migration (SQLite-backed →
  works on the **free** Workers plan) and serves the built SPA from `./dist` via static
  assets, with `run_worker_first: ["/room/*"]` so only the WebSocket path hits the Worker.
- Rename the worker by changing `name` in `wrangler.jsonc`.

## Editing the game

- Questions / answers / rounds: `src/bank.js`.
- Scoring rules and the small-vs-large proximity threshold (`RATIO_MIN`): `src/shared.js`
  (threshold) and `src/bank.js` (`scoreRound`).
