import type { BuiltTrackData } from '@/lib/track-data';

/**
 * 2026 Straight Mode: both flaps may open on every straight a circuit has. A circuit's data carries only the two or
 * three zones of its rear-flap years (they still place the Overtake detection point), so the rest are found here
 * from the circuit itself: a stretch of at least `STRAIGHT_MIN_M` where the line's curvature stays under
 * `STRAIGHT_MAX_CURVATURE`.
 */

/** A stretch of the lap as lap fractions; `start` > `end` when it runs over the line */
export interface LapWindow {
  start: number;
  end: number;
}

/** 1/m: a radius of 800 m, 0.9 g at 300 km/h with the flaps open [est] */
export const STRAIGHT_MAX_CURVATURE = 1 / 800;
/** m: three seconds at 300 km/h [est] */
export const STRAIGHT_MIN_M = 250;

export const inLapWindow = (p: number, start: number, end: number): boolean =>
  start <= end ? p >= start && p <= end : p >= start || p <= end;

const cache = new WeakMap<BuiltTrackData, LapWindow[]>();

/** The circuit's straights, in lap order from the first corner after the line */
export function straightModeWindows(track: BuiltTrackData): readonly LapWindow[] {
  const known = cache.get(track);
  if (known) return known;
  const samples = track.samples;
  const n = samples.length;
  const lap = track.totalLengthM;
  const straight = samples.map((s) => Math.abs(s.curvature) <= STRAIGHT_MAX_CURVATURE);
  const out: LapWindow[] = [];
  const first = straight.indexOf(false);
  if (first < 0) {
    // No corner at all: the whole lap
    if (n > 0) out.push({ start: 0, end: 1 });
  } else {
    // From a corner sample, so a straight over the line is one run
    for (let q = 1; q <= n; ) {
      if (!straight[(first + q) % n]) {
        q++;
        continue;
      }
      const from = q;
      while (q <= n && straight[(first + q) % n]) q++;
      const a = samples[(first + from) % n].s;
      const b = samples[(first + q - 1) % n].s;
      const length = b >= a ? b - a : b - a + lap;
      if (length >= STRAIGHT_MIN_M) out.push({ start: a / lap, end: b / lap });
    }
  }
  cache.set(track, out);
  return out;
}
