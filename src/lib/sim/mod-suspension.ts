/**
 * Suspension data that measures from the design position (Assetto Corsa compatible car data), turned into what
 * `VehiclePhysics` works with: travel from static ride.
 *
 * Such data gives a corner's hub height `d` from the position the hardpoints are drawn at (+ = compressed), and:
 *  - the spring works on `d + ROD_LENGTH` (the rod length is its preload: a longer rod raises the car), so at static
 *    ride the spring (and the axle's heave spring, on its own rod length, shared by the two wheels) carries the corner's
 *    sprung load at some `d` that is rarely zero;
 *  - the packers engage where `d + ROD_LENGTH` passes PACKER_RANGE;
 *  - the bump stops engage where `d` itself passes BUMPSTOP_UP, or falls below −BUMPSTOP_DN;
 *  - the CG sits the tyre's loaded radius less (BASEY + d) above the road, BASEY being the wheel centre's height in
 *    the body's frame (negative: below the CG).
 */

export interface ModCornerData {
  /** Sprung load the corner's springs carry at static ride (N) */
  staticLoadN: number;
  /** SPRING_RATE (N/m at the wheel) and ROD_LENGTH (m) */
  springRate: number;
  rodLength: number;
  /** PACKER_RANGE, BUMPSTOP_UP, BUMPSTOP_DN (m) */
  packerRange: number;
  bumpStopUp: number;
  bumpStopDn: number;
  /** The axle's heave element: its SPRING_RATE, ROD_LENGTH, PACKER_RANGE and BUMPSTOP_UP */
  heave?: { springRate: number; rodLength: number; packerRange: number; bumpStopUp: number };
}

export interface ModCornerStops {
  /** Hub height from the design position at static ride (m, + = compressed) */
  staticOffsetM: number;
  /** Compression from static ride at which the packers, then the bump stop, engage (m) */
  packerGapM: number;
  bumpStopGapM: number;
  /** Extension from static ride at which the droop stop engages (m) */
  droopM: number;
  /** The heave element's packer and bump-stop gaps from static ride (m); NaN without a heave element */
  heavePackerGapM: number;
  heaveBumpStopGapM: number;
}

/** A corner's stops from static ride. The springs are taken as linear about static (their progressive terms are small) */
export function modCornerStops(c: ModCornerData): ModCornerStops {
  // Static balance: load = k·(d + rod) + ½·k_heave·(d + rod_heave)
  const kHeave = c.heave ? 0.5 * c.heave.springRate : 0;
  const d = (c.staticLoadN - c.springRate * c.rodLength - kHeave * (c.heave?.rodLength ?? 0)) / (c.springRate + kHeave);
  return {
    staticOffsetM: d,
    packerGapM: c.packerRange - c.rodLength - d,
    bumpStopGapM: c.bumpStopUp - d,
    droopM: c.bumpStopDn + d,
    heavePackerGapM: c.heave ? c.heave.packerRange - c.heave.rodLength - d : NaN,
    heaveBumpStopGapM: c.heave ? c.heave.bumpStopUp - d : NaN,
  };
}

/**
 * Height of the body's origin (its CG, in such data) above the road at an axle: the tyre's loaded radius less the wheel
 * centre's height in the body frame at static ride (BASEY + the static offset)
 */
export function modBodyHeightM(tyreRadiusM: number, tyreDeflectionM: number, baseY: number, staticOffsetM: number): number {
  return tyreRadiusM - tyreDeflectionM - (baseY + staticOffsetM);
}
