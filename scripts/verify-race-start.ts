/**
 * Manual race starts (`race-start.ts`), on flat ground:
 *   npx tsx scripts/verify-race-start.ts
 *
 * Held on the grid, the car never moves and keeps its gear whatever the pedals and paddles do, while its engine revs
 * free on the throttle. Let go after the lights, it waits on a held clutch and goes as the clutch comes out. Every car
 * has a launch window inside its rev range, and the jump start watch calls a clutch let out in gear with the revs up
 * through the lights, not a flick of the pedal, neutral or a start the car is not held for.
 */
import { createFlatTestTrack } from './lib/flat-track';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { JumpStartWatch, LAUNCH_RPM, launchWindow } from '../src/lib/sim/race-start';
import type { AiRace } from '../src/lib/sim/ai-race';
import { DEFAULT_RACE_SETUP, parseRaceSetup, startAiRace } from '../src/lib/sim/race-setup';
import { revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from '../src/lib/sim/rev-range';
import { isVehicleModelId, type ControlInputs, type VehicleModelId } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(66)} ${detail}`);
  if (!ok) failures.push(name);
};
const DT = 1 / 120;
const track = createFlatTestTrack(30_000, 3000);
const CARS: VehicleModelId[] = ['f12026-car', 'amg-gt3', 'bmw-m1-procar', 'liana'];

for (const id of CARS) {
  console.log(`\n== ${id}`);
  const sim = vehicleModelSpec(id).createSim(track, null);
  sim.assistPreset = 'semi_pro';
  sim.autoGearbox = true;
  sim.teleportToDistance(1000, 0);
  sim.step(DT, {});
  const p0 = sim.worldPosition.clone();
  const gear0 = sim.telemetry.gear;
  sim.gridHold = true;
  const hold = (seconds: number, inputs: Partial<ControlInputs>) => {
    for (let t = 0; t < seconds; t += DT) sim.step(DT, { ...inputs });
  };
  hold(1.5, { throttle: 0.6, clutch: 1 });
  const revs = sim.telemetry.rpm;
  hold(0.5, { throttle: 1 });
  hold(0.2, { throttle: 0.5, shiftUp: true });
  hold(0.2, { throttle: 0.5, shiftDown: true, neutral: true });
  hold(0.5, { brake: 0, throttle: 0.3, analogSteer: 0.5 });
  const moved = sim.worldPosition.distanceTo(p0);
  check('held: the car stays on its spot whatever the pedals do', moved < 0.02 && sim.telemetry.speedKmh < 0.1, `${(moved * 100).toFixed(1)} cm, ${sim.telemetry.speedKmh.toFixed(2)} km/h`);
  check('held: the engine revs free on the throttle', revs > 2500, `${Math.round(revs)} rpm`);
  check('held: the paddles and neutral leave the gear alone', sim.telemetry.gear === gear0, `gear ${gear0} → ${sim.telemetry.gear}`);
  // The lights go out with the clutch held: the car waits; let out, it goes
  sim.gridHold = false;
  for (let t = 0; t < 0.5; t += DT) sim.step(DT, { throttle: 0.6, clutch: 1 });
  const waited = sim.worldPosition.distanceTo(p0);
  for (let t = 0; t < 0.4; t += DT) sim.step(DT, { throttle: 0.8, clutch: 1 - t / 0.4 });
  for (let t = 0; t < 2; t += DT) sim.step(DT, { throttle: 0.8 });
  check('after the lights: waits on a held clutch, goes as it comes out', waited < 0.05 && sim.telemetry.speedKmh > 20, `${(waited * 100).toFixed(1)} cm while held, then ${sim.telemetry.speedKmh.toFixed(0)} km/h`);
}

console.log('\n== Launch windows');
{
  const ids = (Object.keys(LAUNCH_RPM) as VehicleModelId[]).filter(isVehicleModelId);
  const bad = ids.filter((id) => {
    const [lo, hi] = launchWindow(id, 0);
    const limiter = revRangeFor(id)[1] + SHIFT_BEEP_BELOW_LIMITER_RPM;
    return !(lo > 1000 && hi > lo && hi < limiter);
  });
  check('every measured window sits inside its car\'s rev range', bad.length === 0, bad.join(', ') || `${ids.length} cars`);
  const [lo, hi] = launchWindow('unknown-car', 10000);
  check('a car without a window gets 55-75 % of its limiter', lo === 5500 && hi === 7500, `${lo}-${hi}`);
}

console.log('\n== Jump starts');
{
  const run = (frames: [number, boolean, number, number, boolean][]) => {
    const w = new JumpStartWatch();
    for (const [dt, held, clutch, throttle, inGear] of frames) w.update(dt, held, clutch, throttle, inGear);
    return w.jumped;
  };
  const many = (n: number, f: [number, boolean, number, number, boolean]) => Array.from({ length: n }, () => f);
  check('clutch held, revs up: no jump start', !run(many(120, [1 / 60, true, 1, 1, true])));
  check('clutch out in gear with the revs up for a quarter second: jump start', run(many(15, [1 / 60, true, 0, 0.8, true])));
  check('a tenth of a second off the clutch: not one', !run([...many(6, [1 / 60, true, 0, 0.8, true]), ...many(30, [1 / 60, true, 1, 0.8, true])]));
  check('off the clutch in neutral: not one', !run(many(60, [1 / 60, true, 0, 1, false])));
  check('off the clutch, off the throttle: not one', !run(many(60, [1 / 60, true, 0, 0, true])));
  check('after the lights (not held): never one', !run(many(60, [1 / 60, false, 0, 1, true])));
  const w = new JumpStartWatch();
  for (let i = 0; i < 20; i++) w.update(1 / 60, true, 0, 1, true);
  w.update(1 / 60, true, 1, 1, true);
  check('a jump start is kept until the next race', w.jumped);
  w.reset();
  check('and cleared for it', !w.jumped);
}

// ---- The launch rides with the race setup, so every race start (the menu, a restart, a new car) reads the same one
{
  console.log('\n== the race setup');
  const startWith = (patch: Partial<typeof DEFAULT_RACE_SETUP>, standing?: boolean) => {
    const field = { manualStart: false, startRace: () => {} } as unknown as AiRace;
    startAiRace(field, { ...DEFAULT_RACE_SETUP, ...patch }, null, standing);
    return field.manualStart;
  };
  check('a new player starts assisted', DEFAULT_RACE_SETUP.launch === 'assisted');
  check('a manual launch makes a manual start', startWith({ launch: 'manual' }));
  check('an assisted launch does not', !startWith({ launch: 'assisted' }));
  check('a rolling start is never a manual one', !startWith({ launch: 'manual', start: 'rolling' }));
  check('a flying start (standing forced off) is never a manual one', !startWith({ launch: 'manual' }, false));
  check('the launch is saved with the race setup', parseRaceSetup(JSON.parse(JSON.stringify({ ...DEFAULT_RACE_SETUP, launch: 'manual' }))).launch === 'manual');
  check('an unknown launch reads as assisted', parseRaceSetup({ launch: 'auto' }).launch === 'assisted');
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll race start checks passed.');
process.exit(failures.length ? 1 : 0);
