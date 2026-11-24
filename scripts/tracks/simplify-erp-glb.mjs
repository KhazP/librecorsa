/**
 * Simplifies the GLB scripts/tracks/extract_erp_track.py writes from an F1 25 track mod, in place: identical vertices
 * welded, then each heavy mesh simplified by meshoptimizer (QEM, with an error in metres), more or less by what it is
 * (its name). The road, the kerbs, the pit lane, the track's own lines and the painted lines on the road (the
 * extractor's LINE_KEYS) are left exact, and so is any mesh under 1200 triangles.
 *
 *   node scripts/tracks/simplify-erp-glb.mjs <track.glb>
 *
 * The extractor runs it unless told --no-simplify. A script of its own rather than code the extractor hands to
 * `node -e`, so the offline launcher's converter carries it bundled with its packages (launcher/converter/build.mjs).
 */
import { NodeIO } from "@gltf-transform/core";
import { weld, prune } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";

await MeshoptSimplifier.ready;
const glbPath = process.argv[2];
if (!glbPath) {
  console.error("usage: node scripts/tracks/simplify-erp-glb.mjs <track.glb>");
  process.exit(2);
}
const io = new NodeIO();
const doc = await io.read(glbPath);

// Weld identical vertices (position + normal + UV + color match in gltf-transform weld, preserving seams).
await doc.transform(weld());

let beforeTris = 0;
let afterTris = 0;
for (const mesh of doc.getRoot().listMeshes()) {
  const name = mesh.getName() || "";
  let mTris = 0;
  for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue;
    const idx = p.getIndices();
    mTris += idx ? idx.getCount() / 3 : (p.getAttribute("POSITION")?.getCount() ?? 0) / 3;
  }
  beforeTris += mTris;

  // The road's painted lines (LINE_KEYS) lie a few mm over the asphalt: any simplification lifts or drops them
  const isExact = name.startsWith("Road") || name.startsWith("Kerb") || name.startsWith("PitLane") || name.startsWith("Track_") ||
    /v12s_line_white|_line_1(_|$)/.test(name);
  if (isExact || mTris < 1200) {
    afterTris += mTris;
    continue;
  }

  // ErrorAbsolute uses real world-space metres instead of bounding-box fraction (merged meshes span ~2 km).
  let ratio = 0.40;
  let errorM = 0.30;
  let flags = ["ErrorAbsolute"];
  if (/flat_neon|neon_|_led|ledwall|ledmesh|tun_(cyan|violet)|ceiling_light|flood|bulb|lantern/.test(name)) {
    // Light strips are thin tubes and ribbons: a coarse error folds them flat or tears them
    ratio = 0.5;
    errorM = 0.05;
  } else if (name.startsWith("Scenery")) {
    if (name.includes("flat_opaque")) {
      // Every flat-coloured building, stand and structure in one mesh: at 1.6 m the walls of the smaller buildings
      // folded away and left their windows hanging in the air
      ratio = 0.3;
      errorM = 0.12;
    } else if (name.includes("palm")) {
      ratio = 0.16;
      errorM = 0.70;
    } else if (mTris > 40000) {
      ratio = 0.14;
      errorM = 1.15;
    } else if (mTris > 10000) {
      ratio = 0.20;
      errorM = 0.65;
    } else {
      ratio = 0.34;
      errorM = 0.30;
    }
  } else if (name.startsWith("Grass") || name.startsWith("Gravel")) {
    ratio = 0.25;
    // Ground beside the road: its edges meet the kerbs and run-off, which a coarse error turned into jagged teeth
    errorM = 0.05;
    flags = ["ErrorAbsolute", "LockBorder"];
  } else if (name.startsWith("Runoff") || name.startsWith("Wall")) {
    ratio = 0.28;
    errorM = 0.05;
    flags = ["ErrorAbsolute", "LockBorder"];
  }

  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const posAcc = prim.getAttribute("POSITION");
    const idxAcc = prim.getIndices();
    if (!posAcc || !idxAcc) continue;
    const posArr = posAcc.getArray();
    const rawIdx = idxAcc.getArray();
    const u32Idx = rawIdx instanceof Uint32Array ? rawIdx : Uint32Array.from(rawIdx);
    const targetCount = Math.max(90, Math.floor((u32Idx.length / 3) * ratio) * 3);
    if (targetCount >= u32Idx.length) continue;

    // Use simplifyWithAttributes when TEXCOORD_0 or NORMAL exists so UV seams & hard shading are preserved!
    const nrmAcc = prim.getAttribute("NORMAL");
    const uvAcc = prim.getAttribute("TEXCOORD_0");
    let newIdx;
    if (nrmAcc || uvAcc) {
      const nv = posAcc.getCount();
      const stride = (nrmAcc ? 3 : 0) + (uvAcc ? 2 : 0);
      const attrs = new Float32Array(nv * stride);
      const weights = [];
      let off = 0;
      if (nrmAcc) {
        const na = nrmAcc.getArray();
        for (let i = 0; i < nv; i++) {
          attrs[i * stride + off] = na[i * 3];
          attrs[i * stride + off + 1] = na[i * 3 + 1];
          attrs[i * stride + off + 2] = na[i * 3 + 2];
        }
        weights.push(0.5, 0.5, 0.5);
        off += 3;
      }
      if (uvAcc) {
        const ua = uvAcc.getArray();
        for (let i = 0; i < nv; i++) {
          attrs[i * stride + off] = ua[i * 2];
          attrs[i * stride + off + 1] = ua[i * 2 + 1];
        }
        weights.push(0.5, 0.5);
      }
      [newIdx] = MeshoptSimplifier.simplifyWithAttributes(
        u32Idx, posArr, 3, attrs, stride, weights, null, targetCount, errorM, flags
      );
    } else {
      [newIdx] = MeshoptSimplifier.simplify(u32Idx, posArr, 3, targetCount, errorM, flags);
    }

    if (newIdx.length >= 3 && newIdx.length < u32Idx.length) {
      // Compact vertices referenced by newIdx so unreferenced verts don't bloat the GLB!
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
    }
  }

  let mAfter = 0;
  for (const p of mesh.listPrimitives()) {
    if (p.getMode() !== 4) continue;
    const idx = p.getIndices();
    mAfter += idx ? idx.getCount() / 3 : 0;
  }
  afterTris += mAfter;
}

await doc.transform(prune({ keepLeaves: true }));
await io.write(glbPath, doc);
console.log(`  meshopt simplify: ${Math.round(beforeTris).toLocaleString()} -> ${Math.round(afterTris).toLocaleString()} tris`);
