-- The official results of the open races (cloudflare/api/race.ts writes them, cloudflare/api/results.ts reads them).
--
-- One row per race and one per car on its grid. A car's row carries the driver name it raced under; `name_key` (the
-- name's claim key, as in `drivers`) is set only when the name was proven with its driver key, and only those rows
-- count for a driver's standings and record.

CREATE TABLE races (
  id TEXT PRIMARY KEY,
  -- The weekly challenge the race belongs to ("2026-W46")
  week TEXT NOT NULL,
  -- 'open': a scheduled race on the race server
  kind TEXT NOT NULL,
  track_id TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  laps INTEGER NOT NULL,
  -- When the result turned final (ms since the epoch)
  finished_ms INTEGER NOT NULL
);
CREATE INDEX races_week ON races (week, finished_ms);

CREATE TABLE race_cars (
  race_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name_key TEXT,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  -- Race time with penalties (s); null for a DNF
  time_s REAL,
  penalty_s REAL NOT NULL DEFAULT 0,
  laps INTEGER NOT NULL,
  best_lap_ms REAL,
  dnf INTEGER NOT NULL,
  -- Place on the grid (1 = pole)
  grid INTEGER NOT NULL,
  PRIMARY KEY (race_id, position)
);
CREATE INDEX race_cars_driver ON race_cars (name_key);
