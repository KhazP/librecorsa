/**
 * Visual Simulation FX: Persistent Tire Skidmark Ribbons, Instanced Tire Smoke/Gravel
 * Particles & Multiplayer/AI Opponent Car 3D Renderer
 *
 * - Dynamic persistent quad-strip ribbon mesh for 4-wheel tire skidmarks, darkened by how hard each tyre slides past
 *   its grip (`tyre-slide-fx.ts`), and furrows in grass.
 * - `THREE.InstancedMesh` tire smoke (from the same sliding, `tyre-slide-fx.ts`), spray and off-track gravel/grass
 *   debris particles emitted at each wheel's 3D contact patch.
 * - Opponent vehicle 3D rig manager driven by `MultiplayerSyncManager` Cubic Hermite + Slerp states.
 */

import { steerNormOf } from './car-pose';
import * as THREE from 'three';
import { createF1Car2026, type SimCarRig } from '@/lib/car-builder-2026';
import type { WheelSeating } from '@/lib/render/corner-rig';
import { createPortedCarRig, loadTemplate as loadPortedTemplate } from '@/lib/ported-car-model';
import { staticFloorOf } from '@/lib/render/body-floor';
import { CAR_WHEEL_LOCKS_DEG } from '@/lib/input/device-input';
import { SUZUKI_LIANA_CONFIG } from './road/SuzukiLianaConfig';
import { MTR_496R_CONFIG } from './proto/Mtr496rConfig';
import { AMG_GT3_CONFIG } from './gt3/AmgGt3Config';
import { AMR26_MODEL_URL, loadVf26Template } from '@/lib/vf26-car-model';
import { assetProgress } from '@/lib/loading/asset-progress';
import { addContactShadow, seatContactShadow } from '@/lib/render/contact-shadow';
import { disposeTree } from '@/lib/render/dispose-tree';
import { LIVERIES } from '@/lib/track-data';
import { CarTelemetry, LiveryConfig, type VehicleModelId } from '@/types/f1';
import type { SimulatorWheel as SimWheelState } from './simulator-car';
import { GHOST_OPACITY, ghostFade } from './ghost-align';
import { InterpolatedPeerState } from './multiplayer-sync';
import { tyreMarkLevel, tyreSmokeLevel } from './tyre-slide-fx';

const MAX_SKID_SEGMENTS = 900; // Ring buffer of 4-vertex quad segments across all 4 wheels
const MAX_PARTICLES = 360;
/** Tyre smoke puffs per second from one wheel at full smoke (`tyre-slide-fx.ts`) */
const SMOKE_PUFFS_PER_S = 40;
/** Smoke builds within a few hundredths of a second of a lock-up and clears a little slower once the tyre grips again */
const SMOKE_RISE_S = 0.05;
const SMOKE_FALL_S = 0.18;
/** A skid mark darkens as quickly as the tyre starts to slide and fades out over a few centimetres of road */
const MARK_RISE_S = 0.03;
const MARK_FALL_S = 0.08;

/**
 * Soft puffs: camera-facing quads with a noisy radial falloff, fading in and out over their life, and fading out
 * close to the camera so a puff never fills the lens. Instance scale comes from the instance matrix; the per-instance
 * opacity and spin from `aPuff`.
 */
const PUFF_VERT = /* glsl */ `
attribute vec2 aPuff;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec3 center = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float scale = length(instanceMatrix[0].xyz);
  vec4 mv = modelViewMatrix * vec4(center, 1.0);
  float c = cos(aPuff.y);
  float s = sin(aPuff.y);
  mv.xy += mat2(c, s, -s, c) * position.xy * scale;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
  #else
  vColor = vec3(1.0);
  #endif
  vAlpha = aPuff.x * smoothstep(0.9, 3.5, -mv.z);
}
`;

const PUFF_FRAG = /* glsl */ `
uniform float uLight;
varying vec2 vUv;
varying float vAlpha;
varying vec3 vColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 q = vUv - 0.5;
  float r = length(q) * 2.0;
  float body = 1.0 - smoothstep(0.15, 1.0, r);
  float wisp = 0.55 * noise(q * 5.0 + 3.1) + 0.45 * noise(q * 11.0 - 1.7);
  float a = body * body * (0.45 + 0.75 * wisp) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * uLight, a);
}
`;

interface ParticleInstance {
  active: boolean;
  age: number;
  maxAge: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  scale0: number;
  scale1: number;
  /** Peak opacity, reached just after the puff is born */
  alpha: number;
  spin: number;
  spinRate: number;
  color: THREE.Color;
}

export class SimVisualFxManager {
  public readonly group = new THREE.Group();

  // Skidmark ribbon state
  private skidGeom: THREE.BufferGeometry;
  private skidPositions: Float32Array;
  private skidColors: Float32Array;
  private skidMesh: THREE.Mesh;
  private skidHead = 0;
  private lastWheelSkidPos: Array<THREE.Vector3 | null> = [null, null, null, null];

  // Instanced smoke / gravel particle state
  private particleMesh: THREE.InstancedMesh;
  private particleMat: THREE.ShaderMaterial;
  private puffAttr: THREE.InstancedBufferAttribute;
  private particles: ParticleInstance[] = [];
  private particleCursor = 0;
  private emitTimer = 0;
  private dummy = new THREE.Object3D();
  /** Road wetness under the player's car (0..1): rear-wheel spray at speed */
  private wetness = 0;
  /** Per wheel (FR, FL, RR, RL): smoothed smoke level 0..1, puffs owed, and the contact's world velocity (smoothed) */
  private readonly smokeLevel = [0, 0, 0, 0];
  /** Per wheel: smoothed skid-mark darkness 0..1 on a paved surface */
  private readonly markLevel = [0, 0, 0, 0];
  private readonly smokeOwed = [0, 0, 0, 0];
  private readonly wheelPrevPos = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly wheelVel = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private wheelVelValid = false;

  // Multiplayer / AI Opponent 3D cars
  /** wheelRot: the wheels' spin angle (rad), integrated from their speed each frame */
  private opponentCars = new Map<
    string,
    {
      rig: SimCarRig;
      /** The car and look the rig was built for: another car rebuilds it, the other look swaps to `spare` */
      vehicle: VehicleModelId | undefined;
      ghost: boolean;
      /** The rig of the other look (solid / ghost), hidden, once the car has changed look */
      spare?: SimCarRig;
      wheelRot: number;
      telemetry?: CarTelemetry;
      /** The AI car's wheels on its ground at the drawn pose (refreshed in place each frame) */
      wheels?: WheelSeating;
      ghostCheckS?: number;
      /** A ghost's translucent materials, faded as it nears the player's car */
      ghostMats?: THREE.Material[];
    }
  >();
  /** The player's car (mean of its wheels) while it is driven; null in replays and menus (the ghost is not faded) */
  private readonly playerPos = new THREE.Vector3();
  private playerPosValid = false;
  /**
   * Rigs built during loading (one racing car and one ghost per opponent model) so the shader warm-up covers them;
   * handed out to the first peers that need that model instead of being built on the first frame of a race
   */
  private pool = new Map<string, SimCarRig[]>();
  /**
   * One pre-warm per kind of car, settling true once its rigs are built (false when it failed, and then dropped so a
   * later call tries again); a call while it runs waits for the same one
   */
  private prewarms = new Map<string, Promise<boolean>>();

  constructor() {
    // 1. Initialize Persistent Tire Skidmark Ribbon Mesh
    const vertCount = MAX_SKID_SEGMENTS * 4;
    this.skidPositions = new Float32Array(vertCount * 3);
    this.skidColors = new Float32Array(vertCount * 4);
    const indices = new Uint16Array(MAX_SKID_SEGMENTS * 6);

    for (let i = 0; i < MAX_SKID_SEGMENTS; i++) {
      const v = i * 4;
      const idx = i * 6;
      indices[idx] = v;
      indices[idx + 1] = v + 1;
      indices[idx + 2] = v + 2;
      indices[idx + 3] = v + 1;
      indices[idx + 4] = v + 3;
      indices[idx + 5] = v + 2;
    }

    this.skidGeom = new THREE.BufferGeometry();
    this.skidGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(this.skidPositions, 3)
    );
    this.skidGeom.setAttribute(
      'color',
      new THREE.BufferAttribute(this.skidColors, 4)
    );
    this.skidGeom.setIndex(new THREE.BufferAttribute(indices, 1));

    const skidMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    this.skidMesh = new THREE.Mesh(this.skidGeom, skidMat);
    this.skidMesh.frustumCulled = false;
    this.group.add(this.skidMesh);

    // 2. Instanced soft puffs: tyre smoke, spray and off-track dust
    const puffGeom = new THREE.PlaneGeometry(1, 1);
    this.puffAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 2), 2);
    this.puffAttr.setUsage(THREE.DynamicDrawUsage);
    puffGeom.setAttribute('aPuff', this.puffAttr);
    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      uniforms: { uLight: { value: 1 } },
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.particleMesh = new THREE.InstancedMesh(puffGeom, this.particleMat, MAX_PARTICLES);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.renderOrder = 2;
    this.particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        active: false,
        age: 0,
        maxAge: 0.7,
        pos: new THREE.Vector3(0, -1000, 0),
        vel: new THREE.Vector3(),
        scale0: 0.3,
        scale1: 1.8,
        alpha: 0,
        spin: 0,
        spinRate: 0,
        color: new THREE.Color(0xe2e8f0),
      });
      this.dummy.position.set(0, -1000, 0);
      this.dummy.scale.setScalar(0.001);
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, this.dummy.matrix);
      this.particleMesh.setColorAt(i, new THREE.Color(0xe2e8f0));
    }
    this.group.add(this.particleMesh);
  }

  /** Daylight on the puffs (0..1, the sky brightness): smoke and spray do not glow at dusk or under rain clouds */
  public setLightLevel(level: number): void {
    this.particleMat.uniforms.uLight.value = THREE.MathUtils.clamp(0.3 + 0.7 * level, 0.25, 1);
  }

  /** Wetness of the road under the player's car (weather.ts): spray behind the rear wheels, no smoke */
  public setWetness(wetness: number): void {
    this.wetness = THREE.MathUtils.clamp(wetness, 0, 1);
  }

  /**
   * Updates tire skidmarks, smoke/gravel particles, and opponent 3D cars each frame.
   * `emit` is false while the player's car is not being simulated (paused, menus, replay): its wheel state is then
   * frozen, so nothing new is laid down or spawned, but particles in flight and the opponents keep updating.
   */
  public update(
    dt: number,
    carWorldQuat: THREE.Quaternion,
    carSpeedMs: number,
    wheels: readonly [SimWheelState, SimWheelState, SimWheelState, SimWheelState],
    peers: InterpolatedPeerState[],
    emit = true
  ): void {
    if (emit) this.emitFromCar(dt, carWorldQuat, carSpeedMs, wheels);
    else {
      this.emitTimer = 0;
      this.lastWheelSkidPos.fill(null);
      this.smokeLevel.fill(0);
      this.markLevel.fill(0);
      this.smokeOwed.fill(0);
      this.wheelVelValid = false;
    }
    this.stepParticles(dt);
    this.playerPosValid = emit;
    if (emit) {
      this.playerPos.set(0, 0, 0);
      for (const w of wheels) this.playerPos.add(w.worldPos);
      this.playerPos.multiplyScalar(0.25);
    }
    this.updateOpponentCars(dt, peers);
  }

  private readonly carRight = new THREE.Vector3();
  private readonly carUp = new THREE.Vector3();
  private readonly carForward = new THREE.Vector3();

  /** Skidmarks and smoke / gravel / spray from the player's four wheels */
  private emitFromCar(
    dt: number,
    carWorldQuat: THREE.Quaternion,
    carSpeedMs: number,
    wheels: readonly [SimWheelState, SimWheelState, SimWheelState, SimWheelState]
  ): void {
    const carRight = this.carRight.set(1, 0, 0).applyQuaternion(carWorldQuat);
    const carUp = this.carUp.set(0, 1, 0).applyQuaternion(carWorldQuat);
    const carForward = this.carForward.set(0, 0, 1).applyQuaternion(carWorldQuat);

    // 1. Skid marks: rubber laid by a tyre sliding past its grip on a paved surface, darkest from a locked wheel
    //    (`tyre-slide-fx.ts`), and the furrow any loaded tyre leaves in grass. The rubber's darkness follows the tyre
    //    with a short rise and fall, so a mark does not break into dashes as the slide wavers
    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const w = wheels[wIdx];
      const isGrass = w.surfaceType === 'grass';
      const target = isGrass ? 0 : tyreMarkLevel(w.fzN, w.combinedSlipNorm, w.slideSpeedMs, w.lockShare);
      const prevLevel = this.markLevel[wIdx];
      const markLevel = prevLevel + (target - prevLevel) * (1 - Math.exp(-dt / (target > prevLevel ? MARK_RISE_S : MARK_FALL_S)));
      this.markLevel[wIdx] = markLevel;
      const isSkidding = carSpeedMs > 2.5 && w.fzN > 250 && (isGrass || markLevel > 0.04);

      if (isSkidding) {
        const contactPt = new THREE.Vector3(
          w.worldPos.x,
          w.zRoad + 0.035,
          w.worldPos.z
        );
        const prevPt = this.lastWheelSkidPos[wIdx];

        if (prevPt && prevPt.distanceToSquared(contactPt) > 0.12 && prevPt.distanceToSquared(contactPt) < 16.0) {
          this.appendSkidQuad(
            prevPt,
            contactPt,
            carRight,
            wIdx < 2 ? 0.14 : 0.18,
            isGrass ? Math.min(0.85, (w.combinedSlipNorm - 0.62) * 1.1) : 0.12 + 0.73 * markLevel,
            isGrass
          );
          this.lastWheelSkidPos[wIdx] = contactPt;
        } else if (!prevPt || prevPt.distanceToSquared(contactPt) >= 16.0) {
          this.lastWheelSkidPos[wIdx] = contactPt;
        }
      } else {
        this.lastWheelSkidPos[wIdx] = null;
      }
    }

    // 2. Tyre smoke, from how hard each tyre slides (`tyre-slide-fx.ts`), at a rate set by its level
    this.emitTyreSmoke(dt, carForward, carSpeedMs, wheels);

    // 3. Spray and off-track dust
    this.emitTimer += dt;
    if (this.emitTimer >= 0.018 && carSpeedMs > 3.5) {
      this.emitTimer = 0;
      for (let wIdx = 0; wIdx < 4; wIdx++) {
        const w = wheels[wIdx];
        if (w.fzN <= 100) continue;

        // Spray: a fine mist off the tyres, most of it from the rears and the diffuser, rising behind the car. The
        // fronts' is kept low and short-lived so it does not wash across the driver's view from beside the cockpit
        if (this.wetness > 0.14 && carSpeedMs > 12 && w.surfaceType !== 'grass') {
          const isRear = wIdx >= 2;
          const prob = this.wetness * Math.min(1, carSpeedMs / 42) * (isRear ? 1 : 0.35);
          if (Math.random() < prob) {
            this.spawnParticle(
              w.worldPos.x - carForward.x * (isRear ? 0.5 : 0.35),
              w.zRoad + (isRear ? 0.25 : 0.1),
              w.worldPos.z - carForward.z * (isRear ? 0.5 : 0.35),
              carForward,
              carUp,
              carSpeedMs * (isRear ? 1.65 : 1.15),
              isRear ? 0.6 : 0.35,
              isRear ? 3.2 : 1.1,
              isRear ? 0.75 : 0.32,
              0xc9d1d8,
              (isRear ? 0.16 : 0.08) * (0.6 + 0.4 * this.wetness),
              isRear ? 1 : 0.35
            );
          }
          continue;
        }
        if (w.surfaceType === 'grass' || w.surfaceType === 'runoff') {
          this.spawnParticle(
            w.worldPos.x,
            w.zRoad + 0.14,
            w.worldPos.z,
            carForward,
            carUp,
            carSpeedMs,
            0.3,
            1.6,
            0.6,
            w.surfaceType === 'grass' ? 0x8a6a48 : 0xb9b2a6,
            0.3
          );
        }
      }
    }
  }

  private readonly puffVel = new THREE.Vector3();

  /**
   * Smoke from tyres sliding past their grip, thickest from a locked wheel. Each wheel's level follows the tyre with a
   * short rise and fall (a single physics step past the peak gives at most one faint wisp), and puffs come at a rate
   * in proportion to it. A puff starts at the contact patch, carried a little way along by the air the wheel drags with it (the wheel's
   * own direction of travel, so a car sliding sideways leaves its smoke behind it, not ahead of its nose), and rises
   * slowly as it spreads.
   */
  private emitTyreSmoke(
    dt: number,
    carForward: THREE.Vector3,
    carSpeedMs: number,
    wheels: readonly [SimWheelState, SimWheelState, SimWheelState, SimWheelState]
  ): void {
    if (!(dt > 0)) return;
    // Water cools the tread and carries the rubber away: spray, not smoke, on a wet road
    const dry = 1 - THREE.MathUtils.smoothstep(this.wetness, 0.05, 0.2);
    const velBlend = 1 - Math.exp(-dt / 0.1);
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const prev = this.wheelPrevPos[i];
      const vel = this.wheelVel[i];
      const tx = (w.worldPos.x - prev.x) / dt;
      const ty = (w.worldPos.y - prev.y) / dt;
      const tz = (w.worldPos.z - prev.z) / dt;
      // A first frame or a jump (reset, flashback, teleport): the car's own speed and heading until it settles again
      if (!this.wheelVelValid || tx * tx + ty * ty + tz * tz > 150 * 150) vel.copy(carForward).multiplyScalar(carSpeedMs);
      else vel.set(vel.x + (tx - vel.x) * velBlend, vel.y + (ty - vel.y) * velBlend, vel.z + (tz - vel.z) * velBlend);
      prev.set(w.worldPos.x, w.worldPos.y, w.worldPos.z);

      const onRoad = w.surfaceType === 'asphalt' || w.surfaceType === 'kerb';
      const target = onRoad ? dry * tyreSmokeLevel(w.fzN, w.combinedSlipNorm, w.slideSpeedMs, w.lockShare) : 0;
      const level = this.smokeLevel[i];
      this.smokeLevel[i] = level + (target - level) * (1 - Math.exp(-dt / (target > level ? SMOKE_RISE_S : SMOKE_FALL_S)));
      const L = this.smokeLevel[i];
      if (L < 0.02) {
        this.smokeOwed[i] = 0;
        continue;
      }
      this.smokeOwed[i] = Math.min(3, this.smokeOwed[i] + dt * SMOKE_PUFFS_PER_S * L);
      while (this.smokeOwed[i] >= 1) {
        this.smokeOwed[i] -= 1;
        const pv = this.puffVel.copy(vel).multiplyScalar(0.25);
        pv.x += (Math.random() - 0.5) * 1.2;
        pv.y += 0.5 + Math.random() * 0.9;
        pv.z += (Math.random() - 0.5) * 1.2;
        this.spawnPuff(
          w.worldPos.x,
          w.zRoad + 0.15,
          w.worldPos.z,
          pv,
          0.35 + 0.25 * L,
          1.8 + 2.2 * L,
          0.8 + 1.2 * L,
          0xdfe2e5,
          0.1 + 0.3 * L
        );
      }
    }
    this.wheelVelValid = true;
  }

  private appendSkidQuad(
    p0: THREE.Vector3,
    p1: THREE.Vector3,
    rightVec: THREE.Vector3,
    halfWidth: number,
    intensity: number,
    isDirt: boolean
  ): void {
    const seg = this.skidHead % MAX_SKID_SEGMENTS;
    this.skidHead++;

    const vBase = seg * 4 * 3;
    const cBase = seg * 4 * 4;

    const l0x = p0.x - rightVec.x * halfWidth;
    const l0y = p0.y - rightVec.y * halfWidth;
    const l0z = p0.z - rightVec.z * halfWidth;
    const r0x = p0.x + rightVec.x * halfWidth;
    const r0y = p0.y + rightVec.y * halfWidth;
    const r0z = p0.z + rightVec.z * halfWidth;

    const l1x = p1.x - rightVec.x * halfWidth;
    const l1y = p1.y - rightVec.y * halfWidth;
    const l1z = p1.z - rightVec.z * halfWidth;
    const r1x = p1.x + rightVec.x * halfWidth;
    const r1y = p1.y + rightVec.y * halfWidth;
    const r1z = p1.z + rightVec.z * halfWidth;

    const pos = this.skidPositions;
    pos[vBase] = l0x;
    pos[vBase + 1] = l0y;
    pos[vBase + 2] = l0z;
    pos[vBase + 3] = r0x;
    pos[vBase + 4] = r0y;
    pos[vBase + 5] = r0z;
    pos[vBase + 6] = l1x;
    pos[vBase + 7] = l1y;
    pos[vBase + 8] = l1z;
    pos[vBase + 9] = r1x;
    pos[vBase + 10] = r1y;
    pos[vBase + 11] = r1z;

    const r = isDirt ? 0.28 : 0.06;
    const g = isDirt ? 0.20 : 0.06;
    const b = isDirt ? 0.12 : 0.07;
    const a = THREE.MathUtils.clamp(intensity, 0.12, 0.85);

    const col = this.skidColors;
    for (let k = 0; k < 4; k++) {
      const idx = cBase + k * 4;
      col[idx] = r;
      col[idx + 1] = g;
      col[idx + 2] = b;
      col[idx + 3] = a;
    }

    (this.skidGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.skidGeom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private spawnParticle(
    wx: number,
    wy: number,
    wz: number,
    carForward: THREE.Vector3,
    carUp: THREE.Vector3,
    carSpeedMs: number,
    scale0: number,
    scale1: number,
    maxAge: number,
    colorHex: number,
    alpha: number,
    lift = 1
  ): void {
    const vel = this.puffVel
      .copy(carForward)
      .multiplyScalar(carSpeedMs * 0.22)
      .addScaledVector(carUp, (1.4 + Math.random() * 1.6) * lift);
    vel.x += (Math.random() - 0.5) * 1.8;
    vel.z += (Math.random() - 0.5) * 1.8;
    this.spawnPuff(wx, wy, wz, vel, scale0, scale1, maxAge, colorHex, alpha);
  }

  /** One soft puff at (wx, wy, wz) moving at `vel` (m/s, copied) */
  private spawnPuff(
    wx: number,
    wy: number,
    wz: number,
    vel: THREE.Vector3,
    scale0: number,
    scale1: number,
    maxAge: number,
    colorHex: number,
    alpha: number
  ): void {
    const p = this.particles[this.particleCursor % MAX_PARTICLES];
    this.particleCursor++;

    p.active = true;
    p.age = 0;
    p.maxAge = maxAge;
    p.pos.set(
      wx + (Math.random() - 0.5) * 0.22,
      wy,
      wz + (Math.random() - 0.5) * 0.22
    );
    p.vel.copy(vel);
    p.scale0 = scale0 * (0.8 + 0.4 * Math.random());
    p.scale1 = scale1 * (0.8 + 0.4 * Math.random());
    p.alpha = alpha;
    p.spin = Math.random() * Math.PI * 2;
    p.spinRate = (Math.random() - 0.5) * 1.2;
    p.color.setHex(colorHex);
  }

  private stepParticles(dt: number): void {
    let anyUpdated = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      anyUpdated = true;

      p.age += dt;
      if (p.age >= p.maxAge) {
        p.active = false;
        this.dummy.position.set(0, -1000, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.particleMesh.setMatrixAt(i, this.dummy.matrix);
        this.puffAttr.setX(i, 0);
        continue;
      }

      const lifeT = p.age / p.maxAge;
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1.0 - 2.2 * dt));

      // Grows fast and then drifts out; fades in over the first 12 % of its life and thins out to nothing
      const grow = 1 - (1 - lifeT) * (1 - lifeT);
      const s = THREE.MathUtils.lerp(p.scale0, p.scale1, grow);
      this.dummy.position.copy(p.pos);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.setScalar(Math.max(0.01, s));
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, this.dummy.matrix);
      this.particleMesh.setColorAt(i, p.color);
      p.spin += p.spinRate * dt;
      this.puffAttr.setXY(i, p.alpha * THREE.MathUtils.smoothstep(lifeT, 0, 0.12) * Math.pow(1 - lifeT, 1.5), p.spin);
    }

    if (anyUpdated) {
      this.particleMesh.instanceMatrix.needsUpdate = true;
      this.puffAttr.needsUpdate = true;
      if (this.particleMesh.instanceColor) {
        this.particleMesh.instanceColor.needsUpdate = true;
      }
    }
  }

  private mapDriverToLivery(code: string): LiveryConfig {
    if (code === 'KIG') return LIVERIES[2] ?? LIVERIES[0];
    if (code === 'MUS') return LIVERIES[1] ?? LIVERIES[0];
    if (code === 'NYA') return LIVERIES[3] ?? LIVERIES[0];
    if (code === 'RUB') return LIVERIES[4] ?? LIVERIES[0];
    if (code === 'HUY') return LIVERIES[1] ?? LIVERIES[0];
    return LIVERIES[0];
  }

  /** The car the peer reports (AI and older clients: the AMR, which is what F1Physics2026 models) */
  private createOpponentRig(peer: InterpolatedPeerState): SimCarRig {
    const livery = this.mapDriverToLivery(peer.driverCode);
    const ghost = Boolean(peer.ghost || peer.passThrough);
    const pooled = this.pool.get(poolKey(peer.vehicle, ghost))?.pop();
    if (pooled) {
      pooled.root.visible = true;
      if (!ghost) pooled.setLivery(livery);
      return pooled;
    }
    return buildOpponentRig(peer.vehicle, livery);
  }

  /**
   * During loading: fetch the opponents' model and build one racing and one ghost rig of it, parked out of sight but
   * visible so the loading screen's shader warm-up compiles them (and the ghost's translucent variants). Reports to the
   * loading screen's "opponents" task. Call `hidePrewarmed()` once the warm-up has drawn them.
   */
  public prewarm(vehicle: VehicleModelId | undefined): Promise<void> {
    const kind = rigKind(vehicle);
    let job = this.prewarms.get(kind);
    if (!job) {
      job = this.buildPrewarm(vehicle, kind);
      this.prewarms.set(kind, job);
    }
    // Each call reports to the loading screen once the rigs are there, not before
    return job.then((built) => {
      if (built) assetProgress.done('opponents');
      else assetProgress.fail('opponents');
    });
  }

  private buildPrewarm(vehicle: VehicleModelId | undefined, kind: string): Promise<boolean> {
    const template: Promise<unknown> =
      kind === 'gt3' || kind === 'road' || kind === 'proto'
        ? loadPortedTemplate(PORTED_ONLY[kind].url)
        : loadVf26Template(AMR26_MODEL_URL, 'opponents');
    return template
      .then(() => {
        // The rigs attach the cached template in their own `then`, registered before this one returns. One racing
        // rig per AI driver, in its livery, and one ghost
        const builds: { ghost: boolean; livery: LiveryConfig }[] = [
          ...PREWARM_DRIVERS.map((code) => ({ ghost: false, livery: this.mapDriverToLivery(code) })),
          { ghost: true, livery: LIVERIES[0] },
        ];
        for (const { ghost, livery } of builds) {
          const rig = buildOpponentRig(vehicle, livery);
          rig.root.position.set(0, -500, 0);
          this.group.add(rig.root);
          const key = poolKey(vehicle, ghost);
          this.pool.set(key, [...(this.pool.get(key) ?? []), rig]);
        }
        // A task later the rigs have attached the cached models (each in its own promise callback)
        return new Promise<void>((resolve) => setTimeout(resolve, 0));
      })
      .then(() => {
        for (const rig of this.pool.get(poolKey(vehicle, true)) ?? []) ghostify(rig.root);
        return true;
      })
      .catch((err) => {
        console.warn('Opponent cars not pre-warmed', err);
        // Not built: the next prewarm() of this kind tries again
        this.prewarms.delete(kind);
        return false;
      });
  }

  /** Parks the pooled rigs out of the render once the warm-up has compiled them */
  public hidePrewarmed(): void {
    for (const rigs of this.pool.values()) for (const rig of rigs) rig.root.visible = false;
  }

  private updateOpponentCars(dt: number, peers: InterpolatedPeerState[]): void {
    const activeIds = new Set<string>();

    for (const peer of peers) {
      activeIds.add(peer.peerId);
      let entry = this.opponentCars.get(peer.peerId);
      // A car passing through the player's (an open race's fair-play rule) is drawn as the lap ghost is
      const ghost = Boolean(peer.ghost || peer.passThrough);
      if (entry && entry.vehicle !== peer.vehicle) {
        // The peer switched car: rebuild its rig with that car's materials
        this.dropOpponentRigs(entry);
        entry = undefined;
      } else if (entry && entry.ghost !== ghost) {
        // Became (or stopped being) a ghost: swap to the rig of the other look and keep this one for the way back.
        // In an open race a car changes look whenever it runs wide, so each car builds its second rig once at most
        const other = entry.spare ?? this.createOpponentRig(peer);
        if (!entry.spare) this.group.add(other.root);
        entry.rig.root.visible = false;
        entry.spare = entry.rig;
        entry.rig = other;
        other.root.visible = true;
        entry.ghost = ghost;
        entry.ghostMats = undefined;
        entry.ghostCheckS = 0;
      }
      if (!entry) {
        entry = { rig: this.createOpponentRig(peer), vehicle: peer.vehicle, ghost, wheelRot: 0 };
        this.opponentCars.set(peer.peerId, entry);
        this.group.add(entry.rig.root);
      }
      const carRig = entry.rig;
      // A late model load adds meshes to a ghost: look for them twice a second, not by walking the rig every frame
      if (ghost && (entry.ghostCheckS = (entry.ghostCheckS ?? 0) - dt) <= 0) {
        ghostify(carRig.root);
        entry.ghostMats = ghostMaterials(carRig.root);
        entry.ghostCheckS = 0.5;
      }
      if (ghost && entry.ghostMats) {
        // Fades out as it nears the player's car and is gone on top of it, so it never fills the cockpit
        const fade = this.playerPosValid ? ghostFade(peer.position.distanceTo(this.playerPos)) : 1;
        carRig.root.visible = fade > 0.004;
        for (const m of entry.ghostMats) m.opacity = GHOST_OPACITY * fade;
      }

      carRig.root.position.copy(peer.position);
      carRig.root.quaternion.copy(peer.quaternion);

      // Integrated, so the spokes turn smoothly with frame-time jitter and stop when the car does (paused, replay)
      const rpm = peer.wheelRPMs[0];
      const spinRadS = Number.isFinite(rpm) && rpm !== 0 ? (rpm * 2 * Math.PI) / 60 : peer.speedKmh / 3.6 / 0.348;
      entry.wheelRot = (entry.wheelRot + spinRadS * dt) % (2 * Math.PI);
      const wheelRot = entry.wheelRot;
      const pitchRad = peer.brake > 0.2 ? 0.012 : -peer.throttle * 0.008;
      const rollRad = peer.steerAngle * 0.04;

      // One telemetry object per opponent, refreshed in place (it was a ~70-field literal per car per frame)
      const syntheticTelemetry = (entry.telemetry ??= createPeerTelemetry());
      const speedMs = peer.speedKmh / 3.6;
      syntheticTelemetry.speedKmh = peer.speedKmh;
      syntheticTelemetry.speedMs = speedMs;
      // The car's own rpm and gear when it reports them (the AI field), else an estimate from its speed
      syntheticTelemetry.gear = peer.gear ?? Math.max(1, Math.min(8, Math.ceil(peer.speedKmh / 42)));
      syntheticTelemetry.rpm = peer.rpm ?? 8500 + (peer.speedKmh % 45) * 95;
      syntheticTelemetry.throttle = peer.throttle;
      syntheticTelemetry.brake = peer.brake;
      syntheticTelemetry.steering = THREE.MathUtils.clamp(steerNormOf(peer.steerAngle), -1, 1);
      syntheticTelemetry.activeAeroMode = peer.speedKmh > 250 && Math.abs(peer.steerAngle) < 0.05 ? 'X_MODE' : 'Z_MODE';
      syntheticTelemetry.icePowerKw = 400 * peer.throttle;
      syntheticTelemetry.mgukPowerKw = peer.throttle > 0.5 ? 250 : -80;
      syntheticTelemetry.totalPowerKw = 650 * peer.throttle;
      const braking = peer.brake > 0.2;
      const bt = syntheticTelemetry.brakeTempsC;
      bt[0] = bt[1] = braking ? 780 : 340;
      bt[2] = bt[3] = braking ? 720 : 320;
      syntheticTelemetry.trackDistanceM = peer.trackS;

      let wheels: WheelSeating | undefined;
      if (peer.wheels) {
        wheels = entry.wheels ??= { ground: null, position: peer.position, quaternion: peer.quaternion };
        wheels.tyres = peer.wheels.tyres;
        wheels.ground = peer.wheels.ground;
        wheels.position = peer.position;
        wheels.quaternion = peer.quaternion;
        // Road samples under the treads and tyre shadows for the cars near the player's (in a replay: samples across)
        wheels.detail = this.playerPosValid ? tyreDetailAt(peer.position.distanceTo(this.playerPos)) : 1;
      }
      carRig.updateFromTelemetry(syntheticTelemetry, pitchRad, rollRad, wheelRot, dt, wheels);
      seatContactShadow(carRig.root, wheels);

      // Opponent car rooster-tail water spray plume in wet conditions
      if (this.wetness > 0.16 && !peer.ghost && peer.speedKmh > 55) {
        const peerSpeedMs = peer.speedKmh / 3.6;
        if (Math.random() < this.wetness * Math.min(1, peerSpeedMs / 48) * 0.65) {
          const peerFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(peer.quaternion);
          const peerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(peer.quaternion);
          const sideJitter = (Math.random() - 0.5) * 1.3;
          this.spawnParticle(
            peer.position.x - peerFwd.x * 2.1 + peerFwd.z * sideJitter,
            peer.position.y + 0.32,
            peer.position.z - peerFwd.z * 2.1 - peerFwd.x * sideJitter,
            peerFwd,
            peerUp,
            peerSpeedMs * 1.55,
            0.6,
            3.6,
            0.85,
            0xc9d1d8,
            // A mist that greys out what is behind it, not a wall: following closely still costs visibility
            0.14 * (0.6 + 0.4 * this.wetness)
          );
        }
      }
    }

    for (const [peerId, entry] of this.opponentCars.entries()) {
      if (!activeIds.has(peerId)) {
        this.dropOpponentRigs(entry);
        this.opponentCars.delete(peerId);
      }
    }
  }

  /** Takes a car's rigs (the one drawn and the spare of its other look) out of the scene and off the GPU */
  private dropOpponentRigs(entry: { rig: SimCarRig; spare?: SimCarRig }): void {
    for (const rig of [entry.rig, entry.spare]) {
      if (!rig) continue;
      this.group.remove(rig.root);
      // The rig's own dispose() only stops its updates: its canvases, geometry and materials (and the contact
      // shadow) would otherwise stay on the GPU for every car that ever left
      rig.dispose();
      disposeTree(rig.root);
    }
    entry.spare = undefined;
  }
}

/**
 * How closely an opponent's tyres follow the road (`WheelSeating.detail`) at a distance (m) from the player's car:
 * the kerb profile across and along each tread and the tyre shadows (four draw calls a car) close up, the profile
 * across only in the middle distance, the plane under each hub beyond, where a tread is a few pixels wide. The road
 * samples cost ~25 µs a car per frame at full detail, so the radii are generous (chase and TV shots frame cars well
 * away from the player's)
 */
function tyreDetailAt(distanceM: number): 0 | 1 | 2 {
  return distanceM < 60 ? 2 : distanceM < 150 ? 1 : 0;
}

/** Telemetry stand-in for an opponent's rig; the per-frame fields are refreshed in updateOpponentCars */
function createPeerTelemetry(): CarTelemetry {
  return {
    speedKmh: 0,
    speedMs: 0,
    rpm: 8500,
    gear: 1,
    throttle: 0,
    brake: 0,
    clutch: 1,
    steering: 0,
    longitudinalG: 0,
    lateralG: 0,
    verticalG: 1,
    altitudeM: 1400,
    trackElevationM: 15,
    airDensityKgM3: 1.045,
    activeAeroMode: 'Z_MODE',
    autoXMode: true,
    downforceN: 10800,
    downforceKgf: 1100,
    frontDownforceN: 4500,
    rearDownforceN: 6300,
    groundEffectFactor: 1.3,
    dragN: 1800,
    icePowerKw: 0,
    mgukPowerKw: -80,
    totalPowerKw: 0,
    ersBatteryPercent: 75,
    manualOverrideActive: false,
    boostRemainingS: 0,
    turboBoostBar: 2.2,
    fuelKg: 35,
    tireSlipRatio: [0, 0, 0, 0],
    wheelSlipRatios: [0, 0, 0, 0],
    wheelSlipAnglesDeg: [0, 0, 0, 0],
    wheelLoadsN: [3500, 3500, 4200, 4200],
    wheelRideHeightsMm: [28, 28, 38, 38],
    suspensionTravelMm: [14, 14, 18, 18],
    suspensionVelocityMs: [0, 0, 0, 0],
    tireTempsC: [94, 94, 96, 96],
    tireWearPct: [2, 2, 3, 3],
    tireGripFactor: [1, 1, 1, 1],
    brakeTempsC: [340, 340, 320, 320],
    wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
    onKerbLeft: false,
    onKerbRight: false,
    offTrack: false,
    surface: 'asphalt',
    trackDistanceM: 0,
    trackProgress: 0,
    lateralOffsetM: 0,
    gapToRacingLineM: 0,
    headingErrorRad: 0,
    targetCornerSpeedKmh: 260,
    brakingUrgency: 0,
    currentSector: 1,
    currentTurnNumber: 0,
    currentTurnName: 'Main Straight',
    bankingDeg: 0,
    slopePercent: 0,
    lapCount: 1,
    currentLapTimeMs: 42500,
    lastLapTimeMs: null,
    bestLapTimeMs: null,
    sectorTimesMs: [0, 0, 0],
    bestSectorTimesMs: [null, null, null],
    topSpeedThisLapKmh: 310,
    allTimeTopSpeedKmh: 330,
    aiAutopilot: true,
    peers: [],
  };
}

/** The AI field's drivers (ai-opponents.ts AI_DRIVERS), whose liveries the pool is built in */
const PREWARM_DRIVERS = ['KIG', 'MUS', 'NYA', 'RUB', 'HUY'] as const;
const rigKind = (vehicle: VehicleModelId | undefined) =>
  vehicle === 'amg-gt3' ? 'gt3' : vehicle === 'liana' ? 'road' : vehicle === 'mtr-496r' ? 'proto' : 'f1';
/**
 * The models with no body of their own: their opponents wear the car's ported GLB (car-registry's `modelUrl`), on the
 * model's chassis and wheel lock. The GT3s race as the Mercedes-AMG GT3 Evo, the model's own car.
 */
const PORTED_ONLY = {
  gt3: { url: '/cars/amg-gt3-evo/model/amg-gt3-evo.glb', config: AMG_GT3_CONFIG, lockDeg: CAR_WHEEL_LOCKS_DEG['amg-gt3'] },
  road: { url: '/cars/liana/model/liana.glb', config: SUZUKI_LIANA_CONFIG, lockDeg: CAR_WHEEL_LOCKS_DEG.liana },
  proto: { url: '/cars/mtr-496r/model/mtr-496r.glb', config: MTR_496R_CONFIG, lockDeg: CAR_WHEEL_LOCKS_DEG['mtr-496r'] },
} as const;
const poolKey = (vehicle: VehicleModelId | undefined, ghost: boolean) => `${rigKind(vehicle)}${ghost ? ':ghost' : ''}`;

function buildOpponentRig(vehicle: VehicleModelId | undefined, livery: LiveryConfig): SimCarRig {
  let rig: SimCarRig;
  if (vehicle === 'amg-gt3' || vehicle === 'liana' || vehicle === 'mtr-496r') {
    const own = PORTED_ONLY[rigKind(vehicle) as 'gt3' | 'road' | 'proto'];
    rig = createPortedCarRig({
      url: own.url,
      chassis: own.config.chassis,
      steerLockDeg: own.lockDeg / 2,
      floor: staticFloorOf(own.config),
    });
  } else {
    rig = createF1Car2026(livery, 'medium');
  }
  addContactShadow(rig.root, vehicle);
  return rig;
}

/** The translucent materials `ghostify` gave a car */
function ghostMaterials(root: THREE.Object3D): THREE.Material[] {
  const out: THREE.Material[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m.userData.ghost) out.push(m);
  });
  return out;
}

/** Makes a car translucent (the best-lap ghost); new meshes from a late model load are caught on later calls */
function ghostify(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.every((m) => m.userData.ghost)) return;
    const next = mats.map((m) => {
      if (m.userData.ghost) return m;
      const g = m.clone();
      g.transparent = true;
      g.opacity = GHOST_OPACITY;
      g.depthWrite = false;
      g.userData.ghost = true;
      return g;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
}
