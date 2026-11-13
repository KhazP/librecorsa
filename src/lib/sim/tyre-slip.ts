/**
 * The tyres' slip as the driver aids and cues read it: each tyre's slip angle, slip ratio and normalised combined slip
 * (1 = the tyre's peak), load-weighted per axle. One sample serves the steering assist, the keyboard pedal help and
 * the controller's trigger cues, so they all agree on when a tyre is at its limit.
 *
 * The pedals' slip margins are adapted from AC-Advanced-Gamepad-Assist v1.5.5 by Adam D.
 * (https://github.com/adam10603/AC-Advanced-Gamepad-Assist), MIT License — see CREDITS.md.
 */

const RAD2DEG = 180 / Math.PI;
/**
 * tan(peak slip angle) / peak slip ratio of the tyres, to split a tyre's normalised slip into its longitudinal and
 * lateral parts from the raw slip ratio and angle (LC26 slicks: tan 6.7° / 0.1005 ≈ 1.17)
 */
const PEAK_ANGLE_OVER_RATIO = 1.2;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** What the front and rear tyres are doing, load-weighted per axle (from the car's telemetry) */
export interface AxleSlipSample {
  /** Front slip angle magnitude (deg) */
  frontSlipDeg: number;
  /** Normalised combined slip (1 = the tyres' peak) */
  frontNdSlip: number;
  rearNdSlip: number;
  /** Load-weighted normalised slip of all four tyres */
  totalNdSlip: number;
  /**
   * Load-weighted braking part of the four tyres' normalised slip: the share of each tyre's slip that is along the
   * wheel and braking (slip ratio < 0), so cornering slip does not count
   */
  brakeNdSlip: number;
  /** Larger front longitudinal slip ratio magnitude */
  frontSlipRatioAbs: number;
  /** The fronts are on the road surface (not a kerb, grass or run-off) */
  frontOnRoad: boolean;
  /** At least one front tyre carries load */
  frontGrounded: boolean;
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
  brakeNdSlip: 0,
  frontSlipRatioAbs: 0,
  frontOnRoad: true,
  frontGrounded: true,
});

/** Load-weighted average of two wheels (plain average when neither is loaded) */
function weighted(a: number, b: number, wa: number, wb: number): number {
  const w = wa + wb;
  return w > 1e-6 ? (a * wa + b * wb) / w : 0.5 * (a + b);
}

/**
 * The braking part of one tyre's normalised slip (after a7-impulse, which projects `ndSlip` onto the tyre force's
 * longitudinal direction through the friction ellipse: `ndSlip·cos θ·r(θ)/dx`). With the normalised slip
 * `hypot(κ/κ_peak, tanα/tanα_peak)` that projection is just `κ/κ_peak`, read here as the slip ratio's share of the
 * slip vector. A tyre with no slip vector to go by (neither slip ratio nor angle reported) keeps its whole slip.
 */
function brakingNdSlip(w: WheelSlip): number {
  const lateral = Math.tan(w.slipAngleRad) / PEAK_ANGLE_OVER_RATIO;
  const len = Math.hypot(w.slipRatio, lateral);
  if (!(len > 1e-9)) return w.ndSlip;
  return (w.ndSlip * Math.max(0, -w.slipRatio)) / len;
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
  const bfl = brakingNdSlip(fl);
  const bfr = brakingNdSlip(fr);
  const brl = brakingNdSlip(rl);
  const brr = brakingNdSlip(rr);
  out.brakeNdSlip = total > 1e-6 ? (bfl * lfl + bfr * lfr + brl * lrl + brr * lrr) / total : 0.25 * (bfl + bfr + brl + brr);
  out.frontSlipRatioAbs = Math.max(Math.abs(fl.slipRatio), Math.abs(fr.slipRatio));
  out.frontOnRoad = fl.onRoad && fr.onRoad;
  out.frontGrounded = lfl > 1 || lfr > 1;
  return out;
}

/** Four tyre samples a car fills in place each step (FL, FR, RL, RR), and their axle sample */
export class AxleSlipScratch {
  readonly wheels = [createWheelSlip(), createWheelSlip(), createWheelSlip(), createWheelSlip()] as const;
  private readonly out = createAxleSlipSample();

  /** The axle sample of `wheels` as they are now (the same object every call) */
  sample(): AxleSlipSample {
    const [fl, fr, rl, rr] = this.wheels;
    return axleSlip(fl, fr, rl, rr, this.out);
  }
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
 * Normalised slip the driven tyres may carry under power before it counts as wheelspin, by speed (km/h). `strength`
 * (0..1) is the keyboard pedal help's: stronger help backs off earlier.
 */
export const throttleSlipAllowance = (speedKmh: number, strength = 0.5) =>
  lerp(0.25, 0.35, clamp01((speedKmh - 40) / 120)) + (0.5 - clamp01(strength)) * 0.4;

/**
 * Normalised slip added to the tyres' before the brakes count as at their limit: the brake pedal help and the brake
 * trigger cue back off from (slip + this) = 1, so ahead of the peak. `strength` (0..1) is the pedal help's.
 */
export const brakeSlipMargin = (strength = 0.5) => lerp(-0.05, 0.35, clamp01(strength));
