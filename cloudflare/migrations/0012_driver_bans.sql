-- Drivers barred from the online boards by hand (cheated laps): one row per barred name, with the scrambled driver key
-- that held it and the account it was on, so the same browser or account can't post under another name either
CREATE TABLE driver_bans (
  name_key TEXT PRIMARY KEY,
  key_hash TEXT,
  account_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  banned_at INTEGER NOT NULL
);
CREATE INDEX driver_bans_key ON driver_bans (key_hash);
CREATE INDEX driver_bans_account ON driver_bans (account_id);
