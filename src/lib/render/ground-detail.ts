import * as THREE from "three";
import { patchShader } from "./shader-patch";

/**
 * Close-range detail on the converted circuits' ground (scripts/tracks/port_ac_track.py). The mods paint their ground
 * as one photo or render over the whole site and tile a detail texture over it in their own shader; the GLB keeps
 * the big texture (at 2048, about a metre to a texel) and carries the main detail texture in the material's black
 * emissive slot, with `extras.groundDetail` = { tileM, mean }. Here the detail moves out of the emissive slot into a
 * world-space layer: sampled on the ground plane at two scales (one repeat every `tileM` metres, and a larger one that
 * breaks up the repeats), divided by its own mean colour so the ground keeps the photo's colour, and faded out with
 * distance, where the photo alone is sharp enough and the tiling would shimmer. The ground is matte: its specular is
 * cut to a quarter.
 */

/** How strongly the detail modulates the ground close up (0 none, 1 full) */
const STRENGTH = 0.55;
/** Distance band (m) over which the detail fades out */
const FADE_NEAR_M = 30;
const FADE_FAR_M = 160;

interface GroundDetailExtras {
  tileM: number;
  mean: [number, number, number];
}

function isGroundDetail(value: unknown): value is GroundDetailExtras {
  const v = value as GroundDetailExtras | undefined;
  return !!v && typeof v.tileM === "number" && v.tileM > 0 && Array.isArray(v.mean) && v.mean.length === 3;
}

export function applyGroundDetail(mat: THREE.Material): void {
  const std = mat as THREE.MeshStandardMaterial;
  const extras = std.userData?.groundDetail;
  if (!std.isMeshStandardMaterial || !isGroundDetail(extras) || !std.emissiveMap || std.userData.groundDetailApplied) return;
  std.userData.groundDetailApplied = true;
  const detail = std.emissiveMap;
  std.emissiveMap = null;
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  detail.anisotropy = 8;
  const uniforms = {
    groundDetailMap: { value: detail },
    groundDetailTile: { value: extras.tileM },
    groundDetailMean: { value: new THREE.Vector3(...extras.mean.map((c) => Math.max(c, 0.02))) },
    groundDetailStrength: { value: STRENGTH },
  };
  std.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchShader(shader.vertexShader, [
      ["#include <common>", "#include <common>\nvarying vec3 vGroundWorld;"],
      ["#include <worldpos_vertex>", "#include <worldpos_vertex>\n\tvGroundWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;"],
    ], "ground detail vertex");
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      [
        "#include <common>",
        "#include <common>\nvarying vec3 vGroundWorld;\nuniform sampler2D groundDetailMap;\nuniform float groundDetailTile;\nuniform vec3 groundDetailMean;\nuniform float groundDetailStrength;",
      ],
      [
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
	{
		float gdFade = 1.0 - smoothstep( ${FADE_NEAR_M.toFixed(1)}, ${FADE_FAR_M.toFixed(1)}, length( vGroundWorld - cameraPosition ) );
		if ( gdFade > 0.0 ) {
			vec3 gdNear = texture2D( groundDetailMap, vGroundWorld.xz / groundDetailTile ).rgb;
			vec3 gdFar = texture2D( groundDetailMap, vGroundWorld.xz / ( groundDetailTile * 5.37 ) + 0.31 ).rgb;
			vec3 gd = clamp( ( gdNear * 0.65 + gdFar * 0.35 ) / groundDetailMean, 0.0, 2.5 );
			diffuseColor.rgb *= mix( vec3( 1.0 ), gd, groundDetailStrength * gdFade );
		}
	}`,
      ],
      // Grass and soil are matte: at the grazing angles a low sun ahead makes, the stock Fresnel term turned the whole
      // field into a pale, glossy sheet
      [
        "#include <lights_physical_fragment>",
        "#include <lights_physical_fragment>\n\tmaterial.specularColor *= 0.25;\n\tmaterial.specularColorBlended *= 0.25;\n\tmaterial.specularF90 *= 0.25;",
      ],
    ], "ground detail fragment");
  };
  std.customProgramCacheKey = () => "ground-detail-v2";
  std.needsUpdate = true;
}
