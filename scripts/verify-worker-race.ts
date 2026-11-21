/**
 * An AI race run by the simulation worker (`sim-runtime.ts`, `worker-ai-field.ts`), checked without a worker: the
 * worker's side in this process behind the same messages, every one cloned as `postMessage` clones it
 * (`loopbackTransport`), driven the way drive-session.ts drives it.
 *
 *   npx tsx scripts/verify-worker-race.ts [trackId] [car] [weather]
 *
 * The race must be the race a field on the page runs, stepped the same way (the road, the player's car in two 4 ms
 * ticks, then the field over 8 ms): the same report to the last digit, the player's car where the page's would be.
 * Then what the page sees of it: the lights and the grid hold, the AI cars drawn where the worker has them, the road,
 * the standing, and the race ending when the session leaves it. Last, a race with no seed as the game starts one: the
 * field built ahead in the menus, a standing start, and a rolling restart on the same field.
 */
import { existsSync, readFileSync } from 'node:fs';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../src/lib/sim/ai-opponents';
import { DEFAULT_RACE_SETUP, startAiRace } from '../src/lib/sim/race-setup';
import { createSimHost, loopbackTransport } from '../src/lib/sim/runtime/sim-host';
import { SIM_TICK_S, type SimCommand } from '../src/lib/sim/runtime/sim-protocol';
import { WorkerAiField } from '../src/lib/sim/runtime/worker-ai-field';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { TrackEnvironment } from '../src/lib/sim/track-environment';
import { DEFAULT_SESSION_CONDITIONS, WEATHER_PRESETS, type WeatherPresetId } from '../src/lib/sim/weather';
import { getActiveTrackData, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import type { VehicleModelId } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

const trackId = process.argv[2] ?? 'rwanda_official_short';
const vehicle = (process.argv[3] ?? 'amg-gt3') as VehicleModelId;
const weather = (process.argv[4] ?? 'clear') as WeatherPresetId;
if (!WEATHER_PRESETS.includes(weather)) throw new Error(`unknown weather ${weather}`);
/** Both sides' road: the page's environment, which the worker's race takes its weather from */
const conditions = { ...DEFAULT_SESSION_CONDITIONS, weather };
const OPPONENTS = 3;
const SKILL = 80;
const SEED = 4242;
const RACE_S = 45;

const dataPath = `public/tracks/${trackId}/track_data.json`;
if (!existsSync(dataPath)) {
  console.log(`SKIP  ${trackId}: no track data here (a hosted circuit not downloaded)`);
  process.exit(0);
}
setActiveTrack(trackId, JSON.parse(readFileSync(dataPath, 'utf8')) as RawTrackJson);
const track = getActiveTrackData(1200);
const root = loadGlbGeometry(`public${track.meshUrl}`);

/** The game's set-up of a new car (drive-session's createCar, shortened) */
function setUp(car: SimulatorCar): void {
  car.aiAutopilot = false;
  car.assistPreset = 'semi_pro';
  car.autoGearbox = true;
  car.aeroPreset = 'balanced';
  car.tireCompound = 'medium';
  car.resetToStartGrid(false);
}

/** The field's setup the race starts with (race-setup.ts startAiRace) */
function setUpRace(field: { raceLaps: number; gridOrder: string; playerGrid: string; damageLevel: string; aggressionAdd: number }): void {
  field.raceLaps = 3;
  field.gridOrder = 'qualifying';
  field.playerGrid = 'middle';
  field.damageLevel = 'full';
  field.aggressionAdd = 0.1;
}

// ---- The race on the page, stepped as the worker steps it
const pagePlayer = vehicleModelSpec(vehicle).createSim(track, root);
setUp(pagePlayer);
const pageEnv = new TrackEnvironment(track, conditions);
const pageField = new AiOpponentField(track, pagePlayer, aiDriversFor(OPPONENTS), pageEnv, { skill: SKILL, seed: SEED });
setUpRace(pageField as never);
pageField.startRace(true);
// The player's car drives itself, as a player on autopilot would
pagePlayer.aiAutopilot = true;
const blocks = Math.round(RACE_S / (2 * SIM_TICK_S));
for (let b = 0; b < blocks; b++) {
  pageEnv.update(2 * SIM_TICK_S, pageField.sims());
  for (let t = 0; t < 2; t++) if (!pageField.playerFrozen) pagePlayer.step(SIM_TICK_S, {});
  pageField.update(2 * SIM_TICK_S);
}

// ---- The same race in the worker, through the messages
const loop = loopbackTransport();
const host = createSimHost(loop.transport, loop.wallNowMs);
const twin = vehicleModelSpec(vehicle).createSim(track, root);
const car = host.adopt(twin, vehicle, root);
setUp(car);
host.endFrame(true);
const link = host.raceLink();
check('the worker has the car ready for a race', link !== null);
if (!link) process.exit(1);
const env = new TrackEnvironment(track, conditions);
const race = new WorkerAiField(link, env, car, OPPONENTS, SKILL, () => car.groundQuery ?? null);
race.seed = SEED;
setUpRace(race as never);
race.startRace(true);
car.aiAutopilot = true;
const workerField = loop.runtime.raceField;
check('the worker runs the field round its own car', workerField !== null && workerField.sims().includes(loop.runtime.simulatedCar as SimulatorCar));
check(
  'the circuit tells the worker its AI cars drive plans',
  getActiveTrackMetadata().aiPlans?.[vehicle]?.ok === true && workerField!.aiSlots().every((s) => s.sim.aiPlan != null),
  `${workerField!.aiSlots().length} cars on plans`
);

let sawLights = false;
let frozenOnGrid = true;
let gridPos: number | null = null;
let lightsOutAt = -1;
let peersBefore = 0;
for (let tick = 0; tick < blocks * 2; tick++) {
  // A frame of the game every tick here: the controls (none: the autopilot), the worker's clock, the end of the frame
  car.step(SIM_TICK_S, {});
  loop.advance(SIM_TICK_S);
  host.endFrame(true);
  race.update();
  if (race.phase === 'lights') {
    sawLights ||= race.lightsOn > 0;
    gridPos ??= car.sMeters;
    if (Math.abs(car.sMeters - gridPos) > 0.05) frozenOnGrid = false;
  } else if (lightsOutAt < 0) {
    lightsOutAt = tick * SIM_TICK_S;
    peersBefore = race.peers().length;
  }
}
check('the start lights come on and go out', sawLights && lightsOutAt > 4, `out at ${lightsOutAt.toFixed(2)} s`);
check("the player's car is held on the grid until then", frozenOnGrid && race.phase === 'racing');
check('the worker drives the car the whole race', host.remote);

const sim = loop.runtime.simulatedCar as SimulatorCar;
const pageReport = JSON.stringify(pageField.report());
const workerReport = JSON.stringify(workerField!.report());
check(
  'the worker race reports exactly what the race on the page does',
  pageReport === workerReport,
  pageReport === workerReport ? `${RACE_S} s, ${OPPONENTS + 1} cars, ${weather}, line water ${pageEnv.weather.lineWaterMm.toFixed(2)} mm` : 'reports differ'
);
const dPos = sim.worldPosition.distanceTo(pagePlayer.worldPosition);
check("the player's car ends where it does on the page", dPos === 0 && sim.vxMs === pagePlayer.vxMs, `${(sim.vxMs * 3.6).toFixed(0)} km/h at ${sim.sMeters.toFixed(0)} m, off by ${dPos}`);

// What the page draws: the AI cars where the worker has them (carried a few ms forward at most), the standing, the road
const peers = race.peers();
const slots = workerField!.aiSlots();
let worstM = 0;
for (const p of peers) {
  const slot = slots.find((s) => s.peer.peerId === p.peerId);
  if (slot) worstM = Math.max(worstM, p.position.distanceTo(slot.peer.position));
}
check('every AI car is drawn, where the worker has it', peers.length === OPPONENTS && peersBefore === OPPONENTS && worstM < 0.6, `${peers.length} cars, within ${worstM.toFixed(3)} m`);
const status = race.status();
const expected = workerField!.status();
check('the standing reaches the page', status.standings.length === OPPONENTS + 1 && status.position === expected.position && status.phase === 'racing', `P${status.position} of ${status.fieldSize}`);
check('the road under the car reaches the page', race.playerWetness !== null && race.rubber !== null, `wetness ${race.playerWetness}, rubber ${race.rubber?.toFixed(3)}`);

// A penalty from the page's race control, the skill, and the race ending when the session leaves it
race.playerPenaltyS = 5;
race.update();
race.setSkill(40);
check('a penalty and the skill reach the worker', workerField!.playerPenaltyS === 5 && workerField!.skill === 40);
// Race control's disqualification (track limits): the worker's field takes the player out, and the page sees it
race.playerDisqualified = true;
race.update();
for (let tick = 0; tick < 30; tick++) {
  car.step(SIM_TICK_S, {});
  loop.advance(SIM_TICK_S);
  host.endFrame(true);
  race.update();
}
const dqMe = race.status().results?.find((r) => r.isPlayer);
check(
  'a disqualification reaches the worker and comes back in the result',
  workerField!.playerDisqualified && race.status().phase === 'finished' && dqMe?.dq === true,
  JSON.stringify(dqMe)
);
race.dispose();
check('the race ends in the worker when the session leaves it', loop.runtime.raceField === null);
const sBefore = sim.sMeters;
for (let tick = 0; tick < 250; tick++) {
  car.step(SIM_TICK_S, {});
  loop.advance(SIM_TICK_S);
  host.endFrame(true);
}
check('and its car drives on alone', host.remote && sim.sMeters !== sBefore && race.peers().length === OPPONENTS);

// ---- A race as the game starts one: no seed, the field built ahead, then a rolling restart on the same field
{
  const link2 = host.raceLink();
  check('the worker can run another race', link2 !== null);
  if (!link2) process.exit(1);
  link2.post({ type: 'race', op: 'prepare', opponents: OPPONENTS, skill: SKILL });
  const prepared = loop.runtime.preparedField;
  check('the menus have the worker build the next field ahead', prepared !== null && prepared.aiSlots().length === OPPONENTS);
  const race2 = new WorkerAiField(link2, env, car, OPPONENTS, SKILL, () => car.groundQuery ?? null);
  race2.startRace(true);
  check('the start takes the field built ahead', loop.runtime.raceField === prepared && loop.runtime.preparedField === null);
  let lightsSeen = false;
  let held = true;
  let grid: number | null = null;
  let out = -1;
  for (let tick = 0; tick < 2500; tick++) {
    car.step(SIM_TICK_S, {});
    loop.advance(SIM_TICK_S);
    host.endFrame(true);
    race2.update();
    if (race2.phase === 'lights') {
      lightsSeen ||= race2.lightsOn > 0;
      grid ??= car.sMeters;
      if (Math.abs(car.sMeters - grid) > 0.05) held = false;
    } else if (out < 0) out = tick * SIM_TICK_S;
  }
  check('its lights, the grid hold and the cars drawn', lightsSeen && held && out > 4 && race2.peers().length === OPPONENTS, `out at ${out.toFixed(2)} s`);
  const field = loop.runtime.raceField;
  race2.startRace(false);
  check('a restart takes the field running', loop.runtime.raceField === field && field !== null);
  const s0 = car.sMeters;
  let sawFormation = false;
  let maxPeerBeforeGreenKmh = 0;
  let formationPaceKmh = 0;
  for (let tick = 0; tick < 500; tick++) {
    car.step(SIM_TICK_S, {});
    loop.advance(SIM_TICK_S);
    host.endFrame(true);
    race2.update();
    const st = race2.status();
    if (st.rollingFormation) {
      sawFormation = true;
      formationPaceKmh = st.rollingFormation.paceMs * 3.6;
      for (const p of race2.peers()) maxPeerBeforeGreenKmh = Math.max(maxPeerBeforeGreenKmh, p.speedKmh);
    }
  }
  const moving = race2.peers().every((p) => p.speedKmh > 50);
  check('a rolling restart races at once, the AI cars with it', race2.phase === 'racing' && !race2.playerFrozen && moving && race2.status().standings.length === OPPONENTS + 1, `the player's car ${(car.sMeters - s0).toFixed(0)} m on`);
  check('worker rolling start surfaces formation status and holds formation pace', sawFormation && maxPeerBeforeGreenKmh <= formationPaceKmh + 10, `max ${maxPeerBeforeGreenKmh.toFixed(1)} vs pace ${formationPaceKmh.toFixed(1)} km/h`);
  race2.dispose();
}

// ---- A race asked for before the worker has the car ready (a car change mid-race, a race right after loading): the
// commands wait in the transport as they would in a busy worker's queue
{
  const loop3 = loopbackTransport();
  const queued: SimCommand[] = [];
  let busy = true;
  const host3 = createSimHost(
    { post: (c) => (busy ? queued.push(structuredClone(c)) : loop3.transport.post(c)), listen: loop3.transport.listen, dispose: loop3.transport.dispose },
    loop3.wallNowMs
  );
  const twin3 = vehicleModelSpec(vehicle).createSim(track, root);
  const car3 = host3.adopt(twin3, vehicle, root);
  setUp(car3);
  const link3 = host3.raceLink();
  check('a race can be asked of a car the worker is still making', link3 !== null && !host3.remote);
  if (!link3) process.exit(1);
  const race3 = new WorkerAiField(link3, env, car3, OPPONENTS, SKILL, () => car3.groundQuery ?? null);
  race3.startRace(true);
  const placed = car3.sMeters;
  for (let f = 0; f < 30; f++) {
    car3.step(SIM_TICK_S, { throttle: 1 });
    host3.endFrame(true);
    race3.update();
  }
  check('meanwhile the car waits on the grid, the page not driving it', car3.sMeters === placed && Math.abs(twin3.vxMs) < 1e-6 && !host3.remote, `s ${placed} → ${car3.sMeters}, vx ${twin3.vxMs}, remote ${host3.remote}`);
  busy = false;
  for (const c of queued.splice(0)) loop3.transport.post(c);
  for (let tick = 0; tick < 2000; tick++) {
    car3.step(SIM_TICK_S, {});
    loop3.advance(SIM_TICK_S);
    host3.endFrame(true);
    race3.update();
  }
  check(
    'then the worker takes the car and runs the race',
    host3.remote && loop3.runtime.raceField !== null && race3.phase === 'racing' && race3.peers().length === OPPONENTS,
    `remote ${host3.remote}, field ${loop3.runtime.raceField !== null}, ${race3.phase}, ${race3.peers().length} drawn, ${race3.status().standings.length} in the standing`
  );
  race3.dispose();
}

// ---- A manual start in the worker: held on the grid with the engine live, the clutch the driver's to let out
{
  const link4 = host.raceLink();
  check('the worker can run a race with a manual start', link4 !== null);
  if (!link4) process.exit(1);
  const race4 = new WorkerAiField(link4, env, car, OPPONENTS, SKILL, () => car.groundQuery ?? null);
  // Through the call the menu's Start race makes, with the launch the race setup carries
  startAiRace(race4, { ...DEFAULT_RACE_SETUP, launch: 'manual' }, null);
  check('a manual launch in the race setup reaches the worker field', race4.manualStart);
  car.aiAutopilot = false;
  let grid: number | null = null;
  let held = true;
  let peakRpm = 0;
  let tick = 0;
  for (; tick < 2500 && (race4.phase === 'lights' || grid === null); tick++) {
    car.step(SIM_TICK_S, { throttle: 0.6, clutch: 1 });
    loop.advance(SIM_TICK_S);
    host.endFrame(true);
    race4.update();
    if (race4.phase === 'lights') {
      grid ??= car.sMeters;
      if (Math.abs(car.sMeters - grid) > 0.05) held = false;
      peakRpm = Math.max(peakRpm, car.telemetry.rpm);
    }
  }
  check('through the lights the car stays on its grid spot, its engine revving', held && peakRpm > 3000, `${Math.round(peakRpm)} rpm`);
  // Clutch still held after the lights: the car waits; let out, it goes
  for (let f = 0; f < 60; f++) {
    car.step(SIM_TICK_S, { throttle: 0.6, clutch: 1 });
    loop.advance(SIM_TICK_S);
    host.endFrame(true);
    race4.update();
  }
  const waited = Math.abs(car.sMeters - (grid ?? car.sMeters)) < 0.1;
  for (let f = 0; f < 400; f++) {
    const clutch = Math.max(0, 1 - f / 75);
    car.step(SIM_TICK_S, clutch > 0 ? { throttle: 0.8, clutch } : { throttle: 0.8 });
    loop.advance(SIM_TICK_S);
    host.endFrame(true);
    race4.update();
  }
  check('after the lights the car waits on the clutch, and goes as it comes out', waited && car.sMeters - (grid ?? 0) > 5, `${(car.sMeters - (grid ?? 0)).toFixed(1)} m on`);
  race4.dispose();
}

// ---- Leaving a worker race while autopilot was held on the lights must release speed cap & lane bias (#149)
{
  const link5 = host.raceLink();
  if (link5) {
    const race5 = new WorkerAiField(link5, env, car, OPPONENTS, SKILL, () => car.groundQuery ?? null);
    startAiRace(race5, { ...DEFAULT_RACE_SETUP, launch: 'manual' }, null);
    car.aiAutopilot = true;
    for (let f = 0; f < 40; f++) {
      car.step(SIM_TICK_S, {});
      loop.advance(SIM_TICK_S);
      host.endFrame(true);
      race5.update();
    }
    // Leave race mid-lights back to solo practice with autopilot still active (4 s = 1000 ticks at 250 Hz)
    race5.dispose();
    const sBefore = car.sMeters;
    for (let f = 0; f < 1000; f++) {
      car.step(SIM_TICK_S, {});
      loop.advance(SIM_TICK_S);
      host.endFrame(true);
    }
    const movedM = ((car.sMeters - sBefore) % track.totalLengthM + track.totalLengthM) % track.totalLengthM;
    check(
      'leaving a worker race during lights releases autopilot speed cap & lane bias',
      movedM > 35 && car.telemetry.speedKmh > 80,
      `moved=${movedM.toFixed(1)} m, speed=${car.telemetry.speedKmh.toFixed(0)} km/h`
    );
    car.aiAutopilot = false;
  }
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll worker race checks passed.');
if (failures.length) process.exitCode = 1;
