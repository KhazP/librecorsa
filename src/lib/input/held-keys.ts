/**
 * The keyboard's held controls, and the keys physically down. The drive drops key presses while the pause menu or the
 * seat panel has the keyboard, and lets go of every held key as one opens; the browser sends a held key again only
 * after the system's repeat delay. So a throttle or steering key already down as the menu closed did nothing for up to
 * a second (#171): the drive now holds such keys again the moment it takes the keyboard back.
 */

import type { KeyAction } from "./bindings";

/** Key actions that act while held, and the held-key flag each sets (the rest are one-shot actions) */
export const HELD_KEYS = {
  throttle: "up",
  brake: "down",
  steerLeft: "left",
  steerRight: "right",
  throttleHalf: "half",
  brakeHalf: "halfBrake",
  clutch: "clutch",
  boostHold: "boostHold",
  headlightFlash: "headlightFlash",
} as const satisfies Partial<Record<KeyAction, string>>;
export type HeldKeyAction = keyof typeof HELD_KEYS;
export const isHeldKeyAction = (action: KeyAction): action is HeldKeyAction => Object.hasOwn(HELD_KEYS, action);

/** Who had the keyboard when a key went down: the drive, a menu over the game (the pause menu), or the seat panel */
export type KeyOwner = "drive" | "menu" | "seatPanel";

/**
 * Keys a screen acts on that must not carry on into the drive once it closes. In a menu Enter presses the focused
 * control (Space does on its release), which may be Resume or Flying lap, and Backspace steps back out of the pause
 * menu. The seat panel's arrows pick and change its rows, Enter and R reset them (SeatPanel.tsx). Arrows pressed in the
 * pause menu do carry on: they steer, and closing the menu takes a click, Enter or Esc, not the arrow itself
 */
const SPENT_BY: Record<Exclude<KeyOwner, "drive">, ReadonlySet<string>> = {
  menu: new Set(["Enter", "NumpadEnter", "Space", "Backspace"]),
  seatPanel: new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "NumpadEnter", "KeyR"]),
};

const ALT_CODES: ReadonlySet<string> = new Set(["AltLeft", "AltRight"]);
const META_CODES: ReadonlySet<string> = new Set(["MetaLeft", "MetaRight"]);

/** The parts of a keydown the tracker reads */
export interface KeyDownLike {
  code: string;
  repeat: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The keys physically down, by code */
export class PhysicalKeys {
  private readonly down = new Set<string>();
  /** Down, but pressed while a screen that acts on them had the keyboard: the screen used them */
  private readonly spent = new Set<string>();
  /** Down with Alt: a cockpit view nudge, not a driving key, unless an Alt key bound to a control is down */
  private readonly withAlt = new Set<string>();

  keyDown(e: KeyDownLike, owner: KeyOwner): void {
    // A Cmd shortcut: macOS sends no keyup for a key let go while Cmd is down, so it would stay down here for good
    if (e.metaKey) return;
    if (e.repeat && this.down.has(e.code)) {
      // A repeat is the same press, except that once the drive has taken a held key's repeat the key is the drive's
      if (owner === "drive") this.spent.delete(e.code);
      return;
    }
    this.down.add(e.code);
    if (owner !== "drive" && SPENT_BY[owner].has(e.code)) this.spent.add(e.code);
    else this.spent.delete(e.code);
    if (e.altKey && !ALT_CODES.has(e.code)) this.withAlt.add(e.code);
    else this.withAlt.delete(e.code);
  }

  keyUp(code: string): void {
    // Letting go of Cmd: keys let go while it was down sent no keyup
    if (META_CODES.has(code)) return this.clear();
    this.down.delete(code);
    this.spent.delete(code);
    this.withAlt.delete(code);
  }

  /** Focus left the window or the tab was hidden: the keyups go elsewhere */
  clear(): void {
    this.down.clear();
    this.spent.clear();
    this.withAlt.clear();
  }

  /** The keys the drive holds again as it takes the keyboard back, in the order they went down */
  restorable(lookup: ReadonlyMap<string, KeyAction>): string[] {
    const boundAltDown = [...ALT_CODES].some((code) => this.down.has(code) && lookup.has(code));
    return [...this.down].filter((code) => !this.spent.has(code) && (boundAltDown || !this.withAlt.has(code)));
  }
}

/**
 * What keys still down hold again: their held controls, and Gear up's hold (a manual start holds it as the clutch).
 * One-shot actions never fire from it: a gear change, the camera or a restart needs a new press
 */
export function heldActionsOf(
  codes: Iterable<string>,
  lookup: ReadonlyMap<string, KeyAction>
): { actions: HeldKeyAction[]; gearUpHeld: boolean } {
  const actions: HeldKeyAction[] = [];
  let gearUpHeld = false;
  for (const code of codes) {
    const action = lookup.get(code);
    if (action === undefined) continue;
    if (action === "shiftUp") gearUpHeld = true;
    else if (isHeldKeyAction(action) && !actions.includes(action)) actions.push(action);
  }
  return { actions, gearUpHeld };
}
