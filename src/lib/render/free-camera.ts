import * as THREE from "three";

const DEG2RAD = Math.PI / 180;
const PITCH_LIMIT_RAD = 85 * DEG2RAD;
const MIN_SPEED_MS = 2;
const MAX_SPEED_MS = 140;
const DEFAULT_SPEED_MS = 18;
const MIN_FOV_DEG = 18;
const MAX_FOV_DEG = 95;
const DEFAULT_FOV_DEG = 55;
/** Smooth damping time constant for fly velocity (s) */
const VEL_SMOOTH_TAU_S = 0.055;

export interface FreeCameraInput {
  /** +1 forward, -1 backward */
  forward: number;
  /** +1 right, -1 left */
  right: number;
  /** +1 up, -1 down */
  up: number;
  /** Fast modifier (e.g. Shift) */
  fast: boolean;
  /** Slow precision modifier (e.g. Alt) */
  slow: boolean;
  /** Continuous yaw rate (rad/s, + = turn left) from controller right stick */
  lookYawRate?: number;
  /** Continuous pitch rate (rad/s, + = look up) from controller right stick */
  lookPitchRate?: number;
}

export interface FreeCameraOutput {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fovDeg: number;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Fly-around free camera usable both on track and during race replays.
 * Spawns framing the focused car, supports mouse-drag look, WASD/Arrows/Q/E flight,
 * scroll-wheel speed scaling, FOV zoom, and controller stick flight.
 */
export class FreeCameraController {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  private readonly velocity = new THREE.Vector3();
  private readonly desiredVel = new THREE.Vector3();
  private readonly forwardVec = new THREE.Vector3();
  private readonly rightVec = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly lookDir = new THREE.Vector3();
  private readonly out: FreeCameraOutput = {
    position: this.position,
    quaternion: this.quaternion,
    fovDeg: DEFAULT_FOV_DEG,
  };

  private yawRad = 0;
  private pitchRad = -0.18;
  private speedMs = DEFAULT_SPEED_MS;
  private fovDeg = DEFAULT_FOV_DEG;
  private _initialised = false;

  get initialised(): boolean {
    return this._initialised;
  }

  get moveSpeedMs(): number {
    return this.speedMs;
  }

  get currentFovDeg(): number {
    return this.fovDeg;
  }

  /** Spawns 6 m behind, 3.5 m to the side, and 2.8 m above the car, aimed cleanly at the car's centre */
  spawnNear(carPos: THREE.Vector3, carQuaternion: THREE.Quaternion): void {
    const carFwd = this.forwardVec.set(0, 0, 1).applyQuaternion(carQuaternion);
    carFwd.y = 0;
    if (carFwd.lengthSq() > 1e-6) carFwd.normalize();
    else carFwd.set(0, 0, 1);
    const carRight = this.rightVec.crossVectors(carFwd, WORLD_UP).normalize();

    this.position
      .copy(carPos)
      .addScaledVector(carFwd, -6.0)
      .addScaledVector(carRight, 3.2)
      .addScaledVector(WORLD_UP, 2.6);
    this.velocity.set(0, 0, 0);
    this.fovDeg = DEFAULT_FOV_DEG;

    this.lookDir.set(carPos.x - this.position.x, carPos.y + 0.65 - this.position.y, carPos.z - this.position.z);
    const len = this.lookDir.length();
    if (len > 1e-4) {
      this.lookDir.divideScalar(len);
      // Three.js camera looks down -Z when yaw = 0, so atan2(-x, -z) aligns -Z with lookDir
      this.yawRad = Math.atan2(-this.lookDir.x, -this.lookDir.z);
      this.pitchRad = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(this.lookDir.y, -1, 1)), -PITCH_LIMIT_RAD, PITCH_LIMIT_RAD);
    } else {
      this.yawRad = 0;
      this.pitchRad = -0.18;
    }
    this.syncQuaternion();
    this._initialised = true;
  }

  /** Applies mouse drag deltas in radians (`dYawRad` + = turn left, `dPitchRad` + = look up) */
  lookDelta(dYawRad: number, dPitchRad: number): void {
    if (!Number.isFinite(dYawRad) || !Number.isFinite(dPitchRad)) return;
    this.yawRad += dYawRad;
    this.pitchRad = THREE.MathUtils.clamp(this.pitchRad + dPitchRad, -PITCH_LIMIT_RAD, PITCH_LIMIT_RAD);
    this.syncQuaternion();
  }

  /** Multiplies fly speed (e.g. scroll wheel up/down) */
  adjustSpeed(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.speedMs = THREE.MathUtils.clamp(this.speedMs * factor, MIN_SPEED_MS, MAX_SPEED_MS);
  }

  /** Adjusts vertical FOV in degrees */
  adjustFov(deltaDeg: number): void {
    if (!Number.isFinite(deltaDeg)) return;
    this.fovDeg = THREE.MathUtils.clamp(this.fovDeg + deltaDeg, MIN_FOV_DEG, MAX_FOV_DEG);
  }

  update(dt: number, input?: FreeCameraInput, minY?: number): FreeCameraOutput {
    const h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
    if (input && h > 0) {
      if (input.lookYawRate || input.lookPitchRate) {
        this.lookDelta((input.lookYawRate ?? 0) * h, (input.lookPitchRate ?? 0) * h);
      }
      const mult = input.fast ? 3.0 : input.slow ? 0.25 : 1.0;
      const spd = this.speedMs * mult;
      // Camera forward is -Z in local camera frame; right is +X
      this.forwardVec.set(0, 0, -1).applyQuaternion(this.quaternion);
      this.rightVec.set(1, 0, 0).applyQuaternion(this.quaternion);
      this.desiredVel
        .set(0, 0, 0)
        .addScaledVector(this.forwardVec, input.forward)
        .addScaledVector(this.rightVec, input.right)
        .addScaledVector(WORLD_UP, input.up);
      if (this.desiredVel.lengthSq() > 1) this.desiredVel.normalize();
      this.desiredVel.multiplyScalar(spd);
      const alpha = 1 - Math.exp(-h / VEL_SMOOTH_TAU_S);
      this.velocity.lerp(this.desiredVel, alpha);
      this.position.addScaledVector(this.velocity, h);
    } else if (h > 0) {
      const alpha = 1 - Math.exp(-h / VEL_SMOOTH_TAU_S);
      this.velocity.multiplyScalar(1 - alpha);
      this.position.addScaledVector(this.velocity, h);
    }

    if (typeof minY === "number" && Number.isFinite(minY) && this.position.y < minY) {
      this.position.y = minY;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    this.syncQuaternion();
    this.out.fovDeg = this.fovDeg;
    return this.out;
  }

  reset(): void {
    this._initialised = false;
    this.velocity.set(0, 0, 0);
  }

  private syncQuaternion(): void {
    this.euler.set(this.pitchRad, this.yawRad, 0, "YXZ");
    this.quaternion.setFromEuler(this.euler);
  }
}
