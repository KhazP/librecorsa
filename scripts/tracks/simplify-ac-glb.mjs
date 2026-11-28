/**
 * Selectively simplifies heavy visual meshes (e.g. repetitive fence/barrier string objects) in a raw AC track GLB
 * before meshopt compression. Never touches physics colliders, hidden nodes, keepShape kerbs, or unmatched materials.
 *
 *   node scripts/tracks/simplify-ac-glb.mjs <raw.glb> '<json rules: [[regex, ratio, errorM, flags?], ...]>'
 *
 * Welds vertices by (pos, normal, uv) so opposite-facing thin barriers/walls never merge into zero-crossing normals
 * (which produce NaN in Three.js normalize(vNormal) and bloom into flashing black blocks). Rejects any simplification
 * that introduces new opposite-normal triangles (dot < -0.95).
 */
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);

const [glbPath, rulesArg] = process.argv.slice(2);
if (!glbPath || !rulesArg) {
  console.error("usage: node scripts/tracks/simplify-ac-glb.mjs <raw.glb> '<json rules>'");
  process.exit(2);
}
const rules = JSON.parse(rulesArg).map(([rx, ratio, errorM, flags]) => ({
  re: new RegExp(rx, "i"),
  ratio: Number(ratio),
  errorM: Number(errorM ?? 0.08),
  flags: Array.isArray(flags) ? flags : flags === true ? ["ErrorAbsolute", "Permissive"] : ["ErrorAbsolute"],
}));

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

const doc = await io.read(glbPath);

const isProtectedNode = (node) => {
  const extras = node.getExtras() ?? {};
  return /^Track_(Collider|Surface)_/.test(node.getName()) || Boolean(extras.collider || extras.hidden || extras.keepShape);
};

const protectedMeshes = new Set();
const walk = (node, prot) => {
  const p = prot || isProtectedNode(node);
  if (p && node.getMesh()) protectedMeshes.add(node.getMesh());
  for (const child of node.listChildren()) walk(child, p);
};
for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) walk(node, false);

/** Per-primitive (pos, normal, uv) weld so hard edges & opposite-facing thin walls never merge normals */
function weldPrimitiveIndices(u32Idx, posArr, nrmAcc, uvAcc) {
  const nv = posArr.length / 3;
  const map = new Map();
  const remap = new Uint32Array(nv);
  const nrm = [0, 0, 0];
  const uv = [0, 0];
  for (let i = 0; i < nv; i++) {
    const px = Math.round(posArr[i * 3] * 1000);
    const py = Math.round(posArr[i * 3 + 1] * 1000);
    const pz = Math.round(posArr[i * 3 + 2] * 1000);
    let key = `${px},${py},${pz}`;
    if (nrmAcc) {
      nrmAcc.getElement(i, nrm);
      key += `|${Math.round(nrm[0] * 100)},${Math.round(nrm[1] * 100)},${Math.round(nrm[2] * 100)}`;
    }
    if (uvAcc) {
      uvAcc.getElement(i, uv);
      key += `|${Math.round(uv[0] * 1e4)},${Math.round(uv[1] * 1e4)}`;
    }
    const existing = map.get(key);
    if (existing !== undefined) {
      remap[i] = existing;
    } else {
      map.set(key, i);
      remap[i] = i;
    }
  }
  const out = new Uint32Array(u32Idx.length);
  for (let i = 0; i < u32Idx.length; i++) out[i] = remap[u32Idx[i]];
  return out;
}

/** Count triangles whose vertex normals oppose each other (interpolates through 0 -> NaN in normalize(vNormal)) */
function countOppositeNormalTris(idxArr, nrmAcc) {
  if (!nrmAcc) return 0;
  const e0 = [0, 0, 0];
  const e1 = [0, 0, 0];
  const e2 = [0, 0, 0];
  let count = 0;
  for (let t = 0; t < idxArr.length; t += 3) {
    nrmAcc.getElement(idxArr[t], e0);
    nrmAcc.getElement(idxArr[t + 1], e1);
    nrmAcc.getElement(idxArr[t + 2], e2);
    const d01 = e0[0] * e1[0] + e0[1] * e1[1] + e0[2] * e1[2];
    const d12 = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2];
    const d20 = e2[0] * e0[0] + e2[1] * e0[1] + e2[2] * e0[2];
    if (d01 < -0.95 || d12 < -0.95 || d20 < -0.95) count++;
  }
  return count;
}

let beforeTris = 0;
let afterTris = 0;
let matchedPrims = 0;
let guardedPrims = 0;

for (const mesh of doc.getRoot().listMeshes()) {
  const prot = protectedMeshes.has(mesh);
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const posAcc = prim.getAttribute("POSITION");
    const idxAcc = prim.getIndices();
    if (!posAcc || !idxAcc) continue;
    const rawIdx = idxAcc.getArray();
    const tris = rawIdx.length / 3;
    beforeTris += tris;
    if (prot || tris < 1200) {
      afterTris += tris;
      continue;
    }
    const matName = prim.getMaterial()?.getName() ?? "";
    const rule = rules.find((r) => r.re.test(matName));
    if (!rule) {
      afterTris += tris;
      continue;
    }

    const posArr = posAcc.getArray();
    const u32Idx = rawIdx instanceof Uint32Array ? rawIdx : Uint32Array.from(rawIdx);
    const targetCount = Math.max(90, Math.floor(tris * rule.ratio) * 3);
    if (targetCount >= u32Idx.length) {
      afterTris += tris;
      continue;
    }

    matchedPrims++;
    const nrmAcc = prim.getAttribute("NORMAL");
    const uvAcc = prim.getAttribute("TEXCOORD_0");
    const origOpp = countOppositeNormalTris(u32Idx, nrmAcc);
    const weldedIdx = weldPrimitiveIndices(u32Idx, posArr, nrmAcc, uvAcc);

    let attrs = null;
    let stride = 0;
    const weights = [];
    if (nrmAcc || uvAcc) {
      const nv = posAcc.getCount();
      stride = (nrmAcc ? 3 : 0) + (uvAcc ? 2 : 0);
      attrs = new Float32Array(nv * stride);
      let off = 0;
      if (nrmAcc) {
        const el = [0, 0, 0];
        for (let i = 0; i < nv; i++) {
          nrmAcc.getElement(i, el);
          attrs[i * stride + off] = el[0];
          attrs[i * stride + off + 1] = el[1];
          attrs[i * stride + off + 2] = el[2];
        }
        weights.push(1.0, 1.0, 1.0);
        off += 3;
      }
      if (uvAcc) {
        const el = [0, 0];
        for (let i = 0; i < nv; i++) {
          uvAcc.getElement(i, el);
          attrs[i * stride + off] = el[0];
          attrs[i * stride + off + 1] = el[1];
        }
        weights.push(0.5, 0.5);
      }
    }

    const runSimplify = (flags) => {
      if (attrs) {
        return MeshoptSimplifier.simplifyWithAttributes(
          weldedIdx, posArr, 3, attrs, stride, weights, null, targetCount, rule.errorM, flags
        )[0];
      }
      return MeshoptSimplifier.simplify(weldedIdx, posArr, 3, targetCount, rule.errorM, flags)[0];
    };

    let newIdx = runSimplify(rule.flags);
    if (nrmAcc && countOppositeNormalTris(newIdx, nrmAcc) > origOpp) {
      // Retry conservatively without Permissive and with LockBorder so thin walls/posts never invert normals
      const safeIdx = runSimplify(["ErrorAbsolute", "LockBorder"]);
      if (countOppositeNormalTris(safeIdx, nrmAcc) <= origOpp) {
        newIdx = safeIdx;
      } else {
        newIdx = u32Idx;
      }
      guardedPrims++;
    }

    if (newIdx.length >= 3 && newIdx.length < u32Idx.length) {
      const [remap, uniqueCount] = MeshoptSimplifier.compactMesh(newIdx);
      for (const sem of prim.listSemantics()) {
        const acc = prim.getAttribute(sem);
        const es = acc.getElementSize();
        const src = acc.getArray();
        const dst = new src.constructor(uniqueCount * es);
        for (let i = 0; i < remap.length; i++) {
          const r = remap[i];
          if (r !== 0xffffffff) {
            for (let k = 0; k < es; k++) dst[r * es + k] = src[i * es + k];
          }
        }
        acc.setArray(dst);
      }
      const outIdx = uniqueCount <= 65535 ? Uint16Array.from(newIdx) : newIdx;
      idxAcc.setArray(outIdx);
      afterTris += newIdx.length / 3;
    } else {
      afterTris += tris;
    }
  }
}

await doc.transform(prune({ keepLeaves: true }));
await io.write(glbPath, doc);
console.log(
  `meshopt simplify (${matchedPrims} prims, ${guardedPrims} normal-guarded): ${Math.round(beforeTris).toLocaleString()} -> ${Math.round(afterTris).toLocaleString()} tris`
);
