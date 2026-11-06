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
process.exit(failed ? 1 : 0);
