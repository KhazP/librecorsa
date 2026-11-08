/**
 * Reference lines to judge our racing lines against, on our track's own frame (distance s along the centreline,
 * lateral n + right, speed v), resampled to a uniform grid:
 *
 *  - Assetto Corsa `fast_lane.ai`: the line the AC track's author recorded by driving it, with speeds (the sim-grade
 *    circuits were ported from these AC tracks, so the line is in the same world up to `metadata.modelOffset`)
 *  - OpenF1 pole-lap telemetry: position (circuit frame, 0.1 m units, ~3.8 Hz) registered to our centreline by a rigid
 *    fit, and speed from the car data
 *
 * Both are local reference data: read from disk, never shipped (licences: the AC mods' own; OpenF1 CC BY-NC-SA).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BuiltTrackData } from '../../../src/lib/track-data';

export interface RefLine {
  source: string;
  /** Grid spacing (m) and values per grid point: lateral offset (m, + right) and speed (m/s); NaN where unknown */
  ds: number;
  n: Float64Array;
  v: Float64Array;
}

const HOME = homedir();
export const REALISM_REF = process.env.REALISM_REF ?? join(HOME, 'Documents/GitHub/_realism-ref');
const DOWNLOADS = process.env.AC_TRACKS_DIR ?? join(HOME, 'Downloads');

/** Where each sim-grade circuit's AC layout keeps its `fast_lane.ai` */
const FAST_LANE: Record<string, string> = {
  chang: 'chang/circuit_gp',
  okayama: 'okayama/circuit_gp',
  okayama_piper: 'okayama/circuit_piper',
  okayama_drift: 'okayama/circuit_piper_drift',
  monaco: 'monaco/monaco_v101',
  spielberg: 'spielberg/spielberg_ver2/circuit_full',
  spielberg_south: 'spielberg/spielberg_ver2/circuit_south',
  spielberg_inner: 'spielberg/spielberg_ver2/circuit_inner',
  dunsfold: 'librecorsa-src/topgear/topgear',
};

export function fastLanePath(trackId: string): string | null {
  const rel = FAST_LANE[trackId];
  if (!rel) return null;
  const p = join(DOWNLOADS, rel, 'ai', 'fast_lane.ai');
  return existsSync(p) ? p : null;
}

export function telemetryPath(trackId: string): string | null {
  const p = join(REALISM_REF, 'telemetry', `${trackId}_2026_Q.json`);
  return existsSync(p) ? p : null;
}

const wrap = (s: number, L: number) => ((s % L) + L) % L;

/**
 * Points (s, n, v) along a lap onto a uniform periodic grid: each grid point takes the linear interpolation of the
 * samples around it (sorted by s, wrap-around aware); a gap wider than `maxGapM` leaves NaN
 */
export function toGrid(points: { s: number; n: number; v: number }[], L: number, ds: number, maxGapM = 30): { n: Float64Array; v: Float64Array } {
  const N = Math.round(L / ds);
  const pts = points.map((p) => ({ ...p, s: wrap(p.s, L) })).sort((a, b) => a.s - b.s);
  const n = new Float64Array(N).fill(NaN);
  const v = new Float64Array(N).fill(NaN);
  if (pts.length < 2) return { n, v };
  let j = 0;
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    while (j < pts.length && pts[j].s < s) j++;
    const hi = pts[j % pts.length];
    const lo = pts[(j - 1 + pts.length) % pts.length];
    const sHi = j >= pts.length ? hi.s + L : hi.s;
    const sLo = j === 0 ? lo.s - L : lo.s;
    const gap = sHi - sLo;
    if (!(gap > 0) || gap > maxGapM) continue;
    const t = (s - sLo) / gap;
    n[i] = lo.n + (hi.n - lo.n) * t;
    v[i] = lo.v + (hi.v - lo.v) * t;
  }
  return { n, v };
}

/** The AC author's recorded line and speeds, on our track frame */
export function loadFastLane(track: BuiltTrackData, trackId: string, modelOffset: number[], ds = 2): RefLine | null {
  const path = fastLanePath(trackId);
  if (!path) return null;
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getInt32(4, true);
  const exOff = 20 + count * 20;
  const hasExtra = buf.byteLength >= exOff + count * 18 * 4;
  const pts: { s: number; n: number; v: number }[] = [];
  let hint = 0;
  for (let i = 0; i < count; i++) {
    const o = 16 + i * 20;
    // AC world → ours: the port subtracted the model offset from the AC coordinates
    const x = dv.getFloat32(o, true) + modelOffset[0];
    const z = dv.getFloat32(o + 8, true) + modelOffset[2];
    const v = hasExtra ? dv.getFloat32(exOff + i * 72, true) : NaN;
    const p = track.projectWorldToTrack(x, z, hint);
    hint = p.s;
    pts.push({ s: p.s, n: p.lateralOffset, v });
  }
  const g = toGrid(pts, track.totalLengthM, ds);
  return { source: 'fast_lane.ai', ds, ...g };
}

interface OpenF1Lap {
  lap: { lap_duration: number; date_start: string };
  car_data: { date: string; speed: number }[];
  location: { date: string; x: number; y: number }[];
}

/**
 * Rigid 2D fit (rotation + translation, optionally mirrored) of `a` onto `b` for paired points: Kabsch / Umeyama with
 * the scale held at 1. Returns the transform and the RMS residual.
 */
function rigidFit(a: Float64Array[], b: Float64Array[]): { c: number; s: number; tx: number; ty: number; rms: number } {
  const n = a.length;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (let i = 0; i < n; i++) {
    ax += a[i][0]; ay += a[i][1]; bx += b[i][0]; by += b[i][1];
  }
  ax /= n; ay /= n; bx /= n; by /= n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const px = a[i][0] - ax, py = a[i][1] - ay, qx = b[i][0] - bx, qy = b[i][1] - by;
    sxx += px * qx + py * qy;
    sxy += px * qy - py * qx;
  }
  const th = Math.atan2(sxy, sxx);
  const c = Math.cos(th), s = Math.sin(th);
  const tx = bx - (c * ax - s * ay);
  const ty = by - (s * ax + c * ay);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const x = c * a[i][0] - s * a[i][1] + tx - b[i][0];
    const y = s * a[i][0] + c * a[i][1] + ty - b[i][1];
    e += x * x + y * y;
  }
  return { c, s, tx, ty, rms: Math.sqrt(e / n) };
}

/** A closed polyline resampled to `m` points evenly spaced by arc length */
function resampleClosed(p: Float64Array[], m: number): Float64Array[] {
  const L: number[] = [0];
  for (let i = 1; i <= p.length; i++) {
    const a = p[i - 1], b = p[i % p.length];
    L.push(L[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = L[L.length - 1];
  const out: Float64Array[] = [];
  let j = 0;
  for (let k = 0; k < m; k++) {
    const s = (k / m) * total;
    while (L[j + 1] < s) j++;
    const t = (s - L[j]) / Math.max(1e-9, L[j + 1] - L[j]);
    const a = p[j], b = p[(j + 1) % p.length];
    out.push(Float64Array.of(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  }
  return out;
}

/**
 * The real pole lap on our track frame. The circuit frame of OpenF1 is unknown to us (rotation, origin, maybe a
 * mirrored axis), so the lap's path is registered to our centreline: a coarse search over the start offset and the
 * mirror on arc-length-resampled shapes, then rigid ICP on nearest points. Returns the fit residual too: a racing line
 * against a centreline leaves a few metres by nature, a wrong fit tens.
 */
export function loadOpenF1(track: BuiltTrackData, trackId: string, ds = 2): (RefLine & { fitRmsM: number; lapS: number }) | null {
  const path = telemetryPath(trackId);
  if (!path) return null;
  const lap = JSON.parse(readFileSync(path, 'utf8')) as OpenF1Lap;
  const loc = lap.location.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (loc.length < 50) return null;
  const real = loc.map((p) => Float64Array.of(p.x * 0.1, p.y * 0.1));
  // Our centreline in the horizontal plane (x, z)
  const L = track.totalLengthM;
  const cl: Float64Array[] = [];
  for (let s = 0; s < L; s += 2) {
    const q = track.getSampleAtDistance(s).position;
    cl.push(Float64Array.of(q.x, q.z));
  }
  const M = 400;
  const C = resampleClosed(cl, M);
  let best = { rms: Infinity, c: 1, s: 0, tx: 0, ty: 0, mirror: false };
  for (const mirror of [false, true]) {
    const R = resampleClosed(real.map((p) => Float64Array.of(mirror ? -p[0] : p[0], p[1])), M);
    // The lap closes as a loop: try both directions of travel too (OpenF1 order is the driving order, ours too)
    for (let k = 0; k < M; k += 2) {
      const a: Float64Array[] = [];
      for (let i = 0; i < M; i++) a.push(R[(i + k) % M]);
      const f = rigidFit(a, C);
      if (f.rms < best.rms) best = { ...f, mirror };
    }
  }
  // ICP on nearest centreline points, the whole lap
  const apply = (p: Float64Array, f: typeof best) => {
    const x = f.mirror ? -p[0] : p[0];
    return Float64Array.of(f.c * x - f.s * p[1] + f.tx, f.s * x + f.c * p[1] + f.ty);
  };
  for (let it = 0; it < 30; it++) {
    const a: Float64Array[] = [];
    const b: Float64Array[] = [];
    for (const p of real) {
      const q = apply(p, best);
      let dmin = Infinity, nearest = cl[0];
      for (const c of cl) {
        const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2;
        if (d < dmin) { dmin = d; nearest = c; }
      }
      a.push(Float64Array.of(best.mirror ? -p[0] : p[0], p[1]));
      b.push(nearest);
    }
    const f = rigidFit(a, b);
    const done = Math.abs(f.rms - best.rms) < 1e-4;
    best = { ...f, mirror: best.mirror };
    if (done) break;
  }
  // Speed at each location time (car data is its own clock)
  const cd = lap.car_data.map((d) => ({ t: Date.parse(d.date), v: d.speed / 3.6 })).sort((a, b) => a.t - b.t);
  const speedAt = (t: number) => {
    let i = cd.findIndex((d) => d.t >= t);
    if (i <= 0) return cd[Math.max(0, i)].v;
    const a = cd[i - 1], b = cd[i];
    return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(1, b.t - a.t);
  };
  const pts: { s: number; n: number; v: number }[] = [];
  let hint = 0;
  for (let i = 0; i < loc.length; i++) {
    const q = apply(real[i], best);
    const p = track.projectWorldToTrack(q[0], q[1], hint);
    hint = p.s;
    pts.push({ s: p.s, n: p.lateralOffset, v: speedAt(Date.parse(loc[i].date)) });
  }
  const g = toGrid(pts, L, ds, 60);
  return { source: 'OpenF1 pole lap', ds, ...g, fitRmsM: best.rms, lapS: lap.lap.lap_duration };
}
