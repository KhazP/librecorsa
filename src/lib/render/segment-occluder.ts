import * as THREE from "three";

/**
 * "Is anything in the way?" for sight lines across a circuit scan, fast. three's Raycaster tests every triangle of
 * every mesh a ray's bounding spheres let through, and a scan's merged meshes span the whole circuit: on a 1-million-
 * triangle Sketchfab track a ray cost ~100 ms on Firefox, and the TV cameras' ~120 sight lines (camera-rig.ts) stalled
 * the first 15 s of driving there.
 *
 * The triangles are copied to world space once and filed in a flat grid of 20 m cells (XZ); a sight line only tests
 * the triangles in the cells it crosses, and stops at the first hit. Faces are culled as three's raycast culls them
 * (front faces of FrontSide materials, back faces of BackSide ones, both for DoubleSide), so the answers match
 * `Raycaster.intersectObjects(meshes, false)` (scripts/verify-tv-occlusion.ts). The build is a generator: it yields
 * every few thousand triangles so it can be spread over idle time.
 */

const CELL_M = 20;
/** Triangles processed between yields while building */
const BUILD_SLICE = 4000;

const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_DOUBLE = 2;

interface Source {
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  index: THREE.BufferAttribute | null;
  /** First and past-the-end vertex-index positions (in index units, or vertices when unindexed) */
  start: number;
  end: number;
  side: number;
  matrices: THREE.Matrix4[];
}

function sideOf(m: THREE.Material): number {
  return m.side === THREE.BackSide ? SIDE_BACK : m.side === THREE.DoubleSide ? SIDE_DOUBLE : SIDE_FRONT;
}

/** The triangle ranges (with their material's side) and world matrices three's raycast would test for these meshes */
function sourcesOf(meshes: readonly THREE.Object3D[]): Source[] {
  const out: Source[] = [];
  for (const obj of meshes) {
    const mesh = obj as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    const pos = geom?.attributes.position;
    if (!mesh.isMesh || !geom || !pos || !mesh.material) continue;
    mesh.updateWorldMatrix(true, false);
    let matrices: THREE.Matrix4[] = [mesh.matrixWorld];
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      matrices = [];
      const m = new THREE.Matrix4();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        matrices.push(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m));
      }
    }
    const index = geom.index;
    const total = index ? index.count : pos.count;
    const drawStart = Math.max(0, geom.drawRange.start);
    const drawEnd = Math.min(total, geom.drawRange.start + geom.drawRange.count);
    const mats = mesh.material;
    if (Array.isArray(mats)) {
      for (const g of geom.groups) {
        const mat = mats[g.materialIndex ?? 0];
        if (!mat) continue;
        const start = Math.max(g.start, drawStart);
        const end = Math.min(g.start + g.count, drawEnd);
        if (end > start) out.push({ pos, index, start, end, side: sideOf(mat), matrices });
      }
    } else if (drawEnd > drawStart) {
      out.push({ pos, index, start: drawStart, end: drawEnd, side: sideOf(mats), matrices });
    }
  }
  return out;
}

export class SegmentOccluder {
  private tris = new Float32Array(0);
  private sides = new Uint8Array(0);
  private stamp = new Uint32Array(0);
  private query = 0;
  private cellStart = new Uint32Array(0);
  private cellTris = new Uint32Array(0);
  private minX = 0;
  private minZ = 0;
  private nx = 0;
  private nz = 0;
  private readonly ray = new THREE.Ray();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();

  /** Builds the index of these meshes (as collected for a Raycaster: visible meshes only) */
  *build(meshes: readonly THREE.Object3D[]): Generator<void, void, void> {
    const sources = sourcesOf(meshes);
    let count = 0;
    for (const s of sources) count += Math.floor((s.end - s.start) / 3) * s.matrices.length;
    const tris = new Float32Array(count * 9);
    const sides = new Uint8Array(count);
    const v = new THREE.Vector3();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    // World-space copy of every triangle
    let t = 0;
    let sinceYield = 0;
    for (const s of sources) {
      for (const m of s.matrices) {
        for (let i = s.start; i + 2 < s.end; i += 3) {
          for (let k = 0; k < 3; k++) {
            const vi = s.index ? s.index.getX(i + k) : i + k;
            v.fromBufferAttribute(s.pos, vi).applyMatrix4(m);
            const o = t * 9 + k * 3;
            tris[o] = v.x;
            tris[o + 1] = v.y;
            tris[o + 2] = v.z;
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
          }
          sides[t++] = s.side;
          if (++sinceYield >= BUILD_SLICE) {
            sinceYield = 0;
            yield;
          }
        }
      }
    }
    if (count === 0) return;
    const nx = Math.max(1, Math.ceil((maxX - minX) / CELL_M) + 1);
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL_M) + 1);
    // Cell ranges of each triangle's bounding box: counted, then filed (compressed rows)
    const cellStart = new Uint32Array(nx * nz + 1);
    const span = (tri: number, visit: (cell: number) => void) => {
      const o = tri * 9;
      const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]);
      const x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]);
      const z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      const cx0 = Math.floor((x0 - minX) / CELL_M), cx1 = Math.floor((x1 - minX) / CELL_M);
      const cz0 = Math.floor((z0 - minZ) / CELL_M), cz1 = Math.floor((z1 - minZ) / CELL_M);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) visit(cz * nx + cx);
    };
    for (let i = 0; i < count; i++) {
      span(i, (cell) => cellStart[cell + 1]++);
      if (++sinceYield >= BUILD_SLICE) {
        sinceYield = 0;
        yield;
      }
    }
    for (let c = 0; c < nx * nz; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, nx * nz);
    const cellTris = new Uint32Array(cellStart[nx * nz]);
    for (let i = 0; i < count; i++) {
      span(i, (cell) => {
        cellTris[fill[cell]++] = i;
      });
      if (++sinceYield >= BUILD_SLICE) {
        sinceYield = 0;
        yield;
      }
    }
    Object.assign(this, { tris, sides, stamp: new Uint32Array(count), cellStart, cellTris, minX, minZ, nx, nz });
  }

  /** Whether a triangle lies on the ray from `origin` along unit `dir` within `far` metres (three's face culling) */
  blocked(origin: THREE.Vector3, dir: THREE.Vector3, far: number): boolean {
    if (this.nx === 0 || far <= 0) return false;
    const q = ++this.query;
    if (q === 0xffffffff) {
      this.stamp.fill(0);
      this.query = 1;
    }
    this.ray.set(origin, dir);
    const { nx, nz, minX, minZ } = this;
    // Walk the cells the segment crosses in XZ (Amanatides & Woo)
    const x0 = (origin.x - minX) / CELL_M, z0 = (origin.z - minZ) / CELL_M;
    const x1 = x0 + (dir.x * far) / CELL_M, z1 = z0 + (dir.z * far) / CELL_M;
    let cx = Math.floor(x0), cz = Math.floor(z0);
    const ex = Math.floor(x1), ez = Math.floor(z1);
    const sx = Math.sign(x1 - x0), sz = Math.sign(z1 - z0);
    const dx = Math.abs(x1 - x0), dz = Math.abs(z1 - z0);
    const tdx = dx > 0 ? 1 / dx : Infinity, tdz = dz > 0 ? 1 / dz : Infinity;
    let tmx = dx > 0 ? (sx > 0 ? cx + 1 - x0 : x0 - cx) * tdx : Infinity;
    let tmz = dz > 0 ? (sz > 0 ? cz + 1 - z0 : z0 - cz) * tdz : Infinity;
    for (let guard = 0; guard < 100000; guard++) {
      if (cx >= 0 && cz >= 0 && cx < nx && cz < nz && this.cellHits(cz * nx + cx, q, far)) return true;
      if (cx === ex && cz === ez) return false;
      if (tmx < tmz) {
        if (tmx > 1) return false;
        cx += sx;
        tmx += tdx;
      } else {
        if (tmz > 1) return false;
        cz += sz;
        tmz += tdz;
      }
    }
    return false;
  }

  private cellHits(cell: number, q: number, far: number): boolean {
    const { tris, sides, stamp, cellTris } = this;
    for (let k = this.cellStart[cell], e = this.cellStart[cell + 1]; k < e; k++) {
      const i = cellTris[k];
      if (stamp[i] === q) continue;
      stamp[i] = q;
      const o = i * 9;
      this.a.set(tris[o], tris[o + 1], tris[o + 2]);
      this.b.set(tris[o + 3], tris[o + 4], tris[o + 5]);
      this.c.set(tris[o + 6], tris[o + 7], tris[o + 8]);
      const side = sides[i];
      const p =
        side === SIDE_BACK
          ? this.ray.intersectTriangle(this.c, this.b, this.a, true, this.hit)
          : this.ray.intersectTriangle(this.a, this.b, this.c, side === SIDE_FRONT, this.hit);
      if (p && p.distanceTo(this.ray.origin) <= far) return true;
    }
    return false;
  }
}
