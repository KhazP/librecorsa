import * as THREE from "three";
import { anyCarById, type CarClassId, type CarId } from "@/lib/cars/car-registry";

/**
 * Falling rain around the camera: one LineSegments draw call of up to 6000 streaks, animated entirely on the GPU
 * (each streak's position wraps through a box that follows the camera), so the CPU cost per frame is a few uniform
 * writes. The streak count follows the rain intensity (draw range), streaks lean against the camera's motion so rain
 * at 250 km/h comes at the screen, and closed-cockpit cars clip streaks against their cabin volume so rain never
 * falls inside enclosed interiors while remaining visible right outside the windscreen.
 */

const MAX_STREAKS = 6000;
/** Box of rain around the camera (m): wide enough for the chase cams, short enough to stay dense */
const BOX = new THREE.Vector3(44, 22, 44);
const FALL_MS = 9;

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
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec2 uWindXZ;
uniform float uLength;
uniform float uCockpitEnabled;
uniform mat4 uCockpitInvMatrix;
uniform vec3 uCockpitMin;
uniform vec3 uCockpitMax;
uniform vec4 uCockpitWindscreen;
varying float vAlpha;
void main() {
  vec3 pHead = aSeed.xyz * uBox;
  float fallSpeed = ${FALL_MS.toFixed(1)} * (0.85 + 0.3 * aSeed.x);
  pHead.y = mod(pHead.y - uTime * fallSpeed, uBox.y);
  pHead.xz += uWindXZ * uTime * 0.35;
  // Wrap around the camera so the box follows it without the streaks moving with it
  pHead.xz = mod(pHead.xz - uCamPos.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz + uCamPos.xz;
  pHead.y += uCamPos.y - 0.5 * uBox.y;
  // The streak runs along the drop's velocity (including wind) relative to the camera
  vec3 rel = vec3(uWindXZ.x, -fallSpeed, uWindXZ.y) - uVel;
  float speed = max(length(rel), 0.001);
  vec3 dir = rel / speed;
  vec3 pTail = pHead + dir * uLength * clamp(speed / 20.0, 0.6, 3.0);

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

  vec3 p = mix(pHead, pTail, mix(t0, t1, aSeed.w));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Fade near the camera (avoids huge streaks across the lens) and at the box edge
  float d = length(p - uCamPos);
  vAlpha = smoothstep(0.6, 2.0, d) * (1.0 - smoothstep(0.35 * uBox.x, 0.5 * uBox.x, d));
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vAlpha);
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
}

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

  const freqHz =
    state.wiperMode === "high"
      ? 1.45
      : state.wiperMode === "low"
        ? 0.85
        : state.wiperMode === "intermittent"
          ? 0.32
          : 0;
  if (freqHz > 0 || state.wiperPhase > 0.01) {
    const prev = state.wiperPhase;
    state.wiperPhase = (state.wiperPhase + Math.max(freqHz, 0.85) * dt) % 1;
    if (freqHz === 0 && state.wiperPhase < prev) state.wiperPhase = 0;
    // Wiper blade sweeps across the glass twice per cycle (out and back)
    if (Math.floor(prev * 2) !== Math.floor(state.wiperPhase * 2)) {
      state.dropletDensity *= 0.15;
    }
  } else if (state.wiperPhase > 0) {
    // Switched off with the blade still at park (phase ≤ 0.01): it settles there rather than staying a hair off it
    state.wiperPhase = 0;
  }
  return state;
}

const VISOR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const VISOR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uDroplets;
uniform float uSpray;
uniform float uSpeedNorm;
uniform vec3 uTint;
varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 centered = vUv - 0.5;
  float dist = length(centered);
  // Radial airflow blows droplets outward at speed; gravity pulls them down at low speed
  vec2 radialDir = dist > 0.001 ? centered / dist : vec2(0.0, 1.0);
  vec2 flowUv = vUv - radialDir * (uTime * 0.18 * uSpeedNorm) + vec2(0.0, uTime * 0.06 * (1.0 - 0.7 * uSpeedNorm));
  vec2 cell = floor(flowUv * vec2(28.0, 18.0));
  vec2 local = fract(flowUv * vec2(28.0, 18.0)) - 0.5;
  float h = hash21(cell);
  float bead = smoothstep(0.28, 0.06, length(local - vec2(h - 0.5, fract(h * 17.3) - 0.5) * 0.45));
  float activeBead = bead * step(1.0 - uDroplets * 0.85, h);
  // Edge vignette mist from rooster-tail spray wake
  float mist = uSpray * smoothstep(0.18, 0.72, dist) * 0.22;
  float alpha = clamp(activeBead * 0.22 * uDroplets + mist, 0.0, 0.35);
  gl_FragColor = vec4(uTint, alpha);
}
`;

export interface RainFx {
  readonly object: THREE.LineSegments;
  readonly windscreenState: WindscreenWetState;
  /**
   * Configures enclosed-cockpit streak clipping for the focused car this frame.
   * Pass `null` for open-cockpit cars (F1) or when no car cabin should occlude rain.
   */
  setCockpitOcclusion(volume: CockpitRainVolume | null, chassisMatrixWorld: THREE.Matrix4 | null): void;
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

/** Layer of the visor droplets: only a camera that enables it (the driver's eye) draws them, never the mirrors */
export const RAIN_VISOR_LAYER = 7;

export function createRainFx(scene: THREE.Scene): RainFx {
  const windscreenState: WindscreenWetState = {
    dropletDensity: 0,
    wiperPhase: 0,
    wiperMode: "off",
  };
  const seeds = new Float32Array(MAX_STREAKS * 2 * 4);
  const positions = new Float32Array(MAX_STREAKS * 2 * 3);
  for (let i = 0; i < MAX_STREAKS; i++) {
    const x = Math.random();
    const y = Math.random();
    const z = Math.random();
    for (let e = 0; e < 2; e++) {
      const k = (i * 2 + e) * 4;
      seeds[k] = x;
      seeds[k + 1] = y;
      seeds[k + 2] = z;
      seeds[k + 3] = e; // 0 = head, 1 = tail
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uBox: { value: BOX.clone() },
      uVel: { value: new THREE.Vector3() },
      uWindXZ: { value: new THREE.Vector2() },
      uLength: { value: 0.55 },
      uColor: { value: new THREE.Color(0xb8c2cc) },
      uOpacity: { value: 0.32 },
      uCockpitEnabled: { value: 0 },
      uCockpitInvMatrix: { value: new THREE.Matrix4() },
      uCockpitMin: { value: new THREE.Vector3() },
      uCockpitMax: { value: new THREE.Vector3() },
      uCockpitWindscreen: { value: new THREE.Vector4(0, 0, 1, 10) },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });

  const object = new THREE.LineSegments(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 1001;
  object.visible = false;
  scene.add(object);

  const visorGeo = new THREE.PlaneGeometry(2, 2);
  const visorMat = new THREE.ShaderMaterial({
    vertexShader: VISOR_VERT,
    fragmentShader: VISOR_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uDroplets: { value: 0 },
      uSpray: { value: 0 },
      uSpeedNorm: { value: 0 },
      uTint: { value: new THREE.Color(0xdbe4ee) },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const visorMesh = new THREE.Mesh(visorGeo, visorMat);
  visorMesh.frustumCulled = false;
  visorMesh.renderOrder = 1002;
  visorMesh.visible = false;
  visorMesh.layers.set(RAIN_VISOR_LAYER);
  scene.add(visorMesh);

  const camPos = material.uniforms.uCamPos.value as THREE.Vector3;
  const vel = material.uniforms.uVel.value as THREE.Vector3;
  const windXZ = material.uniforms.uWindXZ.value as THREE.Vector2;
  const color = material.uniforms.uColor.value as THREE.Color;
  const cockpitInvMatrix = material.uniforms.uCockpitInvMatrix.value as THREE.Matrix4;
  const cockpitMin = material.uniforms.uCockpitMin.value as THREE.Vector3;
  const cockpitMax = material.uniforms.uCockpitMax.value as THREE.Vector3;
  const cockpitWindscreen = material.uniforms.uCockpitWindscreen.value as THREE.Vector4;
  const visorTint = visorMat.uniforms.uTint.value as THREE.Color;
  const baseColor = new THREE.Color(0xb8c2cc);
  let time = 0;

  return {
    object,
    windscreenState,
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
    update(dt, intensity, camera, cameraVelocity, brightness, windVxMs = 0, windVzMs = 0, sprayIntensity = 0) {
      const r = THREE.MathUtils.clamp(intensity, 0, 1);
      const spray = THREE.MathUtils.clamp(sprayIntensity, 0, 1);
      const effectiveIntensity = Math.max(r, spray * 0.65);
      const carSpeedMs = cameraVelocity.length();
      stepWindscreenWipers(windscreenState, dt, r, spray, carSpeedMs, true);
      // The clock runs while anything is drawn, so drops left on the visor keep running after the rain stops
      time += dt;

      const showVisor = windscreenState.dropletDensity > 0.015 || spray > 0.02;
      const streaksShown = Math.round(MAX_STREAKS * Math.pow(effectiveIntensity, 0.8)) > 0;
      // The streak phase is time × a per-drop speed, so wrapping the clock moves every drop at once. Wrap it only
      // while nothing is drawn; the hard limit (float precision in the shader) is only reached by four hours of
      // unbroken rain
      if ((!showVisor && !streaksShown && time > 60) || time > RAIN_CLOCK_MAX_S) time = 0;
      visorMesh.visible = showVisor;
      if (showVisor) {
        visorMat.uniforms.uTime.value = time;
        visorMat.uniforms.uDroplets.value = windscreenState.dropletDensity;
        visorMat.uniforms.uSpray.value = spray;
        visorMat.uniforms.uSpeedNorm.value = THREE.MathUtils.clamp(carSpeedMs / 80, 0, 1);
        visorTint.copy(baseColor).multiplyScalar(THREE.MathUtils.clamp(0.45 + 0.55 * brightness, 0.25, 1));
      }

      const count = Math.round(MAX_STREAKS * Math.pow(effectiveIntensity, 0.8));
      object.visible = count > 0;
      if (!object.visible) return;
      material.uniforms.uTime.value = time;
      camera.getWorldPosition(camPos);
      // Smooth the camera velocity so camera cuts do not flick the streaks
      vel.lerp(cameraVelocity, 1 - Math.exp(-dt * 8));
      windXZ.set(Number.isFinite(windVxMs) ? windVxMs : 0, Number.isFinite(windVzMs) ? windVzMs : 0);
      geometry.setDrawRange(0, count * 2);
      color.copy(baseColor).multiplyScalar(THREE.MathUtils.clamp(0.35 + 0.65 * brightness, 0.2, 1));
      material.uniforms.uOpacity.value = 0.22 + 0.16 * effectiveIntensity;
    },
    dispose() {
      scene.remove(object);
      scene.remove(visorMesh);
      geometry.dispose();
      material.dispose();
      visorGeo.dispose();
      visorMat.dispose();
    },
  };
}
