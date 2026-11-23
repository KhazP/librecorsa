/**
 * When the live mirrors (the virtual mirror strip and the cockpit's wing mirrors) render the rear view again: every
 * second drawn frame while the game draws fast enough for that to look smooth (30 times a second at 60 fps, 60 at
 * 120 Hz, 72 at 144 Hz), and every drawn frame once it runs slower (40 at 40 fps, 30 under the 30 fps cap). Counted in
 * frames alone, a 40 fps machine had a 20 Hz mirror, and Low's every fourth frame showed 7-10 Hz at 30-40 fps (#186).
 *
 * Decided from the drawn frames' average interval, with a band between the two cadences: a frame rate at the edge
 * (45 fps) would otherwise flip between them, an uneven mirror that reads as a stutter of its own.
 */

/** Average drawn-frame interval (ms) above which the mirrors render every frame: under about 42.5 fps */
export const EVERY_FRAME_ABOVE_MS = 23.5;
/** ... and below which they go back to every second frame: over about 49 fps */
export const EVERY_OTHER_BELOW_MS = 20.5;
/** Each drawn frame's weight in the average (about 20 frames' memory) */
const AVG_WEIGHT = 0.05;
/** A hitch counts as this long at most (ms): one GC pause should not switch the cadence */
const MAX_SAMPLE_MS = 50;

export class MirrorClock {
  private avgMs = 1000 / 60;
  private everyFrame = false;
  private renderedLast = false;

  /** Whether the mirrors render on every drawn frame now (else every second one) */
  get rendersEveryFrame(): boolean {
    return this.everyFrame;
  }

  /** A drawn frame, `intervalMs` after the previous drawn one (0 or less: unknown): whether the mirrors render on it */
  tick(intervalMs: number): boolean {
    if (intervalMs > 0) this.avgMs += (Math.min(intervalMs, MAX_SAMPLE_MS) - this.avgMs) * AVG_WEIGHT;
    if (this.everyFrame ? this.avgMs < EVERY_OTHER_BELOW_MS : this.avgMs > EVERY_FRAME_ABOVE_MS) this.everyFrame = !this.everyFrame;
    const render = this.everyFrame || !this.renderedLast;
    this.renderedLast = render;
    return render;
  }
}
