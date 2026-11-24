/**
 * Shared shapes for lap recording, ghosts, the lap summary, replays and leaderboards.
 * Plain JSON-friendly data so recordings can be stored (IndexedDB), exported as files and uploaded.
 */
import type { AssistPreset, TireCompound, VehicleModelId } from "@/types/f1";
import type { SharedCarSetup } from "./setup-share";
import { lc26OnRigidBody } from "@/lib/cars/lc26-engine";
import { SIM_REALISM_LEVELS, type SimRealism } from "./sim-realism";
import { USAGE_EXTRAS } from "@/lib/net/usage-modes";
import { CIRCUIT_BOARD_RESETS, type CircuitBoardReset } from "@/lib/circuit-board-resets";

/** What a lap can be driven with: the same four kinds the usage report counts */
export const LAP_INPUTS = USAGE_EXTRAS.input;
export type LapInput = (typeof LAP_INPUTS)[number];
export const isLapInput = (value: unknown): value is LapInput => (LAP_INPUTS as readonly unknown[]).includes(value);

/**
 * What drives the car this frame, for the icon beside the driver's name on the boards (a lap keeps the one used most).
 * Only what is being used counts: on-screen controls touched, the bound wheel (its rim always steers), keys held or the
 * mouse steering, a pad's pedals or stick moved. Null while nothing is, so on-screen controls left showing, or a pad
 * left plugged in, don't count against the keys
 */
export function drivingInputOf(f: {
  /** The on-screen controls' pedals and steering, when they are shown */
  touch: {
    throttle: number;
    brake: number;
    steer: number;
    steerLeft?: boolean;
    steerRight?: boolean;
    throttleBtn?: boolean;
    brakeBtn?: boolean;
  } | null;
  /** The device the pad reader took this frame (`DeviceFrame.source`) */
  source: "wheel" | "controller" | "legacy" | null;
  mouseSteer: boolean;
  /** A steering, throttle or brake key held */
  keys: boolean;
  /** The pad's pedals and steering (stick or axis), after shaping */
  pad: { throttle: number; brake: number; steer: number };
  /** The input chosen in the settings: a pad without the standard layout is a wheel there */
  setting: "keyboard" | "controller" | "wheel";
}): LapInput | null {
  if (
    f.touch &&
    (f.touch.throttle > 0.02 ||
      f.touch.brake > 0.02 ||
      Math.abs(f.touch.steer) > 0.01 ||
      f.touch.steerLeft ||
      f.touch.steerRight ||
      f.touch.throttleBtn ||
      f.touch.brakeBtn)
  ) {
    return "touch";
  }
  if (f.source === "wheel" && !f.mouseSteer) return "wheel";
  if (f.keys || f.mouseSteer) return "keyboard";
  const padUsed = f.pad.throttle > 0.02 || f.pad.brake > 0.02 || Math.abs(f.pad.steer) > 0.05;
  if (!padUsed || f.source === null) return null;
  // A pad without the standard layout is often a wheel nobody has bound yet
  return f.source === "legacy" && f.setting === "wheel" ? "wheel" : "controller";
}

/**
 * Revision of the vehicle physics. Bump it whenever a physics change makes earlier lap times incomparable: laps
 * recorded under another revision then go on another leaderboard.
 */
export const PHYSICS_VERSION = 8;

/**
 * The revision a lap in this car on this circuit is ranked under: the one its current board, ghosts, personal bests,
 * upload queue and weekly challenges go by. The car's revision (`carPhysicsVersion`), plus CIRCUIT_REVISION_STEP for
 * each time the circuit's own boards started again (src/lib/circuit-board-resets.ts).
 */
export function lapPhysicsVersion(vehicle: VehicleModelId | undefined, trackId: string): number {
  return carPhysicsVersion(vehicle) + CIRCUIT_REVISION_STEP * circuitRevision(trackId);
}

/**
 * The physics revision of a car, whatever the circuit (multiplayer compares it: players on other physics can't race
 * together). The LC26 on the rigid-body engine it ships on (`lc26-engine.ts`) is another car to drive than on its older
 * engine, so its laps have a revision of their own; the older engine's laps (still driven with `?lc26engine=classic`)
 * stay under `PHYSICS_VERSION`, an older board of that car. Raise the offset by ten when that car alone changes: the
 * other cars keep their boards. A version and its offset stay under CIRCUIT_REVISION_STEP.
 */
const LC26_RIGID_BODY_OFFSET = 530;
export function carPhysicsVersion(vehicle?: VehicleModelId): number {
  return revisionIn(PHYSICS_VERSION, LC26_RIGID_BODY_OFFSET, vehicle);
}

/**
 * Each restart of a circuit's boards adds this much to every lap revision on it. A car's own revision (a physics
 * version, plus the LC26's offset) stays under it, so the two never mix.
 */
export const CIRCUIT_REVISION_STEP = 1000;
/** The largest lap revision a board takes: 998 restarts of one circuit */
export const MAX_LAP_REVISION = 999_999;

/** A circuit's restarts: the map's own entry only (a circuit id from a request can be any word, "constructor" too) */
function resetsOf(trackId: string): readonly CircuitBoardReset[] {
  return Object.prototype.hasOwnProperty.call(CIRCUIT_BOARD_RESETS, trackId) ? CIRCUIT_BOARD_RESETS[trackId] : [];
}

/** How many times a circuit's boards have started again up to physics version `physics` (the one driven now by default) */
export function circuitRevision(trackId: string, physics: number = PHYSICS_VERSION): number {
  return resetsOf(trackId).filter((r) => r.physics <= physics).length;
}

/** A car's revision under a physics version: the version itself, and for the LC26 on its rigid-body engine, plus its offset */
function revisionIn(physics: number, lc26Offset: number, vehicle?: VehicleModelId): number {
  return vehicle === "lc26" && lc26OnRigidBody() ? physics + lc26Offset : physics;
}

/**
 * The physics versions the boards are named by, oldest first: the PHYSICS_VERSION each one's laps were driven under,
 * and the LC26's rigid-body offset then. The last is the one driven now, the only one a lap goes up to; the boards of
 * the ones before it stay readable as they were. A new version is one more line here, with PHYSICS_VERSION raised to
 * its number (scripts/verify-leaderboard.ts holds the two together).
 */
export const PHYSICS_VERSIONS = [
  { name: "V1", physics: 7, lc26Offset: 520 },
  { name: "V2", physics: 8, lc26Offset: 530, priorLc26Offsets: [520] },
] as const satisfies readonly { name: string; physics: number; lc26Offset: number; priorLc26Offsets?: readonly number[] }[];
export type NamedPhysicsVersion = (typeof PHYSICS_VERSIONS)[number];

/** The named version whose PHYSICS_VERSION is `physics`; null for one the boards don't name */
export function namedPhysicsVersion(physics: number): NamedPhysicsVersion | null {
  return PHYSICS_VERSIONS.find((v) => v.physics === physics) ?? null;
}

/** "Physics V2 (New)" for the version driven now, "Physics V1" for an older one */
export function physicsVersionLabel(physics: number, opts: { short?: boolean } = {}): string {
  const name = namedPhysicsVersion(physics)?.name ?? `v${physics}`;
  return `Physics ${name}${physics === PHYSICS_VERSION && !opts.short ? " (New)" : ""}`;
}

/**
 * A car's revision in physics version `physics` (a PHYSICS_VERSIONS number), whatever the circuit. For the current
 * version it is `carPhysicsVersion`.
 */
export function boardPhysicsVersion(physics: number, vehicle?: VehicleModelId): number {
  return revisionIn(physics, lc26OffsetIn(physics), vehicle);
}

const lc26OffsetIn = (physics: number): number => namedPhysicsVersion(physics)?.lc26Offset ?? LC26_RIGID_BODY_OFFSET;

/**
 * One board of a circuit the picker offers: a physics version, and the circuit's revision under it. Its `base` is the
 * revision of a car with no offset of its own (what `version=` asks the board API for); a car's revision on it is
 * `revisionOnBoard`.
 */
export interface BoardChoice {
  /** "8" for a version's newest board on the circuit, "8-0" for one it had before the circuit's boards started again */
  id: string;
  physics: number;
  circuit: number;
  base: number;
  /** "Physics V2 (New)", "Physics V1", "Physics V2 · Old kerbs" */
  label: string;
  /** The board laps on this circuit go on now */
  current: boolean;
}

/**
 * The boards a circuit's laps have been ranked on, newest first: each named physics version, and under one, each board
 * the circuit had before its boards started again (src/lib/circuit-board-resets.ts). Without a restart, one board per
 * version.
 */
export function boardChoices(trackId: string): BoardChoice[] {
  const resets = resetsOf(trackId);
  const versions = [...PHYSICS_VERSIONS].reverse();
  const out: BoardChoice[] = [];
  versions.forEach((v, i) => {
    const top = circuitRevision(trackId, v.physics);
    const bottom = circuitRevision(trackId, versions[i + 1]?.physics ?? 0);
    for (let k = top; k >= bottom; k--) {
      const newest = k === top;
      out.push({
        id: newest ? String(v.physics) : `${v.physics}-${k}`,
        physics: v.physics,
        circuit: k,
        base: v.physics + CIRCUIT_REVISION_STEP * k,
        label: newest ? physicsVersionLabel(v.physics) : `Physics ${v.name} · ${resets[k]?.oldBoard ?? "Older laps"}`,
        current: newest && v.physics === PHYSICS_VERSION,
      });
    }
  });
  return out;
}

/** The board picked as `id` on this circuit: one it doesn't have falls back to its version's newest, then the current one */
export function boardChoiceOf(trackId: string, id: string | null | undefined): BoardChoice {
  const all = boardChoices(trackId);
  return all.find((c) => c.id === id) ?? all.find((c) => c.id === id?.split("-")[0]) ?? all.find((c) => c.current) ?? all[0];
}

/** The base revision of the board laps on this circuit go on now */
export function currentBoardBase(trackId: string): number {
  return PHYSICS_VERSION + CIRCUIT_REVISION_STEP * circuitRevision(trackId);
}

/** A car's revision on the board of base revision `base` (a physics version, plus the circuit's steps) */
export function revisionOnBoard(base: number, vehicle?: VehicleModelId): number {
  const physics = base % CIRCUIT_REVISION_STEP;
  return boardPhysicsVersion(physics, vehicle) + (base - physics);
}

/**
 * The board (`BoardChoice.id`) a lap of this revision on this circuit was ranked on, the LC26's on either engine; null
 * for one older than every board the picker names
 */
export function boardChoiceOfLap(trackId: string, vehicle: VehicleModelId, revision: number): string | null {
  const on = boardChoices(trackId).find((c) => revision === c.base || (vehicle === "lc26" && revision === c.base + lc26OffsetIn(c.physics)));
  return on?.id ?? null;
}

/**
 * The primary shipping physics revision for a car on a circuit: always uses the LC26's shipping rigid-body engine
 * regardless of browser URL flags (`?lc26engine=classic`). Used by Fastest Lap awards and record holders so the
 * hidden legacy LC26 engine never double-counts records on the same circuit.
 */
export function shippingLapPhysicsVersion(vehicle: VehicleModelId, trackId: string): number {
  const base = currentBoardBase(trackId);
  return vehicle === "lc26" ? base + LC26_RIGID_BODY_OFFSET : base;
}

/**
 * True when a lap of this revision on this circuit may go on a board now: the current physics version and the
 * circuit's current revision only, the LC26's on either engine
 */
export function isCurrentLapPhysics(vehicle: VehicleModelId, revision: number, trackId: string): boolean {
  const base = currentBoardBase(trackId);
  return revision === base || (vehicle === "lc26" && revision === base + LC26_RIGID_BODY_OFFSET);
}

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
  /** The revision the lap is ranked under (`lapPhysicsVersion`): its physics version and its circuit's revision */
  physicsVersion: number;
  /**
   * What drove most of the lap (keyboard, controller, wheel or touch), shown beside the driver's name. Not part of the
   * board class: every device ranks on the same board. Absent on laps recorded before it was kept
   */
  input?: LapInput;
}

/** Mean water on the racing line (mm) from which a lap counts as wet */
export const WET_LAP_WATER_MM = 0.05;

/** The board a lap driven right now would be ranked on: the one place the surface is decided */
export function lapConditionsNow(c: {
  assists: AssistPreset;
  compound: TireCompound;
  lineWaterMm: number;
  realism: SimRealism;
  /** The car driven and the circuit: they decide the revision (`lapPhysicsVersion`) */
  vehicle?: VehicleModelId;
  trackId: string;
}): LapConditions {
  return {
    assists: c.assists,
    compound: c.compound,
    surface: c.lineWaterMm >= WET_LAP_WATER_MM ? "wet" : "dry",
    realism: c.realism,
    physicsVersion: lapPhysicsVersion(c.vehicle, c.trackId),
  };
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
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_LAP_REVISION) return null;
  const out: LapConditions = { assists: r.assists as AssistPreset, compound: r.compound as TireCompound, surface: r.surface, realism: r.realism as SimRealism, physicsVersion: v };
  // Optional: a lap without it (or with a kind this build doesn't know) is still a lap, only without the icon
  if (isLapInput(r.input)) out.input = r.input;
  return out;
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
  /** Optional car setup used to drive this lap (stored in local IDB and R2 ghost JSON for "Apply setup") */
  setup?: SharedCarSetup;
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
  /** The lap was deleted for barrier contact (riding the wall; on a hill climb, any touch): the card says so */
  wallContact?: boolean;
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
  /** True when the lap carries a saved car setup that other drivers can apply */
  hasSetup?: boolean;
  /** Inline setup on locally loaded entries (remote entries load theirs on demand via `/api/laps/<id>`) */
  setup?: SharedCarSetup;
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
  /** Distance along the lap (m), the track projection's hint when a flashback puts the car back here */
  s?: number;
  /** The player's lap count here */
  lap?: number;
  /** True while on the out-lap before the first timing-line crossing */
  outLap?: boolean;
  /** Cumulative race distance (m) during an AI race, so flashback rewinds lap clocks cleanly */
  distM?: number;
}

export interface ReplayFrame {
  /** Session time (s) */
  t: number;
  cars: ReplayCarState[];
}
