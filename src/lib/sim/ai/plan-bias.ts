/**
 * How the field moves a car on a drive plan off its line (the traffic bias), for the cars that track plans their own way
 * (`plan-tracking.ts`: the road, classic and prototype cars): with a lateral acceleration its tyres have to spare, not
 * only at a rate.
 *
 * The field moves a car across the road at 2.2 m/s (3.2 to pull out of a tow, 4-5 to give room or pass a hazard), the
 * move starting and stopping at once. A car on a plan tracks the moved target with a pure pursuit 0.4 s ahead, which
 * brings it across within ~0.2 s: ~10 m/s² for the step to 2.2 m/s, over the whole grip of a road car (the Liana has
 * 8 m/s², the F1 cars 21-34). At RISE short the Liana field on plans spun 22 times in 3 races (its own driver 0), most in
 * the 150 km/h kink before Turn 1 where its plan already asks ~6.3 of its 7.8 m/s², on a pass or a give-room move
 * started or reversed there.
 */

/**
 * One step of the bias toward `goal` (m) at no more than `rateMs` (m/s) and with no more than `accelMs2` (m/s²) of
 * lateral acceleration: it gathers speed across the road and eases off to arrive at the goal at rest. With an endless
 * acceleration it is the plain rate limit
 */
export function stepBias(bias: number, vel: number, goal: number, rateMs: number, accelMs2: number, dt: number): { bias: number; vel: number } {
  if (!Number.isFinite(accelMs2)) {
    const step = Math.max(-rateMs * dt, Math.min(rateMs * dt, goal - bias));
    return { bias: bias + step, vel: dt > 0 ? step / dt : 0 };
  }
  const e = goal - bias;
  // At the goal and slow enough to stop within the step: there, at rest
  if (Math.abs(e) < 1e-6 && Math.abs(vel) <= accelMs2 * dt) return { bias: goal, vel: 0 };
  // The lateral speed that still comes to rest at the goal braking at `accelMs2` (from where this step leaves it), no
  // faster than the rate, nor past the goal in one step
  const room = Math.max(0, Math.abs(e) - Math.abs(vel) * dt);
  const want = Math.sign(e) * Math.min(rateMs, Math.sqrt(2 * accelMs2 * room), Math.abs(e) / dt);
  const v = vel + Math.max(-accelMs2 * dt, Math.min(accelMs2 * dt, want - vel));
  return { bias: bias + v * dt, vel: v };
}

/**
 * The lateral acceleration (m/s²) a bias move may use: the plan's lateral limit at this speed (`latLimitMs2`, at the
 * plan's grip) less what the path ahead already takes (`speedMs`² × the tightest |curvature| `kappaPath`), within
 * [`floorMs2`, `share` × the limit]. On a straight a car moves across briskly; on its limit in a corner it holds its
 * offset, as a driver at the limit can only run wide or tighten the line by giving speed away
 */
export function biasAccelMs2(latLimitMs2: number, speedMs: number, kappaPath: number, share: number, floorMs2: number): number {
  const margin = latLimitMs2 - speedMs * speedMs * Math.abs(kappaPath);
  return Math.max(floorMs2, Math.min(share * latLimitMs2, margin));
}

/** The field's mark for a corner (1/m of centreline curvature): its rules limit the room off the line from here */
export const FIELD_CORNER_K = 0.006;

/**
 * The curvature (1/m, + right) that is as much of a corner for the field's rules as a stretch of a car's plan is for the
 * car: the plan path's lateral acceleration (`kPlan` at the plan's expected speed `vMs`) as a share of its lateral limit,
 * `FIELD_CORNER_K` at `share`; the centreline's own `kc` where that is more. The field's marks (0.006 and 0.012 1/m) are
 * an F1 car's: RISE short's 147 km/h sweep (0.004 1/m) is a straight to them, where a 5 m pass to the outside on a 12 m
 * road took a Liana, whose plan already uses ~80 % of its grip there, over the edge
 */
export function ownCornerK(kc: number, kPlan: number, vMs: number, latLimitMs2: number, share: number): number {
  const k = (FIELD_CORNER_K * vMs * vMs * Math.abs(kPlan)) / (share * latLimitMs2);
  return k > Math.abs(kc) ? (Math.sign(Math.abs(kc) > 1e-4 ? kc : kPlan) || 1) * k : kc;
}
