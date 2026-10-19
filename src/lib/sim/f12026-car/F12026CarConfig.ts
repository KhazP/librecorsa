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
 *  - [ref_…]    2026 open-wheel reference data files
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
  /**
   * Steering compliance: road-wheel angle each front wheel gives up per kN of its own lateral force (deg/kN, rack /
   * tie-rod / bush flex). Adds understeer gradient roughly linearly in lateral g; default 0 (rigid)
   */
  steerComplianceDegPerKN?: number;
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
  /** Deploy multiplier by gear (gear number → 0..1, the source's per-gear table); default 1 in every gear */
  deployVsGear?: LutPoints;
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
  /** Electronic diff: the coast locking (same units as `coast`) while braking, i.e. on corner entry; default `coast` */
  coastBraking?: number;
  /** 2026 3-Phase Active Electronic Differential (Entry braking <= -0.5G, Mid apex -0.5G..+0.5G, Exit/HiSpd > +0.5G or > 250 km/h) */
  threePhase?: boolean;
  /** Default Entry coast locking dial (1..12, where locking = (level - 1) / 11; default 3 -> 18.2%) */
  diffEntryLevel?: number;
  /** Default Mid-corner apex locking dial (1..12; default 5 -> 36.4%) */
  diffMidLevel?: number;
  /** Default Exit / High-Speed power locking dial (1..12; default 5 -> 36.4%) */
  diffExitLevel?: number;
  /** High-speed straight stability threshold where Exit/HiSpd lock engages regardless of G_long (km/h; default 250) */
  hiSpdSwitchKmh?: number;
}

export interface BrakesData {
  /** Brake torque at full pedal before the bias split (Nm per wheel pair-equivalent) */
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
  /** Disc / pad material for the brake thermal model and pad μ(T) (default carbon-carbon, F1) */
  discMaterial?: 'carbon-ceramic' | 'endurance-steel';
  /**
   * Brake-by-wire migration: the bias moves forward by `amount` at full pedal, starting at `rampStart` of the pedal
   * travel (BRAKE_MIGRATION + BMIG_RAMP). Default 0.015 from the first of the travel
   */
  migration?: { amount: number; rampStart: number };
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
  /**
   * 3D wishbone + steering link pickup coordinates `[x_inboard, y_up, z_fwd]` from the wheel center (m):
   * `[WBCAR_TOP_FRONT, WBCAR_TOP_REAR, WBCAR_BOTTOM_FRONT, WBCAR_BOTTOM_REAR, WBTYRE_TOP, WBTYRE_BOTTOM, WBCAR_STEER?, WBTYRE_STEER?]`
   */
  hardpoints?: ReadonlyArray<readonly [number, number, number]>;
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
  /**
   * The plank's skid surface in the body frame (m): its height and its front and rear ends (z, + forward). Absent,
   * the skids sit on the floor reference plane under the axles.
   */
  plank?: { y: number; frontZ: number; rearZ: number };
  /** DRS flap travel time (s) */
  drsTransitionS: number;
  /** DRS closes when the throttle falls below this (a lift), as well as on the brake */
  drsCloseThrottle: number;
  /** Air density (kg/m³) */
  airDensity: number;
  /**
   * 2D ride-height aero map (`MAP_CL_RH` / `MAP_CD_RH` / `MAP_BALANCE_RH`): when present the body's downforce, drag and
   * balance come from it, and `wings` only add their angle-dependent offsets on top
   */
  rhMap?: AeroRideHeightMap;
}

/** 2D ride-height aero map: coefficients × area, scaled by 2D ride-height tables and by roll / yaw */
export interface AeroRideHeightMap {
  /** CL·A and CD·A (m²) the tables multiply */
  clA: number;
  cdA: number;
  /** Ride-height pickups below the CG in the body frame (m), at the axles; the tables read their ground clearance */
  frontPickupY: number;
  rearPickupY: number;
  /** Table axes (m): rows are the rear ride height, columns the front */
  rearRh: number[];
  frontRh: number[];
  /** [row][col] multipliers on CL·A and CD·A, and the front share of the downforce */
  cl: number[][];
  cd: number[][];
  balance: number[][];
  /** Body roll (deg) → CL / CD multipliers and balance offset */
  rollCl: LutPoints;
  rollCd: LutPoints;
  rollBalance: LutPoints;
  /** Body yaw (slip, deg) → CL / CD multipliers and balance offset */
  yawCl: LutPoints;
  yawCd: LutPoints;
  yawBalance: LutPoints;
  /** First-order lags on the front / rear downforce and the drag (s) */
  frontDelayS: number;
  rearDelayS: number;
  dragDelayS: number;
  /** Active aero (straight-line mode) at full open: CL·A change at each axle and CD·A change (m², negative) */
  activeAero: { dClAFront: number; dClARear: number; dCdA: number };
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
   * Reference load (N) for the front section width. Without a `rearOverride.modelData.Fz0` the rear's scales with
   * its width: load sensitivity follows contact pressure, so a wider tyre at the same load keeps more μ
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
  /**
   * Tabulated load sensitivity (DY_CURVE / DX_CURVE): vertical load (N) → peak μ. When set it replaces
   * `Dy0`·(Fz/Fz0)^(lsExp−1) for that axis; Fz0 / lsExp then only matter to code that reads them directly
   */
  dyCurve?: LutPoints;
  dxCurve?: LutPoints;
  /** BRAKE_DX_MOD: longitudinal μ × (1 + brakeDxMod) while the tyre is braking (negative slip ratio) */
  brakeDxMod?: number;
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
  /**
   * The rear tyre's own values where it differs from the front (the source's [REAR] tyre data); everything else is shared.
   * A rear `Fz0` given here is used as is, instead of the front's scaled by section width
   */
  rearOverride?: {
    modelData?: Partial<TyresModelData>;
    camberData?: Partial<TyresCamberData>;
    pressureData?: Partial<TyresPressureData>;
  };
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

// The f12026-car runs on 2026 open-wheel reference specification data,
// tagged [ref_<file>]: the mod's tables in our units. Where our model differs from the source's, the value is mapped and
// tagged [derived] or [est].

/** Driveline efficiency: the source power curve is torque at the wheels, so the crank torque is the curve / this */
const F12026_DRIVELINE_EFFICIENCY = 0.93;

/** ICE torque at the wheels before the turbo (rpm → Nm) [ref_power.lut] */
const REF_WHEEL_TORQUE: [number, number][] = [
  [0, 46.681],
  [870, 46.681],
  [1740, 82.725],
  [2610, 106.647],
  [3480, 117.457],
  [4350, 133.481],
  [5220, 145.937],
  [6090, 152.378],
  [6960, 156.473],
  [7830, 161.383],
  [8700, 166.622],
  [9570, 170.113],
  [10440, 168.304],
  [11310, 158.036],
  [12180, 143.065],
  [13050, 125.964],
];

/** Turbo boost on the curve: MAX_BOOST 1.12 (torque × 2.12), reached at REFERENCE_RPM 3700 with GAMMA 1.5 [ref_engine.ini] */
const refBoost = (rpm: number) => Math.min(1.12, 1.12 * (rpm / 3700) ** 1.5);

/**
 * ICE crank power (kW): ≈389 kW at 9570 rpm, ≈361 kW of it at the wheels [derived]. The 0 rpm row is left out: as
 * power it would be 0 kW, and a stalled engine could never pick up again; below 870 rpm the curve holds its first
 * value instead (the source reads the row as torque, which keeps it turning too).
 */
const ICE_POWER_CURVE: LutPoints = REF_WHEEL_TORQUE.filter(([rpm]) => rpm > 0).map(([rpm, nm]) => [
  rpm,
  ((nm * (1 + refBoost(rpm))) / F12026_DRIVELINE_EFFICIENCY) * rpm * (Math.PI / 30) / 1000,
]);

/** ICE: 1.6 L V6 turbo, no MGU-H [ref_engine.ini] */
const F12026_ENGINE: EngineData = {
  powerCurve: ICE_POWER_CURVE,
  // COAST_REF 120 Nm at 11 000 rpm, linear [ref_engine.ini]
  coastCurve: [
    [0, 0],
    [11000, 120],
    [13050, 142.4],
  ],
  // Linear pedal [ref_throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ],
  // MINIMUM / INERTIA [ref_engine.ini]
  idleRpm: 3700,
  inertia: 0.0729,
  // LIMITER_HZ 25: half a 40 ms cycle cut [derived]
  limiterCutS: 0.02,
};

/** MGU-K harvest torque at the crank: up to `maxCrankNm`, then the `maxW` hyperbola */
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

/** 2026 MGU-K: 350 kW [spec]; the mod's torque curve gives ≈346.5 kW above 7000 rpm */
const ERS_MAX_DEPLOY_W = 350_000;

const F12026_ERS: ERSData = {
  // 495 Nm at the crank to 6000 rpm, then ≈346.5 kW [ref_kers_torque.lut]
  torqueLut: [
    [0, 0],
    [1000, 495],
    [6000, 495],
    [7000, 472.68],
    [8000, 413.6],
    [9000, 367.64],
    [10000, 330.88],
    [11500, 287.72],
    [12500, 264.7],
    [13500, 245.1],
    [15000, 220.59],
  ],
  // Harvest as strong as the deploy: 350 kW on the same 495 Nm [spec]
  coastLut: mgukCrankTorqueLut(ERS_MAX_DEPLOY_W, 495),
  ERS_MAX_DEPLOY: ERS_MAX_DEPLOY_W,
  maxHarvestW: 350_000,
  ERS_MAX_CHARGE: 4_000_000,
  // MAX_KJ_PER_LAP 9000 [ref_ers.ini]; 8.5 MJ harvest a lap [spec]
  deployPerLapJ: 9_000_000,
  harvestPerLapJ: 8_500_000,
  deployEfficiency: 0.95,
  harvestEfficiency: 0.92,
  liftThrottle: 0.15,
  topGearLiftHarvestW: 90_000,
  // Every delivery map scales 1st–3rd down [ref_ers*_gear.lut]
  deployVsGear: [
    [0, 0],
    [1, 0.333],
    [2, 0.666],
    [3, 0.9],
    [4, 1],
    [8, 1],
  ],
};

/** The mod's delivery maps (deploy vs road speed, a share of the 350 kW) [ref_ctrl_ers_N.ini, ers N_speed.lut] */
const REF_DEPLOY_BALANCED: LutPoints = [
  [0, 0],
  [75, 0],
  [170, 0.285],
  [275, 0.25],
  [285, 0],
];
const REF_DEPLOY_LOW_SPEED: LutPoints = [
  [0, 0],
  [75, 0],
  [170, 0.285],
  [260, 0.25],
  [270, 0],
];
// The 2026 override: full power to 300 km/h, then tapering (≈250 kW at 320, 150 kW from 340)
const REF_DEPLOY_OVERRIDE: LutPoints = [
  [0, 0],
  [50, 1],
  [300, 1],
  [320, 0.7143],
  [340, 0.4286],
];

const F12026_PERFORMANCE_MODES: Record<PerformanceModeName, PerformanceModeData> = {
  // Override (the push button / boost) [ref_ctrl_ers_5.ini]
  PSH: {
    performance_mode_name: 'PSH',
    deployFraction: 1,
    deployVsSpeed: REF_DEPLOY_OVERRIDE,
    socFloor: 0,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1,
    ebbOffset: 0,
  },
  // Balanced, the mod's default delivery [ref_ctrl_ers_2.ini, ers.ini DEFAULT_CONTROLLER=2]
  RAC: {
    performance_mode_name: 'RAC',
    deployFraction: 1,
    deployVsSpeed: REF_DEPLOY_BALANCED,
    socFloor: 0.2,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1,
    ebbOffset: 1,
  },
  // Low speed [ref_ctrl_ers_1.ini]
  BAL: {
    performance_mode_name: 'BAL',
    deployFraction: 1,
    deployVsSpeed: REF_DEPLOY_LOW_SPEED,
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
    deployFraction: 1,
    deployVsSpeed: REF_DEPLOY_LOW_SPEED,
    socFloor: 0.2,
    brakeHarvestScale: 1,
    liftHarvestScale: 0.3,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 0.35,
    ebbOffset: 0,
  },
  // No deploy [ref_ctrl_ers_0.ini]
  CHR: {
    performance_mode_name: 'CHR',
    deployFraction: 0,
    deployVsSpeed: REF_DEPLOY_BALANCED,
    socFloor: 0,
    brakeHarvestScale: 1,
    liftHarvestScale: 1,
    topGearClipHarvestW: 120_000,
    partThrottleHarvestW: 80_000,
    coastTorqueScale: 1.15,
    ebbOffset: 0,
  },
};

/** 8-speed seamless, overall ratios (FINAL 1): ≈109 km/h in 1st to ≈375 km/h in 8th at 13 050 rpm [ref_drivetrain.ini] */
const F12026_GEARBOX: GearBoxData = {
  ratios: [16.4, 11.86, 10.15, 8.63, 7.26, 6.25, 5.46, 4.76],
  reverse: 16.4,
  finalDrive: 1,
  // CHANGE_UP_TIME 5 ms / CHANGE_DN_TIME 16 ms [ref_drivetrain.ini]: one torque dip in between [derived]
  shiftTimeS: 0.01,
  shiftTorqueFraction: 0.85,
  efficiency: F12026_DRIVELINE_EFFICIENCY,
  gears: {
    // LIMITER [ref_engine.ini], AUTO_SHIFTER UP / DOWN [ref_drivetrain.ini]
    redline_rpm: 13050,
    upshift_rpm: 11700,
    downshift_rpm: 9360,
  },
};

const F12026_CLUTCH: ClutchData = {
  // The mod's 631 Nm carries only the ICE; ours also carries the crank-mounted MGU-K (388 + 495 Nm) [est]
  maxTorqueNm: 900,
  // Auto-clutch MIN_RPM / MAX_RPM [ref_drivetrain.ini]
  biteRpm: 2800,
  lockRpm: 4000,
};

/**
 * Electronic diff as the mod's script runs it: locking = preload + setting × input torque, setting (n − 1) / 11 of
 * full lock. Defaults Entry 3/12 on the brakes, Mid 5/12 at the apex, Exit 5/12 on power / >250 km/h [ref_script.lua, setup.ini]
 */
const F12026_DIFFERENTIAL: DifferentialData = {
  type: 'LSD_Ramp',
  settings: {
    power: 4 / 11,
    coast: 4 / 11,
    preload: 15,
    friction_faces: 1,
    power_ramp_deg: 45,
    coast_ramp_deg: 45,
  },
  coastBraking: 2 / 11,
  threePhase: true,
  diffEntryLevel: 3,
  diffMidLevel: 5,
  diffExitLevel: 5,
  hiSpdSwitchKmh: 250,
};

/** MAX_TORQUE / FRONT_SHARE / ADJUST_STEP; migration +2 % from half pedal (BRAKE_MIGRATION, BMIG_RAMP) [ref_brakes.ini, setup.ini] */
const F12026_BRAKES: BrakesData = {
  maxTorqueNm: 5200,
  front_bias: 0.55,
  ebbStep: 0.005,
  migration: { amount: 0.02, rampStart: 0.5 },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});
const NO_DAMPER = damper(0, 0, 0, 0);

/**
 * Double wishbones with heave springs [spec]. Packers (free travel + rate + progression) are fits
 * to the progressive bump-rubber tables: 50 kN/m stiffening from 15 mm in on corners, ≈105 kN/m on heave
 * elements [derived].
 */
const F12026_SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'pull_rod',
    staticCamber: -3.6,
    camberGainKinematic: -18,
    springs: { wheel_rate: 160_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 250_000, gap: 0, packerGap: 0.005, packerRate: 150_000 },
    bumpStop: { range: 0.031, rate: 50_000, progression: 11_000_000 },
    droopTravel: 0.03,
    rollCentreHeight: 0.045,
    arb: 120_000,
    hardpoints: [
      [0.7198, 0.1858, 0.0],
      [0.7198, 0.1828, -0.375],
      [0.7500, -0.0273, 0.05],
      [0.7500, -0.0229, -0.40],
      [0.1749, 0.1925, -0.0356],
      [0.1350, -0.0225, -0.0083],
      [0.7198, 0.1883, 0.08],
      [0.1749, 0.1925, 0.06],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'pull_rod',
    staticCamber: -1.4,
    camberGainKinematic: -14,
    springs: { wheel_rate: 140_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 120_000, gap: 0, packerGap: 0.05, packerRate: 150_000 },
    bumpStop: { range: 0.053, rate: 50_000, progression: 11_000_000 },
    droopTravel: 0.04,
    rollCentreHeight: 0.08,
    arb: 45_000,
    hardpoints: [
      [0.6847, 0.1297, 0.42],
      [0.6847, 0.1418, -0.05],
      [0.6887, -0.0186, 0.45],
      [0.6887, -0.0127, -0.05],
      [0.2483, 0.1925, 0.0],
      [0.2299, 0.0175, 0.0],
      [0.6847, 0.1423, -0.125],
      [0.2483, 0.1925, -0.125],
    ],
  },
  // Corner and heave dampers, 0.05 m/s knees
  dampers_controller: {
    front: {
      base: damper(5000, 2500, 6000, 3000),
      heave: damper(2000, 1000, 2200, 1100),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
    },
    rear: {
      base: damper(7000, 4500, 9000, 6500),
      heave: damper(2500, 1500, 3500, 2500),
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.05,
    },
  },
};

/**
 * The mod's "Current Concept" aero map [ref_aero.ini MAP_1]: CL·A 5.185 m², CD·A 1.216 m² × the ride-height tables
 * (rows rear, columns front; the clearance of the ride pickups 0.243 / 0.219 m below the CG [ref_car.ini RIDE]),
 * balance ≈45 % front, plus the wing angle offsets and the 2026 straight-line mode (flaps on both wings).
 * With the CG ≈0.27 m up (GRAPHICS_OFFSET) the pickups sit ≈27 / 51 mm off the ground at rest [derived].
 */
const F12026_AERO: AeroData = {
  front_lift: 0,
  rear_lift: 0,
  drag: 0,
  wings: [
    {
      // Offset vs the 30° reference angle, set at 25° [ref_aero.ini WING_0, CL_FW_AOA.lut / CD_FW_AOA.lut]
      name: 'FRONT_WING',
      area: 1,
      positionZ: 2.543,
      angleDeg: 25,
      heightRef: 'front',
      lutAOA_CL: [
        [10, -0.354],
        [20, -0.177],
        [30, 0],
      ],
      lutAOA_CD: [
        [10, -0.078],
        [20, -0.039],
        [30, 0],
      ],
      lutGH_CL_mult: [[0, 1]],
      lutGH_CD_mult: [[0, 1]],
    },
    {
      // Offset vs the 20° reference angle, set at 15° [ref_aero.ini WING_1, CL_RW_AOA.lut / CD_RW_AOA.lut]
      name: 'REAR_WING',
      area: 1,
      positionZ: -1.739,
      angleDeg: 15,
      heightRef: 'rear',
      lutAOA_CL: [
        [0, -0.456],
        [10, -0.228],
        [20, 0],
      ],
      lutAOA_CD: [
        [0, -0.21],
        [10, -0.105],
        [20, 0],
      ],
      lutGH_CL_mult: [[0, 1]],
      lutGH_CD_mult: [[0, 1]],
    },
  ],
  rhMap: {
    clA: 5.185,
    cdA: 1.216,
    frontPickupY: -0.243,
    rearPickupY: -0.219,
    rearRh: [-0.05, 0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07],
    frontRh: [-0.05, 0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03],
    // [ref_MAP_CL_RH.2Dlut]
    cl: [
      [0.923, 0.923, 0.894, 0.867, 0.84, 0.812, 0.784, 0.757],
      [0.923, 0.923, 0.894, 0.867, 0.84, 0.812, 0.784, 0.757],
      [0.963, 0.963, 0.935, 0.908, 0.88, 0.853, 0.825, 0.797],
      [0.989, 0.989, 0.961, 0.934, 0.906, 0.878, 0.851, 0.823],
      [1, 1, 0.971, 0.945, 0.917, 0.889, 0.862, 0.834],
      [0.996, 0.996, 0.967, 0.941, 0.913, 0.885, 0.858, 0.83],
      [0.977, 0.977, 0.948, 0.922, 0.894, 0.866, 0.839, 0.811],
      [0.943, 0.943, 0.915, 0.888, 0.86, 0.832, 0.805, 0.777],
      [0.894, 0.894, 0.866, 0.839, 0.811, 0.784, 0.756, 0.728],
    ],
    // [ref_MAP_CD_RH.2Dlut]
    cd: [
      [0.923, 0.923, 0.934, 0.945, 0.956, 0.967, 0.978, 0.989],
      [0.923, 0.923, 0.934, 0.945, 0.956, 0.967, 0.978, 0.989],
      [0.932, 0.932, 0.941, 0.951, 0.96, 0.97, 0.979, 0.989],
      [0.942, 0.942, 0.949, 0.957, 0.965, 0.973, 0.981, 0.989],
      [0.952, 0.952, 0.958, 0.965, 0.971, 0.977, 0.984, 0.99],
      [0.963, 0.963, 0.968, 0.973, 0.977, 0.982, 0.987, 0.992],
      [0.975, 0.975, 0.978, 0.981, 0.984, 0.987, 0.991, 0.994],
      [0.987, 0.987, 0.989, 0.99, 0.992, 0.993, 0.995, 0.997],
      [1, 1, 1, 1, 1, 1, 1, 1],
    ],
    // [ref_MAP_BALANCE_RH.2Dlut]
    balance: [
      [0.465, 0.465, 0.45, 0.435, 0.42, 0.405, 0.39, 0.375],
      [0.465, 0.465, 0.45, 0.435, 0.42, 0.405, 0.39, 0.375],
      [0.471, 0.471, 0.456, 0.441, 0.427, 0.412, 0.397, 0.382],
      [0.48, 0.48, 0.465, 0.451, 0.436, 0.421, 0.407, 0.392],
      [0.492, 0.492, 0.478, 0.463, 0.449, 0.434, 0.42, 0.405],
      [0.507, 0.507, 0.493, 0.478, 0.464, 0.45, 0.435, 0.421],
      [0.525, 0.525, 0.511, 0.497, 0.483, 0.468, 0.454, 0.44],
      [0.546, 0.546, 0.532, 0.518, 0.504, 0.49, 0.476, 0.462],
      [0.57, 0.57, 0.556, 0.542, 0.529, 0.515, 0.501, 0.487],
    ],
    // [ref_MAP_ROLL_* / MAP_YAW_*.lut]
    rollCl: [
      [-3, 0.94],
      [0, 1],
      [3, 0.94],
    ],
    rollCd: [
      [-3, 0.972],
      [0, 1],
      [3, 0.972],
    ],
    rollBalance: [
      [-3, 0.002],
      [0, 0],
      [3, 0.002],
    ],
    yawCl: [
      [-30, 0.69],
      [-25, 0.93],
      [-5, 0.996],
      [0, 1],
      [5, 0.996],
      [25, 0.93],
      [30, 0.69],
    ],
    yawCd: [
      [-30, 1.11],
      [-25, 1.08],
      [-5, 1.005],
      [0, 1],
      [5, 1.005],
      [25, 1.08],
      [30, 1.11],
    ],
    yawBalance: [
      [-30, 0.025],
      [-25, 0.02],
      [-5, 0.001],
      [0, 0],
      [5, 0.001],
      [25, 0.02],
      [30, 0.025],
    ],
    // FRONT_FORCE_DELAY / REAR_FORCE_DELAY / DRAG_FORCE_DELAY [ref_aero.ini MAP_1]
    frontDelayS: 0.045,
    rearDelayS: 0.03,
    dragDelayS: 0.03,
    // Straight-line mode: both wings' flaps fully open [ref_aero.ini WING_9 / WING_10, CL_DRS / CD_DRS / CL_DRS2 / CD_DRS2.lut]
    activeAero: { dClAFront: -0.25, dClARear: -0.35, dCdA: -0.28 },
  },
  front_target_height: 0.027,
  rear_target_height: 0.051,
  // The plank at the front pickup's level
  floorOffsetY: -0.243,
  // The skid collider: 0.21 m below the CG, 1.6 m ahead to 1.4 m behind it, 28 mm above the front pickup
  // [ref_colliders.ini COLLIDER_0]
  plank: { y: -0.215, frontZ: 1.6, rearZ: -1.4 },
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** 2026 Pirelli: front 280 / rear 375 mm on 0.3625 m [ref_tyres.ini] */
const F1_FRONT: TyreGeometry = { width: 0.28, radius: 0.3625, rimRadius: 0.2413, verticalRateScale: 1 };
const F1_REAR: TyreGeometry = { width: 0.375, radius: 0.3625, rimRadius: 0.2413, verticalRateScale: 1 };

/** Vertical rate vs pressure: RATE at PRESSURE_STATIC + PRESSURE_SPRING_GAIN per psi [ref_tyres.ini] */
const rateCurve = (rate: number, staticPsi: number, perPsi: number): LutPoints =>
  [staticPsi, 20, 25, 28, 32].map((p) => [p, rate + perPsi * (p - staticPsi)]);

interface RefAxleCurves {
  dy: LutPoints;
  dx: LutPoints;
  dyRef: number;
  dxRef: number;
}

/**
 * One reference compound: the front's values, the rear's own load sensitivity, peak slip angle, relaxation length, camber
 * and pressures in `rearOverride` [ref_tyres.ini FRONT_n / REAR_n]. Grip is the load curves DY_CURVE / DX_CURVE
 * (μ vs Fz per tyre); the temperature curve is the compound's PERFORMANCE_CURVE (peak 1)
 */
function f1Compound(
  tyre_compound: PhysicsTyreCompound,
  name: string,
  shortName: 'S' | 'M' | 'H',
  front: RefAxleCurves,
  rear: RefAxleCurves,
  thermalCurve: LutPoints,
  window: [number, number]
): TyresCompoundData {
  return {
    name,
    shortName,
    tyre_compound,
    front: F1_FRONT,
    rear: F1_REAR,
    modelData: {
      Dy0: front.dyRef,
      Dx0: front.dxRef,
      dyCurve: front.dy,
      dxCurve: front.dx,
      lsExpY: 0.72,
      lsExpX: 0.756,
      Fz0: 3460,
      friction_limit_angle: 6.137,
      // The source derives it at run time; its ABS / TC limits are 0.10 [ref_electronics.ini]
      slip_ratio_limit: 0.1,
      // The source's COMBINED_FACTOR 2.2 is not this model's cross-axis factor: the friction circle, as on the GT3 [est]
      combinedFactor: 1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // FALLOFF_LEVEL / FALLOFF_SPEED
      use_slip_falloff: true,
      falloff_level: 0.85,
      falloff_slope: 3,
      relaxationLengthX: 0.1025,
      relaxationLengthY: 0.1025,
      rollingResistance: 0.012,
      verticalDamping: 396,
      pneumaticTrail: 0.035,
      brakeDxMod: 0.05,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // The mod's thermal model is not this one: these are ours [est]
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
      pressureSpringCurve: rateCurve(213_175, 16, 11_550),
      pressureGripSensitivity: 1.6,
      // BLANKETS_TEMP 80 °C
      coldRefC: 80,
    },
    camberData: {
      camberGain: 0.136,
      contact_camber_c1: 1,
      contact_camber_c2: 45,
      dcamber0: 1.042,
      dcamber1: -6.861,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    rearOverride: {
      modelData: {
        Dy0: rear.dyRef,
        Dx0: rear.dxRef,
        dyCurve: rear.dy,
        dxCurve: rear.dx,
        lsExpY: 0.75,
        lsExpX: 0.7875,
        Fz0: 3460,
        friction_limit_angle: 5.411,
        relaxationLengthX: 0.1044,
        relaxationLengthY: 0.1044,
        verticalDamping: 481,
      },
      camberData: { camberGain: 0.159, dcamber0: 1.211, dcamber1: -11.584 },
      pressureData: { optimalPsi: 24, pressureSpringCurve: rateCurve(274_490, 15, 12_250) },
    },
  };
}

// C3 / C2 / C1 as soft / medium / hard (the mod's default is C3, INDEX 2) [ref_tyres.ini FRONT_2..4 / REAR_2..4]
const C3_FRONT: RefAxleCurves = {
  dyRef: 1.9012,
  dxRef: 1.8816,
  dy: [[0, 2.295], [1000, 2.18], [2000, 2.065], [3000, 1.949], [4000, 1.833], [5000, 1.721], [6000, 1.614], [7000, 1.512], [8000, 1.418], [9000, 1.333], [10000, 1.258], [11000, 1.194], [12000, 1.14], [13000, 1.092], [14000, 1.05], [150000, 1.009]],
  dx: [[0, 2.205], [1000, 2.109], [2000, 2.009], [3000, 1.903], [4000, 1.793], [5000, 1.686], [6000, 1.583], [7000, 1.487], [8000, 1.398], [9000, 1.32], [10000, 1.254], [11000, 1.202], [12000, 1.161], [13000, 1.129], [14000, 1.102], [150000, 1.078]],
};
const C3_REAR: RefAxleCurves = {
  dyRef: 1.9698,
  dxRef: 1.9502,
  dy: [[0, 2.352], [1000, 2.24], [2000, 2.127], [3000, 2.013], [4000, 1.901], [5000, 1.793], [6000, 1.689], [7000, 1.592], [8000, 1.503], [9000, 1.422], [10000, 1.352], [11000, 1.293], [12000, 1.244], [13000, 1.201], [14000, 1.163], [150000, 1.127]],
  dx: [[0, 2.254], [1000, 2.17], [2000, 2.078], [3000, 1.972], [4000, 1.862], [5000, 1.756], [6000, 1.657], [7000, 1.566], [8000, 1.484], [9000, 1.413], [10000, 1.352], [11000, 1.304], [12000, 1.266], [13000, 1.235], [14000, 1.209], [150000, 1.186]],
};
const C2_FRONT: RefAxleCurves = {
  dyRef: 1.8818,
  dxRef: 1.8624,
  dy: [[0, 2.271], [1000, 2.158], [2000, 2.044], [3000, 1.929], [4000, 1.815], [5000, 1.704], [6000, 1.597], [7000, 1.497], [8000, 1.404], [9000, 1.319], [10000, 1.245], [11000, 1.182], [12000, 1.128], [13000, 1.081], [14000, 1.039], [150000, 0.999]],
  dx: [[0, 2.183], [1000, 2.087], [2000, 1.988], [3000, 1.883], [4000, 1.775], [5000, 1.669], [6000, 1.567], [7000, 1.471], [8000, 1.384], [9000, 1.307], [10000, 1.242], [11000, 1.19], [12000, 1.149], [13000, 1.117], [14000, 1.091], [150000, 1.067]],
};
const C2_REAR: RefAxleCurves = {
  dyRef: 1.9497,
  dxRef: 1.9303,
  dy: [[0, 2.328], [1000, 2.217], [2000, 2.105], [3000, 1.993], [4000, 1.882], [5000, 1.774], [6000, 1.672], [7000, 1.576], [8000, 1.488], [9000, 1.408], [10000, 1.339], [11000, 1.28], [12000, 1.231], [13000, 1.189], [14000, 1.151], [150000, 1.115]],
  dx: [[0, 2.231], [1000, 2.148], [2000, 2.056], [3000, 1.952], [4000, 1.843], [5000, 1.738], [6000, 1.64], [7000, 1.55], [8000, 1.469], [9000, 1.398], [10000, 1.339], [11000, 1.291], [12000, 1.253], [13000, 1.222], [14000, 1.197], [150000, 1.174]],
};
const C1_FRONT: RefAxleCurves = {
  dyRef: 1.8624,
  dxRef: 1.8432,
  dy: [[0, 2.248], [1000, 2.135], [2000, 2.023], [3000, 1.909], [4000, 1.796], [5000, 1.686], [6000, 1.581], [7000, 1.481], [8000, 1.389], [9000, 1.306], [10000, 1.232], [11000, 1.17], [12000, 1.117], [13000, 1.07], [14000, 1.028], [150000, 0.989]],
  dx: [[0, 2.16], [1000, 2.066], [2000, 1.968], [3000, 1.864], [4000, 1.757], [5000, 1.652], [6000, 1.551], [7000, 1.456], [8000, 1.37], [9000, 1.293], [10000, 1.229], [11000, 1.178], [12000, 1.137], [13000, 1.106], [14000, 1.079], [150000, 1.056]],
};
const C1_REAR: RefAxleCurves = {
  dyRef: 1.9296,
  dxRef: 1.9104,
  dy: [[0, 2.304], [1000, 2.194], [2000, 2.083], [3000, 1.972], [4000, 1.862], [5000, 1.756], [6000, 1.655], [7000, 1.56], [8000, 1.472], [9000, 1.393], [10000, 1.325], [11000, 1.267], [12000, 1.218], [13000, 1.176], [14000, 1.139], [150000, 1.104]],
  dx: [[0, 2.208], [1000, 2.126], [2000, 2.035], [3000, 1.932], [4000, 1.824], [5000, 1.72], [6000, 1.623], [7000, 1.534], [8000, 1.454], [9000, 1.384], [10000, 1.325], [11000, 1.278], [12000, 1.24], [13000, 1.21], [14000, 1.184], [150000, 1.162]],
};

// PERFORMANCE_CURVE per compound (°C → grip), peaks 105 / 110 / 115 °C; windows within 0.3 % of the peak [ref_FR_Temp_Comp_3..5.lut]
const C3_TEMP: LutPoints = [[0, 0.905], [55, 0.9506], [75, 0.9783], [85, 0.9897], [95, 0.9973], [100, 0.9993], [105, 1], [110, 0.9993], [115, 0.9973], [125, 0.9897], [135, 0.9783], [155, 0.9506]];
const C2_TEMP: LutPoints = [[0, 0.9067], [60, 0.9571], [80, 0.9817], [90, 0.9914], [100, 0.9978], [105, 0.9994], [110, 1], [115, 0.9994], [120, 0.9978], [130, 0.9914], [140, 0.9817], [160, 0.9571]];
const C1_TEMP: LutPoints = [[0, 0.9098], [65, 0.9645], [85, 0.9854], [95, 0.9932], [105, 0.9983], [110, 0.9996], [115, 1], [120, 0.9996], [125, 0.9983], [135, 0.9932], [145, 0.9854], [165, 0.9645]];

const F12026_TYRES = {
  PhysicsTyreCompound_F1_Soft: f1Compound('PhysicsTyreCompound_F1_Soft', 'Soft', 'S', C3_FRONT, C3_REAR, C3_TEMP, [95, 115]),
  PhysicsTyreCompound_F1_Medium: f1Compound('PhysicsTyreCompound_F1_Medium', 'Medium', 'M', C2_FRONT, C2_REAR, C2_TEMP, [100, 120]),
  PhysicsTyreCompound_F1_Hard: f1Compound('PhysicsTyreCompound_F1_Hard', 'Hard', 'H', C1_FRONT, C1_REAR, C1_TEMP, [105, 125]),
} satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;

const F12026_MASS = 769;
/** Inertia of a box of the mod's INERTIA dimensions (width 1.19, height 0.523, length 4.005 m) [ref_car.ini] */
const f1Box = (a: number, b: number) => (F12026_MASS / 12) * (a * a + b * b);

export const F12026_CAR_CONFIG = {
  screenName: 'f12026-car',
  chassis: {
    // TOTALMASS (with driver, no fuel) [ref_car.ini], CG_LOCATION / WHEELBASE / TRACK [ref_suspensions.ini]
    totalMassKg: F12026_MASS,
    frontWeightFraction: 0.455,
    wheelbase: 3.382,
    trackWidthFront: 1.56,
    trackWidthRear: 1.461,
    // GRAPHICS_OFFSET puts the ground 0.27 m under the CG [ref_car.ini, derived]
    cgHeight: 0.27,
    inertia: { pitch: f1Box(0.523, 4.005), roll: f1Box(1.19, 0.523), yaw: f1Box(1.19, 4.005) },
    // HUB_MASS, ANGULAR_INERTIA [ref_suspensions.ini, tyres.ini]
    unsprungMassFront: 29,
    unsprungMassRear: 33,
    wheelInertiaFront: 1.802,
    wheelInertiaRear: 2.063,
    // STEER_LOCK 250° / STEER_RATIO 12.6 [ref_car.ini]
    maxRoadWheelDeg: 250 / 12.6,
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
