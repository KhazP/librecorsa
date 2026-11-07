/**
 * Shared shapes for lap recording, ghosts, the lap summary, replays and leaderboards.
 * Plain JSON-friendly data so recordings can be stored (IndexedDB), exported as files and uploaded.
 */
import type { AssistPreset, TireCompound, VehicleModelId } from "@/types/f1";
import { SIM_REALISM_LEVELS, type SimRealism } from "./sim-realism";

/**
 * Revision of the vehicle physics. Bump it whenever a physics change makes earlier lap times incomparable: laps
 * recorded under another revision then go on another leaderboard.
 */
export const PHYSICS_VERSION = 2;

/** What a lap was driven with. Laps are only ranked against laps driven under the same class (`lapBoardClass`) */
export interface LapConditions {
  /** The most-aided assist preset in force at any point of the lap */
  assists: AssistPreset;
  /** Tyre compound at the line */
  compound: TireCompound;
  /** "wet" when the racing line held standing water at any point of the lap */
  surface: "dry" | "wet";
  /** The least realistic simulation level in force at any point of the lap (Casual forgives tyre temperatures) */
  realism: SimRealism;
  /** PHYSICS_VERSION the lap was driven under */
  physicsVersion: number;
}

/** Assist presets from the least to the most aided */
export const ASSIST_PRESETS: readonly AssistPreset[] = ["pro", "semi_pro", "assisted"];
export const TYRE_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];

/**
 * Board a lap is ranked on (with its circuit and car): physics revision, assists, realism and surface, e.g.
 * "p2-pro-full-dry"
 */
export function lapBoardClass(c: LapConditions): string {
  return `p${c.physicsVersion}-${c.assists}-${c.realism}-${c.surface}`;
}

/** Validates untrusted conditions; null when absent or malformed */
export function parseLapConditions(raw: unknown): LapConditions | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!ASSIST_PRESETS.includes(r.assists as AssistPreset)) return null;
  if (!TYRE_COMPOUNDS.includes(r.compound as TireCompound)) return null;
  if (r.surface !== "dry" && r.surface !== "wet") return null;
  if (!SIM_REALISM_LEVELS.includes(r.realism as SimRealism)) return null;
  const v = r.physicsVersion;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) return null;
  return { assists: r.assists as AssistPreset, compound: r.compound as TireCompound, surface: r.surface, realism: r.realism as SimRealism, physicsVersion: v };
}

/** Fields of one recorded sample, in order; a recording stores samples flattened with this stride */
export const LAP_SAMPLE_FIELDS = [
  "t", // time since the lap started (s)
  "s", // track distance (m)
  "x",
  "y",
  "z", // world position (m)
  "qx",
  "qy",
  "qz",
  "qw", // world orientation quaternion
  "speedKmh",
  "throttle", // 0..1
  "brake", // 0..1
  "steer", // -1..1, + = right
  "gear",
] as const;
export const LAP_SAMPLE_STRIDE = LAP_SAMPLE_FIELDS.length;

export interface LapSample {
  t: number;
  s: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  speedKmh: number;
  throttle: number;
  brake: number;
  steer: number;
  gear: number;
}

/** One complete lap: enough to replay it as a ghost and to check it on a leaderboard */
export interface LapRecording {
  version: 1;
  trackId: string;
  vehicle: VehicleModelId;
  driverName: string;
  driverCode: string;
  lapTimeMs: number;
  sectorTimesMs: [number, number, number];
  /** Epoch milliseconds */
  recordedAt: number;
  /** Samples per second */
  sampleHz: number;
  /** Flattened samples, LAP_SAMPLE_STRIDE numbers each, in LAP_SAMPLE_FIELDS order */
  data: number[];
  /** Assists, tyre, surface and physics revision; absent on laps recorded before they were kept */
  conditions?: LapConditions;
  /**
   * Fingerprint of the circuit geometry the lap was driven on (`trackGeometryKey`) and its lap length (m), so a ghost
   * from another version of the circuit can be moved onto this one (`alignGhostToTrack`); absent on older laps.
   * Kept locally: the leaderboard's wire form leaves them out
   */
  trackGeometry?: string;
  trackLengthM?: number;
}

/** A corner of the lap: the lowest speed through it, and the best seen on earlier laps */
export interface CornerStat {
  turnNumber: number;
  name: string;
  minSpeedKmh: number;
  /** Best (highest) minimum speed on an earlier lap of this session; null on the first lap */
  bestMinSpeedKmh: number | null;
}

/** Shown on the lap summary card after a lap */
export interface LapSummaryData {
  lapNumber: number;
  lapTimeMs: number;
  /** False when the lap left the track limits */
  valid: boolean;
  /** The racing-line autopilot drove at some point: the card shows it, but it is never a best, a ghost or uploaded */
  autopilot: boolean;
  /** Against the personal best before this lap (ms, negative = faster); null without one */
  deltaToBestMs: number | null;
  isPersonalBest: boolean;
  sectorTimesMs: [number, number, number];
  /** Session-best sectors before this lap (null when not yet set) */
  bestSectorTimesMs: [number | null, number | null, number | null];
  /** Sum of the best sectors, this lap included; null until all three exist */
  theoreticalBestMs: number | null;
  topSpeedKmh: number;
  avgSpeedKmh: number;
  /** Share of the lap at > 98 % throttle / on the brakes (> 5 %), 0..100 */
  fullThrottlePct: number;
  brakingPct: number;
  corners: CornerStat[];
}

export interface LeaderboardEntry {
  name: string;
  code: string;
  lapTimeMs: number;
  sectorTimesMs: [number, number, number];
  vehicle: VehicleModelId;
  trackId: string;
  recordedAt: number;
  source: "local" | "remote";
  conditions?: LapConditions;
  /** Remote entries can carry an id to download their ghost */
  id?: string;
}

/** One car's pose in a replay frame */
export interface ReplayCarState {
  id: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  speedKmh: number;
  steer: number;
  throttle: number;
  brake: number;
  gear: number;
  rpm: number;
  /** Optional extended kinematic state for Instant Flashback resume */
  s?: number;
  vyMs?: number;
  yawRateRadS?: number;
}

export interface ReplayFrame {
  /** Session time (s) */
  t: number;
  cars: ReplayCarState[];
}
