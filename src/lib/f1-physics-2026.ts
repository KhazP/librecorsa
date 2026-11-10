/**
 * 2026 Formula 1 vehicle dynamics — VF26 physics (`f1-physics-2026.ts`)
 *
 * An assist-free vehicle model driven by the VF26 parameter set
 * (see `src/lib/sim/vf26-data.ts`).
 *
 * Model overview (fixed 500 Hz outer step, 4 × 2 kHz inner sub-steps):
 * - Chassis:      planar 3-DOF (vx, vy, yaw) on the local road plane + sprung heave / pitch / roll
 *                 with uniform-box principal inertia; gravity (slope / banking) and vertical-curvature loads.
 * - Suspension:   4 corner springs (progressive), slow/fast bump & rebound dampers, bump rubbers,
 *                 droop limits, front/rear heave (third) elements with packers, anti-roll bars,
 *                 roll centres computed from double-wishbone hardpoints.
 * - Unsprung:     4 hub masses on radial tyre springs/dampers (kerb strikes, wheel lift).
 * - Tyres:        load-sensitive combined-slip model with falloff, camber, thermal curve,
 *                 relaxation-length carcass. Below 3 m/s a carcass damper is blended in (ac-tyre.ts,
 *                 LOW_SPEED_BLEND_MS) so the deflection spring doesn't ring at standstill.
 * - Aero:         11 wing elements (AoA & ground-height LUTs, yaw sensitivity) incl. 2026 X/Z-mode.
 * - Power unit:   ICE torque × (1 + turbo boost), MGU-K deploy/harvest with ERS controller
 *                 curves, 4 MJ store, 350 kW limit, brake-by-wire blending on the rear axle.
 * - Drivetrain:   seamless 8-speed, auto-clutch launch, limited-slip differential, engine inertia.
 * - Brakes:       max-torque / bias model with disc thermal state.
 *
 * Nothing in here steers or stabilises the car. Driver aids (TC / ABS) only exist when the player selects them,
 * and they act like real ECU aids, on pedal inputs. Two low-speed blends exist for numerical reasons, not for
 * handling: the tyre carcass damper above, and the steering-rack torque fading out below 4 km/h (FFB only).
 */

import * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DiffPhase,
  DriverAssistPreset,
  ERSMode,
  LiveTunerPatch,
  LiveTunerState,
  SurfaceType,
  TireCompound,
  TyreSetup,
  WheelPressures,
} from '@/types/f1';
import { axlePressures, pressureAt } from '@/types/f1';
export type { ControlInputs };
import {
  BASE_ALTITUDE_M,
  type BuiltTrackData,
  evaluateSampleLateralHeightM,
  getActiveSurfaceTable,
  getActiveTrackData,
  RWANDA_DRS_ZONES,
} from './track-data';
import { Lut } from './sim/lut';
import { type OvertakingRaceControl, type OvertakingRules, OvertakeGrant } from './sim/overtaking-rules';
import {
  computeRollCentreHeight,
  mgukDeployCapW,
  VF26_ACTIVE_AERO_TRANSITION_S,
  VF26_BRAKES,
  VF26_CHASSIS,
  VF26_DRIVETRAIN,
  VF26_ENGINE,
  VF26_ERS,
  VF26_TYRES,
  VF26_TYRE_SETUP_RANGES,
  VF26_WINGS,
  type Vf26AxleSuspension,
} from './sim/vf26-data';
import {
  createGroundHit,
  createWallHit,
  type GroundQuery,
  wallPenetration,
  type WallQuery,
  wallSweep,
} from './sim/f12026-car/TrackColliderQuery';
import { trackColliders } from './sim/track-colliders';
import { createWingRuntimes, VF26_CG_HEIGHT_M, type WingRuntime, wingAngleDeg } from './sim/vf26-aero';
import {
  coldPressureFor,
  computeTyreForces,
  type TyreForceInput,
  type TyreForceOutput,
  createContactPatchResult,
  createTyreRuntime,
  evaluateIso8608RoadRoughness,
  sample5PointContactPatch,
  setTyreColdPressure,
  setTyreSpec,
  setTyreTemperature,
  restoreTyreWear,
  tyreWearState,
  tyreBandSurfaceTempC,
  tyreLoadedRadius,
  tyreRollingRadius,
  tyreVerticalDeflection,
  updateTyreThermal,
} from './sim/ac-tyre';
import {
  buildDoubleWishboneHardpoints,
  type CornerKinematicsState,
  createAxleKinematicsState,
  type DoubleWishboneHardpoints,
  solveAxleKinematics3D,
} from './sim/suspension-kinematics';
import {
  computeDynamicBrakeMigration,
  createBrakeDiscState,
  resetBrakeDiscState,
  stepBrakeDiscThermal,
} from './sim/brake-physics';
import {
  type AeroWakeState,
  CLEAN_AIR_WAKE_STATE,
  computeRelativeAirspeed,
  evaluateRollAeroFactor,
  type RelativeAirspeed,
} from './sim/aero-wake';
import { type CarDamageEffects, withDamage } from './sim/car-damage';
import type { AiDrivePlan } from './sim/ai/drive-plan';
import { sampleGrid } from './sim/ai/ai-track';
import type { TrackEvolutionSample } from './sim/track-evolution';
import { DRY_WEATHER_SAMPLE, type WeatherContactSample } from './sim/weather';
import { FULL_REALISM, type SimRealismFlags } from './sim/sim-realism';
import {
  hydrodynamicDragN,
  isRearFlapAllowedInWet,
  surfaceWetMultiplier,
  WET_TYRE_TRAITS,
  wetGripFactor,
  wetnessFromWater,
} from './sim/wet-tyres';
import { surfaceRippleM, type TrackSurfaceKind } from './sim/track-surfaces';
import { BRAKE_DUCT_STEP, type ChassisSetup, clampChassisSetup, DEFAULT_CHASSIS_SETUP, pctScale, startingFuelKg, WING_CLICK_DEG } from './sim/car-setup';
import { flyingExitSpeedMs, flyingStartPoint, type TyreVisualState } from './sim/simulator-car';
import type { VehicleWheelState, WheelCornerIndex } from './sim/vehicle-types';
import {
  type RaceGymObservation,
  computeLookaheadVectors,
  evaluateDynamicBrakingUrgency,
  queryWheelGroundContact,
} from './sim/track-occupancy';
import { type AiVehicleParams, RacingLineDriver } from './sim/ai-mpc';
import { SteeringAssist, type SteeringAssistCarState } from './sim/steering-assist';
import { AxleSlipScratch } from './sim/tyre-slip';
import { type AutoShiftSchedule, autoShift, createAutoShiftInput, ManualShiftOverride } from './sim/auto-gearbox';
import {
  aiLineOffsetM,
  type BrakingGuide,
  circuitBrakingGuide,
  computeSpeedProfile,
  createVf26ProfileCarModel,
  sampleProfile,
  type SpeedProfile,
  vf26FullBrakeForceN,
  withPlanningGrip,
} from './sim/speed-profile';

export type { VehicleWheelState, WheelCornerIndex };

const G = 9.81;
const DEG2RAD = Math.PI / 180;
const RPM2RADS = (2 * Math.PI) / 60;
const RADS2RPM = 60 / (2 * Math.PI);
const AMBIENT_C = 27;
const TRACK_SURFACE_C = 41;
const SUBSTEPS = 4;
const INITIAL_TYRE_TEMP_C = 82;
const INITIAL_BRAKE_TEMP_C = 380;
/** Speed at which the autopilot's wet planning grip is taken (m/s): inters aquaplane above it in standing water */
const AI_PLAN_WET_REF_MS = 50;
/** Share of the wet grip the AI plan leaves in hand on a fully wet road */
const AI_PLAN_WET_MARGIN = 0.15;
/** The VF26's auto box: it shifts down on a lift under 60 % throttle, and always under 6200 rpm */
const VF26_AUTO_SHIFT: AutoShiftSchedule = {
  upshiftRpm: VF26_DRIVETRAIN.autoUpshiftRpm,
  limiterRpm: VF26_ENGINE.limiterRpm,
  downshiftRpm: VF26_DRIVETRAIN.autoDownshiftRpm,
  lugRpm: 6200,
  downshiftMarginRpm: 600,
  upshiftMaxBrake: 0.1,
  liftThrottle: 0.6,
};
const SURFACE_KIND: Record<SurfaceType, TrackSurfaceKind> = {
  asphalt: 'road',
  kerb: 'kerb',
  runoff: 'runoff',
  grass: 'grass',
};
/** Floor stall: plank clearance (m) where the floor starts to lose suction, and where it is fully stalled */
const FLOOR_STALL_START_M = 0.006;
const FLOOR_STALL_FULL_M = 0.004;
/** Floor suction left when fully stalled, and the extra floor drag at full stall */
const FLOOR_STALL_MIN_FACTOR = 0.55;
const FLOOR_STALL_DRAG_RISE = 0.05;
/**
 * Barrier contact: restitution, the most rebound a hit can give (m/s: the barrier and the crash structure soak up
 * the rest, so a 300 km/h hit bounces the car back onto the track side, not across it) and wall friction
 */
const WALL_RESTITUTION = 0.25;
const WALL_MAX_REBOUND_MS = 5;
const WALL_FRICTION = 0.5;
/** Deepest believable penetration past a wall segment, and the clearance a contact is resolved to (m) */
const WALL_MAX_DEPTH_M = 1.2;
const WALL_SKIN_M = 0.001;
/** Height above the centreline road at which barrier segments are tested (m), and the tolerance either side */
const WALL_CAR_Y_M = 0.4;
const WALL_Y_SLACK_M = 2.0;
/** Track-data barrier lines: least run-off before one (m past the track edge), and the line where the data has none */
const WALL_LINE_MIN_RUNOFF_M = 2.5;
const WALL_LINE_DEFAULT_RUNOFF_M = 5.8;

type TrackProjection = ReturnType<BuiltTrackData['projectWorldToTrack']>;

const _wallHit = createWallHit();
/**
 * A mesh kerb's crown above the road for the VF26, which takes its road height from the track samples rather than the
 * mesh (the converted circuits were driven with this)
 */
const MESH_KERB_CROWN_M = 0.018;
const _groundHit = createGroundHit();
// Scratch reused by the 500 Hz / 2 kHz steps instead of allocating (single-threaded; read, never kept)
const _rightFlat = new THREE.Vector3();
const _roadUp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _roadTorque = new Float64Array(4);
const _dF = new Float64Array(4);
const _comp = new Float64Array(4);
const _compVel = new Float64Array(4);
const _plank = new Float64Array(4);
const _subStepAcc = { ax: 0, ay: 0 };
const _tyreIn: TyreForceInput = { fz: 0, vx: 0, vy: 0, rimSpeed: 0, camberLeftRad: 0, surfaceGrip: 1, dt: 0 };
const _tyreOut = {} as TyreForceOutput;

/**
 * Floor suction factor for the lowest corner's plank clearance (m): 1 above 6 mm, smoothstep down to
 * 0.55 at 4 mm and below.
 */
export function floorStallFactorForClearance(clearanceM: number): number {
  const t = THREE.MathUtils.clamp((FLOOR_STALL_START_M - clearanceM) / (FLOOR_STALL_START_M - FLOOR_STALL_FULL_M), 0, 1);
  return 1 - (1 - FLOOR_STALL_MIN_FACTOR) * t * t * (3 - 2 * t);
}

/** Garage defaults: cold gauge pressure reaching the hot gauge reference, to 0.1 psi, and static camber */
function defaultTyreSetup(): TyreSetup {
  const round = (psi: number) => Math.round(psi * 10) / 10;
  return {
    coldPressurePsi: axlePressures(
      round(coldPressureFor(VF26_TYRES.soft.front.pressureRefPsi)),
      round(coldPressureFor(VF26_TYRES.soft.rear.pressureRefPsi))
    ),
    camberDeg: { front: VF26_CHASSIS.front.staticCamberDeg, rear: VF26_CHASSIS.rear.staticCamberDeg },
  };
}

type ErsControllerKey = keyof typeof VF26_ERS.modes;

interface ErsControllerRuntime {
  throttle: Lut;
  speed: Lut;
  gear: Lut;
  soc: Lut;
  coastHarvest: number;
}

interface AxleRuntime {
  spec: Vf26AxleSuspension;
  hardpoints: DoubleWishboneHardpoints;
  rollCentreHeight: number;
  /** Static sprung load carried by each corner spring (N) */
  staticSpringForce: number;
  /** Static spring deflection (m) */
  staticSpringDeflection: number;
  /** Static tyre load per wheel (N) */
  staticTyreLoad: number;
  tyreDamp: number;
  /** Static camber the tyres run at (deg, negative = top in); from the driver's tyre setup */
  camberDeg: number;
}

interface DrivetrainRuntime {
  gear: number;
  shiftTarget: number;
  shiftTimerS: number;
  autoShiftCooldownS: number;
  engineOmega: number;
  clutchLocked: boolean;
  clutchEngagement: number;
  /** Throttle pedal before traction control (sets the auto-clutch launch window) */
  launchPedal: number;
  /** Seconds the auto-clutch has been slipping with the car rolling (lets the launch window down) */
  launchSlipS: number;
  boostBar: number;
  iceTorqueNm: number;
  mgukTorqueNm: number;
  mgukPowerW: number;
  harvestAxleTorqueNm: number;
  limiterCut: boolean;
  fuelKg: number;
  ersMode: ERSMode;
  ersEnergyJ: number;
  boostRemainingS: number;
  boostCooldownS: number;
  diffLockedFraction: number;
}

/** Working window of a grip-vs-temperature curve: where grip is within 3 % of its peak (°C), cached per curve */
const thermalWindowCache = new WeakMap<object, [number, number]>();
function thermalWindowC(curve: ReadonlyArray<readonly [number, number]>): [number, number] {
  const hit = thermalWindowCache.get(curve);
  if (hit) return hit;
  let peak = 0;
  for (const [, g] of curve) peak = Math.max(peak, g);
  const inWindow = curve.filter(([, g]) => g >= peak * 0.97).map(([x]) => x);
  const w: [number, number] = inWindow.length ? [Math.min(...inWindow), Math.max(...inWindow)] : [85, 105];
  thermalWindowCache.set(curve, w);
  return w;
}

export class F1Physics2026 {
  /** Fixed 500 Hz simulation step decoupled from render FPS */
  public static readonly FIXED_DT = 0.002;
  /** Longest frame (s) whose time is simulated in full */
  public static readonly MAX_CATCH_UP_S = 0.25;
  private static readonly MAX_STEPS_PER_CALL = Math.ceil(F1Physics2026.MAX_CATCH_UP_S / F1Physics2026.FIXED_DT) + 1;

  private track: BuiltTrackData;
  private timeAccumulator = 0;

  // Chassis constants (exposed for camera / HUD / AI)
  public readonly massKg: number = VF26_CHASSIS.totalMassKg;
  public readonly wheelbaseM: number = VF26_CHASSIS.wheelbase;
  public readonly wheeltrackM: number = (VF26_CHASSIS.front.track + VF26_CHASSIS.rear.track) * 0.5;
  public readonly cgToFrontAxleM: number = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
  public readonly cgToRearAxleM: number = VF26_CHASSIS.wheelbase * VF26_CHASSIS.frontWeightFraction;
  public readonly cgHeightM: number = VF26_CG_HEIGHT_M;
  /** What the player is shown: braking line, braking urgency and HUD target speed, with crests allowed for (the AI
   * plans on its own profile) */
  public readonly brakingGuide: BrakingGuide;
  public readonly maxSteerAngleRad: number =
    (VF26_CHASSIS.steering.lockDeg / VF26_CHASSIS.steering.ratio) * DEG2RAD;
  public yawInertiaKgM2 = 0;
  private pitchInertiaKgM2 = 0;
  private rollInertiaKgM2 = 0;
  /**
   * Body outline probed against the barriers, [left, forward] from the CG (m): nose (front-wing corners), front
   * wheels, sidepods, rear wheels, tail
   */
  public readonly wallProbePoints: ReadonlyArray<readonly [number, number]> = (() => {
    const a = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
    const b = VF26_CHASSIS.wheelbase * VF26_CHASSIS.frontWeightFraction;
    const wingZ = VF26_WINGS.map((w) => w.position[2]);
    const noseZ = Math.max(a, ...wingZ) + 0.3;
    const tailZ = Math.min(-b, ...wingZ) - 0.3;
    const halfF = 0.5 * (VF26_CHASSIS.front.track + VF26_TYRES.soft.front.width);
    const halfR = 0.5 * (VF26_CHASSIS.rear.track + VF26_TYRES.soft.rear.width);
    const out: [number, number][] = [];
    for (const side of [1, -1]) {
      for (const [x, z] of [[halfF, noseZ], [halfF, a], [0.85, 0], [halfR, -b], [0.5, tailZ]] as const) out.push([side * x, z]);
    }
    return out;
  })();
  /** Barrier walls from the track GLB (`Track_Collider_Wall_*`); without them, the track data's per-sample barrier lines */
  private walls?: WallQuery;
  /** 3D surface colliders from the track GLB (`Track_Surface_Kerb`, etc.) */
  private ground?: GroundQuery;
  /**
   * The circuit's kerbs exist only as meshes (a converted circuit, `conformSurfaces`): its track samples miss some, so
   * the wheels also read the kerb colliders; elsewhere the samples' kerb profile is the kerb
   */
  private meshKerbs = false;
  private readonly wallIds = new Int32Array(256);
  private readonly wallQueryRadius = Math.max(...this.wallProbePoints.map(([x, z]) => Math.hypot(x, z))) + 0.5;

  public aeroPreset: AeroSetupPreset = 'balanced';
  private _assistPreset: DriverAssistPreset = 'semi_pro';
  public tcLevel = 5;
  public tc2Level = 6;
  public absLevel = 5;
  public liveBrakeBias: number = VF26_BRAKES.frontBias;
  public liveBrakeMigration: number = VF26_BRAKES.migrationAtFullPedal;
  public diffEntryLevel = 3;
  public diffMidLevel = 5;
  public diffExitLevel = 5;
  public diffActivePhase: DiffPhase = 'MID';
  public lastLsdTorqueNm = 0;
  public engineMap = 2;
  private userErsMode: ERSMode = 'BALANCED';
  /** The tuner's ERS setting as the player picked it (two settings share a mode, so the mode alone can't be read back) */
  private userErsLabel: 'PSH' | 'RAC' | 'BAL' | 'LIC' | 'CHR' = 'RAC';
  public tireCompound: TireCompound = 'soft';
  /** AI cars fit the tyre the weather calls for (set on cars made by `createAiPeerCar`) */
  public aiAutoTyres = false;
  /** Air temperature (°C) and road water film: the weather's, else the long-standing 27 °C dry baseline */
  private weatherSample: WeatherContactSample = { ...DRY_WEATHER_SAMPLE };
  private realism: SimRealismFlags = { ...FULL_REALISM };
  public autoGearbox = true;
  /** The controller's stick goes through the steering assist (off = raw stick to the rack); the keyboard always does */
  public gamepadAssistEnabled = true;
  /** Keyboard and controller steering assist */
  public readonly steeringAssist = new SteeringAssist();
  private readonly slipScratch = new AxleSlipScratch();
  /** The driver's last paddle shift with the auto box on, and the auto box's reading of the car */
  private readonly manualShift = new ManualShiftOverride();
  private readonly autoShiftIn = createAutoShiftInput();

  // Vehicle state (3D Cartesian world + projected curvilinear track state)
  public worldX = 0;
  public worldZ = 0;
  public worldYawRad = 0; // atan2(forward.x, forward.z)
  public sMeters = 45;
  public lateralOffsetM = 0;
  public headingErrorRad = 0; // + = nose pointed right of track tangent
  private lastSyncedSMeters = 45;
  private lastSyncedLateralOffsetM = 0;
  private lastSyncedHeadingErrorRad = 0;
  public vxMs = 0; // body-frame longitudinal velocity (m/s)
  public vyMs = 0; // body-frame lateral velocity (m/s, + = left)
  public vzMs = 0;
  public yawRateRadS = 0; // + = turning right (UI convention)
  public steerAngleNorm = 0; // [-1..1], + = right
  public frontWheelAngleRad = 0; // + = right
  public ffbTorqueNorm = 0;
  public readonly ffbSubframeSamples: number[] = [];
  public frontSlipRatioNorm = 0;
  public rearSlipRatioNorm = 0;

  // Sprung-body attitude relative to the road plane
  public pitchRad = 0; // + = nose up
  public rollRad = 0; // + = rolled toward the right (left-hand corner)
  public pitchVelRadS = 0;
  public rollVelRadS = 0;
  public rideHeightOffsetM = 0;
  private heaveM = 0;
  private heaveVelMs = 0;

  private steerRoadWheelRad = 0; // + = left (body convention)
  private lastAxMs2 = 0;
  private lastAyMs2 = 0;
  private prevShiftUp = false;
  private prevShiftDown = false;
  /** A paddle press that came while a shift was still under way: it is made once that shift is done */
  private pendingShift: -1 | 0 | 1 = 0;
  private prevToggleXMode = false;
  /** `aiAutopilot` as the last step saw it: the shell flips it between frames, so `step` acts on the change */
  private prevAiAutopilot = false;
  private tcCut = 1;
  private aiBrakeTrim = 1;
  private aiThrottleTrim = 1;
  private readonly aiDriver = new RacingLineDriver();
  private aiProfile: {
    preset: AeroSetupPreset;
    grip: number;
    trim: { front: number; rear: number };
    massKg: number;
    rho: number;
    profile: SpeedProfile;
    params: AiVehicleParams;
  } | null = null;
  private aiTargetSpeedKmh = 0;
  /** Time the AI car has been (nearly) stationary — beached or spun off */
  private aiStuckS = 0;
  private aiFrontCourseRad = 0;
  /** Low-passed cross-slope of the road plane the chassis is referenced to (rad) */
  private planeBankRad = 0;
  private absFactor: [number, number, number, number] = [1, 1, 1, 1];
  private xModeBlend = 0;
  private airDensity = 1.06;
  private gravityBody = { x: 0, y: 0, n: G };
  private verticalCurvature = 0;
  private lastFxTyres = 0;
  /** ABS release wanted per channel this step (scratch) */
  private readonly absWant = [1, 1, 1, 1];

  // Aero results (outer step) & wake / wind / track evolution states
  private aeroDownforceN = 0;
  private aeroFrontDownforceN = 0;
  private aeroRearDownforceN = 0;
  private aeroDragN = 0;
  private aeroSideCoef = 0;
  private aeroPitchMomentNm = 0;
  private groundEffectFactor = 1;
  private aeroWakeState: AeroWakeState = { ...CLEAN_AIR_WAKE_STATE };
  private trackEvolutionSample: TrackEvolutionSample = {
    gripMultiplier: 1.0,
    marbleLevel: 0,
    rubberLevel: 0.65,
    trackTempC: TRACK_SURFACE_C,
  };
  /** Wind velocity in the world (m/s, where the air moves to) */
  public windWorldXMs = 0;
  public windWorldZMs = 0;
  private readonly relAir: RelativeAirspeed = { vxAirMs: 0, vyAirMs: 0, airspeedMs: 0, airspeedSq: 0, aeroBetaRad: 0 };
  /** Aero centre of pressure as the front share of downforce (%), and the floor stall factor (0.55–1) */
  public aeroCopFrontPct = 50;
  public floorStallFactor = 1;
  /** Driver tyre setup; the camber of each axle is kept on its runtime */
  private tyreSetup: TyreSetup = defaultTyreSetup();

  private readonly wings: WingRuntime[];
  private readonly axles: [AxleRuntime, AxleRuntime];
  /** Live wishbone kinematics per axle (solved in place each step) and per corner, FR, FL, RR, RL */
  private readonly frontKin = createAxleKinematicsState();
  private readonly rearKin = createAxleKinematicsState();
  public readonly lastKinematics: readonly [
    CornerKinematicsState,
    CornerKinematicsState,
    CornerKinematicsState,
    CornerKinematicsState,
  ] = [this.frontKin.right, this.frontKin.left, this.rearKin.right, this.rearKin.left];
  private readonly torqueLut = new Lut(VF26_ENGINE.torqueCurve);
  private readonly coastLut = new Lut(VF26_ENGINE.coastCurve);
  private readonly boostLut = new Lut(VF26_ENGINE.boostCurve);
  private readonly kineticLut = new Lut(VF26_ERS.kineticTorque);
  private readonly ersControllers: Record<ErsControllerKey, ErsControllerRuntime>;
  private sprungMassKg = 0;
  private totalMassKg = 0;

  public wheels: [VehicleWheelState, VehicleWheelState, VehicleWheelState, VehicleWheelState];
  public drivetrain: DrivetrainRuntime;
  public lastObservation: RaceGymObservation;

  // Mirrors for external readers
  public rpm: number = VF26_ENGINE.idleRpm;
  public gear = 1;
  public ersEnergyJ: number = VF26_ERS.batteryJ;
  public readonly maxErsEnergyJ: number = VF26_ERS.batteryJ;
  public activeAeroMode: ActiveAeroMode = 'Z_MODE';
  public autoXMode = true;
  /** Race control for Overtake Mode (the 1 s rule); null = practice, the override is free */
  public raceControl: OvertakingRaceControl | null = null;
  /** A 2026 car: Straight Mode in every zone, Overtake Mode within 1 s at the detection point */
  public readonly overtakingRules: OvertakingRules = 'straight-mode-2026';
  private readonly overtake = new OvertakeGrant();
  public aiAutopilot = false;
  /** AI driver pace (fraction of the car's limit), line shift (m, + right) and speed ceiling (m/s) */
  public aiPaceScale = 1;
  public aiLineBiasM = 0;
  public aiSpeedCapMs = Infinity;
  /**
   * A plan to drive (`sim/ai/drive-plan.ts`): its line and its cornering-and-braking limit, handed to the racing line
   * driver as its profile instead of the one it builds itself; null keeps its own
   */
  public aiPlan: AiDrivePlan | null = null;
  private planProfileCache: { plan: AiDrivePlan; profile: SpeedProfile } | null = null;

  // Three.js world transform outputs
  public worldPosition = new THREE.Vector3();
  public worldQuaternion = new THREE.Quaternion();
  public worldVelocity = new THREE.Vector3();
  public wheelRotationRad = 0;
  /** Visual tyre state per corner (FR, FL, RR, RL), refreshed at the end of each `step()`. Read-only for consumers. */
  public readonly tyreVisuals: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState] = [
    {
      loadedRadiusM: 0,
      verticalDeflectionM: 0,
      lateralForceN: 0,
      camberRad: 0,
      contactInCar: { x: 0, y: 0, z: 0 },
      onRoad: true,
    },
    {
      loadedRadiusM: 0,
      verticalDeflectionM: 0,
      lateralForceN: 0,
      camberRad: 0,
      contactInCar: { x: 0, y: 0, z: 0 },
      onRoad: true,
    },
    {
      loadedRadiusM: 0,
      verticalDeflectionM: 0,
      lateralForceN: 0,
      camberRad: 0,
      contactInCar: { x: 0, y: 0, z: 0 },
      onRoad: true,
    },
    {
      loadedRadiusM: 0,
      verticalDeflectionM: 0,
      lateralForceN: 0,
      camberRad: 0,
      contactInCar: { x: 0, y: 0, z: 0 },
      onRoad: true,
    },
  ];

  // Lap & sector timing
  private currentLapStartMs = 0;
  private currentSectorStartMs = 0;
  private lastSector: 1 | 2 | 3 = 1;
  /** Set by a grid / flying-start reset: the next S/F crossing starts lap timing instead of completing a lap */
  private lineCrossingStartsLap = false;
  private lapValid = true;
  /**
   * Track limits: 'strict' deletes the lap the instant the car is off the track; 'judged' leaves the verdict to race
   * control (`TrackLimitsMonitor`), which calls `invalidateLap()` and holds `trackLimitsHold` while it is judging.
   */
  public trackLimitsMode: 'strict' | 'judged' = 'strict';
  public trackLimitsHold = false;
  /** Garage: wing trim on top of the aero package (deg) and the chassis offsets in force */
  private wingTrimDeg = { front: 0, rear: 0 };
  /** Garage scales on the baseline: full-pedal brake torque, closed-throttle engine braking, brake duct airflow */
  private brakePowerScale = 1;
  private engineBrakingScale = 1;
  private brakeDuctScale = { front: 1, rear: 1 };
  private chassis: ChassisSetup = { ...DEFAULT_CHASSIS_SETUP };
  private simTimeMs = 0;

  public telemetry: CarTelemetry;

  constructor(track: BuiltTrackData = getActiveTrackData()) {
    this.track = track;
    this.brakingGuide = circuitBrakingGuide(track.samples);

    this.wings = createWingRuntimes();

    const mkCtrl = (k: ErsControllerKey): ErsControllerRuntime => ({
      throttle: new Lut(VF26_ERS.modes[k].throttle),
      speed: new Lut(VF26_ERS.modes[k].speed),
      gear: new Lut(VF26_ERS.modes[k].gear),
      soc: new Lut(VF26_ERS.modes[k].soc),
      coastHarvest: VF26_ERS.modes[k].coastHarvest,
    });
    this.ersControllers = { RAC: mkCtrl('RAC'), BAL: mkCtrl('BAL'), PSH: mkCtrl('PSH'), CHR: mkCtrl('CHR') };

    const tyres = VF26_TYRES[this.tireCompound];
    const mkAxle = (
      spec: Vf26AxleSuspension,
      radius: number,
      rate: number,
      damp: number,
      isFront: boolean
    ): AxleRuntime => ({
      spec,
      hardpoints: buildDoubleWishboneHardpoints(spec.hardpoints, isFront, isFront ? 'pull_rod' : 'push_rod', {
        staticCasterTrailM: VF26_CHASSIS.steering.mechanicalTrail,
      }),
      rollCentreHeight: computeRollCentreHeight(spec, radius),
      staticSpringForce: 0,
      staticSpringDeflection: 0,
      staticTyreLoad: 0,
      tyreDamp: damp,
      camberDeg: spec.staticCamberDeg,
    });
    this.axles = [
      // Own copies of the axle specs: the garage setup changes them per car (the AI field shares the module data)
      mkAxle(structuredClone(VF26_CHASSIS.front), tyres.front.radius, tyres.front.rate, tyres.front.damp, true),
      mkAxle(structuredClone(VF26_CHASSIS.rear), tyres.rear.radius, tyres.rear.rate, tyres.rear.damp, false),
    ];

    const a = this.cgToFrontAxleM;
    const b = this.cgToRearAxleM;
    const tf = VF26_CHASSIS.front.track * 0.5;
    const tr = VF26_CHASSIS.rear.track * 0.5;
    const mkWheel = (index: WheelCornerIndex, x: number, y: number): VehicleWheelState => {
      const isFront = index < 2;
      const spec = isFront ? tyres.front : tyres.rear;
      return {
        index,
        isFront,
        isLeft: index % 2 === 1,
        staticPos: { x, y },
        worldPos: { x: 0, y: 0, z: 0 },
        zRoad: 0,
        surfaceType: 'asphalt',
        surfaceFrictionMult: 1,
        surfaceBumpM: 0,
        roadOffsetPrev: 0,
        roadOffset: 0,
        steerRad: 0,
        spinVel: 0,
        rotationRad: 0,
        fzN: 0,
        ftN: 0,
        fnN: 0,
        slipRatio: 0,
        slipAngleRad: 0,
        combinedSlipNorm: 0,
        effectiveMu: spec.dyRef,
        gripFactor: 1,
        torqueAlignNm: 0,
        rideHeight: (isFront ? VF26_CHASSIS.front : VF26_CHASSIS.rear).staticRideHeight,
        suspCompression: 0,
        suspCompressionVel: 0,
        hubZ: 0,
        hubZVel: 0,
        camberLeftRad: 0,
        brakeTorqueNm: 0,
        brakeTempC: INITIAL_BRAKE_TEMP_C,
        brakeDisc: createBrakeDiscState(INITIAL_BRAKE_TEMP_C, 'carbon-ceramic'),
        tyre: createTyreRuntime(spec, INITIAL_TYRE_TEMP_C),
        contactCentroidShiftInward: 0,
        contactCentroidShiftLeftM: 0,
        kinematicsCamberDeltaRad: 0,
        kinematicsBumpSteerRad: 0,
        casterTrailM: VF26_CHASSIS.steering.mechanicalTrail,
        scrubRadiusM: isFront ? 0.018 : 0.012,
        kpiRad: (isFront ? 11.5 : 8.0) * DEG2RAD,
      };
    };
    this.wheels = [mkWheel(0, a, -tf), mkWheel(1, a, tf), mkWheel(2, -b, -tr), mkWheel(3, -b, tr)];
    this.updateTyreVisuals();

    this.drivetrain = this.createDrivetrain();
    this.recomputeMassProperties();
    this.telemetry = this.createInitialTelemetry();
    this.lastObservation = this.buildObservation(this.track.getSampleAtDistance(35));
    this.resetToStartGrid(false);
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  public getTelemetry(): CarTelemetry {
    return this.telemetry;
  }

  public setAssistPreset(preset: DriverAssistPreset): void {
    this.assistPreset = preset;
  }

  public setAeroWakeState(wake: AeroWakeState): void {
    this.lastWake = wake;
    this.aeroWakeState = withDamage(wake, this.damage) ?? wake;
  }

  /** Damage (car-damage.ts): on the VF26 model the aero loss only, through the wake multipliers */
  public setDamageEffects(effects: Readonly<CarDamageEffects> | null): void {
    this.damage = effects;
    if (this.lastWake) this.aeroWakeState = withDamage(this.lastWake, effects) ?? this.lastWake;
  }
  private lastWake: AeroWakeState | null = null;
  private damage: Readonly<CarDamageEffects> | null = null;
  /** The car puts itself back on the line when stuck (off in a race: the field rejoins its cars) */
  public aiSelfRecovery = true;

  public setTrackEvolutionSample(sample: TrackEvolutionSample): void {
    if (!Number.isFinite(sample.gripMultiplier) || !Number.isFinite(sample.trackTempC)) return;
    this.trackEvolutionSample = sample;
  }

  /** The weather under the car: the water reaches each tyre, the air temperature the tyre and brake cooling */
  public setWeatherSample(sample: WeatherContactSample): void {
    if (![sample.waterMm, sample.wetness, sample.ambientC].every(Number.isFinite)) return;
    this.weatherSample = sample;
    if (Number.isFinite(sample.windVxMs)) this.windWorldXMs = sample.windVxMs!;
    if (Number.isFinite(sample.windVzMs)) this.windWorldZMs = sample.windVzMs!;
    for (const w of this.wheels) {
      const wheelWater = sample.wheelWaterMm?.[w.index] ?? sample.waterMm;
      w.tyre.waterMm = Math.max(0, Number.isFinite(wheelWater) ? wheelWater : sample.waterMm);
      w.tyre.wetness = Math.min(1, Math.max(0, sample.wheelWaterMm ? wetnessFromWater(w.tyre.waterMm) : sample.wetness));
    }
  }

  /** Simulation realism: tyre wear, temperature grip, fuel use and wet severity */
  public setSimRealism(flags: SimRealismFlags): void {
    this.realism = { ...flags };
    for (const w of this.wheels) {
      w.tyre.wetSeverity = flags.wetSeverity;
      w.tyre.wearScale = flags.tyreWearScale;
      w.tyre.thermalGripScale = flags.thermalGripScale;
    }
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
    // Move in the world, then re-project so the curvilinear pose (which step() trusts) agrees
    this.worldX += posDeltaX;
    this.worldZ += posDeltaZ;
    const projected = this.track.projectWorldToTrack(this.worldX, this.worldZ, this.sMeters);
    this.sMeters = projected.s;
    this.lateralOffsetM = projected.lateralOffset;
    const tangent = projected.sample.tangent;
    const headingErr = Math.atan2(tangent.x, tangent.z) - this.worldYawRad;
    this.headingErrorRad = Math.atan2(Math.sin(headingErr), Math.cos(headingErr));
    this.lastSyncedSMeters = this.sMeters;
    this.lastSyncedLateralOffsetM = this.lateralOffsetM;
    this.lastSyncedHeadingErrorRad = this.headingErrorRad;
    // World (X, Z) velocity into the body frame: forward (sin ψ, cos ψ), left (cos ψ, −sin ψ)
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    this.vxMs += velDeltaX * sinYaw + velDeltaZ * cosYaw;
    this.vyMs += velDeltaX * cosYaw - velDeltaZ * sinYaw;
    // yawRateRadS is + turning right, the delta + counter-clockwise (left)
    this.yawRateRadS -= yawRateDeltaRadS;
  }

  /**
   * Simulated time not yet stepped (s, under one 2 ms step). The pose is that far behind the frame: the renderer
   * carries it forward by this much so the car doesn't judder when the display rate isn't a multiple of 500 Hz.
   */
  get renderLeadS(): number {
    return this.timeAccumulator;
  }

  get assistPreset(): DriverAssistPreset {
    return this._assistPreset;
  }

  set assistPreset(preset: DriverAssistPreset) {
    this._assistPreset = preset;
    if (preset === 'pro') {
      this.tcLevel = 0;
      this.tc2Level = 6;
      this.absLevel = 0;
    } else if (preset === 'semi_pro') {
      this.tcLevel = 5;
      this.tc2Level = 6;
      this.absLevel = 5;
    } else {
      this.tcLevel = 8;
      this.tc2Level = 9;
      this.absLevel = 9;
    }
  }

  public getMgukGearClipFraction(): number {
    const g = this.drivetrain.gear;
    if (g <= 0) return 0;
    return THREE.MathUtils.clamp(this.ersController().ctrl.gear.evaluate(g), 0, 1);
  }

  public getLiveTunerState(): LiveTunerState {
    // The setting the player picked, not the mode running now (an override or the autopilot's own choice): the tuner
    // steps from what it reads back, and LIC / CHR and BAL / RAC share a mode
    const ersLabel = this.userErsLabel;
    return {
      tcLevel: this.tcLevel,
      tc2Level: this.tc2Level,
      absLevel: this.absLevel,
      brakeBiasPct: Number((this.liveBrakeBias * 100).toFixed(1)),
      brakeMigrationPct: Number((this.liveBrakeMigration * 100).toFixed(1)),
      diffEntry: this.diffEntryLevel,
      diffMid: this.diffMidLevel,
      diffExit: this.diffExitLevel,
      diffActivePhase: this.diffActivePhase,
      diffLockingTorqueNm: Math.round(this.lastLsdTorqueNm),
      engineMap: this.engineMap,
      ersMode: ersLabel,
      hasErs: true,
      tcCutFraction: Number(Math.max(0, 1 - this.tcCut).toFixed(3)),
      // Order: [FL, FR, RL, RR] = [wheels[1], wheels[0], wheels[3], wheels[2]]
      absCutPerWheel: [
        Number(Math.max(0, 1 - this.absFactor[1]).toFixed(3)),
        Number(Math.max(0, 1 - this.absFactor[0]).toFixed(3)),
        Number(Math.max(0, 1 - this.absFactor[3]).toFixed(3)),
        Number(Math.max(0, 1 - this.absFactor[2]).toFixed(3)),
      ],
      mgukGearClipFraction: Number(this.getMgukGearClipFraction().toFixed(3)),
    };
  }

  public setLiveTuner(patch: LiveTunerPatch): void {
    if (patch.tcLevel !== undefined) {
      this.tcLevel = THREE.MathUtils.clamp(Math.round(patch.tcLevel), 0, 12);
    }
    if (patch.tc2Level !== undefined) {
      this.tc2Level = THREE.MathUtils.clamp(Math.round(patch.tc2Level), 1, 12);
    }
    if (patch.absLevel !== undefined) {
      this.absLevel = THREE.MathUtils.clamp(Math.round(patch.absLevel), 0, 12);
    }
    if (patch.brakeBiasPct !== undefined) {
      this.liveBrakeBias = THREE.MathUtils.clamp(patch.brakeBiasPct / 100, 0.45, 0.78);
    }
    if (patch.brakeMigrationPct !== undefined) {
      this.liveBrakeMigration = THREE.MathUtils.clamp(patch.brakeMigrationPct / 100, 0, 0.06);
    }
    if (patch.diffEntry !== undefined) {
      this.diffEntryLevel = THREE.MathUtils.clamp(Math.round(patch.diffEntry), 1, 12);
    }
    if (patch.diffMid !== undefined) {
      this.diffMidLevel = THREE.MathUtils.clamp(Math.round(patch.diffMid), 1, 12);
    }
    if (patch.diffExit !== undefined) {
      this.diffExitLevel = THREE.MathUtils.clamp(Math.round(patch.diffExit), 1, 12);
    }
    if (patch.engineMap !== undefined) {
      this.engineMap = THREE.MathUtils.clamp(Math.round(patch.engineMap), 1, 5);
    }
    if (patch.ersMode !== undefined) {
      const m = patch.ersMode;
      if (m === 'PSH') this.userErsMode = 'HOTLAP';
      else if (m === 'CHR' || m === 'LIC') this.userErsMode = 'HARVEST';
      else this.userErsMode = 'BALANCED';
      this.userErsLabel = m === 'PSH' || m === 'BAL' || m === 'LIC' || m === 'CHR' ? m : 'RAC';
      if (this.drivetrain.boostRemainingS <= 0) {
        this.drivetrain.ersMode = this.userErsMode;
      }
    }
    this.telemetry.liveTuner = this.getLiveTunerState();
  }

  /** Current tyre setup: cold pressures (psi) and static camber (deg) per axle */
  public getTyreSetup(): TyreSetup {
    return {
      coldPressurePsi: { ...this.tyreSetup.coldPressurePsi },
      camberDeg: { front: this.axles[0].camberDeg, rear: this.axles[1].camberDeg },
    };
  }

  public getChassisSetup(): ChassisSetup {
    return { ...this.chassis };
  }

  /** Garage chassis setup, as offsets from the VF26 baseline; springs, bars, dampers and ride height act at once */
  public applyChassisSetup(setup: ChassisSetup): void {
    const s = clampChassisSetup(setup);
    // A new fuel load is put in the car now (and at every restart); other changes leave the fuel burnt so far
    if (s.fuelDeltaKg !== this.chassis.fuelDeltaKg) {
      this.drivetrain.fuelKg = startingFuelKg('vf26', s);
      this.telemetry.fuelKg = this.drivetrain.fuelKg;
    }
    this.chassis = s;
    this.wingTrimDeg = { front: s.frontWingClicks * WING_CLICK_DEG.vf26.front, rear: s.rearWingClicks * WING_CLICK_DEG.vf26.rear };
    const bases = [VF26_CHASSIS.front, VF26_CHASSIS.rear] as const;
    this.axles.forEach((ax, i) => {
      const b = bases[i];
      const front = i === 0;
      const spec = ax.spec;
      spec.springRate = b.springRate * pctScale(front ? s.springFrontPct : s.springRearPct);
      spec.arbRate = b.arbRate * pctScale(front ? s.arbFrontPct : s.arbRearPct);
      spec.damper.bumpSlow = b.damper.bumpSlow * pctScale(front ? s.bumpFrontPct : s.bumpRearPct);
      spec.damper.bumpFast = b.damper.bumpFast * pctScale(front ? s.fastBumpFrontPct : s.fastBumpRearPct);
      spec.damper.reboundSlow = b.damper.reboundSlow * pctScale(front ? s.reboundFrontPct : s.reboundRearPct);
      spec.damper.reboundFast = b.damper.reboundFast * pctScale(front ? s.fastReboundFrontPct : s.fastReboundRearPct);
      spec.staticToeDeg = b.staticToeDeg + (front ? s.toeFrontDeg : s.toeRearDeg);
      spec.staticRideHeight = b.staticRideHeight + (front ? s.rideHeightFrontMm : s.rideHeightRearMm) / 1000;
    });
    this.brakePowerScale = pctScale(s.brakePowerPct);
    this.engineBrakingScale = pctScale(s.engineBrakingPct);
    this.brakeDuctScale = { front: Math.max(0.3, 1 + s.brakeDuctFront * BRAKE_DUCT_STEP), rear: Math.max(0.3, 1 + s.brakeDuctRear * BRAKE_DUCT_STEP) };
    // Static spring deflections follow the new rates
    this.recomputeMassProperties();
  }

  /**
   * Sets the tyre setup, clamped to `VF26_TYRE_SETUP_RANGES` (cold pressures 14–27 psi to 0.1 psi, front camber
   * −4.5…−1.5°, rear camber −3.0…−0.5°). A non-finite value keeps the current setting.
   */
  public setTyreSetup(setup: TyreSetup): void {
    const pick = (v: number, [lo, hi]: [number, number], current: number) =>
      Number.isFinite(v) ? THREE.MathUtils.clamp(v, lo, hi) : current;
    const ranges = VF26_TYRE_SETUP_RANGES;
    const cp = this.tyreSetup.coldPressurePsi;
    for (const k of ["fl", "fr", "rl", "rr"] as const) {
      cp[k] = Math.round(pick(setup.coldPressurePsi[k], ranges.coldPsiRange, cp[k]) * 10) / 10;
    }
    this.axles[0].camberDeg = pick(setup.camberDeg.front, ranges.frontCamberRange, this.axles[0].camberDeg);
    this.axles[1].camberDeg = pick(setup.camberDeg.rear, ranges.rearCamberRange, this.axles[1].camberDeg);
    this.applyColdPressures();
  }

  /** 2026 Overtake Mode: full MGU-K deployment sustained to 337 km/h for 8 s; in a race only once earned within 1 s */
  public activateBoostOverride(): boolean {
    const dt = this.drivetrain;
    if (this.overtake.available(this.raceControl) && dt.ersEnergyJ > 200_000 && dt.boostCooldownS <= 0) {
      dt.ersMode = 'OVERRIDE';
      dt.boostRemainingS = 8.0;
      return true;
    }
    return false;
  }

  /**
   * Places the car on the start grid (`gridSlot` 0 = pole) for a standing start, or on the run-up
   * of the main straight for a flying lap (further slots queue up 28 m apart, alternating sides).
   */
  public resetToStartGrid(flyingStart = false, gridSlot = 0): void {
    const lapLen = this.track.totalLengthM;
    let flyingGear = 7;
    if (flyingStart) {
      // Run-up from the final straight (`flyingStartPoint`) on the racing line; timing starts at the line. It starts
      // no faster than 90 % of the speed the circuit's braking profile allows there, nor than it carries out of the
      // last corner, in the gear for that speed
      const start = flyingStartPoint(this.track);
      const s = (start.s - gridSlot * 28 + lapLen) % lapLen;
      const smp = this.track.getSampleAtDistance(s);
      const edge = Math.max(0, smp.width / 2 - 1.2);
      const stagger = gridSlot === 0 ? 0 : gridSlot % 2 === 1 ? -2.6 : 2.6;
      const lateral = THREE.MathUtils.clamp(aiLineOffsetM(smp) + stagger, -edge, edge);
      let speed = Math.min(75, (0.9 * (smp.brakeLimitKmh ?? smp.optimalSpeedKmh)) / 3.6);
      if (start.cornerS !== null) {
        const corner = (0.9 * this.track.getSampleAtDistance(start.cornerS).optimalSpeedKmh) / 3.6;
        speed = Math.min(speed, flyingExitSpeedMs(corner, (s - start.cornerS + lapLen) % lapLen));
      }
      this.placeCar(s, speed, lateral);
      if (speed < 75) flyingGear = this.selectGearForSpeed(speed);
    } else {
      // Exported grid slot (behind the S/F line, staggered left / right)
      const grid = this.track.spawnGrid;
      const slot = grid[Math.min(gridSlot, grid.length - 1)];
      this.placeCar(slot ? slot.s : lapLen - 12 - gridSlot * 8, 0, slot ? slot.lateral : 0);
    }
    this.activeAeroMode = flyingStart ? 'X_MODE' : 'Z_MODE';
    this.xModeBlend = flyingStart ? 1 : 0;
    // A restart hands Straight Mode back to the automatic rule, as at the first start
    this.autoXMode = true;
    this.drivetrain = this.createDrivetrain();
    // The ERS setting the player picked in the tuner, not the fresh drivetrain's default
    this.drivetrain.ersMode = this.userErsMode;
    // A fresh tank of the garage's fuel load: its mass and readout from the first frame
    this.recomputeMassProperties();
    this.telemetry.fuelKg = this.drivetrain.fuelKg;
    this.drivetrain.gear = flyingStart ? flyingGear : 1;
    this.drivetrain.shiftTarget = this.drivetrain.gear;
    this.syncDrivetrainToRoadSpeed();
    this.ersEnergyJ = this.drivetrain.ersEnergyJ;
    this.simTimeMs = 0;
    this.currentLapStartMs = 0;
    this.currentSectorStartMs = 0;
    this.lapValid = true;
    this.lineCrossingStartsLap = true;
    this.settleSuspension();
    this.finishPlacement();
  }

  /** The track collider the car drives on (null on the track samples' ground), for the rigs to seat the wheels on */
  public get groundQuery(): GroundQuery | null {
    return this.ground ?? null;
  }

  public readonly vehicleId = 'vf26' as const;
  public readonly racingLineId = 'f1' as const;

  public createAiPeerCar(): F1Physics2026 {
    const peer = new F1Physics2026(this.track);
    peer.aiAutoTyres = true;
    if (this.walls) peer.setWalls(this.walls);
    if (this.ground) peer.ground = this.ground;
    peer.meshKerbs = this.meshKerbs;
    return peer;
  }

  public teleportToDistance(sMeters: number, speedMs = 0, lateral = 0): void {
    this.lineCrossingStartsLap = false;
    // Moved mid-lap (corner practice, a stuck-car rescue): the lap under way can't count
    this.invalidateLap();
    const wrapped = ((sMeters % this.track.totalLengthM) + this.track.totalLengthM) % this.track.totalLengthM;
    // The car moves, its tyres don't get swapped: the set keeps its wear and damage (only the grid fits a fresh set)
    const worn = this.wheels.map((w) => tyreWearState(w.tyre));
    this.placeCar(wrapped, Math.max(0, speedMs), lateral);
    this.wheels.forEach((w, i) => restoreTyreWear(w.tyre, worn[i]));
    const dt = this.drivetrain;
    dt.gear = this.selectGearForSpeed(this.vxMs);
    dt.shiftTarget = dt.gear;
    dt.shiftTimerS = 0;
    this.syncDrivetrainToRoadSpeed();
    this.settleSuspension();
    this.finishPlacement();
  }

  /** Flashback: back at a replayed pose (heading included), rolling at its speed, with the tyres and brakes as they are */
  public restorePose(pose: { x: number; z: number; yawRad: number; speedMs: number; s?: number }): void {
    const p = this.track.projectWorldToTrack(pose.x, pose.z, pose.s ?? this.sMeters);
    const speedMs = Math.max(0, pose.speedMs);
    const tangent = this.track.getSampleAtDistance(p.s).tangent;
    const trackHeadingRad = Math.atan2(tangent.x, tangent.z);
    this.lineCrossingStartsLap = false;
    // A flashback moves the car mid-lap: the lap under way can't count
    this.invalidateLap();
    this.timeAccumulator = 0;
    this.sMeters = p.s;
    this.lateralOffsetM = p.lateralOffset;
    this.headingErrorRad = Math.atan2(Math.sin(trackHeadingRad - pose.yawRad), Math.cos(trackHeadingRad - pose.yawRad));
    this.vxMs = speedMs;
    this.vyMs = 0;
    this.vzMs = 0;
    this.yawRateRadS = 0;
    this.lastAxMs2 = 0;
    this.lastAyMs2 = 0;
    this.steerAngleNorm = 0;
    this.frontWheelAngleRad = 0;
    this.steerRoadWheelRad = 0;
    this.ffbTorqueNorm = 0;
    this.ffbSubframeSamples.length = 0;
    this.pitchRad = 0;
    this.rollRad = 0;
    this.pitchVelRadS = 0;
    this.rollVelRadS = 0;
    this.heaveM = 0;
    this.heaveVelMs = 0;
    this.tcCut = 1;
    this.absFactor = [1, 1, 1, 1];
    this.steeringAssist.reset();
    for (const w of this.wheels) {
      w.spinVel = speedMs / w.tyre.spec.radius;
      w.tyre.deflX = 0;
      w.tyre.deflY = 0;
      w.hubZ = 0;
      w.hubZVel = 0;
      w.slipRatio = 0;
      w.slipAngleRad = 0;
      w.combinedSlipNorm = 0;
      w.steerRad = 0;
    }
    this.syncCartesianFromCurvilinear();
    const dt = this.drivetrain;
    dt.gear = this.selectGearForSpeed(speedMs);
    dt.shiftTarget = dt.gear;
    dt.shiftTimerS = 0;
    this.syncDrivetrainToRoadSpeed();
    this.settleSuspension();
    this.finishPlacement();
  }

  public teleportToTurn(turnNumber: number): void {
    const idx = this.track.samples.findIndex((s) => s.turnNumber === turnNumber);
    const target = idx >= 0 ? this.track.samples[(idx + 2) % this.track.samples.length] : this.track.samples[0];
    const plan = this.getAiPlan().profile;
    const L = this.track.totalLengthM;
    const at = (values: Float64Array, s: number) => sampleProfile(values, s, L);
    // A little under the braking-aware plan's speed there (the sample's corner speed ignores the braking already
    // due): dropped in at the limit with no time to settle, the car runs wide at turn-in
    const speedMs = Math.min(62, target.optimalSpeedKmh / 3.6, 0.92 * at(plan.speedMs, target.s));
    this.teleportToDistance(target.s, speedMs);
    // On the line, heading along it and turning with it: square to the centreline where the line crosses the track
    // (0.2 rad at Shanghai's T6), the car could not catch the corner and ran off
    this.lateralOffsetM = at(plan.lineOffsetM, target.s);
    this.headingErrorRad = Math.atan((at(plan.lineOffsetM, target.s + 2.5) - at(plan.lineOffsetM, target.s - 2.5)) / 5);
    this.yawRateRadS = speedMs * at(plan.curvature, target.s);
    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
  }

  /** Collide with the loaded track GLB's barrier walls (`Track_Collider_Wall_*`) and 3D kerb surfaces (`Track_Surface_Kerb`) */
  public attachTrackRoot(root: THREE.Object3D): void {
    const { ground, walls, conformSurfaces } = trackColliders(root);
    this.setWalls(walls.segments.length > 0 ? walls : undefined);
    this.ground = ground ?? undefined;
    this.meshKerbs = conformSurfaces && ground !== null;
    this.syncWorldTransform();
    this.updateTyreVisuals();
  }

  /** Barrier walls to collide with; none = the track data's per-sample barrier lines */
  public setWalls(walls: WallQuery | undefined): void {
    this.walls = walls;
  }

  /**
   * Main frame entry point. Accumulates the frame delta and steps the solver at a strict
   * fixed 500 Hz, completely decoupled from render FPS.
   */
  public step(dtSeconds: number, rawInputs: Partial<ControlInputs>): CarTelemetry {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return this.telemetry;
    }

    // If the caller moved the car directly along the track, rebuild the Cartesian pose
    if (
      this.sMeters !== this.lastSyncedSMeters ||
      this.lateralOffsetM !== this.lastSyncedLateralOffsetM ||
      this.headingErrorRad !== this.lastSyncedHeadingErrorRad
    ) {
      this.syncCartesianFromCurvilinear();
    }

    this.applyCompound();

    // A hitch up to MAX_CATCH_UP_S is caught up in full (the car must not drop into slow motion); longer stalls
    // (a hidden tab, a debugger) are not
    this.timeAccumulator += Math.min(dtSeconds, F1Physics2026.MAX_CATCH_UP_S);

    const inputs: ControlInputs = {
      throttle: THREE.MathUtils.clamp(rawInputs.throttle ?? 0, 0, 1),
      brake: THREE.MathUtils.clamp(rawInputs.brake ?? 0, 0, 1),
      steerLeft: THREE.MathUtils.clamp(rawInputs.steerLeft ?? 0, 0, 1),
      steerRight: THREE.MathUtils.clamp(rawInputs.steerRight ?? 0, 0, 1),
      analogSteer:
        rawInputs.analogSteer !== undefined ? THREE.MathUtils.clamp(rawInputs.analogSteer, -1, 1) : undefined,
      padSteer: rawInputs.padSteer !== undefined ? THREE.MathUtils.clamp(rawInputs.padSteer, -1, 1) : undefined,
      kbSteer: rawInputs.kbSteer !== undefined ? Math.sign(rawInputs.kbSteer) : undefined,
      clutch: rawInputs.clutch,
      manualOverride: Boolean(rawInputs.manualOverride),
      toggleXMode: Boolean(rawInputs.toggleXMode),
      shiftUp: Boolean(rawInputs.shiftUp),
      shiftDown: Boolean(rawInputs.shiftDown),
    };

    if (this.aiAutopilot !== this.prevAiAutopilot) {
      this.prevAiAutopilot = this.aiAutopilot;
      if (this.aiAutopilot) this.onAutopilotEngaged();
      else this.onAutopilotReleased();
    }
    if (inputs.toggleXMode && !this.prevToggleXMode) {
      this.autoXMode = false;
      this.activeAeroMode = this.activeAeroMode === 'Z_MODE' ? 'X_MODE' : 'Z_MODE';
    }
    this.prevToggleXMode = inputs.toggleXMode;
    // In a race the override (Overtake Mode) is only there once earned at the detection point
    if (!this.overtake.available(this.raceControl)) {
      inputs.manualOverride = false;
      const drv = this.drivetrain;
      if (drv.boostRemainingS > 0) drv.boostRemainingS = 0;
      if (drv.ersMode === 'OVERRIDE') drv.ersMode = this.userErsMode;
    }
    const progressBefore = this.sMeters / this.track.totalLengthM;

    let shiftReq: -1 | 0 | 1 = 0;
    if (inputs.shiftUp && !this.prevShiftUp) shiftReq = 1;
    else if (inputs.shiftDown && !this.prevShiftDown) shiftReq = -1;
    this.prevShiftUp = inputs.shiftUp;
    this.prevShiftDown = inputs.shiftDown;

    this.ffbSubframeSamples.length = 0;
    let stepsRun = 0;
    while (this.timeAccumulator >= F1Physics2026.FIXED_DT && stepsRun < F1Physics2026.MAX_STEPS_PER_CALL) {
      this.outerStep(F1Physics2026.FIXED_DT, inputs, stepsRun === 0 ? shiftReq : 0);
      this.timeAccumulator -= F1Physics2026.FIXED_DT;
      this.simTimeMs += F1Physics2026.FIXED_DT * 1000;
      stepsRun++;
    }
    if (stepsRun === 0 && dtSeconds < F1Physics2026.FIXED_DT) {
      // A frame shorter than one step: simulate everything owed, the remainder left by earlier frames included
      const h = this.timeAccumulator;
      this.outerStep(h, inputs, shiftReq);
      this.simTimeMs += h * 1000;
      this.timeAccumulator = 0;
    }

    this.overtake.observe(progressBefore, this.sMeters / this.track.totalLengthM, RWANDA_DRS_ZONES, this.raceControl);
    this.syncWorldTransform();
    this.recoverStuckAi(dtSeconds);
    const currentSample = this.track.getSampleAtDistance(this.sMeters);
    this.lastObservation = this.buildObservation(currentSample);
    this.updateTelemetrySnapshot(currentSample, inputs);
    this.updateTyreVisuals();
    return this.telemetry;
  }

  /** The autopilot takes the car: its driver starts from what the car is doing now, not from its last drive */
  private onAutopilotEngaged(): void {
    this.aiDriver.reset();
    this.aiBrakeTrim = 1;
    this.aiThrottleTrim = 1;
    this.aiFrontCourseRad = Math.atan2(this.vyMs - this.yawRateRadS * this.cgToFrontAxleM, Math.max(3, this.vxMs));
  }

  /**
   * The player takes the car back: the ERS mode the player picked instead of the AI's, and Straight Mode shut (the
   * automatic rule opens it again at once where it applies; a manual player opens it themselves)
   */
  private onAutopilotReleased(): void {
    const drv = this.drivetrain;
    if (drv.boostRemainingS <= 0) drv.ersMode = this.userErsMode;
    this.activeAeroMode = 'Z_MODE';
  }

  /** Copies the last sub-step's tyre state into `tyreVisuals` (no physics state is written) */
  private updateTyreVisuals(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    const carUp = this.localRoadUp(sample);
    const invUpY = 1 / Math.max(0.5, carUp.y);
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const out = this.tyreVisuals[i];
      out.loadedRadiusM = tyreLoadedRadius(w.tyre, w.fzN);
      out.verticalDeflectionM = tyreVerticalDeflection(w.tyre, w.fzN);
      out.lateralForceN = w.fnN;
      out.camberRad = w.camberLeftRad;
      // The tyre model's carcass states, held at the grip peak's once the tyre slides
      const elastic = 1 / Math.max(1, w.combinedSlipNorm);
      out.carcassDeflectionXM = w.tyre.deflX * elastic;
      out.carcassDeflectionYM = w.tyre.deflY * elastic;
      const c = out.contactInCar!;
      c.x = w.staticPos.y;
      c.z = w.staticPos.x;
      c.y = this.wheelContactInCar(w, invUpY);
    }
  }

  /**
   * Car-frame height (m) of the road under a wheel: the track collider there when the car has one (the car frame
   * sits on it, `syncWorldTransform`), else the wheel's own road and kerb bump. The rigs seat the drawn wheels from it.
   */
  private wheelContactInCar(w: VehicleWheelState, invUpY: number): number {
    if (!this.ground) return (w.zRoad + w.surfaceBumpM - w.worldPos.y) * invUpY;
    // The wheel's point on the car frame's origin plane
    const e = _basis.makeRotationFromQuaternion(this.worldQuaternion).elements;
    const x = w.staticPos.y;
    const z = w.staticPos.x;
    const px = this.worldPosition.x + e[0] * x + e[8] * z;
    const py = this.worldPosition.y + e[1] * x + e[9] * z;
    const pz = this.worldPosition.z + e[2] * x + e[10] * z;
    const roadY = this.ground.query(px, pz, py + 0.6, _groundHit) ? _groundHit.height : w.zRoad + w.surfaceBumpM;
    return (roadY - py) * invUpY;
  }

  /**
   * Autopilot only: a car stopped for 3 s (beached, spun into the barrier), or crawling the wrong way after a spin
   * (the line follower cannot turn it round), is put back on the AI line
   */
  private recoverStuckAi(dtSeconds: number): void {
    if (!this.aiAutopilot || !this.aiSelfRecovery) {
      this.aiStuckS = 0;
      return;
    }
    const speed = Math.hypot(this.vxMs, this.vyMs);
    const wrongWay = Math.abs(Math.atan2(Math.sin(this.headingErrorRad), Math.cos(this.headingErrorRad))) > 1.8;
    this.aiStuckS = speed < 2 || (wrongWay && speed < 20) ? this.aiStuckS + Math.min(dtSeconds, 0.05) : 0;
    if (this.aiStuckS < 3) return;
    this.aiStuckS = 0;
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.teleportToDistance(this.sMeters, Math.min(15, sample.optimalSpeedKmh / 3.6));
    this.lateralOffsetM = aiLineOffsetM(sample);
    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
  }

  // ===========================================================================
  // Setup / placement helpers
  // ===========================================================================

  private createDrivetrain(): DrivetrainRuntime {
    return {
      gear: 1,
      shiftTarget: 1,
      shiftTimerS: 0,
      autoShiftCooldownS: 0,
      engineOmega: VF26_ENGINE.idleRpm * RPM2RADS,
      clutchLocked: false,
      clutchEngagement: 0,
      launchPedal: 0,
      launchSlipS: 0,
      boostBar: 0,
      iceTorqueNm: 0,
      mgukTorqueNm: 0,
      mgukPowerW: 0,
      harvestAxleTorqueNm: 0,
      limiterCut: false,
      fuelKg: startingFuelKg('vf26', this.chassis),
      ersMode: 'BALANCED',
      ersEnergyJ: VF26_ERS.batteryJ,
      boostRemainingS: 0,
      boostCooldownS: 0,
      diffLockedFraction: 0,
    };
  }

  private recomputeMassProperties(): void {
    const fuel = this.drivetrain.fuelKg;
    const m = VF26_CHASSIS.totalMassKg + fuel;
    this.totalMassKg = m;
    const unsprung = 2 * VF26_CHASSIS.front.unsprungMassKg + 2 * VF26_CHASSIS.rear.unsprungMassKg;
    this.sprungMassKg = m - unsprung;
    const box = VF26_CHASSIS.inertiaBox;
    // Principal moments of inertia of a uniform box of the car's mass
    this.yawInertiaKgM2 = (m * (box.width ** 2 + box.length ** 2)) / 12;
    this.pitchInertiaKgM2 = (m * (box.height ** 2 + box.length ** 2)) / 12;
    this.rollInertiaKgM2 = (m * (box.width ** 2 + box.height ** 2)) / 12;

    const weight = m * G;
    const frontAxleLoad = weight * VF26_CHASSIS.frontWeightFraction;
    const rearAxleLoad = weight - frontAxleLoad;
    const setAxle = (ax: AxleRuntime, axleLoad: number) => {
      ax.staticTyreLoad = axleLoad * 0.5;
      ax.staticSpringForce = ax.staticTyreLoad - ax.spec.unsprungMassKg * G;
      ax.staticSpringDeflection = ax.staticSpringForce / ax.spec.springRate;
    };
    setAxle(this.axles[0], frontAxleLoad);
    setAxle(this.axles[1], rearAxleLoad);
  }

  private applyCompound(): void {
    const set = VF26_TYRES[this.tireCompound];
    for (const w of this.wheels) {
      const targetSpec = w.isFront ? set.front : set.rear;
      if (w.tyre.spec !== targetSpec) {
        const newShift = targetSpec.wet?.tempShiftC ?? 0;
        setTyreSpec(w.tyre, targetSpec);
        // Another compound is a new set off the blankets: no wear, flat spots or graining carried over from the
        // old one (that used to depend on whether the wet temperature shift happened to change)
        setTyreTemperature(w.tyre, INITIAL_TYRE_TEMP_C + 0.55 * newShift);
        w.tyre.wear = 0;
      }
    }
    this.applyColdPressures();
    this.axles[0].tyreDamp = set.front.damp;
    this.axles[1].tyreDamp = set.rear.damp;
  }

  /** Pushes the setup's cold pressures into each tyre (the hot pressure follows the ideal gas law) */
  private applyColdPressures(): void {
    for (const w of this.wheels) {
      const psi = pressureAt(this.tyreSetup.coldPressurePsi, w.isFront, w.isLeft);
      if (w.tyre.coldPressurePsi !== psi) setTyreColdPressure(w.tyre, psi);
    }
  }

  private placeCar(s: number, speedMs: number, lateralOffset: number): void {
    this.timeAccumulator = 0;
    this.sMeters = s;
    this.lateralOffsetM = lateralOffset;
    this.headingErrorRad = 0;
    this.vxMs = speedMs;
    this.vyMs = 0;
    this.vzMs = 0;
    this.yawRateRadS = 0;
    this.lastAxMs2 = 0;
    this.lastAyMs2 = 0;
    this.steerAngleNorm = 0;
    this.frontWheelAngleRad = 0;
    this.steerRoadWheelRad = 0;
    this.ffbTorqueNorm = 0;
    this.ffbSubframeSamples.length = 0;
    this.aeroWakeState = { ...CLEAN_AIR_WAKE_STATE };
    this.pitchRad = 0;
    this.rollRad = 0;
    this.pitchVelRadS = 0;
    this.rollVelRadS = 0;
    this.heaveM = 0;
    this.heaveVelMs = 0;
    this.tcCut = 1;
    this.absFactor = [1, 1, 1, 1];
    this.aiDriver.reset();
    this.steeringAssist.reset();
    this.aiFrontCourseRad = 0;
    this.aiBrakeTrim = 1;
    this.aiThrottleTrim = 1;
    this.lastFxTyres = 0;
    this.applyCompound();
    for (const w of this.wheels) {
      const r = w.tyre.spec.radius;
      const blanketTempC = INITIAL_TYRE_TEMP_C + 0.55 * (w.tyre.spec.wet?.tempShiftC ?? 0);
      setTyreTemperature(w.tyre, blanketTempC);
      w.spinVel = speedMs / r;
      w.tyre.deflX = 0;
      w.tyre.deflY = 0;
      w.hubZ = 0;
      w.hubZVel = 0;
      w.slipRatio = 0;
      w.slipAngleRad = 0;
      w.combinedSlipNorm = 0;
      w.steerRad = 0;
      w.brakeTempC = INITIAL_BRAKE_TEMP_C;
      resetBrakeDiscState(w.brakeDisc, INITIAL_BRAKE_TEMP_C, 'carbon-ceramic');
    }
    this.applyColdPressures();
    this.recomputeMassProperties();
    this.syncCartesianFromCurvilinear();
  }

  private finishPlacement(): void {
    this.overtake.reset();
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.manualShift.clear();
    this.pendingShift = 0;
    this.drivetrain.autoShiftCooldownS = 0;
    this.lastSector = sample.sector;
    this.syncWorldTransform();
    this.updateWheelWorldPositions(sample);
    this.lastObservation = this.buildObservation(sample);
    this.gear = this.drivetrain.gear;
    this.rpm = this.drivetrain.engineOmega * RADS2RPM;
    this.ersEnergyJ = this.drivetrain.ersEnergyJ;
    this.updateTelemetrySnapshot(sample, {
      throttle: 0,
      brake: 0,
      steerLeft: 0,
      steerRight: 0,
      manualOverride: false,
      toggleXMode: false,
      shiftUp: false,
      shiftDown: false,
    });
    this.updateTyreVisuals();
  }

  private overallRatio(gear: number): number {
    if (gear >= 1 && gear <= VF26_DRIVETRAIN.gearRatios.length) {
      return VF26_DRIVETRAIN.gearRatios[gear - 1] * VF26_DRIVETRAIN.finalDrive;
    }
    if (gear === -1) return VF26_DRIVETRAIN.reverseRatio * VF26_DRIVETRAIN.finalDrive;
    return 0;
  }

  private selectGearForSpeed(speedMs: number): number {
    const r = VF26_TYRES.soft.rear.radius;
    for (let g = 1; g <= 8; g++) {
      const rpm = (speedMs / r) * this.overallRatio(g) * RADS2RPM;
      if (rpm < 11200) return g;
    }
    return 8;
  }

  private syncDrivetrainToRoadSpeed(): void {
    const dt = this.drivetrain;
    const rearOmega = 0.5 * (this.wheels[2].spinVel + this.wheels[3].spinVel);
    const engineFromRoad = rearOmega * this.overallRatio(dt.gear);
    const idle = VF26_ENGINE.idleRpm * RPM2RADS;
    if (engineFromRoad > VF26_DRIVETRAIN.autoClutchFullRpm * RPM2RADS) {
      dt.engineOmega = engineFromRoad;
      dt.clutchLocked = true;
      dt.clutchEngagement = 1;
    } else {
      dt.engineOmega = idle;
      dt.clutchLocked = false;
      dt.clutchEngagement = 0;
    }
  }

  /** Runs the vertical dynamics alone so a teleported car starts in aero/suspension equilibrium */
  private settleSuspension(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.planeBankRad = this.measureLocalBank(sample);
    this.updateWheelWorldPositions(sample);
    this.updateRoadContacts(sample, true);
    this.updateGravity(sample);
    for (let i = 0; i < 600; i++) {
      this.updateAero();
      this.integrateVertical(F1Physics2026.FIXED_DT / SUBSTEPS, 1, 0, 0, true);
    }
    for (const w of this.wheels) w.roadOffsetPrev = w.roadOffset;
  }

  private syncCartesianFromCurvilinear(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    this.worldX = sample.position.x + sample.binormal.x * this.lateralOffsetM;
    this.worldZ = sample.position.z + sample.binormal.z * this.lateralOffsetM;
    const trackHeadingRad = Math.atan2(sample.tangent.x, sample.tangent.z);
    this.worldYawRad = Math.atan2(
      Math.sin(trackHeadingRad - this.headingErrorRad),
      Math.cos(trackHeadingRad - this.headingErrorRad)
    );
    this.lastSyncedSMeters = this.sMeters;
    this.lastSyncedLateralOffsetM = this.lateralOffsetM;
    this.lastSyncedHeadingErrorRad = this.headingErrorRad;
  }

  private computeAirDensity(altitudeM: number): number {
    return 1.225 * Math.pow(1 - 2.25577e-5 * altitudeM, 4.25588);
  }

  // ===========================================================================
  // 500 Hz outer step
  // ===========================================================================

  /** The car as the steering assist reads it */
  private readonly steeringAssistState = (brake: number): SteeringAssistCarState => {
    // The tyres' live slip per axle, for the learned peak slip angle (wheels FR, FL, RR, RL; the sample's FL, FR, RL, RR)
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const o = this.slipScratch.wheels[i ^ 1];
      o.loadN = w.fzN;
      o.slipAngleRad = w.slipAngleRad;
      o.ndSlip = w.combinedSlipNorm;
      o.slipRatio = w.slipRatio;
      o.onRoad = w.surfaceType === 'asphalt';
    }
    return {
      vxMs: this.vxMs,
      vyMs: this.vyMs,
      yawRateRadS: this.yawRateRadS,
      cgToFrontAxleM: this.cgToFrontAxleM,
      cgToRearAxleM: this.cgToRearAxleM,
      wheelbaseM: this.wheelbaseM,
      maxSteerAngleRad: this.maxSteerAngleRad,
      frontPeakSlipRad: VF26_TYRES[this.tireCompound].front.frictionLimitAngleDeg * DEG2RAD,
      brake,
      // Measured on the flat pad: ≈1.75 × (g + downforce / m) from 90 to 240 km/h, scaled by surface/wet grip
      maxLateralAccel: 1.75 * this.aiPlanGrip() * (G + this.aeroDownforceN / this.massKg),
      slip: this.slipScratch.sample(),
    };
  };

  private outerStep(dt: number, inputs: ControlInputs, shiftRequest: -1 | 0 | 1): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    const drv = this.drivetrain;

    // ---- 1. Driver / AI commands ------------------------------------------------
    let throttle = inputs.throttle;
    let brake = inputs.brake;
    let steerNorm: number; // + = right

    let launchPedal: number | undefined;

    if (this.aiAutopilot) {
      // The player's steering assist holds nothing while the autopilot drives, so a hand-back starts from centre
      this.steeringAssist.reset();
      this.lastObservation = this.buildObservation(sample);
      const own = this.getAiPlan();
      const plan = this.aiPlan ? { profile: this.planProfile(this.aiPlan), params: own.params } : own;
      plan.params.paceScale = this.aiPaceScale;
      plan.params.lineBiasM = this.aiLineBiasM;
      plan.params.speedCapMs = this.aiSpeedCapMs;
      const ai = this.aiDriver.evaluate(this.lastObservation, this.track, this.sMeters, plan.profile, plan.params, dt);
      // The AI holds the front tyres at (not beyond) their peak slip angle
      // (low-passed so the limit doesn't form a fast loop with the yaw / tyre dynamics)
      const vxSafe = Math.max(3, this.vxMs);
      const frontCourseLeft = Math.atan2(this.vyMs - this.yawRateRadS * this.cgToFrontAxleM, vxSafe);
      this.aiFrontCourseRad += (frontCourseLeft - this.aiFrontCourseRad) * Math.min(1, dt / 0.05);
      const alphaLim = 1.05 * VF26_TYRES[this.tireCompound].front.frictionLimitAngleDeg * DEG2RAD;
      const wantLeft = THREE.MathUtils.clamp(
        ai.steerCmd * this.maxSteerAngleRad,
        this.aiFrontCourseRad - alphaLim,
        this.aiFrontCourseRad + alphaLim
      );
      steerNorm = THREE.MathUtils.clamp(-wantLeft / this.maxSteerAngleRad, -1, 1);
      // A skilled driver bleeds off the brake when the tyres start to lock and feathers the throttle
      // on wheelspin. Lock-up is load-weighted: a skating, nearly unloaded inside wheel carries
      // almost no braking force, so it must not make the driver release the whole brake.
      let lockSum = 0;
      let fzSum = 0;
      let lockLoaded = 0;
      let spin = 0;
      for (const w of this.wheels) {
        const l = Math.max(0, -w.slipRatio);
        lockSum += l * w.fzN;
        fzSum += w.fzN;
        if (w.fzN > 1500) lockLoaded = Math.max(lockLoaded, l);
        if (!w.isFront) spin = Math.max(spin, w.slipRatio);
      }
      const lock = fzSum > 1 ? lockSum / fzSum : 0;
      const brakeWant = Math.min(
        lock > 0.09 ? Math.max(0.25, 1 - (lock - 0.09) * 8) : 1,
        // a properly loaded wheel sliding well past its peak must be released to recover
        lockLoaded > 0.2 ? Math.max(0.3, 1 - (lockLoaded - 0.2) * 2.5) : 1
      );
      this.aiBrakeTrim += (brakeWant - this.aiBrakeTrim) * Math.min(1, (brakeWant < this.aiBrakeTrim ? 40 : 8) * dt);
      const throttleWant = spin > 0.085 ? Math.max(0.2, 1 - (spin - 0.085) * 10) : 1;
      this.aiThrottleTrim += (throttleWant - this.aiThrottleTrim) * Math.min(1, (throttleWant < this.aiThrottleTrim ? 40 : 6) * dt);
      throttle = ai.throttleCmd * this.aiThrottleTrim;
      // The auto-clutch's launch revs follow the pedal the driver wants, not its feathering of the wheelspin: with the
      // feathered pedal the launch window came down at the first spin, the engine fell into the anti-stall and the
      // clutch let go (the AI lost ~0.25 s to 100 km/h on a flat-out launch)
      launchPedal = ai.throttleCmd;
      // Brake only up to what the less-loaded front tyre can take (left/right torque is equal),
      // using the grip left over after its current cornering force
      // Front torque per wheel at pedal p is T·(bias + mig·p)·p with the migration, so the cap is the root of
      // mig·p² + bias·p − τ/T = 0 for the torque τ the tyre can take
      const brakeTorqueFull = VF26_BRAKES.maxTorqueNm * VF26_BRAKES.powerMult * this.brakePowerScale;
      // The live bias and migration (the tuner can move them), as the brake distribution itself uses
      const bias0 = this.liveBrakeBias;
      const mig = this.liveBrakeMigration;
      let pedalCap = 1;
      for (let i = 0; i < 2; i++) {
        const w = this.wheels[i];
        const fxMax = Math.sqrt(Math.max(0, (1.06 * w.effectiveMu * w.fzN) ** 2 - w.fnN * w.fnN));
        const share = (1.05 * fxMax * w.tyre.spec.radius) / brakeTorqueFull;
        const cap = mig > 1e-6 ? (-bias0 + Math.sqrt(bias0 * bias0 + 4 * mig * share)) / (2 * mig) : share / bias0;
        pedalCap = Math.min(pedalCap, cap);
      }
      brake = Math.min(ai.brakeCmd, Math.max(0.15, pedalCap)) * this.aiBrakeTrim;
      this.aiTargetSpeedKmh = ai.targetSpeedKmh;
      this.activeAeroMode = isRearFlapAllowedInWet(this.weatherSample.wetness) ? ai.aeroMode : 'Z_MODE';
      // An earned Overtake Mode is spent in the zones, where the AI car overtakes
      const aiOvertake = !!this.raceControl?.racing && this.overtake.earned && sample.drsZone;
      if (drv.boostRemainingS <= 0) drv.ersMode = aiOvertake ? 'OVERRIDE' : ai.ersMode;
    } else {
      steerNorm = this.steeringAssist.steer(inputs, this.gamepadAssistEnabled, this.steeringAssistState, dt);

      if (inputs.manualOverride && drv.ersEnergyJ > 0) {
        drv.ersMode = 'OVERRIDE';
      } else if (drv.boostRemainingS <= 0 && drv.ersMode === 'OVERRIDE') {
        drv.ersMode = this.userErsMode;
      }

      if (this.autoXMode) {
        const canXMode =
          sample.drsZone &&
          isRearFlapAllowedInWet(this.weatherSample.wetness) &&
          brake < 0.05 &&
          Math.abs(steerNorm) < 0.18 &&
          this.vxMs > 38 &&
          throttle > 0.6;
        this.activeAeroMode = canXMode ? 'X_MODE' : 'Z_MODE';
      }
    }

    drv.launchPedal = launchPedal ?? throttle;

    // ---- 2. Driver aids (12-stage 130 Hz TC1/TC2 + Lateral-G & 12-stage 240 Hz 4-channel ABS) ----
    const tcLv = THREE.MathUtils.clamp(Math.round(this.tcLevel), 0, 12);
    // Level 1 = 1.235 (least intrusive), Level 5 = 1.055 (semi_pro), Level 8 = 0.92 (assisted), Level 12 = 0.74
    const tcBaseTarget = tcLv > 0 ? 1.28 - tcLv * 0.045 : 0;
    if (tcBaseTarget > 0 && this.vxMs > 2) {
      const gLat = Math.abs(this.lastAyMs2) / G;
      const latFactor = Math.max(0.45, 1 - 0.14 * Math.pow(gLat, 1.3));
      const tcTarget = tcBaseTarget * latFactor;
      const fzMean = 0.5 * (this.wheels[2].fzN + this.wheels[3].fzN);
      const wheelExcess: [number, number] = [0, 0];
      for (let i = 2; i < 4; i++) {
        const w = this.wheels[i];
        const sk = w.slipRatio / w.tyre.spec.peakSlipRatio;
        const sa = Math.abs(Math.tan(w.slipAngleRad)) / w.tyre.tanPeakAngle;
        const skFloor = THREE.MathUtils.lerp(0.4, 0.12, THREE.MathUtils.clamp((sa - 0.75) / 0.3, 0, 1));
        const skAllowed = Math.sqrt(Math.max(skFloor * skFloor, tcTarget * tcTarget - sa * sa));
        const loadWeight = fzMean > 1 ? Math.min(1, (1.5 * w.fzN) / fzMean) : 0;
        wheelExcess[i - 2] = Math.max(0, sk - skAllowed) * loadWeight;
      }
      const excess = Math.max(wheelExcess[0], wheelExcess[1]);
      const tc2 = THREE.MathUtils.clamp(this.tc2Level, 1, 12);
      const tc2Norm = (tc2 - 1) / 11;
      const stageACut = Math.min(1, excess / 0.08) * 0.32 * (0.65 + 0.35 * tc2Norm);
      const stageBCut = excess > 0.08 ? (excess - 0.08) * (3.2 + 2.4 * tc2Norm) : 0;
      const minThrottle = Math.max(0.05, 0.14 - 0.008 * tc2);
      const want = excess > 0 ? Math.max(minThrottle, 1 - stageACut - stageBCut) : 1;
      this.tcCut += (want - this.tcCut) * Math.min(1, (want < this.tcCut ? 130 : 12) * dt);
      throttle *= this.tcCut;
    } else {
      this.tcCut = 1;
    }

    // 12-stage 4-channel 240 Hz ABS (Level 5 = 1.10 semi_pro, Level 9 = 0.92 assisted)
    const absLv = THREE.MathUtils.clamp(Math.round(this.absLevel), 0, 12);
    const absTarget = absLv > 0 ? 1.32 - absLv * 0.044 : 0;
    const absWant = this.absWant;
    for (let i = 0; i < 4; i++) {
      let want = 1;
      if (absTarget > 0 && this.vxMs > 3 && brake > 0.01) {
        const w = this.wheels[i];
        const sk = -w.slipRatio / w.tyre.spec.peakSlipRatio;
        // Every channel shares its tyre's grip with the cornering force: the longitudinal slip allowed shrinks with
        // the slip angle (friction circle), fronts included
        const sa = Math.abs(Math.tan(w.slipAngleRad)) / w.tyre.tanPeakAngle;
        const skAllowed = Math.sqrt(Math.max(0.35 * 0.35, absTarget * absTarget - sa * sa));
        if (sk > skAllowed) want = Math.max(0.1, 1 - (sk - skAllowed) * 3.2);
      }
      absWant[i] = want;
    }
    // Electronic brake distribution: a rear channel never brakes harder, relative to its share, than the more
    // released front, so freeing a front mid-corner does not move the balance rearward and spin the car
    const frontWant = 0.5 * (absWant[0] + absWant[1]);
    absWant[2] = Math.min(absWant[2], frontWant);
    absWant[3] = Math.min(absWant[3], frontWant);
    for (let i = 0; i < 4; i++) {
      const want = absWant[i];
      this.absFactor[i] += (want - this.absFactor[i]) * Math.min(1, (want < this.absFactor[i] ? 160 : 38) * dt);
    }

    // ---- 3. Steering rack & 3D Double-Wishbone + Tie-Rod Kinematics ----------------
    const targetRoad = -steerNorm * this.maxSteerAngleRad;
    const maxRate = (VF26_CHASSIS.steering.maxWheelSpeedDegS / VF26_CHASSIS.steering.ratio) * DEG2RAD;
    const dSteer = THREE.MathUtils.clamp(targetRoad - this.steerRoadWheelRad, -maxRate * dt, maxRate * dt);
    this.steerRoadWheelRad += dSteer;

    const frontKin = solveAxleKinematics3D(
      this.axles[0].hardpoints,
      this.wheels[1].suspCompression,
      this.wheels[0].suspCompression,
      this.steerRoadWheelRad,
      this.axles[0].spec.track,
      this.wheels[1].tyre.spec.radius,
      this.wheels[0].tyre.spec.radius,
      this.frontKin
    );
    const rearKin = solveAxleKinematics3D(
      this.axles[1].hardpoints,
      this.wheels[3].suspCompression,
      this.wheels[2].suspCompression,
      0,
      this.axles[1].spec.track,
      this.wheels[3].tyre.spec.radius,
      this.wheels[2].tyre.spec.radius,
      this.rearKin
    );

    const toeF = this.axles[0].spec.staticToeDeg * DEG2RAD;
    const toeR = this.axles[1].spec.staticToeDeg * DEG2RAD;
    // Each front wheel's own road angle from the steering geometry (Ackermann: the inside wheel turns more); the
    // solver's roadSteerRad also holds its full bump steer, taken out here for the scaled term below
    const ackRight = frontKin.right.roadSteerRad - frontKin.right.bumpSteerToeInRad;
    const ackLeft = frontKin.left.roadSteerRad + frontKin.left.bumpSteerToeInRad;
    this.wheels[0].steerRad = ackRight + toeF + 0.12 * frontKin.right.bumpSteerToeInRad;
    this.wheels[1].steerRad = ackLeft - toeF - 0.12 * frontKin.left.bumpSteerToeInRad;
    this.wheels[2].steerRad = toeR + 0.12 * rearKin.right.bumpSteerToeInRad;
    this.wheels[3].steerRad = -toeR - 0.12 * rearKin.left.bumpSteerToeInRad;
    for (let i = 0; i < 4; i++) {
      const k = this.lastKinematics[i];
      const w = this.wheels[i];
      w.kinematicsCamberDeltaRad = k.dynamicCamberDeltaRad;
      w.kinematicsBumpSteerRad = k.bumpSteerToeInRad;
      w.casterTrailM = k.casterTrailM;
      w.scrubRadiusM = k.scrubRadiusM;
      w.kpiRad = k.kpiRad;
    }
    this.frontWheelAngleRad = -this.steerRoadWheelRad;
    this.steerAngleNorm = THREE.MathUtils.clamp(this.frontWheelAngleRad / this.maxSteerAngleRad, -1, 1);

    // ---- 4. Gearbox ---------------------------------------------------------------
    this.updateGearbox(dt, shiftRequest, throttle, brake);

    // ---- 5. Track contact, gravity, aero -------------------------------------------
    const bankTarget = this.measureLocalBank(sample);
    this.planeBankRad += (bankTarget - this.planeBankRad) * Math.min(1, dt / 0.08);
    this.updateWheelWorldPositions(sample);
    this.updateRoadContacts(sample, false);
    this.updateGravity(sample);
    const altitudeM = (this.track.baseAltitudeM ?? BASE_ALTITUDE_M) + sample.position.y;
    this.airDensity = this.computeAirDensity(altitudeM);
    // The flaps stay shut on a wet road whoever asked for it (a manual toggle or a flying start included), and
    // Straight Mode only opens inside a DRS zone
    if (this.activeAeroMode === 'X_MODE' && (!isRearFlapAllowedInWet(this.weatherSample.wetness) || !sample.drsZone)) {
      this.activeAeroMode = 'Z_MODE';
    }
    const xTarget = this.activeAeroMode === 'X_MODE' ? 1 : 0;
    const aeroRate = dt / VF26_ACTIVE_AERO_TRANSITION_S;
    this.xModeBlend += THREE.MathUtils.clamp(xTarget - this.xModeBlend, -aeroRate, aeroRate);
    this.updateAero();

    // ---- 6. Power unit & brakes (controls for the sub-steps) ----------------------
    this.updatePowerUnitControls(dt, throttle, brake);
    const effectiveFrontBias = computeDynamicBrakeMigration(this.liveBrakeBias, brake, this.liveBrakeMigration);
    const brakeDemand = brake * VF26_BRAKES.maxTorqueNm * VF26_BRAKES.powerMult * this.brakePowerScale;
    const frontPerWheel = brakeDemand * effectiveFrontBias;
    const rearPerWheelDemand = brakeDemand * (1 - effectiveFrontBias);
    // Brake-by-wire: MGU-K harvest replaces part of the rear hydraulic torque. The BBW keeps the
    // total rear torque at the (ABS-limited) demand, so harvest never adds to a locking axle.
    const rearAbs = Math.min(this.absFactor[2], this.absFactor[3]);
    const harvestPerWheel = Math.min(rearPerWheelDemand * rearAbs, drv.harvestAxleTorqueNm * 0.5);
    drv.harvestAxleTorqueNm = 2 * harvestPerWheel;
    // It also counts the closed-throttle engine braking the rear axle already carries through the
    // gearbox; adding it on top of the rear hydraulic torque over-brakes the rear in a fast corner
    const coastPerWheel =
      brake > 0.02 && drv.clutchLocked
        ? (0.5 * Math.max(0, -this.coastLut.evaluate(drv.engineOmega * RADS2RPM) * this.engineBrakingScale) * Math.abs(this.overallRatio(drv.gear)) * (1 - throttle)) /
          VF26_DRIVETRAIN.efficiency
        : 0;
    this.wheels[0].brakeTorqueNm = frontPerWheel * this.absFactor[0] * this.wheels[0].brakeDisc.muFactor;
    this.wheels[1].brakeTorqueNm = frontPerWheel * this.absFactor[1] * this.wheels[1].brakeDisc.muFactor;
    this.wheels[2].brakeTorqueNm =
      Math.max(0, rearPerWheelDemand * this.absFactor[2] - harvestPerWheel - coastPerWheel) *
      this.wheels[2].brakeDisc.muFactor;
    this.wheels[3].brakeTorqueNm =
      Math.max(0, rearPerWheelDemand * this.absFactor[3] - harvestPerWheel - coastPerWheel) *
      this.wheels[3].brakeDisc.muFactor;

    // ---- 7. 2 kHz sub-steps: tyres, wheels, drivetrain, chassis, suspension -------
    const h = dt / SUBSTEPS;
    const prevS = this.sMeters;
    const prevX = this.worldX;
    const prevZ = this.worldZ;
    let sumAx = 0;
    let sumAy = 0;
    for (let k = 0; k < SUBSTEPS; k++) {
      const roadFrac = (k + 1) / SUBSTEPS;
      const acc = this.subStep(h, throttle, roadFrac);
      sumAx += acc.ax;
      sumAy += acc.ay;
    }
    this.lastAxMs2 += (sumAx / SUBSTEPS - this.lastAxMs2) * Math.min(1, 25 * dt);
    this.lastAyMs2 += (sumAy / SUBSTEPS - this.lastAyMs2) * Math.min(1, 25 * dt);

    // ---- 8. Thermal models (9-node + 16-sector tyre, 2-node carbon brake), fuel ----
    const ambC = this.weatherSample.ambientC;
    for (const w of this.wheels) {
      const radius = tyreRollingRadius(w.tyre, w.fzN, w.spinVel);
      const rollSpeed = w.spinVel * radius;
      const hubVx = this.wheelHubVx(w);
      const slipPower = Math.abs(w.ftN * (rollSpeed - hubVx)) + Math.abs(w.fnN * this.wheelHubVy(w));
      const sprayBoost = this.weatherSample.sprayIntensity ?? this.aeroWakeState.sprayIntensity ?? 0;
      stepBrakeDiscThermal(
        w.brakeDisc,
        w.brakeTorqueNm,
        w.spinVel,
        this.vxMs,
        ambC,
        dt,
        'carbon-ceramic',
        w.isFront ? this.brakeDuctScale.front : this.brakeDuctScale.rear,
        Math.min(1, w.tyre.wetness + 0.5 * sprayBoost)
      );
      w.brakeTempC = w.brakeDisc.surfaceTempC;
      updateTyreThermal(
        w.tyre,
        slipPower,
        w.fzN,
        hubVx,
        ambC,
        this.trackEvolutionSample.trackTempC,
        dt,
        w.brakeTempC,
        rollSpeed,
        w.surfaceType,
        this.trackEvolutionSample.marbleLevel
      );
    }
    if (this.realism.fuelUse && throttle > 0.01 && drv.fuelKg > 0) {
      drv.fuelKg = Math.max(0, drv.fuelKg - VF26_CHASSIS.fuelFlowKgS * throttle * dt);
    }
    this.totalMassKg = VF26_CHASSIS.totalMassKg + drv.fuelKg;

    // ---- 9. Barriers, project onto the track, timing ------------------------------
    this.postIntegrate(prevS, prevX, prevZ);

    // ---- 10. Outputs & True 3D Steering Rack FFB ----------------------------------
    this.rpm = drv.engineOmega * RADS2RPM;
    this.gear = drv.gear;
    this.ersEnergyJ = drv.ersEnergyJ;
    const dhFOut = this.axles[0].spec.staticRideHeight - VF26_CHASSIS.front.staticRideHeight;
    const dhROut = this.axles[1].spec.staticRideHeight - VF26_CHASSIS.rear.staticRideHeight;
    this.rideHeightOffsetM = this.heaveM + 0.5 * (dhFOut + dhROut);
    this.wheelRotationRad = this.wheels[0].rotationRad;
    this.frontSlipRatioNorm = Math.max(this.wheels[0].combinedSlipNorm, this.wheels[1].combinedSlipNorm);
    this.rearSlipRatioNorm = Math.max(this.wheels[2].combinedSlipNorm, this.wheels[3].combinedSlipNorm);

    const wFR = this.wheels[0];
    const wFL = this.wheels[1];
    // Low-speed slip-torque envelope: attenuates stationary/crawl carcass scrubbing below 4 km/h
    const speedKmhNow = Math.hypot(this.vxMs, this.vyMs) * 3.6;
    const lowSpeedScale = THREE.MathUtils.lerp(0.03, 1.0, THREE.MathUtils.smoothstep(speedKmhNow, 0.5, 4.0));
    // 1. Pneumatic trail self-aligning torque Mz
    const mzPneumatic = (wFR.torqueAlignNm + wFL.torqueAlignNm) * lowSpeedScale;
    // 2. Dynamic 3D caster trail lateral force moment
    const casterTrailR = wFR.casterTrailM ?? VF26_CHASSIS.steering.mechanicalTrail;
    const casterTrailL = wFL.casterTrailM ?? VF26_CHASSIS.steering.mechanicalTrail;
    const mzCaster = -(casterTrailR * wFR.fnN + casterTrailL * wFL.fnN) * lowSpeedScale;
    // 3. Scrub radius longitudinal force moment (cancels on symmetric straight braking, pulls on asymmetric lockup/kerb)
    const scrubR = wFR.scrubRadiusM ?? 0.018;
    const scrubL = wFL.scrubRadiusM ?? 0.018;
    const mzScrub = (scrubR * wFR.ftN - scrubL * wFL.ftN) * lowSpeedScale;
    // 4. Kingpin inclination (KPI) vertical load jacking torque
    const kpiSin = Math.sin(wFR.kpiRad ?? 0.2);
    const mzKpi = -(wFR.fzN - wFL.fzN) * 0.016 * kpiSin * Math.sin(this.steerRoadWheelRad);
    // 5. Tire gyroscopic precession torque (Iy * omega * dGamma/dt)
    const mzGyro =
      0.32 * wFR.tyre.spec.angularInertia * (wFR.spinVel + wFL.spinVel) * this.rollVelRadS;
    // 6. Flat-spot harmonic vibration (the tyre model's, ≤ 16 Nm per wheel) + road/kerb micro-roughness suspension kick
    const mzFlatSpot = (wFR.flatSpotVibrationNm ?? 0) + (wFL.flatSpotVibrationNm ?? 0);
    const speedGate = THREE.MathUtils.clamp(Math.abs(this.vxMs) / 5, 0, 1);
    const isoR = evaluateIso8608RoadRoughness(wFR.worldPos.x, wFR.worldPos.z, wFR.surfaceType === 'kerb' ? 'kerb' : 'asphalt');
    const isoL = evaluateIso8608RoadRoughness(wFL.worldPos.x, wFL.worldPos.z, wFL.surfaceType === 'kerb' ? 'kerb' : 'asphalt');
    const mzIsoRough = (isoL * wFL.tyre.verticalRate - isoR * wFR.tyre.verticalRate) * 0.006 * speedGate;
    const mzRoadTexture = (wFR.suspCompressionVel - wFL.suspCompressionVel) * 18 * lowSpeedScale + mzIsoRough;
    // 7. Overturning moment of the shifted contact centroids (cancels left / right on a level road), as VehiclePhysics
    const mzOverturn = 0.08 * ((wFR.overturningMomentNm ?? 0) + (wFL.overturningMomentNm ?? 0)) * lowSpeedScale;

    const totalKingpinTorqueNm =
      mzPneumatic + mzCaster + mzScrub + mzKpi + mzGyro + mzFlatSpot + mzRoadTexture + mzOverturn;
    this.ffbTorqueNorm = THREE.MathUtils.clamp(
      (-totalKingpinTorqueNm / 650) * VF26_CHASSIS.steering.ffbMult,
      -1,
      1
    );
    this.ffbSubframeSamples.push(this.ffbTorqueNorm);
  }

  private wheelHubVx(w: VehicleWheelState): number {
    const r = -this.yawRateRadS;
    const vbx = this.vxMs - r * w.staticPos.y;
    const vby = this.vyMs + r * w.staticPos.x;
    return vbx * Math.cos(w.steerRad) + vby * Math.sin(w.steerRad);
  }

  private wheelHubVy(w: VehicleWheelState): number {
    const r = -this.yawRateRadS;
    const vbx = this.vxMs - r * w.staticPos.y;
    const vby = this.vyMs + r * w.staticPos.x;
    return -vbx * Math.sin(w.steerRad) + vby * Math.cos(w.steerRad);
  }

  // ---------------------------------------------------------------------------
  // Gearbox & power unit controls
  // ---------------------------------------------------------------------------

  private updateGearbox(dt: number, shiftRequest: -1 | 0 | 1, throttle: number, brake: number): void {
    const drv = this.drivetrain;
    if (drv.autoShiftCooldownS > 0) drv.autoShiftCooldownS = Math.max(0, drv.autoShiftCooldownS - dt);
    this.manualShift.tick(dt);

    // A paddle press during a shift waits for it to finish (one press is kept), instead of being dropped
    if (shiftRequest !== 0 && drv.shiftTimerS > 0) this.pendingShift = shiftRequest;
    if (drv.shiftTimerS > 0) {
      drv.shiftTimerS -= dt;
      if (drv.shiftTimerS <= 0) {
        drv.shiftTimerS = 0;
        drv.gear = drv.shiftTarget;
        if (drv.clutchLocked) {
          const rearOmega = 0.5 * (this.wheels[2].spinVel + this.wheels[3].spinVel);
          drv.engineOmega = Math.max(VF26_ENGINE.idleRpm * RPM2RADS, rearOmega * this.overallRatio(drv.gear));
        }
      }
      return;
    }
    if (this.pendingShift !== 0) {
      if (shiftRequest === 0) shiftRequest = this.pendingShift;
      this.pendingShift = 0;
    }

    let desired = drv.gear;
    const rearOmega = 0.5 * (this.wheels[2].spinVel + this.wheels[3].spinVel);
    if (shiftRequest !== 0) {
      desired = THREE.MathUtils.clamp(drv.gear + shiftRequest, 1, VF26_DRIVETRAIN.gearRatios.length);
      // Reverse sits below first (no neutral in between), and only near standstill
      if (drv.gear === 1 && shiftRequest < 0) desired = Math.abs(this.vxMs) < 2 ? -1 : 1;
      else if (drv.gear === -1) desired = shiftRequest > 0 && Math.abs(this.vxMs) < 2 ? 1 : -1;
      if (shiftRequest < 0 && desired > 0) {
        // Gearbox protection: refuse a downshift that would over-rev the engine
        const rpmAfter = rearOmega * this.overallRatio(desired) * RADS2RPM;
        if (rpmAfter > VF26_ENGINE.maxRpm - 500) desired = drv.gear;
      }
      if (desired !== drv.gear) this.manualShift.shifted(desired > drv.gear ? 1 : -1, desired);
    } else if ((this.autoGearbox || this.aiAutopilot) && drv.gear >= 1 && drv.autoShiftCooldownS <= 0) {
      const a = this.autoShiftIn;
      const roadOmega = Math.max(0, this.vxMs) / this.wheels[2].tyre.spec.radius;
      a.gear = drv.gear;
      a.topGear = VF26_DRIVETRAIN.gearRatios.length;
      a.engineRpm = drv.engineOmega * RADS2RPM;
      a.roadRpm = roadOmega * this.overallRatio(drv.gear) * RADS2RPM;
      // Downshifts go by road speed (or the rears' if faster) so a locking rear axle can't cascade the box down
      a.lowerGearRpm = Math.max(rearOmega, roadOmega) * this.overallRatio(drv.gear - 1) * RADS2RPM;
      a.clutchClosed = drv.clutchLocked;
      a.throttle = throttle;
      a.brake = brake;
      a.drivenGrounded = this.wheels[2].fzN > 1 || this.wheels[3].fzN > 1;
      a.drivenSpinning = Math.max(this.wheels[2].slipRatio, this.wheels[3].slipRatio) > 0.14;
      desired = drv.gear + autoShift(a, VF26_AUTO_SHIFT, this.manualShift);
      if (desired !== drv.gear) drv.autoShiftCooldownS = 0.12;
    }

    if (desired !== drv.gear) {
      drv.shiftTarget = desired;
      drv.shiftTimerS = desired > drv.gear ? VF26_DRIVETRAIN.upshiftTimeS : VF26_DRIVETRAIN.downshiftTimeS;
    }
  }

  private ersController(): { ctrl: ErsControllerRuntime; override: boolean } {
    const mode = this.drivetrain.ersMode;
    if (mode === 'HOTLAP') return { ctrl: this.ersControllers.PSH, override: false };
    if (mode === 'HARVEST') return { ctrl: this.ersControllers.CHR, override: false };
    if (mode === 'OVERRIDE') return { ctrl: this.ersControllers.PSH, override: true };
    return { ctrl: this.ersControllers.RAC, override: false };
  }

  private updatePowerUnitControls(dt: number, throttle: number, brake: number): void {
    const drv = this.drivetrain;
    const rpm = drv.engineOmega * RADS2RPM;
    const speedKmh = Math.abs(this.vxMs) * 3.6;

    if (drv.boostCooldownS > 0) drv.boostCooldownS = Math.max(0, drv.boostCooldownS - dt);
    if (drv.boostRemainingS > 0) {
      drv.boostRemainingS = Math.max(0, drv.boostRemainingS - dt);
      if (drv.boostRemainingS === 0) {
        // Back to the mode the driver chose (as the override-release path in outerStep does), not a fixed one
        if (drv.ersMode === 'OVERRIDE') drv.ersMode = this.userErsMode;
        drv.boostCooldownS = 4;
      }
    }

    // Rev limiter (fuel cut with 150 rpm hysteresis)
    if (rpm > VF26_ENGINE.limiterRpm) drv.limiterCut = true;
    else if (rpm < VF26_ENGINE.limiterRpm - 150) drv.limiterCut = false;

    // Turbo: boost target from the controller LUT, scaled by throttle, with spool lag
    const boostTarget = drv.limiterCut ? 0 : this.boostLut.evaluate(rpm) * throttle;
    const tau = boostTarget > drv.boostBar ? VF26_ENGINE.turboSpoolTauS : VF26_ENGINE.turboDecayTauS;
    drv.boostBar += (boostTarget - drv.boostBar) * (1 - Math.exp(-dt / tau));

    // MGU-K deployment (mod ERS controller curves) / harvesting
    const { ctrl, override } = this.ersController();
    const soc = drv.ersEnergyJ / VF26_ERS.batteryJ;
    const omega = Math.max(drv.engineOmega, 1);
    const shifting = drv.shiftTimerS > 0;
    let mgukTorque = 0;
    let harvestAxle = 0;
    const kinetic = this.kineticLut.evaluate(rpm);

    if (throttle > 0.02 && brake < 0.05 && drv.clutchLocked && !shifting && drv.ersEnergyJ > 0) {
      let speedFactor = ctrl.speed.evaluate(speedKmh);
      // Override holds full power; the taper above 337 km/h comes from the deploy ceiling below
      if (override) speedFactor = speedKmh < 100 ? 0 : 1;
      const frac = THREE.MathUtils.clamp(
        THREE.MathUtils.clamp(ctrl.throttle.evaluate(throttle), 0, 1) *
          speedFactor *
          THREE.MathUtils.clamp(ctrl.gear.evaluate(drv.gear), 0, 1) *
          THREE.MathUtils.clamp(ctrl.soc.evaluate(soc), 0, 1),
        0,
        1
      );
      mgukTorque = Math.min(kinetic * frac, mgukDeployCapW(speedKmh, override) / omega);
      const energy = mgukTorque * omega * dt;
      if (energy > drv.ersEnergyJ) {
        mgukTorque = drv.ersEnergyJ / (omega * dt);
      }
      drv.ersEnergyJ = Math.max(0, drv.ersEnergyJ - mgukTorque * omega * dt);
    } else if (drv.clutchLocked && speedKmh > 30 && soc < 1) {
      // Harvest: brake-by-wire on the rear axle, or lift-off coast harvest
      let frac = 0;
      if (brake > 0.02) frac = THREE.MathUtils.clamp(brake / 0.4, 0, 1);
      else if (throttle < 0.05) frac = ctrl.coastHarvest;
      if (frac > 0) {
        const ratio = Math.abs(this.overallRatio(drv.gear));
        const wetClip =
          this.weatherSample.wetness > 0
            ? Math.max(
                0.35,
                (1 - 0.32 * this.weatherSample.wetness) *
                  (1 - 0.18 * Math.min(1.5, Math.abs(this.lastAyMs2) / G) * this.weatherSample.wetness)
              )
            : 1;
        let harvestTorque = Math.min(kinetic, VF26_ERS.maxPowerW / omega) * frac * wetClip;
        if (brake <= 0.02 && ratio > 0) {
          harvestTorque = Math.min(harvestTorque, (VF26_ERS.coastHarvestMaxAxleTorqueNm * wetClip) / ratio);
        }
        harvestAxle = harvestTorque * ratio;
        mgukTorque = -harvestTorque;
        drv.ersEnergyJ = Math.min(
          VF26_ERS.batteryJ,
          drv.ersEnergyJ + harvestTorque * omega * dt * VF26_ERS.harvestEfficiency
        );
      }
    }
    // Braking harvest is delivered at the wheels via BBW, so it is not added to the crank torque path
    // (the rear hydraulic brakes are reduced by the same amount in outerStep).
    const brakingHarvest = brake > 0.02 && mgukTorque < 0;
    drv.mgukTorqueNm = brakingHarvest ? 0 : mgukTorque;
    drv.harvestAxleTorqueNm = brakingHarvest ? harvestAxle : 0;
    drv.mgukPowerW = mgukTorque * omega;
  }

  /** Crank torque from ICE + MGU-K at the given engine speed with the current controls */
  private engineTorque(omega: number, throttle: number): number {
    const drv = this.drivetrain;
    const rpm = omega * RADS2RPM;
    const coast = this.coastLut.evaluate(rpm) * this.engineBrakingScale;
    const mapIdx = THREE.MathUtils.clamp(this.engineMap, 1, 5);
    const wetPedalBlend = Math.max(this.weatherSample.wetness, mapIdx >= 4 ? (mapIdx - 3) * 0.35 : 0);
    const lowGearWetExp = drv.gear >= 1 && drv.gear <= 4 ? (5 - drv.gear) * 0.065 * wetPedalBlend : 0;
    const mapExponent = 0.88 + (mapIdx - 1) * 0.12 + lowGearWetExp;
    const mapCeiling = mapIdx <= 2 ? 1.0 : 1.0 - (mapIdx - 2) * 0.04;
    const shapedThrottle = Math.pow(Math.max(0, throttle), mapExponent) * mapCeiling;
    let ice: number;
    if (drv.limiterCut || drv.shiftTimerS > 0 || drv.fuelKg <= 0) {
      ice = coast;
    } else {
      const full = this.torqueLut.evaluate(rpm) * (1 + drv.boostBar);
      ice = coast + (full - coast) * shapedThrottle;
    }
    drv.iceTorqueNm = ice;
    const mguk = drv.shiftTimerS > 0 ? Math.min(0, drv.mgukTorqueNm) : drv.mgukTorqueNm;
    return ice + mguk;
  }

  // ---------------------------------------------------------------------------
  // Track contact, gravity & aero (outer step)
  // ---------------------------------------------------------------------------

  /**
   * Road height under a point of the current wheel's footprint, measured from the road plane through the contact
   * point (grade along, bank across; see updateRoadContacts; one closure, reused). Camber is already relative to
   * that plane, so only what departs from it (kerb lips, rumble strips, texture) may tilt the patch.
   */
  private patchWheel: VehicleWheelState | null = null;
  private patchContact: ReturnType<typeof queryWheelGroundContact> | null = null;
  private patchSample: ReturnType<BuiltTrackData['getSampleAtDistance']> | null = null;
  private patchNearKerb = false;
  private patchApproxS = 0;
  private patchSpeed = 0;
  private readonly patchOut = createContactPatchResult();
  private readonly patchHeightAt = (x: number, z: number): number => {
    const w = this.patchWheel!;
    const contact = this.patchContact!;
    if (!this.patchNearKerb) return contact.bumpM; // elsewhere the road is that plane
    // Kerb edges and rumble strips vary across the tread: query the surface itself
    const sample = this.patchSample!;
    const dx = x - w.worldPos.x;
    const dz = z - w.worldPos.z;
    const dFwd = dx * sample.tangent.x + dz * sample.tangent.z;
    const dRight = dx * sample.binormal.x + dz * sample.binormal.z;
    const plane = contact.zRoad + dFwd * sample.slopeSin - dRight * Math.sin(contact.bankRad);
    const c = queryWheelGroundContact(this.track, x, z, this.patchApproxS, this.patchSpeed);
    if (c.surfaceType !== 'kerb') {
      const kerbBumpM = this.meshKerbBumpAt(x, z, c.zRoad, this.patchApproxS + dFwd, this.patchSpeed);
      if (kerbBumpM !== null) c.bumpM = Math.max(c.bumpM, kerbBumpM);
    }
    return c.zRoad + c.bumpM - plane;
  };

  /**
   * On a circuit whose kerbs are meshes (`meshKerbs`): the bump of a kerb at a point (m, crown plus ripple, the ripple
   * fading in over the first 8 m/s), or null off one; `_groundHit` then holds the kerb's surface and grip
   */
  private meshKerbBumpAt(x: number, z: number, zRoad: number, alongS: number, speedMs: number): number | null {
    if (!this.meshKerbs || !this.ground!.query(x, z, zRoad + 0.6, _groundHit) || _groundHit.surface !== 'kerb') return null;
    return MESH_KERB_CROWN_M + surfaceRippleM(_groundHit.props, alongS, 1.0) * Math.min(1, speedMs / 8);
  }

  private updateRoadContacts(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>, reset: boolean): void {
    const speed = Math.abs(this.vxMs);
    for (const w of this.wheels) {
      const approxS = this.sMeters + w.staticPos.x;
      const contact = queryWheelGroundContact(this.track, w.worldPos.x, w.worldPos.z, approxS, speed);
      const kerbBumpM = this.meshKerbBumpAt(w.worldPos.x, w.worldPos.z, contact.zRoad, approxS, speed);
      if (kerbBumpM !== null) {
        contact.surfaceType = 'kerb';
        contact.frictionMult = _groundHit.grip;
        contact.bumpM = Math.max(contact.bumpM, kerbBumpM);
      }
      w.zRoad = contact.zRoad;
      w.surfaceType = contact.surfaceType;
      w.surfaceBumpM = contact.bumpM;
      const heading = this.worldYawRad + w.steerRad;
      this.patchWheel = w;
      this.patchContact = contact;
      this.patchSample = sample;
      this.patchNearKerb = this.meshKerbs
        ? contact.surfaceType === 'kerb' || Math.abs(contact.lateralOffsetM) > contact.halfWidthM - 1.5
        : Math.abs(contact.lateralOffsetM) > contact.halfWidthM - 0.65;
      this.patchApproxS = approxS;
      this.patchSpeed = speed;
      const patch = sample5PointContactPatch(
        w.worldPos.x,
        w.worldPos.z,
        Math.cos(heading),
        Math.sin(heading),
        w.isLeft ? -1 : 1,
        w.tyre.spec.width,
        Math.max(0.008, w.fzN / w.tyre.verticalRate),
        this.patchHeightAt,
        contact.surfaceType,
        this.patchOut
      );
      w.contactCentroidShiftInward = patch.centroidShiftInwardNorm;
      w.contactCentroidShiftLeftM = patch.centroidShiftLeftM;
      // A wet road: painted kerbs and grass go slicker than the asphalt (the tyre's own water response is ac-tyre's)
      const wet = this.weatherSample.wetness;
      const wetSurface =
        wet > 0
          ? surfaceWetMultiplier(getActiveSurfaceTable()[SURFACE_KIND[contact.surfaceType] ?? 'road'].wetFriction, wet, this.realism.wetSeverity)
          : 1;
      w.surfaceFrictionMult =
        contact.frictionMult * (sample.gripMultiplier ?? 1) * this.trackEvolutionSample.gripMultiplier * wetSurface;
      w.roadOffsetPrev = reset ? contact.zRoad + contact.bumpM - w.worldPos.y : w.roadOffset;
      w.roadOffset = contact.zRoad + contact.bumpM - w.worldPos.y;
    }
  }

  /** Instantaneous cross-slope of the track surface under the car centre (rad) */
  private measureLocalBank(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): number {
    const yLeft = evaluateSampleLateralHeightM(sample, this.lateralOffsetM - 0.8);
    const yRight = evaluateSampleLateralHeightM(sample, this.lateralOffsetM + 0.8);
    return Math.atan2(yLeft - yRight, 1.6);
  }

  /**
   * Road-plane normal under the car (filtered cross-slope; identical frame used for rendering). Returns a shared
   * scratch vector, valid until the next call: read it, don't keep it.
   */
  private localRoadUp(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): THREE.Vector3 {
    const rightFlat = _rightFlat.set(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const upFlat = _roadUp.crossVectors(rightFlat, sample.tangent).normalize();
    return upFlat.applyAxisAngle(sample.tangent, this.planeBankRad).normalize();
  }

  /**
   * Roll-centre height of an axle (m): the static design value, moved a quarter of the way to where the 3D wishbone
   * solver puts it now (it migrates with roll and heave), as the f12026 model blends them
   */
  private rollCentreOf(axleIndex: 0 | 1): number {
    const kin = axleIndex === 0 ? this.frontKin : this.rearKin;
    return 0.75 * this.axles[axleIndex].rollCentreHeight + 0.25 * kin.rollCentreHeightM;
  }

  /**
   * The car's heading laid onto the road plane with normal `up`: the one forward axis gravity, the wheel positions
   * and the render pose all use. Returns a shared scratch vector (read it, don't keep it).
   */
  private headingOnRoad(up: THREE.Vector3): THREE.Vector3 {
    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy = Math.abs(up.y) > 1e-4 ? -(hx * up.x + hz * up.z) / up.y : 0;
    return _fwd.set(hx, fy, hz).normalize();
  }

  private updateGravity(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): void {
    const up = this.localRoadUp(sample);
    const fwd = this.headingOnRoad(up);
    const right = _right.crossVectors(fwd, up).normalize();
    // Gravity (0, −g, 0) expressed in the body frame on the road plane
    this.gravityBody.x = -G * fwd.y;
    this.gravityBody.y = G * right.y; // left = −right
    this.gravityBody.n = G * up.y;
    const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    const rel = Math.cos(this.worldYawRad - heading);
    this.verticalCurvature = THREE.MathUtils.clamp(sample.verticalCurvature * rel * rel, -0.03, 0.03);
  }

  private updateAero(): void {
    const air = computeRelativeAirspeed(
      this.vxMs,
      this.vyMs,
      this.worldYawRad,
      this.windWorldXMs,
      this.windWorldZMs,
      this.relAir
    );
    const q = 0.5 * this.airDensity * air.airspeedSq;
    const beta = Math.abs(air.aeroBetaRad);
    const rollAeroMult = evaluateRollAeroFactor(this.rollRad);

    // Road height under an element, interpolated between the axle contact patches
    const roadF = 0.5 * (this.wheels[0].roadOffset + this.wheels[1].roadOffset);
    const roadR = 0.5 * (this.wheels[2].roadOffset + this.wheels[3].roadOffset);
    const a = this.cgToFrontAxleM;
    const L = this.wheelbaseM;

    // Floor stall: as the plank (the lowest corner) nears the road the floor loses suction and gains drag
    let plankM = Infinity;
    for (const w of this.wheels) plankM = Math.min(plankM, w.rideHeight);
    this.floorStallFactor = floorStallFactorForClearance(plankM);
    const floorStallLoss = (1 - this.floorStallFactor) / (1 - FLOOR_STALL_MIN_FACTOR);
    // The X-mode flap is eased at both ends of its travel (the linear state is kept for the actuator)
    const xb = this.xModeBlend;
    const xEase = xb * xb * (3 - 2 * xb);

    const dhF = this.axles[0].spec.staticRideHeight - VF26_CHASSIS.front.staticRideHeight;
    const dhR = this.axles[1].spec.staticRideHeight - VF26_CHASSIS.rear.staticRideHeight;
    let down = 0;
    let front = 0;
    let drag = 0;
    let pitch = 0;
    let floorGh = 0;
    let floorCount = 0;
    for (const wing of this.wings) {
      const s = wing.spec;
      const angle = wingAngleDeg(s, this.aeroPreset, xEase, this.wingTrimDeg);
      const z = s.position[2];
      const y = s.position[1];
      const isFloor = s.name.startsWith('FLOOR');

      let ghCl = 1;
      let ghCd = 1;
      if (wing.ghCl || wing.ghCd) {
        const frac = THREE.MathUtils.clamp((a - z) / L, -0.3, 1.3);
        const road = roadF + (roadR - roadF) * frac;
        const dh = dhF + (dhR - dhF) * frac;
        const bodyZ = this.heaveM + z * this.pitchRad + dh;
        const hgt = Math.max(0, this.cgHeightM + y + bodyZ - road);
        if (wing.ghCl) ghCl = wing.ghCl.evaluate(hgt);
        if (wing.ghCd) ghCd = wing.ghCd.evaluate(hgt);
        if (isFloor) {
          floorGh += ghCl;
          floorCount++;
        }
      }
      const stallCl = isFloor ? this.floorStallFactor * rollAeroMult : 1;
      const stallCd = isFloor ? 1 + FLOOR_STALL_DRAG_RISE * floorStallLoss : 1;
      const yawMult = Math.max(0, 1 + s.yawClGain * beta);
      const cl = wing.aoaCl.evaluate(angle) * s.clGain * ghCl * stallCl * yawMult;
      const cd = wing.aoaCd.evaluate(angle) * s.cdGain * ghCd * stallCd;
      const fDown = q * wing.area * cl;
      const fDrag = q * wing.area * cd;
      down += fDown;
      front += fDown * THREE.MathUtils.clamp((z + this.cgToRearAxleM) / L, -0.5, 1.5);
      drag += fDrag;
      pitch += -fDown * z + fDrag * y;
    }

    // Apply slipstream & dirty-air vortex wake multipliers (1.0 in clean air)
    const wake = this.aeroWakeState;
    const rearRaw = down - front;
    const frontWaked = front * wake.frontDownforceMultiplier;
    const rearWaked = rearRaw * wake.rearDownforceMultiplier;
    const downWaked = frontWaked + rearWaked;
    const dragWaked = drag * wake.dragMultiplier;

    this.aeroDownforceN = downWaked;
    this.aeroFrontDownforceN = frontWaked;
    this.aeroRearDownforceN = rearWaked;
    this.aeroCopFrontPct = downWaked > 1 ? (100 * frontWaked) / downWaked : 50;
    this.aeroDragN = dragWaked;
    this.aeroPitchMomentNm = pitch * (down > 1 ? downWaked / down : 1);
    // Side force from the body/fin side area (Cy·A ≈ 1.6 m², centre of pressure 0.45 m behind CG)
    this.aeroSideCoef = 0.5 * this.airDensity * 1.6;
    this.groundEffectFactor = floorCount > 0 ? floorGh / floorCount : 1;
  }

  // ---------------------------------------------------------------------------
  // 2 kHz sub-step
  // ---------------------------------------------------------------------------

  private subStep(h: number, throttle: number, roadFrac: number): { ax: number; ay: number } {
    const M = this.totalMassKg;
    const r = -this.yawRateRadS; // CCW yaw rate

    let sumFx = 0;
    let sumFy = 0;
    let sumMz = 0;
    let fyFront = 0;
    let fyRear = 0;
    let fxTyres = 0;
    const roadTorque = _roadTorque.fill(0);

    // ---- Tyre forces ----
    for (const w of this.wheels) {
      const axle = w.isFront ? this.axles[0] : this.axles[1];
      const vbx = this.vxMs - r * w.staticPos.y;
      const vby = this.vyMs + r * w.staticPos.x;
      const cs = Math.cos(w.steerRad);
      const sn = Math.sin(w.steerRad);
      const vxw = vbx * cs + vby * sn;
      const vyw = -vbx * sn + vby * cs;

      // Normal load from the radial tyre spring/damper on the unsprung mass (the spring rate
      // follows the inflation pressure)
      const road = THREE.MathUtils.lerp(w.roadOffsetPrev, w.roadOffset, roadFrac);
      const roadVel = THREE.MathUtils.clamp((w.roadOffset - w.roadOffsetPrev) / F1Physics2026.FIXED_DT, -2, 2);
      const tyreRate = w.tyre.verticalRate;
      const staticDefl = axle.staticTyreLoad / tyreRate;
      const defl = road - w.hubZ + staticDefl;
      const fz = Math.max(0, tyreRate * defl + axle.tyreDamp * (roadVel - w.hubZVel));
      w.fzN = defl > 0 ? fz : 0;
      const radius = tyreRollingRadius(w.tyre, w.fzN, w.spinVel);

      // Camber relative to the road (body roll + 3D wishbone bump camber)
      const sideSign = w.isLeft ? 1 : -1;
      const staticCamber = axle.camberDeg * DEG2RAD;
      const bumpCamber =
        0.75 * axle.spec.camberGainDegPerM * DEG2RAD * w.suspCompression +
        0.25 * (w.kinematicsCamberDeltaRad ?? 0);
      w.camberLeftRad = sideSign * (staticCamber + bumpCamber) - this.rollRad;

      const tin = _tyreIn;
      tin.fz = w.fzN;
      tin.vx = vxw;
      tin.vy = vyw;
      tin.rimSpeed = w.spinVel * radius;
      tin.camberLeftRad = w.camberLeftRad;
      tin.surfaceGrip = w.surfaceFrictionMult;
      tin.inwardSign = w.isLeft ? -1 : 1;
      tin.contactCentroidShiftInward = w.contactCentroidShiftInward;
      tin.contactCentroidShiftLeftM = w.contactCentroidShiftLeftM;
      tin.dt = h;
      const out = computeTyreForces(w.tyre, tin, _tyreOut);
      const hydroDrag =
        w.tyre.waterMm > 0 && vxw > 0.5
          ? hydrodynamicDragN(w.tyre.waterMm, vxw, w.tyre.spec.width, w.fzN)
          : 0;
      const fxWheel = out.fx - hydroDrag;
      w.ftN = fxWheel;
      w.fnN = out.fy;
      w.slipRatio = out.slipRatio;
      w.slipAngleRad = out.slipAngle;
      w.combinedSlipNorm = out.normSlip;
      w.effectiveMu = out.mu;
      w.gripFactor = out.gripFactor;
      w.torqueAlignNm = out.mz;
      w.overturningMomentNm = out.mx;
      w.flatSpotVibrationNm = out.flatSpotVibrationNm;

      const fbx = fxWheel * cs - out.fy * sn;
      const fby = fxWheel * sn + out.fy * cs;
      sumFx += fbx;
      sumFy += fby;
      sumMz += w.staticPos.x * fby - w.staticPos.y * fbx + out.mz;
      fxTyres += fbx;
      if (w.isFront) fyFront += fby;
      else fyRear += fby;

      // Rolling resistance acts on the wheel; surfaces like grass add drag
      const rrMult = w.surfaceType === 'grass' ? 4 : w.surfaceType === 'runoff' ? 2 : 1;
      const rr = w.tyre.spec.rollingResistance * rrMult * w.fzN * radius;
      roadTorque[w.index] = out.fx * radius + (Math.abs(w.spinVel) > 0.05 ? Math.sign(w.spinVel) * rr : 0);
    }

    // ---- Wheel spin: free-rolling fronts ----
    for (let i = 0; i < 2; i++) {
      const w = this.wheels[i];
      const I = w.tyre.spec.angularInertia;
      const free = w.spinVel - (roadTorque[i] / I) * h;
      w.spinVel = this.applyBrakeFriction(free, (w.brakeTorqueNm / I) * h);
    }

    // ---- Rear axle: clutch, gearbox, LSD, engine ----
    this.integrateDrivenAxle(h, throttle, roadTorque[3], roadTorque[2]);

    for (const w of this.wheels) {
      w.rotationRad = (w.rotationRad + w.spinVel * h) % (Math.PI * 2000);
    }

    // ---- Aero, gravity & chassis planar integration ----
    const speed = Math.hypot(this.vxMs, this.vyMs);
    if (speed > 0.1) {
      sumFx -= (this.aeroDragN * this.vxMs) / speed;
      const side = -this.aeroSideCoef * this.vyMs * speed;
      sumFy += side;
      sumMz += -0.45 * side;
    }
    sumFx += M * this.gravityBody.x;
    sumFy += M * this.gravityBody.y;

    // Plank / skid-block contact drag
    for (const w of this.wheels) {
      if (w.rideHeight < 0.003) {
        const pen = 0.003 - w.rideHeight;
        const nForce = 2.5e6 * pen;
        sumFx -= 0.45 * nForce * Math.sign(this.vxMs);
      }
    }

    const ax = sumFx / M;
    const ay = sumFy / M;
    this.vxMs += (ax + r * this.vyMs) * h;
    this.vyMs += (ay - r * this.vxMs) * h;
    const rNew = r + (sumMz / this.yawInertiaKgM2) * h;
    this.yawRateRadS = -rNew;

    this.lastFxTyres = fxTyres;

    // ---- Vertical dynamics ----
    this.integrateVertical(h, roadFrac, fyFront, fyRear, false);

    // ---- World pose ----
    this.worldYawRad = Math.atan2(Math.sin(this.worldYawRad + rNew * h), Math.cos(this.worldYawRad + rNew * h));
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    this.worldX += (this.vxMs * sinYaw + this.vyMs * cosYaw) * h;
    this.worldZ += (this.vxMs * cosYaw - this.vyMs * sinYaw) * h;

    _subStepAcc.ax = ax;
    _subStepAcc.ay = ay;
    return _subStepAcc;
  }

  /** Coulomb brake friction that can stop, but never reverse, a wheel within one step */
  private applyBrakeFriction(omega: number, impulse: number): number {
    if (impulse <= 0) return omega;
    if (Math.abs(omega) <= impulse) return 0;
    return omega - Math.sign(omega) * impulse;
  }

  private integrateDrivenAxle(h: number, throttle: number, roadTqLeft: number, roadTqRight: number): void {
    const drv = this.drivetrain;
    const wl = this.wheels[3];
    const wr = this.wheels[2];
    const Iw = wl.tyre.spec.angularInertia;
    const ratio = this.overallRatio(drv.gear);
    const eta = VF26_DRIVETRAIN.efficiency;
    const Ie = VF26_ENGINE.inertia;
    const Igb = VF26_DRIVETRAIN.gearboxInertia;
    const idle = VF26_ENGINE.idleRpm * RPM2RADS;
    const maxOmega = VF26_ENGINE.maxRpm * RPM2RADS;

    let omegaAxle = 0.5 * (wl.spinVel + wr.spinVel);
    let deltaOmega = wl.spinVel - wr.spinVel;
    const brakeL = wl.brakeTorqueNm;
    const brakeR = wr.brakeTorqueNm;

    const tEngine = this.engineTorque(drv.engineOmega, throttle);
    let tIn: number; // torque delivered into the differential

    if (drv.clutchLocked) {
      // Brake-by-wire MGU-K harvest acts on the rear axle through the gearbox (the rear
      // hydraulic brake torque was reduced by the same amount in outerStep)
      tIn = ratio * tEngine * (tEngine >= 0 ? eta : 1 / eta) - drv.harvestAxleTorqueNm;
      const J = 2 * Iw + (Ie + Igb) * ratio * ratio;
      const free = omegaAxle + ((tIn - roadTqLeft - roadTqRight) / J) * h;
      omegaAxle = this.applyBrakeFriction(free, ((brakeL + brakeR) / J) * h);
      drv.engineOmega = Math.min(maxOmega, omegaAxle * ratio);

      // Auto-clutch opens when the engine would drop below the launch window (anti-stall)
      if (drv.engineOmega < VF26_DRIVETRAIN.autoClutchStartRpm * RPM2RADS || ratio === 0) {
        drv.clutchLocked = false;
        drv.engineOmega = Math.max(idle, drv.engineOmega);
      }
    } else {
      // Launch / anti-stall clutch: engagement follows engine speed (mod: 4000 → 5500 rpm). With the
      // pedal down the window moves up to the launch rpm, so the engine revs up and the clutch slips
      // there instead of bogging the engine at idle.
      const rpm = drv.engineOmega * RADS2RPM;
      const window = VF26_DRIVETRAIN.autoClutchFullRpm - VF26_DRIVETRAIN.autoClutchStartRpm;
      const launch = THREE.MathUtils.clamp((drv.launchPedal - 0.2) / 0.6, 0, 1);
      // Once the car rolls, the launch window comes down to the anti-stall one over launchReleaseS
      drv.launchSlipS = launch > 0 && ratio !== 0 && omegaAxle * Math.sign(ratio) > 1 ? drv.launchSlipS + h : 0;
      const hold = Math.max(0, 1 - drv.launchSlipS / VF26_DRIVETRAIN.launchReleaseS);
      const startRpm =
        VF26_DRIVETRAIN.autoClutchStartRpm +
        launch * hold * Math.max(0, VF26_DRIVETRAIN.launchRpm - window - VF26_DRIVETRAIN.autoClutchStartRpm);
      const engage = THREE.MathUtils.clamp((rpm - startRpm) / window, 0, 1);
      drv.clutchEngagement = engage * engage * (3 - 2 * engage);
      const slip = drv.engineOmega - omegaAxle * ratio;
      const capacity = drv.clutchEngagement * VF26_DRIVETRAIN.clutchMaxTorqueNm;
      const tClutch = ratio !== 0 ? THREE.MathUtils.clamp(slip * 40, -capacity, capacity) : 0;

      drv.engineOmega += ((tEngine - tClutch) / (Ie + 0.002)) * h;
      if (drv.engineOmega < idle) drv.engineOmega = idle; // idle governor
      if (drv.engineOmega > maxOmega) drv.engineOmega = maxOmega;

      // Losses work against the flow of power, as on the locked path: engine braking arrives at the wheels
      // with the loss added, not taken off
      tIn = ratio * tClutch * (tClutch >= 0 ? eta : 1 / eta);
      const J = 2 * Iw + Igb * ratio * ratio;
      const free = omegaAxle + ((tIn - roadTqLeft - roadTqRight) / J) * h;
      omegaAxle = this.applyBrakeFriction(free, ((brakeL + brakeR) / J) * h);

      const slipAfter = drv.engineOmega - omegaAxle * ratio;
      if (ratio !== 0 && Math.abs(slipAfter) < 8 && capacity >= Math.abs(tEngine) * 0.9 && capacity > 50) {
        drv.clutchLocked = true;
        drv.clutchEngagement = 1;
        drv.engineOmega = omegaAxle * ratio;
        drv.launchSlipS = 0;
      }
    }

    // 2026 F1 3-Phase Electronic Differential (Entry / Mid / Exit-HiSpd)
    const gLong = this.lastAxMs2 / G;
    const speedKmh = Math.abs(this.vxMs) * 3.6;
    if (gLong <= -0.5) {
      this.diffActivePhase = 'ENTRY';
    } else if (gLong > 0.5 || speedKmh >= 250) {
      this.diffActivePhase = 'EXIT';
    } else {
      this.diffActivePhase = 'MID';
    }
    const entryLock = 0.08 + (THREE.MathUtils.clamp(this.diffEntryLevel, 1, 12) - 1) * (0.66 / 11);
    const midLv = THREE.MathUtils.clamp(this.diffMidLevel, 1, 12);
    const exitLock = 0.10 + (THREE.MathUtils.clamp(this.diffExitLevel, 1, 12) - 1) * (0.495 / 11);
    let powerLock: number;
    let coastLock: number;
    let preload: number;
    if (this.diffActivePhase === 'ENTRY') {
      coastLock = entryLock;
      powerLock = exitLock * 0.85;
      preload = VF26_DRIVETRAIN.diffPreloadNm * (0.65 + 0.06 * this.diffEntryLevel);
    } else if (this.diffActivePhase === 'MID') {
      const midScale = 0.4 + (midLv - 1) * (1.5 / 11);
      coastLock = 0.5 * (entryLock + exitLock) * (midLv / 5);
      powerLock = coastLock;
      preload = VF26_DRIVETRAIN.diffPreloadNm * midScale;
    } else {
      coastLock = entryLock;
      powerLock = exitLock;
      preload = VF26_DRIVETRAIN.diffPreloadNm * (0.75 + 0.05 * this.diffExitLevel);
    }
    const lock = tIn >= 0 ? powerLock : coastLock;
    const capacity = preload + lock * Math.abs(tIn);
    const sgn = (v: number) => (Math.abs(v) > 0.05 ? Math.sign(v) : 0);
    const dRoad = roadTqLeft + brakeL * sgn(wl.spinVel) - (roadTqRight + brakeR * sgn(wr.spinVel));
    const tReq = ((Iw * deltaOmega) / h) * 0.5 - dRoad * 0.5;
    this.lastLsdTorqueNm = Math.min(Math.abs(tReq), capacity);
    if (Math.abs(tReq) <= capacity) {
      deltaOmega = 0;
      drv.diffLockedFraction = 1;
    } else {
      const tLsd = Math.sign(tReq) * capacity;
      deltaOmega += ((-2 * tLsd - dRoad) / Iw) * h;
      drv.diffLockedFraction = 0;
    }

    wl.spinVel = omegaAxle + deltaOmega * 0.5;
    wr.spinVel = omegaAxle - deltaOmega * 0.5;
  }

  // ---------------------------------------------------------------------------
  // Suspension: sprung heave / pitch / roll + 4 unsprung hubs
  // ---------------------------------------------------------------------------

  private integrateVertical(h: number, roadFrac: number, fyFront: number, fyRear: number, settling: boolean): void {
    const ms = this.sprungMassKg;
    const M = this.totalMassKg;
    const gExtra = this.gravityBody.n - G + this.vxMs * this.vxMs * this.verticalCurvature;
    const sprungShare = ms / M;
    const hcg = this.cgHeightM;

    const dF = _dF.fill(0);
    const comp = _comp.fill(0);
    const compVel = _compVel.fill(0);

    for (const w of this.wheels) {
      const zc = this.heaveM + w.staticPos.x * this.pitchRad + w.staticPos.y * this.rollRad;
      const zcVel = this.heaveVelMs + w.staticPos.x * this.pitchVelRadS + w.staticPos.y * this.rollVelRadS;
      const c = w.hubZ - zc;
      const cv = w.hubZVel - zcVel;
      comp[w.index] = c;
      compVel[w.index] = cv;
      w.suspCompression = c;
      w.suspCompressionVel = cv;

      const axle = w.isFront ? this.axles[0] : this.axles[1];
      const sp = axle.spec;
      const x0 = axle.staticSpringDeflection;
      let f = sp.springRate * c + 0.5 * sp.progressiveRate * ((x0 + c) * Math.abs(x0 + c) - x0 * x0);
      // Two-stage dampers
      const d = sp.damper;
      if (cv >= 0) {
        f += cv <= d.bumpThreshold ? d.bumpSlow * cv : d.bumpSlow * d.bumpThreshold + d.bumpFast * (cv - d.bumpThreshold);
      } else {
        const a = -cv;
        f -= a <= d.reboundThreshold ? d.reboundSlow * a : d.reboundSlow * d.reboundThreshold + d.reboundFast * (a - d.reboundThreshold);
      }
      // Bump rubber
      if (c > sp.bumpStopTravel) {
        const pen = c - sp.bumpStopTravel;
        f += sp.bumpStopRate * pen + 6e7 * pen * pen;
      }
      // Droop limiter (strap)
      if (c < -sp.droopTravel) {
        f += 1.2e6 * (c + sp.droopTravel) + 4000 * Math.min(0, cv);
      }
      dF[w.index] = f;
    }

    // Anti-roll bars and heave (third) elements
    for (let ax = 0; ax < 2; ax++) {
      const axle = this.axles[ax];
      const sp = axle.spec;
      const iR = ax * 2;
      const iL = ax * 2 + 1;
      const fArb = sp.arbRate * (comp[iL] - comp[iR]);
      dF[iL] += fArb;
      dF[iR] -= fArb;

      const cAvg = 0.5 * (comp[iL] + comp[iR]);
      const cAvgVel = 0.5 * (compVel[iL] + compVel[iR]);
      let fHeave = sp.heaveDamping * cAvgVel;
      if (cAvg > 0) {
        fHeave += sp.heaveRate * cAvg + 0.5 * sp.heaveProgressiveRate * cAvg * cAvg;
        if (cAvg > sp.heavePackerTravel) {
          const pen = cAvg - sp.heavePackerTravel;
          fHeave += sp.heavePackerRate * pen + 4e7 * pen * pen;
        }
      }
      dF[iL] += 0.5 * fHeave;
      dF[iR] += 0.5 * fHeave;
    }

    // Floor plank contact supports the body if it bottoms out
    const plank = _plank.fill(0);
    for (const w of this.wheels) {
      const axle = w.isFront ? this.axles[0] : this.axles[1];
      const zc = this.heaveM + w.staticPos.x * this.pitchRad + w.staticPos.y * this.rollRad;
      const road = THREE.MathUtils.lerp(w.roadOffsetPrev, w.roadOffset, roadFrac);
      w.rideHeight = axle.spec.staticRideHeight + zc - road;
      if (w.rideHeight < 0.003) {
        const zcVel = this.heaveVelMs + w.staticPos.x * this.pitchVelRadS + w.staticPos.y * this.rollVelRadS;
        plank[w.index] = 2.5e6 * (0.003 - w.rideHeight) - 6000 * Math.min(0, zcVel);
      }
    }

    // Sprung body
    let fz = -this.aeroDownforceN - ms * gExtra;
    let mPitch = this.aeroPitchMomentNm + (settling ? 0 : this.lastFxTyres * sprungShare * hcg);
    let mRoll =
      settling ? 0 : (fyFront * (hcg - this.rollCentreOf(0)) + fyRear * (hcg - this.rollCentreOf(1))) * sprungShare;
    for (const w of this.wheels) {
      const f = dF[w.index] + plank[w.index];
      fz += f;
      mPitch += f * w.staticPos.x;
      mRoll += f * w.staticPos.y;
    }

    this.heaveVelMs += (fz / ms) * h;
    this.pitchVelRadS += (mPitch / this.pitchInertiaKgM2) * h;
    this.rollVelRadS += (mRoll / this.rollInertiaKgM2) * h;
    this.heaveM += this.heaveVelMs * h;
    this.pitchRad += this.pitchVelRadS * h;
    this.rollRad += this.rollVelRadS * h;

    // Unsprung hubs (geometric roll-centre load transfer acts directly through the links)
    for (const w of this.wheels) {
      const axle = w.isFront ? this.axles[0] : this.axles[1];
      const road = THREE.MathUtils.lerp(w.roadOffsetPrev, w.roadOffset, roadFrac);
      const roadVel = THREE.MathUtils.clamp((w.roadOffset - w.roadOffsetPrev) / F1Physics2026.FIXED_DT, -2, 2);
      const tyreRate = w.tyre.verticalRate;
      const staticDefl = axle.staticTyreLoad / tyreRate;
      const defl = road - w.hubZ + staticDefl;
      const ft = defl > 0 ? Math.max(0, tyreRate * defl + axle.tyreDamp * (roadVel - w.hubZVel)) : 0;
      const fyAxle = settling ? 0 : w.isFront ? fyFront : fyRear;
      const fGeo = (fyAxle * this.rollCentreOf(axle === this.axles[0] ? 0 : 1)) / axle.spec.track;
      const geo = w.isLeft ? -fGeo : fGeo;
      const mu = axle.spec.unsprungMassKg;
      const acc = (ft - axle.staticTyreLoad - dF[w.index] - geo) / mu - gExtra;
      w.hubZVel += acc * h;
      w.hubZ += w.hubZVel * h;
    }
  }

  // ---------------------------------------------------------------------------
  // Track projection, barriers, timing
  // ---------------------------------------------------------------------------

  private postIntegrate(prevS: number, prevX: number, prevZ: number): void {
    let projected = this.track.projectWorldToTrack(this.worldX, this.worldZ, prevS);
    // Barrier height test against the road under the car, so a bridge's parapets (Suzuka's crossover) or the
    // barriers of a road passing below are not hit. The window spans both the centreline and the ground under the
    // car: on a banked corner's wide run-off the barrier stands well above (outside) or below (inside) the centreline
    const roadY = projected.sample.position.y;
    const groundY = evaluateSampleLateralHeightM(projected.sample, projected.lateralOffset);
    const carY = 0.5 * (roadY + groundY) + WALL_CAR_Y_M;
    const ySlack = WALL_Y_SLACK_M + 0.5 * Math.abs(groundY - roadY);
    if (this.walls ? this.applyWallSegments(prevX, prevZ, carY, ySlack) : this.applyWallLines(projected)) {
      projected = this.track.projectWorldToTrack(this.worldX, this.worldZ, prevS);
    }
    const nextSample = projected.sample;
    this.sMeters = projected.s;
    this.lateralOffsetM = projected.lateralOffset;

    const trackHeadingRad = Math.atan2(nextSample.tangent.x, nextSample.tangent.z);
    let headingErr = trackHeadingRad - this.worldYawRad;
    while (headingErr > Math.PI) headingErr -= Math.PI * 2;
    while (headingErr < -Math.PI) headingErr += Math.PI * 2;
    this.headingErrorRad = headingErr;

    this.lastSyncedSMeters = this.sMeters;
    this.lastSyncedLateralOffsetM = this.lateralOffsetM;
    this.lastSyncedHeadingErrorRad = this.headingErrorRad;

    if (nextSample.sector !== this.lastSector) {
      this.onSectorCompleted(this.lastSector);
      this.lastSector = nextSample.sector;
    }
    if (prevS > this.track.totalLengthM * 0.85 && this.sMeters < this.track.totalLengthM * 0.15) {
      if (this.lineCrossingStartsLap) {
        this.lineCrossingStartsLap = false;
        this.currentLapStartMs = this.simTimeMs;
        this.currentSectorStartMs = this.simTimeMs;
      } else {
        this.onLapCompleted();
      }
    }
  }

  /**
   * Barriers on the track GLB's wall segments: the CG's path is swept so it never ends up behind a wall, then every
   * outline point past one is pushed back out. Only segments spanning `carY` (± `ySlack`) count. Returns
   * whether the car was moved.
   */
  private applyWallSegments(prevX: number, prevZ: number, carY: number, ySlack: number): boolean {
    const walls = this.walls!;
    const ids = this.wallIds;
    const n = walls.near(this.worldX, this.worldZ, this.wallQueryRadius + Math.hypot(this.worldX - prevX, this.worldZ - prevZ), ids);
    if (n === 0) return false;
    let moved = false;
    if (wallSweep(walls, ids, n, prevX, prevZ, this.worldX, this.worldZ, carY, ySlack, _wallHit) >= 0) {
      this.worldX += _wallHit.nx * (_wallHit.depth + WALL_SKIN_M);
      this.worldZ += _wallHit.nz * (_wallHit.depth + WALL_SKIN_M);
      this.wallImpulse(0, 0, _wallHit.nx, _wallHit.nz);
      moved = true;
    }
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    for (const [left, fwd] of this.wallProbePoints) {
      // World offset of the point: left = (cos ψ, −sin ψ), forward = (sin ψ, cos ψ)
      const rx = cosYaw * left + sinYaw * fwd;
      const rz = -sinYaw * left + cosYaw * fwd;
      const depth = wallPenetration(walls, ids, n, this.worldX + rx, carY, this.worldZ + rz, this.worldX, this.worldZ, WALL_MAX_DEPTH_M, ySlack, _wallHit);
      if (depth <= 0) continue;
      this.wallImpulse(rx, rz, _wallHit.nx, _wallHit.nz);
      this.worldX += _wallHit.nx * (depth + WALL_SKIN_M);
      this.worldZ += _wallHit.nz * (depth + WALL_SKIN_M);
      moved = true;
    }
    return moved;
  }

  /**
   * Barriers on the track data's per-sample barrier lines (no GLB attached): the CG, then every outline point, is
   * projected onto the track and pushed back inside its side's line. Returns whether the car was moved.
   */
  private applyWallLines(cg: TrackProjection): boolean {
    const near = cg.lateralOffset >= 0 ? 1 : -1;
    if (Math.abs(cg.lateralOffset) + this.wallQueryRadius + 1.5 < this.wallLineLat(cg.sample, near)) return false;
    let moved = false;
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    for (let k = -1; k < this.wallProbePoints.length; k++) {
      const [left, fwd] = k < 0 ? [0, 0] : this.wallProbePoints[k];
      const rx = cosYaw * left + sinYaw * fwd;
      const rz = -sinYaw * left + cosYaw * fwd;
      const pr = this.track.projectWorldToTrack(this.worldX + rx, this.worldZ + rz, cg.s);
      const side = pr.lateralOffset >= 0 ? 1 : -1;
      const smp = pr.sample;
      const over = Math.abs(pr.lateralOffset) - this.wallLineLat(smp, side);
      if (over <= 0) continue;
      // Normal back toward the track, tilted by the line's slope along the lap
      const slope =
        0.5 *
        (this.wallLineLat(this.track.getSampleAtDistance(pr.s + 1), side) -
          this.wallLineLat(this.track.getSampleAtDistance(pr.s - 1), side));
      const bl = Math.hypot(smp.binormal.x, smp.binormal.z) || 1;
      const tl = Math.hypot(smp.tangent.x, smp.tangent.z) || 1;
      let nx = (-side * smp.binormal.x) / bl + (slope * smp.tangent.x) / tl;
      let nz = (-side * smp.binormal.z) / bl + (slope * smp.tangent.z) / tl;
      const nl = Math.hypot(nx, nz);
      nx /= nl;
      nz /= nl;
      this.wallImpulse(rx, rz, nx, nz);
      this.worldX += nx * (over / nl + WALL_SKIN_M);
      this.worldZ += nz * (over / nl + WALL_SKIN_M);
      moved = true;
    }
    return moved;
  }

  /** The track data's barrier line on one side (lateral offset, m), at least WALL_LINE_MIN_RUNOFF_M past the edge */
  private wallLineLat(smp: ReturnType<BuiltTrackData['getSampleAtDistance']>, side: number): number {
    const wall = side > 0 ? smp.wallRightM : smp.wallLeftM;
    const edge = smp.width * 0.5;
    return wall !== undefined ? Math.max(edge + WALL_LINE_MIN_RUNOFF_M, wall) : edge + WALL_LINE_DEFAULT_RUNOFF_M;
  }

  /**
   * Barrier impulse at the world lever arm (rx, rz) from the CG against a wall with normal (nx, nz), on the planar
   * body (mass, yaw inertia): the into-wall speed there becomes a rebound of WALL_RESTITUTION × that speed (at most
   * WALL_MAX_REBOUND_MS), and wall friction scrubs the sliding speed along the barrier.
   */
  private wallImpulse(rx: number, rz: number, nx: number, nz: number): void {
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    let vwx = this.vxMs * sinYaw + this.vyMs * cosYaw;
    let vwz = this.vxMs * cosYaw - this.vyMs * sinYaw;
    // Yaw rate about +Y (world), so the point moves at v + ω × r = (vx + ω rz, vz − ω rx)
    let w = -this.yawRateRadS;
    const vn = (vwx + w * rz) * nx + (vwz - w * rx) * nz;
    if (vn >= 0) return;
    const invM = 1 / this.totalMassKg;
    const invI = 1 / this.yawInertiaKgM2;
    const rn = rz * nx - rx * nz;
    const jn = (Math.min(WALL_RESTITUTION * -vn, WALL_MAX_REBOUND_MS) - vn) / (invM + rn * rn * invI);
    vwx += jn * nx * invM;
    vwz += jn * nz * invM;
    w += jn * rn * invI;
    const tx = -nz;
    const tz = nx;
    const vt = (vwx + w * rz) * tx + (vwz - w * rx) * tz;
    const rt = rz * tx - rx * tz;
    const jt = -Math.sign(vt) * Math.min(Math.abs(vt) / (invM + rt * rt * invI), WALL_FRICTION * jn);
    vwx += jt * tx * invM;
    vwz += jt * tz * invM;
    w += jt * rt * invI;
    this.vxMs = vwx * sinYaw + vwz * cosYaw;
    this.vyMs = vwx * cosYaw - vwz * sinYaw;
    this.yawRateRadS = -w;
  }

  /** Computes the world positions of the 4 contact points on the local road plane */
  private updateWheelWorldPositions(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): void {
    const carGroundY = evaluateSampleLateralHeightM(sample, this.lateralOffsetM);
    const carUp = this.localRoadUp(sample);
    const f = this.headingOnRoad(carUp);
    const r = _right.crossVectors(f, carUp).normalize();
    for (const w of this.wheels) {
      w.worldPos.x = this.worldX + f.x * w.staticPos.x - r.x * w.staticPos.y;
      w.worldPos.y = carGroundY + f.y * w.staticPos.x - r.y * w.staticPos.y;
      w.worldPos.z = this.worldZ + f.z * w.staticPos.x - r.z * w.staticPos.y;
    }
  }

  /**
   * Grip share (0.05 steps, 0.25..1) the autopilot plans its corner speeds and braking points with on a wet road,
   * from the fitted compound's wet traits and the water under the car. 1 in the dry.
   */
  public aiPlanGrip(): number {
    if (this.weatherSample.waterMm <= 0) return 1;
    const traits = WET_TYRE_TRAITS[this.tireCompound];
    const grip = traits.dryGrip * wetGripFactor(traits, this.weatherSample.waterMm, AI_PLAN_WET_REF_MS, this.realism.wetSeverity);
    // Planned a little under the tyre's water grip: wet kerbs, the polished line and the front-limited braking on
    // a wet road all take more than the film alone, and the plan at the full figure runs the car wide
    const margin = AI_PLAN_WET_MARGIN * this.weatherSample.wetness;
    return Math.max(0.25, Math.min(1, Math.round(grip * (1 - margin) * 20) / 20));
  }

  /** Target-speed profile for the AI, rebuilt when the aero package or the road's wet grip changes */
  /** A drive plan as the racing line driver's profile, on the track samples it reads (built once per plan) */
  private planProfile(plan: AiDrivePlan): SpeedProfile {
    const c = this.planProfileCache;
    if (c && c.plan === plan) return c.profile;
    const samples = this.track.samples;
    const n = samples.length;
    const ds = plan.track.ds;
    const lineOffsetM = new Float64Array(n), curvature = new Float64Array(n), speedMs = new Float64Array(n);
    const pointX = new Float64Array(n), pointZ = new Float64Array(n), segLenM = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const smp = samples[i];
      const off = sampleGrid(plan.n, smp.s, ds);
      lineOffsetM[i] = off;
      curvature[i] = sampleGrid(plan.kappa, smp.s, ds);
      speedMs[i] = sampleGrid(plan.v, smp.s, ds);
      const bl = Math.hypot(smp.binormal.x, smp.binormal.z) || 1;
      pointX[i] = smp.position.x + (smp.binormal.x / bl) * off;
      pointZ[i] = smp.position.z + (smp.binormal.z / bl) * off;
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segLenM[i] = Math.max(0.1, Math.hypot(pointX[j] - pointX[i], pointZ[j] - pointZ[i]));
    }
    const profile = { lineOffsetM, curvature, speedMs, brakeEnvelopeMs: speedMs, segLenM, pointX, pointZ } as unknown as SpeedProfile;
    this.planProfileCache = { plan, profile };
    return profile;
  }

  private getAiPlan(): { profile: SpeedProfile; params: AiVehicleParams } {
    const grip = this.aiPlanGrip();
    // Planned on the wings the car actually runs, garage clicks included
    const trim = this.wingTrimDeg;
    // Planned for the car as it is (fuel load, in 10 kg steps) in this circuit's air (0.02 kg/m³ steps): a full tank
    // corners slower, and a sea-level track gives ~13 % more downforce than the 1400 m of the nominal profile
    const massKg = Math.round(this.totalMassKg / 10) * 10;
    const rho = Math.round(this.computeAirDensity(this.track.baseAltitudeM ?? BASE_ALTITUDE_M) * 50) / 50;
    const p = this.aiProfile;
    if (!p || p.preset !== this.aeroPreset || p.grip !== grip || p.trim !== trim || p.massKg !== massKg || p.rho !== rho) {
      const car = withPlanningGrip({ ...createVf26ProfileCarModel(this.aeroPreset, rho, trim), massKg }, grip);
      this.aiProfile = {
        preset: this.aeroPreset,
        grip,
        trim,
        massKg,
        rho,
        profile: computeSpeedProfile(this.track.samples, car),
        params: {
          wheelbaseM: this.wheelbaseM,
          maxSteerLockRad: this.maxSteerAngleRad,
          car,
          fullBrakeForceN: vf26FullBrakeForceN(),
          aeroTransitionS: VF26_ACTIVE_AERO_TRANSITION_S,
        },
      };
      return this.aiProfile;
    }
    return p;
  }

  private buildObservation(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): RaceGymObservation {
    const { lookaheadCurvatures, lookaheadTargetSpeedsMs } = computeLookaheadVectors(this.track, this.sMeters);
    const racelineOffsetM = aiLineOffsetM(sample);
    const gapToRacingLineM = this.lateralOffsetM - racelineOffsetM;
    let wheelsOut = 0;
    for (const w of this.wheels) {
      if (w.surfaceType === 'runoff' || w.surfaceType === 'grass') wheelsOut++;
    }
    const W = this.wheels;
    return {
      speedMs: this.vxMs,
      localVelocityX: this.vxMs,
      localVelocityY: this.vyMs,
      localVelocityZ: this.vzMs,
      angularVelocityX: this.rollVelRadS,
      angularVelocityY: this.pitchVelRadS,
      angularVelocityZ: -this.yawRateRadS,
      accelX: this.lastAxMs2,
      accelY: this.lastAyMs2,
      rollRad: this.rollRad,
      pitchRad: this.pitchRad,
      yawRad: this.worldYawRad,
      engineRpm: this.rpm,
      gear: this.gear,
      normalizedSplinePosition: this.sMeters / this.track.totalLengthM,
      gapToRacingLineM,
      lateralOffsetCenterM: this.lateralOffsetM,
      headingErrorRad: this.headingErrorRad,
      slipAngleRad: [W[0].slipAngleRad, W[1].slipAngleRad, W[2].slipAngleRad, W[3].slipAngleRad],
      slipRatio: [W[0].slipRatio, W[1].slipRatio, W[2].slipRatio, W[3].slipRatio],
      tyreLoadN: [W[0].fzN, W[1].fzN, W[2].fzN, W[3].fzN],
      rideHeightM: [W[0].rideHeight, W[1].rideHeight, W[2].rideHeight, W[3].rideHeight],
      tyreTempC: [W[0].tyre.surfaceTempC, W[1].tyre.surfaceTempC, W[2].tyre.surfaceTempC, W[3].tyre.surfaceTempC],
      lookaheadCurvatures,
      lookaheadTargetSpeedsMs,
      wheelsOutOfTrack: wheelsOut,
      outOfTrack: wheelsOut >= 3,
    };
  }

  // ===========================================================================
  // Telemetry
  // ===========================================================================

  private createInitialTelemetry(): CarTelemetry {
    return {
      speedKmh: 0,
      speedMs: 0,
      rpm: VF26_ENGINE.idleRpm,
      gear: 1,
      throttle: 0,
      brake: 0,
      clutch: 0,
      steering: 0,
      longitudinalG: 0,
      lateralG: 0,
      verticalG: 1,
      altitudeM: BASE_ALTITUDE_M + 35,
      trackElevationM: 35,
      airDensityKgM3: 1.06,
      activeAeroMode: 'Z_MODE',
      autoXMode: true,
      downforceN: 0,
      downforceKgf: 0,
      frontDownforceN: 0,
      rearDownforceN: 0,
      groundEffectFactor: 1.0,
      aeroCopFrontPct: 50,
      floorStallFactor: 1,
      dragN: 0,
      icePowerKw: 0,
      mgukPowerKw: 0,
      totalPowerKw: 0,
      ersBatteryPercent: 100,
      manualOverrideActive: false,
      boostRemainingS: 0,
      turboBoostBar: 1.0,
      fuelKg: startingFuelKg('vf26', this.chassis),
      tireSlipRatio: [0, 0, 0, 0],
      wheelSlipRatios: [0, 0, 0, 0],
      wheelSlipAnglesDeg: [0, 0, 0, 0],
      wheelLoadsN: [0, 0, 0, 0],
      wheelRideHeightsMm: [44, 44, 60, 60],
      suspensionTravelMm: [0, 0, 0, 0],
      suspensionVelocityMs: [0, 0, 0, 0],
      tireTempsC: [INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C],
      tireWearPct: [0, 0, 0, 0],
      tireFlatSpotSeverity: [0, 0, 0, 0],
      tireGrainLevel: [0, 0, 0, 0],
      tireBlisterLevel: [0, 0, 0, 0],
      tireDirtyLevel: [0, 0, 0, 0],
      tireGripFactor: [1, 1, 1, 1],
      brakeTempsC: [INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C],
      brakeCoreTempsC: [INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C],
      brakePadMuFactor: [1, 1, 1, 1],
      aeroWakeDragMult: 1,
      aeroWakeDownforceMult: 1,
      wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
      frontSlipAngleDeg: 0,
      rearSlipAngleDeg: 0,
      ffbTorqueNorm: 0,
      ffbClipping: false,
      ffbSubframeSamples: [],
      onKerbLeft: false,
      onKerbRight: false,
      offTrack: false,
      surface: 'asphalt',
      trackDistanceM: 35,
      trackProgress: 35 / this.track.totalLengthM,
      lateralOffsetM: 0,
      gapToRacingLineM: 0,
      headingErrorRad: 0,
      targetCornerSpeedKmh: 295,
      brakingUrgency: 0,
      currentSector: 1,
      currentTurnNumber: 0,
      currentTurnName: 'Main Straight — Starting Grid',
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

  private updateTelemetrySnapshot(
    sample: ReturnType<BuiltTrackData['getSampleAtDistance']>,
    inputs: ControlInputs
  ): void {
    const t = this.telemetry;
    const drv = this.drivetrain;
    const speedKmh = Math.max(0, this.vxMs * 3.6);
    if (speedKmh > t.topSpeedThisLapKmh) t.topSpeedThisLapKmh = speedKmh;
    if (speedKmh > t.allTimeTopSpeedKmh) t.allTimeTopSpeedKmh = speedKmh;

    const icePowerKw = Math.max(0, (drv.iceTorqueNm * drv.engineOmega) / 1000);
    const mgukPowerKw = drv.mgukPowerW / 1000;

    // CarTelemetry 4-wheel arrays are ordered [FL, FR, RL, RR]
    const order = [1, 0, 3, 2] as const;
    const W = order.map((i) => this.wheels[i]);
    const quad = <T,>(f: (w: VehicleWheelState) => T): [T, T, T, T] => [f(W[0]), f(W[1]), f(W[2]), f(W[3])];

    const onKerbLeft = W[0].surfaceType === 'kerb' || W[2].surfaceType === 'kerb';
    const onKerbRight = W[1].surfaceType === 'kerb' || W[3].surfaceType === 'kerb';
    const offTrack = this.lastObservation.outOfTrack;
    if (offTrack && this.trackLimitsMode === 'strict') this.lapValid = false;
    t.lapInvalid = !this.lapValid;

    let dominantSurface: SurfaceType = 'asphalt';
    if (onKerbLeft || onKerbRight) dominantSurface = 'kerb';
    else if (W[0].surfaceType === 'grass' || W[1].surfaceType === 'grass') dominantSurface = 'grass';
    else if (W[0].surfaceType === 'runoff' || W[1].surfaceType === 'runoff') dominantSurface = 'runoff';

    const markerS = (this.sMeters + 25) % this.track.totalLengthM;
    const brakingUrgency = evaluateDynamicBrakingUrgency(this.track, this.sMeters, this.vxMs, markerS, this.brakingGuide);

    t.speedMs = this.vxMs;
    t.speedKmh = speedKmh;
    t.rpm = Math.round(this.rpm);
    t.gear = this.gear;
    t.throttle = this.aiAutopilot ? THREE.MathUtils.clamp(drv.iceTorqueNm / 450, 0, 1) : inputs.throttle;
    t.brake = this.aiAutopilot
      ? THREE.MathUtils.clamp(this.wheels[1].brakeTorqueNm / (VF26_BRAKES.maxTorqueNm * VF26_BRAKES.frontBias), 0, 1)
      : inputs.brake;
    t.clutch = drv.clutchLocked ? 1 : drv.clutchEngagement;
    t.steering = this.steerAngleNorm;
    t.longitudinalG = this.lastAxMs2 / G;
    t.lateralG = -this.lastAyMs2 / G;
    t.verticalG = 1 + this.aeroDownforceN / (this.totalMassKg * G);

    t.altitudeM = BASE_ALTITUDE_M + sample.position.y;
    t.trackElevationM = sample.position.y;
    t.airDensityKgM3 = this.airDensity;
    t.activeAeroMode = this.activeAeroMode;
    t.autoXMode = this.autoXMode;
    t.downforceN = this.aeroDownforceN;
    t.downforceKgf = this.aeroDownforceN / G;
    t.frontDownforceN = this.aeroFrontDownforceN;
    t.rearDownforceN = this.aeroRearDownforceN;
    t.groundEffectFactor = this.groundEffectFactor;
    t.aeroCopFrontPct = this.aeroCopFrontPct;
    t.floorStallFactor = this.floorStallFactor;
    t.dragN = this.aeroDragN;

    t.icePowerKw = icePowerKw;
    t.mgukPowerKw = mgukPowerKw;
    t.totalPowerKw = Math.max(0, icePowerKw + Math.max(0, mgukPowerKw));
    t.ersBatteryPercent = (drv.ersEnergyJ / VF26_ERS.batteryJ) * 100;
    t.manualOverrideActive = drv.ersMode === 'OVERRIDE' || drv.boostRemainingS > 0;
    t.boostRemainingS = drv.boostRemainingS;
    t.overtakingRules = this.overtakingRules;
    t.overtakeAvailable = this.overtake.available(this.raceControl);
    t.turboBoostBar = 1 + drv.boostBar;
    t.fuelKg = drv.fuelKg;

    t.tireSlipRatio = quad((w) => w.combinedSlipNorm);
    t.wheelSlipRatios = quad((w) => w.slipRatio);
    t.wheelSlipAnglesDeg = quad((w) => THREE.MathUtils.radToDeg(w.slipAngleRad));
    t.wheelLoadsN = quad((w) => Math.round(w.fzN));
    t.wheelRideHeightsMm = quad((w) => Math.round(w.rideHeight * 1000));
    t.suspensionTravelMm = quad((w) => {
      const ax = w.isFront ? this.axles[0] : this.axles[1];
      return Number(((ax.staticSpringDeflection + w.suspCompression) * 1000).toFixed(2));
    });
    t.suspensionVelocityMs = quad((w) => w.suspCompressionVel);
    t.tireTempsC = quad((w) => Math.round(0.6 * w.tyre.surfaceTempC + 0.4 * w.tyre.coreTempC));
    t.tireWearPct = quad((w) => Number((w.tyre.wear * 100).toFixed(1)));
    t.tireFlatSpotSeverity = quad((w) => Number(w.tyre.flatSpotSeverity.toFixed(3)));
    t.tireGrainLevel = quad((w) => Number(w.tyre.grainLevel.toFixed(3)));
    t.tireBlisterLevel = quad((w) => Number(w.tyre.blisterLevel.toFixed(3)));
    t.tireDirtyLevel = quad((w) => Number(w.tyre.dirtyLevel.toFixed(3)));
    t.tireBandTempsC = quad((w) => {
      // Inner / middle / outer surface temperatures, listed left to right as seen from behind
      const imo: [number, number, number] = [0, 1, 2].map((b) => Math.round(tyreBandSurfaceTempC(w.tyre, b))) as [
        number,
        number,
        number,
      ];
      return w.isLeft ? [imo[2], imo[1], imo[0]] : imo;
    });
    t.tirePressuresPsi = quad((w) => Number(w.tyre.pressurePsi.toFixed(1)));
    t.tireOptimalPsi = quad((w) => w.tyre.spec.pressureRefPsi);
    t.tireOptimalTempC = thermalWindowC(W[0].tyre.spec.thermalCurve);
    t.tireGripFactor = quad((w) => Number(w.gripFactor.toFixed(2)));
    t.brakeTempsC = quad((w) => Math.round(w.brakeTempC));
    t.brakeCoreTempsC = quad((w) => Math.round(w.brakeDisc.coreTempC));
    t.brakePadMuFactor = quad((w) => Number(w.brakeDisc.muFactor.toFixed(3)));
    t.aeroWakeDragMult = Number(this.aeroWakeState.dragMultiplier.toFixed(3));
    t.aeroWakeDownforceMult = Number(
      (0.5 * (this.aeroWakeState.frontDownforceMultiplier + this.aeroWakeState.rearDownforceMultiplier)).toFixed(3)
    );
    t.wheelSurfaces = quad((w) => w.surfaceType);

    t.frontSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[0] + t.wheelSlipAnglesDeg[1]);
    t.rearSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[2] + t.wheelSlipAnglesDeg[3]);
    t.ffbTorqueNorm = this.ffbTorqueNorm;
    t.ffbClipping = Math.abs(this.ffbTorqueNorm) > 0.95;
    t.ffbSubframeSamples = [...this.ffbSubframeSamples];

    t.onKerbLeft = onKerbLeft;
    t.onKerbRight = onKerbRight;
    t.offTrack = offTrack;
    t.surface = dominantSurface;

    t.trackDistanceM = this.sMeters;
    t.trackProgress = this.sMeters / this.track.totalLengthM;
    t.lateralOffsetM = this.lateralOffsetM;
    t.gapToRacingLineM = this.lastObservation.gapToRacingLineM;
    t.headingErrorRad = this.headingErrorRad;
    t.targetCornerSpeedKmh = this.aiAutopilot
      ? this.aiTargetSpeedKmh
      : Math.round(sampleProfile(this.brakingGuide.speedMs, this.sMeters, this.track.totalLengthM) * 3.6);
    t.brakingUrgency = brakingUrgency;
    t.currentSector = sample.sector;
    t.currentTurnNumber = sample.turnNumber;
    t.currentTurnName = sample.turnName;
    t.bankingDeg = THREE.MathUtils.radToDeg(sample.bankingRad);
    t.slopePercent = sample.slopeSin * 100;
    t.currentLapTimeMs = Math.max(0, this.simTimeMs - this.currentLapStartMs);
    t.aiAutopilot = this.aiAutopilot;
    t.liveTuner = this.getLiveTunerState();
  }

  private onSectorCompleted(completedSector: 1 | 2 | 3): void {
    const nowMs = this.simTimeMs;
    const sectorDuration = nowMs - this.currentSectorStartMs;
    this.currentSectorStartMs = nowMs;
    const idx = completedSector - 1;
    if (sectorDuration > 8000) {
      this.telemetry.sectorTimesMs[idx] = sectorDuration;
      const prevBest = this.telemetry.bestSectorTimesMs[idx];
      if (prevBest === null || sectorDuration < prevBest) {
        this.telemetry.bestSectorTimesMs[idx] = sectorDuration;
      }
    }
  }

  private onLapCompleted(): void {
    const nowMs = this.simTimeMs;
    const lapTime = nowMs - this.currentLapStartMs;
    this.onSectorCompleted(3);
    this.currentLapStartMs = nowMs;
    // Judged track limits: a lap that ends while an excursion is still being judged cannot count
    const valid = this.lapValid && !(this.trackLimitsMode === 'judged' && (this.trackLimitsHold || this.lastObservation.outOfTrack));
    if (lapTime > 45_000) {
      this.telemetry.lastLapTimeMs = lapTime;
      if (valid && (this.telemetry.bestLapTimeMs === null || lapTime < this.telemetry.bestLapTimeMs)) {
        this.telemetry.bestLapTimeMs = lapTime;
      }
    }
    this.telemetry.lastLapValid = valid;
    this.telemetry.lapCount++;
    this.telemetry.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.lapValid = true;
    this.telemetry.lapInvalid = false;
  }

  /** Race control deleted the running lap (judged track limits) */
  public invalidateLap(): void {
    this.lapValid = false;
    this.telemetry.lapInvalid = true;
  }

  private syncWorldTransform(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    let exactGroundY = evaluateSampleLateralHeightM(sample, this.lateralOffsetM);
    if (this.ground && this.ground.query(this.worldX, this.worldZ, exactGroundY + 0.6, _groundHit)) {
      if (Math.abs(_groundHit.height - exactGroundY) < 0.5) {
        exactGroundY = _groundHit.height;
      }
    }
    this.worldPosition.set(this.worldX, exactGroundY, this.worldZ);

    const carUp = this.localRoadUp(sample);
    const carForward = this.headingOnRoad(carUp);
    const carLeft = _right.crossVectors(carUp, carForward).normalize();
    const basis = _basis.makeBasis(carLeft, carUp, carForward);
    this.worldQuaternion.setFromRotationMatrix(basis);
    this.worldVelocity
      .copy(carForward)
      .multiplyScalar(this.vxMs)
      .addScaledVector(carLeft, this.vyMs)
      .addScaledVector(carUp, this.heaveVelMs);
  }
}
