import type { CarTelemetry } from "@/types/f1";

/** The flaps' state as the car's era names it: rear-flap DRS up to 2025, X-mode (Straight Mode) / Z-mode from 2026 */
export function aeroModeLabel(t: Pick<CarTelemetry, "activeAeroMode" | "overtakingRules">): string {
  const open = t.activeAeroMode === "X_MODE";
  if (t.overtakingRules === "drs-rear") return open ? "DRS OPEN" : "DRS";
  return open ? "X-MODE" : "Z-MODE";
}
