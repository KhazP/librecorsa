/**
 * AI opponents: full-physics LC26 cars driven by the racing-line AI, with a standing start behind
 * the five start lights, traffic awareness (follow or pass on the free side, give room alongside),
 * simple car-to-car contact and live race standings.
 *
 * The player's car (the LC26 or the f12026-car) is passed in so that it takes part in the start
 * procedure, contact and order; it is stepped by the caller (the field only steps its AI cars).
 */
import { steerAngleOf, wheelRpmOf } from './car-pose';
import * as THREE from 'three';
import { F1Physics2026 } from '@/lib/f1-physics-2026';
import { DEFAULT_TRACK_ID, getActiveTrackMetadata, type AiPlanCheck, type BuiltTrackData } from '@/lib/track-data';
import { resolveCarToCarObbCollision, type RigidBodyCollisionCar } from '@/lib/sim/track-evolution';
import { TrackEnvironment } from '@/lib/sim/track-environment';
import { aiLineOffsetM, computeSpeedProfile, createLc26ProfileCarModel, withPlanningGrip } from '@/lib/sim/speed-profile';
import { RacingLineDriver } from '@/lib/sim/ai-mpc';
import {
  AI_SKILL_DEFAULT,
  AiTrackTuning,
  aiSkillModifiers,
  buildTargetSpeedProfile,
  cornerSections,
  decelEnvelope,
  gaussian,
  hashString,
  inSection,
  resolveAiTuning,
  seededRng,
  type AiClassId,
  type AiSkillModifiers,
  type AiTuningLibrary,
  type TrackSection,
} from '@/lib/sim/ai-tuning';
import { AI_TUNING_LIBRARY } from '@/lib/sim/ai-tuning-data';
import { AiSectionLearner, loadLearnedCorners, saveLearnedCorners, type LearnedCorner } from '@/lib/sim/ai-learning';
import type { InterpolatedPeerState } from '@/lib/sim/multiplayer-sync';
import type { SimulatorCar } from '@/lib/sim/simulator-car';
import { carAheadOnRoad, earnedAtDetection, type OvertakingRaceControl } from '@/lib/sim/overtaking-rules';
import type { RaceStatus, VehicleModelId } from '@/types/f1';
import { AiCarControl, aiControlTraits, KNOCK_LATERAL_MS, KNOCK_WALL_MS, KNOCK_YAW_RADS, type AiControlCarState } from '@/lib/sim/ai-car-control';
import { CarDamage, worldToCarLocal, type DamageLevel, type DamageReport } from '@/lib/sim/car-damage';
import {
  brakingDistanceM,
  hazardHalfWidthM,
  hazardLine,
  inYellowZone,
  isHazardSpeed,
  overlapNow,
  ownsCorner,
  passFeasible,
  RacecraftMemory,
} from '@/lib/sim/ai-racecraft';
import { RaceIncidents } from '@/lib/sim/race-incidents';
import { aiTrackFor, sampleGrid, type AiTrack } from '@/lib/sim/ai/ai-track';
import { carLimitsFor } from '@/lib/sim/ai/ggv';
import { makeDrivePlan, type AiDrivePlan } from '@/lib/sim/ai/drive-plan';
import { DEFAULT_PLANNER_WEIGHTS, PLAN_DT, PLAN_STEPS, planLocal, type PlannerResult, type PredictedCar } from '@/lib/sim/ai/local-planner';
import type { AiGridOrder, PlayerGridSlot } from '@/lib/sim/race-setup';
import { F12026_CAR_CONFIG } from '@/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '@/lib/sim/gt3/AmgGt3Config';
import { SUZUKI_LIANA_CONFIG } from '@/lib/sim/road/SuzukiLianaConfig';
import { MTR_496R_CONFIG } from '@/lib/sim/proto/Mtr496rConfig';
import { NISSAN_R33_CONFIG } from '@/lib/sim/classic/NissanR33Config';
import { NISSAN_R32_CONFIG } from '@/lib/sim/classic/NissanR32Config';
import {
  classificationClosed,
  classifiedTimeS,
  classify,
  GapTimer,
  LapClock,
  lapPositionM,
  PlayerSplits,
  raceOrder,
  SplitTimer,
  type RacerProgress,
  wrapHalf,
} from '@/lib/sim/race-session';

export interface AiDriverDef {
  code: string;
  teamColorHex: string;
  /** Fraction of the car's limit the driver runs at (at the default skill level) */
  pace: number;
  /** Racecraft temperament: -1 waits for a clear gap and rarely defends ... +1 late lunges and covers every inside */
  aggression?: number;
  /** Lap-to-lap repeatability against the field's `consistency` (-0.1 ... +0.1) */
  consistencyBias?: number;
}

/** Field in grid order (pole first); the player lines up behind them */
export const AI_DRIVERS: AiDriverDef[] = [
  { code: 'KIG', teamColorHex: '#ff8000', pace: 0.975, aggression: 0.2, consistencyBias: 0.05 },
  { code: 'MUS', teamColorHex: '#e8002d', pace: 0.968, aggression: 0.5, consistencyBias: -0.05 },
  { code: 'NYA', teamColorHex: '#27f4d2', pace: 0.961, aggression: -0.3, consistencyBias: 0.08 },
  { code: 'RUB', teamColorHex: '#3671c6', pace: 0.954, aggression: 0.3, consistencyBias: -0.03 },
  { code: 'HUY', teamColorHex: '#b6babd', pace: 0.947, aggression: -0.5, consistencyBias: 0 },
];

/** Further down the order, for a bigger field (`aiDriversFor`) */
export const AI_RESERVE_DRIVERS: AiDriverDef[] = [
  { code: 'GIS', teamColorHex: '#52e252', pace: 0.951, aggression: 0.6, consistencyBias: -0.06 },
  { code: 'KAR', teamColorHex: '#ff87bc', pace: 0.944, aggression: 0.1, consistencyBias: 0.04 },
  { code: 'NYU', teamColorHex: '#6692ff', pace: 0.958, aggression: -0.1, consistencyBias: 0.02 },
  { code: 'BUT', teamColorHex: '#ffd700', pace: 0.94, aggression: 0.4, consistencyBias: -0.02 },
  { code: 'RUH', teamColorHex: '#00a19c', pace: 0.936, aggression: -0.4, consistencyBias: 0.06 },
  { code: 'KIB', teamColorHex: '#9b0000', pace: 0.947, aggression: 0.8, consistencyBias: -0.08 },
];

/** A field of `n` AI drivers: the five regulars, then the reserves */
export function aiDriversFor(n: number): AiDriverDef[] {
  return [...AI_DRIVERS, ...AI_RESERVE_DRIVERS].slice(0, Math.max(1, Math.min(n, AI_DRIVERS.length + AI_RESERVE_DRIVERS.length)));
}

const PLAYER_CODE = 'YOU';
/** Car footprint used for contact (m): length, width */
const CAR_LEN_M = 5.0;
const CAR_WID_M = 1.95;
/** Lateral spacing a passing car keeps from the car it passes (m) */
const PASS_SPACING_M = 2.5;
/**
 * Centre spacing two cars side by side keep (m): a car's width and ~0.9 m of air. At the passing spacing they ran
 * ~0.4 m apart, and with a few degrees of yaw between them the boxes rubbed for seconds
 */
const ALONGSIDE_SPACING_M = 2.9;

/**
 * The racecraft's tunable knobs (scripts/ai/tune-racecraft.ts searches them in headless races). The defaults are the
 * values the field races with.
 */
export interface RacecraftParams {
  /** Lateral spacing a passing car aims for beside the car it passes (m, at the shipped caution) */
  passSpacingM: number;
  /** Centre spacing two cars side by side keep (m) */
  alongsideSpacingM: number;
  /** A pass is set up within this many seconds of the car ahead (plus a closing-speed term) */
  reactGapS: number;
  /** Pull out of the tow this far behind (m) plus this many seconds of the closing speed */
  pullOutBaseM: number;
  pullOutClosingS: number;
  /** Extra pace once alongside in a pass (share, × 1 + aggression) */
  attackPush: number;
  /** How much harder than the car ahead a follower may brake (m/s²), and the distance its braking lead fades over (m) */
  followRelAccel: number;
  followFadeM: number;
  /** Corner speed given away per unit of front downforce lost in the wake (planned cars) */
  dirtyAirMargin: number;
  /** Local planner weights (when it is on) */
  plannerIntent: number;
  plannerLine: number;
  plannerProximity: number;
  plannerConsistency: number;
  /** Defending: a car this far behind (m) and closing by more than this (m/s) is an attacker */
  defendLookM: number;
  defendClosingMs: number;
  /** How far across a defensive move goes (m, × the driver's defend), and the room it needs to the attacker: half a
   * car length plus this many seconds of the closing speed */
  defendReachM: number;
  defendRoomS: number;
  /** Off the start an AI keeps its grid lane until a corner comes into view, or this far into the race at most (m) */
  startLaneMaxM: number;
}

export const DEFAULT_RACECRAFT: RacecraftParams = {
  passSpacingM: PASS_SPACING_M,
  alongsideSpacingM: ALONGSIDE_SPACING_M,
  reactGapS: 0.35,
  pullOutBaseM: 3,
  pullOutClosingS: 0.9,
  attackPush: 0.012,
  followRelAccel: 6,
  followFadeM: 25,
  dirtyAirMargin: 0.12,
  plannerIntent: 4,
  plannerLine: 0.15,
  plannerProximity: 25,
  plannerConsistency: 0.4,
  defendLookM: 30,
  defendClosingMs: 1,
  defendReachM: 2.2,
  defendRoomS: 0.8,
  startLaneMaxM: 900,
};
/** Rate at which an AI moves off / back onto its line (m/s) */
const BIAS_RATE_MS = 2.2;
/** ... and out of the tow to pass (m/s): a quick move, made with the speed the tow gave */
const PULL_OUT_RATE_MS = 3.2;
const LIGHT_INTERVAL_S = 1.0;
const GAP_BUCKET_M = 10;
/** The overtake caution the passing rules below were written for (the shipped default): no change at this value */
const BASE_CAUTION = 0.3;
/** Speed scale of a "too hot into the corner" mistake */
const MISTAKE_APEX_SCALE = 1.06;

/**
 * The speed a car may carry toward the car ahead in its path at a nose-to-tail gap (m): the speed that car will have
 * once our brakes bite (~0.2 s on at its own deceleration), plus what we can take out braking a little harder than it,
 * with 2.5 m to spare. Without the lead for its braking, the car behind in a braking zone was always a step late
 */
function followCapMs(ahead: SimulatorCar, gapM: number, rc: RacecraftParams = DEFAULT_RACECRAFT): number {
  const decelAhead = Math.max(0, -(ahead.telemetry.longitudinalG ?? 0) * 9.81);
  const vAhead = Math.max(0, ahead.vxMs);
  // The lead for the car ahead's braking and the extra gap into a braking zone matter close up; 25 m back they held a
  // quicker car off a slower one that braked early, and it never got close enough to try a pass
  const close = Math.max(0, Math.min(1, (rc.followFadeM - gapM) / Math.max(5, rc.followFadeM - 5)));
  const margin = 2.5 + (decelAhead > 5 ? 0.12 * vAhead * close : 0);
  return Math.max(0, vAhead - 0.2 * decelAhead * close) + Math.sqrt(2 * rc.followRelAccel * Math.max(0, gapM - margin));
}

/**
 * How much a planned car's speed over the road ahead (to `lookM`) is a corner's to set: 1 where the plan has it brake
 * or hold a corner's limit within that distance, 0 where the slowest point ahead is well above its speed (a straight,
 * a fast sweep it is still accelerating through). The plan's level-ground top speed is no corner: a car in a tow runs
 * past it
 */
function cornerLimitedShare(plan: AiDrivePlan, s: number, vMs: number, lookM: number): number {
  const ds = plan.track.ds;
  let vMin = Infinity;
  for (let d = 0; d <= lookM; d += 5) {
    const v = sampleGrid(plan.v, s + d, ds);
    if (sampleGrid(plan.vOpen, s + d, ds) > v + 0.05) continue;
    vMin = Math.min(vMin, v);
  }
  return THREE.MathUtils.clamp((1.15 - vMin / Math.max(1, vMs)) / 0.15, 0, 1);
}

/**
 * Planned grip of an AI car at pace 1: the share of its measured limits the plan uses. A driver's pace (skill, the
 * lap's form, the weather) scales it as pace² (corner speed goes with √grip), so slower drivers are slower through
 * the corners and on the brakes, not down the straights
 */
const PLAN_GRIP = 0.97;
/** Below a circuit's checked grip ceiling, what the fastest level plans to (see refreshPlan) */
const RACE_GRIP_MARGIN = 0.04;

/**
 * Lights out to the car moving (s) for an AI skill 0..100 and two seeded draws 0..1: a reaction of 0.30 s for a rookie
 * to 0.17 s for an alien, ± 0.05 s from start to start, and now and then (1 start in 6 for a rookie, 1 in 25 for an
 * alien) a launch bogged by wheelspin or a slow clutch release, worth a few tenths. Real F1 starts react in 0.15-0.3 s
 */
export function launchReactionS(skill: number, draw: number, badDraw: number): number {
  const k = THREE.MathUtils.clamp(skill / 100, 0, 1);
  const react = 0.3 - 0.13 * k + (draw - 0.5) * 0.1;
  const badChance = 0.17 - 0.13 * k;
  const bogged = badDraw < badChance ? 0.2 + 0.3 * (badDraw / badChance) : 0;
  return react + bogged;
}

/** What a headless race reports per car */
export interface AiCarStats {
  offTracks: number;
  wallHits: number;
  stuckRecoveries: number;
  contacts: number;
  mistakes: number;
  /** Spins (a slide the driver could not catch) */
  spins: number;
  /** Times the marshals had to move the car */
  marshalRecoveries: number;
  /** Places gained on the road (a car's own retirement or another's doesn't count) */
  passes: number;
  lapTimesMs: number[];
  /** Running position at each completed lap (1 = leading) */
  lapPositions: number[];
}

/** How the field sets a car's target speed and steering gain (null: a car without an AI tuning hook) */
interface AiDriveHooks {
  base: ArrayLike<number>;
  env: Float32Array;
  setTarget(v: Float64Array | null): void;
  setSteerGain(g: number): void;
  /** Swaps `base` / `env` for the car's current planning grip (rain); true when they changed */
  refresh?(): boolean;
}

const lc26Bases = new WeakMap<BuiltTrackData, Map<string, { base: Float64Array; env: Float32Array }>>();

function driveHooksFor(sim: SimulatorCar, track: BuiltTrackData): AiDriveHooks | null {
  const L = track.totalLengthM;
  if (typeof sim.aiBaseSpeedProfile === 'function') {
    const base = sim.aiBaseSpeedProfile();
    return {
      base,
      env: decelEnvelope(base, L),
      setTarget: (v) => (sim.aiTargetSpeedMs = v),
      setSteerGain: (g) => (sim.aiSteerGain = g),
    };
  }
  // The LC26 drives on a RacingLineDriver over the profile it builds from this planning model; f1-physics-2026.ts has
  // no tuning setters of its own, so the tuning goes straight to its driver
  const driver = (sim as unknown as { aiDriver?: unknown }).aiDriver;
  if (driver instanceof RacingLineDriver) {
    let perTrack = lc26Bases.get(track);
    if (!perTrack) lc26Bases.set(track, (perTrack = new Map()));
    const cache = perTrack;
    // The limit profile on the tyres' grip on this road (the dry one unless it rains)
    const entryFor = (grip: number) => {
      const key = `${sim.aeroPreset}@${grip}`;
      let entry = cache.get(key);
      if (!entry) {
        const base = computeSpeedProfile(track.samples, withPlanningGrip(createLc26ProfileCarModel(sim.aeroPreset), grip)).speedMs;
        entry = { base, env: decelEnvelope(base, L) };
        cache.set(key, entry);
      }
      return entry;
    };
    let grip = sim.aiPlanGrip?.() ?? 1;
    const entry = entryFor(grip);
    const hooks: AiDriveHooks = {
      base: entry.base,
      env: entry.env,
      setTarget: (v) => (driver.targetSpeedMs = v),
      setSteerGain: (g) => (driver.steerGain = g),
      refresh: () => {
        const now = sim.aiPlanGrip?.() ?? 1;
        if (now === grip) return false;
        grip = now;
        const next = entryFor(grip);
        hooks.base = next.base;
        hooks.env = next.env;
        return true;
      },
    };
    return hooks;
  }
  return null;
}

/** Tuning class of a car: GT3 by its racing line or model, otherwise the 2026 open-wheelers */
const classOf = (sim: SimulatorCar): AiClassId => (sim.vehicleId === 'amg-gt3' || sim.racingLineId === 'gt3' ? 'gt3' : 'f1-2026');

export interface AiFieldOptions {
  /** AI skill 0-100 (`AI_SKILL_DEFAULT`, Pro: the field as it always drove) */
  skill?: number;
  /** Circuit id for the per-track tuning files (default: the track data's id) */
  trackId?: string;
  /** Tuning class (default: from the player's car) */
  classId?: AiClassId;
  /** Race seed (lap-to-lap errors, mistakes, the start hold): a seed replays the same race in the headless runner */
  seed?: number;
  /** Each car learns per corner, lap to lap (default true) */
  learning?: boolean;
  /** Keep what was learnt per circuit, class and driver in localStorage (default false: every session starts fresh) */
  persistLearning?: boolean;
  /** No player in the field (headless races): `player` is only the car the AI cars are built like */
  spectate?: boolean;
  /** Tuning files (default: public/ai) */
  library?: AiTuningLibrary;
  /** Damage from contact and barriers (default 'reduced') */
  damage?: DamageLevel;
  /** AI grid order: by pace (the quickest on pole, as the field always lined up), a qualifying shuffle, or reversed */
  gridOrder?: AiGridOrder;
  /** The player's grid slot (default 'back') */
  playerGrid?: PlayerGridSlot;
  /** Racecraft knobs (default DEFAULT_RACECRAFT) */
  racecraft?: Partial<RacecraftParams>;
  /**
   * The local planner chooses how cars on drive plans approach and pass the cars ahead (default false: the racecraft
   * rules on the drive plans race cleaner until its weights are tuned)
   */
  localPlanner?: boolean;
  /**
   * AI cars already made with `player.createAiPeerCar()`, one per driver in order (a field built ahead makes them a
   * few at a time); any missing are made here
   */
  peers?: readonly SimulatorCar[];
}

export type { AiGridOrder, PlayerGridSlot } from '@/lib/sim/race-setup';

interface FieldCar {
  id: string;
  code: string;
  teamColorHex: string;
  isPlayer: boolean;
  sim: SimulatorCar;
  /** The AI car's physics (null for the player) */
  ai: SimulatorCar | null;
  /** The driver's pace as written (default skill) */
  defPace: number;
  /** Pace before this lap's inconsistency: driver x skill x tuning */
  basePace: number;
  /** This lap's pace */
  pace: number;
  aggression: number;
  consistencyBias: number;
  hooks: AiDriveHooks | null;
  learner: AiSectionLearner | null;
  rng: () => number;
  /** This lap's braking-point error per corner (share of braking held back), and the corner of a mistake (-1: none) */
  cornerBrakeErr: Float32Array;
  mistakeCorner: number;
  stats: AiCarStats;
  wasOff: boolean;
  lastWallMs: number;
  prevVx: number;
  /** Decelerating like a wall hit last frame (the LC26's impacts are counted from this) */
  inWallHit: boolean;
  /** Touched another car this frame */
  contact: boolean;
  /** The driver's hands off the autopilot: reaction to a knock, spin, stop and rejoin (AI cars only) */
  control: AiCarControl | null;
  damage: CarDamage;
  /** Out of the race (terminal damage) */
  retired: boolean;
  /** Race time the car retired (s) */
  retiredAtS: number | null;
  /** Retired and stopped long enough ago that the marshals have taken it away: no longer on the track */
  removed: boolean;
  /** Barrier impact last counted for damage (the car's own event clock) */
  lastWallDamageMs: number;
  /** What the AI driver remembers for its racecraft (overlaps, defence count, pass commitment) */
  craft: RacecraftMemory;
  /** Grid slot of this race (0 = pole) */
  gridSlot: number;
  /** Grip its current drive plan was built on (the plan is rebuilt when it moves) */
  planGrip: number;
  /** The local planner's last choice, and the race time it was made */
  local: PlannerResult | null;
  /** What the racecraft rules asked the planner for last (end offset from the line; null: race the line) */
  intentD: number | null;
  localAtS: number;
  /** Covering the inside against a car behind */
  defending: boolean;
  /** Lateral offset of its grid slot (m), held off the start until the first corner; null once it races its line */
  startLaneM: number | null;
  /** Time from lights out until it gets going (s): its reaction, now and then a bogged launch on top */
  launchReactS: number;
  /** Laps, distance and flag of this car (the same clock a multiplayer race keeps) */
  readonly clock: LapClock;
  /** Race distance covered (m); negative on the grid behind the line */
  readonly distM: number;
  prevS: number;
  biasM: number;
  stuckS: number;
  peer: InterpolatedPeerState;
  /** Race time at the chequered flag (s); null while running */
  readonly finishTimeS: number | null;
  /** Laps completed at the flag (fewer than the race's when lapped) */
  readonly finishLaps: number | null;
  readonly bestLapMs: number | null;
  readonly lastLapMs: number | null;
}



/** Contact mass properties (an F1 car with driver and fuel) and the per-frame limits on what a contact may do */
const CONTACT_MASS_KG = 778;
const CONTACT_YAW_INERTIA_KGM2 = 1120;
const CONTACT_MAX_POS_M = 0.25;
const CONTACT_MAX_DV_MS = 6;
// A touch lasts tens of ms, and over that the still-gripping tyres (≈30 kN·m of yaw moment on an F1 car) resist about
// as much yaw as the contact gives, which the free-body impulse leaves out: a 2 m/s rear-quarter tap at 260 km/h
// otherwise kicks ~1 rad/s and spins the car
const CONTACT_MAX_DYAW_RADS = 0.25;
/**
 * Between the field's own cars the caps grow with the impact: a graze keeps the cap above, a real hit gets the yaw its
 * off-centre impulse gives (up to 2.5 rad/s per frame), so a rear-quarter tap at speed can spin a car, and the speed
 * change of the impulse itself (at most (1 + e) × the closing speed) is never cut, so a car can't drive through a
 * stopped one
 */
const fieldContactYawCap = (impactMs: number) => THREE.MathUtils.clamp(0.25 + 0.09 * impactMs, CONTACT_MAX_DYAW_RADS, 2.5);
const fieldContactDvCap = (impactMs: number) => Math.max(CONTACT_MAX_DV_MS, 2 + 1.3 * impactMs);
/** Two boxes can only overlap with their centres within a full diagonal (m, squared) */
const CONTACT_BROAD_M2 = CAR_LEN_M * CAR_LEN_M + CAR_WID_M * CAR_WID_M;
/** A retired car stopped this long is taken away by the marshals (s): long enough to be a yellow-flag hazard */
const RETIRED_REMOVE_S = 20;

/** What happened on track this frame, for race control (`race-incidents.ts`) and the HUD */
export type FieldIncident =
  | {
      kind: 'contact';
      /** Car codes; `a` is the car further back on the road when the contact began */
      a: string;
      b: string;
      aIsPlayer: boolean;
      bIsPlayer: boolean;
      /** Closing speed along the contact normal (m/s) */
      impactMs: number;
      /** Road gap b − a along the track (m) and lateral offsets (m, + right) at contact */
      dsM: number;
      aLatM: number;
      bLatM: number;
      /** Lateral speeds across the track (m/s, + right) at contact: who moved across into whom */
      aLatSpeedMs: number;
      bLatSpeedMs: number;
      /** Braking at contact */
      aBraking: boolean;
      bBraking: boolean;
      /** Lap distance of the contact (m) */
      s: number;
    }
  | { kind: 'damage'; code: string; isPlayer: boolean; report: DamageReport; source: 'car' | 'wall' }
  | { kind: 'spin'; code: string; isPlayer: boolean; s: number }
  | { kind: 'retired'; code: string; isPlayer: boolean; s: number };

const _obbA: RigidBodyCollisionCar = {
  x: 0, y: 0, z: 0, fwdX: 0, fwdZ: 1, vx: 0, vz: 0, yawRateRadS: 0,
  massKg: CONTACT_MASS_KG, yawInertiaKgM2: CONTACT_YAW_INERTIA_KGM2, halfLengthM: 0, halfWidthM: 0,
};
const _obbB: RigidBodyCollisionCar = { ..._obbA };
const _sep: [number, number] = [0, 0];

/** The car's contact box in the Three.js world (X, Z), heading from its quaternion's forward axis */
function fillObb(sim: SimulatorCar, out: RigidBodyCollisionCar): void {
  const q = sim.worldQuaternion;
  // Model +Z (forward) rotated by q, projected on the ground; left is (fz, −fx) (model +X)
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  out.x = sim.worldPosition.x;
  out.y = sim.worldPosition.y;
  out.z = sim.worldPosition.z;
  out.fwdX = fx;
  out.fwdZ = fz;
  // Body velocity (vx forward, vy + left) to world
  out.vx = sim.vxMs * fx + sim.vyMs * fz;
  out.vz = sim.vxMs * fz - sim.vyMs * fx;
  // OBB yaw rate is + counter-clockwise (turning left), the car's + turning right
  out.yawRateRadS = -sim.yawRateRadS;
  out.halfLengthM = CAR_LEN_M * 0.5;
  out.halfWidthM = CAR_WID_M * 0.5;
  out.massKg = sim.contactMassKg ?? CONTACT_MASS_KG;
  out.yawInertiaKgM2 = sim.contactYawInertiaKgM2 ?? CONTACT_YAW_INERTIA_KGM2;
}

/** Hands the solver's deltas to the car, clamped per frame so a deep overlap can never launch it */
function applyObbDeltas(
  sim: SimulatorCar,
  pos: readonly [number, number],
  vel: readonly [number, number],
  yaw: number,
  maxDv = CONTACT_MAX_DV_MS,
  maxYaw = CONTACT_MAX_DYAW_RADS
): void {
  if (!sim.applyRigidBodyCollision) return;
  const pl = Math.hypot(pos[0], pos[1]);
  const ps = pl > CONTACT_MAX_POS_M ? CONTACT_MAX_POS_M / pl : 1;
  const vl = Math.hypot(vel[0], vel[1]);
  const vs = vl > maxDv ? maxDv / vl : 1;
  const y = THREE.MathUtils.clamp(yaw, -maxYaw, maxYaw);
  sim.applyRigidBodyCollision(pos[0] * ps, pos[1] * ps, vel[0] * vs, vel[1] * vs, y);
  _applied.dvx = vel[0] * vs;
  _applied.dvz = vel[1] * vs;
  _applied.dyaw = y;
}
/** The deltas the last applyObbDeltas handed over */
const _applied = { dvx: 0, dvz: 0, dyaw: 0 };

/**
 * Another player's car: its pose is a prediction a few cm out, so the contact is soft. Overlap is worked out at most
 * this fast (m/s) beyond a small slop, the closing speed is taken out by the impulse, with little bounce.
 */
const REMOTE_SEP_RATE_MS = 1.5;
const REMOTE_SLOP_M = 0.02;
/**
 * Overlap of the predicted boxes below which there is no contact (m): above the separation slop, as the remote pose
 * is a prediction off by ~0.1 m on average, yet low enough that a hit is still met before it digs in (at 5 cm the
 * contact came late and hard enough to spin the side-by-side duel in verify-multiplayer-contact)
 */
const REMOTE_CONTACT_SLOP_M = 0.03;
const REMOTE_RESTITUTION = 0.1;

/** Contact mass and yaw inertia of another player's car, from the model it drives */
function remoteContactMass(vehicle: VehicleModelId | undefined): [number, number] {
  if (vehicle === 'amg-gt3') return [AMG_GT3_CONFIG.chassis.totalMassKg, AMG_GT3_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'liana') return [SUZUKI_LIANA_CONFIG.chassis.totalMassKg, SUZUKI_LIANA_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'mtr-496r') return [MTR_496R_CONFIG.chassis.totalMassKg, MTR_496R_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'nissan-r33-jgtc') return [NISSAN_R33_CONFIG.chassis.totalMassKg, NISSAN_R33_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'nissan-r32-jtcc') return [NISSAN_R32_CONFIG.chassis.totalMassKg, NISSAN_R32_CONFIG.chassis.inertia.yaw];
  if (vehicle === 'f12026-car') return [F12026_CAR_CONFIG.chassis.totalMassKg, F12026_CAR_CONFIG.chassis.inertia.yaw];
  return [CONTACT_MASS_KG, CONTACT_YAW_INERTIA_KGM2];
}

/**
 * Contact between the player and another human's car (multiplayer). Each client resolves only its own car against
 * the other's state predicted to the present (`MultiplayerSyncManager.predictPeer`); both sides do the same, so the
 * pair separates and exchanges momentum as the field's contacts do. `dt` is the frame time (s), which paces the
 * position correction. Returns true when the cars touched.
 */
export function resolvePlayerVsRemoteCar(player: SimulatorCar, remote: InterpolatedPeerState, dt = 1 / 60): boolean {
  if (!player.applyRigidBodyCollision || remote.contactReady === false) return false;
  const dx = remote.position.x - player.worldPosition.x;
  const dz = remote.position.z - player.worldPosition.z;
  const dy = remote.position.y - player.worldPosition.y;
  // Broad phase: two boxes can overlap with their centres up to a full diagonal apart (√(L² + W²) ≈ 5.4 m)
  if (dx * dx + dz * dz > CAR_LEN_M * CAR_LEN_M + CAR_WID_M * CAR_WID_M || Math.abs(dy) > 2) return false;
  fillObb(player, _obbA);
  const q = remote.quaternion;
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl;
  fz /= fl;
  _obbB.x = remote.position.x;
  _obbB.y = remote.position.y;
  _obbB.z = remote.position.z;
  _obbB.fwdX = fx;
  _obbB.fwdZ = fz;
  _obbB.vx = remote.linearVelocity.x;
  _obbB.vz = remote.linearVelocity.z;
  // + counter-clockwise for the solver, + turning right on the wire
  _obbB.yawRateRadS = -(remote.yawRateRadS ?? 0);
  _obbB.halfLengthM = CAR_LEN_M * 0.5;
  _obbB.halfWidthM = CAR_WID_M * 0.5;
  [_obbB.massKg, _obbB.yawInertiaKgM2] = remoteContactMass(remote.vehicle);
  const hit = resolveCarToCarObbCollision(_obbA, _obbB, REMOTE_RESTITUTION);
  // The remote box is a prediction, good to about a decimetre: an overlap within the slop is not contact. This,
  // not a tight broad phase, is what keeps prediction error from turning grazes into phantom hits
  if (!hit.collided || hit.penetrationM <= REMOTE_CONTACT_SLOP_M) return false;
  // This car's half of the overlap, paced so a few frames of it never snap the car sideways
  const sep = Math.min(Math.max(0, 0.5 * hit.penetrationM - REMOTE_SLOP_M), REMOTE_SEP_RATE_MS * Math.max(0, dt));
  _sep[0] = -hit.nx * sep;
  _sep[1] = -hit.nz * sep;
  applyObbDeltas(player, _sep, hit.velDeltaA, hit.yawDeltaA);
  return true;
}

const emptyStats = (): AiCarStats => ({
  offTracks: 0,
  wallHits: 0,
  stuckRecoveries: 0,
  contacts: 0,
  mistakes: 0,
  spins: 0,
  marshalRecoveries: 0,
  passes: 0,
  lapTimesMs: [],
  lapPositions: [],
});

export interface AiFieldReport {
  seed: number;
  skill: number;
  tuningSources: string[];
  cars: {
    code: string;
    isPlayer: boolean;
    gridPos: number;
    position: number;
    pace: number;
    distM: number;
    finishTimeS: number | null;
    bestLapMs: number | null;
    stats: AiCarStats;
    learnt: LearnedCorner[];
    retired: boolean;
    penaltyS: number;
    damage: number;
  }[];
  /** Race control's messages over the race */
  raceControl: { kind: string; text: string; detail?: string; atS: number }[];
}

export class AiOpponentField {
  public phase: RaceStatus['phase'] = 'racing';
  /**
   * False until startRace: the shell builds a spare field in the menus, and a field that never started is not a race
   * (its `phase` only says where a started race would be)
   */
  private started = false;
  /** Race length; the player's flag ends their race (the AI cars finish their own lap and keep circulating) */
  public raceLaps = 5;
  public lightsOn = 0;
  /** Track evolution and aero wake shared by every car on the track */
  public readonly environment: TrackEnvironment;
  /** True when the field updates `environment` itself (none was given); otherwise its owner does, every car included */
  private readonly ownsEnvironment: boolean;
  private readonly cars: FieldCar[] = [];
  /** Every car's physics, AI cars in grid order then the player */
  private readonly allSims: SimulatorCar[] = [];
  private lightsTimerS = 0;
  private holdS = 0;
  private raceTimeS = 0;
  /** Race time at which the first car reached each distance bucket (gap timing) */
  /** Time gaps to the leader at the same point of the track (finer buckets than a multiplayer race's) */
  private readonly gapTimer = new GapTimer(GAP_BUCKET_M);
  /** Every car's time at points of race distance (split gaps to the player's neighbours, DRS gaps) */
  private readonly splitTimer = new SplitTimer();
  private readonly playerSplits = new PlayerSplits();

  // ---- AI tuning, skill and learning
  public readonly classId: AiClassId;
  public readonly trackId: string;
  public readonly tuning: AiTrackTuning;
  /** The corners each car learns (each turn with its braking straight) */
  public readonly corners: readonly TrackSection[];
  private readonly cornerAt: Int16Array;
  private skillLevel: number;
  private mods: AiSkillModifiers;
  private readonly seed: number;
  private readonly learning: boolean;
  private readonly persistLearning: boolean;
  private readonly spectate: boolean;
  /** Last contact time per car pair (a touch is counted once) */
  /** Last contact time per pair of field slots (key: lower slot × 256 + higher slot) */
  private readonly contactAt = new Map<number, number>();
  private readonly rng: () => number;
  /** Damage from contact and barriers (from the next start) */
  public damageLevel: DamageLevel;
  /** Incidents this frame for race control: contacts (with who hit whom), damage, retirements */
  public readonly incidents: FieldIncident[] = [];
  /** Races started on this field (each one rolls its own damage dice) */
  private raceCount = 0;
  /** The local planner is on (cars on drive plans) */
  public localPlanner: boolean;
  /** Racecraft knobs */
  public readonly rc: RacecraftParams;
  /** Grid of the next race */
  public gridOrder: AiGridOrder;
  public playerGrid: PlayerGridSlot;
  /** Added to every driver's temperament (`RACE_AGGRESSION_OFFSET`): the race setup's clean / normal / hard */
  public aggressionAdd = 0;
  /** Race control: contacts judged, penalties, yellow flags, the messages for the HUD */
  public readonly raceControl = new RaceIncidents(PLAYER_CODE);

  constructor(
    private readonly track: BuiltTrackData,
    private readonly player: SimulatorCar,
    drivers: AiDriverDef[] = AI_DRIVERS,
    environment?: TrackEnvironment,
    options: AiFieldOptions = {}
  ) {
    this.damageLevel = options.damage ?? 'reduced';
    this.localPlanner = options.localPlanner ?? false;
    this.rc = { ...DEFAULT_RACECRAFT, ...(options.racecraft ?? {}) };
    this.gridOrder = options.gridOrder ?? 'pace';
    this.playerGrid = options.playerGrid ?? 'back';
    this.environment = environment ?? new TrackEnvironment(track);
    this.ownsEnvironment = !environment;
    this.spectate = options.spectate ?? false;
    this.classId = options.classId ?? classOf(player);
    this.trackId = options.trackId ?? track.id ?? DEFAULT_TRACK_ID;
    this.skillLevel = THREE.MathUtils.clamp(options.skill ?? AI_SKILL_DEFAULT, 0, 100);
    this.mods = aiSkillModifiers(this.skillLevel);
    this.seed = (options.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
    this.rng = seededRng(this.seed);
    this.learning = options.learning ?? true;
    this.persistLearning = options.persistLearning ?? false;
    this.corners = cornerSections(track);
    const library = options.library ?? AI_TUNING_LIBRARY;
    let tuning: AiTrackTuning | null = null;
    for (const [i, d] of drivers.entries()) {
      const sim = options.peers?.[i] ?? (player.createAiPeerCar ? player.createAiPeerCar() : new F1Physics2026(track));
      sim.assistPreset = 'pro';
      sim.aiAutopilot = true;
      // The field rejoins its own cars after a spin, by driving, not by the car's own teleport
      sim.aiSelfRecovery = false;
      sim.autoGearbox = true;
      sim.aiPaceScale = d.pace;
      tuning ??= new AiTrackTuning(track, resolveAiTuning({ classId: this.classId, vehicleId: sim.vehicleId, trackId: this.trackId }, library));
      const car = this.makeCar(`ai_${d.code}`, d.code, d.teamColorHex, sim, sim, d.pace);
      car.aggression = THREE.MathUtils.clamp(d.aggression ?? 0, -1, 1);
      car.consistencyBias = THREE.MathUtils.clamp(d.consistencyBias ?? 0, -0.2, 0.2);
      car.hooks = driveHooksFor(sim, track);
      this.cars.push(car);
    }
    this.tuning = tuning ?? new AiTrackTuning(track, resolveAiTuning({ classId: this.classId, trackId: this.trackId }, library));
    this.cornerAt = new Int16Array(this.tuning.n);
    for (let i = 0; i < this.tuning.n; i++) {
      const s = (i * track.totalLengthM) / this.tuning.n;
      this.cornerAt[i] = this.corners.findIndex((c) => inSection(s, c.fromM, c.toM, track.totalLengthM));
    }
    if (!this.spectate) this.cars.push(this.makeCar('player', PLAYER_CODE, '#E10600', player, null, 1));
    for (const car of this.cars) this.allSims.push(car.sim);
    // The AI cars' overtaking aids follow the race rules too (the player's are wired by the simulator)
    for (const car of this.cars) if (car.ai) car.ai.raceControl = this.raceControlFor(car.ai);
    this.applySkill();
  }

  /** AI skill 0-100 */
  get skill(): number {
    return this.skillLevel;
  }

  /** Changes the AI level mid-session: pace at once, braking points and corner speeds from a rebuilt target */
  public setSkill(skill: number): void {
    this.skillLevel = THREE.MathUtils.clamp(skill, 0, 100);
    this.mods = aiSkillModifiers(this.skillLevel);
    this.applySkill();
    for (const car of this.cars) if (car.ai) {
      this.rebuildTarget(car);
      this.refreshPlan(car);
    }
  }

  private applySkill(): void {
    for (const car of this.cars) {
      if (!car.ai) continue;
      car.basePace = Math.min(0.999, (1 - (1 - car.defPace) * this.mods.spread) * this.mods.paceMult * this.tuning.params.pace);
      car.pace = car.basePace;
    }
  }

  private cornerIndex(s: number): number {
    const L = this.track.totalLengthM;
    const n = this.cornerAt.length;
    return this.cornerAt[Math.floor(((((s % L) + L) % L) / L) * n) % n];
  }

  /** A new lap for an AI car: this lap's inconsistency (pace, braking points, maybe a mistake), then its target speed */
  private newLap(car: FieldCar): void {
    const spread = 1 - THREE.MathUtils.clamp(this.tuning.params.consistency + car.consistencyBias, 0, 1);
    const m = this.mods;
    car.pace = car.basePace * (1 + THREE.MathUtils.clamp(gaussian(car.rng) * m.lapPaceSigma * spread, -0.03, 0.03));
    for (let k = 0; k < car.cornerBrakeErr.length; k++) {
      car.cornerBrakeErr[k] = Math.max(0, gaussian(car.rng) * m.cornerBrakeSigma * spread);
    }
    // A proper mistake (into one corner too hot); its chance is rated at the default consistency 0.85. None on the
    // in-lap after the flag, which would otherwise still count in the race's mistake stats
    const mistake = car.finishTimeS === null && car.rng() < m.mistakesPerLap * (spread / 0.15);
    car.mistakeCorner = mistake && this.corners.length ? Math.floor(car.rng() * this.corners.length) : -1;
    if (car.mistakeCorner >= 0) car.stats.mistakes++;
    this.rebuildTarget(car);
    this.refreshPlan(car);
  }

  /** An AI car's target speed: its limit profile with the tuning, the skill, what it learnt and this lap's errors */
  private rebuildTarget(car: FieldCar): void {
    const hooks = car.hooks;
    if (!hooks) return;
    const T = this.tuning;
    const m = this.mods;
    const learner = car.learner;
    const target = buildTargetSpeedProfile(
      hooks.base,
      this.track,
      (s) => {
        const k = this.cornerIndex(s);
        const learnt = learner ? learner.offsetsAt(s) : null;
        // Empty until startRace sizes it (setSkill can rebuild the target before that): no error rather than NaN
        const err = k >= 0 ? (car.cornerBrakeErr[k] ?? 0) : 0;
        const hot = k >= 0 && k === car.mistakeCorner ? MISTAKE_APEX_SCALE : 1;
        return {
          brakeMargin: T.at('brakeMargin', s) + m.brakeMarginAdd + (learnt?.brakeMargin ?? 0) + err,
          apexScale: T.at('apexSpeedScale', s) * m.apexMult * (1 + (learnt?.apex ?? 0)) * hot,
          bumpCaution: T.at('bumpCaution', s),
        };
      },
      hooks.env
    );
    if (car.ai?.vehicleId === 'lc26' && car.ai.aiPlan) return;
    hooks.setTarget(target);
  }

  /** The AI grid and the racing line per class, built on first use */
  private aiTrack: AiTrack | null = null;
  private readonly classLines = new Map<string, Float64Array>();

  /** A driver's temperament in this race: its own, moved by the race setup's aggression */
  private aggressionOf(car: FieldCar): number {
    return THREE.MathUtils.clamp(car.aggression + this.aggressionAdd, -1, 1);
  }

  /**
   * Whether a car's autopilot tracks drive plans: where the circuit's line check (scripts/ai/check-lines.ts) found this
   * car can drive the line on the full physics. Elsewhere (a line through Monaco's barriers, an unchecked circuit) it
   * keeps its own driver
   */
  private static tracksPlans(sim: SimulatorCar): boolean {
    return 'aiPlan' in sim && getActiveTrackMetadata().aiPlans?.[sim.vehicleId ?? '']?.ok === true;
  }

  /**
   * A car's drive plan: its class's racing line with the speeds its own limits allow at its grip, which is the plan
   * grip times its pace² (skill, this lap's form) and the weather's grip. Rebuilt when that grip moves.
   */
  private refreshPlan(car: FieldCar): void {
    const sim = car.ai;
    if (!sim || !AiOpponentField.tracksPlans(sim)) return;
    const weather = this.environment.weatherPaceScale(sim);
    // A damaged car (a broken wing, bent suspension) has less grip to plan with, and a puncture leaves its tyre under
    // half: the plan takes the weaker axle's grip too, as a car through a corner is held by its worse end, with the
    // weak tyre on the outside carrying 70 % of its axle (a puncture: 0.6)
    let damaged = 1;
    if (!car.damage.pristine) {
      const g = car.damage.effects().wheelGripMult;
      const axle = (a: number, b: number) => 0.7 * Math.min(a, b) + 0.3 * Math.max(a, b);
      damaged = Math.min(1 - 0.35 * car.damage.overall, axle(g[0], g[1]), axle(g[2], g[3]));
    }
    // The fastest levels plan toward the most grip this car drove cleanly here (the circuit's line check), one step
    // (0.04) under it: the check is a flying lap alone, and a race adds traffic, dirty air and a pack on lap 1 (at
    // the full step the LC26 hit Okayama's barriers four times as often)
    const checked = (getActiveTrackMetadata().aiPlans?.[sim.vehicleId ?? ''] as AiPlanCheck | undefined)?.maxGrip;
    const ceiling = Math.max(PLAN_GRIP, (checked ?? PLAN_GRIP) - RACE_GRIP_MARGIN);
    // On a race's first lap the pack brakes into the corners together: the extra grip waits for the second lap (with
    // it, Alien GT3 fields went off at Spielberg's Turn 1 on lap 1 two races in six)
    const reach = this.started && car.clock.lapsDone === 0 ? 0 : this.mods.gripReach;
    const planGrip = PLAN_GRIP + (ceiling - PLAN_GRIP) * reach;
    const grip = Math.round(planGrip * car.pace * car.pace * weather * weather * damaged * 200) / 200;
    if (sim.aiPlan && grip === car.planGrip) return;
    this.aiTrack ??= aiTrackFor(this.track);
    const t = this.aiTrack;
    const lineId = sim.racingLineId ?? 'f1';
    let line = this.classLines.get(lineId);
    if (!line) {
      line = new Float64Array(t.n);
      for (let i = 0; i < t.n; i++) line[i] = aiLineOffsetM(this.track.getSampleAtDistance(i * t.ds), lineId);
      this.classLines.set(lineId, line);
    }
    sim.aiPlan = makeDrivePlan(t, line, carLimitsFor(sim.vehicleId, grip));
    car.planGrip = grip;
    // The LC26's driver takes a tuning target in place of its profile's speeds: with a plan, the plan's speeds rule
    if (sim.vehicleId === 'lc26') car.hooks?.setTarget(null);
  }

  public attachTrackRoot(root: THREE.Object3D): void {
    for (const car of this.cars) {
      car.ai?.attachTrackRoot?.(root);
    }
  }

  private makeCar(
    id: string,
    code: string,
    teamColorHex: string,
    sim: SimulatorCar,
    ai: SimulatorCar | null,
    pace: number
  ): FieldCar {
    const clock = new LapClock(this.track.totalLengthM);
    return {
      clock,
      get distM() {
        return clock.distM;
      },
      get finishTimeS() {
        return clock.finishTimeS;
      },
      get finishLaps() {
        return clock.finishLaps;
      },
      get bestLapMs() {
        return clock.bestLapMs;
      },
      get lastLapMs() {
        return clock.lastLapMs;
      },
      id,
      code,
      teamColorHex,
      isPlayer: ai === null,
      sim,
      ai,
      defPace: pace,
      basePace: pace,
      pace,
      aggression: 0,
      consistencyBias: 0,
      hooks: null,
      learner: null,
      rng: Math.random,
      cornerBrakeErr: new Float32Array(0),
      mistakeCorner: -1,
      stats: emptyStats(),
      wasOff: false,
      lastWallMs: 0,
      prevVx: 0,
      inWallHit: false,
      contact: false,
      control: ai ? new AiCarControl() : null,
      damage: new CarDamage(this.damageLevel, CAR_LEN_M / 2, CAR_WID_M / 2, seededRng(hashString(code) ^ 0x5bd1e995)),
      retired: false,
      retiredAtS: null,
      removed: false,
      lastWallDamageMs: 0,
      craft: new RacecraftMemory(),
      gridSlot: 0,
      planGrip: 0,
      local: null,
      localAtS: -Infinity,
      intentD: null,
      defending: false,
      startLaneM: null,
      launchReactS: 0,
      prevS: 0,
      biasM: 0,
      stuckS: 0,
      peer: {
        peerId: id,
        driverCode: code,
        teamColorHex,
        vehicle: sim.vehicleId ?? this.player.vehicleId,
        position: sim.worldPosition.clone(),
        quaternion: sim.worldQuaternion.clone(),
        linearVelocity: new THREE.Vector3(),
        steerAngle: 0,
        wheelRPMs: [0, 0, 0, 0],
        throttle: 0,
        brake: 0,
        trackS: sim.sMeters,
        speedKmh: 0,
        isAiPeer: true,
      },
    };
  }

  /** The player is held on the grid until the lights go out */
  get playerFrozen(): boolean {
    return this.phase === 'lights';
  }

  /**
   * Lines the field up: AI cars in grid order, the player behind them. A standing start runs the
   * light sequence (five reds one second apart, then a random 0.2–3 s hold); a rolling start
   * queues the cars on the main straight, all at one formation speed, and races at once.
   */
  public startRace(standing: boolean): void {
    const L = this.track.totalLengthM;
    this.raceCount++;
    this.environment.reset();
    this.assignGrid();
    this.cars.forEach((car) => {
      car.sim.resetToStartGrid(!standing, car.gridSlot, standing ? undefined : this.cars.length);
      if (car.ai) {
        car.ai.aiLineBiasM = 0;
        car.ai.aiSpeedCapMs = Infinity;
        car.rng = seededRng(this.seed ^ hashString(car.code));
        car.cornerBrakeErr = new Float32Array(this.corners.length);
        car.mistakeCorner = -1;
        car.stats = emptyStats();
        car.wasOff = false;
        car.lastWallMs = car.ai.telemetry.f12026?.wallImpact?.atMs ?? 0;
        car.prevVx = 0;
        car.contact = false;
        car.defending = false;
        car.inWallHit = false;
        car.learner = this.learning
          ? new AiSectionLearner(
              this.corners,
              L,
              this.persistLearning ? loadLearnedCorners(this.trackId, this.classId, car.code, this.corners.length) : undefined
            )
          : null;
      }
      car.damage.level = this.damageLevel;
      car.damage.rng = seededRng((this.seed + this.raceCount * 0x9e37) ^ hashString(car.code) ^ 0x5bd1e995);
      car.damage.reset();
      car.sim.setDamageEffects?.(null);
      car.retired = false;
      car.retiredAtS = null;
      car.removed = false;
      car.lastWallDamageMs = car.sim.telemetry.f12026?.wallImpact?.atMs ?? 0;
      car.craft.reset();
      if (car.control) {
        const traits = aiControlTraits(this.skillLevel, car.rng());
        car.control.reactionS = traits.reactionS;
        car.control.catchSlipRad = traits.catchSlipRad;
        car.control.reset();
      }
      // A standing start only: a rolling one is already under way at the green
      const launchDraw = car.ai ? launchReactionS(this.skillLevel, car.rng(), car.rng()) : 0;
      car.launchReactS = standing ? launchDraw : 0;
      // Start from the grid slot's lane, not the racing line, so the field does not file onto the line off the grid
      car.startLaneM = car.ai ? car.sim.lateralOffsetM : null;
      car.biasM = car.ai ? THREE.MathUtils.clamp(car.sim.lateralOffsetM - aiLineOffsetM(this.track.getSampleAtDistance(car.sim.sMeters), car.ai.racingLineId), -6, 6) : 0;
      if (car.ai) car.ai.aiLineBiasM = car.biasM;
      car.stuckS = 0;
      car.prevS = car.sim.sMeters;
      car.clock.reset(car.sim.sMeters);
      // After the per-race state above is cleared (newLap reads finishTimeS)
      if (car.ai) this.newLap(car);
      this.syncPeer(car);
    });
    this.player.aiAutopilot = false;
    this.playerPenaltyS = 0;
    this.raceTimeS = 0;
    this.gapTimer.reset();
    this.splitTimer.reset();
    this.playerSplits.reset();
    this.contactAt.clear();
    this.started = true;
    this.incidents.length = 0;
    this.raceControl.reset();
    this.yellowS.length = 0;
    this.passOrder = [];
    this.passTimerS = 0;
    this.phase = standing ? 'lights' : 'racing';
    this.lightsOn = 0;
    this.lightsTimerS = 0;
    this.holdS = 0.2 + this.rng() * 2.8;
  }

  /**
   * Grid slots for the race: the AI cars by pace, or by a qualifying session's worth of scatter (each driver's pace
   * with a lap's spread of luck), and the player's slot among them
   */
  private assignGrid(): void {
    const ai = this.cars.filter((c) => c.ai);
    const rng = seededRng(this.seed ^ 0x9e3779b9);
    const quali = new Map<FieldCar, number>();
    for (const c of ai) quali.set(c, this.gridOrder === 'qualifying' ? c.basePace * (1 + gaussian(rng) * 0.012) : c.basePace);
    ai.sort((a, b) => (quali.get(b) as number) - (quali.get(a) as number));
    if (this.gridOrder === 'reversed') ai.reverse();
    const player = this.cars.find((c) => c.isPlayer);
    const n = ai.length + (player ? 1 : 0);
    let playerSlot = n - 1;
    if (this.playerGrid === 'front') playerSlot = 0;
    else if (this.playerGrid === 'middle') playerSlot = Math.floor((n - 1) / 2);
    else if (this.playerGrid === 'random') playerSlot = Math.floor(rng() * n);
    let slot = 0;
    for (const c of ai) {
      if (player && slot === playerSlot) slot++;
      c.gridSlot = slot++;
    }
    if (player) player.gridSlot = playerSlot;
  }

  /** Advances the start procedure and steps the AI cars. Call after the player's physics step. */
  public update(dt: number): void {
    if (!(dt > 0)) return;
    if (this.phase === 'lights') {
      this.lightsTimerS += dt;
      this.lightsOn = Math.min(5, 1 + Math.floor(this.lightsTimerS / LIGHT_INTERVAL_S));
      if (this.lightsTimerS >= 4 * LIGHT_INTERVAL_S + LIGHT_INTERVAL_S + this.holdS) {
        this.phase = 'racing';
        this.lightsOn = 0;
      }
      for (const car of this.cars) this.syncPeer(car);
      return;
    }

    this.raceTimeS += dt;
    this.incidents.length = 0;
    if (this.ownsEnvironment) this.environment.update(dt, this.allSims);
    this.updateYellows();
    this.planTraffic(dt);
    for (const car of this.cars) {
      car.contact = false;
      const sim = car.ai;
      if (!sim || car.removed) continue;
      const ctl = car.control as AiCarControl;
      const wasSpinning = ctl.mode === 'spinning';
      const wasDriving = ctl.mode === 'racing' || ctl.mode === 'rejoining';
      const out = ctl.update(dt, this.controlState(car), this.clearBehind(car));
      // Back on the autopilot after a knock or a spin: its line starts where the car is and eases back (the traffic
      // bias is rate-limited), rather than the tracker snatching it back across metres of road
      if (!wasDriving && (ctl.mode === 'racing' || ctl.mode === 'rejoining')) {
        const line = aiLineOffsetM(this.track.getSampleAtDistance(sim.sMeters), sim.racingLineId);
        car.biasM = THREE.MathUtils.clamp(sim.lateralOffsetM - line, -8, 8);
        sim.aiLineBiasM = car.biasM;
      }
      if (!wasSpinning && ctl.mode === 'spinning') {
        car.stats.spins++;
        car.learner?.interrupt();
        this.incidents.push({ kind: 'spin', code: car.code, isPlayer: false, s: sim.sMeters });
      }
      if (out.autopilot) {
        sim.aiAutopilot = true;
        if (out.speedCapMs < (sim.aiSpeedCapMs ?? Infinity)) sim.aiSpeedCapMs = out.speedCapMs;
        // Lights out: on the brakes until the driver reacts
        if (this.raceTimeS < car.launchReactS) sim.aiSpeedCapMs = 0;
        sim.step(dt, {});
      } else {
        sim.aiAutopilot = false;
        sim.step(dt, out.inputs);
      }
    }
    this.resolveContacts();
    this.recoverStuckCars(dt);
    for (const car of this.cars) {
      this.observeDamage(car);
      if (car.ai && !car.removed) this.observe(car, dt);
      this.trackDistance(car);
      this.syncPeer(car);
    }
    this.raceControl.update(this.raceTimeS, this.incidents, this.playerUnderYellow());
    this.countPasses();
  }

  /** Running order on the road a few times a second, for the passes made (retired cars are left out) */
  private passOrder: FieldCar[] = [];
  private passTimerS = 0;
  private countPasses(): void {
    if (this.raceTimeS - this.passTimerS < 0.25) return;
    this.passTimerS = this.raceTimeS;
    const running = this.cars.filter((c) => !c.retired && c.finishTimeS === null);
    const order = [...running].sort((a, b) => b.distM - a.distM);
    const prev = this.passOrder.filter((c) => running.includes(c));
    if (prev.length === order.length) {
      for (let i = 0; i < order.length; i++) {
        const was = prev.indexOf(order[i]);
        if (was > i) order[i].stats.passes += was - i;
      }
    }
    this.passOrder = order;
  }

  /** The player is coming up on a yellow flag (someone else's incident ahead) */
  public playerUnderYellow(): boolean {
    const me = this.cars.find((c) => c.isPlayer);
    if (!me || this.phase !== 'racing') return false;
    const L = this.track.totalLengthM;
    for (const c of this.cars) {
      if (c === me || !this.isHazard(c)) continue;
      const sample = this.track.getSampleAtDistance(c.sim.sMeters);
      if (Math.abs(c.sim.lateralOffsetM) < sample.width / 2 + 4 && inYellowZone(me.sim.sMeters, c.sim.sMeters, L)) return true;
    }
    return false;
  }

  /** What the driver feels of the car, for its hands (`AiCarControl`) */
  private controlState(car: FieldCar): AiControlCarState {
    const sim = car.sim;
    const sample = this.track.getSampleAtDistance(sim.sMeters);
    const q = sim.worldQuaternion;
    const heading = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const err = heading - Math.atan2(sample.tangent.x, sample.tangent.z);
    const t = sim.telemetry;
    return {
      vxMs: sim.vxMs,
      vyMs: sim.vyMs,
      yawRateRadS: sim.yawRateRadS,
      roadYawRateRadS: sim.vxMs * sample.curvature,
      headingErrRad: Math.atan2(Math.sin(err), Math.cos(err)),
      lateralM: sim.lateralOffsetM,
      steer: sim.steerAngleNorm,
      throttle: t.throttle,
      brake: t.brake,
    };
  }

  /** No car is coming up on this stretch for the next few seconds: a stopped car may rejoin */
  private clearBehind(car: FieldCar): boolean {
    const L = this.track.totalLengthM;
    const me = car.sim;
    for (const other of this.cars) {
      if (other === car || other.removed) continue;
      const o = other.sim;
      const ds = wrapHalf(o.sMeters - me.sMeters, L);
      // Overlapping right here and moving, or closing from behind within ~3.5 s. A car stopped or crawling close by
      // (stuck too, or waiting itself) doesn't count: two cars that each waited for the other never moved again
      if (Math.abs(ds) < CAR_LEN_M && Math.abs(o.lateralOffsetM - me.lateralOffsetM) < 3 && Math.abs(o.vxMs) > 3) return false;
      if (ds < 0 && o.vxMs > 3 && -ds < Math.max(40, o.vxMs * 3.5)) return false;
    }
    return true;
  }

  /**
   * Damage from barrier hits (the rigid-body cars report each impact and where on the car it landed), and what
   * the damage does: the car's aero, grip and toe, and retirement
   */
  private observeDamage(car: FieldCar): void {
    if (car.removed) return;
    const sim = car.sim;
    const wall = sim.telemetry.f12026?.wallImpact;
    if (wall && wall.atMs !== car.lastWallDamageMs) {
      car.lastWallDamageMs = wall.atMs;
      if (wall.speedMs >= KNOCK_WALL_MS) car.control?.knock(this.controlState(car));
      const report = car.damage.registerImpact({ localX: wall.localX ?? 0, localZ: wall.localZ ?? CAR_LEN_M / 2, speedMs: wall.speedMs, source: 'wall' });
      if (report) this.incidents.push({ kind: 'damage', code: car.code, isPlayer: car.isPlayer, report, source: 'wall' });
    }
    this.applyDamage(car);
  }

  /** Hands the damage to the car's physics, and retires a car whose damage is terminal */
  private applyDamage(car: FieldCar): void {
    if (car.damage.pristine) return;
    car.sim.setDamageEffects?.(car.damage.effects());
    // Wrecked (no pit lane to fix it in): an AI driver parks it rather than spin round on three good corners
    const wrecked = car.ai !== null && car.damage.overall >= 0.85;
    if ((car.damage.terminal || wrecked) && !car.retired) {
      car.retired = true;
      car.retiredAtS = this.raceTimeS;
      car.control?.retire();
      this.incidents.push({ kind: 'retired', code: car.code, isPlayer: car.isPlayer, s: car.sim.sMeters });
      if (car.isPlayer) this.phase = 'finished';
    }
    // Stopped for a while: the marshals take the car away (the player's own car stays where it is)
    if (car.retired && car.ai && !car.removed && car.retiredAtS !== null && this.raceTimeS - car.retiredAtS > RETIRED_REMOVE_S && Math.abs(car.sim.vxMs) < 1) {
      car.removed = true;
    }
  }

  /** Incidents for the report, and what the car's learning sees this frame */
  private observe(car: FieldCar, dt: number): void {
    const sim = car.ai as SimulatorCar;
    const t = sim.telemetry;
    const off = t.offTrack;
    if (off && !car.wasOff) car.stats.offTracks++;
    car.wasOff = off;
    // A wall hit: the rigid-body cars report their impacts; on the LC26 it is a deceleration no brake can give
    const wall = t.f12026?.wallImpact;
    if (t.f12026) {
      if (wall && wall.atMs !== car.lastWallMs && wall.speedMs > 2) car.stats.wallHits++;
      car.lastWallMs = wall?.atMs ?? car.lastWallMs;
    } else {
      // One impact lasts several frames: count it once
      const hit = !car.contact && (sim.vxMs - car.prevVx) / dt < -75;
      if (hit && !car.inWallHit) car.stats.wallHits++;
      car.inWallHit = hit;
    }
    car.prevVx = sim.vxMs;
    // A jump along the track this frame is the car's own stuck recovery
    if (Math.abs(wrapHalf(sim.sMeters - car.prevS, this.track.totalLengthM)) > Math.max(15, Math.abs(sim.vxMs) * dt * 3 + 5)) {
      car.stats.stuckRecoveries++;
      car.learner?.interrupt();
    }
    const learner = car.learner;
    if (!learner) return;
    const sample = this.track.getSampleAtDistance(sim.sMeters);
    let maxSlip = 0;
    for (const w of sim.wheels) maxSlip = Math.max(maxSlip, w.combinedSlipNorm);
    const sr = t.wheelSlipRatios;
    learner.observe({
      s: sim.sMeters,
      offTrack: off,
      lineErrorM: Math.abs(sim.lateralOffsetM - aiLineOffsetM(sample, sim.racingLineId) - car.biasM),
      maxSlip,
      lockup: t.brake > 0.2 && Math.min(sr[0], sr[1], sr[2], sr[3]) < -0.2,
      trafficBiasM: car.biasM,
      contact: car.contact,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Traffic: give room to cars alongside, pass a slower car ahead on the side with more room, or
  // follow it when there is no room
  // ---------------------------------------------------------------------------------------------
  private planTraffic(dt: number): void {
    const L = this.track.totalLengthM;
    const decel = this.classId === 'gt3' ? 16 : 32;
    this.capPlayerAutopilot(L);
    // Leader first: each follower then plans against the paths the cars ahead have just chosen
    const order = [...this.cars].sort((a, b) => b.distM - a.distM);
    for (const car of order) {
      const me = car.ai;
      if (!me || car.removed) continue;
      const craft = car.craft;
      const sample = this.track.getSampleAtDistance(me.sMeters);
      const line = aiLineOffsetM(sample, me.racingLineId);
      const half = sample.width / 2 - 1.2;
      let targetLat: number | null = null;
      let speedCap = Infinity;
      let biasRate = BIAS_RATE_MS;
      // Racecraft here: the tuning (with its section overrides), the skill level and the driver's temperament.
      // At the shipped caution the passing rules are exactly the ones this field always raced with.
      const T = this.tuning;
      const yellow = this.underYellow(me.sMeters);
      const caution = THREE.MathUtils.clamp(
        T.at('overtakeCaution', me.sMeters) + this.mods.cautionAdd - 0.25 * this.aggressionOf(car) + this.raceControl.cautionOf(car.code, this.raceTimeS),
        0,
        1
      );
      const dc = caution - BASE_CAUTION;
      let passSpacing = this.rc.passSpacingM * (1 + 0.5 * dc);
      let minClosing = -1 + 3 * dc;
      const followGap = 12 + 10 * dc;
      const defend = THREE.MathUtils.clamp(T.params.defend * this.mods.defendMult + 0.2 * this.aggressionOf(car), 0, 1);

      let ahead: FieldCar | null = null;
      let aheadGap = Infinity;
      let attacker: FieldCar | null = null;
      let attackerGap = Infinity;
      let alongsideAhead: FieldCar | null = null;
      let squeezedBy: FieldCar | null = null;
      let hazard: FieldCar | null = null;
      let hazardGap = Infinity;
      let lapper: FieldCar | null = null;
      const hazardLook = 40 + me.vxMs * 3;
      for (const other of this.cars) {
        if (other === car || other.removed) continue;
        const ds = wrapHalf(other.sim.sMeters - me.sMeters, L);
        const dLat = other.sim.lateralOffsetM - me.lateralOffsetM;
        const along = overlapNow(craft.alongside.get(other.id) ?? false, ds, dLat, CAR_LEN_M, CAR_WID_M);
        craft.alongside.set(other.id, along);
        // A car spun, stopped or crawling: an obstacle to pass, not a car to race (and never one to follow in)
        if (this.isHazard(other)) {
          if (ds > -CAR_LEN_M && ds < hazardLook && ds < hazardGap) {
            hazard = other;
            hazardGap = ds;
          }
          continue;
        }
        // Alongside: keep a car's width of room
        if (Math.abs(ds) < CAR_LEN_M + 1.5 && Math.abs(dLat) < this.rc.alongsideSpacingM) {
          const away = me.lateralOffsetM >= other.sim.lateralOffsetM ? 1 : -1;
          targetLat = other.sim.lateralOffsetM + away * this.rc.alongsideSpacingM;
          // Squeezed against the edge with no room left on that side and not clearly ahead: back out of it
          if (Math.abs(targetLat) > half && ds > -0.5 * CAR_LEN_M) squeezedBy = other;
        }
        // Side by side with its nose behind the other car's: the one that yields if a corner comes and it doesn't own it
        if (ds > 0.5 && along && Math.abs(dLat) < this.rc.alongsideSpacingM + 0.6) alongsideAhead = other;
        if (ds > 0 && ds < 90 && Math.abs(dLat) < CAR_WID_M + 0.4 && ds < aheadGap) {
          ahead = other;
          aheadGap = ds;
        }
        // A pass under way: the car being passed stays the one to pass once we are out of its wake, until we are by
        if (craft.passTargetId === other.id && ds > 0 && ds < 90 && ds < aheadGap) {
          ahead = other;
          aheadGap = ds;
        }
        // Closing in from behind, not yet alongside
        if (ds < -CAR_LEN_M && ds > -this.rc.defendLookM && other.sim.vxMs - me.vxMs > this.rc.defendClosingMs && -ds < attackerGap) {
          attacker = other;
          attackerGap = -ds;
        }
        // Blue flag: a car a lap (or more) up, coming up behind
        if (ds < 0 && ds > -90 && other.distM > car.distM + 0.5 * L && other.finishTimeS === null) lapper = other;
        // A car in our path: never closer than we could still stop behind it if it braked now (the pack into a
        // braking zone, each car on its own braking point, otherwise ran into each other's gearboxes)
        if (ds > 0 && ds < 80 && Math.abs(dLat) < CAR_WID_M + 0.35) {
          speedCap = Math.min(speedCap, followCapMs(other.sim, ds - CAR_LEN_M, this.rc));
        }
      }

      // Tight corners leave little room to run off-line, so look as far ahead as the car needs to
      // brake: a pass started on the straight must not reach the hairpin off-line
      let kAbs = Math.abs(sample.curvature);
      let kNext = sample.curvature;
      let distToCorner = Math.abs(sample.curvature) > 0.006 ? 0 : Infinity;
      const lookM = 30 + (me.vxMs * me.vxMs) / 60;
      for (let d = 10; d <= lookM; d += 10) {
        const k = this.track.getSampleAtDistance((me.sMeters + d) % L).curvature;
        if (Math.abs(k) > 0.006 && !Number.isFinite(distToCorner)) distToCorner = d;
        if (Math.abs(k) > kAbs) {
          kAbs = Math.abs(k);
          kNext = k;
        }
      }
      let maxBias = kAbs > 0.012 ? 1.2 : kAbs > 0.006 ? 2.5 : 6;
      const insideSign = Math.sign(kNext);
      const inCorner = Math.abs(sample.curvature) > 0.004;
      // A new straight: the defence count starts again, and a pass commitment ends with the corner it was for
      if (inCorner) craft.defendMoves = 0;
      if (craft.commitSide !== 0 && wrapHalf(me.sMeters - craft.commitUntilS, L) > 0) craft.commitSide = 0;

      if (ahead && targetLat === null) {
        const closing = me.vxMs - ahead.sim.vxMs;
        // About half a second at speed: the slipstream reaches that far, and a pass is set up from there
        const reactGap = 8 + Math.max(0, closing) * 2.2 + me.vxMs * this.rc.reactGapS;
        // Lapping a backmarker: go by readily (it is told to let us through)
        const lapping = ahead.distM < car.distM - 0.5 * L;
        if (lapping) {
          minClosing = Math.min(minClosing, -2);
          passSpacing *= 0.85;
        }
        if (aheadGap < reactGap) {
          const aLat = ahead.sim.lateralOffsetM;
          // Its wake runs down its line: where it is off its own line, carried onto ours here. The line swings across the
          // road between two cars 15 m apart, and the raw offset pulled the follower off its line through a kink and
          // read as "out of the wake" when it wasn't, so it pulled out far too early and lost the tow
          const aLatHere = line + aLat - aiLineOffsetM(this.track.getSampleAtDistance(ahead.sim.sMeters), me.racingLineId);
          const roomRight = half - aLat;
          const roomLeft = aLat + half;
          let side = roomRight >= roomLeft ? 1 : -1;
          if (craft.passTargetId === ahead.id && craft.passSide !== 0) side = craft.passSide;
          if (craft.commitSide !== 0) side = craft.commitSide;
          const room = side > 0 ? roomRight : roomLeft;
          // A pass that can't draw alongside before the corner is a lunge: wait for the next straight
          const cornerV = Number.isFinite(distToCorner)
            ? (this.track.getSampleAtDistance((me.sMeters + distToCorner) % L).optimalSpeedKmh / 3.6) * car.pace
            : me.vxMs;
          const brakingZone = brakingDistanceM(me.vxMs, cornerV, decel);
          // The car ahead on less grip brakes earlier for a slower corner (its speeds go with its pace, its braking with
          // pace²): the metres that buys a later braker
          const paceRatio = THREE.MathUtils.clamp(ahead.pace / Math.max(0.5, car.pace), 0.8, 1.25);
          const itsZone = brakingDistanceM(ahead.sim.vxMs, cornerV * paceRatio, decel * paceRatio * paceRatio);
          // Holding a pass already under way needs less than starting one: the tow is gone once out of it
          const holding = craft.passTargetId === ahead.id;
          // A committed pass not alongside by the turn-in is over: the corner is the other car's. Held on into it, the
          // passing car ran down the inside a few metres behind and the other car turned in across its nose
          if (craft.commitSide !== 0 && holding && (inCorner || distToCorner <= 10) && aheadGap > 0.5 * CAR_LEN_M) craft.commitSide = 0;
          const feasible =
            craft.commitSide !== 0 ||
            passFeasible({
              gapM: aheadGap,
              closingMs: closing,
              speedMs: me.vxMs,
              distToCornerM: distToCorner,
              brakingZoneM: brakingZone,
              // A bold driver will finish the pass deeper into the braking zone
              brakingShare: 0.35 + 0.3 * Math.max(0, this.aggressionOf(car)),
              brakeGainM: itsZone - brakingZone,
            });
          if (!yellow && room >= passSpacing && (closing > minClosing || (holding && closing > minClosing - 2.5)) && feasible) {
            // Use the tow first: stay in the car's wake until close, then pull out with the speed it gave. Out of
            // the wake too early, the passing car lost the tow and never had the speed to get by. Already out (or
            // alongside), the move is held
            const noseToTail = aheadGap - CAR_LEN_M;
            // The move across takes time, the gap closing all the while: it starts that much sooner. Started at the
            // pull-out distance alone, the car was still in line when it ran up to the gearbox, and the follow cap took
            // its speed away
            const moveS = passSpacing / PULL_OUT_RATE_MS;
            const pullOut = this.rc.pullOutBaseM + Math.max(0, closing) * (this.rc.pullOutClosingS + moveS) + (Number.isFinite(distToCorner) ? 6 : 0);
            const out = Math.abs(me.lateralOffsetM - aLatHere) > CAR_WID_M * 0.75;
            if (noseToTail > pullOut && !out && !holding) {
              targetLat = aLatHere;
            } else {
              targetLat = aLat + side * passSpacing;
              craft.passTargetId = ahead.id;
              craft.passSide = side;
              if (!out) biasRate = PULL_OUT_RATE_MS;
            }
            // Committed once the braking zone for the corner is near: no switching sides on the brakes
            if (craft.commitSide === 0 && Number.isFinite(distToCorner) && distToCorner < brakingZone + 80) {
              craft.commitSide = side;
              craft.commitUntilS = (me.sMeters + distToCorner + 120) % L;
            }
          } else {
            // No room, no time or a yellow: sit in the tow and wait. A pass called off with the car already out beside
            // the other's gearbox backs off first (below)
            const outBeside = Math.abs(me.lateralOffsetM - aLatHere) > CAR_WID_M * 0.75;
            if (holding && outBeside) {
              craft.backOffId = ahead.id;
              craft.backOffSide = Math.sign(me.lateralOffsetM - aLatHere);
            }
            craft.passTargetId = null;
            speedCap = ahead.sim.vxMs + Math.max(-4, (aheadGap - followGap) * 0.5);
          }
        }
      }
      // The pass is done (the other car is behind) or off (it is far ahead again)
      if (craft.passTargetId !== null && (!ahead || ahead.id !== craft.passTargetId)) craft.passTargetId = null;
      // Backing off a pass called off: stay out beside the other car's line and drop back behind it before moving back
      // across. Moving back at once, with the run's speed and the corner's braking under way, put the nose into its
      // gearbox. Done once a few metres behind it and no quicker, or once it is gone, alongside or a hazard
      let holdingOut = false;
      if (craft.backOffId !== null) {
        const o = this.cars.find((c) => c.id === craft.backOffId);
        const dsO = o && !o.removed ? wrapHalf(o.sim.sMeters - me.sMeters, L) : -Infinity;
        const behindBy = dsO - CAR_LEN_M;
        // (a car spun or stopped is a hazard, passed as one: no backing off behind it)
        if (!o || this.isHazard(o) || dsO <= 0 || dsO > 60 || (behindBy > 4 && me.vxMs <= o.sim.vxMs + 1)) {
          craft.backOffId = null;
        } else {
          const oLatHere = line + o.sim.lateralOffsetM - aiLineOffsetM(this.track.getSampleAtDistance(o.sim.sMeters), me.racingLineId);
          if (targetLat === null) {
            targetLat = oLatHere + craft.backOffSide * Math.max(Math.abs(me.lateralOffsetM - oLatHere), CAR_WID_M + 0.5);
            holdingOut = true;
          }
          // ... and never closer than it could stop behind the other car if that braked now: held beside it, the corner's
          // room took the car back across onto its line while the other braked for the turn-in
          speedCap = Math.min(speedCap, Math.max(0, o.sim.vxMs - 1), followCapMs(o.sim, behindBy, this.rc));
        }
      }

      // Off the start: run down the grid lane, side by side, until the first corner comes into view
      if (car.startLaneM !== null) {
        if (kAbs > 0.006 || car.distM > this.rc.startLaneMaxM) car.startLaneM = null;
        else if (targetLat === null) targetLat = car.startLaneM;
      }
      // Two cars can't take one corner side by side: the one behind on the way in gives the place up and tucks in
      // behind, unless the corner is its own (on the inside, nose at least at the other's middle)
      if (alongsideAhead && kAbs > 0.006) {
        const dsA = wrapHalf(alongsideAhead.sim.sMeters - me.sMeters, L);
        const owns = ownsCorner(dsA, me.lateralOffsetM, alongsideAhead.sim.lateralOffsetM, insideSign, CAR_LEN_M);
        // Tuck in behind: drop back by the overlap before the turn-in, not just ease off (1.5 m/s slower took a second
        // to clear a part overlap while the car ahead moved across onto its line, into the front wheel)
        const overlapM = Math.max(0, CAR_LEN_M + 0.5 - dsA);
        if (!owns) speedCap = Math.min(speedCap, alongsideAhead.sim.vxMs - THREE.MathUtils.clamp(1.5 * overlapM, 1.5, 5));
      }
      if (squeezedBy) speedCap = Math.min(speedCap, squeezedBy.sim.vxMs - 2);
      // Defending: a quicker car closing from behind and a real corner coming: cover the inside, the move made while
      // still on the throttle (never started under braking, never while a pass of our own is on), held through the
      // braking zone and given up once the car is in the corner itself, where it rejoins its own line to make the turn.
      // One move per straight; none against a car lapping us, none under a yellow
      // Off the start the grid lane gives way to it: the run to the first corner is where places go, and a car that
      // only held its lane was driven past by anything quicker off the line
      const onStartLane = car.startLaneM !== null && targetLat === car.startLaneM;
      const mayDefend =
        (targetLat === null || onStartLane) && attacker !== null && defend > 0 && (kAbs > 0.006 || onStartLane) && !inCorner && !lapper && !yellow;
      // ... and only with room to make it: the move must be made before the attacker gets there (a move across the
      // nose of a car already right behind is a brake test). Half a car length plus 0.8 s of the closing speed (defaults)
      const attackerClosing = attacker ? Math.max(0, attacker.sim.vxMs - me.vxMs) : 0;
      const startsDefence =
        !car.defending && craft.defendMoves < 1 && me.telemetry.brake < 0.05 && attackerGap > 0.5 * CAR_LEN_M + this.rc.defendRoomS * attackerClosing;
      const wasDefending = car.defending;
      car.defending = mayDefend && (car.defending || startsDefence);
      if (car.defending && !wasDefending && attacker) {
        craft.defendMoves++;
        // Cover the side the attacker is going for; one directly behind gets the inside of the corner ahead covered
        const dLatAtt = attacker.sim.lateralOffsetM - me.lateralOffsetM;
        const side = Math.abs(dLatAtt) > 0.8 || insideSign === 0 ? Math.sign(dLatAtt) || 1 : insideSign;
        const from = onStartLane ? me.lateralOffsetM : line;
        const reach = Math.abs(dLatAtt) > 0.8 ? Math.min(Math.abs(dLatAtt), this.rc.defendReachM * defend) : this.rc.defendReachM * defend;
        const to = THREE.MathUtils.clamp(from + side * reach, -half, half);
        craft.defendOffLine = onStartLane;
        craft.defendLatM = onStartLane ? to : to - line;
        // The new lane is the one held to the first corner: going back to the grid slot's would be a second move
        if (onStartLane) car.startLaneM = to;
      }
      if (car.defending) targetLat = THREE.MathUtils.clamp(craft.defendOffLine ? craft.defendLatM : line + craft.defendLatM, -half, half);
      // Blue flag: give the car lapping us the inside of the next corner and a little room
      let blueLift = 1;
      if (lapper && targetLat === null) {
        targetLat = line - insideSign * 1.8;
        blueLift = 0.98;
      }
      // A hazard ahead: pass it on the side with room, quicker off the line than for traffic; slowly if the gap
      // is tight, and stop short of it if the road is blocked
      if (hazard) {
        const hs = hazard.sim;
        const hHalf = hazardHalfWidthM(this.headingErr(hs), CAR_LEN_M, CAR_WID_M);
        const hl = hazardLine(hs.lateralOffsetM, hHalf, sample.width / 2 - 0.3, CAR_WID_M, line);
        const gap = Math.max(0, hazardGap - CAR_LEN_M);
        if (hl) {
          targetLat = hl.latM;
          maxBias = Math.max(maxBias, sample.width / 2);
          biasRate = 5;
          // Not on the clear line yet, or little room beside it: slow enough to stop short if it goes wrong
          const offLine = Math.abs(me.lateralOffsetM - hl.latM) > 1;
          if (offLine || hl.roomM < CAR_WID_M + 1.5) speedCap = Math.min(speedCap, Math.max(hs.vxMs + 6, Math.sqrt(2 * 0.6 * decel * Math.max(0, gap - 4))));
        } else {
          speedCap = Math.min(speedCap, Math.max(0, Math.sqrt(2 * 0.6 * decel * Math.max(0, gap - 6))));
        }
      }
      let pos = targetLat === null ? null : THREE.MathUtils.clamp(targetLat, -half, half);
      // Corner margins from the tuning: keep the car's centre this far inside the inside / outside edge
      const intM = T.at('intMarginM', me.sMeters);
      const extM = T.at('extMarginM', me.sMeters);
      if (intM > 0 || extM > 0) {
        const k = this.track.getSampleAtDistance((me.sMeters + Math.max(5, me.vxMs * 0.4)) % L).curvature;
        if (Math.abs(k) > 0.002) {
          const edge = sample.width / 2;
          // + curvature is a right-hander: its inside is the + (right) side
          const rightM = k > 0 ? intM : extM;
          const leftM = k > 0 ? extM : intM;
          const hi = rightM > 0 ? Math.max(0, edge - rightM) : Infinity;
          const lo = leftM > 0 ? -Math.max(0, edge - leftM) : -Infinity;
          const want = pos ?? line;
          const kept = THREE.MathUtils.clamp(want, lo, hi);
          if (Math.abs(kept - want) > 1e-3) pos = kept;
        }
      }
      // (backing off beside a car, the corner's room is no limit: held to it, the car was taken back across into the other)
      if (holdingOut) maxBias = Math.max(maxBias, sample.width / 2);
      const biasTarget = pos === null ? 0 : THREE.MathUtils.clamp(pos - line, -maxBias, maxBias);
      // A pass the corner ahead has no room for: held to its line there, the passing car is back in the other car's path,
      // so it follows it in. With a run from the tow and a later braking point, it went on and ran into its rear corner
      let passBlocked = false;
      if (craft.passTargetId !== null && ahead && ahead.id === craft.passTargetId && aheadGap > 0.5 * CAR_LEN_M) {
        // (both off their lines: where we will be against where it is, carried onto our line here)
        const aheadOff = ahead.sim.lateralOffsetM - aiLineOffsetM(this.track.getSampleAtDistance(ahead.sim.sMeters), me.racingLineId);
        if (Math.abs(biasTarget - aheadOff) < CAR_WID_M + 0.35) {
          passBlocked = true;
          speedCap = Math.min(speedCap, followCapMs(ahead.sim, aheadGap - CAR_LEN_M, this.rc));
        }
      }
      if (this.localPlanner && me.aiPlan && car.control?.racing !== false && this.trafficNear(car)) {
        // The local planner chooses the path among the cars around: the behaviour above is its intent
        car.intentD = pos === null && !hazard ? null : biasTarget;
        const capped = this.planAround(car, car.intentD, speedCap);
        speedCap = Math.min(speedCap, capped);
        // The planner says where to be; the bias moves there at the usual rate (quicker for a hazard). Handing over the
        // planned offset a moment ahead instead never converged: a smooth move starts slowly, so each replan from the
        // car's own position left it where it was
        const goal = car.local ? car.local.endD : biasTarget;
        car.biasM += THREE.MathUtils.clamp(goal - car.biasM, -biasRate * dt, biasRate * dt);
      } else {
        car.local = null;
        car.biasM += THREE.MathUtils.clamp(biasTarget - car.biasM, -biasRate * dt, biasRate * dt);
      }
      me.aiLineBiasM = car.biasM;
      // Off-line and in dirty air the corner is tighter than planned: give a little speed away for it
      const wakeFrontMult = me.telemetry.aeroWakeDownforceMult ?? 1;
      // (the physics lose the downforce; this is the driver's margin for it: a car on a drive plan runs at its real limit
      // and spun in the wake at a smaller one). A planned car gives it away only where a corner sets its speed: on the
      // straights it scaled the whole plan, and the car in the tow ran 2 % under its own top speed and never got by
      const dirtyAirShare = me.aiPlan ? this.rc.dirtyAirMargin * cornerLimitedShare(me.aiPlan, me.sMeters, me.vxMs, lookM) : 0.05;
      const dirtyAirPenalty = 1 - dirtyAirShare * Math.max(0, 1 - wakeFrontMult);
      // Rain: the pace the tyres' grip on this much water allows (weather.ts / track-environment.ts)
      const weatherPace = this.environment.weatherPaceScale(me);
      // Yellow flag: lift through the zone
      const yellowLift = yellow ? 0.93 : 1;
      // Making a pass stick: a little more into the corner (a later brake, more speed) once alongside
      const passing = craft.passTargetId !== null && ahead !== null && aheadGap < CAR_LEN_M * 1.2 && !passBlocked;
      const attackPush = passing ? 1 + this.rc.attackPush * (1 + Math.max(0, this.aggressionOf(car))) : 1;
      // A car on a drive plan has its pace and the weather in the plan's grip already
      this.refreshPlan(car);
      const planned = me.aiPlan ? 1 : car.pace * weatherPace;
      // (a planned car's speed off the line is the planner's, from its path: no blanket slow-down per metre)
      const offLine = me.aiPlan ? 1 : 1 - 0.012 * Math.abs(car.biasM);
      me.aiPaceScale = Math.min(me.aiPlan ? 1.03 : 0.999, planned * attackPush) * offLine * dirtyAirPenalty * yellowLift * blueLift;
      me.aiSpeedCapMs = speedCap;
      me.aiTopSpeedOpen = yellowLift === 1 && blueLift === 1;
      car.hooks?.setSteerGain(T.at('steerGain', me.sMeters));
      // Rain changed the grip the car plans on: new corner speeds and braking points
      if (car.hooks?.refresh?.()) this.rebuildTarget(car);
    }
  }

  /**
   * The player's car on autopilot drives its line blind to traffic: in a race it gets the same "never closer than it
   * could stop" cap as the AI cars, or it runs into the back of them
   */
  private capPlayerAutopilot(L: number): void {
    const me = this.cars.find((c) => c.isPlayer);
    if (!me) return;
    const sim = me.sim;
    if (!sim.aiAutopilot) {
      if (sim.aiSpeedCapMs !== undefined && sim.aiSpeedCapMs !== Infinity) sim.aiSpeedCapMs = Infinity;
      return;
    }
    let cap = Infinity;
    for (const other of this.cars) {
      if (other === me || other.removed) continue;
      const ds = wrapHalf(other.sim.sMeters - sim.sMeters, L);
      if (ds > 0 && ds < 80 && Math.abs(other.sim.lateralOffsetM - sim.lateralOffsetM) < CAR_WID_M + 0.35) {
        cap = Math.min(cap, followCapMs(other.sim, ds - CAR_LEN_M, this.rc));
      }
    }
    sim.aiSpeedCapMs = cap;
  }

  /** Usable offsets per AI grid point for each racing line class (from a car's own usable road), built once */
  private readonly classBounds = new Map<string, { lo: Float64Array; hi: Float64Array }>();

  private boundsFor(sim: SimulatorCar): { lo: Float64Array; hi: Float64Array } {
    const id = sim.racingLineId ?? 'f1';
    let b = this.classBounds.get(id);
    if (b) return b;
    const t = (this.aiTrack ??= aiTrackFor(this.track));
    const rangeAt = (sim as unknown as { lateralRangeAt?: (s: number) => [number, number] }).lateralRangeAt?.bind(sim);
    const lo = new Float64Array(t.n), hi = new Float64Array(t.n);
    for (let i = 0; i < t.n; i++) {
      const [a, c] = rangeAt ? rangeAt(i * t.ds) : [-(t.width[i] / 2 - 1.2), t.width[i] / 2 - 1.2];
      lo[i] = a;
      hi[i] = c;
    }
    b = { lo, hi };
    this.classBounds.set(id, b);
    return b;
  }

  /**
   * Whether the local planner runs: a car (or a hazard) ahead within 120 m, and nobody alongside. Side by side the
   * car keeps to the racecraft rules (a car's width of room, yielding a corner it doesn't own), which hold the space
   * the other driver is owed; the planner chooses how to approach and pass the cars ahead
   */
  private trafficNear(car: FieldCar): boolean {
    const L = this.track.totalLengthM;
    const me = car.sim;
    let ahead = false;
    for (const o of this.cars) {
      if (o === car || o.removed) continue;
      const ds = wrapHalf(o.sim.sMeters - me.sMeters, L);
      if (Math.abs(ds) < CAR_LEN_M + 1.5 && Math.abs(o.sim.lateralOffsetM - me.lateralOffsetM) < 4.5) return false;
      if (ds >= CAR_LEN_M + 1.5 && ds < 120) ahead = true;
    }
    return ahead;
  }

  /** Where another car will be over the planner's horizon: its own fresh plan if it has one, else steady as it goes */
  private predict(other: FieldCar): PredictedCar {
    const s = new Float64Array(PLAN_STEPS), n = new Float64Array(PLAN_STEPS);
    const o = other.sim;
    const loc = other.local;
    const age = this.raceTimeS - other.localAtS;
    if (loc && age < 0.35 && other.control?.racing !== false) {
      for (let k = 1; k <= PLAN_STEPS; k++) {
        const x = Math.min(PLAN_STEPS, Math.max(1, k + age / PLAN_DT)) - 1;
        const i0 = Math.floor(x), i1 = Math.min(PLAN_STEPS - 1, i0 + 1), f = x - i0;
        s[k - 1] = loc.s[i0] + (loc.s[i1] - loc.s[i0]) * f;
        n[k - 1] = loc.n[i0] + (loc.n[i1] - loc.n[i0]) * f;
      }
    } else {
      const v = Math.max(0, o.vxMs);
      for (let k = 1; k <= PLAN_STEPS; k++) {
        s[k - 1] = o.sMeters + v * k * PLAN_DT;
        n[k - 1] = o.lateralOffsetM;
      }
    }
    const haz = this.isHazard(other);
    // A car sideways across the road is wider than its width
    return { s, n, halfLenM: CAR_LEN_M / 2, halfWidM: haz ? hazardHalfWidthM(this.headingErr(o), CAR_LEN_M, CAR_WID_M) : CAR_WID_M / 2, hazard: haz };
  }

  /**
   * Runs the local planner for a car (every 0.1 s; in between, the last plan is followed) and hands its path to the
   * tracker as the line bias a little ahead. Returns the speed cap the plan asks for (Infinity: none beyond the
   * path's limit)
   */
  private planAround(car: FieldCar, intentD: number | null, speedCap: number): number {
    const me = car.ai as SimulatorCar;
    const plan = me.aiPlan;
    if (!plan) return Infinity;
    const L = this.track.totalLengthM;
    if (!car.local || this.raceTimeS - car.localAtS >= 0.1) {
      const others: PredictedCar[] = [];
      for (const o of this.cars) {
        if (o === car || o.removed) continue;
        const ds = wrapHalf(o.sim.sMeters - me.sMeters, L);
        if (ds > -40 && ds < 220) others.push(this.predict(o));
      }
      const smp = this.track.getSampleAtDistance(me.sMeters);
      const vel = me.worldVelocity;
      const bl = Math.hypot(smp.binormal.x, smp.binormal.z) || 1;
      const nDot = vel ? (vel.x * smp.binormal.x + vel.z * smp.binormal.z) / bl : 0;
      const b = this.boundsFor(me);
      car.local = planLocal({
        track: plan.track,
        line: plan.n,
        lineKappa: plan.kappa,
        // (past the top speed in a tow, as the tracker: `F12026CarSim.planSpeedTarget`)
        vLimit: me.aiTopSpeedOpen ? plan.vOpen : plan.v,
        limits: plan.limits,
        lo: b.lo,
        hi: b.hi,
        s: me.sMeters,
        n: me.lateralOffsetM,
        nDot,
        v: Math.max(1, me.vxMs),
        halfLenM: CAR_LEN_M / 2,
        halfWidM: CAR_WID_M / 2,
        others,
        intentD,
        speedCapMs: speedCap,
        // With no intent, the line is home: leaving it has to buy real progress
        weights: {
          ...DEFAULT_PLANNER_WEIGHTS,
          intent: this.rc.plannerIntent,
          proximity: this.rc.plannerProximity,
          consistency: this.rc.plannerConsistency,
          line: intentD === null ? this.rc.plannerLine : DEFAULT_PLANNER_WEIGHTS.line,
        },
        prevEndD: car.local?.endD ?? car.biasM,
      });
      car.localAtS = this.raceTimeS;
    }
    const loc = car.local;
    const tAhead = this.raceTimeS - car.localAtS + 0.3;
    const i1 = Math.min(PLAN_STEPS - 1, Math.ceil(Math.max(1, tAhead / PLAN_DT)) - 1);
    // The path's own aim a little ahead: its corner limit off the line, a slower version's scale, a boxed-in car's
    // braking (on the line at full scale this is the line's envelope, which the tracker follows anyway)
    const aim = loc.vAim[Math.min(PLAN_STEPS - 1, i1)] + 0.5;
    return Math.abs(loc.endD) > 0.4 || loc.speedScale < 1 || loc.boxedIn ? aim : Infinity;
  }

  /** A car the others treat as an obstacle: spinning, stopped or crawling, or retired and not yet taken away */
  private isHazard(car: FieldCar): boolean {
    if (car.removed) return false;
    if (car.retired || car.control?.incident) return true;
    // Off the start everyone is slow; and a finished car on its in-lap is no obstacle anyone races
    if (this.raceTimeS < 10 || car.distM < 150) return false;
    const road = this.track.getSampleAtDistance(car.sim.sMeters).optimalSpeedKmh / 3.6;
    return isHazardSpeed(Math.abs(car.sim.vxMs), road) || Math.abs(this.headingErr(car.sim)) > 1.2;
  }

  /** Heading against the track direction (rad, ±π) */
  private headingErr(sim: SimulatorCar): number {
    const sample = this.track.getSampleAtDistance(sim.sMeters);
    const q = sim.worldQuaternion;
    const heading = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const err = heading - Math.atan2(sample.tangent.x, sample.tangent.z);
    return Math.atan2(Math.sin(err), Math.cos(err));
  }

  /** Lap distances of the hazards on the road (yellow flags), refreshed each frame */
  private readonly yellowS: number[] = [];

  private updateYellows(): void {
    this.yellowS.length = 0;
    for (const c of this.cars) {
      if (!this.isHazard(c)) continue;
      const sample = this.track.getSampleAtDistance(c.sim.sMeters);
      // On or by the road: a car far out in a run-off area needs no yellow
      if (Math.abs(c.sim.lateralOffsetM) < sample.width / 2 + 4) this.yellowS.push(c.sim.sMeters);
    }
  }

  /** Inside a yellow flag zone at lap distance `s` */
  public underYellow(s: number): boolean {
    const L = this.track.totalLengthM;
    for (const ys of this.yellowS) if (inYellowZone(s, ys, L)) return true;
    return false;
  }

  // ---------------------------------------------------------------------------------------------
  // Contact: 3D OBB SAT rigid-body collision impulse (P7), with the rectangles in track coordinates as the fallback
  // (side-by-side overlap pushes the cars apart laterally; a nose-to-tail hit exchanges speed, restitution 0.2)
  // ---------------------------------------------------------------------------------------------
  private resolveContacts(): void {
    const L = this.track.totalLengthM;
    for (let a = 0; a < this.cars.length; a++) {
      if (this.cars[a].removed) continue;
      for (let b = a + 1; b < this.cars.length; b++) {
        if (this.cars[b].removed) continue;
        const A = this.cars[a].sim;
        const B = this.cars[b].sim;
        const ds = wrapHalf(B.sMeters - A.sMeters, L);
        const dLat = B.lateralOffsetM - A.lateralOffsetM;

        if (A.applyRigidBodyCollision && B.applyRigidBodyCollision) {
          // Broad phase in the world, not along the track: a car spun across the road is ~5 m wide in track terms
          const dx = B.worldPosition.x - A.worldPosition.x;
          const dz = B.worldPosition.z - A.worldPosition.z;
          if (dx * dx + dz * dz > CONTACT_BROAD_M2 || Math.abs(B.worldPosition.y - A.worldPosition.y) > 2) continue;
          // 3D OBB SAT contact with the off-centre yaw moment and energy loss
          fillObb(A, _obbA);
          fillObb(B, _obbB);
          const hit = resolveCarToCarObbCollision(_obbA, _obbB);
          if (!hit.collided) continue;
          this.noteContact(a, b);
          const yawCap = fieldContactYawCap(hit.impactSpeedMs);
          const dvCap = fieldContactDvCap(hit.impactSpeedMs);
          const stateA = this.cars[a].control ? this.controlState(this.cars[a]) : null;
          const stateB = this.cars[b].control ? this.controlState(this.cars[b]) : null;
          applyObbDeltas(A, hit.posDeltaA, hit.velDeltaA, hit.yawDeltaA, dvCap, yawCap);
          this.afterContact(this.cars[a], _obbA, stateA, hit.impactSpeedMs, hit.contactX, hit.contactZ);
          applyObbDeltas(B, hit.posDeltaB, hit.velDeltaB, hit.yawDeltaB, dvCap, yawCap);
          this.afterContact(this.cars[b], _obbB, stateB, hit.impactSpeedMs, hit.contactX, hit.contactZ);
          if (hit.impactSpeedMs > 0.5) this.reportContact(this.cars[a], this.cars[b], ds, hit.impactSpeedMs);
          continue;
        }

        // A car without rigid-body contact: rectangles in track coordinates (side-by-side overlap pushes the cars
        // apart laterally; a nose-to-tail hit exchanges speed, restitution 0.2)
        const overLong = CAR_LEN_M - Math.abs(ds);
        const overLat = CAR_WID_M - Math.abs(dLat);
        if (overLong <= 0 || overLat <= 0) continue;
        this.noteContact(a, b);
        if (overLat < overLong * 0.55) {
          const push = (overLat / 2 + 0.02) * (dLat >= 0 ? 1 : -1);
          A.lateralOffsetM -= push;
          B.lateralOffsetM += push;
          A.vxMs *= 0.995;
          B.vxMs *= 0.995;
        } else {
          const [back, front] = ds >= 0 ? [A, B] : [B, A];
          const closing = back.vxMs - front.vxMs;
          if (closing > 0) {
            const e = 0.2;
            back.vxMs -= (closing * (1 + e)) / 2;
            front.vxMs += (closing * (1 + e)) / 2;
          }
          back.sMeters = (((back.sMeters - overLong - 0.02) % L) + L) % L;
        }
      }
    }
  }

  /**
   * One car's side of a contact, after its deltas were applied (`_applied`): a knock big enough startles the driver,
   * and the impact damages the car where it landed
   */
  private afterContact(car: FieldCar, box: RigidBodyCollisionCar, before: AiControlCarState | null, impactMs: number, cx: number, cz: number): void {
    if (car.control && before) {
      // The lateral part of the speed change, in the car's own frame (left = (fwdZ, −fwdX))
      const dvLat = Math.abs(_applied.dvx * box.fwdZ - _applied.dvz * box.fwdX);
      if (Math.abs(_applied.dyaw) > KNOCK_YAW_RADS || dvLat > KNOCK_LATERAL_MS || impactMs > 3) {
        car.control.knock(before, Math.abs(_applied.dyaw) > 2 * KNOCK_YAW_RADS || dvLat > 2 * KNOCK_LATERAL_MS || impactMs > 4);
      }
    }
    // A contact the driver feels (the pad's impact pulse)
    if (car.isPlayer && impactMs > 1.5) {
      const prev = car.sim.telemetry.carContact;
      car.sim.telemetry.carContact = { speedMs: impactMs, seq: (prev?.seq ?? 0) + 1 };
    }
    if (impactMs > 1) {
      const local = worldToCarLocal(cx, cz, box.x, box.z, box.fwdX, box.fwdZ);
      const report = car.damage.registerImpact({ localX: local.x, localZ: local.z, speedMs: impactMs, source: 'car' });
      if (report) this.incidents.push({ kind: 'damage', code: car.code, isPlayer: car.isPlayer, report, source: 'car' });
    }
  }

  /** The facts of a contact for race control's judgement: who was where, moving which way */
  private reportContact(carA: FieldCar, carB: FieldCar, dsAB: number, impactMs: number): void {
    // `a` is the car further back
    const [back, front, ds] = dsAB >= 0 ? [carA, carB, dsAB] : [carB, carA, -dsAB];
    const latSpeed = (sim: SimulatorCar) => {
      const sample = this.track.getSampleAtDistance(sim.sMeters);
      const v = sim.worldVelocity;
      const b = sample.binormal;
      const bl = Math.hypot(b.x, b.z) || 1;
      if (v) return (v.x * b.x + v.z * b.z) / bl;
      return 0;
    };
    this.incidents.push({
      kind: 'contact',
      a: back.code,
      b: front.code,
      aIsPlayer: back.isPlayer,
      bIsPlayer: front.isPlayer,
      impactMs,
      dsM: ds,
      aLatM: back.sim.lateralOffsetM,
      bLatM: front.sim.lateralOffsetM,
      aLatSpeedMs: latSpeed(back.sim),
      bLatSpeedMs: latSpeed(front.sim),
      aBraking: back.sim.telemetry.brake > 0.2,
      bBraking: front.sim.telemetry.brake > 0.2,
      s: back.sim.sMeters,
    });
  }

  /** Counts a touch between two cars once (a new one after 1 s apart) */
  private noteContact(ia: number, ib: number): void {
    const a = this.cars[ia];
    const b = this.cars[ib];
    a.contact = b.contact = true;
    // A number, not a string built per overlapping pair per frame
    const key = Math.min(ia, ib) * 256 + Math.max(ia, ib);
    const last = this.contactAt.get(key);
    if (last === undefined || this.raceTimeS - last > 1) {
      a.stats.contacts++;
      b.stats.contacts++;
    }
    this.contactAt.set(key, this.raceTimeS);
  }

  /**
   * A car stalled while racing (pinned against a wall, beached without a spin) stops and waits to rejoin like a spun
   * one; one that cannot get going again (`AiCarControl.needsMarshal`) is put back on its line by the marshals once
   * the road behind is clear
   */
  private recoverStuckCars(dt: number): void {
    for (const car of this.cars) {
      const sim = car.ai;
      const ctl = car.control;
      if (!sim || !ctl || car.retired) continue;
      car.stuckS = ctl.mode === 'racing' && Math.abs(sim.vxMs) < 2 ? car.stuckS + dt : 0;
      if (car.stuckS > 3) {
        car.stuckS = 0;
        ctl.stall();
      }
      if (ctl.needsMarshal && this.clearBehind(car)) {
        const sample = this.track.getSampleAtDistance(sim.sMeters);
        const lineLat = aiLineOffsetM(sample, sim.racingLineId);
        sim.teleportToDistance(sim.sMeters, 0, lineLat);
        sim.lateralOffsetM = lineLat;
        car.biasM = 0;
        car.stats.stuckRecoveries++;
        car.stats.marshalRecoveries++;
        car.learner?.interrupt();
        ctl.marshalled();
      }
    }
  }

  private trackDistance(car: FieldCar): void {
    const s = car.sim.sMeters;
    car.prevS = s;
    const clock = car.clock;
    const lapsBefore = clock.lapsDone;
    const running = clock.finishTimeS === null;
    // The last lap done, or the winner already in: the flag is out, and every car finishes at its next crossing
    const flagOut = running && this.cars.some((c) => c.finishTimeS !== null);
    const finished = clock.update(s, this.raceTimeS, this.raceLaps, flagOut);
    if (running && clock.lapsDone > lapsBefore) {
      if (car.ai) {
        car.stats.lapTimesMs.push(Math.round(clock.lastCrossingLapMs ?? 0));
        car.stats.lapPositions.push(this.positionOf(car));
      }
      if (finished) {
        if (car.isPlayer) this.phase = 'finished';
        if (car.ai && this.persistLearning && car.learner) saveLearnedCorners(this.trackId, this.classId, car.code, car.learner.snapshot());
        if (this.spectate && this.cars.every((c) => c.finishTimeS !== null)) this.phase = 'finished';
      }
      if (car.ai) this.newLap(car);
    }
    this.splitTimer.record(car.id, this.raceTimeS, car.distM);
    this.gapTimer.recordOne(this.raceTimeS, car.distM);
  }

  /** Running position of a car now (1 = leading) */
  private positionOf(car: FieldCar): number {
    const ordered = raceOrder(this.cars.map((c) => this.progressOf(c)), this.track.totalLengthM);
    return ordered.findIndex((p) => p.id === car.id) + 1;
  }

  private progressOf(c: FieldCar): RacerProgress {
    return {
      id: c.id,
      code: c.code,
      name: c.code,
      color: c.teamColorHex,
      isPlayer: c.isPlayer,
      distM: c.distM,
      speedMs: c.sim.vxMs,
      finishTimeS: c.finishTimeS,
      finishLaps: c.finishLaps ?? undefined,
      grid: c.gridSlot,
      bestLapMs: c.bestLapMs,
      lastLapMs: c.lastLapMs,
      penaltyS: (c.isPlayer ? this.playerPenaltyS : 0) + this.raceControl.penaltyOf(c.code),
      compound: c.sim.tireCompound,
      dnf: c.retired || undefined,
    };
  }

  /** Race time since the lights went out (s) */
  get timeS(): number {
    return this.raceTimeS;
  }

  /** Everything a headless race reports: running order, laps, incidents and what each car learnt (grid order) */
  public report(): AiFieldReport {
    const ordered = raceOrder(this.cars.map((c) => this.progressOf(c)), this.track.totalLengthM);
    return {
      seed: this.seed,
      skill: this.skillLevel,
      tuningSources: this.tuning.resolved.sources,
      cars: this.cars.map((c, i) => ({
        code: c.code,
        isPlayer: c.isPlayer,
        gridPos: c.gridSlot + 1,
        position: ordered.findIndex((p) => p.id === c.id) + 1,
        pace: c.basePace,
        distM: c.distM,
        finishTimeS: c.finishTimeS,
        bestLapMs: c.bestLapMs,
        stats: c.stats,
        learnt: c.learner?.snapshot() ?? [],
        retired: c.retired,
        penaltyS: this.raceControl.penaltyOf(c.code),
        damage: c.damage.overall,
      })),
      raceControl: this.raceControl.messages.map((m) => ({ kind: m.kind, text: m.text, detail: m.detail, atS: m.atS })),
    };
  }

  private syncPeer(car: FieldCar): void {
    const sim = car.sim;
    const p = car.peer;
    p.position.copy(sim.worldPosition);
    p.quaternion.copy(sim.worldQuaternion);
    // The rig seats the wheels on the road under each corner, as the player's: the body keeps its heave
    if (sim.tyreVisuals) {
      p.wheels ??= { tyres: sim.tyreVisuals, ground: null };
      p.wheels.ground = sim.groundQuery ?? null;
    }
    p.linearVelocity.set(sim.vyMs, 0, sim.vxMs).applyQuaternion(sim.worldQuaternion);
    p.steerAngle = steerAngleOf(sim.steerAngleNorm);
    for (let i = 0; i < 4; i++) p.wheelRPMs[i] = wheelRpmOf(sim.wheels[i].spinVel);
    p.throttle = sim.telemetry.throttle;
    p.brake = sim.telemetry.brake;
    p.trackS = sim.sMeters;
    p.speedKmh = sim.telemetry.speedKmh;
    p.rpm = sim.telemetry.rpm;
    p.gear = sim.telemetry.gear;
    p.contact = car.contact;
  }

  /** Physics of every car in the field, AI cars in grid order then the player (for the shared track environment) */
  public sims(): readonly SimulatorCar[] {
    return this.allSims;
  }

  /** Physics of the AI cars, in grid order */
  public aiSims(): SimulatorCar[] {
    return this.cars.flatMap((c) => (c.ai ? [c.ai] : []));
  }

  /**
   * Time to the car directly ahead of the player on the road (s), from the race distances and the
   * player's speed; null before the start or when the player leads.
   */
  public playerGapAheadS(): number | null {
    if (!this.started || this.phase !== 'racing') return null;
    const me = this.cars.find((c) => c.isPlayer);
    if (!me) return null;
    let gapM = Infinity;
    let ahead: FieldCar | null = null;
    for (const c of this.cars) {
      if (c !== me && c.distM > me.distM && c.distM - me.distM < gapM) {
        gapM = c.distM - me.distM;
        ahead = c;
      }
    }
    if (!ahead) return null;
    // The time since that car passed this point (distance over speed only before there is timing there)
    return this.splitTimer.gapS(this.raceTimeS, ahead.id, me.distM) ?? gapM / Math.max(5, me.sim.vxMs);
  }

  /**
   * The race rules for the player's overtaking aids apply (the start lights included); after the player's flag they
   * are free, and never before the race has started
   */
  public get raceRulesActive(): boolean {
    return this.started && (this.phase === 'lights' || this.phase === 'racing');
  }

  /**
   * The race rules for one car of the field: from the start until that car's own flag. The player taking the flag
   * ends the race for the player only; the AI cars still running stay under the rules until they finish.
   */
  private raceRulesActiveFor(sim: SimulatorCar): boolean {
    if (!this.started) return false;
    const car = this.cars.find((c) => c.sim === sim);
    return car ? car.finishTimeS === null : this.raceRulesActive;
  }

  /** Race laps the leader has completed */
  public leaderLapsCompleted(): number {
    let lead = -Infinity;
    for (const c of this.cars) if (c.distM > lead) lead = c.distM;
    return Number.isFinite(lead) ? Math.max(0, Math.floor(lead / this.track.totalLengthM)) : 0;
  }

  /**
   * Time to the car directly ahead of `car` on the road (s), a lapped car or a leader a lap up included, as a timing
   * loop sees it: the time since that car passed this point. Finished cars do not count; null when there is none.
   */
  public gapAheadOnRoadS(car: FieldCar): number | null {
    const others = this.cars.filter((c) => c !== car && c.finishTimeS === null);
    const ahead = carAheadOnRoad(car.distM, others, this.track.totalLengthM);
    if (!ahead) return null;
    return this.splitTimer.gapS(this.raceTimeS, ahead.car.id, ahead.passedHereAtDistM) ?? ahead.roadGapM / Math.max(5, car.sim.vxMs);
  }

  /** Race control's call at a detection point: within 1 s of the car ahead, and for DRS once the leader has done two laps */
  public detectionEarnedFor(sim: SimulatorCar): boolean {
    const car = this.cars.find((c) => c.sim === sim);
    const rules = sim.overtakingRules;
    if (!car || !rules) return false;
    return earnedAtDetection({ rules, gapAheadS: this.gapAheadOnRoadS(car), leaderLapsCompleted: this.leaderLapsCompleted() });
  }

  /** Race control for a car of this field */
  public raceControlFor(sim: SimulatorCar): OvertakingRaceControl {
    const field = this;
    return {
      get racing() {
        return field.raceRulesActiveFor(sim);
      },
      earnedAtDetection: () => field.detectionEarnedFor(sim),
    };
  }

  /** One car's state by its code ('YOU' for the player): the driver's mode, damage, retirement, incidents */
  public carInfo(code: string): {
    mode: AiCarControl['mode'];
    damage: CarDamage;
    retired: boolean;
    removed: boolean;
    sim: SimulatorCar;
    stats: AiCarStats;
  } | null {
    const c = this.cars.find((x) => x.code === code);
    return c ? { mode: c.control?.mode ?? 'racing', damage: c.damage, retired: c.retired, removed: c.removed, sim: c.sim, stats: c.stats } : null;
  }

  /** Race control's messages for the HUD: the player's own, and the race's retirements and penalties */
  private raceControlFeed(): RaceStatus['raceControl'] {
    const live = this.raceControl.live(this.raceTimeS).filter((m) => m.player || m.kind === 'retired' || m.kind === 'penalty');
    return live.length ? live.slice(0, 2).map(({ id, kind, text, detail }) => ({ id, kind, text, detail })) : undefined;
  }

  private playerDamageStatus(): RaceStatus['damage'] {
    const d = this.cars.find((c) => c.isPlayer)?.damage;
    // A scuff that costs nothing isn't worth a HUD panel
    if (!d || d.pristine || (d.overall < 0.03 && !d.terminal && !d.punctured.some(Boolean))) return undefined;
    return {
      front: d.front,
      rear: d.rear,
      left: d.left,
      right: d.right,
      suspension: [...d.suspension],
      punctured: [...d.punctured],
      overall: d.overall,
      terminal: d.terminal,
    };
  }

  /** The player's damage (for the HUD) */
  public playerDamage(): CarDamage | null {
    return this.cars.find((c) => c.isPlayer)?.damage ?? null;
  }

  /** Render / HUD states of the AI cars (the player is drawn by the caller) */
  public peers(): InterpolatedPeerState[] {
    return this.cars.filter((c) => !c.isPlayer && !c.removed).map((c) => c.peer);
  }

  /** Time penalties the player serves at the flag (track limits), in seconds */
  public playerPenaltyS = 0;

  public status(): RaceStatus {
    const L = this.track.totalLengthM;
    const progress = new Map<FieldCar, RacerProgress>();
    for (const c of this.cars) progress.set(c, this.progressOf(c));
    const orderedProgress = raceOrder([...progress.values()], L);
    const byId = new Map(this.cars.map((c) => [c.id, c]));
    const order = orderedProgress.map((p) => byId.get(p.id) as FieldCar);
    // Time since the first car reached this car's distance
    const gapTo = (car: FieldCar) => this.gapTimer.gapS(this.raceTimeS, car.distM, car.sim.vxMs);
    const leader = order[0];
    let gapFloor = 0;
    let prevGap = 0;
    const playerIdx = order.findIndex((c) => c.isPlayer);
    // A spectated (headless) field has no player: report on its leader
    const player = order[playerIdx] ?? leader;
    // Out of the race counts as done: the classification shows the retirement
    const playerFinished = player.finishTimeS !== null || player.retired;
    const final = playerFinished && classificationClosed(orderedProgress, this.raceTimeS);
    return {
      phase: this.phase,
      lightsOn: this.lightsOn,
      position: playerIdx + 1,
      fieldSize: order.length,
      lap: Math.max(1, Math.min(this.raceLaps, Math.floor(player.distM / L) + 1)),
      totalLaps: this.raceLaps,
      standings: order.map((c, i) => {
        const p = progress.get(c) as RacerProgress;
        // Keep the gaps ordered like the positions (bucket timing is coarse at launch speeds)
        if (this.phase !== 'lights') {
          const ct = classifiedTimeS(p);
          const lt = classifiedTimeS(progress.get(leader) as RacerProgress);
          const gap = ct !== null && lt !== null ? ct - lt : gapTo(c);
          gapFloor = Math.max(gapFloor, gap);
        }
        const intervalS = i > 0 ? gapFloor - prevGap : undefined;
        prevGap = gapFloor;
        return {
          driverCode: c.code,
          teamColorHex: c.teamColorHex,
          isPlayer: c.isPlayer,
          lap: Math.max(1, Math.min(this.raceLaps, Math.floor(c.distM / L) + 1)),
          gapToLeaderS: gapFloor,
          intervalS,
          finished: c.finishTimeS !== null,
          retired: c.retired || undefined,
          damage: c.damage.pristine ? undefined : Math.round(c.damage.overall * 100) / 100,
          bestLapMs: c.bestLapMs,
          lastLapMs: c.lastLapMs,
          trackS: lapPositionM(c.distM, L),
          raceDistM: c.distM,
          compound: c.sim.tireCompound,
          penaltyS: p.penaltyS || undefined,
        };
      }),
      // polish:B each row's place on the grid (classify keeps the order it is given)
      results: playerFinished
        ? classify(orderedProgress, L, this.raceLaps, final).map((r, i) => ({ ...r, gridPosition: (orderedProgress[i].grid ?? 0) + 1 }))
        : undefined,
      resultsFinal: final,
      splits: this.phase === 'racing' ? this.playerSplits.compute(this.splitTimer, this.raceTimeS, orderedProgress) : undefined,
      raceControl: this.raceControlFeed(),
      yellow: this.playerUnderYellow() || undefined,
      damage: this.playerDamageStatus(),
    };
  }
}
