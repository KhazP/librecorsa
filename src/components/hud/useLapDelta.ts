"use client";

import { useEffect, useRef } from "react";
import type { CarTelemetry } from "@/types/f1";

/** Distance resolution of the lap traces (m) */
const BUCKET_M = 10;

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
  update(t: CarTelemetry): void {
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
  delta(t: CarTelemetry): number | null {
    const best = this.best;
    if (!best) return null;
    const ref = best[Math.floor(t.trackDistanceM / BUCKET_M)];
    if (ref === undefined || Number.isNaN(ref) || t.currentLapTimeMs <= 0) return null;
    return (t.currentLapTimeMs - ref) / 1000;
  }
}

/** `LapDeltaTracker` for the HUD: the delta in seconds, or null until a complete lap has been timed */
export function useLapDelta(telemetry: CarTelemetry, trackLengthM: number): number | null {
  const trackerRef = useRef<LapDeltaTracker | null>(null);
  trackerRef.current ??= new LapDeltaTracker(trackLengthM);
  const tracker = trackerRef.current;

  useEffect(() => {
    tracker.update(telemetry);
  }, [tracker, telemetry]);

  return tracker.delta(telemetry);
}
