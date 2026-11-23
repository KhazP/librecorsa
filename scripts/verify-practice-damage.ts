/**
 * Practice damage (#169), headless:
 *
 *   npx tsx scripts/verify-practice-damage.ts
 *
 * 1. The setting: off by default, each level read back, an old save or an unknown value reads as off
 * 2. The player's damage feed (player-damage.ts, the online race's and practice's alike): a barrier impact counts once,
 *    a hit after a grid start counts though the car's clock went back, Off breaks nothing, the damage goes to the car
 *    once per change, a big hit puts the car out, Flashback puts the damage back as it was
 * 3. The car the sim worker drives: its impact reaches the page, and the damage reaches its physics, one message a hit
 */
import { getActiveTrackData } from '../src/lib/track-data';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { DEFAULT_PLAYER_SETTINGS, parsePlayerSettings } from '../src/lib/settings/player-settings';
import { CarDamage, DAMAGE_LEVELS, type CarDamageEffects, type DamageLevel } from '../src/lib/sim/car-damage';
import { damageStatusOf, PlayerDamageFeed, PLAYER_HALF_LENGTH_M, PLAYER_HALF_WIDTH_M } from '../src/lib/sim/player-damage';
import { createSimHost, loopbackTransport } from '../src/lib/sim/runtime/sim-host';
import type { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import type { CarTelemetry } from '../src/types/f1';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

console.log('== The setting');
{
  check('Off by default', DEFAULT_PLAYER_SETTINGS.practiceDamage === 'off' && parsePlayerSettings(undefined).practiceDamage === 'off');
  check('A save from before the setting reads as off', parsePlayerSettings({ realism: 'full' }).practiceDamage === 'off');
  const back = DAMAGE_LEVELS.map((level) => parsePlayerSettings(JSON.parse(JSON.stringify({ ...DEFAULT_PLAYER_SETTINGS, practiceDamage: level }))).practiceDamage);
  check('Each level is read back', back.every((level, i) => level === DAMAGE_LEVELS[i]), back.join(', '));
  check('An unknown value reads as off', parsePlayerSettings({ practiceDamage: 'heavy' }).practiceDamage === 'off' && parsePlayerSettings({ practiceDamage: 2 }).practiceDamage === 'off');
  check('The AI race\'s damage is its own', parsePlayerSettings({ practiceDamage: 'full' }).race.damage === DEFAULT_PLAYER_SETTINGS.race.damage);
}

/** A car's telemetry with a barrier impact (or none), and the damage effects it is handed */
type WallImpact = NonNullable<CarTelemetry['f12026']>['wallImpact'];
function fakeCar() {
  const channels: { wallImpact: WallImpact } = { wallImpact: null };
  const handed: (Readonly<CarDamageEffects> | null)[] = [];
  return {
    telemetry: { f12026: channels } as unknown as Pick<CarTelemetry, 'f12026'>,
    channels,
    handed,
    hit(atMs: number, speedMs: number, localZ = PLAYER_HALF_LENGTH_M, localX = 0) {
      channels.wallImpact = { atMs, speedMs, localX, localZ };
    },
    setDamageEffects(effects: Readonly<CarDamageEffects> | null) {
      handed.push(effects ? { ...effects, wheelGripMult: [...effects.wheelGripMult], wheelToeRad: [...effects.wheelToeRad] } : null);
    },
  };
}
const newDamage = (level: DamageLevel) => new CarDamage(level, PLAYER_HALF_LENGTH_M, PLAYER_HALF_WIDTH_M, () => 0.99);

console.log('\n== The damage feed');
{
  const car = fakeCar();
  const damage = newDamage('full');
  const feed = new PlayerDamageFeed();
  feed.restart(car.telemetry);
  feed.update(damage, car);
  check('An undamaged car is handed no damage', car.handed.length === 1 && car.handed[0] === null && damageStatusOf(damage) === undefined);
  for (let f = 0; f < 30; f++) feed.update(damage, car);
  check('and nothing more while nothing changes', car.handed.length === 1, `${car.handed.length} hand-over(s) in 31 frames`);

  car.hit(5000, 12);
  const report = feed.update(damage, car);
  for (let f = 0; f < 30; f++) feed.update(damage, car);
  const afterOne = damage.front;
  check('A nose-first barrier hit breaks the front once', report !== null && report.zone === 'front' && afterOne > 0.3 && afterOne < 1, `front ${(afterOne * 100).toFixed(0)}%`);
  check('The car is handed the damage once', car.handed.length === 2 && (car.handed[1]?.frontDownforceMult ?? 1) < 1, `front downforce ×${car.handed[1]?.frontDownforceMult.toFixed(2)}`);
  const status = damageStatusOf(damage);
  check('The HUD reads it', status !== undefined && status.front === damage.front && !status.terminal, status ? `overall ${(status.overall * 100).toFixed(0)}%` : 'none');

  // A grid start: the car's clock starts over, and a hit can read earlier than the last one counted
  feed.restart(car.telemetry);
  damage.reset();
  car.channels.wallImpact = null;
  feed.update(damage, car);
  check('A new run hands the repaired car over', car.handed[car.handed.length - 1] === null && damage.pristine);
  car.hit(1200, 12);
  feed.update(damage, car);
  check('A hit after a grid start counts, its time earlier than the last', damage.front > 0.3, `front ${(damage.front * 100).toFixed(0)}%`);

  // Off: the same hit breaks nothing
  const offCar = fakeCar();
  const off = newDamage('off');
  const offFeed = new PlayerDamageFeed();
  offFeed.restart(offCar.telemetry);
  offCar.hit(800, 20);
  offFeed.update(off, offCar);
  check('Off: the hit breaks nothing', off.pristine && offCar.handed.length === 1 && offCar.handed[0] === null && damageStatusOf(off) === undefined);

  // A hit while no damage is judged (the setting off, a room), then damage switched on: the old hit is not counted
  const lateCar = fakeCar();
  const late = newDamage('full');
  const lateFeed = new PlayerDamageFeed();
  lateFeed.restart(lateCar.telemetry);
  lateCar.hit(4000, 25);
  lateFeed.skip(lateCar.telemetry);
  lateFeed.update(late, lateCar);
  lateCar.hit(4500, 12);
  lateFeed.update(late, lateCar);
  check('Switched on after a hit: only hits from then on count', !late.terminal && late.front > 0 && late.front < 1, `front ${(late.front * 100).toFixed(0)}%`);

  // Put out: a big hit (full damage: ≥ 24 m/s into the barrier)
  const wreckCar = fakeCar();
  const wreck = newDamage('full');
  const wreckFeed = new PlayerDamageFeed();
  wreckFeed.restart(wreckCar.telemetry);
  wreckCar.hit(9000, 30);
  const out = wreckFeed.update(wreck, wreckCar);
  const last = wreckCar.handed[wreckCar.handed.length - 1];
  check('A big hit puts the car out: no power', out?.terminal === true && wreck.terminal && last?.powerMult === 0 && damageStatusOf(wreck)?.terminal === true, `${(30 * 3.6).toFixed(0)} km/h`);
  const reduced = newDamage('reduced');
  const reducedCar = fakeCar();
  const reducedFeed = new PlayerDamageFeed();
  reducedFeed.restart(reducedCar.telemetry);
  reducedCar.hit(9000, 30);
  reducedFeed.update(reduced, reducedCar);
  check('Reduced: the same hit leaves the car running, less broken', !reduced.terminal && reduced.front < wreck.front, `front ${(reduced.front * 100).toFixed(0)}% against ${(wreck.front * 100).toFixed(0)}%`);
}

console.log('\n== Flashback');
{
  const car = fakeCar();
  const damage = newDamage('full');
  const feed = new PlayerDamageFeed();
  feed.restart(car.telemetry);
  // As driven: as new at 0-10 s, a front hit at 10 s, a rear hit at 20 s
  for (let t = 0; t <= 30; t += 0.5) {
    if (t === 10) car.hit(10_000, 10);
    if (t === 20) car.hit(20_000, 10, -PLAYER_HALF_LENGTH_M);
    feed.update(damage, car);
    feed.record(damage, t);
  }
  const front = damage.front;
  check('Driven: front and rear damaged', front > 0 && damage.rear > 0);
  feed.rewind(damage, 15);
  feed.update(damage, car);
  check('Back to 15 s: the front hit stays, the rear one is undone', damage.front === front && damage.rear === 0 && car.handed[car.handed.length - 1] !== null);
  feed.rewind(damage, 5);
  feed.update(damage, car);
  check('Back to 5 s: as new, and the car is told', damage.pristine && car.handed[car.handed.length - 1] === null);
  // Driven on from 5 s: a new hit and a second rewind still find their place
  car.hit(30_000, 10);
  feed.update(damage, car);
  feed.record(damage, 8);
  feed.rewind(damage, 6);
  check('Driven on, then back again: as new before the new hit', damage.pristine);
}

console.log('\n== The car the sim worker drives (f12026-car)');
{
  const loop = loopbackTransport();
  let damageCalls = 0;
  const post = loop.transport.post;
  loop.transport.post = (command) => {
    if (command.type === 'call' && command.name === 'setDamageEffects') damageCalls++;
    post(command);
  };
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const track = getActiveTrackData(1200);
  const car = host.adopt(vehicleModelSpec('f12026-car').createSim(track, null), 'f12026-car');
  car.autoGearbox = true;
  car.resetToStartGrid(false);
  const frame = (inputs = { throttle: 0.6 }) => {
    car.step(1 / 60, inputs);
    loop.advance(1 / 60);
    host.endFrame(true);
  };
  host.endFrame(true);
  const sim = loop.runtime.simulatedCar!;
  const vehicle = (sim as unknown as { vehicle: VehiclePhysics }).vehicle;
  const damage = newDamage('full');
  const feed = new PlayerDamageFeed();
  feed.restart(car.telemetry);
  for (let f = 0; f < 60; f++) {
    frame();
    feed.update(damage, car);
  }
  check('The worker drives the car', host.remote && sim.vxMs > 3, `${(sim.vxMs * 3.6).toFixed(0)} km/h`);
  const callsBefore = damageCalls;
  // The worker's car reports a barrier hit on its front right corner (as its contact solver does)
  const channels = sim.telemetry.f12026!;
  channels.wallImpact = { atMs: 1000, speedMs: 14, localX: -0.8, localZ: 2.2 };
  let seenAt = -1;
  for (let f = 0; f < 60; f++) {
    frame();
    const was = damage.version;
    feed.update(damage, car);
    if (seenAt < 0 && damage.version !== was) seenAt = f;
  }
  check('Its impact reaches the page', seenAt >= 0 && seenAt <= 3 && damage.front > 0, `after ${seenAt + 1} frame(s), front ${(damage.front * 100).toFixed(0)}%, FR suspension ${(damage.suspension[0] * 100).toFixed(0)}%`);
  check('The damage reaches the worker\'s car', vehicle.damageGrip[1] < 1 && vehicle.damageToeRad[1] !== 0, `FR grip ×${vehicle.damageGrip[1].toFixed(2)}, toe ${((vehicle.damageToeRad[1] * 180) / Math.PI).toFixed(2)}°`);
  check('One message for the hit, none per frame', damageCalls - callsBefore === 1, `${damageCalls - callsBefore} message(s) in 60 frames`);
  // Put out, then a grid start repairs it (resetRun: the feed starts over and the car is handed no damage)
  channels.wallImpact = { atMs: 3000, speedMs: 30, localX: 0, localZ: 2.75 };
  for (let f = 0; f < 10; f++) {
    frame({ throttle: 1 });
    feed.update(damage, car);
  }
  check('A big hit: the worker\'s car has no power', damage.terminal && vehicle.damagePowerMult === 0);
  feed.restart(car.telemetry);
  car.setDamageEffects?.(null);
  damage.reset();
  car.resetToStartGrid(true);
  for (let f = 0; f < 10; f++) {
    frame();
    feed.update(damage, car);
  }
  check('Restarted: repaired on the worker\'s car', damage.pristine && vehicle.damagePowerMult === 1 && vehicle.damageGrip.every((g) => g === 1));
  host.dispose();
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll practice damage checks passed.');
if (failures.length) process.exitCode = 1;
