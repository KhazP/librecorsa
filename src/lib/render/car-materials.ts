import * as THREE from "three";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { toPhysical } from "./to-physical";
import { applyPaintFinish, SATIN_PAINT } from "./paint-finish";

/**
 * PBR upgrades for the LC26 GLB materials (see lc26-car-model.ts; the GLB itself is not edited).
 *
 * - EXT_SKIN with a livery mask (restyled GLB, root extras `liveryMask`, see scripts/lc26/livery_lc26.py): the
 *   texture holds primary / secondary / accent weights in R / G / B and the shader mixes the selected livery's
 *   colours (`setLc26LiveryColours`).
 * - EXT_SKIN with the mod's authored colour texture: two-tone livery in one material.
 *   Both are satin all over (paint-finish.ts), like a race livery; the authored metallicRoughness map is dropped.
 *   The paint reflects less than the plain satin finish and its coat is thinner and sharper (`applyBodyPaint`).
 * - EXT_DECALS: the same satin finish.
 * - Carbon: procedural 2x2 twill weave (object-space triplanar, ~5 mm tow pitch, object units assumed metres)
 *   driving a height bump, a roughness of 0.32 +-0.06 between tows and a slight diffuse modulation. The weave
 *   fades out by pixel footprint (sub-pixel tows average to flat) and by distance, so it does not shimmer.
 *
 * - EXT_PAINT_PRIMARY / _SECONDARY / _ACCENT (`PAINT_ZONE_MATERIALS`): a body painted in zones, no texture; the same
 *   satin finish, coloured per car with the livery by lc26-car-model.ts.
 *
 * Not touched: EXT_TYRE, mirror_*, INT_DISPLAY, INT_LED, EXT_clearled_security, glass, DRV_*, harness.
 */

type PaintTarget = "skin" | "decal" | "carbon";

/** The materials of a body painted in livery zones, primary / secondary / accent */
export const PAINT_ZONE_MATERIALS: readonly string[] = ["EXT_PAINT_PRIMARY", "EXT_PAINT_SECONDARY", "EXT_PAINT_ACCENT"];

const CARBON_MATERIALS = new Set([
  "EXT_carbon",
  "EXT_carbon_caliper",
  "EXT_black_s",
  // Steering-wheel carbon (the tub's matte INT_cockpit_carbon / _2 keep their authored look)
  "INT_sw_2026_carbon",
]);

/**
 * The body paint's own reflection, as a share of a plain surface's (three's `specularIntensity`). Satin paint spreads
 * a low sun ahead of the car over every surface that faces it, and from behind a dark livery then reads as silver;
 * at this share the colour holds.
 */
const PAINT_REFLECTION = 0.18;
/** The coat over it: thinner than the satin finish's and sharper, so the sun shows in it as a line of light */
const PAINT_COAT = 0.12;
const PAINT_COAT_ROUGHNESS = 0.15;

/** Carbon base colour floor (linear). The GLB carbon is 0.007, which is too dark for the weave to read. */
const CARBON_BASE_FLOOR = 0.015;

/** Carbon tow pitch in object units (metres). */
const CARBON_TOW_PITCH = 0.005;
/** Peak weave relief in metres; drives the normal perturbation. */
const CARBON_RELIEF_M = 0.0003;

// Upgraded materials (outputs) and source -> output mapping so shared materials stay shared
const upgradedMaterials = new WeakSet<THREE.Material>();
const conversions = new WeakMap<THREE.Material, THREE.Material>();

/**
 * Walks `root` and replaces the target GLB materials with MeshPhysicalMaterial upgrades.
 * Idempotent: already-upgraded materials are left alone, and a source material shared by several meshes is
 * converted once and the same replacement is assigned to all of them.
 */
export function upgradeLc26Materials(root: THREE.Object3D, options: { liveryMask?: boolean } = {}): void {
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

/** Livery colours for the masked EXT_SKIN paint (linear, shared by every LC26 instance) */
const liveryUniforms = {
  lc26Primary: { value: new THREE.Color("#00a1de") },
  lc26Secondary: { value: new THREE.Color("#0f172a") },
  lc26Accent: { value: new THREE.Color("#fad201") },
};

/** Sets the colours the livery mask mixes (CSS colour strings, sRGB). No shader recompile. */
export function setLc26LiveryColours(primary: string, secondary: string, accent: string): void {
  liveryUniforms.lc26Primary.value.set(primary);
  liveryUniforms.lc26Secondary.value.set(secondary);
  liveryUniforms.lc26Accent.value.set(accent);
}

function targetFor(name: string): PaintTarget | null {
  if (name === "EXT_SKIN" || PAINT_ZONE_MATERIALS.includes(name)) return "skin";
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


function configure(
  out: THREE.MeshPhysicalMaterial,
  target: PaintTarget,
  src: THREE.MeshStandardMaterial,
  liveryMask: boolean
): void {
  switch (target) {
    case "skin": {
      out.roughnessMap = null;
      out.metalnessMap = null;
      applyBodyPaint(out);
      if (liveryMask && out.map) {
        // The mask holds weights, not colour: no sRGB decode. On a copy: toPhysical shares the source's texture
        // object, and another material still sampling it as colour must keep its sRGB decode
        out.map = out.map.clone();
        out.map.colorSpace = THREE.NoColorSpace;
        out.map.needsUpdate = true;
        out.customProgramCacheKey = () => "lc26-skin-livery-mask-v2";
        out.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, liveryUniforms);
          shader.fragmentShader = patch(shader.fragmentShader, SKIN_MASK_FRAGMENT_PATCHES, out.name);
        };
      }
      break;
    }
    case "decal": {
      applyBodyPaint(out);
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
      out.customProgramCacheKey = () => "lc26-carbon-weave-v1";
      out.onBeforeCompile = (shader) => {
        shader.vertexShader = patch(shader.vertexShader, CARBON_VERTEX_PATCHES, out.name);
        shader.fragmentShader = patch(shader.fragmentShader, CARBON_FRAGMENT_PATCHES, out.name);
      };
      break;
    }
  }
}

/** The satin finish, with its reflection toned so the livery's colour reads when the car heads into a low sun */
function applyBodyPaint(out: THREE.MeshPhysicalMaterial): void {
  applyPaintFinish(out, SATIN_PAINT);
  out.specularIntensity = PAINT_REFLECTION;
  out.clearcoat = PAINT_COAT;
  out.clearcoatRoughness = PAINT_COAT_ROUGHNESS;
}

type Patch = ShaderPatch;
const patch = patchShader;

// ---------------------------------------------------------------------------------------------------------------
// EXT_SKIN: livery mask colours
// ---------------------------------------------------------------------------------------------------------------

// EXT_SKIN with the livery mask: R / G / B = primary / secondary / accent weights
const SKIN_MASK_FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\nuniform vec3 lc26Primary;\nuniform vec3 lc26Secondary;\nuniform vec3 lc26Accent;"],
	[
		"#include <map_fragment>",
		/* glsl */ `
#ifdef USE_MAP
	vec3 lc26Mix = texture2D( map, vMapUv ).rgb;
	lc26Mix /= max( lc26Mix.r + lc26Mix.g + lc26Mix.b, 1e-3 );
	diffuseColor.rgb *= lc26Mix.r * lc26Primary + lc26Mix.g * lc26Secondary + lc26Mix.b * lc26Accent;
#endif
`,
	],
];

// ---------------------------------------------------------------------------------------------------------------
// Carbon: triplanar 2x2 twill in object space
// ---------------------------------------------------------------------------------------------------------------

const CARBON_VERTEX_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\nvarying vec3 vLc26ObjPos;\nvarying vec3 vLc26ObjNrm;"],
	["#include <begin_vertex>", "#include <begin_vertex>\nvLc26ObjPos = position;\nvLc26ObjNrm = normal;"],
];

// Unnormalised-sigma version of three's perturbNormalArb (see asphalt-sheen.ts for why the sigmas stay unnormalised)
const CARBON_FRAGMENT_HELPERS_GLSL = /* glsl */ `
varying vec3 vLc26ObjPos;
varying vec3 vLc26ObjNrm;

// 2x2 twill: warp floats over two weft tows, then under two, shifting by one per row.
// Returns (profile across the tow, 1 where the warp is on top).
vec2 lc26Twill( vec2 p ) {
	vec2 c = floor( p );
	vec2 f = fract( p );
	float warpOver = step( mod( c.x + c.y, 4.0 ), 1.5 );
	float prof = mix( sin( 3.14159265 * f.x ), sin( 3.14159265 * f.y ), warpOver );
	return vec2( prof, warpOver );
}

vec3 lc26PerturbNormal( vec3 eyePos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
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
vec3 lc26N = normalize( vLc26ObjNrm );
vec3 lc26W = pow( abs( lc26N ), vec3( 4.0 ) );
lc26W /= ( lc26W.x + lc26W.y + lc26W.z );
float lc26Inv = ${(1 / CARBON_TOW_PITCH).toFixed(1)};
vec2 lc26Hx = lc26Twill( vLc26ObjPos.zy * lc26Inv );
vec2 lc26Hy = lc26Twill( vLc26ObjPos.xz * lc26Inv );
vec2 lc26Hz = lc26Twill( vLc26ObjPos.xy * lc26Inv );
float lc26Height = dot( lc26W, vec3( lc26Hx.x, lc26Hy.x, lc26Hz.x ) );
float lc26Tow = dot( lc26W, vec3( lc26Hx.y, lc26Hy.y, lc26Hz.y ) );
// Tows per pixel: sub-pixel weave averages to flat instead of shimmering
vec3 lc26DP = fwidth( vLc26ObjPos );
float lc26TowPerPx = max( lc26DP.x, max( lc26DP.y, lc26DP.z ) ) * lc26Inv;
float lc26Fade = ( 1.0 - smoothstep( 0.15, 0.3, lc26TowPerPx ) ) * ( 1.0 - smoothstep( 8.0, 25.0, length( vViewPosition ) ) );
float lc26Sign = 2.0 * lc26Tow - 1.0;
float roughnessFactor = 0.32 + 0.06 * lc26Sign * lc26Fade;
diffuseColor.rgb *= 1.0 + 0.2 * lc26Sign * lc26Fade;
float lc26ReliefM = lc26Height * ${CARBON_RELIEF_M.toExponential()} * lc26Fade;
`,
	],
	[
		"#include <normal_fragment_maps>",
		/* glsl */ `
#include <normal_fragment_maps>
normal = lc26PerturbNormal( -vViewPosition, normal, vec2( dFdx( lc26ReliefM ), dFdy( lc26ReliefM ) ), faceDirection );
`,
	],
];
