/**
 * The course a lap has to follow, where the paved ground offers another.
 *
 * Some circuits lay two layouts over one model (RISE Motordrome: the Grand Prix lap and the short lap). Each lap's
 * track data runs along its own road, but the other layout's road is asphalt too, so a car on it reads as on the track,
 * and where it leaves the lap far enough the car's position along the lap (`projectWorldToTrack`) jumps across the
 * stretch it skipped: the short lap's link road on the Grand Prix lap puts the car 685 m further round in one frame.
 *
 * Two rules close that:
 *   - In the stretches a layout lists in `otherLayoutRoads` (its track data), the lap's own road edge, with its kerbs,
 *     is the track limit, whatever is paved beyond: a wheel past it is off the track.
 *   - A change of lap position no car can drive in one update is a cut (`isCourseHop`): the lap under way does not
 *     count. Honest driving moves it at most ~25 m in an update (the frame's 0.25 s catch-up at 100 m/s); the
 *     projection hops to another part of the lap at a distance of about 200 m (its search window) or more.
 *
 * No three.js: race control (track-limits.ts) uses this too.
 */

/** A lap position change past this in one update (m) is no driving: the car crossed to another part of the lap */
export const COURSE_HOP_M = 100;

/** `ds`: the change of lap position since the last update (m, wrapped to ±half a lap) */
export const isCourseHop = (ds: number): boolean => Math.abs(ds) > COURSE_HOP_M;

/** Kerb width beyond the asphalt edge where a sample has a kerb (m), and the slack past it before a wheel is off (m) */
export const LAYOUT_KERB_M = 1.5;
export const LAYOUT_EDGE_SLACK_M = 0.3;

/** Stretches of a lap, [from, to] in m of lap distance (from > to wraps over the line) */
export type LapStretches = readonly (readonly [number, number])[];

/** Is lap distance `s` inside one of the stretches? */
export function inLapStretch(stretches: LapStretches | undefined, s: number, lapLengthM: number): boolean {
  if (!stretches) return false;
  const x = ((s % lapLengthM) + lapLengthM) % lapLengthM;
  for (const [a, b] of stretches) {
    if (a <= b ? x >= a && x <= b : x >= a || x <= b) return true;
  }
  return false;
}

interface Vec2Like {
  x: number;
  z: number;
}

/** The sample fields the edge test reads */
export interface LayoutEdgeSample {
  position: Vec2Like;
  binormal: Vec2Like;
  width: number;
  kerbLeft: boolean;
  kerbRight: boolean;
}

/** Is world point x, z past the lap's own road edge (and its kerb), at the sample the car is at? */
export function beyondLayoutEdge(sample: LayoutEdgeSample, x: number, z: number): boolean {
  const bl = Math.hypot(sample.binormal.x, sample.binormal.z) || 1;
  // Signed offset across the road (m, + right)
  const lat = ((x - sample.position.x) * sample.binormal.x + (z - sample.position.z) * sample.binormal.z) / bl;
  const half = sample.width / 2 + LAYOUT_EDGE_SLACK_M;
  return lat >= 0 ? lat > half + (sample.kerbRight ? LAYOUT_KERB_M : 0) : -lat > half + (sample.kerbLeft ? LAYOUT_KERB_M : 0);
}
