/**
 * The simulation as the worker runs it (`src/lib/sim/runtime`), checked without a worker: a `SimRuntime` in this
 * process behind the same messages, every one cloned as `postMessage` clones it (`loopbackTransport`).
 *
 *   npx tsx scripts/verify-sim-runtime.ts
 *
 * For every car model: the game sets up and drives its stand-in car as it does the real one, and the simulation's car
 * ends exactly where a car stepped directly with the same controls does. Then the hand-overs: a placement is seen at
 * once, a press is one press, every force-feedback sample arrives once, the clock stops when the game stops driving,
 * and the page takes the car back where the simulation had it.
 */
import * as THREE from 'three';
import { setLc26OnRigidBody } from '../src/lib/cars/lc26-engine';
import { vehicleModelSpec } from '../src/lib/cars/vehicle-models';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { createGroundHit } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { simMode } from '../src/lib/sim/runtime/sim-mode';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { SIM_TICK_S } from '../src/lib/sim/runtime/sim-protocol';
import { createSimHost, loopbackTransport } from '../src/lib/sim/runtime/sim-host';
import type { SimulatorCar } from '../src/lib/sim/simulator-car';
import { getActiveTrackData } from '../src/lib/track-data';
import type { ControlInputs, VehicleModelId } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

const track = getActiveTrackData(1200);
const FRAME_S = 1 / 60;

/** The game's set-up of a new car (drive-session's createCar, shortened) */
function setUp(car: SimulatorCar): void {
  car.aiAutopilot = false;
  car.assistPreset = 'semi_pro';
  car.gamepadAssistEnabled = true;
  car.autoGearbox = true;
  car.aeroPreset = 'balanced';
  car.tireCompound = 'medium';
  car.resetToStartGrid(false);
  const tyres = car.getTyreSetup();
  car.setTyreSetup({ ...tyres });
}

/** A lap's worth of controls as a function of the frame: launch, a lift, steering, braking, a DRS press */
function controls(frame: number): Partial<ControlInputs> {
  const t = frame * FRAME_S;
  return {
    throttle: t < 6 ? 1 : t < 7 ? 0.2 : t < 11 ? 0.8 : 0.3,
    brake: t >= 9 && t < 9.5 ? 0.5 : 0,
    analogSteer: 0.04 * Math.sin(t * 0.9),
    toggleXMode: frame === 200,
  };
}

const yawOf = (q: THREE.Quaternion) => {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(f.x, f.z);
};
const poseOf = (car: SimulatorCar) => [
  car.worldPosition.x,
  car.worldPosition.y,
  car.worldPosition.z,
  car.worldQuaternion.x,
  car.worldQuaternion.y,
  car.worldQuaternion.z,
  car.worldQuaternion.w,
  car.vxMs,
  car.vyMs,
  car.yawRateRadS,
  car.telemetry.rpm,
  ...car.wheels.map((w) => w.spinVel),
];
const worstDifference = (a: number[], b: number[]) => a.reduce((worst, v, i) => Math.max(worst, Math.abs(v - b[i])), 0);

interface Rig {
  host: ReturnType<typeof createSimHost>;
  loop: ReturnType<typeof loopbackTransport>;
  car: SimulatorCar;
  twin: SimulatorCar;
}
function rig(vehicle: VehicleModelId): Rig {
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const twin = vehicleModelSpec(vehicle).createSim(track, null);
  const car = host.adopt(twin, vehicle);
  setUp(car);
  return { host, loop, car, twin };
}
/** One frame of the game: the controls to the car, the simulation's clock, the end of the frame */
function frame(r: Rig, inputs: Partial<ControlInputs>, driving = true): void {
  if (driving) r.car.step(FRAME_S, inputs);
  r.loop.advance(FRAME_S);
  r.host.endFrame(true);
}

console.log('== Each car through the messages, against a car stepped directly');
const MODELS: [string, VehicleModelId, boolean][] = [
  ['LC26', 'lc26', false],
  ['LC26 (rigid-body)', 'lc26', true],
  ['f12026-car', 'f12026-car', false],
  ['AMG GT3', 'amg-gt3', false],
  ['MTR 496R', 'mtr-496r', false],
  ['Liana', 'liana', false],
];
for (const [name, vehicle, rigid] of MODELS) {
  setLc26OnRigidBody(rigid);
  const r = rig(vehicle);
  // The simulation takes the car over before it moves
  r.host.endFrame(true);
  const sim = r.loop.runtime.simulatedCar!;
  if (vehicle === 'lc26') {
    check(
      `${name}: the simulation built the engine the page chose`,
      rigid ? sim instanceof F12026CarSim : sim instanceof F1Physics2026,
      sim.constructor.name
    );
  }

  // The same car set up and stepped directly: whole ticks with each frame's controls
  const direct = vehicleModelSpec(vehicle).createSim(track, null);
  setUp(direct);
  let acc = 0;
  let pressed = false;
  const FRAMES = 60 * 12;
  for (let f = 0; f < FRAMES; f++) {
    const inputs = controls(f);
    frame(r, inputs);
    pressed ||= inputs.toggleXMode === true;
    for (acc += FRAME_S; acc >= SIM_TICK_S; acc -= SIM_TICK_S) {
      direct.step(SIM_TICK_S, pressed ? { ...inputs, toggleXMode: true } : { ...inputs, toggleXMode: false });
      pressed = false;
    }
  }
  check(`${name}: the worker is driving`, r.host.remote);
  const worst = worstDifference(poseOf(sim), poseOf(direct));
  check(`${name}: ends where the directly stepped car does`, worst === 0, worst === 0 ? `${(sim.vxMs * 3.6).toFixed(0)} km/h, ${sim.sMeters.toFixed(0)} m` : `largest difference ${worst.toExponential(2)}`);

  // What the game reads from its stand-in at the next frame: the simulation's car, carried forward by the part of a
  // tick it has not run yet (position with its velocity, heading with its yaw rate)
  r.car.step(FRAME_S, controls(FRAMES));
  const lead = acc;
  const expected = sim.worldPosition.clone().addScaledVector(sim.worldVelocity ?? new THREE.Vector3(), lead);
  const off = r.car.worldPosition.distanceTo(expected);
  // Yaw rate is + to the right, which turns the heading (atan2 of forward x over z, + x being the car's left) down
  const turned = yawOf(r.car.worldQuaternion) - yawOf(sim.worldQuaternion);
  // The direction, against the car itself: one more tick of the directly stepped car turns the same way
  const yawBefore = yawOf(direct.worldQuaternion);
  direct.step(SIM_TICK_S, controls(FRAMES));
  const reallyTurned = yawOf(direct.worldQuaternion) - yawBefore;
  check(
    `${name}: the game reads the simulation's car, carried forward to the frame`,
    off < 1e-9 && // (about the car's own up axis: a rolled or pitched body turns its heading a hair less)
    Math.abs(turned + sim.yawRateRadS * lead) < 1e-9 + 0.02 * Math.abs(sim.yawRateRadS * lead) && (Math.abs(reallyTurned) < 1e-7 || turned * reallyTurned > 0) && r.car.renderLeadS === 0,
    `${(lead * 1000).toFixed(2)} ms forward: ${(sim.vxMs * lead * 1000).toFixed(0)} mm and ${((turned * 180) / Math.PI).toFixed(4)}° (the next tick turns ${((reallyTurned * 180) / Math.PI).toFixed(4)}°)`
  );
  // The whole telemetry comes with every second state: at most a tick behind
  check(`${name}: telemetry reaches the game`, Math.abs(r.car.telemetry.speedKmh - sim.telemetry.speedKmh) < 1 && r.car.telemetry.gear === sim.telemetry.gear, `${r.car.telemetry.speedKmh.toFixed(1)} km/h, gear ${r.car.telemetry.gear}`);
  check(`${name}: the page's own car stood still meanwhile`, Math.abs(r.twin.vxMs) < 0.5 && r.twin.sMeters !== sim.sMeters);
}
setLc26OnRigidBody(false);

console.log('\n== Set-up, placement and hand-over (f12026-car)');
{
  const r = rig('f12026-car');
  r.host.endFrame(true);
  const sim = r.loop.runtime.simulatedCar!;

  // Settings reach the simulation's car, and the game reads them back at once
  r.car.tireCompound = 'hard';
  r.car.assistPreset = 'pro';
  r.car.autoGearbox = false;
  const setup = r.car.getTyreSetup();
  setup.camberDeg = { ...setup.camberDeg, front: setup.camberDeg.front - 0.5 };
  r.car.setTyreSetup(setup);
  check('a setting is read back at once and reaches the simulation', r.car.tireCompound === 'hard' && sim.tireCompound === 'hard' && sim.assistPreset === 'pro' && sim.autoGearbox === false);
  check('a tyre setup reaches the simulation', Math.abs(sim.getTyreSetup().camberDeg.front - r.car.getTyreSetup().camberDeg.front) < 1e-9, `front camber ${sim.getTyreSetup().camberDeg.front.toFixed(1)}°`);

  // A placement: seen at once (from the page's own car), and still there once the simulation's states arrive
  for (let f = 0; f < 120; f++) frame(r, { throttle: 1 });
  const before = r.car.sMeters;
  r.car.teleportToDistance(1000, 30);
  const atOnce = r.car.sMeters;
  frame(r, { throttle: 0.3 });
  frame(r, { throttle: 0.3 });
  check('a teleport is seen at once, never the old position', Math.abs(atOnce - 1000) < 1 && Math.abs(before - 1000) > 50, `${before.toFixed(0)} m → ${atOnce.toFixed(0)} m`);
  check('and the simulation carries on from there', Math.abs(r.car.sMeters - 1001) < 3 && Math.abs(sim.sMeters - r.car.sMeters) < 1, `${r.car.sMeters.toFixed(1)} m`);

  // A paddle: one frame's press is one gear, however many ticks the frame spans
  for (let f = 0; f < 30; f++) frame(r, { throttle: 0.4 });
  const gear = sim.telemetry.gear;
  frame(r, { throttle: 0.4, shiftUp: true });
  for (let f = 0; f < 30; f++) frame(r, { throttle: 0.4 });
  check('a paddle pressed for one frame shifts one gear', sim.telemetry.gear === gear + 1, `gear ${gear} → ${sim.telemetry.gear}`);

  // Force feedback: every 500 Hz sample of the simulation reaches the game once
  let samples = 0;
  const FRAMES = 240;
  for (let f = 0; f < FRAMES; f++) {
    frame(r, { throttle: 0.5, analogSteer: 0.05 });
    samples += r.car.telemetry.ffbSubframeSamples?.length ?? 0;
  }
  const expectedSamples = Math.round((FRAMES * FRAME_S) / 0.002);
  // The frame that takes them comes before the ticks that make the last ones: within one frame's worth
  check('every force-feedback sample arrives once', Math.abs(samples - expectedSamples) <= 10, `${samples} of ${expectedSamples}`);

  // The game stops driving (pause, a menu): the simulation's clock stops with it
  // (the frame that stops driving still runs: the stop goes out at its end)
  frame(r, {}, false);
  const stopped = !r.loop.runtime.running;
  const sBefore = sim.sMeters;
  for (let f = 0; f < 60; f++) frame(r, {}, false);
  check('the clock stops when the game stops driving', stopped && sim.sMeters === sBefore, `${sim.vxMs.toFixed(1)} m/s held`);
  frame(r, { throttle: 0.5 });
  frame(r, { throttle: 0.5 });
  check('and runs again with the next controls', r.loop.runtime.running && sim.sMeters > sBefore);

  // An AI or online race: the page takes the car back, where the simulation had it
  const sHandBack = r.car.sMeters;
  const vHandBack = r.car.vxMs;
  r.host.endFrame(false);
  check('the page takes the car back where the simulation had it', !r.host.remote && Math.abs(r.twin.sMeters - sHandBack) < 1 && Math.abs(r.twin.vxMs - vHandBack) < 1, `${r.twin.sMeters.toFixed(0)} m at ${(r.twin.vxMs * 3.6).toFixed(0)} km/h`);
  const sTwin = r.twin.sMeters;
  r.car.step(FRAME_S, { throttle: 0.5 });
  r.host.endFrame(false);
  check('and drives it itself', r.twin.sMeters > sTwin && r.car.sMeters === r.twin.sMeters && !r.loop.runtime.running);

  // The worker does not take a car on the move (its own has other tyres and fuel by now): only one fresh on the grid
  r.host.endFrame(true);
  const leftAlone = !r.host.remote;
  r.car.resetToStartGrid(false);
  r.host.endFrame(true);
  frame(r, { throttle: 1 });
  frame(r, { throttle: 1 });
  check('the worker takes the car again only from a grid start', leftAlone && r.host.remote && Math.abs(r.car.sMeters - r.loop.runtime.simulatedCar!.sMeters) < 0.5, `${r.car.sMeters.toFixed(1)} m`);

  // A car change: the old car's commands no longer reach the simulation
  const oldCar = r.car;
  const twin2 = vehicleModelSpec('amg-gt3').createSim(track, null);
  const car2 = r.host.adopt(twin2, 'amg-gt3');
  setUp(car2);
  oldCar.tireCompound = 'soft';
  r.host.endFrame(true);
  const sim2 = r.loop.runtime.simulatedCar!;
  check('after a car change the simulation runs the new car, deaf to the old one', sim2.vehicleId === 'amg-gt3' && sim2.tireCompound === 'medium' && r.host.remote, `${sim2.vehicleId}`);
}

console.log('\n== On the circuit\'s own colliders (autopilot)');
// The track mesh loads on the page; its colliders cross to the simulation as data, and the car there drives on them
const root = loadGlbGeometry('public/tracks/rwanda_official/rwanda_official.glb');
for (const [name, vehicle] of [['f12026-car', 'f12026-car'], ['LC26 as it ships', 'lc26']] as const) {
  setLc26OnRigidBody(true);
  const r = rig(vehicle);
  r.car.attachTrackRoot?.(root);
  r.car.resetToStartGrid(true);
  r.car.aiAutopilot = true;
  r.host.endFrame(true);
  const sim = r.loop.runtime.simulatedCar!;
  const direct = vehicleModelSpec(vehicle).createSim(track, null);
  setUp(direct);
  direct.attachTrackRoot?.(root);
  direct.resetToStartGrid(true);
  direct.aiAutopilot = true;
  let acc = 0;
  for (let f = 0; f < 60 * 20; f++) {
    frame(r, {});
    for (acc += FRAME_S; acc >= SIM_TICK_S; acc -= SIM_TICK_S) direct.step(SIM_TICK_S, {});
  }
  check(`${name}: the simulation's car drives on the colliders it was sent`, sim.groundQuery != null && sim.groundQuery !== r.twin.groundQuery && r.host.remote, sim.constructor.name);
  const worst = worstDifference(poseOf(sim), poseOf(direct));
  check(`${name}: and ends where a car stepped directly on the mesh's colliders does`, worst === 0, worst === 0 ? `${(sim.vxMs * 3.6).toFixed(0)} km/h, ${sim.sMeters.toFixed(0)} m` : `largest difference ${worst.toExponential(2)}`);
  // The same car on the track samples' ground ends elsewhere: the colliders are what it drove on
  const flat = vehicleModelSpec(vehicle).createSim(track, null);
  setUp(flat);
  flat.resetToStartGrid(true);
  flat.aiAutopilot = true;
  for (let t = 0; t < 20 - 1e-9; t += SIM_TICK_S) flat.step(SIM_TICK_S, {});
  check(`${name}: (a car on the track samples' ground ends elsewhere)`, worstDifference(poseOf(flat), poseOf(direct)) > 1e-3);

  if (vehicle === 'lc26') {
    // The kerbs' blocks (the circuit's surface table, read off the kerb meshes' texture coordinates) are the same under
    // the simulation's car as under the page's: every kerb the track data flags, 0.7 m out from the road's edge
    const here = r.twin.groundQuery!;
    const there = sim.groundQuery!;
    const a = createGroundHit();
    const b = createGroundHit();
    let kerbs = 0;
    let differ = 0;
    let blocks = 0;
    let tallest = 0;
    for (const smp of track.samples) {
      for (const side of [-1, 1]) {
        if (!(side < 0 ? smp.kerbLeft : smp.kerbRight)) continue;
        const reach = side * (smp.width / 2 + 0.7);
        for (let along = 0; along < 1; along += 0.1) {
          const x = smp.position.x + smp.binormal.x * reach + smp.tangent.x * along;
          const z = smp.position.z + smp.binormal.z * reach + smp.tangent.z * along;
          if (!here.query(x, z, smp.position.y + 3, a) || a.surface !== 'kerb') continue;
          kerbs++;
          if (!there.query(x, z, smp.position.y + 3, b) || b.surface !== 'kerb' || b.height !== a.height) differ++;
          if (b.props.bumpRise > 0) blocks++;
          // (the hump alone is a smooth 3 cm; a block's crest stands out against the next sample 10 cm on)
          tallest = Math.max(tallest, b.props.bumpHeightM);
        }
      }
    }
    check("the kerbs' blocks reach the simulation's ground: the same height under both cars at every kerb probed",
      kerbs > 2000 && differ === 0 && blocks === kerbs && tallest === 0.016, `${kerbs} points, ${differ} differ, blocks of ${(tallest * 1000).toFixed(0)} mm`);
  }
}

console.log('\n== Where the simulation runs');
{
  const g = globalThis as { window?: unknown; localStorage?: unknown; Worker?: unknown };
  const kept = new Map<string, string>();
  const inBrowser = (search: string, stored?: string, workers = true) => {
    kept.clear();
    if (stored) kept.set('librecorsa.simMode', stored);
    const had = g.Worker;
    g.window = { location: { search } };
    g.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    g.Worker = workers ? class {} : undefined;
    const out = { mode: simMode(), kept: kept.get('librecorsa.simMode') };
    delete g.window;
    delete g.localStorage;
    g.Worker = had;
    return out;
  };
  check('in the worker, in a browser that never chose', inBrowser('').mode === 'worker' && inBrowser('', 'worker').mode === 'worker');
  const asked = inBrowser('?sim=main');
  const back = inBrowser('?sim=worker', 'main');
  check('on the page when asked for in the address, kept for the browser, and undone the same way',
    asked.mode === 'main' && asked.kept === 'main' && inBrowser('', 'main').mode === 'main' && back.mode === 'worker' && back.kept === 'worker');
  check('on the page where there are no workers, and off the browser', inBrowser('', undefined, false).mode === 'main' && simMode() === 'main');
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll simulation-runtime checks passed.');
