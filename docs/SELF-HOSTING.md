# Self-hosting and the online backend

LibreCorsa is a static Next.js export (`out/`) that runs on any static file host with zero backend required. Adding the optional Cloudflare Worker (`cloudflare/worker.js`) unlocks custom-domain room matchmaking, TURN relays, global lap boards, ghost storage, scheduled open races, optional player accounts, and the public `/stats` page.

## Static-only hosting

Running `npm run build` outputs a complete static bundle to `./out` (including `offline-manifest.json` for offline service-worker support). Served from any static host (GitHub Pages, Cloudflare Pages, Netlify, or Nginx), a static-only copy provides:

- Full single-player driving, AI races, local replays, local ghosts, and car setups
- Peer-to-peer multiplayer rooms paired via the public PeerJS broker (plus manual WebRTC offer/answer and local-tab racing)
- Browser-local personal bests

A fresh clone includes **RISE Motordrome**, the **LC26 Prototype** (`public/cars/f12026/`) and the **LC25 Prototype** (`public/cars/lc25/`). Other hosted cars and circuits are stored outside git in R2 and are listed only when built with `NEXT_PUBLIC_HOSTED_CONTENT=1`.

## Full online backend (Cloudflare Worker)

The Cloudflare Worker in `cloudflare/` serves the static bundle, streams large R2 assets (`> 25 MiB`), and exposes `/api/*` (`cloudflare/api/`). Every online subsystem is independent and controlled by a runtime switch in `wrangler.jsonc`:

| Subsystem | Player-facing feature | Backing services | `wrangler.jsonc` switch |
| :-- | :-- | :-- | :-- |
| **Room server** (`api/room.ts`) | Private room codes, instant room lookup, Cloudflare TURN relay credentials | Durable Object per room (sleeps when idle) + Cloudflare TURN | `ONLINE_ROOMS` |
| **Lap boards** (`api/board.ts`) | Per-circuit/car leaderboards, ghosts, Hall of Fame, and weekly challenge | D1 (`librecorsa-board`) + R2 (`librecorsa-ghosts`) | `ONLINE_BOARD` |
| **Race server** (`api/race.ts`) | Scheduled open races every 20 minutes | Durable Object per active race | `ONLINE_RACES` |
| **Usage counter & public stats** (`api/usage.ts`, `api/stats.ts`) | Aggregate daily session minutes, laps, anonymous dimension counts, and the public `/stats` page | D1 (`usage_daily`, `usage_extra`) | `ONLINE_USAGE` |
| **Live count** (`api/presence.ts`) | `"LIVE · N driving now"` indicator on the title screen | Single in-memory Durable Object (`PresenceCounter`) | `ONLINE_LIVE` |
| **Player accounts** (`api/accounts/`) | Optional sign-in (Discord, Google, Steam, passkeys), cross-device driver names, cloud saves, and desktop link codes | D1 (`librecorsa-accounts`, plus `drivers.account_id` / `account_keys` on `librecorsa-board`) + R2 (`librecorsa-ghosts`) | `ONLINE_ACCOUNTS` |

Because the client queries `GET /api/config` on startup, setting any switch to `"off"` and running `npx wrangler deploy` takes effect immediately without rebuilding the frontend. The game degrades cleanly: rooms fall back to PeerJS, laps stay local, and open races hide automatically.

## Deploying on your own Cloudflare account

1. **Create D1, R2, and apply migrations:**

   ```sh
   npx wrangler d1 create librecorsa-board        # copy the database_id into wrangler.jsonc
   npx wrangler d1 create librecorsa-accounts     # optional: for ONLINE_ACCOUNTS (ACCOUNTS_DB)
   npx wrangler r2 bucket create librecorsa-ghosts
   npx wrangler d1 migrations apply librecorsa-board --remote
   npx wrangler d1 migrations apply librecorsa-accounts --remote
   ```

2. **Configure optional secrets:**

   ```sh
   # Optional: Cloudflare Realtime TURN relay credentials for players behind strict NATs
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN

   # Optional: OAuth sign-in providers for ONLINE_ACCOUNTS (Steam OpenID and passkeys need no secrets)
   npx wrangler secret put DISCORD_CLIENT_ID
   npx wrangler secret put DISCORD_CLIENT_SECRET
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET

   # Optional: Bearer token protecting the private /admin dashboard (long random string)
   npx wrangler secret put ADMIN_KEY

   # Optional: SHA-256 hex digest of the maintainer's driver key to display the Creator badge
   # (printf %s '<driver-key>' | shasum -a 256 | cut -d' ' -f1)
   npx wrangler secret put CREATOR_KEY_HASH

   # Optional: Cloudflare GraphQL analytics token for /admin (Account Analytics: Read + Zone Analytics: Read)
   npx wrangler secret put CF_ANALYTICS_TOKEN
   ```

3. **Build and deploy:**

   Build with `NEXT_PUBLIC_ONLINE_API=/api` set so the client talks to your Worker's API routes, then deploy with `npx wrangler deploy`:

   ```sh
   NEXT_PUBLIC_ONLINE_API=/api npm run build
   npx wrangler deploy
   ```

   Without `NEXT_PUBLIC_ONLINE_API`, the static build never attempts to call `/api`.

## Running the backend locally

```sh
# 1. Build ./out once (or pass --assets pointing at an empty directory)
npm run build

# 2. Apply D1 migrations locally and launch Wrangler
npx wrangler d1 migrations apply librecorsa-board --local
npx wrangler d1 migrations apply librecorsa-accounts --local
npx wrangler dev --port 8787 --infer-origin-from-routes=false
```

Configure two local gitignored files for dev (use `localhost` for both the game and Worker when testing accounts so cookies and passkeys share a host):

- **`.env.local`:**

  ```dotenv
  NEXT_PUBLIC_ONLINE_API=http://localhost:8787/api
  ```

- **`.dev.vars`** (read by `wrangler dev`):

  ```dotenv
  DEV_ORIGINS=http://127.0.0.1:3000,http://localhost:3000
  ADMIN_KEY=local-dev-secret
  RACE_SLOT_S=120
  ```

Setting `RACE_SLOT_S=120` starts open races every 2 minutes instead of every 20 minutes during development.

To run all backend verification tests without a Cloudflare account (using an in-memory D1/R2 harness), run `npm run verify`, which covers `verify-room-server.ts`, `verify-race-server.ts`, `verify-race-client.ts`, `verify-leaderboard.ts`, `verify-board-stats.ts`, `verify-usage.ts`, `verify-admin.ts`, and `verify-accounts.ts`.

## Operational notes

- **HTTP caching:** Public endpoints shared across all drivers use edge caches (`GET /api/laps` without a driver parameter and `GET /api/stats` cache for `30 s`; `/api/stats/circuit`, `/api/hall-of-fame`, `/api/badges`, and `/api/drivers/profile` cache for `60 s`; `/api/stats/totals` and `/api/stats/public` cache for `1 h` via Cloudflare's Cache API with in-isolate single-flight coalescing; `/api/stats/popular` caches for `6 h`). Personalized responses and errors return `no-store` so newly uploaded laps appear immediately.
- **Rate limits:** Lap uploads and renames are limited to `20/min` at the Worker edge (`BOARD_LIMIT`) and `30/hour` in D1 (`lap_posts`). Public stats reads cap at `30/min` (`STATS_LIMIT`), badge and driver profile reads at `60/min` (`BADGES_LIMIT`, `PROFILE_LIMIT`), account auth ceremonies at `20/min` (`AUTH_LIMIT`), cloud save and ghost syncs at `60/min` (`SAVE_LIMIT`), usage reports at `10/min` (`USAGE_LIMIT`, `240` min max per report), live heartbeats at `6/min` (`LIVE_LIMIT`), and `/api/admin/*` at `20/min` (`ADMIN_LIMIT`) before checking the token. Unauthenticated or misconfigured admin routes return a standard `404` indistinguishable from unknown paths.
- **Privacy by design:** Driver keys are stored strictly as SHA-256 hashes, raw IP addresses are never stored in D1, usage counters aggregate only per-day totals without cookies or player IDs, and the live counter holds only one-minute heartbeat timestamps in memory.
- **Weekly challenge and race schedule:** Both derive deterministically from the UTC clock in `src/lib/net/weekly-challenge.ts` and `src/lib/net/race-schedule.ts`; edit those files to customize a league's calendar.
- **Cost profile:** The room server and lap boards generally sit within Cloudflare's free tier for small communities. Player accounts cap each save at `1 MB` in D1 and `400` cloud ghosts in R2. TURN relays bill per gigabyte relayed (only for peers unable to connect directly; omit the TURN secrets to disable relaying). Live presence and scheduled open races use Durable Object requests and duration (~1¢ per 8-car race hour for open races; `ONLINE_LIVE`, `ONLINE_RACES`, and `ONLINE_ACCOUNTS` can be switched off independently at any time).
