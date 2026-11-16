// RISE Motordrome's Assetto Corsa release on the game's model: takes the Blender build (post.mjs's output, kept as
// data/rwanda_official_blender.glb) and what ac_import.py read from the release (data/ac/), and writes the game's
// circuit file.
//
//   - the scenery the release added goes in as new top-level nodes (shadows as ac_import.py set them; flat ground
//     pieces drawn as decals over the terrain);
//   - the main model's meshes the release changed, and the barrier colliders it moved to its Tecpro, take the
//     release's geometry under the game's own node (name, extras and materials kept);
//   - ext_config.ini's colour and texture changes go onto the game's materials, and its multilayer grass colours onto
//     the grass nodes' vertex colours (a texture the release made for one object, the forest sheet's, replaces that
//     node's vertex colours, which the release had baked into the texture it replaces).
//
// Every surface the cars drive on is the Blender build's, untouched. Materials of the release that the game already
// has (by name) are the game's, so a building of the village is shaded like the paddock's.
//
//   node scripts/rwanda-official/ac_merge.mjs [--base <glb>] [--report]
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization, KHRTextureTransform } from '@gltf-transform/extensions';
import { mergeDocuments, prune, quantize, reorder, textureCompress, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', join(HERE, 'data/rwanda_official_blender.glb'));
const AC = join(HERE, 'data/ac');
const OUT = join(HERE, '../../public/tracks/rwanda_official/rwanda_official.glb');
const REPORT = process.argv.includes('--report');
/** ext_config's multilayer tints act on the release's colours as drawn (sRGB); the game's vertex colours are linear */
const GAMMA = 2.2;

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(BASE);
const root = doc.getRoot();
if (root.listNodes().some((n) => n.getName().startsWith('Ground_Lakeside_'))) {
  throw new Error(`${BASE} already carries the release's scenery: start from post.mjs's output`);
}
const look = JSON.parse(readFileSync(join(AC, 'look.json'), 'utf8'));
const baseMats = new Map(root.listMaterials().map((m) => [m.getName(), m]));
const baseNodes = new Map(root.listNodes().map((n) => [n.getName(), n]));

const pngTexture = (file) =>
  doc.createTexture(file.replace(/\.png$/, '')).setMimeType('image/png').setImage(readFileSync(join(AC, 'tex', file)));

// The look: colours and textures from ext_config.ini on the game's materials
const transform = doc.createExtension(KHRTextureTransform);
for (const [name, change] of Object.entries(look.materials)) {
  const mat = baseMats.get(name);
  if (!mat) continue; // the release's own materials (its trees, the outer horizon) the game does not carry
  if (change.colourMultiply) {
    const c = mat.getBaseColorFactor();
    mat.setBaseColorFactor([0, 1, 2].map((k) => Math.min(1, c[k] * change.colourMultiply[k])).concat(c[3]));
  }
  if (change.baseColorTexture) mat.setBaseColorTexture(pngTexture(change.baseColorTexture));
  if (change.normalTexture) mat.setNormalTexture(pngTexture(change.normalTexture)).setNormalScale(1);
  if (change.uvScale) {
    for (const info of [mat.getBaseColorTextureInfo(), mat.getNormalTextureInfo()]) {
      info?.setExtension('KHR_texture_transform', transform.createTransform().setScale(change.uvScale));
    }
  }
}
for (const [name, tint] of Object.entries(look.vertexColour)) {
  const node = baseNodes.get(name);
  if (!node) throw new Error(`no node ${name} for its ground colour`);
  const k = tint.map((t) => t ** GAMMA);
  for (const prim of node.getMesh().listPrimitives()) {
    const src = prim.getAttribute('COLOR_0');
    if (!src) throw new Error(`${name} has no vertex colours`);
    const col = src.clone();
    const e = [];
    for (let i = 0; i < col.getCount(); i++) {
      col.getElement(i, e);
      for (let c = 0; c < 3; c++) e[c] = Math.min(1, e[c] * k[c]);
      col.setElement(i, e);
    }
    prim.setAttribute('COLOR_0', col);
  }
}

for (const name of look.dropVertexColour ?? []) {
  const node = baseNodes.get(name);
  if (!node) throw new Error(`no node ${name} to take its new texture alone`);
  for (const prim of node.getMesh().listPrimitives()) prim.setAttribute('COLOR_0', null);
}

// The meshes
const layers = await io.read(join(AC, 'layers.glb'));
const layerScene = layers.getRoot().listScenes()[0];
/**
 * The added buildings, props and plants in 16 bits, over one uniform scale per node (so normals stay true): a
 * centimetre or two at most, on things no car touches. Ground pieces keep their float positions, as they lie on
 * the terrain like the game's own; so do the replaced meshes (the lines lie 6 mm over the road) and the colliders.
 */
const quantizeNode = (node) => {
  const prims = node.getMesh().listPrimitives();
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) {
    const a = p.getAttribute('POSITION');
    const mn = a.getMin([]);
    const mx = a.getMax([]);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], mn[k]);
      hi[k] = Math.max(hi[k], mx[k]);
    }
  }
  const c = lo.map((v, k) => (v + hi[k]) / 2);
  const s = Math.max(...hi.map((v, k) => (v - lo[k]) / 2), 1e-3);
  for (const p of prims) {
    const a = p.getAttribute('POSITION');
    const f = a.getArray();
    const q = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) q[i] = Math.round(((f[i] - c[i % 3]) / s) * 32767);
    p.setAttribute('POSITION', layers.createAccessor().setType('VEC3').setArray(q).setNormalized(true).setBuffer(a.getBuffer()));
  }
  node.setTranslation(c).setScale([s, s, s]);
};
for (const n of layerScene.listChildren()) {
  if (n.getExtras().ac === 'add' && !n.getName().startsWith('Ground_')) quantizeNode(n);
}
const map = mergeDocuments(doc, layers);
const scene = root.getDefaultScene() ?? root.listScenes()[0];
const useGameMaterials = (mesh) => {
  for (const prim of mesh.listPrimitives()) {
    const game = baseMats.get(prim.getMaterial()?.getName());
    if (game) prim.setMaterial(game);
  }
};
/** Positions and normals from world space into a node's own frame (the Blender build's nodes are all at the origin) */
const intoNodeFrame = (node, mesh) => {
  const m = node.getWorldMatrix();
  const identity = m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);
  if (!identity) throw new Error(`${node.getName()} is not at the origin; its replacement would need moving`);
  return mesh;
};
const counts = { add: 0, replace: 0, collider: 0 };
for (const src of layerScene.listChildren()) {
  const node = map.get(src);
  const { ac, target, castShadow, layer } = node.getExtras();
  const mesh = node.getMesh();
  if (ac === 'add') {
    useGameMaterials(mesh);
    const extras = { castShadow };
    // Flat ground over the terrain (shore bands, paving, paths, the airfield): drawn as decals, as the game's own
    if (node.getName().startsWith('Ground_')) extras.decal = true;
    node.setExtras(extras);
    scene.addChild(node);
  } else if (ac === 'replace' || ac === 'collider') {
    const game = baseNodes.get(target);
    if (!game) throw new Error(`no node ${target} to take the release's ${ac}`);
    if (ac === 'collider') {
      const hidden = game.getMesh().listPrimitives()[0].getMaterial();
      for (const prim of mesh.listPrimitives()) prim.setMaterial(hidden);
    } else {
      useGameMaterials(mesh);
    }
    game.setMesh(intoNodeFrame(game, mesh).setName(game.getMesh().getName()));
    node.dispose();
  } else {
    throw new Error(`${node.getName()}: unknown role ${ac} (${layer})`);
  }
  counts[ac]++;
}
for (const s of root.listScenes()) if (s !== scene) s.dispose();
console.log(`added ${counts.add} nodes, replaced ${counts.replace} meshes and ${counts.collider} colliders`);

doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
await doc.transform(
  unpartition(),
  prune({ keepAttributes: true }),
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88, formats: /png/ }),
  reorder({ encoder: MeshoptEncoder, target: 'size' }),
  quantize({ pattern: /^(NORMAL|COLOR_\d+)$/, quantizeNormal: 8, quantizeColor: 8 }),
);
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
await io.write(OUT, doc);

const tris = (mesh) => mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);
const total = root.listMeshes().reduce((n, m) => n + tris(m), 0);
console.log(`wrote ${OUT}: ${(statSync(OUT).size / 1e6).toFixed(2)} MB, ${Math.round(total).toLocaleString('en')} triangles, ${root.listTextures().length} textures`);
if (REPORT) {
  for (const n of scene.listChildren()) console.log(`  ${n.getName().padEnd(40)} ${n.getMesh() ? Math.round(tris(n.getMesh())) : 0}`);
}
