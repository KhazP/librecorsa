/**
 * Where each car's rev lights sit: the dash, the HUD styles and the wheel's shift cue all call the shift at the same
 * rpm.
 */

/**
 * Rev-light range per car: first LED and all-lit rpm (the Formula cars by default; the GT3's 7500 rpm shift point,
 * the Liana's 6500, the 496R's dash LEDs from 8000 to 9400)
 */
export function revRangeFor(carId: string | undefined): [number, number] {
  if (carId === "liana") return [5200, 6500];
  if (carId === "mtr-496r") return [8000, 9400];
  // The classic Nissans up to their shift lights or shift points [spec digital_instruments.ini, drivetrain.ini]
  if (carId === "nissan-r33-jgtc") return [5000, 6700];
  if (carId === "nissan-r32-jtcc") return [6300, 7500];
  return carId === "amg-gt3" ? [6200, 7500] : [10_800, 14_600];
}
