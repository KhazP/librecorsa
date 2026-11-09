/**
 * The brush tyre family of `VehiclePhysics` (`TyresModelData.curve: 'brush'`): the force curve, peak slip, combined slip
 * and lag of a tyre whose data states a peak slip angle, a falloff level and speed, a load gain on the peak angle, a
 * combined-slip exponent and a longitudinal stiffness multiplier (Assetto Corsa compatible car data).
 *
 * The brush model (Fiala; Pacejka, Tire and Vehicle Dynamics ch. 3) gives the force of a tread of elastic bristles under
 * a parabolic pressure: with the slip s normalised to the slip where the whole patch slides,
 *
 *   F(s) = 1 − (1 − s)³    for s ≤ 1,
 *
 * so the slip stiffness at the origin is 3 × the peak force over the peak slip: a stiffer, squarer rise than the
 * `sin(C·atan(B·s))` family fitted to a falloff level. Past the peak the patch slides as a whole and the force decays
 * toward its sliding level as the sliding grows:
 *
 *   F = level + (1 − level) / (1 + speed × (slip − peak slip)),
 *
 * in the tyre's own slip units, so a tyre with a small peak slip angle loses its grip over a wider multiple of it. The
 * slips are the theoretical ones, measured against the wheel's rolling speed (σx = κ / (1 + κ), σy = tan α / (1 + κ)),
 * which is what a bristle sees; they combine as (|σx|^p + |σy|^p)^(1/p), and each axis reads the curve at that combined
 * slip against its own peak (the longitudinal one is the lateral one over `longStiffnessMult`).
 */
import type { TyresModelData } from './F12026CarConfig';

/** Share of a grip change that the peak slip follows: a tyre with less grip (cold, worn, wet) also peaks earlier */
const PEAK_SLIP_GRIP_SHARE = 0.75;
/** The peak slip never falls below this share of its value at the reference load (a negative load gain at high load) */
const MIN_PEAK_SLIP_SHARE = 0.25;
/** Lag at small slip over the data's relaxation length, its growth per `RELAXATION_LOAD_REF_N` of extra load */
const RELAXATION_SMALL_SLIP_FACTOR = 2;
const RELAXATION_LOAD_GAIN = 0.3;
const RELAXATION_LOAD_REF_N = 2000;
/** Floor of 1 + κ in the theoretical slips: a locked wheel's slip is large, not infinite */
const MIN_ROLLING_SHARE = 1e-3;

/** A brush tyre's constants, from its compound data (one per axle) */
export interface BrushTyre {
  /** tan(peak slip angle) at the reference load */
  tanPeak0: number;
  /** Change of tan(peak slip angle) per reference load of extra load */
  tanPeakPerRefLoad: number;
  peakLoadRefN: number;
  peakPressureGain: number;
  /** Lateral over longitudinal peak slip */
  longStiffnessMult: number;
  /** Combined-slip exponent */
  exponent: number;
  /** Extra fullness of the rising branch */
  fullness: number;
  /** Sliding level and its decay per unit of slip past the peak (0: the force holds its peak) */
  falloffLevel: number;
  falloffSpeed: number;
  /** Grip lost per m/s of sliding speed */
  speedSensitivity: number;
  /** The data's relaxation length (m) */
  relaxationLength: number;
}

/** The brush constants of a compound's model data; `tanPeakAngle` and `fz0` as the tyre runtime has them */
export function createBrushTyre(model: TyresModelData, tanPeakAngle: number, fz0: number): BrushTyre {
  const peakAngle = Math.atan(tanPeakAngle);
  const gain = model.peakSlipLoadGain ?? 0;
  return {
    tanPeak0: tanPeakAngle,
    tanPeakPerRefLoad: Math.tan((1 + gain) * peakAngle) - tanPeakAngle,
    peakLoadRefN: model.peakSlipLoadRefN ?? fz0,
    peakPressureGain: model.peakSlipPressureGain ?? 0,
    longStiffnessMult: model.longStiffnessMult ?? tanPeakAngle / Math.max(1e-3, model.slip_ratio_limit),
    exponent: model.combinedExponent && model.combinedExponent > 0 ? model.combinedExponent : 2,
    fullness: model.curveFullness ?? 0,
    falloffLevel: model.falloff_level,
    falloffSpeed: model.use_slip_falloff ? Math.max(0, model.falloff_slope) : 0,
    speedSensitivity: model.speedSensitivity ?? 0,
    relaxationLength: model.relaxationLengthY,
  };
}

/**
 * tan(peak slip angle) at load `fz` (N): linear in load about the reference load, scaled by the grip state `grip` (the
 * tyre's grip multipliers of temperature, wear, surface and water: 1 = full grip) and by the pressure over the optimum
 */
export function brushPeakSlipTan(t: BrushTyre, fz: number, grip: number, pressureRatio: number): number {
  const loaded = t.tanPeak0 + ((fz - t.peakLoadRefN) / t.peakLoadRefN) * t.tanPeakPerRefLoad;
  const peak = (loaded * (1 + PEAK_SLIP_GRIP_SHARE * (grip - 1))) / (1 + t.peakPressureGain * (pressureRatio - 1));
  return Math.max(MIN_PEAK_SLIP_SHARE * t.tanPeak0, peak);
}

/** Force share (1 at the peak) at slip `slip` for a peak slip `peak`, both in the tyre's slip units */
export function brushCurve(t: BrushTyre, slip: number, peak: number): number {
  if (slip <= peak) {
    const s = slip / peak;
    const free = 1 - s;
    return 1 - free * free * free + t.fullness * 3 * s * free * free;
  }
  if (t.falloffSpeed <= 0) return 1;
  return t.falloffLevel + (1 - t.falloffLevel) / (1 + t.falloffSpeed * (slip - peak));
}

/** Slip stiffness at the origin of the curve, as force share per unit of slip, for a peak slip `peak` */
export function brushSlipStiffness(t: BrushTyre, peak: number): number {
  return (3 * (1 + t.fullness)) / peak;
}

export interface BrushForces {
  /** Longitudinal and lateral force as shares of μx·Fz and μy·Fz (the lateral one along the slip, + = toward +σy) */
  fx: number;
  fy: number;
  /** Combined slip over the lateral peak slip (1 = the lateral peak) */
  slipNorm: number;
}

/**
 * Combined-slip forces from the slip ratio `kappa` and tan(slip angle) `tanAlpha` (camber shift included) at a lateral
 * peak slip `peak`. Each axis takes the curve at the combined slip against its own peak, split along the slip.
 */
export function brushForces(t: BrushTyre, kappa: number, tanAlpha: number, peak: number, out: BrushForces): void {
  const rolling = Math.max(MIN_ROLLING_SHARE, 1 + kappa);
  const sx = kappa / rolling;
  const sy = tanAlpha / rolling;
  const ax = Math.abs(sx);
  const ay = Math.abs(sy);
  const slip = t.exponent === 2 ? Math.hypot(ax, ay) : Math.pow(Math.pow(ax, t.exponent) + Math.pow(ay, t.exponent), 1 / t.exponent);
  out.slipNorm = slip / peak;
  if (slip < 1e-9) {
    out.fx = 0;
    out.fy = 0;
    return;
  }
  out.fx = (brushCurve(t, slip, peak / t.longStiffnessMult) * sx) / slip;
  out.fy = (brushCurve(t, slip, peak) * sy) / slip;
}

/**
 * The tyre's lag (m) at load `fz` and normalised slip `slipNorm`: twice the relaxation length at small slip, longer
 * under load, coming down to the relaxation length itself as the patch starts to slide (a sliding tread follows at once)
 */
export function brushRelaxationLength(t: BrushTyre, fz: number, slipNorm: number): number {
  const small = RELAXATION_SMALL_SLIP_FACTOR * t.relaxationLength * (1 + RELAXATION_LOAD_GAIN * (fz / RELAXATION_LOAD_REF_N - 1));
  const k = Math.min(1, Math.max(0, slipNorm));
  return Math.max(0.25 * t.relaxationLength, small + (t.relaxationLength - small) * k);
}

/** Grip multiplier for a sliding speed `slideMs` (m/s) */
export function brushSpeedGrip(t: BrushTyre, slideMs: number): number {
  return 1 / (1 + t.speedSensitivity * slideMs);
}
