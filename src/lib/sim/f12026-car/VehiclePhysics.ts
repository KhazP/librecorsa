/**
 * f12026-car vehicle dynamics (`VehiclePhysics`).
 *
 * A data-driven 6-DOF rigid-body car on the Three.js track colliders (see `F12026CarConfig.ts` for the
 * structures and values).
 *
 * Model (fixed 500 Hz outer step, 4 × 2 kHz sub-steps):
 * - Body:        6-DOF sprung body (quaternion attitude, world-frame angular velocity, body-frame inertia).
 *                Hubs ride with the body horizontally, so horizontal translation uses the total mass; the
 *                unsprung masses' own inertia reaches the tyres along the hub's path (the solved wishbones).
 * - Contact:     each corner probes the ground straight down through a `GroundQuery`
 *                (`TrackColliderQuery` on `Track_Collider_Road` + the `userData.surface` meshes) at five points
 *                over its contact patch, folded into an enveloped road height and plane normal
 *                (`ContactPatch.ts`); the centre gives `surface` and `grip`.
 * - Suspension:  pull-rod double wishbones solved from their hardpoints (camber, steer with Ackermann and bump
 *                steer; tyre forces reach the body through the link geometry: roll centre, jacking, anti-dive,
 *                anti-squat, anti-lift): main spring in series with a helper (`helper_rate` /
 *                `helper_range`), bump rubbers after `BumpStopSettingsUnits.range` (`BUMPSTOPUP_TRAVEL_*`),
 *                droop limiter, ARBs, heave spring + packers (double-wishbone configurations),
 *                4-way `DamperControllerData` (base corner + heave / roll / pitch mode dampers).
 * - Unsprung:    4 hub masses on the tyre's radial spring (`pressureSpringCurve` × `thermalVerticalK`).
 * - Tyres:       load-sensitive normalised-slip model on the `TyresModelData` fields (`Dy0`, `Dx0`,
 *                `lsExpY`, `lsExpX`, `Fz0`, `friction_limit_angle`, `slip_ratio_limit`). The cornering
 *                stiffness saturates with load (Pacejka `pKy2`), so the peak slip angle grows with load and the
 *                lateral relaxation length follows the stiffness. Slip ratio
 *                (`WHEEL_SR_*`) and slip angle come from relaxation-length carcass states. Camber thrust
 *                (`camberGain`, `contact_camber_c1/c2`) enters as an equivalent slip-angle shift, camber
 *                grip from `dcamber0/1` (lateral) and `dcamber0_x/1_x` (longitudinal). Fx / Fy come from
 *                friction-ellipse combined slip (the normalised slip vector, optional `new_combined` SA/SR cross
 *                terms, optional `use_slip_falloff` past-peak decay). `circleFraction` is a telemetry output only.
 *                Grip × `userData.grip`. One thermal model: 3 bands (I/M/O) × 2 nodes (tread surface / carcass);
 *                grip and flash temperature from the surfaces (compound performance curve), ideal-gas pressure
 *                and carcass stiffness (radial and cornering) from the carcass.
 * - Aero:        front wing, venturi floor and rear wing: `lutAOA_CL/CD(angle)` × `lutGH_CL/CD_mult(ride
 *                height)`, forces at each element's centre of pressure; DRS scales the rear wing.
 * - Power unit:  ICE power curve + MGU-K (`torqueLut` / `coastLut`, 120 kW, 4 MJ store, per-lap limits),
 *                5 performance modes, brake-by-wire on the rear axle.
 * - Drivetrain:  8-speed seamless gearbox, auto clutch, ramp LSD; engine, clutch, diff and brakes are
 *                solved together as velocity constraints each sub-step (no stiff explicit couplings).
 *
 * Frames: Three.js world (Y up). Body axes: +X left, +Y up, +Z forward (same basis as F1Physics2026's
 * car quaternion). Wheel order everywhere: 0 LF, 1 RF, 2 LR, 3 RR.
 */

import * as THREE from 'three';
import { Lut, type LutPoints } from '../lut';
import {
  CLUTCH_BITE_LOCK,
  CLUTCH_BITE_START,
  clutchPedalEngagement,
  StallController,
  stallSpeedRpm,
} from '../stall-controller';
export { CLUTCH_BITE_LOCK, CLUTCH_BITE_START, clutchPedalEngagement };
import { tyreColdPressureForGas, tyreGaugePressureOfGas } from '../tyre-pressure';
import {
  advanceTreadDirt,
  flatSpotVibrationNm,
  tyreCentrifugalGrowthM,
  wearGripMultiplier,
} from '../ac-tyre';
import {
  buildDoubleWishboneHardpoints,
  createAxleKinematicsState,
  type DoubleWishboneHardpoints,
  solveAxleKinematics3D,
} from '../suspension-kinematics';
import {
  type BrakeCompoundKind,
  type BrakePadMuCurve,
  type BrakeDiscState,
  computeDynamicBrakeMigration,
  createBrakeDiscState,
  defaultDiscThicknessMm,
  resetBrakeDiscState,
  stepBrakeDiscThermal,
} from '../brake-physics';
import {
  type AeroWakeState,
  CLEAN_AIR_WAKE_STATE,
  DEFAULT_AERO_WAKE,
  evaluateRollAeroFactor,
} from '../aero-wake';
import {
  DEFAULT_TRACK_EVOLUTION_SAMPLE,
  type TrackEvolutionSample,
} from '../track-evolution';
import {
  dynamicBristleRelaxationScale,
  evaluateWlfGripMultiplier,
  hydrodynamicDragN,
  isRearFlapAllowedInWet,
  rimWetEnvironmentCoolingWK,
  SLICK_TRAITS,
  surfaceWetMultiplier,
  wetExternalGasCoolingWK,
  wetGripFactor,
  wetHeatScale,
  wetnessFromWater,
  wetPneumaticTrailScale,
  wetRoadCoolingWK,
  wetWearScale,
} from '../wet-tyres';
import { FULL_REALISM, realismThermalGrip, type SimRealismFlags } from '../sim-realism';
import { surfaceDragN } from '../track-surfaces';
import { createKerbHitState, kerbHitLevel, stepKerbHit, type KerbHitState } from '../kerb-hits';
import {
  type AeroRideHeightMap,
  type AxleSuspensionData,
  type BumpStopSettingsUnits,
  type CarPhysicsConfig,
  blanketTempC,
  compoundData,
  DEFAULT_FRICTION_LIMIT_ANGLE_DEG,
  type DamperControllerData,
  type DamperSettingsUnits,
  type ExponentialPlankData,
  F12026_CAR_CONFIG,
  type PerformanceModeData,
  type PerformanceModeName,
  type PhysicsTyreCompound,
  type PowerSteeringData,
  type RimGasCavityThermalData,
  type SuspensionSettingUnits,
  suspensionSupportsHeave,
  type TyresCompoundData,
  type TyresPressureData,
  turboBoostAsked,
  turboSteadyBoost,
  type TyresThermalPatchData,
  type WingData,
  type ZoneData_DRSZone,
  racesOnBlankets,
} from './F12026CarConfig';
import {
  convexHullIndices,
  createGroundHit,
  createWallEndHit,
  createWallHit,
  type GroundHit,
  type GroundQuery,
  OUTLINE_EDGE_STRIDE,
  type TrackSurfaceKind,
  wallCornerContact,
  wallEndInOutline,
  type WallQuery,
  wallSweep,
  writeOutlineEdges,
} from './TrackColliderQuery';
import { queryContactPatch } from './ContactPatch';
import { CUT_ENERGY_MARGIN_J, DEPLOY_THROTTLE_START, Ers2026Control, ersValueSPerMJ, F1_2026_ERS } from './ers-2026';
import { type EnergySession, type F1EnergyCircuit, inStretch } from '../f1-energy-circuits';
import { type AutoShiftSchedule, autoShift, createAutoShiftInput, ManualShiftOverride } from '../auto-gearbox';
import {
  contactHalfLengthM,
  driverRackTorqueNm,
  kingpinMomentNm,
  PATCH_HALF_WIDTH_SHARE,
  PATCH_TWIST_DAMPING_S,
  patchTwistStiffness,
  spinFrictionArmM,
  stepPatchTwist,
} from './steering-torque';
import {
  brushForces,
  brushPeakSlipTan,
  brushRelaxationLength,
  brushSlipStiffness,
  brushSpeedGrip,
  createBrushTyre,
  type BrushForces,
  type BrushTyre,
} from './brush-tyre';
import { roadTextureHeightM } from '../road-texture';
import {
  FLAP_PRESS_MAX_WAIT_S,
  FLAP_PRESS_REACH_M,
  inDelayedLapWindow,
  type LapWindow,
  lapWindowFor,
  LOW_GRIP_ZONE_DELAY_M,
  mergeLapWindows,
  STRAIGHT_NOTICE_M,
} from '../straight-mode-zones';
import { beginSettle } from './settle-memo';

const G = 9.81;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const RPM2RADS = Math.PI / 30;
const RADS2RPM = 30 / Math.PI;
const SOLVER_ITERATIONS = 8;

/** Auto box: hold a new gear this long after an upshift before an off-brake downshift (s) */
const AUTO_DOWNSHIFT_HOLD_S = 1.0;
/** Auto box: under this share of the downshift point the engine lugs, and the box shifts down whatever the pedals */
const AUTO_LUG_SHARE = 0.65;
/** Auto box: brake pedal that counts as braking into a corner, and the least time between its downshifts (s) */
const AUTO_BRAKE_DOWNSHIFT_PEDAL = 0.3;
const AUTO_BRAKE_DOWNSHIFT_GAP_S = 0.25;
/** Probe start above the suspension hardpoint (m) */
const GROUND_PROBE_UP_M = 0.6;
/**
 * Least half-length of the contact patch the ground is sampled over (m): the 0.15 m patch rFactor 2 / LMU / iRacing
 * sample, kept by a lightly loaded tyre whose deflection chord would be shorter (see `ContactPatch.ts`)
 */
const CONTACT_PATCH_MIN_HALF_LENGTH_M = 0.075;
/** The tread's edges, as a share of the section width each side of centre (as ac-tyre's `sample5PointContactPatch`) */
const TREAD_HALF_WIDTH_SHARE = 0.42;
/** Placement: the ground under each tyre is looked for at most this far above the ground under the CG (m) */
const ROAD_ATTITUDE_PROBE_UP_M = 1.5;
/** Placement: steepest grade or camber the car is seated on (rad, ≈34°: Daytona's 31° turn banking) */
const ROAD_ATTITUDE_MAX_RAD = 0.6;
/** Steepest slope a contact patch's plane may take (rise over run): the grade or camber a car is seated on */
const CONTACT_MAX_SLOPE = Math.tan(ROAD_ATTITUDE_MAX_RAD);
/**
 * Past these the integration has blown up rather than the car crashed: 200 m/s is 720 km/h, and 40 rad/s is over six
 * turns a second (a barrel roll or a spin at speed stays under ≈15 rad/s)
 */
const BLOWN_UP_SPEED_MS = 200;
const BLOWN_UP_SPIN_RADS = 40;
/** Least climb per step over an abrupt rise (m), so a car at rest still settles onto a raised surface */
const STEP_CLIMB_MIN_M = 0.0005;
/** Droop limiter stiffness / damping (N/m, Ns/m) */
const DROOP_STOP_RATE = 1_000_000;
const DROOP_STOP_DAMP = 3000;
/** Low-speed contact damping (N per m/s per N of grip), faded out by LOW_SPEED_FADE_MS */
const LOW_SPEED_DAMPING = 0.3;
const LOW_SPEED_FADE_MS = 4;
/** Contact-patch / track-surface conductance while loaded (W/K) */
const ROAD_CONDUCTANCE = 30;
/** Heat conducted between neighbouring tyre bands (inner / middle / outer), through the tread and through the carcass (W/K) */
const BAND_TREAD_CONDUCTANCE = 2;
const BAND_CARCASS_CONDUCTANCE = 10;
/**
 * A brush tyre's graining / blistering per unit of (slip^gamma × grip × metres rolled × gain × °C outside the grip
 * curve's peak), and the graining worn off per unit of (grip × metres rolled × gain, × slip^gamma where the tread wears
 * it off only as it slides): full graining takes tens of minutes of hard work on a cold tyre
 */
const TREAD_CONDITION_RATE = 1e-6;
const GRAIN_WEAR_OFF_RATE = 5e-7;
/** Rolling speed from which a brush tyre's camber thrust is in full (m/s) */
const CAMBER_THRUST_FULL_MS = 3;

/**
 * Steering shake of a flat-spotted tyre (Nm): one thump per revolution, peaking as the most worn of its sectors comes
 * round to the road, at the size of the tyre model's flat-spot shake (`flatSpotVibrationNm` at its crest)
 */
export function flatSpotThumpNm(severity: number, rotationRad: number, omega: number, fz: number, sectorWear: ArrayLike<number>): number {
  if (severity <= 0.005) return 0;
  const n = sectorWear.length;
  let flat = 0;
  for (let i = 1; i < n; i++) if (sectorWear[i] > sectorWear[flat]) flat = i;
  const flatRad = ((flat + 0.5) / n) * 2 * Math.PI;
  return flatSpotVibrationNm(severity, Math.PI / 4, omega, fz) * Math.cos(rotationRad - flatRad);
}
/**
 * Rack torque that maps to full FFB output: the sum of both front tyres' moments about their kingpin axes (Nm). The
 * column sees it divided by the steering ratio (≈ 48 Nm on 12.6:1)
 */
const FFB_REFERENCE_NM = 600;
/**
 * Backward push at the contact patch per newton of a kerb's load hit (`kerb-hits.ts`): a tyre meeting an edge is pushed
 * back as well as up. Felt in the rack through the front tyres' scrub radius (`kingpinMomentNm`), as a kerb kicks a real
 * steering wheel
 */
const KERB_STRIKE_FX_PER_N = 0.35;
/**
 * Diff map blending: the pedal travel over which the brake hands the diff to its entry map and the throttle to its exit
 * map (a touch of brake is corner entry; power is committed from ≈ 40 % pedal), the road-wheel angle over which the lock
 * keeps a light pedal on the mid map (a fast corner's ≈ 1° to a medium-speed apex's ≈ 6°), and the speed band (km/h)
 * either side of the high-speed switch [est]
 */
const DIFF_BRAKE_PHASE = [0.02, 0.2] as const;
const DIFF_POWER_PHASE = [0.1, 0.4] as const;
const DIFF_TURNED_IN_DEG = [1, 6] as const;
const DIFF_HISPD_BLEND_KMH = 20;
/** Throttle pedal over which a four-wheel-drive car's centre coupling comes in: open off the throttle */
const AWD_THROTTLE_ENGAGE = 0.05;
/** Brake pedal by which the centre coupling has let go: an electronic coupling releases on the brakes (ABS) */
const AWD_BRAKE_RELEASE = 0.1;
/** Outer-step FFB samples kept per frame for the 500 Hz bridge (≈ one 60 Hz frame; the newest are kept) */
const FFB_SUBFRAME_MAX = 8;
/** Caster (mechanical) trail when the chassis data has none: keeps the wheel weighted once the pneumatic trail collapses */
const DEFAULT_FFB_MECHANICAL_TRAIL_M = 0.012;
/** Time constant of the steering-compliance angle (s) */
const STEER_COMPLIANCE_TAU_S = 0.015;
/** Plank / skid-block contact: stiffness (N/m), damping (Ns/m), sliding friction */
const PLANK_RATE = 2_000_000;
const PLANK_DAMP = 20_000;
const PLANK_FRICTION = 0.35;
/** The plank looks for its ground at most this far above itself (m): deeper than this it is meeting a step face, not riding on a surface */
const PLANK_PROBE_UP_M = 0.05;
/** The motor's largest share of the drive the spark-first cut reckons with (the rest is always the engine's) */
const SPARK_FIRST_MAX_MOTOR_SHARE = 0.25;

const _shaft: [number, number] = [0, 0];
/**
 * Engine and motor crank torque (Nm) under a regulated limit on the shaft power (`EngineData.outputPowerCap`, `capNm`
 * at the crank): the engine gives way to the motor's deployment, then the motor to the limit. `motorGivesWay`: the
 * motor gives way to the engine first instead. Written into a shared pair
 */
function underShaftLimit(ice: number, motor: number, capNm: number, motorGivesWay: boolean): [number, number] {
  if (ice + motor > capNm) {
    if (motorGivesWay && motor > 0) motor = Math.max(0, Math.min(motor, capNm - Math.max(0, ice)));
    ice = Math.max(Math.min(ice, 0), capNm - motor);
    motor = Math.min(motor, capNm - ice);
  }
  _shaft[0] = ice;
  _shaft[1] = motor;
  return _shaft;
}
/** Share of the engine's crank power that goes into its coolant [est] */
const COOLANT_HEAT_SHARE = 0.6;
/** Radiator conductance per garage step of opening, against the baseline [est] */
const COOLANT_RADIATOR_STEP = 0.12;
/** Coolant and block heat capacity as seconds of the baseline radiator's conductance: its warm-up time constant [est] */
const COOLANT_CAPACITY_S = 85;
const COOLANT_DERATE_FROM_C = 112;
/** Half the skid block's width, for its four contact corners (m) */
const PLANK_HALF_WIDTH_M = 0.15;
/** The exponential part of a skid's stiffness stops growing past this penetration (m), so a crash stays bounded */
const PLANK_EXP_CAP_M = 0.025;
/**
 * Barrier contact: restitution, the most rebound a hit can give (m/s: the barrier and the crash structure soak up
 * the rest, so a 300 km/h hit bounces the car back onto the track side, not across it), wall friction
 */
const WALL_RESTITUTION = 0.2;
const WALL_MAX_REBOUND_MS = 5;
const WALL_FRICTION = 0.5;
/** Wall ends and corners inside the outline resolved per sub-step (two posts met at once, one each) */
const WALL_END_PASSES = 2;
/** Clearance a barrier contact is resolved to, so the next step starts strictly on the near side (m) */
const WALL_SKIN_M = 0.001;
/**
 * The most the barrier contacts move the car in a sub-step (m/s × the sub-step): more than the outline can go into a
 * wall in one (100 m/s). A contact is only deeper when the wall was not there a moment before (one whose height band
 * the car has just come into on a slope, a placement on it): that overlap is let out over a few sub-steps, not in a jump
 */
const WALL_MAX_PUSH_MS = 100;
/** Height band around a wall segment's own height range that still counts as touching it (m) */
const WALL_Y_SLACK_M = 0.3;
/** Impact speed (m/s) that raises a `WALL_IMPACT` event */
const WALL_IMPACT_EVENT_MS = 2;
/** A hit this much harder than the step's hardest so far, while already touching, is a new impact (m/s) */
const WALL_IMPACT_HARDER_MS = 4;

export const WHEEL_NAMES = ['LF', 'RF', 'LR', 'RR'] as const;
export type WheelName = (typeof WHEEL_NAMES)[number];

export interface VehicleInputs {
  /** Pedals 0..1 */
  throttle: number;
  brake: number;
  /**
   * Share of the drive torque the ECU lets through by cutting spark and fuel, and the MGU-K's with it (0..1: traction
   * control). Acts at once, unlike the pedal, whose torque waits on the air path. Omitted = 1
   */
  ignitionCut?: number;
  /** Per-wheel brake pressure share 0..1 (LF, RF, LR, RR) after a per-wheel ABS; omitted = 1 */
  brakeWheelScale?: readonly [number, number, number, number];
  /** Steering −1..1, + = right */
  steer: number;
  /** Clutch pedal 0..1 (1 = fully open); omitted = auto clutch */
  clutch?: number;
  /** Handbrake 0..1, on the rear wheels of a car that has one (`BrakesData.handbrakeTorqueNm`) */
  handbrake?: number;
  /** Edge-triggered */
  shiftUp?: boolean;
  shiftDown?: boolean;
  /**
   * Edge-triggered: out of gear, the engine free of the wheels. It wins over a shift in the same step; the next shift
   * (or the auto box on the throttle) puts a gear back in
   */
  neutral?: boolean;
  /** DRS button (edge-triggered toggle) */
  drs?: boolean;
}

export type VehicleEvent =
  | { type: 'CHANGED_DRS_OPEN'; open: boolean }
  | { type: 'CHANGED_PERFORMANCE_MODE'; mode: PerformanceModeName }
  | { type: 'GEAR'; gear: number }
  /** Crossed a `ZoneData_DRSZone` detection point; `eligible` = DRS may open in that zone */
  | { type: 'DRS_DETECTION'; zone: string; eligible: boolean }
  /**
   * A car whose flaps open on every straight (2026 Straight Mode, no detection) came within `STRAIGHT_NOTICE_M` of
   * one, or left the one before it when that ends nearer
   */
  | { type: 'STRAIGHT_MODE_AHEAD' }
  /** Started touching a barrier at `speedMs` into the wall */
  | {
      type: 'WALL_IMPACT';
      speedMs: number;
      /** Where the hardest-hit point was, in the car frame (m, + left / + forward) */
      localX: number;
      localZ: number;
    };

export interface VehiclePhysicsOptions {
  ground: GroundQuery;
  config?: CarPhysicsConfig;
  compound?: PhysicsTyreCompound;
  performanceMode?: PerformanceModeName;
  /** Air density (kg/m³); defaults to the config's */
  airDensity?: number;
  ambientC?: number;
  trackTempC?: number;
  drsZones?: ZoneData_DRSZone[];
  /**
   * Stretches of the lap (fractions) where the flaps may open as well as in `drsZones`, for a car whose zones are not
   * gated by detection (2026 Straight Mode: every straight). They have no detection point.
   */
  straightZones?: readonly { start: number; end: number }[];
  /**
   * Lap progress (0..1) of a world point. With it, DRS only opens inside a zone after crossing that
   * zone's detection point; without it DRS is allowed anywhere and lap energy never resets.
   */
  locateProgress?: (x: number, z: number) => number;
  /**
   * The lap's length (m) `locateProgress` measures: with it a press of the flap button before a zone is kept for it
   * (`FLAP_PRESS_REACH_M`) and a 2026 car is told of each straight ahead. Without it a press only acts where the
   * flaps may open at once
   */
  lapLengthM?: number;
  /** Asked at each detection point whether DRS is earned (e.g. within 1 s of the car ahead); default yes */
  drsEligibleAtDetection?: (zone: ZoneData_DRSZone) => boolean;
  /** Race control shuts the flaps here whatever the zone says (a yellow flag under the open-wheel rules) */
  flapsBarred?: () => boolean;
  /** Barrier walls (`Track_Collider_Wall_*`); none = no barriers */
  walls?: WallQuery;
  /**
   * The plan of the body this car wears when it is not the vehicle model's own (another car's body on the same
   * physics): as `ChassisData.bodyPlan`, in its place
   */
  bodyPlan?: readonly (readonly [number, number])[];
  onEvent?: (event: VehicleEvent) => void;
}

export interface WheelState {
  name: WheelName;
  isFront: boolean;
  isLeft: boolean;
  /** Suspension hardpoint in the body frame (m) */
  hardpoint: THREE.Vector3;
  hardpointWorld: THREE.Vector3;
  hardpointVel: THREE.Vector3;
  ground: GroundHit;
  grounded: boolean;
  /** Last full collider query plane reference point (for plane-projected reuse across AI substeps) */
  groundRefX: number;
  groundRefY: number;
  groundRefZ: number;
  /** Height the tyre has climbed to: rolls over an abrupt rise along its contact arc instead of jumping it (m) */
  contactY: number;
  /** Hub centre height (world Y) and vertical velocity */
  hubY: number;
  hubVy: number;
  /** Hub-to-hardpoint distance along the strut at static ride height (m) */
  staticHubDist: number;
  /** Spring deflection at static ride height (m) */
  springPreload: number;
  /** Compression from static (m, + = bump) and its rate (m/s) */
  compression: number;
  compressionVel: number;
  /** Net suspension force on the body at this corner (N, + = up) */
  suspensionForce: number;
  /** Remaining travel to the bump rubber (m) — `BUMPSTOPUP_TRAVEL_*` */
  bumpStopTravel: number;
  /** Tyre radial deflection (m), loaded radius and effective rolling radius (m) */
  deflection: number;
  loadedRadius: number;
  rollingRadius: number;
  /** Contact-patch half-length from the deflection (m) */
  patchHalfLengthM: number;
  /** Tyre radial stiffness (N/m) */
  verticalRate: number;
  fz: number;
  /** What the road's shape does to the tyre (`kerb-hits.ts`) */
  kerbHit: KerbHitState;
  fx: number;
  fy: number;
  /** Self-aligning moment about the contact normal (Nm) */
  mz: number;
  /** Moment of the patch twisted against the road about the contact normal (Nm): the parking torque */
  mzTwist: number;
  /** Front wheel's gyroscopic torque about its steering axis (N·m), added to the rack (0 on the rears) */
  gyroSteerNm: number;
  /**
   * Patch twist (rad, + = wheel turned left of the rubber held by the road), and the toe / compliance share of the
   * steer angle it was last wound from (the driver's share comes in as a rate)
   */
  twistRad: number;
  twistSteerRad: number;
  /** Overturning moment Mx (Nm) from lateral contact patch shift */
  mx: number;
  /** Spin (rad/s) and accumulated visual rotation (rad) */
  omega: number;
  rotationRad: number;
  /** Road-wheel steer (rad, + = left) */
  steerRad: number;
  /** Toe the steering geometry adds to the rack's nominal angle: Ackermann, bump steer and damage toe (rad, + = toe-in) */
  toeRad: number;
  /** Steering-compliance angle given up to the lateral force (rad, filtered) */
  complianceRad: number;
  /** Kinematic caster trail (m) */
  casterTrailM: number;
  /** Kinematic kingpin scrub radius (m) */
  scrubRadiusM: number;
  /** Relaxed slip ratio (`WHEEL_SR_*`) and tan(slip angle) */
  slipRatio: number;
  tanSlipAngle: number;
  slipAngleRad: number;
  /** Slip angle of this tyre's peak lateral force at its present load (rad; held while unloaded, 0 until loaded) */
  peakSlipAngleRad: number;
  /** Lateral force per unit tan(slip angle) at small slip, with every grip scaling as it is now (N; 0 unloaded) */
  corneringStiffness: number;
  /** Normalised combined slip (1 = peak) and share of the friction circle in use (telemetry; 1 = on the circle) */
  combinedSlip: number;
  circleFraction: number;
  /** Camber leaning toward +left relative to the road (rad) */
  camberLeftRad: number;
  /** Effective lateral / longitudinal friction coefficients */
  muY: number;
  muX: number;
  thermalGrip: number;
  /** Contact-patch velocities in the wheel frame (m/s) */
  vx: number;
  vy: number;
  slipVelX: number;
  /** Tread surface temperature (°C): the bands' surfaces weighted by contact pressure (derived, see `bandTempsC`) */
  surfaceTempC: number;
  /** Carcass (core) temperature (°C): the bands' mean core; inflation gas, carcass stiffness (derived) */
  coreTempC: number;
  /** Inner, Middle, Outer surface band temperatures (°C): the tread surface nodes (flash heat, the road's touch) */
  bandTempsC: [number, number, number];
  /** Inner, Middle, Outer tread-bulk temperatures (°C): the layer under the surface, where most of the grip lives */
  bandCarcassTempsC: [number, number, number];
  /** Inner, Middle, Outer carcass-liner temperatures (°C): the layer the inflation gas touches */
  bandCoreTempsC: [number, number, number];
  /** Inner, Middle, Outer share of the contact pressure (and of the heat), summing to 1 */
  bandLoadShares: [number, number, number];
  /** Wheel rim and inflation gas temperatures (°C): the gas's sets the pressure */
  rimTempC: number;
  gasTempC: number;
  /** 16-sector circumferential surface temperature grid (°C) */
  circumferentialTempsC: Float32Array;
  /** 16-sector circumferential wear depth grid (0..1) */
  circumferentialWear: Float32Array;
  /** Overall tread wear (0..1) */
  wear: number;
  /** Localized flat-spot severity (0..1) */
  flatSpotSeverity: number;
  /** Surface graining level (0..1) */
  grainLevel: number;
  /** Carcass blistering level (0..1) */
  blisterLevel: number;
  /** Off-track dirt / marble pickup level (0..1) */
  dirtyLevel: number;
  /** Physical 2-node brake disc thermal & pad state */
  brakeDisc: BrakeDiscState;
  /** Setup inflation pressure at the compound's coldRefC blanket temperature (psi gauge) */
  coldPressurePsi: number;
  /** Current inflation pressure (psi gauge) */
  pressurePsi: number;
  brakeTorqueNm: number;
  driveTorqueNm: number;
}

export interface VehicleTelemetry {
  speedKmh: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  clutchEngagement: number;
  /** Normalized clutch slip intensity (0..1) while partially engaged with engine/wheel speed difference */
  clutchSlip: number;
  /** True when the engine has stalled under manual clutch */
  engineStalled: boolean;
  /** Body-frame accelerations (g): + forward, + left */
  lonG: number;
  latG: number;
  WHEEL_SPEED_LF: number;
  WHEEL_SPEED_RF: number;
  WHEEL_SPEED_LR: number;
  WHEEL_SPEED_RR: number;
  WHEEL_SR_LF: number;
  WHEEL_SR_RF: number;
  WHEEL_SR_LR: number;
  WHEEL_SR_RR: number;
  /** Slip angles (deg) */
  SLIP_ANGLE_LF: number;
  SLIP_ANGLE_RF: number;
  SLIP_ANGLE_LR: number;
  SLIP_ANGLE_RR: number;
  BUMPSTOPUP_TRAVEL_LF: number;
  BUMPSTOPUP_TRAVEL_RF: number;
  BUMPSTOPUP_TRAVEL_LR: number;
  BUMPSTOPUP_TRAVEL_RR: number;
  tyreLoadN: [number, number, number, number];
  circleFraction: [number, number, number, number];
  surface: [TrackSurfaceKind, TrackSurfaceKind, TrackSurfaceKind, TrackSurfaceKind];
  surfaceGrip: [number, number, number, number];
  camberDeg: [number, number, number, number];
  tyreSurfaceTempC: [number, number, number, number];
  tyreCoreTempC: [number, number, number, number];
  /** Current inflation pressures (psi gauge), LF / RF / LR / RR */
  tyrePressurePsi: [number, number, number, number];
  /** Floor heights (m): mean, front axle, rear axle */
  AERO_HEIGHT: number;
  aeroHeightFront: number;
  aeroHeightRear: number;
  /** Front share of downforce (%) */
  AERO_BALANCE: number;
  downforceN: number;
  dragN: number;
  /** ES state of charge (0..1), stored energy (J), limits */
  ERS_CHARGE: number;
  ERS_CURRENT_CHARGE: number;
  ERS_MAX_CHARGE: number;
  ERS_MAX_DEPLOY: number;
  /** MGU-K mechanical power (W, + = deploy, − = harvest) */
  MGUK_POWER: number;
  ERS_CHARGING: boolean;
  lapDeployJ: number;
  lapHarvestJ: number;
  performanceMode: PerformanceModeName;
  DRS: number;
  drsOpen: boolean;
  drsZone: boolean;
  /** Inside a zone whose detection point was crossed eligibly: the DRS button will open the flap */
  drsAvailable: boolean;
  /** A press of the button waits for the zone the car is on or coming to (`FLAP_PRESS_REACH_M`) */
  drsQueued: boolean;
  /** Body touching a barrier this step, and the highest speed into it (m/s) */
  wallContact: boolean;
  wallImpactMs: number;
  LSD_LOCKING_TORQUE: number;
  brakeBias: number;
  ffbTorqueNorm: number;
  compound: PhysicsTyreCompound;
}

interface AxleRuntime {
  spec: AxleSuspensionData;
  dampers: DamperControllerData;
  heaveActive: boolean;
  /**
   * Axle heave from static (m, + = bump) at which the heave element is at its free length. Below static when it carries
   * its share of the car's weight there (see computeStaticGeometry), so its rate runs on through static ride height
   */
  heaveFreeM: number;
  unsprungMass: number;
  wheelInertia: number;
}

interface WingRuntime {
  spec: WingData;
  aoaCl: Lut;
  aoaCd: Lut;
  ghCl: Lut;
  ghCd: Lut;
  /** Body yaw (|deg|) → CL / CD multipliers; null = insensitive */
  yawCl: Lut | null;
  yawCd: Lut | null;
}

export interface TyreRuntime {
  data: TyresCompoundData;
  thermal: Lut;
  /** Lateral grip against camber (degrees, negative leaning into the force) when the compound gives it as a table */
  camberLut: Lut | null;
  pressureSpring: Lut;
  /** tan(peak slip angle) at Fz0; at other loads see `tyrePeakSlipTan` */
  tanPeakAngle: number;
  /** Pacejka pKy2 (`TyresModelData.pKy2`) and the peak lateral force at Fz0 (N, before temperature, wear, water…) */
  pKy2: number;
  peakForceY0: number;
  peakSlipRatio: number;
  /** Magic-formula shape: y = sin(C·atan(B·s)), peak 1 at s = 1 */
  B: number;
  C: number;
  useFalloff: boolean;
  falloffLevel: number;
  falloffSlope: number;
  /** Camber beyond which the cubic thrust is held at its peak (rad) */
  camberThrustLimit: number;
  /** Reference load of this axle's tyre (N) */
  fz0: number;
  /** Load (N) → peak μ tables, when the compound has them */
  dyCurve: Lut | null;
  dxCurve: Lut | null;
  brakeDxMod: number;
  /** Core temperatures (°C) at which the compound grains, cleans up and blisters (`tyreGrainThresholdsC`) */
  grain: { grainBelow: number; healFrom: number; healTo: number; blisterAbove: number };
  /** The brush family's constants when the compound is a brush tyre (`TyresModelData.curve`), else null */
  brush: BrushTyre | null;
  /** Core temperatures (°C) between which the grip curve is at its peak: a brush tyre grains below, blisters above */
  peakWindowC: [number, number];
  /**
   * Size of this axle's tyre over the front's (tread width × radius): the compound's heat capacities and cooling are
   * stated for the front tyre, and a wider rear holds and sheds heat in proportion
   */
  thermalSize: number;
  /** The compound's own wear curve (km slid → grip, 1 = new) and the distance at which it is worn out; null: generic wear */
  wearCurve: Lut | null;
  wearOutKm: number;
  /** The three rubber layers (front-tyre size; × `thermalSize` per axle): `TyresThermalPatchData`'s with its defaults */
  layers: TyreLayers;
  /** Rim and gas (`RimGasCavityThermalData`), a typical racing wheel's where the compound's data gives none */
  rimGas: Required<RimGasCavityThermalData>;
}

interface TyreLayers {
  cSurf: number;
  cSub: number;
  cCore: number;
  g12: number;
  g23: number;
  fricToSub: number;
  rollToSub: number;
}

/** A racing wheel and tyre cavity where a car's data gives none [est] */
export const RIM_GAS_DEFAULTS: Readonly<Required<RimGasCavityThermalData>> = {
  rimHeatCapacityJK: 4600,
  rimBrakeOverlapAreaM2: 0.07,
  discToRimEmissivity: 0.58,
  discToRimConvectionWK: [2.8, 0.08],
  rimToAmbientConvectionWK: [6.5, 0.52],
  rimToGasConductanceWK: 16.5,
  carcassToGasConductanceWK: 22,
  gasHeatCapacityJK: 52,
  carcassVolumeStretchPerPsi: 0.0018,
};

/** The three layers of a compound's thermal data: the tread's bulk added over the carcass liner, by default */
function tyreLayers(th: TyresThermalPatchData): TyreLayers {
  return {
    cSurf: th.surfaceHeatCapacity,
    cSub: th.subsurfaceHeatCapacity ?? 0.62 * th.coreHeatCapacity,
    cCore: th.coreHeatCapacity,
    g12: th.surfaceToSubsurfaceTransfer ?? 2.2 * th.surfaceToCore,
    g23: th.subsurfaceToCoreTransfer ?? 1.4 * th.surfaceToCore,
    fricToSub: th.frictionHeatToSubsurface ?? 0.22,
    rollToSub: th.rollingHeatToSubsurface ?? 0.6,
  };
}

/** Main spring in series with a helper that goes coil-bound after `helper_range` */
export function springForce(deflection: number, s: SuspensionSettingUnits): number {
  if (deflection <= 0) return 0;
  const km = s.wheel_rate;
  const kh = s.helper_rate;
  if (kh <= 0 || s.helper_range <= 0) return km * deflection;
  const ks = (km * kh) / (km + kh);
  const bound = (s.helper_range * kh) / ks;
  return deflection <= bound ? ks * deflection : ks * bound + km * (deflection - bound);
}

/** Deflection that produces `force` (inverse of `springForce`) */
export function springDeflectionFor(force: number, s: SuspensionSettingUnits): number {
  if (force <= 0) return 0;
  const km = s.wheel_rate;
  const kh = s.helper_rate;
  if (kh <= 0 || s.helper_range <= 0) return force / km;
  const ks = (km * kh) / (km + kh);
  const bound = (s.helper_range * kh) / ks;
  return force <= ks * bound ? force / ks : bound + (force - ks * bound) / km;
}

/** Two-stage damper: slow rate up to the knee, fast rate beyond (v + = bump); rebound may have its own knee */
export function damperForce(d: DamperSettingsUnits, v: number, knee: number, reboundKnee = knee): number {
  if (v >= 0) return d.slow_bump * Math.min(v, knee) + d.fast_bump * Math.max(0, v - knee);
  return -(d.slow_rebound * Math.min(-v, reboundKnee) + d.fast_rebound * Math.max(0, -v - reboundKnee));
}

/** Load sensitivity of a contact strip's grip: μ ∝ Fz^this, against the strip's share of an even load */
const STRIP_LOAD_SENSITIVITY = -0.085;

/**
 * Grip of a contact patch whose strips carry `sh` of the load, against the same patch loaded evenly (1 when even): each
 * strip carries 3 × its share of an even strip's load, and grips by μ ∝ Fz^−0.085 at it, weighted by its share and its
 * temperature grip `g0..g2` (`thermalRaw` their weighted sum)
 */
export function stripLoadGrip(sh: ArrayLike<number>, g0: number, g1: number, g2: number, thermalRaw: number): number {
  if (thermalRaw <= 0) return 1;
  const e = STRIP_LOAD_SENSITIVITY;
  const sum = sh[0] * g0 * Math.pow(3 * sh[0], e) + sh[1] * g1 * Math.pow(3 * sh[1], e) + sh[2] * g2 * Math.pow(3 * sh[2], e);
  return sum / thermalRaw;
}

/** Shift of the contact pressure onto the inner strip per radian of camber leaning toward the car, and its limit */
const STRIP_CAMBER_SHIFT = 6.5;
const STRIP_CAMBER_SHIFT_MAX = 0.26;
/** Shift onto the middle strip per metre of the belt's centrifugal growth, and its limits (− unloads the middle) */
const STRIP_CENTRIFUGAL_CROWN_PER_M = 12;
const STRIP_CROWN_MIN = -0.2;
const STRIP_CROWN_MAX = 0.22;

/**
 * The inner / middle / outer strips' shares of a contact patch's load (summing to 1) into `out`. Camber leaning toward
 * the car (`camberInRad` > 0, negative camber) moves load onto the inner strip; inflation over the optimum, by the
 * compound's `crownGain`, and the belt's centrifugal growth crown the tread onto the middle strip, under-inflation
 * moves it onto the shoulders. Cornering moves the load only through the camber the roll and the uprights give the
 * wheel
 */
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (x: number, min: number, max: number): number => {
  if (x <= min) return 0;
  if (x >= max) return 1;
  const t = (x - min) / (max - min);
  return t * t * (3 - 2 * t);
};
const ENGINE_MAP_TORQUE_SCALE = [1.0, 0.985, 0.96, 0.925, 0.87] as const;
const DEFAULT_BRAKE_MIGRATION = { amount: 0.015, rampStart: 0 } as const;

export function computeBandLoadShares(
  out: [number, number, number],
  camberInRad: number,
  pressurePsi: number,
  optimalPsi: number,
  crownGain: number,
  growthM: number
): void {
  const dCam = clamp(camberInRad * STRIP_CAMBER_SHIFT, -STRIP_CAMBER_SHIFT_MAX, STRIP_CAMBER_SHIFT_MAX);
  const pRel = optimalPsi > 0 ? (pressurePsi - optimalPsi) / optimalPsi : 0;
  const dCrown = clamp(crownGain * pRel + STRIP_CENTRIFUGAL_CROWN_PER_M * growthM, STRIP_CROWN_MIN, STRIP_CROWN_MAX);
  const s1 = clamp(1 / 3 + dCrown, 0.14, 0.62);
  const s0 = clamp((1 - s1) / 2 + dCam, 0.06, 0.8);
  const s2 = Math.max(0.06, 1 - s0 - s1);
  const sum = s0 + s1 + s2;
  out[0] = s0 / sum;
  out[1] = s1 / sum;
  out[2] = s2 / sum;
}

/** cot of a diff ramp angle (deg), the ramp held to 5° at least */
const cot = (deg: number): number => 1 / Math.tan(Math.max(5, deg) * DEG2RAD);
/** A three-phase diff dial (1–12) as its lock share 0–1 */
const diffDialLevel = (dial: number): number => (clamp(dial, 1, 12) - 1) / 11;
/** A plain ramp diff's dial (1–12) as a scale on its data's lock: 0.65× at 1 to 1.35× at 12 */
const rampDiffDial = (level: number): number => 0.65 + ((clamp(level, 1, 12) - 1) / 11) * 0.7;

/** A first-order lag's step share over `h` with time constant `tau` (s); no lag at 0 */
const aeroLag = (h: number, tau: number): number => (tau > 0 ? Math.min(1, h / tau) : 1);

/** Bump-rubber damping at contact and per metre squeezed, and its rebound shares, where the car's data gives none */
export const BUMP_RUBBER_DEFAULTS = { damper: 2400, risingDamper: 60_000, reboundElasticShare: 0.55, reboundDamperShare: 0.15 };

/**
 * Force of a bump rubber squeezed `into` metres at wheel speed `v` (m/s, + = bump), at the wheel (N, + = up on the
 * body). Squeezing: its elastic force plus a damping that rises with the squeeze (capped at `dampMax`). Extending: only
 * `reboundElasticShare` of the elastic force and `reboundDamperShare` of the damping, never pulling. The two branches
 * blend over a band of extension speed wide enough that the hysteresis never acts as a damping stiffer than `dampMax`
 * (the hub's explicit step), so a corner standing still on its rubber carries its whole elastic force
 */
export function bumpRubberForce(bs: BumpStopSettingsUnits, into: number, v: number, dampMax: number): number {
  const el = bs.rate * into + bs.progression * into * into;
  const c = Math.min(dampMax, (bs.damper ?? BUMP_RUBBER_DEFAULTS.damper) + (bs.risingDamper ?? BUMP_RUBBER_DEFAULTS.risingDamper) * into);
  const load = el + c * v;
  if (v >= 0) return load;
  const etaEl = bs.reboundElasticShare ?? BUMP_RUBBER_DEFAULTS.reboundElasticShare;
  const etaC = bs.reboundDamperShare ?? BUMP_RUBBER_DEFAULTS.reboundDamperShare;
  const unload = Math.max(0, etaEl * el + etaC * c * v);
  // A smoothstep's steepest slope is 1.5 × its mean: the band is that much wider than the mean slope alone asks
  const band = Math.max(0.005, (1.5 * ((1 - etaEl) * el + (1 - etaC) * c * 0.5)) / Math.max(1, dampMax - c));
  const u = Math.min(1, -v / band);
  return Math.max(0, load + (unload - load) * u * u * (3 - 2 * u));
}

/** Fit C so the curve sin(C·atan(B·s)), B = tan(π/2C), falls to `falloff` at s = 3 */
function fitMagicFormula(falloff: number): { B: number; C: number } {
  const at3 = (C: number) => Math.sin(C * Math.atan(3 * Math.tan(Math.PI / (2 * C))));
  let lo = 1.0001;
  let hi = 1.99;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (at3(mid) > falloff) lo = mid;
    else hi = mid;
  }
  const C = 0.5 * (lo + hi);
  return { B: Math.tan(Math.PI / (2 * C)), C };
}

const _rhOut = { cl: 0, cd: 0, balance: 0 };

/** Zero-alloc bilinear look-up of CL, CD and balance in a ride-height map (single axis search for all three tables) */
function evalRhMap(map: AeroRideHeightMap, front: number, rear: number, out: { cl: number; cd: number; balance: number }): void {
  const rearRh = map.rearRh;
  const nr = rearRh.length;
  let r0: number;
  let r1: number;
  let tr: number;
  if (rear <= rearRh[0]) {
    r0 = r1 = 0;
    tr = 0;
  } else if (rear >= rearRh[nr - 1]) {
    r0 = r1 = nr - 1;
    tr = 0;
  } else {
    let i = 0;
    while (i < nr - 2 && rear > rearRh[i + 1]) i++;
    r0 = i;
    r1 = i + 1;
    const span = rearRh[r1] - rearRh[r0];
    tr = span > 0 ? (rear - rearRh[r0]) / span : 0;
  }

  const frontRh = map.frontRh;
  const nc = frontRh.length;
  let c0: number;
  let c1: number;
  let tc: number;
  if (front <= frontRh[0]) {
    c0 = c1 = 0;
    tc = 0;
  } else if (front >= frontRh[nc - 1]) {
    c0 = c1 = nc - 1;
    tc = 0;
  } else {
    let i = 0;
    while (i < nc - 2 && front > frontRh[i + 1]) i++;
    c0 = i;
    c1 = i + 1;
    const span = frontRh[c1] - frontRh[c0];
    tc = span > 0 ? (front - frontRh[c0]) / span : 0;
  }

  const clR0 = map.cl[r0];
  const clR1 = map.cl[r1];
  const clTop = clR0[c0] + (clR0[c1] - clR0[c0]) * tc;
  const clBot = clR1[c0] + (clR1[c1] - clR1[c0]) * tc;
  out.cl = clTop + (clBot - clTop) * tr;

  const cdR0 = map.cd[r0];
  const cdR1 = map.cd[r1];
  const cdTop = cdR0[c0] + (cdR0[c1] - cdR0[c0]) * tc;
  const cdBot = cdR1[c0] + (cdR1[c1] - cdR1[c0]) * tc;
  out.cd = cdTop + (cdBot - cdTop) * tr;

  const balR0 = map.balance[r0];
  const balR1 = map.balance[r1];
  const balTop = balR0[c0] + (balR0[c1] - balR0[c0]) * tc;
  const balBot = balR1[c0] + (balR1[c1] - balR1[c0]) * tc;
  out.balance = balTop + (balBot - balTop) * tr;
}

function inLapWindow(p: number, start: number, end: number): boolean {
  return start <= end ? p >= start && p <= end : p >= start || p <= end;
}

/**
 * The runtime for one axle. The rear merges the compound's `rearOverride`, so everything reading
 * `tyres[1].data` sees the rear tyre's own values
 */
export function createTyreRuntime(compound: TyresCompoundData, rear = false): TyreRuntime {
  const o = rear ? compound.rearOverride : undefined;
  const data: TyresCompoundData = o
    ? {
        ...compound,
        modelData: { ...compound.modelData, ...o.modelData },
        camberData: { ...compound.camberData, ...o.camberData },
        pressureData: { ...compound.pressureData, ...o.pressureData },
      }
    : compound;
  const model = data.modelData;
  // Without its own Fz0 the rear's scales with section width (see TyresModelData.Fz0)
  const fz0 = rear && o?.modelData?.Fz0 === undefined ? model.Fz0 * (data.rear.width / data.front.width) : model.Fz0;
  const { B, C } = fitMagicFormula(model.falloff_level);
  const cam = data.camberData;
  const fla = model.friction_limit_angle && model.friction_limit_angle > 0 ? model.friction_limit_angle : DEFAULT_FRICTION_LIMIT_ANGLE_DEG;
  const dyCurve = model.dyCurve ? new Lut(model.dyCurve) : null;
  return {
    data,
    thermal: new Lut(data.thermalData.thermalPerformanceCurve),
    camberLut: data.camberData.dcamberLut ? new Lut(data.camberData.dcamberLut) : null,
    pressureSpring: new Lut(data.pressureData.pressureSpringCurve),
    tanPeakAngle: Math.tan(fla * DEG2RAD),
    pKy2: model.pKy2,
    peakForceY0: (dyCurve ? dyCurve.evaluate(fz0) : model.Dy0) * fz0,
    peakSlipRatio: model.slip_ratio_limit,
    B,
    C,
    useFalloff: model.use_slip_falloff,
    falloffLevel: model.falloff_level,
    falloffSlope: Math.max(0, model.falloff_slope),
    camberThrustLimit: cam.contact_camber_c2 > 0 ? Math.sqrt(cam.contact_camber_c1 / (3 * cam.contact_camber_c2)) : Infinity,
    fz0,
    dyCurve,
    dxCurve: model.dxCurve ? new Lut(model.dxCurve) : null,
    brakeDxMod: model.brakeDxMod ?? 0,
    grain: tyreGrainThresholdsC(data.thermalData.optimalTempC),
    brush: model.curve === 'brush' ? createBrushTyre(model, Math.tan(fla * DEG2RAD), fz0) : null,
    peakWindowC: gripCurvePeakWindowC(data.thermalData.thermalPerformanceCurve),
    thermalSize: rear ? (compound.rear.width * compound.rear.radius) / (compound.front.width * compound.front.radius) : 1,
    wearCurve: data.wear ? new Lut(data.wear.curve.map(([km, pct]) => [km, pct / 100] as const)) : null,
    wearOutKm: data.wear ? data.wear.curve[data.wear.curve.length - 1][0] : 0,
    layers: tyreLayers(data.thermalData),
    rimGas: { ...RIM_GAS_DEFAULTS, ...data.thermalData.rimGas },
  };
}

/** First and last temperature (°C) at which a grip-against-temperature curve is at its peak */
export function gripCurvePeakWindowC(curve: LutPoints): [number, number] {
  let peak = 0;
  for (const [, grip] of curve) peak = Math.max(peak, grip);
  const at = curve.filter(([, grip]) => grip >= peak - 1e-6);
  return [at[0][0], at[at.length - 1][0]];
}

/** Load (as a share of Fz0) below which the load laws are held, so they stay finite as a wheel unloads */
const MIN_LOAD_RATIO = 0.05;

/**
 * Peak friction coefficient of a tyre at vertical load `fz` (N), lateral (`y`) or longitudinal (`x`): the compound's
 * tabulated load-sensitivity curve, else the power law about Fz0. Before temperature, pressure, camber, wear and
 * water scale it (the per-wheel force in `VehiclePhysics` multiplies those in).
 */
export function tyrePeakMu(t: Pick<TyreRuntime, 'data' | 'fz0' | 'dyCurve' | 'dxCurve'>, fz: number, axis: 'x' | 'y'): number {
  const curve = axis === 'y' ? t.dyCurve : t.dxCurve;
  if (curve) return curve.evaluate(fz);
  const m = t.data.modelData;
  const loadRef = Math.max(MIN_LOAD_RATIO, fz / t.fz0);
  return axis === 'y' ? m.Dy0 * Math.pow(loadRef, m.lsExpY - 1) : m.Dx0 * Math.pow(loadRef, m.lsExpX - 1);
}

/**
 * Cornering stiffness at load `fz` over the one at Fz0. Pacejka MF: Kyα = pKy1·Fz0·sin(2·atan(Fz / (pKy2·Fz0))),
 * which normalised to Fz0 is x·(pKy2² + 1) / (pKy2² + x²) with x = Fz / Fz0: near-linear in light load, saturating
 * to its peak at pKy2·Fz0. The lateral relaxation length scales with it (MF 6.1: σα = Kyα / lateral carcass stiffness).
 */
export function tyreCorneringStiffnessLoadFactor(t: Pick<TyreRuntime, 'fz0' | 'pKy2'>, fz: number): number {
  const x = Math.max(MIN_LOAD_RATIO, fz / t.fz0);
  const p2 = t.pKy2 * t.pKy2;
  return (x * (p2 + 1)) / (p2 + x * x);
}

/**
 * tan(peak slip angle) at load `fz`: the peak lateral force there over the cornering stiffness, both from the
 * compound's data at Fz0 (`friction_limit_angle`, the load table) and the stiffness's load law. Before the carcass
 * temperature (a softer carcass peaks later) and before the grip scalings (temperature, wear, water), which scale
 * force and stiffness together.
 */
export function tyrePeakSlipTan(
  t: Pick<TyreRuntime, 'data' | 'fz0' | 'dyCurve' | 'dxCurve' | 'pKy2' | 'tanPeakAngle' | 'peakForceY0'>,
  fz: number
): number {
  const fzL = Math.max(fz, MIN_LOAD_RATIO * t.fz0);
  return (t.tanPeakAngle * tyrePeakMu(t, fzL, 'y') * fzL) / (t.peakForceY0 * tyreCorneringStiffnessLoadFactor(t, fzL));
}

/**
 * Carcass stiffness at carcass temperature `carcassC` over its stiffness at `thermalVerticalRefC` (the rubber softens
 * as it warms), floored at 0.7: the radial rate takes it, and so does the cornering stiffness (same rubber), so a hot
 * carcass peaks at a larger slip angle and a cold one is sharper
 */
export function tyreCarcassStiffnessFactor(
  th: Pick<TyresThermalPatchData, 'thermalVerticalK' | 'thermalVerticalRefC'>,
  carcassC: number
): number {
  return Math.max(0.7, 1 + th.thermalVerticalK * (carcassC - th.thermalVerticalRefC));
}

/**
 * Core temperatures (°C) at which a compound grains, cleans up and blisters, from its working window `[low, high]`:
 * graining below low − 17, cleaning up from there to high + 5 (a tyre too warm to tear, rolled without much sliding,
 * wears its grained tread off), blistering above high + 13. An F1 slick's 95–115 °C window gives 78 / 78–120 / 128 °C;
 * a GT3 or road tyre's lower window moves them down with it.
 */
export function tyreGrainThresholdsC(optimalTempC: readonly [number, number]): { grainBelow: number; healFrom: number; healTo: number; blisterAbove: number } {
  const [low, high] = optimalTempC;
  return { grainBelow: low - 17, healFrom: low - 17, healTo: high + 5, blisterAbove: high + 13 };
}

/** Grip at hot inflation pressure `psi` (gauge): a parabola about the optimum, or the data's loss per psi; floored at half grip */
export function tyrePressureGrip(p: Pick<TyresPressureData, 'optimalPsi' | 'pressureGripSensitivity' | 'pressureGripLossPerPsi'>, psi: number): number {
  // Tyre data that states its loss per psi: linear either side of the optimum
  if (p.pressureGripLossPerPsi !== undefined) return Math.max(0.5, 1 / (1 + p.pressureGripLossPerPsi * Math.abs(psi - p.optimalPsi)));
  const dp = (psi - p.optimalPsi) / p.optimalPsi;
  return Math.max(0.5, 1 - p.pressureGripSensitivity * dp * dp);
}

/** Pure-slip force shape at normalised slip s ≥ 0 (1 at the peak, s = 1) */
export function tyreSlipCurve(t: Pick<TyreRuntime, 'B' | 'C' | 'useFalloff' | 'falloffLevel' | 'falloffSlope'>, s: number): number {
  if (t.useFalloff && s > 1) {
    const d = s - 1;
    return t.falloffLevel + (1 - t.falloffLevel) * Math.exp(-t.falloffSlope * d * d);
  }
  return Math.sin(t.C * Math.atan(t.B * s));
}

/** tyreSlipCurve(s) / s, finite at s = 0 */
function slipCurveOverS(t: TyreRuntime, s: number): number {
  return s > 1e-6 ? tyreSlipCurve(t, s) / s : t.B * t.C;
}

/**
 * Combined slip by the normalised slip vector (Pacejka's similarity method, Tire and Vehicle Dynamics ch. 4; the
 * friction ellipse a brush model gives): normalised slips (sx, sy) → per-axis force fractions (fx, fy) of μ·Fz. One
 * combined slip s = |(sx, sy)| sets the force F(s) on the pure-slip curve, split along the slip direction: fx = F(s)·sx/s,
 * fy = F(s)·sy/s. So fx² + fy² = F(s)² ≤ 1, and with each axis's own μ the forces stay on or inside the friction
 * ellipse (Fx / μx·Fz)² + (Fy / μy·Fz)² ≤ 1 at every slip. `new_combined` first shifts / scales the slips by the
 * SA/SR cross terms.
 */
export function combinedSlipForces(
  t: TyreRuntime,
  model: Pick<TyresCompoundData['modelData'], 'new_combined' | 'fx_shift_SA' | 'fx_scale_SA' | 'fy_shift_SR' | 'fy_scale_SR'>,
  sx: number,
  sy: number,
  out: { fx: number; fy: number; sx: number; sy: number }
): void {
  let sxm = sx;
  let sym = sy;
  if (model.new_combined) {
    sxm = sx * (1 - model.fx_scale_SA * Math.min(1, Math.abs(sy))) + model.fx_shift_SA * sy;
    sym = sy * (1 - model.fy_scale_SR * Math.min(1, Math.abs(sx))) + model.fy_shift_SR * sx;
  }
  const fOverS = slipCurveOverS(t, Math.hypot(sxm, sym));
  out.fx = sxm * fOverS;
  out.fy = sym * fOverS;
  out.sx = sxm;
  out.sy = sym;
}

const _comb = { fx: 0, fy: 0, sx: 0, sy: 0 };
const _brush: BrushForces = { fx: 0, fy: 0, slipNorm: 0 };
/** Share of the tread surface's temperature in the temperature a brush tyre's grip curve is read at (the rest: its carcass) */
const GRIP_TEMP_SURFACE_SHARE = 0.3;
/**
 * The pressure a compound's tyre is set to by default at its `coldRefC` (psi gauge): the one its data states, else the
 * one that reaches the optimum with the carcass at the centre of the working window
 */
export function defaultColdPressurePsi(t: TyresCompoundData): number {
  const p = t.pressureData;
  if (p.setPsi !== undefined) return p.setPsi;
  // The gas at the centre of the working window, the carcass stretching as it does on track
  const targetGasC = 0.5 * (t.thermalData.optimalTempC[0] + t.thermalData.optimalTempC[1]);
  const stretch = t.thermalData.rimGas?.carcassVolumeStretchPerPsi ?? RIM_GAS_DEFAULTS.carcassVolumeStretchPerPsi;
  return Math.round(tyreColdPressureForGas(p.optimalPsi, p.coldRefC, targetGasC, stretch) * 10) / 10;
}

/** Spin past which a tyre's radius grows no further (rad/s): a wheel spun up off the ground does not balloon */
const MAX_GROWTH_SPIN_RADS = 350;
/** The scrub term of rolling resistance: the slip (over the peak slip) it stops growing at, and the spin it is whole from */
const SCRUB_MAX_SLIP = 3;
const SCRUB_FULL_SPIN_RADS = 20;
const _roadSlope = { dhdx: 0, dhdz: 0 };

// Scratch (single-threaded, never escapes a call)
const _m = new THREE.Matrix4();
const _tyreTorque = new Float64Array(4);
const _wheelInertia = new Float64Array(4);
const _wheelOmega = new Float64Array(4);
const STEFAN_BOLTZMANN = 5.670374419e-8;
const _carWake: AeroWakeState = { ...CLEAN_AIR_WAKE_STATE };
const _coolAero = { cdA: 0, clAFront: 0, clARear: 0 };
const KELVIN = 273.15;
/** Wet spray's cooling of the rim against the wet-environment conductance of `rimWetEnvironmentCoolingWK` [est] */
const RIM_WET_SPRAY_SCALE = 10;
const _brakeImpulse = new Float64Array(4);
const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
/** Kingpin geometry handed to the rack-torque sum (geometric scrub and trail) */
const _kpGeo = { kpiRad: 0, casterRad: 0, scrubRadiusM: 0, casterTrailM: 0 };
const _p = new THREE.Vector3();
const _plankHit = createGroundHit();
const _plankXs = new Float64Array(4);
const _plankYs = new Float64Array(4);
const _plankZs = new Float64Array(4);
const _plankHits = [createGroundHit(), createGroundHit(), createGroundHit(), createGroundHit()];
const _wallHit = createWallHit();
const _wallEndHit = createWallEndHit();
const _pFrom = new THREE.Vector3();
const _n = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _lw = new THREE.Vector3();
const _w = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _qd = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _w2 = new THREE.Vector3();
const _rxd = new THREE.Vector3();
const _air = new THREE.Vector3();

/**
 * The barrier outline's corners relative to the CG, in order round it (x, z pairs), and its edges
 * (`OUTLINE_EDGE_STRIDE` floats each): scratch, filled before every read, so no car's state
 */
const _outlineCorners = new Float64Array(64);
const _outlineEdges = new Float64Array(32 * OUTLINE_EDGE_STRIDE);

/** Stretches of the lap the 2026 energy management keeps its record of the braking harvest in */
const ERS_LAP_BINS = 64;

/** A mode's energy management against charge (`EnergyManagementData`) */
interface ManagementLuts {
  deployAbove: Lut;
  superclipBelow: Lut;
}
const managementLuts = (m: PerformanceModeData): ManagementLuts | null => {
  const em = m.energyManagement;
  return em ? { deployAbove: new Lut(em.deployAboveSPerMJ), superclipBelow: new Lut(em.superclipBelowSPerMJ) } : null;
};

export class VehiclePhysics {
  public static readonly FIXED_DT = 0.002;
  public static readonly SUBSTEPS = 4;
  /**
   * Lighter physics tier for AI opponent cars (never set on the player's car):
   * - Single-point hub ground queries instead of 5-point contact-patch enveloping
   * - Ground probed once per 500 Hz outer step instead of every substep
   * - 2 substeps (1 kHz) instead of 4 (2 kHz), skipping unused FFB subframe buffering
   */
  public aiLitePhysics = false;
  /** Counter for decimating slow-varying AI physics work (thermal 125 Hz, collider ground re-probe 250 Hz) */
  private aiStepTick = 0;
  /** Elapsed time since the previous ground collider probe (s), so climbStep scales travel accurately on decimated probes */
  private probeElapsedS = 0;

  private get activeSubsteps(): number {
    return this.aiLitePhysics ? 2 : VehiclePhysics.SUBSTEPS;
  }

  public readonly config: CarPhysicsConfig;
  /** Car, driver and fuel (kg): see setFuelMass */
  public totalMassKg: number;
  public sprungMassKg: number;
  /** CG → front / rear axle (m) */
  public readonly cgToFrontM: number;
  public readonly cgToRearM: number;
  public readonly wheelbaseM: number;
  /** The wheels the engine drives (left, right): 0/1 the front pair, 2/3 the rear (`CarPhysicsConfig.drivenAxle`) */
  public readonly drivenWheels: readonly [number, number];
  /**
   * Four-wheel drive (`CarPhysicsConfig.awd`): the other axle's wheels (left, right), driven through the centre coupling
   * off `drivenWheels`' drive. null on a two-wheel-drive car
   */
  public readonly coupledWheels: readonly [number, number] | null;
  /** Every wheel the engine drives: `drivenWheels`, then `coupledWheels` on a four-wheel-drive car */
  public readonly allDrivenWheels: readonly number[];
  /** The driven axles' wheel pairs: `drivenWheels`, then `coupledWheels` */
  private readonly drivenPairs: ReadonlyArray<readonly [number, number]>;
  /** Torque the centre coupling hands the coupled axle (Nm at the axle, + forward: backwards in reverse); 0 without AWD */
  public centreCouplingTorqueNm = 0;
  /** Locking torque of the coupled axle's differential (Nm); 0 without AWD */
  public coupledLockTorqueNm = 0;
  /** Road-wheel angle at full lock (rad); the garage's steering ratio changes it */
  public maxSteerRad: number;
  /** Garage: static toe per axle (rad, + = toe-in), engine braking and brake duct cooling relative to the baseline */
  public staticToeRad = { front: 0, rear: 0 };
  public engineBrakingScale = 1;
  public brakeDuctScale = { front: 1, rear: 1 };
  /**
   * The garage's cooling openings in steps from their baseline (brake ducts at step 3, the radiator's tape), for their
   * drag and downforce (`AeroData.cooling`) and the radiator's cooling of the engine
   */
  public coolingSteps = { brakeDuctFront: 0, brakeDuctRear: 0, radiator: 0 };
  /** Mean over the last 500 Hz step of the engine's own positive power at the crank (W) */
  public iceMechanicalPowerW = 0;
  /** Mean over the last 500 Hz step of the power into the driven shafts, engine and motor together (W) */
  public driveshaftPowerW = 0;
  private stepIcePowerSumW = 0;
  /** The engine's and the motor's crank torque the last sub-step without the traction cut (Nm), for the spark-first split */
  private lastIceDriveNm = 0;
  private lastMotorDriveNm = 0;
  private stepShaftPowerSumW = 0;
  private stepPowerSamples = 0;
  /**
   * A prototype's hybrid dials (`CarPhysicsConfig.hybridDials`): the motor's deployment cap and the braking
   * regeneration cap (kW), in place of the performance mode's. null on a car without them
   */
  public motorDeployKw: number | null = null;
  public regenKw: number | null = null;
  /**
   * Engine coolant temperature (°C), on a car whose radiator opening is a garage setting (`AeroData.cooling`): taped up
   * for less drag it runs hotter, and past 112 °C the engine's control takes torque away to protect it
   */
  public coolantTempC = 90;
  private readonly coolantModel: boolean;
  /** The engine curve's peak (W), for the coolant's sizing */
  private readonly peakEnginePowerW: number;
  /** Skid-block wear at its four corners, front-left, front-right, rear-left, rear-right (mm) (`AeroData.plankPhysics`) */
  public readonly plankWearMm: [number, number, number, number] = [0, 0, 0, 0];
  /** Steering compliance (rad of road-wheel angle per N of lateral force) */
  private readonly steerComplianceRadPerN: number;
  private readonly ffbMechanicalTrailM: number;
  private readonly powerSteering: PowerSteeringData | undefined;
  /** Sum / count of the per-step FFB torque since the last takeFfbAverage() */
  private ffbSum = 0;
  private ffbSamples = 0;
  /** 500 Hz outer-step FFB samples accumulated during step() */
  private ffbSubframeSamples: number[] = [];
  /** The torque of the substeps of the outer step under way, summed, and their count: its sample is their mean */
  private ffbStepSum = 0;
  private ffbStepSamples = 0;
  /**
   * Commanded road-wheel angle at the last step() and its rate over that step (rad, rad/s): how fast the wheel is
   * really being turned, which the once-per-frame input otherwise only shows as steps
   */
  private lastCmdSteerRad = Number.NaN;
  private cmdSteerRateRadS = 0;

  // ---- body state (world)
  /** CG position */
  public readonly position = new THREE.Vector3();
  public readonly quaternion = new THREE.Quaternion();
  public readonly velocity = new THREE.Vector3();
  public readonly angularVelocity = new THREE.Vector3();
  /** Ground-level origin of the car model (body point straight below the CG at static height) */
  public readonly modelPosition = new THREE.Vector3();

  public readonly wheels: [WheelState, WheelState, WheelState, WheelState];
  public readonly telemetry: VehicleTelemetry;

  // ---- power unit & drivetrain
  public gear = 1;
  public engineOmega: number;
  public autoShift = true;
  /** Automatic clutch and anti-stall (default true); false with manual gears enables bite point, slip and stalls */
  public autoClutch = true;
  public ersEnergyJ: number;
  public lapDeployJ = 0;
  public lapHarvestJ = 0;
  /**
   * Of `lapHarvestJ`, what the brake pedal recovered, by stretch of the lap (`ERS_LAP_BINS` of them); and that on the
   * last whole lap, which the 2026 energy management keeps the recharge limit's room for
   */
  private readonly lapBrakeHarvestJ = new Float64Array(ERS_LAP_BINS);
  private readonly lastLapBrakeHarvestJ = new Float64Array(ERS_LAP_BINS);
  private lastLapBrakeKnown = false;
  /** This lap began at the line, not at a placement part-way round: only such a lap's braking is a whole lap's */
  private lapFromLine = false;
  /** The 2026 F1 rules' ERS-K control (`ERSData.regulations` 'f1-2026'), else null */
  private readonly ers2026: Ers2026Control | null;
  /** How much the engine sped up over the last step (rad/s), for the 2026 motor's torque */
  private ersOmegaStep = 0;
  /** The motor's share of a traction-control cut after `ERSData.mguDemandFilter` (0..1) */
  private mguShareFiltered = 1;
  public performanceMode: PerformanceModeName;
  /** Driver EBB offset in steps (+ = forward), on top of the performance mode's */
  public ebbUser = 0;
  public compound: PhysicsTyreCompound;
  /** Live turbo boost pressure for the gauge and the sound (bar absolute, 1.0 = atmospheric; `TurboData.displayMaxBoostBar`) */
  public turboBoostBar = 1.0;
  /** Boost the turbo has spooled to (`TurboData` units: torque ∝ 1 + boost) */
  private turboBoost = 0;
  /**
   * The turbo's spool lag shapes the ICE torque: on by default when the engine has `turbo` data; the adapter sets it
   * from its car profile
   */
  public turbocharged: boolean;
  /** Disc / pad material of the brakes (`BrakesData.discMaterial`) */
  private readonly brakeCompound: BrakeCompoundKind;
  /** The car's own pad friction against disc temperature (`BrakesData.padMuCurve`), else the material's */
  private readonly brakePadCurve: BrakePadMuCurve | undefined;
  /** Disc temperature at the start and every reset (°C, `BrakesData.discStartTempC`) */
  private readonly brakeStartTempC: number;
  /** The rear discs' cooling air against the front's (`BrakesData.rearDuctShare`) */
  private readonly brakeRearDuctShare: number;
  /** Both axles' cooling air against the material's own ducts (`BrakesData.ductShare`) */
  private readonly brakeDuctShare: number;
  /** Dynamic brake bias after pressure-sensitive brake migration */
  public dynamicBrakeBias = 0.56;
  /** Live-tunable dynamic brake migration ramp amount (0..0.06) */
  public liveBrakeMigrationAmount = 0.02;
  /** Live-tunable 3-Phase Electronic Differential dials (1..12) and active phase */
  public diffEntryLevel = 3;
  public diffMidLevel = 5;
  public diffExitLevel = 5;
  /** The car's own entry / exit dial positions: a plain ramp diff has its data's lock there (the dials scale about them) */
  private readonly diffEntryDefault: number;
  private readonly diffExitDefault: number;
  public diffActivePhase: 'ENTRY' | 'MID' | 'EXIT' = 'MID';
  /** Live-tunable engine torque/throttle map (1 = Quali 100%, 2 = Race 98.5%, 3 = Smooth 96%, 4 = Lean 92.5%, 5 = Save 87%) */
  public engineMap = 1;

  // ---- aero & track environment
  public airDensity: number;
  public ambientC: number;
  public trackTempC: number;
  private readonly baseTrackTempC: number;
  public drsOpen = false;
  public drsBlend = 0;
  /**
   * Which flaps the DRS button opens: both wings' (2026 Straight Mode) or the rear wing's alone (DRS up to 2025).
   * Rear only drops the front flap's downforce change and keeps the rear's share of the drag reduction.
   */
  public drsFlaps: 'front-rear' | 'rear' = 'front-rear';
  /**
   * Race control's grip call for the flaps (2026 Straight Mode): null, none (the flaps shut once the road under the car
   * is too wet, `isRearFlapAllowedInWet`); false, Normal Grip Conditions (both open); true, Low Grip Conditions: only
   * the front flaps open (partial activation, FIA Section B7.1.2 b), each stretch from `LOW_GRIP_ZONE_DELAY_M` later
   */
  public flapsLowGrip: boolean | null = null;
  /**
   * A zone opens only after its detection point was crossed eligibly (`drsEligibleAtDetection`, DRS up to 2025).
   * Off: every zone opens for every car (2026 Straight Mode); the detection points are still reported.
   */
  public drsGatedByDetection = true;
  /** The car has a DRS flap at all (off: a car from before 2011, whose flaps never open) */
  public drsFitted = true;
  /** Extra recharge allowed this lap on top of `harvestPerLapJ` (J): a 2026 race lap begun with Overtake activated */
  public extraRechargeJ = 0;
  /** The ERS-K's power runs to Overtake's curve (under `ERSData.regulations` 'f1-2026'): the adapter's call */
  public ersOvertake = false;
  /** The driver's Boost held (under the 2026 rules): the adapter's */
  public ersBoost = false;
  /** The share of Overtake's power over the normal curve used (1; less for the game's Automatic Overtake) */
  public ersOvertakeShare = 1;
  /** The circuit's 2026 energy rules (`f1-energy-circuits.ts`) and the session driven; null: the rules' defaults */
  public ersCircuit: F1EnergyCircuit | null = null;
  public ersSession: EnergySession = 'practice';
  /**
   * Low Grip Conditions under the 2026 rules: the Boost only holds the power (Section B7.2.1 g i), and a cut may be
   * reset only in the last sector before the line, never in a race (g ii). The adapter's
   */
  public ersLowGrip = false;
  /**
   * Distance on from lap distance s (m) to the next braking zone on the circuit (m; Infinity: none), which the 2026
   * energy management plans its cuts and superclipping by: the adapter's, from the car's braking guide. Read at each
   * tick from the lap progress, so the car is the same whatever the frame rate. Null: no braking zone known
   */
  public ersBrakeAheadAt: ((s: number) => number) | null = null;
  /** Lap progress from `locateProgress` (NaN without it) */
  public trackProgress = Number.NaN;
  public aeroWake: AeroWakeState = { ...DEFAULT_AERO_WAKE };
  /** Damage (car-damage.ts), per wheel LF, RF, LR, RR: grip multiplier and extra toe (rad, + in); engine torque multiplier */
  public readonly damageGrip = new Float64Array([1, 1, 1, 1]);
  public readonly damageToeRad = new Float64Array(4);
  public damagePowerMult = 1;
  public trackEvolution: TrackEvolutionSample = { ...DEFAULT_TRACK_EVOLUTION_SAMPLE };
  /** Water film under the car (mm), per-wheel water film [LF, RF, LR, RR] (mm), and how wet the road acts (0..1) */
  public waterMm = 0;
  public wheelWaterMm: [number, number, number, number] = [0, 0, 0, 0];
  public wetness = 0;
  /** Wind over the ground, world frame (m/s): the aero sees the velocity through the air */
  public windWorld = new THREE.Vector3();
  /** Simulation realism (tyre wear, temperature grip, wet severity) */
  public realism: SimRealismFlags = { ...FULL_REALISM };

  private ground: GroundQuery;
  private readonly axles: [AxleRuntime, AxleRuntime];
  private readonly frontSuspHardpoints: DoubleWishboneHardpoints;
  private readonly rearSuspHardpoints: DoubleWishboneHardpoints;
  /** Wishbone kinematics solved in place each sub-step */
  private readonly frontKin = createAxleKinematicsState();
  private readonly rearKin = createAxleKinematicsState();
  private readonly wings: WingRuntime[];
  private tyres: [TyreRuntime, TyreRuntime];
  private readonly tyreByCompound = new Map<PhysicsTyreCompound, [TyreRuntime, TyreRuntime]>();
  private readonly inertiaBody: THREE.Vector3;
  /** Body inertia without fuel (the config's, for its fuel-less mass) */
  private readonly dryInertiaBody: THREE.Vector3;
  private fuelKg = 0;
  private readonly floorOffsetY: number;
  private readonly staticRakeDeg: number;
  private readonly luts: {
    power: Lut;
    coast: Lut;
    throttle: Lut;
    mgukDeploy: Lut;
    mgukHarvest: Lut;
    deployVsSpeed: Record<PerformanceModeName, Lut>;
    /** Each mode's `energyManagement` (against charge), null for a mode without */
    management: Record<PerformanceModeName, ManagementLuts | null>;
    deployVsGear: Lut;
    /** `EngineData.outputPowerCap`: the limit at the driven shafts (rpm → kW) and its change with road speed */
    powerCap: Lut | null;
    powerCapVsSpeed: Lut | null;
  };
  /** Roll / yaw tables of the ride-height aero map */
  private readonly mapLuts: { rollCl: Lut; rollCd: Lut; rollBalance: Lut; yawCl: Lut; yawCd: Lut; yawBalance: Lut } | null;
  private readonly drsZones: ZoneData_DRSZone[];
  private readonly straightZones: readonly { start: number; end: number }[];
  private readonly locateProgress?: (x: number, z: number) => number;
  private readonly lapLengthM: number;
  private readonly drsEligibleAtDetection?: (zone: ZoneData_DRSZone) => boolean;
  private readonly flapsBarred?: () => boolean;
  /**
   * Where the flaps may open as one list (`flapStretches`), for the rules it was made for, with the lap fraction at
   * which a 2026 car is told of each (`STRAIGHT_MODE_AHEAD`)
   */
  private flapStretchCache: { gated: boolean; list: readonly LapWindow[]; noticeAt: readonly number[] } | null = null;
  /**
   * A press of the flap button the flaps could not answer yet, kept for one stretch: it opens them there once they
   * may open, and lapses on leaving that stretch, on the brake inside it, on a second press or after
   * `FLAP_PRESS_MAX_WAIT_S`
   */
  private drsQueue: { window: LapWindow; reached: boolean; waitedS: number } | null = null;
  private onEvent?: (event: VehicleEvent) => void;
  private walls?: WallQuery;
  private readonly wallIds = new Int32Array(256);
  /** Body-frame points probed against the barriers (floor level, around the outline) */
  public readonly wallProbePoints: THREE.Vector3[];
  /** Wall search radius around the CG: the farthest probe plus a margin (m) */
  private readonly wallQueryRadius: number;
  /** The probes on the outline's convex hull, in order round it (indices into `wallProbePoints`) */
  private readonly wallOutline: number[];
  /** The farthest probe from the CG (m): the outline's bounding radius */
  private readonly wallOutlineRadius: number;
  /** CG and attitude at the start of the substep, for the swept barrier tests */
  private readonly wallPrevCg = new THREE.Vector3();
  private readonly wallPrevQuat = new THREE.Quaternion();
  /** Zone whose detection point was crossed eligibly and not yet left */
  private drsArmedZone: string | null = null;
  private lastDrsZoneId: string | null = null;
  private wallContactNow = false;
  /**
   * True while `reset` holds the car on its spot to settle: no wall contact then. A car placed overlapping a barrier
   * was pushed and spun by it on every held substep, its position put back each time, until it rolled over, flew up
   * or blew up; let go, the barrier pushes it out as ever (capped per step)
   */
  private pinnedForSettle = false;
  private wallContactStep = false;
  private wallImpactStep = 0;
  /** Hardest hit of the contact going on now (m/s); 0 once off the barrier */
  private wallContactPeakMs = 0;

  private timeAccumulator = 0;
  private prevInputs = { shiftUp: false, shiftDown: false, neutral: false, drs: false };
  private drsRequested = false;
  private shiftTimer = 0;
  /** A paddle press that came while a shift was still under way: it is made once that shift is done */
  private pendingShift: -1 | 0 | 1 = 0;
  /** The driver's last paddle shift with the auto box on, the auto box's schedule and its reading of the car */
  private readonly manualShift = new ManualShiftOverride();
  private readonly autoShiftSchedule: AutoShiftSchedule;
  private readonly autoShiftIn = createAutoShiftInput();
  /** Time since the last upshift (s): the auto box holds the gear a moment after one so wheelspin can't hunt it */
  private sinceUpshiftS = Infinity;
  private sinceDownshiftS = Infinity;
  private limiterTimer = 0;
  private clutchEngagement = 1;
  private clutchSlipNorm = 0;
  private readonly stall = new StallController();
  /** Throttle plate the cylinders see, after the air path's lag (`EngineData.torqueResponseS`) */
  private icePlate = 0;
  /** Effective cylinder load including transparent 2026 ICE-to-MGU-K torque arbitration (keeps the turbo spooled) */
  private iceArbPlate = 0;
  private lsdLockTorque = 0;
  /**
   * Rear halfshaft twist (rad, + = the diff side ahead of the hub): the mean of the two (it carries the drive torque) and
   * half their left-minus-right difference (it carries the diff's locking torque)
   */
  private shaftTwistMeanRad = 0;
  private shaftTwistHalfDiffRad = 0;
  /**
   * Chassis twist between the axle structures (rad, + = the front structure rolled about body +Z against the rear) and
   * its rate (`ChassisData.chassisTorsion`); 0 on a rigid car
   */
  public chassisTwistRad = 0;
  /**
   * The next placement is a cold start from the garage (the full realism level): tyres raced without blankets start at
   * the air's temperature and the brakes at `BrakesData.garageDiscTempC`. Set by the owner before `reset`
   */
  public coldGarageStart = false;
  /**
   * The player's tyre blankets (`ChassisSetup.tyreBlankets`): true, the tyres leave their blankets warm at every start
   * (`blanketTempC`); false, a car raced on blankets leaves the garage on cold tyres too when its start is a cold one
   * (`coldGarageStart`); null, the car's own way (`racesOnBlankets`). Set by the owner before `reset`
   */
  public tyreBlankets: boolean | null = null;
  private chassisTwistVelRadS = 0;
  /** Torsion stiffness (Nm/rad), damping (Nms/rad), front roll-inertia share and twist limit (rad); stiffness 0 = rigid */
  private readonly torsionK: number;
  private readonly torsionC: number;
  private readonly torsionFrontShare: number;
  private readonly torsionMaxRad: number;
  /** Roll moments about the CG (body +Z) the front and rear corners put on the body this sub-step (Nm) */
  private rollTorqueFront = 0;
  private rollTorqueRear = 0;
  private mgukTorque = 0;
  private aeroFrontN = 0;
  private aeroDownN = 0;
  private aeroDragN = 0;
  /** Air slip angle the aero last saw (|deg|), wing-element or map path */
  public aeroYawDeg = 0;
  private rideFront = 0;
  private rideRear = 0;
  /** Lagged map-aero forces (N): front and rear downforce, drag */
  private mapAeroFrontN = 0;
  private mapAeroRearN = 0;
  private mapAeroDragN = 0;
  /** The wing elements carry their own drag heights (`WingData.dragY`): the drag acts where its parts put it */
  private readonly dragAtElements: boolean;
  private readonly prevVelocity = new THREE.Vector3();
  /** The body's acceleration less gravity at the last sub-step (m/s², world): what the unsprung masses ride with */
  private readonly bodySpecificForce = new THREE.Vector3();
  private readonly force = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();
  private lastInputs: VehicleInputs = { throttle: 0, brake: 0, steer: 0 };

  constructor(options: VehiclePhysicsOptions) {
    const cfg: CarPhysicsConfig = options.config ?? F12026_CAR_CONFIG;
    this.config = cfg;
    this.ground = options.ground;
    this.compound = options.compound ?? cfg.compoundSlots.soft;
    this.performanceMode = options.performanceMode ?? 'RAC';
    this.airDensity = options.airDensity ?? cfg.aero.airDensity;
    this.ambientC = options.ambientC ?? 27;
    this.trackTempC = options.trackTempC ?? 41;
    this.baseTrackTempC = this.trackTempC;
    this.drsZones = options.drsZones ?? [];
    this.straightZones = options.straightZones ?? [];
    this.locateProgress = options.locateProgress;
    this.lapLengthM = options.lapLengthM ?? 0;
    this.drsEligibleAtDetection = options.drsEligibleAtDetection;
    this.flapsBarred = options.flapsBarred;
    this.walls = options.walls;
    this.onEvent = options.onEvent;

    const ch = cfg.chassis;
    this.totalMassKg = ch.totalMassKg;
    this.sprungMassKg = ch.totalMassKg - 2 * ch.unsprungMassFront - 2 * ch.unsprungMassRear;
    this.wheelbaseM = ch.wheelbase;
    this.cgToFrontM = ch.wheelbase * (1 - ch.frontWeightFraction);
    this.cgToRearM = ch.wheelbase * ch.frontWeightFraction;
    this.maxSteerRad = ch.maxRoadWheelDeg * DEG2RAD;
    const gears = cfg.gearbox.gears;
    this.autoShiftSchedule = {
      upshiftRpm: gears.upshift_rpm,
      limiterRpm: gears.redline_rpm,
      downshiftRpm: gears.downshift_rpm,
      lugRpm: AUTO_LUG_SHARE * gears.downshift_rpm,
      downshiftMarginRpm: 300,
      upshiftMaxBrake: Infinity,
      liftThrottle: 0,
      downshiftHoldS: AUTO_DOWNSHIFT_HOLD_S,
      brakeDownshift:
        gears.brake_downshift_rpm === undefined
          ? undefined
          : { rpm: gears.brake_downshift_rpm, pedal: AUTO_BRAKE_DOWNSHIFT_PEDAL, gapS: AUTO_BRAKE_DOWNSHIFT_GAP_S },
      upshiftWhileSpinning: gears.spin_upshift,
    };
    this.steerComplianceRadPerN = ((ch.steerComplianceDegPerKN ?? 0) * DEG2RAD) / 1000;
    this.powerSteering = ch.powerSteering;
    this.ffbMechanicalTrailM = ch.ffbMechanicalTrailM ?? DEFAULT_FFB_MECHANICAL_TRAIL_M;
    this.brakeCompound = cfg.brakes.discMaterial ?? 'carbon-ceramic';
    this.brakePadCurve = cfg.brakes.padMuCurve;
    this.brakeStartTempC = cfg.brakes.discStartTempC ?? 380;
    this.brakeRearDuctShare = cfg.brakes.rearDuctShare ?? 1;
    this.brakeDuctShare = cfg.brakes.ductShare ?? 1;
    this.drivenWheels = cfg.drivenAxle === 'front' ? [0, 1] : [2, 3];
    this.coupledWheels = cfg.awd ? (cfg.drivenAxle === 'front' ? [2, 3] : [0, 1]) : null;
    this.drivenPairs = this.coupledWheels ? [this.drivenWheels, this.coupledWheels] : [this.drivenWheels];
    this.allDrivenWheels = this.drivenPairs.flat();
    // Body axes: X = left (pitch), Y = up (yaw), Z = forward (roll)
    this.dryInertiaBody = new THREE.Vector3(ch.inertia.pitch, ch.inertia.yaw, ch.inertia.roll);
    this.inertiaBody = this.dryInertiaBody.clone();
    const tor = ch.chassisTorsion;
    this.torsionK = tor ? tor.torsionalStiffnessNmPerDeg * RAD2DEG : 0;
    this.torsionC = tor ? tor.torsionalDampingNmsPerDeg * RAD2DEG : 0;
    this.torsionFrontShare = clamp(tor?.frontRollInertiaShare ?? 0.46, 0.2, 0.8);
    this.torsionMaxRad = (tor?.maxTwistDeg ?? 2.5) * DEG2RAD;
    const dials = cfg.hybridDials;
    if (dials) {
      this.motorDeployKw = dials.deployStepsKw[dials.defaultDeployIndex] ?? null;
      this.regenKw = dials.regenStepsKw[dials.defaultRegenIndex] ?? null;
    }
    this.coolantModel = cfg.aero.cooling !== undefined;
    this.peakEnginePowerW = Math.max(1, ...cfg.engine.powerCurve.map((p) => p[1])) * 1000;
    this.floorOffsetY = cfg.aero.floorOffsetY;
    this.staticRakeDeg = Math.asin((cfg.aero.rear_target_height - cfg.aero.front_target_height) / ch.wheelbase) * RAD2DEG;

    const mkAxle = (spec: AxleSuspensionData, dampers: DamperControllerData, name: string, mass: number, inertia: number): AxleRuntime => {
      const heaveActive = suspensionSupportsHeave(spec.type);
      if (!heaveActive && spec.heave.rate > 0) console.warn(`IGNORING HEAVE SPRING BECAUSE SUSPENSION ${name} IS NOT DOUBLE WISHBONE`);
      return { spec, dampers, heaveActive, heaveFreeM: spec.heave.gap, unsprungMass: mass, wheelInertia: inertia };
    };
    const susp = cfg.suspensions;
    this.axles = [
      mkAxle(susp.front, susp.dampers_controller.front, 'FRONT', ch.unsprungMassFront, ch.wheelInertiaFront),
      mkAxle(susp.rear, susp.dampers_controller.rear, 'REAR', ch.unsprungMassRear, ch.wheelInertiaRear),
    ];

    this.wings = cfg.aero.wings.map((spec) => ({
      spec,
      aoaCl: new Lut(spec.lutAOA_CL),
      aoaCd: new Lut(spec.lutAOA_CD),
      ghCl: new Lut(spec.lutGH_CL_mult),
      ghCd: new Lut(spec.lutGH_CD_mult),
      yawCl: spec.lutYaw_CL_mult ? new Lut(spec.lutYaw_CL_mult) : null,
      yawCd: spec.lutYaw_CD_mult ? new Lut(spec.lutYaw_CD_mult) : null,
    }));
    this.dragAtElements = cfg.aero.wings.some((w) => w.dragY !== undefined);

    const modes = cfg.performanceModes;
    this.luts = {
      power: new Lut(cfg.engine.powerCurve),
      coast: new Lut(cfg.engine.coastCurve),
      throttle: new Lut(cfg.engine.throttleResponseCurve),
      mgukDeploy: new Lut(cfg.ers.torqueLut),
      mgukHarvest: new Lut(cfg.ers.coastLut),
      deployVsGear: new Lut(cfg.ers.deployVsGear ?? [[0, 1], [1, 1]]),
      powerCap: cfg.engine.outputPowerCap ? new Lut(cfg.engine.outputPowerCap.curve) : null,
      powerCapVsSpeed: cfg.engine.outputPowerCap?.vsSpeedKmh ? new Lut(cfg.engine.outputPowerCap.vsSpeedKmh) : null,
      deployVsSpeed: {
        PSH: new Lut(modes.PSH.deployVsSpeed),
        RAC: new Lut(modes.RAC.deployVsSpeed),
        BAL: new Lut(modes.BAL.deployVsSpeed),
        LIC: new Lut(modes.LIC.deployVsSpeed),
        CHR: new Lut(modes.CHR.deployVsSpeed),
      },
      management: {
        PSH: managementLuts(modes.PSH),
        RAC: managementLuts(modes.RAC),
        BAL: managementLuts(modes.BAL),
        LIC: managementLuts(modes.LIC),
        CHR: managementLuts(modes.CHR),
      },
    };
    const rh = cfg.aero.rhMap;
    this.mapLuts = rh
      ? {
          rollCl: new Lut(rh.rollCl),
          rollCd: new Lut(rh.rollCd),
          rollBalance: new Lut(rh.rollBalance),
          yawCl: new Lut(rh.yawCl),
          yawCd: new Lut(rh.yawCd),
          yawBalance: new Lut(rh.yawBalance),
        }
      : null;

    this.tyres = this.tyreRuntimes(this.compound);
    this.liveBrakeMigrationAmount = (cfg.brakes.migration ?? { amount: 0.015, rampStart: 0 }).amount;
    this.diffEntryLevel = cfg.differential.diffEntryLevel ?? 4;
    this.diffMidLevel = cfg.differential.diffMidLevel ?? 5;
    this.diffExitLevel = cfg.differential.diffExitLevel ?? 6;
    this.diffEntryDefault = this.diffEntryLevel;
    this.diffExitDefault = this.diffExitLevel;
    // F1 pull-rod cars and GT3 push-rod cars pass their unpacked 3D wishbone + tie-rod hardpoints into the 3D linkage solver
    const kinOptions = {
      geometry: susp.front.actuation === 'pull_rod' ? ('f1' as const) : ('gt3' as const),
      staticCasterTrailM: this.ffbMechanicalTrailM,
    };
    this.frontSuspHardpoints = buildDoubleWishboneHardpoints(susp.front.hardpoints, true, susp.front.actuation, {
      ...kinOptions,
      rockerProgressivityPerM: susp.front.rockerProgressivityPerM,
    });
    this.rearSuspHardpoints = buildDoubleWishboneHardpoints(susp.rear.hardpoints, false, susp.rear.actuation, {
      ...kinOptions,
      rockerProgressivityPerM: susp.rear.rockerProgressivityPerM,
    });

    const a = this.cgToFrontM;
    const b = this.cgToRearM;
    const tf = ch.trackWidthFront * 0.5;
    const tr = ch.trackWidthRear * 0.5;
    const mkWheel = (i: number): WheelState => {
      const isFront = i < 2;
      const isLeft = i % 2 === 0;
      const x = (isLeft ? 1 : -1) * (isFront ? tf : tr);
      const circTemps = new Float32Array(16);
      circTemps.fill(70);
      return {
        name: WHEEL_NAMES[i],
        isFront,
        isLeft,
        hardpoint: new THREE.Vector3(x, 0, isFront ? a : -b),
        hardpointWorld: new THREE.Vector3(),
        hardpointVel: new THREE.Vector3(),
        ground: createGroundHit(),
        grounded: false,
        groundRefX: 0,
        groundRefY: 0,
        groundRefZ: 0,
        contactY: Number.NaN,
        hubY: 0,
        hubVy: 0,
        staticHubDist: 0,
        springPreload: 0,
        compression: 0,
        compressionVel: 0,
        suspensionForce: 0,
        bumpStopTravel: (isFront ? susp.front : susp.rear).bumpStop.range,
        deflection: 0,
        loadedRadius: 0,
        rollingRadius: 0,
        patchHalfLengthM: 0,
        verticalRate: 0,
        fz: 0,
        kerbHit: createKerbHitState(),
        fx: 0,
        fy: 0,
        mz: 0,
        mzTwist: 0,
        gyroSteerNm: 0,
        twistRad: 0,
        twistSteerRad: Number.NaN,
        mx: 0,
        omega: 0,
        rotationRad: 0,
        steerRad: 0,
        toeRad: 0,
        complianceRad: 0,
        casterTrailM: this.ffbMechanicalTrailM,
        scrubRadiusM: isFront ? 0.014 : 0.01,
        slipRatio: 0,
        tanSlipAngle: 0,
        slipAngleRad: 0,
        peakSlipAngleRad: 0,
        corneringStiffness: 0,
        combinedSlip: 0,
        circleFraction: 0,
        camberLeftRad: 0,
        muY: 0,
        muX: 0,
        thermalGrip: 1,
        vx: 0,
        vy: 0,
        slipVelX: 0,
        surfaceTempC: 70,
        coreTempC: 70,
        bandTempsC: [70, 70, 70],
        bandCarcassTempsC: [70, 70, 70],
        bandCoreTempsC: [70, 70, 70],
        bandLoadShares: [1 / 3, 1 / 3, 1 / 3],
        rimTempC: 70,
        gasTempC: 70,
        circumferentialTempsC: circTemps,
        circumferentialWear: new Float32Array(16),
        wear: 0,
        flatSpotSeverity: 0,
        grainLevel: 0,
        blisterLevel: 0,
        dirtyLevel: 0,
        brakeDisc: createBrakeDiscState(
          this.brakeStartTempC,
          this.brakeCompound,
          this.brakePadCurve,
          (isFront ? cfg.brakes.discThicknessMm?.front : cfg.brakes.discThicknessMm?.rear) ?? defaultDiscThicknessMm(this.brakeCompound, isFront)
        ),
        coldPressurePsi: 0,
        pressurePsi: 0,
        brakeTorqueNm: 0,
        driveTorqueNm: 0,
      };
    };
    this.wheels = [mkWheel(0), mkWheel(1), mkWheel(2), mkWheel(3)];

    // Barrier probes (body frame, x left, z forward): the body's measured plan and the tyres' corners round it; without
    // a plan, nose, front wheels, sidepods, rear wheels, tail
    const geo = this.tyres[0].data;
    const halfF = tf + 0.5 * geo.front.width;
    const halfR = tr + 0.5 * geo.rear.width;
    const py = cfg.aero.floorOffsetY + 0.2;
    this.wallProbePoints = [];
    const plan = options.bodyPlan ?? ch.bodyPlan;
    if (plan?.length) {
      // The plan's z is from the axles' midpoint, which is 0.5 (a - b) ahead of the CG
      const mid = 0.5 * (a - b);
      const pts: { x: number; z: number }[] = [];
      for (const [x, z] of plan) {
        pts.push({ x, z: z + mid });
        if (x > 0) pts.push({ x: -x, z: z + mid });
      }
      for (const side of [1, -1]) {
        pts.push({ x: side * halfF, z: a + geo.front.radius }, { x: side * halfF, z: a - geo.front.radius });
        pts.push({ x: side * halfR, z: -b + geo.rear.radius }, { x: side * halfR, z: -b - geo.rear.radius });
      }
      for (const i of convexHullIndices(pts)) this.wallProbePoints.push(new THREE.Vector3(pts[i].x, py, pts[i].z));
    } else {
      const wingZ = cfg.aero.wings.map((wg) => wg.positionZ);
      const noseZ = Math.max(a, ...wingZ) + 0.3;
      const tailZ = Math.min(-b, ...wingZ) - 0.3;
      for (const side of [1, -1]) {
        for (const [x, z] of [
          [halfF, noseZ],
          [halfF, a],
          [0.85, 0],
          [halfR, -b],
          [0.5, tailZ],
        ] as const) {
          this.wallProbePoints.push(new THREE.Vector3(side * x, py, z));
        }
      }
    }
    this.wallOutlineRadius = Math.max(...this.wallProbePoints.map((p) => Math.hypot(p.x, p.z)));
    this.wallQueryRadius = this.wallOutlineRadius + 0.5;
    this.wallOutline = convexHullIndices(this.wallProbePoints);
    if (this.wallOutline.length > _outlineCorners.length / 2) throw new Error(`barrier outline of ${this.wallOutline.length} corners`);
    this.setTyreBlanketState();
    this.computeStaticGeometry();

    this.engineOmega = cfg.engine.idleRpm * RPM2RADS;
    this.turbocharged = cfg.engine.turbo !== undefined;
    this.ersEnergyJ = cfg.ers.ERS_MAX_CHARGE;
    this.ers2026 = cfg.ers.regulations === 'f1-2026' ? new Ers2026Control() : null;
    this.dynamicBrakeBias = this.brakeBias;
    this.telemetry = this.createTelemetry();
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  public setGround(ground: GroundQuery): void {
    this.ground = ground;
  }

  public setWalls(walls: WallQuery | undefined): void {
    this.walls = walls;
  }

  /** Optimum hot pressure (psi gauge) and working tread window (°C) of the front (0) or rear (1) tyres */
  public tyreOptimum(axle: 0 | 1): { psi: number; tempC: [number, number] } {
    const d = this.tyres[axle].data;
    return { psi: d.pressureData.optimalPsi, tempC: d.thermalData.optimalTempC };
  }

  public setCompound(compound: PhysicsTyreCompound): void {
    this.compound = compound;
    this.tyres = this.tyreRuntimes(compound);
    this.setTyreBlanketState();
  }

  public setAeroWakeState(wake: AeroWakeState | null): void {
    this.aeroWake = wake ?? { ...DEFAULT_AERO_WAKE };
  }

  public setTrackEvolutionSample(sample: TrackEvolutionSample | null): void {
    this.trackEvolution = sample ?? { ...DEFAULT_TRACK_EVOLUTION_SAMPLE };
    // The sample's temperature is the track evolution base (the same 41 °C default) plus the local frictional heating
    const t = this.trackEvolution.trackTempC;
    this.trackTempC = Number.isFinite(t) ? t : this.baseTrackTempC;
  }

  /**
   * Mean FFB torque (telemetry convention, +-1) over the steps since the last call: a box filter, so a frame-rate
   * reader does not alias the 2 kHz tyre signal into noise. Falls back to the latest value when nothing was stepped.
   */
  public takeFfbAverage(): number {
    const mean = this.ffbSamples > 0 ? this.ffbSum / this.ffbSamples : this.telemetry.ffbTorqueNorm;
    this.ffbSum = 0;
    this.ffbSamples = 0;
    return mean;
  }

  /**
   * Drain the outer-step FFB samples collected since the last call (the newest FFB_SUBFRAME_MAX), in the telemetry
   * convention (torque on the rim, + = right) like `-takeFfbAverage()`. Falls back to the latest value.
   */
  /**
   * Each tyre's kerb hit level now (FL, FR, RL, RR; `kerbHitLevel`) into `hits`; and how often the left and right
   * tyres are being hit (Hz, the busier of each side's two) into `hz`.
   * For the pad's rumble and the DualSense, which are told what the road does to each side.
   */
  public readKerbHits(hits: number[], hz: number[]): void {
    hz[0] = hz[1] = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      hits[i] = kerbHitLevel(w.kerbHit, this.staticCornerLoad(w.isFront));
      const side = w.isLeft ? 0 : 1;
      hz[side] = Math.max(hz[side], w.kerbHit.hitRateHz);
    }
  }

  public takeFfbSubframeSamples(): number[] {
    if (this.ffbSubframeSamples.length === 0) return [-this.telemetry.ffbTorqueNorm];
    const out = this.ffbSubframeSamples.slice();
    this.ffbSubframeSamples.length = 0;
    return out;
  }

  public setPerformanceMode(mode: PerformanceModeName): void {
    if (mode === this.performanceMode) return;
    this.performanceMode = mode;
    this.onEvent?.({ type: 'CHANGED_PERFORMANCE_MODE', mode });
  }

  /**
   * Reset the ERS per-lap deploy / harvest allowances: `atLine` on a lap wrap (called automatically then), else a
   * placement (a grid, a reset)
   */
  public resetLapEnergy(atLine = false): void {
    // A whole lap's braking harvest, line to line, for the next lap's superclipping to leave room for; not a part lap's
    // (the run from a flying start or a placement to the line)
    if (this.ers2026 && atLine && this.lapFromLine) {
      this.lastLapBrakeHarvestJ.set(this.lapBrakeHarvestJ);
      this.lastLapBrakeKnown = true;
    }
    this.lapFromLine = atLine;
    this.lapDeployJ = 0;
    this.lapHarvestJ = 0;
    this.lapBrakeHarvestJ.fill(0);
  }

  /**
   * A standing start from the grid: under the 2026 F1 rules the MGU-K deploys only from 50 km/h (C5.2.12). No-op on
   * other cars
   */
  public armStandingStart(): void {
    this.ers2026?.armStandingStart();
  }

  /**
   * The recharge this lap may have (J): the circuit's for the session (the rules' 8.5 MJ without a circuit), and a race
   * lap begun with Overtake activated 0.5 MJ more (`extraRechargeJ`)
   */
  private ersRechargeLimitJ(): number {
    const c = this.ersCircuit;
    const base = c && this.ers2026 ? c.recharge[this.ersSession] : this.config.ers.harvestPerLapJ;
    return base + this.extraRechargeJ;
  }

  /** The bigger cut a power-limited period may start with here (W, C5.12.4), in a sector the circuit names; else 0 */
  private ersBigCutW(c: F1EnergyCircuit, lapS: number): number {
    let step = 0;
    for (const w of c.bigCut) if ((!w.timeTrialOnly || this.ersSession === 'timeTrial') && inStretch(lapS, w)) step = Math.max(step, w.maxW);
    return step;
  }

  /**
   * Whether a cut may be reset here (C5.12.5): in the sectors the circuit names for the session; in Low Grip
   * Conditions only the last before the line, and never in a race (Section B7.2.1 g ii)
   */
  private ersResetSector(c: F1EnergyCircuit, lapS: number): boolean {
    if (this.ersLowGrip && this.ersSession === 'race') return false;
    let last: F1EnergyCircuit['reset'][number] | null = null;
    for (const w of c.reset) {
      if (w.timeTrialOnly && this.ersSession !== 'timeTrial') continue;
      if (!this.ersLowGrip && inStretch(lapS, w)) return true;
      if (!last || w.fromM > last.fromM) last = w;
    }
    return this.ersLowGrip && last !== null && inStretch(lapS, last);
  }

  /** Distance to the next braking zone from where the car is on the lap (m; Infinity: none known) */
  private ersBrakeAheadM(): number {
    const at = this.ersBrakeAheadAt;
    return at && Number.isFinite(this.trackProgress) && this.lapLengthM > 0 ? at(this.trackProgress * this.lapLengthM) : Number.POSITIVE_INFINITY;
  }

  /** Under the 2026 F1 rules: a power-limited period under way (deployment cut, or harvesting flat out) */
  public get ersClipping(): boolean {
    return this.ers2026?.clipping ?? false;
  }

  /** Whether the Boost button can actually deploy (or hold in Low Grip) energy right now */
  public get ersCanBoost(): boolean {
    if (!this.ers2026) return this.ersEnergyJ > 0;
    if (this.ers2026.isStandingStart) return false;
    if (this.ersEnergyJ <= CUT_ENERGY_MARGIN_J) return false;
    if (this.ersLowGrip) return this.config.performanceModes[this.performanceMode].deployFraction > 0;
    return true;
  }

  /**
   * What the lap's recharge limit leaves for non-braking harvest (part-throttle arbitration and superclipping, J): the
   * limit (with Overtake's extra) less this lap's recharge and less what the braking zones still to come could recover
   * on the last lap (before a whole lap, 78 % of the limit spread over the lap)
   */
  private superclipRoomJ(): number {
    const limit = this.ersRechargeLimitJ();
    const p = Number.isFinite(this.trackProgress) ? clamp(this.trackProgress, 0, 1) : 0.5;
    let reserve: number;
    if (this.lastLapBrakeKnown) {
      const x = p * ERS_LAP_BINS;
      const b = Math.min(ERS_LAP_BINS - 1, Math.floor(x));
      reserve = this.lastLapBrakeHarvestJ[b] * (1 - (x - b));
      for (let k = b + 1; k < ERS_LAP_BINS; k++) reserve += this.lastLapBrakeHarvestJ[k];
    } else {
      reserve = 0.78 * limit * (1 - p);
    }
    return Math.max(0, limit - this.lapHarvestJ - reserve);
  }

  /** Front brake bias including the performance mode's and the driver's EBB offsets */
  public get brakeBias(): number {
    const br = this.config.brakes;
    const steps = this.config.performanceModes[this.performanceMode].ebbOffset + this.ebbUser;
    return clamp(br.front_bias + br.ebbStep * steps, 0.3, 0.8);
  }

  /**
   * The driver dials the bias they want now: it is kept as their EBB offset (`ebbUser`, fractional steps) on top of
   * the running performance mode's, so a later mode change still moves the bias by that mode's offset
   */
  public set brakeBias(val: number) {
    const br = this.config.brakes;
    const want = clamp(val, 0.3, 0.8);
    this.ebbUser = (want - br.front_bias) / br.ebbStep - this.config.performanceModes[this.performanceMode].ebbOffset;
  }

  public get rpm(): number {
    return this.engineOmega * RADS2RPM;
  }

  public get speedMs(): number {
    return this.velocity.length();
  }

  /** Per-gear MGU-K torque clipping ceiling fraction (e.g. 0.333 in 1st, 0.666 in 2nd, 0.90 in 3rd, 1.0 in 4th+) */
  public getMgukGearClipFraction(): number {
    return this.luts.deployVsGear.evaluate(Math.max(1, this.gear));
  }

  /**
   * Place the car at rest on the ground under (x, z), heading along `yawRad` (atan2(forward.x, forward.z)),
   * then let the suspension settle. `speedMs` > 0 gives a rolling start.
   */
  /** Places the car at rest (or rolling at `speedMs`) on the ground at x, z; `keepTyres` keeps tyre and brake heat and wear (a car put back at a pose) */
  public reset(x: number, z: number, yawRad: number, speedMs = 0, keepTyres = false): void {
    const ch = this.config.chassis;
    const aero = this.config.aero;
    const probeY = 1e4;
    const hit = createGroundHit();
    const groundY = this.ground.query(x, z, probeY, hit) ? hit.height : 0;
    const pitch = Math.asin(this.staticPitchSin());
    // Seated on the road's grade and camber, not level: level on a 10 % hill, one axle starts deep in its bump rubber
    // and the other past its droop stop, and that spring torque pitches the car over before it is released
    const road = this.roadAttitude(x, z, yawRad, groundY, hit);
    this.quaternion.setFromEuler(new THREE.Euler(pitch - road.gradeRad, yawRad, road.bankRad, 'YXZ'));
    this.position.set(x, groundY + ch.cgHeight + this.rideHeightOffsetM, z);
    this.clearDynamicState();
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.prevVelocity.set(0, 0, 0);
    this.timeAccumulator = 0;
    this.gear = 1;
    this.shiftTimer = 0;
    this.pendingShift = 0;
    this.manualShift.clear();
    this.sinceUpshiftS = Infinity;
    this.sinceDownshiftS = Infinity;
    this.limiterTimer = 0;
    this.ers2026?.reset();
    // A placement starts a part lap: its braking is no lap's record
    this.lapFromLine = false;
    this.engineOmega = this.config.engine.idleRpm * RPM2RADS;
    this.turboBoostBar = 1.0;
    this.turboBoost = 0;
    this.drsOpen = false;
    this.drsBlend = 0;
    this.drsRequested = false;
    this.drsQueue = null;
    this.drsArmedZone = null;
    this.lastDrsZoneId = null;
    this.trackProgress = Number.NaN;
    this.wallContactNow = false;
    this.mapAeroFrontN = 0;
    this.mapAeroRearN = 0;
    this.mapAeroDragN = 0;
    this.wallPrevCg.copy(this.position);
    this.wallPrevQuat.copy(this.quaternion);
    // Tyres kept through a placement are only worth keeping while their state is a number
    if (!keepTyres || !this.tyreStateFinite()) this.setTyreBlanketState();

    // Hubs at their static height over the local ground
    this.updateBasis();
    for (const w of this.wheels) {
      _p.copy(w.hardpoint).applyQuaternion(this.quaternion).add(this.position);
      const gy = this.ground.query(_p.x, _p.z, _p.y + GROUND_PROBE_UP_M, w.ground) ? w.ground.height : groundY;
      const tyre = this.tyres[w.isFront ? 0 : 1];
      const R0 = (w.isFront ? tyre.data.front : tyre.data.rear).radius;
      const fz0 = this.staticCornerLoad(w.isFront);
      w.hubY = gy + R0 - fz0 / this.tyreVerticalRate(w);
      w.hubVy = 0;
      w.contactY = gy;
      w.slipRatio = 0;
      w.tanSlipAngle = 0;
      w.omega = 0;
      w.complianceRad = 0;
      w.twistRad = 0;
      w.twistSteerRad = Number.NaN;
    }
    // Lift the body so the hardpoints sit at their static distance above the hubs
    let dy = 0;
    for (const w of this.wheels) {
      _p.copy(w.hardpoint).applyQuaternion(this.quaternion).add(this.position);
      dy += w.hubY + w.staticHubDist * _ey.y - _p.y;
    }
    this.position.y += dy / 4;

    // Settle: hold the car in place horizontally while the springs find equilibrium (on a rolling road
    // at `speedMs`, so the aero load is already on the springs), then let it sit on its brakes so the
    // tyre carcasses wind up against any slope. Always settle at full resolution (temporarily holding
    // `aiLitePhysics = false`) so AI opponents share the player car's exact memoized static equilibrium.
    const savedAiLite = this.aiLitePhysics;
    this.aiLitePhysics = false;
    this.probeElapsedS = 0;
    const substeps = VehiclePhysics.SUBSTEPS;
    const h = VehiclePhysics.FIXED_DT / substeps;
    const rolling = speedMs > 0;
    const hold: VehicleInputs = { throttle: 0, brake: rolling ? 0 : 1, steer: 0 };
    if (rolling) this.gear = this.gearForSpeed(speedMs);
    // A car in exactly the state of one settled before takes that settle's result (`settle-memo.ts`), on ground and
    // barriers whose answers never depend on their earlier queries. The step size is the class's, not the car's (a test
    // changes it), so it goes in with the settle's own inputs. Not for a car keeping its worn, hot tyres (a flashback):
    // that state never comes round again, and keeping it would only push out settles that do
    const opaque = new Set<object>([this.ground]);
    if (this.walls) opaque.add(this.walls);
    try {
      const memo =
        !keepTyres && this.ground.stateless === true && (this.walls === undefined || this.walls.stateless === true)
          ? beginSettle(this, opaque, [x, z, speedMs, VehiclePhysics.FIXED_DT, substeps])
          : null;
      if (!memo?.applied) {
        // Events seen here (a barrier hit) would not be seen by a car given this settle's result: it is not kept then
        let events = 0;
        const onEvent = this.onEvent;
        this.onEvent = (e) => {
          events++;
          onEvent?.(e);
        };
        try {
          this.pinnedForSettle = true;
          for (let k = 0; k < 300 * substeps; k++) {
            this.updateBasis();
            this.velocity.x = speedMs * _ez.x;
            this.velocity.z = speedMs * _ez.z;
            // Free-rolling at the road speed under each tyre: held at speed / r, the tyres would drive (or brake) the
            // pinned car through the whole settle, and on a grade that thrust pitches it up
            for (const w of this.wheels) w.omega = (k === 0 ? speedMs : Math.max(0, w.vx)) / Math.max(0.2, w.rollingRadius || 0.35);
            if (rolling) this.engineOmega = this.drivenOmega() * this.totalRatio();
            this.substep(h, hold, true);
            this.position.x = x;
            this.position.z = z;
            this.angularVelocity.y = 0;
          }
          this.pinnedForSettle = false;
          if (!rolling) for (let k = 0; k < 600 * substeps; k++) this.substep(h, hold, true);
        } finally {
          this.pinnedForSettle = false;
          this.onEvent = onEvent;
        }
        memo?.store(events > 0);
      }
    } finally {
      this.aiLitePhysics = savedAiLite;
    }
    if (!rolling) {
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
    } else {
      // Released along the road's slope, not level: level off a 7 % downhill at 250 km/h, the car would fly off the
      // road for half a second
      this.updateBasis();
      const hx = _ez.x;
      const hz = _ez.z;
      const hl = Math.hypot(hx, hz) || 1;
      const W = this.wheels;
      const slope = (0.5 * (W[0].contactY + W[1].contactY) - 0.5 * (W[2].contactY + W[3].contactY)) / this.wheelbaseM;
      const n = Math.hypot(1, slope);
      this.velocity.set((speedMs * hx) / hl / n, (speedMs * slope) / n, (speedMs * hz) / hl / n);
      this.angularVelocity.set(0, 0, 0);
      for (const w of this.wheels) {
        w.omega = speedMs / Math.max(0.2, w.rollingRadius || 0.35);
        w.slipRatio = 0;
        w.tanSlipAngle = 0;
      }
      // A rolling start is a car already driving: its turbo spooled for the road rpm, as on the throttle
      const turbo = this.config.engine.turbo;
      this.turboBoost = turbo ? turboSteadyBoost(turbo, this.rpm) : 0;
    }
    this.prevVelocity.copy(this.velocity);
    this.ffbSubframeSamples.length = 0;
    this.ffbStepSum = 0;
    this.ffbStepSamples = 0;
    this.lastCmdSteerRad = Number.NaN;
    this.cmdSteerRateRadS = 0;
    this.updateOutputs(0);
  }

  /**
   * Grade along the heading (rad, + = uphill) and camber across it (rad, + = left side higher) of the ground under
   * the four tyres of a car placed at (x, z) heading `yawRad`, for seating it on the road. A corner with no ground
   * under it reads as `groundY`; a cliff edge or a wall face under one corner is clamped to a believable road.
   */
  private roadAttitude(x: number, z: number, yawRad: number, groundY: number, hit: GroundHit): { gradeRad: number; bankRad: number } {
    const fx = Math.sin(yawRad);
    const fz = Math.cos(yawRad);
    const a = this.cgToFrontM;
    const b = this.cgToRearM;
    const tf = 0.5 * this.config.chassis.trackWidthFront;
    const tr = 0.5 * this.config.chassis.trackWidthRear;
    // Body +left = up × forward = (fz, 0, −fx)
    const at = (along: number, left: number) => {
      const px = x + fx * along + fz * left;
      const pz = z + fz * along - fx * left;
      return this.ground.query(px, pz, groundY + ROAD_ATTITUDE_PROBE_UP_M, hit) ? hit.height : groundY;
    };
    const fl = at(a, tf);
    const fr = at(a, -tf);
    const rl = at(-b, tr);
    const rr = at(-b, -tr);
    const gradeRad = Math.atan2(0.5 * (fl + fr) - 0.5 * (rl + rr), a + b);
    const bankRad = Math.atan2(0.5 * (fl + rl) - 0.5 * (fr + rr), tf + tr);
    const lim = ROAD_ATTITUDE_MAX_RAD;
    return { gradeRad: clamp(gradeRad, -lim, lim), bankRad: clamp(bankRad, -lim, lim) };
  }

  /**
   * Zero what the last run left in the body, wheels and drivetrain that `reset` does not set itself. After the state
   * blew up (a non-finite number anywhere), any of these would carry the NaN straight into the settle and the car
   * could never be put back on the track.
   */
  private clearDynamicState(): void {
    for (const w of this.wheels) {
      w.compression = 0;
      w.compressionVel = 0;
      w.suspensionForce = 0;
      w.deflection = 0;
      w.loadedRadius = 0;
      w.rollingRadius = 0;
      w.fz = 0;
      w.fx = 0;
      w.fy = 0;
      w.mz = 0;
      w.mzTwist = 0;
      w.gyroSteerNm = 0;
      w.twistRad = 0;
      w.twistSteerRad = Number.NaN;
      w.patchHalfLengthM = 0;
      w.mx = 0;
      w.vx = 0;
      w.vy = 0;
      w.slipVelX = 0;
      w.slipAngleRad = 0;
      w.corneringStiffness = 0;
      w.combinedSlip = 0;
      w.circleFraction = 0;
      w.camberLeftRad = 0;
      w.steerRad = 0;
      w.toeRad = 0;
      w.muX = 0;
      w.muY = 0;
      w.brakeTorqueNm = 0;
      w.driveTorqueNm = 0;
      if (!Number.isFinite(w.rotationRad)) w.rotationRad = 0;
      if (!w.bandLoadShares.every(Number.isFinite)) w.bandLoadShares = [1 / 3, 1 / 3, 1 / 3];
    }
    this.clutchEngagement = 1;
    this.clutchSlipNorm = 0;
    this.stall.reset();
    this.icePlate = 0;
    this.iceArbPlate = 0;
    this.lsdLockTorque = 0;
    this.centreCouplingTorqueNm = 0;
    this.coupledLockTorqueNm = 0;
    this.shaftTwistMeanRad = 0;
    this.shaftTwistHalfDiffRad = 0;
    this.chassisTwistRad = 0;
    this.chassisTwistVelRadS = 0;
    this.stepIcePowerSumW = 0;
    this.stepShaftPowerSumW = 0;
    this.stepPowerSamples = 0;
    if (!Number.isFinite(this.coolantTempC)) this.coolantTempC = 90;
    this.rollTorqueFront = 0;
    this.rollTorqueRear = 0;
    this.mgukTorque = 0;
    this.lastIceDriveNm = 0;
    this.lastMotorDriveNm = 0;
    this.aeroFrontN = 0;
    this.aeroDownN = 0;
    this.aeroDragN = 0;
    this.rideFront = 0;
    this.rideRear = 0;
    this.bodySpecificForce.set(0, 0, 0);
    this.turboBoost = 0;
    this.ffbSum = 0;
    this.ffbSamples = 0;
    this.telemetry.ffbTorqueNorm = 0;
    if (!Number.isFinite(this.ersEnergyJ)) this.ersEnergyJ = this.config.ers.ERS_MAX_CHARGE;
  }

  /** Tyre temperatures, wear and pressures, and the brake discs, are all finite */
  private tyreStateFinite(): boolean {
    const fin = Number.isFinite;
    return this.wheels.every(
      (w) =>
        fin(w.surfaceTempC) &&
        fin(w.coreTempC) &&
        w.bandTempsC.every(fin) &&
        w.bandCarcassTempsC.every(fin) &&
        w.bandCoreTempsC.every(fin) &&
        w.circumferentialTempsC.every(fin) &&
        w.circumferentialWear.every(fin) &&
        fin(w.wear) &&
        fin(w.flatSpotSeverity) &&
        fin(w.grainLevel) &&
        fin(w.blisterLevel) &&
        fin(w.dirtyLevel) &&
        fin(w.pressurePsi) &&
        fin(w.rimTempC) &&
        fin(w.gasTempC) &&
        fin(w.brakeDisc.discThicknessMm) &&
        fin(w.brakeDisc.surfaceTempC) &&
        fin(w.brakeDisc.coreTempC) &&
        fin(w.brakeDisc.muFactor)
    );
  }

  /**
   * The rigid body, wheels and engine hold numbers a car can have: all finite, under BLOWN_UP_SPEED_MS and spinning
   * slower than BLOWN_UP_SPIN_RADS. False once the integration has blown up; the owner puts the car back with `reset`.
   */
  public stateIsSane(): boolean {
    const p = this.position;
    const v = this.velocity;
    const w = this.angularVelocity;
    const q = this.quaternion;
    if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z + w.x + w.y + w.z + q.x + q.y + q.z + q.w + this.engineOmega + this.chassisTwistRad)) return false;
    if (v.lengthSq() > BLOWN_UP_SPEED_MS * BLOWN_UP_SPEED_MS || w.lengthSq() > BLOWN_UP_SPIN_RADS * BLOWN_UP_SPIN_RADS) return false;
    for (const wh of this.wheels) {
      if (!Number.isFinite(wh.omega + wh.hubY + wh.hubVy + wh.slipRatio + wh.tanSlipAngle + wh.complianceRad + wh.twistRad)) return false;
    }
    return true;
  }

  /** Simulated time the last step() call actually advanced (whole fixed steps; s) */
  public lastStepTimeS = 0;

  /** Time handed to step() but not yet simulated (s, under one fixed step): the pose is that far behind the frame */
  public get unsteppedS(): number {
    return this.timeAccumulator;
  }

  /** Advance by a render frame (any dt); runs fixed 500 Hz steps */
  public step(dtSeconds: number, inputs: VehicleInputs): void {
    const inp = this.sanitizeInputs(inputs);
    this.handleEdges(inp);
    this.timeAccumulator = Math.min(this.timeAccumulator + dtSeconds, 0.1);
    // The steering input arrives once per call: spread its change over the fixed steps this call runs, the wheel's
    // real speed (a step that runs none carries the change on to the next)
    let fixedSteps = 0;
    for (let a = this.timeAccumulator; a >= VehiclePhysics.FIXED_DT; a -= VehiclePhysics.FIXED_DT) fixedSteps++;
    if (fixedSteps > 0) {
      const cmdSteerRad = -inp.steer * this.maxSteerRad;
      this.cmdSteerRateRadS = Number.isFinite(this.lastCmdSteerRad)
        ? (cmdSteerRad - this.lastCmdSteerRad) / (fixedSteps * VehiclePhysics.FIXED_DT)
        : 0;
      this.lastCmdSteerRad = cmdSteerRad;
    }
    let steps = 0;
    while (this.timeAccumulator >= VehiclePhysics.FIXED_DT) {
      this.timeAccumulator -= VehiclePhysics.FIXED_DT;
      this.outerStep(inp);
      steps++;
    }
    this.lastStepTimeS = steps * VehiclePhysics.FIXED_DT;
  }

  /**
   * Ground height under a wheel for the ride-height reads. A wheel in the air keeps its last contact in `ground`
   * (the probe only reaches 0.6 m), which after a crest is above the real road: the road is at least as low as the
   * bottom of the tyre, so the aero sees its ride height grow instead of the take-off value.
   */
  private groundYUnder(w: WheelState): number {
    if (w.grounded) return w.ground.height;
    return Math.min(w.ground.height, w.hubY - this.tyreRadiusOf(w));
  }

  /**
   * World height of the bottom of a wheel's tyre: the road (the climbed contact height) under a loaded tyre, the hub
   * less the unloaded radius for one off the ground (in the air, or above a road the probe still reaches)
   */
  public tyreBottomY(w: WheelState): number {
    const R0 = this.tyreRadiusOf(w);
    return w.grounded && (w.hubY - w.ground.height) * w.ground.ny < R0 ? w.ground.height : w.hubY - R0;
  }

  /** Unloaded radius of a wheel's tyre (m) */
  private tyreRadiusOf(w: WheelState): number {
    const tyre = this.tyres[w.isFront ? 0 : 1];
    return (w.isFront ? tyre.data.front : tyre.data.rear).radius;
  }

  // ===========================================================================
  // Setup
  // ===========================================================================

  /** Front and rear runtimes of a compound */
  private tyreRuntimes(compound: PhysicsTyreCompound): [TyreRuntime, TyreRuntime] {
    let t = this.tyreByCompound.get(compound);
    if (!t) {
      const data = compoundData(this.config, compound);
      t = [createTyreRuntime(data), createTyreRuntime(data, true)];
      this.tyreByCompound.set(compound, t);
    }
    return t;
  }

  /**
   * The temperature a compound's tyres start at. On blankets (the player's choice, else the car's own way): the
   * blankets' (`blanketTempC`). Without: a tyre raced without blankets (`blanketC` set) at the air's on a cold start from
   * the garage, else at `blanketC` (a level that warms them, or a rolling start after a formation lap); a tyre whose
   * blankets the player took off at the air's on a cold start, else its `coldRefC` as before; a tyre set in the garage's
   * air at its `coldRefC`
   */
  private tyreStartTempC(t: TyresCompoundData): number {
    const p = t.pressureData;
    const own = racesOnBlankets(p);
    if (this.tyreBlankets ?? own) return blanketTempC(t);
    if (p.blanketC !== undefined || own) return this.coldGarageStart ? this.ambientC : (p.blanketC ?? p.coldRefC);
    return p.coldRefC;
  }

  /** Blanket (or garage) temperature, cold pressure that reaches the optimum with the core at the window centre */
  private setTyreBlanketState(): void {
    const discC =
      this.coldGarageStart && this.config.brakes.garageDiscTempC !== undefined ? this.config.brakes.garageDiscTempC : this.brakeStartTempC;
    for (const w of this.wheels) {
      const rt = this.tyres[w.isFront ? 0 : 1];
      const t = rt.data;
      const p = t.pressureData;
      const startC = this.tyreStartTempC(t);
      w.coldPressurePsi = defaultColdPressurePsi(t);
      w.surfaceTempC = startC;
      w.coreTempC = startC;
      w.bandTempsC = [startC, startC, startC];
      w.bandCarcassTempsC = [startC, startC, startC];
      w.bandCoreTempsC = [startC, startC, startC];
      // A blanket warms the tyre, and its rim and air with it; a cold tyre's are the air's
      w.gasTempC = startC;
      w.rimTempC = startC;
      w.circumferentialTempsC.fill(startC);
      this.plankWearMm.fill(0);
      this.coolantTempC = 90;
      w.circumferentialWear.fill(0);
      w.wear = 0;
      w.flatSpotSeverity = 0;
      w.grainLevel = 0;
      w.blisterLevel = 0;
      w.dirtyLevel = 0;
      resetBrakeDiscState(w.brakeDisc, discC, this.brakeCompound, this.brakePadCurve);
      w.pressurePsi = tyreGaugePressureOfGas(w.coldPressurePsi, p.coldRefC, w.gasTempC, rt.rimGas.carcassVolumeStretchPerPsi);
    }
  }

  /** The tyres' pressures again from their cold pressures and their gas's temperature (after the cold pressures change) */
  public refreshTyrePressures(): void {
    for (const w of this.wheels) {
      const rt = this.tyres[w.isFront ? 0 : 1];
      w.pressurePsi = tyreGaugePressureOfGas(w.coldPressurePsi, rt.data.pressureData.coldRefC, w.gasTempC, rt.rimGas.carcassVolumeStretchPerPsi);
    }
  }

  /** Fuel on board (kg) */
  public get fuelMassKg(): number {
    return this.fuelKg;
  }

  /**
   * Fuel on board (kg): its mass rides with the body and the moments of inertia grow with the mass, as the LC26's
   * uniform-box body does. Its weight acts at the tank (`ChassisData.fuelTank`; at the CG without one), so a tank
   * behind the CG moves the weight split rearward. The spring preloads keep the load they were last set for
   * (`refreshStaticGeometry` sets them for this load), so a car that burns fuel rises on its springs.
   */
  public setFuelMass(kg: number): void {
    const fuel = Number.isFinite(kg) ? Math.max(0, kg) : 0;
    if (fuel === this.fuelKg) return;
    const ch = this.config.chassis;
    this.fuelKg = fuel;
    this.totalMassKg = ch.totalMassKg + fuel;
    this.sprungMassKg = this.totalMassKg - 2 * ch.unsprungMassFront - 2 * ch.unsprungMassRear;
    this.inertiaBody.copy(this.dryInertiaBody).multiplyScalar(this.totalMassKg / ch.totalMassKg);
  }

  private staticCornerLoad(front: boolean): number {
    const ch = this.config.chassis;
    // The fuel's weight acts at the tank: its moment about the CG moves that much load between the axles
    const tankShiftN = (this.fuelKg * G * (ch.fuelTank?.z ?? 0)) / ch.wheelbase;
    return 0.5 * (this.totalMassKg * G * (front ? ch.frontWeightFraction : 1 - ch.frontWeightFraction) + (front ? tankShiftN : -tankShiftN));
  }

  /**
   * Sine of the body's static nose-down pitch that puts the floor (or, with a ride-height map, its pickups, whose
   * own height difference is rake built into the body) at the target ride heights
   */
  private staticPitchSin(): number {
    const aero = this.config.aero;
    const built = aero.rhMap ? aero.rhMap.rearPickupY - aero.rhMap.frontPickupY : 0;
    return (aero.rear_target_height - aero.front_target_height - built) / this.config.chassis.wheelbase;
  }

  /**
   * Garage ride-height change common to both axles (m): the body rests this much higher than the configured CG
   * height (the rake comes from the target ride heights)
   */
  public rideHeightOffsetM = 0;

  /** Re-derives the static geometry after a garage change to the spring rates or ride heights */
  public refreshStaticGeometry(): void {
    this.computeStaticGeometry();
  }

  /**
   * Static hub distances and spring preloads, on flat ground at the target ride heights. A heave element in contact at
   * static (`gap` 0) is a preloaded coilover in parallel with the corner springs: from a common free ride height every
   * element is compressed alike, so it carries its rate's share of the weight and the corner springs the rest (the
   * static ride height is unchanged; VRC's preloaded heave coilovers, AC's heave springs). With a gap it only meets
   * the car after that much heave, as before.
   */
  private computeStaticGeometry(): void {
    const ch = this.config.chassis;
    const sinT = this.staticPitchSin();
    const cosT = Math.sqrt(1 - sinT * sinT);
    const cgY = ch.cgHeight + this.rideHeightOffsetM;
    for (const w of this.wheels) {
      const axle = this.axles[w.isFront ? 0 : 1];
      const tyre = this.tyres[w.isFront ? 0 : 1];
      const R0 = (w.isFront ? tyre.data.front : tyre.data.rear).radius;
      const fz = this.staticCornerLoad(w.isFront);
      const hpY = cgY + w.hardpoint.y * cosT - w.hardpoint.z * sinT;
      const hubY = R0 - fz / this.tyreVerticalRate(w);
      w.staticHubDist = (hpY - hubY) / cosT;
      const load = fz - axle.unsprungMass * G;
      const springs = axle.spec.springs;
      const heave = axle.spec.heave;
      const preloaded = axle.heaveActive && heave.rate > 0 && heave.gap <= 0;
      // Static deflection d with springForce(d) + ½·heave rate·d = load (each wheel takes half the heave force): monotonic,
      // so bisect below the corner-only deflection
      let lo = 0;
      let hi = springDeflectionFor(load, springs);
      for (let k = 0; preloaded && k < 50; k++) {
        const mid = 0.5 * (lo + hi);
        if (springForce(mid, springs) + 0.5 * heave.rate * mid > load) hi = mid;
        else lo = mid;
      }
      w.springPreload = hi;
      axle.heaveFreeM = preloaded ? -hi : heave.gap;
    }
  }

  private tyreVerticalRate(w: WheelState): number {
    const t = this.tyres[w.isFront ? 0 : 1];
    const geo = w.isFront ? t.data.front : t.data.rear;
    const thermal = tyreCarcassStiffnessFactor(t.data.thermalData, w.coreTempC);
    return t.pressureSpring.evaluate(w.pressurePsi) * geo.verticalRateScale * thermal;
  }

  private totalRatio(): number {
    const gb = this.config.gearbox;
    if (this.gear > 0) return gb.ratios[this.gear - 1] * gb.finalDrive;
    if (this.gear < 0) return -gb.reverse * gb.finalDrive;
    return 0;
  }

  /** Engine rpm the road speed implies in `gear` (driven wheels' rolling radius, no wheelspin); needs `updateBasis` */
  private roadRpm(gear: number, speedMs = Math.abs(this.velocity.dot(_ez))): number {
    const gb = this.config.gearbox;
    if (gear < 1) return 0;
    const [dl, dr] = this.drivenWheels;
    const r = Math.max(0.2, 0.5 * (this.wheels[dl].rollingRadius + this.wheels[dr].rollingRadius) || 0.35);
    return (speedMs / r) * gb.ratios[gear - 1] * gb.finalDrive * RADS2RPM;
  }

  /** Mean spin of the driven wheels (rad/s) */
  private drivenOmega(): number {
    const [dl, dr] = this.drivenWheels;
    return 0.5 * (this.wheels[dl].omega + this.wheels[dr].omega);
  }

  /** Lowest gear that keeps the road rpm under the upshift point */
  private gearForSpeed(speedMs: number): number {
    const n = this.config.gearbox.ratios.length;
    for (let g = 1; g <= n; g++) if (this.roadRpm(g, speedMs) < this.config.gearbox.gears.upshift_rpm) return g;
    return n;
  }

  // ===========================================================================
  // Inputs, shifting, DRS
  // ===========================================================================

  private sanitizeInputs(i: VehicleInputs): VehicleInputs {
    const c = clamp;
    const fin = (v: number) => (Number.isFinite(v) ? v : 0);
    return {
      throttle: c(fin(i.throttle), 0, 1),
      brake: c(fin(i.brake), 0, 1),
      ignitionCut: i.ignitionCut === undefined ? undefined : c(fin(i.ignitionCut), 0, 1),
      steer: c(fin(i.steer), -1, 1),
      brakeWheelScale: i.brakeWheelScale
        ? [c(fin(i.brakeWheelScale[0]), 0, 1), c(fin(i.brakeWheelScale[1]), 0, 1), c(fin(i.brakeWheelScale[2]), 0, 1), c(fin(i.brakeWheelScale[3]), 0, 1)]
        : undefined,
      clutch: i.clutch === undefined ? undefined : c(fin(i.clutch), 0, 1),
      handbrake: i.handbrake === undefined ? undefined : c(fin(i.handbrake), 0, 1),
      shiftUp: !!i.shiftUp,
      shiftDown: !!i.shiftDown,
      neutral: !!i.neutral,
      drs: !!i.drs,
    };
  }

  private handleEdges(inp: VehicleInputs): void {
    if (inp.shiftUp && !this.prevInputs.shiftUp) this.paddleShift(1);
    if (inp.shiftDown && !this.prevInputs.shiftDown) this.paddleShift(-1);
    // After the paddles: both pressed at once (the usual way to ask for neutral) end in neutral, whatever they did first
    if (inp.neutral && !this.prevInputs.neutral) this.selectNeutral();
    // The flap button: opens the flaps (or keeps the press for the zone ahead, `updateDrs`), shuts them when open, and
    // a second press takes back a kept one
    if (inp.drs && !this.prevInputs.drs) {
      if (this.drsOpen || this.drsQueue) {
        this.drsRequested = false;
        this.drsQueue = null;
      } else {
        this.drsRequested = true;
      }
    }
    this.prevInputs.shiftUp = !!inp.shiftUp;
    this.prevInputs.shiftDown = !!inp.shiftDown;
    this.prevInputs.neutral = !!inp.neutral;
    this.prevInputs.drs = !!inp.drs;
  }

  /** The driver's paddle: shifts now, or once the shift under way is done (one press is kept), as the auto box waits */
  private paddleShift(dir: -1 | 1): void {
    if (this.shiftTimer > 0) {
      this.pendingShift = dir;
      return;
    }
    if (this.requestShift(this.gear + dir)) this.manualShift.shifted(dir, this.gear);
  }

  /** Takes the gear out at any speed: a shift waiting behind the one under way is dropped */
  private selectNeutral(): void {
    this.pendingShift = 0;
    this.manualShift.clear();
    if (this.gear === 0) return;
    this.gear = 0;
    this.shiftTimer = this.config.gearbox.shiftTimeS;
    this.onEvent?.({ type: 'GEAR', gear: 0 });
  }

  private requestShift(target: number): boolean {
    const gb = this.config.gearbox;
    // Out of neutral on the move, either paddle (or the auto box) puts in the gear that fits the road speed, the ECU
    // matching the revs to it: first gear at speed would throw the engine far past its limit. At a standstill, up is
    // first and down is reverse
    if (this.gear === 0) this.updateBasis();
    const forwardMs = this.gear === 0 ? this.velocity.dot(_ez) : 0;
    const fromNeutralMoving = forwardMs > 2;
    if (fromNeutralMoving) target = this.gearForSpeed(forwardMs);
    let g = clamp(target, -1, gb.ratios.length);
    // A sequential box has no neutral between first and reverse: down from first is reverse (only near standstill,
    // below), up from reverse is first
    if (g === 0) g = target < this.gear ? -1 : 1;
    if (g === this.gear) return false;
    // Over-rev protection on downshifts (seamless boxes refuse the shift)
    if (g > 0 && g < this.gear) {
      this.updateBasis();
      const margin = gb.downshift?.overRevRpm ?? -200;
      if (this.roadRpm(g) > gb.gears.redline_rpm + margin) return false;
    }
    // Reverse only near standstill
    if (g < 0 && this.velocity.length() > 2) return false;
    const down = g > 0 && g < this.gear;
    if (g > this.gear) this.sinceUpshiftS = 0;
    if (down) this.sinceDownshiftS = 0;
    // A managed up-shift: the engine meets the new gear at the speed the driven wheels turn at, so the closed clutch
    // does not spin them up with the engine's inertia. The wheels' speed, not the road's: a spinning axle keeps its spin
    if (gb.upshiftCutS && gb.upshiftNeutralS === undefined && this.gear > 0 && g > this.gear && this.clutchEngagement > 0.5) {
      this.engineOmega *= gb.ratios[g - 1] / gb.ratios[this.gear - 1];
    }
    this.gear = g;
    this.shiftTimer = down ? (gb.downshiftTimeS ?? gb.shiftTimeS) : gb.shiftTimeS;
    if (fromNeutralMoving && !this.stall.stalled) {
      this.engineOmega = Math.max(this.engineOmega, Math.min(this.roadRpm(g), gb.gears.redline_rpm) * RPM2RADS);
    }
    // The ECU blips the engine up to the new gear's road speed on a downshift, so the closed clutch does not
    // jerk the rear axle down by the engine's inertia (that impulse locked the rears under trail braking).
    // Road speed, not wheel speed: matching spinning wheels would feed the wheelspin.
    // A car with its own down-shift gets there by its blip and its clutch (`solveDrivetrain`)
    if (down && !gb.downshift && this.clutchEngagement > 0.5 && !this.stall.stalled) {
      const target = Math.min(this.roadRpm(g), gb.gears.redline_rpm) * RPM2RADS;
      this.engineOmega = Math.max(this.engineOmega, target);
    }
    this.onEvent?.({ type: 'GEAR', gear: g });
    return true;
  }

  private autoShiftFor(throttle: number, brake: number): void {
    if (!this.autoShift || this.shiftTimer > 0) return;
    if (this.gear === 0 && throttle > 0.1) {
      this.requestShift(1);
      return;
    }
    if (this.gear < 1) return;
    this.updateBasis();
    const a = this.autoShiftIn;
    const road = this.roadRpm(this.gear);
    a.gear = this.gear;
    a.topGear = this.config.gearbox.ratios.length;
    // Wheelspin may lift the engine at most 30 % over road speed for shift purposes; road speed while the clutch slips.
    // A box that shifts through wheelspin goes by the engine itself, once the gear above would not lug
    const sched = this.autoShiftSchedule;
    const bySpin =
      sched.upshiftWhileSpinning === true &&
      this.gear < a.topGear &&
      this.roadRpm(this.gear + 1) >= sched.lugRpm + sched.downshiftMarginRpm;
    a.engineRpm = this.clutchEngagement >= 0.99 ? Math.min(this.rpm, bySpin ? Infinity : road * 1.3) : road;
    a.roadRpm = road;
    // Downshifts go by road speed: locked wheels must not drag the box down through the gears
    a.lowerGearRpm = this.roadRpm(this.gear - 1);
    a.throttle = throttle;
    a.brake = brake;
    a.sinceUpshiftS = this.sinceUpshiftS;
    a.sinceDownshiftS = this.sinceDownshiftS;
    // Every driven wheel: a four-wheel-drive car's coupled axle too
    let grounded = false;
    let spin = -Infinity;
    for (const i of this.allDrivenWheels) {
      grounded ||= this.wheels[i].fz > 1;
      spin = Math.max(spin, this.wheels[i].slipRatio);
    }
    a.drivenGrounded = grounded;
    a.drivenSpinning = spin > 0.14;
    const shift = autoShift(a, sched, this.manualShift);
    if (shift === 0) return;
    const throughSpin = shift > 0 && a.drivenSpinning && road < sched.upshiftRpm;
    // A shift taken through wheelspin is held like the driver's own: the gear below would only spin again
    if (this.requestShift(this.gear + shift) && throughSpin) this.manualShift.shifted(1, this.gear);
  }

  /**
   * Where the flaps may open, as one list of stretches: the circuit's zones, and for a car whose zones need no
   * detection (2026 Straight Mode) its straights too, joined where they meet
   */
  /** The flaps that open now: `drsFlaps`, but only the front ones in 2026 Low Grip Conditions (`flapsLowGrip`) */
  private get openFlaps(): 'front-rear' | 'rear' | 'front' {
    return this.flapsLowGrip === true && this.drsFlaps === 'front-rear' ? 'front' : this.drsFlaps;
  }

  private flapStretches(): readonly LapWindow[] {
    return this.flapStretchInfo().list;
  }

  private flapStretchInfo(): { list: readonly LapWindow[]; noticeAt: readonly number[] } {
    const gated = this.drsGatedByDetection;
    if (this.flapStretchCache?.gated !== gated) {
      const list = mergeLapWindows(gated ? this.drsZones : [...this.drsZones, ...this.straightZones]);
      // `STRAIGHT_NOTICE_M` before each; where that is still on the stretch before it (a short corner or a kink
      // between two), as the car leaves that one
      const lead = this.lapLengthM > 0 ? STRAIGHT_NOTICE_M / this.lapLengthM : 0;
      const noticeAt = list.map((w) => {
        const at = (((w.start - lead) % 1) + 1) % 1;
        const before = list.find((o) => o !== w && inLapWindow(at, o.start, o.end));
        return before ? before.end : at;
      });
      this.flapStretchCache = { gated, list, noticeAt };
    }
    return this.flapStretchCache;
  }

  private updateDrs(inp: VehicleInputs, dt: number): void {
    let inZone = true;
    let armed = true;
    let p = Number.NaN;
    if (this.locateProgress && Number.isFinite(this.position.x) && Number.isFinite(this.position.z)) {
      p = this.locateProgress(this.position.x, this.position.z);
      const prev = this.trackProgress;
      if (Number.isFinite(prev) && Number.isFinite(p)) {
        if (prev > 0.9 && p < 0.1) this.resetLapEnergy(true);
        // Detection points crossed going forward this step (a jump of more than 5 % of a lap is a teleport)
        let d = p - prev;
        if (d > 0.5) d -= 1;
        else if (d < -0.5) d += 1;
        // A car without DRS (a pre-2011 season) is never judged at the detection points: no "DRS enabled" call
        if (d > 0 && d < 0.05 && this.drsFitted) {
          for (const zone of this.drsZones) {
            const ahead = (((zone.detection - prev) % 1) + 1) % 1;
            if (ahead > 0 && ahead <= d) {
              const eligible = this.drsEligibleAtDetection ? this.drsEligibleAtDetection(zone) : true;
              this.drsArmedZone = eligible ? zone.id : null;
              this.onEvent?.({ type: 'DRS_DETECTION', zone: zone.id, eligible });
            }
          }
          // 2026 Straight Mode has no detection: the car is told of each stretch `STRAIGHT_NOTICE_M` before it starts
          // (or as it leaves the one before, when that is nearer)
          if (!this.drsGatedByDetection && this.lapLengthM > 0) {
            for (const at of this.flapStretchInfo().noticeAt) {
              const ahead = (((at - prev) % 1) + 1) % 1;
              if (ahead > 0 && ahead <= d) {
                this.onEvent?.({ type: 'STRAIGHT_MODE_AHEAD' });
                break;
              }
            }
          }
        }
      }
      this.trackProgress = p;
      // Low Grip Conditions: each stretch from `LOW_GRIP_ZONE_DELAY_M` later (the FIA's Low Grip Activation Zones)
      const delay = this.flapsLowGrip === true && this.lapLengthM > 0 ? LOW_GRIP_ZONE_DELAY_M / this.lapLengthM : 0;
      const zone = Number.isFinite(p) ? this.drsZones.find((z) => inDelayedLapWindow(p, z.start, z.end, delay)) : undefined;
      // Leaving the zone spends its eligibility
      if (!zone && this.lastDrsZoneId !== null && this.drsArmedZone === this.lastDrsZoneId) this.drsArmedZone = null;
      this.lastDrsZoneId = zone?.id ?? null;
      // A straight outside the zones: open to a car whose zones need no detection, and never to one that does
      const straight =
        zone === undefined &&
        !this.drsGatedByDetection &&
        Number.isFinite(p) &&
        this.straightZones.some((z) => inDelayedLapWindow(p, z.start, z.end, delay));
      inZone = zone !== undefined || straight;
      armed = straight || (zone !== undefined && (!this.drsGatedByDetection || this.drsArmedZone === zone.id));
    }
    if (!this.drsFitted) inZone = armed = false;
    // Too wet, or race control's yellow flag: the flaps stay shut (and an open one closes). Under race control's grip
    // call (2026) the call decides: Low Grip Conditions leave the front flaps (`openFlaps`)
    const dryEnoughForDrs = (this.flapsLowGrip !== null || isRearFlapAllowedInWet(this.wetness)) && !this.flapsBarred?.();
    this.telemetry.drsZone = inZone;
    this.telemetry.drsAvailable = inZone && armed && dryEnoughForDrs;
    // Closes on the brake, a lift, or when track wetness exceeds the rear flap threshold
    const braking = inp.brake > 0.05;
    const lifted = braking || inp.throttle < this.config.aero.drsCloseThrottle;
    const canOpen = inZone && armed && dryEnoughForDrs && !lifted;
    // A press the flaps can't answer yet (before the zone, or in it off the throttle) is kept for the stretch the car
    // is on or the next one within reach; elsewhere it does nothing, as before. Never for a stretch where they can't
    // open on this pass whatever the driver does: too wet, or a DRS zone whose detection point the car passed without
    // earning it (before that point it is not known yet). A zone is the stretch's when its middle is on it (the joined
    // stretches' ends are the zones' own, give or take the rounding of the join)
    const barred = (w: LapWindow): boolean =>
      !dryEnoughForDrs ||
      (this.drsGatedByDetection &&
        this.drsZones.some(
          (z) =>
            this.drsArmedZone !== z.id &&
            inLapWindow(p, z.detection, z.end) &&
            inLapWindow((z.start + ((((z.end - z.start) % 1) + 1) % 1) / 2) % 1, w.start, w.end)
        ));
    if (this.drsRequested && !this.drsOpen && !canOpen) {
      this.drsRequested = false;
      const target = this.drsFitted && this.lapLengthM > 0 ? lapWindowFor(p, this.flapStretches(), this.lapLengthM, FLAP_PRESS_REACH_M) : null;
      if (target && !barred(target.window)) this.drsQueue = { window: target.window, reached: false, waitedS: 0 };
    }
    const q = this.drsQueue;
    if (q) {
      q.waitedS += dt;
      const onIt = inLapWindow(p, q.window.start, q.window.end);
      q.reached ||= onIt;
      // Lapses past the stretch, on the brake on it (that straight is over), when the car never gets there, or once
      // the flaps can't open there on this pass
      if (q.waitedS > FLAP_PRESS_MAX_WAIT_S || (q.reached && !onIt) || (onIt && braking) || barred(q.window)) this.drsQueue = null;
      else if (onIt && canOpen) {
        this.drsRequested = true;
        this.drsQueue = null;
      }
    }
    this.telemetry.drsQueued = this.drsQueue !== null;
    const open = this.drsRequested && canOpen;
    if (!open) this.drsRequested = false;
    if (open !== this.drsOpen) {
      this.drsOpen = open;
      this.onEvent?.({ type: 'CHANGED_DRS_OPEN', open });
    }
    const rate = dt / Math.max(1e-3, this.config.aero.drsTransitionS);
    this.drsBlend = clamp(this.drsBlend + (open ? rate : -rate), 0, 1);
  }

  // ===========================================================================
  // Simulation
  // ===========================================================================

  private outerStep(inp: VehicleInputs): void {
    const dt = VehiclePhysics.FIXED_DT;
    this.lastInputs = inp;
    this.wallContactStep = false;
    this.wallImpactStep = 0;
    this.updateDrs(inp, dt);
    if (this.pendingShift !== 0 && this.shiftTimer <= 0) {
      const dir = this.pendingShift;
      this.pendingShift = 0;
      this.paddleShift(dir);
    }
    this.autoShiftFor(inp.throttle, inp.brake);
    this.prevVelocity.copy(this.velocity);
    const substeps = this.activeSubsteps;
    const h = dt / substeps;
    const tick = this.aiStepTick++;
    // AI cars probe the collider once every 2nd outer step (4 ms) when all 4 wheels are grounded,
    // and every outer step if any wheel is airborne so landings are never delayed.
    const anyAirborne =
      !this.wheels[0].grounded || !this.wheels[1].grounded || !this.wheels[2].grounded || !this.wheels[3].grounded;
    const probeGroundThisStep = !this.aiLitePhysics || (tick & 1) === 0 || anyAirborne;
    for (let k = 0; k < substeps; k++) {
      this.probeElapsedS += h;
      const doProbe = !this.aiLitePhysics || (probeGroundThisStep && k === 0);
      this.substep(h, inp, doProbe, doProbe ? this.probeElapsedS : h);
      if (doProbe) this.probeElapsedS = 0;
    }
    this.iceMechanicalPowerW = this.stepPowerSamples > 0 ? this.stepIcePowerSumW / this.stepPowerSamples : 0;
    this.driveshaftPowerW = this.stepPowerSamples > 0 ? this.stepShaftPowerSumW / this.stepPowerSamples : 0;
    this.stepIcePowerSumW = 0;
    this.stepShaftPowerSumW = 0;
    this.stepPowerSamples = 0;
    if (this.coolantModel) this.stepCoolant(dt);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.manualShift.tick(dt);
    this.sinceUpshiftS += dt;
    this.sinceDownshiftS += dt;
    this.limiterTimer = Math.max(0, this.limiterTimer - dt);
    // Turbo: spools toward the boost the cylinders' air asks for, faster the more exhaust there is; runs down slowly
    const turbo = this.config.engine.turbo;
    if (turbo && this.turbocharged) {
      const target = turboBoostAsked(turbo, this.rpm, Math.max(this.icePlate, this.iceArbPlate));
      const tau = target > this.turboBoost ? (turbo.spoolUpS * turbo.spoolRefRpm) / Math.max(this.rpm, this.config.engine.idleRpm) : turbo.spoolDownS;
      this.turboBoost += (target - this.turboBoost) * Math.min(1, dt / tau);
      this.turboBoostBar = 1 + (turbo.displayMaxBoostBar * this.turboBoost) / turbo.maxBoost;
    } else {
      this.turboBoostBar = 1;
    }
    if (!this.aiLitePhysics) {
      this.updateThermal(dt);
    } else if ((tick & 3) === 0) {
      this.updateThermal(dt * 4);
    }
    this.updateOutputs(dt);
    if (!this.aiLitePhysics) {
      // Keep the newest samples: a long frame drops its oldest, not its latest, torque
      if (this.ffbSubframeSamples.length >= FFB_SUBFRAME_MAX) this.ffbSubframeSamples.shift();
      // The mean of the step's substeps, not its last: a 500 Hz sample of the 2 kHz torque without the aliasing
      this.ffbSubframeSamples.push(-(this.ffbStepSamples > 0 ? this.ffbStepSum / this.ffbStepSamples : this.telemetry.ffbTorqueNorm));
    }
    this.ffbStepSum = 0;
    this.ffbStepSamples = 0;
  }

  private updateBasis(): void {
    _m.makeRotationFromQuaternion(this.quaternion);
    _ex.setFromMatrixColumn(_m, 0);
    _ey.setFromMatrixColumn(_m, 1);
    _ez.setFromMatrixColumn(_m, 2);
  }

  /** Apply a world force at a world point on the body */
  private addForceAt(f: THREE.Vector3, point: THREE.Vector3): void {
    this.force.add(f);
    _r.subVectors(point, this.position);
    this.torque.add(_tmp.crossVectors(_r, f));
  }

  /**
   * Aero drag −`perMs`·air (N) at the drag's centre of pressure, `centreY` above the CG (`AeroData.dragCentreY` unless
   * given): above the CG it pitches the nose up and loads the rear axle, as the rear wing's and wheels' drag do on the
   * real car
   */
  private addDragAtCentre(air: THREE.Vector3, perMs: number, centreY = this.config.aero.dragCentreY ?? 0): void {
    _f.copy(air).multiplyScalar(-perMs);
    _p.set(0, centreY, 0).applyQuaternion(this.quaternion).add(this.position);
    this.addForceAt(_f, _p);
  }

  /**
   * Gyroscopic torque a front wheel puts on the steering (Nm, + = toward left lock, as the rack sum). Its spin momentum
   * I·ω lies along the axle; turning the wheel about its rolling axis `fw` at rate p (body roll, plus the camber the
   * suspension gives it over a bump: the axle's kinematic camber gain × bump rate) precesses it, and the steering arm
   * takes the part about the steering axis, −I·ω·p. Lean the top right and the wheel steers right, as a bicycle wheel
   * does. The camber the steering itself adds (caster, kingpin inclination) is left out: that turn is about the
   * steering axis, and a precession about an axis puts no torque about that same axis.
   */
  private wheelGyroSteerNm(w: WheelState, fw: THREE.Vector3): number {
    const axle = this.axles[w.isFront ? 0 : 1];
    // Bump camber rate, leaning + left (the left wheel's camber is its lean to the left, the right's to the right);
    // leaning + left turns the wheel about −fw
    const camberRate = (w.isLeft ? 1 : -1) * axle.spec.camberGainKinematic * DEG2RAD * w.compressionVel;
    const p = this.angularVelocity.dot(fw) - camberRate;
    return -axle.wheelInertia * w.omega * p;
  }

  /**
   * Engine coolant: the engine rejects about its own power again into the water (`COOLANT_HEAT_SHARE` of it here, the
   * rest leaves by the exhaust), the radiator sheds it by the air through it, more open by the garage's steps. Sized so
   * a baseline radiator holds ≈ 105 °C flat out at 80 m/s on a 25 °C day; taped up two steps it passes the derate
   */
  private stepCoolant(dt: number): void {
    const peakW = this.peakEnginePowerW;
    const v = Math.max(0, this.velocity.dot(_ez));
    const open = Math.max(0.2, 1 + COOLANT_RADIATOR_STEP * this.coolingSteps.radiator);
    // Flat out at 80 m/s (the speed term at its 1.45) the baseline radiator holds 80 K over the air
    const gRef = (COOLANT_HEAT_SHARE * peakW) / (80 * 1.45);
    const g = gRef * open * (0.25 + 0.75 * Math.min(1.6, v / 50));
    const heat = COOLANT_HEAT_SHARE * this.iceMechanicalPowerW + 0.04 * peakW * (this.rpm / Math.max(1, this.config.gearbox.gears.redline_rpm));
    const cap = COOLANT_CAPACITY_S * gRef;
    this.coolantTempC += ((heat - g * (this.coolantTempC - this.ambientC)) / cap) * dt;
  }

  /** The engine control's torque share for the coolant temperature (1 below 112 °C, down to 0.82) */
  private coolantDerate(): number {
    if (!this.coolantModel || this.coolantTempC <= COOLANT_DERATE_FROM_C) return 1;
    return Math.max(0.82, 1 - 0.015 * (this.coolantTempC - COOLANT_DERATE_FROM_C));
  }

  /** Roll of an axle's structure against the rigid body's mean (rad, about body +Z) */
  private axleTwistRad(front: boolean): number {
    return (front ? 1 - this.torsionFrontShare : -this.torsionFrontShare) * this.chassisTwistRad;
  }

  /** Moment about body +Z through the CG of a world force at a world point (Nm) */
  private rollMomentOf(f: THREE.Vector3, point: THREE.Vector3): number {
    const rx = point.x - this.position.x;
    const ry = point.y - this.position.y;
    const rz = point.z - this.position.z;
    return _ez.x * (ry * f.z - rz * f.y) + _ez.y * (rz * f.x - rx * f.z) + _ez.z * (rx * f.y - ry * f.x);
  }

  /**
   * The chassis twist over one sub-step: the front structure's share of the roll moments against the rear's drives the
   * twist mode (reduced inertia αf·αr·I_roll, the mean roll staying the rigid body's), held by the structure's stiffness
   * and damping. Implicit in both, so any stiffness is stable; the corners' forces react to the twist at the next step
   */
  private stepChassisTwist(h: number): void {
    const af = this.torsionFrontShare;
    const ar = 1 - af;
    const tau = ar * this.rollTorqueFront - af * this.rollTorqueRear;
    this.rollTorqueFront = 0;
    this.rollTorqueRear = 0;
    const invI = 1 / Math.max(1e-6, af * ar * this.inertiaBody.z);
    const k = this.torsionK;
    const c = this.torsionC;
    this.chassisTwistVelRadS =
      (this.chassisTwistVelRadS + h * invI * (tau - k * this.chassisTwistRad)) / (1 + h * c * invI + h * h * k * invI);
    const next = this.chassisTwistRad + h * this.chassisTwistVelRadS;
    if (Math.abs(next) > this.torsionMaxRad) {
      this.chassisTwistRad = Math.sign(next) * this.torsionMaxRad;
      this.chassisTwistVelRadS = 0;
    } else {
      this.chassisTwistRad = next;
    }
  }

  private substep(h: number, inp: VehicleInputs, queryGround = true, probeDt = h): void {
    this.updateBasis();
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    const upY = Math.max(0.3, _ey.y);

    // ---- corner kinematics & ground contact
    const twisting = this.torsionK > 0;
    for (const w of this.wheels) {
      w.hardpointWorld.copy(w.hardpoint);
      if (twisting) {
        // The axle structure's own roll about body +Z through the CG: the hardpoint moves by φ (ez × r)
        const phi = this.axleTwistRad(w.isFront);
        w.hardpointWorld.x -= phi * w.hardpoint.y;
        w.hardpointWorld.y += phi * w.hardpoint.x;
      }
      w.hardpointWorld.applyQuaternion(this.quaternion).add(this.position);
      _r.subVectors(w.hardpointWorld, this.position);
      w.hardpointVel.crossVectors(this.angularVelocity, _r).add(this.velocity);
      if (twisting) {
        const rate = (w.isFront ? 1 - this.torsionFrontShare : -this.torsionFrontShare) * this.chassisTwistVelRadS;
        _tmp.set(-rate * w.hardpoint.y, rate * w.hardpoint.x, 0).applyQuaternion(this.quaternion);
        w.hardpointVel.add(_tmp);
      }
      if (queryGround) {
        w.grounded = this.queryContactPatch(w);
        if (w.grounded) {
          this.climbStep(w, probeDt);
          w.groundRefX = w.hardpointWorld.x;
          w.groundRefY = w.ground.height;
          w.groundRefZ = w.hardpointWorld.z;
        } else {
          w.contactY = Number.NaN;
        }
      } else if (w.grounded) {
        // Project onto the tangent plane captured at substep 0 so grades/banking have zero sawtooth step
        const g = w.ground;
        const ny = Math.max(0.2, g.ny);
        const planeY = w.groundRefY - (g.nx * (w.hardpointWorld.x - w.groundRefX) + g.nz * (w.hardpointWorld.z - w.groundRefZ)) / ny;
        g.height = planeY;
        w.contactY = planeY;
      }
      w.compression = w.staticHubDist - (w.hardpointWorld.y - w.hubY) / upY;
      w.compressionVel = (w.hubVy - w.hardpointVel.y) / upY;
    }

    // ---- 3D double-wishbone + steering tie-rod kinematics
    const frontKin = solveAxleKinematics3D(
      this.frontSuspHardpoints,
      this.wheels[0].compression,
      this.wheels[1].compression,
      -inp.steer * this.maxSteerRad,
      this.config.chassis.trackWidthFront,
      this.wheels[0].loadedRadius || this.tyres[0].data.front.radius,
      this.wheels[1].loadedRadius || this.tyres[0].data.front.radius,
      this.frontKin
    );
    const rearKin = solveAxleKinematics3D(
      this.rearSuspHardpoints,
      this.wheels[2].compression,
      this.wheels[3].compression,
      0,
      this.config.chassis.trackWidthRear,
      this.wheels[2].loadedRadius || this.tyres[1].data.rear.radius,
      this.wheels[3].loadedRadius || this.tyres[1].data.rear.radius,
      this.rearKin
    );

    // ---- suspension forces (+ = pushes the body up and the hub down)
    const vPitch = 0.5 * (0.5 * (this.wheels[0].compressionVel + this.wheels[1].compressionVel) -
      0.5 * (this.wheels[2].compressionVel + this.wheels[3].compressionVel));
    for (let ai = 0; ai < 2; ai++) {
      const axle = this.axles[ai];
      const s = axle.spec;
      const d = axle.dampers;
      const knee = d.fastThresholdMs;
      const reboundKnee = d.fastReboundThresholdMs ?? knee;
      const L = this.wheels[ai * 2];
      const R = this.wheels[ai * 2 + 1];
      const kinAxle = ai === 0 ? frontKin : rearKin;
      const bs = s.bumpStop;
      const freeTravel = bs.range - (bs.packerGap ?? 0);
      // The bump rubber's damping is held to what the hub's explicit step follows (1 − c·h / m ≥ 0.65)
      const rubberDampMax = (0.35 * axle.unsprungMass) / h;
      for (let side = 0; side < 2; side++) {
        const w = side === 0 ? L : R;
        // The rocker's leverage: the wheel rate × leverage² (virtual work), the damper's force × leverage at the shaft
        // speed × leverage, so its knee is the shaft's own. 1 at static ride height
        const mr = (side === 0 ? kinAxle.left : kinAxle.right).motionRatioNorm;
        let f = mr * mr * springForce(w.springPreload + w.compression, s.springs);
        const intoRubber = w.compression - freeTravel;
        if (intoRubber > 0) f += bumpRubberForce(bs, intoRubber, w.compressionVel, rubberDampMax);
        const hard = bs.hardStop;
        if (hard && w.compression > hard.range) f += hard.rate * (w.compression - hard.range);
        const pastDroop = -s.droopTravel - w.compression;
        if (pastDroop > 0) f -= DROOP_STOP_RATE * pastDroop + DROOP_STOP_DAMP * Math.max(0, -w.compressionVel);
        f += mr * damperForce(d.base, mr * w.compressionVel, knee, reboundKnee);
        w.suspensionForce = f;
        w.bumpStopTravel = freeTravel - w.compression;
      }
      const arb = s.arb * (L.compression - R.compression);
      const roll = damperForce(d.roll, 0.5 * (L.compressionVel - R.compressionVel), knee);
      L.suspensionForce += arb + roll;
      R.suspensionForce -= arb + roll;
      if (axle.heaveActive) {
        const heave = 0.5 * (L.compression + R.compression);
        const hv = 0.5 * (L.compressionVel + R.compressionVel);
        const hx = Math.max(0, heave - axle.heaveFreeM);
        const heaveKnee = d.heaveFastThresholdMs ?? knee;
        const fh =
          (s.heave.rate + (s.heave.progressiveRate ?? 0) * hx) * hx +
          s.heave.packerRate * Math.max(0, heave - s.heave.packerGap) +
          damperForce(d.heave, hv, heaveKnee, d.heaveFastReboundThresholdMs ?? d.heaveFastThresholdMs ?? reboundKnee);
        L.suspensionForce += 0.5 * fh;
        R.suspensionForce += 0.5 * fh;
      }
      const fp = damperForce(d.pitch, ai === 0 ? vPitch : -vPitch, knee);
      L.suspensionForce += 0.5 * fp;
      R.suspensionForce += 0.5 * fp;
    }

    // ---- tyres: vertical, hubs, horizontal forces
    // Scratch arrays (module level) reused every 2 kHz sub-step instead of allocated
    const tyreTorque = _tyreTorque.fill(0);
    let ffbMz = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const axle = this.axles[w.isFront ? 0 : 1];
      const tyre = this.tyres[w.isFront ? 0 : 1];
      const geo = w.isFront ? tyre.data.front : tyre.data.rear;
      const model = tyre.data.modelData;
      const g = w.ground;
      // A tyre whose data states its growth with spin runs on the grown radius: contact, rolling radius and all
      const R0 = geo.radius + (geo.radiusGrowthPerRadS ?? 0) * Math.min(Math.abs(w.omega), MAX_GROWTH_SPIN_RADS);
      const dR = geo.radiusGrowthPerRadS !== undefined ? 0 : tyreCentrifugalGrowthM(w.omega);
      w.verticalRate = this.tyreVerticalRate(w);

      const kin = w.isFront
        ? (w.isLeft ? frontKin.left : frontKin.right)
        : (w.isLeft ? rearKin.left : rearKin.right);
      // The solved upright's angle against the rack's nominal one: its Ackermann and bump steer, as toe-in
      const rackSteer = w.isFront ? -inp.steer * this.maxSteerRad : 0;
      w.toeRad = (w.isLeft ? -1 : 1) * (kin.wheelSteerRad - rackSteer) + this.damageToeRad[i];
      w.casterTrailM = kin.kingpinTrailM;
      w.scrubRadiusM = kin.kingpinScrubM;

      let fz = 0;
      let delta = 0;
      if (w.grounded) {
        // Road micro-texture under the patch (position-based, so the tyre and through it the rack feel the same bumps)
        const roadDz = roadTextureHeightM(w.hardpointWorld.x, w.hardpointWorld.z, w.patchHalfLengthM, _roadSlope);
        const roadVy = _roadSlope.dhdx * w.hardpointVel.x + _roadSlope.dhdz * w.hardpointVel.z;
        delta = R0 - (w.hubY - g.height - roadDz) * g.ny;
        const vRelN = w.hardpointVel.x * g.nx + (w.hubVy - roadVy) * g.ny + w.hardpointVel.z * g.nz;
        if (delta > 0) fz = Math.max(0, w.verticalRate * delta - model.verticalDamping * vRelN);
      }
      w.fz = fz;
      stepKerbHit(w.kerbHit, fz, w.grounded, this.staticCornerLoad(w.isFront), h);
      w.deflection = Math.max(0, delta);
      w.loadedRadius = R0 - w.deflection + dR * 0.25;
      w.rollingRadius = Math.max(0.2, R0 - w.deflection / 3);

      // Wheel frame on the contact plane: the solved upright's road-wheel angle (rack, Ackermann, bump steer), the
      // setup's static toe and any damage toe
      w.steerRad =
        kin.wheelSteerRad +
        (w.isLeft ? -1 : 1) * ((w.isFront ? this.staticToeRad.front : this.staticToeRad.rear) + this.damageToeRad[i]);
      if (w.isFront && this.steerComplianceRadPerN > 0) {
        // The lateral force bends the steering toward straight; filtered (~15 ms) so the force loop stays stable
        const target = -this.steerComplianceRadPerN * w.fy;
        w.complianceRad += (target - w.complianceRad) * Math.min(1, h / STEER_COMPLIANCE_TAU_S);
        w.steerRad += w.complianceRad;
      }
      _n.set(g.nx, g.ny, g.nz);
      _fw.copy(_ez).multiplyScalar(Math.cos(w.steerRad)).addScaledVector(_ex, Math.sin(w.steerRad));
      _fw.addScaledVector(_n, -_fw.dot(_n)).normalize();
      _lw.crossVectors(_n, _fw);
      _p.set(w.hardpointWorld.x, w.grounded ? g.height : w.hubY - R0, w.hardpointWorld.z);
      _r.subVectors(_p, this.position);
      _v.crossVectors(this.angularVelocity, _r).add(this.velocity);
      const vx = _v.dot(_fw);
      const vy = _v.dot(_lw);
      const absVx = Math.abs(vx);
      w.vx = vx;
      w.vy = vy;

      // Camber relative to the road, leaning toward +left (rad): the setup's static camber plus the solved upright's
      // camber (wishbone travel, and the caster / KPI camber of the steer angle), plus the body's lean
      // (the axle structure's twist rolls its top toward −X, the right, as it lifts the left)
      const leanBody = Math.asin(clamp(_ey.dot(_lw), -1, 1)) - (twisting ? this.axleTwistRad(w.isFront) : 0);
      w.camberLeftRad = (w.isLeft ? 1 : -1) * (axle.spec.staticCamber * DEG2RAD + kin.uprightCamberRad) + leanBody;

      // Relaxation-length carcass: slip ratio and tan(slip angle), implicit in |vx|
      const rim = w.omega * w.rollingRadius;
      const vsx = rim - vx;
      w.slipVelX = vsx;
      const wWaterMm = this.wheelWaterMm[i] > 0 ? this.wheelWaterMm[i] : this.waterMm;
      const wWetness = wWaterMm > 0 ? wetnessFromWater(wWaterMm) : this.wetness;
      if (fz > 0) {
        let rx: number;
        let ry: number;
        if (tyre.brush) {
          // A brush tyre's lag: both slips follow over the same length, from its load and how far it has slid
          rx = ry = brushRelaxationLength(tyre.brush, fz, w.combinedSlip) * dynamicBristleRelaxationScale(tyre.fz0, tyre.fz0, wWetness);
        } else {
          rx = model.relaxationLengthX * dynamicBristleRelaxationScale(fz, tyre.fz0, wWetness);
          // The lateral length follows the cornering stiffness (σ = Kyα / lateral carcass stiffness), so the carcass
          // stiffness stays the one at Fz0 at every load; the bristle model's own load stretch would count load twice
          ry =
            model.relaxationLengthY *
            tyreCorneringStiffnessLoadFactor(tyre, fz) *
            dynamicBristleRelaxationScale(tyre.fz0, tyre.fz0, wWetness);
        }
        w.slipRatio = (w.slipRatio + (h * vsx) / rx) / (1 + (h * absVx) / rx);
        w.tanSlipAngle = (w.tanSlipAngle + (h * vy) / ry) / (1 + (h * absVx) / ry);
        w.slipRatio = clamp(w.slipRatio, -5, 5);
        w.tanSlipAngle = clamp(w.tanSlipAngle, -5, 5);
      } else {
        w.slipRatio *= 0.9;
        w.tanSlipAngle *= 0.9;
      }
      w.slipAngleRad = Math.atan(w.tanSlipAngle);

      let fx = 0;
      let fy = 0;
      /** The driver's share of this wheel's steer angle (the rest is toe and compliance) */
      const cmdSteerRad = w.isFront ? -inp.steer * this.maxSteerRad : 0;
      if (fz > 0) {
        const td = tyre.data;
        const cam = td.camberData;
        // Temperature grip per band (inner / middle / outer), weighted by each band's share of the contact pressure. A
        // brush tyre's grip curve is drawn against the temperature of its tread as a whole: mostly the tread's bulk,
        // under a third the surface, so a flash of surface heat or a cool straight moves it little
        const sh = w.bandLoadShares;
        computeBandLoadShares(
          sh,
          (w.isLeft ? -1 : 1) * w.camberLeftRad,
          w.pressurePsi,
          td.pressureData.optimalPsi,
          td.thermalData.pressureHeat?.crownGain ?? 0,
          tyreCentrifugalGrowthM(w.omega)
        );
        const k = tyre.brush ? GRIP_TEMP_SURFACE_SHARE : 1;
        const g0 = tyre.thermal.evaluate(w.bandCarcassTempsC[0] + k * (w.bandTempsC[0] - w.bandCarcassTempsC[0]));
        const g1 = tyre.thermal.evaluate(w.bandCarcassTempsC[1] + k * (w.bandTempsC[1] - w.bandCarcassTempsC[1]));
        const g2 = tyre.thermal.evaluate(w.bandCarcassTempsC[2] + k * (w.bandTempsC[2] - w.bandCarcassTempsC[2]));
        const thermalRaw = sh[0] * g0 + sh[1] * g1 + sh[2] * g2;
        const thermal = realismThermalGrip(thermalRaw, this.realism);
        const pressureGrip = tyrePressureGrip(td.pressureData, w.pressurePsi);
        w.thermalGrip = thermal;
        // Wear, graining, blistering, dirt and flat-spots, as the LC26's tyre model (ac-tyre computeTyreForces)
        // A brush tyre's graining softens it (below, at the peak slip) rather than costing grip; its blisters cost up to
        // a sixth of the grip
        const treadGrip = tyre.brush ? 1 / (1 + 0.2 * w.blisterLevel) : (1 - 0.08 * w.grainLevel) * (1 - 0.12 * w.blisterLevel);
        // Wear: the compound's own curve against the distance its tread has slid, else the generic curve
        const wearGrip = tyre.wearCurve ? tyre.wearCurve.evaluate(w.wear * tyre.wearOutKm) : wearGripMultiplier(w.wear);
        const degradation = wearGrip * treadGrip * (1 - 0.18 * w.dirtyLevel) * (1 - 0.05 * w.flatSpotSeverity);
        // Water: the tyre's response (film lubrication, aquaplaning past what its tread clears at this speed) and the
        // surface's (painted kerbs and grass go slicker than the asphalt in the same water)
        const severity = this.realism.wetSeverity;
        const traits = td.wetTraits ?? SLICK_TRAITS;
        const wet =
          wWaterMm > 0
            ? wetGripFactor(traits, wWaterMm, absVx, severity, w.wear) *
              surfaceWetMultiplier(g.props.wetFriction, wWetness, severity)
            : 1;
        const wlfMult =
          wWetness > 0 ? evaluateWlfGripMultiplier(traits, w.surfaceTempC, Math.hypot(vsx, vy), fz, wWetness) : 1;
        const base =
          thermal *
          wlfMult *
          pressureGrip *
          degradation *
          g.grip *
          this.trackEvolution.gripMultiplier *
          wet *
          this.damageGrip[i];

        // Camber grip: leaning into the force direction (force opposes the slip)
        const forceSign = w.tanSlipAngle > 0 ? -1 : 1;
        const gInto = w.camberLeftRad * forceSign;
        const camberGrip = tyre.camberLut
          ? clamp(tyre.camberLut.evaluate(-gInto * RAD2DEG), 0.6, 1.1)
          : clamp(1 + cam.dcamber0 * gInto + cam.dcamber1 * gInto * gInto, 0.7, 1.1);
        const gAbs = Math.abs(w.camberLeftRad);
        const camberGripX = clamp(1 + cam.dcamber0_x * gAbs + cam.dcamber1_x * gAbs * gAbs, 0.7, 1.1);
        // Peak μ at this load: the compound's load tables, else the power law about Fz0. BRAKE_DX_MOD adds
        // longitudinal grip while the tyre is braking
        const dY = tyrePeakMu(tyre, fz, 'y');
        const dX = tyrePeakMu(tyre, fz, 'x');
        // Each strip carries its share of the load on a third of the width, and grips less per newton the more it
        // carries: load piled on a shoulder (too much camber, the wrong pressure) costs grip; an even patch costs nothing
        const strip = stripLoadGrip(sh, g0, g1, g2, thermalRaw);
        const brakeMod = w.slipRatio < 0 ? 1 + tyre.brakeDxMod : 1;
        // A brush tyre loses grip with its sliding speed
        const speedGrip = tyre.brush ? brushSpeedGrip(tyre.brush, Math.hypot(vsx, vy)) : 1;
        const muY = dY * base * camberGrip * speedGrip * strip;
        const muX = dX * brakeMod * base * camberGripX * speedGrip * strip;
        w.muY = muY;
        w.muX = muX;

        let tanPeak: number;
        let s: number;
        /** Slip stiffnesses (N per unit of tan α / of slip ratio), for the patch's twist */
        let cfa: number;
        let cfk: number;
        if (tyre.brush) {
          const bt = tyre.brush;
          // Peak slip angle from the load, the grip state and the pressure; a grained tread is softer and peaks later
          tanPeak = brushPeakSlipTan(bt, fz, base, w.pressurePsi / td.pressureData.optimalPsi) * (1 + w.grainLevel);
          // Camber thrust (toward the lean) as a shift of the slip angle. It comes with rolling: a leaning tyre that
          // stands still pushes nowhere, so the shift fades in over the first metres per second
          const camberShift = Math.sin(w.camberLeftRad) * cam.camberGain * Math.min(1, absVx / CAMBER_THRUST_FULL_MS);
          const tanEff = Math.tan(Math.atan(w.tanSlipAngle) - camberShift);
          brushForces(bt, w.slipRatio, tanEff, tanPeak, _brush);
          fx = muX * fz * _brush.fx;
          fy = -muY * fz * _brush.fy;
          s = _brush.slipNorm;
          cfa = muY * fz * brushSlipStiffness(bt, tanPeak);
          cfk = muX * fz * brushSlipStiffness(bt, tanPeak / bt.longStiffnessMult);
        } else {
          // Peak slip angle at this load: the cornering stiffness saturates with load while the peak force keeps growing;
          // a warm carcass is softer, so it peaks later (its lateral carcass stiffness softens alike: same relaxation length)
          tanPeak = tyrePeakSlipTan(tyre, fz) / tyreCarcassStiffnessFactor(td.thermalData, w.coreTempC);

          // Camber thrust (toward the lean) as an equivalent slip-angle shift
          const gc = clamp(w.camberLeftRad, -tyre.camberThrustLimit, tyre.camberThrustLimit);
          const thrust = cam.camberGain * (cam.contact_camber_c1 * gc - cam.contact_camber_c2 * gc * gc * gc);
          const BC = tyre.B * tyre.C;
          const tanEff = w.tanSlipAngle - (thrust * tanPeak) / Math.max(1e-3, muY * BC);

          // Combined slip
          combinedSlipForces(tyre, model, w.slipRatio / tyre.peakSlipRatio, tanEff / tanPeak, _comb);
          fx = muX * fz * _comb.fx;
          fy = -muY * fz * _comb.fy;
          s = Math.hypot(_comb.sx, _comb.sy);
          cfa = (muY * fz * BC) / tyre.tanPeakAngle;
          cfk = (muX * fz * BC) / tyre.peakSlipRatio;
          w.corneringStiffness = (muY * fz * BC) / tanPeak;
        }
        if (tyre.brush) w.corneringStiffness = cfa;
        w.peakSlipAngleRad = Math.atan(tanPeak);
        w.combinedSlip = s;

        // Low-speed contact damping (keeps a parked car from ringing on the carcass spring)
        const invMaxX = 1 / (muX * fz);
        const invMaxY = 1 / (muY * fz);
        const slipUse = Math.hypot(fx * invMaxX, fy * invMaxY);
        const fade = Math.max(0, 1 - absVx / LOW_SPEED_FADE_MS);
        let use = slipUse;
        if (fade > 0) {
          fx += fade * LOW_SPEED_DAMPING * muX * fz * vsx;
          fy -= fade * LOW_SPEED_DAMPING * muY * fz * vy;
          const limit = Math.max(1, slipUse);
          use = Math.hypot(fx * invMaxX, fy * invMaxY);
          if (use > limit) {
            fx *= limit / use;
            fy *= limit / use;
          }
        }
        // Telemetry only: share of the friction ellipse in use (1 = on it)
        w.circleFraction = Math.min(use, 1);

        // Self-aligning moment: pneumatic trail collapsing toward the limit and over standing water (hydroplaning wedge)
        const wetTrailMult =
          wWaterMm > 0
            ? wetPneumaticTrailScale(td.wetTraits ?? SLICK_TRAITS, wWaterMm, absVx, w.wear)
            : 1;
        // The pneumatic trail at zero slip is a third of the patch half-length (brush model, parabolic pressure), or the
        // tyre's own share of it, so it grows with the load as the patch lengthens
        w.patchHalfLengthM = contactHalfLengthM(R0, w.deflection);
        const trail0 = model.trailShare === undefined ? w.patchHalfLengthM / 3 : w.patchHalfLengthM * model.trailShare;
        w.mz = -fy * trail0 * wetTrailMult * Math.max(0, 1 - s);
        const yCpShift = clamp(
          -0.35 * geo.width * Math.sin(w.camberLeftRad) + (fy / Math.max(500, fz)) * 0.018,
          -0.45 * geo.width,
          0.45 * geo.width
        );
        w.mx = fz * yCpShift;

        // Patch twist (parking torque): the wheel's yaw over the road (steering and the body's yaw) winds the rubber
        // held in the patch up against the tyre's twist stiffness; rolling lets it out, and past the spin friction
        // moment the patch slides round instead
        const patchB = PATCH_HALF_WIDTH_SHARE * geo.width;
        const kTwist = patchTwistStiffness(cfa, cfk, model.relaxationLengthY, model.relaxationLengthX, w.patchHalfLengthM, patchB);
        const maxTwist = kTwist > 0 ? (0.5 * (muX + muY) * fz * spinFrictionArmM(w.patchHalfLengthM, patchB)) / kTwist : 0;
        // The wheel's yaw rate over the road: the driver's steering (spread over the frame), the toe / compliance
        // angle's own change, and the body's yaw
        const ownSteerDelta = Number.isFinite(w.twistSteerRad) ? w.steerRad - cmdSteerRad - w.twistSteerRad : 0;
        const psiRate = (w.isFront ? this.cmdSteerRateRadS : 0) + ownSteerDelta / h + this.angularVelocity.dot(_n);
        w.twistRad = stepPatchTwist(w.twistRad, psiRate * h, absVx * h, w.patchHalfLengthM, maxTwist);
        const twistRate = psiRate - (absVx / Math.max(1e-3, w.patchHalfLengthM)) * w.twistRad;
        const mTwistMax = kTwist * maxTwist;
        w.mzTwist = -clamp(kTwist * (w.twistRad + PATCH_TWIST_DAMPING_S * twistRate), -mTwistMax, mTwistMax);
      } else {
        w.combinedSlip = 0;
        w.circleFraction = 0;
        w.patchHalfLengthM = 0;
        w.corneringStiffness = 0;
        w.mz = 0;
        w.mzTwist = 0;
        w.twistRad = 0;
        w.mx = 0;
      }
      w.twistSteerRad = w.steerRad - cmdSteerRad;
      tyreTorque[i] = -fx * w.rollingRadius;
      // Per-wheel hydrodynamic water-wedge drag: acts on the hub/chassis (pulling toward deeper puddles)
      const hydroDrag = wWaterMm > 0 && vx > 0.5 ? hydrodynamicDragN(wWaterMm, absVx, geo.width, fz) : 0;
      fx -= hydroDrag;
      w.fx = fx;
      w.fy = fy;
      // Rack torque: each front tyre's road loads about its kingpin axis (Fx at the scrub radius, Fy at the caster trail,
      // Fz's KPI / caster weight-jacking, Mz and Mx projected onto the axis), plus the flat-spot shake. Any other moment
      // about the kingpin joins this sum as its own term
      if (w.isFront) {
        // The solved upright's own kingpin ground offsets (the blended scrub / trail fields stay for the LC26)
        _kpGeo.kpiRad = kin.kpiRad;
        _kpGeo.casterRad = kin.casterRad;
        _kpGeo.scrubRadiusM = kin.kingpinScrubM;
        _kpGeo.casterTrailM = kin.kingpinTrailM;
        const tyreKingpinNm = kingpinMomentNm(
          _ex, _ey, _ez, _n, _fw, _lw, w.isLeft ? -1 : 1, w.steerRad, w.loadedRadius, _kpGeo, fx, fy, fz, w.mz + w.mzTwist, w.mx
        );
        w.gyroSteerNm = this.wheelGyroSteerNm(w, _fw);
        // A kerb's hit pushes the patch back at the scrub radius (KERB_STRIKE_FX_PER_N)
        const kerbStrikeNm =
          w.kerbHit.hitN !== 0
            ? kingpinMomentNm(
                _ex, _ey, _ez, _n, _fw, _lw, w.isLeft ? -1 : 1, w.steerRad, w.loadedRadius, _kpGeo, -KERB_STRIKE_FX_PER_N * w.kerbHit.hitN, 0, 0, 0, 0
              )
            : 0;
        // Each wheel's moment about its kingpin reaches the rack through its own tie rod's leverage now (lock and bump
        // change the steering arm's angle to the rod), against the straight-ahead ratio the steering ratio is quoted at
        ffbMz +=
          (tyreKingpinNm +
            flatSpotThumpNm(w.flatSpotSeverity, w.rotationRad, w.omega, fz, w.circumferentialWear) +
            w.gyroSteerNm +
            kerbStrikeNm) *
          kin.tieRodLeverageNorm;
      }

      // Loose ground (gravel, grass) ploughs against the contact patch's motion, sliding or rolling, outside the
      // tyre's friction circle (and so outside the wheel spin, the rack and the tyre telemetry)
      let dragX = 0;
      let dragY = 0;
      const patchSpeed = Math.hypot(vx, vy);
      const dragN = surfaceDragN(g.props?.rollingResistance ?? 0, fz, patchSpeed);
      if (dragN > 0) {
        dragX = (-dragN * vx) / patchSpeed;
        dragY = (-dragN * vy) / patchSpeed;
      }

      // Tyre forces reach the body through the links: across at the contact patch, where they act (so the whole car
      // sees the full load transfer), and up / down as the links' jacking force. That is the contact force's virtual
      // work along the patch's path per unit of travel, F · dr/dz (front view: roll centre and jacking; side view:
      // anti-dive / anti-lift), as a multibody suspension transmits it (AC's DWB, rFactor 2). The brake caliper sits on
      // the upright, so braking acts along the patch's path; a driveshaft's drive force acts along the hub's, its torque
      // going into the chassis (anti-squat, Milliken RCVD §17.4). The normal's horizontal part holds the car on slopes.
      _f.copy(_fw).multiplyScalar(fx + dragX).addScaledVector(_lw, fy + dragY);
      _f.x += fz * g.nx;
      _f.z += fz * g.nz;
      this.addForceAt(_f, _p);
      const mzBody = w.mz + w.mzTwist;
      if (mzBody !== 0) this.torque.addScaledVector(_n, mzBody);
      if (twisting) {
        const tz = this.rollMomentOf(_f, _p) + mzBody * _n.dot(_ez);
        if (w.isFront) this.rollTorqueFront += tz;
        else this.rollTorqueRear += tz;
      }
      // Contact force in the body frame, inboard (body +X is inboard on the right) and forward
      const inX = w.isLeft ? -1 : 1;
      const fIn = inX * (_f.dot(_ex) + fz * g.ny * _ex.y);
      const fFwd = _f.dot(_ez) + fz * g.ny * _ez.y;
      const tDrive = Math.abs(w.driveTorqueNm);
      const fDrive = tDrive > 0 ? (tDrive / (tDrive + w.brakeTorqueNm)) * (fx + hydroDrag) * _fw.dot(_ez) : 0;
      // The unsprung mass's own inertia (with its weight) acts at the hub: its lateral / longitudinal part loads the
      // travel along the hub's path and so reaches the tyre without passing through the spring
      const sfIn = inX * this.bodySpecificForce.dot(_ex);
      const sfFwd = this.bodySpecificForce.dot(_ez);
      const jack =
        fIn * kin.contactInboardPerBump +
        (fFwd - fDrive) * kin.contactForwardPerBump +
        fDrive * kin.hubForwardPerBump -
        axle.unsprungMass * (sfIn * kin.hubInboardPerBump + sfFwd * kin.hubForwardPerBump);

      // Hub: tyre normal force up; spring, damper and link forces down, and up on the body at the hardpoint
      const link = w.suspensionForce - jack;
      const hubAcc = (fz * g.ny - link * _ey.y) / axle.unsprungMass - G;
      w.hubVy += hubAcc * h;
      w.hubY += w.hubVy * h;
      _f.set(0, link * _ey.y, 0);
      this.addForceAt(_f, w.hardpointWorld);
      if (twisting) {
        const tz = this.rollMomentOf(_f, w.hardpointWorld);
        if (w.isFront) this.rollTorqueFront += tz;
        else this.rollTorqueRear += tz;
      }
    }
    if (twisting) this.stepChassisTwist(h);
    // The rim feels the driver's share of the rack torque, the power steering's assist taking the rest
    const driverNm = driverRackTorqueNm(ffbMz, this.velocity.dot(_ez), this.powerSteering);
    this.telemetry.ffbTorqueNorm = clamp(driverNm / FFB_REFERENCE_NM, -1, 1);
    this.ffbSum += this.telemetry.ffbTorqueNorm;
    this.ffbSamples++;
    this.ffbStepSum += this.telemetry.ffbTorqueNorm;
    this.ffbStepSamples++;

    // ---- drivetrain, brakes and wheel spin
    this.solveDrivetrain(h, inp, tyreTorque);

    // ---- aero, then the plank if the floor reaches the road
    if (this.config.aero.rhMap) this.applyMapAero(h, this.config.aero.rhMap);
    else this.applyAero();
    this.applyPlankContact(h);

    // ---- gravity and integration
    // Acceleration less gravity, for the next sub-step's unsprung inertia (the hubs ride with the body across)
    this.bodySpecificForce.set(this.force.x / this.totalMassKg, this.force.y / this.sprungMassKg, this.force.z / this.totalMassKg);
    this.force.y -= this.sprungMassKg * G;
    // The fuel's weight acts at the tank, not at the CG: the moment of that offset
    const tank = this.config.chassis.fuelTank;
    if (tank && this.fuelKg > 0) {
      _r.set(0, tank.y, tank.z).applyQuaternion(this.quaternion);
      this.torque.add(_tmp.crossVectors(_r, _f.set(0, -this.fuelKg * G, 0)));
    }
    this.velocity.x += (this.force.x / this.totalMassKg) * h;
    this.velocity.z += (this.force.z / this.totalMassKg) * h;
    this.velocity.y += (this.force.y / this.sprungMassKg) * h;
    this.wallPrevCg.copy(this.position);
    this.wallPrevQuat.copy(this.quaternion);
    this.position.addScaledVector(this.velocity, h);

    // ω̇ = I⁻¹(τ − ω × (Iω + h)), with I in body axes and h the spinning wheels' angular momentum (body frame): each
    // wheel's I·ω lies along its axle, (cos δ, 0, −sin δ) at road-wheel steer δ. Turning the car turns those momenta,
    // and the body supplies that precession through the uprights: in a corner it rolls the car outward (≈ 0.8 kNm on
    // the F1 at 250 km/h and 4 g), and a roll rate pushes back in yaw
    _w.copy(this.angularVelocity).applyQuaternion(_qd.copy(this.quaternion).invert());
    _tmp.copy(this.torque).applyQuaternion(_qd);
    const I = this.inertiaBody;
    let hx = 0;
    let hz = 0;
    for (const w of this.wheels) {
      const spin = this.axles[w.isFront ? 0 : 1].wheelInertia * w.omega;
      hx += spin * Math.cos(w.steerRad);
      hz -= spin * Math.sin(w.steerRad);
    }
    const lx = I.x * _w.x + hx;
    const ly = I.y * _w.y;
    const lz = I.z * _w.z + hz;
    const gx = _w.y * lz - _w.z * ly;
    const gy = _w.z * lx - _w.x * lz;
    const gz = _w.x * ly - _w.y * lx;
    _w.x += ((_tmp.x - gx) / I.x) * h;
    _w.y += ((_tmp.y - gy) / I.y) * h;
    _w.z += ((_tmp.z - gz) / I.z) * h;
    this.angularVelocity.copy(_w).applyQuaternion(this.quaternion);

    const ox = this.angularVelocity.x * 0.5 * h;
    const oy = this.angularVelocity.y * 0.5 * h;
    const oz = this.angularVelocity.z * 0.5 * h;
    const q = this.quaternion;
    _qd.set(ox, oy, oz, 0).multiply(q);
    q.set(q.x + _qd.x, q.y + _qd.y, q.z + _qd.z, q.w + _qd.w).normalize();

    for (const w of this.wheels) w.rotationRad = (w.rotationRad + w.omega * h) % (2 * Math.PI);

    if (!this.pinnedForSettle) this.applyWallContacts();
  }

  /** I^-1 v in world axes (body-frame diagonal inertia) */
  private applyInverseInertia(v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _qi.copy(this.quaternion).invert();
    out.copy(v).applyQuaternion(_qi);
    out.set(out.x / this.inertiaBody.x, out.y / this.inertiaBody.y, out.z / this.inertiaBody.z);
    return out.applyQuaternion(this.quaternion);
  }

  /** Inverse effective mass of the body at offset r along unit direction d */
  private inverseMassAlong(r: THREE.Vector3, d: THREE.Vector3): number {
    _rxd.crossVectors(r, d);
    this.applyInverseInertia(_rxd, _w2);
    return 1 / this.totalMassKg + d.dot(_rxd.crossVectors(_w2, r));
  }

  private applyImpulseAt(j: THREE.Vector3, r: THREE.Vector3): void {
    this.velocity.addScaledVector(j, 1 / this.totalMassKg);
    _rxd.crossVectors(r, j);
    this.angularVelocity.add(this.applyInverseInertia(_rxd, _w2));
  }

  /**
   * Ground under a wheel's contact patch (`ContactPatch.ts`): the enveloped road height and plane normal over a patch
   * as long as the tyre's deflection chord (at least `CONTACT_PATCH_MIN_HALF_LENGTH_M` each way) and as wide as its
   * tread, headed along the road wheel (last sub-step's steer). False when nothing is under the patch centre.
   */
  private queryContactPatch(w: WheelState): boolean {
    const geo = w.isFront ? this.tyres[0].data.front : this.tyres[1].data.rear;
    const R0 = geo.radius;
    const d = Math.min(Math.max(0, w.deflection), R0);
    const halfLength = Math.max(CONTACT_PATCH_MIN_HALF_LENGTH_M, Math.sqrt(d * (2 * R0 - d)));
    const c = Math.cos(w.steerRad);
    const s = Math.sin(w.steerRad);
    const fx = _ez.x * c + _ex.x * s;
    const fz = _ez.z * c + _ex.z * s;
    const fl = Math.sqrt(fx * fx + fz * fz);
    const p = w.hardpointWorld;
    // AI opponent cars probe at the hub centre alone (5× fewer triangle tests per wheel);
    // on its side or nose-down any car also probes at the hub alone
    if (this.aiLitePhysics || fl < 1e-3) return this.ground.query(p.x, p.z, p.y + GROUND_PROBE_UP_M, w.ground);
    return queryContactPatch(
      this.ground,
      p.x,
      p.z,
      p.y + GROUND_PROBE_UP_M,
      fx / fl,
      fz / fl,
      halfLength,
      TREAD_HALF_WIDTH_SHARE * geo.width,
      R0,
      CONTACT_MAX_SLOPE,
      w.ground
    );
  }

  /**
   * A tyre meets an abrupt rise (a surface seam, the edge of a raised verge) along its contact arc: over a step
   * of height d it rises across √(2Rd − d²) of travel, so the contact height climbs at most travel·√(d / 2R)
   * per step instead of jumping (a one-step jump drives the whole step into the tyre spring and launches the
   * car). Gentle grades pass straight through, and so do drops: the contact patch's trailing samples already hold the
   * tyre up on an edge until it has rolled off (`queryContactPatch`).
   */
  private climbStep(w: WheelState, h: number): void {
    const g = w.ground;
    const R0 = (w.isFront ? this.tyres[0].data.front : this.tyres[1].data.rear).radius;
    const rise = g.height - w.contactY;
    // Nothing to climb when the tyre is already clear of the new surface (or was airborne)
    if (!(rise > 0) || w.hubY - R0 >= g.height) {
      w.contactY = g.height;
      return;
    }
    const travel = Math.hypot(w.hardpointVel.x, w.hardpointVel.z) * h;
    const d = Math.min(rise, R0);
    const allowed = Math.max(travel * 0.25, travel * Math.sqrt(d / (2 * R0)), STEP_CLIMB_MIN_M);
    w.contactY = rise > allowed ? w.contactY + allowed : g.height;
    g.height = w.contactY;
  }

  /**
   * Barriers: the car's outline (its probes, and the edges between them) against the wall segments, from where it was
   * at the start of the sub-step to where it is now. A probe that went through a face this sub-step (its path entered
   * it from the CG's side), or that is past a face lying between it and the CG, is in contact with that face; and a wall
   * end or corner inside the outline (a post between the probes) is in contact with the outline's nearest edge
   * (`wallCornerContact`, `wallEndInOutline`). Each contact gets an impulse with a capped rebound and wall friction, and
   * the body is pushed back out along the contact's normal by its depth: no more than the outline really is into the
   * wall (and at most WALL_MAX_PUSH_MS worth in a sub-step). The impulse acts at the CG's height: a barrier loads the
   * whole side of the body, so a hit yaws the car but does not roll it over the wall. The CG's own path is swept
   * against the walls as well, so it can never end up behind one (the side the CG is on is what the probes measure
   * from).
   */
  private applyWallContacts(): void {
    const walls = this.walls;
    const wasTouching = this.wallContactNow;
    this.wallContactNow = false;
    if (!walls) return;
    const p = this.position;
    const prev = this.wallPrevCg;
    const n = walls.near(p.x, p.z, this.wallQueryRadius + Math.hypot(p.x - prev.x, p.z - prev.z), this.wallIds);
    if (n === 0) return;
    let impact = 0;
    let hitX = 0;
    let hitZ = 0;
    let budget = (WALL_MAX_PUSH_MS * VehiclePhysics.FIXED_DT) / this.activeSubsteps;
    if (wallSweep(walls, this.wallIds, n, prev.x, prev.z, p.x, p.z, p.y, WALL_Y_SLACK_M, _wallHit) >= 0) {
      this.wallContactNow = true;
      p.x += _wallHit.nx * (_wallHit.depth + WALL_SKIN_M);
      p.z += _wallHit.nz * (_wallHit.depth + WALL_SKIN_M);
      impact = Math.max(impact, this.wallImpulse(_r.set(0, 0, 0), _wallHit.nx, _wallHit.nz));
    }
    for (const probe of this.wallProbePoints) {
      _r.copy(probe).applyQuaternion(this.quaternion);
      _pFrom.copy(probe).applyQuaternion(this.wallPrevQuat).add(prev);
      const depth = wallCornerContact(walls, this.wallIds, n, p.x + _r.x, p.y + _r.y, p.z + _r.z, _pFrom.x, _pFrom.z, p.x, p.z, WALL_Y_SLACK_M, _wallHit);
      if (depth <= 0) continue;
      this.wallContactNow = true;
      _r.y = 0;
      const hitMs = this.wallImpulse(_r, _wallHit.nx, _wallHit.nz);
      if (hitMs > impact) {
        impact = hitMs;
        hitX = probe.x;
        hitZ = probe.z;
      }
      const push = Math.min(depth, budget);
      budget -= push;
      p.x += _wallHit.nx * (push + WALL_SKIN_M);
      p.z += _wallHit.nz * (push + WALL_SKIN_M);
    }
    // Wall ends and corners between the probes
    this.outlineEdges(this.quaternion, _outlineEdges);
    const edges = this.wallOutline.length;
    const py = p.y + _p.set(0, this.wallProbePoints[0].y, 0).applyQuaternion(this.quaternion).y;
    for (let pass = 0; pass < WALL_END_PASSES; pass++) {
      const depth = wallEndInOutline(
        walls,
        this.wallIds,
        n,
        p.x,
        p.z,
        py,
        _outlineEdges,
        edges,
        this.wallOutlineRadius,
        WALL_Y_SLACK_M,
        _wallEndHit
      );
      if (depth <= 0) break;
      this.wallContactNow = true;
      _r.set(_wallEndHit.x - p.x, 0, _wallEndHit.z - p.z);
      const hitMs = this.wallImpulse(_r, _wallEndHit.nx, _wallEndHit.nz);
      if (hitMs > impact) {
        impact = hitMs;
        // The contact point in the body frame
        _p.copy(_r).applyQuaternion(_qd.copy(this.quaternion).invert());
        hitX = _p.x;
        hitZ = _p.z;
      }
      const push = Math.min(depth, budget);
      budget -= push;
      p.x += _wallEndHit.nx * (push + WALL_SKIN_M);
      p.z += _wallEndHit.nz * (push + WALL_SKIN_M);
    }
    if (this.wallContactNow) {
      this.wallContactStep = true;
      // A new hit, or a harder one while still scraping along (a slide into the barrier, then the nose)
      if (!wasTouching) this.wallContactPeakMs = 0;
      const harder = impact >= this.wallContactPeakMs + WALL_IMPACT_HARDER_MS;
      this.wallContactPeakMs = Math.max(this.wallContactPeakMs, impact);
      this.wallImpactStep = Math.max(this.wallImpactStep, impact);
      if ((!wasTouching || harder) && impact >= WALL_IMPACT_EVENT_MS) {
        this.onEvent?.({ type: 'WALL_IMPACT', speedMs: impact, localX: hitX, localZ: hitZ });
      }
    }
  }

  /** The outline's edges at attitude `q`, relative to the CG (`wallEndInOutline`) */
  private outlineEdges(q: THREE.Quaternion, out: Float64Array): void {
    const hullIdx = this.wallOutline;
    for (let i = 0; i < hullIdx.length; i++) {
      _p.copy(this.wallProbePoints[hullIdx[i]]).applyQuaternion(q);
      _outlineCorners[2 * i] = _p.x;
      _outlineCorners[2 * i + 1] = _p.z;
    }
    writeOutlineEdges(_outlineCorners, hullIdx.length, out);
  }

  /**
   * Barrier impulse at the horizontal lever arm `r` against a wall with normal (nx, nz): the into-wall speed there
   * becomes a rebound of WALL_RESTITUTION × that speed (at most WALL_MAX_REBOUND_MS), and wall friction scrubs the
   * sliding speed along the barrier. Returns the into-wall speed (m/s, 0 when the point is already leaving).
   */
  private wallImpulse(r: THREE.Vector3, nx: number, nz: number): number {
    _n.set(nx, 0, nz);
    _v.crossVectors(this.angularVelocity, r).add(this.velocity);
    const vn = _v.dot(_n);
    if (vn >= 0) return 0;
    const jn = (Math.min(WALL_RESTITUTION * -vn, WALL_MAX_REBOUND_MS) - vn) / this.inverseMassAlong(r, _n);
    this.applyImpulseAt(_f.copy(_n).multiplyScalar(jn), r);
    _v.crossVectors(this.angularVelocity, r).add(this.velocity);
    _v.addScaledVector(_n, -_v.dot(_n));
    _v.y = 0;
    const vt = _v.length();
    if (vt > 1e-4) {
      _v.divideScalar(vt);
      const jt = Math.min(vt / this.inverseMassAlong(r, _v), WALL_FRICTION * jn);
      this.applyImpulseAt(_f.copy(_v).multiplyScalar(-jt), r);
    }
    return -vn;
  }

  /**
   * Engine, clutch, ramp LSD and brakes as velocity constraints (sequential impulses, accumulated and
   * clamped to each element's torque capacity).
   */
  private solveDrivetrain(h: number, inp: VehicleInputs, tyreTorque: Float64Array): void {
    const omegaAtStart = this.engineOmega;
    const cfg = this.config;
    const eng = cfg.engine;
    const gb = cfg.gearbox;
    const ers = cfg.ers;
    const mode = cfg.performanceModes[this.performanceMode];
    const W = this.wheels;
    const ratio = this.totalRatio();
    const rpm = this.rpm;
    const omegaE = Math.max(50, this.engineOmega);
    const manualClutch = !this.autoClutch && !this.autoShift;
    const stallRpm = stallSpeedRpm(eng.idleRpm);
    const idleOmega = eng.idleRpm * RPM2RADS;
    const stallOmega = stallRpm * RPM2RADS;
    const axleOmega = this.drivenOmega();
    const wheelSideRpm = Math.abs(axleOmega * ratio) * RADS2RPM;
    const wheelSideForwardRpm = axleOmega * ratio * RADS2RPM;

    // Switching Auto clutch (or Auto gearbox) back on recovers a stalled engine immediately
    if (!manualClutch) {
      this.engineOmega = this.stall.recoverIfAuto(this.engineOmega, idleOmega);
    }

    // ---- clutch engagement
    const cl = cfg.clutch;
    let engage = 0;
    if (this.gear !== 0) {
      if (manualClutch) {
        // Full manual clutch: pedal maps through free play and a progressive bite zone directly to torque capacity
        engage = clutchPedalEngagement(inp.clutch ?? 0);
      } else {
        // Launch: in first gear the pedal moves the bite window up to end at the car's launch rpm, so the engine revs to
        // where it has torque and the clutch slips there until the wheels have met it, instead of closing on an engine
        // near its idle. Off the pedal the window is the anti-stall one again
        let biteRpm = cl.biteRpm;
        if (cl.launchRpm !== undefined && Math.abs(this.gear) === 1) {
          const launch = clamp((inp.throttle - 0.2) / 0.6, 0, 1);
          biteRpm += launch * Math.max(0, cl.launchRpm - cl.lockRpm);
        }
        const lockRpm = biteRpm + (cl.lockRpm - cl.biteRpm);
        const t = clamp((rpm - biteRpm) / (lockRpm - biteRpm), 0, 1);
        engage = wheelSideRpm >= lockRpm ? 1 : t * t * (3 - 2 * t);
        // Anti-stall: off the pedal, with the wheels turning slower than the engine idles, the auto-clutch lets go. The
        // idle controller holds the engine at or above some cars' bite speed, and its torque through the slipping clutch
        // walked a car standing on the grid away. A pedal past 5 % has the whole clutch again, for the launch. Wheels
        // turning against the gear (a car spinning backwards off a barrier, in first) count as slower than idle: through
        // the clutch they would turn the engine backwards, and a stopped engine never starts again
        if (wheelSideForwardRpm < eng.idleRpm) {
          const pedal = clamp(inp.throttle / 0.05, 0, 1);
          const turning = smoothstep(wheelSideForwardRpm, 0.7 * eng.idleRpm, eng.idleRpm);
          engage *= Math.max(pedal, turning);
        }
        // Auto-clutch mode keeps linear 1 - clutch so manual race starts stay unchanged; the progressive bite-point
        // curve (`clutchPedalEngagement`) applies only when full manual clutch (`manualClutch`) is active.
        if (inp.clutch !== undefined) engage = Math.min(engage, clamp(1 - inp.clutch, 0, 1));
      }
      // A dog box between gears: the engine is free of the wheels
      if (gb.upshiftNeutralS !== undefined && this.sinceUpshiftS < gb.upshiftNeutralS) engage = 0;
    }

    // ---- manual-clutch stall & starter / bump-start recovery
    if (manualClutch) {
      this.engineOmega = this.stall.step(
        h,
        this.gear !== 0,
        engage,
        inp.clutch ?? 0,
        inp.throttle,
        this.engineOmega,
        axleOmega * ratio,
        idleOmega,
        stallOmega,
      );
    }

    // ---- ICE (with live Engine Torque Map 1..5)
    if (rpm >= gb.gears.redline_rpm) this.limiterTimer = eng.limiterCutS;
    const mapIdx = clamp(Math.round(this.engineMap), 1, 5);
    const engineMapTorqueScale = ENGINE_MAP_TORQUE_SCALE[mapIdx - 1] ?? 1.0;
    // The softer low-gear pedal: the driver's own choice (engine maps 4 and 5), and on a power unit with a wet pedal map
    // the ECU's on a wet road. A car without one keeps the pedal its driver set
    const wetPedalBlend = Math.max(eng.wetPedalMap ? this.wetness : 0, mapIdx >= 4 ? (mapIdx - 3) * 0.35 : 0);
    const lowGearWetExp = this.gear >= 1 && this.gear <= 4 ? (5 - this.gear) * 0.065 * wetPedalBlend : 0;
    const baseExp = (mapIdx >= 3 ? 1 + (mapIdx - 2) * 0.12 : 1) + lowGearWetExp;
    const rawThrottle = baseExp > 1 ? Math.pow(inp.throttle, baseExp) : inp.throttle;
    let plate = this.luts.throttle.evaluate(rawThrottle);
    // The blip of a down-shift opens the throttle on the free engine, through the same air path
    const dn = gb.downshift;
    const downshifting = dn !== undefined && this.sinceDownshiftS < dn.clutchHomeS && this.sinceDownshiftS < this.sinceUpshiftS;
    if (downshifting && dn.blip && this.sinceDownshiftS < Math.max(dn.neutralS, dn.clutchReleaseS) && !this.stall.stalled) {
      // Held until the engine turns as fast as the driven wheels ask of it in this gear, less what it still gains while
      // the air path empties
      const wanted = Math.min(Math.abs(axleOmega * ratio) * RADS2RPM, gb.gears.redline_rpm);
      const emptiesS = (eng.torqueResponseS?.fall ?? 0) + 60 / Math.max(rpm, eng.idleRpm);
      const stillGains = ((this.icePlate * this.luts.power.evaluate(rpm) * 1000) / omegaE / eng.inertia) * emptiesS * RADS2RPM;
      if (rpm + stillGains < wanted) plate = Math.max(plate, dn.blip.level * Math.min(1, this.sinceDownshiftS / Math.max(1e-6, dn.blip.riseS)));
    }
    // Air path: the plate the cylinders see trails the pedal's (actuator, plenum), plus one crank revolution from the
    // intake stroke to the power stroke. The idle controller (spark advance), the limiter and the spark cut below act on
    // the combustion at once
    const resp = eng.torqueResponseS;
    if (resp) {
      const tau = (plate > this.icePlate ? resp.rise : resp.fall) + 60 / Math.max(rpm, eng.idleRpm);
      this.icePlate += (plate - this.icePlate) * Math.min(1, h / tau);
    } else {
      this.icePlate = plate;
    }
    if (this.stall.stalled) {
      this.icePlate = 0;
      plate = 0;
    } else {
      const idleScale = manualClutch ? smoothstep(rpm, stallRpm, eng.idleRpm * 0.75) : 1;
      const idleFloor = clamp((eng.idleRpm + 200 - rpm) / 800, 0, 0.15) * idleScale;
      plate = Math.max(this.icePlate, idleFloor);
    }
    if (this.limiterTimer > 0) plate = 0;
    // A managed up-shift takes the drive away while it lasts: the spark, and with it the MGU-K's deployment below
    const shiftCut = gb.upshiftCutS !== undefined && this.sinceUpshiftS < gb.upshiftCutS;
    // A road car's cut is the driver's foot off: the throttle shuts too, and the engine slows on its overrun drag
    if (shiftCut && gb.upshiftCutLift) plate = 0;
    // The traction control's cut (`ignitionCut`: the torque share it allows). A hybrid under a shaft power limit cuts
    // the engine's spark first, up to three quarters of the demand, and only then the motor, whose torque is the
    // smoother and quicker to come back; any other car cuts both alike. A managed up-shift cuts everything
    // The total it takes off is what it asked for: the engine gives up its share first (by the motor's part of the last
    // step's drive torque before the cut), the motor only what the engine cannot
    const totalCut = shiftCut ? 1 : clamp(1 - (inp.ignitionCut ?? 1), 0, 1);
    const sparkFirst = ers.ERS_MAX_DEPLOY > 0 && eng.outputPowerCap !== undefined;
    let sparkShare = 1 - totalCut;
    let motorShare = 1 - totalCut;
    if (sparkFirst && !shiftCut && totalCut > 0) {
      const iceNm = Math.max(0, this.lastIceDriveNm);
      const motorNm = Math.max(0, this.lastMotorDriveNm);
      const f = iceNm + motorNm > 1 ? Math.min(SPARK_FIRST_MAX_MOTOR_SHARE, motorNm / (iceNm + motorNm)) : 0;
      sparkShare = Math.max(0, 1 - totalCut / (1 - f));
      motorShare = totalCut <= 1 - f ? 1 : Math.max(0, (1 - totalCut) / Math.max(1e-6, f));
    }
    // A motor whose torque demand may not vary fast (`ERSData.mguDemandFilter`): there its share of the cut through a
    // first-order filter at that frequency, which takes the traction control's chatter off it
    const mguFilter = ers.mguDemandFilter;
    if (mguFilter) {
      const slow =
        inp.throttle > 0.1 && inp.brake < 0.02 && !shiftCut && this.shiftTimer <= 0 && this.velocity.length() * 3.6 < mguFilter.belowKmh && this.lastIceDriveNm + this.lastMotorDriveNm > 0;
      this.mguShareFiltered = slow ? this.mguShareFiltered + (motorShare - this.mguShareFiltered) * (1 - Math.exp(-2 * Math.PI * mguFilter.maxHz * h)) : motorShare;
      motorShare = this.mguShareFiltered;
    }
    // Turbo lag: the curve is the torque with the boost this plate makes in steady state; while the rotor trails it the
    // torque is (1 + boost made) / (1 + boost asked for) of that, as torque ∝ 1 + boost. A rotor still spinning faster
    // than the demand gives no more than the demand (the wastegate and the throttle hold the plenum to it). With the
    // throttle inside the boost law the curve is the full-load torque, so the share is (1 + boost made, up to the boost
    // asked for) / (1 + the full-load boost)
    const turbo = eng.turbo;
    let boostShare = 1;
    // Share of the curve's torque the lag costs
    let lagShare = 0;
    if (turbo && this.turbocharged) {
      if (turbo.throttleInBoostLaw) {
        const full = 1 + turboSteadyBoost(turbo, rpm);
        const asked = turboBoostAsked(turbo, rpm, plate);
        boostShare = (1 + Math.min(this.turboBoost, asked)) / full;
        lagShare = Math.max(0, asked - this.turboBoost) / full;
      } else {
        boostShare = Math.min(1, (1 + this.turboBoost) / (1 + turboSteadyBoost(turbo, rpm) * plate));
        lagShare = 1 - boostShare;
      }
    }
    // Thin air (altitude, heat) costs the engine a share of what it costs the wings
    const airShare = eng.airDensitySensitivity ? 1 + eng.airDensitySensitivity * (this.airDensity / cfg.aero.airDensity - 1) : 1;
    // Ram air: the intake's dynamic pressure packs the cylinders a little fuller at speed
    let ramShare = 1;
    if (eng.ramAirGainPerKPa) {
      const vAir = Math.max(0, _air.copy(this.velocity).sub(this.windWorld).dot(_ez));
      ramShare = 1 + eng.ramAirGainPerKPa * ((0.5 * this.airDensity * vAir * vAir) / 1000);
    }
    // Combustion torque at the full spark, and what the traction cut leaves of it.
    // Under manual clutch, an engine dragged below stall speed chokes and loses torque; once stalled it produces none.
    const lugScale = this.stall.stalled ? 0 : manualClutch && rpm < stallRpm ? clamp(rpm / stallRpm, 0, 1) : 1;
    const tCombustionMax =
      (lugScale * this.luts.power.evaluate(rpm) * engineMapTorqueScale * airShare * ramShare * this.coolantDerate() * 1000) / omegaE;
    const tCombustionFull = plate * tCombustionMax;
    const tCombustion = tCombustionFull * sparkShare;
    const coastSpinScale = this.stall.stalled ? clamp(this.engineOmega / 30, 0, 1) : 1;
    const tCoast = (1 - plate) * this.luts.coast.evaluate(rpm) * mode.coastTorqueScale * this.engineBrakingScale * coastSpinScale;
    let tIce = tCombustion * boostShare - tCoast;
    // The same at the full spark, for the next step's spark-first split: one read back after the cut would count the cut
    // as the motor's larger share, and a held cut would take more each step
    let tIceUncut = tCombustionFull * boostShare - tCoast;
    // Crank torque the lag costs, which the MGU-K may fill below
    let turboDeficit = tCombustion * lagShare;
    if (this.shiftTimer > 0 && tIce > 0 && !downshifting) {
      tIce *= gb.shiftTorqueFraction;
      turboDeficit *= gb.shiftTorqueFraction;
    }
    if (this.shiftTimer > 0 && tIceUncut > 0 && !downshifting) tIceUncut *= gb.shiftTorqueFraction;
    if (tIce > 0) tIce *= this.damagePowerMult;
    if (tIceUncut > 0) tIceUncut *= this.damagePowerMult;

    // A down-shift: free between gears, then the clutch comes home over its ramp, or at once when the engine has met
    // the wheels' speed (nothing is left to slip away, and the throttle finds the whole clutch)
    if (this.gear !== 0 && downshifting) {
      const from = Math.max(dn.neutralS, dn.clutchReleaseS);
      if (this.sinceDownshiftS >= from && Math.abs(rpm - wheelSideRpm) < 0.02 * Math.max(rpm, wheelSideRpm)) {
        this.sinceDownshiftS = dn.clutchHomeS;
      } else {
        const home = this.sinceDownshiftS < from ? 0 : (this.sinceDownshiftS - from) / Math.max(1e-6, dn.clutchHomeS - from);
        engage = Math.min(engage, home);
      }
    }
    this.clutchEngagement = engage;
    this.clutchSlipNorm =
      this.gear !== 0 && engage > 0.02 && engage < 0.99
        ? clamp(Math.abs(this.engineOmega - axleOmega * ratio) / Math.max(50, eng.idleRpm * RPM2RADS), 0, 1)
        : 0;
    const clutchCap = cl.maxTorqueNm * engage;

    // ---- MGU-K (crank torque, + deploy / − harvest)
    const soc = this.ersEnergyJ / ers.ERS_MAX_CHARGE;
    const speedKmh = this.velocity.length() * 3.6;
    const topGear = this.gear === gb.ratios.length;
    let pK = 0;
    /** The ECU may deploy now: the MGU-K then also fills the torque the turbo lag costs */
    let deployAllowed = false;
    /**
     * On a car that harvests on a lift in every gear: that harvest now (W), the same power in every gear, easing off as
     * the throttle comes back to the lift threshold. The brake pedal keeps it, as it keeps the engine's overrun
     */
    let liftW = 0;
    /** The 2026 rules' control ran this step (else the driver is off the throttle or the drive is out: no limited period) */
    let ersStepped = false;
    /** What the brake pedal asks the MGU-K to recover, before the lap's recharge limit (W) */
    let brakeWantW = 0;
    const everyGear = ers.liftHarvestEveryGear;
    const coupled = engage > 0.9 && this.gear > 0 && !this.stall.stalled;
    if (coupled) {
      if (everyGear && inp.throttle < ers.liftThrottle) {
        liftW = ers.topGearLiftHarvestW * mode.liftHarvestScale * (1 - inp.throttle / ers.liftThrottle);
      }
      const dials = cfg.hybridDials;
      if (inp.brake > 0.05) {
        const harvestCapW = this.regenKw !== null ? Math.min(ers.maxHarvestW, this.regenKw * 1000) : ers.maxHarvestW * mode.brakeHarvestScale;
        pK = -harvestCapW * Math.min(1, inp.brake * 3);
        brakeWantW = -pK;
      } else if (dials && this.motorDeployKw !== null) {
        // The deploy dial: up to its cap on the throttle, above the class's minimum speed, while the store has charge
        if (inp.throttle > 0.05 && speedKmh >= dials.minDeploySpeedKmh && this.ersEnergyJ > 0 && this.motorDeployKw > 0) {
          deployAllowed = true;
          pK = Math.min(ers.ERS_MAX_DEPLOY, this.motorDeployKw * 1000) * this.luts.deployVsGear.evaluate(this.gear) * inp.throttle;
        }
      } else if (liftW > 0) {
        pK = -liftW;
      } else if (!everyGear && topGear && inp.throttle < ers.liftThrottle) {
        pK = -ers.topGearLiftHarvestW * mode.liftHarvestScale;
      } else if (topGear && inp.throttle > 0.95 && mode.topGearClipHarvestW > 0) {
        pK = -mode.topGearClipHarvestW;
      } else if (inp.throttle > 0.05 && inp.throttle < 0.9 && mode.partThrottleHarvestW > 0 && !(this.ers2026 && this.ersBoost && !this.ersLowGrip)) {
        pK = -mode.partThrottleHarvestW;
      } else if (this.ers2026 && inp.throttle > 0.05) {
        // The 2026 F1 rules (ers-2026.ts): the ERS-K's power against road speed, the control unit's cuts flat out at
        // the rules' rates, and superclipping. The traction maps (the mode's low-speed delivery, the gear's) under it
        const em = this.luts.management[this.performanceMode];
        const socN = clamp(soc, 0, 1);
        const circuit = this.ersCircuit;
        const lapS = Number.isFinite(this.trackProgress) && this.lapLengthM > 0 ? this.trackProgress * this.lapLengthM : -1;
        const bigCutW = circuit && lapS >= 0 ? this.ersBigCutW(circuit, lapS) : 0;
        const boostDeployFrac = this.ersBoost && !this.ersLowGrip ? 1 : mode.deployFraction;
        const dc = this.ers2026.step({
          h,
          speedKmh,
          throttle: inp.throttle,
          shifting: shiftCut || this.shiftTimer > 0,
          soc,
          overtake: this.ersOvertake,
          overtakeShare: this.ersOvertakeShare,
          boost: this.ersBoost,
          boostCapped: this.ersSession === 'race',
          boostHoldOnly: this.ersLowGrip,
          curves: circuit?.curves ?? 'base',
          alt1Sector: !!circuit && this.ersSession === 'race' && lapS >= 0 && circuit.alt1.some((w) => inStretch(lapS, w)),
          cutStepW: Math.max(F1_2026_ERS.limitStepW, bigCutW),
          cutRateWps: circuit?.cutRateWps ?? F1_2026_ERS.limitRateWps,
          resetSector: !!circuit && lapS >= 0 && this.ersResetSector(circuit, lapS),
          share: boostDeployFrac * this.luts.deployVsSpeed[this.performanceMode].evaluate(speedKmh) * this.luts.deployVsGear.evaluate(this.gear),
          fillShare: boostDeployFrac * this.luts.deployVsGear.evaluate(this.gear),
          valueSPerMJ: ersValueSPerMJ(speedKmh / 3.6, this.ersBrakeAheadM(), this.totalMassKg),
          deployAboveSPerMJ: em ? em.deployAbove.evaluate(socN) : Number.NaN,
          superclipBelowSPerMJ: em ? em.superclipBelow.evaluate(socN) : 0,
          superclipRoomJ: this.superclipRoomJ(),
        });
        ersStepped = true;
        // The motor may fill the turbo's lag wherever the management deploys, the low-speed map aside
        deployAllowed = this.ers2026.fillCeilingW > 0;
        if (dc > 0) {
          pK = dc * ers.deployEfficiency;
        } else if (dc < 0) {
          pK = dc / ers.harvestEfficiency;
        }
      } else if (inp.throttle > 0.05 && soc > mode.socFloor && this.lapDeployJ < ers.deployPerLapJ) {
        deployAllowed = mode.deployFraction > 0;
        pK =
          ers.ERS_MAX_DEPLOY *
          mode.deployFraction *
          this.luts.deployVsSpeed[this.performanceMode].evaluate(speedKmh) *
          this.luts.deployVsGear.evaluate(this.gear) *
          inp.throttle;
      }
      if (pK < 0 && this.wetness > 0) {
        const wetClip = Math.max(
          0.35,
          (1 - 0.32 * this.wetness) * (1 - 0.18 * Math.min(1.5, Math.abs(this.telemetry.latG)) * this.wetness)
        );
        pK *= wetClip;
        liftW *= wetClip;
      }
      if (pK < 0 && (soc >= 1 || this.lapHarvestJ >= this.ersRechargeLimitJ())) pK = liftW = 0;
    }
    if (this.ers2026 && !ersStepped) this.ers2026.release();
    // ---- brake bias (brake-by-wire + live-tunable dynamic brake migration)
    const br = cfg.brakes;
    const mig = br.migration ?? DEFAULT_BRAKE_MIGRATION;
    const migAmount = this.liveBrakeMigrationAmount;
    this.dynamicBrakeBias =
      br.brakeByWire !== false || migAmount > 0
        ? computeDynamicBrakeMigration(this.brakeBias, inp.brake, migAmount, mig.rampStart)
        : this.brakeBias;
    const bias = this.dynamicBrakeBias;

    let tK = 0;
    // Under the 2026 rules a power limit binds the motor (C5.2.8): its torque is sized on the engine speed this step ends
    // at, as the last step's change carries on (out of a shift the engine speeds up 2 % in a step), so the power the
    // store gives it never runs over the limit
    const kOmega = this.ers2026 ? omegaE + Math.max(0, this.ersOmegaStep) : omegaE;
    if (pK > 0) tK = Math.min(pK / kOmega, this.luts.mgukDeploy.evaluate(rpm)) * motorShare;
    else if (pK < 0) {
      let cap = this.luts.mgukHarvest.evaluate(rpm);
      // On the pedal the brake-by-wire never lets the drivetrain brake the rear axle past its share of the demand:
      // harvest fills what the engine overrun leaves of it, the rear calipers the rest
      if (inp.brake > 0.05 && br.brakeByWire !== false && ratio !== 0) {
        const rearDemand = 2 * inp.brake * br.maxTorqueNm * (1 - bias);
        cap = Math.min(cap, Math.max(0, rearDemand / (Math.abs(ratio) * gb.efficiency) - Math.max(0, -tIce)));
      }
      tK = -Math.min(-pK / omegaE, cap);
      // A lift's harvest under its ceiling at the axle; on the brake, the pedal's own harvest once that is the greater
      if (everyGear && liftW > 0 && ratio !== 0) {
        const lift = Math.min(liftW / omegaE, this.luts.mgukHarvest.evaluate(rpm), everyGear.maxAxleTorqueNm / Math.abs(ratio));
        tK = inp.brake > 0.05 ? Math.min(tK, -lift) : -lift;
      }
    }
    // 2026 transparent ICE-to-MGU-K torque arbitration (FIA C5.2.5 / C5.2.10 i): during trail/medium braking and
    // low-to-mid part throttle (5 %–60 % pedal, before positive MGU-K deploy blends in), run the ICE above the driver's
    // wheel-torque demand and absorb the exact surplus torque into the MGU-K generator (tIce += tArb, tK -= tArb). Net
    // crank torque (tIce + tK) and rear brake-by-wire balance remain bit-exact while keeping the turbo spooled and
    // recovering electrical energy cleanly without requiring heavy full-throttle superclipping.
    this.iceArbPlate = this.icePlate;
    if (
      this.ers2026 &&
      coupled &&
      !shiftCut &&
      this.shiftTimer <= 0 &&
      !downshifting &&
      this.limiterTimer <= 0 &&
      sparkShare >= 0.99 &&
      !(this.ersBoost && !this.ersLowGrip) &&
      soc < 0.99 &&
      this.lapHarvestJ < this.ersRechargeLimitJ() &&
      rpm > eng.idleRpm + 800
    ) {
      let arbWeight = 0;
      const socNeed = 1 - smoothstep(soc, 0.7, 0.92);
      if (inp.brake > 0.05) {
        arbWeight = 0.85 * socNeed * smoothstep(rpm, eng.idleRpm + 800, 7500);
      } else if (inp.throttle > 0.05 && inp.throttle < DEPLOY_THROTTLE_START && pK >= 0 && !(topGear && inp.throttle < ers.liftThrottle)) {
        arbWeight = 0.9 * socNeed * smoothstep(inp.throttle, 0.05, 0.15) * (1 - smoothstep(inp.throttle, 0.45, DEPLOY_THROTTLE_START));
      } else if (inp.throttle > 0.05 && inp.throttle < 0.9 && mode.partThrottleHarvestW > 0 && pK < 0) {
        arbWeight = smoothstep(inp.throttle, 0.05, 0.15) * (1 - smoothstep(inp.throttle, 0.75, 0.9));
      }
      if (arbWeight > 0) {
        const wetScale =
          this.wetness > 0
            ? Math.max(0.35, (1 - 0.32 * this.wetness) * (1 - 0.18 * Math.min(1.5, Math.abs(this.telemetry.latG)) * this.wetness))
            : 1;
        const mgukMaxNm = this.luts.mgukHarvest.evaluate(rpm) * wetScale;
        const mgukHeadroomNm = Math.max(0, mgukMaxNm - Math.max(0, -tK));
        // Only arbitrate from the FIA lap recharge budget left over after reserving upcoming braking zones so late-lap
        // pure kinetic braking (e.g. a final hairpin before the main straight) is never starved
        const arbBudgetJ =
          Number.isFinite(this.trackProgress) && this.lapLengthM > 0
            ? this.superclipRoomJ()
            : Math.max(0, this.ersRechargeLimitJ() - this.lapHarvestJ);
        const eRoomJ = Math.min(ers.ERS_MAX_CHARGE - this.ersEnergyJ, arbBudgetJ);
        const roomMaxNm = eRoomJ / Math.max(1e-6, ers.harvestEfficiency * h * omegaE);
        const roomHeadroomNm = Math.max(0, roomMaxNm - Math.max(0, -tK));
        const arbBoostShare = turbo && this.turbocharged ? Math.min(1, (1 + this.turboBoost) / (1 + turboSteadyBoost(turbo, rpm))) : 1;
        const tIceCapNm = tCombustionMax * sparkShare * arbBoostShare * this.damagePowerMult;
        const iceHeadroomNm = Math.max(0, tIceCapNm - tIce);
        const tArb = Math.min(mgukHeadroomNm, roomHeadroomNm, iceHeadroomNm) * arbWeight;
        if (tArb > 0) {
          tIce += tArb;
          tIceUncut += tArb;
          tK -= tArb;
          if (tCombustionMax > 1) {
            this.iceArbPlate = clamp(plate + tArb / tCombustionMax, this.icePlate, 1);
          }
        }
      }
    }
    // Torque fill: with no MGU-H to spin the turbo, the MGU-K makes up the torque its lag costs, within the motor's torque
    // curve and the gear's power clip, from the same store and lap allowance as the deploy
    if (deployAllowed && turboDeficit > 0) {
      const deployCapW = this.motorDeployKw !== null ? Math.min(ers.ERS_MAX_DEPLOY, this.motorDeployKw * 1000) : ers.ERS_MAX_DEPLOY;
      // Under the 2026 rules the ceiling this step, the speed's limit and the control unit's cut (the gear's map in it)
      const fillW = this.ers2026 ? this.ers2026.fillCeilingW * ers.deployEfficiency : deployCapW * this.luts.deployVsGear.evaluate(this.gear);
      const fillCap = Math.min(this.luts.mgukDeploy.evaluate(rpm), fillW / kOmega);
      tK = Math.max(tK, Math.min(fillCap * motorShare, tK + turboDeficit));
    }
    if (this.limiterTimer > 0 && tK > 0) tK = 0;
    // A regulated limit on the power at the driven shafts (`EngineData.outputPowerCap`), which carry the crank's torque
    // less the gearbox's losses: the engine gives way to the motor's deployment, then the motor to the limit
    const powerCap = this.luts.powerCap;
    // The motor's torque before its share of the cut (a cut that leaves it nothing keeps the last step's)
    let tKUncut = motorShare > 0.05 ? Math.max(0, tK) / motorShare : this.lastMotorDriveNm;
    if (powerCap) {
      const capW = powerCap.evaluate(rpm) * (this.luts.powerCapVsSpeed?.evaluate(speedKmh) ?? 1) * 1000;
      const capNm = capW / (omegaE * gb.efficiency);
      // On a hybrid run from its own dials the controller holds the battery about its target charge: above it the
      // engine gives way to the motor at the limit, as the class's energy rules have it; below it the motor gives way
      // there instead (deploying adds no power at the limit, so it would only empty the battery), and keeps filling
      // what the engine leaves under it (the turbos' lag, a corner exit)
      const motorGivesWay = this.motorDeployKw !== null && soc < (cfg.hybridDials?.socTarget ?? 0.5);
      let limited = underShaftLimit(tIce, tK, capNm, motorGivesWay);
      tIce = limited[0];
      tK = limited[1];
      // The split's torques without the cut, under the same limit
      limited = underShaftLimit(tIceUncut, tKUncut, capNm, motorGivesWay);
      tIceUncut = limited[0];
      tKUncut = limited[1];
    }
    this.mgukTorque = tK;
    this.lastIceDriveNm = tIceUncut;
    this.lastMotorDriveNm = tKUncut;
    this.stepIcePowerSumW += Math.max(0, tIce * omegaE);
    this.stepShaftPowerSumW += Math.max(0, (tIce + tK) * omegaE * gb.efficiency * engage);
    this.stepPowerSamples++;

    // ---- brakes (physical brake pad μ(T))
    // Net drivetrain braking torque at the crank: when 2026 ICE-to-MGU-K arbitration fires the ICE into unused generator
    // headroom during braking (tIce > 0, tK < 0), only the net retarding torque -(tIce + tK) slows the rear axle
    const crankBrake = Math.max(0, -(tIce + tK));
    // The slowing engine gives up some of its own inertia's torque, so a little less than the crank's braking reaches the
    // wheels: this share keeps the rear axle on its demand under harvest (scripts/verify-powertrain.ts)
    // (a lift's harvest is on from the first of the pedal, so the rear calipers give way to it from there too)
    const driveBrake = (inp.brake > 0.05 || liftW > 0) && br.brakeByWire !== false ? (crankBrake * engage * Math.abs(ratio) * gb.efficiency) / 2 : 0;
    const [dl, dr] = this.drivenWheels;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const demand = inp.brake * (inp.brakeWheelScale ? inp.brakeWheelScale[i] : 1) * br.maxTorqueNm * (w.isFront ? bias : 1 - bias);
      // Pad μ(T) of the disc (1 in its window, a mild loss cold or faded)
      const friction = (i === dl || i === dr ? Math.max(0, demand - driveBrake) : demand) * w.brakeDisc.muFactor;
      const compound = this.tyres[w.isFront ? 0 : 1].data;
      const tyre = compound.modelData;
      const rollV = w.vx;
      // Rolling resistance: its speed term, more of it on a soft tyre, and the scrub of a tyre working at its limit
      // (on a turning wheel: a locked one only slides)
      const softDrag = 1 + (compound.pressureData.pressureRollingGain ?? 0) * (compound.pressureData.optimalPsi / Math.max(1, w.pressurePsi) - 1);
      const scrub = (tyre.rollingResistanceSlipGain ?? 0) * Math.min(w.combinedSlip, tyre.rollingResistanceSlipMax ?? SCRUB_MAX_SLIP) * Math.min(1, Math.abs(w.omega) / SCRUB_FULL_SPIN_RADS);
      const rollingResistance = (tyre.rollingResistance + (tyre.rollingResistanceSpeedSq ?? 0) * rollV * rollV) * softDrag * (1 + scrub * softDrag);
      const handbrake = !w.isFront && inp.handbrake ? inp.handbrake * (br.handbrakeTorqueNm ?? 0) : 0;
      w.brakeTorqueNm = friction + handbrake + w.fz * rollingResistance * w.rollingRadius;
    }
    // Brake-operated diff lock: the faster driven wheel is held back (on a four-wheel-drive car, on each driven axle)
    const brakeLock = cfg.differential.brakeLock;
    const cw = this.coupledWheels;
    if (brakeLock) {
      const map = tIce + tK > 0 ? brakeLock.power : brakeLock.coast;
      for (const [pl, pr] of this.drivenPairs) {
        const l = Math.abs(W[pl].omega);
        const r = Math.abs(W[pr].omega);
        const spin = Math.max(l, r) / Math.max(1, Math.min(l, r)) - 1;
        const share = clamp((spin - map.deadZone) / Math.max(1e-6, map.fullSpin - map.deadZone), 0, 1);
        W[l > r ? pl : pr].brakeTorqueNm += share * map.torqueNm;
      }
    }

    // ---- predicted velocities from the free torques
    const Ie = eng.inertia;
    const Iw = _wheelInertia;
    const wW = _wheelOmega;
    for (let i = 0; i < 4; i++) {
      Iw[i] = this.axles[W[i].isFront ? 0 : 1].wheelInertia;
      wW[i] = W[i].omega + (tyreTorque[i] / Iw[i]) * h;
    }
    // Driveline loss: the gearbox and final drive pass `efficiency` of the torque the crank drives the wheels with, once
    // the clutch carries it. The cars' crank curves are their wheel curves over that efficiency, so the wheels get the
    // wheel curve. A free-revving engine loses nothing, and the overrun (engine braking, harvest) passes 1:1
    const tCrank = tIce + tK;
    const tDriveline = tCrank > 0 ? tCrank * (1 - (1 - gb.efficiency) * engage) : tCrank;
    let wE = this.engineOmega + (tDriveline / Ie) * h;

    // ---- sequential impulses & 3-Phase Electronic Differential (Entry / Mid / Exit-HiSpd)
    const accB = _brakeImpulse.fill(0);
    let accC = 0;
    let accD = 0;
    const half = 0.5 * ratio;
    let mC = ratio !== 0 ? 1 / (1 / Ie + (half * half) / Iw[dl] + (half * half) / Iw[dr]) : 0;
    let mD = 1 / (1 / Iw[dl] + 1 / Iw[dr]);
    // Compliant halfshafts make the clutch and diff rows soft constraints: an implicit spring-damper on each row's own
    // coordinate (Catto, "Soft Constraints", GDC 2011; ODE's CFM / ERP), stable at any stiffness. The side gears' inertia
    // is negligible next to the wheels' and the engine's, so the shafts sit in series with the clutch and the diff. With
    // equal shafts the two rows see independent modes: the clutch row (J = [1, −r/2, −r/2]) twists both shafts alike
    // (2k/r², 2c/r² at the crank, coordinate r·θ_mean); the diff row (J = [1, −1] on the driven wheels) twists them oppositely
    // (k/2, c/2, coordinate −2·θ_halfDiff). Rigid shafts: gamma = bias = 0, the rows as before.
    const shaft = cfg.differential.halfshaft;
    let gammaC = 0;
    let biasC = 0;
    let gammaD = 0;
    let biasD = 0;
    if (shaft) {
      const k = shaft.stiffnessNmPerRad;
      const cS = shaft.dampingNmsPerRad;
      if (ratio !== 0) {
        const kC = (2 * k) / (ratio * ratio);
        const denC = (2 * cS) / (ratio * ratio) + h * kC;
        gammaC = 1 / (h * denC);
        biasC = (kC * ratio * this.shaftTwistMeanRad) / denC;
        mC = 1 / (1 / mC + gammaC);
      }
      const denD = 0.5 * cS + h * 0.5 * k;
      gammaD = 1 / (h * denD);
      biasD = (0.5 * k * -2 * this.shaftTwistHalfDiffRad) / denD;
      mD = 1 / (1 / mD + gammaD);
    }
    const diffCfg = cfg.differential;
    const diff = diffCfg.settings;
    const hiSpdKmh = diffCfg.hiSpdSwitchKmh ?? 250;
    // Phase weights, blended as an ECU blends its diff maps rather than switched: the entry map on the brake, the exit
    // map on the power, the mid map between. A light pedal with the lock on (trail braking into the apex, maintenance
    // throttle at it) stays with the mid map until the pedal commits
    const smooth = smoothstep;
    const turnedIn = smooth(Math.abs(inp.steer) * this.maxSteerRad * RAD2DEG, DIFF_TURNED_IN_DEG[0], DIFF_TURNED_IN_DEG[1]);
    const brakeW = smooth(inp.brake, DIFF_BRAKE_PHASE[0], DIFF_BRAKE_PHASE[1]);
    const powerW = smooth(inp.throttle, DIFF_POWER_PHASE[0], DIFF_POWER_PHASE[1]);
    let entryW = brakeW * (1 - turnedIn * (1 - brakeW));
    let exitW = powerW * (1 - turnedIn * (1 - powerW)) * (1 - brakeW);
    let powerCoeff = diff.power;
    let coastCoeff = lerp(diff.coast, diffCfg.coastBraking ?? diff.coast, entryW);
    if (diffCfg.threePhase) {
      // Past the high-speed switch (and at a standstill launch) the exit map holds for straight-line stability
      const hiSpdW = speedKmh < 1 ? 1 : smooth(speedKmh, hiSpdKmh - DIFF_HISPD_BLEND_KMH, hiSpdKmh + DIFF_HISPD_BLEND_KMH);
      entryW *= 1 - hiSpdW;
      exitW = Math.max(exitW, hiSpdW);
      const mid = diffDialLevel(this.diffMidLevel);
      powerCoeff = lerp(mid, diffDialLevel(this.diffExitLevel), exitW);
      coastCoeff = lerp(mid, diffDialLevel(this.diffEntryLevel), entryW);
    } else {
      // A plain ramp diff locks by its data (POWER / COAST) with the dials where the car has them; turning a dial
      // scales that lock, 0.65× at 1 to 1.35× at 12, about the car's own position. An open diff stays open (no floor)
      powerCoeff = clamp((diff.power * rampDiffDial(this.diffExitLevel)) / rampDiffDial(this.diffExitDefault), 0, 1);
      coastCoeff = clamp((coastCoeff * rampDiffDial(this.diffEntryLevel)) / rampDiffDial(this.diffEntryDefault), 0, 1);
    }
    this.diffActivePhase = entryW > 0.5 ? 'ENTRY' : exitW > 0.5 ? 'EXIT' : 'MID';
    const lockPower = powerCoeff * diff.friction_faces * cot(diff.power_ramp_deg);
    const lockCoast = coastCoeff * diff.friction_faces * cot(diff.coast_ramp_deg);
    let lockTorque = diff.preload;
    // Four-wheel drive (`AwdData`): the centre coupling's row and the coupled axle's differential. The coupling row
    // (J = ½ on each coupled wheel, −½ on each driven one; its impulse is the coupled axle's torque × h) is a damper of
    // `rampNmPerRadS`, implicit as the halfshafts' soft rows (γ = 1 / (h · ramp), no spring), clamped one way: in the
    // drive direction (backwards in reverse), up to `maxTorqueNm`, and only on the throttle
    const awd = cfg.awd;
    let accX = 0;
    let accS = 0;
    let mX = 0;
    let gammaX = 0;
    let xLo = 0;
    let xHi = 0;
    let mS = 0;
    let lockPowerS = 0;
    let lockCoastS = 0;
    let lockS = 0;
    let sl = 0;
    let sr = 0;
    if (awd && cw) {
      [sl, sr] = cw;
      const ramp = Math.max(1e-6, awd.centre.rampNmPerRadS);
      gammaX = 1 / (h * ramp);
      mX = 1 / (0.25 * (1 / Iw[sl] + 1 / Iw[sr] + 1 / Iw[dl] + 1 / Iw[dr]) + gammaX);
      // Engaged with the driver's foot on the throttle, not by the torque of the moment (the limiter's and the traction
      // control's cuts don't release it), and let go as the brake pedal goes down (a down-shift's blip drives too)
      const gate =
        clamp(inp.throttle / AWD_THROTTLE_ENGAGE, 0, 1) * clamp(1 - inp.brake / AWD_BRAKE_RELEASE, 0, 1);
      const cap = awd.centre.maxTorqueNm * gate * h;
      if (ratio < 0) xLo = -cap;
      else xHi = cap;
      mS = 1 / (1 / Iw[sl] + 1 / Iw[sr]);
      const sd = awd.secondaryDiff;
      lockPowerS = sd.power * sd.friction_faces * cot(sd.power_ramp_deg);
      lockCoastS = sd.coast * sd.friction_faces * cot(sd.coast_ramp_deg);
      lockS = sd.preload;
    }
    for (let it = 0; it < SOLVER_ITERATIONS; it++) {
      for (let i = 0; i < 4; i++) {
        const max = W[i].brakeTorqueNm * h;
        const prev = accB[i];
        accB[i] = clamp(prev - wW[i] * Iw[i], -max, max);
        wW[i] += (accB[i] - prev) / Iw[i];
      }
      if (clutchCap > 0 && ratio !== 0) {
        const c = wE - half * (wW[dl] + wW[dr]);
        const max = clutchCap * h;
        const prev = accC;
        accC = clamp(prev - (c + biasC + gammaC * prev) * mC, -max, max);
        const d = accC - prev;
        wE += d / Ie;
        wW[dl] -= (half * d) / Iw[dl];
        wW[dr] -= (half * d) / Iw[dr];
      }
      if (awd && cw) {
        const c = 0.5 * (wW[sl] + wW[sr]) - 0.5 * (wW[dl] + wW[dr]);
        const prev = accX;
        accX = clamp(prev - (c + gammaX * prev) * mX, xLo, xHi);
        const d = 0.5 * (accX - prev);
        wW[sl] += d / Iw[sl];
        wW[sr] += d / Iw[sr];
        wW[dl] -= d / Iw[dl];
        wW[dr] -= d / Iw[dr];
      }
      // Torque into the diff (Nm): + when the engine drives the wheels forward (less what the coupling takes off it)
      let tIn = (-accC / h) * ratio;
      if (awd) tIn -= accX / h;
      lockTorque = diff.preload + Math.abs(tIn) * (tIn >= 0 ? lockPower : lockCoast);
      {
        const c = wW[dl] - wW[dr];
        const max = lockTorque * h;
        const prev = accD;
        accD = clamp(prev - (c + biasD + gammaD * prev) * mD, -max, max);
        const d = accD - prev;
        wW[dl] += d / Iw[dl];
        wW[dr] -= d / Iw[dr];
      }
      // The coupled axle's differential, locking on the torque the coupling hands it
      if (awd && cw) {
        const tInS = (ratio < 0 ? -accX : accX) / h;
        lockS = awd.secondaryDiff.preload + Math.abs(tInS) * (tInS >= 0 ? lockPowerS : lockCoastS);
        const c = wW[sl] - wW[sr];
        const max = lockS * h;
        const prev = accS;
        accS = clamp(prev - c * mS, -max, max);
        const d = accS - prev;
        wW[sl] += d / Iw[sl];
        wW[sr] -= d / Iw[sr];
      }
    }
    this.lsdLockTorque = lockTorque;
    if (awd) {
      this.centreCouplingTorqueNm = accX / h;
      this.coupledLockTorqueNm = lockS;
    }
    if (shaft) {
      // The twists follow the torque the rows delivered (c·θ̇ + k·θ = T, implicit), so a slipping clutch or diff holds
      // the shafts at the torque it passes rather than winding them up by its slip
      const k = shaft.stiffnessNmPerRad;
      const den = shaft.dampingNmsPerRad + h * k;
      const tMean = clutchCap > 0 && ratio !== 0 ? -(accC / h) * half : 0;
      this.shaftTwistMeanRad += (h * (tMean - k * this.shaftTwistMeanRad)) / den;
      this.shaftTwistHalfDiffRad += (h * (accD / h - k * this.shaftTwistHalfDiffRad)) / den;
    }
    this.engineOmega = Math.max(0, wE);
    for (let i = 0; i < 4; i++) {
      W[i].driveTorqueNm = i === dl || i === dr ? -(accC / h) * half : 0;
      W[i].omega = wW[i];
    }
    // The coupling's torque leaves the driven axle for the coupled one, half to each of its wheels
    if (awd && cw) {
      const tX = (0.5 * accX) / h;
      W[dl].driveTorqueNm -= tX;
      W[dr].driveTorqueNm -= tX;
      W[sl].driveTorqueNm = tX;
      W[sr].driveTorqueNm = tX;
    }

    // ---- energy store
    let pMech = tK * this.engineOmega;
    if (pMech > 0) {
      // Never overrun the per-lap allowance or the store inside a sub-step (the 2026 rules have no deploy limit a lap)
      const room = this.ers2026 ? this.ersEnergyJ : Math.min(ers.deployPerLapJ - this.lapDeployJ, this.ersEnergyJ);
      const want = (pMech / ers.deployEfficiency) * h;
      if (want > room) {
        const scale = Math.max(0, room) / want;
        pMech *= scale;
        this.mgukTorque *= scale;
        this.lastMotorDriveNm *= scale;
      }
      const e = (pMech / ers.deployEfficiency) * h;
      this.ersEnergyJ = Math.max(0, this.ersEnergyJ - e);
      this.lapDeployJ += e;
    } else if (pMech < 0) {
      let e = -pMech * ers.harvestEfficiency * h;
      if (this.ers2026) {
        // The lap's recharge limit is never overrun inside a sub-step (C5.2.10)
        const room = Math.max(0, this.ersRechargeLimitJ() - this.lapHarvestJ);
        if (e > room) {
          const scale = room / e;
          pMech *= scale;
          this.mgukTorque *= scale;
          e = room;
        }
      }
      this.ersEnergyJ = Math.min(ers.ERS_MAX_CHARGE, this.ersEnergyJ + e);
      // Counted on the store's side of the MGU-K, as deploy is, so both per-lap limits measure the same thing
      this.lapHarvestJ += e;
    }
    if (this.ers2026) {
      // Preserve pre-shift deployment across the brief 20 ms upshift torque cut so a cut starting right after a shift
      // steps down from the actual power rather than snapping to 0
      if (!shiftCut) this.ers2026.lastDcW = pMech > 0 ? pMech / ers.deployEfficiency : 0;
      this.ersOmegaStep = this.engineOmega - omegaAtStart;
      // What the braking zones could have recovered here (including braking-headroom arbitration), the recharge limit
      // aside: the room the next lap reserves so superclipping and part-throttle arbitration never starve late braking
      if (brakeWantW > 0 && Number.isFinite(this.trackProgress)) {
        const w = Math.min(brakeWantW, this.luts.mgukHarvest.evaluate(this.rpm) * Math.max(0, this.engineOmega));
        this.lapBrakeHarvestJ[Math.min(ERS_LAP_BINS - 1, Math.max(0, Math.floor(this.trackProgress * ERS_LAP_BINS)))] += w * ers.harvestEfficiency * h;
      }
    }
  }

  /** The wake's multipliers as this car feels them (`AeroData.wakeSensitivity`), into a scratch state */
  private carWake(): AeroWakeState {
    const wake = this.aeroWake;
    const ws = this.config.aero.wakeSensitivity;
    if (!ws) return wake;
    _carWake.dragMultiplier = 1 - ws.dragWakeMult * (1 - wake.dragMultiplier);
    _carWake.frontDownforceMultiplier = 1 - ws.frontLiftWakeMult * (1 - wake.frontDownforceMultiplier);
    _carWake.rearDownforceMultiplier = 1 - ws.diffuserDraftLiftMult * (1 - wake.rearDownforceMultiplier);
    return _carWake;
  }

  /**
   * Drag and downforce areas the cooling openings add away from their baseline (`AeroData.cooling`, m²): the brake
   * ducts at their own axle, the radiator 65 / 35 front / rear
   */
  private coolingAero(out: { cdA: number; clAFront: number; clARear: number }): { cdA: number; clAFront: number; clARear: number } {
    const c = this.config.aero.cooling;
    if (!c) {
      out.cdA = out.clAFront = out.clARear = 0;
      return out;
    }
    const { brakeDuctFront: f, brakeDuctRear: r, radiator: rad } = this.coolingSteps;
    out.cdA = f * c.brakeDuctFrontCdAPerStep + r * c.brakeDuctRearCdAPerStep + rad * c.radiatorCdAPerStep;
    out.clAFront = f * c.brakeDuctFrontClAPerStep + 0.65 * rad * c.radiatorClAPerStep;
    out.clARear = r * c.brakeDuctRearClAPerStep + 0.35 * rad * c.radiatorClAPerStep;
    return out;
  }

  /** Front wing, venturi floor and rear wing on the current ride heights, with wake and body-yaw sensitivity */
  private applyAero(): void {
    const aero = this.config.aero;
    const W = this.wheels;
    const a = this.cgToFrontM;
    const b = this.cgToRearM;
    const L = this.wheelbaseM;

    // Floor heights at the axles above the local ground
    _p.set(0, this.floorOffsetY, a).applyQuaternion(this.quaternion).add(this.position);
    const fy = _p.y;
    _p.set(0, this.floorOffsetY, -b).applyQuaternion(this.quaternion).add(this.position);
    const ry = _p.y;
    const gF = 0.5 * (this.groundYUnder(W[0]) + this.groundYUnder(W[1]));
    const gR = 0.5 * (this.groundYUnder(W[2]) + this.groundYUnder(W[3]));
    this.rideFront = fy - gF;
    this.rideRear = ry - gR;
    const hMean = 0.5 * (this.rideFront + this.rideRear);
    const rakeDeg = Math.atan2(this.rideRear - this.rideFront, L) * RAD2DEG;
    const pitchDelta = rakeDeg - this.staticRakeDeg;
    const wake = this.carWake();

    const air = _air.copy(this.velocity).sub(this.windWorld);
    const vF = air.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    // Air slip angle in the body frame, as the map-aero path reads it
    const yawDeg = Math.abs(vF) > 1 ? Math.abs(Math.atan2(air.dot(_ex), Math.abs(vF))) * RAD2DEG : 0;
    this.aeroYawDeg = yawDeg;
    let down = 0;
    let front = 0;
    let drag = (aero.drag + this.coolingAero(_coolAero).cdA) * wake.dragMultiplier;
    // With the elements' own drag heights: Σ drag area × height, the bodywork's at `dragCentreY`
    const perElement = this.dragAtElements;
    const bodyY = aero.dragCentreY ?? 0;
    let dragMoment = perElement ? drag * bodyY : 0;

    const flaps = this.openFlaps;
    for (const wing of this.wings) {
      const s = wing.spec;
      const h = s.heightRef === 'front' ? this.rideFront : s.heightRef === 'rear' ? this.rideRear : hMean;
      const aoa = s.name === 'VENTURI_FLOOR' ? rakeDeg : s.angleDeg + pitchDelta;
      let cl = wing.aoaCl.evaluate(aoa) * wing.ghCl.evaluate(h);
      let cd = wing.aoaCd.evaluate(aoa) * wing.ghCd.evaluate(h);
      if (wing.yawCl) cl *= wing.yawCl.evaluate(yawDeg);
      if (wing.yawCd) cd *= wing.yawCd.evaluate(yawDeg);
      if (s.drs && !(flaps === 'rear' && s.name === 'FRONT_WING') && !(flaps === 'front' && s.name === 'REAR_WING')) {
        cl *= 1 + (s.drs.clMult - 1) * this.drsBlend;
        cd *= 1 + (s.drs.cdMult - 1) * this.drsBlend;
      }
      const wakeClMult =
        s.name === 'FRONT_WING'
          ? wake.frontDownforceMultiplier
          : s.name === 'REAR_WING'
            ? wake.rearDownforceMultiplier
            : 0.5 * (wake.frontDownforceMultiplier + wake.rearDownforceMultiplier);
      const fd = q * cl * s.area * wakeClMult;
      const dragArea = cd * s.area * wake.dragMultiplier;
      drag += dragArea;
      if (perElement) dragMoment += dragArea * (s.dragY ?? bodyY);
      down += fd;
      front += fd * ((s.positionZ + b) / L);
      _f.copy(_ey).multiplyScalar(-fd);
      _p.set(0, this.floorOffsetY, s.positionZ).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }
    // Bodywork lift at the axles, with what the cooling openings add or spill
    for (let axle = 0; axle < 2; axle++) {
      const cl = axle === 0 ? aero.front_lift + _coolAero.clAFront : aero.rear_lift + _coolAero.clARear;
      const z = axle === 0 ? a : -b;
      const fd = q * cl;
      down += fd;
      if (axle === 0) front += fd;
      _f.copy(_ey).multiplyScalar(-fd);
      _p.set(0, this.floorOffsetY, z).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }

    const speed = air.length();
    const dragN = 0.5 * this.airDensity * speed * speed * drag;
    if (speed > 1e-3) {
      if (perElement && drag > 0) this.addDragAtCentre(air, dragN / speed, dragMoment / drag);
      else this.addDragAtCentre(air, dragN / speed);
    }

    this.aeroDownN = down;
    this.aeroFrontN = front;
    this.aeroDragN = dragN;
  }

  /**
   * 2D ride-height map aero: CL·A / CD·A × the ride-height tables (clearance of the pickups at the axles) × roll and yaw,
   * the front share from the balance table, plus the wings' angle offsets and the active-aero flaps; each force lags
   * by its own delay and acts at the axles
   */
  private applyMapAero(h: number, map: AeroRideHeightMap): void {
    const W = this.wheels;
    const a = this.cgToFrontM;
    const b = this.cgToRearM;
    const L = this.wheelbaseM;
    _p.set(0, map.frontPickupY, a).applyQuaternion(this.quaternion).add(this.position);
    const fy = _p.y;
    _p.set(0, map.rearPickupY, -b).applyQuaternion(this.quaternion).add(this.position);
    const ry = _p.y;
    this.rideFront = fy - 0.5 * (this.groundYUnder(W[0]) + this.groundYUnder(W[1]));
    this.rideRear = ry - 0.5 * (this.groundYUnder(W[2]) + this.groundYUnder(W[3]));
    const rakeDeg = Math.atan2(this.rideRear - this.rideFront, L) * RAD2DEG;
    const pitchDelta = rakeDeg - this.staticRakeDeg;
    const wake = this.carWake();
    const cool = this.coolingAero(_coolAero);

    const air = _air.copy(this.velocity).sub(this.windWorld);
    const vF = air.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    const rollDeg = Math.asin(clamp(_ex.y, -1, 1)) * RAD2DEG;
    // Signed here (the map's yaw tables span ±, and its balance shift may be odd in yaw); the wing path above reads
    // the magnitude, its per-wing yaw tables being one-sided
    const yawDeg = Math.abs(vF) > 1 ? Math.atan2(air.dot(_ex), Math.abs(vF)) * RAD2DEG : 0;
    this.aeroYawDeg = Math.abs(yawDeg);
    const ml = this.mapLuts!;
    evalRhMap(map, this.rideFront, this.rideRear, _rhOut);
    const clMult = _rhOut.cl * ml.rollCl.evaluate(rollDeg) * ml.yawCl.evaluate(yawDeg);
    const cdMult = _rhOut.cd * ml.rollCd.evaluate(rollDeg) * ml.yawCd.evaluate(yawDeg);
    const balance = clamp(_rhOut.balance + ml.rollBalance.evaluate(rollDeg) + ml.yawBalance.evaluate(yawDeg), 0, 1);
    const act = map.activeAero;
    const open = this.drsBlend;
    // One flap alone (the rear's for DRS, the front's in 2026 Low Grip Conditions): the other's downforce change goes,
    // and the drag reduction is the open one's share of it, by downforce change
    const flaps = this.openFlaps;
    const dClAFront = flaps === 'rear' ? 0 : act.dClAFront;
    const dClARear = flaps === 'front' ? 0 : act.dClARear;
    const dFlaps = Math.abs(act.dClAFront) + Math.abs(act.dClARear);
    const dCdA = flaps !== 'front-rear' && dFlaps > 0 ? (act.dCdA * (Math.abs(dClAFront) + Math.abs(dClARear))) / dFlaps : act.dCdA;
    const clA = map.clA * clMult;
    let front = q * (clA * balance + dClAFront * open + cool.clAFront);
    let rear = q * (clA * (1 - balance) + dClARear * open + cool.clARear);
    let cdA = map.cdA * cdMult + dCdA * open + cool.cdA;
    // The wings' angle-of-attack offsets (body pitch included), split to the axles by their position
    for (const wing of this.wings) {
      const s = wing.spec;
      const aoa = s.angleDeg + pitchDelta;
      const fd = q * wing.aoaCl.evaluate(aoa) * s.area;
      const share = clamp((s.positionZ + b) / L, 0, 1);
      front += fd * share;
      rear += fd * (1 - share);
      cdA += wing.aoaCd.evaluate(aoa) * s.area;
    }
    front *= wake.frontDownforceMultiplier;
    rear *= wake.rearDownforceMultiplier;
    const speed = air.length();
    const drag = 0.5 * this.airDensity * speed * speed * cdA * wake.dragMultiplier;
    this.mapAeroFrontN += (front - this.mapAeroFrontN) * aeroLag(h, map.frontDelayS);
    this.mapAeroRearN += (rear - this.mapAeroRearN) * aeroLag(h, map.rearDelayS);
    this.mapAeroDragN += (drag - this.mapAeroDragN) * aeroLag(h, map.dragDelayS);

    for (let axle = 0; axle < 2; axle++) {
      _f.copy(_ey).multiplyScalar(-(axle === 0 ? this.mapAeroFrontN : this.mapAeroRearN));
      _p.set(0, this.floorOffsetY, axle === 0 ? a : -b).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }
    if (speed > 1e-3) this.addDragAtCentre(air, this.mapAeroDragN / speed);
    this.aeroDownN = this.mapAeroFrontN + this.mapAeroRearN;
    this.aeroFrontN = this.mapAeroFrontN;
    this.aeroDragN = this.mapAeroDragN;
  }

  /** Skid-block contact at the front and rear of the plank (floor reference plane) */
  private applyPlankContact(h: number): void {
    if (this.config.aero.plankPhysics) {
      this.applyWearingPlank(h, this.config.aero.plankPhysics);
      return;
    }
    const pl = this.config.aero.plank;
    const y = pl ? pl.y : this.floorOffsetY;
    for (let axle = 0; axle < 2; axle++) {
      const z = axle === 0 ? (pl ? pl.frontZ : this.cgToFrontM) : pl ? pl.rearZ : -this.cgToRearM;
      _p.set(0, y, z).applyQuaternion(this.quaternion).add(this.position);
      // The ground under the plank itself, probed from just above it: a ledge overhead (the body has dropped
      // off an edge the wheels still stand on) is not a surface the plank is pressed into
      if (!this.ground.query(_p.x, _p.z, _p.y + PLANK_PROBE_UP_M, _plankHit)) continue;
      const pen = _plankHit.height - _p.y;
      if (pen <= 0) continue;
      _n.set(_plankHit.nx, _plankHit.ny, _plankHit.nz);
      _r.subVectors(_p, this.position);
      _v.crossVectors(this.angularVelocity, _r).add(this.velocity);
      const vn = _v.dot(_n);
      const fn = Math.max(0, PLANK_RATE * pen * _n.y - PLANK_DAMP * vn);
      _f.copy(_n).multiplyScalar(fn);
      _v.addScaledVector(_n, -vn);
      const vt = _v.length();
      if (vt > 1e-3) _f.addScaledVector(_v, (-PLANK_FRICTION * fn * Math.min(1, vt / 0.5)) / vt);
      this.addForceAt(_f, _p);
    }
  }

  /**
   * A skid block at the four corners of the plank (`ExponentialPlankData`): stiffening exponentially as it is pressed in,
   * its sliding work wearing it down, so a car that bottoms lap after lap rides on a thinner skid
   */
  private applyWearingPlank(h: number, pp: ExponentialPlankData): void {
    const pl = this.config.aero.plank;
    const y = pl ? pl.y : this.floorOffsetY;
    const halfW = PLANK_HALF_WIDTH_M;
    const frontZ = pl ? pl.frontZ : this.cgToFrontM;
    const rearZ = pl ? pl.rearZ : -this.cgToRearM;
    const q = this.quaternion;
    const pos = this.position;

    let maxPy = -Infinity;
    for (let k = 0; k < 4; k++) {
      const z = k < 2 ? frontZ : rearZ;
      const wornM = 0.001 * this.plankWearMm[k];
      _p.set(k % 2 === 0 ? halfW : -halfW, y + wornM, z).applyQuaternion(q).add(pos);
      _plankXs[k] = _p.x;
      _plankYs[k] = _p.y;
      _plankZs[k] = _p.z;
      if (_p.y > maxPy) maxPy = _p.y;
    }

    let foundMask = 0;
    if (this.ground.queryMany) {
      foundMask = this.ground.queryMany(_plankXs, _plankZs, 4, maxPy + PLANK_PROBE_UP_M, _plankHits, 4);
    } else {
      for (let k = 0; k < 4; k++) {
        if (this.ground.query(_plankXs[k], _plankZs[k], _plankYs[k] + PLANK_PROBE_UP_M, _plankHits[k])) {
          foundMask |= 1 << k;
        }
      }
    }

    for (let k = 0; k < 4; k++) {
      if (!((foundMask >> k) & 1)) continue;
      const hit = _plankHits[k];
      const py = _plankYs[k];
      if (hit.height > py + PLANK_PROBE_UP_M) continue;
      const pen = hit.height - py;
      if (pen <= 0) continue;
      _p.set(_plankXs[k], py, _plankZs[k]);
      _n.set(hit.nx, hit.ny, hit.nz);
      _r.subVectors(_p, pos);
      _v.crossVectors(this.angularVelocity, _r).add(this.velocity);
      const vn = _v.dot(_n);
      // A quarter of the block's stiffness at each corner
      const elastic = 0.25 * (pp.kLinearNm * pen + (pp.kExpNm / pp.betaPerM) * (Math.exp(pp.betaPerM * Math.min(pen, PLANK_EXP_CAP_M)) - 1));
      const fn = Math.max(0, elastic * _n.y - 0.25 * pp.dampNsPerM * vn);
      _f.copy(_n).multiplyScalar(fn);
      _v.addScaledVector(_n, -vn);
      const vt = _v.length();
      if (vt > 1e-3) {
        _f.addScaledVector(_v, (-pp.frictionMu * fn * Math.min(1, vt / 0.5)) / vt);
        // Wear by the sliding work (mm per MJ), at most down to nothing left of the block
        this.plankWearMm[k] = Math.min(pp.initialWearMarginMm, this.plankWearMm[k] + pp.wearMmPerMJ * pp.frictionMu * fn * vt * h * 1e-6);
      }
      this.addForceAt(_f, _p);
    }
  }

  /** 6-node I/M/O + 16-sector tyre temperatures, wear, flat-spots, graining, blistering, dirt, and 2-node brake discs */
  private updateThermal(dt: number): void {
    const carSpeedMs = this.velocity.length();
    for (const w of this.wheels) {
      const td = this.tyres[w.isFront ? 0 : 1].data;
      const th = td.thermalData;
      const v = Math.abs(w.vx);
      // A rain tyre on a dry road squirms and runs hot; water on the road cools every tread
      const traits = td.wetTraits ?? SLICK_TRAITS;
      const heatScale = wetHeatScale(traits, this.wetness);
      const roadG = ROAD_CONDUCTANCE + wetRoadCoolingWK(this.wetness, v);
      const extWetCool = wetExternalGasCoolingWK(this.wetness, v);
      const slipPower = (Math.abs(w.fx * w.slipVelX) + Math.abs(w.fy * w.vy)) * heatScale;
      const hyst = th.hysteresis * w.fz * v * heatScale;

      // One thermal model: three bands, each a tread surface over the tread's bulk over the carcass liner, each a third
      // of the tyre (a third of the heat capacity and conductances, so with an even load the bands are the whole tyre).
      // Each band takes the heat of its share of the contact pressure (`computeBandLoadShares`, set in the substep)
      const shares = w.bandLoadShares;
      // The compound's heat capacities and conductances are the front tyre's: this axle's scale with its size
      const rtT = this.tyres[w.isFront ? 0 : 1];
      const size = rtT.thermalSize;
      const L = rtT.layers;
      const rg = rtT.rimGas;
      const surfaceCap = L.cSurf * size;
      const subCap = L.cSub * size;
      const coreCap = L.cCore * size;
      // Inflation pressure in the heat: an under-inflated tyre works its rubber harder and flexes more
      // (`TyresThermalPatchData.pressureHeat`); where it runs on its crown or its shoulders is in the band shares
      const ph = th.pressureHeat;
      let slipHeat = slipPower;
      let rollHeat = hyst;
      if (ph) {
        const pd = td.pressureData;
        const pRel = w.pressurePsi / pd.optimalPsi - 1;
        slipHeat = slipPower * Math.max(0, 1 - ph.slipGain * pRel);
        rollHeat = hyst * Math.max(0, 1 + (pd.pressureRollingGain ?? 0) * (pd.optimalPsi / Math.max(1, w.pressurePsi) - 1));
      }
      // Three layers per band: the tread surface over the tread's bulk over the carcass liner. The sliding heat taken
      // into the tyre lands mostly in the surface, some in the bulk; the rolling (hysteresis) heat is made in the bulk and
      // the liner. The surface sheds heat to the road and the air, the liner through the sidewalls and to the gas
      const g12 = L.g12 * size;
      const g23 = L.g23 * size;
      const gGas = rg.carcassToGasConductanceWK * size;
      const fricIn = th.slipHeatShare * slipHeat;
      for (let b = 0; b < 3; b++) {
        const share = shares[b] * 3;
        const tS = w.bandTempsC[b];
        const tB = w.bandCarcassTempsC[b];
        const tC = w.bandCoreTempsC[b];
        const q12 = g12 * (tS - tB);
        const q23 = g23 * (tB - tC);
        const bSurfCool = (th.surfaceCooling[0] + th.surfaceCooling[1] * v) * size * (tS - this.ambientC);
        const bRoadCool = w.fz > 0 ? roadG * size * share * (tS - this.trackTempC) : 0;
        const bCoreCool = (th.coreCooling[0] + th.coreCooling[1] * v + extWetCool) * size * (tC - this.ambientC);
        const bGas = gGas * (tC - w.gasTempC);
        w.bandTempsC[b] = tS + (((1 - L.fricToSub) * fricIn * share - q12 - bSurfCool - bRoadCool) / surfaceCap) * dt;
        w.bandCarcassTempsC[b] = tB + ((L.fricToSub * fricIn * share + L.rollToSub * rollHeat * share + q12 - q23) / subCap) * dt;
        w.bandCoreTempsC[b] = tC + (((1 - L.rollToSub) * rollHeat * share + q23 - bCoreCool - bGas) / coreCap) * dt;
      }
      // Cross-band conduction: heat crosses between neighbouring bands through the tread and through the carcass (W/K),
      // each band a third of its layer's heat capacity. Slow next to the bands' own heating and cooling, so camber and
      // pressure keep their inner / outer temperature difference
      const kSurf = ((3 * BAND_TREAD_CONDUCTANCE) / surfaceCap) * dt;
      const kSub = ((3 * BAND_CARCASS_CONDUCTANCE) / subCap) * dt;
      const kCore = ((3 * BAND_CARCASS_CONDUCTANCE) / coreCap) * dt;
      const d01 = kSurf * (w.bandTempsC[0] - w.bandTempsC[1]);
      const d12 = kSurf * (w.bandTempsC[1] - w.bandTempsC[2]);
      w.bandTempsC[0] -= d01;
      w.bandTempsC[1] += d01 - d12;
      w.bandTempsC[2] += d12;
      const m01 = kSub * (w.bandCarcassTempsC[0] - w.bandCarcassTempsC[1]);
      const m12 = kSub * (w.bandCarcassTempsC[1] - w.bandCarcassTempsC[2]);
      w.bandCarcassTempsC[0] -= m01;
      w.bandCarcassTempsC[1] += m01 - m12;
      w.bandCarcassTempsC[2] += m12;
      const c01 = kCore * (w.bandCoreTempsC[0] - w.bandCoreTempsC[1]);
      const c12 = kCore * (w.bandCoreTempsC[1] - w.bandCoreTempsC[2]);
      w.bandCoreTempsC[0] -= c01;
      w.bandCoreTempsC[1] += c01 - c12;
      w.bandCoreTempsC[2] += c12;
      // The tyre's surface temperature is the band surfaces weighted by contact pressure (the rubber on the road: flash
      // temperature, graining); its carcass temperature the bulk and the liner by their heat capacity, the bands
      // averaged (the rubber behind the carcass's vertical and cornering stiffness, and the working-window checks)
      w.surfaceTempC = shares[0] * w.bandTempsC[0] + shares[1] * w.bandTempsC[1] + shares[2] * w.bandTempsC[2];
      const linerMeanC = (w.bandCoreTempsC[0] + w.bandCoreTempsC[1] + w.bandCoreTempsC[2]) / 3;
      w.coreTempC =
        (subCap * (w.bandCarcassTempsC[0] + w.bandCarcassTempsC[1] + w.bandCarcassTempsC[2]) / 3 + coreCap * linerMeanC) /
        (subCap + coreCap);

      // Wear & 16-sector flat-spotting / graining / blistering / dirt pickup
      // A compound with its own wear curve wears by the distance its tread slides over the road (more under more load,
      // when its data says so), as a share of the distance that wears it out; the others by sliding power and rolling
      const wearRt = this.tyres[w.isFront ? 0 : 1];
      const wearDelta = wearRt.wearCurve
        ? ((Math.hypot(w.slipVelX, w.vy) * dt * (td.wear?.loadScaled ? w.fz / (td.wear.loadRefN ?? wearRt.fz0) : 1)) / (1000 * wearRt.wearOutKm)) *
          (w.fz > 0 ? 1 : 0) *
          this.realism.tyreWearScale *
          wetWearScale(traits, this.wetness)
        : (slipPower * 1.4e-8 + w.fz * v * 2.5e-10) * dt * this.realism.tyreWearScale * wetWearScale(traits, this.wetness);
      w.wear = Math.min(1, w.wear + wearDelta);
      const numSec = w.circumferentialWear.length;
      const rimSpeed = Math.abs(w.omega * w.rollingRadius);
      const sec = (((Math.floor((w.rotationRad / (2 * Math.PI)) * numSec) % numSec) + numSec) % numSec);
      if (v > 4.0 && rimSpeed < 0.35 * v) {
        const lockFrac = (0.35 * v - rimSpeed) / (0.35 * v);
        const prevSec = (sec + numSec - 1) % numSec;
        const nextSec = (sec + 1) % numSec;
        const locWear = td.flatSpotSoftness === undefined ? wearDelta * (1 + 11 * lockFrac) : wearDelta * (1 + 11 * lockFrac) * td.flatSpotSoftness;
        w.circumferentialWear[sec] = Math.min(1, w.circumferentialWear[sec] + locWear * 0.6);
        w.circumferentialWear[prevSec] = Math.min(1, w.circumferentialWear[prevSec] + locWear * 0.2);
        w.circumferentialWear[nextSec] = Math.min(1, w.circumferentialWear[nextSec] + locWear * 0.2);
      } else {
        for (let sIdx = 0; sIdx < numSec; sIdx++) {
          w.circumferentialWear[sIdx] = Math.min(1, w.circumferentialWear[sIdx] + wearDelta);
          w.circumferentialTempsC[sIdx] += (w.surfaceTempC - w.circumferentialTempsC[sIdx]) * Math.min(1, dt * 3.5);
        }
      }
      let minSecW = w.circumferentialWear[0];
      let maxSecW = w.circumferentialWear[0];
      for (let sIdx = 1; sIdx < numSec; sIdx++) {
        const sw = w.circumferentialWear[sIdx];
        if (sw < minSecW) minSecW = sw;
        if (sw > maxSecW) maxSecW = sw;
      }
      w.flatSpotSeverity = Math.min(1, Math.max(0, (maxSecW - minSecW) * 18));

      // Graining / blistering against the compound's own working window (a rain tyre's sits lower, a GT or road tyre's
      // lower than an F1 slick's): a tyre worked hard well below it tears its cold tread, one running in or near it
      // cleans up, one far above it blisters
      const rt = this.tyres[w.isFront ? 0 : 1];
      const grain = rt.grain;
      const core = w.coreTempC;
      if (rt.brush) {
        // A brush tyre's tread condition builds slowly, with the work done at the wrong temperature: slip^gamma × the
        // road's grip × rolling speed × the degrees outside the grip curve's peak. Graining wears off as the tyre rolls,
        // or, with `wearOffWithSlip`, only as its tread slides
        const tread = th.tread;
        if (tread && v > 2 && w.fz > 0) {
          const work = w.ground.grip * v * this.realism.tyreWearScale * dt;
          const slip = Math.min(2, w.combinedSlip);
          const [peakFrom, peakTo] = rt.peakWindowC;
          if (core < peakFrom) w.grainLevel += Math.pow(slip, tread.grainGamma) * work * tread.grainGain * (peakFrom - core) * TREAD_CONDITION_RATE;
          const wearOff = tread.wearOffWithSlip ? Math.pow(slip, tread.grainGamma) * work : work;
          w.grainLevel = clamp(w.grainLevel - wearOff * tread.grainGain * GRAIN_WEAR_OFF_RATE, 0, 1);
          if (core > peakTo) {
            w.blisterLevel = Math.min(1, w.blisterLevel + Math.pow(slip, tread.blisterGamma) * work * tread.blisterGain * (core - peakTo) * TREAD_CONDITION_RATE);
          }
        }
      } else {
        const surfCoreDelta = w.surfaceTempC - w.coreTempC;
        if (core < grain.grainBelow && surfCoreDelta > 10 && slipPower > 6000) {
          w.grainLevel = Math.min(1, w.grainLevel + (slipPower / 100000) * ((grain.grainBelow - core) / 30) * 0.25 * dt);
        } else if (core >= grain.healFrom && core <= grain.healTo && w.fz > 500 && slipPower < 25000) {
          w.grainLevel = Math.max(0, w.grainLevel - 0.035 * dt);
        }
        if (core > grain.blisterAbove) {
          w.blisterLevel = Math.min(1, w.blisterLevel + (core - grain.blisterAbove) * 0.0035 * dt);
        }
      }

      w.dirtyLevel = advanceTreadDirt(w.dirtyLevel, w.ground.surface, v, dt, this.trackEvolution.marbleLevel);

      // Brake disc (2 nodes), then the rim it heats by radiation and through the barrel's air, then the gas the rim and
      // the carcass liner heat (implicit: its heat capacity is small next to its conductances), then the pressure
      const frictionTorqueNm = this.lastInputs.brake > 0.01 ? Math.abs(w.brakeTorqueNm) : 0;
      const sprayBoost = this.aeroWake.sprayIntensity ?? 0;
      stepBrakeDiscThermal(
        w.brakeDisc,
        frictionTorqueNm,
        Math.abs(w.omega),
        carSpeedMs,
        this.ambientC,
        dt,
        this.brakeCompound,
        this.brakeDuctShare * (w.isFront ? this.brakeDuctScale.front : this.brakeDuctScale.rear * this.brakeRearDuctShare),
        Math.min(1, this.wetness + 0.5 * sprayBoost),
        this.brakePadCurve
      );
      {
        const disc = w.brakeDisc;
        const tDiscK = disc.surfaceTempC + KELVIN;
        const tRimK = w.rimTempC + KELVIN;
        const qDiscRim =
          STEFAN_BOLTZMANN * rg.discToRimEmissivity * rg.rimBrakeOverlapAreaM2 * (tDiscK * tDiscK * tDiscK * tDiscK - tRimK * tRimK * tRimK * tRimK) +
          (rg.discToRimConvectionWK[0] + rg.discToRimConvectionWK[1] * carSpeedMs) * (disc.coreTempC - w.rimTempC);
        const rimAmbG =
          rg.rimToAmbientConvectionWK[0] + rg.rimToAmbientConvectionWK[1] * carSpeedMs + RIM_WET_SPRAY_SCALE * rimWetEnvironmentCoolingWK(this.wetness, v);
        const rimGasG = rg.rimToGasConductanceWK;
        w.rimTempC += ((qDiscRim - rimAmbG * (w.rimTempC - this.ambientC) - rimGasG * (w.rimTempC - w.gasTempC)) / rg.rimHeatCapacityJK) * dt;
        const k = dt / rg.gasHeatCapacityJK;
        w.gasTempC = (w.gasTempC + k * (gGas * linerMeanC + rimGasG * w.rimTempC)) / (1 + k * (gGas + rimGasG));
      }
      w.pressurePsi = tyreGaugePressureOfGas(w.coldPressurePsi, td.pressureData.coldRefC, w.gasTempC, rg.carcassVolumeStretchPerPsi);
    }
  }

  // ===========================================================================
  // Outputs
  // ===========================================================================

  private updateOutputs(dt: number): void {
    this.updateBasis();
    this.modelPosition.copy(this.position).addScaledVector(_ey, -this.config.chassis.cgHeight);
    const t = this.telemetry;
    const W = this.wheels;
    const inp = this.lastInputs;
    t.speedKmh = this.velocity.length() * 3.6;
    t.rpm = this.rpm;
    t.gear = this.gear;
    t.throttle = inp.throttle;
    t.brake = inp.brake;
    t.steer = inp.steer;
    t.clutchEngagement = this.clutchEngagement;
    t.clutchSlip = this.clutchSlipNorm;
    t.engineStalled = this.stall.stalled;
    if (dt > 0) {
      _v.subVectors(this.velocity, this.prevVelocity).divideScalar(dt);
      t.lonG = _v.dot(_ez) / G;
      t.latG = _v.dot(_ex) / G;
    }
    t.WHEEL_SPEED_LF = W[0].omega;
    t.WHEEL_SPEED_RF = W[1].omega;
    t.WHEEL_SPEED_LR = W[2].omega;
    t.WHEEL_SPEED_RR = W[3].omega;
    t.WHEEL_SR_LF = W[0].slipRatio;
    t.WHEEL_SR_RF = W[1].slipRatio;
    t.WHEEL_SR_LR = W[2].slipRatio;
    t.WHEEL_SR_RR = W[3].slipRatio;
    t.SLIP_ANGLE_LF = W[0].slipAngleRad * RAD2DEG;
    t.SLIP_ANGLE_RF = W[1].slipAngleRad * RAD2DEG;
    t.SLIP_ANGLE_LR = W[2].slipAngleRad * RAD2DEG;
    t.SLIP_ANGLE_RR = W[3].slipAngleRad * RAD2DEG;
    t.BUMPSTOPUP_TRAVEL_LF = W[0].bumpStopTravel;
    t.BUMPSTOPUP_TRAVEL_RF = W[1].bumpStopTravel;
    t.BUMPSTOPUP_TRAVEL_LR = W[2].bumpStopTravel;
    t.BUMPSTOPUP_TRAVEL_RR = W[3].bumpStopTravel;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      t.tyreLoadN[i] = w.fz;
      t.circleFraction[i] = w.circleFraction;
      // The surface last touched; no grip while the wheel is in the air
      t.surface[i] = w.ground.surface;
      t.surfaceGrip[i] = w.grounded ? w.ground.grip : 0;
      t.camberDeg[i] = w.camberLeftRad * RAD2DEG * (w.isLeft ? 1 : -1);
      t.tyreSurfaceTempC[i] = w.surfaceTempC;
      t.tyreCoreTempC[i] = w.coreTempC;
      t.tyrePressurePsi[i] = w.pressurePsi;
    }
    t.aeroHeightFront = this.rideFront;
    t.aeroHeightRear = this.rideRear;
    t.AERO_HEIGHT = 0.5 * (this.rideFront + this.rideRear);
    t.AERO_BALANCE = this.aeroDownN > 1 ? (100 * this.aeroFrontN) / this.aeroDownN : 0;
    t.downforceN = this.aeroDownN;
    t.dragN = this.aeroDragN;
    const ers = this.config.ers;
    t.ERS_CHARGE = this.ersEnergyJ / ers.ERS_MAX_CHARGE;
    t.ERS_CURRENT_CHARGE = this.ersEnergyJ;
    t.ERS_MAX_CHARGE = ers.ERS_MAX_CHARGE;
    t.ERS_MAX_DEPLOY = ers.ERS_MAX_DEPLOY;
    t.MGUK_POWER = this.mgukTorque * this.engineOmega;
    t.ERS_CHARGING = t.MGUK_POWER < 0;
    t.lapDeployJ = this.lapDeployJ;
    t.lapHarvestJ = this.lapHarvestJ;
    t.performanceMode = this.performanceMode;
    t.DRS = this.drsBlend;
    t.drsOpen = this.drsOpen;
    t.wallContact = this.wallContactStep;
    t.wallImpactMs = this.wallImpactStep;
    t.LSD_LOCKING_TORQUE = this.lsdLockTorque;
    t.brakeBias = this.brakeBias;
    t.compound = this.compound;
  }

  private createTelemetry(): VehicleTelemetry {
    const four = () => [0, 0, 0, 0] as [number, number, number, number];
    return {
      speedKmh: 0,
      rpm: 0,
      gear: this.gear,
      throttle: 0,
      brake: 0,
      steer: 0,
      clutchEngagement: 0,
      clutchSlip: 0,
      engineStalled: false,
      lonG: 0,
      latG: 0,
      WHEEL_SPEED_LF: 0,
      WHEEL_SPEED_RF: 0,
      WHEEL_SPEED_LR: 0,
      WHEEL_SPEED_RR: 0,
      WHEEL_SR_LF: 0,
      WHEEL_SR_RF: 0,
      WHEEL_SR_LR: 0,
      WHEEL_SR_RR: 0,
      SLIP_ANGLE_LF: 0,
      SLIP_ANGLE_RF: 0,
      SLIP_ANGLE_LR: 0,
      SLIP_ANGLE_RR: 0,
      BUMPSTOPUP_TRAVEL_LF: 0,
      BUMPSTOPUP_TRAVEL_RF: 0,
      BUMPSTOPUP_TRAVEL_LR: 0,
      BUMPSTOPUP_TRAVEL_RR: 0,
      tyreLoadN: four(),
      circleFraction: four(),
      surface: ['road', 'road', 'road', 'road'],
      surfaceGrip: [1, 1, 1, 1],
      camberDeg: four(),
      tyreSurfaceTempC: four(),
      tyreCoreTempC: four(),
      tyrePressurePsi: four(),
      AERO_HEIGHT: 0,
      aeroHeightFront: 0,
      aeroHeightRear: 0,
      AERO_BALANCE: 0,
      downforceN: 0,
      dragN: 0,
      ERS_CHARGE: 1,
      ERS_CURRENT_CHARGE: this.ersEnergyJ,
      ERS_MAX_CHARGE: this.config.ers.ERS_MAX_CHARGE,
      ERS_MAX_DEPLOY: this.config.ers.ERS_MAX_DEPLOY,
      MGUK_POWER: 0,
      ERS_CHARGING: false,
      lapDeployJ: 0,
      lapHarvestJ: 0,
      performanceMode: this.performanceMode,
      DRS: 0,
      drsOpen: false,
      drsZone: false,
      drsAvailable: false,
      drsQueued: false,
      wallContact: false,
      wallImpactMs: 0,
      LSD_LOCKING_TORQUE: 0,
      brakeBias: this.brakeBias,
      ffbTorqueNorm: 0,
      compound: this.compound,
    };
  }
}
