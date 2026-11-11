/**
 * Steering-Wheel MFD Telemetry State Builders, 15-LED Shift Bar & Real-Time 2D Canvas
 * Texture Renderer for the VeloSoft LC-26 (`lc26-f1`).
 *
 * Drives both:
 *  1. The 3D steering wheel's `mfd_display` (`INT_DISPLAY` material) `CanvasTexture`
 *     and `led_shift_01..15` emissive nodes in glTF space.
 *  2. The React `Lc26MfdOverlay` motorsport HUD widget across all 5 `Lc26MfdPageId` pages.
 */

import * as THREE from 'three';
import type { CarTelemetry } from '@/types/f1';
import {
  LC26_ACTIVE_AERO_HINGES,
  LC26_FIA_POWERTRAIN_LIMITS,
  LC26_GLB_NODE_NAMES,
  LC26_PLANK_SPEC,
  LC26_SHORT_NAME,
  type Lc26AeroOperatingMode,
  type Lc26BbwSplitResult,
  type Lc26CoolingGillLevel,
  type Lc26CornerThermalState,
  type Lc26FlapDeflectionState,
  type Lc26MfdPageId,
  type Lc26PirelliSlickCode,
  type Lc26PlankWearState,
  type Lc26PowertrainTelemetry,
  type Lc26ShiftLedState,
  type PerformanceModeName,
  type SolverCornerOrder,
  type TireCompound,
} from './contract-types';
import {
  formatLc26PirelliCompoundCode,
  LC26_BASELINE_SETUP,
  LC26_DEFAULT_WEEKEND_ALLOCATION,
  stepLc26AiRacecraft,
  type Lc26WeekendSlickAllocation,
} from './setup';

export { stepLc26AiRacecraft };
export type { Lc26MfdPageId, Lc26ShiftLedState };

// ---------------------------------------------------------------------------
// Constants & Palette
// ---------------------------------------------------------------------------

export const LC26_MFD_PAGES: readonly {
  readonly id: Lc26MfdPageId;
  readonly index: number;
  readonly tag: string;
  readonly title: string;
}[] = [
  { id: 'race-main', index: 1, tag: 'RACE', title: 'Main Race Telemetry' },
  { id: 'ers-active-aero', index: 2, tag: 'ERS/AERO', title: '350 kW ERS & Active Aero' },
  { id: 'tyres-thermals', index: 3, tag: 'TYRES', title: '18" Pirelli Thermals & Pressures' },
  { id: 'brakes-diff', index: 4, tag: 'BRK/DIFF', title: 'BBW Migration & 3-Phase Diff' },
  { id: 'fuel-plank', index: 5, tag: 'FUEL/PLK', title: 'Sustainable Fuel (kg) & Plank Wear' },
] as const;

export function nextLc26MfdPage(current: Lc26MfdPageId): Lc26MfdPageId {
  const idx = LC26_MFD_PAGES.findIndex((p) => p.id === current);
  return LC26_MFD_PAGES[(idx + 1 + LC26_MFD_PAGES.length) % LC26_MFD_PAGES.length].id;
}

export function prevLc26MfdPage(current: Lc26MfdPageId): Lc26MfdPageId {
  const idx = LC26_MFD_PAGES.findIndex((p) => p.id === current);
  return LC26_MFD_PAGES[(idx - 1 + LC26_MFD_PAGES.length) % LC26_MFD_PAGES.length].id;
}

export const LC26_SHIFT_LED_COUNT = 15 as const;

export const LC26_LED_COLORS = {
  off: '#161922',
  green: '#22c55e',
  red: '#ef4444',
  blue: '#3b82f6',
  violet: '#a855f7',
  flashCyan: '#38bdf8',
  pitAmber: '#f59e0b',
  overtakeMagenta: '#d946ef',
} as const;

// ---------------------------------------------------------------------------
// Live Operating Mode Pill (`CM` / `SM` / `WET SM` / `SUPER CLIP` / `OVERTAKE READY` / `OVERTAKE` / `BOOST`)
// ---------------------------------------------------------------------------

export type Lc26LiveModeId =
  | 'CM'
  | 'SM'
  | 'WET SM'
  | 'SUPER CLIP'
  | 'OVERTAKE READY'
  | 'OVERTAKE'
  | 'BOOST';

export interface Lc26LiveModeBadge {
  readonly mode: Lc26LiveModeId;
  readonly aeroBadge: 'CM' | 'SM' | 'WET SM';
  readonly bgHex: string;
  readonly fgHex: string;
  readonly borderHex: string;
  readonly description: string;
}

export const LC26_LIVE_MODE_STYLES: Readonly<
  Record<Lc26LiveModeId, Omit<Lc26LiveModeBadge, 'mode' | 'aeroBadge'>>
> = {
  CM: {
    bgHex: '#1e293b',
    fgHex: '#f8fafc',
    borderHex: '#475569',
    description: 'Corner Mode — Full front & rear wing downforce load',
  },
  SM: {
    bgHex: '#00e5ff',
    fgHex: '#061018',
    borderHex: '#67e8f9',
    description: 'Straight Mode — Dual-link FW & RW flaps flattened for low drag',
  },
  'WET SM': {
    bgHex: '#0284c7',
    fgHex: '#f0f9ff',
    borderHex: '#38bdf8',
    description: 'Partial Wet Straight Mode — Front flaps open, rear wing locked in CM',
  },
  'SUPER CLIP': {
    bgHex: '#f59e0b',
    fgHex: '#090b10',
    borderHex: '#fbbf24',
    description: 'Super Clipping — Full-throttle high-speed MGU-K harvest into ES',
  },
  'OVERTAKE READY': {
    bgHex: '#ccff00',
    fgHex: '#08090d',
    borderHex: '#d9f99d',
    description: 'Overtake Mode Armed (< 1.0 s detection) — +0.5 MJ & 337.5 km/h cap ready',
  },
  OVERTAKE: {
    bgHex: '#a855f7',
    fgHex: '#faf5ff',
    borderHex: '#c084fc',
    description: 'Overtake Mode Active — 350 kW MGU-K override up to 337.5 km/h (+0.5 MJ)',
  },
  BOOST: {
    bgHex: '#ec4899',
    fgHex: '#fdf2f8',
    borderHex: '#f472b6',
    description: 'Tactical Driver Boost — Maximum 350 kW MGU-K manual deployment',
  },
} as const;

export interface Lc26LiveModeInput {
  readonly aeroMode?: Lc26AeroOperatingMode;
  readonly smProgress01?: number;
  readonly throttle01?: number;
  readonly brake01?: number;
  readonly speedKmh?: number;
  readonly mgukPowerKw?: number;
  readonly superClippingOverride?: boolean;
  readonly overtakeAvailable?: boolean;
  readonly overtakeActive?: boolean;
  readonly boostActive?: boolean;
}

/** Resolves the primary live mode pill and secondary aero flap state deterministically. */
export function resolveLc26LiveMode(input: Lc26LiveModeInput): Lc26LiveModeBadge {
  const aeroMode = input.aeroMode ?? ((input.smProgress01 ?? 0) >= 0.5 ? 'straight-mode' : 'corner-mode');
  const aeroBadge: 'CM' | 'SM' | 'WET SM' =
    aeroMode === 'partial-wet-fw-only'
      ? 'WET SM'
      : aeroMode === 'straight-mode' || (input.smProgress01 ?? 0) >= 0.5
        ? 'SM'
        : 'CM';

  const superClipping =
    input.superClippingOverride ??
    ((input.throttle01 ?? 0) >= 0.88 &&
      (input.brake01 ?? 0) <= 0.03 &&
      (input.speedKmh ?? 0) >= 250 &&
      (input.mgukPowerKw ?? 0) < -5);

  let mode: Lc26LiveModeId;
  if (input.boostActive && !input.overtakeActive) {
    mode = 'BOOST';
  } else if (input.overtakeActive) {
    mode = 'OVERTAKE';
  } else if (superClipping) {
    mode = 'SUPER CLIP';
  } else if (input.overtakeAvailable) {
    mode = 'OVERTAKE READY';
  } else if (aeroBadge === 'WET SM') {
    mode = 'WET SM';
  } else if (aeroBadge === 'SM') {
    mode = 'SM';
  } else {
    mode = 'CM';
  }

  return {
    mode,
    aeroBadge,
    ...LC26_LIVE_MODE_STYLES[mode],
  };
}

// ---------------------------------------------------------------------------
// 15-LED Shift Bar State Builder (`Lc26ShiftLedState`)
// ---------------------------------------------------------------------------

export interface Lc26ShiftLedInput {
  readonly rpm: number;
  readonly ledStartRpm?: number;
  readonly shiftFlashRpm?: number;
  readonly revLimitRpm?: number;
  readonly pitLimiterActive?: boolean;
  readonly overtakeActive?: boolean;
  readonly boostActive?: boolean;
  readonly nowMs?: number;
}

/**
 * Pure builder computing `Lc26ShiftLedState` for the 15 steering-wheel LEDs (`led_shift_01..15`):
 *  - LEDs `1..5` (`0..4`): green (`#22c55e`)
 *  - LEDs `6..10` (`5..9`): red (`#ef4444`)
 *  - LEDs `11..15` (`10..14`): blue/violet (`#3b82f6` / `#a855f7`)
 *  - Shift flash (`>= shiftFlashRpm`), pit-limiter alternating blink, and overtake/boost wingtip strobe.
 */
export function computeLc26ShiftLedState(input: Lc26ShiftLedInput): Lc26ShiftLedState {
  const ledStartRpm = input.ledStartRpm ?? 9400;
  const revLimitRpm = input.revLimitRpm ?? LC26_FIA_POWERTRAIN_LIMITS.revLimitRpm;
  const shiftFlashRpm = input.shiftFlashRpm ?? Math.min(revLimitRpm - 200, 11950);
  const rpm = Number.isFinite(input.rpm) ? Math.max(0, input.rpm) : 0;
  const nowMs = Number.isFinite(input.nowMs) ? (input.nowMs as number) : 0;

  const span = Math.max(200, shiftFlashRpm - ledStartRpm);
  const normalized = Math.min(1, Math.max(0, (rpm - ledStartRpm) / span));
  const litCount = Math.min(
    LC26_SHIFT_LED_COUNT,
    Math.max(0, Math.round(normalized * LC26_SHIFT_LED_COUNT)),
  );

  const pitLimiterBlink = Boolean(input.pitLimiterActive);
  const shiftFlashActive = !pitLimiterBlink && rpm >= shiftFlashRpm;
  const overtakeStrobeActive = !pitLimiterBlink && Boolean(input.overtakeActive || input.boostActive);

  const colorsHex: string[] = new Array<string>(LC26_SHIFT_LED_COUNT).fill(LC26_LED_COLORS.off);

  if (pitLimiterBlink) {
    // 4 Hz alternating even/odd pit-lane speed limiter pattern
    const phaseEven = Math.floor(Math.max(0, nowMs) / 125) % 2 === 0;
    for (let i = 0; i < LC26_SHIFT_LED_COUNT; i++) {
      if ((i % 2 === 0) === phaseEven) {
        colorsHex[i] = i < 3 || i >= 12 ? LC26_LED_COLORS.blue : LC26_LED_COLORS.pitAmber;
      }
    }
  } else if (shiftFlashActive) {
    // 8 Hz high-visibility upshift / limiter flash (ON at phase 0 so static/t=0 frames light brightly)
    const flashOn = Math.floor(Math.max(0, nowMs) / 62.5) % 2 === 0;
    const flashHex = overtakeStrobeActive ? LC26_LED_COLORS.violet : LC26_LED_COLORS.flashCyan;
    for (let i = 0; i < LC26_SHIFT_LED_COUNT; i++) {
      colorsHex[i] = flashOn ? flashHex : LC26_LED_COLORS.off;
    }
  } else {
    for (let i = 0; i < litCount; i++) {
      if (i < 5) {
        colorsHex[i] = LC26_LED_COLORS.green;
      } else if (i < 10) {
        colorsHex[i] = LC26_LED_COLORS.red;
      } else if (i < 13) {
        colorsHex[i] = LC26_LED_COLORS.blue;
      } else {
        colorsHex[i] = LC26_LED_COLORS.violet;
      }
    }

    if (overtakeStrobeActive) {
      // 10 Hz violet/magenta outer-pair overtake strobe on LEDs 1..2 & 14..15 when unlit or accenting
      const strobeOn = Math.floor(Math.max(0, nowMs) / 50) % 2 === 0;
      const strobeHex = strobeOn ? LC26_LED_COLORS.violet : LC26_LED_COLORS.overtakeMagenta;
      for (const idx of [0, 1, 13, 14]) {
        if (idx >= litCount || strobeOn) {
          colorsHex[idx] = strobeHex;
        }
      }
    }
  }

  return {
    litCount,
    pitLimiterBlink,
    shiftFlashActive,
    overtakeStrobeActive,
    colorsHex,
  };
}

// ---------------------------------------------------------------------------
// Structured MFD View-Model Types (All 5 Pages)
// ---------------------------------------------------------------------------

export interface Lc26MfdCornerTyreView {
  readonly corner: 'FL' | 'FR' | 'RL' | 'RR';
  readonly surfaceTempC: number;
  readonly bulkTempC: number;
  readonly coreTempC: number;
  readonly bandsTempC: readonly [inner: number, middle: number, outer: number];
  readonly pressurePsi: number;
  readonly wearPct: number;
  readonly remainingLifePct: number;
  readonly grainingPct: number;
  readonly blisteringPct: number;
  readonly brakeTempC: number;
  readonly tempColorHex: string;
}

export interface Lc26MfdViewModel {
  readonly activePage: Lc26MfdPageId;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly pageTag: string;
  readonly pageTitle: string;

  // Core header & shift bar
  readonly shiftLeds: Lc26ShiftLedState;
  readonly liveMode: Lc26LiveModeBadge;
  readonly gearLabel: string; // 'R' | 'N' | '1'..'8'
  readonly gearNumeric: number;
  readonly speedKmh: number;
  readonly rpm: number;
  readonly revLimitRpm: number;
  readonly throttlePct: number;
  readonly brakePct: number;
  readonly currentLapTimeFormatted: string;
  readonly deltaSeconds: number | null;
  readonly deltaFormatted: string;

  // Hybrid 350 kW ERS & Lap Energy Budgets (MJ)
  readonly socPct: number;
  readonly ersDeployMode: PerformanceModeName;
  readonly mgukPowerKw: number;
  readonly icePowerKw: number;
  readonly speedDerateCapKw: number;
  readonly lapHarvestMj: number;
  readonly lapHarvestCapMj: number; // 8.5 MJ standard, 9.0 MJ with Overtake recharge allowance
  readonly lapHarvestRatio01: number;
  readonly lapDeployMj: number;
  readonly lapDeployCapMj: number; // 4.0 MJ standard, 4.5 MJ with Overtake +0.5 MJ allowance
  readonly lapDeployRatio01: number;

  // Active Aero
  readonly aeroOperatingMode: Lc26AeroOperatingMode;
  readonly smProgressPct: number;
  readonly flapsDeg: {
    readonly fwFlap2: number;
    readonly fwFlap3: number;
    readonly rwFlap2: number;
    readonly rwFlap3: number;
  };
  readonly downforceKgf: number;
  readonly dragN: number;
  readonly aeroBalanceFrontPct: number;
  readonly floorStallPct: number;
  readonly coolingGillLevel: Lc26CoolingGillLevel;

  // Tyres & Thermals (Ordered [FL, FR, RL, RR])
  readonly compound: TireCompound;
  readonly pirelliCode: Lc26PirelliSlickCode | 'INT' | 'WET';
  readonly corners: SolverCornerOrder<Lc26MfdCornerTyreView>;

  // Brakes (BBW) & 3-Phase Differential
  readonly brakeBiasFrontPct: number;
  readonly brakeMigrationPct: number;
  readonly effectiveFrontBiasPct: number;
  readonly rearHydraulicTorqueNm: number;
  readonly rearMgukRegenTorqueNm: number;
  readonly diffEntryLockPct: number;
  readonly diffMidCoastLockPct: number;
  readonly diffHighSpeedPreloadNm: number;
  readonly engineBrakingLevel: number;

  // Fuel (strictly in kg) & 10 mm Plank Wear
  readonly fuelKg: number;
  readonly fuelMassFlowKgS: number;
  readonly fuelEnergyFlowMjH: number;
  readonly fuelPerLapKg: number | null;
  readonly estimatedLapsRemaining: number | null;
  readonly frontRideHeightMm: number;
  readonly rearRideHeightMm: number;
  readonly plank: {
    readonly frontSplitterMm: number;
    readonly midFloorMm: number;
    readonly rearTeaTrayMm: number;
    readonly minLegalMm: number;
    readonly worstWearMm: number;
    readonly legal: boolean;
    readonly sparkIntensityPct: number;
  };
}

export interface Lc26MfdTelemetryInput {
  readonly activePage?: Lc26MfdPageId;
  readonly nowMs?: number;
  readonly rpm: number;
  readonly revLimitRpm?: number;
  readonly gear: number;
  readonly speedKmh: number;
  readonly throttle01: number;
  readonly brake01: number;
  readonly currentLapTimeMs?: number;
  readonly deltaSeconds?: number | null;
  readonly pitLimiterActive?: boolean;

  // Hybrid & Powertrain
  readonly soc01: number;
  readonly ersDeployMode?: PerformanceModeName;
  readonly mgukPowerKw: number;
  readonly icePowerKw?: number;
  readonly speedDerateCapKw?: number;
  readonly lapHarvestedJ?: number;
  readonly lapDeployedJ?: number;
  readonly overtakeAvailable?: boolean;
  readonly overtakeModeActive?: boolean;
  readonly boostActive?: boolean;
  readonly superClippingOverride?: boolean;
  readonly powertrain?: Partial<Lc26PowertrainTelemetry>;

  // Active Aero
  readonly flaps?: Partial<Lc26FlapDeflectionState>;
  readonly downforceN?: number;
  readonly dragN?: number;
  readonly aeroBalanceFront01?: number;
  readonly floorStallFactor01?: number;
  readonly coolingGillLevel?: Lc26CoolingGillLevel;

  // Tyres & Thermals
  readonly compound?: TireCompound;
  readonly weekendAllocation?: Lc26WeekendSlickAllocation;
  readonly cornerThermals?: SolverCornerOrder<Partial<Lc26CornerThermalState>>;
  readonly tireTempsC?: SolverCornerOrder<number>;
  readonly tirePressuresPsi?: SolverCornerOrder<number>;
  readonly tireWearPct?: SolverCornerOrder<number>;
  readonly brakeTempsC?: SolverCornerOrder<number>;

  // Brakes & Diff
  readonly brakeBiasFrontPct?: number;
  readonly brakeMigrationPct?: number;
  readonly bbwSplit?: Partial<Lc26BbwSplitResult>;
  readonly diffEntryLockPct?: number;
  readonly diffMidCoastLockPct?: number;
  readonly diffHighSpeedPreloadNm?: number;
  readonly engineBrakingLevel?: number;

  // Fuel (strictly in kg) & Plank
  readonly fuelKg: number;
  readonly fuelMassFlowKgS?: number;
  readonly fuelEnergyFlowMjH?: number;
  readonly fuelPerLapKg?: number | null;
  readonly frontRideHeightMm?: number;
  readonly rearRideHeightMm?: number;
  readonly plankWear?: Partial<Lc26PlankWearState>;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

export function formatLc26LapTime(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '--:--.---';
  const whole = Math.floor(ms);
  const min = Math.floor(whole / 60000);
  const sec = Math.floor(whole / 1000) % 60;
  const milli = whole % 1000;
  return `${min}:${String(sec).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

export function formatLc26Delta(deltaS: number | null | undefined): string {
  if (deltaS === null || deltaS === undefined || !Number.isFinite(deltaS)) return '-.---';
  const sign = deltaS > 0.0005 ? '+' : deltaS < -0.0005 ? '-' : '±';
  return `${sign}${Math.abs(deltaS).toFixed(3)}`;
}

export function tyreTempToHex(tempC: number, compound: TireCompound): string {
  const [optLo, optHi] =
    compound === 'wet'
      ? [45, 70]
      : compound === 'intermediate'
        ? [60, 85]
        : [85, 106];
  if (tempC < optLo - 15) return '#3b82f6'; // cold blue
  if (tempC < optLo) return '#38bdf8'; // warming sky
  if (tempC <= optHi) return '#22c55e'; // optimal green
  if (tempC <= optHi + 10) return '#f59e0b'; // warm amber
  return '#ef4444'; // overheating red
}

/** Pure view-model builder across all 5 `Lc26MfdPageId` pages. */
export function buildLc26MfdViewModel(input: Lc26MfdTelemetryInput): Lc26MfdViewModel {
  const activePage: Lc26MfdPageId = input.activePage ?? 'race-main';
  const pageMeta = LC26_MFD_PAGES.find((p) => p.id === activePage) ?? LC26_MFD_PAGES[0];

  const revLimitRpm = input.revLimitRpm ?? LC26_FIA_POWERTRAIN_LIMITS.revLimitRpm;
  const rpm = clamp(input.rpm, 0, LC26_FIA_POWERTRAIN_LIMITS.fiaMaxRpm);
  const speedKmh = Math.max(0, Number.isFinite(input.speedKmh) ? input.speedKmh : 0);
  const throttle01 = clamp(input.throttle01, 0, 1);
  const brake01 = clamp(input.brake01, 0, 1);
  const gearNumeric = Math.trunc(Number.isFinite(input.gear) ? input.gear : 0);
  const gearLabel = gearNumeric < 0 ? 'R' : gearNumeric === 0 ? 'N' : String(gearNumeric);

  const mgukPowerKw = clamp(
    input.powertrain?.mgukPowerKw ?? input.mgukPowerKw,
    -LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw,
    LC26_FIA_POWERTRAIN_LIMITS.mgukMaxPowerKw,
  );
  const icePowerKw = Math.max(0, input.powertrain?.icePowerKw ?? input.icePowerKw ?? 0);
  const overtakeActive = Boolean(input.powertrain?.overtakeModeActive ?? input.overtakeModeActive);
  const boostActive = Boolean(input.boostActive);
  const overtakeAvailable = Boolean(input.overtakeAvailable);

  const smProgress01 = clamp(input.flaps?.smProgress01 ?? 0, 0, 1);
  const aeroOperatingMode: Lc26AeroOperatingMode =
    input.flaps?.mode ?? (smProgress01 >= 0.5 ? 'straight-mode' : 'corner-mode');

  const liveMode = resolveLc26LiveMode({
    aeroMode: aeroOperatingMode,
    smProgress01,
    throttle01,
    brake01,
    speedKmh,
    mgukPowerKw,
    superClippingOverride: input.superClippingOverride,
    overtakeAvailable,
    overtakeActive,
    boostActive,
  });

  const shiftLeds = computeLc26ShiftLedState({
    rpm,
    revLimitRpm,
    pitLimiterActive: input.pitLimiterActive,
    overtakeActive,
    boostActive,
    nowMs: input.nowMs,
  });

  const soc01 = clamp(input.powertrain?.soc01 ?? input.soc01, 0, 1);
  const socPct = Number((soc01 * 100).toFixed(1));

  // Lap energy budgets: 8.5 MJ standard / 9.0 MJ Overtake harvest; 4.0 MJ standard / 4.5 MJ Overtake deploy
  const hasOvertakeAllowance = overtakeActive || overtakeAvailable;
  const lapHarvestCapMj = hasOvertakeAllowance ? 9.0 : 8.5;
  const lapDeployCapMj = hasOvertakeAllowance ? 4.5 : 4.0;
  const lapHarvestMj = Number(
    Math.max(0, (input.powertrain?.lapHarvestedJ ?? input.lapHarvestedJ ?? 0) / 1_000_000).toFixed(2),
  );
  const lapDeployMj = Number(
    Math.max(0, (input.powertrain?.lapDeployedJ ?? input.lapDeployedJ ?? 0) / 1_000_000).toFixed(2),
  );
  const lapHarvestRatio01 = clamp(lapHarvestMj / lapHarvestCapMj, 0, 1);
  const lapDeployRatio01 = clamp(lapDeployMj / lapDeployCapMj, 0, 1);

  const speedDerateCapKw =
    input.powertrain?.speedDerateCapKw ??
    input.speedDerateCapKw ??
    computeFiaMgukCapPreviewKw(speedKmh, overtakeActive);

  // Active aero flap angles
  const flapsDeg = {
    fwFlap2: Number(
      (input.flaps?.fwFlap2Deg ?? LC26_ACTIVE_AERO_HINGES.fwFlap2.straightModeAngleDeg * smProgress01).toFixed(1),
    ),
    fwFlap3: Number(
      (input.flaps?.fwFlap3Deg ?? LC26_ACTIVE_AERO_HINGES.fwFlap3.straightModeAngleDeg * smProgress01).toFixed(1),
    ),
    rwFlap2: Number(
      (
        input.flaps?.rwFlap2Deg ??
        (aeroOperatingMode === 'partial-wet-fw-only'
          ? 0
          : LC26_ACTIVE_AERO_HINGES.rwFlap2.straightModeAngleDeg * smProgress01)
      ).toFixed(1),
    ),
    rwFlap3: Number(
      (
        input.flaps?.rwFlap3Deg ??
        (aeroOperatingMode === 'partial-wet-fw-only'
          ? 0
          : LC26_ACTIVE_AERO_HINGES.rwFlap3.straightModeAngleDeg * smProgress01)
      ).toFixed(1),
    ),
  };

  // Tyres & 4-corner thermals [FL, FR, RL, RR]
  const compound: TireCompound = input.compound ?? LC26_BASELINE_SETUP.compound;
  const allocation = input.weekendAllocation ?? LC26_DEFAULT_WEEKEND_ALLOCATION;
  const pirelliCode = formatLc26PirelliCompoundCode(compound, allocation);
  const cornerNames = ['FL', 'FR', 'RL', 'RR'] as const;
  const defaultTemps: SolverCornerOrder<number> = [92, 92, 94, 94];
  const defaultPsi: SolverCornerOrder<number> = LC26_BASELINE_SETUP.coldPressurePsi;
  const defaultBrakes: SolverCornerOrder<number> = [480, 480, 420, 420];

  const corners = cornerNames.map((corner, idx) => {
    const th = input.cornerThermals?.[idx];
    const baseTemp = input.tireTempsC?.[idx] ?? defaultTemps[idx];
    const bands: readonly [number, number, number] = th?.surfaceBandsC ?? [
      baseTemp + 2,
      baseTemp,
      baseTemp - 2,
    ];
    const surfaceTempC = Number(((bands[0] + bands[1] + bands[2]) / 3).toFixed(1));
    const bulkBands = th?.bulkBandsC ?? [baseTemp, baseTemp - 1, baseTemp - 2];
    const bulkTempC = Number(((bulkBands[0] + bulkBands[1] + bulkBands[2]) / 3).toFixed(1));
    const coreTempC = Number((th?.coreC ?? baseTemp - 3).toFixed(1));
    const pressurePsi = Number(
      (th?.carcassDynamicPsi ?? input.tirePressuresPsi?.[idx] ?? defaultPsi[idx]).toFixed(1),
    );
    const remainingLife01 =
      th?.remainingLife01 ?? clamp(1 - (input.tireWearPct?.[idx] ?? 0) / 100, 0, 1);
    const wearPct = Number(((1 - remainingLife01) * 100).toFixed(1));
    const remainingLifePct = Number((remainingLife01 * 100).toFixed(1));
    const grainingPct = Number((clamp(th?.graining01 ?? 0, 0, 1) * 100).toFixed(0));
    const blisteringPct = Number((clamp(th?.blistering01 ?? 0, 0, 1) * 100).toFixed(0));
    const brakeTempC = Math.round(input.brakeTempsC?.[idx] ?? defaultBrakes[idx]);
    return {
      corner,
      surfaceTempC,
      bulkTempC,
      coreTempC,
      bandsTempC: [Math.round(bands[0]), Math.round(bands[1]), Math.round(bands[2])] as const,
      pressurePsi,
      wearPct,
      remainingLifePct,
      grainingPct,
      blisteringPct,
      brakeTempC,
      tempColorHex: tyreTempToHex(surfaceTempC, compound),
    } satisfies Lc26MfdCornerTyreView;
  }) as unknown as SolverCornerOrder<Lc26MfdCornerTyreView>;

  // Brakes & BBW migration
  const brakeBiasFrontPct = Number(
    (input.brakeBiasFrontPct ?? LC26_BASELINE_SETUP.brakeBiasFrontPct).toFixed(1),
  );
  const brakeMigrationPct = Number(
    (input.brakeMigrationPct ?? LC26_BASELINE_SETUP.brakeMigrationPct).toFixed(1),
  );
  const computedEffectiveBias =
    input.bbwSplit?.effectiveFrontBias01 !== undefined
      ? input.bbwSplit.effectiveFrontBias01 * 100
      : brakeBiasFrontPct + brakeMigrationPct * clamp((brake01 - 0.2) / 0.8, 0, 1);
  const effectiveFrontBiasPct = Number(clamp(computedEffectiveBias, 45, 72).toFixed(1));

  // Fuel (strictly in kg) & Plank
  const fuelKg = Number(Math.max(0, input.fuelKg).toFixed(2));
  const fuelEnergyFlowMjH = Number(
    Math.max(
      0,
      input.powertrain?.fuelEnergyFlowMjH ??
        input.fuelEnergyFlowMjH ??
        throttle01 * Math.min(3000, 0.27 * rpm + 165),
    ).toFixed(0),
  );
  const fuelMassFlowKgS = Number(
    Math.max(
      0,
      input.powertrain?.fuelMassFlowKgS ??
        input.fuelMassFlowKgS ??
        fuelEnergyFlowMjH / (3600 * LC26_FIA_POWERTRAIN_LIMITS.sustainableFuelLhvMjPerKg),
    ).toFixed(5),
  );
  const fuelPerLapKg =
    input.fuelPerLapKg !== undefined && input.fuelPerLapKg !== null && input.fuelPerLapKg > 0.05
      ? Number(input.fuelPerLapKg.toFixed(2))
      : null;
  const estimatedLapsRemaining =
    fuelPerLapKg !== null && fuelKg > 0 ? Number((fuelKg / fuelPerLapKg).toFixed(1)) : null;

  const frontSplitterMm = Number(
    (input.plankWear?.frontSplitterMm ?? LC26_PLANK_SPEC.thicknessNewMm).toFixed(2),
  );
  const midFloorMm = Number((input.plankWear?.midFloorMm ?? LC26_PLANK_SPEC.thicknessNewMm).toFixed(2));
  const rearTeaTrayMm = Number(
    (input.plankWear?.rearTeaTrayMm ?? LC26_PLANK_SPEC.thicknessNewMm).toFixed(2),
  );
  const minRemainingMm = Math.min(frontSplitterMm, midFloorMm, rearTeaTrayMm);
  const worstWearMm = Number(Math.max(0, LC26_PLANK_SPEC.thicknessNewMm - minRemainingMm).toFixed(2));

  return {
    activePage,
    pageNumber: pageMeta.index,
    pageCount: LC26_MFD_PAGES.length,
    pageTag: pageMeta.tag,
    pageTitle: pageMeta.title,
    shiftLeds,
    liveMode,
    gearLabel,
    gearNumeric,
    speedKmh: Math.round(speedKmh),
    rpm: Math.round(rpm),
    revLimitRpm,
    throttlePct: Math.round(throttle01 * 100),
    brakePct: Math.round(brake01 * 100),
    currentLapTimeFormatted: formatLc26LapTime(input.currentLapTimeMs),
    deltaSeconds: input.deltaSeconds ?? null,
    deltaFormatted: formatLc26Delta(input.deltaSeconds),

    socPct,
    ersDeployMode: (input.ersDeployMode ?? LC26_BASELINE_SETUP.ersDeployMode) as PerformanceModeName,
    mgukPowerKw: Math.round(mgukPowerKw),
    icePowerKw: Math.round(icePowerKw),
    speedDerateCapKw: Math.round(speedDerateCapKw),
    lapHarvestMj,
    lapHarvestCapMj,
    lapHarvestRatio01,
    lapDeployMj,
    lapDeployCapMj,
    lapDeployRatio01,

    aeroOperatingMode,
    smProgressPct: Math.round(smProgress01 * 100),
    flapsDeg,
    downforceKgf: Math.round((input.downforceN ?? 0) / 9.80665),
    dragN: Math.round(input.dragN ?? 0),
    aeroBalanceFrontPct: Number(((input.aeroBalanceFront01 ?? 0.46) * 100).toFixed(1)),
    floorStallPct: Math.round(clamp(input.floorStallFactor01 ?? 0, 0, 1) * 100),
    coolingGillLevel: input.coolingGillLevel ?? LC26_BASELINE_SETUP.coolingGillLevel,

    compound,
    pirelliCode,
    corners,

    brakeBiasFrontPct,
    brakeMigrationPct,
    effectiveFrontBiasPct,
    rearHydraulicTorqueNm: Math.round(input.bbwSplit?.rearHydraulicTorqueNm ?? 0),
    rearMgukRegenTorqueNm: Math.round(input.bbwSplit?.rearMgukRegenTorqueNm ?? 0),
    diffEntryLockPct: Math.round(input.diffEntryLockPct ?? LC26_BASELINE_SETUP.diffEntryLockPct),
    diffMidCoastLockPct: Math.round(input.diffMidCoastLockPct ?? LC26_BASELINE_SETUP.diffMidCoastLockPct),
    diffHighSpeedPreloadNm: Math.round(
      input.diffHighSpeedPreloadNm ?? LC26_BASELINE_SETUP.diffHighSpeedPreloadNm,
    ),
    engineBrakingLevel: Math.round(input.engineBrakingLevel ?? LC26_BASELINE_SETUP.engineBrakingLevel),

    fuelKg,
    fuelMassFlowKgS,
    fuelEnergyFlowMjH,
    fuelPerLapKg,
    estimatedLapsRemaining,
    frontRideHeightMm: Number(
      (input.frontRideHeightMm ?? LC26_BASELINE_SETUP.frontRideHeightMm).toFixed(1),
    ),
    rearRideHeightMm: Number(
      (input.rearRideHeightMm ?? LC26_BASELINE_SETUP.rearRideHeightMm).toFixed(1),
    ),
    plank: {
      frontSplitterMm,
      midFloorMm,
      rearTeaTrayMm,
      minLegalMm: LC26_PLANK_SPEC.minLegalThicknessMm,
      worstWearMm,
      legal: minRemainingMm >= LC26_PLANK_SPEC.minLegalThicknessMm,
      sparkIntensityPct: Math.round(clamp(input.plankWear?.sparkIntensity01 ?? 0, 0, 1) * 100),
    },
  };
}

function computeFiaMgukCapPreviewKw(speedKmh: number, overtakeModeActive: boolean): number {
  if (overtakeModeActive) {
    if (speedKmh <= 337.5) return 350;
    if (speedKmh < 355) return Math.max(0, 7100 - 20 * speedKmh);
    return 0;
  }
  if (speedKmh <= 290) return 350;
  if (speedKmh < 340) return 1800 - 5 * speedKmh;
  if (speedKmh < 345) return 6900 - 20 * speedKmh;
  return 0;
}

/** Adapter converting LibreCorsa `CarTelemetry` (+ optional LC-26 overrides) into `Lc26MfdViewModel`. */
export function fromCarTelemetryToLc26Mfd(
  telemetry: CarTelemetry,
  overrides: Partial<Lc26MfdTelemetryInput> = {},
): Lc26MfdViewModel {
  const tuner = telemetry.liveTuner;
  const ersModeRaw = tuner?.ersMode ?? telemetry.f12026?.performanceMode ?? 'RAC';
  const ersDeployMode: PerformanceModeName = (
    ['PSH', 'RAC', 'BAL', 'LIC', 'CHR'].includes(ersModeRaw) ? ersModeRaw : 'RAC'
  ) as PerformanceModeName;

  const isXMode = telemetry.activeAeroMode === 'X_MODE' || Boolean(telemetry.f12026?.CHANGED_DRS_OPEN);
  const frontRhMm =
    telemetry.wheelRideHeightsMm
      ? (telemetry.wheelRideHeightsMm[0] + telemetry.wheelRideHeightsMm[1]) * 0.5
      : LC26_BASELINE_SETUP.frontRideHeightMm;
  const rearRhMm =
    telemetry.wheelRideHeightsMm
      ? (telemetry.wheelRideHeightsMm[2] + telemetry.wheelRideHeightsMm[3]) * 0.5
      : LC26_BASELINE_SETUP.rearRideHeightMm;

  return buildLc26MfdViewModel({
    rpm: telemetry.rpm,
    gear: telemetry.gear,
    speedKmh: telemetry.speedKmh,
    throttle01: telemetry.throttle,
    brake01: telemetry.brake,
    currentLapTimeMs: telemetry.currentLapTimeMs,
    soc01: telemetry.ersBatteryPercent / 100,
    ersDeployMode,
    mgukPowerKw: telemetry.mgukPowerKw,
    icePowerKw: telemetry.icePowerKw,
    overtakeAvailable: telemetry.overtakeAvailable,
    overtakeModeActive:
      telemetry.overtakingRules === 'straight-mode-2026' &&
      telemetry.manualOverrideActive &&
      telemetry.overtakeAvailable !== false,
    boostActive:
      telemetry.manualOverrideActive && telemetry.overtakingRules !== 'straight-mode-2026',
    flaps: {
      mode: isXMode ? 'straight-mode' : 'corner-mode',
      smProgress01: isXMode ? 1 : 0,
    },
    downforceN: telemetry.downforceN,
    dragN: telemetry.dragN,
    aeroBalanceFront01:
      telemetry.aeroCopFrontPct !== undefined ? telemetry.aeroCopFrontPct / 100 : 0.46,
    floorStallFactor01:
      telemetry.floorStallFactor !== undefined ? Math.max(0, 1 - telemetry.floorStallFactor) : 0,
    tireTempsC: telemetry.tireTempsC,
    tirePressuresPsi: telemetry.tirePressuresPsi,
    tireWearPct: telemetry.tireWearPct,
    brakeTempsC: telemetry.brakeTempsC,
    brakeBiasFrontPct: tuner?.brakeBiasPct ?? LC26_BASELINE_SETUP.brakeBiasFrontPct,
    brakeMigrationPct: tuner?.brakeMigrationPct ?? LC26_BASELINE_SETUP.brakeMigrationPct,
    diffEntryLockPct: tuner ? Math.round(((tuner.diffEntry - 1) / 11) * 70 + 10) : undefined,
    diffMidCoastLockPct: tuner ? Math.round(((tuner.diffMid - 1) / 11) * 70 + 10) : undefined,
    fuelKg: telemetry.fuelKg,
    frontRideHeightMm: frontRhMm,
    rearRideHeightMm: rearRhMm,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Crisp 2D Canvas Renderer (`renderLc26WheelMfdCanvas`) for 3D `INT_DISPLAY`
// ---------------------------------------------------------------------------

/** Minimal 2D canvas surface subset so headless tests & browser `CanvasRenderingContext2D` both work seamlessly. */
export type Lc26Canvas2DContext = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'font'
  | 'textAlign'
  | 'textBaseline'
  | 'fillRect'
  | 'strokeRect'
  | 'clearRect'
  | 'fillText'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'save'
  | 'restore'
>;

function drawBar(
  ctx: Lc26Canvas2DContext,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio01: number,
  fillHex: string,
  trackHex = '#141824',
): void {
  ctx.fillStyle = trackHex;
  ctx.fillRect(x, y, w, h);
  const fw = Math.max(0, Math.min(w, w * clamp(ratio01, 0, 1)));
  if (fw > 0.5) {
    ctx.fillStyle = fillHex;
    ctx.fillRect(x, y, fw, h);
  }
}

function drawTelemetryCell(
  ctx: Lc26Canvas2DContext,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  valueColor = '#f8fafc',
  scale = 1,
): void {
  ctx.fillStyle = '#0d111a';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#1e2638';
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(x, y, w, h);

  ctx.fillStyle = '#8b95a9';
  ctx.font = `700 ${Math.round(11 * scale)}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, x + 6 * scale, y + 4 * scale);

  ctx.fillStyle = valueColor;
  ctx.font = `800 ${Math.round(20 * scale)}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(value, x + w - 6 * scale, y + h - 4 * scale);
}

/**
 * Paints the LC-26 steering wheel's `INT_DISPLAY` (`mfd_display` node, nominal 512x312 or 512x256)
 * `CanvasTexture` in real time across all 5 `Lc26MfdPageId` telemetry pages.
 */
export function renderLc26WheelMfdCanvas(
  ctx: Lc26Canvas2DContext,
  width: number,
  height: number,
  stateInput: Lc26MfdViewModel | Lc26MfdTelemetryInput,
): void {
  const state: Lc26MfdViewModel =
    'shiftLeds' in stateInput ? stateInput : buildLc26MfdViewModel(stateInput);
  const w = Math.max(128, width);
  const h = Math.max(96, height);
  const sx = w / 512;
  const sy = h / 312;
  const sc = Math.min(sx, sy);

  ctx.save();

  // 1. Deep OLED carbon background & bezel border
  ctx.fillStyle = '#05070c';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#20293d';
  ctx.lineWidth = Math.max(1, 2 * sc);
  ctx.strokeRect(1, 1, w - 2, h - 2);

  // 2. Top 15-LED Shift Strip (`1..5` green, `6..10` red, `11..15` blue/violet)
  const padX = 12 * sx;
  const ledY = 8 * sy;
  const ledH = 16 * sy;
  const ledGap = 3.5 * sx;
  const ledW = (w - 2 * padX - (LC26_SHIFT_LED_COUNT - 1) * ledGap) / LC26_SHIFT_LED_COUNT;
  for (let i = 0; i < LC26_SHIFT_LED_COUNT; i++) {
    ctx.fillStyle = state.shiftLeds.colorsHex[i] ?? LC26_LED_COLORS.off;
    ctx.fillRect(padX + i * (ledW + ledGap), ledY, ledW, ledH);
  }

  // 3. Header Status Bar: Vehicle Tag | Live Mode Pill | Aero Sub-Badge | Page Index
  const hdrY = 30 * sy;
  const hdrH = 28 * sy;
  ctx.fillStyle = '#0c1018';
  ctx.fillRect(padX, hdrY, w - 2 * padX, hdrH);

  ctx.fillStyle = '#94a3b8';
  ctx.font = `700 ${Math.round(12 * sc)}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${LC26_SHORT_NAME} · ${state.ersDeployMode}`, padX + 8 * sx, hdrY + hdrH * 0.5);

  // Live mode pill (`CM` / `SM` / `WET SM` / `SUPER CLIP` / `OVERTAKE READY` / `OVERTAKE` / `BOOST`)
  const pillW = 164 * sx;
  const pillX = (w - pillW) * 0.5;
  ctx.fillStyle = state.liveMode.bgHex;
  ctx.fillRect(pillX, hdrY + 2 * sy, pillW, hdrH - 4 * sy);
  ctx.strokeStyle = state.liveMode.borderHex;
  ctx.lineWidth = Math.max(1, 1.5 * sc);
  ctx.strokeRect(pillX, hdrY + 2 * sy, pillW, hdrH - 4 * sy);

  ctx.fillStyle = state.liveMode.fgHex;
  ctx.font = `800 ${Math.round(13 * sc)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(state.liveMode.mode, pillX + pillW * 0.5, hdrY + hdrH * 0.5);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = `700 ${Math.round(11 * sc)}px monospace`;
  ctx.textAlign = 'right';
  ctx.fillText(
    `${state.pageTag} ${state.pageNumber}/${state.pageCount}`,
    w - padX - 8 * sx,
    hdrY + hdrH * 0.5,
  );

  // 4. Page-Specific Body Area
  const bodyTop = 64 * sy;
  const bodyH = h - bodyTop - 42 * sy;

  if (state.activePage === 'race-main') {
    // Left column: SoC, Fuel (kg), BBW Bias
    const colW = 148 * sx;
    const cellH = (bodyH - 12 * sy) / 3;
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop,
      colW,
      cellH,
      'ERS SOC',
      `${state.socPct.toFixed(0)}%`,
      state.socPct <= 15 ? '#ef4444' : '#ccff00',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + cellH + 6 * sy,
      colW,
      cellH,
      'FUEL MASS',
      `${state.fuelKg.toFixed(1)} kg`,
      '#38bdf8',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + 2 * (cellH + 6 * sy),
      colW,
      cellH,
      'BBW BIAS',
      `${state.effectiveFrontBiasPct.toFixed(1)}%`,
      '#f8fafc',
      sc,
    );

    // Center hero pod: Giant Gear + Speed + RPM
    const centerX = padX + colW + 8 * sx;
    const centerW = w - 2 * padX - 2 * colW - 16 * sx;
    ctx.fillStyle = '#0b0f17';
    ctx.fillRect(centerX, bodyTop, centerW, bodyH);
    ctx.strokeStyle = state.shiftLeds.shiftFlashActive ? '#ef4444' : state.liveMode.borderHex;
    ctx.lineWidth = Math.max(1.5, 2 * sc);
    ctx.strokeRect(centerX, bodyTop, centerW, bodyH);

    ctx.fillStyle = '#f8fafc';
    ctx.font = `900 ${Math.round(98 * sc)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.gearLabel, centerX + centerW * 0.5, bodyTop + bodyH * 0.43);

    ctx.fillStyle = '#ccff00';
    ctx.font = `800 ${Math.round(28 * sc)}px monospace`;
    ctx.fillText(`${state.speedKmh} km/h`, centerX + centerW * 0.5, bodyTop + bodyH * 0.8);

    ctx.fillStyle = '#94a3b8';
    ctx.font = `700 ${Math.round(12 * sc)}px monospace`;
    ctx.fillText(`${state.rpm} RPM`, centerX + centerW * 0.5, bodyTop + bodyH * 0.93);

    // Right column: Lap time, Delta, 2x2 Compact Tyre Temps
    const rightX = w - padX - colW;
    drawTelemetryCell(
      ctx,
      rightX,
      bodyTop,
      colW,
      cellH,
      'LAP TIME',
      state.currentLapTimeFormatted,
      '#f8fafc',
      sc,
    );
    const deltaTone =
      state.deltaSeconds === null
        ? '#94a3b8'
        : state.deltaSeconds <= 0
          ? '#22c55e'
          : '#ef4444';
    drawTelemetryCell(
      ctx,
      rightX,
      bodyTop + cellH + 6 * sy,
      colW,
      cellH,
      'DELTA',
      state.deltaFormatted,
      deltaTone,
      sc,
    );

    // Mini 4-corner tyre temp grid
    const miniTop = bodyTop + 2 * (cellH + 6 * sy);
    const mw = (colW - 4 * sx) * 0.5;
    const mh = (cellH - 4 * sy) * 0.5;
    for (let i = 0; i < 4; i++) {
      const c = state.corners[i];
      const cx = rightX + (i % 2) * (mw + 4 * sx);
      const cy = miniTop + Math.floor(i / 2) * (mh + 4 * sy);
      ctx.fillStyle = c.tempColorHex;
      ctx.fillRect(cx, cy, mw, mh);
      ctx.fillStyle = '#06080d';
      ctx.font = `800 ${Math.round(12 * sc)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${c.corner} ${Math.round(c.surfaceTempC)}°`, cx + mw * 0.5, cy + mh * 0.5);
    }
  } else if (state.activePage === 'ers-active-aero') {
    const halfW = (w - 2 * padX - 8 * sx) * 0.5;
    const rowH = (bodyH - 12 * sy) / 3;
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop,
      halfW,
      rowH,
      'MGU-K POWER (CAP)',
      `${state.mgukPowerKw >= 0 ? '+' : ''}${state.mgukPowerKw} / ${state.speedDerateCapKw} kW`,
      state.mgukPowerKw < 0 ? '#22c55e' : '#a855f7',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop,
      halfW,
      rowH,
      `AERO (${state.liveMode.aeroBadge} · ${state.smProgressPct}%)`,
      `FW ${state.flapsDeg.fwFlap3}° | RW ${state.flapsDeg.rwFlap3}°`,
      '#00e5ff',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'LAP DEPLOY BUDGET',
      `${state.lapDeployMj.toFixed(2)} / ${state.lapDeployCapMj.toFixed(1)} MJ`,
      '#ccff00',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'LAP HARVEST BUDGET',
      `${state.lapHarvestMj.toFixed(2)} / ${state.lapHarvestCapMj.toFixed(1)} MJ`,
      '#22c55e',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + 2 * (rowH + 6 * sy),
      halfW,
      rowH,
      'DOWNFORCE / COP',
      `${state.downforceKgf} kgf · ${state.aeroBalanceFrontPct}%F`,
      '#f8fafc',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop + 2 * (rowH + 6 * sy),
      halfW,
      rowH,
      `COOLING GILLS L${state.coolingGillLevel}`,
      `STALL ${state.floorStallPct}% · ${state.dragN} N`,
      state.floorStallPct > 20 ? '#f59e0b' : '#94a3b8',
      sc,
    );
  } else if (state.activePage === 'tyres-thermals') {
    const cardW = (w - 2 * padX - 10 * sx) * 0.5;
    const cardH = (bodyH - 8 * sy) * 0.5;
    for (let i = 0; i < 4; i++) {
      const c = state.corners[i];
      const cx = padX + (i % 2) * (cardW + 10 * sx);
      const cy = bodyTop + Math.floor(i / 2) * (cardH + 8 * sy);
      ctx.fillStyle = '#0d111a';
      ctx.fillRect(cx, cy, cardW, cardH);
      ctx.strokeStyle = c.tempColorHex;
      ctx.lineWidth = Math.max(1.5, 2 * sc);
      ctx.strokeRect(cx, cy, cardW, cardH);

      ctx.fillStyle = c.tempColorHex;
      ctx.font = `800 ${Math.round(14 * sc)}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${c.corner} (${state.pirelliCode})`, cx + 8 * sx, cy + 6 * sy);

      ctx.fillStyle = '#f8fafc';
      ctx.font = `800 ${Math.round(22 * sc)}px sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(`${Math.round(c.surfaceTempC)}°C · ${c.pressurePsi.toFixed(1)} psi`, cx + cardW - 8 * sx, cy + 5 * sy);

      ctx.fillStyle = '#94a3b8';
      ctx.font = `700 ${Math.round(11 * sc)}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(
        `CORE ${Math.round(c.coreTempC)}° | LIFE ${c.remainingLifePct.toFixed(0)}% | BRK ${c.brakeTempC}°`,
        cx + 8 * sx,
        cy + cardH - 6 * sy,
      );
    }
  } else if (state.activePage === 'brakes-diff') {
    const halfW = (w - 2 * padX - 8 * sx) * 0.5;
    const rowH = (bodyH - 12 * sy) / 3;
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop,
      halfW,
      rowH,
      'STATIC BRAKE BIAS',
      `${state.brakeBiasFrontPct.toFixed(1)}% FRONT`,
      '#f8fafc',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop,
      halfW,
      rowH,
      'BBW MIGRATION / EFF',
      `+${state.brakeMigrationPct.toFixed(1)}% -> ${state.effectiveFrontBiasPct.toFixed(1)}%`,
      '#00e5ff',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'DIFF ENTRY / MID',
      `${state.diffEntryLockPct}% / ${state.diffMidCoastLockPct}%`,
      '#ccff00',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'DIFF HISPD / E-BRK',
      `${state.diffHighSpeedPreloadNm} Nm · EB ${state.engineBrakingLevel}`,
      '#a855f7',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + 2 * (rowH + 6 * sy),
      halfW,
      rowH,
      'FRONT ROTORS',
      `${state.corners[0].brakeTempC}° / ${state.corners[1].brakeTempC}°C`,
      '#f59e0b',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop + 2 * (rowH + 6 * sy),
      halfW,
      rowH,
      'REAR BBW ROTORS',
      `${state.corners[2].brakeTempC}° / ${state.corners[3].brakeTempC}°C`,
      '#22c55e',
      sc,
    );
  } else {
    // 'fuel-plank'
    const halfW = (w - 2 * padX - 8 * sx) * 0.5;
    const rowH = (bodyH - 12 * sy) / 3;
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop,
      halfW,
      rowH,
      'SUSTAINABLE FUEL (KG)',
      `${state.fuelKg.toFixed(2)} kg`,
      '#38bdf8',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop,
      halfW,
      rowH,
      'ENERGY FLOW (C5.4.3)',
      `${state.fuelEnergyFlowMjH} / 3000 MJ/h`,
      state.fuelEnergyFlowMjH >= 2995 ? '#ccff00' : '#f8fafc',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'FUEL / LAP & RANGE',
      state.fuelPerLapKg !== null
        ? `${state.fuelPerLapKg.toFixed(2)} kg · ${state.estimatedLapsRemaining ?? '--'} L`
        : `${(state.fuelMassFlowKgS * 1000).toFixed(1)} g/s`,
      '#22c55e',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX + halfW + 8 * sx,
      bodyTop + rowH + 6 * sy,
      halfW,
      rowH,
      'RIDE HEIGHT (F / R)',
      `${state.frontRideHeightMm.toFixed(1)} / ${state.rearRideHeightMm.toFixed(1)} mm`,
      '#f8fafc',
      sc,
    );
    drawTelemetryCell(
      ctx,
      padX,
      bodyTop + 2 * (rowH + 6 * sy),
      w - 2 * padX,
      rowH,
      `10MM PLANK SKIDS (MIN ${state.plank.minLegalMm.toFixed(1)} MM)`,
      `F ${state.plank.frontSplitterMm.toFixed(2)} · M ${state.plank.midFloorMm.toFixed(2)} · R ${state.plank.rearTeaTrayMm.toFixed(2)} mm`,
      state.plank.legal ? '#22c55e' : '#ef4444',
      sc,
    );
  }

  // 5. Bottom Dual Energy Progress Strip: SoC | Harvest (8.5/9.0 MJ) | Deploy (4.0/4.5 MJ)
  const ftrY = h - 32 * sy;
  const barH = 10 * sy;
  const thirdW = (w - 2 * padX - 16 * sx) / 3;

  drawBar(ctx, padX, ftrY + 12 * sy, thirdW, barH, state.socPct / 100, '#ccff00');
  drawBar(ctx, padX + thirdW + 8 * sx, ftrY + 12 * sy, thirdW, barH, state.lapHarvestRatio01, '#22c55e');
  drawBar(ctx, padX + 2 * (thirdW + 8 * sx), ftrY + 12 * sy, thirdW, barH, state.lapDeployRatio01, '#a855f7');

  ctx.fillStyle = '#94a3b8';
  ctx.font = `700 ${Math.round(9.5 * sc)}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`SOC ${state.socPct.toFixed(0)}%`, padX, ftrY);
  ctx.fillText(
    `HRV ${state.lapHarvestMj.toFixed(1)}/${state.lapHarvestCapMj.toFixed(1)}MJ`,
    padX + thirdW + 8 * sx,
    ftrY,
  );
  ctx.fillText(
    `DEP ${state.lapDeployMj.toFixed(1)}/${state.lapDeployCapMj.toFixed(1)}MJ`,
    padX + 2 * (thirdW + 8 * sx),
    ftrY,
  );

  // Thin horizontal divider above footer
  ctx.beginPath();
  ctx.moveTo(padX, ftrY - 4 * sy);
  ctx.lineTo(w - padX, ftrY - 4 * sy);
  ctx.strokeStyle = '#1e2638';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Three.js `mfd_display` (`INT_DISPLAY`) & `led_shift_01..15` Binding Helper
// ---------------------------------------------------------------------------

const DEFAULT_WHEEL_CANVAS_W = 512;
const DEFAULT_WHEEL_CANVAS_H = 312;
const REDRAW_INTERVAL_MS = 1000 / 30;

/**
 * Attaches a live `CanvasTexture` to the LC-26 3D steering wheel's `mfd_display` (`INT_DISPLAY` material)
 * and drives emissive colors on `led_shift_01..15` (`LC26_GLB_NODE_NAMES.shiftLeds`).
 */
export class Lc26WheelMfdRig {
  public readonly foundDisplay: boolean;
  public readonly foundLedCount: number;

  private readonly displayMesh: THREE.Mesh | null = null;
  private readonly originalDisplayMat: THREE.Material | null = null;
  private readonly clonedDisplayMat: THREE.MeshStandardMaterial | null = null;
  private readonly texture: THREE.CanvasTexture | null = null;
  private readonly ctx: CanvasRenderingContext2D | null = null;
  private readonly ledBindings: {
    mesh: THREE.Mesh;
    original: THREE.Material;
    mat: THREE.MeshStandardMaterial;
  }[] = [];
  private lastDrawMs = -Infinity;

  constructor(root: THREE.Object3D) {
    let targetDisplay: THREE.Mesh | null = null;
    const mfdNode = root.getObjectByName(LC26_GLB_NODE_NAMES.mfdDisplay) ?? root;
    mfdNode.traverse((obj) => {
      if (targetDisplay) return;
      const m = obj as THREE.Mesh;
      if (!m.isMesh || Array.isArray(m.material)) return;
      if (
        m.name === LC26_GLB_NODE_NAMES.mfdDisplay ||
        m.material.name === LC26_GLB_NODE_NAMES.specialMaterials.mfdDisplay
      ) {
        targetDisplay = m;
      }
    });

    if (
      targetDisplay &&
      typeof document !== 'undefined' &&
      ((targetDisplay as THREE.Mesh).material as THREE.MeshStandardMaterial)?.isMeshStandardMaterial
    ) {
      const mesh = targetDisplay as THREE.Mesh;
      const srcMat = mesh.material as THREE.MeshStandardMaterial;
      const canvas = document.createElement('canvas');
      canvas.width = DEFAULT_WHEEL_CANVAS_W;
      canvas.height = DEFAULT_WHEEL_CANVAS_H;
      this.ctx = canvas.getContext('2d', { alpha: false });

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      this.texture = tex;

      const cloned = srcMat.clone();
      cloned.color.set(0x05070c);
      cloned.emissive.set(0xffffff);
      cloned.emissiveIntensity = 1.35;
      cloned.emissiveMap = tex;
      cloned.needsUpdate = true;

      this.displayMesh = mesh;
      this.originalDisplayMat = srcMat;
      this.clonedDisplayMat = cloned;
      mesh.material = cloned;
      this.foundDisplay = true;
    } else {
      this.foundDisplay = false;
    }

    for (const ledName of LC26_GLB_NODE_NAMES.shiftLeds) {
      const node = root.getObjectByName(ledName);
      if (!node) continue;
      node.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material)) return;
        const std = m.material as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) return;
        const mat = std.clone();
        mat.emissiveIntensity = 0;
        this.ledBindings.push({ mesh: m, original: std, mat });
        m.material = mat;
      });
    }
    this.foundLedCount = this.ledBindings.length;
  }

  update(state: Lc26MfdViewModel, nowMs: number): void {
    // Update 3D shift LED emissives every frame
    for (let i = 0; i < this.ledBindings.length && i < LC26_SHIFT_LED_COUNT; i++) {
      const hex = state.shiftLeds.colorsHex[i] ?? LC26_LED_COLORS.off;
      const isOff = hex.toLowerCase() === LC26_LED_COLORS.off;
      const binding = this.ledBindings[i];
      if (isOff) {
        binding.mat.emissiveIntensity = 0;
      } else {
        binding.mat.emissive.set(hex);
        binding.mat.emissiveIntensity = 2.4;
      }
    }

    // Throttle 2D CanvasTexture upload to 30 Hz
    if (!this.foundDisplay || !this.ctx || !this.texture) return;
    if (nowMs >= this.lastDrawMs && nowMs - this.lastDrawMs < REDRAW_INTERVAL_MS) return;
    this.lastDrawMs = nowMs;
    renderLc26WheelMfdCanvas(this.ctx, DEFAULT_WHEEL_CANVAS_W, DEFAULT_WHEEL_CANVAS_H, state);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    if (this.displayMesh && this.originalDisplayMat) {
      this.displayMesh.material = this.originalDisplayMat;
    }
    this.clonedDisplayMat?.dispose();
    this.texture?.dispose();
    for (const b of this.ledBindings) {
      b.mesh.material = b.original;
      b.mat.dispose();
    }
    this.ledBindings.length = 0;
  }
}
