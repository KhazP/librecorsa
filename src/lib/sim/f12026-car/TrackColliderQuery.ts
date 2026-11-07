/**
 * Ground queries against the Rwanda glTF track colliders for `VehiclePhysics`.
 *
 * Node contract (see scripts/rwanda-2026/build_surfaces.py):
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
 * the contact layer's own tags. Converted circuits built with `conformSurfaces` fit their off-road bands to the
 * road first, and then also drive on their grass and let a kerb fitted just under the road name the surface.
 *
 * Queries are vertical rays (the wheels probe straight down), answered from a uniform XZ grid of
 * world-space triangles, so a query costs a cell lookup plus a handful of 2D triangle tests.
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
/** Swept visual surfaces a car drives on (everything tagged but coarse terrain grass) */
const DRIVABLE_SURFACES: ReadonlySet<TrackSurfaceKind> = new Set(['road', 'runoff', 'pitlane', 'gravel']);
const SURFACE_MATCH_M = 0.05;
/** Maximum physical step height of a standard kerb / sausage kerb above the underlying road/verge surface (m) */
const CELL_SIZE_M = 4;

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
  if (root.userData?.__collidersConformed) return;
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
    root.userData = { ...root.userData, __collidersConformed: true };
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
    root.userData = { ...root.userData, __collidersConformed: true };
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
  for (const { mesh, kind } of offroadMeshes) {
    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
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
          pos.setXYZ(i, nx, r.edgeY + dyExt, nz);
        } else {
          pos.setY(i, r.yPlane);
        }
      } else {
        const maxDev = r.dOut <= 0.35 ? 0.002 : Math.min(0.08, 0.015 * (r.dOut - 0.35));
        pos.setY(i, THREE.MathUtils.clamp(y, r.yPlane - maxDev, r.yPlane + maxDev));
      }
    }
    pos.needsUpdate = true;
  }
  root.userData = { ...root.userData, __collidersConformed: true };
}

export class TrackColliderQuery implements GroundQuery {
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
  /** CSR grid: cell → [cellStart[c], cellStart[c+1]) into cellTris */
  private readonly cellStart: Uint32Array;
  private readonly cellTris: Uint32Array;
  public readonly triangleCount: number;

  /**
   * Build from the loaded track root: `Track_Collider_Road` plus every node tagged `userData.surface`.
   * Throws when the road collider is missing.
   */
  static fromTrackRoot(
    root: THREE.Object3D,
    table: SurfaceTable = DEFAULT_SURFACE_TABLE,
    options: { conformSurfaces?: boolean } = {}
  ): TrackColliderQuery {
    if (options.conformSurfaces) conformTrackSurfaceColliders(root);
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

  constructor(
    sources: ColliderLayerSource[],
    table: SurfaceTable = DEFAULT_SURFACE_TABLE,
    options: { conformSurfaces?: boolean } = {}
  ) {
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
      const props = table[surface];
      const grip = src.grip ?? (typeof ud.grip === 'number' ? ud.grip : props.friction);
      const ripple = !isRoadCollider && props.bumpHeightM > 0 && props.bumpLengthM > 0;
      const uvScaleM = ripple ? (typeof ud.uvScaleM === 'number' ? ud.uvScaleM : DEFAULT_UV_SCALE_M) : 0;
      if (this.layers.length >= 255) throw new Error('TrackColliderQuery: too many layers');
      const li = this.layers.length;
      const isTagged = !!(src.surface ?? tagged);
      const drivable =
        isTagged &&
        !RAISED_SURFACES.has(surface) &&
        (DRIVABLE_SURFACES.has(surface) || (fitted && surface === 'grass' && src.object.name !== 'Terrain'));
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
    this.cellStart = grid.cellStart;
    this.cellTris = grid.items;
  }

  /**
   * Ground under (x, z), considering only surfaces at or below `probeY`.
   * Returns false when nothing is underneath (the wheel is off the mesh: airborne).
   */
  query(x: number, z: number, probeY: number, out: GroundHit): boolean {
    const fx = (x - this.minX) / CELL_SIZE_M;
    const fz = (z - this.minZ) / CELL_SIZE_M;
    if (fx < 0 || fz < 0 || fx >= this.nx || fz >= this.nz) return false;
    const cell = Math.floor(fz) * this.nx + Math.floor(fx);
    const tris = this.tris;

    let roadH = -Infinity;
    let roadT = -1;
    let roadU = 0;
    let roadV = 0;
    let raisedH = -Infinity;
    let raisedT = -1;
    let raisedU = 0;
    let raisedV = 0;
    let anyH = -Infinity;
    let anyT = -1;
    let anyU = 0;
    let anyV = 0;
    let driveH = -Infinity;
    let driveT = -1;
    let driveU = 0;
    let driveV = 0;
    // Tagged surfaces, kept to classify the final contact height
    let tagCount = 0;
    const tagH = this.scratchH;
    const tagT = this.scratchT;

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

      const layer = this.layers[this.triLayer[t]];
      if (layer.isRoadCollider) {
        if (h > roadH) {
          roadH = h;
          roadT = t;
          roadU = u;
          roadV = v;
        }
      } else {
        if (RAISED_SURFACES.has(layer.surface) && h > raisedH) {
          raisedH = h;
          raisedT = t;
          raisedU = u;
          raisedV = v;
        }
        if (h > anyH) {
          anyH = h;
          anyT = t;
          anyU = u;
          anyV = v;
        }
        if (layer.drivable && h > driveH) {
          driveH = h;
          driveT = t;
          driveU = u;
          driveV = v;
        }
        if (layer.tagged && tagCount < tagH.length) {
          tagH[tagCount] = h;
          tagT[tagCount] = t;
          tagCount++;
        }
      }
    }

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
      if (raisedT >= 0 && raisedH >= baseH - (this.fitted ? SURFACE_MATCH_M : 0) && raisedH <= baseH + 0.6) {
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

    // Classify: top-most tagged surface near the contact height (on fitted surfaces a kerb or sausage first), else the contact layer itself
    let bestTagT = -1;
    let bestTagH = -Infinity;
    let bestTagRaised = false;
    if (RAISED_SURFACES.has(this.layers[this.triLayer[contactT]].surface)) {
      bestTagT = contactT;
      bestTagH = contactH;
      bestTagRaised = true;
    } else {
      for (let i = 0; i < tagCount; i++) {
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

    // Ripple of the surface the wheel stands on (kerb serrations, grass and gravel bumps)
    const contactLayer = this.layers[this.triLayer[contactT]];
    const uo = this.triUVAt[contactT];
    if (contactLayer.uvScaleM > 0 && uo >= 0) {
      const uv = this.triUV;
      const bw = 1 - contactU - contactV;
      const u = bw * uv[uo] + contactU * uv[uo + 2] + contactV * uv[uo + 4];
      const v = bw * uv[uo + 1] + contactU * uv[uo + 3] + contactV * uv[uo + 5];
      contactH += surfaceRippleM(contactLayer.props, u * contactLayer.uvScaleM, Math.sin(Math.PI * Math.min(1, Math.max(0, v))));
    }

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

  /**
   * Conforms `Track_Model` visual road/kerb/runoff vertices near the physics surface so the rendered road
   * matches the smoothed `Track_Surface_Road` collider across crests and compressions.
   */
  public conformVisualRoad(root: THREE.Object3D): void {
    if (root.userData?.__visualRoadConformed) return;
    if (root.userData) root.userData.__visualRoadConformed = true;
    const tm = root.getObjectByName('Track_Model');
    if (!tm) return;
    const hit = createGroundHit();
    const mInv = new THREE.Matrix4();
    const seen = new Set<THREE.BufferGeometry>();
    tm.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || !o.geometry || seen.has(o.geometry)) return;
      seen.add(o.geometry);
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;
      const isOverlay = Boolean(
        o.userData?.decal || o.userData?.groove || o.parent?.userData?.decal || o.parent?.userData?.groove
      );
      const lift = isOverlay ? 0.002 : 0;
      const e = o.matrixWorld.elements;
      const m0 = e[0], m1 = e[1], m2 = e[2];
      const m4 = e[4], m5 = e[5], m6 = e[6];
      const m8 = e[8], m9 = e[9], m10 = e[10];
      const m12 = e[12], m13 = e[13], m14 = e[14];
      const ie = mInv.copy(o.matrixWorld).invert().elements;
      const i0 = ie[0], i1 = ie[1], i2 = ie[2];
      const i4 = ie[4], i5 = ie[5], i6 = ie[6];
      const i8 = ie[8], i9 = ie[9], i10 = ie[10];
      const i12 = ie[12], i13 = ie[13], i14 = ie[14];
      let dirty = false;
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i);
        const ly = pos.getY(i);
        const lz = pos.getZ(i);
        const wx = m0 * lx + m4 * ly + m8 * lz + m12;
        const wy = m1 * lx + m5 * ly + m9 * lz + m13;
        const wz = m2 * lx + m6 * ly + m10 * lz + m14;
        if (this.query(wx, wz, wy + 0.32, hit) && hit.surface !== 'grass' && Math.abs(wy - hit.height) < 0.32) {
          const ny = hit.height + lift;
          pos.setXYZ(
            i,
            i0 * wx + i4 * ny + i8 * wz + i12,
            i1 * wx + i5 * ny + i9 * wz + i13,
            i2 * wx + i6 * ny + i10 * wz + i14
          );
          dirty = true;
        }
      }
      if (dirty) pos.needsUpdate = true;
    });
  }

  private readonly scratchH = new Float64Array(32);
  private readonly scratchT = new Int32Array(32);
}

/** Infinite flat ground (tests, garage) */
export class FlatGroundQuery implements GroundQuery {
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
}

/**
 * The `Track_Collider_Wall_Left` / `Track_Collider_Wall_Right` barrier colliders (`userData.collider =
 * 'wall'`, hidden in the render). Each vertical wall triangle becomes the segment between its two
 * vertices farthest apart in XZ; duplicates (the two halves of a quad) are dropped.
 */
export class TrackWallQuery implements WallQuery {
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

  /** Every node with `userData.collider === 'wall'` (or named `Track_Collider_Wall_*`) under the track root */
  static fromTrackRoot(root: THREE.Object3D): TrackWallQuery {
    root.updateMatrixWorld(true);
    const walls: THREE.Object3D[] = [];
    root.traverse((obj) => {
      if (obj.userData?.collider === 'wall' || obj.name.startsWith('Track_Collider_Wall')) walls.push(obj);
    });
    return new TrackWallQuery(walls);
  }

  constructor(objects: THREE.Object3D[]) {
    const segs: number[] = [];
    const seen = new Set<string>();
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (const obj of objects) {
      obj.updateWorldMatrix(true, true);
      obj.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const geom = o.geometry as THREE.BufferGeometry;
        const pos = geom.getAttribute('position');
        if (!pos) return;
        const index = geom.getIndex();
        const n = index ? index.count : pos.count;
        for (let i = 0; i + 2 < n; i += 3) {
          for (let k = 0; k < 3; k++) p[k].fromBufferAttribute(pos, index ? index.getX(i + k) : i + k).applyMatrix4(o.matrixWorld);
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
          if (best < 0.05) continue;
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
 * How far the point (px, py, pz) is past the wall segments `ids[0..count)`, seen from the reference point (refX, refZ)
 * on the near side (the car's CG): the deepest segment the point lies alongside (within its length, and within `ySlack`
 * of its height range; a NaN `py` skips the height test) and behind, up to `maxDepth` (anything deeper is another
 * stretch of wall). The normal points back toward the reference side. Returns the depth, 0 when clear.
 */
export function wallPenetration(
  walls: WallQuery,
  ids: Int32Array,
  count: number,
  px: number,
  py: number,
  pz: number,
  refX: number,
  refZ: number,
  maxDepth: number,
  ySlack: number,
  out: WallHit
): number {
  const seg = walls.segments;
  out.depth = 0;
  for (let k = 0; k < count; k++) {
    const o = ids[k] * WALL_SEGMENT_STRIDE;
    if (py < seg[o + 4] - ySlack || py > seg[o + 5] + ySlack) continue;
    const ax = seg[o];
    const az = seg[o + 1];
    const dx = seg[o + 2] - ax;
    const dz = seg[o + 3] - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    const t = ((px - ax) * dx + (pz - az) * dz) / len2;
    if (t < 0 || t > 1) continue;
    const len = Math.sqrt(len2);
    let nx = -dz / len;
    let nz = dx / len;
    const sr = (refX - ax) * nx + (refZ - az) * nz;
    if (Math.abs(sr) < 1e-4) continue;
    if (sr < 0) {
      nx = -nx;
      nz = -nz;
    }
    const depth = -((px - ax) * nx + (pz - az) * nz);
    if (depth <= 0 || depth > maxDepth || depth <= out.depth) continue;
    out.depth = depth;
    out.nx = nx;
    out.nz = nz;
  }
  return out.depth;
}

/**
 * Where the path (ax, az) → (bx, bz) first crosses one of the wall segments `ids[0..count)` (height test as in
 * `wallPenetration`): the fraction along the path, or −1 when it crosses none. `out` gets that wall's normal toward the
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
