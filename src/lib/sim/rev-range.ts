/**
 * Where each car's rev lights sit: the dash, the HUD styles and the wheel's shift cue all call the shift at the same
 * rpm.
 */

/** Rev-light range per car: first LED and all-lit rpm (the Formula cars by default; the GT3's 7500 rpm shift point) */
export function revRangeFor(carId: string | undefined): [number, number] {
  return carId === "amg-gt3" ? [6200, 7500] : [10_800, 14_600];
}
