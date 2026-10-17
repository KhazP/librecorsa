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
 * Golden-hour lighting, sky/environment and post-processing for the Rwanda F1 sim.
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

const REAR_RAIN_MATERIAL_NAME = "EXT_clearled_security";
const REAR_RAIN_EMISSIVE = 0xff1100;
const REAR_RAIN_EMISSIVE_INTENSITY = 10.0;
const REAR_RAIN_BASE_COLOR = 0x2a0000;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GoldenHourEnvironment {
  sunLight: THREE.DirectionalLight;
  /** unit vector from scene towards the sun */
  sunDirection: THREE.Vector3;
  sky: Sky;
  /** Weak warm-blue / olive fill; added to the scene by createGoldenHourEnvironment. */
  fillLight: THREE.HemisphereLight;
  /** Call once per frame before rendering: keeps the +/-55 m shadow frustum centred on the car (texel-snapped to avoid shimmering) and the sky dome centred on the camera */
  update(carWorldPos: THREE.Vector3, camera: THREE.Camera): void;
  dispose(): void;
}

export interface PostFx {
  composer: EffectComposer;
  render(dtSeconds: number): void;
  setSize(width: number, height: number): void;
  /** swap the camera used by the render pass (the sim uses a single camera, but keep it safe) */
  setCamera(camera: THREE.Camera): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.15;
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
  u.turbidity.value = 2.8;
  u.rayleigh.value = 1.8;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  u.cloudCoverage.value = 0;
  u.showSunDisc.value = showSunDisc ? 1 : 0;
  (u.sunPosition.value as THREE.Vector3).copy(sunDirectionUnit());
  // The Sky shader writes HDR values directly; it must not also get scene fog.
  sky.material.fog = false;
  // The stock disc reaches ~60000, which the mipmap bloom smears into a full-screen white haze. Capped, it
  // stays well above the 1.1 bloom threshold and blooms into a halo instead.
  // The stock sky is tuned for exposure ~0.5: at 14° its horizon toward the sun reaches ~29 linear, so a
  // quarter of the frame crossed the bloom threshold. Scaled, only the glow around the sun blooms.
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace(
      "vec3 sundiscColor = ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 );",
      "vec3 sundiscColor = min( ( 760.0 * sundisc ) * min( vSunE * Fex, 80.0 ), vec3( SUN_DISC_MAX ) );"
    )
    .replace(
      "gl_FragColor = vec4( texColor, 1.0 );",
      "gl_FragColor = vec4( texColor * SKY_RADIANCE_SCALE, 1.0 );"
    );
  sky.material.defines = {
    ...sky.material.defines,
    SUN_DISC_MAX: SUN_DISC_MAX_RADIANCE.toFixed(1),
    SKY_RADIANCE_SCALE: SKY_RADIANCE_SCALE.toFixed(3),
  };
}

// Returns a fresh unit vector for the sun. Only called at setup time.
function sunDirectionUnit(): THREE.Vector3 {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG);
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  return new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
}

/** Bake the Sky once into a 256x256 PMREM. The sun disc is hidden during the bake
 *  so its ~60000 radiance does not dominate the prefiltered environment. */
function bakeSkyEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const bakeScene = new THREE.Scene();
  const bakeSky = new Sky();
  bakeSky.scale.setScalar(1000);
  configureSkyUniforms(bakeSky, false);
  bakeScene.add(bakeSky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(bakeScene, 0, 0.1, 1000, { size: ENV_SIZE });
  pmrem.dispose();

  bakeSky.geometry.dispose();
  bakeSky.material.dispose();
  bakeScene.clear();
  return target;
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

  // --- Environment map (PMREM, baked once) ----------------------------------
  const envTarget = bakeSkyEnvironment(renderer);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 1.0;
  scene.background = null;

  const fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.fog = fog;

  // --- Weak fill ------------------------------------------------------------
  const fillLight = new THREE.HemisphereLight(0xc4d8ee, 0x6b6a3a, 0.35);
  scene.add(fillLight);

  // --- Sun ------------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(0xffebd6, 5.0);
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
    },

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
