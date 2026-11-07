/**
 * The local planner: where to drive over the next few seconds, among the cars around.
 *
 * Candidates are smooth offsets from the car's racing line in Frenet coordinates (distance s, lateral n): a quintic
 * from the car's current offset and lateral speed to an end offset, reached over one of a few lateral times, then
 * held. Generated relative to the line, so the zero-offset candidate is the line itself (TUM's relative trajectory
 * generation, Ögretmen et al. 2024). Each candidate gets the speeds the car's own limits allow on that path (its
 * curvature from the line's plus the offset's, and the line's braking envelope for what lies beyond), then is
 * checked against every other car's predicted path: overlapping a car within the confidence horizon rules the
 * candidate out; later on, being close costs (an ellipse in s and n, as TUM's planner). When the fast version of a
 * candidate hits a car, slower versions are tried, down to following it.
 *
 * Cost (lower is better): progress over the horizon (metres, negative), staying near the behaviour's intent and the
 * line, keeping to the last plan (no dithering, TUM's consistency term), proximity, and the lateral effort.
 * Weights are starting values meant to be tuned headlessly.
 */
import type { AiTrack } from './ai-track';
import { sampleGrid } from './ai-track';
import type { CarLimits } from './ggv';

export const PLAN_STEPS = 15;
export const PLAN_DT = 0.2;
/** Hard collision checks reach this far ahead (s); beyond it, closeness only costs */
const CONFIDENCE_S = 1.5;

export interface PredictedCar {
  /** Predicted lap distance and lateral offset at each planner step (k = 1..PLAN_STEPS, index k − 1) */
  s: Float64Array;
  n: Float64Array;
  halfLenM: number;
  halfWidM: number;
  /** A stopped / spun car: kept clear of by more */
  hazard: boolean;
}

export interface PlannerWeights {
  progress: number;
  intent: number;
  line: number;
  consistency: number;
  proximity: number;
  effort: number;
}

export const DEFAULT_PLANNER_WEIGHTS: PlannerWeights = {
  progress: 1,
  // The behaviour's intent (attack on this side, defend, give room) is honoured unless it collides or loses a lot:
  // over a 3 s horizon a pass buys little progress, so a weak intent term left the car following for ever
  intent: 4,
  line: 0.03,
  consistency: 0.4,
  proximity: 25,
  effort: 0.02,
};

export interface PlannerInput {
  track: AiTrack;
  /** The car's racing line offsets, the line's own path curvature (1/m, + right) and its cornering / braking limit */
  line: Float64Array;
  lineKappa: Float64Array;
  vLimit: Float64Array;
  limits: CarLimits;
  /** Usable offsets (centre of the car) per grid point */
  lo: Float64Array;
  hi: Float64Array;
  /** Car state: lap distance, offset (m, + right), lateral speed (m/s, + right), speed (m/s) */
  s: number;
  n: number;
  nDot: number;
  v: number;
  halfLenM: number;
  halfWidM: number;
  others: readonly PredictedCar[];
  /** The behaviour's wish: an end offset relative to the line (null: none, race the line) */
  intentD: number | null;
  /** A speed the behaviour caps the car at (m/s) */
  speedCapMs: number;
  /** End offset (relative to the line) chosen last time */
  prevEndD: number;
  weights?: PlannerWeights;
}

export interface PlannerResult {
  /** End offset relative to the line and the lateral time of the chosen candidate */
  endD: number;
  /** Offset (absolute, + right) and speed at each step (index k − 1 for t = k·PLAN_DT) */
  n: Float64Array;
  s: Float64Array;
  v: Float64Array;
  cost: number;
  /** No candidate was free of collisions: the least bad was taken (slowest) */
  boxedIn: boolean;
  /** Speed scale of the chosen candidate (1: the path's limit) */
  speedScale: number;
  /**
   * The speed the candidate aims at per step (its corner limit off the line, × its scale, under the cap): what the
   * tracker is held to; acceleration toward it is the car's own (the planned `v` estimates it)
   */
  vAim: Float64Array;
}

/**
 * Quintic lateral move from (d0, d0dot, 0) to (d1, 0, 0) over T, evaluated at t (held after T): with D = d1 − d0,
 * d(t) = d0 + v0·t + (10D − 6v0T)·τ³ + (−15D + 8v0T)·τ⁴ + (6D − 3v0T)·τ⁵, τ = t/T
 */
function quintic(d0: number, v0: number, d1: number, T: number, t: number): number {
  if (t >= T) return d1;
  const tau = t / T;
  const D = d1 - d0;
  const vT = v0 * T;
  return d0 + vT * tau + (10 * D - 6 * vT) * tau ** 3 + (-15 * D + 8 * vT) * tau ** 4 + (6 * D - 3 * vT) * tau ** 5;
}

const LAT_TIMES = [1.2, 2.0, 3.0];
/** Speed versions of each path: its limit, two slower ones, and following the car ahead (0) */
const SPEED_SCALES = [1, 0.96, 0.9, 0];
/**
 * Gap a following car keeps to the car ahead in its lane: this much plus this many seconds of its speed (m, s). Close
 * enough for the tow (a car kept 30 m back on the straights never had the speed to pass); the race field's follow cap
 * keeps the braking zones safe
 */
const FOLLOW_GAP_M = 2;
const FOLLOW_GAP_S = 0.12;

export function planLocal(inp: PlannerInput): PlannerResult {
  const t = inp.track;
  const w = inp.weights ?? DEFAULT_PLANNER_WEIGHTS;
  const lineAt = (s: number) => sampleGrid(inp.line, s, t.ds);
  const d0 = inp.n - lineAt(inp.s);
  // The line's own lateral rate at this speed, so the offset's rate is the car's minus the line's
  const lineRate = ((lineAt(inp.s + 1) - lineAt(inp.s - 1)) / 2) * inp.v;
  const d0Dot = inp.nDot - lineRate;

  // End offsets to try (relative to the line): the line, where the car is, the intent, and a sweep across the road
  const loHere = sampleGrid(inp.lo, inp.s + inp.v * 2, t.ds) - lineAt(inp.s + inp.v * 2);
  const hiHere = sampleGrid(inp.hi, inp.s + inp.v * 2, t.ds) - lineAt(inp.s + inp.v * 2);
  // End offsets with a purpose: the line, where the car is, the intent, the last choice, and beside each car ahead
  // (a sweep across the whole road let the planner wander: progress along the centreline rewards cutting inside)
  const ends = new Set<number>([0, Math.round(d0 * 4) / 4, Math.round(inp.prevEndD * 4) / 4]);
  if (inp.intentD !== null) ends.add(Math.round(inp.intentD * 4) / 4);
  for (const o of inp.others) {
    const sO = o.s[Math.min(PLAN_STEPS - 1, 7)];
    const dO = o.n[Math.min(PLAN_STEPS - 1, 7)] - lineAt(sO);
    const gap = inp.halfWidM + o.halfWidM + 0.9;
    for (const side of [-1, 1]) {
      const e = Math.round((dO + side * gap) * 4) / 4;
      if (e >= loHere && e <= hiHere) ends.add(e);
    }
  }

  let best: PlannerResult | null = null;
  let bestBoxed: PlannerResult | null = null;
  let boxedHit = 0;
  const nArr = new Float64Array(PLAN_STEPS), sArr = new Float64Array(PLAN_STEPS), vArr = new Float64Array(PLAN_STEPS);
  const aimArr = new Float64Array(PLAN_STEPS);
  const dArr = new Float64Array(PLAN_STEPS + 1);

  for (const endD of ends) {
    for (const T of LAT_TIMES) {
      // Lateral profile (relative to the line) at each step
      dArr[0] = d0;
      for (let k = 1; k <= PLAN_STEPS; k++) dArr[k] = quintic(d0, d0Dot, endD, T, k * PLAN_DT);
      for (const scale of SPEED_SCALES) {
        // Longitudinal: from the current speed toward the path's limit (× scale, under the cap), accelerating and
        // braking within the car's limits
        let s = inp.s, v = inp.v, edge = 0, effort = 0, prox = 0, collided = false, firstHit = PLAN_STEPS + 1;
        for (let k = 1; k <= PLAN_STEPS; k++) {
          const dPrev = dArr[k - 1], d = dArr[k], dNext = dArr[Math.min(PLAN_STEPS, k + 1)];
          const ds = Math.max(0.5, v * PLAN_DT);
          // Path curvature: the line's own, tighter on the inside of its turn by the offset (radius R − d), plus the
          // offset's second derivative along s
          const kLine = sampleGrid(inp.lineKappa, s, t.ds);
          const dss = (dNext - 2 * d + dPrev) / (ds * ds);
          const kPath = kLine / Math.max(0.3, 1 - kLine * d) + dss;
          const vCornerLimit = Math.sqrt(inp.limits.lateral(v) / Math.max(1e-4, Math.abs(kPath)));
          // The line's envelope for the corners ahead, lowered where this path runs a tighter arc than the line (corner
          // speed goes with the square root of the radius)
          const tighter = Math.abs(kPath) > Math.abs(kLine) + 1e-4 ? Math.sqrt(Math.max(1e-4, Math.abs(kLine)) / Math.abs(kPath)) : 1;
          const vEnv = sampleGrid(inp.vLimit, s + ds, t.ds) * Math.max(0.6, tighter) * (1 - 0.005 * Math.abs(d));
          let vTarget = Math.min(inp.speedCapMs, (scale || 1) * Math.min(vCornerLimit, vEnv));
          if (scale === 0) {
            // Following: no faster than the car ahead in this lane allows, keeping a gap
            const L = t.lengthM;
            for (const o of inp.others) {
              const nHere = lineAt(s) + d;
              const dsO = ((o.s[k - 1] - s + 1.5 * L) % L) - L / 2;
              if (dsO <= 0 || dsO > 120 || Math.abs(o.n[k - 1] - nHere) > inp.halfWidM + o.halfWidM + 0.4) continue;
              const oPrev = k >= 2 ? o.s[k - 2] : o.s[0] - (o.s[1] - o.s[0]);
              const vO = Math.max(0, (((o.s[k - 1] - oPrev + 1.5 * L) % L) - L / 2) / PLAN_DT);
              const gapNeed = inp.halfLenM + o.halfLenM + FOLLOW_GAP_M + FOLLOW_GAP_S * vO;
              vTarget = Math.min(vTarget, Math.max(0, vO + 0.5 * (dsO - gapNeed)));
            }
          }
          aimArr[k - 1] = vTarget;
          const aUp = inp.limits.traction(v), aDown = inp.limits.braking(v);
          v = vTarget > v ? Math.min(vTarget, v + aUp * PLAN_DT) : Math.max(vTarget, v - aDown * PLAN_DT);
          s += 0.5 * (ds + v * PLAN_DT);
          // Kept on the usable road: a car off its line where the line swings toward an edge would otherwise be held
          // at an offset that runs it off (the clamp costs, so a path that needs it loses to one that doesn't)
          const lo = sampleGrid(inp.lo, s, t.ds), hi = sampleGrid(inp.hi, s, t.ds);
          const nRaw = lineAt(s) + d;
          const n = Math.min(hi, Math.max(lo, nRaw));
          nArr[k - 1] = n;
          sArr[k - 1] = s;
          vArr[k - 1] = v;
          edge += Math.abs(nRaw - n);
          effort += dss * dss * ds;
          // The other cars: overlap within the confidence horizon rules the candidate out; closeness costs later
          for (const o of inp.others) {
            const L = t.lengthM;
            const dsO = ((o.s[k - 1] - s + 1.5 * L) % L) - L / 2;
            const dn = o.n[k - 1] - n;
            // Clearance: half a metre across, a metre and a half along (no cutting back across a car's nose), more round
            // a stopped or spun car
            const marginN = o.hazard ? 1.0 : 0.5;
            const marginS = o.hazard ? 2.0 : 1.5;
            const overlapS = Math.abs(dsO) < inp.halfLenM + o.halfLenM + marginS;
            const overlapN = Math.abs(dn) < inp.halfWidM + o.halfWidM + marginN;
            // The rear car reacts to the leading one (TUM's rule for its IAC stack): only cars ahead (and hazards) are
            // hard obstacles; a car alongside or behind is the other driver's to avoid, and costs as closeness only
            // (braking with a car leaning on the rear quarter was what spun the car)
            if (overlapS && overlapN && k * PLAN_DT <= CONFIDENCE_S && (dsO > 0 || o.hazard)) {
              collided = true;
              firstHit = Math.min(firstHit, k);
            }
            prox += Math.exp(-((dsO / 8) ** 2) - (dn / 1.4) ** 2) * PLAN_DT;
          }
        }
        const progress = ((s - inp.s + 1.5 * t.lengthM) % t.lengthM) - 0.5 * t.lengthM;
        let lineDev = 0;
        for (let k = 1; k <= PLAN_STEPS; k++) lineDev += dArr[k] * dArr[k] * PLAN_DT;
        const cost =
          -w.progress * progress +
          (inp.intentD !== null ? w.intent * (endD - inp.intentD) ** 2 : 0) +
          w.line * lineDev +
          w.consistency * (endD - inp.prevEndD) ** 2 +
          w.proximity * prox +
          w.effort * effort +
          5 * edge;
        const res: PlannerResult = {
          endD,
          n: Float64Array.from(nArr),
          s: Float64Array.from(sArr),
          v: Float64Array.from(vArr),
          cost,
          boxedIn: collided,
          speedScale: scale,
          vAim: Float64Array.from(aimArr),
        };
        if (collided) {
          // Least bad if nothing is free: the one whose first contact comes latest (most time for the other car to move
          // and for this one to react), then the cheapest. The slowest one braked flat out mid-corner and spun the car
          const later = !bestBoxed || firstHit > boxedHit || (firstHit === boxedHit && cost < bestBoxed.cost);
          if (later) {
            bestBoxed = res;
            boxedHit = firstHit;
          }
          continue;
        }
        if (!best || cost < best.cost) best = res;
        // The fastest collision-free version of this lateral candidate is enough
        break;
      }
    }
  }
  if (best) return best;
  if (bestBoxed) return bestBoxed;
  // Nothing at all (off the road everywhere): hold the line, slowing
  const n = new Float64Array(PLAN_STEPS), s = new Float64Array(PLAN_STEPS), v = new Float64Array(PLAN_STEPS);
  for (let k = 1; k <= PLAN_STEPS; k++) {
    v[k - 1] = Math.max(0, inp.v - inp.limits.braking(inp.v) * 0.5 * k * PLAN_DT);
    s[k - 1] = inp.s + inp.v * k * PLAN_DT;
    n[k - 1] = lineAt(s[k - 1]);
  }
  return { endD: 0, n, s, v, cost: Infinity, boxedIn: true, speedScale: 0.9, vAim: Float64Array.from(v) };
}
