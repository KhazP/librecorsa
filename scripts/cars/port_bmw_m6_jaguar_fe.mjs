import fs from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function mulMat4(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function invert3x3(m) {
  const a00 = m[0], a01 = m[4], a02 = m[8];
  const a10 = m[1], a11 = m[5], a12 = m[9];
  const a20 = m[2], a21 = m[6], a22 = m[10];
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  let det = a00 * b01 + a01 * b11 + a02 * b21;
  if (!det) return [1,0,0, 0,1,0, 0,0,1];
  det = 1 / det;
  return [
    b01 * det, (-a22 * a01 + a02 * a21) * det, (a12 * a01 - a02 * a11) * det,
    b11 * det, (a22 * a00 - a02 * a20) * det, (-a12 * a00 + a02 * a10) * det,
    b21 * det, (-a21 * a00 + a01 * a20) * det, (a11 * a00 - a01 * a10) * det,
  ];
}

function xformPos(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function xformNormal(nMat3, n) {
  const nx = nMat3[0] * n[0] + nMat3[1] * n[1] + nMat3[2] * n[2];
  const ny = nMat3[3] * n[0] + nMat3[4] * n[1] + nMat3[5] * n[2];
  const nz = nMat3[6] * n[0] + nMat3[7] * n[1] + nMat3[8] * n[2];
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function cloneMaterialTo(dstDoc, srcMat, texMap) {
  const m = dstDoc.createMaterial(srcMat.getName());
  m.setBaseColorFactor(srcMat.getBaseColorFactor());
  m.setMetallicFactor(srcMat.getMetallicFactor());
  m.setRoughnessFactor(srcMat.getRoughnessFactor());
  m.setEmissiveFactor(srcMat.getEmissiveFactor());
  m.setAlphaMode(srcMat.getAlphaMode());
  m.setAlphaCutoff(srcMat.getAlphaCutoff());
  m.setDoubleSided(srcMat.getDoubleSided());

  const mapTex = (srcTex) => {
    if (!srcTex) return null;
    if (texMap.has(srcTex)) return texMap.get(srcTex);
    const t = dstDoc.createTexture(srcTex.getName());
    t.setImage(srcTex.getImage());
    t.setMimeType(srcTex.getMimeType());
    texMap.set(srcTex, t);
    return t;
  };
  if (srcMat.getBaseColorTexture()) m.setBaseColorTexture(mapTex(srcMat.getBaseColorTexture()));
  if (srcMat.getMetallicRoughnessTexture()) m.setMetallicRoughnessTexture(mapTex(srcMat.getMetallicRoughnessTexture()));
  if (srcMat.getNormalTexture()) {
    m.setNormalTexture(mapTex(srcMat.getNormalTexture()));
    m.setNormalScale(srcMat.getNormalScale());
  }
  if (srcMat.getOcclusionTexture()) m.setOcclusionTexture(mapTex(srcMat.getOcclusionTexture()));
  if (srcMat.getEmissiveTexture()) m.setEmissiveTexture(mapTex(srcMat.getEmissiveTexture()));
  return m;
}

function buildPrim(dstDoc, buf, positions, normals, uvs, indices, mat) {
  const prim = dstDoc.createPrimitive().setMaterial(mat);
  prim.setAttribute("POSITION", dstDoc.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buf));
  if (normals && normals.length === positions.length) {
    prim.setAttribute("NORMAL", dstDoc.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buf));
  }
  if (uvs && uvs.length) {
    prim.setAttribute("TEXCOORD_0", dstDoc.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)).setBuffer(buf));
  }
  prim.setIndices(dstDoc.createAccessor().setType("SCALAR").setArray(new Uint32Array(indices)).setBuffer(buf));
  return prim;
}

function extractPrimData(srcPrim, worldMat, pivot = [0, 0, 0], extraRotMat3 = null) {
  const posAcc = srcPrim.getAttribute("POSITION");
  const nrmAcc = srcPrim.getAttribute("NORMAL");
  const uvAcc = srcPrim.getAttribute("TEXCOORD_0");
  const idxAcc = srcPrim.getIndices();
  const count = posAcc.getCount();
  const nMat = invert3x3(worldMat);

  const pos = [];
  const nrm = nrmAcc ? [] : null;
  const uvs = uvAcc ? [] : null;
  const p = [0, 0, 0];
  const n = [0, 0, 0];
  const uv = [0, 0];

  for (let i = 0; i < count; i++) {
    posAcc.getElement(i, p);
    let wp = xformPos(worldMat, p);
    wp = [wp[0] - pivot[0], wp[1] - pivot[1], wp[2] - pivot[2]];
    if (extraRotMat3) {
      wp = [
        extraRotMat3[0] * wp[0] + extraRotMat3[3] * wp[1] + extraRotMat3[6] * wp[2],
        extraRotMat3[1] * wp[0] + extraRotMat3[4] * wp[1] + extraRotMat3[7] * wp[2],
        extraRotMat3[2] * wp[0] + extraRotMat3[5] * wp[1] + extraRotMat3[8] * wp[2],
      ];
    }
    pos.push(wp[0], wp[1], wp[2]);
    if (nrmAcc) {
      nrmAcc.getElement(i, n);
      let wn = xformNormal(nMat, n);
      if (extraRotMat3) {
        wn = [
          extraRotMat3[0] * wn[0] + extraRotMat3[3] * wn[1] + extraRotMat3[6] * wn[2],
          extraRotMat3[1] * wn[0] + extraRotMat3[4] * wn[1] + extraRotMat3[7] * wn[2],
          extraRotMat3[2] * wn[0] + extraRotMat3[5] * wn[1] + extraRotMat3[8] * wn[2],
        ];
      }
      nrm.push(wn[0], wn[1], wn[2]);
    }
    if (uvAcc) {
      uvAcc.getElement(i, uv);
      uvs.push(uv[0], uv[1]);
    }
  }
  const indices = [];
  if (idxAcc) {
    for (let i = 0; i < idxAcc.getCount(); i++) indices.push(idxAcc.getScalar(i));
  } else {
    for (let i = 0; i < count; i++) indices.push(i);
  }
  return { pos, nrm, uvs, indices };
}

function splitByQuadrant(pos, nrm, uvs, indices, classifyFn) {
  const buckets = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3;
    const cy = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3;
    const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3;
    const key = classifyFn(cx, cy, cz);
    if (!buckets.has(key)) buckets.set(key, { remap: new Map(), pos: [], nrm: nrm ? [] : null, uvs: uvs ? [] : null, indices: [] });
    const b = buckets.get(key);
    for (const vi of [i0, i1, i2]) {
      let ni = b.remap.get(vi);
      if (ni === undefined) {
        ni = b.pos.length / 3;
        b.remap.set(vi, ni);
        b.pos.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        if (nrm) b.nrm.push(nrm[vi * 3], nrm[vi * 3 + 1], nrm[vi * 3 + 2]);
        if (uvs) b.uvs.push(uvs[vi * 2], uvs[vi * 2 + 1]);
      }
      b.indices.push(ni);
    }
  }
  return buckets;
}

async function portBmwM6() {
  const srcDoc = await io.read("carsupd/bmw_m6_gt3.glb");
  const dstDoc = new Document();
  const buf = dstDoc.createBuffer();
  const texMap = new Map();
  const matMap = new Map();
  const BRIGHT_INTERIOR_MATS = new Set(["interior", "detailplastic", "blackplastic", "blackmatte"]);
  const CLEAR_WINDOW_MATS = new Set(["window", "windowrear"]);
  for (const sm of srcDoc.getRoot().listMaterials()) {
    const dm = cloneMaterialTo(dstDoc, sm, texMap);
    const name = sm.getName();
    if (CLEAR_WINDOW_MATS.has(name)) {
      dm.setBaseColorTexture(null);
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([0.05, 0.07, 0.10, 0.22]);
      dm.setAlphaMode("BLEND");
      dm.setMetallicFactor(0.0);
      dm.setRoughnessFactor(0.08);
      dm.setDoubleSided(true);
    } else if (name === "BMW_M6_GT3_by_Alex_Ka") {
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([1.0, 1.0, 1.0, 1.0]);
      dm.setMetallicFactor(0.18);
      dm.setRoughnessFactor(0.32);
    } else if (BRIGHT_INTERIOR_MATS.has(name)) {
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([0.55, 0.55, 0.58, 1.0]);
      dm.setMetallicFactor(0.0);
      dm.setRoughnessFactor(0.75);
    } else if (name === "rim1" || name === "rim2" || name === "chrome") {
      dm.setMetallicRoughnessTexture(null);
      dm.setMetallicFactor(0.55);
      dm.setRoughnessFactor(0.28);
    }
    matMap.set(sm, dm);
  }

  // node.getWorldMatrix() already puts Sketchfab_model in +X left, +Y up, +Z forward; shift +0.007 in Y so ground = 0
  const M_RAW_TO_LC = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0.007, 0, 1,
  ];
  const SKIP_MATS = new Set(["floor", "smoke", "carshadow"]);
  const TYRE_MATS = new Set(["tire", "tire_side"]);
  const RIM_MATS = new Set(["rim1", "rim2", "rimbolts", "brakedisk"]);

  // Measure exact wheel centres & radii from the 'tire' mesh in world space
  const wheelBounds = {
    WHEEL_RF: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    WHEEL_LF: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    WHEEL_RR: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
    WHEEL_LR: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
  };
  for (const node of srcDoc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const worldMat = mulMat4(M_RAW_TO_LC, node.getWorldMatrix());
    for (const srcPrim of mesh.listPrimitives()) {
      if (srcPrim.getMaterial()?.getName() !== "tire") continue;
      const { pos } = extractPrimData(srcPrim, worldMat);
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        const q = z > 0 ? (x < 0 ? "WHEEL_RF" : "WHEEL_LF") : (x < 0 ? "WHEEL_RR" : "WHEEL_LR");
        const b = wheelBounds[q];
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (z < b[2]) b[2] = z;
        if (x > b[3]) b[3] = x; if (y > b[4]) b[4] = y; if (z > b[5]) b[5] = z;
      }
    }
  }
  const wheelCentres = Object.fromEntries(
    Object.entries(wheelBounds).map(([k, b]) => [k, [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]])
  );
  const fRad = (wheelBounds.WHEEL_LF[4] - wheelBounds.WHEEL_LF[1]) / 2;
  const rRad = (wheelBounds.WHEEL_LR[4] - wheelBounds.WHEEL_LR[1]) / 2;
  // Un-steer front wheels (authored ~22 deg turned in Sketchfab pose) around Y at each front wheel centre
  const unsteerAngleFor = (corner) => {
    const [cx, , cz] = wheelCentres[corner];
    const pts = [];
    for (const node of srcDoc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const worldMat = mulMat4(M_RAW_TO_LC, node.getWorldMatrix());
      for (const srcPrim of mesh.listPrimitives()) {
        if (srcPrim.getMaterial()?.getName() !== "tire") continue;
        const { pos } = extractPrimData(srcPrim, worldMat);
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], z = pos[i + 2];
          if (z > 0 && ((corner === "WHEEL_LF" && x > 0) || (corner === "WHEEL_RF" && x < 0))) {
            pts.push([x - cx, z - cz]);
          }
        }
      }
    }
    let bestRad = 0, bestW = Infinity;
    for (let deg = -35; deg <= 35; deg += 0.5) {
      const rad = (deg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
      let minX = Infinity, maxX = -Infinity;
      for (const [dx, dz] of pts) {
        const rx = dx * c - dz * s;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
      }
      if (maxX - minX < bestW) { bestW = maxX - minX; bestRad = rad; }
    }
    return { rad: bestRad, halfW: bestW / 2 };
  };
  const lfUnsteer = unsteerAngleFor("WHEEL_LF");
  const rfUnsteer = unsteerAngleFor("WHEEL_RF");
  const frontUnsteerRad = { WHEEL_LF: lfUnsteer.rad, WHEEL_RF: rfUnsteer.rad };
  const fHalfW = (lfUnsteer.halfW + rfUnsteer.halfW) / 2;
  const rHalfW = (wheelBounds.WHEEL_LR[3] - wheelBounds.WHEEL_LR[0]) / 2;

  const steerPivot = [0.240, 0.723, 0.040];
  const tilt = (12 * Math.PI) / 180;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const M_BODY_TO_STEER_3 = [
    1, 0, 0,
    0, c, s,
    0, -s, c,
  ];
  const M_STEER = [
    1, 0, 0, 0,
    0, c, -s, 0,
    0, s, c, 0,
    steerPivot[0], steerPivot[1], steerPivot[2], 1,
  ];

  const bodyNode = dstDoc.createNode("BODY");
  const steerNode = dstDoc.createNode("STEER").setMatrix(M_STEER);
  const wheelGroups = {
    WHEEL_RF: { root: dstDoc.createNode("WHEEL_RF").setTranslation(wheelCentres.WHEEL_RF), rim: [], tyre: [] },
    WHEEL_LF: { root: dstDoc.createNode("WHEEL_LF").setTranslation(wheelCentres.WHEEL_LF), rim: [], tyre: [] },
    WHEEL_RR: { root: dstDoc.createNode("WHEEL_RR").setTranslation(wheelCentres.WHEEL_RR), rim: [], tyre: [] },
    WHEEL_LR: { root: dstDoc.createNode("WHEEL_LR").setTranslation(wheelCentres.WHEEL_LR), rim: [], tyre: [] },
  };

  for (const node of srcDoc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const worldMat = mulMat4(M_RAW_TO_LC, node.getWorldMatrix());
    for (const srcPrim of mesh.listPrimitives()) {
      const mat = srcPrim.getMaterial();
      const matName = mat?.getName() ?? "";
      if (SKIP_MATS.has(matName)) continue;
      const dstMat = matMap.get(mat);
      const { pos, nrm, uvs, indices } = extractPrimData(srcPrim, worldMat);

      if (TYRE_MATS.has(matName) || RIM_MATS.has(matName)) {
        const isTyre = TYRE_MATS.has(matName);
        const buckets = splitByQuadrant(pos, nrm, uvs, indices, (x, _y, z) =>
          z > 0 ? (x < 0 ? "WHEEL_RF" : "WHEEL_LF") : (x < 0 ? "WHEEL_RR" : "WHEEL_LR")
        );
        for (const [corner, b] of buckets) {
          const [cx, cy, cz] = wheelCentres[corner];
          const unRad = frontUnsteerRad[corner] ?? 0;
          const uc = Math.cos(unRad), us = Math.sin(unRad);
          for (let i = 0; i < b.pos.length; i += 3) {
            const dx = b.pos[i] - cx;
            const dz = b.pos[i + 2] - cz;
            b.pos[i] = unRad ? dx * uc - dz * us : dx;
            b.pos[i + 1] -= cy;
            b.pos[i + 2] = unRad ? dx * us + dz * uc : dz;
            if (unRad && b.nrm) {
              const nx = b.nrm[i], nz = b.nrm[i + 2];
              b.nrm[i] = nx * uc - nz * us;
              b.nrm[i + 2] = nx * us + nz * uc;
            }
          }
          const prim = buildPrim(dstDoc, buf, b.pos, b.nrm, b.uvs, b.indices, dstMat);
          if (isTyre) wheelGroups[corner].tyre.push(prim);
          else wheelGroups[corner].rim.push(prim);
        }
      } else if (matName === "interior") {
        // Split out steering wheel + paddles in LC world space (0.922 scaled)
        const buckets = splitByQuadrant(pos, nrm, uvs, indices, (x, y, z) =>
          x >= 0.095 && x <= 0.385 && y >= 0.630 && y <= 0.815 && z >= 0.005 && z <= 0.075 ? "STEER" : "BODY"
        );
        if (buckets.has("BODY")) {
          const b = buckets.get("BODY");
          const prim = buildPrim(dstDoc, buf, b.pos, b.nrm, b.uvs, b.indices, dstMat);
          const m = dstDoc.createMesh("interior_body").addPrimitive(prim);
          bodyNode.addChild(dstDoc.createNode("interior_body").setMesh(m));
        }
        if (buckets.has("STEER")) {
          const b = buckets.get("STEER");
          for (let i = 0; i < b.pos.length; i += 3) {
            const dx = b.pos[i] - steerPivot[0];
            const dy = b.pos[i + 1] - steerPivot[1];
            const dz = b.pos[i + 2] - steerPivot[2];
            b.pos[i] = M_BODY_TO_STEER_3[0] * dx + M_BODY_TO_STEER_3[3] * dy + M_BODY_TO_STEER_3[6] * dz;
            b.pos[i + 1] = M_BODY_TO_STEER_3[1] * dx + M_BODY_TO_STEER_3[4] * dy + M_BODY_TO_STEER_3[7] * dz;
            b.pos[i + 2] = M_BODY_TO_STEER_3[2] * dx + M_BODY_TO_STEER_3[5] * dy + M_BODY_TO_STEER_3[8] * dz;
            if (b.nrm) {
              const nx = b.nrm[i], ny = b.nrm[i + 1], nz = b.nrm[i + 2];
              b.nrm[i] = M_BODY_TO_STEER_3[0] * nx + M_BODY_TO_STEER_3[3] * ny + M_BODY_TO_STEER_3[6] * nz;
              b.nrm[i + 1] = M_BODY_TO_STEER_3[1] * nx + M_BODY_TO_STEER_3[4] * ny + M_BODY_TO_STEER_3[7] * nz;
              b.nrm[i + 2] = M_BODY_TO_STEER_3[2] * nx + M_BODY_TO_STEER_3[5] * ny + M_BODY_TO_STEER_3[8] * nz;
            }
          }
          const prim = buildPrim(dstDoc, buf, b.pos, b.nrm, b.uvs, b.indices, dstMat);
          const m = dstDoc.createMesh("interior_steer").addPrimitive(prim);
          steerNode.addChild(dstDoc.createNode("interior_steer").setMesh(m));
        }
      } else {
        const prim = buildPrim(dstDoc, buf, pos, nrm, uvs, indices, dstMat);
        const m = dstDoc.createMesh(node.getName() || matName).addPrimitive(prim);
        bodyNode.addChild(dstDoc.createNode(node.getName() || matName).setMesh(m));
      }
    }
  }

  // Add a live BMW M6 GT3 digital dashboard screen behind the steering wheel
  const dashMat = dstDoc
    .createMaterial("BMW_DASH_SCREEN")
    .setBaseColorFactor([1, 1, 1, 1])
    .setEmissiveFactor([1, 1, 1])
    .setRoughnessFactor(0.15)
    .setMetallicFactor(0);
  const dw = 0.085, dh = 0.042;
  const dTilt = (-15 * Math.PI) / 180;
  const dc = Math.cos(dTilt), ds = Math.sin(dTilt);
  const dx0 = 0.240, dy0 = 0.755, dz0 = 0.185;
  const dPos = [
    dx0 + dw, dy0 - dh * dc, dz0 - dh * ds,
    dx0 - dw, dy0 - dh * dc, dz0 - dh * ds,
    dx0 - dw, dy0 + dh * dc, dz0 + dh * ds,
    dx0 + dw, dy0 + dh * dc, dz0 + dh * ds,
  ];
  const dNrm = [0, ds, -dc, 0, ds, -dc, 0, ds, -dc, 0, ds, -dc];
  const dUvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const dIdx = [0, 1, 2, 0, 2, 3];
  const dashPrim = buildPrim(dstDoc, buf, dPos, dNrm, dUvs, dIdx, dashMat);
  bodyNode.addChild(dstDoc.createNode("BMW_DASH_SCREEN").setMesh(dstDoc.createMesh("BMW_DASH_SCREEN").addPrimitive(dashPrim)));

  const wheelNodes = [];
  for (const [corner, wg] of Object.entries(wheelGroups)) {
    if (wg.rim.length) {
      const m = dstDoc.createMesh(`${corner}_RIM`);
      wg.rim.forEach((p) => m.addPrimitive(p));
      wg.root.addChild(dstDoc.createNode(`${corner}_RIM`).setMesh(m));
    }
    if (wg.tyre.length) {
      const m = dstDoc.createMesh(`${corner}_TYRE`);
      wg.tyre.forEach((p) => m.addPrimitive(p));
      wg.root.addChild(dstDoc.createNode(`${corner}_TYRE`).setMesh(m));
    }
    wheelNodes.push(wg.root);
  }

  const cameras = {
    cockpit: { pos: [0.240, 0.89, -0.32], pitchDeg: -4.17, fov: 60 },
    tcam: { pos: [0.0, 1.38, -0.15], pitchDeg: -7, fov: 58 },
    dash: { pos: [0.240, 0.81, 0.13], pitchDeg: -3, fov: 58 },
    bumper: { pos: [0.0, 0.52, 2.00], pitchDeg: -3, fov: 60 },
    nearChase: { pos: [0.0, 1.75, -5.0], pitchDeg: -10, fov: 60 },
    farChase: { pos: [0.0, 2.25, -7.0], pitchDeg: -10, fov: 60 },
  };
  const extras = {
    wheelCentres,
    tyreRadius: { LF: fRad, RF: fRad, LR: rRad, RR: rRad },
    tyreHalfWidth: { LF: fHalfW, RF: fHalfW, LR: rHalfW, RR: rHalfW },
    wheelbaseM: wheelCentres.WHEEL_LF[2] - wheelCentres.WHEEL_LR[2],
    trackWidthM: {
      front: wheelCentres.WHEEL_LF[0] - wheelCentres.WHEEL_RF[0],
      rear: wheelCentres.WHEEL_LR[0] - wheelCentres.WHEEL_RR[0],
    },
    steer: { pivot: steerPivot, columnAxis: [0, s, -c] },
    cameras,
    source: { converted: "scripts/cars/port_bmw_m6_jaguar_fe.mjs", author: "Alex.Ka" },
  };

  const carRoot = dstDoc.createNode("CAR").setExtras(extras);
  carRoot.addChild(bodyNode);
  carRoot.addChild(steerNode);
  for (const wn of wheelNodes) carRoot.addChild(wn);
  dstDoc.createScene("Scene").addChild(carRoot);

  fs.mkdirSync("public/cars/bmw-m6-gt3/model", { recursive: true });
  await io.write("public/cars/bmw-m6-gt3/model/bmw-m6-gt3.glb", dstDoc);
  console.log("Wrote public/cars/bmw-m6-gt3/model/bmw-m6-gt3.glb");
}

async function portJaguarFe() {
  const srcDoc = await io.read("carsupd/formula_e__jaguar_i_type-4.glb");
  const dstDoc = new Document();
  const buf = dstDoc.createBuffer();
  const texMap = new Map();
  const matMap = new Map();
  const BRIGHT_INTERIOR_MATS = new Set(["interior", "detailplastic", "blackplastic", "blackmatte"]);
  const CLEAR_WINDOW_MATS = new Set(["window", "windowrear"]);
  for (const sm of srcDoc.getRoot().listMaterials()) {
    const dm = cloneMaterialTo(dstDoc, sm, texMap);
    const name = sm.getName();
    if (CLEAR_WINDOW_MATS.has(name)) {
      dm.setBaseColorTexture(null);
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([0.05, 0.07, 0.10, 0.22]);
      dm.setAlphaMode("BLEND");
      dm.setMetallicFactor(0.0);
      dm.setRoughnessFactor(0.08);
      dm.setDoubleSided(true);
    } else if (name === "BMW_M6_GT3_by_Alex_Ka") {
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([1.0, 1.0, 1.0, 1.0]);
      dm.setMetallicFactor(0.18);
      dm.setRoughnessFactor(0.32);
    } else if (BRIGHT_INTERIOR_MATS.has(name)) {
      dm.setMetallicRoughnessTexture(null);
      dm.setBaseColorFactor([0.55, 0.55, 0.58, 1.0]);
      dm.setMetallicFactor(0.0);
      dm.setRoughnessFactor(0.75);
    } else if (name === "rim1" || name === "rim2" || name === "chrome") {
      dm.setMetallicRoughnessTexture(null);
      dm.setMetallicFactor(0.55);
      dm.setRoughnessFactor(0.28);
    }
    matMap.set(sm, dm);
  }

  const M_SHIFT = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0.9220, 0.5020, 0, 1,
  ];

  const wheelCentres = {
    WHEEL_LF: [0.6595, 0.3305, 1.2925],
    WHEEL_RF: [-0.6595, 0.3305, 1.2925],
    WHEEL_LR: [0.7940, 0.3305, -1.9580],
    WHEEL_RR: [-0.7365, 0.3305, -1.9580],
  };

  const steerNodeNames = new Set(["Object_53", "Object_54", "Object_55", "Object_56", "Object_57"]);
  const steerPivot = [0.0, 0.607, 0.237];
  const tilt = (15 * Math.PI) / 180;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const M_BODY_TO_STEER_3 = [
    1, 0, 0,
    0, c, s,
    0, -s, c,
  ];
  const M_STEER = [
    1, 0, 0, 0,
    0, c, -s, 0,
    0, s, c, 0,
    steerPivot[0], steerPivot[1], steerPivot[2], 1,
  ];

  const wheelNodeMap = new Map([
    ["Object_41", ["WHEEL_LF", true]],
    ["Object_42", ["WHEEL_LF", false]],
    ["Object_43", ["WHEEL_LF", false]],
    ["Object_83", ["WHEEL_RF", true]],
    ["Object_84", ["WHEEL_RF", false]],
    ["Object_85", ["WHEEL_RF", false]],
    ["Object_87", ["WHEEL_RR", true]],
    ["Object_88", ["WHEEL_RR", false]],
    ["Object_89", ["WHEEL_RR", false]],
    ["Object_91", ["WHEEL_LR", true]],
    ["Object_92", ["WHEEL_LR", false]],
    ["Object_93", ["WHEEL_LR", false]],
  ]);

  const bodyNode = dstDoc.createNode("BODY");
  const steerNode = dstDoc.createNode("STEER").setMatrix(M_STEER);
  const wheelGroups = {
    WHEEL_RF: { root: dstDoc.createNode("WHEEL_RF").setTranslation(wheelCentres.WHEEL_RF), rim: [], tyre: [] },
    WHEEL_LF: { root: dstDoc.createNode("WHEEL_LF").setTranslation(wheelCentres.WHEEL_LF), rim: [], tyre: [] },
    WHEEL_RR: { root: dstDoc.createNode("WHEEL_RR").setTranslation(wheelCentres.WHEEL_RR), rim: [], tyre: [] },
    WHEEL_LR: { root: dstDoc.createNode("WHEEL_LR").setTranslation(wheelCentres.WHEEL_LR), rim: [], tyre: [] },
  };

  for (const node of srcDoc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const nodeName = node.getName() || "";
    const worldMat = mulMat4(M_SHIFT, node.getWorldMatrix());

    for (const srcPrim of mesh.listPrimitives()) {
      const mat = srcPrim.getMaterial();
      const dstMat = matMap.get(mat);
      const wInfo = wheelNodeMap.get(nodeName);
      if (wInfo) {
        const [corner, isTyre] = wInfo;
        const { pos, nrm, uvs, indices } = extractPrimData(srcPrim, worldMat, wheelCentres[corner]);
        const prim = buildPrim(dstDoc, buf, pos, nrm, uvs, indices, dstMat);
        if (isTyre) wheelGroups[corner].tyre.push(prim);
        else wheelGroups[corner].rim.push(prim);
      } else if (steerNodeNames.has(nodeName)) {
        const { pos, nrm, uvs, indices } = extractPrimData(srcPrim, worldMat, steerPivot, M_BODY_TO_STEER_3);
        let outUvs = uvs;
        if (nodeName === "Object_55") {
          // Generate clean [0..1] planar UVs on the steering wheel OLED screen
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (let i = 0; i < pos.length; i += 3) {
            if (pos[i] < minX) minX = pos[i];
            if (pos[i] > maxX) maxX = pos[i];
            if (pos[i + 1] < minY) minY = pos[i + 1];
            if (pos[i + 1] > maxY) maxY = pos[i + 1];
          }
          const dx = Math.max(1e-4, maxX - minX);
          const dy = Math.max(1e-4, maxY - minY);
          outUvs = [];
          for (let i = 0; i < pos.length; i += 3) {
            // +X is driver's left when looking forward (+Z), so u = 1 - normalized X to avoid mirroring
            outUvs.push(1 - (pos[i] - minX) / dx, (pos[i + 1] - minY) / dy);
          }
        }
        const prim = buildPrim(dstDoc, buf, pos, nrm, outUvs, indices, dstMat);
        const m = dstDoc.createMesh(nodeName).addPrimitive(prim);
        steerNode.addChild(dstDoc.createNode(nodeName).setMesh(m));
      } else {
        const { pos, nrm, uvs, indices } = extractPrimData(srcPrim, worldMat);
        const prim = buildPrim(dstDoc, buf, pos, nrm, uvs, indices, dstMat);
        const m = dstDoc.createMesh(nodeName || mat?.getName() || "mesh").addPrimitive(prim);
        bodyNode.addChild(dstDoc.createNode(nodeName || mat?.getName() || "mesh").setMesh(m));
      }
    }
  }

  // Add a live BMW M6 GT3 digital dashboard screen behind the steering wheel
  const dashMat = dstDoc
    .createMaterial("BMW_DASH_SCREEN")
    .setBaseColorFactor([1, 1, 1, 1])
    .setEmissiveFactor([1, 1, 1])
    .setRoughnessFactor(0.15)
    .setMetallicFactor(0);
  const dw = 0.085, dh = 0.042;
  const dTilt = (-15 * Math.PI) / 180;
  const dc = Math.cos(dTilt), ds = Math.sin(dTilt);
  const dx0 = 0.240, dy0 = 0.755, dz0 = 0.185;
  const dPos = [
    dx0 + dw, dy0 - dh * dc, dz0 - dh * ds,
    dx0 - dw, dy0 - dh * dc, dz0 - dh * ds,
    dx0 - dw, dy0 + dh * dc, dz0 + dh * ds,
    dx0 + dw, dy0 + dh * dc, dz0 + dh * ds,
  ];
  const dNrm = [0, ds, -dc, 0, ds, -dc, 0, ds, -dc, 0, ds, -dc];
  const dUvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const dIdx = [0, 1, 2, 0, 2, 3];
  const dashPrim = buildPrim(dstDoc, buf, dPos, dNrm, dUvs, dIdx, dashMat);
  bodyNode.addChild(dstDoc.createNode("BMW_DASH_SCREEN").setMesh(dstDoc.createMesh("BMW_DASH_SCREEN").addPrimitive(dashPrim)));

  const wheelNodes = [];
  for (const [corner, wg] of Object.entries(wheelGroups)) {
    if (wg.rim.length) {
      const m = dstDoc.createMesh(`${corner}_RIM`);
      wg.rim.forEach((p) => m.addPrimitive(p));
      wg.root.addChild(dstDoc.createNode(`${corner}_RIM`).setMesh(m));
    }
    if (wg.tyre.length) {
      const m = dstDoc.createMesh(`${corner}_TYRE`);
      wg.tyre.forEach((p) => m.addPrimitive(p));
      wg.root.addChild(dstDoc.createNode(`${corner}_TYRE`).setMesh(m));
    }
    wheelNodes.push(wg.root);
  }

  const cameras = {
    cockpit: { pos: [0.0, 0.72, -0.10], pitchDeg: -5, fov: 60 },
    tcam: { pos: [0.0, 1.12, -0.58], pitchDeg: -9, fov: 58 },
    dash: { pos: [0.0, 0.65, 0.35], pitchDeg: -6, fov: 58 },
    bumper: { pos: [0.0, 0.42, 1.80], pitchDeg: -3, fov: 60 },
    nearChase: { pos: [0.0, 1.55, -4.8], pitchDeg: -10, fov: 60 },
    farChase: { pos: [0.0, 2.05, -6.8], pitchDeg: -10, fov: 60 },
  };
  const extras = {
    wheelCentres,
    tyreRadius: { LF: 0.3305, RF: 0.3305, LR: 0.3305, RR: 0.3305 },
    tyreHalfWidth: { LF: 0.143, RF: 0.143, LR: 0.157, RR: 0.157 },
    wheelbaseM: wheelCentres.WHEEL_LF[2] - wheelCentres.WHEEL_LR[2],
    trackWidthM: {
      front: wheelCentres.WHEEL_LF[0] - wheelCentres.WHEEL_RF[0],
      rear: wheelCentres.WHEEL_LR[0] - wheelCentres.WHEEL_RR[0],
    },
    steer: { pivot: steerPivot, columnAxis: [0, s, -c] },
    cameras,
    source: { converted: "scripts/cars/port_bmw_m6_jaguar_fe.mjs", author: "3dblender_1" },
  };

  const carRoot = dstDoc.createNode("CAR").setExtras(extras);
  carRoot.addChild(bodyNode);
  carRoot.addChild(steerNode);
  for (const wn of wheelNodes) carRoot.addChild(wn);
  dstDoc.createScene("Scene").addChild(carRoot);

  fs.mkdirSync("public/cars/jaguar-fe/model", { recursive: true });
  await io.write("public/cars/jaguar-fe/model/jaguar-fe.glb", dstDoc);
  console.log("Wrote public/cars/jaguar-fe/model/jaguar-fe.glb");
}

await portBmwM6();
await portJaguarFe();
