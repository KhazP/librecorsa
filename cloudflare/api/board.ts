/**
 * The online lap boards, on D1 (rows) and R2 (ghost samples):
 *   POST /api/laps        { rec: LapRecording, driverKey, event? }
 *                         -> { ok: true, rank, total, eventRank?, eventTotal?, eventError? } | { ok: false, error }
 *   GET  /api/laps?track=&vehicle=&physics=&assists=&realism=&surface=&event=&name=&limit=
 *                         -> { laps: [...], total, me: { rank, lap, aboveMs } | null, physics: [revisions with laps] }
 *                            (aboveMs: the best lap of the place above the driver's, null at the top)
 *   GET  /api/laps/<id>   -> the lap's LapRecording (its ghost), or 404
 *
 * One board per circuit, car and physics revision: every driver appears once, with their fastest lap and what it
 * was driven with (assists, realism, dry or wet). A driver keeps one stored lap per such class, so the board can be
 * narrowed ("no assists only") and still show everyone's best of that kind. A weekly challenge (`event`) has its own
 * board with the same rules.
 *
 * Driver names are claimed with a driver key: a random secret the game keeps in the browser. The first upload under
 * a name stores the key's SHA-256; later uploads under that name (ignoring case and extra spaces) must bring the same
 * key. A claim lapses after six months without an upload, and the laps under it go with it.
 */
import { ASSIST_PRESETS, type LapConditions } from "../../src/lib/sim/lap-types";
import { SIM_REALISM_LEVELS } from "../../src/lib/sim/sim-realism";
import { isVehicleModelId } from "../../src/types/f1";
import { checkLap, TRACK_ID_RE, type CheckedLap } from "./lap-check";
import type { D1Database, D1PreparedStatement, Env, R2Bucket } from "./types";

const MAX_BODY_BYTES = 2 * 1024 * 1024 + 4096;
/** A session on a new circuit sets a personal best every few laps, and each one is uploaded */
const MAX_POSTS_PER_HOUR = 30;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CLAIM_LAPSES_MS = 183 * 24 * 3600 * 1000;
const DRIVER_KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const LAP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_ID_RE = /^\d{4}-W\d{2}$/;

/** Null when `rec` may go on `event`'s board right now, else why not */
export type EventRule = (rec: CheckedLap, event: string, nowMs: number) => string | null;

export interface BoardDeps {
  db: D1Database;
  ghosts: R2Bucket;
  eventRule: EventRule;
  now: () => number;
}

type Answer = { status: number; body: unknown };
const fail = (error: string, status = 400): Answer => ({ status, body: { ok: false, error } });

interface LapRow {
  id: string;
  track_id: string;
  vehicle: string;
  physics: number;
  assists: string;
  realism: string;
  surface: string;
  compound: string;
  driver_name: string;
  driver_code: string;
  lap_time_ms: number;
  s1_ms: number;
  s2_ms: number;
  s3_ms: number;
  recorded_at: number;
}

/** Board row for the game: a lap without its samples */
const entryOf = (r: LapRow) => ({
  id: r.id,
  name: r.driver_name,
  code: r.driver_code,
  lapTimeMs: r.lap_time_ms,
  sectorTimesMs: [r.s1_ms, r.s2_ms, r.s3_ms],
  vehicle: r.vehicle,
  trackId: r.track_id,
  recordedAt: r.recorded_at,
  conditions: { assists: r.assists, realism: r.realism, surface: r.surface, compound: r.compound, physicsVersion: r.physics },
});

/**
 * The claim key of a driver name: outer spaces off, runs of whitespace as one space, lower case. The same rule as the
 * Supabase board this one replaced, so the claims carried over from it (scripts/migrate-supabase-board.ts) keep matching.
 */
export function driverNameKey(name: string): string {
  return name.replace(/^ +| +$/g, "").replace(/[ \t\n\r\f\v]+/g, " ").toLowerCase();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ghostKey = (id: string) => `laps/${id}.json`;

/** Removes rows and their ghosts */
async function deleteLaps(deps: BoardDeps, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    await deps.db.prepare(`DELETE FROM laps WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    await deps.ghosts.delete(chunk.map(ghostKey));
  }
}

/** This driver's place on a board (their fastest lap of any class against everyone else's) and the board's size */
async function placeOf(deps: BoardDeps, rec: CheckedLap, event: string, nameKey: string): Promise<{ rank: number; total: number }> {
  const board = [rec.trackId, rec.vehicle, rec.conditions.physicsVersion, event];
  const best = deps.db
    .prepare("SELECT MIN(lap_time_ms) AS best FROM laps WHERE track_id = ? AND vehicle = ? AND physics = ? AND event = ? AND name_key = ?")
    .bind(...board, nameKey);
  const [mine, drivers] = await deps.db.batch([
    best,
    deps.db
      .prepare("SELECT name_key, MIN(lap_time_ms) AS best FROM laps WHERE track_id = ? AND vehicle = ? AND physics = ? AND event = ? GROUP BY name_key")
      .bind(...board),
  ]);
  const myBest = (mine.results[0] as { best: number | null } | undefined)?.best ?? rec.lapTimeMs;
  const all = drivers.results as { best: number }[];
  return { rank: 1 + all.filter((d) => d.best < myBest).length, total: all.length };
}

/** Stores `rec` as this driver's lap of its class on one board, unless they already have a faster one there */
async function storeLap(deps: BoardDeps, rec: CheckedLap, event: string, nameKey: string): Promise<boolean> {
  const c = rec.conditions;
  const cls = [rec.trackId, rec.vehicle, c.physicsVersion, event, c.assists, c.realism, c.surface, nameKey];
  const prev = await deps.db
    .prepare(
      "SELECT id, lap_time_ms FROM laps WHERE track_id = ? AND vehicle = ? AND physics = ? AND event = ? AND assists = ? AND realism = ? AND surface = ? AND name_key = ?",
    )
    .bind(...cls)
    .first<{ id: string; lap_time_ms: number }>();
  if (prev && prev.lap_time_ms <= rec.lapTimeMs) return false;

  const id = crypto.randomUUID();
  // The ghost before the row that points at it
  await deps.ghosts.put(ghostKey(id), JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
  const writes: D1PreparedStatement[] = [];
  if (prev) writes.push(deps.db.prepare("DELETE FROM laps WHERE id = ?").bind(prev.id));
  writes.push(
    deps.db
      .prepare(
        "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, rec.trackId, rec.vehicle, c.physicsVersion, event, c.assists, c.realism, c.surface, c.compound, nameKey, rec.driverName, rec.driverCode, rec.lapTimeMs, rec.sectorTimesMs[0], rec.sectorTimesMs[1], rec.sectorTimesMs[2], rec.recordedAt, deps.now()),
  );
  await deps.db.batch(writes);
  if (prev) await deps.ghosts.delete(ghostKey(prev.id));
  return true;
}

export async function submitLap(deps: BoardDeps, request: Request): Promise<Answer> {
  const nowMs = deps.now();
  // Uploads per address per hour (hashed)
  const hour = Math.floor(nowMs / 3_600_000);
  const client = await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const used = await deps.db
    .prepare("INSERT INTO lap_posts (client_hash, hour, count) VALUES (?, ?, 1) ON CONFLICT (client_hash, hour) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(client, hour)
    .first<{ count: number }>();
  if (used && used.count === 1) await deps.db.prepare("DELETE FROM lap_posts WHERE hour < ?").bind(hour - 1).run();
  if ((used?.count ?? 1) > MAX_POSTS_PER_HOUR) return fail("Too many uploads, try again later", 429);

  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return fail("Recording is larger than 2 MB", 413);
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) return fail("Recording is larger than 2 MB", 413);
  let body: { rec?: unknown; driverKey?: unknown; event?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    return fail("Body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) return fail("Body is not valid JSON");

  const checked = checkLap(body.rec);
  if (!checked.ok) return fail(checked.error);
  const rec = checked.rec;
  // A lap sent for a challenge it doesn't fit (the week turned, a clock is off) still counts on the open board
  let event = "";
  let eventError: string | null = null;
  if (body.event !== undefined && body.event !== "") {
    if (typeof body.event !== "string" || !EVENT_ID_RE.test(body.event)) eventError = "Unknown event";
    else eventError = deps.eventRule(rec, body.event, nowMs);
    if (eventError === null) event = body.event as string;
  }

  // The name must be free, lapsed, or claimed with this driver key
  if (typeof body.driverKey !== "string" || !DRIVER_KEY_RE.test(body.driverKey)) {
    return fail("Missing driver key. Reload the game and try again");
  }
  const keyHash = await sha256Hex(body.driverKey);
  const nameKey = driverNameKey(rec.driverName);
  await deps.db.prepare("DELETE FROM drivers WHERE name_key = ? AND last_seen < ?").bind(nameKey, nowMs - CLAIM_LAPSES_MS).run();
  const claim = await deps.db
    .prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING")
    .bind(nameKey, keyHash, nowMs, nowMs)
    .run();
  const claimed = claim.meta.changes === 1;
  const owner = await deps.db.prepare("SELECT key_hash FROM drivers WHERE name_key = ?").bind(nameKey).first<{ key_hash: string }>();
  if (owner?.key_hash !== keyHash) {
    return fail("This name is taken. Import your driver key under Lap Times, or race under another name", 409);
  }
  if (claimed) {
    // A fresh claim starts clean: laps left under the name by a previous owner go
    const left = await deps.db.prepare("SELECT id FROM laps WHERE name_key = ?").bind(nameKey).all<{ id: string }>();
    await deleteLaps(deps, left.results.map((r) => r.id));
  } else {
    await deps.db.prepare("UPDATE drivers SET last_seen = ? WHERE name_key = ?").bind(nowMs, nameKey).run();
  }

  // A challenge lap also counts on the open board
  const onOpen = await storeLap(deps, rec, "", nameKey);
  const onEvent = event ? await storeLap(deps, rec, event, nameKey) : false;
  if (!onOpen && !onEvent) return fail(eventError ?? "Not faster than your best lap", 409);

  const place = await placeOf(deps, rec, "", nameKey);
  const answer: Record<string, unknown> = { ok: true, rank: place.rank, total: place.total };
  if (eventError) answer.eventError = eventError;
  if (event) {
    const eventPlace = await placeOf(deps, rec, event, nameKey);
    answer.eventRank = eventPlace.rank;
    answer.eventTotal = eventPlace.total;
  }
  return { status: 200, body: answer };
}

export async function listLaps(deps: BoardDeps, url: URL): Promise<Answer> {
  const q = url.searchParams;
  const track = q.get("track") ?? "";
  const vehicle = q.get("vehicle") ?? "";
  const physics = Number(q.get("physics"));
  const event = q.get("event") ?? "";
  if (!TRACK_ID_RE.test(track) || !isVehicleModelId(vehicle) || !Number.isInteger(physics) || physics < 1 || physics > 1000) {
    return fail("track, vehicle and physics are required");
  }
  if (event !== "" && !EVENT_ID_RE.test(event)) return fail("Unknown event");
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;

  // Narrowing to a class: only known values are taken
  let where = "track_id = ? AND vehicle = ? AND physics = ? AND event = ?";
  const binds: unknown[] = [track, vehicle, physics, event];
  const narrow = (column: keyof LapConditions, allowed: readonly string[]) => {
    const value = q.get(column);
    if (value === null || value === "") return;
    if (!allowed.includes(value)) throw new Error(column);
    where += ` AND ${column} = ?`;
    binds.push(value);
  };
  try {
    narrow("assists", ASSIST_PRESETS);
    narrow("realism", SIM_REALISM_LEVELS);
    narrow("surface", ["dry", "wet"]);
  } catch {
    return fail("Unknown filter value");
  }

  const best = `SELECT *, ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY lap_time_ms, created_at) AS rn FROM laps WHERE ${where}`;
  const statements = [
    deps.db.prepare(`SELECT * FROM (${best}) WHERE rn = 1 ORDER BY lap_time_ms, created_at LIMIT ?`).bind(...binds, limit),
    deps.db.prepare(`SELECT COUNT(DISTINCT name_key) AS total FROM laps WHERE ${where}`).bind(...binds),
    deps.db.prepare("SELECT DISTINCT physics FROM laps WHERE track_id = ? AND vehicle = ? AND event = ? ORDER BY physics DESC").bind(track, vehicle, event),
  ];
  const name = q.get("name");
  const nameKey = name && name.length <= 64 ? driverNameKey(name) : "";
  if (nameKey) {
    statements.push(
      deps.db.prepare(`SELECT * FROM (${best}) WHERE rn = 1 AND name_key = ?`).bind(...binds, nameKey),
      deps.db
        // The drivers ahead, and the slowest of them: the place just above (the board lists only the top places)
        .prepare(`SELECT COUNT(*) AS ahead, MAX(b) AS above FROM (SELECT MIN(lap_time_ms) AS b FROM laps WHERE ${where} GROUP BY name_key) WHERE b < (SELECT MIN(lap_time_ms) FROM laps WHERE ${where} AND name_key = ?)`)
        .bind(...binds, ...binds, nameKey),
    );
  }
  const results = await deps.db.batch(statements);
  const mine = nameKey ? (results[3].results[0] as unknown as LapRow | undefined) : undefined;
  const ahead = nameKey ? (results[4].results[0] as { ahead: number; above: number | null } | undefined) : undefined;
  return {
    status: 200,
    body: {
      laps: (results[0].results as unknown as LapRow[]).map(entryOf),
      total: (results[1].results[0] as { total: number } | undefined)?.total ?? 0,
      physics: (results[2].results as { physics: number }[]).map((r) => r.physics),
      me: mine ? { rank: 1 + (ahead?.ahead ?? 0), lap: entryOf(mine), aboveMs: ahead?.above ?? null } : null,
    },
  };
}

/** The lap's stored recording as JSON text, or null */
export async function ghostOf(deps: BoardDeps, id: string): Promise<string | null> {
  if (!LAP_ID_RE.test(id)) return null;
  const object = await deps.ghosts.get(ghostKey(id));
  return object ? object.text() : null;
}

export function boardDeps(env: Env, eventRule: EventRule): BoardDeps | null {
  if (!env.BOARD_DB || !env.GHOSTS) return null;
  return { db: env.BOARD_DB, ghosts: env.GHOSTS, eventRule, now: Date.now };
}
