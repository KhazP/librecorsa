import type { BuiltTrackData } from '@/lib/track-data';

/**
 * 2026 Straight Mode: both flaps may open on every straight a circuit has. A circuit's data carries only the two or
 * three zones of its rear-flap years (they still place the Overtake detection point), so the rest are found here
 * from the circuit itself: a stretch of at least `STRAIGHT_MIN_M` where the line's curvature stays under
 * `STRAIGHT_MAX_CURVATURE`, short gentle kinks included (`STRAIGHT_KINK_MAX_M`).
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
/**
 * m: a bend this short between two straight pieces belongs to the straight when its radius stays at or over
 * `STRAIGHT_KINK_MIN_RADIUS_M` (VIR's back straight: 26 m at 520 m). A longer or tighter one (Le Mans' Mulsanne kink,
 * 300 m) still ends the straight, so the flaps stay shut through fast kinks (in 2026 the FIA dropped Albert Park's zone
 * through its fast Turn 9-10 esses on safety grounds)
 */
export const STRAIGHT_KINK_MAX_M = 100;
/** m: 1.4 g at 300 km/h [est] */
export const STRAIGHT_KINK_MIN_RADIUS_M = 500;

/**
 * m: how far before a stretch a 2026 car is told it is coming (`STRAIGHT_MODE_AHEAD`); nearer, as it leaves the
 * stretch before, when the corner between them is shorter (the Red Bull Ring's Turn 1: 140 m)
 */
export const STRAIGHT_NOTICE_M = 150;
/**
 * m: a press of the flap button this far before a stretch (or on it, while the flaps can't open yet) is kept and opens
 * the flaps once they may open there. The notice comes at `STRAIGHT_NOTICE_M`, so a press when it shows always counts
 */
export const FLAP_PRESS_REACH_M = 250;
/**
 * s: the longest a kept press waits, however slowly the car gets there (a spin, a stop). Room for a hairpin between
 * the press and the straight (the Red Bull Ring's Remus, at under 50 km/h)
 */
export const FLAP_PRESS_MAX_WAIT_S = 12;

export const inLapWindow = (p: number, start: number, end: number): boolean =>
  start <= end ? p >= start && p <= end : p >= start || p <= end;

const wrap01 = (x: number): number => ((x % 1) + 1) % 1;

/**
 * m: in Low Grip Conditions (2026; FIA Section B7.1.2 b) only the front flaps open, on Low Grip Activation Zones that
 * start later than the normal ones. The FIA's 2026 circuit maps give both for 25 zones at 9 events (Austria, Baku, Spa,
 * Silverstone, Hungary, Monza, Las Vegas, Miami, São Paulo): the Low Grip zone starts 30 to 70 m later (one at Spa
 * 300 m), 50 m at the median, and two zones have none. The game's stretches are its own, so each starts this much later
 */
export const LOW_GRIP_ZONE_DELAY_M = 50;

/** Whether lap fraction p is on a stretch started `delay` (lap fraction) later; on none shorter than that */
export const inDelayedLapWindow = (p: number, start: number, end: number, delay: number): boolean =>
  delay <= 0 ? inLapWindow(p, start, end) : wrap01(end - start) > delay && inLapWindow(p, wrap01(start + delay), end);

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
  const joined = joinAcrossKinks(track, out);
  cache.set(track, joined);
  return joined;
}

/** Two straights with a short gentle kink between them (`STRAIGHT_KINK_MAX_M`) are one */
function joinAcrossKinks(track: BuiltTrackData, windows: LapWindow[]): LapWindow[] {
  if (windows.length < 2) return windows;
  const lap = track.totalLengthM;
  const samples = track.samples;
  const gentle = (a: number, b: number): boolean => {
    // The gap's samples, from the end of one straight to the start of the next
    const gapM = wrap01(b - a) * lap;
    if (gapM > STRAIGHT_KINK_MAX_M) return false;
    const n = samples.length;
    const i0 = Math.round(a * n);
    const i1 = i0 + Math.round((gapM / lap) * n);
    for (let i = i0; i <= i1; i++) if (Math.abs(samples[i % n].curvature) > 1 / STRAIGHT_KINK_MIN_RADIUS_M) return false;
    return true;
  };
  const out = windows.map((w) => ({ ...w }));
  for (let i = 0; i < out.length && out.length > 1; ) {
    const next = (i + 1) % out.length;
    if (gentle(out[i].end, out[next].start)) {
      out[i] = { start: out[i].start, end: out[next].end };
      out.splice(next, 1);
      if (next < i) i--;
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Overlapping or touching stretches joined into one, in lap order from the line (a stretch over the line last, as
 * `start` > `end`)
 */
export function mergeLapWindows(windows: readonly LapWindow[]): LapWindow[] {
  // Unwrapped onto [0, 1]: a stretch over the line is two pieces
  const pieces: [number, number][] = [];
  for (const w of windows) {
    const a = wrap01(w.start);
    const b = w.end >= 1 ? 1 : wrap01(w.end);
    if (a <= b) pieces.push([a, b]);
    else pieces.push([a, 1], [0, b]);
  }
  pieces.sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of pieces) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1e-9) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  // One piece ending at the line and one starting there are a stretch over it
  if (merged.length > 1 && merged[0][0] <= 1e-9 && merged[merged.length - 1][1] >= 1 - 1e-9) {
    const head = merged.shift()!;
    merged[merged.length - 1] = [merged[merged.length - 1][0], head[1]];
  }
  return merged.map(([start, end]) => ({ start, end: end >= 1 ? 1 : end }));
}

/**
 * The stretch a flap press at lap fraction `p` is for: the one the car is on, else the nearest one starting within
 * `reachM` ahead. Null: none near enough
 */
export function lapWindowFor(
  p: number,
  windows: readonly LapWindow[],
  lapM: number,
  reachM: number
): { window: LapWindow; aheadM: number } | null {
  if (!Number.isFinite(p)) return null;
  let best: { window: LapWindow; aheadM: number } | null = null;
  for (const w of windows) {
    if (inLapWindow(p, w.start, w.end)) return { window: w, aheadM: 0 };
    const aheadM = wrap01(w.start - p) * lapM;
    if (aheadM <= reachM && (!best || aheadM < best.aheadM)) best = { window: w, aheadM };
  }
  return best;
}

const stretchCache = new WeakMap<BuiltTrackData, { zones: readonly LapWindow[]; count: number; list: LapWindow[] }>();

/**
 * Where a 2026 car's flaps may open: the circuit's own zones and its straights (`straightModeWindows`), joined, as
 * `VehiclePhysics` joins them for the player's car and the AI field alike
 */
export function straightModeStretches(track: BuiltTrackData, zones: readonly LapWindow[]): readonly LapWindow[] {
  const known = stretchCache.get(track);
  // The zones are the active circuit's array: refilled in place only for another circuit, which is another track
  if (known && known.zones === zones && known.count === zones.length) return known.list;
  const list = mergeLapWindows([...zones, ...straightModeWindows(track)]);
  stretchCache.set(track, { zones, count: zones.length, list });
  return list;
}
