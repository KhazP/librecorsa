import * as THREE from "three";

/**
 * PBR upgrades for the VF26 GLB materials (see vf26-car-model.ts; the GLB itself is not edited).
 *
 * - EXT_SKIN with a livery mask (restyled GLB, root extras `liveryMask`, see scripts/vf26/livery_vf26.py): the
 *   texture holds primary / secondary / accent weights in R / G / B and the shader mixes the selected livery's
 *   colours (`setVf26LiveryColours`). Primary and secondary are satin; the accent gets the gloss coat below.
 * - EXT_SKIN with the mod's authored colour texture: two-tone livery in one material. Navy/satin areas keep roughness 0.48 + clearcoat 0.35; warm
 *   yellow/red accents (detected per fragment from the sampled base colour) switch to a glossy coat
 *   (roughness 0.25, clearcoat 1.0, clearcoat roughness 0.04). The authored metallicRoughness map is dropped:
 *   its G channel is ~0.65 roughness on navy and ~0.22 on the yellow/red accents with B (metal) = 0 everywhere,
 *   so the colour mask reproduces the same regions with the target values and one 4K texture sample is saved.
 * - EXT_DECALS: clearcoat 1.0 / clearcoat roughness 0.04, nothing else changed.
 * - Carbon: procedural 2x2 twill weave (object-space triplanar, ~5 mm tow pitch, object units assumed metres)
 *   driving a height bump, a roughness of 0.32 +-0.06 between tows and a slight diffuse modulation. The weave
 *   fades out by pixel footprint (sub-pixel tows average to flat) and by distance, so it does not shimmer.
 *
 * Not touched: EXT_TYRE, mirror_*, INT_DISPLAY, INT_LED, EXT_clearled_security, glass, DRV_*, harness.
 */

type PaintTarget = "skin" | "decal" | "carbon";

const CARBON_MATERIALS = new Set([
  "EXT_carbon",
  "EXT_carbon_caliper",
  "EXT_black_s",
  // Steering-wheel carbon (the tub's matte INT_cockpit_carbon / _2 keep their authored look)
  "INT_sw_2026_carbon",
]);

/** Carbon base colour floor (linear). The GLB carbon is 0.007, which is too dark for the weave to read. */
const CARBON_BASE_FLOOR = 0.015;

/** Carbon tow pitch in object units (metres). */
const CARBON_TOW_PITCH = 0.005;
/** Peak weave relief in metres; drives the normal perturbation. */
const CARBON_RELIEF_M = 0.0003;

// Upgraded materials (outputs) and source -> output mapping so shared materials stay shared
const upgradedMaterials = new WeakSet<THREE.Material>();
const conversions = new WeakMap<THREE.Material, THREE.Material>();

export function isUpgradedMaterial(m: THREE.Material): boolean {
  return upgradedMaterials.has(m);
}

/**
 * Walks `root` and replaces the target GLB materials with MeshPhysicalMaterial upgrades.
 * Idempotent: already-upgraded materials are left alone, and a source material shared by several meshes is
 * converted once and the same replacement is assigned to all of them.
 */
export function upgradeVf26Materials(root: THREE.Object3D, options: { liveryMask?: boolean } = {}): void {
  const upgrade = (m: THREE.Material) => upgradeOne(m, options.liveryMask === true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(upgrade);
    } else {
      mesh.material = upgrade(mesh.material);
    }
  });
}

/** Livery colours for the masked EXT_SKIN paint (linear, shared by every VF26 instance) */
const liveryUniforms = {
  vf26Primary: { value: new THREE.Color("#00a1de") },
  vf26Secondary: { value: new THREE.Color("#0f172a") },
  vf26Accent: { value: new THREE.Color("#fad201") },
};

/** Sets the colours the livery mask mixes (CSS colour strings, sRGB). No shader recompile. */
export function setVf26LiveryColours(primary: string, secondary: string, accent: string): void {
  liveryUniforms.vf26Primary.value.set(primary);
  liveryUniforms.vf26Secondary.value.set(secondary);
  liveryUniforms.vf26Accent.value.set(accent);
}

function targetFor(name: string): PaintTarget | null {
  if (name === "EXT_SKIN") return "skin";
  if (name === "EXT_DECALS") return "decal";
  if (CARBON_MATERIALS.has(name)) return "carbon";
  return null;
}

function upgradeOne(m: THREE.Material, liveryMask: boolean): THREE.Material {
  if (upgradedMaterials.has(m)) return m;
  const existing = conversions.get(m);
  if (existing) return existing;

  const target = targetFor(m.name);
  if (!target) return m;
  if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;

  const out = toPhysical(m as THREE.MeshStandardMaterial);
  configure(out, target, m as THREE.MeshStandardMaterial, liveryMask);
  upgradedMaterials.add(out);
  conversions.set(m, out);
  return out;
}

/** Copies everything a GLB material carries that we keep; the caller then sets the PBR targets. */
function toPhysical(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const dst = new THREE.MeshPhysicalMaterial();
  dst.name = src.name;
  dst.userData = { ...src.userData };

  dst.color.copy(src.color);
  dst.map = src.map;
  dst.alphaMap = src.alphaMap;
  dst.alphaTest = src.alphaTest;
  dst.alphaHash = src.alphaHash;
  dst.opacity = src.opacity;
  dst.transparent = src.transparent;
  dst.side = src.side;
  dst.depthWrite = src.depthWrite;
  dst.depthTest = src.depthTest;
  dst.blending = src.blending;
  dst.visible = src.visible;
  dst.vertexColors = src.vertexColors;
  dst.flatShading = src.flatShading;
  dst.toneMapped = src.toneMapped;
  dst.wireframe = src.wireframe;
  dst.polygonOffset = src.polygonOffset;
  dst.polygonOffsetFactor = src.polygonOffsetFactor;
  dst.polygonOffsetUnits = src.polygonOffsetUnits;

  dst.emissive.copy(src.emissive);
  dst.emissiveMap = src.emissiveMap;
  dst.emissiveIntensity = src.emissiveIntensity;

  dst.normalMap = src.normalMap;
  dst.normalScale.copy(src.normalScale);
  dst.aoMap = src.aoMap;
  dst.aoMapIntensity = src.aoMapIntensity;
  dst.lightMap = src.lightMap;
  dst.lightMapIntensity = src.lightMapIntensity;
  dst.envMap = src.envMap;
  dst.envMapIntensity = src.envMapIntensity;

  // Kept as-is; the caller decides whether the MR maps survive (EXT_SKIN drops them)
  dst.roughnessMap = src.roughnessMap;
  dst.metalnessMap = src.metalnessMap;
  dst.roughness = src.roughness;
  dst.metalness = src.metalness;

  const phys = src as Partial<THREE.MeshPhysicalMaterial>;
  if (phys.isMeshPhysicalMaterial) {
    dst.clearcoatMap = phys.clearcoatMap ?? null;
    dst.clearcoatRoughnessMap = phys.clearcoatRoughnessMap ?? null;
    dst.clearcoatNormalMap = phys.clearcoatNormalMap ?? null;
  }
  return dst;
}

function configure(
  out: THREE.MeshPhysicalMaterial,
  target: PaintTarget,
  src: THREE.MeshStandardMaterial,
  liveryMask: boolean
): void {
  switch (target) {
    case "skin": {
      if (liveryMask && out.map) {
        out.roughness = 0.48;
        out.metalness = 0.15;
        out.roughnessMap = null;
        out.metalnessMap = null;
        out.clearcoat = 0.35;
        out.clearcoatRoughness = 0.15;
        // The mask holds weights, not colour: no sRGB decode
        out.map.colorSpace = THREE.NoColorSpace;
        out.map.needsUpdate = true;
        out.customProgramCacheKey = () => "vf26-skin-livery-mask-v1";
        out.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, liveryUniforms);
          shader.fragmentShader = patch(shader.fragmentShader, SKIN_MASK_FRAGMENT_PATCHES, out.name);
        };
        break;
      }
      // Uniform values are the navy/satin look; the shader moves warm accents to the gloss values.
      out.roughness = 0.48;
      out.metalness = 0.15;
      out.roughnessMap = null;
      out.metalnessMap = null;
      out.clearcoat = 0.35;
      out.clearcoatRoughness = 0.15;
      out.customProgramCacheKey = () => "vf26-skin-paint-v1";
      out.onBeforeCompile = (shader) => {
        shader.fragmentShader = patch(shader.fragmentShader, SKIN_FRAGMENT_PATCHES, out.name);
      };
      break;
    }
    case "decal": {
      out.clearcoat = 1.0;
      out.clearcoatRoughness = 0.04;
      break;
    }
    case "carbon": {
      // Keep the authored colour where it is already brighter than the floor (some interior carbon is ~0.08)
      const c = src.color;
      out.color.setRGB(
        Math.max(c.r, CARBON_BASE_FLOOR),
        Math.max(c.g, CARBON_BASE_FLOOR),
        Math.max(c.b, CARBON_BASE_FLOOR)
      );
      out.roughness = 0.32;
      out.metalness = 0.1;
      out.roughnessMap = null;
      out.metalnessMap = null;
      out.clearcoat = 0.2;
      out.clearcoatRoughness = 0.2;
      out.customProgramCacheKey = () => "vf26-carbon-weave-v1";
      out.onBeforeCompile = (shader) => {
        shader.vertexShader = patch(shader.vertexShader, CARBON_VERTEX_PATCHES, out.name);
        shader.fragmentShader = patch(shader.fragmentShader, CARBON_FRAGMENT_PATCHES, out.name);
      };
      break;
    }
  }
}

type Patch = readonly [anchor: string, replacement: string];

/**
 * Replaces each anchor (an unresolved `#include <...>` line of the three.js physical shader) exactly once.
 * A missing or duplicated anchor is reported, and that patch is skipped so the material falls back to its
 * uniform values instead of failing to compile.
 */
function patch(source: string, patches: readonly Patch[], label: string): string {
  let out = source;
  for (const [anchor, replacement] of patches) {
    const parts = out.split(anchor);
    if (parts.length !== 2) {
      console.warn(`[car-materials] ${label}: anchor "${anchor}" found ${parts.length - 1} times, skipped`);
      continue;
    }
    out = parts[0] + replacement + parts[1];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// EXT_SKIN: warm accent mask from the base colour
// ---------------------------------------------------------------------------------------------------------------

const WARM_MASK_GLSL = /* glsl */ `
// 1 for saturated red..yellow (linear rgb), 0 for navy, blue flakes, black, white and grey
float vf26WarmMask( vec3 c ) {
	float mx = max( max( c.r, c.g ), c.b );
	float mn = min( min( c.r, c.g ), c.b );
	float sat = ( mx - mn ) / max( mx, 1e-4 );
	float warmHue = smoothstep( 0.02, 0.15, c.r - c.b );
	return smoothstep( 0.02, 0.07, mx ) * smoothstep( 0.45, 0.75, sat ) * warmHue;
}
`;

const SKIN_FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\n" + WARM_MASK_GLSL],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
float vf26Warm = vf26WarmMask( diffuseColor.rgb );
float roughnessFactor = mix( roughness, 0.25, vf26Warm );
#ifdef USE_CLEARCOAT
	float vf26CoatAmount = mix( clearcoat, 1.0, vf26Warm );
	float vf26CoatRoughness = mix( clearcoatRoughness, 0.04, vf26Warm );
#endif
`,
	],
	[
		"#include <lights_physical_fragment>",
		/* glsl */ `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
	// Same clamps as the chunk above; the chunk has already run with the uniform values
	material.clearcoat = saturate( vf26CoatAmount );
	material.clearcoatRoughness = min( max( vf26CoatRoughness, 0.0525 ) + geometryRoughness, 1.0 );
#endif
`,
	],
];

// EXT_SKIN with the livery mask: R / G / B = primary / secondary / accent weights; the accent is the gloss coat
const SKIN_MASK_FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\nuniform vec3 vf26Primary;\nuniform vec3 vf26Secondary;\nuniform vec3 vf26Accent;"],
	[
		"#include <map_fragment>",
		/* glsl */ `
#ifdef USE_MAP
	vec3 vf26Mix = texture2D( map, vMapUv ).rgb;
	vf26Mix /= max( vf26Mix.r + vf26Mix.g + vf26Mix.b, 1e-3 );
	diffuseColor.rgb *= vf26Mix.r * vf26Primary + vf26Mix.g * vf26Secondary + vf26Mix.b * vf26Accent;
	float vf26Gloss = vf26Mix.b;
#else
	float vf26Gloss = 0.0;
#endif
`,
	],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
float roughnessFactor = mix( roughness, 0.25, vf26Gloss );
#ifdef USE_CLEARCOAT
	float vf26CoatAmount = mix( clearcoat, 1.0, vf26Gloss );
	float vf26CoatRoughness = mix( clearcoatRoughness, 0.04, vf26Gloss );
#endif
`,
	],
	SKIN_FRAGMENT_PATCHES[2],
];

// ---------------------------------------------------------------------------------------------------------------
// Carbon: triplanar 2x2 twill in object space
// ---------------------------------------------------------------------------------------------------------------

const CARBON_VERTEX_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\nvarying vec3 vVf26ObjPos;\nvarying vec3 vVf26ObjNrm;"],
	["#include <begin_vertex>", "#include <begin_vertex>\nvVf26ObjPos = position;\nvVf26ObjNrm = normal;"],
];

// Unnormalised-sigma version of three's perturbNormalArb (see asphalt-sheen.ts for why the sigmas stay unnormalised)
const CARBON_FRAGMENT_HELPERS_GLSL = /* glsl */ `
varying vec3 vVf26ObjPos;
varying vec3 vVf26ObjNrm;

// 2x2 twill: warp floats over two weft tows, then under two, shifting by one per row.
// Returns (profile across the tow, 1 where the warp is on top).
vec2 vf26Twill( vec2 p ) {
	vec2 c = floor( p );
	vec2 f = fract( p );
	float warpOver = step( mod( c.x + c.y, 4.0 ), 1.5 );
	float prof = mix( sin( 3.14159265 * f.x ), sin( 3.14159265 * f.y ), warpOver );
	return vec2( prof, warpOver );
}

vec3 vf26PerturbNormal( vec3 eyePos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
	vec3 dPdx = dFdx( eyePos );
	vec3 dPdy = dFdy( eyePos );
	vec3 R1 = cross( dPdy, surfNorm );
	vec3 R2 = cross( surfNorm, dPdx );
	float det = dot( dPdx, R1 ) * faceDir;
	vec3 grad = sign( det ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
	return normalize( abs( det ) * surfNorm - grad );
}
`;

const CARBON_FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\n" + CARBON_FRAGMENT_HELPERS_GLSL],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
vec3 vf26N = normalize( vVf26ObjNrm );
vec3 vf26W = pow( abs( vf26N ), vec3( 4.0 ) );
vf26W /= ( vf26W.x + vf26W.y + vf26W.z );
float vf26Inv = ${(1 / CARBON_TOW_PITCH).toFixed(1)};
vec2 vf26Hx = vf26Twill( vVf26ObjPos.zy * vf26Inv );
vec2 vf26Hy = vf26Twill( vVf26ObjPos.xz * vf26Inv );
vec2 vf26Hz = vf26Twill( vVf26ObjPos.xy * vf26Inv );
float vf26Height = dot( vf26W, vec3( vf26Hx.x, vf26Hy.x, vf26Hz.x ) );
float vf26Tow = dot( vf26W, vec3( vf26Hx.y, vf26Hy.y, vf26Hz.y ) );
// Tows per pixel: sub-pixel weave averages to flat instead of shimmering
vec3 vf26DP = fwidth( vVf26ObjPos );
float vf26TowPerPx = max( vf26DP.x, max( vf26DP.y, vf26DP.z ) ) * vf26Inv;
float vf26Fade = ( 1.0 - smoothstep( 0.15, 0.3, vf26TowPerPx ) ) * ( 1.0 - smoothstep( 8.0, 25.0, length( vViewPosition ) ) );
float vf26Sign = 2.0 * vf26Tow - 1.0;
float roughnessFactor = 0.32 + 0.06 * vf26Sign * vf26Fade;
diffuseColor.rgb *= 1.0 + 0.2 * vf26Sign * vf26Fade;
float vf26ReliefM = vf26Height * ${CARBON_RELIEF_M.toExponential()} * vf26Fade;
`,
	],
	[
		"#include <normal_fragment_maps>",
		/* glsl */ `
#include <normal_fragment_maps>
normal = vf26PerturbNormal( -vViewPosition, normal, vec2( dFdx( vf26ReliefM ), dFdy( vf26ReliefM ) ), faceDirection );
`,
	],
];
