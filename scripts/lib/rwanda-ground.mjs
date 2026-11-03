// Shared by the Rwanda scenery generators (rwanda-scenery.mjs, rwanda-stands.mjs): welded pieces of a primitive, a
// stable position hash, and the ground the physics drives on.

/** Welded connected pieces of a primitive: bounds and centroid of each */
export function pieces(prim) {
  const pos = prim.getAttribute('POSITION');
  const n = pos.getCount();
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const weldMap = new Map();
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const k = `${Math.round(v[0] * 1000)},${Math.round(v[1] * 1000)},${Math.round(v[2] * 1000)}`;
    const first = weldMap.get(k);
    if (first === undefined) weldMap.set(k, i);
    else union(i, first);
  }
  const idx = prim.getIndices();
  const triCount = idx ? idx.getCount() / 3 : n / 3;
  for (let t = 0; t < triCount; t++) {
    const a = idx ? idx.getScalar(3 * t) : 3 * t;
    const b = idx ? idx.getScalar(3 * t + 1) : 3 * t + 1;
    const c = idx ? idx.getScalar(3 * t + 2) : 3 * t + 2;
    union(a, b);
    union(b, c);
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const r = find(i);
    let g = groups.get(r);
    if (!g) {
      g = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], sum: [0, 0, 0], n: 0 };
      groups.set(r, g);
    }
    for (let a = 0; a < 3; a++) {
      g.min[a] = Math.min(g.min[a], v[a]);
      g.max[a] = Math.max(g.max[a], v[a]);
      g.sum[a] += v[a];
    }
    g.n++;
  }
  return [...groups.values()].map((g) => ({
    cx: g.sum[0] / g.n,
    cz: g.sum[2] / g.n,
    minY: g.min[1],
    maxY: g.max[1],
    height: g.max[1] - g.min[1],
    width: Math.max(g.max[0] - g.min[0], g.max[2] - g.min[2]),
  }));
}

/** Stable 0..1 hash of a position */
export function hash(x, z, salt = 0) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The ground the physics drives on (the circuit's `surface`-tagged meshes: terrain, road, kerbs, run-off, pit lane):
 * under (x, z), the highest triangle at or below `probeY`, its surface and height. XZ point-in-triangle on an 8 m
 * grid with barycentric height; these nodes carry no transforms, so their vertices are world positions.
 */
export function groundSampler(doc) {
  const CELL = 8;
  const cells = new Map();
  const tris = [];
  for (const node of doc.getRoot().listNodes()) {
    const surface = node.getExtras()?.surface;
    if (typeof surface !== 'string') continue;
    for (const prim of node.getMesh()?.listPrimitives() ?? []) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      const pt = (i) => pos.getElement(idx ? idx.getScalar(i) : i, [0, 0, 0]);
      for (let i = 0; i + 2 < n; i += 3) {
        const t = { a: pt(i), b: pt(i + 1), c: pt(i + 2), surface };
        const k = tris.push(t) - 1;
        const xs = [t.a[0], t.b[0], t.c[0]];
        const zs = [t.a[2], t.b[2], t.c[2]];
        for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++)
          for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
            const key = `${cx},${cz}`;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(k);
          }
      }
    }
  }
  return (x, z, probeY = Infinity) => {
    let best = null;
    for (const k of cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? []) {
      const { a, b, c, surface } = tris[k];
      const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const height = l1 * a[1] + l2 * b[1] + l3 * c[1];
      if (height <= probeY && (!best || height > best.height)) best = { height, surface };
    }
    return best;
  };
}

/** A point through a column-major 4×4 matrix */
export const apply = (W, v) => [
  W[0] * v[0] + W[4] * v[1] + W[8] * v[2] + W[12],
  W[1] * v[0] + W[5] * v[1] + W[9] * v[2] + W[13],
  W[2] * v[0] + W[6] * v[1] + W[10] * v[2] + W[14],
];

/** World positions of a node's vertices (every `step`th), with their material names */
export function worldPoints(node, step = 1) {
  const W = node.getWorldMatrix();
  const out = [];
  for (const prim of node.getMesh().listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    const mat = prim.getMaterial()?.getName() ?? '';
    for (let i = 0; i < pos.getCount(); i += step) out.push({ p: apply(W, pos.getElement(i, [0, 0, 0])), mat });
  }
  return out;
}

/**
 * The separate objects of a merged node, as lists of world points: vertices joined by shared positions and
 * triangles into pieces, then pieces whose boxes come within `gap` metres (in plan) into one object.
 */
export function worldClusters(node, gap) {
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
      const g = gap;
      if (a.lo[0] - g <= b.hi[0] && b.lo[0] - g <= a.hi[0] && a.lo[2] - g <= b.hi[2] && b.lo[2] - g <= a.hi[2]) cp[cf(i)] = cf(j);
    }
  const clusters = new Map();
  list.forEach((b, i) => {
    const r = cf(i);
    if (!clusters.has(r)) clusters.set(r, []);
    clusters.get(r).push(...b.members.map((m) => pts[m].p));
  });
  return [...clusters.values()];

}
