/**
 * f12026-car in the simulator: wraps `VehiclePhysics` behind the `SimulatorCar` surface the simulator,
 * the AI field and the renderer use for the VF26 model, and maps its live telemetry channels to `CarTelemetry`.
 *
 * Ground: the `Track_Collider_Road` colliders and `Track_Collider_Wall_*` barriers once the track GLB has
 * loaded (`attachTrackRoot`); until then (or when it never loads) a ground built from the track samples'
 * lateral height profiles, without barriers.
 *
 * The flaps open in the circuit's `ZoneData_DRSZone`s and close on the brake or a lift, by the car's era
 * (`overtaking-rules.ts`): a 2026 car opens both flaps in every zone and earns Overtake Mode within 1 s at the
 * detection point; an older car opens the rear flap alone, in a race only once race control (`raceControl`) says it
 * was within 1 s at that zone's detection point.
 */
import {
  BRAKE_DUCT_STEP,
  type ChassisSetup,
  clampChassisSetup,
  DEFAULT_CHASSIS_SETUP,
  pctScale,
  startingFuelKg,
  STEER_RATIO_BASE,
  WING_CLICK_DEG,
} from '../car-setup';
import * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
  F12026Channels,
  LiveTunerPatch,
  LiveTunerState,
  RacingLineId,
  SurfaceType,
  TireCompound,
  TrackSamplePoint,
  TyreSetup,
  WheelPressures,
} from '@/types/f1';
import { axlePressures, pressureAt, type VehicleModelId } from '@/types/f1';
import {
  BASE_ALTITUDE_M,
  type BuiltTrackData,
  evaluateSampleLateralHeightM,
  getActiveSurfaceTable,
  RWANDA_DRS_ZONES,
} from '@/lib/track-data';
import { SteeringAssist, type SteeringAssistCarState } from '../steering-assist';
import { type OvertakingRaceControl, type OvertakingRules, OvertakeGrant } from '../overtaking-rules';
import { AxleSlipScratch } from '../tyre-slip';
import type { AeroWakeState } from '../aero-wake';
import { type CarDamageEffects, withDamage } from '../car-damage';
import type { TrackEvolutionSample } from '../track-evolution';
import type { WeatherContactSample } from '../weather';
import { SLICK_TRAITS, wetGripFactor } from '../wet-tyres';
import { tyreGaugePressureAtTemperature } from '../tyre-pressure';
import { FULL_REALISM, type SimRealismFlags } from '../sim-realism';
import { flyingExitSpeedMs, flyingStartPoint, type SimulatorCar, type SimulatorWheel, type TyreVisualState } from '../simulator-car';
import { aiLineOffsetM, type BrakingGuide, brakingGuideFor, sampleProfile, type SpeedProfileCarModel } from '../speed-profile';
import { evaluateDynamicBrakingUrgency } from '../track-occupancy';
import {
  type CarPhysicsConfig,
  compoundData,
  DEFAULT_FRICTION_LIMIT_ANGLE_DEG,
  F12026_CAR_CONFIG,
  type PerformanceModeName,
  type TyresCompoundData,
} from './F12026CarConfig';
import { createGroundHit, type GroundHit, type GroundQuery, type TrackSurfaceKind } from './TrackColliderQuery';
import { trackColliders } from '../track-colliders';
import { type VehicleEvent, type VehicleInputs, VehiclePhysics } from './VehiclePhysics';
import { KERB_PROFILE_L, kerbProfileM, surfaceRippleM } from '../track-surfaces';
import { sampleGrid } from '../ai/ai-track';
import type { AiDrivePlan } from '../ai/drive-plan';

const G = 9.81;
const DEG2RAD = Math.PI / 180;
/**
 * Of the two fronts' steering compliance (rad), the one the steering assist's grip limit looks after: the less bent
 * front, the lightly loaded inside one, slips the most and reaches its peak first
 */
const leastBent = (left: number, right: number) => (Math.abs(left) < Math.abs(right) ? left : right);
const RAD2DEG = 180 / Math.PI;
/** Rwanda (≈1400 m ASL) air density: what the braking envelopes below are planned at */
const AIR_DENSITY = 1.06;
/** Standard-atmosphere air density at an altitude (as the VF26's): 1.07 at Rwanda, 1.21 at Silverstone */
const airDensityAt = (altitudeM: number) => 1.225 * Math.pow(1 - 2.25577e-5 * altitudeM, 4.25588);
/** A braking envelope at a circuit's air: the aero part grows with the density it was planned at (1.06) */
const envelopeAt = (b: BrakingEnvelope, rho: number): BrakingEnvelope => ({ ...b, aeroG: (b.aeroG * rho) / AIR_DENSITY });

/** Braking envelope (g) a car pulls at a speed: `lowG` + `aeroG` × min(1, (v / `refMs`)²) */
export interface BrakingEnvelope {
  lowG: number;
  aeroG: number;
  refMs: number;
}

/** 12-stage multi-position TC and 4-channel ABS electronics calibration */
export interface CarElectronicsProfile {
  /** 12 allowed lock slip ratios from most intrusive (index 0, level 12) to least intrusive (index 11, level 1) */
  absLevels: readonly number[];
  absDefault: number;
  absRateHz: number;
  /** 12 allowed rear traction slip ratios from most intrusive (index 0, level 12) to least intrusive (index 11, level 1) */
  tcLevels: readonly number[];
  tcDefault: number;
  tcRateHz: number;
  tcMinSpeedKmh: number;
  /**
   * TC1 slip target tightening with lateral g: target × max(`floor`, 1 − `gain`·(|a_y|/g)^`exponent` − driven-axle
   * slide term in the wet). Default (an F1 calibration): gain 0.14, exponent 1.3, floor 0.42.
   */
  tcLateralTightening?: { gain: number; exponent: number; floor: number };
  /**
   * TC1 slide term on a dry road: the slip target also shrinks by `gain` × (driven axle's slip angle / peak − `from`),
   * so a driven axle that already slides sideways (the rear on an F1 car or a GT3) gets less wheelspin before the cut,
   * as a cornering-aware GT3 TC does. Absent: only in the wet (gain 0.22 from 0.45), the F1 calibration.
   */
  tcDryRearSlide?: { gain: number; from: number };
  /**
   * ABS rear channels: the lock target × max(`floor`, 1 − `gain`·(|slip angle| − `deadbandRad`)), so a trail-braked rear
   * that already slides is held off the brakes. Default (an F1 calibration): gain 1.4, dead band 0.03 rad, floor 0.72.
   * Gain 0 = the rears regulate slip ratio only.
   */
  absRearSlipAngleGuard?: { gain: number; deadbandRad: number; floor: number };
}

const DEFAULT_TC_LATERAL_TIGHTENING = { gain: 0.14, exponent: 1.3, floor: 0.42 } as const;
/** Fastest a driver turns the steering wheel (deg/s at the rim), and the rim angle per road-wheel angle (the cars' lock is
 * given as rim lock / 12.6) */
const DRIVER_RIM_SPEED_DEG_S = 900;
const RIM_PER_ROAD_WHEEL = 12.6;
const DEFAULT_ABS_REAR_GUARD = { gain: 1.4, deadbandRad: 0.03, floor: 0.72 } as const;

export const F12026_ELECTRONICS: CarElectronicsProfile = {
  absLevels: [0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19],
  absDefault: 0.15,
  absRateHz: 240,
  tcLevels: [0.065, 0.07, 0.075, 0.08, 0.085, 0.09, 0.095, 0.1, 0.11, 0.12, 0.135, 0.15],
  tcDefault: 0.1,
  tcRateHz: 130,
  tcMinSpeedKmh: 7.2,
};

/**
 * What differs between the cars this adapter drives: physics data, the systems the car has, setup limits, driver
 * aids and the envelope the autopilot plans with.
 */
export interface CarSimProfile {
  id: string;
  config: CarPhysicsConfig;
  /** MGU-K / push mode */
  hasErs: boolean;
  hasDrs: boolean;
  /** Turbocharged (telemetry boost pressure) */
  turbo: boolean;
  coldPsiRange: [number, number];
  frontCamberRange: [number, number];
  rearCamberRange: [number, number];
  /** Traction control works above this speed (m/s) */
  tcMinSpeedMs: number;
  /** Optional 12-stage TC / 4-channel ABS electronics calibration */
  electronics?: CarElectronicsProfile;
  /** Wing angle offsets per aero package (deg): front, rear */
  aeroPackagesDeg: Record<AeroSetupPreset, [number, number]>;
  /** Lateral grip the steering assist assumes, per g of (weight + downforce) */
  padLateralMu: number;
  braking: BrakingEnvelope;
  /**
   * Planning model of this car for its braking line, braking urgency and HUD target speed (`brakingGuideFor`).
   * Without one the car uses the circuit's (the VF26 profile baked into the track samples).
   */
  speedProfile?: SpeedProfileCarModel;
  /** The racing line this car drives, plans on and draws (default: the F1 line) */
  racingLine?: RacingLineId;
  /**
   * The car's understeer gradient (front road-wheel angle beyond the kinematic one, rad per m/s² of lateral
   * acceleration) the autopilot steers in ahead of its yaw loop. Default 0: the loop's integrator finds it.
   */
  understeerRadPerMs2?: number;
  /** Fuel flow at full throttle (kg/s); default 0.036 for the GT3, 0.0278 for an F1 car */
  fuelFlowKgS?: number;
  /** The TC / ABS dial positions of each driver-assist preset; absent: the F1 or GT3 positions */
  assistDials?: Record<DriverAssistPreset, AidDials>;
}

export const F12026_SIM_PROFILE: CarSimProfile = {
  id: 'f12026-car',
  config: F12026_CAR_CONFIG,
  hasErs: true,
  hasDrs: true,
  turbo: true,
  // 2026 open-wheel setup ranges
  coldPsiRange: [15, 25],
  frontCamberRange: [-3.6, 0],
  rearCamberRange: [-2.0, 0],
  tcMinSpeedMs: 2,
  electronics: F12026_ELECTRONICS,
  // Wing offsets: front 10–30° (set 25), rear 0–20° (set 15)
  aeroPackagesDeg: { low_downforce: [-10, -10], balanced: [0, 0], high_downforce: [5, 5] },
  // Flat-ground steer ramps: 2.3 g at 100 km/h on 1.24 g of load (μ ≈ 1.8), falling with load
  padLateralMu: 1.75,
  // Flat-ground probes: 2.3 / 3.6 / 4.0 g lateral at 100 / 200 / 280 km/h, 4.3 g on the brakes from 300
  braking: { lowG: 1.6, aeroG: 2.8, refMs: 70 },
};

/** How far inside the track edge the autopilot keeps the CG (m): half the track plus 0.4 m (1.2 m on the f12026-car) */
function autopilotEdgeMarginM(profile: CarSimProfile): number {
  const ch = profile.config.chassis;
  return 0.5 * Math.max(ch.trackWidthFront, ch.trackWidthRear) + 0.4;
}

/** Height step (m) over one 0.1 m probe across the road that ends the asphalt the autopilot uses: a lip no tyre should meet */
const AP_EDGE_STEP_M = 0.08;
/** Probe spacing across the road (m) */
const AP_EDGE_PROBE_M = 0.1;
/** Clear ground the autopilot keeps between its usable road and a raised step out past it (m) */
const AP_EDGE_APRON_M = 0.6;
/** Road either side of the centreline the autopilot may use (m, every `AP_PROFILE_STEP_M`): - and + lateral sides */
interface AutopilotEdges {
  neg: Float32Array;
  pos: Float32Array;
}
const apEdges = new WeakMap<GroundQuery, WeakMap<BuiltTrackData, AutopilotEdges>>();

/**
 * Where the road under the track's colliders really ends each side: probed out from the centreline to
 * `AP_EDGE_APRON_M` past the track's width, the first rise of more than `AP_EDGE_STEP_M` beyond what the banking
 * gives (a collider that does not meet the road surface, e.g. a 0.2–0.45 m lip along Suzuka's edges that launches a
 * car onto it) leaves the road `AP_EDGE_APRON_M` short of it, never more than 1 m inside the track's own width. A drop
 * (onto lower runoff) is no hazard. Each narrowing holds for ±10 m, since the car comes at a lip at an angle.
 */
function autopilotEdges(track: BuiltTrackData, ground: GroundQuery): AutopilotEdges {
  let perTrack = apEdges.get(ground);
  if (!perTrack) apEdges.set(ground, (perTrack = new WeakMap()));
  const cached = perTrack.get(track);
  if (cached) return cached;
  const L = track.totalLengthM;
  const n = Math.ceil(L / AP_PROFILE_STEP_M);
  const raw = { neg: new Float32Array(n), pos: new Float32Array(n) };
  const hit = createGroundHit();
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance((i * L) / n);
    const half = smp.width / 2;
    const b = smp.binormal;
    for (const side of [-1, 1] as const) {
      const at = (lat: number) =>
        ground.query(smp.position.x + b.x * lat, smp.position.z + b.z * lat, smp.position.y + b.y * lat + 1.5, hit) ? hit.height : null;
      let usable = half;
      let prev = at(0);
      for (let lat = AP_EDGE_PROBE_M; prev !== null && lat <= half + AP_EDGE_APRON_M + 1e-6; lat += AP_EDGE_PROBE_M) {
        const h = at(side * lat);
        if (h === null ? lat <= half : h - prev - b.y * side * AP_EDGE_PROBE_M > AP_EDGE_STEP_M) {
          usable = Math.min(half, lat - AP_EDGE_PROBE_M - (h === null ? 0 : AP_EDGE_APRON_M));
          break;
        }
        if (h === null) break;
        prev = h;
      }
      // how far inside the track's width the road ends
      (side < 0 ? raw.neg : raw.pos)[i] = Math.min(1, half - usable);
    }
  }
  const hold = Math.round(10 / (L / n));
  const out = { neg: new Float32Array(n), pos: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    let neg = 0;
    let pos = 0;
    for (let k = -hold; k <= hold; k++) {
      const j = (i + k + n) % n;
      neg = Math.max(neg, raw.neg[j]);
      pos = Math.max(pos, raw.pos[j]);
    }
    const half = track.getSampleAtDistance((i * L) / n).width / 2;
    out.neg[i] = half - neg;
    out.pos[i] = half - pos;
  }
  perTrack.set(track, out);
  return out;
}

/** The lateral range (m) the autopilot keeps its CG in at distance `s`: the usable road less its edge margin */
function autopilotLateralRange(
  track: BuiltTrackData,
  sample: TrackSamplePoint,
  s: number,
  edges: AutopilotEdges | null,
  profile: CarSimProfile
): [number, number] {
  const margin = autopilotEdgeMarginM(profile);
  let neg = sample.width / 2;
  let pos = neg;
  if (edges) {
    const n = edges.neg.length;
    const i = Math.round((wrap(s, track.totalLengthM) / track.totalLengthM) * n) % n;
    neg = Math.min(neg, edges.neg[i]);
    pos = Math.min(pos, edges.pos[i]);
  }
  const lo = -(neg - margin);
  const hi = pos - margin;
  return lo <= hi ? [lo, hi] : [0.5 * (lo + hi), 0.5 * (lo + hi)];
}

/** Deceleration the autopilot plans with at a speed (m/s): 85 % of what the car pulls on the brakes */
function autopilotDecel(b: BrakingEnvelope, speedMs: number): number {
  return 0.85 * 9.81 * (b.lowG + b.aeroG * Math.min(1, (speedMs / b.refMs) ** 2));
}

/** Spacing of the autopilot's own speed profile (m) */
const AP_PROFILE_STEP_M = 5;
/** Lateral grip the autopilot plans corners with, as a fraction of its braking envelope */
const AP_LATERAL_SHARE = 1.1;
/** Banking the autopilot's plan ignores (rad, 4°): see `autopilotProfile` */
const AP_BANK_DEADBAND_RAD = (4 * Math.PI) / 180;
const apProfiles = new WeakMap<BuiltTrackData, Map<string, Float32Array>>();

/**
 * The f12026-car's own speed limit along the path its autopilot drives (the racing line kept on the asphalt),
 * every `AP_PROFILE_STEP_M`: corner speed from its own grip and downforce, then a backward braking pass on the
 * friction circle, so no braking is planned that the tyres need for turning. The circuit's profile is the VF26's,
 * which corners and brakes harder than this car.
 */
function autopilotProfile(track: BuiltTrackData, profile: CarSimProfile, edges: AutopilotEdges | null): Float32Array {
  let perCar = apProfiles.get(track);
  if (!perCar) apProfiles.set(track, (perCar = new Map()));
  const key = edges ? `${profile.id}:colliders` : profile.id;
  const cached = perCar.get(key);
  if (cached) return cached;
  const b = envelopeAt(profile.braking, airDensityAt(track.baseAltitudeM ?? BASE_ALTITUDE_M));
  const L = track.totalLengthM;
  const n = Math.ceil(L / AP_PROFILE_STEP_M);
  const ds = L / n;
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  const bank = new Float64Array(n);
  const offs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance(i * ds);
    bank[i] = smp.bankingRad;
    const [lo, hi] = autopilotLateralRange(track, smp, i * ds, edges, profile);
    offs[i] = THREE.MathUtils.clamp(aiLineOffsetM(smp, profile.racingLine), lo, hi);
  }
  // The clamp kinks the path where the line meets it, and a kink read over ±10 m is a corner twice as tight as the
  // line (82 instead of ~120 km/h planned through Shanghai's turn 13): the path the car drives through it is the
  // clamped line smoothed over ±10 m
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance(i * ds);
    const off = (offs[(i - 2 + n) % n] + 2 * offs[(i - 1 + n) % n] + 3 * offs[i] + 2 * offs[(i + 1) % n] + offs[(i + 2) % n]) / 9;
    px[i] = smp.position.x + smp.binormal.x * off;
    pz[i] = smp.position.z + smp.binormal.z * off;
  }
  // Path curvature over ±10 m (circumcircle of three points), averaged with its neighbours below; its sign (+ right)
  // says which way the banking leans relative to the turn
  const k = new Float64Array(n);
  const turnSign = new Float64Array(n);
  const span = Math.max(1, Math.round(10 / ds));
  for (let i = 0; i < n; i++) {
    const a = (i - span + n) % n;
    const c = (i + span) % n;
    const abx = px[i] - px[a], abz = pz[i] - pz[a], bcx = px[c] - px[i], bcz = pz[c] - pz[i];
    const acx = px[c] - px[a], acz = pz[c] - pz[a];
    const cross = abx * bcz - abz * bcx;
    turnSign[i] = Math.sign(cross) || 1;
    k[i] = (2 * Math.abs(cross)) / Math.max(1e-6, Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz));
  }
  // Banking into the turn (θ) as the circuit's speed profile has it: the tyres' share of the load is g cos θ and
  // gravity carries g sin θ of the turn (Daytona's 31° turns are flat out; planned as flat corners they were not).
  // The first AP_BANK_DEADBAND_RAD of it is left out: a road course's few degrees of camber, read off a scan, are
  // drainage fall and noise, and the full-pace plan was tuned without them (Rwanda's lap then ran 0.2 m wide).
  const gN = new Float64Array(n);
  const gT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const raw = bank[i] * turnSign[i];
    const into = Math.sign(raw) * Math.max(0, Math.abs(raw) - AP_BANK_DEADBAND_RAD);
    gN[i] = Math.cos(into);
    gT[i] = 9.81 * Math.sin(into);
  }
  const v = new Float32Array(n);
  // v²κ = share × decel(v) + g sin θ, with decel(v) = c (low cos θ + aero (v / ref)²) up to ref and
  // c (low cos θ + aero) above
  const c = AP_LATERAL_SHARE * 0.85 * 9.81;
  for (let i = 0; i < n; i++) {
    const kk = Math.max(1e-5, (k[(i - 1 + n) % n] + 2 * k[i] + k[(i + 1) % n]) / 4);
    const den = kk - (c * b.aeroG) / (b.refMs * b.refMs);
    const vLow = den > 0 ? Math.sqrt(Math.max(0, c * b.lowG * gN[i] + gT[i]) / den) : Infinity;
    v[i] = Math.min(110, vLow < b.refMs ? vLow : Math.sqrt(Math.max(0, c * (b.lowG * gN[i] + b.aeroG) + gT[i]) / kk));
  }
  // Backward braking pass (twice round the lap so the wrap is consistent)
  for (let pass = 0; pass < 2 * n; pass++) {
    const i = (n - 1 - (pass % n) + n) % n;
    const j = (i + 1) % n;
    const vj = v[j];
    const aLat = Math.max(0, vj * vj * k[j] - gT[j]);
    const aDec = autopilotDecel(b, vj);
    const aLong = Math.sqrt(Math.max(0.15 * aDec * aDec, aDec * aDec - (aLat / AP_LATERAL_SHARE) ** 2));
    v[i] = Math.min(v[i], Math.sqrt(vj * vj + 2 * aLong * ds));
  }
  perCar.set(key, v);
  return v;
}

/** TC / ABS / TC2 dial positions */
export interface AidDials {
  tcLevel: number;
  tc2Level: number;
  absLevel: number;
}

/** The dial positions of a driver-assist preset */
function assistPresetDials(profile: CarSimProfile, preset: DriverAssistPreset): AidDials {
  const own = profile.assistDials?.[preset];
  if (own) return own;
  const isGt3 = profile.id === 'amg-gt3';
  if (preset === 'pro') return { tcLevel: 0, tc2Level: isGt3 ? 5 : 6, absLevel: 0 };
  if (preset === 'semi_pro') return { tcLevel: isGt3 ? 10 : 5, tc2Level: 6, absLevel: isGt3 ? 9 : 5 };
  return { tcLevel: isGt3 ? 12 : 8, tc2Level: 9, absLevel: isGt3 ? 11 : 9 };
}

/** Driver aids and the autopilot run on frame slices no longer than this (s) */
const AID_SLICE_S = 1 / 240;
/**
 * The autopilot's integrators are stale once it has been off this long (s). An AI car's hand-back after a knock
 * (its driver's reaction, under half a second) keeps them; a takeover after a real stint off resets them.
 */
const AUTOPILOT_STALE_S = 1;
const BOOST_S = 8;
const BOOST_COOLDOWN_S = 4;
const AMBIENT_C = 27;
/** Autopilot line holding: lateral acceleration (m/s²) per m off its line and per m/s drifting off it, and its cap */
const AP_LINE_KP = 2.25;
const AP_LINE_KD = 2.1;
const AP_LINE_MAX_MS2 = 3;
/**
 * Tracking a supplied plan (`aiPlan`): pure pursuit on the plan's path with a short look-ahead, a slow integral on
 * the lateral error, and the plan's speed with its own slope as the pedal feed-forward
 */
/** Pure-pursuit look-ahead on a plan: this many seconds of travel, at least the minimum (m) */
const TRACK_LOOK_S = 0.22;
const TRACK_LOOK_MIN_M = 5;
/** Lateral acceleration a car metres off its path gets back onto it with (m/s²): sets the look-ahead's stretch */
const TRACK_REJOIN_MS2 = 6;
/** Integral on the lateral error (m/s² per m·s) and its cap: a long corner taken a little wide is pulled back */
const TRACK_KI = 1.2;
const TRACK_I_MAX_MS2 = 2.5;
/** A line may put two wheels on a kerb: this much past the autopilot's usual edge margin where the edge has one (m) */
const TRACK_KERB_ALLOW_M = 0.6;
/** Autopilot pedals ease off past this share of the rears' peak slip angle, by this much per share beyond it */
const AP_REAR_GUARD = 0.9;
const AP_REAR_GUARD_GAIN = 4;
/** Autopilot pedal per m/s of speed error, on top of its integral */
const AP_PEDAL_P = 0.5;
/** Autopilot: stopped this long (s) → rejoin on the racing line, as the AI cars do */
const AUTOPILOT_STUCK_S = 4;
/** This far below the track's surface the car has fallen through the world */
const LOST_BELOW_TRACK_M = 15;
/** f12026 wheel (LF, RF, LR, RR) for each VF-order slot (FR, FL, RR, RL) */
const VF_ORDER = [1, 0, 3, 2] as const;

const wrapHalf = (d: number, L: number) => ((((d + L / 2) % L) + L) % L) - L / 2;
const wrap = (s: number, L: number) => ((s % L) + L) % L;

function surfaceType(kind: TrackSurfaceKind): SurfaceType {
  switch (kind) {
    case 'kerb':
    case 'sausage':
      return 'kerb';
    case 'runoff':
    case 'gravel':
      return 'runoff';
    case 'grass':
      return 'grass';
    default:
      return 'asphalt';
  }
}

/**
 * Ground from the track samples (centreline + 9-point lateral height profile), with surfaces from the
 * kerb / run-off / gravel widths. Stands in for the colliders until the track GLB is loaded.
 */
export class TrackSampleGroundQuery implements GroundQuery {
  /** Interpolated from the samples: nothing for a contact patch to envelope, so the tyres probe it at one point */
  readonly smooth = true;
  private hintS: number | undefined;

  constructor(private readonly track: BuiltTrackData) {}

  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    const p = this.track.projectWorldToTrack(x, z, this.hintS);
    this.hintS = p.s;
    const sample = p.sample;
    const lat = p.lateralOffset;
    const h = evaluateSampleLateralHeightM(sample, lat);
    if (h > probeY) return false;
    // Lateral slope from the profile, longitudinal slope from the sample
    const dl = 0.5;
    const dh = (evaluateSampleLateralHeightM(sample, lat + dl) - evaluateSampleLateralHeightM(sample, lat - dl)) / (2 * dl);
    const bx = sample.binormal.x;
    const bz = sample.binormal.z;
    const bl = Math.hypot(bx, bz) || 1;
    const tx = sample.tangent.x;
    const tz = sample.tangent.z;
    const tl = Math.hypot(tx, tz) || 1;
    const slope = sample.slopeSin / Math.sqrt(Math.max(1e-6, 1 - sample.slopeSin * sample.slopeSin));
    // Gradient of the height field in world XZ, normal = (−∂h/∂x, 1, −∂h/∂z)
    const gx = (dh * bx) / bl + (slope * tx) / tl;
    const gz = (dh * bz) / bl + (slope * tz) / tl;
    const n = Math.hypot(gx, 1, gz);
    out.height = h;
    out.nx = -gx / n;
    out.ny = 1 / n;
    out.nz = -gz / n;
    const edge = Math.abs(lat) - sample.width / 2;
    const left = lat < 0;
    const kerb = left ? sample.kerbLeft : sample.kerbRight;
    const runoff = (left ? sample.runoffLeftM : sample.runoffRightM) ?? 3;
    const gravel = (left ? sample.gravelLeftM : sample.gravelRightM) ?? 0;
    const kind: TrackSurfaceKind =
      kerb && edge > KERB_PROFILE_L[0] && edge < KERB_PROFILE_L[KERB_PROFILE_L.length - 1]
        ? 'kerb'
        : edge <= 0
          ? 'road'
          : edge < runoff
            ? 'runoff'
            : edge < runoff + gravel
              ? 'gravel'
              : 'grass';
    const props = getActiveSurfaceTable()[kind];
    if (kind === 'kerb') {
      const wSpan = KERB_PROFILE_L[KERB_PROFILE_L.length - 1] - KERB_PROFILE_L[0];
      const across = Math.sin(Math.PI * Math.min(1, Math.max(0, (edge - KERB_PROFILE_L[0]) / wSpan)));
      out.height += kerbProfileM(edge) + surfaceRippleM(props, p.s, across);
    } else if (kind === 'gravel' || kind === 'grass') {
      out.height += surfaceRippleM(props, p.s, 1);
    }
    out.surface = kind;
    out.grip = props.friction;
    out.props = props;
    out.source = 'track-samples';
    return true;
  }
}

interface AdapterWheel extends SimulatorWheel {
  brakeTempC: number;
}

const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _v = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

export class F12026CarSim implements SimulatorCar {
  public readonly vehicle: VehiclePhysics;
  public readonly config: CarPhysicsConfig;
  public readonly telemetry: CarTelemetry;
  public readonly worldPosition = new THREE.Vector3();
  public readonly worldQuaternion = new THREE.Quaternion();
  public readonly worldVelocity = new THREE.Vector3();
  public readonly wheels: [AdapterWheel, AdapterWheel, AdapterWheel, AdapterWheel];
  /** Visual tyre state per corner (FR, FL, RR, RL), refreshed in `syncPose()`. Read-only for consumers. */
  public readonly tyreVisuals: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState];
  public readonly profile: CarSimProfile;
  /** This car's braking guidance (null: the circuit's) */
  public readonly brakingGuide: BrakingGuide | null;
  /** The racing line this car follows (`CarSimProfile.racingLine`) */
  private readonly line: RacingLineId;
  public readonly wheelbaseM: number;
  public get cgHeightM(): number {
    return this.config.chassis.cgHeight;
  }

  /**
   * Simulated time not yet stepped (s, under one 2 ms step). The renderer carries the pose forward by it: without it
   * a 60 Hz display drew 8, 8, then 9 steps' worth of motion, a 14 cm lurch every third frame at 250 km/h (#65)
   */
  public get renderLeadS(): number {
    return this.vehicle.unsteppedS;
  }
  /** Road-wheel angle at full lock (rad), after the garage's steering ratio */
  public get maxSteerAngleRad(): number {
    return this.vehicle.maxSteerRad;
  }
  /** Car-to-car contact uses this car's own mass and yaw inertia (a GT3 is ~1.75× an F1 car's mass) */
  public get contactMassKg(): number {
    return this.vehicle.totalMassKg;
  }
  public get contactYawInertiaKgM2(): number {
    const ch = this.config.chassis;
    return (ch.inertia.yaw * this.vehicle.totalMassKg) / ch.totalMassKg;
  }
  public readonly cgToFrontAxleM: number;
  public readonly cgToRearAxleM: number;
  // The rig's extra pitch / roll / heave (SimulatorCar): none, since the rigid body's pose already carries them.
  // Not the setup's ride height, which lives on `this.vehicle.rideHeightOffsetM` and is part of that pose
  public readonly pitchRad = 0;
  public readonly rollRad = 0;
  public readonly rideHeightOffsetM = 0;
  /** Off-track verdict of the last frame with a wheel on the ground */
  private wasOffTrack = false;
  public wheelRotationRad = 0;
  public vyMs = 0;
  public yawRateRadS = 0;
  public steerAngleNorm = 0;

  public get vehicleId(): import('@/types/f1').VehicleModelId {
    return this.profile.id as import('@/types/f1').VehicleModelId;
  }
  public get racingLineId(): 'f1' | 'gt3' {
    return this.line;
  }
  public aiAutopilot = false;
  /** The car puts itself back on the line when stuck (off in a race: the field rejoins its cars, `ai-car-control.ts`) */
  public aiSelfRecovery = true;
  private lastWake: AeroWakeState | null = null;
  private damage: Readonly<CarDamageEffects> | null = null;
  /** Fraction of the car's own limit speed (see `autopilotProfile`) the autopilot drives at */
  public aiPaceScale = 0.8;
  /** Lateral offset bias from the racing line for AI traffic / passing (m) */
  public aiLineBiasM = 0;
  /** Speed cap for AI traffic when following another car (m/s) */
  public aiSpeedCapMs = Infinity;
  /**
   * AI tuning (`ai-tuning.ts`): target speed along the lap (m/s, uniform spacing) used instead of this car's own
   * limit profile (`aiBaseSpeedProfile`), e.g. with earlier braking points; null = the limit profile
   */
  public aiTargetSpeedMs: Float64Array | null = null;
  /** AI tuning: multiplier on the autopilot's steering (shorter pursuit look-ahead when higher) */
  public aiSteerGain = 1;
  /**
   * A plan to track: lateral offset and speed along the lap (`ai/drive-plan.ts`). Set, the autopilot follows it as
   * given, with `aiLineBiasM`, `aiSpeedCapMs`, `aiPaceScale` and the tuning target's errors on top; null keeps the
   * autopilot's own line and limit profile
   */
  public aiPlan: AiDrivePlan | null = null;
  /** Integral of the lateral error while tracking a plan (m/s²) */
  private trackI = 0;
  private _assistPreset: DriverAssistPreset = 'semi_pro';
  /** Live MFD Stage-1 TC slip dial (0 = OFF, 1 = min intervention / max slip, 12 = max intervention / min slip) */
  public tcLevel = 5;
  /** Live MFD Stage-2 TC torque cut depth dial (1..12) */
  public tc2Level = 6;
  /** Live MFD 4-channel ABS dial (0 = OFF, 1 = min intervention, 12 = max stability) */
  public absLevel = 5;
  /** User-selected ERS deployment mode in MFD (overridden to 'PSH' while manual override / boost is held) */
  private userErsMode: PerformanceModeName = 'RAC';
  /** Push mode is running (the override held or latched, the 8 s boost, or the AI's Overtake Mode), not just picked */
  private pushActive = false;
  /** Seconds the autopilot has been off: `step` decides from it whether a takeover starts it afresh */
  private autopilotIdleS = 0;
  public gamepadAssistEnabled = true;
  /** Automatic gear changes; off = the driver shifts. The autopilot always shifts for itself (VehiclePhysics.autoShift) */
  public autoGearbox = true;
  /** Keyboard and controller steering assist */
  public readonly steeringAssist = new SteeringAssist();
  /** DRS is driver-operated on the f12026-car (and absent on a GT3): there is no automatic mode, so writes are ignored */
  public get autoXMode(): boolean {
    return false;
  }
  public set autoXMode(_auto: boolean) {
    // nothing to switch: the driver opens the flap
  }
  /** Race control for the overtaking aids (the 1 s and lap rules); null = practice, the aids are free */
  public raceControl: OvertakingRaceControl | null = null;
  /** The car's era: 2026 Straight Mode + Overtake Mode, or rear-flap DRS (`setOvertakingRules`) */
  private rules: OvertakingRules = 'straight-mode-2026';
  private readonly overtake = new OvertakeGrant();

  private readonly track: BuiltTrackData;
  private trackRoot: THREE.Object3D | null = null;
  private readonly baseWingDeg: number[];
  /** Garage: the profile's own suspension and ride heights, the wing trim (deg) and the setup in force */
  private readonly chassisBase: {
    front: { springRate: number; arb: number; bumpStopRate: number; bumpStopRange: number };
    rear: { springRate: number; arb: number; bumpStopRate: number; bumpStopRange: number };
    maxSteerRad: number;
    brakeTorqueNm: number;
    diffPreloadNm: number;
    frontDamper: { slow_bump: number; fast_bump: number; slow_rebound: number; fast_rebound: number };
    rearDamper: { slow_bump: number; fast_bump: number; slow_rebound: number; fast_rebound: number };
    frontHeight: number;
    rearHeight: number;
  };
  private wingTrimDeg = { front: 0, rear: 0 };
  private chassis: ChassisSetup = { ...DEFAULT_CHASSIS_SETUP };
  private readonly channels: F12026Channels = {
    WHEEL_SR_LF: 0,
    WHEEL_SR_RF: 0,
    WHEEL_SR_LR: 0,
    WHEEL_SR_RR: 0,
    BUMPSTOPUP_TRAVEL_LF: 0,
    BUMPSTOPUP_TRAVEL_RF: 0,
    BUMPSTOPUP_TRAVEL_LR: 0,
    BUMPSTOPUP_TRAVEL_RR: 0,
    AERO_HEIGHT: 0,
    AERO_BALANCE: 0,
    LSD_LOCKING_TORQUE: 0,
    CHANGED_DRS_OPEN: false,
    drsOpenEvents: 0,
    drsZone: false,
    drsAvailable: false,
    drsDetection: null,
    circleFraction: [0, 0, 0, 0],
    performanceMode: 'RAC',
    carId: 'f12026-car',
    hasErs: true,
    hasDrs: true,
    tcActive: false,
    absActive: false,
    wallContact: false,
    wallImpact: null,
  };
  private aero: AeroSetupPreset = 'balanced';
  private compound: TireCompound = 'soft';
  /** AI cars fit the tyre the weather calls for (set on cars made by `createAiPeerCar`) */
  public aiAutoTyres = false;
  private realism: SimRealismFlags = { ...FULL_REALISM };
  private coldPsi: WheelPressures = axlePressures(0, 0);
  private onColliders = false;
  /** The track's road collider once the car is on it (`attachTrackRoot`) */
  private collider: GroundQuery | null = null;
  private progressHintS: number | undefined;
  private poseHintS: number | undefined;
  private s = 0;
  private lateral = 0;
  private prevS = 0;
  private lastSector: 1 | 2 | 3 = 1;
  private simTimeMs = 0;
  private lapStartMs = 0;
  private sectorStartMs = 0;
  private lapValid = true;
  /**
   * Track limits: 'strict' deletes the lap the instant the car is off the track; 'judged' leaves the verdict to race
   * control (`TrackLimitsMonitor`), which calls `invalidateLap()` and holds `trackLimitsHold` while it is judging.
   */
  public trackLimitsMode: 'strict' | 'judged' = 'strict';
  public trackLimitsHold = false;
  private lineCrossingStartsLap = true;
  private drsPressPending = false;
  private boostRemainingS = 0;
  private boostCooldownS = 0;
  /** Fuel on board (kg): the garage's starting load at each restart (`fillFuel`) */
  private fuelKg = 0;
  private tcCut = 1;
  private absCut = 1;
  /** Per-wheel ABS pressure share (LF, RF, LR, RR); `absCut` is their minimum */
  private readonly absWheelCut: [number, number, number, number] = [1, 1, 1, 1];
  private readonly prevWheelOmega: [number, number, number, number] = [0, 0, 0, 0];
  private readonly slipScratch = new AxleSlipScratch();
  private steerCmd = 0;
  /** Autopilot pedal (−1 full brake … +1 full throttle): the integral of its speed error */
  private apPedal = 0;
  private apThrottle = 0;
  /** Pulling away from rest (cleared at 20 m/s) */
  private apLaunch = false;
  /** Autopilot steer trim (rad) integrated from the yaw-rate shortfall, i.e. the car's understeer */
  private apYawI = 0;
  private lastAxMs2 = 0;
  private lastAyMs2 = 0;
  private stuckS = 0;

  constructor(track: BuiltTrackData, root?: THREE.Object3D | null, profile: CarSimProfile = F12026_SIM_PROFILE) {
    this.track = track;
    this.profile = profile;
    this.line = profile.racingLine ?? 'f1';
    this.brakingGuide = profile.speedProfile
      ? brakingGuideFor(track.samples, profile.id, profile.speedProfile, this.line)
      : null;
    this.config = structuredClone(profile.config);
    // Unloaded radii, used until the first step
    const geo = compoundData(this.config, this.config.compoundSlots.soft);
    const vis = (radius: number): TyreVisualState => ({
      loadedRadiusM: radius,
      verticalDeflectionM: 0,
      lateralForceN: 0,
      camberRad: 0,
      contactInCar: { x: 0, y: 0, z: 0 },
      onRoad: false,
    });
    this.tyreVisuals = [vis(geo.front.radius), vis(geo.front.radius), vis(geo.rear.radius), vis(geo.rear.radius)];
    this.baseWingDeg = this.config.aero.wings.map((w) => w.angleDeg);
    const sp = this.config.suspensions;
    this.chassisBase = {
      front: { springRate: sp.front.springs.wheel_rate, arb: sp.front.arb, bumpStopRate: sp.front.bumpStop.rate, bumpStopRange: sp.front.bumpStop.range },
      rear: { springRate: sp.rear.springs.wheel_rate, arb: sp.rear.arb, bumpStopRate: sp.rear.bumpStop.rate, bumpStopRange: sp.rear.bumpStop.range },
      maxSteerRad: this.config.chassis.maxRoadWheelDeg * (Math.PI / 180),
      brakeTorqueNm: this.config.brakes.maxTorqueNm,
      diffPreloadNm: this.config.differential.settings.preload,
      frontDamper: { ...sp.dampers_controller.front.base },
      rearDamper: { ...sp.dampers_controller.rear.base },
      frontHeight: this.config.aero.front_target_height,
      rearHeight: this.config.aero.rear_target_height,
    };
    const L = track.totalLengthM;
    this.vehicle = new VehiclePhysics({
      ground: new TrackSampleGroundQuery(track),
      config: this.config,
      compound: this.config.compoundSlots[this.compound],
      airDensity: airDensityAt(track.baseAltitudeM ?? BASE_ALTITUDE_M),
      ambientC: AMBIENT_C,
      drsZones: profile.hasDrs ? RWANDA_DRS_ZONES : [],
      locateProgress: (x, z) => {
        const p = track.projectWorldToTrack(x, z, this.progressHintS);
        this.progressHintS = p.s;
        return p.s / L;
      },
      drsEligibleAtDetection: (zone) => (this.raceControl?.racing ? this.raceControl.earnedAtDetection(zone.id) : true),
      onEvent: (e) => this.onVehicleEvent(e),
    });
    const v = this.vehicle;
    v.turbocharged = profile.turbo;
    this.wheelbaseM = v.wheelbaseM;
    this.cgToFrontAxleM = v.cgToFrontM;
    this.cgToRearAxleM = v.cgToRearM;
    const mkWheel = (): AdapterWheel => ({
      worldPos: { x: 0, y: 0, z: 0 },
      zRoad: 0,
      fzN: 0,
      combinedSlipNorm: 0,
      surfaceType: 'asphalt',
      spinVel: 0,
      brakeTempC: 300,
    });
    this.wheels = [mkWheel(), mkWheel(), mkWheel(), mkWheel()];
    this.applyAssistPresetLevels(this._assistPreset);
    this.telemetry = this.createTelemetry();
    this.telemetry.f12026 = this.channels;
    this.channels.carId = profile.id;
    this.channels.hasErs = profile.hasErs;
    this.channels.hasDrs = profile.hasDrs;
    this.coldPsi = axlePressures(v.wheels[0].coldPressurePsi, v.wheels[2].coldPressurePsi);
    if (root) this.attachTrackRoot(root);
    this.resetToStartGrid(false);
  }

  // ===========================================================================
  // Track
  // ===========================================================================

  /** Where the road under this car's track colliders really ends (null on the sample ground) */
  private autopilotEdges(): AutopilotEdges | null {
    return this.collider ? autopilotEdges(this.track, this.collider) : null;
  }

  /** The autopilot's own limit speed along the lap (m/s, every 5 m): what AI tuning scales */
  public aiBaseSpeedProfile(): Float32Array {
    return autopilotProfile(this.track, this.profile, this.autopilotEdges());
  }

  /** Instantiate an AI opponent car with the exact same vehicle profile and track colliders */
  public createAiPeerCar(): F12026CarSim {
    const peer = new F12026CarSim(this.track, this.trackRoot, this.profile);
    peer.aiAutoTyres = true;
    peer.setOvertakingRules(this.rules);
    return peer;
  }

  get overtakingRules(): OvertakingRules | undefined {
    return this.profile.hasDrs && this.rules !== 'none' ? this.rules : undefined;
  }

  /**
   * The overtaking aids of the car's era: both flaps in every zone + Overtake (2026), the rear flap by the 1 s rule
   * (2011-2025), or none at all (before 2011)
   */
  public setOvertakingRules(rules: OvertakingRules): void {
    this.rules = rules;
    this.vehicle.drsFitted = rules !== 'none';
    this.vehicle.drsFlaps = rules === 'drs-rear' ? 'rear' : 'front-rear';
    this.vehicle.drsGatedByDetection = rules === 'drs-rear';
    this.channels.hasDrs = this.profile.hasDrs && rules !== 'none';
    this.overtake.reset();
  }

  /** 2026 Overtake Mode (the override): usable now — always in practice, in a race once earned at the detection point */
  private get overtakeAvailable(): boolean {
    return this.rules !== 'straight-mode-2026' || this.overtake.available(this.raceControl);
  }

  /** Switch to the GLB's road / surface colliders and barriers (no-op when they cannot be built) */
  public attachTrackRoot(root: THREE.Object3D): void {
    this.trackRoot = root;
    const { ground, walls } = trackColliders(root);
    if (!ground) return;
    const wasOn = this.onColliders;
    this.vehicle.setGround(ground);
    this.vehicle.setWalls(walls);
    this.onColliders = true;
    this.collider = ground;
    // A car at rest is re-seated on the collider heights; a moving one rides over the (small) step
    if (!wasOn && this.vehicle.speedMs < 0.5) {
      const p = this.vehicle.position;
      this.resetVehicle(p.x, p.z, this.yaw());
      this.syncPose();
    }
  }

  public get onTrackColliders(): boolean {
    return this.onColliders;
  }

  /** The track collider the car drives on (null on the track samples' ground), for the rigs to seat the wheels on */
  public get groundQuery(): GroundQuery | null {
    return this.collider;
  }

  // ===========================================================================
  // SimulatorCar surface
  // ===========================================================================

  get sMeters(): number {
    return this.s;
  }

  set sMeters(value: number) {
    const L = this.track.totalLengthM;
    const ds = wrapHalf(value - this.s, L);
    if (ds === 0) return;
    const t = this.track.getSampleAtDistance(this.s).tangent;
    const tl = Math.hypot(t.x, t.z) || 1;
    this.vehicle.position.x += (t.x / tl) * ds;
    this.vehicle.position.z += (t.z / tl) * ds;
    this.poseHintS = wrap(value, L);
    this.syncPose();
  }

  get lateralOffsetM(): number {
    return this.lateral;
  }

  set lateralOffsetM(value: number) {
    const dl = value - this.lateral;
    if (dl === 0) return;
    const b = this.track.getSampleAtDistance(this.s).binormal;
    const bl = Math.hypot(b.x, b.z) || 1;
    this.vehicle.position.x += (b.x / bl) * dl;
    this.vehicle.position.z += (b.z / bl) * dl;
    this.syncPose();
  }

  get vxMs(): number {
    return this.vehicle.velocity.dot(_ez.set(0, 0, 1).applyQuaternion(this.vehicle.quaternion));
  }

  set vxMs(value: number) {
    const v = this.vehicle;
    const vx = this.vxMs;
    if (Math.abs(value - vx) > 3 && Math.abs(vx) < 5 && value > 0) {
      // Kick-start from (near) rest, e.g. engaging the autopilot: a rolling restart in place
      const p = v.position;
      this.resetVehicle(p.x, p.z, this.yaw(), value);
    } else {
      _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
      v.velocity.addScaledVector(_ez, value - vx);
      // Wheel spin follows the new speed; through a change of direction (or near rest) it is set from the speed
      // instead, since scaling by a negative ratio would spin the wheels backwards against the car's travel
      if (Math.abs(vx) > 1 && Math.sign(value) === Math.sign(vx)) {
        const scale = value / vx;
        for (const w of v.wheels) w.omega *= scale;
      } else {
        for (const w of v.wheels) w.omega = value / Math.max(0.2, w.rollingRadius || 0.35);
      }
    }
    this.syncPose();
  }

  get ersEnergyJ(): number {
    return this.vehicle.ersEnergyJ;
  }

  get aeroPreset(): AeroSetupPreset {
    return this.aero;
  }

  set aeroPreset(preset: AeroSetupPreset) {
    this.aero = preset;
    const [front, rear] = this.profile.aeroPackagesDeg[preset];
    const trim = this.wingTrimDeg;
    this.config.aero.wings.forEach((w, i) => {
      w.angleDeg =
        this.baseWingDeg[i] + (w.name === 'FRONT_WING' ? front + trim.front : w.name === 'REAR_WING' ? rear + trim.rear : 0);
    });
  }

  public getChassisSetup(): ChassisSetup {
    return { ...this.chassis };
  }

  /** The vehicle model whose setup limits, wing steps and fuel this car takes */
  private get setupCar(): Exclude<VehicleModelId, 'vf26'> {
    const id = this.profile.id;
    return id === 'amg-gt3' || id === 'liana' ? id : 'f12026-car';
  }

  /** The garage's starting fuel into the car, with the spring preloads set for that load */
  private fillFuel(): void {
    this.fuelKg = startingFuelKg(this.setupCar, this.chassis);
    this.vehicle.setFuelMass(this.fuelKg);
    this.vehicle.refreshStaticGeometry();
    this.telemetry.fuelKg = Number(this.fuelKg.toFixed(2));
  }

  /**
   * Garage chassis setup as offsets from the car's baseline. Springs, bars, dampers and wings are read live by
   * VehiclePhysics; a ride-height change re-derives the spring preloads, so the car settles at the new height.
   */
  public applyChassisSetup(setup: ChassisSetup): void {
    const s = clampChassisSetup(setup);
    const refuel = s.fuelDeltaKg !== this.chassis.fuelDeltaKg;
    this.chassis = s;
    const car = this.setupCar;
    // A new fuel load is put in the car now (and at every restart); other changes leave the fuel burnt so far.
    // The spring preloads below are set for the load on board.
    if (refuel) {
      this.fuelKg = startingFuelKg(car, s);
      this.vehicle.setFuelMass(this.fuelKg);
      this.telemetry.fuelKg = Number(this.fuelKg.toFixed(2));
    }
    const click = WING_CLICK_DEG[car];
    this.wingTrimDeg = { front: s.frontWingClicks * click.front, rear: s.rearWingClicks * click.rear };
    this.aeroPreset = this.aero;
    const base = this.chassisBase;
    const susp = this.config.suspensions;
    const axle = (spec: typeof susp.front, b: typeof base.front, springPct: number, arbPct: number, stopRatePct: number, stopRangeMm: number) => {
      spec.springs.wheel_rate = b.springRate * pctScale(springPct);
      spec.arb = b.arb * pctScale(arbPct);
      spec.bumpStop.rate = b.bumpStopRate * pctScale(stopRatePct);
      spec.bumpStop.range = Math.max(0.002, b.bumpStopRange + stopRangeMm / 1000);
    };
    axle(susp.front, base.front, s.springFrontPct, s.arbFrontPct, s.bumpStopRateFrontPct, s.bumpStopRangeFrontMm);
    axle(susp.rear, base.rear, s.springRearPct, s.arbRearPct, s.bumpStopRateRearPct, s.bumpStopRangeRearMm);
    const damp = (d: typeof susp.dampers_controller.front.base, b: typeof base.frontDamper, front: boolean) => {
      d.slow_bump = b.slow_bump * pctScale(front ? s.bumpFrontPct : s.bumpRearPct);
      d.fast_bump = b.fast_bump * pctScale(front ? s.fastBumpFrontPct : s.fastBumpRearPct);
      d.slow_rebound = b.slow_rebound * pctScale(front ? s.reboundFrontPct : s.reboundRearPct);
      d.fast_rebound = b.fast_rebound * pctScale(front ? s.fastReboundFrontPct : s.fastReboundRearPct);
    };
    damp(susp.dampers_controller.front.base, base.frontDamper, true);
    damp(susp.dampers_controller.rear.base, base.rearDamper, false);
    const v = this.vehicle;
    const DEG = Math.PI / 180;
    v.staticToeRad = { front: s.toeFrontDeg * DEG, rear: s.toeRearDeg * DEG };
    v.engineBrakingScale = pctScale(s.engineBrakingPct);
    v.brakeDuctScale = { front: Math.max(0.3, 1 + s.brakeDuctFront * BRAKE_DUCT_STEP), rear: Math.max(0.3, 1 + s.brakeDuctRear * BRAKE_DUCT_STEP) };
    this.config.brakes.maxTorqueNm = base.brakeTorqueNm * pctScale(s.brakePowerPct);
    this.config.differential.settings.preload = Math.max(0, base.diffPreloadNm + s.diffPreloadNm);
    const ratio = STEER_RATIO_BASE[car];
    v.maxSteerRad = (base.maxSteerRad * ratio) / (ratio + s.steerRatioDelta);
    const aero = this.config.aero;
    const fh = base.frontHeight + s.rideHeightFrontMm / 1000;
    const rh = base.rearHeight + s.rideHeightRearMm / 1000;
    aero.front_target_height = fh;
    aero.rear_target_height = rh;
    // The mean change lifts the whole body (the static geometry sits on the CG height); the difference is rake
    this.vehicle.rideHeightOffsetM = (s.rideHeightFrontMm + s.rideHeightRearMm) / 2000;
    // Spring preloads follow both the rates and the heights
    this.vehicle.refreshStaticGeometry();
  }

  get tireCompound(): TireCompound {
    return this.compound;
  }

  private defaultColdPsiForCompound(): number {
    const cd = this.compoundData;
    const p = cd.pressureData;
    const th = cd.thermalData;
    const targetCoreC = 0.5 * (th.optimalTempC[0] + th.optimalTempC[1]);
    return Math.round(tyreGaugePressureAtTemperature(p.optimalPsi, targetCoreC, p.coldRefC) * 10) / 10;
  }

  set tireCompound(compound: TireCompound) {
    const prevDefault = this.defaultColdPsiForCompound();
    const deltas = { ...this.coldPsi };
    for (const k of ["fl", "fr", "rl", "rr"] as const) deltas[k] -= prevDefault;
    this.compound = compound;
    this.vehicle.setCompound(this.config.compoundSlots[compound]);
    const nextDefault = this.defaultColdPsiForCompound();
    const pr = this.profile;
    for (const k of ["fl", "fr", "rl", "rr"] as const) {
      this.coldPsi[k] = Math.round(THREE.MathUtils.clamp(nextDefault + deltas[k], pr.coldPsiRange[0], pr.coldPsiRange[1]) * 10) / 10;
    }
    this.applyColdPressures();
  }

  get assistPreset(): DriverAssistPreset {
    return this._assistPreset;
  }

  set assistPreset(preset: DriverAssistPreset) {
    this._assistPreset = preset;
    this.applyAssistPresetLevels(preset);
  }

  private applyAssistPresetLevels(preset: DriverAssistPreset): void {
    Object.assign(this, assistPresetDials(this.profile, preset));
  }

  public getLiveTunerState(): LiveTunerState {
    const v = this.vehicle;
    const cut = this.absWheelCut;
    return {
      tcLevel: this.tcLevel,
      tc2Level: this.tc2Level,
      absLevel: this.absLevel,
      brakeBiasPct: Number((v.brakeBias * 100).toFixed(1)),
      brakeMigrationPct: Number((v.liveBrakeMigrationAmount * 100).toFixed(1)),
      diffEntry: v.diffEntryLevel,
      diffMid: v.diffMidLevel,
      diffExit: v.diffExitLevel,
      diffActivePhase: v.diffActivePhase,
      diffLockingTorqueNm: Math.round(v.telemetry.LSD_LOCKING_TORQUE),
      engineMap: v.engineMap,
      // The setting the player picked, not the push mode an override runs: the tuner steps from what it reads back
      ersMode: this.userErsMode,
      hasErs: this.profile.hasErs,
      tcCutFraction: Number(Math.max(0, 1 - this.tcCut).toFixed(3)),
      absCutPerWheel: [
        Number(Math.max(0, 1 - cut[0]).toFixed(3)),
        Number(Math.max(0, 1 - cut[1]).toFixed(3)),
        Number(Math.max(0, 1 - cut[2]).toFixed(3)),
        Number(Math.max(0, 1 - cut[3]).toFixed(3)),
      ],
      mgukGearClipFraction: Number(v.getMgukGearClipFraction().toFixed(3)),
    };
  }

  public setLiveTuner(patch: LiveTunerPatch): void {
    const v = this.vehicle;
    if (patch.tcLevel !== undefined) {
      this.tcLevel = THREE.MathUtils.clamp(Math.round(patch.tcLevel), 0, 12);
    }
    if (patch.tc2Level !== undefined) {
      this.tc2Level = THREE.MathUtils.clamp(Math.round(patch.tc2Level), 1, 12);
    }
    if (patch.absLevel !== undefined) {
      this.absLevel = THREE.MathUtils.clamp(Math.round(patch.absLevel), 0, 12);
    }
    // The mode before the bias: the bias the driver dials is set as their offset on top of the mode's own
    if (patch.ersMode !== undefined && this.profile.hasErs) {
      const m = patch.ersMode as PerformanceModeName;
      if (m === 'PSH' || m === 'RAC' || m === 'BAL' || m === 'LIC' || m === 'CHR') {
        this.userErsMode = m;
        v.setPerformanceMode(m);
      }
    }
    if (patch.brakeBiasPct !== undefined) {
      v.brakeBias = THREE.MathUtils.clamp(patch.brakeBiasPct / 100, 0.45, 0.78);
    }
    if (patch.brakeMigrationPct !== undefined) {
      v.liveBrakeMigrationAmount = THREE.MathUtils.clamp(patch.brakeMigrationPct / 100, 0, 0.06);
    }
    if (patch.diffEntry !== undefined) {
      v.diffEntryLevel = THREE.MathUtils.clamp(Math.round(patch.diffEntry), 1, 12);
    }
    if (patch.diffMid !== undefined) {
      v.diffMidLevel = THREE.MathUtils.clamp(Math.round(patch.diffMid), 1, 12);
    }
    if (patch.diffExit !== undefined) {
      v.diffExitLevel = THREE.MathUtils.clamp(Math.round(patch.diffExit), 1, 12);
    }
    if (patch.engineMap !== undefined) {
      v.engineMap = THREE.MathUtils.clamp(Math.round(patch.engineMap), 1, 5);
    }
    this.telemetry.liveTuner = this.getLiveTunerState();
  }

  /** DRS open = X_MODE (low drag), closed = Z_MODE */
  get activeAeroMode(): ActiveAeroMode {
    return this.vehicle.drsOpen ? 'X_MODE' : 'Z_MODE';
  }

  set activeAeroMode(mode: ActiveAeroMode) {
    if (this.profile.hasDrs && mode !== this.activeAeroMode) this.drsPressPending = true;
  }

  /** The selected compound's data */
  private get compoundData(): TyresCompoundData {
    return compoundData(this.config, this.config.compoundSlots[this.compound]);
  }

  public getTyreSetup(): TyreSetup {
    const s = this.config.suspensions;
    return {
      coldPressurePsi: { ...this.coldPsi },
      camberDeg: { front: s.front.staticCamber, rear: s.rear.staticCamber },
    };
  }

  /** Clamps cold pressure (psi gauge, rounded to 0.1) and camber (degrees) to the active vehicle profile's limits. */
  public setTyreSetup(setup: TyreSetup): void {
    const pick = (v: number, [lo, hi]: [number, number], current: number) => (Number.isFinite(v) ? THREE.MathUtils.clamp(v, lo, hi) : current);
    const pr = this.profile;
    for (const k of ["fl", "fr", "rl", "rr"] as const) {
      this.coldPsi[k] = Math.round(pick(setup.coldPressurePsi[k], pr.coldPsiRange, this.coldPsi[k]) * 10) / 10;
    }
    const s = this.config.suspensions;
    s.front.staticCamber = pick(setup.camberDeg.front, pr.frontCamberRange, s.front.staticCamber);
    s.rear.staticCamber = pick(setup.camberDeg.rear, pr.rearCamberRange, s.rear.staticCamber);
    this.applyColdPressures();
  }

  /** Push mode (PSH) for 8 s; on a 2026 car in a race only with Overtake Mode earned */
  public activateBoostOverride(): boolean {
    if (this.profile.hasErs && this.overtakeAvailable && this.vehicle.ersEnergyJ > 200_000 && this.boostCooldownS <= 0) {
      this.boostRemainingS = BOOST_S;
      return true;
    }
    return false;
  }

  public setAeroWakeState(wake: AeroWakeState | null): void {
    this.lastWake = wake;
    this.vehicle.setAeroWakeState(withDamage(wake, this.damage));
  }

  /** Damage from contact and barriers (car-damage.ts): aero through the wake multipliers, grip and toe per wheel */
  public setDamageEffects(effects: Readonly<CarDamageEffects> | null): void {
    this.damage = effects;
    const v = this.vehicle;
    // Damage wheels are FR, FL, RR, RL; the vehicle's LF, RF, LR, RR
    const map = [1, 0, 3, 2];
    for (let i = 0; i < 4; i++) {
      v.damageGrip[i] = effects ? effects.wheelGripMult[map[i]] : 1;
      v.damageToeRad[i] = effects ? effects.wheelToeRad[map[i]] : 0;
    }
    v.damagePowerMult = effects ? effects.powerMult : 1;
    v.setAeroWakeState(withDamage(this.lastWake, effects));
  }

  public setTrackEvolutionSample(sample: TrackEvolutionSample | null): void {
    this.vehicle.setTrackEvolutionSample(sample);
  }

  /** The weather under the car: water for the tyres, air temperature for tyre / brake cooling and the air density */
  public setWeatherSample(sample: WeatherContactSample): void {
    if (![sample.waterMm, sample.wetness, sample.ambientC].every(Number.isFinite)) return;
    const v = this.vehicle;
    v.waterMm = Math.max(0, sample.waterMm);
    if (sample.wheelWaterMm) {
      // sample.wheelWaterMm is [FR, FL, RR, RL]; v.wheelWaterMm is [LF, RF, LR, RR]
      v.wheelWaterMm[0] = Math.max(0, sample.wheelWaterMm[1] ?? sample.waterMm);
      v.wheelWaterMm[1] = Math.max(0, sample.wheelWaterMm[0] ?? sample.waterMm);
      v.wheelWaterMm[2] = Math.max(0, sample.wheelWaterMm[3] ?? sample.waterMm);
      v.wheelWaterMm[3] = Math.max(0, sample.wheelWaterMm[2] ?? sample.waterMm);
    } else {
      v.wheelWaterMm.fill(v.waterMm);
    }
    v.wetness = Math.min(1, Math.max(0, sample.wetness));
    v.ambientC = sample.ambientC;
    v.windWorld.set(Number.isFinite(sample.windVxMs) ? sample.windVxMs! : 0, 0, Number.isFinite(sample.windVzMs) ? sample.windVzMs! : 0);
    // The circuit's altitude, and warmer air is thinner (ideal gas, about the 27 °C the cars are calibrated at)
    v.airDensity = this.circuitAirDensity() * ((AMBIENT_C + 273.15) / (sample.ambientC + 273.15));
  }

  /** Air density at this circuit's altitude (standard atmosphere): 1.07 at Rwanda, 1.21 at a sea-level track */
  private circuitAirDensity(): number {
    return airDensityAt(this.track.baseAltitudeM ?? BASE_ALTITUDE_M);
  }

  /** Simulation realism: tyre wear, temperature grip, fuel use and wet severity */
  public setSimRealism(flags: SimRealismFlags): void {
    this.realism = { ...flags };
    this.vehicle.realism = { ...flags };
  }

  /** Car-to-car contact as world deltas (see `SimulatorCar.applyRigidBodyCollision` for the convention) */
  public applyRigidBodyCollision(
    posDeltaX: number,
    posDeltaZ: number,
    velDeltaX: number,
    velDeltaZ: number,
    yawRateDeltaRadS: number
  ): void {
    if (![posDeltaX, posDeltaZ, velDeltaX, velDeltaZ, yawRateDeltaRadS].every(Number.isFinite)) return;
    const v = this.vehicle;
    v.position.x += posDeltaX;
    v.position.z += posDeltaZ;
    v.velocity.x += velDeltaX;
    v.velocity.z += velDeltaZ;
    // World angular velocity: + about +Y is counter-clockwise from above, the delta's convention
    v.angularVelocity.y += yawRateDeltaRadS;
    this.syncPose();
  }

  /**
   * Standing start from grid slot `gridSlot` (0 = pole), or a flying lap from the run-up of the main
   * straight (further slots queue 28 m apart, alternating sides), as the VF26 does.
   */
  public resetToStartGrid(flyingStart = false, gridSlot = 0): void {
    // Fuelled before it is seated, so it settles at the ride height of that load
    this.fillFuel();
    const L = this.track.totalLengthM;
    if (flyingStart) {
      // From the final straight (`flyingStartPoint`), on this car's line, kept on the asphalt, and no faster than
      // 90 % of the speed this car's autopilot plans there, nor than it can carry out of the last corner
      const start = flyingStartPoint(this.track);
      const s = wrap(start.s - gridSlot * 28, L);
      const smp = this.track.getSampleAtDistance(s);
      const [lo, hi] = autopilotLateralRange(this.track, smp, s, this.autopilotEdges(), this.profile);
      const stagger = gridSlot === 0 ? 0 : gridSlot % 2 === 1 ? -2.6 : 2.6;
      const lateral = THREE.MathUtils.clamp(aiLineOffsetM(smp, this.line) + stagger, Math.min(0, lo), Math.max(0, hi));
      const prof = autopilotProfile(this.track, this.profile, this.autopilotEdges());
      const ownAt = (at: number) => prof[Math.floor(wrap(at, L) / (L / prof.length)) % prof.length];
      let speed = Math.min(75, 0.9 * Math.min(ownAt(s), (smp.brakeLimitKmh ?? smp.optimalSpeedKmh) / 3.6));
      if (start.cornerS !== null) {
        const corner = Math.min(ownAt(start.cornerS), this.track.getSampleAtDistance(start.cornerS).optimalSpeedKmh / 3.6);
        speed = Math.min(speed, flyingExitSpeedMs(0.9 * corner, wrap(s - start.cornerS, L)));
      }
      this.placeAt(s, lateral, speed);
    } else {
      const grid = this.track.spawnGrid;
      const slot = grid[Math.min(gridSlot, grid.length - 1)];
      if (slot) {
        this.progressHintS = this.poseHintS = slot.s;
        this.resetVehicle(slot.position[0], slot.position[2], slot.yawRad);
      } else {
        this.placeAt(L - 12 - gridSlot * 8, 0, 0);
      }
    }
    this.afterPlacement();
    this.vehicle.ersEnergyJ = this.config.ers.ERS_MAX_CHARGE;
    this.vehicle.resetLapEnergy();
    this.simTimeMs = 0;
    this.lapStartMs = 0;
    this.sectorStartMs = 0;
    this.lapValid = true;
    this.telemetry.lapInvalid = false;
    this.lineCrossingStartsLap = true;
    this.telemetry.currentLapTimeMs = 0;
    this.telemetry.topSpeedThisLapKmh = 0;
  }

  public teleportToDistance(sMeters: number, speedMs = 0, lateral = 0): void {
    this.lineCrossingStartsLap = false;
    // Moved mid-lap (corner practice, a stuck or lost car's rescue): the lap under way can't count
    this.invalidateLap();
    this.placeAt(wrap(sMeters, this.track.totalLengthM), lateral, Math.max(0, speedMs));
    this.afterPlacement();
  }

  /** Flashback: back on the ground at a replayed pose, rolling at its speed, with the tyres as they are now */
  public restorePose(pose: { x: number; z: number; yawRad: number; speedMs: number; s?: number }): void {
    // A flashback moves the car mid-lap: the timed lap under way can't count (an out-lap, not yet timed, carries on)
    if (!this.lineCrossingStartsLap) this.invalidateLap();
    const p = this.track.projectWorldToTrack(pose.x, pose.z, pose.s ?? this.s);
    this.progressHintS = this.poseHintS = p.s;
    this.resetVehicle(pose.x, pose.z, pose.yawRad, Math.max(0, pose.speedMs), true);
    this.afterPlacement();
  }

  public teleportToTurn(turnNumber: number): void {
    const samples = this.track.samples;
    const idx = samples.findIndex((s) => s.turnNumber === turnNumber);
    const target = idx >= 0 ? samples[(idx + 2) % samples.length] : samples[0];
    // On the racing line heading along it, not along the centreline: where the line crosses the track the car
    // could not catch the corner and ran off
    const onLine = (s: number): [number, number] => {
      const sm = this.track.getSampleAtDistance(wrap(s, this.track.totalLengthM));
      const b = sm.binormal;
      const bl = Math.hypot(b.x, b.z) || 1;
      const lat = aiLineOffsetM(sm, this.line);
      return [sm.position.x + (b.x / bl) * lat, sm.position.z + (b.z / bl) * lat];
    };
    const [x, z] = onLine(target.s);
    const [xa, za] = onLine(target.s - 2.5);
    const [xb, zb] = onLine(target.s + 2.5);
    this.lineCrossingStartsLap = false;
    // Corner practice moves the car mid-lap: the lap under way can't count
    this.invalidateLap();
    this.progressHintS = this.poseHintS = target.s;
    this.resetVehicle(x, z, Math.atan2(xb - xa, zb - za), Math.min(62, target.optimalSpeedKmh / 3.6));
    this.afterPlacement();
  }

  public step(dtSeconds: number, raw: Partial<ControlInputs>): CarTelemetry {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return this.telemetry;
    const v = this.vehicle;
    const inputs = {
      throttle: THREE.MathUtils.clamp(raw.throttle ?? 0, 0, 1),
      brake: THREE.MathUtils.clamp(raw.brake ?? 0, 0, 1),
      steerLeft: raw.steerLeft ?? 0,
      steerRight: raw.steerRight ?? 0,
      analogSteer: raw.analogSteer,
      padSteer: raw.padSteer !== undefined ? THREE.MathUtils.clamp(raw.padSteer, -1, 1) : undefined,
      kbSteer: raw.kbSteer !== undefined ? Math.sign(raw.kbSteer) : undefined,
      manualOverride: raw.manualOverride ?? false,
      toggleXMode: raw.toggleXMode ?? false,
      shiftUp: raw.shiftUp ?? false,
      shiftDown: raw.shiftDown ?? false,
    };
    if (inputs.toggleXMode && this.profile.hasDrs) this.drsPressPending = true;
    if (this.aiAutopilot) {
      // The autopilot takes the car after a stint off: its pedal and steer integrators start from zero, not from its
      // last drive. A brief hand-back (an AI driver's reaction to a knock) carries on from where it was.
      if (this.autopilotIdleS > AUTOPILOT_STALE_S) this.apPedal = this.apYawI = this.apThrottle = 0;
      this.autopilotIdleS = 0;
    } else {
      this.autopilotIdleS += dtSeconds;
    }

    // Push mode while the override is held / latched, or for the boost's 8 s
    this.boostCooldownS = Math.max(0, this.boostCooldownS - dtSeconds);
    if (this.boostRemainingS > 0) {
      this.boostRemainingS = Math.max(0, this.boostRemainingS - dtSeconds);
      if (this.boostRemainingS === 0) this.boostCooldownS = BOOST_COOLDOWN_S;
    }
    // 2026: the override is Overtake Mode, earned in a race within 1 s at the detection point for the lap after it
    // (with its extra energy); an AI car spends it in the zones, where it overtakes
    const overtakeOk = this.overtakeAvailable;
    if (!overtakeOk) this.boostRemainingS = 0;
    const aiOvertake = this.aiAutopilot && this.rules === 'straight-mode-2026' && !!this.raceControl?.racing && overtakeOk && v.telemetry.drsZone;
    const push = this.profile.hasErs && overtakeOk && (inputs.manualOverride || this.boostRemainingS > 0 || aiOvertake) && v.ersEnergyJ > 0;
    this.pushActive = push;
    v.setPerformanceMode(push ? 'PSH' : this.userErsMode);
    v.extraDeployJ = this.rules === 'straight-mode-2026' ? this.overtake.extraDeployJ(this.raceControl) : 0;
    const progressBefore = v.trackProgress;

    const slices = Math.max(1, Math.ceil(dtSeconds / AID_SLICE_S - 1e-9));
    const h = dtSeconds / slices;
    // The paddles and the DRS button go to every slice of the frame: VehiclePhysics compares each slice with the one
    // before, so a press is one edge per frame (released in the later slices, a held paddle was a new press each frame)
    const drsPress = this.drsPressPending;
    this.drsPressPending = false;
    this.vehicle.autoShift = this.autoGearbox || this.aiAutopilot;
    for (let k = 0; k < slices; k++) {
      const cmd: { throttle: number; ignitionCut: number; brake: number; brakeWheelScale?: readonly [number, number, number, number]; steer: number; drs: boolean } =
        this.aiAutopilot ? this.autopilot(h) : this.driverCommand(inputs, h);
      const vin: VehicleInputs = {
        throttle: cmd.throttle,
        ignitionCut: cmd.ignitionCut,
        brake: cmd.brake,
        brakeWheelScale: cmd.brakeWheelScale,
        steer: cmd.steer,
        drs: drsPress || cmd.drs,
        shiftUp: inputs.shiftUp,
        shiftDown: inputs.shiftDown,
      };
      this.steerCmd = cmd.steer;
      _v.copy(v.velocity);
      v.step(h, vin);
      this.updateBrakes(h);
      // Divided by the time the fixed steps actually covered: a slice runs a whole number of 2 ms steps, not h
      const stepS = v.lastStepTimeS;
      if (stepS > 0) {
        const dvx = _v.subVectors(v.velocity, _v);
        this.lastAxMs2 = dvx.dot(_ez.set(0, 0, 1).applyQuaternion(v.quaternion)) / stepS;
        this.lastAyMs2 = dvx.dot(_ex.set(1, 0, 0).applyQuaternion(v.quaternion)) / stepS;
      }
    }
    if (this.rules === 'straight-mode-2026' && this.profile.hasDrs) {
      this.overtake.observe(progressBefore, v.trackProgress, RWANDA_DRS_ZONES, this.raceControl);
    }
    if (v.telemetry.throttle > 0.01 && this.fuelKg > 0 && this.realism.fuelUse) {
      const mapFlowMult = v.engineMap === 1 ? 1.04 : v.engineMap === 2 ? 1.0 : v.engineMap === 3 ? 0.96 : v.engineMap === 4 ? 0.90 : 0.85;
      const baseFlowKgS = this.profile.fuelFlowKgS ?? (this.profile.id === 'amg-gt3' ? 0.036 : 0.0278);
      this.fuelKg = Math.max(0, this.fuelKg - baseFlowKgS * mapFlowMult * v.telemetry.throttle * dtSeconds);
      v.setFuelMass(this.fuelKg);
    }
    this.simTimeMs += dtSeconds * 1000;
    if (this.recoverIfLost()) return this.telemetry;
    if (this.aiAutopilot && this.aiSelfRecovery) this.recoverIfStuck(dtSeconds);
    else this.stuckS = 0;
    this.wheelRotationRad = (this.wheelRotationRad + 0.5 * (v.wheels[2].omega + v.wheels[3].omega) * dtSeconds) % (Math.PI * 2);
    this.syncPose();
    this.updateTiming();
    this.updateTelemetry(inputs);
    return this.telemetry;
  }

  // ===========================================================================
  // Inputs
  // ===========================================================================

  /**
   * Steering (wheel / mouse straight to the rack; keyboard, and the controller unless its assist is off, through the
   * steering assist) and 130 Hz TC1/TC2 + 240 Hz 4-Ch ABS
   */
  private driverCommand(
    inputs: ControlInputs,
    h: number
  ): { throttle: number; ignitionCut: number; brake: number; brakeWheelScale?: readonly [number, number, number, number]; steer: number; drs: boolean } {
    const want = THREE.MathUtils.clamp(this.steeringAssist.steer(inputs, this.gamepadAssistEnabled, this.steeringAssistState, h), -1, 1);
    // The rack turns no faster than hands turn a wheel (900°/s at the rim, as the VF26's): a stick flick or a phone tilt
    // otherwise reached the tyres as an instant step, which snaps a car at speed
    const maxStep = (DRIVER_RIM_SPEED_DEG_S / (this.config.chassis.maxRoadWheelDeg * RIM_PER_ROAD_WHEEL)) * h;
    const steer = this.steerCmd + THREE.MathUtils.clamp(want - this.steerCmd, -maxStep, maxStep);
    return { ...this.electronicAids(inputs.throttle, inputs.brake, h, this), steer, drs: false };
  }

  /** The car as the steering assist reads it */
  private readonly steeringAssistState = (brake: number): SteeringAssistCarState => {
    const v = this.vehicle;
    // The tyres' live slip per axle, for the learned peak slip angle
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const o = this.slipScratch.wheels[i];
      o.loadN = w.grounded ? w.fz : 0;
      o.slipAngleRad = w.slipAngleRad;
      o.ndSlip = w.combinedSlip;
      o.slipRatio = w.slipRatio;
      o.onRoad = w.ground.surface === 'road' || w.ground.surface === 'pitlane';
    }
    const wetMuScale =
      v.waterMm > 0
        ? wetGripFactor(
            this.compoundData.wetTraits ?? SLICK_TRAITS,
            v.waterMm,
            v.speedMs,
            v.realism.wetSeverity,
            0.5 * (v.wheels[0].wear + v.wheels[1].wear)
          ) / (this.compoundData.wetTraits?.dryGrip ?? 1)
        : 1;
    return {
      vxMs: this.vxMs,
      vyMs: this.bodyVy(),
      yawRateRadS: this.bodyYawRate(),
      cgToFrontAxleM: this.cgToFrontAxleM,
      cgToRearAxleM: this.cgToRearAxleM,
      wheelbaseM: this.wheelbaseM,
      maxSteerAngleRad: this.maxSteerAngleRad,
      frontPeakSlipRad: this.frontPeakSlipRad(),
      brake,
      maxLateralAccel: this.profile.padLateralMu * wetMuScale * (G + v.telemetry.downforceN / v.totalMassKg),
      slip: this.slipScratch.sample(),
      frontComplianceRad: -leastBent(v.wheels[0].complianceRad, v.wheels[1].complianceRad),
    };
  };

  /**
   * 130 Hz TC1/TC2 + 240 Hz 4-Ch ABS on the pedals, at the given dial positions (the driver's, or the autopilot's). The
   * TC cuts spark and fuel (`ignitionCut`), which takes torque off at once; the pedal itself passes through
   */
  private electronicAids(
    throttleIn: number,
    brake: number,
    h: number,
    dials: AidDials
  ): { throttle: number; ignitionCut: number; brake: number; brakeWheelScale: readonly [number, number, number, number] } {
    const v = this.vehicle;
    const W = v.wheels;
    const speed = v.speedMs;
    const elec = this.profile.electronics ?? F12026_ELECTRONICS;

    // 130 Hz 2-Stage Traction Control (TC1 slip target + Lateral-G compensation + TC2 spark/cylinder cut)
    const throttle = throttleIn;
    let ignitionCut = 1;
    const tcLv = THREE.MathUtils.clamp(Math.round(dials.tcLevel), 0, 12);
    const tcBaseTarget = tcLv > 0 ? elec.tcLevels[THREE.MathUtils.clamp(12 - tcLv, 0, elec.tcLevels.length - 1)] : 0;
    const tcMinSpeedMs = elec.tcMinSpeedKmh / 3.6;
    if (tcBaseTarget > 0 && speed > Math.max(this.profile.tcMinSpeedMs, tcMinSpeedMs)) {
      // Lateral-G slip target tightening: kappa_target(ay) = kappa_TC1 * max(floor, 1.0 - gain * (|ay|/g)^exponent)
      const tight = elec.tcLateralTightening ?? DEFAULT_TC_LATERAL_TIGHTENING;
      const gLat = Math.abs(this.lastAyMs2) / G;
      const saLimitRad = Math.max(0.05, (this.compoundData.modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD);
      // The driven axle's tyres: the rears on an F1 car or a GT3, the fronts on a front-wheel-drive car
      const [dl, dr] = v.drivenWheels;
      const saDriven = Math.max(Math.abs(W[dl].slipAngleRad), Math.abs(W[dr].slipAngleRad)) / saLimitRad;
      const slide = v.waterMm > 0 ? { gain: 0.22, from: 0.45 } : elec.tcDryRearSlide;
      const slideTerm = slide ? slide.gain * Math.max(0, saDriven - slide.from) : 0;
      const latFactor = Math.max(tight.floor, 1 - tight.gain * Math.pow(gLat, tight.exponent) - slideTerm);
      const tcEffTarget = tcBaseTarget * latFactor;
      // Weighted driven axle slip: 0.65 * max(k_L, k_R) + 0.35 * mean(k_L, k_R)
      const kL = Math.max(0, W[dl].slipRatio);
      const kR = Math.max(0, W[dr].slipRatio);
      const kDriven = 0.65 * Math.max(kL, kR) + 0.35 * (0.5 * (kL + kR));
      const eTc = Math.max(0, kDriven - tcEffTarget);
      const tc2 = THREE.MathUtils.clamp(dials.tc2Level, 1, 12);
      const tc2Norm = (tc2 - 1) / 11;
      // Stage A (0 < eTc <= 0.03): smooth spark timing retard up to 25% cut
      const stageACut = Math.min(1, eTc / 0.03) * 0.25 * (0.55 + 0.45 * tc2Norm);
      // Stage B (eTc > 0.03): sequential cylinder cut scaled by TC2 up to 85% total cut
      const peak = Math.max(0.05, this.compoundData.modelData.slip_ratio_limit);
      const stageBCut = eTc > 0.03 ? ((eTc - 0.03) / peak) * (1.6 + 3.2 * tc2Norm) : 0;
      const minThrottleShare = Math.max(0.05, 0.18 - 0.011 * tc2);
      const want = eTc > 0 ? Math.max(minThrottleShare, 1 - stageACut - stageBCut) : 1;
      const tcRate = elec.tcRateHz;
      this.tcCut += (want - this.tcCut) * Math.min(1, (want < this.tcCut ? tcRate : tcRate * 0.24) * h);
      ignitionCut = this.tcCut;
    } else {
      this.tcCut = 1;
    }

    // 240 Hz 4-Channel Independent ABS (per-wheel slip + angular decel anticipation + rear yaw stability)
    const absLv = THREE.MathUtils.clamp(Math.round(dials.absLevel), 0, 12);
    const absBaseTarget = absLv > 0 ? elec.absLevels[THREE.MathUtils.clamp(12 - absLv, 0, elec.absLevels.length - 1)] : 0;
    const cut = this.absWheelCut;
    if (this.absCut === 1) cut.fill(1);
    if (absBaseTarget > 0 && speed > 3 && brake > 0.01) {
      const absRate = elec.absRateHz;
      const guard = elec.absRearSlipAngleGuard ?? DEFAULT_ABS_REAR_GUARD;
      let minCut = 1;
      for (let i = 0; i < 4; i++) {
        const w = W[i];
        const wheelDecel = Math.max(0, -(w.omega - this.prevWheelOmega[i]) / Math.max(1e-4, h));
        const decelAnticipation = ((wheelDecel * w.rollingRadius) / Math.max(8, speed)) * 0.016;
        const lock = -w.slipRatio + decelAnticipation;
        // Rear channels tighten target under trail-braking slip angle to prevent rear axle step-out
        const rearLatGuard = i >= 2 ? Math.max(guard.floor, 1 - guard.gain * Math.max(0, Math.abs(w.slipAngleRad) - guard.deadbandRad)) : 1;
        const effAbsTarget = absBaseTarget * rearLatGuard;
        const want = lock > effAbsTarget ? Math.max(0.08, 1 - (lock - effAbsTarget) * 12.5) : 1;
        cut[i] += (want - cut[i]) * Math.min(1, (want < cut[i] ? absRate * 0.65 : absRate * 0.16) * h);
        minCut = Math.min(minCut, cut[i]);
      }
      this.absCut = minCut;
    } else {
      this.absCut = 1;
      cut.fill(1);
    }
    for (let i = 0; i < 4; i++) this.prevWheelOmega[i] = W[i].omega;
    return { throttle, ignitionCut, brake, brakeWheelScale: cut };
  }

  /**
   * Autopilot: pure pursuit on the racing line with countersteer on body slip, a target speed of
   * `aiPaceScale` × this car's limit speed just ahead (its own profile, never above the circuit's braking-limit
   * speed), the pedals through the car's own TC and 4-channel ABS at the semi-pro dials.
   * Opens DRS on full throttle when it is available.
   */
  private autopilot(h: number): {
    throttle: number;
    ignitionCut: number;
    brake: number;
    brakeWheelScale: readonly [number, number, number, number];
    steer: number;
    drs: boolean;
  } {
    // The player's steering assist holds nothing while the autopilot drives, so a hand-back starts from centre
    this.steeringAssist.reset();
    const v = this.vehicle;
    const L = this.track.totalLengthM;
    const speed = v.speedMs;
    const p = this.track.projectWorldToTrack(v.position.x, v.position.z, this.poseHintS);
    _ex.set(1, 0, 0).applyQuaternion(v.quaternion);
    _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
    const beta = Math.atan2(v.velocity.dot(_ex), Math.max(1, v.velocity.dot(_ez)));
    const plan = this.aiPlan;
    let kappa: number;
    if (plan) {
      kappa = this.planCurvature(plan, p, speed);
    } else {
    const look = this.track.getSampleAtDistance((p.s + Math.max(10, (speed * 0.55) / this.aiSteerGain)) % L);
    // the racing line uses the kerbs; the autopilot keeps all four wheels on the asphalt
    const [lookLo, lookHi] = autopilotLateralRange(this.track, look, look.s, this.autopilotEdges(), this.profile);
    const off = THREE.MathUtils.clamp(aiLineOffsetM(look, this.line) + this.aiLineBiasM, lookLo, lookHi);
    const dx = look.position.x + look.binormal.x * off - v.position.x;
    const dz = look.position.z + look.binormal.z * off - v.position.z;
    const dl = Math.hypot(dx, dz);
    const alpha = Math.atan2(dx * _ex.x + dz * _ex.z, dx * _ez.x + dz * _ez.z);
    // Pure pursuit asks for a path curvature; yaw-rate PI makes the car actually turn at it, so its
    // understeer at speed does not carry it wide of the line
    kappa = (2 * Math.sin(alpha)) / Math.max(5, dl);
    // ... plus a pull back onto the line here and now, on the error and its rate (the pursuit alone let the car run
    // 2 m past its line and the edge on Daytona's banking exits and into Rwanda's turn 1), capped so a car well off
    // the line rejoins it rather than asking the tyres for a second corner
    {
      const [lo, hi] = autopilotLateralRange(this.track, p.sample, p.s, this.autopilotEdges(), this.profile);
      const lineNow = THREE.MathUtils.clamp(aiLineOffsetM(p.sample, this.line) + this.aiLineBiasM, lo, hi);
      const b = p.sample.binormal;
      const bl = Math.hypot(b.x, b.z) || 1;
      // + lateral is this far to the car's left
      const leftOf = (b.x * _ex.x + b.z * _ex.z) / bl;
      const errLeft = (lineNow - p.lateralOffset) * leftOf;
      const rateLeft = -((v.velocity.x * b.x + v.velocity.z * b.z) / bl) * leftOf;
      const aLat = THREE.MathUtils.clamp(
        (AP_LINE_KP * errLeft + AP_LINE_KD * rateLeft) * this.aiSteerGain,
        -AP_LINE_MAX_MS2,
        AP_LINE_MAX_MS2
      );
      kappa += aLat / Math.max(100, speed * speed);
    }
    }
    // The path curvature is in the horizontal plane, so the yaw that follows it is about world up, not the body's
    // (on Daytona's 31° banking the body's is cos 31° of it, and the integrator built up there sent the car off the
    // banking wide)
    const yawErr = speed * kappa - v.angularVelocity.y;
    const kYaw = v.wheelbaseM / Math.max(10, speed);
    // past 65 m/s the yaw loop alone is too slow for the car's own response
    const kYawP = 0.5 + 3 * THREE.MathUtils.clamp((speed - 65) / 30, 0, 1);
    // Never steer the fronts far past their peak slip angle: beyond it they only scrub and the car runs wide
    // (the integrator holds while the governor is on, so it cannot wind up)
    // Braking takes its share of the fronts' grip (the tyre's friction ellipse), so the harder they brake the less
    // lateral slip is worth asking of them: the allowance shrinks with the fronts' normalised braking slip ratio. Only
    // braking: a front-drive car's unloaded inside front spins up on the way out of a slow corner (an open diff), and
    // counting that drive slip choked the lock to under half the peak, so the car ran straight off the exit
    const [fl, fr] = v.wheels;
    const sxF =
      (0.5 * (Math.max(0, -fl.slipRatio) + Math.max(0, -fr.slipRatio))) / Math.max(0.01, this.compoundData.modelData.slip_ratio_limit);
    const peak = this.frontPeakSlipRad() * Math.sqrt(Math.max(0.2, 1.15 * 1.15 - sxF * sxF));
    const betaF = Math.atan2(v.velocity.dot(_ex) - this.bodyYawRate() * this.cgToFrontAxleM, Math.max(1, v.velocity.dot(_ez)));
    // the car's understeer at the lateral acceleration asked for, steered in up front rather than left to the integrator:
    // the profile's calibrated gradient, else the front slip the corner needs at the fronts' present cornering stiffness
    // (it saturates with load, so a car pressed into a compression needs lock the yaw loop could not find in time)
    const kF = fl.corneringStiffness + fr.corneringStiffness;
    const understeer =
      this.profile.understeerRadPerMs2 !== undefined
        ? this.profile.understeerRadPerMs2 * speed * speed * kappa
        : kF > 0
          ? THREE.MathUtils.clamp((v.totalMassKg * speed * speed * kappa * this.cgToRearAxleM) / (v.wheelbaseM * kF), -peak, peak)
          : 0;
    const raw = Math.atan(v.wheelbaseM * kappa) + understeer + 0.8 * beta + kYawP * kYaw * yawErr + this.apYawI;
    const delta = THREE.MathUtils.clamp(raw, betaF - peak, betaF + peak);
    const frontsSaturated = delta !== raw;
    if (!frontsSaturated) this.apYawI = THREE.MathUtils.clamp(this.apYawI + yawErr * kYaw * 2 * h, -0.05, 0.05);
    // Braking envelope of this car: its own limit speeds (capped at the circuit's) × pace over the next 300 m,
    // each reachable by braking at the f12026-car's own deceleration. Aimed a little ahead of the car to cover the
    // pedal's lag.
    const lead = Math.max(5, speed * 0.2);
    const prof = autopilotProfile(this.track, this.profile, this.autopilotEdges());
    const b = envelopeAt(this.profile.braking, this.circuitAirDensity());
    let vTarget = this.aiSpeedCapMs;
    let pedalFF = 0;
    if (plan) {
      const r = this.planSpeedTarget(plan, p.s, speed, prof);
      // A cap below the plan (traffic, a rejoin) rules: the plan's own pedal feed-forward doesn't apply then
      if (r.v <= vTarget) {
        vTarget = r.v;
        pedalFF = r.pedalFF;
      }
    }
    for (let d = 0; d <= 300 && !plan; d += 5) {
      const smp = this.track.getSampleAtDistance((p.s + lead + d) % L);
      const tab = this.aiTargetSpeedMs ?? prof;
      const own = tab[Math.floor(((p.s + lead + d) % L) / (L / tab.length)) % tab.length];
      const vC = Math.min((smp.brakeLimitKmh ?? smp.optimalSpeedKmh) / 3.6, own) * this.aiPaceScale;
      if (vC >= vTarget) continue;
      const a = 0.5 * (autopilotDecel(b, vC) + autopilotDecel(b, Math.min(speed, Math.sqrt(vC * vC + 2 * autopilotDecel(b, vC) * d))));
      vTarget = Math.min(vTarget, Math.sqrt(vC * vC + 2 * a * d));
    }
    // Off the line the corner is tighter than planned: give speed away for it
    if (!plan) {
      const lineErr = Math.abs(aiLineOffsetM(p.sample, this.line) + this.aiLineBiasM - p.lateralOffset);
      vTarget *= 1 - 0.04 * Math.min(5, Math.max(0, lineErr - 1));
    }
    // PI on speed: the integral alone lags a falling target, so the car braked on past each apex speed it was given
    const vErr = vTarget - speed;
    const pedalP = AP_PEDAL_P * vErr;
    // the integral does not wind on into a pedal already pinned that way
    if (!(Math.abs(this.apPedal + pedalP) >= 1 && Math.sign(vErr) === Math.sign(this.apPedal + pedalP))) {
      this.apPedal = THREE.MathUtils.clamp(this.apPedal + vErr * 0.01 * (h * 120), -1, 1);
    }
    const pedal = THREE.MathUtils.clamp(this.apPedal + pedalP + pedalFF, -1, 1);
    const W = v.wheels;
    // The rear stepping out (on a trail-braked entry, or on the power): ease both pedals as the rears' slip angle
    // passes AP_REAR_GUARD of their peak, so they regain grip to hold the car with rather than spinning it
    const rearSlip = Math.max(Math.abs(W[2].slipAngleRad), Math.abs(W[3].slipAngleRad)) / peak;
    const rearCut = THREE.MathUtils.clamp(1 - AP_REAR_GUARD_GAIN * (rearSlip - AP_REAR_GUARD), 0.15, 1);
    // squeezed on rather than stabbed: at most full throttle in 0.4 s. Off the line (from rest until 72 km/h) it goes
    // down at once, the traction control metering the wheelspin as on a player's launch (the squeeze cost the AI a car
    // length to 100 km/h). Only from rest: a quick pedal out of a slow corner put the car in the barrier at Sepang
    if (speed < 1) this.apLaunch = true;
    else if (speed > 20) this.apLaunch = false;
    const squeeze = this.apLaunch ? 12 : 2.5;
    const throttle = Math.min(Math.max(0, pedal), this.apThrottle + squeeze * h) * rearCut;
    this.apThrottle = throttle;
    // The car's own TC and per-wheel ABS: a lock-up of the unloaded inside front no longer takes the brakes off all
    // four wheels (the car then ran into the corner 20-25 km/h hot), nor inside-rear wheelspin the whole throttle
    const aids = this.electronicAids(
      throttle,
      // understeering on the brakes: ease off so the fronts have grip left to turn with
      Math.max(0, -pedal) * (frontsSaturated ? 0.5 : 1) * rearCut,
      h,
      assistPresetDials(this.profile, 'semi_pro')
    );
    return {
      ...aids,
      // aimed at the road-wheel angle: the rack gives up `complianceRad` to the lateral force, so add it back
      steer: this.autopilotSteer(THREE.MathUtils.clamp(-(delta - 0.5 * (W[0].complianceRad + W[1].complianceRad)) / v.maxSteerRad, -1, 1), h),
      drs: v.telemetry.drsAvailable && !v.drsOpen && aids.throttle > 0.95,
    };
  }

  /**
   * The autopilot's steering, turned no faster than a driver's hands can turn the wheel when it tracks a plan (the
   * player's 900°/s at the rim): a hand-back after a knock otherwise slammed the rack across in one step
   */
  private autopilotSteer(want: number, h: number): number {
    if (!this.aiPlan) return want;
    const maxStep = (DRIVER_RIM_SPEED_DEG_S / (this.config.chassis.maxRoadWheelDeg * RIM_PER_ROAD_WHEEL)) * h;
    return this.steerCmd + THREE.MathUtils.clamp(want - this.steerCmd, -maxStep, maxStep);
  }

  /**
   * Where the car's centre may be at lap distance `s` (m, + right): the autopilot's usable road (track edges, raised
   * lips under the colliders, half the car's track plus a margin), plus `TRACK_KERB_ALLOW_M` over an edge with a kerb
   * that isn't a lip. The line generator bounds its lines with this, and the tracker keeps its target inside it.
   */
  public lateralRangeAt(s: number, sample: TrackSamplePoint = this.track.getSampleAtDistance(s)): [number, number] {
    const edges = this.autopilotEdges();
    let [lo, hi] = autopilotLateralRange(this.track, sample, s, edges, this.profile);
    const half = sample.width / 2;
    let lipNeg = false, lipPos = false;
    if (edges) {
      const n = edges.neg.length;
      const i = Math.round((wrap(s, this.track.totalLengthM) / this.track.totalLengthM) * n) % n;
      lipNeg = edges.neg[i] < half - 0.05;
      lipPos = edges.pos[i] < half - 0.05;
    }
    if (sample.kerbLeft && !lipNeg) lo -= TRACK_KERB_ALLOW_M;
    if (sample.kerbRight && !lipPos) hi += TRACK_KERB_ALLOW_M;
    return [lo, hi];
  }

  /**
   * The curvature (+ left, as the pursuit's) to steer for on a supplied plan: the path's own, a little ahead for the
   * steering's lag, plus a pull onto the path on the lateral error and its rate. The target is the plan's offset with
   * the traffic bias, kept inside the autopilot's usable road (edges and lips as ever).
   */
  private planCurvature(plan: AiDrivePlan, p: { s: number; lateralOffset: number; sample: TrackSamplePoint }, speed: number): number {
    const v = this.vehicle;
    const t = plan.track;
    // Pure pursuit on the plan's own path with a short look-ahead: geometric, so it holds when the line crosses the
    // road at a steep angle (a tight corner's turn-in), where errors measured across the track misled a lateral loop.
    // The look-ahead is short enough that the corner-cutting it brings stays a few decimetres.
    // Metres off the path (a start, a rejoin, a knock), the look-ahead stretches so that getting back asks for about
    // TRACK_REJOIN_MS2: pursuit asks ≈ 2v²e/L², and 4 m off at 190 km/h a short look-ahead asked for several g and spun
    // the car. Within a metre it stays short: tracking errors there are the pursuit's own, and stretching for them
    // only cut the corners further
    const [lo0, hi0] = this.lateralRangeAt(p.s, p.sample);
    const nNow = THREE.MathUtils.clamp(sampleGrid(plan.n, p.s, t.ds) + this.aiLineBiasM, lo0, hi0);
    const eFar = Math.max(0, Math.abs(nNow - p.lateralOffset) - 1);
    const ld = Math.max(TRACK_LOOK_MIN_M, speed * TRACK_LOOK_S, Math.sqrt((2 * speed * speed * eFar) / TRACK_REJOIN_MS2)) / this.aiSteerGain;
    // The look-ahead along the path, as centreline distance (the inside of a corner covers less path per metre of
    // centreline, the outside more)
    const kc = sampleGrid(t.kappa, p.s + 0.5 * ld, t.ds);
    const nMid = sampleGrid(plan.n, p.s + 0.5 * ld, t.ds);
    const sLook = p.s + ld / Math.max(0.4, 1 - kc * nMid);
    const look = this.track.getSampleAtDistance(wrap(sLook, this.track.totalLengthM));
    const [lo, hi] = this.lateralRangeAt(sLook, look);
    const nT = THREE.MathUtils.clamp(sampleGrid(plan.n, sLook, t.ds) + this.aiLineBiasM, lo, hi);
    const dx = look.position.x + look.binormal.x * nT - v.position.x;
    const dz = look.position.z + look.binormal.z * nT - v.position.z;
    const dl = Math.hypot(dx, dz);
    const alpha = Math.atan2(dx * _ex.x + dz * _ex.z, dx * _ez.x + dz * _ez.z);
    let kappa = (2 * Math.sin(alpha)) / Math.max(3, dl);
    // A slow integral on the lateral error here and now: a long corner taken a little wide is pulled back
    {
      const b = p.sample.binormal;
      const leftOf = (b.x * _ex.x + b.z * _ex.z) / (Math.hypot(b.x, b.z) || 1);
      const errLeft = (nNow - p.lateralOffset) * leftOf;
      this.trackI = THREE.MathUtils.clamp(this.trackI + TRACK_KI * errLeft * AID_SLICE_S, -TRACK_I_MAX_MS2, TRACK_I_MAX_MS2);
      kappa += this.trackI / Math.max(100, speed * speed);
    }
    return kappa;
  }

  /**
   * The speed to drive now on a supplied plan, and the pedal its slope asks for: the plan a little ahead (the pedal's
   * lag) at this car's pace, with the AI tuning target's errors and learning carried over as its ratio to the limit
   * profile it was built from
   */
  private planSpeedTarget(plan: AiDrivePlan, s: number, speed: number, prof: Float32Array): { v: number; pedalFF: number } {
    const t = plan.track;
    const L = this.track.totalLengthM;
    const lead = Math.max(3, speed * 0.15);
    const at = (d: number) => {
      let vv = sampleGrid(plan.v, s + d, t.ds) * this.aiPaceScale;
      const tab = this.aiTargetSpeedMs;
      if (tab) {
        const k = Math.floor((wrap(s + d, L) / L) * tab.length) % tab.length;
        const base = prof[Math.floor((wrap(s + d, L) / L) * prof.length) % prof.length];
        if (base > 1) vv *= THREE.MathUtils.clamp(tab[k] / base, 0.8, 1.05);
      }
      return vv;
    };
    // The limit a little ahead (the pedal's lag). Where it rises or holds (a straight, a corner exit) the car simply
    // accelerates as hard as it can; where it falls, its slope is the braking the pedal is set for
    const v0 = at(lead);
    const v1 = at(lead + 6);
    const aFF = (v1 * v1 - v0 * v0) / 12;
    if (aFF >= -0.5 && speed < v0) {
      // Still cornering hard (a corner exit): the full plan's acceleration, which shares the tyres between the corner
      // and the throttle; flooring it there ran the car wide on the power. Near straight: as hard as it can
      const ayShare = (Math.abs(sampleGrid(plan.kappa, s + lead, t.ds)) * speed * speed) / plan.limits.lateral(speed);
      if (ayShare > 0.3) {
        const vExp = sampleGrid(plan.vExpected, s + lead, t.ds) * this.aiPaceScale;
        const vExp1 = sampleGrid(plan.vExpected, s + lead + 6, t.ds) * this.aiPaceScale;
        const aExp = (vExp1 * vExp1 - vExp * vExp) / 12;
        return { v: Math.min(v0, vExp), pedalFF: THREE.MathUtils.clamp(aExp / Math.max(1, plan.limits.traction(speed)), 0, 1) };
      }
      return { v: Infinity, pedalFF: 1 };
    }
    const pedalFF = aFF >= 0 ? 0 : aFF / Math.max(1, plan.limits.braking(speed) / plan.limits.gripScale);
    return { v: v0, pedalFF: THREE.MathUtils.clamp(pedalFF, -1, 1) };
  }

  /**
   * The integration blew up (a non-finite or impossible state: see `VehiclePhysics.stateIsSane`) or the car fell
   * through the world, e.g. launched over a barrier where there is no ground: put it back on the track, stopped, at
   * the last good position. True if it did.
   */
  private recoverIfLost(): boolean {
    const v = this.vehicle;
    const s = Number.isFinite(this.s) ? this.s : 0;
    if (v.stateIsSane() && v.position.y > this.track.getSampleAtDistance(s).position.y - LOST_BELOW_TRACK_M) return false;
    this.teleportToDistance(s, 0, 0);
    return true;
  }

  /** Beached or pinned against a barrier: rejoin on the racing line a little further on */
  private recoverIfStuck(dt: number): void {
    this.stuckS = this.vehicle.speedMs < 2 ? this.stuckS + dt : 0;
    if (this.stuckS < AUTOPILOT_STUCK_S) return;
    this.stuckS = 0;
    const sample = this.track.getSampleAtDistance(this.s + 20);
    this.teleportToDistance(sample.s, Math.min(25, sample.optimalSpeedKmh / 3.6), aiLineOffsetM(sample, this.line));
  }

  // ===========================================================================
  // State
  // ===========================================================================

  private onVehicleEvent(e: VehicleEvent): void {
    const c = this.channels;
    switch (e.type) {
      case 'CHANGED_DRS_OPEN':
        c.CHANGED_DRS_OPEN = e.open;
        c.drsOpenEvents++;
        break;
      case 'DRS_DETECTION':
        c.drsDetection = { zone: e.zone, eligible: e.eligible, atMs: this.simTimeMs };
        break;
      case 'WALL_IMPACT':
        c.wallImpact = { speedMs: e.speedMs, atMs: this.simTimeMs, localX: e.localX, localZ: e.localZ };
        break;
      case 'CHANGED_PERFORMANCE_MODE':
        c.performanceMode = e.mode;
        break;
    }
  }

  private yaw(): number {
    _ez.set(0, 0, 1).applyQuaternion(this.vehicle.quaternion);
    return Math.atan2(_ez.x, _ez.z);
  }

  private bodyVy(): number {
    return this.vehicle.velocity.dot(_ex.set(1, 0, 0).applyQuaternion(this.vehicle.quaternion));
  }

  /** + = turning right (rotation about +Y turns the nose toward +X = left) */
  private bodyYawRate(): number {
    return -this.vehicle.angularVelocity.dot(_ey.set(0, 1, 0).applyQuaternion(this.vehicle.quaternion));
  }

  /**
   * The front tyres' peak slip angle as they are loaded now (rad): it grows with load, so the loaded outside front peaks
   * later than the data's angle at Fz0. Load-weighted over the axle; the data's angle while both fronts are unloaded.
   */
  private frontPeakSlipRad(): number {
    const [l, r] = this.vehicle.wheels;
    const fz = l.fz + r.fz;
    return fz > 0 && l.peakSlipAngleRad > 0 && r.peakSlipAngleRad > 0
      ? (l.fz * l.peakSlipAngleRad + r.fz * r.peakSlipAngleRad) / fz
      : (this.compoundData.modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD;
  }

  /** At track distance `s`, `lateral` m right of the centreline, heading along the track */
  private placeAt(s: number, lateral: number, speedMs: number): void {
    const sample = this.track.getSampleAtDistance(s);
    const b = sample.binormal;
    const bl = Math.hypot(b.x, b.z) || 1;
    const x = sample.position.x + (b.x / bl) * lateral;
    const z = sample.position.z + (b.z / bl) * lateral;
    this.progressHintS = this.poseHintS = s;
    this.resetVehicle(x, z, Math.atan2(sample.tangent.x, sample.tangent.z), speedMs);
  }

  /**
   * Every placement goes through here: VehiclePhysics.reset() puts the tyres back in their blankets at the
   * compound's optimal pressure, so the driver's cold pressures are set again right after it
   */
  private resetVehicle(x: number, z: number, yawRad: number, speedMs = 0, keepTyres = false): void {
    this.vehicle.reset(x, z, yawRad, speedMs, keepTyres);
    if (!keepTyres) this.applyColdPressures();
  }

  private afterPlacement(): void {
    this.steeringAssist.reset();
    this.tcCut = this.absCut = 1;
    this.absWheelCut.fill(1);
    for (let i = 0; i < 4; i++) this.prevWheelOmega[i] = this.vehicle.wheels[i].omega;
    this.apPedal = this.apYawI = this.apThrottle = 0;
    this.apLaunch = false;
    this.drsPressPending = false;
    this.boostRemainingS = 0;
    this.pushActive = false;
    this.overtake.reset();
    this.lastAxMs2 = this.lastAyMs2 = 0;
    this.stuckS = 0;
    // The off-track verdict belongs to where the car was: the new spot is judged afresh
    this.wasOffTrack = false;
    const c = this.channels;
    c.CHANGED_DRS_OPEN = false;
    c.drsOpenEvents = 0;
    c.drsDetection = null;
    c.wallImpact = null;
    this.syncPose();
    this.prevS = this.s;
    this.lastSector = this.track.getSampleAtDistance(this.s).sector;
    this.updateTelemetry(null);
  }

  private applyColdPressures(): void {
    for (const w of this.vehicle.wheels) {
      w.coldPressurePsi = pressureAt(this.coldPsi, w.isFront, w.isLeft);
      w.pressurePsi = w.coldPressurePsi;
    }
  }

  /** Sync adapter brake temps from VehiclePhysics 2-node physical brake disc state */
  private updateBrakes(_h: number): void {
    const v = this.vehicle;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const vf = this.wheels[VF_ORDER.indexOf(i as 0 | 1 | 2 | 3)];
      vf.brakeTempC = w.brakeDisc.surfaceTempC;
    }
  }

  /** Render pose, track coordinates and the VF-order wheels from the rigid body */
  private syncPose(): void {
    const v = this.vehicle;
    const q = v.quaternion;
    _ey.set(0, 1, 0).applyQuaternion(q);
    this.worldPosition.copy(v.position).addScaledVector(_ey, -this.config.chassis.cgHeight);
    this.worldQuaternion.copy(q);
    this.worldVelocity.copy(v.velocity);
    _qInv.copy(q).invert();
    const p = this.track.projectWorldToTrack(this.worldPosition.x, this.worldPosition.z, this.poseHintS);
    this.poseHintS = p.s;
    this.s = p.s;
    this.lateral = p.lateralOffset;
    this.vyMs = this.bodyVy();
    this.yawRateRadS = this.bodyYawRate();
    this.steerAngleNorm = this.steerCmd;
    // Relaxation lengths of the fitted compound (front, then the rear's own where it has them): the carcass states
    // below are its slip states times these (the dry lengths; a wet road shortens or stretches them by up to ~20 %)
    const cd = this.compoundData;
    const rearModel = cd.rearOverride?.modelData;
    const relaxFx = cd.modelData.relaxationLengthX;
    const relaxFy = cd.modelData.relaxationLengthY;
    const relaxRx = rearModel?.relaxationLengthX ?? relaxFx;
    const relaxRy = rearModel?.relaxationLengthY ?? relaxFy;
    for (let k = 0; k < 4; k++) {
      const w = v.wheels[VF_ORDER[k]];
      const out = this.wheels[k];
      out.worldPos.x = w.hardpointWorld.x;
      out.worldPos.y = w.ground.height;
      out.worldPos.z = w.hardpointWorld.z;
      out.zRoad = w.ground.height;
      out.fzN = w.fz;
      out.combinedSlipNorm = w.combinedSlip;
      out.surfaceType = surfaceType(w.ground.surface);
      out.spinVel = w.omega;
      // Visual tyre state: the wheel's own deflection / loaded radius / lateral force / camber (no physics write)
      const vis = this.tyreVisuals[k];
      if (w.loadedRadius > 0) vis.loadedRadiusM = w.loadedRadius;
      vis.verticalDeflectionM = w.deflection;
      vis.lateralForceN = w.fy;
      vis.camberRad = w.camberLeftRad;
      // Carcass deflection: the relaxed slip ratio / tan(slip angle) times the relaxation length (the same states as
      // ac-tyre's deflX / deflY), held at the grip peak's once the tyre slides
      const elastic = 1 / Math.max(1, w.combinedSlip);
      vis.carcassDeflectionXM = w.slipRatio * (w.isFront ? relaxFx : relaxRx) * elastic;
      vis.carcassDeflectionYM = w.tanSlipAngle * (w.isFront ? relaxFy : relaxRy) * elastic;
      vis.onRoad = w.deflection > 0;
      // The bottom of the tyre in the car frame, under the corner's hardpoint at the current pose: the car frame rides
      // on the sprung body, so this is where the rigs put the unsprung wheel
      _v.set(w.hardpoint.x, 0, w.hardpoint.z).applyQuaternion(q).add(this.worldPosition);
      const c = vis.contactInCar!;
      c.x = w.hardpoint.x;
      c.y = (v.tyreBottomY(w) - _v.y) / Math.max(0.5, _ey.y);
      c.z = w.hardpoint.z;
    }
  }

  /** Sector / lap timing at the sector boundaries and the start / finish line (as the VF26) */
  private updateTiming(): void {
    const L = this.track.totalLengthM;
    const sample = this.track.getSampleAtDistance(this.s);
    if (sample.sector !== this.lastSector) {
      this.onSectorCompleted(this.lastSector);
      this.lastSector = sample.sector;
    }
    if (this.prevS > L * 0.85 && this.s < L * 0.15) {
      if (this.lineCrossingStartsLap) {
        this.lineCrossingStartsLap = false;
        this.lapStartMs = this.simTimeMs;
        this.sectorStartMs = this.simTimeMs;
      } else {
        this.onLapCompleted();
      }
    }
    this.prevS = this.s;
  }

  private onSectorCompleted(sector: 1 | 2 | 3): void {
    const t = this.telemetry;
    const duration = this.simTimeMs - this.sectorStartMs;
    this.sectorStartMs = this.simTimeMs;
    if (duration > 8000) {
      t.sectorTimesMs[sector - 1] = duration;
      const best = t.bestSectorTimesMs[sector - 1];
      if (best === null || duration < best) t.bestSectorTimesMs[sector - 1] = duration;
    }
  }

  private onLapCompleted(): void {
    const t = this.telemetry;
    const lapTime = this.simTimeMs - this.lapStartMs;
    this.onSectorCompleted(3);
    this.lapStartMs = this.simTimeMs;
    // Judged track limits: a lap that ends while an excursion is still being judged cannot count
    const valid = this.lapValid && !(this.trackLimitsMode === 'judged' && (this.trackLimitsHold || t.offTrack));
    if (lapTime > 45_000) {
      t.lastLapTimeMs = lapTime;
      if (valid && (t.bestLapTimeMs === null || lapTime < t.bestLapTimeMs)) t.bestLapTimeMs = lapTime;
    }
    t.lastLapValid = valid;
    t.lapCount++;
    t.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.lapValid = true;
    t.lapInvalid = false;
  }

  /** Race control deleted the running lap (judged track limits) */
  public invalidateLap(): void {
    this.lapValid = false;
    this.telemetry.lapInvalid = true;
  }

  /** `CarTelemetry` (wheel arrays FL, FR, RL, RR = f12026 LF, RF, LR, RR) and live engineering channels */
  private updateTelemetry(inputs: ControlInputs | null): void {
    const v = this.vehicle;
    const vt = v.telemetry;
    const t = this.telemetry;
    const W = v.wheels;
    const sample = this.track.getSampleAtDistance(this.s);
    const vx = this.vxMs;
    const speedKmh = Math.max(0, vx * 3.6);
    if (speedKmh > t.topSpeedThisLapKmh) t.topSpeedThisLapKmh = speedKmh;
    if (speedKmh > t.allTimeTopSpeedKmh) t.allTimeTopSpeedKmh = speedKmh;
    const quad = <T>(f: (w: (typeof W)[number], i: number) => T): [T, T, T, T] => [f(W[0], 0), f(W[1], 1), f(W[2], 2), f(W[3], 3)];

    const surfaces = quad((w) => surfaceType(w.ground.surface));
    const onKerbLeft = surfaces[0] === 'kerb' || surfaces[2] === 'kerb';
    const onKerbRight = surfaces[1] === 'kerb' || surfaces[3] === 'kerb';
    // All four wheels on surfaces the table does not count as the track (run-off, gravel, grass, sausage kerbs)
    // Judged on the wheels touching the road: an airborne wheel's ground is its last contact (the probe only reaches
    // 0.6 m), so a jump keeps the verdict it took off with rather than reading stale surfaces
    let anyGrounded = false;
    let allOff = true;
    for (const w of W) {
      if (!w.grounded) continue;
      anyGrounded = true;
      if (w.ground.props.validTrack) allOff = false;
    }
    const offTrack = anyGrounded ? allOff : this.wasOffTrack;
    this.wasOffTrack = offTrack;
    if (offTrack && this.trackLimitsMode === 'strict') this.lapValid = false;
    t.lapInvalid = !this.lapValid;
    let surface: SurfaceType = 'asphalt';
    if (onKerbLeft || onKerbRight) surface = 'kerb';
    else if (surfaces[0] === 'grass' || surfaces[1] === 'grass') surface = 'grass';
    else if (surfaces[0] === 'runoff' || surfaces[1] === 'runoff') surface = 'runoff';

    const mgukKw = vt.MGUK_POWER / 1000;
    let wheelKw = 0;
    for (const w of W) wheelKw += (w.driveTorqueNm * w.omega) / 1000;
    const iceKw = Math.max(0, wheelKw - Math.max(0, mgukKw));
    const frontDf = (vt.downforceN * vt.AERO_BALANCE) / 100;

    t.speedMs = vx;
    t.speedKmh = speedKmh;
    t.rpm = Math.round(vt.rpm);
    t.gear = vt.gear;
    t.throttle = vt.throttle;
    t.brake = vt.brake;
    t.clutch = vt.clutchEngagement;
    t.steering = this.steerCmd;
    t.longitudinalG = this.lastAxMs2 / G;
    t.lateralG = -this.lastAyMs2 / G;
    t.verticalG = 1 + vt.downforceN / (v.totalMassKg * G);
    t.altitudeM = BASE_ALTITUDE_M + this.worldPosition.y;
    t.trackElevationM = sample.position.y;
    t.airDensityKgM3 = v.airDensity;
    t.activeAeroMode = this.activeAeroMode;
    t.autoXMode = false;
    t.downforceN = vt.downforceN;
    t.downforceKgf = vt.downforceN / G;
    t.frontDownforceN = frontDf;
    t.rearDownforceN = vt.downforceN - frontDf;
    t.groundEffectFactor = 1;
    t.aeroCopFrontPct = vt.AERO_BALANCE;
    t.floorStallFactor = 1;
    t.dragN = vt.dragN;
    t.icePowerKw = iceKw;
    t.mgukPowerKw = mgukKw;
    t.totalPowerKw = Math.max(0, iceKw + Math.max(0, mgukKw));
    t.ersBatteryPercent = vt.ERS_CHARGE * 100;
    // Push actually running (the override or the boost), not PSH picked in the tuner
    t.manualOverrideActive = this.pushActive;
    t.boostRemainingS = this.boostRemainingS;
    t.overtakingRules = this.profile.hasDrs ? this.rules : undefined;
    t.overtakeAvailable = this.profile.hasErs && this.overtakeAvailable;
    t.turboBoostBar = this.profile.turbo ? Number(v.turboBoostBar.toFixed(2)) : 1;
    t.fuelKg = Number(this.fuelKg.toFixed(2));

    t.tireSlipRatio = quad((w) => w.combinedSlip);
    t.wheelSlipRatios = quad((w) => w.slipRatio);
    t.wheelSlipAnglesDeg = quad((w) => w.slipAngleRad * RAD2DEG);
    t.wheelLoadsN = quad((w) => Math.round(w.fz));
    t.wheelRideHeightsMm = quad((w) => Math.round((w.isFront ? vt.aeroHeightFront : vt.aeroHeightRear) * 1000));
    t.suspensionTravelMm = quad((w) => Number((w.compression * 1000).toFixed(2)));
    t.suspensionVelocityMs = quad((w) => w.compressionVel);
    t.tireTempsC = quad((w) => Math.round(0.6 * w.surfaceTempC + 0.4 * w.coreTempC));
    t.tireWearPct = quad((w) => Math.round(w.wear * 100));
    t.tireBandTempsC = quad((w) => [
      Math.round(w.bandTempsC[0]),
      Math.round(w.bandTempsC[1]),
      Math.round(w.bandTempsC[2]),
    ]);
    t.tireFlatSpotSeverity = quad((w) => Number(w.flatSpotSeverity.toFixed(3)));
    t.tireGrainLevel = quad((w) => Number(w.grainLevel.toFixed(3)));
    t.tireBlisterLevel = quad((w) => Number(w.blisterLevel.toFixed(3)));
    t.tireDirtyLevel = quad((w) => Number(w.dirtyLevel.toFixed(3)));
    t.tirePressuresPsi = quad((w) => Number(w.pressurePsi.toFixed(1)));
    const frontOpt = v.tyreOptimum(0);
    const rearOpt = v.tyreOptimum(1);
    t.tireOptimalPsi = [frontOpt.psi, frontOpt.psi, rearOpt.psi, rearOpt.psi];
    t.tireOptimalTempC = frontOpt.tempC;
    t.tireGripFactor = quad((w) => Number((w.thermalGrip * w.ground.grip * v.trackEvolution.gripMultiplier).toFixed(2)));
    t.brakeTempsC = quad((w) => Math.round(w.brakeDisc.surfaceTempC));
    t.brakeCoreTempsC = quad((w) => Math.round(w.brakeDisc.coreTempC));
    t.brakePadMuFactor = quad((w) => Number(w.brakeDisc.muFactor.toFixed(3)));
    t.aeroWakeDownforceMult = Number(v.aeroWake.totalDownforceMultiplier.toFixed(3));
    t.aeroWakeDragMult = Number(v.aeroWake.dragMultiplier.toFixed(3));
    t.wheelSurfaces = surfaces;
    t.frontSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[0] + t.wheelSlipAnglesDeg[1]);
    t.rearSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[2] + t.wheelSlipAnglesDeg[3]);
    // VehiclePhysics' moment has the steering's sign; the telemetry convention is the torque on the rim (+ = right)
    t.ffbTorqueNorm = -this.vehicle.takeFfbAverage();
    t.ffbSubframeSamples = this.vehicle.takeFfbSubframeSamples();
    t.ffbClipping = Math.abs(t.ffbTorqueNorm) > 0.95;
    t.onKerbLeft = onKerbLeft;
    t.onKerbRight = onKerbRight;
    t.offTrack = offTrack;
    t.surface = surface;

    // Heading error: + = nose pointed right of the track tangent
    _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
    const tan = sample.tangent;
    const bin = sample.binormal;
    t.trackDistanceM = this.s;
    t.trackProgress = this.s / this.track.totalLengthM;
    t.lateralOffsetM = this.lateral;
    t.gapToRacingLineM = this.lateral - aiLineOffsetM(sample, this.line);
    t.headingErrorRad = Math.atan2(_ez.x * bin.x + _ez.z * bin.z, _ez.x * tan.x + _ez.z * tan.z);
    const guide = this.brakingGuide;
    t.targetCornerSpeedKmh = Math.round(guide ? sampleProfile(guide.speedMs, this.s, this.track.totalLengthM) * 3.6 : sample.optimalSpeedKmh);
    t.brakingUrgency = evaluateDynamicBrakingUrgency(this.track, this.s, vx, (this.s + 25) % this.track.totalLengthM, guide);
    t.currentSector = sample.sector;
    t.currentTurnNumber = sample.turnNumber;
    t.currentTurnName = sample.turnName;
    t.bankingDeg = sample.bankingRad * RAD2DEG;
    t.slopePercent = sample.slopeSin * 100;
    t.currentLapTimeMs = Math.max(0, this.simTimeMs - this.lapStartMs);
    t.aiAutopilot = this.aiAutopilot;
    if (inputs && !this.aiAutopilot) {
      t.throttle = inputs.throttle;
      t.brake = inputs.brake;
    }

    const c = this.channels;
    c.WHEEL_SR_LF = vt.WHEEL_SR_LF;
    c.WHEEL_SR_RF = vt.WHEEL_SR_RF;
    c.WHEEL_SR_LR = vt.WHEEL_SR_LR;
    c.WHEEL_SR_RR = vt.WHEEL_SR_RR;
    c.BUMPSTOPUP_TRAVEL_LF = vt.BUMPSTOPUP_TRAVEL_LF;
    c.BUMPSTOPUP_TRAVEL_RF = vt.BUMPSTOPUP_TRAVEL_RF;
    c.BUMPSTOPUP_TRAVEL_LR = vt.BUMPSTOPUP_TRAVEL_LR;
    c.BUMPSTOPUP_TRAVEL_RR = vt.BUMPSTOPUP_TRAVEL_RR;
    c.AERO_HEIGHT = vt.AERO_HEIGHT;
    c.AERO_BALANCE = vt.AERO_BALANCE;
    c.LSD_LOCKING_TORQUE = vt.LSD_LOCKING_TORQUE;
    c.drsZone = vt.drsZone;
    c.drsAvailable = vt.drsAvailable;
    for (let i = 0; i < 4; i++) c.circleFraction[i] = vt.circleFraction[i];
    c.performanceMode = v.performanceMode;
    c.tcActive = this.tcCut < 0.98;
    c.absActive = this.absCut < 0.98;
    c.wallContact = vt.wallContact;
    t.liveTuner = this.getLiveTunerState();
  }

  private createTelemetry(): CarTelemetry {
    const four = <T>(x: T): [T, T, T, T] => [x, x, x, x];
    return {
      speedKmh: 0,
      speedMs: 0,
      rpm: this.config.engine.idleRpm,
      gear: 1,
      throttle: 0,
      brake: 0,
      clutch: 1,
      steering: 0,
      longitudinalG: 0,
      lateralG: 0,
      verticalG: 1,
      altitudeM: BASE_ALTITUDE_M,
      trackElevationM: 0,
      airDensityKgM3: AIR_DENSITY,
      activeAeroMode: 'Z_MODE',
      autoXMode: false,
      downforceN: 0,
      downforceKgf: 0,
      frontDownforceN: 0,
      rearDownforceN: 0,
      groundEffectFactor: 1,
      aeroCopFrontPct: 50,
      floorStallFactor: 1,
      dragN: 0,
      icePowerKw: 0,
      mgukPowerKw: 0,
      totalPowerKw: 0,
      ersBatteryPercent: 100,
      manualOverrideActive: false,
      boostRemainingS: 0,
      turboBoostBar: 1,
      fuelKg: 0,
      tireSlipRatio: four(0),
      wheelSlipRatios: four(0),
      wheelSlipAnglesDeg: four(0),
      wheelLoadsN: four(0),
      wheelRideHeightsMm: four(0),
      suspensionTravelMm: four(0),
      suspensionVelocityMs: four(0),
      tireTempsC: four(70),
      tireWearPct: four(0),
      tireBandTempsC: [
        [70, 70, 70],
        [70, 70, 70],
        [70, 70, 70],
        [70, 70, 70],
      ],
      tireFlatSpotSeverity: four(0),
      tireGrainLevel: four(0),
      tireBlisterLevel: four(0),
      tireDirtyLevel: four(0),
      tirePressuresPsi: four(0),
      tireGripFactor: four(1),
      brakeTempsC: four(380),
      brakeCoreTempsC: four(380),
      brakePadMuFactor: four(1),
      aeroWakeDownforceMult: 1,
      aeroWakeDragMult: 1,
      wheelSurfaces: four<SurfaceType>('asphalt'),
      frontSlipAngleDeg: 0,
      rearSlipAngleDeg: 0,
      ffbTorqueNorm: 0,
      ffbSubframeSamples: [],
      ffbClipping: false,
      onKerbLeft: false,
      onKerbRight: false,
      offTrack: false,
      surface: 'asphalt',
      trackDistanceM: 0,
      trackProgress: 0,
      lateralOffsetM: 0,
      gapToRacingLineM: 0,
      headingErrorRad: 0,
      targetCornerSpeedKmh: 0,
      brakingUrgency: 0,
      currentSector: 1,
      currentTurnNumber: 0,
      currentTurnName: '',
      bankingDeg: 0,
      slopePercent: 0,
      lapCount: 1,
      currentLapTimeMs: 0,
      lastLapTimeMs: null,
      bestLapTimeMs: null,
      sectorTimesMs: [0, 0, 0],
      bestSectorTimesMs: [null, null, null],
      topSpeedThisLapKmh: 0,
      allTimeTopSpeedKmh: 0,
      aiAutopilot: false,
      peers: [],
    };
  }
}
