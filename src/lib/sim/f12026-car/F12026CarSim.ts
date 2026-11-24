/**
 * f12026-car in the simulator: wraps `VehiclePhysics` behind the `SimulatorCar` surface the simulator,
 * the AI field and the renderer use for the LC26 model, and maps its live telemetry channels to `CarTelemetry`.
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
  FUEL_KG_PER_L,
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
  createTrackSampleBuffer,
  evaluateSampleLateralHeightM,
  getActiveSurfaceTable,
  RWANDA_DRS_ZONES,
  type TrackProjectionResult,
} from '@/lib/track-data';
import { SteeringAssist, type SteeringAssistCarState } from '../steering-assist';
import { OPEN_WHEEL_KEYBOARD_STEER, type KeyboardSteerProfile } from '@/lib/input/keyboard-steer';
import { type OvertakeLines, type OvertakingRaceControl, type OvertakingRules, OvertakeGrant } from '../overtaking-rules';
import { f1EnergyCircuit, inStretch } from '../f1-energy-circuits';
import { inLapWindow, straightModeWindows } from '../straight-mode-zones';
import { AxleSlipScratch } from '../tyre-slip';
import type { AeroWakeState } from '../aero-wake';
import { type CarDamageEffects, withDamage } from '../car-damage';
import type { TrackEvolutionSample } from '../track-evolution';
import type { WeatherContactSample } from '../weather';
import { SLICK_TRAITS, wetGripFactor } from '../wet-tyres';
import { tyreGaugePressureAtTemperature } from '../tyre-pressure';
import { FULL_REALISM, type SimRealismFlags } from '../sim-realism';
import {
  FLYING_SLOT_SPACING_M,
  flyingExitSpeedMs,
  flyingStartPoint,
  rollingStartSlots,
  rollingStartSpeedMs,
  START_HANDS_OFF_S,
  type SimulatorCar,
  type SimulatorWheel,
  type StartFootprint,
  startPose,
  type TyreVisualState,
} from '../simulator-car';
import { aiLineOffsetM, type BrakingGuide, brakingGuideFor, circuitBrakingGuide, createLc26ProfileCarModel, sampleProfile, type SpeedProfileCarModel, withPlanningGrip } from '../speed-profile';
import { evaluateDynamicBrakingUrgency } from '../track-occupancy';
import {
  type CarPhysicsConfig,
  compoundData,
  type DamperSettingsUnits,
  DEFAULT_FRICTION_LIMIT_ANGLE_DEG,
  F12026_CAR_CONFIG,
  type PerformanceModeName,
  type TyresCompoundData,
} from './F12026CarConfig';
import { createGroundHit, type GroundHit, type GroundQuery, type TrackSurfaceKind } from './TrackColliderQuery';
import { trackColliders } from '../track-colliders';
import { defaultColdPressurePsi, type VehicleEvent, type VehicleInputs, VehiclePhysics } from './VehiclePhysics';
import { KERB_PROFILE_L, kerbProfileM, surfaceRippleM } from '../track-surfaces';
import { sampleGrid } from '../ai/ai-track';
import type { AiDrivePlan } from '../ai/drive-plan';
import { lockShareOf } from '../tyre-slide-fx';
import { filterChassisG } from '../chassis-g';
import { beyondLayoutEdge, CourseCutWatch, inLapStretch, isCourseHop } from '../course-limits';
import { coneLaneRangeAt } from '../cone-lanes';
import { keptOnGrid } from '../race-start';

const G = 9.81;
const DEG2RAD = Math.PI / 180;
/**
 * Of the two fronts' steering compliance (rad), the one the steering assist's grip limit looks after: the less bent
 * front, the lightly loaded inside one, slips the most and reaches its peak first
 */
const leastBent = (left: number, right: number) => (Math.abs(left) < Math.abs(right) ? left : right);
/** The step of a dial nearest a value */
const nearestStep = (steps: readonly number[], v: number): number =>
  steps.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), steps[0] ?? v);
const RAD2DEG = 180 / Math.PI;
/** Rwanda (≈1400 m ASL) air density: what the braking envelopes below are planned at */
const AIR_DENSITY = 1.06;
/** Standard-atmosphere air density at an altitude (as the LC26's): 1.07 at Rwanda, 1.21 at Silverstone */
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
   * as a cornering-aware GT3 TC does. Absent: only in the wet (`AidControlProfile.tcWetSlide`), the F1 calibration.
   */
  tcDryRearSlide?: { gain: number; from: number };
  /**
   * ABS rear channels: the lock target × max(`floor`, 1 − `gain`·(|slip angle| − `deadbandRad`)), so a trail-braked rear
   * that already slides is held off the brakes. Default (an F1 calibration): gain 1.4, dead band 0.03 rad, floor 0.72.
   * Gain 0 = the rears regulate slip ratio only.
   */
  absRearSlipAngleGuard?: { gain: number; deadbandRad: number; floor: number };
  /** The TC and ABS controllers' own gains, each defaulting to `DEFAULT_AID_CONTROL` (the F1 calibration) */
  control?: Partial<AidControlProfile>;
}

/** Gains of the TC and ABS controllers (`electronicAids`) */
export interface AidControlProfile {
  /** TC stage A (spark retard): up to `tcStageACut` of the torque over the first `tcStageASlip` of slip past the target */
  tcStageASlip: number;
  tcStageACut: number;
  /** TC stage B (cylinder cut) past stage A: (`tcStageBSlope` + `tcStageBSlopeTc2` × TC2 0..1) per tyre peak slip of excess */
  tcStageBSlope: number;
  tcStageBSlopeTc2: number;
  /** Torque the TC always leaves: `tcFloor` − `tcFloorPerTc2` × the TC2 dial (never under 5 %) */
  tcFloor: number;
  tcFloorPerTc2: number;
  /** Driven-axle slip the TC reads: `tcSlipMaxWeight` × the faster wheel's + `tcSlipMeanWeight` × the pair's mean */
  tcSlipMaxWeight: number;
  tcSlipMeanWeight: number;
  /** The torque comes back at this share of the TC's rate (cuts at the full rate) */
  tcReleaseShare: number;
  /** TC1 slide term on a wet road (see `CarElectronicsProfile.tcDryRearSlide`) */
  tcWetSlide: { gain: number; from: number };
  /** ABS pressure cut per unit of lock slip past the target, and the least pressure it leaves */
  absGain: number;
  absFloor: number;
  /** ABS cuts at `absApplyShare` and gives the pressure back at `absReleaseShare` of its rate */
  absApplyShare: number;
  absReleaseShare: number;
  /** Lock the ABS anticipates from the wheel's deceleration (s of it, as slip at the car's speed) */
  absAnticipationS: number;
}

export const DEFAULT_AID_CONTROL: Readonly<AidControlProfile> = {
  tcStageASlip: 0.03,
  tcStageACut: 0.25,
  tcStageBSlope: 1.6,
  tcStageBSlopeTc2: 3.2,
  tcFloor: 0.18,
  tcFloorPerTc2: 0.011,
  tcSlipMaxWeight: 0.65,
  tcSlipMeanWeight: 0.35,
  tcReleaseShare: 0.24,
  tcWetSlide: { gain: 0.22, from: 0.45 },
  absGain: 12.5,
  absFloor: 0.08,
  absApplyShare: 0.65,
  absReleaseShare: 0.16,
  absAnticipationS: 0.016,
};

const DEFAULT_TC_LATERAL_TIGHTENING = { gain: 0.14, exponent: 1.3, floor: 0.42 } as const;
/** Fastest a driver turns the steering wheel (deg/s at the rim) */
const DRIVER_RIM_SPEED_DEG_S = 900;
/** Rim angle per road-wheel angle where a profile gives none (`CarSimProfile.steerRatio`) */
const DEFAULT_STEER_RATIO = 12.6;
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

/** TC / ABS / TC2 dial positions */
export interface AidDials {
  tcLevel: number;
  tc2Level: number;
  absLevel: number;
  /** The slip-angle traction dial, on a car with it (`CarSimProfile.tcSlipAngleDial`); absent: the car's own slide term */
  tcSlipAngleLevel?: number;
}

/** The F1 cars' driver-assist presets on `F12026_ELECTRONICS` */
export const F1_ASSIST_DIALS: Readonly<Record<DriverAssistPreset, AidDials>> = {
  pro: { tcLevel: 0, tc2Level: 6, absLevel: 0 },
  semi_pro: { tcLevel: 5, tc2Level: 6, absLevel: 5 },
  assisted: { tcLevel: 8, tc2Level: 9, absLevel: 9 },
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
   * Without one the car is shown the circuit's car's (`circuitBrakingGuide`).
   */
  speedProfile?: SpeedProfileCarModel;
  /** The racing line this car drives, plans on and draws (default: the F1 line) */
  racingLine?: RacingLineId;
  /**
   * The tallest kerb (its rise over the ground it stands on, m) the AI lets this car's outer tyres run onto (default
   * `AI_KERB_RISE_DEFAULT_M`). Where a circuit's kerbs are modelled at their real height, the line, the plans and the
   * tracker keep the tyres off anything taller (`lateralRangeAt`)
   */
  aiMaxKerbRiseM?: number;
  /**
   * The car's understeer gradient (front road-wheel angle beyond the kinematic one, rad per m/s² of lateral
   * acceleration) the autopilot steers in ahead of its yaw loop. Default 0: the loop's integrator finds it.
   */
  understeerRadPerMs2?: number;
  /** Fuel flow at full throttle (kg/s) where `fuelLPerS1000Rpm` is absent; default 0.0278, an F1 car's */
  fuelFlowKgS?: number;
  /**
   * Fuel flow that follows the engine: litres a second per 1000 rpm at full throttle, so the flow is
   * rpm / 1000 × this × throttle (× `FUEL_KG_PER_L`). Absent: the constant `fuelFlowKgS` × throttle
   */
  fuelLPerS1000Rpm?: number;
  /** The TC / ABS dial positions of each driver-assist preset */
  assistDials: Record<DriverAssistPreset, AidDials>;
  /** The plan of the body worn when it is not the vehicle model's own (`VehiclePhysicsOptions.bodyPlan`) */
  bodyPlan?: readonly (readonly [number, number])[];
  /**
   * Steering-wheel angle per road-wheel angle: the rim's lock is `maxRoadWheelDeg` × this, which the steering's
   * hand-speed limit turns through at 900°/s. Default 12.6
   */
  steerRatio?: number;
  /**
   * Temperature the garage's cold tyre pressures are stated at (°C), where that is not the tyres' own `coldRefC`: a
   * setup sheet that gives pressures at 20 °C for tyres that leave 80 °C blankets. `coldPsiRange` is at this
   * temperature too. Tyre setups are converted on the way in and out, so a saved setup means the same pressure
   */
  setupPressureRefC?: number;
  /** The car's own keyboard steering curve (`keyboard-steer.ts`); absent = the keyboard's base ramp at every speed */
  keyboardSteer?: KeyboardSteerProfile;
  /**
   * The class allows ABS. false (a prototype's regulations): the dial is held at 0 on every preset but Assisted, which
   * keeps its ABS so a keyboard or pad driver can still stop the car. Default true
   */
  absAllowed?: boolean;
  /**
   * The ABS dial picks one of twelve maps, each a front and rear slip target as a share of the tyre's peak slip and a
   * reapply rate (`ENDURANCE_ABS_MAPS`): qualifying, race, worn or bumpy, wet. Absent: one slip target per level
   */
  enduranceAbsMaps?: boolean;
  /**
   * A third traction dial for the driven axle's slide (`AidDials.tcSlipAngleLevel`): how far sideways the rears may go
   * before the cut, apart from the slip ratio (TC1) and the cut's depth (TC2). Absent: the slide term is the car's own
   */
  tcSlipAngleDial?: boolean;
  /** The car's own static toe (deg, + = toe-in), on which the garage's toe offsets sit. Default 0 */
  staticToeDeg?: { front: number; rear: number };
  /**
   * The hybrid motor sits on the gearbox's input shaft, behind the clutch (a P2 layout), so it turns with the gearbox
   * and not with the engine while the clutch slips: the telemetry's `mguRpm` is then that shaft's speed (the motor's own
   * gear on it taken as 1 : 1). Absent: the motor is on the crank and `mguRpm` is left unset (the engine's speed)
   */
  motorOnGearbox?: boolean;
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
  // The car's understeer, which the autopilot steers in ahead of its yaw loop: the front road-wheel angle past the
  // kinematic one (and past the loop's 0.8 × body slip) per m/s², on a flat-pad steer ramp at constant speed: 0.0005 at
  // 130 km/h, 0.0008 at 160-250. 0.001 holds SpeedVegas' tight line, which 0.0007 ran 3.4 m off. Without it the
  // autopilot worked it out from the fronts' cornering stiffness each step, 0.0012-0.0015 at 100-160 km/h, and went to
  // the fronts' whole peak slip angle whenever a front wheel left the ground over a kerb
  understeerRadPerMs2: 0.001,
  assistDials: F1_ASSIST_DIALS,
  keyboardSteer: OPEN_WHEEL_KEYBOARD_STEER,
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
/** Furthest past the track's width the kerb-and-road probe looks (m) */
const AP_KERB_PROBE_M = 3;
/** Road either side of the centreline the autopilot may use (m, every `AP_PROFILE_STEP_M`): - and + lateral sides */
interface AutopilotEdges {
  neg: Float32Array;
  pos: Float32Array;
  /**
   * How far a flat kerb runs on past the track's width, - and + sides (m, 0 where there is none): to its last point,
   * with no lip on the way, up to `AP_KERB_PROBE_M`. A line may run its outer tyres out to it, as a driver uses the
   * kerbs (`lateralRangeAt`)
   */
  negOut: Float32Array;
  posOut: Float32Array;
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
  const rawOut = { neg: new Float32Array(n), pos: new Float32Array(n) };
  const hit = createGroundHit();
  const COARSE_M = 0.5;
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance((i * L) / n);
    const half = smp.width / 2;
    const b = smp.binormal;
    for (const side of [-1, 1] as const) {
      const at = (lat: number) =>
        ground.query(smp.position.x + b.x * lat, smp.position.z + b.z * lat, smp.position.y + b.y * lat + 1.5, hit) ? hit.height : null;
      let usable = half;
      const limitLat = half + AP_EDGE_APRON_M + 1e-6;
      let prev = at(0);
      let prevLat = 0;
      // Coarse 0.5 m scan across the road, refining at 0.1 m only where a step or missing ground appears
      for (let lat = COARSE_M; prev !== null && lat <= limitLat + COARSE_M; lat += COARSE_M) {
        const probeLat = Math.min(lat, limitLat);
        const stepM = probeLat - prevLat;
        if (stepM <= 1e-6) break;
        const h = at(side * probeLat);
        const flagged = h === null || h - prev - b.y * side * stepM > AP_EDGE_STEP_M;
        if (flagged) {
          let finePrev = prev;
          let stopped = false;
          for (let fLat = prevLat + AP_EDGE_PROBE_M; fLat <= probeLat + 1e-6; fLat += AP_EDGE_PROBE_M) {
            const fh = at(side * fLat);
            if (fh === null ? fLat <= half : fh - finePrev - b.y * side * AP_EDGE_PROBE_M > AP_EDGE_STEP_M) {
              usable = Math.min(half, fLat - AP_EDGE_PROBE_M - (fh === null ? 0 : AP_EDGE_APRON_M));
              stopped = true;
              break;
            }
            if (fh === null) {
              stopped = true;
              break;
            }
            finePrev = fh;
          }
          if (stopped) break;
        }
        prev = h;
        prevLat = probeLat;
      }
      // how far inside the track's width the road ends
      (side < 0 ? raw.neg : raw.pos)[i] = Math.min(1, half - usable);
      // How far a flat kerb runs on past the width, with no lip on the way: out to the kerb's last point. Asphalt past
      // the width does not count of itself (on a street circuit it runs on to the barriers)
      let out = 0;
      let last = usable >= half ? at(side * half) : null;
      let lastD = 0;
      const kerbStep = 0.4;
      for (let d = kerbStep; last !== null && d <= AP_KERB_PROBE_M + kerbStep; d += kerbStep) {
        const probeD = Math.min(d, AP_KERB_PROBE_M);
        const stepM = probeD - lastD;
        if (stepM <= 1e-6) break;
        const h = at(side * (half + probeD));
        const probeSurface = hit.surface;
        const okSurface = h !== null && (probeSurface === 'kerb' || probeSurface === 'road');
        const okSlope = okSurface && h - last - b.y * side * stepM <= AP_EDGE_STEP_M;
        if (!okSlope) {
          let fineLast = last;
          let stopped = false;
          for (let fd = lastD + AP_EDGE_PROBE_M; fd <= probeD + 1e-6; fd += AP_EDGE_PROBE_M) {
            const fh = at(side * (half + fd));
            if (fh === null || (hit.surface !== 'kerb' && hit.surface !== 'road')) {
              stopped = true;
              break;
            }
            if (fh - fineLast - b.y * side * AP_EDGE_PROBE_M > AP_EDGE_STEP_M) {
              stopped = true;
              break;
            }
            if (hit.surface === 'kerb') out = fd;
            fineLast = fh;
          }
          if (stopped) break;
        }
        if (probeSurface === 'kerb') out = probeD;
        last = h;
        lastD = probeD;
      }
      (side < 0 ? rawOut.neg : rawOut.pos)[i] = out;
    }
  }
  const hold = Math.round(10 / (L / n));
  // A kerb past the width counts where it runs on for ±5 m (its ends, a gap between two: not a target)
  const holdOut = Math.max(1, Math.round(5 / (L / n)));
  const out = { neg: new Float32Array(n), pos: new Float32Array(n), negOut: new Float32Array(n), posOut: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    let neg = 0;
    let pos = 0;
    for (let k = -hold; k <= hold; k++) {
      const j = (i + k + n) % n;
      neg = Math.max(neg, raw.neg[j]);
      pos = Math.max(pos, raw.pos[j]);
    }
    let negOut = Infinity;
    let posOut = Infinity;
    for (let k = -holdOut; k <= holdOut; k++) {
      const j = (i + k + n) % n;
      negOut = Math.min(negOut, rawOut.neg[j]);
      posOut = Math.min(posOut, rawOut.pos[j]);
    }
    const half = track.getSampleAtDistance((i * L) / n).width / 2;
    out.neg[i] = half - neg;
    out.pos[i] = half - pos;
    // A lip anywhere near: none of the surface past it
    out.negOut[i] = neg > 0 ? 0 : negOut;
    out.posOut[i] = pos > 0 ? 0 : posOut;
  }
  perTrack.set(track, out);
  return out;
}

/** The tallest kerb an AI car's tyres run onto, unless its profile says otherwise (m) */
const AI_KERB_RISE_DEFAULT_M = 0.08;
/**
 * Room the outer tyres' outer edges keep from where a kerb gets too tall, measured from the wheel's centre (m): half a
 * tyre's width and 0.1 m to spare, as on a kerb past the track's width (`TRACK_KERB_EDGE_ROOM_M`)
 */
const AI_KERB_TYRE_ROOM_M = 0.3;
/** Spacing along the lap of the kerb-height probe (m): a kerb's height changes over a few metres */
const AI_KERB_STEP_M = 2;

/** Per side, how far from the centreline a kerb first rises past a limit (m, every `AI_KERB_STEP_M`; Infinity: none) */
interface KerbLimits {
  neg: Float32Array;
  pos: Float32Array;
}
const kerbLimitCache = new WeakMap<GroundQuery, WeakMap<BuiltTrackData, Map<number, KerbLimits | null>>>();

/**
 * Where the kerbs get taller than `maxRiseM` over the ground they stand on (`GroundQuery.queryBase`), probed out from
 * the centreline past the track's width every `AI_KERB_STEP_M`, each limit held for ±5 m (a car comes at a kerb at an
 * angle). Null where the ground can't say (no `queryBase`) or no kerb on the circuit can be that tall. It runs where the
 * circuit's surface table caps a kerb's rise (`maxRiseM`) above the car's limit: the converter's modelled kerbs (0.2 m).
 * Where kerbs are flattened to a few cm, or the circuit has no cap of its own (its kerbs as built, RISE's 5 cm edges),
 * nothing is probed and nothing changes
 */
function kerbLimits(track: BuiltTrackData, ground: GroundQuery, maxRiseM: number): KerbLimits | null {
  const cap = getActiveSurfaceTable().kerb.maxRiseM;
  if (!ground.queryBase || !Number.isFinite(cap) || cap <= maxRiseM) return null;
  let perTrack = kerbLimitCache.get(ground);
  if (!perTrack) kerbLimitCache.set(ground, (perTrack = new WeakMap()));
  let perRise = perTrack.get(track);
  if (!perRise) perTrack.set(track, (perRise = new Map()));
  if (perRise.has(maxRiseM)) return perRise.get(maxRiseM) ?? null;
  const L = track.totalLengthM;
  const n = Math.ceil(L / AI_KERB_STEP_M);
  const raw = { neg: new Float32Array(n).fill(Infinity), pos: new Float32Array(n).fill(Infinity) };
  const hit = createGroundHit();
  const base = createGroundHit();
  let any = false;
  const KERB_COARSE_M = 0.4;
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance((i * L) / n);
    const b = smp.binormal;
    const reach = smp.width / 2 + AP_KERB_PROBE_M;
    for (const side of [-1, 1] as const) {
      // Coarse 0.4 m sweep from near the track edge (or centre on narrow roads), refining at 0.1 m on kerb hits
      const startLat = Math.max(0, Math.floor((smp.width / 2 - 2.0) / KERB_COARSE_M) * KERB_COARSE_M);
      for (let lat = startLat; lat <= reach + 1e-6; lat += KERB_COARSE_M) {
        const x = smp.position.x + b.x * side * lat;
        const z = smp.position.z + b.z * side * lat;
        const y = smp.position.y + b.y * side * lat + 1.5;
        if (!ground.query(x, z, y, hit) || hit.surface !== 'kerb') continue;
        // Kerb found near `lat`: refine from the previous coarse step at 0.1 m to find the exact rise edge
        const fineStart = Math.max(0, lat - KERB_COARSE_M + AP_EDGE_PROBE_M);
        let found = false;
        for (let fLat = fineStart; fLat <= Math.min(reach, lat + KERB_COARSE_M) + 1e-6; fLat += AP_EDGE_PROBE_M) {
          const fx = smp.position.x + b.x * side * fLat;
          const fz = smp.position.z + b.z * side * fLat;
          const fy = smp.position.y + b.y * side * fLat + 1.5;
          if (!ground.query(fx, fz, fy, hit) || hit.surface !== 'kerb') continue;
          if (!ground.queryBase(fx, fz, fy, base) || hit.height - base.height <= maxRiseM) continue;
          (side < 0 ? raw.neg : raw.pos)[i] = fLat;
          any = true;
          found = true;
          break;
        }
        if (found) break;
      }
    }
  }
  let out: KerbLimits | null = null;
  if (any) {
    const hold = Math.max(1, Math.round(5 / (L / n)));
    out = { neg: new Float32Array(n), pos: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      let neg = Infinity;
      let pos = Infinity;
      for (let k = -hold; k <= hold; k++) {
        const j = (i + k + n) % n;
        neg = Math.min(neg, raw.neg[j]);
        pos = Math.min(pos, raw.pos[j]);
      }
      out.neg[i] = neg;
      out.pos[i] = pos;
    }
  }
  perRise.set(maxRiseM, out);
  return out;
}

/** The edges a traffic bias may push a tracked plan's target out to, - and + sides (m, every `ds` along the lap) */
interface BiasEdges {
  lo: Float32Array;
  hi: Float32Array;
  /**
   * The range itself with each narrowing ahead brought in no steeper than the edges (and no widening): how far out a
   * car already past the edges is let stay (`planTargetAt`)
   */
  loAhead: Float32Array;
  hiAhead: Float32Array;
  ds: number;
}
/** Per collider (or none yet), track and car profile */
const NO_COLLIDER = {};
const biasEdgeCache = new WeakMap<object, WeakMap<BuiltTrackData, WeakMap<CarSimProfile, BiasEdges>>>();

/**
 * The lateral range (`rangeAt`, a car's `lateralRangeAt`) as the edges a traffic bias may push a tracked plan's target
 * out to: nowhere steeper along the lap than `TRACK_BIAS_EDGE_SLOPE`, its corners rounded over ±`TRACK_BIAS_EDGE_ROUND_M`,
 * and nowhere wider than the range itself (a widening starts later, a narrowing earlier).
 *
 * The range steps: a kerb's allowance comes in over a metre (`TRACK_KERB_ALLOW_M`, and up to a metre more where a kerb
 * runs on past the width), a lip's narrowing is held to ±10 m. A bias that took the target past the range left it on
 * the edge, and the edge's step came through as a step in the target: on Istanbul's rolling start the GT3s' grid lanes
 * held them 3-4 m right of a line swinging right for Turn 1, on the edge, and the kerb starting at s 266 moved their
 * target 1.1 m out within 7 m. The pursuit's 14 m look-ahead at 220 km/h asked 2.5-4 g of steering for it (it asks
 * about 41 m/s² per metre of sudden error), the steering swung at the hands' speed to ±0.4 of its lock and back, and
 * the swing grew until the car spun.
 */
function biasEdgesOf(L: number, rangeAt: (s: number) => [number, number]): BiasEdges {
  const n = Math.max(16, Math.ceil(L / TRACK_BIAS_EDGE_STEP_M));
  const ds = L / n;
  const lo0 = new Float32Array(n);
  const hi0 = new Float32Array(n);
  for (let i = 0; i < n; i++) [lo0[i], hi0[i]] = rangeAt(i * ds);
  // Each narrowing ahead brought in at the slope, before the widenings are: twice round the lap backwards
  const rise = TRACK_BIAS_EDGE_SLOPE * ds;
  const loAhead = Float32Array.from(lo0);
  const hiAhead = Float32Array.from(hi0);
  for (let k = 2 * n - 1; k >= 0; k--) {
    const i = k % n;
    const j = (i + 1) % n;
    hiAhead[i] = Math.min(hiAhead[i], hiAhead[j] + rise);
    loAhead[i] = Math.max(loAhead[i], loAhead[j] - rise);
  }
  // No steeper than the slope: each edge pulled in to within slope × distance of every point where it is narrower (twice
  // round the lap each way, so the pull carries across the line)
  for (let k = 0; k < 2 * n; k++) {
    const i = k % n;
    const j = (i - 1 + n) % n;
    hi0[i] = Math.min(hi0[i], hi0[j] + rise);
    lo0[i] = Math.max(lo0[i], lo0[j] - rise);
  }
  for (let k = 2 * n - 1; k >= 0; k--) {
    const i = k % n;
    const j = (i + 1) % n;
    hi0[i] = Math.min(hi0[i], hi0[j] + rise);
    lo0[i] = Math.max(lo0[i], lo0[j] - rise);
  }
  // The corners rounded, still inside: the narrowest within ±w, then the mean of that over ±w (every point the mean
  // reads is no wider than here)
  const w = Math.max(1, Math.round(TRACK_BIAS_EDGE_ROUND_M / ds));
  const loN = new Float32Array(n);
  const hiN = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = -Infinity;
    let b = Infinity;
    for (let k = -w; k <= w; k++) {
      const j = (i + k + n) % n;
      a = Math.max(a, lo0[j]);
      b = Math.min(b, hi0[j]);
    }
    loN[i] = a;
    hiN[i] = b;
  }
  const lo = new Float32Array(n);
  const hi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let b = 0;
    for (let k = -w; k <= w; k++) {
      const j = (i + k + n) % n;
      a += loN[j];
      b += hiN[j];
    }
    lo[i] = a / (2 * w + 1);
    hi[i] = b / (2 * w + 1);
    // Narrower than nothing: both edges at its middle
    if (lo[i] > hi[i]) lo[i] = hi[i] = 0.5 * (lo[i] + hi[i]);
  }
  return { lo, hi, loAhead, hiAhead, ds };
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
 * friction circle, so no braking is planned that the tyres need for turning. The circuit's profile is the LC26's,
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
    offs[i] = clamp(aiLineOffsetM(smp, profile.racingLine), lo, hi);
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
  // A crest takes load off the tyres: v² κv of the car's weight, κv the road's vertical curvature (1/m, + over a
  // crest, read over ±20 m and averaged like the path's). Planned as level road, the esses of RISE Motordrome, which
  // turn over a crest, were taken up to 3 m wide of the asphalt at full pace. A dip is planned as level road.
  const crest = new Float64Array(n);
  const vSpan = Math.max(1, Math.round(20 / ds));
  const height = (i: number) => track.getSampleAtDistance((((i % n) + n) % n) * ds).position.y;
  for (let i = 0; i < n; i++) crest[i] = Math.max(0, -(height(i + vSpan) - 2 * height(i) + height(i - vSpan)) / (vSpan * ds) ** 2);
  const v = new Float32Array(n);
  // v²κ = share × decel(v) + g sin θ, with decel(v) = c (low (cos θ − v² κv / g) + aero (v / ref)²) up to ref and
  // c (low (cos θ − v² κv / g) + aero) above
  const c = AP_LATERAL_SHARE * 0.85 * 9.81;
  for (let i = 0; i < n; i++) {
    const kk = Math.max(1e-5, (k[(i - 1 + n) % n] + 2 * k[i] + k[(i + 1) % n]) / 4);
    const light = (c * b.lowG * (crest[(i - 1 + n) % n] + 2 * crest[i] + crest[(i + 1) % n])) / 4 / 9.81;
    const den = kk + light - (c * b.aeroG) / (b.refMs * b.refMs);
    const vLow = den > 0 ? Math.sqrt(Math.max(0, c * b.lowG * gN[i] + gT[i]) / den) : Infinity;
    v[i] = Math.min(110, vLow < b.refMs ? vLow : Math.sqrt(Math.max(0, c * (b.lowG * gN[i] + b.aeroG) + gT[i]) / (kk + light)));
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

/** The dial positions of a driver-assist preset (a class without ABS keeps it only on Assisted) */
function assistPresetDials(profile: CarSimProfile, preset: DriverAssistPreset): AidDials {
  const d = profile.assistDials[preset];
  return profile.absAllowed === false && preset !== 'assisted' ? { ...d, absLevel: 0 } : d;
}

/**
 * Twelve ABS maps [est]: front and rear slip targets as shares of the tyre's peak slip, and the pressure's reapply rate
 * against the base. 1–3 qualifying (new tyres, the shortest stop, a rear free to rotate the car), 4–6 race (a margin on
 * the rear as the tyres wear), 7–9 worn tyres, bumps or a cold track (slower reapply, no false releases off kerbs),
 * 10–12 wet (a wider window for the wet tread)
 */
const ENDURANCE_ABS_MAPS: readonly (readonly [number, number, number])[] = [
  [1.02, 0.92, 1.22],
  [1.0, 0.9, 1.22],
  [0.98, 0.88, 1.2],
  [0.96, 0.84, 1.1],
  [0.95, 0.83, 1.05],
  [0.94, 0.81, 1.0],
  [0.92, 0.8, 0.92],
  [0.9, 0.78, 0.88],
  [0.88, 0.76, 0.84],
  [1.1, 0.88, 0.95],
  [1.08, 0.86, 0.92],
  [1.05, 0.84, 0.9],
];

/**
 * The car's controllers (steering assist, traction control, ABS, the autopilot) run on a clock of their own: every
 * 2 ms physics step, 500 Hz, whatever the display's frame rate. They used to run on slices of the frame, so a 60 Hz
 * and a 144 Hz display drove different cars.
 */
const CONTROL_DT_S = VehiclePhysics.FIXED_DT;
/** Barrier contact counts toward race control's wall rules only while the car moves faster than this (m/s) */
const WALL_CONTACT_MIN_SPEED_MS = 2;
/** A stall longer than this is not caught up (s): the car does not fast-forward after a hidden tab */
const MAX_CATCH_UP_S = 0.25;
/**
 * The autopilot's integrators are stale once it has been off this long (s). An AI car's hand-back after a knock
 * (its driver's reaction, under half a second) keeps them; a takeover after a real stint off resets them.
 */
const AUTOPILOT_STALE_S = 1;
/**
 * The braking zones of a circuit as the 2026 energy management maps them, from the speed profile baked into its samples
 * (the same on the page and in the simulation worker, as the autopilot's is): where the profile asks for over half of a
 * car's braking (as the braking guide's red does: 1.6 g slow, rising with downforce to 5.1 g) and falls by at least
 * 36 km/h in all. Per sample, the distance on to the next such zone (m; 0 inside one, Infinity on a lap without)
 */
const brakeAheadCache = new WeakMap<ReadonlyArray<TrackSamplePoint>, Float32Array>();
const BRAKE_ZONE_LOOK_M = 13.5;
const BRAKE_ZONE_MIN_DROP_MS = 10;

function brakeAheadTable(samples: ReadonlyArray<TrackSamplePoint>, lapM: number): Float32Array {
  let ahead = brakeAheadCache.get(samples);
  if (ahead) return ahead;
  const n = samples.length;
  const ds = lapM / n;
  const v = Float64Array.from(samples, (p) => (p.brakeLimitKmh ?? p.optimalSpeedKmh) / 3.6);
  const k = Math.max(1, Math.round(BRAKE_ZONE_LOOK_M / ds));
  const hard = (i: number): boolean => {
    const a = v[i];
    const b = v[(i + k) % n];
    return (a * a - b * b) / (2 * k * ds) > 0.52 * 9.81 * (1.6 + 3.5 * Math.min(1, (a / 83) ** 2));
  };
  const zone = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!hard(i) || hard((i - 1 + n) % n)) continue;
    let j = i;
    let vMin = v[i];
    while (hard(j % n) && j - i < n) vMin = Math.min(vMin, v[(++j + k - 1) % n]);
    if (v[i] - vMin >= BRAKE_ZONE_MIN_DROP_MS) for (let m = i; m < j; m++) zone[m % n] = 1;
  }
  ahead = new Float32Array(n).fill(Number.POSITIVE_INFINITY);
  const first = zone.indexOf(1);
  // Back round the lap from a braking sample: each sample's distance on to the nearest braking sample ahead of it
  if (first >= 0) {
    let d = 0;
    for (let m = 0; m < n; m++) {
      const i = (first - m + n) % n;
      d = zone[i] ? 0 : d + ds;
      ahead[i] = d;
    }
  }
  brakeAheadCache.set(samples, ahead);
  return ahead;
}

/** Distance from lap distance `s` on to the next braking zone (`brakeAheadTable`) (m) */
function brakeAheadM(ahead: Float32Array, s: number, lapM: number): number {
  const n = ahead.length;
  if (n === 0 || !(lapM > 0)) return Number.POSITIVE_INFINITY;
  const x = ((((s % lapM) + lapM) % lapM) / lapM) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return Math.max(0, ahead[i] - (x - i) * (lapM / n));
}

/**
 * The game's Automatic Overtake: the share of Overtake's extra power over the normal curve it uses, so a driver's own
 * press of Overtake ends a long straight about a car's length ahead of it (no game found that makes its assist slower
 * on purpose; F1 25's automatic ERS is "nowhere near as efficient" as a driver's) [est]
 */
const AUTO_OVERTAKE_SHARE = 0.75;

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
/** On a kerb past the track's width, the outer tyres' outer edges stay this far inside where it ends (m): half a tyre's width and 0.1 m to spare */
const TRACK_KERB_EDGE_ROOM_M = 0.3;
/**
 * The edges a traffic bias may push a plan's target out to (`biasEdgesOf`): the lateral range drawn no steeper along
 * the lap than this (m per m), its corners rounded over ± this (m), sampled this often (m)
 */
const TRACK_BIAS_EDGE_SLOPE = 0.025;
const TRACK_BIAS_EDGE_ROUND_M = 10;
const TRACK_BIAS_EDGE_STEP_M = 0.5;
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

/** In one of the circuit's own zones (its data), not just on a straight the 2026 flaps open on */
function inOvertakingZone(progress: number): boolean {
  for (const z of RWANDA_DRS_ZONES) if (inLapWindow(progress, z.start, z.end)) return true;
  return false;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const _groundProj: TrackProjectionResult = { sample: createTrackSampleBuffer(), s: 0, lateralOffset: 0, distSq: 0 };
const _simProj: TrackProjectionResult = { sample: createTrackSampleBuffer(), s: 0, lateralOffset: 0, distSq: 0 };
const _simSample: TrackSamplePoint = createTrackSampleBuffer();
const _apSample: TrackSamplePoint = createTrackSampleBuffer();
const _planSpeedOut = { v: 0, pedalFF: 0 };

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
    const p = this.track.projectWorldToTrackInto
      ? this.track.projectWorldToTrackInto(x, z, _groundProj, this.hintS)
      : this.track.projectWorldToTrack(x, z, this.hintS);
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
  /** This car's braking guidance (the circuit's car's when it has no planning model of its own); adapts to wet grip */
  public brakingGuide: BrakingGuide;
  private brakingGuideGripBucket = 20;
  private lastGuideWaterMm = 0;
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
    return this.controlAccumulatorS + this.vehicle.unsteppedS;
  }
  /** Simulated time since the car was built (s): whole control ticks, whatever frames it was stepped in */
  public get simTimeS(): number {
    return this.steppedTicks * CONTROL_DT_S;
  }
  private steppedTicks = 0;
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
  /** The plan's top speed is no limit (`SimulatorCar.aiTopSpeedOpen`) */
  public aiTopSpeedOpen = false;
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
  /** Live MFD slip-angle TC dial (0 = off), on a car with it (`CarSimProfile.tcSlipAngleDial`) */
  public tcSlipAngleLevel = 5;
  /** User-selected ERS deployment mode in MFD (overridden to 'PSH' while manual override / boost is held) */
  private userErsMode: PerformanceModeName = 'RAC';
  /** Push mode is running (the override held or latched, the 8 s boost, or the AI's Overtake Mode), not just picked */
  private pushActive = false;
  /** 2026: the Overtake earned in a race is in use this lap (the driver's press), the assist using it, the Boost held */
  private overtakeInUse = false;
  private overtakeAutoNow = false;
  private ersBoostNow = false;
  /** The Overtake grant's lap the use belongs to (`OvertakeGrant.activations`) */
  private overtakeLap = 0;
  /** The player's Automatic Overtake (2026 F1) */
  public autoOvertake = true;
  /** Race control's Low Grip Conditions (`WeatherContactSample.lowGrip`): the 2026 rules' wet-weather limits */
  private lowGrip = false;
  /** Seconds the autopilot has been off: `step` decides from it whether a takeover starts it afresh */
  private autopilotIdleS = 0;
  public gamepadAssistEnabled = true;
  /** Automatic gear changes; off = the driver shifts. The autopilot always shifts for itself (VehiclePhysics.autoShift) */
  public autoGearbox = true;
  /** Automatic clutch and anti-stall (default true); false with manual gears enables bite point, slip and stalls */
  public autoClutch = true;
  /**
   * Held on the grid through the lights of a manual start: the gear left where it is, and while the driver holds the
   * clutch (or keeps off the throttle) the brakes on and the clutch open, the throttle revving a free engine. Let out in
   * gear with the throttle up, the car goes: moving before the lights go out is the jump start
   */
  public gridHold = false;
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
  /** The circuit's Overtake Detection and Activation Lines (2026 energy rules); null: the last DRS zone's detection */
  private overtakeLines: OvertakeLines | null = null;
  /** A time trial (the weekly challenge) is driven: the energy rules' qualifying allowances (`setEnergySession`) */
  private energyTimeTrial = false;

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
    /** Third springs (rate, packer gap) and dampers, and the corner packers, as the car's data has them */
    heave: { front: { rate: number; packerGap: number }; rear: { rate: number; packerGap: number } };
    heaveDamper: { front: DamperSettingsUnits; rear: DamperSettingsUnits };
    cornerPacker: { front: number; rear: number };
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
    drsQueued: false,
    drsDetection: null,
    straightModeAhead: null,
    overtakeDetection: null,
    circleFraction: [0, 0, 0, 0],
    performanceMode: 'RAC',
    carId: 'f12026-car',
    hasErs: true,
    hasDrs: true,
    tcActive: false,
    absActive: false,
    wallContact: false,
    wallContactS: 0,
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
  /** On a point-to-point course: a run is under way (started at the start line, not yet at the finish) */
  private runActive = false;
  /** On a point-to-point course: the car has stood still just behind the start line, so its next run starts from rest */
  private atRestOnLine = false;
  private simTimeMs = 0;
  /** Frame time not yet run as control ticks (s, under one tick) */
  private controlAccumulatorS = 0;
  /** A paddle pressed in a frame that ran no tick waits for the next one */
  private shiftUpPending = false;
  private shiftDownPending = false;
  private neutralPending = false;
  /** The steering rim's position at the last frame (`ControlInputs.steerRim`), its move is spread over this frame's ticks */
  private lastRimSteer: number | null = null;
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
  /** Standing race start from a forward-offset grid (ahead of the finish/control line `s = 0`): Lap 1 is shorter than a full lap and must not set a PB or sector 1 best */
  private shortStartLap = false;
  /** Jumps of the lap position round the course: one that stands cuts the lap (course-limits.ts) */
  private readonly cutWatch = new CourseCutWatch();
  private drsPressPending = false;
  private boostRemainingS = 0;
  private boostCooldownS = 0;
  /** Fuel on board (kg): the garage's starting load at each restart (`fillFuel`) */
  private fuelKg = 0;
  /** The profile's TC / ABS gains over the defaults */
  private readonly aidControl: AidControlProfile;
  /** Rim lock each way (deg): `maxRoadWheelDeg` × the profile's steering ratio */
  private readonly rimLockDeg: number;
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
  /** Seconds the body has touched a barrier while moving, since the car was last placed (channel `wallContactS`) */
  private wallContactS = 0;
  private lastAyMs2 = 0;
  /** Measured vertical acceleration of the chassis (g), low-passed tick by tick (`chassis-g.ts`) */
  private chassisG = 1;
  private stuckS = 0;

  constructor(
    track: BuiltTrackData,
    root?: THREE.Object3D | null,
    profile: CarSimProfile = F12026_SIM_PROFILE,
    opts?: { aiLite?: boolean }
  ) {
    this.track = track;
    this.profile = profile;
    this.line = profile.racingLine ?? 'f1';
    this.brakingGuide = profile.speedProfile
      ? brakingGuideFor(track.samples, profile.id, profile.speedProfile, this.line)
      : circuitBrakingGuide(track.samples, this.line);
    this.config = structuredClone(profile.config);
    this.aidControl = { ...DEFAULT_AID_CONTROL, ...(profile.electronics ?? F12026_ELECTRONICS).control };
    this.rimLockDeg = this.config.chassis.maxRoadWheelDeg * (profile.steerRatio ?? DEFAULT_STEER_RATIO);
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
      heave: {
        front: { rate: sp.front.heave.rate, packerGap: sp.front.heave.packerGap },
        rear: { rate: sp.rear.heave.rate, packerGap: sp.rear.heave.packerGap },
      },
      heaveDamper: { front: { ...sp.dampers_controller.front.heave }, rear: { ...sp.dampers_controller.rear.heave } },
      cornerPacker: { front: sp.front.bumpStop.packerGap ?? 0, rear: sp.rear.bumpStop.packerGap ?? 0 },
    };
    const L = track.totalLengthM;
    this.vehicle = new VehiclePhysics({
      ground: new TrackSampleGroundQuery(track),
      config: this.config,
      compound: this.config.compoundSlots[this.compound],
      airDensity: airDensityAt(track.baseAltitudeM ?? BASE_ALTITUDE_M),
      ambientC: AMBIENT_C,
      drsZones: profile.hasDrs ? RWANDA_DRS_ZONES : [],
      // 2026 Straight Mode opens on every straight; the zones in the circuit's data are only some of them
      straightZones: profile.hasDrs ? straightModeWindows(track) : [],
      locateProgress: (x, z) => {
        const p = track.projectWorldToTrack(x, z, this.progressHintS);
        this.progressHintS = p.s;
        return p.s / L;
      },
      lapLengthM: L,
      drsEligibleAtDetection: (zone) => (this.raceControl?.racing ? this.raceControl.earnedAtDetection(zone.id) : true),
      flapsBarred: () => !!this.raceControl?.racing && !!this.raceControl.aidsLocked,
      bodyPlan: profile.bodyPlan,
      onEvent: (e) => this.onVehicleEvent(e),
    });
    const v = this.vehicle;
    if (opts?.aiLite) v.aiLitePhysics = true;
    // The circuit as the 2026 energy management knows it: how far the next braking zone is, from the circuit's own
    // speed profile (one table for the car's life, the same in the simulation worker, so its choices never hang on
    // when a frame fell or which thread drives it)
    if (profile.hasErs && track.samples.length > 0) {
      const ahead = brakeAheadTable(track.samples, L);
      v.ersBrakeAheadAt = (s) => brakeAheadM(ahead, s, L);
      // The circuit's 2026 energy rules: the FIA's for an event it holds, else derived (`f1-energy-circuits.ts`)
      if (profile.config.ers.regulations === 'f1-2026') {
        v.ersCircuit = f1EnergyCircuit(track.id ?? '', track.samples, L, straightModeWindows(track), RWANDA_DRS_ZONES);
        const c = v.ersCircuit;
        this.overtakeLines = c.detectionM !== null ? { detection: c.detectionM / L, activation: c.activationM !== null ? c.activationM / L : null } : null;
      }
    }
    v.turbocharged = profile.turbo;
    this.wheelbaseM = v.wheelbaseM;
    this.cgToFrontAxleM = v.cgToFrontM;
    this.cgToRearAxleM = v.cgToRearM;
    const mkWheel = (): AdapterWheel => ({
      worldPos: { x: 0, y: 0, z: 0 },
      zRoad: 0,
      fzN: 0,
      combinedSlipNorm: 0,
      slideSpeedMs: 0,
      lockShare: 0,
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
    // On the colliders without the re-seat `attachTrackRoot` gives a car at rest: the grid placement below seats it,
    // and a settle where it stands now would be thrown away
    if (root) this.attachColliders(root);
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
    const peer = new F12026CarSim(this.track, this.trackRoot, this.profile, { aiLite: true });
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
    const wasOn = this.onColliders;
    if (!this.attachColliders(root)) return;
    // A car at rest is re-seated on the collider heights; a moving one rides over the (small) step
    if (!wasOn && this.vehicle.speedMs < 0.5) {
      const p = this.vehicle.position;
      this.resetVehicle(p.x, p.z, this.yaw());
      this.syncPose();
    }
  }

  /** Puts the car on the track root's colliders, where it stands (false: the root has no road collider) */
  private attachColliders(root: THREE.Object3D): boolean {
    this.trackRoot = root;
    const { ground, walls } = trackColliders(root);
    if (!ground) return false;
    this.vehicle.setGround(ground);
    this.vehicle.setWalls(walls);
    this.onColliders = true;
    this.collider = ground;
    return true;
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
  private get setupCar(): Exclude<VehicleModelId, 'lc26'> {
    const id = this.profile.id;
    return id === 'amg-gt3' ||
      id === 'liana' ||
      id === 'mtr-496r' ||
      id === 'lc-lmdh' ||
      id === 'nissan-r33-jgtc' ||
      id === 'nissan-r32-jtcc' ||
      id === 'bmw-m1-procar' ||
      id === 'vw-scirocco-gtx' ||
      id === 'chaparral-2d' ||
      id === 'chaparral-2d-67' ||
      id === 'porsche-934-rsr'
      ? id
      : 'f12026-car';
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
    // Blankets on or off take effect where the tyres are next put back to their start temperature (the next start)
    this.vehicle.tyreBlankets = s.tyreBlankets === 0 ? null : s.tyreBlankets > 0;
    const click = WING_CLICK_DEG[car];
    this.wingTrimDeg = { front: s.frontWingClicks * click.front, rear: s.rearWingClicks * click.rear };
    this.aeroPreset = this.aero;
    const base = this.chassisBase;
    const susp = this.config.suspensions;
    const axle = (spec: typeof susp.front, b: typeof base.front, springPct: number, arbPct: number, stopRatePct: number, stopRangeMm: number) => {
      spec.springs.wheel_rate = b.springRate * pctScale(springPct);
      // A bar is only taken off altogether (−100 %) on a car whose data allows it
      spec.arb = b.arb * pctScale(Math.max(spec.allowNoArb ? -100 : -50, arbPct));
      spec.bumpStop.rate = b.bumpStopRate * pctScale(stopRatePct);
      spec.bumpStop.range = Math.max(0.002, b.bumpStopRange + stopRangeMm / 1000);
    };
    axle(susp.front, base.front, s.springFrontPct, s.arbFrontPct, s.bumpStopRateFrontPct, s.bumpStopRangeFrontMm);
    axle(susp.rear, base.rear, s.springRearPct, s.arbRearPct, s.bumpStopRateRearPct, s.bumpStopRangeRearMm);
    // Corner packers, and on a car with third elements their springs, packers and dampers
    susp.front.bumpStop.packerGap = base.cornerPacker.front + s.cornerPackerFrontMm / 1000;
    susp.rear.bumpStop.packerGap = base.cornerPacker.rear + s.cornerPackerRearMm / 1000;
    const third = (
      spec: typeof susp.front,
      d: typeof susp.dampers_controller.front,
      b: { rate: number; packerGap: number },
      bd: DamperSettingsUnits,
      front: boolean
    ) => {
      if (b.rate <= 0) return;
      spec.heave.rate = b.rate * pctScale(front ? s.heaveSpringFrontPct : s.heaveSpringRearPct);
      spec.heave.packerGap = Math.max(0.001, b.packerGap + (front ? s.heavePackerFrontMm : s.heavePackerRearMm) / 1000);
      d.heave.slow_bump = bd.slow_bump * pctScale(front ? s.heaveBumpFrontPct : s.heaveBumpRearPct);
      d.heave.fast_bump = bd.fast_bump * pctScale(front ? s.heaveFastBumpFrontPct : s.heaveFastBumpRearPct);
      d.heave.slow_rebound = bd.slow_rebound * pctScale(front ? s.heaveReboundFrontPct : s.heaveReboundRearPct);
      d.heave.fast_rebound = bd.fast_rebound * pctScale(front ? s.heaveFastReboundFrontPct : s.heaveFastReboundRearPct);
    };
    third(susp.front, susp.dampers_controller.front, base.heave.front, base.heaveDamper.front, true);
    third(susp.rear, susp.dampers_controller.rear, base.heave.rear, base.heaveDamper.rear, false);
    // A homologated gear set, on a car with more than one
    const sets = this.config.gearSets;
    if (sets && sets.length > 0) {
      const set = sets[clamp(Math.round(s.gearRatioSet), 0, sets.length - 1)];
      const gb = this.config.gearbox;
      gb.ratios = [...set.ratios];
      gb.reverse = set.reverse;
      gb.finalDrive = set.finalDrive;
    }
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
    const toe0 = this.profile.staticToeDeg;
    v.staticToeRad = { front: ((toe0?.front ?? 0) + s.toeFrontDeg) * DEG, rear: ((toe0?.rear ?? 0) + s.toeRearDeg) * DEG };
    // Never past the engine's whole overrun: only a car whose default tune passes part of it can turn it up
    v.engineBrakingScale = Math.min(pctScale(s.engineBrakingPct), 1 / Math.min(1, this.config.performanceModes.RAC.coastTorqueScale));
    v.brakeDuctScale = { front: Math.max(0.3, 1 + s.brakeDuctFront * BRAKE_DUCT_STEP), rear: Math.max(0.3, 1 + s.brakeDuctRear * BRAKE_DUCT_STEP) };
    v.coolingSteps = { brakeDuctFront: s.brakeDuctFront, brakeDuctRear: s.brakeDuctRear, radiator: s.radiatorTapeSteps };
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
    return defaultColdPressurePsi(this.compoundData);
  }

  set tireCompound(compound: TireCompound) {
    const prevDefault = this.defaultColdPsiForCompound();
    const deltas = { ...this.coldPsi };
    for (const k of ["fl", "fr", "rl", "rr"] as const) deltas[k] -= prevDefault;
    this.compound = compound;
    this.vehicle.setCompound(this.config.compoundSlots[compound]);
    this.refreshBrakingGuide(this.lastGuideWaterMm, true);
    const nextDefault = this.defaultColdPsiForCompound();
    const pr = this.profile;
    for (const k of ["fl", "fr", "rl", "rr"] as const) {
      // Clamped as the setup sheet states it (as setTyreSetup does), kept at the tyres' own reference temperature
      const sheet = clamp(this.setupPsi(nextDefault + deltas[k], true), pr.coldPsiRange[0], pr.coldPsiRange[1]);
      this.coldPsi[k] = pr.setupPressureRefC === undefined ? Math.round(sheet * 10) / 10 : this.setupPsi(sheet, false);
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
    const d = assistPresetDials(this.profile, preset);
    Object.assign(this, d);
    this.tcSlipAngleLevel = d.tcSlipAngleLevel ?? d.tcLevel;
  }

  public getLiveTunerState(): LiveTunerState {
    const v = this.vehicle;
    const cut = this.absWheelCut;
    return {
      tcLevel: this.tcLevel,
      tc2Level: this.tc2Level,
      tcSlipAngleLevel: this.tcSlipAngleLevel,
      hasTcSlipAngle: this.profile.tcSlipAngleDial === true,
      absLevel: this.absLevel,
      absAllowed: this.profile.absAllowed !== false,
      motorDeployKw: v.motorDeployKw,
      regenKw: v.regenKw,
      motorDeployStepsKw: this.config.hybridDials?.deployStepsKw ?? [],
      regenStepsKw: this.config.hybridDials?.regenStepsKw ?? [],
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
      // A prototype's hybrid runs from its kW dials: the F1 modes do nothing on it, so they are not offered
      hasErs: this.profile.hasErs && !this.config.hybridDials,
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
      this.tcLevel = clamp(Math.round(patch.tcLevel), 0, 12);
    }
    if (patch.tc2Level !== undefined) {
      this.tc2Level = clamp(Math.round(patch.tc2Level), 1, 12);
    }
    if (patch.absLevel !== undefined) {
      // A class without ABS: only the Assisted preset may run it
      const banned = this.profile.absAllowed === false && this._assistPreset !== 'assisted';
      this.absLevel = banned ? 0 : clamp(Math.round(patch.absLevel), 0, 12);
    }
    if (patch.tcSlipAngleLevel !== undefined) {
      this.tcSlipAngleLevel = clamp(Math.round(patch.tcSlipAngleLevel), 0, 12);
    }
    const dials = this.config.hybridDials;
    if (dials && patch.motorDeployKw !== undefined && Number.isFinite(patch.motorDeployKw)) {
      v.motorDeployKw = nearestStep(dials.deployStepsKw, patch.motorDeployKw);
    }
    if (dials && patch.regenKw !== undefined && Number.isFinite(patch.regenKw)) {
      v.regenKw = nearestStep(dials.regenStepsKw, patch.regenKw);
    }
    // The mode before the bias: the bias the driver dials is set as their offset on top of the mode's own
    if (patch.ersMode !== undefined && this.profile.hasErs && !this.config.hybridDials) {
      const m = patch.ersMode as PerformanceModeName;
      if (m === 'PSH' || m === 'RAC' || m === 'BAL' || m === 'LIC' || m === 'CHR') {
        this.userErsMode = m;
        v.setPerformanceMode(m);
      }
    }
    if (patch.brakeBiasPct !== undefined) {
      v.brakeBias = clamp(patch.brakeBiasPct / 100, 0.45, 0.78);
    }
    if (patch.brakeMigrationPct !== undefined) {
      v.liveBrakeMigrationAmount = clamp(patch.brakeMigrationPct / 100, 0, 0.06);
    }
    if (patch.diffEntry !== undefined) {
      v.diffEntryLevel = clamp(Math.round(patch.diffEntry), 1, 12);
    }
    if (patch.diffMid !== undefined) {
      v.diffMidLevel = clamp(Math.round(patch.diffMid), 1, 12);
    }
    if (patch.diffExit !== undefined) {
      v.diffExitLevel = clamp(Math.round(patch.diffExit), 1, 12);
    }
    if (patch.engineMap !== undefined) {
      v.engineMap = clamp(Math.round(patch.engineMap), 1, 5);
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

  /** A cold pressure at the tyres' own reference temperature as the setup sheet states it, and back */
  private setupPsi(psi: number, toSheet: boolean): number {
    const sheetC = this.profile.setupPressureRefC;
    if (sheetC === undefined) return psi;
    const tyreC = this.compoundData.pressureData.coldRefC;
    return Math.round(tyreGaugePressureAtTemperature(psi, toSheet ? tyreC : sheetC, toSheet ? sheetC : tyreC) * 10) / 10;
  }

  public getTyreSetup(): TyreSetup {
    const s = this.config.suspensions;
    const p = this.coldPsi;
    return {
      coldPressurePsi: { fl: this.setupPsi(p.fl, true), fr: this.setupPsi(p.fr, true), rl: this.setupPsi(p.rl, true), rr: this.setupPsi(p.rr, true) },
      camberDeg: { front: s.front.staticCamber, rear: s.rear.staticCamber },
    };
  }

  /** Clamps cold pressure (psi gauge, rounded to 0.1) and camber (degrees) to the active vehicle profile's limits. */
  public setTyreSetup(setup: TyreSetup): void {
    const pick = (v: number, [lo, hi]: [number, number], current: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : current);
    const pr = this.profile;
    for (const k of ["fl", "fr", "rl", "rr"] as const) {
      // Clamped as the sheet states it, kept at the tyres' own reference temperature
      const sheet = pick(setup.coldPressurePsi[k], pr.coldPsiRange, this.setupPsi(this.coldPsi[k], true));
      this.coldPsi[k] = pr.setupPressureRefC === undefined ? Math.round(sheet * 10) / 10 : this.setupPsi(sheet, false);
    }
    const s = this.config.suspensions;
    s.front.staticCamber = pick(setup.camberDeg.front, pr.frontCamberRange, s.front.staticCamber);
    s.rear.staticCamber = pick(setup.camberDeg.rear, pr.rearCamberRange, s.rear.staticCamber);
    this.applyColdPressures();
  }

  /**
   * The session's energy allowances (2026 rules): a time trial's are qualifying's, a practice's free practice's (a race
   * is known from race control)
   */
  public setEnergySession(timeTrial: boolean): void {
    this.energyTimeTrial = timeTrial;
  }

  /**
   * The latched boost. Under the 2026 rules the Boost, any time the store has charge (the latch is the session's); on
   * other cars push mode (PSH) for 8 s, on a 2026 car in a race only with Overtake Mode earned
   */
  public activateBoostOverride(): boolean {
    if (this.config.ers.regulations === 'f1-2026') return this.profile.hasErs && this.vehicle.ersCanBoost;
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
    this.lowGrip = sample.lowGrip === true;
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
    this.lastGuideWaterMm = sample.lineWaterMm !== undefined ? Math.max(0, sample.lineWaterMm) : v.waterMm;
    this.refreshBrakingGuide(this.lastGuideWaterMm, false);
  }

  /** Rebuilds the cached braking guide only when lap-wide wet-track grip crosses a hysteretic 5 % bucket */
  private refreshBrakingGuide(waterMm: number = this.lastGuideWaterMm, force = false): void {
    const v = this.vehicle;
    const traits = this.compoundData.wetTraits ?? SLICK_TRAITS;
    const wetGrip = waterMm > 0.02 ? wetGripFactor(traits, waterMm, 50, v.realism.wetSeverity, 0) / (traits.dryGrip ?? 1) : 1;
    const scaled = Math.max(8, Math.min(20, wetGrip * 20));
    // Hysteresis prevents rapid guide swapping when crossing a drying racing line near a bucket boundary
    if (!force && Math.abs(scaled - this.brakingGuideGripBucket) < 0.75) return;
    const bucket = Math.max(8, Math.min(20, Math.round(scaled)));
    if (bucket === this.brakingGuideGripBucket) return;
    this.brakingGuideGripBucket = bucket;
    const base = this.profile.speedProfile;
    if (bucket === 20) {
      this.brakingGuide = base
        ? brakingGuideFor(this.track.samples, this.profile.id, base, this.line)
        : circuitBrakingGuide(this.track.samples, this.line);
      return;
    }
    const wetBase = base ?? createLc26ProfileCarModel(this.aeroPreset);
    const gripScale = bucket / 20;
    this.brakingGuide = brakingGuideFor(
      this.track.samples,
      `${this.profile.id}:${this.aeroPreset}:g${bucket}`,
      withPlanningGrip(wetBase, gripScale),
      this.line
    );
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
   * straight (further slots queue 28 m apart, alternating sides), as the LC26 does.
   */
  public resetToStartGrid(flyingStart = false, gridSlot = 0, fieldSize?: number, raceStart = false): void {
    // A point-to-point course is driven from a standing start: its road ends behind the start line
    const pointToPoint = !!this.track.pointToPoint;
    if (pointToPoint) flyingStart = false;
    // Out of the garage at the full realism level: tyres raced without blankets and their brakes cold, for an out-lap
    // to warm. A race's grid and a rolling start come after a formation lap, a hill climb's start line after the
    // driver's own warm-up (it has no out-lap), and the autopilot's cars plan on warm brakes
    this.vehicle.coldGarageStart = this.realism.coldGarageStart && !flyingStart && !raceStart && !pointToPoint && !this.aiAutopilot;
    this.runActive = false;
    this.atRestOnLine = false;
    // Fuelled before it is seated, so it settles at the ride height of that load
    this.fillFuel();
    const L = this.track.totalLengthM;
    if (flyingStart) {
      // From the final straight (`flyingStartPoint`), on this car's line, kept on the asphalt, and no faster than
      // 90 % of the speed this car's autopilot plans there, nor than it can carry out of the last corner
      const start = flyingStartPoint(this.track);
      const s =
        fieldSize !== undefined
          ? rollingStartSlots(this.track, start, gridSlot + 1)[gridSlot]
          : wrap(start.s - gridSlot * FLYING_SLOT_SPACING_M, L);
      const stagger = gridSlot === 0 ? 0 : gridSlot % 2 === 1 ? -2.6 : 2.6;
      const rangeAt = (at: number) =>
        autopilotLateralRange(this.track, this.track.getSampleAtDistance(at), at, this.autopilotEdges(), this.profile);
      const lineAt = (at: number) => {
        const [lo, hi] = rangeAt(at);
        return clamp(aiLineOffsetM(this.track.getSampleAtDistance(at), this.line) + stagger, Math.min(0, lo), Math.max(0, hi));
      };
      const [lo, hi] = rangeAt(s);
      const prof = autopilotProfile(this.track, this.profile, this.autopilotEdges());
      const ownAt = (at: number) => prof[Math.floor(wrap(at, L) / (L / prof.length)) % prof.length];
      const spotSpeed = (at: number) => {
        const sample = this.track.getSampleAtDistance(at);
        return Math.min(75, 0.9 * Math.min(ownAt(at), (sample.brakeLimitKmh ?? sample.optimalSpeedKmh) / 3.6));
      };
      const cornerExit =
        start.cornerS === null ? 0 : 0.9 * Math.min(ownAt(start.cornerS), this.track.getSampleAtDistance(start.cornerS).optimalSpeedKmh / 3.6);
      let speed = spotSpeed(s);
      if (fieldSize !== undefined) speed = rollingStartSpeedMs(this.track, start, fieldSize, spotSpeed, cornerExit);
      else if (start.cornerS !== null) speed = Math.min(speed, flyingExitSpeedMs(cornerExit, wrap(s - start.cornerS, L)));
      if (fieldSize === undefined) {
        // A flying lap hands the car over at speed: pointed so that, hands-off, its tyres stay on the asphalt for its
        // first second (`startPose`)
        const pose = startPose(this.track, this.collider, s, lineAt(s), lineAt, lo, hi, this.startFootprint(), speed * START_HANDS_OFF_S);
        this.progressHintS = this.poseHintS = s;
        this.resetVehicle(pose.x, pose.z, pose.yawRad, speed);
      } else {
        // A race's rolling start puts each slot on its line along the road, unchecked: its queue runs back into the
        // last corner, where pointing a car at its line ahead turned one 19° across the road (Le Mans 1982's fourth slot)
        this.placeAt(s, lineAt(s), speed);
      }
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
    this.atRestOnLine = pointToPoint && this.s >= L - 10;
    this.vehicle.coldGarageStart = false;
    this.vehicle.ersEnergyJ = this.config.ers.ERS_MAX_CHARGE;
    this.vehicle.resetLapEnergy();
    if (!flyingStart) this.vehicle.armStandingStart();
    this.simTimeMs = 0;
    this.lapStartMs = 0;
    this.sectorStartMs = 0;
    this.lapValid = true;
    this.telemetry.lapInvalid = false;
    // Standing race starts on circuits whose painted grid lies ahead of the control/finish line (s = 0, e.g. Istanbul
    // Park) complete Lap 1 on their first crossing of s = 0, matching RaceClock; solo standing starts still treat that
    // opening stretch as an out-lap so no shorter-than-full lap is ever timed or submitted.
    const startedAheadOfLine = !flyingStart && !pointToPoint && this.s > 0 && this.s < L * 0.5;
    this.lineCrossingStartsLap = !(raceStart && startedAheadOfLine);
    this.shortStartLap = raceStart && startedAheadOfLine;
    this.telemetry.outLap = this.lineCrossingStartsLap;
    this.telemetry.currentLapTimeMs = 0;
    this.telemetry.topSpeedThisLapKmh = 0;
  }

  public teleportToDistance(sMeters: number, speedMs = 0, lateral = 0): void {
    this.lineCrossingStartsLap = false;
    this.shortStartLap = false;
    this.atRestOnLine = false;
    this.telemetry.outLap = false;
    // Moved mid-lap (corner practice, a stuck or lost car's rescue): the lap under way can't count
    this.invalidateLap();
    this.placeAt(wrap(sMeters, this.track.totalLengthM), lateral, Math.max(0, speedMs));
    this.afterPlacement();
  }

  /** Back on the ground at a recorded pose, rolling at its speed, with the tyres as they are now */
  public restorePose(pose: { x: number; z: number; yawRad: number; speedMs: number; s?: number; lapCount?: number; outLap?: boolean }): void {
    // Put back: the lap under way can't count. Restore recorded outLap state when supplied (so rewinding from lap 1
    // back onto the out-lap does not count the out-lap as a lap), otherwise preserve the current out-lap flag.
    if (pose.outLap !== undefined) this.lineCrossingStartsLap = pose.outLap;
    this.shortStartLap = false;
    this.atRestOnLine = false;
    this.invalidateLap();
    if (pose.lapCount !== undefined && Number.isFinite(pose.lapCount)) {
      this.telemetry.lapCount = Math.max(0, Math.floor(pose.lapCount));
    }
    this.telemetry.outLap = this.lineCrossingStartsLap;
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
    this.shortStartLap = false;
    this.atRestOnLine = false;
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
      throttle: clamp(raw.throttle ?? 0, 0, 1),
      brake: clamp(raw.brake ?? 0, 0, 1),
      steerLeft: raw.steerLeft ?? 0,
      steerRight: raw.steerRight ?? 0,
      analogSteer: raw.analogSteer,
      padSteer: raw.padSteer !== undefined ? clamp(raw.padSteer, -1, 1) : undefined,
      kbSteer: raw.kbSteer !== undefined ? Math.sign(raw.kbSteer) : undefined,
      steerRim: raw.steerRim === true && Number.isFinite(raw.analogSteer),
      manualOverride: raw.manualOverride ?? false,
      overtake: raw.overtake ?? false,
      toggleXMode: raw.toggleXMode ?? false,
      shiftUp: raw.shiftUp ?? false,
      shiftDown: raw.shiftDown ?? false,
      neutral: raw.neutral ?? false,
      // The driver's clutch pedal while it is pressed at all; let go, the car works its own clutch
      clutch: Number.isFinite(raw.clutch) && (raw.clutch ?? 0) > 0 ? clamp(raw.clutch ?? 0, 0, 1) : undefined,
      clutchBound: raw.clutchBound,
    };
    if (inputs.toggleXMode && this.profile.hasDrs) this.drsPressPending = true;
    // Whole control ticks of this frame; what is left over waits for the next (the pose is drawn carried forward by it)
    this.controlAccumulatorS = Math.min(this.controlAccumulatorS + dtSeconds, MAX_CATCH_UP_S);
    let ticks = 0;
    for (let a = this.controlAccumulatorS; a >= CONTROL_DT_S; a -= CONTROL_DT_S) ticks++;
    this.controlAccumulatorS -= ticks * CONTROL_DT_S;
    const steppedS = ticks * CONTROL_DT_S;
    this.steppedTicks += ticks;

    if (this.aiAutopilot) {
      // The autopilot takes the car after a stint off: its pedal and steer integrators start from zero, not from its
      // last drive. A brief hand-back (an AI driver's reaction to a knock) carries on from where it was.
      if (this.autopilotIdleS > AUTOPILOT_STALE_S) this.apPedal = this.apYawI = this.apThrottle = 0;
      this.autopilotIdleS = 0;
    } else {
      this.autopilotIdleS += steppedS;
    }

    // Push mode while the override is held / latched, or for the boost's 8 s
    this.boostCooldownS = Math.max(0, this.boostCooldownS - steppedS);
    if (this.boostRemainingS > 0 && steppedS > 0) {
      this.boostRemainingS = Math.max(0, this.boostRemainingS - steppedS);
      if (this.boostRemainingS === 0) this.boostCooldownS = BOOST_COOLDOWN_S;
    }
    // 2026: the override is Overtake Mode, earned in a race within 1 s at the detection point for the lap after it
    // (with its extra energy); an AI car spends it in the zones, where it overtakes
    const overtakeOk = this.overtakeAvailable;
    const straight2026 = this.rules === 'straight-mode-2026';
    const racing = !!this.raceControl?.racing;
    // Where an Overtake is spent: under the 2026 rules the circuit's overtaking stretches (Monaco's longest runs too), else
    // the circuit's DRS zones
    const zoneNow =
      v.ersCircuit && Number.isFinite(v.trackProgress)
        ? v.ersCircuit.overtakeZones.some((w) => inStretch(v.trackProgress * this.track.totalLengthM, w))
        : inOvertakingZone(v.trackProgress);
    // Low Grip Conditions (2026): Overtake disabled in every session (Section B7.2.2 d), the Boost only holding the power
    // (B7.2.1 g), only the front flaps (B7.1.2 b)
    const lowGrip = straight2026 && this.lowGrip;
    v.flapsLowGrip = straight2026 ? this.lowGrip : null;
    v.ersLowGrip = lowGrip;
    const aiOvertake = this.aiAutopilot && straight2026 && racing && overtakeOk && !lowGrip && zoneNow;
    v.extraRechargeJ = straight2026 && !lowGrip ? this.overtake.extraRechargeJ(this.raceControl) : 0;
    v.ersSession = racing ? 'race' : this.energyTimeTrial ? 'timeTrial' : 'practice';
    if (this.config.ers.regulations === 'f1-2026') {
      // The 2026 rules: the Boost and Overtake are two things (FIA 2026 Section C5.12.5, B7.2.3). The Boost: the driver's,
      // any time, held or latched, capped in a race (`ers-2026.ts`). Overtake: all the time outside a race; in one, from
      // the Activation Line after an earned detection to the next, used from the driver's press of Overtake (a second
      // press stops it) or by the Automatic Overtake on the overtaking straights, flat out, with less of its power
      if (this.overtake.activations !== this.overtakeLap) {
        this.overtakeLap = this.overtake.activations;
        this.overtakeInUse = false;
      }
      if (inputs.overtake && racing && overtakeOk && !lowGrip) this.overtakeInUse = !this.overtakeInUse;
      if (!overtakeOk || lowGrip) this.overtakeInUse = false;
      const autoOt =
        straight2026 && racing && overtakeOk && !lowGrip && !this.overtakeInUse && !this.aiAutopilot && this.autoOvertake &&
        zoneNow && inputs.throttle >= 0.98;
      const boost = this.profile.hasErs && (inputs.manualOverride || aiOvertake) && v.ersCanBoost;
      v.setPerformanceMode(this.userErsMode);
      v.ersBoost = boost;
      v.ersOvertake = straight2026 && !lowGrip && (!racing || this.overtakeInUse || aiOvertake || autoOt);
      v.ersOvertakeShare = autoOt ? AUTO_OVERTAKE_SHARE : 1;
      this.ersBoostNow = boost;
      this.overtakeAutoNow = autoOt;
      this.pushActive = boost || (racing && (this.overtakeInUse || aiOvertake || autoOt));
    } else {
      if (!overtakeOk) this.boostRemainingS = 0;
      const push = this.profile.hasErs && overtakeOk && (inputs.manualOverride || this.boostRemainingS > 0 || aiOvertake) && v.ersEnergyJ > 0;
      this.pushActive = push;
      v.setPerformanceMode(push ? 'PSH' : this.userErsMode);
      v.ersOvertake = push;
    }
    const progressBefore = v.trackProgress;

    // The paddles and the DRS button go to every tick of the frame: VehiclePhysics compares each tick with the one
    // before, so a press is one edge per frame (released in the later ticks, a held paddle was a new press each frame).
    // A press in a frame too short for a tick is kept for the next.
    this.shiftUpPending ||= inputs.shiftUp;
    this.shiftDownPending ||= inputs.shiftDown;
    this.neutralPending ||= inputs.neutral;
    const drsPress = this.drsPressPending;
    const shiftUp = this.shiftUpPending;
    const shiftDown = this.shiftDownPending;
    const neutral = this.neutralPending;
    if (ticks > 0) this.drsPressPending = this.shiftUpPending = this.shiftDownPending = this.neutralPending = false;
    this.vehicle.autoShift = this.autoGearbox || this.aiAutopilot;
    // Never soft-lock a car when manual clutch is requested but no clutch control is bound on the active device
    this.vehicle.autoClutch = this.autoClutch || this.autoGearbox || this.aiAutopilot || inputs.clutchBound === false;
    // A steering wheel's rim is read once a frame: its move since the last frame is spread over this frame's ticks, so
    // the rack turns at the rim's own speed rather than in one jump per frame
    const rim = inputs.steerRim && inputs.analogSteer !== undefined ? inputs.analogSteer : null;
    const rimFrom = rim !== null && this.lastRimSteer !== null ? this.lastRimSteer : rim;
    const held = this.gridHold;
    // Held, the car stays on its spot until the driver lets the clutch out in gear with the throttle up;
    // autopilot stays pinned on the grid through the red lights so it cannot jump the start
    const pinned = held && (this.aiAutopilot || keptOnGrid(v.velocity.length(), v.gear !== 0, inputs.clutch ?? 0, inputs.throttle ?? 0));
    for (let k = 0; k < ticks; k++) {
      if (rim !== null && rimFrom !== null) inputs.analogSteer = rimFrom + ((rim - rimFrom) * (k + 1)) / ticks;
      const cmd: { throttle: number; ignitionCut: number; brake: number; brakeWheelScale?: readonly [number, number, number, number]; steer: number; drs: boolean } =
        this.aiAutopilot ? this.autopilot(CONTROL_DT_S) : this.driverCommand(inputs, CONTROL_DT_S);
      const vin: VehicleInputs = {
        throttle: pinned && this.aiAutopilot ? 0 : cmd.throttle,
        // An empty tank (fuel is only burnt with fuel use on): the engine no longer fires. A race field's own car is
        // spared: it starts on a load nobody chose and has no pit stop to take
        ignitionCut: this.fuelKg > 0 || !this.realism.fuelUse || (this.aiAutopilot && !this.aiSelfRecovery) ? cmd.ignitionCut : 0,
        brake: pinned ? 1 : cmd.brake,
        brakeWheelScale: pinned ? undefined : cmd.brakeWheelScale,
        steer: pinned && this.aiAutopilot ? 0 : cmd.steer,
        drs: !held && (drsPress || cmd.drs),
        shiftUp: !held && shiftUp,
        shiftDown: !held && shiftDown,
        // The autopilot keeps its gear and drives on the car's own clutch
        neutral: !held && neutral && !this.aiAutopilot,
        clutch: pinned ? 1 : this.aiAutopilot ? undefined : this.vehicle.autoClutch ? inputs.clutch : (inputs.clutch ?? 0),
      };
      // A car whose state has blown up hands back a non-finite command: the rack must not keep it past the rescue
      this.steerCmd = Number.isFinite(vin.steer) ? vin.steer : 0;
      _v.copy(v.velocity);
      v.step(CONTROL_DT_S, vin);
      // Barrier contact this tick, while moving: every fixed step is counted, not only a frame's last
      if (v.telemetry.wallContact && v.velocity.length() > WALL_CONTACT_MIN_SPEED_MS) this.wallContactS += v.lastStepTimeS;
      this.updateBrakes(CONTROL_DT_S);
      // Divided by the time the fixed steps actually covered
      const stepS = v.lastStepTimeS;
      if (stepS > 0) {
        const dvx = _v.subVectors(v.velocity, _v);
        this.lastAxMs2 = dvx.dot(_ez.set(0, 0, 1).applyQuaternion(v.quaternion)) / stepS;
        this.lastAyMs2 = dvx.dot(_ex.set(1, 0, 0).applyQuaternion(v.quaternion)) / stepS;
        // An accelerometer's reading along the car's up axis: the body's acceleration less gravity's
        _ey.set(0, 1, 0).applyQuaternion(v.quaternion);
        this.chassisG = filterChassisG(this.chassisG, (dvx.dot(_ey) / stepS + G * _ey.y) / G, stepS);
      }
      // Fuel burnt this tick: the car gets lighter tick by tick, not frame by frame
      if (v.telemetry.throttle > 0.01 && this.fuelKg > 0 && this.realism.fuelUse) {
        const mapFlowMult = v.engineMap === 1 ? 1.04 : v.engineMap === 2 ? 1.0 : v.engineMap === 3 ? 0.96 : v.engineMap === 4 ? 0.90 : 0.85;
        const perRpm = this.profile.fuelLPerS1000Rpm;
        const baseFlowKgS = perRpm !== undefined ? (v.rpm / 1000) * perRpm * FUEL_KG_PER_L : (this.profile.fuelFlowKgS ?? 0.0278);
        this.fuelKg = Math.max(0, this.fuelKg - baseFlowKgS * mapFlowMult * v.telemetry.throttle * CONTROL_DT_S);
        v.setFuelMass(this.fuelKg);
      }
    }
    if (ticks > 0 || rim === null) this.lastRimSteer = rim;
    if (this.rules === 'straight-mode-2026' && this.profile.hasDrs) {
      // Race control's verdict at the detection point, for the HUD (judged only in a race)
      const judged = this.overtakeLines
        ? this.overtake.observeLines(progressBefore, v.trackProgress, this.overtakeLines, this.raceControl)
        : this.overtake.observe(progressBefore, v.trackProgress, RWANDA_DRS_ZONES, this.raceControl);
      if (judged) {
        this.channels.overtakeDetection = { earned: this.overtake.earned, atMs: this.simTimeMs };
      }
    }
    this.simTimeMs += steppedS * 1000;
    if (this.recoverIfLost()) return this.telemetry;
    if (this.aiAutopilot && this.aiSelfRecovery && !held && this.aiSpeedCapMs >= 2) this.recoverIfStuck(steppedS);
    else this.stuckS = 0;
    this.wheelRotationRad = (this.wheelRotationRad + 0.5 * (v.wheels[2].omega + v.wheels[3].omega) * steppedS) % (Math.PI * 2);
    this.syncPose();
    this.updateTiming(steppedS);
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
    const want = clamp(this.steeringAssist.steer(inputs, this.gamepadAssistEnabled, this.steeringAssistState, h), -1, 1);
    // A steering wheel's rim goes to the rack as the driver's hands turn it, however fast the catch
    if (inputs.steerRim && this.steeringAssist.source === 'direct') {
      return { ...this.electronicAids(inputs.throttle, inputs.brake, h, this), steer: want, drs: false };
    }
    // Any other device: the rack turns no faster than hands turn a wheel (900°/s at the rim, as the LC26's): a stick
    // flick, a mouse or a phone tilt otherwise reached the tyres as an instant step, which snaps a car at speed
    const maxStep = (DRIVER_RIM_SPEED_DEG_S / this.rimLockDeg) * h;
    const steer = this.steerCmd + clamp(want - this.steerCmd, -maxStep, maxStep);
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
      keyboardSteer: this.profile.keyboardSteer,
    };
  };

  /**
   * The autopilot's dials: the semi-pro preset's, with the Assisted preset's ABS where the class bans it (the AI's
   * threshold braking, which the autopilot's pedal alone does not do)
   */
  private autopilotDials(): AidDials {
    const d = this.profile.assistDials.semi_pro;
    return d.absLevel > 0 || this.profile.absAllowed !== false ? d : { ...d, absLevel: this.profile.assistDials.assisted.absLevel };
  }

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
    const tcLv = clamp(Math.round(dials.tcLevel), 0, 12);
    const tcBaseTarget = tcLv > 0 ? elec.tcLevels[clamp(12 - tcLv, 0, elec.tcLevels.length - 1)] : 0;
    const tcMinSpeedMs = elec.tcMinSpeedKmh / 3.6;
    if (tcBaseTarget > 0 && speed > Math.max(this.profile.tcMinSpeedMs, tcMinSpeedMs)) {
      // Lateral-G slip target tightening: kappa_target(ay) = kappa_TC1 * max(floor, 1.0 - gain * (|ay|/g)^exponent)
      const tight = elec.tcLateralTightening ?? DEFAULT_TC_LATERAL_TIGHTENING;
      const gLat = Math.abs(this.lastAyMs2) / G;
      const saLimitRad = Math.max(0.05, (this.compoundData.modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD);
      // The driven axle's tyres: the rears on an F1 car or a GT3, the fronts on a front-wheel-drive car
      const [dl, dr] = v.drivenWheels;
      const saDriven = Math.max(Math.abs(W[dl].slipAngleRad), Math.abs(W[dr].slipAngleRad)) / saLimitRad;
      const ctl = this.aidControl;
      const slide = v.waterMm > 0 ? ctl.tcWetSlide : elec.tcDryRearSlide;
      let slideGain = slide ? slide.gain : 0;
      let slideFrom = slide ? slide.from : 0;
      if (this.profile.tcSlipAngleDial) {
        // The slip-angle dial: off at 0; from 1 (the most slide before the cut) to 12 (the least), about the car's own
        // calibration at 6–7
        const lvl = clamp(Math.round(dials.tcSlipAngleLevel ?? dials.tcLevel), 0, 12);
        const own = slide ?? ctl.tcWetSlide;
        const n = (lvl - 1) / 11;
        slideGain = lvl > 0 ? own.gain * (0.45 + 1.1 * n) : 0;
        slideFrom = own.from * (1.45 - 0.9 * n);
      }
      const slideTerm = slideGain > 0 ? slideGain * Math.max(0, saDriven - slideFrom) : 0;
      const latFactor = Math.max(tight.floor, 1 - tight.gain * Math.pow(gLat, tight.exponent) - slideTerm);
      const tcEffTarget = tcBaseTarget * latFactor;
      // Weighted driven axle slip (default 0.65 * max(k_L, k_R) + 0.35 * mean(k_L, k_R)); on a four-wheel-drive car the
      // axle that spins the more (the slide term above stays with the axle the engine drives directly)
      const axleSlip = (l: number, r: number) => {
        const kL = Math.max(0, W[l].slipRatio);
        const kR = Math.max(0, W[r].slipRatio);
        return ctl.tcSlipMaxWeight * Math.max(kL, kR) + ctl.tcSlipMeanWeight * (0.5 * (kL + kR));
      };
      let kDriven = axleSlip(dl, dr);
      if (v.coupledWheels) kDriven = Math.max(kDriven, axleSlip(v.coupledWheels[0], v.coupledWheels[1]));
      const eTc = Math.max(0, kDriven - tcEffTarget);
      const tc2 = clamp(dials.tc2Level, 1, 12);
      const tc2Norm = (tc2 - 1) / 11;
      // Stage A (0 < eTc <= 0.03 by default): smooth spark timing retard up to 25% cut
      const stageACut = Math.min(1, eTc / ctl.tcStageASlip) * ctl.tcStageACut * (0.55 + 0.45 * tc2Norm);
      // Stage B (past stage A): sequential cylinder cut scaled by TC2 up to 85% total cut
      const peak = Math.max(0.05, this.compoundData.modelData.slip_ratio_limit);
      const stageBCut = eTc > ctl.tcStageASlip ? ((eTc - ctl.tcStageASlip) / peak) * (ctl.tcStageBSlope + ctl.tcStageBSlopeTc2 * tc2Norm) : 0;
      const minThrottleShare = Math.max(0.05, ctl.tcFloor - ctl.tcFloorPerTc2 * tc2);
      const want = eTc > 0 ? Math.max(minThrottleShare, 1 - stageACut - stageBCut) : 1;
      const tcRate = elec.tcRateHz;
      this.tcCut += (want - this.tcCut) * Math.min(1, (want < this.tcCut ? tcRate : tcRate * ctl.tcReleaseShare) * h);
      ignitionCut = this.tcCut;
    } else {
      this.tcCut = 1;
    }

    // 240 Hz 4-Channel Independent ABS (per-wheel slip + angular decel anticipation + rear yaw stability)
    const absLv = clamp(Math.round(dials.absLevel), 0, 12);
    // A map per dial position (front and rear targets as shares of the tyre's peak slip, a reapply rate), or a slip
    // target per level
    const absMap = this.profile.enduranceAbsMaps && absLv > 0 ? ENDURANCE_ABS_MAPS[absLv - 1] : null;
    const kappaPeak = Math.max(0.05, this.compoundData.modelData.slip_ratio_limit);
    const absBaseTarget = absMap
      ? kappaPeak * absMap[0]
      : absLv > 0
        ? elec.absLevels[clamp(12 - absLv, 0, elec.absLevels.length - 1)]
        : 0;
    const cut = this.absWheelCut;
    if (this.absCut === 1) cut.fill(1);
    if (absBaseTarget > 0 && speed > 3 && brake > 0.01) {
      const absRate = elec.absRateHz;
      const guard = elec.absRearSlipAngleGuard ?? DEFAULT_ABS_REAR_GUARD;
      const ctl = this.aidControl;
      let minCut = 1;
      for (let i = 0; i < 4; i++) {
        const w = W[i];
        const wheelDecel = Math.max(0, -(w.omega - this.prevWheelOmega[i]) / Math.max(1e-4, h));
        const decelAnticipation = ((wheelDecel * w.rollingRadius) / Math.max(8, speed)) * ctl.absAnticipationS;
        const lock = -w.slipRatio + decelAnticipation;
        // Rear channels tighten target under trail-braking slip angle to prevent rear axle step-out
        const rearLatGuard = i >= 2 ? Math.max(guard.floor, 1 - guard.gain * Math.max(0, Math.abs(w.slipAngleRad) - guard.deadbandRad)) : 1;
        const axleTarget = absMap && i >= 2 ? kappaPeak * absMap[1] : absBaseTarget;
        const effAbsTarget = axleTarget * rearLatGuard;
        const want = lock > effAbsTarget ? Math.max(ctl.absFloor, 1 - (lock - effAbsTarget) * ctl.absGain) : 1;
        const reapply = absRate * ctl.absReleaseShare * (absMap ? absMap[2] : 1);
        cut[i] += (want - cut[i]) * Math.min(1, (want < cut[i] ? absRate * ctl.absApplyShare : reapply) * h);
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
    const p = this.track.projectWorldToTrackInto
      ? this.track.projectWorldToTrackInto(v.position.x, v.position.z, _simProj, this.poseHintS)
      : this.track.projectWorldToTrack(v.position.x, v.position.z, this.poseHintS);
    _ex.set(1, 0, 0).applyQuaternion(v.quaternion);
    _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
    const beta = Math.atan2(v.velocity.dot(_ex), Math.max(1, v.velocity.dot(_ez)));
    const plan = this.aiPlan;
    let kappa: number;
    if (plan) {
      kappa = this.planCurvature(plan, p, speed);
    } else {
    const lookS = (p.s + Math.max(10, (speed * 0.55) / this.aiSteerGain)) % L;
    const look = this.track.getSampleAtDistanceInto
      ? this.track.getSampleAtDistanceInto(lookS, _apSample)
      : this.track.getSampleAtDistance(lookS);
    // the racing line uses the kerbs; the autopilot keeps all four wheels on the asphalt
    const [lookLo, lookHi] = autopilotLateralRange(this.track, look, look.s, this.autopilotEdges(), this.profile);
    const off = clamp(aiLineOffsetM(look, this.line) + this.aiLineBiasM, lookLo, lookHi);
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
      const lineNow = clamp(aiLineOffsetM(p.sample, this.line) + this.aiLineBiasM, lo, hi);
      const b = p.sample.binormal;
      const bl = Math.hypot(b.x, b.z) || 1;
      // + lateral is this far to the car's left
      const leftOf = (b.x * _ex.x + b.z * _ex.z) / bl;
      const errLeft = (lineNow - p.lateralOffset) * leftOf;
      const rateLeft = -((v.velocity.x * b.x + v.velocity.z * b.z) / bl) * leftOf;
      const aLat = clamp(
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
    const kYawP = 0.5 + 3 * clamp((speed - 65) / 30, 0, 1);
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
          ? clamp((v.totalMassKg * speed * speed * kappa * this.cgToRearAxleM) / (v.wheelbaseM * kF), -peak, peak)
          : 0;
    const raw = Math.atan(v.wheelbaseM * kappa) + understeer + 0.8 * beta + kYawP * kYaw * yawErr + this.apYawI;
    const delta = clamp(raw, betaF - peak, betaF + peak);
    const frontsSaturated = delta !== raw;
    if (!frontsSaturated) this.apYawI = clamp(this.apYawI + yawErr * kYaw * 2 * h, -0.05, 0.05);
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
      this.apPedal = clamp(this.apPedal + vErr * 0.01 * (h * 120), -1, 1);
    }
    const pedal = clamp(this.apPedal + pedalP + pedalFF, -1, 1);
    const W = v.wheels;
    // The rear stepping out (on a trail-braked entry, or on the power): ease both pedals as the rears' slip angle
    // passes AP_REAR_GUARD of their peak, so they regain grip to hold the car with rather than spinning it
    const rearSlip = Math.max(Math.abs(W[2].slipAngleRad), Math.abs(W[3].slipAngleRad)) / peak;
    const rearCut = clamp(1 - AP_REAR_GUARD_GAIN * (rearSlip - AP_REAR_GUARD), 0.15, 1);
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
      this.autopilotDials()
    );
    return {
      ...aids,
      // aimed at the road-wheel angle: the rack gives up `complianceRad` to the lateral force, so add it back
      steer: this.autopilotSteer(clamp(-(delta - 0.5 * (W[0].complianceRad + W[1].complianceRad)) / v.maxSteerRad, -1, 1), h),
      drs: v.telemetry.drsAvailable && !v.drsOpen && aids.throttle > 0.95,
    };
  }

  /**
   * The autopilot's steering, turned no faster than a driver's hands can turn the wheel when it tracks a plan (the
   * player's 900°/s at the rim): a hand-back after a knock otherwise slammed the rack across in one step
   */
  private autopilotSteer(want: number, h: number): number {
    if (!this.aiPlan) return want;
    const maxStep = (DRIVER_RIM_SPEED_DEG_S / this.rimLockDeg) * h;
    return this.steerCmd + clamp(want - this.steerCmd, -maxStep, maxStep);
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
    let outNeg = 0, outPos = 0;
    if (edges) {
      const n = edges.neg.length;
      const i = Math.round((wrap(s, this.track.totalLengthM) / this.track.totalLengthM) * n) % n;
      lipNeg = edges.neg[i] < half - 0.05;
      lipPos = edges.pos[i] < half - 0.05;
      outNeg = edges.negOut[i];
      outPos = edges.posOut[i];
    }
    if (sample.kerbLeft && !lipNeg) lo -= TRACK_KERB_ALLOW_M;
    if (sample.kerbRight && !lipPos) hi += TRACK_KERB_ALLOW_M;
    // A kerb past the width: the outer tyres may run out to where it ends, as the quick drivers do
    const halfTrack = 0.5 * Math.max(this.profile.config.chassis.trackWidthFront, this.profile.config.chassis.trackWidthRear);
    if (!lipNeg && outNeg > 0) lo = Math.min(lo, -(half + outNeg - halfTrack - TRACK_KERB_EDGE_ROOM_M));
    if (!lipPos && outPos > 0) hi = Math.max(hi, half + outPos - halfTrack - TRACK_KERB_EDGE_ROOM_M);
    // A kerb modelled taller than this car takes: the outer tyres stay off it (the kerb allowance above included)
    const kerbs = this.collider ? kerbLimits(this.track, this.collider, this.profile.aiMaxKerbRiseM ?? AI_KERB_RISE_DEFAULT_M) : null;
    if (kerbs) {
      const n = kerbs.neg.length;
      const i = Math.round((wrap(s, this.track.totalLengthM) / this.track.totalLengthM) * n) % n;
      if (Number.isFinite(kerbs.neg[i])) lo = Math.max(lo, -(kerbs.neg[i] - halfTrack - AI_KERB_TYRE_ROOM_M));
      if (Number.isFinite(kerbs.pos[i])) hi = Math.min(hi, kerbs.pos[i] - halfTrack - AI_KERB_TYRE_ROOM_M);
      if (lo > hi) lo = hi = 0.5 * (lo + hi);
    }
    // A course laid out in cones: the lane between them, as a road edge (cone-lanes.ts)
    const cones = coneLaneRangeAt(this.track.id, s, this.track.totalLengthM);
    if (cones) {
      const margin = autopilotEdgeMarginM(this.profile);
      lo = Math.max(lo, cones[0] + margin);
      hi = Math.min(hi, cones[1] - margin);
      if (lo > hi) lo = hi = 0.5 * (cones[0] + cones[1]);
    }
    return [lo, hi];
  }

  /** The edges a traffic bias may push this car's plan target out to (`biasEdgesOf`), built on first use */
  private biasEdges(): BiasEdges {
    const key = this.collider ?? NO_COLLIDER;
    let perTrack = biasEdgeCache.get(key);
    if (!perTrack) biasEdgeCache.set(key, (perTrack = new WeakMap()));
    let perProfile = perTrack.get(this.track);
    if (!perProfile) perTrack.set(this.track, (perProfile = new WeakMap()));
    let edges = perProfile.get(this.profile);
    if (!edges) perProfile.set(this.profile, (edges = biasEdgesOf(this.track.totalLengthM, (s) => this.lateralRangeAt(s))));
    return edges;
  }

  /**
   * Where a supplied plan puts a car now `latNow` across the road at lap distance `s` (m, + right): the plan's offset
   * with the traffic bias, kept inside the usable road (`lateralRangeAt`). The bias takes it no further out than the
   * range's smoothed edges (`biasEdgesOf`), or than the plan's own offset or the car itself where either is further out:
   * a target held on the range's own edge stepped with it, and one held inside the car on the smoothed edge pulled it in
   * toward a car beside it (a pack into a corner, each car out on the kerb). Where the car is past the smoothed edge, a
   * narrowing ahead brings the target in no steeper than the edges are drawn. With no bias it is the plan's offset in
   * the range, as before
   */
  private planTargetAt(plan: AiDrivePlan, s: number, sample: TrackSamplePoint, latNow: number): number {
    const [lo, hi] = this.lateralRangeAt(s, sample);
    const n = sampleGrid(plan.n, s, plan.track.ds);
    let want = n + this.aiLineBiasM;
    if (this.aiLineBiasM !== 0) {
      const e = this.biasEdges();
      const loE = Math.min(sampleGrid(e.lo, s, e.ds), Math.max(sampleGrid(e.loAhead, s, e.ds), latNow));
      const hiE = Math.max(sampleGrid(e.hi, s, e.ds), Math.min(sampleGrid(e.hiAhead, s, e.ds), latNow));
      want = clamp(want, Math.min(n, loE), Math.max(n, hiE));
    }
    return clamp(want, lo, hi);
  }

  /**
   * The curvature (+ left, as the pursuit's) to steer for on a supplied plan: the path's own, a little ahead for the
   * steering's lag, plus a pull onto the path on the lateral error and its rate. The target is the plan's offset with
   * the traffic bias, kept inside the autopilot's usable road (edges and lips as ever, `planTargetAt`).
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
    const nNow = this.planTargetAt(plan, p.s, p.sample, p.lateralOffset);
    const eFar = Math.max(0, Math.abs(nNow - p.lateralOffset) - 1);
    const ld = Math.max(TRACK_LOOK_MIN_M, speed * TRACK_LOOK_S, Math.sqrt((2 * speed * speed * eFar) / TRACK_REJOIN_MS2)) / this.aiSteerGain;
    // The look-ahead along the path, as centreline distance (the inside of a corner covers less path per metre of
    // centreline, the outside more)
    const kc = sampleGrid(t.kappa, p.s + 0.5 * ld, t.ds);
    const nMid = sampleGrid(plan.n, p.s + 0.5 * ld, t.ds);
    const sLook = p.s + ld / Math.max(0.4, 1 - kc * nMid);
    const sLookWrapped = wrap(sLook, this.track.totalLengthM);
    const look = this.track.getSampleAtDistanceInto
      ? this.track.getSampleAtDistanceInto(sLookWrapped, _apSample)
      : this.track.getSampleAtDistance(sLookWrapped);
    const nT = this.planTargetAt(plan, sLook, look, p.lateralOffset);
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
      this.trackI = clamp(this.trackI + TRACK_KI * errLeft * CONTROL_DT_S, -TRACK_I_MAX_MS2, TRACK_I_MAX_MS2);
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
    // Racing, the plan's top speed is no limit: a car in a tow runs past it, held by its own drag, and brakes from there
    // on the open envelope. Held at the plan's top speed, the tow was worth nothing and a quicker car sat behind a slower
    // one down every straight. Told to lift (a yellow, a blue flag), the car keeps it, at its pace
    const env = this.aiTopSpeedOpen ? plan.vOpen : plan.v;
    const tab = this.aiTargetSpeedMs;
    const pace = this.aiPaceScale;
    let v0 = sampleGrid(env, s + lead, t.ds) * pace;
    let v1 = sampleGrid(env, s + lead + 6, t.ds) * pace;
    if (tab) {
      const s0w = wrap(s + lead, L);
      const k0 = Math.floor((s0w / L) * tab.length) % tab.length;
      const base0 = prof[Math.floor((s0w / L) * prof.length) % prof.length];
      if (base0 > 1) v0 *= clamp(tab[k0] / base0, 0.8, 1.05);
      const s1w = wrap(s + lead + 6, L);
      const k1 = Math.floor((s1w / L) * tab.length) % tab.length;
      const base1 = prof[Math.floor((s1w / L) * prof.length) % prof.length];
      if (base1 > 1) v1 *= clamp(tab[k1] / base1, 0.8, 1.05);
    }
    // The limit a little ahead (the pedal's lag). Where it rises or holds (a straight, a corner exit) the car simply
    // accelerates as hard as it can; where it falls, its slope is the braking the pedal is set for
    const aFF = (v1 * v1 - v0 * v0) / 12;
    if (aFF >= -0.5 && speed < v0) {
      // Still cornering hard (a corner exit): the full plan's acceleration, which shares the tyres between the corner
      // and the throttle; flooring it there ran the car wide on the power. Near straight: as hard as it can
      const ayShare = (Math.abs(sampleGrid(plan.kappa, s + lead, t.ds)) * speed * speed) / plan.limits.lateral(speed);
      if (ayShare > 0.3) {
        const vExp = sampleGrid(plan.vExpected, s + lead, t.ds) * pace;
        const vExp1 = sampleGrid(plan.vExpected, s + lead + 6, t.ds) * pace;
        const aExp = (vExp1 * vExp1 - vExp * vExp) / 12;
        _planSpeedOut.v = Math.min(v0, vExp);
        _planSpeedOut.pedalFF = clamp(aExp / Math.max(1, plan.limits.traction(speed)), 0, 1);
        return _planSpeedOut;
      }
      _planSpeedOut.v = Infinity;
      _planSpeedOut.pedalFF = 1;
      return _planSpeedOut;
    }
    const pedalFF = aFF >= 0 ? 0 : aFF / Math.max(1, plan.limits.braking(speed) / plan.limits.gripScale);
    _planSpeedOut.v = v0;
    _planSpeedOut.pedalFF = clamp(pedalFF, -1, 1);
    return _planSpeedOut;
  }

  /**
   * The integration blew up (a non-finite or impossible state: see `VehiclePhysics.stateIsSane`) or the car fell
   * through the world, e.g. launched over a barrier where there is no ground: put it back on the track, stopped, at
   * the last good position. True if it did.
   */
  private recoverIfLost(): boolean {
    const v = this.vehicle;
    const s = Number.isFinite(this.s) ? this.s : 0;
    const refSample = this.track.getSampleAtDistanceInto
      ? this.track.getSampleAtDistanceInto(s, _simSample)
      : this.track.getSampleAtDistance(s);
    if (v.stateIsSane() && v.position.y > refSample.position.y - LOST_BELOW_TRACK_M) return false;
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
      case 'STRAIGHT_MODE_AHEAD':
        c.straightModeAhead = { atMs: this.simTimeMs };
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

  /** The tyres' outer edges either side of the car's centre and its axles ahead and behind (`startPose`) */
  private startFootprint(): StartFootprint {
    const ch = this.config.chassis;
    const tyres = this.compoundData;
    return {
      halfWidthM: 0.5 * Math.max(ch.trackWidthFront + tyres.front.width, ch.trackWidthRear + tyres.rear.width),
      frontM: this.vehicle.cgToFrontM,
      rearM: this.vehicle.cgToRearM,
    };
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
    this.steerCmd = 0;
    this.lastRimSteer = null;
    this.shiftUpPending = this.shiftDownPending = this.neutralPending = false;
    this.tcCut = this.absCut = 1;
    this.absWheelCut.fill(1);
    for (let i = 0; i < 4; i++) this.prevWheelOmega[i] = this.vehicle.wheels[i].omega;
    this.apPedal = this.apYawI = this.apThrottle = this.trackI = 0;
    this.apLaunch = false;
    this.drsPressPending = false;
    this.boostRemainingS = 0;
    this.pushActive = this.overtakeInUse = this.overtakeAutoNow = this.ersBoostNow = false;
    this.overtake.reset();
    this.overtakeLap = 0;
    this.lastAxMs2 = this.lastAyMs2 = 0;
    this.chassisG = 1;
    this.stuckS = 0;
    // The off-track verdict belongs to where the car was: the new spot is judged afresh
    this.wasOffTrack = false;
    // So does the barrier contact: zeroed, on the page's car and the sim worker's alike (race control reads a drop as none)
    this.wallContactS = 0;
    const c = this.channels;
    c.wallContactS = 0;
    c.CHANGED_DRS_OPEN = false;
    c.drsOpenEvents = 0;
    c.drsDetection = null;
    c.straightModeAhead = null;
    c.overtakeDetection = null;
    c.drsQueued = false;
    c.wallImpact = null;
    this.syncPose();
    this.prevS = this.s;
    this.cutWatch.reset();
    this.lastSector = this.track.getSampleAtDistance(this.s).sector;
    this.updateTelemetry(null);
  }

  private applyColdPressures(): void {
    for (const w of this.vehicle.wheels) w.coldPressurePsi = pressureAt(this.coldPsi, w.isFront, w.isLeft);
    // At the temperature the gas is at now (blankets, the garage's air, or as the tyres were)
    this.vehicle.refreshTyrePressures();
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
    const p = this.track.projectWorldToTrackInto
      ? this.track.projectWorldToTrackInto(this.worldPosition.x, this.worldPosition.z, _simProj, this.poseHintS)
      : this.track.projectWorldToTrack(this.worldPosition.x, this.worldPosition.z, this.poseHintS);
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
      out.slideSpeedMs = w.fz > 0 ? Math.hypot(w.slipVelX, w.vy) : 0;
      out.lockShare = w.fz > 0 ? lockShareOf(w.slipVelX, w.vx) : 0;
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

  /** Sector / lap timing at the sector boundaries and the start / finish line (as the LC26) */
  private updateTiming(dtS: number): void {
    const L = this.track.totalLengthM;
    const sample = this.track.getSampleAtDistanceInto
      ? this.track.getSampleAtDistanceInto(this.s, _simSample)
      : this.track.getSampleAtDistance(this.s);
    // The lap position jumped further than a car drives in a frame: the car crossed to another part of the lap off its
    // road (another layout's, course-limits.ts). A sector boundary it jumped over is no sector driven, and a jump ahead
    // that stands cuts the lap under way
    const ds = wrapHalf(this.s - this.prevS, L);
    const hop = isCourseHop(ds);
    if (this.cutWatch.update(ds, dtS)) this.invalidateLap();
    if (sample.sector !== this.lastSector) {
      // Sectors 1 and 2 end at their boundaries; sector 3 ends at the line (onLapCompleted). The nearest sample turns
      // to sector 1 up to half a sample before the line, and ending sector 3 there too would cut it short by that much
      // (a slow car's sectors then miss the lap time by more than the board allows)
      if (!hop && sample.sector === this.lastSector + 1) this.onSectorCompleted(this.lastSector);
      this.lastSector = sample.sector;
    }
    const p2p = this.track.pointToPoint;
    if (p2p) {
      // A point-to-point course: the start line starts a run (again, when it is crossed again), the finish line ends it.
      // A run counts from a standing start: at rest within 10 m of the line first, without backing out of that 10 m box
      // before crossing (#191), or the run is timed but not valid
      if (this.prevS > L * 0.85 && this.s < L * 0.15) {
        // A jump before the start line is not the run's
        this.cutWatch.reset();
        this.lineCrossingStartsLap = false;
        this.runActive = true;
        this.lapStartMs = this.simTimeMs;
        this.sectorStartMs = this.simTimeMs;
        this.lapValid = this.atRestOnLine;
        this.telemetry.lapInvalid = !this.atRestOnLine;
        this.atRestOnLine = false;
      } else if (this.runActive && this.prevS < p2p.finishS && this.s >= p2p.finishS && this.s - this.prevS < 50) {
        // A jump ahead still pending at the finish is the run's
        if (this.cutWatch.settle()) this.invalidateLap();
        this.runActive = false;
        this.onLapCompleted();
      } else if (this.s >= L - 10) {
        if (Math.abs(this.vxMs) < 0.5) this.atRestOnLine = true;
      } else {
        this.atRestOnLine = false;
      }
    } else if (this.prevS > L * 0.85 && this.s < L * 0.15) {
      // A jump ahead still pending at the line is the lap's
      const cut = this.cutWatch.settle();
      if (this.lineCrossingStartsLap) {
        this.lineCrossingStartsLap = false;
        this.lapStartMs = this.simTimeMs;
        this.sectorStartMs = this.simTimeMs;
      } else {
        if (cut) this.invalidateLap();
        this.onLapCompleted();
      }
    }
    this.prevS = this.s;
  }

  private onSectorCompleted(sector: 1 | 2 | 3): void {
    const t = this.telemetry;
    const duration = this.simTimeMs - this.sectorStartMs;
    this.sectorStartMs = this.simTimeMs;
    if (duration > Math.min(8000, this.minLapMs / 5)) {
      t.sectorTimesMs[sector - 1] = duration;
      const best = t.bestSectorTimesMs[sector - 1];
      // A best sector only from a lap that still counts (and never Sector 1 of a forward-offset grid's shorter Lap 1)
      const shortSector1 = sector === 1 && this.shortStartLap;
      if (!shortSector1 && this.lapValid && (best === null || duration < best)) t.bestSectorTimesMs[sector - 1] = duration;
    }
  }

  private onLapCompleted(): void {
    const t = this.telemetry;
    const lapTime = this.simTimeMs - this.lapStartMs;
    const shortStart = this.shortStartLap;
    this.shortStartLap = false;
    this.onSectorCompleted(3);
    this.lapStartMs = this.simTimeMs;
    // Judged track limits: a lap that ends while an excursion is still being judged cannot count
    const valid = !shortStart && this.lapValid && !(this.trackLimitsMode === 'judged' && (this.trackLimitsHold || t.offTrack));
    if (lapTime > this.minLapMs) {
      t.lastLapTimeMs = lapTime;
      if (valid && (t.bestLapTimeMs === null || lapTime < t.bestLapTimeMs)) t.bestLapTimeMs = lapTime;
    }
    t.lastLapValid = valid;
    t.lapCount++;
    t.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.lapValid = true;
    t.lapInvalid = false;
  }

  /**
   * A lap (or a hill climb's run) quicker than this is no lap: 90 m/s on average, and never more than 45 s, which a
   * short layout's lap (Sachsenring's short course, 1.5 km) or a hill climb's run can take less than
   */
  private get minLapMs(): number {
    return Math.min(45_000, ((this.track.pointToPoint?.finishS ?? this.track.totalLengthM) / 90) * 1000);
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
    const sample = this.track.getSampleAtDistanceInto
      ? this.track.getSampleAtDistanceInto(this.s, _simSample)
      : this.track.getSampleAtDistance(this.s);
    const vx = this.vxMs;
    const speedKmh = Math.max(0, vx * 3.6);
    if (speedKmh > t.topSpeedThisLapKmh) t.topSpeedThisLapKmh = speedKmh;
    if (speedKmh > t.allTimeTopSpeedKmh) t.allTimeTopSpeedKmh = speedKmh;

    const surfaces = t.wheelSurfaces;
    for (let i = 0; i < 4; i++) surfaces[i] = surfaceType(W[i].ground.surface);
    const onKerbLeft = surfaces[0] === 'kerb' || surfaces[2] === 'kerb';
    const onKerbRight = surfaces[1] === 'kerb' || surfaces[3] === 'kerb';
    // All four wheels on surfaces the table does not count as the track (run-off, gravel, grass, sausage kerbs)
    // Judged on the wheels touching the road: an airborne wheel's ground is its last contact (the probe only reaches
    // 0.6 m), so a jump keeps the verdict it took off with rather than reading stale surfaces
    // Where another layout's road leaves the lap, this lap's road edge and kerbs are the limit: that road's asphalt and
    // kerbs past it are off the track (course-limits.ts)
    const fenced = inLapStretch(this.track.otherLayoutRoads, this.s, this.track.totalLengthM);
    let anyGrounded = false;
    let allOff = true;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      if (!w.grounded) continue;
      anyGrounded = true;
      const kind = w.ground.surface;
      if (!w.ground.props.validTrack) continue;
      if (fenced && (kind === 'road' || kind === 'kerb') && beyondLayoutEdge(sample, w.hardpointWorld.x, w.hardpointWorld.z)) continue;
      allOff = false;
    }
    const offTrack = anyGrounded ? allOff : this.wasOffTrack;
    this.wasOffTrack = offTrack;
    if (offTrack && this.trackLimitsMode === 'strict') this.lapValid = false;
    t.lapInvalid = !this.lapValid;
    t.outLap = this.lineCrossingStartsLap;
    let surface: SurfaceType = 'asphalt';
    if (onKerbLeft || onKerbRight) surface = 'kerb';
    else if (surfaces[0] === 'grass' || surfaces[1] === 'grass') surface = 'grass';
    else if (surfaces[0] === 'runoff' || surfaces[1] === 'runoff') surface = 'runoff';

    const mgukKw = vt.MGUK_POWER / 1000;
    let wheelKw = 0;
    for (let i = 0; i < 4; i++) wheelKw += (W[i].driveTorqueNm * W[i].omega) / 1000;
    const iceKw = Math.max(0, wheelKw - Math.max(0, mgukKw));
    const frontDf = (vt.downforceN * vt.AERO_BALANCE) / 100;

    t.speedMs = vx;
    t.speedKmh = speedKmh;
    t.rpm = Math.round(vt.rpm);
    t.gear = vt.gear;
    t.throttle = vt.throttle;
    t.brake = vt.brake;
    t.clutch = vt.clutchEngagement;
    t.clutchSlip = vt.clutchSlip;
    t.engineStalled = vt.engineStalled;
    t.steering = this.steerCmd;
    t.longitudinalG = this.lastAxMs2 / G;
    t.lateralG = -this.lastAyMs2 / G;
    t.verticalG = 1 + vt.downforceN / (v.totalMassKg * G);
    t.chassisVerticalG = this.chassisG;
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
    // The driven shafts: their mean speed and the torque they carry (negative on the overrun and under regeneration)
    const [shaftL, shaftR] = v.drivenWheels;
    t.driveshaftRadS = 0.5 * (W[shaftL].omega + W[shaftR].omega);
    t.driveshaftTorqueNm = W[shaftL].driveTorqueNm + W[shaftR].driveTorqueNm;
    if (this.profile.motorOnGearbox) {
      const gb = v.config.gearbox;
      const ratio = vt.gear > 0 ? gb.ratios[vt.gear - 1] * gb.finalDrive : vt.gear < 0 ? gb.reverse * gb.finalDrive : 0;
      // In gear the shaft turns with the wheels; out of gear the closed clutch turns it with the engine
      t.mguRpm = ratio > 0 ? (Math.abs(t.driveshaftRadS) * ratio * 30) / Math.PI : vt.rpm;
    }
    t.totalPowerKw = Math.max(0, iceKw + Math.max(0, mgukKw));
    t.ersBatteryPercent = vt.ERS_CHARGE * 100;
    // Push actually running (the override or the boost), not PSH picked in the tuner
    t.manualOverrideActive = this.pushActive;
    const rules2026 = this.config.ers.regulations === 'f1-2026' && this.profile.hasErs;
    t.ersBoostActive = rules2026 ? this.ersBoostNow : undefined;
    t.overtakeRace = rules2026 && this.rules === 'straight-mode-2026' && !!this.raceControl?.racing;
    t.overtakeInUse = t.overtakeRace && (this.overtakeInUse || this.overtakeAutoNow);
    t.overtakeAuto = t.overtakeRace && this.overtakeAutoNow;
    t.boostRemainingS = this.boostRemainingS;
    t.overtakingRules = this.profile.hasDrs ? this.rules : undefined;
    t.overtakeAvailable = this.profile.hasErs && this.overtakeAvailable && !(this.rules === 'straight-mode-2026' && this.lowGrip);
    t.lowGrip = rules2026 ? this.rules === 'straight-mode-2026' && this.lowGrip : undefined;
    t.turboBoostBar = this.profile.turbo ? Math.round(v.turboBoostBar * 100) / 100 : 1;
    t.fuelKg = Math.round(this.fuelKg * 100) / 100;

    const hits = (t.wheelKerbHit ??= [0, 0, 0, 0]);
    const hitHz = (t.kerbHitHz ??= [0, 0]);
    v.readKerbHits(hits, hitHz);
    const evoGrip = v.trackEvolution.gripMultiplier;
    const frontRhMm = Math.round(vt.aeroHeightFront * 1000);
    const rearRhMm = Math.round(vt.aeroHeightRear * 1000);
    const flatSpots = (t.tireFlatSpotSeverity ??= [0, 0, 0, 0]);
    const grains = (t.tireGrainLevel ??= [0, 0, 0, 0]);
    const blisters = (t.tireBlisterLevel ??= [0, 0, 0, 0]);
    const dirts = (t.tireDirtyLevel ??= [0, 0, 0, 0]);
    const pressuresPsi = (t.tirePressuresPsi ??= [0, 0, 0, 0]);
    const brakeCores = (t.brakeCoreTempsC ??= [380, 380, 380, 380]);
    const padMus = (t.brakePadMuFactor ??= [1, 1, 1, 1]);
    const slipRats = (t.wheelSlipRatios ??= [0, 0, 0, 0]);
    const slipAngs = (t.wheelSlipAnglesDeg ??= [0, 0, 0, 0]);
    const suspVel = (t.suspensionVelocityMs ??= [0, 0, 0, 0]);
    const bandTemps = (t.tireBandTempsC ??= [
      [70, 70, 70],
      [70, 70, 70],
      [70, 70, 70],
      [70, 70, 70],
    ]);

    for (let i = 0; i < 4; i++) {
      const w = W[i];
      t.tireSlipRatio[i] = w.combinedSlip;
      slipRats[i] = w.slipRatio;
      slipAngs[i] = w.slipAngleRad * RAD2DEG;
      t.wheelLoadsN[i] = Math.round(w.fz);
      t.wheelRideHeightsMm[i] = w.isFront ? frontRhMm : rearRhMm;
      t.suspensionTravelMm[i] = Math.round(w.compression * 100000) / 100;
      suspVel[i] = w.compressionVel;
      t.tireTempsC[i] = Math.round(0.6 * w.surfaceTempC + 0.4 * w.coreTempC);
      t.tireWearPct[i] = Math.round(w.wear * 100);
      // Inner / middle / outer surface temperatures, listed left → right as seen from behind (left tyres: O / M / I)
      const b0 = Math.round(w.bandTempsC[0]);
      const b1 = Math.round(w.bandTempsC[1]);
      const b2 = Math.round(w.bandTempsC[2]);
      const bt = bandTemps[i];
      if (w.isLeft) {
        bt[0] = b2;
        bt[1] = b1;
        bt[2] = b0;
      } else {
        bt[0] = b0;
        bt[1] = b1;
        bt[2] = b2;
      }
      flatSpots[i] = Math.round(w.flatSpotSeverity * 1000) / 1000;
      grains[i] = Math.round(w.grainLevel * 1000) / 1000;
      blisters[i] = Math.round(w.blisterLevel * 1000) / 1000;
      dirts[i] = Math.round(w.dirtyLevel * 1000) / 1000;
      pressuresPsi[i] = Math.round(w.pressurePsi * 10) / 10;
      t.tireGripFactor[i] = Math.round(w.thermalGrip * w.ground.grip * evoGrip * 100) / 100;
      t.brakeTempsC[i] = Math.round(w.brakeDisc.surfaceTempC);
      brakeCores[i] = Math.round(w.brakeDisc.coreTempC);
      padMus[i] = Math.round(w.brakeDisc.muFactor * 1000) / 1000;
    }
    const frontOpt = v.tyreOptimum(0);
    const rearOpt = v.tyreOptimum(1);
    const optPsi = (t.tireOptimalPsi ??= [frontOpt.psi, frontOpt.psi, rearOpt.psi, rearOpt.psi]);
    optPsi[0] = frontOpt.psi;
    optPsi[1] = frontOpt.psi;
    optPsi[2] = rearOpt.psi;
    optPsi[3] = rearOpt.psi;
    t.tireOptimalTempC = frontOpt.tempC;
    t.aeroWakeDownforceMult = Math.round(v.aeroWake.totalDownforceMultiplier * 1000) / 1000;
    t.aeroWakeDragMult = Math.round(v.aeroWake.dragMultiplier * 1000) / 1000;
    t.frontSlipAngleDeg = 0.5 * (slipAngs[0] + slipAngs[1]);
    t.rearSlipAngleDeg = 0.5 * (slipAngs[2] + slipAngs[3]);
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
    t.targetCornerSpeedKmh = Math.round(sampleProfile(guide.speedMs, this.s, this.track.totalLengthM) * 3.6);
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
    c.drsQueued = vt.drsQueued;
    for (let i = 0; i < 4; i++) c.circleFraction[i] = vt.circleFraction[i];
    c.performanceMode = v.performanceMode;
    c.tcActive = this.tcCut < 0.98;
    c.absActive = this.absCut < 0.98;
    c.wallContact = vt.wallContact;
    c.wallContactS = this.wallContactS;
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
      chassisVerticalG: 1,
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
