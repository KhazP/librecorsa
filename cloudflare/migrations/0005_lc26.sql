-- The 2026 Prototype's id went from vf26 to lc26. The rows stored under the old id are the same car's, so they take
-- the new one: its earlier boards, its races and its usage stay its own.
--
-- A lap keeps its physics revision, so an old lap stays on the board it was set on and never ranks against laps of
-- a later revision. Where a driver already has an lc26 lap on the same board, the quicker of the two is kept.

DELETE FROM laps
WHERE vehicle = 'vf26' -- keep-old-id
  AND EXISTS (
    SELECT 1 FROM laps AS n
    WHERE n.vehicle = 'lc26' AND n.track_id = laps.track_id AND n.physics = laps.physics AND n.event = laps.event
      AND n.assists = laps.assists AND n.realism = laps.realism AND n.surface = laps.surface
      AND n.name_key = laps.name_key AND n.lap_time_ms <= laps.lap_time_ms
  );
DELETE FROM laps
WHERE vehicle = 'lc26'
  AND EXISTS (
    SELECT 1 FROM laps AS o
    WHERE o.vehicle = 'vf26' AND o.track_id = laps.track_id AND o.physics = laps.physics AND o.event = laps.event -- keep-old-id
      AND o.assists = laps.assists AND o.realism = laps.realism AND o.surface = laps.surface
      AND o.name_key = laps.name_key
  );
UPDATE laps SET vehicle = 'lc26' WHERE vehicle = 'vf26'; -- keep-old-id

UPDATE races SET vehicle = 'lc26' WHERE vehicle = 'vf26'; -- keep-old-id

-- Usage is a count per day: a day both ids have is added up
INSERT INTO usage_daily (day, track_id, vehicle, mode, country, sessions, minutes)
SELECT day, track_id, 'lc26', mode, country, sessions, minutes FROM usage_daily WHERE vehicle = 'vf26' -- keep-old-id
ON CONFLICT (day, track_id, vehicle, mode, country) DO UPDATE SET
  sessions = sessions + excluded.sessions,
  minutes = minutes + excluded.minutes;
DELETE FROM usage_daily WHERE vehicle = 'vf26'; -- keep-old-id
