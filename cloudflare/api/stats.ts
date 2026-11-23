/**
 * The boards' totals, read by the lap times panel, the HUD's lap board, the title screen and the home page:
 *   GET /api/stats/circuit?track=&vehicle=&physics=&version=   -> { ok: true, laps, drivers }
 *        laps:    laps driven on the circuit (in that car), every revision: the laps the usage reports counted
 *                 (migration 0006), or the laps stored on the boards when that is more (an honest lower bound: the
 *                 counter is newer than the boards, and only a faster lap is stored)
 *        drivers: drivers on the circuit's open board (the car's, on `physics`, else its current revision; with
 *                 vehicle=all, every car on its revision on the board of base revision `version`, as board.ts reads
 *                 it, else the board laps go on now), with no filter: the board's own size
 *   GET /api/stats                                    -> { ok: true, drivers, live }
 *        drivers: drivers to date, everyone who has driven a lap on a board or in an open race. Counted by name (a
 *                 rename takes the laps and the results with it, so a renamed driver counts once), and only names
 *                 a driver key proved: a race result under a name nobody claimed is not a driver this can count
 *        live:    tabs on /play right now (presence.ts), null with the live count off
 *
 * And the usage totals' public side, read by the circuit and car browsers and the press page. Each is one dimension on
 * its own over a whole range, never crossed with the day, the country or another field, so no number here can point at
 * one player:
 *   GET /api/stats/popular                            -> { ok: true, days, circuits, cars }
 *        circuits, cars: the ids driven most over the last POPULAR_DAYS days, most hours first, as ranks with no
 *                 numbers. Only what the game still has (a retired circuit stays out), and only ids with at least
 *                 POPULAR_MIN_SESSIONS sessions in the range, so a few players can't set the order
 *   GET /api/stats/totals                             -> { ok: true, since, hours, laps, countries, drivers }
 *        since:   the first day the usage totals counted, "2026-11-11"; hours, laps and countries are since then
 *        hours:   whole hours driven; laps: laps driven, or the laps on the boards when that is more (as above)
 *        countries: countries the driving came from; drivers: drivers to date, null with the boards off
 * Neither takes a query string (index.ts): one copy of each is kept at the edge for everyone.
 */
import { CIRCUIT_IDS } from "./admin";
import { currentBoardBase, lapPhysicsVersion, MAX_LAP_REVISION } from "../../src/lib/sim/lap-types";
import { isVehicleModelId } from "../../src/types/f1";
import { ALL_CARS, askedBoardBase, currentPhysicsWhere } from "./board";
import { TRACK_ID_RE } from "./lap-check";
import type { D1Database } from "./types";

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** A count from a statement that may not run on an older database (a table or column its migration adds): 0 then */
async function countOr0(db: D1Database, sql: string, binds: unknown[]): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(...binds).first<{ n: number | null }>();
    return Math.max(0, Math.floor(Number(row?.n ?? 0)) || 0);
  } catch {
    return 0;
  }
}

export interface CircuitTotals {
  laps: number;
  drivers: number;
}

/**
 * A circuit's laps and drivers, for one car (on `physics`, else its current revision) or every car (on the board of base
 * revision `physics`, else the board laps go on now)
 */
export async function circuitTotals(db: D1Database, track: string, vehicle: string, physics?: number): Promise<CircuitTotals> {
  const allCars = vehicle === ALL_CARS;
  const car = allCars ? "" : " AND vehicle = ?";
  const carBind = allCars ? [] : [vehicle];
  let driversWhere: string;
  let driversBinds: unknown[];
  if (allCars) {
    const current = currentPhysicsWhere(physics ?? currentBoardBase(track));
    driversWhere = `track_id = ? AND event = '' AND ${current.sql}`;
    driversBinds = [track, ...current.binds];
  } else {
    driversWhere = "track_id = ? AND vehicle = ? AND physics = ? AND event = ''";
    driversBinds = [track, vehicle, physics ?? lapPhysicsVersion(vehicle as never, track)];
  }
  const [stored, counted, drivers] = await Promise.all([
    // A weekly challenge's lap is stored on the open board as well: the open board alone counts each once
    countOr0(db, `SELECT COUNT(*) AS n FROM laps WHERE track_id = ?${car} AND event = ''`, [track, ...carBind]),
    countOr0(db, `SELECT SUM(laps) AS n FROM usage_daily WHERE track_id = ?${car}`, [track, ...carBind]),
    countOr0(db, `SELECT COUNT(DISTINCT name_key) AS n FROM laps WHERE ${driversWhere}`, driversBinds),
  ]);
  return { laps: Math.max(stored, counted), drivers };
}

/** Drivers to date: every name with a lap on a board or a lap in an open race it was proven for */
export async function driversToDate(db: D1Database): Promise<number> {
  const withRaces = await countOr0(
    db,
    "SELECT COUNT(*) AS n FROM (SELECT name_key FROM laps UNION SELECT name_key FROM race_cars WHERE name_key IS NOT NULL AND laps >= 1)",
    [],
  );
  // Before the race results' table (migration 0002), the boards alone
  return withRaces || countOr0(db, "SELECT COUNT(DISTINCT name_key) AS n FROM laps", []);
}

export async function circuitStats(db: D1Database, url: URL): Promise<Answer> {
  const q = url.searchParams;
  const track = q.get("track") ?? "";
  const vehicle = q.get("vehicle") ?? ALL_CARS;
  if (!TRACK_ID_RE.test(track) || (vehicle !== ALL_CARS && !isVehicleModelId(vehicle))) return fail("track and vehicle are required");
  let physics: number | undefined;
  if (vehicle === ALL_CARS) {
    // One of the circuit's boards for every car, as the board reads it
    const version = askedBoardBase(q, track);
    if (version === null) return fail("Unknown physics version");
    physics = version;
  } else if (q.has("physics")) {
    physics = Number(q.get("physics"));
    if (!Number.isInteger(physics) || physics < 1 || physics > MAX_LAP_REVISION) return fail("Unknown physics revision");
  }
  const totals = await circuitTotals(db, track, vehicle, physics);
  return { status: 200, body: { ok: true, ...totals } };
}

/** The window the most-driven ranks cover */
export const POPULAR_DAYS = 30;
/** Sessions a circuit or car needs in that window to be ranked */
export const POPULAR_MIN_SESSIONS = 50;
const DAY_MS = 86_400_000;

export interface PopularRanks {
  days: number;
  circuits: string[];
  cars: string[];
}

/** The circuits and cars driven most over the last POPULAR_DAYS UTC days (today included), most hours first */
export async function popularRanks(db: D1Database, nowMs: number): Promise<PopularRanks> {
  const from = new Date(nowMs - (POPULAR_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const ranked = async (column: "track_id" | "vehicle", keep: (id: string) => boolean): Promise<string[]> => {
    const rows = await db
      .prepare(
        `SELECT ${column} AS id FROM usage_daily WHERE day >= ? GROUP BY ${column} HAVING SUM(sessions) >= ? ORDER BY SUM(minutes) DESC, ${column} LIMIT 500`,
      )
      .bind(from, POPULAR_MIN_SESSIONS)
      .all<{ id: unknown }>();
    return rows.results.map((r) => String(r.id)).filter(keep);
  };
  const [circuits, cars] = await Promise.all([ranked("track_id", (id) => CIRCUIT_IDS.has(id)), ranked("vehicle", isVehicleModelId)]);
  return { days: POPULAR_DAYS, circuits, cars };
}

export interface SiteTotals {
  since: string | null;
  hours: number;
  laps: number;
  countries: number;
  drivers: number | null;
}

/** Everything the usage totals have counted, and drivers to date when the boards are on */
export async function siteTotals(db: D1Database, withDrivers: boolean): Promise<SiteTotals> {
  const usage = async (laps: string) =>
    db
      .prepare(`SELECT MIN(day) AS since, SUM(minutes) AS minutes, ${laps} AS laps, COUNT(DISTINCT CASE WHEN country != 'XX' THEN country END) AS countries FROM usage_daily`)
      .first<{ since: unknown; minutes: unknown; laps: unknown; countries: unknown }>();
  // Before migration 0006 the usage rows count no laps: the boards' own then
  const row = await usage("SUM(laps)").catch(() => usage("0"));
  const whole = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0)) || 0);
  const [stored, drivers] = await Promise.all([
    countOr0(db, "SELECT COUNT(*) AS n FROM laps WHERE event = ''", []),
    withDrivers ? driversToDate(db) : Promise.resolve(null),
  ]);
  return {
    since: typeof row?.since === "string" ? row.since : null,
    hours: Math.floor(whole(row?.minutes) / 60),
    laps: Math.max(whole(row?.laps), stored),
    countries: whole(row?.countries),
    drivers,
  };
}
