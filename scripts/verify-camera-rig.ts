/**
 * The view camera (camera-rig.ts CameraRig) places every view sensibly around the car:
 *   npx tsx scripts/verify-camera-rig.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { type BuiltTrackData, getActiveTrackData, inDeadZone, type RawTrackJson, setActiveTrack } from '../src/lib/track-data';
import { F1Physics2026 } from '../src/lib/f1-physics-2026';
import { CameraRig, type CameraRigFrame, type CameraRigMenu, TracksideBroadcastDirector } from '../src/lib/render/camera-rig';
import { ALL_CAMERA_MODES, CAMERA_CYCLE, CAMERA_MODES, isDrivingCameraMode } from '../src/lib/render/camera-modes';
import type { CameraMode } from '../src/types/f1';
import { DEFAULT_KEY_BINDINGS } from '../src/lib/input/bindings';

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

/** Deterministic [0, 1) noise for the frame-timing checks */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** How far (m) each frame's value is off the line between its neighbours, interpolated in time; frames next to a jump of over `cutM` left out */
function wobbleM(times: number[], points: THREE.Vector3[], cutM = 3): number[] {
  const out: number[] = [];
  const mid = new THREE.Vector3();
  for (let i = 1; i + 1 < points.length; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    if (a.distanceTo(b) > cutM || b.distanceTo(c) > cutM) continue;
    mid.copy(a).lerp(c, (times[i] - times[i - 1]) / (times[i + 1] - times[i - 1]));
    out.push(b.distanceTo(mid));
  }
  return out;
}
const p99 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.99)];

check('Trackside TV: the dolly glides with the car as drawn, however stale its lap distance (#160)', () => {
  // The car is drawn where it is at the frame's time (renderCarPos); its lap distance comes from the last physics state,
  // a few milliseconds old at a frame (3 to 15 ms in a worker race) and by a different amount each frame
  const speed = 65;
  const drive = (staleS: (i: number) => number, hz: number) => {
    const { camera, rig, car, frame } = setup();
    const times: number[] = [];
    const cams: THREE.Vector3[] = [];
    const pos = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const back = new THREE.Vector3();
    const at = (s: number, out: THREE.Vector3) => {
      const smp = track.getSampleAtDistance(s);
      // Off the centreline by a few metres, changing as a racing line does
      return out.copy(smp.position).addScaledVector(smp.binormal, 4 * Math.sin(s / 70));
    };
    for (let i = 0; i < hz * 12; i++) {
      const t = i / hz;
      const s = 300 + speed * t;
      at(s, pos);
      at(s + 0.05, vel).sub(at(s - 0.05, back)).multiplyScalar(speed / 0.1);
      car.sMeters = (s - speed * staleS(i)) % track.totalLengthM;
      rig.update(frame('tv_side', { dt: 1 / hz, nowMs: t * 1000, carPos: pos.clone(), carVelocity: vel.clone() }));
      times.push(t);
      cams.push(camera.position.clone());
    }
    return p99(wobbleM(times, cams).slice(Math.round(hz * 0.5)));
  };
  for (const hz of [144, 75]) {
    const exact = drive(() => 0, hz);
    const rnd = lcg(160);
    const stale = drive(() => rnd() * 0.015, hz);
    assert.ok(
      stale < exact * 1.5 + 0.005,
      `${hz} Hz: camera wobble p99 ${(stale * 1000).toFixed(1)} mm with a stale lap distance, ${(exact * 1000).toFixed(1)} mm with an exact one`
    );
  }
});

check('helicopter: the same framing at any frame rate, and no wobble when frames come unevenly', () => {
  // A car at a steady 60 m/s on a straight: once settled, the camera's place behind it must not depend on the frame time
  const offsetAfter = (dts: () => number) => {
    const { camera, rig, car, frame } = setup();
    const vel = new THREE.Vector3(0, 0, 60).applyQuaternion(car.worldQuaternion);
    const pos = car.worldPosition.clone();
    const times: number[] = [];
    const offsets: THREE.Vector3[] = [];
    let t = 0;
    while (t < 4) {
      const dt = dts();
      t += dt;
      pos.addScaledVector(vel, dt);
      rig.update(frame('helicopter', { dt, carPos: pos.clone(), carVelocity: vel }));
      if (t > 2) {
        times.push(t);
        offsets.push(camera.position.clone().sub(pos));
      }
    }
    return { offset: offsets[offsets.length - 1], wobble: Math.max(...wobbleM(times, offsets)) };
  };
  const at60 = offsetAfter(() => 1 / 60);
  const at144 = offsetAfter(() => 1 / 144);
  const rnd = lcg(7);
  // 60 Hz with every tenth frame or so dropped
  const uneven = offsetAfter(() => (rnd() < 0.1 ? 2 : 1) / 60);
  assert.ok(at144.offset.distanceTo(at60.offset) < 0.05, `144 Hz frames it ${at144.offset.distanceTo(at60.offset).toFixed(3)} m off the 60 Hz framing`);
  assert.ok(uneven.offset.distanceTo(at60.offset) < 0.05, `uneven frames leave it ${uneven.offset.distanceTo(at60.offset).toFixed(3)} m off the 60 Hz framing`);
  assert.ok(uneven.wobble < 0.01, `uneven frames wobble it ${(uneven.wobble * 1000).toFixed(1)} mm against the car`);
});

check('Trackside TV: the aim settles on the car at any frame rate, and does not wobble when frames come unevenly', () => {
  // The look-at leads the car by its velocity as far as the damping trails it: on a steady car it sits on the car
  const aimOff = (dts: () => number) => {
    const director = new TracksideBroadcastDirector(track);
    const vel = new THREE.Vector3(0, 0, 70);
    const pos = new THREE.Vector3(0, 0, 0);
    const times: number[] = [];
    const offsets: THREE.Vector3[] = [];
    let t = 0;
    while (t < 3) {
      const dt = dts();
      t += dt;
      pos.addScaledVector(vel, dt);
      const out = director.update(dt, pos, 300, vel, false);
      if (t > 1.5) {
        times.push(t);
        // (it looks at the car 0.6 m up)
        offsets.push(out.lookAt.clone().sub(pos).setY(out.lookAt.y - pos.y - 0.6));
      }
    }
    return { offset: Math.max(...offsets.map((o) => o.length())), wobble: Math.max(...wobbleM(times, offsets)) };
  };
  const rnd = lcg(11);
  for (const [name, dts] of [
    ['60 Hz', () => 1 / 60],
    ['144 Hz', () => 1 / 144],
    ['60 Hz with dropped frames', () => (rnd() < 0.1 ? 2 : 1) / 60],
    // A hitch the session catches up in full (MAX_FRAME_CATCH_UP_S), once the aim has settled
    ['60 Hz with a quarter-second hitch', (() => {
      let n = 0;
      return () => (++n === 120 ? 0.25 : 1 / 60);
    })()],
  ] as const) {
    const { offset, wobble } = aimOff(dts);
    assert.ok(offset < 0.01, `${name}: aims up to ${offset.toFixed(3)} m off the car`);
    assert.ok(wobble < 0.005, `${name}: the aim wobbles ${(wobble * 1000).toFixed(1)} mm against the car`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The title screen's aerial tour (menu-aerial.ts)
// ---------------------------------------------------------------------------------------------------------------

const riseGp = (() => {
  // The GP layout's own data, built and then the short layout put back for the checks below
  setActiveTrack('rwanda_official', JSON.parse(readFileSync('public/tracks/rwanda_official/track_data.json', 'utf8')) as RawTrackJson);
  const gp = getActiveTrackData(1200);
  setActiveTrack('rwanda_official_short', JSON.parse(readFileSync('public/tracks/rwanda_official_short/track_data.json', 'utf8')) as RawTrackJson);
  return gp;
})();
// A hill climb: the short layout cut into a point-to-point run, its closing line (2600 .. 5200 m) with no road
const p2pDef = { finishS: 2400, endS: 2600, startS: 5200 };
const hillClimb: BuiltTrackData = { ...track, pointToPoint: p2pDef };

const aerialMenu = (over: Partial<CameraRigMenu> = {}): CameraRigMenu => ({ close: false, width: 1600, height: 900, aerial: true, ...over });

/** The road under the camera's line of sight (the shot's target sits on its forward axis, whatever the view offset) */
function aimedAt(t: BuiltTrackData, camera: THREE.PerspectiveCamera) {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const p = camera.position.clone();
  for (let d = 0; d < 3000; d += 2) {
    p.copy(camera.position).addScaledVector(dir, d);
    const hit = t.projectWorldToTrack(p.x, p.z);
    if (p.y <= hit.sample.position.y) return hit;
  }
  return null;
}

/** Centreline samples (off a point-to-point course's closing line) inside the frame, and their mean screen x (-1 .. 1) */
function roadInFrame(t: BuiltTrackData, camera: THREE.PerspectiveCamera) {
  camera.updateMatrixWorld();
  let n = 0;
  let sumX = 0;
  const v = new THREE.Vector3();
  for (const s of t.samples) {
    if (t.pointToPoint && inDeadZone(t.pointToPoint, s.s)) continue;
    v.copy(s.position).project(camera);
    if (Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1) {
      n++;
      sumX += v.x;
    }
  }
  return { n, meanX: n ? sumX / n : 0 };
}

function maxRoadYNear(t: BuiltTrackData, p: THREE.Vector3, r: number) {
  let y = -Infinity;
  for (const s of t.samples) if (Math.hypot(s.position.x - p.x, s.position.z - p.z) < r) y = Math.max(y, s.position.y);
  return y;
}

for (const [name, t] of [
  ['RISE short', track],
  ['RISE GP', riseGp],
  ['a point-to-point course', hillClimb],
] as const) {
  check(`aerial tour on ${name}: above the road, the road in frame right of the menu, aimed at driven road, cutting between shots`, () => {
    const car = new F1Physics2026(t);
    car.resetToStartGrid(false);
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.12, 5500);
    const rig = new CameraRig(camera, t);
    const chassis = new THREE.Group();
    const dt = 1 / 30;
    let prev: THREE.Vector3 | null = null;
    let cuts = 0;
    for (let i = 0; i <= 30 * 95; i++) {
      rig.update({
        dt,
        nowMs: 1000 + i * dt * 1000,
        mode: 'chase',
        car,
        carPos: car.worldPosition.clone(),
        carVelocity: new THREE.Vector3(),
        anchor: null,
        chassis,
        onboardFovShift: 0,
        headMovement: 'natural',
        driving: false,
        inVr: false,
        menu: aerialMenu(),
      });
      const timeS = i * dt;
      assert.ok(finite(camera.position), `${timeS.toFixed(1)} s: position ${camera.position.toArray()}`);
      if (prev) {
        const step = camera.position.distanceTo(prev);
        if (step > 8) cuts++;
        // Within a shot it drifts (a cut is a jump): never faster than a slow helicopter, a little faster in the climb
        // away from the car
        else assert.ok(step < (timeS < 8 ? 2 : 1.5), `${timeS.toFixed(1)} s: ${step.toFixed(2)} m in one frame`);
      }
      prev = camera.position.clone();
      // Checked in each shot's body, after the rise from the car
      if (timeS < 8.5 || i % 15 !== 0) continue;
      const floor = maxRoadYNear(t, camera.position, 150);
      assert.ok(camera.position.y > floor + 40, `${timeS.toFixed(1)} s: ${(camera.position.y - floor).toFixed(0)} m over the road below`);
      const seen = roadInFrame(t, camera);
      assert.ok(seen.n >= 20, `${timeS.toFixed(1)} s: ${seen.n} road samples in frame`);
      assert.ok(seen.meanX > -0.25, `${timeS.toFixed(1)} s: the road sits under the menu (mean x ${seen.meanX.toFixed(2)})`);
      const aim = aimedAt(t, camera);
      assert.ok(aim, `${timeS.toFixed(1)} s: looking at the ground`);
      assert.ok(aim!.distSq < 90 * 90, `${timeS.toFixed(1)} s: aimed ${Math.sqrt(aim!.distSq).toFixed(0)} m off the road`);
      if (t.pointToPoint) {
        const p = t.pointToPoint;
        assert.ok(!(aim!.s > p.endS + 120 && aim!.s < p.startS - 120), `${timeS.toFixed(1)} s: aimed at the closing line (s ${aim!.s.toFixed(0)})`);
      }
      assert.ok(camera.view?.enabled, 'the view offset holds through the tour');
    }
    assert.ok(cuts >= 4, `${cuts} cuts in 95 s`);
  });
}

check('the aerial rises from the car, cuts back to it on input, holds still under reduced motion, and pulls in in the rain', () => {
  const { camera, rig, car, frame } = setup();
  const menuFrame = (menu: CameraRigMenu) => frame('chase', { driving: false, menu });
  rig.update(menuFrame(aerialMenu({ aerial: false })));
  const orbitDist = camera.position.distanceTo(car.worldPosition);
  rig.update(menuFrame(aerialMenu()));
  assert.ok(camera.position.distanceTo(car.worldPosition) < orbitDist + 0.5, 'starts from the orbit, not with a cut');
  for (let i = 0; i < 60 * 10; i++) rig.update(menuFrame(aerialMenu()));
  assert.ok(rig.aerialUp && camera.position.distanceTo(car.worldPosition) > 100, 'up in the air after the rise');
  rig.update(menuFrame(aerialMenu({ aerial: false })));
  assert.ok(!rig.aerialUp && camera.position.distanceTo(car.worldPosition) < 12, 'any input: straight back on the car');
  // The car-select step stays on the car
  rig.update(menuFrame(aerialMenu({ close: true })));
  assert.ok(!rig.aerialUp && camera.position.distanceTo(car.worldPosition) < 8, 'the car step keeps the close orbit');
  // Reduced motion: the first frame is the held one, and it never moves
  rig.update(menuFrame(aerialMenu({ aerial: false })));
  rig.update(menuFrame(aerialMenu({ still: true })));
  const held = camera.position.clone();
  assert.ok(held.distanceTo(car.worldPosition) > 100, 'cuts straight to the aerial');
  for (let i = 0; i < 60 * 40; i++) rig.update(menuFrame(aerialMenu({ still: true })));
  assert.ok(camera.position.distanceTo(held) < 1e-6, 'holds still');
  // Thick air (heavy rain) brings the camera nearer its target than clear air does
  const reach = (fogDensity: number) => {
    rig.update(menuFrame(aerialMenu({ aerial: false })));
    for (let i = 0; i < 60 * 10; i++) rig.update(menuFrame(aerialMenu({ fogDensity })));
    const aim = aimedAt(track, camera);
    return aim ? camera.position.distanceTo(aim.sample.position) : Infinity;
  };
  const clear = reach(0.00035);
  const rain = reach(0.003);
  assert.ok(rain < clear * 0.75, `rain ${rain.toFixed(0)} m against clear ${clear.toFixed(0)} m`);
  rig.update(frame('chase'));
  assert.ok(!rig.aerialUp && !camera.view?.enabled, 'on track: no aerial, no view offset');
});

check('camera cycle includes chase_close and chase_far while keeping free, chase_low, helicopter, nose, shoulder and Trackside TV outside C cycle', () => {
  assert.ok(CAMERA_CYCLE.includes('chase_close'));
  assert.ok(CAMERA_CYCLE.includes('chase'));
  assert.ok(CAMERA_CYCLE.includes('chase_far'));
  assert.ok(!CAMERA_CYCLE.includes('chase_low'));
  assert.ok(!CAMERA_CYCLE.includes('free'));
  assert.ok(!CAMERA_CYCLE.includes('helicopter'));
  // Trackside TV has its own key (F8) and pause menu button, like the free camera
  assert.ok(!CAMERA_CYCLE.includes('tv_side'));
  assert.deepEqual(DEFAULT_KEY_BINDINGS.tvCamera, ['F8']);
  assert.ok(!isDrivingCameraMode('free'), 'free camera is never persisted as default driving camera');
  assert.ok(isDrivingCameraMode('chase_close') && isDrivingCameraMode('chase_low'));
});

check('free camera spawns framing the car, flies with input, clamps to ground, adjusts FOV/speed, and resets cleanly', () => {
  const { camera, rig, car, frame } = setup();
  rig.update(frame('free'));
  const spawned = camera.position.clone();
  const spawnDist = spawned.distanceTo(car.worldPosition);
  assert.ok(spawnDist > 4 && spawnDist < 11, `free cam spawned ${spawnDist.toFixed(2)} m from car`);

  // Fly forward and up
  for (let i = 0; i < 30; i++) {
    rig.update(frame('free', { freeInput: { forward: 1, right: 0, up: 0.5, fast: true, slow: false } }));
  }
  assert.ok(camera.position.distanceTo(spawned) > 10, 'free cam moves under flight input');

  // Ground clearance clamp
  for (let i = 0; i < 40; i++) {
    rig.update(frame('free', { freeInput: { forward: 0, right: 0, up: -1, fast: true, slow: false }, freeMinY: 5.0 }));
  }
  assert.ok(camera.position.y >= 4.99, `ground clamp holds y=${camera.position.y.toFixed(2)} >= 5.0`);

  // Look, speed and FOV adjustments
  const beforeQ = camera.quaternion.clone();
  rig.freeCamera.lookDelta(0.5, 0.2);
  rig.freeCamera.adjustFov(-10);
  rig.freeCamera.adjustSpeed(2);
  rig.update(frame('free'));
  assert.ok(camera.quaternion.angleTo(beforeQ) > 0.3, 'lookDelta rotates camera');
  assert.ok(Math.abs(camera.fov - 45) < 1e-3, `FOV adjusted to ${camera.fov}`);
  assert.ok(rig.freeCamera.moveSpeedMs > 30, 'speed scaled');

  // Reset returns near car
  rig.freeCamera.reset();
  rig.update(frame('free'));
  assert.ok(camera.position.distanceTo(spawned) < 1e-4, 'reset respawns near target car');
});

console.log(`\n${passed} camera rig checks passed`);
