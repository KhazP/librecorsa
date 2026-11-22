import * as THREE from "three";
import type { BuiltTrackData, NightLightingDef } from "@/lib/track-data";
import type { FloodlitNightLook } from "./golden-hour-environment";
import type { CircuitNightMode, ModelLamp } from "./circuit-night-lights";
import { patchShader } from "./shader-patch";

/*
 * Night at a circuit raced under lights (track data `nightLighting`): the road and what stands beside it are floodlit,
 * the rest of the world stays dark, the light sources of the model glow, and the tunnels take their own colour.
 *
 * The floodlight is the scene's one key light (the sun, which at night stands in for the moon): at such a circuit the
 * environment turns it into a steep, near-white light at night (`VENUE_NIGHT_LOOK`, golden-hour-environment.ts
 * `setFloodlitNight`). It lights the cars as it is, with their shadows. On the circuit's own materials a top-down map of
 * the venue scales it (`uLcVenueMap`, alpha): 1 along the road and under each mast, fading to a trace of moonlight
 * away from the circuit, and 0 in the tunnels. So the whole circuit is lit by one shadowed light, with no light per
 * mast. The map's colour channels are light that is simply there, added as ambient light: the tunnels' own colour, and
 * the glow of the model's light sources on what stands round them (neon on a wall, a lit plaza), gathered once from
 * the model's emissive meshes as seen from above.
 *
 * Light sources: a material with `nightEmissive` in its glTF extras ({ day, night, vertexColor? }, written by the
 * circuit's converter) has its emissive strength run between the two with the night; `vertexColor` multiplies the
 * emissive by the mesh's vertex colours (one merged mesh of neon strips in every hue).
 *
 * Masts: one instanced pole, one instanced lamp head and one glow point each (three draws for the circuit). The glow
 * points give the lamps their halo where there is no bloom (Low and Medium).
 *
 * A circuit whose own model has lamps (circuit-night-lights.ts) uses the same map in one of two ways. Lit all round
 * ("floodlit"), its lamps' pools go into the key as the masts' do. On a moonlit night ("lamps"), the key stays the moon
 * and each lamp's pool is light that is simply there, in the lamp's colour, in the map's colour channels: the road
 * under a street lamp is lit, and between the lamps the night is dark. Such lamps get glow points of their own and no
 * masts (the model has its poles).
 *
 * Costs per frame: nothing here (the uniforms change only when the night share does); in the shaders one texture read.
 */

/** The key light, sky fill and exposure of this floodlit night (the environment blends to them with the night share) */
export const VENUE_NIGHT_LOOK: Readonly<FloodlitNightLook> = {
  keyColor: 0xf3f1ff,
  keyIntensity: 3.0,
  keyElevationDeg: 62,
  fillIntensity: 0.06,
  environmentIntensity: 0.3,
  exposure: 1.28,
  fogColor: 0x0b1020,
};

export interface VenueNightLighting {
  /** Masts, lamp heads and their glow: add to the scene */
  readonly group: THREE.Group;
  readonly look: Readonly<FloodlitNightLook>;
  readonly mode: CircuitNightMode;
  /**
   * The lamps' light at a ground point (x, z) as irradiance (linear), as the circuit's materials take it: a moonlit
   * circuit's pools at the night share now. Black on a floodlit circuit (its key light lights the cars) and by day.
   * For the cars (car-lamp-light.ts), which the map does not reach
   */
  lightAt(x: number, z: number, out: THREE.Color): THREE.Color;
  /** 0 by day .. 1 at night (the environment's night share) */
  setNight(share: number): void;
  setQuality(quality: "low" | "medium" | "high"): void;
  dispose(): void;
}

/** Share of the key light left away from the circuit, per channel: a trace of cool light, as of the moon */
const MOONLIGHT_FLOOR = "vec3( 0.013, 0.021, 0.04 )";
/** How far beyond the road's edge the floodlight reaches before it has faded out (m) */
const FLOOD_REACH_M = 42;
/** A mast's own pool of light on the ground (m) */
const POOL_RADIUS_M = 34;
/** Strength of the map's coloured light as ambient irradiance */
const ACCENT_IRRADIANCE = 1.5;
/**
 * The same on a moonlit circuit with lamps, where the colour channels hold the lamps' pools: a street lamp lights the
 * road under it many times brighter than the moon does
 */
const LAMP_POOL_IRRADIANCE = 6;
/** Light sources of the model light what stands round them: triangles read per mesh at most (larger meshes are thinned) */
const SPILL_MAX_TRIS = 60000;
/** How far their light spreads (m, about one standard deviation) */
const SPILL_SPREAD_M = 10;
/** From emitting area per ground area (x the night strength) to light; and the most a place takes */
const SPILL_GAIN = 42;
const SPILL_MAX = 0.62;
const LAMP_COLOR = 0xfff4e2;
/** A model lamp's pool at its brightest, as the share of its colour in the map (sRGB, before ACCENT_IRRADIANCE) */
const LAMP_POOL_PEAK = 0.9;
const LAMP_NIGHT_INTENSITY = 9;
const LAMP_DAY_INTENSITY = 0.25;

interface NightEmissive {
  day: number;
  night: number;
  vertexColor?: boolean;
  /** False: the light source lights the ground through its own pool, not as glow gathered from above */
  spill?: boolean;
}

const isNightEmissive = (v: unknown): v is NightEmissive =>
  !!v && typeof v === "object" && typeof (v as NightEmissive).day === "number" && typeof (v as NightEmissive).night === "number";

/** Adds to a material's shader hooks, keeping the ones it has (asphalt, scenery detail, leaves ...) */
export function chainShaderPatch(mat: THREE.Material, key: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    patch(shader);
  };
  mat.customProgramCacheKey = () => `${prevKey()}|${key}`;
  mat.needsUpdate = true;
}

const VENUE_VERTEX_PATCHES = [
  ["#include <common>", "#include <common>\nuniform vec4 uLcVenueBox;\nvarying vec2 vLcVenueUv;"],
  [
    "#include <project_vertex>",
    /* glsl */ `#include <project_vertex>
	{
		vec4 lcVenueWorld = vec4( transformed, 1.0 );
		#ifdef USE_BATCHING
			lcVenueWorld = batchingMatrix * lcVenueWorld;
		#endif
		#ifdef USE_INSTANCING
			lcVenueWorld = instanceMatrix * lcVenueWorld;
		#endif
		lcVenueWorld = modelMatrix * lcVenueWorld;
		vLcVenueUv = ( lcVenueWorld.xz - uLcVenueBox.xy ) * uLcVenueBox.zw;
	}`,
  ],
] as const;

/** The key light scaled by the map inside three's sun-light loop (falls back to the unscaled light if the loop moves) */
const venueLightsBegin = () =>
  patchShader(
    THREE.ShaderChunk.lights_fragment_begin,
    [["getSunLightInfo( sunLight, directLight );", "getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= lcVenueKey;"]],
    "venue night key"
  );

const venueFragmentPatches = () =>
  [
    [
      "#include <common>",
      "#include <common>\nuniform sampler2D uLcVenueMap;\nuniform float uLcVenueNight;\nuniform float uLcVenueFlood;\nuniform float uLcVenueAccent;\nvarying vec2 vLcVenueUv;",
    ],
    [
      "#include <lights_fragment_begin>",
      /* glsl */ `
	vec4 lcVenue = texture2D( uLcVenueMap, vLcVenueUv );
	// off the map: the open country, in moonlight
	float lcVenueIn = step( 0.0, vLcVenueUv.x ) * step( vLcVenueUv.x, 1.0 ) * step( 0.0, vLcVenueUv.y ) * step( vLcVenueUv.y, 1.0 );
	// (a moonlit circuit with lamps keeps its key light as it is: uLcVenueFlood 0)
	vec3 lcVenueKey = mix( vec3( 1.0 ), max( vec3( lcVenue.a * lcVenueIn ), ${MOONLIGHT_FLOOR} ), uLcVenueNight * uLcVenueFlood );
${venueLightsBegin()}`,
    ],
    [
      "#include <lights_fragment_end>",
      /* glsl */ `
	#if defined( RE_IndirectDiffuse )
		irradiance += lcVenue.rgb * ( lcVenueIn * uLcVenueAccent * uLcVenueNight );
	#endif
#include <lights_fragment_end>`,
    ],
  ] as const;

const VERTEX_COLOR_EMISSIVE_PATCH = [
  [
    "#include <emissivemap_fragment>",
    /* glsl */ `#include <emissivemap_fragment>
	#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
		totalEmissiveRadiance *= vColor.rgb;
	#endif`,
  ],
] as const;

interface VenueMap {
  texture: THREE.DataTexture;
  /** min x, min z, 1 / size x, 1 / size z */
  box: THREE.Vector4;
  /** The map's texels (RGBA, sRGB colour) and size, kept for lightAt */
  data: Uint8Array;
  w: number;
  h: number;
}

/** A soft-edged band along a polyline: strokes from the widest, each adding a share, so the light fades with distance */
function strokeFalloff(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  innerPx: number,
  outerPx: number,
  peak: number,
  rgb = "255,255,255"
): void {
  const passes = 8;
  // each pass covers (1 - a) of what is left: after all of them the middle stands at `peak`
  const a = 1 - Math.pow(1 - peak, 1 / passes);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = `rgba(${rgb},${a.toFixed(4)})`;
  for (let i = 0; i < passes; i++) {
    const t = i / (passes - 1);
    // eased: most of the fade sits near the outer edge
    ctx.lineWidth = outerPx + (innerPx - outerPx) * Math.pow(t, 0.7);
    ctx.stroke(path);
  }
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** The mean colour (linear) of a light source's texture: how much of it is lit, and in what hue. null: cannot be read */
function meanTextureColor(tex: THREE.Texture, scratch: CanvasRenderingContext2D): [number, number, number] | null {
  const img = tex.image as CanvasImageSource | { data?: unknown } | null;
  if (!img || (tex as THREE.CompressedTexture).isCompressedTexture || (img as { data?: unknown }).data !== undefined) return null;
  try {
    scratch.clearRect(0, 0, 8, 8);
    scratch.drawImage(img as CanvasImageSource, 0, 0, 8, 8);
    const px = scratch.getImageData(0, 0, 8, 8).data;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < px.length; i += 4) {
      r += srgbToLinear(px[i] / 255);
      g += srgbToLinear(px[i + 1] / 255);
      b += srgbToLinear(px[i + 2] / 255);
    }
    const n = px.length / 4;
    return [r / n, g / n, b / n];
  } catch {
    return null;
  }
}

/**
 * The light the model's own light sources throw round them, seen from above: an RGBA image (sRGB) of gw x gh cells
 * over the map's box. Every emissive triangle adds its area x night strength x colour to the cell under it; the sum is
 * spread over `SPILL_SPREAD_M` and compressed. null: the model has no light sources.
 */
function emitterSpill(
  root: THREE.Object3D,
  minX: number,
  minZ: number,
  sizeX: number,
  sizeZ: number,
  gw: number,
  gh: number
): ImageData | null {
  const scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = scratchCanvas.height = 8;
  const scratch = scratchCanvas.getContext("2d", { willReadFrequently: true });
  if (!scratch) return null;
  const acc = new Float32Array(gw * gh * 3);
  const cellArea = (sizeX / gw) * (sizeZ / gh);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tint = new THREE.Color();
  const textureColors = new Map<THREE.Texture, [number, number, number] | null>();
  let any = false;
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const spec = mat?.userData?.nightEmissive as unknown;
    if (!isNightEmissive(spec) || spec.night <= 0 || spec.spill === false) return;
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) return;
    const index = mesh.geometry.getIndex();
    const vcol = spec.vertexColor ? mesh.geometry.getAttribute("color") : null;
    let base: [number, number, number] = [mat.emissive.r, mat.emissive.g, mat.emissive.b];
    if (vcol) base = [1, 1, 1];
    else if (mat.emissiveMap) {
      let mean = textureColors.get(mat.emissiveMap);
      if (mean === undefined) {
        mean = meanTextureColor(mat.emissiveMap, scratch);
        textureColors.set(mat.emissiveMap, mean);
      }
      // unreadable (a compressed texture): a banner or a facade is mostly dark
      const m = mean ?? [0.15, 0.15, 0.15];
      // and it is a facade or a screen, facing sideways: little of its light reaches the ground
      base = [base[0] * m[0] * 0.35, base[1] * m[1] * 0.35, base[2] * m[2] * 0.35];
    }
    const triCount = Math.floor((index ? index.count : pos.count) / 3);
    const stride = Math.max(1, Math.ceil(triCount / SPILL_MAX_TRIS));
    const gain = (spec.night * stride) / cellArea;
    const world = mesh.matrixWorld;
    for (let t = 0; t < triCount; t += stride) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(world);
      b.fromBufferAttribute(pos, i1).applyMatrix4(world);
      c.fromBufferAttribute(pos, i2).applyMatrix4(world);
      const gx = Math.floor((((a.x + b.x + c.x) / 3 - minX) / sizeX) * gw);
      const gz = Math.floor((((a.z + b.z + c.z) / 3 - minZ) / sizeZ) * gh);
      if (gx < 0 || gz < 0 || gx >= gw || gz >= gh) continue;
      const area = 0.5 * b.sub(a).cross(c.sub(a)).length();
      if (!(area > 0)) continue;
      let r = base[0];
      let g = base[1];
      let bl = base[2];
      if (vcol) {
        tint.fromBufferAttribute(vcol, i0);
        r = tint.r;
        g = tint.g;
        bl = tint.b;
      }
      const k = (gz * gw + gx) * 3;
      const wgt = area * gain;
      acc[k] += r * wgt;
      acc[k + 1] += g * wgt;
      acc[k + 2] += bl * wgt;
      any = true;
    }
  });
  if (!any) return null;

  // Spread: two box blurs each way (about a Gaussian of SPILL_SPREAD_M)
  const cellM = Math.sqrt(cellArea);
  const radius = Math.max(1, Math.round((SPILL_SPREAD_M / cellM) * 1.22 - 0.5));
  const tmp = new Float32Array(acc.length);
  const blur = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const len = horizontal ? gw : gh;
    const lines = horizontal ? gh : gw;
    const step = (horizontal ? 1 : gw) * 3;
    const norm = 1 / (2 * radius + 1);
    for (let line = 0; line < lines; line++) {
      const start = (horizontal ? line * gw : line) * 3;
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) if (i >= 0 && i < len) sum += src[start + i * step + ch];
        for (let i = 0; i < len; i++) {
          dst[start + i * step + ch] = sum * norm;
          const add = i + radius + 1;
          const drop = i - radius;
          if (add < len) sum += src[start + add * step + ch];
          if (drop >= 0) sum -= src[start + drop * step + ch];
        }
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    blur(acc, tmp, true);
    blur(tmp, acc, false);
  }

  const image = new ImageData(gw, gh);
  for (let i = 0; i < gw * gh; i++) {
    const r = acc[i * 3];
    const g = acc[i * 3 + 1];
    const bl = acc[i * 3 + 2];
    const peak = Math.max(r, g, bl);
    // compressed by its strongest channel, so a bright place keeps its hue
    const scale = peak > 1e-6 ? (SPILL_MAX * (1 - Math.exp(-peak * SPILL_GAIN))) / peak : 0;
    image.data[i * 4] = Math.round(255 * linearToSrgb(Math.min(1, r * scale)));
    image.data[i * 4 + 1] = Math.round(255 * linearToSrgb(Math.min(1, g * scale)));
    image.data[i * 4 + 2] = Math.round(255 * linearToSrgb(Math.min(1, bl * scale)));
    image.data[i * 4 + 3] = 255;
  }
  return image;
}

/** A model lamp's pool of light on the ground: its radius (m) from the lamp's height, and its centre toward the road */
export function lampPool(lamp: ModelLamp): { x: number; z: number; radiusM: number } {
  const radiusM = THREE.MathUtils.clamp(6 + 1.5 * lamp.heightM, 9, 34);
  // a lamp leans its light over the road: the pool lies between its foot and the road, never past the road's middle
  const lean = Math.min(lamp.roadDistM, 0.45 * lamp.heightM);
  return { x: lamp.x + lamp.towardX * lean, z: lamp.z + lamp.towardZ * lean, radiusM };
}

const srgbHex = (hex: number) => `${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255}`;

function buildVenueMap(
  root: THREE.Object3D,
  track: BuiltTrackData,
  def: NightLightingDef,
  maxSize: number,
  mode: CircuitNightMode,
  modelLamps: readonly ModelLamp[]
): VenueMap | null {
  if (typeof document === "undefined") return null;
  const samples = track.samples;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.position.x);
    maxX = Math.max(maxX, s.position.x);
    minZ = Math.min(minZ, s.position.z);
    maxZ = Math.max(maxZ, s.position.z);
  }
  const margin = FLOOD_REACH_M + 60;
  minX -= margin;
  maxX += margin;
  minZ -= margin;
  maxZ += margin;
  const sizeX = maxX - minX;
  const sizeZ = maxZ - minZ;
  const scale = maxSize / Math.max(sizeX, sizeZ);
  const w = Math.max(64, Math.round(sizeX * scale));
  const h = Math.max(64, Math.round(sizeZ * scale));
  const px = (x: number) => (x - minX) * (w / sizeX);
  const pz = (z: number) => (z - minZ) * (h / sizeZ);
  const m = w / sizeX; // px per metre

  const canvasOf = () => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);
    return { c, ctx };
  };
  const key = canvasOf();
  const accent = canvasOf();
  if (!key || !accent) return null;

  const L = track.totalLengthM;
  const n = samples.length;
  const at = (s: number) => samples[Math.min(n - 1, Math.floor(((((s % L) + L) % L) / L) * n))];
  /** The lap from s0 to s1 (wrapping) as a path */
  const span = (s0: number, s1: number): Path2D => {
    const path = new Path2D();
    const len = s1 >= s0 ? s1 - s0 : L - s0 + s1;
    const steps = Math.max(2, Math.ceil(len / 6));
    for (let i = 0; i <= steps; i++) {
      const p = at(s0 + (len * i) / steps).position;
      if (i === 0) path.moveTo(px(p.x), pz(p.z));
      else path.lineTo(px(p.x), pz(p.z));
    }
    return path;
  };
  const lap = new Path2D();
  let halfWidth = 0;
  samples.forEach((s, i) => {
    halfWidth += s.width / 2 / n;
    if (i === 0) lap.moveTo(px(s.position.x), pz(s.position.z));
    else lap.lineTo(px(s.position.x), pz(s.position.z));
  });
  lap.closePath();

  // The floodlit band: the road and its run-off at 0.7, fading out over the reach; each mast adds its pool on top.
  // A moonlit circuit has no band: its light is its lamps' pools alone
  if (mode === "floodlit") {
    const inner = 2 * (halfWidth + 9) * m;
    const outer = 2 * (halfWidth + FLOOD_REACH_M) * m;
    strokeFalloff(key.ctx, lap, inner, outer, 0.7);
  }
  const lamps = def.lamps ?? [];
  key.ctx.globalCompositeOperation = "lighter";
  for (const [x, , z, , tx, tz] of lamps) {
    // the pool lies between the mast and the middle of the road
    const cx = px(x + tx * 9);
    const cz = pz(z + tz * 9);
    const r = POOL_RADIUS_M * m;
    const g = key.ctx.createRadialGradient(cx, cz, 0, cx, cz, r);
    g.addColorStop(0, "rgba(255,255,255,0.34)");
    g.addColorStop(0.45, "rgba(255,255,255,0.2)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    key.ctx.fillStyle = g;
    key.ctx.fillRect(cx - r, cz - r, 2 * r, 2 * r);
  }
  // The model's own lamps: under lights, more key; on a moonlit night, light of their own colour
  for (const lamp of modelLamps) {
    if (lamp.pool <= 0) continue;
    const pool = lampPool(lamp);
    const cx = px(pool.x);
    const cz = pz(pool.z);
    const r = pool.radiusM * m;
    if (cx + r < 0 || cz + r < 0 || cx - r > w || cz - r > h) continue;
    const ctx = mode === "floodlit" ? key.ctx : null;
    if (ctx) {
      const g = ctx.createRadialGradient(cx, cz, 0, cx, cz, r);
      g.addColorStop(0, `rgba(255,255,255,${(0.34 * lamp.pool).toFixed(3)})`);
      g.addColorStop(0.45, `rgba(255,255,255,${(0.2 * lamp.pool).toFixed(3)})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cz - r, 2 * r, 2 * r);
    }
  }
  key.ctx.globalCompositeOperation = "source-over";

  // The glow of the model's light sources, at a quarter of the map's resolution and drawn up smoothly
  const gw = Math.max(16, Math.round(w / 4));
  const gh = Math.max(16, Math.round(h / 4));
  const spill = emitterSpill(root, minX, minZ, sizeX, sizeZ, gw, gh);
  if (spill) {
    const small = document.createElement("canvas");
    small.width = gw;
    small.height = gh;
    const smallCtx = small.getContext("2d");
    if (smallCtx) {
      smallCtx.putImageData(spill, 0, 0);
      accent.ctx.imageSmoothingEnabled = true;
      accent.ctx.imageSmoothingQuality = "high";
      accent.ctx.drawImage(small, 0, 0, w, h);
    }
  }

  // A moonlit circuit's lamps: each pool in its lamp's colour, brightest under the lamp, adding where pools meet
  if (mode === "lamps") {
    accent.ctx.globalCompositeOperation = "lighter";
    for (const lamp of modelLamps) {
      if (lamp.pool <= 0) continue;
      const pool = lampPool(lamp);
      const cx = px(pool.x);
      const cz = pz(pool.z);
      const r = pool.radiusM * m;
      if (cx + r < 0 || cz + r < 0 || cx - r > w || cz - r > h) continue;
      const rgb = srgbHex(lamp.color);
      const g = accent.ctx.createRadialGradient(cx, cz, 0, cx, cz, r);
      g.addColorStop(0, `rgba(${rgb},${(LAMP_POOL_PEAK * lamp.pool).toFixed(3)})`);
      g.addColorStop(0.35, `rgba(${rgb},${(0.55 * LAMP_POOL_PEAK * lamp.pool).toFixed(3)})`);
      g.addColorStop(0.7, `rgba(${rgb},${(0.16 * LAMP_POOL_PEAK * lamp.pool).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      accent.ctx.fillStyle = g;
      accent.ctx.fillRect(cx - r, cz - r, 2 * r, 2 * r);
    }
    accent.ctx.globalCompositeOperation = "source-over";
  }

  // No floodlight in the tunnels (with shadows off nothing else keeps it out); their mouths fade over a few metres
  const tunnels = def.tunnels ?? [];
  for (const t of tunnels) {
    const len = t.s1 >= t.s0 ? t.s1 - t.s0 : L - t.s0 + t.s1;
    if (len < 16) continue;
    key.ctx.lineJoin = "round";
    key.ctx.lineCap = "butt";
    for (const [inset, alpha] of [[2, 0.45], [5, 0.7], [8, 1]] as const) {
      key.ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
      key.ctx.lineWidth = 2 * (halfWidth + 5) * m;
      key.ctx.stroke(span(t.s0 + inset, t.s1 - inset));
    }
    // their own light, spilling a little out of each mouth
    accent.ctx.lineCap = "butt";
    const color = new THREE.Color(t.color);
    // THREE.Color parses the hex as sRGB and holds it linear; the canvas wants it back in sRGB
    const srgb = color.clone().convertLinearToSRGB();
    const rgbS = `${Math.round(srgb.r * 255)},${Math.round(srgb.g * 255)},${Math.round(srgb.b * 255)}`;
    strokeFalloff(accent.ctx, span(t.s0 - 10, t.s1 + 10), 2 * (halfWidth + 1) * m, 2 * (halfWidth + 12) * m, 0.35, rgbS);
    accent.ctx.lineCap = "butt";
    accent.ctx.strokeStyle = `rgba(${rgbS},0.85)`;
    accent.ctx.lineWidth = 2 * (halfWidth + 4) * m;
    accent.ctx.stroke(span(t.s0, t.s1));
  }

  const keyPx = key.ctx.getImageData(0, 0, w, h).data;
  const accentPx = accent.ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = accentPx[i * 4];
    data[i * 4 + 1] = accentPx[i * 4 + 1];
    data[i * 4 + 2] = accentPx[i * 4 + 2];
    data[i * 4 + 3] = keyPx[i * 4];
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, box: new THREE.Vector4(minX, minZ, 1 / sizeX, 1 / sizeZ), data, w, h };
}

/** sRGB byte to linear, as the texture's sampler decodes it */
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

/** A soft disc for the lamps' glow points */
function glowSprite(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,250,235,0.8)");
  g.addColorStop(0.45, "rgba(255,240,215,0.22)");
  g.addColorStop(1, "rgba(255,235,205,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Sets up the night lighting of a circuit that has it. Call once its model is loaded, with the model's root: its
 * materials take the venue map, and its light sources are found by their `nightEmissive` extras.
 */
export function createVenueNightLighting(
  root: THREE.Object3D,
  track: BuiltTrackData,
  def: NightLightingDef,
  opts: {
    mapSize?: number;
    /** "floodlit" (the default, as track data `nightLighting`): the night's key light is the venue's; "lamps": moonlit */
    mode?: CircuitNightMode;
    /** Lamps of the circuit's own model (circuit-night-lights.ts): pools and glow points, no masts */
    modelLamps?: readonly ModelLamp[];
  } = {}
): VenueNightLighting {
  const group = new THREE.Group();
  group.name = "VenueNightLighting";
  const disposables: { dispose(): void }[] = [];
  const mode = opts.mode ?? "floodlit";
  const modelLamps = opts.modelLamps ?? [];

  // --- The venue map on the circuit's own materials ---------------------------
  const map = buildVenueMap(root, track, def, opts.mapSize ?? 2048, mode, modelLamps);
  const uniforms = {
    uLcVenueMap: { value: map?.texture ?? null },
    uLcVenueBox: { value: map?.box ?? new THREE.Vector4(0, 0, 1, 1) },
    uLcVenueNight: { value: 0 },
    uLcVenueFlood: { value: mode === "floodlit" ? 1 : 0 },
    uLcVenueAccent: { value: mode === "lamps" ? LAMP_POOL_IRRADIANCE : ACCENT_IRRADIANCE },
  };
  if (map) disposables.push(map.texture);
  const fragmentPatches = venueFragmentPatches();
  const patched = new Set<THREE.Material>();
  const lit: { mat: THREE.MeshStandardMaterial; spec: NightEmissive }[] = [];
  const venuePatch = (mat: THREE.Material) => {
    const std = mat as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial || patched.has(mat)) return;
    patched.add(mat);
    const spec = std.userData.nightEmissive as unknown;
    const emissive = isNightEmissive(spec) ? spec : null;
    if (emissive) {
      lit.push({ mat: std, spec: emissive });
      if (emissive.vertexColor) std.emissive.setRGB(1, 1, 1);
    }
    if (!map && !emissive?.vertexColor) return;
    chainShaderPatch(mat, `venue-night-v2${emissive?.vertexColor ? "-vc" : ""}${map ? "" : "-nomap"}`, (shader) => {
      if (map) {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = patchShader(shader.vertexShader, VENUE_VERTEX_PATCHES, "venue night");
        shader.fragmentShader = patchShader(shader.fragmentShader, fragmentPatches, "venue night");
      }
      if (emissive?.vertexColor) {
        shader.fragmentShader = patchShader(shader.fragmentShader, VERTEX_COLOR_EMISSIVE_PATCH, "venue night emissive");
      }
    });
  };
  // Skip hidden non-LOD subtrees (e.g. replaced scenery nodes), but still visit hidden LOD levels so far trees get patched too
  const visitVenue = (obj: THREE.Object3D) => {
    if (obj !== root && !obj.visible && !(obj.parent as THREE.LOD | null)?.isLOD) return;
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) {
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) venuePatch(mat);
    }
    for (const child of obj.children) visitVenue(child);
  };
  visitVenue(root);

  // --- Masts --------------------------------------------------------------------
  const lamps = def.lamps ?? [];
  let headMaterial: THREE.MeshStandardMaterial | null = null;
  let glowMaterial: THREE.PointsMaterial | null = null;
  if (lamps.length) {
    const poleGeometry = new THREE.CylinderGeometry(0.11, 0.17, 1, 6, 1, true);
    poleGeometry.translate(0, 0.5, 0);
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.6, metalness: 0.4 });
    poleMaterial.name = "Venue_Mast";
    venuePatch(poleMaterial);
    const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, lamps.length);
    // A row of lamps on a bar across the mast's head, tilted down at the road
    const headGeometry = new THREE.BoxGeometry(1.9, 0.5, 0.16);
    headMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.5, emissive: LAMP_COLOR, emissiveIntensity: LAMP_DAY_INTENSITY });
    headMaterial.name = "Venue_Lamp";
    const heads = new THREE.InstancedMesh(headGeometry, headMaterial, lamps.length);
    const glowPositions = new Float32Array(lamps.length * 3);
    const mtx = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    lamps.forEach(([x, y, z, heightM, tx, tz], i) => {
      mtx.compose(pos.set(x, y, z), quat.identity(), scl.set(1, heightM, 1));
      poles.setMatrixAt(i, mtx);
      // facing the road (the box's +Z), tilted 32° down
      euler.set(0.56, Math.atan2(tx, tz), 0);
      quat.setFromEuler(euler);
      pos.set(x + tx * 0.25, y + heightM, z + tz * 0.25);
      mtx.compose(pos, quat, scl.set(1, 1, 1));
      heads.setMatrixAt(i, mtx);
      glowPositions.set([pos.x + tx * 0.2, pos.y - 0.1, pos.z + tz * 0.2], i * 3);
    });
    for (const mesh of [poles, heads]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // the instances are spread round the whole lap
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
    const sprite = glowSprite();
    glowMaterial = new THREE.PointsMaterial({
      map: sprite,
      color: LAMP_COLOR,
      size: 5.5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const glow = new THREE.Points(glowGeometry, glowMaterial);
    glow.frustumCulled = false;
    glow.matrixAutoUpdate = false;
    glow.renderOrder = 3;
    group.add(glow);
    disposables.push(poleGeometry, poleMaterial, headGeometry, headMaterial, glowGeometry, glowMaterial);
    if (sprite) disposables.push(sprite);
  }

  // --- The model's own lamps: a glow point under each head (one draw per size and colour) -------------
  const lampGlowMaterials: THREE.PointsMaterial[] = [];
  const lampSprite = modelLamps.some((l) => l.glowSizeM > 0) ? glowSprite() : null;
  if (lampSprite) disposables.push(lampSprite);
  const buckets = new Map<string, ModelLamp[]>();
  for (const lamp of modelLamps) {
    if (lamp.glowSizeM <= 0) continue;
    const key = `${lamp.glowSizeM}|${lamp.color}`;
    const list = buckets.get(key);
    if (list) list.push(lamp);
    else buckets.set(key, [lamp]);
  }
  for (const list of buckets.values()) {
    const positions = new Float32Array(list.length * 3);
    // just under the head, a little toward the road: where its lamps face
    list.forEach((l, i) => positions.set([l.x + l.towardX * 0.3, l.y - 0.35, l.z + l.towardZ * 0.3], i * 3));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      map: lampSprite,
      color: list[0].color,
      size: list[0].glowSizeM,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;
    points.renderOrder = 3;
    points.name = "VenueLampGlow";
    group.add(points);
    lampGlowMaterials.push(material);
    disposables.push(geometry, material);
  }

  let night = -1;
  let glowGain = 0.55;
  const apply = () => {
    const k = Math.max(0, night);
    uniforms.uLcVenueNight.value = k;
    for (const { mat, spec } of lit) mat.emissiveIntensity = spec.day + (spec.night - spec.day) * k;
    if (headMaterial) headMaterial.emissiveIntensity = LAMP_DAY_INTENSITY + (LAMP_NIGHT_INTENSITY - LAMP_DAY_INTENSITY) * k;
    if (glowMaterial) {
      glowMaterial.opacity = glowGain * k;
      glowMaterial.visible = k > 0.02;
    }
    for (const mat of lampGlowMaterials) {
      mat.opacity = glowGain * k;
      mat.visible = k > 0.02;
    }
  };

  const api: VenueNightLighting = {
    group,
    look: VENUE_NIGHT_LOOK,
    mode,
    lightAt(x: number, z: number, out: THREE.Color): THREE.Color {
      const k = Math.max(0, night);
      if (!map || mode !== "lamps" || k <= 0) return out.setRGB(0, 0, 0);
      const { data, w, h, box } = map;
      // bilinear, texel centres at half steps, as the sampler reads it
      const fx = (x - box.x) * box.z * w - 0.5;
      const fz = (z - box.y) * box.w * h - 0.5;
      if (fx < -1 || fz < -1 || fx > w || fz > h) return out.setRGB(0, 0, 0);
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)));
      const z0 = Math.max(0, Math.min(h - 1, Math.floor(fz)));
      const x1 = Math.min(w - 1, x0 + 1);
      const z1 = Math.min(h - 1, z0 + 1);
      const tx = THREE.MathUtils.clamp(fx - x0, 0, 1);
      const tz = THREE.MathUtils.clamp(fz - z0, 0, 1);
      const scale = uniforms.uLcVenueAccent.value * k;
      const ch = (c: number) => {
        const a = SRGB_TO_LINEAR[data[(z0 * w + x0) * 4 + c]];
        const b = SRGB_TO_LINEAR[data[(z0 * w + x1) * 4 + c]];
        const d = SRGB_TO_LINEAR[data[(z1 * w + x0) * 4 + c]];
        const e = SRGB_TO_LINEAR[data[(z1 * w + x1) * 4 + c]];
        return ((a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz) * scale;
      };
      return out.setRGB(ch(0), ch(1), ch(2));
    },
    setNight(share: number): void {
      const k = THREE.MathUtils.clamp(share, 0, 1);
      if (Math.abs(k - night) < 0.004) return;
      night = k;
      apply();
    },
    setQuality(quality): void {
      // With bloom (High) the lamp heads make their own halo: the glow points only hint at it
      const next = quality === "high" ? 0.55 : 1;
      if (next === glowGain) return;
      glowGain = next;
      apply();
    },
    dispose(): void {
      group.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
  api.setNight(0);
  return api;
}
