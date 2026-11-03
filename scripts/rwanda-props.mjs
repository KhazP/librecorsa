// Builds public/tracks/rwanda/scenery/props.glb: the project's own versions of Rwanda's small trackside props, in
// place of a third-party track pack's models (rwanda_2026.glb is not changed; at runtime the loader hides the nodes
// this file lists in `extras.replaces`, so they stay as the fallback if it does not load).
//
//   node scripts/rwanda-props.mjs --helicopter <ec135.glb> [--track <rwanda_2026.glb>] [--out <file>]
//
//  - Jumbotrons (3): the owner's circuit-map screen (TX_screen) kept exactly as it is, in a generated frame on truss
//    legs, at each node's own transform.
//  - Start lights: a housing at exactly the original's box, 5 columns × 4 lens rows (amber, green, red, red from the
//    top): the game's emissive pods snap to that box and light on the first red row (scene-builder.ts).
//  - Pit exit light, radio masts (2), paddock tents (28 + the large marquee), TV camera platforms (7, camera on a
//    tripod under an umbrella): generated to each original's footprint, height and facing. The merged nodes are
//    split into their objects by welding and clustering (scripts/lib/rwanda-ground.mjs).
//  - Helicopter: "Cedric-EC135- Waving-190 Rotor" by PatrickBiani (CC BY 4.0), the helicopter only (the model's
//    figure and animation are left out), simplified, textures re-encoded, at the original's transform.

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, flatten, prune, simplifyPrimitive, textureCompress, transformMesh, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, groundSampler, worldClusters } from './lib/rwanda-ground.mjs';
import { Builder } from './lib/scenery-builder.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const TRACK = args.track ?? join(ROOT, 'public/tracks/rwanda/rwanda_2026.glb');
const OUT = args.out ?? join(ROOT, 'public/tracks/rwanda/scenery/props.glb');
const HELI_SRC = args.helicopter;
if (!HELI_SRC) throw new Error('--helicopter <ec135.glb> is required (the Sketchfab download, kept outside the repo)');

/** Attribution for the one third-party model here; also in src/lib/render/scenery-credits.ts (verify-scenery checks) */
export const CREDITS = [
  {
    id: 'helicopter',
    title: 'Cedric-EC135- Waving-190 Rotor',
    author: 'PatrickBiani',
    url: 'https://sketchfab.com/3d-models/cedric-ec135-waving-190-rotor-09fbae3edc0a44bea7dbb7ed7644df6b',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    changes: "helicopter only (the figure and its animation left out), simplified, textures re-encoded to WebP, parked on the circuit's helicopter spot",
  },
];

const REPLACES = ['Prop_Jumbotron_0', 'Prop_Jumbotron_1', 'Prop_Jumbotron_2', 'Prop_StartLights_0', 'Prop_PitExitLight', 'Prop_RadioMasts', 'Prop_Paddock_Tents', 'Prop_CameraPosts', 'Prop_Helicopter'];
/** The owner's circuit-map screen texture on the jumbotrons, kept as it is */
const SCREEN_TEXTURE = 'TX_screen';
const SINK = -0.4;

await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const track = await io.read(TRACK);
const byName = Object.fromEntries(track.getRoot().listNodes().map((n) => [n.getName(), n]));
const ground = groundSampler(track);

// ---------------------------------------------------------------------------
// Frames from the circuit
// ---------------------------------------------------------------------------

const yawOf = (q) => 2 * Math.atan2(q[1], q[3]);
/** Road vertices (world), for which way a camera platform faces */
const road = [];
for (const node of track.getRoot().listNodes()) {
  if (node.getExtras()?.surface !== 'road') continue;
  for (const prim of node.getMesh()?.listPrimitives() ?? []) {
    const pos = prim.getAttribute('POSITION');
    for (let i = 0; i < pos.getCount(); i += 4) road.push(pos.getElement(i, [0, 0, 0]));
  }
}
const nearestRoad = (x, z) => road.reduce((best, p) => (Math.hypot(p[0] - x, p[2] - z) < Math.hypot(best[0] - x, best[2] - z) ? p : best), road[0]);

/** A single-node prop: its transform and local extent */
function nodeFrame(name) {
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
  return { node, lo, hi, translation: node.getTranslation(), rotation: node.getRotation() };
}

/** Lowest ground under a footprint given in world corners' (x, z), probing from `fromY` */
function lowestGround(points, fromY) {
  let lo = Infinity;
  for (const [x, z] of points) {
    const g = ground(x, z, fromY + 30);
    if (g) lo = Math.min(lo, g.height);
  }
  return lo;
}

/**
 * One object of a merged node: centre of its footprint, yaw of its long axis (local x), extent, base height, and
 * the depth its legs must reach below the base (to the lowest ground under it).
 */
function clusterFrame(points, { faceRoad = false } = {}) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cz = points.reduce((s, p) => s + p[2], 0) / points.length;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const p of points) {
    sxx += (p[0] - cx) ** 2;
    szz += (p[2] - cz) ** 2;
    sxz += (p[0] - cx) * (p[2] - cz);
  }
  const a = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  // Local x along the long axis: Ry(yaw) maps local x to (cos yaw, -sin yaw)
  let yaw = -a;
  const ext = (yw) => {
    const ux = [Math.cos(yw), -Math.sin(yw)];
    const uz = [Math.sin(yw), Math.cos(yw)];
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of points) {
      const dx = p[0] - cx;
      const dz = p[2] - cz;
      const l = dx * ux[0] + dz * ux[1];
      const w = dx * uz[0] + dz * uz[1];
      x0 = Math.min(x0, l);
      x1 = Math.max(x1, l);
      z0 = Math.min(z0, w);
      z1 = Math.max(z1, w);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
    return { ux, uz, x0, x1, z0, z1, y0, y1 };
  };
  let e = ext(yaw);
  if (faceRoad) {
    // Local -z towards the nearest road
    const r = nearestRoad(cx, cz);
    const front = [-e.uz[0], -e.uz[1]];
    if ((r[0] - cx) * front[0] + (r[2] - cz) * front[1] < 0) yaw += Math.PI;
    e = ext(yaw);
  }
  const mx = (e.x0 + e.x1) / 2;
  const mz = (e.z0 + e.z1) / 2;
  const x = cx + e.ux[0] * mx + e.uz[0] * mz;
  const z = cz + e.ux[1] * mx + e.uz[1] * mz;
  const length = e.x1 - e.x0;
  const depth = e.z1 - e.z0;
  // Sample at least 2 m square: a camera platform's legs stand wider than its measured footprint
  const sl = Math.max(length, 2);
  const sd = Math.max(depth, 2);
  const corners = [-0.5, -0.25, 0, 0.25, 0.5].flatMap((i) => [-0.5, -0.25, 0, 0.25, 0.5].map((j) => [x + e.ux[0] * i * sl + e.uz[0] * j * sd, z + e.ux[1] * i * sl + e.uz[1] * j * sd]));
  const groundLo = lowestGround(corners, e.y0);
  return { x, z, yaw, length, depth, height: e.y1 - e.y0, baseY: e.y0, footDrop: Math.max(0, e.y0 - groundLo) };
}

const yawQuat = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

// ---------------------------------------------------------------------------
// Generated props (local frame: length on x, front towards -z, base at y = 0)
// ---------------------------------------------------------------------------

/**
 * A jumbotron around the circuit's screen quad: a surround and back box in the screen's own plane, a cap, two
 * lattice truss legs down to concrete footings. `screen` gives the screen's corners in the node's local frame.
 */
function jumbotron(screen, footDrop) {
  const b = new Builder();
  const { a, u, n, width, y0, y1 } = screen;
  // Point in the screen's frame: s along its width from its left edge, y up, d behind it (along -n)
  const P = (s, y, d) => [a[0] + u[0] * s - n[0] * d, y, a[2] + u[2] * s - n[2] * d];
  const box = (mat, s0, s1, ya, yb, d0, d1) => {
    const c = (s, y, d) => P(s, y, d);
    const faces = [
      [c(s0, yb, d0), c(s1, yb, d0), c(s1, yb, d1), c(s0, yb, d1), [0, 1, 0]],
      [c(s0, ya, d0), c(s1, ya, d0), c(s1, ya, d1), c(s0, ya, d1), [0, -1, 0]],
      [c(s0, ya, d0), c(s1, ya, d0), c(s1, yb, d0), c(s0, yb, d0), n],
      [c(s0, ya, d1), c(s1, ya, d1), c(s1, yb, d1), c(s0, yb, d1), n.map((v) => -v)],
      [c(s0, ya, d0), c(s0, yb, d0), c(s0, yb, d1), c(s0, ya, d1), u.map((v) => -v)],
      [c(s1, ya, d0), c(s1, yb, d0), c(s1, yb, d1), c(s1, ya, d1), u],
    ];
    for (const [p, q, r, t, out] of faces) b.quad(mat, p, q, r, t, out);
  };
  const border = 0.45;
  // Surround: four bars just in front of the screen's plane, and the screen box behind it
  box('Jumbo_Frame', -border, 0, y0 - border, y1 + border, -0.15, 1.2);
  box('Jumbo_Frame', width, width + border, y0 - border, y1 + border, -0.15, 1.2);
  box('Jumbo_Frame', 0, width, y1, y1 + border, -0.15, 1.2);
  box('Jumbo_Frame', 0, width, y0 - border, y0, -0.15, 1.2);
  box('Jumbo_Frame', 0, width, y0, y1, 0.05, 1.2);
  box('Jumbo_Frame', -border - 0.2, width + border + 0.2, y1 + border, y1 + border + 0.35, -0.35, 1.5);
  // Two lattice legs (four chords, rungs and diagonals) under the screen, footings under them
  for (const s of [width * 0.22, width * 0.78]) {
    const w = 0.9;
    const chord = (i, j) => (y) => P(s + i * w, y, 0.6 + j * w);
    const corners = [chord(-0.5, -0.5), chord(0.5, -0.5), chord(0.5, 0.5), chord(-0.5, 0.5)];
    for (const c of corners) b.beam('Steel', c(SINK - footDrop + 0.6), c(y0 - border), 0.14);
    const steps = Math.max(2, Math.round((y0 - border) / 1.6));
    for (let k = 0; k < steps; k++) {
      const ya = (k / steps) * (y0 - border);
      const yb = ((k + 1) / steps) * (y0 - border);
      for (let c = 0; c < 4; c++) {
        b.beam('Steel', corners[c](yb), corners[(c + 1) % 4](yb), 0.06);
        b.beam('Steel', corners[c](ya), corners[(c + 1) % 4](yb), 0.05);
      }
    }
    box('Building_White', s - 0.9, s + 0.9, SINK - footDrop, 0.6, 0.6 - 0.9, 0.6 + 0.9);
  }
  return b;
}

/**
 * The start lights in exactly the box of the circuit's assembly: a black housing, 5 columns × 4 lenses on the
 * front (-z) — amber, green, red, red from the top, the game's pods light over the first red row — a visor over
 * each row and two hanger bars on top.
 */
function startLights(lo, hi) {
  const b = new Builder();
  const [x0, y0, z0] = lo;
  const [x1, y1, z1] = hi;
  b.box('Housing', x0, x1, y0, y1, z0 + 0.08, z1);
  const cols = 5;
  const rows = ['Lens_Amber', 'Lens_Green', 'Lens_Red', 'Lens_Red'];
  const cw = (x1 - x0) / cols;
  const rh = (y1 - y0) / rows.length;
  const r = Math.min(cw, rh) * 0.32;
  for (let c = 0; c < cols; c++)
    rows.forEach((mat, i) => {
      const cx = x0 + (c + 0.5) * cw;
      const cy = y1 - (i + 0.5) * rh;
      // An octagonal lens, set just in front of the housing
      const pts = Array.from({ length: 8 }, (_, k) => [cx + r * Math.cos((k * Math.PI) / 4), cy + r * Math.sin((k * Math.PI) / 4), z0 + 0.07]);
      b.polygon(mat, pts, [0, 0, -1]);
      b.box('Housing', cx - r * 1.1, cx + r * 1.1, cy + r * 0.95, cy + r * 1.1, z0, z0 + 0.08, ['back']);
    });
  // The hanger bars stay inside the box (the pods are placed from it)
  for (const x of [x0 + 0.2, x1 - 0.2]) b.box('Steel', x - 0.03, x + 0.03, y1 - 0.06, y1, z0 + 0.15, z1 - 0.1, ['bottom']);
  return b;
}

/** The pit exit light: a post on a base plate, a housing with a red over a green lens facing -z */
function pitExitLight(lo, hi) {
  const b = new Builder();
  const cx = (lo[0] + hi[0]) / 2;
  const cz = (lo[2] + hi[2]) / 2;
  const top = hi[1];
  b.box('Building_White', cx - 0.3, cx + 0.3, SINK, 0.08, cz - 0.25, cz + 0.25, ['bottom']);
  b.box('Steel', cx - 0.06, cx + 0.06, 0.08, top - 0.9, cz - 0.06, cz + 0.06, ['bottom']);
  b.box('Housing', cx - 0.25, cx + 0.25, top - 0.95, top, lo[2] + 0.12, lo[2] + 0.42);
  for (const [mat, y] of [
    ['Lens_Red', top - 0.27],
    ['Lens_Green', top - 0.67],
  ]) {
    const pts = Array.from({ length: 8 }, (_, k) => [cx + 0.15 * Math.cos((k * Math.PI) / 4), y + 0.15 * Math.sin((k * Math.PI) / 4), lo[2] + 0.11]);
    b.polygon(mat, pts, [0, 0, -1]);
    b.box('Housing', cx - 0.19, cx + 0.19, y + 0.15, y + 0.19, lo[2], lo[2] + 0.12, ['back']);
  }
  return b;
}

/**
 * A radio mast: a tapering triangular lattice in red and white sections, rings and diagonals every section, two
 * dish antennas and a rod at the top, an aviation light. `footDrop` extends the legs to the ground.
 */
function radioMast(f) {
  const b = new Builder();
  const H = f.height;
  const base = Math.min(f.length, f.depth) * 0.9;
  const top = Math.max(1.0, base * 0.22);
  const sections = Math.max(6, Math.round(H / 3));
  const legAt = (k, y) => {
    const t = y / H;
    const r = (base * (1 - t) + top * t) / Math.sqrt(3);
    const ang = (k * 2 * Math.PI) / 3 + Math.PI / 2;
    return [r * Math.cos(ang), y, r * Math.sin(ang)];
  };
  for (let s = 0; s < sections; s++) {
    const ya = (s / sections) * H * 0.92;
    const yb = ((s + 1) / sections) * H * 0.92;
    const mat = Math.floor(s / 2) % 2 ? 'Mast_White' : 'Mast_Red';
    for (let k = 0; k < 3; k++) {
      const yStart = s === 0 ? SINK - f.footDrop : ya;
      b.beam(mat, legAt(k, yStart), legAt(k, yb), 0.16);
      b.beam(mat, legAt(k, yb), legAt((k + 1) % 3, yb), 0.07);
      b.beam(mat, legAt(k, ya), legAt((k + 1) % 3, yb), 0.06);
    }
  }
  // Top: a rod and an aviation light, two dishes facing out
  const yTop = H * 0.92;
  b.beam('Steel', [0, yTop, 0], [0, H, 0], 0.12);
  b.box('Lens_Red', -0.15, 0.15, H, H + 0.3, -0.15, 0.15);
  for (const [ang, y] of [
    [0.4, yTop - 3],
    [2.6, yTop - 6],
  ]) {
    const r = 0.9;
    const c = [Math.cos(ang) * (top / 2 + 0.6), y, Math.sin(ang) * (top / 2 + 0.6)];
    const out = [Math.cos(ang), 0, Math.sin(ang)];
    const side = [-Math.sin(ang), 0, Math.cos(ang)];
    const pts = Array.from({ length: 10 }, (_, k) => {
      const t = (k * 2 * Math.PI) / 10;
      return [c[0] + side[0] * r * Math.cos(t) + out[0] * 0.15, c[1] + r * Math.sin(t), c[2] + side[2] * r * Math.cos(t) + out[2] * 0.15];
    });
    b.polygon('Mast_White', pts, out);
    b.polygon('Mast_White', [...pts].reverse(), out.map((v) => -v));
    b.beam('Steel', [c[0] - out[0] * 0.5, y, c[2] - out[2] * 0.5], c, 0.08);
  }
  return b;
}

/**
 * A framed marquee: white walls with a darker window band, a pitched roof along the long side, gable ends, posts
 * at the corners and every ~5 m. `footDrop`: the posts reach the ground on slopes.
 */
function tent(f) {
  const b = new Builder();
  const L = f.length;
  const D = f.depth;
  const ridge = f.height;
  const eave = Math.min(ridge * 0.55, 4);
  const xL = -L / 2;
  const xR = L / 2;
  const zF = -D / 2;
  const zB = D / 2;
  const sink = SINK - f.footDrop;
  // Walls: fabric below and above a window band on the long sides, plain on the gable ends
  for (const [z, out] of [
    [zF, [0, 0, -1]],
    [zB, [0, 0, 1]],
  ]) {
    b.quad('Tent_Fabric', [xL, sink, z], [xR, sink, z], [xR, 1.1, z], [xL, 1.1, z], out);
    b.quad('Tent_Window', [xL, 1.1, z], [xR, 1.1, z], [xR, 2.3, z], [xL, 2.3, z], out);
    b.quad('Tent_Fabric', [xL, 2.3, z], [xR, 2.3, z], [xR, eave, z], [xL, eave, z], out);
  }
  // A long, narrow one is a row of pagoda tents, each with its own peaked roof
  if (L > 4 * D) {
    const k = Math.max(2, Math.round(L / (2 * D)));
    const w = L / k;
    for (let i = 0; i < k; i++) {
      const x0 = xL + i * w;
      const x1 = x0 + w;
      const peak = [(x0 + x1) / 2, ridge, 0];
      const c = [
        [x0 - 0.2, eave, zF - 0.2],
        [x1 + 0.2, eave, zF - 0.2],
        [x1 + 0.2, eave, zB + 0.2],
        [x0 - 0.2, eave, zB + 0.2],
      ];
      for (let j = 0; j < 4; j++) {
        const a = c[j];
        const bb = c[(j + 1) % 4];
        const out = [(a[0] + bb[0]) / 2 - peak[0], 1.2, (a[2] + bb[2]) / 2];
        b.quad('Tent_Fabric', a, bb, peak, peak, out);
      }
      for (const x of [x0, x1]) for (const z of [zF + 0.05, zB - 0.05]) b.box('Steel', x - 0.06, x + 0.06, sink, eave, z - 0.06, z + 0.06, ['bottom', 'top']);
    }
    for (const [x, out] of [
      [xL, [-1, 0, 0]],
      [xR, [1, 0, 0]],
    ])
      b.quad('Tent_Fabric', [x, sink, zF], [x, sink, zB], [x, eave, zB], [x, eave, zF], out);
    return b;
  }
  // A wide marquee gets one ridge per ~12 m of depth (a row of pitched bays), a small tent one ridge
  const ridges = Math.max(1, Math.round(D / 12));
  const bayD = D / ridges;
  const o = 0.25;
  for (let r = 0; r < ridges; r++) {
    const z0 = zF + r * bayD;
    const z1 = z0 + bayD;
    const zm = (z0 + z1) / 2;
    for (const [x, out] of [
      [xL, [-1, 0, 0]],
      [xR, [1, 0, 0]],
    ])
      b.polygon('Tent_Fabric', [[x, sink, z0], [x, eave, z0], [x, ridge, zm], [x, eave, z1], [x, sink, z1]], out);
    // Roof: two slopes meeting at the ridge, a little overhang at the outer edges
    const oF = r === 0 ? o : 0;
    const oB = r === ridges - 1 ? o : 0;
    b.quad('Tent_Fabric', [xL - o, eave - 0.1, z0 - oF], [xR + o, eave - 0.1, z0 - oF], [xR + o, ridge, zm], [xL - o, ridge, zm], [0, 1, -0.6]);
    b.quad('Tent_Fabric', [xL - o, eave - 0.1, z1 + oB], [xR + o, eave - 0.1, z1 + oB], [xR + o, ridge, zm], [xL - o, ridge, zm], [0, 1, 0.6]);
  }
  // Frame: posts at the corners and along the long sides, the ridge beam
  const bays = Math.max(2, Math.round(L / 5));
  for (let i = 0; i <= bays; i++) {
    const x = xL + (L * i) / bays;
    for (const z of [zF + 0.05, zB - 0.05]) b.box('Steel', x - 0.06, x + 0.06, sink, eave, z - 0.06, z + 0.06, ['bottom', 'top']);
    if (i === 0 || i === bays) for (let r = 0; r < ridges; r++) { const zm = zF + (r + 0.5) * bayD; b.box('Steel', x - 0.06, x + 0.06, eave, ridge - 0.05, zm - 0.06, zm + 0.06, ['bottom']); }
  }
  return b;
}

/**
 * A TV camera platform: a scaffold tower (four legs, braces, a deck with a rail) to the original's height, a
 * broadcast camera on a tripod facing the track (-z), under an umbrella.
 */
function cameraPlatform(f) {
  const b = new Builder();
  const w = Math.max(1.6, Math.min(f.length, f.depth) * 0.9);
  const h = Math.max(2.5, f.height - 2.6); // deck height; camera and umbrella above it
  const half = w / 2;
  const sink = SINK - f.footDrop;
  const legs = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const [x, z] of legs) b.box('Steel', x - 0.05, x + 0.05, sink, h, z - 0.05, z + 0.05, ['bottom', 'top']);
  const levels = Math.max(2, Math.round(h / 1.8));
  for (let k = 0; k < levels; k++) {
    const ya = (k / levels) * h;
    const yb = ((k + 1) / levels) * h;
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = legs[i];
      const [x1, z1] = legs[(i + 1) % 4];
      b.beam('Steel', [x0, yb, z0], [x1, yb, z1], 0.05);
      b.beam('Steel', [x0, k % 2 ? ya : yb, z0], [x1, k % 2 ? yb : ya, z1], 0.04);
    }
  }
  // Deck, rail
  b.box('Steel', -half - 0.1, half + 0.1, h - 0.08, h, -half - 0.1, half + 0.1);
  for (const [x, z] of legs) b.box('Steel', x - 0.03, x + 0.03, h, h + 1.0, z - 0.03, z + 0.03, ['bottom']);
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = legs[i];
    const [x1, z1] = legs[(i + 1) % 4];
    b.beam('Steel', [x0, h + 1.0, z0], [x1, h + 1.0, z1], 0.05);
  }
  // Tripod and camera (body, lens towards -z, viewfinder), umbrella on a pole
  const top = h + 1.35;
  for (let k = 0; k < 3; k++) {
    const ang = (k * 2 * Math.PI) / 3;
    b.beam('Camera', [0.5 * Math.cos(ang), h, 0.5 * Math.sin(ang)], [0, top, 0.05], 0.035);
  }
  b.box('Camera', -0.14, 0.14, top, top + 0.32, -0.3, 0.3);
  b.box('Camera', -0.08, 0.08, top + 0.08, top + 0.24, -0.75, -0.3);
  b.box('Camera', 0.14, 0.24, top + 0.18, top + 0.32, 0.05, 0.25);
  const ux = 0.35;
  b.beam('Steel', [ux, h, half - 0.3], [ux, top + 1.0, half - 0.3], 0.04);
  const ur = 1.1;
  const uc = [ux, top + 1.0, half - 0.3];
  const rim = Array.from({ length: 8 }, (_, k) => [uc[0] + ur * Math.cos((k * Math.PI) / 4), uc[1] - 0.3, uc[2] + ur * Math.sin((k * Math.PI) / 4)]);
  for (let k = 0; k < 8; k++) {
    const p = rim[k];
    const q = rim[(k + 1) % 8];
    b.quad('Umbrella', uc, p, q, q, [0, 1, 0]);
    b.quad('Umbrella', uc, q, p, p, [0, -1, 0]);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const doc = new Document();
const buffer = doc.createBuffer();
doc.createExtension(EXTTextureWebP).setRequired(true);
doc.getRoot().getAsset().generator = 'LibreCorsa scripts/rwanda-props.mjs';

const material = (name, { colour = [1, 1, 1], rough = 0.6, metal = 0, map = null, doubleSided = false, emissive = null } = {}) => {
  const m = doc.createMaterial(name).setBaseColorFactor([...colour, 1]).setRoughnessFactor(rough).setMetallicFactor(metal).setDoubleSided(doubleSided);
  if (map) m.setBaseColorTexture(map);
  if (emissive) m.setEmissiveFactor(emissive);
  return m;
};

// The jumbotron screen: the owner's texture and the circuit material's own settings, under a plain name
const screenSrc = track
  .getRoot()
  .listMaterials()
  .find((m) => m.getBaseColorTexture()?.getName() === SCREEN_TEXTURE);
if (!screenSrc) throw new Error(`${SCREEN_TEXTURE} not found in ${TRACK}`);
const screenTexSrc = screenSrc.getBaseColorTexture();
const screenTex = doc.createTexture(SCREEN_TEXTURE).setImage(screenTexSrc.getImage().slice()).setMimeType(screenTexSrc.getMimeType());
const screenMat = material('Jumbotron_Screen', { colour: screenSrc.getBaseColorFactor().slice(0, 3), rough: screenSrc.getRoughnessFactor(), metal: screenSrc.getMetallicFactor(), map: screenTex });
screenMat.setEmissiveFactor(screenSrc.getEmissiveFactor());
if (screenSrc.getEmissiveTexture()) screenMat.setEmissiveTexture(screenTex);

const MATERIALS = {
  Building_White: material('Building_White', { colour: [0.84, 0.86, 0.88], rough: 0.6 }),
  Steel: material('Prop_Steel', { colour: [0.45, 0.47, 0.5], rough: 0.5, metal: 0.55 }),
  Jumbo_Frame: material('Jumbotron_Frame', { colour: [0.08, 0.09, 0.1], rough: 0.55, metal: 0.3 }),
  Housing: material('Light_Housing', { colour: [0.03, 0.03, 0.035], rough: 0.45 }),
  Lens_Red: material('Lens_Red', { colour: [0.25, 0.01, 0.01], rough: 0.15 }),
  Lens_Green: material('Lens_Green', { colour: [0.01, 0.16, 0.04], rough: 0.15 }),
  Lens_Amber: material('Lens_Amber', { colour: [0.3, 0.13, 0.0], rough: 0.15 }),
  Mast_Red: material('Mast_Red', { colour: [0.55, 0.06, 0.05], rough: 0.55, metal: 0.3 }),
  Mast_White: material('Mast_White', { colour: [0.82, 0.83, 0.84], rough: 0.55, metal: 0.3 }),
  Tent_Fabric: material('Tent_Fabric', { colour: [0.88, 0.89, 0.9], rough: 0.85, doubleSided: true }),
  Tent_Window: material('Tent_Window', { colour: [0.12, 0.14, 0.16], rough: 0.3 }),
  Camera: material('TV_Camera', { colour: [0.05, 0.05, 0.06], rough: 0.4, metal: 0.3 }),
  Umbrella: material('TV_Umbrella', { colour: [0.06, 0.45, 0.72], rough: 0.8 }),
};

const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
function toMesh(name, builder, extra = []) {
  const mesh = doc.createMesh(name);
  for (const [mat, p] of builder.parts) {
    const n = p.pos.length / 3;
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', accessor('VEC3', new Float32Array(p.pos)))
        .setAttribute('NORMAL', accessor('VEC3', new Float32Array(p.nor)))
        .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(p.uv)))
        .setIndices(accessor('SCALAR', n < 65536 ? new Uint16Array(p.idx) : new Uint32Array(p.idx)))
        .setMaterial(MATERIALS[mat])
    );
  }
  for (const prim of extra) mesh.addPrimitive(prim);
  return mesh;
}

const scene = doc.createScene('Props');
const root = doc.createNode('Scenery_Props');
scene.addChild(root);
const counts = {};
const place = (kind, name, mesh, translation, rotation, footprint) => {
  counts[kind] = (counts[kind] ?? 0) + 1;
  const node = doc.createNode(name).setMesh(mesh).setTranslation(translation).setRotation(rotation).setExtras({ props: kind, ...(footprint ? { footprint } : {}) });
  root.addChild(node);
  return node;
};

// Jumbotrons: the circuit's screen quad as it is, in a generated frame
{
  const f = nodeFrame('Prop_Jumbotron_0');
  const prim = f.node
    .getMesh()
    .listPrimitives()
    .find((p) => p.getMaterial()?.getBaseColorTexture()?.getName() === SCREEN_TEXTURE);
  const pos = prim.getAttribute('POSITION');
  const pts = Array.from({ length: pos.getCount() }, (_, i) => pos.getElement(i, [0, 0, 0]));
  const xs = pts.map((p) => p[0]);
  const left = pts[xs.indexOf(Math.min(...xs))];
  const right = pts[xs.indexOf(Math.max(...xs))];
  const span = [right[0] - left[0], 0, right[2] - left[2]];
  const width = Math.hypot(span[0], span[2]);
  const u = [span[0] / width, 0, span[2] / width];
  const nor = prim.getAttribute('NORMAL').getElement(0, [0, 0, 0]);
  const n = [nor[0], 0, nor[2]].map((v, _, a) => v / Math.hypot(a[0], a[2]));
  const ys = pts.map((p) => p[1]);
  const screen = { a: [left[0], 0, left[2]], u, n, width, y0: Math.min(...ys), y1: Math.max(...ys) };
  const copy = doc.createPrimitive().setMaterial(screenMat);
  for (const sem of prim.listSemantics()) {
    const a = prim.getAttribute(sem);
    copy.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setNormalized(a.getNormalized()).setBuffer(buffer));
  }
  if (prim.getIndices()) copy.setIndices(accessor('SCALAR', prim.getIndices().getArray().slice()));
  // All three share the model: the deepest drop of the three sets the legs
  const drops = ['Prop_Jumbotron_0', 'Prop_Jumbotron_1', 'Prop_Jumbotron_2'].map((name) => {
    const g = nodeFrame(name);
    const W = g.node.getWorldMatrix();
    const corners = [g.lo[0], g.hi[0]].flatMap((x) => [g.lo[2], g.hi[2]].map((z) => apply(W, [x, 0, z])));
    return Math.max(0, g.translation[1] - lowestGround(corners.map((c) => [c[0], c[2]]), g.translation[1]));
  });
  const mesh = toMesh('Jumbotron', jumbotron(screen, Math.max(...drops)), [copy]);
  for (const name of ['Prop_Jumbotron_0', 'Prop_Jumbotron_1', 'Prop_Jumbotron_2']) {
    const g = nodeFrame(name);
    place('jumbotron', name.replace('Prop_', 'Scenery_'), mesh, g.translation, g.rotation);
  }
}

// Start lights and the pit exit light: exactly the circuit's boxes and transforms
for (const [name, build, kind] of [
  ['Prop_StartLights_0', startLights, 'startLights'],
  ['Prop_PitExitLight', pitExitLight, 'pitExitLight'],
]) {
  const f = nodeFrame(name);
  place(kind, name.replace('Prop_', 'Scenery_'), toMesh(kind === 'startLights' ? 'Start_Lights' : 'Pit_Exit_Light', build(f.lo, f.hi)), f.translation, f.rotation, { lo: f.lo, hi: f.hi });
}

// The merged ones, split into their objects
for (const [name, kind, gap, build, opts] of [
  ['Prop_RadioMasts', 'radioMast', 3, radioMast, {}],
  ['Prop_Paddock_Tents', 'tent', 0.5, tent, {}],
  ['Prop_CameraPosts', 'cameraPlatform', 2, cameraPlatform, { faceRoad: true }],
]) {
  const frames = worldClusters(byName[name], gap)
    .map((pts) => clusterFrame(pts, opts))
    .sort((a, b) => a.x - b.x || a.z - b.z);
  const cache = new Map();
  frames.forEach((f, i) => {
    const key = `${f.length.toFixed(1)}:${f.depth.toFixed(1)}:${f.height.toFixed(1)}:${f.footDrop.toFixed(1)}`;
    if (!cache.has(key)) cache.set(key, toMesh(`${kind}_${cache.size + 1}`, build(f)));
    const footprint = { x: f.x, z: f.z, yaw: f.yaw, length: f.length, depth: f.depth, baseY: f.baseY };
    place(kind, `Scenery_${kind}_${String(i + 1).padStart(2, '0')}`, cache.get(key), [f.x, f.baseY, f.z], yawQuat(f.yaw), footprint);
  });
}

// ---------------------------------------------------------------------------
// The helicopter (Sketchfab, CC BY): helicopter only, simplified, at the circuit's spot
// ---------------------------------------------------------------------------
{
  const heli = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(HELI_SRC);
  for (const a of heli.getRoot().listAnimations()) a.dispose();
  // The model also carries a figure (Wolf3D materials): leave it out
  for (const node of heli.getRoot().listNodes()) {
    const m = node.getMesh();
    if (m && m.listPrimitives().some((p) => /^Wolf3D/.test(p.getMaterial()?.getName() ?? ''))) node.setMesh(null);
  }
  for (const skin of heli.getRoot().listSkins()) skin.dispose();
  await heli.transform(prune(), flatten());
  const mesh = heli.createMesh('Helicopter');
  for (const node of heli.getRoot().listNodes()) {
    const m = node.getMesh();
    if (!m) continue;
    transformMesh(m, node.getWorldMatrix());
    for (const p of m.listPrimitives()) {
      for (const sem of ['TANGENT', 'TEXCOORD_1', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0']) if (p.getAttribute(sem)) p.setAttribute(sem, null);
      mesh.addPrimitive(p);
      m.removePrimitive(p);
    }
  }
  for (const n of heli.getRoot().listNodes()) n.dispose();
  for (const s of heli.getRoot().listScenes()) s.dispose();
  heli.createScene('Helicopter').addChild(heli.createNode('Helicopter').setMesh(mesh));
  for (const mat of heli.getRoot().listMaterials()) {
    mat.setNormalTexture(null).setOcclusionTexture(null).setEmissiveTexture(null).setMetallicRoughnessTexture(null);
    mat.setMetallicFactor(0.2).setRoughnessFactor(0.45);
    mat.setName(`Helicopter_${mat.getName().replace(/\W+/g, '_')}`);
  }
  await heli.transform(weld(), dedup());
  let before = 0;
  let after = 0;
  for (const p of mesh.listPrimitives()) {
    before += p.getIndices().getCount() / 3;
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ratio: 0.5, error: 0.004, lockBorder: true });
    after += p.getIndices().getCount() / 3;
  }
  // Centre the footprint on the origin, base on y = 0; the fuselage runs along z like the circuit's helicopter
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.listPrimitives()) {
    const a = p.getAttribute('POSITION').getMin([0, 0, 0]);
    const b = p.getAttribute('POSITION').getMax([0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  transformMesh(mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2, 1]);
  await heli.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }), prune({ keepAttributes: true, keepIndices: true }));
  console.log(`  Helicopter: ${before} → ${after} triangles, ${(hi[0] - lo[0]).toFixed(1)} × ${(hi[1] - lo[1]).toFixed(1)} × ${(hi[2] - lo[2]).toFixed(1)} m`);
  const { mergeDocuments } = await import('@gltf-transform/functions');
  const map = mergeDocuments(doc, heli);
  const heliMesh = map.get(mesh);
  for (const s of doc.getRoot().listScenes()) if (s !== scene) s.dispose();
  for (const n of doc.getRoot().listNodes()) if (n.getMesh() === heliMesh && n !== root) n.dispose();
  const f = nodeFrame('Prop_Helicopter');
  place('helicopter', 'Scenery_Helicopter', heliMesh, [f.translation[0], f.translation[1] + f.lo[1], f.translation[2]], f.rotation);
}

root.setExtras({ replaces: REPLACES, counts, credits: CREDITS, source: 'generated by scripts/rwanda-props.mjs, helicopter from Sketchfab (see credits)' });
doc.getRoot().getAsset().copyright = CREDITS.map((cr) => `"${cr.title}" by ${cr.author} (${cr.url}), ${cr.license}; changes: ${cr.changes}`).join(' | ') + '; everything else generated for LibreCorsa';

const { unpartition } = await import('@gltf-transform/functions');
await doc.transform(unpartition(), dedup(), prune({ keepAttributes: true, keepIndices: true }));
mkdirSync(dirname(OUT), { recursive: true });
await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(OUT, doc);
const tris = doc
  .getRoot()
  .listNodes()
  .reduce((s, n) => s + (n.getMesh()?.listPrimitives().reduce((t, p) => t + (p.getIndices()?.getCount() ?? 0) / 3, 0) ?? 0), 0);
console.log(`Wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(2)} MB): ${JSON.stringify(counts)}, ${tris} triangles drawn`);
