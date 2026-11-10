// The trees of the official Rwanda layout as plain meshes for the Assetto Corsa project (bl_ac.py): the game's
// instanced tiles (public/tracks/rwanda_official/scenery/foliage.glb) baked into one mesh per tile and material, each
// under 60,000 vertices. Beside the track the acacias take their third level and the shrubs their second, the rest
// of the site the lightest one.
//
//   node scripts/rwanda-official/ac_trees.mjs          ->  scripts/rwanda-official/data/ac_trees.glb
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../public/tracks/rwanda_official/scenery/foliage.glb');
const OUT = join(HERE, 'data/ac_trees.glb');
const MAX_VERTS = 60000;
/** The level each kind of tile is baked at (a tile without that level is left out) */
const LEVEL = { 'acacia:near': 2, 'acacia:far': 3, 'shrub:near': 1 };

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const src = await io.read(SRC);

const rot = (q, v) => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};

/** material name -> { material, chunks: [{ pos, nrm, uv, idx }] } */
const groups = new Map();
const chunkFor = (material, adding) => {
  const name = material.getName();
  if (!groups.has(name)) groups.set(name, { material, chunks: [{ pos: [], nrm: [], uv: [], idx: [] }] });
  const g = groups.get(name);
  let c = g.chunks[g.chunks.length - 1];
  if (c.pos.length / 3 + adding > MAX_VERTS) {
    c = { pos: [], nrm: [], uv: [], idx: [] };
    g.chunks.push(c);
  }
  return c;
};

let trees = 0;
let tris = 0;
for (const node of src.getRoot().listNodes()) {
  const ex = node.getExtras();
  const batch = node.getExtension('EXT_mesh_gpu_instancing');
  if (!batch || !node.getMesh() || typeof ex.tile !== 'string') continue;
  const [model, band] = ex.tile.split(':');
  if (LEVEL[`${model}:${band}`] !== (ex.level ?? 0)) continue;
  const T = batch.getAttribute('TRANSLATION');
  const R = batch.getAttribute('ROTATION');
  const S = batch.getAttribute('SCALE');
  const n = T.getCount();
  for (const prim of node.getMesh().listPrimitives()) {
    const P = prim.getAttribute('POSITION');
    const N = prim.getAttribute('NORMAL');
    const U = prim.getAttribute('TEXCOORD_0');
    const I = prim.getIndices();
    const nv = P.getCount();
    const p = [0, 0, 0];
    const q = [0, 0, 0, 1];
    const s = [1, 1, 1];
    const t = [0, 0, 0];
    const u = [0, 0];
    for (let i = 0; i < n; i++) {
      T.getElement(i, t);
      if (R) R.getElement(i, q);
      if (S) S.getElement(i, s);
      const c = chunkFor(prim.getMaterial(), nv);
      const base = c.pos.length / 3;
      for (let v = 0; v < nv; v++) {
        P.getElement(v, p);
        const w = rot(q, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
        c.pos.push(w[0] + t[0], w[1] + t[1], w[2] + t[2]);
        if (N) {
          N.getElement(v, p);
          const m = rot(q, p);
          c.nrm.push(m[0], m[1], m[2]);
        } else c.nrm.push(0, 1, 0);
        if (U) {
          U.getElement(v, u);
          c.uv.push(u[0], u[1]);
        } else c.uv.push(0, 0);
      }
      const ni = I ? I.getCount() : nv;
      for (let k = 0; k < ni; k++) c.idx.push(base + (I ? I.getScalar(k) : k));
      tris += ni / 3;
    }
    if (prim === node.getMesh().listPrimitives()[0]) trees += n;
  }
}

// ---- a plain document: one node per chunk, the materials and their textures as they are ----
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('trees');
const texCopy = new Map();
const copyTexture = (tex) => {
  if (!tex) return null;
  if (!texCopy.has(tex)) texCopy.set(tex, doc.createTexture(tex.getName() || 'tree').setImage(tex.getImage()).setMimeType(tex.getMimeType()));
  return texCopy.get(tex);
};
let nodes = 0;
for (const [name, g] of groups) {
  const m = g.material;
  const mat = doc.createMaterial(`Tree_${name}`).setBaseColorFactor(m.getBaseColorFactor()).setBaseColorTexture(copyTexture(m.getBaseColorTexture()))
    .setAlphaMode(m.getAlphaMode()).setAlphaCutoff(m.getAlphaCutoff()).setDoubleSided(m.getDoubleSided()).setRoughnessFactor(1).setMetallicFactor(0);
  g.chunks.forEach((c, i) => {
    if (!c.idx.length) return;
    const prim = doc.createPrimitive().setMaterial(mat)
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(c.pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(c.nrm)).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(c.uv)).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(c.idx)).setBuffer(buffer));
    scene.addChild(doc.createNode(`Trees_${name}_${i}`).setMesh(doc.createMesh(`Trees_${name}_${i}`).addPrimitive(prim)));
    nodes++;
  });
}
await new NodeIO().write(OUT, doc);
console.log(`Wrote ${OUT}: ${trees} trees and shrubs, ${Math.round(tris)} triangles in ${nodes} meshes, materials ${[...groups.keys()].join(', ')}`);
