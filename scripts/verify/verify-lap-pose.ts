/**
 * The lap recording of a car simulated in the worker: its samples are stamped with the telemetry's lap time, so their
 * pose must be the one that telemetry is from (`SimulatorCar.telemetryPose`), not the pose drawn this frame. The drawn
 * pose is carried forward or back to the frame's time (up to 50 ms), and telemetry comes with every other state only;
 * recorded from it, a lap at speed jumped metres between samples and the online board refused it ("Positions imply a
 * speed above 420 km/h").
 *
 * The LC26 drives a lap of RISE Motordrome on autopilot; each step is sent through the worker proxy's view
 * (`CarStateView`) as the worker sends it, and each frame carries the drawn pose by a lead of up to 50 ms either way.
 *
 *   npx tsx scripts/verify/verify-lap-pose.ts
 */
import { getActiveTrackData } from '../../src/lib/track-data';
import { F1Physics2026 } from '../../src/lib/f1-physics-2026';
import { LapRecorder } from '../../src/lib/sim/lap-recorder';
import { lapPhysicsVersion, type LapRecording } from '../../src/lib/sim/lap-types';
import { CarStateView, PAGE_OWNED_TELEMETRY, captureCarState, type CarState } from '../../src/lib/sim/runtime/car-state';
import { checkLap } from '../../cloudflare/api/lap-check';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(70)} ${detail}`);
  if (!ok) failures.push(name);
};

const TRACK = 'rwanda_official_short';
const track = getActiveTrackData();
const car = new F1Physics2026(track);
car.aiAutopilot = true;
const view = new CarStateView({ ...car.telemetry });
let state: CarState | undefined;

const recorder = (driverName: string) =>
  new LapRecorder({ trackLengthM: track.totalLengthM, turns: [], trackId: TRACK, vehicle: 'lc26', driverName, driverCode: 'TST' });
const drawn = recorder('Drawn Pose');
const ticked = recorder('Telemetry Pose');
const conditions = { assists: 'pro', compound: 'medium', surface: 'dry', realism: 'full', physicsVersion: lapPhysicsVersion('lc26', TRACK), autopilot: false } as const;

// A seeded spread of render leads, the worst the proxy allows (±50 ms)
let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

let drawnLap: LapRecording | null = null;
let tickedLap: LapRecording | null = null;
let laps = 0;
let maxGapM = 0;
for (let f = 0, sent = 0; f < 60 * 600 && laps < 2; f++) {
  car.step(1 / 60, {});
  // The worker's state, with its telemetry every other time (sim-runtime.ts `report`)
  state = captureCarState(car, state ?? ({ p: [0, 0, 0], q: [0, 0, 0, 1], wheels: [{}, {}, {}, {}] } as unknown as CarState));
  view.apply(state);
  if (sent++ % 2 === 0) {
    const telemetry: Record<string, unknown> = { ...car.telemetry };
    for (const key of PAGE_OWNED_TELEMETRY) delete telemetry[key];
    view.applyTelemetry(telemetry);
  }
  // The frame draws the car carried to its own time
  view.carryForward((random() * 2 - 1) * 0.05);
  maxGapM = Math.max(maxGapM, view.worldPosition.distanceTo(view.telemetryPose.position));
  const a = drawn.update({ telemetry: view.telemetry, position: view.worldPosition, quaternion: view.worldQuaternion, conditions, input: 'keyboard' });
  const b = ticked.update({ telemetry: view.telemetry, position: view.telemetryPose.position, quaternion: view.telemetryPose.quaternion, conditions, input: 'keyboard' });
  if (a) drawnLap = a.recording;
  if (b) {
    laps++;
    // The second lap is a flying one
    if (laps === 2) tickedLap = b.recording;
  }
}

check('a flying lap completed through the worker view', tickedLap !== null && drawnLap !== null);
check('the drawn pose strays from the telemetry pose (the test bites)', maxGapM > 3, `${maxGapM.toFixed(1)} m`);
if (tickedLap && drawnLap) {
  const fromDrawn = checkLap(drawnLap);
  check('recorded from the drawn pose, the board refuses the lap', !fromDrawn.ok && /420 km\/h/.test(fromDrawn.error), fromDrawn.ok ? 'accepted' : fromDrawn.error);
  const fromTicked = checkLap(tickedLap);
  check('recorded from the telemetry pose, the board takes it', fromTicked.ok, fromTicked.ok ? `${tickedLap.lapTimeMs} ms` : fromTicked.error);
  check('both recordings keep the same lap time', tickedLap.lapTimeMs === drawnLap.lapTimeMs, `${tickedLap.lapTimeMs} / ${drawnLap.lapTimeMs}`);
}

if (failures.length) {
  console.error(`\n${failures.length} failing: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll lap pose checks passed');
