import * as THREE from "three";

/**
 * A geometry sharing `src`'s attribute and index buffers (the GLB's primitives often share one vertex buffer, so the
 * source is never modified) with its own planar UV set: each vertex the index references gets (u, v) in 0..1 across
 * the bounding box of those vertices (u along X, mirrored with `flipX`; v along `vAxis`), passed through `map` with
 * the box's width and height. Null when the box is flat, or with `requireIndex` and no index.
 */
export function planarUvGeometry(
  src: THREE.BufferGeometry,
  opts: {
    vAxis?: "y" | "z";
    flipX?: boolean;
    requireIndex?: boolean;
    map: (u: number, v: number, width: number, height: number) => readonly [number, number];
  }
): THREE.BufferGeometry | null {
  const pos = src.getAttribute("position") as THREE.BufferAttribute | undefined;
  const index = src.index;
  if (!pos || (opts.requireIndex && !index)) return null;
  const count = pos.count;
  const used = new Uint8Array(count);
  if (index) for (let i = 0; i < index.count; i++) used[index.getX(i)] = 1;
  else used.fill(1);
  const vOf = opts.vAxis === "z" ? (i: number) => pos.getZ(i) : (i: number) => pos.getY(i);

  let xMin = Infinity, xMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < count; i++) {
    if (!used[i]) continue;
    const x = pos.getX(i);
    const v = vOf(i);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const w = xMax - xMin;
  const h = vMax - vMin;
  if (!(w > 0) || !(h > 0)) return null;

  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    if (!used[i]) continue;
    const u = opts.flipX ? (xMax - pos.getX(i)) / w : (pos.getX(i) - xMin) / w;
    const [mu, mv] = opts.map(u, (vOf(i) - vMin) / h, w, h);
    uv[i * 2] = mu;
    uv[i * 2 + 1] = mv;
  }

  const geo = new THREE.BufferGeometry();
  for (const name in src.attributes) {
    if (name !== "uv") geo.setAttribute(name, src.getAttribute(name));
  }
  if (index) geo.setIndex(index);
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}
