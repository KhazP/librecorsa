/**
 * Hazards judged against a car's own pace (`isHazardSpeed`, `hazardPaceProfile`, `AiOpponentField.isHazard`), and the
 * VSC pace taken from it:
 *   npx tsx scripts/verify/verify-hazard-pace.ts
 *
 * A car is a hazard when it crawls for itself: well under the speed its own model carries there, not under the
 * circuit's speed profile, which is the LC26's. A road car at its normal pace through a hairpin or up a climb is none;
 * the same car at half its corner speed, or stopped, is. A queue braking early into a corner is still racing, and a car
 * held up close behind a car no faster is queuing: the car holding the jam up is the hazard. The VSC pace the player is
 * held to and the autopilot drives to is a share of the car's own speed too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { VEHICLE_MODELS, vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../../src/lib/sim/ai-opponents';
import { hazardPaceProfile, isHazardSpeed } from '../../src/lib/sim/ai-racecraft';
import { ownPaceFor, ownSpeedAt, racingLineOfVehicle, vehicleOwnSpeedMs } from '../../src/lib/sim/own-pace';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { TrackEnvironment } from '../../src/lib/sim/track-environment';
import { VSC_PACE_SHARE, vscReferenceSpeedMs } from '../../src/lib/sim/vsc';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failures.push(name);
};
const f1 = (v: number) => v.toFixed(1);

console.log('== isHazardSpeed');
// A road car's hairpin: it is expected to carry 10.6 m/s through it, and does ~9 at its normal pace
const hairpin = 10.6;
check('a slow car at its own corner speed: no hazard', !isHazardSpeed(hairpin, hairpin));
check('…nor at its normal pace a little under it (9 m/s, under the old 8 m/s floor + margin)', !isHazardSpeed(9, hairpin));
check('the same car at half its corner speed: a hazard', isHazardSpeed(hairpin / 2, hairpin));
check('a stopped car: a hazard', isHazardSpeed(0, hairpin) && isHazardSpeed(0.5, 40));
// Where the car's own speed is high, a third of it is crawling (unchanged); in a fast car's hairpin, 8 m/s (unchanged)
check('a third of its own speed on a straight: a hazard, 40 % of it none', isHazardSpeed(0.33 * 85, 85) && !isHazardSpeed(0.4 * 85, 85));
check('an F1 hairpin (17 m/s): under 8 m/s a hazard, over it none (as before)', isHazardSpeed(7.9, 17) && !isHazardSpeed(8.1, 17));
// The climb at RISE short: a road car at its normal 25 m/s where it is expected to do 27.5, and the LC26 does 72
check('a road car at its normal pace up a climb: no hazard against its own speed', !isHazardSpeed(25, 27.5));
check('…which the circuit\'s (LC26) speed there made one', isHazardSpeed(25, 72));

console.log('\n== hazardPaceProfile');
{
  // A closed 4 km lap every 2 m: 80 m/s, one hairpin at 15 m/s at s = 2000 m, braked into at 30 m/s² and left at 3 m/s²
  const ds = 2;
  const n = 2000;
  const apex = 1000;
  const exp = new Float64Array(n).fill(80);
  for (let i = 0; i < n; i++) {
    const d = (i - apex) * ds;
    const v = d <= 0 ? Math.sqrt(15 * 15 + 2 * 30 * -d) : Math.sqrt(15 * 15 + 2 * 3 * d);
    exp[i] = Math.min(80, v);
  }
  const eased = hazardPaceProfile(exp, ds, () => 30);
  const at = (m: number) => eased[apex + m / ds];
  const ex = (m: number) => exp[apex + m / ds];
  check('the apex keeps its speed', Math.abs(eased[apex] - 15) < 1e-9, `${f1(eased[apex])} m/s`);
  check('the braking zone is eased under the limit braking (40 m before the apex)', at(-40) < ex(-40) - 5, `${f1(at(-40))} vs ${f1(ex(-40))} m/s`);
  check('…to about a third of the braking (40 m before: √(15² + 2·0.35·30·40))', Math.abs(at(-40) - Math.sqrt(225 + 2 * 0.35 * 30 * 40)) < 0.5, f1(at(-40)));
  check('the exit and the straight are untouched', at(200) === ex(200) && eased[0] === exp[0] && eased[apex - 700] === 80);
  check('never over the expected speed', eased.every((v, i) => v <= exp[i] + 1e-9));
  // A queue braking early: 15 m/s 40 m before a 15 m/s apex is slow, not crawling
  check('a queue braking early into it (15 m/s, 40 m out): no hazard', !isHazardSpeed(15, at(-40)) && isHazardSpeed(15, ex(-40)), `limit ${f1(ex(-40))}, eased ${f1(at(-40))} m/s`);
}

console.log('\n== AiOpponentField on RISE short (road cars)');
{
  const id = 'rwanda_official_short';
  const file = `public/tracks/${id}/track_data.json`;
  if (!existsSync(file)) {
    console.log(`SKIP  ${file} is not here (hosted asset)`);
  } else {
    setActiveTrack(id, JSON.parse(readFileSync(file, 'utf8')) as RawTrackJson);
    const track = getActiveTrackData(1200);
    const player = vehicleModelSpec('liana').createSim(track, null);
    const field = new AiOpponentField(track, player, aiDriversFor(1), new TrackEnvironment(track), { seed: 3, learning: false, trackId: id });
    field.startRace(true);
    type Car = {
      isPlayer: boolean;
      sim: SimulatorCar;
      launched: boolean;
      retired: boolean;
      clock: { distM: number; startDistM: number };
      control: { incident?: unknown } | null;
    };
    const f = field as unknown as {
      cars: Car[];
      phase: string;
      raceTimeS: number;
      isHazard(c: Car): boolean;
      ownSpeedMs(c: Car, hazard?: boolean): number;
      vsc: { _phase: string };
      updateVsc(dt: number): void;
    };
    f.phase = 'racing';
    f.raceTimeS = 90;
    const ai = f.cars.find((c) => !c.isPlayer) as Car;
    const me = f.cars.find((c) => c.isPlayer) as Car;
    // The T3 hairpin at the top of the climb (~1,310 m), where the leading road car brakes to ~9 m/s every lap
    const probe = { sim: { vehicleId: ai.sim.vehicleId, racingLineId: ai.sim.racingLineId, sMeters: 0 } } as unknown as Car;
    const ownAt = (s: number) => ((probe.sim as { sMeters: number }).sMeters = s, f.ownSpeedMs(probe, true));
    let apexS = 1250;
    for (let s = 1250; s <= 1380; s += 1) if (ownAt(s) < ownAt(apexS)) apexS = s;
    const place = (car: Car, s: number, v: number) => {
      car.sim.teleportToDistance(s, v, 0);
      car.clock.distM = s + track.totalLengthM;
      car.clock.startDistM = 0;
      car.launched = true;
    };
    const own = ownAt(apexS);
    const nominal = track.getSampleAtDistance(apexS).optimalSpeedKmh / 3.6;
    check('the road car\'s own hairpin speed is its own, not the circuit\'s', own < 0.75 * nominal && own > 7, `${f1(own)} vs circuit ${f1(nominal)} m/s at ${apexS} m`);
    place(ai, apexS, 9);
    check('at its normal hairpin speed (9 m/s): no hazard', !f.isHazard(ai));
    place(ai, apexS, 7.5);
    check('a little slower in traffic (7.5 m/s, under the old 8 m/s floor): no hazard', !f.isHazard(ai));
    place(ai, apexS, own / 2);
    check('at half its own hairpin speed: a hazard', f.isHazard(ai), `${f1(own / 2)} m/s`);
    place(ai, apexS, 0.5);
    check('stopped there: a hazard', f.isHazard(ai));
    // Up the climb (~1,150 m) at its normal 25 m/s, where 35 % of the circuit's speed is ~25 m/s
    place(ai, 1150, 25);
    check('up the climb at its normal 25 m/s: no hazard', !f.isHazard(ai), `own ${f1(f.ownSpeedMs(ai, true))}, circuit ${f1(track.getSampleAtDistance(1150).optimalSpeedKmh / 3.6)} m/s`);
    place(ai, 1150, 5);
    check('crawling up the climb at 5 m/s: a hazard', f.isHazard(ai));
    // A jam: a slow car close behind a car no faster is queuing, not crawling; the car holding it up is the hazard
    place(me, 1160, 5);
    check('crawling up the climb close behind a car no faster (a jam): no hazard', !f.isHazard(ai));
    check('…the car holding it up, with the road clear ahead: a hazard', f.isHazard(me));
    place(me, 1151, 5);
    check('…nor beside a car no faster, a metre ahead or behind', !f.isHazard(ai) && (place(me, 1149, 5), !f.isHazard(ai)));
    place(me, 1160, 0.5);
    check('rolling behind a stopped car: no hazard, the stopped car is', !f.isHazard(ai) && f.isHazard(me));
    place(ai, 1150, 0.5);
    check('stopped behind it: a hazard too', f.isHazard(ai));
    place(me, 5000, 40);
    place(ai, 1150, 25);
    ai.retired = true;
    check('a retired car there, whatever its speed: a hazard', f.isHazard(ai));
    ai.retired = false;
    // Under the VSC the field runs at its pace share: a car at that pace through the hairpin is no hazard
    f.vsc._phase = 'deployed';
    place(ai, apexS, 0.65 * 9);
    check('under the VSC, at the VSC share of its hairpin pace: no hazard', !f.isHazard(ai), `${f1(0.65 * 9)} m/s`);
    place(ai, apexS, 0.5);
    check('under the VSC, stopped: still a hazard', f.isHazard(ai));
    f.vsc._phase = 'none';

    // The VSC pace on the main straight (~400 m): a share of the car's own top end, not of the LC26's
    me.sim.teleportToDistance(400, 40, 0);
    const ownStraight = f.ownSpeedMs(me);
    const circuit = track.getSampleAtDistance(400).optimalSpeedKmh / 3.6;
    check('a road car\'s own speed down the straight is its own (≤ its 52 m/s top end)', ownStraight < 53 && ownStraight > 35, `${f1(ownStraight)} vs circuit ${f1(circuit)} m/s`);
    check('its VSC pace there is a share of that, under its top speed', vscReferenceSpeedMs(ownStraight * 3.6) < 0.7 * ownStraight + 1e-9, `${f1(vscReferenceSpeedMs(ownStraight * 3.6))} m/s (${VSC_PACE_SHARE} share)`);
    // The player's car on autopilot under the VSC drives to that pace, not to the circuit's share (over its top speed)
    me.sim.aiAutopilot = true;
    f.vsc._phase = 'deployed';
    // (both ways the autopilot is driven: by the field's racecraft, `autopilotRacecraft` above 0, and on its own)
    const inner = field as unknown as { rc: { autopilotRacecraft: number }; capPlayerAutopilot(L: number, dt: number): void; planTraffic(dt: number): void };
    const racecraftWas = inner.rc.autopilotRacecraft;
    for (const racecraft of [racecraftWas, 0]) {
      inner.rc.autopilotRacecraft = racecraft;
      me.sim.aiSpeedCapMs = undefined;
      inner.capPlayerAutopilot(track.totalLengthM, 1 / 120);
      if (racecraft > 0) inner.planTraffic(1 / 120);
      me.sim.teleportToDistance(400, 40, 0);
      const cap = me.sim.aiSpeedCapMs ?? Infinity;
      check(`the autopilot's VSC cap is its own VSC pace (${racecraft > 0 ? 'raced by the field\'s rules' : 'on its own'})`, Math.abs(cap - vscReferenceSpeedMs(ownStraight * 3.6)) < 0.5 && cap < vscReferenceSpeedMs(circuit * 3.6) - 5, `cap ${f1(cap)} vs circuit share ${f1(vscReferenceSpeedMs(circuit * 3.6))} m/s`);
    }
    inner.rc.autopilotRacecraft = racecraftWas;
    // Driven at full pace under the VSC, the delta runs out (it used to grow: the circuit's share was over its top speed)
    me.sim.aiAutopilot = false;
    const delta = () => (field as unknown as { vsc: { deltaS: number } }).vsc.deltaS;
    const d0 = delta();
    for (let k = 0; k < 120; k++) {
      me.sim.teleportToDistance(400, ownStraight, 0);
      f.updateVsc(1 / 60);
    }
    check('at full pace down the straight under the VSC, the player\'s delta falls', delta() < d0 - 0.5, `${d0.toFixed(2)} → ${delta().toFixed(2)} s in 2 s`);
  }
}

console.log('\n== own-pace.ts (an online car is known by its model alone)');
{
  const id = 'rwanda_official_short';
  const file = `public/tracks/${id}/track_data.json`;
  if (existsSync(file)) {
    setActiveTrack(id, JSON.parse(readFileSync(file, 'utf8')) as RawTrackJson);
    const track = getActiveTrackData(1200);
    const wrong: string[] = [];
    for (const v of Object.keys(VEHICLE_MODELS) as (keyof typeof VEHICLE_MODELS)[]) {
      const line = vehicleModelSpec(v).createSim(track, null).racingLineId ?? 'f1';
      if (racingLineOfVehicle(v) !== line) wrong.push(`${v}: ${racingLineOfVehicle(v)} vs ${line}`);
    }
    check('every model\'s racing line from its class is the line its car drives', wrong.length === 0, wrong.join(', '));
    const liana = ownPaceFor(track, 'liana', 'gt3');
    check('a model named in packets has the own pace its car has', liana !== null && vehicleOwnSpeedMs(track, 'liana', 1310) === ownSpeedAt(liana, 1310, true), `${f1(vehicleOwnSpeedMs(track, 'liana', 1310) ?? NaN)} m/s at T3`);
    check('an unknown or missing model has none (the fixed rules hold)', vehicleOwnSpeedMs(track, 'some-mod-car', 1310) === undefined && vehicleOwnSpeedMs(track, undefined, 1310) === undefined);
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll hazard pace checks passed.');
if (failures.length) process.exit(1);
