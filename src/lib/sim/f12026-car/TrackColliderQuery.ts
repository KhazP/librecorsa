/**
 * Ground queries against a circuit's glTF track colliders for `VehiclePhysics`.
 *
 * Node contract (see scripts/rwanda-official/bl_track.py):
 *  - `Track_Collider_Road` (`userData.collider = 'road'`): low-res drivable surface, road ± (half width + 1.6 m).
 *    It carries no grip/surface tags, so it reads as `surface: 'road'`, `grip: 1` unless tagged.
 *  - Visual surfaces tagged with `userData.surface` and optionally `userData.grip`:
 *    `Track_Asphalt_Road` (road, 1.0), `Track_Kerbs` (kerb), `Track_Kerbs_Sausage` (sausage),
 *    `Track_Runoff_Paint` (runoff, 0.75), `Track_Pitlane` (pitlane), `Terrain` (grass).
 *
 * Height comes from the highest drivable visual surface under the wheel (road, run-off, pit lane, gravel): those
 * are swept at the full sample resolution, so they carry the real vertical curves. The road collider (one row every
 * 6 m, three points across) fills in where no drivable surface exists, or where the only one lies more than 0.5 m
 * under it (the road beneath a bridge). A kerb or sausage above that ground carries the wheel at its modelled height,
 * up to its surface's `maxRiseM`; failing all of these, the highest tagged surface (terrain) is used. The surface /
 * grip of a contact is the top-most tagged surface within `SURFACE_MATCH_M` of the contact height, falling back to
 * the contact layer's own tags. Converted circuits built with `conformSurfaces` fit their off-road bands to the road
 * first and take them off it where another stretch's bands cover it (`clearOffroadOverRoad`), and then also drive on
 * their grass and let a kerb fitted just under the road name the surface.
 *
 * Queries are vertical rays (the wheels probe straight down), answered from a uniform XZ grid of
 * world-space triangles, so a query costs a cell lookup plus a handful of 2D triangle tests. `queryMany` answers a
 * tyre's contact patch (several points a few centimetres apart) with one pass over the cell's triangles.
 *
 * Each surface kind's physics comes from the track's surface table (track-surfaces.ts). Its ripple (kerb
 * serrations, grass and gravel bumps) is added to the contact height analytically: along the surface from the
 * mesh's `TEXCOORD_0` u (× `userData.uvScaleM` metres, default `DEFAULT_UV_SCALE_M`), faded in across it by
 * sin(π·v), as the kerb's hump rises from both edges.
 */

import * as THREE from 'three';
import {
  DEFAULT_SURFACE_TABLE,
  isTrackSurfaceKind,
  surfaceRippleM,
  type SurfaceProps,
  type SurfaceTable,
  type TrackSurfaceKind,
} from '../track-surfaces';

export type { TrackSurfaceKind, SurfaceProps } from '../track-surfaces';

/** Grip when a node has `userData.surface` but no `userData.grip` */
export const DEFAULT_SURFACE_GRIP = Object.fromEntries(
  Object.entries(DEFAULT_SURFACE_TABLE).map(([k, v]) => [k, v.friction])
) as Record<TrackSurfaceKind, number>;

/** Metres along a surface per unit of its texture u, when the node has no `userData.uvScaleM` (the kerb texture's repeat) */
const DEFAULT_UV_SCALE_M = 6;

/** Surfaces allowed to raise the contact above the road collider */
const RAISED_SURFACES: ReadonlySet<TrackSurfaceKind> = new Set(['kerb', 'sausage']);
/** Swept visual surfaces a car drives on (the grass too on fitted circuits; kerbs and sausages rise above them) */
const DRIVABLE_SURFACES: ReadonlySet<TrackSurfaceKind> = new Set(['road', 'runoff', 'pitlane', 'gravel']);
const SURFACE_MATCH_M = 0.05;
const CELL_SIZE_M = 4;
/**
 * Margin of `queryMany`'s triangle box test (m): a point the barycentric test accepts lies at most 1e-6 of the
 * triangle's size outside it (microns on the largest terrain triangles), so the box test never rejects one it keeps
 */
const TRI_BOX_MARGIN_M = 1e-3;
/**
 * A grid cell listing more triangles than this is split into finer cells (`splitDenseCells`): a busy stretch of a
 * circuit (Spielberg had one 4 m cell of 458 triangles, against 9 for a typical one) cost a car a whole frame there
 */
const DENSE_CELL_TRIS = 64;
/** A split cell aims for about this many triangles in each of its finer cells, in at most 8 × 8 of them */
const SPLIT_CELL_TRIS = 16;
const SPLIT_MAX = 8;
/** Most points one `queryMany` answers (a contact patch takes five) */
export const GROUND_QUERY_MANY_MAX = 8;
/** Tagged surfaces kept per point to classify its contact */
const MAX_TAGS = 32;
/** Candidate slots per scanned point: the highest road-collider, raised (kerb, sausage), any and drivable surface */
const CAND_ROAD = 0;
const CAND_RAISED = 1;
const CAND_ANY = 2;
const CAND_DRIVE = 3;

export interface GroundHit {
  /** Contact height (world Y, m) */
  height: number;
  /** Unit surface normal (world) */
  nx: number;
  ny: number;
  nz: number;
  surface: TrackSurfaceKind;
  /** `userData.grip` of the surface (or its table friction) */
  grip: number;
  /** The surface's entry in the track's surface table */
  props: SurfaceProps;
  /** Name of the node the surface tags came from */
  source: string;
}

/** Anything that can answer "what is under this XZ point, at or below probeY" */
export interface GroundQuery {
  query(x: number, z: number, probeY: number, out: GroundHit): boolean;
  /** The ground with the kerbs left out (the circuit's colliders only): what a kerb stands on */
  queryBase?(x: number, z: number, probeY: number, out: GroundHit): boolean;
  /**
   * The ground is a smooth analytic surface (flat, or interpolated from the track samples) with no texture or seams for
   * a tyre's contact patch to envelope: the tyres probe it at their centre alone
   */
  readonly smooth?: boolean;
  /**
   * `query` answers from the point alone, never from the ground's own earlier queries: a car's settle on it is the same
   * whenever the car is, so it can be reused (`settle-memo.ts`)
   */
  readonly stateless?: boolean;
  /**
   * Optional: `query` for up to `GROUND_QUERY_MANY_MAX` nearby points at once (a tyre's contact patch), for a ground
   * that can share work between them. Returns a bit mask, bit i set when point i has ground (in `outs[i]`); points
   * from `fullCount` (default all) on may get only their height.
   */
  queryMany?(
    xs: ArrayLike<number>,
    zs: ArrayLike<number>,
    count: number,
    probeY: number,
    outs: readonly GroundHit[],
    fullCount?: number
  ): number;
}

interface Layer {
  name: string;
  /** Road collider: provides height but only default tags */
  isRoadCollider: boolean;
  surface: TrackSurfaceKind;
  grip: number;
  props: SurfaceProps;
  /** Explicitly tagged with `userData.surface` */
  tagged: boolean;
  /** Swept drivable surface (road, runoff, pitlane, gravel, or Track_Surface_Grass verge, excluding coarse Terrain) */
  drivable: boolean;
  /** Metres along the surface per texture u; 0 when the layer has no ripple */
  uvScaleM: number;
}

/**
 * A ground collider's data as typed arrays and plain values: all a `TrackColliderQuery` is made of, with no reference
 * to the track mesh it was built from. Structured-clonable, so a collider built where the mesh is loaded can be handed
 * to a worker (`toBuffers` / `fromBuffers`); the typed arrays may be transferred rather than copied.
 */
export interface TrackColliderBuffers {
  tris: Float32Array;
  triLayer: Uint8Array;
  triUVAt: Int32Array;
  triUV: Float32Array;
  triNormal: Float32Array;
  triVertNormal: Float32Array;
  layers: ColliderLayerData[];
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  cellStart: Uint32Array;
  cellTris: Uint32Array;
  /** Per grid cell: -1, or the first of the k × k finer cells it is split into (`cellSplitK` holds k) */
  cellSplit: Int32Array;
  cellSplitK: Uint8Array;
  fitted: boolean;
}

/** A collider layer's surface tags (plain data) */
export type ColliderLayerData = Layer;

export interface ColliderLayerSource {
  object: THREE.Object3D;
  /** Overrides for the node's `userData` */
  surface?: TrackSurfaceKind;
  grip?: number;
  isRoadCollider?: boolean;
}

function asSurface(v: unknown): TrackSurfaceKind | null {
  return isTrackSurfaceKind(v) ? v : null;
}

/** Cell of coordinate `v` on a grid axis starting at `min` with `n` cells of CELL_SIZE_M, clamped to the grid */
function gridCell(v: number, min: number, n: number): number {
  return Math.min(n - 1, Math.max(0, Math.floor((v - min) / CELL_SIZE_M)));
}

/**
 * Uniform XZ grid over [minX, maxX] × [minZ, maxZ] in CELL_SIZE_M cells, as CSR: cell c holds
 * items[cellStart[c] .. cellStart[c + 1]). Each of `count` items is listed in every cell its box overlaps;
 * `boxOf` fills [x0, z0, x1, z1] and returns false to leave an item out.
 */
function buildCsrGrid(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  count: number,
  boxOf: (i: number, box: Float64Array) => boolean
): { nx: number; nz: number; cellStart: Uint32Array; items: Uint32Array } {
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_M));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_M));
  const cellCount = nx * nz;
  const box = new Float64Array(4);
  const forEachCell = (i: number, fn: (cell: number) => void) => {
    if (!boxOf(i, box)) return;
    const cx0 = gridCell(box[0], minX, nx);
    const cx1 = gridCell(box[2], minX, nx);
    const cz0 = gridCell(box[1], minZ, nz);
    const cz1 = gridCell(box[3], minZ, nz);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * nx + cx);
  };
  // Two passes: count, then fill
  const cellStart = new Uint32Array(cellCount + 1);
  for (let i = 0; i < count; i++) forEachCell(i, (cell) => cellStart[cell + 1]++);
  for (let c = 0; c < cellCount; c++) cellStart[c + 1] += cellStart[c];
  const items = new Uint32Array(cellStart[cellCount]);
  const fill = cellStart.slice(0, cellCount);
  for (let i = 0; i < count; i++) forEachCell(i, (cell) => (items[fill[cell]++] = i));
  return { nx, nz, cellStart, items };
}

/**
 * Splits each grid cell of more than `DENSE_CELL_TRIS` items into k × k finer cells, each listing the cell's items
 * whose box (grown by `TRI_BOX_MARGIN_M`, so every triangle a point there could be inside is kept) overlaps it, in the
 * cell's own order. A query in a split cell then scans only its finer cell's list, and finds the same triangles in the
 * same order as it found in the whole cell's: the same answer, ties included. The finer cells follow the grid's cells
 * in `cellStart` (a split cell's own range is left empty); `cellAt` maps a point to one with the same arithmetic.
 */
function splitDenseCells(
  grid: { nx: number; nz: number; cellStart: Uint32Array; items: Uint32Array },
  minX: number,
  minZ: number,
  tris: Float32Array
): { cellStart: Uint32Array; items: Uint32Array; cellSplit: Int32Array; cellSplitK: Uint8Array } {
  const cells = grid.nx * grid.nz;
  const cellSplit = new Int32Array(cells).fill(-1);
  const cellSplitK = new Uint8Array(cells);
  let leaves = cells;
  for (let c = 0; c < cells; c++) {
    const count = grid.cellStart[c + 1] - grid.cellStart[c];
    if (count <= DENSE_CELL_TRIS) continue;
    const k = Math.min(SPLIT_MAX, Math.max(2, Math.ceil(Math.sqrt(count / SPLIT_CELL_TRIS))));
    cellSplit[c] = leaves;
    cellSplitK[c] = k;
    leaves += k * k;
  }
  if (leaves === cells) return { cellStart: grid.cellStart, items: grid.items, cellSplit, cellSplitK };
  /** A coordinate's finer column / row within its cell (`cellAt`'s arithmetic), clamped to the cell */
  const sub = (v: number, min: number, cell: number, k: number) => Math.min(k - 1, Math.max(0, Math.floor(((v - min) / CELL_SIZE_M - cell) * k)));
  const forEachLeaf = (c: number, t: number, fn: (leaf: number) => void) => {
    const k = cellSplitK[c];
    const cx = c % grid.nx;
    const cz = (c - cx) / grid.nx;
    const o = t * 9;
    const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]) - TRI_BOX_MARGIN_M;
    const x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]) + TRI_BOX_MARGIN_M;
    const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]) - TRI_BOX_MARGIN_M;
    const z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) + TRI_BOX_MARGIN_M;
    const sx0 = sub(x0, minX, cx, k);
    const sx1 = sub(x1, minX, cx, k);
    const sz0 = sub(z0, minZ, cz, k);
    const sz1 = sub(z1, minZ, cz, k);
    for (let sz = sz0; sz <= sz1; sz++) for (let sx = sx0; sx <= sx1; sx++) fn(cellSplit[c] + sz * k + sx);
  };
  const cellStart = new Uint32Array(leaves + 1);
  for (let c = 0; c < cells; c++) {
    if (cellSplit[c] < 0) cellStart[c + 1] = grid.cellStart[c + 1] - grid.cellStart[c];
    else for (let i = grid.cellStart[c]; i < grid.cellStart[c + 1]; i++) forEachLeaf(c, grid.items[i], (leaf) => cellStart[leaf + 1]++);
  }
  for (let l = 0; l < leaves; l++) cellStart[l + 1] += cellStart[l];
  const items = new Uint32Array(cellStart[leaves]);
  const fill = cellStart.slice(0, leaves);
  for (let c = 0; c < cells; c++) {
    if (cellSplit[c] < 0) items.set(grid.items.subarray(grid.cellStart[c], grid.cellStart[c + 1]), fill[c]);
    else for (let i = grid.cellStart[c]; i < grid.cellStart[c + 1]; i++) forEachLeaf(c, grid.items[i], (leaf) => (items[fill[leaf]++] = grid.items[i]));
  }
  return { cellStart, items, cellSplit, cellSplitK };
}

/** Closest point in XZ on triangle (a, b, c) to (px, pz), writing the interpolated 3D point and squared XZ distance */
function closestPointOnTriXZ(
  px: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  out: { x: number; y: number; z: number; d2: number }
): void {
  const abx = bx - ax;
  const abz = bz - az;
  const acx = cx - ax;
  const acz = cz - az;
  const apx = px - ax;
  const apz = pz - az;
  const d1 = abx * apx + abz * apz;
  const d2 = acx * apx + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out.x = ax;
    out.y = ay;
    out.z = az;
    out.d2 = apx * apx + apz * apz;
    return;
  }
  const bpx = px - bx;
  const bpz = pz - bz;
  const d3 = abx * bpx + abz * bpz;
  const d4 = acx * bpx + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out.x = bx;
    out.y = by;
    out.z = bz;
    out.d2 = bpx * bpx + bpz * bpz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out.x = ax + v * abx;
    out.y = ay + v * (by - ay);
    out.z = az + v * abz;
    const dx = px - out.x;
    const dz = pz - out.z;
    out.d2 = dx * dx + dz * dz;
    return;
  }
  const cpx = px - cx;
  const cpz = pz - cz;
  const d5 = abx * cpx + abz * cpz;
  const d6 = acx * cpx + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out.x = cx;
    out.y = cy;
    out.z = cz;
    out.d2 = cpx * cpx + cpz * cpz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out.x = ax + w * acx;
    out.y = ay + w * (cy - ay);
    out.z = az + w * acz;
    const dx = px - out.x;
    const dz = pz - out.z;
    out.d2 = dx * dx + dz * dz;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out.x = bx + w * (cx - bx);
    out.y = by + w * (cy - by);
    out.z = bz + w * (cz - bz);
    const dx = px - out.x;
    const dz = pz - out.z;
    out.d2 = dx * dx + dz * dz;
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out.x = ax + abx * v + acx * w;
  out.y = ay + (by - ay) * v + (cy - ay) * w;
  out.z = az + abz * v + acz * w;
  const dx = px - out.x;
  const dz = pz - out.z;
  out.d2 = dx * dx + dz * dz;
}

/**
 * Conforms `Track_Collider_Road`, `Track_Surface_Runoff`, `Track_Surface_Gravel`, and `Track_Surface_Grass`
 * vertices near `Track_Surface_Road` so off-road bands and 3-column road colliders meet the smoothed road edge
 * without vertical steps or wall-foot spikes.
 */
export function conformTrackSurfaceColliders(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const roadMeshes: THREE.Mesh[] = [];
  const offroadMeshes: { mesh: THREE.Mesh; kind: string }[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.name === 'Track_Surface_Road' || o.name === 'Track_Surface_Apron') {
      roadMeshes.push(o);
    } else if (
      o.name === 'Track_Collider_Road' ||
      o.name === 'Track_Surface_Runoff' ||
      o.name === 'Track_Surface_Gravel' ||
      o.name === 'Track_Surface_Grass'
    ) {
      offroadMeshes.push({ mesh: o, kind: o.name });
    }
  });
  if (roadMeshes.length === 0 || offroadMeshes.length === 0) {
    return;
  }

  const rTris: number[] = [];
  const rNorms: number[] = [];
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const rm of roadMeshes) {
    const geom = rm.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    if (!pos) continue;
    const idx = geom.getIndex();
    const n = idx ? idx.count : pos.count;
    const m = rm.matrixWorld;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      vA.fromBufferAttribute(pos, i0).applyMatrix4(m);
      vB.fromBufferAttribute(pos, i1).applyMatrix4(m);
      vC.fromBufferAttribute(pos, i2).applyMatrix4(m);
      const e1x = vB.x - vA.x;
      const e1y = vB.y - vA.y;
      const e1z = vB.z - vA.z;
      const e2x = vC.x - vA.x;
      const e2y = vC.y - vA.y;
      const e2z = vC.z - vA.z;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) continue;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      nx /= len;
      ny /= len;
      nz /= len;
      if (ny < 0.5) continue;
      rTris.push(vA.x, vA.y, vA.z, vB.x, vB.y, vB.z, vC.x, vC.y, vC.z);
      rNorms.push(nx, ny, nz);
      minX = Math.min(minX, vA.x, vB.x, vC.x);
      maxX = Math.max(maxX, vA.x, vB.x, vC.x);
      minZ = Math.min(minZ, vA.z, vB.z, vC.z);
      maxZ = Math.max(maxZ, vA.z, vB.z, vC.z);
    }
  }
  const numT = rTris.length / 9;
  if (numT === 0) {
    return;
  }

  const CELL = 12;
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  const buckets: number[][] = Array.from({ length: nx * nz }, () => []);
  for (let t = 0; t < numT; t++) {
    const o = t * 9;
    const x0 = Math.max(0, Math.floor((Math.min(rTris[o], rTris[o + 3], rTris[o + 6]) - minX) / CELL));
    const x1 = Math.min(nx - 1, Math.floor((Math.max(rTris[o], rTris[o + 3], rTris[o + 6]) - minX) / CELL));
    const z0 = Math.max(0, Math.floor((Math.min(rTris[o + 2], rTris[o + 5], rTris[o + 8]) - minZ) / CELL));
    const z1 = Math.min(nz - 1, Math.floor((Math.max(rTris[o + 2], rTris[o + 5], rTris[o + 8]) - minZ) / CELL));
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) buckets[cz * nx + cx].push(t);
    }
  }

  const vNormMap = new Map<string, [number, number, number]>();
  for (let t = 0; t < numT; t++) {
    const o = t * 9;
    const no = t * 3;
    const tnx = rNorms[no];
    const tny = rNorms[no + 1];
    const tnz = rNorms[no + 2];
    for (let k = 0; k < 3; k++) {
      const key = `${Math.round(rTris[o + k * 3] * 10)},${Math.round(rTris[o + k * 3 + 1] * 5)},${Math.round(rTris[o + k * 3 + 2] * 10)}`;
      const acc = vNormMap.get(key);
      if (acc) {
        acc[0] += tnx;
        acc[1] += tny;
        acc[2] += tnz;
      } else {
        vNormMap.set(key, [tnx, tny, tnz]);
      }
    }
  }
  for (let t = 0; t < numT; t++) {
    const o = t * 9;
    const no = t * 3;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < 3; k++) {
      const key = `${Math.round(rTris[o + k * 3] * 10)},${Math.round(rTris[o + k * 3 + 1] * 5)},${Math.round(rTris[o + k * 3 + 2] * 10)}`;
      const acc = vNormMap.get(key)!;
      sx += acc[0];
      sy += acc[1];
      sz += acc[2];
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    rNorms[no] = sx / l;
    rNorms[no + 1] = sy / l;
    rNorms[no + 2] = sz / l;
  }

  const cp = { x: 0, y: 0, z: 0, d2: 0 };
  const evalRoad = (
    x: number,
    y: number,
    z: number
  ): { yPlane: number; dOut: number; edgeX: number; edgeY: number; edgeZ: number; bnx: number; bny: number; bnz: number } | null => {
    const cx0 = Math.floor((x - minX) / CELL);
    const cz0 = Math.floor((z - minZ) / CELL);
    let bestD2 = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    let bestT = -1;
    for (let dz = -1; dz <= 1; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= nz) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= nx) continue;
        const b = buckets[cz * nx + cx];
        for (let k = 0; k < b.length; k++) {
          const t = b[k];
          const o = t * 9;
          if (Math.abs(rTris[o + 1] - y) > 4.0) continue;
          closestPointOnTriXZ(
            x,
            z,
            rTris[o],
            rTris[o + 1],
            rTris[o + 2],
            rTris[o + 3],
            rTris[o + 4],
            rTris[o + 5],
            rTris[o + 6],
            rTris[o + 7],
            rTris[o + 8],
            cp
          );
          if (cp.d2 < bestD2 && Math.abs(cp.y - y) < 3.5) {
            bestD2 = cp.d2;
            bestX = cp.x;
            bestY = cp.y;
            bestZ = cp.z;
            bestT = t;
          }
        }
      }
    }
    if (bestT < 0) return null;
    const dOut = Math.sqrt(bestD2);
    const no = bestT * 3;
    const bnx = rNorms[no];
    const bny = rNorms[no + 1];
    const bnz = rNorms[no + 2];
    const dySlope = THREE.MathUtils.clamp(-(bnx * (x - bestX) + bnz * (z - bestZ)) / Math.max(0.5, bny), -0.65 * dOut, 0.65 * dOut);
    return { yPlane: bestY + dySlope, dOut, edgeX: bestX, edgeY: bestY, edgeZ: bestZ, bnx, bny, bnz };
  };

  const cache = new Map<
    string,
    { yPlane: number; dOut: number; edgeX: number; edgeY: number; edgeZ: number; bnx: number; bny: number; bnz: number } | null
  >();
  const world = new THREE.Vector3();
  const toLocal = new THREE.Matrix4();
  for (const { mesh, kind } of offroadMeshes) {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    toLocal.copy(mesh.matrixWorld).invert();
    /** Writes a world-space vertex back into the mesh's own space (the road triangles are in world space) */
    const put = (i: number, wx: number, wy: number, wz: number) => {
      world.set(wx, wy, wz).applyMatrix4(toLocal);
      pos.setXYZ(i, world.x, world.y, world.z);
    };
    for (let i = 0; i < pos.count; i++) {
      world.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const x = world.x;
      const y = world.y;
      const z = world.z;
      const key = `${Math.round(x * 20)},${Math.round(y * 5)},${Math.round(z * 20)}`;
      let r = cache.get(key);
      if (r === undefined) {
        r = evalRoad(x, y, z);
        cache.set(key, r);
      }
      if (!r || r.dOut > 10.0 || Math.abs(y - r.yPlane) > 3.5) continue;
      if (kind === 'Track_Collider_Road') {
        if (r.dOut > 0.8 && r.dOut < 2.2) {
          const scale = 1.95;
          const nx = r.edgeX + (x - r.edgeX) * scale;
          const nz = r.edgeZ + (z - r.edgeZ) * scale;
          const dOutExt = r.dOut * scale;
          const dyExt = THREE.MathUtils.clamp(
            -(r.bnx * (nx - r.edgeX) + r.bnz * (nz - r.edgeZ)) / Math.max(0.5, r.bny),
            -0.65 * dOutExt,
            0.65 * dOutExt
          );
          put(i, nx, r.edgeY + dyExt, nz);
        } else {
          put(i, x, r.yPlane, z);
        }
      } else {
        const maxDev = r.dOut <= 0.35 ? 0.002 : Math.min(0.08, 0.015 * (r.dOut - 0.35));
        put(i, x, THREE.MathUtils.clamp(y, r.yPlane - maxDev, r.yPlane + maxDev), z);
      }
    }
    pos.needsUpdate = true;
  }
}

/** The off-road bands a converted circuit lays either side of its lap */
const OFFROAD_BANDS: ReadonlySet<string> = new Set(['Track_Surface_Runoff', 'Track_Surface_Gravel', 'Track_Surface_Grass']);
/** A band face this close (m) above or below the road under it lies on it (a bridge's deck or the road under one does not) */
const OVER_ROAD_HEIGHT_M = 1;
/**
 * A band face partly over the road is quartered until its pieces are this small (longest side, m), and then each
 * piece's middle decides: the cut follows the road's edge to within half of it
 */
const OVER_ROAD_PIECE_M = 0.25;

/**
 * Takes the run-off, gravel and grass bands off the lap's road (`Track_Surface_Road`, the band between its edges) where
 * they lie on it, once they are fitted to it (`conformTrackSurfaceColliders`). A converted circuit's bands run out from
 * each stretch of its lap to 12 m past the barriers (where it found none, 57 m out), so wherever another stretch of the
 * same lap passes within that reach, its road was covered: VIR's South course 55 m across open ground from the run
 * back, Norisring's two straights either side of one wall. Fitted onto the road, that grass named the surface and the
 * car on the asphalt was off the track, on grass grip. The road is under those faces, so they are dropped (the porter's
 * `offroadOverRoad` moves them at the build, where a circuit asks for it); a face partly over the road is quartered
 * until its middle, corners and side middles agree, or down to `OVER_ROAD_PIECE_M`. A band's own faces start at the
 * road's edge and keep every face, and the porter's own `Track_Surface_Apron`
 * (the mod's paved ground off the lap, Dunsfold's runways) is left as built. Returns the area dropped (m², per band).
 */
export function clearOffroadOverRoad(root: THREE.Object3D): Record<string, number> {
  root.updateMatrixWorld(true);
  const bands: THREE.Mesh[] = [];
  const road: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const forEachTri = (mesh: THREE.Mesh, fn: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, i0: number, i1: number, i2: number) => void) => {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position');
    if (!pos) return;
    const idx = geom.getIndex();
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      fn(a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld), b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld),
        c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld), i0, i1, i2);
    }
  };
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // A band's node may hold its mesh as a child (several primitives)
    let node: THREE.Object3D | null = o;
    while (node && node !== root && !OFFROAD_BANDS.has(node.name) && node.name !== 'Track_Surface_Road') node = node.parent;
    if (!node || node === root) return;
    if (OFFROAD_BANDS.has(node.name)) {
      bands.push(o);
      return;
    }
    forEachTri(o, (p, q, r) => {
      // Upward faces only: the road's skirts and steps are no ground to lie on
      const ny = (q.z - p.z) * (r.x - p.x) - (q.x - p.x) * (r.z - p.z);
      const len = Math.hypot((q.y - p.y) * (r.z - p.z) - (q.z - p.z) * (r.y - p.y), ny, (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
      if (len < 1e-9 || Math.abs(ny) / len < 0.5) return;
      road.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
    });
  });
  const dropped: Record<string, number> = {};
  if (road.length === 0 || bands.length === 0) return dropped;

  // The road's faces on an XZ grid, each listed in every cell its box overlaps
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < road.length; i += 3) {
    minX = Math.min(minX, road[i]);
    maxX = Math.max(maxX, road[i]);
    minZ = Math.min(minZ, road[i + 2]);
    maxZ = Math.max(maxZ, road[i + 2]);
  }
  const grid = buildCsrGrid(minX, minZ, maxX, maxZ, road.length / 9, (t, box) => {
    const o = t * 9;
    box[0] = Math.min(road[o], road[o + 3], road[o + 6]);
    box[1] = Math.min(road[o + 2], road[o + 5], road[o + 8]);
    box[2] = Math.max(road[o], road[o + 3], road[o + 6]);
    box[3] = Math.max(road[o + 2], road[o + 5], road[o + 8]);
    return true;
  });
  const onRoad = (x: number, y: number, z: number): boolean => {
    const fx = (x - minX) / CELL_SIZE_M;
    const fz = (z - minZ) / CELL_SIZE_M;
    if (fx < 0 || fz < 0 || fx >= grid.nx || fz >= grid.nz) return false;
    const cell = Math.floor(fz) * grid.nx + Math.floor(fx);
    for (let k = grid.cellStart[cell], end = grid.cellStart[cell + 1]; k < end; k++) {
      const o = grid.items[k] * 9;
      const v0x = road[o + 3] - road[o];
      const v0z = road[o + 5] - road[o + 2];
      const v1x = road[o + 6] - road[o];
      const v1z = road[o + 8] - road[o + 2];
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const px = x - road[o];
      const pz = z - road[o + 2];
      const u = (px * v1z - v1x * pz) / den;
      const v = (v0x * pz - px * v0z) / den;
      if (u < 0 || v < 0 || u + v > 1) continue;
      const h = road[o + 1] + u * (road[o + 4] - road[o + 1]) + v * (road[o + 7] - road[o + 1]);
      if (Math.abs(h - y) <= OVER_ROAD_HEIGHT_M) return true;
    }
    return false;
  };

  // A face as 3 corners of [x, y, z, u, v] (world position, texture coordinates)
  type Corner = number[];
  const votesOnRoad = (f: Corner[]): { all: boolean; none: boolean; middle: boolean } => {
    const mx = (f[0][0] + f[1][0] + f[2][0]) / 3;
    const my = (f[0][1] + f[1][1] + f[2][1]) / 3;
    const mz = (f[0][2] + f[1][2] + f[2][2]) / 3;
    const middle = onRoad(mx, my, mz);
    let n = middle ? 1 : 0;
    // The corners and the middles of the sides, each a tenth of the way in (a point on the road's edge is on neither side)
    for (let k = 0; k < 3; k++) {
      const p = f[k];
      const q = f[(k + 1) % 3];
      if (onRoad(p[0] + 0.1 * (mx - p[0]), p[1] + 0.1 * (my - p[1]), p[2] + 0.1 * (mz - p[2]))) n++;
      const sx = (p[0] + q[0]) / 2;
      const sy = (p[1] + q[1]) / 2;
      const sz = (p[2] + q[2]) / 2;
      if (onRoad(sx + 0.1 * (mx - sx), sy + 0.1 * (my - sy), sz + 0.1 * (mz - sz))) n++;
    }
    return { all: n === 7, none: n === 0, middle };
  };
  const mid = (p: Corner, q: Corner): Corner => p.map((v, k) => (v + q[k]) / 2);
  const areaXZ = (f: Corner[]) => Math.abs((f[1][0] - f[0][0]) * (f[2][2] - f[0][2]) - (f[2][0] - f[0][0]) * (f[1][2] - f[0][2])) / 2;
  const longestSide = (f: Corner[]) =>
    Math.max(Math.hypot(f[1][0] - f[0][0], f[1][2] - f[0][2]), Math.hypot(f[2][0] - f[1][0], f[2][2] - f[1][2]), Math.hypot(f[0][0] - f[2][0], f[0][2] - f[2][2]));

  for (const mesh of bands) {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const uv = geom.getAttribute('uv');
    const kept: Corner[][] = [];
    let droppedM2 = 0;
    forEachTri(mesh, (p, q, r, i0, i1, i2) => {
      const corner = (v: THREE.Vector3, i: number): Corner => [v.x, v.y, v.z, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0];
      let todo: Corner[][] = [[corner(p, i0), corner(q, i1), corner(r, i2)]];
      // (9 quarterings take a 100 m face under 0.25 m: the cap of 12 only guards against a degenerate one)
      for (let depth = 0; depth <= 12 && todo.length; depth++) {
        const next: Corner[][] = [];
        for (const f of todo) {
          const vote = votesOnRoad(f);
          const last = depth === 12 || longestSide(f) < OVER_ROAD_PIECE_M;
          if (vote.none || (last && !vote.all && !vote.middle)) kept.push(f);
          else if (vote.all || last) droppedM2 += areaXZ(f);
          else {
            const ab = mid(f[0], f[1]);
            const bc = mid(f[1], f[2]);
            const ca = mid(f[2], f[0]);
            next.push([f[0], ab, ca], [ab, f[1], bc], [ca, bc, f[2]], [ab, bc, ca]);
          }
        }
        todo = next;
      }
    });
    if (droppedM2 === 0) continue;
    // Rebuilt unindexed, in the mesh's own space, keeping its texture coordinates (the surface ripple reads them)
    const toLocal = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const positions = new Float32Array(kept.length * 9);
    const uvs = uv ? new Float32Array(kept.length * 6) : null;
    const v = new THREE.Vector3();
    kept.forEach((f, i) => {
      f.forEach((p, k) => {
        v.set(p[0], p[1], p[2]).applyMatrix4(toLocal);
        positions.set([v.x, v.y, v.z], i * 9 + k * 3);
        uvs?.set([p[3], p[4]], i * 6 + k * 2);
      });
    });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (uvs) out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    mesh.geometry = out;
    let name = mesh.name;
    for (let o: THREE.Object3D | null = mesh; o && o !== root; o = o.parent) if (OFFROAD_BANDS.has(o.name)) name = o.name;
    dropped[name] = (dropped[name] ?? 0) + droppedM2;
  }
  return dropped;
}

export class TrackColliderQuery implements GroundQuery {
  /** Each query starts from cleared scratch buffers: nothing carries over from the last */
  readonly stateless = true;
  /** Triangles: 9 floats each (a, b, c world positions) */
  private readonly tris: Float32Array;
  private readonly triLayer: Uint8Array;
  /** Per triangle, its offset into `triUV` (6 floats: u, v of a, b, c), or −1 when its layer has no ripple or no UVs */
  private readonly triUVAt: Int32Array;
  private readonly triUV: Float32Array;
  /** Precomputed unit normals (3 floats each) */
  private readonly triNormal: Float32Array;
  /** Precomputed smooth vertex normals per triangle (9 floats each: n0, n1, n2) */
  private readonly triVertNormal: Float32Array;
  private readonly layers: Layer[];
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  /** CSR grid: cell → [cellStart[c], cellStart[c+1]) into cellTris, the finer cells of split ones after the grid's */
  private readonly cellStart: Uint32Array;
  private readonly cellTris: Uint32Array;
  /** Per grid cell: -1, or its first finer cell, and how many across (`splitDenseCells`) */
  private readonly cellSplit: Int32Array;
  private readonly cellSplitK: Uint8Array;
  public readonly triangleCount: number;

  /**
   * Build from the loaded track root: `Track_Collider_Road` plus every node tagged `userData.surface`.
   * `prepare` runs on the root once its surfaces are fitted, before the layers are read (drawn-surfaces.ts).
   * Throws when the road collider is missing.
   */
  static fromTrackRoot(
    root: THREE.Object3D,
    table: SurfaceTable = DEFAULT_SURFACE_TABLE,
    options: { conformSurfaces?: boolean; prepare?: (root: THREE.Object3D) => void; splitDenseCells?: boolean } = {}
  ): TrackColliderQuery {
    if (options.conformSurfaces) {
      conformTrackSurfaceColliders(root);
      // After the fitting: the pieces kept of a face split here lie in its fitted plane, where the fitting left it
      clearOffroadOverRoad(root);
    }
    options.prepare?.(root);
    root.updateMatrixWorld(true);
    const sources: ColliderLayerSource[] = [];
    const found: { road?: THREE.Object3D } = {};
    root.traverse((obj) => {
      if (obj.name === 'Track_Collider_Road') found.road = obj;
      else if (asSurface(obj.userData?.surface) && !obj.userData?.collider) sources.push({ object: obj });
    });
    if (!found.road) throw new Error('TrackColliderQuery: Track_Collider_Road not found under the track root');
    sources.unshift({ object: found.road, isRoadCollider: true });
    return new TrackColliderQuery(sources, table, options);
  }

  /**
   * The surfaces were fitted to the road (`conformSurfaces`): every tagged mesh is ground the tyres can follow, and a
   * kerb fitted a touch under the road (within `SURFACE_MATCH_M`) still carries the wheel and names the surface.
   * Unfitted, the road collider's band is the ground next to the road and the top-most surface names it.
   */
  private readonly fitted: boolean;

  /** The collider rebuilt from its data (`toBuffers`), e.g. in a worker: no mesh, no rebuild, the same answers */
  static fromBuffers(buffers: TrackColliderBuffers): TrackColliderQuery {
    return new TrackColliderQuery(buffers);
  }

  /** This collider's data, sharing its arrays (not copies): see `TrackColliderBuffers` */
  toBuffers(): TrackColliderBuffers {
    return {
      tris: this.tris,
      triLayer: this.triLayer,
      triUVAt: this.triUVAt,
      triUV: this.triUV,
      triNormal: this.triNormal,
      triVertNormal: this.triVertNormal,
      layers: this.layers,
      minX: this.minX,
      minZ: this.minZ,
      nx: this.nx,
      nz: this.nz,
      cellStart: this.cellStart,
      cellTris: this.cellTris,
      cellSplit: this.cellSplit,
      cellSplitK: this.cellSplitK,
      fitted: this.fitted,
    };
  }

  constructor(
    sources: ColliderLayerSource[] | TrackColliderBuffers,
    table: SurfaceTable = DEFAULT_SURFACE_TABLE,
    /** `splitDenseCells: false` keeps every grid cell whole (scripts/verify-collider-split.ts compares the two) */
    options: { conformSurfaces?: boolean; splitDenseCells?: boolean } = {}
  ) {
    if (!Array.isArray(sources)) {
      this.fitted = sources.fitted;
      this.layers = sources.layers;
      this.tris = sources.tris;
      this.triLayer = sources.triLayer;
      this.triUVAt = sources.triUVAt;
      this.triUV = sources.triUV;
      this.triNormal = sources.triNormal;
      this.triVertNormal = sources.triVertNormal;
      this.triangleCount = sources.tris.length / 9;
      this.minX = sources.minX;
      this.minZ = sources.minZ;
      this.nx = sources.nx;
      this.nz = sources.nz;
      this.cellStart = sources.cellStart;
      this.cellTris = sources.cellTris;
      this.cellSplit = sources.cellSplit;
      this.cellSplitK = sources.cellSplitK;
      return;
    }
    const fitted = options.conformSurfaces === true;
    this.fitted = fitted;
    this.layers = [];
    const tri: number[] = [];
    const layerOf: number[] = [];
    const uvAt: number[] = [];
    const uvs: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (const src of sources) {
      const ud = src.object.userData ?? {};
      const isRoadCollider = src.isRoadCollider ?? ud.collider === 'road';
      const tagged = asSurface(ud.surface);
      const surface = src.surface ?? tagged ?? 'road';
      // A node may cap its own rise (`userData.maxRiseM`): faces renamed from a kerb keep the kerb's (drawn-surfaces.ts)
      const props = typeof ud.maxRiseM === 'number' ? { ...table[surface], maxRiseM: ud.maxRiseM } : table[surface];
      const grip = src.grip ?? (typeof ud.grip === 'number' ? ud.grip : props.friction);
      const ripple = !isRoadCollider && props.bumpHeightM > 0 && props.bumpLengthM > 0;
      const uvScaleM = ripple ? (typeof ud.uvScaleM === 'number' ? ud.uvScaleM : DEFAULT_UV_SCALE_M) : 0;
      if (this.layers.length >= 255) throw new Error('TrackColliderQuery: too many layers');
      const li = this.layers.length;
      const isTagged = !!(src.surface ?? tagged);
      const drivable = isTagged && (DRIVABLE_SURFACES.has(surface) || (fitted && surface === 'grass'));
      this.layers.push({ name: src.object.name, isRoadCollider, surface, grip, props, tagged: isTagged, drivable, uvScaleM });

      src.object.updateWorldMatrix(true, true);
      src.object.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const geom = o.geometry as THREE.BufferGeometry;
        const pos = geom.getAttribute('position');
        if (!pos) return;
        const index = geom.getIndex();
        const n = index ? index.count : pos.count;
        const m = o.matrixWorld;
        const uv = uvScaleM > 0 ? geom.getAttribute('uv') : undefined;
        for (let i = 0; i + 2 < n; i += 3) {
          const i0 = index ? index.getX(i) : i;
          const i1 = index ? index.getX(i + 1) : i + 1;
          const i2 = index ? index.getX(i + 2) : i + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(m);
          b.fromBufferAttribute(pos, i1).applyMatrix4(m);
          c.fromBufferAttribute(pos, i2).applyMatrix4(m);
          tri.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
          layerOf.push(li);
          if (uv) {
            uvAt.push(uvs.length);
            uvs.push(uv.getX(i0), uv.getY(i0), uv.getX(i1), uv.getY(i1), uv.getX(i2), uv.getY(i2));
          } else {
            uvAt.push(-1);
          }
        }
      });
    }

    this.tris = Float32Array.from(tri);
    this.triLayer = Uint8Array.from(layerOf);
    this.triUVAt = Int32Array.from(uvAt);
    this.triUV = Float32Array.from(uvs);
    this.triangleCount = layerOf.length;

    // Normals (facing up); drop vertical / degenerate triangles from the grid (walls, skirts)
    this.triNormal = new Float32Array(this.triangleCount * 3);
    this.triVertNormal = new Float32Array(this.triangleCount * 9);
    const keep: boolean[] = new Array(this.triangleCount);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let t = 0; t < this.triangleCount; t++) {
      const o = t * 9;
      const e1x = tri[o + 3] - tri[o];
      const e1y = tri[o + 4] - tri[o + 1];
      const e1z = tri[o + 5] - tri[o + 2];
      const e2x = tri[o + 6] - tri[o];
      const e2y = tri[o + 7] - tri[o + 1];
      const e2z = tri[o + 8] - tri[o + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-9) {
        keep[t] = false;
        continue;
      }
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      nx /= len;
      ny /= len;
      nz /= len;
      this.triNormal[t * 3] = nx;
      this.triNormal[t * 3 + 1] = ny;
      this.triNormal[t * 3 + 2] = nz;
      keep[t] = ny > 0.2;
      if (!keep[t]) continue;
      for (let k = 0; k < 3; k++) {
        minX = Math.min(minX, tri[o + k * 3]);
        maxX = Math.max(maxX, tri[o + k * 3]);
        minZ = Math.min(minZ, tri[o + k * 3 + 2]);
        maxZ = Math.max(maxZ, tri[o + k * 3 + 2]);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = minZ = 0;
      maxX = maxZ = 1;
    }

    // Build smooth vertex normals per layer so triangle edges and quad diagonals have C0 normal continuity
    {
      const vertMap = new Map<number, number>();
      // Vertices are welded on a 1 cm grid per layer; the key spans the collider's extent so no two cells share one
      const keyNX = Math.round((maxX - minX) * 100) + 1;
      const keyNZ = Math.round((maxZ - minZ) * 100) + 1;
      const vNormPool = new Float64Array(this.triangleCount * 9);
      const triVertIdx = new Int32Array(this.triangleCount * 3);
      let poolCount = 0;
      for (let t = 0; t < this.triangleCount; t++) {
        if (!keep[t]) continue;
        const o = t * 9;
        const li = this.triLayer[t];
        const fnx = this.triNormal[t * 3];
        const fny = this.triNormal[t * 3 + 1];
        const fnz = this.triNormal[t * 3 + 2];
        for (let k = 0; k < 3; k++) {
          const vx = Math.round((tri[o + k * 3] - minX) * 100);
          const vz = Math.round((tri[o + k * 3 + 2] - minZ) * 100);
          const key = (li * keyNX + vx) * keyNZ + vz;
          let vi = vertMap.get(key);
          if (vi === undefined) {
            vi = poolCount++;
            vertMap.set(key, vi);
          }
          triVertIdx[t * 3 + k] = vi;
          const po = vi * 3;
          vNormPool[po] += fnx;
          vNormPool[po + 1] += fny;
          vNormPool[po + 2] += fnz;
        }
      }
      for (let vi = 0; vi < poolCount; vi++) {
        const po = vi * 3;
        const l = Math.hypot(vNormPool[po], vNormPool[po + 1], vNormPool[po + 2]) || 1;
        vNormPool[po] /= l;
        vNormPool[po + 1] /= l;
        vNormPool[po + 2] /= l;
      }
      for (let t = 0; t < this.triangleCount; t++) {
        if (!keep[t]) continue;
        const fnx = this.triNormal[t * 3];
        const fny = this.triNormal[t * 3 + 1];
        const fnz = this.triNormal[t * 3 + 2];
        const vo = t * 9;
        for (let k = 0; k < 3; k++) {
          const po = triVertIdx[t * 3 + k] * 3;
          const vnx = vNormPool[po];
          const vny = vNormPool[po + 1];
          const vnz = vNormPool[po + 2];
          // Preserve sharp creases (e.g., sausage kerb sides) if angle > ~30 deg
          const dot = fnx * vnx + fny * vny + fnz * vnz;
          if (dot > 0.86) {
            this.triVertNormal[vo + k * 3] = vnx;
            this.triVertNormal[vo + k * 3 + 1] = vny;
            this.triVertNormal[vo + k * 3 + 2] = vnz;
          } else {
            this.triVertNormal[vo + k * 3] = fnx;
            this.triVertNormal[vo + k * 3 + 1] = fny;
            this.triVertNormal[vo + k * 3 + 2] = fnz;
          }
        }
      }
    }

    const grid = buildCsrGrid(minX, minZ, maxX, maxZ, this.triangleCount, (t, box) => {
      if (!keep[t]) return false;
      const o = t * 9;
      box[0] = Math.min(tri[o], tri[o + 3], tri[o + 6]);
      box[1] = Math.min(tri[o + 2], tri[o + 5], tri[o + 8]);
      box[2] = Math.max(tri[o], tri[o + 3], tri[o + 6]);
      box[3] = Math.max(tri[o + 2], tri[o + 5], tri[o + 8]);
      return true;
    });
    this.minX = minX;
    this.minZ = minZ;
    this.nx = grid.nx;
    this.nz = grid.nz;
    const split =
      options.splitDenseCells === false
        ? { cellStart: grid.cellStart, items: grid.items, cellSplit: new Int32Array(grid.nx * grid.nz).fill(-1), cellSplitK: new Uint8Array(grid.nx * grid.nz) }
        : splitDenseCells(grid, minX, minZ, this.tris);
    this.cellStart = split.cellStart;
    this.cellTris = split.items;
    this.cellSplit = split.cellSplit;
    this.cellSplitK = split.cellSplitK;
  }

  /**
   * Ground under (x, z), considering only surfaces at or below `probeY`.
   * Returns false when nothing is underneath (the wheel is off the mesh: airborne).
   */
  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    const cell = this.cellAt(x, z);
    if (cell < 0) return false;
    this.clearCandidates(0);
    const tris = this.tris;
    for (let k = this.cellStart[cell], end = this.cellStart[cell + 1]; k < end; k++) {
      const t = this.cellTris[k];
      const o = t * 9;
      const ax = tris[o];
      const az = tris[o + 2];
      const v0x = tris[o + 3] - ax;
      const v0z = tris[o + 5] - az;
      const v1x = tris[o + 6] - ax;
      const v1z = tris[o + 8] - az;
      const px = x - ax;
      const pz = z - az;
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const u = (px * v1z - v1x * pz) / den;
      const v = (v0x * pz - px * v0z) / den;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const ay = tris[o + 1];
      const h = ay + u * (tris[o + 4] - ay) + v * (tris[o + 7] - ay);
      if (h > probeY) continue;
      this.addCandidate(0, t, u, v, h);
    }
    return this.resolve(0, out);
  }

  /**
   * `query`'s ground with the kerbs and sausages left out: the road, run-off or other ground they stand on. False
   * where there is none but a kerb (or nothing).
   */
  queryBase(x: number, z: number, probeY: number, out: GroundHit): boolean {
    if (!this.query(x, z, probeY, out)) return false;
    return this.resolve(0, out, true, false);
  }

  /**
   * `query` for up to `GROUND_QUERY_MANY_MAX` nearby points at once (a tyre's contact patch), each answered exactly as
   * `query` would: points in the same grid cell share one pass over its triangles, the bulk of a query's cost.
   * Returns a bit mask, bit i set when point i has ground (written to `outs[i]`); points from `fullCount` on get only
   * their height.
   */
  queryMany(
    xs: ArrayLike<number>,
    zs: ArrayLike<number>,
    count: number,
    probeY: number,
    outs: readonly GroundHit[],
    fullCount = count
  ): number {
    const n = Math.min(count, GROUND_QUERY_MANY_MAX);
    const cells = this.manyCells;
    let pending = 0;
    for (let i = 0; i < n; i++) {
      cells[i] = this.cellAt(xs[i], zs[i]);
      if (cells[i] >= 0) pending |= 1 << i;
    }
    const gx = this.groupX;
    const gz = this.groupZ;
    const slots = this.groupSlots;
    const tris = this.tris;
    let found = 0;
    while (pending !== 0) {
      // The points sharing the lowest pending point's cell, scanned together
      const cell = cells[31 - Math.clz32(pending & -pending)];
      let m = 0;
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < n; i++) {
        if ((pending >> i) & 1 && cells[i] === cell) {
          slots[m] = i;
          gx[m] = xs[i];
          gz[m] = zs[i];
          x0 = Math.min(x0, xs[i]);
          x1 = Math.max(x1, xs[i]);
          z0 = Math.min(z0, zs[i]);
          z1 = Math.max(z1, zs[i]);
          m++;
          pending &= ~(1 << i);
          this.clearCandidates(i);
        }
      }
      x0 -= TRI_BOX_MARGIN_M;
      x1 += TRI_BOX_MARGIN_M;
      z0 -= TRI_BOX_MARGIN_M;
      z1 += TRI_BOX_MARGIN_M;
      for (let k = this.cellStart[cell], end = this.cellStart[cell + 1]; k < end; k++) {
        const t = this.cellTris[k];
        const o = t * 9;
        const ax = tris[o];
        const az = tris[o + 2];
        const bx = tris[o + 3];
        const bz = tris[o + 5];
        const cx = tris[o + 6];
        const cz = tris[o + 8];
        // Triangles clear of the whole group's box are skipped for every point at once
        if (
          ((+(ax > x1) & +(bx > x1) & +(cx > x1)) |
            (+(ax < x0) & +(bx < x0) & +(cx < x0)) |
            (+(az > z1) & +(bz > z1) & +(cz > z1)) |
            (+(az < z0) & +(bz < z0) & +(cz < z0))) !==
          0
        )
          continue;
        const v0x = bx - ax;
        const v0z = bz - az;
        const v1x = cx - ax;
        const v1z = cz - az;
        const den = v0x * v1z - v1x * v0z;
        if (Math.abs(den) < 1e-12) continue;
        for (let j = 0; j < m; j++) {
          const px = gx[j] - ax;
          const pz = gz[j] - az;
          const u = (px * v1z - v1x * pz) / den;
          const v = (v0x * pz - px * v0z) / den;
          if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
          const ay = tris[o + 1];
          const h = ay + u * (tris[o + 4] - ay) + v * (tris[o + 7] - ay);
          if (h > probeY) continue;
          this.addCandidate(slots[j], t, u, v, h);
        }
      }
      for (let j = 0; j < m; j++) {
        const p = slots[j];
        if (this.resolve(p, outs[p], p < fullCount)) found |= 1 << p;
      }
    }
    return found;
  }

  /** Grid cell of (x, z), or its finer cell in a split one; -1 off the grid */
  private cellAt(x: number, z: number): number {
    const fx = (x - this.minX) / CELL_SIZE_M;
    const fz = (z - this.minZ) / CELL_SIZE_M;
    if (fx < 0 || fz < 0 || fx >= this.nx || fz >= this.nz) return -1;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const cell = cz * this.nx + cx;
    const first = this.cellSplit[cell];
    if (first < 0) return cell;
    const k = this.cellSplitK[cell];
    return first + Math.min(k - 1, Math.floor((fz - cz) * k)) * k + Math.min(k - 1, Math.floor((fx - cx) * k));
  }

  /** Point `p` starts a scan with no candidates */
  private clearCandidates(p: number): void {
    for (let c = p * 4, e = c + 4; c < e; c++) {
      this.candH[c] = -Infinity;
      this.candT[c] = -1;
      this.candU[c] = 0;
      this.candV[c] = 0;
    }
    this.tagCount[p] = 0;
  }

  /**
   * Point `p` lies over triangle `t` (barycentric u, v) at height `h`: it keeps its highest road-collider, raised, any
   * and drivable surface, and its tagged surfaces (in the cell's order, so ties keep the first)
   */
  private addCandidate(p: number, t: number, u: number, v: number, h: number): void {
    const cH = this.candH;
    const c = p * 4;
    const layer = this.layers[this.triLayer[t]];
    if (layer.isRoadCollider) {
      if (h > cH[c + CAND_ROAD]) this.setCandidate(c + CAND_ROAD, t, u, v, h);
      return;
    }
    if (RAISED_SURFACES.has(layer.surface) && h > cH[c + CAND_RAISED]) this.setCandidate(c + CAND_RAISED, t, u, v, h);
    if (h > cH[c + CAND_ANY]) this.setCandidate(c + CAND_ANY, t, u, v, h);
    if (layer.drivable && h > cH[c + CAND_DRIVE]) this.setCandidate(c + CAND_DRIVE, t, u, v, h);
    if (layer.tagged && this.tagCount[p] < MAX_TAGS) {
      const ti = p * MAX_TAGS + this.tagCount[p]++;
      this.scratchH[ti] = h;
      this.scratchT[ti] = t;
    }
  }

  private setCandidate(c: number, t: number, u: number, v: number, h: number): void {
    this.candH[c] = h;
    this.candT[c] = t;
    this.candU[c] = u;
    this.candV[c] = v;
  }

  /** Ripple of the surface triangle `t` belongs to at barycentric (u, v) (kerb serrations, grass and gravel bumps), m */
  private rippleAt(t: number, bu: number, bv: number): number {
    const layer = this.layers[this.triLayer[t]];
    const uo = this.triUVAt[t];
    if (!(layer.uvScaleM > 0) || uo < 0) return 0;
    const uv = this.triUV;
    const bw = 1 - bu - bv;
    const u = bw * uv[uo] + bu * uv[uo + 2] + bv * uv[uo + 4];
    const v = bw * uv[uo + 1] + bu * uv[uo + 3] + bv * uv[uo + 5];
    return surfaceRippleM(layer.props, u * layer.uvScaleM, Math.sin(Math.PI * Math.min(1, Math.max(0, v))));
  }

  /**
   * Point `p`'s ground from its scanned candidates (see the class notes), into `out`; false when it has none. Unless
   * `full`, only its height is written (no normal or surface tags). Without `raised`, kerbs and sausages are left out.
   */
  private resolve(p: number, out: GroundHit, full = true, raised = true): boolean {
    const c = p * 4;
    const roadH = this.candH[c + CAND_ROAD];
    const roadT = this.candT[c + CAND_ROAD];
    const roadU = this.candU[c + CAND_ROAD];
    const roadV = this.candV[c + CAND_ROAD];
    const raisedH = this.candH[c + CAND_RAISED];
    const raisedT = this.candT[c + CAND_RAISED];
    const raisedU = this.candU[c + CAND_RAISED];
    const raisedV = this.candV[c + CAND_RAISED];
    const anyH = this.candH[c + CAND_ANY];
    const anyT = this.candT[c + CAND_ANY];
    const anyU = this.candU[c + CAND_ANY];
    const anyV = this.candV[c + CAND_ANY];
    const driveH = this.candH[c + CAND_DRIVE];
    const driveT = this.candT[c + CAND_DRIVE];
    const driveU = this.candU[c + CAND_DRIVE];
    const driveV = this.candV[c + CAND_DRIVE];
    // Tagged surfaces, kept to classify the final contact height
    const tagCount = this.tagCount[p];
    const tagAt = p * MAX_TAGS;
    const tagH = this.scratchH;
    const tagT = this.scratchT;

    let baseT = -1;
    let baseH = -Infinity;
    let baseU = 0;
    let baseV = 0;
    if (driveT >= 0 && (roadT < 0 || driveH >= roadH - 0.5)) {
      baseT = driveT;
      baseH = driveH;
      baseU = driveU;
      baseV = driveV;
    } else if (roadT >= 0) {
      baseT = roadT;
      baseH = roadH;
      baseU = roadU;
      baseV = roadV;
    }

    let contactT: number;
    let contactH: number;
    let contactU: number;
    let contactV: number;
    let normalT: number;
    let normalU: number;
    let normalV: number;
    if (baseT >= 0) {
      if (raised && raisedT >= 0 && raisedH >= baseH - (this.fitted ? SURFACE_MATCH_M : 0) && raisedH <= baseH + 0.6) {
        const maxRise = this.layers[this.triLayer[raisedT]].props.maxRiseM;
        contactT = raisedT;
        contactH = Math.min(Math.max(baseH, raisedH), baseH + maxRise);
        contactU = raisedU;
        contactV = raisedV;
        if (raisedH > baseH + maxRise + 0.01) {
          normalT = baseT;
          normalU = baseU;
          normalV = baseV;
        } else {
          normalT = raisedT;
          normalU = raisedU;
          normalV = raisedV;
        }
      } else {
        contactT = baseT;
        contactH = baseH;
        contactU = baseU;
        contactV = baseV;
        normalT = baseT;
        normalU = baseU;
        normalV = baseV;
      }
    } else if (!raised) {
      return false;
    } else if (raisedT >= 0) {
      contactT = raisedT;
      contactH = raisedH;
      contactU = raisedU;
      contactV = raisedV;
      normalT = raisedT;
      normalU = raisedU;
      normalV = raisedV;
    } else if (anyT >= 0) {
      contactT = anyT;
      contactH = anyH;
      contactU = anyU;
      contactV = anyV;
      normalT = anyT;
      normalU = anyU;
      normalV = anyV;
    } else {
      return false;
    }
    if (!full) {
      out.height = contactH + this.rippleAt(contactT, contactU, contactV);
      return true;
    }

    // Classify: top-most tagged surface near the contact height (on fitted surfaces a kerb or sausage first), else the contact layer itself
    let bestTagT = -1;
    let bestTagH = -Infinity;
    let bestTagRaised = false;
    if (RAISED_SURFACES.has(this.layers[this.triLayer[contactT]].surface)) {
      bestTagT = contactT;
      bestTagH = contactH;
      bestTagRaised = true;
    } else {
      for (let i = tagAt; i < tagAt + tagCount; i++) {
        if (Math.abs(tagH[i] - contactH) <= SURFACE_MATCH_M) {
          const isRaised = this.fitted && RAISED_SURFACES.has(this.layers[this.triLayer[tagT[i]]].surface);
          if ((isRaised && !bestTagRaised) || (isRaised === bestTagRaised && tagH[i] > bestTagH)) {
            bestTagH = tagH[i];
            bestTagT = tagT[i];
            bestTagRaised = isRaised;
          }
        }
      }
    }
    const tagLayer = this.layers[this.triLayer[bestTagT >= 0 ? bestTagT : contactT]];

    contactH += this.rippleAt(contactT, contactU, contactV);

    const vo = normalT * 9;
    const vn = this.triVertNormal;
    const w = 1 - normalU - normalV;
    const nx = w * vn[vo] + normalU * vn[vo + 3] + normalV * vn[vo + 6];
    const ny = w * vn[vo + 1] + normalU * vn[vo + 4] + normalV * vn[vo + 7];
    const nz = w * vn[vo + 2] + normalU * vn[vo + 5] + normalV * vn[vo + 8];
    const invLen = 1 / (Math.hypot(nx, ny, nz) || 1);

    out.height = contactH;
    out.nx = nx * invLen;
    out.ny = ny * invLen;
    out.nz = nz * invLen;
    out.surface = tagLayer.surface;
    out.grip = tagLayer.grip;
    out.props = tagLayer.props;
    out.source = tagLayer.name;
    return true;
  }

  /** `queryMany`: each point's grid cell, and the points of the cell being scanned (coordinates, index) */
  private readonly manyCells = new Int32Array(GROUND_QUERY_MANY_MAX);
  private readonly groupX = new Float64Array(GROUND_QUERY_MANY_MAX);
  private readonly groupZ = new Float64Array(GROUND_QUERY_MANY_MAX);
  private readonly groupSlots = new Int32Array(GROUND_QUERY_MANY_MAX);
  /** Per point, its highest road-collider / raised / any / drivable candidate (`CAND_*`): height, triangle, u, v */
  private readonly candH = new Float64Array(GROUND_QUERY_MANY_MAX * 4);
  private readonly candT = new Int32Array(GROUND_QUERY_MANY_MAX * 4);
  private readonly candU = new Float64Array(GROUND_QUERY_MANY_MAX * 4);
  private readonly candV = new Float64Array(GROUND_QUERY_MANY_MAX * 4);
  /** Per point, up to `MAX_TAGS` tagged surfaces (height, triangle) */
  private readonly tagCount = new Int32Array(GROUND_QUERY_MANY_MAX);
  private readonly scratchH = new Float64Array(GROUND_QUERY_MANY_MAX * MAX_TAGS);
  private readonly scratchT = new Int32Array(GROUND_QUERY_MANY_MAX * MAX_TAGS);
}

/** Infinite flat ground (tests, garage) */
export class FlatGroundQuery implements GroundQuery {
  readonly smooth = true;
  readonly stateless = true;

  constructor(
    private readonly height = 0,
    private readonly surface: TrackSurfaceKind = 'road',
    private readonly grip = DEFAULT_SURFACE_TABLE[surface].friction
  ) {}

  query(_x: number, _z: number, probeY: number, out: GroundHit): boolean {
    if (this.height > probeY) return false;
    out.height = this.height;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.surface = this.surface;
    out.grip = this.grip;
    out.props = DEFAULT_SURFACE_TABLE[this.surface];
    out.source = 'flat';
    return true;
  }
}

export function createGroundHit(): GroundHit {
  return { height: 0, nx: 0, ny: 1, nz: 0, surface: 'road', grip: 1, props: DEFAULT_SURFACE_TABLE.road, source: '' };
}

// ---------------------------------------------------------------------------
// Barrier walls
// ---------------------------------------------------------------------------

/** Floats per wall segment: ax, az, bx, bz, yMin, yMax */
export const WALL_SEGMENT_STRIDE = 6;

/** Barrier walls as vertical 2D segments (XZ footprint + height range) */
export interface WallQuery {
  /** `WALL_SEGMENT_STRIDE` floats per segment */
  readonly segments: Float32Array;
  /**
   * Ids of the segments passing within `radius` of (x, z), written to `out`; returns how many
   * (at most `out.length`).
   */
  near(x: number, z: number, radius: number, out: Int32Array): number;
  /** `near` answers from its arguments alone, never from earlier queries (as `GroundQuery.stateless`) */
  readonly stateless?: boolean;
}

/**
 * The `Track_Collider_Wall_Left` / `Track_Collider_Wall_Right` barrier colliders (`userData.collider =
 * 'wall'`, hidden in the render). Each vertical wall triangle becomes the segment between its two
 * vertices farthest apart in XZ; duplicates (the two halves of a quad) are dropped.
 */
/** A wall collider's data (see `TrackColliderBuffers`): structured-clonable, its arrays transferable */
export interface TrackWallBuffers {
  segments: Float32Array;
  minX: number;
  minZ: number;
  nx: number;
  nz: number;
  cellStart: Uint32Array;
  cellSegs: Uint32Array;
}

/** Whether a wall face at (x, z) with horizontal normal (nx, nz) faces the road (its normal points toward the centreline) */
export type RoadFacing = (x: number, z: number, nx: number, nz: number) => boolean;

/** A drawn barrier's face steeper than this (|normal.y|) is a top or an underside, not a wall */
const DRAWN_BARRIER_MAX_NORMAL_Y = 0.5;
/**
 * A drawn barrier's face shorter than this (m) is a rounded end or a cap, not a wall: a probe beside a 0.1 m face of
 * Monaco's Armco curls read as a metre past it and threw the car back along the road a metre at a step
 */
const DRAWN_BARRIER_MIN_FACE_M = 0.5;

export class TrackWallQuery implements WallQuery {
  /** The stamps only stop a segment being listed twice in one query: no answer depends on an earlier one */
  readonly stateless = true;
  public readonly segments: Float32Array;
  public readonly segmentCount: number;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cellStart: Uint32Array;
  private readonly cellSegs: Uint32Array;
  /** Per-segment query stamp, so a segment spanning several cells is reported once */
  private readonly stamp: Uint32Array;
  private queryId = 0;

  /**
   * Every node with `userData.collider === 'wall'` (or named `Track_Collider_Wall_*`) under the track root, and the
   * drawn barriers named in `barrierMeshes` (a mesh `name` or its exported `name_chunkN` parts)
   */
  static fromTrackRoot(root: THREE.Object3D, barrierMeshes: readonly string[] = [], facesRoad?: RoadFacing): TrackWallQuery {
    root.updateMatrixWorld(true);
    const walls: THREE.Object3D[] = [];
    const drawn = new Set<THREE.Object3D>();
    const barrier = (name: string) => barrierMeshes.some((b) => name === b || (name.startsWith(`${b}_chunk`) && /^\d+$/.test(name.slice(b.length + 6))));
    root.traverse((obj) => {
      if (obj.userData?.collider === 'wall' || obj.name.startsWith('Track_Collider_Wall')) walls.push(obj);
      else if (barrierMeshes.length && obj instanceof THREE.Mesh && barrier(obj.name)) {
        walls.push(obj);
        drawn.add(obj);
      }
    });
    return new TrackWallQuery(walls, { drawn, facesRoad });
  }

  /** The walls rebuilt from their data (`toBuffers`), e.g. in a worker */
  static fromBuffers(buffers: TrackWallBuffers): TrackWallQuery {
    return new TrackWallQuery(buffers);
  }

  /** The walls' data, sharing its arrays (not copies) */
  toBuffers(): TrackWallBuffers {
    return { segments: this.segments, minX: this.minX, minZ: this.minZ, nx: this.nx, nz: this.nz, cellStart: this.cellStart, cellSegs: this.cellSegs };
  }

  /**
   * `drawn`: barriers drawn for the eye, not built as colliders. A solid one (a rail with a back, a top and end caps)
   * keeps only its upright faces at least DRAWN_BARRIER_MIN_FACE_M long, and of those (with `facesRoad`) the ones
   * facing the road, as a collider wall is built: one face, along the road
   */
  constructor(objects: THREE.Object3D[] | TrackWallBuffers, drawnBarriers?: { drawn: ReadonlySet<THREE.Object3D>; facesRoad?: RoadFacing }) {
    if (!Array.isArray(objects)) {
      this.segments = objects.segments;
      this.segmentCount = objects.segments.length / WALL_SEGMENT_STRIDE;
      this.stamp = new Uint32Array(this.segmentCount);
      this.minX = objects.minX;
      this.minZ = objects.minZ;
      this.nx = objects.nx;
      this.nz = objects.nz;
      this.cellStart = objects.cellStart;
      this.cellSegs = objects.cellSegs;
      return;
    }
    const segs: number[] = [];
    const seen = new Set<string>();
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    for (const obj of objects) {
      obj.updateWorldMatrix(true, true);
      const drawn = drawnBarriers?.drawn.has(obj) === true;
      obj.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const geom = o.geometry as THREE.BufferGeometry;
        const pos = geom.getAttribute('position');
        if (!pos) return;
        const index = geom.getIndex();
        const n = index ? index.count : pos.count;
        for (let i = 0; i + 2 < n; i += 3) {
          for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
          if (drawn) {
            e1.subVectors(p[1], p[0]).cross(e2.subVectors(p[2], p[0]));
            const len = e1.length();
            if (!(len > 0) || Math.abs(e1.y) / len > DRAWN_BARRIER_MAX_NORMAL_Y) continue;
            const facing = drawnBarriers?.facesRoad;
            if (facing && !facing((p[0].x + p[1].x + p[2].x) / 3, (p[0].z + p[1].z + p[2].z) / 3, e1.x / len, e1.z / len)) continue;
          }
          let best = -1;
          let ia = 0;
          let ib = 1;
          for (const [u, v] of [
            [0, 1],
            [1, 2],
            [0, 2],
          ] as const) {
            const d = Math.hypot(p[u].x - p[v].x, p[u].z - p[v].z);
            if (d > best) {
              best = d;
              ia = u;
              ib = v;
            }
          }
          if (best < (drawn ? DRAWN_BARRIER_MIN_FACE_M : 0.05)) continue;
          const a = p[ia];
          const b = p[ib];
          const yMin = Math.min(p[0].y, p[1].y, p[2].y);
          const yMax = Math.max(p[0].y, p[1].y, p[2].y);
          // Order the endpoints so both halves of a quad give the same key
          const swap = a.x > b.x || (a.x === b.x && a.z > b.z);
          const [s, e] = swap ? [b, a] : [a, b];
          const key = `${Math.round(s.x * 50)},${Math.round(s.z * 50)},${Math.round(e.x * 50)},${Math.round(e.z * 50)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          segs.push(s.x, s.z, e.x, e.z, yMin, yMax);
        }
      });
    }
    this.segments = Float32Array.from(segs);
    this.segmentCount = segs.length / WALL_SEGMENT_STRIDE;
    this.stamp = new Uint32Array(this.segmentCount);

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < this.segmentCount; i++) {
      const o = i * WALL_SEGMENT_STRIDE;
      minX = Math.min(minX, segs[o], segs[o + 2]);
      maxX = Math.max(maxX, segs[o], segs[o + 2]);
      minZ = Math.min(minZ, segs[o + 1], segs[o + 3]);
      maxZ = Math.max(maxZ, segs[o + 1], segs[o + 3]);
    }
    if (!Number.isFinite(minX)) {
      minX = minZ = 0;
      maxX = maxZ = 1;
    }
    const grid = buildCsrGrid(minX, minZ, maxX, maxZ, this.segmentCount, (i, box) => {
      const o = i * WALL_SEGMENT_STRIDE;
      box[0] = Math.min(segs[o], segs[o + 2]);
      box[1] = Math.min(segs[o + 1], segs[o + 3]);
      box[2] = Math.max(segs[o], segs[o + 2]);
      box[3] = Math.max(segs[o + 1], segs[o + 3]);
      return true;
    });
    this.minX = minX;
    this.minZ = minZ;
    this.nx = grid.nx;
    this.nz = grid.nz;
    this.cellStart = grid.cellStart;
    this.cellSegs = grid.items;
  }

  private cellX(x: number): number {
    return gridCell(x, this.minX, this.nx);
  }

  private cellZ(z: number): number {
    return gridCell(z, this.minZ, this.nz);
  }

  near(x: number, z: number, radius: number, out: Int32Array): number {
    if (this.segmentCount === 0) return 0;
    if (++this.queryId === 0xffffffff) {
      this.stamp.fill(0);
      this.queryId = 1;
    }
    const id = this.queryId;
    const s = this.segments;
    const r2 = radius * radius;
    let count = 0;
    const cx0 = this.cellX(x - radius);
    const cx1 = this.cellX(x + radius);
    const cz0 = this.cellZ(z - radius);
    const cz1 = this.cellZ(z + radius);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cz * this.nx + cx;
        for (let k = this.cellStart[cell], end = this.cellStart[cell + 1]; k < end; k++) {
          const i = this.cellSegs[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          const o = i * WALL_SEGMENT_STRIDE;
          const ax = s[o];
          const az = s[o + 1];
          const dx = s[o + 2] - ax;
          const dz = s[o + 3] - az;
          const len2 = dx * dx + dz * dz;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
          const ex = ax + t * dx - x;
          const ez = az + t * dz - z;
          if (ex * ex + ez * ez > r2) continue;
          if (count >= out.length) return count;
          out[count++] = i;
        }
      }
    }
    return count;
  }
}

/** A barrier contact: depth past the wall face (m) and the unit XZ normal back out of it */
export interface WallHit {
  depth: number;
  nx: number;
  nz: number;
}

export function createWallHit(): WallHit {
  return { depth: 0, nx: 0, nz: 0 };
}

/**
 * A corner of a car's barrier outline at (px, py, pz) against the wall segments `ids[0..count)`, the car's centre at
 * (cgX, cgZ) and the corner at (fromX, fromZ) at the start of the sub-step. A face counts when the corner's path this
 * sub-step entered it from the centre's side; of several, the first it entered (a post's front, not its back; the side
 * of a row, not the end it then slid out past). A corner already past a face at the start of the sub-step (left there
 * by another contact's push) counts the first face between the centre and the corner, when the corner lies behind
 * that face within its length: a face the corner only got behind by going round its end is not one it is through (the
 * end is inside the outline then, `wallEndInOutline`). Nothing further away counts: a face beside the corner, or one the
 * corner is "behind" only as seen from the centre across empty ground, is not a contact. Only segments whose height
 * range reaches within `ySlack` of `py` count (a NaN `py` skips the height test). The normal points back toward the
 * centre's side; returns the depth behind the face, 0 when clear.
 */
export function wallCornerContact(
  walls: WallQuery,
  ids: Int32Array,
  count: number,
  px: number,
  py: number,
  pz: number,
  fromX: number,
  fromZ: number,
  cgX: number,
  cgZ: number,
  ySlack: number,
  out: WallHit
): number {
  const seg = walls.segments;
  // The face normals are left unnormalized (|n| = the face's length): every test below is a sign or a ratio, so only the
  // face picked needs a square root
  let firstEntry = Infinity;
  let entryDepth = 0;
  let entryNx = 0;
  let entryNz = 0;
  let firstOnRay = Infinity;
  let rayDepth = 0;
  let rayNx = 0;
  let rayNz = 0;
  let rayBehind = false;
  for (let k = 0; k < count; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    if (py < seg[o + 4] - ySlack || py > seg[o + 5] + ySlack) continue;
    const ax = seg[o];
    const az = seg[o + 1];
    const dx = seg[o + 2] - ax;
    const dz = seg[o + 3] - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    let nx = -dz;
    let nz = dx;
    let sc = (cgX - ax) * nx + (cgZ - az) * nz;
    // The centre within 0.1 mm of the face's line: no side to take
    if (sc * sc < 1e-8 * len2) continue;
    if (sc < 0) {
      nx = -nx;
      nz = -nz;
      sc = -sc;
    }
    const sp = (px - ax) * nx + (pz - az) * nz;
    if (sp >= 0) continue;
    // Entered along the corner's own path, from the centre's side
    const sf = (fromX - ax) * nx + (fromZ - az) * nz;
    if (sf >= 0) {
      const g = sf / (sf - sp);
      const t = ((fromX + (px - fromX) * g - ax) * dx + (fromZ + (pz - fromZ) * g - az) * dz) / len2;
      if (t >= 0 && t <= 1) {
        if (g < firstEntry) {
          const inv = 1 / Math.sqrt(len2);
          firstEntry = g;
          entryDepth = -sp * inv;
          entryNx = nx * inv;
          entryNz = nz * inv;
        }
        continue;
      }
    }
    // Between the centre and the corner: the line from one to the other crosses the face
    const f = sc / (sc - sp);
    const t = ((cgX + (px - cgX) * f - ax) * dx + (cgZ + (pz - cgZ) * f - az) * dz) / len2;
    if (t < 0 || t > 1 || f >= firstOnRay) continue;
    const inv = 1 / Math.sqrt(len2);
    firstOnRay = f;
    const tq = ((px - ax) * dx + (pz - az) * dz) / len2;
    rayBehind = tq >= 0 && tq <= 1;
    rayDepth = -sp * inv;
    rayNx = nx * inv;
    rayNz = nz * inv;
  }
  if (firstEntry !== Infinity) {
    out.depth = entryDepth;
    out.nx = entryNx;
    out.nz = entryNz;
  } else if (firstOnRay !== Infinity && rayBehind) {
    out.depth = rayDepth;
    out.nx = rayNx;
    out.nz = rayNz;
  } else out.depth = 0;
  return out.depth;
}

/** A wall's end or corner inside a car's outline: as `WallHit` (the normal is the way to push the car), and where it is */
export interface WallEndHit extends WallHit {
  x: number;
  z: number;
}

export function createWallEndHit(): WallEndHit {
  return { depth: 0, nx: 0, nz: 0, x: 0, z: 0 };
}

/** Floats per outline edge in `wallEndInOutline`'s edge lists: the outward unit normal (nx, nz) and its offset c */
export const OUTLINE_EDGE_STRIDE = 3;

/** The points (x, z) on the convex hull of `pts`, as indices in order round it (points on a straight edge left out) */
export function convexHullIndices(pts: readonly { x: number; z: number }[]): number[] {
  const order = pts.map((_, i) => i).sort((i, j) => pts[i].x - pts[j].x || pts[i].z - pts[j].z);
  const cross = (o: number, a: number, b: number) =>
    (pts[a].x - pts[o].x) * (pts[b].z - pts[o].z) - (pts[a].z - pts[o].z) * (pts[b].x - pts[o].x);
  const half = (idx: number[]) => {
    const h: number[] = [];
    for (const i of idx) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], i) <= 0) h.pop();
      h.push(i);
    }
    return h.slice(0, -1);
  };
  return half(order).concat(half([...order].reverse()));
}

/**
 * A convex outline's edges for `wallEndInOutline`, from its `k` corners in order round it relative to the centre
 * inside it (`corners`: x, z pairs): edge i runs from corner i − 1 to corner i
 */
export function writeOutlineEdges(corners: Float64Array, k: number, out: Float64Array): void {
  let ax = corners[2 * k - 2];
  let az = corners[2 * k - 1];
  for (let i = 0; i < k; i++) {
    const bx = corners[2 * i];
    const bz = corners[2 * i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    let nx = -dz / len;
    let nz = dx / len;
    let c = nx * ax + nz * az;
    // Outward: away from the centre
    if (c < 0) {
      nx = -nx;
      nz = -nz;
      c = -c;
    }
    const e = i * OUTLINE_EDGE_STRIDE;
    out[e] = nx;
    out[e + 1] = nz;
    out[e + 2] = c;
    ax = bx;
    az = bz;
  }
}

/** Faces meeting at a wall's joint within this angle of a straight line make a smooth wall there, not a corner */
const SMOOTH_JOINT_COS = Math.cos((30 * Math.PI) / 180);
/**
 * A face passing this close (m) to a wall's end meets it there. More than touching: faces under 5 cm are dropped from
 * the walls (`TrackWallQuery`), which leaves gaps that size in a traced outline, and a barrier's sections can stand a
 * few centimetres proud of each other (Monaco's Armco)
 */
const JOINT_TOLERANCE_M = 0.06;

/**
 * The deepest end or corner of the wall segments `ids[0..count)` inside a car's convex barrier outline: a post or a
 * wall's end between the outline's corners, which no corner touches. The outline is given by its edges relative to its
 * centre (at cgX, cgZ): `OUTLINE_EDGE_STRIDE` floats each, the outward unit normal n and c = n · (a corner on the edge);
 * a point r from the centre is inside when r · n < c on every edge. `radius` bounds the outline. Height test against
 * `py` as in `wallCornerContact`.
 *
 * The contact normal is that of the outline's edge nearest the end, and the depth how far it is in past that edge: a
 * post met by the nose pushes the car straight back by the little it got in during the sub-step, one met by the nose's
 * corner turns it aside. At a joint of a smooth wall (every face reaching the end within 30° of a straight line) the
 * faces' own normal is used instead, with the push along it that clears the joint (if that is not much more than
 * through the edge): a barrier's slight zig-zag, or a section standing a few centimetres proud of the one before,
 * would otherwise catch a car sliding along it on the edge of its nose. `out` gets the way to push the car and the
 * end's position; returns the depth, 0 when none is in.
 */
export function wallEndInOutline(
  walls: WallQuery,
  ids: Int32Array,
  count: number,
  cgX: number,
  cgZ: number,
  py: number,
  edges: Float64Array,
  edgeCount: number,
  radius: number,
  ySlack: number,
  out: WallEndHit
): number {
  const seg = walls.segments;
  const r2 = radius * radius;
  out.depth = 0;
  for (let k = 0; k < count; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    if (py < seg[o + 4] - ySlack || py > seg[o + 5] + ySlack) continue;
    for (let end = 0; end < 2; end++) {
      const ex = seg[o + 2 * end];
      const ez = seg[o + 1 + 2 * end];
      const rx = ex - cgX;
      const rz = ez - cgZ;
      if (rx * rx + rz * rz > r2) continue;
      let inside = true;
      let nearest = -Infinity;
      let nearestEdge = 0;
      for (let i = 0; i < edgeCount; i++) {
        const e = i * OUTLINE_EDGE_STRIDE;
        const d = rx * edges[e] + rz * edges[e + 1] - edges[e + 2];
        if (d >= 0) {
          inside = false;
          break;
        }
        if (d > nearest) {
          nearest = d;
          nearestEdge = i;
        }
      }
      if (!inside) continue;
      let depth = -nearest;
      let ux = -edges[nearestEdge * OUTLINE_EDGE_STRIDE];
      let uz = -edges[nearestEdge * OUTLINE_EDGE_STRIDE + 1];
      if (depth <= out.depth) continue;
      // A joint of a smooth wall: the faces reaching the end, their directions turned to agree; the side the car is on
      // is read from the face whose line runs furthest from its centre (one pointing at the centre cannot tell)
      let faces = 0;
      let smooth = true;
      let fx = 0;
      let fz = 0;
      let sx = 0;
      let sz = 0;
      let side = 0;
      let sideDist = -1;
      for (let j = 0; j < count && smooth; j++) {
        const oj = ids[j] * WALL_SEGMENT_STRIDE;
        if (py < seg[oj + 4] - ySlack || py > seg[oj + 5] + ySlack) continue;
        const ax = seg[oj];
        const az = seg[oj + 1];
        const bx = seg[oj + 2];
        const bz = seg[oj + 3];
        const dx = bx - ax;
        const dz = bz - az;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        const t = Math.min(1, Math.max(0, ((ex - ax) * dx + (ez - az) * dz) / len2));
        const gx = ax + t * dx - ex;
        const gz = az + t * dz - ez;
        if (gx * gx + gz * gz > JOINT_TOLERANCE_M * JOINT_TOLERANCE_M) continue;
        const len = Math.sqrt(len2);
        let tx = dx / len;
        let tz = dz / len;
        if (faces === 0) {
          fx = tx;
          fz = tz;
        } else if (Math.abs(tx * fx + tz * fz) < SMOOTH_JOINT_COS) smooth = false;
        else if (tx * fx + tz * fz < 0) {
          tx = -tx;
          tz = -tz;
        }
        sx += tx;
        sz += tz;
        // The centre's distance from this face's line, on the side of the normal (−tz, tx)
        const sc = (cgX - ax) * -tz + (cgZ - az) * tx;
        if (Math.abs(sc) > sideDist) {
          sideDist = Math.abs(sc);
          side = Math.sign(sc);
        }
        faces++;
      }
      const sl = Math.hypot(sx, sz);
      if (faces >= 2 && smooth && sl > 1e-6 && side !== 0) {
        // The faces' mean normal, toward the car's side
        const wx = (-sz / sl) * side;
        const wz = (sx / sl) * side;
        // How far the car must move along w for the joint to leave the outline: through the first edge it reaches
        let s = Infinity;
        for (let i = 0; i < edgeCount; i++) {
          const e = i * OUTLINE_EDGE_STRIDE;
          const un = wx * edges[e] + wz * edges[e + 1];
          if (un >= 0) continue;
          s = Math.min(s, (rx * edges[e] + rz * edges[e + 1] - edges[e + 2]) / un);
        }
        if (s <= 3 * depth + JOINT_TOLERANCE_M) {
          depth = s;
          ux = wx;
          uz = wz;
        }
      }
      if (depth <= out.depth) continue;
      out.depth = depth;
      out.nx = ux;
      out.nz = uz;
      out.x = ex;
      out.z = ez;
    }
  }
  return out.depth;
}

/**
 * Where the path (ax, az) → (bx, bz) first crosses one of the wall segments `ids[0..count)` (height test as in
 * `wallCornerContact`): the fraction along the path, or −1 when it crosses none. `out` gets that wall's normal toward the
 * path's start and how far (bx, bz) is past it.
 */
export function wallSweep(
  walls: WallQuery,
  ids: Int32Array,
  count: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  py: number,
  ySlack: number,
  out: WallHit
): number {
  const seg = walls.segments;
  const rx = bx - ax;
  const rz = bz - az;
  let best = -1;
  for (let k = 0; k < count; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    if (py < seg[o + 4] - ySlack || py > seg[o + 5] + ySlack) continue;
    const cx = seg[o];
    const cz = seg[o + 1];
    const sx = seg[o + 2] - cx;
    const sz = seg[o + 3] - cz;
    const den = rx * sz - rz * sx;
    if (Math.abs(den) < 1e-12) continue;
    const qx = cx - ax;
    const qz = cz - az;
    const u = (qx * sz - qz * sx) / den;
    const v = (qx * rz - qz * rx) / den;
    if (u < 0 || u > 1 || v < 0 || v > 1 || (best >= 0 && u >= best)) continue;
    const len = Math.hypot(sx, sz);
    let nx = -sz / len;
    let nz = sx / len;
    if ((ax - cx) * nx + (az - cz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    best = u;
    out.nx = nx;
    out.nz = nz;
    out.depth = Math.max(0, -((bx - cx) * nx + (bz - cz) * nz));
  }
  return best;
}
