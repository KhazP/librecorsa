import * as THREE from "three";
import { patchShader } from "./shader-patch";

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
export function leafShading(mat: THREE.Material): void {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || !std.map || !(std.alphaTest > 0) || std.userData.leafShading) return;
  std.userData.leafShading = true;
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
}
