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
 *   - A change of lap position no car can drive in one update (`isCourseHop`) that is not undone is a cut
 *     (`CourseCutWatch`): the lap under way does not count. Honest driving moves it at most ~25 m in an update (the
 *     frame's 0.25 s catch-up at 100 m/s); the projection hops to another part of the lap at a distance of about
 *     200 m (its search window) or more.
 *
 * No three.js: race control (track-limits.ts) uses this too.
 */

/** A lap position change past this in one update (m) is no driving: the car crossed to another part of the lap */
export const COURSE_HOP_M = 100;

/** `ds`: the change of lap position since the last update (m, wrapped to ±half a lap) */
export const isCourseHop = (ds: number): boolean => Math.abs(ds) > COURSE_HOP_M;

/** A jump round the lap that stands this long (s) is a cut; one undone sooner was a car between two parts of the lap */
export const COURSE_CUT_SETTLE_S = 1;

/**
 * Tells a cut from a car far off the road between two parts of the lap that lie close (Spielberg's inner lap, 12 m
 * past its edge after the line): there the lap position jumps there and back. Jumps add up; a cut is a jump ahead
 * that is not undone within `COURSE_CUT_SETTLE_S` (or by the line, `settle`). A jump back alone gains nothing.
 */
export class CourseCutWatch {
  /** The jumps not yet settled, summed (m, + ahead), and how long since the last one (s) */
  private pendingM = 0;
  private sinceS = 0;

  reset(): void {
    this.pendingM = 0;
    this.sinceS = 0;
  }

  /** One update: `ds` the change of lap position (m, wrapped), `dtS` the time it took. True when a cut settles */
  update(ds: number, dtS: number): boolean {
    if (isCourseHop(ds)) {
      this.pendingM += ds;
      this.sinceS = 0;
      if (!isCourseHop(this.pendingM)) this.pendingM = 0;
      return false;
    }
    if (this.pendingM === 0) return false;
    this.sinceS += dtS;
    return this.sinceS >= COURSE_CUT_SETTLE_S && this.settle();
  }

  /** Settles what is pending now (at the line): true if it is a jump ahead */
  settle(): boolean {
    const cut = this.pendingM > COURSE_HOP_M;
    this.reset();
    return cut;
  }
}

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
