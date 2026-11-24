/**
 * Side lanes: a left and a right lane beside a class's racing line, each kept to one half of the road and with its
 * own speeds, for racing side by side. The idea is Speed Dreams' (the simplix, shadow, dandroid and usr drivers build
 * a left and a right lane next to the racing line, each held to one side of the road, with their own speed plans at
 * 95 % of the grip and braking, and a car alongside another takes its own side's lane); this is our own
 * implementation of it, built at race load from the line the field already drives.
 *
 * A lane is the racing line clamped into its half of the car's usable road (the car's `lateralRangeAt`: edges, lips,
 * kerbs and other layouts' roads already in it), its inner edge `gapM` plus half a car's width from the centre, then
 * smoothed toward the least curvature inside those bounds (Gauss-Seidel on the path's second difference, in the world,
 * projected back across the road). Its speeds are the AI speed plan's on the lane at `gripShare` of the line's grip,
 * kept as a ratio to the line's own (`ratio`, ≤ 1) so each car applies it to its own plan.
 *
 * A grid point has no lane (`ok` 0) where that half is narrower than a car, or the lane is tighter than the car can
 * steer: there the field keeps its yield rules.
 */
import type { AiTrack } from './ai-track';
import { pathGeometry } from './ai-track';
import type { CarLimits } from './ggv';
import { planSpeeds } from './speed-plan';

export interface SideLane {
  /** Lateral offset of the lane per AI grid point (m, + right, as the line's) */
  readonly n: Float64Array;
  /** The lane's speed against the line's at the same grid point (≤ 1) */
  readonly ratio: Float32Array;
  /** 1 where the lane exists */
  readonly ok: Uint8Array;
}

export interface SideLanes {
  readonly left: SideLane;
  readonly right: SideLane;
}

export interface SideLaneOptions {
  /** Clear road between the lane's inner edge and the centre (m) */
  gapM?: number;
  carWidthM?: number;
  /** Smoothing sweeps */
  iters?: number;
  /** Grip share of the lane's speed plan against the line's (Speed Dreams' 0.95) */
  gripShare?: number;
}

/**
 * Both lanes for a line. `rangeAt(s)` is the car's usable road at lap distance `s` ([left, right] centre offsets, m);
 * `limits` the class's limits at the plan grip, `laneLimits` the same at `gripShare` of it
 */
export function buildSideLanes(
  t: AiTrack,
  line: ArrayLike<number>,
  rangeAt: (s: number) => [number, number],
  limits: CarLimits,
  laneLimits: CarLimits,
  opts: SideLaneOptions = {}
): SideLanes {
  const N = t.n;
  const lo = new Float64Array(N), hi = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const [a, b] = rangeAt(i * t.ds);
    lo[i] = a;
    hi[i] = b;
  }
  const inner = (opts.gapM ?? 0.5) + 0.5 * (opts.carWidthM ?? 1.95);
  const lineV = planSpeeds(t, line, limits).vLimit;
  const lane = (side: -1 | 1): SideLane => {
    const blo = new Float64Array(N), bhi = new Float64Array(N);
    const ok = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (side < 0) {
        blo[i] = lo[i];
        bhi[i] = Math.min(hi[i], -inner);
      } else {
        blo[i] = Math.max(lo[i], inner);
        bhi[i] = hi[i];
      }
      ok[i] = blo[i] <= bhi[i] ? 1 : 0;
      // No room on this side: the lane runs at the edge of the half it can't fit in, marked unusable
      if (!ok[i]) blo[i] = bhi[i] = side < 0 ? Math.min(hi[i], Math.max(lo[i], -inner)) : Math.max(lo[i], Math.min(hi[i], inner));
    }
    const n = new Float64Array(N);
    for (let i = 0; i < N; i++) n[i] = Math.min(bhi[i], Math.max(blo[i], line[i]));
    // Least curvature inside the bounds: each point moved to where its neighbours' second difference is zero,
    // p_i = (−p_{i−2} + 4p_{i−1} + 4p_{i+1} − p_{i+2}) / 6, then back across the road and into its bounds. Coarse to
    // fine (every 8th point, then 4th, 2nd, each one): on the full grid alone the smoothing creeps along a few metres
    // a sweep and a hairpin's lane still had a kink after 2000 sweeps
    const iters = opts.iters ?? 120;
    for (const stride of [8, 4, 2, 1]) {
      const M = Math.floor(N / stride);
      if (M < 8) continue;
      const at = (k: number) => (((k % M) + M) % M) * stride;
      const px = (k: number) => {
        const i = at(k);
        return t.x[i] + t.rx[i] * n[i];
      };
      const pz = (k: number) => {
        const i = at(k);
        return t.z[i] + t.rz[i] * n[i];
      };
      for (let it = 0; it < iters; it++) {
        for (let k = 0; k < M; k++) {
          const i = at(k);
          const x = (-px(k - 2) + 4 * px(k - 1) + 4 * px(k + 1) - px(k + 2)) / 6;
          const z = (-pz(k - 2) + 4 * pz(k - 1) + 4 * pz(k + 1) - pz(k + 2)) / 6;
          const off = (x - t.x[i]) * t.rx[i] + (z - t.z[i]) * t.rz[i];
          n[i] = Math.min(bhi[i], Math.max(blo[i], off));
        }
      }
      // The points between: straight between their neighbours on this level, into their bounds
      if (stride > 1) {
        for (let k = 0; k < M; k++) {
          const i0 = at(k), i1 = at(k + 1);
          const span = k === M - 1 ? N - i0 : stride;
          for (let j = 1; j < span; j++) {
            const i = (i0 + j) % N;
            const u = j / span;
            n[i] = Math.min(bhi[i], Math.max(blo[i], n[i0] * (1 - u) + n[i1] * u));
          }
        }
      }
    }
    // Tighter than the car can steer: no lane there
    const geo = pathGeometry(t, n);
    for (let i = 0; i < N; i++) if (Math.abs(geo.kappa[i]) > limits.maxKappa) ok[i] = 0;
    const laneV = planSpeeds(t, n, laneLimits, geo).vLimit;
    const ratio = new Float32Array(N);
    for (let i = 0; i < N; i++) ratio[i] = Math.min(1, laneV[i] / Math.max(1, lineV[i]));
    return { n, ratio, ok };
  };
  return { left: lane(-1), right: lane(1) };
}
