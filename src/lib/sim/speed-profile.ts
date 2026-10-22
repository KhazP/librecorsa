/**
 * Car-aware target-speed profile along the AI driving line.
 *
 * 1. Lateral limit per sample:  v²·|κ| = μ_lat·(g·cos θ + c_L·v²/m) + g·sin θ   (θ = banking into the turn)
 * 2. Backward pass (braking):    friction-circle-limited brake deceleration incl. downforce and drag
 * 3. Forward pass (traction):    power / rear-axle grip limited acceleration minus drag
 *
 * The same profile feeds the AI driver and the track's `optimalSpeedKmh` (HUD target speed,
 * braking-zone markers, ghost cars), so they all agree with what this car can actually do.
 */

import type { AeroSetupPreset, RacingLineId, TrackSamplePoint } from '@/types/f1';
import { estimateAeroCoefficients } from './vf26-aero';
import { VF26_BRAKES, VF26_CHASSIS, VF26_TYRES } from './vf26-data';

const G = 9.81;

export interface SpeedProfileCarModel {
  massKg: number;
  /** Downforce per (m/s)² (N·s²/m²) */
  downforceCoef: number;
  /** Drag per (m/s)² (N·s²/m²) */
  dragCoef: number;
  /** Share of the downforce carried by the rear (driven) axle */
  rearDownforceShare: number;
  /** Static share of the weight on the rear axle */
  rearWeightFraction: number;
  /** Usable lateral / longitudinal friction coefficients (already include a safety margin) */
  muLat: number;
  muLong: number;
  /** Maximum total brake force the brake system can produce at the contact patches (N) */
  maxBrakeForceN: number;
  /** Power delivered to the rear wheels at full deployment (W) */
  maxDrivePowerW: number;
  vMaxMs: number;
}

export interface SpeedProfile {
  /** Lateral offset of the AI line from the centreline per sample (m, + right, along the sample binormal) */
  lineOffsetM: Float64Array;
  /** Signed curvature of the AI line per sample (1/m, + right) */
  curvature: Float64Array;
  /** Target speed per sample (m/s) */
  speedMs: Float64Array;
  /**
   * Braking envelope per sample (m/s): the highest speed from which the car can still make every
   * slower point further along the line. Unlike `speedMs` it is not limited by how fast the car
   * can accelerate to this point, so `speed > brakeEnvelopeMs` means "must be braking already".
   */
  brakeEnvelopeMs: Float64Array;
  /** Length of the AI line from sample i to i + 1 (m) */
  segLenM: Float64Array;
  /** Horizontal world position of the AI line per sample */
  pointX: Float64Array;
  pointZ: Float64Array;
}

/**
 * Width scale of the normalised `racingLineOffset`. track-data stores the exported racing line
 * (`ro`, metres) divided by width·scale, so `aiLineOffsetM` returns that line exactly: the AI,
 * the drawn line, the speed profile and the braking markers all use the same path.
 */
export const AI_LINE_WIDTH_SCALE = 0.3;

export function aiLineOffsetM(
  sample: Pick<TrackSamplePoint, 'racingLineOffset' | 'racingLineOffsetGt3' | 'width'>,
  line: RacingLineId = 'f1'
): number {
  const norm = line === 'gt3' ? (sample.racingLineOffsetGt3 ?? sample.racingLineOffset) : sample.racingLineOffset;
  return norm * sample.width * AI_LINE_WIDTH_SCALE;
}

/** The planning model on tyres that hold `grip` × its grip, e.g. rain tyres on a wet road */
export function withPlanningGrip(car: SpeedProfileCarModel, grip: number): SpeedProfileCarModel {
  return grip === 1 ? car : { ...car, muLat: car.muLat * grip, muLong: car.muLong * grip };
}

/** Air density at the circuit (Bugesera ≈ 1400 m ASL) used for nominal profiles */
export const NOMINAL_AIR_DENSITY = 1.06;

/** Total brake force at the contact patches with the pedal fully pressed (N) */
export function vf26FullBrakeForceN(): number {
  const t = VF26_BRAKES.maxTorqueNm * VF26_BRAKES.powerMult;
  return (
    2 * ((t * VF26_BRAKES.frontBias) / VF26_TYRES.soft.front.radius) +
    2 * ((t * (1 - VF26_BRAKES.frontBias)) / VF26_TYRES.soft.rear.radius)
  );
}

/**
 * Nominal VF26 planning model for an aero package. μ values sit ~4 % under what the car
 * achieves on the skidpad / in straight-line braking with tyres in their window.
 */
export function createVf26ProfileCarModel(
  preset: AeroSetupPreset = 'balanced',
  airDensity = NOMINAL_AIR_DENSITY
): SpeedProfileCarModel {
  // Typical at-speed attitude: ~17 mm lower than static, slight nose-up rake change
  const aero = estimateAeroCoefficients(preset, airDensity, -0.017, 0.0015);
  return {
    massKg: VF26_CHASSIS.totalMassKg + VF26_CHASSIS.fuelKg,
    downforceCoef: aero.downforceCoef,
    dragCoef: aero.dragCoef,
    rearDownforceShare: 1 - aero.frontShare,
    rearWeightFraction: 1 - VF26_CHASSIS.frontWeightFraction,
    muLat: 1.7,
    muLong: 1.65,
    maxBrakeForceN: vf26FullBrakeForceN() * 0.92,
    maxDrivePowerW: 650_000,
    vMaxMs: 95,
  };
}

export function computeSpeedProfile(
  samples: ReadonlyArray<TrackSamplePoint>,
  car: SpeedProfileCarModel,
  line: RacingLineId = 'f1'
): SpeedProfile {
  const n = samples.length;
  const m = car.massKg;
  const lineOffsetM = new Float64Array(n);
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sp = samples[i];
    const lat = aiLineOffsetM(sp, line);
    lineOffsetM[i] = lat;
    px[i] = sp.position.x + sp.binormal.x * lat;
    pz[i] = sp.position.z + sp.binormal.z * lat;
  }

  const segLenM = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    segLenM[i] = Math.max(0.1, Math.hypot(px[j] - px[i], pz[j] - pz[i]));
  }

  // Menger curvature over ±2 samples (+ right), then a short smoothing kernel
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const c = (i + 2) % n;
    const abx = px[i] - px[a];
    const abz = pz[i] - pz[a];
    const bcx = px[c] - px[i];
    const bcz = pz[c] - pz[i];
    const cross = abx * bcz - abz * bcx;
    const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(px[c] - px[a], pz[c] - pz[a]);
    raw[i] = den > 1e-9 ? (2 * cross) / den : 0;
  }
  const curvature = new Float64Array(n);
  const kernel = [1, 2, 3, 2, 1];
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -2; k <= 2; k++) acc += kernel[k + 2] * raw[(i + k + n) % n];
    curvature[i] = acc / 9;
  }

  // 1. Lateral limit
  const gN = new Float64Array(n);
  const gT = new Float64Array(n);
  const speedMs = new Float64Array(n);
  const aeroLat = (car.muLat * car.downforceCoef) / m;
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curvature[i]);
    const bankInto = samples[i].bankingRad * Math.sign(curvature[i] || 1);
    gN[i] = G * Math.cos(bankInto);
    gT[i] = G * Math.sin(bankInto);
    const den = k - aeroLat;
    const vLat = den > 1e-7 ? Math.sqrt(Math.max(0, (car.muLat * gN[i] + gT[i]) / den)) : car.vMaxMs;
    speedMs[i] = Math.min(car.vMaxMs, vLat);
  }

  // Fraction of the friction circle still available after the lateral demand at speed v
  const longShare = (i: number, v: number) => {
    const latMax = car.muLat * (gN[i] + (car.downforceCoef * v * v) / m);
    const latUsed = Math.max(0, v * v * Math.abs(curvature[i]) - gT[i]);
    // Between a friction circle and a linear trade-off: with fixed left/right brake and drive
    // torque the less-loaded tyre saturates first, so combined grip is below the ideal circle
    const r = Math.min(1, latUsed / Math.max(1e-6, latMax));
    return Math.max(0, 1 - r * r) ** 0.75;
  };

  const backwardPass = (v: Float64Array) => {
    for (let step = 0; step < n; step++) {
      const i = n - 1 - step;
      const j = (i + 1) % n;
      const vn = v[j];
      const grip = car.muLong * (G + (car.downforceCoef * vn * vn) / m);
      const decel = Math.min(grip, car.maxBrakeForceN / m) * longShare(i, vn) + (car.dragCoef * vn * vn) / m;
      v[i] = Math.min(v[i], Math.sqrt(vn * vn + 2 * decel * segLenM[i]));
    }
  };
  const brakeEnvelopeMs = Float64Array.from(speedMs);
  backwardPass(brakeEnvelopeMs);
  backwardPass(brakeEnvelopeMs);

  for (let pass = 0; pass < 3; pass++) {
    // 2. Backward: braking into each sample
    backwardPass(speedMs);
    // 3. Forward: acceleration out of each sample
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const v = speedMs[i];
      const traction =
        car.muLong * (car.rearWeightFraction * G + (car.rearDownforceShare * car.downforceCoef * v * v) / m);
      const power = car.maxDrivePowerW / (m * Math.max(5, v));
      const accel = Math.min(traction, power) * longShare(i, v) - (car.dragCoef * v * v) / m;
      speedMs[j] = Math.min(speedMs[j], Math.sqrt(Math.max(0, v * v + 2 * accel * segLenM[i])));
    }
  }

  return { lineOffsetM, curvature, speedMs, brakeEnvelopeMs, segLenM, pointX: px, pointZ: pz };
}

/**
 * Braking-zone level of sample i from a target-speed profile (the speed lost over the next three samples):
 * 1 = heavy braking, 0.5 = lift / transition, 0 = throttle
 */
export function brakingZoneLevel(speedMs: ArrayLike<number>, i: number): number {
  const n = speedMs.length;
  const drop = speedMs[i] - speedMs[(i + 3) % n];
  return drop > 4.2 ? 1.0 : drop > 1.6 ? 0.5 : 0.0;
}

/**
 * A car's own braking guidance along its racing line, per track sample: the braking line's colours, the braking
 * urgency and the HUD target speed. Cars without one use the circuit's (the VF26 profile baked into the samples).
 */
export interface BrakingGuide {
  /** The racing line the guide (and the car) follows */
  line: RacingLineId;
  /** Target speed (m/s) */
  speedMs: Float64Array;
  /** Braking envelope (m/s), see `SpeedProfile.brakeEnvelopeMs` */
  brakeEnvelopeMs: Float64Array;
  /** Braking-zone level: 1 = heavy braking, 0.5 = lift / transition, 0 = throttle */
  brakingZone: Float32Array;
}

/** Share of the car's braking capability a braking zone asks for: red (braking) and amber (lift) */
const BRAKING_ZONE_RED = 0.52;
const BRAKING_ZONE_AMBER = 0.2;

const brakingGuides = new WeakMap<ReadonlyArray<TrackSamplePoint>, Map<string, BrakingGuide>>();

/** The braking guide of a car (cached per track and car id) */
export function brakingGuideFor(
  samples: ReadonlyArray<TrackSamplePoint>,
  carId: string,
  car: SpeedProfileCarModel,
  line: RacingLineId = 'f1'
): BrakingGuide {
  let perCar = brakingGuides.get(samples);
  if (!perCar) brakingGuides.set(samples, (perCar = new Map()));
  const key = `${carId}:${line}`;
  let guide = perCar.get(key);
  if (!guide) {
    const profile = computeSpeedProfile(samples, car, line);
    const n = samples.length;
    const brakingZone = new Float32Array(n);
    // The circuit's zones (`brakingZoneLevel`) are an absolute speed drop tuned to the VF26's ~4 g; for any car,
    // grade the deceleration the profile asks for over the next three samples against what this car can brake
    // with at that speed. These fractions give the VF26 the same 540 m of red / 300 m of amber on Rwanda.
    for (let i = 0; i < n; i++) {
      const v = profile.speedMs[i];
      const w = profile.speedMs[(i + 3) % n];
      const ds = profile.segLenM[i] + profile.segLenM[(i + 1) % n] + profile.segLenM[(i + 2) % n];
      const need = (v * v - w * w) / (2 * ds);
      const grip = car.muLong * (G + (car.downforceCoef * v * v) / car.massKg);
      const can = Math.min(grip, car.maxBrakeForceN / car.massKg) + (car.dragCoef * v * v) / car.massKg;
      brakingZone[i] = need > BRAKING_ZONE_RED * can ? 1.0 : need > BRAKING_ZONE_AMBER * can ? 0.5 : 0.0;
    }
    guide = { line, speedMs: profile.speedMs, brakeEnvelopeMs: profile.brakeEnvelopeMs, brakingZone };
    perCar.set(key, guide);
  }
  return guide;
}

/** Linear interpolation of a per-sample profile array at track distance s */
export function sampleProfile(values: Float64Array, s: number, totalLengthM: number): number {
  const n = values.length;
  const x = ((((s % totalLengthM) + totalLengthM) % totalLengthM) / totalLengthM) * n;
  const i0 = Math.floor(x) % n;
  const t = x - Math.floor(x);
  return values[i0] + (values[(i0 + 1) % n] - values[i0]) * t;
}
