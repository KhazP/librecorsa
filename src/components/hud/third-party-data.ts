import type { CarTelemetry, RaceStandingEntry, RadarBlip } from "@/types/f1";
import { t as tr } from "@/i18n/runtime";
import { perLanguage } from "./hud-format";

/**
 * Readings the third-party HUD layouts share (styles/*Hud.tsx from other projects): the cars around the player on the
 * road, the slice of the order a short leaderboard shows, the session's best lap, the ideal lap and the fuel's laps.
 * Pure, so scripts/verify-third-party-hud.ts can check them headlessly.
 */

/** A completed lap a layout lists */
export interface LapRecord {
  /** Lap number (1 = the first completed) */
  lap: number;
  ms: number;
  /** Sector times; null where the lap was not timed through that sector */
  sectorsMs: [number | null, number | null, number | null];
  /** The lap counted (not cut) */
  valid: boolean;
}

/** The words the layouts read every frame, built once per language */
const words = perLanguage(() => ({
  you: tr("hud.thirdPartyData.you"),
  headlight: {
    flash: tr("hud.thirdPartyData.headlight.flash"),
    on: tr("hud.thirdPartyData.headlight.on"),
    off: tr("hud.thirdPartyData.headlight.off"),
  },
  surface: {
    dry: tr("hud.thirdPartyData.surface.dry"),
    damp: tr("hud.thirdPartyData.surface.damp"),
    wet: tr("hud.thirdPartyData.surface.wet"),
    flooded: tr("hud.thirdPartyData.surface.flooded"),
  },
}));

/** A car near the player on the road */
export interface RelativeCar {
  entry: RaceStandingEntry;
  /** Estimated time to it on the road (s): + ahead of the player, − behind; 0 for the player */
  gapS: number;
  /** Laps it is ahead of (+) or behind (−) the player in the race: a lapping or lapped car */
  lapsAhead: number;
}

/** A lap time to estimate road gaps with: the player's best, else the last, else a typical lap */
export function referenceLapS(t: Pick<CarTelemetry, "bestLapTimeMs" | "lastLapTimeMs">): number {
  const ms = t.bestLapTimeMs ?? t.lastLapTimeMs;
  return ms && ms > 0 ? ms / 1000 : 95;
}

/** `d` wrapped into (−L/2, L/2]: the shorter way round a lap of length L */
export function wrapLap(d: number, lengthM: number): number {
  if (!(lengthM > 0)) return d;
  let w = d % lengthM;
  if (w > lengthM / 2) w -= lengthM;
  if (w <= -lengthM / 2) w += lengthM;
  return w;
}

/**
 * The cars physically nearest the player, up to `perSide` ahead and behind, ordered from the furthest ahead to the
 * furthest behind with the player between. The gap is the road distance at the reference lap's average speed, so it
 * reads like a relative timing board's. Without track positions (a race state that doesn't carry them) it falls back
 * to the running order's gaps.
 */
export function relativeCars(t: CarTelemetry, lengthM: number, perSide = 3): RelativeCar[] {
  const standings = t.race?.standings;
  if (!standings?.length) return [];
  const me = standings.find((e) => e.isPlayer);
  if (!me) return [];
  const lapS = referenceLapS(t);
  const onRoad = me.trackS !== undefined && lengthM > 0;
  const others = standings
    .filter((e) => !e.isPlayer && !e.retired && !e.finished)
    .map((entry): RelativeCar => {
      if (onRoad && entry.trackS !== undefined) {
        const dS = wrapLap(entry.trackS - me.trackS!, lengthM);
        const raceGap = (entry.raceDistM ?? 0) - (me.raceDistM ?? 0);
        const lapsAhead = entry.raceDistM !== undefined && me.raceDistM !== undefined ? Math.round((raceGap - dS) / lengthM) : 0;
        return { entry, gapS: (dS / lengthM) * lapS, lapsAhead };
      }
      // Running order: the gap to the leader at the same race distance, in seconds
      return { entry, gapS: me.gapToLeaderS - entry.gapToLeaderS, lapsAhead: entry.lap - me.lap };
    });
  const ahead = others.filter((c) => c.gapS > 0).sort((a, b) => a.gapS - b.gapS).slice(0, perSide).reverse();
  const behind = others.filter((c) => c.gapS <= 0).sort((a, b) => b.gapS - a.gapS).slice(0, perSide);
  return [...ahead, { entry: me, gapS: 0, lapsAhead: 0 }, ...behind];
}

/**
 * The rows a leaderboard of at most `rows` lines shows: the whole order when it fits, else the leader and a run of
 * cars around the player (the player kept in view, the window held inside the field)
 */
export function leaderboardWindow<T extends { isPlayer: boolean }>(standings: readonly T[], rows: number): T[] {
  if (standings.length <= rows || rows < 3) return standings.slice(0, Math.max(rows, 0));
  const me = Math.max(0, standings.findIndex((e) => e.isPlayer));
  // The leader, then rows − 1 cars around the player
  const span = rows - 1;
  let start = Math.max(1, me - Math.floor((span - 1) / 2));
  start = Math.min(start, standings.length - span);
  return [standings[0], ...standings.slice(start, start + span)];
}

/** The fastest lap anyone has set this session (the player's best outside a race), null before one */
export function sessionBestLapMs(t: Pick<CarTelemetry, "bestLapTimeMs" | "race">): number | null {
  let best = t.bestLapTimeMs && t.bestLapTimeMs > 0 ? t.bestLapTimeMs : null;
  for (const e of t.race?.standings ?? []) {
    if (e.bestLapMs && e.bestLapMs > 0 && (best === null || e.bestLapMs < best)) best = e.bestLapMs;
  }
  return best;
}

/** The player's best sectors added up, once every sector has a best */
export function idealLapMs(t: Pick<CarTelemetry, "bestSectorTimesMs">): number | null {
  const b = t.bestSectorTimesMs;
  return b.every((s) => s !== null && s > 0) ? b.reduce<number>((sum, s) => sum + (s ?? 0), 0) : null;
}

/** The lap the live delta predicts: the best lap plus the delta, null without either */
export function predictedLapMs(bestLapMs: number | null, deltaS: number | null): number | null {
  return bestLapMs && deltaS !== null && Number.isFinite(deltaS) ? Math.max(0, bestLapMs + deltaS * 1000) : null;
}

/** Laps the fuel on board lasts at a measured use per lap; null until a lap has been measured */
export function fuelLapsLeft(fuelKg: number, perLapKg: number | null): number | null {
  if (perLapKg === null || !(perLapKg > 0.01) || !(fuelKg >= 0)) return null;
  return fuelKg / perLapKg;
}

/**
 * A driver as a short label: the multiplayer name, else the three-letter code. The player is "You" online, where the
 * others go by name, and goes by their own code against the AI, as the field does
 */
export function driverLabel(e: Pick<RaceStandingEntry, "isPlayer" | "name" | "driverCode">, you = words().you): string {
  if (e.isPlayer) return e.name === undefined ? e.driverCode : you;
  return e.name?.trim() || e.driverCode;
}

/** A session clock as h:mm:ss (mm:ss under an hour) */
export function formatClock(totalS: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalS) ? totalS : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${String(m).padStart(2, "0")}:${sec}`;
}

/**
 * The lap a just-completed lap leaves behind, from the frame before it ended (its first two sectors) and the frame
 * after (the lap time): sector 3 is what the lap time leaves over
 */
export function completedLap(
  lap: number,
  lapMs: number,
  prevSectorsMs: readonly [number, number, number],
  valid: boolean,
): LapRecord {
  const s1 = prevSectorsMs[0] > 0 ? prevSectorsMs[0] : null;
  const s2 = prevSectorsMs[1] > 0 ? prevSectorsMs[1] : null;
  const s3 = s1 !== null && s2 !== null && lapMs - s1 - s2 > 0 ? lapMs - s1 - s2 : null;
  return { lap, ms: lapMs, sectorsMs: [s1, s2, s3], valid };
}

/** The player's headlights as a HUD shows them */
export type HeadlightState = "flash" | "on" | "off";

/**
 * The player's headlights for a HUD's weather panel: flashing, on, or switched off by hand; null while they are off
 * and nothing asked for them (a day on automatic), when the panel shows nothing for them
 */
export function headlightState(w: { headlightsOn?: boolean; headlightFlash?: boolean; headlightMode?: string }): HeadlightState | null {
  if (w.headlightFlash) return "flash";
  if (w.headlightsOn) return "on";
  if (w.headlightMode === "off") return "off";
  return null;
}

export const HEADLIGHT_WORD: Record<HeadlightState, string> = {
  get flash() {
    return words().headlight.flash;
  },
  get on() {
    return words().headlight.on;
  },
  get off() {
    return words().headlight.off;
  },
};

export type TrackSurfaceState = "dry" | "damp" | "wet" | "flooded";

/** Track wetness word thresholds shared with WeatherBadge */
export function trackSurfaceState(wetness: number): TrackSurfaceState {
  if (wetness < 0.03) return "dry";
  if (wetness < 0.14) return "damp";
  if (wetness < 1.1) return "wet";
  return "flooded";
}

export const SURFACE_WORD: Record<TrackSurfaceState, string> = {
  get dry() {
    return words().surface.dry;
  },
  get damp() {
    return words().surface.damp;
  },
  get wet() {
    return words().surface.wet;
  },
  get flooded() {
    return words().surface.flooded;
  },
};

/** 24-hour clock HH:MM from time-of-day in hours */
export function dayClock(hours: number): string {
  const m = ((Math.round(hours * 60) % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const RADAR_CAR_W = 2.0;
export const RADAR_CAR_L = 5.2;
export const RADAR_DISTANCE_THRESHOLD_M = 30.0;
export const RADAR_OPACITY_THRESHOLD_M = 8.0;
export const RADAR_VIEW_RANGE_M = 25.0;
const RADAR_FRONT_FADE_ARC_DEG = 90.0;
const RADAR_FRONT_FADE_SPAN_DEG = 10.0;
const RADAR_OVERLAP_LEVEL1_Z = RADAR_CAR_L * 1.2;
const RADAR_OVERLAP_LEVEL2_Z = RADAR_CAR_L * 0.8;
const RADAR_OVERLAP_MAX_X = 8.0;

export interface EvaluatedRadarBlip {
  blip: RadarBlip;
  dist: number;
  opacity: number;
  overlapLevel: 0 | 1 | 2;
  side: -1 | 0 | 1;
}

export interface EvaluatedRadar {
  blips: EvaluatedRadarBlip[];
  leftCar: EvaluatedRadarBlip | null;
  rightCar: EvaluatedRadarBlip | null;
  opacity: number;
}

function closerSideCar(best: EvaluatedRadarBlip | null, candidate: EvaluatedRadarBlip): EvaluatedRadarBlip {
  if (!best) return candidate;
  if (candidate.overlapLevel !== best.overlapLevel) return candidate.overlapLevel > best.overlapLevel ? candidate : best;
  const dx = Math.abs(candidate.blip.x) - Math.abs(best.blip.x);
  if (dx !== 0) return dx < 0 ? candidate : best;
  return candidate.dist < best.dist ? candidate : best;
}

/**
 * Evaluates raw proximity radar blips for longitudinal/radial fade-out, a 90° forward sightline exclusion cone,
 * and two-stage side overlap warnings matching the shared proximity radar thresholds.
 */
export function evaluateRadar(blips: readonly RadarBlip[]): EvaluatedRadar {
  const evaluated: EvaluatedRadarBlip[] = [];
  let leftCar: EvaluatedRadarBlip | null = null;
  let rightCar: EvaluatedRadarBlip | null = null;
  let maxOpacity = 0;

  for (const blip of blips) {
    const dist = Math.hypot(blip.x, blip.z);
    if (dist > RADAR_DISTANCE_THRESHOLD_M) continue;

    const absX = Math.abs(blip.x);
    const absZ = Math.abs(blip.z);
    const effDist = Math.max(absZ, dist * 0.75);
    const alphaZ = Math.max(
      0,
      Math.min(1, 1 - (effDist - RADAR_OPACITY_THRESHOLD_M) / (RADAR_DISTANCE_THRESHOLD_M - RADAR_OPACITY_THRESHOLD_M)),
    );
    const angleDeg = Math.abs((Math.atan2(blip.x, blip.z) * 180) / Math.PI);
    const alphaAngle = Math.max(
      0,
      Math.min(1, (angleDeg - RADAR_FRONT_FADE_ARC_DEG * 0.5 + RADAR_FRONT_FADE_SPAN_DEG * 0.5) / RADAR_FRONT_FADE_SPAN_DEG),
    );
    const opacity = alphaZ * alphaAngle;
    if (opacity <= 0.01) continue;

    const overlapLevel: 0 | 1 | 2 =
      absX < RADAR_OVERLAP_MAX_X && absZ < RADAR_OVERLAP_LEVEL2_Z
        ? 2
        : absX < RADAR_OVERLAP_MAX_X && absZ < RADAR_OVERLAP_LEVEL1_Z
          ? 1
          : 0;

    const side: -1 | 0 | 1 = overlapLevel > 0 ? (blip.x < 0 ? -1 : blip.x > 0 ? 1 : 0) : 0;
    const item: EvaluatedRadarBlip = { blip, dist, opacity, overlapLevel, side };

    evaluated.push(item);
    if (side === -1) leftCar = closerSideCar(leftCar, item);
    if (side === 1) rightCar = closerSideCar(rightCar, item);
    if (opacity > maxOpacity) maxOpacity = opacity;
  }

  return { blips: evaluated, leftCar, rightCar, opacity: maxOpacity };
}

/** SVG path for a side proximity warning arc around the player car */
export function radarSideArcPath(side: -1 | 1, target: EvaluatedRadarBlip): string {
  const absX = Math.abs(target.blip.x);
  const r = Math.max(3.0, Math.min(8.2, absX));
  const baseAngle = side === 1 ? 0 : Math.PI;
  const bearingShift = Math.atan2(target.blip.z, Math.max(2.5, absX)) * 0.45;
  const centerAngle = baseAngle + side * bearingShift;
  const halfSpan = (35 * Math.PI) / 180;
  const a0 = centerAngle - halfSpan;
  const a1 = centerAngle + halfSpan;
  const p = (a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(-Math.sin(a) * r).toFixed(2)}`;
  return `M ${p(a0)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 0 ${p(a1)}`;
}
