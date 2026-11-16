/**
 * What an AI car is asked to drive: a lateral offset and a speed per AI grid point (`ai-track.ts`), with the path's
 * own curvature for the steering feed-forward. The autopilots track it as given (they no longer re-derive a path and
 * a speed plan of their own); the line and the speeds come from the line generator and `planSpeeds`, later from the
 * local planner.
 */
import type { AiTrack, PathGeometry } from './ai-track';
import { pathGeometry } from './ai-track';
import type { CarLimits } from './ggv';
import { planSpeedsJob } from './speed-plan';

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

/** What a plan takes from its line alone, the same for every plan on it: the offsets, the path's geometry and dn/ds */
export interface DriveLine {
  readonly n: Float64Array;
  readonly geometry: PathGeometry;
  readonly dnds: Float64Array;
}

export function driveLineOf(track: AiTrack, offsets: ArrayLike<number>): DriveLine {
  const n = Float64Array.from(offsets);
  const dnds = new Float64Array(track.n);
  for (let i = 0; i < track.n; i++) {
    const a = n[(i - 1 + track.n) % track.n], b = n[(i + 1) % track.n];
    dnds[i] = (b - a) / (2 * track.ds);
  }
  return { n, geometry: pathGeometry(track, n), dnds };
}

export function makeDrivePlan(track: AiTrack, offsets: ArrayLike<number> | DriveLine, limits: CarLimits): AiDrivePlan {
  const job = drivePlanJob(track, 'geometry' in offsets ? offsets : driveLineOf(track, offsets), limits);
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/**
 * `makeDrivePlan` a slice at a time (`planSpeedsJob`): pauses about every `quantum` work units, and run to the end
 * returns the same plan. The plan shares the line's arrays, which no one writes to
 */
export function* drivePlanJob(track: AiTrack, line: DriveLine, limits: CarLimits, quantum = Infinity): Generator<number, AiDrivePlan, void> {
  const plan = yield* planSpeedsJob(track, line.n, limits, line.geometry, true, quantum);
  return { track, n: line.n, v: plan.vLimit, vOpen: plan.vOpen ?? plan.vLimit, vExpected: plan.v, kappa: plan.geometry.kappa, dnds: line.dnds, limits, lapS: plan.lapS };
}
