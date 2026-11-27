/**
 * The autopilot's steering speed on a drive plan (`CarSimProfile.aiPlanRimSpeedDegS`, F12026CarSim `autopilotSteer`).
 * At the player's 900°/s at the rim, the road, classic and prototype cars' plan tracking ran out of steering speed on a
 * quick correction and swung wider each time until the car spun, so career races on their plans spun and left the road
 * many times more than on their own driver. Those cars now track a plan at 3600°/s; the F1 cars and the GT3, whose plans
 * passed at 900, keep it, and the player's own steering is untouched.
 *
 * 1. Each road, classic and prototype car sets 3600; the LC26, LC25 and AMG GT3 set nothing (900).
 * 2. On a plan, one step of the autopilot's steering moves the rack exactly the car's rate (3600 or 900°/s at the rim).
 * 3. Off a plan (its own driver), the autopilot's steering is not rate-limited here, as before.
 * 4. A hand-back after a knock (full lock one way to full lock the other) still takes several steps at 3600, not one.
 * 5. The player's car, the same Liana with 3600 set, driven by a stick or keys: its rack still turns no faster than
 *    900°/s at the rim.
 *
 * Usage: npx tsx scripts/verify/verify-ai-plan-steer-rate.ts
 */
import type { F12026CarSim } from '../../src/lib/sim/f12026-car/F12026CarSim';
import { createLc26Sim } from '../../src/lib/sim/f12026-car/Lc26Sim';
import { createLc25Sim } from '../../src/lib/sim/f12025-car/Lc25Sim';
import { createAmgGt3Sim } from '../../src/lib/sim/gt3/AmgGt3Sim';
import { createSuzukiLianaSim } from '../../src/lib/sim/road/SuzukiLianaSim';
import { createVwSciroccoSim } from '../../src/lib/sim/road/VwSciroccoSim';
import { createNissanR32Sim } from '../../src/lib/sim/classic/NissanR32Sim';
import { createNissanR33Sim } from '../../src/lib/sim/classic/NissanR33Sim';
import { createBmwM1ProcarSim } from '../../src/lib/sim/classic/BmwM1ProcarSim';
import { createPorsche934RsrSim } from '../../src/lib/sim/classic/Porsche934RsrSim';
import { createChaparral2dSim, createChaparral2d67Sim } from '../../src/lib/sim/classic/Chaparral2dSim';
import { createMtr496rSim } from '../../src/lib/sim/proto/Mtr496rSim';
import { createLcLmdhSim } from '../../src/lib/sim/proto/LcLmdhSim';
import { createFlatTestTrack } from '../lib/flat-track';

const DT = 1 / 120;
const pad = createFlatTestTrack(30_000, 3000);

let failed = 0;
const check = (ok: boolean, line: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
};

/** The sim's private steering state and the two steering paths, for the rate checks */
interface SteerInternals {
  aiPlan: unknown;
  steerCmd: number;
  rimLockDeg: number;
  autopilotSteer(want: number, h: number): number;
}
const internals = (c: F12026CarSim) => c as unknown as SteerInternals;

const FAST: [string, (t: typeof pad) => F12026CarSim][] = [
  ['Liana', createSuzukiLianaSim],
  ['Scirocco', createVwSciroccoSim],
  ['R32', createNissanR32Sim],
  ['R33', createNissanR33Sim],
  ['M1 Procar', createBmwM1ProcarSim],
  ['934 RSR', createPorsche934RsrSim],
  ['Chaparral 2D', createChaparral2dSim],
  ['Chaparral 2D 67', createChaparral2d67Sim],
  ['MTR 496R', createMtr496rSim],
  ['LC-LMDH', (t) => createLcLmdhSim(t)],
];
const KEEP: [string, (t: typeof pad) => F12026CarSim][] = [
  ['LC26', (t) => createLc26Sim(t)],
  ['LC25', (t) => createLc25Sim(t)],
  ['AMG GT3', (t) => createAmgGt3Sim(t)],
];

// 1. Which cars set it
for (const [name, make] of FAST) {
  const v = make(pad).profile.aiPlanRimSpeedDegS;
  check(v === 3600, `${name} tracks a plan at 3600°/s (${v ?? 'unset'})`);
}
for (const [name, make] of KEEP) {
  const v = make(pad).profile.aiPlanRimSpeedDegS;
  check(v === undefined, `${name} keeps the player's 900°/s on a plan (${v ?? 'unset'})`);
}

// 2-4. The autopilot's steering on and off a plan
const onePlanStep = (c: F12026CarSim, from: number, want: number) => {
  const s = internals(c);
  s.aiPlan = {};
  s.steerCmd = from;
  return s.autopilotSteer(want, DT) - from;
};
for (const [name, make, rate] of [
  ['Liana', createSuzukiLianaSim, 3600],
  ['LC-LMDH', (t: typeof pad) => createLcLmdhSim(t), 3600],
  ['AMG GT3', (t: typeof pad) => createAmgGt3Sim(t), 900],
  ['LC26', (t: typeof pad) => createLc26Sim(t), 900],
] as const) {
  const c = make(pad);
  const want = (rate / internals(c).rimLockDeg) * DT;
  const got = onePlanStep(c, 0, 1);
  check(Math.abs(got - want) < 1e-9, `${name} on a plan: one step turns the rack ${(got * internals(c).rimLockDeg / DT).toFixed(0)}°/s at the rim (${rate})`);
}
{
  const c = createSuzukiLianaSim(pad);
  const s = internals(c);
  s.aiPlan = null;
  s.steerCmd = 0;
  check(s.autopilotSteer(0.8, DT) === 0.8, 'Liana on its own driver: the autopilot steering is passed straight through, as before');
}
{
  const c = createSuzukiLianaSim(pad);
  const s = internals(c);
  s.aiPlan = {};
  s.steerCmd = -1;
  let steps = 0;
  while (s.steerCmd < 1 && steps < 1000) {
    s.steerCmd = s.autopilotSteer(1, DT);
    steps++;
  }
  const secs = steps * DT;
  check(steps > 5 && secs < 0.5, `Liana hand-back from full lock to full lock on a plan takes ${steps} steps (${secs.toFixed(2)} s), not one`);
}

// 5. The player's own steering on the Liana with 3600 set: a mouse (straight to the rack) and a stick, each flicked
//    full left to full right
for (const [device, input] of [
  ['mouse', (v: number) => ({ analogSteer: v })],
  ['stick', (v: number) => ({ padSteer: v })],
] as const) {
  const c = createSuzukiLianaSim(pad);
  c.assistPreset = 'pro';
  c.teleportToDistance(1000, 30);
  const s = internals(c);
  // The rack moves in the sim's own sub-steps, so a frame can carry one more than its share: the rate is read over
  // quarter-second windows, which one extra sub-step moves by under 5 %
  const trace: number[] = [s.steerCmd];
  for (let i = 0; i < 240; i++) {
    c.step(DT, { throttle: 0.2, ...input(i < 120 ? 1 : -1) });
    trace.push(s.steerCmd);
  }
  const W = 30;
  let worst = 0;
  for (let i = W; i < trace.length; i++) worst = Math.max(worst, Math.abs(trace[i] - trace[i - W]));
  const degS = (worst * s.rimLockDeg) / (W * DT);
  check(degS <= 900 * 1.05, `the player's Liana on a ${device}: rack at most ${degS.toFixed(0)}°/s at the rim (cap 900)`);
  check(degS > 300, `the player's Liana on a ${device} steered quickly in that test (${degS.toFixed(0)}°/s)`);
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll AI plan steering rate checks passed.');
