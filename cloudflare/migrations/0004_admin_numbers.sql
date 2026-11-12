-- More of the owner's numbers (cloudflare/api/admin.ts).
--
-- Board times are read by when they were set. A driver's newer best replaces their older one, so this is the times
-- still on the boards, by the day each was set.
CREATE INDEX laps_created ON laps (created_at);

-- The usage counter's extra fields (cloudflare/api/usage.ts, USAGE_EXTRAS in src/lib/net/usage-modes.ts): input,
-- device, weather, assists and build. One row per day, field and value, each added up on its own and never crossed
-- with the circuit, the country or another field. Like usage_daily, nothing here tells two players apart.
CREATE TABLE usage_extra (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  minutes REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, value)
);
