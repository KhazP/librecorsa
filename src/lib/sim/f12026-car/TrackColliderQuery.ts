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
 * Height comes from the highest drivable visual surface under the wheel (road, kerb, sausage, run-off,
 * pit lane, gravel): those are swept at the full sample resolution, so they carry the real vertical
 * curves. The road collider (one row every 6 m, three points across) only fills in where no drivable
 * surface exists, with kerbs and sausages still allowed above it; failing both, the highest tagged surface
 * (terrain) is used. The surface / grip of a contact is the top-most tagged surface within
 * `SURFACE_MATCH_M` of the contact height, falling back to the contact layer's own tags.
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
/** Swept visual surfaces a car drives on (everything tagged but terrain grass) */
const DRIVABLE_SURFACES: ReadonlySet<TrackSurfaceKind> = new Set(['road', 'kerb', 'sausage', 'runoff', 'pitlane', 'gravel']);
const SURFACE_MATCH_M = 0.05;
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
  static fromTrackRoot(root: THREE.Object3D, table: SurfaceTable = DEFAULT_SURFACE_TABLE): TrackColliderQuery {
    root.updateMatrixWorld(true);
    const sources: ColliderLayerSource[] = [];
    const found: { road?: THREE.Object3D } = {};
    root.traverse((obj) => {
      if (obj.name === 'Track_Collider_Road') found.road = obj;
      else if (asSurface(obj.userData?.surface) && !obj.userData?.collider) sources.push({ object: obj });
    });
    if (!found.road) throw new Error('TrackColliderQuery: Track_Collider_Road not found under the track root');
    sources.unshift({ object: found.road, isRoadCollider: true });
    return new TrackColliderQuery(sources, table);
  }

  constructor(sources: ColliderLayerSource[], table: SurfaceTable = DEFAULT_SURFACE_TABLE) {
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
      this.layers.push({ name: src.object.name, isRoadCollider, surface, grip, props, tagged: !!(src.surface ?? tagged), uvScaleM });

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

    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_M));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_M));

    // Two passes: count, then fill (CSR)
    const cellCount = this.nx * this.nz;
    const counts = new Uint32Array(cellCount + 1);
    const forEachCell = (t: number, fn: (cell: number) => void) => {
      const o = t * 9;
      const x0 = Math.min(tri[o], tri[o + 3], tri[o + 6]);
      const x1 = Math.max(tri[o], tri[o + 3], tri[o + 6]);
      const z0 = Math.min(tri[o + 2], tri[o + 5], tri[o + 8]);
      const z1 = Math.max(tri[o + 2], tri[o + 5], tri[o + 8]);
      const cx0 = this.cellX(x0);
      const cx1 = this.cellX(x1);
      const cz0 = this.cellZ(z0);
      const cz1 = this.cellZ(z1);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.nx + cx);
    };
    for (let t = 0; t < this.triangleCount; t++) if (keep[t]) forEachCell(t, (cell) => counts[cell + 1]++);
    for (let i = 0; i < cellCount; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellTris = new Uint32Array(counts[cellCount]);
    const fill = counts.slice(0, cellCount);
    for (let t = 0; t < this.triangleCount; t++) if (keep[t]) forEachCell(t, (cell) => (this.cellTris[fill[cell]++] = t));
  }

  private cellX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL_SIZE_M)));
  }

  private cellZ(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL_SIZE_M)));
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
        if (layer.tagged && DRIVABLE_SURFACES.has(layer.surface) && h > driveH) {
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

    let contactT: number;
    let contactH: number;
    let contactU: number;
    let contactV: number;
    if (driveT >= 0) {
      contactT = driveT;
      contactH = driveH;
      contactU = driveU;
      contactV = driveV;
    } else if (roadT >= 0) {
      if (raisedT >= 0 && raisedH > roadH) {
        contactT = raisedT;
        contactH = raisedH;
        contactU = raisedU;
        contactV = raisedV;
      } else {
        contactT = roadT;
        contactH = roadH;
        contactU = roadU;
        contactV = roadV;
      }
    } else if (anyT >= 0) {
      contactT = anyT;
      contactH = anyH;
      contactU = anyU;
      contactV = anyV;
    } else {
      return false;
    }

    // Classify: top-most tagged surface near the contact height, else the contact layer itself
    let bestTagT = -1;
    let bestTagH = -Infinity;
    for (let i = 0; i < tagCount; i++) {
      if (Math.abs(tagH[i] - contactH) <= SURFACE_MATCH_M && tagH[i] > bestTagH) {
        bestTagH = tagH[i];
        bestTagT = tagT[i];
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

    const vo = contactT * 9;
    const vn = this.triVertNormal;
    const w = 1 - contactU - contactV;
    const nx = w * vn[vo] + contactU * vn[vo + 3] + contactV * vn[vo + 6];
    const ny = w * vn[vo + 1] + contactU * vn[vo + 4] + contactV * vn[vo + 7];
    const nz = w * vn[vo + 2] + contactU * vn[vo + 5] + contactV * vn[vo + 8];
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
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / CELL_SIZE_M));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL_SIZE_M));

    const cellCount = this.nx * this.nz;
    const counts = new Uint32Array(cellCount + 1);
    const forEachCell = (i: number, fn: (cell: number) => void) => {
      const o = i * WALL_SEGMENT_STRIDE;
      const cx0 = this.cellX(Math.min(segs[o], segs[o + 2]));
      const cx1 = this.cellX(Math.max(segs[o], segs[o + 2]));
      const cz0 = this.cellZ(Math.min(segs[o + 1], segs[o + 3]));
      const cz1 = this.cellZ(Math.max(segs[o + 1], segs[o + 3]));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) fn(cz * this.nx + cx);
    };
    for (let i = 0; i < this.segmentCount; i++) forEachCell(i, (cell) => counts[cell + 1]++);
    for (let i = 0; i < cellCount; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellSegs = new Uint32Array(counts[cellCount]);
    const fill = counts.slice(0, cellCount);
    for (let i = 0; i < this.segmentCount; i++) forEachCell(i, (cell) => (this.cellSegs[fill[cell]++] = i));
  }

  private cellX(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / CELL_SIZE_M)));
  }

  private cellZ(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / CELL_SIZE_M)));
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
