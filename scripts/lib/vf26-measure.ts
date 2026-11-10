/**
 * Measures a VF26 on flat ground, the same way whichever engine it runs on: both are driven through `SimulatorCar`
 * with the same pedal and steering traces, soft tyres, no driver aids, sea-level air. Shared by
 * `compare-vf26-engines.ts` (prints the table) and `verify-vf26-fold.ts` (asserts it).
 */
import * as THREE from 'three';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { VF26_AI_REFERENCE } from '../../src/lib/sim/vf26-data';
import { createVf26Sim } from '../../src/lib/sim/f12026-car/Vf26Sim';
import { createFlatTestTrack } from './flat-track';

export interface Vf26Measurement {
  /** Seconds from rest to 100 / 200 / 300 km/h */
  accelS: Record<number, number>;
  topSpeedKmh: number;
  /** A stop from 300 to 100 km/h on a pedal held just short of locking: distance (m) and peak g */
  brakeM: number;
  brakePeakG: number;
  /** Best 1 s lateral g at the reference's five speeds */
  lateralG: number[];
  /** Steering (share of lock) held for 1.5 g at 180 km/h */
  steerFor15G: number;
  /** Yaw-rate overshoot of a step of steering at 180 km/h (peak over settled − 1) */
  stepOvershoot: number;
  /** Peak body slip angle after lifting off the throttle in a 2.5 g corner at 200 km/h (deg) */
  liftOffSlipDeg: number;
}

const pad = createFlatTestTrack(60_000, 3000);
const H = 1 / 240;

/** The engines a VF26 can run on: the one it ships on, and (once it exists) the rigid-body one */
export const VF26_ENGINES: { name: string; make: () => SimulatorCar }[] = [
  { name: 'F1Physics2026', make: () => new F1Physics2026(pad) },
  { name: 'VehiclePhysics', make: () => createVf26Sim(pad) },
];

function fresh(make: () => SimulatorCar, speedMs: number): SimulatorCar {
  const sim = make();
  sim.assistPreset = 'pro';
  sim.autoGearbox = true;
  sim.teleportToDistance(2000, speedMs);
  return sim;
}
const bodySlip = (sim: SimulatorCar) => Math.atan2(sim.vyMs, Math.max(1, Math.abs(sim.vxMs)));

export function measureVf26(make: () => SimulatorCar): Vf26Measurement {
  // Straight line: from rest on a throttle eased whenever a rear wheel passes 9 % slip (a driver's foot: neither
  // engine's traction control), then on to the top speed
  let sim = fresh(make, 0);
  const accelS: Record<number, number> = {};
  let top = 0;
  let foot = 1;
  for (let t = 0; t < 45; t += H) {
    const spin = Math.max(sim.telemetry.wheelSlipRatios[2], sim.telemetry.wheelSlipRatios[3]);
    foot = THREE.MathUtils.clamp(foot + (spin > 0.09 ? -0.05 : 0.025), 0.15, 1);
    sim.step(H, { throttle: foot });
    const kmh = sim.vxMs * 3.6;
    for (const mark of [100, 200, 300]) if (accelS[mark] === undefined && kmh >= mark) accelS[mark] = t;
    top = Math.max(top, kmh);
  }

  // Braking: from 300 km/h, the pedal held where the most-slipping wheel sits at 7 % (a driver's threshold braking:
  // the pedal follows the slip smoothly, it does not jump off and on)
  sim = fresh(make, 300 / 3.6);
  for (let t = 0; t < 0.5; t += H) sim.step(H, { throttle: 0.6 });
  const s0 = sim.sMeters;
  let pedal = 1;
  let peak = 0;
  for (let t = 0; t < 8 && sim.vxMs * 3.6 > 100; t += H) {
    const slip = Math.max(...sim.telemetry.wheelSlipRatios.map((r) => Math.abs(r)));
    pedal = THREE.MathUtils.clamp(pedal + THREE.MathUtils.clamp((0.07 - slip) * 0.6, -0.02, 0.01), 0.2, 1);
    sim.step(H, { brake: pedal });
    peak = Math.max(peak, -sim.telemetry.longitudinalG);
  }
  const brakeM = sim.sMeters - s0;

  // Sustained lateral g: a slow steering ramp at a held speed, best one-second mean
  const lateralG = VF26_AI_REFERENCE.lateral.map(([v]) => {
    const car = fresh(make, v);
    const hist: number[] = [];
    let best = 0;
    const T = 12;
    for (let t = 0; t < T; t += 1 / 120) {
      const throttle = THREE.MathUtils.clamp(0.25 + 0.6 * (v - car.vxMs), 0, 1);
      car.step(1 / 120, { throttle, analogSteer: Math.min(1, t / T) * Math.min(1, (24 / v) ** 1.5) });
      hist.push(Math.abs(car.telemetry.lateralG));
      if (hist.length > 120) hist.shift();
      if (hist.length === 120) best = Math.max(best, hist.reduce((a, b) => a + b, 0) / 120);
      if (Math.abs(bodySlip(car)) > 0.35) break;
    }
    return best;
  });

  // The steering 1.5 g takes at 180 km/h: the ramp's steering when the lateral g first holds 1.5
  const v180 = 50;
  let steerFor15G = NaN;
  {
    const car = fresh(make, v180);
    for (let t = 0; t < 10 && Number.isNaN(steerFor15G); t += H) {
      const steer = 0.03 * t;
      car.step(H, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (v180 - car.vxMs), 0, 1), analogSteer: steer });
      if (Math.abs(car.telemetry.lateralG) >= 1.5) steerFor15G = steer;
    }
  }

  // A step of that steering: the yaw rate's peak over where it settles
  let stepOvershoot = NaN;
  if (!Number.isNaN(steerFor15G)) {
    const car = fresh(make, v180);
    for (let t = 0; t < 1; t += H) car.step(H, { throttle: 0.3 });
    let peakYaw = 0;
    let settled = 0;
    let n = 0;
    // The yaw rate as a driver feels it: its mean over a fifth of a second (the body's own roll shimmer on its tyres,
    // 10 Hz and up, is left out)
    const window: number[] = [];
    for (let t = 0; t < 3; t += H) {
      car.step(H, { throttle: 0.3, analogSteer: steerFor15G });
      window.push(Math.abs(car.yawRateRadS));
      if (window.length > 48) window.shift();
      const yaw = window.reduce((a, b) => a + b, 0) / window.length;
      if (window.length === 48) peakYaw = Math.max(peakYaw, yaw);
      if (t > 2) {
        settled += yaw;
        n++;
      }
    }
    stepOvershoot = peakYaw / (settled / n) - 1;
  }

  // Lift-off: a 2.5 g corner at 200 km/h on a held throttle, then the throttle shut
  let liftOffSlipDeg = NaN;
  {
    const v = 200 / 3.6;
    const car = fresh(make, v);
    let steer = 0;
    for (let t = 0; t < 8; t += H) {
      if (Math.abs(car.telemetry.lateralG) < 2.5) steer += 0.02 * H;
      car.step(H, { throttle: THREE.MathUtils.clamp(0.25 + 0.6 * (v - car.vxMs), 0, 1), analogSteer: steer });
    }
    let peakSlip = 0;
    for (let t = 0; t < 2; t += H) {
      car.step(H, { throttle: 0, analogSteer: steer });
      peakSlip = Math.max(peakSlip, Math.abs(bodySlip(car)));
    }
    liftOffSlipDeg = (peakSlip * 180) / Math.PI;
  }

  return { accelS, topSpeedKmh: top, brakeM, brakePeakG: peak, lateralG, steerFor15G, stepOvershoot, liftOffSlipDeg };
}
