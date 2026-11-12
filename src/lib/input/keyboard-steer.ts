/**
 * Keyboard steering. A key is all or nothing, so it is not sent to the rack: its direction goes to the car's steering
 * assist (steering-assist.ts), which ramps it along an S-curve to the angle that holds the front tyres at their grip
 * (on turn-in and on the brakes as well as mid-corner), self-aligns the car when the key is let go and caps a
 * countersteer. A held key used to ramp in a straight line to a fixed angle worked out for steady cornering: on turn-in
 * and under braking that angle was past the fronts' grip, so they scrubbed and overheated (#64), and a tap was a
 * large share of the limit.
 *
 * Each car steers in along its own curve (`KeyboardSteerProfile`): how quickly a held key turns it in at low speed and
 * at high speed, and how quickly the steering lets go. The player's ramp times (Keyboard feel) scale that curve, for
 * every car alike.
 */

/** Default time settings for keyboard steering out of centre, and back to centre (s) */
export const KB_STEER_RISE_S = 0.22;
export const KB_STEER_RETURN_S = 0.14;

/** The assist's keyboard ramp speeds for the player's ramp times (1 = the defaults; a shorter time = quicker) */
export function keyboardRampScales(riseS: number, returnS: number): { riseScale: number; returnScale: number } {
  const scale = (def: number, s: number) => (Number.isFinite(s) && s > 0 ? def / s : 1);
  return { riseScale: scale(KB_STEER_RISE_S, riseS), returnScale: scale(KB_STEER_RETURN_S, returnS) };
}

/**
 * A car's own keyboard steering, as speeds relative to the keyboard's base ramp (1 = the base, > 1 quicker). The
 * steer-in speed moves from `lowSpeedRate` to `highSpeedRate` between `KB_LOW_SPEED_MS` and `KB_HIGH_SPEED_MS`.
 */
export interface KeyboardSteerProfile {
  /** Steer-in speed of a held key in slow corners */
  lowSpeedRate: number;
  /** Steer-in speed at high speed */
  highSpeedRate: number;
  /** Return-to-centre speed once the key is let go */
  returnRate: number;
}

/** The base ramp at every speed: a car without a curve of its own */
export const NEUTRAL_KEYBOARD_STEER: KeyboardSteerProfile = { lowSpeedRate: 1, highSpeedRate: 1, returnRate: 1 };

/** Speeds the car's curve moves between its slow-corner and its high-speed steer-in (m/s) */
export const KB_LOW_SPEED_MS = 60 / 3.6;
export const KB_HIGH_SPEED_MS = 200 / 3.6;

/** The car's steer-in speed at `speedMs`: eased between its slow-corner and high-speed rates (geometric blend) */
export function keyboardSteerSpeedRate(profile: KeyboardSteerProfile, speedMs: number): number {
  const { lowSpeedRate: lo, highSpeedRate: hi } = profile;
  if (lo === hi) return lo;
  const u = Math.min(1, Math.max(0, (speedMs - KB_LOW_SPEED_MS) / (KB_HIGH_SPEED_MS - KB_LOW_SPEED_MS)));
  const s = u * u * (3 - 2 * u);
  return lo * Math.pow(hi / lo, s);
}
