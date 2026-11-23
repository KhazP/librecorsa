/**
 * The byte-level part of the KTX2 texture converter (scripts/ktx2-track-textures.mjs) and its check
 * (scripts/verify-ktx2-models.ts): no basisu, no image decoding, so CI can run it.
 *
 * A circuit GLB is rewritten without a glTF library: its JSON is edited and its binary chunk rebuilt from the original
 * buffer views, so every view that is not an image (meshopt-compressed geometry, physics, animation) keeps its bytes
 * exactly. A gltf-transform read and write would decode and re-encode the meshopt views, which re-rounds some normals.
 * Images, textures and materials keep their indices: the venue split (scripts/split-venue-model.mjs on
 * feat/shared-venue-models) refers to them by index.
 */

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const MESHOPT = "EXT_meshopt_compression";
export const BASISU = "KHR_texture_basisu";
const WEBP = "EXT_texture_webp";
const AVIF = "EXT_texture_avif";

const pad4 = (n) => (n + 3) & ~3;

/** A GLB's JSON and binary chunk */
export function parseGlb(buf, label = "GLB") {
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${label}: not a GLB`);
  let offset = 12;
  let json;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString("utf8"));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error(`${label}: no JSON chunk`);
  return { json, bin };
}

export function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonLen = pad4(jsonBuf.length);
  const binLen = pad4(bin.length);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonLen, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonBuf.copy(out, 20);
  out.fill(0x20, 20 + jsonBuf.length, 20 + jsonLen);
  if (bin.length) {
    const o = 20 + jsonLen;
    out.writeUInt32LE(binLen, o);
    out.writeUInt32LE(CHUNK_BIN, o + 4);
    bin.copy(out, o + 8);
  }
  return out;
}

/** The image a texture shows: its own source, or the one a WebP / AVIF / Basis extension names */
export function textureImage(tex) {
  return tex.extensions?.[BASISU]?.source ?? tex.extensions?.[WEBP]?.source ?? tex.extensions?.[AVIF]?.source ?? tex.source;
}

/**
 * The byte ranges of the binary chunk that buffer views point at: a plain view's own range, or a meshopt view's
 * compressed range (its own `buffer` is then meshopt's fallback buffer, which has no bytes in the file)
 */
function binSegments(json) {
  const segments = [];
  json.bufferViews.forEach((bv, view) => {
    const ext = bv.extensions?.[MESHOPT];
    const fallback = json.buffers[bv.buffer]?.extensions?.[MESHOPT]?.fallback;
    if (ext) {
      if (ext.buffer !== 0) throw new Error(`buffer view ${view}: compressed data outside the binary chunk`);
      segments.push({ view, meshopt: true, offset: ext.byteOffset ?? 0, length: ext.byteLength });
    }
    if (!fallback) {
      if (bv.buffer !== 0) throw new Error(`buffer view ${view}: data outside the binary chunk`);
      segments.push({ view, meshopt: false, offset: bv.byteOffset ?? 0, length: bv.byteLength });
    }
  });
  return segments;
}

/** The bytes of a plain buffer view (an image's) */
export function viewBytes(glb, view) {
  const bv = glb.json.bufferViews[view];
  if (bv.extensions?.[MESHOPT] || bv.buffer !== 0) throw new Error(`buffer view ${view}: not a plain view in the binary chunk`);
  return glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
}

/**
 * The GLB with every image replaced by its KTX2 file (`ktx2` maps image index → bytes; it must cover every image a
 * texture shows) and each texture pointing at it through KHR_texture_basisu. Everything else keeps its bytes and
 * indices; `materialExtras` and `imageExtras` (index → extras to merge) and `assetExtras` are added to the JSON.
 *
 * @param {{ json: any, bin: Buffer }} glb
 * @param {Map<number, Buffer>} ktx2
 * @param {{ materialExtras?: Map<number, object>, imageExtras?: Map<number, object>, assetExtras?: object }} [options]
 */
export function replaceImagesWithKtx2(glb, ktx2, { materialExtras = new Map(), imageExtras = new Map(), assetExtras = undefined } = {}) {
  const json = structuredClone(glb.json);
  const imageViews = new Map();
  for (const [image, bytes] of ktx2) {
    const def = json.images[image];
    if (def?.bufferView === undefined) throw new Error(`image ${image}: not stored in the GLB`);
    imageViews.set(def.bufferView, bytes);
    def.mimeType = "image/ktx2";
  }
  for (const [t, tex] of (json.textures ?? []).entries()) {
    const image = textureImage(tex);
    if (image === undefined) continue;
    if (!ktx2.has(image)) throw new Error(`texture ${t}: image ${image} has no KTX2 file`);
    delete tex.source;
    if (tex.extensions) {
      delete tex.extensions[WEBP];
      delete tex.extensions[AVIF];
    }
    tex.extensions = { ...tex.extensions, [BASISU]: { source: image } };
  }

  const bin = rebuildBin(json, glb.bin, imageViews);

  for (const [m, extras] of materialExtras) json.materials[m].extras = { ...json.materials[m].extras, ...extras };
  for (const [i, extras] of imageExtras) json.images[i].extras = { ...json.images[i].extras, ...extras };
  if (assetExtras) json.asset.extras = { ...json.asset.extras, ...assetExtras };

  const stillUsed = (name) => (json.textures ?? []).some((t) => t.extensions?.[name]);
  for (const key of ["extensionsUsed", "extensionsRequired"]) {
    const list = (json[key] ?? []).filter((e) => (e !== WEBP && e !== AVIF) || stillUsed(e));
    if (!list.includes(BASISU)) list.push(BASISU);
    json[key] = list;
  }
  return { json, bin };
}

/**
 * The GLB with some images' bytes replaced in the same format (`images` maps image index → bytes): textures,
 * materials and every other buffer view keep their indices and bytes.
 *
 * @param {{ json: any, bin: Buffer }} glb
 * @param {Map<number, Buffer>} images
 */
export function replaceImages(glb, images) {
  const json = structuredClone(glb.json);
  const imageViews = new Map();
  for (const [image, bytes] of images) {
    const def = json.images[image];
    if (def?.bufferView === undefined) throw new Error(`image ${image}: not stored in the GLB`);
    imageViews.set(def.bufferView, bytes);
  }
  return { json, bin: rebuildBin(json, glb.bin, imageViews) };
}

/**
 * The binary chunk rebuilt in its original order, each range on a 4-byte boundary, the views in `imageViews` (buffer
 * view index → bytes) holding their new bytes; `json`'s buffer views and buffer length are updated in place to match.
 */
function rebuildBin(json, oldBin, imageViews) {
  const segments = binSegments(json).sort((a, b) => a.offset - b.offset || a.view - b.view);
  const parts = [];
  let length = 0;
  const placed = new Map();
  let lastEnd = -1;
  for (const seg of segments) {
    const key = `${seg.offset}:${seg.length}`;
    let at = placed.get(key);
    if (at === undefined) {
      if (seg.offset < lastEnd) throw new Error(`buffer view ${seg.view}: overlaps another view`);
      lastEnd = seg.offset + seg.length;
      const replacement = !seg.meshopt ? imageViews.get(seg.view) : undefined;
      const bytes = replacement ?? oldBin.subarray(seg.offset, seg.offset + seg.length);
      at = pad4(length);
      if (at > length) parts.push(Buffer.alloc(at - length));
      parts.push(bytes);
      length = at + bytes.length;
      placed.set(key, at);
    } else if (!seg.meshopt && imageViews.has(seg.view)) {
      throw new Error(`buffer view ${seg.view}: an image view shares its bytes with another view`);
    }
    const bv = json.bufferViews[seg.view];
    if (seg.meshopt) bv.extensions[MESHOPT].byteOffset = at;
    else {
      bv.byteOffset = at;
      if (imageViews.has(seg.view)) bv.byteLength = imageViews.get(seg.view).length;
    }
  }
  const bin = Buffer.concat(parts, length);
  json.buffers[0].byteLength = bin.length;
  return bin;
}

/**
 * How each image is used, from the materials: colour (sRGB) or data (linear) slots, whether a MASK / BLEND material
 * reads its alpha, and the materials that show it as base colour.
 */
export function imageUsage(json) {
  const usage = new Map();
  const use = (texIndex, slot, material, alphaMode) => {
    if (texIndex === undefined) return;
    const image = textureImage(json.textures[texIndex]);
    if (image === undefined) return;
    let u = usage.get(image);
    if (!u) usage.set(image, (u = { slots: new Set(), srgb: false, linear: false, alpha: false, blendMaterials: [], groundDetail: false }));
    u.slots.add(slot);
    if (/^(base|emissive)$|Color/.test(slot)) u.srgb = true;
    else u.linear = true;
    if (slot === "base" && (alphaMode === "MASK" || alphaMode === "BLEND")) u.alpha = true;
    if (slot === "base" && alphaMode === "BLEND") u.blendMaterials.push(material);
    if (slot === "emissive" && json.materials[material].extras?.groundDetail) u.groundDetail = true;
  };
  (json.materials ?? []).forEach((m, i) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    use(pbr.baseColorTexture?.index, "base", i, m.alphaMode);
    use(pbr.metallicRoughnessTexture?.index, "metallicRoughness", i);
    use(m.normalTexture?.index, "normal", i);
    use(m.occlusionTexture?.index, "occlusion", i);
    use(m.emissiveTexture?.index, "emissive", i);
    for (const [ext, def] of Object.entries(m.extensions ?? {})) {
      for (const [key, value] of Object.entries(def ?? {})) {
        if (value && typeof value === "object" && typeof value.index === "number") use(value.index, `${ext}.${key}`, i);
      }
    }
  });
  return usage;
}

// scan-materials.ts classifies a blended scan material by its texture's alpha, sampled at 128 px. The browser reads
// the WebP through a canvas; a KTX2 texture has no pixels to read, so the converter stores the result in the
// material's extras (`alphaKind`) from the source image. Same thresholds as scan-materials.ts.
const SOFT_LO = 0.15;
const SOFT_HI = 0.85;
const MAX_SOFT_SHARE = 0.45;
const MIN_KEPT_SHARE = 0.5;
const SAMPLE_PX = 128;

/**
 * "opaque" | "cutout" | "soft" for an RGBA image (Uint8 w*h*4), as scan-materials.ts decides it at run time. The image
 * is sampled at 128 x 128 bilinearly at pixel centres, the way a canvas `drawImage` with the default (low) smoothing
 * scales it down in Chromium.
 */
export function alphaKindOf(rgba, w, h) {
  let transparent = 0;
  let soft = 0;
  let visible = 0;
  let kept = 0;
  const at = (x, y) => rgba[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + 3];
  for (let j = 0; j < SAMPLE_PX; j++) {
    const sy = ((j + 0.5) * h) / SAMPLE_PX - 0.5;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let i = 0; i < SAMPLE_PX; i++) {
      const sx = ((i + 0.5) * w) / SAMPLE_PX - 0.5;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const v = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      const a = Math.round(v) / 255;
      if (a < 0.95) transparent++;
      if (a > SOFT_LO && a < SOFT_HI) soft++;
      if (a > 0.02) visible++;
      if (a >= 0.5) kept++;
    }
  }
  if (transparent === 0) return "opaque";
  if (soft / transparent <= MAX_SOFT_SHARE && kept / Math.max(visible, 1) >= MIN_KEPT_SHARE) return "cutout";
  return "soft";
}

/**
 * Error of a decoded image against its source (both RGBA, same size): PSNR of luma over the texels that show (alpha
 * ≥ 32 when `alpha`), the PSNR of the worst 1 % of 16 x 16 tiles (local blocking on signs and lettering), and for
 * alpha the PSNR and the share of texels that flip across a 0.5 alpha test.
 */
export function compareRgba(src, dec, w, h, { alpha = false } = {}) {
  const TILE = 16;
  const tilesX = Math.ceil(w / TILE);
  const tileSe = new Float64Array(tilesX * Math.ceil(h / TILE));
  const tileN = new Uint32Array(tileSe.length);
  let se = 0;
  let seC = 0;
  let n = 0;
  let seA = 0;
  let flips = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (alpha) {
        const da = src[i + 3] - dec[i + 3];
        seA += da * da;
        if (src[i + 3] >= 128 !== dec[i + 3] >= 128) flips++;
        if (src[i + 3] < 32) continue;
      }
      const ys = 0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2];
      const yd = 0.2126 * dec[i] + 0.7152 * dec[i + 1] + 0.0722 * dec[i + 2];
      const d = ys - yd;
      se += d * d;
      // BT.709 chroma: colour speckle on grey surfaces (ETC1S's weak spot) hardly moves luma
      const dcb = (src[i + 2] - ys) / 1.8556 - (dec[i + 2] - yd) / 1.8556;
      const dcr = (src[i] - ys) / 1.5748 - (dec[i] - yd) / 1.5748;
      seC += (dcb * dcb + dcr * dcr) / 2;
      n++;
      const t = Math.floor(y / TILE) * tilesX + Math.floor(x / TILE);
      tileSe[t] += d * d;
      tileN[t]++;
    }
  }
  const psnr = (mse) => (mse <= 1e-9 ? 99 : 10 * Math.log10((255 * 255) / mse));
  const tiles = [];
  for (let t = 0; t < tileSe.length; t++) if (tileN[t] >= 32) tiles.push(psnr(tileSe[t] / tileN[t]));
  tiles.sort((a, b) => a - b);
  const round = (v) => Math.round(v * 100) / 100;
  return {
    psnrY: round(n ? psnr(se / n) : 99),
    psnrC: round(n ? psnr(seC / n) : 99),
    tileP01: round(tiles.length ? tiles[Math.floor(tiles.length * 0.01)] : 99),
    ...(alpha ? { psnrA: round(psnr(seA / (w * h))), flipPct: round((100 * flips) / (w * h)) } : {}),
  };
}

/** What a KTX2 file's header and data format descriptor say (enough to check a converted texture) */
export function ktx2Info(bytes) {
  const MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 80 || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not a KTX2 file");
  const u32 = (o) => bytes.readUInt32LE(o);
  const vkFormat = u32(12);
  const width = u32(20);
  const height = u32(24);
  const levelCount = u32(40);
  const supercompression = u32(44);
  const dfdOffset = u32(48);
  // The basic DFD block after the DFD's total size: block size at +6, colour model at +8, transfer function at +10,
  // samples from +24 (16 bytes each, channel id in the low bits of byte 3)
  const block = dfdOffset + 4;
  const colorModel = bytes[block + 8];
  const transfer = bytes[block + 10];
  const descriptorBlockSize = bytes.readUInt16LE(block + 6);
  const samples = (descriptorBlockSize - 24) / 16;
  const channels = [];
  for (let s = 0; s < samples; s++) channels.push(bytes[block + 24 + s * 16 + 3] & 0x0f);
  const codec = colorModel === 163 ? "etc1s" : colorModel === 166 ? "uastc" : `model ${colorModel}`;
  // ETC1S stores alpha as a second sample (channel 15); UASTC names RGBA (3) or RGB (0) in its one sample
  const hasAlpha = codec === "etc1s" ? channels.includes(15) : channels[0] === 3;
  return { vkFormat, width, height, levelCount, supercompression, codec, srgb: transfer === 2, hasAlpha };
}
