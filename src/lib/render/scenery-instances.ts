import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { withBasePath } from "@/lib/base-path";
import { applySceneryDetail, sceneryKind } from "@/lib/render/scenery-detail";

/**
 * Trackside scenery that replaces some of a circuit's own (public/tracks/<id>/scenery/*.glb). Each file's root
 * lists in `extras.replaces` the circuit nodes it stands in for; those are hidden once it is in, so if it fails to
 * load the circuit keeps its own.
 *  - Instanced foliage (scripts/rwanda-scenery.mjs): openly licensed trees and shrubs, one EXT_mesh_gpu_instancing
 *    node per 250 m tile and model. Instances inside a tile are stored in hash order, so drawing the first N of each
 *    tile thins it out evenly: that is how Medium and Low quality draw fewer.
 *  - Generated stands (scripts/rwanda-stands.mjs): plain meshes whose concrete and roof materials carry the circuit's
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

/** The scenery GLB's root, or null when it is missing or fails to load (the circuit's own scenery stays) */
export async function loadSceneryInstances(url: string): Promise<THREE.Object3D | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(withBasePath(url));
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
  scenery.traverse((obj) => {
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
  for (const name of replaces) {
    const node = trackRoot.getObjectByName(name);
    if (node) node.visible = false;
  }
  scenery.name = scenery.name || "Scenery_Instances";
  trackRoot.add(scenery);
}

/**
 * Leaf cards, two fixes in their shader:
 *  - Alpha-tested leaves thin out with distance: each smaller mip level averages the cut-outs' alpha down, until it
 *    falls under the alpha test and the crown disappears. Scaling the alpha up by the mip level the pixel samples
 *    keeps the leaf coverage at a distance (the canopy reads as a canopy from the helicopter camera); close up it is
 *    unchanged.
 *  - The cards' normals are baked towards the crown's outward normal (scripts/rwanda-scenery.mjs), so a card seen
 *    from behind keeps it rather than being flipped to face the camera: the crown shades as one volume.
 *  - Leaves are matte. With the sun low ahead the crowns' upward normals sit at the grazing angle where the standard
 *    Fresnel term climbs to full white: the canopy glinted silver-grey. Their specular is cut to a fifth.
 */
function leafShading(mat: THREE.Material): void {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || !std.map || !(std.alphaTest > 0) || std.userData.leafShading) return;
  std.userData.leafShading = true;
  std.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""))
      .replace(
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\n\tmaterial.specularColor *= 0.2;\n\tmaterial.specularColorBlended *= 0.2;\n\tmaterial.specularF90 *= 0.2;"
      )
      .replace(
        "#include <alphatest_fragment>",
        /* glsl */ `
#ifdef USE_MAP
	vec2 leafTexel = vMapUv * vec2( textureSize( map, 0 ) );
	vec2 leafDx = dFdx( leafTexel );
	vec2 leafDy = dFdy( leafTexel );
	float leafMip = max( 0.0, 0.5 * log2( max( dot( leafDx, leafDx ), dot( leafDy, leafDy ) ) ) );
	diffuseColor.a *= 1.0 + leafMip * 0.6;
#endif
#include <alphatest_fragment>`
      );
  };
  std.customProgramCacheKey = () => "scenery-leaf-v3";
  std.needsUpdate = true;
}

/** Forget scenery from a previous circuit (its meshes are disposed with the scene) */
export function resetSceneryInstances(): void {
  meshes.clear();
}
