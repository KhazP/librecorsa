/**
 * Two laps of one circuit side by side (the lap board's Analysis view): both resampled onto one distance grid, with the
 * time gap along the lap, the sector splits and the corners where the most time went. Free of React and the DOM.
 */
import type { TurnMetadata } from "@/types/f1";
import { LAP_SAMPLE_STRIDE, type LapRecording, type LapSample } from "./lap-types";

/** Points on the distance grid both laps are resampled onto */
const GRID_POINTS = 220;
/** A sector gap worth a note (ms) */
const SECTOR_NOTE_MS = 40;
/** An apex speed gap worth a note (km/h) */
const APEX_NOTE_KMH = 5;
/** A braking point gap worth a note (m) */
const BRAKE_NOTE_M = 6;
/** Brake pressure that counts as the braking point */
const BRAKE_ON = 0.25;
/** At most this many notes */
const MAX_INSIGHTS = 5;

/** Both laps at one distance along the circuit */
export interface AnalysisPoint {
  /** Distance from the line (m), and as a share of the lap */
  s: number;
  progress: number;
  /** The compared lap's time minus the reference's at this distance (s): above zero, the compared lap is behind */
  deltaS: number;
  refSpeedKmh: number;
  cmpSpeedKmh: number;
  /** Pedals 0 to 1, steering -1 to 1 */
  refThrottle: number;
  cmpThrottle: number;
  refBrake: number;
  cmpBrake: number;
  refSteer: number;
  cmpSteer: number;
  refGear: number;
  cmpGear: number;
  /** Where each car was (world x / z), for the driving line */
  refX: number;
  refZ: number;
  cmpX: number;
  cmpZ: number;
}

export interface SectorComparison {
  sector: 1 | 2 | 3;
  refMs: number;
  cmpMs: number;
  deltaMs: number;
}

/** A note on where the compared lap gained or lost against the reference (the view words it) */
export type LapInsight =
  | { kind: "sector"; sector: 1 | 2 | 3; deltaMs: number }
  /** diffKmh above zero: the compared lap carried more speed through the corner */
  | { kind: "apexSpeed"; turn: TurnMetadata; diffKmh: number }
  /** diffM above zero: the compared lap braked later */
  | { kind: "brakePoint"; turn: TurnMetadata; diffM: number };

export interface LapAnalysisResult {
  refLapMs: number;
  cmpLapMs: number;
  totalDeltaMs: number;
  trackLengthM: number;
  points: AnalysisPoint[];
  sectors: SectorComparison[];
  /** Where sectors 1 and 2 end on the reference lap (m); empty when it has no sector times */
  sectorEndsM: number[];
  insights: LapInsight[];
}

/** A lap's samples in distance order, the stretch before the line moved to the start (or the end) of the lap */
function decodeSamples(rec: LapRecording): LapSample[] {
  const raw = rec.data;
  const out: LapSample[] = [];
  for (let i = 0; i + LAP_SAMPLE_STRIDE <= raw.length; i += LAP_SAMPLE_STRIDE) {
    out.push({
      t: raw[i],
      s: raw[i + 1],
      x: raw[i + 2],
      y: raw[i + 3],
      z: raw[i + 4],
      qx: raw[i + 5],
      qy: raw[i + 6],
      qz: raw[i + 7],
      qw: raw[i + 8],
      speedKmh: raw[i + 9],
      throttle: raw[i + 10],
      brake: raw[i + 11],
      steer: raw[i + 12],
      gear: raw[i + 13],
    });
  }
  if (out.length > 1) {
    const trackLen = rec.trackLengthM && rec.trackLengthM > 10 ? rec.trackLengthM : Math.max(...out.map((p) => p.s), 1);
    const n = out.length;
    // The first samples can still read the end of the last lap's distance, and the last ones the start of the next
    for (let i = 0; i < n; i++) {
      let s = out[i].s;
      if (i < n * 0.25 && s > trackLen * 0.75) s -= trackLen;
      else if (i > n * 0.75 && s < trackLen * 0.25) s += trackLen;
      out[i].s = Math.max(0, Math.min(trackLen, s));
    }
    out.sort((a, b) => a.s - b.s);
  }
  return out;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

/** A lap's state at distance `s` (m), between the samples either side */
function sampleAtDistance(samples: readonly LapSample[], s: number): Pick<LapSample, "t" | "x" | "z" | "speedKmh" | "throttle" | "brake" | "steer" | "gear"> {
  if (samples.length === 0) return { t: 0, x: 0, z: 0, speedKmh: 0, throttle: 0, brake: 0, steer: 0, gear: 1 };
  if (samples.length === 1 || s <= samples[0].s) return samples[0];
  const last = samples[samples.length - 1];
  if (s >= last.s) return last;
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.s - a.s;
  const f = span > 1e-4 ? Math.max(0, Math.min(1, (s - a.s) / span)) : 0;
  return {
    t: lerp(a.t, b.t, f),
    x: lerp(a.x, b.x, f),
    z: lerp(a.z, b.z, f),
    speedKmh: lerp(a.speedKmh, b.speedKmh, f),
    throttle: lerp(a.throttle, b.throttle, f),
    brake: lerp(a.brake, b.brake, f),
    steer: lerp(a.steer, b.steer, f),
    gear: f < 0.5 ? a.gear : b.gear,
  };
}

/**
 * Compares `cmp` with `ref` (usually the personal best) on one distance grid. `turns`, the circuit's corners, add notes
 * on apex speed and braking points.
 */
export function analyzeLaps(ref: LapRecording, cmp: LapRecording, turns: readonly TurnMetadata[] = []): LapAnalysisResult {
  const refSamples = decodeSamples(ref);
  const cmpSamples = decodeSamples(cmp);
  const trackLengthM = Math.max(ref.trackLengthM || 0, cmp.trackLengthM || 0, refSamples[refSamples.length - 1]?.s ?? 1000);

  const points: AnalysisPoint[] = [];
  const refTimes: number[] = [];
  for (let i = 0; i < GRID_POINTS; i++) {
    const progress = i / (GRID_POINTS - 1);
    const s = progress * trackLengthM;
    const r = sampleAtDistance(refSamples, s);
    const c = sampleAtDistance(cmpSamples, s);
    refTimes.push(r.t);
    points.push({
      s,
      progress,
      deltaS: c.t - r.t,
      refSpeedKmh: r.speedKmh,
      cmpSpeedKmh: c.speedKmh,
      refThrottle: r.throttle,
      cmpThrottle: c.throttle,
      refBrake: r.brake,
      cmpBrake: c.brake,
      refSteer: r.steer,
      cmpSteer: c.steer,
      refGear: r.gear,
      cmpGear: c.gear,
      refX: r.x,
      refZ: r.z,
      cmpX: c.x,
      cmpZ: c.z,
    });
  }

  const sectors: SectorComparison[] = ([0, 1, 2] as const).map((idx) => {
    const refMs = ref.sectorTimesMs?.[idx] ?? 0;
    const cmpMs = cmp.sectorTimesMs?.[idx] ?? 0;
    return { sector: (idx + 1) as 1 | 2 | 3, refMs, cmpMs, deltaMs: cmpMs - refMs };
  });

  // The sector lines sit where the reference lap's clock passed each split
  const sectorEndsM: number[] = [];
  const [s1, s2] = ref.sectorTimesMs ?? [0, 0, 0];
  if (s1 > 0 && s2 > 0) {
    for (const splitS of [s1 / 1000, (s1 + s2) / 1000]) {
      const i = refTimes.findIndex((t) => t >= splitS);
      if (i > 0) sectorEndsM.push(points[i].s);
    }
  }

  return {
    refLapMs: ref.lapTimeMs,
    cmpLapMs: cmp.lapTimeMs,
    totalDeltaMs: cmp.lapTimeMs - ref.lapTimeMs,
    trackLengthM,
    points,
    sectors,
    sectorEndsM,
    insights: buildInsights(points, sectors, turns, trackLengthM),
  };
}

function buildInsights(
  points: readonly AnalysisPoint[],
  sectors: readonly SectorComparison[],
  turns: readonly TurnMetadata[],
  trackLengthM: number,
): LapInsight[] {
  const out: LapInsight[] = [];

  // The sector with the biggest gap
  const timed = sectors.filter((s) => s.refMs > 0 && s.cmpMs > 0);
  if (timed.length > 0) {
    const widest = [...timed].sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))[0];
    if (Math.abs(widest.deltaMs) >= SECTOR_NOTE_MS) out.push({ kind: "sector", sector: widest.sector, deltaMs: widest.deltaMs });
  }

  // Corner by corner: the slowest point through it, and where the brakes went on
  for (const turn of turns) {
    if (out.length >= MAX_INSIGHTS) break;
    const from = Math.max(0, turn.sApprox - 140);
    const to = Math.min(trackLengthM, turn.sApprox + 60);
    const near = points.filter((p) => p.s >= from && p.s <= to);
    if (near.length < 4) continue;

    const refMin = Math.min(...near.map((p) => p.refSpeedKmh));
    const cmpMin = Math.min(...near.map((p) => p.cmpSpeedKmh));
    const diffKmh = cmpMin - refMin;
    if (Math.abs(diffKmh) >= APEX_NOTE_KMH) out.push({ kind: "apexSpeed", turn, diffKmh });

    const refBrake = near.find((p) => p.refBrake >= BRAKE_ON);
    const cmpBrake = near.find((p) => p.cmpBrake >= BRAKE_ON);
    if (refBrake && cmpBrake && Math.abs(cmpBrake.s - refBrake.s) >= BRAKE_NOTE_M) {
      out.push({ kind: "brakePoint", turn, diffM: cmpBrake.s - refBrake.s });
    }
  }

  return out.slice(0, MAX_INSIGHTS);
}
