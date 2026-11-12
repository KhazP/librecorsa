/**
 * What an AI car is asked to drive: a lateral offset and a speed per AI grid point (`ai-track.ts`), with the path's
 * own curvature for the steering feed-forward. The autopilots track it as given (they no longer re-derive a path and
 * a speed plan of their own); the line and the speeds come from the line generator and `planSpeeds`, later from the
 * local planner.
 */
import type { AiTrack } from './ai-track';
import { pathGeometry } from './ai-track';
import type { CarLimits } from './ggv';
import { planSpeeds } from './speed-plan';

export interface AiDrivePlan {
  readonly track: AiTrack;
  /**
   * Lateral offset (m, + right), the speed the car may carry (m/s: the cornering and braking limit; it accelerates as
   * hard as it can toward it), path curvature (1/m, + right) and dn/ds per grid point
   */
  readonly n: Float64Array;
  readonly v: Float64Array;
  /**
   * `v` with no top speed in it (`SpeedPlan.vOpen`): the corners and braking zones are its only limits. Where the two
   * differ, `v` is the car's level-ground top speed, which a car in a tow goes beyond
   */
  readonly vOpen: Float64Array;
  /** The full plan's speeds, traction included (what the lap is expected to look like) */
  readonly vExpected: Float64Array;
  readonly kappa: Float64Array;
  readonly dnds: Float64Array;
  /** The limits the speeds were planned on (the tracker's pedal feed-forward reads them) */
  readonly limits: CarLimits;
  readonly lapS: number;
}

export function makeDrivePlan(track: AiTrack, offsets: ArrayLike<number>, limits: CarLimits): AiDrivePlan {
  const n = Float64Array.from(offsets);
  const plan = planSpeeds(track, n, limits, undefined, true);
  const dnds = new Float64Array(track.n);
  for (let i = 0; i < track.n; i++) {
    const a = n[(i - 1 + track.n) % track.n], b = n[(i + 1) % track.n];
    dnds[i] = (b - a) / (2 * track.ds);
  }
  return { track, n, v: plan.vLimit, vOpen: plan.vOpen ?? plan.vLimit, vExpected: plan.v, kappa: plan.geometry.kappa, dnds, limits, lapS: plan.lapS };
}
