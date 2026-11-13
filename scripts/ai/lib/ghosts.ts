/**
 * Players' fastest laps (the online boards' ghosts, fetched by scripts/ai/fetch-ghosts.ts) as references for the AI
 * lines: each lap projected onto this circuit's centreline as lateral offset, speed and lap time on the AI grid.
 *
 * A ghost from an older version of the circuit is moved onto this one first (`alignGhostToTrack`); where the car's
 * centre went well past the road edge (a cut, a slide onto the grass) the lap is marked, and a lap that leaves the road
 * for long is not used at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuiltTrackData } from '../../../src/lib/track-data';
import { validateLapRecording } from '../../../src/lib/sim/lap-recorder';
import { alignGhostToTrack } from '../../../src/lib/sim/ghost-align';
import { LAP_SAMPLE_STRIDE } from '../../../src/lib/sim/lap-types';
import { REALISM_REF, type RefLine } from './references';

export const GHOST_DIR = join(REALISM_REF, 'ghosts');

/** One downloaded lap, as fetch-ghosts.ts indexes it (no names) */
export interface GhostIndexRow {
  id: string;
  track: string;
  vehicle: string;
  physics: number;
  lapTimeMs: number;
  assists: string | null;
  realism: string | null;
  surface: string | null;
}

export interface GhostLine extends RefLine {
  id: string;
  vehicle: string;
  physics: number;
  assists: string | null;
  lapS: number;
  /** Time since the lap's start at each grid point (s) */
  t: Float64Array;
  /** Brake pedal at each grid point (0..1) */
  brake: Float64Array;
  /** Share of the grid points where the car's centre was more than `OUT_M` past the road edge */
  offRoadShare: number;
  /** Furthest the car's centre went past the road edge (m) */
  worstOutM: number;
  /** Grid points with the car's centre more than `OUT_M` past the edge (1) */
  out: Uint8Array;
  /** Share of the grid the lap covers */
  coverage: number;
  /** The lap was driven on another version of the circuit and moved onto this one */
  aligned: boolean;
}

/** All four wheels off: the car's centre this far past the road edge (m) */
export const OUT_M = 1.2;
/** A lap off the road for more than this share of its length is no reference */
const MAX_OFF_ROAD_SHARE = 0.03;

const wrap = (s: number, L: number) => ((s % L) + L) % L;

export function ghostIndex(): GhostIndexRow[] {
  const p = join(GHOST_DIR, 'index.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as GhostIndexRow[]) : [];
}

/**
 * The ghosts of a circuit for these cars, on the AI grid (`n` points `ds` apart), fastest first. Wet laps are left
 * out unless asked for; laps that leave the road for long, or cover less than 95 % of the lap, are dropped.
 */
export function loadGhostLines(
  track: BuiltTrackData,
  trackId: string,
  opts: { vehicles: readonly string[]; n: number; ds: number; wet?: boolean; physics?: readonly number[]; keepOffRoad?: boolean }
): GhostLine[] {
  const rows = ghostIndex().filter(
    (r) =>
      r.track === trackId &&
      opts.vehicles.includes(r.vehicle) &&
      (opts.wet || r.surface !== 'wet') &&
      (!opts.physics || opts.physics.includes(r.physics))
  );
  const out: GhostLine[] = [];
  for (const row of rows) {
    const file = join(GHOST_DIR, trackId, `${row.id}.json`);
    if (!existsSync(file)) continue;
    const rec = validateLapRecording(JSON.parse(readFileSync(file, 'utf8')));
    if (!rec) continue;
    const { recording, aligned } = alignGhostToTrack(rec, track);
    const g = ghostOnGrid(track, recording.data, recording.lapTimeMs / 1000, opts.n, opts.ds);
    const line: GhostLine = {
      source: `ghost ${row.vehicle} ${(row.lapTimeMs / 1000).toFixed(3)} s (${row.assists ?? '?'}, p${row.physics})`,
      id: row.id,
      vehicle: row.vehicle,
      physics: row.physics,
      assists: row.assists,
      lapS: row.lapTimeMs / 1000,
      aligned,
      ...g,
    };
    if (line.coverage < 0.95) continue;
    if (!opts.keepOffRoad && line.offRoadShare > MAX_OFF_ROAD_SHARE) continue;
    out.push(line);
  }
  return out.sort((a, b) => a.lapS - b.lapS);
}

/** A recording's samples projected onto the track and resampled onto the grid (linear, wrap-aware) */
function ghostOnGrid(track: BuiltTrackData, data: number[], lapS: number, N: number, ds: number) {
  const L = track.totalLengthM;
  const count = Math.floor(data.length / LAP_SAMPLE_STRIDE);
  const pts: { s: number; n: number; v: number; t: number; b: number }[] = [];
  let hint = data[1] ?? 0;
  for (let i = 0; i < count; i++) {
    const o = i * LAP_SAMPLE_STRIDE;
    const p = track.projectWorldToTrack(data[o + 2], data[o + 4], hint);
    hint = p.s;
    pts.push({ s: wrap(p.s, L), n: p.lateralOffset, v: data[o + 9] / 3.6, t: data[o], b: data[o + 11] });
  }
  pts.sort((a, b) => a.s - b.s);
  const n = new Float64Array(N).fill(NaN), v = new Float64Array(N).fill(NaN), t = new Float64Array(N).fill(NaN);
  const brake = new Float64Array(N).fill(NaN);
  const out = new Uint8Array(N);
  let covered = 0, outCount = 0, worstOut = 0;
  if (pts.length >= 2) {
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      while (j < pts.length && pts[j].s < s) j++;
      const hi = pts[j % pts.length], lo = pts[(j - 1 + pts.length) % pts.length];
      const sHi = j >= pts.length ? hi.s + L : hi.s;
      const sLo = j === 0 ? lo.s - L : lo.s;
      const gap = sHi - sLo;
      if (!(gap > 0) || gap > 30) continue;
      const f = (s - sLo) / gap;
      n[i] = lo.n + (hi.n - lo.n) * f;
      v[i] = lo.v + (hi.v - lo.v) * f;
      brake[i] = lo.b + (hi.b - lo.b) * f;
      // Across the start line the clock restarts: carry it over a lap
      const tHi = hi.t < lo.t ? hi.t + lapS : hi.t;
      t[i] = wrap(lo.t + (tHi - lo.t) * f, lapS);
      covered++;
      const past = Math.abs(n[i]) - track.getSampleAtDistance(s).width / 2;
      worstOut = Math.max(worstOut, past);
      if (past > OUT_M) {
        out[i] = 1;
        outCount++;
      }
    }
  }
  return { ds, n, v, t, brake, out, coverage: covered / N, offRoadShare: outCount / N, worstOutM: worstOut };
}

/** Time the lap took from grid point `i0` to `i1` (s), through the start line if need be; NaN where not covered */
export function segmentTime(t: ArrayLike<number>, lapS: number, i0: number, i1: number): number {
  const a = t[i0], b = t[i1];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return wrap(b - a, lapS);
}

/**
 * Corners as speed minima: points slower than everything within ±`winM` and under 90 % of the fastest within
 * ±`wideM` (the corner detection of line-report.ts)
 */
export function cornerMinima(v: ArrayLike<number>, ds: number, winM = 60, wideM = 250): number[] {
  const N = v.length;
  const out: number[] = [];
  const win = Math.round(winM / ds), wide = Math.round(wideM / ds);
  for (let i = 0; i < N; i++) {
    const vi = v[i];
    if (!Number.isFinite(vi)) continue;
    let isMin = true, maxAround = vi;
    for (let k = -wide; k <= wide; k++) {
      const vk = v[(i + k + N) % N];
      if (!Number.isFinite(vk)) continue;
      if (Math.abs(k) <= win && vk < vi) isMin = false;
      if (vk > maxAround) maxAround = vk;
    }
    if (isMin && vi < 0.9 * maxAround && (!out.length || i - out[out.length - 1] > win)) out.push(i);
  }
  return out;
}

/**
 * Segments of the lap, one per corner: segment c runs from the fastest point after corner c to the fastest point
 * after corner c + 1 (the ends of the straights, where lines meet again), so it holds corner c + 1; [from, to) grid
 * indices
 */
export function cornerSegments(v: ArrayLike<number>, corners: number[]): [number, number][] {
  const N = v.length;
  // One segment for the whole lap, ending a point short of where it starts (the loops run from `from` until `to`)
  if (corners.length < 2) return [[0, N - 1]];
  const cuts: number[] = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const span = (b - a + N) % N || N;
    let best = a, bestV = -Infinity;
    for (let k = 1; k < span; k++) {
      const i = (a + k) % N;
      if (Number.isFinite(v[i]) && v[i] > bestV) {
        bestV = v[i];
        best = i;
      }
    }
    cuts.push(best);
  }
  const segs: [number, number][] = [];
  for (let c = 0; c < cuts.length; c++) segs.push([cuts[c], cuts[(c + 1) % cuts.length]]);
  return segs;
}

/**
 * One line from the fastest lap through each segment: the segment times of every ghost are compared and the
 * quickest lap's line is taken there, blended into the next over `blendM` around each cut (a raised cosine). Gaps
 * in a lap's coverage fall back to `fallback`. Returns the line, the lap chosen per segment and the summed times.
 */
export function stitchFastest(
  laps: GhostLine[],
  segs: [number, number][],
  fallback: ArrayLike<number>,
  blendM = 40
): { n: Float64Array; picks: number[]; idealS: number } {
  const N = fallback.length;
  const ds = laps[0].ds;
  const picks: number[] = [];
  let idealS = 0;
  const base = new Float64Array(N);
  for (let i = 0; i < N; i++) base[i] = fallback[i];
  const owner = new Int32Array(N).fill(-1);
  for (const [a, b] of segs) {
    let best = -1, bestT = Infinity;
    laps.forEach((g, k) => {
      const dt = segmentTime(g.t, g.lapS, a, b);
      // A segment the lap spent off the road is no reference for it
      let off = false;
      for (let i = a; i !== b; i = (i + 1) % N) if (g.out[i]) off = true;
      if (!off && dt < bestT) {
        bestT = dt;
        best = k;
      }
    });
    picks.push(best);
    if (best >= 0) idealS += bestT;
    for (let i = a; i !== b; i = (i + 1) % N) owner[i] = best;
  }
  const own = (k: number, i: number) => {
    const x = k >= 0 ? laps[k].n[i] : NaN;
    return Number.isFinite(x) ? x : base[i];
  };
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = own(owner[i], i);
  // Blend across each cut: the line before the cut eases into the one after it
  const half = Math.max(1, Math.round(blendM / 2 / ds));
  for (let c = 0; c < segs.length; c++) {
    const cut = segs[c][0];
    const prev = owner[(cut - 1 + N) % N], next = owner[cut];
    if (prev === next) continue;
    for (let k = -half; k < half; k++) {
      const i = (cut + k + N) % N;
      const w = 0.5 * (1 - Math.cos((Math.PI * (k + half)) / (2 * half)));
      out[i] = own(prev, i) * (1 - w) + own(next, i) * w;
    }
  }
  return { n: out, picks, idealS };
}

/** Circular box smoothing over ±`halfM` (a driver's small steering corrections are not part of the line) */
export function smoothLine(n: ArrayLike<number>, ds: number, halfM = 6): Float64Array {
  const N = n.length;
  const h = Math.max(1, Math.round(halfM / ds));
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0, cnt = 0;
    for (let k = -h; k <= h; k++) {
      const x = n[(i + k + N) % N];
      if (Number.isFinite(x)) {
        sum += x;
        cnt++;
      }
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

/** `line` with its NaN points filled from `fallback` */
export function filled(line: ArrayLike<number>, fallback: ArrayLike<number>): Float64Array {
  const out = new Float64Array(line.length);
  for (let i = 0; i < line.length; i++) out[i] = Number.isFinite(line[i]) ? line[i] : fallback[i];
  return out;
}
