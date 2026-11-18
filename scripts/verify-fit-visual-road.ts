/**
 * fitVisualRoad leaves out the vertices it cannot move before it asks the ground (render/fit-visual-road.ts,
 * `roadReach`). The road it lays must stay exactly as before: each circuit is loaded twice, one copy fitted the
 * way it was before that test (every vertex queried: `everyVertex`) and one with fitVisualRoad as the game runs it, and every position
 * of `Track_Model` must come out bit for bit the same. Also prints how much load time the test saves.
 *
 * Both are given the circuit's road materials, as the game gives them, so the asphalt is laid on the ground and the
 * layers around it move with it. A synthetic crossover checks first that each level's layers move with their own
 * asphalt.
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
import type { GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
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

// A crossover: a road at 0 m and one over it at 5 m, each with a line 1 cm over its asphalt. The ground lifts the lower
// road 5 cm and lowers the upper one 8 cm; each line must move with its own road's asphalt, not a mix of both levels
{
  const quad = (y: number, half: number, name: string) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-half, y, -half, half, y, -half, half, y, half, -half, y, half], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name }));
  };
  const root = new THREE.Group();
  const tm = new THREE.Group();
  tm.name = 'Track_Model';
  root.add(tm);
  const lowerLine = quad(0.01, 0.5, 'Line');
  const upperLine = quad(5.01, 0.5, 'Line');
  tm.add(quad(0, 1, 'Asphalt'), quad(5, 1, 'Asphalt'), lowerLine, upperLine);
  const ground = {
    query(_x: number, _z: number, probeY: number, out: { height: number; surface: string }) {
      out.height = probeY > 4 ? 4.92 : 0.05;
      out.surface = 'road';
      return true;
    },
  } as unknown as GroundQuery;
  fitVisualRoad(root, ground, ['Asphalt']);
  const ys = (m: THREE.Mesh) => Array.from({ length: 4 }, (_, i) => m.geometry.getAttribute('position').getY(i));
  const lower = ys(lowerLine);
  const upper = ys(upperLine);
  check('crossover: the lower road\'s line moves with its own asphalt', lower.every((y) => Math.abs(y - 0.06) < 1e-5), lower.map((y) => y.toFixed(4)).join(' '));
  check('crossover: the upper road\'s line moves with its own asphalt', upper.every((y) => Math.abs(y - 4.93) < 1e-5), upper.map((y) => y.toFixed(4)).join(' '));
}

// What lies on the ground casts no shadow (`onGround`); what stands up (a wall, a post, a deck) keeps it, also merged
// into flat road or in a road material. Ground at 0 m for x < 4 and none further out; a dip to -0.5 m for 0.5 < x < 4
// where a test asks for one
{
  const mesh = (name: string, points: number[], tris: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    g.setIndex(tris);
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name }));
  };
  const flat = (x0: number, x1: number, y = 0) => [x0, y, -1, x1, y, -1, x1, y, 1, x0, y, 1];
  const ground = (dip: boolean) =>
    ({
      query(x: number, _z: number, _probeY: number, out: { height: number; surface: string }) {
        if (x >= 4) return false;
        out.height = dip && x > 0.5 ? -0.5 : 0;
        out.surface = 'road';
        return true;
      },
    }) as unknown as GroundQuery;
  const onGround = (m: THREE.Mesh, dip = false, road: string[] = ['Asphalt']) => {
    const root = new THREE.Group();
    const tm = new THREE.Group();
    tm.name = 'Track_Model';
    root.add(tm);
    tm.add(m);
    fitVisualRoad(root, ground(dip), road);
    return m.userData.onGround === true;
  };
  // Asphalt running off the colliders: half its vertices have no ground, but it is road
  check('ground: asphalt partly off the colliders lies on the ground', onGround(mesh('Asphalt', [...flat(-1, 1), ...flat(10, 12)], [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6])));
  check('ground: the same mesh in another material does not', !onGround(mesh('Grandstand', [...flat(-1, 1), ...flat(10, 12)], [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6])));
  // Mostly where the colliders don't reach (another layout's road): nothing tells it from a deck
  check('ground: asphalt mostly off the colliders keeps its shadow', !onGround(mesh('Asphalt', [...flat(-1, 1), ...flat(10, 12), ...flat(14, 16)], [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 8, 11, 10])));
  // A 1 m wall off the colliders, merged into asphalt that lies on them
  check('ground: asphalt with a wall off the colliders stands up', !onGround(mesh('Asphalt', [...flat(-1, 1), 10, 0, -1, 10, 0, 1, 10, 1, 1, 10, 1, -1], [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7])));
  // Flat asphalt over a dip the fit cannot reach (0.5 m under its far edge): nothing on it stands up
  check('ground: flat asphalt over a dip lies on the ground', onGround(mesh('Asphalt', flat(-1, 1), [0, 2, 1, 0, 3, 2]), true));
  // A 1 m wall merged into the asphalt at its far edge, in the road material and in another one fitted to 90 %
  const wall = [...flat(-1, 1), 1, 1, -1, 1, 1, 1];
  const wallTris = [0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4];
  check('ground: asphalt with a wall merged in stands up', !onGround(mesh('Asphalt', wall, wallTris)));
  const many = [...flat(-1, 1), ...Array.from({ length: 16 }, (_, i) => [-1 + i / 8, 0, 0]).flat(), 1, 1, -1, 1, 1, 1];
  // A deck 5 m up in the road material (a bridge over the ground): it has room under it
  check('ground: an asphalt deck 5 m up keeps its shadow', !onGround(mesh('Asphalt', flat(-1, 1, 5), [0, 2, 1, 0, 3, 2])));
  check('ground: a laid line with a post merged in stands up', !onGround(mesh('Line', many, wallTris.map((i) => (i >= 4 ? i + 16 : i))), false, []));
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
