import type { CarTelemetry } from "@/types/f1";
import type { OvertakingRules } from "@/lib/sim/overtaking-rules";
import type { BadgeToneProp, BadgeVariant } from "@/components/ui/Badge";
import type { IconName } from "@/components/ui/icons/registry";
import { t as tr } from "@/i18n/runtime";
import { perLanguage } from "./hud-format";

/** The words of the dash and the notices, built once per language: every HUD reads the readout every frame */
const words = perLanguage(() => ({
  noDrs: tr("hud.aeroLabel.readout.noDrs"),
  drsOpen: tr("hud.aeroLabel.readout.drsOpen"),
  drsQueued: tr("hud.aeroLabel.readout.drsQueued"),
  drsArmed: tr("hud.aeroLabel.readout.drsArmed"),
  xMode: tr("hud.aeroLabel.readout.xMode"),
  xQueued: tr("hud.aeroLabel.readout.xQueued"),
  xArmed: tr("hud.aeroLabel.readout.xArmed"),
  zMode: tr("hud.aeroLabel.readout.zMode"),
  drsEnabled: tr("hud.aeroLabel.notice.drsEnabled"),
  drsNotEnabled: tr("hud.aeroLabel.notice.drsNotEnabled"),
  drsQueuedNotice: tr("hud.aeroLabel.notice.drsQueued"),
  xModeBadge: tr("hud.aeroLabel.notice.xModeBadge"),
  straightMode: tr("hud.aeroLabel.notice.straightMode"),
  xModeQueued: tr("hud.aeroLabel.notice.xModeQueued"),
  overtakeBadge: tr("hud.aeroLabel.notice.overtakeBadge"),
  overtakeEnabled: tr("hud.aeroLabel.notice.overtakeEnabled"),
  overtakeLocked: tr("hud.aeroLabel.notice.overtakeLocked"),
}));

/** The flaps as every HUD panel shows them */
export interface AeroReadout {
  /**
   * As the car's era names it: "NO DRS", "DRS OPEN" / "DRS ARMED" / "DRS QUEUED" / "DRS", "X-MODE" / "X ARMED" /
   * "X QUEUED" / "Z-MODE"
   */
  label: string;
  /** The flaps are open (X-mode, DRS open) */
  open: boolean;
  /** Shut, but may be opened here (a DRS zone the car is allowed to use) */
  armed: boolean;
  /** Shut, with a press of the button kept for the zone the car is on or coming to: it opens them there */
  queued: boolean;
  /** The 2026 rules: both flaps on every straight for every car, the 1 s gap earning Overtake Mode instead */
  straightMode: boolean;
}

/**
 * The flaps' state as the car's era names it: no DRS before 2011, rear-flap DRS from 2011 to 2025, X-mode (Straight
 * Mode) / Z-mode from 2026. The era comes from the car's overtaking rules; "armed" and "queued" from the 6-DOF car's
 * DRS channels.
 */
export function aeroReadout(t: Pick<CarTelemetry, "activeAeroMode" | "overtakingRules" | "f12026">): AeroReadout {
  const w = words();
  if (t.overtakingRules === "none") return { label: w.noDrs, open: false, armed: false, queued: false, straightMode: false };
  const open = t.activeAeroMode === "X_MODE";
  const fitted = t.f12026?.hasDrs === true;
  const armed = !open && fitted && t.f12026?.drsAvailable === true;
  const queued = !open && fitted && t.f12026?.drsQueued === true;
  if (t.overtakingRules === "drs-rear") {
    return { label: open ? w.drsOpen : queued ? w.drsQueued : armed ? w.drsArmed : "DRS", open, armed, queued, straightMode: false };
  }
  return {
    label: open ? w.xMode : queued ? w.xQueued : armed ? w.xArmed : w.zMode,
    open,
    armed,
    queued,
    straightMode: t.overtakingRules === "straight-mode-2026",
  };
}

/** The label alone (see `aeroReadout`) */
export function aeroModeLabel(t: Pick<CarTelemetry, "activeAeroMode" | "overtakingRules" | "f12026">): string {
  return aeroReadout(t).label;
}

/** What the HUD's race-control notice can be about */
export type AeroNoticeEvent =
  /** A DRS detection point (2011 to 2025): whether DRS was earned for its zone */
  | { kind: "detection"; zone: string; eligible: boolean }
  /** 2026: a stretch where both flaps may open (Straight Mode) is coming up */
  | { kind: "straight" }
  /** 2026, in a race: race control's Overtake Mode verdict at the detection point */
  | { kind: "overtake"; earned: boolean }
  /** A press of the flap button is kept for the zone ahead */
  | { kind: "queued" };

/** The notice as the HUD shows it: a badge and a line of text */
export interface AeroNotice {
  badge: string;
  text: string;
  tone: BadgeToneProp;
  variant: BadgeVariant;
  icon: IconName;
}

/**
 * The notice for an event in the car's era's words, or null when that era has no such notice. A 2026 car's flaps
 * open on every straight for every car, so it never hears "DRS (not) enabled": the 1 s gap there earns Overtake Mode
 */
export function aeroNotice(rules: OvertakingRules | undefined, e: AeroNoticeEvent): AeroNotice | null {
  const w = words();
  if (rules === "drs-rear") {
    if (e.kind === "detection") {
      return {
        badge: e.zone,
        text: e.eligible ? w.drsEnabled : w.drsNotEnabled,
        tone: e.eligible ? "info" : "neutral",
        variant: e.eligible ? "solid" : "soft",
        icon: e.eligible ? "drsOpen" : "drsClosed",
      };
    }
    if (e.kind === "queued") return { badge: "DRS", text: w.drsQueuedNotice, tone: "info", variant: "outline", icon: "drsClosed" };
    return null;
  }
  if (rules === "straight-mode-2026") {
    switch (e.kind) {
      case "straight":
        return { badge: w.xModeBadge, text: w.straightMode, tone: "info", variant: "solid", icon: "drsOpen" };
      case "queued":
        return { badge: w.xModeBadge, text: w.xModeQueued, tone: "info", variant: "outline", icon: "drsClosed" };
      case "overtake":
        return {
          badge: w.overtakeBadge,
          text: e.earned ? w.overtakeEnabled : w.overtakeLocked,
          tone: e.earned ? "info" : "neutral",
          variant: e.earned ? "solid" : "soft",
          icon: "overtake",
        };
      default:
        return null;
    }
  }
  return null;
}

/** The newest notice event of the car's era in its channels, with its sim time (ms) */
export function latestAeroEvent(
  t: Pick<CarTelemetry, "overtakingRules" | "f12026">
): (AeroNoticeEvent & { atMs: number }) | null {
  const c = t.f12026;
  if (!c) return null;
  if (t.overtakingRules === "drs-rear") {
    return c.drsDetection ? { kind: "detection", zone: c.drsDetection.zone, eligible: c.drsDetection.eligible, atMs: c.drsDetection.atMs } : null;
  }
  if (t.overtakingRules === "straight-mode-2026") {
    const ahead = c.straightModeAhead;
    const ot = c.overtakeDetection;
    if (ot && (!ahead || ot.atMs >= ahead.atMs)) return { kind: "overtake", earned: ot.earned, atMs: ot.atMs };
    return ahead ? { kind: "straight", atMs: ahead.atMs } : null;
  }
  return null;
}
