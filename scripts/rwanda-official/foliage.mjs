// Trees and shrubs of the official Rwanda layout: an acacia and a shrub (assets/foliage_src.glb, both CC BY 4.0, credited
// in assets/credits.json and CREDITS.md) instanced at this layout's own tree spots (data/trees.json, written by
// bl_terrain.export_trees). One EXT_mesh_gpu_instancing node per tile, model and level of detail, in hash order.
//
//   node scripts/rwanda-official/foliage.mjs
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { dedup, prune, simplifyPrimitive } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { hash } from '../lib/rwanda-ground.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SRC = join(HERE, 'assets/foliage_src.glb');
const OUT = join(ROOT, 'public/tracks/rwanda_official/scenery/foliage.glb');
const TREES = join(HERE, 'data/trees.json');
// Trees beside the track go in small tiles, so only the ones really near the camera are drawn in full detail (a
// tile switches level as a whole, by its nearest tree). The rest of the site, never nearer a car than the third
// level's distance, is in large ones: few draw calls
const NEAR_TRACK_M = 220;
const NEAR_TILE_M = 125;
const FAR_TILE_M = 500;
const LAPS = ['rwanda_official', 'rwanda_official_short'];
/** Sunk into the ground so a slope never shows a floating base */
const SINK_M = 0.15;
const MODELS = { acacia: 'Acacia', shrub: 'Shrub' };
// This layout stands in ten times the concept layout's trees, so its acacias switch levels sooner and get a fourth,
// lighter one far out (distances are to the nearest tree of a tile, as the loader measures them)
const ACACIA_FROM = [0, 70, 170, 420];
/** The far level: this many of the last level's leaf cards, each this much larger, on a trunk without branches */
const FAR_CARDS = 7;
const FAR_CARD_SCALE = 1.8;
/** ... drawn for this share of a tile's trees (the first ones in hash order: an even spread), each a little larger */
const FAR_SHARE = 0.6;
const FAR_TREE_SCALE = 1.12;
/** Trees this many canopy cells (18 m) inside the closed woodland's sheet stand under it: one in three is kept */
const DEEP_CELLS = 2;
const DEEP_KEEP = 0.34;

await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(SRC);
const root = doc.getRoot();
const credits = JSON.parse(readFileSync(join(dirname(SRC), 'credits.json'), 'utf8'));
const planted = JSON.parse(readFileSync(TREES, 'utf8'));
const trees = planted.filter((t) => !(t.d >= DEEP_CELLS) || hash(t.x, t.z, 21) < DEEP_KEEP);

// The models' levels of detail, with when each is drawn, as the source file's own nodes state them
const levels = {};
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  const extras = node.getExtras();
  if (!mesh || typeof extras.tile !== 'string') continue;
  const model = extras.tile.split(':')[0];
  const { tile: _tile, ...when } = extras;
  ((levels[model] ??= [])[extras.level] ??= { mesh, when });
}
for (const node of root.listNodes()) node.dispose();
for (const scene of root.listScenes()) scene.dispose();

const buffer0 = root.listBuffers()[0];
/** Connected pieces of a primitive (vertices at the same spot count as one): lists of triangles, largest first */
function pieces(prim) {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices().getArray();
  const n = pos.getCount();
  const par = [...Array(n).keys()];
  const find = (a) => {
    while (par[a] !== a) a = par[a] = par[par[a]];
    return a;
  };
  const at = new Map();
  const el = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const k = pos.getElement(i, el).map((v) => Math.round(v * 1000)).join(',');
    if (at.has(k)) par[find(i)] = find(at.get(k));
    else at.set(k, i);
  }
  for (let t = 0; t < idx.length; t += 3) {
    par[find(idx[t])] = find(idx[t + 1]);
    par[find(idx[t + 1])] = find(idx[t + 2]);
  }
  const out = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const c = find(idx[t]);
    if (!out.has(c)) out.set(c, []);
    out.get(c).push([idx[t], idx[t + 1], idx[t + 2]]);
  }
  return [...out.values()].sort((a, b) => b.length - a.length);
}
/** A primitive of the given pieces of `prim`, each scaled about its own middle */
function ofPieces(prim, list, scale) {
  const out = { idx: [] };
  const sems = prim.listSemantics();
  for (const sem of sems) out[sem] = [];
  const pos = prim.getAttribute('POSITION');
  let count = 0;
  for (const tris of list) {
    const used = [...new Set(tris.flat())];
    const mid = [0, 0, 0];
    for (const i of used) pos.getElement(i, [0, 0, 0]).forEach((v, k) => (mid[k] += v / used.length));
    const remap = new Map(used.map((i, k) => [i, count + k]));
    count += used.length;
    for (const i of used)
      for (const sem of sems) {
        const a = prim.getAttribute(sem);
        const v = a.getElement(i, Array(a.getElementSize()).fill(0));
        out[sem].push(...(sem === 'POSITION' ? v.map((x, k) => mid[k] + (x - mid[k]) * scale) : v));
      }
    for (const tri of tris) out.idx.push(...tri.map((i) => remap.get(i)));
  }
  const copy = doc.createPrimitive().setMaterial(prim.getMaterial());
  for (const sem of sems) copy.setAttribute(sem, doc.createAccessor().setType(prim.getAttribute(sem).getType()).setArray(new Float32Array(out[sem])).setBuffer(buffer0));
  return copy.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(out.idx)).setBuffer(buffer0));
}
/** The level past the model's last: an even pick of its leaf cards, enlarged, and the trunk without its branches */
function farMesh(base, name) {
  const mesh = doc.createMesh(name);
  for (const prim of base.listPrimitives()) {
    const list = pieces(prim);
    if (prim.getMaterial()?.getAlphaMode() === 'MASK') {
      const pick = Array.from({ length: FAR_CARDS }, (_, k) => list[Math.floor(((k + 0.5) * list.length) / FAR_CARDS)]);
      mesh.addPrimitive(ofPieces(prim, pick, FAR_CARD_SCALE));
    } else {
      const trunk = ofPieces(prim, list.slice(0, 1), 1);
      simplifyPrimitive(trunk, { simplifier: MeshoptSimplifier, ratio: 0.45, error: 0.2, lockBorder: false });
      mesh.addPrimitive(trunk);
    }
  }
  return mesh;
}
{
  const l = levels.acacia;
  l.push({ mesh: farMesh(l[l.length - 1].mesh, 'Acacia_LOD3'), when: { level: l.length, shadow: false }, share: FAR_SHARE, grow: FAR_TREE_SCALE });
  l.forEach((x, level) => (x.when = { ...x.when, from: ACACIA_FROM[level] }));
  // the nearest trees cast their shadows through the next level's lighter mesh, as that level does through its next
  l[0].when = { ...l[0].when, shadow: false, shadowFrom: 1 };
}

const instancing = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
const buffer = root.listBuffers()[0];
const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const scene = doc.createScene('Rwanda_Official_Scenery');
const count = (m) => trees.filter((t) => t.m === m).length;
const sceneryRoot = doc.createNode('Rwanda_Official_Scenery').setExtras({
  replaces: [],
  credits,
  counts: { acacia: count('acacia'), shrub: count('shrub') },
});
scene.addChild(sceneryRoot);
root.setDefaultScene(scene);

// Every lap's centreline (track_data.json, so export_json.py runs first), binned to find the trees beside it
const lapCells = new Map();
for (const id of LAPS)
  for (const { p } of JSON.parse(readFileSync(join(ROOT, `public/tracks/${id}/track_data.json`), 'utf8')).samples) {
    const k = `${Math.floor(p[0] / NEAR_TRACK_M)}:${Math.floor(p[2] / NEAR_TRACK_M)}`;
    if (!lapCells.has(k)) lapCells.set(k, []);
    lapCells.get(k).push(p);
  }
const besideTrack = (x, z) => {
  const cx = Math.floor(x / NEAR_TRACK_M);
  const cz = Math.floor(z / NEAR_TRACK_M);
  for (let i = cx - 1; i <= cx + 1; i++)
    for (let j = cz - 1; j <= cz + 1; j++)
      for (const p of lapCells.get(`${i}:${j}`) ?? []) if (Math.hypot(p[0] - x, p[2] - z) < NEAR_TRACK_M) return true;
  return false;
};
const tiles = new Map();
let beside = 0;
for (const p of trees) {
  const near = besideTrack(p.x, p.z);
  if (near) beside++;
  const size = near ? NEAR_TILE_M : FAR_TILE_M;
  const key = `${p.m}:${near ? 'near' : 'far'}:${Math.floor(p.x / size)}:${Math.floor(p.z / size)}`;
  if (!tiles.has(key)) tiles.set(key, []);
  tiles.get(key).push(p);
}
for (const [key, list] of [...tiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const [model] = key.split(':');
  // Hash order: the first N of a tile are an even spread of it
  list.sort((a, b) => hash(a.x, a.z, 9) - hash(b.x, b.z, 9));
  const n = list.length;
  const t = new Float32Array(n * 3);
  const r = new Float32Array(n * 4);
  const s = new Float32Array(n * 3);
  const c = new Float32Array(n * 3);
  list.forEach((p, i) => {
    t.set([p.x, p.y - SINK_M * p.s, p.z], 3 * i);
    r.set([0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)], 4 * i);
    s.set([p.s, p.s, p.s], 3 * i);
    // Tint: ±10 % brightness, a little hue drift
    const lum = 0.9 + 0.2 * hash(p.x, p.z, 7);
    const drift = hash(p.z, p.x, 11) - 0.5;
    c.set([lum * (1 + 0.12 * drift), lum, lum * (1 - 0.1 * drift)], 3 * i);
  });
  const attrs = { TRANSLATION: accessor('VEC3', t), ROTATION: accessor('VEC4', r), SCALE: accessor('VEC3', s), _COLOR_0: accessor('VEC3', c) };
  levels[model].forEach(({ mesh, when, share, grow }, level) => {
    const batch = instancing.createInstancedMesh();
    const m = share ? Math.max(1, Math.ceil(n * share)) : n;
    const own = share
      ? { TRANSLATION: accessor('VEC3', t.slice(0, 3 * m)), ROTATION: accessor('VEC4', r.slice(0, 4 * m)), SCALE: accessor('VEC3', s.slice(0, 3 * m).map((v) => v * grow)), _COLOR_0: accessor('VEC3', c.slice(0, 3 * m)) }
      : attrs;
    for (const [sem, a] of Object.entries(own)) batch.setAttribute(sem, a);
    const node = doc.createNode(`Scenery_${key.replace(/:/g, '_')}${level ? `_LOD${level}` : ''}`).setMesh(mesh).setExtras({ tile: key, ...when });
    node.setExtension('EXT_mesh_gpu_instancing', batch);
    sceneryRoot.addChild(node);
  });
}

root.getAsset().generator = 'LibreCorsa scripts/rwanda-official/foliage.mjs';
await doc.transform(prune({ keepAttributes: true, keepIndices: true }), dedup());
mkdirSync(dirname(OUT), { recursive: true });
await io.write(OUT, doc);
writeFileSync(join(dirname(OUT), 'credits.json'), JSON.stringify(credits, null, 2) + '\n');
const tri = (m) => m.listPrimitives().reduce((sum, p) => sum + p.getIndices().getCount() / 3, 0);
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB): ${tiles.size} tiles, ${trees.length} instances of ${planted.length} planted ` +
  `(${count('acacia')} acacias, ${count('shrub')} shrubs; ${beside} beside the track in ${[...tiles.keys()].filter((k) => k.includes(':near:')).length} small tiles); levels ` +
  Object.entries(levels).map(([m, l]) => `${m} ${l.map((x) => `${tri(x.mesh)} tris ${JSON.stringify(x.when)}`).join(' / ')}`).join('; '));
console.log('copyright:', root.getAsset().copyright);
