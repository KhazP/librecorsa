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
/** Decals and grooves laid on the ground away from the asphalt sit this far above it (m) */
const OVERLAY_LIFT_M = 0.002;
/**
 * Within this distance (m, across the ground) of the asphalt's fitted vertices, a vertex of any other layer moves as the
 * asphalt there moved; from here out to `CARRY_FADE_M` it blends into being laid on the ground like the rest
 */
const CARRY_RADIUS_M = 2;
const CARRY_FADE_M = 4;

/** A mesh's material name: three's material, or `userData.materialName` from the Node scripts' GLB reader */
export function materialNameOf(mesh: THREE.Mesh): string {
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return (m?.name || (mesh.userData?.materialName as string | undefined) || "").toString();
}

/**
 * Lays a converted circuit's visual road (`Track_Model`) onto its fitted ground, so the drawn road follows the
 * colliders across crests and compressions and the wheels sit on what the player sees. Grass is left as modelled.
 *
 * With the circuit's road materials (track data `mesh.roadMaterials`), the asphalt is laid on the ground and every
 * other layer around it (lines, markings, decals and grooves, the terrain at its edges) moves as the asphalt next to it
 * moved: the layers keep the gaps and the order the mod gives them. Each laid on the ground at its own vertices, they
 * all came out at one height and fought for depth along the edges in jagged patches, and a decal's large triangles
 * sagged under the finer asphalt between its corners. Away from the asphalt, and on a circuit without road materials,
 * vertices are laid on the ground, decals and grooves just above it.
 *
 * Meshes the converter already laid on the colliders (`keepShape`: a mod's modelled kerbs, moved with the road and
 * driven on as drawn) are left as built. On such a circuit the rest is laid on the ground under a kerb, not on its
 * top, so the road beneath stays beneath it.
 *
 * `everyVertex` asks the ground for every vertex, without `roadReach`'s test first (scripts/verify-fit-visual-road.ts
 * checks that the test changes nothing).
 */
export function fitVisualRoad(
  root: THREE.Object3D,
  ground: GroundQuery,
  roadMaterials?: readonly string[],
  opts: { everyVertex?: boolean } = {}
): void {
  const roadSet = new Set(roadMaterials ?? []);
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
  const reach = opts.everyVertex ? null : roadReach(ground);
  const inv = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const seen = new Set<THREE.BufferGeometry>();
  const layers: { mesh: THREE.Mesh; overlay: boolean; road: boolean }[] = [];
  for (const tm of models) tm.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry || seen.has(o.geometry) || inheritedTag(o, "keepShape", root)) return;
    seen.add(o.geometry);
    if (!o.geometry.getAttribute("position")) return;
    const overlay = !!(inheritedTag(o, "decal", root) || inheritedTag(o, "groove", root));
    layers.push({ mesh: o, overlay, road: !overlay && roadSet.has(materialNameOf(o)) });
  });

  /** Moves a layer's vertices the fit reaches; `place` gives a vertex's new height from its own and its ground's */
  const fit = (layer: (typeof layers)[number], place: (x: number, y: number, z: number, groundY: number) => number) => {
    const o = layer.mesh;
    const pos = o.geometry.getAttribute("position");
    const under = layer.overlay ? null : base;
    inv.copy(o.matrixWorld).invert();
    let dirty = false;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (reach && !reach(v.x, v.y, v.z)) continue;
      const found = under ? under.queryBase(v.x, v.z, v.y + FIT_WINDOW_M, hit) : ground.query(v.x, v.z, v.y + FIT_WINDOW_M, hit);
      if (!found || hit.surface === "grass" || !(Math.abs(v.y - hit.height) < FIT_WINDOW_M)) continue;
      v.y = place(v.x, v.y, v.z, hit.height);
      v.applyMatrix4(inv);
      pos.setXYZ(i, v.x, v.y, v.z);
      dirty = true;
    }
    if (dirty) pos.needsUpdate = true;
  };

  // The asphalt first, on the ground; each move is kept by where it was made
  const moves = new Map<string, number[]>();
  const cellKey = (cx: number, cz: number) => `${cx},${cz}`;
  for (const layer of layers) {
    if (!layer.road) continue;
    fit(layer, (x, y, z, groundY) => {
      const key = cellKey(Math.floor(x / CARRY_FADE_M), Math.floor(z / CARRY_FADE_M));
      let cell = moves.get(key);
      if (!cell) moves.set(key, (cell = []));
      cell.push(x, z, groundY - y);
      return groundY;
    });
  }
  /** The asphalt's move around (x, z), weighted by distance, and how far its nearest fitted vertex is (Infinity: none) */
  const carried = { dy: 0, near: Infinity };
  const carry = (x: number, z: number) => {
    const cx = Math.floor(x / CARRY_FADE_M);
    const cz = Math.floor(z / CARRY_FADE_M);
    let sw = 0;
    let sdy = 0;
    let near = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = moves.get(cellKey(cx + dx, cz + dz));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 3) {
          const d2 = (cell[k] - x) ** 2 + (cell[k + 1] - z) ** 2;
          if (d2 >= CARRY_FADE_M * CARRY_FADE_M) continue;
          const w = 1 / (d2 + 0.01);
          sw += w;
          sdy += w * cell[k + 2];
          near = Math.min(near, d2);
        }
      }
    }
    carried.dy = sw ? sdy / sw : 0;
    carried.near = Math.sqrt(near);
    return carried;
  };
  // Then every other layer: as the asphalt next to it moved, blending into the ground away from it
  for (const layer of layers) {
    if (layer.road) continue;
    const lift = layer.overlay ? OVERLAY_LIFT_M : 0;
    fit(layer, (x, y, z, groundY) => {
      const { dy, near } = carry(x, z);
      const laid = groundY + lift;
      if (near >= CARRY_FADE_M) return laid;
      if (near <= CARRY_RADIUS_M) return y + dy;
      const t = (near - CARRY_RADIUS_M) / (CARRY_FADE_M - CARRY_RADIUS_M);
      const w = t * t * (3 - 2 * t);
      return y + dy + (laid - (y + dy)) * w;
    });
  }
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
