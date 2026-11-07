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
 * The keyboard and the controller each have their own tuning; the device steering (`SteeringAssist.source`, which the
 * cars route through `steer`) uses its own, with the keys released as much as held.
 *
 * The cars' steering racks are linear (road-wheel angle = input × lock), so no input-to-angle curve is needed.
 *
 * Conventions: steering + = right (same as `ControlInputs.analogSteer`), yaw rate + = right, body lateral velocity
 * + = left (F1Physics2026).
 *
 * Adapted from AC-Advanced-Gamepad-Assist v1.5.5 by Adam D. (https://github.com/adam10603/AC-Advanced-Gamepad-Assist),
 * MIT License — see CREDITS.md.
 */

import type { ControlInputs } from "@/types/f1";
import { PAD_SENSITIVITY } from "@/lib/input/device-input";
import { KB_STEER_RETURN_S, KB_STEER_RISE_S, keyboardRampScales } from "@/lib/input/keyboard-steer";
import type { AxleSlipSample } from "./tyre-slip";

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

export type SteeringDevice = "keyboard" | "controller";

/** One device's assist sliders as the assist uses them (`deviceAssistTuning`) */
export interface DeviceAssistResolved {
  selfSteerResponse: number;
  dampingStrength: number;
  maxSelfSteerAngleDeg: number;
  maxDynamicLimitReduction: number;
  countersteerResponse: number;
  targetSlip: number;
  /** Change of the smoothing rate with speed: + quicker, − slower at speed */
  rateIncreaseWithSpeed: number;
}

/** The assist's tuning for each steering device; the device that steers picks its own (`SteeringAssist.source`) */
export interface SteeringAssistSettings {
  controller: DeviceAssistResolved & {
    /** Stick smoothing rate multiplier (higher = quicker steering) */
    steeringRate: number;
  };
  keyboard: DeviceAssistResolved & {
    /** Key ramp speed out of centre / back to centre, relative to the defaults (higher = quicker) */
    riseScale: number;
    returnScale: number;
  };
}

/** One device's steering assist sliders (PlayerSettings.padTuning / keyboardTuning): see ASSIST_SLIDERS */
export interface DeviceAssistTuning {
  selfSteerStrength: number;
  dampingStrength: number;
  speedSensitivity: number;
  /** Offset of the front tyres' grip target from 95 % of their peak slip (negative = a safer margin) */
  slipLimitMargin: number;
  /** Most road-wheel angle the self-steer turns to by itself (deg; at most the car's lock) */
  maxSelfSteerAngleDeg: number;
}

/** One steering assist slider: what it is called, its range and default, and how its value reads */
export interface AssistSliderSpec {
  key: keyof DeviceAssistTuning;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  default: number;
  format: (value: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

const SLIDERS: { readonly [K in keyof DeviceAssistTuning]: Omit<AssistSliderSpec, "key"> } = {
  selfSteerStrength: {
    label: "Self-steer & countersteer",
    hint: "How strongly the wheels follow the car's travel direction and catch rear slides",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    format: pct,
  },
  dampingStrength: {
    label: "Yaw damping",
    hint: "Calms snap-back and pendulum swings as a slide recovers",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    format: pct,
  },
  speedSensitivity: {
    label: "High-speed calm",
    hint: "How much the steering slows down at speed, so small inputs stay gentle",
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.5,
    format: pct,
  },
  slipLimitMargin: {
    label: "Tyre slip margin",
    hint: "Negative: a safer understeer cushion · Positive: lets the fronts past their peak slip",
    min: -0.25,
    max: 0.25,
    step: 0.01,
    default: 0,
    format: (v) => `${v > 0 ? "+" : ""}${Math.round(v * 100)} %`,
  },
  maxSelfSteerAngleDeg: {
    label: "Max countersteer lock",
    hint: "Most road-wheel angle the assist turns to by itself to catch a slide",
    min: 5,
    max: 30,
    step: 1,
    default: 25,
    format: (v) => `${Math.round(v)}°`,
  },
};

/**
 * The steering assist's sliders, the same for the keyboard and the controller: the setup screens and the pause menu
 * draw them, the saved settings are clamped to their ranges and the presets are matched on their steps.
 */
export const ASSIST_SLIDERS: readonly AssistSliderSpec[] = (Object.keys(SLIDERS) as (keyof DeviceAssistTuning)[]).map(
  (key) => ({ key, ...SLIDERS[key] })
);

function fromSliders(value: (s: AssistSliderSpec) => number): DeviceAssistTuning {
  const out = {} as DeviceAssistTuning;
  for (const s of ASSIST_SLIDERS) out[s.key] = value(s);
  return out;
}

export const DEFAULT_DEVICE_ASSIST_TUNING: DeviceAssistTuning = fromSliders((s) => s.default);

/** Each slider of a saved tuning in its range; a missing or broken one takes its default */
export function sanitizeAssistTuning(v: Partial<Record<keyof DeviceAssistTuning, unknown>>): DeviceAssistTuning {
  return fromSliders((s) => {
    const x = v[s.key];
    return typeof x === "number" && Number.isFinite(x) ? Math.min(s.max, Math.max(s.min, x)) : s.default;
  });
}

export interface AssistPresetInfo {
  id: "balanced" | "stable" | "loose" | "drift" | "calm";
  label: string;
  tuning: DeviceAssistTuning;
}

/** One-click factory assist presets (adapted from AC-Advanced-Gamepad-Assist's factory presets) */
export const ASSIST_PRESETS: readonly AssistPresetInfo[] = [
  { id: "balanced", label: "Balanced", tuning: { ...DEFAULT_DEVICE_ASSIST_TUNING } },
  {
    id: "stable",
    label: "Stable",
    tuning: { selfSteerStrength: 0.85, dampingStrength: 0.9, speedSensitivity: 0.65, slipLimitMargin: -0.04, maxSelfSteerAngleDeg: 30 },
  },
  {
    id: "loose",
    label: "Loose",
    tuning: { selfSteerStrength: 0.3, dampingStrength: 0.3, speedSensitivity: 0.25, slipLimitMargin: 0.05, maxSelfSteerAngleDeg: 8 },
  },
  {
    id: "drift",
    label: "Drift",
    tuning: { selfSteerStrength: 0.45, dampingStrength: 0.65, speedSensitivity: 0.2, slipLimitMargin: 0.05, maxSelfSteerAngleDeg: 30 },
  },
  {
    id: "calm",
    label: "Calm at speed",
    tuning: { selfSteerStrength: 0.48, dampingStrength: 0.58, speedSensitivity: 0.85, slipLimitMargin: 0, maxSelfSteerAngleDeg: 25 },
  },
];

/** The preset `tuning` is (every slider within half a step of it), if any */
export function matchingAssistPreset(tuning: DeviceAssistTuning): AssistPresetInfo | undefined {
  return ASSIST_PRESETS.find((p) => ASSIST_SLIDERS.every((s) => Math.abs(tuning[s.key] - p.tuning[s.key]) < s.step / 2));
}

/** What a tuning does, in a line: its sliders and the grip target they make (countersteer: "full lock" at `lockDeg`) */
export function assistPresetDetail(tuning: DeviceAssistTuning, lockDeg?: number): string {
  const t = sanitizeAssistTuning(tuning);
  const grip = Math.round(deviceAssistTuning(t, "controller").targetSlip * 100);
  const cap =
    lockDeg !== undefined && t.maxSelfSteerAngleDeg >= lockDeg ? "full lock" : SLIDERS.maxSelfSteerAngleDeg.format(t.maxSelfSteerAngleDeg);
  return (
    `self-steer ${pct(t.selfSteerStrength)}, yaw damping ${pct(t.dampingStrength)}, high-speed calm ` +
    `${pct(t.speedSensitivity)}, fronts at ${grip} % of their peak slip, countersteer up to ${cap}`
  );
}

/** A device's assist sliders as the assist's coefficients */
export function deviceAssistTuning(tuning: DeviceAssistTuning, device: SteeringDevice): DeviceAssistResolved {
  const { selfSteerStrength: s, dampingStrength: d, speedSensitivity: spd, slipLimitMargin, maxSelfSteerAngleDeg } =
    sanitizeAssistTuning(tuning);
  return {
    // Lower for the keyboard: a key cannot steer by degrees, so at speed it steers in more slowly and a tap stays a
    // nudge, while it stays quick in slow corners
    rateIncreaseWithSpeed: (1 - spd) * 0.2 - (device === "keyboard" ? 0.35 : 0.1),
    selfSteerResponse: s * 0.5 + 0.12,
    dampingStrength: d * 0.5 + 0.12,
    maxSelfSteerAngleDeg,
    maxDynamicLimitReduction: 3 * s + 3.5,
    countersteerResponse: (1 - s) * 0.2 + 0.1,
    targetSlip: 0.95 - (s - 0.5) * 0.04 + slipLimitMargin,
  };
}

/**
 * The assist's settings for the player's controller and keyboard tuning (PlayerSettings.padTuning / keyboardTuning).
 * The game and the tests build them here, so both drive the same assist.
 */
export function steeringAssistSettings(
  controller: DeviceAssistTuning & { steeringRate: number },
  keyboard: DeviceAssistTuning & { steerRiseS: number; steerReturnS: number }
): SteeringAssistSettings {
  return {
    controller: { ...deviceAssistTuning(controller, "controller"), steeringRate: controller.steeringRate },
    keyboard: { ...deviceAssistTuning(keyboard, "keyboard"), ...keyboardRampScales(keyboard.steerRiseS, keyboard.steerReturnS) },
  };
}

/** The settings of the default controller and keyboard tuning */
export const DEFAULT_STEERING_ASSIST: SteeringAssistSettings = steeringAssistSettings(
  { ...DEFAULT_DEVICE_ASSIST_TUNING, steeringRate: PAD_SENSITIVITY.default.steeringRate },
  { ...DEFAULT_DEVICE_ASSIST_TUNING, steerRiseS: KB_STEER_RISE_S, steerReturnS: KB_STEER_RETURN_S }
);

/** Smoothing rate multiplier while the keyboard steers */
const KEYBOARD_RATE = 0.5;

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

/**
 * Smoothing rate multiplier: the setting's rate, scaled with speed by `rateIncreaseWithSpeed` (the ratio of the lock
 * to the angle a car needs at this speed grows with speed, so a positive exponent quickens and a negative one slows
 * the steering as the car goes faster)
 */
export function steeringRateMult(speedMs: number, lockDeg: number, rate: number, rateIncreaseWithSpeed: number): number {
  const speedAdjusted = lockDeg / Math.min(65 / (Math.max(speedMs, 8) - 7.3) + 3.5, lockDeg);
  return Math.pow(speedAdjusted, rateIncreaseWithSpeed) * rate;
}

/**
 * The self-steer curve: road-wheel angle (deg, toward the side the rear slides to) for the rear axle travelling
 * `rearAngleDeg` off the car's heading, before yaw damping, eased into the countersteer cap (at most the car's lock,
 * `lockDeg`). The assist steers by it and the setup screens draw it (AGA's `selfSteerCurveCallback`).
 */
export function selfSteerDeg(
  rearAngleDeg: number,
  tuning: Pick<DeviceAssistResolved, "selfSteerResponse" | "maxSelfSteerAngleDeg">,
  lockDeg: number
): number {
  const exponent = 1 + (1 - Math.log10(10 * (tuning.selfSteerResponse * 0.9 + 0.1)));
  const correctionDeg = signedPow(clamp(rearAngleDeg / 72, -1, 1), exponent) * 72;
  const capDeg = Math.min(lockDeg, tuning.maxSelfSteerAngleDeg);
  return clampEased(correctionDeg, -capDeg, capDeg, 1);
}

/** What steers the car: the keys or the stick through the assist, or a wheel, mouse or touch straight to the rack */
export type SteeringSource = SteeringDevice | "direct";

/** The player's steering inputs as the cars receive them, and the brake the assist's limit follows */
export type SteeringInputs = Pick<ControlInputs, "analogSteer" | "padSteer" | "kbSteer" | "steerLeft" | "steerRight" | "brake">;

/** Stick travel (shaped, past its dead zone) that takes the steering over from the keys */
const STICK_TAKEOVER = 0.05;

export class SteeringAssist {
  settings: SteeringAssistSettings;

  private sourceNow: SteeringSource | null = null;
  /** The assist steered the last step: it starts from a clean state when it takes over */
  private engaged = false;
  private readonly keyboard = new SmoothTowards(7, 1, -1, 1, 0);
  private readonly steering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly absSteering = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly selfSteer = new SmoothTowards(7, 0.13, -1, 1, 0);
  private readonly limit = new SmoothTowards(11, 0.01, 0, 32, 32);
  private readonly grounded = new SmoothTowards(4, 1, 0, 1, 1);
  private readonly counterIndicator = new SmoothTowards(12, 1, 0, 1, 0);
  private readonly slideCatch = new SmoothTowards(12, 1, 0, 1, 0);
  /** The fronts' peak slip angle, learned while cornering; kept across resets (it belongs to the tyres) */
  readonly peakSlip = new PeakSlipEstimator();

  constructor(settings: SteeringAssistSettings = DEFAULT_STEERING_ASSIST) {
    this.settings = { ...settings };
  }

  /** What steered the last step (null before the first) */
  get source(): SteeringSource | null {
    return this.sourceNow;
  }

  /** Back to centre with no slide in progress; the learned peak slip and the steering device are kept */
  reset(): void {
    this.engaged = false;
    this.keyboard.reset();
    this.steering.reset();
    this.absSteering.reset();
    this.selfSteer.reset();
    this.limit.reset();
    this.grounded.reset();
    this.counterIndicator.reset();
    this.slideCatch.reset();
  }

  /**
   * The player's steering for one step (−1..1, + = right). A wheel, mouse or touch (`analogSteer`, or
   * `steerRight − steerLeft` when neither keys nor a stick are given) goes straight to the rack; the keys, and the
   * stick unless `controllerAssist` is off, go through the assist with the tuning of the device that steers. `car` is
   * only read while the assist steers.
   */
  steer(
    inputs: SteeringInputs,
    controllerAssist: boolean,
    car: (brake: number) => SteeringAssistCarState,
    dt: number
  ): number {
    const keys = Math.sign(inputs.kbSteer ?? 0);
    const source = this.pickSource(keys, inputs);
    this.sourceNow = source;
    if (source === "direct" || (source === "controller" && !controllerAssist)) {
      this.engaged = false;
      return source === "controller" ? (inputs.padSteer ?? 0) : (inputs.analogSteer ?? inputs.steerRight - inputs.steerLeft);
    }
    if (!this.engaged) this.reset();
    this.engaged = true;
    return this.update(inputs.padSteer ?? 0, keys, source, car(inputs.brake), dt);
  }

  /**
   * A pressed key takes the steering, and keeps it while its ramp returns to centre and while the stick stays centred
   * (a keyboard player with a pad plugged in keeps the keyboard's tuning); a moved stick takes it over, and so does a
   * wheel, mouse or touch once the keys' ramp is back at centre.
   */
  private pickSource(keys: number, inputs: SteeringInputs): SteeringSource {
    if (keys !== 0) return "keyboard";
    const keyboardBefore = this.sourceNow === "keyboard" && inputs.kbSteer !== undefined;
    if (keyboardBefore && Math.abs(this.keyboard.state) > 1e-4) return "keyboard";
    if (inputs.analogSteer !== undefined) return "direct";
    if (inputs.padSteer !== undefined) {
      return keyboardBefore && Math.abs(inputs.padSteer) <= STICK_TAKEOVER ? "keyboard" : "controller";
    }
    return inputs.kbSteer !== undefined ? "keyboard" : "direct";
  }

  /** Stick (−1..1) and keys (−1, 0, +1) → steering command (−1..1, + = right), with `source`'s tuning */
  private update(stick: number, keys: number, source: SteeringDevice, car: SteeringAssistCarState, dt: number): number {
    const { controller, keyboard } = this.settings;
    const keyboardSteers = source === "keyboard";
    const lockDeg = car.maxSteerAngleRad * RAD2DEG;
    const wbFactor = car.wheelbaseM / 2.5;
    const speed = Math.hypot(car.vxMs, car.vyMs);

    // Keyboard: a linear ramp first, quicker back to centre (and through it) than out of it
    const kbDir = Math.sign(keys);
    const kbRateMult = steeringRateMult(speed, lockDeg, KEYBOARD_RATE, keyboard.rateIncreaseWithSpeed);
    const kbState = this.keyboard.state;
    const kbCentring = Math.abs(kbState) - Math.sign(kbState) * kbDir > 0;
    const kb = this.keyboard.get(kbDir, dt, kbRateMult * (kbCentring ? 1.5 * keyboard.returnScale : keyboard.riseScale));

    // Then the rounded smoother both inputs share
    const raw = clamp(stick + kb, -1, 1);
    const rateMult = keyboardSteers
      ? kbRateMult
      : steeringRateMult(speed, lockDeg, controller.steeringRate, controller.rateIncreaseWithSpeed);
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
    const active = keyboardSteers ? keyboard : controller;
    const frontGrounded = this.grounded.get(car.slip?.frontGrounded === false ? 0 : 1, dt);
    const selfSteerStrength = Math.max(0.25, frontGrounded) * assistFadeIn;
    const damping = -car.yawRateRadS * active.dampingStrength * 0.15 * (30 / lockDeg);
    const rawSelfSteer = selfSteerDeg(rearAngle, active, lockDeg) / lockDeg + damping;
    const selfSteer = clamp(this.selfSteer.get(rawSelfSteer, dt), -2, 2) * selfSteerStrength;

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
    // turn, the key's steering hands over to the self-steer force (which countersteers) until the rear grips again. A
    // stick steers by degrees, so the player catches the slide there.
    const slidingOut = Math.abs(initial) > 1e-6 && inputSign !== Math.sign(vRightRear);
    const rawSlide =
      keyboardSteers && slidingOut ? clampEased((Math.abs(rearAngle) - peakDeg) / (0.5 * peakDeg), 0, 1, 0.6) : 0;
    const slide = this.slideCatch.get(rawSlide, dt, rawSlide < this.slideCatch.state ? 0.5 : 1) * midSpeedFade;

    const processed = clamp(
      initial * limit * (1 - slide) + selfSteer - absInitial * selfSteer * (1 - slide),
      -1,
      1
    );
    return clamp(lerp(initial, processed, assistFadeIn), -1, 1);
  }
}
