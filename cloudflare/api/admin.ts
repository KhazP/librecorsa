/**
 * The owner's numbers: GET /api/admin/stats?days=30 with the header X-Admin-Key, equal to the Worker secret ADMIN_KEY.
 * Without the secret, or with any other key, the route answers as any unknown path does, so it does not reveal itself.
 * It reads the usage totals and their extras (usage.ts), the boards, and the race results; a part whose table is not
 * there yet (an older database) reads as null, and the rest still answers. About twenty reads, run side by side.
 */
import { utcDay } from "./usage";
import type { D1Database } from "./types";

type Answer = { status: number; body: unknown };

export interface AdminDeps {
  db: D1Database;
  now: () => number;
  /** The next open race and who is waiting for it; absent when the races are off */
  nextRace?: () => Promise<{ startsMs: number; waiting: number }>;
}

const DAY_MS = 86_400_000;
export const DEFAULT_STATS_DAYS = 30;
export const MAX_STATS_DAYS = 90;
/** Rows per top list: ids are checked for shape only, so a long tail of junk stays out */
const TOP = 50;

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** True when `given` is the admin key; compared as SHA-256 digests in constant time, never true without a secret */
export async function adminKeyMatches(given: string | null, secret: string | undefined): Promise<boolean> {
  if (!secret || given === null) return false;
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Days in the range asked for: a whole number of 1 to 90, else 30 */
export function statsDays(raw: string | null): number {
  const days = Number(raw);
  return raw !== null && Number.isInteger(days) && days >= 1 && days <= MAX_STATS_DAYS ? days : DEFAULT_STATS_DAYS;
}

export interface UsageTotal {
  sessions: number;
  minutes: number;
}
export type UsageGroup = UsageTotal & { id: string };
/** A count of something by one id (a day, a setting) */
export interface Count {
  id: string;
  n: number;
}

export interface AdminStats {
  ok: true;
  days: number;
  /** First and last UTC day of the range, "2026-11-11" */
  from: string;
  to: string;
  totals: UsageTotal;
  /** The same number of days just before the range */
  previous: UsageTotal;
  perDay: (UsageTotal & { day: string })[];
  byCircuit: UsageGroup[];
  byCar: UsageGroup[];
  byMode: UsageGroup[];
  byCountry: UsageGroup[];
  /** The circuits split by mode, most minutes first */
  circuitModes: (UsageTotal & { trackId: string; mode: string })[];
  /** What the driving was done with, each field on its own; null before migration 0004 */
  extras: { input: UsageGroup[]; device: UsageGroup[]; weather: UsageGroup[]; assists: UsageGroup[]; build: UsageGroup[] } | null;
  board: {
    /** Claimed driver names, and those seen on the boards in the range */
    drivers: number;
    driversActive: number;
    /** Names first claimed in the range, and names claimed before it that were seen in it */
    driversNew: number;
    driversReturning: number;
    /** Names claimed per UTC day in the range */
    namesPerDay: Count[];
    laps: number;
    lapsInRange: number;
    /** Times still on the boards, by the UTC day each was set (a newer best replaces an older one) */
    lapsPerDay: Count[];
    /** Times set in the range by what they were driven with */
    lapsBy: { assists: Count[]; realism: Count[]; surface: Count[]; compound: Count[] };
    /** Laps and drivers on each board (circuit, car, physics revision, '' or a weekly challenge) */
    boards: { trackId: string; vehicle: string; physics: number; event: string; laps: number; drivers: number }[];
    /** Most times set in the range, under the names the boards show */
    topDrivers: { name: string; laps: number; boards: number }[];
    /** The weekly challenges, newest first: times on each board and the drivers who set them */
    challenges: { event: string; laps: number; drivers: number }[];
  };
  /** Finished races in the range; null before race results are stored */
  races: {
    open: number;
    room: number;
    /** Cars classified, and those of them that did not finish */
    cars: number;
    dnf: number;
    perWeek: { week: string; races: number; cars: number }[];
    byCircuit: { trackId: string; vehicle: string; races: number }[];
    /** Most wins, then podiums, then starts, under the names raced with */
    topDrivers: { name: string; races: number; wins: number; podiums: number }[];
  } | null;
  /** The next open race and who is waiting for it, right now; null when the races are off */
  live: { startsMs: number; waiting: number } | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const total = (r: { sessions?: unknown; minutes?: unknown }): UsageTotal => ({ sessions: num(r.sessions), minutes: Math.round(num(r.minutes) * 10) / 10 });
const counts = (rows: { id: unknown; n: unknown }[]): Count[] => rows.map((r) => ({ id: String(r.id), n: num(r.n) }));
/** The UTC day of a time in ms, in SQL */
const DAY_OF = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;

/** Null when the read fails: a table from a later migration that is not there yet */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function adminStats(deps: AdminDeps, url: URL): Promise<Answer> {
  const days = statsDays(url.searchParams.get("days"));
  const nowMs = deps.now();
  const to = utcDay(nowMs);
  const from = utcDay(nowMs - (days - 1) * DAY_MS);
  const before = utcDay(nowMs - (2 * days - 1) * DAY_MS);
  const sinceMs = Date.parse(`${from}T00:00:00Z`);
  const db = deps.db;
  const all = async <T>(sql: string, ...binds: unknown[]): Promise<T[]> => (await db.prepare(sql).bind(...binds).all<T>()).results;
  const first = async <T>(sql: string, ...binds: unknown[]): Promise<T> => ((await db.prepare(sql).bind(...binds).first<T>()) ?? {}) as T;

  const grouped = async (column: "track_id" | "vehicle" | "mode" | "country"): Promise<UsageGroup[]> =>
    (
      await all<{ id: string; sessions: number; minutes: number }>(
        `SELECT ${column} AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ? GROUP BY ${column} ORDER BY minutes DESC LIMIT ${TOP}`,
        from,
      )
    ).map((r) => ({ id: String(r.id), ...total(r) }));

  const usage = Promise.all([
    first<{ sessions: number; minutes: number; prevSessions: number; prevMinutes: number }>(
      "SELECT SUM(CASE WHEN day >= ? THEN sessions ELSE 0 END) AS sessions, SUM(CASE WHEN day >= ? THEN minutes ELSE 0 END) AS minutes, SUM(CASE WHEN day < ? THEN sessions ELSE 0 END) AS prevSessions, SUM(CASE WHEN day < ? THEN minutes ELSE 0 END) AS prevMinutes FROM usage_daily WHERE day >= ?",
      from,
      from,
      from,
      from,
      before,
    ),
    all<{ day: string; sessions: number; minutes: number }>("SELECT day, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day", from),
    grouped("track_id"),
    grouped("vehicle"),
    grouped("mode"),
    grouped("country"),
    all<{ trackId: string; mode: string; sessions: number; minutes: number }>(
      `SELECT track_id AS trackId, mode, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ? GROUP BY track_id, mode ORDER BY minutes DESC LIMIT ${TOP * 5}`,
      from,
    ),
    orNull(() =>
      all<{ name: string; value: string; sessions: number; minutes: number }>(
        "SELECT name, value, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_extra WHERE day >= ? GROUP BY name, value ORDER BY minutes DESC",
        from,
      ),
    ),
  ]);

  const board = Promise.all([
    first<{ total: number; active: number; fresh: number; back: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN claimed_at >= ? THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN claimed_at < ? AND last_seen >= ? THEN 1 ELSE 0 END) AS back FROM drivers",
      sinceMs,
      sinceMs,
      sinceMs,
      sinceMs,
    ),
    all<{ id: string; n: number }>(`SELECT ${DAY_OF("claimed_at")} AS id, COUNT(*) AS n FROM drivers WHERE claimed_at >= ? GROUP BY id ORDER BY id`, sinceMs),
    first<{ total: number; inRange: number }>("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS inRange FROM laps", sinceMs),
    all<{ id: string; n: number }>(`SELECT ${DAY_OF("created_at")} AS id, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY id ORDER BY id`, sinceMs),
    all<{ dim: string; id: string; n: number }>(
      ["assists", "realism", "surface", "compound"]
        .map((c) => `SELECT '${c}' AS dim, ${c} AS id, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY ${c}`)
        .join(" UNION ALL "),
      sinceMs,
      sinceMs,
      sinceMs,
      sinceMs,
    ),
    all<{ track_id: string; vehicle: string; physics: number; event: string; laps: number; drivers: number }>(
      `SELECT track_id, vehicle, physics, event, COUNT(*) AS laps, COUNT(DISTINCT name_key) AS drivers FROM laps GROUP BY track_id, vehicle, physics, event ORDER BY laps DESC LIMIT ${TOP}`,
    ),
    all<{ name: string; laps: number; boards: number }>(
      "SELECT MAX(driver_name) AS name, COUNT(*) AS laps, COUNT(DISTINCT track_id || '|' || vehicle) AS boards FROM laps WHERE created_at >= ? GROUP BY name_key ORDER BY laps DESC, name LIMIT 10",
      sinceMs,
    ),
    all<{ event: string; laps: number; drivers: number }>(
      "SELECT event, COUNT(*) AS laps, COUNT(DISTINCT name_key) AS drivers FROM laps WHERE event != '' GROUP BY event ORDER BY event DESC LIMIT 8",
    ),
  ]);

  // The race results come from a migration of their own (0002_race_results.sql): absent, there is nothing to count
  const races = orNull(() =>
    Promise.all([
      all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM races WHERE finished_ms >= ? GROUP BY kind", sinceMs),
      first<{ cars: number; dnf: number }>(
        "SELECT COUNT(*) AS cars, SUM(CASE WHEN race_cars.dnf != 0 THEN 1 ELSE 0 END) AS dnf FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ?",
        sinceMs,
      ),
      all<{ week: string; races: number; cars: number }>(
        "SELECT races.week AS week, COUNT(DISTINCT races.id) AS races, COUNT(race_cars.race_id) AS cars FROM races LEFT JOIN race_cars ON race_cars.race_id = races.id WHERE races.finished_ms >= ? GROUP BY races.week ORDER BY races.week",
        sinceMs,
      ),
      all<{ trackId: string; vehicle: string; races: number }>(
        "SELECT track_id AS trackId, vehicle, COUNT(*) AS races FROM races WHERE finished_ms >= ? GROUP BY track_id, vehicle ORDER BY races DESC LIMIT 10",
        sinceMs,
      ),
      all<{ name: string; races: number; wins: number; podiums: number }>(
        "SELECT MAX(race_cars.name) AS name, COUNT(*) AS races, SUM(CASE WHEN race_cars.position = 1 AND race_cars.dnf = 0 THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN race_cars.position <= 3 AND race_cars.dnf = 0 THEN 1 ELSE 0 END) AS podiums FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ? GROUP BY COALESCE(race_cars.name_key, race_cars.name) ORDER BY wins DESC, podiums DESC, races DESC, name LIMIT 10",
        sinceMs,
      ),
    ]),
  );

  const live = deps.nextRace ? orNull(deps.nextRace) : Promise.resolve(null);

  const [[sums, perDay, byCircuit, byCar, byMode, byCountry, circuitModes, extraRows], [names, namesPerDay, laps, lapsPerDay, lapsByRows, boards, topDrivers, challenges], raceRows, liveNow] =
    await Promise.all([usage, board, races, live]);

  const extra = (name: string): UsageGroup[] => (extraRows ?? []).filter((r) => r.name === name).map((r) => ({ id: String(r.value), ...total(r) }));
  const lapsBy = (dim: string): Count[] => counts(lapsByRows.filter((r) => r.dim === dim).sort((a, b) => num(b.n) - num(a.n)));

  let raceStats: AdminStats["races"] = null;
  if (raceRows) {
    const [kinds, cars, perWeek, byRaceCircuit, raceDrivers] = raceRows;
    const of = (kind: string) => num(kinds.find((k) => k.kind === kind)?.n);
    raceStats = {
      open: of("open"),
      room: of("room"),
      cars: num(cars.cars),
      dnf: num(cars.dnf),
      perWeek: perWeek.map((w) => ({ week: String(w.week), races: num(w.races), cars: num(w.cars) })),
      byCircuit: byRaceCircuit.map((r) => ({ trackId: String(r.trackId), vehicle: String(r.vehicle), races: num(r.races) })),
      topDrivers: raceDrivers.map((d) => ({ name: String(d.name), races: num(d.races), wins: num(d.wins), podiums: num(d.podiums) })),
    };
  }

  const body: AdminStats = {
    ok: true,
    days,
    from,
    to,
    totals: total(sums),
    previous: total({ sessions: sums.prevSessions, minutes: sums.prevMinutes }),
    perDay: perDay.map((r) => ({ day: String(r.day), ...total(r) })),
    byCircuit,
    byCar,
    byMode,
    byCountry,
    circuitModes: circuitModes.map((r) => ({ trackId: String(r.trackId), mode: String(r.mode), ...total(r) })),
    extras: extraRows ? { input: extra("input"), device: extra("device"), weather: extra("weather"), assists: extra("assists"), build: extra("build").slice(0, 10) } : null,
    board: {
      drivers: num(names.total),
      driversActive: num(names.active),
      driversNew: num(names.fresh),
      driversReturning: num(names.back),
      namesPerDay: counts(namesPerDay),
      laps: num(laps.total),
      lapsInRange: num(laps.inRange),
      lapsPerDay: counts(lapsPerDay),
      lapsBy: { assists: lapsBy("assists"), realism: lapsBy("realism"), surface: lapsBy("surface"), compound: lapsBy("compound") },
      boards: boards.map((b) => ({ trackId: b.track_id, vehicle: b.vehicle, physics: num(b.physics), event: b.event, laps: num(b.laps), drivers: num(b.drivers) })),
      topDrivers: topDrivers.map((d) => ({ name: String(d.name), laps: num(d.laps), boards: num(d.boards) })),
      challenges: challenges.map((c) => ({ event: String(c.event), laps: num(c.laps), drivers: num(c.drivers) })),
    },
    races: raceStats,
    live: liveNow,
  };
  return { status: 200, body };
}
