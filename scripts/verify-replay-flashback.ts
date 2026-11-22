/**
 * Verifies Flashback / Rewind (#145):
 *   1. Strict mode gating (`canFlashback` + `isInOnlineRoom`): allowed ONLY in solo Practice and active regular AI races;
 *      rejected in online rooms/races, Weekly Challenge (Time Trial & AI race), Qualifying, and AI start/finish phases.
 *   2. ReplayBuffer truncation (`truncateAfter`) and kinematic pose extraction (`poseFromReplayCar`).
 *   3. Practice flashback end-to-end: restores car pose/speed, truncates replay buffer, invalidates current lap just like
 *      going off-track (telemetry.lapInvalid, TrackLimitsMonitor banner, LapRecorder valid=false / never PB), next clean lap valid.
 *   4. AI race flashback end-to-end: restores player & AI cars together without teleport glitches, rewinds LapClock cleanly,
 *      invalidates player's current lap in telemetry and LapClock (never records bestLapMs), preserves race penalties.
 *
 * Run: npx tsx scripts/verify-replay-flashback.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { getActiveTrackData, type RawTrackJson } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { AI_DRIVERS, AiOpponentField } from '../src/lib/sim/ai-opponents';
import { CarDamage } from '../src/lib/sim/car-damage';
import { LapClock } from '../src/lib/sim/race-session';
import { LapRecorder, type CompletedLap, type LapRecorderInput } from '../src/lib/sim/lap-recorder';
import { TrackLimitsMonitor } from '../src/lib/sim/track-limits';
import { YellowPassJudge } from '../src/lib/sim/yellow-passes';
import { createRemoteCar } from '../src/lib/sim/runtime/remote-car';
import { SimRuntime } from '../src/lib/sim/runtime/sim-runtime';
import type { SimCommand, SimEvent } from '../src/lib/sim/runtime/sim-protocol';
import { SIM_REALISM_FLAGS } from '../src/lib/sim/sim-realism';
import { WeatherState } from '../src/lib/sim/weather';
import {
  canFlashback,
  isInOnlineRoom,
  poseFromReplayCar,
  ReplayBuffer,
} from '../src/lib/sim/replay-buffer';
import type { ReplayCarState } from '../src/lib/sim/lap-types';
import type { FieldCarRestorePose } from '../src/lib/sim/ai-race';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b} (eps=${eps})`);

console.log('1. Flashback mode gating');
check('solo Practice allows flashback', () => {
  assert.equal(
    canFlashback({
      raceKind: 'practice',
      weeklyChallengeRace: false,
      timeTrialActive: false,
      qualifyingActive: false,
      inOnlineRoom: false,
    }),
    true
  );
});

check('regular AI race allows flashback only while racing (rejected on lights / finished)', () => {
  assert.equal(
    canFlashback({
      raceKind: 'ai',
      weeklyChallengeRace: false,
      timeTrialActive: false,
      qualifyingActive: false,
      inOnlineRoom: false,
      aiRacePhase: 'racing',
    }),
    true
  );
  assert.equal(canFlashback({ raceKind: 'ai', aiRacePhase: 'lights' }), false, 'rejected during start lights');
  assert.equal(canFlashback({ raceKind: 'ai', aiRacePhase: 'finished' }), false, 'rejected after chequered flag');
});

check('Online multiplayer race and online rooms strictly disallow flashback', () => {
  assert.equal(canFlashback({ raceKind: 'mp' }), false, 'online MP race');
  assert.equal(canFlashback({ raceKind: 'practice', inOnlineRoom: true }), false, 'practice in online room');
  assert.equal(canFlashback({ raceKind: 'ai', aiRacePhase: 'racing', inOnlineRoom: true }), false, 'online room active');

  // isInOnlineRoom covers all room states and remote peers on track
  assert.equal(
    isInOnlineRoom({ mode: 'local', roomCode: '', state: 'idle', connectedWebRtcPeers: 0 }, 0),
    false,
    'solo offline default'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'room_guest', roomCode: '', state: 'error', connectedWebRtcPeers: 0 }, 0),
    false,
    'after failed join error, solo practice works again'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'room_host', roomCode: 'ABCD', state: 'signaling', connectedWebRtcPeers: 0 }, 0),
    true,
    'hosting a room'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'room_guest', roomCode: 'ABCD', state: 'connected', connectedWebRtcPeers: 1 }, 0),
    true,
    'joined a room'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'race_server', roomCode: '', state: 'connected', connectedWebRtcPeers: 0 }, 0),
    true,
    'race server room'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'local', roomCode: '', state: 'connected', connectedWebRtcPeers: 0 }, 0),
    true,
    'local multi-tab room host'
  );
  assert.equal(
    isInOnlineRoom({ mode: 'local', roomCode: '', state: 'idle', connectedWebRtcPeers: 0 }, 1),
    true,
    'remote peer on track'
  );
});

check('Weekly Challenge (Time Trial & Weekly AI race) and Qualifying strictly disallow flashback', () => {
  assert.equal(canFlashback({ raceKind: 'practice', timeTrialActive: true }), false, 'Weekly Challenge Time Trial');
  assert.equal(
    canFlashback({ raceKind: 'ai', weeklyChallengeRace: true, aiRacePhase: 'racing' }),
    false,
    'Weekly Challenge AI race'
  );
  assert.equal(canFlashback({ raceKind: 'practice', qualifyingActive: true }), false, 'Qualifying session');
});

console.log('2. ReplayBuffer truncation & pose extraction');
check('truncateAfter drops strictly newer frames and allows coherent re-recording', () => {
  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 10 });
  const makeCar = (id: string, x: number, s: number, distM: number): ReplayCarState => ({
    id,
    x,
    y: 0,
    z: x * 2,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    speedKmh: 180,
    steer: 0,
    throttle: 1,
    brake: 0,
    gear: 4,
    rpm: 11000,
    s,
    lap: 1,
    distM,
  });
  for (let i = 0; i <= 50; i++) {
    const t = i * 0.1;
    buf.push(t, [makeCar('player', i, i * 5, i * 5)]);
  }
  assert.equal(buf.frameCount, 51);
  near(buf.endS, 5.0);

  // Truncate at t = 2.5s
  buf.truncateAfter(2.5);
  assert.equal(buf.frameCount, 26);
  near(buf.endS, 2.5);
  const f = buf.frameAt(2.5);
  assert.ok(f);
  near(f.cars[0].x, 25);
  near(f.cars[0].s!, 125);
  near(f.cars[0].distM!, 125);

  // Subsequent new frames push cleanly forward from 2.5s
  buf.push(2.6, [makeCar('player', 999, 130, 130)]);
  assert.equal(buf.frameCount, 27);
  near(buf.endS, 2.6);
  near(buf.frameAt(2.6)!.cars[0].x, 999);
});

check('poseFromReplayCar matches THREE quaternion forward heading', () => {
  for (const yaw of [-2.4, -0.7, 0, 0.85, 2.9]) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const car: ReplayCarState = {
      id: 'player',
      x: 12.5,
      y: 0.4,
      z: -34.2,
      qx: q.x,
      qy: q.y,
      qz: q.z,
      qw: q.w,
      speedKmh: 216,
      steer: 0,
      throttle: 1,
      brake: 0,
      gear: 5,
      rpm: 11500,
      s: 420,
    };
    const pose = poseFromReplayCar(car);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    near(pose.yawRad, Math.atan2(fwd.x, fwd.z), 1e-5);
    near(pose.speedMs, 60, 1e-5);
    near(pose.x, 12.5);
    near(pose.z, -34.2);
    assert.equal(pose.s, 420);
  }
});

console.log('3. Practice Flashback end-to-end (car physics + TrackLimitsMonitor + LapRecorder)');
check('Practice flashback restores car state, truncates buffer, and invalidates current lap like off-track', () => {
  const track = getActiveTrackData(1200);
  const car = new F12026CarSim(track);
  car.resetToStartGrid(true);
  car.aiAutopilot = true;

  const trackLimits = new TrackLimitsMonitor();
  trackLimits.reset('practice');
  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 30 });

  // Drive past the start/finish line into a timed lap (lapCount === 0, lineCrossingStartsLap === false)
  let tS = 0;
  const dt = 1 / 60;
  for (let i = 0; i < 60 * 8; i++) {
    car.step(dt, {});
    tS += dt;
    if (car.telemetry.currentLapTimeMs > 2000 && car.sMeters > 200 && car.sMeters < 1000) break;
  }
  assert.equal(car.telemetry.lapInvalid, false, 'clean timed lap before flashback');

  // Record 3 seconds of driving into the replay buffer
  const recordStartT = tS;
  let targetT = 0;
  let targetS = 0;
  let targetX = 0;
  let targetZ = 0;
  for (let i = 0; i < 60 * 3; i++) {
    car.step(dt, {});
    tS += dt;
    if (i % 2 === 0) {
      buf.push(tS, [
        {
          id: 'player',
          x: car.worldPosition.x,
          y: car.worldPosition.y,
          z: car.worldPosition.z,
          qx: car.worldQuaternion.x,
          qy: car.worldQuaternion.y,
          qz: car.worldQuaternion.z,
          qw: car.worldQuaternion.w,
          speedKmh: car.telemetry.speedKmh,
          steer: car.steerAngleNorm,
          throttle: car.telemetry.throttle,
          brake: car.telemetry.brake,
          gear: car.telemetry.gear,
          rpm: car.telemetry.rpm,
          s: car.sMeters,
          lap: car.telemetry.lapCount,
        },
      ]);
    }
    if (i === 60) {
      targetT = tS;
      targetS = car.sMeters;
      targetX = car.worldPosition.x;
      targetZ = car.worldPosition.z;
    }
  }
  assert.ok(car.sMeters > targetS + 30, 'car moved forward past flashback point');
  assert.ok(buf.endS > targetT + 1.5, 'buffer has frames after flashback point');

  // Trigger flashback to targetT (mirroring DriveSession.flashbackReplay)
  const frame = buf.frameAt(targetT);
  assert.ok(frame);
  const recorded = frame.cars.find((c) => c.id === 'player')!;
  car.invalidateLap();
  car.restorePose(poseFromReplayCar(recorded));
  car.invalidateLap();
  trackLimits.noteFlashback(1000);
  buf.truncateAfter(targetT);

  // Verify car pose & speed restored cleanly
  assert.ok(Math.hypot(car.worldPosition.x - targetX, car.worldPosition.z - targetZ) < 1.5, 'car position restored near target');
  assert.ok(Math.abs(car.sMeters - targetS) < 3.0, 'car track sMeters restored near target');
  assert.ok(car.vxMs > 10, 'car restored rolling at speed');

  // Verify replay buffer truncated cleanly
  assert.ok(buf.endS <= targetT + 1e-4, 'buffer truncated at flashback time');
  assert.ok(buf.startS >= recordStartT - 1e-4, 'earlier replay frames preserved');

  // Verify lap invalidation matches off-track cut
  assert.equal(car.telemetry.lapInvalid, true, 'telemetry.lapInvalid is true after flashback');
  const tlSnap = trackLimits.snapshot(1200);
  assert.equal(tlSnap.message?.kind, 'lap_invalid', 'TrackLimitsMonitor posts lap_invalid banner');
});

check('LapRecorder marks a flashback lap invalid (never PB / leaderboard) while next clean lap counts', () => {
  const TRACK_M = 5000;
  const rec = new LapRecorder({
    trackId: 'test-circuit',
    trackLengthM: TRACK_M,
    vehicle: 'lc26',
    driverName: 'TEST',
    driverCode: 'TST',
    turns: [{ number: 1, name: 'Turn 1', sApprox: 1500 }],
  });

  const runLap = (lapCount: number, lapMs: number, flashbackMidLap: boolean): CompletedLap | null => {
    let completed: CompletedLap | null = null;
    const steps = 600;
    let lapInvalid = false;
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      if (flashbackMidLap && i === 300) {
        lapInvalid = true;
        rec.invalidateCurrentLap();
      }
      const crossing = i === steps;
      const input: LapRecorderInput = {
        position: { x: frac * 1000, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        telemetry: {
          lapCount: crossing ? lapCount + 1 : lapCount,
          currentLapTimeMs: crossing ? 10 : frac * lapMs,
          lastLapTimeMs: crossing ? lapMs : null,
          trackDistanceM: crossing ? 2 : frac * TRACK_M,
          speedKmh: 220,
          throttle: 1,
          brake: 0,
          steering: 0,
          gear: 6,
          offTrack: false,
          sectorTimesMs: [lapMs / 3, lapMs / 3, lapMs / 3],
          lapInvalid: crossing ? false : lapInvalid,
          lastLapValid: crossing ? !lapInvalid : undefined,
          runId: 0,
        },
      };
      const done = rec.update(input);
      if (done) completed = done;
    }
    return completed;
  };

  // Lap 0: uses flashback mid-lap (even though very fast 70s) -> invalid, never PB
  const lap0 = runLap(0, 70_000, true);
  assert.ok(lap0, 'flashback lap finishes and produces a summary');
  assert.equal(lap0.summary.valid, false, 'flashback lap is marked invalid');
  assert.equal(lap0.summary.isPersonalBest, false, 'flashback lap is never personal best');
  assert.equal(rec.personalBestMs, null, 'PB stays null after invalidated flashback lap');

  // Lap 1: clean lap (75s) -> valid, sets PB
  const lap1 = runLap(1, 75_000, false);
  assert.ok(lap1, 'clean lap finishes');
  assert.equal(lap1.summary.valid, true, 'next clean lap is valid');
  assert.equal(lap1.summary.isPersonalBest, true, 'next clean lap becomes PB');
  assert.equal(rec.personalBestMs, 75_000, 'PB set to clean lap time');

  // Lap 2: faster lap (68s) with flashback -> invalid, must NOT overwrite 75s PB
  const lap2 = runLap(2, 68_000, true);
  assert.ok(lap2);
  assert.equal(lap2.summary.valid, false, 'second flashback lap invalid');
  assert.equal(lap2.summary.isPersonalBest, false, 'faster flashback lap cannot beat clean PB');
  assert.equal(rec.personalBestMs, 75_000, 'clean PB preserved');
});

console.log('4. AI Race Flashback end-to-end (player + AI field + LapClock)');
check('AI race flashback rewinds player & AI cars consistently without teleport glitches and invalidates lap', () => {
  const track = getActiveTrackData(1200);
  const player = new F12026CarSim(track);
  const field = new AiOpponentField(track, player, AI_DRIVERS.slice(0, 3), undefined, { skill: 75, seed: 42 });
  field.raceLaps = 3;
  field.startRace(false); // rolling start -> phase === 'racing'
  assert.equal(field.phase, 'racing');
  player.aiAutopilot = true;

  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 30 });
  const trackLimits = new TrackLimitsMonitor();
  trackLimits.reset('race');

  let tS = 0;
  const dt = 1 / 60;
  let snapshotT = 0;
  const snapshotPoses = new Map<string, { x: number; z: number; s: number }>();

  for (let i = 0; i < 60 * 4; i++) {
    player.step(dt, {});
    field.update(dt);
    tS += dt;
    if (i % 2 === 0) {
      const status = field.status();
      const peers = field.peers();
      const playerDistM = status.standings.find((st) => st.isPlayer)?.raceDistM;
      const cars: ReplayCarState[] = [
        {
          id: 'player',
          x: player.worldPosition.x,
          y: player.worldPosition.y,
          z: player.worldPosition.z,
          qx: player.worldQuaternion.x,
          qy: player.worldQuaternion.y,
          qz: player.worldQuaternion.z,
          qw: player.worldQuaternion.w,
          speedKmh: player.telemetry.speedKmh,
          steer: player.steerAngleNorm,
          throttle: player.telemetry.throttle,
          brake: player.telemetry.brake,
          gear: player.telemetry.gear,
          rpm: player.telemetry.rpm,
          s: player.sMeters,
          lap: player.telemetry.lapCount,
          ...(playerDistM !== undefined ? { distM: playerDistM } : {}),
        },
      ];
      for (const p of peers) {
        const peerDistM = status.standings.find((st) => !st.isPlayer && st.driverCode === p.driverCode)?.raceDistM;
        cars.push({
          id: p.peerId,
          x: p.position.x,
          y: p.position.y,
          z: p.position.z,
          qx: p.quaternion.x,
          qy: p.quaternion.y,
          qz: p.quaternion.z,
          qw: p.quaternion.w,
          speedKmh: p.speedKmh,
          steer: 0,
          throttle: p.throttle,
          brake: p.brake,
          gear: 0,
          rpm: 0,
          s: p.trackS,
          ...(peerDistM !== undefined ? { distM: peerDistM } : {}),
        });
      }
      buf.push(tS, cars);
    }
    if (i === 90) {
      snapshotT = tS;
      snapshotPoses.set('player', { x: player.worldPosition.x, z: player.worldPosition.z, s: player.sMeters });
      for (const p of field.peers()) snapshotPoses.set(p.peerId, { x: p.position.x, z: p.position.z, s: p.trackS });
    }
  }

  const timeBeforeRewind = field.timeS;
  const rewindS = tS - snapshotT;
  assert.ok(rewindS > 2.0, 'drove at least 2s past snapshot');

  // Execute flashback (mirroring DriveSession.flashbackReplay)
  const frame = buf.frameAt(snapshotT)!;
  const playerRec = frame.cars.find((c) => c.id === 'player')!;
  player.invalidateLap();
  player.restorePose(poseFromReplayCar(playerRec));
  player.invalidateLap();
  const fieldPoses: FieldCarRestorePose[] = frame.cars.map((c) => {
    const p = poseFromReplayCar(c);
    return {
      id: c.id,
      x: c.x,
      y: c.y,
      z: c.z,
      qx: c.qx,
      qy: c.qy,
      qz: c.qz,
      qw: c.qw,
      yawRad: p.yawRad,
      speedMs: p.speedMs,
      ...(c.s !== undefined ? { s: c.s } : {}),
      ...(c.distM !== undefined ? { distM: c.distM } : {}),
    };
  });
  field.restoreField(fieldPoses, rewindS);
  trackLimits.noteFlashback(5000);
  buf.truncateAfter(snapshotT);

  // Verify race time rewound cleanly
  near(field.timeS, timeBeforeRewind - rewindS, 0.05);

  // Verify player AND every AI car returned to snapshot poses (no teleport discrepancy)
  const pSnap = snapshotPoses.get('player')!;
  assert.ok(Math.hypot(player.worldPosition.x - pSnap.x, player.worldPosition.z - pSnap.z) < 2.0, 'player restored');
  for (const peer of field.peers()) {
    const expected = snapshotPoses.get(peer.peerId);
    assert.ok(expected, `AI peer ${peer.peerId} in snapshot`);
    const dist = Math.hypot(peer.position.x - expected.x, peer.position.z - expected.z);
    assert.ok(dist < 2.5, `AI peer ${peer.peerId} restored cleanly (err=${dist.toFixed(2)}m)`);
  }

  // Verify player's lap invalidated in telemetry
  assert.equal(player.telemetry.lapInvalid, true, 'AI race player telemetry.lapInvalid is true');
  assert.equal(trackLimits.snapshot(5100).message?.kind, 'lap_invalid', 'race control shows lap_invalid');

  // Verify stepping forward 1 second after flashback is finite and glitch-free
  for (let i = 0; i < 60; i++) {
    player.step(dt, {});
    field.update(dt);
  }
  assert.ok(Number.isFinite(player.worldPosition.x) && Number.isFinite(player.vxMs), 'player physics finite after flashback');
  for (const peer of field.peers()) {
    assert.ok(Number.isFinite(peer.position.x) && Number.isFinite(peer.speedKmh), `AI ${peer.peerId} finite after flashback`);
  }
});

check('LapClock ignores invalidated flashback lap for bestLapMs, then counts next clean lap', () => {
  const L = 5000;
  const clock = new LapClock(L);
  clock.reset(0);
  // Drive to 4000m at t=60s
  clock.update(2000, 30, 3);
  clock.update(4000, 60, 3);
  // Flashback back to 3000m at t=45s and invalidate current lap
  clock.invalidateCurrentLap();
  clock.rewindTo(3000, 45, 3000);
  near(clock.distM, 3000);
  assert.equal(clock.lapsDone, 0);
  // Finish lap 1 at t=70s -> invalidated, must NOT set bestLapMs
  clock.update(4500, 62, 3);
  clock.update(100, 70, 3);
  assert.equal(clock.lapsDone, 1);
  assert.equal(clock.bestLapMs, null, 'invalidated flashback lap did not set bestLapMs');
  assert.equal(clock.lastLapMs, 70_000, 'lastLapMs still recorded for timing display');
  // Drive clean lap 2 -> sets bestLapMs
  clock.update(2500, 105, 3);
  clock.update(4800, 140, 3);
  clock.update(50, 145, 3);
  assert.equal(clock.lapsDone, 2);
  assert.equal(clock.bestLapMs, 75_000, 'clean lap 2 sets bestLapMs');
});

console.log('5. Flashback regressions (#2, #3, #4, #5, #6)');

check('#2: CarDamage snapshot/restore and retired AI cars stay retired (never revive into zombie racers) on Flashback', () => {
  // CarDamage snapshot/restore round-trip
  const dmg = new CarDamage('full', 2.5, 0.975, () => 0.1);
  const pristine = dmg.snapshot();
  dmg.registerImpact({ localX: 0.9, localZ: 2.2, speedMs: 26, source: 'wall' });
  assert.equal(dmg.terminal, true, 'terminal impact recorded');
  const wrecked = dmg.snapshot();
  dmg.restore(pristine);
  assert.equal(dmg.pristine, true, 'restored pristine');
  dmg.restore(wrecked);
  assert.equal(dmg.terminal, true, 'restored wrecked');

  // Field-level test: AI car already retired BEFORE the rewind point must remain parked/retired after restoreField
  const track = getActiveTrackData(1200);
  const player = new F12026CarSim(track);
  const field = new AiOpponentField(track, player, AI_DRIVERS.slice(0, 2), undefined, { seed: 9, damage: 'full' });
  field.raceLaps = 3;
  field.startRace(false);
  const dt = 1 / 60;
  for (let i = 0; i < 60; i++) {
    player.step(dt, {});
    field.update(dt);
  }
  // Retire AI car 0 via terminal impact at t = 1 s
  const cars = (field as unknown as { cars: Array<{ id: string; ai: F12026CarSim | null; damage: CarDamage; retired: boolean; retiredAtS: number | null; control: { mode: string; retire(): void } | null }> }).cars;
  const ai0 = cars.find((c) => c.ai !== null)!;
  ai0.damage.registerImpact({ localX: 0, localZ: 2.4, speedMs: 30, source: 'wall' });
  // Step 4 seconds so ai0 retires and parks, recording retired snapshots at t=1..5 s
  for (let i = 0; i < 60 * 4; i++) {
    player.step(dt, {});
    field.update(dt);
  }
  assert.equal(ai0.retired, true, 'ai0 retired after terminal hit');
  const snapAtT3 = field.peers().find((p) => p.peerId === ai0.id)!;
  // Flashback 2 seconds (to t = 3 s, AFTER ai0 retired at t = 1 s): ai0 must stay retired and parked
  field.restoreField(
    [
      {
        id: ai0.id,
        x: snapAtT3.position.x,
        y: snapAtT3.position.y,
        z: snapAtT3.position.z,
        qx: snapAtT3.quaternion.x,
        qy: snapAtT3.quaternion.y,
        qz: snapAtT3.quaternion.z,
        qw: snapAtT3.quaternion.w,
        yawRad: 0,
        speedMs: 0,
        s: snapAtT3.trackS,
      },
    ],
    2.0
  );
  assert.equal(ai0.retired, true, 'ai0 remains retired after rewinding to post-retirement moment');
  assert.equal(ai0.control?.mode, 'retired', 'ai0 control stays retired (not reset to racing)');
  for (let i = 0; i < 60 * 2; i++) {
    player.step(dt, {});
    field.update(dt);
  }
  assert.ok(Math.abs(ai0.ai!.vxMs) < 5, `retired ai0 stays parked (vx=${ai0.ai!.vxMs.toFixed(1)} m/s)`);

  // Flashback further back to t = 0.25 s (BEFORE the crash at t = 1 s): ai0's damage and retirement roll back cleanly
  field.restoreField(
    [
      {
        id: ai0.id,
        x: snapAtT3.position.x,
        y: snapAtT3.position.y,
        z: snapAtT3.position.z,
        qx: snapAtT3.quaternion.x,
        qy: snapAtT3.quaternion.y,
        qz: snapAtT3.quaternion.z,
        qw: snapAtT3.quaternion.w,
        yawRad: 0,
        speedMs: 30,
        s: snapAtT3.trackS,
      },
    ],
    4.75
  );
  assert.equal(ai0.retired, false, 'rewinding before crash restores ai0 to active');
  assert.equal(ai0.damage.pristine, true, 'rewinding before crash restores pristine damage');
  assert.equal(ai0.control?.mode, 'racing', 'rewinding before crash restores racing mode');

  // Non-terminal damage hit taken < 0.25 s before a zero-rewind Flashback is immediately snapshotted (never free-repaired)
  ai0.damage.registerImpact({ localX: 0, localZ: 2.4, speedMs: 12, source: 'wall' });
  player.step(dt, {});
  field.update(dt);
  const frontDmg = ai0.damage.front;
  assert.ok(frontDmg > 0.1 && !ai0.retired, `non-terminal front wing damage recorded (${frontDmg.toFixed(2)})`);
  field.restoreField([], 0);
  near(ai0.damage.front, frontDmg, 1e-6);
});

check('#3: LapClock rewinding across Start/Finish restores true lapStartS (no bogus ~3s fastest lap)', () => {
  const L = 5000;
  const clock = new LapClock(L);
  clock.reset(0);
  // Complete lap 1 in 80 s, cross into lap 2 at t = 82 s
  clock.update(2000, 32, 5);
  clock.update(4000, 64, 5);
  clock.update(4900, 77, 5);
  clock.update(100, 80, 5);
  assert.equal(clock.lapsDone, 1);
  assert.equal(clock.bestLapMs, 80_000);
  // Slight negative clock skew (raceTimeS = 79.95 while still on lap 1 at distM = 5010) must NOT drop lap 1
  clock.rewindTo(10, 79.95, 5010);
  assert.equal(clock.lapsDone, 1, 'clock skew keeps lap 1');
  assert.equal(clock.bestLapMs, 80_000, 'clock skew keeps lap 1 bestLapMs');
  // Rewind 5 s back across S/F to s=4800m, distM=4800m at t=77s
  clock.rewindTo(4800, 77, 4800);
  assert.equal(clock.lapsDone, 0);
  assert.equal(clock.bestLapMs, null, 'lap completed inside rewound window rolled back');
  assert.equal(clock.lastLapMs, null, 'lastLapMs rolled back cleanly');
  // Re-cross S/F 3.5 s later at t = 80.5 s -> lap time MUST be 80.5 s, NOT 3.5 s
  clock.update(50, 80.5, 5);
  assert.equal(clock.lapsDone, 1);
  assert.equal(clock.bestLapMs, 80_500, `true lap time recorded (got ${clock.bestLapMs})`);
  assert.equal(clock.lastLapMs, 80_500, `true lastLapMs recorded (got ${clock.lastLapMs})`);
});

check('#4: Practice Flashback across S/F or in Sector 3 restores lapCount (both engines) and forfeits next lap', () => {
  const track = getActiveTrackData(1200);
  const s = track.getSampleAtDistance(track.totalLengthM - 100);
  const yaw = Math.atan2(s.tangent.x, s.tangent.z);
  for (const sim of [new F12026CarSim(track), new F1Physics2026(track)]) {
    sim.telemetry.lapCount = 3;
    sim.restorePose({ x: s.position.x, z: s.position.z, yawRad: yaw, speedMs: 40, s: track.totalLengthM - 100, lapCount: 2 });
    assert.equal(sim.telemetry.lapCount, 2, 'restorePose restores recorded lapCount (prevents +1 inflation)');
    assert.equal(sim.telemetry.lapInvalid, true, 'restorePose invalidates current lap');
  }

  // TrackLimitsMonitor: flashback in Sector 3 or across S/F forfeits the next lap too and ignores restore's lapCount jump
  const tl = new TrackLimitsMonitor();
  tl.reset('practice');
  tl.update({ nowMs: 1000, dtS: 0.5, lapCount: 2, lapTimeMs: 78_000, sector: 3, distM: 4800, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: 0, active: true });
  tl.update({ nowMs: 3500, dtS: 2.5, lapCount: 3, lapTimeMs: 500, sector: 1, distM: 50, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: 0, active: true });
  tl.noteFlashback(4000, 3.0, { crossedLine: true, inLastSector: true });
  assert.equal(tl.nextLapForfeit, true, 'flashback across S/F / in S3 arms nextLapForfeit');
  // First frame at restored lapCount=2 must NOT spend nextLapForfeit
  tl.update({ nowMs: 4100, dtS: 0.1, lapCount: 2, lapTimeMs: 78_000, sector: 3, distM: 4800, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: 0, active: true });
  assert.equal(tl.nextLapForfeit, true, 'forfeit still armed until actual line crossing');
  // Re-crossing S/F onto lap 3 deletes lap 3
  const ev = tl.update({ nowMs: 6000, dtS: 1.9, lapCount: 3, lapTimeMs: 200, sector: 1, distM: 20, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: 0, active: true });
  assert.equal(ev?.kind, 'lap_invalid', 'next lap after S3/S-F flashback is deleted');
});

check('#5: RemoteCar.restorePose keeps worker lapCount before delayed reply & SimRuntime restore emits fresh field', () => {
  const track = getActiveTrackData(1200);
  const posted: SimCommand[] = [];
  const emitted: SimEvent[] = [];
  const runtime = new SimRuntime((ev) => emitted.push(ev));
  const link = {
    post(cmd: SimCommand) {
      posted.push(cmd);
    },
    sendColliders() {},
  };
  const twin = new F12026CarSim(track);
  const remote = createRemoteCar(twin, link, () => performance.now());
  // Initialize worker, start on grid, and deliver ready + live state with lapCount = 2
  const rawTrack = JSON.parse(readFileSync('public/tracks/rwanda_official_short/track_data.json', 'utf8')) as RawTrackJson;
  runtime.handle({ type: 'init', car: 1, track: { id: 'rwanda_official_short', raw: rawTrack }, vehicle: 'lc26', lc26Rigid: true });
  remote.car.resetToStartGrid(true);
  for (const cmd of posted.splice(0)) runtime.handle(cmd);
  for (const ev of emitted.splice(0)) remote.receive(ev);
  remote.setRemote(true);
  assert.equal(remote.remote, true, 'remote car switched to worker');
  runtime.handle({ type: 'inputs', inputs: { throttle: 0.5 } });
  runtime.advance(0.02);
  const stEv = emitted.find((e): e is Extract<SimEvent, { type: 'state' }> => e.type === 'state' && e.telemetry !== undefined);
  assert.ok(stEv && stEv.telemetry, 'worker emitted state with telemetry');
  stEv.telemetry.lapCount = 2;
  remote.receive(stEv);
  assert.equal(remote.car.telemetry.lapCount, 2, 'remote car reads worker lapCount = 2');
  // Call restorePose WITHOUT delivering worker's reply yet (simulates 1-frame-late worker reply)
  const s0 = track.getSampleAtDistance(400);
  remote.car.restorePose?.({ x: s0.position.x, z: s0.position.z, yawRad: 0, speedMs: 30, s: 400 });
  // Interim frame before worker replies must NOT drop lapCount to twin's unstepped 0
  assert.equal(remote.car.telemetry.lapCount, 2, `interim lapCount stays 2 (got ${remote.car.telemetry.lapCount})`);
  assert.equal(remote.car.telemetry.lapInvalid, true, 'interim lapInvalid is true');
  // SimRuntime race restore immediately packs fresh field poses on the reply
  emitted.length = 0;
  runtime.handle({
    type: 'race',
    op: 'start',
    race: 1,
    opponents: 2,
    skill: 75,
    setup: {
      laps: 3,
      standing: false,
      gridOrder: 'qualifying',
      playerGrid: 'back',
      damage: 'off',
      aggressionAdd: 0,
      lockAidsInYellow: false,
      driver: null,
    },
    epoch: 10,
    weather: new WeatherState(track.totalLengthM).snapshot(),
    realism: SIM_REALISM_FLAGS.full,
    seed: 1,
  });
  runtime.advance(0.05);
  emitted.length = 0;
  runtime.handle({ type: 'race', op: 'restore', poses: [], rewindS: 1 });
  const replyState = emitted.find((e): e is Extract<SimEvent, { type: 'state' }> => e.type === 'state');
  assert.ok(replyState?.field !== undefined, 'SimRuntime restore immediately packs fresh field poses');
});

check('#6: TrackLimitsMonitor and YellowPassJudge keep pre-rewind pending orders on zero/short Flashback and drop rewound-window ones', () => {
  const tl = new TrackLimitsMonitor();
  tl.reset('race');
  // Off-track excursion starts at t = 0..1.5 s, rejoins at t = 1.5..2.0 s (now in 'judging' stage)
  for (let i = 0; i < 15; i++) {
    tl.update({ nowMs: i * 100, dtS: 0.1, lapCount: 0, distM: 500 + i * 5, lapLengthM: 5000, offTrack: true, throttle: 1, brake: 0, lateralM: 9, curvature: 0.01, deltaS: -0.5, active: true });
  }
  for (let i = 0; i < 6; i++) {
    tl.update({ nowMs: 1500 + i * 100, dtS: 0.1, lapCount: 0, distM: 600 + i * 5, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: -0.8, active: true });
  }
  // Zero-rewind Flashback (0.2 s back, still AFTER excursion started at clockS=0.1 s) MUST NOT wipe the pending excursion
  tl.noteFlashback(2200, 0.2);
  let verdictFired = false;
  for (let i = 0; i < 30; i++) {
    const ev = tl.update({ nowMs: 2300 + i * 100, dtS: 0.1, lapCount: 0, distM: 650 + i * 5, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: -0.8, active: true });
    if (ev && (ev.kind === 'warning' || ev.kind === 'penalty')) verdictFired = true;
    if (tl.snapshot(2300 + i * 100).pending !== null) verdictFired = true;
  }
  assert.equal(verdictFired, true, 'zero/short rewind does not erase pending excursion verdict');

  // Rewinding PAST the excursion start (rewindS = 3.0 s > clockS) DOES clear the excursion
  const tl2 = new TrackLimitsMonitor();
  tl2.reset('race');
  for (let i = 0; i < 5; i++) {
    tl2.update({ nowMs: i * 100, dtS: 0.1, lapCount: 0, distM: 400 + i * 5, lapLengthM: 5000, offTrack: false, throttle: 1, brake: 0, lateralM: 0, curvature: 0, deltaS: 0, active: true });
  }
  for (let i = 0; i < 10; i++) {
    tl2.update({ nowMs: 500 + i * 100, dtS: 0.1, lapCount: 0, distM: 500 + i * 5, lapLengthM: 5000, offTrack: true, throttle: 1, brake: 0, lateralM: 9, curvature: 0.01, deltaS: -0.5, active: true });
  }
  tl2.noteFlashback(1600, 1.4); // restoredClockS = 0.1 s < excursion start (0.5 s)
  assert.equal(tl2.snapshot(1700).pending, null, 'rewinding before excursion clears it');

  // YellowPassJudge.rewind: keeps orders from before restored moment, drops orders from inside rewound window
  const yp = new YellowPassJudge();
  yp.update(0.1, 100, [{ code: 'HAM', distM: 105, exempt: false, gone: false }], 1, true);
  yp.update(0.1, 110, [{ code: 'HAM', distM: 105, exempt: false, gone: false }], 1, true); // illegal pass at age 0
  yp.update(2.0, 180, [{ code: 'HAM', distM: 170, exempt: false, gone: false }], 1, true); // age = 2.0 s
  yp.rewind(0.5); // rewound 0.5 s -> order started 2.0 s ago (before rewind), MUST stay owed
  assert.equal(yp.owed?.code, 'HAM', 'yellow pass order older than rewind stays owed');
  yp.rewind(2.0); // rewound past the pass -> dropped
  assert.equal(yp.owed, null, 'yellow pass order inside rewound window is dropped');
});

console.log('6. Compact typed-array full-race ReplayBuffer (#152)');

check('supports 20-minute multi-car recording, chunk eviction, mid-session car join, velocityAt, and lapMarkers', () => {
  const buf = new ReplayBuffer({ maxSeconds: 1200, hz: 20 });
  // Push 22 minutes (1320 s) to exercise multi-chunk allocation AND head chunk eviction
  for (let i = 0; i <= 1320 * 20; i++) {
    const t = i / 20;
    const lap = Math.floor(t / 100) + 1;
    const cars: ReplayCarState[] = [
      {
        id: 'player',
        x: t * 50,
        y: 0.3,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        speedKmh: 180,
        steer: 0.1,
        throttle: 0.8,
        brake: 0,
        gear: 5,
        rpm: 10500,
        s: (t * 50) % 5000,
        lap,
        distM: t * 50,
      },
    ];
    // Second car joins mid-session after t = 600 s (crossing chunk boundaries)
    if (t >= 600) {
      cars.push({
        id: 'ai-1',
        x: t * 48,
        y: 0.3,
        z: 4,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        speedKmh: 172.8,
        steer: 0,
        throttle: 0.9,
        brake: 0,
        gear: 5,
        rpm: 9800,
        s: (t * 48) % 5000,
      });
    }
    buf.push(t, cars);
  }
  assert.ok(buf.durationS >= 1199.9 && buf.durationS <= 1200.1, `duration=${buf.durationS.toFixed(2)} s`);
  assert.ok(buf.startS >= 119.9 && buf.endS >= 1319.9, `window=[${buf.startS.toFixed(1)}, ${buf.endS.toFixed(1)}]`);
  const ids = buf.carIds();
  assert.deepEqual(ids, ['player', 'ai-1'], 'carIds lists player first followed by AI cars');

  // Velocity reconstruction accuracy (50 m/s for player, 48 m/s for ai-1)
  const vPlayer = buf.velocityAt(900.025, 'player');
  const vAi = buf.velocityAt(900.025, 'ai-1');
  assert.ok(Math.abs(vPlayer.x - 50) < 0.05, `player vx=${vPlayer.x.toFixed(3)}`);
  assert.ok(Math.abs(vAi.x - 48) < 0.05, `ai-1 vx=${vAi.x.toFixed(3)}`);

  // Lap markers detect lap boundaries
  const markers = buf.lapMarkers();
  assert.ok(markers.length >= 10, `found ${markers.length} lap markers`);
  const lap10 = markers.find((m) => m.lap === 10);
  assert.ok(lap10 && Math.abs(lap10.timeS - 900) <= 0.1, `lap 10 marker at ${lap10?.timeS}`);

  // Truncate across chunk boundaries and push a frame with ONLY player -> ai-1 must NOT ghost in
  buf.truncateAfter(700);
  assert.ok(Math.abs(buf.endS - 700) < 0.06, `truncated endS=${buf.endS}`);
  buf.push(700.05, [
    {
      id: 'player',
      x: 123,
      y: 0.3,
      z: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
      speedKmh: 100,
      steer: 0,
      throttle: 0,
      brake: 1,
      gear: 3,
      rpm: 7000,
    },
  ]);
  const after = buf.frameAt(700.05)!;
  assert.equal(after.cars.length, 1, 'no stale AI car ghosts into overwritten post-truncate slot');
  assert.equal(after.cars[0].id, 'player');
});

check('ReplayBuffer carIds() tracks cars present only briefly between start/middle/end and prunes them on truncate', () => {
  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 10 });
  const mkCar = (id: string, x: number) => ({
    id,
    x,
    y: 0.3,
    z: 0,
    qx: 0,
    qy: 0,
    qz: 0,
    qw: 1,
    speedKmh: 100,
    steer: 0,
    throttle: 1,
    brake: 0,
    gear: 3,
    rpm: 8000,
  });
  for (let i = 0; i < 200; i++) {
    const t = i * 0.1;
    // ai-retire appears only around 20%..30% of the buffer (neither first, middle, nor last frame!)
    const cars = i >= 40 && i <= 60 ? [mkCar('player', i), mkCar('ai-retire', i + 5)] : [mkCar('player', i)];
    buf.push(t, cars);
  }
  assert.deepEqual(buf.carIds(), ['player', 'ai-retire'], 'mid-window retired car is reported in carIds()');
  buf.truncateAfter(3.5);
  assert.deepEqual(buf.carIds(), ['player'], 'carIds() drops car once its frames are truncated away');
});

check('AiOpponentField damage history retains snapshots across >150 s rewinds without eviction', () => {
  const track = getActiveTrackData(1200);
  const player = new F12026CarSim(track, null);
  const field = new AiOpponentField(track, player, AI_DRIVERS.slice(0, 2), undefined, { skill: 75, seed: 11 });
  field.damageLevel = 'full';
  field.startRace(false);
  // Advance past lights into racing
  for (let i = 0; i < 60 && field.phase === 'lights'; i++) {
    player.step(1 / 60, {});
    field.update(1 / 60);
  }
  // Record initial clean state, then fast-forward raceTimeS by 200 s and retire an AI car
  field.update(1 / 60);
  const internal = field as unknown as {
    raceTimeS: number;
    cars: Array<{ isPlayer: boolean; id: string; retired: boolean; retiredAtS: number | null; damage: { version: number } }>;
    recordDamageHistory: () => void;
    damageHistory: Array<{ timeS: number }>;
  };
  const targetAi = internal.cars.find((c) => !c.isPlayer)!;
  assert.equal(targetAi.retired, false, 'AI car starts unretired');
  internal.raceTimeS = 200;
  targetAi.retired = true;
  targetAi.retiredAtS = 200;
  internal.recordDamageHistory();
  assert.equal(internal.damageHistory.length, 2, 'change-only history keeps compact 2 snapshots across 200 s');
  // Rewind 195 s back to t = 5 s (before the retirement at t = 200 s)
  field.restoreField([], 195);
  assert.equal(targetAi.retired, false, 'rewinding 195 s back cleanly restores pre-retirement state');
});

check('ReplayBuffer + poseFromReplayCar preserve outLap so Lap 1 -> out-lap Flashback stays on out-lap (both engines)', () => {
  const track = getActiveTrackData(1200);
  const nearLineS = track.totalLengthM - 15;
  const s = track.getSampleAtDistance(nearLineS);
  const yaw = Math.atan2(s.tangent.x, s.tangent.z);
  const buf = new ReplayBuffer({ maxSeconds: 30, hz: 20 });
  buf.push(0, [
    {
      id: 'player',
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      qx: 0,
      qy: Math.sin(yaw / 2),
      qz: 0,
      qw: Math.cos(yaw / 2),
      speedKmh: 180,
      steer: 0,
      throttle: 1,
      brake: 0,
      gear: 5,
      rpm: 9000,
      s: nearLineS,
      lap: 0,
      outLap: true,
    },
  ]);
  buf.push(1.0, [
    {
      id: 'player',
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      qx: 0,
      qy: Math.sin(yaw / 2),
      qz: 0,
      qw: Math.cos(yaw / 2),
      speedKmh: 180,
      steer: 0,
      throttle: 1,
      brake: 0,
      gear: 5,
      rpm: 9000,
      s: 40,
      lap: 0,
    },
  ]);
  const outFrame = buf.frameAt(0)!;
  const lap1Frame = buf.frameAt(1.0)!;
  assert.equal(outFrame.cars[0].lap, 0);
  assert.equal(outFrame.cars[0].outLap, true);
  assert.equal(lap1Frame.cars[0].outLap, undefined);
  const outPose = poseFromReplayCar(outFrame.cars[0]);
  assert.equal(outPose.outLap, true);
  for (const sim of [new F12026CarSim(track), new F1Physics2026(track)]) {
    sim.resetToStartGrid(true);
    // Simulate having crossed onto Lap 1 (outLap=false, lapCount=0)
    sim.restorePose({ ...outPose, outLap: false, lapCount: 0 });
    assert.equal(sim.telemetry.outLap, false);
    // Now rewind back onto the out-lap and drive across the start/finish line
    sim.restorePose(outPose);
    assert.equal(sim.telemetry.outLap, true, 'restorePose restores outLap=true');
    for (let i = 0; i < 60; i++) sim.step(1 / 60, { throttle: 1 });
    assert.equal(sim.telemetry.lapCount, 0, 'crossing line after rewinding onto out-lap starts lap 1 without counting out-lap as a lap');
    assert.equal(sim.telemetry.outLap, false, 'outLap clears after crossing the line');
  }
});

console.log(`\n${passed} checks passed`);
