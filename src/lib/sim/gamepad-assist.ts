/**
 * Gamepad steering assist.
 *
 * A thumbstick has a few centimetres of travel and no force feedback, so mapping it straight to
 * the steering rack makes a 2026 F1 car nearly undrivable: a small twitch is several degrees of
 * road-wheel angle at 250 km/h, and nothing tells the player when the front tyres are saturated or
 * when to countersteer:
 *
 * - The stick is smoothed and then scaled to a steering *limit* rather than to the full lock. The
 *   limit is the road-wheel angle that puts the front tyres at (just under) their peak slip angle
 *   relative to the front axle's direction of travel, so full stick = maximum front grip at any speed.
 * - A self-steer force turns the wheels toward the rear axle's direction of travel (with yaw
 *   damping). It acts in full when the stick is centred and fades out as the player steers, the way
 *   a real steering wheel self-aligns when the driver relaxes their hands — this catches slides.
 * - When the player countersteers a slide, the limit switches to the rear axle's travel angle plus
 *   a margin, so a full-stick countersteer is a sensible correction instead of opposite lock.
 * - (Addition) A yaw-rate guard: when the car already rotates toward the steering side faster than
 *   its grip can turn it (r > a_y,max / v), the limit shrinks. Without it a held full-stick
 *   countersteer turns into a tank-slapper the moment the rear grips again.
 *
 * Conventions: steering + = right (same as `ControlInputs.analogSteer`), yaw rate + = right,
 * body lateral velocity + = left (F1Physics2026).
 */

export interface GamepadAssistCarState {
  /** Body longitudinal / lateral velocity (m/s, lateral + = left) */
  vxMs: number;
  vyMs: number;
  /** Yaw rate (rad/s, + = turning right) */
  yawRateRadS: number;
  cgToFrontAxleM: number;
  cgToRearAxleM: number;
  wheelbaseM: number;
  /** Road-wheel angle at full steering lock (rad) */
  maxSteerAngleRad: number;
  /** Front tyre peak slip angle (rad) */
  frontPeakSlipRad: number;
  /** Brake pedal 0..1 */
  brake: number;
  /** Lateral acceleration the tyres can sustain at this speed (m/s², including downforce) */
  maxLateralAccel: number;
}

export interface GamepadAssistSettings {
  /** Stick dead zone (rescaled) */
  deadzone: number;
  /** Stick smoothing rate multiplier (higher = quicker steering) */
  steeringRate: number;
  /** Fraction of the front peak slip angle used as the steering limit */
  targetSlip: number;
  /** Strength of the self-aligning (countersteer) force */
  selfSteerResponse: number;
  /** Yaw-rate damping of the self-steer force */
  dampingStrength: number;
  /** How far past the rear axle's travel angle a manual countersteer may go */
  countersteerResponse: number;
  /** How much the limit may shrink while the car is rotating away from the steering (0..10) */
  maxDynamicLimitReduction: number;
}

/** Defaults equal to the script's "filter 50 %" preset */
export const DEFAULT_GAMEPAD_ASSIST: GamepadAssistSettings = {
  deadzone: 0.05,
  steeringRate: 0.5,
  targetSlip: 0.95,
  selfSteerResponse: 0.37,
  dampingStrength: 0.37,
  countersteerResponse: 0.2,
  maxDynamicLimitReduction: 5,
};

const RAD2DEG = 180 / Math.PI;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpInvSat = (v: number, a: number, b: number) => clamp01((v - a) / (b - a));
const signedPow = (x: number, y: number) => Math.sign(x) * Math.pow(Math.abs(x), y);

/** Clamp with quadratic easing into the bounds over `window` (fraction of the range) */
function clampEased(v: number, lo: number, hi: number, window: number): number {
  const w = window * (hi - lo);
  const half = w * 0.5;
  if (v < lo - half) return lo;
  if (v > hi + half) return hi;
  if (v < lo + half) {
    const t = (v - (lo - half)) / w;
    return lo + t * t * half;
  }
  if (v > hi - half) {
    const t = (v - (hi - half) - w) / w;
    return hi - t * t * half;
  }
  return v;
}

/**
 * Moves toward a target at a rate proportional to the remaining distance (exponential), blended
 * with a constant-rate part by `linearity` (1 = purely linear). Rates are per second over the range.
 */
class SmoothTowards {
  state: number;
  private readonly range: number;

  constructor(
    private readonly rate: number,
    private readonly linearity: number,
    minValue: number,
    maxValue: number,
    private readonly start: number
  ) {
    this.range = maxValue - minValue;
    this.state = start;
  }

  get(target: number, dt: number, rateMult = 1): number {
    const lin2 = this.linearity * this.linearity;
    const rate = ((this.rate * rateMult) / (1 - 1 / (lin2 + 1 / 0.75))) * 0.5;
    const diff = Math.abs((target - this.state) / this.range);
    const adjusted = (diff * (1 - lin2) + lin2) * rate;
    this.state += Math.sign(target - this.state) * Math.min(diff, dt * adjusted) * this.range;
    return this.state;
  }

  reset(): void {
    this.state = this.start;
  }
}

export class GamepadSteeringAssist {
  settings: GamepadAssistSettings;

  private readonly steering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly absSteering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly selfSteer = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly limit = new SmoothTowards(11, 0.01, 0, 32, 32);
  private readonly counterIndicator = new SmoothTowards(12, 1, 0, 1, 0);

  constructor(settings: GamepadAssistSettings = DEFAULT_GAMEPAD_ASSIST) {
    this.settings = { ...settings };
  }

  reset(): void {
    this.steering.reset();
    this.absSteering.reset();
    this.selfSteer.reset();
    this.limit.reset();
    this.counterIndicator.reset();
  }

  /** Raw stick (−1 left .. +1 right) → steering command (−1..1, + = right) */
  update(rawStick: number, car: GamepadAssistCarState, dt: number): number {
    const cfg = this.settings;
    const lockDeg = car.maxSteerAngleRad * RAD2DEG;
    const wbFactor = car.wheelbaseM / 2.5;

    // Dead zone (rescaled so the response starts at zero)
    const mag = Math.abs(rawStick);
    const stick = mag <= cfg.deadzone ? 0 : (Math.sign(rawStick) * Math.min(1, mag - cfg.deadzone)) / (1 - cfg.deadzone);

    // Stick smoothing
    const initial = this.steering.get(stick, dt, cfg.steeringRate);
    const absInitial = this.absSteering.get(Math.abs(stick), dt, cfg.steeringRate);

    // Axle travel directions in the body frame (deg, + = moving to the right)
    const vx = Math.abs(car.vxMs);
    const vRightFront = -car.vyMs + car.yawRateRadS * car.cgToFrontAxleM;
    const vRightRear = -car.vyMs - car.yawRateRadS * car.cgToRearAxleM;
    const frontAngle = Math.atan2(vRightFront, vx) * RAD2DEG;
    const rearAngle = Math.atan2(vRightRear, vx) * RAD2DEG;
    const speed = Math.hypot(car.vxMs, car.vyMs);
    const frontSpeed = Math.hypot(car.vxMs, vRightFront);
    const assistFadeIn = lerpInvSat(frontSpeed, 2 * wbFactor, 6 * wbFactor);
    const midSpeedFade = lerpInvSat(speed, 10 * wbFactor, 20 * wbFactor);
    const inputSign = Math.sign(initial);

    // Self-steer: wheels follow the rear axle's direction of travel, plus yaw damping
    const exponent = 1 + (1 - Math.log10(10 * (cfg.selfSteerResponse * 0.9 + 0.1)));
    const correction = (signedPow(clamp(rearAngle / 72, -1, 1), exponent) * 72) / lockDeg;
    const damping = -car.yawRateRadS * cfg.dampingStrength * 0.15 * (30 / lockDeg);
    const rawSelfSteer = clampEased(correction, -1, 1, 1) + damping;
    const selfSteer = clamp(this.selfSteer.get(rawSelfSteer, dt), -2, 2) * assistFadeIn;

    // Steering limit that keeps the front tyres just under their peak slip angle
    const targetSlipDeg = car.frontPeakSlipRad * RAD2DEG * cfg.targetSlip;
    const maxLimitReduction = lerp(targetSlipDeg * 0.4, targetSlipDeg * 0.75, clamp01(cfg.maxDynamicLimitReduction / 10));
    const angleSubLimit = lerp(maxLimitReduction, maxLimitReduction * 0.9, car.brake);
    // Front axle travel angle *away* from the steering direction (outward = positive)
    const frontAway = clampEased(
      -inputSign * frontAngle,
      -lockDeg - 15,
      angleSubLimit,
      (angleSubLimit * 0.4) / (lockDeg + 15 + angleSubLimit)
    );

    // Countersteering: the player steers toward the side the rear is sliding to
    const isCountersteering = Math.abs(initial) > 1e-6 && inputSign === Math.sign(vRightRear);
    // Unclamped inverse lerp into the eased clamp (AGALib inverseLerpClampedEased): 0 under ≈2.9°, 1 past ≈11.6°
    const rawCounter = isCountersteering ? clampEased((Math.abs(rearAngle) - 4.5) / (10 - 4.5), 0, 1, 0.6) : 0;
    const returnRate = lerp(0.8, 0.3, lerpInvSat(Math.abs(frontAngle - rearAngle), 2, 10));
    const counter =
      this.counterIndicator.get(rawCounter, dt, rawCounter < this.counterIndicator.state ? returnRate : 1) * midSpeedFade;

    const rearToward = inputSign * rearAngle; // rear axle travel angle on the steering side
    const counterMult = lerp(lerpInvSat(rearToward, 0, 30) / 3 + 2 / 3, 1, cfg.countersteerResponse);
    // Yaw-rate guard: shrink the limit by the steering that the excess rotation corresponds to
    const yawTowardSteer = inputSign * car.yawRateRadS;
    const maxYawRate = (1.1 * car.maxLateralAccel) / Math.max(5, speed);
    const yawExcessDeg = (Math.max(0, yawTowardSteer - maxYawRate) * car.wheelbaseM * RAD2DEG) / Math.max(5, speed);
    const targetInward = targetSlipDeg - frontAway - 2.5 * yawExcessDeg;
    // Countersteer: align with the rear axle's travel (+ a margin), but never past the front tyres'
    // peak — on a quick left-right flick the rear still slides from the previous turn and would
    // otherwise read as a slide to catch, allowing far more lock than the front can use.
    const targetCounter = Math.min(
      targetSlipDeg * (cfg.countersteerResponse * counterMult * 0.7 + 0.1) + rearToward,
      targetInward
    );
    const targetAngle = lerp(clamp(targetInward, 0, lockDeg), clamp(targetCounter, 0, lockDeg), counter);

    // No limit when travelling sideways / backwards
    const travelDeg = Math.atan2(car.vyMs, car.vxMs) * RAD2DEG;
    const notForward = Math.pow(Math.sin(clamp(((travelDeg * 2) / 3) * (Math.PI / 180), -Math.PI / 2, Math.PI / 2)), 16);
    const limit = lerp(this.limit.get(targetAngle, dt) / lockDeg, 1, notForward);

    const processed = clamp(initial * limit + selfSteer - absInitial * selfSteer, -1, 1);
    return clamp(lerp(initial, processed, assistFadeIn), -1, 1);
  }
}
