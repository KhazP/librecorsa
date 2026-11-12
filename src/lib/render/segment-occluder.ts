import * as THREE from "three";

/**
 * "Is anything in the way?" for sight lines across a circuit scan, fast. three's Raycaster tests every triangle of
 * every mesh a ray's bounding spheres let through, and a scan's merged meshes span the whole circuit: on a 1-million-
 * triangle Sketchfab track a ray cost ~100 ms on Firefox, and the TV cameras' ~120 sight lines (camera-rig.ts) stalled
 * the first 15 s of driving there.
 *
 * A plain mesh's triangles are copied to world space once and filed in a flat grid of 20 m cells (XZ). An instanced
 * mesh's triangles are kept once, in its own space, and each instance is filed by its world box: a sight line that
 * reaches the box is taken into the instance's space and tested there, as three's InstancedMesh.raycast does. Copying
 * every instance to world space instead cost 36 bytes per triangle per instance: RISE Motordrome's 14,000 trees came
 * to 16 M triangles and a 750 MB array, enough on its own to get the tab killed on a phone.
 *
 * A sight line only tests what lies in the cells it crosses, and stops at the first hit. Faces are culled as three's
 * raycast culls them (front faces of FrontSide materials, back faces of BackSide ones, both for DoubleSide), and only
 * objects on a default Raycaster's layers count (not the sun's shadow-only proxies), so the answers match
 * `Raycaster.intersectObjects(meshes, false)` (scripts/verify-tv-occlusion.ts). The build is a generator: it yields
 * every few thousand triangles so it can be spread over idle time.
 */

const CELL_M = 20;
/** Triangles (or instances) processed between yields while building */
const BUILD_SLICE = 4000;
/** Slack on an instance's world box, so rounding never drops a triangle that lies on its face */
const BOX_PAD_M = 1e-3;
/** The layers a default THREE.Raycaster tests: objects on none of them are skipped, as it skips them */
const RAYCAST_LAYERS = new THREE.Layers();

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
  /** The mesh's world matrix */
  matrix: THREE.Matrix4;
  /** Each instance's world matrix (the mesh's times the instance's); null for a plain mesh */
  instances: THREE.Matrix4[] | null;
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
    if (!mesh.isMesh || !geom || !pos || !mesh.material || !mesh.layers.test(RAYCAST_LAYERS)) continue;
    mesh.updateWorldMatrix(true, false);
    let instances: THREE.Matrix4[] | null = null;
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      instances = [];
      const m = new THREE.Matrix4();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, m);
        instances.push(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, m));
      }
    }
    const index = geom.index;
    const total = index ? index.count : pos.count;
    const drawStart = Math.max(0, geom.drawRange.start);
    const drawEnd = Math.min(total, geom.drawRange.start + geom.drawRange.count);
    const mats = mesh.material;
    const matrix = mesh.matrixWorld;
    if (Array.isArray(mats)) {
      for (const g of geom.groups) {
        const mat = mats[g.materialIndex ?? 0];
        if (!mat) continue;
        const start = Math.max(g.start, drawStart);
        const end = Math.min(g.start + g.count, drawEnd);
        if (end > start) out.push({ pos, index, start, end, side: sideOf(mat), matrix, instances });
      }
    } else if (drawEnd > drawStart) {
      out.push({ pos, index, start: drawStart, end: drawEnd, side: sideOf(mats), matrix, instances });
    }
  }
  return out;
}

const triCount = (s: Source) => Math.floor((s.end - s.start) / 3);

export class SegmentOccluder {
  /** World-space triangles of the plain meshes (9 floats each) and their faces' side */
  private tris = new Float32Array(0);
  private sides = new Uint8Array(0);
  /** Instanced geometry, once per shape in its own space: triangles, and each shape's first triangle, count, side */
  private shapeTris = new Float32Array(0);
  private shapeStart = new Uint32Array(0);
  private shapeCount = new Uint32Array(0);
  private shapeSide = new Uint8Array(0);
  /** Per instance: its shape, world matrix (16, column-major) and world box (min xyz, max xyz) */
  private instShape = new Uint32Array(0);
  private instMatrix = new Float64Array(0);
  private instBox = new Float32Array(0);
  /** Items filed in the grid: triangles 0..triCount-1, then instances */
  private triCount = 0;
  private stamp = new Uint32Array(0);
  private query = 0;
  private cellStart = new Uint32Array(0);
  private cellItems = new Uint32Array(0);
  private minX = 0;
  private minZ = 0;
  private nx = 0;
  private nz = 0;
  private readonly ray = new THREE.Ray();
  private readonly localRay = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly matrix = new THREE.Matrix4();
  private readonly inverse = new THREE.Matrix4();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly c = new THREE.Vector3();
  private readonly hit = new THREE.Vector3();

  /** Memory the index holds, in bytes */
  get byteLength(): number {
    return [
      this.tris, this.sides, this.shapeTris, this.shapeStart, this.shapeCount, this.shapeSide,
      this.instShape, this.instMatrix, this.instBox, this.stamp, this.cellStart, this.cellItems,
    ].reduce((sum, a) => sum + a.byteLength, 0);
  }

  /** Builds the index of these meshes (as collected for a Raycaster: visible meshes only) */
  *build(meshes: readonly THREE.Object3D[]): Generator<void, void, void> {
    const sources = sourcesOf(meshes);
    const plain = sources.filter((s) => !s.instances);
    const instanced = sources.filter((s) => s.instances && s.instances.length > 0);

    // Each instanced triangle range once (the tiles of a forest share a handful of tree meshes)
    const shapes: Source[] = [];
    const shapeOf = instanced.map((s) => {
      let k = shapes.findIndex((o) => o.pos === s.pos && o.index === s.index && o.start === s.start && o.end === s.end && o.side === s.side);
      if (k < 0) k = shapes.push(s) - 1;
      return k;
    });
    let count = 0;
    for (const s of plain) count += triCount(s);
    let shapeTriTotal = 0;
    for (const s of shapes) shapeTriTotal += triCount(s);
    let instances = 0;
    for (const s of instanced) instances += s.instances!.length;

    const tris = new Float32Array(count * 9);
    const sides = new Uint8Array(count);
    const shapeTris = new Float32Array(shapeTriTotal * 9);
    const shapeStart = new Uint32Array(shapes.length);
    const shapeCount = new Uint32Array(shapes.length);
    const shapeSide = new Uint8Array(shapes.length);
    const instShape = new Uint32Array(instances);
    const instMatrix = new Float64Array(instances * 16);
    const instBox = new Float32Array(instances * 6);
    const v = new THREE.Vector3();
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    let sinceYield = 0;
    /** Copies a range's triangles into `out` from triangle `t` on: to world space through `m`, or as they are */
    function* copy(s: Source, out: Float32Array, t: number, m: THREE.Matrix4 | null): Generator<void, number, void> {
      for (let i = s.start; i + 2 < s.end; i += 3) {
        for (let k = 0; k < 3; k++) {
          const vi = s.index ? s.index.getX(i + k) : i + k;
          v.fromBufferAttribute(s.pos, vi);
          if (m) {
            v.applyMatrix4(m);
            if (v.x < minX) minX = v.x;
            if (v.x > maxX) maxX = v.x;
            if (v.z < minZ) minZ = v.z;
            if (v.z > maxZ) maxZ = v.z;
          }
          const o = t * 9 + k * 3;
          out[o] = v.x;
          out[o + 1] = v.y;
          out[o + 2] = v.z;
        }
        t++;
        if (++sinceYield >= BUILD_SLICE) {
          sinceYield = 0;
          yield;
        }
      }
      return t;
    }

    // World-space copy of every plain triangle
    let t = 0;
    for (const s of plain) {
      const first = t;
      t = yield* copy(s, tris, t, s.matrix);
      sides.fill(s.side, first, t);
    }

    // Each shape once in its own space, with its box there
    const shapeBoxes: THREE.Box3[] = [];
    t = 0;
    for (let k = 0; k < shapes.length; k++) {
      shapeStart[k] = t;
      shapeSide[k] = shapes[k].side;
      const first = t;
      t = yield* copy(shapes[k], shapeTris, t, null);
      shapeCount[k] = t - first;
      const box = new THREE.Box3();
      for (let i = first * 9; i < t * 9; i += 3) box.expandByPoint(v.set(shapeTris[i], shapeTris[i + 1], shapeTris[i + 2]));
      shapeBoxes.push(box);
    }

    // Every instance: its world matrix and its shape's box in world space
    const box = new THREE.Box3();
    let j = 0;
    for (let n = 0; n < instanced.length; n++) {
      const k = shapeOf[n];
      for (const m of instanced[n].instances!) {
        instShape[j] = k;
        m.toArray(instMatrix, j * 16);
        box.copy(shapeBoxes[k]).applyMatrix4(m).expandByScalar(BOX_PAD_M);
        box.min.toArray(instBox, j * 6);
        box.max.toArray(instBox, j * 6 + 3);
        if (box.min.x < minX) minX = box.min.x;
        if (box.max.x > maxX) maxX = box.max.x;
        if (box.min.z < minZ) minZ = box.min.z;
        if (box.max.z > maxZ) maxZ = box.max.z;
        j++;
        if (++sinceYield >= BUILD_SLICE) {
          sinceYield = 0;
          yield;
        }
      }
    }

    const items = count + instances;
    if (items === 0) return;
    const nx = Math.max(1, Math.ceil((maxX - minX) / CELL_M) + 1);
    const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL_M) + 1);
    // Cell ranges of each item's bounding box (XZ): counted, then filed (compressed rows)
    const cellStart = new Uint32Array(nx * nz + 1);
    const span = (item: number, visit: (cell: number) => void) => {
      let x0: number, x1: number, z0: number, z1: number;
      if (item < count) {
        const o = item * 9;
        x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]);
        x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
        z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]);
        z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      } else {
        const o = (item - count) * 6;
        x0 = instBox[o];
        z0 = instBox[o + 2];
        x1 = instBox[o + 3];
        z1 = instBox[o + 5];
      }
      const cx0 = Math.floor((x0 - minX) / CELL_M), cx1 = Math.floor((x1 - minX) / CELL_M);
      const cz0 = Math.floor((z0 - minZ) / CELL_M), cz1 = Math.floor((z1 - minZ) / CELL_M);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) visit(cz * nx + cx);
    };
    for (let i = 0; i < items; i++) {
      span(i, (cell) => cellStart[cell + 1]++);
      if (++sinceYield >= BUILD_SLICE) {
        sinceYield = 0;
        yield;
      }
    }
    for (let c = 0; c < nx * nz; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, nx * nz);
    const cellItems = new Uint32Array(cellStart[nx * nz]);
    for (let i = 0; i < items; i++) {
      span(i, (cell) => {
        cellItems[fill[cell]++] = i;
      });
      if (++sinceYield >= BUILD_SLICE) {
        sinceYield = 0;
        yield;
      }
    }
    Object.assign(this, {
      tris, sides, shapeTris, shapeStart, shapeCount, shapeSide, instShape, instMatrix, instBox,
      triCount: count, stamp: new Uint32Array(items), cellStart, cellItems, minX, minZ, nx, nz,
    });
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
    const { tris, sides, stamp, cellItems, triCount } = this;
    for (let k = this.cellStart[cell], e = this.cellStart[cell + 1]; k < e; k++) {
      const i = cellItems[k];
      if (stamp[i] === q) continue;
      stamp[i] = q;
      if (i >= triCount) {
        if (this.instanceHits(i - triCount, far)) return true;
        continue;
      }
      const o = i * 9;
      this.a.set(tris[o], tris[o + 1], tris[o + 2]);
      this.b.set(tris[o + 3], tris[o + 4], tris[o + 5]);
      this.c.set(tris[o + 6], tris[o + 7], tris[o + 8]);
      if (this.triangleHit(this.ray, sides[i]) && this.hit.distanceTo(this.ray.origin) <= far) return true;
    }
    return false;
  }

  /** An instance, tested in its own space as three's Mesh.raycast tests it, with the hit measured in world space */
  private instanceHits(j: number, far: number): boolean {
    const { instBox, shapeTris } = this;
    const o = j * 6;
    this.box.min.set(instBox[o], instBox[o + 1], instBox[o + 2]);
    this.box.max.set(instBox[o + 3], instBox[o + 4], instBox[o + 5]);
    // A hit inside the box is at least as far as where the ray enters it (from inside, intersectBox gives the exit)
    if (!this.box.containsPoint(this.ray.origin)) {
      const entry = this.ray.intersectBox(this.box, this.hit);
      if (!entry || entry.distanceTo(this.ray.origin) > far) return false;
    }
    this.matrix.fromArray(this.instMatrix, j * 16);
    this.localRay.copy(this.ray).applyMatrix4(this.inverse.copy(this.matrix).invert());
    const s = this.instShape[j];
    const side = this.shapeSide[s];
    for (let t = this.shapeStart[s], e = t + this.shapeCount[s]; t < e; t++) {
      const p = t * 9;
      this.a.set(shapeTris[p], shapeTris[p + 1], shapeTris[p + 2]);
      this.b.set(shapeTris[p + 3], shapeTris[p + 4], shapeTris[p + 5]);
      this.c.set(shapeTris[p + 6], shapeTris[p + 7], shapeTris[p + 8]);
      if (this.triangleHit(this.localRay, side) && this.hit.applyMatrix4(this.matrix).distanceTo(this.ray.origin) <= far) {
        return true;
      }
    }
    return false;
  }

  /** The ray against triangle a-b-c with three's culling for this side; the point lands in `hit` */
  private triangleHit(ray: THREE.Ray, side: number): boolean {
    const p =
      side === SIDE_BACK
        ? ray.intersectTriangle(this.c, this.b, this.a, true, this.hit)
        : ray.intersectTriangle(this.a, this.b, this.c, side === SIDE_FRONT, this.hit);
    return p !== null;
  }
}
