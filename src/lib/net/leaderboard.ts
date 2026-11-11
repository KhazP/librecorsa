/**
 * Lap boards: a local one built from the personal bests in ghost-store, and the online one served by the site's own
 * API (cloudflare/api/board.ts) when it has one switched on (src/lib/net/online-config.ts).
 *
 * Online there is one board per circuit and car: every driver appears once, with their fastest lap and what it was
 * driven with (assists, realism, dry or wet). The board can be narrowed to laps of one kind ("no assists").
 * Only the LapRecording and the driver key are ever sent; answers are validated before use.
 */
import { isVehicleModelId, type AssistPreset, type VehicleModelId } from "@/types/f1";
import { listBestLaps } from "@/lib/sim/ghost-store";
import { lapPlausibilityProblem } from "@/lib/sim/lap-plausibility";
import { validateLapRecording } from "@/lib/sim/lap-recorder";
import { lapPhysicsVersion, parseLapConditions, type LapConditions, type LapRecording, type LeaderboardEntry } from "@/lib/sim/lap-types";
import type { SimRealism } from "@/lib/sim/sim-realism";
import { getOrCreateDriverKey } from "./driver-key";
import { getOnlineConfig, onlineUrl } from "./online-config";

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_CODE_LENGTH = 16;
const MAX_TRACK_ID_LENGTH = 64;
const MAX_ERROR_LENGTH = 200;

/** Narrows the online board to laps driven a certain way; absent fields take every lap */
export interface BoardFilter {
  assists?: AssistPreset;
  realism?: SimRealism;
  surface?: "dry" | "wet";
}

/** One online board as fetched: its fastest drivers, how many drivers it has, and where this player stands */
export interface RemoteBoard {
  entries: LeaderboardEntry[];
  /** Drivers on the board (with the filter applied) */
  total: number;
  /**
   * This player's place and lap, and the best lap of the place above theirs (null at the top, or from a server that
   * does not say); null when they have no lap here
   */
  me: { rank: number; entry: LeaderboardEntry; aboveMs: number | null } | null;
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
}

const CHALLENGE_BEST_KEY = "lc.challengeBest";

/** This browser's best lap (ms) on the board of weekly challenge `id`, as last confirmed by the server; null without one */
export function loadChallengeBest(id: string): number | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHALLENGE_BEST_KEY) ?? "null");
    if (!isRecord(saved) || saved.id !== id) return null;
    return finiteNumber(saved.lapTimeMs);
  } catch {
    return null;
  }
}

/** Remembers the lap that went on a weekly challenge's board (only the current week's is kept) */
export function saveChallengeBest(id: string, lapTimeMs: number): void {
  try {
    localStorage.setItem(CHALLENGE_BEST_KEY, JSON.stringify({ id, lapTimeMs }));
  } catch {
    // Storage blocked: the next challenge lap is simply sent again
  }
}

/** True when this site has an online lap board switched on (asked once, then remembered for a while) */
export async function boardOnline(): Promise<boolean> {
  return (await getOnlineConfig()).board;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string no longer than max, or null */
function cappedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit))) : DEFAULT_LIMIT;
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
  return entry;
}

const ASSIST_LABEL: Record<LapConditions["assists"], string> = { pro: "No assists", semi_pro: "Some assists", assisted: "Assisted" };
const REALISM_LABEL: Record<LapConditions["realism"], string> = { casual: "Casual", standard: "Standard", full: "Full" };

/** "No assists · Full · Dry": what a lap was driven with */
export function boardLabel(c: Pick<LapConditions, "assists" | "realism" | "surface">): string {
  return `${ASSIST_LABEL[c.assists]} · ${REALISM_LABEL[c.realism]} · ${c.surface === "wet" ? "Wet" : "Dry"}`;
}

/** The claim key of a driver name, as the board compares names: outer spaces off, inner runs as one, lower case */
export function driverNameKey(name: string): string {
  return name.replace(/^ +| +$/g, "").replace(/[ \t\n\r\f\v]+/g, " ").toLowerCase();
}

/** Local personal bests for this circuit (all cars, or one car), every class, fastest first */
export async function localLeaderboard(trackId: string, vehicle?: VehicleModelId): Promise<LeaderboardEntry[]> {
  const laps = await listBestLaps();
  return laps
    .filter((lap) => lap.trackId === trackId && (vehicle === undefined || lap.vehicle === vehicle))
    .map((lap) => lapToEntry(lap, "local"))
    .sort((a, b) => a.lapTimeMs - b.lapTimeMs);
}

/** Validates one remote board row; null when any field is missing or malformed, or it belongs on another board */
function parseRemoteEntry(raw: unknown, trackId: string, vehicle: VehicleModelId, physics: number, filter: BoardFilter): LeaderboardEntry | null {
  if (!isRecord(raw)) return null;
  const name = cappedString(raw.name, MAX_NAME_LENGTH);
  const code = cappedString(raw.code, MAX_CODE_LENGTH);
  const entryTrack = cappedString(raw.trackId, MAX_TRACK_ID_LENGTH);
  const lapTimeMs = finiteNumber(raw.lapTimeMs);
  const recordedAt = finiteNumber(raw.recordedAt);
  const sectors = Array.isArray(raw.sectorTimesMs) ? raw.sectorTimesMs : null;
  if (!sectors || sectors.length !== 3) return null;
  const s0 = finiteNumber(sectors[0]);
  const s1 = finiteNumber(sectors[1]);
  const s2 = finiteNumber(sectors[2]);
  if (!name || !code || !entryTrack || lapTimeMs === null || lapTimeMs <= 0 || recordedAt === null) return null;
  if (s0 === null || s1 === null || s2 === null || s0 < 0 || s1 < 0 || s2 < 0) return null;
  // Rows for another circuit or car do not belong on this board
  if (entryTrack !== trackId || raw.vehicle !== vehicle || !isVehicleModelId(raw.vehicle)) return null;
  if (raw.id !== undefined && cappedString(raw.id, MAX_ID_LENGTH) === null) return null;
  // Nor do rows from another physics revision, or outside what was asked for
  const conditions = parseLapConditions(raw.conditions);
  if (!conditions || conditions.physicsVersion !== physics) return null;
  if (filter.assists && conditions.assists !== filter.assists) return null;
  if (filter.realism && conditions.realism !== filter.realism) return null;
  if (filter.surface && conditions.surface !== filter.surface) return null;

  const entry: LeaderboardEntry = {
    name,
    code,
    lapTimeMs,
    sectorTimesMs: [s0, s1, s2],
    vehicle,
    trackId: entryTrack,
    recordedAt,
    source: "remote",
    conditions,
  };
  if (typeof raw.id === "string") entry.id = raw.id;
  return entry;
}

/** fetch() with an 8 s timeout; resolves null on network error, timeout or unreadable body */
async function requestJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** An answer of GET /api/laps, validated; null when it is not one */
export function parseRemoteBoard(
  body: unknown,
  trackId: string,
  vehicle: VehicleModelId,
  physics: number,
  filter: BoardFilter,
  limit: number = DEFAULT_LIMIT,
): RemoteBoard | null {
  if (!isRecord(body) || !Array.isArray(body.laps)) return null;
  const entries: LeaderboardEntry[] = [];
  for (const row of body.laps.slice(0, clampLimit(limit))) {
    const entry = parseRemoteEntry(row, trackId, vehicle, physics, filter);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
  const total = finiteNumber(body.total);
  let me: RemoteBoard["me"] = null;
  if (isRecord(body.me)) {
    const rank = finiteNumber(body.me.rank);
    const entry = parseRemoteEntry(body.me.lap, trackId, vehicle, physics, filter);
    const above = finiteNumber(body.me.aboveMs);
    // Only a time faster than the player's own is the place above
    const aboveMs = entry && above !== null && above > 0 && above < entry.lapTimeMs ? above : null;
    if (entry && rank !== null && rank >= 1) me = { rank: Math.floor(rank), entry, aboveMs };
  }
  const revisions = Array.isArray(body.physics)
    ? body.physics.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1000).slice(0, 20)
    : [];
  return { entries, total: total !== null && total >= entries.length ? Math.floor(total) : entries.length, me, physics: revisions };
}

/**
 * One online board: the fastest drivers of a circuit and car (optionally only laps driven a certain way), and where
 * `name` stands on it. Null when there is no online board, or it could not be read.
 */
export async function fetchRemoteBoard(
  trackId: string,
  vehicle: VehicleModelId,
  opts: { filter?: BoardFilter; physics?: number; name?: string; event?: string; limit?: number } = {},
): Promise<RemoteBoard | null> {
  const base = onlineUrl("/laps");
  if (!base || !(await boardOnline())) return null;
  const filter = opts.filter ?? {};
  const physics = opts.physics ?? lapPhysicsVersion(vehicle);
  const count = clampLimit(opts.limit ?? DEFAULT_LIMIT);
  const query = new URLSearchParams({ track: trackId, vehicle, physics: String(physics), limit: String(count) });
  if (filter.assists) query.set("assists", filter.assists);
  if (filter.realism) query.set("realism", filter.realism);
  if (filter.surface) query.set("surface", filter.surface);
  if (opts.event) query.set("event", opts.event);
  if (opts.name) query.set("name", opts.name.slice(0, MAX_NAME_LENGTH));
  const res = await requestJson(`${base}?${query.toString()}`, { method: "GET" });
  if (!res || res.status < 200 || res.status >= 300) return null;
  return parseRemoteBoard(res.body, trackId, vehicle, physics, filter, count);
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
  };
}

/** Uploads a valid lap with its ghost (POST /api/laps), claiming the driver's name with this browser's key */
export async function submitLap(rec: LapRecording, opts: { event?: string } = {}): Promise<SubmitResult> {
  const url = onlineUrl("/laps");
  if (!url || !(await boardOnline())) return { ok: false, error: "The online board is not available right now" };
  const valid = validateLapRecording(rec);
  if (!valid) return { ok: false, error: "The lap recording is invalid" };
  // Without its assists, realism, surface and physics revision a lap can't be shown fairly
  if (!valid.conditions) return { ok: false, error: "This lap was recorded by an older version of the game" };
  // The board refuses a lap whose samples don't agree with each other; say so before uploading
  const problem = lapPlausibilityProblem(valid.data);
  if (problem) return { ok: false, error: problem };
  const body: Record<string, unknown> = { rec: toWirePayload({ ...valid, conditions: valid.conditions }), driverKey: getOrCreateDriverKey() };
  if (opts.event) body.event = opts.event;
  const res = await requestJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res) return { ok: false, error: "Could not reach the leaderboard" };
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
  return result;
}

/** Downloads an online lap's ghost (GET /api/laps/<id>) → LapRecording (validated) or null */
export async function fetchRemoteGhost(id: string): Promise<LapRecording | null> {
  const base = onlineUrl("/laps");
  if (!base || cappedString(id, MAX_ID_LENGTH) === null) return null;
  const res = await requestJson(`${base}/${encodeURIComponent(id)}`, { method: "GET" });
  if (!res || res.status !== 200) return null;
  return validateLapRecording(res.body);
}
