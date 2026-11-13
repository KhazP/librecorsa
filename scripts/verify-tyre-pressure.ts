/** Gauge/absolute pressure regressions through both tyre models and their simulator adapters. */
import { strict as assert } from 'node:assert';
import {
  coldPressureFor, createTyreRuntime, setTyreColdPressure, setTyreTemperature, updateTyreThermal,
} from '../src/lib/sim/ac-tyre';
import { LC26_TYRES } from '../src/lib/sim/lc26-data';
import { compoundData, F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { createTyreRuntime as createVehicleTyre, VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AMG_GT3_CONFIG } from '../src/lib/sim/gt3/AmgGt3Config';
import { createAmgGt3Sim } from '../src/lib/sim/gt3/AmgGt3Sim';
import { createFlatTestTrack } from './lib/flat-track';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { TYRE_SETUP_LIMITS } from '../src/lib/sim/tyre-setup';

// Independent test reference: psig + one standard atmosphere gives psia.
const ATM = 14.6959;
const K = 273.15;
let passed = 0;
const failures: string[] = [];
function check(name: string, run: () => void): void {
  try {
    run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (±${tolerance})`);
}
function gasInvariant(psi: number, tempC: number): number {
  return (psi + ATM) / (tempC + K);
}

check('LC26: known hot-to-cold gauge pressures at 95 → 20 °C', () => {
  near(coldPressureFor(23.5), 15.71868124405813);
  near(coldPressureFor(21.5), 14.126123862556023);
});

check('LC26: explicit setup, heating, cooling and no-change temperature', () => {
  const tyre = createTyreRuntime(LC26_TYRES.soft.front, 20);
  setTyreColdPressure(tyre, 20);
  near(tyre.pressurePsi, 20);
  setTyreTemperature(tyre, 95);
  near(tyre.pressurePsi, 28.87665870714651);
  near(tyre.coldPressurePsi, 20); // Heating must not rewrite the driver's setup.
  setTyreTemperature(tyre, 5);
  assert.ok(tyre.pressurePsi < 20);
  near(gasInvariant(tyre.pressurePsi, 5), gasInvariant(20, 20));
  setTyreTemperature(tyre, 20);
  near(tyre.pressurePsi, 20);
});

check('LC26: zero gauge pressure still contains gas and rises when heated', () => {
  const tyre = createTyreRuntime(LC26_TYRES.soft.front, 20);
  setTyreColdPressure(tyre, 0);
  setTyreTemperature(tyre, 95);
  near(tyre.pressurePsi, 3.759824322019446);
});

for (const [compound, axles] of Object.entries(LC26_TYRES)) {
  for (const axle of ['front', 'rear'] as const) {
    check(`LC26 ${compound} ${axle}: reference pressure, wet shift and thermal update`, () => {
      const spec = axles[axle];
      const tyre = createTyreRuntime(spec, 95);
      near(tyre.pressurePsi, spec.pressureRefPsi);
      const refC = 95 + 0.75 * (spec.wet?.tempShiftC ?? 0);
      setTyreTemperature(tyre, refC);
      near(gasInvariant(tyre.pressurePsi, refC), gasInvariant(spec.pressureRefPsi, 95));
      near(tyre.verticalRate, spec.rate, 1e-7); // Wet optimum must use the same absolute-pressure conversion.
      const cold = tyre.coldPressurePsi;
      updateTyreThermal(tyre, 20000, 4000, 40, 26, 35, 0.01, 500);
      near(gasInvariant(tyre.pressurePsi, tyre.gasTempC), gasInvariant(cold, 20));
      near(tyre.coldPressurePsi, cold);
    });
  }
}

for (const [name, config] of [['F12026', F12026_CAR_CONFIG], ['AMG GT3', AMG_GT3_CONFIG]] as const) {
  for (const [slot, compound] of Object.entries(config.compoundSlots)) {
    check(`${name} ${slot}: both axles, blanket defaults and live pressure/telemetry`, () => {
      const car = new VehiclePhysics({ ground: new FlatGroundQuery(0), config, compound });
      const cd = compoundData(config, compound);
      const data = [createVehicleTyre(cd).data, createVehicleTyre(cd, true).data];
      for (const w of car.wheels) {
        const td = data[w.isFront ? 0 : 1];
        const refC = td.pressureData.coldRefC;
        const targetC = (td.thermalData.optimalTempC[0] + td.thermalData.optimalTempC[1]) / 2;
        // The default is rounded to 0.1 psi at the blanket temperature.
        near(gasInvariant(w.coldPressurePsi, refC), gasInvariant(td.pressureData.optimalPsi, targetC), 0.0500001 / (refC + K));
        near(w.pressurePsi, w.coldPressurePsi);
        w.coldPressurePsi = w.isFront ? 20 : 19;
      }
      // Exercise heating and cooling through the real thermal step, comparing the resulting gas proxy. The thermal
      // state is the three bands' surface and carcass nodes; the tyre's core (gas) temperature is derived from them
      for (const tempC of [110, 35]) {
        for (const w of car.wheels) {
          w.bandTempsC.fill(tempC);
          w.bandCoreTempsC.fill(tempC);
        }
        car.step(0.002, { throttle: 0, brake: 0, steer: 0 });
        for (const [i, w] of car.wheels.entries()) {
          const refC = data[w.isFront ? 0 : 1].pressureData.coldRefC;
          near(w.coldPressurePsi, w.isFront ? 20 : 19);
          near(w.coreTempC, tempC, 0.5);
          near(gasInvariant(w.pressurePsi, w.coreTempC), gasInvariant(w.coldPressurePsi, refC));
          near(car.telemetry.tyrePressurePsi[i], w.pressurePsi);
        }
      }
    });
  }
}

const track = createFlatTestTrack();
check('LC26: physical defaults fit garage/save limits and survive setup reset/reload', () => {
  const sim = new F1Physics2026(track);
  const defaults = sim.getTyreSetup();
  assert.deepEqual(defaults.coldPressurePsi, { fl: 15.7, fr: 15.7, rl: 14.1, rr: 14.1 });
  const range = TYRE_SETUP_LIMITS.lc26.pressurePsi;
  for (const psi of Object.values(defaults.coldPressurePsi)) assert.ok(psi >= range.min && psi <= range.max);
  sim.setTyreSetup(JSON.parse(JSON.stringify(defaults)));
  sim.resetToStartGrid(false);
  assert.deepEqual(sim.getTyreSetup(), defaults);
  near(sim.wheels[0].tyre.coldPressurePsi, 15.7);
  near(sim.wheels[2].tyre.coldPressurePsi, 14.1);
});

for (const [name, sim, config] of [
  ['F12026', new F12026CarSim(track), F12026_CAR_CONFIG],
  ['AMG GT3', createAmgGt3Sim(track), AMG_GT3_CONFIG],
] as const) {
  check(`${name} adapter: compound default conversion and gauge setup round-trip`, () => {
    // Preserve a driver's front-pressure offset as the adapter recalculates compound defaults.
    const initial = sim.getTyreSetup();
    sim.setTyreSetup({ ...initial, coldPressurePsi: { ...initial.coldPressurePsi, fl: initial.coldPressurePsi.fl - 1 } });
    sim.tireCompound = 'wet';
    const td = compoundData(config, config.compoundSlots.wet);
    const targetC = (td.thermalData.optimalTempC[0] + td.thermalData.optimalTempC[1]) / 2;
    const setup = sim.getTyreSetup();
    near(gasInvariant(setup.coldPressurePsi.fl + 1, td.pressureData.coldRefC), gasInvariant(td.pressureData.optimalPsi, targetC), 0.0500001 / (td.pressureData.coldRefC + K));
    sim.setTyreSetup({ ...setup, coldPressurePsi: { fl: 20, fr: 20.5, rl: 19, rr: 19.5 } });
    assert.deepEqual(sim.getTyreSetup().coldPressurePsi, { fl: 20, fr: 20.5, rl: 19, rr: 19.5 });
    sim.resetToStartGrid(false);
    sim.step(0.002, {});
    assert.deepEqual(sim.getTyreSetup().coldPressurePsi, { fl: 20, fr: 20.5, rl: 19, rr: 19.5 });
    assert.ok(sim.telemetry.tirePressuresPsi?.every(Number.isFinite));
  });
}

console.log(`\n${passed} pressure checks passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
