/**
 * Keyboard steering (#64): a player on A / D holds the key through a corner, so the car runs at the keyboard's
 * steering limit (keyboard-steer.ts). The VF26's fixed limit held a GT3's fronts at 2-3× their peak slip angle, so
 * they scrubbed and overheated within a lap; each car's own limit keeps them near the peak.
 *
 * On a flat pad at a steady speed (throttle only), D is held for 3 s, once with the old fixed limit and once with the
 * car's own. With its own limit each car must keep its fronts within 1.5× their peak slip over the last second, not
 * spin (body slip under 8°), corner at least as hard as before (2 % margin) and heat its fronts no more.
 *
 * Usage: npx tsx scripts/verify-keyboard-steer.ts
 */
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { keyboardSteerLimit, stepKeyboardSteer, type KeyboardSteerCar } from '../src/lib/input/keyboard-steer';
import { createFlatTestTrack } from './lib/flat-track';

const DT = 1 / 120;
const RAD2DEG = 180 / Math.PI;
const pad = createFlatTestTrack(20_000, 3000);

// The sims' internals (compound data, rigid-body wheels) are read directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Car = any;

interface Held {
  /** Fronts' slip angle over their peak, mean of the last second */
  slipOverPeak: number;
  latG: number;
  /** Hotter front's rise over the 3 s (°C) */
  tempRiseC: number;
  maxBetaDeg: number;
}

function holdKey(make: () => Car, kmh: number, ownLimit: boolean): Held {
  const c = make();
  c.setAssistPreset?.('semi_pro');
  c.teleportToDistance(500, kmh / 3.6);
  const limitCar: KeyboardSteerCar = ownLimit ? c : { wheelbaseM: c.wheelbaseM, maxSteerAngleRad: c.maxSteerAngleRad };
  const peakRad = ((c.compoundData.modelData.friction_limit_angle as number) || 7) / RAD2DEG;
  // Settle driving straight
  for (let t = 0; t < 2; t += DT) c.step(DT, { throttle: 0.3, analogSteer: 0 });
  const hotterFront = () => Math.max(c.telemetry.tireTempsC[0], c.telemetry.tireTempsC[1]);
  const t0 = hotterFront();
  const vT = kmh / 3.6;
  let steer = 0, thr = 0.3, slip = 0, ay = 0, n = 0, maxBeta = 0;
  for (let t = 0; t < 3; t += DT) {
    steer = stepKeyboardSteer(steer, 1, keyboardSteerLimit(limitCar, Math.max(1, c.vxMs)), DT);
    // The player holds the speed on the throttle
    thr = Math.max(0, Math.min(1, thr + (vT - c.vxMs) * 0.5 * DT));
    c.step(DT, { throttle: thr, analogSteer: steer });
    maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(c.vyMs, Math.max(1, c.vxMs))) * RAD2DEG);
    if (t > 2) {
      slip += Math.max(Math.abs(Math.atan(c.vehicle.wheels[0].tanSlipAngle)), Math.abs(Math.atan(c.vehicle.wheels[1].tanSlipAngle)));
      ay += Math.abs(c.vxMs * c.yawRateRadS);
      n++;
    }
  }
  return { slipOverPeak: slip / n / peakRad, latG: ay / n / 9.81, tempRiseC: hotterFront() - t0, maxBetaDeg: maxBeta };
}

const cars: [string, () => Car][] = [
  ['AMG GT3', () => createAmgGt3Sim(pad)],
  ['FA-26 Rigid-Body', () => new F12026CarSim(pad)],
];
let failed = 0;
for (const [name, make] of cars) {
  for (const kmh of [70, 90, 110, 150, 190]) {
    const o = holdKey(make, kmh, false);
    const nw = holdKey(make, kmh, true);
    const ok = nw.slipOverPeak <= 1.5 && nw.maxBetaDeg < 8 && nw.latG >= 0.98 * o.latG && nw.tempRiseC <= o.tempRiseC;
    if (!ok) failed++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(17)} D held at ${String(kmh).padStart(3)} km/h, old → own limit: fronts at ` +
        `${o.slipOverPeak.toFixed(2)}× → ${nw.slipOverPeak.toFixed(2)}× their peak slip, ${o.latG.toFixed(2)} → ${nw.latG.toFixed(2)} g, ` +
        `front +${o.tempRiseC.toFixed(0)} → +${nw.tempRiseC.toFixed(0)} °C in 3 s, body slip ${o.maxBetaDeg.toFixed(0)}° → ${nw.maxBetaDeg.toFixed(0)}°`
    );
  }
}
console.log(failed ? `${failed} case(s) failed.` : 'A held steering key keeps the fronts at their grip.');
process.exit(failed ? 1 : 0);
