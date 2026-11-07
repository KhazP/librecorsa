/**
 * Force-feedback post-processing adapted from Adam's FFB Toolbox (adam10603/AC-Adams-FFB-Toolbox, MIT, Adam D.).
 * The Toolbox shapes Assetto Corsa's FFB from AC's car data (ffbBase, predicted axle loads); these do the same jobs
 * from LibreCorsa's own telemetry, on the gained force the wheel plays (1 = full force).
 *
 * - Downforce compensation: the kingpin torque grows with the front axle load, so at speed the aero load makes an F1
 *   wheel far heavier than at a hairpin. Scaling by the aero-free share of that load takes the downforce back out.
 * - Collision protection: a hit throws a torque spike at the rim. Rather than scaling the force down, a slew limiter
 *   starts from the calmest of the last few samples and lets the force drift only slowly from there, inside an eased
 *   band, so the spike never reaches the hands while a falling force still falls fast.
 * - Slip and shift cues: the tyre slide vibration ramps in from just before the tyres' peak slip (not a fixed slip
 *   ratio, which means a different thing on every tyre), and a shift warning buzzes as the revs reach the shift point.
 */

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// ---- Downforce compensation ----

/** The compensation never takes the force below this share of the physics torque */
export const DF_COMP_MIN_MULT = 0.2;
/**
 * Time constant of the axle-load smoothing (s). The aero load moves with speed, over seconds; a kerb or bump spike
 * must pass through at the multiplier it found, not lift it, so the force keeps that hit
 */
export const DF_COMP_LOAD_TAU_S = 0.3;
/** Below this front axle load (N) the fronts are airborne (or the telemetry is missing): no compensation */
export const DF_COMP_MIN_FRONT_N = 200;

/**
 * Force multiplier (static front load / current front load)^k, never above 1 (a light front over a crest is not
 * boosted) nor below {@link DF_COMP_MIN_MULT}. k = 0 is off; k = 1 cancels a torque that grows in step with the load.
 */
export function downforceCompMult(staticFrontN: number, currentFrontN: number, k: number): number {
  if (!(k > 0) || !finite(staticFrontN) || !finite(currentFrontN)) return 1;
  if (staticFrontN <= 0 || currentFrontN < DF_COMP_MIN_FRONT_N) return 1;
  const ratio = staticFrontN / currentFrontN;
  if (ratio >= 1) return 1;
  return Math.max(DF_COMP_MIN_MULT, ratio ** Math.min(1, k));
}

/**
 * Tracks the front axle's load from `wheelLoadsN` and its aero share from `frontDownforceN`. The static load is the
 * current one less the downforce, so braking weight transfer stays in the force (as the Toolbox, which compensates
 * the predicted aero load only) and fuel burn or a different car needs no calibration.
 */
export class DownforceCompensator {
  /** Smoothed front axle load, both fronts (N) */
  currentFrontN = 0;
  /** Smoothed front axle load without the downforce (N) */
  staticFrontN = 0;
  /** Multiplier from the last step */
  mult = 1;
  private frontN = 0;
  private aeroN = 0;
  private primed = false;

  step(
    wheelLoadsN: readonly number[] | undefined,
    frontDownforceN: number | undefined,
    dtS: number,
    k: number
  ): number {
    const fl = wheelLoadsN?.[0];
    const fr = wheelLoadsN?.[1];
    if (!(k > 0) || !finite(fl) || !finite(fr)) {
      this.reset();
      return 1;
    }
    const front = Math.max(0, fl) + Math.max(0, fr);
    const aero = finite(frontDownforceN) ? Math.max(0, frontDownforceN) : 0;
    if (!this.primed || !(dtS > 0)) {
      if (!this.primed) {
        this.frontN = front;
        this.aeroN = aero;
        this.primed = true;
      }
    } else {
      const a = 1 - Math.exp(-dtS / DF_COMP_LOAD_TAU_S);
      this.frontN += (front - this.frontN) * a;
      this.aeroN += (aero - this.aeroN) * a;
    }
    this.currentFrontN = this.frontN;
    this.staticFrontN = this.frontN - this.aeroN;
    this.mult = downforceCompMult(this.staticFrontN, this.currentFrontN, k);
    return this.mult;
  }

  reset(): void {
    this.frontN = 0;
    this.aeroN = 0;
    this.primed = false;
    this.currentFrontN = 0;
    this.staticFrontN = 0;
    this.mult = 1;
  }
}

// ---- Collision protection ----

/** How long one contact keeps the protection on (s) */
export const COLLISION_HOLD_S = 1.0;
/** The protection fades out over the last part of the hold (s) */
export const COLLISION_FADE_S = 0.5;
/** Time constant of the slew limiter at full protection (s) */
export const COLLISION_SLEW_TAU_S = 0.22;
/** While the force is falling the limiter follows at least this fast (share of full protection) */
export const COLLISION_RELEASE_BLEND = 0.1;
/** Half-width of the band the force may stray from the slewed value (share of full force) */
export const COLLISION_BAND = 0.075;
/** Share of the band over which the clamp eases in */
export const COLLISION_EASE = 0.5;
/** Inputs remembered before a contact; the one nearest zero seeds the limiter */
export const COLLISION_SEED_SAMPLES = 3;

const smoothstep01 = (x: number) => {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
};

/**
 * Clamp to [lo, hi] with a quadratic shoulder: identity inside, easing into each limit over `ease` × (hi − lo)
 * centred on it, so the clamped force has no corner
 */
export function clampEased(v: number, lo: number, hi: number, ease: number): number {
  const w = Math.max(0, ease) * (hi - lo);
  if (!(w > 0)) return Math.max(lo, Math.min(hi, v));
  const half = w * 0.5;
  if (v <= lo - half) return lo;
  if (v >= hi + half) return hi;
  if (v < lo + half) {
    const t = (v - (lo - half)) / w;
    return lo + t * t * half;
  }
  if (v > hi - half) {
    const t = (hi + half - v) / w;
    return hi - t * t * half;
  }
  return v;
}

/**
 * Collision protection for one force stream, run per sample. Idle (no contact for {@link COLLISION_HOLD_S}) it is
 * the identity. {@link trigger} on a contact: a fresh one restarts the limiter from the recent sample nearest zero.
 */
export class CollisionGuard {
  /** Protection strength of the last sample (0 = off, 1 = full) */
  blend = 0;
  private held = 0;
  private timerS = 0;
  private readonly recent = new Float64Array(COLLISION_SEED_SAMPLES);
  private recentCount = 0;
  private recentIdx = 0;

  /** The protection is on (or fading out) */
  get active(): boolean {
    return this.timerS > 0;
  }

  /** A contact this frame (barrier touch, impact): holds the protection for {@link COLLISION_HOLD_S} */
  trigger(): void {
    // A contact still being held keeps its limiter; a new one starts it from the calmest force before the hit
    if (this.timerS < COLLISION_FADE_S * 0.5 && this.recentCount > 0) {
      let seed = this.recent[0];
      for (let i = 1; i < this.recentCount; i++) if (Math.abs(this.recent[i]) < Math.abs(seed)) seed = this.recent[i];
      this.held = seed;
    }
    this.timerS = COLLISION_HOLD_S;
  }

  /** Keeps a running protection from fading (the car is airborne after the hit); never starts one */
  sustain(): void {
    if (this.timerS > 0) this.timerS = COLLISION_HOLD_S;
  }

  /** One force sample `x` (gained, 1 = full force) `hS` seconds after the last → the protected force */
  step(x: number, hS: number): number {
    let blend = smoothstep01(this.timerS / COLLISION_FADE_S);
    let out = x;
    if (blend > 1e-6) {
      // A falling force is let down quickly so a high value is never held
      if (Math.abs(x) < Math.abs(this.held) * 0.999) blend = Math.min(blend, COLLISION_RELEASE_BLEND);
      if (hS > 0) this.held += (x - this.held) * (1 - Math.exp(-hS / (COLLISION_SLEW_TAU_S * blend)));
      out = clampEased(x, this.held - COLLISION_BAND, this.held + COLLISION_BAND, COLLISION_EASE);
    } else {
      blend = 0;
      this.held = x;
    }
    this.blend = blend;
    if (hS > 0) this.timerS = Math.max(0, this.timerS - hS);
    this.recent[this.recentIdx] = x;
    this.recentIdx = (this.recentIdx + 1) % COLLISION_SEED_SAMPLES;
    this.recentCount = Math.min(COLLISION_SEED_SAMPLES, this.recentCount + 1);
    return out;
  }

  reset(): void {
    this.blend = 0;
    this.held = 0;
    this.timerS = 0;
    this.recent.fill(0);
    this.recentCount = 0;
    this.recentIdx = 0;
  }
}

// ---- Slip and shift cues ----

/** Share of the cue that plays as soon as the input crosses the start: a clear onset, then the ramp */
export const CUE_ONSET = 0.3;
/** Front tyres' slide cue range, as normalised combined slip (1 = the tyres' peak) */
export const FRONT_SLIP_CUE_START = 0.95;
export const FRONT_SLIP_CUE_END = 1.5;
/** Rear (driven) tyres' wheelspin cue range under power, as normalised combined slip */
export const REAR_SLIP_CUE_START = 1.0;
export const REAR_SLIP_CUE_END = 1.6;
/** Throttle above which rear slip counts as wheelspin for the cue */
const WHEELSPIN_THROTTLE = 0.05;

/**
 * Progressive cue level 0..1 for `x` over [start, end]: 0 below the start, {@link CUE_ONSET} at it, then a square-law
 * ramp to 1 at the end (the onset eases in over the first tenth so it is not a click)
 */
export function progressiveCue(x: number, start: number, end: number, onset = CUE_ONSET): number {
  if (!finite(x) || !(x >= start) || !(end > start)) return 0;
  const p = Math.min(1, (x - start) / (end - start));
  const fadeIn = smoothstep01(p / 0.1);
  return onset * fadeIn + (1 - onset) * p * p;
}

/**
 * Slide cue 0..1 from the axles' normalised slip: the fronts past their peak (understeer, a lock-up), or the rears
 * spinning under power (traction control not already catching it)
 */
export function slipCue(frontNdSlip: number, rearNdSlip: number, throttle: number, tcActive: boolean): number {
  const front = progressiveCue(frontNdSlip, FRONT_SLIP_CUE_START, FRONT_SLIP_CUE_END);
  const rear =
    throttle > WHEELSPIN_THROTTLE && !tcActive ? progressiveCue(rearNdSlip, REAR_SLIP_CUE_START, REAR_SLIP_CUE_END) : 0;
  return Math.max(front, rear);
}

/** How far ahead the shift cue reads the revs (s): time to react before the shift point */
export const SHIFT_LOOKAHEAD_S = 0.3;
/** Time constant of the rpm-rate smoothing (s) */
const SHIFT_RATE_TAU_S = 0.1;
/** After a shift (or a lift) the cue waits this long before it may come on again (s) */
const SHIFT_REARM_S = 0.1;
/** The cue stays off while the rears spin this far past their peak (the revs are not the car's speed) */
const SHIFT_MAX_REAR_ND = 1.5;

/** Shift warning: on once the revs, read {@link SHIFT_LOOKAHEAD_S} ahead, reach the shift point, until the next gear */
export class ShiftCue {
  on = false;
  private lastRpm = Number.NaN;
  private rateRpmS = 0;
  private lastGear = Number.NaN;
  private sinceResetS = 0;

  step(rpm: number, gear: number, throttle: number, rearNdSlip: number, shiftRpm: number, dtS: number): boolean {
    if (!finite(rpm) || !finite(gear) || !finite(shiftRpm) || shiftRpm <= 0) {
      this.reset();
      return false;
    }
    if (finite(this.lastRpm) && dtS > 0) {
      const a = 1 - Math.exp(-dtS / SHIFT_RATE_TAU_S);
      this.rateRpmS += ((rpm - this.lastRpm) / dtS - this.rateRpmS) * a;
    }
    this.lastRpm = rpm;
    const canShift = gear >= 1 && throttle > 0.01 && !(rearNdSlip > SHIFT_MAX_REAR_ND);
    if (gear !== this.lastGear || !canShift) {
      // A new gear's rpm drop must not read as a negative rate into the next one
      if (gear !== this.lastGear) this.rateRpmS = 0;
      this.lastGear = gear;
      this.on = false;
      this.sinceResetS = 0;
      return false;
    }
    this.sinceResetS += Math.max(0, dtS);
    if (!this.on && this.sinceResetS > SHIFT_REARM_S) {
      this.on = rpm + Math.max(0, this.rateRpmS) * SHIFT_LOOKAHEAD_S >= shiftRpm;
    }
    return this.on;
  }

  reset(): void {
    this.on = false;
    this.lastRpm = Number.NaN;
    this.rateRpmS = 0;
    this.lastGear = Number.NaN;
    this.sinceResetS = 0;
  }
}
