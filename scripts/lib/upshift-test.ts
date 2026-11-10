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
