/**
 * The owner's numbers: GET /api/admin/stats?days=30 with the header X-Admin-Key, equal to the Worker secret ADMIN_KEY.
 * Without the secret, or with any other key, the route answers as any unknown path does, so it does not reveal itself.
 * It reads the usage totals (usage.ts) and a few counts from the boards, and the race results when that table exists.
 */
import { utcDay } from "./usage";
import type { D1Database } from "./types";

type Answer = { status: number; body: unknown };

export interface AdminDeps {
  db: D1Database;
  now: () => number;
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

export interface AdminStats {
  ok: true;
  days: number;
  /** First and last UTC day of the range, "2026-11-11" */
  from: string;
  to: string;
  totals: UsageTotal;
  perDay: (UsageTotal & { day: string })[];
  byCircuit: UsageGroup[];
  byCar: UsageGroup[];
  byMode: UsageGroup[];
  byCountry: UsageGroup[];
  board: {
    /** Claimed driver names, and those seen on the boards in the range */
    drivers: number;
    driversActive: number;
    laps: number;
    lapsInRange: number;
    /** Laps on each board (circuit, car, physics revision, '' or a weekly challenge) */
    boards: { trackId: string; vehicle: string; physics: number; event: string; laps: number }[];
  };
  /** Finished races in the range by kind, and the cars classified in them; null before race results are stored */
  races: { open: number; room: number; cars: number } | null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const total = (r: { sessions?: unknown; minutes?: unknown }): UsageTotal => ({ sessions: num(r.sessions), minutes: Math.round(num(r.minutes) * 10) / 10 });

export async function adminStats(deps: AdminDeps, url: URL): Promise<Answer> {
  const days = statsDays(url.searchParams.get("days"));
  const nowMs = deps.now();
  const to = utcDay(nowMs);
  const from = utcDay(nowMs - (days - 1) * DAY_MS);
  const sinceMs = Date.parse(`${from}T00:00:00Z`);
  const db = deps.db;

  const grouped = async (column: "track_id" | "vehicle" | "mode" | "country"): Promise<UsageGroup[]> => {
    const { results } = await db
      .prepare(`SELECT ${column} AS id, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ? GROUP BY ${column} ORDER BY minutes DESC LIMIT ${TOP}`)
      .bind(from)
      .all<{ id: string; sessions: number; minutes: number }>();
    return results.map((r) => ({ id: String(r.id), ...total(r) }));
  };
  const count = async (sql: string, ...binds: unknown[]): Promise<number> => num((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n);

  const sums = await db.prepare("SELECT SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ?").bind(from).first<UsageTotal>();
  const perDay = await db
    .prepare("SELECT day, SUM(sessions) AS sessions, SUM(minutes) AS minutes FROM usage_daily WHERE day >= ? GROUP BY day ORDER BY day")
    .bind(from)
    .all<{ day: string; sessions: number; minutes: number }>();
  const boards = await db
    .prepare(`SELECT track_id, vehicle, physics, event, COUNT(*) AS laps FROM laps GROUP BY track_id, vehicle, physics, event ORDER BY laps DESC LIMIT ${TOP}`)
    .all<{ track_id: string; vehicle: string; physics: number; event: string; laps: number }>();

  // The race results come from a migration of their own (0002_race_results.sql): absent, there is nothing to count
  let races: AdminStats["races"] = null;
  try {
    const kinds = await db.prepare("SELECT kind, COUNT(*) AS n FROM races WHERE finished_ms >= ? GROUP BY kind").bind(sinceMs).all<{ kind: string; n: number }>();
    const of = (kind: string) => num(kinds.results.find((k) => k.kind === kind)?.n);
    races = {
      open: of("open"),
      room: of("room"),
      cars: await count("SELECT COUNT(*) AS n FROM race_cars JOIN races ON races.id = race_cars.race_id WHERE races.finished_ms >= ?", sinceMs),
    };
  } catch {
    races = null;
  }

  const body: AdminStats = {
    ok: true,
    days,
    from,
    to,
    totals: total(sums ?? {}),
    perDay: perDay.results.map((r) => ({ day: String(r.day), ...total(r) })),
    byCircuit: await grouped("track_id"),
    byCar: await grouped("vehicle"),
    byMode: await grouped("mode"),
    byCountry: await grouped("country"),
    board: {
      drivers: await count("SELECT COUNT(*) AS n FROM drivers"),
      driversActive: await count("SELECT COUNT(*) AS n FROM drivers WHERE last_seen >= ?", sinceMs),
      laps: await count("SELECT COUNT(*) AS n FROM laps"),
      lapsInRange: await count("SELECT COUNT(*) AS n FROM laps WHERE created_at >= ?", sinceMs),
      boards: boards.results.map((b) => ({ trackId: b.track_id, vehicle: b.vehicle, physics: num(b.physics), event: b.event, laps: num(b.laps) })),
    },
    races,
  };
  return { status: 200, body };
}
