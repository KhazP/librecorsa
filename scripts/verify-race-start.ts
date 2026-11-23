/**
 * Manual race starts (`race-start.ts`), on flat ground:
 *   npx tsx scripts/verify-race-start.ts
 *
 * Held on the grid with the clutch in, the car never moves and keeps its gear whatever the pedals and paddles do, while
 * its engine revs free on the throttle; off the throttle, the clutch out leaves it standing too. The clutch let out in
 * gear on the throttle, it goes. Let go after the lights, it waits on a held clutch and goes as the clutch comes out.
 * Every car has a launch window inside its rev range, and the jump start watch calls the car moving off its spot
 * through the lights, not a few centimetres of roll, revs on a car that stays put or a start the car is not held for.
 * The reaction watch times the launch from the frame the lights go out, and has none for a launch that went before.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createFlatTestTrack } from './lib/flat-track';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../src/lib/sim/ai-opponents';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { JumpStartWatch, LAUNCH_RPM, launchWindow, pullsAway, ReactionWatch } from '../src/lib/sim/race-start';
import type { AiRace } from '../src/lib/sim/ai-race';
import { DEFAULT_RACE_SETUP, parseRaceSetup, startAiRace } from '../src/lib/sim/race-setup';
import { revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from '../src/lib/sim/rev-range';
import { getActiveTrackData, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
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
  hold(0.5, { throttle: 1, clutch: 1 });
  hold(0.2, { throttle: 0.5, clutch: 1, shiftUp: true });
  hold(0.2, { throttle: 0.5, clutch: 1, shiftDown: true, neutral: true });
  hold(0.5, { brake: 0, throttle: 0.3, clutch: 1, analogSteer: 0.5 });
  hold(0.5, { throttle: 0.1, clutch: 0 });
  const moved = sim.worldPosition.distanceTo(p0);
  check('held: the car stays on its spot with the clutch in, or off the throttle', moved < 0.02 && sim.telemetry.speedKmh < 0.1, `${(moved * 100).toFixed(1)} cm, ${sim.telemetry.speedKmh.toFixed(2)} km/h`);
  check('held: the engine revs free on the throttle', revs > 2500, `${Math.round(revs)} rpm`);
  check('held: the paddles and neutral leave the gear alone', sim.telemetry.gear === gear0, `gear ${gear0} → ${sim.telemetry.gear}`);
  // The clutch let out early on the throttle: the car goes, on a copy so the rest starts from the spot
  {
    const early = vehicleModelSpec(id).createSim(track, null);
    early.assistPreset = 'semi_pro';
    early.autoGearbox = true;
    early.teleportToDistance(1000, 0);
    early.step(DT, {});
    const e0 = early.worldPosition.clone();
    early.gridHold = true;
    for (let t = 0; t < 1; t += DT) early.step(DT, { throttle: 0.6, clutch: 1 });
    for (let t = 0; t < 1.5; t += DT) early.step(DT, { throttle: 0.6, clutch: 0 });
    const went = early.worldPosition.distanceTo(e0);
    check('held: the clutch let out early on the throttle, the car goes', went > 1, `${went.toFixed(1)} m in 1.5 s`);
    // Gone early, the car is the driver's: a lift lets it coast, the hold does not brake it to a stop
    const before = early.telemetry.speedKmh;
    for (let t = 0; t < 0.3; t += DT) early.step(DT, { throttle: 0, clutch: 0 });
    const after = early.telemetry.speedKmh;
    check('held: a car that went early coasts on a lift, not braked', after > 0.7 * before, `${before.toFixed(0)} → ${after.toFixed(0)} km/h over 0.3 s`);
  }
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
  type StartFrame = [number, boolean, number, number?];
  const run = (frames: StartFrame[]) => {
    const w = new JumpStartWatch();
    for (const [dt, held, speedMs] of frames) w.update(dt, held, speedMs);
    return w.jumped;
  };
  const many = (n: number, f: StartFrame): StartFrame[] => Array.from({ length: n }, () => f);
  check('standing still through the lights: no jump start', !run(many(600, [1 / 60, true, 0])));
  check('rolling a metre off the spot: jump start', run(many(60, [1 / 60, true, 1])));
  check('a few centimetres of roll: not one', !run([...many(6, [1 / 60, true, 0.5]), ...many(120, [1 / 60, true, 0])]));
  check('after the lights (not held): never one', !run(many(120, [1 / 60, false, 20])));
  const w = new JumpStartWatch();
  for (let i = 0; i < 60; i++) w.update(1 / 60, true, 2);
  w.update(1 / 60, true, 0);
  check('a jump start is kept until the next race', w.jumped);
  w.reset();
  check('and cleared for it', !w.jumped);

  const calls = (frames: StartFrame[]) => {
    const j = new JumpStartWatch();
    const out: string[] = [];
    for (const [dt, held, speedMs, pos] of frames) {
      const c = j.update(dt, held, speedMs, pos);
      if (c) out.push(c);
    }
    return { j, out };
  };
  const creep = calls([...many(30, [1 / 60, true, 1.5]), ...many(60, [1 / 60, true, 0]), [1 / 60, false, 0]]);
  check('a short creep (0.75 m): +5 s, called once at lights out', creep.j.penaltyS === 5 && !creep.j.big && creep.out.join(',') === 'jump,verdict', creep.out.join(','));
  const gone = calls([...many(120, [1 / 60, true, 3]), [1 / 60, false, 10], ...many(30, [1 / 60, false, 20])]);
  check('a big jump (6 m before the lights went out): +10 s', gone.j.penaltyS === 10 && gone.j.big && gone.out.join(',') === 'jump,verdict', `${gone.j.penaltyS} s, ${gone.out.join(',')}`);
  const past = calls([[1 / 60, true, 0, 6], ...many(40, [1 / 60, true, 1.5, 6]), [1 / 60, true, 1.5, 5], [1 / 60, false, 5, 5]]);
  check('past the car ahead before the lights went out: +10 s', past.j.penaltyS === 10 && past.j.big, `${past.j.penaltyS} s`);
  // A car shaking on its springs on the spot (±0.3 m, ±2 m/s) for 13 s: it has gone nowhere
  const shake = new JumpStartWatch();
  let shakeCall: string | null = null;
  for (let i = 0; i < 13 * 60; i++) {
    const phase = Math.sin(i * 0.9);
    shakeCall ??= shake.update(1 / 60, true, 2 * Math.cos(i * 0.9), 6, 5000 + 0.3 * phase, 5340);
  }
  check('a car shaking on its spot through the lights: no jump start', shakeCall === null && !shake.jumped && shake.penaltyS === 0);
  // Measured from the spot round the line: a grid slot 2 m before the line, the car 3 m up the road past it
  const wrap = new JumpStartWatch();
  wrap.update(1 / 60, true, 0, 6, 5338, 5340);
  wrap.update(1 / 60, true, 3, 6, 1, 5340);
  check('the distance from the spot is read across the line', wrap.jumped && wrap.big, `${wrap.penaltyS} s`);
  const back = new JumpStartWatch();
  back.update(1 / 60, true, 0, 6, 100, 5340);
  back.update(1 / 60, true, -1, 6, 97, 5340);
  check('rolling back off the spot is no jump start', !back.jumped);
  const clean = calls([...many(300, [1 / 60, true, 0]), ...many(60, [1 / 60, false, 30])]);
  check('a clean start: no call, no time', clean.out.length === 0 && clean.j.penaltyS === 0);
  check('the clutch out in gear on the throttle pulls away', pullsAway(true, 0, 0.6));
  check('the clutch in, neutral or off the throttle does not', !pullsAway(true, 1, 1) && !pullsAway(false, 0, 1) && !pullsAway(true, 0, 0.1));
}

console.log('\n== Reaction to the lights');
{
  // [lights lit, manual, throttle, clutch] per 1/60 s frame
  type Frame = [boolean, boolean, number, number];
  const many = (n: number, f: Frame): Frame[] => Array.from({ length: n }, () => f);
  const run = (frames: Frame[]) => {
    const w = new ReactionWatch();
    for (const [lit, manual, throttle, clutch] of frames) w.update(1 / 60, lit, manual, throttle, clutch);
    return w.ms;
  };
  const lights = (manual: boolean, throttle: number, clutch: number) => many(120, [true, manual, throttle, clutch]);
  // Assisted: off the throttle through the lights, down 15 frames after they go out (the lights-out frame is frame 0)
  const assisted = run([...lights(false, 0, 0), [false, false, 0, 0], ...many(14, [false, false, 0, 0]), ...many(30, [false, false, 1, 0])]);
  check('assisted: the throttle 15 frames after lights out reads 250 ms', assisted === 250, `${assisted} ms`);
  check('assisted: the throttle held through the lights reads nothing', run([...lights(false, 1, 0), ...many(60, [false, false, 1, 0])]) === null);
  check('assisted: down on the lights-out frame itself reads nothing', run([...lights(false, 0, 0), ...many(60, [false, false, 1, 0])]) === null);
  check('assisted: a press 3.5 s on reads nothing', run([...lights(false, 0, 0), ...many(210, [false, false, 0, 0]), ...many(10, [false, false, 1, 0])]) === null);
  // Manual: clutch in through the lights (the revs up), let out 12 frames after they go out
  const manual = run([...lights(true, 0.8, 1), [false, false, 0.8, 1], ...many(11, [false, false, 0.8, 1]), ...many(30, [false, false, 0.8, 0])]);
  check('manual: the clutch out 12 frames after lights out reads 200 ms', manual === 200, `${manual} ms`);
  check('manual: the clutch let out before the lights reads nothing', run([...lights(true, 0.8, 0), ...many(60, [false, false, 0.8, 0])]) === null);
  check('manual: the revs alone after lights out read nothing', run([...lights(true, 0.8, 1), ...many(60, [false, false, 1, 1])]) === null);
  // The key's clutch eases out over 0.4 s: timed from the first frame it is 10 % out, not from the bite
  const ramp = (n: number): Frame[] => Array.from({ length: n }, (_, i) => [false, false, 0.8, Math.max(0, 1 - (i + 1) / 24)] as Frame);
  const keyed = run([...lights(true, 0.8, 1), [false, false, 0.8, 1], ...many(11, [false, false, 0.8, 1]), ...ramp(30)]);
  check('manual: a key clutch easing out is timed as it starts (233 ms)', keyed === 233, `${keyed} ms`);
  const partial = run([...lights(true, 0.8, 0.7), [false, false, 0.8, 0.7], ...many(11, [false, false, 0.8, 0.7]), ...many(10, [false, false, 0.8, 0.55])]);
  check('manual: a pedal held part-way in is timed off where it was held', partial === 200, `${partial} ms`);
  const w = new ReactionWatch();
  for (const [lit, m, th, cl] of [...lights(false, 0, 0), ...many(20, [false, false, 0, 0] as Frame), ...many(5, [false, false, 1, 0] as Frame)]) w.update(1 / 60, lit, m, th, cl);
  const first = w.ms;
  for (let i = 0; i < 600; i++) w.update(1 / 60, false, false, i % 2, 0);
  check('the reading stands through the race', w.ms === first && first !== null, `${w.ms} ms`);
  w.update(1 / 60, true, false, 0, 0);
  check('and clears with the next start\'s lights', w.ms === null);
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
  check('a manual launch makes a manual start (the start left to the rules)', DEFAULT_RACE_SETUP.startMode === 'auto' && startWith({ launch: 'manual' }));
  check('and from a standing start picked outright', startWith({ launch: 'manual', startMode: 'standing' }));
  check('an assisted launch does not', !startWith({ launch: 'assisted' }));
  check('a rolling start is never a manual one', !startWith({ launch: 'manual', startMode: 'rolling' }));
  check('a flying start (standing forced off) is never a manual one', !startWith({ launch: 'manual' }, false));
  check('the launch is saved with the race setup', parseRaceSetup(JSON.parse(JSON.stringify({ ...DEFAULT_RACE_SETUP, launch: 'manual' }))).launch === 'manual');
  check('an unknown launch reads as assisted', parseRaceSetup({ launch: 'auto' }).launch === 'assisted');
}

// ---- Autopilot engaged before lights out (#149): stays still on the grid (no velocity kick / shake), launches cleanly behind AI
{
  console.log('\n== autopilot standing start (#149)');
  for (const manualStart of [false, true]) {
    const env = new TrackEnvironment(track);
    const player = vehicleModelSpec('mtr-496r').createSim(track, null);
    const field = new AiOpponentField(track, player, aiDriversFor(5), env, { skill: 70, seed: 7 });
    field.playerGrid = 'back';
    field.damageLevel = 'full';
    field.manualStart = manualStart;
    field.startRace(true);
    const p0 = player.worldPosition.clone();
    // Player presses P before lights turn green
    player.aiAutopilot = true;

    let maxLightsSpeedMs = 0;
    let maxLightsMoveM = 0;
    let lightsTicks = 0;
    const stepDt = 1 / 120;
    while (field.phase === 'lights' && lightsTicks < 1200) {
      const held = field.playerFrozen && field.manualStart && !field.gridStanding;
      player.gridHold = held;
      if (!field.playerFrozen || held) player.step(stepDt, {});
      field.update(stepDt);
      maxLightsSpeedMs = Math.max(maxLightsSpeedMs, Math.hypot(player.vxMs, player.vyMs));
      maxLightsMoveM = Math.max(maxLightsMoveM, player.worldPosition.distanceTo(p0));
      lightsTicks++;
    }
    const modeLabel = manualStart ? 'manual' : 'assisted';
    check(
      `autopilot (${modeLabel}): stays still through red lights`,
      field.phase === 'racing' && maxLightsSpeedMs < 0.2 && maxLightsMoveM < 0.05,
      `vMax=${maxLightsSpeedMs.toFixed(3)} m/s, moved=${(maxLightsMoveM * 100).toFixed(1)} cm`
    );

    // Race for 4 s after lights out: must accelerate cleanly behind the AI pack with zero DNF / heavy collision
    player.gridHold = false;
    let maxSpeedKmh = 0;
    for (let i = 0; i < 4 * 120; i++) {
      player.step(stepDt, {});
      field.update(stepDt);
      maxSpeedKmh = Math.max(maxSpeedKmh, player.telemetry.speedKmh);
    }
    const status = field.status();
    const me = status.standings.find((s) => s.isPlayer);
    const anyRetired = status.standings.some((s) => s.retired);
    const maxDmg = status.standings.reduce((m, s) => Math.max(m, s.damage ?? 0), 0);
    check(
      `autopilot (${modeLabel}): clean launch behind AI pack (no crash/DNF)`,
      !anyRetired && maxDmg < 0.05 && me !== undefined && maxSpeedKmh > 80 && player.telemetry.speedKmh > 60,
      `max=${maxSpeedKmh.toFixed(0)} km/h, end=${player.telemetry.speedKmh.toFixed(0)} km/h, retired=${anyRetired}, dmg=${maxDmg.toFixed(2)}`
    );
  }
}

// ---- Forward-offset starting grid (#155, e.g. Istanbul Park where grid boxes sit ~180 m ahead of s = 0)
{
  console.log('\n== forward-offset starting grid (#155)');
  const fwdTrack = createFlatTestTrack(1500, 150);
  const L = fwdTrack.totalLengthM;
  const makeSlot = (slot: number, s: number, lateral: number) => {
    const smp = fwdTrack.getSampleAtDistance(s);
    const pos = smp.position.clone().addScaledVector(smp.binormal, lateral);
    const fwd = smp.tangent.clone().normalize();
    return {
      slot,
      s,
      lateral,
      position: [pos.x, pos.y, pos.z] as [number, number, number],
      yawRad: Math.atan2(fwd.x, fwd.z),
      forward: [fwd.x, fwd.y, fwd.z] as [number, number, number],
    };
  };
  fwdTrack.spawnGrid = [makeSlot(1, 180, 3.0), makeSlot(2, 172, -3.0), makeSlot(3, 164, 3.0), makeSlot(4, 156, -3.0)];

  for (const id of ['f12026-car', 'lc26'] as const) {
    // 1. Standing race start: first crossing of s = 0 finishes Lap 1 without recording a shorter-lap PB or Sector 1 best
    const raceCar = vehicleModelSpec(id).createSim(fwdTrack, null);
    raceCar.autoGearbox = true;
    raceCar.resetToStartGrid(false, 0, undefined, true);
    const startS = raceCar.sMeters;
    const startLap = raceCar.telemetry.lapCount;
    let crossed = false;
    for (let i = 0; i < 60 * 120; i++) {
      raceCar.step(1 / 120, { throttle: 1 });
      if (raceCar.telemetry.lapCount > startLap) {
        crossed = true;
        break;
      }
    }
    check(
      `${id} forward grid (race): spawns at s=180 and completes Lap 1 on first s=0 crossing`,
      Math.abs(startS - 180) < 2 && crossed && raceCar.telemetry.lapCount === 2 && raceCar.telemetry.lastLapValid === false && raceCar.telemetry.bestLapTimeMs === null && raceCar.telemetry.bestSectorTimesMs[0] === null,
      `s0=${startS.toFixed(1)}m, lap=${raceCar.telemetry.lapCount}, lastValid=${raceCar.telemetry.lastLapValid}, best=${raceCar.telemetry.bestLapTimeMs}, bestS1=${raceCar.telemetry.bestSectorTimesMs[0]}`
    );

    // 2. Solo standing start: first crossing of s = 0 starts timed Lap 1 cleanly (out-lap, lapCount stays 1)
    const soloCar = vehicleModelSpec(id).createSim(fwdTrack, null);
    soloCar.autoGearbox = true;
    soloCar.resetToStartGrid(false, 0, undefined, false);
    let prevS = soloCar.sMeters;
    let crossedSolo = false;
    for (let i = 0; i < 60 * 120; i++) {
      soloCar.step(1 / 120, { throttle: 1 });
      if (prevS > L * 0.85 && soloCar.sMeters < L * 0.15) {
        crossedSolo = true;
        break;
      }
      prevS = soloCar.sMeters;
    }
    check(
      `${id} forward grid (solo): first s=0 crossing starts timed Lap 1 cleanly`,
      crossedSolo && soloCar.telemetry.lapCount === 1 && soloCar.telemetry.currentLapTimeMs < 500 && soloCar.telemetry.bestLapTimeMs === null,
      `crossed=${crossedSolo}, lap=${soloCar.telemetry.lapCount}, clock=${soloCar.telemetry.currentLapTimeMs.toFixed(0)}ms`
    );
  }

  // 3. Real Istanbul Park track_data.json (when hosted asset is present locally)
  const istPath = 'public/tracks/istanbul_park/track_data.json';
  if (existsSync(istPath)) {
    const raw = JSON.parse(readFileSync(istPath, 'utf8')) as RawTrackJson;
    setActiveTrack('istanbul_park', raw);
    const ist = getActiveTrackData(1200);
    const slots = ist.spawnGrid;
    const pole = slots[0];
    let monotonic = slots.length === 20;
    let insideRoad = slots.length === 20;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (i > 0 && !(slots[i - 1].s - s.s > 6 && slots[i - 1].s - s.s < 10)) monotonic = false;
      const p = ist.projectWorldToTrack(s.position[0], s.position[2], s.s);
      if (Math.abs(p.lateralOffset) > p.sample.width / 2 - 1.5) insideRoad = false;
    }
    check(
      'Istanbul Park: spawnGrid matches forward grid boxes (P1 ~180 m, 20 slots on road)',
      pole !== undefined && pole.s >= 175 && pole.s <= 185 && monotonic && insideRoad,
      `slots=${slots.length}, P1 s=${pole?.s}m lat=${pole?.lateral}m, P20 s=${slots[slots.length - 1]?.s}m`
    );
    const env = new TrackEnvironment(ist);
    const pCar = vehicleModelSpec('f12026-car').createSim(ist, null);
    const field = new AiOpponentField(ist, pCar, aiDriversFor(5), env, { skill: 70, seed: 3 });
    field.playerGrid = 'front';
    field.startRace(true);
    const st = field.status();
    check(
      'Istanbul Park: AI race standing start orders P1..P6 on forward grid',
      st.standings.length === 6 && Math.abs(pCar.sMeters - pole.s) < 2 && st.standings[0].isPlayer && st.lap === 1,
      `playerS=${pCar.sMeters.toFixed(1)}m, P1isPlayer=${st.standings[0]?.isPlayer}, lap=${st.lap}`
    );
  } else {
    console.log(`SKIP  Istanbul Park forward-grid asset check (${istPath} absent)`);
  }
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nAll race start checks passed.');
process.exit(failures.length ? 1 : 0);
