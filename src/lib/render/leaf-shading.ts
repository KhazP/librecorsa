import * as THREE from "three";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { Fn, dFdx, dFdy, dot, faceDirection, float, log2, max, normalView, texture, uv, vec2 } from "three/tsl";
import { patchShader } from "./shader-patch";
import { isWebGPUMode } from "./webgpu-renderer";

/**
 * Leaf cards (Rwanda's instanced foliage, scenery-instances.ts, and the converted circuits' alpha-tested
 * double-sided cards, scan-materials.ts), three fixes in their shader:
 *  - Alpha-tested leaves thin out with distance: each smaller mip level averages the cut-outs' alpha down, until it
 *    falls under the alpha test and the crown disappears. Scaling the alpha up by the mip level the pixel samples
 *    keeps the leaf coverage at a distance (the canopy reads as a canopy from the helicopter camera); close up it is
 *    unchanged.
 *  - A card seen from behind keeps its own normal rather than having it flipped to face the camera, so the crown
 *    shades as one volume. Rwanda's cards are baked towards the crown's outward normal (scripts/rwanda-official/
 *    foliage.mjs); the converted circuits' trees carry upward normals on upright crossed cards, and many draw each
 *    card twice, back to back. Flipped, every card was lit on one side and dark on the other, and the two copies of a
 *    card fought over the depth buffer in light and dark blocks that changed with the smallest camera move.
 *  - Leaves are matte. With the sun low ahead the crowns' upward normals sit at the grazing angle where the standard
 *    Fresnel term climbs to full white: the canopy glinted silver-grey. Their specular is cut to a fifth.
 */
const leafNodeCache = new WeakMap<THREE.Material, MeshPhysicalNodeMaterial>();

export function leafShading(mat: THREE.Material): THREE.Material {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || !std.map || !(std.alphaTest > 0)) return mat;
  const cached = leafNodeCache.get(mat);
  if (cached) return cached;
  if (std.userData.leafShading) return mat;
  std.userData.leafShading = true;
  if (isWebGPUMode()) {
    const out = new MeshPhysicalNodeMaterial();
    out.name = std.name;
    out.color.copy(std.color);
    out.map = std.map;
    out.normalMap = std.normalMap;
    out.alphaTest = std.alphaTest;
    out.transparent = std.transparent;
    out.opacity = std.opacity;
    out.depthWrite = std.depthWrite;
    out.side = std.side;
    out.roughness = Math.max(std.roughness, 0.96);
    out.metalness = 0;
    out.specularIntensity = 0.2;
    out.envMapIntensity = 0.35;
    out.vertexColors = std.vertexColors;
    out.userData = { ...std.userData };
    // Cancel DoubleSide faceDirection flip so crossed leaf cards keep their original normal.
    out.normalNode = normalView.mul(faceDirection);
    const leafMap = std.map;
    const img = leafMap.image as { width?: number; height?: number } | undefined;
    const texW = img?.width && img.width > 0 ? img.width : 512;
    const texH = img?.height && img.height > 0 ? img.height : 512;
    out.opacityNode = Fn(() => {
      const texUv = uv();
      const texel = texUv.mul(vec2(texW, texH));
      const dx = dFdx(texel);
      const dy = dFdy(texel);
      const mip = max(0.0, log2(max(dot(dx, dx), dot(dy, dy))).mul(0.5));
      return texture(leafMap, texUv).a.mul(std.opacity).mul(float(1.0).add(mip.mul(0.6)));
    })();
    leafNodeCache.set(mat, out);
    return out;
  }
  std.onBeforeCompile = (shader) => {
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      [
        "#include <normal_fragment_begin>",
        patchShader(THREE.ShaderChunk.normal_fragment_begin, [["normal *= faceDirection;", ""]], "leaf normal chunk"),
      ],
      [
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\n\tmaterial.specularColor *= 0.2;\n\tmaterial.specularColorBlended *= 0.2;\n\tmaterial.specularF90 *= 0.2;",
      ],
      [
        "#include <alphatest_fragment>",
        /* glsl */ `
#ifdef USE_MAP
	vec2 leafTexel = vMapUv * vec2( textureSize( map, 0 ) );
	vec2 leafDx = dFdx( leafTexel );
	vec2 leafDy = dFdy( leafTexel );
	float leafMip = max( 0.0, 0.5 * log2( max( dot( leafDx, leafDx ), dot( leafDy, leafDy ) ) ) );
	diffuseColor.a *= 1.0 + leafMip * 0.6;
#endif
#include <alphatest_fragment>`,
      ],
    ], "scenery leaves");
  };
  std.customProgramCacheKey = () => "scenery-leaf-v3";
  std.needsUpdate = true;
  return mat;
}
