import type { PadLike } from "@/lib/input/device-input";

/**
 * A headset's two hand controllers (Meta Quest Touch and alike) as one standard-mapping pad, so they drive through the
 * same pad code as an Xbox or a DualSense: the player's button layout, the steering assist and the pedal curves.
 *
 * WebXR reports each hand on its own with the `xr-standard` mapping (W3C WebXR Gamepads Module): buttons 0 trigger,
 * 1 grip, 2 touchpad, 3 thumbstick press, 4 A / X, 5 B / Y; axes 2 and 3 the thumbstick. They are laid out where a
 * pad has them: the triggers are the pedals (right throttle, left brake), the left stick steers, the face buttons are
 * the face buttons (A gear up, X gear down by default) and the stick presses are L3 / R3. The right stick's flicks are
 * the D-pad (the MFD's arrows). The grips do nothing: hands squeeze them while holding the controllers.
 *
 * The pad exists only in the headset and only for the drive (drive-session.ts): the menus never see it, since they are
 * not drawn in the headset.
 */

export const XR_PAD_ID = "Headset controllers (WebXR)";

/** The `xr-standard` indices on each hand */
const XR_TRIGGER = 0;
const XR_STICK_PRESS = 3;
const XR_BUTTON_LOWER = 4;
const XR_BUTTON_UPPER = 5;
const XR_STICK_X = 2;
const XR_STICK_Y = 3;

/** A right-stick flick past this reads as a D-pad press, and lets go under the lower value */
const DPAD_ON = 0.7;
const DPAD_OFF = 0.45;

export interface XrHandSource {
  handedness: string;
  gamepad?: Pick<Gamepad, "buttons" | "axes"> | null;
}

interface PadButton {
  value: number;
  pressed: boolean;
}

const RELEASED: PadButton = { value: 0, pressed: false };
const button = (b: GamepadButton | PadButton | undefined): PadButton =>
  b ? { value: b.value, pressed: b.pressed } : RELEASED;
const press = (on: boolean): PadButton => (on ? { value: 1, pressed: true } : RELEASED);

/** Builds the pad from the session's input sources every frame; keeps the D-pad's latch between frames */
export class XrPadMapper {
  /** D-pad up, down, left, right held from the right stick */
  private readonly dpad = [false, false, false, false];

  read(sources: Iterable<XrHandSource>): PadLike | null {
    let left: XrHandSource["gamepad"] = null;
    let right: XrHandSource["gamepad"] = null;
    for (const s of sources) {
      if (!s.gamepad) continue;
      if (s.handedness === "left") left = s.gamepad;
      else if (s.handedness === "right") right = s.gamepad;
    }
    if (!left && !right) {
      this.dpad.fill(false);
      return null;
    }
    const lb = left?.buttons ?? [];
    const rb = right?.buttons ?? [];
    const rx = right?.axes[XR_STICK_X] ?? 0;
    const ry = right?.axes[XR_STICK_Y] ?? 0;
    // Up is negative y, as on a pad's stick
    const latch = (i: number, v: number) => {
      this.dpad[i] = this.dpad[i] ? v > DPAD_OFF : v > DPAD_ON;
      return this.dpad[i];
    };
    const up = latch(0, -ry);
    const down = latch(1, ry);
    const leftDir = latch(2, -rx);
    const rightDir = latch(3, rx);

    const buttons: PadButton[] = [
      button(rb[XR_BUTTON_LOWER]), // 0 A
      button(rb[XR_BUTTON_UPPER]), // 1 B
      button(lb[XR_BUTTON_LOWER]), // 2 X
      button(lb[XR_BUTTON_UPPER]), // 3 Y
      RELEASED, // 4 LB: the left grip is held, not pressed
      RELEASED, // 5 RB: likewise the right grip
      button(lb[XR_TRIGGER]), // 6 LT: brake
      button(rb[XR_TRIGGER]), // 7 RT: throttle
      RELEASED, // 8 View
      RELEASED, // 9 Menu: the headset keeps its menu button (a long B pauses, vr-presenter.ts)
      button(lb[XR_STICK_PRESS]), // 10 L3
      button(rb[XR_STICK_PRESS]), // 11 R3
      press(up), // 12 D-pad up
      press(down), // 13 D-pad down
      press(leftDir), // 14 D-pad left
      press(rightDir), // 15 D-pad right
      RELEASED, // 16 Home
    ];
    return {
      id: XR_PAD_ID,
      index: -1,
      mapping: "standard",
      connected: true,
      axes: [left?.axes[XR_STICK_X] ?? 0, left?.axes[XR_STICK_Y] ?? 0, rx, ry],
      buttons,
    };
  }
}

/** A long press of B pauses the drive (the headset keeps its menu button for itself), in ms */
export const PAUSE_HOLD_MS = 600;

/** The standard pad buttons the paused panel reads */
const PAD_A = 0;
const PAD_B = 1;
const PAD_Y = 3;
const PAD_RT = 7;

export interface VrPauseInput {
  /** B held long while driving: pause */
  pause: boolean;
  /** A or the throttle trigger, paused: drive on */
  resume: boolean;
  /** Y, paused: put the head back on the eye point */
  recenter: boolean;
  /** B, paused: leave the headset (the page's pause menu takes over) */
  leave: boolean;
}

/**
 * The headset's own buttons, read from the controllers' pad: the pause menu in a headset is the HUD's paused panel.
 * Driving, a long B pauses (a tap of B stays the pad's B). Paused, A or the throttle trigger drives on, Y recentres
 * and B leaves the headset; the B that paused has to be let go first, so holding it never leaves as well.
 */
export class HeadsetButtons {
  private readonly prev: boolean[] = [];
  private bHeldSinceMs: number | null = null;
  private bHoldFired = false;

  reset(): void {
    this.prev.length = 0;
    this.bHeldSinceMs = null;
    this.bHoldFired = false;
  }

  read(pad: PadLike | null, nowMs: number, paused: boolean): VrPauseInput {
    const out: VrPauseInput = { pause: false, resume: false, recenter: false, leave: false };
    const down = (i: number) => Boolean(pad?.buttons[i]?.pressed);
    const edge = (i: number) => down(i) && !this.prev[i];
    if (!paused) {
      if (down(PAD_B)) {
        this.bHeldSinceMs ??= nowMs;
        if (!this.bHoldFired && nowMs - this.bHeldSinceMs >= PAUSE_HOLD_MS) {
          this.bHoldFired = true;
          out.pause = true;
        }
      } else {
        this.bHeldSinceMs = null;
        this.bHoldFired = false;
      }
    } else {
      if (!down(PAD_B)) this.bHoldFired = false;
      out.resume = edge(PAD_A) || edge(PAD_RT);
      out.recenter = edge(PAD_Y);
      out.leave = !this.bHoldFired && edge(PAD_B);
      this.bHeldSinceMs = null;
    }
    for (const i of [PAD_A, PAD_B, PAD_Y, PAD_RT]) this.prev[i] = down(i);
    return out;
  }
}
