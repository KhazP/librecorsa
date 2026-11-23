-- Covering index for driver profiles (cloudflare/api/profile.ts) and distinct-driver board counts:
-- seeks a board's rows by (track_id, vehicle, physics, event) and reads every driver's best time and
-- tie-break columns without table lookups.
CREATE INDEX laps_board_driver ON laps (track_id, vehicle, physics, event, name_key, lap_time_ms, created_at, id);
