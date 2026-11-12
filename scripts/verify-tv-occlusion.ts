/**
 * The TV cameras' sight-line test (segment-occluder.ts) against three's Raycaster, on real circuits.
 *
 * For each circuit, camera-like sight lines (from 4.5-8 m up, 20-45 m off the centreline, to the car's height 30-120 m
 * along the track, the last 6 m left out as the TV director does) are tested both ways. The meshes get front-, back- and
 * double-sided materials in turn, and a field of instanced boxes, a forest of turned and stretched instanced crowns and
 * a shadow-layer-only wall are added, so face culling, instancing and layers are exercised too. Every answer must match
 * the Raycaster's, the index must be much faster per line, and it must keep an instanced mesh once, not per instance.
 *
 * Usage: npx tsx scripts/verify-tv-occlusion.ts
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { getActiveTrackData, setActiveTrack, type BuiltTrackData } from '../src/lib/track-data';
import { SegmentOccluder } from '../src/lib/render/segment-occluder';
import { TracksideBroadcastDirector } from '../src/lib/render/camera-rig';
import { SHADOW_PROXY_LAYER } from '../src/lib/render/layers';
import type { TrackSamplePoint } from '../src/types/f1';
import { loadGlbGeometry } from './lib/glb-geometry';
import { hasFile, noteSkip } from './lib/hosted-files';

const SIDES = [THREE.FrontSide, THREE.DoubleSide, THREE.BackSide] as const;
let failed = 0;

for (const id of ['monaco', 'rwanda_official', 'rwanda_official_short']) {
  if (!hasFile(`public/tracks/${id}/track_data.json`)) {
    noteSkip(id, `public/tracks/${id}/track_data.json`);
    continue;
  }
  const raw = JSON.parse(readFileSync(`public/tracks/${id}/track_data.json`, 'utf8'));
  setActiveTrack(id, raw);
  const track = getActiveTrackData(1200);
  const root = loadGlbGeometry(`public${raw.metadata?.mesh?.url ?? `/tracks/${id}/${id}.glb`}`);
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
  // A forest between the cameras and the track: a 1,280-triangle crown per tree, turned, leaning and stretched per
  // instance, seen from both sides like leaf cards (scenery-instances.ts) and from the front only
  const crown = new THREE.IcosahedronGeometry(3, 3);
  const crownTris = crown.attributes.position.count / 3;
  const forest = [THREE.DoubleSide, THREE.FrontSide].map((side, f) => {
    const trees = new THREE.InstancedMesh(crown, new THREE.MeshBasicMaterial({ side }), 150);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < 150; i++) {
      const p = track.getSampleAtDistance(((i + 0.5 * f) / 150) * track.totalLengthM);
      const off = (i % 2 ? -1 : 1) * (8 + (i % 7) * 1.5);
      pos.set(p.position.x + p.binormal.x * off, p.position.y + 3 + (i % 3), p.position.z + p.binormal.z * off);
      q.setFromEuler(e.set(0.2 * Math.sin(i), i * 0.7, 0.15 * Math.cos(i * 1.3)));
      scale.set(1 + (i % 4) * 0.25, 0.6 + (i % 5) * 0.2, 0.8 + (i % 3) * 0.3);
      trees.setMatrixAt(i, m.compose(pos, q, scale));
    }
    return trees;
  });
  root.add(...forest);
  // Shadow-only copies of the trees, as big as a wall: a Raycaster never sees that layer, so neither may the index
  const shadowWall = new THREE.InstancedMesh(new THREE.BoxGeometry(60, 40, 60), new THREE.MeshBasicMaterial(), 40);
  for (let i = 0; i < 40; i++) {
    const p = track.getSampleAtDistance((i / 40) * track.totalLengthM);
    shadowWall.setMatrixAt(i, m.makeTranslation(p.position.x, p.position.y + 20, p.position.z));
  }
  shadowWall.layers.set(SHADOW_PROXY_LAYER);
  root.add(shadowWall);
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
  // The forest on its own: the index keeps each crown once, not once per tree (a copy per tree is 36 bytes a triangle)
  const forestOcc = new SegmentOccluder();
  for (const _ of forestOcc.build(forest)) void _;
  const perTreeCopy = forest.length * 150 * crownTris * 36;
  const ok = mismatches === 0 && occMs * 20 < rayMs && forestOcc.byteLength * 20 < perTreeCopy;
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${id}: ${lines.length} sight lines (${blocked} blocked), ${mismatches} differ from the Raycaster; ` +
      `index built in ${buildMs.toFixed(0)} ms (${(occ.byteLength / 1048576).toFixed(1)} MB), ${occMs.toFixed(3)} ms a line ` +
      `vs the Raycaster's ${rayMs.toFixed(2)} ms; the forest takes ${(forestOcc.byteLength / 1024).toFixed(0)} KB ` +
      `(${(perTreeCopy / 1048576).toFixed(1)} MB copied per tree)`
  );
}
console.log(failed ? `${failed} circuit(s) failed.` : 'The sight-line index answers as the Raycaster does.');

// A sight line that starts inside an instance's box: a 4 m square 5 m ahead, and two slivers 300 m out that stretch the
// box round the camera. From inside, the box's far side is where the ray leaves it, not where it enters
{
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [
        -2, -2, 5, 2, -2, 5, 2, 2, 5, -2, -2, 5, 2, 2, 5, -2, 2, 5,
        -300, -300, -300, -299, -300, -300, -300, -299, -300, 300, 300, 300, 299, 300, 300, 300, 299, 300,
      ],
      3
    )
  );
  const inst = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 1);
  inst.setMatrixAt(0, new THREE.Matrix4().makeRotationY(0.3).setPosition(1, 0.5, -2));
  inst.updateMatrixWorld(true);
  const occ = new SegmentOccluder();
  for (const _ of occ.build([inst])) void _;
  const ray = new THREE.Raycaster();
  let differ = 0;
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.sin(a), 0.05 * Math.cos(3 * a), Math.cos(a)).normalize();
    ray.set(new THREE.Vector3(0, 0, 0), dir);
    ray.far = 50;
    if ((ray.intersectObject(inst, false).length > 0) !== occ.blocked(ray.ray.origin, dir, 50)) differ++;
  }
  if (differ) failed++;
  console.log(`${differ ? 'FAIL' : 'PASS'}  sight lines from inside an instance's box: ${differ} of 64 differ from the Raycaster`);
}

// The director on a synthetic ring: a station the occlusion pass moves while it is on air cuts to its new place, and
// a car that moved further than a frame allows since the last update (another camera was on) starts it over
{
  const R = 640;
  const L = 2 * Math.PI * R;
  const N = 2000;
  // Constant right-hand curvature: every station watches from the inside of the ring (32 m in)
  const samples = Array.from({ length: N }, (_, i) => {
    const a = (i / N) * 2 * Math.PI;
    const outward = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    return { position: outward.clone().multiplyScalar(R), binormal: outward, curvature: 1 / R } as unknown as TrackSamplePoint;
  });
  const director = new TracksideBroadcastDirector({ samples, totalLengthM: L } as unknown as BuiltTrackData);
  const vel = new THREE.Vector3();
  const frame = (s: number) => {
    const a = (s / L) * 2 * Math.PI;
    vel.set(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(60);
    const pos = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(R);
    const out = director.update(1 / 60, pos, s, vel, false);
    return { cut: out.cut, radius: Math.hypot(out.position.x, out.position.z), index: out.cameraIndex };
  };
  // A wall 26 m inside the ring blocks every inside station; the first alternative (the outside, 32 m out) is clear
  const wall = new THREE.Mesh(new THREE.CylinderGeometry(R - 26, R - 26, 40, 256, 1, true), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  wall.position.y = 10;
  const ring = new THREE.Group();
  ring.add(wall);
  ring.updateMatrixWorld(true);

  let directorFailed = 0;
  const expect = (ok: boolean, what: string) => {
    if (!ok) directorFailed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  director: ${what}`);
  };
  const first = frame(100);
  expect(first.cut && first.radius < R, 'primes with a cut, inside the ring');
  expect(!frame(101).cut, 'then glides');
  let moved = 0;
  for (const m of director.occlusionSteps(ring)) moved = m;
  const recut = frame(102);
  expect(moved > 0 && recut.cut && recut.radius > R, `the station on air moved outside (${moved} moved): a cut, not a glide`);
  expect(!frame(103).cut, 'then glides again');
  const jumped = frame(109);
  expect(jumped.cut && jumped.index === recut.index, 'a 6 m jump (frames it did not see) starts over on the same station, with a cut');
  expect(!frame(110).cut, 'then glides again');
  if (directorFailed) failed++;
}
process.exit(failed ? 1 : 0);
