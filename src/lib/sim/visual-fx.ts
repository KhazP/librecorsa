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
import { createGt3CarRig } from '@/lib/gt3-car-model';
import { LIVERIES } from '@/lib/track-data';
import { CarTelemetry, LiveryConfig, type VehicleModelId } from '@/types/f1';
import type { SimulatorWheel as SimWheelState } from './simulator-car';
import { InterpolatedPeerState } from './multiplayer-sync';

const MAX_SKID_SEGMENTS = 900; // Ring buffer of 4-vertex quad segments across all 4 wheels
const MAX_PARTICLES = 180;

interface ParticleInstance {
  active: boolean;
  age: number;
  maxAge: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  scale0: number;
  scale1: number;
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
  private particles: ParticleInstance[] = [];
  private particleCursor = 0;
  private emitTimer = 0;
  private dummy = new THREE.Object3D();
  /** Road wetness under the player's car (0..1): rear-wheel spray at speed */
  private wetness = 0;

  // Multiplayer / AI Opponent 3D cars
  private opponentCars = new Map<string, { rig: SimCarRig; vehicle: VehicleModelId | undefined }>();

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

    // 2. Initialize Instanced Tire Smoke & Gravel Particles
    const puffGeom = new THREE.IcosahedronGeometry(0.32, 1);
    const puffMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    this.particleMesh = new THREE.InstancedMesh(
      puffGeom,
      puffMat,
      MAX_PARTICLES
    );
    this.particleMesh.frustumCulled = false;
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

  /** Wetness of the road under the player's car (weather.ts): spray behind the rear wheels, no smoke */
  public setWetness(wetness: number): void {
    this.wetness = THREE.MathUtils.clamp(wetness, 0, 1);
  }

  /**
   * Updates tire skidmarks, smoke/gravel particles, and opponent 3D cars each frame.
   */
  public update(
    dt: number,
    carWorldQuat: THREE.Quaternion,
    carSpeedMs: number,
    wheels: readonly [SimWheelState, SimWheelState, SimWheelState, SimWheelState],
    peers: InterpolatedPeerState[]
  ): void {
    const carRight = new THREE.Vector3(1, 0, 0).applyQuaternion(carWorldQuat);
    const carUp = new THREE.Vector3(0, 1, 0).applyQuaternion(carWorldQuat);
    const carForward = new THREE.Vector3(0, 0, 1).applyQuaternion(carWorldQuat);

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

        // Spray: front and rear tyres + central diffuser throw a rooster-tail plume of water up behind the car
        if (this.wetness > 0.14 && carSpeedMs > 12 && w.surfaceType !== 'grass') {
          const isRear = wIdx >= 2;
          const prob = this.wetness * Math.min(1, carSpeedMs / 42) * (isRear ? 1 : 0.45);
          if (Math.random() < prob) {
            this.spawnParticle(
              w.worldPos.x - carForward.x * (isRear ? 0.45 : 0.25),
              w.zRoad + (isRear ? 0.28 : 0.16),
              w.worldPos.z - carForward.z * (isRear ? 0.45 : 0.25),
              carForward,
              carUp,
              carSpeedMs * (isRear ? 1.65 : 1.15),
              isRear ? 0.55 : 0.35,
              isRear ? 3.8 : 2.1,
              isRear ? 0.82 : 0.52,
              0xd4dbe1
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
            0.35,
            2.2,
            0.58,
            0xe2e8f0
          );
        } else if (w.surfaceType === 'grass' || w.surfaceType === 'runoff') {
          this.spawnParticle(
            w.worldPos.x,
            w.zRoad + 0.14,
            w.worldPos.z,
            carForward,
            carUp,
            carSpeedMs,
            0.28,
            1.45,
            0.48,
            w.surfaceType === 'grass' ? 0x7c5836 : 0xcbd5e1
          );
        }
      }
    }

    this.stepParticles(dt);
    this.updateOpponentCars(dt, peers);
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
    colorHex: number
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
      .addScaledVector(carUp, 1.4 + Math.random() * 1.6);
    p.vel.x += (Math.random() - 0.5) * 1.8;
    p.vel.z += (Math.random() - 0.5) * 1.8;
    p.scale0 = scale0;
    p.scale1 = scale1;
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
        continue;
      }

      const lifeT = p.age / p.maxAge;
      p.pos.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1.0 - 2.2 * dt));

      const s = THREE.MathUtils.lerp(p.scale0, p.scale1, lifeT) * (1.0 - lifeT * 0.35);
      this.dummy.position.copy(p.pos);
      this.dummy.scale.setScalar(Math.max(0.01, s));
      this.dummy.rotation.set(lifeT * 2.1, lifeT * 1.7, 0);
      this.dummy.updateMatrix();
      this.particleMesh.setMatrixAt(i, this.dummy.matrix);
      this.particleMesh.setColorAt(i, p.color);
    }

    if (anyUpdated) {
      this.particleMesh.instanceMatrix.needsUpdate = true;
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
    if (peer.vehicle === 'amg-gt3') {
      const rig = createGt3CarRig();
      rig.setLivery(livery);
      return rig;
    }
    return createF1Car2026(livery, 'medium');
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
        entry = undefined;
      }
      if (!entry) {
        entry = { rig: this.createOpponentRig(peer), vehicle: peer.vehicle };
        this.opponentCars.set(peer.peerId, entry);
        this.group.add(entry.rig.root);
      }
      const carRig = entry.rig;
      if (peer.ghost) ghostify(carRig.root);

      carRig.root.position.copy(peer.position);
      carRig.root.quaternion.copy(peer.quaternion);

      const spinRad = ((peer.wheelRPMs[0] * 2 * Math.PI) / 60) * dt * 15;
      const wheelRot = (performance.now() * 0.001 * (peer.speedKmh / 3.6)) / 0.348 + spinRad;
      const pitchRad = peer.brake > 0.2 ? 0.012 : -peer.throttle * 0.008;
      const rollRad = peer.steerAngle * 0.04;

      const syntheticTelemetry: CarTelemetry = {
        speedKmh: peer.speedKmh,
        speedMs: peer.speedKmh / 3.6,
        rpm: 8500 + (peer.speedKmh % 45) * 95,
        gear: Math.max(1, Math.min(8, Math.ceil(peer.speedKmh / 42))),
        throttle: peer.throttle,
        brake: peer.brake,
        clutch: 1,
        steering: THREE.MathUtils.clamp(peer.steerAngle / 0.36, -1, 1),
        longitudinalG: 0,
        lateralG: 0,
        verticalG: 1,
        altitudeM: 1400,
        trackElevationM: 15,
        airDensityKgM3: 1.045,
        activeAeroMode: peer.speedKmh > 250 && Math.abs(peer.steerAngle) < 0.05 ? 'X_MODE' : 'Z_MODE',
        autoXMode: true,
        downforceN: 10800,
        downforceKgf: 1100,
        frontDownforceN: 4500,
        rearDownforceN: 6300,
        groundEffectFactor: 1.3,
        dragN: 1800,
        icePowerKw: 400 * peer.throttle,
        mgukPowerKw: peer.throttle > 0.5 ? 250 : -80,
        totalPowerKw: 650 * peer.throttle,
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
        tireTempsC: [94, 94, 96, 96],
        tireWearPct: [2, 2, 3, 3],
        tireGripFactor: [1, 1, 1, 1],
        brakeTempsC: [
          peer.brake > 0.2 ? 780 : 340,
          peer.brake > 0.2 ? 780 : 340,
          peer.brake > 0.2 ? 720 : 320,
          peer.brake > 0.2 ? 720 : 320,
        ],
        wheelSurfaces: ['asphalt', 'asphalt', 'asphalt', 'asphalt'],
        onKerbLeft: false,
        onKerbRight: false,
        offTrack: false,
        surface: 'asphalt',
        trackDistanceM: peer.trackS,
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

      carRig.updateFromTelemetry(syntheticTelemetry, pitchRad, rollRad, wheelRot);

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
            4.1,
            0.85,
            0xd4dbe1
          );
        }
      }
    }

    for (const [peerId, { rig }] of this.opponentCars.entries()) {
      if (!activeIds.has(peerId)) {
        this.group.remove(rig.root);
        rig.dispose();
        this.opponentCars.delete(peerId);
      }
    }
  }
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
      g.opacity = 0.3;
      g.depthWrite = false;
      g.userData.ghost = true;
      return g;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });
}
