/**
 * Consistency checks of an uploaded lap's samples, beyond their shape: the lap closes on itself (but on a
 * point-to-point course, a hill climb), and the recorded speed, the distance along the track and the distance driven
 * between positions all tell the same story.
 *
 * Autopilot laps of Rwanda agree to about 0.3 % on both; the limits leave room for spins and wet laps.
 *
 * A heuristic, not proof: a lap built by a careful forger passes. What it stops is the cheap fake (a short lap time
 * pasted onto a real recording, a scaled time axis, invented samples) and a car that gains speed faster than it can.
 * The online board runs this same function on every upload (cloudflare/api/lap-check.ts).
 */
import type { VehicleModelId } from "@/types/f1";
import { LAP_SAMPLE_STRIDE } from "./lap-types";

/** The first and last samples are both at the line; further apart than this (m), the lap is not closed */
export const MAX_LAP_GAP_M = 150;
/**
 * Fastest start-line crossing speed (km/h) for a point-to-point standing-start run (#191): launching full-throttle
 * from the back of the 10 m standing-start box puts the 2026 F1 car at ~55 km/h across the line (~66 km/h after the
 * 250 ms start-grace window), while reversing down the run-up for a flying start puts GT3s > 100 km/h and F1 > 130 km/h
 */
export const MAX_OPEN_START_KMH = 80;
/** Distance from the speed channel vs from the positions: allowed mismatch (share of the lap, plus a margin in m) */
export const MAX_SPEED_PATH_MISMATCH = 0.03;
export const SPEED_PATH_MARGIN_M = 50;
/** Distance driven vs the track-distance channel: allowed mismatch (racing line vs centreline, plus a margin in m) */
export const MAX_TRACK_PATH_MISMATCH = 0.06;
export const TRACK_PATH_MARGIN_M = 100;
/**
 * Sustained acceleration (`sustainedAccelG`): how fast the car gains speed, in g, over a stretch of the lap, read
 * twice: from the recorded speed (median of `ACCEL_MEDIAN_SAMPLES` samples, so one glitched sample can't move it)
 * over `ACCEL_SPEED_WINDOW_S`, and from the positions (distance driven over `ACCEL_POSITION_SPAN_S`, steady against
 * jittery sample times) over `ACCEL_POSITION_WINDOW_S`. A lap's figure is its `ACCEL_RANK`-th best stretch, the
 * stretches at least `ACCEL_SEPARATION_S` apart: a car that gains speed too fast at corner exit after corner exit, not
 * one crash or kerb strike that throws it forward. How fast the car is going doesn't count, only how fast it gains
 * speed, so a flying lap crossing the line at 260 km/h is no different from one starting slow.
 */
export const ACCEL_MEDIAN_SAMPLES = 5;
export const ACCEL_SPEED_WINDOW_S = 1;
export const ACCEL_POSITION_SPAN_S = 0.8;
export const ACCEL_POSITION_WINDOW_S = 1.5;
export const ACCEL_RANK = 3;
export const ACCEL_SEPARATION_S = 3;
/**
 * Most sustained acceleration (g) each car can show on a board lap, about 30 % over the most its honest laps show.
 * Measured on 27 Nov 2026 over the top 25 laps of every live board (2,484 laps; hill-climb standing starts and wet
 * laps among them): the LC26's most was 1.44 g against 3.57 g for a lap gaining 13 to 162 km/h in a second, the GT3's
 * 0.83 g against 1.63 and 2.04 g. Cars with no board laps then (the LC25, the F1 Teams car, the F1 2007 and the
 * LC-LMDh) take the LC26's limit, the most of any car. Measure again when a car's power or grip changes.
 */
export const MAX_SUSTAINED_ACCEL_G: Readonly<Record<VehicleModelId, number>> = {
  lc26: 1.9,
  lc25: 1.9,
  "f12026-car": 1.9,
  "f1-2007": 1.9,
  "lc-lmdh": 1.9,
  "amg-gt3": 1.1,
  "mtr-496r": 1.3,
  "nissan-r33-jgtc": 1.2,
  "nissan-r32-jtcc": 1.0,
  "bmw-m1-procar": 1.2,
  "porsche-934-rsr": 1.0,
  "chaparral-2d": 0.9,
  "chaparral-2d-67": 1.1,
  liana: 0.6,
  "vw-scirocco-gtx": 0.7,
};

/** The `ACCEL_RANK`-th best gain of `v` (m/s) over `windowS`, its stretches `ACCEL_SEPARATION_S` apart (g) */
function rankedGainG(t: ArrayLike<number>, v: ArrayLike<number>, windowS: number): number {
  const n = t.length;
  const gains: { g: number; t: number }[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n - 1 && t[j] - t[i] < windowS) j++;
    const dt = t[j] - t[i];
    if (dt < windowS) break;
    gains.push({ g: (v[j] - v[i]) / dt / 9.81, t: t[i] });
  }
  gains.sort((a, b) => b.g - a.g);
  const picked: number[] = [];
  for (const w of gains) {
    if (picked.every((p) => Math.abs(w.t - p) >= ACCEL_SEPARATION_S)) picked.push(w.t);
    if (picked.length === ACCEL_RANK) return w.g;
  }
  return 0;
}

/** A lap's sustained acceleration (g), the larger of its recorded-speed and position readings; 0 when too short */
export function sustainedAccelG(data: readonly number[]): number {
  const S = LAP_SAMPLE_STRIDE;
  const n = Math.floor(data.length / S);
  if (n < 2) return 0;
  const t = new Float64Array(n);
  const raw = new Float64Array(n);
  const cum = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * S;
    t[i] = data[o];
    raw[i] = data[o + 9] / 3.6;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(data[o + 2] - data[o - S + 2], data[o + 3] - data[o - S + 3], data[o + 4] - data[o - S + 4]);
  }
  // Recorded speed, each sample the median of those around it
  const half = Math.floor(ACCEL_MEDIAN_SAMPLES / 2);
  const speed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const near = Array.from(raw.subarray(Math.max(0, i - half), Math.min(n, i + half + 1))).sort((a, b) => a - b);
    const m = near.length >> 1;
    speed[i] = near.length % 2 ? near[m] : (near[m - 1] + near[m]) / 2;
  }
  // Speed from the positions: distance driven over the span around each sample
  const reach = ACCEL_POSITION_SPAN_S / 2;
  const driven = new Float64Array(n);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < i && t[i] - t[lo] > reach) lo++;
    while (hi < n - 1 && t[hi] - t[i] < reach) hi++;
    const dt = t[hi] - t[lo];
    driven[i] = dt > 0 ? (cum[hi] - cum[lo]) / dt : 0;
  }
  return Math.max(rankedGainG(t, speed, ACCEL_SPEED_WINDOW_S), rankedGainG(t, driven, ACCEL_POSITION_WINDOW_S));
}

/**
 * Null when the samples are consistent, else the reason they are not. `data` is the flattened LapRecording.data;
 * `open`: a point-to-point course's run, which ends at a finish line away from its start (track-kinds.ts);
 * `vehicle`: the car it was driven in, whose acceleration it must not beat (`MAX_SUSTAINED_ACCEL_G`)
 */
export function lapPlausibilityProblem(
  data: readonly number[],
  opts: { open?: boolean; vehicle?: VehicleModelId } = {}
): string | null {
  const S = LAP_SAMPLE_STRIDE;
  const n = Math.floor(data.length / S);
  if (n < 2) return "Recording has too few samples";

  const last = (n - 1) * S;
  const gap = Math.hypot(data[last + 2] - data[2], data[last + 3] - data[3], data[last + 4] - data[4]);
  if (!opts.open && gap > MAX_LAP_GAP_M) return "The lap does not end where it started";
  if (opts.open && data[9] > MAX_OPEN_START_KMH) return "A point-to-point run must begin from a standing start";

  let path = 0;
  let speedPath = 0;
  let maxS = 0;
  for (let i = 0; i < n; i++) {
    const o = i * S;
    maxS = Math.max(maxS, data[o + 1]);
    if (i === 0) continue;
    const p = o - S;
    const dt = data[o] - data[p];
    path += Math.hypot(data[o + 2] - data[p + 2], data[o + 3] - data[p + 3], data[o + 4] - data[p + 4]);
    speedPath += ((data[o + 9] + data[p + 9]) / 2 / 3.6) * dt;
  }
  if (Math.abs(path - speedPath) > MAX_SPEED_PATH_MISMATCH * path + SPEED_PATH_MARGIN_M) {
    return "Recorded speeds do not match the distance driven";
  }
  // The track distance runs from the line to (nearly) the lap length; the car drives about that far
  if (Math.abs(path - maxS) > MAX_TRACK_PATH_MISMATCH * path + TRACK_PATH_MARGIN_M) {
    return "Distance driven does not match the lap length";
  }
  if (opts.vehicle && sustainedAccelG(data) > MAX_SUSTAINED_ACCEL_G[opts.vehicle]) {
    return "The car gains speed faster than it can";
  }
  return null;
}
