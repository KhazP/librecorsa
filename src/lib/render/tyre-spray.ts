import * as THREE from "three";
import { isTouchDevice } from "@/lib/input/touch-input";
import { DETAIL_LAYER } from "./layers";
import { RAIN_BEAMS, type RainLight } from "./rain-fx";

/**
 * Water thrown up by the cars on a wet road: jets off the rear tyres, a low wash off the fronts, and the rooster tail,
 * the plume of mist rising behind the car and hanging there. Soft camera-facing puffs of their own pool (the tyre smoke
 * and dust keep theirs), lit as the falling rain is (rain-fx.ts: the sky, the sun through thin cloud, the headlight
 * beams, a street lamp) and red where they pass through a car's rear lamps, faded out towards the road so a puff never
 * shows a hard edge where it meets the asphalt, and faded with the scene's fog.
 *
 * How much water a car throws grows with its speed (none below walking pace, full from about 160 km/h), the water on
 * the road under it and the depth standing on the track. Puffs alive at once are capped per graphics tier, and phones
 * take a smaller share still; when the pool is full the oldest puff is reused. Drawn on the view-only detail layer, so
 * the reflection probe and the mirrors never film it.
 */

export type SprayQuality = "low" | "medium" | "high";

/** Puffs alive at most, by tier */
export const SPRAY_BUDGET: Readonly<Record<SprayQuality, number>> = { low: 160, medium: 480, high: 900 };
/** Phones and tablets: at most this many, and this share of the tier's rate */
export const SPRAY_BUDGET_TOUCH = 200;
const TOUCH_RATE = 0.6;
/** Emission against the full rate, by tier */
const SPRAY_RATE: Readonly<Record<SprayQuality, number>> = { low: 0.4, medium: 0.7, high: 1 };
/** Cars farther than this (m) from the player throw no spray, by tier */
export const SPRAY_REACH_M: Readonly<Record<SprayQuality, number>> = { low: 90, medium: 130, high: 170 };
const MAX_SPRAY = SPRAY_BUDGET.high;

/** Puffs per second at full speed and water: off the rear tyres, off the fronts, the plume */
const REAR_JET_RATE = 80;
const FRONT_RATE = 12;
const PLUME_RATE = 44;
/**
 * Share of the car's speed the mist leaves with: the wake behind a car moves on with it, so the spray hangs on the car
 * for a few metres before the air lets it go (at a third of this it was past a chase camera in a fifth of a second)
 */
const WAKE_SHARE = 0.7;
/** Speed (m/s) the spray starts at and is full from */
const SPRAY_START_MS = 9;
const SPRAY_FULL_MS = 45;

/** The mist's own colour (it takes the light it is given) and the red of the rear lamps through it */
const MIST_ALBEDO = new THREE.Color(0.86, 0.89, 0.92);
const GLOW_COLOR = new THREE.Color(1, 0.06, 0.025).multiplyScalar(0.3);

/** How much a car throws (0..1) from its speed (m/s), the water under it (0..1) and the standing water (mm) */
export function sprayAmount(speedMs: number, wetness: number, waterMm: number): number {
  if (!(speedMs > SPRAY_START_MS) || !(wetness > 0.12)) return 0;
  const s = THREE.MathUtils.smoothstep(speedMs, SPRAY_START_MS, SPRAY_FULL_MS);
  const depth = THREE.MathUtils.smoothstep(Number.isFinite(waterMm) ? waterMm : 0, 0.15, 2);
  return s * s * THREE.MathUtils.smoothstep(wetness, 0.12, 0.6) * (0.55 + 0.45 * depth);
}

const VERT = /* glsl */ `
attribute vec4 aCenter; // world position, size (m)
attribute vec4 aPuff; // opacity, spin, the road's height under it, rear-lamp glow
uniform vec3 uAmbient;
uniform vec3 uLamp;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec4 uBeamPos[${RAIN_BEAMS}];
uniform vec4 uBeamDir[${RAIN_BEAMS}];
uniform float uBeamScale;
uniform vec3 uMist;
uniform vec3 uGlow;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vHeight;
varying float vSize;
varying float vSeed;
#include <fog_pars_vertex>

// A headlight's light on the mist at p, seen from the camera: inside the beam, fading with distance. Water drops
// scatter it mostly onwards, so the mist glows looking into a car's lamps and much less along one's own beam, where
// only what scatters back is seen (lit as strongly as the rain streaks, a plume in one's own lights went white)
vec3 beamLight(vec3 p, vec3 view, vec4 pos, vec4 dir) {
  if (pos.w <= 0.0) return vec3(0.0);
  vec3 d = p - pos.xyz;
  float dist = length(d);
  if (dist > pos.w || dist < 0.05) return vec3(0.0);
  float cone = smoothstep(0.8, 0.95, dot(d / dist, dir.xyz));
  float fall = 1.0 - dist / pos.w;
  float onwards = 0.3 + 1.7 * pow(max(-dot(view, dir.xyz), 0.0), 4.0);
  return vec3(1.0, 0.96, 0.88) * dir.w * cone * fall * fall * onwards;
}

void main() {
  vec4 mv = modelViewMatrix * vec4(aCenter.xyz, 1.0);
  float c = cos(aPuff.y);
  float s = sin(aPuff.y);
  vec2 off = mat2(c, s, -s, c) * position.xy * aCenter.w;
  mv.xy += off;
  gl_Position = projectionMatrix * mv;
  // This corner's height over the road: the view-space offset turned back into the world
  vHeight = aCenter.y + (vec3(off, 0.0) * mat3(viewMatrix)).y - aPuff.z;
  vSize = aCenter.w;
  vSeed = aPuff.y;
  vUv = uv;
  // Never a puff across the lens
  vAlpha = aPuff.x * smoothstep(0.4, 1.8, -mv.z);
  // Lit where it hangs: the sky, a street lamp, the sun through thin cloud (mostly looking towards it), the beams
  vec3 view = normalize(aCenter.xyz - cameraPosition);
  vec3 light = uAmbient + uLamp + uSunColor * (0.2 + 1.6 * pow(max(dot(view, uSunDir), 0.0), 5.0));
  vec3 beams = vec3(0.0);
  for (int i = 0; i < ${RAIN_BEAMS}; i++) beams += beamLight(aCenter.xyz, view, uBeamPos[i], uBeamDir[i]);
  vColor = (light + beams * uBeamScale) * uMist + uGlow * aPuff.w;
  vec4 mvPosition = mv;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uNoise;
uniform float uDetail;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
varying float vHeight;
varying float vSize;
varying float vSeed;
#include <fog_pars_fragment>
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  if (r >= 1.0 || vAlpha < 0.003) discard;
  float body = 1.0 - r * r;
  // Wisps: the noise drifts through the puff as it turns
  vec2 drift = vec2(sin(vSeed), cos(vSeed)) * 0.37;
  float wisp = texture2D(uNoise, q * 0.8 + drift).r;
  if (uDetail > 0.5) wisp = 0.6 * wisp + 0.4 * texture2D(uNoise, q * 2.1 - drift.yx).r;
  float a = body * sqrt(body) * (0.3 + 0.95 * wisp) * vAlpha;
  // Thins out towards the road instead of being cut off by it
  a *= smoothstep(0.0, 0.2 + 0.3 * vSize, vHeight);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
}
`;

/** A tileable value noise (64 px, two octaves): the puffs' wisps, a texture read instead of hashing per pixel */
function createNoiseTexture(): THREE.DataTexture {
  const N = 64;
  const lattice = (cells: number, seed: number) => {
    const v = new Float32Array(cells * cells);
    let h = seed >>> 0;
    for (let i = 0; i < v.length; i++) {
      h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      v[i] = (h & 0xffff) / 0xffff;
    }
    return (x: number, y: number) => {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => v[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const coarse = lattice(6, 0x9e3779b9);
  const fine = lattice(16, 0x85ebca6b);
  const data = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) data[y * N + x] = Math.round(255 * (0.62 * coarse(x, y) + 0.38 * fine(x, y)));
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** The road's height under it when born */
  ground: number;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  spin: number;
  spinRate: number;
  /** Rear-lamp glow when born, and how fast it fades (1/s) as the car pulls away */
  glow: number;
  glowFade: number;
  /** Upward drift it settles to (m/s): the plume keeps rising a little, a jet's droplets fall */
  rise: number;
}

/** Puffs owed per car, carried between frames so a slow emitter still emits on time */
interface Owed {
  rear: number;
  front: number;
  plume: number;
  seenFrame: number;
}

const _right = new THREE.Vector3();

export class TyreSpray {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly centers: THREE.InstancedBufferAttribute;
  private readonly puffAttr: THREE.InstancedBufferAttribute;
  private readonly noise: THREE.DataTexture;
  private readonly puffs: Puff[] = [];
  private active = 0;
  private cursor = 0;
  private quality: SprayQuality = "high";
  private readonly touch: boolean;
  private readonly owed = new Map<string, Owed>();
  private frame = 0;
  private windX = 0;
  private windZ = 0;
  private waterMm = 0;
  private readonly beamPos = Array.from({ length: RAIN_BEAMS }, () => new THREE.Vector4());
  private readonly beamDir = Array.from({ length: RAIN_BEAMS }, () => new THREE.Vector4());

  constructor(options: { touch?: boolean } = {}) {
    this.touch = options.touch ?? isTouchDevice();
    this.noise = createNoiseTexture();
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute("position", quad.getAttribute("position"));
    geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRAY * 4), 4);
    this.puffAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRAY * 4), 4);
    this.centers.setUsage(THREE.DynamicDrawUsage);
    this.puffAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aCenter", this.centers);
    geometry.setAttribute("aPuff", this.puffAttr);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uAmbient: { value: new THREE.Color(0.15, 0.15, 0.15) },
          uLamp: { value: new THREE.Color(0, 0, 0) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunColor: { value: new THREE.Color(0, 0, 0) },
          uBeamPos: { value: this.beamPos },
          uBeamDir: { value: this.beamDir },
          uBeamScale: { value: 1 },
          uMist: { value: MIST_ALBEDO.clone() },
          uGlow: { value: GLOW_COLOR.clone() },
          uNoise: { value: null },
          uDetail: { value: 1 },
        },
      ]),
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    // merge() clones its values: the arrays and the texture are set after it, so these stay the ones written to
    this.material.uniforms.uBeamPos.value = this.beamPos;
    this.material.uniforms.uBeamDir.value = this.beamDir;
    this.material.uniforms.uNoise.value = this.noise;
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "tyre-spray";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    this.mesh.layers.set(DETAIL_LAYER);
    for (let i = 0; i < MAX_SPRAY; i++) {
      this.puffs.push({ x: 0, y: -1000, z: 0, vx: 0, vy: 0, vz: 0, ground: 0, age: 0, life: 1, size0: 0, size1: 0, alpha: 0, spin: 0, spinRate: 0, glow: 0, glowFade: 0, rise: 0 });
    }
  }

  /** The puffs alive at most now */
  get budget(): number {
    const tier = SPRAY_BUDGET[this.quality];
    return this.touch ? Math.min(tier, SPRAY_BUDGET_TOUCH) : tier;
  }

  /** The cars throwing spray reach this far (m) */
  get reachM(): number {
    return SPRAY_REACH_M[this.quality];
  }

  get activeCount(): number {
    return this.active;
  }

  setQuality(quality: SprayQuality): void {
    this.quality = quality;
    this.material.uniforms.uDetail.value = quality === "low" || this.touch ? 0 : 1;
    const budget = this.budget;
    if (this.active > budget) this.active = budget;
  }

  /** The water standing on the track (mm), and the wind (m/s along scene X and Z) the mist drifts with */
  setConditions(waterMm: number, windVxMs = 0, windVzMs = 0): void {
    this.waterMm = Number.isFinite(waterMm) ? waterMm : 0;
    this.windX = Number.isFinite(windVxMs) ? windVxMs : 0;
    this.windZ = Number.isFinite(windVzMs) ? windVzMs : 0;
  }

  /**
   * What lights the mist this frame (the rain's lights, rain-fx.ts) and the sky's brightness (0..1: the session's
   * daylight under its cloud): a grey about as bright as the rain clouds by day, near black at night but for the lamps
   */
  setLight(light: RainLight | null, brightness: number): void {
    const u = this.material.uniforms;
    const b = THREE.MathUtils.clamp(Number.isFinite(brightness) ? brightness : 0, 0, 1);
    (u.uAmbient.value as THREE.Color).setScalar(0.012 + 0.24 * b);
    // The lamps' red shows through the mist at night, faintly by day
    (u.uGlow.value as THREE.Color).copy(GLOW_COLOR).multiplyScalar(1 - 0.6 * b);
    // A beam lights a plume at night; by day the sky outshines it (lit as the rain streaks are, the whole plume went white)
    u.uBeamScale.value = 1 - 0.95 * THREE.MathUtils.clamp(b * 2, 0, 1);
    const n = light ? Math.min(RAIN_BEAMS, light.beamCount, light.beams.length) : 0;
    for (let i = 0; i < RAIN_BEAMS; i++) {
      const beam = light && i < n ? light.beams[i] : null;
      if (!beam) {
        this.beamPos[i].set(0, 0, 0, 0);
        continue;
      }
      this.beamPos[i].set(beam.pos.x, beam.pos.y, beam.pos.z, beam.range);
      this.beamDir[i].set(beam.dir.x, beam.dir.y, beam.dir.z, THREE.MathUtils.clamp(beam.intensity / 450, 0, 1.5));
    }
    const lamp = u.uLamp.value as THREE.Color;
    if (light?.lamp) lamp.copy(light.lamp).multiplyScalar(0.3);
    else lamp.setRGB(0, 0, 0);
    if (light?.sunDir) (u.uSunDir.value as THREE.Vector3).copy(light.sunDir).normalize();
    (u.uSunColor.value as THREE.Color).setRGB(1, 0.95, 0.85).multiplyScalar(0.5 * THREE.MathUtils.clamp(light?.sunShare ?? 0, 0, 1));
  }

  /**
   * One car's spray this frame. `wheels` are its tyres' contact points on the road in physics order (FR, FL, RR, RL);
   * `vel` its world velocity (m/s); `fwd` its forward axis. `wetness` is the water under it (0..1), `lamp` its rear
   * lamps (0 off, about 1 on, more braking), `share` the emission kept at its distance from the player (0..1).
   */
  emitCar(
    id: string,
    dt: number,
    wheels: readonly THREE.Vector3[],
    fwd: THREE.Vector3,
    vel: THREE.Vector3,
    wetness: number,
    lamp: number,
    share = 1
  ): void {
    if (!(dt > 0)) return;
    const speedMs = vel.length();
    const base = sprayAmount(speedMs, wetness, this.waterMm);
    const rate = SPRAY_RATE[this.quality] * (this.touch ? TOUCH_RATE : 1);
    const amount = base * share * rate;
    let o = this.owed.get(id);
    if (amount < 0.01) {
      if (o) o.rear = o.front = o.plume = 0;
      return;
    }
    if (!o) this.owed.set(id, (o = { rear: 0, front: 0, plume: 0, seenFrame: this.frame }));
    o.seenFrame = this.frame;
    // Low and phones keep the plume a little smaller: its overdraw is most of the cost
    const sp = THREE.MathUtils.smoothstep(speedMs, SPRAY_START_MS, SPRAY_FULL_MS) * (this.quality === "low" || this.touch ? 0.8 : 1);
    // More water is more puffs, each a little thicker; a lower tier's fewer puffs are a little thicker too
    const thick = (0.65 + 0.35 * base) * Math.min(1.35, 1 / Math.sqrt(rate));
    const right = _right.crossVectors(fwd, THREE.Object3D.DEFAULT_UP).normalize();
    // A puff's red: the lamps light the mist just behind them; it fades as the car leaves it behind
    const glowFade = Math.max(3, speedMs * 0.45);
    // Rear jets: off each rear tyre, fast and short, thrown up and back
    o.rear = Math.min(4, o.rear + dt * REAR_JET_RATE * amount);
    while (o.rear >= 1) {
      o.rear -= 1;
      const w = wheels[2 + (Math.random() < 0.5 ? 0 : 1)];
      const side = Math.random() * 0.4 - 0.2;
      const carry = WAKE_SHARE * (0.85 + 0.25 * Math.random());
      this.spawn(
        w.x - fwd.x * 0.45 + right.x * side,
        w.y + 0.2,
        w.z - fwd.z * 0.45 + right.z * side,
        vel.x * carry + right.x * (Math.random() - 0.5) * 2.4,
        1.5 + 1.6 * Math.random(),
        vel.z * carry + right.z * (Math.random() - 0.5) * 2.4,
        w.y,
        0.45 + 0.35 * Math.random(),
        0.4,
        (1.6 + 0.8 * Math.random()) * (0.7 + 0.5 * sp),
        0.48 * thick,
        lamp * 0.55,
        glowFade,
        -1
      );
    }
    // Fronts: a low, short wash out to the sides, kept out of the driver's view
    o.front = Math.min(4, o.front + dt * FRONT_RATE * amount);
    while (o.front >= 1) {
      o.front -= 1;
      const k = Math.random() < 0.5 ? 0 : 1;
      const w = wheels[k];
      const out = k === 0 ? 1 : -1;
      this.spawn(
        w.x - fwd.x * 0.3,
        w.y + 0.08,
        w.z - fwd.z * 0.3,
        vel.x * WAKE_SHARE + right.x * out * 1.8,
        0.6 + 0.6 * Math.random(),
        vel.z * WAKE_SHARE + right.z * out * 1.8,
        w.y,
        0.25 + 0.15 * Math.random(),
        0.3,
        0.9 + 0.4 * Math.random(),
        0.22 * thick,
        0,
        glowFade,
        -1.5
      );
    }
    // The rooster tail: a plume of mist off the back of the car, rising and hanging in the air behind it
    o.plume = Math.min(4, o.plume + dt * PLUME_RATE * amount);
    while (o.plume >= 1) {
      o.plume -= 1;
      const rl = wheels[2];
      const rr = wheels[3];
      const back = 0.7 + 0.5 * Math.random();
      const side = Math.random() - 0.5;
      const cx = 0.5 * (rl.x + rr.x) - fwd.x * back + (rr.x - rl.x) * side * 0.8;
      const cz = 0.5 * (rl.z + rr.z) - fwd.z * back + (rr.z - rl.z) * side * 0.8;
      const gy = 0.5 * (rl.y + rr.y);
      const carry = WAKE_SHARE * (0.95 + 0.25 * Math.random());
      this.spawn(
        cx,
        gy + 0.35 + 0.3 * Math.random(),
        cz,
        vel.x * carry + right.x * side * 1.6,
        1.1 + 1.2 * Math.random(),
        vel.z * carry + right.z * side * 1.6,
        gy,
        1.0 + 0.8 * Math.random(),
        0.9,
        (3.2 + 1.8 * Math.random()) * (0.6 + 0.6 * sp),
        0.38 * thick,
        lamp * 0.7,
        glowFade,
        0.25
      );
    }
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    ground: number,
    life: number,
    size0: number,
    size1: number,
    alpha: number,
    glow: number,
    glowFade: number,
    rise: number
  ): void {
    const budget = this.budget;
    if (budget <= 0) return;
    let i: number;
    if (this.active < budget) i = this.active++;
    else {
      // Full: the oldest-ish puff (round the pool) makes way
      i = this.cursor % budget;
      this.cursor++;
    }
    const p = this.puffs[i];
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.ground = ground;
    p.age = 0;
    p.life = life;
    p.size0 = size0 * (0.85 + 0.3 * Math.random());
    p.size1 = size1 * (0.85 + 0.3 * Math.random());
    p.alpha = alpha;
    p.spin = Math.random() * Math.PI * 2;
    p.spinRate = (Math.random() - 0.5) * 1.4;
    p.glow = glow;
    p.glowFade = glowFade;
    p.rise = rise;
  }

  /** Moves the puffs on (call once per frame, after the cars have emitted) */
  step(dt: number): void {
    this.frame++;
    // Cars that stopped emitting (gone, or dry) are forgotten after a while
    if (this.frame % 120 === 0) for (const [id, o] of this.owed) if (this.frame - o.seenFrame > 120) this.owed.delete(id);
    if (this.active === 0) {
      this.mesh.visible = false;
      this.geometry.instanceCount = 0;
      return;
    }
    const d = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
    // The air takes the mist's speed within about half a second; then it drifts with the wind
    const relax = 1 - Math.exp(-d * 2);
    const settle = 1 - Math.exp(-d * 3);
    const c = this.centers.array as Float32Array;
    const a = this.puffAttr.array as Float32Array;
    let i = 0;
    while (i < this.active) {
      const p = this.puffs[i];
      p.age += d;
      if (p.age >= p.life) {
        // Keep the live ones packed at the front
        const last = --this.active;
        if (i < last) {
          this.puffs[i] = this.puffs[last];
          this.puffs[last] = p;
        }
        continue;
      }
      p.vx += (this.windX - p.vx) * relax;
      p.vz += (this.windZ - p.vz) * relax;
      p.vy += (p.rise - p.vy) * settle;
      p.x += p.vx * d;
      p.y += p.vy * d;
      p.z += p.vz * d;
      p.spin += p.spinRate * d;
      const t = p.age / p.life;
      const grow = 1 - (1 - t) * (1 - t);
      const o = i * 4;
      c[o] = p.x;
      c[o + 1] = p.y;
      c[o + 2] = p.z;
      c[o + 3] = p.size0 + (p.size1 - p.size0) * grow;
      // In over the first few hundredths of its life, holding, then thinning out to nothing
      a[o] = p.alpha * THREE.MathUtils.smoothstep(t, 0, 0.08) * (1 - THREE.MathUtils.smoothstep(t, 0.4, 1));
      a[o + 1] = p.spin;
      a[o + 2] = p.ground;
      a[o + 3] = p.glow * Math.exp(-p.age * p.glowFade);
      i++;
    }
    this.geometry.instanceCount = this.active;
    this.mesh.visible = this.active > 0;
    if (this.active > 0) {
      this.centers.clearUpdateRanges();
      this.centers.addUpdateRange(0, this.active * 4);
      this.centers.needsUpdate = true;
      this.puffAttr.clearUpdateRanges();
      this.puffAttr.addUpdateRange(0, this.active * 4);
      this.puffAttr.needsUpdate = true;
    }
  }

  /** Every puff gone at once (a new session, a jump back) */
  clear(): void {
    this.active = 0;
    this.cursor = 0;
    this.owed.clear();
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.noise.dispose();
  }
}
