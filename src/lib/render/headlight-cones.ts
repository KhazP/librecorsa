import * as THREE from "three";
import { isTouchDevice } from "@/lib/input/touch-input";
import { DETAIL_LAYER } from "./layers";
import type { HeadlightBeam } from "./car-headlights";

/**
 * Headlight beams seen in the rain at night: a soft cone of light out of each lamp, where the rain and the mist in the
 * air catch it. One instanced draw of open cones (two per car, one per lamp), additive, brightest along the axis and
 * near the lamp, fading out along the beam, at its edges, towards the road (so the lower side never shows a hard line
 * where it meets the asphalt) and close to the camera. By day the sky outshines it, and in the dry there is nothing in
 * the air to catch it: it shows from dusk on, in rain.
 *
 * The beams are the ones the falling rain is lit with (the player's first, then the nearest others): Low and phones
 * draw the player's only, Medium one other car's as well, High three.
 */

export type ConeQuality = "low" | "medium" | "high";

/** Cars whose beams show, by tier (phones take Low's) */
export const CONE_CARS: Readonly<Record<ConeQuality, number>> = { low: 1, medium: 2, high: 4 };
/** The lamps either side of the beam's line (m), the shaft's half-angle (rad) and its visible length at most (m) */
const LAMP_HALF_SPACING_M = 0.62;
const SHAFT_HALF_ANGLE = 0.2;
const SHAFT_MAX_M = 32;
/** How bright a shaft is in heavy rain at night, per unit of the beam's strength (its SpotLight intensity / 300) */
const SHAFT_GAIN = 0.04;
const MAX_CONES = CONE_CARS.high * 2;

/** 0..1: how much a beam shows in the air, from the rain and the daylight (0..1, the sky's brightness) */
export function coneVisibility(rain: number, daylight: number): number {
  const r = THREE.MathUtils.smoothstep(Number.isFinite(rain) ? rain : 0, 0.12, 0.7);
  const dark = 1 - THREE.MathUtils.clamp((Number.isFinite(daylight) ? daylight : 1) * 2.5, 0, 1);
  return r * dark;
}

const VERT = /* glsl */ `
attribute vec2 aCone; // strength, the road's height under the lamp
varying float vAlong;
varying float vStrength;
varying float vFacing;
varying float vHeight;
varying float vNear;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  vec3 toCam = cameraPosition - world.xyz;
  float dist = length(toCam);
  vAlong = position.z;
  vStrength = aCone.x;
  vFacing = abs(dot(n, toCam / max(dist, 1e-4)));
  vHeight = world.y - aCone.y;
  vNear = smoothstep(1.0, 4.0, dist);
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlong;
varying float vStrength;
varying float vFacing;
varying float vHeight;
varying float vNear;
#include <fog_pars_fragment>
void main() {
  // Bright near the lamp (but not a point at it), fading out along the beam; soft at the cone's silhouette
  float along = smoothstep(0.0, 0.06, vAlong) * pow(1.0 - vAlong, 2.0);
  float body = pow(vFacing, 1.4);
  float a = vStrength * along * body * vNear * smoothstep(0.0, 0.5, vHeight);
  if (a < 0.002) discard;
  // Added light: the fog takes it away with distance rather than tinting it
  float fade = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fade = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fade = 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(uColor * a * fade, 1.0);
}
`;

const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _side = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

export class HeadlightCones {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly coneAttr: THREE.InstancedBufferAttribute;
  private readonly touch: boolean;
  private quality: ConeQuality = "high";

  constructor(options: { touch?: boolean } = {}) {
    this.touch = options.touch ?? isTouchDevice();
    // An open cone from its apex at the origin along +Z to a unit circle at z = 1
    const geometry = new THREE.CylinderGeometry(1, 0, 1, 20, 6, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, 0.5);
    this.coneAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CONES * 2), 2);
    this.coneAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aCone", this.coneAttr);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(1, 0.95, 0.86) } }]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_CONES);
    this.mesh.name = "headlight-cones";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.layers.set(DETAIL_LAYER);
  }

  setQuality(quality: ConeQuality): void {
    this.quality = quality;
  }

  /** Cars whose beams are drawn now */
  get cars(): number {
    return this.touch ? CONE_CARS.low : CONE_CARS[this.quality];
  }

  /**
   * Per frame: the beams (the player's first), the rain (0..1) and the daylight (0..1). Cheap when it does not show:
   * the mesh is hidden.
   */
  update(beams: readonly HeadlightBeam[], count: number, rain: number, daylight: number): void {
    const show = coneVisibility(rain, daylight);
    const cars = Math.min(this.cars, count, beams.length);
    if (show < 0.01 || cars === 0) {
      this.mesh.visible = false;
      this.mesh.count = 0;
      return;
    }
    const c = this.coneAttr.array as Float32Array;
    let n = 0;
    for (let i = 0; i < cars; i++) {
      const b = beams[i];
      if (!(b.range > 0) || !(b.intensity > 0)) continue;
      const len = Math.min(SHAFT_MAX_M, b.range * 0.6);
      const r = len * Math.tan(SHAFT_HALF_ANGLE);
      _q.setFromUnitVectors(_z, b.dir);
      _s.set(r, r, len);
      // The lamps either side of the beam's line, level across the car
      _side.set(b.dir.z, 0, -b.dir.x);
      if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
      _side.normalize();
      const strength = SHAFT_GAIN * show * THREE.MathUtils.clamp(b.intensity / 300, 0, 3);
      for (const k of [-1, 1]) {
        _p.copy(b.pos).addScaledVector(_side, k * LAMP_HALF_SPACING_M);
        _m.compose(_p, _q, _s);
        this.mesh.setMatrixAt(n, _m);
        c[n * 2] = strength;
        // The road under the lamps: the beam's start is a little under a metre above it
        c[n * 2 + 1] = b.pos.y - 0.75;
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.coneAttr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
