/**
 * Controller stick response: input −1..1 (+ = right) to output −1..1.
 * Inside the inner dead zone the output is 0; the outer dead zone reads full deflection a little before the stop;
 * linearity 1 is linear, above 1 finer near centre. The one curve for both the game and the setup screen's preview.
 */
export function shapeStick(x: number, deadzone: number, outer: number, linearity: number): number {
  const a = Math.abs(x);
  if (!(a > deadzone)) return 0;
  const u = Math.min(1, (a - deadzone) / Math.max(0.01, 1 - deadzone - outer));
  return Math.sign(x) * Math.pow(u, linearity);
}
