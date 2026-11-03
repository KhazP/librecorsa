// Geometry for the generated Rwanda scenery (rwanda-stands.mjs, rwanda-props.mjs): flat-shaded quads, boxes, beams
// and polygons collected per material, and the vector helpers they use.

/** Per-material vertex lists; flat-shaded quads and boxes, wound so their normal points the way they face */
export class Builder {
  constructor() {
    this.parts = new Map();
  }
  part(mat) {
    if (!this.parts.has(mat)) this.parts.set(mat, { pos: [], nor: [], uv: [], idx: [] });
    return this.parts.get(mat);
  }
  /** Quad a-b-c-d (a loop), facing `out`; uv per corner (defaults to metres along the two edges) */
  quad(mat, a, b, c, d, out, uv) {
    const e1 = sub(b, a);
    const e2 = sub(d, a);
    let n = norm(cross(e1, e2));
    if (dot(n, out) < 0) {
      [b, d] = [d, b];
      if (uv) [uv[1], uv[3]] = [uv[3], uv[1]];
      n = n.map((x) => -x);
    }
    uv ??= [
      [0, 0],
      [len(sub(b, a)), 0],
      [len(sub(b, a)), len(sub(d, a))],
      [0, len(sub(d, a))],
    ];
    const p = this.part(mat);
    const base = p.pos.length / 3;
    for (const [i, v] of [a, b, c, d].entries()) {
      p.pos.push(...v);
      p.nor.push(...n);
      p.uv.push(...uv[i]);
    }
    p.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** Axis-aligned box [x0, x1] × [y0, y1] × [z0, z1]; `skip` names faces to leave out (e.g. 'bottom') */
  box(mat, x0, x1, y0, y1, z0, z1, skip = []) {
    const P = (x, y, z) => [x, y, z];
    const faces = {
      top: [P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1), [0, 1, 0]],
      bottom: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), [0, -1, 0]],
      front: [P(x0, y0, z0), P(x1, y0, z0), P(x1, y1, z0), P(x0, y1, z0), [0, 0, -1]],
      back: [P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), [0, 0, 1]],
      left: [P(x0, y0, z0), P(x0, y1, z0), P(x0, y1, z1), P(x0, y0, z1), [-1, 0, 0]],
      right: [P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1), [1, 0, 0]],
    };
    for (const [name, [a, b, c, d, out]] of Object.entries(faces)) if (!skip.includes(name)) this.quad(mat, a, b, c, d, out);
  }
  /** A square-section beam of width `w` from p0 to p1 (four sides, no end caps) */
  beam(mat, p0, p1, w) {
    const axis = norm(sub(p1, p0));
    const ref = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const s = norm(cross(axis, ref)).map((x) => (x * w) / 2);
    const t = norm(cross(axis, s)).map((x) => (x * w) / 2);
    const corner = (p, i, j) => add(p, add(s.map((x) => x * i), t.map((x) => x * j)));
    for (const [i, j, k, l] of [
      [1, 1, 1, -1],
      [1, -1, -1, -1],
      [-1, -1, -1, 1],
      [-1, 1, 1, 1],
    ]) {
      const a = corner(p0, i, j);
      const b = corner(p0, k, l);
      const out = add(s.map((x) => x * (i + k)), t.map((x) => x * (j + l)));
      this.quad(mat, a, b, corner(p1, k, l), corner(p1, i, j), out);
    }
  }
  /** A flat polygon (convex or a fan from its first point) facing `out` */
  polygon(mat, pts, out) {
    for (let i = 1; i + 1 < pts.length; i++) this.quad(mat, pts[0], pts[i], pts[i + 1], pts[i + 1], out);
  }
  triangles() {
    let n = 0;
    for (const p of this.parts.values()) n += p.idx.length / 3;
    return n;
  }
}
export const sub = (a, b) => a.map((x, i) => x - b[i]);
export const add = (a, b) => a.map((x, i) => x + b[i]);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(...a);
export const norm = (a) => a.map((x) => x / (len(a) || 1));
