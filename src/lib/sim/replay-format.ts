import { isVehicleModelId } from "@/types/f1";
import type { RaceKind } from "./replay-types";
import { PHYSICS_VERSION } from "./lap-types";
import { getTrackInfo } from "@/lib/track-registry";
import {
  MAX_REPLAY_FRAMES,
  MAX_REPLAY_IMPORT_BYTES,
  MAX_REPLAY_PARTICIPANTS,
  REPLAY_FORMAT_VERSION,
  REPLAY_MAGIC,
  type ReplayBookmark,
  type ReplayCompatibility,
  type ReplayEvent,
  type ReplayEventKind,
  type ReplayMetadata,
  type ReplayParticipant,
  type ReplayRecordingPayload,
} from "./replay-types";

const HEADER_FLAG_GZIP = 1;
const CAR_STRIDE = 16;

const VALID_RACE_KINDS = new Set<RaceKind>(["practice", "ai", "mp"]);
const VALID_EVENT_KINDS = new Set<ReplayEventKind>([
  "lap_start",
  "lap_finish",
  "personal_best",
  "fastest_lap",
  "overtake",
  "collision",
  "dnf",
  "penalty",
  "yellow",
  "vsc",
]);

export class ReplayFormatError extends Error {
  constructor(
    public readonly code:
      | "oversized"
      | "invalid_magic"
      | "unsupported_version"
      | "corrupt"
      | "invalid_frames"
      | "too_many_frames"
      | "too_many_participants",
    message: string
  ) {
    super(message);
    this.name = "ReplayFormatError";
  }
}

interface LcrJsonHeader {
  formatVersion: number;
  metadata: ReplayMetadata;
  carIds: string[];
  frameCount: number;
  hz: number;
  events: ReplayEvent[];
  bookmarks: ReplayBookmark[];
}

async function compressBytes(raw: Uint8Array): Promise<{ bytes: Uint8Array; compressed: boolean }> {
  if (typeof CompressionStream !== "undefined") {
    try {
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream("gzip"));
      const buf = await new Response(stream).arrayBuffer();
      return { bytes: new Uint8Array(buf), compressed: true };
    } catch {
      // Fall through to uncompressed
    }
  }
  return { bytes: raw, compressed: false };
}

async function decompressBytes(raw: Uint8Array, compressed: boolean): Promise<Uint8Array> {
  if (!compressed) return raw;
  if (typeof DecompressionStream !== "undefined") {
    const copy = new Uint8Array(raw.byteLength);
    copy.set(raw);
    const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("gzip"));
    const buf = await new Response(stream).arrayBuffer();
    if (buf.byteLength > MAX_REPLAY_IMPORT_BYTES * 4) {
      throw new ReplayFormatError("oversized", "Decompressed replay payload exceeds maximum allowed size.");
    }
    return new Uint8Array(buf);
  }
  throw new ReplayFormatError("corrupt", "Browser DecompressionStream is unavailable for compressed .lcr replay.");
}

/**
 * Encodes a complete replay recording into the portable `.lcr` binary format:
 * `[4B "LCR1"][2B uint16LE version][2B uint16LE flags][4B uint32LE headerByteLen][header UTF-8 JSON][payload (gzipped or raw): Float64 times + Float32 frame data]`
 */
export async function encodeLcrReplay(payload: ReplayRecordingPayload): Promise<Uint8Array> {
  const { metadata, frames, events, bookmarks } = payload;
  if (frames.times.length > MAX_REPLAY_FRAMES) {
    throw new ReplayFormatError("too_many_frames", `Replay exceeds maximum frame count (${MAX_REPLAY_FRAMES}).`);
  }
  if (frames.carIds.length > MAX_REPLAY_PARTICIPANTS) {
    throw new ReplayFormatError("too_many_participants", `Replay exceeds maximum participant count (${MAX_REPLAY_PARTICIPANTS}).`);
  }

  const headerObj: LcrJsonHeader = {
    formatVersion: REPLAY_FORMAT_VERSION,
    metadata,
    carIds: frames.carIds,
    frameCount: frames.times.length,
    hz: frames.hz,
    events,
    bookmarks,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));

  const timesBytes = new Uint8Array(frames.times.buffer, frames.times.byteOffset, frames.times.byteLength);
  const dataBytes = new Uint8Array(frames.data.buffer, frames.data.byteOffset, frames.data.byteLength);
  const rawBody = new Uint8Array(timesBytes.byteLength + dataBytes.byteLength);
  rawBody.set(timesBytes, 0);
  rawBody.set(dataBytes, timesBytes.byteLength);

  const { bytes: bodyBytes, compressed } = await compressBytes(rawBody);
  const totalLen = 12 + headerBytes.byteLength + bodyBytes.byteLength;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  for (let i = 0; i < 4; i++) out[i] = REPLAY_MAGIC.charCodeAt(i);
  view.setUint16(4, REPLAY_FORMAT_VERSION, true);
  view.setUint16(6, compressed ? HEADER_FLAG_GZIP : 0, true);
  view.setUint32(8, headerBytes.byteLength, true);
  out.set(headerBytes, 12);
  out.set(bodyBytes, 12 + headerBytes.byteLength);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function sanitizeString(v: unknown, maxLen: number, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.slice(0, maxLen).trim();
}

function validateParticipants(raw: unknown): ReplayParticipant[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_REPLAY_PARTICIPANTS) {
    throw new ReplayFormatError("too_many_participants", "Too many participants in replay file.");
  }
  const out: ReplayParticipant[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const id = sanitizeString(item.id, 64);
    if (!id) continue;
    out.push({
      id,
      label: sanitizeString(item.label, 16, id.slice(0, 3).toUpperCase()),
      ...(typeof item.name === "string" ? { name: sanitizeString(item.name, 64) } : {}),
      color: sanitizeString(item.color, 32, "#9ca3af"),
      isPlayer: Boolean(item.isPlayer),
      ...(typeof item.vehicle === "string" ? { vehicle: sanitizeString(item.vehicle, 64) } : {}),
      ...(typeof item.position === "number" && Number.isFinite(item.position) ? { position: Math.round(item.position) } : {}),
      ...(typeof item.dnf === "boolean" ? { dnf: item.dnf } : {}),
      ...(typeof item.bestLapMs === "number" && Number.isFinite(item.bestLapMs) ? { bestLapMs: item.bestLapMs } : {}),
      ...(typeof item.totalTimeMs === "number" && Number.isFinite(item.totalTimeMs) ? { totalTimeMs: item.totalTimeMs } : {}),
      ...(typeof item.penaltyS === "number" && Number.isFinite(item.penaltyS) ? { penaltyS: item.penaltyS } : {}),
    });
  }
  return out;
}

function validateEvents(raw: unknown): ReplayEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplayEvent[] = [];
  for (let i = 0; i < Math.min(raw.length, 5000); i++) {
    const item = raw[i];
    if (!isPlainObject(item)) continue;
    const kind = item.kind as ReplayEventKind;
    if (!VALID_EVENT_KINDS.has(kind)) continue;
    if (typeof item.timeS !== "number" || !Number.isFinite(item.timeS)) continue;
    out.push({
      id: sanitizeString(item.id, 80, `ev-${i}`),
      kind,
      timeS: item.timeS,
      ...(typeof item.carId === "string" ? { carId: sanitizeString(item.carId, 64) } : {}),
      ...(typeof item.otherCarId === "string" ? { otherCarId: sanitizeString(item.otherCarId, 64) } : {}),
      ...(typeof item.lap === "number" && Number.isFinite(item.lap) ? { lap: Math.round(item.lap) } : {}),
      ...(typeof item.detail === "string" ? { detail: sanitizeString(item.detail, 64) } : {}),
    });
  }
  return out;
}

function validateBookmarks(raw: unknown): ReplayBookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplayBookmark[] = [];
  for (let i = 0; i < Math.min(raw.length, 500); i++) {
    const item = raw[i];
    if (!isPlainObject(item)) continue;
    if (typeof item.timeS !== "number" || !Number.isFinite(item.timeS)) continue;
    out.push({
      id: sanitizeString(item.id, 64, `bm-${i}`),
      timeS: item.timeS,
      label: sanitizeString(item.label, 80, "Bookmark"),
      createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    });
  }
  return out;
}

/**
 * Decodes and strictly validates a `.lcr` replay file.
 * Rejects oversized files, bad magic, unsupported format versions, malformed headers,
 * non-finite numbers, and unreasonable frame/participant counts.
 */
export async function decodeLcrReplay(input: ArrayBuffer | Uint8Array): Promise<ReplayRecordingPayload> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_REPLAY_IMPORT_BYTES) {
    throw new ReplayFormatError("oversized", `Replay file exceeds maximum size (${MAX_REPLAY_IMPORT_BYTES} bytes).`);
  }
  if (bytes.byteLength < 12) {
    throw new ReplayFormatError("corrupt", "Replay file is truncated.");
  }

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== REPLAY_MAGIC) {
    throw new ReplayFormatError("invalid_magic", "Not a valid .lcr replay file.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== REPLAY_FORMAT_VERSION) {
    throw new ReplayFormatError("unsupported_version", `Unsupported .lcr replay version: ${version}.`);
  }
  const flags = view.getUint16(6, true);
  const headerLen = view.getUint32(8, true);
  if (headerLen < 2 || 12 + headerLen > bytes.byteLength || headerLen > 4 * 1024 * 1024) {
    throw new ReplayFormatError("corrupt", "Invalid replay header length.");
  }

  let parsed: unknown;
  try {
    const headerJson = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(12, 12 + headerLen));
    parsed = JSON.parse(headerJson);
  } catch {
    throw new ReplayFormatError("corrupt", "Malformed replay JSON header.");
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.metadata)) {
    throw new ReplayFormatError("corrupt", "Replay header is missing metadata.");
  }

  const frameCount = parsed.frameCount;
  const hz = parsed.hz;
  const carIds = parsed.carIds;
  if (
    typeof frameCount !== "number" ||
    !Number.isInteger(frameCount) ||
    frameCount < 1 ||
    frameCount > MAX_REPLAY_FRAMES
  ) {
    throw new ReplayFormatError("too_many_frames", "Invalid or excessive frame count in replay.");
  }
  if (typeof hz !== "number" || !Number.isFinite(hz) || hz < 1 || hz > 240) {
    throw new ReplayFormatError("corrupt", "Invalid sample rate in replay.");
  }
  if (!Array.isArray(carIds) || carIds.length < 1 || carIds.length > MAX_REPLAY_PARTICIPANTS) {
    throw new ReplayFormatError("too_many_participants", "Invalid participant list in replay.");
  }
  const cleanCarIds = carIds.map((id) => sanitizeString(id, 64)).filter(Boolean);
  if (cleanCarIds.length !== carIds.length) {
    throw new ReplayFormatError("corrupt", "Invalid car ID in replay.");
  }

  const compressed = (flags & HEADER_FLAG_GZIP) !== 0;
  const rawBody = await decompressBytes(bytes.subarray(12 + headerLen), compressed);

  const expectedTimesBytes = frameCount * 8;
  const expectedDataFloats = frameCount * cleanCarIds.length * CAR_STRIDE;
  const expectedDataBytes = expectedDataFloats * 4;
  if (rawBody.byteLength !== expectedTimesBytes + expectedDataBytes) {
    throw new ReplayFormatError("invalid_frames", "Replay binary frame payload size mismatch.");
  }

  // Copy into aligned buffers so typed array views never fail alignment checks
  const timesBuf = new ArrayBuffer(expectedTimesBytes);
  new Uint8Array(timesBuf).set(rawBody.subarray(0, expectedTimesBytes));
  const times = new Float64Array(timesBuf);

  const dataBuf = new ArrayBuffer(expectedDataBytes);
  new Uint8Array(dataBuf).set(rawBody.subarray(expectedTimesBytes));
  const data = new Float32Array(dataBuf);

  // Validate timestamps are finite & monotonic, and validate pose numbers for present cars
  let prevT = -Infinity;
  for (let i = 0; i < frameCount; i++) {
    const t = times[i];
    if (!Number.isFinite(t) || t < prevT) {
      throw new ReplayFormatError("invalid_frames", `Invalid or non-monotonic timestamp at frame ${i}.`);
    }
    prevT = t;
    const frameBase = i * cleanCarIds.length * CAR_STRIDE;
    for (let c = 0; c < cleanCarIds.length; c++) {
      const o = frameBase + c * CAR_STRIDE;
      const x = data[o];
      if (Number.isNaN(x)) continue; // Car absent in this frame
      // Pose + speed + rpm must be finite (no Infinity or NaN in active car pose)
      for (let k = 0; k <= 12; k++) {
        if (!Number.isFinite(data[o + k])) {
          throw new ReplayFormatError("invalid_frames", `Non-finite telemetry value at frame ${i}, car ${c}.`);
        }
      }
    }
  }

  const rawMeta = parsed.metadata;
  const raceKind = VALID_RACE_KINDS.has(rawMeta.raceKind as RaceKind) ? (rawMeta.raceKind as RaceKind) : "practice";
  const weatherObj = isPlainObject(rawMeta.weather) ? rawMeta.weather : {};
  const preview = Array.isArray(rawMeta.trackPreview)
    ? rawMeta.trackPreview
        .filter((pt): pt is [number, number] => Array.isArray(pt) && pt.length === 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
        .slice(0, 400)
    : undefined;

  const metadata: ReplayMetadata = {
    id: sanitizeString(rawMeta.id, 64) || `replay-${Date.now()}`,
    name: sanitizeString(rawMeta.name, 120) || "Imported Replay",
    recordedAt: typeof rawMeta.recordedAt === "number" && Number.isFinite(rawMeta.recordedAt) ? rawMeta.recordedAt : Date.now(),
    trackId: sanitizeString(rawMeta.trackId, 64) || "unknown",
    trackName: sanitizeString(rawMeta.trackName, 120) || sanitizeString(rawMeta.trackId, 64) || "Unknown Circuit",
    ...(typeof rawMeta.layoutId === "string" ? { layoutId: sanitizeString(rawMeta.layoutId, 64) } : {}),
    vehicle: sanitizeString(rawMeta.vehicle, 64) || "lc26",
    vehicleClass: sanitizeString(rawMeta.vehicleClass, 64) || "open-wheel",
    raceKind,
    durationS: times[frameCount - 1] - times[0],
    frameCount,
    hz,
    participantCount: cleanCarIds.length,
    participants: validateParticipants(rawMeta.participants),
    weather: {
      condition: sanitizeString(weatherObj.condition, 64) || "clear",
      ...(typeof weatherObj.trackWetness === "number" && Number.isFinite(weatherObj.trackWetness) ? { trackWetness: weatherObj.trackWetness } : {}),
      ...(typeof weatherObj.rainIntensity === "number" && Number.isFinite(weatherObj.rainIntensity) ? { rainIntensity: weatherObj.rainIntensity } : {}),
      ...(typeof weatherObj.ambientTempC === "number" && Number.isFinite(weatherObj.ambientTempC) ? { ambientTempC: weatherObj.ambientTempC } : {}),
      ...(typeof weatherObj.trackTempC === "number" && Number.isFinite(weatherObj.trackTempC) ? { trackTempC: weatherObj.trackTempC } : {}),
    },
    physicsVersion: typeof rawMeta.physicsVersion === "number" && Number.isFinite(rawMeta.physicsVersion) ? rawMeta.physicsVersion : PHYSICS_VERSION,
    lapPhysicsVersion: typeof rawMeta.lapPhysicsVersion === "number" && Number.isFinite(rawMeta.lapPhysicsVersion) ? rawMeta.lapPhysicsVersion : PHYSICS_VERSION,
    ...(preview && preview.length >= 2 ? { trackPreview: preview } : {}),
  };

  return {
    metadata,
    frames: { hz, carIds: cleanCarIds, times, data },
    events: validateEvents(parsed.events),
    bookmarks: validateBookmarks(parsed.bookmarks),
  };
}

/** Evaluates whether a replay's track, car and physics version match the local build */
export function checkReplayCompatibility(meta: Pick<ReplayMetadata, "trackId" | "vehicle" | "physicsVersion">): ReplayCompatibility {
  const warnings: string[] = [];
  const trackKnown = getTrackInfo(meta.trackId).id === meta.trackId;
  if (!trackKnown) warnings.push(`Unknown circuit "${meta.trackId}" — playback will degrade to current circuit.`);
  const vehicleKnown = isVehicleModelId(meta.vehicle);
  if (!vehicleKnown) warnings.push(`Unknown vehicle "${meta.vehicle}" — fallback vehicle model will be used.`);
  const physicsMatch = meta.physicsVersion === PHYSICS_VERSION;
  if (!physicsMatch) warnings.push(`Recorded under physics v${meta.physicsVersion} (current v${PHYSICS_VERSION}).`);
  return { trackKnown, vehicleKnown, physicsMatch, warnings };
}
