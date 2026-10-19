"use client";

import { useEffect, useRef } from "react";
import type { CarTelemetry } from "@/types/f1";
import { LapDeltaTracker } from "@/lib/sim/lap-delta";

export { LapDeltaTracker };

/** `LapDeltaTracker` for the HUD: the tracker and the delta in seconds (null until a complete lap has been timed) */
export function useLapDeltaTracker(telemetry: CarTelemetry, trackLengthM: number): { tracker: LapDeltaTracker; deltaS: number | null } {
  const trackerRef = useRef<LapDeltaTracker | null>(null);
  trackerRef.current ??= new LapDeltaTracker(trackLengthM);
  const tracker = trackerRef.current;

  useEffect(() => {
    tracker.update(telemetry);
  }, [tracker, telemetry]);

  return { tracker, deltaS: tracker.delta(telemetry) };
}

/** `LapDeltaTracker` for the HUD: the delta in seconds, or null until a complete lap has been timed */
export function useLapDelta(telemetry: CarTelemetry, trackLengthM: number): number | null {
  return useLapDeltaTracker(telemetry, trackLengthM).deltaS;
}
