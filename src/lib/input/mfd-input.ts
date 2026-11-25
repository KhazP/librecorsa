/*
 * MFD dial button auto-repeat (TC, ABS, brake bias, diff, engine map, ERS), kept apart from the drive loop so the
 * checks can test it frame by frame (scripts/verify/verify-input.ts).
 *
 * Driven strictly by resolved PadAction bindings from DeviceInputReader (never raw button indices), so steering
 * wheel shift paddles on buttons 12–15 (such as Moza R3 ES/ES-X rims) cannot touch MFD dials unless explicitly bound.
 *
 * Also what the dials do on the MFD's Pit page (`pitDial`): its settings take the D-pad as the Electronics page's do.
 */
import type { PitStrategyState, TireCompound } from "@/types/f1";
import type { PadAction } from "./bindings";

export const MFD_DIAL_ACTIONS = ["mfdUp", "mfdDown", "mfdPrev", "mfdNext"] as const;
export type MfdDialAction = (typeof MFD_DIAL_ACTIONS)[number];

const MFD_DIAL_ACTION_SET: ReadonlySet<PadAction> = new Set(MFD_DIAL_ACTIONS);

export function isMfdDialAction(action: PadAction): action is MfdDialAction {
  return MFD_DIAL_ACTION_SET.has(action);
}

/** Delay before a held MFD dial button starts repeating (ms) */
export const MFD_REPEAT_DELAY_MS = 320;
/** Interval between repeated MFD dial steps while held (ms) */
export const MFD_REPEAT_RATE_MS = 95;

/** Tracks rising-edge + hold-to-repeat timing for bound MFD dial actions */
export class MfdRepeatController {
  private repeatAt = new Map<MfdDialAction, number>();

  /**
   * One frame: `pressed` and `held` come from DeviceInputReader; `active` is true while driving live.
   * When inactive (menus, paused, seat panel, replay), timers clear so a button held through a menu never fires.
   */
  update(
    pressed: ReadonlySet<PadAction>,
    held: ReadonlySet<PadAction> | undefined,
    nowMs: number,
    active: boolean,
  ): MfdDialAction[] {
    if (!active) {
      this.repeatAt.clear();
      return [];
    }
    const fired: MfdDialAction[] = [];
    for (const action of MFD_DIAL_ACTIONS) {
      if (!held?.has(action)) {
        this.repeatAt.delete(action);
        continue;
      }
      if (pressed.has(action)) {
        fired.push(action);
        this.repeatAt.set(action, nowMs + MFD_REPEAT_DELAY_MS);
        continue;
      }
      const nextAt = this.repeatAt.get(action);
      if (nextAt !== undefined && nowMs >= nextAt) {
        fired.push(action);
        this.repeatAt.set(action, nowMs + MFD_REPEAT_RATE_MS);
      }
    }
    return fired;
  }
}

/** The Pit page's compounds, left to right */
export const PIT_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];

/** The Pit page's settings, top to bottom: where left / right move its cursor (wrapping round, as the dials do) */
export type PitItem = "tyres" | "repair" | "box";
export const PIT_ITEMS: readonly PitItem[] = ["tyres", "repair", "box"];

/** Left (−1) or right (+1) from one Pit setting to the next */
export function pitPick(item: PitItem, dir: -1 | 1): PitItem {
  return PIT_ITEMS[(PIT_ITEMS.indexOf(item) + dir + PIT_ITEMS.length) % PIT_ITEMS.length];
}

/**
 * Up (+1) or down (−1) on a Pit setting: the next compound to the right or left (no further than the ends), repairs
 * and the box call on with up and off with down, so a held button repeating never flickers them. Null: no change.
 */
export function pitDial(s: PitStrategyState, item: PitItem, dir: -1 | 1): Partial<PitStrategyState> | null {
  if (item === "tyres") {
    const at = Math.max(0, PIT_COMPOUNDS.indexOf(s.nextCompound));
    const next = PIT_COMPOUNDS[Math.max(0, Math.min(PIT_COMPOUNDS.length - 1, at + dir))];
    return next === s.nextCompound ? null : { nextCompound: next };
  }
  if (item === "repair") return s.repairDamage === dir > 0 ? null : { repairDamage: dir > 0 };
  return s.boxRequested === dir > 0 ? null : { boxRequested: dir > 0 };
}
