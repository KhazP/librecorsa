-- The anonymous usage counter (cloudflare/api/usage.ts): how much is driven, per UTC day, circuit, car, mode and
-- country. Each stretch of driving the game reports adds one session and its minutes to its row. Nothing here
-- tells two players apart: no address, no player id, only these sums.
--
-- `vehicle` is the vehicle model the car drives on (several bodies share one), `mode` one of practice, time_trial,
-- ai_race, open_race, room_race, `country` the two letters Cloudflare puts on the request ("XX" when it has none).

CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  track_id TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  mode TEXT NOT NULL,
  country TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, track_id, vehicle, mode, country)
);
