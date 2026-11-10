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
import { F1_RAIN_TYRE_PACK, f1RainTraits, WET_TYRE_TRAITS, type WetTyreTraits } from '../wet-tyres';

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

/** `PhysicsTyreCompound`: F1, GT3 and prototype slicks, their treaded rain tyres, and a road car's street tyre */
export type PhysicsTyreCompound =
  | 'PhysicsTyreCompound_F1_Soft'
  | 'PhysicsTyreCompound_F1_Medium'
  | 'PhysicsTyreCompound_F1_Hard'
  | 'PhysicsTyreCompound_F1_Intermediate'
  | 'PhysicsTyreCompound_F1_Wet'
  | 'PhysicsTyreCompound_GT3_Soft'
  | 'PhysicsTyreCompound_GT3_Medium'
  | 'PhysicsTyreCompound_GT3_Hard'
  | 'PhysicsTyreCompound_GT3_Intermediate'
  | 'PhysicsTyreCompound_GT3_Wet'
  | 'PhysicsTyreCompound_Proto_Soft'
  | 'PhysicsTyreCompound_Proto_Medium'
  | 'PhysicsTyreCompound_Proto_Hard'
  | 'PhysicsTyreCompound_Proto_Intermediate'
  | 'PhysicsTyreCompound_Proto_Wet'
  | 'PhysicsTyreCompound_Road_Street';

/** The simulator's compound choice: soft / medium / hard slicks, intermediate and full wet */
export type CompoundSlot = 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet';

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
  /**
   * Where the fuel sits, from the CG of the car without fuel (m: y up, z forward). Its weight acts there, so a tank
   * behind the CG moves the weight split rearward as it fills. Absent: at the CG
   */
  fuelTank?: { y: number; z: number };
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
  /** Hydraulic power steering; none = an unassisted rack */
  powerSteering?: PowerSteeringData;
}

/**
 * Hydraulic power steering: the boost valve shares the rack's torque between the driver and the assist piston by the
 * torque the driver puts through the column. Below `deadbandNm` the valve stays on its centre lap (no assist); over
 * the next `rampNm` its assist ratio (assist torque per Nm of the driver's) builds to `maxRatio` and holds there.
 * The rim feels the driver's share.
 */
export interface PowerSteeringData {
  /** Steering ratio between the column and the road wheels, through which the valve sees the rack */
  steeringRatio: number;
  /** Column torque the valve passes unassisted (Nm at the rim) */
  deadbandNm: number;
  /** Column torque past the deadband over which the assist ratio builds to its full value (Nm) */
  rampNm: number;
  /** Full assist ratio: assist torque per Nm of the driver's */
  maxRatio: number;
  /**
   * Road speed over which a speed-sensitive pump fades the assist out [from, gone by] (m/s). Omitted: an engine-driven
   * pump, the same assist at any speed
   */
  speedFadeMs?: readonly [number, number];
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
  /**
   * First-order lag of the ICE's air path behind the throttle (s), opening and closing: drive-by-wire actuator, manifold
   * filling and the ECU's torque ramp. One crank revolution, the intake-to-power-stroke delay of a four-stroke, is added
   * at run time. Absent: the torque follows the pedal at once
   */
  torqueResponseS?: { rise: number; fall: number };
  /**
   * The ECU softens the pedal in the low gears by itself on a wet road (an F1 power unit's wet pedal map). Absent: the
   * pedal map changes only when the driver picks engine map 4 or 5
   */
  wetPedalMap?: boolean;
  /** Turbocharger; absent: naturally aspirated */
  turbo?: TurboData;
  idleRpm: number;
  /** Crank + flywheel + MGU-K/H rotor inertia reflected to the crank (kg·m²) */
  inertia: number;
  /** Ignition cut held after the limiter trips (s) */
  limiterCutS: number;
  /**
   * Share of a change in air density that reaches the engine's torque (0.1: a tenth less air costs 1 %), against the
   * density the car's data is given at (`aero.airDensity`). Unset: the engine makes its curve in any air
   */
  airDensitySensitivity?: number;
}

/**
 * Exhaust-driven turbocharger. The power curve is the steady state with the boost made; this is the boost the torque waits
 * for. Torque ∝ 1 + boost (an AC-style turbo), and the full-load boost at `rpm` is maxBoost·(rpm / referenceRpm)^gamma,
 * capped at maxBoost (`turboSteadyBoost`). The rotor spools toward the boost the throttle asks for with a time constant
 * spoolUpS·spoolRefRpm / rpm (the turbine's surplus power grows with the exhaust flow, ∝ rpm), and runs down with
 * spoolDownS once the exhaust stops pushing (rotor inertia against the compressor's work)
 */
export interface TurboData {
  maxBoost: number;
  referenceRpm: number;
  gamma: number;
  spoolUpS: number;
  spoolRefRpm: number;
  spoolDownS: number;
  /** Gauge pressure shown at full boost (bar), for the HUD and the sound */
  displayMaxBoostBar: number;
}

/** Full-load steady-state boost of `turbo` at `rpm` */
export function turboSteadyBoost(turbo: TurboData, rpm: number): number {
  return Math.min(turbo.maxBoost, turbo.maxBoost * Math.max(0, rpm / turbo.referenceRpm) ** turbo.gamma);
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
  /** The same for a down-shift, where it differs (s) */
  downshiftTimeS?: number;
  shiftTorqueFraction: number;
  /**
   * An up-shift managed by the control unit: for this long (s) it takes the drive away (spark and MGU-K), and the engine
   * meets the new gear at the wheels' speed, its excess taken up in the shift. Without it the closed clutch hands the
   * engine's excess to the driven wheels, which spins them up by the ratio step
   */
  upshiftCutS?: number;
  /**
   * A dog box: for this long (s) after an up-shift the dogs are out and the engine turns free of the wheels, slowing on
   * its own friction under the cut (`upshiftCutS`); then the dogs take the rest of its excess into the driveline, the
   * shove of a flat shift. With it the engine is not re-aligned
   */
  upshiftNeutralS?: number;
  /**
   * A down-shift as the car's own gearbox and control unit make it, in place of an engine that is at the lower gear's
   * speed the moment the paddle is pulled. Times in s from the paddle
   */
  downshift?: {
    /** The box is between gears until here: the engine turns free of the wheels */
    neutralS: number;
    /** The clutch starts home here (the later of this and `neutralS`) and is fully home at `clutchHomeS` */
    clutchReleaseS: number;
    clutchHomeS: number;
    /**
     * The throttle blip that lifts the free engine to the lower gear's speed (the control unit's, or a driver's heel and
     * toe): this much throttle, risen over `riseS`, held until the engine is there or the box is in gear. What it leaves,
     * the clutch takes up. Absent: the clutch takes it all
     */
    blip?: { level: number; riseS: number };
    /** A down-shift may land this far above the limiter (rpm); unset, it is refused from 200 rpm under it */
    overRevRpm?: number;
  };
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
  /**
   * Torsional compliance of each rear halfshaft, diff side gear to hub with its CV joints: stiffness (Nm/rad) and damping
   * (Nm·s/rad). The driveline winds up against the tyres, and a throttle step rings at its shuffle frequency (the engine
   * on the shafts, √(2k / (r²·I_engine)) at overall ratio r). Absent: rigid shafts
   */
  halfshaft?: { stiffnessNmPerRad: number; dampingNmsPerRad: number };
  /**
   * Brake-operated diff lock of a road car's stability system: a brake torque (Nm) on the driven wheel that turns the
   * faster, growing from nothing at `deadZone` to all of it at `fullSpin` (how much faster than the other wheel it
   * turns: 1 = twice as fast), with its own numbers on the power and off it
   */
  brakeLock?: {
    power: { torqueNm: number; deadZone: number; fullSpin: number };
    coast: { torqueNm: number; deadZone: number; fullSpin: number };
  };
  /** Electronic diff: the coast locking (same units as `coast`) while braking, i.e. on corner entry; default `coast` */
  coastBraking?: number;
  /**
   * 2026 3-Phase Active Electronic Differential: Entry map on the brake, Exit / HiSpd map on the power or past
   * `hiSpdSwitchKmh`, Mid map between and at the apex; blended by the pedals and the steering, not switched
   */
  threePhase?: boolean;
  /** Default Entry coast locking dial (1..12, where locking = (level - 1) / 11; default 3 -> 18.2%) */
  diffEntryLevel?: number;
  /** Default Mid-corner apex locking dial (1..12; default 5 -> 36.4%) */
  diffMidLevel?: number;
  /** Default Exit / High-Speed power locking dial (1..12; default 5 -> 36.4%) */
  diffExitLevel?: number;
  /** High-speed stability threshold where the Exit/HiSpd lock engages whatever the pedals (km/h; default 250) */
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
  /** Handbrake: brake torque on each rear wheel at full pull (Nm), outside the pedal's bias and ABS. Absent: none */
  handbrakeTorqueNm?: number;
  /** One EBB step moves the bias this much (0..1) */
  ebbStep: number;
  /** Disc / pad material for the brake thermal model and pad μ(T) (default carbon-carbon, F1) */
  discMaterial?: 'carbon-ceramic' | 'endurance-steel';
  /**
   * The pads' friction against disc temperature (°C → share of `maxTorqueNm`, linear between points, held past the
   * ends), in place of the material's built-in curve. Pad glazing still acts on top. Absent: the material's curve
   */
  padMuCurve?: LutPoints;
  /** Disc temperature the car starts and restarts with (°C); default 380 */
  discStartTempC?: number;
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
  /** The heave damper's own bump and rebound knees (m/s); default the base damper's */
  heaveFastThresholdMs?: number;
  heaveFastReboundThresholdMs?: number;
}

/** `BumpStopSettingsUnits` */
export interface BumpStopSettingsUnits {
  /** Free travel from static ride height to bump-rubber contact (m) */
  range: number;
  /** Bump-rubber rate at the wheel (N/m), progressive with `progression` */
  rate: number;
  /** Extra rate per metre of rubber compression (N/m²) */
  progression: number;
  /** A second stop further up the travel (m from static ride) adding its own rate (N/m at the wheel) */
  hardStop?: { range: number; rate: number };
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
  /**
   * Heave travel before the element engages (m). 0: in contact at static ride height, where it carries its rate's share
   * of the weight (a preloaded coilover), so its rate runs on into droop
   */
  gap: number;
  /** Packer: rate added once heave exceeds `packerGap` (N/m) */
  packerGap: number;
  packerRate: number;
  /** Extra rate per metre of the element's own compression (N/m²): force = (rate + this · x) · x. Absent: linear */
  progressiveRate?: number;
}

/** `SuspensionGeometryData` + the axle's setup values */
export interface AxleSuspensionData {
  type: SuspensionTypeEnum;
  actuation: 'pull_rod' | 'push_rod';
  /** `BasicSuspensionData.staticCamber` (deg, negative = top inward) */
  staticCamber: number;
  /**
   * Kinematic camber change with bump at static (deg per m of compression): what `hardpoints` give, for reference (the
   * physics solves the camber from the hardpoints; the verify suites check the two agree)
   */
  camberGainKinematic: number;
  springs: SuspensionSettingUnits;
  heave: HeaveSpringData;
  bumpStop: BumpStopSettingsUnits;
  /** Rebound travel from static to the droop limiter (m) */
  droopTravel: number;
  /**
   * Kinematic roll-centre height above the ground at static (m): what `hardpoints` give, for reference (the tyre forces
   * reach the body through the solved link geometry; the verify suites check the two agree)
   */
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
  /**
   * Body yaw (air slip angle, |deg|) → CL / CD multipliers on this element: a wing working in the body's wake loses
   * load when the car slides. Absent = no yaw sensitivity (the map-aero cars carry theirs in `rhMap.yawCl`).
   */
  lutYaw_CL_mult?: LutPoints;
  lutYaw_CD_mult?: LutPoints;
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
  /**
   * Height of the total drag's line of action above the CG, body frame (m). Wings, wheels and body each drag at their
   * own height, so the sum pitches the car (nose up when it acts above the CG). Absent: through the CG, no pitch moment.
   * Set it for wing-element aero; a ride-height map whose balance is an axle split already carries the drag's moment
   */
  dragCentreY?: number;
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
  /**
   * Growth of the free radius with spin (m per rad/s): the belt stretches as the wheel turns faster, which lifts the car
   * and lengthens its gearing at speed. Absent: the model's own small growth, on the steering arms only
   */
  radiusGrowthPerRadS?: number;
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
  /**
   * Slip angle at peak lateral force at `Fz0` (deg); `DEFAULT_FRICTION_LIMIT_ANGLE_DEG` when unset or 0. With the peak
   * μ at Fz0 it fixes the cornering stiffness there; away from Fz0 the stiffness follows `pKy2` and the peak slip
   * angle follows from the two
   */
  friction_limit_angle?: number;
  /**
   * Pacejka MF pKy2: cornering stiffness saturates with load as Kyα ∝ sin(2·atan(Fz / (pKy2·Fz0))), peaking at
   * Fz = pKy2·Fz0. The lateral relaxation length follows the stiffness (σ = Kyα / lateral carcass stiffness)
   */
  pKy2: number;
  /** Slip ratio at peak longitudinal force */
  slip_ratio_limit: number;
  /**
   * Enables the asymmetric cross-axis shift / scale terms below. Either way the combined force is the pure-slip curve
   * at the normalised slip vector's length, split along it, so it stays inside the μx / μy friction ellipse
   */
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
  /** Carcass relaxation lengths (m); the lateral one at `Fz0` (it scales with the cornering stiffness, see `pKy2`) */
  relaxationLengthX: number;
  relaxationLengthY: number;
  /** Rolling-resistance coefficient at walking speed */
  rollingResistance: number;
  /**
   * Its growth with speed, per (m/s)²: f = rollingResistance + rollingResistanceSpeedSq·v², the standard tyre form (the
   * carcass's hysteresis work per second rises with the deflection rate). Absent: 0, no speed term
   */
  rollingResistanceSpeedSq?: number;
  /**
   * Its growth with slip: × (1 + this × the combined slip over the peak slip), on a rolling wheel. A tyre working at
   * its limit scrubs: a street tyre several times its free-rolling drag, a racing slick a few per cent. Absent: 0
   */
  rollingResistanceSlipGain?: number;
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
  /**
   * Force curve family (see `brush-tyre.ts`). 'magic' (default): sin(C·atan(B·s)) to the peak and the falloff above.
   * 'brush': the brush model's cubic to the peak, so the cornering stiffness is 3 × the peak force over the peak slip,
   * then a gentle decay toward `falloff_level` (`falloff_slope` per unit of slip past the peak; none without
   * `use_slip_falloff`). A brush tyre also works on the theoretical slips (κ / (1 + κ), tan α / (1 + κ)), takes camber
   * as a slip-angle shift of sin γ × `camberGain`, moves its peak slip with load, grip and pressure by the fields
   * below, and lags by twice its relaxation length at small slip. `pKy2` and `slip_ratio_limit` are then unused
   * (the limit only when `longStiffnessMult` is given)
   */
  curve?: 'magic' | 'brush';
  /** 'brush': a fuller rising branch, the cubic plus this × 3s(1 − s)² (0: the plain cubic) */
  curveFullness?: number;
  /**
   * 'brush': growth of the peak slip angle with load. The angle at twice the reference load is (1 + this) × the angle
   * at the reference load, and the peak slip is linear in load between and beyond. May be negative
   */
  peakSlipLoadGain?: number;
  /** 'brush': the reference load of `peakSlipLoadGain` (N); default the tyre's Fz0 */
  peakSlipLoadRefN?: number;
  /** 'brush': the peak slip divides by 1 + this × (pressure / optimal pressure − 1): a softer tyre peaks later */
  peakSlipPressureGain?: number;
  /** 'brush': exponent of the combined slip, (|s_x|^p + |s_y|^p)^(1/p); 2 (default) is the friction circle */
  combinedExponent?: number;
  /**
   * 'brush': longitudinal over lateral slip stiffness, so the longitudinal force peaks at the peak slip over this.
   * Absent: taken from `slip_ratio_limit` at Fz0
   */
  longStiffnessMult?: number;
  /** 'brush': grip lost to sliding speed, μ ÷ (1 + this × sliding speed in m/s) */
  speedSensitivity?: number;
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
  /**
   * Rolling hysteresis power coefficient (W per N per m/s): the share of the load that the rolling tyre turns into
   * heat in its carcass. A tyre's rolling resistance is that loss, so it sits near the rolling-resistance coefficient
   */
  hysteresis: number;
  /** Surface → core conductance (W/K) */
  surfaceToCore: number;
  /** Convective cooling: G = g0 + g1·v (W/K) for surface and core */
  surfaceCooling: [number, number];
  coreCooling: [number, number];
  /** Vertical-rate change per °C of core temperature away from the reference */
  thermalVerticalK: number;
  thermalVerticalRefC: number;
  /**
   * A brush tyre's slow tread condition (GRAIN_* / BLISTER_* of its data): worked below the temperature where its grip
   * curve first reaches its peak the tread grains, above the last it blisters, each at `gain` × slip^`gamma` × rolling
   * speed × the degrees past the threshold. Graining softens the tyre (it peaks later) and wears off with rolling;
   * blisters cost grip and stay. Both take many laps. Absent: a brush tyre neither grains nor blisters
   */
  tread?: { grainGain: number; grainGamma: number; blisterGain: number; blisterGamma: number };
}

/** `TyresPressureData` */
export interface TyresPressureData {
  /** Hot inflation pressure for peak grip (psi gauge) */
  optimalPsi: number;
  /**
   * The pressure the tyre is set to in the garage, at `coldRefC`, where the car's data states one (psi gauge). Absent:
   * the pressure that reaches `optimalPsi` with the carcass at the centre of the working window
   */
  setPsi?: number;
  /** Inflation pressure (psi gauge) → radial stiffness (N/m) */
  pressureSpringCurve: LutPoints;
  /**
   * Rolling resistance against pressure: × (1 + this × (optimalPsi / pressure − 1)), so a soft tyre drags more.
   * Absent: 0, no change with pressure
   */
  pressureRollingGain?: number;
  /** Grip loss per (ΔP / P_opt)² */
  pressureGripSensitivity: number;
  /** Grip loss per psi away from the optimum, μ ÷ (1 + this × |ΔP|); when set it replaces the parabola above */
  pressureGripLossPerPsi?: number;
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
  shortName: 'S' | 'M' | 'H' | 'I' | 'W';
  tyre_compound: PhysicsTyreCompound;
  /** Behaviour on a wet road (`wet-tyres.ts`); absent = a slick */
  wetTraits?: WetTyreTraits;
  /**
   * The compound's own wear (WEAR_CURVE of its data): grip (% of new) against the distance the tread has slid over
   * the road (km). The tyre is worn out at the curve's last point. `loadScaled`: sliding under more than Fz0 of load
   * counts for more, in proportion (`loadRefN`: the load it counts once at, where that is not the model's Fz0).
   * Absent: the model's generic wear
   */
  wear?: { curve: LutPoints; loadScaled?: boolean; loadRefN?: number };
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
  /** The axle the engine drives through the clutch and differential; absent: the rear */
  drivenAxle?: 'front' | 'rear';
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

/**
 * A treaded rain tyre on a slick's carcass [est]: the grip (D, the load tables) scaled by the compound's dry grip, the
 * temperature curve moved down to its cooler window and falling off twice as fast again above it (a rain tyre on a dry
 * track overheats), cooler blankets, and a longer, softer tread (relaxation length, peak slip angle). The water
 * response, and the extra heat and wear on a dry road, come from `wetTraits` at run time.
 * `f1Pack`: an F1 car's rain tyres take the 2026 Pirelli pack's temperature curve, window and wear ratio instead
 * (`F1_RAIN_TYRE_PACK`).
 */
export function deriveRainCompound(
  base: TyresCompoundData,
  kind: 'intermediate' | 'wet',
  tyre_compound: PhysicsTyreCompound,
  name: string,
  f1Pack = false
): TyresCompoundData {
  const th = base.thermalData;
  const peakC = 0.5 * (th.optimalTempC[0] + th.optimalTempC[1]);
  const traits = f1Pack ? f1RainTraits(kind, peakC) : WET_TYRE_TRAITS[kind];
  const k = traits.dryGrip;
  const tread = kind === 'wet' ? 1.10 : 1.05;
  const angle = kind === 'wet' ? 1.12 : 1.06;
  const slipRatioScale = kind === 'wet' ? 1.12 : 1.06;
  const scaleLut = (lut: LutPoints | undefined) => lut?.map(([fz, mu]) => [fz, Number((mu * k).toFixed(4))] as [number, number]);
  const scaleModel = (m: Partial<TyresModelData> | undefined): Partial<TyresModelData> => {
    if (!m) return {};
    const out: Partial<TyresModelData> = { ...m };
    if (m.Dy0 !== undefined) out.Dy0 = m.Dy0 * k;
    if (m.Dx0 !== undefined) out.Dx0 = m.Dx0 * k;
    if (m.dyCurve) out.dyCurve = scaleLut(m.dyCurve);
    if (m.dxCurve) out.dxCurve = scaleLut(m.dxCurve);
    if (m.relaxationLengthX !== undefined) out.relaxationLengthX = m.relaxationLengthX * tread;
    if (m.relaxationLengthY !== undefined) out.relaxationLengthY = m.relaxationLengthY * tread;
    if (m.friction_limit_angle) out.friction_limit_angle = m.friction_limit_angle * angle;
    if (m.slip_ratio_limit) out.slip_ratio_limit = m.slip_ratio_limit * slipRatioScale;
    return out;
  };
  const thermalPerformanceCurve: LutPoints = f1Pack
    ? F1_RAIN_TYRE_PACK[kind].thermalCurve
    : th.thermalPerformanceCurve.map(([t, g]) => {
        const over = Math.max(0, t - peakC);
        const loss = (1 - g) * (1 + 2 * Math.min(1, over / 40));
        return [t + traits.tempShiftC, Number(Math.max(0.5, 1 - loss).toFixed(4))] as [number, number];
      });
  const model = { ...base.modelData, ...scaleModel(base.modelData) } as TyresModelData;
  model.falloff_level = Math.min(0.95, base.modelData.falloff_level + (kind === 'wet' ? 0.06 : 0.04));
  model.falloff_slope = kind === 'wet' ? 1.5 : 1.8;
  return {
    ...base,
    name,
    shortName: kind === 'wet' ? 'W' : 'I',
    tyre_compound,
    wetTraits: traits,
    modelData: model,
    thermalData: {
      ...th,
      thermalPerformanceCurve,
      optimalTempC: [th.optimalTempC[0] + traits.tempShiftC, th.optimalTempC[1] + traits.tempShiftC],
    },
    pressureData: { ...base.pressureData, coldRefC: base.pressureData.coldRefC + 0.55 * traits.tempShiftC },
    rearOverride: base.rearOverride
      ? { ...base.rearOverride, modelData: scaleModel(base.rearOverride.modelData) }
      : undefined,
  };
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

/**
 * Turbo boost on the curve: MAX_BOOST 1.12 (torque × 2.12), reached at REFERENCE_RPM 3700 with GAMMA 1.5 [ref_engine.ini].
 * One large turbo and no MGU-H, so only the exhaust spins it: a race-size rotor (≈ 2e-4 kg·m² at ≈ 12 000 rad/s, ≈ 15 kJ)
 * on ≈ 50–70 kW of turbine surplus at 10 000 rpm full load spools in ≈ 0.25 s, slower as the exhaust thins with rpm;
 * with the throttle shut it runs down over ≈ 1.5 s against the compressor's recirculation work [est]. The MGU-K fills
 * the torque the lag costs (VehiclePhysics.solveDrivetrain). The gauge reads 2.5 bar at full boost, as before [display]
 */
const F12026_TURBO: TurboData = {
  maxBoost: 1.12,
  referenceRpm: 3700,
  gamma: 1.5,
  spoolUpS: 0.25,
  spoolRefRpm: 10_000,
  spoolDownS: 1.5,
  displayMaxBoostBar: 2.5,
};
const refBoost = (rpm: number) => turboSteadyBoost(F12026_TURBO, rpm);

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
  // Drive-by-wire barrels at the trumpets: actuator ≈ 20 ms and a small plenum, so ≈ 30 ms opening; with the crank
  // revolution that is 90 % of a torque step in ≈ 85 ms at 9000 rpm. Closing 20 ms: the overrun fuel cut takes the torque
  // off before the plenum empties [est]
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  wetPedalMap: true,
  turbo: F12026_TURBO,
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
  // The control unit manages the up-shift: the drive is away for 20 ms and the engine meets the new gear at the wheels'
  // speed [est]
  upshiftCutS: 0.02,
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
  // Titanium tube ≈ 40 / 30 mm × 0.45 m between the CV joints (G 44 GPa): GJ/L ≈ 17 kNm/rad, ≈ 13 kNm/rad with the two
  // joints in series, ≈ 11° of twist at the ≈ 2.5 kNm a rear tyre takes at low speed; shuffle 5.8 Hz in 1st, 20 Hz in 8th.
  // Damping: 10 % of critical for a wheel on its own shaft (√(k/I_w) ≈ 13 Hz; CV-joint and bearing friction) [est]
  halfshaft: { stiffnessNmPerRad: 13_000, dampingNmsPerRad: 33 },
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
    // Stiffer packer: the extra downforce held off the plank at 320 km/h [est]
    heave: { rate: 250_000, gap: 0, packerGap: 0.005, packerRate: 300_000 },
    bumpStop: { range: 0.031, rate: 50_000, progression: 11_000_000 },
    droopTravel: 0.03,
    rollCentreHeight: 0.045,
    arb: 120_000,
    // Inner pickup heights (each wishbone and the rack moved as a whole) set so the solved geometry gives the RC and
    // camber gain above; the side view (≈ 22 % anti-dive) and the uprights are as before [derived]
    hardpoints: [
      [0.7198, 0.1286, 0.0],
      [0.7198, 0.1256, -0.375],
      [0.7500, -0.0520, 0.05],
      [0.7500, -0.0476, -0.40],
      [0.1749, 0.1925, -0.0356],
      [0.1350, -0.0225, -0.0083],
      [0.7198, 0.1317, 0.08],
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
    // As the front: inner pickup heights for the RC and camber gain above, side view and uprights as before [derived]
    hardpoints: [
      [0.6847, 0.1729, 0.42],
      [0.6847, 0.1850, -0.05],
      [0.6887, 0.0227, 0.45],
      [0.6887, 0.0286, -0.05],
      [0.2483, 0.1925, 0.0],
      [0.2299, 0.0175, 0.0],
      [0.6847, 0.1851, -0.125],
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
  // No dragCentreY: the map's drag stays through the CG. Its balance table is a front/rear axle split, the way tunnel
  // and CFD balances are quoted, and an axle split already holds the drag's pitching moment (the drag acts ≈ 0.45 m up,
  // 0.18 m above the CG, which unloads the front by ≈ 1.1 points of the downforce at any speed); the source map applies
  // its drag at the reference point, and this table (with its −1.5 pt) is tuned that way. Raising the drag here would
  // count that moment twice
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
    // ×1.10 on the reference map: in-corner CL·A 4.5–5.05 m², a 2026 car's level [est]
    clA: 5.70,
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
    // [ref_MAP_BALANCE_RH.2Dlut] − 1.5 pt everywhere: ≈ 44.5 % front at 250 km/h, just behind the 45.5 % weight, so a
    // quick turn-in at the limit at speed no longer spins the car (step steer to 100 % of the limit at 250 km/h) [est]
    balance: [
      [0.45, 0.45, 0.435, 0.42, 0.405, 0.39, 0.375, 0.36],
      [0.45, 0.45, 0.435, 0.42, 0.405, 0.39, 0.375, 0.36],
      [0.456, 0.456, 0.441, 0.426, 0.412, 0.397, 0.382, 0.367],
      [0.465, 0.465, 0.45, 0.436, 0.421, 0.406, 0.392, 0.377],
      [0.477, 0.477, 0.463, 0.448, 0.434, 0.419, 0.405, 0.39],
      [0.492, 0.492, 0.478, 0.463, 0.449, 0.435, 0.42, 0.406],
      [0.51, 0.51, 0.496, 0.482, 0.468, 0.453, 0.439, 0.425],
      [0.531, 0.531, 0.517, 0.503, 0.489, 0.475, 0.461, 0.447],
      [0.555, 0.555, 0.541, 0.527, 0.514, 0.5, 0.486, 0.472],
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
      // A brush tyre on the tyre data's own shape: the peak slip angle (FRICTION_LIMIT_ANGLE), its growth with load,
      // 6.9 % per Fz0 (FLEX_GAIN), and with a softer tyre (PRESSURE_FLEX_GAIN), the combined-slip exponent
      // (COMBINED_FACTOR), the longitudinal stiffness (CX_MULT) and the grip lost to sliding speed (SPEED_SENSITIVITY)
      // [ref_tyres.ini]
      curve: 'brush',
      friction_limit_angle: 6.137,
      peakSlipLoadGain: 0.069,
      peakSlipPressureGain: 0.1,
      combinedExponent: 2.2,
      longStiffnessMult: 1.15,
      speedSensitivity: 0.001795,
      // Unused by a brush tyre (the magic-formula family's stiffness law)
      pKy2: 3.2,
      // The slip the driver aids are scaled to; the drive force peaks at tan(6.137°) / 1.15 of theoretical slip, 10.3 %
      // [derived]. The source's ABS / TC limits are 0.10 [ref_electronics.ini]
      slip_ratio_limit: 0.1,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      // FALLOFF_LEVEL / FALLOFF_SPEED [ref_tyres.ini]: 97.9 % of the grip at 1.5 × the peak slip angle, 96.3 % at 2 ×
      use_slip_falloff: true,
      falloff_level: 0.85,
      falloff_slope: 3,
      relaxationLengthX: 0.1025,
      relaxationLengthY: 0.1025,
      rollingResistance: 0.012,
      // Speed term in the proportion of a radial tyre's, f = 0.0136 + 0.40e-7·V² (V km/h; Wong, Theory of Ground
      // Vehicles): 3.8e-5 of the static value per (m/s)², so +26 % at 300 km/h [derived]
      rollingResistanceSpeedSq: 4.6e-7,
      verticalDamping: 396.40625,
      pneumaticTrail: 0.035,
      brakeDxMod: 0.05,
    },
    thermalData: {
      thermalPerformanceCurve: thermalCurve,
      optimalTempC: window,
      // The mod's thermal model is not this one: these are ours [est]. The carcass heats by most of the tyre's rolling
      // loss (0.012 of the load): on a race stint all four settle near 100 °C, in the compounds' windows, with the
      // pressures within a psi of their optimum (scripts/verify-tyre-thermal.ts)
      surfaceHeatCapacity: 1500,
      coreHeatCapacity: 9500,
      slipHeatShare: 0.35,
      hysteresis: 0.0107,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.0012,
      thermalVerticalRefC: 100,
      // GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA [ref_tyres.ini]
      tread: { grainGain: 0.125, grainGamma: 0.5, blisterGain: 0.125, blisterGamma: 0.5 },
    },
    pressureData: {
      optimalPsi: 25,
      pressureSpringCurve: rateCurve(213_175, 16, 11_550),
      pressureGripSensitivity: 1.6,
      // 0.25 % of grip per psi off the ideal (PRESSURE_D_GAIN) [ref_tyres.ini]
      pressureGripLossPerPsi: 0.0025,
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
        // The rear's own load gain and sliding-speed loss [ref_tyres.ini REAR]
        peakSlipLoadGain: 0.07,
        speedSensitivity: 0.001665,
        pKy2: 5.2,
        relaxationLengthX: 0.1044,
        relaxationLengthY: 0.1044,
        verticalDamping: 480.925,
      },
      camberData: { camberGain: 0.159, dcamber0: 1.211, dcamber1: -11.584 },
      pressureData: { optimalPsi: 24, pressureSpringCurve: rateCurve(274_490, 15, 12_250) },
    },
  };
}

// C3 / C2 / C1 as soft / medium / hard (the mod's default is C3, INDEX 2) [ref_tyres.ini FRONT_2..4 / REAR_2..4]. Above 4 kN
// the lateral μ falls 0.57× as steeply as the file's curve (a 2026 reference tyre's slope): at aero loads the grip held
// too little of the extra downforce [est]
const C3_FRONT: RefAxleCurves = {
  dyRef: 1.9012,
  dxRef: 1.8816,
  dy: [[0, 2.295], [1000, 2.18], [2000, 2.065], [3000, 1.949], [4000, 1.833], [5000, 1.7692], [6000, 1.7082], [7000, 1.65], [8000, 1.5964], [9000, 1.548], [10000, 1.5052], [11000, 1.4688], [12000, 1.438], [13000, 1.4106], [14000, 1.3867], [150000, 1.3633]],
  dx: [[0, 2.205], [1000, 2.109], [2000, 2.009], [3000, 1.903], [4000, 1.793], [5000, 1.686], [6000, 1.583], [7000, 1.487], [8000, 1.398], [9000, 1.32], [10000, 1.254], [11000, 1.202], [12000, 1.161], [13000, 1.129], [14000, 1.102], [150000, 1.078]],
};
const C3_REAR: RefAxleCurves = {
  dyRef: 1.9698,
  dxRef: 1.9502,
  dy: [[0, 2.352], [1000, 2.24], [2000, 2.127], [3000, 2.013], [4000, 1.901], [5000, 1.8394], [6000, 1.7802], [7000, 1.7249], [8000, 1.6741], [9000, 1.628], [10000, 1.5881], [11000, 1.5544], [12000, 1.5265], [13000, 1.502], [14000, 1.4803], [150000, 1.4598]],
  dx: [[0, 2.254], [1000, 2.17], [2000, 2.078], [3000, 1.972], [4000, 1.862], [5000, 1.756], [6000, 1.657], [7000, 1.566], [8000, 1.484], [9000, 1.413], [10000, 1.352], [11000, 1.304], [12000, 1.266], [13000, 1.235], [14000, 1.209], [150000, 1.186]],
};
const C2_FRONT: RefAxleCurves = {
  dyRef: 1.8818,
  dxRef: 1.8624,
  dy: [[0, 2.271], [1000, 2.158], [2000, 2.044], [3000, 1.929], [4000, 1.815], [5000, 1.7517], [6000, 1.6907], [7000, 1.6337], [8000, 1.5807], [9000, 1.5323], [10000, 1.4901], [11000, 1.4542], [12000, 1.4234], [13000, 1.3966], [14000, 1.3727], [150000, 1.3499]],
  dx: [[0, 2.183], [1000, 2.087], [2000, 1.988], [3000, 1.883], [4000, 1.775], [5000, 1.669], [6000, 1.567], [7000, 1.471], [8000, 1.384], [9000, 1.307], [10000, 1.242], [11000, 1.19], [12000, 1.149], [13000, 1.117], [14000, 1.091], [150000, 1.067]],
};
const C2_REAR: RefAxleCurves = {
  dyRef: 1.9497,
  dxRef: 1.9303,
  dy: [[0, 2.328], [1000, 2.217], [2000, 2.105], [3000, 1.993], [4000, 1.882], [5000, 1.8204], [6000, 1.7623], [7000, 1.7076], [8000, 1.6574], [9000, 1.6118], [10000, 1.5725], [11000, 1.5389], [12000, 1.5109], [13000, 1.487], [14000, 1.4653], [150000, 1.4448]],
  dx: [[0, 2.231], [1000, 2.148], [2000, 2.056], [3000, 1.952], [4000, 1.843], [5000, 1.738], [6000, 1.64], [7000, 1.55], [8000, 1.469], [9000, 1.398], [10000, 1.339], [11000, 1.291], [12000, 1.253], [13000, 1.222], [14000, 1.197], [150000, 1.174]],
};
const C1_FRONT: RefAxleCurves = {
  dyRef: 1.8624,
  dxRef: 1.8432,
  dy: [[0, 2.248], [1000, 2.135], [2000, 2.023], [3000, 1.909], [4000, 1.796], [5000, 1.7333], [6000, 1.6735], [7000, 1.6165], [8000, 1.564], [9000, 1.5167], [10000, 1.4745], [11000, 1.4392], [12000, 1.409], [13000, 1.3822], [14000, 1.3582], [150000, 1.336]],
  dx: [[0, 2.16], [1000, 2.066], [2000, 1.968], [3000, 1.864], [4000, 1.757], [5000, 1.652], [6000, 1.551], [7000, 1.456], [8000, 1.37], [9000, 1.293], [10000, 1.229], [11000, 1.178], [12000, 1.137], [13000, 1.106], [14000, 1.079], [150000, 1.056]],
};
const C1_REAR: RefAxleCurves = {
  dyRef: 1.9296,
  dxRef: 1.9104,
  dy: [[0, 2.304], [1000, 2.194], [2000, 2.083], [3000, 1.972], [4000, 1.862], [5000, 1.8016], [6000, 1.744], [7000, 1.6899], [8000, 1.6397], [9000, 1.5947], [10000, 1.5559], [11000, 1.5229], [12000, 1.4949], [13000, 1.471], [14000, 1.4499], [150000, 1.4299]],
  dx: [[0, 2.208], [1000, 2.126], [2000, 2.035], [3000, 1.932], [4000, 1.824], [5000, 1.72], [6000, 1.623], [7000, 1.534], [8000, 1.454], [9000, 1.384], [10000, 1.325], [11000, 1.278], [12000, 1.24], [13000, 1.21], [14000, 1.184], [150000, 1.162]],
};

// PERFORMANCE_CURVE per compound (°C → grip), peaks 105 / 110 / 115 °C; windows within 0.3 % of the peak [ref_FR_Temp_Comp_3..5.lut]
const C3_TEMP: LutPoints = [[0, 0.905], [55, 0.9506], [75, 0.9783], [85, 0.9897], [95, 0.9973], [100, 0.9993], [105, 1], [110, 0.9993], [115, 0.9973], [125, 0.9897], [135, 0.9783], [155, 0.9506]];
const C2_TEMP: LutPoints = [[0, 0.9067], [60, 0.9571], [80, 0.9817], [90, 0.9914], [100, 0.9978], [105, 0.9994], [110, 1], [115, 0.9994], [120, 0.9978], [130, 0.9914], [140, 0.9817], [160, 0.9571]];
const C1_TEMP: LutPoints = [[0, 0.9098], [65, 0.9645], [85, 0.9854], [95, 0.9932], [105, 0.9983], [110, 0.9996], [115, 1], [120, 0.9996], [125, 0.9983], [135, 0.9932], [145, 0.9854], [165, 0.9645]];

const F1_MEDIUM = f1Compound('PhysicsTyreCompound_F1_Medium', 'Medium', 'M', C2_FRONT, C2_REAR, C2_TEMP, [100, 120]);
const F12026_TYRES = {
  PhysicsTyreCompound_F1_Soft: f1Compound('PhysicsTyreCompound_F1_Soft', 'Soft', 'S', C3_FRONT, C3_REAR, C3_TEMP, [95, 115]),
  PhysicsTyreCompound_F1_Medium: F1_MEDIUM,
  PhysicsTyreCompound_F1_Hard: f1Compound('PhysicsTyreCompound_F1_Hard', 'Hard', 'H', C1_FRONT, C1_REAR, C1_TEMP, [105, 125]),
  // Rain tyres on the medium's carcass [est], with the 2026 Pirelli pack's temperature curves and wear ratio
  PhysicsTyreCompound_F1_Intermediate: deriveRainCompound(F1_MEDIUM, 'intermediate', 'PhysicsTyreCompound_F1_Intermediate', 'Intermediate', true),
  PhysicsTyreCompound_F1_Wet: deriveRainCompound(F1_MEDIUM, 'wet', 'PhysicsTyreCompound_F1_Wet', 'Full Wet', true),
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
    // Equivalent box for the mass as it sits (tub, power unit, wheels), not the outside size: yaw ≈ 884 kg·m² [ref_car.ini INERTIA]
    inertia: { pitch: f1Box(0.63, 3.608), roll: f1Box(0.88, 0.63), yaw: f1Box(0.88, 3.608) },
    // HUB_MASS, ANGULAR_INERTIA [ref_suspensions.ini, tyres.ini]
    unsprungMassFront: 29,
    unsprungMassRear: 33,
    wheelInertiaFront: 1.802,
    wheelInertiaRear: 2.063,
    // STEER_LOCK 250° / STEER_RATIO 12.6 [ref_car.ini]
    maxRoadWheelDeg: 250 / 12.6,
    // A kN of lateral force puts ≈ 45 Nm on the kingpin (12 mm caster + ≈ 33 mm pneumatic trail). The all-spherical-joint
    // chain gives way to it: the rack held by the power steering (≈ 1.3 kNm/deg at the kingpin: valve torsion bar
    // times the assist) in series with a carbon / titanium tie-rod (≈ 5 kNm/deg) is ≈ 0.04 °/kN, the upright and
    // wishbones ≈ 0.01 more: 0.05 °/kN, a fifth of the bushed GT3's [est]
    steerComplianceDegPerKN: 0.05,
    // The rules allow only hydraulic assist, neither electronically controlled nor electrically powered: an engine-driven
    // pump, the same boost at any speed. Teams size it to keep the fast corners' weight with the driver: the valve opens
    // at ≈ 26 Nm at the rim (above the ≈ 24 Nm of a 2.5 g corner at 200 km/h) and reaches a light 0.45 ratio 6 Nm
    // later, so the slow hairpins and parking get the help [est]
    powerSteering: { steeringRatio: 12.6, deadbandNm: 26, rampNm: 6, maxRatio: 0.45 },
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
    intermediate: 'PhysicsTyreCompound_F1_Intermediate',
    wet: 'PhysicsTyreCompound_F1_Wet',
  },
} satisfies CarPhysicsConfig;
