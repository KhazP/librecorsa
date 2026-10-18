/**
 * Checks the lap recorder, ghost playback, recording validation and the replay buffer without a browser:
 *   npx tsx scripts/verify-lap-tools.ts
 */
import assert from 'node:assert/strict';
import {
  GhostPlayer,
  LapRecorder,
  lapSampleAt,
  validateLapRecording,
  type CompletedLap,
  type LapRecorderInput,
  type LapRecorderOptions,
  type LapRecorderTurn,
} from '../src/lib/sim/lap-recorder';
import { ReplayBuffer } from '../src/lib/sim/replay-buffer';
import { LAP_SAMPLE_FIELDS, LAP_SAMPLE_STRIDE, type LapRecording, type ReplayCarState } from '../src/lib/sim/lap-types';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// ---- Synthetic track and car -------------------------------------------------------------------

const TRACK_M = 5000;
const SECTOR1_M = TRACK_M / 3;
const SECTOR2_M = (2 * TRACK_M) / 3;
const DT_S = 1 / 60;
const TURNS: LapRecorderTurn[] = [
  { number: 1, name: 'Turn 1', sApprox: 800 },
  { number: 2, name: 'Turn 2', sApprox: 2200 },
  { number: 3, name: 'Turn 3', sApprox: 4000 },
];

/** Speed loss (m/s) from the three corners: 25 m/s at each apex */
function cornerLossMs(s: number): number {
  let loss = 0;
  for (const turn of TURNS) loss += 25 * Math.exp(-(((s - turn.sApprox) / 120) ** 2));
  return loss;
}
/** Car speed (m/s) at distance s with a pace factor: 75 m/s on the straights, 50 f m/s at each apex */
const speedMs = (s: number, pace: number) => pace * (75 - cornerLossMs(s));

interface SimState {
  s: number;
  elapsedMs: number;
  lapCount: number;
  lastLapTimeMs: number | null;
  sectorTimesMs: [number, number, number];
  sector1Ms: number | null;
  sector2Ms: number | null;
}

interface DrivePlan {
  paceFor: (lapCount: number) => number;
  offTrackAt: (lapCount: number, s: number) => boolean;
}

/** Drives frame by frame at 60 Hz, updating the physics-style lap counters, until `untilLapCount` is reached */
function drive(sim: SimState, rec: LapRecorder, untilLapCount: number, plan: DrivePlan): CompletedLap[] {
  const out: CompletedLap[] = [];
  while (sim.lapCount < untilLapCount) {
    const speed = speedMs(sim.s, plan.paceFor(sim.lapCount));
    const loss = cornerLossMs(sim.s);
    const prevS = sim.s;
    sim.s += speed * DT_S;
    sim.elapsedMs += DT_S * 1000;
    if (sim.sector1Ms === null && prevS < SECTOR1_M && sim.s >= SECTOR1_M) sim.sector1Ms = sim.elapsedMs;
    if (sim.sector2Ms === null && prevS < SECTOR2_M && sim.s >= SECTOR2_M) sim.sector2Ms = sim.elapsedMs;
    const offTrack = plan.offTrackAt(sim.lapCount, sim.s);

    if (sim.s >= TRACK_M) {
      // Line crossed: the physics publishes the finished lap's sectors and (for laps over 45 s) its time
      sim.s -= TRACK_M;
      const lapMs = sim.elapsedMs;
      const s1 = sim.sector1Ms ?? lapMs / 3;
      const s2 = sim.sector2Ms ?? (2 * lapMs) / 3;
      sim.sectorTimesMs = [s1, s2 - s1, lapMs - s2];
      if (lapMs > 45_000) sim.lastLapTimeMs = lapMs;
      sim.lapCount++;
      sim.elapsedMs = 0;
      sim.sector1Ms = null;
      sim.sector2Ms = null;
    }

    const telemetry = {
      lapCount: sim.lapCount,
      currentLapTimeMs: sim.elapsedMs,
      lastLapTimeMs: sim.lastLapTimeMs,
      trackDistanceM: sim.s,
      speedKmh: speed * 3.6,
      throttle: loss < 1 ? 1 : loss > 5 ? 0 : 0.5,
      brake: loss > 5 ? 0.8 : 0,
      steering: 0,
      gear: 6,
      offTrack,
      sectorTimesMs: sim.sectorTimesMs,
    };
    const heading = (sim.s / TRACK_M) * 2 * Math.PI;
    const input: LapRecorderInput = {
      telemetry,
      position: { x: sim.s, y: 0, z: 0 },
      quaternion: { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) },
    };
    const done = rec.update(input);
    if (done) out.push(done);
  }
  return out;
}

function makeRecorder(overrides: Partial<LapRecorderOptions> = {}): LapRecorder {
  return new LapRecorder({
    trackLengthM: TRACK_M,
    turns: TURNS,
    trackId: 'test-track',
    vehicle: 'vf26',
    driverName: 'Test Driver',
    driverCode: 'TST',
    ...overrides,
  });
}

/**
 * Pace per lap count: lapCount 0 is the partial lap, then 1..4. Lap 2 goes off the track once.
 * Pace 0 matches lap 1 because the crossing frame still reports the old pace.
 */
const PACE = [0.98, 0.98, 1.03, 1.02, 0.97];
const plan: DrivePlan = {
  paceFor: (k) => PACE[k] ?? 1,
  offTrackAt: (k, s) => k === 2 && s >= 3000 && s < 3030,
};
const sumOf = (a: [number, number, number]) => a[0] + a[1] + a[2];
const STRIDE = LAP_SAMPLE_STRIDE;

// ---- Lap recording -----------------------------------------------------------------------------

console.log('Lap recorder');
const rec = makeRecorder();
// Join the lap 30 s in (currentLapTimeMs starts at 50 s): the first crossing must be dropped
const sim: SimState = { s: 2000, elapsedMs: 50_000, lapCount: 0, lastLapTimeMs: null, sectorTimesMs: [0, 0, 0], sector1Ms: null, sector2Ms: null };
const laps = drive(sim, rec, 4, plan);
const [lap1, lap2, lap3] = laps;

check('mid-lap start: the first crossing is dropped, later laps are returned', () => {
  assert.equal(laps.length, 3);
  assert.deepEqual(laps.map((l) => l.summary.lapNumber), [1, 2, 3]);
});
check('a clean lap: time, sectors, validity and sample count', () => {
  const lapS = lap1.summary.lapTimeMs / 1000;
  assert.ok(lapS > 60 && lapS < 80, `lap time ${lapS}`);
  assert.equal(lap1.recording.lapTimeMs, lap1.summary.lapTimeMs);
  assert.equal(lap1.summary.valid, true);
  assert.equal(lap1.recording.version, 1);
  assert.equal(lap1.recording.trackId, 'test-track');
  assert.equal(lap1.recording.vehicle, 'vf26');
  assert.equal(lap1.recording.sampleHz, 20);
  assert.ok(Math.abs(sumOf(lap1.summary.sectorTimesMs) - lap1.summary.lapTimeMs) <= 2, 'sectors add up to the lap');
  const samples = lap1.recording.data.length / STRIDE;
  assert.ok(Math.abs(samples - lapS * 20) <= 5, `samples ${samples} vs ${lapS * 20}`);
  near(lap1.summary.avgSpeedKmh, (TRACK_M / lapS) * 3.6, 1e-9);
  assert.ok(lap1.summary.topSpeedKmh > 262 && lap1.summary.topSpeedKmh < 266, `top speed ${lap1.summary.topSpeedKmh}`);
  assert.ok(lap1.summary.fullThrottlePct > 0 && lap1.summary.fullThrottlePct < 100);
  assert.ok(lap1.summary.brakingPct > 0 && lap1.summary.brakingPct < 100);
});
check('first valid lap: PB, no delta, no sector or corner bests yet', () => {
  assert.equal(lap1.summary.deltaToBestMs, null);
  assert.equal(lap1.summary.isPersonalBest, true);
  assert.deepEqual(lap1.summary.bestSectorTimesMs, [null, null, null]);
  assert.equal(lap1.summary.theoreticalBestMs, sumOf(lap1.summary.sectorTimesMs));
  assert.equal(lap1.summary.corners.length, 3);
  assert.deepEqual(lap1.summary.corners.map((c) => c.name), ['Turn 1', 'Turn 2', 'Turn 3']);
  near(lap1.summary.corners[0].minSpeedKmh, 50 * 0.98 * 3.6, 1.5);
  assert.equal(lap1.summary.corners[0].bestMinSpeedKmh, null);
});
check('off-track lap is invalid, not a PB, and its delta is still against the PB', () => {
  assert.equal(lap2.summary.valid, false);
  assert.equal(lap2.summary.isPersonalBest, false);
  assert.ok(lap2.summary.lapTimeMs < lap1.summary.lapTimeMs, 'lap 2 is the faster lap');
  assert.equal(lap2.summary.deltaToBestMs, lap2.summary.lapTimeMs - lap1.summary.lapTimeMs);
  assert.ok(lap2.summary.deltaToBestMs! < 0);
});
check('invalid laps do not feed the sector or corner session bests', () => {
  assert.deepEqual(lap2.summary.bestSectorTimesMs, lap1.summary.sectorTimesMs);
  assert.equal(lap2.summary.theoreticalBestMs, sumOf(lap1.summary.sectorTimesMs));
  assert.equal(lap2.summary.corners[0].bestMinSpeedKmh, lap1.summary.corners[0].minSpeedKmh);
});
check('faster valid lap: new PB, delta, sector bests and theoretical best', () => {
  assert.equal(lap3.summary.valid, true);
  assert.equal(lap3.summary.isPersonalBest, true);
  assert.equal(lap3.summary.deltaToBestMs, lap3.summary.lapTimeMs - lap1.summary.lapTimeMs);
  assert.ok(lap3.summary.deltaToBestMs! < 0);
  assert.equal(rec.personalBestMs, lap3.summary.lapTimeMs);
  const bestSectors = lap1.summary.sectorTimesMs.map((v, i) => Math.min(v, lap3.summary.sectorTimesMs[i])) as [number, number, number];
  assert.deepEqual(lap3.summary.bestSectorTimesMs, lap1.summary.sectorTimesMs);
  assert.equal(lap3.summary.theoreticalBestMs, sumOf(bestSectors), 'best of each sector across the valid laps');
  assert.equal(lap3.summary.corners[0].bestMinSpeedKmh, lap1.summary.corners[0].minSpeedKmh);
  near(lap3.summary.corners[0].minSpeedKmh, 50 * 1.02 * 3.6, 1.5);
  assert.ok(lap3.summary.corners[0].minSpeedKmh > lap1.summary.corners[0].minSpeedKmh);
});

console.log('Continuing after a car change');
rec.setContext({ vehicle: 'f12026-car' });
const after = drive(sim, rec, 5, plan);
check('a car change clears session bests but keeps the personal best', () => {
  assert.equal(after.length, 1);
  const lap4 = after[0];
  assert.equal(lap4.recording.vehicle, 'f12026-car');
  assert.deepEqual(lap4.summary.bestSectorTimesMs, [null, null, null]);
  assert.equal(lap4.summary.corners[0].bestMinSpeedKmh, null);
  assert.equal(lap4.summary.isPersonalBest, false);
  assert.equal(lap4.summary.deltaToBestMs, lap4.summary.lapTimeMs - lap3.summary.lapTimeMs);
  assert.equal(lap4.summary.theoreticalBestMs, sumOf(lap4.summary.sectorTimesMs));
});

console.log('Lap bookkeeping edge cases');
const tele = (lapCount: number, currentLapTimeMs: number, lastLapTimeMs: number | null): LapRecorderInput => ({
  telemetry: {
    lapCount,
    currentLapTimeMs,
    lastLapTimeMs,
    trackDistanceM: 0,
    speedKmh: 200,
    throttle: 1,
    brake: 0,
    steering: 0,
    gear: 7,
    offTrack: false,
    sectorTimesMs: [20_000, 20_000, 20_000],
  },
  position: { x: 0, y: 0, z: 0 },
  quaternion: { x: 0, y: 0, z: 0, w: 1 },
});
check('a lap count jump drops the lap and re-arms on the next crossing', () => {
  const r = makeRecorder();
  assert.equal(r.update(tele(0, 0, null)), null); // armed at the start
  assert.equal(r.update(tele(2, 10, 60_000)), null); // jump by two: dropped
  assert.equal(r.update(tele(3, 5, 60_000)), null); // crossing starts an armed lap
  assert.equal(r.update(tele(3, 1000, 60_000)), null);
  const done = r.update(tele(4, 5, 61_000));
  assert.ok(done, 'lap armed at the crossing 2 -> 3 is returned');
  assert.equal(done!.summary.lapTimeMs, 61_000);
  assert.equal(done!.summary.lapNumber, 3);
});
check('a stale lap time (unchanged since the last update) is not taken as a lap', () => {
  const r = makeRecorder();
  r.update(tele(0, 0, null));
  assert.ok(r.update(tele(1, 5, 60_000)) !== null, 'a new lap time is taken');
  assert.equal(r.update(tele(2, 5, 60_000)), null, 'the same lap time again is not');
});
check('reset() before a mid-lap start: the lap is not armed until the line is crossed', () => {
  const r = makeRecorder();
  r.update(tele(0, 0, null));
  r.reset();
  assert.equal(r.update(tele(5, 30_000, 61_000)), null); // not near the start: not armed
  assert.equal(r.update(tele(6, 5, 70_000)), null); // crossing from a mid-lap start is dropped
  assert.ok(r.update(tele(7, 5, 80_000)) !== null, 'the next lap is armed');
});

// ---- Ghost playback ----------------------------------------------------------------------------

console.log('Ghost playback');
const ghost = new GhostPlayer(lap1.recording);
check('ghost lap time and samples match the recording', () => {
  assert.equal(ghost.lapTimeS, lap1.recording.lapTimeMs / 1000);
  assert.equal(LAP_SAMPLE_STRIDE, LAP_SAMPLE_FIELDS.length);
  // Field k of the stored row must unpack to LAP_SAMPLE_FIELDS[k]
  const row: LapRecording = { ...lap1.recording, data: LAP_SAMPLE_FIELDS.map((_, k) => k + 1) };
  const sample = lapSampleAt(row, 0);
  LAP_SAMPLE_FIELDS.forEach((field, k) => assert.equal(sample[field], k + 1, `field ${field}`));
});
check('midway between two samples is the average of both', () => {
  const a = lapSampleAt(lap1.recording, 500);
  const b = lapSampleAt(lap1.recording, 501);
  const mid = ghost.sampleAt((a.t + b.t) / 2);
  assert.ok(mid);
  near(mid!.t, (a.t + b.t) / 2, 1e-9);
  near(mid!.x, (a.x + b.x) / 2);
  near(mid!.y, (a.y + b.y) / 2);
  near(mid!.speedKmh, (a.speedKmh + b.speedKmh) / 2);
  assert.equal(mid!.gear, a.gear);
});
check('interpolated quaternions are normalised', () => {
  for (let i = 0; i < lap1.recording.data.length / STRIDE - 1; i += 97) {
    const a = lapSampleAt(lap1.recording, i);
    const q = ghost.sampleAt((a.t + lapSampleAt(lap1.recording, i + 1).t) / 2)!;
    near(Math.hypot(q.qx, q.qy, q.qz, q.qw), 1, 1e-9);
  }
});
check('a quaternion pair with opposite signs blends the short way', () => {
  const row = (t: number, qw: number) => [t, 0, 0, 0, 0, 0, 0, 0, qw, 100, 0, 0, 0, 6];
  const flipped: LapRecording = {
    version: 1,
    trackId: 't',
    vehicle: 'vf26',
    driverName: 'A',
    driverCode: 'AAA',
    lapTimeMs: 20_000,
    sectorTimesMs: [1, 1, 1],
    recordedAt: 0,
    sampleHz: 20,
    data: [...row(0, 1), ...row(1, -1)],
  };
  const q = new GhostPlayer(flipped).sampleAt(0.5)!;
  near(q.qw, 1);
  near(q.qx, 0);
});
check('clamping and the two-sample minimum', () => {
  assert.equal(ghost.sampleAt(-5)!.t, lapSampleAt(lap1.recording, 0).t);
  const last = lapSampleAt(lap1.recording, lap1.recording.data.length / STRIDE - 1);
  assert.equal(ghost.sampleAt(1e6)!.t, last.t);
  const single: LapRecording = { ...lap1.recording, data: lap1.recording.data.slice(0, STRIDE) };
  assert.equal(new GhostPlayer(single).sampleAt(0.5), null);
});

// ---- Validation --------------------------------------------------------------------------------

console.log('Recording validation');
const json = JSON.parse(JSON.stringify(lap1.recording)) as unknown;
const withPatch = (patch: Record<string, unknown>) => ({ ...(json as Record<string, unknown>), ...patch });
check('a real recording survives a JSON round trip and comes back as a fresh copy', () => {
  const valid = validateLapRecording(json);
  assert.ok(valid, 'accepted');
  assert.deepEqual(valid, lap1.recording);
  assert.notEqual(valid, json);
  assert.notEqual(valid!.data, lap1.recording.data);
});
check('tampered recordings are rejected', () => {
  const data = lap1.recording.data;
  assert.equal(validateLapRecording(withPatch({ driverCode: 'T5' })), null, 'bad code');
  assert.equal(validateLapRecording(withPatch({ driverCode: 'TSTX' })), null, 'long code');
  assert.equal(validateLapRecording(withPatch({ data: data.map((v, i) => (i === 5 ? NaN : v)) })), null, 'NaN in data');
  assert.equal(validateLapRecording(withPatch({ data: data.slice(0, -1) })), null, 'wrong stride');
  assert.equal(validateLapRecording(withPatch({ lapTimeMs: 10_000 })), null, 'lap too short');
  assert.equal(validateLapRecording(withPatch({ lapTimeMs: 1_000_000 })), null, 'lap too long');
  assert.equal(validateLapRecording(withPatch({ lapTimeMs: lap1.recording.lapTimeMs + 5000 })), null, 'end time far from lap time');
  assert.equal(validateLapRecording(withPatch({ version: 2 })), null, 'version');
  assert.equal(validateLapRecording(withPatch({ vehicle: 'bogus' })), null, 'vehicle');
  assert.equal(validateLapRecording(withPatch({ sectorTimesMs: [1, 2] })), null, 'sectors');
  assert.equal(validateLapRecording(withPatch({ sampleHz: 500 })), null, 'sample rate');
  const badTime = data.slice();
  badTime[2 * STRIDE] = -1;
  assert.equal(validateLapRecording(withPatch({ data: badTime })), null, 'time goes backwards');
  assert.equal(validateLapRecording(withPatch({ data: new Array<number>(200_004).fill(0) })), null, 'too many numbers');
  assert.equal(validateLapRecording(null), null);
  assert.equal(validateLapRecording('lap'), null);
});
check('driver code is uppercased and the name is cleaned', () => {
  const valid = validateLapRecording(withPatch({ driverCode: 'tst', driverName: '  <b>Caglar\u0007 Cabaoglu long name</b>  ' }));
  assert.ok(valid);
  assert.equal(valid!.driverCode, 'TST');
  assert.ok(valid!.driverName.length <= 16);
  assert.ok(!/[<>\x00-\x1f]/.test(valid!.driverName), 'no brackets or control characters');
  assert.ok(valid!.driverName.startsWith('bCaglar'));
});

// ---- Replay buffer -----------------------------------------------------------------------------

console.log('Replay buffer');
const car = (id: string, x: number): ReplayCarState => ({
  id,
  x,
  y: 0,
  z: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  speedKmh: x,
  steer: 0,
  throttle: 0,
  brake: 0,
  gear: 3,
  rpm: 8000,
});

check('an empty buffer reports NaN / 0 and no frame', () => {
  const rb = new ReplayBuffer();
  assert.equal(rb.frameCount, 0);
  assert.ok(Number.isNaN(rb.startS) && Number.isNaN(rb.endS));
  assert.equal(rb.durationS, 0);
  assert.equal(rb.frameAt(1), null);
});
check('ring overflow keeps the last 60 s at 30 Hz', () => {
  const rb = new ReplayBuffer({ maxSeconds: 60, hz: 30 });
  for (let i = 0; i < 6000; i++) rb.push(i / 30, [car('a', i)]); // 200 s
  assert.equal(rb.frameCount, 60 * 30 + 1);
  near(rb.durationS, 60, 1e-6);
  near(rb.endS, 5999 / 30, 1e-9);
  assert.equal(rb.frameAt(rb.startS)!.cars[0].x, 4199);
  assert.equal(rb.frameAt(rb.endS)!.cars[0].x, 5999);
});
check('frames closer than 1/hz are dropped; clear() empties the buffer', () => {
  const rb = new ReplayBuffer({ maxSeconds: 10, hz: 30 });
  for (let i = 0; i < 60; i++) rb.push(i / 60, [car('a', i)]); // 60 Hz input, 30 Hz storage
  assert.equal(rb.frameCount, 30);
  rb.clear();
  assert.equal(rb.frameCount, 0);
  assert.ok(Number.isNaN(rb.startS));
});
check('a backwards time is ignored until clear()', () => {
  const rb = new ReplayBuffer();
  rb.push(5, [car('a', 1)]);
  rb.push(4, [car('a', 2)]);
  assert.equal(rb.frameCount, 1);
  assert.equal(rb.startS, 5);
});
check('interpolation: scalars linear, gear from the earlier frame, orientation normalised', () => {
  const rb = new ReplayBuffer();
  rb.push(0, [car('a', 0)]);
  rb.push(1, [car('a', 10)]);
  const mid = rb.frameAt(0.5)!;
  near(mid.t, 0.5);
  near(mid.cars[0].x, 5);
  near(mid.cars[0].speedKmh, 5);
  assert.equal(mid.cars[0].gear, 3);
});
check('orientation interpolates the short way round', () => {
  const rb = new ReplayBuffer();
  const a = { ...car('a', 0), qw: 1 };
  const b = { ...car('a', 0), qw: -1 };
  rb.push(0, [a]);
  rb.push(1, [b]);
  const mid = rb.frameAt(0.5)!.cars[0];
  near(Math.hypot(mid.qx, mid.qy, mid.qz, mid.qw), 1);
  near(mid.qw, 1);
});
check('times outside the buffer are clamped', () => {
  const rb = new ReplayBuffer();
  rb.push(0, [car('a', 0)]);
  rb.push(1, [car('a', 10)]);
  const before = rb.frameAt(-10)!;
  assert.equal(before.t, 0);
  assert.equal(before.cars[0].x, 0);
  const after = rb.frameAt(100)!;
  assert.equal(after.t, 1);
  assert.equal(after.cars[0].x, 10);
  assert.equal(rb.frameAt(Number.NaN), null);
});
check('a car present in one neighbouring frame only is taken from that frame as is', () => {
  const rb = new ReplayBuffer();
  rb.push(0, [car('A', 0), car('B', 100)]);
  rb.push(1, [car('A', 10)]);
  rb.push(2, [car('A', 20), car('C', 50)]);
  const first = rb.frameAt(0.5)!;
  assert.deepEqual(first.cars.map((c) => c.id), ['A', 'B']);
  near(first.cars[0].x, 5);
  assert.equal(first.cars[1].x, 100);
  const second = rb.frameAt(1.5)!;
  assert.deepEqual(second.cars.map((c) => c.id), ['A', 'C']);
  near(second.cars[0].x, 15);
  assert.equal(second.cars[1].x, 50);
});
check('stored frames are copies: caller mutation and returned frames do not leak in', () => {
  const rb = new ReplayBuffer();
  const c = car('a', 1);
  rb.push(0, [c]);
  c.x = 999;
  assert.equal(rb.frameAt(0)!.cars[0].x, 1);
  rb.frameAt(0)!.cars[0].x = 555;
  assert.equal(rb.frameAt(0)!.cars[0].x, 1);
});

console.log(`\n${passed} checks passed`);
