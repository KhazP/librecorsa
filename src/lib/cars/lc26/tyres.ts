/**
 * Clean-Room 2026 Narrowed 18-Inch Pirelli Thermal Tyre & Wet-Line Module
 * for VeloSoft LC-26 (`lc26-f1`).
 *
 * Regulation & First-Principles Basis:
 * - FIA 2026 Formula 1 Technical Regulations Section C (Issue 21, Art. C10.8–C10.10):
 *   - Front `280/705-R18`: width `0.280 m` (`-25 mm` vs 2025 `305 mm`), outer diameter `0.705 m`
 *     (`-15 mm` vs 2025 `720 mm`, unloaded radius `0.3525 m`), `18"` nominal rim (`0.2286 m` bead
 *     seat radius, `0.248 m` outer lip radius).
 *   - Rear `375/710-R18`: width `0.375 m` (`-30 mm` vs 2025 `405 mm`), outer diameter `0.710 m`
 *     (`-10 mm` vs 2025 `720 mm`, unloaded radius `0.3550 m`), `18"` nominal rim.
 * - FIA 2026 Sporting Regulations Section B (Issue 09):
 *   - Slicks (`C1`–`C5`): `70 °C` tyre-blanket pre-heat, `90–105 °C` optimal working window.
 *   - Intermediate: `60 °C` tyre-blanket pre-heat, `~38 L/s` groove evacuation at `300 km/h`.
 *   - Full Wet: unblanketed (`35–40 °C` ambient/garage start), `~80 L/s` groove evacuation at `300 km/h`.
 *
 * STRICT CLEAN-ROOM POLICY:
 * Zero copied LUTs, curves, or parameters from RSS, VRC, DeX (`vf26` / `f12026`), or external mods.
 * Every load-sensitivity, viscoelastic thermal, brush pneumatic-trail, and hydrodynamic evacuation
 * curve is synthesized analytically from first-principles tyre mechanics.
 */

import type { TyreGeometry } from '@/lib/sim/f12026-car/F12026CarConfig';
import { Lut, type LutPoints } from '@/lib/sim/lut';
import { tyreGaugePressureAtTemperature } from '@/lib/sim/tyre-pressure';
import {
  rimWetEnvironmentCoolingWK,
  wetExternalGasCoolingWK,
  wetGrooveGripEffect,
  wetHeatScale,
  wetnessFromWater,
  wetPneumaticTrailScale,
  wetRoadCoolingWK,
  wetWearScale,
} from '@/lib/sim/wet-tyres';
import {
  LC26_TYRE_DIMENSIONS,
  type CompoundSlot,
  type Lc26CornerThermalState,
  type Lc26PirelliSlickCode,
  type Lc26TyresModule,
  type Lc26WetEvacuationResult,
  type PhysicsTyreCompound,
  type TyresCamberData,
  type TyresCompoundData,
  type TyresModelData,
  type TyresPressureData,
  type TyresThermalPatchData,
  type WetTyreTraits,
} from './contract-types';

export { LC26_TYRE_DIMENSIONS };

// ---------------------------------------------------------------------------
// 1. FIA 2026 Narrowed 18-Inch Wheel & Tyre Geometry
// ---------------------------------------------------------------------------

/** Exact 18-inch FIA C10.8–C10.10 rim radii & 2025 dimensional deltas */
export const LC26_RIM_18_INCH_SPEC = {
  nominalDiameterInch: 18,
  /** Exact 18-inch ETRTO bead-seat radius: `9 in * 0.0254 m/in = 0.2286 m` */
  beadRadiusM: 0.2286,
  /** FIA C10.8 outer rim lip radius: `0.496 m / 2 = 0.248 m` */
  lipRadiusM: 0.248,
  /** FIA C10.8 inner barrel clearance radius: `0.438 m / 2 = 0.219 m` */
  innerBarrelRadiusM: 0.219,
  frontVs2025: {
    width2025M: 0.305,
    width2026M: LC26_TYRE_DIMENSIONS.front.widthM,
    widthDeltaM: -0.025,
    outerDiameter2025M: 0.72,
    outerDiameter2026M: LC26_TYRE_DIMENSIONS.front.outerDiameterM,
    outerDiameterDeltaM: -0.015,
  },
  rearVs2025: {
    width2025M: 0.405,
    width2026M: LC26_TYRE_DIMENSIONS.rear.widthM,
    widthDeltaM: -0.03,
    outerDiameter2025M: 0.72,
    outerDiameter2026M: LC26_TYRE_DIMENSIONS.rear.outerDiameterM,
    outerDiameterDeltaM: -0.01,
  },
} as const;

/** Front `280/705-R18` solver geometry (`VehiclePhysics` `TyreGeometry`) */
export const LC26_FRONT_TYRE_GEOMETRY: TyreGeometry = {
  width: LC26_TYRE_DIMENSIONS.front.widthM, // 0.280 m
  radius: LC26_TYRE_DIMENSIONS.front.unloadedRadiusM, // 0.3525 m
  rimRadius: LC26_RIM_18_INCH_SPEC.beadRadiusM, // 0.2286 m (18" bead seat)
  verticalRateScale: 1.0,
  radiusGrowthPerRadS: 1.1e-5, // ~2.8 mm radial belt stretch at 320 km/h
};

/** Rear `375/710-R18` solver geometry (`VehiclePhysics` `TyreGeometry`) */
export const LC26_REAR_TYRE_GEOMETRY: TyreGeometry = {
  width: LC26_TYRE_DIMENSIONS.rear.widthM, // 0.375 m
  radius: LC26_TYRE_DIMENSIONS.rear.unloadedRadiusM, // 0.3550 m
  rimRadius: LC26_RIM_18_INCH_SPEC.beadRadiusM, // 0.2286 m (18" bead seat)
  verticalRateScale: 1.09,
  radiusGrowthPerRadS: 1.2e-5, // ~3.0 mm radial belt stretch at 320 km/h
};

// ---------------------------------------------------------------------------
// 2. Clean-Room Pirelli C1–C5 + Intermediate + Full Wet Compound Specifications
// ---------------------------------------------------------------------------

export const LC26_PIRELLI_SLICK_CODES: readonly Lc26PirelliSlickCode[] = [
  'C1',
  'C2',
  'C3',
  'C4',
  'C5',
] as const;

export type Lc26CompoundId = Lc26PirelliSlickCode | 'intermediate' | 'wet';

export interface Lc26AxleFrictionSpec {
  /** Reference vertical load `Fz0` (N) */
  readonly fz0N: number;
  /** Peak lateral friction coefficient `Dy0` at `Fz0` in optimal thermal/pressure state */
  readonly dy0: number;
  /** Peak longitudinal friction coefficient `Dx0` at `Fz0` in optimal thermal/pressure state */
  readonly dx0: number;
  /** Power-law load sensitivity exponent `n_ls` (`< 1` so `mu ~ (Fz/Fz0)^(n_ls - 1)` falls with load) */
  readonly lsExpY: number;
  readonly lsExpX: number;
  /** Narrowed-footprint high-pressure contact saturation decay `beta` (`> 0`) */
  readonly highLoadSaturationBeta: number;
  /** Nominal peak slip angle at `Fz0` (deg) */
  readonly peakSlipAngleDeg0: number;
  /** Optimal hot inflation pressure (psi gauge) */
  readonly optimalHotPsi: number;
  /** Structural sidewall radial stiffness at 0 psig + pneumatic membrane gain per psi (N/m) */
  readonly sidewallBaseRateNm: number;
  readonly pneumaticRatePerPsiNm: number;
}

export interface Lc26CompoundSpec {
  readonly id: Lc26CompoundId;
  readonly displayName: string;
  readonly hardnessRank: number; // 1 = C1 hardest .. 5 = C5 softest, 6 = Inter, 7 = Wet
  readonly isRain: boolean;
  /** FIA 2026 pre-heat blanket / garage starting temperature (°C): 70°C slicks, 60°C Inter, 37°C unblanketed Wet */
  readonly blanketPreheatC: number;
  /** Optimal viscoelastic working temperature window `[lowC, highC]` (°C) */
  readonly optimalWindowC: readonly [lowC: number, highC: number];
  /** Bulk temperature (°C) below which high-slip sliding tears cold tread into graining ripples */
  readonly grainColdThresholdC: number;
  /** Internal carcass/core temperature (°C) above which volatile outgassing causes structural blistering */
  readonly blisterCoreThresholdC: number;
  /** Characteristic sliding-work distance to wear fresh tread to carcass cords (`remainingLife01: 1 -> 0`, km) */
  readonly wearEnduranceSlidingKm: number;
  /** Susceptibility to locked-wheel flat-spotting (`C1 < C2 < C3 < C4 < C5`) */
  readonly flatSpotSoftness: number;
  /** 3-layer front thermal capacities & conductances (rear scales automatically by tyre area ratio `1.3488`) */
  readonly thermalModel: {
    readonly surfaceCapJK: number;
    readonly bulkCapJK: number;
    readonly coreCapJK: number;
    readonly slipHeatToSurfaceShare: number;
    readonly hysteresisCoeff: number;
    readonly surfaceToBulkWK: number;
    readonly bulkToCoreWK: number;
    readonly surfaceConvectiveWK: readonly [g0: number, g1PerMs: number];
    readonly bulkConvectiveWK: readonly [g0: number, g1PerMs: number];
    readonly coreConvectiveWK: readonly [g0: number, g1PerMs: number];
    /** Cold-temperature grip floor & cold/hot drop-off steepness for viscoelastic master curve */
    readonly coldGripAt20C: number;
    readonly coldDropExponent: number;
    readonly hotDropPerDegSq: number;
  };
  /** Water-evacuation & wet-road traits */
  readonly wet: {
    readonly traits: WetTyreTraits;
    /** Maximum groove + sipe water evacuation rate at `300 km/h` (`83.33 m/s`) per front / rear tyre (L/s) */
    readonly maxEvacAt300KmhLitresPerSec: readonly [frontLs: number, rearLs: number];
    /** Residual water wedge film thickness (mm) that triggers dynamic hydroplaning lift */
    readonly hydroplaneWedgeRefMm: number;
    /** Boundary micro-asperity friction retention as function of water film */
    readonly dryBaseEfficiency: number;
    readonly wetPeakEfficiency: number;
  };
  readonly front: Lc26AxleFrictionSpec;
  readonly rear: Lc26AxleFrictionSpec;
}

const FRONT_FZ0_N = 3600;
const REAR_FZ0_N = 4600;
const REAR_THERMAL_AREA_SCALE =
  (LC26_TYRE_DIMENSIONS.rear.widthM * LC26_TYRE_DIMENSIONS.rear.unloadedRadiusM) /
  (LC26_TYRE_DIMENSIONS.front.widthM * LC26_TYRE_DIMENSIONS.front.unloadedRadiusM); // ~1.3488

function makeSlickSpec(params: {
  code: Lc26PirelliSlickCode;
  rank: 1 | 2 | 3 | 4 | 5;
  windowC: readonly [number, number];
  grainColdC: number;
  blisterCoreC: number;
  frontDy0: number;
  frontDx0: number;
  rearDy0: number;
  rearDx0: number;
  peakSlipFrontDeg: number;
  peakSlipRearDeg: number;
  wearKm: number;
  flatSpotSoftness: number;
  surfaceCapJK: number;
  bulkCapJK: number;
  coreCapJK: number;
  slipShare: number;
  hysteresis: number;
  coldGripAt20C: number;
  hotDropPerDegSq: number;
  wetBoundaryGrip: number;
}): Lc26CompoundSpec {
  const wetTraits: WetTyreTraits = {
    dryGrip: 1.0,
    wetGrip: params.wetBoundaryGrip,
    clearMm: 0.36, // Un-grooved slick clears only thin squeeze film; rapid hydroplaning > 0.5-0.8 mm
    treadDepthMm: 0,
    tempShiftC: 0,
    dryWearScale: 1.0,
    dryHeatScale: 1.0,
    wetWearScale: 0.52,
  };
  return {
    id: params.code,
    displayName: `Pirelli P Zero 2026 ${params.code}`,
    hardnessRank: params.rank,
    isRain: false,
    blanketPreheatC: 70, // FIA 2026 Sporting Regulations: 70 °C slick blankets
    optimalWindowC: params.windowC,
    grainColdThresholdC: params.grainColdC,
    blisterCoreThresholdC: params.blisterCoreC,
    wearEnduranceSlidingKm: params.wearKm,
    flatSpotSoftness: params.flatSpotSoftness,
    thermalModel: {
      surfaceCapJK: params.surfaceCapJK,
      bulkCapJK: params.bulkCapJK,
      coreCapJK: params.coreCapJK,
      slipHeatToSurfaceShare: params.slipShare,
      hysteresisCoeff: params.hysteresis,
      // Radial rubber conductance G = k_rubber * A_tread / delta_r (~0.33 W/mK * 0.62 m^2 / 0.0023 m)
      surfaceToBulkWK: 88,
      bulkToCoreWK: 82,
      surfaceConvectiveWK: [6.8, 0.92],
      bulkConvectiveWK: [5.0, 0.30],
      // Enclosed inner carcass/rim cavity loses heat primarily via forged Mg alloy rim barrel airflow
      coreConvectiveWK: [4.2, 0.09],
      coldGripAt20C: params.coldGripAt20C,
      coldDropExponent: 1.22,
      hotDropPerDegSq: params.hotDropPerDegSq,
    },
    wet: {
      traits: wetTraits,
      // Smooth slick footprint edge expulsion only (~6.5 L/s front, ~7.8 L/s rear @ 300 km/h)
      maxEvacAt300KmhLitresPerSec: [6.5, 7.8],
      hydroplaneWedgeRefMm: 0.24,
      dryBaseEfficiency: 1.0,
      wetPeakEfficiency: params.wetBoundaryGrip,
    },
    front: {
      fz0N: FRONT_FZ0_N,
      dy0: params.frontDy0,
      dx0: params.frontDx0,
      lsExpY: 0.895,
      lsExpX: 0.912,
      highLoadSaturationBeta: 0.028, // Narrowed 280 mm contact-patch pressure sensitivity
      peakSlipAngleDeg0: params.peakSlipFrontDeg,
      optimalHotPsi: 24.5,
      sidewallBaseRateNm: 142_000,
      pneumaticRatePerPsiNm: 7_200,
    },
    rear: {
      fz0N: REAR_FZ0_N,
      dy0: params.rearDy0,
      dx0: params.rearDx0,
      lsExpY: 0.908,
      lsExpX: 0.924,
      highLoadSaturationBeta: 0.023, // Narrowed 375 mm rear contact-patch pressure sensitivity
      peakSlipAngleDeg0: params.peakSlipRearDeg,
      optimalHotPsi: 22.5,
      sidewallBaseRateNm: 152_000,
      pneumaticRatePerPsiNm: 8_200,
    },
  };
}

/** Full clean-room 2026 Pirelli C1–C5 slick specification database */
export const LC26_SLICK_SPECS: Record<Lc26PirelliSlickCode, Lc26CompoundSpec> = {
  C1: makeSlickSpec({
    code: 'C1',
    rank: 1,
    windowC: [94, 107],
    grainColdC: 84,
    blisterCoreC: 130, // Highest thermal ceiling (~130 °C)
    frontDy0: 1.78,
    frontDx0: 1.85,
    rearDy0: 1.83,
    rearDx0: 1.92,
    peakSlipFrontDeg: 5.85,
    peakSlipRearDeg: 5.35,
    wearKm: 44.0,
    flatSpotSoftness: 0.78,
    surfaceCapJK: 1620,
    bulkCapJK: 4900,
    coreCapJK: 6900,
    slipShare: 0.3,
    hysteresis: 0.0094,
    coldGripAt20C: 0.69,
    hotDropPerDegSq: 0.00014,
    wetBoundaryGrip: 0.49,
  }),
  C2: makeSlickSpec({
    code: 'C2',
    rank: 2,
    windowC: [92, 105],
    grainColdC: 82,
    blisterCoreC: 127,
    frontDy0: 1.84,
    frontDx0: 1.91,
    rearDy0: 1.89,
    rearDx0: 1.98,
    peakSlipFrontDeg: 6.0,
    peakSlipRearDeg: 5.48,
    wearKm: 35.5,
    flatSpotSoftness: 0.88,
    surfaceCapJK: 1550,
    bulkCapJK: 4700,
    coreCapJK: 6700,
    slipShare: 0.315,
    hysteresis: 0.0099,
    coldGripAt20C: 0.71,
    hotDropPerDegSq: 0.000155,
    wetBoundaryGrip: 0.51,
  }),
  C3: makeSlickSpec({
    code: 'C3',
    rank: 3,
    windowC: [90, 105], // Canonical 90–105 °C slick window
    grainColdC: 80,
    blisterCoreC: 124,
    frontDy0: 1.9,
    frontDx0: 1.97,
    rearDy0: 1.95,
    rearDx0: 2.04,
    peakSlipFrontDeg: 6.15,
    peakSlipRearDeg: 5.62,
    wearKm: 28.0,
    flatSpotSoftness: 1.0,
    surfaceCapJK: 1480,
    bulkCapJK: 4500,
    coreCapJK: 6500,
    slipShare: 0.33,
    hysteresis: 0.0104,
    coldGripAt20C: 0.73,
    hotDropPerDegSq: 0.00017,
    wetBoundaryGrip: 0.53,
  }),
  C4: makeSlickSpec({
    code: 'C4',
    rank: 4,
    windowC: [89, 103],
    grainColdC: 79,
    blisterCoreC: 121,
    frontDy0: 1.96,
    frontDx0: 2.03,
    rearDy0: 2.01,
    rearDx0: 2.1,
    peakSlipFrontDeg: 6.3,
    peakSlipRearDeg: 5.75,
    wearKm: 21.5,
    flatSpotSoftness: 1.14,
    surfaceCapJK: 1410,
    bulkCapJK: 4300,
    coreCapJK: 6300,
    slipShare: 0.345,
    hysteresis: 0.0109,
    coldGripAt20C: 0.75,
    hotDropPerDegSq: 0.00019,
    wetBoundaryGrip: 0.55,
  }),
  C5: makeSlickSpec({
    code: 'C5',
    rank: 5,
    windowC: [88, 101],
    grainColdC: 78,
    blisterCoreC: 118, // Softest qualifying compound blisters above ~118 °C core
    frontDy0: 2.03,
    frontDx0: 2.1,
    rearDy0: 2.08,
    rearDx0: 2.17,
    peakSlipFrontDeg: 6.48,
    peakSlipRearDeg: 5.9,
    wearKm: 16.2,
    flatSpotSoftness: 1.3,
    surfaceCapJK: 1340,
    bulkCapJK: 4100,
    coreCapJK: 6100,
    slipShare: 0.36,
    hysteresis: 0.0115,
    coldGripAt20C: 0.77,
    hotDropPerDegSq: 0.000215,
    wetBoundaryGrip: 0.57,
  }),
};

/** Green-walled Cinturato Intermediate (`60 °C` blankets, `0.4–2.2 mm` optimal, `~38 L/s` @ `300 km/h`) */
export const LC26_INTERMEDIATE_SPEC: Lc26CompoundSpec = {
  id: 'intermediate',
  displayName: 'Pirelli Cinturato 2026 Intermediate',
  hardnessRank: 6,
  isRain: true,
  blanketPreheatC: 60, // FIA Sporting Regs: 60 °C Intermediate blankets
  optimalWindowC: [58, 78],
  grainColdThresholdC: 44,
  blisterCoreThresholdC: 102,
  wearEnduranceSlidingKm: 24.0,
  flatSpotSoftness: 1.18,
  thermalModel: {
    surfaceCapJK: 1380,
    bulkCapJK: 4550,
    coreCapJK: 9000,
    slipHeatToSurfaceShare: 0.34,
    hysteresisCoeff: 0.0118,
    surfaceToBulkWK: 60,
    bulkToCoreWK: 46,
    surfaceConvectiveWK: [5.6, 0.64],
    bulkConvectiveWK: [4.4, 0.24],
    coreConvectiveWK: [6.8, 0.2],
    coldGripAt20C: 0.86,
    coldDropExponent: 1.3,
    hotDropPerDegSq: 0.00028, // Overheats & degrades rapidly on bone-dry rubbered asphalt
  },
  wet: {
    traits: {
      dryGrip: 0.9,
      wetGrip: 0.9,
      clearMm: 1.55,
      treadDepthMm: 2.6,
      tempShiftC: -29.5,
      dryWearScale: 3.2,
      dryHeatScale: 1.45,
      wetWearScale: 1.0,
    },
    // Mean 38.0 L/s at 300 km/h across narrowed front (35.5 L/s) & rear (40.5 L/s) channels
    maxEvacAt300KmhLitresPerSec: [35.5, 40.5],
    hydroplaneWedgeRefMm: 0.92,
    dryBaseEfficiency: 0.895,
    wetPeakEfficiency: 0.915,
  },
  front: {
    fz0N: FRONT_FZ0_N,
    dy0: 1.71,
    dx0: 1.77,
    lsExpY: 0.9,
    lsExpX: 0.915,
    highLoadSaturationBeta: 0.026,
    peakSlipAngleDeg0: 6.55,
    optimalHotPsi: 23.5,
    sidewallBaseRateNm: 138_000,
    pneumaticRatePerPsiNm: 7_000,
  },
  rear: {
    fz0N: REAR_FZ0_N,
    dy0: 1.755,
    dx0: 1.835,
    lsExpY: 0.912,
    lsExpX: 0.926,
    highLoadSaturationBeta: 0.022,
    peakSlipAngleDeg0: 6.0,
    optimalHotPsi: 21.5,
    sidewallBaseRateNm: 148_000,
    pneumaticRatePerPsiNm: 8_000,
  },
};

/** Blue-walled Cinturato Full Wet (`35–40 °C` unblanketed, `2.0–5.5 mm` heavy standing water, `~80 L/s` @ `300 km/h`) */
export const LC26_FULL_WET_SPEC: Lc26CompoundSpec = {
  id: 'wet',
  displayName: 'Pirelli Cinturato 2026 Full Wet',
  hardnessRank: 7,
  isRain: true,
  blanketPreheatC: 37, // FIA Sporting Regs: zero blankets permitted (35–40 °C warm ambient/pit start)
  optimalWindowC: [40, 64],
  grainColdThresholdC: 26,
  blisterCoreThresholdC: 88,
  wearEnduranceSlidingKm: 32.0,
  flatSpotSoftness: 1.25,
  thermalModel: {
    surfaceCapJK: 1320,
    bulkCapJK: 4400,
    coreCapJK: 8850,
    slipHeatToSurfaceShare: 0.35,
    hysteresisCoeff: 0.0126,
    surfaceToBulkWK: 58,
    bulkToCoreWK: 45,
    surfaceConvectiveWK: [5.8, 0.66],
    bulkConvectiveWK: [4.6, 0.25],
    coreConvectiveWK: [6.8, 0.2],
    coldGripAt20C: 0.915,
    coldDropExponent: 1.3,
    hotDropPerDegSq: 0.00034, // Tall 5.5 mm sipes squirm & overheat aggressively on dry asphalt
  },
  wet: {
    traits: {
      dryGrip: 0.82,
      wetGrip: 0.94,
      clearMm: 3.35,
      treadDepthMm: 5.5,
      tempShiftC: -45.5,
      dryWearScale: 4.2,
      dryHeatScale: 1.55,
      wetWearScale: 0.72,
    },
    // Mean 80.0 L/s at 300 km/h across narrowed front (75.0 L/s) & rear (85.0 L/s) deep aqueduct channels
    maxEvacAt300KmhLitresPerSec: [75.0, 85.0],
    hydroplaneWedgeRefMm: 1.42,
    dryBaseEfficiency: 0.8,
    wetPeakEfficiency: 0.875,
  },
  front: {
    fz0N: FRONT_FZ0_N,
    dy0: 1.56,
    dx0: 1.62,
    lsExpY: 0.905,
    lsExpX: 0.92,
    highLoadSaturationBeta: 0.025,
    peakSlipAngleDeg0: 7.05,
    optimalHotPsi: 23.0,
    sidewallBaseRateNm: 134_000,
    pneumaticRatePerPsiNm: 6_850,
  },
  rear: {
    fz0N: REAR_FZ0_N,
    dy0: 1.6,
    dx0: 1.67,
    lsExpY: 0.916,
    lsExpX: 0.928,
    highLoadSaturationBeta: 0.021,
    peakSlipAngleDeg0: 6.45,
    optimalHotPsi: 21.0,
    sidewallBaseRateNm: 144_000,
    pneumaticRatePerPsiNm: 7_850,
  },
};

export const LC26_ALL_COMPOUND_SPECS: Record<Lc26CompoundId, Lc26CompoundSpec> = {
  ...LC26_SLICK_SPECS,
  intermediate: LC26_INTERMEDIATE_SPEC,
  wet: LC26_FULL_WET_SPEC,
};

export function getLc26CompoundSpec(id: Lc26CompoundId): Lc26CompoundSpec {
  return LC26_ALL_COMPOUND_SPECS[id];
}

// ---------------------------------------------------------------------------
// 3. Analytical Curves: Negative Load Sensitivity, Viscoelastic Grip & Wear
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * First-principles load-sensitive peak friction coefficient `mu(Fz)` for narrowed 2026 contact patches.
 *
 * Combines molecular-adhesion power-law decay `(Fz / Fz0)^(n_ls - 1)` (`n_ls < 1`) with high-pressure
 * asperity contact saturation `exp(-beta * (Fz - Fz0) / Fz0)` (`beta > 0`).
 * Because `n_ls < 1` and `beta > 0`, `d(mu) / d(Fz) < 0` holds STRICTLY for all `Fz > 0`
 * (including the entire `1 kN .. 14 kN` F1 vertical-load envelope), while `F_peak = mu(Fz) * Fz`
 * remains strictly increasing across `1 kN .. 14 kN`.
 */
export function evaluateLc26LoadSensitiveMu(
  compound: Lc26CompoundId | Lc26CompoundSpec,
  fzN: number,
  isRearAxle: boolean,
  axis: 'x' | 'y' = 'y',
): number {
  const spec = typeof compound === 'string' ? LC26_ALL_COMPOUND_SPECS[compound] : compound;
  const axle = isRearAxle ? spec.rear : spec.front;
  const fzSafe = Math.max(10, fzN);
  const ratio = fzSafe / axle.fz0N;
  const mu0 = axis === 'y' ? axle.dy0 : axle.dx0;
  const lsExp = axis === 'y' ? axle.lsExpY : axle.lsExpX;
  const powerTerm = Math.pow(ratio, lsExp - 1);
  const saturationTerm = Math.exp(-axle.highLoadSaturationBeta * (ratio - 1));
  return mu0 * powerTerm * saturationTerm;
}

/** Synthesizes solver `LutPoints` (`250 N .. 18,000 N`) directly from `evaluateLc26LoadSensitiveMu` */
function buildAnalyticalLoadCurve(spec: Lc26CompoundSpec, isRearAxle: boolean, axis: 'x' | 'y'): LutPoints {
  const pts: [number, number][] = [];
  for (let fz = 250; fz <= 18_000; fz += 500) {
    pts.push([fz, Number(evaluateLc26LoadSensitiveMu(spec, fz, isRearAxle, axis).toFixed(5))]);
    if (fz === 250) fz = 500; // 250, 1000, 1500, ..., 18000
  }
  return pts;
}

/**
 * Analytical viscoelastic rubber thermal grip master curve `g(T)` (`0..1`):
 * - Rises smoothly from glassy/stiff regime below `optimalWindowC[0]` (`70 °C` blankets -> `90–105 °C` peak).
 * - Holds `1.000` across `[optimalWindowC[0], optimalWindowC[1]]`.
 * - Falls off progressively above `optimalWindowC[1]` due to polymer hysteretic softening & thermal reversion.
 */
export function evaluateLc26ViscoelasticThermalMultiplier(
  compound: Lc26CompoundId | Lc26CompoundSpec,
  effectiveTempC: number,
): number {
  const spec = typeof compound === 'string' ? LC26_ALL_COMPOUND_SPECS[compound] : compound;
  const [lowC, highC] = spec.optimalWindowC;
  if (effectiveTempC >= lowC && effectiveTempC <= highC) {
    return 1.0;
  }
  if (effectiveTempC < lowC) {
    const span = Math.max(15, lowC - 20);
    const u = Math.max(0, (lowC - effectiveTempC) / span);
    const maxDrop = 1 - spec.thermalModel.coldGripAt20C;
    const coldMult = 1 - maxDrop * Math.pow(u, spec.thermalModel.coldDropExponent);
    return clamp(coldMult, 0.62, 1.0);
  }
  const overC = effectiveTempC - highC;
  const hotLoss = spec.thermalModel.hotDropPerDegSq * overC * (overC + 14);
  return clamp(1 / (1 + hotLoss), 0.58, 1.0);
}

function buildAnalyticalThermalLut(spec: Lc26CompoundSpec): LutPoints {
  const sampleTemps = [
    0,
    15,
    30,
    45,
    60,
    70,
    80,
    spec.optimalWindowC[0] - 4,
    spec.optimalWindowC[0],
    0.5 * (spec.optimalWindowC[0] + spec.optimalWindowC[1]),
    spec.optimalWindowC[1],
    spec.optimalWindowC[1] + 5,
    spec.optimalWindowC[1] + 15,
    spec.optimalWindowC[1] + 30,
    spec.optimalWindowC[1] + 50,
  ];
  const uniqueSorted = [...new Set(sampleTemps.map((t) => Number(t.toFixed(1))))].sort((a, b) => a - b);
  return uniqueSorted.map((t) => [t, Number(evaluateLc26ViscoelasticThermalMultiplier(spec, t).toFixed(5))]);
}

/** Synthesizes radial tyre spring rate curve `k_z(P_gauge)` (N/m) from sidewall + pneumatic membrane physics */
export function evaluateLc26RadialSpringRateNm(
  compound: Lc26CompoundId | Lc26CompoundSpec,
  gaugePsi: number,
  isRearAxle: boolean,
  coreTempC = 98,
): number {
  const spec = typeof compound === 'string' ? LC26_ALL_COMPOUND_SPECS[compound] : compound;
  const axle = isRearAxle ? spec.rear : spec.front;
  const psiSafe = clamp(gaugePsi, 8, 40);
  const baseRate = axle.sidewallBaseRateNm + axle.pneumaticRatePerPsiNm * psiSafe;
  const refC = 0.5 * (spec.optimalWindowC[0] + spec.optimalWindowC[1]);
  const carcassThermalFactor = clamp(1 - 0.0011 * (coreTempC - refC), 0.78, 1.12);
  return baseRate * carcassThermalFactor;
}

function buildAnalyticalPressureSpringLut(axle: Lc26AxleFrictionSpec): LutPoints {
  return [14, 18, 21, 24.5, 28, 32].map((psi) => [
    psi,
    Math.round(axle.sidewallBaseRateNm + axle.pneumaticRatePerPsiNm * psi),
  ]);
}

/** Non-linear tread-wear grip curve (`remainingLife01: 1.0 -> 0.0`), including carcass-cord cliff below 20% life */
export function evaluateLc26WearGripMultiplier(remainingLife01: number): number {
  const life = clamp(remainingLife01, 0, 1);
  const used = 1 - life;
  // Gentle 6.5% degradation across first 78% of tread depth, then sharp cord-exposure cliff
  const linearDecay = 0.065 * used;
  const cliffProgress = Math.max(0, (0.22 - life) / 0.22);
  const cliffLoss = 0.255 * cliffProgress * cliffProgress;
  return clamp(1 - linearDecay - cliffLoss, 0.68, 1.0);
}

function buildAnalyticalWearCurve(spec: Lc26CompoundSpec): LutPoints {
  const endKm = spec.wearEnduranceSlidingKm;
  const fractions = [0, 0.15, 0.35, 0.55, 0.72, 0.82, 0.9, 0.96, 1.0];
  return fractions.map((u) => {
    const km = Number((u * endKm).toFixed(2));
    const pct = Number((evaluateLc26WearGripMultiplier(1 - u) * 100).toFixed(2));
    return [km, pct];
  });
}

/** Contact-patch uniformity grip multiplier vs inflation pressure deviation from `optimalHotPsi` */
export function evaluateLc26PressureGripMultiplier(
  compound: Lc26CompoundId | Lc26CompoundSpec,
  dynamicPsi: number,
  isRearAxle: boolean,
): number {
  const spec = typeof compound === 'string' ? LC26_ALL_COMPOUND_SPECS[compound] : compound;
  const optPsi = isRearAxle ? spec.rear.optimalHotPsi : spec.front.optimalHotPsi;
  const relErr = (dynamicPsi - optPsi) / optPsi;
  // Parabolic crown/shoulder footprint distortion penalty + small linear term
  const loss = 1.45 * relErr * relErr + 0.0022 * Math.abs(dynamicPsi - optPsi);
  return clamp(1 / (1 + loss), 0.72, 1.0);
}

// ---------------------------------------------------------------------------
// 4. Analytical Brush Pneumatic Trail & Lateral Force (`t_p(alpha, Fz)`)
// ---------------------------------------------------------------------------

export interface Lc26PneumaticTrailInput {
  readonly slipAngleRad: number;
  readonly fzN: number;
  readonly isRearAxle?: boolean;
  readonly compound?: Lc26CompoundId;
  readonly carcassDynamicPsi?: number;
  readonly coreTempC?: number;
  readonly graining01?: number;
  readonly waterFilmMm?: number;
  readonly speedMs?: number;
}

export interface Lc26PneumaticTrailOutput {
  /** Pneumatic trail `t_p` (m): `> 0` ahead of patch center at small slip, `<= 0` past `alpha_peak` */
  readonly pneumaticTrailM: number;
  /** Contact-patch half-length `a` (m) */
  readonly patchHalfLengthM: number;
  /** Peak lateral slip angle `alpha_peak` (rad) at current load & carcass state */
  readonly peakSlipAngleRad: number;
  /** Lateral tyre force `Fy` (N, opposing slip angle) */
  readonly lateralForceN: number;
  /** Self-aligning torque `Mz` (Nm) = `-Fy * pneumaticTrailM` */
  readonly aligningTorqueNm: number;
}

/**
 * Computes analytical brush-model contact-patch half-length, peak slip angle, lateral force,
 * and pneumatic trail `t_p(alpha, Fz)` for 500 Hz WebHID kingpin FFB & vehicle handling analysis.
 *
 * Physical behaviour:
 * - At small slip angles (`|alpha| << alpha_peak`), elastic bristle shear builds from leading to
 *   trailing edge while rolling hysteresis shifts normal pressure slightly forward, placing
 *   `t_p(0, Fz) = 0.36 * a(Fz)` (`~28–42 mm`) ahead of patch center.
 * - As `|alpha|` approaches `alpha_peak`, the sliding zone invades from the trailing edge toward
 *   the leading edge and `t_p` decays strictly monotonically.
 * - Just past `alpha_peak` (`|tan(alpha)| > 1.06 * tan(alpha_peak)`), `t_p` passes smoothly (`C^1`)
 *   through zero and dips mildly negative (`~ -1.5 to -2.5 mm`) due to carcass belt shear and
 *   leading-edge rolling pressure offset, naturally lightening WebHID steering FFB on understeer!
 */
export function evaluateLc26PneumaticTrail(input: Lc26PneumaticTrailInput): Lc26PneumaticTrailOutput {
  const isRear = input.isRearAxle ?? false;
  const compoundId = input.compound ?? 'C3';
  const spec = LC26_ALL_COMPOUND_SPECS[compoundId];
  const axle = isRear ? spec.rear : spec.front;
  const geo = isRear ? LC26_REAR_TYRE_GEOMETRY : LC26_FRONT_TYRE_GEOMETRY;

  if (!(input.fzN > 1)) {
    return {
      pneumaticTrailM: 0,
      patchHalfLengthM: 0.065,
      peakSlipAngleRad: (axle.peakSlipAngleDeg0 * Math.PI) / 180,
      lateralForceN: 0,
      aligningTorqueNm: 0,
    };
  }

  const fz = input.fzN;
  const coreC = input.coreTempC ?? 0.5 * (spec.optimalWindowC[0] + spec.optimalWindowC[1]);
  const psi = input.carcassDynamicPsi ?? axle.optimalHotPsi;
  const graining = clamp(input.graining01 ?? 0, 0, 1);
  const waterMm = Math.max(0, input.waterFilmMm ?? 0);
  const speedMs = Math.max(0, input.speedMs ?? 55);

  const kz = evaluateLc26RadialSpringRateNm(spec, psi, isRear, coreC);
  const deflectionM = clamp(fz / kz, 0.001, 0.065);
  const chordHalfM = 0.86 * Math.sqrt(Math.max(0, 2 * geo.radius * deflectionM - deflectionM * deflectionM));
  const patchHalfLengthM = Math.max(0.068, chordHalfM);

  // Peak slip angle grows mildly with vertical load (saturated cornering stiffness) & carcass warmth/graining
  const tanPeak0 = Math.tan((axle.peakSlipAngleDeg0 * Math.PI) / 180);
  const loadSlipFactor = 1 + 0.072 * ((fz - axle.fz0N) / axle.fz0N);
  const pressureRatio = psi / axle.optimalHotPsi;
  const pressureSlipFactor = 1 / (1 + 0.09 * (pressureRatio - 1));
  const grainSoftening = 1 + 0.22 * graining;
  const tanPeak = Math.max(0.35 * tanPeak0, tanPeak0 * loadSlipFactor * pressureSlipFactor * grainSoftening);
  const peakSlipAngleRad = Math.atan(tanPeak);

  const tanAlpha = Math.tan(clamp(input.slipAngleRad, -1.25, 1.25));
  const absTanAlpha = Math.abs(tanAlpha);
  const sigma = absTanAlpha / tanPeak;

  // Brush cubic rising branch + smooth high-slip sliding decay
  let forceShare: number;
  if (sigma <= 1) {
    const free = 1 - sigma;
    forceShare = 1 - free * free * free;
  } else {
    const falloffLevel = 0.855;
    forceShare = falloffLevel + (1 - falloffLevel) / (1 + 2.8 * (sigma - 1));
  }

  const muLoad = evaluateLc26LoadSensitiveMu(spec, fz, isRear, 'y');
  const thermalMult = evaluateLc26ViscoelasticThermalMultiplier(spec, coreC);
  const pressMult = evaluateLc26PressureGripMultiplier(spec, psi, isRear);
  const grainMult = 1 - 0.12 * graining;
  const wetContact =
    waterMm > 0 ? evaluateLc26WetContactBySpec(spec, speedMs, waterMm, 0.35, isRear).wetGripMultiplier : 1.0;

  const peakFy = muLoad * thermalMult * pressMult * grainMult * wetContact * fz;
  const sign = tanAlpha >= 0 ? -1 : 1;
  const lateralForceN = sign * peakFy * forceShare;

  // Initial trail ahead of patch center (36% of half-length), scaled by wet leading-edge hydrodynamic wedge
  const wetTrailScale = waterMm > 0 ? wetPneumaticTrailScale(spec.wet.traits, waterMm, speedMs, 0) : 1.0;
  const trail0M = 0.36 * patchHalfLengthM * wetTrailScale;

  // C^1-continuous brush trail decaying strictly monotonically to 0 at sigmaZero = 1.06 (just past alpha_peak)
  // and dipping mildly negative (-6.5% of trail0M) in full understeer slide
  const sigmaZero = 1.06;
  const u = sigma / sigmaZero;
  let pneumaticTrailM: number;
  if (u <= 1) {
    const oneMinusU = 1 - u;
    pneumaticTrailM = (trail0M * (oneMinusU * oneMinusU * (1 + 0.35 * u))) / (1 + 0.85 * u * u);
  } else {
    const du = u - 1;
    pneumaticTrailM = -0.065 * trail0M * ((du * du) / (0.16 + du * du)) * Math.exp(-0.22 * du);
  }

  const aligningTorqueNm = -lateralForceN * pneumaticTrailM;

  return {
    pneumaticTrailM,
    patchHalfLengthM,
    peakSlipAngleRad,
    lateralForceN,
    aligningTorqueNm,
  };
}

// ---------------------------------------------------------------------------
// 5. Dedicated 3-Band × 3-Layer (`surface`, `bulk`, `core` + `psi`) Thermal Model
// ---------------------------------------------------------------------------

export interface Lc26CornerThermalStepInput {
  readonly dtS: number;
  readonly compound: Lc26CompoundId;
  readonly isRearAxle: boolean;
  readonly isLeftCorner?: boolean;
  readonly fzN: number;
  readonly speedMs: number;
  readonly slipAngleRad: number;
  readonly slipRatio: number;
  readonly camberRad?: number;
  readonly ambientTempC?: number;
  readonly trackTempC?: number;
  readonly waterFilmMm?: number;
  readonly offRubberedLine01?: number;
  readonly brakeDiscTempC?: number;
  /** Optional garage set pressure at `blanketPreheatC` (psi gauge); defaults to compound's ideal blanket pressure */
  readonly coldSetPsi?: number;
}

export interface Lc26CornerThermalEvaluation {
  readonly effectiveBandTempsC: readonly [inner: number, middle: number, outer: number];
  readonly meanSurfaceC: number;
  readonly meanBulkC: number;
  readonly thermalGripMultiplier: number;
  readonly pressureGripMultiplier: number;
  readonly grainingGripMultiplier: number;
  readonly blisteringGripMultiplier: number;
  readonly wearGripMultiplier: number;
  readonly wetGripMultiplier: number;
  readonly effectiveMuY: number;
  readonly effectiveMuX: number;
}

export interface Lc26CornerThermalStepOutput extends Lc26CornerThermalEvaluation {
  readonly state: Lc26CornerThermalState;
}

/** Computes default FIA tyre-blanket / garage gauge pressure (psi) that reaches `optimalHotPsi` in the window */
export function computeLc26DefaultBlanketPsi(compound: Lc26CompoundId | Lc26CompoundSpec, isRearAxle: boolean): number {
  const spec = typeof compound === 'string' ? LC26_ALL_COMPOUND_SPECS[compound] : compound;
  const axle = isRearAxle ? spec.rear : spec.front;
  const targetWindowMidC = 0.5 * (spec.optimalWindowC[0] + spec.optimalWindowC[1]);
  return Number(
    tyreGaugePressureAtTemperature(axle.optimalHotPsi, targetWindowMidC, spec.blanketPreheatC).toFixed(2),
  );
}

/** Creates initial 3-band × 3-layer corner thermal state at FIA pre-heat temperature (`70 °C` slicks, `60 °C` Inter, `37 °C` Wet) */
export function createLc26CornerThermalState(
  compound: Lc26CompoundId,
  isRearAxle: boolean,
  coldSetPsiOverride?: number,
): Lc26CornerThermalState {
  const spec = LC26_ALL_COMPOUND_SPECS[compound];
  const t0 = spec.blanketPreheatC;
  const setPsi = coldSetPsiOverride ?? computeLc26DefaultBlanketPsi(spec, isRearAxle);
  return {
    surfaceBandsC: [t0, t0, t0],
    bulkBandsC: [t0, t0, t0],
    coreC: t0,
    carcassDynamicPsi: setPsi,
    graining01: 0,
    blistering01: 0,
    remainingLife01: 1.0,
  };
}

/**
 * Computes 3-band (`inner`, `middle`, `outer`) contact load shares from SAE camber
 * (`camberRad < 0` = negative camber, top leaned inboard on any corner), lateral cornering
 * roll-over (`+fyOutboardRatio` shifts toward outer shoulder), and crown inflation pressure.
 */
function computeBandLoadShares(
  camberRad: number,
  isLeftCorner: boolean,
  fyEstimateN: number,
  fzN: number,
  pressureRatio: number,
): [number, number, number] {
  // Negative SAE camber (`camberRad < 0`) shifts static contact patch load onto the inner shoulder (`band 0`).
  const camberInward = -camberRad;
  // Lateral force opposing slip rolls patch slightly toward the loaded shoulder
  const inwardSign = isLeftCorner ? -1 : 1;
  const latRollOutboard = (inwardSign * fyEstimateN) / Math.max(500, fzN);
  const shoulderBiasOutboard = clamp(-camberInward * 5.2 + latRollOutboard * 0.09, -0.72, 0.72);
  const pRel = clamp(pressureRatio - 1, -0.35, 0.35);
  const crownBoost = Math.max(0.55, 1 + 0.9 * pRel);
  const shoulderScale = Math.max(0.55, 1 - 0.45 * pRel);

  const sInner = Math.max(0.08, (1 - shoulderBiasOutboard) * 0.33 * shoulderScale);
  const sMid = Math.max(0.12, 0.34 * crownBoost);
  const sOuter = Math.max(0.08, (1 + shoulderBiasOutboard) * 0.33 * shoulderScale);
  const invSum = 1 / (sInner + sMid + sOuter);
  return [sInner * invSum, sMid * invSum, sOuter * invSum];
}

/** Pure evaluator computing instantaneous grip multipliers & effective `muY`/`muX` from a 3-layer thermal state */
export function evaluateLc26CornerThermalGrip(
  compound: Lc26CompoundId,
  state: Lc26CornerThermalState,
  options?: {
    readonly isRearAxle?: boolean;
    readonly fzN?: number;
    readonly waterFilmMm?: number;
    readonly speedMs?: number;
    readonly offRubberedLine01?: number;
    readonly bandShares?: readonly [number, number, number];
  },
): Lc26CornerThermalEvaluation {
  const spec = LC26_ALL_COMPOUND_SPECS[compound];
  const isRear = options?.isRearAxle ?? false;
  const fzN = options?.fzN ?? (isRear ? REAR_FZ0_N : FRONT_FZ0_N);
  const waterFilmMm = Math.max(0, options?.waterFilmMm ?? 0);
  const speedMs = Math.max(0, options?.speedMs ?? 60);
  const offLine01 = clamp(options?.offRubberedLine01 ?? 0, 0, 1);
  const shares = options?.bandShares ?? [0.36, 0.34, 0.3];

  // Effective working rubber temperature blends bulk viscoelastic belt layer (65%) + flash tread skin (35%)
  const eff0 = 0.65 * state.bulkBandsC[0] + 0.35 * state.surfaceBandsC[0];
  const eff1 = 0.65 * state.bulkBandsC[1] + 0.35 * state.surfaceBandsC[1];
  const eff2 = 0.65 * state.bulkBandsC[2] + 0.35 * state.surfaceBandsC[2];

  const thermalGripMultiplier =
    shares[0] * evaluateLc26ViscoelasticThermalMultiplier(spec, eff0) +
    shares[1] * evaluateLc26ViscoelasticThermalMultiplier(spec, eff1) +
    shares[2] * evaluateLc26ViscoelasticThermalMultiplier(spec, eff2);

  const pressureGripMultiplier = evaluateLc26PressureGripMultiplier(spec, state.carcassDynamicPsi, isRear);
  // Cold-tearing graining reduces peak mechanical grip up to 12%; hot-core blistering inflicts up to 18% structural loss
  const grainingGripMultiplier = 1 - 0.12 * clamp(state.graining01, 0, 1);
  const blisteringGripMultiplier = 1 - 0.18 * clamp(state.blistering01, 0, 1);
  const wearGripMultiplier = evaluateLc26WearGripMultiplier(state.remainingLife01);

  const wetGripMultiplier =
    waterFilmMm > 0 || spec.isRain
      ? evaluateLc26WetContactBySpec(spec, speedMs, waterFilmMm, offLine01, isRear, 1 - state.remainingLife01)
          .wetGripMultiplier / (spec.isRain && waterFilmMm === 0 ? spec.wet.dryBaseEfficiency : 1)
      : 1.0;

  const combinedMod =
    thermalGripMultiplier *
    pressureGripMultiplier *
    grainingGripMultiplier *
    blisteringGripMultiplier *
    wearGripMultiplier *
    wetGripMultiplier;

  const effectiveMuY = evaluateLc26LoadSensitiveMu(spec, fzN, isRear, 'y') * combinedMod;
  const effectiveMuX = evaluateLc26LoadSensitiveMu(spec, fzN, isRear, 'x') * combinedMod;

  const meanSurfaceC = (state.surfaceBandsC[0] + state.surfaceBandsC[1] + state.surfaceBandsC[2]) / 3;
  const meanBulkC = (state.bulkBandsC[0] + state.bulkBandsC[1] + state.bulkBandsC[2]) / 3;

  return {
    effectiveBandTempsC: [eff0, eff1, eff2],
    meanSurfaceC,
    meanBulkC,
    thermalGripMultiplier,
    pressureGripMultiplier,
    grainingGripMultiplier,
    blisteringGripMultiplier,
    wearGripMultiplier,
    wetGripMultiplier,
    effectiveMuY,
    effectiveMuX,
  };
}

/**
 * Advances the 3-band (`inner`, `middle`, `outer`) × 3-layer (`surface`, `bulk`, `core`) thermal ODE,
 * dynamic ideal-gas carcass pressure (`psi`), cold-sliding graining, hot-core structural blistering,
 * and compound-graduated tread wear.
 */
export function stepLc26CornerThermal(
  prev: Lc26CornerThermalState,
  input: Lc26CornerThermalStepInput,
): Lc26CornerThermalStepOutput {
  const spec = LC26_ALL_COMPOUND_SPECS[input.compound];
  const axle = input.isRearAxle ? spec.rear : spec.front;
  const areaScale = input.isRearAxle ? REAR_THERMAL_AREA_SCALE : 1.0;
  const isLeft = input.isLeftCorner ?? true;
  // Standard SAE camber convention: negative = top of tyre leaned inboard toward vehicle centreline
  const defaultCamberRad = ((input.isRearAxle ? -1.75 : -3.1) * Math.PI) / 180;
  const camberRad = input.camberRad ?? defaultCamberRad;
  const ambientC = input.ambientTempC ?? 27;
  const trackC = input.trackTempC ?? 41;
  const waterFilmMm = Math.max(0, input.waterFilmMm ?? 0);
  const offLine01 = clamp(input.offRubberedLine01 ?? 0, 0, 1);
  const brakeDiscC = input.brakeDiscTempC ?? 420;
  const setPsi = input.coldSetPsi ?? computeLc26DefaultBlanketPsi(spec, input.isRearAxle);

  const fz = Math.max(0, input.fzN);
  const v = Math.max(0, Math.abs(input.speedMs));
  const wetness = wetnessFromWater(waterFilmMm);

  let surf0 = prev.surfaceBandsC[0];
  let surf1 = prev.surfaceBandsC[1];
  let surf2 = prev.surfaceBandsC[2];
  let bulk0 = prev.bulkBandsC[0];
  let bulk1 = prev.bulkBandsC[1];
  let bulk2 = prev.bulkBandsC[2];
  let coreC = prev.coreC;
  let graining01 = clamp(prev.graining01, 0, 1);
  let blistering01 = clamp(prev.blistering01, 0, 1);
  let remainingLife01 = clamp(prev.remainingLife01, 0, 1);
  let dynamicPsi = prev.carcassDynamicPsi;

  const totalDt = Math.max(0, input.dtS);
  if (totalDt > 0) {
    // Internal sub-stepping guarantees unconditional stability even for coarse caller steps (e.g. 0.1 s)
    const steps = Math.max(1, Math.ceil(totalDt / 0.01));
    const h = totalDt / steps;

    const th = spec.thermalModel;
    const surfBandCap = (th.surfaceCapJK * areaScale) / 3;
    const bulkBandCap = (th.bulkCapJK * areaScale) / 3;
    const coreCap = th.coreCapJK * areaScale;

    const gSurfToBulk = (th.surfaceToBulkWK * areaScale) / 3;
    const gBulkToCore = (th.bulkToCoreWK * areaScale) / 3;
    const gSurfConv = ((th.surfaceConvectiveWK[0] + th.surfaceConvectiveWK[1] * v) * areaScale) / 3;
    const extWetWK = wetExternalGasCoolingWK(wetness, v);
    const gBulkConv = ((th.bulkConvectiveWK[0] + th.bulkConvectiveWK[1] * v + 0.6 * extWetWK) * areaScale) / 3;
    const gCoreConv = (th.coreConvectiveWK[0] + th.coreConvectiveWK[1] * v + 0.4 * extWetWK) * areaScale;
    const gRoadBase = (30 + wetRoadCoolingWK(wetness, v)) * areaScale;
    const gCrossSurf = 2.4 * areaScale;
    const gCrossBulk = 8.5 * areaScale;
    // Wheel-hub / carbon-disc radiative bleed into rim & inner cavity (~0.18 W/K front, ~0.13 W/K rear)
    const gBrakeToCore = input.isRearAxle ? 0.13 : 0.18;

    const heatMult = wetHeatScale(spec.wet.traits, wetness);
    const wearWetMult = wetWearScale(spec.wet.traits, wetness);

    const tanAlpha = Math.tan(clamp(input.slipAngleRad, -1.2, 1.2));
    const slipVelY = v * Math.abs(tanAlpha);
    const slipVelX = v * Math.abs(input.slipRatio);
    const slipSpeedMs = Math.hypot(slipVelX, slipVelY);

    const tanPeak0 = Math.tan((axle.peakSlipAngleDeg0 * Math.PI) / 180);
    const normSlip = Math.hypot(input.slipRatio / 0.095, tanAlpha / tanPeak0);
    const utilizedShare = normSlip <= 1 ? 1 - Math.pow(1 - normSlip, 3) : 0.88;

    for (let s = 0; s < steps; s++) {
      const pRatio = dynamicPsi / axle.optimalHotPsi;
      const curEval = evaluateLc26CornerThermalGrip(
        input.compound,
        {
          surfaceBandsC: [surf0, surf1, surf2],
          bulkBandsC: [bulk0, bulk1, bulk2],
          coreC,
          carcassDynamicPsi: dynamicPsi,
          graining01,
          blistering01,
          remainingLife01,
        },
        { isRearAxle: input.isRearAxle, fzN: Math.max(500, fz), waterFilmMm, speedMs: v, offRubberedLine01: offLine01 },
      );

      const totalForceEstN = 0.5 * (curEval.effectiveMuY + curEval.effectiveMuX) * fz * utilizedShare;
      const fyEstN =
        normSlip > 1e-6 ? (-tanAlpha / Math.max(1e-6, Math.hypot(tanAlpha, input.slipRatio))) * totalForceEstN : 0;
      const shares = computeBandLoadShares(camberRad, isLeft, fyEstN, Math.max(500, fz), pRatio);

      // Under-inflated carcass flexes more; sliding friction power heats surface & bulk layers
      const flexPressureBoost = clamp(1 + 0.35 * (axle.optimalHotPsi / Math.max(10, dynamicPsi) - 1), 0.8, 1.4);
      const slipPowerW = totalForceEstN * slipSpeedMs * heatMult;
      const hystPowerW = th.hysteresisCoeff * fz * v * heatMult * flexPressureBoost;

      const sArr = [surf0, surf1, surf2];
      const bArr = [bulk0, bulk1, bulk2];
      let sumBulkToCoreW = 0;

      // Blok interfacial effusivity partition: `slipHeatToSurfaceShare` (~0.30-0.36) of total sliding
      // friction power enters the rubber (~74% flash surface skin, ~26% sub-surface bristle shear),
      // while the remaining ~64-70% conducts directly into the higher-effusivity stone road surface.
      const tyreSlipPowerW = th.slipHeatToSurfaceShare * slipPowerW;
      for (let b = 0; b < 3; b++) {
        const bandWeight = shares[b];
        const qSlipSurf = 0.74 * tyreSlipPowerW * bandWeight;
        const qSlipBulk = 0.26 * tyreSlipPowerW * bandWeight;
        const qHystBulk = 0.65 * hystPowerW * bandWeight;

        const qSurfToBulk = gSurfToBulk * (sArr[b] - bArr[b]);
        const qBulkToCore = gBulkToCore * (bArr[b] - coreC);
        sumBulkToCoreW += qBulkToCore;

        const qRoad = fz > 0 ? gRoadBase * bandWeight * (sArr[b] - trackC) : 0;
        const qSurfAir = gSurfConv * (sArr[b] - ambientC);
        const qBulkAir = gBulkConv * (bArr[b] - ambientC);

        sArr[b] += ((qSlipSurf - qSurfToBulk - qRoad - qSurfAir) / surfBandCap) * h;
        bArr[b] += ((qSlipBulk + qHystBulk + qSurfToBulk - qBulkToCore - qBulkAir) / bulkBandCap) * h;
      }

      // Cross-band lateral conduction (inner <-> middle <-> outer)
      const ds01 = ((gCrossSurf * (sArr[0] - sArr[1])) / surfBandCap) * h;
      const ds12 = ((gCrossSurf * (sArr[1] - sArr[2])) / surfBandCap) * h;
      sArr[0] -= ds01;
      sArr[1] += ds01 - ds12;
      sArr[2] += ds12;

      const db01 = ((gCrossBulk * (bArr[0] - bArr[1])) / bulkBandCap) * h;
      const db12 = ((gCrossBulk * (bArr[1] - bArr[2])) / bulkBandCap) * h;
      bArr[0] -= db01;
      bArr[1] += db01 - db12;
      bArr[2] += db12;

      surf0 = sArr[0];
      surf1 = sArr[1];
      surf2 = sArr[2];
      bulk0 = bArr[0];
      bulk1 = bArr[1];
      bulk2 = bArr[2];

      // Layer 3 (`coreC`): carcass inner liner + wheel rim conduction + sidewall hysteresis
      const qHystCore = 0.35 * hystPowerW;
      const qBrakeBleed = gBrakeToCore * (brakeDiscC - coreC);
      const qCoreAir = gCoreConv * (coreC - ambientC);
      coreC += ((qHystCore + sumBulkToCoreW + qBrakeBleed - qCoreAir) / coreCap) * h;

      // Dynamic ideal-gas inflation pressure (with wet rim spray cooling offset)
      const rimWetCoolDeltaC =
        rimWetEnvironmentCoolingWK(wetness, v) * 0.45 * Math.max(0, coreC - ambientC) * 0.02;
      const gasEffectiveC = Math.max(ambientC - 5, coreC - rimWetCoolDeltaC);
      dynamicPsi = tyreGaugePressureAtTemperature(setPsi, spec.blanketPreheatC, gasEffectiveC);

      const meanSurf = (surf0 + surf1 + surf2) / 3;
      const meanBulk = (bulk0 + bulk1 + bulk2) / 3;
      const [winLow, winHigh] = spec.optimalWindowC;

      // Cold-sliding graining buildup vs in-window smooth abrasion healing
      if (fz > 200 && v > 3) {
        if (meanBulk < spec.grainColdThresholdC && slipSpeedMs > 1.5 && slipPowerW > 4500) {
          const coldDeficit = (spec.grainColdThresholdC - meanBulk) / 16;
          const skinShearBoost = 1 + 0.035 * Math.max(0, meanSurf - meanBulk);
          const softnessFactor = 0.8 + 0.1 * Math.min(5, spec.hardnessRank);
          const dGrain =
            0.032 * coldDeficit * skinShearBoost * softnessFactor * (slipPowerW / 24_000) * (1 - wetness * 0.65);
          graining01 = clamp(graining01 + dGrain * h, 0, 1);
        } else if (meanBulk >= winLow - 2 && meanBulk <= winHigh + 6 && normSlip < 1.05) {
          // Smoothly driven in optimal window wears torn surface ripples clean
          const workClean = 0.028 * (0.4 + 0.6 * Math.min(1, normSlip)) * (v / 55) * (fz / axle.fz0N);
          graining01 = clamp(graining01 - workClean * h, 0, 1);
        }

        // Hot-core structural blistering when internal coreC exceeds compound threshold (irreversible)
        if (coreC > spec.blisterCoreThresholdC) {
          const overCore = coreC - spec.blisterCoreThresholdC;
          const loadFactor = 0.45 + 0.55 * (fz / axle.fz0N);
          const speedFactor = 0.35 + 0.65 * Math.min(1.3, v / 55);
          const dBlister = 0.0048 * overCore * (1 + 0.065 * overCore) * loadFactor * speedFactor;
          blistering01 = clamp(blistering01 + dBlister * h, 0, 1);
        }

        // Tread wear progression (`remainingLife01: 1.0 -> 0.0`), inversely proportional to `wearEnduranceSlidingKm`
        const overTempAccel =
          meanSurf > winHigh + 8 ? 1 + 0.035 * (meanSurf - (winHigh + 8)) : 1.0;
        const loadWearScale = Math.pow(Math.max(0.2, fz / axle.fz0N), 1.08);
        const effectiveSlideKm = ((slipSpeedMs + 0.0085 * v) * h * loadWearScale * wearWetMult * overTempAccel) / 1000;
        const lifeDelta = effectiveSlideKm / spec.wearEnduranceSlidingKm;
        remainingLife01 = clamp(remainingLife01 - lifeDelta, 0, 1);
      }
    }
  }

  const nextState: Lc26CornerThermalState = {
    surfaceBandsC: [surf0, surf1, surf2],
    bulkBandsC: [bulk0, bulk1, bulk2],
    coreC,
    carcassDynamicPsi: dynamicPsi,
    graining01,
    blistering01,
    remainingLife01,
  };

  const finalEval = evaluateLc26CornerThermalGrip(input.compound, nextState, {
    isRearAxle: input.isRearAxle,
    fzN: Math.max(500, fz),
    waterFilmMm,
    speedMs: v,
    offRubberedLine01: offLine01,
  });

  return {
    state: nextState,
    ...finalEval,
  };
}

// ---------------------------------------------------------------------------
// 6. Water-Film Evacuation, Hydroplaning & Dynamic Wet-Line Crossover
// ---------------------------------------------------------------------------

/**
 * Evaluates compound-specific water-film groove evacuation, residual hydrodynamic wedge thickness,
 * hydroplaning load-support loss, and off-line vs rubbered-racing-line grip crossover.
 *
 * Key physical regimes:
 * - Slicks (`C1`–`C5`): smooth tread squeezes only thin films; rapid hydroplaning onset above `0.5–0.8 mm`.
 * - Intermediate: `~38 L/s` groove pumping at `300 km/h` (`35.5 L/s` front, `40.5 L/s` rear), optimal across
 *   `0.4–2.2 mm` damp/drying conditions, penalized by tread-block squirm on bone-dry tarmac.
 * - Full Wet: `~80 L/s` deep-channel evacuation at `300 km/h` (`75.0 L/s` front, `85.0 L/s` rear), superior in
 *   heavy standing water (`2.0–5.5 mm`).
 * - Wet-line crossover (`offRubberedLine01`): on dry/nearly-dry tarmac (`waterFilmMm < 0.20 mm`), the rubbered
 *   racing line (`offRubberedLine01 = 0`) offers superior adhesive grip; once wet (`waterFilmMm > 0.30 mm`),
 *   vulcanized rubber seals asphalt pores (`wetGrooveGripEffect < 0`) so unrubbered high-macrotexture off-line
 *   tarmac (`offRubberedLine01 = 1`) yields meaningfully higher grip until the racing line dries out!
 */
export function evaluateLc26WetContactBySpec(
  spec: Lc26CompoundSpec,
  speedMs: number,
  waterFilmMm: number,
  offRubberedLine01: number,
  isRearAxle: boolean,
  wear01 = 0,
): Lc26WetEvacuationResult {
  const v = Math.max(0, Number.isFinite(speedMs) ? speedMs : 0);
  const h0Mm = Math.max(0, Number.isFinite(waterFilmMm) ? waterFilmMm : 0);
  const offLine = clamp(Number.isFinite(offRubberedLine01) ? offRubberedLine01 : 0, 0, 1);
  const onLineWeight = 1 - offLine;
  const wear = clamp(wear01, 0, 1);

  const widthM = isRearAxle ? LC26_TYRE_DIMENSIONS.rear.widthM : LC26_TYRE_DIMENSIONS.front.widthM;
  const vRef300Ms = 300 / 3.6; // 83.3333 m/s

  // Dry / wet racing-line rubber crossover factor:
  // - Dry line (h0 = 0): +3.5% rubbered adhesion on-line (1.035) vs -3.5% unrubbered off-line (0.965)
  // - Wet line (h0 > 0.3 mm): sealed rubbered groove loses grip (`wetGrooveGripEffect`) while exposed
  //   off-line aggregate micro-asperities add bite (+3.5%) and open-pore macro-drainage
  const dryLineFactor = 1.035 - 0.07 * offLine;
  const wetness = wetnessFromWater(h0Mm);
  const wetGroovePenalty = wetGrooveGripEffect(0.95, Math.max(wetness, h0Mm > 0.3 ? 0.52 : wetness), onLineWeight, 1);
  const wetOffLineBonus = 0.038 * offLine * smoothstep(0.18, 0.45, h0Mm);
  const wetLineBlend = smoothstep(0.12, 0.32, h0Mm);
  const wetSurfaceLineFactor = 1 + wetGroovePenalty + wetOffLineBonus;
  const lineGripFactor = dryLineFactor * (1 - wetLineBlend) + wetSurfaceLineFactor * wetLineBlend;

  if (h0Mm <= 0) {
    return {
      evacuatedLitresPerSec: 0,
      residualFilmMm: 0,
      hydroplaneFactor01: 0,
      wetGripMultiplier: clamp(spec.wet.dryBaseEfficiency * lineGripFactor, 0.05, 1.15),
    };
  }

  // Volumetric water swept by rolling tyre footprint: 1 m * 1 m * 1 mm = 1 Litre
  const sweptInflowLs = widthM * v * h0Mm;

  // Groove channel evacuation capacity scales with tread groove depth retention and speed
  const wearChannelRetention = spec.isRain ? 1 - 0.52 * wear : 1 - 0.15 * wear;
  const maxEvac300Ls = spec.wet.maxEvacAt300KmhLitresPerSec[isRearAxle ? 1 : 0] * wearChannelRetention;
  const baseClearCap300Mm = maxEvac300Ls / (widthM * vRef300Ms);
  // At lower speeds, water has longer residence time to escape laterally; off-line pores add macro-drainage
  const speedDrainFactor = v > 1 ? Math.pow(vRef300Ms / Math.max(12, v), 0.28) : 1.8;
  const offLinePoreDrainMm = 0.075 * offLine;
  const clearCapacityMm = baseClearCap300Mm * speedDrainFactor + offLinePoreDrainMm;
  const channelCapacityLs = widthM * v * clearCapacityMm;

  let evacuatedLitresPerSec = 0;
  let residualFilmMm = 0;
  if (v > 0.05 && channelCapacityLs > 1e-9) {
    // Smooth L^4 channel saturation curve: approaches `channelCapacityLs` asymptotically in deep flood
    const ratio = sweptInflowLs / channelCapacityLs;
    const ratio4 = ratio * ratio * ratio * ratio;
    evacuatedLitresPerSec = sweptInflowLs / Math.pow(1 + ratio4, 0.25);
    const clearedDepthMm = evacuatedLitresPerSec / (widthM * v);
    residualFilmMm = Math.max(0, h0Mm - clearedDepthMm);
  } else {
    // Stationary / creeping tyre squeezes standing water out down to thin static boundary film
    evacuatedLitresPerSec = 0;
    residualFilmMm = spec.isRain ? Math.max(0, h0Mm - clearCapacityMm) : Math.min(h0Mm, 0.08);
  }

  // Dynamic hydroplaning lift factor (Horne v^2 wedge onset above ~36–170 km/h when residual wedge > ref)
  const hydroSpeedGate = smoothstep(8, 46, v);
  const wedgeRatio = (residualFilmMm / spec.wet.hydroplaneWedgeRefMm) * hydroSpeedGate;
  const hydroplaneFactor01 =
    wedgeRatio <= 0 ? 0 : clamp(1 - Math.exp(-1.55 * Math.pow(wedgeRatio, 1.65)), 0, 1);

  // Compound surface-film viscoelastic/boundary efficiency before hydroplaning load loss
  let compoundFilmEfficiency: number;
  if (!spec.isRain) {
    // Un-grooved slicks retain dry advantage on < 0.2 mm trace dampness, then lose boundary grip rapidly
    const slickWetLoss = smoothstep(0.04, 0.62, h0Mm);
    compoundFilmEfficiency = 1 - (1 - spec.wet.wetPeakEfficiency) * slickWetLoss;
  } else if (spec.id === 'intermediate') {
    // High-silica Intermediate activates on damp film, peaking in 0.4–1.8 mm before heavy flood cooling/saturation
    const dampActivation = smoothstep(0.02, 0.42, h0Mm);
    const deepFloodTaper = 0.045 * smoothstep(1.8, 4.2, h0Mm);
    compoundFilmEfficiency =
      spec.wet.dryBaseEfficiency +
      (spec.wet.wetPeakEfficiency - spec.wet.dryBaseEfficiency) * dampActivation -
      deepFloodTaper;
  } else {
    // Full Wet sipes stabilize as water cools & supports tread blocks, excelling across 2.0–5.5 mm
    const wetActivation = smoothstep(0.15, 1.6, h0Mm);
    compoundFilmEfficiency =
      spec.wet.dryBaseEfficiency + (spec.wet.wetPeakEfficiency - spec.wet.dryBaseEfficiency) * wetActivation;
  }

  const hydroRetention = 1 - 0.92 * hydroplaneFactor01;
  const wetGripMultiplier = clamp(compoundFilmEfficiency * hydroRetention * lineGripFactor, 0.04, 1.15);

  return {
    evacuatedLitresPerSec,
    residualFilmMm,
    hydroplaneFactor01,
    wetGripMultiplier,
  };
}

// ---------------------------------------------------------------------------
// 7. `TyresCompoundData` Builder for LibreCorsa 6-DOF `VehiclePhysics` Solver
// ---------------------------------------------------------------------------

const FRONT_CAMBER_DATA: TyresCamberData = {
  camberGain: 0.142,
  contact_camber_c1: 1.0,
  contact_camber_c2: 42.0,
  dcamber0: 1.08,
  dcamber1: -7.1,
  dcamber0_x: 0.0,
  dcamber1_x: -5.8,
};

const REAR_CAMBER_DATA: TyresCamberData = {
  camberGain: 0.162,
  contact_camber_c1: 1.0,
  contact_camber_c2: 42.0,
  dcamber0: 1.22,
  dcamber1: -11.2,
  dcamber0_x: 0.0,
  dcamber1_x: -6.2,
};

function buildAxleModelData(spec: Lc26CompoundSpec, isRear: boolean): TyresModelData {
  const axle = isRear ? spec.rear : spec.front;
  const relaxBase = spec.isRain ? (spec.id === 'wet' ? 0.112 : 0.106) : 0.098 + (spec.hardnessRank - 1) * 0.0015;
  const relax = isRear ? relaxBase * 1.03 : relaxBase;
  return {
    Dy0: axle.dy0,
    Dx0: axle.dx0,
    dyCurve: buildAnalyticalLoadCurve(spec, isRear, 'y'),
    dxCurve: buildAnalyticalLoadCurve(spec, isRear, 'x'),
    lsExpY: axle.lsExpY,
    lsExpX: axle.lsExpX,
    Fz0: axle.fz0N,
    curve: 'brush',
    friction_limit_angle: axle.peakSlipAngleDeg0,
    peakSlipLoadGain: 0.072,
    peakSlipLoadRefN: axle.fz0N,
    peakSlipPressureGain: 0.09,
    combinedExponent: 2.18,
    longStiffnessMult: 1.18,
    speedSensitivity: isRear ? 0.00155 : 0.00168,
    pKy2: isRear ? 4.8 : 3.3,
    slip_ratio_limit: 0.095,
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    use_slip_falloff: true,
    falloff_level: spec.isRain ? 0.89 : 0.855,
    falloff_slope: spec.isRain ? 1.7 : 2.8,
    relaxationLengthX: relax,
    relaxationLengthY: relax,
    rollingResistance: spec.isRain ? 0.0138 : 0.0118,
    rollingResistanceSpeedSq: 4.4e-7,
    rollingResistanceSlipGain: 0.04,
    rollingResistanceSlipMax: 2.0,
    verticalDamping: isRear ? 465 : 390,
    trailShare: 0.36, // Analytical parabolic+hysteresis initial pneumatic trail share
    brakeDxMod: 0.045,
  };
}

function buildAxlePressureData(spec: Lc26CompoundSpec, isRear: boolean): TyresPressureData {
  const axle = isRear ? spec.rear : spec.front;
  return {
    optimalPsi: axle.optimalHotPsi,
    pressureSpringCurve: buildAnalyticalPressureSpringLut(axle),
    pressureRollingGain: 0.28,
    pressureGripSensitivity: 1.45,
    pressureGripLossPerPsi: 0.0025,
    coldRefC: spec.blanketPreheatC,
  };
}

function buildThermalPatchData(spec: Lc26CompoundSpec): TyresThermalPatchData {
  const th = spec.thermalModel;
  return {
    thermalPerformanceCurve: buildAnalyticalThermalLut(spec),
    optimalTempC: [spec.optimalWindowC[0], spec.optimalWindowC[1]],
    surfaceHeatCapacity: th.surfaceCapJK,
    coreHeatCapacity: th.bulkCapJK + th.coreCapJK * 0.52,
    slipHeatShare: th.slipHeatToSurfaceShare,
    hysteresis: th.hysteresisCoeff,
    surfaceToCore: th.surfaceToBulkWK,
    surfaceCooling: [th.surfaceConvectiveWK[0], th.surfaceConvectiveWK[1]],
    coreCooling: [
      th.bulkConvectiveWK[0] + 0.65 * th.coreConvectiveWK[0],
      th.bulkConvectiveWK[1] + 0.65 * th.coreConvectiveWK[1],
    ],
    thermalVerticalK: -0.0011,
    thermalVerticalRefC: 0.5 * (spec.optimalWindowC[0] + spec.optimalWindowC[1]),
    tread: {
      grainGain: 0.11 + 0.008 * Math.min(5, spec.hardnessRank),
      grainGamma: 0.55,
      blisterGain: 0.1 + 0.012 * Math.min(5, spec.hardnessRank),
      blisterGamma: 0.55,
      wearOffWithSlip: true,
    },
    pressureHeat: {
      slipGain: 0.22,
      crownGain: 0.35,
    },
    bandSpread: {
      camber: 3.6,
      lateral: 0.22,
    },
  };
}

/**
 * Builds `[front: TyresCompoundData, rear: TyresCompoundData]` for a given `Lc26CompoundSpec`.
 * - `front` carries `rearOverride` so `VehiclePhysics` (`createTyreRuntime(front, true)`) resolves the
 *   exact rear-axle parameters seamlessly.
 * - `rear` also exposes the resolved rear-axle `modelData`, `camberData`, and `pressureData` at top level
 *   for direct per-axle consumers.
 */
export function buildLc26CompoundPair(
  spec: Lc26CompoundSpec,
  shortName: 'S' | 'M' | 'H' | 'I' | 'W',
  physicsCompound: PhysicsTyreCompound,
  labelOverride?: string,
): readonly [front: TyresCompoundData, rear: TyresCompoundData] {
  const frontModel = buildAxleModelData(spec, false);
  const rearModel = buildAxleModelData(spec, true);
  const frontPressure = buildAxlePressureData(spec, false);
  const rearPressure = buildAxlePressureData(spec, true);
  const thermalData = buildThermalPatchData(spec);
  const wearCurve = buildAnalyticalWearCurve(spec);
  const name = labelOverride ?? spec.displayName;

  const frontCompound: TyresCompoundData = {
    name,
    shortName,
    tyre_compound: physicsCompound,
    wetTraits: spec.wet.traits,
    wear: {
      curve: wearCurve,
      loadScaled: true,
      loadRefN: FRONT_FZ0_N,
    },
    flatSpotSoftness: spec.flatSpotSoftness,
    front: LC26_FRONT_TYRE_GEOMETRY,
    rear: LC26_REAR_TYRE_GEOMETRY,
    modelData: frontModel,
    thermalData,
    pressureData: frontPressure,
    camberData: FRONT_CAMBER_DATA,
    rearOverride: {
      modelData: rearModel,
      camberData: REAR_CAMBER_DATA,
      pressureData: rearPressure,
    },
  };

  const rearCompound: TyresCompoundData = {
    name,
    shortName,
    tyre_compound: physicsCompound,
    wetTraits: spec.wet.traits,
    wear: {
      curve: wearCurve,
      loadScaled: true,
      loadRefN: REAR_FZ0_N,
    },
    flatSpotSoftness: spec.flatSpotSoftness,
    front: LC26_FRONT_TYRE_GEOMETRY,
    rear: LC26_REAR_TYRE_GEOMETRY,
    modelData: rearModel,
    thermalData,
    pressureData: rearPressure,
    camberData: REAR_CAMBER_DATA,
  };

  return [frontCompound, rearCompound] as const;
}

/** Pre-built `[front, rear]` `TyresCompoundData` database for all 5 Pirelli slick compounds (`C1`–`C5`) */
export const LC26_PIRELLI_SLICK_COMPOUNDS: Record<
  Lc26PirelliSlickCode,
  readonly [front: TyresCompoundData, rear: TyresCompoundData]
> = {
  C1: buildLc26CompoundPair(LC26_SLICK_SPECS.C1, 'H', 'PhysicsTyreCompound_F1_Hard', 'Pirelli P Zero C1'),
  C2: buildLc26CompoundPair(LC26_SLICK_SPECS.C2, 'H', 'PhysicsTyreCompound_F1_Hard', 'Pirelli P Zero C2'),
  C3: buildLc26CompoundPair(LC26_SLICK_SPECS.C3, 'M', 'PhysicsTyreCompound_F1_Medium', 'Pirelli P Zero C3'),
  C4: buildLc26CompoundPair(LC26_SLICK_SPECS.C4, 'S', 'PhysicsTyreCompound_F1_Soft', 'Pirelli P Zero C4'),
  C5: buildLc26CompoundPair(LC26_SLICK_SPECS.C5, 'S', 'PhysicsTyreCompound_F1_Soft', 'Pirelli P Zero C5'),
};

export const LC26_INTERMEDIATE_COMPOUND_PAIR = buildLc26CompoundPair(
  LC26_INTERMEDIATE_SPEC,
  'I',
  'PhysicsTyreCompound_F1_Intermediate',
);

export const LC26_FULL_WET_COMPOUND_PAIR = buildLc26CompoundPair(
  LC26_FULL_WET_SPEC,
  'W',
  'PhysicsTyreCompound_F1_Wet',
);

// ---------------------------------------------------------------------------
// 8. Weekend Compound Mapper (`buildLc26CompoundSet`) & Default Module
// ---------------------------------------------------------------------------

/**
 * Maps any valid FIA Grand Prix weekend Pirelli slick allocation `(hardCode, mediumCode, softCode)`
 * (where `hardCode` is strictly harder than `mediumCode`, and `mediumCode` is strictly harder than `softCode`,
 * e.g. `('C1', 'C2', 'C3')`, `('C2', 'C3', 'C4')`, `('C3', 'C4', 'C5')`, or step allocations `('C1', 'C3', 'C5')`)
 * alongside the 2026 Cinturato `intermediate` and `wet` compounds into a complete `Lc26TyresModule`.
 */
export function buildLc26CompoundSet(
  hardCode: Lc26PirelliSlickCode,
  mediumCode: Lc26PirelliSlickCode,
  softCode: Lc26PirelliSlickCode,
): Lc26TyresModule {
  const hardSpec = LC26_SLICK_SPECS[hardCode];
  const mediumSpec = LC26_SLICK_SPECS[mediumCode];
  const softSpec = LC26_SLICK_SPECS[softCode];

  if (!(hardSpec.hardnessRank < mediumSpec.hardnessRank && mediumSpec.hardnessRank < softSpec.hardnessRank)) {
    throw new RangeError(
      `Invalid LC-26 Pirelli weekend allocation (${hardCode}/${mediumCode}/${softCode}): expected strictly increasing softness C1 < C2 < C3 < C4 < C5.`,
    );
  }

  const slickFamilyMapping: Record<'soft' | 'medium' | 'hard', Lc26PirelliSlickCode> = {
    hard: hardCode,
    medium: mediumCode,
    soft: softCode,
  };

  const compounds: Record<CompoundSlot, readonly [front: TyresCompoundData, rear: TyresCompoundData]> = {
    hard: buildLc26CompoundPair(
      hardSpec,
      'H',
      'PhysicsTyreCompound_F1_Hard',
      `Pirelli P Zero Hard (${hardCode})`,
    ),
    medium: buildLc26CompoundPair(
      mediumSpec,
      'M',
      'PhysicsTyreCompound_F1_Medium',
      `Pirelli P Zero Medium (${mediumCode})`,
    ),
    soft: buildLc26CompoundPair(
      softSpec,
      'S',
      'PhysicsTyreCompound_F1_Soft',
      `Pirelli P Zero Soft (${softCode})`,
    ),
    intermediate: LC26_INTERMEDIATE_COMPOUND_PAIR,
    wet: LC26_FULL_WET_COMPOUND_PAIR,
  };

  const wetTraits: Record<CompoundSlot, WetTyreTraits> = {
    hard: hardSpec.wet.traits,
    medium: mediumSpec.wet.traits,
    soft: softSpec.wet.traits,
    intermediate: LC26_INTERMEDIATE_SPEC.wet.traits,
    wet: LC26_FULL_WET_SPEC.wet.traits,
  };

  const slotToSpec: Record<CompoundSlot, Lc26CompoundSpec> = {
    hard: hardSpec,
    medium: mediumSpec,
    soft: softSpec,
    intermediate: LC26_INTERMEDIATE_SPEC,
    wet: LC26_FULL_WET_SPEC,
  };

  return {
    compounds,
    slickFamilyMapping,
    wetTraits,
    evaluateWetContact(
      compound: CompoundSlot,
      speedMs: number,
      waterFilmMm: number,
      offRubberedLine01: number,
      isRearAxle: boolean,
    ): Lc26WetEvacuationResult {
      return evaluateLc26WetContactBySpec(
        slotToSpec[compound],
        speedMs,
        waterFilmMm,
        offRubberedLine01,
        isRearAxle,
      );
    },
  };
}

/** Convenience helper to evaluate a `TyresCompoundData` LUT directly during runtime or verification */
export function evaluateTyresCompoundThermalLut(compound: TyresCompoundData, tempC: number): number {
  return new Lut(compound.thermalData.thermalPerformanceCurve).evaluate(tempC);
}

/** Default LC-26 Grand Prix weekend tyre module (`C2` Hard / `C3` Medium / `C4` Soft + Intermediate + Full Wet) */
export const LC26_TYRES_MODULE: Lc26TyresModule = buildLc26CompoundSet('C2', 'C3', 'C4');
