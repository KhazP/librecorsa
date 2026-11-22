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
/**
 * An asphalt vertex carries its move only to a vertex within the fit window of its own height, plus this much per metre
 * across the ground for the road's slope: where a road passes over another (a bridge, a crossover, a pit lane under the
 * track), each level's layers move with their own asphalt, not a mix of both
 */
const CARRY_SLOPE = 0.5;
/**
 * Paint on the asphalt (a layer whose material has `depthOffset` in its glTF extras: a converted circuit's kerbs and
 * lines, scene-builder.ts) over an asphalt triangle with an edge longer than this (m, across the ground), within
 * `SURFACE_CARRY_GAP_M` of it, moves as the triangle moved under it, not as the asphalt's nearest corners did: on asphalt
 * modelled in triangles tens of metres long (Qiddiya's) the corners are far apart, and between them the flat triangle and
 * the kerbs on it parted by up to 3 cm and the asphalt buried the kerbs. Every other layer is carried as before.
 */
const SURFACE_CARRY_EDGE_M = 4;
const SURFACE_CARRY_GAP_M = 0.1;

/**
 * A mesh with at least this share of its vertices laid on the ground, or in a road material with ground under at least
 * `ROAD_GROUND_SHARE` of them, lies on it (its asphalt, lines and markings) when none of its laid vertices ends up more
 * than `ON_GROUND_HEIGHT_M` over the ground and nothing on it stands up: tagged `userData.onGround`, it casts no
 * shadow (scene-builder.ts), as a mod draws it. Anything standing up keeps its shadow: a curb, a wall, a sign post or
 * a stand (a steep face more than `ON_GROUND_HEIGHT_M` tall, over the ground by as much or with no ground under it),
 * and a deck with room under it (a face held more than `DECK_HEIGHT_M` over the ground at each corner), also when it
 * is merged with flat road or built in a road material. A flat road the fit cannot reach in places (over a dip, over
 * grass) still lies on the ground: with nothing standing up, its shadow would only fall on itself and the layers
 * beside it, in jagged teeth. Where the colliders don't reach (a layout's colliders cover its own roads only), there is
 * nothing to tell a road from a deck by, and a mesh mostly out there keeps its shadow
 */
const ON_GROUND_SHARE = 0.9;
const ROAD_GROUND_SHARE = 0.5;
const ON_GROUND_HEIGHT_M = 0.08;
/** A triangle whose normal points up less than this (steeper than 60°) stands up: a wall, a post, a curb's face */
const STANDING_NORMAL_Y = 0.5;
/** A face this far over the ground at each of its corners is a deck (a bridge, a walkway): there is room under it */
const DECK_HEIGHT_M = 2;

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
 * moved: the layers keep the gaps and the order the mod gives them. Paint (`depthOffset` materials) over a large asphalt
 * triangle moves as the triangle under it moved (`SURFACE_CARRY_EDGE_M`). Each laid on the ground at its own vertices, they
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
  const layers: { mesh: THREE.Mesh; overlay: boolean; road: boolean; paint: boolean }[] = [];
  for (const tm of models) tm.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry || seen.has(o.geometry) || inheritedTag(o, "keepShape", root)) return;
    seen.add(o.geometry);
    if (!o.geometry.getAttribute("position")) return;
    const overlay = !!(inheritedTag(o, "decal", root) || inheritedTag(o, "groove", root));
    const paint = (Array.isArray(o.material) ? o.material : [o.material]).some((m) => typeof m?.userData?.depthOffset === "number");
    layers.push({ mesh: o, overlay, road: !overlay && roadSet.has(materialNameOf(o)), paint });
  });

  /** Moves a layer's vertices the fit reaches; `place` gives a vertex's new height from its own and its ground's */
  const fit = (layer: (typeof layers)[number], place: (x: number, y: number, z: number, groundY: number) => number) => {
    const o = layer.mesh;
    const pos = o.geometry.getAttribute("position");
    const under = layer.overlay ? null : base;
    inv.copy(o.matrixWorld).invert();
    if (heights.length < pos.count) heights = new Float32Array(pos.count);
    heights.fill(NaN, 0, pos.count);
    let fitted = 0;
    let highest = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (reach && !reach(v.x, v.y, v.z)) continue;
      const found = under ? under.queryBase(v.x, v.z, v.y + FIT_WINDOW_M, hit) : ground.query(v.x, v.z, v.y + FIT_WINDOW_M, hit);
      if (!found || hit.surface === "grass" || !(Math.abs(v.y - hit.height) < FIT_WINDOW_M)) continue;
      v.y = place(v.x, v.y, v.z, hit.height);
      heights[i] = v.y - hit.height;
      highest = Math.max(highest, heights[i]);
      v.applyMatrix4(inv);
      pos.setXYZ(i, v.x, v.y, v.z);
      fitted++;
    }
    if (fitted) pos.needsUpdate = true;
    if (highest > ON_GROUND_HEIGHT_M) return;
    const laid = fitted >= ON_GROUND_SHARE * pos.count;
    if (!(laid || layer.road) || standsUp(o, under)) return;
    if (laid || groundUnderMost(o, under)) o.userData.onGround = true;
  };

  /**
   * Each vertex's height over the ground below it, as fitted, of the layer `fit` last moved (NaN: not asked yet;
   * Infinity: no ground under it)
   */
  let heights = new Float32Array(0);
  const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const cornerAt = [0, 0, 0];
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const heightOf = (i: number, p: THREE.Vector3, under: TrackColliderQuery | null): number => {
    if (Number.isNaN(heights[i])) {
      const found = under ? under.queryBase(p.x, p.z, p.y + FIT_WINDOW_M, hit) : ground.query(p.x, p.z, p.y + FIT_WINDOW_M, hit);
      heights[i] = found ? p.y - hit.height : Infinity;
    }
    return heights[i];
  };
  /** Whether at least `ROAD_GROUND_SHARE` of the mesh's vertices have ground under them */
  const groundUnderMost = (o: THREE.Mesh, under: TrackColliderQuery | null): boolean => {
    const pos = o.geometry.getAttribute("position");
    const need = ROAD_GROUND_SHARE * pos.count;
    let found = 0;
    let missing = 0;
    for (let i = 0; i < pos.count; i++) {
      if (heightOf(i, corners[0].fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld), under) !== Infinity) {
        if (++found >= need) return true;
      } else if (++missing > pos.count - need) {
        return false;
      }
    }
    return found >= need;
  };
  /** Whether anything on the mesh, as fitted, stands up: a steep face or a deck (see `ON_GROUND_SHARE`) */
  const standsUp = (o: THREE.Mesh, under: TrackColliderQuery | null): boolean => {
    const pos = o.geometry.getAttribute("position");
    const index = o.geometry.index;
    const count = index ? index.count : pos.count;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < 3; k++) {
        cornerAt[k] = index ? index.getX(t + k) : t + k;
        corners[k].fromBufferAttribute(pos, cornerAt[k]).applyMatrix4(o.matrixWorld);
      }
      e1.subVectors(corners[1], corners[0]);
      e2.subVectors(corners[2], corners[0]);
      e1.cross(e2);
      const len = e1.length();
      if (!(len > 0)) continue;
      if (Math.abs(e1.y) < STANDING_NORMAL_Y * len) {
        // A steep face standing up by its own height, with a corner that far over the ground or no ground under it
        const tall = Math.max(corners[0].y, corners[1].y, corners[2].y) - Math.min(corners[0].y, corners[1].y, corners[2].y);
        if (!(tall > ON_GROUND_HEIGHT_M)) continue;
        for (let k = 0; k < 3; k++) {
          if (heightOf(cornerAt[k], corners[k], under) > ON_GROUND_HEIGHT_M) return true;
        }
      } else {
        // A deck: every corner held high over the ground
        let k = 0;
        while (k < 3) {
          const h = heightOf(cornerAt[k], corners[k], under);
          if (!(h > DECK_HEIGHT_M && h !== Infinity)) break;
          k++;
        }
        if (k === 3) return true;
      }
    }
    return false;
  };

  // The asphalt first, on the ground; each move is kept by where it was made (x, its height before, z)
  const moves = new Map<string, number[]>();
  const cellKey = (cx: number, cz: number) => `${cx},${cz}`;
  const surface = layers.some((l) => l.paint) ? new SurfaceMoves() : null;
  for (const layer of layers) {
    if (!layer.road) continue;
    const before = surface ? worldPositions(layer.mesh) : null;
    fit(layer, (x, y, z, groundY) => {
      const key = cellKey(Math.floor(x / CARRY_FADE_M), Math.floor(z / CARRY_FADE_M));
      let cell = moves.get(key);
      if (!cell) moves.set(key, (cell = []));
      cell.push(x, y, z, groundY - y);
      return groundY;
    });
    if (surface && before) surface.add(layer.mesh, before, worldPositions(layer.mesh));
  }
  /**
   * The move of the asphalt around (x, y, z) on the same level, weighted by distance, and how far its nearest fitted
   * vertex is (Infinity: none)
   */
  const carried = { dy: 0, near: Infinity };
  const carry = (x: number, y: number, z: number) => {
    const cx = Math.floor(x / CARRY_FADE_M);
    const cz = Math.floor(z / CARRY_FADE_M);
    let sw = 0;
    let sdy = 0;
    let near = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = moves.get(cellKey(cx + dx, cz + dz));
        if (!cell) continue;
        for (let k = 0; k < cell.length; k += 4) {
          const d2 = (cell[k] - x) ** 2 + (cell[k + 2] - z) ** 2;
          if (d2 >= CARRY_FADE_M * CARRY_FADE_M) continue;
          if (Math.abs(cell[k + 1] - y) > FIT_WINDOW_M + CARRY_SLOPE * Math.sqrt(d2)) continue;
          const w = 1 / (d2 + 0.01);
          sw += w;
          sdy += w * cell[k + 3];
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
      const under = layer.paint && surface ? surface.moveAt(x, y, z) : null;
      if (under !== null) return y + under;
      const { dy, near } = carry(x, y, z);
      const laid = groundY + lift;
      if (near >= CARRY_FADE_M) return laid;
      if (near <= CARRY_RADIUS_M) return y + dy;
      const t = (near - CARRY_RADIUS_M) / (CARRY_FADE_M - CARRY_RADIUS_M);
      const w = t * t * (3 - 2 * t);
      return y + dy + (laid - (y + dy)) * w;
    });
  }
}

/** A mesh's vertex positions in world space */
function worldPositions(mesh: THREE.Mesh): Float32Array {
  const pos = mesh.geometry.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

/** Cell size of `SurfaceMoves`' grid (m) */
const SURFACE_CELL_M = 4;

/**
 * The asphalt's large triangles (an edge over `SURFACE_CARRY_EDGE_M`) as they lay before the fit, with each corner's
 * move, in a grid over the ground: how the asphalt surface moved at a point over one of them
 */
class SurfaceMoves {
  /** Per triangle: x, y, z of its 3 corners before the fit, then the 3 corners' moves (12 numbers) */
  private readonly tris: number[] = [];
  private readonly cells = new Map<string, number[]>();

  add(mesh: THREE.Mesh, before: Float32Array, after: Float32Array): void {
    const index = mesh.geometry.index;
    const count = index ? index.count : before.length / 3;
    for (let t = 0; t + 2 < count; t += 3) {
      const a = index ? index.getX(t) : t;
      const b = index ? index.getX(t + 1) : t + 1;
      const c = index ? index.getX(t + 2) : t + 2;
      const corners = [a, b, c];
      let longest = 0;
      for (let k = 0; k < 3; k++) {
        const i = corners[k] * 3;
        const j = corners[(k + 1) % 3] * 3;
        longest = Math.max(longest, Math.hypot(before[i] - before[j], before[i + 2] - before[j + 2]));
      }
      if (!(longest > SURFACE_CARRY_EDGE_M)) continue;
      const id = this.tris.length / 12;
      for (const i of corners) this.tris.push(before[i * 3], before[i * 3 + 1], before[i * 3 + 2]);
      for (const i of corners) this.tris.push(after[i * 3 + 1] - before[i * 3 + 1]);
      const xs = corners.map((i) => before[i * 3]);
      const zs = corners.map((i) => before[i * 3 + 2]);
      const x0 = Math.floor(Math.min(...xs) / SURFACE_CELL_M);
      const x1 = Math.floor(Math.max(...xs) / SURFACE_CELL_M);
      const z0 = Math.floor(Math.min(...zs) / SURFACE_CELL_M);
      const z1 = Math.floor(Math.max(...zs) / SURFACE_CELL_M);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const key = `${cx},${cz}`;
          let cell = this.cells.get(key);
          if (!cell) this.cells.set(key, (cell = []));
          cell.push(id);
        }
      }
    }
  }

  /** The move of the large asphalt triangle lying within `SURFACE_CARRY_GAP_M` of (x, y, z), nearest first; null: none */
  moveAt(x: number, y: number, z: number): number | null {
    const cell = this.cells.get(`${Math.floor(x / SURFACE_CELL_M)},${Math.floor(z / SURFACE_CELL_M)}`);
    if (!cell) return null;
    const T = this.tris;
    let best: number | null = null;
    let bestGap = SURFACE_CARRY_GAP_M;
    for (const id of cell) {
      const o = id * 12;
      const v0x = T[o + 3] - T[o];
      const v0z = T[o + 5] - T[o + 2];
      const v1x = T[o + 6] - T[o];
      const v1z = T[o + 8] - T[o + 2];
      const den = v0x * v1z - v1x * v0z;
      if (Math.abs(den) < 1e-12) continue;
      const px = x - T[o];
      const pz = z - T[o + 2];
      const u = (px * v1z - v1x * pz) / den;
      const w = (v0x * pz - px * v0z) / den;
      if (u < -1e-6 || w < -1e-6 || u + w > 1 + 1e-6) continue;
      const ty = T[o + 1] + u * (T[o + 4] - T[o + 1]) + w * (T[o + 7] - T[o + 1]);
      const gap = Math.abs(y - ty);
      if (!(gap < bestGap)) continue;
      bestGap = gap;
      best = T[o + 9] + u * (T[o + 10] - T[o + 9]) + w * (T[o + 11] - T[o + 9]);
    }
    return best;
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
