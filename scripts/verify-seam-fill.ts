/**
 * The strips fillRoadSeams lays under a converted circuit's road edges (render/seam-fill.ts) fill the gaps between the
 * asphalt and the terrain beside it, are drawn as that terrain, and stay under whatever lies over them.
 *
 * Synthetic cases first, then every circuit with fitted surfaces this copy has: fitted and filled as the game does, its
 * strips face up and hold only finite numbers.
 *
 *   npx tsx scripts/verify-seam-fill.ts            (every circuit with fitted surfaces this copy has)
 *   npx tsx scripts/verify-seam-fill.ts willow_springs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as THREE from 'three';
import { fitVisualRoad } from '../src/lib/render/fit-visual-road';
import { fillRoadSeams } from '../src/lib/render/seam-fill';
import { trackColliders } from '../src/lib/sim/track-colliders';
import { setActiveTrack, type RawTrackJson } from '../src/lib/track-data';
import { loadGlbGeometry } from './lib/glb-geometry';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(64)} ${detail}`);
  if (!ok) failures.push(name);
};

/** A flat rectangle at height y, wound to face up, with u = x / 3 and v = z / 3 */
function rect(name: string, x0: number, x1: number, z0: number, z1: number, y: number, laid = false): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([x0 / 3, z0 / 3, x1 / 3, z0 / 3, x1 / 3, z1 / 3, x0 / 3, z1 / 3], 2));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ name }));
  m.userData.onGround = laid;
  return m;
}

function scene(...meshes: THREE.Mesh[]): { root: THREE.Group; strips: () => THREE.Mesh[] } {
  const root = new THREE.Group();
  const tm = new THREE.Group();
  tm.name = 'Track_Model';
  root.add(tm);
  tm.add(...meshes);
  return {
    root,
    strips: () => {
      const out: THREE.Mesh[] = [];
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && o.userData.seamFill) out.push(o as THREE.Mesh);
      });
      return out;
    },
  };
}

/** The strips' surface height at (x, z), the highest where several overlap; NaN where there is none */
function stripHeight(strips: THREE.Mesh[], x: number, z: number): number {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 50, z), new THREE.Vector3(0, -1, 0));
  for (const s of strips) (s.material as THREE.Material).side = THREE.DoubleSide;
  const hits = ray.intersectObjects(strips, false);
  return hits.length ? hits[0].point.y : NaN;
}

/** Whether every triangle of the strips faces up */
function facesUp(strips: THREE.Mesh[]): boolean {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const s of strips) {
    const pos = s.geometry.getAttribute('position');
    const idx = s.geometry.index!;
    for (let t = 0; t < idx.count; t += 3) {
      a.fromBufferAttribute(pos, idx.getX(t));
      b.fromBufferAttribute(pos, idx.getX(t + 1)).sub(a);
      c.fromBufferAttribute(pos, idx.getX(t + 2)).sub(a);
      const n = b.cross(c);
      if (n.lengthSq() > 1e-12 && !(n.y > 0)) return false;
    }
  }
  return true;
}

// A 3 cm gap between the asphalt's edge (x = 0) and the terrain, which stands 1 cm over it
{
  const terrain = rect('Ground', 0.03, 3, -3, 3, 0.01);
  const { root, strips } = scene(rect('Asphalt', -2, 0, -2, 2, 0, true), terrain);
  fillRoadSeams(root, ['Asphalt']);
  const s = strips();
  check('gap: strips laid', s.length > 0, `${s.length} mesh(es)`);
  check('gap: drawn as the terrain, its own material', s.length > 0 && s.every((m) => m.material === terrain.material));
  const inGap = stripHeight(s, 0.015, 0);
  check('gap: the gap is filled, just under the asphalt\'s edge', inGap < 0 && inGap > -0.01, `${(inGap * 100).toFixed(2)} cm`);
  const under = [0.05, 0.1, 0.2, 0.29].map((x) => stripHeight(s, x, 0));
  check('gap: under the terrain beyond it', under.every((y) => y <= 0.01 - 0.009), under.map((y) => (y * 100).toFixed(2)).join(' ') + ' cm');
  check('gap: every strip faces up', facesUp(s));
  // The terrain's u = x / 3 carried on: at the strip's outer edge (x = 0.3) u = 0.1
  let uv = NaN;
  for (const m of s) {
    const pos = m.geometry.getAttribute('position');
    const uvs = m.geometry.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i) - 0.3) < 1e-4 && Math.abs(pos.getZ(i)) < 1e-4) uv = uvs.getX(i);
  }
  check('gap: the terrain\'s texture carried on', Math.abs(uv - 0.1) < 1e-4, `u ${uv.toFixed(4)} at x = 0.3`);
}

// The terrain 10 cm under the asphalt's edge, meeting it: from the first step out (2 cm) the strip is under it, so
// all that shows is a face down from the edge, closing the slit under it seen from outside
{
  const { root, strips } = scene(rect('Asphalt', -2, 0, -2, 2, 0, true), rect('Ground', 0, 3, -3, 3, -0.1));
  fillRoadSeams(root, ['Asphalt']);
  const ys = [0.02, 0.05, 0.2].map((x) => stripHeight(strips(), x, 0));
  check('lower terrain: the strip stays under it', ys.every((y) => y <= -0.1 - 0.009), ys.map((y) => (y * 100).toFixed(2)).join(' ') + ' cm');
}

// Two asphalt meshes meeting at x = 0: no strip along their shared edge
{
  const { root, strips } = scene(rect('Asphalt', -2, 0, -2, 2, 0, true), rect('Asphalt', 0, 2, -2, 2, 0, true), rect('Ground', -3, 3, -3, 3, -0.02));
  fillRoadSeams(root, ['Asphalt']);
  let along = 0;
  for (const m of strips()) {
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 0.31 && Math.abs(pos.getZ(i)) < 1.9) along++;
  }
  check('shared edge: no strip between two asphalt meshes', along === 0, `${along} strip vertices along it`);
}

// A road material the fit did not lay on the ground (a stand, a bridge): no strip
{
  const { root, strips } = scene(rect('Asphalt', -2, 0, -2, 2, 3, false), rect('Ground', -3, 3, -3, 3, 0));
  fillRoadSeams(root, ['Asphalt']);
  check('not laid: no strip under a road material that stands up', strips().length === 0);
}

const tracksDir = path.join('public', 'tracks');
type TrackJson = RawTrackJson & { metadata?: { mesh?: { url?: string; conformSurfaces?: boolean; roadMaterials?: string[] } } };
const wanted = process.argv.slice(2);
const ids = (wanted.length ? wanted : readdirSync(tracksDir)).filter((id) => existsSync(path.join(tracksDir, id, 'track_data.json'))).sort();
const done = new Set<string>();
let tested = 0;
for (const id of ids) {
  const raw = JSON.parse(readFileSync(path.join(tracksDir, id, 'track_data.json'), 'utf8')) as TrackJson;
  const mesh = raw.metadata?.mesh;
  const glb = path.join('public', mesh?.url ?? `/tracks/${id}/${id}.glb`);
  if (mesh?.conformSurfaces !== true || !mesh.roadMaterials?.length || done.has(glb) || !existsSync(glb)) continue;
  done.add(glb);
  setActiveTrack(id, raw);
  const root = loadGlbGeometry(glb);
  const ground = trackColliders(root).ground;
  if (!ground) continue;
  fitVisualRoad(root, ground, mesh.roadMaterials);
  const t0 = performance.now();
  const laid = fillRoadSeams(root, mesh.roadMaterials);
  const ms = performance.now() - t0;
  const strips: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.seamFill) strips.push(o as THREE.Mesh);
  });
  let vertices = 0;
  let finite = true;
  for (const s of strips) {
    vertices += s.geometry.getAttribute('position').count;
    for (const attr of Object.values(s.geometry.attributes)) if (!(attr.array as Float32Array).every(Number.isFinite)) finite = false;
  }
  tested++;
  check(`${id}: strips laid, facing up, finite`, laid > 0 && facesUp(strips) && finite, `${laid} pieces, ${vertices} vertices, ${ms.toFixed(0)} ms`);
}

if (!tested) console.log('SKIP: no circuit with fitted surfaces in this copy (they are hosted on librecorsa.org only)');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nAll seam checks passed (${tested} circuit(s)).`);
