/**
 * Steering assist for the keyboard and the controller.
 *
 * Neither a thumbstick nor a pair of keys can be driven like a steering wheel: a stick has a few centimetres of travel
 * and no force feedback, and a key is all or nothing. Mapped straight to the steering rack, a small twitch is several
 * degrees of road-wheel angle at 250 km/h, a held key scrubs the front tyres far past their grip (#64), and nothing
 * tells the player when the fronts are saturated or when to countersteer. This assist turns either input into the
 * steering a driver with a wheel would use:
 *
 * - Input shaping. A key goes through two smoothers in a row: a linear ramp (quicker back to centre than out of it)
 *   and the same rounded smoother the stick goes through. A short tap therefore only nudges the car while a held key
 *   rolls on to the limit along an S-curve, instead of reaching it in a straight line. The smoothing rate can rise or
 *   fall with speed (`rateIncreaseWithSpeed`), and at a low rate the steering still returns to centre at least at
 *   half speed so it never feels like it lags on the way back.
 * - Grip limit. Full input is scaled to a steering *limit* rather than to the full lock: the road-wheel angle that puts
 *   the front tyres at (just under) their peak slip angle relative to the front axle's direction of travel, so full
 *   input = maximum front grip at any speed, on turn-in and on the brakes as much as mid-corner. The peak slip angle
 *   starts from the tyre data and is then learned from the tyres' measured slip while cornering (`PeakSlipEstimator`).
 * - Self-steer. A force turns the wheels toward the rear axle's direction of travel (with yaw damping). It acts in full
 *   when the input is centred and fades out as the player steers, the way a real steering wheel self-aligns when the
 *   driver relaxes their hands: a released key straightens the car smoothly and catches slides.
 * - Countersteer. When the player steers into a slide the limit switches to the rear axle's travel angle plus a margin,
 *   so a full countersteer is a sensible correction instead of opposite lock.
 * - Yaw-rate guard. When the car already rotates toward the steering side faster than its grip can turn it
 *   (r > a_y,max / v) the limit shrinks. Without it a held countersteer turns into a tank-slapper the moment the rear
 *   grips again.
 * - Keyboard slide catch. A key cannot ease off or countersteer by degrees, so when the rear slides out past its grip
 *   while a key still steers into the turn, the key hands over to the self-steer force until the rear grips again.
 *
 * The cars' steering racks are linear (road-wheel angle = input × lock), so no input-to-angle curve is needed.
 *
 * Conventions: steering + = right (same as `ControlInputs.analogSteer`), yaw rate + = right, body lateral velocity
 * + = left (F1Physics2026).
 */

/** What the front and rear tyres are doing, load-weighted per axle (from the car's telemetry) */
export interface AxleSlipSample {
  /** Front slip angle magnitude (deg) */
  frontSlipDeg: number;
  /** Normalised combined slip (1 = the tyres' peak) */
  frontNdSlip: number;
  rearNdSlip: number;
  /** Load-weighted normalised slip of all four tyres */
  totalNdSlip: number;
  /** Larger front longitudinal slip ratio magnitude */
  frontSlipRatioAbs: number;
  /** The fronts are on the road surface (not a kerb, grass or run-off) */
  frontOnRoad: boolean;
  /** At least one front tyre carries load */
  frontGrounded: boolean;
}

export interface SteeringAssistCarState {
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
  /** Front tyre peak slip angle from the tyre data (rad): the starting point of the learned peak */
  frontPeakSlipRad: number;
  /** Brake pedal 0..1 */
  brake: number;
  /** Lateral acceleration the tyres can sustain at this speed (m/s², including downforce) */
  maxLateralAccel: number;
  /** Measured tyre slip, for learning the fronts' real peak slip angle; absent = the data's peak is used */
  slip?: AxleSlipSample;
}

export interface DeviceAssistResolved {
  selfSteerResponse: number;
  dampingStrength: number;
  maxSelfSteerAngleDeg: number;
  maxDynamicLimitReduction: number;
  countersteerResponse: number;
  targetSlip: number;
}

export interface SteeringAssistSettings extends DeviceAssistResolved {
  /** Stick dead zone (rescaled) */
  deadzone: number;
  /** Controller smoothing rate multiplier (higher = quicker steering) */
  steeringRate: number;
  /** Smoothing rate multiplier while the keyboard steers */
  keyboardRate: number;
  /** Keyboard ramp speed out of centre / back to centre, relative to the defaults (higher = quicker) */
  keyboardRiseScale: number;
  keyboardReturnScale: number;
  /** Change of the controller's smoothing rate with speed: + quicker, − slower at speed (−0.5..0.5) */
  rateIncreaseWithSpeed: number;
  /**
   * The same for the keyboard. Lower than the controller's: a key cannot steer by degrees, so at speed it steers in
   * more slowly and a tap stays a nudge, while it stays quick in slow corners
   */
  keyboardRateIncreaseWithSpeed: number;
  /** Optional separate assist tuning applied when the keyboard is steering (falls back to the top-level fields) */
  keyboardAssist?: DeviceAssistResolved;
}

/** Per-device steering assist sliders exposed in the Keyboard and Controller settings */
export interface DeviceAssistTuning {
  /** Self-aligning & countersteer strength, 0..1 (0.5 = default) */
  selfSteerStrength: number;
  /** Yaw-rate damping strength, 0..1 (0.5 = default) */
  dampingStrength: number;
  /** High-speed steering rate calm, 0..1 (0.5 = default) */
  speedSensitivity: number;
  /** Front peak slip limit offset, −0.25..0.25 (0 = default; negative = safer margin, positive = sharper bite) */
  slipLimitMargin: number;
  /** Maximum automatic countersteer road-wheel angle (deg, 5..30, default 25) */
  maxSelfSteerAngleDeg: number;
}

export const DEFAULT_DEVICE_ASSIST_TUNING: DeviceAssistTuning = {
  selfSteerStrength: 0.5,
  dampingStrength: 0.5,
  speedSensitivity: 0.5,
  slipLimitMargin: 0,
  maxSelfSteerAngleDeg: 25,
};

/** Converts a device's user-facing assist sliders into internal `SteeringAssist` coefficients */
export function deviceAssistTuning(
  tuning: DeviceAssistTuning
): DeviceAssistResolved & Pick<SteeringAssistSettings, "rateIncreaseWithSpeed" | "keyboardRateIncreaseWithSpeed"> {
  const s = Math.min(1, Math.max(0, tuning.selfSteerStrength));
  const d = Math.min(1, Math.max(0, tuning.dampingStrength));
  const spd = Math.min(1, Math.max(0, tuning.speedSensitivity));
  const margin = Math.min(0.25, Math.max(-0.25, tuning.slipLimitMargin));
  return {
    rateIncreaseWithSpeed: (1 - spd) * 0.2 - 0.1,
    keyboardRateIncreaseWithSpeed: (1 - spd) * 0.2 - 0.35,
    selfSteerResponse: s * 0.5 + 0.12,
    dampingStrength: d * 0.5 + 0.12,
    maxSelfSteerAngleDeg: Math.min(90, Math.max(5, tuning.maxSelfSteerAngleDeg)),
    maxDynamicLimitReduction: 3 * s + 3.5,
    countersteerResponse: (1 - s) * 0.2 + 0.1,
    targetSlip: Math.min(1.25, Math.max(0.65, 0.95 - (s - 0.5) * 0.04 + margin)),
  };
}

/** Default "Steering assistance" level (0 = least processing, 1 = most) */
export const DEFAULT_STEERING_ASSIST_LEVEL = 0.5;

/**
 * The tuning a single "Steering assistance" level stands for: more assistance = a stronger self-steer and damping,
 * more limit reduction when the car oversteers, a gentler countersteer and slower steering at speed.
 */
export function steeringAssistTuning(
  level: number
): Pick<
  SteeringAssistSettings,
  | 'rateIncreaseWithSpeed'
  | 'keyboardRateIncreaseWithSpeed'
  | 'selfSteerResponse'
  | 'dampingStrength'
  | 'maxSelfSteerAngleDeg'
  | 'maxDynamicLimitReduction'
  | 'countersteerResponse'
  | 'targetSlip'
> {
  const f = Math.min(1, Math.max(0, level));
  return deviceAssistTuning({
    selfSteerStrength: f,
    dampingStrength: f,
    speedSensitivity: f,
    slipLimitMargin: 0,
    maxSelfSteerAngleDeg: 90,
  });
}

/** Defaults: the middle "Steering assistance" level */
export const DEFAULT_STEERING_ASSIST: SteeringAssistSettings = {
  deadzone: 0.05,
  steeringRate: 0.5,
  keyboardRate: 0.5,
  keyboardRiseScale: 1,
  keyboardReturnScale: 1,
  ...steeringAssistTuning(DEFAULT_STEERING_ASSIST_LEVEL),
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

/**
 * The front tyres' peak slip angle, learned while cornering. It starts at the tyre data's peak and moves toward the
 * slip angle the tyres reach divided by their normalised slip (the angle at which the normalised slip would be 1), so
 * camber, load, temperature and pressure effects that move the real peak are followed. It only learns while the fronts
 * corner near their grip on the road with almost no longitudinal slip (braking or wheelspin would read low), and
 * restarts from the data when the data's peak changes (a new compound).
 */
export class PeakSlipEstimator {
  private readonly smoother = new SmoothTowards(0.12, 0.05, 0, 15, 0);
  private baseDeg = Number.NaN;
  private fastLearningS = 0;

  /** Learned peak slip angle (deg) */
  get deg(): number {
    return this.smoother.state;
  }

  update(baseDeg: number, slip: AxleSlipSample | undefined, initialSteering: number, fwdVelMs: number, dt: number): number {
    if (!(Math.abs(baseDeg - this.baseDeg) < 1e-6)) {
      this.baseDeg = baseDeg;
      this.smoother.state = baseDeg;
      this.fastLearningS = 0;
    }
    if (
      slip &&
      slip.frontNdSlip > 0.25 &&
      slip.frontNdSlip < 1.5 &&
      fwdVelMs > 8 &&
      slip.rearNdSlip > 0.1 &&
      slip.rearNdSlip < 1.5 &&
      slip.frontOnRoad &&
      slip.frontGrounded &&
      Math.abs(initialSteering) > 0.6 &&
      slip.frontSlipRatioAbs < 0.03
    ) {
      let rateMult = 1;
      if (this.fastLearningS < 1.5) {
        this.fastLearningS += dt;
        rateMult = 4;
      }
      const ideal = clamp(slip.frontSlipDeg / slip.frontNdSlip, 4, 14);
      this.smoother.get(ideal, dt, rateMult);
    }
    return this.smoother.state;
  }
}

/** One tyre's state, for the axle slip sample */
export interface WheelSlip {
  /** Vertical load (N) */
  loadN: number;
  /** Slip angle (rad, either sign) */
  slipAngleRad: number;
  /** Normalised combined slip (1 = the peak) */
  ndSlip: number;
  /** Longitudinal slip ratio (either sign) */
  slipRatio: number;
  /** On the road surface (not a kerb, grass or run-off) */
  onRoad: boolean;
}

export const createWheelSlip = (): WheelSlip => ({ loadN: 0, slipAngleRad: 0, ndSlip: 0, slipRatio: 0, onRoad: true });

export const createAxleSlipSample = (): AxleSlipSample => ({
  frontSlipDeg: 0,
  frontNdSlip: 0,
  rearNdSlip: 0,
  totalNdSlip: 0,
  frontSlipRatioAbs: 0,
  frontOnRoad: true,
  frontGrounded: true,
});

/** Load-weighted average of two wheels (plain average when neither is loaded) */
function weighted(a: number, b: number, wa: number, wb: number): number {
  const w = wa + wb;
  return w > 1e-6 ? (a * wa + b * wb) / w : 0.5 * (a + b);
}

/** Per-axle slip of the four tyres (front left, front right, rear left, rear right), written into `out` */
export function axleSlip(fl: WheelSlip, fr: WheelSlip, rl: WheelSlip, rr: WheelSlip, out: AxleSlipSample = createAxleSlipSample()): AxleSlipSample {
  const lfl = Math.max(0, fl.loadN);
  const lfr = Math.max(0, fr.loadN);
  const lrl = Math.max(0, rl.loadN);
  const lrr = Math.max(0, rr.loadN);
  const total = lfl + lfr + lrl + lrr;
  out.frontSlipDeg = weighted(Math.abs(fl.slipAngleRad), Math.abs(fr.slipAngleRad), lfl, lfr) * RAD2DEG;
  out.frontNdSlip = weighted(fl.ndSlip, fr.ndSlip, lfl, lfr);
  out.rearNdSlip = weighted(rl.ndSlip, rr.ndSlip, lrl, lrr);
  out.totalNdSlip =
    total > 1e-6
      ? (fl.ndSlip * lfl + fr.ndSlip * lfr + rl.ndSlip * lrl + rr.ndSlip * lrr) / total
      : 0.25 * (fl.ndSlip + fr.ndSlip + rl.ndSlip + rr.ndSlip);
  out.frontSlipRatioAbs = Math.max(Math.abs(fl.slipRatio), Math.abs(fr.slipRatio));
  out.frontOnRoad = fl.onRoad && fr.onRoad;
  out.frontGrounded = lfl > 1 || lfr > 1;
  return out;
}

/** Telemetry the axle slip can be read from (CarTelemetry satisfies it); wheel order FL, FR, RL, RR */
export interface AxleSlipTelemetry {
  tireSlipRatio?: readonly number[];
  wheelSlipAnglesDeg?: readonly number[];
  wheelLoadsN?: readonly number[];
  wheelSlipRatios?: readonly number[];
}

const _telemetryWheels = [createWheelSlip(), createWheelSlip(), createWheelSlip(), createWheelSlip()] as const;

/** Per-axle slip from a car's telemetry (the surface is not known there: the fronts count as on the road) */
export function axleSlipFromTelemetry(t: AxleSlipTelemetry, out: AxleSlipSample = createAxleSlipSample()): AxleSlipSample {
  for (let i = 0; i < 4; i++) {
    const o = _telemetryWheels[i];
    o.loadN = t.wheelLoadsN?.[i] ?? 0;
    o.slipAngleRad = (t.wheelSlipAnglesDeg?.[i] ?? 0) / RAD2DEG;
    o.ndSlip = t.tireSlipRatio?.[i] ?? 0;
    o.slipRatio = t.wheelSlipRatios?.[i] ?? 0;
    o.onRoad = true;
  }
  return axleSlip(_telemetryWheels[0], _telemetryWheels[1], _telemetryWheels[2], _telemetryWheels[3], out);
}

/**
 * Smoothing rate multiplier: the setting's rate, scaled with speed by `rateIncreaseWithSpeed` (the ratio of the lock
 * to the angle a car needs at this speed grows with speed, so a positive exponent quickens and a negative one slows
 * the steering as the car goes faster)
 */
export function steeringRateMult(speedMs: number, lockDeg: number, rate: number, rateIncreaseWithSpeed: number): number {
  const speedAdjusted = lockDeg / Math.min(65 / (Math.max(speedMs, 8) - 7.3) + 3.5, lockDeg);
  return Math.pow(speedAdjusted, rateIncreaseWithSpeed) * rate;
}

export class SteeringAssist {
  settings: SteeringAssistSettings;

  private readonly keyboard = new SmoothTowards(7, 1, -1, 1, 0);
  private readonly steering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly absSteering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly selfSteer = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly limit = new SmoothTowards(11, 0.01, 0, 32, 32);
  private readonly counterIndicator = new SmoothTowards(12, 1, 0, 1, 0);
  private readonly slideCatch = new SmoothTowards(12, 1, 0, 1, 0);
  /** The fronts' peak slip angle, learned while cornering; kept across resets (it belongs to the tyres) */
  readonly peakSlip = new PeakSlipEstimator();

  constructor(settings: SteeringAssistSettings = DEFAULT_STEERING_ASSIST) {
    this.settings = { ...settings };
  }

  /** The keyboard is steering, or its ramp has not yet settled back to centre */
  get keyboardEngaged(): boolean {
    return Math.abs(this.keyboard.state) > 1e-4;
  }

  reset(): void {
    this.keyboard.reset();
    this.steering.reset();
    this.absSteering.reset();
    this.selfSteer.reset();
    this.limit.reset();
    this.counterIndicator.reset();
    this.slideCatch.reset();
  }

  /**
   * Stick (−1 left .. +1 right, 0 without a controller) and keys (−1 left, 0, +1 right) → steering command
   * (−1..1, + = right)
   */
  update(rawStick: number, keys: number, car: SteeringAssistCarState, dt: number): number {
    const cfg = this.settings;
    const lockDeg = car.maxSteerAngleRad * RAD2DEG;
    const wbFactor = car.wheelbaseM / 2.5;
    const speed = Math.hypot(car.vxMs, car.vyMs);

    // Dead zone (rescaled so the response starts at zero)
    const mag = Math.abs(rawStick);
    const stick = mag <= cfg.deadzone ? 0 : (Math.sign(rawStick) * Math.min(1, mag - cfg.deadzone)) / (1 - cfg.deadzone);

    // Keyboard: a linear ramp first, quicker back to centre (and through it) than out of it
    const kbDir = Math.sign(keys);
    const kbRateMult = steeringRateMult(speed, lockDeg, cfg.keyboardRate, cfg.keyboardRateIncreaseWithSpeed);
    const kbState = this.keyboard.state;
    const kbCentring = Math.abs(kbState) - Math.sign(kbState) * kbDir > 0;
    const kb = this.keyboard.get(kbDir, dt, kbRateMult * (kbCentring ? 1.5 * cfg.keyboardReturnScale : cfg.keyboardRiseScale));
    const keyboardActive = kbDir !== 0 || Math.abs(kb) > 1e-4;

    // Then the rounded smoother both inputs share
    const raw = clamp(stick + kb, -1, 1);
    const rateMult = keyboardActive ? kbRateMult : steeringRateMult(speed, lockDeg, cfg.steeringRate, cfg.rateIncreaseWithSpeed);
    // Under half rate the return to centre stays at least as quick as at half rate
    let centringRate = 1;
    if (rateMult > 0 && rateMult < 0.5) {
      const st = this.steering.state;
      if ((Math.abs(raw) < Math.abs(st) && Math.sign(raw) === Math.sign(st)) || Math.sign(raw) !== Math.sign(st)) {
        centringRate = (rateMult * 0.5 + 0.25) / rateMult;
      }
    }
    const initial = this.steering.get(raw, dt, rateMult * centringRate);
    const absInitial = this.absSteering.get(Math.abs(raw), dt, rateMult * centringRate);

    // Axle travel directions in the body frame (deg, + = moving to the right)
    const vx = Math.abs(car.vxMs);
    const vRightFront = -car.vyMs + car.yawRateRadS * car.cgToFrontAxleM;
    const vRightRear = -car.vyMs - car.yawRateRadS * car.cgToRearAxleM;
    const frontAngle = Math.atan2(vRightFront, vx) * RAD2DEG;
    const rearAngle = Math.atan2(vRightRear, vx) * RAD2DEG;
    const frontSpeed = Math.hypot(car.vxMs, vRightFront);
    const assistFadeIn = lerpInvSat(frontSpeed, 2 * wbFactor, 6 * wbFactor);
    const midSpeedFade = lerpInvSat(speed, 10 * wbFactor, 20 * wbFactor);
    const inputSign = Math.sign(initial);

    // The fronts' peak slip angle: the data's, refined by what the tyres show while cornering
    const peakDeg = this.peakSlip.update(car.frontPeakSlipRad * RAD2DEG, car.slip, initial, Math.max(0, car.vxMs), dt);

    // Self-steer: wheels follow the rear axle's direction of travel, plus yaw damping
    const active = keyboardActive && cfg.keyboardAssist ? cfg.keyboardAssist : cfg;
    const exponent = 1 + (1 - Math.log10(10 * (active.selfSteerResponse * 0.9 + 0.1)));
    const correction = (signedPow(clamp(rearAngle / 72, -1, 1), exponent) * 72) / lockDeg;
    const selfSteerCap = clamp01(active.maxSelfSteerAngleDeg / lockDeg);
    const selfSteerCapWindow = Math.min(1, 4 / (2 * Math.max(1e-6, selfSteerCap)));
    const damping = -car.yawRateRadS * active.dampingStrength * 0.15 * (30 / lockDeg);
    const rawSelfSteer = clampEased(correction, -selfSteerCap, selfSteerCap, selfSteerCapWindow) + damping;
    const selfSteer = clamp(this.selfSteer.get(rawSelfSteer, dt), -2, 2) * assistFadeIn;

    // Steering limit that keeps the front tyres just under their peak slip angle
    const targetSlipDeg = peakDeg * active.targetSlip;
    const maxLimitReduction = lerp(targetSlipDeg * 0.4, targetSlipDeg * 0.75, clamp01(active.maxDynamicLimitReduction / 10));
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
    // 0 under ≈2.9° of rear slide, 1 past ≈11.6°, eased in between
    const rawCounter = isCountersteering ? clampEased((Math.abs(rearAngle) - 4.5) / (10 - 4.5), 0, 1, 0.6) : 0;
    const returnRate = lerp(0.8, 0.3, lerpInvSat(Math.abs(frontAngle - rearAngle), 2, 10));
    const counter =
      this.counterIndicator.get(rawCounter, dt, rawCounter < this.counterIndicator.state ? returnRate : 1) * midSpeedFade;

    const rearToward = inputSign * rearAngle; // rear axle travel angle on the steering side
    const counterMult = lerp(lerpInvSat(rearToward, 0, 30) / 3 + 2 / 3, 1, active.countersteerResponse);
    // Yaw-rate guard: shrink the limit by the steering that the excess rotation corresponds to
    const yawTowardSteer = inputSign * car.yawRateRadS;
    const maxYawRate = (1.1 * car.maxLateralAccel) / Math.max(5, speed);
    const yawExcessDeg = (Math.max(0, yawTowardSteer - maxYawRate) * car.wheelbaseM * RAD2DEG) / Math.max(5, speed);
    const targetInward = targetSlipDeg - frontAway - 2.5 * yawExcessDeg;
    // Countersteer: align with the rear axle's travel (+ a margin), but never past the front tyres'
    // peak — on a quick left-right flick the rear still slides from the previous turn and would
    // otherwise read as a slide to catch, allowing far more lock than the front can use.
    const targetCounter = Math.min(
      targetSlipDeg * (active.countersteerResponse * counterMult * 0.7 + 0.1) + rearToward,
      targetInward
    );
    const targetAngle = lerp(clamp(targetInward, 0, lockDeg), clamp(targetCounter, 0, lockDeg), counter);

    // No limit when travelling sideways / backwards
    const travelDeg = Math.atan2(car.vyMs, car.vxMs) * RAD2DEG;
    const notForward = Math.pow(Math.sin(clamp(((travelDeg * 2) / 3) * (Math.PI / 180), -Math.PI / 2, Math.PI / 2)), 16);
    const limit = lerp(this.limit.get(targetAngle, dt) / lockDeg, 1, notForward);

    // Keyboard slide catch: a held key cannot ease off or countersteer by degrees, so when the rear slides out past
    // its grip (from ≈0.85× to ≈1.65× the fronts' peak slip angle at the rear axle) while a key still steers into the
    // turn, the key's steering hands over to the self-steer force (which
    // countersteers) until the rear grips again. A stick steers by degrees, so the player catches the slide there.
    const slidingOut = Math.abs(initial) > 1e-6 && inputSign !== Math.sign(vRightRear);
    const rawSlide =
      keyboardActive && slidingOut ? clampEased((Math.abs(rearAngle) - peakDeg) / (0.5 * peakDeg), 0, 1, 0.6) : 0;
    const slide = this.slideCatch.get(rawSlide, dt, rawSlide < this.slideCatch.state ? 0.5 : 1) * midSpeedFade;

    const processed = clamp(
      initial * limit * (1 - slide) + selfSteer - absInitial * selfSteer * (1 - slide),
      -1,
      1
    );
    return clamp(lerp(initial, processed, assistFadeIn), -1, 1);
  }
}
