/**
 * Keyboard steering: a held key ramps the steering to a speed-dependent limit instead of full lock, and lets go back
 * to centre. The limit is the road-wheel angle that holds the car's cornering grip at this speed: the geometric
 * (Ackermann) angle for its lateral grip, L·a/v², plus the front tyres' slip angle at their grip peak. Past that angle
 * the fronts only scrub and heat up (#64); BeamNG's grip-aware steering limit works the same way.
 */

/** What a car can corner on: the keyboard holds the steering at the angle that uses it */
export interface SteeringEnvelope {
  /** Lateral acceleration the tyres hold at this speed, downforce included (m/s², dry) */
  maxLateralAccelMs2: number;
  /** Slip angle the front tyres steer past the car's path at the limit (rad) */
  frontSlipRad: number;
}

/** The VF26's keyboard limit, which it was tuned on (cars without their own envelope keep it) */
export const DEFAULT_STEERING_ENVELOPE: SteeringEnvelope = { maxLateralAccelMs2: 38, frontSlipRad: 0.12 };

/** Time for keyboard steering to reach its limit, and to recentre (s) */
export const KB_STEER_RISE_S = 0.22;
export const KB_STEER_RETURN_S = 0.14;

export interface KeyboardSteerCar {
  readonly wheelbaseM: number;
  readonly maxSteerAngleRad: number;
  steeringEnvelope?(): SteeringEnvelope;
}

/** Keyboard steering limit (0..1 of full lock) at `vFwdMs`, the grip scaled by `gripScale` (water) */
export function keyboardSteerLimit(car: KeyboardSteerCar, vFwdMs: number, gripScale = 1): number {
  const env = car.steeringEnvelope?.() ?? DEFAULT_STEERING_ENVELOPE;
  const v = Math.max(1, vFwdMs);
  const roadAngle = (car.wheelbaseM * env.maxLateralAccelMs2 * gripScale) / (v * v) + env.frontSlipRad;
  return Math.min(1, roadAngle / car.maxSteerAngleRad);
}

/**
 * One frame of keyboard steering: toward `dir` (−1 left, 0 none, +1 right) × `limit`, at a rate that covers the limit in
 * `riseS` (or `returnS` while recentring or reversing)
 */
export function stepKeyboardSteer(
  steer: number,
  dir: number,
  limit: number,
  dtS: number,
  riseS = KB_STEER_RISE_S,
  returnS = KB_STEER_RETURN_S
): number {
  const target = dir * limit;
  const recentring = target === 0 || target * steer < 0;
  const maxStep = (limit / (recentring ? returnS : riseS)) * dtS;
  return steer + Math.max(-maxStep, Math.min(maxStep, target - steer));
}
