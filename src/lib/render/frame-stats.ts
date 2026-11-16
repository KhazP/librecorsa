import { percentile } from "./adaptive-quality";

/**
 * The frame rate of the last minute of driving, always on, for bug reports: players who report lag (issues #111,
 * #116) were asked to reload with `?perf=1` and drive again; the report now carries the numbers itself.
 *
 * Only frames drawn while driving count, the frames the automatic quality judges: not the pause menu (the scene keeps
 * drawing under it), the title menu, a replay or a hidden tab. "The last minute" is a minute of driving, so a long
 * pause before the report does not water it down; the module keeps it for the page, so a report written from the
 * title menu after a drive still has it. A gap longer than 2 s (a hidden tab, the debugger) is not a frame.
 */

/** Seconds of driving summed up */
const WINDOW_S = 60;
/** Intervals kept: a minute at 240 Hz */
const CAPACITY = 14_400;
/** A longer gap is not a frame (a hidden tab, a debugger stop) */
const MAX_INTERVAL_MS = 2000;
/** A drawn frame this long is a long frame */
const LONG_FRAME_MS = 50;

export interface FrameSummary {
  /** Seconds of driving the numbers cover (at most a minute) */
  seconds: number;
  fps: number;
  /** Typical and 95th-percentile time between drawn frames (ms) */
  p50Ms: number;
  p95Ms: number;
  /** Drawn frames over 50 ms */
  longFrames: number;
  /** Seconds since the last frame counted (a report from the menus some time after the drive) */
  agoS: number;
  /** The graphics as the frames were drawn: preset, resolution, frame cap, what the automatic quality lowered */
  graphics: string | null;
}

const intervals = new Float32Array(CAPACITY);
let count = 0;
let next = 0;
let lastAtMs = -1;
let graphics: string | null = null;

/** A frame drawn while driving, `intervalMs` after the one before it */
export function noteDrivingFrame(intervalMs: number, nowMs: number = performance.now()): void {
  if (!(intervalMs > 0) || intervalMs > MAX_INTERVAL_MS) return;
  intervals[next] = intervalMs;
  next = (next + 1) % CAPACITY;
  count = Math.min(count + 1, CAPACITY);
  lastAtMs = nowMs;
}

/** The graphics the frames are drawn with, kept beside them */
export function noteFrameGraphics(line: string): void {
  graphics = line;
}

/** The last minute of driving, or null before any */
export function drivingFrameSummary(nowMs: number = performance.now()): FrameSummary | null {
  if (count === 0) return null;
  const window: number[] = [];
  let totalMs = 0;
  for (let i = 1; i <= count && totalMs < WINDOW_S * 1000; i++) {
    const ms = intervals[(next - i + CAPACITY) % CAPACITY];
    window.push(ms);
    totalMs += ms;
  }
  const sorted = [...window].sort((a, b) => a - b);
  return {
    seconds: totalMs / 1000,
    fps: (window.length * 1000) / totalMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    longFrames: window.filter((ms) => ms > LONG_FRAME_MS).length,
    agoS: Math.max(0, (nowMs - lastAtMs) / 1000),
    graphics,
  };
}

/** Forgets the frames (scripts/verify-report-details.ts) */
export function resetFrameStats(): void {
  count = 0;
  next = 0;
  lastAtMs = -1;
  graphics = null;
}
