/**
 * Tyre temperature and tread-condition checks for the rigid-body cars (`VehiclePhysics`), over autopilot stints of the
 * Rwanda circuit: what a driver sees on the tyre widget after a few laps.
 *
 *   npx tsx scripts/verify-tyre-thermal.ts
 *
 * Graining and blistering follow each compound's own working window (`tyreGrainThresholdsC`): a GT3 slick run at its
 * normal temperatures must not grain, and an F1 slick keeps the thresholds it always had. A brush tyre (the 496R's
 * slicks, the Liana's street tyre) grains and blisters slowly, by the work done outside its grip curve's peak. The inner, middle and outer bands of the tread keep their own temperatures: negative camber
 * loads the inner shoulder, so it runs hottest.
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { tyreGrainThresholdsC } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { compoundData, F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createMtr496rSim } from '../src/lib/sim/proto/Mtr496rSim';
import { createSuzukiLianaSim } from '../src/lib/sim/road/SuzukiLianaSim';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);
const quad = (v: readonly number[], d = 2) => v.map((x) => fmt(x, d)).join(' / ');

console.log('== Thresholds from the working window');
{
  const f1 = tyreGrainThresholdsC(compoundData(F12026_CAR_CONFIG, F12026_CAR_CONFIG.compoundSlots.soft).thermalData.optimalTempC);
  check('F1 soft (95–115 °C): grains below 78, cleans up to 120, blisters above 128', f1.grainBelow === 78 && f1.healTo === 120 && f1.blisterAbove === 128,
    `${f1.grainBelow} / ${f1.healTo} / ${f1.blisterAbove} °C`);
  const gt3 = tyreGrainThresholdsC(compoundData(AMG_GT3_CONFIG, AMG_GT3_CONFIG.compoundSlots.soft).thermalData.optimalTempC);
  check('GT3 soft (70–85 °C): grains below 53, cleans up to 90, blisters above 98', gt3.grainBelow === 53 && gt3.healTo === 90 && gt3.blisterAbove === 98,
    `${gt3.grainBelow} / ${gt3.healTo} / ${gt3.blisterAbove} °C`);
}

interface StintResult {
  /** Graining per wheel at the end of each lap */
  grainByLap: number[][];
  /** Worst blistering over the stint */
  blister: number;
  coreC: number[];
  /** Mean tread surface temperature of each wheel's inner / middle / outer band over the last lap (°C) */
  bandsC: number[][];
}

/** An autopilot stint of `laps` flying laps from the grid on blanket / garage temperatures */
function stint(sim: F12026CarSim, laps: number): StintResult {
  sim.resetToStartGrid(true);
  sim.aiAutopilot = true;
  sim.aiPaceScale = 1;
  const lap0 = sim.telemetry.lapCount;
  let last = lap0;
  let t = 0;
  let blister = 0;
  const grainByLap: number[][] = [];
  let bandSum = [0, 1, 2, 3].map(() => [0, 0, 0]);
  let bandsC = bandSum;
  let samples = 0;
  while (t < 240 * (laps + 1) && sim.telemetry.lapCount < lap0 + laps + 1) {
    sim.step(1 / 60, {});
    t += 1 / 60;
    sim.vehicle.wheels.forEach((w, i) => {
      blister = Math.max(blister, w.blisterLevel);
      for (let b = 0; b < 3; b++) bandSum[i][b] += w.bandTempsC[b];
    });
    samples++;
    if (sim.telemetry.lapCount !== last) {
      last = sim.telemetry.lapCount;
      grainByLap.push(sim.vehicle.wheels.map((w) => w.grainLevel));
      bandsC = bandSum.map((wheel) => wheel.map((sum) => sum / samples));
      bandSum = [0, 1, 2, 3].map(() => [0, 0, 0]);
      samples = 0;
    }
  }
  return { grainByLap, blister, coreC: sim.vehicle.wheels.map((w) => w.coreTempC), bandsC };
}

console.log('\n== Stints round Rwanda (autopilot)');
{
  const track = getActiveTrackData();
  const gt3 = stint(createAmgGt3Sim(track), 5);
  check('GT3: no graining or blistering over 5 laps', Math.max(...gt3.grainByLap.flat()) < 0.1 && gt3.blister === 0,
    `grain ${quad(gt3.grainByLap[gt3.grainByLap.length - 1])}, core ${quad(gt3.coreC, 0)} °C`);
  // −3.5° of front camber: the inner band carries the most load and runs hottest, the outer coolest
  const spread = (wheel: number[]) => wheel[0] - wheel[2];
  check('GT3: front tyres run 5–15 °C hotter inside than outside', [0, 1].every((i) => spread(gt3.bandsC[i]) > 5 && spread(gt3.bandsC[i]) < 15 && gt3.bandsC[i][0] > gt3.bandsC[i][1] && gt3.bandsC[i][1] > gt3.bandsC[i][2]),
    `inner / middle / outer ${quad(gt3.bandsC[0], 0)} and ${quad(gt3.bandsC[1], 0)} °C`);
  const proto = stint(createMtr496rSim(track), 5);
  check('496R: no graining or blistering over 5 laps', Math.max(...proto.grainByLap.flat()) < 0.1 && proto.blister === 0,
    `grain ${quad(proto.grainByLap[proto.grainByLap.length - 1])}, core ${quad(proto.coreC, 0)} °C`);
  const f1 = stint(new F12026CarSim(track), 4);
  check('F1: no graining or blistering over 4 laps', Math.max(...f1.grainByLap.flat()) < 0.1 && f1.blister === 0,
    `grain ${quad(f1.grainByLap[f1.grainByLap.length - 1])}, core ${quad(f1.coreC, 0)} °C`);
  // A road tyre leaves the garage at 25 °C and runs well under its 75 °C peak: on its slow tread model that grains the
  // worked fronts a little each lap (a softer tyre, not a slower one), never to the full within a stint
  const liana = stint(createSuzukiLianaSim(track), 5);
  const end = liana.grainByLap[liana.grainByLap.length - 1];
  check('Liana: cold fronts grain slowly, under a tenth in 5 laps', end[0] > 0.001 && Math.max(...end) < 0.1 && liana.blister === 0,
    `lap 1 ${quad(liana.grainByLap[0], 3)}, lap 5 ${quad(end, 3)}, core ${quad(liana.coreC, 0)} °C`);
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll tyre thermal checks passed.');
if (failures.length) process.exitCode = 1;
