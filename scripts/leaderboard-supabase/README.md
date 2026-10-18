# Online leaderboard on Supabase

The online lap board runs on a free Supabase project. There's no server code to deploy: the browser calls three
Postgres functions through Supabase's REST API.

| Call | What it does |
| :-- | :-- |
| `POST /rest/v1/rpc/submit_lap` `{ "rec": LapRecording }` | Checks the lap (shape, sector sum, speeds, no teleporting), keeps each driver's best, returns `{ ok, rank }` |
| `GET /rest/v1/rpc/leaderboard?track=&vehicle=&lim=` | Top laps for a circuit and car, without the samples |
| `GET /rest/v1/rpc/get_lap?lap_id=` | One lap with its ghost samples |

The rules match the Cloudflare Worker in [`../leaderboard-worker`](../leaderboard-worker): 10 uploads an hour per
client, one row per driver, top 100 per board. The tables have row-level security on with no policies, so
only those functions can touch them. The checks are heuristics, not cheat-proof.

## Setup

1. Create a project at [supabase.com](https://supabase.com) (the free plan is enough).
2. Open **SQL Editor**, paste [`schema.sql`](schema.sql) and run it. Running it again is safe.
3. Under **Project Settings → API**, copy the project URL and the publishable (anon) key. Both are public by
   design: the key only lets the browser call what the SQL grants.
4. Add them to the GitHub repository as **variables** (Settings → Secrets and variables → Actions → Variables):
   `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The next Pages deploy picks them up.

For a local build, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local`.
