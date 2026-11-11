/**
 * Phase 0 Clean-Room Architecture Contract Types & Constants for the 2026 F1
 * Rigid-Body Vehicle ("VeloSoft LC-26" / `lc26-f1`).
 *
 * Single TypeScript source of truth paired with `specs/lc26-contract.json`.
 * Imported by all 6 parallel Phase 1 engineering modules in isolated worktrees
 * and by Phase 2 full-vehicle integration.
 *
 * STRICT CLEAN-ROOM POLICY:
 * Zero copied geometry, LUTs, textures, or aero/torque curves from RSS, VRC,
 * DeX (`vf26` / `f12026` / ported cars), or any real 2026 Formula 1 team.
 */

import lc26ContractJson from '../../../../specs/lc26-contract.json';
import type {
  AeroData,
  AeroRideHeightMap,
  AxleSuspensionData,
  BrakesData,
  ChassisData,
  ClutchData,
  CompoundSlot,
  DamperControllerData,
  DifferentialData,
  EngineData,
  ERSData,
  GearBoxData,
  PerformanceModeData,
  PerformanceModeName,
  PhysicsTyreCompound,
  PowerSteeringData,
  SuspensionsData,
  TurboData,
  TyresCamberData,
  TyresCompoundData,
  TyresModelData,
  TyresPressureData,
  TyresThermalPatchData,
  WingData,
} from '@/lib/sim/f12026-car/F12026CarConfig';
import type { CarElectronicsProfile, BrakingEnvelope } from '@/lib/sim/f12026-car/F12026CarSim';
import {
  buildDoubleWishboneHardpoints,
  type DoubleWishboneHardpoints,
  type Vec3Tuple,
} from '@/lib/sim/suspension-kinematics';
import type { WetTyreTraits } from '@/lib/sim/wet-tyres';
import type { ActiveAeroMode, AeroSetupPreset, TireCompound } from '@/types/f1';

export type {
  AeroData,
  AeroRideHeightMap,
  ActiveAeroMode,
  AeroSetupPreset,
  AxleSuspensionData,
  BrakesData,
  BrakingEnvelope,
  CarElectronicsProfile,
  ChassisData,
  ClutchData,
  CompoundSlot,
  DamperControllerData,
  DifferentialData,
  DoubleWishboneHardpoints,
  EngineData,
  ERSData,
  GearBoxData,
  PerformanceModeData,
  PerformanceModeName,
  PhysicsTyreCompound,
  PowerSteeringData,
  SuspensionsData,
  TireCompound,
  TurboData,
  TyresCamberData,
  TyresCompoundData,
  TyresModelData,
  TyresPressureData,
  TyresThermalPatchData,
  Vec3Tuple,
  WetTyreTraits,
  WingData,
};

// ---------------------------------------------------------------------------
// Identity & Core Architectural Constants
// ---------------------------------------------------------------------------

export const LC26_VEHICLE_ID = 'lc26-f1' as const;
export type Lc26VehicleId = typeof LC26_VEHICLE_ID;

export const LC26_DISPLAY_NAME = 'VeloSoft LC-26' as const;
export const LC26_SHORT_NAME = 'LC-26' as const;
export const LC26_AERO_CONCEPT = 'Canyon-Overcut + Twin-Keel Spoon' as const;
export const LC26_CONTRACT_VERSION = '1.0.0' as const;

/** Raw parsed JSON contract (`specs/lc26-contract.json`) for runtime inspection & verification suites */
export const LC26_CONTRACT = lc26ContractJson;

/** Solver fixed rates: 500 Hz outer loop (`dt = 2 ms`), 4 × 2000 Hz inner 6-DOF substeps (`subDt = 0.5 ms`) */
export const LC26_SOLVER_RATES = {
  outerRateHz: 500,
  outerDtS: 0.002,
  innerSubsteps: 4,
  innerRateHz: 2000,
  innerSubDtS: 0.0005,
  contactPatchPoints: 5,
  ffbRateHz: 500,
  activeAeroMaxTransitionS: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Coordinate Systems & Wheel Index Conventions
// ---------------------------------------------------------------------------

/**
 * 4-corner ordering in `VehiclePhysics.ts`, `CarTelemetry`, and `F12026Channels`:
 * `[0: FL, 1: FR, 2: RL, 3: RR]`
 */
export type SolverCornerOrder<T> = readonly [fl: T, fr: T, rl: T, rr: T];
export type SolverCornerKey = 'fl' | 'fr' | 'rl' | 'rr';

/**
 * 4-corner ordering in `SimulatorCar.wheels`, `SimulatorCar.tyreVisuals`,
 * `VehicleWheelState`, and `corner-rig.ts`:
 * `[0: FR, 1: FL, 2: RR, 3: RL]`
 */
export type SimRigCornerOrder<T> = readonly [fr: T, fl: T, rr: T, rl: T];

/** Reorders `[FL, FR, RL, RR]` (solver/telemetry) -> `[FR, FL, RR, RL]` (`SimulatorCar`/rig) */
export function solverToSimWheelOrder<T>(corners: SolverCornerOrder<T>): [T, T, T, T] {
  return [corners[1], corners[0], corners[3], corners[2]];
}

/** Reorders `[FR, FL, RR, RL]` (`SimulatorCar`/rig) -> `[FL, FR, RL, RR]` (solver/telemetry) */
export function simToSolverWheelOrder<T>(corners: SimRigCornerOrder<T>): [T, T, T, T] {
  return [corners[1], corners[0], corners[3], corners[2]];
}

/** FIA 2026 Section C datum planes in `XF` mm (rearward from front axle) and glTF `z` m (forward from CG) */
export const LC26_FIA_DATUM_PLANES = {
  wheelbaseM: 3.4,
  frontWeightFraction: 0.46,
  rearWeightFraction: 0.54,
  frontAxleGltfZM: 1.836,
  rearAxleGltfZM: -1.564,
  staticFrontRideHeightM: 0.032,
  staticRearRideHeightM: 0.058,
  staticRakeDeg: 0.43815,
  xfMm: {
    XA_0: -100,
    XF_0: 0,
    XC_0: 1830,
    XPU_0: 2250,
    XDIF_0: 3050,
    XR_0: 3400,
  },
  gltfZM: {
    XA_0: 1.936,
    XF_0: 1.836,
    XC_0: 0.006,
    XPU_0: -0.414,
    XDIF_0: -1.214,
    XR_0: -1.564,
  },
} as const;

/**
 * Converts FIA Section C coordinates `[X_FIA_mm (rearward from XF=0), Y_FIA_mm (right), Z_FIA_mm (up from Z=0 ref)]`
 * into LibreCorsa glTF / solver static coordinates `[x_left_m, y_up_m, z_fwd_m]`.
 */
export function fiaMmToGltfM(xFiaMm: number, yFiaMm: number, zFiaMm: number): [number, number, number] {
  const x = -yFiaMm / 1000;
  const z = LC26_FIA_DATUM_PLANES.frontAxleGltfZM - xFiaMm / 1000;
  const yFloor =
    LC26_FIA_DATUM_PLANES.staticFrontRideHeightM +
    (LC26_FIA_DATUM_PLANES.staticRearRideHeightM - LC26_FIA_DATUM_PLANES.staticFrontRideHeightM) *
      (xFiaMm / (LC26_FIA_DATUM_PLANES.wheelbaseM * 1000));
  const y = yFloor + zFiaMm / 1000;
  return [x === 0 ? 0 : x, y, z === 0 ? 0 : z];
}

/** Converts LibreCorsa glTF `[x_left, y_up, z_fwd]` (m) -> Blender Z-up `[X_bl, Y_bl, Z_bl]` (m) for `export_yup=True` */
export function gltfMToBlenderM(ptGltf: Vec3Tuple): [number, number, number] {
  const x = ptGltf[0] === 0 ? 0 : ptGltf[0];
  const y = -ptGltf[2] === 0 ? 0 : -ptGltf[2];
  const z = ptGltf[1] === 0 ? 0 : ptGltf[1];
  return [x, y, z];
}

/** Converts Blender Z-up `[X_bl, Y_bl, Z_bl]` (m) -> LibreCorsa glTF `[x_left, y_up, z_fwd]` (m) */
export function blenderMToGltfM(ptBl: Vec3Tuple): [number, number, number] {
  const x = ptBl[0] === 0 ? 0 : ptBl[0];
  const y = ptBl[2] === 0 ? 0 : ptBl[2];
  const z = -ptBl[1] === 0 ? 0 : -ptBl[1];
  return [x, y, z];
}

// ---------------------------------------------------------------------------
// FIA 2026 Section C Issue 21 Dimensions, Mass, Inertia & Plank Strikes
// ---------------------------------------------------------------------------

export const LC26_TYRE_DIMENSIONS = {
  front: {
    designation: '280/705-R18',
    widthM: 0.28,
    outerDiameterM: 0.705,
    unloadedRadiusM: 0.3525,
    rimNominalInch: 18,
    rimLipDiameterM: 0.496,
    rimInnerBarrelIdM: 0.438,
    rimOverallWidthM: 0.334,
    inboardRimOriginAbsYMm: 598,
    fiaMaxInboardRimOriginAbsYMm: 603,
    brakeDiscDiameterMm: 336,
    brakeDiscThicknessMm: 34,
  },
  rear: {
    designation: '375/710-R18',
    widthM: 0.375,
    outerDiameterM: 0.71,
    unloadedRadiusM: 0.355,
    rimNominalInch: 18,
    rimLipDiameterM: 0.496,
    rimInnerBarrelIdM: 0.438,
    rimOverallWidthM: 0.4203,
    inboardRimOriginAbsYMm: 521.85,
    fiaMaxInboardRimOriginAbsYMm: 525,
    brakeDiscDiameterMm: 276,
    brakeDiscThicknessMm: 32,
  },
} as const;

export const LC26_MASS_AND_INERTIA = {
  /** Minimum car + driver + dry tyre set mass (kg), fuel excluded (FIA C4.1: 724 kg + 44 kg nominal tyres = 768 kg) */
  minimumMassKg: 768,
  driverPlusSeatKitKg: 80,
  sprungDryWithDriverKg: 660,
  unsprungMassFrontPerCornerKg: 25.5,
  unsprungMassRearPerCornerKg: 28.5,
  frontWeightFraction: 0.46,
  rearWeightFraction: 0.54,
  cgHeightAboveGroundM: 0.248,
  /** Fuel cell center offset from dry CG (m: +y up, +z forward) */
  fuelTankOffsetFromCgM: { y: 0.012, z: -0.21 } as const,
  maxRaceFuelKg: 100,
  defaultQualiFuelKg: 12,
  defaultRaceFuelKg: 98,
  /** Principal inertias about dry CG (kg·m²): Solver body axes use X=pitch, Y=yaw, Z=roll */
  principalInertiaKgM2: {
    pitch: 868,
    roll: 126,
    yaw: 912,
  } as const,
  /** Diagonal `[Ixx_pitch, Iyy_yaw, Izz_roll]` in LibreCorsa solver/glTF frame (`+X left, +Y up, +Z forward`) */
  solverDiagonalInertiaKgM2: [868, 912, 126] as const,
  /** Diagonal `[Ixx_roll, Iyy_pitch, Izz_yaw]` in FIA Section C frame (`+X rear, +Y right, +Z up`) */
  fiaDiagonalInertiaKgM2: [126, 868, 912] as const,
  wheelInertiaFrontKgM2: 1.54,
  wheelInertiaRearKgM2: 1.82,
} as const;

/** Baseline `ChassisData` conforming directly to `F12026CarConfig.ts` */
export const LC26_CHASSIS_DATA: ChassisData = {
  totalMassKg: LC26_MASS_AND_INERTIA.minimumMassKg,
  frontWeightFraction: LC26_MASS_AND_INERTIA.frontWeightFraction,
  wheelbase: LC26_FIA_DATUM_PLANES.wheelbaseM,
  trackWidthFront: 1.53,
  trackWidthRear: 1.464,
  cgHeight: LC26_MASS_AND_INERTIA.cgHeightAboveGroundM,
  inertia: { ...LC26_MASS_AND_INERTIA.principalInertiaKgM2 },
  unsprungMassFront: LC26_MASS_AND_INERTIA.unsprungMassFrontPerCornerKg,
  unsprungMassRear: LC26_MASS_AND_INERTIA.unsprungMassRearPerCornerKg,
  fuelTank: { ...LC26_MASS_AND_INERTIA.fuelTankOffsetFromCgM },
  wheelInertiaFront: LC26_MASS_AND_INERTIA.wheelInertiaFrontKgM2,
  wheelInertiaRear: LC26_MASS_AND_INERTIA.wheelInertiaRearKgM2,
  maxRoadWheelDeg: 18.75,
  ffbMechanicalTrailM: 0.0204,
  steerComplianceDegPerKN: 0.035,
};

export interface Lc26PlankStrikePoint {
  readonly id: 'skid_front_splitter' | 'skid_mid_floor' | 'skid_rear_tea_tray';
  readonly fiaMm: Vec3Tuple;
  readonly gltfStaticM: Vec3Tuple;
  readonly offsetFromCgM: Vec3Tuple;
}

export const LC26_PLANK_SPEC = {
  thicknessNewMm: 10.0,
  toleranceMm: 0.2,
  minLegalThicknessMm: 9.0,
  fiaIssue21HoleInspectionMinMm: 8.0,
  gltfZRangeM: [-1.214, 1.406] as const,
  skidMaterial: 'Ti-6Al-4V',
  strikes: {
    frontSplitter: {
      id: 'skid_front_splitter',
      fiaMm: [500, 0, -10],
      gltfStaticM: [0, 0.02582, 1.336],
      offsetFromCgM: [0, -0.22218, 1.336],
    },
    midFloor: {
      id: 'skid_mid_floor',
      fiaMm: [1130, 0, -10],
      gltfStaticM: [0, 0.03064, 0.706],
      offsetFromCgM: [0, -0.21736, 0.706],
    },
    rearTeaTray: {
      id: 'skid_rear_tea_tray',
      fiaMm: [2800, 0, -10],
      gltfStaticM: [0, 0.04341, -0.964],
      offsetFromCgM: [0, -0.20459, -0.964],
    },
  } satisfies Record<'frontSplitter' | 'midFloor' | 'rearTeaTray', Lc26PlankStrikePoint>,
} as const;

// ---------------------------------------------------------------------------
// 3D Suspension Hardpoints (Wheel-Local & Chassis glTF Space)
// ---------------------------------------------------------------------------

/** Static wheel centers in glTF rest space (`y = unloadedRadiusM` so tyre sits tangent to `y = 0`) */
export const LC26_WHEEL_CENTERS_GLTF_M = {
  fl: [0.765, 0.3525, 1.836] as Vec3Tuple,
  fr: [-0.765, 0.3525, 1.836] as Vec3Tuple,
  rl: [0.732, 0.355, -1.564] as Vec3Tuple,
  rr: [-0.732, 0.355, -1.564] as Vec3Tuple,
} as const;

/**
 * Clean-room front pull-rod double-wishbone + tie-rod raw 8-tuple in `suspension-kinematics.ts`
 * wheel-local frame `[x_inboard, y_up, z_fwd]` (m):
 * KPI = 7.70°, Caster = 4.64°, Scrub = 24.6 mm, Mech Trail = 20.4 mm, RC = 25.5 mm, bump steer < 0.085°.
 */
export const LC26_FRONT_HARDPOINTS_RAW: NonNullable<AxleSuspensionData['hardpoints']> = [
  [0.535, 0.088, 0.165], // carTopFront
  [0.52, 0.074, -0.175], // carTopRear
  [0.545, -0.172, 0.15], // carBottomFront
  [0.53, -0.162, -0.19], // carBottomRear
  [0.092, 0.146, -0.02], // tyreTop
  [0.052, -0.15, 0.004], // tyreBottom
  [0.538, -0.022, 0.092], // carSteer
  [0.088, 0.024, 0.112], // tyreSteer
] as const;

/**
 * Clean-room rear push-rod double-wishbone + toe-link raw 8-tuple in `suspension-kinematics.ts`
 * wheel-local frame `[x_inboard, y_up, z_fwd]` (m):
 * KPI = 5.56°, Caster = 3.34°, RC = 68.9 mm, progressive negative camber gain, bump steer < 0.04°.
 */
export const LC26_REAR_HARDPOINTS_RAW: NonNullable<AxleSuspensionData['hardpoints']> = [
  [0.555, 0.106, 0.21], // carTopFront
  [0.57, 0.122, -0.14], // carTopRear
  [0.565, -0.148, 0.19], // carBottomFront
  [0.58, -0.138, -0.155], // carBottomRear
  [0.108, 0.152, -0.014], // tyreTop
  [0.078, -0.156, 0.004], // tyreBottom
  [0.575, -0.044, -0.165], // carSteer (toe link inner)
  [0.098, -0.04, -0.132], // tyreSteer (toe link outer)
] as const;

/** Pre-built `DoubleWishboneHardpoints` descriptors ready for `solveAxleKinematics3D` */
export const LC26_FRONT_HARDPOINTS: DoubleWishboneHardpoints = buildDoubleWishboneHardpoints(
  LC26_FRONT_HARDPOINTS_RAW,
  true,
  'pull_rod',
  { staticCasterTrailM: 0.0204 },
);

export const LC26_REAR_HARDPOINTS: DoubleWishboneHardpoints = buildDoubleWishboneHardpoints(
  LC26_REAR_HARDPOINTS_RAW,
  false,
  'push_rod',
  { staticCasterTrailM: 0.0156 },
);

export const LC26_ACTUATION_RODS_LOCAL = {
  frontPullrod: {
    chassisInner: [0.542, -0.168, 0.065] as Vec3Tuple,
    uprightOuter: [0.118, 0.134, 0.006] as Vec3Tuple,
    nominalMotionRatio: 0.78,
  },
  rearPushrod: {
    chassisInner: [0.548, 0.195, 0.05] as Vec3Tuple,
    uprightOuter: [0.115, -0.132, 0.018] as Vec3Tuple,
    nominalMotionRatio: 0.82,
  },
} as const;

// ---------------------------------------------------------------------------
// .glb Scene-Graph & Active Aero Hinge Contract
// ---------------------------------------------------------------------------

export const LC26_GLB_ASSET_PATH = '/cars/lc26-f1/lc26-f1.glb' as const;

export const LC26_GLB_NODE_NAMES = {
  chassis: 'chassis',
  plank: 'plank',
  fwFlap2: 'fw_flap_2',
  fwFlap3: 'fw_flap_3',
  rwFlap2: 'rw_flap_2',
  rwFlap3: 'rw_flap_3',
  ersSafetyLights: 'ers_safety_lights',
  steeringColumn: 'steering_column',
  steeringWheel: 'steering_wheel',
  mfdDisplay: 'mfd_display',
  shiftLeds: [
    'led_shift_01',
    'led_shift_02',
    'led_shift_03',
    'led_shift_04',
    'led_shift_05',
    'led_shift_06',
    'led_shift_07',
    'led_shift_08',
    'led_shift_09',
    'led_shift_10',
    'led_shift_11',
    'led_shift_12',
    'led_shift_13',
    'led_shift_14',
    'led_shift_15',
  ] as const,
  corners: {
    fl: 'corner_fl',
    fr: 'corner_fr',
    rl: 'corner_rl',
    rr: 'corner_rr',
  },
  wheels: {
    fl: 'wheel_fl',
    fr: 'wheel_fr',
    rl: 'wheel_rl',
    rr: 'wheel_rr',
  },
  tyreMeshes: {
    fl: 'wheel_fl_TYRE',
    fr: 'wheel_fr_TYRE',
    rl: 'wheel_rl_TYRE',
    rr: 'wheel_rr_TYRE',
  },
  calipers: {
    fl: 'caliper_fl',
    fr: 'caliper_fr',
    rl: 'caliper_rl',
    rr: 'caliper_rr',
  },
  specialMaterials: {
    mfdDisplay: 'INT_DISPLAY',
    ersSafetyLed: 'EXT_clearled_security',
    tyreMeshSuffix: '_TYRE',
  },
} as const;

export interface Lc26FlapHingeSpec {
  readonly nodeName: 'fw_flap_2' | 'fw_flap_3' | 'rw_flap_2' | 'rw_flap_3';
  readonly localPivotGltfM: Vec3Tuple;
  readonly hingeAxisGltf: Vec3Tuple;
  readonly cornerModeAngleDeg: number;
  readonly straightModeAngleDeg: number;
  readonly maxTransitionTimeS: number;
}

export const LC26_ACTIVE_AERO_HINGES: Record<'fwFlap2' | 'fwFlap3' | 'rwFlap2' | 'rwFlap3', Lc26FlapHingeSpec> = {
  fwFlap2: {
    nodeName: 'fw_flap_2',
    localPivotGltfM: [0, 0.174, 2.64],
    hingeAxisGltf: [1, 0, 0],
    cornerModeAngleDeg: 0,
    straightModeAngleDeg: -9.5,
    maxTransitionTimeS: 0.4,
  },
  fwFlap3: {
    nodeName: 'fw_flap_3',
    localPivotGltfM: [0, 0.239, 2.503],
    hingeAxisGltf: [1, 0, 0],
    cornerModeAngleDeg: 0,
    straightModeAngleDeg: -16.5,
    maxTransitionTimeS: 0.4,
  },
  rwFlap2: {
    nodeName: 'rw_flap_2',
    localPivotGltfM: [0, 0.846, -2.0],
    hingeAxisGltf: [1, 0, 0],
    cornerModeAngleDeg: 0,
    straightModeAngleDeg: -12.0,
    maxTransitionTimeS: 0.4,
  },
  rwFlap3: {
    nodeName: 'rw_flap_3',
    localPivotGltfM: [0, 0.916, -2.14],
    hingeAxisGltf: [1, 0, 0],
    cornerModeAngleDeg: 0,
    straightModeAngleDeg: -19.0,
    maxTransitionTimeS: 0.4,
  },
};

// ---------------------------------------------------------------------------
// Agent 2 (`suspension-ffb`): Suspension, Plank Wear & 500 Hz Kingpin FFB
// ---------------------------------------------------------------------------

export interface Lc26PlankWearState {
  /** Remaining plank thickness (mm) at each titanium strike point (`10.0` new, `< 9.0` illegal) */
  readonly frontSplitterMm: number;
  readonly midFloorMm: number;
  readonly rearTeaTrayMm: number;
  /** Instantaneous vertical ground contact force (N) on each strike */
  readonly strikeForcesN: readonly [front: number, mid: number, rear: number];
  /** Spark emission intensity `0..1` for visual & audio triggers */
  readonly sparkIntensity01: number;
}

export interface Lc26KingpinFfbInput {
  readonly dtS: number;
  readonly speedMs: number;
  readonly steeringWheelNormalized: number; // -1..+1 (+ = right)
  /** Front left & right tyre forces in corner road plane (N) */
  readonly frontLateralForceN: readonly [fl: number, fr: number];
  readonly frontLongitudinalForceN: readonly [fl: number, fr: number];
  readonly frontVerticalLoadN: readonly [fl: number, fr: number];
  /** Pneumatic self-aligning torque (Nm) from brush/contact-patch twist */
  readonly frontPneumaticAligningNm: readonly [fl: number, fr: number];
  /** Instantaneous front suspension heave travel (m, + = jounce) */
  readonly frontHeaveM: readonly [fl: number, fr: number];
  /** Kerb / road high-frequency normal impulse on front patches (N) */
  readonly frontKerbImpulseN?: readonly [fl: number, fr: number];
}

export interface Lc26KingpinFfbOutput {
  /** Torque felt by driver at steering wheel rim after hydraulic boost valve (Nm, + = pulls left / resists right turn) */
  readonly columnTorqueNm: number;
  /** Unassisted raw steering rack force (N) */
  readonly rackForceN: number;
  /** Normalized WebHID direct-drive command `-1..+1` (for nominal `15 Nm` DD base) */
  readonly webHidNormalized: number;
  /** Instantaneous solved left/right kingpin moments (Nm) */
  readonly kingpinMomentsNm: readonly [fl: number, fr: number];
}

export interface Lc26SuspensionModule {
  readonly chassis: ChassisData;
  readonly suspensions: SuspensionsData;
  readonly powerSteering: PowerSteeringData;
  computeKingpinFfb(input: Lc26KingpinFfbInput): Lc26KingpinFfbOutput;
  stepPlankWear(
    prev: Lc26PlankWearState,
    frontRideHeightM: number,
    rearRideHeightM: number,
    verticalVelMs: number,
    speedMs: number,
    dtS: number,
  ): Lc26PlankWearState;
}

// ---------------------------------------------------------------------------
// Agent 3 (`active-aero`): Active Aero, Ground Effect & Track SM Zones
// ---------------------------------------------------------------------------

/** Parametric dorsal engine-cover cooling gill level (`1` = tightest/lowest drag, `5` = maximum hot-weather opening) */
export type Lc26CoolingGillLevel = 1 | 2 | 3 | 4 | 5;

export type Lc26AeroOperatingMode =
  | 'corner-mode'
  | 'straight-mode'
  | 'partial-wet-fw-only'
  | 'failsafe-corner';

export interface Lc26FlapDeflectionState {
  readonly mode: Lc26AeroOperatingMode;
  /** `0` = full Corner Mode, `1` = full Straight Mode (`<= 400 ms` slew) */
  readonly smProgress01: number;
  readonly fwFlap2Deg: number;
  readonly fwFlap3Deg: number;
  readonly rwFlap2Deg: number;
  readonly rwFlap3Deg: number;
}

export interface Lc26SmZoneSegment {
  readonly zoneId: string;
  /** Normalized spline start `[0..1)` along track length */
  readonly startProgress01: number;
  /** Normalized spline end `[0..1)` along track length (supports wrap-around if `end < start`) */
  readonly endProgress01: number;
  /** Minimum speed threshold (km/h) for automatic/legal Straight Mode activation */
  readonly minActivationSpeedKmh: number;
  /** Optional lateral g ceiling above which SM auto-reverts to Corner Mode */
  readonly maxLateralG: number;
}

export interface Lc26CircuitSmZones {
  readonly circuitId: string;
  readonly trackLengthM: number;
  readonly zones: readonly Lc26SmZoneSegment[];
}

export interface Lc26AeroStepInput {
  readonly dtS: number;
  readonly speedMs: number;
  readonly airDensityKgM3: number;
  readonly frontRideHeightM: number;
  readonly rearRideHeightM: number;
  readonly yawSlipRad: number;
  readonly rollRad: number;
  readonly steerRad: number;
  readonly driverRequestsStraightMode: boolean;
  readonly inAuthorizedSmZone: boolean;
  readonly brakePedal01: number;
  readonly throttlePedal01: number;
  readonly lateralG: number;
  readonly trackWetness01: number;
  readonly rearFlapAllowedInWet: boolean;
  readonly actuatorFault?: boolean;
  /** Car ahead gap (s) for dirty-air wake downforce/drag reduction (`null` = clean air) */
  readonly gapAheadSeconds: number | null;
  readonly coolingGillLevel: Lc26CoolingGillLevel;
  readonly preset: AeroSetupPreset;
  readonly frontWingTrimDeg: number;
  readonly rearWingTrimDeg: number;
}

export interface Lc26AeroStepOutput {
  readonly flaps: Lc26FlapDeflectionState;
  readonly downforceFrontN: number;
  readonly downforceRearN: number;
  readonly totalDownforceN: number;
  readonly totalDragN: number;
  /** Aerodynamic centre of pressure (% front downforce, `0..1`) */
  readonly aeroBalanceFront01: number;
  /** Diffuser vortex stall / porpoising factor (`0` = attached, `1` = stalled) */
  readonly floorStallFactor01: number;
  /** Dirty-air wake downforce retention (`1.0` in clean air) */
  readonly wakeRetention01: number;
  /** Radiator/plenum heat rejection factor relative to baseline (`~0.88..1.16` across gill levels `1..5`) */
  readonly coolingRejectMultiplier: number;
}

export interface Lc26AeroModule {
  readonly aeroData: AeroData;
  createInitialState(): Lc26FlapDeflectionState;
  stepAero(prev: Lc26FlapDeflectionState, input: Lc26AeroStepInput): Lc26AeroStepOutput;
}

// ---------------------------------------------------------------------------
// Agent 4 (`powertrain-ecu`): 2026 MGU-H-Free V6, 350 kW MGU-K, Overtake & BBW
// ---------------------------------------------------------------------------

export const LC26_FIA_POWERTRAIN_LIMITS = {
  iceDisplacementCc: 1600,
  veeAngleDeg: 90,
  boreMm: 80.0,
  maxCompressionRatio: 16.0,
  maxBoostPlenumBarA: 4.8,
  idleRpm: 3800,
  fuelFlowKneeRpm: 10500,
  revLimitRpm: 12200,
  fiaMaxRpm: 15000,
  maxFuelEnergyFlowMjPerH: 3000,
  sustainableFuelLhvMjPerKg: 43.5,
  mgukMaxPowerKw: 350,
  mgukMaxCrankTorqueNm: 500,
  esMaxUsableDeltaSocJ: 4_000_000,
  maxHarvestPerLapStandardJ: 8_500_000,
  overtakeExtraDeployJ: 500_000,
  forwardGears: 8,
  minRearHydraulicBrakeTorqueNm: 2500,
} as const;

export type Lc26ErsDeployMode = PerformanceModeName | 'OVERTAKE';

export interface Lc26BbwSplitResult {
  readonly totalFrontAxleTorqueNm: number;
  readonly rearHydraulicTorqueNm: number;
  readonly rearMgukRegenTorqueNm: number;
  readonly effectiveFrontBias01: number;
  readonly harvestedPowerKw: number;
}

export interface Lc26PowertrainTelemetry {
  readonly iceTorqueNm: number;
  readonly icePowerKw: number;
  readonly mgukTorqueNm: number;
  readonly mgukPowerKw: number; // + deploy, - harvest
  readonly boostPressureBarA: number;
  readonly fuelMassFlowKgS: number;
  readonly fuelEnergyFlowMjH: number;
  readonly soc01: number;
  readonly lapDeployedJ: number;
  readonly lapHarvestedJ: number;
  readonly overtakeModeActive: boolean;
  readonly speedDerateCapKw: number;
}

export interface Lc26PowertrainModule {
  readonly engine: EngineData;
  readonly turbo: TurboData;
  readonly ers: ERSData;
  readonly gearbox: GearBoxData;
  readonly clutch: ClutchData;
  readonly differential: DifferentialData;
  readonly brakes: BrakesData;
  /** FIA Article C5.2.8 exact speed-based MGU-K mechanical power ceiling (kW) */
  computeFiaMgukPowerCapKw(speedKmh: number, overtakeModeActive: boolean): number;
  /** FIA Article C5.4.3 exact fuel energy flow ceiling (MJ/h) & mass flow ceiling (kg/s) */
  computeFiaFuelFlowCap(rpm: number): { maxEnergyMjH: number; maxMassKgS: number };
  /** Rear Brake-by-Wire blending of MGU-K harvest + hydraulic caliper torque with dynamic brake migration */
  solveBrakeByWire(
    brakePedal01: number,
    speedKmh: number,
    rpm: number,
    soc01: number,
    lapHarvestedJ: number,
    baseFrontBias01: number,
    migrationRamp01: number,
  ): Lc26BbwSplitResult;
}

// ---------------------------------------------------------------------------
// Agent 5 (`tyres-wet`): Narrowed 18" Pirelli C1-C5, 3-Layer Thermals & Wet
// ---------------------------------------------------------------------------

export type Lc26PirelliSlickCode = 'C1' | 'C2' | 'C3' | 'C4' | 'C5';

/** 3-band (`inner`, `middle`, `outer`) × 3-layer (`surface`, `bulk`, `core`) tyre temperatures (°C) */
export interface Lc26CornerThermalState {
  readonly surfaceBandsC: readonly [inner: number, middle: number, outer: number];
  readonly bulkBandsC: readonly [inner: number, middle: number, outer: number];
  readonly coreC: number;
  readonly carcassDynamicPsi: number;
  readonly graining01: number;
  readonly blistering01: number;
  /** Remaining tread life `1.0` = fresh -> `0.0` = worn to cords */
  readonly remainingLife01: number;
}

export interface Lc26WetEvacuationResult {
  /** Water evacuated per second (L/s) by contact-patch grooves / sipes */
  readonly evacuatedLitresPerSec: number;
  /** Residual water film thickness beneath contact patch (mm) */
  readonly residualFilmMm: number;
  /** Hydroplaning load support loss `0` = dry contact, `1` = full aquaplane */
  readonly hydroplaneFactor01: number;
  /** Effective grip multiplier including off-line wet-line vs polished rubbered-line crossover */
  readonly wetGripMultiplier: number;
}

export interface Lc26TyresModule {
  readonly compounds: Record<CompoundSlot, readonly [front: TyresCompoundData, rear: TyresCompoundData]>;
  readonly slickFamilyMapping: Record<'soft' | 'medium' | 'hard', Lc26PirelliSlickCode>;
  readonly wetTraits: Record<CompoundSlot, WetTyreTraits>;
  evaluateWetContact(
    compound: CompoundSlot,
    speedMs: number,
    waterFilmMm: number,
    offRubberedLine01: number,
    isRearAxle: boolean,
  ): Lc26WetEvacuationResult;
}

// ---------------------------------------------------------------------------
// Agent 6 (`cockpit-audio-ai`): Garage Setup, MFD/HUD, WebAudio & AI Racecraft
// ---------------------------------------------------------------------------

export interface Lc26GarageSetup {
  readonly aeroPreset: AeroSetupPreset;
  readonly frontWingAngleDeg: number;
  readonly rearWingAngleDeg: number;
  readonly coolingGillLevel: Lc26CoolingGillLevel;
  readonly frontRideHeightMm: number;
  readonly rearRideHeightMm: number;
  readonly frontHeaveRateNmm: number;
  readonly rearHeaveRateNmm: number;
  readonly frontCornerRateNmm: number;
  readonly rearCornerRateNmm: number;
  readonly frontArbStiffnessNmDeg: number;
  readonly rearArbStiffnessNmDeg: number;
  readonly frontPackerGapMm: number;
  readonly rearPackerGapMm: number;
  readonly camberDeg: SolverCornerOrder<number>;
  readonly toeDeg: readonly [frontToeOutDeg: number, rearToeInDeg: number];
  readonly coldPressurePsi: SolverCornerOrder<number>;
  readonly compound: TireCompound;
  readonly brakeBiasFrontPct: number;
  readonly brakeMigrationPct: number;
  readonly diffEntryLockPct: number;
  readonly diffMidCoastLockPct: number;
  readonly diffHighSpeedPreloadNm: number;
  readonly engineBrakingLevel: number; // 1..10
  readonly ersDeployMode: PerformanceModeName;
  readonly fuelLoadKg: number;
}

export type Lc26MfdPageId =
  | 'race-main'
  | 'ers-active-aero'
  | 'tyres-thermals'
  | 'brakes-diff'
  | 'fuel-plank';

export interface Lc26ShiftLedState {
  /** Active LED count `0..15` (`1..5` green, `6..10` red, `11..15` blue/purple) */
  readonly litCount: number;
  readonly pitLimiterBlink: boolean;
  readonly shiftFlashActive: boolean;
  readonly overtakeStrobeActive: boolean;
  readonly colorsHex: readonly string[]; // length 15
}

export interface Lc26AudioFrameInput {
  readonly rpm: number;
  readonly revLimitRpm: number;
  readonly throttle01: number;
  readonly pedal01: number;
  readonly gear: number; // -1 = R, 0 = N, 1..8
  readonly speedKmh: number;
  readonly boostBarGauge: number;
  readonly mgukPowerKw: number; // + deploy whine, - regen whine
  readonly straightModeProgress01: number;
  readonly tyreSlipPeak01: number;
  readonly plankSparkIntensity01: number;
  readonly cameraInterior: boolean;
}

export interface Lc26AudioController {
  init(ctx: AudioContext, destination?: AudioNode): void;
  update(frame: Lc26AudioFrameInput, dtS: number): void;
  triggerGearShift(direction: 'up' | 'down'): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export interface Lc26AiCircuitEntry {
  readonly paceScale: number;
  readonly brakeScale: number;
  readonly cornerGripScale: number;
  readonly straightModeAggression01: number;
  readonly overtakeSocReserve01: number;
}

export interface Lc26AiTuningSchema {
  readonly schemaVersion: 1;
  readonly carId: Lc26VehicleId;
  readonly version: string;
  readonly defaults: Lc26AiCircuitEntry;
  readonly circuits: Record<string, Partial<Lc26AiCircuitEntry>>;
}
