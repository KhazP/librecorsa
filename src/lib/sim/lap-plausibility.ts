/**
 * Consistency checks of an uploaded lap's samples, beyond their shape: the lap closes on itself, and the recorded
 * speed, the distance along the track and the distance driven between positions all tell the same story.
 *
 * Autopilot laps of Rwanda agree to about 0.3 % on both; the limits leave room for spins and wet laps.
 *
 * A heuristic, not proof: a lap built by a careful forger passes. What it stops is the cheap fake (a short lap time
 * pasted onto a real recording, a scaled time axis, invented samples). The online board runs this same function
 * on every upload (cloudflare/api/lap-check.ts).
 */
import { LAP_SAMPLE_STRIDE } from "./lap-types";

/** The first and last samples are both at the line; further apart than this (m), the lap is not closed */
export const MAX_LAP_GAP_M = 150;
/** Distance from the speed channel vs from the positions: allowed mismatch (share of the lap, plus a margin in m) */
export const MAX_SPEED_PATH_MISMATCH = 0.03;
export const SPEED_PATH_MARGIN_M = 50;
/** Distance driven vs the track-distance channel: allowed mismatch (racing line vs centreline, plus a margin in m) */
export const MAX_TRACK_PATH_MISMATCH = 0.06;
export const TRACK_PATH_MARGIN_M = 100;

/** Null when the samples are consistent, else the reason they are not. `data` is the flattened LapRecording.data */
export function lapPlausibilityProblem(data: readonly number[]): string | null {
  const S = LAP_SAMPLE_STRIDE;
  const n = Math.floor(data.length / S);
  if (n < 2) return "Recording has too few samples";

  const last = (n - 1) * S;
  const gap = Math.hypot(data[last + 2] - data[2], data[last + 3] - data[3], data[last + 4] - data[4]);
  if (gap > MAX_LAP_GAP_M) return "The lap does not end where it started";

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
  return null;
}
