/**
 * The track as the AI reads it: flat typed arrays on a fixed 2 m grid along the centreline, built once per track.
 *
 * `BuiltTrackData` resamples every circuit to 1200 samples (0.8 – 5.8 m apart depending on its length) and its
 * `getSampleAtDistance` allocates on every call; the AI's lines, speed plans and planner work on many points per
 * frame, so they read these arrays instead. Lateral offsets are + right, as `lateralOffsetM` everywhere.
 */
import type { BuiltTrackData } from '@/lib/track-data';

export const AI_TRACK_DS = 2;

export interface AiTrack {
  readonly lengthM: number;
  readonly ds: number;
  readonly n: number;
  /** Centreline world position */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Horizontal unit tangent and horizontal unit right vector */
  readonly tx: Float64Array;
  readonly tz: Float64Array;
  readonly rx: Float64Array;
  readonly rz: Float64Array;
  /** Centreline horizontal curvature (1/m, + turning right) */
  readonly kappa: Float64Array;
  /** Road width (m), banking (rad, + raises the left edge: a right-hander banked into the turn) */
  readonly width: Float64Array;
  readonly bank: Float64Array;
  /** Longitudinal slope (rad, + uphill) and vertical curvature d²y/ds² (1/m: + in a dip, − over a crest) */
  readonly slope: Float64Array;
  readonly vcurv: Float64Array;
  /** Kerb on the left / right edge (0/1) */
  readonly kerbL: Uint8Array;
  readonly kerbR: Uint8Array;
}

const cache = new WeakMap<BuiltTrackData, AiTrack>();

/** Periodic index of a lap distance on a grid of `n` points `ds` apart */
export const gridIndex = (s: number, ds: number, n: number) => ((Math.round(s / ds) % n) + n) % n;

/** Linear interpolation of a periodic grid array at lap distance `s` */
export function sampleGrid(arr: ArrayLike<number>, s: number, ds: number): number {
  const n = arr.length;
  const k = s / ds;
  const f = Math.floor(k);
  const t = k - f;
  const i0 = ((f % n) + n) % n;
  const i1 = (i0 + 1) % n;
  return arr[i0] + (arr[i1] - arr[i0]) * t;
}

/** Light circular smoothing (box of ±`half` points), for derivatives taken from sampled geometry */
function smoothCircular(a: Float64Array, half: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -half; k <= half; k++) sum += a[(i + k + n) % n];
    out[i] = sum / (2 * half + 1);
  }
  return out;
}

export function aiTrackFor(track: BuiltTrackData): AiTrack {
  const hit = cache.get(track);
  if (hit) return hit;
  const L = track.totalLengthM;
  const n = Math.max(16, Math.round(L / AI_TRACK_DS));
  const ds = L / n;
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const tx = new Float64Array(n), tz = new Float64Array(n), rx = new Float64Array(n), rz = new Float64Array(n);
  const width = new Float64Array(n), bank = new Float64Array(n);
  const kerbL = new Uint8Array(n), kerbR = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const smp = track.getSampleAtDistance(i * ds);
    x[i] = smp.position.x;
    y[i] = smp.position.y;
    z[i] = smp.position.z;
    width[i] = smp.width;
    bank[i] = smp.bankingRad;
    kerbL[i] = smp.kerbLeft ? 1 : 0;
    kerbR[i] = smp.kerbRight ? 1 : 0;
    // Right = the sample's binormal flattened onto the ground plane
    const bl = Math.hypot(smp.binormal.x, smp.binormal.z) || 1;
    rx[i] = smp.binormal.x / bl;
    rz[i] = smp.binormal.z / bl;
  }
  // Tangents and heading from the positions (central differences over ±2 points)
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n, b = (i + 2) % n;
    const dx = x[b] - x[a], dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
    heading[i] = Math.atan2(dx, dz);
  }
  // Curvature: heading change per metre over ±3 points, signed + right (the right vector is where the turn goes)
  const kRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 3 + n) % n, b = (i + 3) % n;
    let d = heading[b] - heading[a];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    // Heading increases toward +x; turning toward the right vector is + curvature
    const towardRight = Math.sign(tx[b] * rx[i] + tz[b] * rz[i] - (tx[a] * rx[i] + tz[a] * rz[i])) || 1;
    kRaw[i] = (Math.abs(d) / (6 * ds)) * towardRight;
  }
  const kappa = smoothCircular(kRaw, 2);
  // Slope and vertical curvature from the heights (smoothed: the scans carry centimetre noise)
  const ys = smoothCircular(smoothCircular(y, 3), 3);
  const slope = new Float64Array(n), vcurvRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    slope[i] = Math.atan((ys[b] - ys[a]) / (2 * ds));
    const a5 = (i - 5 + n) % n, b5 = (i + 5) % n;
    vcurvRaw[i] = (ys[b5] - 2 * ys[i] + ys[a5]) / (25 * ds * ds);
  }
  const vcurv = smoothCircular(vcurvRaw, 3);
  const t: AiTrack = { lengthM: L, ds, n, x, y, z, tx, tz, rx, rz, kappa, width, bank, slope, vcurv, kerbL, kerbR };
  cache.set(track, t);
  return t;
}

/** A line given as lateral offsets on the AI grid, as world points with segment lengths and horizontal curvature */
export interface PathGeometry {
  /** Horizontal curvature of the path itself (1/m, + right) */
  kappa: Float64Array;
  /** Length of each grid step along the path (m) */
  seg: Float64Array;
}

export function pathGeometry(t: AiTrack, offsets: ArrayLike<number>, spanPoints = 3): PathGeometry {
  const n = t.n;
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    px[i] = t.x[i] + t.rx[i] * offsets[i];
    pz[i] = t.z[i] + t.rz[i] * offsets[i];
  }
  const seg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    seg[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i]);
  }
  // Menger curvature of (i − k, i, i + k), signed by which side the turn goes (+ right)
  const raw = new Float64Array(n);
  const k = spanPoints;
  for (let i = 0; i < n; i++) {
    const a = (i - k + n) % n, b = (i + k) % n;
    const ax = px[a], az = pz[a], bx = px[i], bz = pz[i], cx = px[b], cz = pz[b];
    const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const d1 = Math.hypot(bx - ax, bz - az), d2 = Math.hypot(cx - bx, cz - bz), d3 = Math.hypot(cx - ax, cz - az);
    const kk = (2 * Math.abs(cross)) / Math.max(1e-6, d1 * d2 * d3);
    // Which side the middle point bends toward, measured on the right vector
    const mx = 0.5 * (ax + cx), mz = 0.5 * (az + cz);
    const side = (mx - bx) * t.rx[i] + (mz - bz) * t.rz[i];
    raw[i] = side >= 0 ? kk : -kk;
  }
  return { kappa: smoothCircular(raw, 1), seg };
}
