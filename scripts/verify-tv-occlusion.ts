/**
 * The TV cameras' sight-line test (segment-occluder.ts) against three's Raycaster, on real circuit scans.
 *
 * For each circuit, camera-like sight lines (from 4.5-8 m up, 20-45 m off the centreline, to the car's height 30-120 m
 * along the track, the last 6 m left out as the TV director does) are tested both ways. The meshes get front-, back- and
 * double-sided materials in turn, and a field of instanced boxes is added beside the track, so face culling and
 * instancing are exercised too. Every answer must match the Raycaster's, and the index must be much faster per line.
 *
 * Usage: npx tsx scripts/verify-tv-occlusion.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { getActiveTrackData, setActiveTrack } from '../src/lib/track-data';
import { DynamicChaseCamera, type ChaseCameraInput } from '../src/lib/render/camera-rig';
import { SegmentOccluder } from '../src/lib/render/segment-occluder';
import { loadGlbGeometry } from './lib/glb-geometry';

const SIDES = [THREE.FrontSide, THREE.DoubleSide, THREE.BackSide] as const;
let failed = 0;

for (const id of ['yas_marina', 'rwanda']) {
  const raw = JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, 'utf8'));
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  const root = loadGlbGeometry(id === 'rwanda' ? 'public/tracks/rwanda/rwanda_2026.glb' : `public/tracks/${id}/${id}.glb`);
  let k = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.material = new THREE.MeshBasicMaterial({ side: SIDES[k++ % 3] });
  });
  // Instanced boxes beside the track (scenery instances: stands, trees)
  const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 10, 6), new THREE.MeshBasicMaterial(), 60);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 60; i++) {
    const p = track.getSampleAtDistance((i / 60) * track.totalLengthM);
    m.makeTranslation(p.position.x + p.binormal.x * 25, p.position.y + 5, p.position.z + p.binormal.z * 25);
    boxes.setMatrixAt(i, m);
  }
  root.add(boxes);
  root.updateMatrixWorld(true);
  const meshes: THREE.Object3D[] = [];
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o);
  });

  const occ = new SegmentOccluder();
  let t0 = performance.now();
  for (const _ of occ.build(meshes)) void _;
  const buildMs = performance.now() - t0;

  // Camera-like sight lines
  const lines: [THREE.Vector3, THREE.Vector3, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let s = 0; s < track.totalLengthM; s += 25) {
    const p = track.getSampleAtDistance(s);
    const side = rnd() < 0.5 ? -1 : 1;
    const from = p.position.clone().addScaledVector(p.binormal, side * (20 + 25 * rnd()));
    from.y += 4.5 + 3.5 * rnd();
    const q = track.getSampleAtDistance((s + (rnd() < 0.5 ? -1 : 1) * (30 + 90 * rnd()) + track.totalLengthM) % track.totalLengthM);
    const to = q.position.clone();
    to.y += 0.6;
    const dir = to.clone().sub(from);
    const dist = dir.length();
    lines.push([from, dir.divideScalar(dist), dist - 6]);
  }

  const ray = new THREE.Raycaster();
  const hits: THREE.Intersection[] = [];
  t0 = performance.now();
  const expected = lines.map(([from, dir, far]) => {
    ray.set(from, dir);
    ray.far = far;
    hits.length = 0;
    return ray.intersectObjects(meshes, false, hits).length > 0;
  });
  const rayMs = (performance.now() - t0) / lines.length;
  t0 = performance.now();
  const got = lines.map(([from, dir, far]) => occ.blocked(from, dir, far));
  const occMs = (performance.now() - t0) / lines.length;

  const mismatches = got.filter((g, i) => g !== expected[i]).length;
  const blocked = expected.filter(Boolean).length;
  const ok = mismatches === 0 && occMs * 20 < rayMs;
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${id}: ${lines.length} sight lines (${blocked} blocked), ${mismatches} differ from the Raycaster; ` +
      `index built in ${buildMs.toFixed(0)} ms, ${occMs.toFixed(3)} ms a line vs the Raycaster's ${rayMs.toFixed(2)} ms`
  );
}
console.log(failed ? `${failed} circuit(s) failed.` : 'The sight-line index answers as the Raycaster does.');

// ---------------------------------------------------------------------------------------------------------------
// DynamicChaseCamera unit tests
// ---------------------------------------------------------------------------------------------------------------
{
  const cam = new DynamicChaseCamera();
  const pos = new THREE.Vector3(0, 0, 0);
  const quat = new THREE.Quaternion();
  const vel = new THREE.Vector3(0, 0, 0);
  const input: ChaseCameraInput = {
    carPos: pos,
    carQuaternion: quat,
    carVelocity: vel,
    longitudinalG: 0,
    lateralG: 0,
    verticalG: 1,
    wheelbaseM: 3.6,
    cgHeightM: 0.28,
  };

  const isFiniteVec3 = (v: THREE.Vector3) =>
    Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

  // 1. Allocation-free update & finite outputs at standstill
  const out0 = cam.update(1 / 60, input);
  const out1 = cam.update(1 / 60, input);
  const sameInstance = out0 === out1;
  const standstillFinite =
    isFiniteVec3(out1.position) &&
    isFiniteVec3(out1.direction) &&
    isFiniteVec3(out1.lookAt) &&
    isFiniteVec3(out1.up) &&
    Number.isFinite(out1.fovDeg);
  const baseBoomDist = out1.fxDistanceM;

  // 2. Longitudinal G shifts boom distance: acceleration pulls camera back, braking moves it closer
  cam.reset();
  pos.set(0, 0, 0);
  vel.set(0, 0, 50);
  input.longitudinalG = 1.8;
  for (let i = 0; i < 60; i++) {
    pos.z += 50 * (1 / 60);
    cam.update(1 / 60, input);
  }
  const accelBoomDist = out0.fxDistanceM;

  input.longitudinalG = -4.2;
  for (let i = 0; i < 60; i++) {
    pos.z += 50 * (1 / 60);
    cam.update(1 / 60, input);
  }
  const brakeBoomDist = out0.fxDistanceM;
  const lonSurgeOk = accelBoomDist > baseBoomDist && brakeBoomDist < baseBoomDist;

  // 3. Lateral G shifts camera laterally toward outside of turn and tilts horizon subtly
  cam.reset();
  pos.set(0, 0, 0);
  vel.set(0, 0, 60);
  input.longitudinalG = 0;
  input.lateralG = 3.0; // Right-hand turn (+lateralG) -> outside of turn is +X (carLeft = -carRight)
  for (let i = 0; i < 60; i++) {
    pos.z += 60 * (1 / 60);
    cam.update(1 / 60, input);
  }
  const rightTurnCamX = out0.position.x;
  const rightTurnUpX = out0.up.x;
  const latSwayOk = rightTurnCamX > 0.1 && Math.abs(rightTurnUpX) > 0.005 && Math.abs(rightTurnUpX) < 0.05;

  // 4. Banking increases rollAdd height compensation via quintic smootherstep
  cam.reset();
  pos.set(0, 0, 0);
  vel.set(0, 0, 55);
  input.lateralG = 0;
  quat.identity();
  cam.update(1 / 60, input);
  const flatRollAdd = out0.rollAddM;

  // Bank car by 20 degrees around forward (+Z) axis
  quat.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (20 * Math.PI) / 180);
  for (let i = 0; i < 60; i++) {
    pos.z += 55 * (1 / 60);
    cam.update(1 / 60, input);
  }
  const bankedRollAdd = out0.rollAddM;
  const bankingOk = flatRollAdd === 0 && bankedRollAdd > 0.05 && isFiniteVec3(out0.position);

  // 5. Teleport / reset handling does not spike velocity or produce NaNs
  quat.identity();
  vel.set(0, 0, 0);
  pos.set(0, 0, 0);
  cam.reset();
  cam.update(1 / 60, input);
  const preTeleportFov = out0.fovDeg;
  // Jump 800 m in a single frame
  pos.set(500, 25, -600);
  const postTeleport = cam.update(1 / 60, input);
  const teleportDistToCar = postTeleport.position.distanceTo(pos);
  const teleportOk =
    isFiniteVec3(postTeleport.position) &&
    isFiniteVec3(postTeleport.direction) &&
    isFiniteVec3(postTeleport.up) &&
    Math.abs(postTeleport.fovDeg - preTeleportFov) < 1.0 &&
    teleportDistToCar > 3.5 &&
    teleportDistToCar < 7.0;

  // 6. High-speed aerodynamic downforce (verticalG = 3.2 at 324 km/h on flat straight) must not sink the camera
  cam.reset();
  quat.identity();
  pos.set(0, 0, 0);
  vel.set(0, 0, 0);
  input.longitudinalG = 0;
  input.lateralG = 0;
  input.verticalG = 1.0;
  for (let i = 0; i < 180; i++) {
    const t = i / 180;
    const speedMs = 90 * t;
    vel.set(0, 0, speedMs);
    pos.z += speedMs * (1 / 60);
    input.verticalG = 1.0 + 2.2 * t * t; // ramps to 3.2 G of aero downforce
    cam.update(1 / 60, input);
  }
  // Hold 324 km/h for 2 seconds so high-pass filter settles
  for (let i = 0; i < 120; i++) {
    pos.z += 90 * (1 / 60);
    cam.update(1 / 60, input);
  }
  const highSpeedHeightM = out0.position.y - pos.y;
  const highSpeedPitchOk = highSpeedHeightM > 1.7 && out0.direction.y < -0.05 && Math.abs(out0.vertFxM) < 0.03;

  const allChaseOk =
    sameInstance && standstillFinite && lonSurgeOk && latSwayOk && bankingOk && teleportOk && highSpeedPitchOk;
  if (!allChaseOk) failed++;
  console.log(
    `${allChaseOk ? 'PASS' : 'FAIL'}  DynamicChaseCamera: allocFree=${sameInstance}, finite=${standstillFinite}, ` +
      `lonSurge=(brake ${brakeBoomDist.toFixed(2)}m < base ${baseBoomDist.toFixed(2)}m < accel ${accelBoomDist.toFixed(2)}m), ` +
      `latSway=(x=${rightTurnCamX.toFixed(3)}m, upX=${rightTurnUpX.toFixed(4)}), ` +
      `bankRollAdd=${bankedRollAdd.toFixed(3)}m, highSpeedHeight=${highSpeedHeightM.toFixed(2)}m, teleportDist=${teleportDistToCar.toFixed(2)}m`
  );
}

process.exit(failed ? 1 : 0);
