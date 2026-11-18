/**
 * Tyre blankets (`ChassisSetup.tyreBlankets`, the garage's Tyres tab), headless:
 *
 *   npx tsx scripts/verify-tyre-blankets.ts
 *
 * Each car keeps its own way unless the player picks: a car raced on blankets (the F1 cars) leaves the garage warm, a
 * car raced without them (the GT3, the LC-LMDH) leaves it cold at the full realism level and warm after a formation
 * lap, and a car whose tyres are set in the garage's air (the Chaparral 2Ds, the M1, the road cars) starts at that air.
 * Blankets on warm every car at every start; off cools a car raced on blankets on a cold garage start. Old saves keep
 * the car's own way.
 */
import { createFlatTestTrack } from './lib/flat-track';
import type { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import type { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { VEHICLE_MODELS } from '../src/lib/cars/vehicle-models';
import { clampChassisSetup, DEFAULT_CHASSIS_SETUP } from '../src/lib/sim/car-setup';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { setupSheet, type SetupParam, type SetupState } from '../src/lib/sim/setup-sheet';
import { TYRE_SETUP_LIMITS } from '../src/lib/sim/tyre-setup';
import type { TyreSetup, VehicleModelId } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};
const pad = createFlatTestTrack(30_000, 3000);

/** The tyres' temperature after a start: `blankets` 1 on, −1 off, 0 the car's own way */
function startC(vehicle: VehicleModelId, how: 'garage' | 'flying', blankets: number, level: 'full' | 'standard' = 'full'): number {
  const sim = VEHICLE_MODELS[vehicle].createSim(pad, null) as F12026CarSim;
  sim.setSimRealism(SIM_REALISM_FLAGS[level]);
  sim.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, tyreBlankets: blankets });
  sim.resetToStartGrid(how === 'flying');
  const v = (sim as unknown as { vehicle: VehiclePhysics }).vehicle;
  return v.wheels[0].coreTempC;
}

console.log('== Each car its own way (no choice made)');
{
  const chap = startC('chaparral-2d', 'garage', 0);
  const chapFly = startC('chaparral-2d', 'flying', 0);
  check('Chaparral 2D: tyres set in the garage air start at its 20 °C', Math.abs(chap - 20) < 0.5 && Math.abs(chapFly - 20) < 0.5, `${chap.toFixed(0)} / ${chapFly.toFixed(0)} °C garage / flying`);
  const f1 = startC('f12026-car', 'garage', 0);
  check('F1 2026: raced on blankets, warm out of the garage', f1 >= 75, `${f1.toFixed(0)} °C`);
  const gt3 = startC('amg-gt3', 'garage', 0);
  const gt3Fly = startC('amg-gt3', 'flying', 0);
  check('GT3: raced without blankets, cold out of the garage, warm on a flying start', gt3 < 35 && gt3Fly >= 75, `${gt3.toFixed(0)} / ${gt3Fly.toFixed(0)} °C`);
  // Rain tyres on a carcass set in the garage's air start at that air too, set to reach their pressure in their own window
  const rain = (['porsche-934-rsr', 'chaparral-2d', 'bmw-m1-procar'] as const).flatMap((v) =>
    (['intermediate', 'wet'] as const).map((c) => {
      const sim = VEHICLE_MODELS[v].createSim(pad, null) as F12026CarSim;
      sim.setSimRealism(SIM_REALISM_FLAGS.full);
      sim.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP });
      sim.tireCompound = c;
      sim.resetToStartGrid(false);
      return { name: `${v} ${c}`, c: (sim as unknown as { vehicle: VehiclePhysics }).vehicle.wheels[0].coreTempC };
    })
  );
  check('934, Chaparral 2D, M1: rain tyres leave the garage at its 20 °C', rain.every((r) => Math.abs(r.c - 20) < 0.5), rain.map((r) => `${r.name} ${r.c.toFixed(1)}`).join(', '));
}

console.log('\n== Blankets on');
{
  const chap = startC('chaparral-2d', 'garage', 1);
  const chapFly = startC('chaparral-2d', 'flying', 1);
  // The middle of its 40–80 °C window
  check('Chaparral 2D: 60 °C out of the garage and on a flying start', Math.abs(chap - 60) < 0.5 && Math.abs(chapFly - 60) < 0.5, `${chap.toFixed(0)} / ${chapFly.toFixed(0)} °C`);
  const chap67 = startC('chaparral-2d-67', 'garage', 1);
  check('Chaparral 2D 427: 60 °C out of the garage', Math.abs(chap67 - 60) < 0.5, `${chap67.toFixed(0)} °C`);
  // The middle of its 75–95 °C window is past what a blanket gives: 80
  const m1 = startC('bmw-m1-procar', 'garage', 1);
  check('M1 Procar: at a blanket\'s 80 °C', Math.abs(m1 - 80) < 0.5, `${m1.toFixed(0)} °C`);
  const gt3 = startC('amg-gt3', 'garage', 1);
  check('GT3: at its 80 °C blankets out of the garage on Full realism', Math.abs(gt3 - 80) < 0.5, `${gt3.toFixed(0)} °C`);
}

console.log('\n== Blankets off');
{
  const f1 = startC('f12026-car', 'garage', -1);
  const f1Fly = startC('f12026-car', 'flying', -1);
  const f1Std = startC('f12026-car', 'garage', -1, 'standard');
  check('F1 2026: cold out of the garage on Full realism, warm on a flying start or at Standard', f1 < 35 && f1Fly >= 75 && f1Std >= 75,
    `${f1.toFixed(0)} / ${f1Fly.toFixed(0)} / ${f1Std.toFixed(0)} °C`);
  const chap = startC('chaparral-2d', 'garage', -1);
  check('Chaparral 2D: off is its own way, 20 °C', Math.abs(chap - 20) < 0.5, `${chap.toFixed(0)} °C`);
}

console.log('\n== The garage');
{
  const tyreOf = (vehicle: VehicleModelId): TyreSetup => (VEHICLE_MODELS[vehicle].createSim(pad, null) as unknown as { getTyreSetup(): TyreSetup }).getTyreSetup();
  const param = (vehicle: VehicleModelId): SetupParam => {
    const tyres = setupSheet(vehicle, TYRE_SETUP_LIMITS[vehicle], tyreOf(vehicle)).find((g) => g.id === 'tyres');
    const p = tyres?.params.find((q) => q.id === 'tyreBlankets');
    if (!p) throw new Error(`${vehicle}: no blankets row`);
    return p;
  };
  const vehicles = Object.keys(VEHICLE_MODELS) as VehicleModelId[];
  check('Every car has a Tyre blankets switch in its Tyres tab', vehicles.every((v) => {
    try {
      return param(v).toggle === true;
    } catch {
      return false;
    }
  }), `${vehicles.length} cars`);
  const st = (blankets: number): SetupState => ({ chassis: { ...DEFAULT_CHASSIS_SETUP, tyreBlankets: blankets } } as unknown as SetupState);
  const f1 = param('f12026-car');
  const lc26 = param('lc26');
  const chap = param('chaparral-2d');
  check('On by default for the F1 cars, off for the Chaparral', f1.base === 1 && lc26.base === 1 && chap.base === 0, `F1 ${f1.base}, LC26 ${lc26.base}, Chaparral ${chap.base}`);
  check('Picking the car\'s own way saves no choice; the other way saves it', chap.set(st(0), 1).chassis.tyreBlankets === 1 && chap.set(st(1), 0).chassis.tyreBlankets === 0 &&
    f1.set(st(0), 0).chassis.tyreBlankets === -1 && f1.get(st(0)) === 1 && f1.get(st(-1)) === 0 && chap.get(st(1)) === 1, '');
  const old = clampChassisSetup({ springFrontPct: 6 });
  check('A setup saved before the switch keeps the car\'s own way', old.tyreBlankets === 0 && clampChassisSetup({ tyreBlankets: 'yes' }).tyreBlankets === 0, '');
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll tyre blanket checks passed.');
if (failures.length) process.exitCode = 1;
