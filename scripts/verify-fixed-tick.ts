/**
 * The rigid-body cars' controllers (steering assist, traction control, ABS, the autopilot) run on their own 500 Hz
 * clock, so the same drive lands in the same state whatever frames it is stepped in: a 30 Hz phone, a 60 Hz and a
 * 144 Hz display, frames of uneven length.
 *
 *   npx tsx scripts/verify-fixed-tick.ts
 *
 * Also: a paddle pressed in a frame too short to run a tick still shifts once, and a steering wheel's rim reaches the
 * rack at the speed it is turned while a mouse or a stick stays limited to the speed of a driver's hands.
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createVf26Sim } from '../src/lib/sim/f12026-car/Vf26Sim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createMtr496rSim } from '../src/lib/sim/proto/Mtr496rSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';
import { createFlatTestTrack } from './lib/flat-track';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};

const track = getActiveTrackData();
const CARS: [string, () => F12026CarSim][] = [
  ['f12026-car', () => new F12026CarSim(track, null)],
  ['VF26 (rigid-body)', () => createVf26Sim(track, null)],
  ['AMG GT3', () => createAmgGt3Sim(track, null)],
  ['MTR 496R', () => createMtr496rSim(track, null)],
  ['Liana', () => createSuzukiLianaSim(track, null)],
];

/** A small seeded generator (mulberry32), for frames of uneven length */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUN_S = 20;
/** The car's state after `RUN_S` of simulated time on the autopilot, stepped in frames of `frameS()` */
function drive(make: () => F12026CarSim, frameS: () => number): number[] {
  const sim = make();
  sim.resetToStartGrid(true);
  sim.aiAutopilot = true;
  // Frames of the given length until the last one would pass the mark, then short ones that land on it exactly
  while (sim.simTimeS < RUN_S - 0.1) sim.step(frameS(), {});
  while (sim.simTimeS < RUN_S - 1e-9) sim.step(0.0005, {});
  const p = sim.worldPosition;
  const q = sim.worldQuaternion;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, sim.vxMs, sim.vyMs, sim.yawRateRadS, sim.telemetry.rpm, ...sim.wheels.map((w) => w.spinVel)];
}

console.log('== The same drive, stepped in different frames');
for (const [name, make] of CARS) {
  const base = drive(make, () => 0.002);
  const random = seeded(7);
  const runs: [string, () => number][] = [
    ['30 Hz', () => 1 / 30],
    ['60 Hz', () => 1 / 60],
    ['144 Hz', () => 1 / 144],
    ['uneven frames, 3–45 ms', () => 0.003 + 0.042 * random()],
  ];
  for (const [label, frameS] of runs) {
    const got = drive(make, frameS);
    let worst = 0;
    for (let i = 0; i < base.length; i++) worst = Math.max(worst, Math.abs(got[i] - base[i]));
    check(`${name}: ${label} ends in the same state as 2 ms frames`, worst === 0, worst === 0 ? `${(base[7] * 3.6).toFixed(0)} km/h after ${RUN_S} s` : `largest difference ${worst.toExponential(2)}`);
  }
}

console.log('\n== Buttons and steering between frames');
{
  const pad = createFlatTestTrack(20_000, 3000);
  // A paddle pressed in a frame that runs no tick (0.5 ms) still shifts, once
  const sim = new F12026CarSim(pad, null);
  sim.autoGearbox = false;
  sim.teleportToDistance(2000, 40);
  for (let t = 0; t < 1; t += 0.002) sim.step(0.002, { throttle: 0.3 });
  const gear = sim.telemetry.gear;
  sim.step(0.0005, { throttle: 0.3, shiftUp: true });
  for (let t = 0; t < 0.5; t += 0.0005) sim.step(0.0005, { throttle: 0.3 });
  check('a paddle pressed in a frame too short for a tick shifts one gear', sim.telemetry.gear === gear + 1, `gear ${gear} → ${sim.telemetry.gear}`);

  // Steering: half lock asked for in one frame. A wheel's rim is there within the frame; a mouse takes hands' time
  const steerAfter = (rim: boolean): number => {
    const car = new F12026CarSim(pad, null);
    car.teleportToDistance(2000, 15);
    for (let t = 0; t < 0.5; t += 1 / 60) car.step(1 / 60, { analogSteer: 0, steerRim: rim });
    car.step(1 / 60, { analogSteer: 0.5, steerRim: rim });
    return car.steerAngleNorm;
  };
  const rim = steerAfter(true);
  const mouse = steerAfter(false);
  check("a steering wheel's rim reaches the rack within the frame", Math.abs(rim - 0.5) < 1e-9, `${rim.toFixed(3)} of lock`);
  check('a mouse or a stick turns the rack at the speed of hands', mouse > 0.01 && mouse < 0.2, `${mouse.toFixed(3)} of lock after one frame`);
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll fixed-tick checks passed.');
