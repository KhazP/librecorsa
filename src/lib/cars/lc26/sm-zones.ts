/**
 * 2026 FIA Straight Mode (`SM`) Authorized Track Zones & Generic Straight Detector
 * for "VeloSoft LC-26" (`lc26-f1`).
 *
 * Clean-room derivation aligned with 2026 FIA Formula 1 Sporting & Technical
 * Regulations (Driver Adjustable Bodywork / Straight Mode activation zones):
 * - Unlike legacy overtaking-only DRS (1–3 zones, 1.0 s gap rule), 2026 Straight
 *   Mode is available on every lap to every car inside FIA-designated low-curvature
 *   straights to prevent MGU-K battery depletion while shedding ~40–45% drag.
 * - Zones terminate ahead of heavy braking markers with a lateral-acceleration
 *   and minimum-speed envelope (`minActivationSpeedKmh`, `maxLateralG`).
 * - Includes an analytical curvature + braking-zone straight detector fallback
 *   (`detectGenericStraightModeZones`) for procedural or custom circuits.
 */

import type { ZoneData_DRSZone } from '@/lib/sim/f12026-car/F12026CarConfig';
import type { TrackSamplePoint } from '@/types/f1';
import type { Lc26CircuitSmZones, Lc26SmZoneSegment } from './contract-types';

/** Minimal sample point contract accepted by the generic fallback straight detector */
export type Lc26GenericTrackSample = Pick<TrackSamplePoint, 't' | 'curvature'> & {
  readonly s?: number;
  readonly brakingZone?: number;
  readonly optimalSpeedKmh?: number;
};

export interface Lc26GenericSmDetectorOptions {
  /** Maximum horizontal curvature |kappa| (1/m) treated as straight/gentle kink (default `0.0028` => R >= 357 m) */
  readonly maxCurvatureInvM?: number;
  /** Minimum contiguous straight length (m) to qualify for Straight Mode (default `220` m) */
  readonly minStraightLengthM?: number;
  /** Entry safety buffer after corner exit before SM opens (m, default `35` m) */
  readonly entryBufferM?: number;
  /** Pre-braking safety margin before heavy braking begins (m, default `25` m) */
  readonly exitBrakingMarginM?: number;
  /** Default minimum activation speed (km/h, default `165` km/h) */
  readonly minActivationSpeedKmh?: number;
  /** Default lateral G ceiling inside detected zones (g, default `1.25` g) */
  readonly maxLateralG?: number;
}

/** Common circuit ID aliases mapped to canonical LibreCorsa track IDs */
export const LC26_CIRCUIT_ID_ALIASES: Readonly<Record<string, string>> = {
  red_bull_ring: 'spielberg',
  'red-bull-ring': 'spielberg',
  rbr: 'spielberg',
  austria: 'spielberg',
  singapore: 'marina_bay',
  'marina-bay': 'marina_bay',
  abu_dhabi: 'yas_marina',
  'yas-marina': 'yas_marina',
  spa_francorchamps: 'spa',
  'spa-francorchamps': 'spa',
  belgium: 'spa',
  britain: 'silverstone',
  italy: 'monza',
  japan: 'suzuka',
  china: 'shanghai',
  malaysia: 'sepang',
  kigali: 'rwanda_official',
  rwanda: 'rwanda_official',
};

/**
 * Authorized 2026 Straight Mode zones for all circuits in LibreCorsa.
 * Normalized spline coordinates (`[0..1)`) are calibrated against each circuit's
 * centreline length, turn apexes, and braking zones.
 */
export const LC26_CIRCUIT_SM_ZONES: Readonly<Record<string, Lc26CircuitSmZones>> = {
  // -------------------------------------------------------------------------
  // Core F1 Championship Circuits
  // -------------------------------------------------------------------------
  monza: {
    circuitId: 'monza',
    trackLengthM: 5785.63,
    zones: [
      {
        zoneId: 'monza_sm_1_rettifilo',
        startProgress01: 0.895,
        endProgress01: 0.084,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.15,
      },
      {
        zoneId: 'monza_sm_2_roggia_approach',
        startProgress01: 0.228,
        endProgress01: 0.295,
        minActivationSpeedKmh: 185,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'monza_sm_3_serraglio',
        startProgress01: 0.462,
        endProgress01: 0.605,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'monza_sm_4_back_straight',
        startProgress01: 0.698,
        endProgress01: 0.815,
        minActivationSpeedKmh: 180,
        maxLateralG: 1.15,
      },
    ],
  },

  silverstone: {
    circuitId: 'silverstone',
    trackLengthM: 5865.13,
    zones: [
      {
        zoneId: 'silverstone_sm_1_hamilton_straight',
        startProgress01: 0.958,
        endProgress01: 0.032,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'silverstone_sm_2_wellington_straight',
        startProgress01: 0.198,
        endProgress01: 0.286,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'silverstone_sm_3_copse_to_maggotts',
        startProgress01: 0.426,
        endProgress01: 0.48,
        minActivationSpeedKmh: 195,
        maxLateralG: 1.3,
      },
      {
        zoneId: 'silverstone_sm_4_hangar_straight',
        startProgress01: 0.698,
        endProgress01: 0.808,
        minActivationSpeedKmh: 180,
        maxLateralG: 1.2,
      },
    ],
  },

  spa: {
    circuitId: 'spa',
    trackLengthM: 6993.26,
    zones: [
      {
        zoneId: 'spa_sm_1_pit_straight',
        startProgress01: 0.974,
        endProgress01: 0.016,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'spa_sm_2_eau_rouge_run',
        startProgress01: 0.068,
        endProgress01: 0.122,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'spa_sm_3_kemmel_straight',
        startProgress01: 0.255,
        endProgress01: 0.308,
        minActivationSpeedKmh: 185,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'spa_sm_4_bruxelles_to_pouhon',
        startProgress01: 0.458,
        endProgress01: 0.512,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.3,
      },
      {
        zoneId: 'spa_sm_5_blanchimont_to_bus_stop',
        startProgress01: 0.85,
        endProgress01: 0.924,
        minActivationSpeedKmh: 195,
        maxLateralG: 1.3,
      },
    ],
  },

  suzuka: {
    circuitId: 'suzuka',
    trackLengthM: 5846.38,
    zones: [
      {
        zoneId: 'suzuka_sm_1_main_straight',
        startProgress01: 0.954,
        endProgress01: 0.062,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.15,
      },
      {
        zoneId: 'suzuka_sm_2_degner_to_hairpin',
        startProgress01: 0.392,
        endProgress01: 0.43,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'suzuka_sm_3_spoon_to_130r',
        startProgress01: 0.672,
        endProgress01: 0.805,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'suzuka_sm_4_130r_to_casio',
        startProgress01: 0.844,
        endProgress01: 0.878,
        minActivationSpeedKmh: 205,
        maxLateralG: 1.3,
      },
    ],
  },

  marina_bay: {
    circuitId: 'marina_bay',
    trackLengthM: 5043.45,
    zones: [
      {
        zoneId: 'marina_bay_sm_1_pit_straight',
        startProgress01: 0.962,
        endProgress01: 0.03,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'marina_bay_sm_2_raffles_boulevard',
        startProgress01: 0.178,
        endProgress01: 0.305,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.35,
      },
      {
        zoneId: 'marina_bay_sm_3_st_andrews_road',
        startProgress01: 0.422,
        endProgress01: 0.47,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'marina_bay_sm_4_esplanade_drive',
        startProgress01: 0.586,
        endProgress01: 0.658,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
    ],
  },

  yas_marina: {
    circuitId: 'yas_marina',
    trackLengthM: 5280.06,
    zones: [
      {
        zoneId: 'yas_marina_sm_1_main_straight',
        startProgress01: 0.96,
        endProgress01: 0.028,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'yas_marina_sm_2_north_back_straight',
        startProgress01: 0.268,
        endProgress01: 0.456,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'yas_marina_sm_3_marsa_back_straight',
        startProgress01: 0.514,
        endProgress01: 0.64,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.4,
      },
    ],
  },

  spielberg: {
    circuitId: 'spielberg',
    trackLengthM: 4314.25,
    zones: [
      {
        zoneId: 'spielberg_sm_1_start_finish',
        startProgress01: 0.928,
        endProgress01: 0.048,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'spielberg_sm_2_remus_uphill',
        startProgress01: 0.104,
        endProgress01: 0.256,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.35,
      },
      {
        zoneId: 'spielberg_sm_3_rauch_straight',
        startProgress01: 0.315,
        endProgress01: 0.452,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'spielberg_sm_4_rindt_approach',
        startProgress01: 0.738,
        endProgress01: 0.82,
        minActivationSpeedKmh: 185,
        maxLateralG: 1.3,
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Additional LibreCorsa Grand Prix, Club & Test Circuits
  // -------------------------------------------------------------------------
  rwanda_official: {
    circuitId: 'rwanda_official',
    trackLengthM: 5895.0,
    zones: [
      {
        zoneId: 'rwanda_gp_sm_1_main_straight',
        startProgress01: 0.958,
        endProgress01: 0.054,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'rwanda_gp_sm_2_west_hill_run',
        startProgress01: 0.316,
        endProgress01: 0.452,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'rwanda_gp_sm_3_savanna_run',
        startProgress01: 0.568,
        endProgress01: 0.642,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.25,
      },
    ],
  },

  rwanda_official_short: {
    circuitId: 'rwanda_official_short',
    trackLengthM: 5340.0,
    zones: [
      {
        zoneId: 'rwanda_short_sm_1_main_straight',
        startProgress01: 0.954,
        endProgress01: 0.06,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'rwanda_short_sm_2_west_hill_run',
        startProgress01: 0.266,
        endProgress01: 0.399,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'rwanda_short_sm_3_forest_to_savanna',
        startProgress01: 0.525,
        endProgress01: 0.605,
        minActivationSpeedKmh: 175,
        maxLateralG: 1.3,
      },
    ],
  },

  shanghai: {
    circuitId: 'shanghai',
    trackLengthM: 5435.88,
    zones: [
      {
        zoneId: 'shanghai_sm_1_pit_straight',
        startProgress01: 0.955,
        endProgress01: 0.045,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'shanghai_sm_2_sector2_straight',
        startProgress01: 0.468,
        endProgress01: 0.526,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'shanghai_sm_3_long_back_straight',
        startProgress01: 0.635,
        endProgress01: 0.828,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.2,
      },
    ],
  },

  sepang: {
    circuitId: 'sepang',
    trackLengthM: 5530.77,
    zones: [
      {
        zoneId: 'sepang_sm_1_kuala_lumpur_straight',
        startProgress01: 0.934,
        endProgress01: 0.045,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'sepang_sm_2_t3_to_t4_run',
        startProgress01: 0.18,
        endProgress01: 0.242,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'sepang_sm_3_t9_approach',
        startProgress01: 0.47,
        endProgress01: 0.526,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'sepang_sm_4_penang_back_straight',
        startProgress01: 0.762,
        endProgress01: 0.882,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
    ],
  },

  motegi: {
    circuitId: 'motegi',
    trackLengthM: 4782.65,
    zones: [
      {
        zoneId: 'motegi_sm_1_main_straight',
        startProgress01: 0.918,
        endProgress01: 0.006,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'motegi_sm_2_t2_to_t3_straight',
        startProgress01: 0.072,
        endProgress01: 0.15,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'motegi_sm_3_downhill_back_straight',
        startProgress01: 0.668,
        endProgress01: 0.792,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.2,
      },
    ],
  },

  daytona_oval: {
    circuitId: 'daytona_oval',
    trackLengthM: 4043.73,
    zones: [
      {
        zoneId: 'daytona_oval_sm_1_superstretch',
        startProgress01: 0.385,
        endProgress01: 0.605,
        minActivationSpeedKmh: 185,
        maxLateralG: 1.35,
      },
      {
        zoneId: 'daytona_oval_sm_2_tri_oval_front',
        startProgress01: 0.845,
        endProgress01: 0.14,
        minActivationSpeedKmh: 185,
        maxLateralG: 1.45,
      },
    ],
  },

  daytona_road: {
    circuitId: 'daytona_road',
    trackLengthM: 5778.18,
    zones: [
      {
        zoneId: 'daytona_road_sm_1_infield_west',
        startProgress01: 0.182,
        endProgress01: 0.238,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'daytona_road_sm_2_backstretch_to_bus_stop',
        startProgress01: 0.565,
        endProgress01: 0.642,
        minActivationSpeedKmh: 180,
        maxLateralG: 1.35,
      },
      {
        zoneId: 'daytona_road_sm_3_nascar4_to_t1',
        startProgress01: 0.888,
        endProgress01: 0.036,
        minActivationSpeedKmh: 180,
        maxLateralG: 1.45,
      },
    ],
  },

  chang: {
    circuitId: 'chang',
    trackLengthM: 4571.07,
    zones: [
      {
        zoneId: 'chang_sm_1_start_finish',
        startProgress01: 0.985,
        endProgress01: 0.075,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'chang_sm_2_t1_to_t3_long',
        startProgress01: 0.155,
        endProgress01: 0.292,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'chang_sm_3_t3_to_t4_straight',
        startProgress01: 0.365,
        endProgress01: 0.508,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.25,
      },
    ],
  },

  okayama: {
    circuitId: 'okayama',
    trackLengthM: 3710.41,
    zones: [
      {
        zoneId: 'okayama_sm_1_main_straight',
        startProgress01: 0.912,
        endProgress01: 0.035,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'okayama_sm_2_back_straight',
        startProgress01: 0.382,
        endProgress01: 0.52,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
    ],
  },

  okayama_piper: {
    circuitId: 'okayama_piper',
    trackLengthM: 1966.13,
    zones: [
      {
        zoneId: 'okayama_piper_sm_1_main_straight',
        startProgress01: 0.835,
        endProgress01: 0.065,
        minActivationSpeedKmh: 155,
        maxLateralG: 1.2,
      },
    ],
  },

  okayama_drift: {
    circuitId: 'okayama_drift',
    trackLengthM: 1965.44,
    zones: [
      {
        zoneId: 'okayama_drift_sm_1_main_straight',
        startProgress01: 0.835,
        endProgress01: 0.046,
        minActivationSpeedKmh: 155,
        maxLateralG: 1.2,
      },
    ],
  },

  spielberg_south: {
    circuitId: 'spielberg_south',
    trackLengthM: 2335.8,
    zones: [
      {
        zoneId: 'spielberg_south_sm_1_start_finish',
        startProgress01: 0.88,
        endProgress01: 0.082,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.2,
      },
      {
        zoneId: 'spielberg_south_sm_2_castrol_to_south',
        startProgress01: 0.19,
        endProgress01: 0.285,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.25,
      },
    ],
  },

  spielberg_inner: {
    circuitId: 'spielberg_inner',
    trackLengthM: 931.91,
    zones: [],
  },

  monaco: {
    circuitId: 'monaco',
    trackLengthM: 3309.26,
    zones: [
      {
        zoneId: 'monaco_sm_1_pit_straight',
        startProgress01: 0.905,
        endProgress01: 0.032,
        minActivationSpeedKmh: 155,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'monaco_sm_2_tunnel_to_chicane',
        startProgress01: 0.536,
        endProgress01: 0.594,
        minActivationSpeedKmh: 170,
        maxLateralG: 1.35,
      },
    ],
  },

  dunsfold: {
    circuitId: 'dunsfold',
    trackLengthM: 2879.85,
    zones: [
      {
        zoneId: 'dunsfold_sm_1_start_straight',
        startProgress01: 0.992,
        endProgress01: 0.076,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'dunsfold_sm_2_runway_approach',
        startProgress01: 0.386,
        endProgress01: 0.462,
        minActivationSpeedKmh: 160,
        maxLateralG: 1.25,
      },
      {
        zoneId: 'dunsfold_sm_3_follow_through_run',
        startProgress01: 0.564,
        endProgress01: 0.652,
        minActivationSpeedKmh: 165,
        maxLateralG: 1.3,
      },
    ],
  },
};

/** Normalize any spline progress value into canonical `[0, 1)` */
export function normalizeProgress01(progress01: number): number {
  if (!Number.isFinite(progress01)) return 0;
  const wrapped = progress01 % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/** Normalize a circuit identifier using canonical snake_case + alias lookup */
export function normalizeCircuitId(circuitId: string): string {
  const cleaned = circuitId.trim().toLowerCase();
  return LC26_CIRCUIT_ID_ALIASES[cleaned] ?? cleaned;
}

/** Physical arc length (m) of a Straight Mode zone segment */
export function smSegmentLengthM(
  segment: Pick<Lc26SmZoneSegment, 'startProgress01' | 'endProgress01'>,
  trackLengthM: number,
): number {
  if (!(trackLengthM > 0) || !Number.isFinite(trackLengthM)) return 0;
  const start = normalizeProgress01(segment.startProgress01);
  const end = normalizeProgress01(segment.endProgress01);
  const span = end >= start ? end - start : 1 - start + end;
  return span * trackLengthM;
}

/**
 * O(1) wrap-aware progress check for a Straight Mode spline interval.
 * Supports start/finish line wrap-around when `endProgress01 < startProgress01`.
 */
export function isProgressInSmSegment(
  progress01: number,
  segment: Pick<Lc26SmZoneSegment, 'startProgress01' | 'endProgress01'>,
): boolean {
  if (!Number.isFinite(progress01)) return false;
  const p = normalizeProgress01(progress01);
  const start = normalizeProgress01(segment.startProgress01);
  const end = normalizeProgress01(segment.endProgress01);
  if (start === end) return false;
  if (start < end) {
    return p >= start && p <= end;
  }
  return p >= start || p <= end;
}

/** Lookup curated Straight Mode zones for a known LibreCorsa circuit ID */
export function getCircuitSmZones(circuitId: string): Lc26CircuitSmZones | null {
  if (!circuitId) return null;
  const key = normalizeCircuitId(circuitId);
  return LC26_CIRCUIT_SM_ZONES[key] ?? null;
}

/**
 * Generic curvature + braking-zone Straight Mode detector for unknown, custom,
 * or procedurally generated circuits.
 */
export function detectGenericStraightModeZones(
  circuitId: string,
  trackLengthM: number,
  samples: ReadonlyArray<Lc26GenericTrackSample>,
  options: Lc26GenericSmDetectorOptions = {},
): Lc26CircuitSmZones {
  const safeId = normalizeCircuitId(circuitId || 'custom_circuit');
  const n = samples.length;
  if (n < 8 || !(trackLengthM > 0) || !Number.isFinite(trackLengthM)) {
    return { circuitId: safeId, trackLengthM: Math.max(0, trackLengthM || 0), zones: [] };
  }

  const maxCurvature = options.maxCurvatureInvM ?? 0.0028;
  const minStraightLengthM = options.minStraightLengthM ?? 220;
  const entryBufferM = options.entryBufferM ?? 35;
  const exitBrakingMarginM = options.exitBrakingMarginM ?? 25;
  const minActivationSpeedKmh = options.minActivationSpeedKmh ?? 165;
  const maxLateralG = options.maxLateralG ?? 1.25;

  const isStraight = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const pt = samples[i];
    const k = Math.abs(pt.curvature);
    const heavyBraking = (pt.brakingZone ?? 0) >= 0.45;
    isStraight[i] = Number.isFinite(k) && k <= maxCurvature && !heavyBraking;
  }

  // Bridge isolated single-sample spline discretization kinks
  for (let i = 0; i < n; i++) {
    if (!isStraight[i] && isStraight[(i - 1 + n) % n] && isStraight[(i + 1) % n]) {
      isStraight[i] = true;
    }
  }

  const rawRuns: Array<[startIdx: number, endIdx: number]> = [];
  let inRun = false;
  let runStart = 0;
  for (let i = 0; i < n; i++) {
    if (isStraight[i] && !inRun) {
      inRun = true;
      runStart = i;
    } else if (!isStraight[i] && inRun) {
      inRun = false;
      rawRuns.push([runStart, i - 1]);
    }
  }
  if (inRun) {
    rawRuns.push([runStart, n - 1]);
  }

  // Merge wrap-around straight crossing start/finish (t = 0)
  if (rawRuns.length >= 2 && rawRuns[0][0] === 0 && rawRuns[rawRuns.length - 1][1] === n - 1) {
    const tail = rawRuns.pop()!;
    rawRuns[0] = [tail[0], rawRuns[0][1]];
  }

  const entryDelta01 = entryBufferM / trackLengthM;
  const exitDelta01 = exitBrakingMarginM / trackLengthM;
  const zones: Lc26SmZoneSegment[] = [];

  for (let idx = 0; idx < rawRuns.length; idx++) {
    const [a, b] = rawRuns[idx];
    const tRawStart = normalizeProgress01(samples[a].t);
    const tRawEnd = normalizeProgress01(samples[b].t);
    const rawSpan01 = tRawEnd >= tRawStart ? tRawEnd - tRawStart : 1 - tRawStart + tRawEnd;
    const rawLengthM = rawSpan01 * trackLengthM;

    if (rawLengthM < minStraightLengthM + entryBufferM + exitBrakingMarginM) {
      continue;
    }

    const startProgress01 = Number(normalizeProgress01(tRawStart + entryDelta01).toFixed(4));
    const endProgress01 = Number(normalizeProgress01(tRawEnd - exitDelta01).toFixed(4));

    zones.push({
      zoneId: `${safeId}_sm_auto_${zones.length + 1}`,
      startProgress01,
      endProgress01,
      minActivationSpeedKmh,
      maxLateralG,
    });
  }

  return {
    circuitId: safeId,
    trackLengthM,
    zones,
  };
}

/**
 * Convert `Lc26CircuitSmZones` into legacy `ZoneData_DRSZone[]` format for
 * compatibility with `VehiclePhysics` / HUD zone indicators (`detection` placed
 * `45 m` upstream of `startProgress01`).
 */
export function toLegacyDrsZones(smZones: Lc26CircuitSmZones): ZoneData_DRSZone[] {
  const lead01 = smZones.trackLengthM > 0 ? 45 / smZones.trackLengthM : 0.008;
  return smZones.zones.map((z) => ({
    id: z.zoneId,
    detection: Number(normalizeProgress01(z.startProgress01 - lead01).toFixed(4)),
    start: z.startProgress01,
    end: z.endProgress01,
  }));
}

/**
 * Return the Straight Mode zone segment containing `progress01` (ignoring speed/G
 * gates), or `null` when outside every zone. Uses curated zones when available,
 * or falls back to `detectGenericStraightModeZones` if fallback samples are supplied.
 */
export function findActiveSmZone(
  circuitId: string,
  progress01: number,
  fallbackSamples?: ReadonlyArray<Lc26GenericTrackSample>,
  fallbackTrackLengthM?: number,
): Lc26SmZoneSegment | null {
  const table =
    getCircuitSmZones(circuitId) ??
    (fallbackSamples && fallbackTrackLengthM && fallbackTrackLengthM > 0
      ? detectGenericStraightModeZones(circuitId, fallbackTrackLengthM, fallbackSamples)
      : null);
  if (!table) return null;

  for (let i = 0; i < table.zones.length; i++) {
    const seg = table.zones[i];
    if (isProgressInSmSegment(progress01, seg)) {
      return seg;
    }
  }
  return null;
}

/**
 * Fast runtime query checking whether the car at `(progress01, speedKmh, lateralG)`
 * on `circuitId` is inside an authorized 2026 FIA Straight Mode zone envelope.
 *
 * Returns `true` iff:
 * 1. `progress01` lies inside one of the circuit's Straight Mode spline segments,
 * 2. `speedKmh >= segment.minActivationSpeedKmh`, and
 * 3. `Math.abs(lateralG) <= segment.maxLateralG`.
 */
export function isInStraightModeZone(
  circuitId: string,
  progress01: number,
  speedKmh: number,
  lateralG: number,
  fallbackSamples?: ReadonlyArray<Lc26GenericTrackSample>,
  fallbackTrackLengthM?: number,
): boolean {
  if (!Number.isFinite(progress01) || !Number.isFinite(speedKmh) || !Number.isFinite(lateralG)) {
    return false;
  }
  const seg = findActiveSmZone(circuitId, progress01, fallbackSamples, fallbackTrackLengthM);
  if (!seg) return false;

  return speedKmh >= seg.minActivationSpeedKmh && Math.abs(lateralG) <= seg.maxLateralG;
}
