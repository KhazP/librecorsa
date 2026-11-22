import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";
import { createGltfLoader } from "@/lib/render/gltf-loader";
import { DETAIL_LAYER, SHADOW_PROXY_LAYER } from "@/lib/render/layers";
import { applySceneryDetail, sceneryKind } from "@/lib/render/scenery-detail";
import { leafShading } from "./leaf-shading";

/**
 * Trackside scenery that replaces some of a circuit's own (public/tracks/<id>/scenery/*.glb). Each file's root
 * lists in `extras.replaces` the circuit nodes it stands in for; those are hidden once it is in, so if it fails to
 * load the circuit keeps its own.
 *  - Instanced foliage (scripts/rwanda-official/foliage.mjs): openly licensed trees and shrubs, one EXT_mesh_gpu_instancing
 *    node per 250 m tile, model and level of detail. Each tile's levels go under a THREE.LOD at the tile's centre,
 *    which the renderer switches per camera (main view and mirrors; the shadow pass reuses the main view's pick).
 *    Instances inside a tile are stored in hash order, so drawing the first N of each tile thins it out evenly: that
 *    is how Medium and Low quality draw fewer.
 *  - Generated stands: plain meshes whose concrete and roof materials carry the circuit's
 *    flat scenery names, so they get the same surface detail as its own buildings (scenery-detail.ts).
 */

type Quality = "low" | "medium" | "high";

/** Share of each tile drawn per graphics quality */
const DENSITY: Record<Quality, number> = { high: 1, medium: 0.8, low: 0.5 };

/** Far-level tiles at or beyond this distance sit outside probe (350 m) and mirrors (250-300 m), so they stay on DETAIL_LAYER */
const VIEW_ONLY_FAR_M = 360;
/** Minimum tiles sharing a far-level (geometry, material) before pooling them into one InstancedMesh */
const MIN_BATCH_TILES = 4;
/** Split large pooled buckets into 2x2 spatial quadrants so off-screen halves frustum-cull with tight bounds */
const QUADRANT_SPLIT_TILES = 16;

const MAIN_CAMERA_LAYERS = new THREE.Layers();
MAIN_CAMERA_LAYERS.set(DETAIL_LAYER);

let quality: Quality = "high";
const meshes = new Set<THREE.InstancedMesh>();
const farBatches = new Set<FarTileBatch>();

function applyDensity(mesh: THREE.InstancedMesh): void {
  const full = mesh.userData.sceneryFullCount as number;
  mesh.count = Math.max(1, Math.round(full * DENSITY[quality]));
}

/** Graphics quality: how many of the trees and shrubs to draw (remembered for scenery that loads later) */
export function setSceneryDensity(q: Quality): void {
  quality = q;
  for (const m of meshes) applyDensity(m);
  for (const b of farBatches) b.dirty = true;
}

/**
 * The scenery GLB's root, or null when it is missing or fails to load (the circuit's own scenery stays). The deploy
 * meshopt-compresses the props and stands (scripts/compress-track-glb.mjs), so the loader takes both kinds.
 */
export async function loadSceneryInstances(url: string): Promise<THREE.Object3D | null> {
  try {
    const gltf = await createGltfLoader().loadAsync(withBasePath(url));
    return gltf.scene;
  } catch (err) {
    console.warn("[scenery] %s did not load; keeping the circuit's own scenery it replaces:", url, err);
    return null;
  }
}

/**
 * Adds the scenery under the circuit's root and hides what it replaces. Shadows and culling are set per tile:
 * each tile's bounding sphere covers only its own instances, so tiles out of view (or out of the sun's shadow
 * cascades) are skipped. Plain meshes get one copy of each flat scenery material, patched with their own foot
 * height (the stands stand between 20 and 90 m up the hill).
 */
export function attachSceneryInstances(trackRoot: THREE.Object3D, scenery: THREE.Object3D): void {
  let replaces: string[] = [];
  scenery.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tiles = new Map<string, TileLevel[]>();
  scenery.traverse((obj) => {
    const lod = obj.userData as Partial<TileLevel["extras"]>;
    if (typeof lod.tile === "string" && typeof lod.level === "number") {
      if (!tiles.has(lod.tile)) tiles.set(lod.tile, []);
      tiles.get(lod.tile)!.push({ obj, extras: lod as TileLevel["extras"] });
    }
    const r = obj.userData?.replaces;
    if (Array.isArray(r)) replaces = r.filter((x): x is string => typeof x === "string");
    const mesh = obj as THREE.InstancedMesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mesh.isInstancedMesh) {
      const baseY = box.setFromObject(mesh).min.y;
      const detail = (mat: THREE.Material) => {
        if (!sceneryKind(mat)) return mat;
        const own = mat.clone();
        applySceneryDetail(own, { baseY });
        return own;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(detail) : detail(mesh.material);
      return;
    }
    mesh.frustumCulled = true;
    mesh.userData.sceneryFullCount = mesh.count;
    mesh.computeBoundingSphere();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Leaf cards are alpha-tested and seen from both sides
      mat.side = THREE.DoubleSide;
      leafShading(mat);
    }
    meshes.add(mesh);
    applyDensity(mesh);
  });
  const tileLods: { lod: TileLod; levels: TileLevel[] }[] = [];
  for (const levels of tiles.values()) {
    const lod = groupTileLevels(levels);
    if (lod) tileLods.push({ lod, levels });
  }
  poolFarTileLevels(scenery, tileLods);
  for (const name of replaces) {
    const node = trackRoot.getObjectByName(name);
    if (node) node.visible = false;
  }
  scenery.name = scenery.name || "Scenery_Instances";
  trackRoot.add(scenery);
}

/** One level of a foliage tile, with its node extras from scripts/rwanda-official/foliage.mjs */
interface TileLevel {
  obj: THREE.Object3D;
  extras: { tile: string; level: number; from: number; until?: number; shadow: boolean; shadowFrom?: number };
}

/** One tile's slice inside a pooled far-level InstancedMesh (instances stay in hash order for even density thinning) */
interface FarBatchSlot {
  batch: FarTileBatch;
  fullCount: number;
  matrices: Float32Array;
  colors: Float32Array | null;
  active: boolean;
}

/**
 * Pools one non-shadow far LOD level shared across many foliage tiles (e.g. RISE's 175 Acacia_LOD3 tiles -> 2 draws,
 * 143 Shrub_LOD1 tiles -> 1 draw) into a single InstancedMesh repacked only when a tile crosses its LOD boundary or
 * graphics density changes. Starts at `count = 0` so pre-frame TV occlusion rays (`SegmentOccluder`) never double-count it.
 */
class FarTileBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly slots: FarBatchSlot[] = [];
  dirty = false;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    hasColors: boolean,
    viewOnly: boolean,
    name: string
  ) {
    const pool = new THREE.InstancedMesh(geometry, material, capacity);
    pool.name = name;
    pool.castShadow = false;
    pool.receiveShadow = true;
    pool.frustumCulled = true;
    pool.count = 0;
    pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (hasColors) {
      pool.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      pool.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    if (viewOnly) pool.layers.set(DETAIL_LAYER);
    pool.onBeforeRender = () => this.sync();
    this.mesh = pool;
  }

  sync(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const matDst = this.mesh.instanceMatrix.array as Float32Array;
    const colDst = this.mesh.instanceColor ? (this.mesh.instanceColor.array as Float32Array) : null;
    const density = DENSITY[quality];
    let written = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const keep = Math.max(1, Math.round(slot.fullCount * density));
      matDst.set(slot.matrices.subarray(0, keep * 16), written * 16);
      if (colDst) {
        if (slot.colors) {
          colDst.set(slot.colors.subarray(0, keep * 3), written * 3);
        } else {
          colDst.fill(1, written * 3, (written + keep) * 3);
        }
      }
      written += keep;
    }
    this.mesh.count = written;
    if (written > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, written * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) {
        this.mesh.instanceColor.clearUpdateRanges();
        this.mesh.instanceColor.addUpdateRange(0, written * 3);
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }
}

/** Hysteresis on the switch distances, so a camera near one doesn't flicker between levels */
const LOD_HYSTERESIS = 0.08;

const _camPos = new THREE.Vector3();

/**
 * A THREE.LOD that measures from the camera to the nearest point of its tile's trees (their box), not to the tile's
 * centre: in a 250 m tile a tree can stand 177 m from the centre, which would keep full detail far out to be sure
 * of it close in. The level pick is THREE.LOD's own, with its hysteresis.
 */
class TileLod extends THREE.LOD {
  readonly box = new THREE.Box3();
  /** Index of the pooled far level inside `this.levels` (-1 when this tile isn't pooled) */
  farLevelIndex = -1;
  farSlots: FarBatchSlot[] = [];
  private farActive = false;

  override update(camera: THREE.Camera): void {
    const levels = this.levels;
    if (levels.length <= 1) return;
    _camPos.setFromMatrixPosition(camera.matrixWorld);
    const distance = this.box.distanceToPoint(_camPos) / ((camera as THREE.PerspectiveCamera).zoom ?? 1);
    levels[0].object.visible = true;
    let i = 1;
    for (; i < levels.length; i++) {
      let levelDistance = levels[i].distance;
      if (levels[i].object.visible) levelDistance -= levelDistance * levels[i].hysteresis;
      if (distance < levelDistance) break;
      levels[i - 1].object.visible = false;
      levels[i].object.visible = true;
    }
    const picked = i - 1;
    (this as unknown as { _currentLevel: number })._currentLevel = picked;
    for (; i < levels.length; i++) levels[i].object.visible = false;

    if (this.farLevelIndex >= 0 && camera.layers.test(MAIN_CAMERA_LAYERS)) {
      const nextFar = picked === this.farLevelIndex;
      if (nextFar !== this.farActive) {
        this.farActive = nextFar;
        for (const slot of this.farSlots) {
          slot.active = nextFar;
          slot.batch.dirty = true;
        }
      }
    }
  }
}

/**
 * Puts a tile's levels under a TileLod at the tile's centre (each level offset back, so nothing moves): level 0
 * near, the lighter ones from their `from` distance to the tile's trees, nothing past `until`. Only the levels
 * marked so cast shadows; a level with `shadowFrom` casts through a shadow-only copy of that level's instances.
 * Levels past 0 start hidden, so passes that run before the first frame (the TV cameras' occlusion rays) see the
 * trees once, not once per level.
 */
function groupTileLevels(levels: TileLevel[]): TileLod | null {
  levels.sort((a, b) => a.extras.level - b.extras.level);
  const first = levels[0].obj;
  const parent = first.parent;
  if (!parent) return null;
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  first.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    m.computeBoundingBox();
    box.union(part.copy(m.boundingBox!).applyMatrix4(m.matrixWorld));
  });
  if (box.isEmpty()) return null;
  const centre = box.getCenter(new THREE.Vector3());
  const lod = new TileLod();
  lod.box.copy(box);
  lod.name = `Scenery_Tile_${levels[0].extras.tile}`;
  lod.position.copy(centre);
  parent.add(lod);
  for (const { obj, extras } of levels) {
    obj.position.sub(centre);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = extras.shadow !== false;
    });
    if (extras.level > 0) obj.visible = false;
    lod.addLevel(obj, extras.from, LOD_HYSTERESIS);
  }
  for (const { obj, extras } of levels) {
    const source = extras.shadowFrom === undefined ? undefined : levels.find((l) => l.extras.level === extras.shadowFrom);
    if (source) addShadowProxies(obj, source.obj);
  }
  const last = levels[levels.length - 1].extras;
  if (typeof last.until === "number") lod.addLevel(new THREE.Object3D(), last.until, LOD_HYSTERESIS);
  lod.updateMatrixWorld(true);
  return lod;
}

const _invScenery = new THREE.Matrix4();
const _toScenery = new THREE.Matrix4();
const _instMat = new THREE.Matrix4();
const _worldMat = new THREE.Matrix4();
const _instBox = new THREE.Box3();
const _tileCentre = new THREE.Vector3();

/**
 * Zero-geometry LOD node inserted right after all TileLods and right before the pooled FarTileBatch meshes under
 * `scenery`. Three.js calls `LOD.update(camera)` in child order during `projectObject`, before `objects.update(mesh)`
 * uploads `instanceMatrix` / `instanceColor` — so dirty batches repack and upload in the same frame instead of one
 * pass late.
 */
class FarBatchSyncLod extends THREE.LOD {
  constructor(private readonly batches: FarTileBatch[]) {
    super();
    this.name = "Scenery_FarBatchSync";
    this.frustumCulled = false;
  }

  override update(camera: THREE.Camera): void {
    if (!camera.layers.test(MAIN_CAMERA_LAYERS)) return;
    for (const batch of this.batches) batch.sync();
  }
}

/**
 * Collapses non-shadow far-most foliage levels shared across tiles into pooled InstancedMeshes per (geometry, material)
 * pair (split into 2x2 spatial quadrants when >= 16 tiles so behind-camera halves frustum-cull cleanly). Each pooled tile
 * keeps an empty placeholder in its TileLod so LOD switching and hysteresis work identically.
 */
function poolFarTileLevels(scenery: THREE.Object3D, tileLods: { lod: TileLod; levels: TileLevel[] }[]): void {
  scenery.updateMatrixWorld(true);
  _invScenery.copy(scenery.matrixWorld).invert();
  const createdBatches: FarTileBatch[] = [];

  interface Candidate {
    lod: TileLod;
    levelIndex: number;
    mesh: THREE.InstancedMesh;
    from: number;
    cx: number;
    cz: number;
  }
  const buckets = new Map<string, Candidate[]>();

  for (const { lod, levels } of tileLods) {
    if (levels.length < 2) continue;
    const farIndex = levels.length - 1;
    const far = levels[farIndex];
    if (far.extras.shadow !== false || far.extras.shadowFrom !== undefined) continue;
    const insts: THREE.InstancedMesh[] = [];
    let eligible = true;
    far.obj.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (!m.isMesh) return;
      if (!m.isInstancedMesh || Array.isArray(m.material)) {
        eligible = false;
        return;
      }
      insts.push(m);
    });
    if (!eligible || insts.length === 0) continue;
    lod.box.getCenter(_tileCentre);
    const viewOnly = far.extras.from >= VIEW_ONLY_FAR_M;
    for (const m of insts) {
      const mat = m.material as THREE.Material;
      const key = `${m.geometry.uuid}|${mat.uuid}|${viewOnly ? 1 : 0}`;
      let list = buckets.get(key);
      if (!list) {
        list = [];
        buckets.set(key, list);
      }
      list.push({ lod, levelIndex: farIndex, mesh: m, from: far.extras.from, cx: _tileCentre.x, cz: _tileCentre.z });
    }
  }

  for (const fullList of buckets.values()) {
    if (fullList.length < MIN_BATCH_TILES) continue;

    // Split large tile sets into 2x2 quadrants around their midpoint so off-screen halves frustum-cull with tight bounds
    let groups: Candidate[][];
    if (fullList.length >= QUADRANT_SPLIT_TILES) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const c of fullList) {
        if (c.cx < minX) minX = c.cx;
        if (c.cx > maxX) maxX = c.cx;
        if (c.cz < minZ) minZ = c.cz;
        if (c.cz > maxZ) maxZ = c.cz;
      }
      const midX = 0.5 * (minX + maxX);
      const midZ = 0.5 * (minZ + maxZ);
      const quads: Candidate[][] = [[], [], [], []];
      for (const c of fullList) {
        const q = (c.cx >= midX ? 1 : 0) | (c.cz >= midZ ? 2 : 0);
        quads[q].push(c);
      }
      groups = quads.filter((g) => g.length > 0);
    } else {
      groups = [fullList];
    }

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const list = groups[gIdx];
      const sample = list[0].mesh;
      const viewOnly = list.every((c) => c.from >= VIEW_ONLY_FAR_M);
      let capacity = 0;
      let hasColors = false;
      for (const c of list) {
        capacity += (c.mesh.userData.sceneryFullCount as number) || c.mesh.count;
        if (c.mesh.instanceColor) hasColors = true;
      }
      if (capacity === 0) continue;

      if (!sample.geometry.boundingBox) sample.geometry.computeBoundingBox();
      const geomBox = sample.geometry.boundingBox;
      const batchBox = new THREE.Box3();
      const suffix = groups.length > 1 ? `_FarBatch_Q${gIdx}` : "_FarBatch";
      const batch = new FarTileBatch(
        sample.geometry,
        sample.material as THREE.Material,
        capacity,
        hasColors,
        viewOnly,
        `${sample.name || "Scenery"}${suffix}`
      );

      for (const c of list) {
        const m = c.mesh;
        const fullCount = (m.userData.sceneryFullCount as number) || m.count;
        _toScenery.multiplyMatrices(_invScenery, m.matrixWorld);
        const matrices = new Float32Array(fullCount * 16);
        for (let i = 0; i < fullCount; i++) {
          m.getMatrixAt(i, _instMat);
          _worldMat.multiplyMatrices(_toScenery, _instMat);
          _worldMat.toArray(matrices, i * 16);
          if (geomBox) batchBox.union(_instBox.copy(geomBox).applyMatrix4(_worldMat));
        }
        let colors: Float32Array | null = null;
        if (m.instanceColor) {
          colors = new Float32Array(fullCount * 3);
          const src = m.instanceColor.array as Float32Array;
          colors.set(src.subarray(0, fullCount * 3));
        }
        const slot: FarBatchSlot = { batch, fullCount, matrices, colors, active: false };
        batch.slots.push(slot);
        c.lod.farLevelIndex = c.levelIndex;
        c.lod.farSlots.push(slot);

        // Replace the individual tile mesh with nothing (if it was the level root itself, swap in an empty Object3D)
        meshes.delete(m);
        if (c.lod.levels[c.levelIndex].object === m) {
          const stub = new THREE.Object3D();
          stub.name = `${m.name}_Pooled`;
          stub.visible = false;
          c.lod.add(stub);
          c.lod.levels[c.levelIndex].object = stub;
        }
        m.removeFromParent();
      }

      if (!batchBox.isEmpty()) {
        batch.mesh.boundingBox = batchBox;
        batch.mesh.boundingSphere = batchBox.getBoundingSphere(new THREE.Sphere());
      } else {
        batch.mesh.frustumCulled = false;
      }

      farBatches.add(batch);
      createdBatches.push(batch);
    }
  }
  if (createdBatches.length > 0) {
    // Insert sync node before the batch meshes so projectObject flushes dirty batches before Three uploads their buffers
    scenery.add(new FarBatchSyncLod(createdBatches));
    for (const batch of createdBatches) scenery.add(batch.mesh);
  }
}

/**
 * Shadow-only copies of `source`'s instanced meshes, under `level` (so they show with it): same instances and
 * materials, on the layer only the sun's shadow camera draws.
 */
function addShadowProxies(level: THREE.Object3D, source: THREE.Object3D): void {
  const proxies: THREE.InstancedMesh[] = [];
  source.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    const proxy = new THREE.InstancedMesh(m.geometry, m.material, m.instanceMatrix.count);
    proxy.name = `${m.name}_ShadowProxy`;
    proxy.instanceMatrix = m.instanceMatrix;
    // Levels share one offset under their LOD: a mesh that is the level itself needs none of its own
    if (m !== source) {
      proxy.position.copy(m.position);
      proxy.quaternion.copy(m.quaternion);
      proxy.scale.copy(m.scale);
    }
    proxy.layers.set(SHADOW_PROXY_LAYER);
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.frustumCulled = true;
    proxy.userData.sceneryFullCount = m.userData.sceneryFullCount;
    proxy.computeBoundingSphere();
    meshes.add(proxy);
    applyDensity(proxy);
    proxies.push(proxy);
  });
  for (const p of proxies) level.add(p);
}

/** Forget scenery from a previous circuit (its meshes are disposed with the scene) */
export function resetSceneryInstances(): void {
  meshes.clear();
  farBatches.clear();
}
