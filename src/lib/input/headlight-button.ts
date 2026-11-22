/*
 * The headlight controls' timing, kept apart from the drive loop so the checks can run it frame by frame
 * (scripts/verify-input.ts).
 *
 * A controller's headlight button carries both jobs, as GT7's L3 carries the headlight switch and the flash: a press
 * flashes the high beam until the button has been held LIGHTS_HOLD_MS, and then switches the lights on or off instead.
 * The flash key or button flashes for as long as it is held. Either way a tap still lights the high beam for
 * MIN_FLASH_MS, so it reads as a flash and not a flicker.
 */

/** The headlight button held this long switches the lights on or off; a shorter press is a flash */
export const LIGHTS_HOLD_MS = 500;
/** A tap of the flash still lights the high beam this long (ms) */
export const MIN_FLASH_MS = 160;

export interface HeadlightButtonStep {
  /** Flash the high beam this frame */
  flash: boolean;
  /** Switch the lights on or off now (once per hold) */
  toggle: boolean;
}

const IDLE: HeadlightButtonStep = { flash: false, toggle: false };

/** A controller's combined headlight button */
export class HeadlightButton {
  private heldSinceMs: number | null = null;

  /**
   * One frame: `pressed` the button went down this frame, `held` it is down now, `active` the car is being driven
   * (in the menus, a replay or the pause menu the button does nothing and a hold starts over)
   */
  update(pressed: boolean, held: boolean, nowMs: number, active: boolean): HeadlightButtonStep {
    if (!active) {
      this.heldSinceMs = null;
      return IDLE;
    }
    if (pressed) this.heldSinceMs = nowMs;
    if (this.heldSinceMs === null) return IDLE;
    if (!held) {
      this.heldSinceMs = null;
      return IDLE;
    }
    if (nowMs - this.heldSinceMs >= LIGHTS_HOLD_MS) {
      this.heldSinceMs = null;
      return { flash: false, toggle: true };
    }
    return { flash: true, toggle: false };
  }
}

/** Whether the high beam shows: while a flash is wanted, and for at least MIN_FLASH_MS from when it began */
export class FlashTimer {
  private wanted = false;
  private startMs = -Infinity;

  update(wanted: boolean, nowMs: number, active: boolean): boolean {
    const want = active && wanted;
    if (want && !this.wanted) this.startMs = nowMs;
    this.wanted = want;
    return want || (active && nowMs - this.startMs < MIN_FLASH_MS);
  }
}
