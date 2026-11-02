// Builds public/tracks/rwanda/scenery/foliage.glb: openly licensed trees and shrubs instanced where Rwanda's own
// low-poly trees (Env_Trees) and third-party tree/bush cards (Env_Foliage) stand in rwanda_2026.glb. The circuit GLB
// is not changed; at runtime the loader hides the nodes this file lists in `extras.replaces`, so they stay as the
// fallback if it does not load.
//
//   node scripts/rwanda-scenery.mjs --tree <acacia.glb> --shrub <shrub.glb> [--track <rwanda_2026.glb>] [--out <file>]
//
// --tree / --shrub are the source downloads (Sketchfab glTF-binary, kept outside the repo). Per model: transforms
// baked into the vertices (Sketchfab wraps them in a Z-up, centimetre root), the primitives joined into one mesh,
// tangents, normal and roughness maps dropped, the bark simplified, the leaves tinted darker with their cut-outs filled
// with the leaf colour and their normals turned towards the crown, colour textures re-encoded to WebP, base on y = 0.
// Placements come from the circuit: each tree or card is found as a welded piece, then
//  - Env_Trees (520 trees) and the tall tree cards (528) become acacias scaled to the piece's height and width;
//  - the bush cards (1,372) become an acacia when 6 m or taller, otherwise a pair of shrubs.
// Instances are grouped into 250 m tiles (one EXT_mesh_gpu_instancing node per tile and model, so the renderer can
// cull them by tile), ordered by a hash so the first N of a tile are an even subset (Low quality draws fewer), with a
// hashed yaw and tint. Credits (title, author, source, licence, changes) go in `asset.copyright` and root `extras`.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { dedup, flatten, mergeDocuments, prune, simplifyPrimitive, textureCompress, transformMesh, unpartition, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const TREE_SRC = args.tree;
const SHRUB_SRC = args.shrub;
const TRACK = args.track ?? join(ROOT, 'public/tracks/rwanda/rwanda_2026.glb');
const OUT = args.out ?? join(ROOT, 'public/tracks/rwanda/scenery/foliage.glb');
if (!TREE_SRC || !SHRUB_SRC) {
  console.error('usage: node scripts/rwanda-scenery.mjs --tree <acacia.glb> --shrub <shrub.glb> [--track <glb>] [--out <glb>]');
  process.exit(1);
}

/** Who made each model and what was changed (CC BY 4.0 requires both) */
export const CREDITS = [
  {
    id: 'acacia',
    title: 'Acacia tree',
    author: 'evolveduk',
    url: 'https://sketchfab.com/3d-models/acacia-tree-bb14c2bb679b4d0bb1c578a27e2ddabf',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: 'bark simplified, normal maps dropped, leaves toned darker with crown-shaped normals, textures re-encoded to WebP, instanced at the circuit\'s tree spots',
  },
  {
    id: 'shrub',
    title: 'Cliff Shrub For Terrain',
    author: 'Natural_Disbuster (lemedesign)',
    url: 'https://sketchfab.com/3d-models/cliff-shrub-for-terrain-7a0f2bf2982c4ff8bacc67856fdbfae2',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: 'normal map dropped, leaves toned darker with crown-shaped normals, texture re-encoded to WebP, instanced at the circuit\'s bush spots',
  },
];

const REPLACES = ['Env_Trees', 'Env_Foliage'];
const TILE_M = 250;
/** Bush cards this tall and up become acacias; lower ones a pair of shrubs */
const BUSH_TO_TREE_M = 6;
/** Fraction of the bark's triangles kept (it carries ~93 % of the tree's triangles; the leaf cards make the shape) */
const BARK_KEEP = 0.05;
const TEXTURE_PX = 1024;
/** Sunk into the ground so a slope never shows a floating base */
const SINK_M = 0.15;
/** How far the leaf cards' normals turn towards the crown's outward normal (0 = as modelled, 1 = a smooth crown) */
const CROWN_NORMALS = 0.75;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': undefined });
await MeshoptSimplifier.ready;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * One mesh, transforms baked in, base on y = 0, only colour textures; returns its document and size. `leafTint`
 * multiplies the leaves' (alpha-masked) colour: both textures were made for a bright studio render and read pale and
 * yellow under the circuit's golden-hour light.
 */
async function prototype(path, name, { simplifyMaterial = null, leafTint }) {
  const doc = await io.read(path);
  await doc.transform(flatten());
  const root = doc.getRoot();
  const mesh = doc.createMesh(name);
  for (const node of root.listNodes()) {
    const m = node.getMesh();
    if (!m) continue;
    transformMesh(m, node.getWorldMatrix());
    for (const p of m.listPrimitives()) {
      mesh.addPrimitive(p);
      m.removePrimitive(p);
    }
  }
  for (const node of root.listNodes()) node.dispose();
  for (const scene of root.listScenes()) scene.dispose();
  const node = doc.createNode(name).setMesh(mesh);
  doc.createScene(name).addChild(node);

  for (const p of mesh.listPrimitives()) {
    for (const sem of ['TANGENT', 'TEXCOORD_1', 'COLOR_0']) if (p.getAttribute(sem)) p.setAttribute(sem, null);
    const mat = p.getMaterial();
    if (mat) {
      mat.setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null).setMetallicRoughnessTexture(null);
      mat.setMetallicFactor(0).setRoughnessFactor(0.92).setDoubleSided(true);
      if (mat.getAlphaMode() === 'MASK') {
        mat.setBaseColorFactor([...leafTint, 1]).setAlphaCutoff(0.45);
        const tex = mat.getBaseColorTexture();
        if (tex) await bleedLeafColour(tex);
      }
    }
  }
  await doc.transform(weld(), dedup());
  if (simplifyMaterial) {
    for (const p of mesh.listPrimitives()) {
      if (p.getMaterial()?.getName() !== simplifyMaterial) continue;
      const before = p.getIndices().getCount() / 3;
      simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: BARK_KEEP, error: 0.02, lockBorder: false });
      console.log(`  ${name}: ${simplifyMaterial} ${before} → ${p.getIndices().getCount() / 3} triangles`);
    }
  }
  // Base on y = 0, trunk (the model's origin) at x = z = 0
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      minY = Math.min(minY, v[1]);
      maxY = Math.max(maxY, v[1]);
      minX = Math.min(minX, v[0]);
      maxX = Math.max(maxX, v[0]);
      minZ = Math.min(minZ, v[2]);
      maxZ = Math.max(maxZ, v[2]);
    }
  }
  transformMesh(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -minY, 0, 1]);
  for (const p of mesh.listPrimitives()) if (p.getMaterial()?.getAlphaMode() === 'MASK') crownNormals(p);
  await doc.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [TEXTURE_PX, TEXTURE_PX], quality: 82 }),
    prune({ keepAttributes: true, keepIndices: true })
  );
  const tris = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute('POSITION').getCount() / 3), 0);
  const size = { height: maxY - minY, width: Math.max(maxX - minX, maxZ - minZ) };
  console.log(`  ${name}: ${tris} triangles, ${size.height.toFixed(2)} m tall, ${size.width.toFixed(2)} m wide`);
  return { doc, name, size, tris };
}

/**
 * The leaf textures' cut-out (transparent) texels carry a paler colour than the leaves. Far away the mip levels
 * average the two, and the runtime's coverage boost keeps those texels, so distant crowns turned grey. Filling the
 * cut-outs with the leaves' mean colour keeps every mip the colour of the leaves.
 */
const bled = new WeakSet();
async function bleedLeafColour(tex) {
  if (bled.has(tex)) return;
  bled.add(tex);
  const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    for (let k = 0; k < 3; k++) sum[k] += data[i + k];
    n++;
  }
  if (n === 0) return;
  const mean = sum.map((x) => Math.round(x / n));
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] < 128) data.set(mean, i);
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  tex.setImage(new Uint8Array(png)).setMimeType('image/png');
}

/**
 * Leaf cards lit by their own normals shade as noise: each card faces a different way. Turning the normals towards
 * the outward normal of the crown's bounding ellipsoid shades the crown as one volume, lit on the sun's side and
 * darker away from it. The runtime keeps these normals on both faces of a card (scenery-instances.ts), so a card
 * seen from behind is lit like its crown, not flipped dark.
 */
function crownNormals(prim) {
  const pos = prim.getAttribute('POSITION');
  const nor = prim.getAttribute('NORMAL');
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  }
  const c = lo.map((l, k) => (l + hi[k]) / 2);
  const r = lo.map((l, k) => Math.max((hi[k] - l) / 2, 0.1));
  const n = [0, 0, 0];
  const out = new Float32Array(pos.getCount() * 3);
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, v);
    nor.getElement(i, n);
    // Ellipsoid normal: gradient of sum((x - c)^2 / r^2)
    const e = v.map((x, k) => (x - c[k]) / (r[k] * r[k]));
    const el = Math.hypot(...e) || 1;
    const dot = n[0] * e[0] + n[1] * e[1] + n[2] * e[2];
    const s = dot < 0 ? -1 : 1;
    const m = n.map((x, k) => (1 - CROWN_NORMALS) * s * x + (CROWN_NORMALS * e[k]) / el);
    const ml = Math.hypot(...m) || 1;
    out.set(m.map((x) => x / ml), 3 * i);
  }
  nor.setArray(out);
}

// ---------------------------------------------------------------------------
// Placements from the circuit
// ---------------------------------------------------------------------------

/** Welded connected pieces of a primitive: bounds and centroid of each */
function pieces(prim) {
  const pos = prim.getAttribute('POSITION');
  const n = pos.getCount();
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const weldMap = new Map();
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const k = `${Math.round(v[0] * 1000)},${Math.round(v[1] * 1000)},${Math.round(v[2] * 1000)}`;
    const first = weldMap.get(k);
    if (first === undefined) weldMap.set(k, i);
    else union(i, first);
  }
  const idx = prim.getIndices();
  const triCount = idx ? idx.getCount() / 3 : n / 3;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getScalar(3 * t) : 3 * t;
    const b = idx ? idx.getScalar(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getScalar(3 * t + 2) : 3 * t + 2;
    union(a, b);
    union(b, c);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0], n: 0 };
      groups.set(r, g);
    }
    for (let a = 0; a < 3; a++) {
      g.min[a] = Math.min(g.min[a], v[a]);
      g.max[a] = Math.max(g.max[a], v[a]);
      g.sum[a] += v[a];
    }
    g.n++;
  }
  return [...groups.values()].map((g) => ({
    cx: g.sum[0] / g.n,
    cz: g.sum[2] / g.n,
    minY: g.min[1],
    maxY: g.max[1],
    height: g.max[1] - g.min[1],
    width: Math.max(g.max[0] - g.min[0], g.max[2] - g.min[2]),
  }));
}

/** Stable 0..1 hash of a position */
function hash(x, z, salt = 0) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The ground the physics drives on (the circuit's `surface`-tagged meshes: terrain, road, kerbs, run-off, pit lane):
 * under (x, z), the highest triangle at or below `probeY`, its surface and height. XZ point-in-triangle on an 8 m
 * grid with barycentric height; these nodes carry no transforms, so their vertices are world positions.
 */
function groundSampler(doc) {
  const CELL = 8;
  const cells = new Map();
  const tris = [];
  for (const node of doc.getRoot().listNodes()) {
    const surface = node.getExtras()?.surface;
    if (typeof surface !== 'string') continue;
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const pt = (i) => pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]);
      for (let i = 0; i + 2 < n; i += 3) {
        const t = { a: pt(i), b: pt(i + 1), c: pt(i + 2), surface };
        const k = tris.push(t) - 1;
        const xs = [t.a[0], t.b[0], t.c[0]];
        const zs = [t.a[2], t.b[2], t.c[2]];
        for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++)
          for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
            const key = `${cx},${cz}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(k);
          }
      }
    }
  }
  return (x, z, probeY = Infinity) => {
    let best = null;
    for (const k of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const { a, b, c, surface } = tris[k];
      const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const height = l1 * a[1] + l2 * b[1] + l3 * c[1];
      if (height <= probeY && (!best || height > best.height)) best = { height, surface };
    }
    return best;
  };
}

const NO_GROWTH = new Set(['road', 'kerb', 'sausage', 'pitlane']);

async function placements(acacia, shrub) {
  const doc = await io.read(TRACK);
  const byName = Object.fromEntries(doc.getRoot().listNodes().map((n) => [n.getName(), n]));
  const prims = (node) => node?.getMesh()?.listPrimitives() ?? [];
  const ground = groundSampler(doc);
  const out = [];
  let skipped = 0;
  const place = (p) => {
    // On the ground the cars drive on: the old cards' lowest vertex was often off it (on slopes, a crossed card
    // reaches below or above). The circuit's own layout also has a tree or two on a driving surface (the pit
    // lane); those are not carried over.
    const hit = ground(p.x, p.z, p.y + 10);
    if (hit && NO_GROWTH.has(hit.surface)) {
      skipped++;
      return;
    }
    if (hit) p.y = hit.height - (p.model === 'acacia' ? SINK_M : SINK_M * 0.5);
    out.push(p);
  };
  const tree = (x, y, z, height, width, source) => {
    // Between the piece's height and width ratios: a short wide tree and a tall narrow one both read right
    const s = Math.sqrt((height / acacia.size.height) * (width / acacia.size.width));
    place({ model: 'acacia', x, y: y - SINK_M, z, scale: Math.min(2.4, Math.max(0.45, s)), source });
  };

  // Env_Trees: a trunk and a canopy per tree; pair each canopy with the nearest trunk
  const trunks = pieces(prims(byName.Env_Trees).find((p) => p.getMaterial()?.getName() === 'Tree_Trunk'));
  const canopies = pieces(prims(byName.Env_Trees).find((p) => p.getMaterial()?.getName() === 'Tree_Canopy'));
  for (const c of canopies) {
    let best = null;
    let bestD = Infinity;
    for (const t of trunks) {
      const d = (t.cx - c.cx) ** 2 + (t.cz - c.cz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    tree(best.cx, best.minY, best.cz, c.maxY - best.minY, c.width, 'Env_Trees');
  }

  // Env_Foliage: tall tree cards and bush cards
  for (const p of prims(byName.Env_Foliage)) {
    const name = p.getMaterial()?.getName();
    for (const g of pieces(p)) {
      if (name === 'KN5_mat352' || g.height >= BUSH_TO_TREE_M) {
        tree(g.cx, g.minY, g.cz, g.height, g.width, 'Env_Foliage');
        continue;
      }
      // A pair of shrubs across the card's footprint
      const dir = hash(g.cx, g.cz, 1) * Math.PI * 2;
      const r = g.width * 0.18;
      for (const side of [-1, 1]) {
        const s = Math.min(4, Math.max(1.2, (0.8 * g.height) / shrub.size.height)) * (0.85 + 0.3 * hash(g.cx, g.cz, side + 3));
        place({ model: 'shrub', x: g.cx + side * r * Math.cos(dir), y: g.minY - SINK_M * 0.5, z: g.cz + side * r * Math.sin(dir), scale: s, source: 'Env_Foliage' });
      }
    }
  }
  return { list: out, skipped };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

console.log('Models');
const acacia = await prototype(TREE_SRC, 'Acacia', { simplifyMaterial: 'bark05_0Mat', leafTint: [0.4, 0.55, 0.3] });
const shrub = await prototype(SHRUB_SRC, 'Shrub', { leafTint: [0.55, 0.45, 0.4] });
console.log('Placements');
const { list: all, skipped } = await placements(acacia, shrub);
const count = (m) => all.filter((p) => p.model === m).length;
console.log(`  ${count('acacia')} acacias, ${count('shrub')} shrubs (${skipped} skipped: on a driving surface)`);

const doc = await io.read(TREE_SRC); // a container to merge into; emptied first
for (const p of doc.getRoot().listNodes()) p.dispose();
for (const p of doc.getRoot().listScenes()) p.dispose();
for (const p of doc.getRoot().listMeshes()) p.dispose();
await doc.transform(prune());
for (const proto of [acacia, shrub]) mergeDocuments(doc, proto.doc);
// mergeDocuments brings the models' own scenes and nodes; keep only their meshes
for (const p of doc.getRoot().listNodes()) p.dispose();
for (const p of doc.getRoot().listScenes()) p.dispose();
const meshes = Object.fromEntries(doc.getRoot().listMeshes().map((m) => [m.getName(), m]));

const instancing = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const scene = doc.createScene('Rwanda_Scenery');
const sceneryRoot = doc.createNode('Rwanda_Scenery').setExtras({
  replaces: REPLACES,
  credits: CREDITS,
  counts: { acacia: count('acacia'), shrub: count('shrub'), skippedOnTrack: skipped },
});
scene.addChild(sceneryRoot);

const tiles = new Map();
for (const p of all) {
  const key = `${p.model}:${Math.floor(p.x / TILE_M)}:${Math.floor(p.z / TILE_M)}`;
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
    t.set([p.x, p.y, p.z], 3 * i);
    const yaw = hash(p.x, p.z, 5) * Math.PI * 2;
    r.set([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], 4 * i);
    s.set([p.scale, p.scale, p.scale], 3 * i);
    // Tint: ±10 % brightness, a little hue drift
    const lum = 0.9 + 0.2 * hash(p.x, p.z, 7);
    const drift = hash(p.z, p.x, 11) - 0.5;
    c.set([lum * (1 + 0.12 * drift), lum, lum * (1 - 0.1 * drift)], 3 * i);
  });
  const batch = instancing
    .createInstancedMesh()
    .setAttribute('TRANSLATION', accessor('VEC3', t))
    .setAttribute('ROTATION', accessor('VEC4', r))
    .setAttribute('SCALE', accessor('VEC3', s))
    .setAttribute('_COLOR_0', accessor('VEC3', c));
  const node = doc.createNode(`Scenery_${key.replace(/:/g, '_')}`).setMesh(meshes[model === 'acacia' ? 'Acacia' : 'Shrub']);
  node.setExtension('EXT_mesh_gpu_instancing', batch);
  sceneryRoot.addChild(node);
}

doc.getRoot().getAsset().copyright = CREDITS.map((cr) => `"${cr.title}" by ${cr.author} (${cr.url}), ${cr.license}; changes: ${cr.changes}`).join(' | ');
doc.getRoot().getAsset().generator = 'LibreCorsa scripts/rwanda-scenery.mjs';
doc.getRoot().getAsset().extras = {};
await doc.transform(unpartition(), prune({ keepAttributes: true, keepIndices: true }), dedup());
mkdirSync(dirname(OUT), { recursive: true });
await io.write(OUT, doc);
writeFileSync(join(dirname(OUT), 'credits.json'), JSON.stringify(CREDITS, null, 2) + '\n');
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB): ${tiles.size} tiles, ${all.length} instances, ` +
  `${acacia.tris} + ${shrub.tris} triangles per tree / shrub`);
