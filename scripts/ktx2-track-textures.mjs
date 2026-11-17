/**
 * Converts a circuit's textures to KTX2 (Basis Universal) for phones: the GPU keeps them compressed at 0.5-1 byte a
 * texel instead of the 4 a WebP texture takes once decoded, and the download stays close to the WebP file's. The game
 * loads the result on phones through src/lib/ktx2-models.ts and src/lib/venue-models.ts.
 *
 *   node scripts/ktx2-track-textures.mjs <in.glb> <out.glb> [--track-data <json>] [options]
 *   node scripts/ktx2-track-textures.mjs --venue <id> --out <dir> <shared.glb> <layout.glb>... [--track-data <json>]...
 *     options: --file-budget 1.1 (output bytes as a share of the input files') --close-up-floor min|low|high
 *              --cache <dir> --jobs 4 --report <json>
 *
 * The second form converts a venue's split model (src/lib/venue-models.ts) in place: the shared file and every layout
 * file, each keeping its indices, the layout files naming the new shared file's build. Usage is read across all of
 * them: a layout's own material can use a texture of the shared file.
 *
 * Needs `basisu` 2.x on the PATH (`brew install basis_universal`); it writes ETC1S and UASTC LDR 4x4 only, the two
 * modes three's bundled transcoder reads. Phones transcode ETC1S to ETC2 (4 bits a texel, 8 with alpha) and UASTC to
 * ASTC 4x4 (8 bits).
 *
 * Per image:
 * - colour slots (base colour, emissive) are sRGB, data slots (normal, metallic-roughness, occlusion) linear;
 * - alpha is kept only where a MASK or BLEND material reads it;
 * - every image is encoded as ETC1S at three levels (MIN: quality 50 with stronger rate-distortion optimisation, LOW:
 *   quality 50, HIGH: quality 90) and decoded as a phone transcodes it to measure the error; normal maps are also
 *   encoded as UASTC (RDO, Zstandard);
 * - the sizes are fitted to a budget: the output files may be `--file-budget` (1.1) times the WebP files. Every image
 *   starts at MIN; while the budget lasts, normal maps go UASTC (else HIGH), then images go to LOW and then to HIGH:
 *   the surfaces seen close to the car first (track data `mesh.roadMaterials`, ground and kerbs by material name,
 *   RISE's surface nodes, ground-detail layers; the ones MIN damages most first), then the other images MIN damages,
 *   worst first, then the rest. UASTC for other
 *   images costs 3-7 times the WebP bytes even with strong RDO, so it never fits;
 * - images keep their size (ETC2 and ASTC take any size; the game uses KTX2 on phones only), mipmaps come from basisu
 *   with a box filter, like the GPU's own.
 * A blended material's alpha kind (scan-materials.ts) is worked out from the source image and stored in its extras.
 *
 * Geometry, physics and every other buffer view keep their bytes (scripts/lib/ktx2-textures.mjs); images, textures
 * and materials keep their indices. Each output's `asset.extras.ktx2` names its input and the input's sha256. Encodes
 * are cached by image hash and settings, so a re-run gives identical bytes.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { alphaKindOf, compareRgba, imageUsage, ktx2Info, parseGlb, replaceImagesWithKtx2, textureImage, viewBytes, writeGlb } from "./lib/ktx2-textures.mjs";

const TOOL_VERSION = 3;
/** Part of the encode cache key: bump it only when the encodes themselves change */
const ENCODE_VERSION = 1;
/** Three ETC1S levels: MIN trades some detail for a smaller file through stronger rate-distortion optimisation */
const ETC1S_MIN = ["-etc1s", "-quality", "50", "-effort", "5", "-selector_rdo_thresh", "2.5", "-endpoint_rdo_thresh", "4"];
const ETC1S_LOW = ["-etc1s", "-quality", "50", "-effort", "5"];
const ETC1S_HIGH = ["-etc1s", "-quality", "90", "-effort", "5"];
const UASTC_NORMAL = ["-uastc", "-uastc_level", "2", "-uastc_rdo_l", "2", "-normal_map", "-ktx2_zstandard_level", "22"];
const COMMON_ARGS = ["-ktx2", "-mipmap", "-mip_filter", "box"];
/** MIN damages an image when its decode falls under these (dB; luma, chroma) */
const MIN_OK = { psnrY: 36, psnrC: 36 };
/** Material names of ground seen close to the car (scan-materials.ts GROUND, plus the scans' spellings) */
const GROUND = /asph|apsh|road|tarmac|grass|gras|terrain|ground|curb|kerb|cord|rmbl|rumble|gravel|sand|concrete|runoff|pitlane|pit_lane/i;
/** RISE Motordrome's surface nodes (scene-builder.ts naming contract) */
const SURFACE_NODES = /^(Track_Asphalt_Road|Track_Pitlane|Track_Kerbs?|Track_Kerb_Blocks|Track_Runoff_Paint|Terrain)$/;
const VENUE = "LC_venue_shared";

// ---------- arguments

const args = process.argv.slice(2);
const take = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const takeAll = (name) => {
  const out = [];
  for (let i = args.indexOf(name); i >= 0; i = args.indexOf(name)) out.push(...args.splice(i, 2).slice(1));
  return out;
};
const trackDataPaths = takeAll("--track-data");
const cacheDir = path.resolve(take("--cache", path.join(tmpdir(), "lc-ktx2-cache")));
const jobs = Math.max(1, Number(take("--jobs", "4")));
const reportPath = take("--report");
const fileBudget = Number(take("--file-budget", "1.1"));
const closeUpFloor = take("--close-up-floor", "min");
if (!["min", "low", "high"].includes(closeUpFloor)) throw new Error(`--close-up-floor ${closeUpFloor}: min, low or high`);
const venueId = take("--venue");
const outDir = take("--out");
if (venueId ? !outDir || args.length < 2 : args.length !== 2) {
  console.error("Usage: node scripts/ktx2-track-textures.mjs <in.glb> <out.glb> [--track-data <json>] [--file-budget 1.1] [--cache <dir>] [--jobs N] [--report <json>]");
  console.error("       node scripts/ktx2-track-textures.mjs --venue <id> --out <dir> <shared.glb> <layout.glb>... [--track-data <json>]...");
  process.exit(1);
}

let basisuVersion;
try {
  basisuVersion = /v(\d+\.\d+\.\d+)/.exec(execFileSync("basisu", ["-version"], { encoding: "utf8" }))?.[1];
} catch {
  console.error("basisu not found: install it with `brew install basis_universal` (Basis Universal 2.x)");
  process.exit(1);
}
if (!basisuVersion || Number(basisuVersion.split(".")[0]) < 2) {
  console.error(`basisu ${basisuVersion ?? "?"}: version 2.x expected`);
  process.exit(1);
}
mkdirSync(cacheDir, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), "lc-ktx2-"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------- the files and what each image is

const inputs = (venueId ? args : [args[0]]).map((p) => {
  const bytes = readFileSync(p);
  return { path: p, bytes, glb: parseGlb(bytes, p) };
});
if (!venueId && path.resolve(args[0]) === path.resolve(args[1])) {
  console.error("refusing to write over the input");
  process.exit(1);
}
const roadMaterials = new Set(trackDataPaths.flatMap((p) => JSON.parse(readFileSync(p, "utf8")).metadata?.mesh?.roadMaterials ?? []));

/** Materials on RISE's surface nodes (by node name, through their children) */
function surfaceMaterials(json) {
  const out = new Set();
  const visit = (n, inSurface) => {
    const node = json.nodes[n];
    const surface = inSurface || SURFACE_NODES.test(node.name ?? "");
    if (surface && node.mesh !== undefined) for (const p of json.meshes[node.mesh].primitives) if (p.material !== undefined) out.add(p.material);
    for (const c of node.children ?? []) visit(c, surface);
  };
  for (const scene of json.scenes ?? []) for (const n of scene.nodes ?? []) visit(n, false);
  return out;
}

/** Every image to convert, by `${file}:${image}`, with how all the files' materials use it */
const images = new Map();
const imageOf = (file, index) => {
  const key = `${file}:${index}`;
  let im = images.get(key);
  if (!im) images.set(key, (im = { file, index, slots: new Set(), srgb: false, linear: false, alpha: false, closeUp: false, groundDetail: false, blend: [] }));
  return im;
};
/** Where a texture's image lives: its own file, or the shared file for a layout's LC_venue_shared texture */
function resolveTexture(file, texIndex) {
  const tex = inputs[file].glb.json.textures[texIndex];
  const ref = tex.extensions?.[VENUE]?.texture;
  if (ref !== undefined) return { file: 0, image: textureImage(inputs[0].glb.json.textures[ref]) };
  return { file, image: textureImage(tex) };
}
inputs.forEach((input, file) => {
  const json = input.glb.json;
  const surfaces = surfaceMaterials(json);
  (json.materials ?? []).forEach((m, mi) => {
    if (m.extensions?.[VENUE]) return; // a stub: the shared file defines it
    const closeUp = roadMaterials.has(m.name ?? "") || GROUND.test(m.name ?? "") || surfaces.has(mi);
    const pbr = m.pbrMetallicRoughness ?? {};
    const slots = [
      [pbr.baseColorTexture, "base"],
      [pbr.metallicRoughnessTexture, "metallicRoughness"],
      [m.normalTexture, "normal"],
      [m.occlusionTexture, "occlusion"],
      [m.emissiveTexture, "emissive"],
    ];
    for (const [ref, slot] of slots) {
      if (ref?.index === undefined) continue;
      const { file: f, image } = resolveTexture(file, ref.index);
      if (image === undefined) continue;
      const im = imageOf(f, image);
      im.slots.add(slot);
      if (slot === "base" || slot === "emissive") im.srgb = true;
      else im.linear = true;
      if (slot === "base" && (m.alphaMode === "MASK" || m.alphaMode === "BLEND")) im.alpha = true;
      if (slot === "base" && m.alphaMode === "BLEND") im.blend.push({ file, material: mi });
      if (slot === "emissive" && m.extras?.groundDetail) im.groundDetail = true;
      if (closeUp || im.groundDetail) im.closeUp = true;
    }
  });
});
// An image no material shows still has to become KTX2 (KHR_texture_basisu is required): sRGB, no alpha
inputs.forEach((input, file) => {
  (input.glb.json.images ?? []).forEach((_, i) => {
    const im = imageOf(file, i);
    if (!im.slots.size) im.srgb = true;
  });
});
for (const im of images.values()) if (im.srgb && im.linear) throw new Error(`${inputs[im.file].path} image ${im.index}: used as colour and as data`);

// ---------- encoding

function run(cmd, argv, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}: ${err.slice(-400)}`))));
  });
}

/** Encodes in flight, by key: two images with the same bytes and settings share one encode */
const encoding = new Map();
function encode(png, modeArgs, key, w, h, src, alpha) {
  let pending = encoding.get(key);
  if (!pending) encoding.set(key, (pending = encodeOnce(png, modeArgs, key, w, h, src, alpha)));
  return pending;
}
/** Encodes `png` with basisu and decodes level 0 the way a phone transcodes it (ETC1S → ETC2, UASTC → ASTC) */
async function encodeOnce(png, modeArgs, key, w, h, src, alpha) {
  const ktxPath = path.join(cacheDir, `${key}.ktx2`);
  const metaPath = path.join(cacheDir, `${key}.json`);
  if (existsSync(ktxPath) && existsSync(metaPath)) return { bytes: readFileSync(ktxPath), metrics: JSON.parse(readFileSync(metaPath, "utf8")) };
  const out = path.join(work, `${key}.ktx2`);
  await run("basisu", [...modeArgs, ...COMMON_ARGS, "-max_threads", "3", "-quiet", png, "-output_file", out]);
  const un = path.join(work, `${key}-unpacked`);
  mkdirSync(un);
  await run("basisu", ["-unpack", "-no_ktx", "-format_only", modeArgs[0] === "-etc1s" ? "1" : "10", "-quiet", out], un);
  const level0 = readdirSync(un).find((f) => /_unpacked_rgba_.*_level_0_face/.test(f));
  const dec = await sharp(path.join(un, level0)).ensureAlpha().raw().toBuffer();
  const metrics = compareRgba(src, dec, w, h, { alpha });
  rmSync(un, { recursive: true, force: true });
  const bytes = readFileSync(out);
  writeFileSync(ktxPath, bytes);
  writeFileSync(metaPath, JSON.stringify(metrics));
  rmSync(out);
  return { bytes, metrics };
}

/** GPU bytes of a w x h texture with a full mip chain at `bpp` bits per texel in 4x4 blocks */
function mipBytes(w, h, bpp) {
  let total = 0;
  for (;;) {
    total += Math.ceil(w / 4) * Math.ceil(h / 4) * 2 * bpp;
    if (w === 1 && h === 1) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}
function rgba8MipBytes(w, h) {
  let total = 0;
  for (;;) {
    total += w * h * 4;
    if (w === 1 && h === 1) return total;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
}

async function encodeImage(im) {
  const { glb } = inputs[im.file];
  const original = viewBytes(glb, glb.json.images[im.index].bufferView);
  const meta = await sharp(original).metadata();
  const { data: src, info } = await sharp(original).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = im.alpha && meta.hasAlpha === true;
  const png = path.join(work, `f${im.file}i${im.index}.png`);
  const raw = sharp(src, { raw: { width: info.width, height: info.height, channels: 4 } });
  await (alpha ? raw : raw.removeAlpha()).png({ compressionLevel: 1 }).toFile(png);
  const space = im.linear ? ["-linear"] : ["-srgb"];
  const alphaArgs = alpha ? [] : ["-no_alpha"];
  const normal = im.slots.has("normal");
  const keyOf = (modeArgs) => sha256(Buffer.concat([original, Buffer.from(JSON.stringify({ v: ENCODE_VERSION, basisuVersion, modeArgs, COMMON_ARGS, space, alphaArgs }))]));
  const variant = async (modeArgs) => {
    const a = [...modeArgs, ...(normal && modeArgs[0] === "-etc1s" ? ["-normal_map"] : []), ...space, ...alphaArgs];
    return encode(png, a, keyOf(a), info.width, info.height, src, alpha);
  };
  const min = await variant(ETC1S_MIN);
  const low = await variant(ETC1S_LOW);
  const high = await variant(ETC1S_HIGH);
  const uastc = normal ? await variant(UASTC_NORMAL) : undefined;
  rmSync(png, { force: true });
  return Object.assign(im, {
    webpBytes: original.length,
    width: info.width,
    height: info.height,
    hasAlpha: alpha,
    normal,
    min,
    low,
    high,
    uastc,
    alphaKind: im.blend.length ? alphaKindOf(src, info.width, info.height) : undefined,
  });
}

const list = [...images.values()];
let next = 0;
let done = 0;
const started = Date.now();
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < list.length) {
      await encodeImage(list[next++]);
      if (++done % 50 === 0 || done === list.length) console.log(`  ${done}/${list.length} images (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  })
);

// ---------- fitting the budget

// The output files may grow to `--file-budget` times the inputs: what's left for the images after the rest of the bytes
const webpTotal = list.reduce((s, im) => s + im.webpBytes, 0);
const inputTotal = inputs.reduce((s, input) => s + input.bytes.length, 0);
const budget = inputTotal * fileBudget - (inputTotal - webpTotal);
const LEVELS = ["min", "low", "high", "uastc"];
const sizeAt = (im, level) => im[level].bytes.length;
for (const im of list) im.choice = "min";
let total = list.reduce((s, im) => s + sizeAt(im, "min"), 0);
const damaged = (im) => im.min.metrics.psnrY < MIN_OK.psnrY || im.min.metrics.psnrC < MIN_OK.psnrC;
const worstFirst = (a, b) => Math.min(a.min.metrics.psnrY, a.min.metrics.psnrC) - Math.min(b.min.metrics.psnrY, b.min.metrics.psnrC);
const normals = list.filter((im) => im.normal);
const closeUps = list.filter((im) => !im.normal && im.closeUp).sort(worstFirst);
const hurt = list.filter((im) => !im.normal && !im.closeUp && damaged(im)).sort(worstFirst);
const scenery = list.filter((im) => !im.normal && !im.closeUp && !damaged(im)).sort((a, b) => sizeAt(a, "low") - sizeAt(a, "min") - (sizeAt(b, "low") - sizeAt(b, "min")));
// --close-up-floor low|high: the surfaces next to the car start there, over the budget if need be
if (closeUpFloor !== "min") {
  for (const im of closeUps) {
    total += sizeAt(im, closeUpFloor) - sizeAt(im, "min");
    im.choice = closeUpFloor;
    im.why = "close-up surface";
  }
}
const passes = [
  [normals, "uastc", "normal map"],
  [normals, "high", "normal map"],
  [closeUps, "low", "close-up surface"],
  [hurt, "low", "damaged at min"],
  [scenery, "low", "scenery"],
  [closeUps, "high", "close-up surface"],
  [hurt, "high", "damaged at min"],
  [scenery, "high", "scenery"],
];
for (const [group, to, why] of passes) {
  for (const im of group) {
    if (LEVELS.indexOf(im.choice) >= LEVELS.indexOf(to) || !im[to]) continue;
    const delta = sizeAt(im, to) - sizeAt(im, im.choice);
    if (delta <= 0 || total + delta <= budget) {
      total += delta;
      im.choice = to;
      im.why = why;
    }
  }
}

// ---------- writing

const tool = `scripts/ktx2-track-textures.mjs v${TOOL_VERSION}`;
const outputs = [];
const writeFile = (file, extraJson) => {
  const input = inputs[file];
  const own = list.filter((im) => im.file === file);
  const ktx2 = new Map(own.map((im) => [im.index, im[im.choice].bytes]));
  const materialExtras = new Map();
  for (const im of list) for (const b of im.blend) if (b.file === file) materialExtras.set(b.material, { alphaKind: im.alphaKind });
  const out = replaceImagesWithKtx2(input.glb, ktx2, {
    materialExtras,
    assetExtras: { ktx2: { tool, basisu: basisuVersion, source: path.basename(input.path), sourceSha256: sha256(input.bytes) } },
  });
  if (extraJson) extraJson(out.json);
  for (const [, bytes] of ktx2) ktx2Info(bytes);
  return writeGlb(out.json, out.bin);
};

if (venueId) {
  mkdirSync(outDir, { recursive: true });
  const shared = writeFile(0);
  // Named by the layouts' inputs as well as the shared file, so a change to one layout alone gets new names
  const build = sha256(Buffer.concat([shared, ...inputs.slice(1).map((i) => Buffer.from(sha256(i.bytes)))])).slice(0, 8);
  const sharedPath = path.join(outDir, `${venueId}.shared.${build}.glb`);
  writeFileSync(sharedPath, shared);
  outputs.push({ input: inputs[0].path, output: sharedPath, bytes: shared.length, inputBytes: inputs[0].bytes.length });
  for (let f = 1; f < inputs.length; f++) {
    const layout = /([^/]+)\.layout\.[0-9a-f]{8}\.glb$/.exec(inputs[f].path)?.[1];
    if (!layout) throw new Error(`${inputs[f].path}: not a <layout>.layout.<build>.glb file`);
    const bytes = writeFile(f, (json) => {
      if (json.extras?.lcVenueLayout?.venue !== venueId) throw new Error(`${inputs[f].path}: not a layout of ${venueId}`);
      json.extras.lcVenueLayout.shared = build;
    });
    const p = path.join(outDir, `${layout}.layout.${build}.glb`);
    writeFileSync(p, bytes);
    outputs.push({ input: inputs[f].path, output: p, bytes: bytes.length, inputBytes: inputs[f].bytes.length });
  }
  console.log(`venue ${venueId} build ${build}`);
} else {
  const bytes = writeFile(0);
  mkdirSync(path.dirname(path.resolve(args[1])), { recursive: true });
  writeFileSync(args[1], bytes);
  outputs.push({ input: inputs[0].path, output: path.resolve(args[1]), bytes: bytes.length, inputBytes: inputs[0].bytes.length, build: sha256(bytes).slice(0, 8) });
}
rmSync(work, { recursive: true, force: true });

// ---------- summary

const MB = (b) => +(b / 1048576).toFixed(1);
const gpu = (im) => mipBytes(im.width, im.height, im.choice !== "uastc" && !im.hasAlpha ? 4 : 8);
const summary = {
  outputs: outputs.map((o) => ({ ...o, mb: MB(o.bytes), inputMB: MB(o.inputBytes), inputSha256: sha256(readFileSync(o.input)) })),
  fileMB: { before: MB(outputs.reduce((s, o) => s + o.inputBytes, 0)), after: MB(outputs.reduce((s, o) => s + o.bytes, 0)) },
  imageMB: { webp: MB(webpTotal), ktx2: MB(total), budget: MB(budget) },
  fileBudget,
  images: list.length,
  choices: Object.fromEntries(LEVELS.map((c) => [c, list.filter((im) => im.choice === c).length])),
  closeUp: Object.fromEntries(LEVELS.map((c) => [c, list.filter((im) => im.closeUp && im.choice === c).length])),
  withAlpha: list.filter((im) => im.hasAlpha).length,
  blendMaterials: list.reduce((s, im) => s + im.blend.length, 0),
  gpuMB: { rgba8: MB(list.reduce((s, im) => s + rgba8MipBytes(im.width, im.height), 0)), phone: MB(list.reduce((s, im) => s + gpu(im), 0)) },
  seconds: Math.round((Date.now() - started) / 1000),
};
console.log(JSON.stringify(summary, null, 1));
if (reportPath) {
  const pick = (v) => v && { kb: Math.round(v.bytes.length / 1024), ...v.metrics };
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        summary,
        images: list.map((im) => ({
          file: path.basename(inputs[im.file].path),
          index: im.index,
          size: `${im.width}x${im.height}`,
          slots: [...im.slots].sort(),
          alpha: im.hasAlpha,
          closeUp: im.closeUp,
          choice: im.choice,
          why: im.why ?? "min",
          webpKB: Math.round(im.webpBytes / 1024),
          min: pick(im.min),
          low: pick(im.low),
          high: pick(im.high),
          uastc: pick(im.uastc),
          alphaKind: im.alphaKind,
        })),
      },
      null,
      1
    )
  );
}
