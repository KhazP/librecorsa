/**
 * Meshopt-compresses car GLBs in place (EXT_meshopt_compression + KHR_mesh_quantization) for a smaller download.
 *
 *   node scripts/compress-car-glb.mjs public/cars/bmw-m4-gt3/model/bmw-m4-gt3.glb [more.glb ...]
 *   node scripts/compress-car-glb.mjs --all        # every car and cockpit GLB under public/ (tracks excluded)
 *
 * Run by the Pages deploy before `next build` (the repository keeps the raw files the car tools edit). Normals, UVs
 * and colours are quantized (8-bit normals, 12-bit UVs); positions stay float, so every mesh keeps its own node
 * transform and its geometry stays in metres. Textures, materials, node names and extras are left as they are.
 * Nothing is pruned: a LC26 body's per-compound tyre maps are textures no material uses, found by index from its root
 * node's extras, so the script fails unless the texture list survives unchanged. Already compressed files are
 * skipped. The browser decodes with three's MeshoptDecoder (src/lib/render/gltf-loader.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { quantize, reorder } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function carFiles(args) {
  if (!args.includes("--all")) return args;
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p !== path.join(ROOT, "public/tracks")) walk(p);
      } else if (e.name.endsWith(".glb")) out.push(p);
    }
  };
  walk(path.join(ROOT, "public"));
  return out.filter((f) => existsSync(f));
}

function gltfJson(buf) {
  return JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8"));
}

/**
 * glTF-Transform writes a `textures` entry only for textures a material uses, which renumbers them. Put the original
 * table back (images keep their order) and point the materials at the original entries, so textures found by index
 * (a LC26 body's tyre maps) still resolve.
 */
function restoreTextureTable(glb, json0) {
  const json = gltfJson(glb);
  const images0 = json0.images ?? [];
  const images1 = json.images ?? [];
  if (images0.length !== images1.length || (json0.textures ?? []).length === (json.textures ?? []).length) return glb;
  const sameOrder = images0.every((im, i) => (im.name ?? "") === (images1[i].name ?? "") && im.mimeType === images1[i].mimeType);
  if (!sameOrder) return glb;
  const sampler0 = (json0.samplers ?? []).map((x) => JSON.stringify(x));
  const remap = (json.textures ?? []).map((t) => {
    const want = JSON.stringify((json.samplers ?? [])[t.sampler] ?? null);
    const idx = (json0.textures ?? []).findIndex((o) => o.source === t.source && JSON.stringify(sampler0[o.sampler] ?? null) === JSON.stringify(want));
    return idx >= 0 ? idx : (json0.textures ?? []).findIndex((o) => o.source === t.source);
  });
  if (remap.some((i) => i < 0)) return glb;
  const fix = (o) => {
    if (Array.isArray(o)) o.forEach(fix);
    else if (o && typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (k.endsWith("Texture") && v && typeof v.index === "number") v.index = remap[v.index];
        else fix(v);
      }
    }
  };
  fix(json.materials ?? []);
  json.textures = json0.textures;
  json.samplers = json0.samplers;
  // Rewrite the JSON chunk (4-byte aligned, space-padded); the BIN chunk follows unchanged
  const oldLen = glb.readUInt32LE(12);
  const bin = glb.subarray(20 + oldLen);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (text.length % 4)) % 4;
  text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length + bin.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text, bin]);
}

const files = carFiles(process.argv.slice(2));
if (files.length === 0) {
  console.error("usage: node scripts/compress-car-glb.mjs <file.glb ...> | --all");
  process.exit(1);
}

await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const quiet = { debug() {}, info() {}, warn() {}, error: console.error };

let before = 0;
let after = 0;
for (const file of files) {
  const raw = readFileSync(file);
  const json0 = gltfJson(raw);
  if ((json0.extensionsUsed ?? []).includes("EXT_meshopt_compression")) {
    console.log(`${path.relative(ROOT, file)}: already compressed`);
    continue;
  }
  const doc = await io.read(file);
  doc.setLogger(quiet);
  // Positions stay float: quantizing them moves each mesh's scale and offset onto its node, so the geometry the car
  // rigs measure and the tyre shader deforms would no longer be in metres (issue #96: opponents and ghosts floated
  // about 0.65 m up, sitting on tyres read as 1 m in radius). Skinned meshes need it too (their inverse bind matrices
  // assume the unquantized mesh).
  await doc.transform(
    reorder({ encoder: MeshoptEncoder, target: "size" }),
    quantize({
      pattern: /^(?!POSITION$)/,
      quantizeNormal: 8,
      quantizeTexcoord: 12,
      quantizeColor: 8,
      quantizeWeight: 8,
      quantizeGeneric: 12,
    })
  );
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  let glb = Buffer.from(await io.writeBinary(doc));
  glb = restoreTextureTable(glb, json0);

  const json1 = gltfJson(glb);
  const sameTextures =
    (json1.textures ?? []).length === (json0.textures ?? []).length &&
    (json1.images ?? []).length === (json0.images ?? []).length &&
    (json1.nodes ?? []).filter((n) => n.extras).length >= (json0.nodes ?? []).filter((n) => n.extras).length;
  if (!sameTextures) {
    console.error(`${path.relative(ROOT, file)}: textures or node extras changed; file left untouched`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, glb);
  const size0 = raw.length;
  const size1 = statSync(file).size;
  before += size0;
  after += size1;
  console.log(`${path.relative(ROOT, file)}: ${(size0 / 1e6).toFixed(1)} MB -> ${(size1 / 1e6).toFixed(1)} MB`);
}
if (before > 0) console.log(`total: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
