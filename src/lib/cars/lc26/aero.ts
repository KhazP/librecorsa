/**
 * 3D Ride-Height Active Aerodynamics, Ground-Effect Floor Stall & FIA Safety
 * Interlocks for "VeloSoft LC-26" (`lc26-f1`, "Canyon-Overcut + Twin-Keel Spoon").
 *
 * Clean-room first-principles mathematical aerodynamic model aligned with 2026
 * FIA Formula 1 Technical Regulations (Issue 21, Section C3 & C3.18) and Sporting
 * Regulations (Section B, Driver Adjustable Bodywork):
 * - Zero copied lookup tables, matrices, or curves from any existing car or mod.
 * - Continuous 3D attitude surface (`FRH × RRH × Yaw × Roll × Steer`) decomposed
 *   into physical subsystems:
 *     1. Twin-Keel Spoon 3-element slotted front wing (`fw_mainplane`, `fw_flap_2`, `fw_flap_3`),
 *     2. Venturi ground-effect underfloor + flatter 2026 diffuser (`Z_FIA <= 250 mm`)
 *        with throat boundary-layer choke / vortex burst below `FRH < 4 mm` (`0.004 m`)
 *        and high-rake adverse-pressure diffuser separation,
 *     3. Beam-wingless twin-pylon 3-element rear wing (`rw_mainplane`, `rw_flap_2`, `rw_flap_3`)
 *        fed by dorsal canyon-overcut mass flow,
 *     4. Parametric dorsal cooling gill levels (`1..5`) trading radiator heat
 *        rejection (`0.88..1.16`) against upper-body drag,
 *     5. High-dynamic-pressure (`q`) legal trailing-edge aero-elastic compliance
 *        above `280 km/h`, plus 2026 in-washing wake retention (`gapAheadSeconds`).
 * - Exact FIA Active Aero Safety Interlocks:
 *     - Synchronized Corner Mode (`0°`) <-> Straight Mode (`<= 400 ms`) keeping
 *       `|aeroBalanceFront01(SM) - aeroBalanceFront01(CM)| < 0.015` across `200–355 km/h`.
 *     - Wet Partial Mode (`partial-wet-fw-only`) when `!rearFlapAllowedInWet` or
 *       `trackWetness01 >= 0.25`.
 *     - Strictly gated on driver throttle pedal (`throttlePedal01 > 0.90`), NEVER
 *       on net wheel torque or positive MGU-K power: ECU Super Clipping at `100%`
 *       driver throttle (`-250..-350 kW` MGU-K harvest) keeps Straight Mode OPEN.
 */

import {
  LC26_ACTIVE_AERO_HINGES,
  LC26_FIA_DATUM_PLANES,
  type AeroData,
  type AeroRideHeightMap,
  type AeroSetupPreset,
  type Lc26AeroModule,
  type Lc26AeroOperatingMode,
  type Lc26AeroStepInput,
  type Lc26AeroStepOutput,
  type Lc26CoolingGillLevel,
  type Lc26FlapDeflectionState,
  type WingData,
} from './contract-types';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Regulatory & Physical Constants
// ---------------------------------------------------------------------------

/** Track wetness lockout threshold matching `REAR_FLAP_WET_THRESHOLD` in `wet-tyres.ts` */
export const LC26_WET_REAR_FLAP_LOCKOUT_01 = 0.25;

/** Driver throttle pedal position (`0..1`) strictly above which Straight Mode is permitted */
export const LC26_SM_THROTTLE_MIN_GATE_01 = 0.90;

/** Driver brake pedal threshold (`0..1`) above which Straight Mode snaps shut immediately */
export const LC26_SM_BRAKE_MAX_GATE_01 = 0.01;

/** Global minimum airspeed (km/h) below which Straight Mode remains closed */
export const LC26_SM_GLOBAL_MIN_SPEED_KMH = 150.0;

/** Global lateral acceleration ceiling (g) above which Straight Mode reverts to Corner Mode */
export const LC26_SM_GLOBAL_MAX_LATERAL_G = 1.50;

/** Full Corner -> Straight Mode hydraulic actuator travel time (s, FIA limit `<= 0.400 s`) */
export const LC26_SM_OPEN_TRANSITION_S = 0.32;

/** Fast Straight -> Corner Mode snap-shut travel time on brake/lift/zone-exit (s, `<= 0.400 s`) */
export const LC26_SM_CLOSE_TRANSITION_S = 0.22;

/** Failsafe spring-assisted aerodynamic return time under `actuatorFault` (s, `<= 0.400 s`) */
export const LC26_SM_FAILSAFE_TRANSITION_S = 0.18;

/** Reference sea-level ISA air density (kg/m³) */
export const LC26_REFERENCE_AIR_DENSITY_KG_M3 = 1.225;

/** Dynamic pressure onset (Pa) corresponding to `280 km/h` (`77.78 m/s`) at `1.225 kg/m³` */
const AERO_ELASTIC_Q_ONSET_PA = 0.5 * LC26_REFERENCE_AIR_DENSITY_KG_M3 * (280 / 3.6) * (280 / 3.6);

/** Dynamic pressure full-compliance reference (Pa) above `360 km/h` */
const AERO_ELASTIC_Q_FULL_PA = 6200.0;

/** Dorsal cooling gill louver lookup (`1` = Monza tightest, `5` = hot-weather maximum opening) */
export interface Lc26CoolingGillSpec {
  readonly level: Lc26CoolingGillLevel;
  readonly coolingRejectMultiplier: number;
  readonly dCdAM2: number;
  readonly dClARearM2: number;
}

export const LC26_COOLING_GILL_SPECS: Readonly<Record<Lc26CoolingGillLevel, Lc26CoolingGillSpec>> = {
  1: { level: 1, coolingRejectMultiplier: 0.88, dCdAM2: -0.018, dClARearM2: 0.010 },
  2: { level: 2, coolingRejectMultiplier: 0.95, dCdAM2: -0.009, dClARearM2: 0.005 },
  3: { level: 3, coolingRejectMultiplier: 1.02, dCdAM2: 0.000, dClARearM2: 0.000 },
  4: { level: 4, coolingRejectMultiplier: 1.09, dCdAM2: 0.013, dClARearM2: -0.009 },
  5: { level: 5, coolingRejectMultiplier: 1.16, dCdAM2: 0.028, dClARearM2: -0.020 },
};

/** Baseline setup preset offsets on mainplane incidence (balanced to preserve CoP) */
const PRESET_OFFSETS: Readonly<
  Record<AeroSetupPreset, { readonly dClAFrontM2: number; readonly dClARearM2: number; readonly dCdAM2: number }>
> = {
  low_downforce: { dClAFrontM2: -0.125, dClARearM2: -0.156, dCdAM2: -0.072 },
  balanced: { dClAFrontM2: 0.0, dClARearM2: 0.0, dCdAM2: 0.0 },
  high_downforce: { dClAFrontM2: 0.116, dClARearM2: 0.145, dCdAM2: 0.068 },
};

/**
 * Synchronized Active Aero full-deflection aerodynamic deltas (`smProgress01 = 1`):
 * - Front wing (`fw_flap_2: -9.5°`, `fw_flap_3: -16.5°`): sheds `0.608 m²` front `CL·A` and `0.158 m²` `CD·A`.
 * - Rear wing (`rw_flap_2: -12.0°`, `rw_flap_3: -19.0°`): sheds `0.752 m²` rear `CL·A` and `0.284 m²` `CD·A`.
 * Notice `0.608 / (0.608 + 0.752) = 0.4471 ≈ 0.445`, locking Straight Mode CoP within `< 0.3%`
 * (`<< 1.5%` FIA stability envelope) of Corner Mode across `200–355 km/h`!
 */
export const LC26_ACTIVE_AERO_DELTAS = {
  dClAFrontFullSmM2: -0.592,
  dClARearFullSmM2: -0.738,
  dCdAFrontFullSmM2: -0.156,
  dCdARearFullSmM2: -0.284,
} as const;

// ---------------------------------------------------------------------------
// Math Utilities
// ---------------------------------------------------------------------------

function clamp(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  return x < min ? min : x > max ? max : x;
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

/** Hermite smoothstep mapping `edge0 -> 0` and `edge1 -> 1` (supports `edge0 > edge1` inverted ramps) */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x >= edge1 ? 1 : 0;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function slewLinear(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

// ---------------------------------------------------------------------------
// Clean-Room 3D Aerodynamic Surface (`FRH × RRH × Yaw × Roll × Steer`)
// ---------------------------------------------------------------------------

export interface Lc26CleanRoomSurfacePoint {
  readonly clAFrontM2: number;
  readonly clARearM2: number;
  readonly clATotalM2: number;
  readonly cdABaseM2: number;
  readonly aeroBalanceFront01: number;
  readonly floorStallFactor01: number;
}

/**
 * Evaluate the clean-room 3D aerodynamic surface for VeloSoft LC-26 in Corner Mode
 * (`0°` active flap deflection, `balanced` preset, `0°` wing trim, level-3 cooling gills).
 */
export function evaluateLc26CleanRoomAeroSurface(
  frontRideHeightM: number,
  rearRideHeightM: number,
  yawSlipRad = 0,
  rollRad = 0,
  steerRad = 0,
): Lc26CleanRoomSurfacePoint {
  const wheelbaseM = LC26_FIA_DATUM_PLANES.wheelbaseM;
  const hF = clamp(frontRideHeightM, 0.0, 0.14);
  const hR = clamp(rearRideHeightM, 0.0, 0.16);
  const rakeDeg = Math.atan2(hR - hF, wheelbaseM) * RAD_TO_DEG;

  // 1. Floor / Diffuser Vortex Stall Model (`floorStallFactor01`)
  //    - Below FRH = 8.5 mm boundary layers thicken; below FRH = 4.0 mm (0.004 m)
  //      throat blockage bursts leading-edge floor strake vortices progressively.
  //    - Above ~0.95 deg dynamic rake or RRH > 72 mm, the flatter 2026 diffuser
  //      (`Z_FIA <= 250 mm`, no beam wing) separates progressively.
  const lowFrhStall = clamp01(
    0.19 * smoothstep(0.0085, 0.004, hF) + 0.81 * smoothstep(0.0041, 0.0004, hF),
  );
  const highRakeDiffuserStall = clamp01(
    0.78 * smoothstep(0.95, 2.15, rakeDeg) +
      0.44 * smoothstep(0.072, 0.118, hR) +
      0.34 * smoothstep(-0.22, -0.90, rakeDeg),
  );
  const floorStallFactor01 = clamp01(1 - (1 - lowFrhStall) * (1 - highRakeDiffuserStall));

  // 2. Twin-Keel Spoon 3-Element Slotted Front Wing (`fw`)
  //    Ground-proximity mirror circulation peaks around FRH = 15–20 mm and decays gently above 32 mm.
  const hFwEff = Math.max(hF, 0.009);
  const fwGroundGain =
    1 +
    0.092 * Math.exp(-((hFwEff - 0.017) * (hFwEff - 0.017)) / (2 * 0.019 * 0.019)) -
    0.115 * smoothstep(0.032, 0.09, hF);
  const clAFwM2 = 0.715 * fwGroundGain;

  // 3. Venturi Underfloor + Flatter 2026 Diffuser (`RV-FLOOR` + `RV-DIFFUSER`)
  //    Venturi throat suction peaks near FRH = 18 mm & rake = 0.46 deg, shedding up to
  //    56% of underfloor load when `floorStallFactor01 -> 1`.
  const floorSuctionGain =
    (1 +
      0.118 * Math.exp(-((hF - 0.018) * (hF - 0.018)) / (2 * 0.017 * 0.017)) -
      0.235 * smoothstep(0.034, 0.092, hF)) *
    (1 +
      0.042 * Math.exp(-((rakeDeg - 0.46) * (rakeDeg - 0.46)) / (2 * 0.48 * 0.48)) -
      0.165 * smoothstep(0.06, 0.11, hR));
  const clAFloorAttachedM2 = 1.545 * floorSuctionGain;
  const clAFloorM2 = clAFloorAttachedM2 * (1 - 0.56 * floorStallFactor01);

  //    Floor CoP share (`front` fraction): tightly balanced across nominal heave (`16..34 mm` FRH),
  //    moving rearward if low-FRH splitter chokes and forward if high-rake rear diffuser separates.
  const floorFrontShare = clamp(
    0.4207 +
      0.0065 * clamp(rakeDeg - 0.44, -0.8, 1.4) -
      0.036 * lowFrhStall +
      0.044 * highRakeDiffuserStall,
    0.32,
    0.53,
  );

  // 4. Beam-Wingless Twin-Pylon Rear Wing + Dorsal Canyon Overcut (`rw` + `canyon`)
  //    Rear wing sits behind rear axle (`z = -2.02 m` vs rear axle `-1.564 m` -> axle leverage `1.134` rear,
  //    `-0.134` front); front wing overhang sits ahead of front axle (`z = +2.48 m` -> `1.189` front, `-0.189` rear).
  //    Diffuser plume coupling slightly boosts upper-deck extraction when floor flow is attached.
  const canyonPlumeGain =
    (1 + 0.048 * Math.exp(-((hR - 0.042) * (hR - 0.042)) / (2 * 0.024 * 0.024)) - 0.055 * smoothstep(0.062, 0.11, hR)) *
    (1 - 0.08 * highRakeDiffuserStall);
  const clARwAndCanyonM2 = 0.792 * canyonPlumeGain;

  // Resolve axle downforce coefficients (`m²`) in straight/level attitude before 3D yaw/roll/steer:
  // Calibrated so at static datum `(0.032, 0.058)` AND compressed 240 km/h `(0.020, 0.042)`,
  // `aeroBalanceFront01 ≈ 0.4450` (~1.5% behind 0.460 static front weight) and `clATotal ≈ 3.30–3.42 m²`
  // (~30% less peak downforce than 2025 F1's ~4.8 m²).
  const fwFrontLev = 1.078;
  const rwRearLev = 1.096;

  let clAFront =
    clAFwM2 * fwFrontLev +
    clAFloorM2 * floorFrontShare +
    clARwAndCanyonM2 * (1 - rwRearLev);
  let clARear =
    clAFwM2 * (1 - fwFrontLev) +
    clAFloorM2 * (1 - floorFrontShare) +
    clARwAndCanyonM2 * rwRearLev;

  // Base Corner Mode drag (`CD·A`, m²): ~1.10 m² in Corner Mode (narrower 2026 18" tyres,
  // 1-element in-washing wheel wake board, no beam wing), dropping to ~0.66 m² in Straight Mode
  // (~51% lower drag than 2025 F1's ~1.36 m² so 400 kW ICE + tapering MGU-K hits ~335–346 km/h traps).
  let cdABase =
    0.785 +
    0.0285 * (clAFront + clARear) * (clAFront + clARear) +
    0.042 * floorStallFactor01 -
    0.016 * smoothstep(0.034, 0.016, hF);

  // 5. 3D Attitude Sensitivity (`Yaw × Roll × Steer`)
  const absYawDeg = clamp(Math.abs(yawSlipRad) * RAD_TO_DEG, 0, 25);
  const absRollDeg = clamp(Math.abs(rollRad) * RAD_TO_DEG, 0, 8);
  const absSteerDeg = clamp(Math.abs(steerRad) * RAD_TO_DEG, 0, 28);

  // Yaw: crosswind across twin-keel pylons & RV-FLOOR-BOARD weakens rear diffuser side vortex seal
  const yawNorm = absYawDeg / 12.0;
  const yawClMult = 1 / (1 + 0.135 * yawNorm * yawNorm);
  const yawCdMult = 1 + 0.088 * yawNorm * yawNorm;
  const yawBalShift = 0.0055 * smoothstep(1.5, 11.0, absYawDeg);

  // Roll: windward floor edge rises, leaking venturi suction symmetrically
  const rollNorm = absRollDeg / 2.5;
  const rollClMult = 1 - 0.042 * clamp01(rollNorm * rollNorm);
  const rollCdMult = 1 + 0.012 * clamp01(rollNorm * rollNorm);
  const rollBalShift = -0.0028 * clamp01(rollNorm * rollNorm);

  // Front road-wheel steer: deflected front tyre wake perturbs outboard footplate & floor-board in-wash
  const steerNorm = absSteerDeg / 14.0;
  const steerFrontClMult = 1 - 0.028 * clamp01(steerNorm * steerNorm * 0.7 + 0.3 * steerNorm);
  const steerRearClMult = 1 - 0.011 * clamp01(steerNorm * steerNorm);
  const steerExtraCdA = 0.021 * clamp01(steerNorm * steerNorm);

  const attitudeClTotal = (clAFront * steerFrontClMult + clARear * steerRearClMult) * yawClMult * rollClMult;
  const rawSteerBal =
    clAFront + clARear > 1e-6
      ? (clAFront * steerFrontClMult) / (clAFront * steerFrontClMult + clARear * steerRearClMult)
      : 0.445;
  const aeroBalanceFront01 = clamp(rawSteerBal + yawBalShift + rollBalShift, 0.15, 0.85);

  clAFront = attitudeClTotal * aeroBalanceFront01;
  clARear = attitudeClTotal * (1 - aeroBalanceFront01);
  cdABase = cdABase * yawCdMult * rollCdMult + steerExtraCdA;

  return {
    clAFrontM2: clAFront,
    clARearM2: clARear,
    clATotalM2: attitudeClTotal,
    cdABaseM2: cdABase,
    aeroBalanceFront01,
    floorStallFactor01,
  };
}

// ---------------------------------------------------------------------------
// Aero-Elastic Trailing-Edge Flex (`> 280 km/h`) & 2026 Dirty-Air Wake
// ---------------------------------------------------------------------------

export interface Lc26AeroElasticState {
  readonly compliance01: number;
  readonly dClAFrontM2: number;
  readonly dClARearM2: number;
  readonly dCdAM2: number;
}

/**
 * Legal high-dynamic-pressure trailing-edge compliance above `280 km/h` (`q >= 3705 Pa`),
 * bounded by FIA C3.18.3 static load deflection tests. Bleeds ~3–4% upper-element drag
 * with balanced front/rear unloading so CoP moves by `< 0.15%`.
 */
export function evaluateLc26AeroElasticCompliance(
  dynamicPressurePa: number,
  fwOpen01: number,
  rwOpen01: number,
): Lc26AeroElasticState {
  const compliance01 = smoothstep(AERO_ELASTIC_Q_ONSET_PA, AERO_ELASTIC_Q_FULL_PA, dynamicPressurePa);
  if (compliance01 <= 0) {
    return { compliance01: 0, dClAFrontM2: 0, dClARearM2: 0, dCdAM2: 0 };
  }
  // Closed Corner Mode flaps carry higher aerodynamic bending moment than flattened Straight Mode flaps
  const fwLoadFactor = 1 - 0.35 * clamp01(fwOpen01);
  const rwLoadFactor = 1 - 0.35 * clamp01(rwOpen01);
  const dClAFrontM2 = -0.039 * compliance01 * fwLoadFactor;
  const dClARearM2 = -0.048 * compliance01 * rwLoadFactor;
  const dCdAM2 = -0.034 * compliance01 * (0.45 * fwLoadFactor + 0.55 * rwLoadFactor);
  return { compliance01, dClAFrontM2, dClARearM2, dCdAM2 };
}

export interface Lc26WakeState {
  readonly wakeRetention01: number;
  readonly dragWakeMultiplier: number;
}

/**
 * 2026 FIA improved dirty-air wake model (`gapAheadSeconds`):
 * In-washing wheel wake boards + narrower bodywork retain ~86–88% downforce at
 * `0.4–0.5 s` behind a leading car (vs ~68% in pre-2022 cars) while providing
 * realistic slipstream drag reduction. `null` indicates clean air (`1.0`).
 */
export function evaluateLc26WakeEffect(gapAheadSeconds: number | null): Lc26WakeState {
  if (gapAheadSeconds === null || !Number.isFinite(gapAheadSeconds) || gapAheadSeconds < 0 || gapAheadSeconds >= 3.2) {
    return { wakeRetention01: 1.0, dragWakeMultiplier: 1.0 };
  }
  const envelope = smoothstep(3.2, 2.1, gapAheadSeconds);
  const loss01 = 0.205 * Math.exp(-gapAheadSeconds / 0.88) * envelope;
  const wakeRetention01 = clamp(1.0 - loss01, 0.78, 1.0);
  const dragWakeMultiplier = clamp(1.0 - 0.62 * loss01, 0.84, 1.0);
  return { wakeRetention01, dragWakeMultiplier };
}

// ---------------------------------------------------------------------------
// Exact FIA Active Aero Safety Interlocks (Super-Clipping Safe!)
// ---------------------------------------------------------------------------

export interface Lc26SmInterlockDecision {
  readonly targetMode: Lc26AeroOperatingMode;
  readonly targetFwOpen01: number;
  readonly targetRwOpen01: number;
  readonly transitionTimeS: number;
}

/**
 * Optional diagnostic powertrain telemetry accepted ONLY to prove/document the
 * non-negotiable FIA 2026 invariant: ECU Super Clipping (`mgukPowerKw < 0` at
 * `throttlePedal01 === 1.0`) NEVER gates or closes Straight Mode.
 */
export interface Lc26PowertrainClippingContext {
  readonly mgukPowerKw?: number;
  readonly netWheelTorqueNm?: number;
}

/**
 * Evaluate all FIA 2026 Straight Mode & Low-Grip Partial Mode safety interlocks.
 *
 * CRITICAL INVARIANT:
 * Straight Mode is gated strictly on **driver throttle pedal position**
 * (`input.throttlePedal01 > 0.90`), brake application (`input.brakePedal01 <= 0.01`),
 * authorized track zone (`input.inAuthorizedSmZone === true`), speed, lateral G,
 * and actuator health — **NEVER** on net wheel torque or MGU-K electrical power.
 * Consequently, end-of-straight ECU Super Clipping (`-250..-350 kW` MGU-K harvest
 * while the driver holds `100%` throttle) keeps Straight Mode `100%` OPEN.
 */
export function evaluateLc26SmInterlock(
  input: Pick<
    Lc26AeroStepInput,
    | 'speedMs'
    | 'driverRequestsStraightMode'
    | 'inAuthorizedSmZone'
    | 'brakePedal01'
    | 'throttlePedal01'
    | 'lateralG'
    | 'trackWetness01'
    | 'rearFlapAllowedInWet'
    | 'actuatorFault'
  >,
  _ignoredPowertrainClippingContext?: Lc26PowertrainClippingContext,
): Lc26SmInterlockDecision {
  if (input.actuatorFault) {
    return {
      targetMode: 'failsafe-corner',
      targetFwOpen01: 0,
      targetRwOpen01: 0,
      transitionTimeS: LC26_SM_FAILSAFE_TRANSITION_S,
    };
  }

  const speedKmh = Math.abs(input.speedMs) * 3.6;
  const brakeApplied = input.brakePedal01 > LC26_SM_BRAKE_MAX_GATE_01;
  const driverFullThrottle = input.throttlePedal01 > LC26_SM_THROTTLE_MIN_GATE_01;
  const withinDynamicEnvelope =
    speedKmh >= LC26_SM_GLOBAL_MIN_SPEED_KMH && Math.abs(input.lateralG) <= LC26_SM_GLOBAL_MAX_LATERAL_G;

  const smPermitted =
    input.inAuthorizedSmZone === true &&
    input.driverRequestsStraightMode === true &&
    driverFullThrottle &&
    !brakeApplied &&
    withinDynamicEnvelope;

  if (!smPermitted) {
    return {
      targetMode: 'corner-mode',
      targetFwOpen01: 0,
      targetRwOpen01: 0,
      transitionTimeS: LC26_SM_CLOSE_TRANSITION_S,
    };
  }

  // FIA Section B Low-Grip Conditions: lock out rear flap when wet/inter rules or standing water apply
  const wetRearFlapLocked =
    !input.rearFlapAllowedInWet || input.trackWetness01 >= LC26_WET_REAR_FLAP_LOCKOUT_01;

  if (wetRearFlapLocked) {
    return {
      targetMode: 'partial-wet-fw-only',
      targetFwOpen01: 1,
      targetRwOpen01: 0,
      transitionTimeS: LC26_SM_OPEN_TRANSITION_S,
    };
  }

  return {
    targetMode: 'straight-mode',
    targetFwOpen01: 1,
    targetRwOpen01: 1,
    transitionTimeS: LC26_SM_OPEN_TRANSITION_S,
  };
}

// ---------------------------------------------------------------------------
// `AeroData` & `AeroRideHeightMap` Builder for `VehiclePhysics` Integration
// ---------------------------------------------------------------------------

export interface Lc26AeroDataBuildOptions {
  readonly coolingGillLevel?: Lc26CoolingGillLevel;
  readonly preset?: AeroSetupPreset;
  readonly frontWingTrimDeg?: number;
  readonly rearWingTrimDeg?: number;
}

const RH_MAP_FRONT_AXES_M: readonly number[] = [
  0.000, 0.002, 0.003, 0.004, 0.006, 0.008, 0.012, 0.016, 0.020, 0.024,
  0.028, 0.032, 0.038, 0.045, 0.055, 0.068, 0.082, 0.100,
];

const RH_MAP_REAR_AXES_M: readonly number[] = [
  0.008, 0.016, 0.024, 0.032, 0.038, 0.044, 0.050, 0.058, 0.066, 0.074,
  0.082, 0.092, 0.105, 0.120,
];

/**
 * Construct a complete `AeroData` configuration for `VehiclePhysics` directly
 * from the clean-room mathematical 3D LC-26 aerodynamic surface.
 */
export function buildLc26AeroData(options: Lc26AeroDataBuildOptions = {}): AeroData {
  const gillLevel = options.coolingGillLevel ?? 3;
  const preset = options.preset ?? 'balanced';
  const fwTrimDeg = clamp(options.frontWingTrimDeg ?? 0, -6, 6);
  const rwTrimDeg = clamp(options.rearWingTrimDeg ?? 0, -6, 6);

  const gillSpec = LC26_COOLING_GILL_SPECS[gillLevel];
  const presetSpec = PRESET_OFFSETS[preset];

  const refDatum = evaluateLc26CleanRoomAeroSurface(
    LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
    LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
    0,
    0,
    0,
  );

  const refClA = refDatum.clATotalM2 + presetSpec.dClAFrontM2 + presetSpec.dClARearM2 + gillSpec.dClARearM2;
  const refCdA = refDatum.cdABaseM2 + presetSpec.dCdAM2 + gillSpec.dCdAM2;

  const clGrid: number[][] = [];
  const cdGrid: number[][] = [];
  const balanceGrid: number[][] = [];

  for (let r = 0; r < RH_MAP_REAR_AXES_M.length; r++) {
    const hR = RH_MAP_REAR_AXES_M[r];
    const clRow: number[] = [];
    const cdRow: number[] = [];
    const balRow: number[] = [];
    for (let c = 0; c < RH_MAP_FRONT_AXES_M.length; c++) {
      const hF = RH_MAP_FRONT_AXES_M[c];
      const pt = evaluateLc26CleanRoomAeroSurface(hF, hR, 0, 0, 0);
      const frontClA = Math.max(0.05, pt.clAFrontM2 + presetSpec.dClAFrontM2);
      const rearClA = Math.max(0.05, pt.clARearM2 + presetSpec.dClARearM2 + gillSpec.dClARearM2);
      const totClA = frontClA + rearClA;
      const totCdA = Math.max(0.25, pt.cdABaseM2 + presetSpec.dCdAM2 + gillSpec.dCdAM2);
      clRow.push(Number((totClA / refClA).toFixed(5)));
      cdRow.push(Number((totCdA / refCdA).toFixed(5)));
      balRow.push(Number((frontClA / totClA).toFixed(5)));
    }
    clGrid.push(clRow);
    cdGrid.push(cdRow);
    balanceGrid.push(balRow);
  }

  // Signed symmetric roll & yaw LUTs (VehiclePhysics passes signed rollDeg & yawDeg)
  const rollAnglesDeg = [-6, -4, -2.5, -1.5, -0.75, 0, 0.75, 1.5, 2.5, 4, 6];
  const rollCl: [number, number][] = [];
  const rollCd: [number, number][] = [];
  const rollBalance: [number, number][] = [];
  for (const deg of rollAnglesDeg) {
    const pt = evaluateLc26CleanRoomAeroSurface(
      LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
      LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
      0,
      deg * DEG_TO_RAD,
      0,
    );
    rollCl.push([deg, Number((pt.clATotalM2 / refDatum.clATotalM2).toFixed(5))]);
    rollCd.push([deg, Number((pt.cdABaseM2 / refDatum.cdABaseM2).toFixed(5))]);
    rollBalance.push([deg, Number((pt.aeroBalanceFront01 - refDatum.aeroBalanceFront01).toFixed(5))]);
  }

  const yawAnglesDeg = [-20, -14, -10, -6, -3, -1.5, 0, 1.5, 3, 6, 10, 14, 20];
  const yawCl: [number, number][] = [];
  const yawCd: [number, number][] = [];
  const yawBalance: [number, number][] = [];
  for (const deg of yawAnglesDeg) {
    const pt = evaluateLc26CleanRoomAeroSurface(
      LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
      LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
      deg * DEG_TO_RAD,
      0,
      0,
    );
    yawCl.push([deg, Number((pt.clATotalM2 / refDatum.clATotalM2).toFixed(5))]);
    yawCd.push([deg, Number((pt.cdABaseM2 / refDatum.cdABaseM2).toFixed(5))]);
    yawBalance.push([deg, Number((pt.aeroBalanceFront01 - refDatum.aeroBalanceFront01).toFixed(5))]);
  }

  // Floor reference plane at z = 0 sits at -0.20196 m from CG (0.248 m CG height, 32 mm FRH, 58 mm RRH)
  const floorOffsetY = -0.20196;

  const rhMap: AeroRideHeightMap = {
    clA: Number(refClA.toFixed(5)),
    cdA: Number(refCdA.toFixed(5)),
    frontPickupY: floorOffsetY,
    rearPickupY: floorOffsetY,
    rearRh: [...RH_MAP_REAR_AXES_M],
    frontRh: [...RH_MAP_FRONT_AXES_M],
    cl: clGrid,
    cd: cdGrid,
    balance: balanceGrid,
    rollCl,
    rollCd,
    rollBalance,
    yawCl,
    yawCd,
    yawBalance,
    frontDelayS: 0.016,
    rearDelayS: 0.020,
    dragDelayS: 0.014,
    activeAero: {
      dClAFront: LC26_ACTIVE_AERO_DELTAS.dClAFrontFullSmM2,
      dClARear: LC26_ACTIVE_AERO_DELTAS.dClARearFullSmM2,
      dCdA: LC26_ACTIVE_AERO_DELTAS.dCdAFrontFullSmM2 + LC26_ACTIVE_AERO_DELTAS.dCdARearFullSmM2,
    },
  };

  // Setup-trim wings: zero offset at 0 deg (since `rhMap` holds full baseline forces),
  // providing clean physical front/rear trim sensitivity when garage wing angles are adjusted.
  const wings: WingData[] = [
    {
      name: 'FRONT_WING',
      area: 1.0,
      positionZ: LC26_FIA_DATUM_PLANES.frontAxleGltfZM,
      angleDeg: fwTrimDeg,
      heightRef: 'front',
      lutAOA_CL: [
        [-8, -0.304],
        [0, 0.0],
        [8, 0.304],
      ],
      lutAOA_CD: [
        [-8, -0.044],
        [0, 0.0],
        [8, 0.056],
      ],
      lutGH_CL_mult: [
        [0.0, 1.0],
        [0.12, 1.0],
      ],
      lutGH_CD_mult: [
        [0.0, 1.0],
        [0.12, 1.0],
      ],
    },
    {
      name: 'REAR_WING',
      area: 1.0,
      positionZ: LC26_FIA_DATUM_PLANES.rearAxleGltfZM,
      angleDeg: rwTrimDeg,
      heightRef: 'rear',
      lutAOA_CL: [
        [-8, -0.352],
        [0, 0.0],
        [8, 0.352],
      ],
      lutAOA_CD: [
        [-8, -0.068],
        [0, 0.0],
        [8, 0.084],
      ],
      lutGH_CL_mult: [
        [0.0, 1.0],
        [0.14, 1.0],
      ],
      lutGH_CD_mult: [
        [0.0, 1.0],
        [0.14, 1.0],
      ],
    },
  ];

  return {
    front_lift: 0,
    rear_lift: 0,
    drag: 0,
    wings,
    front_target_height: LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
    rear_target_height: LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
    floorOffsetY,
    plank: {
      // 10 mm FIA plank bottom surface below floor reference plane
      y: floorOffsetY - 0.010,
      frontZ: LC26_FIA_DATUM_PLANES.frontAxleGltfZM - 0.430,
      rearZ: LC26_FIA_DATUM_PLANES.rearAxleGltfZM + 0.350,
    },
    drsTransitionS: LC26_SM_OPEN_TRANSITION_S,
    drsCloseThrottle: LC26_SM_THROTTLE_MIN_GATE_01,
    airDensity: LC26_REFERENCE_AIR_DENSITY_KG_M3,
    rhMap,
  };
}

// ---------------------------------------------------------------------------
// `Lc26AeroModule` Runtime Step Implementation
// ---------------------------------------------------------------------------

const FW_FLAP2_SM_DEG = LC26_ACTIVE_AERO_HINGES.fwFlap2.straightModeAngleDeg; // -9.5 deg
const FW_FLAP3_SM_DEG = LC26_ACTIVE_AERO_HINGES.fwFlap3.straightModeAngleDeg; // -16.5 deg
const RW_FLAP2_SM_DEG = LC26_ACTIVE_AERO_HINGES.rwFlap2.straightModeAngleDeg; // -12.0 deg
const RW_FLAP3_SM_DEG = LC26_ACTIVE_AERO_HINGES.rwFlap3.straightModeAngleDeg; // -19.0 deg

function createInitialFlapState(): Lc26FlapDeflectionState {
  return {
    mode: 'corner-mode',
    smProgress01: 0,
    fwFlap2Deg: LC26_ACTIVE_AERO_HINGES.fwFlap2.cornerModeAngleDeg,
    fwFlap3Deg: LC26_ACTIVE_AERO_HINGES.fwFlap3.cornerModeAngleDeg,
    rwFlap2Deg: LC26_ACTIVE_AERO_HINGES.rwFlap2.cornerModeAngleDeg,
    rwFlap3Deg: LC26_ACTIVE_AERO_HINGES.rwFlap3.cornerModeAngleDeg,
  };
}

function stepLc26Aero(prev: Lc26FlapDeflectionState, input: Lc26AeroStepInput): Lc26AeroStepOutput {
  const dtS = clamp(input.dtS, 0, 0.25);
  const rho = clamp(input.airDensityKgM3, 0.7, 1.6);
  const speedMs = Math.max(0, Number.isFinite(input.speedMs) ? Math.abs(input.speedMs) : 0);
  const qPa = 0.5 * rho * speedMs * speedMs;

  // 1. FIA Safety Interlocks & Dual-Link Flap Actuator Slew (`<= 400 ms`)
  const decision = evaluateLc26SmInterlock(input);

  const prevFwOpen01 = clamp01(FW_FLAP3_SM_DEG !== 0 ? prev.fwFlap3Deg / FW_FLAP3_SM_DEG : prev.smProgress01);
  const prevRwOpen01 = clamp01(RW_FLAP3_SM_DEG !== 0 ? prev.rwFlap3Deg / RW_FLAP3_SM_DEG : prev.smProgress01);

  const fwMaxStep =
    dtS / (decision.targetFwOpen01 > prevFwOpen01 ? decision.transitionTimeS : Math.min(decision.transitionTimeS, LC26_SM_CLOSE_TRANSITION_S));
  const rwMaxStep =
    dtS / (decision.targetRwOpen01 > prevRwOpen01 ? decision.transitionTimeS : Math.min(decision.transitionTimeS, LC26_SM_CLOSE_TRANSITION_S));

  const fwOpen01 = slewLinear(prevFwOpen01, decision.targetFwOpen01, fwMaxStep);
  const rwOpen01 = slewLinear(prevRwOpen01, decision.targetRwOpen01, rwMaxStep);

  // `smProgress01` represents active mode completion (`0` = full Corner Mode, `1` = full Straight Mode;
  // in `partial-wet-fw-only`, tracks front-wing low-drag progress `0..1` while RW stays locked at `0°`).
  const smProgress01 =
    decision.targetMode === 'partial-wet-fw-only'
      ? fwOpen01
      : 0.5 * (fwOpen01 + rwOpen01);

  const flaps: Lc26FlapDeflectionState = {
    mode: decision.targetMode,
    smProgress01,
    fwFlap2Deg: fwOpen01 * FW_FLAP2_SM_DEG,
    fwFlap3Deg: fwOpen01 * FW_FLAP3_SM_DEG,
    rwFlap2Deg: rwOpen01 * RW_FLAP2_SM_DEG,
    rwFlap3Deg: rwOpen01 * RW_FLAP3_SM_DEG,
  };

  // 2. 3D Clean-Room Ride-Height & Attitude Surface
  const baseSurface = evaluateLc26CleanRoomAeroSurface(
    input.frontRideHeightM,
    input.rearRideHeightM,
    input.yawSlipRad,
    input.rollRad,
    input.steerRad,
  );

  // 3. Setup Preset, Wing Incidence Trim & Dorsal Cooling Gill Louvres (`1..5`)
  const presetSpec = PRESET_OFFSETS[input.preset] ?? PRESET_OFFSETS.balanced;
  const gillSpec = LC26_COOLING_GILL_SPECS[input.coolingGillLevel] ?? LC26_COOLING_GILL_SPECS[3];
  const fwTrimDeg = clamp(input.frontWingTrimDeg, -8, 8);
  const rwTrimDeg = clamp(input.rearWingTrimDeg, -8, 8);

  const dClAFwTrim = 0.038 * fwTrimDeg * (1 - 0.35 * fwOpen01);
  const dClARwTrim = 0.044 * rwTrimDeg * (1 - 0.35 * rwOpen01);
  const dCdATrim =
    (fwTrimDeg >= 0 ? 0.0070 : 0.0055) * fwTrimDeg +
    (rwTrimDeg >= 0 ? 0.0105 : 0.0085) * rwTrimDeg;

  // 4. Active Aero Dual-Flap Deflection Unloading & High-q Aero-Elastic Flex (`> 280 km/h`)
  const dClAActiveFront = fwOpen01 * LC26_ACTIVE_AERO_DELTAS.dClAFrontFullSmM2;
  const dClAActiveRear = rwOpen01 * LC26_ACTIVE_AERO_DELTAS.dClARearFullSmM2;
  const dCdAActive =
    fwOpen01 * LC26_ACTIVE_AERO_DELTAS.dCdAFrontFullSmM2 +
    rwOpen01 * LC26_ACTIVE_AERO_DELTAS.dCdARearFullSmM2;

  const elastic = evaluateLc26AeroElasticCompliance(qPa, fwOpen01, rwOpen01);

  // 5. Dirty-Air Wake Retention (`gapAheadSeconds`)
  const wake = evaluateLc26WakeEffect(input.gapAheadSeconds);

  const clAFrontNet = Math.max(
    0.02,
    (baseSurface.clAFrontM2 + presetSpec.dClAFrontM2 + dClAFwTrim + dClAActiveFront + elastic.dClAFrontM2) *
      wake.wakeRetention01,
  );
  const clARearNet = Math.max(
    0.02,
    (baseSurface.clARearM2 +
      presetSpec.dClARearM2 +
      gillSpec.dClARearM2 +
      dClARwTrim +
      dClAActiveRear +
      elastic.dClARearM2) *
      wake.wakeRetention01,
  );
  const cdANet = Math.max(
    0.22,
    (baseSurface.cdABaseM2 + presetSpec.dCdAM2 + gillSpec.dCdAM2 + dCdATrim + dCdAActive + elastic.dCdAM2) *
      wake.dragWakeMultiplier,
  );

  const downforceFrontN = qPa * clAFrontNet;
  const downforceRearN = qPa * clARearNet;
  const totalDownforceN = downforceFrontN + downforceRearN;
  const totalDragN = qPa * cdANet;
  const aeroBalanceFront01 =
    totalDownforceN > 1e-6 ? clamp01(downforceFrontN / totalDownforceN) : baseSurface.aeroBalanceFront01;

  return {
    flaps,
    downforceFrontN,
    downforceRearN,
    totalDownforceN,
    totalDragN,
    aeroBalanceFront01,
    floorStallFactor01: baseSurface.floorStallFactor01,
    wakeRetention01: wake.wakeRetention01,
    coolingRejectMultiplier: gillSpec.coolingRejectMultiplier,
  };
}

export const LC26_DEFAULT_AERO_DATA: AeroData = buildLc26AeroData();

export const LC26_AERO_MODULE: Lc26AeroModule = {
  aeroData: LC26_DEFAULT_AERO_DATA,
  createInitialState: createInitialFlapState,
  stepAero: stepLc26Aero,
};
