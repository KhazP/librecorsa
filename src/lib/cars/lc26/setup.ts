/**
 * Garage Setup Schema, Presets, Validator, Physics Applier & 2026 AI Racecraft
 * Controller for the VeloSoft LC-26 (`lc26-f1`).
 *
 * Clean-room implementation conforming strictly to FIA 2026 Section C Issue 21
 * and `src/lib/cars/lc26/contract-types.ts`.
 *
 * - Fuel is tracked and configured strictly in `kg` (`5.0–100.0 kg` in `0.5 kg` steps).
 * - Suspension rates use `N/mm` (torsion bars & 3rd heave elements) and `Nm/deg` (ARBs).
 * - Ride heights & packers use `mm` referenced to the FIA Car Reference Plane (`Z_FIA = 0`).
 * - Pure 2026 AI Racecraft Controller manages Straight Mode (`throttle > 90%`),
 *   intelligent straight-end Super Clipping (`>= 12%` SoC reserve), and `< 1.0 s`
 *   Overtake Mode + tactical Boost deployment.
 */

import {
  LC26_CHASSIS_DATA,
  LC26_FIA_DATUM_PLANES,
  LC26_FIA_POWERTRAIN_LIMITS,
  LC26_MASS_AND_INERTIA,
  LC26_VEHICLE_ID,
  type AeroData,
  type AeroSetupPreset,
  type BrakesData,
  type ChassisData,
  type DifferentialData,
  type Lc26AeroOperatingMode,
  type Lc26AiCircuitEntry,
  type Lc26AiTuningSchema,
  type Lc26CoolingGillLevel,
  type Lc26GarageSetup,
  type Lc26PirelliSlickCode,
  type PerformanceModeName,
  type SolverCornerOrder,
  type SuspensionsData,
  type TireCompound,
} from './contract-types';

// ---------------------------------------------------------------------------
// Garage Tabs & Parameter Metadata
// ---------------------------------------------------------------------------

export type Lc26SetupTabId =
  | 'aero-cooling'
  | 'suspension-heave'
  | 'ride-packers'
  | 'alignment-tyres'
  | 'brakes-diff'
  | 'power-unit-fuel';

export interface Lc26SetupTabMeta {
  readonly id: Lc26SetupTabId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
}

export const LC26_SETUP_TABS: readonly Lc26SetupTabMeta[] = [
  {
    id: 'aero-cooling',
    label: 'Aerodynamics & Cooling',
    shortLabel: 'AERO',
    description:
      'Front/rear wing flap trim angles, aero downforce package, and parametric dorsal cooling gill louvres (1–5).',
  },
  {
    id: 'suspension-heave',
    label: 'Torsion Bars, Heave & ARBs',
    shortLabel: 'SUSP',
    description:
      'Front pull-rod & rear push-rod corner torsion bar rates, 3rd heave elements, and anti-roll bar stiffness.',
  },
  {
    id: 'ride-packers',
    label: 'Ride Height & Packers',
    shortLabel: 'RIDE',
    description:
      'Static reference-plane ride heights (FRH/RRH in mm) and heave packer engagement gaps protecting the 10 mm plank.',
  },
  {
    id: 'alignment-tyres',
    label: 'Alignment & 18" Pirelli Tyres',
    shortLabel: 'TYRES',
    description:
      'Static camber, front toe-out / rear toe-in, 4-corner cold blanket pressures, and narrowed 2026 Pirelli compounds.',
  },
  {
    id: 'brakes-diff',
    label: 'BBW Brakes & 3-Phase Diff',
    shortLabel: 'BRK/DIFF',
    description:
      'Static front brake bias, dynamic Brake-by-Wire forward migration, and 3-phase electronic differential lock.',
  },
  {
    id: 'power-unit-fuel',
    label: 'Hybrid Strategy & Fuel Mass',
    shortLabel: 'PU/FUEL',
    description:
      '350 kW MGU-K deployment strategy map, closed-throttle engine braking, and sustainable race fuel load in kg.',
  },
] as const;

export type Lc26NumericParameterId =
  | 'frontWingAngleDeg'
  | 'rearWingAngleDeg'
  | 'coolingGillLevel'
  | 'frontRideHeightMm'
  | 'rearRideHeightMm'
  | 'frontHeaveRateNmm'
  | 'rearHeaveRateNmm'
  | 'frontCornerRateNmm'
  | 'rearCornerRateNmm'
  | 'frontArbStiffnessNmDeg'
  | 'rearArbStiffnessNmDeg'
  | 'frontPackerGapMm'
  | 'rearPackerGapMm'
  | 'camberFrontDeg'
  | 'camberRearDeg'
  | 'frontToeOutDeg'
  | 'rearToeInDeg'
  | 'coldPressureFlPsi'
  | 'coldPressureFrPsi'
  | 'coldPressureRlPsi'
  | 'coldPressureRrPsi'
  | 'brakeBiasFrontPct'
  | 'brakeMigrationPct'
  | 'diffEntryLockPct'
  | 'diffMidCoastLockPct'
  | 'diffHighSpeedPreloadNm'
  | 'engineBrakingLevel'
  | 'fuelLoadKg';

export interface Lc26SetupParameterMeta {
  readonly id: Lc26NumericParameterId;
  readonly tab: Lc26SetupTabId;
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly decimals: number;
  readonly baseline: number;
  readonly tooltip: string;
  get(setup: Lc26GarageSetup): number;
  set(setup: Lc26GarageSetup, rawValue: number): Lc26GarageSetup;
  format(value: number): string;
}

export interface Lc26EnumParameterMeta<T extends string> {
  readonly id: 'aeroPreset' | 'compound' | 'ersDeployMode';
  readonly tab: Lc26SetupTabId;
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly label: string; readonly detail: string }[];
  readonly tooltip: string;
}

/** Quantize a numeric value onto `[min, max]` in exact multiples of `step` from `min`. */
export function quantizeStep(value: number, min: number, max: number, step: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(max, Math.max(min, value));
  const steps = Math.round((clamped - min) / step);
  const snapped = min + steps * step;
  const bounded = Math.min(max, Math.max(min, snapped));
  const cleaned = Number(bounded.toFixed(6));
  return cleaned === 0 ? 0 : cleaned;
}

// ---------------------------------------------------------------------------
// Pirelli C1–C5 <-> Weekend Slick / Wet Compound Mapping
// ---------------------------------------------------------------------------

export type Lc26CompoundSelection = TireCompound | Lc26PirelliSlickCode;

export interface Lc26WeekendSlickAllocation {
  readonly hard: Lc26PirelliSlickCode;
  readonly medium: Lc26PirelliSlickCode;
  readonly soft: Lc26PirelliSlickCode;
}

export const LC26_DEFAULT_WEEKEND_ALLOCATION: Lc26WeekendSlickAllocation = {
  hard: 'C1',
  medium: 'C3',
  soft: 'C5',
} as const;

export const LC26_CIRCUIT_SLICK_ALLOCATIONS: Readonly<Record<string, Lc26WeekendSlickAllocation>> = {
  monza: { hard: 'C3', medium: 'C4', soft: 'C5' },
  silverstone: { hard: 'C1', medium: 'C2', soft: 'C3' },
  spa: { hard: 'C2', medium: 'C3', soft: 'C4' },
  suzuka: { hard: 'C1', medium: 'C2', soft: 'C3' },
  marina_bay: { hard: 'C3', medium: 'C4', soft: 'C5' },
  yas_marina: { hard: 'C3', medium: 'C4', soft: 'C5' },
  spielberg: { hard: 'C3', medium: 'C4', soft: 'C5' },
  rwanda_official_short: { hard: 'C2', medium: 'C3', soft: 'C4' },
} as const;

/** Maps any `C1–C5` or `TireCompound` selection to canonical `TireCompound` (`soft`/`medium`/`hard`/`intermediate`/`wet`). */
export function resolveLc26TireCompound(
  selection: Lc26CompoundSelection,
  allocation: Lc26WeekendSlickAllocation = LC26_DEFAULT_WEEKEND_ALLOCATION,
): TireCompound {
  switch (selection) {
    case 'soft':
    case 'medium':
    case 'hard':
    case 'intermediate':
    case 'wet':
      return selection;
    case 'C1':
      return allocation.hard === 'C1' ? 'hard' : 'hard';
    case 'C2':
      return allocation.medium === 'C2' ? 'medium' : 'hard';
    case 'C3':
      if (allocation.hard === 'C3') return 'hard';
      if (allocation.soft === 'C3') return 'soft';
      return 'medium';
    case 'C4':
      return allocation.medium === 'C4' ? 'medium' : 'soft';
    case 'C5':
      return 'soft';
  }
}

/** Resolves the display Pirelli code (`C1..C5`, `INT`, `WET`) for HUD / steering-wheel MFD badges. */
export function formatLc26PirelliCompoundCode(
  compound: TireCompound,
  allocation: Lc26WeekendSlickAllocation = LC26_DEFAULT_WEEKEND_ALLOCATION,
): Lc26PirelliSlickCode | 'INT' | 'WET' {
  if (compound === 'intermediate') return 'INT';
  if (compound === 'wet') return 'WET';
  return allocation[compound];
}

// ---------------------------------------------------------------------------
// Baseline & Named Presets
// ---------------------------------------------------------------------------

export type Lc26PresetId = 'baseline' | 'low-drag-monza' | 'high-downforce-monaco' | 'wet-race';

export const LC26_BASELINE_SETUP: Lc26GarageSetup = {
  aeroPreset: 'balanced',
  frontWingAngleDeg: 5.5,
  rearWingAngleDeg: 9.0,
  coolingGillLevel: 3,
  frontRideHeightMm: 32.0,
  rearRideHeightMm: 58.0,
  frontHeaveRateNmm: 270,
  rearHeaveRateNmm: 190,
  frontCornerRateNmm: 165,
  rearCornerRateNmm: 140,
  frontArbStiffnessNmDeg: 1500,
  rearArbStiffnessNmDeg: 950,
  frontPackerGapMm: 11.0,
  rearPackerGapMm: 18.0,
  camberDeg: [-3.25, -3.25, -1.75, -1.75],
  toeDeg: [0.12, 0.22],
  coldPressurePsi: [23.5, 23.5, 21.5, 21.5],
  compound: 'medium',
  brakeBiasFrontPct: 56.2,
  brakeMigrationPct: 2.0,
  diffEntryLockPct: 28,
  diffMidCoastLockPct: 36,
  diffHighSpeedPreloadNm: 75,
  engineBrakingLevel: 5,
  ersDeployMode: 'RAC',
  fuelLoadKg: 98.0,
};

export const LC26_SETUP_PRESETS: Readonly<
  Record<
    Lc26PresetId,
    {
      readonly id: Lc26PresetId;
      readonly name: string;
      readonly summary: string;
      readonly recommendedPirelliCode: Lc26PirelliSlickCode | 'WET';
      readonly setup: Lc26GarageSetup;
    }
  >
> = {
  baseline: {
    id: 'baseline',
    name: 'Baseline Grand Prix (Balanced)',
    summary:
      'Balanced Canyon-Overcut aero trim (32/58 mm static FRH/RRH), C3 Medium tyres, level-3 cooling gills, and 98.0 kg race fuel.',
    recommendedPirelliCode: 'C3',
    setup: LC26_BASELINE_SETUP,
  },
  'low-drag-monza': {
    id: 'low-drag-monza',
    name: 'Low-Drag High-Speed (Monza / Spa)',
    summary:
      'Trimmed spoon FW & twin-pylon RW angles, tighter level-2 cooling louvres, firmer heave/packers for 355 km/h loads, and lower-drag alignment.',
    recommendedPirelliCode: 'C4',
    setup: {
      aeroPreset: 'low_downforce',
      frontWingAngleDeg: 2.5,
      rearWingAngleDeg: 4.5,
      coolingGillLevel: 2,
      frontRideHeightMm: 31.0,
      rearRideHeightMm: 54.5,
      frontHeaveRateNmm: 320,
      rearHeaveRateNmm: 230,
      frontCornerRateNmm: 175,
      rearCornerRateNmm: 150,
      frontArbStiffnessNmDeg: 1650,
      rearArbStiffnessNmDeg: 1050,
      frontPackerGapMm: 9.5,
      rearPackerGapMm: 15.5,
      camberDeg: [-2.95, -2.95, -1.45, -1.45],
      toeDeg: [0.08, 0.18],
      coldPressurePsi: [24.5, 24.5, 22.5, 22.5],
      compound: 'medium',
      brakeBiasFrontPct: 57.0,
      brakeMigrationPct: 2.4,
      diffEntryLockPct: 32,
      diffMidCoastLockPct: 38,
      diffHighSpeedPreloadNm: 85,
      engineBrakingLevel: 6,
      ersDeployMode: 'RAC',
      fuelLoadKg: 94.0,
    },
  },
  'high-downforce-monaco': {
    id: 'high-downforce-monaco',
    name: 'High-Downforce Street (Monaco / Marina Bay)',
    summary:
      'Maximum wing incidence, level-4 cooling louvres for low-speed street heat rejection, compliant torsion bars & ARBs over kerbs, and C5 Softs.',
    recommendedPirelliCode: 'C5',
    setup: {
      aeroPreset: 'high_downforce',
      frontWingAngleDeg: 10.5,
      rearWingAngleDeg: 14.5,
      coolingGillLevel: 4,
      frontRideHeightMm: 35.0,
      rearRideHeightMm: 63.0,
      frontHeaveRateNmm: 240,
      rearHeaveRateNmm: 170,
      frontCornerRateNmm: 140,
      rearCornerRateNmm: 120,
      frontArbStiffnessNmDeg: 1150,
      rearArbStiffnessNmDeg: 700,
      frontPackerGapMm: 14.0,
      rearPackerGapMm: 22.0,
      camberDeg: [-3.55, -3.55, -1.95, -1.95],
      toeDeg: [0.22, 0.28],
      coldPressurePsi: [22.4, 22.4, 20.4, 20.4],
      compound: 'soft',
      brakeBiasFrontPct: 55.4,
      brakeMigrationPct: 1.8,
      diffEntryLockPct: 22,
      diffMidCoastLockPct: 30,
      diffHighSpeedPreloadNm: 60,
      engineBrakingLevel: 4,
      ersDeployMode: 'RAC',
      fuelLoadKg: 88.0,
    },
  },
  'wet-race': {
    id: 'wet-race',
    name: 'Full-Wet Rain Setup',
    summary:
      'Raised static ride heights (+7/+9 mm) against standing-water hydroplaning, high downforce, soft mechanical platform, rearward BBW bias, and Full Wet tyres.',
    recommendedPirelliCode: 'WET',
    setup: {
      aeroPreset: 'high_downforce',
      frontWingAngleDeg: 11.0,
      rearWingAngleDeg: 15.0,
      coolingGillLevel: 2,
      frontRideHeightMm: 39.0,
      rearRideHeightMm: 67.0,
      frontHeaveRateNmm: 210,
      rearHeaveRateNmm: 150,
      frontCornerRateNmm: 125,
      rearCornerRateNmm: 105,
      frontArbStiffnessNmDeg: 850,
      rearArbStiffnessNmDeg: 500,
      frontPackerGapMm: 17.5,
      rearPackerGapMm: 26.5,
      camberDeg: [-2.75, -2.75, -1.35, -1.35],
      toeDeg: [0.16, 0.30],
      coldPressurePsi: [24.2, 24.2, 22.2, 22.2],
      compound: 'wet',
      brakeBiasFrontPct: 53.6,
      brakeMigrationPct: 1.2,
      diffEntryLockPct: 18,
      diffMidCoastLockPct: 24,
      diffHighSpeedPreloadNm: 45,
      engineBrakingLevel: 3,
      ersDeployMode: 'BAL',
      fuelLoadKg: 92.0,
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Complete Numeric & Enum Parameter Metadata Registry
// ---------------------------------------------------------------------------

function makeParam(
  spec: Omit<Lc26SetupParameterMeta, 'format' | 'set'> & {
    apply(setup: Lc26GarageSetup, snapped: number): Lc26GarageSetup;
  },
): Lc26SetupParameterMeta {
  return {
    id: spec.id,
    tab: spec.tab,
    label: spec.label,
    unit: spec.unit,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    decimals: spec.decimals,
    baseline: spec.baseline,
    tooltip: spec.tooltip,
    get: spec.get,
    set(setup, rawValue) {
      const snapped = quantizeStep(rawValue, spec.min, spec.max, spec.step, spec.baseline);
      return spec.apply(setup, snapped);
    },
    format(value) {
      const safe = Number.isFinite(value) ? value : spec.baseline;
      return spec.unit ? `${safe.toFixed(spec.decimals)} ${spec.unit}` : safe.toFixed(spec.decimals);
    },
  };
}

export const LC26_SETUP_PARAMETERS: readonly Lc26SetupParameterMeta[] = [
  // --- Aero & Cooling ---
  makeParam({
    id: 'frontWingAngleDeg',
    tab: 'aero-cooling',
    label: 'Front Wing Flap Angle',
    unit: 'deg',
    min: 0.0,
    max: 12.0,
    step: 0.25,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.frontWingAngleDeg,
    tooltip:
      'Static Corner-Mode incidence of outboard spoon front-wing flaps fw_flap_2 & fw_flap_3. Higher angle shifts aero CoP forward for sharper turn-in.',
    get: (s) => s.frontWingAngleDeg,
    apply: (s, v) => ({ ...s, frontWingAngleDeg: v }),
  }),
  makeParam({
    id: 'rearWingAngleDeg',
    tab: 'aero-cooling',
    label: 'Rear Wing Flap Angle',
    unit: 'deg',
    min: 2.0,
    max: 16.0,
    step: 0.25,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.rearWingAngleDeg,
    tooltip:
      'Static Corner-Mode incidence of beam-wingless 3-element rear wing flaps rw_flap_2 & rw_flap_3. Increases rear traction & high-speed stability at drag cost.',
    get: (s) => s.rearWingAngleDeg,
    apply: (s, v) => ({ ...s, rearWingAngleDeg: v }),
  }),
  makeParam({
    id: 'coolingGillLevel',
    tab: 'aero-cooling',
    label: 'Dorsal Cooling Gill Louvres',
    unit: 'lvl',
    min: 1,
    max: 5,
    step: 1,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.coolingGillLevel,
    tooltip:
      'Parametric engine-cover cooling aperture (1 = tightest minimum drag; 5 = maximum hot-ambient radiator/intercooler heat rejection).',
    get: (s) => s.coolingGillLevel,
    apply: (s, v) => ({ ...s, coolingGillLevel: Math.round(v) as Lc26CoolingGillLevel }),
  }),

  // --- Suspension & Heave ---
  makeParam({
    id: 'frontCornerRateNmm',
    tab: 'suspension-heave',
    label: 'Front Pull-Rod Torsion Bar Rate',
    unit: 'N/mm',
    min: 110,
    max: 230,
    step: 5,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.frontCornerRateNmm,
    tooltip:
      'Front wheel-rate torsion bar stiffness. Firmer front rate sharpens initial steering response and controls roll attitude.',
    get: (s) => s.frontCornerRateNmm,
    apply: (s, v) => ({ ...s, frontCornerRateNmm: v }),
  }),
  makeParam({
    id: 'rearCornerRateNmm',
    tab: 'suspension-heave',
    label: 'Rear Push-Rod Torsion Bar Rate',
    unit: 'N/mm',
    min: 95,
    max: 205,
    step: 5,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.rearCornerRateNmm,
    tooltip:
      'Rear wheel-rate torsion bar stiffness. Softer rear improves low-speed mechanical traction out of hairpins.',
    get: (s) => s.rearCornerRateNmm,
    apply: (s, v) => ({ ...s, rearCornerRateNmm: v }),
  }),
  makeParam({
    id: 'frontHeaveRateNmm',
    tab: 'suspension-heave',
    label: 'Front 3rd Heave Spring Rate',
    unit: 'N/mm',
    min: 160,
    max: 420,
    step: 10,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.frontHeaveRateNmm,
    tooltip:
      'Front central heave spring supporting symmetrical aerodynamic load without stiffening single-wheel kerb compliance.',
    get: (s) => s.frontHeaveRateNmm,
    apply: (s, v) => ({ ...s, frontHeaveRateNmm: v }),
  }),
  makeParam({
    id: 'rearHeaveRateNmm',
    tab: 'suspension-heave',
    label: 'Rear 3rd Heave Spring Rate',
    unit: 'N/mm',
    min: 110,
    max: 320,
    step: 10,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.rearHeaveRateNmm,
    tooltip:
      'Rear central heave element controlling diffuser throat height under high-speed aero compression and Straight Mode release.',
    get: (s) => s.rearHeaveRateNmm,
    apply: (s, v) => ({ ...s, rearHeaveRateNmm: v }),
  }),
  makeParam({
    id: 'frontArbStiffnessNmDeg',
    tab: 'suspension-heave',
    label: 'Front Anti-Roll Bar',
    unit: 'Nm/deg',
    min: 600,
    max: 2600,
    step: 50,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.frontArbStiffnessNmDeg,
    tooltip:
      'Front anti-roll bar roll stiffness. Stiffer front ARB shifts lateral load transfer forward (more mid-corner stability/understeer).',
    get: (s) => s.frontArbStiffnessNmDeg,
    apply: (s, v) => ({ ...s, frontArbStiffnessNmDeg: v }),
  }),
  makeParam({
    id: 'rearArbStiffnessNmDeg',
    tab: 'suspension-heave',
    label: 'Rear Anti-Roll Bar',
    unit: 'Nm/deg',
    min: 300,
    max: 1800,
    step: 50,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.rearArbStiffnessNmDeg,
    tooltip:
      'Rear anti-roll bar roll stiffness. Stiffer rear ARB increases mid-corner rotation at the expense of combined-slip traction.',
    get: (s) => s.rearArbStiffnessNmDeg,
    apply: (s, v) => ({ ...s, rearArbStiffnessNmDeg: v }),
  }),

  // --- Ride Height & Packers ---
  makeParam({
    id: 'frontRideHeightMm',
    tab: 'ride-packers',
    label: 'Front Static Ride Height (FRH)',
    unit: 'mm',
    min: 22.0,
    max: 48.0,
    step: 0.5,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.frontRideHeightMm,
    tooltip:
      'Static front Car Reference Plane height (Z_FIA = 0; 10 mm plank bottom sits 10 mm lower). Lower FRH boosts ground effect until splitter strike/stall.',
    get: (s) => s.frontRideHeightMm,
    apply: (s, v) => ({ ...s, frontRideHeightMm: v }),
  }),
  makeParam({
    id: 'rearRideHeightMm',
    tab: 'ride-packers',
    label: 'Rear Static Ride Height (RRH)',
    unit: 'mm',
    min: 44.0,
    max: 78.0,
    step: 0.5,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.rearRideHeightMm,
    tooltip:
      'Static rear Car Reference Plane height at XR = 0. Controls chassis rake angle and diffuser expansion ratio.',
    get: (s) => s.rearRideHeightMm,
    apply: (s, v) => ({ ...s, rearRideHeightMm: v }),
  }),
  makeParam({
    id: 'frontPackerGapMm',
    tab: 'ride-packers',
    label: 'Front Heave Packer Gap',
    unit: 'mm',
    min: 4.0,
    max: 24.0,
    step: 0.5,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.frontPackerGapMm,
    tooltip:
      'Free heave travel before progressive front bump packers engage to protect Ti-6Al-4V front splitter skids above 300 km/h.',
    get: (s) => s.frontPackerGapMm,
    apply: (s, v) => ({ ...s, frontPackerGapMm: v }),
  }),
  makeParam({
    id: 'rearPackerGapMm',
    tab: 'ride-packers',
    label: 'Rear Heave Packer Gap',
    unit: 'mm',
    min: 8.0,
    max: 34.0,
    step: 0.5,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.rearPackerGapMm,
    tooltip:
      'Free rear heave travel before packers arrest floor compression to prevent diffuser vortex stall and plank wear > 1.0 mm.',
    get: (s) => s.rearPackerGapMm,
    apply: (s, v) => ({ ...s, rearPackerGapMm: v }),
  }),

  // --- Alignment & Tyres ---
  makeParam({
    id: 'camberFrontDeg',
    tab: 'alignment-tyres',
    label: 'Front Static Camber',
    unit: 'deg',
    min: -3.8,
    max: -2.2,
    step: 0.05,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.camberDeg[0],
    tooltip:
      'Front axle static negative camber (280/705-R18). More negative camber maximizes lateral grip in fast sweepers; less aids straight-line braking.',
    get: (s) => s.camberDeg[0],
    apply: (s, v) => ({ ...s, camberDeg: [v, v, s.camberDeg[2], s.camberDeg[3]] }),
  }),
  makeParam({
    id: 'camberRearDeg',
    tab: 'alignment-tyres',
    label: 'Rear Static Camber',
    unit: 'deg',
    min: -2.4,
    max: -1.0,
    step: 0.05,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.camberDeg[2],
    tooltip:
      'Rear axle static negative camber (375/710-R18). Balances longitudinal 350 kW MGU-K + ICE traction patch against high-g lateral support.',
    get: (s) => s.camberDeg[2],
    apply: (s, v) => ({ ...s, camberDeg: [s.camberDeg[0], s.camberDeg[1], v, v] }),
  }),
  makeParam({
    id: 'frontToeOutDeg',
    tab: 'alignment-tyres',
    label: 'Front Static Toe-Out',
    unit: 'deg',
    min: 0.0,
    max: 0.45,
    step: 0.01,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.toeDeg[0],
    tooltip:
      'Front static toe-out per wheel. More toe-out sharpens initial turn-in bite and warms inner tread shoulders faster.',
    get: (s) => s.toeDeg[0],
    apply: (s, v) => ({ ...s, toeDeg: [v, s.toeDeg[1]] }),
  }),
  makeParam({
    id: 'rearToeInDeg',
    tab: 'alignment-tyres',
    label: 'Rear Static Toe-In',
    unit: 'deg',
    min: 0.05,
    max: 0.5,
    step: 0.01,
    decimals: 2,
    baseline: LC26_BASELINE_SETUP.toeDeg[1],
    tooltip:
      'Rear static toe-in per wheel. Stabilizes the rear axle under heavy braking and power application out of slow chicanes.',
    get: (s) => s.toeDeg[1],
    apply: (s, v) => ({ ...s, toeDeg: [s.toeDeg[0], v] }),
  }),
  makeParam({
    id: 'coldPressureFlPsi',
    tab: 'alignment-tyres',
    label: 'Cold Pressure — FL',
    unit: 'psi',
    min: 21.5,
    max: 27.5,
    step: 0.1,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.coldPressurePsi[0],
    tooltip: 'Front-left blanket inflation pressure (psi gauge). Controls carcass vertical rate and hot contact-patch crown.',
    get: (s) => s.coldPressurePsi[0],
    apply: (s, v) => ({
      ...s,
      coldPressurePsi: [v, s.coldPressurePsi[1], s.coldPressurePsi[2], s.coldPressurePsi[3]],
    }),
  }),
  makeParam({
    id: 'coldPressureFrPsi',
    tab: 'alignment-tyres',
    label: 'Cold Pressure — FR',
    unit: 'psi',
    min: 21.5,
    max: 27.5,
    step: 0.1,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.coldPressurePsi[1],
    tooltip: 'Front-right blanket inflation pressure (psi gauge). Asymmetric circuits benefit from stagger on loaded outer tyres.',
    get: (s) => s.coldPressurePsi[1],
    apply: (s, v) => ({
      ...s,
      coldPressurePsi: [s.coldPressurePsi[0], v, s.coldPressurePsi[2], s.coldPressurePsi[3]],
    }),
  }),
  makeParam({
    id: 'coldPressureRlPsi',
    tab: 'alignment-tyres',
    label: 'Cold Pressure — RL',
    unit: 'psi',
    min: 19.5,
    max: 25.5,
    step: 0.1,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.coldPressurePsi[2],
    tooltip: 'Rear-left blanket inflation pressure (psi gauge) for narrowed 375/710-R18 rear construction.',
    get: (s) => s.coldPressurePsi[2],
    apply: (s, v) => ({
      ...s,
      coldPressurePsi: [s.coldPressurePsi[0], s.coldPressurePsi[1], v, s.coldPressurePsi[3]],
    }),
  }),
  makeParam({
    id: 'coldPressureRrPsi',
    tab: 'alignment-tyres',
    label: 'Cold Pressure — RR',
    unit: 'psi',
    min: 19.5,
    max: 25.5,
    step: 0.1,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.coldPressurePsi[3],
    tooltip: 'Rear-right blanket inflation pressure (psi gauge) for narrowed 375/710-R18 rear construction.',
    get: (s) => s.coldPressurePsi[3],
    apply: (s, v) => ({
      ...s,
      coldPressurePsi: [s.coldPressurePsi[0], s.coldPressurePsi[1], s.coldPressurePsi[2], v],
    }),
  }),

  // --- Brakes & Diff ---
  makeParam({
    id: 'brakeBiasFrontPct',
    tab: 'brakes-diff',
    label: 'Static Front Brake Bias',
    unit: '%',
    min: 51.0,
    max: 63.0,
    step: 0.2,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.brakeBiasFrontPct,
    tooltip:
      'Base front brake torque share before dynamic migration. Rear BBW blends MGU-K 350 kW regenerative harvest seamlessly with rear calipers.',
    get: (s) => s.brakeBiasFrontPct,
    apply: (s, v) => ({ ...s, brakeBiasFrontPct: v }),
  }),
  makeParam({
    id: 'brakeMigrationPct',
    tab: 'brakes-diff',
    label: 'BBW Forward Brake Migration',
    unit: '%',
    min: 0.0,
    max: 5.0,
    step: 0.2,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.brakeMigrationPct,
    tooltip:
      'Forward bias ramp added at peak brake pedal pressure so high-speed initial hits stay stable while trail-braking rotates cleanly into the apex.',
    get: (s) => s.brakeMigrationPct,
    apply: (s, v) => ({ ...s, brakeMigrationPct: v }),
  }),
  makeParam({
    id: 'diffEntryLockPct',
    tab: 'brakes-diff',
    label: 'Diff Entry Lock',
    unit: '%',
    min: 10,
    max: 80,
    step: 2,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.diffEntryLockPct,
    tooltip:
      'Electronic differential locking under braking / corner entry. Higher lock stabilizes rear axle under heavy BBW regen.',
    get: (s) => s.diffEntryLockPct,
    apply: (s, v) => ({ ...s, diffEntryLockPct: v }),
  }),
  makeParam({
    id: 'diffMidCoastLockPct',
    tab: 'brakes-diff',
    label: 'Diff Mid-Corner Coast Lock',
    unit: '%',
    min: 10,
    max: 80,
    step: 2,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.diffMidCoastLockPct,
    tooltip:
      'Apex off-throttle differential lock. Lower values free mid-corner rotation in tight hairpins.',
    get: (s) => s.diffMidCoastLockPct,
    apply: (s, v) => ({ ...s, diffMidCoastLockPct: v }),
  }),
  makeParam({
    id: 'diffHighSpeedPreloadNm',
    tab: 'brakes-diff',
    label: 'Diff High-Speed / Exit Preload',
    unit: 'Nm',
    min: 20,
    max: 180,
    step: 5,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.diffHighSpeedPreloadNm,
    tooltip:
      'Baseline electro-hydraulic LSD preload torque governing traction launch and >250 km/h high-speed stability.',
    get: (s) => s.diffHighSpeedPreloadNm,
    apply: (s, v) => ({ ...s, diffHighSpeedPreloadNm: v }),
  }),

  // --- Power Unit & Fuel (Strictly in kg!) ---
  makeParam({
    id: 'engineBrakingLevel',
    tab: 'power-unit-fuel',
    label: 'Engine Overrun Braking',
    unit: 'lvl',
    min: 1,
    max: 10,
    step: 1,
    decimals: 0,
    baseline: LC26_BASELINE_SETUP.engineBrakingLevel,
    tooltip:
      'Closed-throttle V6 + MGU-K overrun drag torque map (1 = minimum overrun / freest apex roll; 10 = maximum engine braking & lift harvest).',
    get: (s) => s.engineBrakingLevel,
    apply: (s, v) => ({ ...s, engineBrakingLevel: Math.round(v) }),
  }),
  makeParam({
    id: 'fuelLoadKg',
    tab: 'power-unit-fuel',
    label: 'Starting Sustainable Fuel Mass',
    unit: 'kg',
    min: 5.0,
    max: 100.0,
    step: 0.5,
    decimals: 1,
    baseline: LC26_BASELINE_SETUP.fuelLoadKg,
    tooltip:
      '100% sustainable FIA 2026 fuel mass tracked strictly in kilograms (43.5 MJ/kg LHV, 3000 MJ/h max energy flow; 5.0–100.0 kg in 0.5 kg steps).',
    get: (s) => s.fuelLoadKg,
    apply: (s, v) => ({ ...s, fuelLoadKg: v }),
  }),
] as const;

export const LC26_ENUM_PARAMETERS: {
  readonly aeroPreset: Lc26EnumParameterMeta<AeroSetupPreset>;
  readonly compound: Lc26EnumParameterMeta<TireCompound>;
  readonly ersDeployMode: Lc26EnumParameterMeta<PerformanceModeName>;
} = {
  aeroPreset: {
    id: 'aeroPreset',
    tab: 'aero-cooling',
    label: 'Aero Wing Package',
    tooltip: 'Selects mainplane chord & flap family between Low-Drag, Balanced GP, and High-Downforce trims.',
    options: [
      { value: 'low_downforce', label: 'Low Downforce', detail: 'Monza / Spa spoon & low-drag RW assembly' },
      { value: 'balanced', label: 'Balanced GP', detail: 'Standard Grand Prix baseline aero kit' },
      { value: 'high_downforce', label: 'High Downforce', detail: 'Monaco / Marina Bay maximum-load aero kit' },
    ],
  },
  compound: {
    id: 'compound',
    tab: 'alignment-tyres',
    label: 'Pirelli 18" Tyre Compound',
    tooltip:
      'Narrowed 2026 Pirelli 280/705-R18 front & 375/710-R18 rear tyres: Dry Slicks (C1–C5 mapped to Hard/Medium/Soft), Intermediate, and Full Wet.',
    options: [
      { value: 'soft', label: 'Soft (C4/C5)', detail: 'Peak qualifying & short-stint mechanical grip' },
      { value: 'medium', label: 'Medium (C3)', detail: 'Balanced race stint thermal window & wear' },
      { value: 'hard', label: 'Hard (C1/C2)', detail: 'High-energy circuit durability & low blister risk' },
      { value: 'intermediate', label: 'Intermediate (Green)', detail: 'Damp / drying asphalt water evacuation' },
      { value: 'wet', label: 'Full Wet (Blue)', detail: 'Standing water heavy rain evacuation' },
    ],
  },
  ersDeployMode: {
    id: 'ersDeployMode',
    tab: 'power-unit-fuel',
    label: 'ERS Strategy Map',
    tooltip: '350 kW MGU-K electrical deployment & straight-end Super Clipping strategy.',
    options: [
      { value: 'PSH', label: 'PSH — Push / Quali', detail: 'Maximum 350 kW deployment across full lap' },
      { value: 'RAC', label: 'RAC — Race Pace', detail: 'Charge-neutral race deployment + straight-end clip' },
      { value: 'BAL', label: 'BAL — Balanced', detail: 'Conservative traction deploy & steady SoC buffer' },
      { value: 'LIC', label: 'LIC — Lift & Coast', detail: 'Early straight-end Super Clipping & fuel save' },
      { value: 'CHR', label: 'CHR — Charge / Harvest', detail: 'Aggressive battery recharge up to 8.5 MJ/lap' },
    ],
  },
} as const;

export const LC26_PARAMETER_BY_ID: Readonly<Record<Lc26NumericParameterId, Lc26SetupParameterMeta>> =
  Object.fromEntries(LC26_SETUP_PARAMETERS.map((p) => [p.id, p])) as Record<
    Lc26NumericParameterId,
    Lc26SetupParameterMeta
  >;

// ---------------------------------------------------------------------------
// Sanitizer & Validator
// ---------------------------------------------------------------------------

const VALID_AERO_PRESETS: ReadonlySet<AeroSetupPreset> = new Set([
  'low_downforce',
  'balanced',
  'high_downforce',
]);
const VALID_COMPOUNDS: ReadonlySet<TireCompound> = new Set([
  'soft',
  'medium',
  'hard',
  'intermediate',
  'wet',
]);
const VALID_PIRELLI_CODES: ReadonlySet<Lc26PirelliSlickCode> = new Set(['C1', 'C2', 'C3', 'C4', 'C5']);
const VALID_ERS_MODES: ReadonlySet<PerformanceModeName> = new Set(['PSH', 'RAC', 'BAL', 'LIC', 'CHR']);

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readTuple4(raw: unknown, fallback: SolverCornerOrder<number>): [number, number, number, number] {
  if (Array.isArray(raw) && raw.length === 4) {
    return [
      typeof raw[0] === 'number' && Number.isFinite(raw[0]) ? raw[0] : fallback[0],
      typeof raw[1] === 'number' && Number.isFinite(raw[1]) ? raw[1] : fallback[1],
      typeof raw[2] === 'number' && Number.isFinite(raw[2]) ? raw[2] : fallback[2],
      typeof raw[3] === 'number' && Number.isFinite(raw[3]) ? raw[3] : fallback[3],
    ];
  }
  return [fallback[0], fallback[1], fallback[2], fallback[3]];
}

/**
 * Sanitizes and clamps any untrusted/partial input into a strictly valid `Lc26GarageSetup`.
 * Guarantees fuel is strictly in `[5.0, 100.0] kg` on `0.5 kg` steps and every parameter sits on its step grid.
 */
export function sanitizeLc26GarageSetup(
  raw: unknown,
  fallback: Lc26GarageSetup = LC26_BASELINE_SETUP,
): Lc26GarageSetup {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const aeroPreset: AeroSetupPreset =
    typeof src.aeroPreset === 'string' && VALID_AERO_PRESETS.has(src.aeroPreset as AeroSetupPreset)
      ? (src.aeroPreset as AeroSetupPreset)
      : fallback.aeroPreset;

  let compound: TireCompound = fallback.compound;
  if (typeof src.compound === 'string') {
    if (VALID_COMPOUNDS.has(src.compound as TireCompound)) {
      compound = src.compound as TireCompound;
    } else if (VALID_PIRELLI_CODES.has(src.compound as Lc26PirelliSlickCode)) {
      compound = resolveLc26TireCompound(src.compound as Lc26PirelliSlickCode);
    }
  }

  const ersDeployMode: PerformanceModeName =
    typeof src.ersDeployMode === 'string' && VALID_ERS_MODES.has(src.ersDeployMode as PerformanceModeName)
      ? (src.ersDeployMode as PerformanceModeName)
      : fallback.ersDeployMode;

  const rawCamber = readTuple4(src.camberDeg, fallback.camberDeg);
  const rawPressures = readTuple4(src.coldPressurePsi, fallback.coldPressurePsi);
  const rawToe =
    Array.isArray(src.toeDeg) && src.toeDeg.length === 2
      ? [
          typeof src.toeDeg[0] === 'number' && Number.isFinite(src.toeDeg[0])
            ? src.toeDeg[0]
            : fallback.toeDeg[0],
          typeof src.toeDeg[1] === 'number' && Number.isFinite(src.toeDeg[1])
            ? src.toeDeg[1]
            : fallback.toeDeg[1],
        ]
      : [fallback.toeDeg[0], fallback.toeDeg[1]];

  const q = (id: Lc26NumericParameterId, candidate: number | undefined, fb: number): number => {
    const meta = LC26_PARAMETER_BY_ID[id];
    return quantizeStep(candidate ?? fb, meta.min, meta.max, meta.step, fb);
  };

  const frontRideMm = q('frontRideHeightMm', readNumber(src, 'frontRideHeightMm'), fallback.frontRideHeightMm);
  const rearRideRawMm = q('rearRideHeightMm', readNumber(src, 'rearRideHeightMm'), fallback.rearRideHeightMm);
  // Maintain non-negative static rake (RRH >= FRH)
  const rearRideMm = Math.max(frontRideMm, rearRideRawMm);

  return {
    aeroPreset,
    frontWingAngleDeg: q('frontWingAngleDeg', readNumber(src, 'frontWingAngleDeg'), fallback.frontWingAngleDeg),
    rearWingAngleDeg: q('rearWingAngleDeg', readNumber(src, 'rearWingAngleDeg'), fallback.rearWingAngleDeg),
    coolingGillLevel: Math.round(
      q('coolingGillLevel', readNumber(src, 'coolingGillLevel'), fallback.coolingGillLevel),
    ) as Lc26CoolingGillLevel,
    frontRideHeightMm: frontRideMm,
    rearRideHeightMm: q('rearRideHeightMm', rearRideMm, fallback.rearRideHeightMm),
    frontHeaveRateNmm: q('frontHeaveRateNmm', readNumber(src, 'frontHeaveRateNmm'), fallback.frontHeaveRateNmm),
    rearHeaveRateNmm: q('rearHeaveRateNmm', readNumber(src, 'rearHeaveRateNmm'), fallback.rearHeaveRateNmm),
    frontCornerRateNmm: q('frontCornerRateNmm', readNumber(src, 'frontCornerRateNmm'), fallback.frontCornerRateNmm),
    rearCornerRateNmm: q('rearCornerRateNmm', readNumber(src, 'rearCornerRateNmm'), fallback.rearCornerRateNmm),
    frontArbStiffnessNmDeg: q(
      'frontArbStiffnessNmDeg',
      readNumber(src, 'frontArbStiffnessNmDeg'),
      fallback.frontArbStiffnessNmDeg,
    ),
    rearArbStiffnessNmDeg: q(
      'rearArbStiffnessNmDeg',
      readNumber(src, 'rearArbStiffnessNmDeg'),
      fallback.rearArbStiffnessNmDeg,
    ),
    frontPackerGapMm: q('frontPackerGapMm', readNumber(src, 'frontPackerGapMm'), fallback.frontPackerGapMm),
    rearPackerGapMm: q('rearPackerGapMm', readNumber(src, 'rearPackerGapMm'), fallback.rearPackerGapMm),
    camberDeg: [
      q('camberFrontDeg', rawCamber[0], fallback.camberDeg[0]),
      q('camberFrontDeg', rawCamber[1], fallback.camberDeg[1]),
      q('camberRearDeg', rawCamber[2], fallback.camberDeg[2]),
      q('camberRearDeg', rawCamber[3], fallback.camberDeg[3]),
    ],
    toeDeg: [
      q('frontToeOutDeg', rawToe[0], fallback.toeDeg[0]),
      q('rearToeInDeg', rawToe[1], fallback.toeDeg[1]),
    ],
    coldPressurePsi: [
      q('coldPressureFlPsi', rawPressures[0], fallback.coldPressurePsi[0]),
      q('coldPressureFrPsi', rawPressures[1], fallback.coldPressurePsi[1]),
      q('coldPressureRlPsi', rawPressures[2], fallback.coldPressurePsi[2]),
      q('coldPressureRrPsi', rawPressures[3], fallback.coldPressurePsi[3]),
    ],
    compound,
    brakeBiasFrontPct: q('brakeBiasFrontPct', readNumber(src, 'brakeBiasFrontPct'), fallback.brakeBiasFrontPct),
    brakeMigrationPct: q('brakeMigrationPct', readNumber(src, 'brakeMigrationPct'), fallback.brakeMigrationPct),
    diffEntryLockPct: q('diffEntryLockPct', readNumber(src, 'diffEntryLockPct'), fallback.diffEntryLockPct),
    diffMidCoastLockPct: q(
      'diffMidCoastLockPct',
      readNumber(src, 'diffMidCoastLockPct'),
      fallback.diffMidCoastLockPct,
    ),
    diffHighSpeedPreloadNm: q(
      'diffHighSpeedPreloadNm',
      readNumber(src, 'diffHighSpeedPreloadNm'),
      fallback.diffHighSpeedPreloadNm,
    ),
    engineBrakingLevel: Math.round(
      q('engineBrakingLevel', readNumber(src, 'engineBrakingLevel'), fallback.engineBrakingLevel),
    ),
    ersDeployMode,
    fuelLoadKg: q('fuelLoadKg', readNumber(src, 'fuelLoadKg'), fallback.fuelLoadKg),
  };
}

export interface Lc26SetupValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/** Strictly validates an `Lc26GarageSetup` without mutating it. */
export function validateLc26GarageSetup(setup: Lc26GarageSetup): Lc26SetupValidationResult {
  const issues: string[] = [];

  if (!VALID_AERO_PRESETS.has(setup.aeroPreset)) {
    issues.push(`Invalid aeroPreset: ${String(setup.aeroPreset)}`);
  }
  if (!VALID_COMPOUNDS.has(setup.compound)) {
    issues.push(`Invalid compound: ${String(setup.compound)}`);
  }
  if (!VALID_ERS_MODES.has(setup.ersDeployMode)) {
    issues.push(`Invalid ersDeployMode: ${String(setup.ersDeployMode)}`);
  }
  if (![1, 2, 3, 4, 5].includes(setup.coolingGillLevel)) {
    issues.push(`coolingGillLevel ${setup.coolingGillLevel} outside 1..5`);
  }

  const checkGrid = (name: string, val: number, meta: Lc26SetupParameterMeta) => {
    if (!Number.isFinite(val)) {
      issues.push(`${name} is non-finite`);
      return;
    }
    if (val < meta.min - 1e-6 || val > meta.max + 1e-6) {
      issues.push(`${name} (${val}) outside [${meta.min}, ${meta.max}] ${meta.unit}`);
      return;
    }
    const steps = (val - meta.min) / meta.step;
    if (Math.abs(steps - Math.round(steps)) > 1e-4) {
      issues.push(`${name} (${val}) off ${meta.step} ${meta.unit} step grid`);
    }
  };

  for (const param of LC26_SETUP_PARAMETERS) {
    checkGrid(param.id, param.get(setup), param);
  }
  // Check right-side camber & symmetric corner bounds explicitly
  checkGrid('camberDeg[1]', setup.camberDeg[1], LC26_PARAMETER_BY_ID.camberFrontDeg);
  checkGrid('camberDeg[3]', setup.camberDeg[3], LC26_PARAMETER_BY_ID.camberRearDeg);

  if (setup.rearRideHeightMm < setup.frontRideHeightMm - 1e-6) {
    issues.push(
      `Negative static rake not allowed: rearRideHeightMm (${setup.rearRideHeightMm}) < frontRideHeightMm (${setup.frontRideHeightMm})`,
    );
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Physics Configuration Applier
// ---------------------------------------------------------------------------

export interface Lc26PhysicsSetupInputBundle {
  readonly chassis?: ChassisData;
  readonly aero?: AeroData;
  readonly suspensions?: SuspensionsData;
  readonly brakes?: BrakesData;
  readonly differential?: DifferentialData;
}

export interface Lc26AppliedPhysicsSetup {
  readonly sanitizedSetup: Lc26GarageSetup;
  readonly dryMassKg: number;
  readonly fuelLoadKg: number;
  readonly wetStartMassKg: number;
  readonly staticRakeDeg: number;
  readonly coolingDragDeltaCdA: number;
  readonly coolingHeatRejectMultiplier: number;
  readonly engineBrakingCoastScale: number;
  readonly frontStaticToeRadPerWheel: readonly [fl: number, fr: number];
  readonly rearStaticToeRadPerWheel: readonly [rl: number, rr: number];
  readonly chassis: ChassisData;
  readonly aero?: AeroData;
  readonly suspensions?: SuspensionsData;
  readonly brakes?: BrakesData;
  readonly differential?: DifferentialData;
}

/** Converts anti-roll bar roll stiffness (`Nm/deg` of chassis roll) into equivalent wheel rate (`N/m`) for `AxleSuspensionData.arb`. */
export function arbNmDegToWheelRateNm(arbStiffnessNmDeg: number, trackWidthM: number): number {
  const torqueNmPerRad = arbStiffnessNmDeg * (180 / Math.PI);
  // Single-wheel jounce dz produces roll dPhi = dz / trackWidthM, resisting roll moment M = k_phi * dPhi,
  // reacted across half-track lever -> wheel force F = 2 * k_phi * dz / (trackWidthM^2).
  return (2 * torqueNmPerRad) / Math.max(0.5, trackWidthM * trackWidthM);
}

/**
 * Pure, non-mutating physics applier translating an `Lc26GarageSetup` into solver-ready `F12026CarConfig` structures
 * and derived mass/aero/cooling/kinematic parameters.
 */
export function applyLc26SetupToPhysicsConfig(
  setupInput: Lc26GarageSetup,
  bundle: Lc26PhysicsSetupInputBundle = {},
): Lc26AppliedPhysicsSetup {
  const s = sanitizeLc26GarageSetup(setupInput);
  const baseChassis = bundle.chassis ?? LC26_CHASSIS_DATA;

  const dryMassKg = baseChassis.totalMassKg;
  const wetStartMassKg = dryMassKg + s.fuelLoadKg;

  const frhM = s.frontRideHeightMm / 1000;
  const rrhM = s.rearRideHeightMm / 1000;
  const staticRakeDeg =
    Math.atan2(rrhM - frhM, LC26_FIA_DATUM_PLANES.wheelbaseM) * (180 / Math.PI);

  // Parametric cooling gill louvres (1..5): level 3 is zero-offset baseline
  const gillDelta = s.coolingGillLevel - 3;
  const coolingDragDeltaCdA = gillDelta * 0.014; // m^2 CD*A increment per louvre step
  const coolingHeatRejectMultiplier = 1 + gillDelta * 0.07; // 0.86x at lvl 1 .. 1.14x at lvl 5

  // Engine braking level 1..10 -> closed-throttle coast torque multiplier (0.55x .. 1.36x, 1.00x at level 6/5)
  const engineBrakingCoastScale = Number((0.55 + ((s.engineBrakingLevel - 1) / 9) * 0.81).toFixed(4));

  // Solver convention (+steerRad = yaw left):
  // Front toe-out points FL left (+) and FR right (-); Rear toe-in points RL right (-) and RR left (+).
  const DEG2RAD = Math.PI / 180;
  const frontToeRad = s.toeDeg[0] * DEG2RAD;
  const rearToeRad = s.toeDeg[1] * DEG2RAD;

  const presetWingTrim: Record<AeroSetupPreset, { fwDeltaDeg: number; rwDeltaDeg: number; cdScale: number }> = {
    low_downforce: { fwDeltaDeg: -1.0, rwDeltaDeg: -1.5, cdScale: 0.93 },
    balanced: { fwDeltaDeg: 0.0, rwDeltaDeg: 0.0, cdScale: 1.0 },
    high_downforce: { fwDeltaDeg: 0.8, rwDeltaDeg: 1.2, cdScale: 1.06 },
  };
  const aeroTrim = presetWingTrim[s.aeroPreset];

  const aero: AeroData | undefined = bundle.aero
    ? {
        ...bundle.aero,
        drag: Math.max(0.1, bundle.aero.drag * aeroTrim.cdScale + coolingDragDeltaCdA),
        front_target_height: frhM,
        rear_target_height: rrhM,
        wings: bundle.aero.wings.map((w) => {
          if (w.name === 'FRONT_WING') {
            return { ...w, angleDeg: s.frontWingAngleDeg + aeroTrim.fwDeltaDeg };
          }
          if (w.name === 'REAR_WING') {
            return { ...w, angleDeg: s.rearWingAngleDeg + aeroTrim.rwDeltaDeg };
          }
          return { ...w };
        }),
      }
    : undefined;

  const suspensions: SuspensionsData | undefined = bundle.suspensions
    ? {
        ...bundle.suspensions,
        front: {
          ...bundle.suspensions.front,
          staticCamber: (s.camberDeg[0] + s.camberDeg[1]) * 0.5,
          springs: {
            ...bundle.suspensions.front.springs,
            wheel_rate: s.frontCornerRateNmm * 1000,
          },
          heave: {
            ...bundle.suspensions.front.heave,
            rate: s.frontHeaveRateNmm * 1000,
            packerGap: s.frontPackerGapMm / 1000,
          },
          arb: arbNmDegToWheelRateNm(s.frontArbStiffnessNmDeg, baseChassis.trackWidthFront),
        },
        rear: {
          ...bundle.suspensions.rear,
          staticCamber: (s.camberDeg[2] + s.camberDeg[3]) * 0.5,
          springs: {
            ...bundle.suspensions.rear.springs,
            wheel_rate: s.rearCornerRateNmm * 1000,
          },
          heave: {
            ...bundle.suspensions.rear.heave,
            rate: s.rearHeaveRateNmm * 1000,
            packerGap: s.rearPackerGapMm / 1000,
          },
          arb: arbNmDegToWheelRateNm(s.rearArbStiffnessNmDeg, baseChassis.trackWidthRear),
        },
      }
    : undefined;

  const brakes: BrakesData | undefined = bundle.brakes
    ? {
        ...bundle.brakes,
        brakeByWire: true,
        front_bias: s.brakeBiasFrontPct / 100,
        migration: {
          amount: s.brakeMigrationPct / 100,
          rampStart: bundle.brakes.migration?.rampStart ?? 0.2,
        },
      }
    : undefined;

  const differential: DifferentialData | undefined = bundle.differential
    ? {
        ...bundle.differential,
        threePhase: true,
        diffEntryLevel: Math.max(1, Math.min(12, Math.round(1 + (s.diffEntryLockPct / 100) * 11))),
        diffMidLevel: Math.max(1, Math.min(12, Math.round(1 + (s.diffMidCoastLockPct / 100) * 11))),
        settings: {
          ...bundle.differential.settings,
          coast: Number((0.08 + (s.diffMidCoastLockPct / 100) * 0.52).toFixed(4)),
          preload: s.diffHighSpeedPreloadNm,
        },
        coastBraking: Number((0.08 + (s.diffEntryLockPct / 100) * 0.56).toFixed(4)),
      }
    : undefined;

  return {
    sanitizedSetup: s,
    dryMassKg,
    fuelLoadKg: s.fuelLoadKg,
    wetStartMassKg,
    staticRakeDeg,
    coolingDragDeltaCdA,
    coolingHeatRejectMultiplier,
    engineBrakingCoastScale,
    frontStaticToeRadPerWheel: [frontToeRad, -frontToeRad],
    rearStaticToeRadPerWheel: [-rearToeRad, rearToeRad],
    chassis: { ...baseChassis },
    aero,
    suspensions,
    brakes,
    differential,
  };
}

// ---------------------------------------------------------------------------
// 2026 AI Racecraft Strategy & Schema Helpers
// ---------------------------------------------------------------------------

export const LC26_AI_DEFAULT_CIRCUIT_ENTRY: Lc26AiCircuitEntry = {
  paceScale: 1.0,
  brakeScale: 1.0,
  cornerGripScale: 1.0,
  straightModeAggression01: 0.88,
  overtakeSocReserve01: 0.14,
} as const;

export const LC26_AI_MIN_SOC_RESERVE_01 = 0.12 as const;

export interface Lc26AiRacecraftInput {
  readonly throttle01: number;
  readonly brake01: number;
  readonly speedKmh: number;
  readonly lateralG: number;
  readonly inLegalSmZone: boolean;
  /** Progress `[0..1]` along the active Straight Mode zone (`0` = zone start, `1` = braking marker at straight end) */
  readonly smZoneProgress01?: number;
  readonly smZoneMinSpeedKmh?: number;
  readonly smZoneMaxLateralG?: number;
  readonly trackWetness01?: number;
  readonly rearFlapAllowedInWet?: boolean;
  /** Battery State of Charge `0..1` */
  readonly soc01: number;
  /** Electrical energy deployed so far on the current lap (J) */
  readonly lapDeployedJ?: number;
  /** Electrical energy harvested so far on the current lap (J) */
  readonly lapHarvestedJ?: number;
  /** Time gap (s) to the car directly ahead on track (`null` = clean air) */
  readonly gapAheadSeconds: number | null;
  /** Time gap (s) to the pursuing car directly behind (`null` = clear behind) */
  readonly gapBehindSeconds?: number | null;
  /** Whether FIA 2026 Overtake Mode was earned (`< 1.0 s` at the detection point) */
  readonly overtakeEarned?: boolean;
}

export interface Lc26AiRacecraftDecision {
  /** Commands active-aero Straight Mode flaps (`fw_flap_2/3` & `rw_flap_2/3`) when legal and `throttle > 90%` */
  readonly requestStraightMode: boolean;
  readonly expectedAeroMode: Lc26AeroOperatingMode;
  /** Recommended ERS map (`PSH` | `RAC` | `BAL` | `LIC` | `CHR`) */
  readonly ersDeployMode: PerformanceModeName;
  /** True when `< 1.0 s` behind a car ahead so Overtake Mode / override latch is armed */
  readonly armOvertakeMode: boolean;
  /** True when actively deploying FIA Overtake Mode (+0.5 MJ / 337.5 km/h cap) or tactical Boost */
  readonly activateOvertakeBoost: boolean;
  /** True when harvesting / Super Clipping at straight ends to protect `>= 12%` SoC reserve */
  readonly superClipHarvestActive: boolean;
  /** Target MGU-K Super Clipping harvest power (kW, `0..350`) */
  readonly superClipTargetKw: number;
  /** Enforced minimum healthy battery reserve (`>= 0.12`) */
  readonly socReserveFloor01: number;
}

/**
 * Pure 2026 AI Racecraft Controller for VeloSoft LC-26 (`lc26-f1`):
 * 1. Activates Straight Mode in legal SM zones strictly when `throttle > 90%`, off-brakes, above zone min speed,
 *    and within safe lateral-g & track-wetness bounds.
 * 2. Harvests / Super Clips intelligently at straight ends (`smZoneProgress01 >= clipStart`) or whenever SoC
 *    approaches the reserve floor (`>= 12%`), guaranteeing the AI never runs flat mid-straight.
 * 3. Arms and deploys Overtake Mode + tactical Boost when `< 1.0 s` behind a car ahead with healthy SoC.
 */
export function stepLc26AiRacecraft(
  input: Lc26AiRacecraftInput,
  circuitTuning: Partial<Lc26AiCircuitEntry> = LC26_AI_DEFAULT_CIRCUIT_ENTRY,
): Lc26AiRacecraftDecision {
  const aggression = Math.min(1, Math.max(0, circuitTuning.straightModeAggression01 ?? 0.88));
  const socReserveFloor01 = Math.max(
    LC26_AI_MIN_SOC_RESERVE_01,
    Math.min(0.45, circuitTuning.overtakeSocReserve01 ?? 0.14),
  );

  const throttle = Math.min(1, Math.max(0, input.throttle01));
  const brake = Math.min(1, Math.max(0, input.brake01));
  const speedKmh = Math.max(0, input.speedKmh);
  const absLatG = Math.abs(input.lateralG);
  const wetness = Math.min(1, Math.max(0, input.trackWetness01 ?? 0));
  const soc = Math.min(1, Math.max(0, input.soc01));
  const zoneProgress = Math.min(1, Math.max(0, input.smZoneProgress01 ?? 0.35));
  const minSmSpeed = input.smZoneMinSpeedKmh ?? 185;
  const maxSmLatG = (input.smZoneMaxLateralG ?? 1.65) * (0.9 + 0.15 * aggression);

  // 1. Legal Straight Mode evaluation (strictly requires throttle > 90% and legal SM zone)
  const smEligible =
    input.inLegalSmZone &&
    throttle > 0.9 &&
    brake <= 0.02 &&
    speedKmh >= minSmSpeed &&
    absLatG <= maxSmLatG &&
    wetness < 0.65;

  const expectedAeroMode: Lc26AeroOperatingMode = !smEligible
    ? 'corner-mode'
    : wetness >= 0.15 && !input.rearFlapAllowedInWet
      ? 'partial-wet-fw-only'
      : 'straight-mode';

  // 2. Overtake / Attack proximity (`< 1.0 s` behind car ahead) & defensive awareness
  const withinOneSecondAhead =
    input.gapAheadSeconds !== null &&
    Number.isFinite(input.gapAheadSeconds) &&
    input.gapAheadSeconds >= 0 &&
    input.gapAheadSeconds < 1.0;

  const closeDefenseBehind =
    input.gapBehindSeconds !== null &&
    input.gapBehindSeconds !== undefined &&
    Number.isFinite(input.gapBehindSeconds) &&
    input.gapBehindSeconds >= 0 &&
    input.gapBehindSeconds < 0.65;

  const armOvertakeMode = withinOneSecondAhead;

  // Lap energy caps (4.0 MJ standard / 4.5 MJ with Overtake Mode; 8.5 MJ standard / 9.0 MJ harvest)
  const overtakeGranted = Boolean(input.overtakeEarned) || withinOneSecondAhead;
  const deployCapJ =
    LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ +
    (overtakeGranted ? LC26_FIA_POWERTRAIN_LIMITS.overtakeExtraDeployJ : 0);
  const harvestCapJ =
    LC26_FIA_POWERTRAIN_LIMITS.maxHarvestPerLapStandardJ +
    (overtakeGranted ? LC26_FIA_POWERTRAIN_LIMITS.overtakeExtraDeployJ : 0);

  const lapDeployedJ = Math.max(0, input.lapDeployedJ ?? 0);
  const lapHarvestedJ = Math.max(0, input.lapHarvestedJ ?? 0);
  const deployRemainingJ = Math.max(0, deployCapJ - lapDeployedJ);
  const harvestRemainingJ = Math.max(0, harvestCapJ - lapHarvestedJ);

  // 3. Straight-end Super Clipping & healthy SoC protection (>= 12% reserve, never flat mid-straight)
  const atOrBelowReserve = soc <= socReserveFloor01 + 0.005;
  const lowSocBuffer = soc < socReserveFloor01 + 0.08;

  // Clip point moves earlier when SoC is low, later when attacking < 1.0 s with healthy battery
  const baseClipProgress = withinOneSecondAhead ? 0.86 : 0.76 + 0.08 * aggression;
  const socAdjustedClipProgress = lowSocBuffer ? Math.min(baseClipProgress, 0.58) : baseClipProgress;

  const inStraightEndClipWindow =
    throttle > 0.9 &&
    brake <= 0.02 &&
    speedKmh >= 255 &&
    harvestRemainingJ > 25_000 &&
    soc < 0.96 &&
    ((input.inLegalSmZone && zoneProgress >= socAdjustedClipProgress) ||
      (atOrBelowReserve && speedKmh >= 240));

  // Never clip away a committed final-meters pass (< 0.45 s) if SoC is safely above the >= 12% reserve floor
  const committedSideBySidePass =
    withinOneSecondAhead &&
    (input.gapAheadSeconds ?? 1) < 0.45 &&
    soc > socReserveFloor01 + 0.05 &&
    deployRemainingJ > 50_000;

  const superClipHarvestActive = inStraightEndClipWindow && !committedSideBySidePass;

  let superClipTargetKw = 0;
  if (superClipHarvestActive) {
    const urgency01 = Math.min(1, Math.max(0.25, (0.65 - soc) / 0.5));
    const speedFactor01 = Math.min(1, Math.max(0, (speedKmh - 240) / 85));
    superClipTargetKw = Number(
      Math.min(LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw, 110 + 210 * urgency01 * (0.45 + 0.55 * speedFactor01)).toFixed(
        1,
      ),
    );
  }

  // 4. Tactical Boost & Overtake deployment
  const canDeployPower =
    !atOrBelowReserve &&
    !superClipHarvestActive &&
    deployRemainingJ > 15_000 &&
    throttle > 0.85 &&
    brake <= 0.02 &&
    absLatG <= 1.85;

  const activateOvertakeBoost =
    canDeployPower &&
    ((withinOneSecondAhead && soc > socReserveFloor01 + 0.015) ||
      (closeDefenseBehind && soc > socReserveFloor01 + 0.08 && speedKmh >= 210));

  let ersDeployMode: PerformanceModeName = 'RAC';
  if (atOrBelowReserve) {
    ersDeployMode = harvestRemainingJ > 25_000 ? 'CHR' : 'LIC';
  } else if (superClipHarvestActive) {
    ersDeployMode = soc < socReserveFloor01 + 0.1 ? 'CHR' : 'LIC';
  } else if (activateOvertakeBoost) {
    ersDeployMode = 'PSH';
  } else if (lowSocBuffer) {
    ersDeployMode = 'BAL';
  } else if (soc > 0.78 && throttle > 0.8) {
    ersDeployMode = 'PSH';
  }

  return {
    requestStraightMode: smEligible,
    expectedAeroMode,
    ersDeployMode,
    armOvertakeMode,
    activateOvertakeBoost,
    superClipHarvestActive,
    superClipTargetKw,
    socReserveFloor01,
  };
}

/** Validates a parsed `public/ai/lc26-f1*.json` payload against `Lc26AiTuningSchema` invariants. */
export function validateLc26AiTuningSchema(raw: unknown): {
  readonly valid: boolean;
  readonly issues: readonly string[];
} {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { valid: false, issues: ['Root JSON must be an object'] };
  }
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== 1) {
    issues.push(`Expected schemaVersion === 1, received ${String(r.schemaVersion)}`);
  }
  if (r.carId !== LC26_VEHICLE_ID) {
    issues.push(`Expected carId === "${LC26_VEHICLE_ID}", received ${String(r.carId)}`);
  }
  if (typeof r.version !== 'string' || r.version.trim().length === 0) {
    issues.push('Missing non-empty version string');
  }

  const checkEntry = (label: string, entry: unknown, partial: boolean) => {
    if (!entry || typeof entry !== 'object') {
      issues.push(`${label} must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const bounds: Record<keyof Lc26AiCircuitEntry, readonly [number, number]> = {
      paceScale: [0.85, 1.08],
      brakeScale: [0.85, 1.1],
      cornerGripScale: [0.85, 1.1],
      straightModeAggression01: [0.0, 1.0],
      overtakeSocReserve01: [LC26_AI_MIN_SOC_RESERVE_01, 0.45],
    };
    for (const [k, [lo, hi]] of Object.entries(bounds) as [keyof Lc26AiCircuitEntry, readonly [number, number]][]) {
      const v = e[k];
      if (v === undefined && partial) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push(`${label}.${k} must be a finite number`);
      } else if (v < lo - 1e-6 || v > hi + 1e-6) {
        issues.push(`${label}.${k} (${v}) outside [${lo}, ${hi}]`);
      }
    }
  };

  checkEntry('defaults', r.defaults, false);

  if (!r.circuits || typeof r.circuits !== 'object' || Array.isArray(r.circuits)) {
    issues.push('circuits must be a dictionary object');
  } else {
    for (const [cid, cEntry] of Object.entries(r.circuits as Record<string, unknown>)) {
      checkEntry(`circuits.${cid}`, cEntry, true);
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Resolves effective `Lc26AiCircuitEntry` for a given `circuitId` by merging `schema.defaults` + `schema.circuits[circuitId]`. */
export function resolveLc26AiCircuitEntry(
  schema: Lc26AiTuningSchema,
  circuitId?: string,
): Lc26AiCircuitEntry {
  const base = schema.defaults ?? LC26_AI_DEFAULT_CIRCUIT_ENTRY;
  const over = circuitId ? schema.circuits?.[circuitId] : undefined;
  return {
    paceScale: over?.paceScale ?? base.paceScale,
    brakeScale: over?.brakeScale ?? base.brakeScale,
    cornerGripScale: over?.cornerGripScale ?? base.cornerGripScale,
    straightModeAggression01: over?.straightModeAggression01 ?? base.straightModeAggression01,
    overtakeSocReserve01: Math.max(
      LC26_AI_MIN_SOC_RESERVE_01,
      over?.overtakeSocReserve01 ?? base.overtakeSocReserve01,
    ),
  };
}
