/*
 * MFD dial button auto-repeat (TC, ABS, brake bias, diff, engine map, ERS), kept apart from the drive loop so the
 * checks can test it frame by frame (scripts/verify/verify-input.ts).
 *
 * Driven strictly by resolved PadAction bindings from DeviceInputReader (never raw button indices), so steering
 * wheel shift paddles on buttons 12–15 (such as Moza R3 ES/ES-X rims) cannot touch MFD dials unless explicitly bound.
 */
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
