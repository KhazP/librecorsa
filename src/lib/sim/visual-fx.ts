/**
 * Visual Simulation FX: Persistent Tire Skidmark Ribbons, Instanced Tire Smoke/Gravel
 * Particles & Multiplayer/AI Opponent Car 3D Renderer
 *
 * - Dynamic persistent quad-strip ribbon mesh for 4-wheel tire skidmarks on asphalt/kerbs,
 *   with vertex alpha scaled by per-wheel combined slip (`combinedSlipNorm`).
 * - `THREE.InstancedMesh` volumetric tire smoke and off-track gravel/grass debris particles
 *   emitted directly at each wheel's 3D contact patch.
 * - Opponent vehicle 3D rig manager driven by `MultiplayerSyncManager` Cubic Hermite + Slerp states.
 */

import * as THREE from 'three';
import { createF1Car2026, type SimCarRig } from '@/lib/car-builder-2026';
import type { WheelSeating } from '@/lib/render/corner-rig';
import { createGt3CarRig, loadGt3Cockpit, loadGt3Template } from '@/lib/gt3-car-model';
import { AMR26_MODEL_URL, loadVf26Template } from '@/lib/vf26-car-model';
import { assetProgress } from '@/lib/loading/asset-progress';
import { addContactShadow, seatContactShadow } from '@/lib/render/contact-shadow';
import { disposeTree } from '@/lib/render/dispose-tree';
import { LIVERIES } from '@/lib/track-data';
import { CarTelemetry, LiveryConfig, type VehicleModelId } from '@/types/f1';
import type { SimulatorWheel as SimWheelState } from './simulator-car';
import { GHOST_OPACITY, ghostFade } from './ghost-align';
import { InterpolatedPeerState } from './multiplayer-sync';

const MAX_SKID_SEGMENTS = 900; // Ring buffer of 4-vertex quad segments across all 4 wheels
const MAX_PARTICLES = 240;

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

  // Multiplayer / AI Opponent 3D cars
  /** wheelRot: the wheels' spin angle (rad), integrated from their speed each frame */
  private opponentCars = new Map<
    string,
    {
      rig: SimCarRig;
      vehicle: VehicleModelId | undefined;
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
  private prewarmedKinds = new Set<string>();

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

    // 1. Record tire skidmarks when combined slip exceeds threshold (`> 0.68`)
    for (let wIdx = 0; wIdx < 4; wIdx++) {
      const w = wheels[wIdx];
      const slipNorm = w.combinedSlipNorm;
      const isSkidding =
        carSpeedMs > 2.5 &&
        w.fzN > 250 &&
        (slipNorm > 0.68 || w.surfaceType === 'grass');

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
            Math.min(0.85, (slipNorm - 0.62) * 1.1),
            w.surfaceType === 'grass'
          );
          this.lastWheelSkidPos[wIdx] = contactPt;
        } else if (!prevPt || prevPt.distanceToSquared(contactPt) >= 16.0) {
          this.lastWheelSkidPos[wIdx] = contactPt;
        }
      } else {
        this.lastWheelSkidPos[wIdx] = null;
      }
    }

    // 2. Spawn & step tire smoke / gravel particles
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
        if (w.combinedSlipNorm > 0.88 && w.surfaceType === 'asphalt') {
          this.spawnParticle(
            w.worldPos.x,
            w.zRoad + 0.12,
            w.worldPos.z,
            carForward,
            carUp,
            carSpeedMs,
            0.4,
            2.4,
            0.9,
            0xd6d9dc,
            0.32
          );
        } else if (w.surfaceType === 'grass' || w.surfaceType === 'runoff') {
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
    p.vel
      .copy(carForward)
      .multiplyScalar(carSpeedMs * 0.22)
      .addScaledVector(carUp, (1.4 + Math.random() * 1.6) * lift);
    p.vel.x += (Math.random() - 0.5) * 1.8;
    p.vel.z += (Math.random() - 0.5) * 1.8;
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
    const pooled = this.pool.get(poolKey(peer.vehicle, Boolean(peer.ghost)))?.pop();
    if (pooled) {
      pooled.root.visible = true;
      if (!peer.ghost) pooled.setLivery(livery);
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
    if (this.prewarmedKinds.has(kind)) {
      assetProgress.done('opponents');
      return Promise.resolve();
    }
    this.prewarmedKinds.add(kind);
    const template: Promise<unknown> =
      kind === 'gt3'
        ? Promise.all([loadGt3Template('opponents'), loadGt3Cockpit()])
        : loadVf26Template(AMR26_MODEL_URL, 'opponents');
    return template
      .then(() => {
        // The rigs attach the cached template in their own `then`, registered before this one returns. One racing
        // rig per AI driver, in its livery (a GT3 livery is a repainted texture: done here, not on lap one's first
        // frame), and one ghost
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
        assetProgress.done('opponents');
      })
      .catch((err) => {
        console.warn('Opponent cars not pre-warmed', err);
        assetProgress.fail('opponents');
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
      if (entry && entry.vehicle !== peer.vehicle) {
        // The peer switched car: rebuild its rig
        this.group.remove(entry.rig.root);
        entry.rig.dispose();
        disposeTree(entry.rig.root);
        entry = undefined;
      }
      if (!entry) {
        entry = { rig: this.createOpponentRig(peer), vehicle: peer.vehicle, wheelRot: 0 };
        this.opponentCars.set(peer.peerId, entry);
        this.group.add(entry.rig.root);
      }
      const carRig = entry.rig;
      // A late model load adds meshes to a ghost: look for them twice a second, not by walking the rig every frame
      if (peer.ghost && (entry.ghostCheckS = (entry.ghostCheckS ?? 0) - dt) <= 0) {
        ghostify(carRig.root);
        entry.ghostMats = ghostMaterials(carRig.root);
        entry.ghostCheckS = 0.5;
      }
      if (peer.ghost && entry.ghostMats) {
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
      syntheticTelemetry.steering = THREE.MathUtils.clamp(peer.steerAngle / 0.36, -1, 1);
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

    for (const [peerId, { rig }] of this.opponentCars.entries()) {
      if (!activeIds.has(peerId)) {
        this.group.remove(rig.root);
        // The rig's own dispose() only stops its updates: its canvases, geometry and materials (and the contact
        // shadow) would otherwise stay on the GPU for every car that ever left
        rig.dispose();
        disposeTree(rig.root);
        this.opponentCars.delete(peerId);
      }
    }
  }
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
const rigKind = (vehicle: VehicleModelId | undefined) => (vehicle === 'amg-gt3' ? 'gt3' : 'f1');
const poolKey = (vehicle: VehicleModelId | undefined, ghost: boolean) => `${rigKind(vehicle)}${ghost ? ':ghost' : ''}`;

function buildOpponentRig(vehicle: VehicleModelId | undefined, livery: LiveryConfig): SimCarRig {
  let rig: SimCarRig;
  if (vehicle === 'amg-gt3') {
    rig = createGt3CarRig();
    rig.setLivery(livery);
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
