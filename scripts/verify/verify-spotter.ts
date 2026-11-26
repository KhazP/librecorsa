/**
 * Checks the spotter's calls without a browser (src/lib/sim/spotter.ts): which side a car alongside is called on, in
 * the player's car frame; three wide and the clears; "still there" once; nothing below walking pace, with the spotter
 * off or for a ghost; and that time away (a pause, a hidden tab) never counts as time alongside:
 *   npx tsx scripts/verify/verify-spotter.ts
 */
import assert from "node:assert/strict";
import * as THREE from "three";
import { SpotterEngine, type SpotterClipKey, type SpotterConfig } from "../../src/lib/sim/spotter";
import type { InterpolatedPeerState } from "../../src/lib/sim/multiplayer-sync";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const ON: SpotterConfig = { enabled: true, volume: 1, voice: "jim", radioFilter: true };
const NO_OUTPUT = { context: null, output: null };
const FRAME_MS = 16;
const SPEED = 40;
const ORIGIN = new THREE.Vector3();
const AHEAD_Z = new THREE.Quaternion();

/** A peer at (x, y, z) in world space; only what the spotter reads is filled */
const peer = (x: number, z: number, extra: Partial<InterpolatedPeerState> = {}) =>
  ({ position: new THREE.Vector3(x, 0, z), ...extra }) as unknown as InterpolatedPeerState;

/** A spotter whose calls are recorded instead of played (no AudioContext in node) */
function spotter() {
  const s = new SpotterEngine();
  const calls: SpotterClipKey[] = [];
  (s as unknown as { play: (k: SpotterClipKey) => void }).play = (k) => calls.push(k);
  let t = 100_000;
  const run = (ms: number, peers: InterpolatedPeerState[], opts: { q?: THREE.Quaternion; speed?: number; config?: SpotterConfig } = {}) => {
    const end = t + ms;
    let state = s.update(t, ORIGIN, opts.q ?? AHEAD_Z, opts.speed ?? SPEED, peers, opts.config ?? ON, NO_OUTPUT);
    while (t < end) {
      t += FRAME_MS;
      state = s.update(t, ORIGIN, opts.q ?? AHEAD_Z, opts.speed ?? SPEED, peers, opts.config ?? ON, NO_OUTPUT);
    }
    return state;
  };
  const away = (ms: number) => {
    t += ms;
  };
  return { s, calls, run, away };
}

console.log("Spotter");

check("heading +z, a car at +x is on the left; at -x on the right", () => {
  const a = spotter();
  assert.equal(a.run(100, [peer(2, 0)]), "left");
  assert.deepEqual(a.calls, ["car_left"]);
  const b = spotter();
  assert.equal(b.run(100, [peer(-2, 1)]), "right");
  assert.deepEqual(b.calls, ["car_right"]);
});

check("heading +x (yawed 90°), a car at -z is on the left", () => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const a = spotter();
  assert.equal(a.run(100, [peer(0, -2)], { q }), "left");
  assert.deepEqual(a.calls, ["car_left"]);
});

check("three wide, then the clears name the side that cleared", () => {
  const a = spotter();
  a.run(100, [peer(2, 0), peer(-2, 0)]);
  assert.deepEqual(a.calls, ["three_wide"]);
  a.run(2000, [peer(2, 0)]);
  assert.deepEqual(a.calls, ["three_wide", "car_left"]);
  a.run(100, []);
  assert.deepEqual(a.calls, ["three_wide", "car_left", "clear_left"]);
});

check("a car well ahead, behind or two lanes over is not alongside", () => {
  const a = spotter();
  assert.equal(a.run(500, [peer(2, 9), peer(-2, -9), peer(6, 0)]), "clear");
  assert.deepEqual(a.calls, []);
});

check("nothing called below walking pace, with the spotter off, or for a ghost, a stale or a pass-through car", () => {
  const slow = spotter();
  assert.equal(slow.run(500, [peer(2, 0)], { speed: 2 }), "clear");
  const off = spotter();
  assert.equal(off.run(500, [peer(2, 0)], { config: { ...ON, enabled: false } }), "clear");
  const ghosts = spotter();
  assert.equal(ghosts.run(500, [peer(2, 0, { ghost: true }), peer(-2, 0, { stale: true }), peer(2, 1, { passThrough: true })]), "clear");
  assert.deepEqual([...slow.calls, ...off.calls, ...ghosts.calls], []);
});

check('"still there" once, after 2.8 s alongside', () => {
  const a = spotter();
  a.run(2500, [peer(2, 0)]);
  assert.deepEqual(a.calls, ["car_left"]);
  a.run(6000, [peer(2, 0)]);
  assert.deepEqual(a.calls, ["car_left", "still_there"]);
});

check('time away (no updates: a hidden tab) is not time alongside: the car is called afresh, no instant "still there"', () => {
  const a = spotter();
  a.run(1000, [peer(2, 0)]);
  a.away(20_000);
  a.run(0, [peer(2, 0)]);
  assert.deepEqual(a.calls, ["car_left", "car_left"]);
});

check("reset() (the drive loop's pause, replay, menus, show and podium) starts from clear", () => {
  const a = spotter();
  a.run(1000, [peer(2, 0)]);
  a.s.reset();
  a.run(1000, [peer(2, 0)]);
  assert.deepEqual(a.calls, ["car_left", "car_left"]);
});

console.log(`\n${passed} checks passed`);
