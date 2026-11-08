/**
 * Steering-axis torque of a front tyre (`src/lib/sim/f12026-car/steering-torque.ts`), used by `VehiclePhysics` for
 * the rack / force-feedback torque.
 *
 * The contact patch comes from the brush model with a rectangular patch of half-length a and half-width b:
 * - pneumatic trail at zero slip t0 = a/3 (parabolic pressure).
 */

/** Contact-patch half-length (m) of a tyre of radius `radiusM` pressed `deflectionM` into the road: the chord √(2Rδ − δ²) */
export function contactHalfLengthM(radiusM: number, deflectionM: number): number {
  const d = Math.min(Math.max(0, deflectionM), radiusM);
  return Math.sqrt(2 * radiusM * d - d * d);
}
