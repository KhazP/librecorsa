/**
 * The course a lap has to follow.
 *
 * Where a car leaves the lap's road far enough (onto another layout's road laid over the same model: RISE Motordrome's
 * Grand Prix and short laps), its position along the lap (`projectWorldToTrack`) jumps across the stretch it skipped:
 * the short lap's link road on the Grand Prix lap puts the car 685 m further round in one frame. A change of lap
 * position no car can drive in one update is a cut (`isCourseHop`): the lap under way does not count. Honest driving
 * moves it at most ~25 m in an update (the frame's 0.25 s catch-up at 100 m/s); the projection hops to another part of
 * the lap at a distance of about 200 m (its search window) or more.
 *
 * No three.js: race control (track-limits.ts) uses this too.
 */

/** A lap position change past this in one update (m) is no driving: the car crossed to another part of the lap */
export const COURSE_HOP_M = 100;

/** `ds`: the change of lap position since the last update (m, wrapped to ±half a lap) */
export const isCourseHop = (ds: number): boolean => Math.abs(ds) > COURSE_HOP_M;
