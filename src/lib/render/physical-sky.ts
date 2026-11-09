import * as THREE from "three";
import { PrecomputedTexturesGenerator, SkyMaterial } from "@takram/three-atmosphere";
import { CloudShape, CloudShapeDetail, CloudsEffect, LocalWeather, Turbulence } from "@takram/three-clouds";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { AZIMUTH_OFFSET_DEG, LATITUDE_DEG } from "@/lib/sim/weather";
import { withBasePath } from "@/lib/base-path";
import { patchShader, type ShaderPatch } from "./shader-patch";

/*
 * Physically based sky and volumetric clouds (@takram/three-atmosphere and @takram/three-clouds, MIT), opt-in with
 * `?sky=physical` while the classic three.js Sky stays the default.
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
 *   - Volumetric clouds run on High (the library's "medium" preset) and Medium ("low"). Without them (Low, the
 *     environment bake, the reflection probe), an overcast veil greys the sky with the weather's cloud cover.
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
/** Cloud drift (local-weather texture repeats per second) */
const CLOUD_WIND = new THREE.Vector2(0.0004, 0.00015);

export type SkyQuality = "low" | "medium" | "high";

export interface PhysicalSkyConditions {
  /** Unit vector from the scene towards the sun, scene frame (may point below the horizon) */
  sunDirection: THREE.Vector3;
  /** Cloud cover 0..1 */
  cloud: number;
  /** Rain intensity 0..1 */
  rain: number;
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

/** The sky material's uniforms this module adds on top of the library's */
interface SkyExtraUniforms {
  skyRadianceScale: THREE.IUniform<number>;
  /** 0..1, read by the car reflection probe as the sky's sun-disc switch (it zeroes it while filming) */
  showSunDisc: THREE.IUniform<number>;
  overcast: THREE.IUniform<number>;
  overcastTint: THREE.IUniform<THREE.Color>;
}

type PatchedSkyMaterial = SkyMaterial & { uniforms: SkyMaterial["uniforms"] & SkyExtraUniforms };

/** The sky fragment shader's edits: radiance scale, sun-disc switch, overcast veil and the radiance cap */
export const SKY_FRAGMENT_PATCHES: readonly ShaderPatch[] = [
  [
    "uniform vec3 groundAlbedo;",
    "uniform vec3 groundAlbedo;\nuniform float skyRadianceScale;\nuniform float showSunDisc;\nuniform float overcast;\nuniform vec3 overcastTint;",
  ],
  ["radiance += transmittance * GetSolarRadiance() * antialias;", "radiance += transmittance * GetSolarRadiance() * antialias * showSunDisc;"],
  [
    "outputColor.a = 1.0;",
    /* glsl */ `outputColor.rgb *= skyRadianceScale;
  float skyLuma = dot(outputColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  outputColor.rgb = mix(outputColor.rgb, vec3(skyLuma) * overcastTint, overcast);
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
 * The clouds composite, scaled to the scene like the sky. Its SKIP_RENDERING switch never worked here: postprocessing
 * renames the effect's define (to e0SKIP_RENDERING) but not this `#ifdef`, so the composite always ran. It is made
 * unconditional, and the clouds are switched off by disabling their pass instead (PhysicalSky.cloudsActive).
 */
export const CLOUDS_COMPOSITE_PATCHES: readonly ShaderPatch[] = [
  ["#ifdef SKIP_RENDERING", "#if 0 // SKIP_RENDERING (the pass is disabled instead)"],
  ["uniform sampler2D cloudsBuffer;", "uniform sampler2D cloudsBuffer;\nuniform float cloudsRadianceScale;"],
  [
    "outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb;",
    "outputColor.rgb = inputColor.rgb * (1.0 - clouds.a) + clouds.rgb * cloudsRadianceScale;",
  ],
];

export function createSkyMaterial(sun: boolean, reversedDepth: boolean): PatchedSkyMaterial {
  const material = new SkyMaterial({ sun, moon: false, ground: true, groundAlbedo: GROUND_ALBEDO.clone() }) as PatchedSkyMaterial;
  Object.assign(material.uniforms, {
    skyRadianceScale: { value: SKY_RADIANCE_SCALE },
    showSunDisc: { value: 1 },
    overcast: { value: 0 },
    overcastTint: { value: OVERCAST_TINT.clone() },
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

/** Scales the clouds by SKY_RADIANCE_SCALE where the effect composites them over the frame */
function patchCloudsComposite(clouds: CloudsEffect): void {
  // postprocessing's Effect keeps its shader behind a protected setter
  const effect = clouds as unknown as { getFragmentShader(): string; setFragmentShader(source: string): void };
  effect.setFragmentShader(patchShader(effect.getFragmentShader(), CLOUDS_COMPOSITE_PATCHES, "clouds composite"));
  clouds.uniforms.set("cloudsRadianceScale" as never, new THREE.Uniform(SKY_RADIANCE_SCALE) as never);
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
  /** The atmosphere's lookup tables are ready (until then the sky renders black: keep the classic sky up) */
  ready = false;

  private readonly generator: PrecomputedTexturesGenerator;
  private readonly worldToECEF = sceneToECEFMatrix();
  private readonly sunECEF = new THREE.Vector3(0, 0, 1);
  private readonly procedural: Array<{ dispose(): void }> = [];
  private stbn: THREE.Data3DTexture | null = null;
  private cloudsOn = false;
  private cloud = 0;
  private rain = 0;
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
    this.clouds.localWeatherVelocity.copy(CLOUD_WIND);
    // Light shafts need the atmosphere's aerial-perspective pass, which this renderer does not run
    this.clouds.lightShafts = false;
    if (reversedDepth) patchCloudsForReversedDepth(this.clouds);
    patchCloudsComposite(this.clouds);
    this.clouds.skipRendering = false;

    this.generator = new PrecomputedTexturesGenerator(renderer);
    allowReversedDepth(this.generator);
    const textures = this.generator.textures;
    Object.assign(this.mesh.material, textures);
    Object.assign(this.bakeMesh.material, textures);
    Object.assign(this.clouds, textures);
    this.generator
      .update()
      .then(() => {
        if (this.disposed) return;
        this.ready = true;
        this.mesh.visible = true;
        this.bakeMesh.visible = true;
        this.applyLook();
        onReady();
      })
      .catch((error: unknown) => console.error("[physical-sky] atmosphere precompute failed; keeping the classic sky", error));

    void fetch(withBasePath(BLUE_NOISE_URL))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status} ${BLUE_NOISE_URL}`))))
      .then((buffer) => {
        if (this.disposed) return;
        this.stbn = createSpatiotemporalNoise(new Uint8Array(buffer));
        this.clouds.stbnTexture = this.stbn;
      })
      .catch((error: unknown) => console.warn("[physical-sky] blue noise missing; the clouds will look grainier", error));
  }

  /** Sun, cloud cover and rain (cheap: uniforms only) */
  setConditions(c: PhysicalSkyConditions): void {
    this.sunECEF.copy(c.sunDirection).transformDirection(this.worldToECEF);
    this.mesh.material.sunDirection.copy(this.sunECEF);
    this.bakeMesh.material.sunDirection.copy(this.sunECEF);
    this.clouds.sunDirection.copy(this.sunECEF);
    this.cloud = THREE.MathUtils.clamp(c.cloud, 0, 1);
    this.rain = THREE.MathUtils.clamp(c.rain, 0, 1);
    this.applyLook();
  }

  /** Volumetric clouds on High (the library's "medium" preset) and Medium ("low"), off on Low */
  setQuality(quality: SkyQuality): void {
    this.cloudsOn = quality !== "low";
    if (quality === "high") this.clouds.qualityPreset = "medium";
    else if (quality === "medium") this.clouds.qualityPreset = "low";
    this.clouds.lightShafts = false;
    this.applyLook();
  }

  /** Whether the clouds' pass should run this frame: the atmosphere is ready and the graphics preset has clouds */
  get cloudsActive(): boolean {
    return this.cloudsOn && this.ready;
  }

  private applyLook(): void {
    const { cloud, rain } = this;
    const volumetric = this.cloudsActive;
    // A clear day keeps a few fair-weather clouds; full cover closes the sky
    this.clouds.coverage = 0.25 + 0.6 * cloud + 0.1 * rain;
    // The bake has no volumetric clouds, so its sky always takes the veil; the visible sky only past what they show
    const veil = cloud * (0.75 + 0.25 * rain);
    this.bakeMesh.material.uniforms.overcast.value = veil;
    this.mesh.material.uniforms.overcast.value = volumetric ? 0.6 * THREE.MathUtils.smoothstep(cloud, 0.7, 1) + 0.25 * rain : veil;
    // A thick overcast hides the sun disc (the probe zeroes this while it films and puts the value back)
    this.mesh.material.uniforms.showSunDisc.value = 1 - THREE.MathUtils.smoothstep(cloud, 0.55, 0.9);
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
    for (const p of this.procedural) p.dispose();
    this.stbn?.dispose();
    this.generator.dispose();
  }
}
