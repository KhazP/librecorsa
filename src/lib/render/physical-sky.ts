import * as THREE from "three";
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, SkyMaterial } from "@takram/three-atmosphere";
import { CloudShape, CloudShapeDetail, CloudsEffect, LocalWeather, Turbulence } from "@takram/three-clouds";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { AZIMUTH_OFFSET_DEG, LATITUDE_DEG } from "@/lib/sim/weather";
import { withBasePath } from "@/lib/base-path";
import { isTouchDevice } from "@/lib/input/touch-input";
import { patchShader, type ShaderPatch } from "./shader-patch";
import { cloudSkyFor, describeClouds, pickCloudRecipe, type CloudRecipe, type CloudSkySetup } from "./cloud-recipes";
import { NIGHT_CLOUD_GLOW, nightShareOfElevation, nightSkyGlsl, starShare } from "./night-sky";

/*
 * Physically based sky and volumetric clouds (@takram/three-atmosphere and @takram/three-clouds, MIT): the sky on
 * the Medium and High graphics presets. Low keeps the classic three.js Sky, and so does `?sky=classic`.
 *
 * What it takes from the sim
 *   The sun direction stays the weather model's (src/lib/sim/weather.ts): every circuit shares one near-equatorial
 *   sky, and the lighting curves in golden-hour-environment.ts key off its elevation. The scene is anchored on the
 *   globe at the weather model's latitude, with compass north where weather.ts puts it, so the scene-frame sun
 *   vector maps straight into the Earth-centred frame the atmosphere works in.
 *
 * Fitting it into this renderer
 *   - Reversed depth: the library's WebGL shaders assume a standard depth buffer (far plane at 1). The sky quad is
 *     pinned to the far plane at 0 instead, and the clouds' scene-depth read is converted (sky test and view z).
 *   - Exposure: the library is tuned for exposure ~10; this scene runs at ~1.15. The sky and the clouds are scaled
 *     by the same SKY_RADIANCE_SCALE, and the visible sun disc is capped like the classic sky's.
 *   - Volumetric clouds run wherever this sky shows: High uses the library's "medium" preset, Medium its "low", and
 *     phones and tablets "low" at half resolution. The environment bake and the reflection probe have no clouds, so
 *     an overcast veil greys their sky with the weather's cloud cover.
 *   - Which clouds show comes from a seed per session (cloud-recipes.ts): the cloud types, their heights and where
 *     the pattern starts. The caller picks the seed; they drift with the session's wind, faster aloft.
 *   - The clouds' noise volumes are generated on the GPU and their ray-march jitter is our own blue noise
 *     (scripts/generate-blue-noise.ts): nothing is fetched from outside the game.
 */

/** Brings the atmosphere's luminance to this scene's exposure (the library's own examples run at exposure ~10) */
const SKY_RADIANCE_SCALE = 6.5;
/** Linear radiance cap of the visible sky; only the sun disc reaches it (bloom threshold is 1.1) */
const SKY_MAX_RADIANCE = 30;
/** Longitude of the globe anchor (deg). Only the latitude shapes the sky; this one sits by Kigali */
const ANCHOR_LONGITUDE_DEG = 30.1;
/** Albedo of the ground below the horizon (linear sRGB), the classic bake's stand-in tarmac and grass */
const GROUND_ALBEDO = new THREE.Color(0x3a3833);
const OVERCAST_TINT = new THREE.Color(0xd8dde2);
const BLUE_NOISE_URL = "/sky/blue-noise-128.bin";
const BLUE_NOISE_SIZE = 128;
/** Slices of the spatiotemporal noise volume the clouds cycle through, one per frame */
const BLUE_NOISE_DEPTH = 64;
/** Wind at cloud height against the session's near-ground wind */
const WIND_ALOFT_FACTOR = 2;
/** The clouds never stand quite still: the least drift (m/s), along the recipe's own heading in a calm */
const MIN_DRIFT_MS = 2.5;
/** Height (m) the drift speed is matched at: the cumulus and the deck */
const DRIFT_ALTITUDE_M = 1500;

export type SkyQuality = "low" | "medium" | "high";

export interface PhysicalSkyConditions {
  /** Unit vector from the scene towards the sun, scene frame (may point below the horizon) */
  sunDirection: THREE.Vector3;
  /** Cloud cover 0..1 */
  cloud: number;
  /** Rain intensity 0..1 */
  rain: number;
  /** Near-ground wind (m/s) along scene X and Z: the clouds drift with it, as the rain streaks do */
  windVxMs?: number;
  windVzMs?: number;
}

/**
 * The scene's frame on the globe: scene +Y is local up, compass north lies along the three.js Sky azimuth
 * AZIMUTH_OFFSET_DEG (x = sin θ, z = cos θ). Exported for scripts/verify-physical-sky.ts.
 */
export function sceneToECEFMatrix(result = new THREE.Matrix4()): THREE.Matrix4 {
  const anchor = new Geodetic(radians(ANCHOR_LONGITUDE_DEG), radians(LATITUDE_DEG), 0).toECEF();
  const enuToECEF = Ellipsoid.WGS84.getEastNorthUpFrame(anchor, new THREE.Matrix4());
  const theta = THREE.MathUtils.degToRad(AZIMUTH_OFFSET_DEG);
  const north = new THREE.Vector3(Math.sin(theta), 0, Math.cos(theta));
  // Compass east is a quarter turn clockwise from north: azimuth θ - 90°
  const east = new THREE.Vector3(-Math.cos(theta), 0, Math.sin(theta));
  const up = new THREE.Vector3(0, 1, 0);
  // Rows east, north, up take a scene vector to (east, north, up) components
  const sceneToENU = new THREE.Matrix4().makeBasis(east, north, up).transpose();
  return result.multiplyMatrices(enuToECEF, sceneToENU);
}

/**
 * The clouds' weather-texture coordinate for a point on the globe (ECEF), as the clouds shader's getCubeSphereUv
 * computes it: the drift speed in m/s is turned into texture repeats per second through it
 */
export function cubeSphereUv(position: THREE.Vector3, out = new THREE.Vector2()): THREE.Vector2 {
  const len = position.length();
  const nx = position.x / len;
  const ny = position.y / len;
  const nz = position.z / len;
  const fx = Math.abs(nx);
  const fy = Math.abs(ny);
  const fz = Math.abs(nz);
  let mx: number;
  let my: number;
  if (fy > fx && fy > fz) {
    mx = ny > 0 ? -nx : nx;
    my = nz;
  } else if (fx > fy && fx > fz) {
    mx = nx > 0 ? ny : -ny;
    my = nz;
  } else {
    mx = nx;
    my = nz > 0 ? ny : -ny;
  }
  const m2x = mx * mx;
  const m2y = my * my;
  const q = -2 * m2x + 2 * m2y - 3;
  const ux = Math.sqrt(Math.max(0, 1.5 + m2x - m2y - 0.5 * Math.sqrt(Math.max(0, -24 * m2x + q * q)))) * (mx > 0 ? 1 : -1);
  const uy = Math.sqrt(6 / (3 - ux * ux)) * my;
  return out.set(ux * 0.5 + 0.5, uy * 0.5 + 0.5);
}

const _driftBase = new THREE.Vector3();
const _driftDir = new THREE.Vector3();
const _driftUp = new THREE.Vector3();
const _uv0 = new THREE.Vector2();
const _uv1 = new THREE.Vector2();
/**
 * The clouds' localWeatherVelocity (texture repeats per second) that moves them `speedMs` along the scene direction
 * (dirX, dirZ). The shader samples the texture at uv x repeat + offset, so the offset runs against the motion.
 */
export function cloudDriftVelocity(
  dirX: number,
  dirZ: number,
  speedMs: number,
  worldToECEF: THREE.Matrix4,
  repeat: number,
  out = new THREE.Vector2()
): THREE.Vector2 {
  const len = Math.hypot(dirX, dirZ);
  if (!(len > 0) || !(speedMs > 0)) return out.set(0, 0);
  _driftUp.set(0, 1, 0).transformDirection(worldToECEF);
  _driftBase.setFromMatrixPosition(worldToECEF).addScaledVector(_driftUp, DRIFT_ALTITUDE_M);
  _driftDir.set(dirX / len, 0, dirZ / len).transformDirection(worldToECEF);
  // Central difference over 2 km: the texture coordinate's rate along the wind
  const step = 1000;
  cubeSphereUv(_driftBase.addScaledVector(_driftDir, -step), _uv0);
  cubeSphereUv(_driftBase.addScaledVector(_driftDir, 2 * step), _uv1);
  return out.subVectors(_uv1, _uv0).multiplyScalar((-repeat * speedMs) / (2 * step));
}

/** The sky material's uniforms this module adds on top of the library's */
interface SkyExtraUniforms {
  skyRadianceScale: THREE.IUniform<number>;
  /** 0..1, read by the car reflection probe as the sky's sun-disc switch (it zeroes it while filming) */
  showSunDisc: THREE.IUniform<number>;
  overcast: THREE.IUniform<number>;
  overcastTint: THREE.IUniform<THREE.Color>;
  /** 0..1: the night sky's glow (night-sky.ts) */
  nightSky: THREE.IUniform<number>;
  /** 0..1: its stars (none in the environment bake) */
  nightStars: THREE.IUniform<number>;
}

type PatchedSkyMaterial = SkyMaterial & { uniforms: SkyMaterial["uniforms"] & SkyExtraUniforms };

/** The sky fragment shader's edits: radiance scale, sun-disc switch, overcast veil, the night sky and the radiance cap */
export const SKY_FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  [
    "uniform vec3 groundAlbedo;",
    "uniform vec3 groundAlbedo;\nuniform float skyRadianceScale;\nuniform float showSunDisc;\nuniform float overcast;\nuniform vec3 overcastTint;\nuniform float nightSky;\nuniform float nightStars;",
  ],
  ["radiance += transmittance * GetSolarRadiance() * antialias;", "radiance += transmittance * GetSolarRadiance() * antialias * showSunDisc;"],
  [
    "outputColor.a = 1.0;",
    /* glsl */ `outputColor.rgb *= skyRadianceScale;
  float skyLuma = dot(outputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  outputColor.rgb = mix(outputColor.rgb, vec3(skyLuma) * overcastTint, overcast);
  ${nightSkyGlsl("outputColor.rgb", "rayDirection", "normalize(vCameraPosition)", "nightSky", "nightStars", "fragmentAngle")}
  outputColor.rgb = min(outputColor.rgb, vec3(${SKY_MAX_RADIANCE.toFixed(1)}));
  outputColor.a = 1.0;`,
  ],
];

/** The quad sits on the far plane; under a reversed depth buffer that is depth 0, not 1 */
export const SKY_VERTEX_REVERSED_DEPTH_PATCHES: readonly ShaderPatch[] = [
  ["gl_Position = vec4(position.xy, 1.0, 1.0);", "gl_Position = vec4(position.xy, 0.0, 1.0);"],
];

/** The clouds' scene-depth read under a reversed depth buffer: the sky test, and view z from three's reversed formula */
export const CLOUDS_REVERSED_DEPTH_PATCHES: readonly ShaderPatch[] = [
  ["if (depth < 1.0 - 1e-7) {", "if (depth > 1e-7) {"],
  [
    "return perspectiveDepthToViewZ(depth, cameraNear, cameraFar);",
    "return (cameraNear * cameraFar) / ((cameraNear - cameraFar) * depth - cameraNear);",
  ],
];

/**
 * The clouds composite, scaled to the scene like the sky, and greyed and dimmed in rain: the library's light inside a
 * thick deck leaves a rain sky pale and tinted by the low sun. Its SKIP_RENDERING switch never worked here: postprocessing
 * renames the effect's define (to e0SKIP_RENDERING) but not this `#ifdef`, so the composite always ran. It is made
 * unconditional, and the clouds are switched off by disabling their pass instead (PhysicalSky.cloudsActive).
 */
export const CLOUDS_COMPOSITE_PATCHES: readonly ShaderPatch[] = [
  ["#ifdef SKIP_RENDERING", "#if 0 // SKIP_RENDERING (the pass is disabled instead)"],
  [
    "uniform sampler2D cloudsBuffer;",
    "uniform sampler2D cloudsBuffer;\nuniform float cloudsRadianceScale;\nuniform float cloudsGrey;\nuniform vec3 cloudsGreyTint;\nuniform vec3 cloudsNightGlow;",
  ],
  [
    "outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb;",
    /* glsl */ `vec3 cloudsColor = clouds.rgb * cloudsRadianceScale;
  cloudsColor = mix(cloudsColor, vec3(dot(cloudsColor, vec3(0.2126, 0.7152, 0.0722))) * cloudsGreyTint, cloudsGrey);
  // At night the clouds' undersides take the glow of the ground (towns, the haze), instead of going black
  cloudsColor += cloudsNightGlow * clouds.a;
  outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + cloudsColor;`,
  ],
];

/**
 * Reversed-depth patches for `@takram/three-atmosphere`'s `AerialPerspectiveEffect`:
 * under three r187 `reversedDepthBuffer` (WebGL2 `ZERO_TO_ONE`), the sky sits at `depth <= 1e-8`,
 * `depth` is already clip-Z in `[0, 1]` (not `[-1, 1]`), and `viewZ` follows the reversed perspective formula.
 */
export const AERIAL_PERSPECTIVE_REVERSED_DEPTH_PATCHES: readonly ShaderPatch[] = [
  ["if (depth >= 1.0 - 1e-8) {", "if (depth <= 1e-8) {"],
  ["vec4 clip = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);", "vec4 clip = vec4(uv * 2.0 - 1.0, depth, 1.0);"],
  [
    "getViewZ(depth),",
    "((cameraNear * cameraFar) / ((cameraNear - cameraFar) * depth - cameraNear)),",
  ],
];

/**
 * Radiance scaling, near-camera NaN guards and drifting cloud ground shadows for `AerialPerspectiveEffect`:
 * - Guards `RaySphereIntersections` against negative float32 discriminants and `getShadowRadius` against
 *   near/behind-camera shadow-texel projections (`w <= 0`).
 * - Skips `GetSkyRadianceToPoint` within 10 m of the camera (and fades smoothly over 10..40 m): `positionECEF` sits at
 *   ~6360 km (float32 ULP ~0.5 m), so close car geometry (hood, halo, roof, cockpit in T-cam / onboard views) can
 *   quantize onto `vCameraPosition`, making `point - camera == 0` -> `normalize(0) = NaN`, which bloom spreads into
 *   flashing black squares on and around the car (issue #161). Also rejects any non-finite LUT outputs.
 * - Scales Bruneton inscatter by `SKY_RADIANCE_SCALE` (dimmed/greyed in rain to match sky & clouds), blends
 *   transmittance & inscatter by `aerialStrength`, and attenuates lit terrain/track radiance under volumetric clouds
 *   via `sunTransmittance` when `CloudsEffect.atmosphereShadow` is bound.
 */
export const AERIAL_PERSPECTIVE_PATCHES: readonly ShaderPatch[] = [
  [
    "uniform vec3 sunDirection;",
    "uniform vec3 sunDirection;\nuniform float aerialRadianceScale;\nuniform float aerialStrength;\nuniform float cloudShadowStrength;\nuniform float aerialGrey;\nuniform vec3 aerialGreyTint;",
  ],
  [
    "float discriminant = b * b - 4.0 * c;\n  float Q = sqrt(discriminant);\n  return vec2(-b - Q, -b + Q) * 0.5;",
    "float discriminant = b * b - 4.0 * c;\n  float Q = sqrt(max(discriminant, 0.0));\n  return vec2(-b - Q, -b + Q) * 0.5;",
  ],
  [
    "projected /= projected.w;\n  projectedX /= projectedX.w;\n  projectedY /= projectedY.w;",
    /* glsl */ `if (!(projected.w > 1e-4 && projectedX.w > 1e-4 && projectedY.w > 1e-4)) {
    return shadowRadius;
  }
  projected /= projected.w;
  projectedX /= projectedX.w;
  projectedY /= projectedY.w;`,
  ],
  [
    "void applyTransmittanceInscatter(const vec3 positionECEF, float shadowLength, inout vec3 radiance) {",
    /* glsl */ `void applyTransmittanceInscatter(const vec3 positionECEF, float shadowLength, inout vec3 radiance) {
  vec3 aerialDelta = positionECEF - vCameraPosition;
  float aerialDistSq = dot(aerialDelta, aerialDelta);
  if (aerialStrength <= 0.0 || !(aerialDistSq >= 1e-4)) {
    return;
  }
  float aerialWeight = aerialStrength * smoothstep(0.01, 0.04, sqrt(aerialDistSq));`,
  ],
  [
    "#ifdef TRANSMITTANCE\n  radiance = radiance * transmittance;",
    /* glsl */ `if (any(isnan(transmittance)) || any(isinf(transmittance)) || any(isnan(inscatter)) || any(isinf(inscatter))) {
    return;
  }
  transmittance = clamp(transmittance, vec3(0.0), vec3(1.0));
  inscatter = max(inscatter, vec3(0.0));
  #ifdef TRANSMITTANCE
  radiance = mix(radiance, radiance * transmittance, aerialWeight);`,
  ],
  [
    "radiance = radiance + inscatter;",
    /* glsl */ `vec3 aerialInscatter = inscatter * aerialRadianceScale;
  aerialInscatter = mix(aerialInscatter, vec3(dot(aerialInscatter, vec3(0.2126, 0.7152, 0.0722))) * aerialGreyTint, aerialGrey);
  radiance = radiance + aerialInscatter * aerialWeight;`,
  ],
  [
    "#else // defined(SUN_LIGHT) || defined(SKY_LIGHT)\n  radiance = inputColor.rgb;",
    /* glsl */ `#else // defined(SUN_LIGHT) || defined(SKY_LIGHT)
  float aerialSunT = (isnan(sunTransmittance) || isinf(sunTransmittance)) ? 1.0 : clamp(sunTransmittance, 0.0, 1.0);
  radiance = inputColor.rgb * mix(1.0, aerialSunT, cloudShadowStrength);`,
  ],
];

export function createSkyMaterial(sun: boolean, reversedDepth: boolean): PatchedSkyMaterial {
  const material = new SkyMaterial({ sun, moon: false, ground: true, groundAlbedo: GROUND_ALBEDO.clone() }) as PatchedSkyMaterial;
  Object.assign(material.uniforms, {
    skyRadianceScale: { value: SKY_RADIANCE_SCALE },
    showSunDisc: { value: 1 },
    overcast: { value: 0 },
    overcastTint: { value: OVERCAST_TINT.clone() },
    nightSky: { value: 0 },
    nightStars: { value: 0 },
  } satisfies SkyExtraUniforms);
  material.fragmentShader = patchShader(material.fragmentShader, SKY_FRAGMENT_PATCHES, "physical sky");
  if (reversedDepth) {
    material.vertexShader = patchShader(material.vertexShader, SKY_VERTEX_REVERSED_DEPTH_PATCHES, "physical sky (reversed depth)");
  }
  material.needsUpdate = true;
  return material;
}

/** A clip-space quad the sky material projects itself onto, drawn after the opaque scene so early-Z skips it */
function createSkyQuad(material: PatchedSkyMaterial): THREE.Mesh<THREE.PlaneGeometry, PatchedSkyMaterial> {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000;
  mesh.name = "PhysicalSky";
  return mesh;
}

/** Converts the clouds' scene-depth read (sky test and view z) to a reversed depth buffer */
function patchCloudsForReversedDepth(clouds: CloudsEffect): void {
  const material = clouds.cloudsPass.currentMaterial;
  material.fragmentShader = patchShader(material.fragmentShader, CLOUDS_REVERSED_DEPTH_PATCHES, "clouds (reversed depth)");
  material.needsUpdate = true;
}

/** The composite's own uniforms: radiance scale, and how far toward a neutral grey (0..1) */
interface CloudsCompositeUniforms {
  cloudsRadianceScale: THREE.Uniform<number>;
  cloudsGrey: THREE.Uniform<number>;
  /** Scene radiance of a night cloud's underside (night-sky.ts) */
  cloudsNightGlow: THREE.Uniform<THREE.Color>;
}

/** Scales the clouds by SKY_RADIANCE_SCALE where the effect composites them over the frame, greyed by the weather */
function patchCloudsComposite(clouds: CloudsEffect): CloudsCompositeUniforms {
  // postprocessing's Effect keeps its shader behind a protected setter
  const effect = clouds as unknown as { getFragmentShader(): string; setFragmentShader(source: string): void };
  effect.setFragmentShader(patchShader(effect.getFragmentShader(), CLOUDS_COMPOSITE_PATCHES, "clouds composite"));
  const u: CloudsCompositeUniforms = {
    cloudsRadianceScale: new THREE.Uniform(SKY_RADIANCE_SCALE),
    cloudsGrey: new THREE.Uniform(0),
    cloudsNightGlow: new THREE.Uniform(new THREE.Color(0, 0, 0)),
  };
  const map = clouds.uniforms as unknown as Map<string, THREE.Uniform>;
  map.set("cloudsRadianceScale", u.cloudsRadianceScale);
  map.set("cloudsGrey", u.cloudsGrey);
  map.set("cloudsNightGlow", u.cloudsNightGlow);
  map.set("cloudsGreyTint", new THREE.Uniform(OVERCAST_TINT.clone()));
  return u;
}

/** The aerial-perspective effect's own uniforms: radiance scale, haze strength, cloud ground-shadow depth, rain greying */
interface AerialUniforms {
  aerialRadianceScale: THREE.Uniform<number>;
  aerialStrength: THREE.Uniform<number>;
  cloudShadowStrength: THREE.Uniform<number>;
  aerialGrey: THREE.Uniform<number>;
}

/** Patches `AerialPerspectiveEffect` for scene radiance scaling, cloud ground shadows and (optionally) reversed depth */
function patchAerialPerspective(aerial: AerialPerspectiveEffect, reversedDepth: boolean): AerialUniforms {
  const effect = aerial as unknown as { getFragmentShader(): string; setFragmentShader(source: string): void };
  let fs = patchShader(effect.getFragmentShader(), AERIAL_PERSPECTIVE_PATCHES, "aerial perspective");
  if (reversedDepth) {
    fs = patchShader(fs, AERIAL_PERSPECTIVE_REVERSED_DEPTH_PATCHES, "aerial perspective (reversed depth)");
  }
  effect.setFragmentShader(fs);
  const u: AerialUniforms = {
    aerialRadianceScale: new THREE.Uniform(SKY_RADIANCE_SCALE),
    aerialStrength: new THREE.Uniform(0.85),
    cloudShadowStrength: new THREE.Uniform(0),
    aerialGrey: new THREE.Uniform(0),
  };
  const map = aerial.uniforms as unknown as Map<string, THREE.Uniform>;
  map.set("aerialRadianceScale", u.aerialRadianceScale);
  map.set("aerialStrength", u.aerialStrength);
  map.set("cloudShadowStrength", u.cloudShadowStrength);
  map.set("aerialGrey", u.aerialGrey);
  map.set("aerialGreyTint", new THREE.Uniform(OVERCAST_TINT.clone()));
  return u;
}

/**
 * The 128 x 128 x 64 spatiotemporal noise the clouds jitter their ray marching with: our blue-noise tile, shifted
 * by the golden ratio on every slice so each frame's noise is blue in space and well spread over time
 */
export function createSpatiotemporalNoise(tile: Uint8Array): THREE.Data3DTexture {
  const n = BLUE_NOISE_SIZE * BLUE_NOISE_SIZE;
  const data = new Uint8Array(n * BLUE_NOISE_DEPTH);
  const golden = 0.6180339887498949;
  for (let z = 0; z < BLUE_NOISE_DEPTH; z++) {
    const shift = (z * golden) % 1;
    for (let i = 0; i < n; i++) data[z * n + i] = Math.floor((((tile[i] + 0.5) / 256 + shift) % 1) * 256);
  }
  const texture = new THREE.Data3DTexture(data, BLUE_NOISE_SIZE, BLUE_NOISE_SIZE, BLUE_NOISE_DEPTH);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * three r187 re-derives a camera's projection for the reversed depth buffer the first time it renders with it, but
 * the libraries' offscreen passes (the atmosphere precompute, the clouds' noise volumes) draw full-screen quads with a
 * bare Camera, which has no projection to update and threw. Those quads need no projection, so a no-op is right.
 */
function allowReversedDepth(owner: unknown): void {
  const camera = (owner as { camera?: THREE.Camera & { updateProjectionMatrix?: () => void } }).camera;
  if (camera && typeof camera.updateProjectionMatrix !== "function") camera.updateProjectionMatrix = () => {};
}

export class PhysicalSky {
  /** The visible sky, sun disc on; added to the scene by the caller */
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, PatchedSkyMaterial>;
  /** The same sky without the sun disc, for the environment bake's scene */
  readonly bakeMesh: THREE.Mesh<THREE.PlaneGeometry, PatchedSkyMaterial>;
  /** Volumetric clouds for the post-processing chain; the caller places it right after the scene render */
  readonly clouds: CloudsEffect;
  /** Physical aerial perspective + drifting cloud ground shadows (High desktop only, merged into the clouds pass) */
  readonly aerialPerspective: AerialPerspectiveEffect;
  /** The atmosphere's lookup tables are ready (until then the sky renders black: keep the classic sky up) */
  ready = false;

  private readonly generator: PrecomputedTexturesGenerator;
  private readonly worldToECEF = sceneToECEFMatrix();
  private readonly sunECEF = new THREE.Vector3(0, 0, 1);
  private readonly procedural: Array<{ dispose(): void }> = [];
  private stbn: THREE.Data3DTexture | null = null;
  private readonly composite: CloudsCompositeUniforms;
  private readonly aerialUniforms: AerialUniforms;
  private quality: SkyQuality = "high";
  private aerialAllowed = true;
  private cloud = 0;
  private rain = 0;
  private sunElevationSin = 0.25;
  private windX = 0;
  private windZ = 0;
  /** The session's cloud seed and the recipe picked from it (null: pick on the next look, with the weather then) */
  private seed = 1;
  private recipe: CloudRecipe | null = null;
  private readonly setup: CloudSkySetup = cloudSkyFor(pickCloudRecipe(1, 0, 0), 0, 0);
  private readonly logRecipes = typeof location !== "undefined" && new URLSearchParams(location.search).has("cloudseed");
  /** The recipe has a layer on now (a cloudless sky skips the clouds' pass: the library has no heights to march then) */
  private anyClouds = true;
  private disposed = false;

  constructor(renderer: THREE.WebGLRenderer, onReady: () => void) {
    const reversedDepth = renderer.state.buffers.depth.getReversed();
    this.mesh = createSkyQuad(createSkyMaterial(true, reversedDepth));
    this.bakeMesh = createSkyQuad(createSkyMaterial(false, reversedDepth));
    this.mesh.visible = false;
    this.bakeMesh.visible = false;
    for (const m of [this.mesh.material, this.bakeMesh.material]) m.worldToECEFMatrix.copy(this.worldToECEF);

    this.clouds = new CloudsEffect();
    this.clouds.worldToECEFMatrix.copy(this.worldToECEF);
    // Procedural noise volumes, rendered on the GPU the first time the clouds draw
    const localWeather = new LocalWeather();
    const shape = new CloudShape();
    const shapeDetail = new CloudShapeDetail();
    const turbulence = new Turbulence();
    this.procedural.push(localWeather, shape, shapeDetail, turbulence);
    for (const p of this.procedural) allowReversedDepth(p);
    this.clouds.localWeatherTexture = localWeather;
    this.clouds.shapeTexture = shape;
    this.clouds.shapeDetailTexture = shapeDetail;
    this.clouds.turbulenceTexture = turbulence;
    // Light shafts need the atmosphere's aerial-perspective pass, which this renderer does not run
    this.clouds.lightShafts = false;
    if (reversedDepth) patchCloudsForReversedDepth(this.clouds);
    this.composite = patchCloudsComposite(this.clouds);
    this.clouds.skipRendering = false;

    this.aerialPerspective = new AerialPerspectiveEffect(undefined, {
      sunLight: false,
      skyLight: false,
      sky: false,
      transmittance: true,
      inscatter: true,
    });
    this.aerialPerspective.worldToECEFMatrix.copy(this.worldToECEF);
    this.aerialPerspective.shadowSampleCount = 4;
    this.aerialPerspective.shadowRadius = 4;
    this.aerialUniforms = patchAerialPerspective(this.aerialPerspective, reversedDepth);
    this.clouds.events.addEventListener("change", (event) => {
      if (event.property === "atmosphereShadow") this.syncAerialShadow();
    });

    this.generator = new PrecomputedTexturesGenerator(renderer);
    allowReversedDepth(this.generator);
    const textures = this.generator.textures;
    Object.assign(this.mesh.material, textures);
    Object.assign(this.bakeMesh.material, textures);
    Object.assign(this.clouds, textures);
    Object.assign(this.aerialPerspective, textures);
    this.generator
      .update()
      .then(() => {
        if (this.disposed) return;
        this.ready = true;
        this.applyLook();
        onReady();
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        // three's readback rejects with nothing when its fence fails, which is what a lost GPU context does
        console.error("[physical-sky] atmosphere precompute failed; keeping the classic sky", error ?? "(no reason: the GPU context was lost)");
      });

    void fetch(withBasePath(BLUE_NOISE_URL))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${BLUE_NOISE_URL}`))))
      .then((buffer) => {
        if (this.disposed) return;
        this.stbn = createSpatiotemporalNoise(new Uint8Array(buffer));
        this.clouds.stbnTexture = this.stbn;
        this.aerialPerspective.stbnTexture = this.stbn;
        this.applyLook();
      })
      .catch((error: unknown) => console.warn("[physical-sky] blue noise missing; the clouds will look grainier", error));
  }

  /** Sun, cloud cover and rain (cheap: uniforms only) */
  setConditions(c: PhysicalSkyConditions): void {
    this.sunElevationSin = Number.isFinite(c.sunDirection.y) ? c.sunDirection.y : 0.25;
    this.sunECEF.copy(c.sunDirection).transformDirection(this.worldToECEF);
    this.mesh.material.sunDirection.copy(this.sunECEF);
    this.bakeMesh.material.sunDirection.copy(this.sunECEF);
    this.clouds.sunDirection.copy(this.sunECEF);
    this.aerialPerspective.sunDirection.copy(this.sunECEF);
    this.cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
    this.rain = THREE.MathUtils.clamp(c.rain, 0, 1);
    this.windX = Number.isFinite(c.windVxMs) ? c.windVxMs! : 0;
    this.windZ = Number.isFinite(c.windVzMs) ? c.windVzMs! : 0;
    this.applyLook();
  }

  /**
   * A new session's sky: the cloud types, heights and pattern are picked from `seed` with the next conditions (cheap:
   * uniforms only, no shader change)
   */
  setSeed(seed: number): void {
    this.seed = seed;
    this.recipe = null;
  }

  /** The cloud types on show now, lowest first (empty until the first conditions) */
  get cloudTypes(): string[] {
    return this.recipe ? describeClouds(this.recipe, this.cloud, this.rain) : [];
  }

  /** The graphics preset: this sky and its clouds on Medium and High, hidden on Low (the classic sky shows there) */
  setQuality(quality: SkyQuality, aerialAllowed = quality === "high"): void {
    this.quality = quality;
    this.aerialAllowed = aerialAllowed;
    const touch = isTouchDevice();
    this.clouds.qualityPreset = quality === "high" && !touch ? "medium" : "low";
    // Desktop Medium keeps crisp 0.75x volumetric clouds; touch devices stay 0.5x for mobile fill-rate budget.
    this.clouds.resolutionScale = touch ? 0.5 : quality === "high" ? 1 : 0.75;
    this.clouds.lightShafts = false;
    this.applyLook();
  }

  /** This sky is up: its lookup tables are ready and the preset is not Low */
  get showing(): boolean {
    return this.ready && this.quality !== "low";
  }

  /** Whether the clouds' pass should run this frame (they come and go with the sky, and sit out a cloudless one) */
  get cloudsActive(): boolean {
    return this.showing && this.anyClouds;
  }

  /** Whether physical aerial perspective + cloud ground shadows should run (High desktop with post-chain aerial enabled) */
  get aerialActive(): boolean {
    return this.showing && this.quality === "high" && this.aerialAllowed && !isTouchDevice();
  }

  private syncAerialShadow(): void {
    const wantShadow = this.aerialActive && this.cloudsActive && this.stbn !== null;
    this.aerialPerspective.shadow = wantShadow ? this.clouds.atmosphereShadow : null;
  }

  /** Picks the session's recipe (once per seed) and puts its pattern where the seed says */
  private ensureRecipe(): CloudRecipe {
    if (this.recipe) return this.recipe;
    const r = pickCloudRecipe(this.seed, this.cloud, this.rain);
    this.recipe = r;
    const c = this.clouds;
    c.localWeatherRepeat.setScalar(r.repeat);
    c.localWeatherOffset.set(r.offset[0], r.offset[1]);
    c.shapeOffset.set(r.shapeOffset[0], r.shapeOffset[1], r.shapeOffset[2]);
    c.shapeDetailOffset.set(r.shapeOffset[1], r.shapeOffset[2], r.shapeOffset[0]);
    if (this.logRecipes) console.info(`[physical-sky] cloud seed ${r.seed}: ${describeClouds(r, this.cloud, this.rain).join(", ") || "clear"}`);
    return r;
  }

  private applyLook(): void {
    const { cloud, rain } = this;
    this.mesh.visible = this.showing;
    this.bakeMesh.visible = this.showing;
    const recipe = this.ensureRecipe();
    cloudSkyFor(recipe, cloud, rain, this.setup);
    this.anyClouds = this.setup.layers.some((l) => l.height > 0);
    const volumetric = this.cloudsActive;
    this.clouds.coverage = this.setup.coverage;
    for (let i = 0; i < 4; i++) this.clouds.cloudLayers[i].set(this.setup.layers[i]);
    // Drift with the wind aloft, along the recipe's own heading in a calm
    const calm = Math.hypot(this.windX, this.windZ) < 0.1;
    cloudDriftVelocity(
      calm ? Math.sin(recipe.calmDriftRad) : this.windX,
      calm ? Math.cos(recipe.calmDriftRad) : this.windZ,
      Math.max(MIN_DRIFT_MS, WIND_ALOFT_FACTOR * Math.hypot(this.windX, this.windZ)),
      this.worldToECEF,
      recipe.repeat,
      this.clouds.localWeatherVelocity
    );
    // Rain clouds dark and grey (the visible sky with them, so the horizon below the deck matches); a dry overcast
    // keeps some of the low sun's colour
    const gloom = rain * (0.75 + 0.25 * cloud);
    this.composite.cloudsRadianceScale.value = SKY_RADIANCE_SCALE * (1 - 0.45 * gloom);
    this.composite.cloudsGrey.value = Math.min(1, 0.7 * gloom + 0.3 * THREE.MathUtils.smoothstep(cloud, 0.8, 1));
    this.mesh.material.uniforms.skyRadianceScale.value = SKY_RADIANCE_SCALE * (1 - 0.35 * gloom);
    // The bake has no volumetric clouds, so its sky always takes the veil; the visible sky only a little under a full
    // deck and in rain (the deck itself greys it, and broken cloud shows blue sky between)
    const veil = cloud * (0.75 + 0.25 * rain);
    this.bakeMesh.material.uniforms.overcast.value = veil;
    this.mesh.material.uniforms.overcast.value = volumetric ? 0.3 * THREE.MathUtils.smoothstep(cloud, 0.85, 1) + 0.4 * rain : veil;
    // The night sky's glow, in the bake too; the stars only on the visible sky, and only on a clear night
    const night = nightShareOfElevation(THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.sunElevationSin, -1, 1))));
    this.mesh.material.uniforms.nightSky.value = night * (1 - 0.5 * gloom);
    this.bakeMesh.material.uniforms.nightSky.value = night * (1 - 0.5 * gloom);
    this.mesh.material.uniforms.nightStars.value = starShare(night, cloud, rain);
    this.composite.cloudsNightGlow.value.setRGB(...NIGHT_CLOUD_GLOW).multiplyScalar(night);
    this.bakeMesh.material.uniforms.nightStars.value = 0;
    // A thick overcast hides the sun disc (the probe zeroes this while it films and puts the value back)
    this.mesh.material.uniforms.showSunDisc.value = 1 - THREE.MathUtils.smoothstep(cloud, 0.55, 0.9);
    // Physical aerial perspective + soft drifting cloud ground shadows on High desktop
    const sunUp = THREE.MathUtils.smoothstep(this.sunElevationSin, 0.02, 0.22);
    this.aerialUniforms.aerialRadianceScale.value = SKY_RADIANCE_SCALE * (1 - 0.4 * gloom);
    this.aerialUniforms.aerialGrey.value = Math.min(1, 0.65 * gloom + 0.25 * THREE.MathUtils.smoothstep(cloud, 0.8, 1));
    this.aerialUniforms.aerialStrength.value = this.aerialActive ? 0.85 * (1 - 0.55 * rain) : 0;
    this.aerialUniforms.cloudShadowStrength.value =
      this.aerialActive && volumetric && this.stbn !== null
        ? 0.34 * sunUp * (1 - 0.85 * gloom) * (1 - 0.65 * THREE.MathUtils.smoothstep(cloud, 0.78, 1))
        : 0;
    this.syncAerialShadow();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of [this.mesh, this.bakeMesh]) {
      m.removeFromParent();
      m.geometry.dispose();
      m.material.dispose();
    }
    this.clouds.dispose();
    this.aerialPerspective.dispose();
    for (const p of this.procedural) p.dispose();
    this.stbn?.dispose();
    this.generator.dispose();
  }
}
