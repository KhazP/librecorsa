/**
 * Leaves props out of a built circuit GLB: every scenery node whose meshes are drawn only with the named diffuse
 * textures goes, and with it whatever nothing else uses (meshes, accessors, buffer views, materials, textures, images).
 * Everything that stays keeps its bytes: compressed buffer views and images are copied as they are, so the geometry,
 * physics and textures left are byte for byte the input's.
 *
 *   node scripts/strip-track-props.mjs <in.glb> <out.glb> --texture '<regex>' [--texture '<regex>'] [--report <json>]
 *   node scripts/strip-track-props.mjs <in.glb> <out.glb> --replace '<image name>=<file>' [--texture ...]
 *
 * `--texture` matches an image's name (the mod's file name, e.g. `ac_crew.dds`), case-insensitively. A node only goes
 * when every primitive of its mesh uses such a texture as its base colour; a mesh that mixes them is an error, as is a
 * matching node with children of its own. `--replace` swaps one image's bytes for a file of the same format (a
 * texture with a logo painted out, where the mesh itself stays). Run it on a layout's full GLB, then re-split the venue
 * (scripts/split-venue-model.mjs) and rebuild the KTX2 pair (scripts/ktx2-track-textures.mjs --venue): a stripped
 * shared file is a new build. Before writing, the output is read back and every kept accessor is decoded and compared
 * with the input's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BinWriter, MESHOPT, accessorBytes, isFallbackBuffer, md5, meshoptOf, parseGlb, readGlb, ready, writeGlbBytes } from "./lib/glb-raw.mjs";

function parseArgs(argv) {
  const opts = { textures: [], replace: new Map(), report: undefined, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--texture") opts.textures.push(new RegExp(argv[++i], "i"));
    else if (a === "--replace") {
      const v = argv[++i];
      const eq = v.indexOf("=");
      if (eq < 1) throw new Error(`--replace takes <image name>=<file>, got ${v}`);
      opts.replace.set(v.slice(0, eq), readFileSync(v.slice(eq + 1)));
    } else if (a === "--report") opts.report = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  if (opts.files.length !== 2 || (!opts.textures.length && !opts.replace.size)) {
    throw new Error("usage: node scripts/strip-track-props.mjs <in.glb> <out.glb> [--texture '<regex>' ...] [--replace '<image>=<file>' ...] [--report <json>]");
  }
  return opts;
}

/** Every `{ index }` texture reference in a material, wherever an extension puts it */
function textureRefs(obj, out = []) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      if (/texture$/i.test(k) && typeof v.index === "number") out.push(v);
      textureRefs(v, out);
    }
  }
  return out;
}

const imageOf = (tex) => tex.source ?? tex.extensions?.EXT_texture_webp?.source ?? tex.extensions?.KHR_texture_basisu?.source;

/** Remaps an index list through `map` (old index -> new index), dropping removed entries */
const remapList = (list, map) => list.filter((i) => map.has(i)).map((i) => map.get(i));

/** Keeps the entries of `arr` whose old index is in `keep` (a Set), in order; returns the kept array and the remap */
function compact(arr, keep) {
  const map = new Map();
  const out = [];
  arr.forEach((item, i) => {
    if (keep.has(i)) {
      map.set(i, out.length);
      out.push(item);
    }
  });
  return { out, map };
}

export function stripProps(glb, textures, replace = new Map()) {
  const src = glb.json;
  for (const k of ["skins", "animations", "cameras"]) if (src[k]?.length) throw new Error(`${k} are not handled`);
  if (src.buffers.length > 2 || (src.buffers.length === 2 && !isFallbackBuffer(src.buffers[1]))) {
    throw new Error("expected buffer 0 (the GLB's binary chunk) and at most a meshopt fallback buffer");
  }
  const json = structuredClone(src);

  const baseImage = (mi) => {
    const t = json.materials[mi]?.pbrMetallicRoughness?.baseColorTexture;
    if (!t) return undefined;
    const img = imageOf(json.textures[t.index]);
    return img === undefined ? undefined : json.images[img].name ?? "";
  };
  const hit = (mi) => {
    const name = baseImage(mi);
    return name !== undefined && textures.some((re) => re.test(name));
  };

  // Nodes to drop: every primitive of the mesh drawn with a matched texture
  const drop = new Set();
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    const prims = json.meshes[n.mesh].primitives;
    const hits = prims.filter((p) => p.material !== undefined && hit(p.material)).length;
    if (!hits) return;
    if (hits !== prims.length) throw new Error(`node ${ni} "${n.name}" mixes matched and other materials`);
    if (n.children?.length) throw new Error(`node ${ni} "${n.name}" has children`);
    drop.add(ni);
  });
  if (textures.length && !drop.size) throw new Error("no node matches");
  // Images to swap: by name, exactly one each, embedded in the binary chunk
  const swap = new Map();
  for (const [name, bytes] of replace) {
    const found = json.images.flatMap((im, i) => (im.name === name ? [i] : []));
    if (found.length !== 1) throw new Error(`--replace ${name}: ${found.length} images have that name`);
    if (json.images[found[0]].bufferView === undefined) throw new Error(`--replace ${name}: not embedded`);
    const mime = json.images[found[0]].mimeType;
    const isWebp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    if ((mime === "image/webp") !== isWebp) throw new Error(`--replace ${name}: the file is not a ${mime}`);
    swap.set(json.images[found[0]].bufferView, bytes);
  }

  const keepNodes = new Set(json.nodes.map((_, i) => i).filter((i) => !drop.has(i)));
  const nodes = compact(json.nodes, keepNodes);
  for (const n of nodes.out) if (n.children) n.children = remapList(n.children, nodes.map);
  for (const s of json.scenes ?? []) s.nodes = remapList(s.nodes, nodes.map);

  const keepMeshes = new Set(nodes.out.filter((n) => n.mesh !== undefined).map((n) => n.mesh));
  const meshes = compact(json.meshes, keepMeshes);
  for (const n of nodes.out) if (n.mesh !== undefined) n.mesh = meshes.map.get(n.mesh);

  const keepAccessors = new Set();
  const keepMaterials = new Set();
  for (const m of meshes.out) {
    for (const p of m.primitives) {
      Object.values(p.attributes).forEach((a) => keepAccessors.add(a));
      if (p.indices !== undefined) keepAccessors.add(p.indices);
      for (const t of p.targets ?? []) Object.values(t).forEach((a) => keepAccessors.add(a));
      if (p.material !== undefined) keepMaterials.add(p.material);
    }
  }
  const accessors = compact(json.accessors, keepAccessors);
  const materials = compact(json.materials, keepMaterials);
  for (const m of meshes.out) {
    for (const p of m.primitives) {
      for (const k of Object.keys(p.attributes)) p.attributes[k] = accessors.map.get(p.attributes[k]);
      if (p.indices !== undefined) p.indices = accessors.map.get(p.indices);
      for (const t of p.targets ?? []) for (const k of Object.keys(t)) t[k] = accessors.map.get(t[k]);
      if (p.material !== undefined) p.material = materials.map.get(p.material);
    }
  }

  const keepTextures = new Set(materials.out.flatMap((m) => textureRefs(m).map((r) => r.index)));
  const textures_ = compact(json.textures ?? [], keepTextures);
  for (const m of materials.out) for (const r of textureRefs(m)) r.index = textures_.map.get(r.index);

  // Every image a kept texture names: its plain source and each extension's (a WebP or Basis image beside a fallback)
  const keepImages = new Set();
  for (const t of textures_.out) {
    if (t.source !== undefined) keepImages.add(t.source);
    for (const ext of ["EXT_texture_webp", "KHR_texture_basisu"]) {
      if (t.extensions?.[ext]?.source !== undefined) keepImages.add(t.extensions[ext].source);
    }
  }
  const images = compact(json.images ?? [], keepImages);
  for (const t of textures_.out) {
    if (t.source !== undefined) t.source = images.map.get(t.source);
    for (const ext of ["EXT_texture_webp", "KHR_texture_basisu"]) {
      if (t.extensions?.[ext]?.source !== undefined) t.extensions[ext].source = images.map.get(t.extensions[ext].source);
    }
  }

  const keepViews = new Set();
  for (const a of accessors.out) {
    if (a.bufferView !== undefined) keepViews.add(a.bufferView);
    if (a.sparse) throw new Error("sparse accessors are not handled");
  }
  for (const im of images.out) if (im.bufferView !== undefined) keepViews.add(im.bufferView);
  const views = compact(json.bufferViews, keepViews);
  const swapAt = new Map([...swap].map(([oldView, bytes]) => [views.map.get(oldView), bytes]));
  for (const a of accessors.out) if (a.bufferView !== undefined) a.bufferView = views.map.get(a.bufferView);
  for (const im of images.out) if (im.bufferView !== undefined) im.bufferView = views.map.get(im.bufferView);

  // Binary: copy each kept view's stored bytes; meshopt views keep their decoded space in the fallback buffer
  const w = new BinWriter();
  const fallback = json.buffers.findIndex(isFallbackBuffer);
  views.out.forEach((bv, vi) => {
    const mo = meshoptOf(bv);
    if (swapAt.has(vi)) {
      if (mo || bv.buffer !== 0) throw new Error("a replaced image's view must be a plain view in the binary chunk");
      bv.byteOffset = w.add(swapAt.get(vi));
      bv.byteLength = swapAt.get(vi).length;
    } else if (mo) {
      if (mo.buffer !== 0 || bv.buffer !== fallback) throw new Error("unexpected meshopt view layout");
      mo.byteOffset = w.add(glb.bin.subarray(mo.byteOffset ?? 0, (mo.byteOffset ?? 0) + mo.byteLength));
      bv.byteOffset = w.reserveFallback(bv.byteLength);
    } else {
      if (bv.buffer !== 0) throw new Error("a plain view outside the binary chunk");
      bv.byteOffset = w.add(glb.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
    }
  });
  const bin = w.bin();
  json.buffers = [{ byteLength: bin.length }];
  if (fallback >= 0) json.buffers.push({ byteLength: w.fallbackLength, extensions: { [MESHOPT]: { fallback: true } } });

  json.nodes = nodes.out;
  json.meshes = meshes.out;
  json.accessors = accessors.out;
  json.materials = materials.out;
  json.textures = textures_.out;
  json.images = images.out;
  json.bufferViews = views.out;

  const removed = {
    nodes: [...drop].map((i) => src.nodes[i].name),
    materials: src.materials.map((m, i) => (keepMaterials.has(i) ? null : m.name)).filter((x) => x !== null),
    images: (src.images ?? []).map((m, i) => (keepImages.has(i) ? null : m.name)).filter((x) => x !== null),
    triangles: [...drop].reduce((s, ni) => {
      for (const p of src.meshes[src.nodes[ni].mesh].primitives) s += src.accessors[p.indices ?? p.attributes.POSITION].count / 3;
      return s;
    }, 0),
  };
  // Old image index -> replacement bytes
  const replaced = new Map((src.images ?? []).flatMap((im, i) => (replace.has(im.name) ? [[i, replace.get(im.name)]] : [])));
  return { json, bin, maps: { nodes: nodes.map, accessors: accessors.map, images: images.map }, removed, replaced };
}

/** Reads the output back: kept accessors decode to the input's bytes, kept images are the input's bytes (or the replacement) */
function check(input, output, maps, replaced) {
  const out = parseGlb(output, "output");
  let n = 0;
  for (const [oldI, newI] of maps.accessors) {
    if (md5(accessorBytes(input, oldI)) !== md5(accessorBytes(out, newI))) throw new Error(`accessor ${oldI} changed`);
    n++;
  }
  const imgBytes = (g, i) => {
    const bv = g.json.bufferViews[g.json.images[i].bufferView];
    return g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  };
  for (const [oldI, newI] of maps.images) {
    const want = replaced.has(oldI) ? replaced.get(oldI) : imgBytes(input, oldI);
    if (md5(want) !== md5(imgBytes(out, newI))) throw new Error(`image ${oldI} is not what it should be`);
  }
  for (const [oldI, newI] of maps.nodes) {
    const a = input.json.nodes[oldI];
    const b = out.json.nodes[newI];
    if (a.name !== b.name || JSON.stringify(a.translation) !== JSON.stringify(b.translation) || JSON.stringify(a.extras) !== JSON.stringify(b.extras)) {
      throw new Error(`node ${oldI} "${a.name}" changed`);
    }
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  await ready;
  const input = readGlb(opts.files[0]);
  const { json, bin, maps, removed, replaced } = stripProps(input, opts.textures, opts.replace);
  const output = writeGlbBytes(json, bin);
  const accessors = check(input, output, maps, replaced);
  removed.replacedImages = [...opts.replace.keys()];
  writeFileSync(opts.files[1], output);
  const report = {
    input: { file: opts.files[0], md5: md5(input.bytes), bytes: input.bytes.length },
    output: { file: opts.files[1], md5: md5(output), bytes: output.length },
    removed,
  };
  if (opts.report) writeFileSync(opts.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    `${opts.files[0]} -> ${opts.files[1]}: ${removed.nodes.length} nodes (${removed.triangles} triangles), ` +
      `${removed.materials.length} materials, ${removed.images.length} images left out; ` +
      `${(input.bytes.length / 1e6).toFixed(2)} -> ${(output.length / 1e6).toFixed(2)} MB; ${accessors} kept accessors decode unchanged`,
  );
  console.log(`  nodes: ${removed.nodes.join(", ")}`);
  console.log(`  images: ${removed.images.join(", ")}`);
  if (removed.replacedImages.length) console.log(`  replaced: ${removed.replacedImages.join(", ")}`);
}
