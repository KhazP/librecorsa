/**
 * Headless checks for contact between two multiplayer players.
 *
 *   npx tsx scripts/verify-multiplayer-contact.ts
 *
 * Two VF26s on autopilot, each client seeing the other only through its own `MultiplayerSyncManager` (25 Hz packets,
 * 40 ± 15 ms one way) and resolving its own car with `resolvePlayerVsRemoteCar`, as the simulator does. Contact is
 * judged against the true poses of both cars.
 *
 *  1. Rear tap: a quicker car runs into the back of a slower one
 *  2. Side by side: two cars leaning on each other on the straight
 *  3. The remote pose: predicted to the present, a jump holds contact off, stale packets turn it off
 */
import * as THREE from 'three';
import { getRwandaTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { MultiplayerSyncManager, type NetworkVehiclePacket } from '../src/lib/sim/multiplayer-sync';
import { resolvePlayerVsRemoteCar } from '../src/lib/sim/ai-opponents';
import { resolveCarToCarObbCollision, type RigidBodyCollisionCar } from '../src/lib/sim/track-evolution';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail}`);
  if (!ok) failures.push(name);
};
const fmt = (v: number, d = 2) => v.toFixed(d);

const track = getRwandaTrackData();
const LATENCY_MS = 40;
const JITTER_MS = 15;
const FPS = 60;
const DT = 1 / FPS;

function packetOf(sim: F1Physics2026, id: string, t: number): NetworkVehiclePacket {
  // As LibreCorsaSimulator sends it: body velocity (vy + left = model +X) to the world, yaw rate + turning right
  const v = new THREE.Vector3(sim.vyMs, 0, sim.vxMs).applyQuaternion(sim.worldQuaternion);
  return {
    peerId: id,
    driverCode: id,
    teamColorHex: '#ffffff',
    timestampMs: t,
    seq: Math.round(t / 40),
    pos: [sim.worldPosition.x, sim.worldPosition.y, sim.worldPosition.z],
    quat: [sim.worldQuaternion.x, sim.worldQuaternion.y, sim.worldQuaternion.z, sim.worldQuaternion.w],
    linVel: [v.x, v.y, v.z],
    angVel: [0, sim.yawRateRadS, 0],
    steerAngle: 0,
    wheelRPMs: [0, 0, 0, 0],
    throttle: 0,
    brake: 0,
    trackS: sim.sMeters,
    speedKmh: sim.vxMs * 3.6,
  };
}

/** The car's true contact box, grown (or shrunk) by `grow` m all round */
function trueBox(sim: F1Physics2026, grow = 0): RigidBodyCollisionCar {
  const q = sim.worldQuaternion;
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const l = Math.hypot(fx, fz) || 1;
  fx /= l;
  fz /= l;
  return {
    x: sim.worldPosition.x, y: sim.worldPosition.y, z: sim.worldPosition.z, fwdX: fx, fwdZ: fz, vx: 0, vz: 0,
    yawRateRadS: 0, massKg: 778, yawInertiaKgM2: 1120, halfLengthM: 2.5 + grow, halfWidthM: 0.975 + grow,
  };
}

interface DuelResult {
  poseErrMeanM: number;
  poseErrMaxM: number;
  /** Frames the cars truly overlapped by more than 5 cm */
  deepFrames: number;
  /** A client touching a car more than 5 cm away / missing one more than 5 cm into it (frames, both clients) */
  phantom: number;
  missed: number;
  hits: number;
  maxPushM: number;
  spinFrames: number;
}

function duel(scenario: 'rear' | 'side', predict: boolean, seconds = 12): DuelResult {
  let seed = 7;
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const A = new F1Physics2026(track);
  const B = new F1Physics2026(track);
  for (const c of [A, B]) {
    c.setAssistPreset('pro');
    c.aiAutopilot = true;
  }
  if (scenario === 'rear') {
    A.teleportToDistance(300, 60, 0);
    B.teleportToDistance(291, 66, 0);
    A.aiPaceScale = 0.8;
    B.aiPaceScale = 1;
  } else {
    A.teleportToDistance(300, 60, -1.1);
    B.teleportToDistance(300, 60, 1.1);
    A.aiPaceScale = 0.9;
    B.aiPaceScale = 0.9;
  }
  const mA = new MultiplayerSyncManager();
  const mB = new MultiplayerSyncManager();
  mA.predictRemotePlayers = predict;
  mB.predictRemotePlayers = predict;
  // What the pings would measure
  mA.setPeerRttMs('B', 2 * LATENCY_MS + JITTER_MS);
  mB.setPeerRttMs('A', 2 * LATENCY_MS + JITTER_MS);
  let maxPushM = 0;
  for (const c of [A, B]) {
    const apply = c.applyRigidBodyCollision.bind(c);
    c.applyRigidBodyCollision = (px, pz, vx, vz, yaw) => {
      maxPushM = Math.max(maxPushM, Math.hypot(px, pz));
      apply(px, pz, vx, vz, yaw);
    };
  }
  const queue: { at: number; to: MultiplayerSyncManager; pkt: NetworkVehiclePacket }[] = [];
  const r: DuelResult = { poseErrMeanM: 0, poseErrMaxM: 0, deepFrames: 0, phantom: 0, missed: 0, hits: 0, maxPushM: 0, spinFrames: 0 };
  let errN = 0;
  let nowMs = 1000;
  let lastSend = -Infinity;
  for (let i = 0; i < seconds * FPS; i++) {
    nowMs += DT * 1000;
    A.step(DT, {});
    B.step(DT, {});
    if (nowMs - lastSend >= 40) {
      lastSend = nowMs;
      queue.push({ at: nowMs + LATENCY_MS + rng() * JITTER_MS, to: mB, pkt: packetOf(A, 'A', nowMs) });
      queue.push({ at: nowMs + LATENCY_MS + rng() * JITTER_MS, to: mA, pkt: packetOf(B, 'B', nowMs) });
    }
    for (let k = queue.length - 1; k >= 0; k--) {
      if (queue[k].at > nowMs) continue;
      queue[k].to.ingestPacket(queue[k].pkt, false, queue[k].at);
      queue.splice(k, 1);
    }
    const near = resolveCarToCarObbCollision(trueBox(A, 0.05), trueBox(B, 0.05)).collided;
    const deep = resolveCarToCarObbCollision(trueBox(A, -0.05), trueBox(B, -0.05)).collided;
    if (deep) r.deepFrames++;
    const seenB = mA.update(nowMs, packetOf(A, 'A', nowMs)).find((p) => p.peerId === 'B');
    const seenA = mB.update(nowMs, packetOf(B, 'B', nowMs)).find((p) => p.peerId === 'A');
    for (const [me, seen, truth] of [[A, seenB, B], [B, seenA, A]] as const) {
      if (!seen) continue;
      if (i > FPS) {
        const e = seen.position.distanceTo(truth.worldPosition);
        r.poseErrMeanM += e;
        r.poseErrMaxM = Math.max(r.poseErrMaxM, e);
        errN++;
      }
      const hit = resolvePlayerVsRemoteCar(me, seen, DT);
      if (hit) r.hits++;
      if (hit && !near) r.phantom++;
      if (!hit && deep) r.missed++;
    }
    for (const c of [A, B]) if (Math.abs(c.yawRateRadS) > 1.5) r.spinFrames++;
  }
  r.poseErrMeanM /= Math.max(1, errN);
  r.maxPushM = maxPushM;
  mA.dispose();
  mB.dispose();
  return r;
}

const show = (label: string, r: DuelResult) =>
  console.log(
    `      ${label}: pose error ${fmt(r.poseErrMeanM)} m (max ${fmt(r.poseErrMaxM)}) · hits ${r.hits}, phantom ${r.phantom}, missed ${r.missed} of ${r.deepFrames} deep frames · max push ${fmt(r.maxPushM, 3)} m · spin frames ${r.spinFrames}`
  );

// ---------------------------------------------------------------------------
// 1 & 2. Two players in contact
// ---------------------------------------------------------------------------
for (const scenario of ['rear', 'side'] as const) {
  console.log(`\n== ${scenario === 'rear' ? 'Rear tap' : 'Side by side'} (${LATENCY_MS} ± ${JITTER_MS} ms one way, 25 Hz)`);
  const old = duel(scenario, false);
  const now = duel(scenario, true);
  show('interpolated (old)', old);
  show('predicted        ', now);
  check(`${scenario}: the other car is drawn where it is`, now.poseErrMeanM < 0.25 && now.poseErrMeanM < old.poseErrMeanM / 10, `${fmt(now.poseErrMeanM)} m vs ${fmt(old.poseErrMeanM)} m interpolated`);
  check(`${scenario}: contact where the cars really touch`, now.hits > 0 && now.phantom < 0.4 * now.hits && now.missed <= 20, `${now.hits} hits, ${now.phantom} phantom, ${now.missed} missed`);
  check(`${scenario}: a push never snaps the car`, now.maxPushM <= 1.5 * DT + 1e-6, `${fmt(now.maxPushM, 3)} m per frame`);
  check(`${scenario}: nobody spins`, now.spinFrames === 0, `${now.spinFrames} frames over 1.5 rad/s`);
}

// ---------------------------------------------------------------------------
// 3. The remote pose
// ---------------------------------------------------------------------------
console.log('\n== Remote pose');
{
  const sim = new F1Physics2026(track);
  sim.setAssistPreset('pro');
  sim.aiAutopilot = true;
  sim.teleportToDistance(300, 60, 0);
  const m = new MultiplayerSyncManager();
  m.setPeerRttMs('R', 80);
  let nowMs = 1000;
  let lastSend = -Infinity;
  // 40 ms one way, no jitter: the 80 ms round trip set above
  const inFlight: { at: number; pkt: NetworkVehiclePacket }[] = [];
  let seen = m.update(nowMs, packetOf(sim, 'L', nowMs)).find((p) => p.peerId === 'R');
  const run = (frames: number, send = true, jumpAt = -1) => {
    let readyFrames = 0;
    for (let i = 0; i < frames; i++) {
      nowMs += DT * 1000;
      sim.step(DT, {});
      if (i === jumpAt) sim.teleportToDistance(sim.sMeters + 40, sim.vxMs, 0);
      if (send && nowMs - lastSend >= 40) {
        lastSend = nowMs;
        inFlight.push({ at: nowMs + 40, pkt: packetOf(sim, 'R', nowMs) });
      }
      while (inFlight.length && inFlight[0].at <= nowMs) {
        const f = inFlight.shift()!;
        m.ingestPacket(f.pkt, false, f.at);
      }
      seen = m.update(nowMs, packetOf(sim, 'L', nowMs)).find((p) => p.peerId === 'R');
      if (seen?.contactReady) readyFrames++;
    }
    return readyFrames;
  };
  run(90);
  const err = seen ? seen.position.distanceTo(sim.worldPosition) : Infinity;
  check('Predicted to now: newest packet + age + one-way latency', !!seen && err < 0.5 && seen.contactReady === true, `${fmt(err)} m from the true car`);
  // A teleport (a reset): snap, then no contact for a moment
  const readyAfterJump = run(12, true, 0);
  check('A jump in the pose holds contact off', readyAfterJump < 12 && !!seen && seen.position.distanceTo(sim.worldPosition) < 1, `ready ${readyAfterJump}/12 frames, ${fmt(seen ? seen.position.distanceTo(sim.worldPosition) : Infinity)} m off`);
  run(60);
  // Packets stop: the guess goes stale and can't be touched
  const readyStale = run(30, false);
  check('Stale packets turn contact off', !!seen && seen.contactReady === false && readyStale < 30, `ready ${readyStale}/30 frames without packets`);
  m.dispose();
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll multiplayer contact checks passed.');
if (failures.length) process.exit(1);
