/**
 * Shared shapes for lap recording, ghosts, the lap summary, replays and leaderboards.
 * Plain JSON-friendly data so recordings can be stored (IndexedDB), exported as files and uploaded.
 */
import type { VehicleModelId } from "@/types/f1";

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
