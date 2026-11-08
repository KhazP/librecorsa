import type { CarTelemetry } from "@/types/f1";

/** The flaps as every HUD panel shows them */
export interface AeroReadout {
  /** As the car's era names it: "NO DRS", "DRS OPEN" / "DRS ARMED" / "DRS", "X-MODE" / "X ARMED" / "Z-MODE" */
  label: string;
  /** The flaps are open (X-mode, DRS open) */
  open: boolean;
  /** Shut, but may be opened here (a DRS zone the car is allowed to use) */
  armed: boolean;
}

/**
 * The flaps' state as the car's era names it: no DRS before 2011, rear-flap DRS from 2011 to 2025, X-mode (Straight
 * Mode) / Z-mode from 2026. The era comes from the car's overtaking rules; "armed" from the 6-DOF car's DRS channel.
 */
export function aeroReadout(t: Pick<CarTelemetry, "activeAeroMode" | "overtakingRules" | "f12026">): AeroReadout {
  if (t.overtakingRules === "none") return { label: "NO DRS", open: false, armed: false };
  const open = t.activeAeroMode === "X_MODE";
  const armed = !open && t.f12026?.hasDrs === true && t.f12026.drsAvailable === true;
  if (t.overtakingRules === "drs-rear") return { label: open ? "DRS OPEN" : armed ? "DRS ARMED" : "DRS", open, armed };
  return { label: open ? "X-MODE" : armed ? "X ARMED" : "Z-MODE", open, armed };
}

/** The label alone (see `aeroReadout`) */
export function aeroModeLabel(t: Pick<CarTelemetry, "activeAeroMode" | "overtakingRules" | "f12026">): string {
  return aeroReadout(t).label;
}
