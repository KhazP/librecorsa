// Builds public/tracks/rwanda/scenery/stands.glb: the project's own grandstands, open stands and media centre for
// Rwanda, generated to the footprint, height and facing of the stands in rwanda_2026.glb (a third-party track pack's
// models, reused). The circuit GLB is not changed; at runtime the loader hides the nodes this file lists in
// `extras.replaces`, so they stay as the fallback if it does not load.
//
//   node scripts/rwanda-stands.mjs [--track <rwanda_2026.glb>] [--out <file>] [--frames]
//
// Frames come from the circuit:
//  - the four roofed grandstands (Prop_Grandstand_01/02/04/05) share one model: the new one is built in its local
//    frame (length on x, seats facing -z and rising towards +z) and placed with each node's own transform;
//  - Prop_Stands_Open is one merged mesh of 14 open stands: it is split into welded pieces, the pieces clustered
//    into stands, and each stand given its long axis (principal axis of its footprint), extent, and facing (the low
//    side of its tiers);
//  - the media centre (Prop_MediaCentre) keeps its node transform and faces the nearest road.
// The owner's "Rwanda" roof lettering is copied byte for byte from the circuit GLB; everything else (seats, concrete,
// steel, glass) is drawn here. Seat rows keep the circuit's blue / yellow / green bands. `--frames` prints the frames
// and stops.

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groundSampler } from './lib/rwanda-ground.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : (all[i + 1] ?? true)]] : acc), []));
const TRACK = args.track && args.track !== true ? args.track : join(ROOT, 'public/tracks/rwanda/rwanda_2026.glb');
const OUT = args.out && args.out !== true ? args.out : join(ROOT, 'public/tracks/rwanda/scenery/stands.glb');

const ROOFED = ['Prop_Grandstand_01', 'Prop_Grandstand_02', 'Prop_Grandstand_04', 'Prop_Grandstand_05'];
const OPEN = 'Prop_Stands_Open';
const MEDIA = 'Prop_MediaCentre';
/** The owner's roof lettering in the circuit GLB, kept as it is */
const ROOF_LETTERING = 'KN5_Rwanda text italics grandstand';
/** Open-stand pieces closer than this belong to one stand */
const CLUSTER_GAP_M = 4;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

// ---------------------------------------------------------------------------
// Frames from the circuit
// ---------------------------------------------------------------------------

const track = await io.read(TRACK);
const byName = Object.fromEntries(track.getRoot().listNodes().map((n) => [n.getName(), n]));
const ground = groundSampler(track);

const apply = (W, v) => [
  W[0] * v[0] + W[4] * v[1] + W[8] * v[2] + W[12],
  W[1] * v[0] + W[5] * v[1] + W[9] * v[2] + W[13],
  W[2] * v[0] + W[6] * v[1] + W[10] * v[2] + W[14],
];
const yawOf = (q) => 2 * Math.atan2(q[1], q[3]);

/** Road vertices (world), for which way a building faces */
const road = [];
for (const node of track.getRoot().listNodes()) {
  if (node.getExtras()?.surface !== 'road') continue;
  for (const prim of node.getMesh()?.listPrimitives() ?? []) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i += 4) road.push(pos.getElement(i, [0, 0, 0]));
  }
}
const nearestRoad = (x, z) => road.reduce((best, p) => (Math.hypot(p[0] - x, p[2] - z) < Math.hypot(best[0] - x, best[2] - z) ? p : best), road[0]);

/** World positions of a node's vertices (every `step`th), with their material names */
function worldPoints(node, step = 1) {
  const W = node.getWorldMatrix();
  const out = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const mat = prim.getMaterial()?.getName() ?? '';
    for (let i = 0; i < pos.getCount(); i += step) out.push({ p: apply(W, pos.getElement(i, [0, 0, 0])), mat });
  }
  return out;
}

/** Lowest and highest ground under a footprint (frame: centre, yaw, length on local x, depth on local z) */
function groundRange(f) {
  let lo = Infinity;
  let hi = -Infinity;
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  for (let i = 0; i <= 8; i++)
    for (let j = 0; j <= 4; j++) {
      const lx = (i / 8 - 0.5) * f.length;
      const lz = (j / 4 - 0.5) * f.depth;
      // Ry(yaw): local x → (cos, -sin), local z → (sin, cos) in world (x, z)
      const x = f.x + c * lx + s * lz;
      const z = f.z - s * lx + c * lz;
      const g = ground(x, z, f.baseY + 30);
      if (!g) continue;
      lo = Math.min(lo, g.height);
      hi = Math.max(hi, g.height);
    }
  return { groundLo: lo, groundHi: hi };
}

/** A roofed grandstand: its node's transform, the shared model's local extent */
function roofedFrame(name) {
  const node = byName[name];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of node.getMesh().listPrimitives()) {
    const a = prim.getAttribute('POSITION').getMin([0, 0, 0]);
    const b = prim.getAttribute('POSITION').getMax([0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  const [x, y, z] = node.getTranslation();
  const f = { name, kind: 'roofed', x, z, baseY: y + lo[1], yaw: yawOf(node.getRotation()), length: hi[0] - lo[0], depth: hi[2] - lo[2], height: hi[1] - lo[1], localCentre: [(lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2] };
  return { ...f, ...groundRange(f) };
}

/** The open stands: welded pieces of Prop_Stands_Open, clustered; each cluster's axis, extent and facing */
function openFrames() {
  const node = byName[OPEN];
  const pts = worldPoints(node);
  // Union vertices that share a position, then triangles' corners, then pieces whose boxes are within CLUSTER_GAP_M
  const n = pts.length;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const seen = new Map();
  pts.forEach(({ p }, i) => {
    const k = p.map((v) => Math.round(v * 100)).join(',');
    if (seen.has(k)) union(i, seen.get(k));
    else seen.set(k, i);
  });
  let base = 0;
  for (const prim of node.getMesh().listPrimitives()) {
    const idx = prim.getIndices();
    for (let t = 0; t < idx.getCount(); t += 3) {
      union(base + idx.getScalar(t), base + idx.getScalar(t + 1));
      union(base + idx.getScalar(t + 1), base + idx.getScalar(t + 2));
    }
    base += prim.getAttribute('POSITION').getCount();
  }
  const boxes = new Map();
  pts.forEach(({ p }, i) => {
    const r = find(i);
    const b = boxes.get(r) ?? { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], members: [] };
    for (let k = 0; k < 3; k++) {
      b.lo[k] = Math.min(b.lo[k], p[k]);
      b.hi[k] = Math.max(b.hi[k], p[k]);
    }
    b.members.push(i);
    boxes.set(r, b);
  });
  const list = [...boxes.values()];
  const cp = list.map((_, i) => i);
  const cf = (i) => {
    while (cp[i] !== i) i = cp[i] = cp[cp[i]];
    return i;
  };
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const g = CLUSTER_GAP_M;
      if (a.lo[0] - g <= b.hi[0] && b.lo[0] - g <= a.hi[0] && a.lo[2] - g <= b.hi[2] && b.lo[2] - g <= a.hi[2]) cp[cf(i)] = cf(j);
    }
  const clusters = new Map();
  list.forEach((b, i) => {
    const r = cf(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(...b.members.map((m) => pts[m].p));
  });

  const frames = [];
  for (const cpts of clusters.values()) {
    const cx = cpts.reduce((s, p) => s + p[0], 0) / cpts.length;
    const cz = cpts.reduce((s, p) => s + p[2], 0) / cpts.length;
    let sxx = 0;
    let szz = 0;
    let sxz = 0;
    for (const p of cpts) {
      sxx += (p[0] - cx) ** 2;
      szz += (p[2] - cz) ** 2;
      sxz += (p[0] - cx) * (p[2] - cz);
    }
    const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    const u = [Math.cos(a), Math.sin(a)]; // long axis (world x, z)
    const w = [-u[1], u[0]]; // across
    // Tiers rise away from the track: height against the across coordinate
    let sw = 0;
    let sy = 0;
    let sww = 0;
    let swy = 0;
    for (const p of cpts) {
      const d = (p[0] - cx) * w[0] + (p[2] - cz) * w[1];
      sw += d;
      sy += p[1];
      sww += d * d;
      swy += d * p[1];
    }
    const N = cpts.length;
    const slope = (N * swy - sw * sy) / (N * sww - sw * sw);
    const back = slope > 0 ? w : [-w[0], -w[1]];
    // Local z points to the back: Ry(yaw) maps local z to (sin yaw, cos yaw)
    const yaw = Math.atan2(back[0], back[1]);
    const lx = [Math.cos(yaw), -Math.sin(yaw)];
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of cpts) {
      const dx = p[0] - cx;
      const dz = p[2] - cz;
      const l = dx * lx[0] + dz * lx[1];
      const b = dx * back[0] + dz * back[1];
      x0 = Math.min(x0, l);
      x1 = Math.max(x1, l);
      z0 = Math.min(z0, b);
      z1 = Math.max(z1, b);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    // Centre of the footprint (not of the vertices)
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    const f = {
      kind: 'open',
      x: cx + lx[0] * mx + back[0] * mz,
      z: cz + lx[1] * mx + back[1] * mz,
      baseY: y0,
      yaw,
      length: x1 - x0,
      depth: z1 - z0,
      height: y1 - y0,
    };
    frames.push({ ...f, ...groundRange(f) });
  }
  // Stable order (east to west along x, then z) and names
  frames.sort((a, b) => a.x - b.x || a.z - b.z);
  return frames.map((f, i) => ({ name: `Stand_Open_${String(i + 1).padStart(2, '0')}`, ...f }));
}

/** The media centre: node transform and local extent; local -z turned to face the nearest road */
function mediaFrame() {
  const node = byName[MEDIA];
  const pos = node.getMesh().listPrimitives().map((p) => p.getAttribute('POSITION'));
  const lo = [0, 1, 2].map((k) => Math.min(...pos.map((a) => a.getMin([0, 0, 0])[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...pos.map((a) => a.getMax([0, 0, 0])[k])));
  const W = node.getWorldMatrix();
  const lc = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const c = apply(W, lc);
  let yaw = yawOf(node.getRotation());
  let length = hi[0] - lo[0];
  let depth = hi[2] - lo[2];
  // The local axis with the long side stays local x; front (-z) towards the road
  if (depth > length) {
    [length, depth] = [depth, length];
    yaw += Math.PI / 2;
  }
  const r = nearestRoad(c[0], c[2]);
  const front = [-Math.sin(yaw), -Math.cos(yaw)];
  if ((r[0] - c[0]) * front[0] + (r[2] - c[2]) * front[1] < 0) yaw += Math.PI;
  const f = { name: MEDIA, kind: 'media', x: c[0], z: c[2], baseY: c[1], yaw, length, depth, height: hi[1] - lo[1] };
  return { ...f, ...groundRange(f) };
}

const frames = [...ROOFED.map(roofedFrame), ...openFrames(), mediaFrame()];
for (const f of frames) {
  const r = nearestRoad(f.x, f.z);
  const front = [-Math.sin(f.yaw), -Math.cos(f.yaw)];
  const toRoad = Math.atan2(r[2] - f.z, r[0] - f.x) - Math.atan2(front[1], front[0]);
  f.faceErrorDeg = Math.abs(((toRoad * 180) / Math.PI + 540) % 360 - 180);
  f.roadDist = Math.hypot(r[0] - f.x, r[2] - f.z);
}
if (args.frames) {
  for (const f of frames)
    console.log(
      `${f.name.padEnd(20)} ${f.kind.padEnd(6)} at ${f.x.toFixed(1)},${f.baseY.toFixed(1)},${f.z.toFixed(1)} yaw ${((f.yaw * 180) / Math.PI).toFixed(1)}° ` +
        `${f.length.toFixed(1)} × ${f.depth.toFixed(1)} × ${f.height.toFixed(1)} m, ground ${f.groundLo.toFixed(1)}..${f.groundHi.toFixed(1)}, ` +
        `road ${f.roadDist.toFixed(0)} m off, front ${f.faceErrorDeg.toFixed(0)}° from it`
    );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Per-material vertex lists; flat-shaded quads and boxes, wound so their normal points the way they face */
class Builder {
  constructor() {
    this.parts = new Map();
  }
  part(mat) {
    if (!this.parts.has(mat)) this.parts.set(mat, { pos: [], nor: [], uv: [], idx: [] });
    return this.parts.get(mat);
  }
  /** Quad a-b-c-d (a loop), facing `out`; uv per corner (defaults to metres along the two edges) */
  quad(mat, a, b, c, d, out, uv) {
    const e1 = sub(b, a);
    const e2 = sub(d, a);
    let n = norm(cross(e1, e2));
    if (dot(n, out) < 0) {
      [b, d] = [d, b];
      if (uv) [uv[1], uv[3]] = [uv[3], uv[1]];
      n = n.map((x) => -x);
    }
    uv ??= [
      [0, 0],
      [len(sub(b, a)), 0],
      [len(sub(b, a)), len(sub(d, a))],
      [0, len(sub(d, a))],
    ];
    const p = this.part(mat);
    const base = p.pos.length / 3;
    for (const [i, v] of [a, b, c, d].entries()) {
      p.pos.push(...v);
      p.nor.push(...n);
      p.uv.push(...uv[i]);
    }
    p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Axis-aligned box [x0, x1] × [y0, y1] × [z0, z1]; `skip` names faces to leave out (e.g. 'bottom') */
  box(mat, x0, x1, y0, y1, z0, z1, skip = []) {
    const P = (x, y, z) => [x, y, z];
    const faces = {
      top: [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), [0, 1, 0]],
      bottom: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0]],
      front: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), [0, 0, -1]],
      back: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1]],
      left: [P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), [-1, 0, 0]],
      right: [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), [1, 0, 0]],
    };
    for (const [name, [a, b, c, d, out]] of Object.entries(faces)) if (!skip.includes(name)) this.quad(mat, a, b, c, d, out);
  }
  /** A square-section beam of width `w` from p0 to p1 (four sides, no end caps) */
  beam(mat, p0, p1, w) {
    const axis = norm(sub(p1, p0));
    const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const s = norm(cross(axis, ref)).map((x) => (x * w) / 2);
    const t = norm(cross(axis, s)).map((x) => (x * w) / 2);
    const corner = (p, i, j) => add(p, add(s.map((x) => x * i), t.map((x) => x * j)));
    for (const [i, j, k, l] of [
      [1, 1, 1, -1],
      [1, -1, -1, -1],
      [-1, -1, -1, 1],
      [-1, 1, 1, 1],
    ]) {
      const a = corner(p0, i, j);
      const b = corner(p0, k, l);
      const out = add(s.map((x) => x * (i + k)), t.map((x) => x * (j + l)));
      this.quad(mat, a, b, corner(p1, k, l), corner(p1, i, j), out);
    }
  }
  /** A flat polygon (convex or a fan from its first point) facing `out` */
  polygon(mat, pts, out) {
    for (let i = 1; i + 1 < pts.length; i++) this.quad(mat, pts[0], pts[i], pts[i + 1], pts[i + 1], out);
  }
  triangles() {
    let n = 0;
    for (const p of this.parts.values()) n += p.idx.length / 3;
    return n;
  }
}
const sub = (a, b) => a.map((x, i) => x - b[i]);
const add = (a, b) => a.map((x, i) => x + b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(...a);
const norm = (a) => a.map((x) => x / (len(a) || 1));

/** Seat bands front to back, as on the circuit's stands: green, yellow, then blue for the upper half */
const BANDS = [
  ['SeatGreen', 0.23],
  ['SeatYellow', 0.25],
  ['SeatBlue', 0.52],
];
const bandOf = (row, rows) => {
  let acc = 0;
  for (const [mat, share] of BANDS) {
    acc += share;
    if ((row + 0.5) / rows <= acc) return mat;
  }
  return BANDS.at(-1)[0];
};

/** Seat pitch along a row (m): the seat texture repeats once per seat */
const SEAT_PITCH = 0.5;

/**
 * One row of seats from x0 to x1 on a tread whose front edge is at (z, y), facing -z: the pan's front, the pan, the
 * backrest's face and its top edge. v runs from the backrest's top (0) to the pan's front (1).
 */
function seatRow(b, mat, x0, x1, z, y, tread) {
  const zPan0 = z + 0.12;
  const zPan1 = z + Math.min(0.5, tread - 0.2);
  const zBack1 = zPan1 + 0.08;
  const yPan = y + 0.42;
  const yTop = y + 0.85;
  const u0 = x0 / SEAT_PITCH;
  const u1 = x1 / SEAT_PITCH;
  const strip = (p0, p1, out, v0, v1) =>
    b.quad(mat, [x0, ...p0], [x1, ...p0], [x1, ...p1], [x0, ...p1], out, [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ]);
  // Points are (y, z)
  const yz = (yy, zz) => [yy, zz];
  strip(yz(y + 0.12, zPan0), yz(yPan, zPan0), [0, 0, -1], 1, 0.86); // pan front
  strip(yz(yPan, zPan0), yz(yPan, zPan1), [0, 1, 0], 0.86, 0.55); // pan
  strip(yz(yPan, zPan1), yz(yTop, zBack1), [0, 0.3, -1], 0.5, 0.04); // backrest face
  strip(yz(yTop, zBack1), yz(yTop, zBack1 + 0.06), [0, 1, 0], 0.04, 0); // backrest top
}

/** Blocks of seats between aisles: [x0, x1] of each block over a row of `length` m */
function seatBlocks(length, targetBlock, aisle) {
  const usable = length - 1.2;
  const n = Math.max(1, Math.round((usable + aisle) / (targetBlock + aisle)));
  const block = (usable - (n - 1) * aisle) / n;
  return Array.from({ length: n }, (_, i) => {
    const x0 = -usable / 2 + i * (block + aisle);
    return [x0, x0 + block];
  });
}

/**
 * The roofed grandstand, in the circuit model's local frame (length on x, seats facing -z, rising towards +z): 22
 * tiers of seats in blocks with stepped aisles on an open steel frame, a front parapet and rails, and a wave canopy:
 * arched trusses front to back on slim columns, a membrane arching between them with the "Rwanda" lettering on top.
 */
function roofedGrandstand(f) {
  const b = new Builder();
  const L = f.length;
  const xL = -L / 2;
  const xR = L / 2;
  const zF = -12.2; // first tread's front edge
  const zT = 5.7; // last tread's back edge
  const y0 = 2.3; // first tread
  const y1 = 11.1; // walkway behind the last row
  const rows = 22;
  const d = (zT - zF) / rows;
  const h = (y1 - y0) / rows;
  const sink = -0.5;
  const treadY = (z) => y0 + Math.max(0, Math.min(rows - 1, Math.floor((z - zF) / d))) * h;

  // Tiers: tread, riser and a thin underside per row
  for (let r = 0; r < rows; r++) {
    const z = zF + r * d;
    const y = y0 + r * h;
    b.quad('Building_White', [xL, y, z], [xR, y, z], [xR, y, z + d], [xL, y, z + d], [0, 1, 0]);
    b.quad('Building_White', [xL, y + h, z + d], [xR, y + h, z + d], [xR, y, z + d], [xL, y, z + d], [0, 0, -1]);
    b.quad('Building_White', [xL, y - 0.25, z], [xR, y - 0.25, z], [xR, y + h - 0.25, z + d], [xL, y + h - 0.25, z + d], [0, -1, 0]);
  }
  // Front parapet, walkway behind the top row, and the tiers' ends
  b.box('Building_White', xL, xR, y0 - 0.3, y0 + 0.55, zF - 0.2, zF);
  b.box('Building_White', xL, xR, y1 - 0.25, y1, zT, zT + 2.4, ['top']);
  b.quad('Building_White', [xL, y1, zT], [xR, y1, zT], [xR, y1, zT + 2.4], [xL, y1, zT + 2.4], [0, 1, 0]);
  for (const [x, out] of [
    [xL, [-1, 0, 0]],
    [xR, [1, 0, 0]],
  ])
    b.polygon('Building_White', [[x, y0 - 0.3, zF - 0.2], [x, y0 + 0.55, zF - 0.2], [x, y1 + 0.55, zT], [x, y1 + 0.55, zT + 2.4], [x, y1 - 0.25, zT + 2.4], [x, y0 - 0.25, zF]], out);
  // Seats in blocks; aisles between them get a half step in every row
  const blocks = seatBlocks(L, 11.5, 1.2);
  for (let r = 0; r < rows; r++) {
    const z = zF + r * d;
    const y = y0 + r * h;
    const mat = bandOf(r, rows);
    for (const [x0, x1] of blocks) seatRow(b, mat, x0, x1, z + 0.02, y, d);
    for (let i = 0; i + 1 < blocks.length; i++) b.box('Building_White', blocks[i][1] + 0.1, blocks[i + 1][0] - 0.1, y, y + h / 2, z + d / 2, z + d, ['bottom', 'back', 'left', 'right']);
  }
  // Open steel frame under the tiers: columns on a grid, braces across the back
  const frameXs = Array.from({ length: 10 }, (_, i) => xL + 0.4 + ((L - 0.8) * i) / 9);
  const underZs = [zF + 0.3, zF + 6, zF + 12, zT + 2.2];
  for (const x of frameXs) {
    for (const z of underZs) {
      const top = z > zT ? y1 - 0.25 : treadY(z) - 0.25;
      b.box('Steel', x - 0.12, x + 0.12, sink, top, z - 0.12, z + 0.12, ['bottom', 'top']);
    }
    b.beam('Steel', [x, 0.4, underZs[0]], [x, treadY(underZs[2]) - 0.5, underZs[2]], 0.1);
  }
  for (let i = 0; i + 1 < frameXs.length; i++) {
    const [x0, x1] = [frameXs[i], frameXs[i + 1]];
    const zb = underZs.at(-1);
    b.beam('Steel', [x0, 0.4, zb], [x1, y1 - 0.6, zb], 0.1);
    b.beam('Steel', [x0, y1 - 0.6, zb], [x1, 0.4, zb], 0.1);
  }
  // Rails: on the parapet, behind the walkway, and up both ends
  const rail = (p0, p1) => b.beam('Steel', p0, p1, 0.07);
  rail([xL, y0 + 1.0, zF - 0.12], [xR, y0 + 1.0, zF - 0.12]);
  rail([xL, y1 + 1.05, zT + 2.35], [xR, y1 + 1.05, zT + 2.35]);
  for (const x of [xL - 0.05, xR + 0.05]) rail([x, y0 + 1.9, zF], [x, y1 + 1.9, zT]);

  // Wave canopy: arched trusses front to back on the frame lines, a membrane arching between them
  const zRF = -f.depth / 2; // canopy front edge, over the parapet
  const zRB = zT + 3.2;
  const yEnd = 19.4; // top chord at both ends
  const rise = 1.0; // top chord's rise at mid-depth
  const bay = 1.0; // membrane's rise between trusses
  const NZ = 8;
  const NX = 4;
  const chordY = (t) => yEnd + rise * Math.sin(Math.PI * t);
  const zAt = (t) => zRF + (zRB - zRF) * t;
  const membraneY = (s, t) => chordY(t) + bay * Math.sin(Math.PI * s);
  const lettering = (x, z) => [0.66614 - 0.00364 * x, -0.56916 - 0.01818 * z]; // as on the circuit's model
  for (let i = 0; i + 1 < frameXs.length; i++) {
    const [x0, x1] = [frameXs[i], frameXs[i + 1]];
    for (let a = 0; a < NX; a++)
      for (let c = 0; c < NZ; c++) {
        const P = (sa, tc) => [x0 + (x1 - x0) * sa, membraneY(sa, tc), zAt(tc)];
        const s0 = a / NX;
        const s1 = (a + 1) / NX;
        const t0 = c / NZ;
        const t1 = (c + 1) / NZ;
        const quadPts = [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)];
        b.quad('RoofLettering', ...quadPts, [0, 1, 0], quadPts.map(([x, , z]) => lettering(x, z)));
        b.quad('Grandstand_Canopy', ...quadPts.map(([x, y, z]) => [x, y - 0.05, z]), [0, -1, 0]);
      }
  }
  // Fascia along the front edge, following the bays' arches
  for (let i = 0; i + 1 < frameXs.length; i++)
    for (let a = 0; a < NX; a++) {
      const [x0, x1] = [frameXs[i], frameXs[i + 1]];
      const xa = x0 + ((x1 - x0) * a) / NX;
      const xb = x0 + ((x1 - x0) * (a + 1)) / NX;
      const ya = membraneY(a / NX, 0);
      const yb = membraneY((a + 1) / NX, 0);
      b.quad('Grandstand_Canopy', [xa, ya - 0.45, zRF], [xb, yb - 0.45, zRF], [xb, yb, zRF], [xa, ya, zRF], [0, 0, -1]);
    }
  // Trusses: top and bottom chords, verticals and diagonals; a slim column at the front and back of each, and a mast
  const zColF = zF + 1.0;
  const zColB = zT + 1.8;
  for (const x of frameXs) {
    const top = (t) => [x, chordY(t) - 0.08, zAt(t)];
    const bottom = (t) => [x, chordY(t) - 0.4 - 1.0 * Math.sin(Math.PI * t), zAt(t)];
    for (let c = 0; c < NZ; c++) {
      const t0 = c / NZ;
      const t1 = (c + 1) / NZ;
      b.beam('Steel', top(t0), top(t1), 0.16);
      b.beam('Steel', bottom(t0), bottom(t1), 0.14);
      b.beam('Steel', c % 2 ? top(t0) : bottom(t0), c % 2 ? bottom(t1) : top(t1), 0.08);
      b.beam('Steel', bottom(t1), top(t1), 0.08);
    }
    const tF = (zColF - zRF) / (zRB - zRF);
    const tB = (zColB - zRF) / (zRB - zRF);
    b.beam('Steel', [x, treadY(zColF), zColF], bottom(tF), 0.32);
    b.beam('Steel', [x, y1, zColB], bottom(tB), 0.36);
    b.beam('Steel', top(0.5), [x, f.height, zAt(0.5)], 0.2);
    b.beam('Steel', [x, f.height - 0.2, zAt(0.5)], top(0.05), 0.05);
    b.beam('Steel', [x, f.height - 0.2, zAt(0.5)], top(0.95), 0.05);
  }
  // Edge beams along the front and back of the canopy
  for (const t of [0, 1]) b.beam('Steel', [xL + 0.4, chordY(t) - 0.3, zAt(t)], [xR - 0.4, chordY(t) - 0.3, zAt(t)], 0.2);
  return b;
}

/**
 * An open stand at its own length: scaffold-supported plank tiers with seats in blocks, rails at the front, back and
 * ends. Local frame as above (front -z), base at y = 0.
 */
function openStand(f) {
  const b = new Builder();
  const L = f.length;
  const xL = -L / 2;
  const xR = L / 2;
  const D = f.depth;
  const zF = -D / 2 + 0.4;
  const zT = D / 2 - 0.4;
  const rows = 10;
  const d = (zT - zF) / rows;
  const y0 = 1.0;
  const h = 0.72;
  const sink = -0.4;
  const yTop = y0 + (rows - 1) * h;

  // Plank tiers and kick plates
  for (let r = 0; r < rows; r++) {
    const z = zF + r * d;
    const y = y0 + r * h;
    b.box('Steel', xL, xR, y - 0.06, y, z, z + d, ['left', 'right']);
    if (r > 0) b.quad('Steel', [xL, y - 0.06, z], [xR, y - 0.06, z], [xR, y - h, z], [xL, y - h, z], [0, 0, -1]);
  }
  const blocks = seatBlocks(L, 11.2, 1.1);
  for (let r = 0; r < rows; r++) {
    const mat = bandOf(r, rows);
    for (const [x0, x1] of blocks) seatRow(b, mat, x0, x1, zF + r * d + 0.02, y0 + r * h, d);
  }
  // Scaffold: legs every ~4.8 m at the front, middle and back, stringers along the tiers, braces in the back frame
  const bays = Math.max(2, Math.round(L / 4.8));
  const legZ = [zF + 0.1, (zF + zT) / 2, zT - 0.1];
  const legTop = (z) => y0 + Math.max(0, Math.min(rows - 1, Math.floor((z - zF) / d))) * h - 0.06;
  for (let i = 0; i <= bays; i++) {
    const x = xL + 0.15 + ((L - 0.3) * i) / bays;
    for (const z of legZ) b.box('Steel', x - 0.05, x + 0.05, sink, legTop(z), z - 0.05, z + 0.05, ['bottom', 'top']);
    b.beam('Steel', [x, y0 - 0.12, zF + 0.1], [x, yTop - 0.12, zT - 0.1], 0.1);
    b.beam('Steel', [x, 0.4, zT - 0.1], [x, legTop(legZ[1]) - 0.2, legZ[1]], 0.06);
    if (i < bays) {
      const xn = xL + 0.15 + ((L - 0.3) * (i + 1)) / bays;
      const [p, q] = i % 2 ? [[x, 0.3, zT - 0.1], [xn, yTop - 0.4, zT - 0.1]] : [[x, yTop - 0.4, zT - 0.1], [xn, 0.3, zT - 0.1]];
      b.beam('Steel', p, q, 0.06);
      b.beam('Steel', [x, 0.3, zF + 0.1], [xn, 0.3, zF + 0.1], 0.06);
    }
  }
  // Rails: front, and along the top behind the last row
  const yRail = y0 + 1.0;
  for (const [y, z] of [
    [yRail, zF - 0.05],
    [yTop + 1.05, zT + 0.05],
  ])
    b.box('Steel', xL, xR, y, y + 0.06, z - 0.03, z + 0.03);
  for (let x = xL + 0.2; x < xR; x += 2.4) b.box('Steel', x - 0.025, x + 0.025, y0, yRail, zF - 0.08, zF - 0.02, ['bottom', 'top']);
  // Ends: a rail up each side along the tiers
  for (const x of [xL - 0.04, xR + 0.04]) b.beam('Steel', [x, y0 + 1.0, zF], [x, yTop + 1.05, zT], 0.06);
  return b;
}

/**
 * The media centre: a concrete ground floor, an upper floor cantilevered towards the track with a glass front and
 * mullions, a roof slab with plant boxes. Local frame: length on x, front (-z) towards the track, base at y = 0.
 */
function mediaCentre(f) {
  const b = new Builder();
  const L = f.length;
  const D = f.depth;
  const xL = -L / 2;
  const xR = L / 2;
  const zF = -D / 2;
  const zB = D / 2;
  const sink = -0.5;
  const yG = 5.2; // first floor
  const yR = f.height - 0.8; // roof slab underside
  const zGF = zF + 6; // ground floor's front, set back under the cantilever
  // Ground floor: concrete with a glazed front
  b.box('Building_White', xL + 1.5, xR - 1.5, sink, yG, zGF, zB - 1, ['bottom', 'top', 'front']);
  b.quad('Glass', [xL + 1.5, 0, zGF], [xR - 1.5, 0, zGF], [xR - 1.5, yG, zGF], [xL + 1.5, yG, zGF], [0, 0, -1]);
  for (let x = xL + 1.5; x <= xR - 1.5 + 1e-6; x += (L - 3) / 16) b.box('Building_White', x - 0.15, x + 0.15, 0, yG, zGF - 0.15, zGF + 0.05, ['bottom', 'top']);
  // First floor slab and the media room above it, glass on the track side
  b.box('Building_White', xL, xR, yG - 0.5, yG, zF, zB, ['top']);
  b.box('Building_White', xL, xR, yG, yR, zF + 0.6, zB, ['bottom', 'top', 'front']);
  b.quad('Glass', [xL, yG, zF + 0.6], [xR, yG, zF + 0.6], [xR, yR, zF + 0.6], [xL, yR, zF + 0.6], [0, 0, -1]);
  for (let i = 0; i <= 27; i++) {
    const x = xL + 0.2 + ((L - 0.4) * i) / 27;
    b.box('Steel', x - 0.06, x + 0.06, yG, yR, zF + 0.45, zF + 0.6, ['bottom', 'top', 'back']);
  }
  b.box('Steel', xL, xR, (yG + yR) / 2 - 0.08, (yG + yR) / 2 + 0.08, zF + 0.45, zF + 0.6, ['back']);
  // Roof slab with an overhang, plant boxes on top
  b.box('Grandstand_Canopy', xL - 0.6, xR + 0.6, yR, f.height, zF - 1.2, zB + 0.3);
  for (const [x, z, w, dd, hh] of [
    [-0.25, 0.2, 9, 5, 2.2],
    [0.2, 0.25, 6, 4, 1.6],
  ])
    b.box('Building_White', x * L - w / 2, x * L + w / 2, f.height, f.height + hh, z * D - dd / 2, z * D + dd / 2, ['bottom']);
  // A terrace rail along the first floor's front edge
  b.box('Steel', xL, xR, yG + 1.0, yG + 1.06, zF + 0.05, zF + 0.11);
  return b;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Seat colours sampled from the circuit's seat bands (sRGB) */
const SEAT_COLOURS = { SeatGreen: [45, 97, 64], SeatYellow: [233, 208, 27], SeatBlue: [18, 160, 211] };

/**
 * One seat, 128 px square, grey (the material colour tints it): the backrest's face (rounded top corners, lighter at
 * the top) from v = 0.04 to 0.5, the pan to 0.86, its front edge below; dark gaps between neighbouring seats.
 */
async function seatTexture() {
  const S = 128;
  const px = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S;
      const v = (y + 0.5) / S;
      let g;
      if (u < 0.05 || u > 0.95) g = 0.12;
      else if (v < 0.04) g = 0.7;
      else if (v < 0.5) {
        const r = 0.1;
        const cu = u < 0.05 + r ? 0.05 + r : u > 0.95 - r ? 0.95 - r : u;
        const cv = 0.04 + r;
        g = v < cv && Math.hypot(u - cu, v - cv) > r ? 0.12 : 0.93 - (0.16 * (v - 0.04)) / 0.46;
      } else if (v < 0.53) g = 0.35;
      else if (v < 0.86) g = 0.72;
      else g = 0.52;
      px.fill(Math.round(g * 255), (y * S + x) * 3, (y * S + x) * 3 + 3);
    }
  return new Uint8Array(await sharp(px, { raw: { width: S, height: S, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer());
}

const doc = new Document();
const buffer = doc.createBuffer();
doc.getRoot().getAsset().generator = 'LibreCorsa scripts/rwanda-stands.mjs';
doc.getRoot().getAsset().copyright = 'LibreCorsa project (generated geometry); "Rwanda" roof lettering from the circuit';
const webp = doc.createExtension((await import('@gltf-transform/extensions')).EXTTextureWebP).setRequired(true);
void webp;

const lettering = track.getRoot().listTextures().find((t) => t.getName() === ROOF_LETTERING);
if (!lettering) throw new Error(`${ROOF_LETTERING} not found in ${TRACK}`);
const letteringTex = doc.createTexture(ROOF_LETTERING).setImage(lettering.getImage().slice()).setMimeType(lettering.getMimeType());
const seatTex = doc.createTexture('Stand_Seat').setImage(await seatTexture()).setMimeType('image/png');

const material = (name, { colour = [1, 1, 1], rough = 0.6, metal = 0, map = null, doubleSided = false } = {}) => {
  const m = doc.createMaterial(name).setBaseColorFactor([...colour, 1]).setRoughnessFactor(rough).setMetallicFactor(metal).setDoubleSided(doubleSided);
  if (map) m.setBaseColorTexture(map);
  return m;
};
const MATERIALS = {
  // Named as the circuit's own flat scenery materials, so scenery-detail.ts weathers them the same way
  Building_White: material('Building_White', { colour: [0.84, 0.86, 0.88], rough: 0.6 }),
  Grandstand_Canopy: material('Grandstand_Canopy', { colour: [0.91, 0.91, 0.91], rough: 0.5 }),
  Steel: material('Stand_Steel', { colour: [0.42, 0.44, 0.46], rough: 0.5, metal: 0.55 }),
  Glass: material('Stand_Glass', { colour: [0.05, 0.08, 0.11], rough: 0.08, metal: 0.1 }),
  RoofLettering: material('Stand_Roof_Lettering', { rough: 0.82, map: letteringTex }),
  ...Object.fromEntries(
    Object.entries(SEAT_COLOURS).map(([k, rgb]) => [k, material(`Stand_${k.replace('Seat', 'Seat_')}`, { colour: rgb.map((c) => srgbToLinear(c / 255)), rough: 0.55, map: seatTex, doubleSided: true })])
  ),
};

const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
function toMesh(name, builder) {
  const mesh = doc.createMesh(name);
  for (const [mat, p] of builder.parts) {
    const n = p.pos.length / 3;
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(p.pos)))
      .setAttribute('NORMAL', accessor('VEC3', new Float32Array(p.nor)))
      .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(p.uv)))
      .setIndices(accessor('SCALAR', n < 65536 ? new Uint16Array(p.idx) : new Uint32Array(p.idx)))
      .setMaterial(MATERIALS[mat]);
    mesh.addPrimitive(prim);
  }
  return mesh;
}

const scene = doc.createScene('Stands');
const root = doc.createNode('Scenery_Stands');
scene.addChild(root);
const yawQuat = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
const meshCache = new Map();
let triangles = 0;
for (const f of frames) {
  // Stands of (nearly) one size share a mesh: the four roofed ones exactly, the open ones to the nearest metre
  const L = f.kind === 'open' ? Math.round(f.length) : f.length;
  const D = f.kind === 'open' ? Math.round(f.depth * 2) / 2 : f.depth;
  const key = `${f.kind}:${L.toFixed(2)}:${D.toFixed(2)}:${f.height.toFixed(2)}`;
  if (!meshCache.has(key)) {
    const g = { ...f, length: L, depth: D };
    const b = f.kind === 'roofed' ? roofedGrandstand(g) : f.kind === 'open' ? openStand(g) : mediaCentre(g);
    meshCache.set(key, { mesh: toMesh(key.split(':')[0] === 'roofed' ? 'Grandstand' : f.kind === 'open' ? `Open_Stand_${L}m` : 'Media_Centre', b), tris: b.triangles() });
  }
  const { mesh, tris } = meshCache.get(key);
  triangles += tris;
  const node = doc.createNode(f.name.replace(/^Prop_/, 'Scenery_')).setMesh(mesh);
  if (f.kind === 'roofed') {
    const src = byName[f.name];
    node.setTranslation(src.getTranslation()).setRotation(src.getRotation());
  } else {
    node.setTranslation([f.x, f.baseY, f.z]).setRotation(yawQuat(f.yaw));
  }
  node.setExtras({ stands: f.kind, footprint: { x: f.x, z: f.z, yaw: f.yaw, length: L, depth: D, baseY: f.baseY } });
  root.addChild(node);
}
const counts = { roofed: frames.filter((f) => f.kind === 'roofed').length, open: frames.filter((f) => f.kind === 'open').length, media: frames.filter((f) => f.kind === 'media').length };
root.setExtras({ replaces: [...ROOFED, OPEN, MEDIA], counts, source: 'generated by scripts/rwanda-stands.mjs' });

await doc.transform(dedup(), prune({ keepAttributes: true, keepIndices: true }));
mkdirSync(dirname(OUT), { recursive: true });
await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(OUT, doc);
const unique = [...meshCache.values()].reduce((s, m) => s + m.tris, 0);
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB): ${counts.roofed} roofed, ${counts.open} open, ${counts.media} media centre; ${meshCache.size} meshes, ${unique} unique / ${triangles} drawn triangles`);
