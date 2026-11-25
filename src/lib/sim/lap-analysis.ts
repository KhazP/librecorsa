import { isCurrentLapPhysics, LAP_SAMPLE_STRIDE, type LapRecording, type LapSample } from "./lap-types";
import type { TurnMetadata, VehicleModelId } from "@/types/f1";

export interface SessionLapEntry {
  recording: LapRecording;
  /** False when the lap broke track limits or used autopilot */
  valid: boolean;
  /** Session lap number when known */
  lapNumber?: number;
}

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

export type LapInsight =
  | {
      id: string;
      kind: "sector";
      tone: "gain" | "loss";
      sector: 1 | 2 | 3;
      /** Signed delta in seconds: positive = slower, negative = faster */
      deltaS: number;
    }
  | {
      id: string;
      kind: "apex";
      tone: "gain" | "loss";
      turnNumber: number;
      turnName?: string;
      /** Signed minimum-speed difference in km/h: positive = faster, negative = slower */
      speedDiffKmh: number;
      s: number;
    }
  | {
      id: string;
      kind: "brake";
      tone: "gain" | "info";
      turnNumber: number;
      turnName?: string;
      /** Signed braking-point shift in metres: negative = earlier, positive = later */
      diffM: number;
      s: number;
    };

export interface LapAnalysisResult {
  refLapMs: number;
  cmpLapMs: number;
  totalDeltaMs: number;
  trackLengthM: number;
  /** Distance along the lap (m) where Sector 1 ends and Sector 2 ends */
  sectorSplitsM: [number, number];
  /** Normalized lap progress (0..1) of the two sector split lines */
  sectorFractions: [number, number];
  points: AnalysisPoint[];
  sectors: SectorComparison[];
  insights: LapInsight[];
}

export interface LapChoice {
  id: string;
  kind: "best" | "latest" | "session";
  recording: LapRecording;
  valid: boolean;
  lapNumber?: number;
}

const GRID_POINTS = 220;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Extracts the circuit's real Sector 1 -> 2 and Sector 2 -> 3 split distances (m) from track samples,
 * clamped to the timed length (for point-to-point courses). Returns null when sectors are absent or invalid.
 */
export function sectorSplitsFromSamples(
  samples: readonly { s: number; sector: 1 | 2 | 3 }[],
  timedLengthM: number,
): [number, number] | null {
  if (samples.length === 0 || !Number.isFinite(timedLengthM) || timedLengthM <= 0) return null;
  let s1: number | null = null;
  let s2: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.s > timedLengthM) break;
    if (s1 === null && sample.sector >= 2 && sample.s > 0) s1 = sample.s;
    if (s2 === null && sample.sector >= 3 && sample.s > 0) {
      s2 = sample.s;
      break;
    }
  }
  if (s1 !== null && s2 !== null && s1 > 0 && s2 > s1 && s2 < timedLengthM) {
    return [s1, s2];
  }
  return null;
}

/** Resolves valid sector split distances and normalized fractions, falling back to equal thirds when unknown */
export function resolveSectorSplits(
  trackLengthM: number,
  splits?: readonly [number, number] | null,
): { splitsM: [number, number]; fractions: [number, number] } {
  const len = Number.isFinite(trackLengthM) && trackLengthM > 0 ? trackLengthM : 1;
  if (
    splits &&
    Number.isFinite(splits[0]) &&
    Number.isFinite(splits[1]) &&
    splits[0] > 0 &&
    splits[1] > splits[0] &&
    splits[1] < len
  ) {
    return {
      splitsM: [splits[0], splits[1]],
      fractions: [splits[0] / len, splits[1] / len],
    };
  }
  return {
    splitsM: [len / 3, (len * 2) / 3],
    fractions: [1 / 3, 2 / 3],
  };
}

/**
 * Picks this car's fastest saved personal best on `trackId` — never another car's lap.
 * Prefers the current physics revision before falling back to an older revision of the same car.
 */
export function selectCarBestLap(
  laps: readonly LapRecording[],
  trackId: string,
  vehicle: VehicleModelId,
): LapRecording | null {
  let currentBest: LapRecording | null = null;
  let legacyBest: LapRecording | null = null;
  for (let i = 0; i < laps.length; i++) {
    const lap = laps[i];
    if (lap.trackId !== trackId || lap.vehicle !== vehicle || lap.data.length < LAP_SAMPLE_STRIDE) continue;
    const isCurrent =
      lap.conditions !== undefined && isCurrentLapPhysics(vehicle, lap.conditions.physicsVersion, trackId);
    if (isCurrent) {
      if (!currentBest || lap.lapTimeMs < currentBest.lapTimeMs) currentBest = lap;
    } else if (!legacyBest || lap.lapTimeMs < legacyBest.lapTimeMs) {
      legacyBest = lap;
    }
  }
  return currentBest ?? legacyBest;
}

function lapKeyOf(r: LapRecording): string {
  return `${r.trackId}|${r.vehicle}|${r.recordedAt}|${Math.round(r.lapTimeMs)}`;
}

/**
 * Deduplicates the all-time best, persisted latest lap, and current-session laps into a picker list,
 * choosing the fastest valid lap as default reference and the most recent lap as default comparison.
 */
export function buildLapChoices(params: {
  sessionLaps?: readonly SessionLapEntry[];
  allTimeBest?: LapRecording | null;
  latestLap?: LapRecording | null;
}): {
  choices: LapChoice[];
  defaultRefId: string | null;
  defaultCmpId: string | null;
} {
  const sessionLaps = (params.sessionLaps ?? []).filter((e) => e.recording.data.length >= LAP_SAMPLE_STRIDE);
  const allTimeBest =
    params.allTimeBest && params.allTimeBest.data.length >= LAP_SAMPLE_STRIDE ? params.allTimeBest : null;
  const latestLap = params.latestLap && params.latestLap.data.length >= LAP_SAMPLE_STRIDE ? params.latestLap : null;

  const byKey = new Map<string, LapChoice>();
  const choices: LapChoice[] = [];

  const add = (choice: LapChoice): LapChoice => {
    const key = lapKeyOf(choice.recording);
    const existing = byKey.get(key);
    if (existing) {
      if (choice.lapNumber !== undefined && existing.lapNumber === undefined) {
        existing.lapNumber = choice.lapNumber;
      }
      return existing;
    }
    byKey.set(key, choice);
    choices.push(choice);
    return choice;
  };

  // Fastest valid reference candidate: all-time best or fastest valid session lap (never an invalid lap)
  const validSessionBest = sessionLaps
    .filter((e) => e.valid)
    .reduce<SessionLapEntry | null>((best, e) => (!best || e.recording.lapTimeMs < best.recording.lapTimeMs ? e : best), null);
  const refBest =
    allTimeBest && (!validSessionBest || allTimeBest.lapTimeMs <= validSessionBest.recording.lapTimeMs)
      ? { recording: allTimeBest, valid: true, lapNumber: undefined }
      : validSessionBest;

  let defaultRef: LapChoice | null = null;
  if (refBest) {
    defaultRef = add({
      id: "best",
      kind: "best",
      recording: refBest.recording,
      valid: true,
      lapNumber: refBest.lapNumber,
    });
  }

  let defaultCmp: LapChoice | null = null;
  for (let i = 0; i < sessionLaps.length; i++) {
    const entry = sessionLaps[i];
    const added = add({
      id: `session-${i}`,
      kind: "session",
      recording: entry.recording,
      valid: entry.valid,
      lapNumber: entry.lapNumber,
    });
    if (i === 0) defaultCmp = added;
  }

  if (latestLap) {
    const addedLatest = add({
      id: "latest",
      kind: "latest",
      recording: latestLap,
      valid: true,
    });
    if (!defaultCmp) defaultCmp = addedLatest;
  }

  if (!defaultRef) {
    // Only invalid session laps exist so far: use the fastest available session lap as baseline
    const fastestAny = choices.reduce<LapChoice | null>(
      (best, c) => (!best || c.recording.lapTimeMs < best.recording.lapTimeMs ? c : best),
      null,
    );
    defaultRef = fastestAny;
  }
  if (!defaultCmp) defaultCmp = defaultRef;

  return {
    choices,
    defaultRefId: defaultRef?.id ?? null,
    defaultCmpId: defaultCmp?.id ?? null,
  };
}

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
    const trackLen =
      rec.trackLengthM && rec.trackLengthM > 10 ? rec.trackLengthM : Math.max(...out.map((p) => p.s), 1);
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
 * Compares two recorded laps (`ref` = baseline/reference, `cmp` = target lap)
 * on a uniform distance grid and extracts sector deltas and structured corner insights.
 */
export function analyzeLaps(
  ref: LapRecording,
  cmp: LapRecording,
  turns: readonly TurnMetadata[] = [],
  options?: { sectorSplitsM?: readonly [number, number] | null },
): LapAnalysisResult {
  const refSamples = decodeSamples(ref);
  const cmpSamples = decodeSamples(cmp);
  const trackLengthM = Math.max(
    ref.trackLengthM || 0,
    cmp.trackLengthM || 0,
    refSamples[refSamples.length - 1]?.s ?? 0,
    cmpSamples[cmpSamples.length - 1]?.s ?? 0,
    1000,
  );
  const { splitsM: sectorSplitsM, fractions: sectorFractions } = resolveSectorSplits(
    trackLengthM,
    options?.sectorSplitsM,
  );

  const points: AnalysisPoint[] = [];
  if (refSamples.length > 0 && cmpSamples.length > 0) {
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
      cur.refLongG = (cur.refSpeedKmh - prev.refSpeedKmh) / 3.6 / (dtRef * 9.81);
      cur.cmpLongG = (cur.cmpSpeedKmh - prev.cmpSpeedKmh) / 3.6 / (dtCmp * 9.81);
    }
    if (points.length > 1) {
      points[0].refLongG = points[1].refLongG;
      points[0].cmpLongG = points[1].cmpLongG;
    }
  }

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
    refLapMs: ref.lapTimeMs,
    cmpLapMs: cmp.lapTimeMs,
    totalDeltaMs: cmp.lapTimeMs - ref.lapTimeMs,
    trackLengthM,
    sectorSplitsM,
    sectorFractions,
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

  // 1. Largest sector gain or loss
  const validSectors = sectors.filter((s) => s.refMs > 0 && s.cmpMs > 0);
  if (validSectors.length > 0) {
    const biggest = [...validSectors].sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))[0];
    if (Math.abs(biggest.deltaMs) >= 40) {
      const lost = biggest.deltaMs > 0;
      out.push({
        id: `sector-${biggest.sector}`,
        kind: "sector",
        tone: lost ? "loss" : "gain",
        sector: biggest.sector,
        deltaS: biggest.deltaMs / 1000,
      });
    }
  }

  // 2. Corner-by-corner minimum speed & braking point insights
  for (const turn of turns) {
    const winStart = Math.max(0, turn.sApprox - 140);
    const winEnd = Math.min(trackLengthM, turn.sApprox + 60);
    const windowPts = points.filter((p) => p.s >= winStart && p.s <= winEnd);
    if (windowPts.length < 4) continue;

    const refMin = windowPts.reduce((m, p) => (p.refSpeedKmh < m.refSpeedKmh ? p : m), windowPts[0]);
    const cmpMin = windowPts.reduce((m, p) => (p.cmpSpeedKmh < m.cmpSpeedKmh ? p : m), windowPts[0]);
    const minSpeedDiff = cmpMin.cmpSpeedKmh - refMin.refSpeedKmh;

    if (Math.abs(minSpeedDiff) >= 5) {
      out.push({
        id: `apex-${turn.number}`,
        kind: "apex",
        tone: minSpeedDiff > 0 ? "gain" : "loss",
        turnNumber: turn.number,
        turnName: turn.name || undefined,
        speedDiffKmh: minSpeedDiff,
        s: turn.sApprox,
      });
    }

    // Braking onset approaching the corner (before apex, never past it into the next corner)
    const entryPts = windowPts.filter((p) => p.s <= turn.sApprox + 10);
    const refBrakePt = entryPts.find((p) => p.refBrake >= 0.25);
    const cmpBrakePt = entryPts.find((p) => p.cmpBrake >= 0.25);
    if (refBrakePt && cmpBrakePt) {
      const brakeDiffM = cmpBrakePt.s - refBrakePt.s;
      if (Math.abs(brakeDiffM) >= 6) {
        out.push({
          id: `brake-${turn.number}`,
          kind: "brake",
          tone: brakeDiffM < 0 ? "info" : "gain",
          turnNumber: turn.number,
          turnName: turn.name || undefined,
          diffM: brakeDiffM,
          s: cmpBrakePt.s,
        });
      }
    }

    if (out.length >= 5) break;
  }

  return out.slice(0, 5);
}
