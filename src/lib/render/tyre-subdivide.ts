/**
 * Tread subdivision for the deforming tyres. WebGL2 has no tessellation, so the tyre deformation
 * (`tyre-deformation.ts`) can only move the vertices a model has: a tread of 40-80 segments round the tyre (the AMG
 * GT3's has 40) shows its facets where the patch flattens, shears and bulges. A tyre coarser than TARGET_SEGMENTS has
 * the circumferential edges of its tread band split once at load, doubling its segments there (the AMG GT3's 40 become
 * 80, the 64-80 of the older F1 cars 128-160); finer tyres (the LC26's 105) are left as they are. One pass keeps the
 * AI field's tyres within the triangle count the LC26's already have.
 *
 * The split is crack-free: each edge is split or not by itself (its two ends in the tread band, spanning an angle round
 * the axle), so both triangles on an edge agree, and every triangle is re-cut by how many of its edges were split
 * (red-green refinement). A new vertex sits on the tyre's arc, not on the chord: the mean radius and axial position of
 * the edge's ends, in the direction of their bisector. Every other attribute is the plain mean of the ends', normals
 * included and left unnormalised: three.js normalises them per vertex, so the shading is the same, and the Pirelli
 * sidewall's face mask (`pirelli-sidewall.ts`, the rest normal's raw x, interpolated) stays exactly where it was; its
 * fit is taken from the model's own geometry. The result is a new geometry holding only the tyre's own vertices (the
 * AMG GT3's rim and tyre share one vertex buffer), cached per source geometry so every car built from a template
 * shares one copy.
 */
import * as THREE from "three";

/** Segments round the tyre a tread should have at least */
const TARGET_SEGMENTS = 96;
/** The tread band: vertices at least this fraction of the outer radius out (the shoulders, the bulge and shear zone) */
const BAND_FROM_R = 0.8;
/** An edge spanning more than this share of a segment's angle runs round the tyre (ring edges and quad diagonals) */
const SPLIT_SHARE = 0.3;

const cache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();

/** The tyre geometry with its tread subdivided, or the geometry itself when it is fine enough (or not a tyre lathe) */
export function subdivideTyreTread(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = cache.get(geometry);
  if (cached) return cached;
  let out = geometry;
  const pos = geometry.getAttribute("position");
  // Multi-material, morphing and skinned meshes are left alone
  const plain =
    geometry.groups.length === 0 &&
    Object.keys(geometry.morphAttributes).length === 0 &&
    !geometry.getAttribute("skinIndex");
  if (pos && pos.count >= 3 && plain) {
    const segments = treadSegments(geometry);
    if (segments > 0 && segments < TARGET_SEGMENTS) out = splitTread(geometry, (2 * Math.PI) / segments);
  }
  cache.set(geometry, out);
  return out;
}

/** Index of corner k of triangle t */
function cornerIndex(index: THREE.BufferAttribute | null, k: number): number {
  return index ? index.getX(k) : k;
}

function outerRadius(
  pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: THREE.BufferAttribute | null
): number {
  let outer = 0;
  const n = index ? index.count : pos.count;
  for (let k = 0; k < n; k++) {
    const i = cornerIndex(index, k);
    outer = Math.max(outer, Math.hypot(pos.getY(i), pos.getZ(i)));
  }
  return outer;
}

/** Angle between two vertices round the axle (X), from their (y, z) */
function spanAngle(ay: number, az: number, by: number, bz: number): number {
  const dot = (ay * by + az * bz) / Math.max(1e-12, Math.hypot(ay, az) * Math.hypot(by, bz));
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** Segments round the tyre: 2π over the median angle spanned by the tread's edges (0 when there is no tread) */
function treadSegments(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const outer = outerRadius(pos, index);
  if (!(outer > 0)) return 0;
  const tris = Math.floor((index ? index.count : pos.count) / 3);
  // Enough triangles for a steady median on the finest tyres
  const stride = Math.max(1, Math.floor(tris / 6000));
  const spans: number[] = [];
  for (let t = 0; t < tris; t += stride) {
    for (let e = 0; e < 3; e++) {
      const a = cornerIndex(index, 3 * t + e);
      const b = cornerIndex(index, 3 * t + ((e + 1) % 3));
      const ay = pos.getY(a), az = pos.getZ(a), by = pos.getY(b), bz = pos.getZ(b);
      if (Math.hypot(ay, az) < 0.95 * outer || Math.hypot(by, bz) < 0.95 * outer) continue;
      const span = spanAngle(ay, az, by, bz);
      if (span > 0.003) spans.push(span);
    }
  }
  if (spans.length < 8) return 0;
  spans.sort((x, y) => x - y);
  return (2 * Math.PI) / spans[spans.length >> 1];
}

/** One red-green pass over the tread band's circumferential edges; `segmentRad` is the current segment angle */
function splitTread(geometry: THREE.BufferGeometry, segmentRad: number): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const outer = outerRadius(pos, index);
  const corners = index ? index.count : pos.count;
  const names = Object.keys(geometry.attributes);
  const sources = names.map((name) => geometry.getAttribute(name));

  // The tyre's own vertices, renumbered (a shared vertex buffer may hold the rim's too)
  const remap = new Map<number, number>();
  const used: number[] = [];
  for (let k = 0; k < corners; k++) {
    const i = cornerIndex(index, k);
    if (!remap.has(i)) {
      remap.set(i, used.length);
      used.push(i);
    }
  }
  const values: number[][] = sources.map(() => []);
  const read = (attr: (typeof sources)[number], i: number, c: number) =>
    c === 0 ? attr.getX(i) : c === 1 ? attr.getY(i) : c === 2 ? attr.getZ(i) : attr.getW(i);
  for (const i of used) {
    sources.forEach((attr, s) => {
      for (let c = 0; c < attr.itemSize; c++) values[s].push(read(attr, i, c));
    });
  }
  const pIdx = names.indexOf("position");
  const P = values[pIdx];
  const radiusOf = (v: number) => Math.hypot(P[3 * v + 1], P[3 * v + 2]);

  const vertexCount = () => P.length / 3;
  const mids = new Map<number, number>();
  const splitThreshold = SPLIT_SHARE * segmentRad;
  const bandR = BAND_FROM_R * outer;
  /** Midpoint vertex of edge (a, b), or −1 when the edge is not split */
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 0x200000 + b : b * 0x200000 + a;
    const known = mids.get(key);
    if (known !== undefined) return known;
    let m = -1;
    const ra = radiusOf(a);
    const rb = radiusOf(b);
    if (
      ra >= bandR &&
      rb >= bandR &&
      spanAngle(P[3 * a + 1], P[3 * a + 2], P[3 * b + 1], P[3 * b + 2]) > splitThreshold
    ) {
      m = vertexCount();
      names.forEach((name, s) => {
        const V = values[s];
        const size = sources[s].itemSize;
        if (name === "position") {
          // On the arc: mean radius and axial position, in the direction of the ends' bisector
          const y = P[3 * a + 1] / ra + P[3 * b + 1] / rb;
          const z = P[3 * a + 2] / ra + P[3 * b + 2] / rb;
          const len = Math.max(1e-9, Math.hypot(y, z));
          const r = 0.5 * (ra + rb);
          V.push(0.5 * (P[3 * a] + P[3 * b]), (r * y) / len, (r * z) / len);
        } else if (name === "tangent") {
          // The mean direction (the shaders normalise it), the handedness (w) from the first end
          for (let c = 0; c < 3; c++) V.push(0.5 * (V[size * a + c] + V[size * b + c]));
          V.push(V[size * a + 3]);
        } else {
          for (let c = 0; c < size; c++) V.push(0.5 * (V[size * a + c] + V[size * b + c]));
        }
      });
    }
    mids.set(key, m);
    return m;
  };

  const tris: number[] = [];
  const v = [0, 0, 0];
  const m = [0, 0, 0];
  for (let k = 0; k + 2 < corners; k += 3) {
    for (let c = 0; c < 3; c++) v[c] = remap.get(cornerIndex(index, k + c))!;
    // m[c]: the midpoint of edge (v[c], v[c + 1])
    let splits = 0;
    for (let c = 0; c < 3; c++) {
      m[c] = midpoint(v[c], v[(c + 1) % 3]);
      if (m[c] >= 0) splits++;
    }
    if (splits === 0) {
      tris.push(v[0], v[1], v[2]);
    } else if (splits === 3) {
      tris.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]);
    } else {
      // Rotate so the split edges come first: one split on edge 0, or two on edges 0 and 1
      let r = 0;
      if (splits === 1) r = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
      else r = m[2] < 0 ? 0 : m[0] < 0 ? 1 : 2;
      const v0 = v[r], v1 = v[(r + 1) % 3], v2 = v[(r + 2) % 3];
      const m0 = m[r], m1 = m[(r + 1) % 3];
      if (splits === 1) tris.push(v0, m0, v2, m0, v1, v2);
      else tris.push(m0, v1, m1, v0, m0, m1, v0, m1, v2);
    }
  }

  const out = new THREE.BufferGeometry();
  names.forEach((name, s) => {
    out.setAttribute(name, new THREE.Float32BufferAttribute(values[s], sources[s].itemSize));
  });
  out.setIndex(tris);
  out.name = geometry.name;
  out.userData = { ...geometry.userData, treadSubdivided: true };
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}
