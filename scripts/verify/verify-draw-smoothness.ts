/**
 * The lap ghost and the AI cars move as evenly as the player's car on a 120 Hz and a 240 Hz display.
 *
 * The physics steps in whole 2 ms steps, so a frame runs 2, 2, 2, then 3 of them at 240 Hz. The player's car is drawn
 * carried forward by the time left unstepped (#65); the ghost and the AI cars were not:
 *
 * 1. The ghost is placed by the lap clock. On the page that clock moved in whole steps; from the worker it came with
 *    every other state and was not carried to the frame's time. `drawLapTimeS` is the lap clock carried forward as the
 *    pose is: it must advance by exactly each frame's time, both with the car on the page and in the worker (its wakes
 *    late by up to 3 ms, as a browser's timers are).
 * 2. Laps recorded in the worker before the recorder took the telemetry's own pose have each sample's pose from up to
 *    50 ms after its lap time: played back, the ghost lurched along the track 20 times a second. `steadyGhostData`
 *    moves each pose to its own time; a clean lap must come through as it was.
 * 3. An AI race on the page (a steering wheel's): each AI car is drawn carried forward by its own unstepped time. Its
 *    drawn distance each frame must match its speed times the frame's time. The same for a race in the worker, its
 *    wakes 8 ms apart and late by up to 3 ms.
 *
 *   npx tsx scripts/verify/verify-draw-smoothness.ts
 */
import * as THREE from 'three';
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../../src/lib/sim/ai-opponents';
import { steadyGhostData } from '../../src/lib/sim/lap-recorder';
import type { LapRecording } from '../../src/lib/sim/lap-types';
import { createSimHost, loopbackTransport, type SimTransport } from '../../src/lib/sim/runtime/sim-host';
import type { SimEvent } from '../../src/lib/sim/runtime/sim-protocol';
import { WorkerAiField } from '../../src/lib/sim/runtime/worker-ai-field';
import type { SimulatorCar } from '../../src/lib/sim/simulator-car';
import { TrackEnvironment } from '../../src/lib/sim/track-environment';
import { getActiveTrackData } from '../../src/lib/track-data';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(72)} ${detail}`);
  if (!ok) failures.push(name);
};

const track = getActiveTrackData(1200);
const RATES = [120, 240];

/** The game's set-up of a new car (drive-session's createCar, shortened), on a flying lap */
function setUp(car: SimulatorCar): void {
  car.aiAutopilot = false;
  car.assistPreset = 'semi_pro';
  car.gamepadAssistEnabled = true;
  car.autoGearbox = true;
  car.aeroPreset = 'balanced';
  car.tireCompound = 'medium';
  car.resetToStartGrid(false);
}

const drive = (t: number) => ({ throttle: t < 5 ? 1 : 0.6, brake: 0, analogSteer: 0.03 * Math.sin(t * 0.7) });

/** How far each frame's clock step strays from the frame's time (s): the worst over the run, lap wraps left out */
interface ClockRun {
  drawn: number;
  telemetry: number;
  lapS: number;
}
function worstStray(samples: { dt: number; drawn: number; telemetry: number }[]): ClockRun {
  let drawn = 0;
  let telemetry = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (b.telemetry < a.telemetry || b.drawn < a.drawn) continue;
    drawn = Math.max(drawn, Math.abs(b.drawn - a.drawn - b.dt));
    telemetry = Math.max(telemetry, Math.abs(b.telemetry - a.telemetry - b.dt));
  }
  return { drawn, telemetry, lapS: samples[samples.length - 1].telemetry };
}

console.log('== The ghost clock, the car on the page');
for (const hz of RATES) {
  const car = vehicleModelSpec('f12026-car').createSim(track, null);
  setUp(car);
  const dt = 1 / hz;
  const samples: { dt: number; drawn: number; telemetry: number }[] = [];
  for (let f = 0; f < hz * 8; f++) {
    car.step(dt, drive(f * dt));
    samples.push({ dt, drawn: car.drawLapTimeS ?? NaN, telemetry: car.telemetry.currentLapTimeMs / 1000 });
  }
  const r = worstStray(samples);
  check(
    `${hz} Hz: the drawn lap clock moves on by each frame's time`,
    r.lapS > 5 && r.drawn < 1e-9,
    `worst ${(r.drawn * 1000).toFixed(6)} ms a frame (the telemetry's lap time: ${(r.telemetry * 1000).toFixed(2)} ms), lap clock at ${r.lapS.toFixed(1)} s`
  );
}

console.log('\n== The ghost clock, the car in the worker');
for (const hz of RATES) {
  const loop = loopbackTransport();
  let frameWallMs = 0;
  const host = createSimHost(loop.transport, () => frameWallMs);
  const car = host.adopt(vehicleModelSpec('f12026-car').createSim(track, null), 'f12026-car');
  setUp(car);
  host.endFrame(true);
  const dt = 1 / hz;
  // The worker wakes every 4 ms on its own timer, late by up to 3 ms (fixed pseudo-random)
  let seed = 7;
  const late = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 3;
  let wakeMs = 0;
  let nextWakeMs = 4;
  const samples: { dt: number; drawn: number; telemetry: number }[] = [];
  let remoteFrames = 0;
  for (let f = 1; f <= hz * 8; f++) {
    frameWallMs = f * dt * 1000;
    while (nextWakeMs <= frameWallMs) {
      loop.advance((nextWakeMs - wakeMs) / 1000);
      wakeMs = nextWakeMs;
      nextWakeMs = wakeMs + 4 + late();
    }
    car.step(dt, drive(f * dt));
    host.endFrame(true);
    if (!host.remote) continue;
    remoteFrames++;
    samples.push({ dt, drawn: car.drawLapTimeS ?? NaN, telemetry: car.telemetry.currentLapTimeMs / 1000 });
  }
  // The first frames after the worker takes over are not carried forward yet
  const r = worstStray(samples.slice(3));
  check(
    `${hz} Hz: the drawn lap clock moves on by each frame's time`,
    remoteFrames > hz * 7 && r.lapS > 5 && r.drawn < 1e-6,
    `worst ${(r.drawn * 1000).toFixed(6)} ms a frame (the telemetry's lap time: ${(r.telemetry * 1000).toFixed(2)} ms), lap clock at ${r.lapS.toFixed(1)} s`
  );
}

console.log('\n== A lap recorded from the drawn pose, played back as a ghost');
{
  // A lap's samples as the recorder takes them (20 Hz, the pose of the lap time), from a car stepped on the page
  const car = vehicleModelSpec('f12026-car').createSim(track, null);
  setUp(car);
  const clean: number[] = [];
  const drawn: number[] = [];
  let seed = 19;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let nextT = 0.05;
  for (let f = 0; f < 60 * 30; f++) {
    car.step(1 / 60, drive(f / 60));
    const t = car.telemetry.currentLapTimeMs / 1000;
    if (t < nextT) continue;
    nextT = t + 0.05;
    const p = car.worldPosition;
    const q = car.worldQuaternion;
    const v = car.worldVelocity!;
    const row = [t, car.sMeters, p.x, p.y, p.z, q.x, q.y, q.z, q.w, car.telemetry.speedKmh, 0, 0, 0, car.telemetry.gear];
    clean.push(...row);
    // The worker's drawn pose before the recorder took the telemetry's own: carried forward 4-12 ms, now and then 50
    const lead = rand() < 0.05 ? 0.05 : 0.004 + 0.008 * rand();
    drawn.push(...row.slice(0, 2), p.x + v.x * lead, p.y + v.y * lead, p.z + v.z * lead, ...row.slice(5));
  }
  const lap = (data: number[]): LapRecording =>
    ({ version: 1, trackId: 'test', vehicle: 'f12026-car', driverName: 'T', driverCode: 'TST', lapTimeMs: 30_000, sectorTimesMs: [0, 0, 0], recordedAt: 0, sampleHz: 20, data }) as unknown as LapRecording;
  /** The 95th percentile of how far a sample sits off the line through its neighbours, at speed (m) */
  const jitter = (d: number[]) => {
    const offs: number[] = [];
    for (let i = 1; i < d.length / 14 - 1; i++) {
      const [a, b, c] = [(i - 1) * 14, i * 14, (i + 1) * 14];
      if (d[b + 9] < 100) continue;
      const k = (d[b] - d[a]) / (d[c] - d[a]);
      offs.push(Math.hypot(d[b + 2] - d[a + 2] - (d[c + 2] - d[a + 2]) * k, d[b + 4] - d[a + 4] - (d[c + 4] - d[a + 4]) * k));
    }
    offs.sort((x, y) => x - y);
    return offs[Math.floor(0.95 * (offs.length - 1))];
  };
  const steadied = steadyGhostData(lap(drawn));
  const cleanAgain = steadyGhostData(lap(clean));
  let moved = 0;
  for (let i = 0; i < clean.length; i += 14) moved = Math.max(moved, Math.hypot(cleanAgain[i + 2] - clean[i + 2], cleanAgain[i + 4] - clean[i + 4]));
  check(
    'a drawn-pose lap plays back within a few centimetres of smooth',
    jitter(steadied) < 0.1 && jitter(drawn) > 5 * jitter(steadied),
    `samples off their neighbours' line (p95): ${(jitter(drawn) * 100).toFixed(1)} cm → ${(jitter(steadied) * 100).toFixed(1)} cm (a clean lap: ${(jitter(clean) * 100).toFixed(1)} cm)`
  );
  // (a few centimetres: the recorded speed is not quite the path's, in a corner)
  check('a clean lap plays back as recorded', moved < 0.05, `moved at most ${(moved * 100).toFixed(2)} cm`);
}

console.log('\n== The AI cars in a race on the page');
interface FieldCarView {
  sim: SimulatorCar;
  isPlayer: boolean;
  peer: { position: { x: number; y: number; z: number } };
}
for (const hz of RATES) {
  const env = new TrackEnvironment(track);
  const player = vehicleModelSpec('f12026-car').createSim(track, null);
  const field = new AiOpponentField(track, player, aiDriversFor(3), env, { skill: 80, seed: 11, learning: false });
  field.startRace(true);
  player.aiAutopilot = true;
  const dt = 1 / hz;
  for (let i = 0; i < hz * 12 && field.phase === 'lights'; i++) {
    if (!field.playerFrozen) player.step(dt, {});
    field.update(dt);
  }
  const cars = (field as unknown as { cars: FieldCarView[] }).cars.filter((c) => !c.isPlayer);
  const last = cars.map((c) => ({ drawn: { ...c.peer.position }, raw: c.sim.worldPosition.clone() }));
  let drawnWorst = 0;
  let rawWorst = 0;
  let counted = 0;
  for (let i = 0; i < hz * 10; i++) {
    player.step(dt, {});
    field.update(dt);
    cars.forEach((c, k) => {
      const p = c.peer.position;
      const speed = c.sim.worldVelocity?.length() ?? Math.hypot(c.sim.vxMs, c.sim.vyMs);
      const prev = last[k];
      const drawnStep = Math.hypot(p.x - prev.drawn.x, p.y - prev.drawn.y, p.z - prev.drawn.z);
      const rawStep = c.sim.worldPosition.distanceTo(prev.raw);
      prev.drawn = { ...p };
      prev.raw.copy(c.sim.worldPosition);
      if (speed < 30) return;
      counted++;
      drawnWorst = Math.max(drawnWorst, Math.abs(drawnStep / (speed * dt) - 1));
      rawWorst = Math.max(rawWorst, Math.abs(rawStep / (speed * dt) - 1));
    });
  }
  check(
    `${hz} Hz: each AI car is drawn moving its speed times the frame's time`,
    field.phase === 'racing' && counted > hz * 10 && drawnWorst < 0.05,
    `worst ${(drawnWorst * 100).toFixed(1)} % off (the last whole step: ${(rawWorst * 100).toFixed(0)} %), ${counted} car-frames above 30 m/s`
  );
}

console.log('\n== The AI cars in a race in the worker');
for (const hz of RATES) {
  const loop = loopbackTransport();
  let frameWallMs = 0;
  let wakeMs = 0;
  // In a race the worker wakes every 8 ms, late by up to 3 ms, and its states reach the page 4-11 ms after the wake
  // (the field's work, then the message)
  let seed = 3;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const inbox: { atMs: number; event: SimEvent }[] = [];
  let deliver: ((event: SimEvent) => void) | null = null;
  const transport: SimTransport = {
    post: (command) => loop.transport.post(command),
    listen: (listener) => {
      deliver = listener;
      return loop.transport.listen((event) => inbox.push({ atMs: wakeMs + 4 + 7 * rand(), event }));
    },
    dispose: () => loop.transport.dispose(),
  };
  const arrive = () => {
    inbox.sort((a, b) => a.atMs - b.atMs);
    while (inbox.length && inbox[0].atMs <= frameWallMs) deliver?.(inbox.shift()!.event);
  };
  const host = createSimHost(transport, () => frameWallMs);
  const car = host.adopt(vehicleModelSpec('f12026-car').createSim(track, null), 'f12026-car');
  setUp(car);
  frameWallMs = 20;
  arrive();
  host.endFrame(true);
  const link = host.raceLink();
  if (!link) {
    check(`${hz} Hz: the worker has the car ready for a race`, false);
    continue;
  }
  const env = new TrackEnvironment(track);
  const race = new WorkerAiField(link, env, car, 3, 80, () => car.groundQuery ?? null);
  race.seed = 11;
  race.startRace(true);
  car.aiAutopilot = true;
  const dt = 1 / hz;
  let nextWakeMs = 8;
  const last = new Map<string, THREE.Vector3[]>();
  const playerLast: THREE.Vector3[] = [];
  /** The change of a car's drawn step from the frame before (m): its jolt, sideways and up as well as along */
  const jolt = (h: THREE.Vector3[]) => (h.length < 3 ? null : h[2].clone().sub(h[1]).sub(h[1].clone().sub(h[0])).length());
  const remember = (h: THREE.Vector3[], p: THREE.Vector3) => {
    h.push(p.clone());
    if (h.length > 3) h.shift();
  };
  const aiJolts: number[] = [];
  const playerJolts: number[] = [];
  let worst = 0;
  let counted = 0;
  for (let f = 1; f <= hz * 22; f++) {
    frameWallMs = 20 + f * dt * 1000;
    while (nextWakeMs <= frameWallMs) {
      loop.advance((nextWakeMs - wakeMs) / 1000);
      wakeMs = nextWakeMs;
      nextWakeMs = wakeMs + 8 + 3 * rand();
    }
    arrive();
    car.step(dt, {});
    host.endFrame(true);
    race.update();
    const racing = race.phase === 'racing';
    remember(playerLast, car.worldPosition);
    const pj = jolt(playerLast);
    if (racing && pj !== null && car.vxMs > 30) playerJolts.push(pj);
    for (const p of race.peers()) {
      const h = last.get(p.peerId) ?? [];
      last.set(p.peerId, h);
      remember(h, p.position);
      const speed = p.linearVelocity.length();
      if (h.length < 2 || !racing || speed < 30 || p.contact) continue;
      counted++;
      worst = Math.max(worst, Math.abs(h[h.length - 1].distanceTo(h[h.length - 2]) / (speed * dt) - 1));
      const j = jolt(h);
      if (j !== null) aiJolts.push(j);
    }
  }
  const p99 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(0.99 * (a.length - 1))] ?? NaN;
  check(
    `${hz} Hz: each AI car is drawn moving its speed times the frame's time`,
    race.phase === 'racing' && counted > hz * 10 && worst < 0.05,
    `worst ${(worst * 100).toFixed(1)} % off, ${counted} car-frames above 30 m/s`
  );
  check(
    `${hz} Hz: the AI cars jolt no more than the player's car`,
    p99(aiJolts) <= 1.5 * p99(playerJolts),
    `99th percentile ${(p99(aiJolts) * 1000).toFixed(2)} mm a frame (the player's car: ${(p99(playerJolts) * 1000).toFixed(2)} mm)`
  );
  race.dispose();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nThe ghost and the AI cars move with the frame, as the player\'s car does.');
