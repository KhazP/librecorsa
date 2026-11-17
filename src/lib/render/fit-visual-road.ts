import * as THREE from "three";
import { createGroundHit, TrackColliderQuery, type GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";

/**
 * The nearest `userData[key]` on `obj` or its ancestors below `root`: glTF node extras land on the node, and the
 * meshes under it inherit nothing
 */
export function inheritedTag<T = unknown>(obj: THREE.Object3D, key: string, root?: THREE.Object3D): T | undefined {
  for (let node: THREE.Object3D | null = obj; node && node !== root; node = node.parent) {
    const v = node.userData?.[key];
    if (v !== undefined && v !== null && v !== false) return v as T;
  }
  return undefined;
}

/** How far above or below the fitted ground a visual vertex may be and still belong to the road (m) */
const FIT_WINDOW_M = 0.32;
/** Decals and grooves sit this far above the road they are laid on (m) */
const OVERLAY_LIFT_M = 0.002;

/**
 * Lays a converted circuit's visual road (`Track_Model`) onto its fitted ground, so the drawn road follows the
 * colliders across crests and compressions and the wheels sit on what the player sees. Grass is left as modelled.
 *
 * Meshes the converter already laid on the colliders (`keepShape`: a mod's modelled kerbs, moved with the road and
 * driven on as drawn) are left as built. On such a circuit the rest is laid on the ground under a kerb, not on its
 * top, so the road beneath stays beneath it; decals and grooves still go on top.
 */
export function fitVisualRoad(root: THREE.Object3D, ground: GroundQuery): void {
  // Every `Track_Model` there is (a venue's split model puts its shared scenery under the layout's own)
  const models: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.name === "Track_Model") models.push(o);
  });
  if (!models.length) return;
  root.updateMatrixWorld(true);
  const hit = createGroundHit();
  let shaped = false;
  for (const tm of models) tm.traverse((o) => {
    if (o.userData?.keepShape) shaped = true;
  });
  const base = shaped && ground instanceof TrackColliderQuery ? ground : null;
  // Leaves out, before the ground query, the vertices the fit cannot move (most of a scan)
  const reach = roadReach(ground);
  const inv = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const seen = new Set<THREE.BufferGeometry>();
  for (const tm of models) tm.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry || seen.has(o.geometry) || inheritedTag(o, "keepShape", root)) return;
    seen.add(o.geometry);
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    const overlay = !!(inheritedTag(o, "decal", root) || inheritedTag(o, "groove", root));
    const lift = overlay ? OVERLAY_LIFT_M : 0;
    const under = overlay ? null : base;
    inv.copy(o.matrixWorld).invert();
    let dirty = false;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (reach && !reach(v.x, v.y, v.z)) continue;
      const found = under ? under.queryBase(v.x, v.z, v.y + FIT_WINDOW_M, hit) : ground.query(v.x, v.z, v.y + FIT_WINDOW_M, hit);
      if (!found || hit.surface === "grass" || !(Math.abs(v.y - hit.height) < FIT_WINDOW_M)) continue;
      v.y = hit.height + lift;
      v.applyMatrix4(inv);
      pos.setXYZ(i, v.x, v.y, v.z);
      dirty = true;
    }
    if (dirty) pos.needsUpdate = true;
  });
}

/** Cell size of `roadReach`'s grid (m) */
const REACH_CELL_M = 4;
/**
 * Margin for the ground query's barycentric tolerance (a point up to 1e-6 of an edge outside a triangle still hits
 * it, and its height is extrapolated as far) and for float rounding (m)
 */
const REACH_SLACK_M = 0.01;

/**
 * A cheap test, before the ground query, that leaves out the vertices `fitVisualRoad` cannot move (most of a scan:
 * scenery away from the road, grass, the upper parts of stands and trees). Per grid cell it keeps the height range of
 * every collider triangle over the cell and whether any of them is not grass. Every candidate the query picks lies
 * over the point, so its answer is one of those triangles' heights (or between two of them) plus a surface ripple of
 * at most the deepest one in the collider, and its surface is one of those triangles' layers. So a vertex over no
 * triangle, over grass only, or further than the fit window plus that ripple from the cell's height range gets either
 * no ground, grass or a ground out of reach from the query: the fit would leave it as it is.
 *
 * Null for a ground without triangles to bound (flat or analytic): every vertex is then queried.
 */
function roadReach(ground: GroundQuery): ((x: number, y: number, z: number) => boolean) | null {
  if (!(ground instanceof TrackColliderQuery)) return null;
  const { tris, triLayer, layers } = ground.toBuffers();
  const triCount = triLayer.length;
  if (triCount === 0) return null;
  // The deepest ripple any layer can add to a height (TrackColliderQuery.rippleAt / surfaceRippleM)
  let ripple = 0;
  for (const l of layers) {
    if (l.uvScaleM > 0 && l.props.bumpLengthM > 0 && l.props.bumpHeightM > 0) ripple = Math.max(ripple, l.props.bumpHeightM);
  }
  const pad = (t: number) => {
    const o = t * 9;
    const span = Math.max(
      Math.max(tris[o], tris[o + 3], tris[o + 6]) - Math.min(tris[o], tris[o + 3], tris[o + 6]),
      Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) - Math.min(tris[o + 2], tris[o + 5], tris[o + 8])
    );
    return REACH_SLACK_M + 4e-6 * span;
  };
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const p = pad(t);
    minX = Math.min(minX, tris[o] - p, tris[o + 3] - p, tris[o + 6] - p);
    maxX = Math.max(maxX, tris[o] + p, tris[o + 3] + p, tris[o + 6] + p);
    minZ = Math.min(minZ, tris[o + 2] - p, tris[o + 5] - p, tris[o + 8] - p);
    maxZ = Math.max(maxZ, tris[o + 2] + p, tris[o + 5] + p, tris[o + 8] + p);
  }
  const nx = Math.floor((maxX - minX) / REACH_CELL_M) + 1;
  const nz = Math.floor((maxZ - minZ) / REACH_CELL_M) + 1;
  const lo = new Float32Array(nx * nz).fill(Infinity);
  const hi = new Float32Array(nx * nz).fill(-Infinity);
  const notGrass = new Uint8Array(nx * nz);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const p = pad(t);
    const x0 = Math.floor((Math.min(tris[o], tris[o + 3], tris[o + 6]) - p - minX) / REACH_CELL_M);
    const x1 = Math.floor((Math.max(tris[o], tris[o + 3], tris[o + 6]) + p - minX) / REACH_CELL_M);
    const z0 = Math.floor((Math.min(tris[o + 2], tris[o + 5], tris[o + 8]) - p - minZ) / REACH_CELL_M);
    const z1 = Math.floor((Math.max(tris[o + 2], tris[o + 5], tris[o + 8]) + p - minZ) / REACH_CELL_M);
    // Float32 values: the min and max are stored exactly
    const y0 = Math.min(tris[o + 1], tris[o + 4], tris[o + 7]);
    const y1 = Math.max(tris[o + 1], tris[o + 4], tris[o + 7]);
    const road = layers[triLayer[t]].surface !== "grass";
    for (let cz = Math.max(0, z0); cz <= Math.min(nz - 1, z1); cz++) {
      for (let cx = Math.max(0, x0); cx <= Math.min(nx - 1, x1); cx++) {
        const c = cz * nx + cx;
        if (y0 < lo[c]) lo[c] = y0;
        if (y1 > hi[c]) hi[c] = y1;
        if (road) notGrass[c] = 1;
      }
    }
  }
  const reachM = FIT_WINDOW_M + ripple + REACH_SLACK_M;
  return (x, y, z) => {
    const cx = Math.floor((x - minX) / REACH_CELL_M);
    const cz = Math.floor((z - minZ) / REACH_CELL_M);
    if (!(cx >= 0 && cx < nx && cz >= 0 && cz < nz)) return false;
    const c = cz * nx + cx;
    return notGrass[c] === 1 && y > lo[c] - reachM && y < hi[c] + reachM;
  };
}
