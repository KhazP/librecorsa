"use client";

import { useEffect, useRef } from "react";
import type { CarTelemetry } from "@/types/f1";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";

export { LapDeltaTracker };

/**
 * `LapDeltaTracker` for the HUD: the tracker and the delta in seconds (null until a complete lap has been timed). The
 * out-lap is left out of both: no lap is timed there, its clock started on the grid, and its trace would otherwise
 * stay in the first timed lap's last metres (the lap counter does not move at the out-lap's line), where the next
 * lap would read a delta of most of a lap.
 */
export function useLapDeltaTracker(telemetry: CarTelemetry, trackLengthM: number): { tracker: LapDeltaTracker; deltaS: number | null } {
  const trackerRef = useRef<LapDeltaTracker | null>(null);
  trackerRef.current ??= new LapDeltaTracker(trackLengthM);
  const tracker = trackerRef.current;
  const outLap = Boolean(telemetry.outLap);

  useEffect(() => {
    if (!outLap) tracker.update(telemetry);
  }, [tracker, telemetry, outLap]);

  return { tracker, deltaS: outLap ? null : tracker.delta(telemetry) };
}
