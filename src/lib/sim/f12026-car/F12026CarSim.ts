/**
 * f12026-car in the simulator: wraps `VehiclePhysics` behind the `SimulatorCar` surface the simulator,
 * the AI field and the renderer use for the VF26 model, and maps its live telemetry channels to `CarTelemetry`.
 *
 * Ground: the `Track_Collider_Road` colliders and `Track_Collider_Wall_*` barriers once the track GLB has
 * loaded (`attachTrackRoot`); until then (or when it never loads) a ground built from the track samples'
 * lateral height profiles, without barriers.
 *
 * DRS uses the circuit's `ZoneData_DRSZone`s: the flap only opens inside a zone after crossing its
 * detection point (with `drsEligibility` saying yes), and closes on the brake or a lift.
 */
import * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
  F12026Channels,
  RacingLineId,
  SurfaceType,
  TireCompound,
  TyreSetup,
} from '@/types/f1';
import {
  BASE_ALTITUDE_M,
  type BuiltTrackData,
  evaluateSampleLateralHeightM,
  RWANDA_DRS_ZONES,
} from '@/lib/track-data';
import { GamepadSteeringAssist } from '../gamepad-assist';
import type { AeroWakeState } from '../aero-wake';
import type { RealRoadSectorQuery } from '../real-road';
import { flyingExitSpeedMs, flyingStartPoint, type SimulatorCar, type SimulatorWheel, type TyreVisualState } from '../simulator-car';
import { aiLineOffsetM, type BrakingGuide, brakingGuideFor, sampleProfile, type SpeedProfileCarModel } from '../speed-profile';
import { evaluateDynamicBrakingUrgency } from '../track-occupancy';
import {
  type CarPhysicsConfig,
  compoundData,
  DEFAULT_FRICTION_LIMIT_ANGLE_DEG,
  F12026_CAR_CONFIG,
  type TyresCompoundData,
} from './F12026CarConfig';
import {
  DEFAULT_SURFACE_GRIP,
  type GroundHit,
  type GroundQuery,
  TrackColliderQuery,
  type TrackSurfaceKind,
  TrackWallQuery,
} from './TrackColliderQuery';
import { type VehicleEvent, type VehicleInputs, VehiclePhysics } from './VehiclePhysics';

const G = 9.81;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
/** Rwanda (≈1400 m ASL) air density */
const AIR_DENSITY = 1.06;

/** Braking envelope (g) a car pulls at a speed: `lowG` + `aeroG` × min(1, (v / `refMs`)²) */
export interface BrakingEnvelope {
  lowG: number;
  aeroG: number;
  refMs: number;
}

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
  /** Traction control: allowed rear slip ratio; ABS: allowed lock-up slip ratio (0 = off) */
  tcTarget: Record<DriverAssistPreset, number>;
  absTarget: Record<DriverAssistPreset, number>;
  /** Traction control works above this speed (m/s) */
  tcMinSpeedMs: number;
  /** Wing angle offsets per aero package (deg): front, rear */
  aeroPackagesDeg: Record<AeroSetupPreset, [number, number]>;
  /** Lateral grip the pad steering assist assumes, per g of (weight + downforce) */
  padLateralMu: number;
  braking: BrakingEnvelope;
  /**
   * Planning model of this car for its braking line, braking urgency and HUD target speed (`brakingGuideFor`).
   * Without one the car uses the circuit's (the VF26 profile baked into the track samples).
   */
  speedProfile?: SpeedProfileCarModel;
  /** The racing line this car drives, plans on and draws (default: the F1 line) */
  racingLine?: RacingLineId;
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
  // 1.0 / 0.85 × the 0.1 peak slip ratio of every f12026-car compound
  tcTarget: { pro: 0, semi_pro: 0.1, assisted: 0.085 },
  absTarget: { pro: 0, semi_pro: 0.15, assisted: 0.11 },
  tcMinSpeedMs: 2,
  // Wing offsets: front 10–30° (set 25), rear 0–20° (set 15)
  aeroPackagesDeg: { low_downforce: [-10, -10], balanced: [0, 0], high_downforce: [5, 5] },
  // Flat-ground steer ramps: 2.3 g at 100 km/h on 1.24 g of load (μ ≈ 1.8), falling with load
  padLateralMu: 1.75,
  // Flat-ground probes: 2.3 / 3.6 / 4.0 g lateral at 100 / 200 / 280 km/h, 4.3 g on the brakes from 300
  braking: { lowG: 1.5, aeroG: 2.6, refMs: 70 },
};

/** How far inside the track edge the autopilot keeps the CG (m): half the track plus 0.4 m (1.2 m on the f12026-car) */
function autopilotEdgeMarginM(profile: CarSimProfile): number {
  const ch = profile.config.chassis;
  return 0.5 * Math.max(ch.trackWidthFront, ch.trackWidthRear) + 0.4;
}

/** Deceleration the autopilot plans with at a speed (m/s): 85 % of what the car pulls on the brakes */
function autopilotDecel(b: BrakingEnvelope, speedMs: number): number {
  return 0.85 * 9.81 * (b.lowG + b.aeroG * Math.min(1, (speedMs / b.refMs) ** 2));
}

/** Spacing of the autopilot's own speed profile (m) */
const AP_PROFILE_STEP_M = 5;
/** Lateral grip the autopilot plans corners with, as a fraction of its braking envelope */
const AP_LATERAL_SHARE = 1.1;
const apProfiles = new WeakMap<BuiltTrackData, Map<string, Float32Array>>();

/**
 * The f12026-car's own speed limit along the path its autopilot drives (the racing line kept on the asphalt),
 * every `AP_PROFILE_STEP_M`: corner speed from its own grip and downforce, then a backward braking pass on the
 * friction circle, so no braking is planned that the tyres need for turning. The circuit's profile is the VF26's,
 * which corners and brakes harder than this car.
 */
function autopilotProfile(track: BuiltTrackData, profile: CarSimProfile): Float32Array {
  let perCar = apProfiles.get(track);
  if (!perCar) apProfiles.set(track, (perCar = new Map()));
  const cached = perCar.get(profile.id);
  if (cached) return cached;
  const b = profile.braking;
  const L = track.totalLengthM;
  const n = Math.ceil(L / AP_PROFILE_STEP_M);
  const ds = L / n;
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance(i * ds);
    const edge = smp.width / 2 - autopilotEdgeMarginM(profile);
    const off = THREE.MathUtils.clamp(aiLineOffsetM(smp, profile.racingLine), -edge, edge);
    px[i] = smp.position.x + smp.binormal.x * off;
    pz[i] = smp.position.z + smp.binormal.z * off;
  }
  // Path curvature over ±10 m (circumcircle of three points), the larger of two neighbouring spans
  const k = new Float64Array(n);
  const span = Math.max(1, Math.round(10 / ds));
  for (let i = 0; i < n; i++) {
    const a = (i - span + n) % n;
    const c = (i + span) % n;
    const abx = px[i] - px[a], abz = pz[i] - pz[a], bcx = px[c] - px[i], bcz = pz[c] - pz[i];
    const acx = px[c] - px[a], acz = pz[c] - pz[a];
    const cross = Math.abs(abx * bcz - abz * bcx);
    k[i] = (2 * cross) / Math.max(1e-6, Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(acx, acz));
  }
  const v = new Float32Array(n);
  // v²κ = share × decel(v), with decel(v) = c (low + aero (v / ref)²) up to ref and c (low + aero) above
  const c = AP_LATERAL_SHARE * 0.85 * 9.81;
  for (let i = 0; i < n; i++) {
    const kk = Math.max(k[i], k[(i + 1) % n], k[(i - 1 + n) % n], 1e-5);
    const den = kk - (c * b.aeroG) / (b.refMs * b.refMs);
    const vLow = den > 0 ? Math.sqrt((c * b.lowG) / den) : Infinity;
    v[i] = Math.min(110, vLow < b.refMs ? vLow : Math.sqrt((c * (b.lowG + b.aeroG)) / kk));
  }
  // Backward braking pass (twice round the lap so the wrap is consistent)
  for (let pass = 0; pass < 2 * n; pass++) {
    const i = (n - 1 - (pass % n) + n) % n;
    const j = (i + 1) % n;
    const vj = v[j];
    const aLat = vj * vj * k[j];
    const aDec = autopilotDecel(b, vj);
    const aLong = Math.sqrt(Math.max(0.15 * aDec * aDec, aDec * aDec - (aLat / AP_LATERAL_SHARE) ** 2));
    v[i] = Math.min(v[i], Math.sqrt(vj * vj + 2 * aLong * ds));
  }
  perCar.set(profile.id, v);
  return v;
}

/** Driver aids and the autopilot run on frame slices no longer than this (s) */
const AID_SLICE_S = 1 / 240;
const BOOST_S = 8;
const BOOST_COOLDOWN_S = 4;
const AMBIENT_C = 27;
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
      edge <= 0 ? 'road' : kerb && edge < 1 ? 'kerb' : edge < runoff ? 'runoff' : edge < runoff + gravel ? 'gravel' : 'grass';
    out.surface = kind;
    out.grip = DEFAULT_SURFACE_GRIP[kind];
    out.source = 'track-samples';
    return true;
  }
}

/** Colliders built once per loaded track root and shared by every f12026-car */
const colliderCache = new WeakMap<THREE.Object3D, { ground: TrackColliderQuery; walls: TrackWallQuery } | null>();

function collidersFor(root: THREE.Object3D) {
  if (!colliderCache.has(root)) {
    try {
      colliderCache.set(root, { ground: TrackColliderQuery.fromTrackRoot(root), walls: TrackWallQuery.fromTrackRoot(root) });
    } catch (err) {
      console.warn('f12026-car: track colliders unavailable, staying on the sample ground', err);
      colliderCache.set(root, null);
    }
  }
  return colliderCache.get(root) ?? null;
}

interface AdapterWheel extends SimulatorWheel {
  brakeTempC: number;
}

const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _v = new THREE.Vector3();

export class F12026CarSim implements SimulatorCar {
  public readonly vehicle: VehiclePhysics;
  public readonly config: CarPhysicsConfig;
  public readonly telemetry: CarTelemetry;
  public readonly worldPosition = new THREE.Vector3();
  public readonly worldQuaternion = new THREE.Quaternion();
  public readonly wheels: [AdapterWheel, AdapterWheel, AdapterWheel, AdapterWheel];
  /** Visual tyre state per corner (FR, FL, RR, RL), refreshed in `syncPose()`. Read-only for consumers. */
  public readonly tyreVisuals: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState];
  public readonly profile: CarSimProfile;
  /** This car's braking guidance (null: the circuit's) */
  public readonly brakingGuide: BrakingGuide | null;
  /** The racing line this car follows (`CarSimProfile.racingLine`) */
  private readonly line: RacingLineId;
  public readonly wheelbaseM: number;
  public readonly maxSteerAngleRad: number;
  /** Car-to-car contact uses this car's own mass and yaw inertia (a GT3 is ~1.75× an F1 car's mass) */
  public get contactMassKg(): number {
    return this.config.chassis.totalMassKg;
  }
  public get contactYawInertiaKgM2(): number {
    return this.config.chassis.inertia.yaw;
  }
  public readonly cgToFrontAxleM: number;
  public readonly cgToRearAxleM: number;
  public readonly pitchRad = 0;
  public readonly rollRad = 0;
  public readonly rideHeightOffsetM = 0;
  public wheelRotationRad = 0;
  public vyMs = 0;
  public yawRateRadS = 0;
  public steerAngleNorm = 0;

  public aiAutopilot = false;
  /** Fraction of the f12026-car's own limit speed (see `autopilotProfile`) the autopilot drives at */
  public aiPaceScale = 0.8;
  public assistPreset: DriverAssistPreset = 'semi_pro';
  public gamepadAssistEnabled = true;
  public readonly gamepadAssist = new GamepadSteeringAssist();
  /** DRS is driver-operated on the f12026-car (and absent on a GT3) */
  public autoXMode = false;
  /** Asked at each DRS detection point (e.g. within 1 s of the car ahead); null = always eligible */
  public drsEligibility: ((zoneId: string) => boolean) | null = null;

  private readonly track: BuiltTrackData;
  private readonly baseWingDeg: number[];
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
  private coldPsi = { front: 0, rear: 0 };
  private onColliders = false;
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
  private lineCrossingStartsLap = true;
  private drsPressPending = false;
  private boostRemainingS = 0;
  private boostCooldownS = 0;
  private tcCut = 1;
  private absCut = 1;
  /** Per-wheel ABS pressure share (LF, RF, LR, RR); `absCut` is their minimum */
  private readonly absWheelCut: [number, number, number, number] = [1, 1, 1, 1];
  private padSteerActive = false;
  private steerCmd = 0;
  private apPedal = 0;
  private apTc = 1;
  private apAbs = 1;
  private apThrottle = 0;
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
    const vis = (radius: number): TyreVisualState => ({ loadedRadiusM: radius, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0 });
    this.tyreVisuals = [vis(geo.front.radius), vis(geo.front.radius), vis(geo.rear.radius), vis(geo.rear.radius)];
    this.baseWingDeg = this.config.aero.wings.map((w) => w.angleDeg);
    const L = track.totalLengthM;
    this.vehicle = new VehiclePhysics({
      ground: new TrackSampleGroundQuery(track),
      config: this.config,
      compound: this.config.compoundSlots[this.compound],
      airDensity: AIR_DENSITY,
      ambientC: AMBIENT_C,
      drsZones: profile.hasDrs ? RWANDA_DRS_ZONES : [],
      locateProgress: (x, z) => {
        const p = track.projectWorldToTrack(x, z, this.progressHintS);
        this.progressHintS = p.s;
        return p.s / L;
      },
      drsEligibleAtDetection: (zone) => (this.drsEligibility ? this.drsEligibility(zone.id) : true),
      onEvent: (e) => this.onVehicleEvent(e),
    });
    const v = this.vehicle;
    v.turbocharged = profile.turbo;
    this.wheelbaseM = v.wheelbaseM;
    this.maxSteerAngleRad = v.maxSteerRad;
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
    this.telemetry = this.createTelemetry();
    this.telemetry.f12026 = this.channels;
    this.channels.carId = profile.id;
    this.channels.hasErs = profile.hasErs;
    this.channels.hasDrs = profile.hasDrs;
    this.coldPsi = { front: v.wheels[0].coldPressurePsi, rear: v.wheels[2].coldPressurePsi };
    if (root) this.attachTrackRoot(root);
    this.resetToStartGrid(false);
  }

  // ===========================================================================
  // Track
  // ===========================================================================

  /** Switch to the GLB's road / surface colliders and barriers (no-op when they cannot be built) */
  public attachTrackRoot(root: THREE.Object3D): void {
    const c = collidersFor(root);
    if (!c) return;
    const wasOn = this.onColliders;
    this.vehicle.setGround(c.ground);
    this.vehicle.setWalls(c.walls);
    this.onColliders = true;
    // A car at rest is re-seated on the collider heights; a moving one rides over the (small) step
    if (!wasOn && this.vehicle.speedMs < 0.5) {
      const p = this.vehicle.position;
      this.vehicle.reset(p.x, p.z, this.yaw());
      this.syncPose();
    }
  }

  public get onTrackColliders(): boolean {
    return this.onColliders;
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
      v.reset(p.x, p.z, this.yaw(), value);
    } else {
      _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
      v.velocity.addScaledVector(_ez, value - vx);
      const scale = Math.abs(vx) > 1 ? value / vx : 1;
      for (const w of v.wheels) w.omega *= scale;
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
    this.config.aero.wings.forEach((w, i) => {
      w.angleDeg = this.baseWingDeg[i] + (w.name === 'FRONT_WING' ? front : w.name === 'REAR_WING' ? rear : 0);
    });
  }

  get tireCompound(): TireCompound {
    return this.compound;
  }

  set tireCompound(compound: TireCompound) {
    this.compound = compound;
    this.vehicle.setCompound(this.config.compoundSlots[compound]);
    this.applyColdPressures();
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

  /** Within the profile's limits (f12026-car: as the VF26, 17–27 psi to 0.1, front camber −4.5…−1.5°, rear −3.0…−0.5°) */
  public setTyreSetup(setup: TyreSetup): void {
    const pick = (v: number, [lo, hi]: [number, number], current: number) => (Number.isFinite(v) ? THREE.MathUtils.clamp(v, lo, hi) : current);
    const pr = this.profile;
    this.coldPsi.front = Math.round(pick(setup.coldPressurePsi.front, pr.coldPsiRange, this.coldPsi.front) * 10) / 10;
    this.coldPsi.rear = Math.round(pick(setup.coldPressurePsi.rear, pr.coldPsiRange, this.coldPsi.rear) * 10) / 10;
    const s = this.config.suspensions;
    s.front.staticCamber = pick(setup.camberDeg.front, pr.frontCamberRange, s.front.staticCamber);
    s.rear.staticCamber = pick(setup.camberDeg.rear, pr.rearCamberRange, s.rear.staticCamber);
    this.applyColdPressures();
  }

  /** Push mode (PSH) for 8 s */
  public activateBoostOverride(): boolean {
    if (this.profile.hasErs && this.vehicle.ersEnergyJ > 200_000 && this.boostCooldownS <= 0) {
      this.boostRemainingS = BOOST_S;
      return true;
    }
    return false;
  }

  public setAeroWakeState(wake: AeroWakeState | null): void {
    this.vehicle.setAeroWakeState(wake);
  }

  public setRealRoadSample(sample: RealRoadSectorQuery | null): void {
    this.vehicle.setRealRoadSample(sample);
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
    const L = this.track.totalLengthM;
    if (flyingStart) {
      // From the final straight (`flyingStartPoint`), on this car's line, kept on the asphalt, and no faster than
      // 90 % of the speed this car's autopilot plans there, nor than it can carry out of the last corner
      const start = flyingStartPoint(this.track);
      const s = wrap(start.s - gridSlot * 28, L);
      const smp = this.track.getSampleAtDistance(s);
      const edge = Math.max(0, smp.width / 2 - autopilotEdgeMarginM(this.profile));
      const stagger = gridSlot === 0 ? 0 : gridSlot % 2 === 1 ? -2.6 : 2.6;
      const lateral = THREE.MathUtils.clamp(aiLineOffsetM(smp, this.line) + stagger, -edge, edge);
      const prof = autopilotProfile(this.track, this.profile);
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
        this.vehicle.reset(slot.position[0], slot.position[2], slot.yawRad);
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
    this.lineCrossingStartsLap = true;
    this.telemetry.currentLapTimeMs = 0;
    this.telemetry.topSpeedThisLapKmh = 0;
  }

  public teleportToDistance(sMeters: number, speedMs = 0, lateral = 0): void {
    this.lineCrossingStartsLap = false;
    this.placeAt(wrap(sMeters, this.track.totalLengthM), lateral, Math.max(0, speedMs));
    this.afterPlacement();
  }

  public teleportToTurn(turnNumber: number): void {
    const samples = this.track.samples;
    const idx = samples.findIndex((s) => s.turnNumber === turnNumber);
    const target = idx >= 0 ? samples[(idx + 2) % samples.length] : samples[0];
    this.teleportToDistance(target.s, Math.min(62, target.optimalSpeedKmh / 3.6), aiLineOffsetM(target, this.line));
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
      manualOverride: raw.manualOverride ?? false,
      toggleXMode: raw.toggleXMode ?? false,
      shiftUp: raw.shiftUp ?? false,
      shiftDown: raw.shiftDown ?? false,
    };
    if (inputs.toggleXMode && this.profile.hasDrs) this.drsPressPending = true;

    // Push mode while the override is held / latched, or for the boost's 8 s
    this.boostCooldownS = Math.max(0, this.boostCooldownS - dtSeconds);
    if (this.boostRemainingS > 0) {
      this.boostRemainingS = Math.max(0, this.boostRemainingS - dtSeconds);
      if (this.boostRemainingS === 0) this.boostCooldownS = BOOST_COOLDOWN_S;
    }
    const push = this.profile.hasErs && (inputs.manualOverride || this.boostRemainingS > 0) && v.ersEnergyJ > 0;
    v.setPerformanceMode(push ? 'PSH' : 'RAC');

    const slices = Math.max(1, Math.ceil(dtSeconds / AID_SLICE_S - 1e-9));
    const h = dtSeconds / slices;
    let first = true;
    for (let k = 0; k < slices; k++) {
      const cmd: { throttle: number; brake: number; brakeWheelScale?: readonly [number, number, number, number]; steer: number; drs: boolean } =
        this.aiAutopilot ? this.autopilot(h) : this.driverCommand(inputs, h);
      const vin: VehicleInputs = { throttle: cmd.throttle, brake: cmd.brake, brakeWheelScale: cmd.brakeWheelScale, steer: cmd.steer };
      if (first) {
        vin.drs = this.drsPressPending || cmd.drs;
        vin.shiftUp = inputs.shiftUp;
        vin.shiftDown = inputs.shiftDown;
        this.drsPressPending = false;
        first = false;
      }
      this.steerCmd = cmd.steer;
      _v.copy(v.velocity);
      v.step(h, vin);
      this.updateBrakes(h);
      const dvx = _v.subVectors(v.velocity, _v);
      this.lastAxMs2 = dvx.dot(_ez.set(0, 0, 1).applyQuaternion(v.quaternion)) / h;
      this.lastAyMs2 = dvx.dot(_ex.set(1, 0, 0).applyQuaternion(v.quaternion)) / h;
    }
    this.simTimeMs += dtSeconds * 1000;
    if (this.recoverIfLost()) return this.telemetry;
    if (this.aiAutopilot) this.recoverIfStuck(dtSeconds);
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

  /** Steering (keyboard / wheel / mouse straight, pad through the steering assist) and TC / ABS */
  private driverCommand(
    inputs: ControlInputs,
    h: number
  ): { throttle: number; brake: number; brakeWheelScale?: readonly [number, number, number, number]; steer: number; drs: boolean } {
    let steer: number;
    if (inputs.padSteer !== undefined) {
      if (!this.padSteerActive) this.gamepadAssist.reset();
      this.padSteerActive = true;
      const front = this.compoundData.modelData;
      steer = this.gamepadAssistEnabled
        ? this.gamepadAssist.update(
            inputs.padSteer,
            {
              vxMs: this.vxMs,
              vyMs: this.bodyVy(),
              yawRateRadS: this.bodyYawRate(),
              cgToFrontAxleM: this.cgToFrontAxleM,
              cgToRearAxleM: this.cgToRearAxleM,
              wheelbaseM: this.wheelbaseM,
              maxSteerAngleRad: this.maxSteerAngleRad,
              frontPeakSlipRad: (front.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD,
              brake: inputs.brake,
              maxLateralAccel: this.profile.padLateralMu * (G + this.vehicle.telemetry.downforceN / this.vehicle.totalMassKg),
            },
            h
          )
        : inputs.padSteer;
    } else {
      this.padSteerActive = false;
      steer = inputs.analogSteer !== undefined ? inputs.analogSteer : inputs.steerRight - inputs.steerLeft;
    }

    const v = this.vehicle;
    const W = v.wheels;
    const speed = v.speedMs;
    let throttle = inputs.throttle;
    const tcTarget = this.profile.tcTarget[this.assistPreset];
    if (tcTarget > 0 && speed > this.profile.tcMinSpeedMs) {
      // in units of the peak slip ratio, so the cut gain is the same for every tyre
      const peak = this.compoundData.modelData.slip_ratio_limit;
      const excess = Math.max(0, (Math.max(W[2].slipRatio, W[3].slipRatio) - tcTarget) / peak);
      const want = Math.max(0.05, 1 - excess * 4);
      this.tcCut += (want - this.tcCut) * Math.min(1, (want < this.tcCut ? 80 : 10) * h);
      throttle *= this.tcCut;
    } else {
      this.tcCut = 1;
    }
    const brake = inputs.brake;
    const absTarget = this.profile.absTarget[this.assistPreset];
    const cut = this.absWheelCut;
    // A placement resets absCut to exactly 1: start the wheels from released too
    if (this.absCut === 1) cut.fill(1);
    if (absTarget > 0 && speed > 3) {
      // Per wheel, as AC's ABS: a locking front no longer releases the (already lighter-braked) rears
      let minCut = 1;
      for (let i = 0; i < 4; i++) {
        const lock = -W[i].slipRatio;
        const want = lock > absTarget ? Math.max(0.1, 1 - (lock - absTarget) * 12) : 1;
        cut[i] += (want - cut[i]) * Math.min(1, (want < cut[i] ? 80 : 20) * h);
        minCut = Math.min(minCut, cut[i]);
      }
      this.absCut = minCut;
    } else {
      this.absCut = 1;
      cut.fill(1);
    }
    return { throttle, brake, brakeWheelScale: cut, steer: THREE.MathUtils.clamp(steer, -1, 1), drs: false };
  }

  /**
   * Autopilot: pure pursuit on the racing line with countersteer on body slip, a target speed of
   * `aiPaceScale` × this car's limit speed just ahead (its own profile, never above the circuit's braking-limit
   * speed), pedals feathered on wheelspin / lock-up.
   * Opens DRS on full throttle when it is available.
   */
  private autopilot(h: number): { throttle: number; brake: number; steer: number; drs: boolean } {
    const v = this.vehicle;
    const L = this.track.totalLengthM;
    const speed = v.speedMs;
    const p = this.track.projectWorldToTrack(v.position.x, v.position.z, this.poseHintS);
    const look = this.track.getSampleAtDistance((p.s + Math.max(10, speed * 0.55)) % L);
    // the racing line uses the kerbs; the autopilot keeps all four wheels on the asphalt
    const edge = look.width / 2 - autopilotEdgeMarginM(this.profile);
    const off = THREE.MathUtils.clamp(aiLineOffsetM(look, this.line), -edge, edge);
    _ex.set(1, 0, 0).applyQuaternion(v.quaternion);
    _ez.set(0, 0, 1).applyQuaternion(v.quaternion);
    const dx = look.position.x + look.binormal.x * off - v.position.x;
    const dz = look.position.z + look.binormal.z * off - v.position.z;
    const dl = Math.hypot(dx, dz);
    const alpha = Math.atan2(dx * _ex.x + dz * _ex.z, dx * _ez.x + dz * _ez.z);
    const beta = Math.atan2(v.velocity.dot(_ex), Math.max(1, v.velocity.dot(_ez)));
    // Pure pursuit asks for a path curvature; yaw-rate PI makes the car actually turn at it, so its
    // understeer at speed does not carry it wide of the line
    const kappa = (2 * Math.sin(alpha)) / Math.max(5, dl);
    const yawErr = speed * kappa + this.bodyYawRate();
    const kYaw = v.wheelbaseM / Math.max(10, speed);
    // Never steer the fronts far past their peak slip angle: beyond it they only scrub and the car runs wide
    // (the integrator holds while the governor is on, so it cannot wind up)
    const peak = (this.compoundData.modelData.friction_limit_angle || DEFAULT_FRICTION_LIMIT_ANGLE_DEG) * DEG2RAD;
    const betaF = Math.atan2(v.velocity.dot(_ex) - this.bodyYawRate() * this.cgToFrontAxleM, Math.max(1, v.velocity.dot(_ez)));
    const raw = Math.atan(v.wheelbaseM * kappa) + 0.8 * beta + 0.5 * kYaw * yawErr + this.apYawI;
    const delta = THREE.MathUtils.clamp(raw, betaF - 1.15 * peak, betaF + 1.15 * peak);
    const frontsSaturated = delta !== raw;
    if (!frontsSaturated) this.apYawI = THREE.MathUtils.clamp(this.apYawI + yawErr * kYaw * 2 * h, -0.05, 0.05);
    // Braking envelope of this car: its own limit speeds (capped at the circuit's) × pace over the next 300 m,
    // each reachable by braking at the f12026-car's own deceleration. Aimed a little ahead of the car to cover the
    // pedal's lag.
    const lead = Math.max(5, speed * 0.2);
    const prof = autopilotProfile(this.track, this.profile);
    const b = this.profile.braking;
    let vTarget = Infinity;
    for (let d = 0; d <= 300; d += 5) {
      const smp = this.track.getSampleAtDistance((p.s + lead + d) % L);
      const own = prof[Math.floor(((p.s + lead + d) % L) / (L / prof.length)) % prof.length];
      const vC = Math.min((smp.brakeLimitKmh ?? smp.optimalSpeedKmh) / 3.6, own) * this.aiPaceScale;
      if (vC >= vTarget) continue;
      const a = 0.5 * (autopilotDecel(b, vC) + autopilotDecel(b, Math.min(speed, Math.sqrt(vC * vC + 2 * autopilotDecel(b, vC) * d))));
      vTarget = Math.min(vTarget, Math.sqrt(vC * vC + 2 * a * d));
    }
    // Off the line the corner is tighter than planned: give speed away for it
    const lineErr = Math.abs(aiLineOffsetM(p.sample, this.line) - p.lateralOffset);
    vTarget *= 1 - 0.04 * Math.min(5, Math.max(0, lineErr - 1));
    this.apPedal = THREE.MathUtils.clamp(this.apPedal + (vTarget - speed) * 0.01 * (h * 120), -1, 1);
    const W = v.wheels;
    const spin = Math.max(W[2].slipRatio, W[3].slipRatio);
    const lock = Math.min(W[0].slipRatio, W[1].slipRatio, W[2].slipRatio, W[3].slipRatio);
    this.apTc = THREE.MathUtils.clamp(this.apTc + (0.06 - spin) * (spin > 0.06 ? 1.5 : 0.3) * (h * 120), 0.1, 1);
    this.apAbs = THREE.MathUtils.clamp(this.apAbs + (lock < -0.12 ? -0.2 : 0.05) * (h * 120), 0.05, 1);
    // squeezed on rather than stabbed: at most full throttle in 0.4 s
    const throttle = Math.min(Math.max(0, this.apPedal), this.apTc, this.apThrottle + 2.5 * h);
    this.apThrottle = throttle;
    return {
      throttle,
      // understeering on the brakes: ease off so the fronts have grip left to turn with
      brake: Math.min(Math.max(0, -this.apPedal), this.apAbs) * (frontsSaturated ? 0.5 : 1),
      // aimed at the road-wheel angle: the rack gives up `complianceRad` to the lateral force, so add it back
      steer: THREE.MathUtils.clamp(-(delta - 0.5 * (W[0].complianceRad + W[1].complianceRad)) / v.maxSteerRad, -1, 1),
      drs: v.telemetry.drsAvailable && !v.drsOpen && throttle > 0.95,
    };
  }

  /**
   * The rigid body blew up (non-finite state) or the car fell through the world, e.g. launched over a barrier where
   * there is no ground: put it back on the track, stopped, at the last good position. True if it did.
   */
  private recoverIfLost(): boolean {
    const v = this.vehicle;
    const p = v.position;
    const finite = Number.isFinite(p.x + p.y + p.z) && Number.isFinite(v.velocity.x + v.velocity.y + v.velocity.z)
      && Number.isFinite(v.angularVelocity.x + v.angularVelocity.y + v.angularVelocity.z);
    const s = Number.isFinite(this.s) ? this.s : 0;
    if (finite && p.y > this.track.getSampleAtDistance(s).position.y - LOST_BELOW_TRACK_M) return false;
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
        c.wallImpact = { speedMs: e.speedMs, atMs: this.simTimeMs };
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

  /** At track distance `s`, `lateral` m right of the centreline, heading along the track */
  private placeAt(s: number, lateral: number, speedMs: number): void {
    const sample = this.track.getSampleAtDistance(s);
    const b = sample.binormal;
    const bl = Math.hypot(b.x, b.z) || 1;
    const x = sample.position.x + (b.x / bl) * lateral;
    const z = sample.position.z + (b.z / bl) * lateral;
    this.progressHintS = this.poseHintS = s;
    this.vehicle.reset(x, z, Math.atan2(sample.tangent.x, sample.tangent.z), speedMs);
  }

  private afterPlacement(): void {
    this.gamepadAssist.reset();
    this.padSteerActive = false;
    this.tcCut = this.absCut = this.apTc = this.apAbs = 1;
    this.apPedal = this.apYawI = this.apThrottle = 0;
    this.drsPressPending = false;
    this.boostRemainingS = 0;
    this.lastAxMs2 = this.lastAyMs2 = 0;
    this.stuckS = 0;
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
      w.coldPressurePsi = w.isFront ? this.coldPsi.front : this.coldPsi.rear;
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

  private get lastBrake(): number {
    return this.vehicle.telemetry.brake;
  }

  /** Render pose, track coordinates and the VF-order wheels from the rigid body */
  private syncPose(): void {
    const v = this.vehicle;
    const q = v.quaternion;
    _ey.set(0, 1, 0).applyQuaternion(q);
    this.worldPosition.copy(v.position).addScaledVector(_ey, -this.config.chassis.cgHeight);
    this.worldQuaternion.copy(q);
    const p = this.track.projectWorldToTrack(this.worldPosition.x, this.worldPosition.z, this.poseHintS);
    this.poseHintS = p.s;
    this.s = p.s;
    this.lateral = p.lateralOffset;
    this.vyMs = this.bodyVy();
    this.yawRateRadS = this.bodyYawRate();
    this.steerAngleNorm = this.steerCmd;
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
    if (lapTime > 45_000) {
      t.lastLapTimeMs = lapTime;
      if (this.lapValid && (t.bestLapTimeMs === null || lapTime < t.bestLapTimeMs)) t.bestLapTimeMs = lapTime;
    }
    t.lapCount++;
    t.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.lapValid = true;
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
    const offTrack = W.every((w) => {
      const k = w.ground.surface;
      return k === 'grass' || k === 'gravel' || k === 'runoff';
    });
    if (offTrack) this.lapValid = false;
    let surface: SurfaceType = 'asphalt';
    if (surfaces[0] === 'grass' || surfaces[1] === 'grass') surface = 'grass';
    else if (surfaces[0] === 'runoff' || surfaces[1] === 'runoff') surface = 'runoff';
    else if (onKerbLeft || onKerbRight) surface = 'kerb';

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
    t.manualOverrideActive = v.performanceMode === 'PSH';
    t.boostRemainingS = this.boostRemainingS;
    t.turboBoostBar = this.profile.turbo ? Number(v.turboBoostBar.toFixed(2)) : 1;

    t.tireSlipRatio = quad((w) => w.combinedSlip);
    t.wheelSlipRatios = quad((w) => w.slipRatio);
    t.wheelSlipAnglesDeg = quad((w) => w.slipAngleRad * RAD2DEG);
    t.wheelLoadsN = quad((w) => Math.round(w.fz));
    t.wheelRideHeightsMm = quad((w) => Math.round((w.isFront ? vt.aeroHeightFront : vt.aeroHeightRear) * 1000));
    t.suspensionTravelMm = quad((w) => Number((w.compression * 1000).toFixed(2)));
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
    t.tireGripFactor = quad((w) => Number((w.thermalGrip * w.ground.grip * v.realRoad.gripMultiplier).toFixed(2)));
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
