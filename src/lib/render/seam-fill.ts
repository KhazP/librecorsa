import * as THREE from "three";
import { inheritedTag, materialNameOf } from "./fit-visual-road";

/**
 * Fills the open seams along a converted circuit's road edges. A mod's asphalt and the terrain beside it don't meet:
 * at Willow Springs nearly half the edge has a gap of a few centimetres between them, and the terrain often starts a
 * centimetre or two above the asphalt's edge. With nothing under the road, the eye goes through the slit to the sky's
 * ground below the horizon, a dark line along the white lines all round the lap. A mod's own layers hide it no better:
 * fitting them with their gaps kept (fit-visual-road.ts) is what shows it from the cockpit.
 *
 * Under each outer edge of the asphalt (the circuit's road materials) this lays a strip `FILL_WIDTH_M` wide, drawn as
 * the surface beside it: its material, and its texture, colours and normals carried on from that surface's own
 * triangle. The strip starts just under the asphalt's edge, and at each step across it, it stays under whatever
 * surface is there: it only shows where nothing was. It goes under the `Track_Model` the surface beside it is in,
 * tagged `onGround` (no shadow) and `seamFill`.
 *
 * Run after `fitVisualRoad`, on the fitted heights. Returns how many pieces of edge it filled.
 */
export interface SeamFillOptions {
  /**
   * The lap being driven, as points along it with how far from each the edges are filled (m): the rest of a circuit's
   * roads (another layout's, the paddock's) are left as they are. Every edge without it
   */
  lap?: readonly { x: number; z: number; reach: number }[];
}

export function fillRoadSeams(root: THREE.Object3D, roadMaterials?: readonly string[], opts: SeamFillOptions = {}): number {
  const road = new Set(roadMaterials ?? []);
  if (!road.size) return 0;
  const models: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === "Track_Model") models.push(o);
  });
  if (!models.length) return 0;
  root.updateMatrixWorld(true);

  // Every surface that can be drawn beside an edge or hide a strip: not decals, grooves or other see-through layers (cut
  // out or blended: a strip drawn as one would show its holes, one under it would show through), and not what moves
  const meshes: THREE.Mesh[] = [];
  for (const tm of models) tm.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry?.getAttribute("position") || m.userData.seamFill) return;
    if (inheritedTag(m, "decal", root) || inheritedTag(m, "groove", root) || m.geometry.getAttribute("_drift") || seeThrough(m)) return;
    meshes.push(m);
  });
  const world = new Map<THREE.Mesh, Float32Array>();
  const worldOf = (m: THREE.Mesh): Float32Array => {
    let w = world.get(m);
    if (!w) {
      const pos = m.geometry.getAttribute("position");
      const flat = !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && pos.itemSize === 3 && !pos.normalized;
      const src = pos.array as ArrayLike<number>;
      // Already in world space: read as it is
      if (flat && src instanceof Float32Array && m.matrixWorld.equals(IDENTITY)) {
        world.set(m, src);
        return src;
      }
      w = new Float32Array(pos.count * 3);
      const e = m.matrixWorld.elements;
      for (let i = 0; i < pos.count; i++) {
        const x = flat ? src[i * 3] : pos.getX(i);
        const y = flat ? src[i * 3 + 1] : pos.getY(i);
        const z = flat ? src[i * 3 + 2] : pos.getZ(i);
        w[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
        w[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        w[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      world.set(m, w);
    }
    return w;
  };
  const triIndex = (m: THREE.Mesh) => m.geometry.index?.array ?? null;

  // The asphalt's outer edges: the edges only one of its triangles uses, the road meshes welded together by position
  // (to the millimetre across the ground)
  const weld = new Map<number, number>();
  const welded: number[] = [];
  const idOf = (x: number, y: number, z: number) => {
    const key = (Math.round(x * 1000) + 2 ** 25) * 2 ** 26 + (Math.round(z * 1000) + 2 ** 25);
    let id = weld.get(key);
    if (id === undefined) {
      id = welded.length / 3;
      weld.set(key, id);
      welded.push(x, y, z);
    }
    return id;
  };
  // Within reach of the lap, on a coarse grid
  const lapCells = new Set<number>();
  for (const { x, z, reach } of opts.lap ?? []) {
    const r = Math.ceil(reach / LAP_CELL_M);
    const cx = Math.floor(x / LAP_CELL_M);
    const cz = Math.floor(z / LAP_CELL_M);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Every cell any part of which is within reach
        if (Math.max(0, Math.abs(dx) - 1) ** 2 + Math.max(0, Math.abs(dz) - 1) ** 2 <= r * r) {
          lapCells.add((cx + dx + 32768) * 65536 + (cz + dz + 32768));
        }
      }
    }
  }
  const nearLap = (x: number, z: number) =>
    !opts.lap || lapCells.has((Math.floor(x / LAP_CELL_M) + 32768) * 65536 + (Math.floor(z / LAP_CELL_M) + 32768));
  // Every triangle's corners as welded vertices, those near the lap
  // The asphalt: the road materials' meshes that lie flat, not a stand in a road material
  const asphalt = meshes.filter((m) => road.has(materialNameOf(m)) && !inheritedTag(m, "keepShape", root) && liesFlat(m, worldOf(m)));
  let corners = 0;
  for (const m of asphalt) corners += m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count;
  const tris = new Int32Array(corners);
  let triCorners = 0;
  for (const m of asphalt) {
    const w = worldOf(m);
    const index = triIndex(m);
    const count = index ? index.length : w.length / 3;
    const ids = new Int32Array(w.length / 3).fill(-1);
    const id = (i: number) => (ids[i] >= 0 ? ids[i] : (ids[i] = idOf(w[i * 3], w[i * 3 + 1], w[i * 3 + 2])));
    for (let t = 0; t + 2 < count; t += 3) {
      const a0 = index ? index[t] : t;
      const a1 = index ? index[t + 1] : t + 1;
      const a2 = index ? index[t + 2] : t + 2;
      if (opts.lap && !nearLap(w[a0 * 3], w[a0 * 3 + 2]) && !nearLap(w[a1 * 3], w[a1 * 3 + 2]) && !nearLap(w[a2 * 3], w[a2 * 3 + 2])) {
        continue;
      }
      const v0 = id(a0);
      const v1 = id(a1);
      const v2 = id(a2);
      if (v0 === v1 || v1 === v2 || v2 === v0) continue;
      tris[triCorners++] = v0;
      tris[triCorners++] = v1;
      tris[triCorners++] = v2;
    }
  }
  // Each edge listed under its lower vertex: an edge listed once is an outer edge
  const vertexCount = welded.length / 3;
  const start = new Int32Array(vertexCount + 1);
  const next = (k: number) => (k % 3 === 2 ? k - 2 : k + 1);
  for (let k = 0; k < triCorners; k++) {
    const a = tris[k];
    const b = tris[next(k)];
    start[(a < b ? a : b) + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, vertexCount);
  /** Per listed edge: the other vertex, then the edge's own first and second vertex and its triangle's third */
  const other = new Int32Array(triCorners);
  const edgeAt = new Int32Array(triCorners);
  for (let k = 0; k < triCorners; k++) {
    const a = tris[k];
    const b = tris[next(k)];
    const slot = fill[a < b ? a : b]++;
    other[slot] = a < b ? b : a;
    edgeAt[slot] = k;
  }
  const edgeInfo: number[] = [];
  for (let v = 0; v < vertexCount; v++) {
    for (let i = start[v]; i < start[v + 1]; i++) {
      let n = 0;
      for (let j = start[v]; j < start[v + 1]; j++) if (other[j] === other[i]) n++;
      if (n !== 1) continue;
      const k = edgeAt[i];
      const base = k - (k % 3);
      edgeInfo.push(1, tris[k], tris[next(k)], tris[base + ((k % 3) + 2) % 3]);
    }
  }
  // Each outer vertex's way out: the average of its edges' outward directions across the ground
  const out = new Map<number, [number, number]>();
  const outer: [number, number][] = [];
  for (let e = 0; e < edgeInfo.length; e += 4) {
    if (edgeInfo[e] !== 1) continue;
    const a = edgeInfo[e + 1];
    const b = edgeInfo[e + 2];
    const c = edgeInfo[e + 3];
    if (!nearLap((welded[a * 3] + welded[b * 3]) / 2, (welded[a * 3 + 2] + welded[b * 3 + 2]) / 2)) continue;
    let nx = welded[b * 3 + 2] - welded[a * 3 + 2];
    let nz = welded[a * 3] - welded[b * 3];
    const len = Math.hypot(nx, nz);
    if (!(len > 1e-6)) continue;
    nx /= len;
    nz /= len;
    // Away from the triangle's third corner
    if (nx * (welded[c * 3] - welded[a * 3]) + nz * (welded[c * 3 + 2] - welded[a * 3 + 2]) > 0) {
      nx = -nx;
      nz = -nz;
    }
    for (const v of [a, b]) {
      const o = out.get(v);
      if (o) {
        o[0] += nx;
        o[1] += nz;
      } else out.set(v, [nx, nz]);
    }
    outer.push([a, b]);
  }
  if (!outer.length) return 0;
  for (const o of out.values()) {
    const len = Math.hypot(o[0], o[1]) || 1;
    o[0] /= len;
    o[1] /= len;
  }
  // The edges cut into pieces of at most `PIECE_M`, so a strip follows the ground between the asphalt's vertices: each
  // point as x, y, z and its way out (x, z); a vertex's point shared by its two edges
  const points: number[] = [];
  const pieces: [number, number][] = [];
  const pointOf = new Map<number, number>();
  const vertexPoint = (v: number) => {
    let i = pointOf.get(v);
    if (i === undefined) {
      i = points.length / 5;
      const [ox, oz] = out.get(v)!;
      points.push(welded[v * 3], welded[v * 3 + 1], welded[v * 3 + 2], ox, oz);
      pointOf.set(v, i);
    }
    return i;
  };
  for (const [a, b] of outer) {
    const ia = vertexPoint(a);
    const ib = vertexPoint(b);
    const n = Math.max(1, Math.ceil(Math.hypot(welded[b * 3] - welded[a * 3], welded[b * 3 + 2] - welded[a * 3 + 2]) / PIECE_M));
    let prev = ia;
    for (let k = 1; k <= n; k++) {
      let next = ib;
      if (k < n) {
        const t = k / n;
        const lerp = (o: number) => points[ia * 5 + o] + (points[ib * 5 + o] - points[ia * 5 + o]) * t;
        const ox = lerp(3);
        const oz = lerp(4);
        const len = Math.hypot(ox, oz) || 1;
        next = points.length / 5;
        points.push(lerp(0), lerp(1), lerp(2), ox / len, oz / len);
      }
      pieces.push([prev, next]);
      prev = next;
    }
  }

  // The cells (a grid over the edges) the strips cover
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < points.length; i += 5) {
    minX = Math.min(minX, points[i]);
    maxX = Math.max(maxX, points[i]);
    minZ = Math.min(minZ, points[i + 2]);
    maxZ = Math.max(maxZ, points[i + 2]);
  }
  minX -= 2 * CELL_M;
  minZ -= 2 * CELL_M;
  const nx = Math.floor((maxX + 2 * CELL_M - minX) / CELL_M) + 1;
  const nz = Math.floor((maxZ + 2 * CELL_M - minZ) / CELL_M) + 1;
  const cellOf = (x: number, z: number) => {
    const cx = Math.floor((x - minX) / CELL_M);
    const cz = Math.floor((z - minZ) / CELL_M);
    return cx >= 0 && cx < nx && cz >= 0 && cz < nz ? cz * nx + cx : -1;
  };
  const wanted = new Uint8Array(nx * nz);
  for (let i = 0; i < points.length; i += 5) {
    for (const s of [0, 0.5, 1]) {
      const c = cellOf(points[i] + points[i + 3] * FILL_WIDTH_M * s, points[i + 2] + points[i + 4] * FILL_WIDTH_M * s);
      if (c >= 0) wanted[c] = 1;
    }
  }
  // The wanted cells and their neighbours
  const near = new Uint8Array(nx * nz);
  for (let cz = 0; cz < nz; cz++) {
    for (let cx = 0; cx < nx; cx++) {
      if (!wanted[cz * nx + cx]) continue;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const z = cz + dz;
          if (x >= 0 && x < nx && z >= 0 && z < nz) near[z * nx + x] = 1;
        }
      }
    }
  }
  // Every surface's triangles in those cells, each as its mesh, its number and its world corners
  const cells = new Map<number, number[]>();
  const box = new THREE.Box3();
  meshes.forEach((m, mi) => {
    m.geometry.computeBoundingBox();
    box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
    // Left out unless it reaches a cell near an edge
    const bx0 = Math.max(0, Math.floor((box.min.x - minX) / CELL_M));
    const bx1 = Math.min(nx - 1, Math.floor((box.max.x - minX) / CELL_M));
    const bz0 = Math.max(0, Math.floor((box.min.z - minZ) / CELL_M));
    const bz1 = Math.min(nz - 1, Math.floor((box.max.z - minZ) / CELL_M));
    let reaches = false;
    for (let cz = bz0; cz <= bz1 && !reaches; cz++) {
      for (let cx = bx0; cx <= bx1; cx++) {
        if (near[cz * nx + cx]) {
          reaches = true;
          break;
        }
      }
    }
    if (!reaches) return;
    const w = worldOf(m);
    const index = triIndex(m);
    const count = index ? index.length : w.length / 3;
    // Vertices in or next to a wanted cell; a triangle with none and no more than a cell across is left out
    const close = new Uint8Array(w.length / 3);
    for (let i = 0; i < close.length; i++) {
      const c = cellOf(w[i * 3], w[i * 3 + 2]);
      close[i] = c >= 0 && near[c] ? 1 : 0;
    }
    for (let t = 0; t + 2 < count; t += 3) {
      const a0 = index ? index[t] : t;
      const a1 = index ? index[t + 1] : t + 1;
      const a2 = index ? index[t + 2] : t + 2;
      const i0 = a0 * 3;
      const i1 = a1 * 3;
      const i2 = a2 * 3;
      if (
        !close[a0] && !close[a1] && !close[a2] &&
        Math.abs(w[i0] - w[i1]) < CELL_M && Math.abs(w[i0] - w[i2]) < CELL_M &&
        Math.abs(w[i0 + 2] - w[i1 + 2]) < CELL_M && Math.abs(w[i0 + 2] - w[i2 + 2]) < CELL_M
      ) {
        continue;
      }
      const x0 = Math.floor((Math.min(w[i0], w[i1], w[i2]) - minX) / CELL_M);
      const x1 = Math.floor((Math.max(w[i0], w[i1], w[i2]) - minX) / CELL_M);
      const z0 = Math.floor((Math.min(w[i0 + 2], w[i1 + 2], w[i2 + 2]) - minZ) / CELL_M);
      const z1 = Math.floor((Math.max(w[i0 + 2], w[i1 + 2], w[i2 + 2]) - minZ) / CELL_M);
      if (x1 < 0 || z1 < 0 || x0 >= nx || z0 >= nz) continue;
      for (let cz = Math.max(0, z0); cz <= Math.min(nz - 1, z1); cz++) {
        for (let cx = Math.max(0, x0); cx <= Math.min(nx - 1, x1); cx++) {
          const k = cz * nx + cx;
          if (!wanted[k]) continue;
          let list = cells.get(k);
          if (!list) cells.set(k, (list = []));
          list.push(mi, t / 3, w[i0], w[i0 + 1], w[i0 + 2], w[i1], w[i1 + 1], w[i1 + 2], w[i2], w[i2 + 1], w[i2 + 2]);
        }
      }
    }
  });

  /** A triangle's corners' vertex numbers */
  const cornersOf = (mi: number, tri: number): [number, number, number] => {
    const index = triIndex(meshes[mi]);
    return index ? [index[tri * 3], index[tri * 3 + 1], index[tri * 3 + 2]] : [tri * 3, tri * 3 + 1, tri * 3 + 2];
  };
  /**
   * The surfaces at (x, z) between `lo` and `hi`, into `look`: the top one's height (-Infinity: none), and the mesh
   * and triangle of the one nearest `near` in height (-1: none)
   */
  const look = { top: -Infinity, mesh: -1, tri: -1 };
  const lookAt = (x: number, z: number, lo: number, hi: number, near: number) => {
    look.top = -Infinity;
    look.mesh = -1;
    look.tri = -1;
    const c = cellOf(x, z);
    const list = c >= 0 ? cells.get(c) : undefined;
    if (!list) return look;
    let nearest = Infinity;
    for (let k = 0; k < list.length; k += STRIDE) {
      const v0x = list[k + 5] - list[k + 2];
      const v0z = list[k + 7] - list[k + 4];
      const v1x = list[k + 8] - list[k + 2];
      const v1z = list[k + 10] - list[k + 4];
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const px = x - list[k + 2];
      const pz = z - list[k + 4];
      const u = (px * v1z - v1x * pz) / den;
      const v = (v0x * pz - px * v0z) / den;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = list[k + 3] + u * (list[k + 6] - list[k + 3]) + v * (list[k + 9] - list[k + 3]);
      if (y < lo || y > hi) continue;
      if (y > look.top) look.top = y;
      const d = Math.abs(y - near);
      if (d < nearest) {
        nearest = d;
        look.mesh = list[k];
        look.tri = list[k + 1];
      }
    }
    return look;
  };
  /** Whether the top surface meets an edge at height `y`: there, not over it nor far under it */
  const meetsEdge = (top: number, y: number) => top <= y + MEET_ABOVE_M && top >= y - MEET_BELOW_M;

  /**
   * Each point across the strip: its steps (just under the asphalt's edge, then under whatever is at each step, or at
   * the edge's height less the drop where nothing is); the surface beside the edge that draws it (the one nearest the
   * edge's height, the terrain and not a wall's top: halfway across the strip, or wherever across it there is one);
   * and whether that surface meets the edge (nothing to fill)
   */
  interface Across {
    pts: Float32Array;
    host: { mesh: number; tri: number } | null;
    meets: boolean;
  }
  const across = new Map<number, Across>();
  const acrossAt = (x0: number, ey: number, z0: number, ox: number, oz: number): Across => {
    const pts = new Float32Array(FILL_STEPS_M.length * 3);
    const hosts: ({ mesh: number; tri: number } | null)[] = [];
    let meets = meetsEdge(lookAt(x0 + ox * MEET_FIRST_M, z0 + oz * MEET_FIRST_M, ey - SEARCH_BELOW_M, ey + SEARCH_ABOVE_M, ey).top, ey);
    FILL_STEPS_M.forEach((d, k) => {
      const x = x0 + ox * d;
      const z = z0 + oz * d;
      let y = ey - FILL_DROP_M;
      hosts.push(null);
      if (d > 0) {
        const l = lookAt(x, z, ey - SEARCH_BELOW_M, ey + SEARCH_ABOVE_M, ey);
        if (l.top > -Infinity) y = Math.min(y, l.top - FILL_UNDER_M);
        if (l.mesh >= 0) hosts[k] = { mesh: l.mesh, tri: l.tri };
        if (d <= MEET_LAST_M && !meetsEdge(l.top, ey)) meets = false;
      }
      pts[k * 3] = x;
      pts[k * 3 + 1] = y;
      pts[k * 3 + 2] = z;
    });
    // Out past the last step with a surface (a drop, the model's end) the strip stops: no ledge over nothing
    let last = 0;
    FILL_STEPS_M.forEach((_, k) => {
      if (hosts[k]) last = k;
    });
    for (let k = last + 1; k < FILL_STEPS_M.length; k++) pts.copyWithin(k * 3, last * 3, last * 3 + 3);
    let host: { mesh: number; tri: number } | null = null;
    for (const k of HOST_STEPS) if (!host) host = hosts[k];
    return { pts, host, meets };
  };
  const acrossOf = (i: number): Across => {
    let a = across.get(i);
    if (!a) {
      a = acrossAt(points[i * 5], points[i * 5 + 1], points[i * 5 + 2], points[i * 5 + 3], points[i * 5 + 4]);
      across.set(i, a);
    }
    return a;
  };

  // A strip per piece, built into one mesh per surface (and material) it is drawn as; a point's row of vertices is
  // shared by its pieces in that mesh. Nothing where the surface beside meets the edge at both ends and halfway
  // between
  const builders = new Map<string, StripBuilder>();
  let laid = 0;
  for (const [ia, ib] of pieces) {
    const a = acrossOf(ia);
    const b = acrossOf(ib);
    if (a.meets && b.meets) {
      const half = (o: number) => (points[ia * 5 + o] + points[ib * 5 + o]) / 2;
      const len = Math.hypot(half(3), half(4)) || 1;
      if (acrossAt(half(0), half(1), half(2), half(3) / len, half(4) / len).meets) continue;
    }
    const host = a.host ?? b.host;
    if (!host) continue;
    const hostMesh = meshes[host.mesh];
    const group = materialIndexOf(hostMesh, host.tri);
    const key = `${hostMesh.uuid}:${group}`;
    let builder = builders.get(key);
    if (!builder) {
      builder = new StripBuilder(hostMesh, group, trackModelOf(hostMesh, root), world.get(hostMesh)!);
      builders.set(key, builder);
    }
    // Each row as its own point's surface draws it, where that is the same mesh; else as this piece's
    const rowTri = (own: Across["host"]) => (own && own.mesh === host.mesh ? own.tri : host.tri);
    const ra = builder.row(ia, a.pts, cornersOf(host.mesh, rowTri(a.host)));
    const rb = builder.row(ib, b.pts, cornersOf(host.mesh, rowTri(b.host)));
    // Wound counter-clockwise seen from above
    const pa = a.pts;
    const pb = b.pts;
    const up = (pb[2] - pa[2]) * (pa[3] - pa[0]) - (pb[0] - pa[0]) * (pa[5] - pa[2]) >= 0;
    builder.join(ra, rb, FILL_STEPS_M.length, up);
    laid++;
  }
  for (const builder of builders.values()) builder.attach();
  return laid;
}

/** How far out from the asphalt's edge a strip reaches (m), in steps: most gaps are under 5 cm, a few tens of cm */
const FILL_STEPS_M = [0, 0.02, 0.08, 0.3];
const FILL_WIDTH_M = FILL_STEPS_M[FILL_STEPS_M.length - 1];
/** The asphalt lies flat: this share of its area faces up within this much (`normal.y`) */
const FLAT_SHARE = 0.9;
const FLAT_NORMAL_Y = 0.9;
/**
 * Where the surface beside an edge meets it, there is nothing to fill: there from `MEET_FIRST_M` out to `MEET_LAST_M`
 * (m, at the strip's steps in between), no more
 * than `MEET_ABOVE_M` over the edge (a step up shows a slit from the road) and no more than `MEET_BELOW_M` under it (a
 * step down shows one from outside)
 */
const MEET_FIRST_M = 0.003;
const MEET_LAST_M = 0.02;
const MEET_ABOVE_M = 0.002;
const MEET_BELOW_M = 0.02;
/** Longest piece of an edge a strip follows straight (m) */
const PIECE_M = 2;
/** The steps across a strip where the surface it is drawn as is looked for, in turn */
const HOST_STEPS = [2, 3, 1];
/** A strip starts this far under the asphalt's edge (m) */
const FILL_DROP_M = 0.005;
/** and stays this far under any surface over it (m) */
const FILL_UNDER_M = 0.01;
/** The surface beside an edge is looked for this far under and over it (m): not the ground under a bridge, not a sign */
const SEARCH_BELOW_M = 1;
const SEARCH_ABOVE_M = 0.5;
const IDENTITY = new THREE.Matrix4();
/** Grid cell for the lap's reach (m) */
const LAP_CELL_M = 8;
/** Grid cell for the surface lookup (m) */
const CELL_M = 2;
/** Numbers per triangle in a cell's list: mesh, triangle, its 9 world corner coordinates */
const STRIDE = 11;

/**
 * Whether a mesh's material lets what is under it show: blended or cut out, as the GLB sets it (scene-builder.ts makes
 * some of them opaque later, from their textures), or as the Node scripts' reader records it
 */
function seeThrough(m: THREE.Mesh): boolean {
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material | undefined;
  const mode = m.userData.alphaMode as string | undefined;
  return mode === "MASK" || mode === "BLEND" || !!(mat && (mat.transparent || mat.alphaTest > 0));
}

/** Whether at least `FLAT_SHARE` of a mesh's area faces up within `FLAT_NORMAL_Y` (its world corners `w`) */
function liesFlat(m: THREE.Mesh, w: Float32Array): boolean {
  const index = m.geometry.index?.array ?? null;
  const count = index ? index.length : w.length / 3;
  let all = 0;
  let flat = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const i0 = (index ? index[t] : t) * 3;
    const i1 = (index ? index[t + 1] : t + 1) * 3;
    const i2 = (index ? index[t + 2] : t + 2) * 3;
    const ax = w[i1] - w[i0];
    const ay = w[i1 + 1] - w[i0 + 1];
    const az = w[i1 + 2] - w[i0 + 2];
    const bx = w[i2] - w[i0];
    const by = w[i2 + 1] - w[i0 + 1];
    const bz = w[i2 + 2] - w[i0 + 2];
    const ny = az * bx - ax * bz;
    const area = Math.hypot(ay * bz - az * by, ny, ax * by - ay * bx);
    all += area;
    if (Math.abs(ny) >= FLAT_NORMAL_Y * area) flat += area;
  }
  return all > 0 && flat >= FLAT_SHARE * all;
}

/**
 * Barycentric weights of (x, z) in a triangle's ground plan, its corners at `i0`, `i1`, `i2` in world positions `w`,
 * into `out`. False when degenerate, or outside unless `outside`
 */
function barycentric(
  w: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  x: number,
  z: number,
  outside: boolean,
  out: [number, number, number]
): boolean {
  const v0x = w[i1] - w[i0];
  const v0z = w[i1 + 2] - w[i0 + 2];
  const v1x = w[i2] - w[i0];
  const v1z = w[i2 + 2] - w[i0 + 2];
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-12) return false;
  const px = x - w[i0];
  const pz = z - w[i0 + 2];
  const u = (px * v1z - v1x * pz) / den;
  const v = (v0x * pz - px * v0z) / den;
  if (!outside && (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6)) return false;
  out[0] = 1 - u - v;
  out[1] = u;
  out[2] = v;
  return true;
}

/** The material slot of a mesh's triangle (its geometry group), 0 for a single material */
function materialIndexOf(mesh: THREE.Mesh, tri: number): number {
  if (!Array.isArray(mesh.material)) return 0;
  for (const g of mesh.geometry.groups) {
    if (tri * 3 >= g.start && tri * 3 < g.start + g.count) return g.materialIndex ?? 0;
  }
  return 0;
}

function trackModelOf(obj: THREE.Object3D, root: THREE.Object3D): THREE.Object3D {
  for (let node: THREE.Object3D | null = obj; node && node !== root; node = node.parent) {
    if (node.name === "Track_Model") return node;
  }
  return root;
}

/**
 * The strips drawn as one surface: every attribute of the surface's geometry carried on from its triangle (texture
 * coordinates, colours, normals) to the strip's corners, positions in its `Track_Model`'s space
 */
class StripBuilder {
  private readonly positions: number[] = [];
  private readonly indices: number[] = [];
  private readonly rows = new Map<number, number>();
  private readonly toModel: THREE.Matrix4;
  private readonly normalToModel = new THREE.Matrix3();
  private readonly n = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly w: [number, number, number] = [0, 0, 0];
  /** The surface's attributes other than its positions, each with the list it fills */
  private readonly attrs: { name: string; attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute; list: number[] }[];

  constructor(
    private readonly host: THREE.Mesh,
    private readonly group: number,
    private readonly model: THREE.Object3D,
    private readonly world: Float32Array
  ) {
    this.toModel = model.matrixWorld.clone().invert();
    // The surface's normals into the strip's space: through the world
    this.normalToModel.getNormalMatrix(this.toModel.clone().multiply(host.matrixWorld));
    this.attrs = Object.entries(host.geometry.attributes)
      .filter(([name]) => name !== "position")
      .map(([name, attr]) => ({ name, attr, list: [] }));
  }

  /** A point's row of vertices across the strip (`acrossOf`), drawn as the surface's triangle `corners`: its first */
  row(point: number, pts: Float32Array, corners: [number, number, number]): number {
    const known = this.rows.get(point);
    if (known !== undefined) return known;
    const first = this.positions.length / 3;
    this.rows.set(point, first);
    const [c0, c1, c2] = corners;
    for (let k = 0; k < pts.length; k += 3) {
      const x = pts[k];
      const z = pts[k + 2];
      this.p.set(x, pts[k + 1], z).applyMatrix4(this.toModel);
      this.positions.push(this.p.x, this.p.y, this.p.z);
      if (!barycentric(this.world, c0 * 3, c1 * 3, c2 * 3, x, z, true, this.w)) this.w.fill(1 / 3);
      const [w0, w1, w2] = this.w;
      for (const { name, attr, list } of this.attrs) {
        if (name === "normal") {
          this.n.set(
            attr.getX(c0) * w0 + attr.getX(c1) * w1 + attr.getX(c2) * w2,
            attr.getY(c0) * w0 + attr.getY(c1) * w1 + attr.getY(c2) * w2,
            attr.getZ(c0) * w0 + attr.getZ(c1) * w1 + attr.getZ(c2) * w2
          );
          this.n.applyMatrix3(this.normalToModel).normalize();
          list.push(this.n.x, this.n.y, this.n.z);
          continue;
        }
        for (let c = 0; c < attr.itemSize; c++) {
          let v = attr.getComponent(c0, c) * w0 + attr.getComponent(c1, c) * w1 + attr.getComponent(c2, c) * w2;
          // Colours stay colours where the weights reach past the triangle
          if (name.startsWith("color")) v = Math.min(1, Math.max(0, v));
          list.push(v);
        }
      }
    }
    return first;
  }

  /** The quads between two rows of `steps` vertices, facing up; a corner a row folds onto itself drops out */
  join(ra: number, rb: number, steps: number, up: boolean): void {
    for (let k = 0; k + 1 < steps; k++) {
      const a0 = ra + k;
      const a1 = ra + k + 1;
      const b0 = rb + k;
      const b1 = rb + k + 1;
      if (up) this.triangle(a0, b0, b1), this.triangle(a0, b1, a1);
      else this.triangle(a0, b1, b0), this.triangle(a0, a1, b1);
    }
  }

  /** A triangle, if it has an area and faces up in the strip's space */
  private triangle(i0: number, i1: number, i2: number): void {
    // As the 32-bit positions the GPU draws: a sliver can turn flat or over in them
    const p = this.positions;
    const f = Math.fround;
    const ex = f(p[i1 * 3]) - f(p[i0 * 3]);
    const ez = f(p[i1 * 3 + 2]) - f(p[i0 * 3 + 2]);
    const fx = f(p[i2 * 3]) - f(p[i0 * 3]);
    const fz = f(p[i2 * 3 + 2]) - f(p[i0 * 3 + 2]);
    if (ez * fx - ex * fz > 1e-8) this.indices.push(i0, i1, i2);
  }

  attach(): void {
    if (!this.positions.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setIndex(this.indices);
    for (const { name, attr, list } of this.attrs) geo.setAttribute(name, new THREE.Float32BufferAttribute(list, attr.itemSize));
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    const mat = Array.isArray(this.host.material) ? this.host.material[this.group] : this.host.material;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `${this.host.name || "surface"}_seam_fill`;
    mesh.userData.seamFill = true;
    mesh.userData.onGround = true;
    if (this.host.userData.materialName) mesh.userData.materialName = this.host.userData.materialName;
    this.model.add(mesh);
    mesh.updateMatrixWorld(true);
  }
}
