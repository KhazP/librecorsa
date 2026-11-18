/**
 * Grafts a small add-on GLB into a circuit's GLB (scripts/graft-track-extras.mjs). The circuit's own JSON objects and
 * binary bytes stay as they are, so its physics and drawn meshes are exactly the ones it had. The add-on's buffer
 * views, accessors, images, samplers, textures, materials, meshes and nodes are appended with their indices moved, its
 * binary chunk goes after the circuit's, its meshopt fallback buffer joins the circuit's, and the children of its
 * Track_Model join the circuit's Track_Model, which must sit at the same place. An add-on image with the same bytes as
 * one of the circuit's is mapped to it (the GPU holds it once). Both files must be meshopt-compressed
 * (scripts/compress-track-glb.mjs).
 *
 * A circuit that already has grafted nodes (a `fromModel` or `drift` extra) is refused: graft onto the file as built.
 */
import { createHash } from "node:crypto";
import { parseGlb, writeGlb } from "./ktx2-textures.mjs";

const MESHOPT = "EXT_meshopt_compression";
const pad4 = (n) => (n + 3) & ~3;

/** The binary chunk's buffer (no uri, not meshopt's fallback) and the fallback buffer, by index */
function buffers(json, label) {
  const bin = json.buffers.findIndex((b) => !b.uri && !b.extensions?.[MESHOPT]?.fallback);
  const fallback = json.buffers.findIndex((b) => b.extensions?.[MESHOPT]?.fallback);
  if (bin < 0 || fallback < 0 || json.buffers.length !== 2) throw new Error(`${label}: expected a binary chunk and a meshopt fallback buffer`);
  return { bin, fallback };
}

/** Texture references in a material (`...Texture: { index }`, at any depth), moved by `shift` */
function shiftTextureRefs(obj, shift) {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (key.endsWith("Texture") && value && typeof value.index === "number") value.index += shift;
    else shiftTextureRefs(value, shift);
  }
}

function graftParsed(base, addon, label) {
  const j = base.json;
  const a = structuredClone(addon.json);
  for (const doc of [j, a]) {
    if (!(doc.extensionsUsed ?? []).includes(MESHOPT)) throw new Error(`${label}: both files must be meshopt-compressed`);
  }
  if (j.nodes.some((n) => n.extras?.fromModel || n.extras?.drift)) {
    throw new Error(`${label}: already has grafted nodes; graft onto the file as built`);
  }
  for (const doc of [j, a]) {
    for (const acc of doc.accessors ?? []) if (acc.sparse) throw new Error(`${label}: sparse accessors are not handled`);
  }
  // Neither is carried over with its indices moved: an add-on animation's nodes and accessors, nor a node extension's
  // own references (EXT_mesh_gpu_instancing's accessors, KHR_lights_punctual's light)
  if ((a.animations ?? []).length) throw new Error(`${label}: add-on animations are not handled`);
  for (const n of a.nodes) {
    const ext = Object.keys(n.extensions ?? {});
    if (ext.length) throw new Error(`${label}: add-on node "${n.name ?? ""}" has extensions (${ext.join(", ")}), which are not handled`);
  }
  const tmBase = j.nodes.findIndex((n) => n.name === "Track_Model");
  const tmAddon = a.nodes.findIndex((n) => n.name === "Track_Model");
  if (tmBase < 0 || tmAddon < 0) throw new Error(`${label}: both files need a Track_Model node`);
  const place = (n) => JSON.stringify([n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1], n.matrix ?? null]);
  if (place(j.nodes[tmBase]) !== place(a.nodes[tmAddon])) {
    throw new Error(`${label}: the add-on's Track_Model is placed differently (${place(a.nodes[tmAddon])} vs ${place(j.nodes[tmBase])})`);
  }

  const bb = buffers(j, "circuit");
  const ab = buffers(a, "add-on");
  const binShift = pad4(base.bin.length);
  const fallbackShift = pad4(j.buffers[bb.fallback].byteLength);
  const shift = {
    view: j.bufferViews.length,
    accessor: (j.accessors ?? []).length,
    image: (j.images ?? []).length,
    texture: (j.textures ?? []).length,
    material: (j.materials ?? []).length,
    mesh: (j.meshes ?? []).length,
  };

  for (const bv of a.bufferViews) {
    if (bv.buffer === ab.bin) {
      bv.buffer = bb.bin;
      bv.byteOffset = (bv.byteOffset ?? 0) + binShift;
    } else if (bv.buffer === ab.fallback) {
      bv.buffer = bb.fallback;
      bv.byteOffset = (bv.byteOffset ?? 0) + fallbackShift;
    } else throw new Error(`${label}: add-on buffer view on an unknown buffer`);
    const ext = bv.extensions?.[MESHOPT];
    if (ext) {
      if (ext.buffer !== ab.bin) throw new Error(`${label}: add-on compressed data outside its binary chunk`);
      ext.buffer = bb.bin;
      ext.byteOffset = (ext.byteOffset ?? 0) + binShift;
    }
  }
  for (const acc of a.accessors ?? []) if (acc.bufferView !== undefined) acc.bufferView += shift.view;

  // Images: one with the same bytes as one of the circuit's (a prop's texture the model already has) is that image,
  // so the GPU holds it once; its bytes stay behind, unused
  const imageBytes = (doc, bin, im) => {
    const v = doc.bufferViews[im.bufferView];
    return v && !v.extensions?.[MESHOPT] ? bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength) : null;
  };
  const baseImages = new Map();
  (j.images ?? []).forEach((im, i) => {
    const bytes = im.bufferView !== undefined ? imageBytes(j, base.bin, im) : null;
    if (bytes) baseImages.set(createHash("sha256").update(bytes).digest("hex"), i);
  });
  const imageMap = [];
  const newImages = [];
  for (const im of addon.json.images ?? []) {
    const bytes = im.bufferView !== undefined ? imageBytes(addon.json, addon.bin, im) : null;
    const same = bytes ? baseImages.get(createHash("sha256").update(bytes).digest("hex")) : undefined;
    if (same !== undefined) imageMap.push(same);
    else {
      imageMap.push(shift.image + newImages.length);
      newImages.push({ ...im, bufferView: im.bufferView !== undefined ? im.bufferView + shift.view : undefined });
    }
  }
  a.images = newImages;

  // Samplers: an equal one of the circuit's is reused
  j.samplers ??= [];
  const samplerMap = (a.samplers ?? []).map((s) => {
    const same = j.samplers.findIndex((t) => JSON.stringify(t) === JSON.stringify(s));
    if (same >= 0) return same;
    j.samplers.push(s);
    return j.samplers.length - 1;
  });
  for (const tex of a.textures ?? []) {
    if (tex.sampler !== undefined) tex.sampler = samplerMap[tex.sampler];
    if (tex.source !== undefined) tex.source = imageMap[tex.source];
    for (const ext of Object.values(tex.extensions ?? {})) if (typeof ext.source === "number") ext.source = imageMap[ext.source];
  }
  for (const mat of a.materials ?? []) shiftTextureRefs(mat, shift.texture);
  for (const mesh of a.meshes ?? []) {
    for (const prim of mesh.primitives) {
      for (const k of Object.keys(prim.attributes)) prim.attributes[k] += shift.accessor;
      if (prim.indices !== undefined) prim.indices += shift.accessor;
      if (prim.material !== undefined) prim.material += shift.material;
      if (prim.targets) throw new Error(`${label}: morph targets are not handled`);
    }
  }

  // Nodes: all but the add-on's Track_Model, whose children join the circuit's
  const keep = a.nodes.map((_, i) => i).filter((i) => i !== tmAddon);
  const nodeMap = new Map(keep.map((i, k) => [i, j.nodes.length + k]));
  const added = keep.map((i) => {
    const n = a.nodes[i];
    if (n.mesh !== undefined) n.mesh += shift.mesh;
    if (n.children) n.children = n.children.map((c) => nodeMap.get(c));
    if (n.skin !== undefined || n.camera !== undefined) throw new Error(`${label}: skins and cameras are not handled`);
    return n;
  });
  const children = (a.nodes[tmAddon].children ?? []).map((c) => nodeMap.get(c));
  const roots = (a.scenes?.[a.scene ?? 0]?.nodes ?? []).filter((i) => i !== tmAddon).map((i) => nodeMap.get(i));

  j.bufferViews.push(...a.bufferViews);
  (j.accessors ??= []).push(...(a.accessors ?? []));
  (j.images ??= []).push(...(a.images ?? []));
  (j.textures ??= []).push(...(a.textures ?? []));
  (j.materials ??= []).push(...(a.materials ?? []));
  (j.meshes ??= []).push(...(a.meshes ?? []));
  j.nodes.push(...added);
  j.nodes[tmBase].children = [...(j.nodes[tmBase].children ?? []), ...children];
  j.scenes[j.scene ?? 0].nodes.push(...roots);
  for (const key of ["extensionsUsed", "extensionsRequired"]) {
    const all = new Set([...(j[key] ?? []), ...(a[key] ?? [])]);
    if (all.size) j[key] = [...all];
  }
  j.buffers[bb.fallback].byteLength = fallbackShift + a.buffers[ab.fallback].byteLength;
  const bin = Buffer.concat([base.bin, Buffer.alloc(binShift - base.bin.length), addon.bin]);
  j.buffers[bb.bin].byteLength = bin.length;
  const shared = (addon.json.images ?? []).length - newImages.length;
  return { json: j, bin, nodes: added.length, meshes: (a.meshes ?? []).length, images: newImages.length, shared };
}

/**
 * The circuit GLB with the add-on grafted in, and what was added. Throws if either file doesn't fit, or if the circuit's
 * own bytes would not come first and unchanged in the result.
 */
export function graftGlb(circuitBytes, addonBytes, label = "GLB") {
  const base = parseGlb(circuitBytes, label);
  const out = graftParsed(base, parseGlb(addonBytes, `${label} add-on`), label);
  const glb = writeGlb(out.json, out.bin);
  if (!parseGlb(glb, label).bin.subarray(0, base.bin.length).equals(base.bin)) throw new Error(`${label}: the circuit's own bytes changed`);
  return { glb, meshes: out.meshes, nodes: out.nodes, images: out.images, shared: out.shared };
}
