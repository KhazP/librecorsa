/**
 * The VF26 on the rigid-body engine (`createVf26Sim`, `Vf26Config`) against the engine it ships on (`F1Physics2026`):
 * the same car data must give the same car. Flat-ground measures from `scripts/lib/vf26-measure.ts`, then autopilot
 * laps of Rwanda on both.
 *
 *   npx tsx scripts/verify-vf26-fold.ts
 *
 * The bands are what two models of one car may differ by (a planar chassis against a rigid body on its suspension):
 * a few per cent on times, speeds and g, and no worse behaved past the limit.
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { createVf26Sim } from '../src/lib/sim/f12026-car/Vf26Sim';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { VF26_AI_REFERENCE } from '../src/lib/sim/vf26-data';
import { measureVf26, VF26_ENGINES } from './lib/vf26-measure';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const pct = (a: number, b: number) => (100 * (a - b)) / b;
const within = (a: number, b: number, tolPct: number) => Math.abs(pct(a, b)) <= tolPct;
const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;

console.log('== Flat ground');
{
  const [old, rigid] = VF26_ENGINES.map(({ make }) => measureVf26(make));
  for (const [kmh, tol] of [[100, 8], [200, 5], [300, 6]] as const)
    check(`0–${kmh} km/h within ${tol} %`, within(rigid.accelS[kmh], old.accelS[kmh], tol), `${rigid.accelS[kmh]?.toFixed(2)} s vs ${old.accelS[kmh]?.toFixed(2)} s (${sign(pct(rigid.accelS[kmh], old.accelS[kmh]))})`);
  check('Top speed within 2 %', within(rigid.topSpeedKmh, old.topSpeedKmh, 2), `${rigid.topSpeedKmh.toFixed(0)} vs ${old.topSpeedKmh.toFixed(0)} km/h`);
  check('300–100 km/h within 8 %', within(rigid.brakeM, old.brakeM, 8), `${rigid.brakeM.toFixed(1)} m vs ${old.brakeM.toFixed(1)} m (${sign(pct(rigid.brakeM, old.brakeM))})`);
  VF26_AI_REFERENCE.lateral.forEach(([v], i) =>
    check(`Lateral g at ${(v * 3.6).toFixed(0)} km/h within 5 %`, within(rigid.lateralG[i], old.lateralG[i], 5), `${rigid.lateralG[i].toFixed(2)} g vs ${old.lateralG[i].toFixed(2)} g (${sign(pct(rigid.lateralG[i], old.lateralG[i]))})`)
  );
  check('Steering for 1.5 g at 180 km/h within 12 %', within(rigid.steerFor15G, old.steerFor15G, 12), `${rigid.steerFor15G.toFixed(3)} vs ${old.steerFor15G.toFixed(3)} of lock`);
  check('A step of steering overshoots by under 15 %', rigid.stepOvershoot < 0.15, `${(rigid.stepOvershoot * 100).toFixed(0)} % (${(old.stepOvershoot * 100).toFixed(0)} % on the other engine)`);
  check('A lift in a 2.5 g corner: under 5° of slide, within 2° of the other engine', rigid.liftOffSlipDeg < 5 && Math.abs(rigid.liftOffSlipDeg - old.liftOffSlipDeg) < 2,
    `${rigid.liftOffSlipDeg.toFixed(1)}° vs ${old.liftOffSlipDeg.toFixed(1)}°`);
}

console.log('\n== Autopilot laps of Rwanda');
{
  const track = getActiveTrackData();
  const laps = (make: () => SimulatorCar) => {
    const sim = make();
    sim.resetToStartGrid(true);
    sim.aiAutopilot = true;
    sim.aiPaceScale = 1;
    const lap0 = sim.telemetry.lapCount;
    let last = lap0;
    let maxSlipDeg = 0;
    let pastEdgeM = 0;
    let lapS = NaN;
    for (let t = 0; t < 400 && sim.telemetry.lapCount < lap0 + 3; t += 1 / 60) {
      sim.step(1 / 60, {});
      maxSlipDeg = Math.max(maxSlipDeg, (Math.abs(Math.atan2(sim.vyMs, Math.max(5, Math.abs(sim.vxMs)))) * 180) / Math.PI);
      pastEdgeM = Math.max(pastEdgeM, Math.abs(sim.lateralOffsetM) - track.getSampleAtDistance(sim.sMeters).width / 2);
      if (sim.telemetry.lapCount !== last) {
        last = sim.telemetry.lapCount;
        lapS = (sim.telemetry.lastLapTimeMs ?? 0) / 1000;
      }
    }
    return { lapS, maxSlipDeg, pastEdgeM, done: sim.telemetry.lapCount >= lap0 + 3 };
  };
  const old = laps(() => new F1Physics2026(track));
  const rigid = laps(() => createVf26Sim(track));
  check('Flying lap within 1.5 % of the other engine', rigid.done && within(rigid.lapS, old.lapS, 1.5), `${rigid.lapS.toFixed(2)} s vs ${old.lapS.toFixed(2)} s (${sign(pct(rigid.lapS, old.lapS))})`);
  check('... on the road, under 8° of body slip', rigid.pastEdgeM < 0.2 && rigid.maxSlipDeg < 8, `CG ${Math.max(0, rigid.pastEdgeM).toFixed(2)} m past the edge, ${rigid.maxSlipDeg.toFixed(1)}° of slip`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll VF26 fold checks passed.');
if (failures.length) process.exitCode = 1;
