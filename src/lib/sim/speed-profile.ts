/**
 * Car-aware target-speed profile along the AI driving line.
 *
 * 1. Lateral limit per sample:  v²·|κ| = μ_lat·(g·cos θ + c_L·v²/m) + g·sin θ   (θ = banking into the turn; with
 *    `crests`, less the v²·κ_v a crest takes off the load)
 * 2. Backward pass (braking):    friction-circle-limited brake deceleration incl. downforce and drag
 * 3. Forward pass (traction):    power / rear-axle grip limited acceleration minus drag
 *
 * The same profile feeds the AI driver and the track's `optimalSpeedKmh` (HUD target speed,
 * braking-zone markers, ghost cars), so they all agree with what this car can actually do.
 */

import type { AeroSetupPreset, RacingLineId, TrackSamplePoint } from '@/types/f1';
import { estimateAeroCoefficients } from './lc26-aero';
import { LC26_BRAKES, LC26_CHASSIS, LC26_TYRES } from './lc26-data';

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
  /**
   * Tyre load sensitivity: μ falls as the load grows, μ = μ₀ · n^−k with n the load over the car's weight (1 at rest,
   * ~3 at an F1 car's top speed). Absent / 0: constant μ.
   */
  muLoadExp?: number;
  /** Downforce per (m/s)² at speed v, where it changes with the car's attitude (ride height under aero load); absent:
   * the constant `downforceCoef` */
  downforceCoefAt?: (vMs: number) => number;
}

/** Downforce per (m/s)² of a planning model at speed v */
export function plannedDownforceCoef(car: SpeedProfileCarModel, vMs: number): number {
  return car.downforceCoefAt ? car.downforceCoefAt(vMs) : car.downforceCoef;
}

/** A planning μ at speed v, after the tyres' load sensitivity */
export function plannedMu(car: SpeedProfileCarModel, mu: number, vMs: number): number {
  const k = car.muLoadExp ?? 0;
  if (k === 0) return mu;
  const n = 1 + (plannedDownforceCoef(car, vMs) * vMs * vMs) / (car.massKg * G);
  return mu * Math.pow(n, -k);
}

export interface SpeedProfileOptions {
  /**
   * Allow for the weight a crest takes off the tyres (v² × the road's vertical curvature). On for what the player is
   * shown (a car's braking guide: line colours, braking urgency, HUD target speed): without it the target through a
   * bend over a crest was up to 30 km/h more than the car could hold. Off for the circuit's own profile and the AI's
   * planning, which has its own caution over crests.
   */
  crests?: boolean;
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
export function lc26FullBrakeForceN(): number {
  const t = LC26_BRAKES.maxTorqueNm * LC26_BRAKES.powerMult;
  return (
    2 * ((t * LC26_BRAKES.frontBias) / LC26_TYRES.soft.front.radius) +
    2 * ((t * (1 - LC26_BRAKES.frontBias)) / LC26_TYRES.soft.rear.radius)
  );
}

/**
 * Nominal LC26 planning model for an aero package. μ values sit ~4 % under what the car
 * achieves on the skidpad / in straight-line braking with tyres in their window.
 */
export function createLc26ProfileCarModel(
  preset: AeroSetupPreset = 'balanced',
  airDensity = NOMINAL_AIR_DENSITY,
  /** Garage wing trim (deg); the AI field drives the untrimmed package */
  wingTrimDeg?: { front: number; rear: number }
): SpeedProfileCarModel {
  // Typical at-speed attitude: ~17 mm lower than static, slight nose-up rake change
  const aero = estimateAeroCoefficients(preset, airDensity, -0.017, 0.0015, 0, undefined, wingTrimDeg);
  const downforceCoefAt = lc26DownforceCurve(preset, airDensity, wingTrimDeg);
  return {
    massKg: LC26_CHASSIS.totalMassKg + LC26_CHASSIS.fuelKg,
    downforceCoef: aero.downforceCoef,
    dragCoef: aero.dragCoef,
    rearDownforceShare: 1 - aero.frontShare,
    rearWeightFraction: 1 - LC26_CHASSIS.frontWeightFraction,
    muLat: 1.66,
    muLong: 1.65,
    maxBrakeForceN: lc26FullBrakeForceN() * 0.92,
    maxDrivePowerW: 650_000,
    vMaxMs: 95,
    // Fitted to the car's own steady cornering limit on the flat pad (2.03 / 3.33 / 4.27 g at 86 / 180 / 248 km/h, sea
    // level), 4–6 % under it: the tyres give less μ as the aero load grows, and the downforce follows the ride height
    muLoadExp: 0.1,
    downforceCoefAt,
  };
}

/**
 * The LC26's downforce per (m/s)² against speed: the car settles on its springs, heave springs, packers and tyres under
 * its own downforce, and the floor's ground effect follows that ride height (it peaks near 33 mm and falls away below
 * it). Solved for the steady attitude at each speed (fixed point), tabulated every 5 m/s and interpolated.
 */
function lc26DownforceCurve(
  preset: AeroSetupPreset,
  airDensity: number,
  wingTrimDeg?: { front: number; rear: number }
): (vMs: number) => number {
  const L = LC26_CHASSIS.wheelbase;
  const a = L * (1 - LC26_CHASSIS.frontWeightFraction);
  const b = L - a;
  // Axle heave stiffness: two corner springs and the heave spring, in series with two tyres; the packer adds its rate
  // past its travel
  const axleDrop = (ax: typeof LC26_CHASSIS.front, tyreRate: number, forceN: number) => {
    const sprung = 2 * ax.springRate + ax.heaveRate;
    let d = forceN / sprung;
    if (d > ax.heavePackerTravel) d = ax.heavePackerTravel + (forceN - ax.heavePackerTravel * sprung) / (sprung + ax.heavePackerRate);
    return d + forceN / (2 * tyreRate);
  };
  const table: number[] = [];
  for (let v = 0; v <= 100; v += 5) {
    let heave = 0;
    let pitch = 0;
    let coef = 0;
    for (let it = 0; it < 6; it++) {
      const e = estimateAeroCoefficients(preset, airDensity, heave, pitch, 0, undefined, wingTrimDeg);
      coef = e.downforceCoef;
      const df = coef * v * v;
      const dF = axleDrop(LC26_CHASSIS.front, LC26_TYRES.soft.front.rate, df * e.frontShare);
      const dR = axleDrop(LC26_CHASSIS.rear, LC26_TYRES.soft.rear.rate, df * (1 - e.frontShare));
      // Body heave at the CG and pitch (+ nose up) from the two axle drops
      pitch = (dR - dF) / L;
      heave = -(dF * b + dR * a) / L;
    }
    table.push(coef);
  }
  return (vMs: number) => {
    const x = Math.min(table.length - 1.001, Math.max(0, vMs / 5));
    const i = Math.floor(x);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  };
}

export function computeSpeedProfile(
  samples: ReadonlyArray<TrackSamplePoint>,
  car: SpeedProfileCarModel,
  line: RacingLineId = 'f1',
  opts: SpeedProfileOptions = {}
): SpeedProfile {
  const n = samples.length;
  const m = car.massKg;
  // Weight a crest takes off the tyres, per (m/s)² of speed: how fast the road falls away under the car (1/m)
  const crest = new Float64Array(n);
  if (opts.crests) for (let i = 0; i < n; i++) crest[i] = Math.max(0, -samples[i].verticalCurvature);
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
  const constantGrip = !car.muLoadExp && !car.downforceCoefAt;
  const aeroLat = (car.muLat * car.downforceCoef) / m;
  const cl = (v: number) => plannedDownforceCoef(car, v);
  const muLatAt = (v: number) => plannedMu(car, car.muLat, v);
  const muLongAt = (v: number) => plannedMu(car, car.muLong, v);
  for (let i = 0; i < n; i++) {
    const k = Math.abs(curvature[i]);
    const bankInto = samples[i].bankingRad * Math.sign(curvature[i] || 1);
    gN[i] = G * Math.cos(bankInto);
    gT[i] = G * Math.sin(bankInto);
    if (constantGrip) {
      const den = k + car.muLat * crest[i] - aeroLat;
      const vLat = den > 1e-7 ? Math.sqrt(Math.max(0, (car.muLat * gN[i] + gT[i]) / den)) : car.vMaxMs;
      speedMs[i] = Math.min(car.vMaxMs, vLat);
    } else {
      // Grip and downforce both change with speed: the highest speed whose lateral limit still covers v²·κ (bisection;
      // the limit grows slower than v²·κ above the corner speed)
      const spare = (v: number) => muLatAt(v) * Math.max(0, gN[i] - crest[i] * v * v + (cl(v) * v * v) / m) + gT[i] - v * v * k;
      if (spare(car.vMaxMs) >= 0) speedMs[i] = car.vMaxMs;
      else {
        let lo = 0;
        let hi = car.vMaxMs;
        for (let it = 0; it < 28; it++) {
          const mid = 0.5 * (lo + hi);
          if (spare(mid) >= 0) lo = mid;
          else hi = mid;
        }
        speedMs[i] = lo;
      }
    }
  }

  // Fraction of the friction circle still available after the lateral demand at speed v
  const longShare = (i: number, v: number) => {
    const latMax = muLatAt(v) * Math.max(0, gN[i] - crest[i] * v * v + (cl(v) * v * v) / m);
    const latUsed = Math.max(0, v * v * Math.abs(curvature[i]) - gT[i]);
    // Between a friction circle and a linear trade-off: with fixed left/right brake and drive
    // torque the less-loaded tyre saturates first, so combined grip is below the ideal circle
    const r = Math.min(1, latUsed / Math.max(1e-6, latMax));
    return Math.max(0, 1 - r * r) ** 0.75;
  };

  const backwardPass = (v: Float64Array) => {
    // Deceleration available braking at speed u through sample i: tyre grip with u's downforce, the share of it the
    // cornering at u leaves (friction circle), and u's drag
    const decelAt = (i: number, u: number) =>
      Math.min(muLongAt(u) * Math.max(0, G - crest[i] * u * u + (cl(u) * u * u) / m), car.maxBrakeForceN / m) * longShare(i, u) +
      (car.dragCoef * u * u) / m;
    for (let step = 0; step < n; step++) {
      const i = n - 1 - step;
      const j = (i + 1) % n;
      const vn = v[j];
      // Across the segment the speed runs from the entry speed down to vn: estimate the entry speed at vn, then take
      // every speed-dependent term (downforce grip, the cornering's share of it, drag) at the segment's midpoint
      // speed. Taking only the friction share at a higher speed, and the downforce at vn, understated the braking
      const vEst = Math.min(v[i], Math.sqrt(vn * vn + 2 * decelAt(i, vn) * segLenM[i]));
      const decel = decelAt(i, 0.5 * (vn + vEst));
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
        muLongAt(v) * Math.max(0, car.rearWeightFraction * (G - crest[i] * v * v) + (car.rearDownforceShare * cl(v) * v * v) / m);
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
 * urgency and the HUD target speed. It allows for crests; the circuit's profile baked into the samples (the LC26's),
 * which the AI reads, does not.
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
    const profile = computeSpeedProfile(samples, car, line, { crests: true });
    const n = samples.length;
    const brakingZone = new Float32Array(n);
    // The circuit's zones (`brakingZoneLevel`) are an absolute speed drop tuned to the LC26's ~4 g; for any car,
    // grade the deceleration the profile asks for over the next three samples against what this car can brake
    // with at that speed. These fractions give the LC26 the same 540 m of red / 300 m of amber on Rwanda.
    for (let i = 0; i < n; i++) {
      const v = profile.speedMs[i];
      const w = profile.speedMs[(i + 3) % n];
      const ds = profile.segLenM[i] + profile.segLenM[(i + 1) % n] + profile.segLenM[(i + 2) % n];
      const need = (v * v - w * w) / (2 * ds);
      const grip = plannedMu(car, car.muLong, v) * (G + (plannedDownforceCoef(car, v) * v * v) / car.massKg);
      const can = Math.min(grip, car.maxBrakeForceN / car.massKg) + (car.dragCoef * v * v) / car.massKg;
      brakingZone[i] = need > BRAKING_ZONE_RED * can ? 1.0 : need > BRAKING_ZONE_AMBER * can ? 0.5 : 0.0;
    }
    guide = { line, speedMs: profile.speedMs, brakeEnvelopeMs: profile.brakeEnvelopeMs, brakingZone };
    perCar.set(key, guide);
  }
  return guide;
}

/** The guide of a car without a planning model of its own: the circuit's car's (the LC26 with balanced aero) */
export function circuitBrakingGuide(samples: ReadonlyArray<TrackSamplePoint>, line: RacingLineId = 'f1'): BrakingGuide {
  return brakingGuideFor(samples, 'lc26', createLc26ProfileCarModel('balanced'), line);
}

/** Linear interpolation of a per-sample profile array at track distance s */
export function sampleProfile(values: Float64Array, s: number, totalLengthM: number): number {
  const n = values.length;
  const x = ((((s % totalLengthM) + totalLengthM) % totalLengthM) / totalLengthM) * n;
  const i0 = Math.floor(x) % n;
  const t = x - Math.floor(x);
  return values[i0] + (values[(i0 + 1) % n] - values[i0]) * t;
}
