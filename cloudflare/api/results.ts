/**
 * The open races' official results, on D1 (cloudflare/migrations/0002_race_results.sql):
 *   GET /api/races/results?week=<challenge id>
 *       -> { week, races: [{ id, finishedMs, trackId, vehicle, laps, podium: [{ position, name, code, timeS, dnf }] }],
 *            standings: [{ name, starts, wins, podiums }] }
 *   GET /api/drivers/record?name=
 *       -> { name, starts, wins, podiums, bestFinish }
 *
 * The race server stores a race when its result turns final (storeRaceResult). A car's result counts for a driver
 * only when the name it raced under was proven with that name's driver key (the `identify` message, checked against
 * the board's claims in `drivers`); other cars are stored under their name without a claim key and count for nobody.
 */
import type { OfficialResultRow } from "../../src/lib/net/wire";
import { driverNameKey, EVENT_ID_RE } from "./board";
import type { D1Database, D1PreparedStatement } from "./types";

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

/** Races listed per week, and drivers in its standings */
const LATEST_RACES = 10;
const STANDINGS = 20;

export interface StoredRace {
  id: string;
  week: string;
  kind: "open";
  trackId: string;
  vehicle: string;
  laps: number;
  finishedMs: number;
}

/** A car on the grid as the race server knew it: the name it raced under, and its driver key's SHA-256 if it sent one */
export interface RaceEntrant {
  name: string;
  code: string;
  keyHash?: string;
}

/** The claim key of each entrant whose driver key owns the name it raced under */
export async function provenNameKeys(db: D1Database, entrants: Record<string, RaceEntrant>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const claimed = Object.entries(entrants).filter(([, e]) => e.keyHash !== undefined);
  if (claimed.length === 0) return out;
  const keys = [...new Set(claimed.map(([, e]) => driverNameKey(e.name)))];
  const owners = await db
    .prepare(`SELECT name_key, key_hash FROM drivers WHERE name_key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .all<{ name_key: string; key_hash: string }>();
  const ownerOf = new Map(owners.results.map((r) => [r.name_key, r.key_hash]));
  for (const [peer, e] of claimed) {
    const key = driverNameKey(e.name);
    if (ownerOf.get(key) === e.keyHash) out.set(peer, key);
  }
  return out;
}

/** Stores a final result; storing the same race again changes nothing */
export async function storeRaceResult(db: D1Database, race: StoredRace, rows: OfficialResultRow[], entrants: Record<string, RaceEntrant>): Promise<void> {
  const proven = await provenNameKeys(db, entrants);
  const writes: D1PreparedStatement[] = [
    db
      .prepare("INSERT OR IGNORE INTO races (id, week, kind, track_id, vehicle, laps, finished_ms) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(race.id, race.week, race.kind, race.trackId, race.vehicle, race.laps, race.finishedMs),
  ];
  for (const r of rows) {
    const e = entrants[r.peer];
    writes.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO race_cars (race_id, position, name_key, name, code, time_s, penalty_s, laps, best_lap_ms, dnf, grid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(race.id, r.position, proven.get(r.peer) ?? null, e?.name ?? "Driver", e?.code ?? "DRV", r.dnf ? null : r.timeS, r.penaltyS, r.laps, r.bestLapMs, r.dnf ? 1 : 0, r.grid),
    );
  }
  await db.batch(writes);
}

const WIN = "SUM(CASE WHEN c.position = 1 AND c.dnf = 0 THEN 1 ELSE 0 END)";
const PODIUM = "SUM(CASE WHEN c.position <= 3 AND c.dnf = 0 THEN 1 ELSE 0 END)";

export async function listRaceResults(db: D1Database, url: URL): Promise<Answer> {
  const week = url.searchParams.get("week") ?? "";
  if (!EVENT_ID_RE.test(week)) return fail("week is required");
  const [races, standings] = await db.batch([
    db.prepare("SELECT id, track_id, vehicle, laps, finished_ms FROM races WHERE week = ? ORDER BY finished_ms DESC LIMIT ?").bind(week, LATEST_RACES),
    // Proven drivers only, under the name they last raced with (SQLite takes the bare column from the MAX row)
    db
      .prepare(
        `SELECT c.name AS name, MAX(r.finished_ms) AS last_ms, COUNT(*) AS starts, ${WIN} AS wins, ${PODIUM} AS podiums FROM race_cars c JOIN races r ON r.id = c.race_id WHERE r.week = ? AND c.name_key IS NOT NULL GROUP BY c.name_key ORDER BY wins DESC, podiums DESC, starts DESC, last_ms ASC LIMIT ?`,
      )
      .bind(week, STANDINGS),
  ]);
  const raceRows = races.results as { id: string; track_id: string; vehicle: string; laps: number; finished_ms: number }[];
  const podiums = new Map<string, { position: number; name: string; code: string; timeS: number | null; dnf: boolean }[]>();
  if (raceRows.length > 0) {
    const ids = raceRows.map((r) => r.id);
    const cars = await db
      .prepare(`SELECT race_id, position, name, code, time_s, dnf FROM race_cars WHERE race_id IN (${ids.map(() => "?").join(",")}) AND position <= 3 ORDER BY position`)
      .bind(...ids)
      .all<{ race_id: string; position: number; name: string; code: string; time_s: number | null; dnf: number }>();
    for (const c of cars.results) {
      const list = podiums.get(c.race_id) ?? [];
      list.push({ position: c.position, name: c.name, code: c.code, timeS: c.time_s, dnf: c.dnf === 1 });
      podiums.set(c.race_id, list);
    }
  }
  return {
    status: 200,
    body: {
      week,
      races: raceRows.map((r) => ({ id: r.id, finishedMs: r.finished_ms, trackId: r.track_id, vehicle: r.vehicle, laps: r.laps, podium: podiums.get(r.id) ?? [] })),
      standings: (standings.results as { name: string; starts: number; wins: number; podiums: number }[]).map((s) => ({
        name: s.name,
        starts: s.starts,
        wins: s.wins,
        podiums: s.podiums,
      })),
    },
  };
}

export async function driverRecord(db: D1Database, url: URL): Promise<Answer> {
  const name = url.searchParams.get("name") ?? "";
  const key = name.length <= 64 ? driverNameKey(name) : "";
  if (!key) return fail("name is required");
  const row = await db
    .prepare(
      `SELECT (SELECT c2.name FROM race_cars c2 JOIN races r2 ON r2.id = c2.race_id WHERE c2.name_key = ? ORDER BY r2.finished_ms DESC LIMIT 1) AS name, COUNT(*) AS starts, ${WIN} AS wins, ${PODIUM} AS podiums, MIN(CASE WHEN c.dnf = 0 THEN c.position END) AS best FROM race_cars c WHERE c.name_key = ?`,
    )
    .bind(key, key)
    .first<{ name: string | null; starts: number; wins: number | null; podiums: number | null; best: number | null }>();
  return {
    status: 200,
    body: {
      name: row?.name ?? name.trim(),
      starts: row?.starts ?? 0,
      wins: row?.wins ?? 0,
      podiums: row?.podiums ?? 0,
      bestFinish: row?.best ?? null,
    },
  };
}
