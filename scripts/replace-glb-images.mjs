/**
 * Replaces images inside a GLB with new files of the same format, picked by the image's name; geometry, physics and
 * every other buffer view keep their bytes, and images, textures and materials keep their indices.
 *
 *   node scripts/replace-glb-images.mjs <in.glb> <out.glb> <image name>=<file> [<image name>=<file> ...]
 *
 * For a fix to a texture that doesn't need the whole model rebuilt (RISE's scanned normal maps: its GLB is the Blender
 * build with the Assetto Corsa release merged on, scripts/rwanda-official/README.md). A KTX2 conversion of the model
 * (scripts/ktx2-track-textures.mjs) must be made again from the result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseGlb, replaceImages, writeGlb } from "./lib/ktx2-textures.mjs";

const MIME = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ktx2": "image/ktx2" };

const [input, output, ...pairs] = process.argv.slice(2);
if (!input || !output || !pairs.length) {
  console.error("Usage: node scripts/replace-glb-images.mjs <in.glb> <out.glb> <image name>=<file> ...");
  process.exit(1);
}

const glb = parseGlb(readFileSync(input), input);
const images = new Map();
for (const pair of pairs) {
  const eq = pair.indexOf("=");
  if (eq < 1) throw new Error(`${pair}: expected <image name>=<file>`);
  const name = pair.slice(0, eq);
  const file = pair.slice(eq + 1);
  const matches = glb.json.images.flatMap((im, i) => (im.name === name ? [i] : []));
  if (matches.length !== 1) throw new Error(`${name}: ${matches.length} images have this name`);
  const [index] = matches;
  const mime = MIME[path.extname(file).toLowerCase()];
  if (mime !== glb.json.images[index].mimeType) {
    throw new Error(`${name}: the GLB's image is ${glb.json.images[index].mimeType}, ${file} is ${mime ?? "unknown"}`);
  }
  images.set(index, readFileSync(file));
}

const out = writeGlb(...Object.values(replaceImages(glb, images)));
writeFileSync(output, out);
for (const [index, bytes] of images) {
  const im = glb.json.images[index];
  const before = glb.json.bufferViews[im.bufferView].byteLength;
  console.log(`  ${im.name}: ${(before / 1024).toFixed(0)} KB -> ${(bytes.length / 1024).toFixed(0)} KB`);
}
console.log(`${output}: ${(readFileSync(input).length / 1e6).toFixed(2)} MB -> ${(out.length / 1e6).toFixed(2)} MB`);
