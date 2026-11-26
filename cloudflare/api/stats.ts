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
 * And the usage totals' public side, read by the circuit and car browsers, the press page and the public stats page.
 * Each is one dimension on its own over a whole range, never crossed with the day, the country or another field, so no
 * number here can point at one player:
 *   GET /api/stats/popular                            -> { ok: true, days, circuits, cars }
 *        circuits, cars: the ids driven most over the last POPULAR_DAYS days, most hours first, as ranks with no
 *                 numbers. Only what the game still has (a retired circuit stays out), and only ids with at least
 *                 POPULAR_MIN_SESSIONS sessions in the range, so a few players can't set the order
 *   GET /api/stats/totals                             -> { ok: true, since, hours, laps, countries, drivers }
 *        since:   the first day the usage totals counted, "2026-11-11"; hours, laps and countries are since then
 *        hours:   whole hours driven; laps: laps driven, or the laps on the boards when that is more (as above)
 *        countries: countries the driving came from; drivers: drivers to date, null with the boards off
 *   GET /api/stats/public                             -> PublicStats
 *        all-time totals plus the last PUBLIC_STATS_DAYS days of anonymous usage aggregates (daily totals, top active
 *        circuits/cars/countries with at least PUBLIC_MIN_SESSIONS sessions, modes, input/device/weather/assists
 *        splits), lap board summary and open race summary. Never includes builds, retired circuits, retention,
 *        accounts, individual driver names or Cloudflare infra numbers.
 * None of these three takes a query string (index.ts): one copy of each is kept at the edge for everyone.
 */
import { CIRCUIT_IDS } from "./admin";
import { currentBoardBase, lapPhysicsVersion, MAX_LAP_REVISION } from "../../src/lib/sim/lap-types";
import { isVehicleModelId } from "../../src/types/f1";
import { ALL_CARS, askedBoardBase, currentPhysicsWhere } from "./board";
import { TRACK_ID_RE } from "./lap-check";
import { utcDay } from "./usage";
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

/** Fixed window for the public stats page (UTC days, today included) */
export const PUBLIC_STATS_DAYS = 30;
/** Minimum sessions in the window for a circuit, car or country to appear on the public stats page */
export const PUBLIC_MIN_SESSIONS = 10;
const PUBLIC_TOP = 15;
const PUBLIC_MODES = new Set(["practice", "time_trial", "ai_race", "open_race", "room_race"]);
const PUBLIC_EXTRAS: Record<"input" | "device" | "weather" | "assists", ReadonlySet<string>> = {
  input: new Set(["keyboard", "controller", "wheel", "touch"]),
  device: new Set(["desktop", "tablet", "phone"]),
  weather: new Set(["dry", "wet"]),
  assists: new Set(["pro", "semi_pro", "assisted"]),
};

export interface PublicUsageGroup {
  id: string;
  sessions: number;
  minutes: number;
  laps: number;
}

export interface PublicShareGroup {
  id: string;
  sessions: number;
  minutes: number;
}

export interface PublicCount {
  id: string;
  n: number;
}

export interface PublicStats {
  days: number;
  from: string;
  to: string;
  allTime: SiteTotals;
  totals: {
    sessions: number;
    minutes: number;
    laps: number;
    countries: number;
    lapsCounted: boolean;
  };
  perDay: { day: string; sessions: number; minutes: number; laps: number; countries: number }[];
  byCircuit: PublicUsageGroup[];
  byCar: PublicUsageGroup[];
  byMode: PublicUsageGroup[];
  byCountry: PublicUsageGroup[];
  extras: {
    input: PublicShareGroup[];
    device: PublicShareGroup[];
    weather: PublicShareGroup[];
    assists: PublicShareGroup[];
  } | null;
  boards: {
    lapsTotal: number;
    lapsInRange: number;
    driversTotal: number;
    lapsBy: {
      assists: PublicCount[];
      realism: PublicCount[];
      surface: PublicCount[];
      compound: PublicCount[];
    };
    challenges: { event: string; laps: number; drivers: number }[];
  } | null;
  races: {
    count: number;
    cars: number;
    finished: number;
    drivers: number;
    fieldMax: number;
    perDay: { day: string; races: number; cars: number }[];
    perWeek: { week: string; races: number; cars: number }[];
  } | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const mins = (v: unknown): number => Math.round(num(v) * 10) / 10;
const DAY_OF = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;

async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** Public aggregate stats for /stats: all-time totals plus a fixed 30-day anonymous breakdown */
export async function publicStats(
  db: D1Database,
  nowMs: number,
  opts: { withBoards: boolean; withRaces: boolean },
): Promise<PublicStats> {
  const to = utcDay(nowMs);
  const from = utcDay(nowMs - (PUBLIC_STATS_DAYS - 1) * DAY_MS);
  const sinceMs = Date.parse(`${from}T00:00:00Z`);
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await db.prepare(sql).bind(...binds).all<T>()).results;
  const first = async <T>(sql: string, ...binds: unknown[]): Promise<T> => ((await db.prepare(sql).bind(...binds).first<T>()) ?? {}) as T;

  const lapsCounted = (await orNull(() => db.prepare("SELECT laps FROM usage_daily LIMIT 1").all())) !== null;
  const LAPS = lapsCounted ? "SUM(laps)" : "0";
  const usageGroup = (r: { id: unknown; sessions?: unknown; minutes?: unknown; laps?: unknown }): PublicUsageGroup => ({
    id: String(r.id),
    sessions: num(r.sessions),
    minutes: mins(r.minutes),
    laps: num(r.laps),
  });

  const usageReads = Promise.all([
    siteTotals(db, opts.withBoards),
    first<{ sessions: number; minutes: number; laps: number }>(
      `SELECT SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ?`,
      from,
    ),
    first<{ n: number }>("SELECT COUNT(DISTINCT country) AS n FROM usage_daily WHERE day >= ? AND country != 'XX'", from),
    all<{ day: string; sessions: number; minutes: number; laps: number; countries: number }>(
      `SELECT day, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps, COUNT(DISTINCT CASE WHEN country != 'XX' THEN country END) AS countries FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`,
      from,
    ),
    all<{ id: string; sessions: number; minutes: number; laps: number }>(
      `SELECT track_id AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ? GROUP BY track_id HAVING SUM(sessions) >= ? ORDER BY SUM(minutes) DESC, track_id LIMIT 500`,
      from,
      PUBLIC_MIN_SESSIONS,
    ),
    all<{ id: string; sessions: number; minutes: number; laps: number }>(
      `SELECT vehicle AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ? GROUP BY vehicle HAVING SUM(sessions) >= ? ORDER BY SUM(minutes) DESC, vehicle LIMIT 50`,
      from,
      PUBLIC_MIN_SESSIONS,
    ),
    all<{ id: string; sessions: number; minutes: number; laps: number }>(
      `SELECT mode AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ? GROUP BY mode ORDER BY SUM(minutes) DESC, mode LIMIT 20`,
      from,
    ),
    all<{ id: string; sessions: number; minutes: number; laps: number }>(
      `SELECT country AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ? AND country != 'XX' GROUP BY country HAVING SUM(sessions) >= ? ORDER BY SUM(minutes) DESC, country LIMIT ${PUBLIC_TOP}`,
      from,
      PUBLIC_MIN_SESSIONS,
    ),
    orNull(() =>
      all<{ name: string; value: string; sessions: number; minutes: number }>(
        "SELECT name, value, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_extra WHERE day >= ? AND name IN ('input', 'device', 'weather', 'assists') GROUP BY name, value ORDER BY SUM(minutes) DESC, value",
        from,
      ),
    ),
  ]);

  const boardReads = opts.withBoards
    ? orNull(() =>
        Promise.all([
          first<{ total: number; inRange: number }>("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS inRange FROM laps", sinceMs),
          all<{ dim: string; id: string; n: number }>(
            ["assists", "realism", "surface", "compound"]
              .map((c) => `SELECT '${c}' AS dim, ${c} AS id, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY ${c}`)
              .join(" UNION ALL "),
            sinceMs,
            sinceMs,
            sinceMs,
            sinceMs,
          ),
          all<{ event: string; laps: number; drivers: number }>(
            "SELECT event, COUNT(*) AS laps, COUNT(DISTINCT name_key) AS drivers FROM laps WHERE event != '' GROUP BY event ORDER BY event DESC LIMIT 8",
          ),
        ]),
      )
    : Promise.resolve(null);

  const raceReads = opts.withRaces
    ? orNull(() =>
        Promise.all([
          first<{ count: number }>("SELECT COUNT(*) AS count FROM races WHERE finished_ms >= ?", sinceMs),
          first<{ cars: number; dnf: number; drivers: number }>(
            "SELECT COUNT(*) AS cars, SUM(CASE WHEN race_cars.dnf != 0 THEN 1 ELSE 0 END) AS dnf, COUNT(DISTINCT race_cars.name_key) AS drivers FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ?",
            sinceMs,
          ),
          first<{ fieldMax: number }>(
            "SELECT MAX(n) AS fieldMax FROM (SELECT COUNT(*) AS n FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ? GROUP BY race_cars.race_id)",
            sinceMs,
          ),
          all<{ day: string; races: number; cars: number }>(
            `SELECT ${DAY_OF("races.finished_ms")} AS day, COUNT(DISTINCT races.id) AS races, COUNT(race_cars.race_id) AS cars FROM races LEFT JOIN race_cars ON race_cars.race_id = races.id WHERE races.finished_ms >= ? GROUP BY 1 ORDER BY 1`,
            sinceMs,
          ),
          all<{ week: string; races: number; cars: number }>(
            "SELECT races.week AS week, COUNT(DISTINCT races.id) AS races, COUNT(race_cars.race_id) AS cars FROM races LEFT JOIN race_cars ON race_cars.race_id = races.id WHERE races.finished_ms >= ? GROUP BY races.week ORDER BY races.week",
            sinceMs,
          ),
        ]),
      )
    : Promise.resolve(null);

  const [[allTime, sums, countries, perDay, circuits, cars, modes, countryRows, extraRows], boardRows, raceRows] = await Promise.all([
    usageReads,
    boardReads,
    raceReads,
  ]);

  const extra = (name: keyof typeof PUBLIC_EXTRAS): PublicShareGroup[] =>
    (extraRows ?? [])
      .filter((r) => r.name === name && PUBLIC_EXTRAS[name].has(String(r.value)))
      .map((r) => ({ id: String(r.value), sessions: num(r.sessions), minutes: mins(r.minutes) }));

  let boards: PublicStats["boards"] = null;
  if (boardRows) {
    const [laps, lapsByRows, challenges] = boardRows;
    const lapsBy = (dim: string): PublicCount[] =>
      lapsByRows
        .filter((r) => r.dim === dim)
        .map((r) => ({ id: String(r.id), n: num(r.n) }))
        .sort((a, b) => b.n - a.n);
    boards = {
      lapsTotal: num(laps.total),
      lapsInRange: num(laps.inRange),
      driversTotal: allTime.drivers ?? 0,
      lapsBy: {
        assists: lapsBy("assists"),
        realism: lapsBy("realism"),
        surface: lapsBy("surface"),
        compound: lapsBy("compound"),
      },
      challenges: challenges.map((c) => ({ event: String(c.event), laps: num(c.laps), drivers: num(c.drivers) })),
    };
  }

  let races: PublicStats["races"] = null;
  if (raceRows) {
    const [raceTotals, carTotals, field, racesPerDay, perWeek] = raceRows;
    const carsCount = num(carTotals.cars);
    const dnfCount = num(carTotals.dnf);
    races = {
      count: num(raceTotals.count),
      cars: carsCount,
      finished: Math.max(0, carsCount - dnfCount),
      drivers: num(carTotals.drivers),
      fieldMax: num(field.fieldMax),
      perDay: racesPerDay.map((d) => ({ day: String(d.day), races: num(d.races), cars: num(d.cars) })),
      perWeek: perWeek.map((w) => ({ week: String(w.week), races: num(w.races), cars: num(w.cars) })),
    };
  }

  return {
    days: PUBLIC_STATS_DAYS,
    from,
    to,
    allTime,
    totals: {
      sessions: num(sums.sessions),
      minutes: mins(sums.minutes),
      laps: num(sums.laps),
      countries: num(countries.n),
      lapsCounted,
    },
    perDay: perDay.map((r) => ({
      day: String(r.day),
      sessions: num(r.sessions),
      minutes: mins(r.minutes),
      laps: num(r.laps),
      countries: num(r.countries),
    })),
    byCircuit: circuits.filter((r) => CIRCUIT_IDS.has(String(r.id))).slice(0, PUBLIC_TOP).map(usageGroup),
    byCar: cars.filter((r) => isVehicleModelId(String(r.id))).map(usageGroup),
    byMode: modes.filter((r) => PUBLIC_MODES.has(String(r.id))).map(usageGroup),
    byCountry: countryRows.map(usageGroup),
    extras: extraRows
      ? { input: extra("input"), device: extra("device"), weather: extra("weather"), assists: extra("assists") }
      : null,
    boards,
    races,
  };
}
