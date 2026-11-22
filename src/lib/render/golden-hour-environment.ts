import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { SunLight } from "three/examples/jsm/lights/SunLight.js";
import { DRIVER_HEAD_LAYER, SHADOW_PROXY_LAYER } from "@/lib/render/layers";
import { setAsphaltQuality } from "@/lib/render/asphalt-sheen";
import { setSceneryQuality } from "@/lib/render/scenery-detail";
import { setSceneryDensity } from "@/lib/render/scenery-instances";
import {
  BloomEffect,
  Effect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";
import { patchShader } from "./shader-patch";
import { PhysicalSky } from "./physical-sky";
import { nightShareOfElevation, nightSkyGlsl, starShare } from "./night-sky";
import { isTouchDevice } from "@/lib/input/touch-input";
import { pixelRatioCap, type RenderPlan } from "./adaptive-quality";
import type { AerialPerspectiveEffect } from "@takram/three-atmosphere";
import type { CloudsEffect } from "@takram/three-clouds";

/*
 * Golden-hour lighting, sky/environment and post-processing for LibreCorsa.
 *
 * Units: world metres. Track is ~1.5 km across at y~0.
 *
 * Sun geometry
 *   elevation 14 deg, azimuth 127 deg in the three.js Sky convention
 *   (theta: 0 = +Z, 90 = +X). 127 deg matches the bearing of the old
 *   key light placed at car + (85, 115, -65), so trackside shadows keep the
 *   same side of the circuit as before.
 *
 * Tone mapping (verified against node_modules/postprocessing 6.39.5 and three 0.186.0)
 *   - The composer's RenderPass draws into a HalfFloat render target. three.js
 *     only applies renderer.toneMapping when the current render target is null
 *     (WebGLRenderer.js ~2391), so renderer.toneMapping is NOT applied there.
 *   - The EffectPass fullscreen material is toneMapped:false and contains no
 *     tonemapping chunk, so it does not apply renderer.toneMapping either.
 *     Its ENCODE_OUTPUT path ends in colorspace_fragment, which performs the
 *     single linear -> sRGB encode when the pass renders to screen.
 *   - Therefore AgX is applied by a ToneMappingEffect (mode AGX) placed in the
 *     final EffectPass, after bloom (High only) and before the display grade.
 *     It reads the three.js toneMappingExposure
 *     uniform, which WebGLRenderer pushes from renderer.toneMappingExposure
 *     (WebGLRenderer.js ~2751). Set exposure before the first render.
 *   - renderer.toneMapping is still set to AgX in configureRenderer, as
 *     requested. It has no effect on the composer path; it only matters for
 *     any object drawn straight to the canvas outside postFx.
 *
 * Deviations from the brief
 *   - PCFSoftShadowMap is removed in three r186 (WebGLShadowMap.js ~99 falls back
 *     to PCF with a warning). PCFShadowMap plus shadow.radius gives the same
 *     Vogel-disk soft edge, so PCFShadowMap is used.
 *   - BloomEffect levels = 5 (default 8) to keep the mip chain cheap at 120 FPS.
 *   - Sky cloudCoverage = 0. The Sky shader skips its cloud fbm entirely when
 *     coverage is 0, which keeps the sky cheap and the sky clear.
 *
 * Time of day and weather (setConditions)
 *   The sun, sky, fill, fog and exposure follow the session's sun position and
 *   cloud / rain (src/lib/sim/weather.ts). Every curve passes exactly through
 *   the values above at 14 deg / 127 deg with a clear sky, so the default
 *   golden-hour look is unchanged. Lights and fog update every call (cheap);
 *   the PMREM environment is re-baked only when the sky has changed visibly
 *   (sun > 1 deg, cloud / rain > 0.05) and at most every 1.5 s, into the same
 *   render target each time (SkyBaker).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUN_ELEVATION_DEG = 14;
const SUN_AZIMUTH_DEG = 127;
const SUN_DISTANCE_M = 220;

/** Per cascade: the two cascades share one 2 x 1 atlas (4096 x 2048) */
const SHADOW_MAP_SIZE = 2048;
/**
 * How far from the camera the sun's two shadow cascades reach. They split the range between the camera's
 * near plane and this distance (half uniform, half logarithmic), so 250 m puts the split near 65 m: the near
 * cascade keeps ~6 cm texels around the car, the far one covers grandstands, trees and barriers at ~20 cm.
 */
const SHADOW_DISTANCE_M = 250;

const SKY_SCALE = 4500;
/** Linear radiance cap for the visible sun disc (bloom threshold is 1.1) */
const SUN_DISC_MAX_RADIANCE = 30;
/** Brings the Sky shader's radiance to this scene's exposure (applies to the PMREM bake too) */
const SKY_RADIANCE_SCALE = 0.15;
const ENV_SIZE = 256;

// Warm hazy horizon, picked by eye to sit between the Sky's warm horizon glow
// near the sun and its pale blue zenith at 14 deg elevation, turbidity 2.8.
const FOG_COLOR = 0xe8c6a0;
const FOG_DENSITY = 0.00035;

const SUN_COLOR = 0xffebd6;
const SUN_INTENSITY = 5.0;
const FILL_SKY = 0xc4d8ee;
const FILL_GROUND = 0x6b6a3a;
const FILL_INTENSITY = 0.13;
/** Albedo of the stand-in ground in the sky's environment bake, and the sky light it gets at least */
const GROUND_ALBEDO = 0x3a3833;
const GROUND_SKY_LIGHT = 0.6;
const EXPOSURE = 1.15;
/** Display-referred grade after AgX (DisplayGradeEffect): contrast and saturation gain */
const GRADE_CONTRAST = 0.12;
const GRADE_SATURATION = 0.18;
const SKY_TURBIDITY = 2.8;
const SKY_RAYLEIGH = 1.8;
/** Minimum time between environment re-bakes (s) */
const REBAKE_MIN_S = 1.5;

const REAR_RAIN_MATERIAL_NAME = "EXT_clearled_security";
const REAR_RAIN_EMISSIVE = 0xff1100;
const REAR_RAIN_EMISSIVE_INTENSITY = 10.0;
const REAR_RAIN_BASE_COLOR = 0x2a0000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Sun position and sky state the lighting follows (from the session's WeatherState) */
export interface SkyConditions {
  /** Sun elevation above the horizon (deg) */
  elevationDeg: number;
  /** Sun azimuth, three.js Sky convention (deg, 0 = +Z, 90 = +X) */
  azimuthDeg: number;
  /** Cloud cover 0..1 */
  cloud: number;
  /** Rain intensity 0..1 */
  rain: number;
  /** Near-ground wind (m/s) along scene X and Z: the volumetric clouds drift with it */
  windVxMs?: number;
  windVzMs?: number;
}

/** How far into the night a sun elevation is: 0 until the sun is 3 deg under the horizon, 1 from 13 deg under */
export function nightShareOf(elevationDeg: number): number {
  return nightShareOfElevation(elevationDeg);
}

/**
 * The night of a circuit raced under floodlights (venue-night-lighting.ts): what the key light, the fill, the
 * environment and the exposure blend to with the night share, in place of moonlight.
 */
export interface FloodlitNightLook {
  keyColor: number;
  /** As the sun's intensity (5 at golden hour) */
  keyIntensity: number;
  /** How high the light stands (deg): steep, as from masts on both sides */
  keyElevationDeg: number;
  fillIntensity: number;
  environmentIntensity: number;
  exposure: number;
  /** Haze lit by the venue, for the fog */
  fogColor: number;
}

/** The original look: clear sky, sun at 14 deg / 127 deg */
export const GOLDEN_HOUR_SKY: Readonly<SkyConditions> = {
  elevationDeg: SUN_ELEVATION_DEG,
  azimuthDeg: SUN_AZIMUTH_DEG,
  cloud: 0,
  rain: 0,
};

export interface GoldenHourEnvironment {
  sunLight: SunLight;
  /** unit vector from scene towards the sun */
  sunDirection: THREE.Vector3;
  sky: Sky;
  /**
   * The physically based sky and its volumetric clouds, shown on Medium and High. Created the first time either is
   * picked, so a Low session never builds it; null until then, and always with `?sky=classic`.
   */
  readonly physicalSky: PhysicalSky | null;
  /** The visible sky's sun-disc switch (`showSunDisc`), which the car reflection probe zeroes while it films */
  probeSky: { material: { uniforms: Record<string, { value: unknown }> } };
  /** Graphics preset: the physical sky on Medium and High, the classic sky on Low */
  setQuality(quality: "low" | "medium" | "high", aerialAllowed?: boolean): void;
  /**
   * With `deferPhysicalSky`: the physical sky may be built from now on (on Medium and High), once the loading's own GPU
   * work is done. Its atmosphere precompute then never runs alongside the circuit's uploads and warm-up frame.
   */
  startPhysicalSky(): void;
  /** Weak warm-blue / olive fill; added to the scene by createGoldenHourEnvironment. */
  fillLight: THREE.HemisphereLight;
  /** Call once per frame before rendering: keeps the sky dome centred on the camera (the shadow cascades fit the rendering camera on their own) */
  update(carWorldPos: THREE.Vector3, camera: THREE.Camera): void;
  /** Time of day and weather: moves the sun and sets sky, fill, fog and exposure (cheap; re-bakes the environment only on a visible change) */
  setConditions(conditions: SkyConditions): void;
  /**
   * A circuit raced under floodlights: at night the key light is its floodlight (steep, near white, with the shadows)
   * instead of the moon, and fill, environment, fog and exposure follow. null: moonlit nights again. Day is unchanged.
   */
  setFloodlitNight(look: Readonly<FloodlitNightLook> | null): void;
  /**
   * A new session's clouds: the seed picks the cloud types, their heights and where the pattern sits (cloud-recipes.ts),
   * with the conditions of the next setConditions. Call it before that setConditions. Cheap: no shader change
   */
  setCloudSeed(seed: number): void;
  /** The cloud types the physical sky shows now, lowest first (empty with the classic sky) */
  readonly cloudTypes: string[];
  dispose(): void;
}

export interface PostFx {
  composer: EffectComposer;
  render(dtSeconds: number): void;
  setSize(width: number, height: number): void;
  /** swap the camera used by the render pass (the sim uses a single camera, but keep it safe) */
  setCamera(camera: THREE.Camera): void;
  /** Graphics preset: MSAA samples and bloom on / off (`bloom` decouples touch High bloom from disabled touch MSAA) */
  setQuality(quality: "low" | "medium" | "high", msaa?: boolean, bloom?: boolean): void;
  /** Puts the physical sky's clouds (and High desktop aerial perspective) into the chain, once; later calls are no-ops */
  setClouds(sky: {
    readonly clouds: CloudsEffect;
    readonly cloudsActive: boolean;
    readonly aerialPerspective?: AerialPerspectiveEffect;
    readonly aerialActive?: boolean;
  }): void;
  /**
   * Zero-pass FidelityFX RCAS sharpening strength (0 = off / skipped, up to 1). Automatically enabled when rendering
   * below native devicePixelRatio (Low on HiDPI, Medium on 2x/3x phones, or adaptive step-down).
   */
  setSharpness(amount: number): void;
  /**
   * The off-track edge glow: a CSS hex colour turns it on (breathing, or steady under reduced motion), null turns it
   * off. A colour it cannot read keeps the last one.
   */
  setEdgeGlow(color: string | null): void;
  dispose(): void;
}

/** Auto-scaled RCAS sharpening strength from `effectivePixelRatio / nativeDpr` (0 at native >= 98%, up to 0.55) */
export function rcasSharpnessForRatio(effectiveRatio: number): number {
  return effectiveRatio >= 0.98 ? 0 : THREE.MathUtils.clamp((1 - effectiveRatio) * 1.15, 0.15, 0.55);
}

/**
 * Applies a graphics plan to the running renderer: resolution (device pixel ratio x the render scale), the sun's
 * shadow, MSAA and bloom, from the preset and what the automatic step-down turned down on top of it
 * (adaptive-quality.ts). Cheap to call again; the caller re-sizes the composer afterwards.
 */
export function applyGraphicsQuality(renderer: THREE.WebGLRenderer, postFx: PostFx, env: GoldenHourEnvironment, plan: RenderPlan): void {
  const { quality, renderScale } = plan;
  // The automatic quality's Lowest resolution bounds `renderScale`, the multiplier on this cap (adaptive-quality.ts)
  const dprCap = pixelRatioCap(plan);
  const nativeDpr = typeof window !== "undefined" ? Math.max(1, window.devicePixelRatio || 1) : 1;
  const pixelRatio = Math.max(0.35, Math.min(nativeDpr, dprCap) * renderScale);
  renderer.setPixelRatio(pixelRatio);
  // Toggling the light's shadow recompiles the lit materials on their own (shadow count is part of the program key)
  env.sunLight.castShadow = quality !== "low";
  // Half the texels per side: three resizes the shadow map in place, with no shader change
  const shadowSize = plan.shadows === "half" ? SHADOW_MAP_SIZE / 2 : SHADOW_MAP_SIZE;
  env.sunLight.shadow.mapSize.set(shadowSize, shadowSize);
  postFx.setQuality(quality, plan.msaa, plan.bloom);
  const autoSharp = rcasSharpnessForRatio(pixelRatio / nativeDpr);
  const sharpness = plan.sharpen === true ? Math.max(0.4, autoSharp) : plan.sharpen === false ? 0 : autoSharp;
  postFx.setSharpness(sharpness);
  env.setQuality(quality, plan.bloom);
  if (env.physicalSky) postFx.setClouds(env.physicalSky);
  // Scenery & asphalt aggregate noise/bump off on Low (baked shading & rubber line stay); fewer instanced trees below High
  setAsphaltQuality(quality);
  setSceneryQuality(quality);
  setSceneryDensity(quality);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was removed in three r186; PCF + shadow.radius replaces it.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

// ---------------------------------------------------------------------------
// Sky helpers
// ---------------------------------------------------------------------------

function configureSkyUniforms(sky: Sky, showSunDisc: boolean): void {
  const u = sky.material.uniforms;
  u.turbidity.value = SKY_TURBIDITY;
  u.rayleigh.value = SKY_RAYLEIGH;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  u.cloudCoverage.value = 0;
  u.showSunDisc.value = showSunDisc ? 1 : 0;
  (u.sunPosition.value as THREE.Vector3).copy(sunDirectionUnit());
  u.skyRadianceScale = { value: SKY_RADIANCE_SCALE };
  // The Sky shader writes HDR values directly; it must not also get scene fog.
  sky.material.fog = false;
  // The stock disc reaches ~60000, which the mipmap bloom smears into a full-screen white haze. Capped, it
  // stays well above the 1.1 bloom threshold and blooms into a halo instead.
  // The stock sky is tuned for exposure ~0.5: at 14° its horizon toward the sun reaches ~29 linear, so a
  // quarter of the frame crossed the bloom threshold. Scaled, only the glow around the sun blooms.
  u.nightSky = { value: 0 };
  u.nightStars = { value: 0 };
  sky.material.fragmentShader = patchShader(
    "uniform float skyRadianceScale;\nuniform float nightSky;\nuniform float nightStars;\n" + sky.material.fragmentShader,
    [
      [
        "vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );",
        "vec3 sundiscColor = min( ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 ), vec3( SUN_DISC_MAX ) );",
      ],
      [
        "gl_FragColor = vec4( texColor, 1.0 );",
        `vec3 lcSkyOut = texColor * skyRadianceScale;
${nightSkyGlsl("lcSkyOut", "direction", "vec3( 0.0, 1.0, 0.0 )", "nightSky", "nightStars", "length( fwidth( direction ) )")}
	gl_FragColor = vec4( lcSkyOut, 1.0 );`,
      ],
    ],
    "sky"
  );
  sky.material.defines = {
    ...sky.material.defines,
    SUN_DISC_MAX: SUN_DISC_MAX_RADIANCE.toFixed(1),
  };
  // The stock vertex shader pins the dome to the far plane with z = w. Under a reversed depth buffer the far
  // plane is depth 0, so z = w would put the sky on the near plane, in front of everything.
  const pinFar = "gl_Position.z = gl_Position.w;";
  if (sky.material.vertexShader.includes(pinFar)) {
    sky.material.vertexShader = sky.material.vertexShader.replace(
      pinFar,
      "\n#ifdef USE_REVERSED_DEPTH_BUFFER\n\tgl_Position.z = 0.0;\n#else\n\tgl_Position.z = gl_Position.w;\n#endif\n"
    );
  } else {
    console.warn("[golden-hour-environment] Sky far-plane anchor not found; the sky may hide the scene with reversed depth");
  }
}

// Returns a fresh unit vector for the sun.
function sunDirectionUnit(elevationDeg = SUN_ELEVATION_DEG, azimuthDeg = SUN_AZIMUTH_DEG): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
  const theta = THREE.MathUtils.degToRad(azimuthDeg);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

// ---------------------------------------------------------------------------
// Time of day / weather look
// ---------------------------------------------------------------------------

type Key = readonly [number, number];

/** Piecewise-linear curve through (x, y) keys sorted by x; flat outside them */
function curve(keys: readonly Key[], x: number): number {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const [x0, y0] = keys[i - 1];
      const [x1, y1] = keys[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return keys[keys.length - 1][1];
}

const _ca = new THREE.Color();
const _cb = new THREE.Color();
/** Colour curve: (x, hex) keys, blended in linear space */
function colorCurve(keys: readonly Key[], x: number, out: THREE.Color): THREE.Color {
  if (x <= keys[0][0]) return out.setHex(keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (x <= keys[i][0]) {
      const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return out.copy(_ca.setHex(keys[i - 1][1])).lerp(_cb.setHex(keys[i][1]), t);
    }
  }
  return out.setHex(keys[keys.length - 1][1]);
}

// Keys by sun elevation (deg). Each passes through the golden-hour constant at 14 deg, and extends smoothly into
// moonlit night below -3 deg while keeping dawn..noon curves identical.
const SUN_COLOR_KEYS: readonly Key[] = [[-18, 0x7692c8], [-6, 0x8088b2], [-2, 0xff6a2a], [4, 0xffa262], [14, SUN_COLOR], [35, 0xfff4e8], [70, 0xfff8f2]];
const SUN_INTENSITY_KEYS: readonly Key[] = [[-18, 0.42], [-6, 0.1], [-3, 0], [1, 0.8], [6, 3.0], [14, SUN_INTENSITY], [35, 5.8], [70, 6.2]];
// The sky's prefiltered environment already lights everything from the sky dome; this flat fill on top of it only
// washes out shading and reflections (cars read as matte plastic), so it is kept to a trace
const FILL_INTENSITY_KEYS: readonly Key[] = [[-18, 0.04], [-8, 0.04], [-3, 0.05], [4, 0.1], [14, FILL_INTENSITY], [40, 0.17], [70, 0.19]];
const FOG_COLOR_KEYS: readonly Key[] = [[-18, 0x060a14], [-8, 0x161a2c], [-3, 0x5e5468], [4, 0xd49c7c], [14, FOG_COLOR], [35, 0xd8dade], [70, 0xc8d4e2]];
const ENV_INTENSITY_KEYS: readonly Key[] = [[-18, 0.16], [-8, 0.18], [-3, 0.3], [4, 0.7], [14, 1], [70, 1.1]];
const EXPOSURE_KEYS: readonly Key[] = [[-18, 1.65], [-8, 1.58], [-3, 1.5], [4, 1.32], [14, EXPOSURE], [35, 1.08], [70, 1.05]];
const NIGHT_FILL_SKY = 0x182542;
/** Fill added on a fully overcast night */
const NIGHT_OVERCAST_FILL = 0.1;
const NIGHT_FILL_GROUND = 0x070a10;
const OVERCAST_SUN = 0xe6e8ea;
const OVERCAST_FOG = 0xb2b6ba;
const RAIN_FOG = 0x8c9297;
const OVERCAST_FILL_SKY = 0xc6cad0;
const WET_FILL_GROUND = 0x4c4c40;

interface SkyLook {
  turbidity: number;
  rayleigh: number;
  cloudCoverage: number;
  cloudDensity: number;
  radianceScale: number;
  /** The night sky's glow and its stars, 0..1 (night-sky.ts) */
  nightSky: number;
  nightStars: number;
}

function skyLookFor(c: SkyConditions, out: SkyLook): SkyLook {
  const cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
  const rain = THREE.MathUtils.clamp(c.rain, 0, 1);
  const nightShare = nightShareOf(c.elevationDeg);
  out.turbidity = SKY_TURBIDITY + 6 * cloud;
  out.rayleigh = SKY_RAYLEIGH * (1 - 0.5 * cloud);
  // 0 keeps the Sky shader's cloud pass off entirely on a clear day
  out.cloudCoverage = cloud < 0.02 ? 0 : cloud;
  out.cloudDensity = 0.4 + 0.45 * cloud + 0.15 * rain;
  out.radianceScale = SKY_RADIANCE_SCALE * (1 - 0.35 * rain) * (1 - 0.94 * nightShare);
  out.nightSky = nightShare * (1 - 0.4 * rain);
  out.nightStars = starShare(nightShare, cloud, rain);
  return out;
}

function applySkyLook(sky: Sky, sunDir: THREE.Vector3, look: SkyLook): void {
  const u = sky.material.uniforms;
  u.turbidity.value = look.turbidity;
  u.rayleigh.value = look.rayleigh;
  u.cloudCoverage.value = look.cloudCoverage;
  u.cloudDensity.value = look.cloudDensity;
  u.skyRadianceScale.value = look.radianceScale;
  u.nightSky.value = look.nightSky;
  u.nightStars.value = look.nightStars;
  (u.sunPosition.value as THREE.Vector3).copy(sunDir);
}

/** Bakes the Sky into a 256 px PMREM cube (three r187+). The sun disc is hidden during the bake
 *  so its ~60000 radiance does not dominate the prefiltered environment. Below the horizon a dark, sunlit ground
 *  stands in for the circuit: the Sky shader carries its horizon colour all the way down, which lit undersides and
 *  sills from below as brightly as the horizon and made reflections of the ground glow. */
interface GroundLight {
  color: THREE.Color;
  intensity: number;
}

class SkyBaker {
  private readonly scene = new THREE.Scene();
  private readonly sky = new Sky();
  private readonly ground: THREE.Mesh<THREE.CircleGeometry, THREE.MeshLambertMaterial>;
  private readonly groundSun = new THREE.DirectionalLight();
  private readonly groundFill = new THREE.HemisphereLight();
  private pmrem: THREE.PMREMGenerator | null;
  /** The bake scene filmed from the origin, as PMREMGenerator.fromScene would (same size, near and far) */
  private readonly cubeTarget = new THREE.WebGLCubeRenderTarget(ENV_SIZE, { type: THREE.HalfFloatType, generateMipmaps: false });
  private readonly cubeCamera = new THREE.CubeCamera(0.1, 1000, this.cubeTarget);
  /** The environment map: one target, filtered again in place by every bake */
  private target: THREE.WebGLCubeRenderTarget | null = null;
  private readonly clearColor = new THREE.Color();

  /** The physical sky's sun-less quad, baked in place of the classic sky while it shows */
  private physicalSky: THREE.Object3D | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(1000);
    configureSkyUniforms(this.sky, false);
    this.scene.add(this.sky);
    // Tarmac, grass and run-off seen from a car: a dark, slightly warm grey
    this.ground = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshLambertMaterial({ color: GROUND_ALBEDO }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -1.5;
    this.scene.add(this.ground, this.groundSun, this.groundFill);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  setPhysicalSky(quad: THREE.Object3D): void {
    this.physicalSky = quad;
    this.scene.add(quad);
  }

  /** Bakes the sky into the environment map and returns its texture: the same texture on every call */
  bake(sunDir: THREE.Vector3, keyDir: THREE.Vector3, look: SkyLook, sun: GroundLight, fill: THREE.HemisphereLight): THREE.Texture {
    applySkyLook(this.sky, sunDir, look);
    // the night sky's glow lights the bake; its stars would only speckle the reflections
    this.sky.material.uniforms.nightStars.value = 0;
    this.sky.visible = !this.physicalSky?.visible;
    // The ground takes the scene's own key (sun, moon or floodlight) and sky fill, so it sits at the real circuit's brightness
    this.groundSun.color.copy(sun.color);
    this.groundSun.intensity = sun.intensity;
    this.groundSun.position.copy(keyDir).multiplyScalar(100);
    this.groundFill.color.copy(fill.color);
    this.groundFill.groundColor.copy(fill.groundColor);
    const dayFloor = THREE.MathUtils.clamp((sunDir.y + 0.08) / 0.22, 0.05, 1);
    this.groundFill.intensity = Math.max(fill.intensity, GROUND_SKY_LIGHT * dayFloor);
    // Filmed here, then prefiltered into the same target every time: fromScene allocated a new one per bake, which
    // handed every lit material a new environment map to look its program up for and churned GPU memory. Every face
    // is cleared whatever the app's clear settings (the composer turns autoClear off), with the clear colour behind
    // the sky, as fromScene does
    const r = this.renderer;
    const { autoClear, autoClearColor, autoClearDepth, autoClearStencil } = r;
    r.autoClear = r.autoClearColor = r.autoClearDepth = r.autoClearStencil = true;
    this.scene.background = r.getClearColor(this.clearColor);
    try {
      this.cubeCamera.update(r, this.scene);
    } finally {
      r.autoClear = autoClear;
      r.autoClearColor = autoClearColor;
      r.autoClearDepth = autoClearDepth;
      r.autoClearStencil = autoClearStencil;
      this.scene.background = null;
    }
    this.target = this.pmrem!.fromCubemap(this.cubeTarget.texture, this.target);
    return this.target.texture;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.cubeTarget.dispose();
    this.pmrem?.dispose();
    this.pmrem = null;
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    // The physical sky's quad is the PhysicalSky's to dispose
    this.scene.clear();
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function createGoldenHourEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  /**
   * `physicalSky`: allow the physically based sky on Medium and High (default false: the classic sky everywhere).
   * `deferPhysicalSky`: build it only after startPhysicalSky()
   */
  options: { physicalSky?: boolean; deferPhysicalSky?: boolean } = {}
): GoldenHourEnvironment {
  const sunDirection = sunDirectionUnit();

  // Scratch vector, reused every frame so update() does not allocate.
  const scratch = new THREE.Vector3();

  // --- Sky (visible dome) ---------------------------------------------------
  const sky = new Sky();
  sky.scale.setScalar(SKY_SCALE);
  sky.frustumCulled = false;
  // Drawn after opaque geometry so early-Z rejects sky pixels hidden by the car/track.
  sky.renderOrder = 1000;
  configureSkyUniforms(sky, true);
  scene.add(sky);

  // The physical sky (Medium / High) is built the first time it is needed and takes over from the classic sky once its
  // lookup tables are computed (a fraction of a second); until then, on Low and if that fails, the classic sky shows
  let physicalSky: PhysicalSky | null = null;

  // --- Environment map (PMREM, re-baked only when the sky changes visibly) ---
  const baker = new SkyBaker(renderer);
  const skyLook = skyLookFor(GOLDEN_HOUR_SKY, {} as SkyLook);
  const skySunDir = sunDirection.clone();
  // The first bake, before the scene's lights exist: their starting values. Later bakes refresh this same texture
  const envMap = baker.bake(
    skySunDir,
    sunDirection,
    skyLook,
    { color: new THREE.Color(SUN_COLOR), intensity: SUN_INTENSITY },
    new THREE.HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY)
  );
  let baked: SkyConditions = { ...GOLDEN_HOUR_SKY };
  let lastBakeMs = -Infinity;
  let pendingBake = false;
  scene.environment = envMap;
  scene.environmentIntensity = 1.0;
  scene.background = null;

  const fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.fog = fog;

  // --- Weak fill ------------------------------------------------------------
  const fillLight = new THREE.HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY);
  scene.add(fillLight);

  // --- Sun ------------------------------------------------------------------
  // Cascaded shadow maps: each frame the renderer fits two orthographic cascades to slices of the rendering
  // camera's frustum (out to SHADOW_DISTANCE_M) and snaps them to whole texels, so shadows stay sharp near the
  // car, reach the scenery behind it and do not crawl as the camera moves.
  // A SunLight has no target: it shines from its position towards the origin.
  const sunLight = new SunLight(SUN_COLOR, SUN_INTENSITY);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  // near: margin in front of the casters nearest the sun; far: the cascades' reach from the camera
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = SHADOW_DISTANCE_M;
  // With any layer besides 0 enabled, the shadow pass (three r187+) picks casters by the shadow camera's layers
  // instead of the view camera's: the helmet keeps casting while the cockpit camera leaves it out.
  sunLight.shadow.camera.layers.enable(DRIVER_HEAD_LAYER);
  // Shadow-only stand-ins (the middle-distance trees cast with lighter crowns)
  sunLight.shadow.camera.layers.enable(SHADOW_PROXY_LAYER);

  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  sunLight.shadow.radius = 2.5;

  sunLight.position.copy(sunDirection).multiplyScalar(SUN_DISTANCE_M);
  scene.add(sunLight);

  let disposed = false;
  let current: SkyConditions = { ...GOLDEN_HOUR_SKY };
  let floodlit: Readonly<FloodlitNightLook> | null = null;
  const tint = new THREE.Color();
  let cloudSeed = 1;
  /** Where the classic sky's drifting clouds start (s on its cloud clock), from the cloud seed */
  let classicCloudClockS = 0;

  const rebake = () => {
    baker.bake(skySunDir, sunDirection, skyLook, sunLight, fillLight);
    baked = { ...current };
    lastBakeMs = performance.now();
    pendingBake = false;
  };
  const syncFogDensity = () => {
    // On High desktop with physical aerial perspective active, scale back the clear-sky exponential fog so
    // Bruneton Rayleigh/Mie scattering carries the horizon depth without double-fogging; keep overcast & rain fog intact.
    const baseFog = physicalSky?.aerialActive ? FOG_DENSITY * 0.28 : FOG_DENSITY;
    fog.density = baseFog + FOG_DENSITY * 1.2 * current.cloud + 0.0022 * Math.pow(current.rain, 1.2);
  };
  /** Shows whichever sky the preset and the physical sky's readiness call for, and re-bakes the environment from it */
  const applySkyChoice = () => {
    if (disposed) return;
    sky.visible = !physicalSky?.showing;
    syncFogDensity();
    rebake();
  };

  let physicalSkyHeld = options.deferPhysicalSky === true;
  let qualityNow: "low" | "medium" | "high" = "high";
  let aerialAllowedNow = true;
  const setQuality = (quality: "low" | "medium" | "high", aerialAllowed = quality === "high") => {
    if (disposed) return;
    qualityNow = quality;
    aerialAllowedNow = aerialAllowed;
    if (!physicalSky && options.physicalSky && !physicalSkyHeld && quality !== "low") {
      physicalSky = new PhysicalSky(renderer, applySkyChoice);
      scene.add(physicalSky.mesh);
      baker.setPhysicalSky(physicalSky.bakeMesh);
      physicalSky.setSeed(cloudSeed);
      physicalSky.setConditions({
        sunDirection: skySunDir,
        cloud: current.cloud,
        rain: current.rain,
        windVxMs: current.windVxMs,
        windVzMs: current.windVzMs,
      });
    }
    if (!physicalSky) return;
    const wasShowing = physicalSky.showing;
    physicalSky.setQuality(quality, aerialAllowed);
    syncFogDensity();
    if (physicalSky.showing !== wasShowing) applySkyChoice();
  };

  // The probe keeps this switch object; it forwards to the sky on show now
  const sunDiscSwitch = {
    get value(): number {
      return ((physicalSky?.showing ? physicalSky.mesh : sky).material.uniforms.showSunDisc as { value: number }).value;
    },
    set value(v: number) {
      ((physicalSky?.showing ? physicalSky.mesh : sky).material.uniforms.showSunDisc as { value: number }).value = v;
    },
  };

  const setConditions = (c: SkyConditions) => {
    if (disposed) return;
    const e = c.elevationDeg;
    const cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
    const rain = THREE.MathUtils.clamp(c.rain, 0, 1);
    current = { elevationDeg: e, azimuthDeg: c.azimuthDeg, cloud, rain, windVxMs: c.windVxMs, windVzMs: c.windVzMs };

    const nightShare = nightShareOf(e);
    // Sun: the light never comes from below the horizon (shadows stay sane at dawn / dusk); between -2° and -6° it
    // smoothly arcs over to a high cool moon so shadows never abruptly flip while headlights carry the road lighting
    const moonBlend = THREE.MathUtils.smoothstep(-e, 2, 6);
    if (moonBlend <= 0) {
      sunDirection.copy(sunDirectionUnit(Math.max(1, e), c.azimuthDeg));
    } else if (moonBlend >= 1) {
      sunDirection.copy(sunDirectionUnit(35, (c.azimuthDeg + 180) % 360));
    } else {
      const dayDir = sunDirectionUnit(Math.max(1, e), c.azimuthDeg);
      const moonDir = sunDirectionUnit(35, (c.azimuthDeg + 180) % 360);
      sunDirection.copy(dayDir).lerp(moonDir, moonBlend);
      if (sunDirection.lengthSq() < 1e-4) sunDirection.set(0, 1, 0);
      else sunDirection.normalize();
    }
    // Under floodlights the night's key light stands steep over the circuit instead
    const flood = floodlit && nightShare > 0 ? floodlit : null;
    if (flood) sunDirection.lerp(sunDirectionUnit(flood.keyElevationDeg, (c.azimuthDeg + 180) % 360), nightShare).normalize();
    skySunDir.copy(sunDirectionUnit(e, c.azimuthDeg));
    sunLight.position.copy(sunDirection).multiplyScalar(SUN_DISTANCE_M);
    colorCurve(SUN_COLOR_KEYS, e, sunLight.color).lerp(tint.setHex(OVERCAST_SUN), 0.6 * cloud * (1 - nightShare));
    // Cloud blocks most direct sun; an overcast sky still leaves faint, soft shadows
    sunLight.intensity = curve(SUN_INTENSITY_KEYS, e) * (1 - 0.88 * Math.pow(cloud, 1.5));

    // Fill: an overcast sky lights everything from above; at night it deepens to cool indigo
    fillLight.color.setHex(FILL_SKY).lerp(tint.setHex(OVERCAST_FILL_SKY), cloud).lerp(tint.setHex(NIGHT_FILL_SKY), nightShare);
    fillLight.groundColor.setHex(FILL_GROUND).lerp(tint.setHex(WET_FILL_GROUND), rain).lerp(tint.setHex(NIGHT_FILL_GROUND), nightShare);
    // (an overcast night is lit from the whole sky by the glow under the clouds, the moon hidden behind them)
    fillLight.intensity = curve(FILL_INTENSITY_KEYS, e) * (1 + 1.1 * cloud) + NIGHT_OVERCAST_FILL * nightShare * cloud;

    colorCurve(FOG_COLOR_KEYS, e, fog.color)
      .lerp(tint.setHex(OVERCAST_FOG), 0.8 * cloud * (1 - 0.9 * nightShare))
      .lerp(tint.setHex(RAIN_FOG), rain * (1 - 0.9 * nightShare));
    // A low sun dims the overcast / rain haze too (at night the haze keeps the night's own colour: dimmed as well it
    // went black, and an overcast night with it)
    if (cloud > 0 && e < 14) fog.color.multiplyScalar(1 - cloud * (1 - curve(ENV_INTENSITY_KEYS, e)) * (1 - nightShare));
    syncFogDensity();

    scene.environmentIntensity = curve(ENV_INTENSITY_KEYS, e) * (1 - 0.25 * rain);
    renderer.toneMappingExposure = curve(EXPOSURE_KEYS, e) * (1 + 0.3 * cloud);
    if (flood) {
      // Cloud does not dim a floodlight; rain and cloud keep their share of the haze
      sunLight.color.lerp(tint.setHex(flood.keyColor), nightShare);
      sunLight.intensity = THREE.MathUtils.lerp(sunLight.intensity, flood.keyIntensity, nightShare);
      fillLight.intensity = THREE.MathUtils.lerp(fillLight.intensity, flood.fillIntensity, nightShare);
      fog.color.lerp(tint.setHex(flood.fogColor), nightShare);
      scene.environmentIntensity = THREE.MathUtils.lerp(scene.environmentIntensity, flood.environmentIntensity, nightShare);
      renderer.toneMappingExposure = THREE.MathUtils.lerp(renderer.toneMappingExposure, flood.exposure, nightShare);
    }

    skyLookFor(current, skyLook);
    applySkyLook(sky, skySunDir, skyLook);
    physicalSky?.setConditions({ sunDirection: skySunDir, cloud, rain, windVxMs: c.windVxMs, windVzMs: c.windVzMs });
    const dElev = Math.abs(e - baked.elevationDeg);
    const dCloud = Math.abs(cloud - baked.cloud);
    const dRain = Math.abs(rain - baked.rain);
    if (dElev > 1 || Math.abs(c.azimuthDeg - baked.azimuthDeg) > 2 || dCloud > 0.05 || dRain > 0.05) pendingBake = true;
    // A big jump (a new session) re-bakes at once; a slow drift waits for the minimum interval
    const big = dElev > 8 || dCloud > 0.3 || dRain > 0.3;
    if (pendingBake && (big || performance.now() - lastBakeMs > REBAKE_MIN_S * 1000)) rebake();
  };

  return {
    sunLight,
    sunDirection,
    sky,
    get physicalSky() {
      return physicalSky;
    },
    probeSky: { material: { uniforms: { showSunDisc: sunDiscSwitch } } },
    fillLight,

    update(_carWorldPos: THREE.Vector3, camera: THREE.Camera): void {
      if (disposed) return;

      camera.getWorldPosition(scratch);
      sky.position.copy(scratch);
      // Drifting clouds (the Sky shader skips them at zero coverage), from where this session's seed starts them
      if (sky.material.uniforms.cloudCoverage.value > 0) sky.material.uniforms.time.value = classicCloudClockS + performance.now() / 1000;
      if (pendingBake && performance.now() - lastBakeMs > REBAKE_MIN_S * 1000) rebake();
    },

    setConditions,
    setFloodlitNight(look): void {
      if (disposed || look === floodlit) return;
      floodlit = look;
      setConditions(current);
      // the environment's ground is lit by the key light: bake it again if it is night now
      if (nightShareOf(current.elevationDeg) > 0) pendingBake = true;
    },
    setCloudSeed(seed: number): void {
      if (disposed) return;
      cloudSeed = seed;
      classicCloudClockS = (Math.abs(Math.floor(seed)) % 10007) * 0.9;
      physicalSky?.setSeed(seed);
    },
    get cloudTypes(): string[] {
      return physicalSky?.showing ? physicalSky.cloudTypes : [];
    },
    setQuality,
    startPhysicalSky(): void {
      if (!physicalSkyHeld) return;
      physicalSkyHeld = false;
      setQuality(qualityNow, aerialAllowedNow);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;

      scene.remove(sky, fillLight, sunLight);
      if (scene.environment === envMap) scene.environment = null;
      if (scene.fog === fog) scene.fog = null;

      sky.geometry.dispose();
      sky.material.dispose();
      sunLight.shadow.dispose();
      // The environment map with it
      baker.dispose();
      physicalSky?.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

/**
 * Zero-pass HDR-safe AMD FidelityFX RCAS (5-tap contrast-adaptive sharpening) merged directly into the terminal
 * EffectPass before AgX tone mapping. Compresses linear HDR luma via Reinhard sqrt so sun discs and bright glints
 * never ring, fades out smoothly wherever clouds or bloom modified the pixel vs `inputBuffer`, and skips all 4
 * neighbour taps via a uniform branch when `uSharpness <= 0.001` (native resolution).
 */
class RcasEffect extends Effect {
  constructor(sharpness = 0) {
    super(
      "RcasEffect",
      /* glsl */ `
uniform float uSharpness;
float lcRcasLuma(const in vec3 c) {
  float y = max(dot(max(c, vec3(0.0)), vec3(0.2126, 0.7152, 0.0722)), 0.0);
  return sqrt(y / (1.0 + y));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  if (uSharpness <= 0.001) {
    outputColor = inputColor;
    return;
  }
  vec3 rawE = max(texture2D(inputBuffer, uv).rgb, vec3(0.0));
  vec3 curE = max(inputColor.rgb, vec3(0.0));
  float rawY = dot(rawE, vec3(0.2126, 0.7152, 0.0722));
  if (rawY <= 1e-4) {
    outputColor = inputColor;
    return;
  }
  // Fade sharpening where preceding clouds/bloom significantly altered this pixel vs inputBuffer
  float diff = length(curE - rawE) / max(0.25, length(curE) + length(rawE));
  float strength = uSharpness * (1.0 - smoothstep(0.08, 0.28, diff));
  if (strength <= 0.001) {
    outputColor = inputColor;
    return;
  }
  float lE = sqrt(rawY / (1.0 + rawY));
  float lN = lcRcasLuma(texture2D(inputBuffer, uv + vec2(0.0, -texelSize.y)).rgb);
  float lS = lcRcasLuma(texture2D(inputBuffer, uv + vec2(0.0,  texelSize.y)).rgb);
  float lW = lcRcasLuma(texture2D(inputBuffer, uv + vec2(-texelSize.x, 0.0)).rgb);
  float lR = lcRcasLuma(texture2D(inputBuffer, uv + vec2( texelSize.x, 0.0)).rgb);
  float mnL = min(lE, min(min(lN, lS), min(lW, lR)));
  float mxL = max(lE, max(max(lN, lS), max(lW, lR)));
  float amp = sqrt(clamp(min(mnL, 1.0 - mxL) / max(mxL, 1e-4), 0.0, 1.0));
  float w = amp * mix(0.0, -0.20, strength);
  float sharpL = clamp((lE + w * (lN + lS + lW + lR)) / (1.0 + 4.0 * w), 0.0, 0.995);
  float targetY = (sharpL * sharpL) / max(1.0 - sharpL * sharpL, 1e-4);
  float gain = clamp(targetY / rawY, 0.65, 1.50);
  outputColor = vec4(curE * gain, inputColor.a);
}
`,
      {
        uniforms: new Map<string, THREE.Uniform>([["uSharpness", new THREE.Uniform(sharpness)]]),
      }
    );
  }

  setSharpness(amount: number): void {
    (this.uniforms.get("uSharpness") as THREE.Uniform<number>).value = amount;
  }
}

/**
 * Contrast about mid-grey and saturation about luma, on the tone-mapped image; alpha forced opaque. Then the off-track
 * edge glow, when on: the HUD's colour fading in from 62 % of the way to the corners to 32 % at them, on an ellipse
 * the screen's shape. Drawn here, it costs a few instructions in a pass that runs anyway, where a full-screen page
 * layer over the canvas, animated every frame, gave the browser the whole screen to composite again each frame.
 */
class DisplayGradeEffect extends Effect {
  constructor(contrast: number, saturation: number) {
    super(
      "DisplayGradeEffect",
      /* glsl */ `
uniform float uContrast;
uniform float uSaturation;
uniform float uEdgeGlow;
uniform vec3 uEdgeColor;
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // grade in a perceptual (gamma 2.2) space so the contrast pivots on mid-grey as seen, then back to linear
  vec3 c = pow(clamp(inputColor.rgb, 0.0, 1.0), vec3(1.0 / 2.2));
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 1.0 + uSaturation);
  if (uEdgeGlow > 0.0) {
    // blended in the same display space the page's layer was composited in
    float r = length((uv - 0.5) * 2.0) * 0.70710678;
    c = mix(clamp(c, 0.0, 1.0), uEdgeColor, clamp((r - 0.62) / 0.38, 0.0, 1.0) * 0.32 * uEdgeGlow);
  }
  outputColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(2.2)), 1.0);
}
`,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ["uContrast", new THREE.Uniform(contrast)],
          ["uSaturation", new THREE.Uniform(saturation)],
          ["uEdgeGlow", new THREE.Uniform(0)],
          ["uEdgeColor", new THREE.Uniform(new THREE.Vector3(1, 42 / 255, 60 / 255))],
        ]),
      }
    );
  }

  /** 0 hides the edge glow; `color` is in display (sRGB) components */
  setEdgeGlow(level: number, color?: THREE.Vector3): void {
    (this.uniforms.get("uEdgeGlow") as THREE.Uniform<number>).value = level;
    if (color) (this.uniforms.get("uEdgeColor") as THREE.Uniform<THREE.Vector3>).value.copy(color);
  }
}

/** The page's breathing: 55 % to full and back over 1.8 s, eased at each end like CSS's ease-in-out */
const EDGE_GLOW_PERIOD_MS = 1800;
const edgeGlowLevel = (sinceMs: number): number => {
  const p = (sinceMs % EDGE_GLOW_PERIOD_MS) / EDGE_GLOW_PERIOD_MS;
  const u = p < 0.5 ? p * 2 : 2 - p * 2;
  return 0.55 + 0.45 * u * u * (3 - 2 * u);
};

/** A CSS hex colour (#rgb or #rrggbb) as display components 0..1, else null */
const hexColor = (css: string): THREE.Vector3 | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1];
  const n = parseInt(hex, 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts?: { multisampling?: number }
): PostFx {
  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: opts?.multisampling ?? 4,
  });
  // `outputBuffer` only ever receives fullscreen post passes (cloudsPass on High), never 3D geometry, so keeping its
  // samples at 0 avoids a duplicate MSAA HalfFloat allocation and a redundant second MSAA resolve blit per frame.
  const keepOutputNonMsaa = () => {
    if (composer.outputBuffer.samples !== 0) {
      composer.outputBuffer.samples = 0;
      composer.outputBuffer.dispose();
    }
  };
  keepOutputNonMsaa();

  const renderPass = new RenderPass(scene, camera);
  renderPass.needsDepthBlit = false;
  // Volumetric clouds (physical sky only, added by setClouds):
  // - On High (with bloom): `cloudsPass` composites clouds into the non-MSAA `outputBuffer` before `bloomPass`, so
  //   bright cloud edges bloom too.
  // - On Medium / non-bloom: `cloudsPlainPass` merges clouds + AgX + display grade into ONE fullscreen pass straight
  //   to screen, eliminating the intermediate HalfFloat write+read round-trip (and when MSAA is off, reading
  //   `inputBuffer.depthTexture` directly with zero depth-copy blits).
  let sky: {
    readonly clouds: CloudsEffect;
    readonly cloudsActive: boolean;
    readonly aerialPerspective?: AerialPerspectiveEffect;
    readonly aerialActive?: boolean;
  } | null = null;
  let cloudsPass: EffectPass | null = null;
  let aerialPass: EffectPass | null = null;
  let cloudsPlainPass: EffectPass | null = null;
  let mainCamera = camera;

  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 1.1,
    luminanceSmoothing: 0.1,
    intensity: 0.4,
    radius: 0.7,
    levels: 5,
  });

  // One merged pass to the screen: bloom runs on linear HDR, then AgX, then the grade.
  // AgX is applied here because EffectPass ignores renderer.toneMapping. It keeps highlights but reads flat and grey on
  // its own (the scanned circuits' bland, hazy look): a light display-referred grade after it puts back some contrast
  // and colour, with alpha forced to 1 and the result clamped (postprocessing's stock BrightnessContrast /
  // HueSaturation effects turned the low-alpha texels blended foliage, fences and decals leave in the buffer into
  // white specks). The grade had a pass of its own; here it runs the same code without the round trip through a
  // half-float buffer (whose rounding was the only difference), a full-screen write and read saved per frame,
  // multisampled on High and Medium.
  // The RCAS & grade effects of each terminal pass below: sharpness and edge glow are synced across all of them
  const rcasEffects: RcasEffect[] = [];
  const grades: DisplayGradeEffect[] = [];
  let sharpnessNow = 0;
  let edgeGlowColor: THREE.Vector3 | null = null;
  const toneMapAndGrade = () => {
    const rcas = new RcasEffect(sharpnessNow);
    rcasEffects.push(rcas);
    const grade = new DisplayGradeEffect(GRADE_CONTRAST, GRADE_SATURATION);
    if (edgeGlowSinceMs !== null) {
      grade.setEdgeGlow(edgeGlowSteady ? 1 : edgeGlowLevel(performance.now() - edgeGlowSinceMs), edgeGlowColor ?? undefined);
    }
    grades.push(grade);
    return [rcas, new ToneMappingEffect({ mode: ToneMappingMode.AGX }), grade];
  };
  // When the edge glow came on (null: off), and whether it holds still for reduced motion
  let edgeGlowSinceMs: number | null = null;
  let edgeGlowSteady = false;
  const bloomPass = new EffectPass(camera, bloom, ...toneMapAndGrade());
  // Low and cloudless Medium have no bloom and no clouds: the same pass without either.
  const plainPass = new EffectPass(camera, ...toneMapAndGrade());
  plainPass.enabled = false;
  // Terminal passes end the chain and one runs at a time, so each draws to the screen itself. Set before they are
  // added, this also stops the composer moving the screen output to whichever pass is last
  bloomPass.renderToScreen = true;
  plainPass.renderToScreen = true;

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(plainPass);

  const syncPassRouting = () => {
    const cloudsOn = Boolean(sky?.cloudsActive && cloudsPass && cloudsPlainPass);
    const bloomOn = bloomPass.enabled;
    const aerialOnlyOn = Boolean(bloomOn && !cloudsOn && sky?.aerialActive && aerialPass);
    if (cloudsPass) cloudsPass.enabled = cloudsOn && bloomOn;
    if (aerialPass) aerialPass.enabled = aerialOnlyOn;
    if (cloudsPlainPass) cloudsPlainPass.enabled = cloudsOn && !bloomOn;
    plainPass.enabled = !bloomOn && !cloudsOn;
    if (!cloudsOn && !aerialOnlyOn) {
      renderPass.needsDepthBlit = false;
      return;
    }
    // Non-MSAA single-pass clouds straight to screen: inputBuffer is never written to after RenderPass, so clouds can
    // sample inputBuffer.depthTexture directly without a full-screen depth blit.
    const directDepth = !bloomOn && composer.multisampling === 0 && composer.inputBuffer.depthTexture;
    if (directDepth && cloudsPlainPass) {
      if (cloudsPlainPass.getDepthTexture() !== directDepth) cloudsPlainPass.setDepthTexture(directDepth);
      renderPass.needsDepthBlit = false;
    } else {
      const stable = (composer as unknown as { stableDepthTexture?: THREE.DepthTexture | null }).stableDepthTexture ?? null;
      if (cloudsPlainPass && stable && cloudsPlainPass.getDepthTexture() !== stable) cloudsPlainPass.setDepthTexture(stable);
      if (cloudsPass && stable && cloudsPass.getDepthTexture() !== stable) cloudsPass.setDepthTexture(stable);
      if (aerialPass && stable && aerialPass.getDepthTexture() !== stable) aerialPass.setDepthTexture(stable);
      renderPass.needsDepthBlit = true;
    }
  };

  return {
    composer,

    render(dtSeconds: number): void {
      syncPassRouting();
      if (edgeGlowSinceMs !== null) {
        const level = edgeGlowSteady ? 1 : edgeGlowLevel(performance.now() - edgeGlowSinceMs);
        for (const grade of grades) grade.setEdgeGlow(level);
      }
      composer.render(dtSeconds);
    },

    setSize(width: number, height: number): void {
      composer.setSize(width, height);
    },

    setCamera(next: THREE.Camera): void {
      mainCamera = next;
      renderPass.mainCamera = next;
      if (cloudsPass) cloudsPass.mainCamera = next;
      if (aerialPass) aerialPass.mainCamera = next;
      if (cloudsPlainPass) cloudsPlainPass.mainCamera = next;
      bloomPass.mainCamera = next;
      plainPass.mainCamera = next;
    },

    setQuality(quality: "low" | "medium" | "high", msaa = true, bloom = quality === "high" && msaa): void {
      const touch = isTouchDevice();
      // Tile-based mobile GPUs suffer heavy DRAM bandwidth penalties resolving HalfFloat MSAA buffers, so touch stays 0×
      composer.multisampling = !msaa || touch ? 0 : quality === "high" ? 4 : quality === "medium" ? 2 : 0;
      keepOutputNonMsaa();
      bloomPass.enabled = bloom && quality === "high";
      syncPassRouting();
    },

    setClouds(next): void {
      if (cloudsPass) return;
      sky = next;
      const includeAerial = Boolean(next.aerialPerspective && !isTouchDevice());
      // On High desktop, merge AerialPerspectiveEffect (transmittance + inscatter + drifting cloud ground shadows)
      // directly into the pre-bloom clouds pass with zero extra FBO or fullscreen draw; keep a cloudless fallback pass.
      cloudsPass = includeAerial
        ? new EffectPass(mainCamera, next.aerialPerspective!, next.clouds)
        : new EffectPass(mainCamera, next.clouds);
      // EffectPass gives its camera to its own material only; the clouds/aerial effects read mainCamera directly
      cloudsPass.mainCamera = mainCamera;
      cloudsPass.enabled = false;
      if (includeAerial) {
        aerialPass = new EffectPass(mainCamera, next.aerialPerspective!);
        aerialPass.mainCamera = mainCamera;
        aerialPass.enabled = false;
      }
      cloudsPlainPass = new EffectPass(mainCamera, next.clouds, ...toneMapAndGrade());
      cloudsPlainPass.mainCamera = mainCamera;
      cloudsPlainPass.renderToScreen = true;
      cloudsPlainPass.enabled = false;
      composer.addPass(cloudsPass, 1);
      if (aerialPass) composer.addPass(aerialPass, 2);
      composer.addPass(cloudsPlainPass);
      syncPassRouting();
    },

    setSharpness(amount: number): void {
      sharpnessNow = THREE.MathUtils.clamp(amount, 0, 1);
      for (const rcas of rcasEffects) rcas.setSharpness(sharpnessNow);
    },

    setEdgeGlow(color: string | null): void {
      if (color === null) {
        if (edgeGlowSinceMs === null) return;
        edgeGlowSinceMs = null;
        edgeGlowColor = null;
        for (const grade of grades) grade.setEdgeGlow(0);
        return;
      }
      const rgb = hexColor(color);
      if (rgb) edgeGlowColor = rgb;
      for (const grade of grades) grade.setEdgeGlow(1, rgb ?? undefined);
      edgeGlowSinceMs = performance.now();
      edgeGlowSteady = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    },

    dispose(): void {
      // EffectPass.dispose() also disposes the bloom, tone-mapping and grade effects, and the clouds (which the
      // PhysicalSky disposes again: three's dispose calls are idempotent)
      composer.removeAllPasses();
      renderPass.dispose();
      cloudsPass?.dispose();
      aerialPass?.dispose();
      cloudsPlainPass?.dispose();
      bloomPass.dispose();
      plainPass.dispose();
      composer.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Car rear rain light
// ---------------------------------------------------------------------------

// Original material -> its emissive clone, so repeated calls share one clone per original.
const rearRainCloneOf = new WeakMap<THREE.Material, THREE.Material>();
// Clones created here; used so a second call does not clone a clone.
const rearRainClones = new WeakSet<THREE.Material>();

/**
 * Clones every material named EXT_clearled_security under carRoot (once per
 * original) and makes it an emissive red light. Returns the clones so the sim
 * can flash them.
 */
export function applyRearRainLight(carRoot: THREE.Object3D): THREE.Material[] {
  const out = new Set<THREE.Material>();

  const resolve = (material: THREE.Material): THREE.Material => {
    if (rearRainClones.has(material)) {
      out.add(material);
      return material;
    }
    if (material.name !== REAR_RAIN_MATERIAL_NAME) return material;

    let clone = rearRainCloneOf.get(material);
    if (!clone) {
      clone = material.clone();
      if (clone instanceof THREE.MeshStandardMaterial) {
        clone.color.set(REAR_RAIN_BASE_COLOR);
        clone.emissive.set(REAR_RAIN_EMISSIVE);
        clone.emissiveIntensity = REAR_RAIN_EMISSIVE_INTENSITY;
      }
      clone.toneMapped = true;
      rearRainCloneOf.set(material, clone);
      rearRainClones.add(clone);
    }
    out.add(clone);
    return clone;
  };

  carRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map(resolve);
    } else {
      mesh.material = resolve(mesh.material);
    }
  });

  return Array.from(out);
}
