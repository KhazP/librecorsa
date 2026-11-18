/**
 * Gyro steering: the DualSense turned like a steering wheel. The pad's tilt is tracked as the direction of gravity
 * in the pad's own frame: the gyro turns it at every report (smooth and quick), and the accelerometer pulls it back
 * toward the measured gravity a little at a time (no drift: a gyro bias only leaves a steady offset of bias ×
 * {@link GYRO_CORRECTION_S}). The steering angle is how far the pad's left-right axis leans from level, so it reads
 * the same with the pad held flat, tipped toward the player or upright, and turning it flat on the table (yaw) or
 * tipping it (pitch) steers nothing.
 *
 * Pure maths, no browser APIs: the WebHID drivers feed it every input report (each pad's own clock read by a
 * {@link SensorClock}), the verify suite feeds it bytes.
 */
import type { Vec3 } from "./dualsense-protocol";

const DEG = Math.PI / 180;

/** Time constant of the accelerometer's pull on the tracked gravity (s) */
export const GYRO_CORRECTION_S = 0.4;
/** A gap in the reports longer than this starts the tracking over from the accelerometer (s) */
export const GYRO_GAP_RESEED_S = 0.25;
/**
 * The accelerometer's pull is trusted fully while its reading stays within this much of 1 g on average, down to
 * {@link ACCEL_TRUST_FLOOR} past {@link ACCEL_TRUST_NONE_G}: the hands moving the pad, or the rumble shaking it. The
 * trust follows a smoothed deviation, never the single reading: a trust picked per reading would keep the shake's
 * low swings and drop its high ones, and lean the tracking over by many degrees
 */
const ACCEL_TRUST_FULL_G = 0.1;
const ACCEL_TRUST_NONE_G = 0.3;
const ACCEL_TRUST_FLOOR = 0.2;
/** Smoothing of that deviation (s): slow next to a shake, so the trust does not follow its swings */
const ACCEL_DEVIATION_S = 0.3;
/** A single reading pulls at most this far (g): a knock on the desk, not a lean */
const ACCEL_PULL_MAX_G = 1;
/** Readings this far from 1 g cannot start the tracking (g) */
const ACCEL_SEED_MAX_G = 0.3;

/** Tilt ignored around the centre (deg): the hands' own tremor */
export const GYRO_DEADZONE_DEG = 0.5;
/** Tilt for full lock (deg each way) and the centre response, the settings' ranges */
export const GYRO_LOCK_MIN_DEG = 10;
export const GYRO_LOCK_MAX_DEG = 90;
export const GYRO_SENSITIVITY_MIN = 0.5;
export const GYRO_SENSITIVITY_MAX = 1.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function normalized(v: Vec3): Vec3 | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** `v` turned by `angle` (rad) about the unit axis `k` (Rodrigues) */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const cx = k[1] * v[2] - k[2] * v[1];
  const cy = k[2] * v[0] - k[0] * v[2];
  const cz = k[0] * v[1] - k[1] * v[0];
  return [
    v[0] * c + cx * s + k[0] * dot * (1 - c),
    v[1] * c + cy * s + k[1] * dot * (1 - c),
    v[2] * c + cz * s + k[2] * dot * (1 - c),
  ];
}

/** How much the accelerometer is trusted, from its smoothed distance off 1 g */
function accelTrust(deviationG: number): number {
  return clamp((ACCEL_TRUST_NONE_G - deviationG) / (ACCEL_TRUST_NONE_G - ACCEL_TRUST_FULL_G), ACCEL_TRUST_FLOOR, 1);
}

/** One motion reading, as the tracker takes it */
export interface MotionSample {
  /** Rotation rate, deg/s, in the pad's frame (x right, y up out of the face, z toward the player) */
  gyroDps: Vec3;
  /** Acceleration, g, gravity included, same axes */
  accelG: Vec3;
  /** Seconds since the pad's previous reading; 0 or less (the first reading, after a gap) starts the tracking over */
  dtS: number;
  /** The re-centre control (the touchpad click) is held */
  recentreHeld: boolean;
}

/**
 * A pad's sensor clock: the seconds between two readings across the counter's wrap. Only when the wall clock says
 * at least a whole wrap went by is the step taken for a gap, whatever the counter says: a 16-bit clock wraps in a
 * third of a second, so a longer silence would read as a short step. A shorter wall-clock gap is the page stalling
 * (a shader compile, a collection) with the reports queued behind it, and the counter's step is the true one.
 */
export class SensorClock {
  private lastTicks: number | null = null;
  private lastWallMs: number | null = null;
  private readonly span: number;
  /** One turn of the counter (ms) */
  private readonly wrapMs: number;

  constructor(
    private readonly ticksPerS: number,
    bits: 16 | 32,
  ) {
    this.span = 2 ** bits;
    this.wrapMs = (this.span / ticksPerS) * 1000;
  }

  reset(): void {
    this.lastTicks = null;
    this.lastWallMs = null;
  }

  /** Seconds since the previous reading, or −1 for the first one and after a gap */
  step(ticks: number, wallMs?: number): number {
    const prev = this.lastTicks;
    const gap = wallMs !== undefined && this.lastWallMs !== null && wallMs - this.lastWallMs >= this.wrapMs;
    this.lastTicks = ticks;
    this.lastWallMs = wallMs ?? null;
    if (prev === null || gap) return -1;
    return ((((ticks - prev) % this.span) + this.span) % this.span) / this.ticksPerS;
  }
}

/** Tracks the pad's lean from its motion reports and holds the centre the steering is measured from */
export class PadTilt {
  /** Up, as a unit vector in the pad's frame; null until a usable reading */
  private up: Vec3 | null = null;
  /** The accelerometer's distance off 1 g, smoothed (g) */
  private deviationG = 0;
  /**
   * Readings since a start: until the usual pull is the stronger, each reading pulls by 1 / (readings + 1), so the
   * start is the average of every reading so far. A start from one shaken reading would be off by a few degrees,
   * which the usual pull takes seconds to take out
   */
  private settleReadings = 0;
  private centreDeg = 0;
  private centrePending = true;

  /** Forget the tracking; the next reading starts it again and becomes the centre */
  reset(): void {
    this.up = null;
    this.deviationG = 0;
    this.settleReadings = 0;
    this.centreDeg = 0;
    this.centrePending = true;
  }

  /** The pad's lean as it is now becomes the centre (straight away, or with the first reading) */
  recentre(): void {
    if (this.up) {
      this.centreDeg = this.rollDeg() ?? 0;
      this.centrePending = false;
    } else this.centrePending = true;
  }

  /** One motion reading. A held re-centre control keeps re-centring, so the centre is where it is let go */
  update(m: MotionSample): void {
    const a = m.accelG;
    const aMag = Math.hypot(a[0], a[1], a[2]);
    const dt = m.dtS;
    if (this.up === null || dt <= 0 || dt > GYRO_GAP_RESEED_S) {
      // Start (or start over after a gap) from gravity alone, once the reading looks like it
      this.up = Math.abs(aMag - 1) < ACCEL_SEED_MAX_G ? normalized(a) : null;
      this.deviationG = 0;
      this.settleReadings = 1;
    } else {
      // A direction fixed in the room, seen from the turning pad, turns the other way: up' = up × ω
      const w: Vec3 = [m.gyroDps[0] * DEG, m.gyroDps[1] * DEG, m.gyroDps[2] * DEG];
      const rate = Math.hypot(w[0], w[1], w[2]);
      let up = this.up;
      if (rate > 1e-9) up = rotate(up, [w[0] / rate, w[1] / rate, w[2] / rate], -rate * dt);
      this.deviationG += (Math.abs(aMag - 1) - this.deviationG) * (1 - Math.exp(-dt / ACCEL_DEVIATION_S));
      // Pulled toward the reading itself, not its direction: a shake that averages out then pulls nowhere
      const pull: Vec3 = [a[0] - up[0], a[1] - up[1], a[2] - up[2]];
      const pullMag = Math.hypot(pull[0], pull[1], pull[2]);
      const usual = accelTrust(this.deviationG) * (1 - Math.exp(-dt / GYRO_CORRECTION_S));
      let gain = usual;
      if (this.settleReadings > 0) {
        this.settleReadings++;
        const settle = 1 / this.settleReadings;
        if (settle > usual) gain = settle;
        else this.settleReadings = 0;
      }
      const k = gain * Math.min(1, ACCEL_PULL_MAX_G / Math.max(pullMag, 1e-9));
      up = [up[0] + k * pull[0], up[1] + k * pull[1], up[2] + k * pull[2]];
      this.up = normalized(up) ?? this.up;
    }
    if (this.up && (this.centrePending || m.recentreHeld)) {
      this.centreDeg = this.rollDeg() ?? 0;
      this.centrePending = false;
    }
  }

  /** How far the pad's right side leans down from level (deg, + = turned clockwise, to the right); null untracked */
  rollDeg(): number | null {
    const u = this.up;
    return u ? Math.atan2(-u[0], Math.hypot(u[1], u[2])) / DEG : null;
  }

  /** The lean from the centre (deg, + = right); null untracked */
  steerDeg(): number | null {
    const r = this.rollDeg();
    return r === null || this.centrePending ? null : r - this.centreDeg;
  }
}

/**
 * Steering −1..1 (+ = right) from the lean off centre: full lock at `lockDeg` each way, a small dead zone, and
 * `sensitivity` shaping the response (1 linear, below 1 calmer around the centre, above 1 sharper)
 */
export function gyroSteerValue(steerDeg: number, lockDeg: number, sensitivity = 1): number {
  const a = Math.abs(steerDeg);
  if (!Number.isFinite(a) || a <= GYRO_DEADZONE_DEG) return 0;
  const lock = clamp(lockDeg, GYRO_LOCK_MIN_DEG, GYRO_LOCK_MAX_DEG);
  const x = Math.min(1, (a - GYRO_DEADZONE_DEG) / (lock - GYRO_DEADZONE_DEG));
  const exponent = 1 / clamp(sensitivity, GYRO_SENSITIVITY_MIN, GYRO_SENSITIVITY_MAX);
  return Math.sign(steerDeg) * Math.pow(x, exponent);
}

/** The shaped stick and the gyro steer together: their sum, held to full lock */
export function combineStickAndGyro(stick: number, gyro: number | undefined): number {
  return gyro === undefined ? stick : clamp(stick + gyro, -1, 1);
}
