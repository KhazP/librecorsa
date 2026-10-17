import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { aiLineOffsetM } from "@/lib/sim/speed-profile";

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
 * Idempotent per material: calling it again simply replaces the earlier patch.
 */
export function applyAsphaltSheen(material: THREE.MeshStandardMaterial, mask: RacingLineMask): void {
  const uniforms = {
    uRubberMask: { value: mask.texture },
    uMaskMin: { value: mask.worldMin },
    uMaskSize: { value: mask.worldSize },
    uAggregateNormalScale: { value: AGGREGATE_NORMAL_SCALE },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patch(shader.vertexShader, VERTEX_PATCHES, "asphalt");
    shader.fragmentShader = patch(shader.fragmentShader, FRAGMENT_PATCHES, "asphalt");
  };
  material.customProgramCacheKey = () => "asphalt-sheen-v1";
  material.needsUpdate = true;
}

type Patch = readonly [anchor: string, replacement: string];

function patch(source: string, patches: readonly Patch[], label: string): string {
  let out = source;
  for (const [anchor, replacement] of patches) {
    const parts = out.split(anchor);
    if (parts.length !== 2) {
      console.warn(`[asphalt-sheen] ${label}: anchor "${anchor}" found ${parts.length - 1} times, skipped`);
      continue;
    }
    out = parts[0] + replacement + parts[1];
  }
  return out;
}

const VERTEX_PATCHES: readonly Patch[] = [
  ["#include <common>", "#include <common>\nvarying vec3 vVf26WorldPos;"],
  [
    "#include <begin_vertex>",
    "#include <begin_vertex>\nvVf26WorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;",
  ],
];

// Unnormalised-sigma bump (three's perturbNormalArb normalises the screen derivatives, which loses the metric
// scale; here dH and dP are both metres per pixel, so the slope is a true world-space gradient).
const FRAGMENT_HELPERS_GLSL = /* glsl */ `
uniform sampler2D uRubberMask;
uniform vec2 uMaskMin;
uniform vec2 uMaskSize;
uniform float uAggregateNormalScale;
varying vec3 vVf26WorldPos;

float vf26Hash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}

// Value noise in [-1, 1]
float vf26ValueNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	float a = vf26Hash( i );
	float b = vf26Hash( i + vec2( 1.0, 0.0 ) );
	float c = vf26Hash( i + vec2( 0.0, 1.0 ) );
	float d = vf26Hash( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y ) * 2.0 - 1.0;
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

const FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\n" + FRAGMENT_HELPERS_GLSL],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
float vf26Rubber = texture2D( uRubberMask, ( vVf26WorldPos.xz - uMaskMin ) / uMaskSize ).r;
float roughnessFactor = mix( 0.78, 0.32, vf26Rubber );
#ifdef USE_ROUGHNESSMAP
	// The map's variation only nudges the result
	roughnessFactor *= mix( 1.0, texture2D( roughnessMap, vRoughnessMapUv ).g, 0.35 );
#endif
diffuseColor.rgb *= mix( 1.0, 0.85, vf26Rubber );
`,
	],
	[
		"#include <normal_fragment_maps>",
		/* glsl */ `
#include <normal_fragment_maps>
vec2 vf26AggP = vVf26WorldPos.xz;
// Amplitude 8 mm: about 3 to 4 degrees of tilt once the 0.3 gradient scale is applied
float vf26AggH = 0.008 * ( 0.6 * vf26ValueNoise( vf26AggP / 0.03 ) + 0.4 * vf26ValueNoise( vf26AggP / 0.12 ) );
float vf26AggAa = 1.0 - smoothstep( 0.25, 0.5, max( fwidth( vf26AggP.x ), fwidth( vf26AggP.y ) ) / 0.03 );
float vf26AggFade = vf26AggAa * ( 1.0 - smoothstep( 30.0, 90.0, length( vViewPosition ) ) );
vec2 vf26AggGrad = vec2( dFdx( vf26AggH ), dFdy( vf26AggH ) ) * uAggregateNormalScale * vf26AggFade;
normal = vf26PerturbNormal( -vViewPosition, normal, vf26AggGrad, faceDirection );
`,
	],
];
