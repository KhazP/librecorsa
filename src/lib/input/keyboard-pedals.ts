/**
 * Keyboard pedal help. A key presses a pedal fully, so with no ABS a held brake key locks the wheels and with no
 * traction control a held throttle key spins the rears out of a slow corner. These scale the key's pedal down while the
 * tyres pass their grip and let it back up as they recover, steering by the tyres' normalised slip (1 = the peak) and
 * where it is heading (a short look-ahead on its rate of change). They are no ABS or traction control, only a stand-in
 * for the feel an analogue pedal would give, so they are meant for when those aids are off.
 */

/** How far ahead the slip is extrapolated from its rate of change (s) */
const SLIP_LOOKAHEAD_S = 0.045;
/** Pedal scale rate (per s) per unit of slip below the peak; past the peak it drops three times as fast */
const SCALE_RATE = 10;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One pedal's scale: rises while the extrapolated slip is under 1, falls (3× as fast) above it, held in [min, 1] */
class SlipLimitedPedal {
  scale = 1;
  private prevSlip = Number.NaN;

  update(slip: number, minScale: number, dt: number): number {
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

/** Normalised slip the driven tyres may carry under power before it counts as wheelspin, by speed (km/h) */
export const throttleSlipAllowance = (speedKmh: number) => lerp(0.25, 0.35, clamp01((speedKmh - 40) / 120));

export class KeyboardPedalAssist {
  private readonly brake = new SlipLimitedPedal();
  private readonly throttle = new SlipLimitedPedal();

  /**
   * Scale (0.3..1) for the brake key from the four tyres' load-weighted normalised slip; 1 when `active` is false
   * (the car's ABS is on, or the help is switched off)
   */
  brakeScale(totalNdSlip: number, dt: number, active: boolean): number {
    if (!active) {
      this.brake.reset();
      return 1;
    }
    return this.brake.update(totalNdSlip + 0.15, 0.3, dt);
  }

  /**
   * Scale (0.6..0.8 up to 1) for the throttle key from the driven tyres' normalised slip; 1 when `active` is false
   * (the car's traction control is on, or the help is switched off)
   */
  throttleScale(drivenNdSlip: number, speedMs: number, dt: number, active: boolean): number {
    if (!active) {
      this.throttle.reset();
      return 1;
    }
    const kmh = speedMs * 3.6;
    const minScale = lerp(0.6, 0.8, clamp01((kmh - 40) / 120));
    return this.throttle.update(drivenNdSlip - throttleSlipAllowance(kmh), minScale, dt);
  }

  reset(): void {
    this.brake.reset();
    this.throttle.reset();
  }
}
