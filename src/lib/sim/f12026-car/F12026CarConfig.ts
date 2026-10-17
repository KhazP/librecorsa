/**
 * f12026-car vehicle data for `VehiclePhysics`.
 *
 * Structured multibody vehicle configuration covering powertrain, hybrid ERS, gearbox, differential,
 * suspension geometry, 4-way dampers, aerodynamics, setup limits and normalized-slip tyre compounds.
 *
 * Values are tagged:
 *  - [spec]     f12026-car target specification / FIA F1 technical regulations figures
 *  - [est]      engineering estimate for a ground-effect F1 car
 *  - [derived]  computed from other values in this file
 */

import type { LutPoints } from '../lut';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** `SuspensionTypeEnum` */
export type SuspensionTypeEnum =
  | 'SuspensionType_DoubleWishbone'
  | 'SuspensionType_DoubleWishboneCoilover'
  | 'SuspensionType_Strut'
  | 'SuspensionType_Axle'
  | 'SuspensionType_Multilink'
  | 'SuspensionType_MultilinkNew'
  | 'SuspensionType_StrutMultilink';

/** `PhysicsTyreCompound`: dry F1 slicks, dry GT3 slicks */
export type PhysicsTyreCompound =
  | 'PhysicsTyreCompound_F1_Soft'
  | 'PhysicsTyreCompound_F1_Medium'
  | 'PhysicsTyreCompound_F1_Hard'
  | 'PhysicsTyreCompound_GT3_Soft'
  | 'PhysicsTyreCompound_GT3_Medium'
  | 'PhysicsTyreCompound_GT3_Hard';

/** The simulator's soft / medium / hard choice */
export type CompoundSlot = 'soft' | 'medium' | 'hard';

/** `PerformanceModeData.performance_mode_name` */
export type PerformanceModeName = 'PSH' | 'RAC' | 'BAL' | 'LIC' | 'CHR';

/** Suspension types whose heave (third) element is active */
export function suspensionSupportsHeave(type: SuspensionTypeEnum): boolean {
  return type === 'SuspensionType_DoubleWishbone' || type === 'SuspensionType_DoubleWishboneCoilover';
}

// ---------------------------------------------------------------------------
// Chassis
// ---------------------------------------------------------------------------

export interface ChassisData {
  /** Car + driver, no fuel (kg) */
  totalMassKg: number;
  /** Static front axle share of the weight */
  frontWeightFraction: number;
  wheelbase: number;
  trackWidthFront: number;
  trackWidthRear: number;
  /** CG height above the ground at static ride height (m) */
  cgHeight: number;
  /** Principal inertias about the CG (kg·m²) */
  inertia: { pitch: number; roll: number; yaw: number };
  /** Unsprung mass per corner (wheel, tyre, upright, brake) (kg) */
  unsprungMassFront: number;
  unsprungMassRear: number;
  /** Wheel + tyre spin inertia per corner (kg·m²) */
  wheelInertiaFront: number;
  wheelInertiaRear: number;
  /** Road-wheel angle at full steering-wheel lock (deg) */
  maxRoadWheelDeg: number;
  /** Caster (mechanical) trail used for the steering-wheel torque only (m); default 12 mm */
  ffbMechanicalTrailM?: number;
}

// ---------------------------------------------------------------------------
// Power unit & drivetrain
// ---------------------------------------------------------------------------

export interface EngineData {
  /** ICE crank power (rpm → kW) */
  powerCurve: LutPoints;
  /** Closed-throttle engine braking (rpm → Nm, positive magnitude) */
  coastCurve: LutPoints;
  /** Pedal → throttle-plate map (0..1 → 0..1) */
  throttleResponseCurve: LutPoints;
  idleRpm: number;
  /** Crank + flywheel + MGU-K/H rotor inertia reflected to the crank (kg·m²) */
  inertia: number;
  /** Ignition cut held after the limiter trips (s) */
  limiterCutS: number;
}

export interface ERSData {
  /** Max MGU-K deploy torque at the crank (rpm → Nm) */
  torqueLut: LutPoints;
  /** Max MGU-K harvest torque at the crank (rpm → Nm, positive magnitude) */
  coastLut: LutPoints;
  /** MGU-K deploy power limit (W) — telemetry `ERS_MAX_DEPLOY` */
  ERS_MAX_DEPLOY: number;
  /** MGU-K harvest power limit (W) */
  maxHarvestW: number;
  /** Energy store usable window (J) — telemetry `ERS_MAX_CHARGE` */
  ERS_MAX_CHARGE: number;
  /** ES → MGU-K energy allowed per lap (J) */
  deployPerLapJ: number;
  /** MGU-K → ES energy allowed per lap (J) */
  harvestPerLapJ: number;
  /** Electrical round-trip efficiencies */
  deployEfficiency: number;
  harvestEfficiency: number;
  /** Lift detection: pedal below this counts as a lift for the top-gear harvest (0..1) */
  liftThrottle: number;
  /** Harvest power while lifting in top gear (W, before the mode scale) */
  topGearLiftHarvestW: number;
}

/** `PerformanceModeData`: one ERS / engine map selectable from the wheel */
export interface PerformanceModeData {
  performance_mode_name: PerformanceModeName;
  /** Fraction of `ERS_MAX_DEPLOY` available */
  deployFraction: number;
  /** Deploy multiplier vs road speed (km/h → 0..1) */
  deployVsSpeed: LutPoints;
  /** State of charge below which deployment stops (0..1) */
  socFloor: number;
  /** Brake-harvest power multiplier */
  brakeHarvestScale: number;
  /** Top-gear lift harvest multiplier */
  liftHarvestScale: number;
  /** ICE power diverted to the MGU-K at full throttle in top gear ("super clipping") (W) */
  topGearClipHarvestW: number;
  /** ICE power diverted to the MGU-K at part throttle (W) */
  partThrottleHarvestW: number;
  /** Closed-throttle engine-braking multiplier */
  coastTorqueScale: number;
  /** Electronic brake balance offset in EBB steps (+ = forward) */
  ebbOffset: number;
}

export interface GearBoxData {
  /** Forward gear ratios, 1st..8th */
  ratios: number[];
  reverse: number;
  finalDrive: number;
  /** Seamless shift: torque dip duration (s) and the torque kept during it */
  shiftTimeS: number;
  shiftTorqueFraction: number;
  efficiency: number;
  gears: {
    redline_rpm: number;
    upshift_rpm: number;
    downshift_rpm: number;
    /**
     * Auto box on the brakes: click down a gear as soon as the lower gear's road rpm is under this, as a driver does
     * into a braking zone (absent: on the brakes too it waits for `downshift_rpm`)
     */
    brake_downshift_rpm?: number;
  };
}

export interface ClutchData {
  maxTorqueNm: number;
  /** Auto-clutch: engine rpm where the clutch starts to bite and where it is fully closed */
  biteRpm: number;
  lockRpm: number;
}

/** `DifferentialSettingsUnits` */
export interface DifferentialSettingsUnits {
  /** Plate friction coefficient per face on power (ramp-LSD clamp gain) */
  power: number;
  /** Plate friction coefficient per face on coast */
  coast: number;
  /** Belleville preload (Nm) */
  preload: number;
  friction_faces: number;
  power_ramp_deg: number;
  coast_ramp_deg: number;
}

export interface DifferentialData {
  type: 'LSD_Ramp';
  settings: DifferentialSettingsUnits;
}

export interface BrakesData {
  /** Brake torque at full pedal before the bias split (Nm per wheel pair-equivalent, AC convention) */
  maxTorqueNm: number;
  /**
   * Rear brake-by-wire: rear friction yields to the engine / MGU-K braking already on the rear axle (F1).
   * false = conventional hydraulic brakes. Default true.
   */
  brakeByWire?: boolean;
  /** Base front bias (0..1) */
  front_bias: number;
  /** One EBB step moves the bias this much (0..1) */
  ebbStep: number;
}

// ---------------------------------------------------------------------------
// Suspension (`SuspensionsData`)
// ---------------------------------------------------------------------------

/** `DamperSettingsUnits` (wheel-rate damping, Ns/m) */
export interface DamperSettingsUnits {
  slow_bump: number;
  fast_bump: number;
  slow_rebound: number;
  fast_rebound: number;
}

/** `DamperControllerData`: base corner damper plus the heave / roll / pitch mode dampers */
export interface DamperControllerData {
  base: DamperSettingsUnits;
  heave: DamperSettingsUnits;
  roll: DamperSettingsUnits;
  pitch: DamperSettingsUnits;
  /** Slow/fast knee (m/s) */
  fastThresholdMs: number;
  /** Rebound slow/fast knee of the base damper (m/s); default `fastThresholdMs` */
  fastReboundThresholdMs?: number;
}

/** `BumpStopSettingsUnits` */
export interface BumpStopSettingsUnits {
  /** Free travel from static ride height to bump-rubber contact (m) */
  range: number;
  /** Bump-rubber rate at the wheel (N/m), progressive with `progression` */
  rate: number;
  /** Extra rate per metre of rubber compression (N/m²) */
  progression: number;
}

/** `SuspensionSettingUnits` */
export interface SuspensionSettingUnits {
  /** Main spring rate at the wheel (N/m) */
  wheel_rate: number;
  /** Helper spring rate in series with the main spring (N/m) */
  helper_rate: number;
  /** Helper travel before it goes coil-bound (m) */
  helper_range: number;
}

/** Third (heave) element on the axle */
export interface HeaveSpringData {
  /** Rate at the wheel per unit axle heave (N/m) */
  rate: number;
  /** Heave travel before the element engages (m) */
  gap: number;
  /** Packer: rate added once heave exceeds `packerGap` (N/m) */
  packerGap: number;
  packerRate: number;
}

/** `SuspensionGeometryData` + the axle's setup values */
export interface AxleSuspensionData {
  type: SuspensionTypeEnum;
  actuation: 'pull_rod' | 'push_rod';
  /** `BasicSuspensionData.staticCamber` (deg, negative = top inward) */
  staticCamber: number;
  /** Kinematic camber change with bump (deg per m of compression) */
  camberGainKinematic: number;
  springs: SuspensionSettingUnits;
  heave: HeaveSpringData;
  bumpStop: BumpStopSettingsUnits;
  /** Rebound travel from static to the droop limiter (m) */
  droopTravel: number;
  /** Kinematic roll-centre height above the ground (m): tyre forces act on the body here */
  rollCentreHeight: number;
  /** Anti-roll bar rate at the wheel (`MechanicalBalanceUnits.arbs`, N/m) */
  arb: number;
}

export interface SuspensionsData {
  front: AxleSuspensionData;
  rear: AxleSuspensionData;
  dampers_controller: { front: DamperControllerData; rear: DamperControllerData };
}

// ---------------------------------------------------------------------------
// Aero (`AeroData`, `WingData`)
// ---------------------------------------------------------------------------

export interface WingData {
  name: 'FRONT_WING' | 'VENTURI_FLOOR' | 'REAR_WING';
  /** Reference area (m²): CL·area and CD·area are the force coefficients */
  area: number;
  /** Longitudinal centre of pressure from the CG (m, + = forward) */
  positionZ: number;
  /** Setup angle of attack (deg); body rake is added at run time */
  angleDeg: number;
  /** Ride height that drives the ground-height LUTs */
  heightRef: 'front' | 'rear' | 'mean';
  /** Lift coefficient vs angle of attack (deg → CL, + = downforce) */
  lutAOA_CL: LutPoints;
  lutAOA_CD: LutPoints;
  /** Ground-height multipliers (ride height m → ×) */
  lutGH_CL_mult: LutPoints;
  lutGH_CD_mult: LutPoints;
  /** DRS multipliers on this element (only the rear wing has a flap) */
  drs?: { clMult: number; cdMult: number };
}

/** `ZoneData_DRSZone` (fractions of a lap) */
export interface ZoneData_DRSZone {
  id: string;
  detection: number;
  start: number;
  end: number;
}

export interface AeroData {
  /** Bodywork (non-wing) lift coefficient × area at each axle (m², + = downforce) */
  front_lift: number;
  rear_lift: number;
  /** Bodywork drag coefficient × area (m²) */
  drag: number;
  wings: WingData[];
  /** `AeroSettingsUnits.front_target_height` / `rear_target_height`: static floor heights (m) */
  front_target_height: number;
  rear_target_height: number;
  /** Floor reference plane below the CG in the body frame (m) */
  floorOffsetY: number;
  /** DRS flap travel time (s) */
  drsTransitionS: number;
  /** DRS closes when the throttle falls below this (a lift), as well as on the brake */
  drsCloseThrottle: number;
  /** Air density (kg/m³) */
  airDensity: number;
}

// ---------------------------------------------------------------------------
// Tyres (`TyresCompoundData`)
// ---------------------------------------------------------------------------

export interface TyreGeometry {
  /** Section width (m) */
  width: number;
  /** Unloaded radius (m) */
  radius: number;
  rimRadius: number;
  /** Vertical-rate multiplier on `pressureSpringCurve` for this axle */
  verticalRateScale: number;
}

/** Peak slip angle used when `friction_limit_angle` is unset or 0 (deg) */
export const DEFAULT_FRICTION_LIMIT_ANGLE_DEG = 7.5;

/**
 * `TyresModelData`: load-sensitive normalized-slip tyre parameters with combined-slip cross terms
 * and past-peak falloff.
 */
export interface TyresModelData {
  /** Reference friction coefficients at `Fz0` (lateral / longitudinal) */
  Dy0: number;
  Dx0: number;
  /** Load-sensitivity exponents: μ ∝ (Fz / Fz0)^(exp − 1) */
  lsExpY: number;
  lsExpX: number;
  /**
   * Reference load (N) for the front section width. The rear's scales with its width: load sensitivity follows
   * contact pressure, so a wider tyre at the same load keeps more μ
   */
  Fz0: number;
  /** Slip angle at peak lateral force (deg); `DEFAULT_FRICTION_LIMIT_ANGLE_DEG` when unset or 0 */
  friction_limit_angle?: number;
  /** Slip ratio at peak longitudinal force */
  slip_ratio_limit: number;
  /**
   * Stereo's combined factor k (0..2): the combined slip seen by each axis is √(s_own² + (k·s_other)²).
   * 1 = friction circle, < 1 = relaxed (elliptical) cross-axis penalty, > 1 = harsher penalty.
   */
  combinedFactor: number;
  /** Enables the asymmetric cross-axis shift / scale terms below */
  new_combined: boolean;
  /** Longitudinal slip: s_x·(1 − fx_scale_SA·min(1, |s_y|)) + fx_shift_SA·s_y */
  fx_shift_SA: number;
  fx_scale_SA: number;
  /** Lateral slip: s_y·(1 − fy_scale_SR·min(1, |s_x|)) + fy_shift_SR·s_x */
  fy_shift_SR: number;
  fy_scale_SR: number;
  /**
   * Past-peak shape. false: the Magic Formula curve is fitted so the force at 3 × peak slip is
   * `falloff_level`. true: the curve follows the Magic Formula to the peak, then decays as
   * falloff_level + (1 − falloff_level)·exp(−falloff_slope·(s − 1)²).
   */
  use_slip_falloff: boolean;
  /** High-slip force as a fraction of the peak */
  falloff_level: number;
  /** Decay rate past the peak (per unit (s − 1)²), used with `use_slip_falloff` */
  falloff_slope: number;
  /** Carcass relaxation lengths (m) */
  relaxationLengthX: number;
  relaxationLengthY: number;
  /** Rolling-resistance coefficient */
  rollingResistance: number;
  /** Radial damping (Ns/m) */
  verticalDamping: number;
  /** Pneumatic trail at zero slip (m) */
  pneumaticTrail: number;
}

/** `TyresThermalPatchData` + the lumped 2-node thermal model */
export interface TyresThermalPatchData {
  /** Surface temperature (°C) → grip multiplier (peak is the compound's peak grip) */
  thermalPerformanceCurve: LutPoints;
  /** Optimal surface window (°C), for the UI */
  optimalTempC: [number, number];
  /** Heat capacities (J/K) */
  surfaceHeatCapacity: number;
  coreHeatCapacity: number;
  /** Share of sliding power that heats the tread surface */
  slipHeatShare: number;
  /** Rolling hysteresis power coefficient (W per N per m/s) */
  hysteresis: number;
  /** Surface → core conductance (W/K) */
  surfaceToCore: number;
  /** Convective cooling: G = g0 + g1·v (W/K) for surface and core */
  surfaceCooling: [number, number];
  coreCooling: [number, number];
  /** Vertical-rate change per °C of core temperature away from the reference */
  thermalVerticalK: number;
  thermalVerticalRefC: number;
}

/** `TyresPressureData` */
export interface TyresPressureData {
  /** Hot inflation pressure for peak grip (psi) */
  optimalPsi: number;
  /** Inflation pressure (psi) → radial stiffness (N/m) */
  pressureSpringCurve: LutPoints;
  /** Grip loss per (ΔP / P_opt)² */
  pressureGripSensitivity: number;
  /** Temperature the cold pressure is set at (°C, tyre blankets) */
  coldRefC: number;
}

/** `TyresCamberData` + `TyreCompoundGeneratorGeneralData` contact-camber terms */
export interface TyresCamberData {
  /** Camber thrust gain (N per N of load at the cubic's slope) */
  camberGain: number;
  /** Camber thrust shape: thrust ∝ c1·γ − c2·γ³ (γ in rad) */
  contact_camber_c1: number;
  contact_camber_c2: number;
  /** Lateral grip vs camber leaning into the force: 1 + dcamber0·γ + dcamber1·γ² (rad) */
  dcamber0: number;
  dcamber1: number;
  /** Longitudinal grip vs camber magnitude: 1 + dcamber0_x·|γ| + dcamber1_x·γ² (rad) */
  dcamber0_x: number;
  dcamber1_x: number;
}

export interface TyresCompoundData {
  name: string;
  shortName: 'S' | 'M' | 'H';
  tyre_compound: PhysicsTyreCompound;
  front: TyreGeometry;
  rear: TyreGeometry;
  modelData: TyresModelData;
  thermalData: TyresThermalPatchData;
  pressureData: TyresPressureData;
  camberData: TyresCamberData;
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

export interface CarPhysicsConfig {
  screenName: string;
  chassis: ChassisData;
  engine: EngineData;
  ers: ERSData;
  performanceModes: Record<PerformanceModeName, PerformanceModeData>;
  gearbox: GearBoxData;
  clutch: ClutchData;
  differential: DifferentialData;
  brakes: BrakesData;
  suspensions: SuspensionsData;
  aero: AeroData;
  /** The car's compounds; `compoundSlots` picks one for each of the simulator's soft / medium / hard */
  tyreCompounds: Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;
  compoundSlots: Record<CompoundSlot, PhysicsTyreCompound>;
}

/** A compound of `config`, or an error when the car does not have it */
export function compoundData(config: CarPhysicsConfig, compound: PhysicsTyreCompound): TyresCompoundData {
  const data = config.tyreCompounds[compound];
  if (!data) throw new Error(`${config.screenName} has no ${compound}`);
  return data;
}

// ===========================================================================
// f12026-car values
// ===========================================================================

const KW_PEAK = 580;

/** ICE: 1.6 L V6 turbo, fuel-flow limited flat top 10 500–12 500 rpm [spec peak, est shape] */
const F12026_ENGINE: EngineData = {
  powerCurve: [
    [1000, 25],
    [3000, 90],
    [5000, 175],
    [7000, 295],
    [8000, 375],
    [9000, 460],
    [10000, 548],
    [10500, KW_PEAK],
    [12500, KW_PEAK],
    [13200, 570],
    [14000, 545],
    [15000, 505],
  ],
  coastCurve: [
    [1000, 18],
    [5000, 40],
    [10000, 78],
    [15000, 112],
  ],
  // Progressive at the top of the travel (a torque-demand driveability map): the corner-exit range of the
  // pedal meters the power in finely instead of front-loading it [est]
  throttleResponseCurve: [
    [0, 0],
    [0.25, 0.18],
    [0.5, 0.42],
    [0.75, 0.7],
    [1, 1],
  ],
  idleRpm: 4000,
  inertia: 0.09,
  limiterCutS: 0.02,
};

/** MGU-K torque at the crank: 200 Nm at the K shaft × ~3.33 gearing, then the 120 kW hyperbola [spec] */
function mgukCrankTorqueLut(maxW: number, maxCrankNm: number): LutPoints {
  const pts: [number, number][] = [[0, maxCrankNm]];
  const kneeRpm = (maxW / maxCrankNm) * (60 / (2 * Math.PI));
  pts.push([kneeRpm, maxCrankNm]);
  for (let rpm = 2500; rpm <= 15000; rpm += 1250) {
    if (rpm <= kneeRpm) continue;
    pts.push([rpm, maxW / (rpm * ((2 * Math.PI) / 60))]);
  }
  return pts;
}

const ERS_MAX_DEPLOY_W = 120_000;

const F12026_ERS: ERSData = {
  torqueLut: mgukCrankTorqueLut(ERS_MAX_DEPLOY_W, 667),
  coastLut: mgukCrankTorqueLut(ERS_MAX_DEPLOY_W, 667),
  ERS_MAX_DEPLOY: ERS_MAX_DEPLOY_W,
  maxHarvestW: 120_000,
  ERS_MAX_CHARGE: 4_000_000,
  deployPerLapJ: 4_000_000,
  harvestPerLapJ: 2_000_000,
  deployEfficiency: 0.95,
  harvestEfficiency: 0.92,
  liftThrottle: 0.15,
  topGearLiftHarvestW: 90_000,
};

const FULL_SPEED: LutPoints = [
  [0, 1],
  [400, 1],
];

const F12026_PERFORMANCE_MODES: Record<PerformanceModeName, PerformanceModeData> = {
  PSH: {
    performance_mode_name: 'PSH',
    deployFraction: 1,
    deployVsSpeed: FULL_SPEED,
    socFloor: 0,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1,
    ebbOffset: 0,
  },
  RAC: {
    performance_mode_name: 'RAC',
    deployFraction: 0.85,
    deployVsSpeed: [
      [0, 1],
      [290, 1],
      [330, 0.55],
    ],
    socFloor: 0.2,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1,
    ebbOffset: 1,
  },
  BAL: {
    performance_mode_name: 'BAL',
    deployFraction: 0.7,
    deployVsSpeed: [
      [0, 1],
      [270, 1],
      [310, 0.4],
    ],
    socFloor: 0.4,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 60_000,
    partThrottleHarvestW: 20_000,
    coastTorqueScale: 1,
    ebbOffset: 0,
  },
  LIC: {
    performance_mode_name: 'LIC',
    deployFraction: 0.75,
    deployVsSpeed: FULL_SPEED,
    socFloor: 0.2,
    brakeHarvestScale: 1,
    liftHarvestScale: 0.3,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 0.35,
    ebbOffset: 0,
  },
  CHR: {
    performance_mode_name: 'CHR',
    deployFraction: 0.25,
    deployVsSpeed: FULL_SPEED,
    socFloor: 0,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 120_000,
    partThrottleHarvestW: 80_000,
    coastTorqueScale: 1.15,
    ebbOffset: 0,
  },
};

/** 8-speed seamless: ~105 / 140 / 170 / 200 / 232 / 266 / 305 / 352 km/h at 15 000 rpm [est] */
const F12026_GEARBOX: GearBoxData = {
  ratios: [6.32, 4.74, 3.9, 3.32, 2.86, 2.49, 2.18, 1.885],
  reverse: 6.0,
  finalDrive: 3.0,
  shiftTimeS: 0.03,
  shiftTorqueFraction: 0.85,
  efficiency: 0.93,
  gears: {
    redline_rpm: 15000,
    upshift_rpm: 13200,
    downshift_rpm: 9800,
  },
};

const F12026_CLUTCH: ClutchData = {
  maxTorqueNm: 900,
  biteRpm: 4500,
  lockRpm: 8000,
};

const F12026_DIFFERENTIAL: DifferentialData = {
  type: 'LSD_Ramp',
  settings: {
    power: 0.075,
    coast: 0.06,
    preload: 80,
    friction_faces: 8,
    power_ramp_deg: 45,
    coast_ramp_deg: 55,
  },
};

const F12026_BRAKES: BrakesData = {
  maxTorqueNm: 7000,
  front_bias: 0.565,
  ebbStep: 0.005,
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

/** Pull-rod double wishbones front and rear [spec layout, est rates] */
const F12026_SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'pull_rod',
    staticCamber: -3.5,
    camberGainKinematic: -18,
    springs: { wheel_rate: 190_000, helper_rate: 60_000, helper_range: 0.0015 },
    heave: { rate: 600_000, gap: 0.002, packerGap: 0.01, packerRate: 1_500_000 },
    bumpStop: { range: 0.016, rate: 650_000, progression: 60_000_000 },
    droopTravel: 0.03,
    rollCentreHeight: 0.045,
    arb: 170_000,
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'pull_rod',
    staticCamber: -2.0,
    camberGainKinematic: -14,
    springs: { wheel_rate: 150_000, helper_rate: 50_000, helper_range: 0.002 },
    heave: { rate: 450_000, gap: 0.004, packerGap: 0.02, packerRate: 1_200_000 },
    bumpStop: { range: 0.03, rate: 550_000, progression: 40_000_000 },
    droopTravel: 0.04,
    rollCentreHeight: 0.08,
    arb: 85_000,
  },
  dampers_controller: {
    front: {
      base: damper(5200, 3000, 7800, 4600),
      heave: damper(6000, 3500, 7000, 4200),
      roll: damper(2400, 1600, 2600, 1800),
      pitch: damper(2000, 1400, 2200, 1500),
      fastThresholdMs: 0.08,
    },
    rear: {
      base: damper(5000, 2900, 7400, 4300),
      heave: damper(5200, 3100, 6200, 3800),
      roll: damper(2000, 1400, 2200, 1500),
      pitch: damper(2000, 1400, 2200, 1500),
      fastThresholdMs: 0.08,
    },
  },
};

/**
 * Aero split into front wing, venturi floor and rear wing.
 * At static heights with zero rake change: CL·A ≈ 4.5 m², CD·A ≈ 1.22 m², ~45 % front [est].
 * DRS: rear wing −18 % CL and −28 % CD [spec of this task].
 */
const F12026_AERO: AeroData = {
  front_lift: 0,
  rear_lift: -0.05,
  drag: 0.42,
  wings: [
    {
      name: 'FRONT_WING',
      area: 1,
      positionZ: 2.66,
      angleDeg: 14,
      heightRef: 'front',
      lutAOA_CL: [
        [6, 0.72],
        [10, 0.93],
        [14, 1.1],
        [18, 1.22],
        [22, 1.27],
      ],
      lutAOA_CD: [
        [6, 0.12],
        [10, 0.15],
        [14, 0.18],
        [18, 0.22],
        [22, 0.27],
      ],
      lutGH_CL_mult: [
        [0.005, 1.08],
        [0.02, 1.05],
        [0.032, 1],
        [0.06, 0.93],
        [0.1, 0.86],
      ],
      lutGH_CD_mult: [
        [0.005, 1.03],
        [0.032, 1],
        [0.1, 0.97],
      ],
    },
    {
      name: 'VENTURI_FLOOR',
      area: 1,
      positionZ: -0.35,
      angleDeg: 0,
      heightRef: 'mean',
      // Angle of attack = body rake (deg): more rake feeds the diffuser up to a point
      lutAOA_CL: [
        [-0.5, 2.05],
        [0, 2.25],
        [0.6, 2.4],
        [1.2, 2.45],
        [2, 2.3],
      ],
      lutAOA_CD: [
        [-0.5, 0.19],
        [0.6, 0.2],
        [2, 0.23],
      ],
      // Venturi suction peaks near 25–35 mm, collapses toward the plank (stall / porpoising band)
      lutGH_CL_mult: [
        [0, 0.45],
        [0.01, 0.7],
        [0.018, 0.95],
        [0.025, 1.08],
        [0.035, 1.1],
        [0.051, 1],
        [0.07, 0.86],
        [0.1, 0.68],
        [0.15, 0.48],
      ],
      lutGH_CD_mult: [
        [0, 1.15],
        [0.018, 1.04],
        [0.051, 1],
        [0.15, 0.9],
      ],
    },
    {
      name: 'REAR_WING',
      area: 1,
      positionZ: -2.35,
      angleDeg: 10,
      heightRef: 'rear',
      lutAOA_CL: [
        [4, 0.66],
        [7, 0.84],
        [10, 1],
        [13, 1.12],
        [16, 1.2],
      ],
      lutAOA_CD: [
        [4, 0.27],
        [7, 0.34],
        [10, 0.42],
        [13, 0.5],
        [16, 0.58],
      ],
      lutGH_CL_mult: [
        [0, 1],
        [0.2, 1],
      ],
      lutGH_CD_mult: [
        [0, 1],
        [0.2, 1],
      ],
      drs: { clMult: 0.82, cdMult: 0.72 },
    },
  ],
  front_target_height: 0.032,
  rear_target_height: 0.07,
  floorOffsetY: -0.2273,
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** Surface temperature curve for a compound: plateau at `peak` over [lo, hi] */
function compoundThermalCurve(peak: number, lo: number, hi: number): LutPoints {
  return [
    [10, peak * 0.74],
    [lo - 45, peak * 0.84],
    [lo - 20, peak * 0.94],
    [lo, peak],
    [hi, peak],
    [hi + 20, peak * 0.955],
    [hi + 45, peak * 0.88],
    [hi + 80, peak * 0.76],
  ];
}

/** Pirelli P Zero 18": front 305/720-R18, rear 405/720-R18 [spec] */
const F1_FRONT: TyreGeometry = { width: 0.305, radius: 0.36, rimRadius: 0.2286, verticalRateScale: 1 };
const F1_REAR: TyreGeometry = { width: 0.405, radius: 0.36, rimRadius: 0.2286, verticalRateScale: 1.12 };

function f1Compound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  peakGrip: number,
  window: [number, number],
  falloffLevel: number
): TyresCompoundData {
  return {
    name,
    shortName,
    tyre_compound,
    front: F1_FRONT,
    rear: F1_REAR,
    modelData: {
      Dy0: 1.78,
      Dx0: 1.8,
      lsExpY: 0.86,
      lsExpX: 0.88,
      Fz0: 4000,
      friction_limit_angle: 8,
      slip_ratio_limit: 0.1,
      // Pure friction circle with no cross-axis terms: the tuned baseline [est]
      combinedFactor: 1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      use_slip_falloff: false,
      falloff_level: falloffLevel,
      falloff_slope: 0.6,
      relaxationLengthX: 0.14,
      relaxationLengthY: 0.32,
      rollingResistance: 0.012,
      verticalDamping: 450,
      pneumaticTrail: 0.035,
    },
    thermalData: {
      thermalPerformanceCurve: compoundThermalCurve(peakGrip, window[0], window[1]),
      optimalTempC: window,
      surfaceHeatCapacity: 1500,
      coreHeatCapacity: 9500,
      slipHeatShare: 0.35,
      hysteresis: 0.0042,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.0012,
      thermalVerticalRefC: 100,
    },
    pressureData: {
      optimalPsi: 25,
      pressureSpringCurve: [
        [16, 215_000],
        [20, 250_000],
        [25, 290_000],
        [28, 315_000],
        [32, 345_000],
      ],
      pressureGripSensitivity: 1.6,
      coldRefC: 70,
    },
    camberData: {
      camberGain: 0.55,
      contact_camber_c1: 1,
      contact_camber_c2: 45,
      dcamber0: 0.9,
      dcamber1: -12,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
  };
}

const F12026_TYRES = {
  PhysicsTyreCompound_F1_Soft: f1Compound('PhysicsTyreCompound_F1_Soft', 'Soft', 'S', 1.0, [95, 110], 0.8),
  PhysicsTyreCompound_F1_Medium: f1Compound('PhysicsTyreCompound_F1_Medium', 'Medium', 'M', 0.96, [100, 125], 0.82),
  PhysicsTyreCompound_F1_Hard: f1Compound('PhysicsTyreCompound_F1_Hard', 'Hard', 'H', 0.92, [105, 140], 0.84),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

export const F12026_CAR_CONFIG = {
  screenName: 'f12026-car',
  chassis: {
    totalMassKg: 800,
    frontWeightFraction: 0.455,
    wheelbase: 3.6,
    trackWidthFront: 1.6,
    trackWidthRear: 1.55,
    cgHeight: 0.28,
    inertia: { pitch: 1000, roll: 190, yaw: 1080 },
    unsprungMassFront: 12,
    unsprungMassRear: 14,
    wheelInertiaFront: 1.0,
    wheelInertiaRear: 1.3,
    maxRoadWheelDeg: 18,
  },
  engine: F12026_ENGINE,
  ers: F12026_ERS,
  performanceModes: F12026_PERFORMANCE_MODES,
  gearbox: F12026_GEARBOX,
  clutch: F12026_CLUTCH,
  differential: F12026_DIFFERENTIAL,
  brakes: F12026_BRAKES,
  suspensions: F12026_SUSPENSIONS,
  aero: F12026_AERO,
  tyreCompounds: F12026_TYRES,
  compoundSlots: {
    soft: 'PhysicsTyreCompound_F1_Soft',
    medium: 'PhysicsTyreCompound_F1_Medium',
    hard: 'PhysicsTyreCompound_F1_Hard',
  },
} satisfies CarPhysicsConfig;
