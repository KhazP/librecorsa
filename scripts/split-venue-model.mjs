/**
 * Splits the circuit GLBs of one venue's layouts (VIR's seven, the Red Bull Ring's three, ...) into one shared visual
 * model and one small file per layout, so a player who has driven one layout downloads only a few MB for the next.
 *
 *   node scripts/split-venue-model.mjs --venue vir --out <dir> vir=<vir.glb> vir_north=<vir_north.glb> ...
 *   node scripts/split-venue-model.mjs --venue vir --out <dir> vir vir_north ...   (inputs: public/tracks/<id>/<id>.glb)
 *   add --install public/tracks to also copy the outputs into each layout's folder there
 *
 * Writes to <dir>:
 * - `<venue>.shared.<build>.glb`: the `Track_Model` children that are identical in every layout (node, transform,
 *   extras, mesh data, material and textures, compared exactly), and every texture image that is identical in every
 *   layout. `Track_Model` itself carries no transform here.
 * - `<layout>.layout.<build>.glb` per layout: the layout's own file minus that shared part: its physics, its own
 *   `Track_Model` (with the layout's translation) and the children only it has, every other top-level node, and the
 *   nodes the game looks up by name (start lights, AC semaphores, `mesh.barrierMeshes`). Materials and textures that
 *   live in the shared file are referenced by index (`LC_venue_shared`), so they are downloaded and uploaded to the
 *   GPU once; the file's `extras.lcVenueLayout.order` restores the original order of `Track_Model`'s children.
 * - `split-report.json`: input and output md5s and sizes.
 *
 * `<build>` is the first 8 hex digits of the sha256 of the shared file and the layouts' input md5s: a rebuild from other
 * inputs gets new names (a physics-only change to one layout too), so files already on R2 for deployed code are never
 * replaced. src/lib/venue-models.ts names the build the game loads;
 * the loader is src/lib/render/venue-model.ts.
 *
 * Buffer views go across byte for byte where they can (every vertex stream here). A meshopt view whose accessors end
 * up in different files (the GLB's one index stream) is decoded and each accessor re-encoded on its own: TRIANGLES
 * when that decodes to the same indices, INDICES (lossless, larger) when TRIANGLES would rotate a triangle. Before
 * anything is written, every layout is rebuilt from its two outputs and compared with its input: the same node tree
 * (names, order, extras, transforms), the same decoded accessor bytes, the same materials, textures and images, and the
 * same sharing of materials, textures and images between meshes. Physics nodes are also checked on their own.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BinWriter,
  MESHOPT,
  accessorBytes,
  attributeCodecVersion,
  compressedBytes,
  encodeView,
  md5,
  meshoptOf,
  parseGlb,
  readGlb,
  ready,
  sha256,
  viewBytes,
  writeGlbBytes,
} from "./lib/glb-raw.mjs";
import { MeshoptDecoder } from "meshoptimizer";

export const VENUE_EXTENSION = "LC_venue_shared";

/** Nodes the game finds by name (scene-builder's start lights): kept in each layout's file */
const NAMED_LOOKUPS = [/^startlight_SUB1$/, /^Prop_StartLights_0$/, /^AC_SEMAPHORE_/i];

// ---------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const opts = { venue: undefined, out: undefined, install: undefined, layouts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--venue") opts.venue = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--install") opts.install = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else {
      const eq = a.indexOf("=");
      const id = eq < 0 ? a : a.slice(0, eq);
      const file = eq < 0 ? path.join("public/tracks", id, `${id}.glb`) : a.slice(eq + 1);
      opts.layouts.push({ id, file });
    }
  }
  if (!opts.venue || !opts.out || opts.layouts.length < 2) {
    throw new Error("usage: node scripts/split-venue-model.mjs --venue <id> --out <dir> [--install public/tracks] <layout>[=<glb>] <layout>[=<glb>] ...");
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys: exact content of nodes, accessors, materials, textures and images

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
};

const isPhysicsNode = (n) => /^Track_(Collider|Surface)_/.test(n.name ?? "") || Boolean(n.extras?.collider || n.extras?.hidden || n.extras?.surface);

/** The image a texture shows (core `source` or EXT_texture_webp / KHR_texture_basisu / EXT_texture_avif) */
const textureImage = (t) => t.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_avif?.source;

/** Every `{ index }` texture reference in a material, with a setter, in a fixed order */
function textureInfos(material) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o).sort()) {
      const v = o[k];
      if (/Texture$/.test(k) && v && typeof v === "object" && typeof v.index === "number") out.push(v);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(material);
  return out;
}

class Layout {
  constructor(id, file) {
    this.id = id;
    this.file = file;
    const bytes = readFileSync(file);
    this.md5 = md5(bytes);
    this.size = bytes.length;
    this.glb = parseGlb(bytes, file);
    this.json = this.glb.json;
    this.views = new Map();
    this.accKeys = new Map();
    this.imgKeys = new Map();
    this.nodeKeys = new Map();
    this.tm = this.json.nodes.findIndex((n) => n.name === "Track_Model");
    if (this.tm < 0) throw new Error(`${file}: no Track_Model node`);
    if (!this.json.scenes[this.json.scene ?? 0].nodes.includes(this.tm)) throw new Error(`${file}: Track_Model is not a top-level node`);
    const tmNode = this.json.nodes[this.tm];
    if (tmNode.mesh !== undefined || tmNode.matrix || tmNode.rotation || tmNode.scale) throw new Error(`${file}: Track_Model carries more than a translation`);
    if ((this.json.scenes?.length ?? 0) !== 1) throw new Error(`${file}: expected one scene`);
    if ((this.json.buffers ?? []).some((b, i) => i > 0 && !b.extensions?.[MESHOPT]?.fallback) || this.json.buffers?.[0]?.uri) {
      throw new Error(`${file}: data outside the GLB`);
    }
    const parents = new Map();
    this.json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parents.set(c, i)));
    this.parents = parents;
  }

  accKey(ai) {
    let k = this.accKeys.get(ai);
    if (!k) {
      const a = this.json.accessors[ai];
      const meta = stable({ ct: a.componentType, n: Boolean(a.normalized), t: a.type, c: a.count, min: a.min, max: a.max, name: a.name, extras: a.extras });
      k = sha256(Buffer.concat([Buffer.from(meta), accessorBytes(this.glb, ai, { views: this.views })]));
      this.accKeys.set(ai, k);
    }
    return k;
  }

  imgKey(ii) {
    let k = this.imgKeys.get(ii);
    if (!k) {
      const im = this.json.images[ii];
      if (im.uri) throw new Error(`${this.file}: image ${ii} is not in the GLB`);
      k = sha256(Buffer.concat([Buffer.from(stable({ mime: im.mimeType, name: im.name, extras: im.extras })), viewBytes(this.glb, im.bufferView)]));
      this.imgKeys.set(ii, k);
    }
    return k;
  }

  samplerKey(si) {
    return stable(si === undefined ? null : this.json.samplers[si]);
  }

  /** A texture's content: its image and sampler by content, the rest of its definition as is */
  texKey(ti) {
    const t = this.json.textures[ti];
    const rest = { ...t, source: undefined, sampler: undefined, extensions: t.extensions && Object.fromEntries(Object.entries(t.extensions).map(([k, v]) => [k, { ...v, source: undefined }])) };
    return stable({ image: this.imgKey(textureImage(t)), sampler: this.samplerKey(t.sampler), rest });
  }

  matKey(mi) {
    const m = structuredClone(this.json.materials[mi]);
    for (const info of textureInfos(m)) info.index = this.texKey(info.index);
    return stable(m);
  }

  /** A node and everything under it, by content */
  nodeKey(ni) {
    let k = this.nodeKeys.get(ni);
    if (!k) {
      const n = this.json.nodes[ni];
      if (n.skin !== undefined || n.camera !== undefined || n.weights) throw new Error(`${this.file}: node ${n.name} has a skin, camera or weights`);
      const mesh = n.mesh === undefined ? null : this.json.meshes[n.mesh];
      const desc = {
        node: { ...n, mesh: undefined, children: undefined },
        children: (n.children ?? []).map((c) => this.nodeKey(c)),
        mesh: mesh && {
          ...mesh,
          primitives: mesh.primitives.map((p) => {
            if (p.targets) throw new Error(`${this.file}: morph targets are not supported`);
            return {
              ...p,
              attributes: Object.fromEntries(Object.entries(p.attributes).map(([s, a]) => [s, this.accKey(a)])),
              indices: p.indices === undefined ? null : this.accKey(p.indices),
              material: p.material === undefined ? null : this.matKey(p.material),
            };
          }),
        },
      };
      k = sha256(stable(desc));
      this.nodeKeys.set(ni, k);
    }
    return k;
  }

  /** The node and its descendants */
  subtree(ni, out = []) {
    out.push(ni);
    for (const c of this.json.nodes[ni].children ?? []) this.subtree(c, out);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Which Track_Model children are shared

function eligible(layout, ni, keepNames) {
  return layout.subtree(ni).every((i) => {
    const n = layout.json.nodes[i];
    if (isPhysicsNode(n)) return false;
    const name = n.name ?? "";
    if (NAMED_LOOKUPS.some((re) => re.test(name))) return false;
    if (keepNames.some((b) => name === b || (name.startsWith(`${b}_chunk`) && /^\d+$/.test(name.slice(b.length + 6))))) return false;
    return true;
  });
}

/**
 * Per layout, the Track_Model children that go to the shared file (in that layout's order), and for each shared child
 * the reference layout's node it equals. Children are matched by content; a key present k times in every layout is
 * shared k times.
 */
function matchShared(layouts, keepNames, excluded) {
  const keyed = layouts.map((l) =>
    (l.json.nodes[l.tm].children ?? []).map((c) => ({ node: c, key: eligible(l, c, keepNames) && !excluded.has(l.nodeKey(c)) ? l.nodeKey(c) : null }))
  );
  const counts = keyed.map((list) => {
    const m = new Map();
    for (const { key } of list) if (key) m.set(key, (m.get(key) ?? 0) + 1);
    return m;
  });
  const shared = new Map();
  for (const [k, c] of counts[0]) {
    const n = Math.min(c, ...counts.slice(1).map((m) => m.get(k) ?? 0));
    if (n > 0) shared.set(k, n);
  }
  // Occurrence j of a key in one layout pairs with occurrence j of it in every other
  return keyed.map((list) => {
    const seen = new Map();
    const out = [];
    for (const { node, key } of list) {
      if (!key || !shared.has(key)) continue;
      const j = seen.get(key) ?? 0;
      if (j >= shared.get(key)) continue;
      seen.set(key, j + 1);
      out.push({ node, key, occurrence: j });
    }
    return out;
  });
}

/** Walks two equal subtrees side by side: (refNode, otherNode) pairs */
function pairNodes(a, ai, b, bi, out = []) {
  out.push([ai, bi]);
  const ca = a.json.nodes[ai].children ?? [];
  const cb = b.json.nodes[bi].children ?? [];
  ca.forEach((c, k) => pairNodes(a, c, b, cb[k], out));
  return out;
}

/** A one-to-one map that fails on any conflict */
class Bijection {
  constructor() {
    this.fwd = new Map();
    this.back = new Map();
  }
  add(a, b) {
    if (this.fwd.has(a) && this.fwd.get(a) !== b) return false;
    if (this.back.has(b) && this.back.get(b) !== a) return false;
    this.fwd.set(a, b);
    this.back.set(b, a);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Writing a GLB from a source GLB's parts

/**
 * Collects accessors and images from one or more source GLBs into a new binary chunk. Views whose accessors all come
 * along are copied byte for byte (compressed bytes included); others are re-packed per accessor (see the header).
 */
class GlbBuilder {
  constructor() {
    this.bin = new BinWriter();
    this.json = { accessors: [], bufferViews: [], images: [] };
    this.accMaps = new Map();
    this.imgMaps = new Map();
    this.usesMeshopt = false;
    this.stats = { verbatimViews: 0, repackedAttributeViews: 0, indexViewsTriangles: 0, indexViewsIndices: 0 };
  }

  accessorMap(src) {
    let m = this.accMaps.get(src);
    if (!m) this.accMaps.set(src, (m = new Map()));
    return m;
  }

  /** Adds these accessors of `src` (source indices); returns nothing, see `acc()` */
  addAccessors(src, indices) {
    const map = this.accessorMap(src);
    const want = [...new Set(indices)].filter((i) => !map.has(i)).sort((a, b) => a - b);
    const byView = new Map();
    for (const ai of want) {
      const a = src.json.accessors[ai];
      if (a.sparse) throw new Error(`${src.file}: sparse accessor ${ai}`);
      if (a.bufferView === undefined) {
        map.set(ai, this.json.accessors.push({ ...a }) - 1);
        continue;
      }
      if (!byView.has(a.bufferView)) byView.set(a.bufferView, []);
      byView.get(a.bufferView).push(ai);
    }
    const allOfView = new Map();
    src.json.accessors.forEach((a, i) => {
      if (a.bufferView === undefined) return;
      if (!allOfView.has(a.bufferView)) allOfView.set(a.bufferView, []);
      allOfView.get(a.bufferView).push(i);
    });
    for (const [bvi, accs] of [...byView].sort((x, y) => x[0] - y[0])) {
      const bv = src.json.bufferViews[bvi];
      const ext = meshoptOf(bv);
      const whole = allOfView.get(bvi).every((i) => accs.includes(i));
      if (whole) {
        const nbv = this.copyView(src, bvi);
        for (const ai of accs) map.set(ai, this.json.accessors.push({ ...src.json.accessors[ai], bufferView: nbv }) - 1);
        continue;
      }
      if (!ext) {
        // A plain view shared with accessors that stay behind: copy each accessor's rows
        const stride = bv.byteStride;
        for (const ai of accs) {
          const a = src.json.accessors[ai];
          const rows = accessorRows(src, ai);
          const nbv = this.json.bufferViews.push({ buffer: 0, byteOffset: this.bin.add(rows), byteLength: rows.length, ...(stride ? { byteStride: stride } : {}), ...(bv.target ? { target: bv.target } : {}) }) - 1;
          map.set(ai, this.json.accessors.push({ ...a, bufferView: nbv, byteOffset: 0 }) - 1);
        }
        continue;
      }
      const stored = viewBytes(src.glb, bvi, { filter: false });
      if (ext.mode === "ATTRIBUTES") {
        // Vertex streams: all of them in one new view (the vertex codec is lossless)
        for (const ai of accs) {
          const off = src.json.accessors[ai].byteOffset ?? 0;
          if (off % ext.byteStride) throw new Error(`${src.file}: interleaved view ${bvi} would need splitting`);
        }
        const blocks = accs.map((ai) => {
          const a = src.json.accessors[ai];
          const off = a.byteOffset ?? 0;
          return { ai, data: stored.subarray(off, off + a.count * ext.byteStride) };
        });
        const data = Buffer.concat(blocks.map((b) => b.data));
        const count = data.length / ext.byteStride;
        const version = attributeCodecVersion(compressedBytes(src.glb, bvi));
        const nbv = this.addMeshoptView(data, count, ext, bv, ext.mode, version);
        this.stats.repackedAttributeViews++;
        let at = 0;
        for (const { ai, data: d } of blocks) {
          map.set(ai, this.json.accessors.push({ ...src.json.accessors[ai], bufferView: nbv, byteOffset: at }) - 1);
          at += d.length;
        }
        continue;
      }
      // Index streams: one view per accessor, TRIANGLES if that decodes back exactly, else INDICES
      for (const ai of accs) {
        const a = src.json.accessors[ai];
        const off = a.byteOffset ?? 0;
        const data = Buffer.from(stored.subarray(off, off + a.count * ext.byteStride));
        let mode = ext.mode;
        if (mode === "TRIANGLES" && !roundTrips(data, a.count, ext.byteStride, mode)) mode = "INDICES";
        const nbv = this.addMeshoptView(data, a.count, ext, bv, mode);
        this.stats[mode === "TRIANGLES" ? "indexViewsTriangles" : "indexViewsIndices"]++;
        map.set(ai, this.json.accessors.push({ ...a, bufferView: nbv, byteOffset: 0 }) - 1);
      }
    }
  }

  /** A whole view, compressed bytes and all */
  copyView(src, bvi) {
    const bv = src.json.bufferViews[bvi];
    const ext = meshoptOf(bv);
    this.stats.verbatimViews++;
    if (!ext) {
      const data = viewBytes(src.glb, bvi);
      return this.json.bufferViews.push({ ...bv, buffer: 0, byteOffset: this.bin.add(data) }) - 1;
    }
    this.usesMeshopt = true;
    const comp = compressedBytes(src.glb, bvi);
    const at = this.bin.add(comp);
    const fallbackAt = this.bin.reserveFallback(bv.byteLength);
    return this.json.bufferViews.push({ ...bv, buffer: 1, byteOffset: fallbackAt, extensions: { ...bv.extensions, [MESHOPT]: { ...ext, buffer: 0, byteOffset: at } } }) - 1;
  }

  addMeshoptView(stored, count, ext, bv, mode, version) {
    this.usesMeshopt = true;
    const comp = encodeView(stored, count, ext.byteStride, mode, version);
    const check = Buffer.alloc(count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(check, count, ext.byteStride, comp, mode);
    if (!check.equals(stored)) throw new Error(`re-encoded ${mode} stream does not decode to its input`);
    const at = this.bin.add(comp);
    const fallbackAt = this.bin.reserveFallback(stored.length);
    const { buffer, byteOffset, byteLength, byteStride, target, extensions, ...rest } = bv;
    const view = { ...rest, buffer: 1, byteOffset: fallbackAt, byteLength: stored.length };
    if (mode === "ATTRIBUTES" && byteStride !== undefined) view.byteStride = byteStride;
    if (target !== undefined) view.target = target;
    view.extensions = { ...extensions, [MESHOPT]: { buffer: 0, byteOffset: at, byteLength: comp.length, byteStride: ext.byteStride, count, mode, ...(ext.filter && ext.filter !== "NONE" ? { filter: ext.filter } : {}) } };
    return this.json.bufferViews.push(view) - 1;
  }

  acc(src, ai) {
    const m = this.accMaps.get(src)?.get(ai);
    if (m === undefined) throw new Error(`accessor ${ai} of ${src.file} was not added`);
    return m;
  }

  /** Adds an image (its bytes byte for byte); returns its new index */
  image(src, ii) {
    let m = this.imgMaps.get(src);
    if (!m) this.imgMaps.set(src, (m = new Map()));
    if (m.has(ii)) return m.get(ii);
    const im = src.json.images[ii];
    const data = viewBytes(src.glb, im.bufferView);
    const bv = this.json.bufferViews.push({ buffer: 0, byteOffset: this.bin.add(data), byteLength: data.length }) - 1;
    const idx = this.json.images.push({ ...im, bufferView: bv }) - 1;
    m.set(ii, idx);
    return idx;
  }

  finish(json) {
    const out = { ...json, ...this.json };
    const bin = this.bin.bin();
    out.buffers = [{ byteLength: bin.length }];
    if (this.usesMeshopt) out.buffers.push({ byteLength: this.bin.fallbackLength, extensions: { [MESHOPT]: { fallback: true } } });
    // glTF arrays may not be empty
    for (const k of ["images", "accessors", "bufferViews", "meshes", "materials", "textures", "samplers"]) if (Array.isArray(out[k]) && !out[k].length) delete out[k];
    return writeGlbBytes(out, bin);
  }
}

function roundTrips(data, count, stride, mode) {
  const comp = encodeView(data, count, stride, mode);
  const check = Buffer.alloc(count * stride);
  MeshoptDecoder.decodeGltfBuffer(check, count, stride, comp, mode);
  return check.equals(data);
}

/** An accessor's rows (stride included) from a plain view */
function accessorRows(src, ai) {
  const a = src.json.accessors[ai];
  const bv = src.json.bufferViews[a.bufferView];
  const data = viewBytes(src.glb, a.bufferView);
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] * { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[a.type];
  const stride = bv.byteStride ?? size;
  const off = a.byteOffset ?? 0;
  return Buffer.from(data.subarray(off, off + stride * (a.count - 1) + size));
}

/** extensionsUsed / extensionsRequired for a written file: what its JSON uses, in the source's order */
function extensionLists(json, sources, extra = []) {
  const found = new Set(extra);
  const scan = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(scan);
    for (const [k, v] of Object.entries(o)) {
      if (k === "extensions" && v && typeof v === "object") for (const name of Object.keys(v)) found.add(name);
      scan(v);
    }
  };
  for (const key of ["materials", "textures", "nodes", "meshes", "bufferViews", "images", "samplers", "scenes"]) scan(json[key]);
  // KHR_mesh_quantization leaves no mark in the JSON: keep it wherever the source had it and meshes came along
  if (json.meshes?.length && sources.some((s) => s.json.extensionsUsed?.includes("KHR_mesh_quantization"))) found.add("KHR_mesh_quantization");
  found.delete(MESHOPT);
  if (json.bufferViews?.some((bv) => bv.extensions?.[MESHOPT])) found.add(MESHOPT);
  const order = [...new Set(sources.flatMap((s) => s.json.extensionsUsed ?? []))];
  const used = [...found].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9) || a.localeCompare(b));
  const required = used.filter((e) => e === VENUE_EXTENSION || sources.some((s) => s.json.extensionsRequired?.includes(e)));
  return { used, required };
}

// ---------------------------------------------------------------------------------------------------------------
// The split

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await ready;
  const layouts = opts.layouts.map(({ id, file }) => new Layout(id, file));
  const ref = layouts[0];
  // Drawn barriers the cars hit (track data `mesh.barrierMeshes`) are physics: they stay in each layout's file
  const keepNames = [
    ...new Set(
      layouts.flatMap((l) => {
        const td = path.join("public/tracks", l.id, "track_data.json");
        return existsSync(td) ? (JSON.parse(readFileSync(td, "utf8")).metadata?.mesh?.barrierMeshes ?? []) : [];
      })
    ),
  ];

  // 1. Shared children, then the material / texture / image / sampler correspondence they imply in every layout.
  //    A shared child whose materials or textures map ambiguously goes back to the layout files, and we go again.
  const excluded = new Set();
  let matched;
  let corr;
  /** A shared child's place among the shared file's Track_Model children, by key and occurrence */
  let sPos;
  const occ = (m) => `${m.key}#${m.occurrence}`;
  for (;;) {
    matched = matchShared(layouts, keepNames, excluded);
    sPos = new Map(matched[0].map((m, k) => [occ(m), k]));
    corr = layouts.map(() => ({ mat: new Bijection(), img: new Bijection(), smp: new Bijection() }));
    const bad = new Set();
    for (let li = 0; li < layouts.length; li++) {
      const l = layouts[li];
      matched[li].forEach((m) => {
        const r = matched[0][sPos.get(occ(m))];
        if (!r || r.key !== m.key) throw new Error("internal: shared children out of step");
        for (const [rn, ln] of pairNodes(ref, r.node, l, m.node)) {
          const rmesh = ref.json.nodes[rn].mesh;
          if (rmesh === undefined) continue;
          ref.json.meshes[rmesh].primitives.forEach((rp, pi) => {
            const lp = l.json.meshes[l.json.nodes[ln].mesh].primitives[pi];
            if (rp.material === undefined) return;
            if (!corr[li].mat.add(rp.material, lp.material)) bad.add(m.key);
            const rinfos = textureInfos(ref.json.materials[rp.material]);
            const linfos = textureInfos(l.json.materials[lp.material]);
            rinfos.forEach((ri, t) => {
              const rt = ref.json.textures[ri.index];
              const lt = l.json.textures[linfos[t].index];
              if (!corr[li].img.add(textureImage(rt), textureImage(lt))) bad.add(m.key);
              if (!corr[li].smp.add(rt.sampler ?? -1, lt.sampler ?? -1)) bad.add(m.key);
            });
          });
        }
      });
    }
    if (!bad.size) break;
    for (const k of bad) excluded.add(k);
    console.log(`  ${bad.size} shared node(s) map materials or textures ambiguously: kept in the layout files`);
  }

  // 2. Shared images: identical in every layout (and unique within each), plus every image a shared material shows
  const imgCount = layouts.map((l) => {
    const m = new Map();
    (l.json.images ?? []).forEach((_, i) => m.set(l.imgKey(i), (m.get(l.imgKey(i)) ?? 0) + 1));
    return m;
  });
  const sharedImgKeys = new Set([...imgCount[0].keys()].filter((k) => imgCount.every((m) => m.get(k) === 1)));
  for (const [ri] of corr[0].img.fwd) {
    if (!sharedImgKeys.has(ref.imgKey(ri))) throw new Error(`image ${ri} of a shared material is not identical in every layout`);
  }
  // Per layout: image index → reference layout's image index, for every shared image
  const imgToRef = layouts.map((l, li) => {
    const byKey = new Map((ref.json.images ?? []).map((_, i) => [ref.imgKey(i), i]));
    const m = new Map();
    (l.json.images ?? []).forEach((_, i) => {
      if (sharedImgKeys.has(l.imgKey(i))) m.set(i, byKey.get(l.imgKey(i)));
    });
    for (const [ri, lii] of corr[li].img.fwd) if (m.get(lii) !== ri) throw new Error(`${l.id}: shared images disagree`);
    return m;
  });

  // 3. The shared file's materials (from the reference layout), textures and samplers
  const S = new GlbBuilder();
  const sJson = { materials: [], textures: [], samplers: [] };
  const sMat = new Map();
  const sSampler = new Map();
  const sTexture = new Map();
  /** The shared file's texture showing reference image `ri` through a sampler like `samplerDef` (made on first use) */
  const sharedTexture = (ri, samplerDef, rest) => {
    const skey = stable(samplerDef ?? null);
    let si = sSampler.get(skey);
    if (si === undefined && samplerDef) sSampler.set(skey, (si = sJson.samplers.push(structuredClone(samplerDef)) - 1));
    const tkey = stable({ ri, si: si ?? null, rest });
    let ti = sTexture.get(tkey);
    if (ti === undefined) {
      const img = S.image(ref, ri);
      const t = structuredClone(rest ?? {});
      if (si !== undefined) t.sampler = si;
      const mime = ref.json.images[ri].mimeType;
      if (mime === "image/webp") t.extensions = { ...t.extensions, EXT_texture_webp: { source: img } };
      else if (mime === "image/avif") t.extensions = { ...t.extensions, EXT_texture_avif: { source: img } };
      else if (mime === "image/ktx2") t.extensions = { ...t.extensions, KHR_texture_basisu: { source: img } };
      else t.source = img;
      sTexture.set(tkey, (ti = sJson.textures.push(t) - 1));
    }
    return ti;
  };
  const textureRest = (t) => {
    const r = structuredClone(t);
    delete r.source;
    delete r.sampler;
    if (r.extensions) {
      for (const k of ["EXT_texture_webp", "EXT_texture_avif", "KHR_texture_basisu"]) delete r.extensions[k];
      if (!Object.keys(r.extensions).length) delete r.extensions;
    }
    return r;
  };
  // Every shared image goes in, in the reference layout's order, so the file holds them whether or not a shared mesh shows them
  for (let i = 0; i < (ref.json.images ?? []).length; i++) if (sharedImgKeys.has(ref.imgKey(i))) S.image(ref, i);
  const addSharedMaterial = (rm) => {
    if (sMat.has(rm)) return sMat.get(rm);
    const m = structuredClone(ref.json.materials[rm]);
    for (const info of textureInfos(m)) {
      const t = ref.json.textures[info.index];
      info.index = sharedTexture(textureImage(t), t.sampler === undefined ? undefined : ref.json.samplers[t.sampler], textureRest(t));
    }
    const idx = sJson.materials.push(m) - 1;
    sMat.set(rm, idx);
    return idx;
  };

  // Shared nodes: Track_Model (no transform) and the reference layout's shared children
  const sNodes = [{ name: "Track_Model", children: [] }];
  const sMeshes = [];
  const copyNode = (src, ni, mapMaterial, out, meshes, builder) => {
    const n = src.json.nodes[ni];
    const copy = structuredClone(n);
    delete copy.children;
    if (n.mesh !== undefined) {
      const mesh = structuredClone(src.json.meshes[n.mesh]);
      const accs = [];
      for (const p of src.json.meshes[n.mesh].primitives) {
        accs.push(...Object.values(p.attributes));
        if (p.indices !== undefined) accs.push(p.indices);
      }
      builder.addAccessors(src, accs);
      mesh.primitives = mesh.primitives.map((p) => ({
        ...p,
        attributes: Object.fromEntries(Object.entries(p.attributes).map(([s, a]) => [s, builder.acc(src, a)])),
        ...(p.indices !== undefined ? { indices: builder.acc(src, p.indices) } : {}),
        ...(p.material !== undefined ? { material: mapMaterial(p.material) } : {}),
      }));
      copy.mesh = meshes.push(mesh) - 1;
    }
    const idx = out.push(copy) - 1;
    const kids = (n.children ?? []).map((c) => copyNode(src, c, mapMaterial, out, meshes, builder));
    if (kids.length) out[idx].children = kids;
    return idx;
  };
  /** Every accessor the meshes of these subtrees use: added in one go, so a view they share is copied whole */
  const accessorsOf = (src, roots) => {
    const out = [];
    for (const r of roots) {
      for (const ni of src.subtree(r)) {
        const mi = src.json.nodes[ni].mesh;
        if (mi === undefined) continue;
        for (const p of src.json.meshes[mi].primitives) {
          out.push(...Object.values(p.attributes));
          if (p.indices !== undefined) out.push(p.indices);
        }
      }
    }
    return out;
  };
  S.addAccessors(ref, accessorsOf(ref, matched[0].map((m) => m.node)));
  for (const { node } of matched[0]) sNodes[0].children.push(copyNode(ref, node, addSharedMaterial, sNodes, sMeshes, S));

  // 4. Layout files. A material a shared mesh uses is referenced; any other material stays, and its textures are
  //    referenced when their image is shared.
  const layoutOut = [];
  for (let li = 0; li < layouts.length; li++) {
    const l = layouts[li];
    const sharedSet = new Set(matched[li].map((m) => m.node));
    const sharedPos = new Map(matched[li].map((m) => [m.node, sPos.get(occ(m))]));
    const B = new GlbBuilder();
    const scene0 = l.json.scenes[l.json.scene ?? 0];
    B.addAccessors(
      l,
      accessorsOf(l, [...scene0.nodes.filter((ni) => ni !== l.tm), ...(l.json.nodes[l.tm].children ?? []).filter((c) => !sharedSet.has(c))])
    );
    const out = { materials: [], textures: [], samplers: [] };
    const nodes = [];
    const meshes = [];
    const lMat = new Map();
    const lTex = new Map();
    const lSmp = new Map();
    const mapTexture = (ti) => {
      if (lTex.has(ti)) return lTex.get(ti);
      const t = l.json.textures[ti];
      const ii = textureImage(t);
      let idx;
      if (imgToRef[li].has(ii)) {
        const sti = sharedTexture(imgToRef[li].get(ii), t.sampler === undefined ? undefined : l.json.samplers[t.sampler], textureRest(t));
        idx = out.textures.push({ extensions: { [VENUE_EXTENSION]: { texture: sti } } }) - 1;
      } else {
        const copy = structuredClone(t);
        const img = B.image(l, ii);
        if (copy.source !== undefined) copy.source = img;
        for (const k of ["EXT_texture_webp", "EXT_texture_avif", "KHR_texture_basisu"]) if (copy.extensions?.[k]) copy.extensions[k].source = img;
        if (t.sampler !== undefined) {
          if (!lSmp.has(t.sampler)) lSmp.set(t.sampler, out.samplers.push(structuredClone(l.json.samplers[t.sampler])) - 1);
          copy.sampler = lSmp.get(t.sampler);
        }
        idx = out.textures.push(copy) - 1;
      }
      lTex.set(ti, idx);
      return idx;
    };
    const mapMaterial = (mi) => {
      if (lMat.has(mi)) return lMat.get(mi);
      let idx;
      const rm = corr[li].mat.back.get(mi);
      if (rm !== undefined) {
        const m = l.json.materials[mi];
        // The material's name stays on the stub for tools that read the file alone (scripts/lib/glb-geometry.ts)
        idx = out.materials.push({ ...(m.name !== undefined ? { name: m.name } : {}), extensions: { [VENUE_EXTENSION]: { material: addSharedMaterial(rm) } } }) - 1;
      } else {
        const m = structuredClone(l.json.materials[mi]);
        for (const info of textureInfos(m)) info.index = mapTexture(info.index);
        idx = out.materials.push(m) - 1;
      }
      lMat.set(mi, idx);
      return idx;
    };
    const scene = l.json.scenes[l.json.scene ?? 0];
    const top = [];
    const order = [];
    for (const ni of scene.nodes) {
      if (ni !== l.tm) {
        top.push(copyNode(l, ni, mapMaterial, nodes, meshes, B));
        continue;
      }
      const tm = structuredClone(l.json.nodes[l.tm]);
      delete tm.children;
      const tmIdx = nodes.push(tm) - 1;
      const kids = [];
      for (const c of l.json.nodes[l.tm].children ?? []) {
        if (sharedSet.has(c)) order.push(sharedPos.get(c));
        else {
          order.push(~kids.length);
          kids.push(copyNode(l, c, mapMaterial, nodes, meshes, B));
        }
      }
      if (kids.length) nodes[tmIdx].children = kids;
      top.push(tmIdx);
    }
    layoutOut.push({ l, B, out, nodes, meshes, top, order });
  }

  // 5. Write the shared file, then the layout files that name its build
  const sharedJsonBase = {
    asset: { ...ref.json.asset },
    extras: { lcVenueShared: { venue: opts.venue, layouts: layouts.map((l) => l.id), sharedNodes: matched[0].length } },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: sNodes,
    meshes: sMeshes,
    ...sJson,
  };
  if (!sharedJsonBase.samplers.length) delete sharedJsonBase.samplers;
  const sExt = extensionLists({ ...sharedJsonBase, bufferViews: S.json.bufferViews }, layouts);
  const sharedBytes = S.finish({ ...sharedJsonBase, extensionsUsed: sExt.used, ...(sExt.required.length ? { extensionsRequired: sExt.required } : {}) });
  // The layouts' inputs too: a change to one layout's own part (its physics) leaves the shared file as it was, and a
  // build named by the shared file alone would rewrite that layout's file under a name already on R2
  const build = sha256(Buffer.concat([sharedBytes, ...layouts.map((l) => Buffer.from(l.md5))])).slice(0, 8);
  const sharedName = `${opts.venue}.shared.${build}.glb`;

  const outputs = [];
  for (const { l, B, out, nodes, meshes, top, order } of layoutOut) {
    const json = {
      asset: { ...l.json.asset },
      extras: { lcVenueLayout: { venue: opts.venue, shared: build, order } },
      scene: 0,
      scenes: [{ ...l.json.scenes[l.json.scene ?? 0], nodes: top }],
      nodes,
      meshes,
      ...out,
    };
    for (const k of ["materials", "textures", "samplers"]) if (!json[k].length) delete json[k];
    const ext = extensionLists({ ...json, bufferViews: B.json.bufferViews }, [l], json.materials?.some((m) => m.extensions?.[VENUE_EXTENSION]) || json.textures?.some((t) => t.extensions?.[VENUE_EXTENSION]) ? [VENUE_EXTENSION] : []);
    const bytes = B.finish({ ...json, extensionsUsed: ext.used, ...(ext.required.length ? { extensionsRequired: ext.required } : {}) });
    outputs.push({ l, name: `${l.id}.layout.${build}.glb`, bytes, stats: B.stats });
  }

  // 6. Check every layout against its input before writing anything
  const sharedGlb = parseGlb(sharedBytes, sharedName);
  let failed = false;
  for (const o of outputs) {
    const layoutGlb = parseGlb(o.bytes, o.name);
    const problems = [...compareLayout(o.l, layoutGlb, sharedGlb), ...comparePhysics(o.l, layoutGlb)];
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${o.l.id}:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  ... ${problems.length - 20} more` : ""}`);
    } else {
      console.log(`PASS ${o.l.id}: shared + layout file rebuild the input exactly (node tree, accessor bytes, materials, textures, images, sharing); physics byte-identical`);
    }
  }
  if (failed) process.exit(1);

  mkdirSync(opts.out, { recursive: true });
  writeFileSync(path.join(opts.out, sharedName), sharedBytes);
  for (const o of outputs) writeFileSync(path.join(opts.out, o.name), o.bytes);
  const report = {
    venue: opts.venue,
    build,
    shared: { file: sharedName, bytes: sharedBytes.length, md5: md5(sharedBytes), nodes: matched[0].length, images: S.json.images.length, materials: sJson.materials.length, views: S.stats },
    layouts: outputs.map((o) => ({
      id: o.l.id,
      input: { file: path.resolve(o.l.file), bytes: o.l.size, md5: o.l.md5 },
      output: { file: o.name, bytes: o.bytes.length, md5: md5(o.bytes), views: o.stats },
      sharedChildren: matched[layouts.indexOf(o.l)].length,
      ownChildren: (o.l.json.nodes[o.l.tm].children ?? []).length - matched[layouts.indexOf(o.l)].length,
    })),
  };
  writeFileSync(path.join(opts.out, "split-report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const mb = (n) => (n / 1e6).toFixed(2);
  const before = layouts.reduce((s, l) => s + l.size, 0);
  const after = sharedBytes.length + outputs.reduce((s, o) => s + o.bytes.length, 0);
  console.log(`\n${opts.venue} build ${build}: ${layouts.length} layouts ${mb(before)} MB -> ${mb(after)} MB (shared ${mb(sharedBytes.length)} MB, ${matched[0].length} shared Track_Model children)`);
  for (const o of outputs) console.log(`  ${o.l.id.padEnd(22)} ${mb(o.l.size).padStart(7)} MB -> first ${mb(sharedBytes.length + o.bytes.length).padStart(7)} MB, after another layout ${mb(o.bytes.length).padStart(6)} MB`);
  console.log(`\nsrc/lib/venue-models.ts entry:\n  { venue: "${opts.venue}", build: "${build}", layouts: [${layouts.map((l) => `"${l.id}"`).join(", ")}] },`);

  if (opts.install) {
    const dir = (id) => path.join(opts.install, id);
    copyFileSync(path.join(opts.out, sharedName), path.join(dir(opts.venue), sharedName));
    for (const o of outputs) copyFileSync(path.join(opts.out, o.name), path.join(dir(o.l.id), o.name));
    console.log(`installed into ${opts.install}/<id>/`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

/**
 * The scene a GLTFLoader-style load builds from a file (or a layout file plus the shared file), described exactly:
 * the node tree in order with names, extras and transforms, each primitive's accessors (metadata and decoded bytes),
 * and its material with textures and images by content. Materials, textures (one object per image and sampler, as
 * three's GLTFLoader caches them) and images also get an identity, so sharing between meshes can be compared.
 */
function describeScene(files) {
  const views = new Map(files.map((f) => [f, new Map()]));
  const main = files[0];
  const shared = files[1];
  const imgId = (f, ii) => `${f === main ? "L" : "S"}img${ii}`;
  const resolveTexture = (f, ti) => {
    const t = f.glb.json.textures[ti];
    const ref = t.extensions?.[VENUE_EXTENSION];
    if (ref) return resolveTexture(shared, ref.texture);
    const ii = textureImage(t);
    const im = f.glb.json.images[ii];
    const rest = { ...t, source: undefined, sampler: undefined, extensions: t.extensions && Object.fromEntries(Object.entries(t.extensions).map(([k, v]) => [k, { ...v, source: undefined }])) };
    return {
      id: `${f === main ? "L" : "S"}tex${im.bufferView}:${t.sampler}`,
      imageId: imgId(f, ii),
      content: stable({ image: sha256(Buffer.concat([Buffer.from(stable({ mime: im.mimeType, name: im.name, extras: im.extras })), viewBytes(f.glb, im.bufferView)])), sampler: t.sampler === undefined ? null : f.glb.json.samplers[t.sampler], rest }),
    };
  };
  const resolveMaterial = (f, mi) => {
    const m = f.glb.json.materials[mi];
    const ref = m.extensions?.[VENUE_EXTENSION];
    if (ref) return resolveMaterial(shared, ref.material);
    const copy = structuredClone(m);
    const textures = [];
    for (const info of textureInfos(copy)) {
      const r = resolveTexture(f, info.index);
      textures.push(r);
      info.index = r.content;
    }
    return { id: `${f === main ? "L" : "S"}mat${mi}`, content: stable(copy), textures };
  };
  const nodes = [];
  const walk = (f, ni, depth, parentPath) => {
    const n = f.glb.json.nodes[ni];
    const pathName = `${parentPath}/${n.name ?? ""}`;
    const entry = { path: pathName, depth, node: stable({ ...n, mesh: undefined, children: undefined }), prims: [] };
    if (n.mesh !== undefined) {
      const mesh = f.glb.json.meshes[n.mesh];
      entry.mesh = stable({ ...mesh, primitives: undefined });
      for (const p of mesh.primitives) {
        const acc = (ai) => {
          const a = f.glb.json.accessors[ai];
          return stable({ meta: { ...a, bufferView: undefined, byteOffset: undefined }, bytes: sha256(accessorBytes(f.glb, ai, { views: views.get(f) })) });
        };
        entry.prims.push({
          prim: stable({ ...p, attributes: undefined, indices: undefined, material: undefined }),
          attributes: stable(Object.fromEntries(Object.entries(p.attributes).map(([s, a]) => [s, acc(a)]))),
          indices: p.indices === undefined ? null : acc(p.indices),
          material: p.material === undefined ? null : resolveMaterial(f, p.material),
        });
      }
    }
    nodes.push(entry);
    let kids = (n.children ?? []).map((c) => [f, c]);
    if (n.name === "Track_Model" && depth === 0 && shared) {
      const order = f.glb.json.extras?.lcVenueLayout?.order ?? [];
      const sTm = shared.glb.json.scenes[0].nodes[0];
      const sKids = shared.glb.json.nodes[sTm].children ?? [];
      kids = order.map((o) => (o >= 0 ? [shared, sKids[o]] : [f, (n.children ?? [])[~o]]));
      if (kids.some(([, c]) => c === undefined)) throw new Error("order names a child that is not there");
      if (kids.length !== (n.children ?? []).length + new Set(order.filter((o) => o >= 0)).size) throw new Error("order leaves children out");
    }
    for (const [ff, c] of kids) walk(ff, c, depth + 1, pathName);
  };
  for (const ni of main.glb.json.scenes[main.glb.json.scene ?? 0].nodes) walk(main, ni, 0, "");
  return nodes;
}

/** Compares a layout's input with its split pair; returns the differences */
function compareLayout(input, layoutGlb, sharedGlb) {
  const problems = [];
  const a = describeScene([{ glb: input.glb, file: input.file }]);
  const lf = { glb: layoutGlb, file: "layout" };
  const sf = { glb: sharedGlb, file: "shared" };
  let b;
  try {
    b = describeScene([lf, sf]);
  } catch (err) {
    return [String(err)];
  }
  if (a.length !== b.length) problems.push(`node count ${a.length} vs ${b.length}`);
  const mat = new Bijection();
  const tex = new Bijection();
  const img = new Bijection();
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.depth !== y.depth) problems.push(`node ${i}: ${x.path} vs ${y.path}`);
    if (x.node !== y.node) problems.push(`${x.path}: node definition differs`);
    if (x.mesh !== y.mesh) problems.push(`${x.path}: mesh definition differs`);
    if (x.prims.length !== y.prims.length) problems.push(`${x.path}: primitive count`);
    x.prims.forEach((p, k) => {
      const q = y.prims[k];
      if (!q) return;
      if (p.prim !== q.prim) problems.push(`${x.path}[${k}]: primitive mode/extras differ`);
      if (p.attributes !== q.attributes) problems.push(`${x.path}[${k}]: attribute accessors differ`);
      if (p.indices !== q.indices) problems.push(`${x.path}[${k}]: indices differ`);
      if (!p.material !== !q.material) problems.push(`${x.path}[${k}]: material presence differs`);
      if (p.material && q.material) {
        if (p.material.content !== q.material.content) problems.push(`${x.path}[${k}]: material ${p.material.id} differs`);
        if (!mat.add(p.material.id, q.material.id)) problems.push(`${x.path}[${k}]: material sharing differs (${p.material.id} / ${q.material.id})`);
        p.material.textures.forEach((t, j) => {
          const u = q.material.textures[j];
          if (!u) return;
          if (!tex.add(t.id, u.id)) problems.push(`${x.path}[${k}]: texture sharing differs`);
          if (!img.add(t.imageId, u.imageId)) problems.push(`${x.path}[${k}]: image sharing differs`);
        });
      }
    });
  }
  return problems;
}

/** Physics nodes: the same JSON and the same decoded (and stored) accessor bytes, in the same scene order */
function comparePhysics(input, layoutGlb) {
  const problems = [];
  const list = (glb) => {
    const out = [];
    const walk = (ni) => {
      const n = glb.json.nodes[ni];
      if (isPhysicsNode(n)) out.push(ni);
      for (const c of n.children ?? []) walk(c);
    };
    for (const ni of glb.json.scenes[glb.json.scene ?? 0].nodes) walk(ni);
    return out;
  };
  const a = list(input.glb);
  const b = list(layoutGlb);
  if (a.length !== b.length) return [`physics node count ${a.length} vs ${b.length}`];
  const va = new Map();
  const vb = new Map();
  a.forEach((ni, k) => {
    const x = input.glb.json.nodes[ni];
    const y = layoutGlb.json.nodes[b[k]];
    if (stable({ ...x, mesh: undefined, children: undefined }) !== stable({ ...y, mesh: undefined, children: undefined })) problems.push(`physics node ${x.name}: definition differs`);
    if ((x.mesh === undefined) !== (y.mesh === undefined)) problems.push(`physics node ${x.name}: mesh presence`);
    if (x.mesh === undefined) return;
    const mx = input.glb.json.meshes[x.mesh];
    const my = layoutGlb.json.meshes[y.mesh];
    mx.primitives.forEach((p, k2) => {
      const q = my.primitives[k2];
      const pairs = [...Object.keys(p.attributes).map((s) => [p.attributes[s], q.attributes[s], s]), ...(p.indices !== undefined ? [[p.indices, q.indices, "indices"]] : [])];
      for (const [ai, bi, s] of pairs) {
        const am = input.glb.json.accessors[ai];
        const bm = layoutGlb.json.accessors[bi];
        if (stable({ ...am, bufferView: undefined, byteOffset: undefined }) !== stable({ ...bm, bufferView: undefined, byteOffset: undefined })) problems.push(`physics ${x.name} ${s}: accessor metadata differs`);
        for (const filter of [true, false]) {
          if (!accessorBytes(input.glb, ai, { filter, views: va }).equals(accessorBytes(layoutGlb, bi, { filter, views: vb }))) problems.push(`physics ${x.name} ${s}: ${filter ? "decoded" : "stored"} bytes differ`);
        }
      }
    });
  });
  return problems;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
