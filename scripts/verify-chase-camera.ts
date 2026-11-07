/**
 * The chase camera frames the car as intended, at any frame rate:
 *   npx tsx scripts/verify-chase-camera.ts
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { type ChaseCameraInput, DynamicChaseCamera } from '../src/lib/render/chase-camera';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

interface Drive {
  cam: DynamicChaseCamera;
  input: ChaseCameraInput;
  yaw: number;
  roll: number;
}

function drive(): Drive {
  return {
    cam: new DynamicChaseCamera(),
    input: {
      carPos: new THREE.Vector3(),
      carQuaternion: new THREE.Quaternion(),
      carVelocity: new THREE.Vector3(),
      longitudinalG: 0,
      lateralG: 0,
      verticalG: 1,
      wheelbaseM: 3.4,
      cgHeightM: 0.3,
      rideHeightOffsetM: 0,
      kerbShakeM: 0,
      manualOverrideActive: false,
    },
    yaw: 0,
    roll: 0,
  };
}

/** One frame of `dt` at `speedMs` along the car's heading, turning at `yawRate` */
function step(d: Drive, dt: number, speedMs: number, yawRate = 0) {
  d.yaw += yawRate * dt;
  d.input.carQuaternion.setFromEuler(new THREE.Euler(0, d.yaw, d.roll, 'YXZ'));
  d.input.carVelocity.set(0, 0, speedMs).applyQuaternion(d.input.carQuaternion);
  d.input.carPos.addScaledVector(d.input.carVelocity, dt);
  return d.cam.update(dt, d.input);
}

/** The camera's offset from the car in the car's flat frame: back (+ = behind), up, left (+ = to the car's left) */
function offset(d: Drive, pos: THREE.Vector3) {
  const rel = pos.clone().sub(d.input.carPos);
  const fwd = new THREE.Vector3(Math.sin(d.yaw), 0, Math.cos(d.yaw));
  const left = new THREE.Vector3(Math.cos(d.yaw), 0, -Math.sin(d.yaw));
  return { back: -rel.dot(fwd), up: rel.y, left: rel.dot(left) };
}

check('at rest: behind and above the car, looking at it', () => {
  const d = drive();
  const out = step(d, 1 / 60, 0);
  const o = offset(d, out.position);
  assert.ok(o.back > 4 && o.back < 6 && o.up > 1.4 && o.up < 2.5 && Math.abs(o.left) < 1e-6, JSON.stringify(o));
  assert.ok(out.lookAt.clone().sub(out.position).z > 0, 'looks forward along the car');
});

check('the boom stretches under acceleration and shortens under braking', () => {
  const boom = (lonG: number) => {
    const d = drive();
    d.input.longitudinalG = lonG;
    let out = step(d, 1 / 60, 50);
    for (let i = 0; i < 120; i++) out = step(d, 1 / 60, 50);
    return offset(d, out.position).back;
  };
  const coast = boom(0);
  assert.ok(boom(1.5) > coast + 0.05 && boom(-4) < coast - 0.05, `${boom(-4).toFixed(2)} < ${coast.toFixed(2)} < ${boom(1.5).toFixed(2)}`);
});

check('in a right-hander the camera swings out to the left and tilts the horizon a little', () => {
  const d = drive();
  d.input.lateralG = 3;
  let out = step(d, 1 / 60, 60);
  for (let i = 0; i < 90; i++) out = step(d, 1 / 60, 60);
  const o = offset(d, out.position);
  assert.ok(o.left > 0.1, JSON.stringify(o));
  const tiltDeg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, out.up.y)));
  assert.ok(tiltDeg > 0.3 && tiltDeg < 3, `${tiltDeg.toFixed(2)}°`);
});

check('on heavy banking the camera rises to keep the car in frame', () => {
  const height = (rollDeg: number) => {
    const d = drive();
    d.roll = THREE.MathUtils.degToRad(rollDeg);
    let out = step(d, 1 / 60, 55);
    for (let i = 0; i < 300; i++) out = step(d, 1 / 60, 55);
    return offset(d, out.position).up;
  };
  assert.ok(height(25) > height(0) + 0.1, `${height(0).toFixed(2)} → ${height(25).toFixed(2)} m`);
});

check('steady aerodynamic downforce does not sink the camera; a crest still moves it', () => {
  const run = (vertG: (t: number) => number) => {
    const d = drive();
    let out = step(d, 1 / 60, 90);
    let maxUp = -Infinity;
    let minUp = Infinity;
    for (let i = 0; i < 360; i++) {
      d.input.verticalG = vertG(i / 60);
      out = step(d, 1 / 60, 90);
      const up = offset(d, out.position).up;
      if (i > 60) {
        maxUp = Math.max(maxUp, up);
        minUp = Math.min(minUp, up);
      }
    }
    return { final: offset(d, out.position).up, span: maxUp - minUp };
  };
  const flat = run(() => 1);
  const aero = run((t) => 1 + 2.2 * Math.min(1, t / 3));
  const crest = run((t) => (t > 3 && t < 3.3 ? 0.2 : 1));
  assert.ok(Math.abs(aero.final - flat.final) < 0.01, `${flat.final.toFixed(3)} vs ${aero.final.toFixed(3)} m`);
  assert.ok(crest.span > 0.05, `crest moves the camera ${crest.span.toFixed(3)} m`);
});

check('the same drive is framed alike at 30, 60, 120 and 240 fps', () => {
  /** Brake into a corner, turn, power out: the camera's offset every 0.1 s (a whole number of frames at each rate) */
  const trace = (fps: number) => {
    const d = drive();
    const samples: { back: number; up: number; left: number }[] = [];
    for (let frame = 0; frame < 6 * fps; frame++) {
      const t = frame / fps;
      const phase = t < 1.5 ? 0 : t < 3 ? 1 : t < 4.5 ? 2 : 3;
      d.input.longitudinalG = [0, -4, 0, 1.5][phase];
      d.input.lateralG = phase === 2 ? 3 : 0;
      d.input.verticalG = 1 + 0.4 * Math.sin(t * 9);
      const out = step(d, 1 / fps, [80, 80 - (t - 1.5) * 25, 42, 42 + (t - 4.5) * 10][phase], phase === 2 ? 0.7 : 0);
      if ((frame + 1) % (fps / 10) === 0) samples.push(offset(d, out.position));
    }
    return samples;
  };
  const ref = trace(60);
  for (const fps of [30, 120, 240]) {
    const tr = trace(fps);
    let worst = 0;
    for (let i = 0; i < ref.length; i++) {
      worst = Math.max(worst, Math.abs(tr[i].back - ref[i].back), Math.abs(tr[i].up - ref[i].up), Math.abs(tr[i].left - ref[i].left));
    }
    console.log(`        ${fps} fps: within ${(worst * 1000).toFixed(1)} mm of 60 fps`);
    assert.ok(worst < 0.03, `${fps} fps strays ${(worst * 1000).toFixed(1)} mm from 60 fps`);
  }
});

check('after reset() the camera starts behind the car where it now is', () => {
  const d = drive();
  for (let i = 0; i < 120; i++) step(d, 1 / 60, 60, 0.5);
  d.input.carPos.set(500, 20, -600);
  d.yaw = Math.PI / 2;
  d.cam.reset();
  const out = step(d, 1 / 60, 0);
  const o = offset(d, out.position);
  assert.ok(o.back > 4 && o.back < 6 && Math.abs(o.left) < 0.01, JSON.stringify(o));
});

console.log(`\n${passed} checks passed`);
