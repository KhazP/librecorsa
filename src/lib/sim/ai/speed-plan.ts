/**
 * The speed a car can carry along a path: quasi-steady forward-backward passes on the car's measured limits
 * (`CarLimits`), with the road's slope, crests / compressions and banking.
 *
 *  1. Cornering limit per point: the highest v with v²|κ| ≤ a_lat(v, g̃) ± g·sin(bank), where the effective gravity
 *     g̃ = g·cos(slope)·cos(bank) + v²·y'' is lighter over a crest (y'' < 0) and heavier in a dip
 *  2. Backward (braking) and forward (traction) passes, each sharing grip with the cornering on a friction ellipse
 *     (exponent 2), with the slope's gravity along the road
 *  3. Twice round the lap, so the start / finish joins up (TUM `calc_vel_profile`)
 *
 * TUM's own profile keeps the machine (power) limit to the forward pass only, as here: an asymmetric envelope is what
 * puts the late apexes in a lap-time line (racing-line report §0).
 */
import type { AiTrack } from './ai-track';
import { pathGeometry, type PathGeometry } from './ai-track';
import { G, type CarLimits } from './ggv';

export interface SpeedPlan {
  /** Planned speed per AI grid point (m/s) */
  v: Float64Array;
  /**
   * The cornering and braking limits only (no forward / traction pass): what the car may carry at each point. A car
   * tracks this, accelerating as hard as its own engine allows; the full plan above times the lap
   */
  vLimit: Float64Array;
  /** Lap time of the plan along the path (s) */
  lapS: number;
  geometry: PathGeometry;
}

const COMBINED_EXP = 2;

/** Grip left along the road when `aLatUsed` of `aLatMax` is cornering, as a share of the straight-line limit */
const longShare = (aLatUsed: number, aLatMax: number) => {
  const r = Math.min(1, Math.abs(aLatUsed) / Math.max(1e-6, aLatMax));
  return Math.pow(Math.max(0, 1 - Math.pow(r, COMBINED_EXP)), 1 / COMBINED_EXP);
};

export function planSpeeds(track: AiTrack, offsets: ArrayLike<number>, limits: CarLimits, geometry = pathGeometry(track, offsets)): SpeedPlan {
  const n = track.n;
  const { kappa, seg } = geometry;
  const vTop = limits.topSpeedMs;
  const gEffAt = (i: number, v: number) => G * Math.cos(track.slope[i]) * Math.cos(track.bank[i]) + v * v * track.vcurv[i];
  // Lateral gravity from banking: + helps when the road is banked into the turn (+ bank raises the left edge, which
  // helps a right-hander: + curvature)
  const bankHelp = (i: number) => G * Math.sin(track.bank[i]) * Math.sign(kappa[i] || 1);

  // 1. Cornering limit (bisection on v)
  const vLat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(kappa[i]);
    if (k < 1e-5) {
      vLat[i] = vTop;
      continue;
    }
    let lo = 1, hi = vTop;
    for (let it = 0; it < 30; it++) {
      const v = 0.5 * (lo + hi);
      if (v * v * k <= limits.lateral(v, gEffAt(i, v)) + bankHelp(i)) lo = v;
      else hi = v;
    }
    vLat[i] = lo;
  }

  // 2. Backward (braking into each point) and forward (accelerating out of each) passes, twice round the lap
  const backward = (v: Float64Array) => {
    for (let step = 0; step < 2 * n; step++) {
      const i = (2 * n - 1 - step) % n;
      const j = (i + 1) % n;
      const vj = v[j];
      const aLatMax = limits.lateral(vj, gEffAt(j, vj)) + bankHelp(j);
      const aBrake = limits.braking(vj, gEffAt(j, vj)) * longShare(vj * vj * kappa[j], aLatMax) + G * Math.sin(track.slope[i]);
      const vMax = Math.sqrt(vj * vj + 2 * Math.max(0.5, aBrake) * seg[i]);
      if (vMax < v[i]) v[i] = vMax;
    }
  };
  const forward = (v: Float64Array) => {
    for (let step = 0; step < 2 * n; step++) {
      const i = step % n;
      const j = (i + 1) % n;
      const vi = v[i];
      const aLatMax = limits.lateral(vi, gEffAt(i, vi)) + bankHelp(i);
      const aAcc = limits.traction(vi) * longShare(vi * vi * kappa[i], aLatMax) - G * Math.sin(track.slope[i]);
      const vMax = Math.sqrt(Math.max(0, vi * vi + 2 * aAcc * seg[i]));
      if (vMax < v[j]) v[j] = Math.max(vMax, 1);
    }
  };
  // The braking-only envelope: what the car may carry, whatever its engine
  const vLimit = Float64Array.from(vLat);
  backward(vLimit);
  backward(vLimit);
  const v = Float64Array.from(vLimit);
  for (let round = 0; round < 2; round++) {
    forward(v);
    backward(v);
  }
  let lapS = 0;
  for (let i = 0; i < n; i++) lapS += seg[i] / Math.max(1, 0.5 * (v[i] + v[(i + 1) % n]));
  return { v, vLimit, lapS, geometry };
}
