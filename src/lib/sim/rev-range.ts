/**
 * Where each car's rev lights sit: the dash, the HUD styles and the wheel's shift cue all call the shift at the same
 * rpm.
 */
import { LC26_ENGINE } from "./lc26-data";

/** The shift beep sounds this far short of the car's rev limiter (rpm) */
export const SHIFT_BEEP_BELOW_LIMITER_RPM = 150;

/**
 * The 2026 Formula car's lights: the first at 10,500 rpm, where the fuel energy flow reaches its 3000 MJ/h cap
 * (FIA 2026 PU regulations, art. 5.4.3 / 5.4.4) [regulation], all lit at the shift beep, 150 rpm short of the
 * LC26's limiter. Its auto box upshifts at 12,200 rpm with 14 of 15 lit.
 */
const F1_REV_RANGE: [number, number] = [10_500, LC26_ENGINE.limiterRpm - SHIFT_BEEP_BELOW_LIMITER_RPM];

/**
 * Rev-light range per car: first LED and all-lit rpm (the Formula cars by default; the GT3's 7500 rpm shift point,
 * the Liana's 6500, the 496R's dash LEDs from 8000 to 9400)
 */
export function revRangeFor(carId: string | undefined): [number, number] {
  if (carId === "liana") return [5200, 6500];
  if (carId === "mtr-496r") return [8000, 9400];
  // The LC-LMDH up to the engine speed its regulated power curve is set on (the lights' last stage) [claim]
  if (carId === "lc-lmdh") return [6850, 8100];
  // The classic Nissans up to their shift lights or shift points [spec digital_instruments.ini, drivetrain.ini]
  if (carId === "nissan-r33-jgtc") return [5000, 6700];
  if (carId === "nissan-r32-jtcc") return [6300, 7500];
  // The M1's shift lamp: its LED series from 7500 rpm, full at 8400 [spec digital_instruments.ini]
  if (carId === "bmw-m1-procar") return [7500, 8400];
  // The Scirocco has no shift light: up to its 7000 rpm shift point [derived]
  if (carId === "vw-scirocco-gtx") return [5800, 7000];
  // The Chaparrals have no shift light: up to their 6700 rpm shift point [spec drivetrain.ini AUTO_SHIFTER UP]
  if (carId === "chaparral-2d" || carId === "chaparral-2d-67") return [5600, 6700];
  // The 934 has no shift light: up to its 7200 rpm shift point [spec drivetrain.ini AUTO_SHIFTER UP]
  if (carId === "porsche-934-rsr") return [6000, 7200];
  // The GT3 up to its 7250 rpm up-shift under the endurance trim's 7450 rpm limiter
  return carId === "amg-gt3" ? [5900, 7250] : [...F1_REV_RANGE];
}

/** A rev light's colour band: the HUD and the car's own wheel paint the same LED in the same band */
export type RevLedBand = "green" | "yellow" | "red" | "shift";

/** The band of LED `i` of `count` (15 lights: 5 green, 5 yellow, 3 red, 2 shift) */
export function revLedBand(i: number, count: number): RevLedBand {
  if (i < count / 3) return "green";
  if (i < (2 * count) / 3) return "yellow";
  if (i < (13 * count) / 15) return "red";
  return "shift";
}

/**
 * How many of `count` rev lights are lit at `rpm`, and whether the car is at its shift point (every light on): one
 * reading for the HUD, the car's wheel and the pad's lights, so they never disagree on where the shift is
 */
export function revLeds(rpm: number, [start, full]: readonly [number, number], count: number): { lit: number; atShift: boolean } {
  const r = Number.isFinite(rpm) ? rpm : 0;
  const lit = Math.max(0, Math.min(count, Math.round(((r - start) / (full - start)) * count)));
  return { lit, atShift: r >= full };
}
