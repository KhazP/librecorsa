/**
 * fitVisualRoad leaves out the vertices it cannot move before it asks the ground (render/fit-visual-road.ts,
 * `roadReach`). The road it lays must stay exactly as before: each circuit is loaded twice, one copy fitted the
 * way it was before that test (every vertex queried: `everyVertex`) and one with fitVisualRoad as the game runs it, and every position
 * of `Track_Model` must come out bit for bit the same. Also prints how much load time the test saves.
 *
 * Both are given the circuit's road materials, as the game gives them, so the asphalt is laid on the ground and the
 * layers around it move with it.
 *
 *   npx tsx scripts/verify-fit-visual-road.ts            (every circuit with fitted surfaces this copy has)
 *   npx tsx scripts/verify-fit-visual-road.ts chang vir  (just these)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { fitVisualRoad } from '../src/lib/render/fit-visual-road';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
  if (!ok) failures.push(name);
};

/** Every `Track_Model` node (a venue's split model has two) */
function trackModels(root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === 'Track_Model') out.push(o);
  });
  return out;
}

/** Every position attribute under Track_Model, in traversal order */
function positions(root: THREE.Object3D): THREE.BufferAttribute[] {
  const out: THREE.BufferAttribute[] = [];
  for (const tm of trackModels(root)) tm.traverse((o) => {
    if (o instanceof THREE.Mesh && o.geometry?.getAttribute('position')) out.push(o.geometry.getAttribute('position') as THREE.BufferAttribute);
  });
  return out;
}

const tracksDir = path.join('public', 'tracks');
type TrackJson = RawTrackJson & { metadata?: { mesh?: { url?: string; conformSurfaces?: boolean; roadMaterials?: string[] } } };
const wanted = process.argv.slice(2);
const ids = (wanted.length ? wanted : readdirSync(tracksDir)).filter((id) => existsSync(path.join(tracksDir, id, 'track_data.json'))).sort();
const done = new Set<string>();
let tested = 0;
for (const id of ids) {
  const raw = JSON.parse(readFileSync(path.join(tracksDir, id, 'track_data.json'), 'utf8')) as TrackJson;
  const glb = path.join('public', raw.metadata?.mesh?.url ?? `/tracks/${id}/${id}.glb`);
  if (raw.metadata?.mesh?.conformSurfaces !== true || done.has(glb) || !existsSync(glb)) continue;
  done.add(glb);
  setActiveTrack(id, raw);
  const before = loadGlbGeometry(glb);
  const after = loadGlbGeometry(glb);
  const groundBefore = trackColliders(before).ground;
  const groundAfter = trackColliders(after).ground;
  if (!groundBefore || !groundAfter) continue;
  const original = positions(before).map((p) => (p.array as Float32Array).slice());
  const t0 = performance.now();
  const roadMaterials = raw.metadata?.mesh?.roadMaterials ?? [];
  fitVisualRoad(before, groundBefore, roadMaterials, { everyVertex: true });
  const t1 = performance.now();
  fitVisualRoad(after, groundAfter, roadMaterials);
  const t2 = performance.now();
  const a = positions(before);
  const b = positions(after);
  let vertices = 0;
  let moved = 0;
  let differ = 0;
  for (let m = 0; m < a.length; m++) {
    const pa = new Uint32Array((a[m].array as Float32Array).buffer, (a[m].array as Float32Array).byteOffset, a[m].array.length);
    const pb = new Uint32Array((b[m].array as Float32Array).buffer, (b[m].array as Float32Array).byteOffset, b[m].array.length);
    const po = new Uint32Array(original[m].buffer);
    vertices += a[m].count;
    for (let k = 0; k < pa.length; k += 3) {
      if (pa[k] !== pb[k] || pa[k + 1] !== pb[k + 1] || pa[k + 2] !== pb[k + 2]) differ++;
      if (pa[k + 1] !== po[k + 1]) moved++;
    }
  }
  tested++;
  check(
    `${id}: fitted road identical`,
    a.length === b.length && differ === 0 && moved > 0,
    `${differ} of ${vertices} vertices differ; ${moved} fitted; ${(t1 - t0).toFixed(0)} -> ${(t2 - t1).toFixed(0)} ms`
  );
}

if (!tested) console.log('SKIP: no circuit with fitted surfaces in this copy (they are hosted on librecorsa.org only)');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tested} circuit(s) fit the same road.`);
