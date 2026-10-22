import * as THREE from "three";

/**
 * Falling rain around the camera: one LineSegments draw call of up to 6000 streaks, animated entirely on the GPU
 * (each streak's position wraps through a box that follows the camera), so the CPU cost per frame is a few uniform
 * writes. The streak count follows the rain intensity (draw range), and streaks lean against the camera's motion,
 * so rain at 250 km/h comes at the screen.
 */

const MAX_STREAKS = 6000;
/** Box of rain around the camera (m): wide enough for the chase cams, short enough to stay dense */
const BOX = new THREE.Vector3(44, 22, 44);
const FALL_MS = 9;

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec2 uWindXZ;
uniform float uLength;
varying float vAlpha;
void main() {
  vec3 p = aSeed.xyz * uBox;
  float fallSpeed = ${FALL_MS.toFixed(1)} * (0.85 + 0.3 * aSeed.x);
  p.y = mod(p.y - uTime * fallSpeed, uBox.y);
  p.xz += uWindXZ * uTime * 0.35;
  // Wrap around the camera so the box follows it without the streaks moving with it
  p.xz = mod(p.xz - uCamPos.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz + uCamPos.xz;
  p.y += uCamPos.y - 0.5 * uBox.y;
  // The streak runs along the drop's velocity (including wind) relative to the camera
  vec3 rel = vec3(uWindXZ.x, -fallSpeed, uWindXZ.y) - uVel;
  float speed = max(length(rel), 0.001);
  vec3 dir = rel / speed;
  p += dir * uLength * clamp(speed / 20.0, 0.6, 3.0) * aSeed.w;
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
uniform float uWiperPhase;
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
      uWiperPhase: { value: 0 },
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
  scene.add(visorMesh);

  const camPos = material.uniforms.uCamPos.value as THREE.Vector3;
  const vel = material.uniforms.uVel.value as THREE.Vector3;
  const windXZ = material.uniforms.uWindXZ.value as THREE.Vector2;
  const color = material.uniforms.uColor.value as THREE.Color;
  const visorTint = visorMat.uniforms.uTint.value as THREE.Color;
  const baseColor = new THREE.Color(0xb8c2cc);
  let time = 0;

  return {
    object,
    windscreenState,
    update(dt, intensity, camera, cameraVelocity, brightness, windVxMs = 0, windVzMs = 0, sprayIntensity = 0) {
      const r = THREE.MathUtils.clamp(intensity, 0, 1);
      const spray = THREE.MathUtils.clamp(sprayIntensity, 0, 1);
      const effectiveIntensity = Math.max(r, spray * 0.65);
      const carSpeedMs = cameraVelocity.length();
      stepWindscreenWipers(windscreenState, dt, r, spray, carSpeedMs, true);

      const showVisor = windscreenState.dropletDensity > 0.015 || spray > 0.02;
      visorMesh.visible = showVisor;
      if (showVisor) {
        visorMat.uniforms.uTime.value = time;
        visorMat.uniforms.uDroplets.value = windscreenState.dropletDensity;
        visorMat.uniforms.uSpray.value = spray;
        visorMat.uniforms.uSpeedNorm.value = THREE.MathUtils.clamp(carSpeedMs / 80, 0, 1);
        visorMat.uniforms.uWiperPhase.value = windscreenState.wiperPhase;
        visorTint.copy(baseColor).multiplyScalar(THREE.MathUtils.clamp(0.45 + 0.55 * brightness, 0.25, 1));
      }

      const count = Math.round(MAX_STREAKS * Math.pow(effectiveIntensity, 0.8));
      object.visible = count > 0;
      if (!object.visible) return;
      time = (time + dt) % 3600;
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
