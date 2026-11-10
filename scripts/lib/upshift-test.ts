/**
 * One up-shift on a light pedal, on a flat pad with no traction control: what the change does to the driven wheels and
 * to the car, apart from the throttle.
 */
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { createFlatTestTrack } from './flat-track';

export interface UpshiftResult {
  /** The gear left and the gear taken */
  from: number;
  to: number;
  /** Largest slip ratio of any wheel just before the change, and its worst in the half second after */
  slipBefore: number;
  slipPeak: number;
  /** Mean longitudinal g before the change, and its extremes in the half second after */
  gBefore: number;
  gMin: number;
  gPeak: number;
}

const H = 1 / 240;
const slip = (sim: SimulatorCar) => Math.max(...sim.telemetry.wheelSlipRatios.map(Math.abs));

export function measureUpshift(make: (track: ReturnType<typeof createFlatTestTrack>) => SimulatorCar, kmh: number, pedal = 0.3): UpshiftResult {
  const sim = make(createFlatTestTrack(60_000, 3000));
  sim.assistPreset = 'pro';
  sim.autoGearbox = false;
  sim.teleportToDistance(2000, kmh / 3.6);
  for (let t = 0; t < 1.2; t += H) sim.step(H, { throttle: pedal });
  const from = sim.telemetry.gear;
  const slipBefore = slip(sim);
  let gBefore = 0;
  let n = 0;
  for (let t = 0; t < 0.2; t += H, n++) {
    sim.step(H, { throttle: pedal });
    gBefore += sim.telemetry.longitudinalG;
  }
  gBefore /= n;
  let slipPeak = 0;
  let gPeak = -9;
  let gMin = 9;
  for (let t = 0, first = true; t < 0.5; t += H, first = false) {
    sim.step(H, { throttle: pedal, shiftUp: first });
    slipPeak = Math.max(slipPeak, slip(sim));
    gPeak = Math.max(gPeak, sim.telemetry.longitudinalG);
    gMin = Math.min(gMin, sim.telemetry.longitudinalG);
  }
  return { from, to: sim.telemetry.gear, slipBefore, slipPeak, gBefore, gMin, gPeak };
}

export interface DownshiftResult {
  from: number;
  to: number;
  /** Mean longitudinal g on the brakes before the change, and its extremes in the second after */
  gBefore: number;
  gMin: number;
  gMax: number;
  /** The most any wheel slipped (as a share of the road speed) in the second after: a locking axle shows here */
  slipPeak: number;
}

/** Into `gear` at `kmh`, on the brakes at `brake` of the pedal, one down-shift 0.3 s in */
export function measureDownshift(make: (track: ReturnType<typeof createFlatTestTrack>) => SimulatorCar, kmh: number, gear: number, brake: number): DownshiftResult {
  const sim = make(createFlatTestTrack(60_000, 3000));
  sim.assistPreset = 'pro';
  sim.autoGearbox = false;
  sim.teleportToDistance(2000, kmh / 3.6);
  let pressed = -1;
  for (let t = 0; t < 5; t += H) {
    const g = sim.telemetry.gear;
    const up = g < gear && t - pressed > 0.4;
    const down = g > gear && t - pressed > 0.4;
    if (up || down) pressed = t;
    sim.step(H, { throttle: Math.min(1, Math.max(0, 0.3 + 0.5 * (kmh / 3.6 - sim.vxMs))), shiftUp: up, shiftDown: down });
  }
  const from = sim.telemetry.gear;
  let gBefore = 0;
  let n = 0;
  let gMin = 9;
  let gMax = -9;
  let slipPeak = 0;
  for (let t = 0; t < 1.3; t += H) {
    sim.step(H, { throttle: 0, brake, shiftDown: Math.abs(t - 0.3) < H / 2 });
    if (t > 0.2 && t < 0.3) {
      gBefore += sim.telemetry.longitudinalG;
      n++;
    }
    if (t >= 0.3) {
      gMin = Math.min(gMin, sim.telemetry.longitudinalG);
      gMax = Math.max(gMax, sim.telemetry.longitudinalG);
      slipPeak = Math.max(slipPeak, slip(sim));
    }
  }
  return { from, to: sim.telemetry.gear, gBefore: gBefore / n, gMin, gMax, slipPeak };
}

/**
 * Whether the box takes a down-shift that would land the engine `overRpm` past its limiter: the car is put in `gear` at
 * the speed that asks it
 */
export function downshiftTakenAt(make: (track: ReturnType<typeof createFlatTestTrack>) => SimulatorCar, gear: number, ratios: number[], redlineRpm: number, overRpm: number): boolean {
  const sim = make(createFlatTestTrack(60_000, 3000));
  sim.assistPreset = 'pro';
  sim.autoGearbox = false;
  sim.teleportToDistance(2000, 30);
  let pressed = -1;
  for (let t = 0; t < 4; t += H) {
    const up = sim.telemetry.gear < gear && t - pressed > 0.4;
    if (up) pressed = t;
    sim.step(H, { throttle: Math.min(1, Math.max(0, 0.3 + 0.5 * (30 - sim.vxMs))), shiftUp: up });
  }
  const rpmPerMs = sim.telemetry.rpm / sim.vxMs;
  const speed = (redlineRpm + overRpm) / (rpmPerMs * (ratios[gear - 2] / ratios[gear - 1]));
  sim.teleportToDistance(2000, speed);
  for (let t = 0; t < 0.05; t += H) sim.step(H, { throttle: 0.2 });
  sim.step(H, { throttle: 0, shiftDown: true });
  for (let t = 0; t < 0.02; t += H) sim.step(H, { throttle: 0 });
  return sim.telemetry.gear === gear - 1;
}

/**
 * Into `gear` at `kmh`, a down-shift off the throttle, then full throttle 0.3 s after it: the push a tenth of a second
 * into the throttle (g), and the most the engine ran ahead of the wheels afterwards (rpm): a clutch still slipping
 * under power shows as a flare
 */
export function downshiftThenThrottle(make: (track: ReturnType<typeof createFlatTestTrack>) => SimulatorCar, kmh: number, gear: number): { pushG: number; flareRpm: number } {
  const sim = make(createFlatTestTrack(60_000, 3000));
  sim.assistPreset = 'pro';
  sim.autoGearbox = false;
  sim.teleportToDistance(2000, kmh / 3.6);
  let pressed = -1;
  for (let t = 0; t < 5; t += H) {
    const g = sim.telemetry.gear;
    const up = g < gear && t - pressed > 0.6;
    const down = g > gear && t - pressed > 0.6;
    if (up || down) pressed = t;
    sim.step(H, { throttle: Math.min(1, Math.max(0, 0.3 + 0.5 * (kmh / 3.6 - sim.vxMs))), shiftUp: up, shiftDown: down });
  }
  const trace: [number, number][] = [];
  let pushG = 0;
  for (let t = 0; t < 2.5; t += H) {
    sim.step(H, { throttle: t < 0.5 ? 0 : 1, shiftDown: Math.abs(t - 0.2) < H / 2 });
    if (Math.abs(t - 0.6) < H / 2) pushG = sim.telemetry.longitudinalG;
    if (t > 0.5) trace.push([sim.telemetry.rpm, sim.vxMs]);
  }
  // The clutch is home by the end: the engine speed per road speed there is the gear's
  const [rpmEnd, vEnd] = trace[trace.length - 1];
  const flareRpm = Math.max(...trace.map(([rpm, v]) => rpm - (rpmEnd / vEnd) * v));
  return { pushG, flareRpm };
}
