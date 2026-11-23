/**
 * The owner's numbers: GET /api/admin/stats?days=30 with `Authorization: Bearer <key>`, the key equal to the Worker
 * secret ADMIN_KEY. Without the secret, or with any other key, the route answers as any unknown path does, so it does
 * not reveal itself (index.ts, which also limits how often one address may try).
 * It reads the usage totals and their extras (usage.ts), the boards, the race results and the player accounts' counts; a
 * part whose table or column is not there yet (an older database) reads as null or zero, and the rest still answers. About thirty reads,
 * run side by side after one that asks whether the usage rows count laps yet.
 */
import trackIndex from "../../public/tracks/index.json";
import { checkAwardInput, grantAward, listAwards, revokeAward, type AdminAward } from "./awards";
import { deleteDriverLaps, deleteLaps, driverNameKey } from "./board";
import { utcDay } from "./usage";
import type { D1Database, R2Bucket } from "./types";

type Answer = { status: number; body: unknown };

export interface AdminDeps {
  db: D1Database;
  now: () => number;
  /** The next open race and who is waiting for it; absent when the races are off */
  nextRace?: () => Promise<{ startsMs: number; waiting: number }>;
  /** The player accounts' database (accounts/), for their counts; absent when accounts are off */
  accountsDb?: D1Database;
}

const DAY_MS = 86_400_000;
export const DEFAULT_STATS_DAYS = 30;
export const MAX_STATS_DAYS = 90;
/** Rows per top list: ids are checked for shape only, so a long tail of junk stays out */
const TOP = 50;
/** Circuit ids read before the ones in the game are set aside: past every circuit this game has had, with room for junk */
const ALL_CIRCUITS = 500;

/** The circuits this build has: the list the game reads (public/tracks/index.json), the Worker deployed with it */
export const CIRCUIT_IDS: ReadonlySet<string> = new Set((trackIndex as { id: string }[]).map((t) => t.id));

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * True when `given` is the admin key; never true without a secret. Both are hashed first, so the comparison runs over
 * 32 bytes whatever either length, and every byte is compared (no early exit): its time says nothing about the key.
 */
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
/** A usage group with the laps its stretches completed (0 before migration 0006) */
export type LapsGroup = UsageGroup & { laps: number };
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
  /** The usage rows count laps (migration 0006): without it every laps number here is 0 */
  lapsCounted: boolean;
  totals: UsageTotal & { laps: number };
  /** The same number of days just before the range */
  previous: UsageTotal;
  /** Countries the driving came from in the range (not the "XX" of a request without one) */
  countries: number;
  perDay: (UsageTotal & { day: string; laps: number; countries: number })[];
  byCircuit: LapsGroup[];
  byCar: LapsGroup[];
  byMode: LapsGroup[];
  byCountry: LapsGroup[];
  /** The circuits split by mode, most minutes first */
  circuitModes: (UsageTotal & { trackId: string; mode: string })[];
  /** Circuits driven in the range that the game no longer has (not in CIRCUIT_IDS): old clients, or junk */
  retired: (LapsGroup & { lastDay: string })[];
  /** Sessions a day on those circuits */
  retiredPerDay: { day: string; sessions: number }[];
  /** What the driving was done with, each field on its own; null before migration 0004 */
  extras: { input: UsageGroup[]; device: UsageGroup[]; weather: UsageGroup[]; assists: UsageGroup[]; build: UsageGroup[] } | null;
  /**
   * The builds sessions ran on, per day, and the day each build was first reported (over all time, so a build from
   * before the range keeps its real age) with its sessions that day and that day's sessions on any build; null before
   * migration 0004
   */
  builds: { perDay: (UsageTotal & { day: string; build: string })[]; firstSeen: { build: string; day: string; sessions: number; dayTotal: number }[] } | null;
  board: {
    /** Claimed driver names, and those seen on the boards in the range */
    drivers: number;
    driversActive: number;
    /** Names first claimed in the range, and names claimed before it that were seen in it */
    driversNew: number;
    driversReturning: number;
    /**
     * Names that uploaded again a day or more after they were claimed (all time), and the names claimed at least a day
     * ago, who could have
     */
    cameBack: number;
    cameBackOf: number;
    /** Names claimed per UTC day in the range */
    namesPerDay: Count[];
    laps: number;
    lapsInRange: number;
    /** Times still on the boards, by the UTC day each was set (a newer best replaces an older one) */
    lapsPerDay: Count[];
    /** Times set in the range by what they were driven with */
    lapsBy: { assists: Count[]; realism: Count[]; surface: Count[]; compound: Count[] };
    /** Times set in the range by their class: assists, realism and surface together, most first */
    lapsByClass: { assists: string; realism: string; surface: string; n: number }[];
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
    /** Cars classified, and those of them that did not finish. Every car is a player: the race server has no AI */
    cars: number;
    dnf: number;
    /** Cars whose name its driver key proved, and how many names those were */
    proven: number;
    drivers: number;
    /** The smallest and the largest grid */
    fieldMin: number;
    fieldMax: number;
    perDay: { day: string; races: number; cars: number; dnf: number }[];
    perWeek: { week: string; races: number; cars: number }[];
    byCircuit: { trackId: string; vehicle: string; races: number }[];
    /** Most wins, then podiums, then starts, under the names raced with */
    topDrivers: { name: string; races: number; wins: number; podiums: number }[];
  } | null;
  /** The next open race and who is waiting for it, right now; null when the races are off */
  live: { startsMs: number; waiting: number } | null;
  /**
   * Player accounts, counts only: all of them, those with each way in (an account with two counts under both), those
   * with a cloud save, and those made in the last 7 days; null when accounts are off or their database can't be read
   */
  accounts: {
    total: number;
    byProvider: { discord: number; google: number; steam: number; passkey: number };
    withSave: number;
    last7d: number;
  } | null;
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

  // The laps column comes with migration 0006: until then each read below counts none
  const lapsCounted = (await orNull(() => db.prepare("SELECT laps FROM usage_daily LIMIT 1").all())) !== null;
  const LAPS = lapsCounted ? "SUM(laps)" : "0";
  const withLaps = (r: { id: unknown; sessions?: unknown; minutes?: unknown; laps?: unknown }): LapsGroup => ({ id: String(r.id), ...total(r), laps: num(r.laps) });

  const grouped = async (column: "vehicle" | "mode" | "country"): Promise<LapsGroup[]> =>
    (
      await all<{ id: string; sessions: number; minutes: number; laps: number }>(
        `SELECT ${column} AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps FROM usage_daily WHERE day >= ? GROUP BY ${column} ORDER BY minutes DESC LIMIT ${TOP}`,
        from,
      )
    ).map(withLaps);

  const usage = Promise.all([
    first<{ sessions: number; minutes: number; laps: number; prevSessions: number; prevMinutes: number }>(
      `SELECT SUM(CASE WHEN day >= ? THEN sessions ELSE 0 END) AS sessions, SUM(CASE WHEN day >= ? THEN minutes ELSE 0 END) AS minutes, ${lapsCounted ? "SUM(CASE WHEN day >= ? THEN laps ELSE 0 END)" : "0"} AS laps, SUM(CASE WHEN day < ? THEN sessions ELSE 0 END) AS prevSessions, SUM(CASE WHEN day < ? THEN minutes ELSE 0 END) AS prevMinutes FROM usage_daily WHERE day >= ?`,
      ...(lapsCounted ? [from, from, from] : [from, from]),
      from,
      from,
      before,
    ),
    all<{ day: string; sessions: number; minutes: number; laps: number; countries: number }>(
      `SELECT day, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps, COUNT(DISTINCT CASE WHEN country != 'XX' THEN country END) AS countries FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day`,
      from,
    ),
    first<{ n: number }>("SELECT COUNT(DISTINCT country) AS n FROM usage_daily WHERE day >= ? AND country != 'XX'", from),
    // Every circuit, the ones the game no longer has set aside below (an id list in SQL would grow with the game)
    all<{ id: string; sessions: number; minutes: number; laps: number; lastDay: string }>(
      `SELECT track_id AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes, ${LAPS} AS laps, MAX(day) AS lastDay FROM usage_daily WHERE day >= ? GROUP BY track_id ORDER BY minutes DESC LIMIT ${ALL_CIRCUITS}`,
      from,
    ),
    all<{ day: string; trackId: string; sessions: number }>(
      "SELECT day, track_id AS trackId, SUM(sessions) AS sessions FROM usage_daily WHERE day >= ? GROUP BY day, track_id ORDER BY day",
      from,
    ),
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
    orNull(() =>
      Promise.all([
        all<{ day: string; build: string; sessions: number; minutes: number }>(
          "SELECT day, value AS build, sessions, minutes FROM usage_extra WHERE name = 'build' AND day >= ? ORDER BY day, sessions DESC",
          from,
        ),
        // Over all time, for the builds seen in the range only: each one's first day, with its sessions that day and that
        // day's sessions on any build (a first day before the range is out of the per-day rows)
        all<{ build: string; day: string; sessions: number; dayTotal: number }>(
          "SELECT f.build AS build, f.day AS day, e.sessions AS sessions, (SELECT SUM(t.sessions) FROM usage_extra t WHERE t.name = 'build' AND t.day = f.day) AS dayTotal FROM (SELECT value AS build, MIN(day) AS day FROM usage_extra WHERE name = 'build' AND value IN (SELECT value FROM usage_extra WHERE name = 'build' AND day >= ?) GROUP BY value) f JOIN usage_extra e ON e.name = 'build' AND e.value = f.build AND e.day = f.day",
          from,
        ),
      ]),
    ),
  ]);

  const board = Promise.all([
    first<{ total: number; active: number; fresh: number; back: number; cameBack: number; cameBackOf: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN claimed_at >= ? THEN 1 ELSE 0 END) AS fresh, SUM(CASE WHEN claimed_at < ? AND last_seen >= ? THEN 1 ELSE 0 END) AS back, SUM(CASE WHEN last_seen - claimed_at >= ? THEN 1 ELSE 0 END) AS cameBack, SUM(CASE WHEN claimed_at <= ? THEN 1 ELSE 0 END) AS cameBackOf FROM drivers",
      sinceMs,
      sinceMs,
      sinceMs,
      sinceMs,
      DAY_MS,
      nowMs - DAY_MS,
    ),
    all<{ id: string; n: number }>(`SELECT ${DAY_OF("claimed_at")} AS id, COUNT(*) AS n FROM drivers WHERE claimed_at >= ? GROUP BY 1 ORDER BY 1`, sinceMs),
    first<{ total: number; inRange: number }>("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS inRange FROM laps", sinceMs),
    all<{ id: string; n: number }>(`SELECT ${DAY_OF("created_at")} AS id, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY 1 ORDER BY 1`, sinceMs),
    all<{ dim: string; id: string; n: number }>(
      ["assists", "realism", "surface", "compound"]
        .map((c) => `SELECT '${c}' AS dim, ${c} AS id, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY ${c}`)
        .join(" UNION ALL "),
      sinceMs,
      sinceMs,
      sinceMs,
      sinceMs,
    ),
    all<{ assists: string; realism: string; surface: string; n: number }>(
      "SELECT assists, realism, surface, COUNT(*) AS n FROM laps WHERE created_at >= ? GROUP BY assists, realism, surface ORDER BY n DESC LIMIT 20",
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
      first<{ cars: number; dnf: number; proven: number; drivers: number }>(
        "SELECT COUNT(*) AS cars, SUM(CASE WHEN race_cars.dnf != 0 THEN 1 ELSE 0 END) AS dnf, SUM(CASE WHEN race_cars.name_key IS NOT NULL THEN 1 ELSE 0 END) AS proven, COUNT(DISTINCT race_cars.name_key) AS drivers FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ?",
        sinceMs,
      ),
      first<{ fieldMin: number; fieldMax: number }>(
        "SELECT MIN(n) AS fieldMin, MAX(n) AS fieldMax FROM (SELECT COUNT(*) AS n FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ? GROUP BY race_cars.race_id)",
        sinceMs,
      ),
      all<{ day: string; races: number; cars: number; dnf: number }>(
        `SELECT ${DAY_OF("races.finished_ms")} AS day, COUNT(DISTINCT races.id) AS races, COUNT(race_cars.race_id) AS cars, SUM(CASE WHEN race_cars.dnf != 0 THEN 1 ELSE 0 END) AS dnf FROM races LEFT JOIN race_cars ON race_cars.race_id = races.id WHERE races.finished_ms >= ? GROUP BY 1 ORDER BY 1`,
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
        // A car with no name of its own (or a refused one) races as "Driver": those are many people, not one driver
        "SELECT MAX(race_cars.name) AS name, COUNT(*) AS races, SUM(CASE WHEN race_cars.position = 1 AND race_cars.dnf = 0 THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN race_cars.position <= 3 AND race_cars.dnf = 0 THEN 1 ELSE 0 END) AS podiums FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ? AND NOT (race_cars.name_key IS NULL AND race_cars.name = 'Driver') GROUP BY COALESCE(race_cars.name_key, race_cars.name) ORDER BY wins DESC, podiums DESC, races DESC, name LIMIT 10",
        sinceMs,
      ),
    ]),
  );

  const live = deps.nextRace ? orNull(deps.nextRace) : Promise.resolve(null);
  const accountsDb = deps.accountsDb;
  const accounts = accountsDb ? orNull(() => accountCounts(accountsDb, nowMs)) : Promise.resolve(null);

  const [
    [sums, perDay, countries, circuits, circuitDays, byCar, byMode, byCountry, circuitModes, extraRows, buildRows],
    [names, namesPerDay, laps, lapsPerDay, lapsByRows, lapsByClass, boards, topDrivers, challenges],
    raceRows,
    liveNow,
    accountNumbers,
  ] = await Promise.all([usage, board, races, live, accounts]);

  const extra = (name: string): UsageGroup[] => (extraRows ?? []).filter((r) => r.name === name).map((r) => ({ id: String(r.value), ...total(r) }));
  const lapsBy = (dim: string): Count[] => counts(lapsByRows.filter((r) => r.dim === dim).sort((a, b) => num(b.n) - num(a.n)));
  const inGame = (id: unknown) => CIRCUIT_IDS.has(String(id));

  const retiredPerDay = new Map<string, number>();
  for (const r of circuitDays) if (!inGame(r.trackId)) retiredPerDay.set(String(r.day), (retiredPerDay.get(String(r.day)) ?? 0) + num(r.sessions));

  let raceStats: AdminStats["races"] = null;
  if (raceRows) {
    const [kinds, cars, field, racesPerDay, perWeek, byRaceCircuit, raceDrivers] = raceRows;
    const of = (kind: string) => num(kinds.find((k) => k.kind === kind)?.n);
    raceStats = {
      open: of("open"),
      room: of("room"),
      cars: num(cars.cars),
      dnf: num(cars.dnf),
      proven: num(cars.proven),
      drivers: num(cars.drivers),
      fieldMin: num(field.fieldMin),
      fieldMax: num(field.fieldMax),
      perDay: racesPerDay.map((d) => ({ day: String(d.day), races: num(d.races), cars: num(d.cars), dnf: num(d.dnf) })),
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
    lapsCounted,
    totals: { ...total(sums), laps: num(sums.laps) },
    previous: total({ sessions: sums.prevSessions, minutes: sums.prevMinutes }),
    countries: num(countries.n),
    perDay: perDay.map((r) => ({ day: String(r.day), ...total(r), laps: num(r.laps), countries: num(r.countries) })),
    byCircuit: circuits.slice(0, TOP).map(withLaps),
    byCar,
    byMode,
    byCountry,
    circuitModes: circuitModes.map((r) => ({ trackId: String(r.trackId), mode: String(r.mode), ...total(r) })),
    retired: circuits
      .filter((r) => !inGame(r.id))
      .sort((a, b) => num(b.sessions) - num(a.sessions))
      .slice(0, TOP)
      .map((r) => ({ ...withLaps(r), lastDay: String(r.lastDay) })),
    retiredPerDay: [...retiredPerDay].map(([day, sessions]) => ({ day, sessions })),
    extras: extraRows ? { input: extra("input"), device: extra("device"), weather: extra("weather"), assists: extra("assists"), build: extra("build").slice(0, 10) } : null,
    builds: buildRows
      ? {
          perDay: buildRows[0].map((r) => ({ day: String(r.day), build: String(r.build), ...total(r) })),
          firstSeen: buildRows[1].map((r) => ({ build: String(r.build), day: String(r.day), sessions: num(r.sessions), dayTotal: num(r.dayTotal) })),
        }
      : null,
    board: {
      drivers: num(names.total),
      driversActive: num(names.active),
      driversNew: num(names.fresh),
      driversReturning: num(names.back),
      cameBack: num(names.cameBack),
      cameBackOf: num(names.cameBackOf),
      namesPerDay: counts(namesPerDay),
      laps: num(laps.total),
      lapsInRange: num(laps.inRange),
      lapsPerDay: counts(lapsPerDay),
      lapsBy: { assists: lapsBy("assists"), realism: lapsBy("realism"), surface: lapsBy("surface"), compound: lapsBy("compound") },
      lapsByClass: lapsByClass.map((c) => ({ assists: String(c.assists), realism: String(c.realism), surface: String(c.surface), n: num(c.n) })),
      boards: boards.map((b) => ({ trackId: b.track_id, vehicle: b.vehicle, physics: num(b.physics), event: b.event, laps: num(b.laps), drivers: num(b.drivers) })),
      topDrivers: topDrivers.map((d) => ({ name: String(d.name), laps: num(d.laps), boards: num(d.boards) })),
      challenges: challenges.map((c) => ({ event: String(c.event), laps: num(c.laps), drivers: num(c.drivers) })),
    },
    races: raceStats,
    live: liveNow,
    accounts: accountNumbers,
  };
  return { status: 200, body };
}

/** The player accounts' counts (AdminStats `accounts`): four reads of the accounts database, nothing about anyone */
async function accountCounts(db: D1Database, nowMs: number): Promise<NonNullable<AdminStats["accounts"]>> {
  const [accounts, providers, passkeys, saves] = await db.batch([
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS fresh FROM accounts").bind(nowMs - 7 * DAY_MS),
    db.prepare("SELECT provider, COUNT(DISTINCT account_id) AS n FROM identities GROUP BY provider"),
    db.prepare("SELECT COUNT(DISTINCT account_id) AS n FROM passkeys"),
    db.prepare("SELECT COUNT(*) AS n FROM saves"),
  ]);
  const totals = (accounts.results[0] ?? {}) as { total?: unknown; fresh?: unknown };
  const by = (provider: string) => num((providers.results as { provider: string; n: unknown }[]).find((r) => r.provider === provider)?.n);
  return {
    total: num(totals.total),
    byProvider: { discord: by("discord"), google: by("google"), steam: by("steam"), passkey: num((passkeys.results[0] as { n?: unknown } | undefined)?.n) },
    withSave: num((saves.results[0] as { n?: unknown } | undefined)?.n),
    last7d: num(totals.fresh),
  };
}

export interface AdminAwardsBody {
  ok: true;
  awards: AdminAward[];
  drivers: { nameKey: string; name: string }[];
  /** False before migration 0008 is applied */
  ready: boolean;
}

const MAX_AWARD_BODY_BYTES = 2048;

/** GET /api/admin/awards?q=&all=1: manual badges (or every row with all=1) and optional driver search */
export async function adminListAwards(db: D1Database, url: URL): Promise<Answer> {
  const q = url.searchParams.get("q") ?? undefined;
  const all = url.searchParams.get("all") === "1";
  const result = await orNull(() => listAwards(db, { all, q }));
  if (result === null) {
    const body: AdminAwardsBody = { ok: true, awards: [], drivers: [], ready: false };
    return { status: 200, body };
  }
  const body: AdminAwardsBody = { ok: true, awards: result.awards, drivers: result.drivers, ready: true };
  return { status: 200, body };
}

/** POST /api/admin/awards: grant a manual badge (defaults to bulb) */
export async function adminGrantAward(db: D1Database, request: Request, nowMs: number): Promise<Answer> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_AWARD_BODY_BYTES) return { status: 413, body: { ok: false, error: "Body is too large" } };
  const text = await request.text();
  if (text.length > MAX_AWARD_BODY_BYTES) return { status: 413, body: { ok: false, error: "Body is too large" } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 400, body: { ok: false, error: "Body is not valid JSON" } };
  }
  const checked = checkAwardInput(raw);
  if (!checked.ok) return { status: 400, body: { ok: false, error: checked.error } };
  const award = await grantAward(db, checked.award, nowMs);
  if (!award) return { status: 500, body: { ok: false, error: "The badge could not be saved" } };
  return { status: 200, body: { ok: true, award } };
}

/** DELETE /api/admin/awards/:id: revoke an award by its row id */
export async function adminRevokeAward(db: D1Database, id: number): Promise<Answer> {
  if (!Number.isInteger(id) || id < 1) return { status: 400, body: { ok: false, error: "Invalid award id" } };
  const removed = await revokeAward(db, id);
  if (removed === 0) return { status: 404, body: { ok: false, error: "Award not found" } };
  return { status: 200, body: { ok: true, id } };
}

const LAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/admin/laps/:id: delete a lap (and its ghost) and invalidate any archived `auto` weekly podium rows
 * for its (event, physics) so the next Hall of Fame / badges read re-archives cleanly from valid laps.
 */
export async function adminDeleteLap(db: D1Database, ghosts: R2Bucket | undefined, id: string): Promise<Answer> {
  if (!LAP_ID_RE.test(id)) return { status: 400, body: { ok: false, error: "Invalid lap id" } };
  const removed = await deleteLaps({ db, ghosts }, [id], { refreshAutoAwards: true });
  if (removed === 0) return { status: 404, body: { ok: false, error: "Lap not found" } };
  return { status: 200, body: { ok: true, id } };
}

/**
 * DELETE /api/admin/drivers/:name/laps: clear all laps for a driver (and their ghosts) and invalidate any archived
 * `auto` weekly podium rows they held so affected weeks re-archive cleanly on the next read.
 */
export async function adminClearDriverLaps(db: D1Database, ghosts: R2Bucket | undefined, rawName: string): Promise<Answer> {
  const nameKey = driverNameKey(rawName);
  if (!nameKey || nameKey.length > 64) return { status: 400, body: { ok: false, error: "Invalid driver name" } };
  const deleted = await deleteDriverLaps({ db, ghosts }, nameKey);
  return { status: 200, body: { ok: true, nameKey, deleted } };
}
