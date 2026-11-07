/**
 * Transient handling manoeuvres, run open loop on any `SimulatorCar` on a flat, very wide pad without driver aids.
 *
 * Steady-state numbers (cornering g at one speed) say how much grip a car has. How it *feels* is mostly transient:
 * how quickly it answers the wheel, whether it overshoots, what it does when the driver lifts, brakes or floors it
 * mid-corner. These are the standard vehicle-dynamics tests for that, after the ISO procedures they are named for:
 *
 *  - steady ramp       ISO 4138: slow steer ramp at constant speed: peak lateral g, understeer gradient, and whether
 *                      more lock still adds grip near the limit (front saturation)
 *  - step steer        ISO 7401: yaw-rate response time, peak time and overshoot
 *  - sine steer        ISO 7401: yaw-rate gain and phase lag at 0.5 / 1 / 2 Hz (lag is the "delay" a driver feels)
 *  - lift-off          ISO 9816: throttle closed mid-corner at 70 % of the limit: yaw-rate change after 1 s, body slip
 *  - brake in turn     ISO 7975: braking mid-corner at 50 % of the limit
 *  - power-on exit     full throttle out of a slow corner at 70 % of the limit: how far the rear steps out
 *
 * Shared by `handling-report.ts` (prints the scorecard) and the verify suites that hold its bands.
 */
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';

export const DT = 1 / 120;
/** Body slip past which a run counts as a spin (rad, ≈ 20°) */
export const SPIN_SLIP_RAD = 0.35;

export type MakeCar = () => SimulatorCar;

interface Sample {
  t: number;
  /** Road-wheel steer (rad, + right) */
  steer: number;
  /** Yaw rate (rad/s, + right) */
  r: number;
  /** Lateral acceleration (g, + = towards the right), from the body motion (a_y = v_x·r − dv_y/dt), not the
   * telemetry channel: some models smooth that one for the HUD */
  ay: number;
  /** Body slip (rad, unsigned) */
  beta: number;
  v: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const slip = (c: SimulatorCar) => Math.abs(Math.atan2(c.vyMs, Math.max(1, Math.abs(c.vxMs))));
const sample = (c: SimulatorCar, t: number, prevVy: number): Sample => ({
  t,
  steer: c.steerAngleNorm * c.maxSteerAngleRad,
  r: c.yawRateRadS,
  // v_y is + left, r + right
  ay: (c.vxMs * c.yawRateRadS - (c.vyMs - prevVy) / DT) / 9.81,
  beta: slip(c),
  v: c.vxMs,
});

/** A car on the pad at speed, with every driver aid off */
export function startCar(make: MakeCar, vMs: number): SimulatorCar {
  const car = make();
  const anyCar = car as unknown as { setAssistPreset?: (p: string) => void };
  if (anyCar.setAssistPreset) anyCar.setAssistPreset('pro');
  else car.assistPreset = 'pro';
  car.teleportToDistance(1500, vMs, 0);
  return car;
}

/** Throttle that holds a speed (PI on speed error) */
function speedHold(vTarget: number) {
  let integ = 0.3;
  return (c: SimulatorCar) => {
    const e = vTarget - c.vxMs;
    integ = clamp(integ + 0.4 * e * DT, 0, 1);
    return clamp(integ + 0.6 * e, 0, 1);
  };
}

/** Drives for `seconds`; `steerAt(t)` is normalised steer (+ right). Stops early on a spin. */
function drive(
  car: SimulatorCar,
  seconds: number,
  steerAt: (t: number) => number,
  pedals: (c: SimulatorCar, t: number) => { throttle: number; brake: number },
  out: Sample[] = []
): Sample[] {
  for (let t = 0; t < seconds; t += DT) {
    const p = pedals(car, t);
    const vy = car.vyMs;
    car.step(DT, { throttle: p.throttle, brake: p.brake, analogSteer: steerAt(t) });
    out.push(sample(car, t + DT, vy));
    if (slip(car) > SPIN_SLIP_RAD) break;
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

export interface RampResult {
  /** Best 1 s average lateral g */
  maxG: number;
  /** Normalised steer at the best 1 s window */
  steerAtMax: number;
  /** Road-wheel understeer gradient over 10–50 % of the peak (deg/g), from steer = L/R + K·a_y */
  understeerDegPerG: number;
  /** Lateral g gained by the last 25 % of the lock used before the peak, as a share of the peak (low = the front has
   * stopped answering the wheel well before the limit) */
  lateGainShare: number;
  /** Normalised steer → lateral g curve, for picking test steer amounts */
  curve: [number, number][];
}

/** ISO 4138-style slow steer ramp at constant speed */
export function steadyRamp(make: MakeCar, vMs: number, seconds = 12, maxNorm = 1): RampResult {
  const car = startCar(make, vMs);
  const hold = speedHold(vMs);
  const norm = (t: number) => Math.min(1, t / seconds) * maxNorm;
  const s = drive(car, seconds, norm, (c) => ({ throttle: hold(c), brake: 0 }));
  const win = Math.round(1 / DT);
  let best = 0;
  let bestI = 0;
  for (let i = win; i < s.length; i++) {
    const m = Math.abs(mean(s.slice(i - win, i).map((x) => x.ay)));
    if (m > best) {
      best = m;
      bestI = i - Math.round(win / 2);
    }
  }
  const curve: [number, number][] = s.map((x) => [norm(x.t), Math.abs(x.ay)]);
  // Understeer gradient: least squares of road steer against a_y in the linear range
  const lin = s
    .filter((x) => x.t <= s[bestI].t)
    .map((x) => ({ ...x, ay: Math.abs(x.ay) }))
    .filter((x) => x.ay > 0.1 * best && x.ay < 0.5 * best);
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  // At constant speed L/R = L·a_y/V² also grows with a_y, so the slope holds both terms; the geometric one is taken
  // out below
  for (const x of lin) {
    sx += x.ay;
    sy += Math.abs(x.steer);
    sxx += x.ay * x.ay;
    sxy += x.ay * Math.abs(x.steer);
  }
  const n = Math.max(1, lin.length);
  const slope = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  // Geometric part at this speed: L/R per g = L·g/V²; the rest of the slope is the understeer gradient
  const geomDegPerG = ((make().wheelbaseM * 9.81) / (vMs * vMs)) * (180 / Math.PI);
  const understeerDegPerG = slope * (180 / Math.PI) - geomDegPerG;
  const steerAtMax = norm(s[bestI]?.t ?? 0);
  const quarterBack = s.findIndex((x) => norm(x.t) >= steerAtMax * 0.75);
  const gAtQuarter = quarterBack >= 0 ? Math.abs(mean(s.slice(Math.max(0, quarterBack - 60), quarterBack + 60).map((x) => x.ay))) : best;
  return { maxG: best, steerAtMax, understeerDegPerG, lateGainShare: (best - gAtQuarter) / Math.max(1e-6, best), curve };
}

/** Normalised steer that gives `frac` of the ramp's peak g (first crossing) */
export function steerFor(ramp: RampResult, frac: number): number {
  const target = ramp.maxG * frac;
  // Smooth the curve a little: the instantaneous a_y is noisy
  for (let i = 6; i < ramp.curve.length - 6; i++) {
    const g = mean(ramp.curve.slice(i - 6, i + 6).map((p) => p[1]));
    if (g >= target) return ramp.curve[i][0];
  }
  return ramp.steerAtMax;
}

export interface StepResult {
  /** Steady yaw rate (deg/s) */
  rSsDegS: number;
  /** Time from 50 % steer to 90 % of the steady yaw rate (s) */
  responseTimeS: number;
  /** Time from 50 % steer to the yaw-rate peak (s) */
  peakTimeS: number;
  /** Yaw-rate overshoot over the steady value (%) */
  overshootPct: number;
  spun: boolean;
}

/**
 * ISO 7401 step steer: straight, then the steer `steerNorm` as fast as the rack allows, or ramped in over `rampS` (ISO
 * asks for 200–500 °/s at the rim)
 */
export function stepSteer(make: MakeCar, vMs: number, steerNorm: number, rampS = 0): StepResult {
  const car = startCar(make, vMs);
  const hold = speedHold(vMs);
  const T0 = 0.5;
  const at = (t: number) => (t < T0 ? 0 : rampS > 0 ? steerNorm * Math.min(1, (t - T0) / rampS) : steerNorm);
  const s = drive(car, T0 + 3.5, at, (c) => ({ throttle: hold(c), brake: 0 }));
  const spun = s.some((x) => x.beta > SPIN_SLIP_RAD);
  const steerSs = Math.abs(s[s.length - 1].steer);
  const t50 = s.find((x) => x.t > T0 && Math.abs(x.steer) >= 0.5 * steerSs)?.t ?? T0;
  const tail = s.filter((x) => x.t > s[s.length - 1].t - 1);
  const rSs = mean(tail.map((x) => x.r));
  const after = s.filter((x) => x.t >= t50);
  const t90 = after.find((x) => x.r * Math.sign(rSs) >= 0.9 * Math.abs(rSs))?.t ?? NaN;
  let peak = after[0];
  for (const x of after) if (x.r * Math.sign(rSs) > peak.r * Math.sign(rSs)) peak = x;
  return {
    rSsDegS: (rSs * 180) / Math.PI,
    responseTimeS: t90 - t50,
    peakTimeS: peak.t - t50,
    overshootPct: ((Math.abs(peak.r) - Math.abs(rSs)) / Math.max(1e-6, Math.abs(rSs))) * 100,
    spun,
  };
}

export interface SineResult {
  hz: number;
  /** Yaw-rate gain (deg/s of yaw per deg of road-wheel steer) */
  gain: number;
  /** Yaw-rate lag behind the road-wheel steer (deg) */
  lagDeg: number;
  /** Lateral-acceleration lag behind the road-wheel steer (deg) */
  ayLagDeg: number;
}

/** Fits a·sin(ωt) + b·cos(ωt) + c; returns amplitude and phase */
function fitSine(ts: number[], ys: number[], w: number) {
  let ss = 0, sc = 0, cc = 0, ys_ = 0, yc = 0;
  const m = mean(ys);
  for (let i = 0; i < ts.length; i++) {
    const s = Math.sin(w * ts[i]);
    const c = Math.cos(w * ts[i]);
    const y = ys[i] - m;
    ss += s * s;
    sc += s * c;
    cc += c * c;
    ys_ += y * s;
    yc += y * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys_ * cc - yc * sc) / det;
  const b = (yc * ss - ys_ * sc) / det;
  return { amp: Math.hypot(a, b), phase: Math.atan2(b, a) };
}

/** ISO 7401 sinusoidal steer at `hz`, sized to `steerNorm` */
export function sineSteer(make: MakeCar, vMs: number, steerNorm: number, hz: number): SineResult {
  const car = startCar(make, vMs);
  const hold = speedHold(vMs);
  const w = 2 * Math.PI * hz;
  const cycles = 4;
  const s = drive(car, cycles / hz, (t) => steerNorm * Math.sin(w * t), (c) => ({ throttle: hold(c), brake: 0 }));
  // Skip the first cycle (start-up transient)
  const use = s.filter((x) => x.t > 1 / hz);
  const ts = use.map((x) => x.t);
  const fs = fitSine(ts, use.map((x) => x.steer), w);
  const fr = fitSine(ts, use.map((x) => x.r), w);
  const fa = fitSine(ts, use.map((x) => x.ay), w);
  const wrap = (d: number) => ((((d * 180) / Math.PI) % 360) + 540) % 360 - 180;
  return {
    hz,
    gain: fr.amp / Math.max(1e-9, fs.amp),
    lagDeg: wrap(fs.phase - fr.phase),
    ayLagDeg: wrap(fs.phase - fa.phase),
  };
}

export interface MidCornerResult {
  /** Path curvature (yaw rate / speed) 1 s after the event over the curvature at it: 1 = holds its line, > 1 = the car
   * tightens its line (rotates), < 1 = it runs wide. Curvature rather than yaw rate, because braking alone lowers the
   * yaw rate on the same line. */
  curvatureRatio: number;
  /** Peak body slip after the event (deg) */
  peakSlipDeg: number;
  /** Time from the event until the body slip reaches 10° (s; Infinity = never): the window a driver has to catch it */
  timeTo10degS: number;
  spun: boolean;
}

/**
 * Steady cornering at `steerNorm` (≈ `frac` of the limit), then at t = 3 s the pedals change to `after`:
 * lift-off (throttle 0), brake-in-turn, or power-on (throttle 1). The steering is held.
 */
export function midCorner(
  make: MakeCar,
  vMs: number,
  steerNorm: number,
  after: { throttle: number; brake: number }
): MidCornerResult {
  const car = startCar(make, vMs);
  const hold = speedHold(vMs);
  const T0 = 3;
  const s = drive(
    car,
    T0 + 1.5,
    (t) => Math.min(1, t / 1) * steerNorm,
    (c, t) => (t < T0 ? { throttle: hold(c), brake: 0 } : after)
  );
  const at = s.filter((x) => x.t > T0 - 0.25 && x.t <= T0);
  const k0 = mean(at.map((x) => x.r / Math.max(1, x.v)));
  const x1 = s.find((x) => x.t >= T0 + 1) ?? s[s.length - 1];
  const post = s.filter((x) => x.t > T0);
  const spun = s.some((x) => x.beta > SPIN_SLIP_RAD);
  const t10 = post.find((x) => x.beta > (10 * Math.PI) / 180)?.t;
  return {
    curvatureRatio: x1.r / Math.max(1, x1.v) / (Math.abs(k0) < 1e-9 ? 1e-9 : k0),
    peakSlipDeg: (Math.max(0, ...post.map((x) => x.beta)) * 180) / Math.PI,
    timeTo10degS: t10 === undefined ? Infinity : t10 - T0,
    spun,
  };
}

export interface HandlingCard {
  label: string;
  vMs: number;
  ramp: RampResult;
  slowRamp: RampResult;
  step: StepResult;
  sines: SineResult[];
  liftOff: MidCornerResult;
  brakeInTurn: MidCornerResult;
  powerOn: MidCornerResult;
}

/**
 * The whole scorecard for one car: tests at `vMs` (a typical mid-speed corner for the class), and the slow-corner
 * tests at `slowMs`.
 */
export function handlingCard(label: string, make: MakeCar, vMs: number, slowMs: number): HandlingCard {
  const ramp = steadyRamp(make, vMs);
  const slowRamp = steadyRamp(make, slowMs);
  const s50 = steerFor(ramp, 0.5);
  const s30 = steerFor(ramp, 0.3);
  const s70 = steerFor(ramp, 0.7);
  const slow70 = steerFor(slowRamp, 0.7);
  return {
    label,
    vMs,
    ramp,
    slowRamp,
    step: stepSteer(make, vMs, s50),
    sines: [0.5, 1, 2].map((hz) => sineSteer(make, vMs, s30, hz)),
    liftOff: midCorner(make, vMs, s70, { throttle: 0, brake: 0 }),
    brakeInTurn: midCorner(make, vMs, steerFor(ramp, 0.5), { throttle: 0, brake: 0.4 }),
    powerOn: midCorner(make, slowMs, slow70, { throttle: 1, brake: 0 }),
  };
}
