import type { VehicleModelId } from "@/types/f1";

export type RaceKind = "practice" | "ai" | "mp";

export const REPLAY_FORMAT_VERSION = 1;
export const REPLAY_FILE_EXTENSION = ".lcr";
export const REPLAY_MAGIC = "LCR1";

/** Maximum accepted .lcr file size on import (64 MB) */
export const MAX_REPLAY_IMPORT_BYTES = 64 * 1024 * 1024;
/** Maximum accepted frame count on import (~83 min at 20 Hz) */
export const MAX_REPLAY_FRAMES = 100_000;
/** Maximum accepted participant count */
export const MAX_REPLAY_PARTICIPANTS = 64;

export interface ReplayParticipant {
  id: string;
  label: string;
  name?: string;
  color: string;
  isPlayer: boolean;
  vehicle?: VehicleModelId | string;
  position?: number;
  dnf?: boolean;
  bestLapMs?: number | null;
  totalTimeMs?: number | null;
  penaltyS?: number;
}

export type ReplayEventKind =
  | "lap_start"
  | "lap_finish"
  | "personal_best"
  | "fastest_lap"
  | "overtake"
  | "collision"
  | "dnf"
  | "penalty"
  | "yellow"
  | "vsc";

export interface ReplayEvent {
  id: string;
  kind: ReplayEventKind;
  timeS: number;
  carId?: string;
  otherCarId?: string;
  lap?: number;
  detail?: string;
}

export interface ReplayBookmark {
  id: string;
  timeS: number;
  label: string;
  createdAt: number;
}

export interface ReplaySegment {
  inS: number | null;
  outS: number | null;
}

export interface ReplayWeatherSnapshot {
  condition: string;
  trackWetness?: number;
  rainIntensity?: number;
  ambientTempC?: number;
  trackTempC?: number;
}

export interface ReplayMetadata {
  id: string;
  name: string;
  recordedAt: number;
  trackId: string;
  trackName: string;
  layoutId?: string;
  vehicle: VehicleModelId | string;
  vehicleClass: string;
  raceKind: RaceKind;
  durationS: number;
  frameCount: number;
  hz: number;
  participantCount: number;
  participants: ReplayParticipant[];
  weather: ReplayWeatherSnapshot;
  physicsVersion: number;
  lapPhysicsVersion: number;
  /** Optional SVG polyline preview points in normalized [0..1] coordinates */
  trackPreview?: Array<[number, number]>;
}

export interface SerializedReplayFrames {
  hz: number;
  carIds: string[];
  /** Monotonic timestamps in seconds (length = frameCount) */
  times: Float64Array;
  /** Packed Float32 array of length frameCount * carIds.length * 16 */
  data: Float32Array;
}

export interface ReplayRecordingPayload {
  metadata: ReplayMetadata;
  frames: SerializedReplayFrames;
  events: ReplayEvent[];
  bookmarks: ReplayBookmark[];
}

export interface StoredReplaySummary {
  id: string;
  name: string;
  recordedAt: number;
  trackId: string;
  trackName: string;
  layoutId?: string;
  vehicle: string;
  vehicleClass: string;
  raceKind: RaceKind;
  durationS: number;
  frameCount: number;
  participantCount: number;
  physicsVersion: number;
  lapPhysicsVersion: number;
  weatherCondition: string;
  trackPreview?: Array<[number, number]>;
  eventCount: number;
  bookmarkCount: number;
  byteSize: number;
}

export interface ReplayCompatibility {
  trackKnown: boolean;
  vehicleKnown: boolean;
  physicsMatch: boolean;
  warnings: string[];
}
