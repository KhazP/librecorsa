# The online side

`cloudflare/worker.js` serves librecorsa.org: the static export, the large files from R2, and under `/api` the
game's online side (`cloudflare/api`). Every part of it is optional and has its own switch.

| Part | What players get | Runs on | Switch (`vars` in `wrangler.jsonc`) |
| :-- | :-- | :-- | :-- |
| Room server (`api/room.ts`) | Room codes paired by this site, "room not found" at once, relay servers for networks that block a direct link | A Durable Object per room, asleep between messages; Cloudflare TURN for the relay | `ONLINE_ROOMS` |
| Lap boards (`api/board.ts`) | The online leaderboard and the weekly challenge's board | D1 (`librecorsa-board`) and R2 (`librecorsa-ghosts`) | `ONLINE_BOARD` |
| Race server (`api/race.ts`) | Scheduled races | A Durable Object per race, which passes every car's state on while it runs | `ONLINE_RACES` |
| Usage counter (`api/usage.ts`) | Nothing they see: minutes driven per day, circuit, car, mode and country, and on their own input, screen, weather, assists and build, for the owner | D1 (`librecorsa-board`, tables `usage_daily` and `usage_extra`) | `ONLINE_USAGE` |
| Live count (`api/presence.ts`) | "LIVE · 23 driving now" on the title screen | One Durable Object that counts the last minute's heartbeats in memory | `ONLINE_LIVE` |
| Player accounts (`api/accounts/`) | Optional sign-in with Discord, Google, Steam or a passkey: names kept on the account (they never lapse), a save the account's devices share, link codes for the desktop app | D1 (`librecorsa-accounts`, plus `drivers.account_id` and `account_keys` on `librecorsa-board`) and R2 (`librecorsa-ghosts`, under `accounts/ghosts/`) | `ONLINE_ACCOUNTS` |

The game asks `GET /api/config` at run time, so a switch set to `"off"` (then `npx wrangler deploy`, or a push to
main) takes effect without a new build of the game, which falls back by itself: room codes go through the public
PeerJS broker, lap times stay in the browser, the Races card goes away, the game keeps a driver key per device and
no account.

## What it costs

- **Room server, lap boards**: expected to sit within Cloudflare's free allowances at this game's size. Not yet
  measured on the live Worker: after the first deploy, check a lap upload's CPU time in the Workers logs (the free
  plan allows 10 ms per request).
- **Relay (TURN)**: billed per GB relayed, only for players who can't connect directly (roughly a cent or two per
  relayed player per hour of racing). Remove the two TURN secrets to stop it: rooms then connect directly only.
- **Live count**: a Worker request and a Durable Object request per tab in view per minute, and the object's time in
  memory while anyone has the game open (about 0.125 GB-s a second). One tab open around the clock is about 43,000
  requests and 324,000 GB-s a month, inside the Workers Paid plan's monthly 1 million object requests and 400,000
  GB-s (shared with the room and race servers); past those, $0.15 per million requests and $12.50 per million GB-s.
  Each further tab adds requests, not memory time: 100 tabs around the clock are about 4.3 million object requests a
  month, roughly $0.50 past the allowance, and as many Worker requests against the plan's 10 million a month ($0.30
  per million past them).
- **Player accounts**: sign-in costs nothing (Discord, Google, Steam and passkeys are free, and no email is sent).
  A session check is a D1 read per call and a sync a few rows, far inside the Workers Paid plan's 25 billion reads and
  50 million writes a month. Saves are JSON in D1: assuming up to 100 KB an account, 20,000 accounts are 2 GB, inside
  the 5 GB the plan includes ($0.75 a GB past it). Cloud ghosts are the one part that grows: a ghost is about 122 KB
  (measured on the boards), and assuming 40 best laps an account, 3,000 accounts hold about 15 GB in R2 (about $0.22 a
  month at $0.015 a GB, once the bucket is past its free 10 GB) and 20,000 about 98 GB (about $1.47). The server holds
  an account to 400 ghosts and a save to 1 MB, and a ghost no save points at goes an hour later. One R2 write per new
  best lap, against a million free a month. Set `ONLINE_ACCOUNTS` to `"off"` to stop it: every account route answers
  404, and the game keeps a driver key per device as before.
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
npx wrangler secret put CREATOR_KEY_HASH           # optional: SHA-256 (hex) of the game maker's driver key; the names it
                                                   # holds wear the Creator badge (printf %s '<key>' | shasum -a 256 | cut -d' ' -f1)
npx wrangler secret put CF_ANALYTICS_TOKEN         # optional: Cloudflare's own numbers on /admin (a token with Account Analytics: Read,
                                                   # and Zone Analytics: Read for visitors); set ANALYTICS_* in wrangler.jsonc
```

Build the game with `NEXT_PUBLIC_ONLINE_API=/api` (the deploy workflow does) and deploy. Without that variable the
game never asks for an online side.

### Player accounts

```sh
npx wrangler d1 create librecorsa-accounts                    # put the id it prints in wrangler.jsonc (ACCOUNTS_DB)
npx wrangler d1 migrations apply librecorsa-accounts --remote
npx wrangler d1 migrations apply librecorsa-board --remote    # migration 0011: drivers.account_id and account_keys
npx wrangler secret put DISCORD_CLIENT_ID                     # optional: Discord sign-in shows once both are set
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID                      # optional: Google sign-in shows once both are set
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Steam and passkeys need nothing: Steam's OpenID 2.0 sign-in has no key, and a passkey belongs to the site's host name.
The redirect each provider must allow, exactly:

| Provider | Redirect URI |
| :-- | :-- |
| Discord | `https://librecorsa.org/api/auth/callback/discord` |
| Google | `https://librecorsa.org/api/auth/callback/google` |
| Steam | `https://librecorsa.org/api/auth/callback/steam` (sent with each sign-in; nothing to register) |

- **Discord** ([developer portal](https://discord.com/developers/applications)): **New Application** (call it
  LibreCorsa). Under **OAuth2**, copy the **Client ID**, press **Reset Secret** and copy the **Client Secret**, and add
  the redirect above under **Redirects**. Leave **Public Client** off. No bot is needed. The game asks for the scope
  `identify` only, which gives the user id; the server keeps that id and nothing else.
- **Google** ([Cloud console](https://console.cloud.google.com/)): make a project. Under **Google Auth Platform**, set
  up the consent screen: the app name LibreCorsa, a support email, `librecorsa.org` as an authorised domain, the privacy
  policy `https://librecorsa.org/privacy`, the audience **External**, and publish it to production. Add no scopes: the
  game asks for `openid` only, which needs no review, and Google then sends the account's `sub` and no email or name.
  Under **Clients**, make an OAuth client of type **Web application** with the redirect above under **Authorized
  redirect URIs** (no JavaScript origins are needed), and copy its client ID and secret.

## Working on it locally

```sh
npm run build                                       # once, so ./out exists (or pass --assets <an empty folder>)
npx wrangler d1 migrations apply librecorsa-board --local
npx wrangler dev --port 8787
```

and in `.env.local` for `npm run dev`: `NEXT_PUBLIC_ONLINE_API=http://127.0.0.1:8787/api`. In `.dev.vars` (not
committed): `DEV_ORIGINS=http://127.0.0.1:3000,http://localhost:3000`, `ADMIN_KEY=<any local key>` for `/admin`, and `RACE_SLOT_S=120` for a race every two
minutes instead of twenty.

Accounts locally: `npx wrangler d1 migrations apply librecorsa-accounts --local` as well, and start the Worker with
`npx wrangler dev --port 8787 --infer-origin-from-routes=false`: without the flag it sees every request as one to
librecorsa.org (the route in `wrangler.jsonc`), and passkeys and sign-in redirects then name the wrong site. On plain
http the session cookie is `lc_session` (not `__Host-lc_session`, which needs https). Cookies and passkeys go by host
name, so use
`localhost` for both the game and the Worker (`NEXT_PUBLIC_ONLINE_API=http://localhost:8787/api`, and
`http://localhost:3000` in `DEV_ORIGINS`): `127.0.0.1` and `localhost` are different sites to a browser. A sign-in
started from a `DEV_ORIGINS` page comes back to it. Discord and Google sign-in locally need
`http://localhost:8787/api/auth/callback/<provider>` added as a redirect on their side; Steam, passkeys and link codes
work as they are.

The checks run without Cloudflare: `npm run verify` covers the room server, the race server (both sides) and the
boards on an in-memory database (`scripts/verify/verify-room-server.ts`, `verify-race-server.ts`, `verify-race-client.ts`,
`verify-leaderboard.ts`), the boards' pages and totals (`verify-board-stats.ts`), the usage counter
(`verify-usage.ts`), the admin numbers with the limits that guard them (`verify-admin.ts`), and player accounts with
Discord, Google and Steam played by a stand-in and a software passkey (`verify-accounts.ts`).

## Rules worth knowing

- Under `/api` only the answers that are the same for everyone are cached (Workers caching is on for the large
  files): a board's page read without a driver's name (`public, max-age=30`), the totals, `GET /api/stats`
  (30 s) and `GET /api/stats/circuit` (60 s), and the Hall of Fame and badges, `GET /api/hall-of-fame` and
  `GET /api/badges` (60 s). Everything else, errors included, says `no-store`, so a driver's own
  place shows their new lap at once.
- The boards' pages: `GET /api/laps` takes `offset` (places skipped) with `limit` (1 to 100), and `near=1..5` adds the
  places either side of the driver's own. `vehicle=all` is the circuit's board over every car: each driver once,
  with their fastest lap in any car, each car on the physics revision this build ships it on (worked out in the Worker
  from `revisionOnBoard`, and sent back as `current`, so a browser on the LC26's older engine still reads it).
- The totals (`api/stats.ts`): a circuit's laps are the laps the usage reports counted (migration
  `0006_lap_counts.sql`), or the laps stored on its boards when that is more, so the number is an honest lower bound
  from day one; its drivers are its current board's. Drivers to date are the names with a lap on a board or in an open
  race result their driver key proved, counted once per name (a rename takes the laps and results along).
- The race server and a room's host run the same checks on everything a player sends (`src/lib/net/wire.ts`). Only
  the server ever sends a lobby, a start or a result; a socket speaks for one car.
- Each car reports its finish once; the race server classifies the reports with the game's own order and sends one
  official result, final when everyone is in or 90 s after the first finish (`src/lib/net/official-result.ts`). A
  finish faster than the race allows, or from a car that never raced, is refused.
- The boards check laps for plausibility (`api/lap-check.ts`) but can't prove them: friendly, not a referee.
- Lap uploads and name changes: 20 a minute per address (`BOARD_LIMIT`, before anything reaches the database), then
  30 an hour (counted in D1, `lap_posts`).
- Driver names are claimed with a driver key kept in the browser; the board stores only its SHA-256. A name the
  filter refuses (`src/lib/net/name-filter.ts`) can't be claimed, and races as "Driver" on the race server.
- The usage counter: when a stretch of driving of half a minute or more ends (back to the menu, another circuit, car
  or kind of session, the flag, the page hidden or closed), the game sends `POST /api/usage` with the circuit, the car
  model, the mode (`practice`, `time_trial`, `ai_race`, `open_race`, `room_race`) and the minutes. The Worker checks
  each field, caps the minutes at 240, limits one address to 10 reports a minute (`USAGE_LIMIT`), and adds one session
  and the minutes to that day's row in `usage_daily` (migration `0003_usage.sql`) with the country Cloudflare puts on
  the request. No address, player id or cookie is stored. Newer builds also send the laps the stretch completed, added
  to the same row (`laps`, capped at six a minute). Newer builds add what the stretch was driven with: `input`
  (keyboard, controller, wheel, touch), `device` (desktop, tablet, phone), `weather` (dry, wet), `assists` and `build`
  (the commit: `NEXT_PUBLIC_BUILD` in the deploy, put in a `lc-build` meta tag so the game's script stays the same). Each is added up on its own in `usage_extra` (migration
  `0004_admin_numbers.sql`), one row per day, field and value, never crossed with another field, the circuit or the
  country. An unknown value is left out and the rest of the report still counts.
- The owner's numbers: `GET /api/admin/stats?days=30` (1 to 90 days) with the key as `Authorization: Bearer <key>`
  (a header Cloudflare's logs redact), read by the page `/admin`. The page is not linked, not in the sitemap and not
  indexed, and until the key opens it it shows one password field and nothing else; the key stays in the tab's memory.
  Set the key once with `npx wrangler secret put ADMIN_KEY`, and locally in `.dev.vars`. Every request to
  `/api/admin/*` counts against `ADMIN_LIMIT` (20 a minute per address) before the key is compared, a right key too, and
  so does every path the API doesn't serve: without the secret, with any other key, or with a fault while reading, an
  admin route answers the same 404 as an unknown path, and past the limit the same 429. The page reads, for the range:
  hours and sessions against the days before; sessions, hours, countries, board times, new names and laps driven per
  day; circuits split by mode, and the circuits the game no longer has (ids not in `public/tracks/index.json`, still
  driven on old builds); minutes a session by screen, input, mode, assists, weather, circuit and car; each day's builds
  with the day each was first seen, and the share still on a build replaced before that day (usage is per UTC day, so a
  deploy day splits between two builds and neither counts as behind); cars and countries; names new, seen and
  back a day or more after their claim; board times per day and by class; the busiest boards and the weekly
  challenges; the open races per day (grid sizes, finishes, proven names, wins and podiums by name) and who is waiting
  for the next one. The live count at the top comes from `GET /api/stats`. A part whose table or column is not there
  yet reads as null or zero and the rest still answers.
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
- The live count: while a `/play` tab is in view, the game sends an empty `POST /api/live` once a minute, and none
  while it is hidden. The Worker limits one address to 6 a minute (`LIVE_LIMIT`) and passes the beat to one Durable
  Object (`PresenceCounter`, migration tag `v2`), which keeps only the arrival times of the last minute's beats, in
  memory: each tab in view beats once a minute, so they are the count. Nothing is written to storage and nothing about
  the sender is kept. A pending timer keeps the object awake while a beat is still within the minute (an idle object
  can be put to sleep after about ten seconds, and its memory with it); with nobody left it may sleep. `GET /api/stats`
  reads it, with the drivers to date. Set `ONLINE_LIVE` to `"off"` to stop it: no heartbeats are sent, and the title
  screen shows the drivers to date alone.
- Player accounts (`api/accounts/`, wire format `src/lib/account/api-types.ts`): sign-in through Discord (OAuth with
  PKCE, scope `identify`), Google (OpenID Connect with PKCE and a nonce, scope `openid`) or Steam (OpenID 2.0, checked
  back with Steam), by hand with no framework, or with a passkey (`@simplewebauthn/server`, which bundles for Workers
  without `nodejs_compat`). The server keeps the provider's id of the player and nothing else. A sign-in under way lives
  10 minutes, once, in `auth_states`, and its `state` also sits in a short `__Host-lc_auth` cookie: the callback needs
  both, so a provider's answer that reaches another browser goes nowhere. A session is a random token in an HttpOnly
  `__Host-lc_session` cookie (SameSite=Lax, 400 days); the database keeps its SHA-256, writes its last use at most once
  an hour, and ends it after a year unused. Every POST and PUT under `/api/auth` and `/api/account` needs an Origin
  the API allows (the site's own or `DEV_ORIGINS`), and one with none is refused. Starting a sign-in, a passkey
  ceremony, and typing a link code count against `AUTH_LIMIT` (20 a minute per address); the cloud save against
  `SAVE_LIMIT` (60 a minute), with its ghosts on a budget of their own.
- Names on accounts: a device joins with its driver key (`POST /api/account/device`), and every name the key holds
  joins the account. From then on any key on the account proves any of its names, in the four places a name is proven
  (uploads, renames, race results, the Creator badge; `api/name-proof.ts`), and a name on an account never lapses. A
  key taken off the account leaves its names to the account's other keys (their key hash becomes `account:<id>`).
  Proving another account's sign-in or passkey while signed in folds that account into this one: its sign-ins,
  passkeys, sessions, names, keys and ghosts move over, and its save waits in `pending_saves` for the next device to
  combine it. Deleting an account takes its sign-ins, sessions, save and ghosts; its names go back to their keys and
  lapse as any other, or with "remove my laps" their laps, ghosts and badges go too and their race results stay as an
  anonymous "Driver". The boards' side of a merge or a deletion runs first, so a failure halfway leaves the account to
  try again. The deploy workflow applies `migrations-accounts` with the boards' migrations.
- The weekly challenge and the race times follow from the clock (`src/lib/net/weekly-challenge.ts`,
  `race-schedule.ts`): change the rotation there.
