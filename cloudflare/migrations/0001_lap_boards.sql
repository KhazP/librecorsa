-- The online lap boards (cloudflare/api/board.ts). Ghost samples live in the librecorsa-ghosts R2 bucket under
-- laps/<id>.json; a row here is a lap without its samples.
--
-- One board per circuit, car and physics revision. A driver keeps one row per class (assists, realism, surface):
-- the board shows each driver's fastest row, with what it was driven with, and can be narrowed to a class.
-- `event` is '' for the open boards, or the id of a weekly challenge ("2026-W46"), which has its own board.

CREATE TABLE laps (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL,
  vehicle TEXT NOT NULL,
  physics INTEGER NOT NULL,
  event TEXT NOT NULL DEFAULT '',
  assists TEXT NOT NULL,
  realism TEXT NOT NULL,
  surface TEXT NOT NULL,
  compound TEXT NOT NULL,
  name_key TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  driver_code TEXT NOT NULL,
  lap_time_ms REAL NOT NULL,
  s1_ms REAL NOT NULL,
  s2_ms REAL NOT NULL,
  s3_ms REAL NOT NULL,
  recorded_at REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX laps_driver_class ON laps (track_id, vehicle, physics, event, assists, realism, surface, name_key);
CREATE INDEX laps_board ON laps (track_id, vehicle, physics, event, lap_time_ms);
CREATE INDEX laps_driver ON laps (name_key);

-- Claimed driver names: the normalised name and the SHA-256 (hex) of its owner's driver key
CREATE TABLE drivers (
  name_key TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Uploads per client per hour (the client address is stored hashed)
CREATE TABLE lap_posts (
  client_hash TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_hash, hour)
);
