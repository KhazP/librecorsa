/**
 * Driver profile across all current open lap boards (GitHub #170):
 *   GET /api/drivers/profile?name=
 *     -> { ok: true, name, nameKey, code, rating, circuitsDriven, boardsEntered, laps: [...] }
 *
 * Returns a driver's best lap per (circuit, car) on the current shipping board revision (`shippingLapPhysicsVersion`)
 * under the Lap times board's default filters (open boards `event = ''`, all assists/realism/surface classes), with
 * their 1-based board position and distinct-driver board size on each.
 *
 * Rating formula (0–100, null when the driver has no laps on current official boards):
 *   1. For each (circuit, car) board entered at 1-based position `p` out of `N` distinct drivers, compute the
 *      midpoint percentile:
 *        q = 100 * (N - p + 0.5) / N
 *      Every board of size N >= 1 has an exact mean of 50.0, and a solo 1-driver board (p = 1, N = 1) scores 50.0
 *      (neutral) so uncontested boards cannot inflate a rating.
 *   2. Aggregate boards on the same circuit `c` into one circuit percentile `q_c` weighted by opponent count `N - 1`
 *      (falling back to 50.0 when every board entered on that circuit has N = 1). Driving many cars on one circuit
 *      still counts as one circuit, and a 1-driver board neither drags down nor props up contested boards there.
 *   3. Shrink the mean across the `C` distinct circuits driven toward the 50th percentile using a Bayesian average
 *      with `RATING_PRIOR_CIRCUITS` (5) pseudo-circuits at `RATING_PRIOR_MEAN` (50):
 *        rating = (sum(q_c) + 5 * 50) / (C + 5)
 *      Rounded to one decimal place. Few circuits stay near 50; consistent top finishes across many circuits climb
 *      toward 100.
 *
 * Bounded D1 work: 1 prepared statement per request. Uses `laps_driver` to seek only this driver's rows, then seeks
 * each entered board once through the covering index `laps_board_driver` (migration 0010; falls back to `laps_board`
 * on pre-0010 databases without a table scan).
 */
import trackIndex from "../../public/tracks/index.json";
import { CIRCUIT_BOARD_RESETS } from "../../src/lib/circuit-board-resets";
import {
  CIRCUIT_REVISION_STEP,
  circuitRevision,
  PHYSICS_VERSION,
  shippingLapPhysicsVersion,
  type LapConditions,
} from "../../src/lib/sim/lap-types";
import { isVehicleModelId, VEHICLE_MODEL_IDS, type VehicleModelId } from "../../src/types/f1";
import { driverNameKey } from "./board";
import type { D1Database } from "./types";

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

const MAX_NAME_LENGTH = 64;

/** Prior strength (pseudo-circuits) and prior mean (50th percentile) for Bayesian rating shrinkage */
export const RATING_PRIOR_CIRCUITS = 5;
export const RATING_PRIOR_MEAN = 50;

/** Listed official circuits in this build (unlisted and unknown track ids stay off public profiles and ratings) */
const OFFICIAL_CIRCUITS: ReadonlySet<string> = new Set(
  (trackIndex as { id: string; unlisted?: boolean }[]).filter((t) => !t.unlisted).map((t) => t.id),
);

export interface DriverProfileLap {
  id: string;
  trackId: string;
  vehicle: VehicleModelId;
  lapTimeMs: number;
  sectorTimesMs: [number, number, number];
  recordedAt: number;
  /** 1-based place in the board's order (time, then earlier created_at, then id) */
  position: number;
  /** Distinct drivers on this (circuit, car) board */
  boardSize: number;
  conditions: LapConditions;
}

export interface DriverProfileAnswer {
  ok: true;
  name: string;
  nameKey: string;
  code: string | null;
  rating: number | null;
  circuitsDriven: number;
  boardsEntered: number;
  laps: DriverProfileLap[];
}

/** Midpoint percentile in (0, 100) for 1-based `position` out of `boardSize` drivers (1 of 1 -> 50.0) */
export function boardPercentile(position: number, boardSize: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(boardSize) || boardSize < 1) return RATING_PRIOR_MEAN;
  const clampedPos = Math.min(boardSize, Math.max(1, position));
  return (100 * (boardSize - clampedPos + 0.5)) / boardSize;
}

/**
 * Computes the Bayesian average percentile rating across distinct circuits (0–100, 1 decimal), or null when empty.
 * See the module header for the full formula.
 */
export function computeDriverRating(entries: readonly { trackId: string; position: number; boardSize: number }[]): number | null {
  if (entries.length === 0) return null;
  const byCircuit = new Map<string, { weightedSum: number; weight: number }>();
  for (const e of entries) {
    const p = boardPercentile(e.position, e.boardSize);
    const w = Math.max(0, e.boardSize - 1);
    const acc = byCircuit.get(e.trackId);
    if (acc) {
      acc.weightedSum += p * w;
      acc.weight += w;
    } else {
      byCircuit.set(e.trackId, { weightedSum: p * w, weight: w });
    }
  }
  const circuits = byCircuit.size;
  if (circuits === 0) return null;
  let circuitSum = 0;
  for (const acc of byCircuit.values()) {
    circuitSum += acc.weight > 0 ? acc.weightedSum / acc.weight : RATING_PRIOR_MEAN;
  }
  const shrunk = (circuitSum + RATING_PRIOR_CIRCUITS * RATING_PRIOR_MEAN) / (circuits + RATING_PRIOR_CIRCUITS);
  return Math.round(shrunk * 10) / 10;
}

/** True when a lap belongs to a listed official circuit on the car's current shipping physics revision */
export function isOfficialProfileBoard(trackId: string, vehicle: string, physics: number): vehicle is VehicleModelId {
  return OFFICIAL_CIRCUITS.has(trackId) && isVehicleModelId(vehicle) && physics === shippingLapPhysicsVersion(vehicle, trackId);
}

/**
 * SQL predicate matching every car's current shipping physics revision across all circuits, including any circuit
 * restarts in `CIRCUIT_BOARD_RESETS`. Keeps bind parameters tiny (3 today) regardless of how many circuits exist.
 */
export function currentProfilePhysicsWhere(): { sql: string; binds: unknown[] } {
  const commonBase = PHYSICS_VERSION;
  const specialVehicles = VEHICLE_MODEL_IDS.map((v) => [v, shippingLapPhysicsVersion(v, "")] as const).filter(
    ([, rev]) => rev !== commonBase,
  );
  const vehicleSql =
    specialVehicles.length > 0
      ? `CASE vehicle ${specialVehicles.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END`
      : "?";
  const vehicleBinds: unknown[] = [...specialVehicles.flat(), commonBase];

  const resetCircuits = Object.keys(CIRCUIT_BOARD_RESETS)
    .map((trackId) => [trackId, circuitRevision(trackId) * CIRCUIT_REVISION_STEP] as const)
    .filter(([, step]) => step > 0);
  if (resetCircuits.length === 0) {
    return { sql: `physics = (${vehicleSql})`, binds: vehicleBinds };
  }
  const circuitSql = `CASE track_id ${resetCircuits.map(() => "WHEN ? THEN ?").join(" ")} ELSE 0 END`;
  return {
    sql: `physics = (${vehicleSql}) + (${circuitSql})`,
    binds: [...vehicleBinds, ...resetCircuits.flat()],
  };
}

interface ProfileRow {
  id: string;
  track_id: string;
  vehicle: string;
  physics: number;
  assists: string;
  realism: string;
  surface: string;
  compound: string;
  input?: string | null;
  driver_name: string;
  driver_code: string;
  lap_time_ms: number;
  s1_ms: number;
  s2_ms: number;
  s3_ms: number;
  recorded_at: number;
  created_at: number;
  position: number;
  board_size: number;
}

/** Builds the single bounded SQL statement that finds a driver's current best laps and board positions */
export function driverProfileQuery(nameKey: string): { sql: string; binds: unknown[] } {
  const physics = currentProfilePhysicsWhere();
  const sql = `WITH my_laps AS (
  SELECT *,
    ROW_NUMBER() OVER (PARTITION BY track_id, vehicle, physics ORDER BY lap_time_ms, created_at, id) AS rn
  FROM laps
  WHERE name_key = ? AND event = '' AND ${physics.sql}
),
my_best AS MATERIALIZED (
  SELECT * FROM my_laps WHERE rn = 1 ORDER BY track_id, vehicle, physics
),
board_drivers AS (
  SELECT m.track_id, m.vehicle, m.physics, l.name_key,
    MAX(CASE
      WHEN l.lap_time_ms < m.lap_time_ms
        OR (l.lap_time_ms = m.lap_time_ms AND (l.created_at < m.created_at OR (l.created_at = m.created_at AND l.id < m.id)))
      THEN 1 ELSE 0
    END) AS is_ahead
  FROM my_best m
  CROSS JOIN laps l
  WHERE l.track_id = m.track_id AND l.vehicle = m.vehicle AND l.physics = m.physics AND l.event = ''
  GROUP BY m.track_id, m.vehicle, m.physics, l.name_key
),
board_stats AS (
  SELECT track_id, vehicle, physics,
    COUNT(*) AS board_size,
    1 + SUM(is_ahead) AS position
  FROM board_drivers
  GROUP BY track_id, vehicle, physics
)
SELECT m.*, s.position, s.board_size
FROM my_best m
JOIN board_stats s ON s.track_id = m.track_id AND s.vehicle = m.vehicle AND s.physics = m.physics
ORDER BY m.track_id, m.vehicle`;
  return { sql, binds: [nameKey, ...physics.binds] };
}

export async function driverProfile(db: D1Database, url: URL): Promise<Answer> {
  const rawName = url.searchParams.get("name") ?? "";
  if (rawName.length > MAX_NAME_LENGTH) return fail(`Driver name must be at most ${MAX_NAME_LENGTH} characters`);
  const nameKey = driverNameKey(rawName);
  if (!nameKey) return fail("name is required");

  const { sql, binds } = driverProfileQuery(nameKey);
  const query = await db.prepare(sql).bind(...binds).all<ProfileRow>();

  let displayName = rawName.trim();
  let code: string | null = null;
  let newestCreatedAt = -Infinity;
  const laps: DriverProfileLap[] = [];
  const circuits = new Set<string>();

  for (const r of query.results) {
    if (!isOfficialProfileBoard(r.track_id, r.vehicle, r.physics)) continue;
    const position = Math.max(1, Math.floor(Number(r.position)));
    const boardSize = Math.max(position, Math.floor(Number(r.board_size)));
    if (r.created_at >= newestCreatedAt) {
      newestCreatedAt = r.created_at;
      if (r.driver_name) displayName = r.driver_name;
      if (r.driver_code) code = r.driver_code;
    }
    circuits.add(r.track_id);
    laps.push({
      id: r.id,
      trackId: r.track_id,
      vehicle: r.vehicle,
      lapTimeMs: r.lap_time_ms,
      sectorTimesMs: [r.s1_ms, r.s2_ms, r.s3_ms],
      recordedAt: r.recorded_at,
      position,
      boardSize,
      conditions: {
        assists: r.assists as LapConditions["assists"],
        realism: r.realism as LapConditions["realism"],
        surface: r.surface as LapConditions["surface"],
        compound: r.compound as LapConditions["compound"],
        physicsVersion: r.physics,
        ...(r.input ? { input: r.input as LapConditions["input"] } : {}),
      },
    });
  }

  // Strongest relative results first: highest board percentile, then best position, then largest board, then id
  laps.sort(
    (a, b) =>
      boardPercentile(b.position, b.boardSize) - boardPercentile(a.position, a.boardSize) ||
      a.position - b.position ||
      b.boardSize - a.boardSize ||
      (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0) ||
      (a.vehicle < b.vehicle ? -1 : a.vehicle > b.vehicle ? 1 : 0),
  );

  const body: DriverProfileAnswer = {
    ok: true,
    name: displayName,
    nameKey,
    code,
    rating: computeDriverRating(laps),
    circuitsDriven: circuits.size,
    boardsEntered: laps.length,
    laps,
  };
  return { status: 200, body };
}
