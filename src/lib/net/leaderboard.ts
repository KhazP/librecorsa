/**
 * Lap boards: a local one built from the personal bests in ghost-store, and the online one served by the site's own
 * API (cloudflare/api/board.ts) when it has one switched on (src/lib/net/online-config.ts).
 *
 * Online there is one board per circuit and car: every driver appears once, with their fastest lap and what it was
 * driven with (assists, realism, dry or wet, and the input: keyboard, controller, wheel or touch). The board can be narrowed to laps of one kind ("no assists").
 * Only the LapRecording and the driver key are ever sent; answers are validated before use.
 */
import { text as t } from "@/lib/text";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { listBestLaps } from "@/lib/sim/ghost-store";
import { lapPlausibilityProblem } from "@/lib/sim/lap-plausibility";
import { isPointToPointTrack } from "@/lib/track-kinds";
import { validateLapRecording } from "@/lib/sim/lap-recorder";
import { isCurrentLapPhysics, lapBoardClass, lapGoesOnBoards, lapPhysicsVersion, type LapConditions, type LapRecording, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { getOrCreateDriverKey } from "./driver-key";
import { getOnlineConfig, markOnlineAnswered, markOnlineUnreachable, onlineUrl, readOnlineConfig } from "./online-config";
import { cappedString, clampLimit, fetchBoardPage, finiteNumber, parseBoardPage, requestJson, type BoardFilter } from "./board-client";

export { boardLabel, driverNameKey, type BoardFilter } from "./board-client";

const DEFAULT_LIMIT = 50;
const MAX_ID_LENGTH = 64;
const MAX_ERROR_LENGTH = 200;

/** One online board as fetched: its fastest drivers, how many drivers it has, and where this player stands */
export interface RemoteBoard {
  entries: LeaderboardEntry[];
  /** Drivers on the board (with the filter applied) */
  total: number;
  /**
   * This player's place and lap, and the best lap of the place above theirs (null at the top, or from a server that
   * does not say); null when they have no lap here. `pos`: their place in the board's order (a tie shares the rank)
   */
  me: { rank: number; pos?: number; entry: LeaderboardEntry; aboveMs: number | null } | null;
  /** Physics revisions that have laps for this circuit and car, newest first */
  physics: number[];
}

export interface SubmitResult {
  ok: boolean;
  /** Place on the circuit and car's board, and how many drivers it has */
  rank?: number;
  total?: number;
  /** Place on the weekly challenge's board, when the lap was driven in one */
  eventRank?: number;
  eventTotal?: number;
  error?: string;
  /** Refused only because the board has this driver's faster lap already */
  notFaster?: boolean;
  /** Refused because another driver holds the name */
  taken?: boolean;
  /** Never reached the board (no answer from it): the game sends the lap again once it answers (board-queue.ts) */
  unreachable?: boolean;
  /** Turned away for too many uploads from this address: not sent again by itself */
  limited?: boolean;
}

/** What the lap card says, and Your best laps, when a lap couldn't reach the board and will go up once it can */
export const BOARD_UNREACHABLE = "Couldn't reach the online board, I'll keep trying";
/** The same once the game has stopped trying by itself (Your best laps still has Retry) */
export const BOARD_UNREACHABLE_GAVE_UP = "Couldn't reach the online board";
/** A lap driven on an older physics version, or before its circuit's boards started again: that board is read only */
export const OLDER_PHYSICS_LAP = "This lap is from an older version of the physics or the circuit, and that board is read only";
/** A lap with a mod package's car or circuit in it */
export const MOD_LAP = "Laps with mod cars or mod circuits stay off the online boards";

export interface RenameResult {
  ok: boolean;
  error?: string;
  /** Another driver holds the new name */
  taken?: boolean;
}

const CHALLENGE_BEST_KEY = "lc.challengeBest";
const MAX_CHALLENGE_BESTS = 16;

function readChallengeBests(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHALLENGE_BEST_KEY) ?? "null");
    if (!isRecord(saved)) return {};
    // Backwards compatibility with single-challenge saves: { id, lapTimeMs }
    if (typeof saved.id === "string") {
      const ms = finiteNumber(saved.lapTimeMs);
      return ms !== null ? { [saved.id]: ms } : {};
    }
    if (isRecord(saved.byId)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(saved.byId)) {
        const ms = finiteNumber(v);
        if (ms !== null) out[k] = ms;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

/** This browser's best lap (ms) on the board of challenge `id` (weekly or permanent), as last confirmed by the server; null without one */
export function loadChallengeBest(id: string): number | null {
  return readChallengeBests()[id] ?? null;
}

/** Remembers the lap that went on a challenge's board (supports multiple active trials simultaneously) */
export function saveChallengeBest(id: string, lapTimeMs: number): void {
  try {
    const bests = readChallengeBests();
    const known = bests[id];
    if (known !== undefined && known <= lapTimeMs) return;
    delete bests[id];
    bests[id] = lapTimeMs;
    const keys = Object.keys(bests);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_CHALLENGE_BESTS))) delete bests[old];
    localStorage.setItem(CHALLENGE_BEST_KEY, JSON.stringify({ byId: bests }));
  } catch {
    // Storage blocked: the next challenge lap is simply sent again
  }
}

const BOARD_BEST_KEY = "lc.boardBest";
/** Boards remembered; past this the oldest are forgotten (a forgotten board's next lap is simply sent again) */
const MAX_BOARD_BESTS = 200;

/** The online board a lap goes on: circuit, car and class (physics revision, assists, realism, surface); null without conditions */
export function boardKeyOf(rec: Pick<LapRecording, "trackId" | "vehicle" | "conditions">): string | null {
  return rec.conditions ? `${rec.trackId}|${rec.vehicle}|${lapBoardClass(rec.conditions)}` : null;
}

function readBoardBests(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(BOARD_BEST_KEY) ?? "null");
    return isRecord(saved) ? saved : {};
  } catch {
    return {};
  }
}

/**
 * This browser's best lap (ms) on an online board, as the server last took it or turned it down for a faster one of the
 * driver's; null when none has gone up from here. Not the local personal best: bests set before the board began, or
 * while it was off, never went up, and laps slower than them still belong on it.
 */
export function loadBoardBest(key: string): number | null {
  return finiteNumber(readBoardBests()[key]);
}

/** Remembers a lap the board took (or refused for a faster one it has); a slower time never replaces a faster one */
export function saveBoardBest(key: string, lapTimeMs: number): void {
  try {
    const bests = readBoardBests();
    const known = finiteNumber(bests[key]);
    if (known !== null && known <= lapTimeMs) return;
    delete bests[key];
    bests[key] = lapTimeMs;
    const keys = Object.keys(bests);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BOARD_BESTS))) delete bests[old];
    localStorage.setItem(BOARD_BEST_KEY, JSON.stringify(bests));
  } catch {
    // Storage blocked: the next lap is simply sent again, and the board keeps the faster one
  }
}

const BOARD_MISS_KEY = "lc.boardMiss";

/** A lap that didn't go on its board, and why: the last failed upload per board */
interface BoardMiss {
  lapTimeMs: number;
  recordedAt: number;
  error: string;
  /**
   * The board was out of reach, so the game sends the lap again once it answers: a lap posting sent by itself
   * (`auto`), or one the player sent (`hand`). Absent for a lap the board (or the game's own check) turned down
   */
  retry?: "auto" | "hand";
}

/** A lap waiting to go up again: its board (circuit, car, class) and which lap it is */
export interface QueuedMiss {
  key: string;
  trackId: string;
  vehicle: VehicleModelId;
  /** The board class (`lapBoardClass`) */
  board: string;
  lapTimeMs: number;
  recordedAt: number;
  retry: "auto" | "hand";
}

function readBoardMisses(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(BOARD_MISS_KEY) ?? "null");
    return isRecord(saved) ? saved : {};
  } catch {
    return {};
  }
}

function writeBoardMisses(misses: Record<string, unknown>): void {
  try {
    const keys = Object.keys(misses);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BOARD_BESTS))) delete misses[old];
    localStorage.setItem(BOARD_MISS_KEY, JSON.stringify(misses));
  } catch {
    // Storage blocked: the lap still shows as not on the board, without the reason
  }
}

/**
 * Remembers why a lap didn't go on its board (refused here or by the server, or the board was out of reach), so Your
 * best laps can say so after the lap card is gone. One failure per board is kept: a slower lap's never replaces the
 * reason a faster one (the best shown there) didn't go up. `retry`: the board was out of reach, and the lap goes up
 * once it answers
 */
export function saveBoardMiss(
  rec: Pick<LapRecording, "trackId" | "vehicle" | "conditions" | "lapTimeMs" | "recordedAt">,
  error: string,
  retry?: "auto" | "hand",
): void {
  const key = boardKeyOf(rec);
  if (!key) return;
  const misses = readBoardMisses();
  const known = misses[key];
  if (isRecord(known) && finiteNumber(known.lapTimeMs) !== null && (known.lapTimeMs as number) < rec.lapTimeMs) return;
  delete misses[key];
  const miss: BoardMiss = { lapTimeMs: rec.lapTimeMs, recordedAt: rec.recordedAt, error: error.slice(0, MAX_ERROR_LENGTH) };
  if (retry) miss.retry = retry;
  misses[key] = miss;
  writeBoardMisses(misses);
}

/** The laps waiting for the board to answer again, oldest first (board-queue.ts sends them) */
export function queuedBoardMisses(): QueuedMiss[] {
  const queued: QueuedMiss[] = [];
  for (const [key, miss] of Object.entries(readBoardMisses())) {
    if (!isRecord(miss) || (miss.retry !== "auto" && miss.retry !== "hand")) continue;
    const lapTimeMs = finiteNumber(miss.lapTimeMs);
    const recordedAt = finiteNumber(miss.recordedAt);
    const [trackId, vehicle, board, ...rest] = key.split("|");
    if (lapTimeMs === null || recordedAt === null || !trackId || !board || rest.length > 0 || !isVehicleModelId(vehicle)) continue;
    queued.push({ key, trackId, vehicle, board, lapTimeMs, recordedAt, retry: miss.retry });
  }
  return queued.sort((a, b) => a.recordedAt - b.recordedAt);
}

/** A queued lap the game stops sending by itself (it gave up, or the lap is gone): the reason stays, Retry with it */
export function settleBoardMiss(key: string, recordedAt: number, error: string): void {
  const misses = readBoardMisses();
  const miss = misses[key];
  if (!isRecord(miss) || miss.recordedAt !== recordedAt) return;
  delete miss.retry;
  miss.error = error.slice(0, MAX_ERROR_LENGTH);
  writeBoardMisses(misses);
}

/** Forgets a board's failed upload once a lap as fast or faster has gone on it */
export function clearBoardMiss(key: string, lapTimeMs: number): void {
  const misses = readBoardMisses();
  const miss = misses[key];
  if (miss === undefined) return;
  if (isRecord(miss) && finiteNumber(miss.lapTimeMs) !== null && (miss.lapTimeMs as number) < lapTimeMs) return;
  delete misses[key];
  writeBoardMisses(misses);
}

/**
 * Whether a saved best is on its online board, as far as this browser knows: `posted` once the board took it (or has a
 * faster lap of the driver's), else not, with the reason its last upload failed when it was this lap's. Null for a lap
 * that can't go on a current board (no conditions, an older physics revision, or a mod circuit's)
 */
export function boardStatusOf(
  lap: Pick<LeaderboardEntry, "trackId" | "vehicle" | "conditions" | "lapTimeMs" | "recordedAt">,
): { posted: true } | { posted: false; error: string | null } | null {
  if (!lap.conditions || lap.conditions.physicsVersion !== lapPhysicsVersion(lap.vehicle, lap.trackId)) return null;
  // A mod circuit's best is the player's own: no board to be on
  if (!lapGoesOnBoards(lap)) return null;
  const key = boardKeyOf(lap);
  if (!key) return null;
  const best = loadBoardBest(key);
  if (best !== null && best <= lap.lapTimeMs) return { posted: true };
  const miss = readBoardMisses()[key];
  const mine = isRecord(miss) && miss.lapTimeMs === lap.lapTimeMs && miss.recordedAt === lap.recordedAt;
  return { posted: false, error: mine ? cappedString(miss.error, MAX_ERROR_LENGTH) : null };
}

/** True when this site has an online lap board switched on (online-config.ts keeps the answer for a while) */
export async function boardOnline(): Promise<boolean> {
  return (await getOnlineConfig()).board;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Board row for a lap: its driver, time and car, without the samples */
export function lapToEntry(rec: LapRecording, source: "local" | "remote", id?: string): LeaderboardEntry {
  const entry: LeaderboardEntry = {
    name: rec.driverName,
    code: rec.driverCode,
    lapTimeMs: rec.lapTimeMs,
    sectorTimesMs: [rec.sectorTimesMs[0], rec.sectorTimesMs[1], rec.sectorTimesMs[2]],
    vehicle: rec.vehicle,
    trackId: rec.trackId,
    recordedAt: rec.recordedAt,
    source,
  };
  if (rec.conditions) entry.conditions = { ...rec.conditions };
  if (id !== undefined) entry.id = id;
  if (rec.setup) {
    entry.hasSetup = true;
    entry.setup = rec.setup;
  }
  return entry;
}


/** Local personal bests for this circuit (all cars, or one car), every class, fastest first */
export async function localLeaderboard(trackId: string, vehicle?: VehicleModelId): Promise<LeaderboardEntry[]> {
  const laps = await listBestLaps();
  return laps
    .filter((lap) => lap.trackId === trackId && (vehicle === undefined || lap.vehicle === vehicle))
    .map((lap) => lapToEntry(lap, "local"))
    .sort((a, b) => a.lapTimeMs - b.lapTimeMs);
}

/** An answer of GET /api/laps for one car's board, validated (board-client.ts); null when it is not one */
export function parseRemoteBoard(
  body: unknown,
  trackId: string,
  vehicle: VehicleModelId,
  physics: number,
  filter: BoardFilter,
  limit: number = DEFAULT_LIMIT,
): RemoteBoard | null {
  const page = parseBoardPage(body, trackId, vehicle, physics, filter, clampLimit(limit, DEFAULT_LIMIT));
  return page ? { entries: page.entries, total: page.total, me: page.me, physics: page.physics } : null;
}

/**
 * One online board: the fastest drivers of a circuit and car (optionally only laps driven a certain way, or under an
 * older physics `version`), and where `name` stands on it. Null when there is no online board, or it could not be read.
 */
export async function fetchRemoteBoard(
  trackId: string,
  vehicle: VehicleModelId,
  opts: { filter?: BoardFilter; physics?: number; version?: number; name?: string; event?: string; limit?: number } = {},
): Promise<RemoteBoard | null> {
  const page = await fetchBoardPage(trackId, vehicle, { ...opts, limit: clampLimit(opts.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT) });
  return page ? { entries: page.entries, total: page.total, me: page.me, physics: page.physics } : null;
}

/** The wire form of a lap: exactly the LapRecording fields the board keeps and nothing else */
function toWirePayload(rec: LapRecording & { conditions: LapConditions }): LapRecording {
  return {
    version: rec.version,
    trackId: rec.trackId,
    vehicle: rec.vehicle,
    driverName: rec.driverName,
    driverCode: rec.driverCode,
    lapTimeMs: rec.lapTimeMs,
    sectorTimesMs: [rec.sectorTimesMs[0], rec.sectorTimesMs[1], rec.sectorTimesMs[2]],
    recordedAt: rec.recordedAt,
    sampleHz: rec.sampleHz,
    data: rec.data,
    conditions: { ...rec.conditions },
    ...(rec.setup ? { setup: rec.setup } : {}),
  };
}

/**
 * Uploads a valid lap with its ghost (POST /api/laps), claiming the driver's name with this browser's key. A board out
 * of reach (no answer to the switches, tried again now, or none to the upload) is `unreachable`, never "off"
 */
export async function submitLap(rec: LapRecording, opts: { event?: string } = {}): Promise<SubmitResult> {
  const url = onlineUrl("/laps");
  if (!url) return { ok: false, error: "The online board is not available right now" };
  const online = await readOnlineConfig({ fresh: true });
  if (online.reach === "unreachable") return { ok: false, unreachable: true, error: BOARD_UNREACHABLE };
  if (!online.config.board) return { ok: false, error: "The online board is not available right now" };
  const valid = validateLapRecording(rec);
  if (!valid) return { ok: false, error: "The lap recording is invalid" };
  // A mod package's car or circuit: the lap is the player's own, never the board's
  if (!lapGoesOnBoards(valid)) return { ok: false, error: MOD_LAP };
  // Without its assists, realism, surface and physics revision a lap can't be shown fairly
  if (!valid.conditions) return { ok: false, error: "This lap was recorded by an older version of the game" };
  // Only the physics and the circuit as they are now take laps (a lap queued from before an update stays off)
  if (!isCurrentLapPhysics(valid.vehicle, valid.conditions.physicsVersion, valid.trackId)) return { ok: false, error: OLDER_PHYSICS_LAP };
  // The board refuses a lap whose samples don't agree with each other; say so before uploading
  const problem = lapPlausibilityProblem(valid.data, { open: isPointToPointTrack(valid.trackId) });
  if (problem) return { ok: false, error: problem };
  const body: Record<string, unknown> = { rec: toWirePayload({ ...valid, conditions: valid.conditions }), driverKey: getOrCreateDriverKey() };
  if (opts.event) body.event = opts.event;
  const res = await requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res) {
    // No answer at all: the server is out of reach until a read of the switches gets one (which sends the lap again)
    markOnlineUnreachable();
    return { ok: false, unreachable: true, error: BOARD_UNREACHABLE };
  }
  markOnlineAnswered();
  const answer: Record<string, unknown> = isRecord(res.body) ? res.body : {};
  if (res.status >= 200 && res.status < 300 && answer.ok === true) {
    const result: SubmitResult = { ok: true };
    for (const field of ["rank", "total", "eventRank", "eventTotal"] as const) {
      const value = finiteNumber(answer[field]);
      if (value !== null && value >= 1) result[field] = Math.floor(value);
    }
    return result;
  }
  const message = cappedString(answer.error, MAX_ERROR_LENGTH);
  const result: SubmitResult = { ok: false, error: message ?? `Leaderboard rejected the lap (HTTP ${res.status})` };
  if (answer.notFaster === true) result.notFaster = true;
  if (answer.taken === true) result.taken = true;
  if (res.status === 429) result.limited = true;
  return result;
}

/**
 * Moves the driver's laps from `from` to `to` on the online boards (POST /api/drivers/rename), claiming `to` with this
 * browser's key, so the boards never list them twice. Without an online board there is nothing to move: the name only
 * changes here. With the board out of reach it doesn't change at all: laps sent later under the new name would stand
 * beside the old ones.
 */
export async function renameOnBoard(from: string, to: string, code?: string): Promise<RenameResult> {
  const url = onlineUrl("/drivers/rename");
  if (!url) return { ok: true };
  const online = await readOnlineConfig({ fresh: true });
  if (online.reach === "unreachable") return { ok: false, error: t("game.board.renameUnreachable") };
  if (!online.config.board) return { ok: true };
  const body = JSON.stringify({ from, to, ...(code ? { code } : {}), driverKey: getOrCreateDriverKey() });
  const res = await requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!res) {
    markOnlineUnreachable();
    return { ok: false, error: t("game.board.renameUnreachable") };
  }
  markOnlineAnswered();
  const answer: Record<string, unknown> = isRecord(res.body) ? res.body : {};
  if (res.status >= 200 && res.status < 300 && answer.ok === true) return { ok: true };
  return {
    ok: false,
    error: cappedString(answer.error, MAX_ERROR_LENGTH) ?? t("game.board.renameFailed", { status: String(res.status) }),
    taken: answer.taken === true,
  };
}

/** Downloads an online lap's ghost (GET /api/laps/<id>) → LapRecording (validated) or null */
export async function fetchRemoteGhost(id: string): Promise<LapRecording | null> {
  const base = onlineUrl("/laps");
  if (!base || cappedString(id, MAX_ID_LENGTH) === null) return null;
  const res = await requestJson(`${base}/${encodeURIComponent(id)}`, { method: "GET" });
  if (!res || res.status !== 200) return null;
  return validateLapRecording(res.body);
}
