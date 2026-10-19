import type { CarTelemetry } from "@/types/f1";

/** Distance resolution of the lap traces (m) */
const BUCKET_M = 10;

type LapSample = Pick<CarTelemetry, "lapCount" | "lastLapTimeMs" | "bestLapTimeMs" | "trackDistanceM" | "currentLapTimeMs">;

/**
 * Live delta to the best lap of this session: the lap time is recorded every 10 m of the current
 * lap and compared with the best lap's trace at the same distance.
 */
export class LapDeltaTracker {
  private readonly current: Float64Array;
  private best: Float64Array | null = null;
  private lap: number | null = null;
  private lastBucket = -1;

  constructor(trackLengthM: number) {
    this.current = new Float64Array(Math.ceil(trackLengthM / BUCKET_M) + 1).fill(Number.NaN);
  }

  /** Records the current lap's trace */
  update(t: LapSample): void {
    const cur = this.current;
    if (this.lap === null) this.lap = t.lapCount;
    if (t.lapCount !== this.lap) {
      // Lap completed: keep its trace when it is the new best and was recorded all the way round
      const lap = t.lastLapTimeMs;
      let filled = 0;
      for (let i = 0; i < cur.length; i++) if (!Number.isNaN(cur[i])) filled++;
      if (lap !== null && lap === t.bestLapTimeMs && filled > cur.length * 0.9) {
        this.best = Float64Array.from(cur);
      }
      cur.fill(Number.NaN);
      this.lap = t.lapCount;
      this.lastBucket = -1;
    }
    const b = Math.floor(t.trackDistanceM / BUCKET_M);
    if (b < 0 || b >= cur.length) return;
    // Fill the buckets passed since the last update (updates come every few metres at speed)
    const from = this.lastBucket >= 0 && this.lastBucket < b ? this.lastBucket + 1 : b;
    for (let i = from; i <= b; i++) if (Number.isNaN(cur[i])) cur[i] = t.currentLapTimeMs;
    this.lastBucket = b;
  }

  /** Delta to the best lap (s, + = slower), or null until a complete lap has been timed */
  delta(t: Pick<CarTelemetry, "trackDistanceM" | "currentLapTimeMs">): number | null {
    const ref = this.referenceTimeMs(t.trackDistanceM);
    if (ref === null || t.currentLapTimeMs <= 0) return null;
    return (t.currentLapTimeMs - ref) / 1000;
  }

  /** Time into the best lap at a distance (ms, interpolated between the 10 m buckets), or null without one */
  referenceTimeMs(distM: number): number | null {
    const best = this.best;
    if (!best) return null;
    const f = distM / BUCKET_M;
    const i = Math.floor(f);
    const a = best[i];
    if (a === undefined || Number.isNaN(a)) return null;
    const b = best[i + 1];
    return b === undefined || Number.isNaN(b) ? a : a + (b - a) * (f - i);
  }

  /** Best-lap time between two lap distances (s, wrapping over the line), or null without a reference */
  referenceGapS(fromM: number, toM: number, lapLengthM: number): number | null {
    const a = this.referenceTimeMs(fromM);
    const b = this.referenceTimeMs(toM);
    if (a === null || b === null) return null;
    const lap = this.referenceTimeMs(lapLengthM - 1);
    let d = b - a;
    if (toM < fromM && lap !== null) d += lap;
    return d / 1000;
  }

  get hasReference(): boolean {
    return this.best !== null;
  }
}
