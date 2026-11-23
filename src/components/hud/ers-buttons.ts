import type { CarTelemetry } from "@/types/f1";

/** How the HUD's Boost and Overtake controls look, from the car's telemetry */
export interface ErsButtons {
  boostOn: boolean;
  /** The boost cannot be used now (an older car's override in a race before it is earned) */
  boostLocked: boolean;
  /**
   * A 2026 F1 car's Overtake in a race: earned and used (`on`), used by the Automatic Overtake (`auto`), earned
   * (`available`), not earned (`locked`); null outside a race (it is on all the time there) and on other cars
   */
  overtake: "on" | "auto" | "available" | "locked" | null;
}

export function ersButtons(t: CarTelemetry): ErsButtons {
  // The 2026 rules: the Boost and Overtake are two controls, the Boost any time
  if (t.ersBoostActive !== undefined) {
    const overtake = !t.overtakeRace ? null : t.overtakeInUse ? (t.overtakeAuto ? "auto" : "on") : t.overtakeAvailable ? "available" : "locked";
    return { boostOn: t.ersBoostActive, boostLocked: false, overtake };
  }
  // An older car's one override: in a race a 2026 car's only once earned within 1 s at the detection point
  const locked = t.overtakingRules === "straight-mode-2026" && t.overtakeAvailable === false;
  return { boostOn: !locked && t.manualOverrideActive, boostLocked: locked, overtake: null };
}
