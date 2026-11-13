/**
 * What a sliding tyre leaves behind: smoke and skid marks (0..1 each), from what its contact patch is doing.
 *
 * Both come from the heat of sliding friction: the load times the speed the tread slides over the road. That heat only
 * cooks and smears rubber once the patch is sliding as a whole, past the grip peak. Below the peak most of the patch
 * still grips and the slip is the carcass winding up, so a car on the limit in a clean corner neither smokes nor
 * marks the road, however high its load and slip speed. A locked wheel puts all that heat into the one patch of
 * rubber that stays on the road instead of spreading it round the tyre, so it smokes thickest and marks darkest for
 * its sliding power. A tyre lays rubber before it smokes: marks start at a lower heat than smoke.
 *
 * Measured on the rigid-body cars (LC26, AMG GT3, MTR 496R, Liana) by `scripts/verify-tyre-slide-fx.ts`: a clean
 * steer ramp to peak lateral g reaches normalised slip ≈ 1.0–1.6 and 10–50 kW of load × slip speed; a locked wheel
 * slides at road speed with normalised slip in the thousands, 20–300 kW.
 */

/** Normalised combined slip (1 = the grip peak) where the patch starts to slide as a whole, and where it all does */
export const SLIDE_START = 1.1;
export const SLIDE_FULL = 2.0;
/** A locked tyre's heat stays in one patch: its sliding power counts this much more */
export const LOCK_CONCENTRATION = 3;
/** Below this load (N) the tyre barely presses on the road: no smoke, no marks */
export const MIN_LOAD_N = 300;
/** Sliding heat (kW, `tyreSlideHeatKw`) for the first wisp of smoke and for full smoke */
export const SMOKE_HEAT_START_KW = 25;
export const SMOKE_HEAT_FULL_KW = 150;
/** Sliding heat (kW) for the first faint skid mark and for the darkest */
export const MARK_HEAT_START_KW = 12;
export const MARK_HEAT_FULL_KW = 90;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Share of its road speed a braked wheel has stopped turning (0 = rolling freely or driving, 1 = locked), from the
 * rim's speed less the road's at the contact (`slipVelX`, m/s) and the road's (`roadVx`, m/s)
 */
export function lockShareOf(slipVelX: number, roadVx: number): number {
  return Math.min(1, Math.max(0, -slipVelX / Math.max(3, Math.abs(roadVx))));
}

/**
 * Heat of a tyre's sliding (kW): load × sliding speed, for the share of the patch that slides, a locked tyre's
 * multiplied by its concentration
 * @param fzN tyre load (N)
 * @param combinedSlipNorm normalised combined slip (1 = the grip peak)
 * @param slideSpeedMs speed of the tread over the road at the contact (m/s)
 * @param lockShare 0..1, `lockShareOf`
 */
export function tyreSlideHeatKw(fzN: number, combinedSlipNorm: number, slideSpeedMs: number, lockShare: number): number {
  if (!(fzN > MIN_LOAD_N) || !(slideSpeedMs > 0)) return 0;
  const sliding = smoothstep(SLIDE_START, SLIDE_FULL, combinedSlipNorm);
  if (sliding <= 0) return 0;
  return (fzN * slideSpeedMs * sliding * (1 + LOCK_CONCENTRATION * lockShare)) / 1000;
}

/** Smoke level 0..1 of a dry tyre (arguments as `tyreSlideHeatKw`) */
export function tyreSmokeLevel(fzN: number, combinedSlipNorm: number, slideSpeedMs: number, lockShare: number): number {
  return smoothstep(SMOKE_HEAT_START_KW, SMOKE_HEAT_FULL_KW, tyreSlideHeatKw(fzN, combinedSlipNorm, slideSpeedMs, lockShare));
}

/** Skid-mark darkness 0..1 a tyre lays on a paved surface (arguments as `tyreSlideHeatKw`) */
export function tyreMarkLevel(fzN: number, combinedSlipNorm: number, slideSpeedMs: number, lockShare: number): number {
  return smoothstep(MARK_HEAT_START_KW, MARK_HEAT_FULL_KW, tyreSlideHeatKw(fzN, combinedSlipNorm, slideSpeedMs, lockShare));
}
