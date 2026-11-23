/**
 * The cone lanes of circuits whose course is laid out in cones (src/lib/sim/cone-lanes.ts): each cone of the layout's
 * cone mesh, the cones on each side of the lap joined into a line, and the lane between the two lines (out to the
 * cones' outer edges) as world outlines, a strip per stretch of the lap.
 *
 * The cone mesh comes apart at every face seam, so its vertices are clustered by position (`CLUSTER_M`) into cones.
 * Each cone is placed on the lap by its nearest centreline point (lap distance s, lateral offset, + right of travel)
 * and joins the line on its side; between two cones a line's offset runs linearly in s.
 *
 * The edges written for the AI (`CONE_LANE_EDGES`) also stop `WALL_ROOM_M` short of a barrier standing inside the
 * lane (a tyre wall at the inner course's skid pad exit, s 738-752, stands 1 m inside the cones); the track limits
 * stay on the cones.
 *
 *   npx tsx scripts/tracks/generate-cone-lanes.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { getActiveTrackData, getActiveTrackMetadata, setActiveTrack, type RawTrackJson } from '../../src/lib/track-data';
import { TrackWallQuery } from '../../src/lib/sim/f12026-car/TrackColliderQuery';
import { roadFacing } from '../../src/lib/sim/track-colliders';
import { loadGlbGeometry, trackModelFiles } from '../lib/glb-geometry';

interface ConeLayout {
  id: string;
  /** The drawn material of its cones */
  coneMaterial: string;
  /** Cones wider than this (m) are other things on the same material */
  maxConeM: number;
}
const LAYOUTS: ConeLayout[] = [{ id: 'spielberg_inner', coneMaterial: '01 - Default_spielberg_inner', maxConeM: 0.5 }];
/** Vertices this close (m, on a grid of this size) belong to one cone */
const CLUSTER_M = 0.35;
/** A cone's radius at the ground (m): the lane reaches its outer edge */
const CONE_RADIUS_M = 0.15;
/** Lap length of each outline strip and their overlap (m) */
const STRIP_M = 40;
const OVERLAP_M = 2;
const STEP_M = 1;
/** Spacing of the lane edges written for the AI (m of lap) */
const BOUNDS_STEP_M = 1;
/** How far the AI's edge stays from a barrier inside the lane (m) */
const WALL_ROOM_M = 0.5;
const OUT = 'src/lib/sim/cone-lanes.ts';

type Cone = { x: number; z: number; s: number; lat: number };

function cones(root: THREE.Object3D, layout: ConeLayout): { x: number; z: number }[] {
  root.updateMatrixWorld(true);
  const pts: [number, number][] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const name = (Array.isArray(m.material) ? '' : m.material?.name) || (m.userData.materialName as string | undefined) || '';
    if (name !== layout.coneMaterial && !m.name.startsWith(`${layout.coneMaterial}_chunk`)) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      pts.push([v.x, v.z]);
    }
  });
  // Cluster on a grid: cells holding vertices join their occupied neighbours
  const cell = (x: number, z: number) => `${Math.floor(x / CLUSTER_M)},${Math.floor(z / CLUSTER_M)}`;
  const cells = new Map<string, number[]>();
  pts.forEach(([x, z], i) => {
    const k = cell(x, z);
    const l = cells.get(k);
    if (l) l.push(i);
    else cells.set(k, [i]);
  });
  const keys = [...cells.keys()];
  const index = new Map(keys.map((k, i) => [k, i]));
  const parent = keys.map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  keys.forEach((k, i) => {
    const [cx, cz] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const j = index.get(`${cx + dx},${cz + dz}`);
        if (j !== undefined) parent[find(j)] = find(i);
      }
    }
  });
  const groups = new Map<number, number[]>();
  keys.forEach((k, i) => {
    const r = find(i);
    const l = groups.get(r) ?? [];
    l.push(...cells.get(k)!);
    groups.set(r, l);
  });
  const out: { x: number; z: number }[] = [];
  for (const g of groups.values()) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of g) {
      x0 = Math.min(x0, pts[i][0]);
      x1 = Math.max(x1, pts[i][0]);
      z0 = Math.min(z0, pts[i][1]);
      z1 = Math.max(z1, pts[i][1]);
    }
    if (Math.max(x1 - x0, z1 - z0) <= layout.maxConeM) out.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2 });
  }
  return out;
}

/** Whether a closed outline (x, z pairs) crosses itself */
function selfCrosses(o: number[]): boolean {
  const n = o.length / 2;
  const seg = (i: number) => [o[2 * i], o[2 * i + 1], o[2 * ((i + 1) % n)], o[2 * ((i + 1) % n) + 1]];
  const cross = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  for (let i = 0; i < n; i++) {
    const [a, b, c, d] = seg(i);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [e, f, g, h] = seg(j);
      const d1 = cross(a, b, c, d, e, f), d2 = cross(a, b, c, d, g, h), d3 = cross(e, f, g, h, a, b), d4 = cross(e, f, g, h, c, d);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

const blocks: string[] = [];
const bounds: string[] = [];
for (const layout of LAYOUTS) {
  setActiveTrack(layout.id, JSON.parse(readFileSync(`public/tracks/${layout.id}/track_data.json`, 'utf8')) as RawTrackJson);
  const track = getActiveTrackData(1200);
  const L = track.totalLengthM;
  const files = trackModelFiles(track);
  const samples: { s: number; x: number; z: number; bx: number; bz: number }[] = [];
  for (let s = 0; s < L; s += 0.25) {
    const q = track.getSampleAtDistance(s);
    const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
    samples.push({ s, x: q.position.x, z: q.position.z, bx: q.binormal.x / bl, bz: q.binormal.z / bl });
  }
  const root = loadGlbGeometry(files.path, files.shared);
  const walls = TrackWallQuery.fromTrackRoot(root, getActiveTrackMetadata().mesh?.barrierMeshes, roadFacing);
  const placed: Cone[] = cones(root, layout).map((c) => {
    let best = samples[0], bd = Infinity;
    for (const p of samples) {
      const d = (p.x - c.x) ** 2 + (p.z - c.z) ** 2;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return { ...c, s: best.s, lat: (c.x - best.x) * best.bx + (c.z - best.z) * best.bz };
  });
  // Each side's line: its cones by s, the offset between two cones linear in s (round the lap's end too)
  const line = (side: -1 | 1) => {
    const l = placed.filter((c) => Math.sign(c.lat) === side).sort((a, b) => a.s - b.s);
    return (s: number) => {
      let i = l.findIndex((c) => c.s > s);
      if (i < 0) i = 0;
      const b = l[i], a = l[(i - 1 + l.length) % l.length];
      const sa = a.s > s ? a.s - L : a.s, sb = b.s < s ? b.s + L : b.s;
      const t = sb === sa ? 0 : (s - sa) / (sb - sa);
      return a.lat + (b.lat - a.lat) * t + side * CONE_RADIUS_M;
    };
  };
  const left = line(-1), right = line(1);
  const sides = [-1, 1].map((sd) => placed.filter((c) => Math.sign(c.lat) === sd).length);
  let minW = Infinity, maxW = 0;
  const outlines: number[][] = [];
  for (let s0 = 0; s0 < L; s0 += STRIP_M) {
    // (the last strip runs on past the line onto the first)
    const s1 = Math.min(L + OVERLAP_M, s0 + STRIP_M + OVERLAP_M);
    const l: number[] = [], r: number[] = [];
    for (let s = s0; s <= s1 + 1e-6; s += STEP_M) {
      const q = track.getSampleAtDistance(s % L);
      const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
      const bx = q.binormal.x / bl, bz = q.binormal.z / bl;
      const a = left(s % L), b = right(s % L);
      minW = Math.min(minW, b - a);
      maxW = Math.max(maxW, b - a);
      l.push(+(q.position.x + bx * a).toFixed(2), +(q.position.z + bz * a).toFixed(2));
      r.push(+(q.position.x + bx * b).toFixed(2), +(q.position.z + bz * b).toFixed(2));
    }
    const outline = [...l];
    for (let i = r.length - 2; i >= 0; i -= 2) outline.push(r[i], r[i + 1]);
    if (selfCrosses(outline)) throw new Error(`${layout.id}: the strip from s ${s0} crosses itself`);
    outlines.push(outline);
  }
  console.log(`${layout.id}: ${placed.length} cones (${sides[0]} left, ${sides[1]} right); lane ${minW.toFixed(2)}-${maxW.toFixed(2)} m wide between the cones' outer edges; ${outlines.length} strips`);
  // The lane's edges across the lap every BOUNDS_STEP_M, for the AI's usable road
  const n = Math.round(L / BOUNDS_STEP_M);
  const lo: number[] = [], hi: number[] = [];
  const ids = new Int32Array(8);
  let walled = 0;
  for (let i = 0; i < n; i++) {
    const s = (i * L) / n;
    let a = left(s), b = right(s);
    // A barrier inside the lane: the edge stops short of it, stepping out from the lane's middle
    const q = track.getSampleAtDistance(s);
    const bl = Math.hypot(q.binormal.x, q.binormal.z) || 1;
    const wallAt = (lat: number) => walls.near(q.position.x + (q.binormal.x / bl) * lat, q.position.z + (q.binormal.z / bl) * lat, 0.05, ids) > 0;
    const mid = 0.5 * (a + b);
    for (let lat = mid; lat >= a; lat -= 0.05) if (wallAt(lat)) { a = lat + WALL_ROOM_M; walled++; break; }
    for (let lat = mid; lat <= b; lat += 0.05) if (wallAt(lat)) { b = lat - WALL_ROOM_M; walled++; break; }
    lo.push(+a.toFixed(2));
    hi.push(+b.toFixed(2));
  }
  console.log(`${layout.id}: AI edges stop at a barrier inside the lane at ${walled} of ${n} points`);
  const name = layout.id.toUpperCase();
  blocks.push(
    `/** ${layout.id}: ${placed.length} cones, the lane ${minW.toFixed(1)}-${maxW.toFixed(1)} m wide */`,
    `export const ${name}_CONE_LANE: readonly (readonly number[])[] = [`,
    ...outlines.map((o) => `  [${o.join(', ')}],`),
    '];',
    '',
  );
  bounds.push(`  ${layout.id}: {`, `    lo: [${lo.join(', ')}],`, `    hi: [${hi.join(', ')}],`, '  },');
}
writeFileSync(
  OUT,
  [
    '/**',
    ' * The lanes of circuits laid out in cones: the lane between the cones on either side of the lap, out to the',
    " * cones' outer edges, as world outlines (x, z pairs, m), a strip per 40 m of the lap. drawn-surfaces.ts makes the",
    ' * lane the track and the ground round it off it. Made by scripts/tracks/generate-cone-lanes.ts; not edited by hand.',
    ' */',
    '',
    ...blocks,
    '/**',
    " * Each lane's edges across the lap (lateral offsets from the centreline, m, + right of travel, out to the cones'",
    ' * outer edges), at equal steps of lap distance from the line: the AI keeps to them (`coneLaneRangeAt`)',
    ' */',
    'export const CONE_LANE_EDGES: Readonly<Record<string, { lo: readonly number[]; hi: readonly number[] }>> = {',
    ...bounds,
    '};',
    '',
    '/** The lane edges [left, right] at lap distance s on a circuit laid out in cones, or null */',
    'export function coneLaneRangeAt(trackId: string | undefined, s: number, lengthM: number): [number, number] | null {',
    '  const e = trackId ? CONE_LANE_EDGES[trackId] : undefined;',
    '  if (!e) return null;',
    '  const n = e.lo.length;',
    '  const u = ((((s / lengthM) % 1) + 1) % 1) * n;',
    '  const i = Math.floor(u) % n, j = (i + 1) % n, t = u - Math.floor(u);',
    '  return [e.lo[i] + (e.lo[j] - e.lo[i]) * t, e.hi[i] + (e.hi[j] - e.hi[i]) * t];',
    '}',
    '',
  ].join('\n'),
);
console.log(`-> ${OUT}`);
process.exit(0);
