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
 * 2. An AI race on the page (a steering wheel's): each AI car is drawn carried forward by its own unstepped time. Its
 *    drawn distance each frame must match its speed times the frame's time.
 *
 *   npx tsx scripts/verify/verify-draw-smoothness.ts
 */
import { vehicleModelSpec } from '../../src/lib/cars/vehicle-models';
import { AiOpponentField, aiDriversFor } from '../../src/lib/sim/ai-opponents';
import { createSimHost, loopbackTransport } from '../../src/lib/sim/runtime/sim-host';
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
  const host = createSimHost(loop.transport, () => frameWallMs);
  const car = host.adopt(vehicleModelSpec('f12026-car').createSim(track, null), 'f12026-car');
  setUp(car);
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
  // In a race the worker wakes every 8 ms, late by up to 3 ms
  let seed = 3;
  const late = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 3;
  let wakeMs = 0;
  let nextWakeMs = 8;
  const last = new Map<string, { x: number; y: number; z: number }>();
  let worst = 0;
  let counted = 0;
  for (let f = 1; f <= hz * 22; f++) {
    frameWallMs = f * dt * 1000;
    while (nextWakeMs <= frameWallMs) {
      loop.advance((nextWakeMs - wakeMs) / 1000);
      wakeMs = nextWakeMs;
      nextWakeMs = wakeMs + 8 + late();
    }
    car.step(dt, {});
    host.endFrame(true);
    race.update();
    for (const p of race.peers()) {
      const prev = last.get(p.peerId);
      last.set(p.peerId, { x: p.position.x, y: p.position.y, z: p.position.z });
      const speed = p.linearVelocity.length();
      if (!prev || race.phase !== 'racing' || speed < 30 || p.contact) continue;
      counted++;
      const step = Math.hypot(p.position.x - prev.x, p.position.y - prev.y, p.position.z - prev.z);
      worst = Math.max(worst, Math.abs(step / (speed * dt) - 1));
    }
  }
  check(
    `${hz} Hz: each AI car is drawn moving its speed times the frame's time`,
    race.phase === 'racing' && counted > hz * 10 && worst < 0.05,
    `worst ${(worst * 100).toFixed(1)} % off, ${counted} car-frames above 30 m/s`
  );
  race.dispose();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nThe ghost and the AI cars move with the frame, as the player\'s car does.');
