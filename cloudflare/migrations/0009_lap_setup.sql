-- Marks laps that include the car's Garage setup in their R2 JSON payload (`laps/<id>.json`),
-- so leaderboard rows can offer an "Apply setup" action without downloading every ghost upfront.
ALTER TABLE laps ADD COLUMN has_setup INTEGER NOT NULL DEFAULT 0;
