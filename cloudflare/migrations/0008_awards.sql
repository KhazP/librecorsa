-- Driver badges and the weekly challenge's Hall of Fame (cloudflare/api/awards.ts, issue #129).
--
-- Most badges are worked out from the boards when asked (a track record, an OG driver), but two kinds are kept here:
--   * the podiums of the weekly challenges once their week is over (`awarded_by` = 'auto'): written the first time a
--     finished week's board is read, once per week and physics version, and never again. A board's laps can go later
--     (a claim that lapses, a rename that merges two names), and a medal won stays won.
--   * the badges the owner gives by hand (`awarded_by` = 'admin'): the Bulb for an idea or a contribution, an OG or a
--     track record set somewhere the boards don't see.
--
-- `physics` is the named physics version of a weekly podium ('v1', 'v2': lap-types.ts PHYSICS_VERSIONS), so a week
-- driven under both keeps both podiums; '' for a badge that isn't about one. `event_id` is the weekly challenge
-- ("2026-W46"), '' for the rest. Neither is ever NULL, so the unique index below holds for every row: one badge of a
-- kind per driver, week and version, however many times the same award is written.

CREATE TABLE driver_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_key TEXT NOT NULL,
  badge_type TEXT NOT NULL CHECK (badge_type IN ('weekly_gold', 'weekly_silver', 'weekly_bronze', 'track_record', 'og', 'bulb')),
  event_id TEXT NOT NULL DEFAULT '',
  physics TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  awarded_at INTEGER NOT NULL,
  -- 'auto' for an archived podium, 'admin' for a badge given by hand
  awarded_by TEXT NOT NULL DEFAULT 'admin',
  -- The name, and for a podium the circuit, car and time, as they were when it was written: the Hall of Fame shows a
  -- finished week from here even once its laps are gone
  driver_name TEXT NOT NULL DEFAULT '',
  track_id TEXT NOT NULL DEFAULT '',
  vehicle TEXT NOT NULL DEFAULT '',
  lap_time_ms REAL
);
CREATE UNIQUE INDEX driver_awards_once ON driver_awards (name_key, badge_type, event_id, physics);
CREATE INDEX driver_awards_driver ON driver_awards (name_key);
CREATE INDEX driver_awards_event ON driver_awards (event_id, physics, badge_type);
