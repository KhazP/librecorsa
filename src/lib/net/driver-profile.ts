/**
 * Reading a driver's cross-circuit profile (cloudflare/api/profile.ts): their best current-revision open-board lap per
 * (circuit, car), board position and size on each, circuit/board counts, and Bayesian-shrunk percentile rating.
 * Kept free of the simulator so the home page and in-game panels can both use it. Every answer is validated before use;
 * malformed or unreachable answers read as null.
 */
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { parseLapConditions, type LapConditions } from "@/lib/sim/lap-types";
import { cappedString, driverNameKey, finiteNumber, requestJson } from "./board-client";
import { getOnlineConfig, onlineUrl } from "./online-config";

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_CODE_LENGTH = 16;
const MAX_TRACK_ID_LENGTH = 64;
const MAX_COUNT = 1_000_000;
const MAX_PROFILE_LAPS = 1000;

export interface DriverProfileLap {
  id: string;
  trackId: string;
  vehicle: VehicleModelId;
  lapTimeMs: number;
  sectorTimesMs: [number, number, number];
  recordedAt: number;
  /** 1-based place in the board's order */
  position: number;
  /** Distinct drivers on this (circuit, car) board */
  boardSize: number;
  conditions: LapConditions;
}

export interface DriverProfile {
  ok: true;
  name: string;
  nameKey: string;
  code: string | null;
  /** Bayesian average percentile across circuits (0–100, 1 decimal), or null when circuitsDriven === 0 */
  rating: number | null;
  circuitsDriven: number;
  boardsEntered: number;
  laps: DriverProfileLap[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wholeCount = (v: unknown): number | null => {
  const n = finiteNumber(v);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT ? n : null;
};

/** Midpoint percentile in (0, 100) for one board entry (matches cloudflare/api/profile.ts `boardPercentile`) */
export function lapBoardPercentile(position: number, boardSize: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(boardSize) || boardSize < 1) return 50;
  const clamped = Math.min(boardSize, Math.max(1, position));
  return (100 * (boardSize - clamped + 0.5)) / boardSize;
}

function parseProfileLap(raw: unknown): DriverProfileLap | null {
  if (!isRecord(raw)) return null;
  const id = cappedString(raw.id, MAX_ID_LENGTH);
  const trackId = cappedString(raw.trackId, MAX_TRACK_ID_LENGTH);
  if (!id || !trackId || !isVehicleModelId(raw.vehicle)) return null;
  const lapTimeMs = finiteNumber(raw.lapTimeMs);
  const recordedAt = finiteNumber(raw.recordedAt);
  const sectors = Array.isArray(raw.sectorTimesMs) ? raw.sectorTimesMs : null;
  if (!sectors || sectors.length !== 3) return null;
  const s0 = finiteNumber(sectors[0]);
  const s1 = finiteNumber(sectors[1]);
  const s2 = finiteNumber(sectors[2]);
  if (lapTimeMs === null || lapTimeMs <= 0 || recordedAt === null) return null;
  if (s0 === null || s1 === null || s2 === null || s0 < 0 || s1 < 0 || s2 < 0) return null;
  const position = wholeCount(raw.position);
  const boardSize = wholeCount(raw.boardSize);
  if (position === null || boardSize === null || position < 1 || boardSize < position) return null;
  const conditions = parseLapConditions(raw.conditions);
  if (!conditions) return null;
  return {
    id,
    trackId,
    vehicle: raw.vehicle,
    lapTimeMs,
    sectorTimesMs: [s0, s1, s2],
    recordedAt,
    position,
    boardSize,
    conditions,
  };
}

/** Validates an answer of GET /api/drivers/profile; returns null when malformed */
export function parseDriverProfile(body: unknown): DriverProfile | null {
  if (!isRecord(body) || body.ok !== true || !Array.isArray(body.laps)) return null;
  const name = cappedString(body.name, MAX_NAME_LENGTH);
  const nameKey = cappedString(body.nameKey, MAX_NAME_LENGTH);
  if (!name || !nameKey) return null;
  const code = body.code === null || body.code === undefined ? null : cappedString(body.code, MAX_CODE_LENGTH);
  if (body.code !== null && body.code !== undefined && code === null) return null;

  let rating: number | null;
  if (body.rating === null) {
    rating = null;
  } else {
    const r = finiteNumber(body.rating);
    if (r === null || r < 0 || r > 100) return null;
    rating = r;
  }

  const circuitsDriven = wholeCount(body.circuitsDriven);
  const boardsEntered = wholeCount(body.boardsEntered);
  if (circuitsDriven === null || boardsEntered === null) return null;

  const laps: DriverProfileLap[] = [];
  for (const row of body.laps.slice(0, MAX_PROFILE_LAPS)) {
    const lap = parseProfileLap(row);
    if (lap) laps.push(lap);
  }
  const distinctCircuits = new Set(laps.map((l) => l.trackId)).size;
  return {
    ok: true,
    name,
    nameKey,
    code,
    rating: laps.length === 0 && boardsEntered === 0 ? null : rating,
    circuitsDriven: Math.max(circuitsDriven, distinctCircuits),
    boardsEntered: Math.max(boardsEntered, laps.length),
    laps,
  };
}

/**
 * Fetches GET /api/drivers/profile?name= for a driver. Uses the canonical name key in the query string so edge and
 * browser caches share one entry regardless of casing. Returns null when the online boards are off or the request fails.
 */
export async function fetchDriverProfile(
  name: string,
  opts: {
    /** Skip the browser HTTP cache (used for explicit refreshes) */
    fresh?: boolean;
    /** Stand-in network call for headless verification */
    fetchJson?: (url: string) => Promise<{ status: number; body: unknown } | null>;
  } = {},
): Promise<DriverProfile | null> {
  const key = driverNameKey(name);
  if (!key || key.length > MAX_NAME_LENGTH) return null;
  const base = onlineUrl("/drivers/profile");
  if (!opts.fetchJson && (!base || !(await getOnlineConfig()).board)) return null;
  const url = `${base ?? "/api/drivers/profile"}?${new URLSearchParams({ name: key }).toString()}`;
  const read = opts.fetchJson ?? ((target: string) => requestJson(target, { method: "GET" }, !opts.fresh));
  const res = await read(url).catch(() => null);
  if (!res || res.status !== 200) return null;
  return parseDriverProfile(res.body);
}
