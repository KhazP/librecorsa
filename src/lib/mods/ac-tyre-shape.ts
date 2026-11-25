/**
 * The brush tyre's peak drive slip, from AC's peak slip angle and CX_MULT.
 * XMU is the fullness of the rising force curve, not this slip ratio.
 */
export function peakDriveSlipRatio(angleDeg: number, longStiffnessMult: number): number {
  const angle = Number.isFinite(angleDeg) ? Math.min(45, Math.max(0.1, angleDeg)) : 7.5;
  const stiffness = Number.isFinite(longStiffnessMult) ? Math.max(0.1, longStiffnessMult) : 1;
  const theoretical = Math.min(0.8, Math.tan(angle * Math.PI / 180) / stiffness);
  return Number((theoretical / (1 - theoretical)).toFixed(4));
}
