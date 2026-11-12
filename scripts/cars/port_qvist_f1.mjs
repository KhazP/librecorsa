/**
 * Ports Qvist_designs' "F1 2026 concept (polygon model)" (Sketchfab, CC BY 4.0) to the 2026 Prototype's body,
 * in the layout `src/lib/vf26-car-model.ts` reads:
 *
 *   node scripts/cars/port_qvist_f1.mjs <f1_2026_concept_polygon_model.glb> [out.glb] [--debug-parts <file.glb>]
 *
 * Output (default `public/cars/f12026/model/f12026.glb`), metres, +X left, +Y up, +Z forward, tyres on y = 0, the
 * front axle at z = 1.5045 (where the AMR26 body had it, so the cameras it shares stay comparable):
 *   VF26 (extras: wheelCentres, cameras, liveryMask: false, source)
 *     BODY        the bodywork, one mesh per material
 *     WHEEL_xx    hub pivot at the tread centre; children WHEEL_xx_RIM, WHEEL_xx_TYRE (one primitive)
 *
 * The download is one CAD shell exported as eleven 65k-vertex chunks, with no UVs, one grey material and constant
 * vertex colours. Its separate pieces are found by shared vertex positions: the four wheels, two mirror glasses and
 * the exhaust; everything else is one welded body. Each wheel splits into tyre and rim by radius. Every piece is
 * simplified on its own with meshoptimizer (attribute seams kept), and the source normals are kept.
 */
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { copyToDocument, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

/** Where the AMR26 body had its front axle (m); the porter puts this model's there too */
const FRONT_AXLE_Z = 1.5045;
/** Tyre / rim boundary (m from the axle): the rim's outer lip ends at ~0.245, the tyre's bead starts at ~0.255 */
const TYRE_MIN_RADIUS = 0.25;

/** Triangle budgets after simplification */
const BUDGET = { body: 100_000, rim: 5_000, tyre: 4_000, small: 1.0 };

const WHEEL_NAMES = { LF: "WHEEL_LF", RF: "WHEEL_RF", LR: "WHEEL_LR", RR: "WHEEL_RR" };

/**
 * DeX's AM26 (CC BY 4.0, the car's previous body) gives it its steering wheel, shift lights and display, and its
 * cockpit cameras: with the front axles lined up the two cockpits sit within ~5 cm of each other (halo, headrest,
 * roll hoop). Only those are kept, in this file: the AM26's `VF26` root with its `cameras` and `steerBase` extras and
 * its `STEER_BASE` subtree.
 */
const STEER_FROM = path.join(ROOT, "scripts/cars/sources/am26-steering-wheel.glb");
/** Where the driver's helmet goes (its centre; the cockpit eye is at 0, 0.74, 0) */
const HELMET_POS = [0, 0.745, -0.055];

// ---------------------------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------------------------

/** Every triangle of the download, in its own millimetre frame (x back, y right, z up; the nose is at -x) */
async function readSource(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(file);
  const pos = [];
  const nrm = [];
  const idx = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // The chunks sit under the Sketchfab root's -90 degree X turn; only that is expected (the axes below undo it)
    const local = node.getMatrix();
    if (local.some((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) > 1e-9)) throw new Error(`${node.getName()} has a transform`);
    for (const prim of mesh.listPrimitives()) {
      const p = prim.getAttribute("POSITION");
      const n = prim.getAttribute("NORMAL");
      const ix = prim.getIndices();
      const base = pos.length / 3;
      const v = [0, 0, 0];
      for (let i = 0; i < p.getCount(); i++) {
        p.getElement(i, v);
        pos.push(v[0], v[1], v[2]);
        n.getElement(i, v);
        nrm.push(v[0], v[1], v[2]);
      }
      for (let i = 0; i < ix.getCount(); i++) idx.push(base + ix.getScalar(i));
    }
  }
  return { pos: Float64Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx) };
}

/** Connected pieces: vertices at the same position join (the export splits the shell into chunks) */
function pieces(src) {
  const vCount = src.pos.length / 3;
  const key = new Map();
  const weld = new Int32Array(vCount);
  for (let i = 0; i < vCount; i++) {
    const k = `${src.pos[3 * i]},${src.pos[3 * i + 1]},${src.pos[3 * i + 2]}`;
    let j = key.get(k);
    if (j === undefined) key.set(k, (j = key.size));
    weld[i] = j;
  }
  const parent = new Int32Array(key.size).map((_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < src.idx.length; t += 3) {
    const a = find(weld[src.idx[t]]);
    parent[find(weld[src.idx[t + 1]])] = a;
    parent[find(weld[src.idx[t + 2]])] = a;
  }
  const byRoot = new Map();
  for (let t = 0; t < src.idx.length; t += 3) {
    const r = find(weld[src.idx[t]]);
    let p = byRoot.get(r);
    if (!p) byRoot.set(r, (p = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    p.tris.push(t / 3);
    for (let c = 0; c < 3; c++) {
      const v = src.idx[t + c];
      for (let k = 0; k < 3; k++) {
        p.min[k] = Math.min(p.min[k], src.pos[3 * v + k]);
        p.max[k] = Math.max(p.max[k], src.pos[3 * v + k]);
      }
    }
  }
  return { list: [...byRoot.values()].sort((a, b) => b.tris.length - a.tris.length), weld };
}

/** Names the pieces: the body (largest), four wheels (~720 mm discs), two mirror glasses, the exhaust */
function classify(list) {
  const size = (p, k) => p.max[k] - p.min[k];
  const wheels = list.filter((p) => Math.abs(size(p, 0) - 718) < 30 && Math.abs(size(p, 2) - 718) < 30);
  if (wheels.length !== 4) throw new Error(`expected 4 wheels, found ${wheels.length}`);
  const body = list[0];
  if (wheels.includes(body)) throw new Error("the largest piece is a wheel");
  const rest = list.filter((p) => p !== body && !wheels.includes(p));
  // Mirror glasses: a pair of small plates either side of the cockpit, ~0.5-0.7 m out
  const mirrors = rest.filter((p) => p.tris.length < 400 && Math.min(Math.abs(p.min[1]), Math.abs(p.max[1])) > 400);
  const exhaust = rest.find((p) => Math.abs(p.min[1] + p.max[1]) < 5 && p.min[0] > 3000 && p.tris.length > 1000);
  const other = rest.filter((p) => !mirrors.includes(p) && p !== exhaust);
  return { body, wheels, mirrors, exhaust, other };
}

// ---------------------------------------------------------------------------------------------------------------
// Frame: source millimetres -> rig metres
// ---------------------------------------------------------------------------------------------------------------

function rigFrame(wheels) {
  const cx = (p) => (p.min[0] + p.max[0]) / 2;
  const xs = wheels.map(cx).sort((a, b) => a - b);
  const xFront = (xs[0] + xs[1]) / 2;
  const xRear = (xs[2] + xs[3]) / 2;
  const zGround = Math.min(...wheels.map((p) => p.min[2]));
  return {
    wheelbase: (xRear - xFront) / 1000,
    /** Position: +X left (source -y), +Y up from the tyre contact, +Z forward with the front axle at FRONT_AXLE_Z */
    point: (x, y, z) => [-y / 1000, (z - zGround) / 1000, FRONT_AXLE_Z - (x - xFront) / 1000],
    dir: (x, y, z) => [-y, z, -x],
  };
}

function toRig(src, frame) {
  const n = src.pos.length / 3;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos.set(frame.point(src.pos[3 * i], src.pos[3 * i + 1], src.pos[3 * i + 2]), 3 * i);
    const d = frame.dir(src.nrm[3 * i], src.nrm[3 * i + 1], src.nrm[3 * i + 2]);
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    nrm.set([d[0] / l, d[1] / l, d[2] / l], 3 * i);
  }
  return { pos, nrm, idx: src.idx };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------

/** A standalone mesh of some triangles: positions shifted by -origin, only the vertices they use */
function extract(rig, tris, origin = [0, 0, 0]) {
  const remap = new Map();
  const pos = [];
  const nrm = [];
  const idx = new Uint32Array(tris.length * 3);
  let o = 0;
  for (const t of tris) {
    for (let c = 0; c < 3; c++) {
      const v = rig.idx[3 * t + c];
      let j = remap.get(v);
      if (j === undefined) {
        remap.set(v, (j = remap.size));
        pos.push(rig.pos[3 * v] - origin[0], rig.pos[3 * v + 1] - origin[1], rig.pos[3 * v + 2] - origin[2]);
        nrm.push(rig.nrm[3 * v], rig.nrm[3 * v + 1], rig.nrm[3 * v + 2]);
      }
      idx[o++] = j;
    }
  }
  return { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx };
}

/** Simplifies to at most `maxTris` triangles (a fraction of the source when < 1), then drops unused vertices */
function simplify(mesh, maxTris, { lockBorder = false } = {}) {
  const tris = mesh.idx.length / 3;
  const target = maxTris <= 1 ? Math.round(tris * maxTris) : Math.min(tris, maxTris);
  let idx = mesh.idx;
  if (target < tris) {
    const flags = lockBorder ? ["LockBorder"] : [];
    [idx] = MeshoptSimplifier.simplify(mesh.idx, mesh.pos, 3, target * 3, 0.01, flags);
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

function bounds(mesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mesh.pos[i + k]);
      max[k] = Math.max(max[k], mesh.pos[i + k]);
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------------------------------------------

/** One wheel: its corner, hub centre (rig) and its tyre / rim triangles split by radius from the axle */
function wheel(rig, piece) {
  const all = extract(rig, piece.tris);
  const b = bounds(all);
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const tyre = [];
  const rim = [];
  for (const t of piece.tris) {
    let rMin = Infinity;
    for (let c = 0; c < 3; c++) {
      const v = rig.idx[3 * t + c];
      rMin = Math.min(rMin, Math.hypot(rig.pos[3 * v + 1] - cy, rig.pos[3 * v + 2] - cz));
    }
    (rMin >= TYRE_MIN_RADIUS ? tyre : rim).push(t);
  }
  const tb = bounds(extract(rig, tyre));
  const centre = [(tb.min[0] + tb.max[0]) / 2, cy, cz];
  const corner = `${centre[0] > 0 ? "L" : "R"}${centre[2] > FRONT_AXLE_Z - 1 ? "F" : "R"}`;
  return {
    corner,
    centre,
    tyre: extract(rig, tyre, centre),
    rim: extract(rig, rim, centre),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Active aero: the flaps are cut out of the welded body
// ---------------------------------------------------------------------------------------------------------------

/**
 * The wing elements: body triangles wholly inside `box` ([xmin, xmax, ymin, ymax, zmin, zmax], rig metres), in
 * connected pieces. Inside the endplates each element of a wing is its own piece; the endplates weld them together.
 */
function boxPieces(rig, weld, tris, box) {
  const [x0, x1, y0, y1, z0, z1] = box;
  const inside = (v) => {
    const x = rig.pos[3 * v];
    const y = rig.pos[3 * v + 1];
    const z = rig.pos[3 * v + 2];
    return x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
  };
  const sel = tris.filter((t) => inside(rig.idx[3 * t]) && inside(rig.idx[3 * t + 1]) && inside(rig.idx[3 * t + 2]));
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  for (const t of sel) {
    const a = find(weld[rig.idx[3 * t]]);
    parent.set(find(weld[rig.idx[3 * t + 1]]), a);
    parent.set(find(weld[rig.idx[3 * t + 2]]), a);
    parent.set(a, a);
  }
  const groups = new Map();
  for (const t of sel) {
    const r = find(weld[rig.idx[3 * t]]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  return [...groups.values()]
    .map((g) => ({ tris: g, ...bounds(extract(rig, g)) }))
    .sort((a, b) => b.tris.length - a.tris.length);
}

/** The flap elements of each wing (2026: the two upper elements of the front and the rear wing move) */
function findFlaps(rig, weld, bodyTris) {
  // Rear: main plane, middle and top element between the endplates (inner faces at |x| ~0.565)
  const rear = boxPieces(rig, weld, bodyTris, [-0.556, 0.556, 0.74, 1.0, -2.7, -1.95]).filter((p) => p.tris.length > 5000);
  if (rear.length !== 3) throw new Error(`rear wing: expected 3 elements, found ${rear.length}`);
  rear.sort((a, b) => b.max[2] - a.max[2]); // front to back: main plane first
  // Front: main plane and two flaps, each one piece under the nose, between the endplates (inner faces at |x| ~0.66)
  const front = boxPieces(rig, weld, bodyTris, [-0.645, 0.645, 0.0, 0.335, 1.7, 2.8]).filter((p) => p.tris.length > 5000);
  if (front.length !== 3) throw new Error(`front wing: expected 3 elements, found ${front.length}`);
  front.sort((a, b) => b.max[2] - a.max[2]); // the main plane reaches furthest forward
  const halves = (p) => {
    // Each front flap moves as two halves (FL / FR), split on the centreline, each about its own leading edge
    const l = [];
    const r = [];
    for (const t of p.tris) {
      let x = 0;
      for (let c = 0; c < 3; c++) x += rig.pos[3 * rig.idx[3 * t + c]];
      (x > 0 ? l : r).push(t);
    }
    return [l, r];
  };
  const [f1l, f1r] = halves(front[1]);
  const [f2l, f2r] = halves(front[2]);
  return [
    // _1 the middle element, _2 the top one (it carries the main colour)
    { name: "WING_REAR_1", tris: rear[1].tris, angleDeg: 16, zone: ZONE.secondary },
    { name: "WING_REAR_2", tris: rear[2].tris, angleDeg: 16, zone: ZONE.primary },
    { name: "FRONTWINGMOVING_FL_1", tris: f1l, angleDeg: 10, zone: ZONE.secondary },
    { name: "FRONTWINGMOVING_FL_2", tris: f2l, angleDeg: 10, zone: ZONE.primary },
    { name: "FRONTWINGMOVING_FR_1", tris: f1r, angleDeg: 10, zone: ZONE.secondary },
    { name: "FRONTWINGMOVING_FR_2", tris: f2r, angleDeg: 10, zone: ZONE.primary },
  ];
}

/** Rotation matrix (column-major 3x3 as rows of a flat array helper) about unit axis `d` by `a` radians */
function axisAngle(d, a) {
  const [x, y, z] = d;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  // Row-major
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

const mul3 = (m, v) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]);

/**
 * The hinge of a flap: a straight line fitted through its leading edge (the front-most point of each spanwise slice),
 * and the sign that turns it flatter (trailing edge down, less angle of attack), as X-mode does
 */
function hinge(mesh) {
  const b = bounds(mesh);
  const bins = 24;
  const lead = new Array(bins).fill(null);
  for (let i = 0; i < mesh.pos.length; i += 3) {
    const k = Math.min(bins - 1, Math.floor(((mesh.pos[i] - b.min[0]) / (b.max[0] - b.min[0] + 1e-9)) * bins));
    if (!lead[k] || mesh.pos[i + 2] > lead[k][2]) lead[k] = [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]];
  }
  const pts = lead.filter(Boolean);
  const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length);
  // Principal direction by power iteration on the covariance
  const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => pts.reduce((s, p) => s + (p[i] - c[i]) * (p[j] - c[j]), 0)));
  let d = [1, 0, 0];
  for (let it = 0; it < 50; it++) {
    const n = mul3(cov, d);
    const l = Math.hypot(...n) || 1;
    d = n.map((v) => v / l);
  }
  if (d[0] < 0) d = d.map((v) => -v);
  // Trailing edge: the rear-most vertex; the sign that lowers it
  let te = null;
  for (let i = 0; i < mesh.pos.length; i += 3) if (!te || mesh.pos[i + 2] < te[2]) te = [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]];
  const rel = te.map((v, k) => v - c[k]);
  const up = mul3(axisAngle(d, 0.1), rel)[1] - rel[1];
  return { pivot: c, axis: d, sign: up > 0 ? -1 : 1 };
}

/** Column-major 4x4 of a rotation (row-major 3x3) and a translation */
function matrix4(r, t) {
  return [r[0][0], r[1][0], r[2][0], 0, r[0][1], r[1][1], r[2][1], 0, r[0][2], r[1][2], r[2][2], 0, t[0], t[1], t[2], 1];
}

// ---------------------------------------------------------------------------------------------------------------
// Caps: the open ends a cut leaves
// ---------------------------------------------------------------------------------------------------------------

/**
 * The boundary loops of a set of triangles (edges only one of them uses), as source vertex ids in the direction the
 * triangles run them. A cut leaves one loop per cut end.
 */
function boundaryLoops(rig, weld, tris) {
  const count = new Map();
  const rep = new Map(); // weld id -> a source vertex id
  for (const t of tris) {
    for (let c = 0; c < 3; c++) {
      const a = rig.idx[3 * t + c];
      const b = rig.idx[3 * t + ((c + 1) % 3)];
      const wa = weld[a];
      const wb = weld[b];
      rep.set(wa, a);
      rep.set(wb, b);
      const k = wa < wb ? `${wa},${wb}` : `${wb},${wa}`;
      const e = count.get(k);
      if (e) e.n++;
      else count.set(k, { n: 1, from: wa, to: wb });
    }
  }
  const next = new Map();
  for (const e of count.values()) if (e.n === 1) next.set(e.from, e.to);
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let v = start;
    while (v !== undefined && !seen.has(v)) {
      seen.add(v);
      loop.push(rep.get(v));
      v = next.get(v);
    }
    if (loop.length >= 3 && v === start) loops.push(loop);
  }
  return loops;
}

/** Ear-clips a loop (source vertex ids) flat in its own plane; `flip` reverses the winding. Returns a mesh. */
function capMesh(rig, loop, flip) {
  const P = loop.map((v) => [rig.pos[3 * v], rig.pos[3 * v + 1], rig.pos[3 * v + 2]]);
  // Newell normal: the loop runs counter-clockwise about it
  const n = [0, 0, 0];
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ln = Math.hypot(...n) || 1;
  const N = n.map((v) => v / ln);
  const u = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = [N[1] * u[2] - N[2] * u[1], N[2] * u[0] - N[0] * u[2], N[0] * u[1] - N[1] * u[0]];
  const l1 = Math.hypot(...e1);
  const U = e1.map((v) => v / l1);
  const V = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
  const Q = P.map((p) => [p[0] * U[0] + p[1] * U[1] + p[2] * U[2], p[0] * V[0] + p[1] * V[1] + p[2] * V[2]]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  const idx = [];
  const ring = Q.map((_, i) => i);
  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const ia = ring[(i + ring.length - 1) % ring.length];
      const ib = ring[i];
      const ic = ring[(i + 1) % ring.length];
      if (cross(Q[ia], Q[ib], Q[ic]) <= 1e-12) continue;
      let ear = true;
      for (const j of ring) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(Q[j], Q[ia], Q[ib], Q[ic])) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      idx.push(ia, ib, ic);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate leftovers (collinear runs along a jagged cut): fan the rest
      for (let i = 1; i + 1 < ring.length; i++) idx.push(ring[0], ring[i], ring[i + 1]);
      ring.length = 0;
    }
  }
  if (ring.length === 3) idx.push(ring[0], ring[1], ring[2]);
  if (flip) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  const sgn = flip ? -1 : 1;
  const nrm = new Float32Array(P.length * 3);
  for (let i = 0; i < P.length; i++) nrm.set([N[0] * sgn, N[1] * sgn, N[2] * sgn], 3 * i);
  return { pos: Float32Array.from(P.flat()), nrm, idx: Uint32Array.from(idx) };
}

function merge(meshes) {
  let vCount = 0;
  let iCount = 0;
  for (const m of meshes) {
    vCount += m.pos.length / 3;
    iCount += m.idx.length;
  }
  const pos = new Float32Array(vCount * 3);
  const nrm = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let v = 0;
  let o = 0;
  for (const m of meshes) {
    pos.set(m.pos, v * 3);
    nrm.set(m.nrm, v * 3);
    for (let i = 0; i < m.idx.length; i++) idx[o++] = m.idx[i] + v;
    v += m.pos.length / 3;
  }
  return { pos, nrm, idx };
}

const shift = (m, d) => ({ ...m, pos: m.pos.map((v, i) => v - d[i % 3]) });

// ---------------------------------------------------------------------------------------------------------------
// Paint: the download is one grey, so the livery goes on by zone, each zone its own material
// ---------------------------------------------------------------------------------------------------------------

/**
 * Zones (rig metres; the front axle at z 1.5045, the rear at -1.8955). The game colours the three paint materials
 * with the picked livery (primary, secondary, accent); carbon gets the procedural weave; the rain light glows.
 */
const ZONE = {
  primary: "EXT_PAINT_PRIMARY",
  secondary: "EXT_PAINT_SECONDARY",
  accent: "EXT_PAINT_ACCENT",
  carbon: "EXT_carbon",
  // The cockpit's inside: matte, no weave (the onboard cameras see it from a hand's width away)
  interior: "INT_cockpit",
  light: "EXT_clearled_security",
};

/** Height of the line between the upper (primary) and lower (secondary) bodywork, rising toward the rear */
const splitY = (z) => 0.33 + 0.06 * Math.min(1, Math.max(0, (0.6 - z) / 2.2));
/** Accent pinstripe along that line (m) */
const STRIPE = 0.022;
/** Surfaces facing the road more than this (normal y) are the carbon undersides */
const UNDERCUT = -0.55;
/** The halo: above this, ahead of its rear mount */
const HALO_Y = 0.7;
const HALO_Z = -0.08;
/** The front bulkhead: the side line and its stripe end here */
const NOSE_Z = 1.25;

function zoneOf(c, n) {
  const [x, y, z] = c;
  const ax = Math.abs(x);
  // Floor, plank, diffuser and anything facing the road low down
  if (y < 0.105) return ZONE.carbon;
  if (z < -1.85 && y < 0.36 && ax < 0.62) return ZONE.carbon;
  if (n[1] < UNDERCUT && y < 0.5 && z < 1.7) return ZONE.carbon;
  // Front wing endplates, fins included: secondary with an accent top
  if (z > 1.6 && ax > 0.6 && y < 0.45) return y > 0.29 ? ZONE.accent : ZONE.secondary;
  // Front wing (below the nose): secondary
  if (z > 1.68 && y < 0.345) return ax < 0.15 && y > 0.2 ? ZONE.primary : ZONE.secondary;
  // Suspension, brake ducts and uprights around the axles, outside the chassis
  if (Math.abs(z - 1.5045) < 0.36 && ax > 0.17 && y < 0.68) return ZONE.carbon;
  if (Math.abs(z + 1.8955) < 0.36 && ax > 0.2 && y < 0.62 && y > 0.12) return ZONE.carbon;
  // Rear wing: endplates primary with an accent top, the main plane secondary
  if (z < -1.95 && y > 0.36) {
    if (ax > 0.5) return y > 0.86 ? ZONE.accent : ZONE.primary;
    if (y > 0.74) return ZONE.secondary;
  }
  // Cockpit interior (seat, tub walls inside the opening)
  if (ax < 0.26 && z > -0.22 && z < 0.56 && y < 0.655 && y > 0.2) return ZONE.interior;
  // Halo
  if (y > HALO_Y && z > HALO_Z && z < 0.66 && ax < 0.32) return ZONE.secondary;
  // Nose tip
  if (z > 2.5) return ZONE.accent;
  // Bodywork: primary above the line, an accent pinstripe on it, secondary below; the nose (ahead of the front
  // bulkhead, where the line would only graze its sides) is primary
  if (z > NOSE_Z) return ZONE.primary;
  const s = splitY(z);
  if (y > s + STRIPE) return ZONE.primary;
  if (y > s && ax > 0.1) return ZONE.accent;
  return y > s ? ZONE.primary : ZONE.secondary;
}

/**
 * The lines the zones meet on, as f(p) = 0 with the region they apply in: the body's triangles are long, so without
 * cutting along these the zone edges follow the triangles in a saw-tooth
 */
const ZONE_LINES = [
  { f: (p, n) => n[1] - UNDERCUT, where: (p) => p[1] < 0.5 && p[2] < 1.7 },
  { f: (p) => p[1] - HALO_Y, where: (p) => p[2] > -0.15 && p[2] < 0.7 && Math.abs(p[0]) < 0.34 },
  { f: (p) => p[2] - HALO_Z, where: (p) => p[1] > 0.65 && Math.abs(p[0]) < 0.34 },
  { f: (p) => p[1] - splitY(p[2]), where: (p) => p[1] > 0.2 && p[1] < 0.55 && p[2] < NOSE_Z + 0.05 },
  { f: (p) => p[1] - splitY(p[2]) - STRIPE, where: (p) => p[1] > 0.2 && p[1] < 0.6 && p[2] < NOSE_Z + 0.05 },
  { f: (p) => p[2] - NOSE_Z, where: (p) => p[1] > 0.2 && p[1] < 0.6 && Math.abs(p[0]) < 0.4 },
  { f: (p) => p[1] - 0.29, where: (p) => p[2] > 1.6 && Math.abs(p[0]) > 0.55 },
  { f: (p) => Math.abs(p[0]) - 0.6, where: (p) => p[2] > 1.55 && p[1] < 0.46 && Math.abs(p[0]) > 0.45 },
  { f: (p) => p[2] - 1.6, where: (p) => p[1] < 0.46 && Math.abs(p[0]) > 0.55 },
  { f: (p) => Math.abs(p[0]) - 0.5, where: (p) => p[2] < -1.9 && p[1] > 0.3 && Math.abs(p[0]) > 0.4 },
  { f: (p) => p[1] - 0.86, where: (p) => p[2] < -1.9 && Math.abs(p[0]) > 0.45 },
  { f: (p) => p[2] - 2.5, where: (p) => p[1] > 0.2 },
];

/**
 * Cuts triangles along the zone lines. New vertices are shared by the two triangles either side of a cut edge (so
 * the mesh stays connected for the simplifier) and appended to `rig`, which is returned grown.
 */
function cutAlongZones(rig, tris) {
  const pos = Array.from(rig.pos);
  const nrm = Array.from(rig.nrm);
  let idx = tris.map((t) => [rig.idx[3 * t], rig.idx[3 * t + 1], rig.idx[3 * t + 2]]);
  const P = (v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
  for (const [li, line] of ZONE_LINES.entries()) {
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
      // Rotate so vertex 0 is the one alone on its side
      const lone = f.findIndex((v) => (pos0 === 1 ? v > 0 : v <= 0));
      const [a, b, cc] = [tri[lone], tri[(lone + 1) % 3], tri[(lone + 2) % 3]];
      const [fa, fb, fc] = [f[lone], f[(lone + 1) % 3], f[(lone + 2) % 3]];
      const ab = cut(a, b, fa, fb);
      const ac = cut(a, cc, fa, fc);
      out.push([a, ab, ac], [ab, b, cc], [ab, cc, ac]);
    }
    idx = out;
    void li;
  }
  const grown = { pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx.flat()) };
  return { rig: grown, tris: idx.map((_, i) => i) };
}

/** The rain light: the rear face of the crash structure, under the exhaust */
function rainLight(rig, tris) {
  const facing = tris.filter((t) => {
    const c = centroid(rig, t);
    const n = faceNormal(rig, t);
    return n[2] < -0.85 && Math.abs(c[0]) < 0.12 && c[1] > 0.15 && c[1] < 0.5 && c[2] < -2.0;
  });
  if (!facing.length) return new Set();
  const zMin = Math.min(...facing.map((t) => centroid(rig, t)[2]));
  return new Set(facing.filter((t) => centroid(rig, t)[2] < zMin + 0.015));
}

function centroid(rig, t) {
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = rig.idx[3 * t + k];
    for (let j = 0; j < 3; j++) c[j] += rig.pos[3 * v + j] / 3;
  }
  return c;
}

/** The triangle's vertex normals averaged (what the undercut line is cut on) */
function vertexNormal(rig, t) {
  const n = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = rig.idx[3 * t + k];
    for (let j = 0; j < 3; j++) n[j] += rig.nrm[3 * v + j];
  }
  const l = Math.hypot(...n) || 1;
  return n.map((v) => v / l);
}

function faceNormal(rig, t) {
  const p = [0, 1, 2].map((k) => {
    const v = rig.idx[3 * t + k];
    return [rig.pos[3 * v], rig.pos[3 * v + 1], rig.pos[3 * v + 2]];
  });
  const a = p[1].map((v, j) => v - p[0][j]);
  const b = p[2].map((v, j) => v - p[0][j]);
  const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const l = Math.hypot(...n) || 1;
  return n.map((v) => v / l);
}

// ---------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------

function material(doc, name, color, { metallic = 0, roughness = 0.6 } = {}) {
  return doc
    .createMaterial(name)
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(metallic)
    .setRoughnessFactor(roughness);
}

function addMesh(doc, buffer, name, parts) {
  const mesh = doc.createMesh(name);
  for (const { geo, mat } of parts) {
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(geo.pos).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(geo.nrm).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(geo.idx).setBuffer(buffer))
      .setMaterial(mat);
    mesh.addPrimitive(prim);
  }
  return mesh;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return null;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const debugParts = flag("--debug-parts");
  const steerFrom = flag("--steer-from") ?? STEER_FROM;
  const [srcFile, outArg] = argv;
  if (!srcFile) {
    console.error("usage: node scripts/cars/port_qvist_f1.mjs <f1_2026_concept_polygon_model.glb> [out.glb]");
    process.exit(1);
  }
  const outFile = outArg ?? path.join(ROOT, "public/cars/f12026/model/f12026.glb");
  await MeshoptSimplifier.ready;

  const src = await readSource(srcFile);
  const { list, weld } = pieces(src);
  const parts = classify(list);
  const frame = rigFrame(parts.wheels);
  const rig = toRig(src, frame);
  console.log(`source: ${src.idx.length / 3} triangles; wheelbase ${frame.wheelbase.toFixed(4)} m`);

  const wheels = parts.wheels.map((p) => wheel(rig, p));
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mats = {
    // The paint zones' colours are the livery's, set by the game; these are only what a plain viewer shows
    [ZONE.primary]: material(doc, ZONE.primary, [0.0, 0.32, 0.72], { roughness: 0.5 }),
    [ZONE.secondary]: material(doc, ZONE.secondary, [0.006, 0.009, 0.025], { roughness: 0.5 }),
    [ZONE.accent]: material(doc, ZONE.accent, [0.95, 0.65, 0.0], { roughness: 0.5 }),
    [ZONE.carbon]: material(doc, ZONE.carbon, [0.012, 0.012, 0.013], { roughness: 0.35 }),
    [ZONE.interior]: material(doc, ZONE.interior, [0.006, 0.006, 0.007], { roughness: 1 }),
    [ZONE.light]: material(doc, ZONE.light, [0.3, 0.02, 0.02], { roughness: 0.3 }),
    exhaust: material(doc, "EXT_exhaust", [0.35, 0.33, 0.3], { metallic: 0.8, roughness: 0.35 }),
    mirrorL: material(doc, "mirror_1", [0.6, 0.6, 0.62], { metallic: 1, roughness: 0.05 }),
    mirrorR: material(doc, "mirror_2", [0.6, 0.6, 0.62], { metallic: 1, roughness: 0.05 }),
    rim: material(doc, "EXT_RIM", [0.05, 0.05, 0.055], { metallic: 0.6, roughness: 0.4 }),
    tyre: material(doc, "EXT_TYRE", [0.035, 0.035, 0.035], { roughness: 0.85 }),
  };

  // The cockpit's inside: a weak, fully rough reflection, so the sun at grazing angles leaves it dark
  const specular = doc.createExtension(KHRMaterialsSpecular);
  mats[ZONE.interior].setExtension("KHR_materials_specular", specular.createSpecular().setSpecularFactor(0.35));

  const vf = doc.createNode("VF26");
  const scene = doc.createScene("Scene").addChild(vf);
  void scene;

  // Flaps: cut out, both ends capped (the flap's and the stub's left on the endplate), hinged on the leading edge
  const flaps = findFlaps(rig, weld, parts.body.tris);
  const flapTris = new Set(flaps.flatMap((f) => f.tris));
  const bodyTris = parts.body.tris.filter((t) => !flapTris.has(t));
  const ratio = BUDGET.body / parts.body.tris.length;
  const stubCaps = [];
  const flapNodes = [];
  for (const f of flaps) {
    const loops = boundaryLoops(rig, weld, f.tris);
    const caps = loops.map((l) => capMesh(rig, l, true));
    stubCaps.push(...loops.map((l) => capMesh(rig, l, false)));
    const mesh = merge([extract(rig, f.tris), ...caps]);
    const h = hinge(mesh);
    // Caps face away from the flap
    const fc = bounds(mesh);
    const mid = [0, 1, 2].map((k) => (fc.min[k] + fc.max[k]) / 2);
    const outward = caps.every((c) => {
      const cb = bounds(c);
      const d = [0, 1, 2].map((k) => (cb.min[k] + cb.max[k]) / 2 - mid[k]);
      return d[0] * c.nrm[0] + d[1] * c.nrm[1] + d[2] * c.nrm[2] > 0;
    });
    if (!outward) console.warn(`  ${f.name}: a cap faces into the flap`);
    const open = axisAngle(h.axis, (h.sign * f.angleDeg * Math.PI) / 180);
    const ident = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const node = doc
      .createNode(f.name)
      .setTranslation(h.pivot)
      .setMesh(addMesh(doc, buffer, f.name, [{ geo: shift(simplify(mesh, ratio), h.pivot), mat: mats[f.zone] }]))
      .setExtras({ aeroClosed: matrix4(ident, h.pivot), aeroOpen: matrix4(open, h.pivot) });
    flapNodes.push(node);
    console.log(`  ${f.name}: ${f.tris.length} tris, ${loops.length} cut ends, hinge ${h.axis.map((v) => v.toFixed(3))}`);
  }

  // Body, one mesh per zone, each simplified with its borders kept so the zones still meet
  const cutBody = cutAlongZones(rig, [...bodyTris, ...parts.other.flatMap((p) => p.tris)]);
  const light = rainLight(cutBody.rig, cutBody.tris);
  const byZone = new Map();
  for (const t of cutBody.tris) {
    const z = light.has(t) ? ZONE.light : zoneOf(centroid(cutBody.rig, t), vertexNormal(cutBody.rig, t));
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z).push(t);
  }
  const bodyParts = [];
  const cutRatio = BUDGET.body / (parts.body.tris.length + (cutBody.tris.length - bodyTris.length));
  for (const [z, tris] of byZone) {
    const extra = z === ZONE.secondary ? stubCaps : [];
    bodyParts.push({ geo: simplify(merge([extract(cutBody.rig, tris), ...extra]), cutRatio, { lockBorder: true }), mat: mats[z] });
    console.log(`  ${z}: ${tris.length} tris`);
  }
  if (parts.exhaust) bodyParts.push({ geo: simplify(extract(rig, parts.exhaust.tris), 0.3), mat: mats.exhaust });
  for (const p of parts.mirrors) {
    const geo = extract(rig, p.tris);
    bodyParts.push({ geo, mat: bounds(geo).min[0] > 0 ? mats.mirrorL : mats.mirrorR });
  }
  const body = doc.createNode("BODY").setMesh(addMesh(doc, buffer, "BODY", bodyParts));
  for (const n of flapNodes) body.addChild(n);
  vf.addChild(body);

  // Wheels
  const wheelCentres = {};
  const tyreRadius = {};
  for (const w of wheels) {
    const name = WHEEL_NAMES[w.corner];
    wheelCentres[name] = w.centre;
    const node = doc.createNode(name).setTranslation(w.centre);
    const rim = simplify(w.rim, BUDGET.rim);
    const tyre = simplify(w.tyre, BUDGET.tyre);
    tyreRadius[name] = bounds(tyre).max[1];
    node.addChild(doc.createNode(`${name}_RIM`).setMesh(addMesh(doc, buffer, `${name}_RIM`, [{ geo: rim, mat: mats.rim }])));
    node.addChild(doc.createNode(`${name}_TYRE`).setMesh(addMesh(doc, buffer, `${name}_TYRE`, [{ geo: tyre, mat: mats.tyre }])));
    vf.addChild(node);
  }
  if (Object.keys(wheelCentres).length !== 4) throw new Error(`wheel corners: ${Object.keys(wheelCentres)}`);

  // Steering wheel (STEER_BASE: rim, paddles, dials, display, shift lights) and cameras from the AMR26 body
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  await MeshoptDecoder.ready;
  const amr = await io.read(steerFrom);
  const amrRoot = amr.getRoot().listNodes().find((n) => n.getName() === "VF26");
  const steerSrc = amr.getRoot().listNodes().find((n) => n.getName() === "STEER_BASE");
  if (!amrRoot || !steerSrc) throw new Error(`${steerFrom}: no VF26 / STEER_BASE`);
  const subtree = [];
  const walk = (n) => {
    subtree.push(n);
    n.listChildren().forEach(walk);
  };
  walk(steerSrc);
  const copied = copyToDocument(doc, amr, subtree);
  const steer = copied.get(steerSrc);
  // Into this document's one buffer
  for (const a of doc.getRoot().listAccessors()) a.setBuffer(buffer);
  for (const b of doc.getRoot().listBuffers()) if (b !== buffer) b.dispose();
  body.addChild(steer);
  const amrExtras = amrRoot.getExtras();
  // The AMR26's cameras as they were (the front axle is where it had it)
  const cameras = structuredClone(amrExtras.cameras);

  vf.setExtras({
    wheelCentres,
    tyreRadius,
    steerBase: amrExtras.steerBase,
    cameras,
    helmet: { pos: HELMET_POS },
    liveryMask: false,
    source: {
      title: "F1 2026 concept (polygon model)",
      author: "Qvist_designs",
      url: "https://sketchfab.com/3d-models/f1-2026-concept-polygon-model-ea3bde709b1e4dc9b0ec8557d106ed42",
      license: "CC BY 4.0",
      changes:
        "Re-oriented to metres; simplified; split into body, wheels and tyres; wing flaps cut free; painted in livery zones; the AM26's steering wheel added",
    },
  });

  await doc.transform(prune({ keepExtras: true }));
  let tris = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount() / 3;
  await io.write(outFile, doc);
  console.log(`wrote ${path.relative(process.cwd(), outFile)}: ${tris} triangles`);
  for (const [k, v] of Object.entries(wheelCentres)) console.log(`  ${k} centre ${v.map((x) => x.toFixed(4))} tyre r ${tyreRadius[k].toFixed(4)}`);

  if (debugParts) {
    // Every piece as its own node, unsimplified, for inspection
    const d = new Document();
    const b = d.createBuffer();
    const colours = [[0.9, 0.2, 0.2], [0.2, 0.8, 0.3], [0.2, 0.4, 0.9], [0.9, 0.8, 0.2], [0.8, 0.3, 0.9], [0.2, 0.9, 0.9]];
    const sc = d.createScene();
    const add = (name, geo, i) => sc.addChild(d.createNode(name).setMesh(addMesh(d, b, name, [{ geo, mat: material(d, name, colours[i % colours.length]) }])));
    wheels.forEach((w, i) => {
      add(`${w.corner}_tyre`, { ...w.tyre, pos: w.tyre.pos.map((v, j) => v + w.centre[j % 3]) }, 2 * i);
      add(`${w.corner}_rim`, { ...w.rim, pos: w.rim.pos.map((v, j) => v + w.centre[j % 3]) }, 2 * i + 1);
    });
    await io.write(debugParts, d);
  }
}

await main();
