/**
 * The view camera (camera-rig.ts CameraRig) places every view sensibly around the car:
 *   npx tsx scripts/verify-camera-rig.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { getActiveTrackData } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { CameraRig, type CameraRigFrame } from '../src/lib/render/camera-rig';
import { ALL_CAMERA_MODES, CAMERA_MODES } from '../src/lib/render/camera-modes';
import type { CameraMode } from '../src/types/f1';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const track = getActiveTrackData(1200);

function setup() {
  const car = new F1Physics2026(track);
  car.resetToStartGrid(false);
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, 5500);
  const rig = new CameraRig(camera, track);
  const chassis = new THREE.Group();
  chassis.position.copy(car.worldPosition);
  chassis.quaternion.copy(car.worldQuaternion);
  const frame = (mode: CameraMode, over: Partial<CameraRigFrame> = {}): CameraRigFrame => ({
    dt: 1 / 60,
    nowMs: 1000,
    mode,
    car,
    carPos: car.worldPosition.clone(),
    carVelocity: new THREE.Vector3(),
    anchor: null,
    chassis,
    onboardFovShift: 0,
    headMovement: 'natural',
    driving: true,
    inVr: false,
    menu: null,
    ...over,
  });
  return { car, camera, rig, chassis, frame };
}

const finite = (v: THREE.Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

check('every view puts the camera near the car with a sane field of view', () => {
  for (const mode of ALL_CAMERA_MODES) {
    const { camera, rig, car, frame } = setup();
    for (let i = 0; i < 30; i++) rig.update(frame(mode));
    assert.ok(finite(camera.position), `${mode}: position ${camera.position.toArray()}`);
    const dist = camera.position.distanceTo(car.worldPosition);
    // The trackside TV cameras stand off the circuit; every other view rides with the car
    const maxDist = mode === 'tv_side' ? 400 : mode === 'helicopter' ? 60 : 12;
    assert.ok(dist < maxDist, `${mode}: ${dist.toFixed(1)} m from the car`);
    assert.ok(camera.fov > 10 && camera.fov < 100, `${mode}: fov ${camera.fov}`);
  }
});

check("the car model's anchor wins over the view's own placement, at the anchor's FOV plus the player's shift", () => {
  const { camera, rig, chassis, frame } = setup();
  const anchor = { pos: new THREE.Vector3(0.1, 0.8, -0.3), pitchRad: 0.05, fovDeg: 70 };
  chassis.updateWorldMatrix(true, false);
  const expected = anchor.pos.clone().applyMatrix4(chassis.matrixWorld);
  rig.update(frame('cockpit', { anchor, onboardFovShift: 5, driving: false }));
  // The micro-shake heaves the lens by at most 4 mm
  assert.ok(camera.position.distanceTo(expected) < 0.005, `${camera.position.distanceTo(expected)} m off the anchor`);
  assert.equal(camera.fov, CAMERA_MODES.cockpit.playerFov ? 75 : 70);
  rig.update(frame('nose', { anchor, onboardFovShift: 5, driving: false }));
  assert.equal(camera.fov, 70, 'the nose view keeps the anchor FOV (no player shift)');
});

check('the menu orbit pushes the car right of a wide viewport, and the offset is cleared on track', () => {
  const { camera, rig, frame } = setup();
  rig.update(frame('chase', { driving: false, menu: { close: false, width: 1600, height: 900 } }));
  assert.ok(camera.view?.enabled, 'view offset set in the menu');
  assert.equal(camera.fov, 32);
  rig.update(frame('chase'));
  assert.ok(!camera.view?.enabled, 'view offset cleared on track');
  rig.update(frame('chase', { driving: false, menu: { close: true, width: 800, height: 600 } }));
  assert.ok(!camera.view?.enabled, 'no offset on a narrow viewport');
  assert.equal(camera.fov, 36);
});

check('the neck only turns the head while driving with natural head movement', () => {
  const run = (over: Partial<CameraRigFrame>) => {
    const { camera, rig, car, frame } = setup();
    car.vxMs = 40;
    // Sliding: the head looks along the direction of travel
    (car as unknown as { vyMs: number }).vyMs = 12;
    for (let i = 0; i < 60; i++) rig.update(frame('cockpit', over));
    return camera.quaternion.clone();
  };
  const still = run({ driving: false });
  const natural = run({});
  const locked = run({ headMovement: 'static' });
  assert.ok(natural.angleTo(still) > 1e-3, 'natural head movement turns the view');
  assert.ok(locked.angleTo(still) < 1e-9, 'static head movement leaves it bolted on');
});

check('reset() starts the smoothed chase camera over', () => {
  const { camera, rig, car, frame } = setup();
  const vel = new THREE.Vector3(0, 0, 60).applyQuaternion(car.worldQuaternion);
  const pos = car.worldPosition.clone();
  for (let i = 0; i < 120; i++) {
    pos.addScaledVector(vel, 1 / 60);
    rig.update(frame('chase', { carPos: pos.clone(), carVelocity: vel }));
  }
  const moving = camera.position.clone();
  rig.reset();
  rig.update(frame('chase', { carPos: pos.clone(), carVelocity: vel }));
  assert.ok(finite(camera.position) && camera.position.distanceTo(moving) < 20, 'still behind the car after a reset');
});

check('the helicopter glides behind a moving car, and starts over after a reset or a jump', () => {
  const { camera, rig, car, frame } = setup();
  const vel = new THREE.Vector3(0, 0, 40).applyQuaternion(car.worldQuaternion);
  const pos = car.worldPosition.clone();
  const fly = (n: number) => {
    for (let i = 0; i < n; i++) {
      pos.addScaledVector(vel, 1 / 60);
      rig.update(frame('helicopter', { carPos: pos.clone(), carVelocity: vel }));
    }
  };
  fly(1);
  // The first frame puts it straight over its spot: 28 m back, 14 m out each way and 24 m up
  const spot = (p: THREE.Vector3) =>
    p.clone().addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(car.worldQuaternion), -28).add(new THREE.Vector3(14, 24, 14));
  assert.ok(camera.position.distanceTo(spot(pos)) < 1e-6, 'snapped on first use');
  fly(30);
  const lag = camera.position.distanceTo(spot(pos));
  assert.ok(lag > 0.5 && lag < 20, `glides behind the car (${lag.toFixed(2)} m behind its spot)`);
  rig.reset();
  fly(1);
  assert.ok(camera.position.distanceTo(spot(pos)) < 1e-6, 'starts over after reset()');
  fly(10);
  pos.addScaledVector(vel, 3); // 120 m in one frame: a replay scrub, or frames it did not see
  fly(1);
  assert.ok(camera.position.distanceTo(spot(pos)) < 1e-6, 'starts over after a jump');
});

console.log(`\n${passed} camera rig checks passed`);
