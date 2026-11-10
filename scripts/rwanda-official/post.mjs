// Turns Blender's export (data/rwanda_official_raw.glb) into the game's circuit file: alpha modes by material name,
// Blender's extra material extensions dropped, textures re-encoded to WebP, unused data pruned, and the mesh data
// packed for the download (EXT_meshopt_compression). Every position stays a float, exactly as exported: the cars
// drive on the visible road, kerbs and run-off, and the lines lie 6 mm over the asphalt, so nothing is rounded to a
// grid. Only normals and vertex colours are stored in 8 bits.
//
//   node scripts/rwanda-official/post.mjs [--report] [--raw]      (--raw: leave the mesh data unpacked)
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'data/rwanda_official_raw.glb');
const OUT = join(HERE, '../../public/tracks/rwanda_official/rwanda_official.glb');
const REPORT = process.argv.includes('--report');
const RAW = process.argv.includes('--raw');

const MASK = new Set(['Fence_Debris']);
const BLEND = new Map([['Collider_Hidden', 0.25]]);
const DOUBLE = new Set(['Fence_Debris', 'Collider_Hidden', 'Flag_Cloth', 'Palm_Leaf']);
const DROP_EXT = ['KHR_materials_specular', 'KHR_materials_ior', 'KHR_materials_emissive_strength', 'KHR_materials_clearcoat',
  'KHR_materials_sheen', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_anisotropy'];

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(SRC);
const root = doc.getRoot();

for (const m of root.listMaterials()) {
  const name = m.getName();
  for (const ext of DROP_EXT) m.setExtension(ext, null);
  if (MASK.has(name)) m.setAlphaMode('MASK').setAlphaCutoff(0.5);
  else if (BLEND.has(name)) {
    const c = m.getBaseColorFactor();
    m.setAlphaMode('BLEND').setBaseColorFactor([c[0], c[1], c[2], BLEND.get(name)]);
  } else m.setAlphaMode('OPAQUE');
  m.setDoubleSided(DOUBLE.has(name));
}
for (const ext of root.listExtensionsUsed()) if (DROP_EXT.includes(ext.extensionName)) ext.dispose();

await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 88, resize: [1024, 1024] }),
  prune({ keepAttributes: true }),
  dedup(),
);
if (!RAW) {
  doc.setLogger({ debug() {}, info() {}, warn() {}, error: console.error });
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(NORMAL|COLOR_\d+)$/, quantizeNormal: 8, quantizeColor: 8 }),
  );
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
}
root.getAsset().generator = 'LibreCorsa scripts/rwanda-official (Blender)';

mkdirSync(dirname(OUT), { recursive: true });
await io.write(OUT, doc);

const tris = (mesh) => mesh.listPrimitives().reduce((n, p) => n + (p.getIndices()?.getCount() ?? p.getAttribute('POSITION').getCount()) / 3, 0);
let total = 0;
const scene = root.listScenes()[0];
for (const node of scene.listChildren()) {
  const mesh = node.getMesh();
  const t = mesh ? tris(mesh) : 0;
  total += t;
  if (REPORT) {
    const prims = mesh ? mesh.listPrimitives().map((p) => `${p.getMaterial()?.getName()}[${p.listSemantics().join(',')}]`).join(' ') : '';
    console.log(`${node.getName().padEnd(30)} ${String(t).padStart(7)}  ${JSON.stringify(node.getExtras())}  ${prims}`);
  }
}
if (REPORT) {
  for (const m of root.listMaterials()) console.log('mat', m.getName(), m.getAlphaMode(), m.getDoubleSided() ? 'double' : '', 'rough', m.getRoughnessFactor().toFixed(2), 'metal', m.getMetallicFactor().toFixed(2), 'base', m.getBaseColorFactor().map((v) => v.toFixed(2)).join(','), m.getBaseColorTexture() ? 'tex' : '');
  for (const t of root.listTextures()) console.log('tex', t.getName(), t.getMimeType(), t.getSize()?.join('x'), `${(t.getImage().byteLength / 1024).toFixed(0)} KB`);
  console.log('extensions', root.listExtensionsUsed().map((e) => e.extensionName).join(', '));
}
console.log(`Wrote ${OUT}: ${(statSync(OUT).size / 1e6).toFixed(2)} MB, ${scene.listChildren().length} nodes, ${total} triangles`);
