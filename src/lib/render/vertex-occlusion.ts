import * as THREE from "three";
import { patchShader, type ShaderPatch } from "./shader-patch";

/**
 * Baked shading for a car body whose porter gave its vertices `_OCCLUSION` (the loader's `_occlusion`): how much of
 * the sky each one sees past the rest of the car, 1 = all of it (see `scripts/cars/port_qvist_f1.mjs`). It dims what
 * the sky and the surroundings light, as an occlusion map does, and a share of the sun's light too, since the shadow
 * map is too coarse for the gaps between a wing's elements or a floor's edge and the body.
 */
const ATTRIBUTE = "_occlusion";

/** The share of the occlusion the sun's light takes (0: none, 1: as much as the sky's) */
const DIRECT_SHARE = 0.35;

const VERTEX_PATCHES: readonly ShaderPatch[] = [
  ["#include <common>", `#include <common>\nattribute float ${ATTRIBUTE};\nvarying float vBakedOcclusion;`],
  ["#include <begin_vertex>", `#include <begin_vertex>\n\tvBakedOcclusion = ${ATTRIBUTE};`],
];

const FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  ["#include <common>", "#include <common>\nvarying float vBakedOcclusion;"],
  [
    "#include <aomap_fragment>",
    /* glsl */ `#include <aomap_fragment>
	{
		float bakedOcclusion = clamp( vBakedOcclusion, 0.0, 1.0 );
		float bakedDirect = mix( 1.0, bakedOcclusion, ${DIRECT_SHARE.toFixed(2)} );
		reflectedLight.indirectDiffuse *= bakedOcclusion;
		reflectedLight.directDiffuse *= bakedDirect;
		reflectedLight.directSpecular *= bakedDirect;
		#if defined( USE_CLEARCOAT )
			clearcoatSpecularIndirect *= bakedOcclusion;
			clearcoatSpecularDirect *= bakedDirect;
		#endif
		#if defined( USE_ENVMAP ) && defined( STANDARD )
			reflectedLight.indirectSpecular *= computeSpecularOcclusion( saturate( dot( geometryNormal, geometryViewDir ) ), bakedOcclusion, material.roughness );
		#endif
	}`,
  ],
];

const patched = new WeakSet<THREE.Material>();

const materialsOf = (mesh: THREE.Mesh): THREE.Material[] => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

/**
 * Gives every material on a mesh under `roots` that carries the occlusion the shader for it. A material is one
 * program whatever mesh wears it, so a mesh without the attribute that shares such a material gets it too, all 1.
 * After the materials are final (upgraded, cloned per car, their other shader hooks installed): this one chains onto
 * what is there. Returns whether anything carries it.
 */
export function installVertexOcclusion(roots: readonly THREE.Object3D[]): boolean {
  const meshes: THREE.Mesh[] = [];
  for (const root of roots) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
  }
  const wanted = new Set<THREE.Material>();
  for (const mesh of meshes) {
    if (!mesh.geometry.getAttribute(ATTRIBUTE)) continue;
    for (const m of materialsOf(mesh)) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) wanted.add(m);
    }
  }
  if (!wanted.size) return false;

  for (const m of wanted) {
    if (patched.has(m)) continue;
    patched.add(m);
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      prev?.call(m, shader, renderer);
      shader.vertexShader = patchShader(shader.vertexShader, VERTEX_PATCHES, `${m.name} occlusion`);
      shader.fragmentShader = patchShader(shader.fragmentShader, FRAGMENT_PATCHES, `${m.name} occlusion`);
    };
    const key = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => `${key()}|vertex-occlusion`;
    m.needsUpdate = true;
  }

  for (const mesh of meshes) {
    if (mesh.geometry.getAttribute(ATTRIBUTE) || !materialsOf(mesh).some((m) => wanted.has(m))) continue;
    const open = new Uint8Array(mesh.geometry.getAttribute("position").count).fill(255);
    mesh.geometry.setAttribute(ATTRIBUTE, new THREE.BufferAttribute(open, 1, true));
  }
  return true;
}
