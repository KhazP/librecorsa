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
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { F12026CarSim } from '../src/lib/sim/f12026-car/F12026CarSim';
import { AI_DRIVERS, AiOpponentField } from '../src/lib/sim/ai-opponents';
import { LapClock } from '../src/lib/sim/race-session';
import { LapRecorder, type CompletedLap, type LapRecorderInput } from '../src/lib/sim/lap-recorder';
import { TrackLimitsMonitor } from '../src/lib/sim/track-limits';
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

console.log(`\n${passed} checks passed`);
