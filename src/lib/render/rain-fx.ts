import * as THREE from "three";
import { anyCarById, type CarClassId, type CarId } from "@/lib/cars/car-registry";
import type { GraphicsQuality } from "@/lib/settings/player-settings";
import { DETAIL_LAYER } from "@/lib/render/layers";

/**
 * Falling rain around the camera: one instanced draw of streaks on `DETAIL_LAYER` (main view only, never
 * redrawn into the car reflection cubemap or mirrors), animated entirely on the GPU (each streak wraps through a
 * camera-following box; up to 4800 on High). Each streak is a soft quad along the drop's motion relative to the camera, at least about a
 * pixel wide and fainter in proportion where that is wider than the drop, so it reads at any distance without
 * aliasing into needles. Seven in ten streaks fill a near box; the rest a wider, deeper one, so rain still shows past
 * 17 m. Drops are lit as they are where they fall: faint in dark air, bright in the player's and the other cars'
 * headlight beams and under a street lamp, a little brighter looking towards the sun. Streak count scales with rain
 * intensity, graphics quality, and adaptive render-scale LOD; closed-cockpit cars clip streaks against their cabin
 * volume so rain never falls inside enclosed interiors while remaining visible right outside the windscreen.
 */

export const RAIN_STREAK_BUDGET: Readonly<Record<GraphicsQuality, number>> = {
  low: 1200,
  medium: 2800,
  high: 4800,
};
const MAX_STREAKS = RAIN_STREAK_BUDGET.high;
/** Box of rain around the camera (m): compact around the visible fade sphere (13 m) so every streak counts */
const BOX = new THREE.Vector3(26, 14, 26);
/** The far layer's box (m): its streaks fade in past the near box's reach and out by about 40 m */
const BOX_FAR = new THREE.Vector3(80, 30, 80);
/** Share of the streaks in the far layer (every streak whose index ends in 7, 8 or 9) */
const FAR_SHARE = 0.3;
/** Headlight beams that light the rain: the player's and the nearest three others' */
export const RAIN_BEAMS = 4;
const FALL_MS = 9;

/** Computes the active rain streak count for an intensity (0..1), graphics quality tier, and adaptive LOD scale (0.5..1) */
export function rainStreakCountFor(
  effectiveIntensity: number,
  quality: GraphicsQuality = "high",
  lodScale = 1
): number {
  const r = THREE.MathUtils.clamp(effectiveIntensity, 0, 1);
  if (r <= 0.001) return 0;
  const budget = RAIN_STREAK_BUDGET[quality] ?? MAX_STREAKS;
  const scale = THREE.MathUtils.clamp(Number.isFinite(lodScale) ? lodScale : 1, 0.5, 1);
  return Math.min(MAX_STREAKS, Math.round(budget * scale * Math.pow(r, 0.8)));
}

/** Longest the rain clock runs before it must wrap (s): float32 time keeps sub-millisecond steps up to here */
const RAIN_CLOCK_MAX_S = 4 * 3600;

/**
 * Enclosed cockpit occlusion volume in chassisGroup local space (+X left, +Y up, +Z forward):
 * an AABB (`min`..`max`) intersected with a forward-raked windscreen half-space (`dot(n, p) <= d`).
 */
export interface CockpitRainVolume {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  /** Outward windscreen plane `[nx, ny, nz, d]` where points inside the cabin satisfy `dot(n, p) <= d` */
  windscreenPlane: readonly [number, number, number, number];
}

interface CabinProfile {
  /** Fallback driver eye position in chassis space when model camera anchors have not loaded yet */
  defaultEye: readonly [number, number, number];
  /** Lateral half-width of the cabin interior from car centreline (m) */
  halfWidthM: number;
  /** Floor clearance below driver eye (m) */
  floorBelowEyeM: number;
  /** Roofline height above driver eye (m) */
  roofAboveEyeM: number;
  /** Rear bulkhead distance behind driver eye (m) */
  rearBehindEyeM: number;
  /** Lower windscreen / cowl distance ahead of driver eye (m) */
  frontAheadOfEyeM: number;
  /** Upper windscreen header distance ahead of driver eye (m; smaller than frontAheadOfEyeM for raked glass) */
  roofFrontAheadOfEyeM: number;
}

const CABIN_CLASS_PROFILES: Readonly<Record<Exclude<CarClassId, "f1">, CabinProfile>> = {
  gt3: {
    defaultEye: [0.4, 0.95, -0.58],
    halfWidthM: 0.78,
    floorBelowEyeM: 0.85,
    roofAboveEyeM: 0.34,
    rearBehindEyeM: 0.82,
    frontAheadOfEyeM: 0.96,
    roofFrontAheadOfEyeM: 0.48,
  },
  proto: {
    defaultEye: [0.22, 0.82, -0.25],
    halfWidthM: 0.68,
    floorBelowEyeM: 0.72,
    roofAboveEyeM: 0.28,
    rearBehindEyeM: 0.76,
    frontAheadOfEyeM: 0.88,
    roofFrontAheadOfEyeM: 0.38,
  },
  classic: {
    defaultEye: [0.35, 0.92, -0.48],
    halfWidthM: 0.74,
    floorBelowEyeM: 0.82,
    roofAboveEyeM: 0.34,
    rearBehindEyeM: 0.82,
    frontAheadOfEyeM: 0.98,
    roofFrontAheadOfEyeM: 0.50,
  },
  road: {
    defaultEye: [0.36, 1.05, -0.45],
    halfWidthM: 0.76,
    floorBelowEyeM: 0.92,
    roofAboveEyeM: 0.38,
    rearBehindEyeM: 0.95,
    frontAheadOfEyeM: 0.96,
    roofFrontAheadOfEyeM: 0.48,
  },
};

const CABIN_CAR_OVERRIDES: Partial<Record<CarId, Partial<CabinProfile>>> = {
  "lc-lmdh": {
    halfWidthM: 0.64,
    roofAboveEyeM: 0.26,
    rearBehindEyeM: 0.72,
    frontAheadOfEyeM: 0.80,
    roofFrontAheadOfEyeM: 0.32,
  },
  "mtr-496r": {
    halfWidthM: 0.74,
    roofAboveEyeM: 0.28,
    frontAheadOfEyeM: 1.05,
    roofFrontAheadOfEyeM: 0.55,
  },
  "bmw-m1-procar": {
    frontAheadOfEyeM: 1.04,
    roofFrontAheadOfEyeM: 0.54,
  },
};

/** Whether a car has an enclosed cockpit (open-cockpit F1 single-seaters return false) */
export function carHasClosedCockpit(carId: CarId): boolean {
  const cls = anyCarById(carId)?.classId;
  return cls !== undefined ? cls !== "f1" : carId !== "lc26";
}

/**
 * Computes the enclosed cabin occlusion volume in chassisGroup local space for `carId`, anchored to the car's
 * loaded cockpit eye point when available. Returns `null` for open-cockpit cars (F1).
 */
export function cockpitRainVolumeFor(
  carId: CarId,
  eyePos?: { readonly x: number; readonly y: number; readonly z: number } | null
): CockpitRainVolume | null {
  if (!carHasClosedCockpit(carId)) return null;
  const cls = anyCarById(carId)?.classId;
  const base = CABIN_CLASS_PROFILES[cls && cls !== "f1" ? cls : "gt3"];
  const ov = CABIN_CAR_OVERRIDES[carId];
  const p = ov ? { ...base, ...ov } : base;

  const ex = eyePos ? eyePos.x : p.defaultEye[0];
  const ey = eyePos ? eyePos.y : p.defaultEye[1];
  const ez = eyePos ? eyePos.z : p.defaultEye[2];

  const halfW = Math.max(p.halfWidthM, Math.abs(ex) + 0.36);
  const minY = Math.max(0.08, ey - p.floorBelowEyeM);
  const maxY = ey + p.roofAboveEyeM;
  const minZ = ez - p.rearBehindEyeM;
  const maxZ = ez + p.frontAheadOfEyeM;
  const roofFrontZ = ez + p.roofFrontAheadOfEyeM;

  // Sloped windscreen plane from lower cowl (yBase, maxZ) back to roof header (maxY, roofFrontZ).
  // Outward unit normal points forward (+Z) and upward (+Y); interior points satisfy dot(n, pos) <= d.
  const yBase = Math.max(minY, ey - 0.16);
  const nyRaw = Math.max(0.05, maxZ - roofFrontZ);
  const nzRaw = Math.max(0.05, maxY - yBase);
  const len = Math.hypot(nyRaw, nzRaw);
  const ny = nyRaw / len;
  const nz = nzRaw / len;
  const d = ny * yBase + nz * maxZ;

  return {
    min: [-halfW, minY, minZ],
    max: [halfW, maxY, maxZ],
    windscreenPlane: [0, ny, nz, d],
  };
}

export interface RainStreakClipResult {
  /** Whether the streak intersected the cockpit volume */
  clipped: boolean;
  /** False when the entire streak lies inside the cockpit (culled) */
  visible: boolean;
  /** Remaining exterior parametric start along [head -> tail] (0..1) */
  t0: number;
  /** Remaining exterior parametric end along [head -> tail] (0..1) */
  t1: number;
}

/**
 * Exact CPU mirror of the vertex shader's Cyrus-Beck segment clipping against an enclosed cockpit volume.
 * Used for deterministic verification of closed-cockpit rain exclusion.
 */
export function clipRainStreakAgainstCockpit(
  headLocal: readonly [number, number, number],
  tailLocal: readonly [number, number, number],
  volume: CockpitRainVolume
): RainStreakClipResult {
  const dx = tailLocal[0] - headLocal[0];
  const dy = tailLocal[1] - headLocal[1];
  const dz = tailLocal[2] - headLocal[2];
  let tEnter = 0;
  let tExit = 1;

  const axes: readonly [number, number, number, number][] = [
    [headLocal[0], dx, volume.min[0], volume.max[0]],
    [headLocal[1], dy, volume.min[1], volume.max[1]],
    [headLocal[2], dz, volume.min[2], volume.max[2]],
  ];
  for (const [o, d, mn, mx] of axes) {
    if (Math.abs(d) < 1e-6) {
      if (o < mn || o > mx) return { clipped: false, visible: true, t0: 0, t1: 1 };
    } else {
      const inv = 1 / d;
      const a = (mn - o) * inv;
      const b = (mx - o) * inv;
      tEnter = Math.max(tEnter, Math.min(a, b));
      tExit = Math.min(tExit, Math.max(a, b));
    }
  }

  const [nx, ny, nz, pd] = volume.windscreenPlane;
  const denom = nx * dx + ny * dy + nz * dz;
  const numer = pd - (nx * headLocal[0] + ny * headLocal[1] + nz * headLocal[2]);
  if (Math.abs(denom) < 1e-6) {
    if (numer < 0) return { clipped: false, visible: true, t0: 0, t1: 1 };
  } else if (denom > 0) {
    tExit = Math.min(tExit, numer / denom);
  } else {
    tEnter = Math.max(tEnter, numer / denom);
  }

  if (tEnter >= tExit) return { clipped: false, visible: true, t0: 0, t1: 1 };

  const preLen = tEnter;
  const postLen = 1 - tExit;
  if (preLen <= 0.02 && postLen <= 0.02) {
    return { clipped: true, visible: false, t0: 0, t1: 0 };
  }
  if (preLen >= postLen) {
    return { clipped: true, visible: true, t0: 0, t1: tEnter };
  }
  return { clipped: true, visible: true, t0: tExit, t1: 1 };
}

const VERT = /* glsl */ `
attribute vec4 aSeed; // per streak: position in its box (0..1), layer (0 near, 1 far)
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform vec3 uBoxFar;
uniform vec3 uVel;
uniform vec2 uWindXZ;
uniform float uLength;
uniform float uPixelAngle;
uniform vec3 uAmbient;
uniform vec3 uLamp;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec4 uBeamPos[${RAIN_BEAMS}]; // xyz, reach (0: off)
uniform vec4 uBeamDir[${RAIN_BEAMS}]; // unit direction, strength
uniform float uCockpitEnabled;
uniform mat4 uCockpitInvMatrix;
uniform vec3 uCockpitMin;
uniform vec3 uCockpitMax;
uniform vec4 uCockpitWindscreen;
varying float vAlpha;
varying vec2 vQuad;
varying vec3 vColor;

// A headlight's light on a drop at p, seen from the camera: inside the beam, fading with distance, brightest when
// looking along the beam (drops scatter the light mostly forward)
vec3 beamLight(vec3 p, vec3 view, vec4 pos, vec4 dir) {
  if (pos.w <= 0.0) return vec3(0.0);
  vec3 d = p - pos.xyz;
  float dist = length(d);
  if (dist > pos.w || dist < 0.05) return vec3(0.0);
  float cone = smoothstep(0.82, 0.96, dot(d / dist, dir.xyz));
  float fall = 1.0 - dist / pos.w;
  float forward = 0.45 + 1.6 * pow(max(dot(view, dir.xyz), 0.0), 4.0);
  return vec3(1.0, 0.96, 0.88) * dir.w * cone * fall * fall * forward;
}

void main() {
  bool far = aSeed.w > 0.5;
  vec3 box = far ? uBoxFar : uBox;
  vec3 pHead = aSeed.xyz * box;
  float fallSpeed = ${FALL_MS.toFixed(1)} * (0.85 + 0.3 * aSeed.x);
  pHead.y = mod(pHead.y - uTime * fallSpeed, box.y);
  pHead.xz += uWindXZ * uTime * 0.35;
  // Wrap around the camera so the box follows it without the streaks moving with it
  pHead.xz = mod(pHead.xz - uCamPos.xz + 0.5 * box.xz, box.xz) - 0.5 * box.xz + uCamPos.xz;
  pHead.y += uCamPos.y - 0.5 * box.y;
  // The streak runs along the drop's velocity (including wind) relative to the camera
  vec3 rel = vec3(uWindXZ.x, -fallSpeed, uWindXZ.y) - uVel;
  float speed = max(length(rel), 0.001);
  vec3 dir = rel / speed;
  vec3 pTail = pHead + dir * uLength * clamp(speed / 20.0, 0.6, 3.0);

  // Reject streaks whose entire span sits outside the outer fade sphere before rasterization (every corner agrees)
  float reach = far ? 0.5 * uBoxFar.x : 0.5 * uBox.x;
  float midDist = length(0.5 * (pHead + pTail) - uCamPos);
  if (midDist > reach + 1.5) {
    vAlpha = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float t0 = 0.0;
  float t1 = 1.0;
  if (uCockpitEnabled > 0.5) {
    vec3 lHead = (uCockpitInvMatrix * vec4(pHead, 1.0)).xyz;
    vec3 lTail = (uCockpitInvMatrix * vec4(pTail, 1.0)).xyz;
    vec3 lDir = lTail - lHead;
    float tEnter = 0.0;
    float tExit = 1.0;
    bool hit = true;

    for (int axis = 0; axis < 3; axis++) {
      float o = axis == 0 ? lHead.x : (axis == 1 ? lHead.y : lHead.z);
      float d = axis == 0 ? lDir.x : (axis == 1 ? lDir.y : lDir.z);
      float mn = axis == 0 ? uCockpitMin.x : (axis == 1 ? uCockpitMin.y : uCockpitMin.z);
      float mx = axis == 0 ? uCockpitMax.x : (axis == 1 ? uCockpitMax.y : uCockpitMax.z);
      if (abs(d) < 1e-6) {
        if (o < mn || o > mx) hit = false;
      } else {
        float invD = 1.0 / d;
        float ta = (mn - o) * invD;
        float tb = (mx - o) * invD;
        tEnter = max(tEnter, min(ta, tb));
        tExit = min(tExit, max(ta, tb));
      }
    }

    if (hit) {
      float denom = dot(uCockpitWindscreen.xyz, lDir);
      float numer = uCockpitWindscreen.w - dot(uCockpitWindscreen.xyz, lHead);
      if (abs(denom) < 1e-6) {
        if (numer < 0.0) hit = false;
      } else if (denom > 0.0) {
        tExit = min(tExit, numer / denom);
      } else {
        tEnter = max(tEnter, numer / denom);
      }
    }

    if (hit && tEnter < tExit) {
      float preLen = tEnter;
      float postLen = 1.0 - tExit;
      if (preLen <= 0.02 && postLen <= 0.02) {
        vAlpha = 0.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      } else if (preLen >= postLen) {
        t1 = tEnter;
      } else {
        t0 = tExit;
      }
    }
  }

  // The quad: along the visible span of the streak (position.y 0 head .. 1 tail), across it facing the camera
  vec3 pA = mix(pHead, pTail, t0);
  vec3 pB = mix(pHead, pTail, t1);
  vec3 p = mix(pA, pB, position.y);
  vec3 toCam = uCamPos - p;
  float dist = max(length(toCam), 0.05);
  vec3 side = cross(dir, toCam / dist);
  float sideLen = length(side);
  side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);
  // A drop is about 1.5 mm across; drawn no thinner than about a pixel (far ones a little more), fainter to match
  float halfTrue = 0.0008;
  float halfMin = dist * uPixelAngle * (far ? 0.9 : 0.6);
  float halfWidth = max(halfTrue, halfMin);
  p += side * position.x * halfWidth;
  vQuad = vec2(position.x, position.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  // Fade near the camera (no huge streaks across the lens) and at the layer's reach; the far layer fades in where
  // the near one ends
  float fade = smoothstep(0.6, 2.0, dist) * (1.0 - smoothstep(0.7 * reach, reach, dist));
  if (far) fade *= smoothstep(0.35 * uBox.x, 0.5 * uBox.x, dist);
  float thin = clamp(halfTrue / halfWidth, far ? 0.25 : 0.45, 1.0);
  vAlpha = fade * thin;

  // Lit where it falls
  vec3 view = -toCam / dist;
  vec3 light = uAmbient + uLamp;
  light += uSunColor * pow(max(dot(view, uSunDir), 0.0), 6.0);
  for (int i = 0; i < ${RAIN_BEAMS}; i++) light += beamLight(p, view, uBeamPos[i], uBeamDir[i]);
  vColor = light;
}
`;

const FRAG = /* glsl */ `
uniform float uOpacity;
varying float vAlpha;
varying vec2 vQuad;
varying vec3 vColor;
void main() {
  // Soft across the streak, a rounded bright head and a feathered tail
  float across = exp(-vQuad.x * vQuad.x * 3.5);
  float along = smoothstep(0.0, 0.12, vQuad.y) * (1.0 - 0.65 * smoothstep(0.25, 1.0, vQuad.y));
  float a = uOpacity * vAlpha * across * along;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

/** Windscreen wiper operating mode for closed-cockpit vehicles */
export type WiperMode = "off" | "intermittent" | "low" | "high";

export interface WindscreenWetState {
  /** Normalized water droplet accumulation on the windscreen/visor (0..1) */
  dropletDensity: number;
  /** Current wiper blade sweep phase (0..1, 0 = parked, 0.5 = apex) */
  wiperPhase: number;
  /** Active wiper mode */
  wiperMode: WiperMode;
  /** Intermittent wipers: seconds left resting at park before the next stroke */
  wiperRestS?: number;
}

/** Wiper strokes per second (out and back) on the slow and fast settings; intermittent strokes at the slow speed */
const WIPER_SLOW_HZ = 0.8;
const WIPER_FAST_HZ = 1.3;
/** Intermittent wipers rest this long at park between strokes (s) */
const WIPER_REST_S = 2.6;

/**
 * Advances windscreen/visor raindrop accumulation, gravity & airflow run-off (`raindropGravityForce` / `raindropSpeedForce`),
 * and wiper sweep clearing.
 */
export function stepWindscreenWipers(
  state: WindscreenWetState,
  dt: number,
  rainIntensity: number,
  sprayIntensity: number,
  carSpeedMs: number,
  autoWipers = true
): WindscreenWetState {
  const rain = Math.max(0, Math.min(1, rainIntensity));
  const spray = Math.max(0, Math.min(1, sprayIntensity));
  const totalInflow = rain * 0.55 + spray * 0.45;
  if (autoWipers) {
    state.wiperMode =
      totalInflow > 0.55 ? "high" : totalInflow > 0.22 ? "low" : totalInflow > 0.04 ? "intermittent" : "off";
  }
  const gravityRunoff = 0.06;
  const airflowRunoff = Math.min(0.65, (Math.max(0, carSpeedMs) / 75) ** 1.4 * 0.38);
  const netGain = totalInflow * (1 + Math.min(1.2, carSpeedMs / 55)) - (gravityRunoff + airflowRunoff) * state.dropletDensity;
  state.dropletDensity = Math.max(0, Math.min(1, state.dropletDensity + netGain * dt));

  const mode = state.wiperMode;
  const strokeHz = mode === "high" ? WIPER_FAST_HZ : mode === "off" ? 0 : WIPER_SLOW_HZ;
  // Intermittent: a full-speed stroke, then a rest at park
  if (mode === "intermittent" && state.wiperPhase === 0 && (state.wiperRestS ?? 0) > 0) {
    state.wiperRestS = Math.max(0, (state.wiperRestS ?? 0) - dt);
    return state;
  }
  if (strokeHz > 0 || state.wiperPhase > 0.01) {
    const prev = state.wiperPhase;
    let next = prev + Math.max(strokeHz, WIPER_SLOW_HZ) * dt;
    if (next >= 1) {
      // A stroke ends back at park: switched off it stays there, intermittent rests there
      if (mode === "off" || mode === "intermittent") {
        next = 0;
        state.wiperRestS = mode === "intermittent" ? WIPER_REST_S : 0;
      } else next -= 1;
    }
    state.wiperPhase = next;
    // Wiper blade sweeps across the glass twice per cycle (out and back)
    if (Math.floor(prev * 2) !== Math.floor(next * 2) || next < prev) {
      state.dropletDensity *= 0.15;
    }
  } else if (state.wiperPhase > 0) {
    // Switched off with the blade still at park (phase ≤ 0.01): it settles there rather than staying a hair off it
    state.wiperPhase = 0;
  }
  return state;
}

/** What lights the rain this frame (all optional: unlit rain takes the sky's light only) */
export interface RainLight {
  /** Headlight beams, the player's first (unit direction; intensity as a SpotLight's, decay 1; reach in metres) */
  beams: readonly { pos: THREE.Vector3; dir: THREE.Vector3; intensity: number; range: number }[];
  beamCount: number;
  /** A street lamp's light where the camera is (linear irradiance, black where there is none) */
  lamp: THREE.Color | null;
  /** Direction to the sun (or moon) and how much of it reaches the rain (0 under a thick deck) */
  sunDir: THREE.Vector3 | null;
  sunShare: number;
}

export interface RainFx {
  readonly object: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly windscreenState: WindscreenWetState;
  /** Sets the graphics tier and adaptive render-scale LOD (0.5..1) that cap active rain streak draw count */
  setQuality(quality: GraphicsQuality, lodScale?: number): void;
  /**
   * Configures enclosed-cockpit streak clipping for the focused car this frame.
   * Pass `null` for open-cockpit cars (F1) or when no car cabin should occlude rain.
   */
  setCockpitOcclusion(volume: CockpitRainVolume | null, chassisMatrixWorld: THREE.Matrix4 | null): void;
  /** This frame's lights on the rain (call before update) */
  setLight(light: RainLight): void;
  /** The drawing buffer's height (px): the streaks are kept about a pixel wide at least */
  setViewportHeight(px: number): void;
  /**
   * Per frame: rain intensity 0..1, the camera, its world velocity (m/s), the sky brightness (0..1, darker rain at
   * dusk), optional world wind velocity (m/s), and optional rooster-tail spray wake intensity (0..1).
   */
  update(
    dt: number,
    intensity: number,
    camera: THREE.Camera,
    cameraVelocity: THREE.Vector3,
    brightness: number,
    windVxMs?: number,
    windVzMs?: number,
    sprayIntensity?: number
  ): void;
  dispose(): void;
}

export function createRainFx(scene: THREE.Scene): RainFx {
  const windscreenState: WindscreenWetState = {
    dropletDensity: 0,
    wiperPhase: 0,
    wiperMode: "off",
  };
  // A quad per streak: x across (-1..1), y along (0 head .. 1 tail)
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  const seeds = new Float32Array(MAX_STREAKS * 4);
  for (let i = 0; i < MAX_STREAKS; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    // Any first n streaks hold the same share of far ones
    seeds[i * 4 + 3] = i % 10 >= 10 * (1 - FAR_SHARE) ? 1 : 0;
  }
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = 0;

  const beamPos = Array.from({ length: RAIN_BEAMS }, () => new THREE.Vector4());
  const beamDir = Array.from({ length: RAIN_BEAMS }, () => new THREE.Vector4());
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: BOX.clone() },
      uBoxFar: { value: BOX_FAR.clone() },
      uVel: { value: new THREE.Vector3() },
      uWindXZ: { value: new THREE.Vector2() },
      uLength: { value: 0.55 },
      uPixelAngle: { value: 0.001 },
      uAmbient: { value: new THREE.Color(0xb8c2cc) },
      uLamp: { value: new THREE.Color(0, 0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0, 0, 0) },
      uBeamPos: { value: beamPos },
      uBeamDir: { value: beamDir },
      uOpacity: { value: 0.32 },
      uCockpitEnabled: { value: 0 },
      uCockpitInvMatrix: { value: new THREE.Matrix4() },
      uCockpitMin: { value: new THREE.Vector3() },
      uCockpitMax: { value: new THREE.Vector3() },
      uCockpitWindscreen: { value: new THREE.Vector4(0, 0, 1, 10) },
    },
    transparent: true,
    depthWrite: false,
    // The quad turns to face the camera whichever way its corners wind
    side: THREE.DoubleSide,
    fog: false,
  });

  const object = new THREE.Mesh(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 1001;
  object.visible = false;
  // View-only detail layer: drawn by the main and XR cameras, skipped by the car reflection probe and mirrors
  object.layers.set(DETAIL_LAYER);
  scene.add(object);

  const camPos = material.uniforms.uCamPos.value as THREE.Vector3;
  const vel = material.uniforms.uVel.value as THREE.Vector3;
  const windXZ = material.uniforms.uWindXZ.value as THREE.Vector2;
  const ambient = material.uniforms.uAmbient.value as THREE.Color;
  const lamp = material.uniforms.uLamp.value as THREE.Color;
  const sunDir = material.uniforms.uSunDir.value as THREE.Vector3;
  const sunColor = material.uniforms.uSunColor.value as THREE.Color;
  const cockpitInvMatrix = material.uniforms.uCockpitInvMatrix.value as THREE.Matrix4;
  const cockpitMin = material.uniforms.uCockpitMin.value as THREE.Vector3;
  const cockpitMax = material.uniforms.uCockpitMax.value as THREE.Vector3;
  const cockpitWindscreen = material.uniforms.uCockpitWindscreen.value as THREE.Vector4;
  const baseColor = new THREE.Color(0xb8c2cc);
  let qualityNow: GraphicsQuality = "high";
  let lodScaleNow = 1;
  let time = 0;
  let viewportPx = 900;

  return {
    object,
    windscreenState,
    setQuality(quality, lodScale = 1) {
      qualityNow = quality;
      lodScaleNow = THREE.MathUtils.clamp(Number.isFinite(lodScale) ? lodScale : 1, 0.5, 1);
    },
    setCockpitOcclusion(volume, chassisMatrixWorld) {
      if (!volume || !chassisMatrixWorld || Math.abs(chassisMatrixWorld.determinant()) < 1e-12) {
        material.uniforms.uCockpitEnabled.value = 0;
        return;
      }
      cockpitInvMatrix.copy(chassisMatrixWorld).invert();
      cockpitMin.set(volume.min[0], volume.min[1], volume.min[2]);
      cockpitMax.set(volume.max[0], volume.max[1], volume.max[2]);
      cockpitWindscreen.set(
        volume.windscreenPlane[0],
        volume.windscreenPlane[1],
        volume.windscreenPlane[2],
        volume.windscreenPlane[3]
      );
      material.uniforms.uCockpitEnabled.value = 1;
    },
    setViewportHeight(px) {
      if (Number.isFinite(px) && px > 0) viewportPx = px;
    },
    setLight(light) {
      const n = Math.min(RAIN_BEAMS, light.beamCount, light.beams.length);
      for (let i = 0; i < RAIN_BEAMS; i++) {
        const b = i < n ? light.beams[i] : null;
        if (!b) {
          beamPos[i].set(0, 0, 0, 0);
          continue;
        }
        beamPos[i].set(b.pos.x, b.pos.y, b.pos.z, b.range);
        // A low beam's SpotLight is a few hundred cd-units: drops in its core glow several times the daylight rain
        beamDir[i].set(b.dir.x, b.dir.y, b.dir.z, THREE.MathUtils.clamp(b.intensity / 50, 0, 16));
      }
      if (light.lamp) lamp.copy(light.lamp).multiplyScalar(0.35);
      else lamp.setRGB(0, 0, 0);
      if (light.sunDir) sunDir.copy(light.sunDir).normalize();
      sunColor.setRGB(1, 0.95, 0.85).multiplyScalar(0.8 * THREE.MathUtils.clamp(light.sunShare, 0, 1));
    },
    update(dt, intensity, camera, cameraVelocity, brightness, windVxMs = 0, windVzMs = 0, sprayIntensity = 0) {
      const r = THREE.MathUtils.clamp(intensity, 0, 1);
      const spray = THREE.MathUtils.clamp(sprayIntensity, 0, 1);
      const effectiveIntensity = Math.max(r, spray * 0.65);
      const carSpeedMs = cameraVelocity.length();
      stepWindscreenWipers(windscreenState, dt, r, spray, carSpeedMs, true);
      time += dt;

      const count = rainStreakCountFor(effectiveIntensity, qualityNow, lodScaleNow);
      const streaksShown = count > 0;
      // The streak phase is time × a per-drop speed, so wrapping the clock moves every drop at once. Wrap it only
      // while nothing is drawn; the hard limit (float precision in the shader) is only reached by four hours of
      // unbroken rain
      if ((!streaksShown && time > 60) || time > RAIN_CLOCK_MAX_S) time = 0;

      object.visible = streaksShown;
      if (!object.visible) return;
      material.uniforms.uTime.value = time;
      camera.getWorldPosition(camPos);
      // Smooth the camera velocity so camera cuts do not flick the streaks
      vel.lerp(cameraVelocity, 1 - Math.exp(-dt * 8));
      windXZ.set(Number.isFinite(windVxMs) ? windVxMs : 0, Number.isFinite(windVzMs) ? windVzMs : 0);
      geometry.instanceCount = count;
      // A pixel's angle at the screen's middle, for the streaks' smallest width
      const cam = camera as THREE.PerspectiveCamera;
      if (cam.isPerspectiveCamera) {
        material.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / viewportPx;
      }
      // The sky's light on the rain: by day a pale grey that shows against the stands and trees, at night barely
      // there (the beams and the lamps light it)
      ambient.copy(baseColor).multiplyScalar(0.06 + 1.3 * THREE.MathUtils.clamp(brightness, 0, 1));
      material.uniforms.uOpacity.value = 0.35 + 0.25 * effectiveIntensity;
    },
    dispose() {
      scene.remove(object);
      geometry.dispose();
      material.dispose();
    },
  };
}
