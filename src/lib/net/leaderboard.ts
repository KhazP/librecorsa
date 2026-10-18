/**
 * Lap leaderboards: a local board built from personal bests in ghost-store, and an optional remote board.
 * The remote board is either a Supabase project running scripts/leaderboard-supabase/schema.sql
 * (NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY) or the reference Worker in
 * scripts/leaderboard-worker (NEXT_PUBLIC_LEADERBOARD_URL). Both take the same LapRecording and answer in
 * the same shapes. Only the LapRecording itself is ever sent; remote responses are validated before use.
 */
import type { VehicleModelId } from "@/types/f1";
import { listBestLaps } from "@/lib/sim/ghost-store";
import { validateLapRecording } from "@/lib/sim/lap-recorder";
import type { LapRecording, LeaderboardEntry } from "@/lib/sim/lap-types";
import { getOrCreateDriverKey } from "./driver-key";

const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 64;
const MAX_CODE_LENGTH = 16;
const MAX_TRACK_ID_LENGTH = 64;
const MAX_ERROR_LENGTH = 200;

/** Typed as a Record over VehicleModelId so adding a car fails to compile until it is listed here */
const VEHICLE_IDS: Record<VehicleModelId, true> = {
  vf26: true,
  "f12026-car": true,
  "amg-gt3": true,
};

/** A configured http(s) base URL without its trailing slash, or null */
function baseUrl(raw: string | undefined): string | null {
  const url = raw?.trim() ?? "";
  return /^https?:\/\//.test(url) ? url.replace(/\/+$/, "") : null;
}

/** Where the remote board lives: a Supabase project (preferred when both are set) or a Worker */
type RemoteBackend = { kind: "supabase"; url: string; key: string } | { kind: "worker"; url: string };

const supabaseUrl = baseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const workerUrl = baseUrl(process.env.NEXT_PUBLIC_LEADERBOARD_URL);

const remote: RemoteBackend | null =
  supabaseUrl && supabaseKey
    ? { kind: "supabase", url: `${supabaseUrl}/rest/v1/rpc`, key: supabaseKey }
    : workerUrl
      ? { kind: "worker", url: workerUrl }
      : null;

/** True when an online leaderboard is configured */
export const remoteLeaderboardEnabled = remote !== null;

/** Headers for a request to the remote board (Supabase needs its publishable key on every call) */
function remoteHeaders(json: boolean): Record<string, string> {
  const headers: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
  if (remote?.kind === "supabase") {
    headers.apikey = remote.key;
    // Legacy JWT anon keys also go in Authorization; the newer sb_publishable_ keys only in apikey
    if (!remote.key.startsWith("sb_")) headers.Authorization = `Bearer ${remote.key}`;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVehicleId(value: unknown): value is VehicleModelId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(VEHICLE_IDS, value);
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
  if (id !== undefined) entry.id = id;
  return entry;
}

/** Local personal bests for this circuit (all cars, or one car), fastest first */
export async function localLeaderboard(trackId: string, vehicle?: VehicleModelId): Promise<LeaderboardEntry[]> {
  const laps = await listBestLaps();
  return laps
    .filter((lap) => lap.trackId === trackId && (vehicle === undefined || lap.vehicle === vehicle))
    .map((lap) => lapToEntry(lap, "local"))
    .sort((a, b) => a.lapTimeMs - b.lapTimeMs);
}

/** Validates one remote board row; null when any field is missing or malformed */
function parseRemoteEntry(raw: unknown, trackId: string, vehicle: VehicleModelId): LeaderboardEntry | null {
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
  if (entryTrack !== trackId || raw.vehicle !== vehicle || !isVehicleId(raw.vehicle)) return null;
  if (raw.id !== undefined && cappedString(raw.id, MAX_ID_LENGTH) === null) return null;

  const entry: LeaderboardEntry = {
    name,
    code,
    lapTimeMs,
    sectorTimesMs: [s0, s1, s2],
    vehicle,
    trackId: entryTrack,
    recordedAt,
    source: "remote",
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
      mode: "cors",
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Remote top laps; [] when no URL is configured or on any network / parse error */
export async function fetchRemoteLeaderboard(
  trackId: string,
  vehicle: VehicleModelId,
  limit: number = DEFAULT_LIMIT,
): Promise<LeaderboardEntry[]> {
  if (!remote) return [];
  const count = clampLimit(limit);
  const query = `track=${encodeURIComponent(trackId)}&vehicle=${encodeURIComponent(vehicle)}`;
  const url =
    remote.kind === "supabase"
      ? `${remote.url}/leaderboard?${query}&lim=${count}`
      : `${remote.url}/laps?${query}&limit=${count}`;
  const res = await requestJson(url, { method: "GET", headers: remoteHeaders(false) });
  if (!res || res.status < 200 || res.status >= 300 || !isRecord(res.body)) return [];
  const rows = res.body.laps;
  if (!Array.isArray(rows)) return [];
  const entries: LeaderboardEntry[] = [];
  for (const row of rows.slice(0, count)) {
    const entry = parseRemoteEntry(row, trackId, vehicle);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.lapTimeMs - b.lapTimeMs);
}

/** The wire form of a lap: exactly the LapRecording fields and nothing else */
function toWirePayload(rec: LapRecording): LapRecording {
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
  };
}

/** Uploads a valid lap with its ghost (Worker: POST /laps, Supabase: rpc/submit_lap). Resolves { ok, rank?, error? } */
export async function submitLap(rec: LapRecording): Promise<{ ok: boolean; rank?: number; error?: string }> {
  if (!remote) return { ok: false, error: "No online leaderboard is configured" };
  const valid = validateLapRecording(rec);
  if (!valid) return { ok: false, error: "The lap recording is invalid" };
  const payload = toWirePayload(valid);
  const res = await requestJson(remote.kind === "supabase" ? `${remote.url}/submit_lap` : `${remote.url}/laps`, {
    method: "POST",
    headers: remoteHeaders(true),
    // Supabase claims the driver's name with this browser's key; the Worker has no name claims
    body: JSON.stringify(remote.kind === "supabase" ? { rec: payload, driver_key: getOrCreateDriverKey() } : payload),
  });
  if (!res) return { ok: false, error: "Could not reach the leaderboard" };
  const body: Record<string, unknown> = isRecord(res.body) ? res.body : {};
  if (res.status >= 200 && res.status < 300 && body.ok === true) {
    const rank = finiteNumber(body.rank);
    return rank === null ? { ok: true } : { ok: true, rank };
  }
  const message = cappedString(body.error, MAX_ERROR_LENGTH);
  return { ok: false, error: message ?? `Leaderboard rejected the lap (HTTP ${res.status})` };
}

/** Downloads a remote lap's ghost (Worker: GET /laps/<id>, Supabase: rpc/get_lap) → LapRecording (validated) or null */
export async function fetchRemoteGhost(id: string): Promise<LapRecording | null> {
  if (!remote || cappedString(id, MAX_ID_LENGTH) === null) return null;
  const url =
    remote.kind === "supabase"
      ? `${remote.url}/get_lap?lap_id=${encodeURIComponent(id)}`
      : `${remote.url}/laps/${encodeURIComponent(id)}`;
  const res = await requestJson(url, { method: "GET", headers: remoteHeaders(false) });
  if (!res || res.status !== 200) return null;
  return validateLapRecording(res.body);
}
