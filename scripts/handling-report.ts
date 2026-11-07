/**
 * Transient handling scorecard (step steer, sine steer, lift-off, brake-in-turn, power-on exit, slow-corner grip) for
 * the VF26, the f12026-car and the GT3. See `lib/handling-tests.ts`.
 *
 *   npx tsx scripts/handling-report.ts [--json]
 */
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createFlatTestTrack } from './lib/flat-track';
import { handlingCard, type HandlingCard } from './lib/handling-tests';

const pad = createFlatTestTrack(40_000, 3000);
const cards: HandlingCard[] = [
  handlingCard('VF26', () => new F1Physics2026(pad), 150 / 3.6, 70 / 3.6),
  handlingCard('f12026-car', () => new F12026CarSim(pad), 150 / 3.6, 70 / 3.6),
  handlingCard('GT3', () => createAmgGt3Sim(pad), 110 / 3.6, 60 / 3.6),
];

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(cards.map(({ ramp, slowRamp, ...c }) => ({ ...c, ramp: { ...ramp, curve: undefined }, slowRamp: { ...slowRamp, curve: undefined } })), null, 2));
} else {
  const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
  const rows: [string, (c: HandlingCard) => string][] = [
    ['test speed (km/h)', (c) => f(c.vMs * 3.6, 0)],
    ['peak lateral g', (c) => f(c.ramp.maxG)],
    ['  steer at peak (of full lock)', (c) => f(c.ramp.steerAtMax)],
    ['  g added by last 25 % of that lock', (c) => `${f(c.ramp.lateGainShare * 100, 0)} %`],
    ['understeer gradient (deg/g)', (c) => f(c.ramp.understeerDegPerG)],
    ['slow corner peak g', (c) => f(c.slowRamp.maxG)],
    ['  steer at peak', (c) => f(c.slowRamp.steerAtMax)],
    ['  g added by last 25 % of lock', (c) => `${f(c.slowRamp.lateGainShare * 100, 0)} %`],
    ['step: yaw response time (s)', (c) => f(c.step.responseTimeS, 3)],
    ['step: yaw peak time (s)', (c) => f(c.step.peakTimeS, 3)],
    ['step: yaw overshoot', (c) => `${f(c.step.overshootPct, 0)} %${c.step.spun ? ' SPUN' : ''}`],
    ...[0, 1, 2].map((i): [string, (c: HandlingCard) => string] => [
      `sine ${[0.5, 1, 2][i]} Hz: yaw gain / lag / a_y lag`,
      (c) => `${f(c.sines[i].gain)} / ${f(c.sines[i].lagDeg, 0)}° / ${f(c.sines[i].ayLagDeg, 0)}°`,
    ]),
    ['lift-off: curv. ratio / peak slip / t→10°', (c) => `${f(c.liftOff.curvatureRatio)} / ${f(c.liftOff.peakSlipDeg, 1)}° / ${f(c.liftOff.timeTo10degS, 2)} s${c.liftOff.spun ? ' SPUN' : ''}`],
    ['brake in turn: curv. ratio / peak slip / t→10°', (c) => `${f(c.brakeInTurn.curvatureRatio)} / ${f(c.brakeInTurn.peakSlipDeg, 1)}° / ${f(c.brakeInTurn.timeTo10degS, 2)} s${c.brakeInTurn.spun ? ' SPUN' : ''}`],
    ['power-on exit: curv. ratio / peak slip / t→10°', (c) => `${f(c.powerOn.curvatureRatio)} / ${f(c.powerOn.peakSlipDeg, 1)}° / ${f(c.powerOn.timeTo10degS, 2)} s${c.powerOn.spun ? ' SPUN' : ''}`],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length)) + 2;
  console.log(''.padEnd(w0) + cards.map((c) => c.label.padStart(24)).join(''));
  for (const [name, get] of rows) console.log(name.padEnd(w0) + cards.map((c) => get(c).padStart(24)).join(''));
}
