import { LAP_SAMPLE_STRIDE, type LapRecording, type LapSample } from "./lap-types";

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
import type { TurnMetadata } from "@/types/f1";

export interface AnalysisPoint {
  s: number;
  progress: number;
  deltaS: number;
  refTimeS: number;
  cmpTimeS: number;
  refSpeedKmh: number;
  cmpSpeedKmh: number;
  refThrottle: number;
  cmpThrottle: number;
  refBrake: number;
  cmpBrake: number;
  refSteer: number;
  cmpSteer: number;
  refGear: number;
  cmpGear: number;
  refLongG: number;
  cmpLongG: number;
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

export interface LapInsight {
  id: string;
  tone: "gain" | "loss" | "info";
  title: string;
  detail: string;
  s?: number;
}

export interface LapAnalysisResult {
  refLabel: string;
  cmpLabel: string;
  refLapMs: number;
  cmpLapMs: number;
  totalDeltaMs: number;
  trackLengthM: number;
  points: AnalysisPoint[];
  sectors: SectorComparison[];
  insights: LapInsight[];
}

const GRID_POINTS = 220;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Sample a sorted array of LapSamples at distance `s` (m) */
function sampleAtDistance(samples: readonly LapSample[], s: number, trackLen: number): LapSample {
  if (samples.length === 0) {
    return {
      t: 0, s: 0, x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1,
      speedKmh: 0, throttle: 0, brake: 0, steer: 0, gear: 1,
    };
  }
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
  const clampedLen = Math.max(1, trackLen);
  return {
    t: lerp(a.t, b.t, f),
    s: Math.min(clampedLen, Math.max(0, s)),
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    z: lerp(a.z, b.z, f),
    qx: a.qx,
    qy: a.qy,
    qz: a.qz,
    qw: a.qw,
    speedKmh: lerp(a.speedKmh, b.speedKmh, f),
    throttle: lerp(a.throttle, b.throttle, f),
    brake: lerp(a.brake, b.brake, f),
    steer: lerp(a.steer, b.steer, f),
    gear: f < 0.5 ? a.gear : b.gear,
  };
}

/**
 * Compares two recorded laps (`ref` = baseline/personal best, `cmp` = target lap)
 * on a uniform distance grid and extracts sector deltas and actionable insights.
 */
export function analyzeLaps(
  ref: LapRecording,
  cmp: LapRecording,
  turns: readonly TurnMetadata[] = [],
  options?: { refLabel?: string; cmpLabel?: string },
): LapAnalysisResult {
  const refSamples = decodeSamples(ref);
  const cmpSamples = decodeSamples(cmp);
  const trackLengthM = Math.max(
    ref.trackLengthM || 0,
    cmp.trackLengthM || 0,
    refSamples[refSamples.length - 1]?.s ?? 1000,
  );

  const points: AnalysisPoint[] = [];
  for (let i = 0; i < GRID_POINTS; i++) {
    const progress = i / (GRID_POINTS - 1);
    const s = progress * trackLengthM;
    const r = sampleAtDistance(refSamples, s, trackLengthM);
    const c = sampleAtDistance(cmpSamples, s, trackLengthM);
    points.push({
      s,
      progress,
      deltaS: c.t - r.t,
      refTimeS: r.t,
      cmpTimeS: c.t,
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
      refLongG: 0,
      cmpLongG: 0,
      refX: r.x,
      refZ: r.z,
      cmpX: c.x,
      cmpZ: c.z,
    });
  }

  // Derive longitudinal G from speed vs time
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const dtRef = Math.max(0.02, cur.refTimeS - prev.refTimeS);
    const dtCmp = Math.max(0.02, cur.cmpTimeS - prev.cmpTimeS);
    cur.refLongG = ((cur.refSpeedKmh - prev.refSpeedKmh) / 3.6) / (dtRef * 9.81);
    cur.cmpLongG = ((cur.cmpSpeedKmh - prev.cmpSpeedKmh) / 3.6) / (dtCmp * 9.81);
  }
  if (points.length > 1) {
    points[0].refLongG = points[1].refLongG;
    points[0].cmpLongG = points[1].cmpLongG;
  }

  // Sector comparison
  const sectors: SectorComparison[] = ([0, 1, 2] as const).map((idx) => {
    const refMs = ref.sectorTimesMs?.[idx] ?? 0;
    const cmpMs = cmp.sectorTimesMs?.[idx] ?? 0;
    return {
      sector: (idx + 1) as 1 | 2 | 3,
      refMs,
      cmpMs,
      deltaMs: cmpMs - refMs,
    };
  });

  const insights = buildInsights(points, sectors, turns, trackLengthM);

  return {
    refLabel: options?.refLabel ?? `${ref.driverCode || "REF"} (${(ref.lapTimeMs / 1000).toFixed(3)}s)`,
    cmpLabel: options?.cmpLabel ?? `${cmp.driverCode || "LAP"} (${(cmp.lapTimeMs / 1000).toFixed(3)}s)`,
    refLapMs: ref.lapTimeMs,
    cmpLapMs: cmp.lapTimeMs,
    totalDeltaMs: cmp.lapTimeMs - ref.lapTimeMs,
    trackLengthM,
    points,
    sectors,
    insights,
  };
}

function buildInsights(
  points: readonly AnalysisPoint[],
  sectors: readonly SectorComparison[],
  turns: readonly TurnMetadata[],
  trackLengthM: number,
): LapInsight[] {
  const out: LapInsight[] = [];

  // 1. Largest sector gain/loss
  const validSectors = sectors.filter((s) => s.refMs > 0 && s.cmpMs > 0);
  if (validSectors.length > 0) {
    const worst = [...validSectors].sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))[0];
    if (Math.abs(worst.deltaMs) >= 40) {
      const sec = Math.abs(worst.deltaMs) / 1000;
      const lost = worst.deltaMs > 0;
      out.push({
        id: `sector-${worst.sector}`,
        tone: lost ? "loss" : "gain",
        title: `Sector ${worst.sector} ${lost ? "time loss" : "time gain"}`,
        detail: `You ${lost ? "lost" : "gained"} ${sec.toFixed(2)} s in Sector ${worst.sector}.`,
      });
    }
  }

  // 2. Corner-by-corner braking & minimum speed insights
  for (const turn of turns) {
    const winStart = Math.max(0, turn.sApprox - 140);
    const winEnd = Math.min(trackLengthM, turn.sApprox + 60);
    const windowPts = points.filter((p) => p.s >= winStart && p.s <= winEnd);
    if (windowPts.length < 4) continue;

    const refMin = windowPts.reduce((m, p) => (p.refSpeedKmh < m.refSpeedKmh ? p : m), windowPts[0]);
    const cmpMin = windowPts.reduce((m, p) => (p.cmpSpeedKmh < m.cmpSpeedKmh ? p : m), windowPts[0]);
    const minSpeedDiff = cmpMin.cmpSpeedKmh - refMin.refSpeedKmh;

    if (Math.abs(minSpeedDiff) >= 5) {
      const faster = minSpeedDiff > 0;
      out.push({
        id: `apex-${turn.number}`,
        tone: faster ? "gain" : "loss",
        title: `Turn ${turn.number}${turn.name ? ` (${turn.name})` : ""} apex speed`,
        detail: `You carried ${Math.abs(Math.round(minSpeedDiff))} km/h ${faster ? "more" : "less"} minimum speed through Turn ${turn.number}.`,
        s: turn.sApprox,
      });
    }

    const refBrakePt = windowPts.find((p) => p.refBrake >= 0.25);
    const cmpBrakePt = windowPts.find((p) => p.cmpBrake >= 0.25);
    if (refBrakePt && cmpBrakePt) {
      const brakeDiffM = cmpBrakePt.s - refBrakePt.s;
      if (Math.abs(brakeDiffM) >= 6) {
        const earlier = brakeDiffM < 0;
        out.push({
          id: `brake-${turn.number}`,
          tone: earlier ? "info" : "gain",
          title: `Turn ${turn.number} braking point`,
          detail: `Your braking point was ~${Math.round(Math.abs(brakeDiffM))} m ${earlier ? "earlier" : "later"} into Turn ${turn.number}.`,
          s: cmpBrakePt.s,
        });
      }
    }

    if (out.length >= 5) break;
  }

  return out.slice(0, 5);
}
