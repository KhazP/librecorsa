/**
 * The online lap boards, on D1 (rows) and R2 (ghost samples):
 *   POST /api/laps        { rec: LapRecording, driverKey, event? }
 *                         -> { ok: true, rank, total, eventRank?, eventTotal?, eventError? } | { ok: false, error }
 *   GET  /api/laps?track=&vehicle=&physics=&assists=&realism=&surface=&event=&name=&limit=&offset=&near=
 *                         -> { laps: [...], offset, total, me: { rank, pos, lap, aboveMs } | null, physics: [revisions with laps],
 *                              near?: { pos, laps: [...] }, current?: { <car>: revision } }
 *                            (limit 1 to 100, 20 by default; offset: places skipped, for the pages after the first.
 *                            rank: 1 + the drivers faster, so a tie shares it; pos: the place in the board's order,
 *                            which the pages follow. aboveMs: the best lap of the place above the driver's, null at the
 *                            top. near=1..5: the places either side of the driver's, as `near`)
 *                            vehicle=all: every driver once, with their fastest lap in any car, each car on its revision
 *                            on one of the circuit's boards (`current`, worked out here; `physics` is not needed and
 *                            is ignored). version=: that board's base revision, its PHYSICS_VERSION plus 1000 for each
 *                            restart of the circuit's boards (lap-types.ts `boardChoices`: 7 for Physics V1 on a
 *                            circuit never restarted; any other is refused); absent, the board laps go on now
 *   GET  /api/laps/<id>   -> the lap's LapRecording (its ghost), or 404
 *   POST /api/drivers/rename  { from, to, code?, driverKey }
 *                         -> { ok: true, moved } | { ok: false, error, taken? }
 *
 * One board per circuit, car and revision (lap-types.ts `lapPhysicsVersion`: the physics version, the circuit's own
 * restarts, the LC26's engine): every driver appears once, with their fastest lap and what it
 * was driven with (assists, realism, dry or wet). A driver keeps one stored lap per such class, so the board can be
 * narrowed ("no assists only") and still show everyone's best of that kind. A weekly challenge (`event`) has its own
 * board with the same rules. Laps go up on the board of the physics and the circuit as they are now only: older boards
 * are read, never written.
 *
 * Driver names are claimed with a driver key: a random secret the game keeps in the browser. The first upload under
 * a name stores the key's SHA-256; later uploads under that name (ignoring case and extra spaces) must bring the same
 * key. A claim lapses after six months without an upload, and the laps under it go with it. A driver who changes their
 * name takes their laps and race results with them (`renameDriver`), so a board never shows them twice. Names that
 * fail the name filter (src/lib/net/name-filter.ts) are refused on upload and on rename.
 */
import { ASSIST_PRESETS, boardChoices, currentBoardBase, isCurrentLapPhysics, MAX_LAP_REVISION, revisionOnBoard, type LapConditions } from "../../src/lib/sim/lap-types";
import { SIM_REALISM_LEVELS } from "../../src/lib/sim/sim-realism";
import { isVehicleModelId, VEHICLE_MODEL_IDS, type VehicleModelId } from "../../src/types/f1";
import { nameProblem } from "../../src/lib/net/name-filter";
import { checkLap, TRACK_ID_RE, type CheckedLap } from "./lap-check";
import { invalidateAutoWeeklyAwards, invalidateAutoWeeklyAwardsForDriver, moveDriverAwards } from "./awards";
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
/** `vehicle` for the board of every car on a circuit */
export const ALL_CARS = "all";

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
  /** What drove the lap; null on laps stored before it was kept */
  input: string | null;
  name_key: string;
  driver_name: string;
  driver_code: string;
  lap_time_ms: number;
  s1_ms: number;
  s2_ms: number;
  s3_ms: number;
  recorded_at: number;
  /** 1 when the lap's R2 JSON carries a car setup; absent/0 on older laps and pre-0009 schemas */
  has_setup?: number | null;
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
  ...(r.has_setup ? { hasSetup: true } : {}),
  conditions: {
    assists: r.assists,
    realism: r.realism,
    surface: r.surface,
    compound: r.compound,
    physicsVersion: r.physics,
    ...(r.input ? { input: r.input } : {}),
  },
});

/**
 * The claim key of a driver name: outer spaces off, runs of whitespace as one space, lower case. The same rule as the
 * Supabase board this one replaced, so the claims carried over from it (scripts/online/migrate-supabase-board.ts) keep matching.
 */
export function driverNameKey(name: string): string {
  return name.replace(/^ +| +$/g, "").replace(/[ \t\n\r\f\v]+/g, " ").toLowerCase();
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const ghostKey = (id: string) => `laps/${id}.json`;

/** Removes rows and their ghosts; when `refreshAutoAwards` is set (admin deletion), invalidates affected archived weekly podiums */
export async function deleteLaps(
  deps: { db: D1Database; ghosts?: R2Bucket },
  ids: string[],
  opts: { refreshAutoAwards?: boolean } = {},
): Promise<number> {
  let deleted = 0;
  const affected: { event: string; physics: number; nameKey: string }[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    if (opts.refreshAutoAwards) {
      const rows = await deps.db
        .prepare(`SELECT DISTINCT event, physics, name_key FROM laps WHERE event != '' AND id IN (${marks})`)
        .bind(...chunk)
        .all<{ event: string; physics: number; name_key: string }>();
      for (const r of rows.results) affected.push({ event: r.event, physics: r.physics, nameKey: r.name_key });
    }
    const done = await deps.db.prepare(`DELETE FROM laps WHERE id IN (${marks})`).bind(...chunk).run();
    deleted += done.meta?.changes ?? 0;
    if (deps.ghosts) await deps.ghosts.delete(chunk.map(ghostKey));
  }
  if (opts.refreshAutoAwards && affected.length > 0) {
    await invalidateAutoWeeklyAwards(deps.db, affected);
  }
  return deleted;
}

/** Removes every lap (and ghost) belonging to a driver and refreshes any affected archived weekly podiums */
export async function deleteDriverLaps(deps: { db: D1Database; ghosts?: R2Bucket }, rawName: string): Promise<number> {
  const nameKey = driverNameKey(rawName);
  if (!nameKey) return 0;
  const rows = await deps.db.prepare("SELECT id FROM laps WHERE name_key = ?").bind(nameKey).all<{ id: string }>();
  const deleted = await deleteLaps(deps, rows.results.map((r) => r.id), { refreshAutoAwards: true });
  await invalidateAutoWeeklyAwardsForDriver(deps.db, nameKey);
  return deleted;
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
  // The ghost (and optional sanitized setup) before the row that points at it
  await deps.ghosts.put(ghostKey(id), JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
  const baseValues = [
    id,
    rec.trackId,
    rec.vehicle,
    c.physicsVersion,
    event,
    c.assists,
    c.realism,
    c.surface,
    c.compound,
    c.input ?? null,
    nameKey,
    rec.driverName,
    rec.driverCode,
    rec.lapTimeMs,
    rec.sectorTimesMs[0],
    rec.sectorTimesMs[1],
    rec.sectorTimesMs[2],
    rec.recordedAt,
    deps.now(),
  ];
  const runInsert = async (withSetup: boolean) => {
    const writes: D1PreparedStatement[] = [];
    if (prev) writes.push(deps.db.prepare("DELETE FROM laps WHERE id = ?").bind(prev.id));
    writes.push(
      withSetup
        ? deps.db
            .prepare(
              "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, input, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at, has_setup) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(...baseValues, rec.setup ? 1 : 0)
        : deps.db
            .prepare(
              "INSERT INTO laps (id, track_id, vehicle, physics, event, assists, realism, surface, compound, input, name_key, driver_name, driver_code, lap_time_ms, s1_ms, s2_ms, s3_ms, recorded_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(...baseValues),
    );
    await deps.db.batch(writes);
  };
  try {
    await runInsert(true);
  } catch (err) {
    // Rolling-deploy / pre-0009 schema compatibility: fall back cleanly if `has_setup` column is not migrated yet
    if (String(err).includes("has_setup")) await runInsert(false);
    else throw err;
  }
  if (prev) await deps.ghosts.delete(ghostKey(prev.id));
  return true;
}

/** Counts one upload or rename from the request's address this hour (hashed); true once past the hourly limit */
async function overPostLimit(deps: BoardDeps, request: Request, nowMs: number): Promise<boolean> {
  const hour = Math.floor(nowMs / 3_600_000);
  const client = await sha256Hex(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const used = await deps.db
    .prepare("INSERT INTO lap_posts (client_hash, hour, count) VALUES (?, ?, 1) ON CONFLICT (client_hash, hour) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(client, hour)
    .first<{ count: number }>();
  if (used && used.count === 1) await deps.db.prepare("DELETE FROM lap_posts WHERE hour < ?").bind(hour - 1).run();
  return (used?.count ?? 1) > MAX_POSTS_PER_HOUR;
}

/** Puts `nameKey` under this driver key: false when another key holds it. A fresh claim starts clean: laps a lapsed owner left under the name go */
async function claimName(deps: BoardDeps, nameKey: string, keyHash: string, nowMs: number): Promise<boolean> {
  await deps.db.prepare("DELETE FROM drivers WHERE name_key = ? AND last_seen < ?").bind(nameKey, nowMs - CLAIM_LAPSES_MS).run();
  const claim = await deps.db
    .prepare("INSERT INTO drivers (name_key, key_hash, claimed_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (name_key) DO NOTHING")
    .bind(nameKey, keyHash, nowMs, nowMs)
    .run();
  const owner = await deps.db.prepare("SELECT key_hash FROM drivers WHERE name_key = ?").bind(nameKey).first<{ key_hash: string }>();
  if (owner?.key_hash !== keyHash) return false;
  if (claim.meta.changes === 1) {
    const left = await deps.db.prepare("SELECT id FROM laps WHERE name_key = ?").bind(nameKey).all<{ id: string }>();
    await deleteLaps(deps, left.results.map((r) => r.id));
  } else {
    await deps.db.prepare("UPDATE drivers SET last_seen = ? WHERE name_key = ?").bind(nowMs, nameKey).run();
  }
  return true;
}

const NAME_TAKEN = "This name is taken. Import your driver key under Lap Times, or race under another name";
/**
 * A lap driven on an older physics version, or before its circuit's boards started again (a tab left open from before
 * the update): its board is read only now
 */
export const OLDER_PHYSICS = "This lap is from an older version of the physics or the circuit. Reload the game to drive on the new one";

/**
 * What a refused upload said about itself, as sent (unchecked, capped): enough to match a player's report to it by
 * circuit, car and lap time. No name: a refused one was never public
 */
interface LapSeen {
  track?: string;
  vehicle?: string;
  lapTimeMs?: number;
}

/**
 * Takes an uploaded lap (POST /api/laps). A refusal goes to the Workers Logs with its reason and the lap it was about,
 * so a "my lap isn't on the board" report can be answered; a faster lap already on the board is no refusal
 */
export async function submitLap(deps: BoardDeps, request: Request): Promise<Answer> {
  const seen: LapSeen = {};
  const answer = await takeLap(deps, request, seen);
  const body = answer.body as { error?: unknown; notFaster?: unknown };
  if (answer.status >= 400 && body.notFaster !== true) {
    console.warn(JSON.stringify({ event: "lap_refused", status: answer.status, error: body.error, ...seen }));
  }
  return answer;
}

async function takeLap(deps: BoardDeps, request: Request, seen: LapSeen): Promise<Answer> {
  const nowMs = deps.now();
  if (await overPostLimit(deps, request, nowMs)) return fail("Too many uploads, try again later", 429);

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
  if (typeof body.rec === "object" && body.rec !== null) {
    const raw = body.rec as Record<string, unknown>;
    if (typeof raw.trackId === "string") seen.track = raw.trackId.slice(0, 64);
    if (typeof raw.vehicle === "string") seen.vehicle = raw.vehicle.slice(0, 32);
    if (typeof raw.lapTimeMs === "number") seen.lapTimeMs = raw.lapTimeMs;
  }

  const checked = checkLap(body.rec);
  if (!checked.ok) return fail(checked.error);
  const rec = checked.rec;
  const badName = nameProblem(rec.driverName);
  if (badName) return fail(badName);
  if (!isCurrentLapPhysics(rec.vehicle, rec.conditions.physicsVersion, rec.trackId)) return fail(OLDER_PHYSICS, 409);
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
  if (!(await claimName(deps, nameKey, keyHash, nowMs))) return { status: 409, body: { ok: false, error: NAME_TAKEN, taken: true } };

  // A challenge lap also counts on the open board
  const onOpen = await storeLap(deps, rec, "", nameKey);
  const onEvent = event ? await storeLap(deps, rec, event, nameKey) : false;
  if (!onOpen && !onEvent) {
    if (eventError) return fail(eventError, 409);
    // The board has this driver's faster lap already: the game posts a new best by itself and keeps quiet about this
    return { status: 409, body: { ok: false, error: "Not faster than your best lap", notFaster: true } };
  }

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

/**
 * The revision each car's laps are ranked under on the board of base revision `base` (lap-types.ts `BoardChoice`; the
 * board laps go on now is `currentBoardBase(track)`), as this build ships it: the revision `revisionOnBoard` gives a
 * car without a browser's own choice of engine (the LC26's older engine is kept in the browser, so the Worker always
 * reads the engine it ships on). The all-cars board takes every car at its own revision.
 */
export function currentPhysicsByCar(base: number): Record<VehicleModelId, number> {
  return Object.fromEntries(VEHICLE_MODEL_IDS.map((v) => [v, revisionOnBoard(base, v)])) as Record<VehicleModelId, number>;
}

/**
 * The rows of every car at its revision on the board of base revision `base` on a circuit: a WHERE clause and its
 * binds (after the circuit and event)
 */
export function currentPhysicsWhere(base: number): { sql: string; binds: unknown[] } {
  const current = Object.entries(currentPhysicsByCar(base));
  return {
    sql: `vehicle IN (${current.map(() => "?").join(", ")}) AND physics = CASE vehicle ${current.map(() => "WHEN ? THEN ?").join(" ")} END`,
    binds: [...current.map(([v]) => v), ...current.flat()],
  };
}

/** The order of a board, the same everywhere a place is worked out: time, then who set it first, then the row */
const BOARD_ORDER = "lap_time_ms, created_at, id";
/** Rows a listing may skip: far past any board this game will have */
const MAX_OFFSET = 1_000_000;
/** Places listed either side of the driver's own (`near`) */
const MAX_NEAR = 5;

/**
 * The board of a circuit an all-cars read asks for (`version`, by its base revision): the one laps go on now when
 * absent, null for one the circuit never had
 */
export function askedBoardBase(q: URLSearchParams, track: string): number | null {
  const raw = q.get("version");
  if (raw === null || raw === "") return currentBoardBase(track);
  const base = Number(raw);
  return Number.isInteger(base) && boardChoices(track).some((c) => c.base === base) ? base : null;
}

export async function listLaps(deps: BoardDeps, url: URL): Promise<Answer> {
  const q = url.searchParams;
  const track = q.get("track") ?? "";
  const vehicle = q.get("vehicle") ?? "";
  const allCars = vehicle === ALL_CARS;
  const physics = Number(q.get("physics"));
  const event = q.get("event") ?? "";
  if (!TRACK_ID_RE.test(track) || (!allCars && (!isVehicleModelId(vehicle) || !Number.isInteger(physics) || physics < 1 || physics > MAX_LAP_REVISION))) {
    return fail("track, vehicle and physics are required");
  }
  if (event !== "" && !EVENT_ID_RE.test(event)) return fail("Unknown event");
  const version = allCars ? askedBoardBase(q, track) : currentBoardBase(track);
  if (version === null) return fail("Unknown physics version");
  const limitRaw = Number(q.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(MAX_LIMIT, Math.floor(limitRaw)) : DEFAULT_LIMIT;
  const offsetRaw = Number(q.get("offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.min(MAX_OFFSET, Math.floor(offsetRaw)) : 0;
  const nearRaw = Number(q.get("near"));
  const near = Number.isFinite(nearRaw) && nearRaw > 0 ? Math.min(MAX_NEAR, Math.floor(nearRaw)) : 0;

  // One car on one revision, or every car on its revision under one physics version; narrowing to a class takes only
  // known values
  let where: string;
  const binds: unknown[] = [];
  if (allCars) {
    const current = currentPhysicsWhere(version);
    where = `track_id = ? AND event = ? AND ${current.sql}`;
    binds.push(track, event, ...current.binds);
  } else {
    where = "track_id = ? AND vehicle = ? AND physics = ? AND event = ?";
    binds.push(track, vehicle, physics, event);
  }
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

  // Each driver's fastest row; `pos` is their place in the board's order (a tie on time goes to the earlier lap)
  const best = `SELECT *, ROW_NUMBER() OVER (PARTITION BY name_key ORDER BY ${BOARD_ORDER}) AS rn FROM laps WHERE ${where}`;
  const ordered = `SELECT *, ROW_NUMBER() OVER (ORDER BY ${BOARD_ORDER}) AS pos FROM (${best}) WHERE rn = 1`;
  const statements = [
    deps.db.prepare(`SELECT * FROM (${best}) WHERE rn = 1 ORDER BY ${BOARD_ORDER} LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    deps.db.prepare(`SELECT COUNT(DISTINCT name_key) AS total FROM laps WHERE ${where}`).bind(...binds),
    // The revisions this car has laps under (the all-cars board takes each car's current one only)
    allCars
      ? deps.db.prepare("SELECT 1 AS physics WHERE 0")
      : deps.db.prepare("SELECT DISTINCT physics FROM laps WHERE track_id = ? AND vehicle = ? AND event = ? ORDER BY physics DESC").bind(track, vehicle, event),
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
      // The driver's position in the board's order, and the places either side of it
      deps.db
        .prepare(`WITH o AS (${ordered}), me AS (SELECT pos FROM o WHERE name_key = ?) SELECT o.* FROM o, me WHERE o.pos BETWEEN me.pos - ? AND me.pos + ? ORDER BY o.pos`)
        .bind(...binds, nameKey, near, near),
    );
  }
  const results = await deps.db.batch(statements);
  const mine = nameKey ? (results[3].results[0] as unknown as LapRow | undefined) : undefined;
  const ahead = nameKey ? (results[4].results[0] as { ahead: number; above: number | null } | undefined) : undefined;
  const around = nameKey ? (results[5].results as unknown as (LapRow & { pos: number })[]) : [];
  const myPos = around.find((r) => r.name_key === nameKey)?.pos;
  const body: Record<string, unknown> = {
    laps: (results[0].results as unknown as LapRow[]).map(entryOf),
    offset,
    total: (results[1].results[0] as { total: number } | undefined)?.total ?? 0,
    physics: (results[2].results as { physics: number }[]).map((r) => r.physics),
    me: mine ? { rank: 1 + (ahead?.ahead ?? 0), pos: myPos ?? 1 + (ahead?.ahead ?? 0), lap: entryOf(mine), aboveMs: ahead?.above ?? null } : null,
  };
  // Every car's revision on this board, so a client checks the rows against what this board took, not its own engine
  // choice
  if (allCars) body.current = currentPhysicsByCar(version);
  if (near > 0 && mine && around.length > 0) body.near = { pos: around[0].pos, laps: around.map(entryOf) };
  return { status: 200, body };
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

const MAX_RENAME_BYTES = 4096;
const MAX_NAME_LENGTH = 64;
const MAX_CODE_LENGTH = 16;

/**
 * A driver changes their name: the new one is claimed with their driver key (it must be free, lapsed or theirs
 * already), and when the key holds the old one, its laps (open and challenge boards) and race results move to the new
 * name and the old claim goes, free for anyone. A driver who already had laps under the new name keeps the fastest of
 * each class. Ghost files keep the name they were driven under.
 */
export async function renameDriver(deps: BoardDeps, request: Request): Promise<Answer> {
  const nowMs = deps.now();
  if (await overPostLimit(deps, request, nowMs)) return fail("Too many changes, try again later", 429);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_RENAME_BYTES) return fail("Body is too large", 413);
  // A body sent without a length (chunked) is measured once read
  const text = await request.text();
  if (text.length > MAX_RENAME_BYTES) return fail("Body is too large", 413);
  let body: { from?: unknown; to?: unknown; code?: unknown; driverKey?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return fail("Body is not valid JSON");
  }
  if (typeof body !== "object" || body === null) return fail("Body is not valid JSON");
  const from = typeof body.from === "string" ? body.from.trim() : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (to.length === 0 || to.length > MAX_NAME_LENGTH || from.length > MAX_NAME_LENGTH) return fail("Invalid name");
  const code = typeof body.code === "string" ? body.code.trim() : null;
  if (code !== null && (code.length === 0 || code.length > MAX_CODE_LENGTH)) return fail("Invalid driver code");
  const badName = nameProblem(to);
  if (badName) return fail(badName);
  if (typeof body.driverKey !== "string" || !DRIVER_KEY_RE.test(body.driverKey)) {
    return fail("Missing driver key. Reload the game and try again");
  }
  const keyHash = await sha256Hex(body.driverKey);
  const fromKey = from ? driverNameKey(from) : "";
  const toKey = driverNameKey(to);

  // Whether this key holds the old name, read before the new one is claimed (which may be the same name in other letters)
  const oldOwner = fromKey ? await deps.db.prepare("SELECT key_hash FROM drivers WHERE name_key = ?").bind(fromKey).first<{ key_hash: string }>() : null;
  const ownsOld = oldOwner?.key_hash === keyHash;
  if (!(await claimName(deps, toKey, keyHash, nowMs))) return { status: 409, body: { ok: false, error: NAME_TAKEN, taken: true } };

  let moved = 0;
  if (ownsOld && fromKey !== toKey) {
    // The driver's own laps already under the new name (from before): a driver keeps one lap per class, the faster
    const pairs = await deps.db
      .prepare(
        "SELECT f.id AS old_id, f.lap_time_ms AS old_ms, t.id AS new_id, t.lap_time_ms AS new_ms FROM laps f JOIN laps t ON t.track_id = f.track_id AND t.vehicle = f.vehicle AND t.physics = f.physics AND t.event = f.event AND t.assists = f.assists AND t.realism = f.realism AND t.surface = f.surface WHERE f.name_key = ? AND t.name_key = ?",
      )
      .bind(fromKey, toKey)
      .all<{ old_id: string; old_ms: number; new_id: string; new_ms: number }>();
    await deleteLaps(deps, pairs.results.map((p) => (p.new_ms <= p.old_ms ? p.old_id : p.new_id)));
    const count = await deps.db.prepare("SELECT COUNT(*) AS n FROM laps WHERE name_key = ?").bind(fromKey).first<{ n: number }>();
    moved = count?.n ?? 0;
    await deps.db.batch([
      deps.db.prepare("UPDATE laps SET name_key = ?, driver_name = ?, driver_code = COALESCE(?, driver_code) WHERE name_key = ?").bind(toKey, to, code, fromKey),
      deps.db.prepare("UPDATE race_cars SET name_key = ?, name = ?, code = COALESCE(?, code) WHERE name_key = ?").bind(toKey, to, code, fromKey),
      deps.db.prepare("DELETE FROM drivers WHERE name_key = ?").bind(fromKey),
    ]);
    await moveDriverAwards(deps.db, fromKey, toKey, to);
  } else if (ownsOld || fromKey === toKey) {
    // The same name in other letters or spacing: the boards show it as now written
    await deps.db.batch([
      deps.db.prepare("UPDATE laps SET driver_name = ?, driver_code = COALESCE(?, driver_code) WHERE name_key = ?").bind(to, code, toKey),
      deps.db.prepare("UPDATE race_cars SET name = ?, code = COALESCE(?, code) WHERE name_key = ?").bind(to, code, toKey),
    ]);
    await moveDriverAwards(deps.db, toKey, toKey, to);
  }
  return { status: 200, body: { ok: true, moved } };
}
