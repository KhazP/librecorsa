/**
 * Ports Qvist Designs' "F1 2026 concept (polygon model)" (CC BY 4.0, https://qvistdesigns.framer.website/) to the 2026
 * Prototype's body, in the layout `src/lib/vf26-car-model.ts` reads:
 *
 *   node scripts/cars/port_qvist_f1.mjs <f1_2026_concept_polygon_model.glb> [out.glb] [--debug-parts <file.glb>]
 *
 * Output (default `public/cars/f12026/model/f12026.glb`), metres, +X left, +Y up, +Z forward, tyres on y = 0, the
 * front axle at z = 1.5045 (where the AM26 body had it, so the cameras it shares stay comparable):
 *   VF26 (extras: wheelCentres, cameras, liveryMask: false, source)
 *     BODY        the bodywork, one mesh per material; every vertex of the body, the flaps, the arms and the
 *                 drums carries `_OCCLUSION`: how much of the sky it sees past the rest of the car (1 = all of it)
 *       ARM_xx_n  a suspension arm, in its own frame at its root (extras `arm`: kind, tip)
 *     SUSP_xx     a brake drum with its vanes: turns and travels with the wheel
 *     WHEEL_xx    hub pivot at the tread centre; children WHEEL_xx_RIM, WHEEL_xx_TYRE (one primitive)
 *
 * The download is one CAD shell exported as eleven 65k-vertex chunks, with no UVs, one grey material and constant
 * vertex colours. Its separate pieces are found by shared vertex positions: the four wheels, two mirror glasses and
 * the exhaust; everything else is one welded body. Each wheel splits into tyre and rim by radius. Every piece is
 * simplified on its own with meshoptimizer (attribute seams kept), and the source normals are kept.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { copyToDocument, prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the AM26 body had its front axle (m); the porter puts this model's there too */
const FRONT_AXLE_Z = 1.5045;
/** Tyre / rim boundary (m from the axle): the rim's outer lip ends at ~0.245, the tyre's bead starts at ~0.255 */
const TYRE_MIN_RADIUS = 0.25;

/** Triangle budgets after simplification */
const BUDGET = { body: 100_000, rim: 5_000, tyre: 4_000, small: 1.0 };
/** The arms and drums keep the body's share of their triangles, the thin arms half as many again, and at least these */
const SUSPENSION_MIN_TRIS = { arm: 400, drum: 1_500 };

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
    // The chunks sit under the download's root -90 degree X turn; only that is expected (the axes below undo it)
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
/** A mesh as a part in a node at `origin`, remembered where it is in the model's frame */
const flapPart = (mesh, origin, mat) => ({ geo: shift(mesh, origin), mat, at: mesh });

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
  return cutAlong(rig, tris, ZONE_LINES);
}

/** Cuts triangles along `lines` (each f(p, n) = 0 where `where(centroid)` holds), as `cutAlongZones` does */
function cutAlong(rig, tris, lines) {
  const pos = Array.from(rig.pos);
  const nrm = Array.from(rig.nrm);
  let idx = tris.map((t) => [rig.idx[3 * t], rig.idx[3 * t + 1], rig.idx[3 * t + 2]]);
  const P = (v) => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
  for (const [li, line] of lines.entries()) {
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

/**
 * The cockpit well. The concept's cockpit is a shallow tray: its flat floor sits at ~0.58 m, above the bottom of the
 * steering wheel (0.52 m), so the onboard cameras saw the wheel sunk into it. The floor comes out and the tray's
 * walls carry on down to `WELL_FLOOR_Y`, closed by a floor there, all in the dark cockpit material.
 */
const WELL_FLOOR_Y = 0.15;

function isTrayFloor(rig, t) {
  const c = centroid(rig, t);
  return vertexNormal(rig, t)[1] > 0.9 && c[1] > 0.54 && c[1] < 0.6 && Math.abs(c[0]) < 0.27 && c[2] > -0.3 && c[2] < 0.62;
}

/** Walls from the tray floor's outline down to the well floor, facing in, and that floor; one mesh */
function cockpitWell(rig, loop) {
  const top = loop.map((v) => [rig.pos[3 * v], rig.pos[3 * v + 1], rig.pos[3 * v + 2]]);
  const mid = [0, 2].map((k) => top.reduce((a, p) => a + p[k], 0) / top.length);
  const pos = [];
  const nrm = [];
  const idx = [];
  for (let i = 0; i < top.length; i++) {
    const a = top[i];
    const b = top[(i + 1) % top.length];
    const quad = [a, b, [b[0], WELL_FLOOR_Y, b[2]], [a[0], WELL_FLOOR_Y, a[2]]];
    // Facing the well's middle
    let n = [b[2] - a[2], 0, -(b[0] - a[0])];
    const l = Math.hypot(n[0], n[2]) || 1;
    n = [n[0] / l, 0, n[2] / l];
    const inward = (mid[0] - (a[0] + b[0]) / 2) * n[0] + (mid[1] - (a[2] + b[2]) / 2) * n[2] > 0;
    if (!inward) n = [-n[0], 0, -n[2]];
    const base = pos.length / 3;
    for (const q of quad) {
      pos.push(...q);
      nrm.push(...n);
    }
    // Winding to match the normal
    const e1 = quad[1].map((v, k) => v - quad[0][k]);
    const e2 = quad[2].map((v, k) => v - quad[0][k]);
    const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (fn[0] * n[0] + fn[2] * n[2] >= 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  // The floor: the outline at the well's depth, facing up
  const flat = { pos: Float32Array.from(top.flatMap((p) => [p[0], WELL_FLOOR_Y, p[2]])), idx: [] };
  let floor = capMesh(flat, top.map((_, i) => i), false);
  if (floor.nrm[1] < 0) floor = capMesh(flat, top.map((_, i) => i), true);
  return merge([{ pos: Float32Array.from(pos), nrm: Float32Array.from(nrm), idx: Uint32Array.from(idx) }, floor]);
}

/** Vertices at the same position share an id (for boundary loops on a mesh with seams) */
function weldMap(rig) {
  const key = new Map();
  const weld = new Int32Array(rig.pos.length / 3);
  for (let i = 0; i < weld.length; i++) {
    const k = `${rig.pos[3 * i]},${rig.pos[3 * i + 1]},${rig.pos[3 * i + 2]}`;
    let j = key.get(k);
    if (j === undefined) key.set(k, (j = key.size));
    weld[i] = j;
  }
  return weld;
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
// Suspension: the brake drums and the arms are cut out of the welded body
// ---------------------------------------------------------------------------------------------------------------

/** The arms are found where they cross a plane this far inboard of a drum's inner face (m) */
const ARM_PLANE_IN = 0.16;
/** Their axis and thickness are measured on the planes this far inboard and outboard of that one (m) */
const ARM_BAND = [0.05, 0.03];
/** Bodywork below this is floor, not suspension (m) */
const ARM_MIN_Y = 0.2;
/** An arm ends where the surface around its axis reaches this many times its own thickness: the chassis, a fairing */
const ARM_FLARE = 1.3;
/** Step (m) an arm is followed toward the chassis in */
const ARM_STEP = 0.005;
/** A drum: within this of the axle (m) */
const DRUM_RADIUS = 0.23;
/** Nothing inboard of this (m from the centreline) is suspension */
const ARM_MIN_X = 0.1;
/** How far an arm's open ends reach into the chassis and into the drum (m), so no gap opens when it moves */
const ARM_REACH = { root: 0.03, tip: 0.07 };
/** A point on the front track rods (|x|, y, z): they turn with the wheels, the wishbones and the pushrod do not */
const TRACK_ROD = [0.44, 0.345, 1.63];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const along = (o, a, t) => [o[0] + a[0] * t, o[1] + a[1] * t, o[2] + a[2] * t];
const vert = (rig, v) => [rig.pos[3 * v], rig.pos[3 * v + 1], rig.pos[3 * v + 2]];
/** Distance of `p` from the line through `o` along the unit `a` */
const offAxis = (p, o, a) => {
  const d = sub(p, o);
  const t = dot(d, a);
  return Math.hypot(d[0] - a[0] * t, d[1] - a[1] * t, d[2] - a[2] * t);
};

/**
 * Whether `p` is within an arm's section, `grow` times as wide and as thick plus `margin` (m). The section is a box
 * across the axis (`u` along its chord, `v` through its thickness), since the arms are flat blades, not tubes.
 */
const inSection = (p, l, grow, margin) => {
  const d = sub(p, l.o);
  return Math.abs(dot(d, l.u)) <= l.hu * grow + margin && Math.abs(dot(d, l.v)) <= l.hv * grow + margin;
};

/** Triangles by the welded vertices they use, for walking from one to its neighbours */
function trianglesAround(rig, weld, tris) {
  const around = new Map();
  for (const t of tris) {
    for (let c = 0; c < 3; c++) {
      const w = weld[rig.idx[3 * t + c]];
      let l = around.get(w);
      if (!l) around.set(w, (l = []));
      l.push(t);
    }
  }
  return around;
}

/** Every triangle reached from `seeds` through shared vertices over triangles `open` lets in (the seeds included) */
function flood(rig, weld, around, seeds, open) {
  const seen = new Set(seeds);
  const queue = [...seeds];
  while (queue.length) {
    const t = queue.pop();
    for (let c = 0; c < 3; c++) {
      for (const u of around.get(weld[rig.idx[3 * t + c]]) ?? []) {
        if (seen.has(u) || !open(u)) continue;
        seen.add(u);
        queue.push(u);
      }
    }
  }
  return seen;
}

/** `tris` in connected groups */
function groupsOf(rig, weld, around, tris) {
  const inSet = new Set(tris);
  const left = new Set(tris);
  const groups = [];
  for (const t of tris) {
    if (!left.has(t)) continue;
    const g = flood(rig, weld, around, [t], (u) => inSet.has(u));
    for (const u of g) left.delete(u);
    groups.push([...g]);
  }
  return groups;
}

/**
 * Where `tris` cross the plane n . p = d: one segment a triangle, its ends `p` and `q` with the welded edges they
 * lie on (`kp`, `kq`), which neighbouring segments share
 */
function planeCuts(rig, weld, tris, n, d) {
  const f = (v) => n[0] * rig.pos[3 * v] + n[1] * rig.pos[3 * v + 1] + n[2] * rig.pos[3 * v + 2] - d;
  const segs = [];
  for (const t of tris) {
    const v = [rig.idx[3 * t], rig.idx[3 * t + 1], rig.idx[3 * t + 2]];
    const fv = v.map(f);
    const ends = [];
    for (let c = 0; c < 3; c++) {
      const b = (c + 1) % 3;
      if (fv[c] < 0 === fv[b] < 0) continue;
      const s = fv[c] / (fv[c] - fv[b]);
      const pa = vert(rig, v[c]);
      const pb = vert(rig, v[b]);
      const wa = weld[v[c]];
      const wb = weld[v[b]];
      ends.push({ at: [0, 1, 2].map((k) => pa[k] + s * (pb[k] - pa[k])), key: wa < wb ? `${wa},${wb}` : `${wb},${wa}` });
    }
    if (ends.length === 2) segs.push({ p: ends[0].at, q: ends[1].at, kp: ends[0].key, kq: ends[1].key });
  }
  return segs;
}

/** The middle of a section's outline: its segments' midpoints weighed by their lengths */
function sectionCentre(segs) {
  const c = [0, 0, 0];
  let total = 0;
  for (const { p, q } of segs) {
    const l = Math.hypot(...sub(p, q));
    total += l;
    for (let k = 0; k < 3; k++) c[k] += (l * (p[k] + q[k])) / 2;
  }
  return c.map((v) => v / (total || 1));
}

/** |x| of a drum's inner face: the largest flat, axle-facing area inboard of the wheel's middle */
function drumFace(rig, tris, w) {
  const [cx, cy, cz] = w.centre;
  const s = Math.sign(cx);
  const bins = new Map();
  for (const t of tris) {
    const v = [rig.idx[3 * t], rig.idx[3 * t + 1], rig.idx[3 * t + 2]].map((i) => vert(rig, i));
    if (!v.every((p) => Math.hypot(p[1] - cy, p[2] - cz) < DRUM_RADIUS - 0.01 && s * p[0] > Math.abs(cx) - 0.4 && s * p[0] < Math.abs(cx) - 0.05)) continue;
    const n = cross3(sub(v[1], v[0]), sub(v[2], v[0]));
    const area = Math.hypot(...n) / 2;
    if (Math.abs(n[0]) < 0.98 * 2 * area) continue;
    const k = Math.round(s * v[0][0] * 200);
    const b = bins.get(k) ?? { area: 0, x: 0 };
    b.area += area;
    b.x += area * s * v[0][0];
    bins.set(k, b);
  }
  const best = [...bins.values()].sort((a, b) => b.area - a.area)[0];
  if (!best || best.area < 0.05) throw new Error(`${w.corner}: no drum face found`);
  return best.x / best.area;
}

/**
 * The arms of one corner, each as a straight axis: body triangles crossing the mid plane, in connected members, each
 * member's axis through the middles of its two sections either side, its thickness the furthest those sections reach
 * from it. An arm is followed along its axis toward the chassis until the surface around it widens (`ARM_FLARE`):
 * there it is cut, and there it turns.
 */
function findLegs(rig, weld, tris, w) {
  const [, , cz] = w.centre;
  const s = Math.sign(w.centre[0]);
  const n = [s, 0, 0];
  const xMid = w.xFace - ARM_PLANE_IN;
  const xA = xMid - ARM_BAND[0];
  const xB = xMid + ARM_BAND[1];
  const region = tris.filter((t) => {
    const c = centroid(rig, t);
    return s * c[0] > ARM_MIN_X - 0.05 && Math.abs(c[2] - cz) < 0.9;
  });
  const slab = region.filter((t) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = 0; c < 3; c++) {
      const p = vert(rig, rig.idx[3 * t + c]);
      if (Math.abs(p[2] - cz) > 0.7 || p[1] > 0.8) return false;
      lo = Math.min(lo, s * p[0]);
      hi = Math.max(hi, s * p[0]);
    }
    return lo < xB && hi > xA;
  });
  const around = trianglesAround(rig, weld, slab);
  const legs = [];
  for (const member of groupsOf(rig, weld, around, slab)) {
    const a0 = planeCuts(rig, weld, member, n, xA);
    const b0 = planeCuts(rig, weld, member, n, xB);
    if (!a0.length || !b0.length) continue;
    const pts = [...a0, ...b0].flatMap((g) => [g.p, g.q]);
    if (Math.min(...pts.map((p) => p[1])) < ARM_MIN_Y) continue;
    const o = sectionCentre(a0);
    const a = unit(sub(sectionCentre(b0), o));
    // It has to point at the drum
    const atFace = along(o, a, (w.xFace - s * o[0]) / (s * a[0]));
    if (!(s * a[0] > 0.3) || Math.hypot(atFace[1] - w.centre[1], atFace[2] - cz) > DRUM_RADIUS + 0.05) continue;
    // The section's chord: the direction across the axis its points spread most in
    const across = pts.map((p) => {
      const d = sub(p, o);
      const t = dot(d, a);
      return [d[0] - a[0] * t, d[1] - a[1] * t, d[2] - a[2] * t];
    });
    const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => across.reduce((sum, d) => sum + d[i] * d[j], 0)));
    let u = unit(cross3(a, [0, 1, 0]));
    for (let it = 0; it < 60; it++) u = unit(mul3(cov, u));
    const v = cross3(a, u);
    const leg = { corner: w.corner, s, o, a, u, v, hu: Math.max(...across.map((d) => Math.abs(dot(d, u)))), hv: Math.max(...across.map((d) => Math.abs(dot(d, v)))) };
    const within = (p) => inSection(p, leg, ARM_FLARE, 0.004);
    const near = region.filter((t) => [0, 1, 2].some((c) => inSection(vert(rig, rig.idx[3 * t + c]), leg, 2.5, 0.05)));
    // How far the arm runs on its own along its axis, toward the chassis (dir -1) or the drum (+1), from the first
    // section: to the last plane on which its outline closes within the limit, before the surface carries on past it
    const follow = (dir, end) => {
      let last = 0;
      for (let t = dir * ARM_STEP; dir * t < end; t += dir * ARM_STEP) {
        const segs = planeCuts(rig, weld, near, a, dot(o, a) + t);
        const byKey = new Map();
        segs.forEach((g, i) => {
          for (const k of [g.kp, g.kq]) byKey.set(k, [...(byKey.get(k) ?? []), i]);
        });
        const own = segs.map((g, i) => (inSection(g.p, leg, 1.05, 0.002) && inSection(g.q, leg, 1.05, 0.002) ? i : -1)).filter((i) => i >= 0);
        const seen = new Set(own);
        const queue = [...own];
        let leaving = false;
        while (queue.length && !leaving) {
          const g = segs[queue.pop()];
          if (!within(g.p) || !within(g.q)) leaving = true;
          for (const k of [g.kp, g.kq]) {
            for (const j of byKey.get(k)) {
              if (seen.has(j)) continue;
              seen.add(j);
              queue.push(j);
            }
          }
        }
        if (!own.length || leaving) return { t: last, stopped: true };
        last = t;
      }
      return { t: last, stopped: false };
    };
    const tRoot = follow(-1, 0.9).t;
    // On an axle that does not steer the arms end where they join the drum's own structure (winglets, the other leg
    // of a wishbone): the drum only rises and falls there, so those stay on it. A steered drum turns about the arms'
    // ends, so there the arms run to its face and pass through it.
    const toFace = (w.xFace - s * o[0]) / (s * a[0]) - 0.01;
    const out = w.corner[1] === "F" ? null : follow(1, toFace);
    const tTip = out?.stopped ? out.t : null;
    legs.push({ ...leg, tRoot, pivot: along(o, a, tRoot), end: tTip === null ? null : along(o, a, tTip) });
  }
  return legs;
}

/** The planes the suspension is cut on: each arm's root and (where it has one) outer end, across its axis, and each drum's inner face */
function suspensionLines(legs, wheels) {
  const lines = [];
  for (const l of legs) {
    for (const at of [l.pivot, l.end]) {
      if (!at) continue;
      lines.push({
        f: (p) => dot(sub(p, at), l.a),
        where: (c) => Math.sign(c[0]) === l.s && inSection(c, l, ARM_FLARE, 0.012) && Math.abs(dot(sub(c, at), l.a)) < 0.45,
      });
    }
  }
  for (const w of wheels) {
    const [cx, cy, cz] = w.centre;
    const s = Math.sign(cx);
    lines.push({ f: (p) => s * p[0] - w.xCut, where: (c) => s * c[0] > ARM_MIN_X && Math.hypot(c[1] - cy, c[2] - cz) < 0.34 });
  }
  return lines;
}

/** A wall from a cut's outline (`loop`, as `boundaryLoops` gives it) out along `e`: an open end's reach past the cut */
function skirt(rig, loop, e) {
  const n = loop.length;
  const pos = new Float32Array(n * 6);
  const nrm = new Float32Array(n * 6);
  const idx = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const p = vert(rig, loop[i]);
    const q = [rig.nrm[3 * loop[i]], rig.nrm[3 * loop[i] + 1], rig.nrm[3 * loop[i] + 2]];
    pos.set(p, 3 * i);
    pos.set([p[0] + e[0], p[1] + e[1], p[2] + e[2]], 3 * (i + n));
    nrm.set(q, 3 * i);
    nrm.set(q, 3 * (i + n));
    const j = (i + 1) % n;
    idx.set([j, i, i + n, j, i + n, j + n], 6 * i);
  }
  return { pos, nrm, idx };
}

/** `mesh` in the frame at `origin` whose axes are the unit `ex`, `ey`, `ez`, and that frame's rotation (x, y, z, w) */
function inFrame(mesh, origin, [ex, ey, ez]) {
  const pos = new Float32Array(mesh.pos.length);
  const nrm = new Float32Array(mesh.nrm.length);
  for (let i = 0; i < pos.length; i += 3) {
    const p = [mesh.pos[i] - origin[0], mesh.pos[i + 1] - origin[1], mesh.pos[i + 2] - origin[2]];
    const q = [mesh.nrm[i], mesh.nrm[i + 1], mesh.nrm[i + 2]];
    pos.set([dot(p, ex), dot(p, ey), dot(p, ez)], i);
    nrm.set([dot(q, ex), dot(q, ey), dot(q, ez)], i);
  }
  const [m00, m10, m20] = ex;
  const [m01, m11, m21] = ey;
  const [m02, m12, m22] = ez;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / k, (m02 - m20) / k, (m10 - m01) / k, k / 4];
  } else if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [k / 4, (m01 + m10) / k, (m02 + m20) / k, (m21 - m12) / k];
  } else if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / k, k / 4, (m12 + m21) / k, (m02 - m20) / k];
  } else {
    const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / k, (m12 + m21) / k, k / 4, (m10 - m01) / k];
  }
  return { geo: { pos, nrm, idx: mesh.idx }, rotation: q };
}

/** Axes with z along the unit `ez` and x level */
function axesAlong(ez) {
  const ex = unit(Math.abs(ez[1]) > 0.95 ? cross3([0, 0, 1], ez) : cross3([0, 1, 0], ez));
  return [ex, cross3(ez, ex), ez];
}

/**
 * Splits the body (already cut on `suspensionLines`) into the arms, the drums and the rest. Per corner: the arms are
 * what the mid plane's members reach between their roots and the drum's face; members that meet before the face
 * (a wishbone's two legs) are one part. The drum is what is left joined to the wheel's side of the face: the drum,
 * its vanes and winglets. The holes both leave are capped: in the chassis, and across the drum's face, which the arms
 * then pass through.
 */
function suspension(rig, weld, tris, wheels, legs) {
  const around = trianglesAround(rig, weld, tris);
  const gone = new Set();
  const arms = [];
  const hubs = [];
  const bodyCaps = [];
  for (const w of wheels) {
    const [cx, cy, cz] = w.centre;
    const s = Math.sign(cx);
    const mine = legs.filter((l) => l.corner === w.corner);
    const xMid = w.xFace - ARM_PLANE_IN;
    // Each cut's outline: the welded vertices on its plane around the arm's own axis. Another arm crossing the same
    // plane has an outline of its own, further from the axis, and is left alone.
    const cuts = mine.flatMap((l) => [{ l, at: l.pivot, side: 1 }, ...(l.end ? [{ l, at: l.end, side: -1 }] : [])]);
    for (const cut of cuts) {
      const on = new Map();
      const here = [];
      for (const t of tris) {
        let any = false;
        for (let c = 0; c < 3; c++) {
          const v = rig.idx[3 * t + c];
          if (Math.sign(rig.pos[3 * v]) !== s) continue;
          const p = vert(rig, v);
          if (Math.abs(dot(sub(p, cut.at), cut.l.a)) > 2e-5 || !inSection(p, cut.l, ARM_FLARE, 0.006)) continue;
          on.set(weld[v], p);
          any = true;
        }
        if (any) here.push(t);
      }
      const parent = new Map([...on.keys()].map((k) => [k, k]));
      const find = (x) => {
        while (parent.get(x) !== x) x = parent.get(x);
        return x;
      };
      for (const t of here) {
        const ws = [0, 1, 2].map((c) => weld[rig.idx[3 * t + c]]).filter((k) => on.has(k));
        for (let i = 1; i < ws.length; i++) parent.set(find(ws[i]), find(ws[0]));
      }
      const outlines = new Map();
      for (const k of on.keys()) outlines.set(find(k), [...(outlines.get(find(k)) ?? []), k]);
      const off = (ks) => Math.hypot(...sub([0, 1, 2].map((j) => ks.reduce((sum, k) => sum + on.get(k)[j], 0) / ks.length), cut.at));
      const own = [...outlines.values()].sort((a, b) => off(a) - off(b))[0] ?? [];
      cut.outline = new Set(own);
    }
    // A triangle on the far side of an arm's root (or of its outer end) that touches the cut's outline: the walk
    // stops there
    const behindRoot = (t) => {
      const vs = [0, 1, 2].map((c) => rig.idx[3 * t + c]);
      return cuts.some((cut) => vs.some((v) => cut.outline.has(weld[v])) && vs.every((v) => cut.side * dot(sub(vert(rig, v), cut.at), cut.l.a) < 2e-5));
    };
    const open = (t) => {
      const c = centroid(rig, t);
      return s * c[0] < w.xCut && s * c[0] > ARM_MIN_X && Math.abs(c[2] - cz) < 0.9 && !behindRoot(t);
    };
    const legOf = new Map();
    for (const t of tris) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let c = 0; c < 3; c++) {
        const x = s * rig.pos[3 * rig.idx[3 * t + c]];
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      if (lo >= xMid || hi < xMid || !open(t)) continue;
      const cut = planeCuts(rig, weld, [t], [s, 0, 0], xMid)[0];
      if (!cut) continue;
      const m = [(cut.p[0] + cut.q[0]) / 2, (cut.p[1] + cut.q[1]) / 2, (cut.p[2] + cut.q[2]) / 2];
      const i = mine.findIndex((l) => inSection(m, l, 1.05, 0.01));
      if (i >= 0) legOf.set(t, i);
    }
    const reached = flood(rig, weld, around, [...legOf.keys()], open);
    const partsHere = [];
    for (const g of groupsOf(rig, weld, around, [...reached])) {
      const own = [...new Set(g.filter((t) => legOf.has(t)).map((t) => legOf.get(t)))].map((i) => mine[i]);
      if (!own.length) continue;
      const describe = () => {
        const b = bounds(extract(rig, g));
        return `${g.length} tris, ${b.min.map((v) => v.toFixed(2))} to ${b.max.map((v) => v.toFixed(2))}`;
      };
      const ended = own.some((l) => l.end);
      const atFace = g.some((t) =>
        [0, 1, 2].some((c) => {
          const p = vert(rig, rig.idx[3 * t + c]);
          return s * p[0] > w.xCut - 0.001 && Math.hypot(p[1] - cy, p[2] - cz) < DRUM_RADIUS + 0.03;
        })
      );
      if (!ended && !atFace) continue;
      if (own.length > (ended ? 1 : 2)) throw new Error(`${w.corner}: ${own.length} arms meet in one part (${describe()})`);
      for (const t of g) gone.add(t);
      const loops = boundaryLoops(rig, weld, g);
      const mean = (l, f) => l.reduce((sum, v) => sum + f(vert(rig, v)), 0) / l.length;
      const tips = loops.filter((l) => (ended ? Math.abs(mean(l, (p) => dot(sub(p, own[0].end), own[0].a))) < 0.004 : mean(l, (p) => s * p[0]) > w.xCut - 0.002));
      const roots = loops.filter((l) => !tips.includes(l));
      // An arm with a closed outer end stops short of the drum (a fairing beside it): its end is its furthest point
      let tip;
      if (tips.length) {
        const tipPts = tips.flat().map((v) => vert(rig, v));
        tip = [0, 1, 2].map((k) => tipPts.reduce((sum, p) => sum + p[k], 0) / tipPts.length);
      } else {
        if (own.length > 1) throw new Error(`${w.corner}: a wishbone has no outer end (${describe()})`);
        let far = -Infinity;
        for (const t of g) for (let c = 0; c < 3; c++) far = Math.max(far, dot(sub(vert(rig, rig.idx[3 * t + c]), own[0].o), own[0].a));
        tip = along(own[0].o, own[0].a, far);
      }
      const skirts = tips.map((l) => skirt(rig, l, ended ? own[0].a.map((v) => v * ARM_REACH.root) : [s * ARM_REACH.tip, 0, 0]));
      for (const l of roots) {
        const pts = l.map((v) => vert(rig, v));
        const c = [0, 1, 2].map((k) => pts.reduce((sum, p) => sum + p[k], 0) / pts.length);
        const leg = own.map((x) => ({ x, d: Math.hypot(...sub(c, x.pivot)) })).sort((a, b) => a.d - b.d)[0];
        // Seams the download's own triangles leave open along an arm are not cut ends
        if (leg.d > 0.08) continue;
        skirts.push(skirt(rig, l, leg.x.a.map((v) => -v * ARM_REACH.root)));
        bodyCaps.push(capMesh(rig, l, false));
      }
      const trackRod = own.length === 1 && cz > 0 && offAxis([s * TRACK_ROD[0], TRACK_ROD[1], TRACK_ROD[2]], own[0].o, own[0].a) < 0.03;
      const kind = own.length === 2 ? "wishbone" : trackRod ? "trackrod" : "link";
      const pivot = own[0].pivot;
      const ez = unit(sub(own.length === 2 ? own[1].pivot : tip, pivot));
      partsHere.push({ corner: w.corner, kind, pivot, tip, axes: axesAlong(ez), mesh: merge([extract(rig, g), ...skirts]), faceCaps: tips.map((l) => capMesh(rig, l, false)), tris: g.length });
    }
    // Front to back, top to bottom: a stable order for the names
    partsHere.sort((a, b) => b.tip[2] - a.tip[2] || b.tip[1] - a.tip[1]);
    arms.push(...partsHere);
    if (cz > 0 && partsHere.filter((p) => p.kind === "trackrod").length !== 1) throw new Error(`${w.corner}: no track rod found`);

    // The drum: everything still joined to the wheel's side of the face
    const seeds = tris.filter((t) =>
      [0, 1, 2].every((c) => {
        const p = vert(rig, rig.idx[3 * t + c]);
        return s * p[0] > w.xFace + 0.02 && Math.hypot(p[1] - cy, p[2] - cz) < DRUM_RADIUS - 0.02;
      })
    );
    const drum = flood(rig, weld, around, seeds, (t) => !gone.has(t));
    for (const t of drum) {
      if (s * centroid(rig, t)[0] < w.xFace - 0.4) throw new Error(`${w.corner}: the drum is still joined to the body`);
      gone.add(t);
    }
    hubs.push({ corner: w.corner, centre: w.centre, mesh: merge([extract(rig, [...drum]), ...partsHere.flatMap((p) => p.faceCaps)]), tris: drum.size });
  }
  return { arms, hubs, bodyCaps, rest: tris.filter((t) => !gone.has(t)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Shading: how much of the sky each vertex sees past the rest of the car
// ---------------------------------------------------------------------------------------------------------------

/**
 * The car at rest is filled into a grid of `voxel` cubes (m). From each vertex `rays` go out over the hemisphere about
 * its normal, more of them near the normal; one that meets the car or the road (y = 0) within `reach` darkens the
 * vertex, the more the nearer. A vertex nothing is near keeps 1; none goes below `floor`. The rays start `lift` cells
 * off the surface: a cell a flat panel passes through reaches no further from it than 1.73 cells.
 */
const OCCLUSION = { voxel: 0.012, reach: 0.3, rays: 48, floor: 0.2, lift: 2 };

/** A grid of the cells the meshes' triangles pass through (`meshes`: { pos, idx } in the model's frame) */
function occlusionGrid(meshes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const m of meshes) {
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
    cells[(k * size[1] + j) * size[0] + i] = 1;
  };
  for (const m of meshes) {
    for (let t = 0; t < m.idx.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((v) => [m.pos[3 * m.idx[t + v]], m.pos[3 * m.idx[t + v] + 1], m.pos[3 * m.idx[t + v] + 2]]);
      const ab = sub(b, a);
      const ac = sub(c, a);
      // Points across the triangle no further apart than half a cell
      const n = Math.max(1, Math.ceil(Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...sub(c, b))) / (h * 0.5)));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) mark(a[0] + (ab[0] * i + ac[0] * j) / n, a[1] + (ab[1] * i + ac[1] * j) / n, a[2] + (ab[2] * i + ac[2] * j) / n);
      }
    }
  }
  const full = (x, y, z) => {
    if (y < 0) return true;
    const i = Math.floor((x - min[0]) / h);
    const j = Math.floor((y - min[1]) / h);
    const k = Math.floor((z - min[2]) / h);
    return i >= 0 && j >= 0 && k >= 0 && i < size[0] && j < size[1] && k < size[2] && cells[(k * size[1] + j) * size[0] + i] === 1;
  };
  return { full };
}

/** The hemisphere's directions about +z, denser toward it (a spiral), as [x, y, z] */
const OCCLUSION_RAYS = Array.from({ length: OCCLUSION.rays }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / OCCLUSION.rays);
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)];
});

/** A byte a vertex (255: open sky, down to `floor`) for `mesh` (pos, nrm in the model's frame) */
function occlusionOf(grid, mesh) {
  const h = OCCLUSION.voxel;
  const out = new Uint8Array(mesh.pos.length / 3);
  for (let v = 0; v < out.length; v++) {
    const p = [mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]];
    const n = unit([mesh.nrm[3 * v], mesh.nrm[3 * v + 1], mesh.nrm[3 * v + 2]]);
    const u = unit(Math.abs(n[1]) > 0.9 ? cross3(n, [1, 0, 0]) : cross3(n, [0, 1, 0]));
    const w = cross3(n, u);
    // Off the surface, so it does not meet itself
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
// Output
// ---------------------------------------------------------------------------------------------------------------

function material(doc, name, color, { metallic = 0, roughness = 0.6 } = {}) {
  return doc
    .createMaterial(name)
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(metallic)
    .setRoughnessFactor(roughness);
}

/**
 * `shaded`: a list each part is added to with its primitive and its mesh in the model's frame (`at`, or `geo` when it
 * is already there), to get its vertices' occlusion once the whole car is known
 */
function addMesh(doc, buffer, name, parts, shaded) {
  const mesh = doc.createMesh(name);
  for (const { geo, mat, at } of parts) {
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
  // Every part whose vertices get their occlusion baked (the wheels turn, so not them)
  const shaded = [];
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
      .setMesh(addMesh(doc, buffer, f.name, [flapPart(simplify(mesh, ratio), h.pivot, mats[f.zone])], shaded))
      .setExtras({ aeroClosed: matrix4(ident, h.pivot), aeroOpen: matrix4(open, h.pivot) });
    flapNodes.push(node);
    console.log(`  ${f.name}: ${f.tris.length} tris, ${loops.length} cut ends, hinge ${h.axis.map((v) => v.toFixed(3))}`);
  }

  // Suspension: the body is cut on each arm's root and each drum's face, then the arms and the drums come out of it
  for (const w of wheels) {
    w.xFace = drumFace(rig, bodyTris, w);
    // The arms are cut just inboard of the face, so the face's own triangles stay on the drum
    w.xCut = w.xFace - 0.002;
  }
  const legs = wheels.flatMap((w) => findLegs(rig, weld, bodyTris, w));
  const cutSusp = cutAlong(rig, [...bodyTris, ...parts.other.flatMap((p) => p.tris)], suspensionLines(legs, wheels));
  const susp = suspension(cutSusp.rig, weldMap(cutSusp.rig), cutSusp.tris, wheels, legs);
  for (const w of wheels) {
    const here = susp.arms.filter((a) => a.corner === w.corner);
    const drum = susp.hubs.find((h) => h.corner === w.corner);
    console.log(`  ${w.corner}: drum face at ${w.xFace.toFixed(3)} m, ${drum.tris} tris; arms ${here.map((a) => `${a.kind} ${a.tris}`).join(", ")}`);
  }

  // Body, one mesh per zone, each simplified with its borders kept so the zones still meet
  const cutBody = cutAlongZones(cutSusp.rig, susp.rest);
  const light = rainLight(cutBody.rig, cutBody.tris);
  // The cockpit's tray floor comes out; a well goes in its place
  const tray = cutBody.tris.filter((t) => isTrayFloor(cutBody.rig, t));
  const trayLoops = boundaryLoops(cutBody.rig, weldMap(cutBody.rig), tray).sort((a, b) => b.length - a.length);
  if (!trayLoops.length) throw new Error("no cockpit tray floor found");
  const well = cockpitWell(cutBody.rig, trayLoops[0]);
  const trayTris = new Set(tray);
  console.log(`  cockpit: tray floor ${tray.length} tris out, ${trayLoops.length} outline(s), well ${well.idx.length / 3} tris`);
  const byZone = new Map();
  for (const t of cutBody.tris) {
    if (trayTris.has(t)) continue;
    const z = light.has(t) ? ZONE.light : zoneOf(centroid(cutBody.rig, t), vertexNormal(cutBody.rig, t));
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z).push(t);
  }
  const bodyParts = [];
  const cutRatio = BUDGET.body / (parts.body.tris.length + (cutBody.tris.length - susp.rest.length));
  for (const [z, tris] of byZone) {
    const extra = z === ZONE.secondary ? stubCaps : z === ZONE.interior ? [well] : [];
    bodyParts.push({ geo: simplify(merge([extract(cutBody.rig, tris), ...extra]), cutRatio, { lockBorder: true }), mat: mats[z] });
    console.log(`  ${z}: ${tris.length} tris`);
  }
  // The holes the arms left in the chassis
  if (susp.bodyCaps.length) bodyParts.push({ geo: merge(susp.bodyCaps), mat: mats[ZONE.carbon] });
  if (parts.exhaust) bodyParts.push({ geo: simplify(extract(rig, parts.exhaust.tris), 0.3), mat: mats.exhaust });
  for (const p of parts.mirrors) {
    const geo = extract(rig, p.tris);
    bodyParts.push({ geo, mat: bounds(geo).min[0] > 0 ? mats.mirrorL : mats.mirrorR });
  }
  const body = doc.createNode("BODY").setMesh(addMesh(doc, buffer, "BODY", bodyParts, shaded));
  for (const n of flapNodes) body.addChild(n);
  vf.addChild(body);

  // Arms: each in its own frame at its root, z along it (a wishbone's along its two roots), with where its outer end
  // is (`tip`) and how it moves (`kind`). Drums: on the wheel's centre, where the game puts them on the steer pivot.
  const armNo = {};
  for (const a of susp.arms) {
    const name = `ARM_${a.corner}_${(armNo[a.corner] = (armNo[a.corner] ?? 0) + 1)}`;
    const at = simplify(a.mesh, Math.max(SUSPENSION_MIN_TRIS.arm, Math.round(a.tris * ratio * 1.5)));
    const { geo, rotation } = inFrame(at, a.pivot, a.axes);
    body.addChild(
      doc
        .createNode(name)
        .setTranslation(a.pivot)
        .setRotation(rotation)
        .setMesh(addMesh(doc, buffer, name, [{ geo, mat: mats[ZONE.carbon], at }], shaded))
        .setExtras({ arm: { kind: a.kind, tip: a.tip } })
    );
  }
  for (const h of susp.hubs) {
    const name = `SUSP_${h.corner}`;
    const part = flapPart(simplify(h.mesh, Math.max(SUSPENSION_MIN_TRIS.drum, Math.round(h.tris * ratio))), h.centre, mats[ZONE.carbon]);
    vf.addChild(doc.createNode(name).setTranslation(h.centre).setMesh(addMesh(doc, buffer, name, [part], shaded)));
  }

  // Wheels
  const wheelCentres = {};
  const tyreRadius = {};
  const wheelsAtRest = [];
  for (const w of wheels) {
    const name = WHEEL_NAMES[w.corner];
    wheelCentres[name] = w.centre;
    const node = doc.createNode(name).setTranslation(w.centre);
    const rim = simplify(w.rim, BUDGET.rim);
    const tyre = simplify(w.tyre, BUDGET.tyre);
    wheelsAtRest.push(shift(rim, w.centre.map((v) => -v)), shift(tyre, w.centre.map((v) => -v)));
    tyreRadius[name] = bounds(tyre).max[1];
    node.addChild(doc.createNode(`${name}_RIM`).setMesh(addMesh(doc, buffer, `${name}_RIM`, [{ geo: rim, mat: mats.rim }])));
    node.addChild(doc.createNode(`${name}_TYRE`).setMesh(addMesh(doc, buffer, `${name}_TYRE`, [{ geo: tyre, mat: mats.tyre }])));
    vf.addChild(node);
  }
  if (Object.keys(wheelCentres).length !== 4) throw new Error(`wheel corners: ${Object.keys(wheelCentres)}`);

  // Occlusion: each shaded vertex against the whole car at rest, its wheels included
  const grid = occlusionGrid([...shaded.map((x) => x.mesh), ...wheelsAtRest]);
  let darkest = 255;
  let sum = 0;
  let count = 0;
  for (const { prim, mesh } of shaded) {
    const ao = occlusionOf(grid, mesh);
    for (const v of ao) {
      darkest = Math.min(darkest, v);
      sum += v;
    }
    count += ao.length;
    prim.setAttribute("_OCCLUSION", doc.createAccessor().setType("SCALAR").setArray(ao).setNormalized(true).setBuffer(buffer));
  }
  console.log(`  occlusion: ${count} vertices, mean ${(sum / count / 255).toFixed(3)}, darkest ${(darkest / 255).toFixed(2)}`);

  // Steering wheel (STEER_BASE: rim, paddles, dials, display, shift lights) and cameras from the AM26
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
  // The AM26's cameras as they were (the front axle is where it had it)
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
      author: "Qvist Designs",
      url: "https://qvistdesigns.framer.website/",
      license: "CC BY 4.0",
      changes:
        "Re-oriented to metres; simplified; split into body, wheels and tyres; wing flaps, suspension arms and brake drums cut free; painted in livery zones; the AM26's steering wheel added",
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
    susp.arms.forEach((a, i) => add(`${a.corner}_${a.kind}_${i}`, a.mesh, i));
    const plain = (name, geo, colour) => sc.addChild(d.createNode(name).setMesh(addMesh(d, b, name, [{ geo, mat: material(d, name, colour) }])));
    susp.hubs.forEach((h) => plain(`${h.corner}_drum`, h.mesh, [1, 0.45, 0.05]));
    plain("body", extract(cutSusp.rig, susp.rest), [0.5, 0.5, 0.5]);
    wheels.forEach((w, i) => {
      add(`${w.corner}_tyre`, { ...w.tyre, pos: w.tyre.pos.map((v, j) => v + w.centre[j % 3]) }, 2 * i);
      add(`${w.corner}_rim`, { ...w.rim, pos: w.rim.pos.map((v, j) => v + w.centre[j % 3]) }, 2 * i + 1);
    });
    await io.write(debugParts, d);
  }
}

await main();
