/**
 * How a car's steering and wheel spin travel in a pose (online peers, AI cars, ghosts and replays), so every sender
 * and the renderer agree on one encoding.
 */

/** Road-wheel angle (rad) a full-lock steer is sent as */
const STEER_LOCK_RAD = 0.36;
/** rad/s → rpm */
const RAD_S_TO_RPM = 60 / (2 * Math.PI);
/** Wheel radius (m) used to spin the wheels of a car that records only its speed (ghosts, replays) */
const NOMINAL_WHEEL_RADIUS_M = 0.36;

/** Grey of a ghost or replayed car with no team colour of its own */
export const GHOST_CAR_COLOR = "#9CA3AF";

/** Steering (-1…1) → the pose's road-wheel angle (rad) */
export const steerAngleOf = (steerNorm: number): number => steerNorm * STEER_LOCK_RAD;
/** The pose's road-wheel angle (rad) → steering (-1…1, unclamped) */
export const steerNormOf = (steerAngle: number): number => steerAngle / STEER_LOCK_RAD;
/** Wheel spin (rad/s) → rpm */
export const wheelRpmOf = (spinVelRadS: number): number => spinVelRadS * RAD_S_TO_RPM;
/** Wheel rpm of a car rolling at this speed, for one that records no wheel spin */
export const wheelRpmAtSpeed = (speedKmh: number): number => wheelRpmOf(speedKmh / 3.6 / NOMINAL_WHEEL_RADIUS_M);
