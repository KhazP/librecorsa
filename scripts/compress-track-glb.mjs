/**
 * Meshopt-compresses circuit GLBs in place (EXT_meshopt_compression + KHR_mesh_quantization).
 *
 *   node scripts/compress-track-glb.mjs public/tracks/suzuka/suzuka.glb [more.glb ...]
 *   node scripts/compress-track-glb.mjs --all          # every circuit in public/tracks/index.json
 *
 * The visual scan is quantized (16-bit positions, 8-bit normals, 14-bit UVs). The hidden physics meshes
 * (Track_Collider_* / Track_Surface_*, or nodes with a `collider` / `hidden` extra) keep their float positions
 * and node transforms, and the script re-reads its output and fails unless every physics vertex is unchanged.
 * Already compressed files are skipped. The browser decodes with three's MeshoptDecoder (src/lib/gltf-loader.ts),
 * the Node scripts with scripts/lib/glb-geometry.ts. Run it after scripts/tracks/build_track.py rebuilds a circuit.
 * The Rwanda GLB is left uncompressed: scripts/smooth-rwanda-track.ts edits it in place.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO, PropertyType } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { prune, quantize, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_POSITION = "_PHYSICS_POSITION";

function trackFiles(args) {
  if (!args.includes("--all")) return args;
  const index = JSON.parse(readFileSync(path.join(ROOT, "public/tracks/index.json"), "utf8"));
  return index.map((t) => path.join(ROOT, "public/tracks", t.id, `${t.id}.glb`)).filter((f) => existsSync(f));
}

function isMeshoptCompressed(file) {
  const buf = readFileSync(file);
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
  return (json.extensionsUsed ?? []).includes("EXT_meshopt_compression");
}

const isPhysicsNode = (node) => {
  const extras = node.getExtras() ?? {};
  return /^Track_(Collider|Surface)_/.test(node.getName()) || Boolean(extras.collider || extras.hidden);
};

/** Meshes under a physics node (the node itself or any descendant) */
function physicsMeshes(doc) {
  const meshes = new Set();
  const walk = (node, inPhysics) => {
    const phys = inPhysics || isPhysicsNode(node);
    if (phys && node.getMesh()) meshes.add(node.getMesh());
    for (const child of node.listChildren()) walk(child, phys);
  };
  for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, false);
  return meshes;
}

/** Each physics mesh's world-space vertices, sorted, so vertex reordering doesn't count as a change */
function physicsVertices(doc) {
  const out = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || !physicsMeshes(doc).has(mesh)) continue;
    const m = node.getWorldMatrix();
    const verts = [];
    for (const prim of mesh.listPrimitives()) {
      // Only vertices the triangles use: compaction drops unreferenced ones from a shared vertex buffer
      const pos = prim.getAttribute("POSITION");
      const indices = prim.getIndices();
      const used = indices ? [...new Set(indices.getArray())] : [...Array(pos.getCount()).keys()];
      const el = [0, 0, 0];
      for (const i of used) {
        pos.getElement(i, el);
        const [x, y, z] = el;
        verts.push([
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ]);
      }
    }
    verts.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    out.set(`${node.getName() || mesh.getName()}#${out.size}`, verts);
  }
  return out;
}

function maxPhysicsError(before, after) {
  if (before.size !== after.size) return Infinity;
  let worst = 0;
  const a = [...before.values()];
  const b = [...after.values()];
  for (let k = 0; k < a.length; k++) {
    if (a[k].length !== b[k].length) return Infinity;
    for (let i = 0; i < a[k].length; i++)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[k][i][c] - b[k][i][c]));
  }
  return worst;
}

const files = trackFiles(process.argv.slice(2));
if (files.length === 0) {
  console.error("usage: node scripts/compress-track-glb.mjs <file.glb ...> | --all");
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
// glTF-Transform logs every UV set it leaves as float (tiling UVs outside [0, 1]); keep the output readable
const quiet = { debug() {}, info() {}, warn() {}, error: console.error };

let before = 0;
let after = 0;
for (const file of files) {
  const size0 = statSync(file).size;
  if (isMeshoptCompressed(file)) {
    console.log(`${path.basename(file)}: already compressed (${(size0 / 1e6).toFixed(1)} MB)`);
    continue;
  }
  const doc = await io.read(file);
  doc.setLogger(quiet);
  const reference = physicsVertices(doc);

  // Park the physics meshes' float positions on a custom attribute the quantizer skips, and remember their nodes
  const physics = physicsMeshes(doc);
  const savedNodes = new Map();
  for (const mesh of physics) {
    savedNodes.set(mesh, new Map(mesh.listParents().filter((p) => p.propertyType === PropertyType.NODE).map((n) => [n, n.getMatrix()])));
    for (const prim of mesh.listPrimitives()) prim.setAttribute(RAW_POSITION, prim.getAttribute("POSITION"));
  }

  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: "size" }),
    quantize({
      pattern: new RegExp(`^(?!${RAW_POSITION}$)`),
      quantizePosition: 16,
      quantizeNormal: 8,
      quantizeTexcoord: 14,
      quantizeColor: 8,
      quantizeGeneric: 12,
    })
  );

  // Put the float positions back and undo the dequantization transform on the physics nodes
  for (const mesh of physics) {
    for (const prim of mesh.listPrimitives()) {
      prim.setAttribute("POSITION", prim.getAttribute(RAW_POSITION));
      prim.setAttribute(RAW_POSITION, null);
    }
    const saved = savedNodes.get(mesh);
    for (const node of mesh.listParents().filter((p) => p.propertyType === PropertyType.NODE)) {
      if (saved.has(node)) {
        node.setMatrix(saved.get(node));
      } else {
        // quantize() moved the mesh onto a new unnamed child; hang it back on its original node
        const parent = node.getParentNode();
        parent.setMesh(mesh);
        node.dispose();
      }
    }
  }
  await doc.transform(prune({ propertyTypes: [PropertyType.ACCESSOR], keepAttributes: true, keepIndices: true }));

  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const glb = await io.writeBinary(doc);

  const check = await io.readBinary(glb);
  const err = maxPhysicsError(reference, physicsVertices(check));
  if (err !== 0) {
    console.error(`${path.basename(file)}: physics geometry changed (max ${err} m); file left untouched`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, glb);
  const size1 = statSync(file).size;
  before += size0;
  after += size1;
  console.log(`${path.basename(file)}: ${(size0 / 1e6).toFixed(1)} MB -> ${(size1 / 1e6).toFixed(1)} MB (${reference.size} physics meshes bit-exact)`);
}
if (before > 0) console.log(`total: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
