/**
 * Tyre thermal / pressure report: the AI drives a stint and the tyre state is printed every lap.
 *
 *   npx tsx scripts/tyre-stint-report.ts [laps=5] [compound=soft]
 */
import { getRwandaTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { tyreBandSurfaceTempC } from '../src/lib/sim/ac-tyre';
import type { TireCompound } from '../src/types/f1';

const laps = Number(process.argv[2] ?? 5);
const compound = (process.argv[3] ?? 'soft') as TireCompound;

const track = getRwandaTrackData(1200);
const car = new F1Physics2026(track);
car.setAssistPreset('pro');
car.tireCompound = compound;
car.resetToStartGrid(true);
car.aiAutopilot = true;

const NAMES = ['FR', 'FL', 'RR', 'RL'];
const dt = 1 / 120;
const input = { throttle: 0, brake: 0, steerLeft: 0, steerRight: 0, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false };

// Lap-averaged band temperatures and peak / mean pressure
const startLap = car.telemetry.lapCount;
let lap = startLap;
let samples = 0;
const sumBand = car.wheels.map(() => [0, 0, 0]);
const sumP = [0, 0, 0, 0];
const sumGrip = [0, 0, 0, 0];
const wearAtLapStart = car.wheels.map((w) => w.tyre.wear);
let simS = 0;
console.log(`compound=${compound}, ${laps} laps`);
while (car.telemetry.lapCount < startLap + laps + 1 && simS < 150 * (laps + 1)) {
  car.step(dt, input);
  simS += dt;
  car.wheels.forEach((w, i) => {
    for (let b = 0; b < 3; b++) sumBand[i][b] += tyreBandSurfaceTempC(w.tyre, b);
    sumP[i] += w.tyre.pressurePsi;
    sumGrip[i] += w.gripFactor;
  });
  samples++;
  if (car.telemetry.lapCount !== lap) {
    lap = car.telemetry.lapCount;
    const lapS = (car.telemetry.lastLapTimeMs ?? 0) / 1000;
    console.log(`lap ${lap - 1}: ${lapS.toFixed(3)} s`);
    car.wheels.forEach((w, i) => {
      const band = sumBand[i].map((v) => (v / samples).toFixed(0)).join('/');
      console.log(
        `  ${NAMES[i]} surf I/M/O avg ${band}  bulk ${w.tyre.coreTempC.toFixed(0)}  gas ${w.tyre.gasTempC.toFixed(0)}  ` +
          `P ${(sumP[i] / samples).toFixed(1)} psi (now ${w.tyre.pressurePsi.toFixed(1)})  grip ${(sumGrip[i] / samples).toFixed(3)}  ` +
          `load I/M/O ${w.tyre.bandLoad.map((v) => v.toFixed(2)).join('/')}  wear ${(w.tyre.wear * 100).toFixed(2)}%`
      );
      sumBand[i] = [0, 0, 0];
      sumP[i] = 0;
      sumGrip[i] = 0;
    });
    samples = 0;
    // Tread lost during the lap, averaged over the four wheels
    const lapWear = car.wheels.map((w, i) => w.tyre.wear - wearAtLapStart[i]);
    const meanLapWear = lapWear.reduce((a, b) => a + b, 0) / lapWear.length;
    console.log(`  tread lost this lap: mean ${(meanLapWear * 100).toFixed(2)}% (${lapWear.map((v) => (v * 100).toFixed(2)).join('/')} FR/FL/RR/RL)`);
    car.wheels.forEach((w, i) => (wearAtLapStart[i] = w.tyre.wear));
  }
}
