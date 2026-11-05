import * as THREE from "three";
import { sharedWetUniforms, WORLD_NOISE_GLSL } from "@/lib/render/asphalt-sheen";
import { patchShader, type ShaderPatch } from "@/lib/render/shader-patch";

/**
 * Surface detail for trackside scenery that ships as flat-colour, UV-less geometry (Rwanda's trees, grandstand
 * roofs, spire, lake, paint and sausage kerbs). Nothing is added to the GLB: the variation is world-space value
 * noise in the shader, and the trees get rounded normals, a per-tree tint and an occlusion term baked into their
 * geometry once at load.
 *
 * Matched by exact material name and only on untextured materials (other circuits' textured `TREE*` stay as they
 * are). One shader serves every kind; the kind is a define, so materials of a kind share one program and only
 * uniform values differ between them. On Low graphics quality the noise is skipped (`uSceneryDetail` 0) and the
 * baked normals, tint and occlusion remain, which matter most there since Low has no sun shadows.
 */

type SceneryKind = "TREE" | "ROOF" | "BUILDING" | "WATER" | "PAINT";

const SCENERY_MATERIALS: Record<string, SceneryKind> = {
  Tree_Canopy: "TREE",
  Tree_Trunk: "TREE",
  Grandstand_Canopy: "ROOF",
  Building_White: "BUILDING",
  Lake_Water: "WATER",
  Paint_White: "PAINT",
  Kerb_Yellow: "PAINT",
};

/** Shared by every scenery material (one write reaches them all) */
const sceneryUniforms = {
  uSceneryDetail: { value: 1 },
  uSceneryTime: { value: 0 },
};

/** Graphics quality: Low drops the noise and bump (the baked tree shading stays) */
export function setSceneryQuality(quality: "low" | "medium" | "high"): void {
  sceneryUniforms.uSceneryDetail.value = quality === "low" ? 0 : 1;
}

/** Seconds, for the lake's moving ripples (wrapped so the float keeps its precision) */
export function setSceneryTime(seconds: number): void {
  if (Number.isFinite(seconds)) sceneryUniforms.uSceneryTime.value = seconds % 3600;
}

/** The kind of detail a material gets, or null when it is not one of the flat scenery materials */
export function sceneryKind(mat: THREE.Material): SceneryKind | null {
  const std = mat as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial || std.map) return null;
  return SCENERY_MATERIALS[mat.name] ?? null;
}

const patched = new WeakSet<THREE.Material>();

/**
 * Patches a flat scenery material in place (once). `baseY` is the world height of the object's foot (a building's
 * grime band); `treeShading` says the geometry carries the baked `color` and `sceneryAo` attributes
 * (`prepareTreeGeometry`). Returns whether the material was patched.
 */
export function applySceneryDetail(mat: THREE.Material, opts: { baseY?: number; treeShading?: boolean } = {}): boolean {
  const kind = sceneryKind(mat);
  if (!kind || patched.has(mat)) return false;
  patched.add(mat);
  const std = mat as THREE.MeshStandardMaterial;
  const treeShading = kind === "TREE" && opts.treeShading === true;
  const uniforms = {
    ...sceneryUniforms,
    ...sharedWetUniforms,
    uSceneryBaseY: { value: opts.baseY ?? 0 },
  };
  // Merge: the rough-diffuse conversion (scene-builder) sets STANDARD + PHYSICAL and must keep them
  std.defines = { ...(std.defines ?? {}), [`SCENERY_${kind}`]: "", ...(treeShading ? { SCENERY_AO: "" } : {}) };
  if (treeShading) std.vertexColors = true;
  std.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchShader(shader.vertexShader, VERTEX_PATCHES, "scenery");
    shader.fragmentShader = patchShader(shader.fragmentShader, FRAGMENT_PATCHES, "scenery");
  };
  std.customProgramCacheKey = () => "scenery-detail-v1";
  std.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// Tree geometry bake
// ---------------------------------------------------------------------------

/**
 * Rounds the shading of the low-poly trees (one merged mesh of separate trunks or canopies, flat-shaded). Each tree
 * is found as a connected piece (vertices welded by position), then:
 *  - normals point out of the canopy's ellipsoid (biased up) or radially out of the trunk, so a hexagonal pancake
 *    shades like a soft crown instead of six flat facets;
 *  - `color` gets a per-tree tint (±12 % brightness, a little hue drift), so 520 trees stop being one colour;
 *  - `sceneryAo` darkens the canopy's underside and the trunk's foot, for ambient light only.
 * Returns false (and changes nothing) when the geometry does not look like a set of trees.
 */
export function prepareTreeGeometry(geometry: THREE.BufferGeometry, part: "trunk" | "canopy"): boolean {
  const pos = geometry.getAttribute("position");
  if (!pos || pos.count < 3) return false;
  const count = pos.count;

  // Weld by position (1 mm), then join the vertices of every triangle
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const weld = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    const first = weld.get(key);
    if (first === undefined) weld.set(key, i);
    else union(i, first);
  }
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : count / 3;
  for (let t = 0; t < triCount; t++) {
    const a = index ? index.getX(3 * t) : 3 * t;
    const b = index ? index.getX(3 * t + 1) : 3 * t + 1;
    const c = index ? index.getX(3 * t + 2) : 3 * t + 2;
    union(a, b);
    union(b, c);
  }

  // Per tree: bounds and centroid
  const comp = new Int32Array(count);
  const roots = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    let id = roots.get(r);
    if (id === undefined) {
      id = roots.size;
      roots.set(r, id);
    }
    comp[i] = id;
  }
  const n = roots.size;
  if (n < 2 || n > count / 3) return false;
  const min = new Float32Array(n * 3).fill(Infinity);
  const max = new Float32Array(n * 3).fill(-Infinity);
  const sum = new Float64Array(n * 3);
  const verts = new Int32Array(n);
  for (let i = 0; i < count; i++) {
    const k = comp[i] * 3;
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let a = 0; a < 3; a++) {
      min[k + a] = Math.min(min[k + a], p[a]);
      max[k + a] = Math.max(max[k + a], p[a]);
      sum[k + a] += p[a];
    }
    verts[comp[i]]++;
  }

  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const ao = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const c = comp[i];
    const k = c * 3;
    const cx = sum[k] / verts[c];
    const cy = sum[k + 1] / verts[c];
    const cz = sum[k + 2] / verts[c];
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const height = Math.max(1e-3, max[k + 1] - min[k + 1]);
    const t = (y - min[k + 1]) / height;
    if (part === "canopy") {
      const rx = Math.max(0.1, 0.5 * (max[k] - min[k]));
      const ry = Math.max(0.1, 0.5 * height);
      const rz = Math.max(0.1, 0.5 * (max[k + 2] - min[k + 2]));
      v.set((x - cx) / rx, (y - cy) / ry, (z - cz) / rz);
      if (v.lengthSq() < 1e-8) v.set(0, 1, 0);
      v.normalize();
      v.y += 0.3;
      ao[i] = 0.55 + 0.45 * t;
    } else {
      v.set(x - cx, 0, z - cz);
      if (v.lengthSq() < 1e-8) v.set(1, 0, 0);
      ao[i] = 0.45 + 0.4 * t;
    }
    v.normalize();
    normals[3 * i] = v.x;
    normals[3 * i + 1] = v.y;
    normals[3 * i + 2] = v.z;
    // Per-tree tint from its position (stable across loads)
    const h1 = hash2(cx, cz);
    const h2 = hash2(cz + 17.3, cx - 5.1);
    const lum = part === "canopy" ? 0.88 + 0.24 * h1 : 0.92 + 0.16 * h1;
    const drift = part === "canopy" ? h2 - 0.5 : 0;
    colors[3 * i] = lum * (1 + 0.18 * drift);
    colors[3 * i + 1] = lum;
    colors[3 * i + 2] = lum * (1 - 0.15 * drift);
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("sceneryAo", new THREE.BufferAttribute(ao, 1));
  geometry.userData.sceneryTrees = n;
  return true;
}

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ---------------------------------------------------------------------------
// Shader patches
// ---------------------------------------------------------------------------

type Patch = ShaderPatch;

export const VERTEX_PATCHES: readonly Patch[] = [
  [
    "#include <common>",
    /* glsl */ `#include <common>
varying vec3 vVf26WorldPos;
varying vec3 vSceneryWorldNormal;
#ifdef SCENERY_AO
attribute float sceneryAo;
varying float vSceneryAo;
#endif`,
  ],
  [
    "#include <begin_vertex>",
    /* glsl */ `#include <begin_vertex>
vVf26WorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vSceneryWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
#ifdef SCENERY_AO
vSceneryAo = sceneryAo;
#endif`,
  ],
];

export const FRAGMENT_PATCHES: readonly Patch[] = [
  [
    "#include <common>",
    /* glsl */ `#include <common>
uniform float uSceneryDetail;
uniform float uSceneryTime;
uniform float uSceneryBaseY;
uniform float uWetness;
uniform float uRainIntensity;
uniform float uWetTime;
varying vec3 vVf26WorldPos;
varying vec3 vSceneryWorldNormal;
#ifdef SCENERY_AO
varying float vSceneryAo;
#endif
${WORLD_NOISE_GLSL}`,
  ],
  [
    "#include <color_fragment>",
    /* glsl */ `#include <color_fragment>
vec3 scnN = normalize( vSceneryWorldNormal );
vec3 scnP = vVf26WorldPos;
float scnDist = length( vViewPosition );
// Detail fades out with distance, where it would only shimmer
float scnDetail = uSceneryDetail * ( 1.0 - smoothstep( 60.0, 220.0, scnDist ) );
#if defined( SCENERY_TREE )
	if ( scnDetail > 0.0 ) {
		// Leaf clumps / bark: two octaves of world noise, the height folded in so the canopy's sides vary too
		vec2 scnQ = scnP.xz + scnP.y * vec2( 0.37, -0.61 );
		diffuseColor.rgb *= 1.0 + scnDetail * ( 0.2 * vf26ValueNoise( scnQ / 0.9 ) + 0.12 * vf26ValueNoise( scnQ / 2.7 ) );
	}
#elif defined( SCENERY_ROOF ) || defined( SCENERY_BUILDING )
	if ( scnDetail > 0.0 ) {
		// Weathering: triplanar world noise, plus vertical streaks on the walls
		vec3 scnW = pow( abs( scnN ), vec3( 4.0 ) );
		scnW /= scnW.x + scnW.y + scnW.z;
		float scnGrime = scnW.x * vf26ValueNoise( scnP.zy / 1.7 ) + scnW.y * vf26ValueNoise( scnP.xz / 1.7 ) + scnW.z * vf26ValueNoise( scnP.xy / 1.7 );
		float scnStreak = vf26ValueNoise( vec2( ( scnP.x + scnP.z ) / 0.45, scnP.y / 7.0 ) );
		scnGrime = 0.6 * scnGrime + 0.4 * scnStreak * ( 1.0 - scnW.y );
		diffuseColor.rgb *= 1.0 - scnDetail * 0.16 * smoothstep( -0.3, 0.9, scnGrime );
	}
	// Faces turned to the ground only see what the dull ground bounces back
	diffuseColor.rgb *= mix( 1.0, 0.72, 1.0 - smoothstep( -0.6, 0.0, scnN.y ) );
	#ifdef SCENERY_BUILDING
		// Splash-back and grime at the foot
		diffuseColor.rgb *= mix( 0.7, 1.0, smoothstep( 0.0, 8.0, scnP.y - uSceneryBaseY ) );
	#endif
#elif defined( SCENERY_PAINT )
	if ( scnDetail > 0.0 ) {
		float scnDirt = 0.6 * vf26ValueNoise( scnP.xz / 1.3 ) + 0.4 * vf26ValueNoise( scnP.xz / 0.35 );
		diffuseColor.rgb *= 1.0 - scnDetail * 0.12 * smoothstep( -0.2, 0.8, scnDirt );
	}
	// Wet paint darkens like the asphalt around it
	diffuseColor.rgb *= 1.0 - 0.22 * uWetness;
#endif`,
  ],
  [
    "#include <roughnessmap_fragment>",
    /* glsl */ `#include <roughnessmap_fragment>
#if defined( SCENERY_ROOF ) || defined( SCENERY_BUILDING )
	roughnessFactor = clamp( roughnessFactor + 0.1 * scnDetail * vf26ValueNoise( scnP.xz / 3.1 + scnP.y * 0.2 ), 0.04, 1.0 );
#elif defined( SCENERY_PAINT )
	roughnessFactor = mix( roughnessFactor, 0.12, 0.8 * uWetness );
#endif`,
  ],
  [
    "#include <normal_fragment_maps>",
    /* glsl */ `#include <normal_fragment_maps>
#if defined( SCENERY_TREE ) || defined( SCENERY_WATER )
{
	float scnH = 0.0;
	#ifdef SCENERY_TREE
		vec2 scnB = scnP.xz + scnP.y * vec2( 0.37, -0.61 );
		float scnAa = 1.0 - smoothstep( 0.25, 0.5, max( fwidth( scnB.x ), fwidth( scnB.y ) ) / 0.55 );
		scnH = 0.09 * ( 0.65 * vf26ValueNoise( scnB / 0.55 ) + 0.35 * vf26ValueNoise( scnB / 1.6 ) ) * scnDetail * scnAa;
	#else
		// Wind ripples drifting across the lake, and rain rings close to the camera
		vec2 scnL = scnP.xz;
		float scnAa = 1.0 - smoothstep( 0.25, 0.5, max( fwidth( scnL.x ), fwidth( scnL.y ) ) / 0.8 );
		scnH = 0.012 * ( vf26ValueNoise( scnL / 2.4 + uSceneryTime * vec2( 0.06, 0.035 ) ) + 0.5 * vf26ValueNoise( scnL / 0.8 - uSceneryTime * vec2( 0.05, 0.08 ) ) );
		scnH *= uSceneryDetail * scnAa;
		if ( uRainIntensity > 0.02 ) {
			scnH += 0.004 * vf26RainSplash( scnL, uWetTime, uRainIntensity ) * uSceneryDetail * ( 1.0 - smoothstep( 15.0, 45.0, scnDist ) );
		}
	#endif
	normal = vf26PerturbNormal( -vViewPosition, normal, vec2( dFdx( scnH ), dFdy( scnH ) ), faceDirection );
}
#endif`,
  ],
  [
    "#include <aomap_fragment>",
    /* glsl */ `#include <aomap_fragment>
#ifdef SCENERY_AO
	// Baked tree occlusion: ambient light only, the sun still reaches what it reaches
	reflectedLight.indirectDiffuse *= vSceneryAo;
	reflectedLight.indirectSpecular *= vSceneryAo;
#endif`,
  ],
];
