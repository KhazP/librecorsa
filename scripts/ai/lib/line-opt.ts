/**
 * Racing line optimisation on the AI grid (`src/lib/sim/ai`): the line is a periodic Catmull-Rom curve through lateral
 * control points every few metres, kept inside the usable road, and chosen to minimise the lap time of the car's own
 * speed plan (`planSpeeds` on its measured limits, with slope, crests and banking) plus a penalty on how fast the
 * curvature changes (the role of TUM's steering-rate penalty: a drivable line, not a jagged one).
 *
 * Starts: the current line and a minimum-curvature line (TUM's starting point for its lap-time optimisation); each is
 * refined by projected gradient descent with finite-difference gradients and a backtracking step, and the faster wins.
 */
import { pathGeometry, type AiTrack } from '../../../src/lib/sim/ai/ai-track';
import type { CarLimits } from '../../../src/lib/sim/ai/ggv';
import { planSpeeds } from '../../../src/lib/sim/ai/speed-plan';

export interface LineBounds {
  lo: Float64Array;
  hi: Float64Array;
}

/**
 * Where the car's centre may be: `edgeM` inside each edge, `kerbM` where that edge has a kerb within ±`kerbReachM`
 * (the line may put two wheels on it); `extra` narrows one side further (an inside / outside line)
 */
export function lineBounds(t: AiTrack, edgeM = 1.2, kerbM = 0.6, kerbReachM = 8): LineBounds {
  const n = t.n;
  const lo = new Float64Array(n), hi = new Float64Array(n);
  const reach = Math.round(kerbReachM / t.ds);
  for (let i = 0; i < n; i++) {
    let kL = false, kR = false;
    for (let k = -reach; k <= reach; k++) {
      const j = (i + k + n) % n;
      if (t.kerbL[j]) kL = true;
      if (t.kerbR[j]) kR = true;
    }
    const half = t.width[i] / 2;
    lo[i] = -(half - (kL ? kerbM : edgeM));
    hi[i] = half - (kR ? kerbM : edgeM);
    if (lo[i] > hi[i]) lo[i] = hi[i] = 0.5 * (lo[i] + hi[i]);
  }
  return { lo, hi };
}

/** Bounds from a car's own usable road (`lateralRangeAt`: edges, lips, kerbs), less `marginM` for tracking error */
export function lineBoundsFromCar(t: AiTrack, rangeAt: (s: number) => [number, number], marginM = 0.15): LineBounds {
  const lo = new Float64Array(t.n), hi = new Float64Array(t.n);
  for (let i = 0; i < t.n; i++) {
    const [a, b] = rangeAt(i * t.ds);
    lo[i] = a + marginM;
    hi[i] = b - marginM;
    if (lo[i] > hi[i]) lo[i] = hi[i] = 0.5 * (lo[i] + hi[i]);
  }
  return { lo, hi };
}

/** Control points every `spacingM` and the interpolation onto the grid */
export class LineParam {
  readonly m: number;
  /** Fractional control coordinate of each grid point */
  private readonly u: Float64Array;

  constructor(readonly t: AiTrack, spacingM = 6) {
    this.m = Math.max(8, Math.round(t.lengthM / spacingM));
    this.u = new Float64Array(t.n);
    for (let i = 0; i < t.n; i++) this.u[i] = (i * this.m) / t.n;
  }

  /** Grid offsets from control points (periodic Catmull-Rom), clamped into the bounds */
  toGrid(c: Float64Array, b: LineBounds, out = new Float64Array(this.t.n)): Float64Array {
    const m = this.m;
    for (let i = 0; i < this.t.n; i++) {
      const u = this.u[i];
      const k = Math.floor(u);
      const s = u - k;
      const p0 = c[(k - 1 + m) % m], p1 = c[k % m], p2 = c[(k + 1) % m], p3 = c[(k + 2) % m];
      const v =
        0.5 * (2 * p1 + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
      out[i] = Math.min(b.hi[i], Math.max(b.lo[i], v));
    }
    return out;
  }

  /** Control points that reproduce grid offsets (sampled at the control positions) */
  fromGrid(n: ArrayLike<number>): Float64Array {
    const c = new Float64Array(this.m);
    for (let k = 0; k < this.m; k++) {
      const x = (k * this.t.n) / this.m;
      const i = Math.floor(x), f = x - i;
      c[k] = n[i % this.t.n] * (1 - f) + n[(i + 1) % this.t.n] * f;
    }
    return c;
  }

  /** Per-control bounds: the tightest grid bound around each control point */
  controlBounds(b: LineBounds): LineBounds {
    const lo = new Float64Array(this.m), hi = new Float64Array(this.m);
    for (let k = 0; k < this.m; k++) {
      const i = Math.round((k * this.t.n) / this.m) % this.t.n;
      lo[k] = b.lo[i];
      hi[k] = b.hi[i];
    }
    return { lo, hi };
  }
}

export interface OptOptions {
  /** Weight on Σ(Δκ)²/ds (s·m) */
  smoothW?: number;
  iters?: number;
  log?: (msg: string) => void;
  /** Stop when the step falls below this (m) */
  minStepM?: number;
}

export interface OptResult {
  n: Float64Array;
  lapS: number;
  cost: number;
  iters: number;
}

function curvatureRatePenalty(kappa: Float64Array, ds: number): number {
  let sum = 0;
  const n = kappa.length;
  for (let i = 0; i < n; i++) {
    const d = kappa[(i + 1) % n] - kappa[i];
    sum += (d * d) / ds;
  }
  return sum;
}

/** Lap time plus the smoothness penalty of a line */
export function lineCost(t: AiTrack, n: Float64Array, limits: CarLimits, smoothW: number): { cost: number; lapS: number } {
  const geo = pathGeometry(t, n);
  const plan = planSpeeds(t, n, limits, geo);
  return { cost: plan.lapS + smoothW * curvatureRatePenalty(geo.kappa, t.ds), lapS: plan.lapS };
}

/** Minimum Σκ²·ds line by projected gradient on the controls (a smooth, symmetric starting line) */
export function minCurvatureLine(param: LineParam, b: LineBounds, start: Float64Array, iters = 300): Float64Array {
  const t = param.t;
  const cb = param.controlBounds(b);
  const c = Float64Array.from(start);
  const grid = new Float64Array(t.n);
  const cost = (cc: Float64Array) => {
    const g = pathGeometry(t, param.toGrid(cc, b, grid), 2);
    let s = 0;
    for (let i = 0; i < t.n; i++) s += g.kappa[i] * g.kappa[i] * g.seg[i];
    return s;
  };
  let f = cost(c);
  let step = 0.5;
  const grad = new Float64Array(param.m);
  const h = 0.02;
  for (let it = 0; it < iters && step > 0.002; it++) {
    for (let k = 0; k < param.m; k++) {
      const keep = c[k];
      c[k] = keep + h;
      grad[k] = (cost(c) - f) / h;
      c[k] = keep;
    }
    let gmax = 0;
    for (let k = 0; k < param.m; k++) gmax = Math.max(gmax, Math.abs(grad[k]));
    if (gmax === 0) break;
    for (;;) {
      const trial = new Float64Array(param.m);
      for (let k = 0; k < param.m; k++) trial[k] = Math.min(cb.hi[k], Math.max(cb.lo[k], c[k] - (step * grad[k]) / gmax));
      const ft = cost(trial);
      if (ft < f) {
        c.set(trial);
        f = ft;
        step *= 1.3;
        break;
      }
      step *= 0.5;
      if (step < 0.002) break;
    }
  }
  return c;
}

/**
 * Lap-time optimisation of the controls from `start`: a pattern search with smooth moves. Each move shifts a run of
 * neighbouring controls by a raised-cosine bump (a single control on its own only makes a kink, which the smoothness
 * term and the speed plan both reject); bumps go from about 130 m wide down to one control, each scale with step sizes
 * from 0.8 m down to 0.05 m. A move is kept when the cost drops and carried on in its direction while it keeps
 * dropping. The cost has kinks (the bounds, the speed passes' minima) that stall a finite-difference gradient.
 */
export function optimiseLapTime(param: LineParam, b: LineBounds, limits: CarLimits, start: Float64Array, opts: OptOptions = {}): OptResult {
  const t = param.t;
  const m = param.m;
  const smoothW = opts.smoothW ?? 40;
  const maxSweeps = opts.iters ?? 3;
  const cb = param.controlBounds(b);
  const c = Float64Array.from(start);
  for (let k = 0; k < m; k++) c[k] = Math.min(cb.hi[k], Math.max(cb.lo[k], c[k]));
  const grid = new Float64Array(t.n);
  const evalC = () => lineCost(t, param.toGrid(c, b, grid), limits, smoothW);
  let cur = evalC();
  let sweeps = 0;
  const saved = new Float64Array(64);
  const schedule: [number, number[]][] = [
    [10, [0.8, 0.4]],
    [5, [0.8, 0.4, 0.2]],
    [2, [0.4, 0.2, 0.1]],
    [1, [0.2, 0.1, 0.05]],
    [0, [0.1, 0.05]],
  ];
  for (const [half, deltas] of schedule) {
    const w: number[] = [];
    for (let j = -half; j <= half; j++) w.push(half === 0 ? 1 : 0.5 * (1 + Math.cos((Math.PI * j) / (half + 1))));
    const stride = Math.max(1, Math.ceil(half / 2));
    for (const delta of deltas) {
      for (let sweep = 0; sweep < maxSweeps; sweep++) {
        sweeps++;
        let improved = 0;
        for (let k0 = 0; k0 < m; k0 += stride) {
          let accepted = false;
          for (const dir of [1, -1]) {
            for (let run = 0; run < 6; run++) {
              for (let j = -half; j <= half; j++) saved[j + half] = c[(k0 + j + m) % m];
              let changed = false;
              for (let j = -half; j <= half; j++) {
                const k = (k0 + j + m) % m;
                const v = Math.min(cb.hi[k], Math.max(cb.lo[k], c[k] + dir * delta * w[j + half]));
                if (v !== c[k]) changed = true;
                c[k] = v;
              }
              if (!changed) break;
              const r = evalC();
              if (r.cost < cur.cost - 1e-5) {
                cur = r;
                accepted = true;
              } else {
                for (let j = -half; j <= half; j++) c[(k0 + j + m) % m] = saved[j + half];
                break;
              }
            }
            if (accepted) break;
          }
          if (accepted) improved++;
        }
        opts.log?.(`  bump ±${half} δ ${delta} sweep ${sweep}: lap ${cur.lapS.toFixed(3)} s, cost ${cur.cost.toFixed(3)} (${improved} moves kept)`);
        if (improved < 2) break;
      }
    }
  }
  return { n: param.toGrid(c, b), lapS: cur.lapS, cost: cur.cost, iters: sweeps };
}
