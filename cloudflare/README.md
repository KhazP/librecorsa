# The online side

`cloudflare/worker.js` serves librecorsa.org: the static export, the large files from R2, and under `/api` the
game's online side (`cloudflare/api`). Every part of it is optional and has its own switch.

| Part | What players get | Runs on | Switch (`vars` in `wrangler.jsonc`) |
| :-- | :-- | :-- | :-- |
| Room server (`api/room.ts`) | Room codes paired by this site, "room not found" at once, relay servers for networks that block a direct link | A Durable Object per room, asleep between messages; Cloudflare TURN for the relay | `ONLINE_ROOMS` |
| Lap boards (`api/board.ts`) | The online leaderboard and the weekly challenge's board | D1 (`librecorsa-board`) and R2 (`librecorsa-ghosts`) | `ONLINE_BOARD` |
| Race server (`api/race.ts`) | Scheduled races | A Durable Object per race, which passes every car's state on while it runs | `ONLINE_RACES` |
| Usage counter (`api/usage.ts`) | Nothing they see: minutes driven per day, circuit, car, mode and country, and on their own input, screen, weather, assists and build, for the owner | D1 (`librecorsa-board`, tables `usage_daily` and `usage_extra`) | `ONLINE_USAGE` |

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
  `ONLINE_RACES` to `"off"` to stop it: the Open races card leaves the Multiplayer panel, and rooms, the boards and
  the weekly challenge carry on. (The Weekly challenge panel needs `ONLINE_BOARD`; the races run without it, with the
  grid in joining order.)

## Setting it up on another account

```sh
npx wrangler d1 create librecorsa-board            # put the id it prints in wrangler.jsonc
npx wrangler r2 bucket create librecorsa-ghosts
npx wrangler d1 migrations apply librecorsa-board --remote
npx wrangler secret put TURN_KEY_ID                # optional: a TURN key from the Cloudflare dashboard (Realtime > TURN)
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler secret put ADMIN_KEY                  # optional: the key of the private /admin page (a long random string)
npx wrangler secret put CF_ANALYTICS_TOKEN         # optional: Cloudflare's own numbers on /admin (a token with Account Analytics: Read,
                                                   # and Zone Analytics: Read for visitors); set ANALYTICS_* in wrangler.jsonc
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
committed): `DEV_ORIGINS=http://127.0.0.1:3000,http://localhost:3000`, `ADMIN_KEY=<any local key>` for `/admin`, and `RACE_SLOT_S=120` for a race every two
minutes instead of twenty.

The checks run without Cloudflare: `npm run verify` covers the room server, the race server (both sides) and the
boards on an in-memory database (`scripts/verify-room-server.ts`, `verify-race-server.ts`, `verify-race-client.ts`,
`verify-leaderboard.ts`), and the usage counter and the admin numbers (`verify-usage.ts`).

## Rules worth knowing

- Nothing under `/api` is cached (Workers caching is on for the large files): every answer says `no-store`.
- The race server and a room's host run the same checks on everything a player sends (`src/lib/net/wire.ts`). Only
  the server ever sends a lobby, a start or a result; a socket speaks for one car.
- Each car reports its finish once; the race server classifies the reports with the game's own order and sends one
  official result, final when everyone is in or 90 s after the first finish (`src/lib/net/official-result.ts`). A
  finish faster than the race allows, or from a car that never raced, is refused.
- The boards check laps for plausibility (`api/lap-check.ts`) but can't prove them: friendly, not a referee.
- Driver names are claimed with a driver key kept in the browser; the board stores only its SHA-256.
- The usage counter: when a stretch of driving of half a minute or more ends (back to the menu, another circuit, car
  or kind of session, the flag, the page hidden or closed), the game sends `POST /api/usage` with the circuit, the car
  model, the mode (`practice`, `time_trial`, `ai_race`, `open_race`, `room_race`) and the minutes. The Worker checks
  each field, caps the minutes at 240, limits one address to 10 reports a minute (`USAGE_LIMIT`), and adds one session
  and the minutes to that day's row in `usage_daily` (migration `0003_usage.sql`) with the country Cloudflare puts on
  the request. No address, player id or cookie is stored. Newer builds add what the stretch was driven with: `input`
  (keyboard, controller, wheel, touch), `device` (desktop, tablet, phone), `weather` (dry, wet), `assists` and `build`
  (the commit: `NEXT_PUBLIC_BUILD` in the deploy, put in a `lc-build` meta tag so the game's script stays the same). Each is added up on its own in `usage_extra` (migration
  `0004_admin_numbers.sql`), one row per day, field and value, never crossed with another field, the circuit or the
  country. An unknown value is left out and the rest of the report still counts.
- The owner's numbers: `GET /api/admin/stats?days=30` (1 to 90 days) with the header `X-Admin-Key`, read by the page
  `/admin` (not linked, not indexed; it asks for the key and keeps it for the tab). Set the key once with
  `npx wrangler secret put ADMIN_KEY`, and locally in `.dev.vars`. Without the secret, or with any other key, the route
  answers 404 like any unknown path. The page reads, for the range: hours and sessions against the days before, per day
  and per weekday, circuits split by mode, cars, countries, the extras above, driver names (new and returning), board
  times per day and what they were set with, the busiest boards, the weekly challenges, the open races (grid size,
  finishes, wins and podiums by name) and who is waiting for the next one. A part whose table is not there yet reads
  as null and the rest still answers.
- Cloudflare's numbers: `GET /api/admin/cloudflare` (same key), from Cloudflare's GraphQL Analytics API with the
  secret `CF_ANALYTICS_TOKEN`, for the last 7 days: the Worker's requests, errors and CPU time, the database's rows
  and size, each R2 bucket, the Durable Objects' requests, and with `ANALYTICS_ZONE_ID` set the site's visitors and
  page views per day (`api/analytics.ts`). One request per dataset, so a field Cloudflare renames fails only its own
  part, listed on the page with Cloudflare's message. Without the token the route is a 404 like any unknown path.
- Race results (`api/results.ts`, `migrations/0002_race_results.sql`): when an open race's result turns final, the
  race server stores it on the boards' database, one row per race and one per car (name, place, time, laps, best lap,
  grid place). A car's row counts for a driver (the week's standings, `GET /api/races/results`, and the record,
  `GET /api/drivers/record`) only when its driver key owns the name it raced under; the key reaches the server once
  per race socket and only its SHA-256 is kept. Room results are not stored. The deploy workflow applies the
  migration (`wrangler d1 migrations apply`), as for the boards.
- The weekly challenge and the race times follow from the clock (`src/lib/net/weekly-challenge.ts`,
  `race-schedule.ts`): change the rotation there.
