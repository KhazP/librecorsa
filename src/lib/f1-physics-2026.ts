/**
 * 2026 Formula 1 vehicle dynamics — VF26 physics (`f1-physics-2026.ts`)
 *
 * A clean, assist-free rigid-body vehicle model driven by the VF26 parameter set
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
 *                 relaxation-length carcass (no low-speed hacks needed).
 * - Aero:         11 wing elements (AoA & ground-height LUTs, yaw sensitivity) incl. 2026 X/Z-mode.
 * - Power unit:   ICE torque × (1 + turbo boost), MGU-K deploy/harvest with ERS controller
 *                 curves, 4 MJ store, 350 kW limit, brake-by-wire blending on the rear axle.
 * - Drivetrain:   seamless 8-speed, auto-clutch launch, limited-slip differential, engine inertia.
 * - Brakes:       max-torque / bias model with disc thermal state.
 *
 * Nothing in here steers, stabilises or damps the car artificially. Driver aids (TC / ABS) only exist
 * when the player selects them and they act like real ECU aids — on pedal inputs.
 */

import * as THREE from 'three';
import type {
  ActiveAeroMode,
  AeroSetupPreset,
  CarTelemetry,
  ControlInputs,
  DriverAssistPreset,
  ERSMode,
  SurfaceType,
  TireCompound,
  TyreSetup,
} from '@/types/f1';
export type { ControlInputs };
import {
  BASE_ALTITUDE_M,
  type BuiltTrackData,
  evaluateSampleLateralHeightM,
  getRwandaTrackData,
} from './track-data';
import { Lut } from './sim/lut';
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
  VF26_WINGS,
  type Vf26AxleSuspension,
} from './sim/vf26-data';
import {
  createWallHit,
  TrackWallQuery,
  wallPenetration,
  type WallQuery,
  wallSweep,
} from './sim/f12026-car/TrackColliderQuery';
import { createWingRuntimes, VF26_CG_HEIGHT_M, type WingRuntime, wingAngleDeg } from './sim/vf26-aero';
import {
  coldPressureFor,
  computeTyreForces,
  createTyreRuntime,
  setTyreColdPressure,
  setTyreSpec,
  tyreBandSurfaceTempC,
  tyreLoadedRadius,
  tyreRollingRadius,
  tyreVerticalDeflection,
  updateTyreThermal,
} from './sim/ac-tyre';
import type { TyreVisualState } from './sim/simulator-car';
import type { VehicleWheelState, WheelCornerIndex } from './sim/vehicle-types';
import {
  type AssettoCorsaGymObservation,
  computeLookaheadVectors,
  evaluateDynamicBrakingUrgency,
  queryWheelGroundContact,
} from './sim/track-occupancy';
import { type AiVehicleParams, RacingLineDriver } from './sim/ai-mpc';
import { GamepadSteeringAssist } from './sim/gamepad-assist';
import {
  aiLineOffsetM,
  computeSpeedProfile,
  createVf26ProfileCarModel,
  type SpeedProfile,
  vf26FullBrakeForceN,
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
/** Track-data barrier lines: least run-off before one (m past the track edge), and the line where the data has none */
const WALL_LINE_MIN_RUNOFF_M = 2.5;
const WALL_LINE_DEFAULT_RUNOFF_M = 5.8;

type TrackProjection = ReturnType<BuiltTrackData['projectWorldToTrack']>;

/** Barrier walls built once per loaded track root and shared by every VF26 */
const wallCache = new WeakMap<THREE.Object3D, WallQuery>();
const _wallHit = createWallHit();

/**
 * Floor suction factor for the lowest corner's plank clearance (m): 1 above 6 mm, smoothstep down to
 * 0.55 at 4 mm and below.
 */
export function floorStallFactorForClearance(clearanceM: number): number {
  const t = THREE.MathUtils.clamp((FLOOR_STALL_START_M - clearanceM) / (FLOOR_STALL_START_M - FLOOR_STALL_FULL_M), 0, 1);
  return 1 - (1 - FLOOR_STALL_MIN_FACTOR) * t * t * (3 - 2 * t);
}

/** Garage defaults: the cold pressure that reaches the reference (hot) pressure, to 0.1 psi, and the static camber */
function defaultTyreSetup(): TyreSetup {
  const round = (psi: number) => Math.round(psi * 10) / 10;
  return {
    coldPressurePsi: {
      front: round(coldPressureFor(VF26_TYRES.soft.front.pressureRefPsi)),
      rear: round(coldPressureFor(VF26_TYRES.soft.rear.pressureRefPsi)),
    },
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
  rollCentreHeight: number;
  /** Static sprung load carried by each corner spring (N) */
  staticSpringForce: number;
  /** Static spring deflection (m) */
  staticSpringDeflection: number;
  /** Static tyre load per wheel (N) */
  staticTyreLoad: number;
  tyreRate: number;
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

export class F1Physics2026 {
  /** Fixed 500 Hz simulation step decoupled from render FPS */
  public static readonly FIXED_DT = 0.002;

  private track: BuiltTrackData;
  private timeAccumulator = 0;

  // Chassis constants (exposed for camera / HUD / AI)
  public readonly massKg: number = VF26_CHASSIS.totalMassKg;
  public readonly wheelbaseM: number = VF26_CHASSIS.wheelbase;
  public readonly wheeltrackM: number = (VF26_CHASSIS.front.track + VF26_CHASSIS.rear.track) * 0.5;
  public readonly cgToFrontAxleM: number = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
  public readonly cgToRearAxleM: number = VF26_CHASSIS.wheelbase * VF26_CHASSIS.frontWeightFraction;
  public readonly cgHeightM: number = VF26_CG_HEIGHT_M;
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
  private readonly wallIds = new Int32Array(256);
  private readonly wallQueryRadius = Math.max(...this.wallProbePoints.map(([x, z]) => Math.hypot(x, z))) + 0.5;

  public aeroPreset: AeroSetupPreset = 'balanced';
  public assistPreset: DriverAssistPreset = 'semi_pro';
  public tireCompound: TireCompound = 'soft';
  public autoGearbox = true;
  /** Gamepad steering assist for `ControlInputs.padSteer` (off = raw stick to the rack) */
  public gamepadAssistEnabled = true;
  public readonly gamepadAssist = new GamepadSteeringAssist();
  private padSteerActive = false;

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
  private prevToggleXMode = false;
  private tcCut = 1;
  private aiBrakeTrim = 1;
  private aiThrottleTrim = 1;
  private readonly aiDriver = new RacingLineDriver();
  private aiProfile: { preset: AeroSetupPreset; profile: SpeedProfile; params: AiVehicleParams } | null = null;
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
  private lastFyFront = 0;
  private lastFyRear = 0;
  private lastFxTyres = 0;

  // Aero results (outer step)
  private aeroDownforceN = 0;
  private aeroFrontDownforceN = 0;
  private aeroRearDownforceN = 0;
  private aeroDragN = 0;
  private aeroSideCoef = 0;
  private aeroPitchMomentNm = 0;
  private groundEffectFactor = 1;
  /** Aero centre of pressure as the front share of downforce (%), and the floor stall factor (0.55–1) */
  public aeroCopFrontPct = 50;
  public floorStallFactor = 1;
  /** Driver tyre setup; the camber of each axle is kept on its runtime */
  private tyreSetup: TyreSetup = defaultTyreSetup();

  private readonly wings: WingRuntime[];
  private readonly axles: [AxleRuntime, AxleRuntime];
  private readonly torqueLut = new Lut(VF26_ENGINE.torqueCurve);
  private readonly coastLut = new Lut(VF26_ENGINE.coastCurve);
  private readonly boostLut = new Lut(VF26_ENGINE.boostCurve);
  private readonly kineticLut = new Lut(VF26_ERS.kineticTorque);
  private readonly ersControllers: Record<ErsControllerKey, ErsControllerRuntime>;
  private sprungMassKg = 0;
  private totalMassKg = 0;

  public wheels: [VehicleWheelState, VehicleWheelState, VehicleWheelState, VehicleWheelState];
  public drivetrain: DrivetrainRuntime;
  public lastObservation: AssettoCorsaGymObservation;

  // Mirrors for external readers
  public rpm: number = VF26_ENGINE.idleRpm;
  public gear = 1;
  public ersEnergyJ: number = VF26_ERS.batteryJ;
  public readonly maxErsEnergyJ: number = VF26_ERS.batteryJ;
  public activeAeroMode: ActiveAeroMode = 'Z_MODE';
  public autoXMode = true;
  public aiAutopilot = false;
  /** AI driver pace (fraction of the car's limit), line shift (m, + right) and speed ceiling (m/s) */
  public aiPaceScale = 1;
  public aiLineBiasM = 0;
  public aiSpeedCapMs = Infinity;

  // Three.js world transform outputs
  public worldPosition = new THREE.Vector3();
  public worldQuaternion = new THREE.Quaternion();
  public wheelRotationRad = 0;
  /** Visual tyre state per corner (FR, FL, RR, RL), refreshed at the end of each `step()`. Read-only for consumers. */
  public readonly tyreVisuals: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState] = [
    { loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0 },
    { loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0 },
    { loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0 },
    { loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0 },
  ];

  // Lap & sector timing
  private currentLapStartMs = 0;
  private currentSectorStartMs = 0;
  private lastSector: 1 | 2 | 3 = 1;
  /** Set by a grid / flying-start reset: the next S/F crossing starts lap timing instead of completing a lap */
  private lineCrossingStartsLap = false;
  private lapValid = true;
  private simTimeMs = 0;

  public telemetry: CarTelemetry;

  constructor(track: BuiltTrackData = getRwandaTrackData()) {
    this.track = track;

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
    const mkAxle = (spec: Vf26AxleSuspension, radius: number, rate: number, damp: number): AxleRuntime => ({
      spec,
      rollCentreHeight: computeRollCentreHeight(spec, radius),
      staticSpringForce: 0,
      staticSpringDeflection: 0,
      staticTyreLoad: 0,
      tyreRate: rate,
      tyreDamp: damp,
      camberDeg: spec.staticCamberDeg,
    });
    this.axles = [
      mkAxle(VF26_CHASSIS.front, tyres.front.radius, tyres.front.rate, tyres.front.damp),
      mkAxle(VF26_CHASSIS.rear, tyres.rear.radius, tyres.rear.rate, tyres.rear.damp),
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
        tyre: createTyreRuntime(spec, INITIAL_TYRE_TEMP_C),
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

  /** Current tyre setup: cold pressures (psi) and static camber (deg) per axle */
  public getTyreSetup(): TyreSetup {
    return {
      coldPressurePsi: { ...this.tyreSetup.coldPressurePsi },
      camberDeg: { front: this.axles[0].camberDeg, rear: this.axles[1].camberDeg },
    };
  }

  /**
   * Sets the tyre setup. Cold pressures are clamped to 17–27 psi (to 0.1 psi), front camber to
   * −4.5…−1.5° and rear camber to −3.0…−0.5°. A non-finite value keeps the current setting.
   */
  public setTyreSetup(setup: TyreSetup): void {
    const pick = (v: number, lo: number, hi: number, current: number) =>
      Number.isFinite(v) ? THREE.MathUtils.clamp(v, lo, hi) : current;
    const cp = this.tyreSetup.coldPressurePsi;
    cp.front = Math.round(pick(setup.coldPressurePsi.front, 17, 27, cp.front) * 10) / 10;
    cp.rear = Math.round(pick(setup.coldPressurePsi.rear, 17, 27, cp.rear) * 10) / 10;
    this.axles[0].camberDeg = pick(setup.camberDeg.front, -4.5, -1.5, this.axles[0].camberDeg);
    this.axles[1].camberDeg = pick(setup.camberDeg.rear, -3.0, -0.5, this.axles[1].camberDeg);
    this.applyColdPressures();
  }

  /** 2026 Manual Override Mode: full MGU-K deployment sustained to 337 km/h for 8 s */
  public activateBoostOverride(): boolean {
    const dt = this.drivetrain;
    if (dt.ersEnergyJ > 200_000 && dt.boostCooldownS <= 0) {
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
    if (flyingStart) {
      // Run-up from the second half of the main straight; timing starts at the line
      const lateral = gridSlot === 0 ? 0 : gridSlot % 2 === 1 ? -2.6 : 2.6;
      this.placeCar(lapLen - 450 - gridSlot * 28, 75, lateral);
    } else {
      // Exported grid slot (behind the S/F line, staggered left / right)
      const grid = this.track.spawnGrid;
      const slot = grid[Math.min(gridSlot, grid.length - 1)];
      this.placeCar(slot ? slot.s : lapLen - 12 - gridSlot * 8, 0, slot ? slot.lateral : 0);
    }
    this.activeAeroMode = flyingStart ? 'X_MODE' : 'Z_MODE';
    this.xModeBlend = flyingStart ? 1 : 0;
    this.drivetrain = this.createDrivetrain();
    this.drivetrain.gear = flyingStart ? 7 : 1;
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

  public teleportToDistance(sMeters: number, speedMs = 0): void {
    this.lineCrossingStartsLap = false;
    const wrapped = ((sMeters % this.track.totalLengthM) + this.track.totalLengthM) % this.track.totalLengthM;
    this.placeCar(wrapped, Math.max(0, speedMs), 0);
    const dt = this.drivetrain;
    dt.gear = this.selectGearForSpeed(this.vxMs);
    dt.shiftTarget = dt.gear;
    dt.shiftTimerS = 0;
    this.syncDrivetrainToRoadSpeed();
    this.settleSuspension();
    this.finishPlacement();
  }

  public teleportToTurn(turnNumber: number): void {
    const idx = this.track.samples.findIndex((s) => s.turnNumber === turnNumber);
    const target = idx >= 0 ? this.track.samples[(idx + 2) % this.track.samples.length] : this.track.samples[0];
    const speedMs = Math.min(62, target.optimalSpeedKmh / 3.6);
    this.teleportToDistance(target.s, speedMs);
    this.lateralOffsetM = aiLineOffsetM(target);
    this.syncCartesianFromCurvilinear();
    this.syncWorldTransform();
  }

  /** Collide with the loaded track GLB's barrier walls (`Track_Collider_Wall_*`), where the visible barriers stand */
  public attachTrackRoot(root: THREE.Object3D): void {
    let walls = wallCache.get(root);
    if (!walls) {
      walls = TrackWallQuery.fromTrackRoot(root);
      wallCache.set(root, walls);
    }
    this.setWalls(walls.segments.length > 0 ? walls : undefined);
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

    this.timeAccumulator += Math.min(dtSeconds, 0.05);

    const inputs: ControlInputs = {
      throttle: THREE.MathUtils.clamp(rawInputs.throttle ?? 0, 0, 1),
      brake: THREE.MathUtils.clamp(rawInputs.brake ?? 0, 0, 1),
      steerLeft: THREE.MathUtils.clamp(rawInputs.steerLeft ?? 0, 0, 1),
      steerRight: THREE.MathUtils.clamp(rawInputs.steerRight ?? 0, 0, 1),
      analogSteer:
        rawInputs.analogSteer !== undefined ? THREE.MathUtils.clamp(rawInputs.analogSteer, -1, 1) : undefined,
      padSteer: rawInputs.padSteer !== undefined ? THREE.MathUtils.clamp(rawInputs.padSteer, -1, 1) : undefined,
      clutch: rawInputs.clutch,
      manualOverride: Boolean(rawInputs.manualOverride),
      toggleXMode: Boolean(rawInputs.toggleXMode),
      shiftUp: Boolean(rawInputs.shiftUp),
      shiftDown: Boolean(rawInputs.shiftDown),
    };

    if (inputs.toggleXMode && !this.prevToggleXMode) {
      this.autoXMode = false;
      this.activeAeroMode = this.activeAeroMode === 'Z_MODE' ? 'X_MODE' : 'Z_MODE';
    }
    this.prevToggleXMode = inputs.toggleXMode;

    let shiftReq: -1 | 0 | 1 = 0;
    if (inputs.shiftUp && !this.prevShiftUp) shiftReq = 1;
    else if (inputs.shiftDown && !this.prevShiftDown) shiftReq = -1;
    this.prevShiftUp = inputs.shiftUp;
    this.prevShiftDown = inputs.shiftDown;

    let stepsRun = 0;
    while (this.timeAccumulator >= F1Physics2026.FIXED_DT && stepsRun < 30) {
      this.outerStep(F1Physics2026.FIXED_DT, inputs, stepsRun === 0 ? shiftReq : 0);
      this.timeAccumulator -= F1Physics2026.FIXED_DT;
      this.simTimeMs += F1Physics2026.FIXED_DT * 1000;
      stepsRun++;
    }
    if (stepsRun === 0 && dtSeconds < F1Physics2026.FIXED_DT) {
      this.outerStep(dtSeconds, inputs, shiftReq);
      this.timeAccumulator = 0;
      this.simTimeMs += dtSeconds * 1000;
    }

    this.syncWorldTransform();
    this.recoverStuckAi(dtSeconds);
    const currentSample = this.track.getSampleAtDistance(this.sMeters);
    this.lastObservation = this.buildObservation(currentSample);
    this.updateTelemetrySnapshot(currentSample, inputs);
    this.updateTyreVisuals();
    return this.telemetry;
  }

  /** Copies the last sub-step's tyre state into `tyreVisuals` (no physics state is written) */
  private updateTyreVisuals(): void {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const out = this.tyreVisuals[i];
      out.loadedRadiusM = tyreLoadedRadius(w.tyre, w.fzN);
      out.verticalDeflectionM = tyreVerticalDeflection(w.tyre, w.fzN);
      out.lateralForceN = w.fnN;
      out.camberRad = w.camberLeftRad;
    }
  }

  /** Autopilot only: a car stopped for 3 s (beached, spun into the barrier) is put back on the AI line */
  private recoverStuckAi(dtSeconds: number): void {
    if (!this.aiAutopilot) {
      this.aiStuckS = 0;
      return;
    }
    this.aiStuckS = Math.hypot(this.vxMs, this.vyMs) < 2 ? this.aiStuckS + Math.min(dtSeconds, 0.05) : 0;
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
      boostBar: 0,
      iceTorqueNm: 0,
      mgukTorqueNm: 0,
      mgukPowerW: 0,
      harvestAxleTorqueNm: 0,
      limiterCut: false,
      fuelKg: VF26_CHASSIS.fuelKg,
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
      setTyreSpec(w.tyre, w.isFront ? set.front : set.rear);
    }
    this.applyColdPressures();
    this.axles[0].tyreRate = set.front.rate;
    this.axles[0].tyreDamp = set.front.damp;
    this.axles[1].tyreRate = set.rear.rate;
    this.axles[1].tyreDamp = set.rear.damp;
  }

  /** Pushes the setup's cold pressures into each tyre (the hot pressure follows the ideal gas law) */
  private applyColdPressures(): void {
    for (const w of this.wheels) {
      const psi = w.isFront ? this.tyreSetup.coldPressurePsi.front : this.tyreSetup.coldPressurePsi.rear;
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
    this.pitchRad = 0;
    this.rollRad = 0;
    this.pitchVelRadS = 0;
    this.rollVelRadS = 0;
    this.heaveM = 0;
    this.heaveVelMs = 0;
    this.tcCut = 1;
    this.absFactor = [1, 1, 1, 1];
    this.aiDriver.reset();
    this.gamepadAssist.reset();
    this.aiFrontCourseRad = 0;
    this.aiBrakeTrim = 1;
    this.aiThrottleTrim = 1;
    this.lastFyFront = 0;
    this.lastFyRear = 0;
    this.lastFxTyres = 0;
    this.applyCompound();
    for (const w of this.wheels) {
      const r = w.tyre.spec.radius;
      w.spinVel = speedMs / r;
      w.tyre.deflX = 0;
      w.tyre.deflY = 0;
      w.hubZ = 0;
      w.hubZVel = 0;
      w.slipRatio = 0;
      w.slipAngleRad = 0;
      w.combinedSlipNorm = 0;
      w.steerRad = 0;
    }
    this.recomputeMassProperties();
    this.syncCartesianFromCurvilinear();
  }

  private finishPlacement(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
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
      this.updateAero(F1Physics2026.FIXED_DT / SUBSTEPS);
      this.integrateVertical(F1Physics2026.FIXED_DT / SUBSTEPS, 1, 0, 0, 0, true);
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

  private outerStep(dt: number, inputs: ControlInputs, shiftRequest: -1 | 0 | 1): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    const drv = this.drivetrain;

    // ---- 1. Driver / AI commands ------------------------------------------------
    let throttle = inputs.throttle;
    let brake = inputs.brake;
    let steerNorm: number; // + = right

    if (this.aiAutopilot) {
      this.lastObservation = this.buildObservation(sample);
      const plan = this.getAiPlan();
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
      // Brake only up to what the less-loaded front tyre can take (left/right torque is equal),
      // using the grip left over after its current cornering force
      const frontTorqueAtFullPedal = VF26_BRAKES.maxTorqueNm * VF26_BRAKES.powerMult * VF26_BRAKES.frontBias;
      let pedalCap = 1;
      for (let i = 0; i < 2; i++) {
        const w = this.wheels[i];
        const fxMax = Math.sqrt(Math.max(0, (1.06 * w.effectiveMu * w.fzN) ** 2 - w.fnN * w.fnN));
        pedalCap = Math.min(pedalCap, (1.05 * fxMax * w.tyre.spec.radius) / frontTorqueAtFullPedal);
      }
      brake = Math.min(ai.brakeCmd, Math.max(0.15, pedalCap)) * this.aiBrakeTrim;
      this.aiTargetSpeedKmh = ai.targetSpeedKmh;
      this.activeAeroMode = ai.aeroMode;
      if (drv.boostRemainingS <= 0) drv.ersMode = ai.ersMode;
    } else {
      if (inputs.padSteer !== undefined) {
        // Start from a clean state when the stick takes over from keyboard / mouse steering
        if (!this.padSteerActive) this.gamepadAssist.reset();
        this.padSteerActive = true;
        steerNorm = this.gamepadAssistEnabled
          ? this.gamepadAssist.update(
              inputs.padSteer,
              {
                vxMs: this.vxMs,
                vyMs: this.vyMs,
                yawRateRadS: this.yawRateRadS,
                cgToFrontAxleM: this.cgToFrontAxleM,
                cgToRearAxleM: this.cgToRearAxleM,
                wheelbaseM: this.wheelbaseM,
                maxSteerAngleRad: this.maxSteerAngleRad,
                frontPeakSlipRad: VF26_TYRES[this.tireCompound].front.frictionLimitAngleDeg * DEG2RAD,
                brake,
                // Measured on the flat pad: ≈1.75 × (g + downforce / m) from 90 to 240 km/h
                maxLateralAccel: 1.75 * (G + this.aeroDownforceN / this.massKg),
              },
              dt
            )
          : inputs.padSteer;
      } else {
        this.padSteerActive = false;
        steerNorm = inputs.analogSteer !== undefined ? inputs.analogSteer : inputs.steerRight - inputs.steerLeft;
      }

      if (inputs.manualOverride && drv.ersEnergyJ > 0) {
        drv.ersMode = 'OVERRIDE';
      } else if (drv.boostRemainingS <= 0 && drv.ersMode === 'OVERRIDE') {
        drv.ersMode = 'BALANCED';
      }

      if (this.autoXMode) {
        const canXMode =
          sample.drsZone && brake < 0.05 && Math.abs(steerNorm) < 0.18 && this.vxMs > 38 && throttle > 0.6;
        this.activeAeroMode = canXMode ? 'X_MODE' : 'Z_MODE';
      }
    }

    drv.launchPedal = throttle;

    // ---- 2. Driver aids (only when selected) -----------------------------------
    // Traction control works on the friction circle: the wheelspin it allows shrinks as the rear
    // tyres use more of their grip for cornering, so a throttle stab mid-corner is cut before the
    // rear is pushed past its combined-slip peak. Target = combined normalised slip (1 = peak).
    const tcTarget = this.assistPreset === 'assisted' ? 0.9 : this.assistPreset === 'semi_pro' ? 1.0 : 0;
    if (tcTarget > 0 && this.vxMs > 2) {
      // The worst rear wheel decides; a lightly loaded inside wheel counts a bit less
      const fzMean = 0.5 * (this.wheels[2].fzN + this.wheels[3].fzN);
      let excess = 0;
      for (let i = 2; i < 4; i++) {
        const w = this.wheels[i];
        const sk = w.slipRatio / w.tyre.spec.peakSlipRatio;
        const sa = Math.abs(Math.tan(w.slipAngleRad)) / w.tyre.tanPeakAngle;
        // Some drive is always allowed, except when the tyre is already at its lateral limit
        const skFloor = THREE.MathUtils.lerp(0.4, 0.12, THREE.MathUtils.clamp((sa - 0.75) / 0.3, 0, 1));
        const skAllowed = Math.sqrt(Math.max(skFloor * skFloor, tcTarget * tcTarget - sa * sa));
        const loadWeight = fzMean > 1 ? Math.min(1, (1.5 * w.fzN) / fzMean) : 0;
        excess = Math.max(excess, Math.max(0, sk - skAllowed) * loadWeight);
      }
      const want = Math.max(0.05, 1 - excess * 4);
      this.tcCut += (want - this.tcCut) * Math.min(1, (want < this.tcCut ? 80 : 10) * dt);
      throttle *= this.tcCut;
    } else {
      this.tcCut = 1;
    }
    // ABS works on the lock normalised to the tyre's peak slip. At the rear it uses the same friction
    // circle as the TC: the lock allowed shrinks as the rear tyre uses its grip for cornering, so trail
    // braking in a fast corner cannot drive the loaded rear past its combined-slip peak (where its side
    // grip collapses). The fronts keep their braking, or releasing them would shift the balance rearward.
    const absTarget = this.assistPreset === 'assisted' ? 0.95 : this.assistPreset === 'semi_pro' ? 1.1 : 0;
    for (let i = 0; i < 4; i++) {
      let want = 1;
      if (absTarget > 0 && this.vxMs > 3) {
        const w = this.wheels[i];
        const sk = -w.slipRatio / w.tyre.spec.peakSlipRatio;
        const sa = w.isFront ? 0 : Math.abs(Math.tan(w.slipAngleRad)) / w.tyre.tanPeakAngle;
        const skAllowed = Math.sqrt(Math.max(0.35 * 0.35, absTarget * absTarget - sa * sa));
        if (sk > skAllowed) want = Math.max(0.1, 1 - (sk - skAllowed) * 3);
      }
      this.absFactor[i] += (want - this.absFactor[i]) * Math.min(1, (want < this.absFactor[i] ? 80 : 20) * dt);
    }

    // ---- 3. Steering rack (hands have a finite speed; parallel steer + static toe) ----
    const targetRoad = -steerNorm * this.maxSteerAngleRad;
    const maxRate = (VF26_CHASSIS.steering.maxWheelSpeedDegS / VF26_CHASSIS.steering.ratio) * DEG2RAD;
    const dSteer = THREE.MathUtils.clamp(targetRoad - this.steerRoadWheelRad, -maxRate * dt, maxRate * dt);
    this.steerRoadWheelRad += dSteer;
    const toeF = VF26_CHASSIS.front.staticToeDeg * DEG2RAD;
    const toeR = VF26_CHASSIS.rear.staticToeDeg * DEG2RAD;
    this.wheels[0].steerRad = this.steerRoadWheelRad + toeF;
    this.wheels[1].steerRad = this.steerRoadWheelRad - toeF;
    this.wheels[2].steerRad = toeR;
    this.wheels[3].steerRad = -toeR;
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
    const altitudeM = BASE_ALTITUDE_M + sample.position.y;
    this.airDensity = this.computeAirDensity(altitudeM);
    const xTarget = this.activeAeroMode === 'X_MODE' ? 1 : 0;
    const aeroRate = dt / VF26_ACTIVE_AERO_TRANSITION_S;
    this.xModeBlend += THREE.MathUtils.clamp(xTarget - this.xModeBlend, -aeroRate, aeroRate);
    this.updateAero(dt);

    // ---- 6. Power unit & brakes (controls for the sub-steps) ----------------------
    this.updatePowerUnitControls(dt, throttle, brake);
    const brakeDemand = brake * VF26_BRAKES.maxTorqueNm * VF26_BRAKES.powerMult;
    const frontPerWheel = brakeDemand * VF26_BRAKES.frontBias;
    const rearPerWheelDemand = brakeDemand * (1 - VF26_BRAKES.frontBias);
    // Brake-by-wire: MGU-K harvest replaces part of the rear hydraulic torque. The BBW keeps the
    // total rear torque at the (ABS-limited) demand, so harvest never adds to a locking axle.
    const rearAbs = Math.min(this.absFactor[2], this.absFactor[3]);
    const harvestPerWheel = Math.min(rearPerWheelDemand * rearAbs, drv.harvestAxleTorqueNm * 0.5);
    drv.harvestAxleTorqueNm = 2 * harvestPerWheel;
    // It also counts the closed-throttle engine braking the rear axle already carries through the
    // gearbox; adding it on top of the rear hydraulic torque over-brakes the rear in a fast corner
    const coastPerWheel =
      brake > 0.02 && drv.clutchLocked
        ? (0.5 * Math.max(0, -this.coastLut.evaluate(drv.engineOmega * RADS2RPM)) * Math.abs(this.overallRatio(drv.gear)) * (1 - throttle)) /
          VF26_DRIVETRAIN.efficiency
        : 0;
    this.wheels[0].brakeTorqueNm = frontPerWheel * this.absFactor[0];
    this.wheels[1].brakeTorqueNm = frontPerWheel * this.absFactor[1];
    this.wheels[2].brakeTorqueNm = Math.max(0, rearPerWheelDemand * this.absFactor[2] - harvestPerWheel - coastPerWheel);
    this.wheels[3].brakeTorqueNm = Math.max(0, rearPerWheelDemand * this.absFactor[3] - harvestPerWheel - coastPerWheel);

    // ---- 7. 2 kHz sub-steps: tyres, wheels, drivetrain, chassis, suspension -------
    const h = dt / SUBSTEPS;
    const prevS = this.sMeters;
    const prevX = this.worldX;
    const prevZ = this.worldZ;
    let sumAx = 0;
    let sumAy = 0;
    for (let k = 0; k < SUBSTEPS; k++) {
      const roadFrac = (k + 1) / SUBSTEPS;
      const acc = this.subStep(h, throttle, roadFrac, dt);
      sumAx += acc.ax;
      sumAy += acc.ay;
    }
    this.lastAxMs2 += (sumAx / SUBSTEPS - this.lastAxMs2) * Math.min(1, 25 * dt);
    this.lastAyMs2 += (sumAy / SUBSTEPS - this.lastAyMs2) * Math.min(1, 25 * dt);

    // ---- 8. Thermal models, fuel ---------------------------------------------------
    for (const w of this.wheels) {
      const rollSpeed = w.spinVel * tyreRollingRadius(w.tyre, w.fzN);
      const slipPower = Math.abs(w.ftN * (rollSpeed - this.wheelHubVx(w))) + Math.abs(w.fnN * this.wheelHubVy(w));
      updateTyreThermal(w.tyre, slipPower, w.fzN, rollSpeed, AMBIENT_C, TRACK_SURFACE_C, dt, w.brakeTempC);
      const brakePower = w.brakeTorqueNm * Math.abs(w.spinVel);
      const cooling = (20 + 2.6 * Math.abs(this.vxMs)) * (w.brakeTempC - AMBIENT_C);
      w.brakeTempC += ((brakePower * 0.92 - cooling) / 2100) * dt;
      w.brakeTempC = Math.max(AMBIENT_C, Math.min(1250, w.brakeTempC));
    }
    if (throttle > 0.01 && drv.fuelKg > 0) {
      drv.fuelKg = Math.max(0, drv.fuelKg - VF26_CHASSIS.fuelFlowKgS * throttle * dt);
    }
    this.totalMassKg = VF26_CHASSIS.totalMassKg + drv.fuelKg;

    // ---- 9. Barriers, project onto the track, timing ------------------------------
    this.postIntegrate(prevS, prevX, prevZ);

    // ---- 10. Outputs ------------------------------------------------------------------
    this.rpm = drv.engineOmega * RADS2RPM;
    this.gear = drv.gear;
    this.ersEnergyJ = drv.ersEnergyJ;
    this.rideHeightOffsetM = this.heaveM;
    this.wheelRotationRad = this.wheels[0].rotationRad;
    this.frontSlipRatioNorm = Math.max(this.wheels[0].combinedSlipNorm, this.wheels[1].combinedSlipNorm);
    this.rearSlipRatioNorm = Math.max(this.wheels[2].combinedSlipNorm, this.wheels[3].combinedSlipNorm);

    const alignFront =
      this.wheels[0].torqueAlignNm +
      this.wheels[1].torqueAlignNm -
      VF26_CHASSIS.steering.mechanicalTrail * (this.wheels[0].fnN + this.wheels[1].fnN);
    this.ffbTorqueNorm = THREE.MathUtils.clamp((-alignFront / 650) * VF26_CHASSIS.steering.ffbMult, -1, 1);
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

    let desired = drv.gear;
    const rearOmega = 0.5 * (this.wheels[2].spinVel + this.wheels[3].spinVel);
    if (shiftRequest !== 0) {
      desired = THREE.MathUtils.clamp(drv.gear + shiftRequest, 1, 8);
      // Reverse sits below first (no neutral in between), and only near standstill
      if (drv.gear === 1 && shiftRequest < 0) desired = Math.abs(this.vxMs) < 2 ? -1 : 1;
      else if (drv.gear === -1) desired = shiftRequest > 0 && Math.abs(this.vxMs) < 2 ? 1 : -1;
      if (shiftRequest < 0 && desired > 0) {
        // Gearbox protection: refuse a downshift that would over-rev the engine
        const rpmAfter = rearOmega * this.overallRatio(desired) * RADS2RPM;
        if (rpmAfter > VF26_ENGINE.maxRpm - 500) desired = drv.gear;
      }
    } else if (this.autoGearbox && drv.gear >= 1 && drv.autoShiftCooldownS <= 0) {
      const rpm = drv.engineOmega * RADS2RPM;
      if (drv.gear < 8 && rpm > VF26_DRIVETRAIN.autoUpshiftRpm && drv.clutchLocked && brake < 0.1) {
        desired = drv.gear + 1;
      } else if (drv.gear > 1) {
        // Downshift decisions use road speed so a locking / spinning rear axle can't trigger
        // a cascade of downshifts
        const roadOmega = Math.max(0, this.vxMs) / this.wheels[2].tyre.spec.radius;
        const rpmRoad = roadOmega * this.overallRatio(drv.gear) * RADS2RPM;
        const rpmLower = Math.max(rearOmega, roadOmega) * this.overallRatio(drv.gear - 1) * RADS2RPM;
        const wantsDown =
          (rpmRoad < VF26_DRIVETRAIN.autoDownshiftRpm && (brake > 0.05 || throttle < 0.6)) || rpmRoad < 6200;
        if (wantsDown && rpmLower < VF26_DRIVETRAIN.autoUpshiftRpm - 600) desired = drv.gear - 1;
      }
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
        if (drv.ersMode === 'OVERRIDE') drv.ersMode = 'BALANCED';
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
        let harvestTorque = Math.min(kinetic, VF26_ERS.maxPowerW / omega) * frac;
        if (brake <= 0.02 && ratio > 0) {
          harvestTorque = Math.min(harvestTorque, VF26_ERS.coastHarvestMaxAxleTorqueNm / ratio);
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
    const coast = this.coastLut.evaluate(rpm);
    let ice: number;
    if (drv.limiterCut || drv.shiftTimerS > 0 || drv.fuelKg <= 0) {
      ice = coast;
    } else {
      const full = this.torqueLut.evaluate(rpm) * (1 + drv.boostBar);
      ice = coast + (full - coast) * throttle;
    }
    drv.iceTorqueNm = ice;
    const mguk = drv.shiftTimerS > 0 ? Math.min(0, drv.mgukTorqueNm) : drv.mgukTorqueNm;
    return ice + mguk;
  }

  // ---------------------------------------------------------------------------
  // Track contact, gravity & aero (outer step)
  // ---------------------------------------------------------------------------

  private updateRoadContacts(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>, reset: boolean): void {
    const speed = Math.abs(this.vxMs);
    for (const w of this.wheels) {
      const contact = queryWheelGroundContact(this.track, w.worldPos.x, w.worldPos.z, this.sMeters + w.staticPos.x, speed);
      w.zRoad = contact.zRoad;
      w.surfaceType = contact.surfaceType;
      w.surfaceFrictionMult = contact.frictionMult * (sample.gripMultiplier ?? 1);
      w.surfaceBumpM = contact.bumpM;
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

  /** Road-plane normal under the car (filtered cross-slope; identical frame used for rendering) */
  private localRoadUp(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): THREE.Vector3 {
    const rightFlat = new THREE.Vector3(-sample.tangent.z, 0, sample.tangent.x).normalize();
    const upFlat = new THREE.Vector3().crossVectors(rightFlat, sample.tangent).normalize();
    return upFlat.applyAxisAngle(sample.tangent, this.planeBankRad).normalize();
  }

  private updateGravity(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): void {
    const up = this.localRoadUp(sample);
    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy = Math.abs(up.y) > 1e-4 ? -(hx * up.x + hz * up.z) / up.y : 0;
    const fwd = new THREE.Vector3(hx, fy, hz).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    // Gravity (0, −g, 0) expressed in the body frame on the road plane
    this.gravityBody.x = -G * fwd.y;
    this.gravityBody.y = G * right.y; // left = −right
    this.gravityBody.n = G * up.y;
    const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    const rel = Math.cos(this.worldYawRad - heading);
    this.verticalCurvature = THREE.MathUtils.clamp(sample.verticalCurvature * 2 * rel * rel, -0.03, 0.03);
  }

  private updateAero(dt: number): void {
    void dt;
    const v2 = this.vxMs * this.vxMs + this.vyMs * this.vyMs;
    const q = 0.5 * this.airDensity * v2;
    const beta = Math.abs(this.vxMs) > 1 ? Math.atan2(Math.abs(this.vyMs), Math.abs(this.vxMs)) : 0;

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

    let down = 0;
    let front = 0;
    let drag = 0;
    let pitch = 0;
    let floorGh = 0;
    let floorCount = 0;
    for (const wing of this.wings) {
      const s = wing.spec;
      const angle = wingAngleDeg(s, this.aeroPreset, xEase);
      const z = s.position[2];
      const y = s.position[1];
      const isFloor = s.name.startsWith('FLOOR');

      let ghCl = 1;
      let ghCd = 1;
      if (wing.ghCl || wing.ghCd) {
        const frac = THREE.MathUtils.clamp((a - z) / L, -0.3, 1.3);
        const road = roadF + (roadR - roadF) * frac;
        const bodyZ = this.heaveM + z * this.pitchRad;
        const hgt = Math.max(0, this.cgHeightM + y + bodyZ - road);
        if (wing.ghCl) ghCl = wing.ghCl.evaluate(hgt);
        if (wing.ghCd) ghCd = wing.ghCd.evaluate(hgt);
        if (isFloor) {
          floorGh += ghCl;
          floorCount++;
        }
      }
      const stallCl = isFloor ? this.floorStallFactor : 1;
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

    // The centre of pressure moves with attitude through the per-element ride-height maps above (front wing
    // nearer the road under braking, diffuser further from it); no extra dive / squat shift on top of them, which
    // double-counted that and unloaded the rear under trail braking.

    this.aeroDownforceN = down;
    this.aeroFrontDownforceN = front;
    this.aeroRearDownforceN = down - front;
    this.aeroCopFrontPct = down > 1 ? (100 * front) / down : 50;
    this.aeroDragN = drag;
    this.aeroPitchMomentNm = pitch;
    // Side force from the body/fin side area (Cy·A ≈ 1.6 m², centre of pressure 0.45 m behind CG)
    this.aeroSideCoef = 0.5 * this.airDensity * 1.6;
    this.groundEffectFactor = floorCount > 0 ? floorGh / floorCount : 1;
  }

  // ---------------------------------------------------------------------------
  // 2 kHz sub-step
  // ---------------------------------------------------------------------------

  private subStep(h: number, throttle: number, roadFrac: number, outerDt: number): { ax: number; ay: number } {
    void outerDt;
    const M = this.totalMassKg;
    const r = -this.yawRateRadS; // CCW yaw rate
    const drv = this.drivetrain;

    let sumFx = 0;
    let sumFy = 0;
    let sumMz = 0;
    let fyFront = 0;
    let fyRear = 0;
    let fxTyres = 0;
    const roadTorque: [number, number, number, number] = [0, 0, 0, 0];

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
      const radius = tyreRollingRadius(w.tyre, w.fzN);

      // Camber relative to the road (body roll + bump camber)
      const sideSign = w.isLeft ? 1 : -1;
      const staticCamber = axle.camberDeg * DEG2RAD;
      const bumpCamber = axle.spec.camberGainDegPerM * DEG2RAD * w.suspCompression;
      w.camberLeftRad = sideSign * (staticCamber + bumpCamber) - this.rollRad;

      const out = computeTyreForces(w.tyre, {
        fz: w.fzN,
        vx: vxw,
        vy: vyw,
        rimSpeed: w.spinVel * radius,
        camberLeftRad: w.camberLeftRad,
        surfaceGrip: w.surfaceFrictionMult,
        inwardSign: w.isLeft ? -1 : 1,
        dt: h,
      });
      w.ftN = out.fx;
      w.fnN = out.fy;
      w.slipRatio = out.slipRatio;
      w.slipAngleRad = out.slipAngle;
      w.combinedSlipNorm = out.normSlip;
      w.effectiveMu = out.mu;
      w.gripFactor = out.gripFactor;
      w.torqueAlignNm = out.mz;

      const fbx = out.fx * cs - out.fy * sn;
      const fby = out.fx * sn + out.fy * cs;
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

    this.lastFyFront = fyFront;
    this.lastFyRear = fyRear;
    this.lastFxTyres = fxTyres;

    // ---- Vertical dynamics ----
    this.integrateVertical(h, roadFrac, ax, fyFront, fyRear, false);

    // ---- World pose ----
    this.worldYawRad = Math.atan2(Math.sin(this.worldYawRad + rNew * h), Math.cos(this.worldYawRad + rNew * h));
    const sinYaw = Math.sin(this.worldYawRad);
    const cosYaw = Math.cos(this.worldYawRad);
    this.worldX += (this.vxMs * sinYaw + this.vyMs * cosYaw) * h;
    this.worldZ += (this.vxMs * cosYaw - this.vyMs * sinYaw) * h;

    return { ax, ay };
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
      const startRpm =
        VF26_DRIVETRAIN.autoClutchStartRpm +
        launch * Math.max(0, VF26_DRIVETRAIN.launchRpm - window - VF26_DRIVETRAIN.autoClutchStartRpm);
      const engage = THREE.MathUtils.clamp((rpm - startRpm) / window, 0, 1);
      drv.clutchEngagement = engage * engage * (3 - 2 * engage);
      const slip = drv.engineOmega - omegaAxle * ratio;
      const capacity = drv.clutchEngagement * VF26_DRIVETRAIN.clutchMaxTorqueNm;
      const tClutch = ratio !== 0 ? THREE.MathUtils.clamp(slip * 40, -capacity, capacity) : 0;

      drv.engineOmega += ((tEngine - tClutch) / (Ie + 0.002)) * h;
      if (drv.engineOmega < idle) drv.engineOmega = idle; // idle governor
      if (drv.engineOmega > maxOmega) drv.engineOmega = maxOmega;

      tIn = ratio * tClutch * eta;
      const J = 2 * Iw + Igb * ratio * ratio;
      const free = omegaAxle + ((tIn - roadTqLeft - roadTqRight) / J) * h;
      omegaAxle = this.applyBrakeFriction(free, ((brakeL + brakeR) / J) * h);

      const slipAfter = drv.engineOmega - omegaAxle * ratio;
      if (ratio !== 0 && Math.abs(slipAfter) < 8 && capacity >= Math.abs(tEngine) * 0.9 && capacity > 50) {
        drv.clutchLocked = true;
        drv.engineOmega = omegaAxle * ratio;
      }
    }

    // Limited-slip differential (preload + power/coast ramp locking)
    const lock = tIn >= 0 ? VF26_DRIVETRAIN.diffPowerLock : VF26_DRIVETRAIN.diffCoastLock;
    const capacity = VF26_DRIVETRAIN.diffPreloadNm + lock * Math.abs(tIn);
    const sgn = (v: number) => (Math.abs(v) > 0.05 ? Math.sign(v) : 0);
    const dRoad = roadTqLeft + brakeL * sgn(wl.spinVel) - (roadTqRight + brakeR * sgn(wr.spinVel));
    const tReq = (Iw * deltaOmega) / h * 0.5 - dRoad * 0.5;
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

  private integrateVertical(h: number, roadFrac: number, axBody: number, fyFront: number, fyRear: number, settling: boolean): void {
    const ms = this.sprungMassKg;
    const M = this.totalMassKg;
    const gExtra = this.gravityBody.n - G + this.vxMs * this.vxMs * this.verticalCurvature;
    const sprungShare = ms / M;
    const hcg = this.cgHeightM;

    const dF: [number, number, number, number] = [0, 0, 0, 0];
    const comp: [number, number, number, number] = [0, 0, 0, 0];
    const compVel: [number, number, number, number] = [0, 0, 0, 0];

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
    const plank: [number, number, number, number] = [0, 0, 0, 0];
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
      settling ? 0 : (fyFront * (hcg - this.axles[0].rollCentreHeight) + fyRear * (hcg - this.axles[1].rollCentreHeight)) * sprungShare;
    for (const w of this.wheels) {
      const f = dF[w.index] + plank[w.index];
      fz += f;
      mPitch += f * w.staticPos.x;
      mRoll += f * w.staticPos.y;
    }
    void axBody;

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
      const fGeo = (fyAxle * axle.rollCentreHeight) / axle.spec.track;
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
    if (this.walls ? this.applyWallSegments(prevX, prevZ) : this.applyWallLines(projected)) {
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
   * outline point past one is pushed back out. No height test: the circuit never passes over itself. Returns whether
   * the car was moved.
   */
  private applyWallSegments(prevX: number, prevZ: number): boolean {
    const walls = this.walls!;
    const ids = this.wallIds;
    const n = walls.near(this.worldX, this.worldZ, this.wallQueryRadius + Math.hypot(this.worldX - prevX, this.worldZ - prevZ), ids);
    if (n === 0) return false;
    let moved = false;
    if (wallSweep(walls, ids, n, prevX, prevZ, this.worldX, this.worldZ, Number.NaN, 0, _wallHit) >= 0) {
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
      const depth = wallPenetration(walls, ids, n, this.worldX + rx, Number.NaN, this.worldZ + rz, this.worldX, this.worldZ, WALL_MAX_DEPTH_M, 0, _wallHit);
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
    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy = Math.abs(carUp.y) > 1e-4 ? -(hx * carUp.x + hz * carUp.z) / carUp.y : 0;
    const fLen = Math.hypot(hx, fy, hz);
    const fx = hx / fLen;
    const fyN = fy / fLen;
    const fz = hz / fLen;
    // right = forward × up
    let rx = fyN * carUp.z - fz * carUp.y;
    let ry = fz * carUp.x - fx * carUp.z;
    let rz = fx * carUp.y - fyN * carUp.x;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen;
    ry /= rLen;
    rz /= rLen;
    for (const w of this.wheels) {
      w.worldPos.x = this.worldX + fx * w.staticPos.x - rx * w.staticPos.y;
      w.worldPos.y = carGroundY + fyN * w.staticPos.x - ry * w.staticPos.y;
      w.worldPos.z = this.worldZ + fz * w.staticPos.x - rz * w.staticPos.y;
    }
  }

  /** Target-speed profile for the AI, rebuilt when the aero package changes */
  private getAiPlan(): { profile: SpeedProfile; params: AiVehicleParams } {
    if (!this.aiProfile || this.aiProfile.preset !== this.aeroPreset) {
      const car = createVf26ProfileCarModel(this.aeroPreset);
      this.aiProfile = {
        preset: this.aeroPreset,
        profile: computeSpeedProfile(this.track.samples, car),
        params: {
          wheelbaseM: this.wheelbaseM,
          maxSteerLockRad: this.maxSteerAngleRad,
          car,
          fullBrakeForceN: vf26FullBrakeForceN(),
          aeroTransitionS: VF26_ACTIVE_AERO_TRANSITION_S,
        },
      };
    }
    return this.aiProfile;
  }

  private buildObservation(sample: ReturnType<BuiltTrackData['getSampleAtDistance']>): AssettoCorsaGymObservation {
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
      fuelKg: VF26_CHASSIS.fuelKg,
      tireSlipRatio: [0, 0, 0, 0],
      wheelSlipRatios: [0, 0, 0, 0],
      wheelSlipAnglesDeg: [0, 0, 0, 0],
      wheelLoadsN: [0, 0, 0, 0],
      wheelRideHeightsMm: [44, 44, 60, 60],
      suspensionTravelMm: [0, 0, 0, 0],
      tireTempsC: [INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C, INITIAL_TYRE_TEMP_C],
      tireWearPct: [0, 0, 0, 0],
      tireGripFactor: [1, 1, 1, 1],
      brakeTempsC: [INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C, INITIAL_BRAKE_TEMP_C],
      wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
      frontSlipAngleDeg: 0,
      rearSlipAngleDeg: 0,
      ffbTorqueNorm: 0,
      ffbClipping: false,
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
    if (offTrack) this.lapValid = false;

    let dominantSurface: SurfaceType = 'asphalt';
    if (W[0].surfaceType === 'grass' || W[1].surfaceType === 'grass') dominantSurface = 'grass';
    else if (W[0].surfaceType === 'runoff' || W[1].surfaceType === 'runoff') dominantSurface = 'runoff';
    else if (onKerbLeft || onKerbRight) dominantSurface = 'kerb';

    const markerS = (this.sMeters + 25) % this.track.totalLengthM;
    const brakingUrgency = evaluateDynamicBrakingUrgency(this.track, this.sMeters, this.vxMs, markerS);

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
    t.tireTempsC = quad((w) => Math.round(0.6 * w.tyre.surfaceTempC + 0.4 * w.tyre.coreTempC));
    t.tireWearPct = quad((w) => Number((w.tyre.wear * 100).toFixed(1)));
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
    t.tireGripFactor = quad((w) => Number(w.gripFactor.toFixed(2)));
    t.brakeTempsC = quad((w) => Math.round(w.brakeTempC));
    t.wheelSurfaces = quad((w) => w.surfaceType);

    t.frontSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[0] + t.wheelSlipAnglesDeg[1]);
    t.rearSlipAngleDeg = 0.5 * (t.wheelSlipAnglesDeg[2] + t.wheelSlipAnglesDeg[3]);
    t.ffbTorqueNorm = this.ffbTorqueNorm;
    t.ffbClipping = Math.abs(this.ffbTorqueNorm) > 0.95;

    t.onKerbLeft = onKerbLeft;
    t.onKerbRight = onKerbRight;
    t.offTrack = offTrack;
    t.surface = dominantSurface;

    t.trackDistanceM = this.sMeters;
    t.trackProgress = this.sMeters / this.track.totalLengthM;
    t.lateralOffsetM = this.lateralOffsetM;
    t.gapToRacingLineM = this.lastObservation.gapToRacingLineM;
    t.headingErrorRad = this.headingErrorRad;
    t.targetCornerSpeedKmh = this.aiAutopilot ? this.aiTargetSpeedKmh : Math.round(sample.optimalSpeedKmh);
    t.brakingUrgency = brakingUrgency;
    t.currentSector = sample.sector;
    t.currentTurnNumber = sample.turnNumber;
    t.currentTurnName = sample.turnName;
    t.bankingDeg = THREE.MathUtils.radToDeg(sample.bankingRad);
    t.slopePercent = sample.slopeSin * 100;
    t.currentLapTimeMs = Math.max(0, this.simTimeMs - this.currentLapStartMs);
    t.aiAutopilot = this.aiAutopilot;
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
    if (lapTime > 45_000) {
      this.telemetry.lastLapTimeMs = lapTime;
      if (this.lapValid && (this.telemetry.bestLapTimeMs === null || lapTime < this.telemetry.bestLapTimeMs)) {
        this.telemetry.bestLapTimeMs = lapTime;
      }
    }
    this.telemetry.lapCount++;
    this.telemetry.topSpeedThisLapKmh = this.vxMs * 3.6;
    this.lapValid = true;
  }

  private syncWorldTransform(): void {
    const sample = this.track.getSampleAtDistance(this.sMeters);
    const exactGroundY = evaluateSampleLateralHeightM(sample, this.lateralOffsetM);
    this.worldPosition.set(this.worldX, exactGroundY, this.worldZ);

    const carUp = this.localRoadUp(sample);

    const hx = Math.sin(this.worldYawRad);
    const hz = Math.cos(this.worldYawRad);
    const fy = Math.abs(carUp.y) > 1e-4 ? -(hx * carUp.x + hz * carUp.z) / carUp.y : 0;
    const carForward = new THREE.Vector3(hx, fy, hz).normalize();
    const carLeft = new THREE.Vector3().crossVectors(carUp, carForward).normalize();
    const basis = new THREE.Matrix4().makeBasis(carLeft, carUp, carForward);
    this.worldQuaternion.setFromRotationMatrix(basis);
  }
}
