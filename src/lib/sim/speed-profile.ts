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
  /**
   * A sample the car stands still at: a hill climb's start line, for the racing-line optimiser's run from rest. The
   * profile brakes to a stop there and accelerates away from it
   */
  standingStartAt?: number;
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

/** Catmull-Rom 1D interpolation for t in [0, 1] between p1 and p2 given neighbours p0 and p3 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Target physical sample spacing (m) for curvature and braking-envelope solving. Circuits longer than ~7 km have
 * coarse 1200-sample spacing (e.g. 11.4 m on Sarthe 1982) that smears tight chicanes unless subdivided first.
 */
const FINE_GRID_TRIGGER_M = 6.0;
const FINE_GRID_TARGET_M = 4.5;
/** Physical half-chord for Menger curvature (m): ~9 m matches ±2 samples on a 5 km / 1200-sample circuit */
const CURVATURE_CHORD_HALF_M = 9.0;
/** Physical lookahead distance for static braking-zone grading (m): matches 3 samples on Rwanda (~13.5 m) */
const BRAKING_ZONE_LOOK_M = 13.5;

export function computeSpeedProfile(
  samples: ReadonlyArray<TrackSamplePoint>,
  car: SpeedProfileCarModel,
  line: RacingLineId = 'f1',
  opts: SpeedProfileOptions = {}
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
  let totalLenM = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.max(0.1, Math.hypot(px[j] - px[i], pz[j] - pz[i]));
    segLenM[i] = len;
    totalLenM += len;
  }
  const avgStepM = totalLenM / Math.max(1, n);

  // Subdivide coarse long circuits (e.g. Le Mans 13.6 km at 11.4 m/sample) onto a ~4.5 m smooth Catmull-Rom grid
  // so tight chicanes and hairpins are resolved accurately before reducing back to the caller's sample array.
  const sub = avgStepM > FINE_GRID_TRIGGER_M ? Math.ceil(avgStepM / FINE_GRID_TARGET_M) : 1;
  const gn = n * sub;
  const gx = sub === 1 ? px : new Float64Array(gn);
  const gz = sub === 1 ? pz : new Float64Array(gn);
  const gBank = new Float64Array(gn);
  const gSlope = new Float64Array(gn);
  const gCrest = new Float64Array(gn);
  const gSegLen = sub === 1 ? segLenM : new Float64Array(gn);

  if (sub === 1) {
    for (let i = 0; i < n; i++) {
      const sp = samples[i];
      gBank[i] = sp.bankingRad;
      if (opts.crests) {
        gSlope[i] = sp.slopeSin ?? 0;
        gCrest[i] = Math.max(0, -sp.verticalCurvature);
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const i0 = (i - 1 + n) % n;
      const i1 = i;
      const i2 = (i + 1) % n;
      const i3 = (i + 2) % n;
      const s1 = samples[i1];
      const s2 = samples[i2];
      const c1 = opts.crests ? Math.max(0, -s1.verticalCurvature) : 0;
      const c2 = opts.crests ? Math.max(0, -s2.verticalCurvature) : 0;
      const sl1 = opts.crests ? (s1.slopeSin ?? 0) : 0;
      const sl2 = opts.crests ? (s2.slopeSin ?? 0) : 0;
      for (let q = 0; q < sub; q++) {
        const gi = i * sub + q;
        const t = q / sub;
        gx[gi] = q === 0 ? px[i1] : catmullRom(px[i0], px[i1], px[i2], px[i3], t);
        gz[gi] = q === 0 ? pz[i1] : catmullRom(pz[i0], pz[i1], pz[i2], pz[i3], t);
        gBank[gi] = s1.bankingRad + (s2.bankingRad - s1.bankingRad) * t;
        gSlope[gi] = sl1 + (sl2 - sl1) * t;
        gCrest[gi] = c1 + (c2 - c1) * t;
      }
    }
    for (let i = 0; i < gn; i++) {
      const j = (i + 1) % gn;
      gSegLen[i] = Math.max(0.1, Math.hypot(gx[j] - gx[i], gz[j] - gz[i]));
    }
  }

  const gridStepM = totalLenM / Math.max(1, gn);
  const chordStep = sub === 1 ? 2 : Math.max(1, Math.round(CURVATURE_CHORD_HALF_M / Math.max(0.5, gridStepM)));

  // Menger curvature over ±2 samples (short/fine circuits) or physical ±9 m half-chord (subdivided long circuits), + right
  const raw = new Float64Array(gn);
  for (let i = 0; i < gn; i++) {
    const a = (i - chordStep + gn) % gn;
    const c = (i + chordStep) % gn;
    const abx = gx[i] - gx[a];
    const abz = gz[i] - gz[a];
    const bcx = gx[c] - gx[i];
    const bcz = gz[c] - gz[i];
    const cross = abx * bcz - abz * bcx;
    const den = Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(gx[c] - gx[a], gz[c] - gz[a]);
    raw[i] = den > 1e-9 ? (2 * cross) / den : 0;
  }

  const gCurv = new Float64Array(gn);
  const gCurvAbs = new Float64Array(gn);
  if (sub === 1) {
    // Already finely sampled circuit: preserve the 5-tap signed [1, 2, 3, 2, 1]/9 kernel so narrow/bumpy
    // short circuits (e.g. Borgloh, Rwanda) keep their exact established curvature profile without noise amplification.
    for (let i = 0; i < gn; i++) {
      const k =
        (raw[(i - 2 + gn) % gn] +
          2 * raw[(i - 1 + gn) % gn] +
          3 * raw[i] +
          2 * raw[(i + 1) % gn] +
          raw[(i + 2) % gn]) /
        9;
      gCurv[i] = k;
      gCurvAbs[i] = Math.abs(k);
    }
  } else {
    // Subdivided coarse long circuits (e.g. Sarthe 1982): smooth Catmull-Rom grid lets us smooth |κ| with [1, 2, 1]/4
    // so tight opposing chicanes (Virage Ford / Virage du Raccordement) never cancel out to flat straights.
    for (let i = 0; i < gn; i++) {
      const prev = raw[(i - 1 + gn) % gn];
      const cur = raw[i];
      const next = raw[(i + 1) % gn];
      gCurv[i] = 0.25 * (prev + 2 * cur + next);
      gCurvAbs[i] = 0.25 * (Math.abs(prev) + 2 * Math.abs(cur) + Math.abs(next));
    }
  }

  // 1. Lateral limit
  const gN = new Float64Array(gn);
  const gT = new Float64Array(gn);
  const gSpeedMs = new Float64Array(gn);
  const constantGrip = !car.muLoadExp && !car.downforceCoefAt;
  const aeroLat = (car.muLat * car.downforceCoef) / m;
  const cl = (v: number) => plannedDownforceCoef(car, v);
  const muLatAt = (v: number) => plannedMu(car, car.muLat, v);
  const muLongAt = (v: number) => plannedMu(car, car.muLong, v);
  for (let i = 0; i < gn; i++) {
    const k = gCurvAbs[i];
    const bankInto = gBank[i] * Math.sign(gCurv[i] || raw[i] || 1);
    gN[i] = G * Math.cos(bankInto);
    gT[i] = G * Math.sin(bankInto);
    if (constantGrip) {
      const den = k + car.muLat * gCrest[i] - aeroLat;
      const vLat = den > 1e-7 ? Math.sqrt(Math.max(0, (car.muLat * gN[i] + gT[i]) / den)) : car.vMaxMs;
      gSpeedMs[i] = Math.min(car.vMaxMs, vLat);
    } else {
      // Grip and downforce both change with speed: the highest speed whose lateral limit still covers v²·κ (bisection;
      // the limit grows slower than v²·κ above the corner speed)
      const spare = (v: number) => muLatAt(v) * Math.max(0, gN[i] - gCrest[i] * v * v + (cl(v) * v * v) / m) + gT[i] - v * v * k;
      if (spare(car.vMaxMs) >= 0) gSpeedMs[i] = car.vMaxMs;
      else {
        let lo = 0;
        let hi = car.vMaxMs;
        for (let it = 0; it < 28; it++) {
          const mid = 0.5 * (lo + hi);
          if (spare(mid) >= 0) lo = mid;
          else hi = mid;
        }
        gSpeedMs[i] = lo;
      }
    }
  }

  if (opts.standingStartAt !== undefined) {
    const startIdx = opts.standingStartAt * sub;
    gSpeedMs[startIdx] = Math.min(gSpeedMs[startIdx], 0.5);
  }

  // Fraction of the friction circle still available after the lateral demand at speed v
  const longShare = (i: number, v: number) => {
    const latMax = muLatAt(v) * Math.max(0, gN[i] - gCrest[i] * v * v + (cl(v) * v * v) / m);
    const latUsed = Math.max(0, v * v * gCurvAbs[i] - gT[i]);
    // Between a friction circle and a linear trade-off: with fixed left/right brake and drive
    // torque the less-loaded tyre saturates first, so combined grip is below the ideal circle
    const r = Math.min(1, latUsed / Math.max(1e-6, latMax));
    return Math.max(0, 1 - r * r) ** 0.75;
  };

  const backwardPass = (v: Float64Array) => {
    // Deceleration available braking at speed u through sample i: tyre grip with u's downforce, the share of it the
    // cornering at u leaves (friction circle), u's drag, and road grade (slopeSin > 0 uphill helps braking, < 0 downhill hurts it)
    const decelAt = (i: number, u: number) =>
      Math.max(
        0.5,
        Math.min(muLongAt(u) * Math.max(0, G - gCrest[i] * u * u + (cl(u) * u * u) / m), car.maxBrakeForceN / m) * longShare(i, u) +
          (car.dragCoef * u * u) / m +
          G * gSlope[i]
      );
    for (let step = 0; step < gn; step++) {
      const i = gn - 1 - step;
      const j = (i + 1) % gn;
      const vn = v[j];
      const vEst = Math.min(v[i], Math.sqrt(vn * vn + 2 * decelAt(i, vn) * gSegLen[i]));
      const decel = decelAt(i, 0.5 * (vn + vEst));
      v[i] = Math.min(v[i], Math.sqrt(vn * vn + 2 * decel * gSegLen[i]));
    }
  };
  const gBrakeEnvelopeMs = Float64Array.from(gSpeedMs);
  backwardPass(gBrakeEnvelopeMs);
  backwardPass(gBrakeEnvelopeMs);

  for (let pass = 0; pass < 3; pass++) {
    // 2. Backward: braking into each sample
    backwardPass(gSpeedMs);
    // 3. Forward: acceleration out of each sample
    for (let i = 0; i < gn; i++) {
      const j = (i + 1) % gn;
      const v = gSpeedMs[i];
      const traction =
        muLongAt(v) * Math.max(0, car.rearWeightFraction * (G - gCrest[i] * v * v) + (car.rearDownforceShare * cl(v) * v * v) / m);
      const power = car.maxDrivePowerW / (m * Math.max(5, v));
      const accel = Math.min(traction, power) * longShare(i, v) - (car.dragCoef * v * v) / m - G * gSlope[i];
      gSpeedMs[j] = Math.min(gSpeedMs[j], Math.sqrt(Math.max(0, v * v + 2 * accel * gSegLen[i])));
    }
  }

  if (sub === 1) {
    return { lineOffsetM, curvature: gCurv, speedMs: gSpeedMs, brakeEnvelopeMs: gBrakeEnvelopeMs, segLenM, pointX: px, pointZ: pz };
  }

  // Reduce the fine-grid profile back to `samples.length`: preserve the tightest apex speed/envelope inside each
  // sample's half-interval so linear interpolation between coarse samples never skips a tight chicane apex.
  const curvature = new Float64Array(n);
  const speedMs = new Float64Array(n);
  const brakeEnvelopeMs = new Float64Array(n);
  const halfLo = Math.floor((sub - 1) / 2);
  const halfHi = Math.ceil((sub - 1) / 2);
  for (let i = 0; i < n; i++) {
    const center = i * sub;
    let minV = gSpeedMs[center];
    let minEnv = gBrakeEnvelopeMs[center];
    let peakCurv = gCurv[center];
    for (let q = -halfLo; q <= halfHi; q++) {
      const gi = (center + q + gn) % gn;
      if (gSpeedMs[gi] < minV) minV = gSpeedMs[gi];
      if (gBrakeEnvelopeMs[gi] < minEnv) minEnv = gBrakeEnvelopeMs[gi];
      if (Math.abs(gCurv[gi]) > Math.abs(peakCurv)) peakCurv = gCurv[gi];
    }
    speedMs[i] = minV;
    brakeEnvelopeMs[i] = minEnv;
    curvature[i] = peakCurv;
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
    // Grade the deceleration the profile asks for over a physical lookahead (~13.5 m, 3 samples on a 5 km track)
    // against what this car can brake with at that speed, so long circuits (Le Mans 13.6 km) stay calibrated.
    let totalSegLen = 0;
    for (let i = 0; i < n; i++) totalSegLen += profile.segLenM[i];
    const avgStepM = totalSegLen / Math.max(1, n);
    const lookSteps = Math.max(1, Math.round(BRAKING_ZONE_LOOK_M / Math.max(0.5, avgStepM)));
    for (let i = 0; i < n; i++) {
      const v = profile.speedMs[i];
      const w = profile.speedMs[(i + lookSteps) % n];
      let ds = 0;
      for (let k = 0; k < lookSteps; k++) ds += profile.segLenM[(i + k) % n];
      const need = (v * v - w * w) / (2 * Math.max(0.1, ds));
      const grip = plannedMu(car, car.muLong, v) * (G + (plannedDownforceCoef(car, v) * v * v) / car.massKg);
      const can = Math.max(0.5, Math.min(grip, car.maxBrakeForceN / car.massKg) + (car.dragCoef * v * v) / car.massKg + G * (samples[i].slopeSin ?? 0));
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
