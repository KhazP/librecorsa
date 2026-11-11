/**
 * Clean-Room 2026 Formula 1 Hybrid Powertrain, Super Clipping & Brake-by-Wire ECU
 * for "VeloSoft LC-26" (`lc26-f1`).
 *
 * Strictly derived from first-principles thermodynamics, electromechanics, and
 * FIA 2026 Formula 1 Technical Regulations — Section C Issue 21:
 *  - Article C5.1 / C5.4: 1.6L (1600 cc) 90° V6 4-stroke, 80.0 mm bore, max 16.0:1 CR, NO MGU-H
 *  - Article C5.2.3–C5.2.6 (Contract C5.4.3): Sustainable fuel (43.5 MJ/kg LHV) capped at
 *    3000 MJ/h (>= 10,500 RPM) and (0.27 * rpm + 165) MJ/h (< 10,500 RPM), tracked strictly in kg
 *  - Article C5.3: Single-stage exhaust turbocharger (shaft inertia J_tc, <= 4.8 barA plenum cap)
 *    with electronic wastegate & low-RPM MGU-K anti-lag torque-fill on corner exit
 *  - Article C5.2.7–C5.2.12: 350 kW / 500 Nm MGU-K, 4.0 MJ usable ES window, 8.5 MJ/lap harvest
 *    (+0.5 MJ Overtake Mode deploy & harvest allowance), exact C5.2.8 speed tapers (Standard
 *    290->340->345 km/h; Overtake 337.5->355 km/h), and standing-start 50 km/h MGU-K gate
 *  - Article C5.12: Driver torque monotonicity, dT/dN >= -0.045 Nm/rpm (> 4000 RPM), Boost override,
 *    and smooth dP/dt ECU Super Clipping at 100% throttle (keeping Straight Mode OPEN)
 *  - Article C9 & C11.6: 8-speed 28 ms seamless gearbox, over-rev downshift protection, button-gated
 *    Neutral/Reverse interlock, 5.0 s grid launch 7500 RPM rev-hold anti-lag, 3-phase clutch-pack +
 *    viscous differential, and zero-spike rear Brake-by-Wire (>= 2500 Nm hydraulic fail-safe).
 */

import type { LutPoints } from '@/lib/sim/lut';
import {
  type BrakesData,
  type ClutchData,
  type DifferentialData,
  type EngineData,
  type ERSData,
  type GearBoxData,
  LC26_FIA_POWERTRAIN_LIMITS,
  type Lc26BbwSplitResult,
  type Lc26ErsDeployMode,
  type Lc26GarageSetup,
  type Lc26PowertrainModule,
  type Lc26PowertrainTelemetry,
  type PerformanceModeData,
  type PerformanceModeName,
  type TurboData,
} from './contract-types';

const RPM_TO_RADS = Math.PI / 30;
const RADS_TO_RPM = 30 / Math.PI;
const SECONDS_PER_HOUR = 3600;

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep01(x: number, edge0: number, edge1: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1);
}

// ---------------------------------------------------------------------------
// Calibration & Physical Parameter Schemas (Phase 2 Telemetry Matching Ready)
// ---------------------------------------------------------------------------

/**
 * Exposed ERS & speed-derating calibration parameters.
 * Default values match FIA 2026 Section C Article C5.2.8 & C5.12 verbatim.
 * Setting `cornerSmoothingWidthKmh > 0` applies an analytical C1 upper-bounded
 * corner rounding that never exceeds the legal FIA C5.2.8 envelope.
 */
export interface Lc26ErsCalibrationParams {
  readonly maxPowerKw: number;
  readonly maxCrankTorqueNm: number;
  readonly usableBatteryWindowJ: number;
  readonly standardLapDeployWindowJ: number;
  readonly standardLapHarvestLimitJ: number;
  readonly overtakeExtraEnergyJ: number;
  readonly deployEfficiency: number;
  readonly harvestEfficiency: number;
  // Standard FIA C5.2.8(i) profile: 350 kW <= 290; (1800 - 5*v) in (290, 340); (6900 - 20*v) in [340, 345); 0 >= 345
  readonly standardKnee1Kmh: number;
  readonly standardSlope1KwPerKmh: number;
  readonly standardKnee2Kmh: number;
  readonly standardSlope2KwPerKmh: number;
  readonly standardZeroKmh: number;
  // Overtake FIA C5.2.8(ii) profile: 350 kW <= 337.5; (7100 - 20*v) in (337.5, 355); 0 >= 355
  readonly overtakeKneeKmh: number;
  readonly overtakeSlopeKwPerKmh: number;
  readonly overtakeZeroKmh: number;
  /** Optional smooth C1 corner-rounding width (km/h); 0 = exact piecewise linear FIA C5.2.8 */
  readonly cornerSmoothingWidthKmh: number;
  /** Overtake detection gap threshold (s); < 1.0 s arms Overtake Mode */
  readonly overtakeDetectionGapS: number;
  /** Standing-start speed below which positive MGU-K launch deploy is gated off (km/h, FIA C5.2.12) */
  readonly standingStartMgukMinSpeedKmh: number;
  /** ECU Super Clipping speed threshold & configurable harvest ceiling (250..350 kW) */
  readonly superClipMinSpeedKmh: number;
  readonly superClipHarvestCeilingKw: number;
  /** FIA C5.12.6 power reduction slew limit while MGU-K > 100 kW (100 kW/s normal, 50 kW/s long-straight) */
  readonly fiaHighPowerSlewKwPerS: number;
  /** Smooth dP/dt slew limit below 100 kW into Super Clipping harvest (kW/s) — prevents rear torque steps */
  readonly superClipTransitionSlewKwPerS: number;
  /** Upward power slew rate on Boost / corner exit (kW/s) */
  readonly deployRampUpSlewKwPerS: number;
}

export const DEFAULT_LC26_ERS_CALIBRATION: Lc26ErsCalibrationParams = {
  maxPowerKw: LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw, // 350 kW
  maxCrankTorqueNm: LC26_FIA_POWERTRAIN_LIMITS.mgukMaxCrankTorqueNm, // 500 Nm
  usableBatteryWindowJ: LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ, // 4.0 MJ
  standardLapDeployWindowJ: LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ, // 4.0 MJ (+0.5 MJ = 4.5 MJ in Overtake)
  standardLapHarvestLimitJ: LC26_FIA_POWERTRAIN_LIMITS.maxHarvestPerLapStandardJ, // 8.5 MJ (+0.5 MJ = 9.0 MJ in Overtake)
  overtakeExtraEnergyJ: LC26_FIA_POWERTRAIN_LIMITS.overtakeExtraDeployJ, // 0.5 MJ
  deployEfficiency: 0.97, // FIA C5.2.21 fixed SECU conversion efficiency
  harvestEfficiency: 0.97,
  standardKnee1Kmh: 290.0,
  standardSlope1KwPerKmh: 5.0,
  standardKnee2Kmh: 340.0,
  standardSlope2KwPerKmh: 20.0,
  standardZeroKmh: 345.0,
  overtakeKneeKmh: 337.5,
  overtakeSlopeKwPerKmh: 20.0,
  overtakeZeroKmh: 355.0,
  cornerSmoothingWidthKmh: 0.0,
  overtakeDetectionGapS: 1.0,
  standingStartMgukMinSpeedKmh: 50.0,
  superClipMinSpeedKmh: 268.0,
  superClipHarvestCeilingKw: 280.0,
  fiaHighPowerSlewKwPerS: 100.0,
  superClipTransitionSlewKwPerS: 320.0,
  deployRampUpSlewKwPerS: 9500.0,
};

/** Physical MGU-H-free single-stage turbocharger & intake plenum parameters (FIA C5.3) */
export interface Lc26TurboPhysicsParams {
  /** Polar moment of inertia of compressor + turbine + shaft (kg·m², fixed inertia per C5.3.1) */
  readonly shaftInertiaKgM2: number;
  readonly idleShaftRadS: number;
  readonly maxShaftRadS: number;
  readonly ambientPressureBarA: number;
  /** Regulated electronic wastegate plenum ceiling (< 4.80 barA FIA C5.3.2 hard limit) */
  readonly maxRegulatedBoostBarA: number;
  readonly fiaHardCeilingBarA: number;
  /** Intake plenum + intercooler pneumatic filling time constant (s) */
  readonly plenumFillingTauS: number;
  /** Grid launch anti-lag retarded-spark pre-boost target (barA) */
  readonly launchPreBoostBarA: number;
}

export const DEFAULT_LC26_TURBO_PARAMS: Lc26TurboPhysicsParams = {
  shaftInertiaKgM2: 4.2e-5,
  idleShaftRadS: 2850,
  maxShaftRadS: 13150,
  ambientPressureBarA: 1.01325,
  maxRegulatedBoostBarA: 4.76,
  fiaHardCeilingBarA: LC26_FIA_POWERTRAIN_LIMITS.maxBoostPlenumBarA, // 4.80 barA
  plenumFillingTauS: 0.022,
  launchPreBoostBarA: 3.18,
};

/** Rear Brake-by-Wire (BBW) & fail-safe hydraulic calibration (FIA C11.6) */
export interface Lc26BbwCalibrationParams {
  /** Nominal full-pedal brake torque per wheel-pair equivalent (Nm -> 2 * this = total 4-wheel capacity) */
  readonly maxWheelPairTorqueNm: number;
  /** Mechanical fail-safe rear axle hydraulic caliper ceiling without MGU-K (>= 2500 Nm FIA min) */
  readonly rearHydraulicMaxAxleTorqueNm: number;
  readonly rearEffectiveRadiusM: number;
  readonly socSaturationTaperStart01: number;
  readonly harvestCapTaperMarginJ: number;
  readonly lowSpeedFadeKmh: readonly [zeroAtKmh: number, fullAtKmh: number];
  readonly lowRpmFadeRpm: readonly [zeroAtRpm: number, fullAtRpm: number];
}

export const DEFAULT_LC26_BBW_PARAMS: Lc26BbwCalibrationParams = {
  maxWheelPairTorqueNm: 8400, // 16,800 Nm total 4-wheel braking capacity (~5.1 g peak with aero)
  rearHydraulicMaxAxleTorqueNm: 8000, // >= 2500 Nm fail-safe mechanical capacity
  rearEffectiveRadiusM: 0.35,
  socSaturationTaperStart01: 0.992,
  harvestCapTaperMarginJ: 50_000,
  lowSpeedFadeKmh: [8, 36],
  lowRpmFadeRpm: [3800, 5200],
};

// ---------------------------------------------------------------------------
// 1. Clean-Room 1.6L 90° V6 Turbo Thermodynamics & FIA Fuel Flow Model
// ---------------------------------------------------------------------------

/**
 * Exact FIA 2026 Section C (Articles C5.2.3 & C5.2.4 / Contract C5.4.3) sustainable fuel
 * energy-flow ceiling (`MJ/h`) and corresponding mass-flow ceiling (`kg/s` at `43.5 MJ/kg` LHV).
 */
export function computeLc26FiaFuelFlowCap(rpm: number): { maxEnergyMjH: number; maxMassKgS: number } {
  const n = Math.max(0, Number.isFinite(rpm) ? rpm : 0);
  const maxEnergyMjH =
    n <= 0
      ? 0
      : n < LC26_FIA_POWERTRAIN_LIMITS.fuelFlowKneeRpm
        ? Math.min(LC26_FIA_POWERTRAIN_LIMITS.maxFuelEnergyFlowMjPerH, 0.27 * n + 165)
        : LC26_FIA_POWERTRAIN_LIMITS.maxFuelEnergyFlowMjPerH;
  const maxMassKgS =
    maxEnergyMjH / (LC26_FIA_POWERTRAIN_LIMITS.sustainableFuelLhvMjPerKg * SECONDS_PER_HOUR);
  return { maxEnergyMjH, maxMassKgS };
}

/**
 * FIA Article C5.2.5 partial-load fuel energy flow limit (MJ/h) as a function of engine power (kW)
 * intersected with the RPM ceiling from `computeLc26FiaFuelFlowCap`.
 */
export function computeLc26PartialLoadFuelCapMjH(rpm: number, icePowerKw: number): number {
  const { maxEnergyMjH } = computeLc26FiaFuelFlowCap(rpm);
  const partLoadCapMjH = icePowerKw <= -50 ? 380 : 9.78 * icePowerKw + 869;
  return Math.max(0, Math.min(maxEnergyMjH, partLoadCapMjH));
}

/**
 * First-principles steady-state full-boost ICE brake power (kW) for the clean-room 1.6L 90° V6
 * (80.0 mm bore × 53.05 mm stroke, 16.0:1 geometric CR, turbulent-jet pre-chamber lean burn,
 * no MGU-H exhaust compounding):
 *  - Thermal input bounded strictly by FIA C5.4.3 / C5.2.3–4 (`3000 MJ/h` = `833.33 kW` >= 10,500 RPM).
 *  - Indicated efficiency combines compressor boost fill + intake Helmholtz / TJI scavenging resonance
 *    peaking near 11,350 RPM (`eta_brake` ~48.4% -> peak `403.5 kW` / `541 hp` around 11,000 RPM).
 *  - Subtracts piston-speed-squared FMEP mechanical friction (`FMEP = c0 + c1*u + c2*u^2`), naturally
 *    placing the equal-power optimal upshift window in `11,600–12,200 RPM` while satisfying FIA C5.12.2
 *    (`dT/dN >= -0.045 Nm/rpm` above 4,000 RPM) all the way to the `15,000 RPM` FIA ceiling.
 */
export function evaluateCleanRoomIceSteadyPowerKw(rpm: number): number {
  const n = clamp(rpm, 0, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  if (n <= 800) return 0;

  const { maxEnergyMjH } = computeLc26FiaFuelFlowCap(n);
  const fuelThermalPowerKw = (maxEnergyMjH * 1000) / SECONDS_PER_HOUR;

  // Compressor plenum pressure ratio fill + TJI pre-chamber / variable-trumpet scavenging curve
  const boostScavengeFill = 1 / (1 + Math.exp(-(n - 5000) / 850));
  const helmholtzResonance = Math.exp(-(((n - 11450) / 3850) ** 2));
  const indicatedThermalEfficiency = 0.422 + 0.119 * boostScavengeFill * helmholtzResonance;
  const indicatedPowerKw = fuelThermalPowerKw * indicatedThermalEfficiency;

  // FMEP mechanical rubbing + pumping friction for 6-cyl short-stroke (53.05 mm) 1600 cc V6
  const u = n / 10000;
  const fmepBar = 0.88 + 0.36 * u + 1.48 * u * u;
  const displacementM3 = LC26_FIA_POWERTRAIN_LIMITS.iceDisplacementCc * 1e-6;
  const frictionPowerKw = (fmepBar * 1e5 * displacementM3 * (n / 120)) / 1000;

  // Low-RPM sub-idle taper below 2,500 RPM for smooth numerical solver boundary
  const lowRpmTaper = smoothstep01(n, 800, 2400);
  return Math.max(0, (indicatedPowerKw - frictionPowerKw) * lowRpmTaper);
}

/**
 * First-principles closed-throttle ICE pumping + friction coast braking torque magnitude (Nm, >= 0).
 * Respects FIA Article C5.12.3 minimum driver torque demand bound when scaled by engine braking map (`1..10`).
 */
export function evaluateCleanRoomIceCoastTorqueNm(rpm: number, engineBrakingLevel = 5): number {
  const n = clamp(rpm, 0, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  if (n <= 900) return 0;
  const u = n / 10000;
  // Base mechanical & pumping coast torque (~26 Nm near 4k RPM rising to ~60 Nm at 12.2k RPM)
  const baseCoastNm = 16 + 22 * u + 11.5 * u * u;
  // Garage setup engineBrakingLevel (1 = most overrun braking / least fuel-push, 10 = least engine braking)
  const levelClamped = clamp(engineBrakingLevel, 1, 10);
  const mapScale = lerp(1.12, 0.58, (levelClamped - 1) / 9);
  return baseCoastNm * mapScale * smoothstep01(n, 900, 2600);
}

/** Target steady-state full-throttle intake plenum boost (barA) vs RPM (`<= 4.76 barA < 4.80 barA` FIA limit) */
export function evaluateTargetPlenumBoostBarA(
  rpm: number,
  throttle01: number,
  turboParams: Lc26TurboPhysicsParams = DEFAULT_LC26_TURBO_PARAMS,
): number {
  const thr = clamp(throttle01, 0, 1);
  if (thr <= 0.01) return turboParams.ambientPressureBarA;
  const n = clamp(rpm, LC26_FIA_POWERTRAIN_LIMITS.idleRpm, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  // Exhaust mass flow builds full 4.76 barA compressor pressure ratio by ~6,900 RPM
  const rpmFactor = clamp((n / 6900) ** 1.65, 0.12, 1.0);
  const maxGaugeBar = turboParams.maxRegulatedBoostBarA - turboParams.ambientPressureBarA;
  const targetBarA = turboParams.ambientPressureBarA + maxGaugeBar * rpmFactor * thr;
  return clamp(targetBarA, turboParams.ambientPressureBarA, turboParams.maxRegulatedBoostBarA);
}

function buildCleanRoomIcePowerLut(): LutPoints {
  const rpms = [
    0, 1000, 2000, 3000, 3800, 4200, 4600, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 9000,
    9500, 10000, 10300, 10500, 10750, 11000, 11200, 11400, 11600, 11850, 12000, 12200, 12600,
    13000, 13500, 14000, 14500, 15000,
  ];
  return rpms.map((r) => [r, Number(evaluateCleanRoomIceSteadyPowerKw(r).toFixed(3))] as const);
}

function buildCleanRoomIceCoastLut(): LutPoints {
  const rpms = [0, 1000, 2500, 3800, 5000, 6500, 8000, 9500, 10500, 11500, 12200, 13500, 15000];
  return rpms.map((r) => [r, Number(evaluateCleanRoomIceCoastTorqueNm(r, 5).toFixed(2))] as const);
}

function buildCleanRoomThrottleResponseLut(): LutPoints {
  // Strictly monotonic progressive drive-by-wire torque demand curve (FIA C5.12.1)
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i <= 10; i++) {
    const p = i / 10;
    const shaped = p <= 0 ? 0 : p >= 1 ? 1 : 0.82 * Math.pow(p, 1.18) + 0.18 * p;
    pts.push([Number(p.toFixed(2)), Number(shaped.toFixed(4))] as const);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// 2. 350 kW MGU-K, 4.0 MJ ES & Exact FIA C5.2.8 Speed Derating Profiles
// ---------------------------------------------------------------------------

/** Smooth upper-bounded corner transition `min_smooth(a, b, delta)` <= `min(a, b)` */
function smoothMinUpperBounded(a: number, b: number, width: number): number {
  if (width <= 0) return Math.min(a, b);
  const h = Math.max(0, width - Math.abs(a - b)) / width;
  return Math.min(a, b) - 0.25 * width * h * h;
}

/**
 * Exact FIA 2026 Article C5.2.8 speed-based MGU-K mechanical power ceiling (kW):
 *  - Standard (`overtakeModeActive === false`):
 *    * `v <= 290 km/h`: `350 kW`
 *    * `290 < v < 340 km/h`: `1800 - 5 * v` (`350 kW` -> `100 kW`)
 *    * `340 <= v < 345 km/h`: `6900 - 20 * v` (`100 kW` -> `0 kW`)
 *    * `v >= 345 km/h`: `0 kW`
 *  - Overtake Mode (`overtakeModeActive === true`):
 *    * `v <= 337.5 km/h` (holds full `350 kW` past `337 km/h` to `337.5 km/h`): `350 kW`
 *    * `337.5 < v < 355 km/h`: `7100 - 20 * v` (`350 kW` -> `0 kW`)
 *    * `v >= 355 km/h`: `0 kW`
 */
export function computeLc26FiaMgukPowerCapKw(
  speedKmh: number,
  overtakeModeActive: boolean,
  calibration: Lc26ErsCalibrationParams = DEFAULT_LC26_ERS_CALIBRATION,
): number {
  const v = Math.max(0, Number.isFinite(speedKmh) ? speedKmh : 0);
  const maxKw = calibration.maxPowerKw;

  if (overtakeModeActive) {
    if (v >= calibration.overtakeZeroKmh) return 0;
    const ramp = calibration.overtakeSlopeKwPerKmh * (calibration.overtakeZeroKmh - v);
    if (calibration.cornerSmoothingWidthKmh > 0) {
      const wKw = calibration.cornerSmoothingWidthKmh * calibration.overtakeSlopeKwPerKmh;
      return clamp(smoothMinUpperBounded(maxKw, ramp, wKw), 0, maxKw);
    }
    return v <= calibration.overtakeKneeKmh ? maxKw : clamp(ramp, 0, maxKw);
  }

  if (v >= calibration.standardZeroKmh) return 0;
  const line1 =
    maxKw - calibration.standardSlope1KwPerKmh * Math.max(0, v - calibration.standardKnee1Kmh);
  const line2 = calibration.standardSlope2KwPerKmh * (calibration.standardZeroKmh - v);

  if (calibration.cornerSmoothingWidthKmh > 0) {
    const w1 = calibration.cornerSmoothingWidthKmh * calibration.standardSlope1KwPerKmh;
    const w2 = calibration.cornerSmoothingWidthKmh * calibration.standardSlope2KwPerKmh;
    const cap1 = smoothMinUpperBounded(maxKw, maxKw - calibration.standardSlope1KwPerKmh * (v - calibration.standardKnee1Kmh), w1);
    return clamp(smoothMinUpperBounded(cap1, line2, w2), 0, maxKw);
  }

  if (v <= calibration.standardKnee1Kmh) return maxKw;
  if (v < calibration.standardKnee2Kmh) return clamp(line1, 0, maxKw);
  return clamp(line2, 0, maxKw);
}

/**
 * Clean-room MGU-K crank mechanical torque limit (Nm) vs RPM:
 * Bounded by FIA C5.2.11 (`<= 500 Nm` referenced to crankshaft) and `powerCapKw` (`350 kW` max).
 * Crossover RPM = `(350,000 / 500) * 30 / pi = 6,684.5 RPM`.
 */
export function evaluateCleanRoomMgukCrankTorqueCapNm(
  rpm: number,
  powerCapKw: number = LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw,
): number {
  const n = Math.max(0, Number.isFinite(rpm) ? rpm : 0);
  if (n <= 600 || powerCapKw <= 0) return 0;
  const omega = n * RPM_TO_RADS;
  const lowRpmRamp = smoothstep01(n, 1200, 4100);
  const torqueCap = LC26_FIA_POWERTRAIN_LIMITS.mgukMaxCrankTorqueNm * lowRpmRamp;
  const powerTorqueCap = (powerCapKw * 1000) / omega;
  return clamp(Math.min(torqueCap, powerTorqueCap), 0, LC26_FIA_POWERTRAIN_LIMITS.mgukMaxCrankTorqueNm);
}

function buildCleanRoomMgukTorqueLut(): LutPoints {
  const rpms = [
    0, 1000, 2000, 3000, 3800, 4200, 5000, 6000, 6685, 7000, 8000, 9000, 10000, 10500, 11000,
    11500, 12000, 12200, 13000, 14000, 15000,
  ];
  return rpms.map((r) => [r, Number(evaluateCleanRoomMgukCrankTorqueCapNm(r, 350).toFixed(2))] as const);
}

function buildStandardDeployVsSpeedLut(scale = 1.0): LutPoints {
  const speeds = [0, 120, 240, 290, 300, 310, 320, 330, 340, 342.5, 345, 360];
  return speeds.map((v) => {
    const frac = (computeLc26FiaMgukPowerCapKw(v, false) / 350) * scale;
    return [v, Number(clamp(frac, 0, 1).toFixed(4))] as const;
  });
}

/** Normalized `deployVsSpeed` LUT for FIA C5.2.8(ii) Overtake Mode (`337.5 -> 355 km/h`) */
export const LC26_OVERTAKE_DEPLOY_VS_SPEED: LutPoints = [
  0, 200, 290, 330, 337, 337.5, 340, 345, 350, 355, 365,
].map((v) => [v, Number(clamp(computeLc26FiaMgukPowerCapKw(v, true) / 350, 0, 1).toFixed(4))] as const);

// ---------------------------------------------------------------------------
// 3. True Rear Brake-by-Wire (BBW) Solver (Zero Rear Torque Spike / Sag)
// ---------------------------------------------------------------------------

/**
 * Solves front hydraulic, rear hydraulic, and rear MGU-K regenerative braking torque split
 * with dynamic forward/rearward brake migration (`migrationRamp01`).
 *
 * INVARIANT: `rearHydraulicTorqueNm + rearMgukRegenTorqueNm === totalRearAxleDemandNm`
 * across all transitions (`soc01 -> 1.0`, `lapHarvestedJ -> 8.5/9.0 MJ`, low-RPM/low-speed taper),
 * backed by `>= 2500 Nm` mechanical rear hydraulic fail-safe capacity (FIA C11.6).
 */
export function solveLc26BrakeByWire(
  brakePedal01: number,
  speedKmh: number,
  rpm: number,
  soc01: number,
  lapHarvestedJ: number,
  baseFrontBias01: number,
  migrationRamp01: number,
  overtakeModeActive = false,
  params: Lc26BbwCalibrationParams = DEFAULT_LC26_BBW_PARAMS,
  ersParams: Lc26ErsCalibrationParams = DEFAULT_LC26_ERS_CALIBRATION,
): Lc26BbwSplitResult {
  const pedal = clamp(brakePedal01, 0, 1);
  const baseBias = clamp(baseFrontBias01, 0.35, 0.75);
  // Dynamic brake migration: shifts effective bias smoothly with pedal pressure
  // Supports both forward (+migrationRamp01) and rearward (-migrationRamp01) migration shapes
  const migDelta = clamp(migrationRamp01, -0.15, 0.15) * pedal;
  const effectiveFrontBias01 = clamp(baseBias + migDelta, 0.35, 0.75);

  if (pedal <= 0) {
    return {
      totalFrontAxleTorqueNm: 0,
      rearHydraulicTorqueNm: 0,
      rearMgukRegenTorqueNm: 0,
      effectiveFrontBias01,
      harvestedPowerKw: 0,
    };
  }

  // Total 4-wheel brake torque demand (`2 * maxWheelPairTorqueNm` at 100% pedal)
  const totalVehicleBrakeTorqueNm = 2 * pedal * params.maxWheelPairTorqueNm;
  const totalFrontAxleTorqueNm = totalVehicleBrakeTorqueNm * effectiveFrontBias01;
  const totalRearAxleDemandNm = Math.min(
    params.rearHydraulicMaxAxleTorqueNm,
    totalVehicleBrakeTorqueNm * (1 - effectiveFrontBias01),
  );

  // Evaluate available MGU-K regenerative rear axle braking torque
  const vKmh = Math.max(0, Number.isFinite(speedKmh) ? speedKmh : 0);
  const vMs = vKmh / 3.6;
  const axleOmegaRadS = vMs / params.rearEffectiveRadiusM;
  const nRpm = Math.max(0, Number.isFinite(rpm) ? rpm : 0);
  const crankOmegaRadS = Math.max(1, nRpm * RPM_TO_RADS);

  // Smooth fade-outs near standstill, low crank RPM, SoC == 100%, and lap harvest cap (8.5 / 9.0 MJ)
  const speedFade = smoothstep01(vKmh, params.lowSpeedFadeKmh[0], params.lowSpeedFadeKmh[1]);
  const rpmFade = smoothstep01(nRpm, params.lowRpmFadeRpm[0], params.lowRpmFadeRpm[1]);
  const socClamped = clamp(soc01, 0, 1);
  const socRoomFactor =
    socClamped >= 1
      ? 0
      : 1 - smoothstep01(socClamped, params.socSaturationTaperStart01, 1.0);

  const maxLapHarvestJ =
    ersParams.standardLapHarvestLimitJ + (overtakeModeActive ? ersParams.overtakeExtraEnergyJ : 0);
  const harvestedClamped = Math.max(0, Number.isFinite(lapHarvestedJ) ? lapHarvestedJ : 0);
  const harvestRoomFactor =
    harvestedClamped >= maxLapHarvestJ
      ? 0
      : 1 -
        smoothstep01(
          harvestedClamped,
          maxLapHarvestJ - params.harvestCapTaperMarginJ,
          maxLapHarvestJ,
        );

  const availability01 = speedFade * rpmFade * socRoomFactor * harvestRoomFactor;

  let rearMgukRegenTorqueNm = 0;
  let harvestedPowerKw = 0;

  if (availability01 > 0 && axleOmegaRadS > 0.5) {
    // Implied drivetrain ratio between crank and rear axle (bounded to physical 1st..8th gear range)
    const impliedRatio = clamp(crankOmegaRadS / axleOmegaRadS, 4.3, 15.5);
    const drivetrainEff = 0.98;
    const maxCrankHarvestKw = ersParams.maxPowerKw * availability01;
    const maxCrankTorqueNm = evaluateCleanRoomMgukCrankTorqueCapNm(nRpm, maxCrankHarvestKw);
    const maxAxleRegenByTorqueNm = (maxCrankTorqueNm * impliedRatio) / drivetrainEff;
    const maxAxleRegenByPowerNm = (maxCrankHarvestKw * 1000) / Math.max(1, axleOmegaRadS * drivetrainEff);
    const maxAvailableAxleRegenNm = Math.max(0, Math.min(maxAxleRegenByTorqueNm, maxAxleRegenByPowerNm));

    rearMgukRegenTorqueNm = Math.min(totalRearAxleDemandNm, maxAvailableAxleRegenNm);
    const mechShaftPowerKw = (rearMgukRegenTorqueNm * axleOmegaRadS * drivetrainEff) / 1000;
    harvestedPowerKw = clamp(
      mechShaftPowerKw * ersParams.harvestEfficiency,
      0,
      ersParams.maxPowerKw,
    );
  }

  // Electro-hydraulic BBW actuator fills the exact remainder so rear axle braking torque never steps!
  const rearHydraulicTorqueNm = Math.max(0, totalRearAxleDemandNm - rearMgukRegenTorqueNm);

  return {
    totalFrontAxleTorqueNm,
    rearHydraulicTorqueNm,
    rearMgukRegenTorqueNm,
    effectiveFrontBias01,
    harvestedPowerKw,
  };
}

// ---------------------------------------------------------------------------
// 4. 3-Phase Electronic Clutch-Pack + Viscous Differential Solver
// ---------------------------------------------------------------------------

export interface Lc26DiffStepInput {
  /** Net signed torque entering the differential ring gear (Nm: + drive, - overrun/regen) */
  readonly ringGearTorqueNm: number;
  readonly rearLeftWheelOmegaRadS: number;
  readonly rearRightWheelOmegaRadS: number;
  readonly throttlePedal01: number;
  readonly brakePedal01: number;
  /** Normalized steering input `[-1..+1]` or road-wheel steer magnitude */
  readonly steeringNormalized: number;
  readonly speedKmh: number;
  /** Entry (braking/turn-in) locking % (`0..100`, default `28`) */
  readonly entryLockPct?: number;
  /** Mid-corner (apex coast/maintenance) locking % (`0..100`, default `18`) */
  readonly midCoastLockPct?: number;
  /** Exit / High-speed power locking % (`0..100`, default `46`) */
  readonly exitPowerLockPct?: number;
  /** Base Belleville + hydraulic clutch-pack preload (Nm, default `75`) */
  readonly preloadNm?: number;
  /** Silicone viscous shear damping gain (Nm per rad/s of wheel speed delta, default `14.5`) */
  readonly viscousGainNmsPerRad?: number;
}

export interface Lc26DiffStepOutput {
  readonly activePhase: 'ENTRY' | 'MID' | 'EXIT';
  readonly entryWeight01: number;
  readonly midWeight01: number;
  readonly exitWeight01: number;
  readonly effectiveLockFraction01: number;
  readonly clutchPackLockTorqueNm: number;
  readonly viscousLockTorqueNm: number;
  readonly totalLockingTorqueNm: number;
  readonly rearLeftTorqueNm: number;
  readonly rearRightTorqueNm: number;
}

/**
 * Evaluates the 2026 3-Phase electro-hydraulic clutch-pack + viscous differential:
 *  - `ENTRY`: brake / trail-brake turn-in stability map (`entryLockPct`)
 *  - `MID`: apex coast / light maintenance throttle with steering angle (`midCoastLockPct`)
 *  - `EXIT`: corner-exit power traction & `>= 255 km/h` straight-line stability (`exitPowerLockPct`)
 */
export function solveLc26Differential(input: Lc26DiffStepInput): Lc26DiffStepOutput {
  const entryLock01 = clamp((input.entryLockPct ?? 28) / 100, 0, 1);
  const midLock01 = clamp((input.midCoastLockPct ?? 18) / 100, 0, 1);
  const exitLock01 = clamp((input.exitPowerLockPct ?? 46) / 100, 0, 1);
  const preloadNm = Math.max(0, input.preloadNm ?? 75);
  const viscousGain = Math.max(0, input.viscousGainNmsPerRad ?? 14.5);

  const steerDegApprox = Math.abs(clamp(input.steeringNormalized, -1, 1)) * 18.75;
  const turnedIn01 = smoothstep01(steerDegApprox, 1.0, 6.0);
  const brakeW = smoothstep01(clamp(input.brakePedal01, 0, 1), 0.02, 0.22);
  const powerW = smoothstep01(clamp(input.throttlePedal01, 0, 1), 0.12, 0.42);
  const hiSpdW =
    input.speedKmh < 1 ? 1 : smoothstep01(Math.max(0, input.speedKmh), 235, 275);

  let entryWeight01 = brakeW * (1 - 0.55 * turnedIn01 * (1 - brakeW)) * (1 - hiSpdW);
  let exitWeight01 = Math.max(
    powerW * (1 - 0.55 * turnedIn01 * (1 - powerW)) * (1 - brakeW),
    hiSpdW * (1 - brakeW),
  );
  const sumEW = entryWeight01 + exitWeight01;
  if (sumEW > 1) {
    entryWeight01 /= sumEW;
    exitWeight01 /= sumEW;
  }
  const midWeight01 = Math.max(0, 1 - entryWeight01 - exitWeight01);

  const effectiveLockFraction01 =
    entryWeight01 * entryLock01 + midWeight01 * midLock01 + exitWeight01 * exitLock01;

  const activePhase: 'ENTRY' | 'MID' | 'EXIT' =
    entryWeight01 >= exitWeight01 && entryWeight01 >= midWeight01
      ? 'ENTRY'
      : exitWeight01 >= midWeight01
        ? 'EXIT'
        : 'MID';

  const deltaOmega = input.rearLeftWheelOmegaRadS - input.rearRightWheelOmegaRadS;
  const clutchPackLockTorqueNm =
    preloadNm + Math.abs(input.ringGearTorqueNm) * effectiveLockFraction01;
  const viscousLockTorqueNm = Math.abs(deltaOmega) * viscousGain;
  const maxTotalLockNm = clutchPackLockTorqueNm + viscousLockTorqueNm;

  // Smooth tanh saturation across small wheel-speed differences prevents chattering sign flips
  const slipSign = Math.tanh(deltaOmega / 0.35);
  const signedTransferNm = 0.5 * maxTotalLockNm * slipSign;

  const halfRingNm = 0.5 * input.ringGearTorqueNm;
  // Faster-spinning wheel yields torque to the slower-spinning gripping wheel
  const rearLeftTorqueNm = halfRingNm - signedTransferNm;
  const rearRightTorqueNm = halfRingNm + signedTransferNm;

  return {
    activePhase,
    entryWeight01,
    midWeight01,
    exitWeight01,
    effectiveLockFraction01,
    clutchPackLockTorqueNm,
    viscousLockTorqueNm,
    totalLockingTorqueNm: maxTotalLockNm,
    rearLeftTorqueNm,
    rearRightTorqueNm,
  };
}

// ---------------------------------------------------------------------------
// 5. F12026CarConfig Clean-Room Data Structures (`VehiclePhysics` Compatible)
// ---------------------------------------------------------------------------

export const LC26_TURBO_DATA: TurboData = {
  // Steady-state torque boost multiplier: (1 + 1.55) scales naturally aspirated base to full 4.76 barA boost
  maxBoost: 1.55,
  referenceRpm: 6900,
  gamma: 1.65,
  // MGU-H-free physical rotor lag (~0.34 s at 7,000 RPM without anti-lag; faster at 11k RPM)
  spoolUpS: 0.34,
  spoolRefRpm: 7000,
  spoolDownS: 0.28,
  // 1.0 barA atmospheric + 3.76 bar gauge = 4.76 barA (< 4.80 barA FIA C5.3.2 limit)
  displayMaxBoostBar: 3.76,
};

export const LC26_ENGINE_DATA: EngineData = {
  powerCurve: buildCleanRoomIcePowerLut(),
  coastCurve: buildCleanRoomIceCoastLut(),
  throttleResponseCurve: buildCleanRoomThrottleResponseLut(),
  torqueResponseS: { rise: 0.018, fall: 0.014 },
  wetPedalMap: true,
  turbo: LC26_TURBO_DATA,
  idleRpm: LC26_FIA_POWERTRAIN_LIMITS.idleRpm, // 3800 RPM
  inertia: 0.094, // Low-inertia V6 crank + MGU-K rotor reflected to crankshaft (kg·m²)
  limiterCutS: 0.024,
  airDensitySensitivity: 0.08,
};

export const LC26_ERS_DATA: ERSData = {
  torqueLut: buildCleanRoomMgukTorqueLut(),
  coastLut: buildCleanRoomMgukTorqueLut(),
  ERS_MAX_DEPLOY: LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw * 1000, // 350,000 W
  maxHarvestW: LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw * 1000, // 350,000 W
  ERS_MAX_CHARGE: LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ, // 4,000,000 J (4.0 MJ)
  deployPerLapJ: LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ, // 4,000,000 J (+0.5 MJ Overtake = 4.5 MJ)
  harvestPerLapJ: LC26_FIA_POWERTRAIN_LIMITS.maxHarvestPerLapStandardJ, // 8,500,000 J (8.5 MJ)
  deployEfficiency: 0.97,
  harvestEfficiency: 0.97,
  liftThrottle: 0.18,
  topGearLiftHarvestW: 290_000,
  deployVsGear: [
    [0, 0.0],
    [1, 0.45],
    [2, 0.72],
    [3, 0.92],
    [4, 1.0],
    [5, 1.0],
    [6, 1.0],
    [7, 1.0],
    [8, 1.0],
  ],
};

export const LC26_PERFORMANCE_MODES: Record<PerformanceModeName, PerformanceModeData> = {
  PSH: {
    performance_mode_name: 'PSH',
    deployFraction: 1.0,
    deployVsSpeed: buildStandardDeployVsSpeedLut(1.0),
    socFloor: 0.02,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 0.85,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1.0,
    ebbOffset: 0,
  },
  RAC: {
    performance_mode_name: 'RAC',
    deployFraction: 0.94,
    deployVsSpeed: buildStandardDeployVsSpeedLut(1.0),
    socFloor: 0.1,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 1.0,
    topGearClipHarvestW: 260_000, // 260 kW end-of-straight Super Clipping
    partThrottleHarvestW: 0,
    coastTorqueScale: 1.0,
    ebbOffset: 0,
  },
  BAL: {
    performance_mode_name: 'BAL',
    deployFraction: 0.8,
    deployVsSpeed: buildStandardDeployVsSpeedLut(0.95),
    socFloor: 0.16,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 1.0,
    topGearClipHarvestW: 285_000, // 285 kW Super Clipping
    partThrottleHarvestW: 35_000,
    coastTorqueScale: 1.0,
    ebbOffset: 0,
  },
  LIC: {
    performance_mode_name: 'LIC',
    deployFraction: 0.58,
    deployVsSpeed: buildStandardDeployVsSpeedLut(0.85),
    socFloor: 0.24,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 1.0,
    topGearClipHarvestW: 315_000, // 315 kW Super Clipping
    partThrottleHarvestW: 70_000,
    coastTorqueScale: 0.92,
    ebbOffset: -1,
  },
  CHR: {
    performance_mode_name: 'CHR',
    deployFraction: 0.22,
    deployVsSpeed: buildStandardDeployVsSpeedLut(0.65),
    socFloor: 0.35,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 1.0,
    topGearClipHarvestW: 350_000, // 350 kW max legal Super Clipping
    partThrottleHarvestW: 120_000,
    coastTorqueScale: 1.05,
    ebbOffset: -1,
  },
};

/**
 * Clean-room 8-speed seamless sequential gearbox (`28 ms` upshift cut, strict over-rev guard).
 * Calibrated for narrowed 375/710-R18 rear tyres (`R = 0.355 m`) so 7th & 8th gears hold the
 * 1.6L V6 strictly above the `10,500 RPM` `3000 MJ/h` fuel-flow knee up to `355 km/h`.
 */
export const LC26_GEARBOX_DATA: GearBoxData = {
  ratios: [4.08, 3.16, 2.54, 2.1, 1.775, 1.53, 1.35, 1.22],
  reverse: 3.85,
  finalDrive: 3.65,
  shiftTimeS: 0.028, // Exact 28 ms seamless zeroshift overlap
  downshiftTimeS: 0.036,
  shiftTorqueFraction: 0.92,
  upshiftCutS: 0.028,
  downshift: {
    neutralS: 0.012,
    clutchReleaseS: 0.012,
    clutchHomeS: 0.036,
    blip: { level: 0.68, riseS: 0.01 },
    overRevRpm: -200, // Refuses any downshift that would land > 12,000 RPM (200 RPM below 12,200 limiter)
  },
  efficiency: 0.98,
  gears: {
    redline_rpm: LC26_FIA_POWERTRAIN_LIMITS.revLimitRpm, // 12,200 RPM
    upshift_rpm: 11850, // Inside optimal 11,600..12,200 RPM shift window
    downshift_rpm: 9400,
    brake_downshift_rpm: 10650,
    spin_upshift: false,
  },
};

export const LC26_CLUTCH_DATA: ClutchData = {
  maxTorqueNm: 1180,
  biteRpm: 4150,
  lockRpm: 5350,
  launchRpm: 7500, // 7,500 RPM grid launch target
};

export const LC26_DIFFERENTIAL_DATA: DifferentialData = {
  type: 'LSD_Ramp',
  settings: {
    power: 0.42,
    coast: 0.24,
    preload: 75,
    friction_faces: 8,
    power_ramp_deg: 48,
    coast_ramp_deg: 62,
  },
  halfshaft: {
    stiffnessNmPerRad: 13800,
    dampingNmsPerRad: 96,
  },
  coastBraking: 0.28,
  threePhase: true,
  diffEntryLevel: 4, // ~27.3% Entry lock
  diffMidLevel: 3, // ~18.2% Mid-corner lock
  diffExitLevel: 6, // ~45.5% Exit/HiSpd lock
  hiSpdSwitchKmh: 255,
};

export const LC26_BRAKES_DATA: BrakesData = {
  maxTorqueNm: DEFAULT_LC26_BBW_PARAMS.maxWheelPairTorqueNm, // 8400 Nm pair-equivalent (16,800 Nm total)
  brakeByWire: true,
  front_bias: 0.56,
  ebbStep: 0.005,
  discMaterial: 'carbon-ceramic',
  discStartTempC: 380,
  migration: {
    amount: 0.025,
    rampStart: 0.05,
  },
};

/** Factory creating a calibrated `Lc26PowertrainModule` instance */
export function createLc26PowertrainModule(options?: {
  ersCalibration?: Partial<Lc26ErsCalibrationParams>;
  bbwCalibration?: Partial<Lc26BbwCalibrationParams>;
}): Lc26PowertrainModule {
  const ersCal: Lc26ErsCalibrationParams = {
    ...DEFAULT_LC26_ERS_CALIBRATION,
    ...options?.ersCalibration,
  };
  const bbwCal: Lc26BbwCalibrationParams = {
    ...DEFAULT_LC26_BBW_PARAMS,
    ...options?.bbwCalibration,
  };

  return {
    engine: LC26_ENGINE_DATA,
    turbo: LC26_TURBO_DATA,
    ers: {
      ...LC26_ERS_DATA,
      ERS_MAX_DEPLOY: ersCal.maxPowerKw * 1000,
      maxHarvestW: ersCal.maxPowerKw * 1000,
      ERS_MAX_CHARGE: ersCal.usableBatteryWindowJ,
      deployPerLapJ: ersCal.standardLapDeployWindowJ,
      harvestPerLapJ: ersCal.standardLapHarvestLimitJ,
      deployEfficiency: ersCal.deployEfficiency,
      harvestEfficiency: ersCal.harvestEfficiency,
    },
    gearbox: LC26_GEARBOX_DATA,
    clutch: LC26_CLUTCH_DATA,
    differential: LC26_DIFFERENTIAL_DATA,
    brakes: {
      ...LC26_BRAKES_DATA,
      maxTorqueNm: bbwCal.maxWheelPairTorqueNm,
    },
    computeFiaMgukPowerCapKw(speedKmh: number, overtakeModeActive: boolean): number {
      return computeLc26FiaMgukPowerCapKw(speedKmh, overtakeModeActive, ersCal);
    },
    computeFiaFuelFlowCap(rpm: number): { maxEnergyMjH: number; maxMassKgS: number } {
      return computeLc26FiaFuelFlowCap(rpm);
    },
    solveBrakeByWire(
      brakePedal01: number,
      speedKmh: number,
      rpm: number,
      soc01: number,
      lapHarvestedJ: number,
      baseFrontBias01: number,
      migrationRamp01: number,
    ): Lc26BbwSplitResult {
      return solveLc26BrakeByWire(
        brakePedal01,
        speedKmh,
        rpm,
        soc01,
        lapHarvestedJ,
        baseFrontBias01,
        migrationRamp01,
        false,
        bbwCal,
        ersCal,
      );
    },
  };
}

/** Canonical clean-room VeloSoft LC-26 Powertrain Module */
export const LC26_POWERTRAIN_MODULE: Lc26PowertrainModule = createLc26PowertrainModule();

// ---------------------------------------------------------------------------
// 6. Full Stateful 500 Hz ECU, Turbo, ERS, Super-Clipping, BBW & Gearbox Controller
// ---------------------------------------------------------------------------

export interface Lc26EcuState {
  readonly rpm: number;
  readonly crankOmegaRadS: number;
  readonly gear: number; // -1 = Reverse, 0 = Neutral, 1..8 = Forward gears
  readonly shiftTimerS: number;
  readonly sinceUpshiftS: number;
  readonly sinceDownshiftS: number;
  readonly pendingShift: -1 | 0 | 1;
  readonly prevShiftUpPressed: boolean;
  readonly prevShiftDownPressed: boolean;
  readonly throttlePlate01: number;
  readonly limiterTimerS: number;
  /** Physical turbocharger shaft angular velocity (rad/s) */
  readonly turboShaftRadS: number;
  /** Intake plenum absolute boost pressure (barA, 1.013..4.80) */
  readonly boostPressureBarA: number;
  /** Electronic wastegate valve position (0 = closed / max spool, 1 = open / bypass) */
  readonly wastegateOpen01: number;
  /** Remaining sustainable fuel mass on board, strictly in kg */
  readonly fuelMassKg: number;
  readonly fuelConsumedKg: number;
  /** Stored usable electrical energy in ES (J, 0..4,000,000 or 4,500,000 when extended) */
  readonly batteryEnergyJ: number;
  readonly soc01: number;
  readonly lapDeployedJ: number;
  readonly lapHarvestedJ: number;
  /** Overtake Mode armed at detection point (`< 1.0 s` behind car ahead) */
  readonly overtakeArmed: boolean;
  readonly overtakeModeActive: boolean;
  readonly prevTrackProgress01: number;
  /** Current slewed MGU-K mechanical shaft power command (kW: + deploy, - harvest) */
  readonly slewedMgukPowerKw: number;
  /** Latched true once ECU Super Clipping initiates on a straight until throttle lift or Boost */
  readonly superClippingActive: boolean;
  /** 5.0-second grid launch rev-hold anti-lag state */
  readonly launchHoldActive: boolean;
  readonly launchHoldTimerS: number;
  readonly launchTimeoutTripped: boolean;
  readonly standingStartActive: boolean;
}

export interface Lc26EcuStepInput {
  readonly dtS: number; // Nominal 0.002 s (500 Hz)
  readonly throttlePedal01: number;
  readonly brakePedal01: number;
  /** Clutch paddle 0..1 (`0` = fully engaged rest, `1` = fully disengaged pulled) */
  readonly clutchPedal01?: number;
  readonly steeringNormalized?: number;
  readonly speedKmh: number;
  readonly rearLeftWheelOmegaRadS?: number;
  readonly rearRightWheelOmegaRadS?: number;
  /** Edge or pulse shift inputs */
  readonly shiftUp?: boolean;
  readonly shiftDown?: boolean;
  /** Dedicated steering-wheel Neutral (`N`) / Reverse (`R`) safety button */
  readonly neutralButtonActive?: boolean;
  readonly reverseButtonActive?: boolean;
  /** Grid launch anti-lag hold button */
  readonly launchButtonActive?: boolean;
  /** Driver ERS deploy mode (`PSH` | `RAC` | `BAL` | `LIC` | `CHR` | `OVERTAKE`) */
  readonly deployMode?: Lc26ErsDeployMode;
  /** Driver-actuated Overtake activation toggle (uses armed Overtake grant) */
  readonly overtakeButtonActive?: boolean;
  /** Driver-actuated Boost / Anti-Clip manual override button */
  readonly boostButtonActive?: boolean;
  /** Overtake detection-point inputs */
  readonly trackProgress01?: number;
  readonly detectionZoneProgress01?: number;
  readonly detectionPointCrossed?: boolean;
  readonly lapCompleted?: boolean;
  readonly gapAheadSeconds?: number | null;
  /** ECU Super Clipping configuration (`250..350 kW` ceiling & SoC target) */
  readonly superClipCeilingKw?: number;
  readonly superClipTargetSoc01?: number;
  readonly forceSuperClip?: boolean;
  /** Brake-by-wire & differential setup parameters */
  readonly baseFrontBrakeBias01?: number;
  readonly brakeMigrationPct?: number;
  readonly diffEntryLockPct?: number;
  readonly diffMidCoastLockPct?: number;
  readonly diffExitPowerLockPct?: number;
  readonly diffPreloadNm?: number;
  readonly engineBrakingLevel?: number;
  readonly autoGearbox?: boolean;
  /** If true, crank RPM tracks driven wheels through gearbox when clutch engaged; otherwise integrates free crank */
  readonly externalRpmOverride?: number;
}

export interface Lc26EcuStepOutput {
  readonly state: Lc26EcuState;
  readonly telemetry: Lc26PowertrainTelemetry;
  readonly bbw: Lc26BbwSplitResult;
  readonly differential: Lc26DiffStepOutput;
  /** Driver throttle pedal passed straight through to Active Aero (`1.0` during Super Clipping -> Straight Mode stays OPEN!) */
  readonly passthroughThrottlePedal01: number;
  readonly steadyBoostedIceTorqueNm: number;
  readonly turboLagDeficitNm: number;
  readonly antiLagTorqueFillNm: number;
  readonly netCrankTorqueNm: number;
  readonly rearAxleDriveTorqueNm: number;
  readonly clutchEngagement01: number;
  readonly downshiftRejectedOverRev: boolean;
  readonly neutralReverseInterlockBlocked: boolean;
  readonly activeDeployCeilingJ: number;
  readonly activeHarvestCeilingJ: number;
}

export function createInitialLc26EcuState(options?: {
  initialFuelKg?: number;
  initialSoc01?: number;
  initialGear?: number;
  initialRpm?: number;
  standingStart?: boolean;
}): Lc26EcuState {
  const soc01 = clamp(options?.initialSoc01 ?? 1.0, 0, 1);
  const rpm = Math.max(LC26_FIA_POWERTRAIN_LIMITS.idleRpm, options?.initialRpm ?? LC26_FIA_POWERTRAIN_LIMITS.idleRpm);
  return {
    rpm,
    crankOmegaRadS: rpm * RPM_TO_RADS,
    gear: clamp(Math.round(options?.initialGear ?? 1), -1, LC26_FIA_POWERTRAIN_LIMITS.forwardGears),
    shiftTimerS: 0,
    sinceUpshiftS: 10,
    sinceDownshiftS: 10,
    pendingShift: 0,
    prevShiftUpPressed: false,
    prevShiftDownPressed: false,
    throttlePlate01: 0,
    limiterTimerS: 0,
    turboShaftRadS: DEFAULT_LC26_TURBO_PARAMS.idleShaftRadS,
    boostPressureBarA: DEFAULT_LC26_TURBO_PARAMS.ambientPressureBarA,
    wastegateOpen01: 0,
    fuelMassKg: clamp(options?.initialFuelKg ?? 98.0, 0, 100.0),
    fuelConsumedKg: 0,
    batteryEnergyJ: soc01 * LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ,
    soc01,
    lapDeployedJ: 0,
    lapHarvestedJ: 0,
    overtakeArmed: false,
    overtakeModeActive: false,
    prevTrackProgress01: Number.NaN,
    slewedMgukPowerKw: 0,
    superClippingActive: false,
    launchHoldActive: false,
    launchHoldTimerS: 0,
    launchTimeoutTripped: false,
    standingStartActive: options?.standingStart ?? false,
  };
}

/** Checks whether forward progress `prev -> curr` crossed `marker` in `[0, 1)` */
function didCrossMarkerForward(prev: number, curr: number, marker: number): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || !Number.isFinite(marker)) return false;
  let step = curr - prev;
  if (step > 0.5) step -= 1;
  else if (step < -0.5) step += 1;
  if (!(step > 0 && step < 0.1)) return false;
  const distToMarker = (((marker - prev) % 1) + 1) % 1;
  return distToMarker > 0 && distToMarker <= step;
}

/** Total crank-to-axle gear ratio (`0` in Neutral, negative in Reverse) */
export function getLc26TotalGearRatio(gear: number, gb: GearBoxData = LC26_GEARBOX_DATA): number {
  if (gear >= 1 && gear <= gb.ratios.length) {
    return gb.ratios[gear - 1] * gb.finalDrive;
  }
  if (gear === -1) {
    return -gb.reverse * gb.finalDrive;
  }
  return 0;
}

/** Road-coupled crankshaft RPM in `gear` at `speedKmh` */
export function computeLc26RoadCoupledRpm(
  gear: number,
  speedKmh: number,
  rearRadiusM = DEFAULT_LC26_BBW_PARAMS.rearEffectiveRadiusM,
  gb: GearBoxData = LC26_GEARBOX_DATA,
): number {
  const ratio = Math.abs(getLc26TotalGearRatio(gear, gb));
  if (ratio === 0) return 0;
  const wheelOmega = Math.abs(speedKmh / 3.6) / Math.max(0.2, rearRadiusM);
  return wheelOmega * ratio * RADS_TO_RPM;
}

/**
 * Pure 500 Hz step of the VeloSoft LC-26 Power Unit, ERS, Super Clipping, BBW & 8-Speed Gearbox ECU.
 */
export function stepLc26Ecu(
  prev: Lc26EcuState,
  input: Lc26EcuStepInput,
  ersCal: Lc26ErsCalibrationParams = DEFAULT_LC26_ERS_CALIBRATION,
  turboParams: Lc26TurboPhysicsParams = DEFAULT_LC26_TURBO_PARAMS,
  bbwParams: Lc26BbwCalibrationParams = DEFAULT_LC26_BBW_PARAMS,
): Lc26EcuStepOutput {
  const dt = clamp(input.dtS, 1e-5, 0.05);
  const throttlePedal01 = clamp(input.throttlePedal01, 0, 1);
  const brakePedal01 = clamp(input.brakePedal01, 0, 1);
  const clutchPedal01 =
    input.clutchPedal01 !== undefined ? clamp(input.clutchPedal01, 0, 1) : undefined;
  const speedKmh = Number.isFinite(input.speedKmh) ? input.speedKmh : 0;
  const absSpeedKmh = Math.abs(speedKmh);

  // ---- 1. Lap Reset & Overtake Mode Detection-Point Arming (< 1.0 s gap ahead) ----
  let lapDeployedJ = prev.lapDeployedJ;
  let lapHarvestedJ = prev.lapHarvestedJ;
  let overtakeArmed = prev.overtakeArmed;
  const currProgress = input.trackProgress01 ?? Number.NaN;

  const crossedStartFinish =
    Boolean(input.lapCompleted) ||
    (Number.isFinite(prev.prevTrackProgress01) &&
      Number.isFinite(currProgress) &&
      prev.prevTrackProgress01 > 0.9 &&
      currProgress < 0.1);
  if (crossedStartFinish) {
    lapDeployedJ = 0;
    lapHarvestedJ = 0;
  }

  const detectionMarker = input.detectionZoneProgress01 ?? 0.88;
  const crossedDetection =
    Boolean(input.detectionPointCrossed) ||
    didCrossMarkerForward(prev.prevTrackProgress01, currProgress, detectionMarker);
  if (crossedDetection) {
    const gap = input.gapAheadSeconds;
    overtakeArmed =
      gap !== undefined && gap !== null && Number.isFinite(gap) && gap >= 0 && gap < ersCal.overtakeDetectionGapS;
  }

  const deployMode: Lc26ErsDeployMode = input.deployMode ?? 'RAC';
  const overtakeRequested = Boolean(input.overtakeButtonActive) || deployMode === 'OVERTAKE';
  const overtakeModeActive = overtakeArmed && overtakeRequested;

  const activeDeployCeilingJ =
    ersCal.standardLapDeployWindowJ + (overtakeArmed ? ersCal.overtakeExtraEnergyJ : 0);
  const activeHarvestCeilingJ =
    ersCal.standardLapHarvestLimitJ + (overtakeArmed ? ersCal.overtakeExtraEnergyJ : 0);

  // ---- 2. 8-Speed Seamless Gearbox, Over-Rev Protection & Button N/R Interlock ----
  const gb = LC26_GEARBOX_DATA;
  let gear = prev.gear;
  let shiftTimerS = Math.max(0, prev.shiftTimerS - dt);
  let sinceUpshiftS = prev.sinceUpshiftS + dt;
  let sinceDownshiftS = prev.sinceDownshiftS + dt;
  let pendingShift = prev.pendingShift;
  let downshiftRejectedOverRev = false;
  let neutralReverseInterlockBlocked = false;

  const shiftUpEdge = Boolean(input.shiftUp) && !prev.prevShiftUpPressed;
  const shiftDownEdge = Boolean(input.shiftDown) && !prev.prevShiftDownPressed;

  const attemptGearChange = (targetGear: number, viaPaddleDir: -1 | 0 | 1): boolean => {
    const clampedTarget = clamp(Math.round(targetGear), -1, gb.ratios.length);
    if (clampedTarget === gear) return false;

    // Neutral (0) & Reverse (-1) safety interlock:
    // Downshift paddle from 1st NEVER drops into N or R without explicit button + low speed/brake!
    if (clampedTarget === 0) {
      const allowedNeutral =
        gear === -1 || (Boolean(input.neutralButtonActive) && absSpeedKmh <= 5.0);
      if (!allowedNeutral) {
        neutralReverseInterlockBlocked = true;
        return false;
      }
    } else if (clampedTarget === -1) {
      const hasReverseAuth =
        Boolean(input.reverseButtonActive) || (Boolean(input.neutralButtonActive) && gear === 0);
      const allowedReverse = hasReverseAuth && absSpeedKmh <= 3.0 && brakePedal01 >= 0.15;
      if (!allowedReverse) {
        neutralReverseInterlockBlocked = true;
        return false;
      }
    }

    // Strict over-rev downshift protection (refuses shift if target gear exceeds 12,000 RPM)
    if (clampedTarget >= 1 && gear >= 2 && clampedTarget < gear) {
      const targetRoadRpm = computeLc26RoadCoupledRpm(
        clampedTarget,
        absSpeedKmh,
        bbwParams.rearEffectiveRadiusM,
        gb,
      );
      const maxAllowedLandRpm = gb.gears.redline_rpm + (gb.downshift?.overRevRpm ?? -200);
      if (targetRoadRpm > maxAllowedLandRpm) {
        downshiftRejectedOverRev = true;
        return false;
      }
    }

    const isUpshift = clampedTarget > gear && clampedTarget >= 1 && gear >= 1;
    const isDownshift = clampedTarget >= 1 && gear >= 2 && clampedTarget < gear;
    gear = clampedTarget;
    if (isUpshift) {
      shiftTimerS = gb.shiftTimeS; // 28 ms seamless shift
      sinceUpshiftS = 0;
    } else if (isDownshift) {
      shiftTimerS = gb.downshiftTimeS ?? gb.shiftTimeS;
      sinceDownshiftS = 0;
    } else if (viaPaddleDir !== 0) {
      shiftTimerS = gb.shiftTimeS;
    }
    return true;
  };

  // Explicit Neutral / Reverse button requests
  if (input.reverseButtonActive && gear !== -1) {
    attemptGearChange(-1, -1);
  } else if (input.neutralButtonActive && !shiftDownEdge && gear > 0) {
    attemptGearChange(0, 0);
  }

  // Sequential paddle handling with pending-shift queue during active 28 ms shift
  if (shiftUpEdge) {
    if (shiftTimerS > 0) {
      pendingShift = 1;
    } else {
      const nextG = gear === -1 ? (input.neutralButtonActive ? 0 : 1) : gear + 1;
      attemptGearChange(nextG, 1);
    }
  } else if (shiftDownEdge) {
    if (shiftTimerS > 0) {
      pendingShift = -1;
    } else if (gear === 1) {
      // Standard downshift paddle in 1st stays in 1st unless N/R button is held
      if (input.reverseButtonActive) {
        attemptGearChange(-1, -1);
      } else if (input.neutralButtonActive) {
        attemptGearChange(0, -1);
      } else {
        neutralReverseInterlockBlocked = true;
      }
    } else if (gear === 0 && (input.reverseButtonActive || input.neutralButtonActive)) {
      attemptGearChange(-1, -1);
    } else if (gear >= 2) {
      attemptGearChange(gear - 1, -1);
    }
  } else if (pendingShift !== 0 && shiftTimerS <= 0) {
    const dir = pendingShift;
    pendingShift = 0;
    const nextG = dir > 0 ? (gear === -1 ? 1 : gear + 1) : gear - 1;
    if (dir < 0 && gear === 1) {
      neutralReverseInterlockBlocked = true;
    } else {
      attemptGearChange(nextG, dir);
    }
  }

  // Optional automatic shift schedule
  if (input.autoGearbox && shiftTimerS <= 0 && gear >= 1) {
    const currentRoadRpm = computeLc26RoadCoupledRpm(gear, absSpeedKmh, bbwParams.rearEffectiveRadiusM, gb);
    if (gear < gb.ratios.length && currentRoadRpm >= gb.gears.upshift_rpm && brakePedal01 < 0.1) {
      attemptGearChange(gear + 1, 1);
    } else if (gear > 1) {
      const downThresh = brakePedal01 >= 0.25 ? (gb.gears.brake_downshift_rpm ?? gb.gears.downshift_rpm) : gb.gears.downshift_rpm;
      const lowerRoadRpm = computeLc26RoadCoupledRpm(gear - 1, absSpeedKmh, bbwParams.rearEffectiveRadiusM, gb);
      if (currentRoadRpm < gb.gears.downshift_rpm || (brakePedal01 >= 0.25 && lowerRoadRpm < downThresh)) {
        attemptGearChange(gear - 1, -1);
      }
    }
  }

  // ---- 3. 5-Second Grid Launch Rev-Hold Anti-Lag (~7,500 RPM + Pre-Boost) ----
  const stationaryForLaunch = absSpeedKmh < 2.0 && (gear === 1 || gear === 0);
  const launchClutchHeld = Boolean(input.launchButtonActive) || (clutchPedal01 !== undefined && clutchPedal01 >= 0.85);
  const driverRequestsLaunchHold = stationaryForLaunch && launchClutchHeld && throttlePedal01 >= 0.45;

  let launchHoldTimerS = prev.launchHoldTimerS;
  let launchTimeoutTripped = prev.launchTimeoutTripped;
  let launchHoldActive = false;
  let standingStartActive = prev.standingStartActive;

  if (driverRequestsLaunchHold) {
    standingStartActive = true;
    if (!launchTimeoutTripped) {
      launchHoldTimerS += dt;
      if (launchHoldTimerS > 5.0) {
        // 5.0 s thermal/valve/clutch timeout protection trips!
        launchTimeoutTripped = true;
        launchHoldActive = false;
      } else {
        launchHoldActive = true;
      }
    }
  } else {
    if (!launchClutchHeld && throttlePedal01 < 0.2) {
      launchHoldTimerS = 0;
      launchTimeoutTripped = false;
    } else if (!stationaryForLaunch) {
      launchHoldTimerS = 0;
      launchTimeoutTripped = false;
    }
  }

  if (absSpeedKmh >= ersCal.standingStartMgukMinSpeedKmh + 5) {
    standingStartActive = false;
  }

  // ---- 4. Clutch Engagement & Crankshaft Speed Resolution ----
  const wheelOmegaMean =
    input.rearLeftWheelOmegaRadS !== undefined && input.rearRightWheelOmegaRadS !== undefined
      ? 0.5 * (input.rearLeftWheelOmegaRadS + input.rearRightWheelOmegaRadS)
      : (speedKmh / 3.6) / bbwParams.rearEffectiveRadiusM;
  const totalRatio = getLc26TotalGearRatio(gear, gb);
  const roadCoupledRpm = Math.abs(wheelOmegaMean * totalRatio) * RADS_TO_RPM;

  let clutchEngagement01 = 0;
  if (gear !== 0) {
    if (clutchPedal01 !== undefined) {
      clutchEngagement01 = clamp(1 - clutchPedal01, 0, 1);
    } else {
      // Auto-clutch with 7,500 RPM 1st-gear launch bite window & anti-stall
      const cl = LC26_CLUTCH_DATA;
      let bite = cl.biteRpm;
      if (Math.abs(gear) === 1 && cl.launchRpm !== undefined) {
        bite += clamp((throttlePedal01 - 0.2) / 0.6, 0, 1) * Math.max(0, cl.launchRpm - cl.lockRpm);
      }
      const lock = bite + (cl.lockRpm - cl.biteRpm);
      clutchEngagement01 = roadCoupledRpm >= lock ? 1 : smoothstep01(prev.rpm, bite, lock);
      if (roadCoupledRpm < LC26_ENGINE_DATA.idleRpm) {
        const pedalGate = clamp(throttlePedal01 / 0.05, 0, 1);
        const rollGate = smoothstep01(roadCoupledRpm, 0.7 * LC26_ENGINE_DATA.idleRpm, LC26_ENGINE_DATA.idleRpm);
        clutchEngagement01 *= Math.max(pedalGate, rollGate);
      }
    }
    if (launchHoldActive || launchTimeoutTripped && stationaryForLaunch && launchClutchHeld) {
      clutchEngagement01 = 0;
    }
  }

  // Preliminary RPM prior to combustion integration (seamless shift snaps crank omega to next gear)
  let rpm = prev.rpm;
  if (input.externalRpmOverride !== undefined && Number.isFinite(input.externalRpmOverride)) {
    rpm = clamp(input.externalRpmOverride, 0, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  } else if (sinceUpshiftS === 0 && gear >= 2 && clutchEngagement01 > 0.5) {
    const prevRatio = gb.ratios[gear - 2];
    const newRatio = gb.ratios[gear - 1];
    rpm = clamp(prev.rpm * (newRatio / prevRatio), LC26_ENGINE_DATA.idleRpm, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  }

  // ---- 5. Throttle Air-Path, Physical Turbocharger Shaft ODE & Electronic Wastegate ----
  let limiterTimerS = Math.max(0, prev.limiterTimerS - dt);
  if (rpm >= gb.gears.redline_rpm) {
    limiterTimerS = LC26_ENGINE_DATA.limiterCutS;
  }

  // Progressive drive-by-wire throttle plate target
  let targetPlate01 =
    throttlePedal01 <= 0
      ? 0
      : throttlePedal01 >= 1
        ? 1
        : 0.82 * Math.pow(throttlePedal01, 1.18) + 0.18 * throttlePedal01;

  if (launchTimeoutTripped && stationaryForLaunch) {
    // Limp idle protection after > 5.0 s launch hold timeout
    targetPlate01 = clamp((4000 - rpm) / 600, 0, 0.14);
  } else if (launchHoldActive) {
    // Active 7,500 RPM launch hold: high airflow + retarded spark feeds exhaust turbine!
    targetPlate01 = Math.max(0.72, targetPlate01);
  }

  // Auto-blip on downshift while synchronizing
  const downshiftSyncing =
    gb.downshift !== undefined && sinceDownshiftS < gb.downshift.clutchHomeS && sinceDownshiftS < sinceUpshiftS;
  if (downshiftSyncing && gb.downshift?.blip && rpm < roadCoupledRpm) {
    targetPlate01 = Math.max(targetPlate01, gb.downshift.blip.level);
  }

  const airTauS =
    (targetPlate01 > prev.throttlePlate01 ? 0.018 : 0.014) +
    60 / Math.max(rpm, LC26_ENGINE_DATA.idleRpm);
  const throttlePlate01 = clamp(
    prev.throttlePlate01 + (targetPlate01 - prev.throttlePlate01) * Math.min(1, dt / airTauS),
    0,
    1,
  );

  // Physical turbocharger shaft rotational dynamics (rad/s) — NO MGU-H motor torque!
  const targetBoostBarA = launchHoldActive
    ? turboParams.launchPreBoostBarA
    : launchTimeoutTripped && stationaryForLaunch
      ? turboParams.ambientPressureBarA
      : evaluateTargetPlenumBoostBarA(Math.max(rpm, LC26_ENGINE_DATA.idleRpm), throttlePlate01, turboParams);

  const maxGaugeBar = turboParams.maxRegulatedBoostBarA - turboParams.ambientPressureBarA;
  const desiredBoostNorm01 = clamp(
    (targetBoostBarA - turboParams.ambientPressureBarA) / Math.max(1e-6, maxGaugeBar),
    0,
    1,
  );
  const shaftSpanRadS = turboParams.maxShaftRadS - turboParams.idleShaftRadS;
  const currentShaftNorm01 = clamp(
    (prev.turboShaftRadS - turboParams.idleShaftRadS) / shaftSpanRadS,
    0,
    1.05,
  );

  // Electronic wastegate & physical turbocharger shaft ODE (rad/s) — NO MGU-H motor torque!
  // Exhaust enthalpy reaches full 4.76 barA compressor pressure ratio by ~6,750 RPM; above that,
  // the electronic wastegate opens proportionally to regulate plenum boost strictly < 4.80 barA.
  const exhaustMassFlowFactor =
    (Math.max(rpm, LC26_ENGINE_DATA.idleRpm) / 6750) *
    (launchHoldActive ? 1.15 * throttlePlate01 : throttlePlate01);

  const tcSubsteps = Math.max(1, Math.ceil(dt / 0.002));
  const subDt = dt / tcSubsteps;
  let turboShaftRadS = prev.turboShaftRadS;
  let boostPressureBarA = prev.boostPressureBarA;
  let wastegateOpen01 = 0;

  for (let s = 0; s < tcSubsteps; s++) {
    if (launchTimeoutTripped && stationaryForLaunch) {
      wastegateOpen01 = 1;
    } else if (throttlePlate01 < 0.06 && !launchHoldActive) {
      wastegateOpen01 = 1;
    } else {
      const overTargetBar = boostPressureBarA - targetBoostBarA;
      const hardGuardBar = boostPressureBarA - (turboParams.fiaHardCeilingBarA - 0.06);
      wastegateOpen01 = clamp(
        smoothstep01(overTargetBar, -0.14, 0.06) * 0.82 + smoothstep01(hardGuardBar, 0, 0.05) * 0.5,
        0,
        1,
      );
    }

    const sNorm = clamp((turboShaftRadS - turboParams.idleShaftRadS) / shaftSpanRadS, 0, 1.05);
    const tTurb = 1.95 * exhaustMassFlowFactor * (1 - 0.86 * wastegateOpen01);
    const tComp = 0.14 + 1.48 * sNorm * sNorm + (throttlePlate01 < 0.06 ? 0.22 * sNorm : 0);
    const alphaTc = (tTurb - tComp) / turboParams.shaftInertiaKgM2;
    turboShaftRadS = clamp(
      turboShaftRadS + alphaTc * subDt,
      turboParams.idleShaftRadS,
      turboParams.maxShaftRadS,
    );
    // Compressor tip-speed pressure ratio feeding intake plenum volume
    const compDeliveredBarA =
      turboParams.ambientPressureBarA +
      maxGaugeBar *
        Math.min(
          1.015,
          Math.pow(clamp((turboShaftRadS - turboParams.idleShaftRadS) / shaftSpanRadS, 0, 1.02), 1.45),
        ) *
        (launchHoldActive ? 0.86 : clamp(throttlePlate01 * 1.15, 0, 1));
    const clampedCompBarA = Math.min(
      compDeliveredBarA,
      targetBoostBarA + 0.02,
      turboParams.fiaHardCeilingBarA - 0.01,
    );
    boostPressureBarA +=
      (clampedCompBarA - boostPressureBarA) * Math.min(1, subDt / turboParams.plenumFillingTauS);
  }
  boostPressureBarA = clamp(
    boostPressureBarA,
    turboParams.ambientPressureBarA,
    turboParams.fiaHardCeilingBarA - 0.005, // Strictly < 4.80 barA FIA C5.3.2
  );
  void desiredBoostNorm01;
  void currentShaftNorm01;

  // ---- 6. ICE Torque, Turbo Lag Deficit & Sustainable Fuel Mass Consumption (kg) ----
  const idleSupport01 = clamp((LC26_ENGINE_DATA.idleRpm + 220 - rpm) / 750, 0, 0.16);
  const effectivePlate01 = Math.max(throttlePlate01, idleSupport01);
  const upshiftCutActive = gb.upshiftCutS !== undefined && sinceUpshiftS < gb.upshiftCutS;
  const hasFuel = prev.fuelMassKg > 0;

  // Launch 7,500 RPM spark-retard controller holds RPM right around ~7,500 RPM while keeping exhaust hot
  let sparkTorqueScale01 = upshiftCutActive || limiterTimerS > 0 || !hasFuel ? 0 : 1;
  if (launchHoldActive) {
    const rpmErr = 7500 - rpm;
    sparkTorqueScale01 = clamp(0.11 + rpmErr * 0.0012, 0, 0.65);
  } else if (launchTimeoutTripped && stationaryForLaunch) {
    sparkTorqueScale01 = rpm > 4150 ? 0 : 0.35;
  }

  const effectiveOmega = Math.max(100, rpm * RPM_TO_RADS);
  const fullSteadyIcePowerKw = evaluateCleanRoomIceSteadyPowerKw(rpm);
  const steadyFullBoostBarA = evaluateTargetPlenumBoostBarA(
    Math.max(rpm, LC26_ENGINE_DATA.idleRpm),
    effectivePlate01,
    turboParams,
  );
  // Actual ICE air-charge density ratio relative to steady-state boosted manifold pressure
  const boostRealization01 =
    effectivePlate01 > 0.05 && !launchHoldActive
      ? clamp(boostPressureBarA / Math.max(turboParams.ambientPressureBarA, steadyFullBoostBarA), 0.28, 1.0)
      : 1.0;

  const steadyBoostedCombustionNm =
    ((effectivePlate01 * sparkTorqueScale01 * fullSteadyIcePowerKw * 1000) / effectiveOmega) *
    (shiftTimerS > 0 && !downshiftSyncing ? gb.shiftTorqueFraction : 1);
  const realizedCombustionNm = steadyBoostedCombustionNm * boostRealization01;
  const turboLagDeficitNm = Math.max(0, steadyBoostedCombustionNm - realizedCombustionNm);

  const coastBrakingNm =
    (1 - effectivePlate01) * evaluateCleanRoomIceCoastTorqueNm(rpm, input.engineBrakingLevel ?? 5);
  const iceTorqueNm = realizedCombustionNm - coastBrakingNm;
  const icePowerKw = (iceTorqueNm * effectiveOmega) / 1000;

  // Exact FIA C5.4.3 / C5.2.3–5 sustainable fuel flow strictly tracked in kg
  const { maxEnergyMjH } = computeLc26FiaFuelFlowCap(rpm);
  let fuelEnergyFlowMjH = 0;
  if (hasFuel && !upshiftCutActive && limiterTimerS <= 0 && effectivePlate01 > 0.01) {
    const rawFuelDemandMjH = maxEnergyMjH * effectivePlate01 * boostRealization01 * (launchHoldActive ? 0.55 : 1.0);
    const partLoadCeilingMjH = launchHoldActive
      ? maxEnergyMjH
      : computeLc26PartialLoadFuelCapMjH(rpm, Math.max(0, icePowerKw));
    fuelEnergyFlowMjH = clamp(Math.min(rawFuelDemandMjH, partLoadCeilingMjH), 0, maxEnergyMjH);
  }
  const fuelMassFlowKgS =
    fuelEnergyFlowMjH / (LC26_FIA_POWERTRAIN_LIMITS.sustainableFuelLhvMjPerKg * SECONDS_PER_HOUR);
  const rawRemainingKg = prev.fuelMassKg - fuelMassFlowKgS * dt;
  const fuelMassKg = rawRemainingKg <= 1e-12 ? 0 : rawRemainingKg;
  const burnedFuelKg = prev.fuelMassKg - fuelMassKg;
  const fuelConsumedKg = prev.fuelConsumedKg + burnedFuelKg;

  // ---- 7. 350 kW MGU-K, Overtake, Boost, Super Clipping (Smooth dP/dt) & BBW ----
  const speedDerateCapKw = computeLc26FiaMgukPowerCapKw(absSpeedKmh, overtakeModeActive, ersCal);
  const bbw = solveLc26BrakeByWire(
    brakePedal01,
    absSpeedKmh,
    rpm,
    prev.soc01,
    lapHarvestedJ,
    input.baseFrontBrakeBias01 ?? LC26_BRAKES_DATA.front_bias,
    (input.brakeMigrationPct ?? 2.5) / 100,
    overtakeArmed,
    bbwParams,
    ersCal,
  );

  const perfModeKey: PerformanceModeName = deployMode === 'OVERTAKE' ? 'PSH' : deployMode;
  const perfMode = LC26_PERFORMANCE_MODES[perfModeKey];
  const boostActive = Boolean(input.boostButtonActive);

  // Configurable ECU Super Clipping ceiling (clamped strictly in 250..350 kW when active)
  const configuredClipCeilingKw = clamp(
    input.superClipCeilingKw ??
      (perfMode.topGearClipHarvestW > 0 ? perfMode.topGearClipHarvestW / 1000 : ersCal.superClipHarvestCeilingKw),
    250,
    ersCal.maxPowerKw,
  );
  const superClipTargetSoc = clamp(input.superClipTargetSoc01 ?? Math.max(0.35, perfMode.socFloor + 0.25), 0.05, 0.99);

  // Determine whether automated full-throttle ECU Super Clipping should engage / latch:
  //  - Engages at full throttle (`throttlePedal01 >= 0.98`, preserving `throttlePedal01 === 1.0` for Straight Mode!),
  //    high speed (`>= superClipMinSpeedKmh` in gears 6..8), `!boostActive`, `!overtakeModeActive` (unless forced),
  //    when SoC < recovery target & harvest headroom remains.
  //  - Per FIA C5.12.5, once latched on a straight, stays latched without hunting up until throttle lift (< 0.90) or Boost!
  const canHarvestMore = prev.soc01 < 0.999 && lapHarvestedJ < activeHarvestCeilingJ - 100;
  const highSpeedStraight = gear >= 6 && absSpeedKmh >= ersCal.superClipMinSpeedKmh;
  const modeWantsSuperClip =
    Boolean(input.forceSuperClip) ||
    (!overtakeModeActive &&
      (perfMode.topGearClipHarvestW > 0 || prev.soc01 < superClipTargetSoc) &&
      prev.soc01 < superClipTargetSoc);

  let superClippingActive = prev.superClippingActive;
  if (boostActive || brakePedal01 > 0.02 || throttlePedal01 < 0.9 || !canHarvestMore) {
    superClippingActive = false;
  } else if (throttlePedal01 >= 0.98 && highSpeedStraight && modeWantsSuperClip) {
    superClippingActive = true;
  }

  // Compute raw target MGU-K mechanical power (kW: + deploy, - harvest)
  let targetMgukPowerKw = 0;
  let antiLagTorqueFillNm = 0;
  const standingStartGatedOff =
    (standingStartActive && absSpeedKmh < ersCal.standingStartMgukMinSpeedKmh) ||
    launchHoldActive ||
    (launchTimeoutTripped && stationaryForLaunch);

  const remainingDeployBudgetJ = Math.min(
    prev.batteryEnergyJ,
    Math.max(0, activeDeployCeilingJ - lapDeployedJ),
  );
  const effectiveSocFloor = boostActive || overtakeModeActive ? 0.0 : perfMode.socFloor;
  const canDeploy =
    !standingStartGatedOff &&
    gear >= 1 &&
    clutchEngagement01 > 0.25 &&
    !upshiftCutActive &&
    limiterTimerS <= 0 &&
    prev.soc01 > effectiveSocFloor &&
    remainingDeployBudgetJ > 50;

  if (brakePedal01 > 0.02) {
    // Under braking, MGU-K harvest matches exact BBW regenerative power split
    const axleOmega = absSpeedKmh / 3.6 / bbwParams.rearEffectiveRadiusM;
    targetMgukPowerKw = -clamp((bbw.rearMgukRegenTorqueNm * axleOmega * gb.efficiency) / 1000, 0, ersCal.maxPowerKw);
  } else if (superClippingActive) {
    // Automated full-throttle Super Clipping (`-250..-350 kW`), tapered smoothly as SoC/harvest cap fills
    const socTaper = 1 - smoothstep01(prev.soc01, 0.985, 1.0);
    const harvTaper = 1 - smoothstep01(lapHarvestedJ, activeHarvestCeilingJ - 60_000, activeHarvestCeilingJ);
    targetMgukPowerKw = -configuredClipCeilingKw * socTaper * harvTaper;
  } else if (gear >= 7 && throttlePedal01 < LC26_ERS_DATA.liftThrottle && absSpeedKmh > 120 && canHarvestMore) {
    // High-speed lift-and-coast regeneration
    const liftKw = (LC26_ERS_DATA.topGearLiftHarvestW / 1000) * perfMode.liftHarvestScale;
    const socTaper = 1 - smoothstep01(prev.soc01, 0.985, 1.0);
    const harvTaper = 1 - smoothstep01(lapHarvestedJ, activeHarvestCeilingJ - 60_000, activeHarvestCeilingJ);
    targetMgukPowerKw = -clamp(liftKw * socTaper * harvTaper, 0, ersCal.maxPowerKw);
  } else if (canDeploy && throttlePedal01 > 0.05) {
    // Positive deployment: Boost or Overtake commands 100% legal profile; standard modes scale by deployFraction
    const modeFrac = boostActive || overtakeModeActive ? 1.0 : perfMode.deployFraction;
    const gearDeployScale = gear === 1 ? 0.55 : gear === 2 ? 0.8 : 1.0;
    let deployKw = speedDerateCapKw * modeFrac * gearDeployScale * throttlePedal01;

    // Low-RPM MGU-K Anti-Lag Torque-Fill on corner exit:
    // Compensates MGU-H-free turbocharger boost deficit seamlessly within legal speed & torque ceilings!
    if (turboLagDeficitNm > 0.5 && speedDerateCapKw > 0) {
      const maxLegalTorqueNm = evaluateCleanRoomMgukCrankTorqueCapNm(rpm, speedDerateCapKw);
      const baseTorqueNm = (deployKw * 1000) / effectiveOmega;
      const desiredTorqueWithFillNm = Math.min(maxLegalTorqueNm, baseTorqueNm + turboLagDeficitNm);
      antiLagTorqueFillNm = Math.max(0, desiredTorqueWithFillNm - baseTorqueNm);
      deployKw = Math.min(speedDerateCapKw, (desiredTorqueWithFillNm * effectiveOmega) / 1000);
    }

    targetMgukPowerKw = clamp(deployKw, 0, speedDerateCapKw);
  }

  // Enforce smooth dP/dt slew rules (FIA C5.12.6 / C5.12.7):
  //  - Zero sudden rear wheel torque step when transitioning into/during Super Clipping at 100% throttle!
  //  - Instant/fast compliance when driver hits brake, lifts throttle, shifts gear, or C5.2.8 speed cap forces drop.
  let slewedMgukPowerKw = targetMgukPowerKw;
  const driverOnFullThrottle = throttlePedal01 >= 0.9 && brakePedal01 <= 0.02 && !upshiftCutActive;
  if (driverOnFullThrottle && gear >= 1) {
    const deltaKw = targetMgukPowerKw - prev.slewedMgukPowerKw;
    if (deltaKw < 0) {
      // Reducing MGU-K power at full throttle (e.g. entering Super Clipping):
      // Enforce FIA C5.12.6 slew above 100 kW and smooth transition slew below 100 kW, EXCEPT where C5.2.8 caps deploy!
      const downRateKwPerS =
        prev.slewedMgukPowerKw > 100
          ? Math.max(ersCal.fiaHighPowerSlewKwPerS, superClippingActive ? ersCal.superClipTransitionSlewKwPerS : ersCal.fiaHighPowerSlewKwPerS)
          : ersCal.superClipTransitionSlewKwPerS;
      const slewedDown = prev.slewedMgukPowerKw - downRateKwPerS * dt;
      // FIA C5.12.7 exception: never exceed FIA C5.2.8 legal speed ceiling `speedDerateCapKw`
      slewedMgukPowerKw = Math.min(speedDerateCapKw, Math.max(targetMgukPowerKw, slewedDown));
    } else if (deltaKw > 0) {
      // FIA C5.12.5: Do not increase power during latched Super Clipping unless Boost is pressed
      if (superClippingActive && !boostActive) {
        slewedMgukPowerKw = Math.min(prev.slewedMgukPowerKw, speedDerateCapKw);
      } else {
        const slewedUp = prev.slewedMgukPowerKw + ersCal.deployRampUpSlewKwPerS * dt;
        slewedMgukPowerKw = Math.min(targetMgukPowerKw, slewedUp, speedDerateCapKw);
      }
    }
  } else if (upshiftCutActive) {
    slewedMgukPowerKw = 0;
  }

  // Clamp MGU-K crank torque strictly within [-500 Nm, +500 Nm] (FIA C5.2.11) and energy budgets
  const maxTorqueMagNm = evaluateCleanRoomMgukCrankTorqueCapNm(rpm, ersCal.maxPowerKw);
  let mgukTorqueNm = clamp((slewedMgukPowerKw * 1000) / effectiveOmega, -maxTorqueMagNm, maxTorqueMagNm);
  let mgukPowerKw = (mgukTorqueNm * effectiveOmega) / 1000;

  let batteryEnergyJ = prev.batteryEnergyJ;
  if (mgukPowerKw > 0) {
    const electricalDrawJ = ((mgukPowerKw * 1000) / ersCal.deployEfficiency) * dt;
    const maxDrawJ = Math.min(batteryEnergyJ, Math.max(0, activeDeployCeilingJ - lapDeployedJ));
    if (electricalDrawJ > maxDrawJ) {
      const scale = electricalDrawJ > 0 ? maxDrawJ / electricalDrawJ : 0;
      mgukPowerKw *= scale;
      mgukTorqueNm *= scale;
      antiLagTorqueFillNm *= scale;
    }
    const actualDrawJ = ((mgukPowerKw * 1000) / ersCal.deployEfficiency) * dt;
    batteryEnergyJ = Math.max(0, batteryEnergyJ - actualDrawJ);
    lapDeployedJ += actualDrawJ;
  } else if (mgukPowerKw < 0) {
    const electricalChargeJ = -mgukPowerKw * 1000 * ersCal.harvestEfficiency * dt;
    const batteryRoomJ = Math.max(0, ersCal.usableBatteryWindowJ - batteryEnergyJ);
    const lapHarvestRoomJ = Math.max(0, activeHarvestCeilingJ - lapHarvestedJ);
    const maxChargeJ = Math.min(batteryRoomJ, lapHarvestRoomJ);
    if (electricalChargeJ > maxChargeJ) {
      const scale = electricalChargeJ > 0 ? maxChargeJ / electricalChargeJ : 0;
      mgukPowerKw *= scale;
      mgukTorqueNm *= scale;
    }
    const actualChargeJ = -mgukPowerKw * 1000 * ersCal.harvestEfficiency * dt;
    batteryEnergyJ = Math.min(ersCal.usableBatteryWindowJ, batteryEnergyJ + actualChargeJ);
    lapHarvestedJ += actualChargeJ;
  }

  slewedMgukPowerKw = mgukPowerKw;
  const soc01 = clamp(batteryEnergyJ / ersCal.usableBatteryWindowJ, 0, 1);

  // ---- 8. Crankshaft & Drivetrain Integration + 3-Phase Differential ----
  const netCrankTorqueNm = iceTorqueNm + mgukTorqueNm;
  let nextCrankOmegaRadS = rpm * RPM_TO_RADS;
  if (input.externalRpmOverride === undefined) {
    if (clutchEngagement01 >= 0.98 && totalRatio !== 0 && !downshiftSyncing) {
      nextCrankOmegaRadS = Math.max(
        LC26_ENGINE_DATA.idleRpm * RPM_TO_RADS * 0.85,
        Math.abs(wheelOmegaMean * totalRatio),
      );
    } else {
      // Blend free crank acceleration with slipping clutch synchronization torque
      const targetWheelCrankOmega = Math.abs(wheelOmegaMean * totalRatio);
      const clutchSlipTorqueNm =
        clutchEngagement01 * LC26_CLUTCH_DATA.maxTorqueNm * clamp((nextCrankOmegaRadS - targetWheelCrankOmega) / 120, -1, 1);
      const alphaCrank = (netCrankTorqueNm - clutchSlipTorqueNm) / LC26_ENGINE_DATA.inertia;
      nextCrankOmegaRadS = clamp(
        nextCrankOmegaRadS + alphaCrank * dt,
        0,
        LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm * RPM_TO_RADS,
      );
    }
    rpm = clamp(nextCrankOmegaRadS * RADS_TO_RPM, 0, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  }

  const drivelineEff = netCrankTorqueNm >= 0 ? gb.efficiency : 1.0;
  const rearAxleDriveTorqueNm =
    gear === 0 ? 0 : netCrankTorqueNm * clutchEngagement01 * totalRatio * drivelineEff;

  const differential = solveLc26Differential({
    ringGearTorqueNm: rearAxleDriveTorqueNm,
    rearLeftWheelOmegaRadS: input.rearLeftWheelOmegaRadS ?? wheelOmegaMean,
    rearRightWheelOmegaRadS: input.rearRightWheelOmegaRadS ?? wheelOmegaMean,
    throttlePedal01,
    brakePedal01,
    steeringNormalized: input.steeringNormalized ?? 0,
    speedKmh: absSpeedKmh,
    entryLockPct: input.diffEntryLockPct,
    midCoastLockPct: input.diffMidCoastLockPct,
    exitPowerLockPct: input.diffExitPowerLockPct,
    preloadNm: input.diffPreloadNm,
  });

  const nextState: Lc26EcuState = {
    rpm,
    crankOmegaRadS: rpm * RPM_TO_RADS,
    gear,
    shiftTimerS,
    sinceUpshiftS,
    sinceDownshiftS,
    pendingShift,
    prevShiftUpPressed: Boolean(input.shiftUp),
    prevShiftDownPressed: Boolean(input.shiftDown),
    throttlePlate01,
    limiterTimerS,
    turboShaftRadS,
    boostPressureBarA,
    wastegateOpen01,
    fuelMassKg,
    fuelConsumedKg,
    batteryEnergyJ,
    soc01,
    lapDeployedJ,
    lapHarvestedJ,
    overtakeArmed,
    overtakeModeActive,
    prevTrackProgress01: currProgress,
    slewedMgukPowerKw,
    superClippingActive,
    launchHoldActive,
    launchHoldTimerS,
    launchTimeoutTripped,
    standingStartActive,
  };

  const telemetry: Lc26PowertrainTelemetry = {
    iceTorqueNm,
    icePowerKw,
    mgukTorqueNm,
    mgukPowerKw,
    boostPressureBarA,
    fuelMassFlowKgS,
    fuelEnergyFlowMjH,
    soc01,
    lapDeployedJ,
    lapHarvestedJ,
    overtakeModeActive,
    speedDerateCapKw,
  };

  return {
    state: nextState,
    telemetry,
    bbw,
    differential,
    passthroughThrottlePedal01: throttlePedal01,
    steadyBoostedIceTorqueNm: steadyBoostedCombustionNm - coastBrakingNm,
    turboLagDeficitNm,
    antiLagTorqueFillNm,
    netCrankTorqueNm,
    rearAxleDriveTorqueNm,
    clutchEngagement01,
    downshiftRejectedOverRev,
    neutralReverseInterlockBlocked,
    activeDeployCeilingJ,
    activeHarvestCeilingJ,
  };
}

/**
 * Stateful 500 Hz ECU & Drivetrain Controller wrapper around `stepLc26Ecu`.
 */
export class Lc26EcuController {
  private _state: Lc26EcuState;
  public readonly ersCalibration: Lc26ErsCalibrationParams;
  public readonly turboParams: Lc26TurboPhysicsParams;
  public readonly bbwParams: Lc26BbwCalibrationParams;

  constructor(options?: {
    initialFuelKg?: number;
    initialSoc01?: number;
    initialGear?: number;
    initialRpm?: number;
    standingStart?: boolean;
    ersCalibration?: Partial<Lc26ErsCalibrationParams>;
    turboParams?: Partial<Lc26TurboPhysicsParams>;
    bbwParams?: Partial<Lc26BbwCalibrationParams>;
  }) {
    this._state = createInitialLc26EcuState(options);
    this.ersCalibration = { ...DEFAULT_LC26_ERS_CALIBRATION, ...options?.ersCalibration };
    this.turboParams = { ...DEFAULT_LC26_TURBO_PARAMS, ...options?.turboParams };
    this.bbwParams = { ...DEFAULT_LC26_BBW_PARAMS, ...options?.bbwParams };
  }

  public get state(): Lc26EcuState {
    return this._state;
  }

  public reset(options?: Parameters<typeof createInitialLc26EcuState>[0]): void {
    this._state = createInitialLc26EcuState(options);
  }

  public setFuelMassKg(fuelKg: number): void {
    this._state = {
      ...this._state,
      fuelMassKg: clamp(fuelKg, 0, 100),
    };
  }

  public step(input: Lc26EcuStepInput): Lc26EcuStepOutput {
    const out = stepLc26Ecu(
      this._state,
      input,
      this.ersCalibration,
      this.turboParams,
      this.bbwParams,
    );
    this._state = out.state;
    return out;
  }
}

/**
 * Helper mapping `Lc26GarageSetup` powertrain/brake/diff parameters onto `Lc26PowertrainModule`
 * structures for Phase 2 vehicle assembly.
 */
export function applyGarageSetupToLc26Powertrain(
  setup: Partial<
    Pick<
      Lc26GarageSetup,
      | 'brakeBiasFrontPct'
      | 'brakeMigrationPct'
      | 'diffEntryLockPct'
      | 'diffMidCoastLockPct'
      | 'diffHighSpeedPreloadNm'
      | 'engineBrakingLevel'
      | 'ersDeployMode'
      | 'fuelLoadKg'
    >
  >,
): {
  module: Lc26PowertrainModule;
  fuelLoadKg: number;
  ersDeployMode: PerformanceModeName;
} {
  const frontBias01 = clamp((setup.brakeBiasFrontPct ?? 56.0) / 100, 0.48, 0.66);
  const migAmount01 = clamp((setup.brakeMigrationPct ?? 2.5) / 100, 0, 0.12);
  const entryDial = clamp(1 + Math.round(((setup.diffEntryLockPct ?? 28) / 100) * 11), 1, 12);
  const midDial = clamp(1 + Math.round(((setup.diffMidCoastLockPct ?? 18) / 100) * 11), 1, 12);
  const preloadNm = clamp(setup.diffHighSpeedPreloadNm ?? 75, 10, 220);
  const ebLevel = clamp(setup.engineBrakingLevel ?? 5, 1, 10);

  const customCoastCurve: LutPoints = LC26_ENGINE_DATA.coastCurve.map(([r]) => [
    r,
    Number(evaluateCleanRoomIceCoastTorqueNm(r, ebLevel).toFixed(2)),
  ]);

  const base = createLc26PowertrainModule();
  const module: Lc26PowertrainModule = {
    ...base,
    engine: {
      ...base.engine,
      coastCurve: customCoastCurve,
    },
    differential: {
      ...base.differential,
      settings: {
        ...base.differential.settings,
        preload: preloadNm,
      },
      diffEntryLevel: entryDial,
      diffMidLevel: midDial,
    },
    brakes: {
      ...base.brakes,
      front_bias: frontBias01,
      migration: {
        amount: migAmount01,
        rampStart: 0.05,
      },
    },
  };

  return {
    module,
    fuelLoadKg: clamp(setup.fuelLoadKg ?? 98.0, 5.0, 100.0),
    ersDeployMode: setup.ersDeployMode ?? 'RAC',
  };
}
