import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { aiLineOffsetM } from "@/lib/sim/speed-profile";
import { patchShader, type ShaderPatch } from "./shader-patch";

/**
 * Rubbered-in racing line on the asphalt: a top-down world-XZ mask (white = rubber) drives roughness, a slight
 * darkening and a world-space aggregate normal bump. The mask is painted once per track on a 2D canvas, so the
 * per-fragment cost is one texture fetch plus a few cheap value-noise taps.
 */

export interface RacingLineMask {
  /** Red channel = rubber amount 0..1. Canvas row 0 is the minimum Z edge (flipY is off). */
  texture: THREE.Texture;
  /** World XZ of the mask's minimum corner */
  worldMin: THREE.Vector2;
  /** World XZ extent covered by the mask (square) */
  worldSize: THREE.Vector2;
}

/** Margin around the racing line covered by the mask (m) */
const MASK_MARGIN_M = 40;
/** Normal bump strength multiplier on the aggregate noise (dimensionless gradient scale) */
const AGGREGATE_NORMAL_SCALE = 0.3;

const maskCache = new WeakMap<BuiltTrackData, Map<string, RacingLineMask>>();

/**
 * How wet the asphalt looks, shared by every sheen material (one uniform object, so a single write reaches them all).
 * Off the line and on the rubbered line separately: the cars dry the line first.
 */
const wetUniforms = {
  uWetness: { value: 0 },
  uLineWetness: { value: 0 },
  uRainIntensity: { value: 0 },
  uWetTime: { value: 0 },
};
/** The same uniform objects, for other surfaces that get wet with the track (scenery-detail) */
export const sharedWetUniforms: Readonly<typeof wetUniforms> = wetUniforms;

/**
 * Wet look of the track surface (0 dry … 1 soaked): darker, glossier asphalt with standing-water puddles,
 * grazing-angle Fresnel reflections, and animated raindrop splash ripples when raining.
 */
export function setAsphaltWetness(offLine: number, onLine: number = offLine, rainIntensity: number = 0): void {
  wetUniforms.uWetness.value = Math.min(1, Math.max(0, offLine));
  wetUniforms.uLineWetness.value = Math.min(1, Math.max(0, onLine));
  wetUniforms.uRainIntensity.value = Math.min(1, Math.max(0, rainIntensity));
}

/** Runs the raindrop ripples' clock; call every frame with the frame time (s), so they animate at frame rate */
export function advanceAsphaltRain(dt: number): void {
  if (!(Number.isFinite(dt) && dt > 0)) return;
  if (wetUniforms.uRainIntensity.value > 0.001) {
    // Not wrapped while the ripples show: their phase is time × a per-drop rate, so a wrap jumps them all at once
    wetUniforms.uWetTime.value += Math.min(0.1, dt);
    if (wetUniforms.uWetTime.value > 4 * 3600) wetUniforms.uWetTime.value = 0;
  } else {
    // No rain, no ripples drawn: the moment to bring the clock back to zero
    wetUniforms.uWetTime.value = 0;
  }
}

/** Racing line in world XZ, using the same lateral convention as the drawn racing line in scene-builder */
function racingLinePoints(track: BuiltTrackData): Array<{ x: number; z: number }> {
  return track.samples.map((s) => {
    const lat = aiLineOffsetM(s);
    return {
      x: s.position.x + s.binormal.x * lat,
      z: s.position.z + s.binormal.z * lat,
    };
  });
}

/**
 * Paints the rubbered-in line into a square canvas. Cached per track object and option set.
 * `bandWidthM` is the core width (default 2.2 m); a fainter outer band is drawn at about twice that width.
 */
export function createRacingLineMask(
  track: BuiltTrackData,
  opts: { size?: number; bandWidthM?: number } = {}
): RacingLineMask {
  const size = Math.max(64, Math.round(opts.size ?? 2048));
  const coreWidthM = opts.bandWidthM ?? 2.2;
  const key = `${size}:${coreWidthM}`;

  let perTrack = maskCache.get(track);
  if (!perTrack) {
    perTrack = new Map();
    maskCache.set(track, perTrack);
  }
  const cached = perTrack.get(key);
  if (cached) return cached;

  const pts = racingLinePoints(track);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  if (!pts.length || !Number.isFinite(minX)) {
    minX = minZ = -1;
    maxX = maxZ = 1;
  }

  // Square mask so one scale applies to both axes; centred on the track bounds
  const side = Math.max(maxX - minX, maxZ - minZ) + 2 * MASK_MARGIN_M;
  const originX = (minX + maxX) / 2 - side / 2;
  const originZ = (minZ + maxZ) / 2 - side / 2;
  const worldMin = new THREE.Vector2(originX, originZ);
  const worldSize = new THREE.Vector2(side, side);

  let texture: THREE.Texture;
  if (typeof document === "undefined") {
    // No canvas (server or headless): an empty mask, so the sheen simply does nothing
    texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    texture.needsUpdate = true;
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const scale = size / side;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, size, size);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const strokeLine = () => {
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const x = (pts[i].x - originX) * scale;
          const y = (pts[i].z - originZ) * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      };

      // Outer faint band, mid band, bright core: stacked strokes give a soft falloff without ctx.filter
      // (not supported on every browser). Values accumulate towards the core.
      const bands: Array<[widthM: number, alpha: number]> = [
        [coreWidthM * 2.05, 0.28],
        [coreWidthM * 1.4, 0.5],
        [coreWidthM, 0.9],
      ];
      for (const [widthM, alpha] of bands) {
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
        ctx.lineWidth = widthM * scale;
        strokeLine();
      }
    }
    const canvasTex = new THREE.CanvasTexture(canvas);
    canvasTex.flipY = false;
    canvasTex.colorSpace = THREE.NoColorSpace;
    canvasTex.generateMipmaps = true;
    canvasTex.minFilter = THREE.LinearMipmapLinearFilter;
    canvasTex.magFilter = THREE.LinearFilter;
    canvasTex.anisotropy = 4;
    texture = canvasTex;
  }

  const mask: RacingLineMask = { texture, worldMin, worldSize };
  perTrack.set(key, mask);
  return mask;
}

/**
 * Patches a MeshStandardMaterial in place: rubber-dependent roughness (0.78 -> 0.32) and darkening (x0.85),
 * plus a world-space aggregate normal bump (3 cm + 12 cm value noise, faded by pixel footprint and distance).
 * Rain (`setAsphaltWetness`) darkens the asphalt and drops its roughness towards a wet gloss, patchy at metre scale.
 * Idempotent per material: calling it again simply replaces the earlier patch.
 */
export function applyAsphaltSheen(material: THREE.MeshStandardMaterial, mask: RacingLineMask): void {
  const uniforms = {
    uRubberMask: { value: mask.texture },
    uMaskMin: { value: mask.worldMin },
    uMaskSize: { value: mask.worldSize },
    uAggregateNormalScale: { value: AGGREGATE_NORMAL_SCALE },
    ...wetUniforms,
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchShader(shader.vertexShader, VERTEX_PATCHES, "asphalt");
    shader.fragmentShader = patchShader(shader.fragmentShader, FRAGMENT_PATCHES, "asphalt");
  };
  material.customProgramCacheKey = () => "asphalt-sheen-v3";
  material.needsUpdate = true;
}

type Patch = ShaderPatch;

const VERTEX_PATCHES: readonly Patch[] = [
  ["#include <common>", "#include <common>\nvarying vec3 vLc26WorldPos;"],
  [
    "#include <begin_vertex>",
    "#include <begin_vertex>\nvLc26WorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;",
  ],
];

// Unnormalised-sigma bump (three's perturbNormalArb normalises the screen derivatives, which loses the metric
// scale; here dH and dP are both metres per pixel, so the slope is a true world-space gradient).
/** World-space noise helpers shared by the asphalt sheen and the scenery detail (no uniforms or varyings) */
export const WORLD_NOISE_GLSL = /* glsl */ `
float lc26Hash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

// Value noise in [-1, 1]
float lc26ValueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = lc26Hash( i );
	float b = lc26Hash( i + vec2( 1.0, 0.0 ) );
	float c = lc26Hash( i + vec2( 0.0, 1.0 ) );
	float d = lc26Hash( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 2.0 - 1.0;
}

// Animated concentric raindrop splash ripple height in world XZ
float lc26RainSplash( vec2 worldXZ, float time, float intensity ) {
	vec2 cell = floor( worldXZ * 2.8 );
	vec2 local = fract( worldXZ * 2.8 ) - 0.5;
	float h = lc26Hash( cell );
	float phase = fract( time * ( 1.6 + 0.8 * h ) + h * 6.28318 );
	vec2 center = ( vec2( lc26Hash( cell + 7.1 ), lc26Hash( cell + 19.3 ) ) - 0.5 ) * 0.45;
	float dist = length( local - center );
	float radius = phase * 0.42;
	float ring = exp( -90.0 * ( dist - radius ) * ( dist - radius ) ) * sin( ( dist - radius ) * 55.0 );
	float envelope = ( 1.0 - phase ) * smoothstep( 0.0, 0.08, phase );
	return ring * envelope * intensity;
}

vec3 lc26PerturbNormal( vec3 eyePos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
	vec3 dPdx = dFdx( eyePos );
	vec3 dPdy = dFdy( eyePos );
	vec3 R1 = cross( dPdy, surfNorm );
	vec3 R2 = cross( surfNorm, dPdx );
	float det = dot( dPdx, R1 ) * faceDir;
	vec3 grad = sign( det ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
	vec3 bumped = abs( det ) * surfNorm - grad;
	// Where the screen derivatives give no area (det 0, as the reflection probe's small faces can on Sachsenring's
	// trackside objects) the bump is nothing, and normalize( 0 ) would be NaN: one such texel, prefiltered, turned
	// the cars' whole reflection map NaN and bloom spread it into black blocks over the car
	return dot( bumped, bumped ) > 0.0 ? normalize( bumped ) : surfNorm;
}
`;

const FRAGMENT_HELPERS_GLSL = /* glsl */ `
uniform sampler2D uRubberMask;
uniform vec2 uMaskMin;
uniform vec2 uMaskSize;
uniform float uAggregateNormalScale;
uniform float uWetness;
uniform float uLineWetness;
uniform float uRainIntensity;
uniform float uWetTime;
varying vec3 vLc26WorldPos;
${WORLD_NOISE_GLSL}`;

const FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\n" + FRAGMENT_HELPERS_GLSL],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
float lc26Rubber = texture2D( uRubberMask, ( vLc26WorldPos.xz - uMaskMin ) / uMaskSize ).r;
float roughnessFactor = mix( 0.78, 0.32, lc26Rubber );
#ifdef USE_ROUGHNESSMAP
	// The map's variation only nudges the result
	roughnessFactor *= mix( 1.0, texture2D( roughnessMap, vRoughnessMapUv ).g, 0.35 );
#endif
diffuseColor.rgb *= mix( 1.0, 0.85, lc26Rubber );
// Rain: water fills the macro-texture pores (WetAlbedoReduction = 0.25 base + puddle/groove darkening),
// standing water puddles flatten roughness to mirror gloss, and grazing view angles boost Fresnel reflection.
float lc26WetRaw = mix( uWetness, uLineWetness, lc26Rubber );
float lc26PuddleMask = 0.0;
if ( lc26WetRaw > 0.0 ) {
	float lc26PatchNoise = lc26ValueNoise( vLc26WorldPos.xz / 2.2 ) * 0.5 + 0.5;
	float lc26FinePatch = lc26ValueNoise( vLc26WorldPos.xz / 0.65 ) * 0.5 + 0.5;
	float lc26Wet = lc26WetRaw * mix( 0.72, 1.08, 0.7 * lc26PatchNoise + 0.3 * lc26FinePatch );
	lc26Wet = clamp( lc26Wet, 0.0, 1.0 );
	// Standing water puddles pool in low-frequency depressions off the crowned racing line
	lc26PuddleMask = smoothstep( 0.52, 0.86, lc26Wet * ( 1.0 - 0.35 * lc26Rubber ) * ( 0.65 + 0.35 * lc26PatchNoise ) );
	// WetAlbedoReduction: 25% base porosity darkening + extra darkening in rubbered groove & standing puddles
	float lc26AlbedoReduction = 0.25 * smoothstep( 0.0, 0.35, lc26Wet ) + 0.18 * lc26Wet + 0.08 * lc26PuddleMask;
	diffuseColor.rgb *= 1.0 - lc26AlbedoReduction;
	// Grazing-angle wet Fresnel specular boost
	vec3 lc26ViewDir = normalize( vViewPosition );
	float lc26NdotV = clamp( abs( lc26ViewDir.y ), 0.0, 1.0 );
	float lc26WetFresnel = pow( 1.0 - lc26NdotV, 3.0 ) * lc26Wet;
	float lc26WetRough = mix( 0.14, 0.025, lc26PuddleMask );
	roughnessFactor = mix( roughnessFactor, lc26WetRough, clamp( lc26Wet + 0.35 * lc26WetFresnel, 0.0, 1.0 ) );
}
`,
	],
	[
		"#include <normal_fragment_maps>",
		/* glsl */ `
#include <normal_fragment_maps>
vec2 lc26AggP = vLc26WorldPos.xz;
// Amplitude 8 mm: about 3 to 4 degrees of tilt once the 0.3 gradient scale is applied; submerged in puddles
float lc26AggH = 0.008 * ( 0.6 * lc26ValueNoise( lc26AggP / 0.03 ) + 0.4 * lc26ValueNoise( lc26AggP / 0.12 ) );
lc26AggH *= mix( 1.0, 0.12, lc26PuddleMask );
if ( uRainIntensity > 0.02 && lc26WetRaw > 0.15 ) {
	float lc26SplashFade = ( 1.0 - smoothstep( 12.0, 42.0, length( vViewPosition ) ) ) * clamp( lc26WetRaw, 0.0, 1.0 );
	lc26AggH += 0.0035 * lc26RainSplash( lc26AggP, uWetTime, uRainIntensity ) * lc26SplashFade;
}
float lc26AggAa = 1.0 - smoothstep( 0.25, 0.5, max( fwidth( lc26AggP.x ), fwidth( lc26AggP.y ) ) / 0.03 );
float lc26AggFade = lc26AggAa * ( 1.0 - smoothstep( 30.0, 90.0, length( vViewPosition ) ) );
vec2 lc26AggGrad = vec2( dFdx( lc26AggH ), dFdy( lc26AggH ) ) * uAggregateNormalScale * lc26AggFade;
normal = lc26PerturbNormal( -vViewPosition, normal, lc26AggGrad, faceDirection );
`,
	],
];
