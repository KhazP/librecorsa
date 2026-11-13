/**
 * The driver figure's arms hold the wheel through the whole lock and stay inside the cockpit:
 *   npx tsx scripts/verify-driver-figure.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createDriverFigure, type DriverFigure } from '../src/lib/render/driver-figure';
import { VF26_CHASSIS } from '../src/lib/sim/vf26-data';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const DEG = Math.PI / 180;
const LOCK_DEG = VF26_CHASSIS.steering.lockDeg;
// The 2026 Prototype's cockpit, as its model has it: the helmet, the wheel's hub, and the tub's walls at the elbows
const HELMET = new THREE.Vector3(0, 0.745, -0.055);
const WHEEL = new THREE.Vector3(0, 0.596, 0.474);
const TUB_HALF_WIDTH_M = 0.26;
const UPPER_ARM_M = 0.31;
const FOREARM_M = 0.27;
/** The wrist's place on the wheel at rest, from the hub (left hand; the right mirrors it) */
const WRIST = new THREE.Vector3(0.14, -0.012, -0.112);

interface Arm {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
}

function build(coarse = false) {
  const frame = new THREE.Group();
  const wheel = new THREE.Group();
  wheel.position.copy(WHEEL);
  frame.add(wheel);
  const figure = createDriverFigure({ helmet: HELMET, wheel, frame, coarse });
  frame.add(figure.group);
  const mesh = (name: string) => {
    const obj = figure.group.getObjectByName(name);
    assert.ok(obj, `${name} is in the figure`);
    return obj as THREE.Mesh;
  };
  const arm = (tag: 'L' | 'R'): Arm => ({
    shoulder: mesh(`DRIVER_UPPER_ARM_${tag}`).position,
    elbow: mesh(`DRIVER_FOREARM_${tag}`).position,
    wrist: mesh(`DRIVER_GLOVE_${tag}`).position,
  });
  const limbs = ['UPPER_ARM_L', 'FOREARM_L', 'UPPER_ARM_R', 'FOREARM_R'].map((n) => mesh(`DRIVER_${n}`));
  return { figure, frame, limbs, left: arm('L'), right: arm('R') };
}

/** An onboard view in the car's frame: `pitchDeg` below (-) the horizon, looking forward */
function onboardView(pos: THREE.Vector3, pitchDeg: number, fovDeg: number, aspect = 16 / 9): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(fovDeg, aspect, 0.12, 5500);
  cam.position.copy(pos);
  cam.lookAt(pos.x, pos.y + Math.sin(pitchDeg * DEG), pos.z + Math.cos(pitchDeg * DEG));
  cam.updateMatrixWorld(true);
  return cam;
}

/** Whether a view draws a limb, by the hooks the renderer calls round its draw */
function draws(cam: THREE.Camera, limb: THREE.Mesh): boolean {
  const hook = (fn: unknown) => (fn as (...args: unknown[]) => void).call(limb, null, null, cam, limb.geometry, null, null);
  hook(limb.onBeforeRender);
  const drawn = limb.geometry.drawRange.count > 0;
  hook(limb.onAfterRender);
  assert.equal(limb.geometry.drawRange.count, Infinity, 'the shared shape is whole again after the draw');
  return drawn;
}

/** Holds the wheel at `deg` long enough for a change of grips to finish */
function settle(figure: DriverFigure, deg: number) {
  for (let i = 0; i < 40; i++) figure.update(deg * DEG, 0.05);
}

/** Where a wrist holding its grip is with the wheel at `deg` (`side` +1 left, -1 right) */
function onGrip(side: number, deg: number): THREE.Vector3 {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const x = side * WRIST.x;
  return new THREE.Vector3(x * c - WRIST.y * s, x * s + WRIST.y * c, WRIST.z).add(WHEEL);
}

/** Closest approach of two bones' centre lines (sampled) */
function gap(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): number {
  let best = Infinity;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i <= 16; i++) {
    a.lerpVectors(a0, a1, i / 16);
    for (let j = 0; j <= 16; j++) best = Math.min(best, a.distanceTo(b.lerpVectors(b0, b1, j / 16)));
  }
  return best;
}

/** The lock, out to one side and back, then the other: both ways through each change of grips */
function sweep(stepDeg = 5): number[] {
  const out: number[] = [];
  for (let d = 0; d <= LOCK_DEG; d += stepDeg) out.push(d);
  for (let d = LOCK_DEG; d >= -LOCK_DEG; d -= stepDeg) out.push(d);
  for (let d = -LOCK_DEG; d <= 0; d += stepDeg) out.push(d);
  return out;
}

check('the bones keep their lengths through the whole lock', () => {
  const { figure, left, right } = build();
  for (const deg of sweep()) {
    settle(figure, deg);
    for (const arm of [left, right]) {
      for (const p of [arm.shoulder, arm.elbow, arm.wrist]) assert.ok(Number.isFinite(p.x + p.y + p.z), `finite at ${deg}`);
      assert.ok(Math.abs(arm.shoulder.distanceTo(arm.elbow) - UPPER_ARM_M) < 1e-6, `upper arm at ${deg}`);
      assert.ok(Math.abs(arm.elbow.distanceTo(arm.wrist) - FOREARM_M) < 1e-6, `forearm at ${deg}`);
    }
  }
});

check('the hands stay on their grips and turn with the wheel', () => {
  const { figure, left, right } = build();
  for (let deg = -140; deg <= 140; deg += 10) {
    settle(figure, deg);
    assert.ok(left.wrist.distanceTo(onGrip(1, deg)) < 1e-6, `left hand at ${deg}`);
    assert.ok(right.wrist.distanceTo(onGrip(-1, deg)) < 1e-6, `right hand at ${deg}`);
  }
});

check('past half a turn the hands take the opposite grips, and take their own again on the way back', () => {
  const { figure, left, right } = build();
  settle(figure, 200);
  assert.ok(left.wrist.distanceTo(onGrip(1, 200 - 180)) < 1e-6, 'left hand on the other grip');
  assert.ok(right.wrist.distanceTo(onGrip(-1, 200 - 180)) < 1e-6, 'right hand on the other grip');
  settle(figure, LOCK_DEG);
  assert.ok(left.wrist.distanceTo(onGrip(1, LOCK_DEG - 180)) < 1e-6, 'left hand at full lock');
  settle(figure, 60);
  assert.ok(left.wrist.distanceTo(onGrip(1, 60)) < 1e-6, 'left hand back on its own grip');
});

check('the elbows stay inside the tub and under the cockpit rim', () => {
  const { figure, left, right } = build();
  for (const deg of sweep()) {
    settle(figure, deg);
    for (const arm of [left, right]) {
      assert.ok(Math.abs(arm.elbow.x) < TUB_HALF_WIDTH_M - 0.045, `elbow ${arm.elbow.x.toFixed(3)} at ${deg}`);
      assert.ok(arm.elbow.y < HELMET.y - 0.2, `elbow height ${arm.elbow.y.toFixed(3)} at ${deg}`);
    }
  }
});

check('the arms do not pass through each other', () => {
  const { figure, left, right } = build();
  for (const deg of sweep()) {
    settle(figure, deg);
    // Forearm against forearm, centre lines: two sleeves are 6 to 9 cm across
    assert.ok(gap(left.elbow, left.wrist, right.elbow, right.wrist) > 0.06, `forearms at ${deg}`);
  }
});

check('left and right mirror each other', () => {
  const a = build();
  const b = build();
  for (let deg = -140; deg <= 140; deg += 20) {
    settle(a.figure, deg);
    settle(b.figure, -deg);
    for (const key of ['shoulder', 'elbow', 'wrist'] as const) {
      const mirrored = b.right[key].clone();
      mirrored.x = -mirrored.x;
      assert.ok(a.left[key].distanceTo(mirrored) < 1e-6, `${key} at ${deg}`);
    }
  }
});

check("an opponent's arms follow the wheel in steps", () => {
  const { figure, left } = build(true);
  figure.update(0, 1 / 60);
  const rest = left.wrist.clone();
  figure.update(1.5 * DEG, 1 / 60);
  assert.ok(left.wrist.equals(rest), 'a small turn leaves the pose alone');
  figure.update(3 * DEG, 1 / 60);
  assert.ok(left.wrist.distanceTo(onGrip(1, 3)) < 1e-6, 'a larger one moves the hands');
  figure.update(200 * DEG, 1 / 60);
  assert.ok(left.wrist.distanceTo(onGrip(1, 20)) < 1e-6, 'a change of grips is made in one step');
});

// The 2026 Prototype's driver's-eye view (its model's cockpit camera) and the dash view ahead of it (onboard-views.ts)
const EYE = new THREE.Vector3(0, 0.74, 0);
const DASH = EYE.clone().add(new THREE.Vector3(0, -0.03, 0.18));

check("the driver's-eye view never cuts an arm open", () => {
  const { figure, frame, limbs } = build();
  const views = [16 / 9, 32 / 9].map((aspect) => onboardView(EYE, -5.865, 55, aspect));
  for (const deg of sweep()) {
    settle(figure, deg);
    frame.updateMatrixWorld(true);
    for (const view of views) for (const limb of limbs) assert.ok(draws(view, limb), `${limb.name} at ${deg}`);
  }
});

check('the dash view leaves out an arm it would cut open, and only then', () => {
  const { figure, frame, limbs } = build();
  const view = onboardView(DASH, -14, 58);
  settle(figure, 0);
  frame.updateMatrixWorld(true);
  for (const limb of limbs) assert.ok(draws(view, limb), `${limb.name} straight ahead`);
  settle(figure, LOCK_DEG);
  frame.updateMatrixWorld(true);
  assert.ok(!draws(view, limbs[1]), 'the top hand\'s forearm at full lock');
  assert.ok(draws(view, limbs[3]), 'the other forearm at full lock');
});

console.log(`\n${passed} checks passed`);
