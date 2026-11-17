/**
 * Kerb hits: what the road's shape does to a tyre, read from its load. A tyre's load against its own mean over the last
 * few hundredths of a second (`KERB_HIT_TAU_S`) is the road hitting it: a kerb's ridges, slots and edges give a front
 * tyre hits of a kilonewton or so at the rate it crosses them (Willow Springs' slotted kerbs: 820 N rms against 170 N on
 * the asphalt beside them), while weight transfer and the car's own pitch and heave move slower than this passes.
 *
 * Both physics engines step one `KerbHitState` per tyre every sub-step; the pad's rumble and the DualSense read the
 * level and rate per side (`CarTelemetry.wheelKerbHit`, `kerbHitHz`), and the rigid-body rack feels each hit at the
 * front tyres' scrub radius (VehiclePhysics). Allocation-free.
 */

/** The load's mean is taken over this long (s): the hit is the load against it */
export const KERB_HIT_TAU_S = 0.02;
/**
 * The load itself is first smoothed over this long (s), past ~80 Hz: a tyre's own carcass and hub shake (an F1 front
 * at ~140 Hz) is not the road, and counted as hits it read as a kerb on plain asphalt
 */
export const KERB_HIT_FAST_TAU_S = 0.002;
/** A load hit of this share of the corner's static load reads as a full kerb hit (level 1) */
export const KERB_HIT_FULL_SHARE = 0.5;
/**
 * A kerb is felt while hits over this share of the corner's static load keep coming (within KERB_HIT_RATE_HOLD_S).
 * Below it is the asphalt's texture: at 0.15 the F1 2026 car's fronts felt Willow Springs' plain asphalt; its slotted
 * kerbs hit at 0.7-1 of the static load
 */
export const KERB_HIT_FELT_SHARE = 0.25;
/**
 * Hits count toward the rate from this lower share: the 2026 Prototype takes the same slots more softly, and at the
 * felt share it counted every other one
 */
export const KERB_HIT_COUNT_SHARE = 0.15;
/** The level is the hits' rms over about this long (s): steady across a kerb's ridges, gone soon after it */
export const KERB_HIT_LEVEL_TAU_S = 0.06;
/** With no counted hit for this long (s) the rate falls to zero */
export const KERB_HIT_RATE_HOLD_S = 0.25;
/** A hit level this high is felt in full */
export const KERB_FEEL_FULL_LEVEL = 0.8;

export interface KerbHitState {
  /** The load smoothed over KERB_HIT_FAST_TAU_S, and its mean over KERB_HIT_TAU_S (N) */
  loadFastN: number;
  loadMeanN: number;
  /** The load against that mean (N): the road's shape hitting the tyre */
  hitN: number;
  /** The hits' mean square over KERB_HIT_LEVEL_TAU_S (N²) */
  hitPowN2: number;
  /** How often counted hits come (Hz), the time since the last (s), and whether the load has dropped back since */
  hitRateHz: number;
  sinceHitS: number;
  armed: boolean;
  /** Hits over KERB_HIT_FELT_SHARE: the time since the last (s), how many in a row came within the hold of each other,
   *  and whether the load has dropped back since the last */
  sinceFeltS: number;
  feltRun: number;
  feltArmed: boolean;
}

export const createKerbHitState = (): KerbHitState => ({
  loadFastN: 0,
  loadMeanN: 0,
  hitN: 0,
  hitPowN2: 0,
  hitRateHz: 0,
  sinceHitS: 1,
  armed: true,
  sinceFeltS: 1,
  feltRun: 0,
  feltArmed: true,
});

/** One sub-step `h` (s) of a tyre at load `fzN` on `staticN`, its corner's static load; none in the air */
export function stepKerbHit(s: KerbHitState, fzN: number, grounded: boolean, staticN: number, h: number): void {
  const gate = KERB_HIT_COUNT_SHARE * staticN;
  s.loadFastN += (fzN - s.loadFastN) * (1 - Math.exp(-h / KERB_HIT_FAST_TAU_S));
  s.loadMeanN += (s.loadFastN - s.loadMeanN) * (1 - Math.exp(-h / KERB_HIT_TAU_S));
  s.hitN = grounded ? s.loadFastN - s.loadMeanN : 0;
  s.hitPowN2 += (s.hitN * s.hitN - s.hitPowN2) * (1 - Math.exp(-h / KERB_HIT_LEVEL_TAU_S));
  s.sinceHitS += h;
  s.sinceFeltS += h;
  if (s.hitN < 0) s.feltArmed = true;
  if (s.feltArmed && s.hitN > KERB_HIT_FELT_SHARE * staticN) {
    s.feltArmed = false;
    s.feltRun = s.sinceFeltS < KERB_HIT_RATE_HOLD_S ? s.feltRun + 1 : 1;
    s.sinceFeltS = 0;
  }
  // A hit counts once: on crossing the gate after the load has come back under its mean
  if (s.hitN < 0) s.armed = true;
  if (s.armed && s.hitN > gate) {
    s.armed = false;
    // The rate from the gap since the last hit, eased so one odd gap does not jump it
    const gapHz = 1 / Math.max(s.sinceHitS, 1e-3);
    s.hitRateHz = s.sinceHitS < KERB_HIT_RATE_HOLD_S ? (s.hitRateHz > 0 ? 0.6 * s.hitRateHz + 0.4 * gapHz : gapHz) : 0;
    s.sinceHitS = 0;
  } else if (s.sinceHitS > KERB_HIT_RATE_HOLD_S) {
    s.hitRateHz = 0;
  }
}

/** A tyre's hits' rms over the full-hit load (1 at KERB_HIT_FULL_SHARE), at most 1.5 */
export const rawKerbHitLevel = (s: KerbHitState, staticN: number): number =>
  staticN > 0 ? Math.min(1.5, Math.sqrt(s.hitPowN2) / (KERB_HIT_FULL_SHARE * staticN)) : 0;

/**
 * What a tyre feels of the road's shape, 0 (the asphalt) to 1 (a hard kerb): its hit level, while hard hits keep coming
 * (two or more over KERB_HIT_FELT_SHARE, each within KERB_HIT_RATE_HOLD_S of the last). One bump alone is the
 * suspension's to feel
 */
export const kerbHitLevel = (s: KerbHitState, staticN: number): number =>
  s.feltRun >= 2 && s.sinceFeltS < KERB_HIT_RATE_HOLD_S ? Math.min(1, rawKerbHitLevel(s, staticN) / KERB_FEEL_FULL_LEVEL) : 0;
