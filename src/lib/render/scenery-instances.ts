import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";
import { createGltfLoader } from "@/lib/render/gltf-loader";
import { SHADOW_PROXY_LAYER } from "@/lib/render/layers";
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

let quality: Quality = "high";
const meshes = new Set<THREE.InstancedMesh>();

function applyDensity(mesh: THREE.InstancedMesh): void {
  const full = mesh.userData.sceneryFullCount as number;
  mesh.count = Math.max(1, Math.round(full * DENSITY[quality]));
}

/** Graphics quality: how many of the trees and shrubs to draw (remembered for scenery that loads later) */
export function setSceneryDensity(q: Quality): void {
  quality = q;
  for (const m of meshes) applyDensity(m);
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
    console.warn(`[scenery] ${url} did not load; keeping the circuit's own scenery it replaces:`, err);
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
  for (const levels of tiles.values()) groupTileLevels(levels);
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
    (this as unknown as { _currentLevel: number })._currentLevel = i - 1;
    for (; i < levels.length; i++) levels[i].object.visible = false;
  }
}

/**
 * Puts a tile's levels under a TileLod at the tile's centre (each level offset back, so nothing moves): level 0
 * near, the lighter ones from their `from` distance to the tile's trees, nothing past `until`. Only the levels
 * marked so cast shadows; a level with `shadowFrom` casts through a shadow-only copy of that level's instances.
 * Levels past 0 start hidden, so passes that run before the first frame (the TV cameras' occlusion rays) see the
 * trees once, not once per level.
 */
function groupTileLevels(levels: TileLevel[]): void {
  levels.sort((a, b) => a.extras.level - b.extras.level);
  const first = levels[0].obj;
  const parent = first.parent;
  if (!parent) return;
  const box = new THREE.Box3();
  const part = new THREE.Box3();
  first.traverse((o) => {
    const m = o as THREE.InstancedMesh;
    if (!m.isInstancedMesh) return;
    m.computeBoundingBox();
    box.union(part.copy(m.boundingBox!).applyMatrix4(m.matrixWorld));
  });
  if (box.isEmpty()) return;
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
}
