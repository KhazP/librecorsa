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
import { tyreGaugePressureAtTemperature } from '../tyre-pressure';
import {
  advanceDirtyLevel,
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
  type BrakeDiscState,
  computeDynamicBrakeMigration,
  createBrakeDiscState,
  resetBrakeDiscState,
  stepBrakeDiscThermal,
} from '../brake-physics';
import {
  type AeroWakeState,
  DEFAULT_AERO_WAKE,
  evaluateRollAeroFactor,
} from '../aero-wake';
import {
  DEFAULT_TRACK_EVOLUTION_SAMPLE,
  type TrackEvolutionSample,
} from '../track-evolution';
import {
  dynamicBristleRelaxationScale,
  evaluateFlashTempAndWlfGrip,
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
import {
  type AeroRideHeightMap,
  type AxleSuspensionData,
  type CarPhysicsConfig,
  compoundData,
  DEFAULT_FRICTION_LIMIT_ANGLE_DEG,
  type DamperControllerData,
  type DamperSettingsUnits,
  F12026_CAR_CONFIG,
  type PerformanceModeName,
  type PhysicsTyreCompound,
  type PowerSteeringData,
  type SuspensionSettingUnits,
  suspensionSupportsHeave,
  type TyresCompoundData,
  type TyresPressureData,
  turboSteadyBoost,
  type TyresThermalPatchData,
  type WingData,
  type ZoneData_DRSZone,
} from './F12026CarConfig';
import {
  createGroundHit,
  createWallHit,
  type GroundHit,
  type GroundQuery,
  type TrackSurfaceKind,
  wallPenetration,
  type WallQuery,
  wallSweep,
} from './TrackColliderQuery';
import { queryContactPatch } from './ContactPatch';
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
 * curve's peak), and the graining worn off per unit of (grip × metres rolled × gain): full graining takes tens of
 * minutes of hard work on a cold tyre
 */
const TREAD_CONDITION_RATE = 1e-6;
const GRAIN_WEAR_OFF_RATE = 5e-7;
/** Rolling speed from which a brush tyre's camber thrust is in full (m/s) */
const CAMBER_THRUST_FULL_MS = 3;
/**
 * Rack torque that maps to full FFB output: the sum of both front tyres' moments about their kingpin axes (Nm). The
 * column sees it divided by the steering ratio (≈ 48 Nm on 12.6:1)
 */
const FFB_REFERENCE_NM = 600;
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
/**
 * Barrier contact: restitution, the most rebound a hit can give (m/s: the barrier and the crash structure soak up
 * the rest, so a 300 km/h hit bounces the car back onto the track side, not across it), wall friction, deepest
 * believable penetration (m)
 */
const WALL_RESTITUTION = 0.2;
const WALL_MAX_REBOUND_MS = 5;
const WALL_FRICTION = 0.5;
const WALL_MAX_DEPTH_M = 1.2;
/** Clearance a barrier contact is resolved to, so the next step starts strictly on the near side (m) */
const WALL_SKIN_M = 0.001;
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
  /** DRS button (edge-triggered toggle) */
  drs?: boolean;
}

export type VehicleEvent =
  | { type: 'CHANGED_DRS_OPEN'; open: boolean }
  | { type: 'CHANGED_PERFORMANCE_MODE'; mode: PerformanceModeName }
  | { type: 'GEAR'; gear: number }
  /** Crossed a `ZoneData_DRSZone` detection point; `eligible` = DRS may open in that zone */
  | { type: 'DRS_DETECTION'; zone: string; eligible: boolean }
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
   * Lap progress (0..1) of a world point. With it, DRS only opens inside a zone after crossing that
   * zone's detection point; without it DRS is allowed anywhere and lap energy never resets.
   */
  locateProgress?: (x: number, z: number) => number;
  /** Asked at each detection point whether DRS is earned (e.g. within 1 s of the car ahead); default yes */
  drsEligibleAtDetection?: (zone: ZoneData_DRSZone) => boolean;
  /** Barrier walls (`Track_Collider_Wall_*`); none = no barriers */
  walls?: WallQuery;
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
  /** Inner, Middle, Outer surface band temperatures (°C): the tread surface nodes, which set the grip */
  bandTempsC: [number, number, number];
  /** Inner, Middle, Outer tread-bulk temperatures (°C): between each band's surface and core, for display */
  bandCarcassTempsC: [number, number, number];
  /** Inner, Middle, Outer core temperatures (°C): each band's carcass node */
  bandCoreTempsC: [number, number, number];
  /** Inner, Middle, Outer share of the contact pressure (and of the heat), summing to 1 */
  bandLoadShares: [number, number, number];
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

/** Bilinear look-up in a ride-height table (rows rear, columns front), clamped to its edges */
function rhTable(map: AeroRideHeightMap, table: number[][], front: number, rear: number): number {
  const seg = (axis: number[], x: number): [number, number, number] => {
    const n = axis.length;
    if (x <= axis[0]) return [0, 0, 0];
    if (x >= axis[n - 1]) return [n - 1, n - 1, 0];
    let i = 0;
    while (i < n - 2 && x > axis[i + 1]) i++;
    const span = axis[i + 1] - axis[i];
    return [i, i + 1, span > 0 ? (x - axis[i]) / span : 0];
  };
  const [r0, r1, tr] = seg(map.rearRh, rear);
  const [c0, c1, tc] = seg(map.frontRh, front);
  const top = table[r0][c0] + (table[r0][c1] - table[r0][c0]) * tc;
  const bot = table[r1][c0] + (table[r1][c1] - table[r1][c0]) * tc;
  return top + (bot - top) * tr;
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
const GRIP_TEMP_SURFACE_SHARE = 0.25;
/**
 * The pressure a compound's tyre is set to by default at its `coldRefC` (psi gauge): the one its data states, else the
 * one that reaches the optimum with the carcass at the centre of the working window
 */
export function defaultColdPressurePsi(t: TyresCompoundData): number {
  const p = t.pressureData;
  if (p.setPsi !== undefined) return p.setPsi;
  const targetCoreC = 0.5 * (t.thermalData.optimalTempC[0] + t.thermalData.optimalTempC[1]);
  return Math.round(tyreGaugePressureAtTemperature(p.optimalPsi, targetCoreC, p.coldRefC) * 10) / 10;
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
const _wallHit = createWallHit();
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

export class VehiclePhysics {
  public static readonly FIXED_DT = 0.002;
  public static readonly SUBSTEPS = 4;

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
  /** Road-wheel angle at full lock (rad); the garage's steering ratio changes it */
  public maxSteerRad: number;
  /** Garage: static toe per axle (rad, + = toe-in), engine braking and brake duct cooling relative to the baseline */
  public staticToeRad = { front: 0, rear: 0 };
  public engineBrakingScale = 1;
  public brakeDuctScale = { front: 1, rear: 1 };
  /** Steering compliance (rad of road-wheel angle per N of lateral force) */
  private readonly steerComplianceRadPerN: number;
  private readonly ffbMechanicalTrailM: number;
  private readonly powerSteering: PowerSteeringData | undefined;
  /** Sum / count of the per-step FFB torque since the last takeFfbAverage() */
  private ffbSum = 0;
  private ffbSamples = 0;
  /** 500 Hz outer-step FFB samples accumulated during step() */
  private ffbSubframeSamples: number[] = [];
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
  public ersEnergyJ: number;
  public lapDeployJ = 0;
  public lapHarvestJ = 0;
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
   * A zone opens only after its detection point was crossed eligibly (`drsEligibleAtDetection`, DRS up to 2025).
   * Off: every zone opens for every car (2026 Straight Mode); the detection points are still reported.
   */
  public drsGatedByDetection = true;
  /** The car has a DRS flap at all (off: a car from before 2011, whose flaps never open) */
  public drsFitted = true;
  /** Extra MGU-K deploy allowance this lap on top of `deployPerLapJ` (J): 2026 Overtake Mode */
  public extraDeployJ = 0;
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
    deployVsGear: Lut;
  };
  /** Roll / yaw tables of the ride-height aero map */
  private readonly mapLuts: { rollCl: Lut; rollCd: Lut; rollBalance: Lut; yawCl: Lut; yawCd: Lut; yawBalance: Lut } | null;
  private readonly drsZones: ZoneData_DRSZone[];
  private readonly locateProgress?: (x: number, z: number) => number;
  private readonly drsEligibleAtDetection?: (zone: ZoneData_DRSZone) => boolean;
  private readonly onEvent?: (event: VehicleEvent) => void;
  private walls?: WallQuery;
  private readonly wallIds = new Int32Array(256);
  /** Body-frame points probed against the barriers (floor level, around the outline) */
  public readonly wallProbePoints: THREE.Vector3[];
  /** Wall search radius around the CG: the farthest probe plus a margin (m) */
  private readonly wallQueryRadius: number;
  /** CG at the start of the substep, for the swept barrier test */
  private readonly wallPrevCg = new THREE.Vector3();
  /** Zone whose detection point was crossed eligibly and not yet left */
  private drsArmedZone: string | null = null;
  private lastDrsZoneId: string | null = null;
  private wallContactNow = false;
  private wallContactStep = false;
  private wallImpactStep = 0;
  /** Hardest hit of the contact going on now (m/s); 0 once off the barrier */
  private wallContactPeakMs = 0;

  private timeAccumulator = 0;
  private prevInputs = { shiftUp: false, shiftDown: false, drs: false };
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
  /** Throttle plate the cylinders see, after the air path's lag (`EngineData.torqueResponseS`) */
  private icePlate = 0;
  private lsdLockTorque = 0;
  /**
   * Rear halfshaft twist (rad, + = the diff side ahead of the hub): the mean of the two (it carries the drive torque) and
   * half their left-minus-right difference (it carries the diff's locking torque)
   */
  private shaftTwistMeanRad = 0;
  private shaftTwistHalfDiffRad = 0;
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
    this.locateProgress = options.locateProgress;
    this.drsEligibleAtDetection = options.drsEligibleAtDetection;
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
    };
    this.steerComplianceRadPerN = ((ch.steerComplianceDegPerKN ?? 0) * DEG2RAD) / 1000;
    this.powerSteering = ch.powerSteering;
    this.ffbMechanicalTrailM = ch.ffbMechanicalTrailM ?? DEFAULT_FFB_MECHANICAL_TRAIL_M;
    this.brakeCompound = cfg.brakes.discMaterial ?? 'carbon-ceramic';
    this.drivenWheels = cfg.drivenAxle === 'front' ? [0, 1] : [2, 3];
    // Body axes: X = left (pitch), Y = up (yaw), Z = forward (roll)
    this.dryInertiaBody = new THREE.Vector3(ch.inertia.pitch, ch.inertia.yaw, ch.inertia.roll);
    this.inertiaBody = this.dryInertiaBody.clone();
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

    const modes = cfg.performanceModes;
    this.luts = {
      power: new Lut(cfg.engine.powerCurve),
      coast: new Lut(cfg.engine.coastCurve),
      throttle: new Lut(cfg.engine.throttleResponseCurve),
      mgukDeploy: new Lut(cfg.ers.torqueLut),
      mgukHarvest: new Lut(cfg.ers.coastLut),
      deployVsGear: new Lut(cfg.ers.deployVsGear ?? [[0, 1], [1, 1]]),
      deployVsSpeed: {
        PSH: new Lut(modes.PSH.deployVsSpeed),
        RAC: new Lut(modes.RAC.deployVsSpeed),
        BAL: new Lut(modes.BAL.deployVsSpeed),
        LIC: new Lut(modes.LIC.deployVsSpeed),
        CHR: new Lut(modes.CHR.deployVsSpeed),
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
    this.frontSuspHardpoints = buildDoubleWishboneHardpoints(susp.front.hardpoints, true, susp.front.actuation, kinOptions);
    this.rearSuspHardpoints = buildDoubleWishboneHardpoints(susp.rear.hardpoints, false, susp.rear.actuation, kinOptions);

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
        circumferentialTempsC: circTemps,
        circumferentialWear: new Float32Array(16),
        wear: 0,
        flatSpotSeverity: 0,
        grainLevel: 0,
        blisterLevel: 0,
        dirtyLevel: 0,
        brakeDisc: createBrakeDiscState(380, this.brakeCompound),
        coldPressurePsi: 0,
        pressurePsi: 0,
        brakeTorqueNm: 0,
        driveTorqueNm: 0,
      };
    };
    this.wheels = [mkWheel(0), mkWheel(1), mkWheel(2), mkWheel(3)];

    // Barrier probes: nose, front wheels, sidepods, rear wheels, tail (body frame, x left, z forward)
    const geo = this.tyres[0].data;
    const halfF = tf + 0.5 * geo.front.width;
    const halfR = tr + 0.5 * geo.rear.width;
    const wingZ = cfg.aero.wings.map((wg) => wg.positionZ);
    const noseZ = Math.max(a, ...wingZ) + 0.3;
    const tailZ = Math.min(-b, ...wingZ) - 0.3;
    const py = cfg.aero.floorOffsetY + 0.2;
    this.wallProbePoints = [];
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
    this.wallQueryRadius = Math.max(...this.wallProbePoints.map((p) => Math.hypot(p.x, p.z))) + 0.5;
    this.setTyreBlanketState();
    this.computeStaticGeometry();

    this.engineOmega = cfg.engine.idleRpm * RPM2RADS;
    this.turbocharged = cfg.engine.turbo !== undefined;
    this.ersEnergyJ = cfg.ers.ERS_MAX_CHARGE;
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

  /** Reset the ERS per-lap deploy / harvest allowances (called automatically on a lap wrap) */
  public resetLapEnergy(): void {
    this.lapDeployJ = 0;
    this.lapHarvestJ = 0;
  }

  /** Front brake bias including the performance mode's and the driver's EBB offsets */
  public get brakeBias(): number {
    const br = this.config.brakes;
    const steps = this.config.performanceModes[this.performanceMode].ebbOffset + this.ebbUser;
    return THREE.MathUtils.clamp(br.front_bias + br.ebbStep * steps, 0.3, 0.8);
  }

  /**
   * The driver dials the bias they want now: it is kept as their EBB offset (`ebbUser`, fractional steps) on top of
   * the running performance mode's, so a later mode change still moves the bias by that mode's offset
   */
  public set brakeBias(val: number) {
    const br = this.config.brakes;
    const want = THREE.MathUtils.clamp(val, 0.3, 0.8);
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
  /** Places the car at rest (or rolling at `speedMs`) on the ground at x, z; `keepTyres` keeps tyre and brake heat and wear (a flashback) */
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
    this.engineOmega = this.config.engine.idleRpm * RPM2RADS;
    this.turboBoostBar = 1.0;
    this.turboBoost = 0;
    this.drsOpen = false;
    this.drsBlend = 0;
    this.drsRequested = false;
    this.drsArmedZone = null;
    this.lastDrsZoneId = null;
    this.trackProgress = Number.NaN;
    this.wallContactNow = false;
    this.mapAeroFrontN = 0;
    this.mapAeroRearN = 0;
    this.mapAeroDragN = 0;
    this.wallPrevCg.copy(this.position);
    // Tyres kept through a flashback are only worth keeping while their state is a number
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
    // tyre carcasses wind up against any slope
    const h = VehiclePhysics.FIXED_DT / VehiclePhysics.SUBSTEPS;
    const rolling = speedMs > 0;
    const hold: VehicleInputs = { throttle: 0, brake: rolling ? 0 : 1, steer: 0 };
    if (rolling) this.gear = this.gearForSpeed(speedMs);
    for (let k = 0; k < 300 * VehiclePhysics.SUBSTEPS; k++) {
      this.updateBasis();
      this.velocity.x = speedMs * _ez.x;
      this.velocity.z = speedMs * _ez.z;
      // Free-rolling at the road speed under each tyre: held at speed / r, the tyres would drive (or brake) the
      // pinned car through the whole settle, and on a grade that thrust pitches it up
      for (const w of this.wheels) w.omega = (k === 0 ? speedMs : Math.max(0, w.vx)) / Math.max(0.2, w.rollingRadius || 0.35);
      if (rolling) this.engineOmega = this.drivenOmega() * this.totalRatio();
      this.substep(h, hold);
      this.position.x = x;
      this.position.z = z;
      this.angularVelocity.y = 0;
    }
    if (!rolling) {
      for (let k = 0; k < 600 * VehiclePhysics.SUBSTEPS; k++) this.substep(h, hold);
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
    return { gradeRad: THREE.MathUtils.clamp(gradeRad, -lim, lim), bankRad: THREE.MathUtils.clamp(bankRad, -lim, lim) };
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
    this.icePlate = 0;
    this.lsdLockTorque = 0;
    this.shaftTwistMeanRad = 0;
    this.shaftTwistHalfDiffRad = 0;
    this.mgukTorque = 0;
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
    if (!Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z + w.x + w.y + w.z + q.x + q.y + q.z + q.w + this.engineOmega)) return false;
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

  /** Blanket temperature, cold pressure that reaches the optimum with the core at the window centre */
  private setTyreBlanketState(): void {
    for (const w of this.wheels) {
      const t = this.tyres[w.isFront ? 0 : 1].data;
      const p = t.pressureData;
      w.coldPressurePsi = defaultColdPressurePsi(t);
      w.surfaceTempC = p.coldRefC;
      w.coreTempC = p.coldRefC;
      w.bandTempsC = [p.coldRefC, p.coldRefC, p.coldRefC];
      w.bandCarcassTempsC = [p.coldRefC, p.coldRefC, p.coldRefC];
      w.bandCoreTempsC = [p.coldRefC, p.coldRefC, p.coldRefC];
      w.circumferentialTempsC.fill(p.coldRefC);
      w.circumferentialWear.fill(0);
      w.wear = 0;
      w.flatSpotSeverity = 0;
      w.grainLevel = 0;
      w.blisterLevel = 0;
      w.dirtyLevel = 0;
      resetBrakeDiscState(w.brakeDisc, 380, this.brakeCompound);
      w.pressurePsi = w.coldPressurePsi;
    }
  }

  /** Fuel on board (kg) */
  public get fuelMassKg(): number {
    return this.fuelKg;
  }

  /**
   * Fuel on board (kg): its mass rides with the body and the moments of inertia grow with the mass, as the VF26's
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
    const c = THREE.MathUtils.clamp;
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
      drs: !!i.drs,
    };
  }

  private handleEdges(inp: VehicleInputs): void {
    if (inp.shiftUp && !this.prevInputs.shiftUp) this.paddleShift(1);
    if (inp.shiftDown && !this.prevInputs.shiftDown) this.paddleShift(-1);
    if (inp.drs && !this.prevInputs.drs) this.drsRequested = !this.drsOpen;
    this.prevInputs.shiftUp = !!inp.shiftUp;
    this.prevInputs.shiftDown = !!inp.shiftDown;
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

  private requestShift(target: number): boolean {
    const gb = this.config.gearbox;
    let g = THREE.MathUtils.clamp(target, -1, gb.ratios.length);
    // A sequential box has no neutral between first and reverse: down from first is reverse (only near standstill,
    // below), up from reverse is first
    if (g === 0) g = target < this.gear ? -1 : 1;
    if (g === this.gear) return false;
    // Over-rev protection on downshifts (seamless boxes refuse the shift)
    if (g > 0 && g < this.gear) {
      this.updateBasis();
      if (this.roadRpm(g) > gb.gears.redline_rpm - 200) return false;
    }
    // Reverse only near standstill
    if (g < 0 && this.velocity.length() > 2) return false;
    const down = g > 0 && g < this.gear;
    if (g > this.gear) this.sinceUpshiftS = 0;
    if (down) this.sinceDownshiftS = 0;
    // A managed up-shift: the engine meets the new gear at the speed the driven wheels turn at, so the closed clutch
    // does not spin them up with the engine's inertia. The wheels' speed, not the road's: a spinning axle keeps its spin
    if (gb.upshiftCutS && this.gear > 0 && g > this.gear && this.clutchEngagement > 0.5) {
      this.engineOmega *= gb.ratios[g - 1] / gb.ratios[this.gear - 1];
    }
    this.gear = g;
    this.shiftTimer = down ? (gb.downshiftTimeS ?? gb.shiftTimeS) : gb.shiftTimeS;
    // The ECU blips the engine up to the new gear's road speed on a downshift, so the closed clutch does not
    // jerk the rear axle down by the engine's inertia (that impulse locked the rears under trail braking).
    // Road speed, not wheel speed: matching spinning wheels would feed the wheelspin.
    if (down && this.clutchEngagement > 0.5) {
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
    // Wheelspin may lift the engine at most 30 % over road speed for shift purposes; road speed while the clutch slips
    a.engineRpm = this.clutchEngagement >= 0.99 ? Math.min(this.rpm, road * 1.3) : road;
    a.roadRpm = road;
    // Downshifts go by road speed: locked wheels must not drag the box down through the gears
    a.lowerGearRpm = this.roadRpm(this.gear - 1);
    a.throttle = throttle;
    a.brake = brake;
    a.sinceUpshiftS = this.sinceUpshiftS;
    a.sinceDownshiftS = this.sinceDownshiftS;
    const [dl, dr] = this.drivenWheels;
    a.drivenGrounded = this.wheels[dl].fz > 1 || this.wheels[dr].fz > 1;
    a.drivenSpinning = Math.max(this.wheels[dl].slipRatio, this.wheels[dr].slipRatio) > 0.14;
    const shift = autoShift(a, this.autoShiftSchedule, this.manualShift);
    if (shift !== 0) this.requestShift(this.gear + shift);
  }

  private updateDrs(inp: VehicleInputs, dt: number): void {
    let inZone = true;
    let armed = true;
    if (this.locateProgress && Number.isFinite(this.position.x) && Number.isFinite(this.position.z)) {
      const p = this.locateProgress(this.position.x, this.position.z);
      const prev = this.trackProgress;
      if (Number.isFinite(prev) && Number.isFinite(p)) {
        if (prev > 0.9 && p < 0.1) this.resetLapEnergy();
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
        }
      }
      this.trackProgress = p;
      const zone = Number.isFinite(p) ? this.drsZones.find((z) => inLapWindow(p, z.start, z.end)) : undefined;
      // Leaving the zone spends its eligibility
      if (!zone && this.lastDrsZoneId !== null && this.drsArmedZone === this.lastDrsZoneId) this.drsArmedZone = null;
      this.lastDrsZoneId = zone?.id ?? null;
      inZone = zone !== undefined;
      armed = zone !== undefined && (!this.drsGatedByDetection || this.drsArmedZone === zone.id);
    }
    if (!this.drsFitted) inZone = armed = false;
    const dryEnoughForDrs = isRearFlapAllowedInWet(this.wetness);
    this.telemetry.drsZone = inZone;
    this.telemetry.drsAvailable = inZone && armed && dryEnoughForDrs;
    // Closes on the brake, a lift, or when track wetness exceeds the rear flap threshold
    const lifted = inp.brake > 0.05 || inp.throttle < this.config.aero.drsCloseThrottle;
    const open = this.drsRequested && inZone && armed && dryEnoughForDrs && !lifted;
    if (!open) this.drsRequested = false;
    if (open !== this.drsOpen) {
      this.drsOpen = open;
      this.onEvent?.({ type: 'CHANGED_DRS_OPEN', open });
    }
    const rate = dt / Math.max(1e-3, this.config.aero.drsTransitionS);
    this.drsBlend = THREE.MathUtils.clamp(this.drsBlend + (open ? rate : -rate), 0, 1);
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
    const h = dt / VehiclePhysics.SUBSTEPS;
    for (let k = 0; k < VehiclePhysics.SUBSTEPS; k++) this.substep(h, inp);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.manualShift.tick(dt);
    this.sinceUpshiftS += dt;
    this.sinceDownshiftS += dt;
    this.limiterTimer = Math.max(0, this.limiterTimer - dt);
    // Turbo: spools toward the boost the cylinders' air asks for, faster the more exhaust there is; runs down slowly
    const turbo = this.config.engine.turbo;
    if (turbo && this.turbocharged) {
      const target = turboSteadyBoost(turbo, this.rpm) * this.icePlate;
      const tau = target > this.turboBoost ? (turbo.spoolUpS * turbo.spoolRefRpm) / Math.max(this.rpm, this.config.engine.idleRpm) : turbo.spoolDownS;
      this.turboBoost += (target - this.turboBoost) * Math.min(1, dt / tau);
      this.turboBoostBar = 1 + (turbo.displayMaxBoostBar * this.turboBoost) / turbo.maxBoost;
    } else {
      this.turboBoostBar = 1;
    }
    this.updateThermal(dt);
    this.updateOutputs(dt);
    // Keep the newest samples: a long frame drops its oldest, not its latest, torque
    if (this.ffbSubframeSamples.length >= FFB_SUBFRAME_MAX) this.ffbSubframeSamples.shift();
    this.ffbSubframeSamples.push(-this.telemetry.ffbTorqueNorm);
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
   * Aero drag −`perMs`·air (N) at the drag's centre of pressure (`AeroData.dragCentreY` above the CG): above the CG it
   * pitches the nose up and loads the rear axle, as the rear wing's and wheels' drag do on the real car
   */
  private addDragAtCentre(air: THREE.Vector3, perMs: number): void {
    _f.copy(air).multiplyScalar(-perMs);
    _p.set(0, this.config.aero.dragCentreY ?? 0, 0).applyQuaternion(this.quaternion).add(this.position);
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

  private substep(h: number, inp: VehicleInputs): void {
    this.updateBasis();
    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
    const upY = Math.max(0.3, _ey.y);

    // ---- corner kinematics & ground contact
    for (const w of this.wheels) {
      w.hardpointWorld.copy(w.hardpoint).applyQuaternion(this.quaternion).add(this.position);
      _r.subVectors(w.hardpointWorld, this.position);
      w.hardpointVel.crossVectors(this.angularVelocity, _r).add(this.velocity);
      w.grounded = this.queryContactPatch(w);
      if (w.grounded) this.climbStep(w, h);
      else w.contactY = Number.NaN;
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
      for (let side = 0; side < 2; side++) {
        const w = side === 0 ? L : R;
        let f = springForce(w.springPreload + w.compression, s.springs);
        const intoRubber = w.compression - s.bumpStop.range;
        if (intoRubber > 0) f += s.bumpStop.rate * intoRubber + s.bumpStop.progression * intoRubber * intoRubber;
        const hard = s.bumpStop.hardStop;
        if (hard && w.compression > hard.range) f += hard.rate * (w.compression - hard.range);
        const pastDroop = -s.droopTravel - w.compression;
        if (pastDroop > 0) f -= DROOP_STOP_RATE * pastDroop + DROOP_STOP_DAMP * Math.max(0, -w.compressionVel);
        f += damperForce(d.base, w.compressionVel, knee, reboundKnee);
        w.suspensionForce = f;
        w.bumpStopTravel = s.bumpStop.range - w.compression;
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
      const leanBody = Math.asin(THREE.MathUtils.clamp(_ey.dot(_lw), -1, 1));
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
        w.slipRatio = THREE.MathUtils.clamp(w.slipRatio, -5, 5);
        w.tanSlipAngle = THREE.MathUtils.clamp(w.tanSlipAngle, -5, 5);
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
        // brush tyre's grip curve is drawn against the temperature of its rubber as a whole: mostly the carcass, a
        // quarter the tread surface, so a flash of surface heat or a cool straight moves it little
        const sh = w.bandLoadShares;
        const k = tyre.brush ? GRIP_TEMP_SURFACE_SHARE : 1;
        const thermal = realismThermalGrip(
          sh[0] * tyre.thermal.evaluate(w.bandCoreTempsC[0] + k * (w.bandTempsC[0] - w.bandCoreTempsC[0])) +
            sh[1] * tyre.thermal.evaluate(w.bandCoreTempsC[1] + k * (w.bandTempsC[1] - w.bandCoreTempsC[1])) +
            sh[2] * tyre.thermal.evaluate(w.bandCoreTempsC[2] + k * (w.bandTempsC[2] - w.bandCoreTempsC[2])),
          this.realism
        );
        const pressureGrip = tyrePressureGrip(td.pressureData, w.pressurePsi);
        w.thermalGrip = thermal;
        // Wear, graining, blistering, dirt and flat-spots, as the VF26's tyre model (ac-tyre computeTyreForces)
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
        const wlf = evaluateFlashTempAndWlfGrip(traits, w.surfaceTempC, Math.hypot(vsx, vy), fz, wWetness);
        const base =
          thermal *
          wlf.viscoelasticMult *
          pressureGrip *
          degradation *
          g.grip *
          this.trackEvolution.gripMultiplier *
          wet *
          this.damageGrip[i];

        // Camber grip: leaning into the force direction (force opposes the slip)
        const forceSign = w.tanSlipAngle > 0 ? -1 : 1;
        const gInto = w.camberLeftRad * forceSign;
        const camberGrip = THREE.MathUtils.clamp(1 + cam.dcamber0 * gInto + cam.dcamber1 * gInto * gInto, 0.7, 1.1);
        const gAbs = Math.abs(w.camberLeftRad);
        const camberGripX = THREE.MathUtils.clamp(1 + cam.dcamber0_x * gAbs + cam.dcamber1_x * gAbs * gAbs, 0.7, 1.1);
        // Peak μ at this load: the compound's load tables, else the power law about Fz0. BRAKE_DX_MOD adds
        // longitudinal grip while the tyre is braking
        const dY = tyrePeakMu(tyre, fz, 'y');
        const dX = tyrePeakMu(tyre, fz, 'x');
        const brakeMod = w.slipRatio < 0 ? 1 + tyre.brakeDxMod : 1;
        // A brush tyre loses grip with its sliding speed
        const speedGrip = tyre.brush ? brushSpeedGrip(tyre.brush, Math.hypot(vsx, vy)) : 1;
        const muY = dY * base * camberGrip * speedGrip;
        const muX = dX * brakeMod * base * camberGripX * speedGrip;
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
          const gc = THREE.MathUtils.clamp(w.camberLeftRad, -tyre.camberThrustLimit, tyre.camberThrustLimit);
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
        const slipUse = Math.hypot(fx / (muX * fz), fy / (muY * fz));
        const fade = Math.max(0, 1 - absVx / LOW_SPEED_FADE_MS);
        if (fade > 0) {
          fx += fade * LOW_SPEED_DAMPING * muX * fz * vsx;
          fy -= fade * LOW_SPEED_DAMPING * muY * fz * vy;
        }
        // The slip forces sit on or inside the friction ellipse already (a brush tyre's combined-slip exponent may
        // take them a little past it); the low-speed damping must not push them further
        const limit = Math.max(1, slipUse);
        const use = Math.hypot(fx / (muX * fz), fy / (muY * fz));
        if (use > limit) {
          fx *= limit / use;
          fy *= limit / use;
        }
        // Telemetry only: share of the friction ellipse in use (1 = on it)
        w.circleFraction = Math.min(use, 1);

        // Self-aligning moment: pneumatic trail collapsing toward the limit and over standing water (hydroplaning wedge)
        const wetTrailMult =
          wWaterMm > 0
            ? wetPneumaticTrailScale(td.wetTraits ?? SLICK_TRAITS, wWaterMm, absVx, w.wear)
            : 1;
        // The pneumatic trail at zero slip is a third of the patch half-length (brush model, parabolic pressure), so it
        // grows with the load as the patch lengthens
        w.patchHalfLengthM = contactHalfLengthM(R0, w.deflection);
        w.mz = -fy * (w.patchHalfLengthM / 3) * wetTrailMult * Math.max(0, 1 - s);
        const yCpShift = THREE.MathUtils.clamp(
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
        w.mzTwist = -THREE.MathUtils.clamp(kTwist * (w.twistRad + PATCH_TWIST_DAMPING_S * twistRate), -mTwistMax, mTwistMax);
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
        // The solved upright's own kingpin ground offsets (the blended scrub / trail fields stay for the VF26)
        _kpGeo.kpiRad = kin.kpiRad;
        _kpGeo.casterRad = kin.casterRad;
        _kpGeo.scrubRadiusM = kin.kingpinScrubM;
        _kpGeo.casterTrailM = kin.kingpinTrailM;
        const tyreKingpinNm = kingpinMomentNm(
          _ex, _ey, _ez, _n, _fw, _lw, w.isLeft ? -1 : 1, w.steerRad, w.loadedRadius, _kpGeo, fx, fy, fz, w.mz + w.mzTwist, w.mx
        );
        w.gyroSteerNm = this.wheelGyroSteerNm(w, _fw);
        ffbMz += tyreKingpinNm + flatSpotVibrationNm(w.flatSpotSeverity, w.rotationRad, w.omega, fz) + w.gyroSteerNm;
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
    }
    // The rim feels the driver's share of the rack torque, the power steering's assist taking the rest
    const driverNm = driverRackTorqueNm(ffbMz, this.velocity.dot(_ez), this.powerSteering);
    this.telemetry.ffbTorqueNorm = THREE.MathUtils.clamp(driverNm / FFB_REFERENCE_NM, -1, 1);
    this.ffbSum += this.telemetry.ffbTorqueNorm;
    this.ffbSamples++;

    // ---- drivetrain, brakes and wheel spin
    this.solveDrivetrain(h, inp, tyreTorque);

    // ---- aero, then the plank if the floor reaches the road
    if (this.config.aero.rhMap) this.applyMapAero(h, this.config.aero.rhMap);
    else this.applyAero();
    this.applyPlankContact();

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

    this.applyWallContacts();
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
    // On its side or nose-down the wheel has no horizontal heading: probe at the hub alone
    if (fl < 1e-3) return this.ground.query(p.x, p.z, p.y + GROUND_PROBE_UP_M, w.ground);
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
   * Barriers: the outline probes against the wall segments. A probe past a wall (on the far side from the CG, within
   * the segment) gets an impulse with a capped rebound and wall friction, and the body is pushed fully back out along
   * the wall normal. The impulse acts at the CG's height: a barrier loads the whole side of the body, so a hit yaws
   * the car but does not roll it over the wall. The CG's own path is swept against the walls as well, so it can never
   * end up behind one (the side the CG is on is what the probes measure from).
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
    if (wallSweep(walls, this.wallIds, n, prev.x, prev.z, p.x, p.z, p.y, WALL_Y_SLACK_M, _wallHit) >= 0) {
      this.wallContactNow = true;
      p.x += _wallHit.nx * (_wallHit.depth + WALL_SKIN_M);
      p.z += _wallHit.nz * (_wallHit.depth + WALL_SKIN_M);
      impact = Math.max(impact, this.wallImpulse(_r.set(0, 0, 0), _wallHit.nx, _wallHit.nz));
    }
    for (const probe of this.wallProbePoints) {
      _p.copy(probe).applyQuaternion(this.quaternion).add(p);
      const depth = wallPenetration(walls, this.wallIds, n, _p.x, _p.y, _p.z, p.x, p.z, WALL_MAX_DEPTH_M, WALL_Y_SLACK_M, _wallHit);
      if (depth <= 0) continue;
      this.wallContactNow = true;
      _r.subVectors(_p, p);
      _r.y = 0;
      const hitMs = this.wallImpulse(_r, _wallHit.nx, _wallHit.nz);
      if (hitMs > impact) {
        impact = hitMs;
        hitX = probe.x;
        hitZ = probe.z;
      }
      p.x += _wallHit.nx * (depth + WALL_SKIN_M);
      p.z += _wallHit.nz * (depth + WALL_SKIN_M);
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
    const cfg = this.config;
    const eng = cfg.engine;
    const gb = cfg.gearbox;
    const ers = cfg.ers;
    const mode = cfg.performanceModes[this.performanceMode];
    const W = this.wheels;
    const ratio = this.totalRatio();
    const rpm = this.rpm;
    const omegaE = Math.max(50, this.engineOmega);

    // ---- ICE (with live Engine Torque Map 1..5)
    if (rpm >= gb.gears.redline_rpm) this.limiterTimer = eng.limiterCutS;
    const mapIdx = THREE.MathUtils.clamp(Math.round(this.engineMap), 1, 5);
    const engineMapTorqueScale = [1.0, 0.985, 0.96, 0.925, 0.87][mapIdx - 1] ?? 1.0;
    // The softer low-gear pedal: the driver's own choice (engine maps 4 and 5), and on a power unit with a wet pedal map
    // the ECU's on a wet road. A car without one keeps the pedal its driver set
    const wetPedalBlend = Math.max(eng.wetPedalMap ? this.wetness : 0, mapIdx >= 4 ? (mapIdx - 3) * 0.35 : 0);
    const lowGearWetExp = this.gear >= 1 && this.gear <= 4 ? (5 - this.gear) * 0.065 * wetPedalBlend : 0;
    const baseExp = (mapIdx >= 3 ? 1 + (mapIdx - 2) * 0.12 : 1) + lowGearWetExp;
    const rawThrottle = baseExp > 1 ? Math.pow(inp.throttle, baseExp) : inp.throttle;
    let plate = this.luts.throttle.evaluate(rawThrottle);
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
    plate = Math.max(this.icePlate, THREE.MathUtils.clamp((eng.idleRpm + 200 - rpm) / 800, 0, 0.15));
    if (this.limiterTimer > 0) plate = 0;
    // A managed up-shift takes the drive away while it lasts: the spark, and with it the MGU-K's deployment below
    const shiftCut = gb.upshiftCutS !== undefined && this.sinceUpshiftS < gb.upshiftCutS;
    const sparkShare = shiftCut ? 0 : (inp.ignitionCut ?? 1);
    // Turbo lag: the curve is the torque with the boost this plate makes in steady state; while the rotor trails it the
    // torque is (1 + boost made) / (1 + boost asked for) of that, as torque ∝ 1 + boost. A rotor still spinning faster
    // than the demand gives no more than the demand (the wastegate and the throttle hold the plenum to it)
    const turbo = eng.turbo;
    const boostShare =
      turbo && this.turbocharged ? Math.min(1, (1 + this.turboBoost) / (1 + turboSteadyBoost(turbo, rpm) * plate)) : 1;
    const tCombustion = (plate * sparkShare * this.luts.power.evaluate(rpm) * engineMapTorqueScale * 1000) / omegaE;
    let tIce = tCombustion * boostShare - (1 - plate) * this.luts.coast.evaluate(rpm) * mode.coastTorqueScale * this.engineBrakingScale;
    // Crank torque the lag costs, which the MGU-K may fill below
    let turboDeficit = tCombustion * (1 - boostShare);
    if (this.shiftTimer > 0 && tIce > 0) {
      tIce *= gb.shiftTorqueFraction;
      turboDeficit *= gb.shiftTorqueFraction;
    }
    if (tIce > 0) tIce *= this.damagePowerMult;

    // ---- clutch engagement
    const axleOmega = this.drivenOmega();
    const wheelSideRpm = Math.abs(axleOmega * ratio) * RADS2RPM;
    const cl = cfg.clutch;
    let engage = 0;
    if (this.gear !== 0) {
      const t = THREE.MathUtils.clamp((rpm - cl.biteRpm) / (cl.lockRpm - cl.biteRpm), 0, 1);
      engage = wheelSideRpm >= cl.lockRpm ? 1 : t * t * (3 - 2 * t);
      if (inp.clutch !== undefined) engage = Math.min(engage, 1 - inp.clutch);
    }
    this.clutchEngagement = engage;
    const clutchCap = cl.maxTorqueNm * engage;

    // ---- MGU-K (crank torque, + deploy / − harvest)
    const soc = this.ersEnergyJ / ers.ERS_MAX_CHARGE;
    const speedKmh = this.velocity.length() * 3.6;
    const topGear = this.gear === gb.ratios.length;
    let pK = 0;
    /** The ECU may deploy now: the MGU-K then also fills the torque the turbo lag costs */
    let deployAllowed = false;
    const coupled = engage > 0.9 && this.gear > 0;
    if (coupled) {
      if (inp.brake > 0.05) {
        pK = -ers.maxHarvestW * mode.brakeHarvestScale * Math.min(1, inp.brake * 3);
      } else if (topGear && inp.throttle < ers.liftThrottle) {
        pK = -ers.topGearLiftHarvestW * mode.liftHarvestScale;
      } else if (topGear && inp.throttle > 0.95 && mode.topGearClipHarvestW > 0) {
        pK = -mode.topGearClipHarvestW;
      } else if (inp.throttle > 0.05 && inp.throttle < 0.9 && mode.partThrottleHarvestW > 0) {
        pK = -mode.partThrottleHarvestW;
      } else if (inp.throttle > 0.05 && soc > mode.socFloor && this.lapDeployJ < ers.deployPerLapJ + this.extraDeployJ) {
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
      }
      if (pK < 0 && (soc >= 1 || this.lapHarvestJ >= ers.harvestPerLapJ)) pK = 0;
    }
    // ---- brake bias (brake-by-wire + live-tunable dynamic brake migration)
    const br = cfg.brakes;
    const mig = br.migration ?? { amount: 0.015, rampStart: 0 };
    const migAmount = this.liveBrakeMigrationAmount;
    this.dynamicBrakeBias =
      br.brakeByWire !== false || migAmount > 0
        ? computeDynamicBrakeMigration(this.brakeBias, inp.brake, migAmount, mig.rampStart)
        : this.brakeBias;
    const bias = this.dynamicBrakeBias;

    let tK = 0;
    if (pK > 0) tK = Math.min(pK / omegaE, this.luts.mgukDeploy.evaluate(rpm)) * sparkShare;
    else if (pK < 0) {
      let cap = this.luts.mgukHarvest.evaluate(rpm);
      // On the pedal the brake-by-wire never lets the drivetrain brake the rear axle past its share of the demand:
      // harvest fills what the engine overrun leaves of it, the rear calipers the rest
      if (inp.brake > 0.05 && br.brakeByWire !== false && ratio !== 0) {
        const rearDemand = 2 * inp.brake * br.maxTorqueNm * (1 - bias);
        cap = Math.min(cap, Math.max(0, rearDemand / (Math.abs(ratio) * gb.efficiency) - Math.max(0, -tIce)));
      }
      tK = -Math.min(-pK / omegaE, cap);
    }
    // Torque fill: with no MGU-H to spin the turbo, the MGU-K makes up the torque its lag costs, within the motor's torque
    // curve and the gear's power clip, from the same store and lap allowance as the deploy
    if (deployAllowed && turboDeficit > 0) {
      const fillCap = Math.min(this.luts.mgukDeploy.evaluate(rpm), (ers.ERS_MAX_DEPLOY * this.luts.deployVsGear.evaluate(this.gear)) / omegaE);
      tK = Math.max(tK, Math.min(fillCap * sparkShare, tK + turboDeficit));
    }
    if (this.limiterTimer > 0 && tK > 0) tK = 0;
    this.mgukTorque = tK;

    // ---- brakes (physical brake pad μ(T))
    const crankBrake = Math.max(0, -tK) + Math.max(0, -tIce);
    // The slowing engine gives up some of its own inertia's torque, so a little less than the crank's braking reaches the
    // wheels: this share keeps the rear axle on its demand under harvest (scripts/verify-powertrain.ts)
    const driveBrake = inp.brake > 0.05 && br.brakeByWire !== false ? (crankBrake * engage * Math.abs(ratio) * gb.efficiency) / 2 : 0;
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
      const scrub = (tyre.rollingResistanceSlipGain ?? 0) * Math.min(w.combinedSlip, SCRUB_MAX_SLIP) * Math.min(1, Math.abs(w.omega) / SCRUB_FULL_SPIN_RADS);
      const rollingResistance = (tyre.rollingResistance + (tyre.rollingResistanceSpeedSq ?? 0) * rollV * rollV) * softDrag * (1 + scrub * softDrag);
      const handbrake = !w.isFront && inp.handbrake ? inp.handbrake * (br.handbrakeTorqueNm ?? 0) : 0;
      w.brakeTorqueNm = friction + handbrake + w.fz * rollingResistance * w.rollingRadius;
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
    const cot = (deg: number) => 1 / Math.tan(Math.max(5, deg) * DEG2RAD);
    const hiSpdKmh = diffCfg.hiSpdSwitchKmh ?? 250;
    // Phase weights, blended as an ECU blends its diff maps rather than switched: the entry map on the brake, the exit
    // map on the power, the mid map between. A light pedal with the lock on (trail braking into the apex, maintenance
    // throttle at it) stays with the mid map until the pedal commits
    const smooth = THREE.MathUtils.smoothstep;
    const turnedIn = smooth(Math.abs(inp.steer) * this.maxSteerRad * RAD2DEG, DIFF_TURNED_IN_DEG[0], DIFF_TURNED_IN_DEG[1]);
    const brakeW = smooth(inp.brake, DIFF_BRAKE_PHASE[0], DIFF_BRAKE_PHASE[1]);
    const powerW = smooth(inp.throttle, DIFF_POWER_PHASE[0], DIFF_POWER_PHASE[1]);
    let entryW = brakeW * (1 - turnedIn * (1 - brakeW));
    let exitW = powerW * (1 - turnedIn * (1 - powerW)) * (1 - brakeW);
    let powerCoeff = diff.power;
    let coastCoeff = THREE.MathUtils.lerp(diff.coast, diffCfg.coastBraking ?? diff.coast, entryW);
    if (diffCfg.threePhase) {
      // Past the high-speed switch (and at a standstill launch) the exit map holds for straight-line stability
      const hiSpdW = speedKmh < 1 ? 1 : smooth(speedKmh, hiSpdKmh - DIFF_HISPD_BLEND_KMH, hiSpdKmh + DIFF_HISPD_BLEND_KMH);
      entryW *= 1 - hiSpdW;
      exitW = Math.max(exitW, hiSpdW);
      const level = (dial: number) => (THREE.MathUtils.clamp(dial, 1, 12) - 1) / 11;
      const mid = level(this.diffMidLevel);
      powerCoeff = THREE.MathUtils.lerp(mid, level(this.diffExitLevel), exitW);
      coastCoeff = THREE.MathUtils.lerp(mid, level(this.diffEntryLevel), entryW);
    } else {
      // A plain ramp diff locks by its data (POWER / COAST) with the dials where the car has them; turning a dial
      // scales that lock, 0.65× at 1 to 1.35× at 12, about the car's own position. An open diff stays open (no floor)
      const dial = (level: number) => 0.65 + ((THREE.MathUtils.clamp(level, 1, 12) - 1) / 11) * 0.7;
      powerCoeff = THREE.MathUtils.clamp((diff.power * dial(this.diffExitLevel)) / dial(this.diffExitDefault), 0, 1);
      coastCoeff = THREE.MathUtils.clamp((coastCoeff * dial(this.diffEntryLevel)) / dial(this.diffEntryDefault), 0, 1);
    }
    this.diffActivePhase = entryW > 0.5 ? 'ENTRY' : exitW > 0.5 ? 'EXIT' : 'MID';
    const lockPower = powerCoeff * diff.friction_faces * cot(diff.power_ramp_deg);
    const lockCoast = coastCoeff * diff.friction_faces * cot(diff.coast_ramp_deg);
    let lockTorque = diff.preload;
    for (let it = 0; it < SOLVER_ITERATIONS; it++) {
      for (let i = 0; i < 4; i++) {
        const max = W[i].brakeTorqueNm * h;
        const prev = accB[i];
        accB[i] = THREE.MathUtils.clamp(prev - wW[i] * Iw[i], -max, max);
        wW[i] += (accB[i] - prev) / Iw[i];
      }
      if (clutchCap > 0 && ratio !== 0) {
        const c = wE - half * (wW[dl] + wW[dr]);
        const max = clutchCap * h;
        const prev = accC;
        accC = THREE.MathUtils.clamp(prev - (c + biasC + gammaC * prev) * mC, -max, max);
        const d = accC - prev;
        wE += d / Ie;
        wW[dl] -= (half * d) / Iw[dl];
        wW[dr] -= (half * d) / Iw[dr];
      }
      // Torque into the diff (Nm): + when the engine drives the wheels forward
      const tIn = (-accC / h) * ratio;
      lockTorque = diff.preload + Math.abs(tIn) * (tIn >= 0 ? lockPower : lockCoast);
      {
        const c = wW[dl] - wW[dr];
        const max = lockTorque * h;
        const prev = accD;
        accD = THREE.MathUtils.clamp(prev - (c + biasD + gammaD * prev) * mD, -max, max);
        const d = accD - prev;
        wW[dl] += d / Iw[dl];
        wW[dr] -= d / Iw[dr];
      }
    }
    this.lsdLockTorque = lockTorque;
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

    // ---- energy store
    let pMech = tK * this.engineOmega;
    if (pMech > 0) {
      // Never overrun the per-lap allowance or the store inside a sub-step
      const room = Math.min(ers.deployPerLapJ + this.extraDeployJ - this.lapDeployJ, this.ersEnergyJ);
      const want = (pMech / ers.deployEfficiency) * h;
      if (want > room) {
        const scale = Math.max(0, room) / want;
        pMech *= scale;
        this.mgukTorque *= scale;
      }
      const e = (pMech / ers.deployEfficiency) * h;
      this.ersEnergyJ = Math.max(0, this.ersEnergyJ - e);
      this.lapDeployJ += e;
    } else if (pMech < 0) {
      const e = -pMech * ers.harvestEfficiency * h;
      this.ersEnergyJ = Math.min(ers.ERS_MAX_CHARGE, this.ersEnergyJ + e);
      // Counted on the store's side of the MGU-K, as deploy is, so both per-lap limits measure the same thing
      this.lapHarvestJ += e;
    }
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
    const wake = this.aeroWake;

    const air = _air.copy(this.velocity).sub(this.windWorld);
    const vF = air.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    // Air slip angle in the body frame, as the map-aero path reads it
    const yawDeg = Math.abs(vF) > 1 ? Math.abs(Math.atan2(air.dot(_ex), Math.abs(vF))) * RAD2DEG : 0;
    this.aeroYawDeg = yawDeg;
    let down = 0;
    let front = 0;
    let drag = aero.drag * wake.dragMultiplier;

    for (const wing of this.wings) {
      const s = wing.spec;
      const h = s.heightRef === 'front' ? this.rideFront : s.heightRef === 'rear' ? this.rideRear : hMean;
      const aoa = s.name === 'VENTURI_FLOOR' ? rakeDeg : s.angleDeg + pitchDelta;
      let cl = wing.aoaCl.evaluate(aoa) * wing.ghCl.evaluate(h);
      let cd = wing.aoaCd.evaluate(aoa) * wing.ghCd.evaluate(h);
      if (wing.yawCl) cl *= wing.yawCl.evaluate(yawDeg);
      if (wing.yawCd) cd *= wing.yawCd.evaluate(yawDeg);
      if (s.drs && !(this.drsFlaps === 'rear' && s.name === 'FRONT_WING')) {
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
      drag += cd * s.area * wake.dragMultiplier;
      down += fd;
      front += fd * ((s.positionZ + b) / L);
      _f.copy(_ey).multiplyScalar(-fd);
      _p.set(0, this.floorOffsetY, s.positionZ).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }
    // Bodywork lift at the axles
    for (const [cl, z] of [
      [aero.front_lift, a],
      [aero.rear_lift, -b],
    ] as const) {
      const fd = q * cl;
      down += fd;
      if (z > 0) front += fd;
      _f.copy(_ey).multiplyScalar(-fd);
      _p.set(0, this.floorOffsetY, z).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }

    const speed = air.length();
    const dragN = 0.5 * this.airDensity * speed * speed * drag;
    if (speed > 1e-3) this.addDragAtCentre(air, dragN / speed);

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
    const wake = this.aeroWake;

    const air = _air.copy(this.velocity).sub(this.windWorld);
    const vF = air.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    const rollDeg = Math.asin(THREE.MathUtils.clamp(_ex.y, -1, 1)) * RAD2DEG;
    // Signed here (the map's yaw tables span ±, and its balance shift may be odd in yaw); the wing path above reads
    // the magnitude, its per-wing yaw tables being one-sided
    const yawDeg = Math.abs(vF) > 1 ? Math.atan2(air.dot(_ex), Math.abs(vF)) * RAD2DEG : 0;
    this.aeroYawDeg = Math.abs(yawDeg);
    const ml = this.mapLuts!;
    const clMult = rhTable(map, map.cl, this.rideFront, this.rideRear) * ml.rollCl.evaluate(rollDeg) * ml.yawCl.evaluate(yawDeg);
    const cdMult = rhTable(map, map.cd, this.rideFront, this.rideRear) * ml.rollCd.evaluate(rollDeg) * ml.yawCd.evaluate(yawDeg);
    const balance = THREE.MathUtils.clamp(
      rhTable(map, map.balance, this.rideFront, this.rideRear) + ml.rollBalance.evaluate(rollDeg) + ml.yawBalance.evaluate(yawDeg),
      0,
      1
    );
    const act = map.activeAero;
    const open = this.drsBlend;
    // Rear flap alone: no front downforce change, and the rear's share (by downforce change) of the drag reduction
    const rearOnly = this.drsFlaps === 'rear';
    const dClAFront = rearOnly ? 0 : act.dClAFront;
    const dFlaps = Math.abs(act.dClAFront) + Math.abs(act.dClARear);
    const dCdA = rearOnly && dFlaps > 0 ? (act.dCdA * Math.abs(act.dClARear)) / dFlaps : act.dCdA;
    const clA = map.clA * clMult;
    let front = q * (clA * balance + dClAFront * open);
    let rear = q * (clA * (1 - balance) + act.dClARear * open);
    let cdA = map.cdA * cdMult + dCdA * open;
    // The wings' angle-of-attack offsets (body pitch included), split to the axles by their position
    for (const wing of this.wings) {
      const s = wing.spec;
      const aoa = s.angleDeg + pitchDelta;
      const fd = q * wing.aoaCl.evaluate(aoa) * s.area;
      const share = THREE.MathUtils.clamp((s.positionZ + b) / L, 0, 1);
      front += fd * share;
      rear += fd * (1 - share);
      cdA += wing.aoaCd.evaluate(aoa) * s.area;
    }
    front *= wake.frontDownforceMultiplier;
    rear *= wake.rearDownforceMultiplier;
    const speed = air.length();
    const drag = 0.5 * this.airDensity * speed * speed * cdA * wake.dragMultiplier;
    const lag = (tau: number) => (tau > 0 ? Math.min(1, h / tau) : 1);
    this.mapAeroFrontN += (front - this.mapAeroFrontN) * lag(map.frontDelayS);
    this.mapAeroRearN += (rear - this.mapAeroRearN) * lag(map.rearDelayS);
    this.mapAeroDragN += (drag - this.mapAeroDragN) * lag(map.dragDelayS);

    for (const [fd, z] of [
      [this.mapAeroFrontN, a],
      [this.mapAeroRearN, -b],
    ] as const) {
      _f.copy(_ey).multiplyScalar(-fd);
      _p.set(0, this.floorOffsetY, z).applyQuaternion(this.quaternion).add(this.position);
      this.addForceAt(_f, _p);
    }
    if (speed > 1e-3) this.addDragAtCentre(air, this.mapAeroDragN / speed);
    this.aeroDownN = this.mapAeroFrontN + this.mapAeroRearN;
    this.aeroFrontN = this.mapAeroFrontN;
    this.aeroDragN = this.mapAeroDragN;
  }

  /** Skid-block contact at the front and rear of the plank (floor reference plane) */
  private applyPlankContact(): void {
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

      // One thermal model: three bands, each a tread-surface node over a carcass (core) node, each a third of the
      // tyre (a third of the heat capacity and conductances, so with an even load the bands are the 2-node tyre).
      // 3-band I/M/O thermal distribution from camber & lateral force shift, in ac-tyre's convention: camber leaning
      // toward the car (negative camber) loads the inner shoulder, the lateral force rolls the patch onto the shoulder
      // away from the force (+ bias = toward the outer band). Inward is −left on a left wheel
      const inward = w.isLeft ? -1 : 1;
      const camberIn = inward * w.camberLeftRad;
      const fyIn = (inward * w.fy) / Math.max(500, w.fz);
      const bias = THREE.MathUtils.clamp(-camberIn * 3.8 + fyIn * 0.22, -0.75, 0.75);
      const sI = Math.max(0.08, (1 - bias) * 0.33);
      const sM = 0.34;
      const sO = Math.max(0.08, (1 + bias) * 0.33);
      const sSum = sI + sM + sO;
      const shares = w.bandLoadShares;
      shares[0] = sI / sSum;
      shares[1] = sM / sSum;
      shares[2] = sO / sSum;
      // The compound's heat capacities and conductances are the front tyre's: this axle's scale with its size
      const size = this.tyres[w.isFront ? 0 : 1].thermalSize;
      const surfaceCap = th.surfaceHeatCapacity * size;
      const coreCap = th.coreHeatCapacity * size;
      for (let b = 0; b < 3; b++) {
        const share = shares[b] * 3;
        const bToCore = th.surfaceToCore * size * (w.bandTempsC[b] - w.bandCoreTempsC[b]);
        const bSurfCool = (th.surfaceCooling[0] + th.surfaceCooling[1] * v) * size * (w.bandTempsC[b] - this.ambientC);
        const bRoadCool = w.fz > 0 ? roadG * size * (shares[b] * 3) * (w.bandTempsC[b] - this.trackTempC) : 0;
        const bCoreCool = (th.coreCooling[0] + th.coreCooling[1] * v + extWetCool) * size * (w.bandCoreTempsC[b] - this.ambientC);
        w.bandTempsC[b] += ((th.slipHeatShare * slipPower * share - bToCore - bSurfCool - bRoadCool) / surfaceCap) * dt;
        w.bandCoreTempsC[b] += ((hyst * share + bToCore - bCoreCool) / coreCap) * dt;
      }
      // Cross-band conduction: heat crosses between neighbouring bands through the tread and through the carcass (W/K),
      // each band a third of its layer's heat capacity. Slow next to the bands' own heating and cooling, so camber and
      // pressure keep their inner / outer temperature difference
      const kSurf = ((3 * BAND_TREAD_CONDUCTANCE) / surfaceCap) * dt;
      const kCore = ((3 * BAND_CARCASS_CONDUCTANCE) / coreCap) * dt;
      const d01 = kSurf * (w.bandTempsC[0] - w.bandTempsC[1]);
      const d12 = kSurf * (w.bandTempsC[1] - w.bandTempsC[2]);
      w.bandTempsC[0] -= d01;
      w.bandTempsC[1] += d01 - d12;
      w.bandTempsC[2] += d12;
      const c01 = kCore * (w.bandCoreTempsC[0] - w.bandCoreTempsC[1]);
      const c12 = kCore * (w.bandCoreTempsC[1] - w.bandCoreTempsC[2]);
      w.bandCoreTempsC[0] -= c01;
      w.bandCoreTempsC[1] += c01 - c12;
      w.bandCoreTempsC[2] += c12;
      for (let b = 0; b < 3; b++) w.bandCarcassTempsC[b] = 0.55 * w.bandTempsC[b] + 0.45 * w.bandCoreTempsC[b];
      // The tyre's surface temperature is the band surfaces weighted by contact pressure (the rubber on the road: flash
      // temperature, graining); its carcass temperature the bands' mean carcass (the inner liner the inflation gas
      // sees, and the rubber behind the carcass's vertical and cornering stiffness)
      w.surfaceTempC = shares[0] * w.bandTempsC[0] + shares[1] * w.bandTempsC[1] + shares[2] * w.bandTempsC[2];
      w.coreTempC = (w.bandCoreTempsC[0] + w.bandCoreTempsC[1] + w.bandCoreTempsC[2]) / 3;

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
        const locWear = wearDelta * (1 + 11 * lockFrac);
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
        // road's grip × rolling speed × the degrees outside the grip curve's peak. Graining wears off as the tyre rolls
        const tread = th.tread;
        if (tread && v > 2 && w.fz > 0) {
          const work = w.ground.grip * v * this.realism.tyreWearScale * dt;
          const slip = Math.min(2, w.combinedSlip);
          const [peakFrom, peakTo] = rt.peakWindowC;
          if (core < peakFrom) w.grainLevel += Math.pow(slip, tread.grainGamma) * work * tread.grainGain * (peakFrom - core) * TREAD_CONDITION_RATE;
          w.grainLevel = THREE.MathUtils.clamp(w.grainLevel - work * tread.grainGain * GRAIN_WEAR_OFF_RATE, 0, 1);
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

      w.dirtyLevel = advanceDirtyLevel(w.dirtyLevel, w.ground.surface, slipPower, v, dt, this.trackEvolution.marbleLevel);

      const p = td.pressureData;
      const rimWetDeltaC = rimWetEnvironmentCoolingWK(this.wetness, v) * 0.45 * Math.max(0, w.coreTempC - this.ambientC) * 0.02;
      const effectiveGasTempC = Math.max(this.ambientC - 5, w.coreTempC - rimWetDeltaC);
      w.pressurePsi = tyreGaugePressureAtTemperature(w.coldPressurePsi, p.coldRefC, effectiveGasTempC);

      // 2-node physical brake disc thermal step
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
        w.isFront ? this.brakeDuctScale.front : this.brakeDuctScale.rear,
        Math.min(1, this.wetness + 0.5 * sprayBoost)
      );
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
      wallContact: false,
      wallImpactMs: 0,
      LSD_LOCKING_TORQUE: 0,
      brakeBias: this.brakeBias,
      ffbTorqueNorm: 0,
      compound: this.compound,
    };
  }
}
