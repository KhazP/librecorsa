import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from "postprocessing";

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
 *     same EffectPass as bloom. It reads the three.js toneMappingExposure
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
 *   (sun > 1 deg, cloud / rain > 0.05) and at most every 1.5 s.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUN_ELEVATION_DEG = 14;
const SUN_AZIMUTH_DEG = 127;
const SUN_DISTANCE_M = 220;

const SHADOW_MAP_SIZE = 2048;
const SHADOW_HALF_SPAN_M = 55;
const SHADOW_FRUSTUM_M = SHADOW_HALF_SPAN_M * 2;
const SHADOW_TEXEL_M = SHADOW_FRUSTUM_M / SHADOW_MAP_SIZE;

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
const FILL_INTENSITY = 0.35;
const EXPOSURE = 1.15;
const SKY_TURBIDITY = 2.8;
const SKY_RAYLEIGH = 1.8;
/** Minimum time between environment re-bakes (s) */
const REBAKE_MIN_S = 1.5;

const REAR_RAIN_MATERIAL_NAME = "EXT_clearled_security";
const REAR_RAIN_EMISSIVE = 0xff1100;
const REAR_RAIN_EMISSIVE_INTENSITY = 10.0;
const REAR_RAIN_BASE_COLOR = 0x2a0000;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

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
}

/** The original look: clear sky, sun at 14 deg / 127 deg */
export const GOLDEN_HOUR_SKY: Readonly<SkyConditions> = {
  elevationDeg: SUN_ELEVATION_DEG,
  azimuthDeg: SUN_AZIMUTH_DEG,
  cloud: 0,
  rain: 0,
};

export interface GoldenHourEnvironment {
  sunLight: THREE.DirectionalLight;
  /** unit vector from scene towards the sun */
  sunDirection: THREE.Vector3;
  sky: Sky;
  /** Weak warm-blue / olive fill; added to the scene by createGoldenHourEnvironment. */
  fillLight: THREE.HemisphereLight;
  /** Call once per frame before rendering: keeps the +/-55 m shadow frustum centred on the car (texel-snapped to avoid shimmering) and the sky dome centred on the camera */
  update(carWorldPos: THREE.Vector3, camera: THREE.Camera): void;
  /** Time of day and weather: moves the sun and sets sky, fill, fog and exposure (cheap; re-bakes the environment only on a visible change) */
  setConditions(conditions: SkyConditions): void;
  dispose(): void;
}

export interface PostFx {
  composer: EffectComposer;
  render(dtSeconds: number): void;
  setSize(width: number, height: number): void;
  /** swap the camera used by the render pass (the sim uses a single camera, but keep it safe) */
  setCamera(camera: THREE.Camera): void;
  /** Graphics preset: MSAA samples and bloom on / off */
  setQuality(quality: "low" | "medium" | "high"): void;
  dispose(): void;
}

/**
 * Applies a graphics preset to the running renderer: resolution (device pixel ratio x the player's render scale),
 * the sun's shadow, MSAA and bloom. Cheap to call again; the caller re-sizes the composer afterwards.
 */
export function applyGraphicsQuality(
  renderer: THREE.WebGLRenderer,
  postFx: PostFx,
  env: GoldenHourEnvironment,
  quality: "low" | "medium" | "high",
  renderScale: number
): void {
  const dprCap = quality === "low" ? 1 : 1.5;
  renderer.setPixelRatio(Math.max(0.35, Math.min(window.devicePixelRatio, dprCap) * renderScale));
  // Toggling the light's shadow recompiles the lit materials on their own (shadow count is part of the program key)
  env.sunLight.castShadow = quality !== "low";
  postFx.setQuality(quality);
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
  sky.material.fragmentShader = ("uniform float skyRadianceScale;\n" + sky.material.fragmentShader)
    .replace(
      "vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );",
      "vec3 sundiscColor = min( ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 ), vec3( SUN_DISC_MAX ) );"
    )
    .replace(
      "gl_FragColor = vec4( texColor, 1.0 );",
      "gl_FragColor = vec4( texColor * skyRadianceScale, 1.0 );"
    );
  sky.material.defines = {
    ...sky.material.defines,
    SUN_DISC_MAX: SUN_DISC_MAX_RADIANCE.toFixed(1),
  };
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

// Keys by sun elevation (deg). Each passes through the golden-hour constant at 14 deg.
const SUN_COLOR_KEYS: readonly Key[] = [[-2, 0xff6a2a], [4, 0xffa262], [14, SUN_COLOR], [35, 0xfff4e8], [70, 0xfff8f2]];
const SUN_INTENSITY_KEYS: readonly Key[] = [[-3, 0], [1, 0.8], [6, 3.0], [14, SUN_INTENSITY], [35, 5.8], [70, 6.2]];
const FILL_INTENSITY_KEYS: readonly Key[] = [[-3, 0.12], [4, 0.26], [14, FILL_INTENSITY], [40, 0.45], [70, 0.5]];
const FOG_COLOR_KEYS: readonly Key[] = [[-3, 0x5e5468], [4, 0xd49c7c], [14, FOG_COLOR], [35, 0xd8dade], [70, 0xc8d4e2]];
const ENV_INTENSITY_KEYS: readonly Key[] = [[-3, 0.3], [4, 0.7], [14, 1], [70, 1.1]];
const EXPOSURE_KEYS: readonly Key[] = [[-3, 1.5], [4, 1.32], [14, EXPOSURE], [35, 1.08], [70, 1.05]];
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
}

function skyLookFor(c: SkyConditions, out: SkyLook): SkyLook {
  const cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
  const rain = THREE.MathUtils.clamp(c.rain, 0, 1);
  out.turbidity = SKY_TURBIDITY + 6 * cloud;
  out.rayleigh = SKY_RAYLEIGH * (1 - 0.5 * cloud);
  // 0 keeps the Sky shader's cloud pass off entirely on a clear day
  out.cloudCoverage = cloud < 0.02 ? 0 : cloud;
  out.cloudDensity = 0.4 + 0.45 * cloud + 0.15 * rain;
  out.radianceScale = SKY_RADIANCE_SCALE * (1 - 0.35 * rain);
  return out;
}

function applySkyLook(sky: Sky, sunDir: THREE.Vector3, look: SkyLook): void {
  const u = sky.material.uniforms;
  u.turbidity.value = look.turbidity;
  u.rayleigh.value = look.rayleigh;
  u.cloudCoverage.value = look.cloudCoverage;
  u.cloudDensity.value = look.cloudDensity;
  u.skyRadianceScale.value = look.radianceScale;
  (u.sunPosition.value as THREE.Vector3).copy(sunDir);
}

/** Bakes the Sky into a 256x256 PMREM. The sun disc is hidden during the bake
 *  so its ~60000 radiance does not dominate the prefiltered environment. */
class SkyBaker {
  private readonly scene = new THREE.Scene();
  private readonly sky = new Sky();
  private pmrem: THREE.PMREMGenerator | null;

  constructor(renderer: THREE.WebGLRenderer) {
    this.sky.scale.setScalar(1000);
    configureSkyUniforms(this.sky, false);
    this.scene.add(this.sky);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  bake(sunDir: THREE.Vector3, look: SkyLook): THREE.WebGLRenderTarget {
    applySkyLook(this.sky, sunDir, look);
    return this.pmrem!.fromScene(this.scene, 0, 0.1, 1000, { size: ENV_SIZE });
  }

  dispose(): void {
    this.pmrem?.dispose();
    this.pmrem = null;
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.scene.clear();
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export function createGoldenHourEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): GoldenHourEnvironment {
  const sunDirection = sunDirectionUnit();

  // Light basis matching DirectionalLightShadow's lookAt (eye = sun, up = +Y),
  // used to snap the shadow frustum to texels in light space.
  const lightRight = new THREE.Vector3().crossVectors(WORLD_UP, sunDirection).normalize();
  const lightUp = new THREE.Vector3().crossVectors(sunDirection, lightRight).normalize();

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

  // --- Environment map (PMREM, re-baked only when the sky changes visibly) ---
  const baker = new SkyBaker(renderer);
  const skyLook = skyLookFor(GOLDEN_HOUR_SKY, {} as SkyLook);
  const skySunDir = sunDirection.clone();
  let envTarget = baker.bake(skySunDir, skyLook);
  let baked: SkyConditions = { ...GOLDEN_HOUR_SKY };
  let lastBakeMs = -Infinity;
  let pendingBake = false;
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 1.0;
  scene.background = null;

  const fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.fog = fog;

  // --- Weak fill ------------------------------------------------------------
  const fillLight = new THREE.HemisphereLight(FILL_SKY, FILL_GROUND, FILL_INTENSITY);
  scene.add(fillLight);

  // --- Sun ------------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);

  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -SHADOW_HALF_SPAN_M;
  shadowCam.right = SHADOW_HALF_SPAN_M;
  shadowCam.top = SHADOW_HALF_SPAN_M;
  shadowCam.bottom = -SHADOW_HALF_SPAN_M;
  shadowCam.near = 1;
  shadowCam.far = 500;
  shadowCam.updateProjectionMatrix();

  sunLight.shadow.bias = -0.0004;
  sunLight.shadow.normalBias = 0.04;
  sunLight.shadow.radius = 2.5;

  sunLight.target.position.set(0, 0, 0);
  sunLight.position.copy(sunDirection).multiplyScalar(SUN_DISTANCE_M);
  scene.add(sunLight);
  scene.add(sunLight.target);

  let disposed = false;
  let current: SkyConditions = { ...GOLDEN_HOUR_SKY };
  const tint = new THREE.Color();

  const rebake = () => {
    const next = baker.bake(skySunDir, skyLook);
    if (scene.environment === envTarget.texture) scene.environment = next.texture;
    envTarget.dispose();
    envTarget = next;
    baked = { ...current };
    lastBakeMs = performance.now();
    pendingBake = false;
  };

  const setConditions = (c: SkyConditions) => {
    if (disposed) return;
    const e = c.elevationDeg;
    const cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
    const rain = THREE.MathUtils.clamp(c.rain, 0, 1);
    current = { elevationDeg: e, azimuthDeg: c.azimuthDeg, cloud, rain };

    // Sun: the light never comes from below the horizon (shadows stay sane at dawn / dusk); the sky's sun does
    sunDirection.copy(sunDirectionUnit(Math.max(1, e), c.azimuthDeg));
    skySunDir.copy(sunDirectionUnit(e, c.azimuthDeg));
    lightRight.crossVectors(WORLD_UP, sunDirection).normalize();
    lightUp.crossVectors(sunDirection, lightRight).normalize();
    colorCurve(SUN_COLOR_KEYS, e, sunLight.color).lerp(tint.setHex(OVERCAST_SUN), 0.6 * cloud);
    // Cloud blocks most direct sun; an overcast sky still leaves faint, soft shadows
    sunLight.intensity = curve(SUN_INTENSITY_KEYS, e) * (1 - 0.88 * Math.pow(cloud, 1.5));

    // Fill: an overcast sky lights everything from above
    fillLight.color.setHex(FILL_SKY).lerp(tint.setHex(OVERCAST_FILL_SKY), cloud);
    fillLight.groundColor.setHex(FILL_GROUND).lerp(tint.setHex(WET_FILL_GROUND), rain);
    fillLight.intensity = curve(FILL_INTENSITY_KEYS, e) * (1 + 1.1 * cloud);

    colorCurve(FOG_COLOR_KEYS, e, fog.color)
      .lerp(tint.setHex(OVERCAST_FOG), 0.8 * cloud)
      .lerp(tint.setHex(RAIN_FOG), rain);
    // A low sun dims the overcast / rain haze too
    if (cloud > 0 && e < 14) fog.color.multiplyScalar(1 - cloud * (1 - curve(ENV_INTENSITY_KEYS, e)));
    fog.density = FOG_DENSITY * (1 + 1.2 * cloud) + 0.0022 * Math.pow(rain, 1.2);

    scene.environmentIntensity = curve(ENV_INTENSITY_KEYS, e) * (1 - 0.25 * rain);
    renderer.toneMappingExposure = curve(EXPOSURE_KEYS, e) * (1 + 0.3 * cloud);

    skyLookFor(current, skyLook);
    applySkyLook(sky, skySunDir, skyLook);
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
    fillLight,

    update(carWorldPos: THREE.Vector3, camera: THREE.Camera): void {
      if (disposed) return;

      // Snap the shadow-frustum origin (car projected onto the light's right/up
      // axes) to whole shadow texels so shadows do not crawl as the car moves.
      const tx = carWorldPos.dot(lightRight);
      const ty = carWorldPos.dot(lightUp);
      const sx = Math.round(tx / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;
      const sy = Math.round(ty / SHADOW_TEXEL_M) * SHADOW_TEXEL_M;

      scratch
        .copy(carWorldPos)
        .addScaledVector(lightRight, sx - tx)
        .addScaledVector(lightUp, sy - ty);

      sunLight.target.position.copy(scratch);
      sunLight.position.copy(scratch).addScaledVector(sunDirection, SUN_DISTANCE_M);

      camera.getWorldPosition(scratch);
      sky.position.copy(scratch);
      // Drifting clouds (the Sky shader skips them at zero coverage)
      if (sky.material.uniforms.cloudCoverage.value > 0) sky.material.uniforms.time.value = performance.now() / 1000;
      if (pendingBake && performance.now() - lastBakeMs > REBAKE_MIN_S * 1000) rebake();
    },

    setConditions,

    dispose(): void {
      if (disposed) return;
      disposed = true;

      scene.remove(sky, fillLight, sunLight, sunLight.target);
      if (scene.environment === envTarget.texture) scene.environment = null;
      if (scene.fog === fog) scene.fog = null;

      sky.geometry.dispose();
      sky.material.dispose();
      sunLight.shadow.dispose();
      envTarget.dispose();
      baker.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

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

  const renderPass = new RenderPass(scene, camera);

  const bloom = new BloomEffect({
    mipmapBlur: true,
    luminanceThreshold: 1.1,
    luminanceSmoothing: 0.1,
    intensity: 0.4,
    radius: 0.7,
    levels: 5,
  });

  // Single merged pass: bloom runs on linear HDR, then AgX as the last effect.
  // AgX is applied here because EffectPass ignores renderer.toneMapping.
  const toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.AGX });
  const effectPass = new EffectPass(camera, bloom, toneMapping);

  composer.addPass(renderPass);
  composer.addPass(effectPass);

  return {
    composer,

    render(dtSeconds: number): void {
      composer.render(dtSeconds);
    },

    setSize(width: number, height: number): void {
      composer.setSize(width, height);
    },

    setCamera(next: THREE.Camera): void {
      renderPass.mainCamera = next;
      effectPass.mainCamera = next;
    },

    setQuality(quality: "low" | "medium" | "high"): void {
      composer.multisampling = quality === "high" ? 4 : quality === "medium" ? 2 : 0;
      bloom.intensity = quality === "high" ? 0.4 : 0;
    },

    dispose(): void {
      // EffectPass.dispose() also disposes the bloom and tone-mapping effects.
      composer.removeAllPasses();
      renderPass.dispose();
      effectPass.dispose();
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
