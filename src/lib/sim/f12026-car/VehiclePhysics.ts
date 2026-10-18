/**
 * f12026-car vehicle dynamics (`VehiclePhysics`).
 *
 * A data-driven 6-DOF rigid-body car on the Three.js track colliders (see `F12026CarConfig.ts` for the
 * structures and values).
 *
 * Model (fixed 500 Hz outer step, 4 × 2 kHz sub-steps):
 * - Body:        6-DOF sprung body (quaternion attitude, world-frame angular velocity, body-frame inertia).
 *                Hubs ride with the body horizontally, so horizontal translation uses the total mass.
 * - Contact:     each corner probes the ground straight down through a `GroundQuery`
 *                (`TrackColliderQuery` on `Track_Collider_Road` + the `userData.surface` meshes), giving
 *                height, normal, `surface` and `grip`.
 * - Suspension:  pull-rod double wishbones: main spring in series with a helper (`helper_rate` /
 *                `helper_range`), bump rubbers after `BumpStopSettingsUnits.range` (`BUMPSTOPUP_TRAVEL_*`),
 *                droop limiter, ARBs, heave spring + packers (double-wishbone configurations),
 *                4-way `DamperControllerData` (base corner + heave / roll / pitch mode dampers).
 * - Unsprung:    4 hub masses on the tyre's radial spring (`pressureSpringCurve` × `thermalVerticalK`).
 * - Tyres:       load-sensitive normalised-slip model on the `TyresModelData` fields (`Dy0`, `Dx0`,
 *                `lsExpY`, `lsExpX`, `Fz0`, `friction_limit_angle`, `slip_ratio_limit`). Slip ratio
 *                (`WHEEL_SR_*`) and slip angle come from relaxation-length carcass states. Camber thrust
 *                (`camberGain`, `contact_camber_c1/c2`) enters as an equivalent slip-angle shift, camber
 *                grip from `dcamber0/1` (lateral) and `dcamber0_x/1_x` (longitudinal). Fx / Fy come from
 *                friction-ellipse combined slip (`combinedFactor`, optional `new_combined` SA/SR cross terms,
 *                optional `use_slip_falloff` past-peak decay). `circleFraction` is a telemetry output only.
 *                Grip × `userData.grip`. 2-node (surface / core) thermal model, ideal-gas pressure, compound
 *                performance curve.
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
import { Lut } from '../lut';
import {
  advanceDirtyLevel,
  evaluateIso8608RoadRoughness,
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
  DEFAULT_REAL_ROAD_QUERY,
  type RealRoadSectorQuery,
} from '../real-road';
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
  type SuspensionSettingUnits,
  suspensionSupportsHeave,
  type TyresCompoundData,
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

const G = 9.81;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const RPM2RADS = Math.PI / 30;
const RADS2RPM = 30 / Math.PI;
const SOLVER_ITERATIONS = 8;
/** Auto box: hold a new gear this long after an upshift before an off-brake downshift (s) */
const AUTO_DOWNSHIFT_HOLD_S = 1.0;
/** Auto box: brake pedal that counts as braking into a corner, and the least time between its downshifts (s) */
const AUTO_BRAKE_DOWNSHIFT_PEDAL = 0.3;
const AUTO_BRAKE_DOWNSHIFT_GAP_S = 0.25;
/** Probe start above the suspension hardpoint (m) */
const GROUND_PROBE_UP_M = 0.6;
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
/** Steering-column torque that maps to full FFB output (front-axle aligning moment incl. caster trail, Nm) */
const FFB_REFERENCE_NM = 600;
/** Torque share missing at full turbo lag (boost far below its target) */
const TURBO_LAG_TORQUE_LOSS = 0.1;
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

export const WHEEL_NAMES = ['LF', 'RF', 'LR', 'RR'] as const;
export type WheelName = (typeof WHEEL_NAMES)[number];

export interface VehicleInputs {
  /** Pedals 0..1 */
  throttle: number;
  brake: number;
  /** Per-wheel brake pressure share 0..1 (LF, RF, LR, RR) after a per-wheel ABS; omitted = 1 */
  brakeWheelScale?: readonly [number, number, number, number];
  /** Steering −1..1, + = right */
  steer: number;
  /** Clutch pedal 0..1 (1 = fully open); omitted = auto clutch */
  clutch?: number;
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
  | { type: 'WALL_IMPACT'; speedMs: number };

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
  /** Tyre radial stiffness (N/m) */
  verticalRate: number;
  fz: number;
  fx: number;
  fy: number;
  /** Self-aligning moment about the contact normal (Nm) */
  mz: number;
  /** Overturning moment Mx (Nm) from lateral contact patch shift */
  mx: number;
  /** Spin (rad/s) and accumulated visual rotation (rad) */
  omega: number;
  rotationRad: number;
  /** Road-wheel steer (rad, + = left) */
  steerRad: number;
  /** Kinematic bump-steer toe offset (rad) */
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
  surfaceTempC: number;
  coreTempC: number;
  /** Inner, Middle, Outer surface band temperatures (°C) */
  bandTempsC: [number, number, number];
  /** Inner, Middle, Outer carcass temperatures (°C) */
  bandCarcassTempsC: [number, number, number];
  /** Inner, Middle, Outer core temperatures (°C) */
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
  coldPressurePsi: number;
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
  unsprungMass: number;
  wheelInertia: number;
}

interface WingRuntime {
  spec: WingData;
  aoaCl: Lut;
  aoaCd: Lut;
  ghCl: Lut;
  ghCd: Lut;
}

export interface TyreRuntime {
  data: TyresCompoundData;
  thermal: Lut;
  pressureSpring: Lut;
  tanPeakAngle: number;
  peakSlipRatio: number;
  /** Magic-formula shape: y = sin(C·atan(B·s)), peak 1 at s = 1 */
  B: number;
  C: number;
  /** `combinedFactor` clamped to 0..2 */
  combinedFactor: number;
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
  return {
    data,
    thermal: new Lut(data.thermalData.thermalPerformanceCurve),
    pressureSpring: new Lut(data.pressureData.pressureSpringCurve),
    tanPeakAngle: Math.tan(fla * DEG2RAD),
    peakSlipRatio: model.slip_ratio_limit,
    B,
    C,
    combinedFactor: THREE.MathUtils.clamp(Number.isFinite(model.combinedFactor) ? model.combinedFactor : 1, 0, 2),
    useFalloff: model.use_slip_falloff,
    falloffLevel: model.falloff_level,
    falloffSlope: Math.max(0, model.falloff_slope),
    camberThrustLimit: cam.contact_camber_c2 > 0 ? Math.sqrt(cam.contact_camber_c1 / (3 * cam.contact_camber_c2)) : Infinity,
    fz0,
    dyCurve: model.dyCurve ? new Lut(model.dyCurve) : null,
    dxCurve: model.dxCurve ? new Lut(model.dxCurve) : null,
    brakeDxMod: model.brakeDxMod ?? 0,
  };
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
 * Stereo's combined slip (this model's interpretation of `combinedFactor`, `new_combined` and the SA/SR
 * cross terms): normalised slips (sx, sy) → per-axis force fractions (fx, fy) of μ·Fz, signs following
 * the slips. With k = 1 and no cross terms this is the plain friction circle.
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
  const k = t.combinedFactor;
  out.fx = sxm * slipCurveOverS(t, Math.hypot(sxm, k * sym));
  out.fy = sym * slipCurveOverS(t, Math.hypot(sym, k * sxm));
  out.sx = sxm;
  out.sy = sym;
}

const _comb = { fx: 0, fy: 0, sx: 0, sy: 0 };

// Scratch (single-threaded, never escapes a call)
const _m = new THREE.Matrix4();
const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _r = new THREE.Vector3();
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
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

export class VehiclePhysics {
  public static readonly FIXED_DT = 0.002;
  public static readonly SUBSTEPS = 4;

  public readonly config: CarPhysicsConfig;
  public readonly totalMassKg: number;
  public readonly sprungMassKg: number;
  /** CG → front / rear axle (m) */
  public readonly cgToFrontM: number;
  public readonly cgToRearM: number;
  public readonly wheelbaseM: number;
  public readonly maxSteerRad: number;
  /** Steering compliance (rad of road-wheel angle per N of lateral force) */
  private readonly steerComplianceRadPerN: number;
  private readonly ffbMechanicalTrailM: number;
  /** Sum / count of the per-step FFB torque since the last takeFfbAverage() */
  private ffbSum = 0;
  private ffbSamples = 0;
  /** 500 Hz outer-step FFB samples accumulated during step() */
  private ffbSubframeSamples: number[] = [];

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
  /** Live turbo boost pressure (bar absolute, 1.0 = atmospheric) with spool lag, and the boost asked for */
  public turboBoostBar = 1.0;
  private turboTargetBar = 1.0;
  /** Turbocharged engine: the boost's spool lag costs a little torque (set by the adapter from its profile) */
  public turbocharged = false;
  /** Disc / pad material of the brakes (`BrakesData.discMaterial`) */
  private readonly brakeCompound: BrakeCompoundKind;
  /** Dynamic brake bias after pressure-sensitive brake migration */
  public dynamicBrakeBias = 0.56;

  // ---- aero & track environment
  public airDensity: number;
  public ambientC: number;
  public trackTempC: number;
  private readonly baseTrackTempC: number;
  public drsOpen = false;
  public drsBlend = 0;
  /** Lap progress from `locateProgress` (NaN without it) */
  public trackProgress = Number.NaN;
  public aeroWake: AeroWakeState = { ...DEFAULT_AERO_WAKE };
  public realRoad: RealRoadSectorQuery = { ...DEFAULT_REAL_ROAD_QUERY };

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

  private timeAccumulator = 0;
  private prevInputs = { shiftUp: false, shiftDown: false, drs: false };
  private drsRequested = false;
  private shiftTimer = 0;
  /** Time since the last upshift (s): the auto box holds the gear a moment after one so wheelspin can't hunt it */
  private sinceUpshiftS = Infinity;
  private sinceDownshiftS = Infinity;
  private limiterTimer = 0;
  private clutchEngagement = 1;
  private lsdLockTorque = 0;
  private mgukTorque = 0;
  private aeroFrontN = 0;
  private aeroDownN = 0;
  private aeroDragN = 0;
  private rideFront = 0;
  private rideRear = 0;
  /** Lagged map-aero forces (N): front and rear downforce, drag */
  private mapAeroFrontN = 0;
  private mapAeroRearN = 0;
  private mapAeroDragN = 0;
  private readonly prevVelocity = new THREE.Vector3();
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
    this.steerComplianceRadPerN = ((ch.steerComplianceDegPerKN ?? 0) * DEG2RAD) / 1000;
    this.ffbMechanicalTrailM = ch.ffbMechanicalTrailM ?? DEFAULT_FFB_MECHANICAL_TRAIL_M;
    this.brakeCompound = cfg.brakes.discMaterial ?? 'carbon-ceramic';
    // Body axes: X = left (pitch), Y = up (yaw), Z = forward (roll)
    this.inertiaBody = new THREE.Vector3(ch.inertia.pitch, ch.inertia.yaw, ch.inertia.roll);
    this.floorOffsetY = cfg.aero.floorOffsetY;
    this.staticRakeDeg = Math.asin((cfg.aero.rear_target_height - cfg.aero.front_target_height) / ch.wheelbase) * RAD2DEG;

    const mkAxle = (spec: AxleSuspensionData, dampers: DamperControllerData, name: string, mass: number, inertia: number): AxleRuntime => {
      const heaveActive = suspensionSupportsHeave(spec.type);
      if (!heaveActive) console.warn(`IGNORING HEAVE SPRING BECAUSE SUSPENSION ${name} IS NOT DOUBLE WISHBONE`);
      return { spec, dampers, heaveActive, unsprungMass: mass, wheelInertia: inertia };
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
    // F1 pull-rod cars get the VF26 mod's wishbones; a push-rod car (the GT3) road-car-derived uprights. The caster
    // trail the FFB reads is the chassis' own plus the kinematic change with travel
    const kinOptions = {
      geometry: susp.front.actuation === 'pull_rod' ? ('f1' as const) : ('gt3' as const),
      staticCasterTrailM: this.ffbMechanicalTrailM,
    };
    this.frontSuspHardpoints = buildDoubleWishboneHardpoints(undefined, true, susp.front.actuation, kinOptions);
    this.rearSuspHardpoints = buildDoubleWishboneHardpoints(undefined, false, susp.rear.actuation, kinOptions);

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
        verticalRate: 0,
        fz: 0,
        fx: 0,
        fy: 0,
        mz: 0,
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

  public setCompound(compound: PhysicsTyreCompound): void {
    this.compound = compound;
    this.tyres = this.tyreRuntimes(compound);
    this.setTyreBlanketState();
  }

  public setAeroWakeState(wake: AeroWakeState | null): void {
    this.aeroWake = wake ?? { ...DEFAULT_AERO_WAKE };
  }

  public setRealRoadSample(sample: RealRoadSectorQuery | null): void {
    this.realRoad = sample ?? { ...DEFAULT_REAL_ROAD_QUERY };
    // The sample's temperature is the RealRoad base (the same 41 °C default) plus the local frictional heating
    const t = this.realRoad.trackTempC;
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

  public get rpm(): number {
    return this.engineOmega * RADS2RPM;
  }

  public get speedMs(): number {
    return this.velocity.length();
  }

  /**
   * Place the car at rest on the ground under (x, z), heading along `yawRad` (atan2(forward.x, forward.z)),
   * then let the suspension settle. `speedMs` > 0 gives a rolling start.
   */
  public reset(x: number, z: number, yawRad: number, speedMs = 0): void {
    const ch = this.config.chassis;
    const aero = this.config.aero;
    const probeY = 1e4;
    const hit = createGroundHit();
    const groundY = this.ground.query(x, z, probeY, hit) ? hit.height : 0;
    const pitch = Math.asin(this.staticPitchSin());
    this.quaternion.setFromEuler(new THREE.Euler(pitch, yawRad, 0, 'YXZ'));
    this.position.set(x, groundY + ch.cgHeight, z);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.prevVelocity.set(0, 0, 0);
    this.timeAccumulator = 0;
    this.gear = 1;
    this.shiftTimer = 0;
    this.sinceUpshiftS = Infinity;
    this.sinceDownshiftS = Infinity;
    this.limiterTimer = 0;
    this.engineOmega = this.config.engine.idleRpm * RPM2RADS;
    this.turboBoostBar = 1.0;
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
    this.setTyreBlanketState();

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
      for (const w of this.wheels) w.omega = speedMs / Math.max(0.2, w.rollingRadius || 0.35);
      if (rolling) this.engineOmega = 0.5 * (this.wheels[2].omega + this.wheels[3].omega) * this.totalRatio();
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
      for (const w of this.wheels) {
        w.slipRatio = 0;
        w.tanSlipAngle = 0;
      }
    }
    this.prevVelocity.copy(this.velocity);
    this.ffbSubframeSamples.length = 0;
    this.updateOutputs(0);
  }

  /** Advance by a render frame (any dt); runs fixed 500 Hz steps */
  public step(dtSeconds: number, inputs: VehicleInputs): void {
    const inp = this.sanitizeInputs(inputs);
    this.handleEdges(inp);
    this.timeAccumulator = Math.min(this.timeAccumulator + dtSeconds, 0.1);
    while (this.timeAccumulator >= VehiclePhysics.FIXED_DT) {
      this.timeAccumulator -= VehiclePhysics.FIXED_DT;
      this.outerStep(inp);
    }
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
      const targetCoreC = 0.5 * (t.thermalData.optimalTempC[0] + t.thermalData.optimalTempC[1]);
      w.coldPressurePsi = Math.round(((p.optimalPsi * (p.coldRefC + 273.15)) / (targetCoreC + 273.15)) * 10) / 10;
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

  private staticCornerLoad(front: boolean): number {
    const ch = this.config.chassis;
    return 0.5 * ch.totalMassKg * G * (front ? ch.frontWeightFraction : 1 - ch.frontWeightFraction);
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

  /** Static hub distances and spring preloads, on flat ground at the target ride heights */
  private computeStaticGeometry(): void {
    const ch = this.config.chassis;
    const sinT = this.staticPitchSin();
    const cosT = Math.sqrt(1 - sinT * sinT);
    const cgY = ch.cgHeight;
    for (const w of this.wheels) {
      const axle = this.axles[w.isFront ? 0 : 1];
      const tyre = this.tyres[w.isFront ? 0 : 1];
      const R0 = (w.isFront ? tyre.data.front : tyre.data.rear).radius;
      const fz = this.staticCornerLoad(w.isFront);
      const hpY = cgY + w.hardpoint.y * cosT - w.hardpoint.z * sinT;
      const hubY = R0 - fz / this.tyreVerticalRate(w);
      w.staticHubDist = (hpY - hubY) / cosT;
      w.springPreload = springDeflectionFor(fz - axle.unsprungMass * G, axle.spec.springs);
    }
  }

  private tyreVerticalRate(w: WheelState): number {
    const t = this.tyres[w.isFront ? 0 : 1];
    const geo = w.isFront ? t.data.front : t.data.rear;
    const th = t.data.thermalData;
    const thermal = Math.max(0.7, 1 + th.thermalVerticalK * (w.coreTempC - th.thermalVerticalRefC));
    return t.pressureSpring.evaluate(w.pressurePsi) * geo.verticalRateScale * thermal;
  }

  private totalRatio(): number {
    const gb = this.config.gearbox;
    if (this.gear > 0) return gb.ratios[this.gear - 1] * gb.finalDrive;
    if (this.gear < 0) return -gb.reverse * gb.finalDrive;
    return 0;
  }

  /** Engine rpm the road speed implies in `gear` (rear rolling radius, no wheelspin); needs `updateBasis` */
  private roadRpm(gear: number, speedMs = Math.abs(this.velocity.dot(_ez))): number {
    const gb = this.config.gearbox;
    if (gear < 1) return 0;
    const r = Math.max(0.2, 0.5 * (this.wheels[2].rollingRadius + this.wheels[3].rollingRadius) || 0.35);
    return (speedMs / r) * gb.ratios[gear - 1] * gb.finalDrive * RADS2RPM;
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
      steer: c(fin(i.steer), -1, 1),
      brakeWheelScale: i.brakeWheelScale
        ? [c(fin(i.brakeWheelScale[0]), 0, 1), c(fin(i.brakeWheelScale[1]), 0, 1), c(fin(i.brakeWheelScale[2]), 0, 1), c(fin(i.brakeWheelScale[3]), 0, 1)]
        : undefined,
      clutch: i.clutch === undefined ? undefined : c(fin(i.clutch), 0, 1),
      shiftUp: !!i.shiftUp,
      shiftDown: !!i.shiftDown,
      drs: !!i.drs,
    };
  }

  private handleEdges(inp: VehicleInputs): void {
    if (inp.shiftUp && !this.prevInputs.shiftUp) this.requestShift(this.gear + 1);
    if (inp.shiftDown && !this.prevInputs.shiftDown) this.requestShift(this.gear - 1);
    if (inp.drs && !this.prevInputs.drs) this.drsRequested = !this.drsOpen;
    this.prevInputs.shiftUp = !!inp.shiftUp;
    this.prevInputs.shiftDown = !!inp.shiftDown;
    this.prevInputs.drs = !!inp.drs;
  }

  private requestShift(target: number): boolean {
    const gb = this.config.gearbox;
    const g = THREE.MathUtils.clamp(target, -1, gb.ratios.length);
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
    this.gear = g;
    this.shiftTimer = gb.shiftTimeS;
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
    const gb = this.config.gearbox;
    if (this.gear === 0 && throttle > 0.1) {
      this.requestShift(1);
      return;
    }
    if (this.gear < 1) return;
    // Upshift on engine rpm once the clutch is closed; downshift on road speed (locked wheels must not
    // drag the box down through the gears)
    this.updateBasis();
    const road = this.roadRpm(this.gear);
    // Wheelspin may lift the engine at most 30 % over road speed for shift purposes
    const engineRpm = this.clutchEngagement >= 0.99 ? Math.min(this.rpm, road * 1.3) : road;
    const brakeDown = gb.gears.brake_downshift_rpm;
    if (engineRpm >= gb.gears.upshift_rpm && this.gear < gb.ratios.length) this.requestShift(this.gear + 1);
    // Braking into a corner: down through the box one click at a time while the lower gear stays under the point
    else if (
      brakeDown !== undefined &&
      this.gear > 1 &&
      brake > AUTO_BRAKE_DOWNSHIFT_PEDAL &&
      this.sinceDownshiftS > AUTO_BRAKE_DOWNSHIFT_GAP_S &&
      this.roadRpm(this.gear - 1) < brakeDown
    ) {
      this.requestShift(this.gear - 1);
    }
    // No downshift straight after an upshift unless braking: wheelspin lifts the engine into an upshift and
    // the new gear's road rpm can sit under the downshift point, which would bounce the box between the two
    else if (this.gear > 1 && road < gb.gears.downshift_rpm && (brake > 0.05 || this.sinceUpshiftS > AUTO_DOWNSHIFT_HOLD_S)) {
      if (this.roadRpm(this.gear - 1) < gb.gears.upshift_rpm - 300) this.requestShift(this.gear - 1);
    }
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
        if (d > 0 && d < 0.05) {
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
      armed = zone !== undefined && this.drsArmedZone === zone.id;
    }
    this.telemetry.drsZone = inZone;
    this.telemetry.drsAvailable = inZone && armed;
    // Closes on the brake or a lift; the driver can press again while still in the zone
    const lifted = inp.brake > 0.05 || inp.throttle < this.config.aero.drsCloseThrottle;
    const open = this.drsRequested && inZone && armed && !lifted;
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
    this.autoShiftFor(inp.throttle, inp.brake);
    this.prevVelocity.copy(this.velocity);
    const h = dt / VehiclePhysics.SUBSTEPS;
    for (let k = 0; k < VehiclePhysics.SUBSTEPS; k++) this.substep(h, inp);
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.sinceUpshiftS += dt;
    this.sinceDownshiftS += dt;
    this.limiterTimer = Math.max(0, this.limiterTimer - dt);
    const targetBoost = 1 + 2.5 * inp.throttle * THREE.MathUtils.clamp((this.rpm - 6000) / 4000, 0, 1);
    const tauTurbo = targetBoost > this.turboBoostBar ? 0.14 : 0.05;
    this.turboBoostBar += (targetBoost - this.turboBoostBar) * Math.min(1, dt / tauTurbo);
    this.turboTargetBar = targetBoost;
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
      w.grounded = this.ground.query(w.hardpointWorld.x, w.hardpointWorld.z, w.hardpointWorld.y + GROUND_PROBE_UP_M, w.ground);
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
      for (const w of [L, R]) {
        let f = springForce(w.springPreload + w.compression, s.springs);
        const intoRubber = w.compression - s.bumpStop.range;
        if (intoRubber > 0) f += s.bumpStop.rate * intoRubber + s.bumpStop.progression * intoRubber * intoRubber;
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
        const fh =
          s.heave.rate * Math.max(0, heave - s.heave.gap) +
          s.heave.packerRate * Math.max(0, heave - s.heave.packerGap) +
          damperForce(d.heave, hv, knee);
        L.suspensionForce += 0.5 * fh;
        R.suspensionForce += 0.5 * fh;
      }
      const fp = damperForce(d.pitch, ai === 0 ? vPitch : -vPitch, knee);
      L.suspensionForce += 0.5 * fp;
      R.suspensionForce += 0.5 * fp;
    }

    // ---- tyres: vertical, hubs, horizontal forces
    const tyreTorque = [0, 0, 0, 0];
    let ffbMz = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const axle = this.axles[w.isFront ? 0 : 1];
      const tyre = this.tyres[w.isFront ? 0 : 1];
      const geo = w.isFront ? tyre.data.front : tyre.data.rear;
      const model = tyre.data.modelData;
      const g = w.ground;
      const R0 = geo.radius;
      const dR = tyreCentrifugalGrowthM(w.omega);
      w.verticalRate = this.tyreVerticalRate(w);

      const kin = w.isFront
        ? (w.isLeft ? frontKin.left : frontKin.right)
        : (w.isLeft ? rearKin.left : rearKin.right);
      w.toeRad = kin.bumpSteerToeInRad;
      w.casterTrailM = kin.casterTrailM;
      w.scrubRadiusM = kin.scrubRadiusM;

      let fz = 0;
      let delta = 0;
      if (w.grounded) {
        delta = R0 - (w.hubY - g.height) * g.ny;
        if (delta > 0) fz = Math.max(0, w.verticalRate * delta - model.verticalDamping * w.hubVy * g.ny);
      }
      w.fz = fz;
      w.deflection = Math.max(0, delta);
      w.loadedRadius = R0 - w.deflection + dR * 0.25;
      w.rollingRadius = Math.max(0.2, R0 - w.deflection / 3);

      // Hub: tyre normal force up, suspension force down
      const hubAcc = (fz * g.ny - w.suspensionForce * _ey.y) / axle.unsprungMass - G;
      w.hubVy += hubAcc * h;
      w.hubY += w.hubVy * h;

      // Suspension load reaches the body vertically at the hardpoint
      _f.set(0, w.suspensionForce * _ey.y, 0);
      this.addForceAt(_f, w.hardpointWorld);

      // Wheel frame on the contact plane
      w.steerRad = w.isFront ? -inp.steer * this.maxSteerRad : 0;
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

      // Camber relative to the road, leaning toward +left (rad)
      const staticCamber = axle.spec.staticCamber + axle.spec.camberGainKinematic * w.compression;
      const leanBody = Math.asin(THREE.MathUtils.clamp(_ey.dot(_lw), -1, 1));
      w.camberLeftRad = (w.isLeft ? 1 : -1) * staticCamber * DEG2RAD + leanBody;

      // Relaxation-length carcass: slip ratio and tan(slip angle), implicit in |vx|
      const rim = w.omega * w.rollingRadius;
      const vsx = rim - vx;
      w.slipVelX = vsx;
      if (fz > 0) {
        w.slipRatio = (w.slipRatio + (h * vsx) / model.relaxationLengthX) / (1 + (h * absVx) / model.relaxationLengthX);
        w.tanSlipAngle = (w.tanSlipAngle + (h * vy) / model.relaxationLengthY) / (1 + (h * absVx) / model.relaxationLengthY);
        w.slipRatio = THREE.MathUtils.clamp(w.slipRatio, -5, 5);
        w.tanSlipAngle = THREE.MathUtils.clamp(w.tanSlipAngle, -5, 5);
      } else {
        w.slipRatio *= 0.9;
        w.tanSlipAngle *= 0.9;
      }
      w.slipAngleRad = Math.atan(w.tanSlipAngle);

      let fx = 0;
      let fy = 0;
      if (fz > 0) {
        const td = tyre.data;
        const cam = td.camberData;
        const loadRef = Math.max(0.05, fz / tyre.fz0);
        // Temperature grip per band (inner / middle / outer), weighted by each band's share of the contact pressure
        const sh = w.bandLoadShares;
        const thermal =
          sh[0] * tyre.thermal.evaluate(w.bandTempsC[0]) +
          sh[1] * tyre.thermal.evaluate(w.bandTempsC[1]) +
          sh[2] * tyre.thermal.evaluate(w.bandTempsC[2]);
        const dp = (w.pressurePsi - td.pressureData.optimalPsi) / td.pressureData.optimalPsi;
        const pressureGrip = Math.max(0.5, 1 - td.pressureData.pressureGripSensitivity * dp * dp);
        w.thermalGrip = thermal;
        // Wear, graining, blistering, dirt and flat-spots, as the VF26's tyre model (ac-tyre computeTyreForces)
        const degradation =
          wearGripMultiplier(w.wear) *
          (1 - 0.08 * w.grainLevel) *
          (1 - 0.12 * w.blisterLevel) *
          (1 - 0.18 * w.dirtyLevel) *
          (1 - 0.05 * w.flatSpotSeverity);
        const base = thermal * pressureGrip * degradation * g.grip * this.realRoad.gripMultiplier;

        // Camber grip: leaning into the force direction (force opposes the slip)
        const forceSign = w.tanSlipAngle > 0 ? -1 : 1;
        const gInto = w.camberLeftRad * forceSign;
        const camberGrip = THREE.MathUtils.clamp(1 + cam.dcamber0 * gInto + cam.dcamber1 * gInto * gInto, 0.7, 1.1);
        const gAbs = Math.abs(w.camberLeftRad);
        const camberGripX = THREE.MathUtils.clamp(1 + cam.dcamber0_x * gAbs + cam.dcamber1_x * gAbs * gAbs, 0.7, 1.1);
        // Peak μ at this load: the compound's load tables, else the power law about Fz0. AC's BRAKE_DX_MOD adds
        // longitudinal grip while the tyre is braking
        const dY = tyre.dyCurve ? tyre.dyCurve.evaluate(fz) : model.Dy0 * Math.pow(loadRef, model.lsExpY - 1);
        const dX = tyre.dxCurve ? tyre.dxCurve.evaluate(fz) : model.Dx0 * Math.pow(loadRef, model.lsExpX - 1);
        const brakeMod = w.slipRatio < 0 ? 1 + tyre.brakeDxMod : 1;
        const muY = dY * base * camberGrip;
        const muX = dX * brakeMod * base * camberGripX;
        w.muY = muY;
        w.muX = muX;

        // Camber thrust (toward the lean) as an equivalent slip-angle shift
        const gc = THREE.MathUtils.clamp(w.camberLeftRad, -tyre.camberThrustLimit, tyre.camberThrustLimit);
        const thrust = cam.camberGain * (cam.contact_camber_c1 * gc - cam.contact_camber_c2 * gc * gc * gc);
        const BC = tyre.B * tyre.C;
        const tanEff = w.tanSlipAngle - (thrust * tyre.tanPeakAngle) / Math.max(1e-3, muY * BC);

        // Stereo's combined slip
        combinedSlipForces(tyre, model, w.slipRatio / tyre.peakSlipRatio, tanEff / tyre.tanPeakAngle, _comb);
        fx = muX * fz * _comb.fx;
        fy = -muY * fz * _comb.fy;
        const s = Math.hypot(_comb.sx, _comb.sy);
        w.combinedSlip = s;
        // A relaxed combinedFactor may use more than the circle; low-speed damping must not add to that
        const useSlip = Math.hypot(_comb.fx, _comb.fy);

        // Low-speed contact damping (keeps a parked car from ringing on the carcass spring)
        const fade = Math.max(0, 1 - absVx / LOW_SPEED_FADE_MS);
        if (fade > 0) {
          fx += fade * LOW_SPEED_DAMPING * muX * fz * vsx;
          fy -= fade * LOW_SPEED_DAMPING * muY * fz * vy;
        }
        const use = Math.hypot(fx / (muX * fz), fy / (muY * fz));
        const limit = Math.max(1, useSlip);
        if (use > limit) {
          fx *= limit / use;
          fy *= limit / use;
        }
        // Telemetry only: share of the friction circle in use (> 1 when combinedFactor < 1 lets it exceed)
        w.circleFraction = Math.min(use, limit);

        // Self-aligning moment: pneumatic trail collapsing toward the limit
        w.mz = -fy * model.pneumaticTrail * Math.max(0, 1 - s);
        const yCpShift = THREE.MathUtils.clamp(
          -0.35 * geo.width * Math.sin(w.camberLeftRad) + (fy / Math.max(500, fz)) * 0.018,
          -0.45 * geo.width,
          0.45 * geo.width
        );
        w.mx = fz * yCpShift;
      } else {
        w.combinedSlip = 0;
        w.circleFraction = 0;
        w.mz = 0;
        w.mx = 0;
      }
      w.fx = fx;
      w.fy = fy;
      tyreTorque[i] = -fx * w.rollingRadius;
      // 3D Steering rack torque: pneumatic Mz + kinematic caster trail + scrub radius + overturning Mx + flat-spot + ISO road micro-roughness
      if (w.isFront) {
        const flatSpotVib = flatSpotVibrationNm(w.flatSpotSeverity, w.rotationRad, w.omega, fz);
        const speedGate = THREE.MathUtils.clamp(absVx / 5, 0, 1);
        const isoRough = evaluateIso8608RoadRoughness(
          w.hardpointWorld.x,
          w.hardpointWorld.z,
          g.surface === 'kerb' || g.surface === 'sausage' ? 'kerb' : 'asphalt'
        );
        const roadTexNm = isoRough * w.verticalRate * 0.006 * speedGate * (w.isLeft ? 1 : -1);
        ffbMz +=
          w.mz -
          fy * w.casterTrailM -
          fx * (w.isLeft ? w.scrubRadiusM : -w.scrubRadiusM) * 0.15 +
          0.08 * w.mx +
          flatSpotVib +
          roadTexNm;
      }

      // Tyre forces reach the body at the roll centre; the normal's horizontal part holds it on slopes
      _f.copy(_fw).multiplyScalar(fx).addScaledVector(_lw, fy);
      _f.x += fz * g.nx;
      _f.z += fz * g.nz;
      _w.copy(_p).addScaledVector(_n, axle.spec.rollCentreHeight);
      this.addForceAt(_f, _w);
      if (w.mz !== 0) this.torque.addScaledVector(_n, w.mz);
    }
    this.telemetry.ffbTorqueNorm = THREE.MathUtils.clamp(ffbMz / FFB_REFERENCE_NM, -1, 1);
    this.ffbSum += this.telemetry.ffbTorqueNorm;
    this.ffbSamples++;

    // ---- drivetrain, brakes and wheel spin
    this.solveDrivetrain(h, inp, tyreTorque);

    // ---- aero, then the plank if the floor reaches the road
    if (this.config.aero.rhMap) this.applyMapAero(h, this.config.aero.rhMap);
    else this.applyAero();
    this.applyPlankContact();

    // ---- gravity and integration
    this.force.y -= this.sprungMassKg * G;
    this.velocity.x += (this.force.x / this.totalMassKg) * h;
    this.velocity.z += (this.force.z / this.totalMassKg) * h;
    this.velocity.y += (this.force.y / this.sprungMassKg) * h;
    this.wallPrevCg.copy(this.position);
    this.position.addScaledVector(this.velocity, h);

    // ω̇ = I⁻¹(τ − ω × Iω), with I in body axes
    _w.copy(this.angularVelocity).applyQuaternion(_qd.copy(this.quaternion).invert());
    _tmp.copy(this.torque).applyQuaternion(_qd);
    const I = this.inertiaBody;
    const lx = I.x * _w.x;
    const ly = I.y * _w.y;
    const lz = I.z * _w.z;
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
   * A tyre meets an abrupt rise (a surface seam, the edge of a raised verge) along its contact arc: over a step
   * of height d it rises across √(2Rd − d²) of travel, so the contact height climbs at most travel·√(d / 2R)
   * per step instead of jumping (a one-step jump drives the whole step into the tyre spring and launches the
   * car). Drops and gentle grades pass straight through.
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
    const allowed = Math.max(travel * Math.sqrt(d / (2 * R0)), STEP_CLIMB_MIN_M);
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
      impact = Math.max(impact, this.wallImpulse(_r, _wallHit.nx, _wallHit.nz));
      p.x += _wallHit.nx * (depth + WALL_SKIN_M);
      p.z += _wallHit.nz * (depth + WALL_SKIN_M);
    }
    if (this.wallContactNow) {
      this.wallContactStep = true;
      this.wallImpactStep = Math.max(this.wallImpactStep, impact);
      if (!wasTouching && impact >= WALL_IMPACT_EVENT_MS) this.onEvent?.({ type: 'WALL_IMPACT', speedMs: impact });
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
  private solveDrivetrain(h: number, inp: VehicleInputs, tyreTorque: number[]): void {
    const cfg = this.config;
    const eng = cfg.engine;
    const gb = cfg.gearbox;
    const ers = cfg.ers;
    const mode = cfg.performanceModes[this.performanceMode];
    const W = this.wheels;
    const ratio = this.totalRatio();
    const rpm = this.rpm;
    const omegaE = Math.max(50, this.engineOmega);

    // ---- ICE
    if (rpm >= gb.gears.redline_rpm) this.limiterTimer = eng.limiterCutS;
    let plate = this.luts.throttle.evaluate(inp.throttle);
    plate = Math.max(plate, THREE.MathUtils.clamp((eng.idleRpm + 200 - rpm) / 800, 0, 0.15));
    if (this.limiterTimer > 0) plate = 0;
    let tIce = (plate * this.luts.power.evaluate(rpm) * 1000) / omegaE - (1 - plate) * this.luts.coast.evaluate(rpm) * mode.coastTorqueScale;
    if (this.shiftTimer > 0 && tIce > 0) tIce *= gb.shiftTorqueFraction;
    // Turbo lag: while the boost still trails the demand (≈0.14 s spool), up to TURBO_LAG_TORQUE_LOSS of the torque
    // is missing. Kept small: the torque curve is the steady-state, full-boost one
    if (this.turbocharged && tIce > 0) {
      const spoolDeficit = THREE.MathUtils.clamp((this.turboTargetBar - this.turboBoostBar) / 2.5, 0, 1);
      tIce *= 1 - TURBO_LAG_TORQUE_LOSS * spoolDeficit;
    }

    // ---- clutch engagement
    const axleOmega = 0.5 * (W[2].omega + W[3].omega);
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
      } else if (inp.throttle > 0.05 && soc > mode.socFloor && this.lapDeployJ < ers.deployPerLapJ) {
        pK =
          ers.ERS_MAX_DEPLOY *
          mode.deployFraction *
          this.luts.deployVsSpeed[this.performanceMode].evaluate(speedKmh) *
          this.luts.deployVsGear.evaluate(this.gear) *
          inp.throttle;
      }
      if (pK < 0 && (soc >= 1 || this.lapHarvestJ >= ers.harvestPerLapJ)) pK = 0;
    }
    // ---- brake bias (brake-by-wire + dynamic brake migration)
    const br = cfg.brakes;
    // Migration is a brake-by-wire map: conventional hydraulics (the GT3) keep the set bias at every pedal pressure
    const mig = br.migration ?? { amount: 0.015, rampStart: 0 };
    this.dynamicBrakeBias =
      br.brakeByWire !== false ? computeDynamicBrakeMigration(this.brakeBias, inp.brake, mig.amount, mig.rampStart) : this.brakeBias;
    const bias = this.dynamicBrakeBias;

    let tK = 0;
    if (pK > 0) tK = Math.min(pK / omegaE, this.luts.mgukDeploy.evaluate(rpm));
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
    if (this.limiterTimer > 0 && tK > 0) tK = 0;
    this.mgukTorque = tK;

    // ---- brakes (physical brake pad μ(T))
    const crankBrake = Math.max(0, -tK) + Math.max(0, -tIce);
    const rearDriveBrake = inp.brake > 0.05 && br.brakeByWire !== false ? (crankBrake * engage * Math.abs(ratio) * gb.efficiency) / 2 : 0;
    for (let i = 0; i < 4; i++) {
      const w = W[i];
      const demand = inp.brake * (inp.brakeWheelScale ? inp.brakeWheelScale[i] : 1) * br.maxTorqueNm * (w.isFront ? bias : 1 - bias);
      // Pad μ(T) of the disc (1 in its window, a mild loss cold or faded)
      const friction = (w.isFront ? demand : Math.max(0, demand - rearDriveBrake)) * w.brakeDisc.muFactor;
      const tyre = this.tyres[w.isFront ? 0 : 1].data.modelData;
      w.brakeTorqueNm = friction + w.fz * tyre.rollingResistance * w.rollingRadius;
    }

    // ---- predicted velocities from the free torques
    const Ie = eng.inertia;
    const Iw = W.map((w) => this.axles[w.isFront ? 0 : 1].wheelInertia);
    let wE = this.engineOmega + ((tIce + tK) / Ie) * h;
    const wW = W.map((w, i) => w.omega + (tyreTorque[i] / Iw[i]) * h);

    // ---- sequential impulses
    const accB = [0, 0, 0, 0];
    let accC = 0;
    let accD = 0;
    const half = 0.5 * ratio;
    const mC = ratio !== 0 ? 1 / (1 / Ie + (half * half) / Iw[2] + (half * half) / Iw[3]) : 0;
    const mD = 1 / (1 / Iw[2] + 1 / Iw[3]);
    const diff = cfg.differential.settings;
    const cot = (deg: number) => 1 / Math.tan(Math.max(5, deg) * DEG2RAD);
    const lockPower = diff.power * diff.friction_faces * cot(diff.power_ramp_deg);
    // An electronic diff opens up on the brakes (corner entry)
    const coast = inp.brake > 0.05 ? (cfg.differential.coastBraking ?? diff.coast) : diff.coast;
    const lockCoast = coast * diff.friction_faces * cot(diff.coast_ramp_deg);
    let lockTorque = diff.preload;
    for (let it = 0; it < SOLVER_ITERATIONS; it++) {
      for (let i = 0; i < 4; i++) {
        const max = W[i].brakeTorqueNm * h;
        const prev = accB[i];
        accB[i] = THREE.MathUtils.clamp(prev - wW[i] * Iw[i], -max, max);
        wW[i] += (accB[i] - prev) / Iw[i];
      }
      if (clutchCap > 0 && ratio !== 0) {
        const c = wE - half * (wW[2] + wW[3]);
        const max = clutchCap * h;
        const prev = accC;
        accC = THREE.MathUtils.clamp(prev - c * mC, -max, max);
        const d = accC - prev;
        wE += d / Ie;
        wW[2] -= (half * d) / Iw[2];
        wW[3] -= (half * d) / Iw[3];
      }
      // Torque into the diff (Nm): + when the engine drives the wheels forward
      const tIn = (-accC / h) * ratio;
      lockTorque = diff.preload + Math.abs(tIn) * (tIn >= 0 ? lockPower : lockCoast);
      {
        const c = wW[2] - wW[3];
        const max = lockTorque * h;
        const prev = accD;
        accD = THREE.MathUtils.clamp(prev - c * mD, -max, max);
        const d = accD - prev;
        wW[2] += d / Iw[2];
        wW[3] -= d / Iw[3];
      }
    }
    this.lsdLockTorque = lockTorque;
    this.engineOmega = Math.max(0, wE);
    for (let i = 0; i < 4; i++) {
      W[i].driveTorqueNm = i >= 2 ? -(accC / h) * half : 0;
      W[i].omega = wW[i];
    }

    // ---- energy store
    let pMech = tK * this.engineOmega;
    if (pMech > 0) {
      // Never overrun the per-lap allowance or the store inside a sub-step
      const room = Math.min(ers.deployPerLapJ - this.lapDeployJ, this.ersEnergyJ);
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
      this.lapHarvestJ += -pMech * h;
    }
  }

  /** Front wing, venturi floor and rear wing on the current ride heights, with wake & roll sensitivity */
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
    const gF = 0.5 * (W[0].ground.height + W[1].ground.height);
    const gR = 0.5 * (W[2].ground.height + W[3].ground.height);
    this.rideFront = fy - gF;
    this.rideRear = ry - gR;
    const hMean = 0.5 * (this.rideFront + this.rideRear);
    const rakeDeg = Math.atan2(this.rideRear - this.rideFront, L) * RAD2DEG;
    const pitchDelta = rakeDeg - this.staticRakeDeg;
    const wake = this.aeroWake;

    const vF = this.velocity.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    let down = 0;
    let front = 0;
    let drag = aero.drag * wake.dragMultiplier;

    for (const wing of this.wings) {
      const s = wing.spec;
      const h = s.heightRef === 'front' ? this.rideFront : s.heightRef === 'rear' ? this.rideRear : hMean;
      const aoa = s.name === 'VENTURI_FLOOR' ? rakeDeg : s.angleDeg + pitchDelta;
      let cl = wing.aoaCl.evaluate(aoa) * wing.ghCl.evaluate(h);
      let cd = wing.aoaCd.evaluate(aoa) * wing.ghCd.evaluate(h);
      if (s.drs) {
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

    const speed = this.velocity.length();
    const dragN = 0.5 * this.airDensity * speed * speed * drag;
    if (speed > 1e-3) this.force.addScaledVector(this.velocity, -dragN / speed);

    this.aeroDownN = down;
    this.aeroFrontN = front;
    this.aeroDragN = dragN;
  }

  /**
   * CSP-style map aero: CL·A / CD·A × the ride-height tables (clearance of the pickups at the axles) × roll and yaw,
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
    this.rideFront = fy - 0.5 * (W[0].ground.height + W[1].ground.height);
    this.rideRear = ry - 0.5 * (W[2].ground.height + W[3].ground.height);
    const rakeDeg = Math.atan2(this.rideRear - this.rideFront, L) * RAD2DEG;
    const pitchDelta = rakeDeg - this.staticRakeDeg;
    const wake = this.aeroWake;

    const vF = this.velocity.dot(_ez);
    const q = 0.5 * this.airDensity * vF * vF;
    const rollDeg = Math.asin(THREE.MathUtils.clamp(_ex.y, -1, 1)) * RAD2DEG;
    const yawDeg = Math.abs(vF) > 1 ? Math.atan2(this.velocity.dot(_ex), Math.abs(vF)) * RAD2DEG : 0;
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
    const clA = map.clA * clMult;
    let front = q * (clA * balance + act.dClAFront * open);
    let rear = q * (clA * (1 - balance) + act.dClARear * open);
    let cdA = map.cdA * cdMult + act.dCdA * open;
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
    const speed = this.velocity.length();
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
    if (speed > 1e-3) this.force.addScaledVector(this.velocity, -this.mapAeroDragN / speed);
    this.aeroDownN = this.mapAeroFrontN + this.mapAeroRearN;
    this.aeroFrontN = this.mapAeroFrontN;
    this.aeroDragN = this.mapAeroDragN;
  }

  /** Skid-block contact at the front and rear of the plank (floor reference plane) */
  private applyPlankContact(): void {
    const pl = this.config.aero.plank;
    const y = pl ? pl.y : this.floorOffsetY;
    for (const z of pl ? [pl.frontZ, pl.rearZ] : [this.cgToFrontM, -this.cgToRearM]) {
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

  /** 9-node I/M/O + 16-sector tyre temperatures, wear, flat-spots, graining, blistering, dirt, and 2-node brake discs */
  private updateThermal(dt: number): void {
    const carSpeedMs = this.velocity.length();
    for (const w of this.wheels) {
      const td = this.tyres[w.isFront ? 0 : 1].data;
      const th = td.thermalData;
      const v = Math.abs(w.vx);
      const slipPower = Math.abs(w.fx * w.slipVelX) + Math.abs(w.fy * w.vy);
      const hyst = th.hysteresis * w.fz * v;
      const toCore = th.surfaceToCore * (w.surfaceTempC - w.coreTempC);
      const surfCool = (th.surfaceCooling[0] + th.surfaceCooling[1] * v) * (w.surfaceTempC - this.ambientC);
      const roadCool = w.fz > 0 ? ROAD_CONDUCTANCE * (w.surfaceTempC - this.trackTempC) : 0;
      const coreCool = (th.coreCooling[0] + th.coreCooling[1] * v) * (w.coreTempC - this.ambientC);
      w.surfaceTempC += ((th.slipHeatShare * slipPower - toCore - surfCool - roadCool) / th.surfaceHeatCapacity) * dt;
      w.coreTempC += ((hyst + toCore - coreCool) / th.coreHeatCapacity) * dt;

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
      for (let b = 0; b < 3; b++) {
        const share = shares[b] * 3;
        const bToCore = th.surfaceToCore * (w.bandTempsC[b] - w.bandCoreTempsC[b]);
        const bSurfCool = (th.surfaceCooling[0] + th.surfaceCooling[1] * v) * (w.bandTempsC[b] - this.ambientC);
        const bRoadCool = w.fz > 0 ? ROAD_CONDUCTANCE * (shares[b] * 3) * (w.bandTempsC[b] - this.trackTempC) : 0;
        const bCoreCool = (th.coreCooling[0] + th.coreCooling[1] * v) * (w.bandCoreTempsC[b] - this.ambientC);
        w.bandTempsC[b] += ((th.slipHeatShare * slipPower * share - bToCore - bSurfCool - bRoadCool) / th.surfaceHeatCapacity) * dt;
        w.bandCoreTempsC[b] += ((hyst * share + bToCore - bCoreCool) / th.coreHeatCapacity) * dt;
        w.bandCarcassTempsC[b] = 0.55 * w.bandTempsC[b] + 0.45 * w.bandCoreTempsC[b];
      }
      // Cross-band conduction
      const d01 = 12 * (w.bandTempsC[0] - w.bandTempsC[1]) * dt;
      const d12 = 12 * (w.bandTempsC[1] - w.bandTempsC[2]) * dt;
      w.bandTempsC[0] -= d01;
      w.bandTempsC[1] += d01 - d12;
      w.bandTempsC[2] += d12;

      // Wear & 16-sector flat-spotting / graining / blistering / dirt pickup
      const wearDelta = (slipPower * 1.4e-8 + w.fz * v * 2.5e-10) * dt;
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

      const surfCoreDelta = w.surfaceTempC - w.coreTempC;
      if (w.coreTempC < 78 && surfCoreDelta > 10 && slipPower > 6000) {
        w.grainLevel = Math.min(1, w.grainLevel + (slipPower / 100000) * ((78 - w.coreTempC) / 30) * 0.25 * dt);
      } else if (w.coreTempC >= 82 && w.coreTempC <= 120 && w.fz > 500 && slipPower < 25000) {
        w.grainLevel = Math.max(0, w.grainLevel - 0.035 * dt);
      }
      if (w.coreTempC > 128) {
        w.blisterLevel = Math.min(1, w.blisterLevel + (w.coreTempC - 128) * 0.0035 * dt);
      }

      w.dirtyLevel = advanceDirtyLevel(w.dirtyLevel, w.ground.surface, slipPower, v, dt, this.realRoad.marbleLevel);

      const p = td.pressureData;
      w.pressurePsi = (w.coldPressurePsi * (w.coreTempC + 273.15)) / (p.coldRefC + 273.15);

      // 2-node physical brake disc thermal step
      const frictionTorqueNm = this.lastInputs.brake > 0.01 ? Math.abs(w.brakeTorqueNm) : 0;
      stepBrakeDiscThermal(
        w.brakeDisc,
        frictionTorqueNm,
        Math.abs(w.omega),
        carSpeedMs,
        this.ambientC,
        dt,
        this.brakeCompound
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
      t.surface[i] = w.ground.surface;
      t.surfaceGrip[i] = w.ground.grip;
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
