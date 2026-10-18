# Leaderboard worker

Reference online leaderboard for the simulator: a Cloudflare Worker that stores
submitted laps (with their ghosts) in KV and serves the top laps per circuit and car.
The simulator talks to it through `src/lib/net/leaderboard.ts`; it is optional.

## Deploy

```sh
cd scripts/leaderboard-worker
npx wrangler kv namespace create LAPS
# paste the printed id into wrangler.toml (replaces REPLACE_WITH_KV_NAMESPACE_ID)
npx wrangler deploy
```

Set `ALLOWED_ORIGIN` in `wrangler.toml` to the site that hosts the simulator.

## Connect the simulator

Set the worker URL (no trailing slash) when building the simulator:

```sh
NEXT_PUBLIC_LEADERBOARD_URL=https://librecorsa-leaderboard.<your-subdomain>.workers.dev npm run build
```

Without the variable the simulator only shows the local board.

## API

- `POST /laps` with a lap recording as JSON (max 2 MB). Returns `{ ok: true, rank }` or `{ ok: false, error }` with status 400.
- `GET /laps?track=<id>&vehicle=<id>&limit=<n>` returns `{ laps: [...] }`, fastest first (limit 1-100, default 20).
- `GET /laps/<id>` returns the stored lap recording (ghost) or 404.

Each driver (code and name) holds one row per circuit and car; a slower lap does not replace their best.
Boards keep the top 100 rows. Uploads are limited to 10 per IP per hour.

## Plausibility checks

The worker rejects laps whose lap time does not match the last sample (within 1.5 s),
whose sector times do not add up to the lap time (within 50 ms), whose samples are out
of range or go back in time, and whose consecutive positions imply more than 420 km/h.

These checks only stop careless or malformed uploads. They are not cheat-proof: anyone
can fabricate a lap that passes them. Treat the board as friendly, not as a referee.
KV is also eventually consistent, so the hourly limit and the board update are best effort.
