/**
 * Ports shunqi's "F1 2025 McLaren MCL39" (CC BY 4.0, https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34)
 * to the LC25 Prototype's body (`public/cars/lc25/model/lc25.glb`), in the exact `LC26` schema read by
 * `src/lib/lc26-car-model.ts`:
 *
 *   node --max-old-space-size=8192 scripts/cars/port_lc25_body.mjs <f1_2025_mclaren_mcl39.glb> [out.glb]
 *
 * Output (default `public/cars/lc25/model/lc25.glb`), metres, +X left, +Y up, +Z forward, tyres on y = 0,
 * front axle at z = 1.5045 (matching `f12026.glb` so AM26 steering wheel and onboard cameras align):
 *   LC26 (extras: wheelCentres, tyreRadius, tyreHalfWidth, steerBase, cameras, helmet, liveryMask: false, source)
 *     BODY           painted bodywork in LibreCorsa livery zones (no team/sponsor textures), carbon aero/floor/suspension,
 *                    mirrors (`mirror_1`/`mirror_2`), exhaust, FIA rain light (`EXT_clearled_security`), baked `_OCCLUSION`
 *       WING_REAR_DRS  rear-wing upper DRS flap hinged at trailing edge (`aeroClosed` / `aeroOpen` extras, rear-only DRS)
 *       STEER_BASE     AM26 steering wheel with live OLED display and RPM LEDs (CC BY 4.0 by DeX)
 *     SUSP_LF / RF   front wheel winglets / wake deflectors (steer and heave with front hubs)
 *     WHEEL_xx       hub pivot at tread centre; children WHEEL_xx_RIM (`EXT_RIM`), WHEEL_xx_TYRE (`EXT_TYRE`, 1 primitive)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { copyToDocument, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FRONT_AXLE_Z = 1.5045;
const STEER_FROM = path.join(ROOT, "scripts/cars/sources/am26-steering-wheel.glb");
const HELMET_POS = [0, 0.745, -0.055];

const ZONE = {
  primary: "EXT_PAINT_PRIMARY",
  secondary: "EXT_PAINT_SECONDARY",
  accent: "EXT_PAINT_ACCENT",
  carbon: "EXT_carbon",
  interior: "INT_cockpit",
  light: "EXT_clearled_security",
};

// ---------------------------------------------------------------------------------------------------------------
// Math & geometry helpers
// ---------------------------------------------------------------------------------------------------------------

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function along(p, d, s) { return [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s]; }

function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

function merge(meshes) {
  const valid = meshes.filter((m) => m && m.idx.length > 0);
  let vCount = 0;
  let iCount = 0;
  for (const m of valid) {
    vCount += m.pos.length / 3;
    iCount += m.idx.length;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let v = 0;
  let o = 0;
  for (const m of valid) {
    pos.set(m.pos, v * 3);
    nrm.set(m.nrm, v * 3);
    for (let i = 0; i < m.idx.length; i++) idx[o++] = m.idx[i] + v;
    v += m.pos.length / 3;
  }
  return { pos, nrm, idx };
}

function shift(m, d) {
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < m.pos.length; i += 3) {
    pos[i] = m.pos[i] - d[0];
    pos[i + 1] = m.pos[i + 1] - d[1];
    pos[i + 2] = m.pos[i + 2] - d[2];
  }
  return { pos, nrm: new Float32Array(m.nrm), idx: new Uint32Array(m.idx) };
}

function extractTris(mesh, triIndices, origin = [0, 0, 0]) {
  const remap = new Map();
  const pos = [];
  const nrm = [];
  const idx = new Uint32Array(triIndices.length * 3);
  let o = 0;
  for (const t of triIndices) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.idx[3 * t + c];
      let j = remap.get(v);
      if (j === undefined) {
        remap.set(v, (j = remap.size));
        pos.push(mesh.pos[3 * v] - origin[0], mesh.pos[3 * v + 1] - origin[1], mesh.pos[3 * v + 2] - origin[2]);
        nrm.push(mesh.nrm[3 * v], mesh.nrm[3 * v + 1], mesh.nrm[3 * v + 2]);
      }
      idx[o++] = j;
    }
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx };
}

function simplify(mesh, maxTris, { lockBorder = false, error = 0.015 } = {}) {
  if (!mesh || mesh.idx.length === 0) return { pos: new Float32Array(0), nrm: new Float32Array(0), idx: new Uint32Array(0) };
  const tris = mesh.idx.length / 3;
  const target = maxTris <= 1 ? Math.max(12, Math.round(tris * maxTris)) : Math.min(tris, maxTris);
  let idx = mesh.idx;
  if (target < tris) {
    const flags = lockBorder ? ["LockBorder"] : [];
    [idx] = MeshoptSimplifier.simplify(mesh.idx, mesh.pos, 3, target * 3, error, flags);
  }
  const remap = new Map();
  const pos = [];
  const nrm = [];
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i];
    let j = remap.get(v);
    if (j === undefined) {
      remap.set(v, (j = remap.size));
      pos.push(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
      nrm.push(mesh.nrm[3 * v], mesh.nrm[3 * v + 1], mesh.nrm[3 * v + 2]);
    }
    out[i] = j;
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: out };
}

function splitComponents(mesh, gridMm = 1.0) {
  const vCount = mesh.pos.length / 3;
  const inv = 1000 / gridMm;
  const keyMap = new Map();
  const weld = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const k = `${Math.round(mesh.pos[3 * i] * inv)},${Math.round(mesh.pos[3 * i + 1] * inv)},${Math.round(mesh.pos[3 * i + 2] * inv)}`;
    let id = keyMap.get(k);
    if (id === undefined) keyMap.set(k, (id = keyMap.size));
    weld[i] = id;
  }
  const parent = new Int32Array(keyMap.size).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  const nTris = mesh.idx.length / 3;
  for (let t = 0; t < nTris; t++) {
    const a = find(weld[mesh.idx[3 * t]]);
    parent[find(weld[mesh.idx[3 * t + 1]])] = a;
    parent[find(weld[mesh.idx[3 * t + 2]])] = a;
  }
  const groups = new Map();
  for (let t = 0; t < nTris; t++) {
    const r = find(weld[mesh.idx[3 * t]]);
    let arr = groups.get(r);
    if (!arr) groups.set(r, (arr = []));
    arr.push(t);
  }
  return [...groups.values()]
    .map((tris) => {
      const geo = extractTris(mesh, tris);
      return { tris, geo, ...bounds(geo) };
    })
    .sort((a, b) => b.tris.length - a.tris.length);
}

function triCentroid(mesh, t) {
  const a = mesh.idx[3 * t], b = mesh.idx[3 * t + 1], c = mesh.idx[3 * t + 2];
  return [
    (mesh.pos[3 * a] + mesh.pos[3 * b] + mesh.pos[3 * c]) / 3,
    (mesh.pos[3 * a + 1] + mesh.pos[3 * b + 1] + mesh.pos[3 * c + 1]) / 3,
    (mesh.pos[3 * a + 2] + mesh.pos[3 * b + 2] + mesh.pos[3 * c + 2]) / 3,
  ];
}

function triNormal(mesh, t) {
  const a = mesh.idx[3 * t], b = mesh.idx[3 * t + 1], c = mesh.idx[3 * t + 2];
  return unit([
    mesh.nrm[3 * a] + mesh.nrm[3 * b] + mesh.nrm[3 * c],
    mesh.nrm[3 * a + 1] + mesh.nrm[3 * b + 1] + mesh.nrm[3 * c + 1],
    mesh.nrm[3 * a + 2] + mesh.nrm[3 * b + 2] + mesh.nrm[3 * c + 2],
  ]);
}

function axisAngleX(angleRad) {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c],
  ];
}

/** Column-major 4x4 matrix from 3x3 rotation (row-major) + translation */
function matrix4(R, t) {
  return [
    R[0][0], R[1][0], R[2][0], 0,
    R[0][1], R[1][1], R[2][1], 0,
    R[0][2], R[1][2], R[2][2], 0,
    t[0], t[1], t[2], 1,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Read source GLB with baked world transforms, grouped by material name
// ---------------------------------------------------------------------------------------------------------------

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function transformNormal(m, x, y, z) {
  // Assumes uniform/rigid linear part (true for Sketchfab Blender exports)
  const nx = m[0] * x + m[4] * y + m[8] * z;
  const ny = m[1] * x + m[5] * y + m[9] * z;
  const nz = m[2] * x + m[6] * y + m[10] * z;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

async function readSourceByMaterial(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(file);
  const byMat = new Map();

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const matName = prim.getMaterial()?.getName() ?? "unknown";
      const pAttr = prim.getAttribute("POSITION");
      const nAttr = prim.getAttribute("NORMAL");
      const iAttr = prim.getIndices();
      if (!pAttr || !iAttr) continue;
      const nVerts = pAttr.getCount();
      const pos = new Float32Array(nVerts * 3);
      const nrm = new Float32Array(nVerts * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < nVerts; i++) {
        pAttr.getElement(i, v);
        const wp = transformPoint(wm, v[0], v[1], v[2]);
        pos[3 * i] = wp[0];
        pos[3 * i + 1] = wp[1];
        pos[3 * i + 2] = wp[2];
        if (nAttr) {
          nAttr.getElement(i, v);
          const wn = transformNormal(wm, v[0], v[1], v[2]);
          nrm[3 * i] = wn[0];
          nrm[3 * i + 1] = wn[1];
          nrm[3 * i + 2] = wn[2];
        } else {
          nrm[3 * i + 1] = 1;
        }
      }
      const nIdx = iAttr.getCount();
      const idx = new Uint32Array(nIdx);
      for (let i = 0; i < nIdx; i++) idx[i] = iAttr.getScalar(i);
      const list = byMat.get(matName) ?? [];
      list.push({ pos, nrm, idx });
      byMat.set(matName, list);
    }
  }

  const merged = new Map();
  for (const [name, list] of byMat) merged.set(name, merge(list));
  return merged;
}

// ---------------------------------------------------------------------------------------------------------------
// Zone line slicing for clean bodywork paint edges
// ---------------------------------------------------------------------------------------------------------------

const splitY = (z) => 0.34 + 0.055 * Math.min(1, Math.max(0, (0.6 - z) / 2.3));
const STRIPE = 0.024;
const UNDERCUT = -0.55;
const NOSE_Z = 1.25;

const BODY_ZONE_LINES = [
  { f: (p, n) => n[1] - UNDERCUT, where: (p) => p[1] < 0.5 && p[2] < 1.7 },
  { f: (p) => p[1] - 0.145, where: (p) => p[1] > 0.08 && p[1] < 0.25 },
  { f: (p) => p[1] - splitY(p[2]), where: (p) => p[1] > 0.2 && p[1] < 0.55 && p[2] < NOSE_Z + 0.05 },
  { f: (p) => p[1] - splitY(p[2]) - STRIPE, where: (p) => p[1] > 0.2 && p[1] < 0.6 && p[2] < NOSE_Z + 0.05 },
  { f: (p) => p[2] - NOSE_Z, where: (p) => p[1] > 0.2 && p[1] < 0.6 && Math.abs(p[0]) < 0.45 },
  { f: (p) => p[2] - 2.38, where: (p) => p[1] > 0.18 },
];

function cutAlong(mesh, lines) {
  const pos = Array.from(mesh.pos);
  const nrm = Array.from(mesh.nrm);
  let idx = [];
  for (let t = 0; t < mesh.idx.length; t += 3) idx.push([mesh.idx[t], mesh.idx[t + 1], mesh.idx[t + 2]]);
  const P = (v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];

  for (const line of lines) {
    const cache = new Map();
    const cut = (a, b, fa, fb) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let v = cache.get(k);
      if (v === undefined) {
        const s = fa / (fa - fb);
        const pa = P(a);
        const pb = P(b);
        v = pos.length / 3;
        for (let j = 0; j < 3; j++) pos.push(pa[j] + s * (pb[j] - pa[j]));
        const n = [0, 1, 2].map((j) => nrm[3 * a + j] + s * (nrm[3 * b + j] - nrm[3 * a + j]));
        const l = Math.hypot(...n) || 1;
        for (let j = 0; j < 3; j++) nrm.push(n[j] / l);
        cache.set(k, v);
      }
      return v;
    };
    const out = [];
    for (const tri of idx) {
      const ps = tri.map(P);
      const c = [0, 1, 2].map((j) => (ps[0][j] + ps[1][j] + ps[2][j]) / 3);
      const f = tri.map((v, k) => line.f(ps[k], [nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]]));
      const pos0 = f.filter((v) => v > 0).length;
      if (!line.where(c) || pos0 === 0 || pos0 === 3 || f.some((v) => v === 0)) {
        out.push(tri);
        continue;
      }
      const lone = f.findIndex((v) => (pos0 === 1 ? v > 0 : v <= 0));
      const [a, b, cc] = [tri[lone], tri[(lone + 1) % 3], tri[(lone + 2) % 3]];
      const [fa, fb, fc] = [f[lone], f[(lone + 1) % 3], f[(lone + 2) % 3]];
      const ab = cut(a, b, fa, fb);
      const ac = cut(a, cc, fa, fc);
      out.push([a, ab, ac], [ab, b, cc], [ab, cc, ac]);
    }
    idx = out;
  }

  const flatIdx = new Uint32Array(idx.length * 3);
  for (let i = 0; i < idx.length; i++) {
    flatIdx[3 * i] = idx[i][0];
    flatIdx[3 * i + 1] = idx[i][1];
    flatIdx[3 * i + 2] = idx[i][2];
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: flatIdx };
}

function mainBodyZone(c, n) {
  const [x, y, z] = c;
  const ax = Math.abs(x);
  // Rear crash-structure FIA rain / ERS light
  if (z < -2.725 && ax < 0.048 && y > 0.24 && y < 0.39 && n[2] < -0.55) return ZONE.light;
  // Floor, Venturi floor edge, plank & rear diffuser
  if (y < 0.145) return ZONE.carbon;
  if (z < -2.02 && y < 0.37 && ax < 0.62) return ZONE.carbon;
  if (n[1] < UNDERCUT && y < 0.5 && z < 1.7) return ZONE.carbon;
  // Cockpit interior tub
  if (ax < 0.25 && z > -0.25 && z < 0.62 && y < 0.68 && y > 0.16) return ZONE.interior;
  // Nose tip accent
  if (z > 2.38) return ZONE.accent;
  // Forward nose ahead of front bulkhead: primary
  if (z > NOSE_Z) return ZONE.primary;
  // Sidepods & engine cover split with accent pinstripe
  const s = splitY(z);
  if (y > s + STRIPE) return ZONE.primary;
  if (y > s && ax > 0.1) return ZONE.accent;
  return y > s ? ZONE.primary : ZONE.secondary;
}

// ---------------------------------------------------------------------------------------------------------------
// Voxel ambient occlusion (same method as port_qvist_f1.mjs)
// ---------------------------------------------------------------------------------------------------------------

const OCCLUSION = { voxel: 0.014, reach: 0.3, rays: 40, floor: 0.22, lift: 2 };
const OCCLUSION_RAYS = Array.from({ length: OCCLUSION.rays }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / OCCLUSION.rays);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)];
});

function occlusionGrid(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
    if (!m.idx.length) continue;
    const b = bounds(m);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  const h = OCCLUSION.voxel;
  const size = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / h) + 1);
  const cells = new Uint8Array(size[0] * size[1] * size[2]);
  const mark = (x, y, z) => {
    const i = Math.floor((x - min[0]) / h);
    const j = Math.floor((y - min[1]) / h);
    const k = Math.floor((z - min[2]) / h);
    if (i >= 0 && j >= 0 && k >= 0 && i < size[0] && j < size[1] && k < size[2]) {
      cells[(k * size[1] + j) * size[0] + i] = 1;
    }
  };
  for (const m of meshes) {
    for (let t = 0; t < m.idx.length; t += 3) {
      const a = [m.pos[3 * m.idx[t]], m.pos[3 * m.idx[t] + 1], m.pos[3 * m.idx[t] + 2]];
      const b = [m.pos[3 * m.idx[t + 1]], m.pos[3 * m.idx[t + 1] + 1], m.pos[3 * m.idx[t + 1] + 2]];
      const c = [m.pos[3 * m.idx[t + 2]], m.pos[3 * m.idx[t + 2] + 1], m.pos[3 * m.idx[t + 2] + 2]];
      const ab = sub(b, a);
      const ac = sub(c, a);
      const n = Math.max(1, Math.ceil(Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...sub(c, b))) / (h * 0.55)));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          mark(a[0] + (ab[0] * i + ac[0] * j) / n, a[1] + (ab[1] * i + ac[1] * j) / n, a[2] + (ab[2] * i + ac[2] * j) / n);
        }
      }
    }
  }
  return {
    full: (x, y, z) => {
      if (y < 0) return true;
      const i = Math.floor((x - min[0]) / h);
      const j = Math.floor((y - min[1]) / h);
      const k = Math.floor((z - min[2]) / h);
      return i >= 0 && j >= 0 && k >= 0 && i < size[0] && j < size[1] && k < size[2] && cells[(k * size[1] + j) * size[0] + i] === 1;
    },
  };
}

function occlusionOf(grid, mesh) {
  const h = OCCLUSION.voxel;
  const out = new Uint8Array(mesh.pos.length / 3);
  for (let v = 0; v < out.length; v++) {
    const p = [mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]];
    const n = unit([mesh.nrm[3 * v], mesh.nrm[3 * v + 1], mesh.nrm[3 * v + 2]]);
    const u = unit(Math.abs(n[1]) > 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
    const w = cross3(n, u);
    const o = along(p, n, OCCLUSION.lift * h);
    let dark = 0;
    for (const [rx, ry, rz] of OCCLUSION_RAYS) {
      const d = [u[0] * rx + w[0] * ry + n[0] * rz, u[1] * rx + w[1] * ry + n[1] * rz, u[2] * rx + w[2] * ry + n[2] * rz];
      for (let s = h; s < OCCLUSION.reach; s += h) {
        if (!grid.full(o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s)) continue;
        dark += 1 - s / OCCLUSION.reach;
        break;
      }
    }
    out[v] = Math.round(255 * Math.max(OCCLUSION.floor, 1 - dark / OCCLUSION.rays));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// glTF output helpers
// ---------------------------------------------------------------------------------------------------------------

function makeMaterial(doc, name, color, { metallic = 0, roughness = 0.55 } = {}) {
  return doc
    .createMaterial(name)
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(metallic)
    .setRoughnessFactor(roughness);
}

function addMesh(doc, buffer, name, parts, shaded) {
  const mesh = doc.createMesh(name);
  for (const { geo, mat, at } of parts) {
    if (!geo || geo.idx.length === 0) continue;
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(geo.pos).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(geo.nrm).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(geo.idx).setBuffer(buffer))
      .setMaterial(mat);
    mesh.addPrimitive(prim);
    shaded?.push({ prim, mesh: at ?? geo });
  }
  return mesh;
}

function splitByPredicate(mesh, pred) {
  const a = [];
  const b = [];
  const n = mesh.idx.length / 3;
  for (let t = 0; t < n; t++) {
    const c = triCentroid(mesh, t);
    const nr = triNormal(mesh, t);
    (pred(c, nr) ? a : b).push(t);
  }
  return [extractTris(mesh, a), extractTris(mesh, b)];
}

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const [srcFile, outArg] = process.argv.slice(2);
  if (!srcFile) {
    console.error("usage: node --max-old-space-size=8192 scripts/cars/port_lc25_body.mjs <f1_2025_mclaren_mcl39.glb> [out.glb]");
    process.exit(1);
  }
  const outFile = outArg ?? path.join(ROOT, "public/cars/lc25/model/lc25.glb");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await MeshoptSimplifier.ready;
  await MeshoptDecoder.ready;

  const rawByMat = await readSourceByMaterial(srcFile);

  // Measure ground Y and front axle Z from tyres
  const ftRaw = rawByMat.get("front_tire");
  const rtRaw = rawByMat.get("rear_tire");
  if (!ftRaw || !rtRaw) throw new Error("Expected front_tire and rear_tire materials in source GLB");
  const ftB = bounds(ftRaw);
  const rtB = bounds(rtRaw);
  const groundY = Math.min(ftB.min[1], rtB.min[1]);
  const frontZRaw = (ftB.min[2] + ftB.max[2]) / 2;
  const rearZRaw = (rtB.min[2] + rtB.max[2]) / 2;
  const wheelbase = frontZRaw - rearZRaw;
  const offset = [0, groundY, frontZRaw - FRONT_AXLE_Z]; // subtract `offset` to place in rig frame

  const byMat = new Map();
  for (const [name, m] of rawByMat) byMat.set(name, shift(m, offset));
  console.log(`Loaded shunqi GLB: groundY=${groundY.toFixed(4)}, wheelbase=${wheelbase.toFixed(4)} m`);

  // --- 1. Wheels (split L/R and F/R) ---
  const wheelDefs = [
    { corner: "LF", node: "WHEEL_LF", isFront: true, isLeft: true },
    { corner: "RF", node: "WHEEL_RF", isFront: true, isLeft: false },
    { corner: "LR", node: "WHEEL_LR", isFront: false, isLeft: true },
    { corner: "RR", node: "WHEEL_RR", isFront: false, isLeft: false },
  ];

  const rimMatParts = [
    { name: "wheel_rim", budgetPerWheel: 2200 },
    { name: "front_wheel_cover", budgetPerWheel: 2200 },
    { name: "rear_wheel_cover", budgetPerWheel: 2200 },
    { name: "wheel_nut", budgetPerWheel: 700 },
    { name: "wheel_screw", budgetPerWheel: 350 },
    { name: "wheel_screw.001", budgetPerWheel: 250 },
  ];

  const wheels = [];
  for (const wd of wheelDefs) {
    const tyreSrc = byMat.get(wd.isFront ? "front_tire" : "rear_tire");
    const [tyreWorld] = splitByPredicate(tyreSrc, (c) => (wd.isLeft ? c[0] > 0 : c[0] < 0));
    const tb = bounds(tyreWorld);
    const centre = [(tb.min[0] + tb.max[0]) / 2, (tb.min[1] + tb.max[1]) / 2, (tb.min[2] + tb.max[2]) / 2];
    const tyreRadius = (tb.max[1] - tb.min[1]) / 2;
    const tyreHalfWidth = (tb.max[0] - tb.min[0]) / 2;

    const rimPieces = [];
    for (const rp of rimMatParts) {
      const m = byMat.get(rp.name);
      if (!m) continue;
      const [piece] = splitByPredicate(m, (c) => (wd.isFront ? c[2] > 0 : c[2] < 0) && (wd.isLeft ? c[0] > 0 : c[0] < 0));
      if (piece.idx.length > 0) rimPieces.push(simplify(shift(piece, centre), rp.budgetPerWheel, { error: 0.02 }));
    }

    const tyreLocal = simplify(shift(tyreWorld, centre), 4500, { error: 0.01 });
    const rimLocal = merge(rimPieces);
    wheels.push({ ...wd, centre, tyreRadius, tyreHalfWidth, tyreLocal, rimLocal });
  }

  // --- 2. Front wheel winglets -> SUSP_LF / SUSP_RF (steer with front hubs) ---
  const suspHubs = [];
  const windlet = byMat.get("front_wheel_windlet");
  if (windlet) {
    for (const wd of wheels.filter((w) => w.isFront)) {
      const [wing] = splitByPredicate(windlet, (c) => (wd.isLeft ? c[0] > 0 : c[0] < 0));
      const simp = simplify(wing, 2800, { error: 0.015 });
      suspHubs.push({ corner: wd.corner, centre: wd.centre, world: simp, local: shift(simp, wd.centre) });
    }
  }

  // --- 3. Rear wing -> detach movable upper DRS flap + paint zones ---
  const rwRaw = byMat.get("rear_wing");
  const rwComps = splitComponents(rwRaw, 1.0);
  const drsIdx = rwComps.findIndex((comp) => comp.max[0] <= 0.52 && comp.min[0] >= -0.52 && comp.min[1] > 0.78 && comp.tris.length > 1000);
  if (drsIdx < 0) throw new Error("Could not locate detached upper DRS flap component in rear_wing");
  const drsWorld = simplify(rwComps[drsIdx].geo, 2200, { error: 0.01 });
  const drsB = bounds(drsWorld);
  // Real F1 DRS pivots near the upper trailing edge so the leading edge lifts up to open an ~85 mm slot gap.
  // With +X left, +Y up, +Z forward, rotating by -24 deg about +X lifts +Z (leading edge) upward (+Y).
  const drsPivot = [0, drsB.max[1] - 0.018, drsB.min[2] + 0.015];
  const drsLocal = shift(drsWorld, drsPivot);
  const drsOpenRot = axisAngleX((-24 * Math.PI) / 180);
  const ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  console.log(`  DRS flap: ${drsWorld.idx.length / 3} tris, pivot=[${drsPivot.map((v) => v.toFixed(3)).join(", ")}]`);

  const rwStaticWorld = merge(rwComps.filter((_, i) => i !== drsIdx).map((c) => c.geo));

  // --- 4. Partition bodywork materials into LibreCorsa paint zones + carbon + mirrors + exhaust ---
  const zoneBuckets = new Map([
    [ZONE.primary, []],
    [ZONE.secondary, []],
    [ZONE.accent, []],
    [ZONE.carbon, []],
    [ZONE.interior, []],
    [ZONE.light, []],
  ]);

  // Main body: slice along zone lines first so paint boundaries are razor-sharp
  const mbCut = cutAlong(byMat.get("main_body"), BODY_ZONE_LINES);
  const mbByZone = new Map();
  for (let t = 0; t < mbCut.idx.length / 3; t++) {
    const z = mainBodyZone(triCentroid(mbCut, t), triNormal(mbCut, t));
    let arr = mbByZone.get(z);
    if (!arr) mbByZone.set(z, (arr = []));
    arr.push(t);
  }
  const mbScale = 52_000 / (mbCut.idx.length / 3);
  for (const [z, tris] of mbByZone) {
    const geo = extractTris(mbCut, tris);
    // Keep rain light unsimplified so it stays crisp
    const simp = z === ZONE.light ? geo : simplify(geo, Math.max(200, Math.round(tris.length * mbScale)), { lockBorder: true, error: 0.012 });
    zoneBuckets.get(z).push(simp);
    console.log(`  main_body ${z}: ${tris.length} -> ${simp.idx.length / 3} tris`);
  }

  // Rear wing static: endplates (primary + accent top), main plane (secondary), beam wings & central mount (carbon)
  const rwByZone = new Map();
  for (let t = 0; t < rwStaticWorld.idx.length / 3; t++) {
    const c = triCentroid(rwStaticWorld, t);
    const ax = Math.abs(c[0]);
    let z = ZONE.carbon;
    if (ax > 0.46 && c[1] > 0.44) z = c[1] > 0.905 ? ZONE.accent : ZONE.primary;
    else if (ax <= 0.46 && c[1] > 0.64) z = ZONE.secondary;
    let arr = rwByZone.get(z);
    if (!arr) rwByZone.set(z, (arr = []));
    arr.push(t);
  }
  for (const [z, tris] of rwByZone) {
    zoneBuckets.get(z).push(simplify(extractTris(rwStaticWorld, tris), Math.max(300, Math.round(tris.length * 0.45)), { lockBorder: true }));
  }

  // Front wing: endplate tops accent, centre nose primary, rest secondary; wing strakes carbon
  const fwRaw = byMat.get("front_wing");
  const fwByZone = new Map();
  for (let t = 0; t < fwRaw.idx.length / 3; t++) {
    const c = triCentroid(fwRaw, t);
    const ax = Math.abs(c[0]);
    let z = ZONE.secondary;
    if (ax > 0.88 && c[1] > 0.36) z = ZONE.accent;
    else if (ax < 0.16 && c[1] > 0.25) z = ZONE.primary;
    let arr = fwByZone.get(z);
    if (!arr) fwByZone.set(z, (arr = []));
    arr.push(t);
  }
  for (const [z, tris] of fwByZone) {
    zoneBuckets.get(z).push(simplify(extractTris(fwRaw, tris), Math.max(300, Math.round(tris.length * 0.45)), { lockBorder: true }));
  }
  if (byMat.get("front_wing_c")) zoneBuckets.get(ZONE.carbon).push(simplify(byMat.get("front_wing_c"), 5500, { error: 0.02 }));

  // Halo, headrest, DRS pod, suspensions, T-cam / misc
  if (byMat.get("halo")) zoneBuckets.get(ZONE.secondary).push(simplify(byMat.get("halo"), 5000));
  if (byMat.get("headrest")) zoneBuckets.get(ZONE.interior).push(simplify(byMat.get("headrest"), 2200));
  if (byMat.get("drs_puller")) zoneBuckets.get(ZONE.carbon).push(simplify(byMat.get("drs_puller"), 900));
  if (byMat.get("suspensions")) zoneBuckets.get(ZONE.carbon).push(simplify(byMat.get("suspensions"), 16000, { error: 0.02 }));
  if (byMat.get("cam_tbone_misc")) zoneBuckets.get(ZONE.carbon).push(simplify(byMat.get("cam_tbone_misc"), 6500, { error: 0.02 }));

  // Mirrors: split glass faces (rear-facing flat surfaces) from housings
  let mirrorL = { pos: new Float32Array(0), nrm: new Float32Array(0), idx: new Uint32Array(0) };
  let mirrorR = { pos: new Float32Array(0), nrm: new Float32Array(0), idx: new Uint32Array(0) };
  if (byMat.get("mirror")) {
    const mirSimp = simplify(byMat.get("mirror"), 4500, { error: 0.015 });
    const [glass, housing] = splitByPredicate(
      mirSimp,
      (c, n) => n[2] < -0.78 && Math.abs(c[0]) > 0.44 && Math.abs(c[0]) < 0.65 && c[1] > 0.685 && c[1] < 0.745
    );
    [mirrorL, mirrorR] = splitByPredicate(glass, (c) => c[0] > 0);
    zoneBuckets.get(ZONE.primary).push(housing);
    console.log(`  mirrors: housing=${housing.idx.length / 3}, glassL=${mirrorL.idx.length / 3}, glassR=${mirrorR.idx.length / 3}`);
  }

  const exhaustGeo = byMat.get("exthaust") ? simplify(byMat.get("exthaust"), 1200) : null;

  // --- 5. Assemble glTF Document ---
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mats = {
    [ZONE.primary]: makeMaterial(doc, ZONE.primary, [0.0, 0.32, 0.72], { roughness: 0.5 }),
    [ZONE.secondary]: makeMaterial(doc, ZONE.secondary, [0.008, 0.01, 0.022], { roughness: 0.5 }),
    [ZONE.accent]: makeMaterial(doc, ZONE.accent, [0.95, 0.65, 0.0], { roughness: 0.5 }),
    [ZONE.carbon]: makeMaterial(doc, ZONE.carbon, [0.012, 0.012, 0.013], { roughness: 0.35 }),
    [ZONE.interior]: makeMaterial(doc, ZONE.interior, [0.006, 0.006, 0.007], { roughness: 1 }),
    [ZONE.light]: makeMaterial(doc, ZONE.light, [0.3, 0.02, 0.02], { roughness: 0.3 }),
    exhaust: makeMaterial(doc, "EXT_exhaust", [0.35, 0.33, 0.3], { metallic: 0.8, roughness: 0.35 }),
    mirrorL: makeMaterial(doc, "mirror_1", [0.6, 0.6, 0.62], { metallic: 1, roughness: 0.05 }),
    mirrorR: makeMaterial(doc, "mirror_2", [0.6, 0.6, 0.62], { metallic: 1, roughness: 0.05 }),
    rim: makeMaterial(doc, "EXT_RIM", [0.045, 0.045, 0.05], { metallic: 0.55, roughness: 0.38 }),
    tyre: makeMaterial(doc, "EXT_TYRE", [0.035, 0.035, 0.035], { roughness: 0.85 }),
  };
  const specular = doc.createExtension(KHRMaterialsSpecular);
  mats[ZONE.interior].setExtension("KHR_materials_specular", specular.createSpecular().setSpecularFactor(0.35));

  const root = doc.createNode("LC26");
  doc.createScene("Scene").addChild(root);

  const shaded = [];
  const bodyParts = [];
  for (const [z, list] of zoneBuckets) {
    const geo = merge(list);
    if (geo.idx.length > 0) bodyParts.push({ geo, mat: mats[z] });
  }
  if (exhaustGeo && exhaustGeo.idx.length > 0) bodyParts.push({ geo: exhaustGeo, mat: mats.exhaust });
  if (mirrorL.idx.length > 0) bodyParts.push({ geo: mirrorL, mat: mats.mirrorL });
  if (mirrorR.idx.length > 0) bodyParts.push({ geo: mirrorR, mat: mats.mirrorR });

  const bodyNode = doc.createNode("BODY").setMesh(addMesh(doc, buffer, "BODY", bodyParts, shaded));
  // Rear-wing DRS flap node
  const drsNode = doc
    .createNode("WING_REAR_DRS")
    .setTranslation(drsPivot)
    .setMesh(addMesh(doc, buffer, "WING_REAR_DRS", [{ geo: drsLocal, mat: mats[ZONE.primary], at: drsWorld }], shaded))
    .setExtras({ aeroClosed: matrix4(ident, drsPivot), aeroOpen: matrix4(drsOpenRot, drsPivot) });
  bodyNode.addChild(drsNode);
  root.addChild(bodyNode);

  // Front wheel aero deflectors (SUSP_LF / SUSP_RF)
  for (const h of suspHubs) {
    const name = `SUSP_${h.corner}`;
    root.addChild(
      doc
        .createNode(name)
        .setTranslation(h.centre)
        .setMesh(addMesh(doc, buffer, name, [{ geo: h.local, mat: mats[ZONE.carbon], at: h.world }], shaded))
    );
  }

  // Wheels
  const wheelCentres = {};
  const tyreRadius = {};
  const tyreHalfWidth = {};
  const wheelsAtRest = [];
  for (const w of wheels) {
    wheelCentres[w.node] = w.centre;
    tyreRadius[w.corner] = Number(w.tyreRadius.toFixed(4));
    tyreHalfWidth[w.corner] = Number(w.tyreHalfWidth.toFixed(4));
    const wn = doc.createNode(w.node).setTranslation(w.centre);
    wn.addChild(doc.createNode(`${w.node}_RIM`).setMesh(addMesh(doc, buffer, `${w.node}_RIM`, [{ geo: w.rimLocal, mat: mats.rim }])));
    wn.addChild(doc.createNode(`${w.node}_TYRE`).setMesh(addMesh(doc, buffer, `${w.node}_TYRE`, [{ geo: w.tyreLocal, mat: mats.tyre }])));
    root.addChild(wn);
    wheelsAtRest.push(shift(w.rimLocal, w.centre.map((v) => -v)), shift(w.tyreLocal, w.centre.map((v) => -v)));
  }

  // --- 6. Bake _OCCLUSION vertex AO ---
  const grid = occlusionGrid([...shaded.map((x) => x.mesh), ...wheelsAtRest]);
  let darkest = 255;
  let sum = 0;
  let count = 0;
  for (const { prim, mesh } of shaded) {
    const ao = occlusionOf(grid, mesh);
    for (const v of ao) {
      if (v < darkest) darkest = v;
      sum += v;
    }
    count += ao.length;
    prim.setAttribute("_OCCLUSION", doc.createAccessor().setType("SCALAR").setArray(ao).setNormalized(true).setBuffer(buffer));
  }
  console.log(`  occlusion: ${count} vertices, mean ${(sum / count / 255).toFixed(3)}, darkest ${(darkest / 255).toFixed(2)}`);

  // --- 7. Graft AM26 steering wheel (CC BY 4.0 by DeX) & cameras ---
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const amr = await io.read(STEER_FROM);
  const amrRoot = amr.getRoot().listNodes().find((n) => n.getName() === "LC26" || n.getName() === "VF26");
  const steerSrc = amr.getRoot().listNodes().find((n) => n.getName() === "STEER_BASE");
  if (!amrRoot || !steerSrc) throw new Error(`${STEER_FROM}: missing LC26/STEER_BASE`);
  const subtree = [];
  const walk = (n) => { subtree.push(n); n.listChildren().forEach(walk); };
  walk(steerSrc);
  const copied = copyToDocument(doc, amr, subtree);
  const steer = copied.get(steerSrc);
  for (const a of doc.getRoot().listAccessors()) a.setBuffer(buffer);
  for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
  bodyNode.addChild(steer);

  const amrExtras = amrRoot.getExtras();
  const cameras = structuredClone(amrExtras.cameras);
  // Adjust T-cam slightly for LC25 airbox (y=1.04) and chase cams for longer 3.57 m chassis
  cameras.tcam = { pos: [0.08, 1.13, -0.44], pitchDeg: -12.0, fov: 55 };
  cameras.nearChase = { pos: [0, 1.82, -5.25], pitchDeg: -5, fov: 55 };
  cameras.farChase = { pos: [0, 2.52, -6.58], pitchDeg: -5, fov: 55 };

  root.setExtras({
    wheelCentres,
    tyreRadius,
    tyreHalfWidth,
    wheelbaseM: Number(wheelbase.toFixed(4)),
    steerBase: amrExtras.steerBase,
    cameras,
    helmet: { pos: HELMET_POS },
    liveryMask: false,
    source: {
      title: "F1 2025 McLaren MCL39",
      author: "shunqi",
      url: "https://sketchfab.com/3d-models/f1-2025-mclaren-mcl39-c6194270002b401bb25be7e35ab56e34",
      license: "CC BY 4.0",
      changes:
        "Re-oriented to metres on y = 0; simplified with meshoptimizer; team textures replaced by LibreCorsa livery zones and carbon weave; wheels split into rim and tyre; front wheel deflectors attached to steering hubs; rear DRS flap hinged; AM26 steering wheel (CC BY 4.0) added",
    },
  });

  await doc.transform(prune({ keepExtras: true }));
  let totalTris = 0;
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) totalTris += p.getIndices().getCount() / 3;
  }
  await io.write(outFile, doc);
  const sizeMb = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
  console.log(`\nWrote ${path.relative(ROOT, outFile)}: ${totalTris} triangles (${sizeMb} MB)`);
  console.log(`Wheelbase: ${wheelbase.toFixed(4)} m`);
  for (const w of wheels) {
    console.log(`  ${w.node}: centre=[${w.centre.map((v) => v.toFixed(4)).join(", ")}] r=${w.tyreRadius.toFixed(4)} halfW=${w.tyreHalfWidth.toFixed(4)}`);
  }
}

await main();
