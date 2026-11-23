/**
 * GPU-compressed circuit models (src/lib/ktx2-models.ts, scripts/ktx2-track-textures.mjs):
 *
 * 1. the Basis transcoder the site serves (public/basis/) is the one three ships, so the two never drift apart;
 * 2. the GLB rewrite keeps every buffer view that isn't an image byte for byte, moves meshopt views with their data,
 *    and swaps WebP for KHR_texture_basisu (a synthetic GLB, so CI runs it without basisu);
 * 3. the converter's alpha kinds (scan-materials.ts' rules) on known inputs;
 * 4. for each listed model whose files this copy has: every texture is KTX2 (ETC1S or UASTC, a full
 *    mip chain, sRGB for colour slots and linear for data slots, alpha only where a material reads it), blended
 *    materials carry their alpha kind, and the colliders the game builds from it are byte-identical to the WebP
 *    model's (venue builds marked `ktx2` in venue-models.ts: the same texture checks on their pair; verify-venue-models
 *    compares the pair with the WebP GLBs). With KTX2_SOURCE_DIR (a folder holding `<id>/<source file>`, e.g. ~/Documents/GitHub/_track-opt), the
 *    converter's input is found by its sha256 and every non-image buffer view and the node, mesh and accessor JSON are
 *    compared with it too.
 *
 *   npx tsx scripts/verify/verify-ktx2-models.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KTX2_MODELS, ktx2ModelUrl } from '../../src/lib/ktx2-models';
import { VENUE_MODELS, venueModelFiles } from '../../src/lib/venue-models';
import { getActiveSurfaceTable, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { TrackColliderQuery, TrackWallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { roadFacing } from '../../src/lib/sim/track-colliders';
import { loadGlbGeometry } from '../lib/glb-geometry';
import * as ktx from '../lib/ktx2-textures.mjs';

interface GltfJson {
  asset: { extras?: { ktx2?: { sourceSha256?: string; source?: string } } };
  images: { bufferView: number; mimeType?: string }[];
  textures: { source?: number; sampler?: number; extensions?: Record<string, { source?: number }> }[];
  materials: { name?: string; alphaMode?: string; extras?: Record<string, unknown>; pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, { buffer: number; byteOffset?: number; byteLength: number }> }[];
  buffers: { byteLength: number; extensions?: Record<string, unknown> }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  [key: string]: unknown;
}

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

// 1. Transcoder copy
{
  const ship = 'node_modules/three/examples/jsm/libs/basis';
  for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
    const same = existsSync(`public/basis/${f}`) && readFileSync(`public/basis/${f}`).equals(readFileSync(`${ship}/${f}`));
    check(`public/basis/${f} is three's copy`, same, same ? '' : `copy ${ship}/${f} to public/basis/`);
  }
}

// 2. GLB rewrite on a synthetic file: plain geometry, a meshopt view (data in buffer 0, view in the fallback buffer),
// two images and a trailing view
{
  const geometry = Buffer.from(Array.from({ length: 36 }, (_, i) => i));
  const meshopt = Buffer.from([0xa0, 1, 2, 3, 4, 5, 6]);
  const webpA = Buffer.from('RIFF....WEBPVP8 aaaa');
  const webpB = Buffer.from('RIFF....WEBPVP8 bbbbbbbbb');
  const tail = Buffer.from([9, 8, 7, 6]);
  const parts = [geometry, meshopt, webpA, webpB, tail];
  const offsets: number[] = [];
  let len = 0;
  for (const p of parts) {
    len = (len + 3) & ~3;
    offsets.push(len);
    len += p.length;
  }
  const bin = Buffer.alloc((len + 3) & ~3);
  parts.forEach((p, i) => p.copy(bin, offsets[i]));
  const json: GltfJson = {
    asset: { version: '2.0' } as GltfJson['asset'],
    extensionsUsed: ['EXT_meshopt_compression', 'EXT_texture_webp'],
    extensionsRequired: ['EXT_meshopt_compression', 'EXT_texture_webp'],
    buffers: [{ byteLength: bin.length }, { byteLength: 64, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: geometry.length },
      { buffer: 1, byteOffset: 0, byteLength: 64, byteStride: 8, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: offsets[1], byteLength: meshopt.length } } },
      { buffer: 0, byteOffset: offsets[2], byteLength: webpA.length },
      { buffer: 0, byteOffset: offsets[3], byteLength: webpB.length },
      { buffer: 0, byteOffset: offsets[4], byteLength: tail.length },
    ],
    images: [{ bufferView: 2, mimeType: 'image/webp' }, { bufferView: 3, mimeType: 'image/webp' }],
    textures: [{ sampler: 0, extensions: { EXT_texture_webp: { source: 0 } } }, { source: 1 }],
    materials: [
      { name: 'leaves', alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extras: { keep: 1 } },
      { name: 'wall', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } },
    ],
  };
  const ktxA = Buffer.from('KTX2-A-bytes-longer-than-before');
  const ktxB = Buffer.from('KTX2-B');
  const out = ktx.replaceImagesWithKtx2({ json, bin }, new Map([[0, ktxA], [1, ktxB]]), {
    materialExtras: new Map([[0, { alphaKind: 'cutout' }]]),
    assetExtras: { ktx2: { sourceSha256: 'x' } },
  });
  const round = ktx.parseGlb(ktx.writeGlb(out.json, out.bin));
  const j = round.json as GltfJson;
  const view = (i: number) => {
    const bv = j.bufferViews[i];
    const ext = bv.extensions?.EXT_meshopt_compression;
    const o = ext ? ext.byteOffset ?? 0 : bv.byteOffset ?? 0;
    return (round.bin as Buffer).subarray(o, o + (ext ? ext.byteLength : bv.byteLength));
  };
  check('rewrite: geometry view keeps its bytes', view(0).equals(geometry));
  check('rewrite: meshopt view keeps its bytes and fallback', view(1).equals(meshopt) && j.bufferViews[1].buffer === 1 && j.bufferViews[1].byteOffset === 0);
  check('rewrite: images hold the KTX2 bytes', view(2).equals(ktxA) && view(3).equals(ktxB));
  check('rewrite: trailing view keeps its bytes', view(4).equals(tail));
  check('rewrite: views start on 4-byte boundaries', j.bufferViews.every((bv) => ((bv.extensions?.EXT_meshopt_compression?.byteOffset ?? bv.byteOffset ?? 0) & 3) === 0));
  check('rewrite: buffer 0 length matches the chunk', j.buffers[0].byteLength === out.bin.length && j.buffers[1].byteLength === 64);
  check(
    'rewrite: textures point at KTX2 through KHR_texture_basisu',
    j.textures.every((t, i) => t.source === undefined && t.extensions?.KHR_texture_basisu?.source === i && !t.extensions?.EXT_texture_webp) &&
      j.images.every((im) => im.mimeType === 'image/ktx2') && j.textures[0].sampler === 0
  );
  check(
    'rewrite: extension lists',
    JSON.stringify(j.extensionsUsed) === '["EXT_meshopt_compression","KHR_texture_basisu"]' && JSON.stringify(j.extensionsRequired) === '["EXT_meshopt_compression","KHR_texture_basisu"]'
  );
  check(
    'rewrite: extras merged',
    JSON.stringify(j.materials[0].extras) === '{"keep":1,"alphaKind":"cutout"}' && j.asset.extras?.ktx2?.sourceSha256 === 'x'
  );
  let threw = false;
  try {
    ktx.replaceImagesWithKtx2({ json, bin }, new Map([[0, ktxA]]));
  } catch {
    threw = true;
  }
  check('rewrite: refuses to leave an image unconverted', threw);
}

// 3. Alpha kinds
{
  const img = (f: (x: number, y: number) => number) => {
    const px = new Uint8Array(256 * 256 * 4);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) px[(y * 256 + x) * 4 + 3] = f(x, y);
    return px;
  };
  const kinds = [ktx.alphaKindOf(img(() => 255), 256, 256), ktx.alphaKindOf(img((x) => (x < 128 ? 0 : 255)), 256, 256), ktx.alphaKindOf(img((x) => x), 256, 256)];
  check('alphaKindOf: opaque, cut-out, soft', JSON.stringify(kinds) === '["opaque","cutout","soft"]', JSON.stringify(kinds));
}

/**
 * Every texture of a converted file is KTX2: ETC1S or UASTC, its source's size, a full mip chain, sRGB for colour
 * slots and linear for data slots, alpha only where a material reads it; blended materials carry their alpha kind. A
 * venue layout file's textures that live in the shared file (LC_venue_shared) are checked there.
 */
function checkTextures(label: string, glb: { json: GltfJson; bin: Buffer }): void {
  const tj = glb.json;
  const usage = ktx.imageUsage(tj) as Map<number, { srgb: boolean; linear: boolean; alpha: boolean; blendMaterials: number[] }>;
  const problems: string[] = [];
  (tj.textures ?? []).forEach((t, i) => {
    if (t.extensions?.LC_venue_shared) return;
    if (t.source !== undefined || t.extensions?.EXT_texture_webp || t.extensions?.KHR_texture_basisu?.source === undefined) problems.push(`texture ${i} is not KHR_texture_basisu only`);
  });
  (tj.images ?? []).forEach((im, i) => {
    if (im.mimeType !== 'image/ktx2') return problems.push(`image ${i} is ${im.mimeType}`);
    const info = ktx.ktx2Info(ktx.viewBytes(glb, im.bufferView));
    const full = Math.floor(Math.log2(Math.max(info.width, info.height))) + 1;
    const u = usage.get(i);
    if (info.vkFormat !== 0) problems.push(`image ${i}: vkFormat ${info.vkFormat}`);
    if (!((info.codec === 'etc1s' && info.supercompression === 1) || (info.codec === 'uastc' && info.supercompression === 2))) problems.push(`image ${i}: ${info.codec} / supercompression ${info.supercompression}`);
    if (info.levelCount !== full) problems.push(`image ${i}: ${info.levelCount} of ${full} mip levels`);
    if (u && u.linear === info.srgb) problems.push(`image ${i}: ${info.srgb ? 'sRGB' : 'linear'} for a ${u.linear ? 'data' : 'colour'} slot`);
    if (u && info.hasAlpha && !u.alpha) problems.push(`image ${i}: alpha no material reads`);
  });
  check(`${label}: ${(tj.images ?? []).length} textures are KTX2, full mips, right colour space and alpha`, problems.length === 0, problems.slice(0, 6).join('; '));
  if ((tj.images ?? []).length) check(`${label}: KHR_texture_basisu required, no WebP left`, !!tj.extensionsRequired?.includes('KHR_texture_basisu') && !tj.extensionsUsed?.includes('EXT_texture_webp'));
  const blend = (tj.materials ?? []).filter((m) => m.alphaMode === 'BLEND' && m.pbrMetallicRoughness?.baseColorTexture && !(m as { extensions?: Record<string, unknown> }).extensions?.LC_venue_shared);
  check(`${label}: ${blend.length} blended materials carry their alpha kind`, blend.every((m) => ['opaque', 'cutout', 'soft'].includes(m.extras?.alphaKind as string)));
}

/**
 * A converted file against the file it was converted from: every buffer view that isn't an image keeps its bytes (the
 * physics nodes' are counted on their own), and the JSON matches but for images, textures, the converter's extras and,
 * for a venue layout file, the shared file's build it names
 */
function compareWithSource(label: string, out: { json: GltfJson; bin: Buffer }, sourcePath: string, build?: string): void {
  const src = ktx.parseGlb(readFileSync(sourcePath), sourcePath) as { json: GltfJson; bin: Buffer };
  const imageViews = new Set((src.json.images ?? []).map((im) => im.bufferView));
  const bytesOf = (g: { json: GltfJson; bin: Buffer }, i: number) => {
    const bv = g.json.bufferViews[i];
    const ext = bv.extensions?.EXT_meshopt_compression;
    const o = ext ? ext.byteOffset ?? 0 : bv.byteOffset ?? 0;
    const n = ext ? ext.byteLength : bv.byteLength;
    return g.bin.subarray(o, o + n);
  };
  const changed = src.json.bufferViews.map((_, i) => i).filter((i) => !imageViews.has(i) && !bytesOf(src, i).equals(bytesOf(out, i)));
  check(`${label}: ${src.json.bufferViews.length - imageViews.size} non-image buffer views byte-identical to ${path.basename(sourcePath)}`, changed.length === 0, changed.slice(0, 10).join(', '));

  // The physics on their own: Track_Collider_* / Track_Surface_* nodes (and nodes marked collider / hidden), their
  // meshes' accessors and the buffer views behind them
  const j = src.json as GltfJson & { nodes: { name?: string; mesh?: number; children?: number[]; extras?: Record<string, unknown> }[]; meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]; accessors: { bufferView?: number }[] };
  const physicsViews = new Set<number>();
  let physicsNodes = 0;
  const visit = (n: number, inPhysics: boolean) => {
    const node = j.nodes[n];
    const physics = inPhysics || /^Track_(Collider|Surface)_/.test(node.name ?? '') || !!node.extras?.collider || !!node.extras?.hidden;
    if (physics) physicsNodes++;
    if (physics && node.mesh !== undefined) {
      for (const p of j.meshes[node.mesh].primitives) {
        for (const acc of [...Object.values(p.attributes), ...(p.indices !== undefined ? [p.indices] : [])]) {
          const bv = j.accessors[acc].bufferView;
          if (bv !== undefined) physicsViews.add(bv);
        }
      }
    }
    for (const c of node.children ?? []) visit(c, physics);
  };
  for (const scene of (j as unknown as { scenes: { nodes: number[] }[] }).scenes) for (const n of scene.nodes) visit(n, false);
  const physicsChanged = [...physicsViews].filter((i) => !bytesOf(src, i).equals(bytesOf(out, i)));
  check(`${label}: ${physicsNodes} physics nodes, ${physicsViews.size} buffer views behind them, byte-identical`, physicsChanged.length === 0 && (physicsNodes > 0 || label.includes('.shared.')), physicsChanged.join(', '));

  const strip = (g: GltfJson) => {
    const { images, textures, materials, bufferViews, buffers, extensionsUsed, extensionsRequired, asset, ...rest } = structuredClone(g) as GltfJson & { extras?: { lcVenueLayout?: { shared?: string } } };
    void images; void textures; void extensionsUsed; void extensionsRequired; void asset;
    const restExtras = (rest as { extras?: { lcVenueLayout?: { shared?: string } } }).extras;
    if (restExtras?.lcVenueLayout) restExtras.lcVenueLayout.shared = undefined;
    return {
      rest,
      materials: materials.map(({ extras, ...m }) => {
        const kept = Object.entries(extras ?? {}).filter(([k]) => k !== 'alphaKind');
        return { ...m, extras: kept.length ? Object.fromEntries(kept) : undefined };
      }),
      views: bufferViews.map(({ byteOffset, extensions, ...bv }, i) => {
        void byteOffset;
        const ext = extensions?.EXT_meshopt_compression;
        return imageViews.has(i) ? { buffer: bv.buffer } : { ...bv, ...(ext ? { meshopt: { ...ext, byteOffset: 0 } } : {}) };
      }),
      buffers: buffers.slice(1),
    };
  };
  check(`${label}: nodes, meshes, accessors, materials and samplers match ${path.basename(sourcePath)}`, JSON.stringify(strip(src.json)) === JSON.stringify(strip(out.json)));
  if (build !== undefined) {
    const named = (out.json as { extras?: { lcVenueLayout?: { shared?: string } } }).extras?.lcVenueLayout?.shared;
    if (named !== undefined) check(`${label}: names the KTX2 shared file's build`, named === build, named);
  }
}

// 4. The listed models
const trackData = new Map<string, RawTrackJson>();
if (existsSync('public/tracks')) {
  for (const id of readdirSync('public/tracks')) {
    const f = `public/tracks/${id}/track_data.json`;
    if (existsSync(f)) trackData.set(id, JSON.parse(readFileSync(f, 'utf8')) as RawTrackJson);
  }
}
check('every listed build is 8 hex digits and every model a .glb', KTX2_MODELS.every((m) => /^[0-9a-f]{8}$/.test(m.build) && /\.glb$/.test(m.model)));

for (const entry of KTX2_MODELS) {
  const twinPath = `public${ktx2ModelUrl(entry.model)}`;
  const originalPath = `public${entry.model}`;
  if (!existsSync(twinPath) || !existsSync(originalPath)) {
    console.log(`  SKIP  ${entry.model}: hosted on librecorsa.org only, not in this copy (${!existsSync(twinPath) ? twinPath : originalPath})`);
    continue;
  }
  const twinBytes = readFileSync(twinPath);
  check(`${twinPath}: name matches its sha256`, sha256(twinBytes).startsWith(entry.build));
  const twin = ktx.parseGlb(twinBytes, twinPath) as { json: GltfJson; bin: Buffer };
  const tj = twin.json;
  checkTextures(twinPath, twin);

  // Physics through the game's own builders, against the WebP model players load today
  const layouts = [...trackData.entries()].filter(([, raw]) => (raw as { metadata?: { mesh?: { url?: string } } }).metadata?.mesh?.url === entry.model);
  for (const [id, raw] of layouts) {
    setActiveTrack(id, raw);
    const mesh = getActiveTrackMetadata().mesh;
    const build = (p: string) => {
      const root = loadGlbGeometry(p);
      const ground = TrackColliderQuery.fromTrackRoot(root, getActiveSurfaceTable(), { conformSurfaces: mesh?.conformSurfaces === true });
      const walls = TrackWallQuery.fromTrackRoot(root, mesh?.barrierMeshes, roadFacing);
      return { ...(ground.toBuffers() as unknown as Record<string, unknown>), ...Object.fromEntries(Object.entries(walls.toBuffers() as unknown as Record<string, unknown>).map(([k, v]) => [`wall.${k}`, v])) };
    };
    const digest = (v: unknown) => createHash('sha256').update(ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : JSON.stringify(v)).digest('hex');
    const a = build(originalPath);
    const b = build(twinPath);
    const differ = Object.keys(a).filter((k) => digest(a[k]) !== digest(b[k]));
    check(`${id}: colliders from the KTX2 model are byte-identical to the WebP model's (${Object.keys(a).length} buffers)`, differ.length === 0, differ.join(', '));
  }

  // Byte-level comparison with the converter's input, when this machine has it
  const want = tj.asset.extras?.ktx2?.sourceSha256;
  const dir = process.env.KTX2_SOURCE_DIR;
  const candidates = [originalPath, ...(dir && tj.asset.extras?.ktx2?.source ? [path.join(dir, path.basename(path.dirname(entry.model)), tj.asset.extras.ktx2.source)] : [])];
  const sourcePath = candidates.find((p) => existsSync(p) && sha256(readFileSync(p)) === want);
  if (!sourcePath) {
    console.log(`  SKIP  ${twinPath}: its source (sha256 ${want?.slice(0, 12)}…) is not here; set KTX2_SOURCE_DIR to compare byte for byte`);
    continue;
  }
  compareWithSource(twinPath, twin, sourcePath);
}

// 5. The venues' KTX2 builds for phones (venue-models.ts `ktx2Build`): the pair's own textures, and its bytes against the
// WebP pair it was converted from
for (const v of VENUE_MODELS.filter((m) => m.ktx2Build)) {
  for (const id of v.layouts) {
    const files = venueModelFiles(id)!;
    const kp = files.ktx2!;
    for (const [url, webpUrl] of [[kp.layoutUrl, files.layoutUrl], ...(id === v.layouts[0] ? [[kp.sharedUrl, files.sharedUrl]] : [])]) {
      const p = `public${url}`;
      if (!existsSync(p)) {
        console.log(`  SKIP  ${p}: hosted on librecorsa.org only, not in this copy`);
        continue;
      }
      const glb = ktx.parseGlb(readFileSync(p), p) as { json: GltfJson; bin: Buffer };
      checkTextures(p, glb);
      const src = `public${webpUrl}`;
      if (existsSync(src)) compareWithSource(p, glb, src, kp.build);
      else console.log(`  SKIP  ${p}: its WebP pair file ${src} is not in this copy`);
    }
  }
}

console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passes} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
