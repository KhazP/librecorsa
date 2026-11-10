# The online side

`cloudflare/worker.js` serves librecorsa.org: the static export, the large files from R2, and under `/api` the
game's online side (`cloudflare/api`). Every part of it is optional and has its own switch.

| Part | What players get | Runs on | Switch (`vars` in `wrangler.jsonc`) |
| :-- | :-- | :-- | :-- |
| Room server (`api/room.ts`) | Room codes paired by this site, "room not found" at once, relay servers for networks that block a direct link | A Durable Object per room, asleep between messages; Cloudflare TURN for the relay | `ONLINE_ROOMS` |
| Lap boards (`api/board.ts`) | The online leaderboard and the weekly challenge's board | D1 (`librecorsa-board`) and R2 (`librecorsa-ghosts`) | `ONLINE_BOARD` |
| Race server (`api/race.ts`) | Scheduled races | A Durable Object per race, which passes every car's state on while it runs | `ONLINE_RACES` |

The game asks `GET /api/config` at run time, so a switch set to `"off"` (then `npx wrangler deploy`, or a push to
main) takes effect without a new build of the game, which falls back by itself: room codes go through the public
PeerJS broker, lap times stay in the browser, the Races card goes away.

## What it costs

- **Room server, lap boards**: expected to sit within Cloudflare's free allowances at this game's size. Not yet
  measured on the live Worker: after the first deploy, check a lap upload's CPU time in the Workers logs (the free
  plan allows 10 ms per request).
- **Relay (TURN)**: billed per GB relayed, only for players who can't connect directly (roughly a cent or two per
  relayed player per hour of racing). Remove the two TURN secrets to stop it: rooms then connect directly only.
- **Race server**: the one part that works the whole time a race runs (about a cent per 8-car race hour). Set
  `ONLINE_RACES` to `"off"` to stop it: the Races card goes away, and rooms, the boards and the weekly challenge
  carry on. (The Weekly challenge panel itself needs `ONLINE_BOARD`.)

## Setting it up on another account

```sh
npx wrangler d1 create librecorsa-board            # put the id it prints in wrangler.jsonc
npx wrangler r2 bucket create librecorsa-ghosts
npx wrangler d1 migrations apply librecorsa-board --remote
npx wrangler secret put TURN_KEY_ID                # optional: a TURN key from the Cloudflare dashboard (Realtime > TURN)
npx wrangler secret put TURN_KEY_API_TOKEN
```

Build the game with `NEXT_PUBLIC_ONLINE_API=/api` (the deploy workflow does) and deploy. Without that variable the
game never asks for an online side.

## Working on it locally

```sh
npm run build                                       # once, so ./out exists (or pass --assets <an empty folder>)
npx wrangler d1 migrations apply librecorsa-board --local
npx wrangler dev --port 8787
```

and in `.env.local` for `npm run dev`: `NEXT_PUBLIC_ONLINE_API=http://127.0.0.1:8787/api`. In `.dev.vars` (not
committed): `DEV_ORIGINS=http://127.0.0.1:3000,http://localhost:3000`, and `RACE_SLOT_S=120` for a race every two
minutes instead of twenty.

The checks run without Cloudflare: `npm run verify` covers the room server, the race server (both sides) and the
boards on an in-memory database (`scripts/verify-room-server.ts`, `verify-race-server.ts`, `verify-race-client.ts`,
`verify-leaderboard.ts`).

## Rules worth knowing

- Nothing under `/api` is cached (Workers caching is on for the large files): every answer says `no-store`.
- The race server and a room's host run the same checks on everything a player sends (`src/lib/net/wire.ts`). Only
  the server ever sends a lobby or a start; a socket speaks for one car.
- The boards check laps for plausibility (`api/lap-check.ts`) but can't prove them: friendly, not a referee.
- Driver names are claimed with a driver key kept in the browser; the board stores only its SHA-256.
- The weekly challenge and the race times follow from the clock (`src/lib/net/weekly-challenge.ts`,
  `race-schedule.ts`): change the rotation there.
