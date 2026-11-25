import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import type { TrackSamplePoint } from "@/types/f1";
import { aiLineOffsetM } from "@/lib/sim/speed-profile";
import { topographicalPuddleFactor } from "@/lib/sim/weather";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { WET_LAMP_SLOTS, wetLampUniforms } from "./wet-road-lamps";

/**
 * Rubbered-in racing line on the asphalt: a top-down world-XZ mask (white = rubber) drives roughness, a slight
 * darkening and a world-space aggregate normal bump. The mask is painted once per track on a 2D canvas, so the
 * per-fragment cost is one texture fetch plus a few cheap value-noise taps.
 *
 * Rain (setAsphaltWetness, setAsphaltStandingWater, setWetRoadProbe): water in the asphalt's pores darkens it; a film
 * of water then smooths it towards a gloss; standing water collects where the circuit's own water model pools it
 * (the mask's green channel) and turns to a near mirror with raindrop rings; and the wet road reflects the world round
 * the player's car (the cars' reflection probe) instead of the sky alone, with the lamps near the camera drawn out
 * into streaks on it (wet-road-lamps.ts). Dry, none of it runs.
 */

export interface RacingLineMask {
  /**
   * Red channel = rubber amount 0..1; green = how readily water stands there (puddleReliefAt), 0 off the road.
   * Canvas row 0 is the minimum Z edge (flipY is off).
   */
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
/**
 * Dry asphalt roughness off the racing line, a floor under the material's own value. The aggregate bump fades out
 * a few metres from the camera, so past that the road is one flat normal and this number alone sets its sheen.
 */
const DRY_ROUGHNESS = 0.86;
/**
 * Roughness on the rubbered-in line. It was 0.32: driving into a low sun, the line's GGX highlight came out tens of
 * times over the bloom threshold, a white streak down the road. 0.6 keeps a bright sheen into the sun.
 */
const RUBBER_ROUGHNESS = 0.6;

/**
 * Standing water (mm, the weather's `waterMm`) at which the deepest hollows start to hold a puddle, and at which the
 * puddles stand at their fullest. Light rain (about 0.7 mm) leaves a few in the gutters; heavy rain (2.4 mm) floods
 * every hollow the circuit's water model finds; the drying preset (0.9 mm, half of it off the line) keeps some.
 */
export const PUDDLE_START_MM = 0.35;
export const PUDDLE_FULL_MM = 2.4;

/** 0..1: how high standing water stands, from the weather's water depth (mm) */
export function standingWaterLevel(waterMm: number): number {
  if (!(waterMm > PUDDLE_START_MM)) return 0;
  return Math.min(1, (waterMm - PUDDLE_START_MM) / (PUDDLE_FULL_MM - PUDDLE_START_MM));
}

/**
 * How readily water stands at `latM` across the road at sample `s` (0 sheds it .. 1 pools it): the physics' own depth
 * factor (weather.ts topographicalPuddleFactor, which the tyres' aquaplaning reads), rescaled from its 0.55..1.55. So
 * the puddles show where the wheels find deeper water: the low side of a camber, the gutters along the kerbs, the
 * flat basins, and not on steep climbs or the high side of a banking.
 */
export function puddleReliefAt(s: TrackSamplePoint, latM: number): number {
  const f = topographicalPuddleFactor(s.s, latM, (s.bankingRad ?? 0) * (180 / Math.PI), (s.slopeSin ?? 0) * 100, (s.width ?? 15) * 0.5);
  return Math.min(1, Math.max(0, f - 0.55));
}

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
/** Standing water off the line and on it (standingWaterLevel), asphalt only */
const waterUniforms = {
  uWaterLevel: { value: 0 },
  uLineWaterLevel: { value: 0 },
};
/**
 * The world round the player's car, filmed by the cars' reflection probe (car-reflection-probe.ts), for the wet road
 * to reflect: its prefiltered cube map, where it was filmed from, its last mip level and its strength. With no probe
 * (Low, or before its first full turn) the wet road keeps the sky's environment map.
 */
const probeUniforms = {
  uWetProbe: { value: null as THREE.Texture | null },
  uWetProbeOn: { value: 0 },
  uWetProbePos: { value: new THREE.Vector3() },
  uWetProbeLod: { value: 5 },
  uWetProbeIntensity: { value: 1 },
  uWetSkyDim: { value: 1 },
};
/** Shared across every patched asphalt material: 0 on Low skips aggregate noise + derivative normal bump */
const qualityUniform = {
  uAsphaltDetail: { value: 1 },
};
/** The same uniform objects, for other surfaces that get wet with the track (scenery-detail) */
export const sharedWetUniforms: Readonly<typeof wetUniforms> = wetUniforms;

/**
 * Turns the asphalt's aggregate value-noise bump off on Low (saving two procedural noise evaluations,
 * screen-space derivatives and normal perturbation per road pixel) while keeping the rubbered racing line
 * and wetness intact. The raindrop rings go with it.
 */
export function setAsphaltQuality(quality: "low" | "medium" | "high"): void {
  qualityUniform.uAsphaltDetail.value = quality === "low" ? 0 : 1;
}

/**
 * Wet look of the track surface (0 dry … 1 soaked): darker, glossier asphalt with grazing-angle reflections, and
 * animated raindrop rings when raining.
 */
export function setAsphaltWetness(offLine: number, onLine: number = offLine, rainIntensity: number = 0): void {
  wetUniforms.uWetness.value = Math.min(1, Math.max(0, offLine));
  wetUniforms.uLineWetness.value = Math.min(1, Math.max(0, onLine));
  wetUniforms.uRainIntensity.value = Math.min(1, Math.max(0, rainIntensity));
}

/** Standing water on the asphalt from the weather's water depth (mm), off the racing line and on it */
export function setAsphaltStandingWater(offLineMm: number, onLineMm: number = offLineMm): void {
  waterUniforms.uWaterLevel.value = standingWaterLevel(offLineMm);
  waterUniforms.uLineWaterLevel.value = standingWaterLevel(onLineMm);
}

/**
 * The reflection probe's map for the wet road (null: none, the sky's environment map is reflected), the point it was
 * filmed from and its strength (the scene's environment intensity, as the cars take it). Cheap: call every frame.
 *
 * `skyDim` scales the sky's environment map where the wet road reflects it instead (no probe). The physical sky's
 * bake has no clouds: under a rain deck it is several times brighter than the sky on screen (the probe films the
 * visible sky, and matches it), and a wet road mirroring it shone white, brighter than the sky above it.
 */
export function setWetRoadProbe(texture: THREE.Texture | null, position: THREE.Vector3, intensity: number, skyDim = 1): void {
  const u = probeUniforms;
  u.uWetProbe.value = texture;
  u.uWetProbeOn.value = texture ? 1 : 0;
  u.uWetSkyDim.value = Math.min(1, Math.max(0, skyDim));
  if (!texture) return;
  u.uWetProbePos.value.copy(position);
  u.uWetProbeIntensity.value = intensity;
  // A prefiltered (PMREM) cube carries its mip levels in `mipmaps`; the last one is the roughest
  u.uWetProbeLod.value = Math.max(0, (texture.mipmaps?.length ?? 1) - 1);
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

/** Strips across the road (and a metre past each edge, the gutters) the puddle relief is painted in */
const RELIEF_STRIPS = 24;
/** Past the asphalt's edge, the gutter along the kerb (m) */
const RELIEF_EDGE_M = 1.2;
/** Along the road, a strip is painted every this many metres (the relief changes over tens of metres) */
const RELIEF_STEP_M = 3;

/**
 * Paints puddleReliefAt over the road into the mask's green channel: on a canvas of its own (opaque quads, each
 * overlapping the next, so no seams), then added onto the mask, where only the green channel takes it.
 */
function paintPuddleRelief(
  ctx: CanvasRenderingContext2D,
  samples: readonly TrackSamplePoint[],
  originX: number,
  originZ: number,
  scale: number,
  size: number
): void {
  const n = samples.length;
  if (n < 2) return;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const pc = canvas.getContext("2d");
  if (!pc) return;
  pc.fillStyle = "#000";
  pc.fillRect(0, 0, size, size);
  // Samples about RELIEF_STEP_M apart, closing the loop
  const picked: TrackSamplePoint[] = [samples[0]];
  for (let i = 1; i < n; i++) if (samples[i].s - picked[picked.length - 1].s >= RELIEF_STEP_M) picked.push(samples[i]);
  const px = (x: number) => (x - originX) * scale;
  const pz = (z: number) => (z - originZ) * scale;
  // A quad's overlap with the next, so anti-aliased edges never leave a dark seam (m)
  const overlapM = 1.2 / scale;
  for (let i = 0; i < picked.length; i++) {
    const a = picked[i];
    const b = picked[(i + 1) % picked.length];
    const ha = a.width * 0.5 + RELIEF_EDGE_M;
    const hb = b.width * 0.5 + RELIEF_EDGE_M;
    const tx = b.position.x - a.position.x;
    const tz = b.position.z - a.position.z;
    const len = Math.hypot(tx, tz);
    // A long jump (the loop's seam on a point-to-point road) is not painted across
    if (!(len > 0) || len > 8 * RELIEF_STEP_M) continue;
    const ox = (tx / len) * overlapM;
    const oz = (tz / len) * overlapM;
    for (let j = 0; j < RELIEF_STRIPS; j++) {
      const u0 = -1 + (2 * j) / RELIEF_STRIPS;
      const u1 = -1 + (2 * (j + 1)) / RELIEF_STRIPS;
      const v = puddleReliefAt(a, ((u0 + u1) / 2) * ha);
      if (v <= 0) continue;
      const e = 0.35 * (u1 - u0);
      const la0 = (u0 - e) * ha;
      const la1 = (u1 + e) * ha;
      const lb0 = (u0 - e) * hb;
      const lb1 = (u1 + e) * hb;
      pc.fillStyle = `rgb(0,${Math.round(v * 255)},0)`;
      pc.beginPath();
      pc.moveTo(px(a.position.x + a.binormal.x * la0), pz(a.position.z + a.binormal.z * la0));
      pc.lineTo(px(b.position.x + b.binormal.x * lb0 + ox), pz(b.position.z + b.binormal.z * lb0 + oz));
      pc.lineTo(px(b.position.x + b.binormal.x * lb1 + ox), pz(b.position.z + b.binormal.z * lb1 + oz));
      pc.lineTo(px(a.position.x + a.binormal.x * la1), pz(a.position.z + a.binormal.z * la1));
      pc.closePath();
      pc.fill();
    }
  }
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

/**
 * Paints the rubbered-in line into a square canvas (red) and where water stands (green). Cached per track object and
 * option set. `bandWidthM` is the core width (default 2.2 m); a fainter outer band is drawn at about twice that width.
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
      // (not supported on every browser). Values accumulate towards the core. Red only: green holds the water
      const bands: Array<[widthM: number, alpha: number]> = [
        [coreWidthM * 2.05, 0.28],
        [coreWidthM * 1.4, 0.5],
        [coreWidthM, 0.9],
      ];
      for (const [widthM, alpha] of bands) {
        ctx.strokeStyle = `rgba(255,0,0,${alpha})`;
        ctx.lineWidth = widthM * scale;
        strokeLine();
      }
      paintPuddleRelief(ctx, track.samples, originX, originZ, scale, size);
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
 * Patches a MeshStandardMaterial in place: rubber-dependent roughness (at least 0.86 -> 0.6) and darkening (x0.85),
 * plus a world-space aggregate normal bump (3 cm + 12 cm value noise, faded by pixel footprint and distance).
 * Rain darkens the asphalt, glosses it, stands water in its hollows and reflects the world round the car in it.
 * Idempotent per material: calling it again simply replaces the earlier patch.
 */
export function applyAsphaltSheen(material: THREE.MeshStandardMaterial, mask: RacingLineMask): void {
  const uniforms = {
    uRubberMask: { value: mask.texture },
    uMaskMin: { value: mask.worldMin },
    uMaskSize: { value: mask.worldSize },
    uAggregateNormalScale: { value: AGGREGATE_NORMAL_SCALE },
    ...qualityUniform,
    ...wetUniforms,
    ...waterUniforms,
    ...probeUniforms,
    ...wetLampUniforms,
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchShader(shader.vertexShader, VERTEX_PATCHES, "asphalt");
    shader.fragmentShader = patchShader(shader.fragmentShader, FRAGMENT_PATCHES, "asphalt");
  };
  material.customProgramCacheKey = () => "asphalt-sheen-v6";
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

/**
 * Raindrop rings on water, as a slope (dh/dx, dh/dz) in world XZ, worked out exactly rather than from screen
 * derivatives (which a 2 x 2 pixel block takes for the whole ring). One layer: a drop per cell per cycle at a new
 * place each cycle, fewer in lighter rain; the ring runs out to RING_R m with a wave WAVE_M m wide and dies away.
 */
const RIPPLE_GLSL = /* glsl */ `
vec2 lc26RippleLayer( vec2 p, float cellM, float rate, float t, float intensity, float seed ) {
	vec2 q = p / cellM + seed;
	vec2 cell = floor( q );
	float h = lc26Hash( cell + seed );
	float cyc = t * rate + h;
	float n = floor( cyc );
	float ph = cyc - n;
	if ( lc26Hash( cell + vec2( n * 0.731, seed ) ) > intensity ) return vec2( 0.0 );
	// The drop lands well inside its cell, so its ring never reaches the cell's edge
	vec2 c = 0.35 + 0.3 * vec2( lc26Hash( cell + vec2( n * 1.37, 3.1 ) ), lc26Hash( cell + vec2( 7.7, n * 2.11 ) ) );
	vec2 d = ( fract( q ) - c ) * cellM;
	float r = length( d );
	float x = ( r - ph * 0.16 ) / 0.024;
	if ( abs( x ) > 2.6 ) return vec2( 0.0 );
	float e = exp( -x * x );
	float env = ( 1.0 - ph ) * ( 1.0 - ph ) * smoothstep( 0.0, 0.06, ph );
	// h = A sin( pi x ) e^( -x^2 ): its slope along the radius, A / w = 0.06
	float dhdr = 0.06 * ( 3.14159 * cos( 3.14159 * x ) - 2.0 * x * sin( 3.14159 * x ) ) * e * env;
	return dhdr * d / max( r, 1e-4 );
}

vec2 lc26Ripples( vec2 p, float t, float intensity ) {
	return lc26RippleLayer( p, 0.7, 1.25, t, intensity, 0.0 ) + lc26RippleLayer( p, 0.53, 1.6, t, intensity, 17.3 );
}
`;

const FRAGMENT_HELPERS_GLSL = /* glsl */ `
uniform sampler2D uRubberMask;
uniform vec2 uMaskMin;
uniform vec2 uMaskSize;
uniform float uAggregateNormalScale;
uniform float uAsphaltDetail;
uniform float uWetness;
uniform float uLineWetness;
uniform float uRainIntensity;
uniform float uWetTime;
uniform float uWaterLevel;
uniform float uLineWaterLevel;
uniform samplerCube uWetProbe;
uniform float uWetProbeOn;
uniform vec3 uWetProbePos;
uniform float uWetProbeLod;
uniform float uWetProbeIntensity;
uniform float uWetSkyDim;
uniform vec4 uWetLampPos[ ${WET_LAMP_SLOTS} ];
uniform vec3 uWetLampColor[ ${WET_LAMP_SLOTS} ];
uniform vec4 uWetLampDir[ ${WET_LAMP_SLOTS} ];
uniform float uWetLampCount;
varying vec3 vLc26WorldPos;
${WORLD_NOISE_GLSL}
${RIPPLE_GLSL}`;

/** Albedo of soaked asphalt against dry: water in the pores takes the light the dry surface scattered back */
const WET_ALBEDO = 0.42;
/** Roughness of damp asphalt (pores full, a thin film), of a water film over it, and of standing water */
const DAMP_ROUGHNESS = 0.36;
const FILM_ROUGHNESS = 0.08;
const PUDDLE_ROUGHNESS = 0.03;
/** Sphere round the probe its view is projected onto for the wet road (m): about where the stands and walls are */
const WET_PROBE_RADIUS_M = 45;
/** A lamp's highlight on the wet road, this many times longer toward the viewer than across */
const STREAK_STRETCH = 5;

const FRAGMENT_PATCHES: readonly Patch[] = [
	["#include <common>", "#include <common>\n" + FRAGMENT_HELPERS_GLSL],
	[
		"#include <roughnessmap_fragment>",
		/* glsl */ `
vec4 lc26Mask = texture2D( uRubberMask, ( vLc26WorldPos.xz - uMaskMin ) / uMaskSize );
float lc26Rubber = lc26Mask.r;
float roughnessFactor = mix( max( roughness, ${DRY_ROUGHNESS.toFixed(2)} ), ${RUBBER_ROUGHNESS.toFixed(2)}, lc26Rubber );
#ifdef USE_ROUGHNESSMAP
	// The map's variation only nudges the result
	roughnessFactor *= mix( 1.0, texture2D( roughnessMap, vRoughnessMapUv ).g, 0.35 );
#endif
diffuseColor.rgb *= mix( 1.0, 0.85, lc26Rubber );
// Rain, in three stages of water: in the pores (darker, still rough), a film over the stones (smoother), and standing
// water where the level tops the road's hollows (a near mirror). The line, swept by the cars, has its own water.
float lc26WetRaw = mix( uWetness, uLineWetness, lc26Rubber );
float lc26Wet = 0.0;
float lc26Mirror = 0.0;
float lc26Film = 0.0;
float lc26PuddleMask = 0.0;
if ( lc26WetRaw > 0.0 ) {
	float lc26Broad = lc26ValueNoise( vLc26WorldPos.xz / 9.0 );
	float lc26Fine = uAsphaltDetail > 0.5 ? lc26ValueNoise( vLc26WorldPos.xz / 2.3 ) : 0.0;
	// A damp road dries unevenly; a soaked one is evenly wet
	lc26Wet = clamp( lc26WetRaw * ( 1.0 + ( 0.22 * lc26Broad + 0.08 * lc26Fine ) * ( 1.0 - lc26WetRaw ) ), 0.0, 1.0 );
	float lc26Level = mix( uWaterLevel, uLineWaterLevel, lc26Rubber );
	lc26Film = smoothstep( 0.0, 0.55, lc26Level );
	// Where the water model pools it (green), broken into shorelines by the road's own unevenness
	float lc26Relief = lc26Mask.g + 0.16 * lc26Broad + 0.07 * lc26Fine;
	float lc26Shore = 1.05 - 0.45 * lc26Level;
	lc26PuddleMask = lc26Level > 0.0 ? smoothstep( lc26Shore, lc26Shore + 0.035, lc26Relief ) : 0.0;
	float lc26Soak = smoothstep( 0.0, 0.6, lc26Wet );
	// Water in the pores: much darker, and a little more saturated (less light scattered back out white)
	float lc26Luma = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
	diffuseColor.rgb = max( mix( vec3( lc26Luma ), diffuseColor.rgb, 1.0 + 0.3 * lc26Soak ), 0.0 );
	diffuseColor.rgb *= mix( 1.0, ${WET_ALBEDO.toFixed(2)}, lc26Soak ) * mix( 1.0, 0.8, lc26PuddleMask );
	// Rough when damp, smoother under a film, a mirror where water stands; rain impacts too small to draw roughen it
	float lc26Rain = uRainIntensity;
	float lc26WetRough = mix( roughnessFactor, ${DAMP_ROUGHNESS.toFixed(2)}, lc26Soak );
	lc26WetRough = mix( lc26WetRough, ${FILM_ROUGHNESS.toFixed(2)} + 0.05 * lc26Rain, lc26Film * lc26Soak );
	roughnessFactor = mix( lc26WetRough, ${PUDDLE_ROUGHNESS.toFixed(3)} + 0.035 * lc26Rain, lc26PuddleMask );
	// How much of the road's shine is the water's mirror (the probe's view, the lamps' streaks)
	lc26Mirror = smoothstep( 0.05, 0.6, lc26Wet );
}
`,
	],
	[
		"#include <normal_fragment_maps>",
		/* glsl */ `
#include <normal_fragment_maps>
// World metres per pixel, taken here for everything below (derivatives in a branch are undefined)
vec2 lc26Foot2 = fwidth( vLc26WorldPos.xz );
float lc26Foot = max( lc26Foot2.x, lc26Foot2.y );
if ( lc26WetRaw > 0.0 ) {
	// Water fills the texture: the normal map's detail drowns under a film and goes under standing water
	normal = normalize( mix( normal, nonPerturbedNormal, clamp( 0.9 * lc26PuddleMask + 0.45 * lc26Film * lc26Wet, 0.0, 1.0 ) ) );
}
if ( uAsphaltDetail > 0.5 ) {
	float lc26Dist = length( vViewPosition );
	if ( lc26Dist < 90.0 ) {
		vec2 lc26AggP = vLc26WorldPos.xz;
		// Amplitude 8 mm: about 3 to 4 degrees of tilt once the 0.3 gradient scale is applied; submerged in puddles
		float lc26AggH = 0.008 * ( 0.6 * lc26ValueNoise( lc26AggP / 0.03 ) + 0.4 * lc26ValueNoise( lc26AggP / 0.12 ) );
		lc26AggH *= mix( 1.0, 0.12, lc26PuddleMask ) * mix( 1.0, 0.4, lc26Film * lc26Wet );
		float lc26AggAa = 1.0 - smoothstep( 0.25, 0.5, lc26Foot / 0.03 );
		float lc26AggFade = lc26AggAa * ( 1.0 - smoothstep( 30.0, 90.0, lc26Dist ) );
		vec2 lc26AggGrad = vec2( dFdx( lc26AggH ), dFdy( lc26AggH ) ) * uAggregateNormalScale * lc26AggFade;
		normal = lc26PerturbNormal( -vViewPosition, normal, lc26AggGrad, faceDirection );
	}
	// Raindrop rings: on standing water above all, faintly on the film. Each ring's wave is about 5 cm, so they show
	// where a pixel is under about 2 cm of road and give way to the rain roughness further off
	float lc26RippleW = uRainIntensity * ( lc26PuddleMask + 0.4 * lc26Film * lc26Wet * ( 1.0 - lc26PuddleMask ) );
	float lc26RippleFade = 1.0 - smoothstep( 0.012, 0.03, lc26Foot );
	if ( lc26RippleW * lc26RippleFade > 0.01 ) {
		vec2 lc26Slope = lc26Ripples( vLc26WorldPos.xz, uWetTime, uRainIntensity ) * ( lc26RippleW * lc26RippleFade );
		normal = normalize( normal - mat3( viewMatrix ) * vec3( lc26Slope.x, 0.0, lc26Slope.y ) );
	}
}
`,
	],
	[
		"#include <lights_fragment_maps>",
		/* glsl */ `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	// The wet road reflects the world round the car (the probe's view) instead of the sky alone. A sphere round the
	// probe stands in for the stands and walls, so what this point reflects is looked up where its ray would meet them;
	// past it, the probe's view of the distance and the sky is everyone's. With no probe, the sky's map, dimmed to the
	// sky on screen
	if ( lc26Mirror > 0.0 && uWetProbeOn < 0.5 ) radiance *= mix( 1.0, uWetSkyDim, lc26Mirror );
	if ( lc26Mirror > 0.0 && uWetProbeOn > 0.5 ) {
		vec3 lc26V = normalize( cameraPosition - vLc26WorldPos );
		vec3 lc26N = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
		vec3 lc26R = reflect( -lc26V, lc26N );
		lc26R.y = max( lc26R.y, 0.0 );
		vec3 lc26P = vLc26WorldPos - uWetProbePos;
		float lc26B = dot( lc26P, lc26R );
		float lc26C = dot( lc26P, lc26P ) - ${(WET_PROBE_RADIUS_M * WET_PROBE_RADIUS_M).toFixed(1)};
		vec3 lc26Dir = lc26C < 0.0 ? lc26P + ( sqrt( lc26B * lc26B - lc26C ) - lc26B ) * lc26R : lc26R;
		float lc26Rgh = material.roughness;
		lc26Dir = mix( normalize( lc26Dir ), lc26N, lc26Rgh * lc26Rgh * lc26Rgh * lc26Rgh );
		vec3 lc26Probe = textureLod( uWetProbe, lc26Dir, uWetProbeLod * lc26Rgh * ( 2.0 - lc26Rgh ) ).rgb * uWetProbeIntensity;
		radiance = mix( radiance, lc26Probe, lc26Mirror );
	}
#endif
`,
	],
	[
		"#include <lights_fragment_end>",
		/* glsl */ `
#if defined( RE_IndirectSpecular )
	// Lamps in the wet road: a glossy highlight per lamp, stretched along the view (a grazing wet road draws a lamp out
	// into a streak toward the viewer), widened and dimmed by the lamp's size as a sphere light's is, with water's
	// Fresnel. Dry pixels, or no lamps, skip it all
	if ( lc26Mirror > 0.0 && uWetLampCount > 0.5 ) {
		vec3 lc26LV = normalize( cameraPosition - vLc26WorldPos );
		vec3 lc26LN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
		float lc26NV = max( dot( lc26LN, lc26LV ), 0.08 );
		vec3 lc26T = lc26LV - lc26LN * dot( lc26LV, lc26LN );
		lc26T = dot( lc26T, lc26T ) > 1e-8 ? normalize( lc26T ) : vec3( 1.0, 0.0, 0.0 );
		vec3 lc26Bt = cross( lc26LN, lc26T );
		float lc26A = max( material.roughness * material.roughness, 0.002 );
		vec3 lc26Glint = vec3( 0.0 );
		for ( int i = 0; i < ${WET_LAMP_SLOTS}; i ++ ) {
			if ( float( i ) >= uWetLampCount ) break;
			vec3 lc26L = uWetLampPos[ i ].xyz - vLc26WorldPos;
			float lc26D2 = max( dot( lc26L, lc26L ), 0.04 );
			float lc26D = sqrt( lc26D2 );
			lc26L /= lc26D;
			if ( dot( lc26LN, lc26L ) <= 0.0 ) continue;
			// a headlight lights only inside its cone
			vec4 lc26Beam = uWetLampDir[ i ];
			float lc26Cone = lc26Beam.w < -1.5 ? 1.0 : smoothstep( lc26Beam.w, mix( lc26Beam.w, 1.0, 0.5 ), dot( -lc26L, lc26Beam.xyz ) );
			if ( lc26Cone <= 0.0 ) continue;
			float lc26Ax = min( 1.0, lc26A + 0.5 * uWetLampPos[ i ].w / lc26D );
			float lc26Ay = min( 1.0, lc26Ax * ${STREAK_STRETCH.toFixed(1)} );
			vec3 lc26H = normalize( lc26L + lc26LV );
			float lc26Ht = dot( lc26H, lc26T ) / lc26Ay;
			float lc26Hb = dot( lc26H, lc26Bt ) / lc26Ax;
			float lc26Hn = dot( lc26H, lc26LN );
			float lc26Den = lc26Ht * lc26Ht + lc26Hb * lc26Hb + lc26Hn * lc26Hn;
			float lc26Dg = 1.0 / ( PI * lc26Ax * lc26Ay * lc26Den * lc26Den );
			float lc26Fr = 0.02 + 0.98 * pow( 1.0 - clamp( dot( lc26LV, lc26H ), 0.0, 1.0 ), 5.0 );
			lc26Glint += uWetLampColor[ i ] * ( lc26Cone * lc26Dg * lc26Fr / ( 4.0 * lc26NV * lc26D2 ) );
		}
		reflectedLight.directSpecular += lc26Glint * lc26Mirror;
	}
#endif
#include <lights_fragment_end>
`,
	],
];
