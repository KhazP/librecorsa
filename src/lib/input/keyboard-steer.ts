/**
 * Keyboard steering. A key is all or nothing, so it is not sent to the rack: its direction goes to the car's steering
 * assist (steering-assist.ts), which ramps it along an S-curve to the angle that holds the front tyres at their grip
 * (on turn-in and on the brakes as well as mid-corner), self-aligns the car when the key is let go and caps a
 * countersteer. A held key used to ramp in a straight line to a fixed angle worked out for steady cornering: on turn-in
 * and under braking that angle was past the fronts' grip, so they scrubbed and overheated (#64), and a tap was a
 * large share of the limit.
 *
 * The player's ramp times (Keyboard feel) scale the assist's keyboard ramp against these defaults.
 */

/** Default time settings for keyboard steering out of centre, and back to centre (s) */
export const KB_STEER_RISE_S = 0.22;
export const KB_STEER_RETURN_S = 0.14;

/** The assist's keyboard ramp speeds for the player's ramp times (1 = the defaults; a shorter time = quicker) */
export function keyboardRampScales(riseS: number, returnS: number): { keyboardRiseScale: number; keyboardReturnScale: number } {
  const scale = (def: number, s: number) => (Number.isFinite(s) && s > 0 ? def / s : 1);
  return { keyboardRiseScale: scale(KB_STEER_RISE_S, riseS), keyboardReturnScale: scale(KB_STEER_RETURN_S, returnS) };
}
