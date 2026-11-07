/**
 * Force-feedback post-processing adapted from Adam's FFB Toolbox (adam10603/AC-Adams-FFB-Toolbox, MIT, Adam D.).
 * The Toolbox shapes Assetto Corsa's FFB from AC's car data (ffbBase, predicted axle loads); these do the same jobs
 * from LibreCorsa's own telemetry, on the gained force the wheel plays (1 = full force).
 *
 * - Downforce compensation: the kingpin torque grows with the front axle load, so at speed the aero load makes an F1
 *   wheel far heavier than at a hairpin. Scaling by the aero-free share of that load takes the downforce back out.
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
