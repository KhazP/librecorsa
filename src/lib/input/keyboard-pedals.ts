/**
 * Keyboard pedal help. A key presses a pedal fully, so with no ABS a held brake key locks the wheels and with no
 * traction control a held throttle key spins the rears out of a slow corner. These scale the key's pedal down while the
 * tyres pass their grip and let it back up as they recover, steering by the tyres' normalised slip (1 = the peak) and
 * where it is heading (a short look-ahead on its rate of change). They are no ABS or traction control, only a stand-in
 * for the feel an analogue pedal would give, so they are meant for when those aids are off.
 *
 * Adapted from AC-Advanced-Gamepad-Assist v1.5.5 by Adam D. (https://github.com/adam10603/AC-Advanced-Gamepad-Assist),
 * MIT License — see CREDITS.md.
 */

import { brakeSlipMargin, throttleSlipAllowance } from "@/lib/sim/tyre-slip";

/** How far ahead the slip is extrapolated from its rate of change (s) */
const SLIP_LOOKAHEAD_S = 0.045;
/** Pedal scale rate (per s) per unit of slip below the peak; past the peak it drops three times as fast */
const SCALE_RATE = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * One key's pedal scale, held in [min, 1]: while the key is down it rises with the extrapolated slip under 1 and falls
 * (3× as fast) above it. It only follows the tyres while the key is down: let go, it holds while the key's pedal falls
 * back (a scale back at 1 would push the falling pedal up again) and is 1 again once the pedal is fully released.
 */
class SlipLimitedPedal {
  scale = 1;
  private prevSlip = Number.NaN;

  update(held: boolean, pedal: number, slip: number, minScale: number, dt: number): number {
    if (!held) {
      this.prevSlip = Number.NaN;
      if (pedal <= 0) this.scale = 1;
      return this.scale;
    }
    const rate = Number.isFinite(this.prevSlip) && dt > 0 ? (slip - this.prevSlip) / dt : 0;
    this.prevSlip = slip;
    const ahead = clamp(slip + SLIP_LOOKAHEAD_S * rate, 0, 2);
    const drive = ahead < 1 ? 1 - ahead : 3 * (1 - ahead);
    this.scale = clamp(this.scale + dt * SCALE_RATE * drive, minScale, 1);
    return this.scale;
  }

  reset(): void {
    this.scale = 1;
    this.prevSlip = Number.NaN;
  }
}

export class KeyboardPedalAssist {
  private readonly brake = new SlipLimitedPedal();
  private readonly throttle = new SlipLimitedPedal();

  /**
   * Scale for the brake key's pedal (`pedal`, 0..1, the key `held`) from the four tyres' load-weighted normalised slip:
   * down to 0.5 at `strength` 0 … 0.1 at 1 (default 0.5, which also backs off earlier). 1 when `active` is false (the
   * car's ABS is on, or the help is switched off).
   */
  brakeScale(held: boolean, pedal: number, totalNdSlip: number, dt: number, active: boolean, strength = 0.5): number {
    if (!active) {
      this.brake.reset();
      return 1;
    }
    const s = clamp01(strength);
    return this.brake.update(held, pedal, totalNdSlip + brakeSlipMargin(s), lerp(0.5, 0.1, s), dt);
  }

  /**
   * Scale for the throttle key's pedal (`pedal`, 0..1, the key `held`) from the driven tyres' normalised slip: down to
   * 0.6 slow … 0.8 past 160 km/h at the default `strength` 0.5 (±0.125 for 0 / 1, at most 0.9). 1 when `active` is
   * false (the car's traction control is on, or the help is switched off).
   */
  throttleScale(
    held: boolean,
    pedal: number,
    drivenNdSlip: number,
    speedMs: number,
    dt: number,
    active: boolean,
    strength = 0.5
  ): number {
    if (!active) {
      this.throttle.reset();
      return 1;
    }
    const s = clamp01(strength);
    const kmh = speedMs * 3.6;
    const minScale = Math.min(0.9, lerp(0.6, 0.8, clamp01((kmh - 40) / 120)) - (s - 0.5) * 0.25);
    return this.throttle.update(held, pedal, drivenNdSlip - throttleSlipAllowance(kmh, s), minScale, dt);
  }

  reset(): void {
    this.brake.reset();
    this.throttle.reset();
  }
}
