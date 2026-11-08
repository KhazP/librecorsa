import * as THREE from "three";

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

const BASE_DISTANCE_M = 3.0;
const BASE_HEIGHT_M = 1.24;
const PITCH_RAD = -4.0 * DEG2RAD;
const BASE_FOV_DEG = 60;
const SPEED_FOV_ADD_DEG = 8;
const BOOST_FOV_ADD_DEG = 3.5;
const BOOST_EXTRA_DIST_M = 0.24;
/** High-pass cutoff (Hz) on the vertical G: steady aerodynamic downforce (up to ~3.5 G at 320 km/h) would otherwise
 * sink the camera into the road at speed, so only crests and dips move it */
const VERT_G_HPF_HZ = 1.2;
const VERT_G_HPF_RC = 1 / (TWO_PI * VERT_G_HPF_HZ);
const VERT_FX_LIMIT_M = 0.18;
/** Most the boom may trail the car's nose (rad): a spin swings the camera round instead of leaving it side-on */
const MAX_LAG_RAD = 0.35;
/** Banking at which the height compensation is full (rad) */
const ROLL_LIMIT_RAD = 0.785;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Share of the way to a target one smoothing step covers: `perFrameAt60` each 1/60 s, compounded over `h` seconds */
function blend(perFrameAt60: number, h: number): number {
  return 1 - Math.pow(1 - Math.min(1, perFrameAt60), h * 60);
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const clamp01 = (x: number) => clamp(x, 0, 1);
const finiteOr = (x: number, fallback: number) => (Number.isFinite(x) ? x : fallback);

function smootherstep(x: number): number {
  const r = clamp01(x);
  return r * r * r * (r * (r * 6 - 15) + 10);
}

export interface ChaseCameraInput {
  /** The car's drawn position (its ground-level origin) */
  carPos: THREE.Vector3;
  /** The car's orientation (model axes: +X left, +Y up, +Z forward) */
  carQuaternion: THREE.Quaternion;
  /** The car's world velocity (m/s) */
  carVelocity: THREE.Vector3;
  /** + = accelerating */
  longitudinalG: number;
  /** + = turning right */
  lateralG: number;
  /** 1 at rest on flat ground */
  verticalG: number;
  wheelbaseM: number;
  cgHeightM: number;
  rideHeightOffsetM: number;
  kerbShakeM: number;
  manualOverrideActive: boolean;
}

export interface ChaseCameraOutput {
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
  up: THREE.Vector3;
  fovDeg: number;
}

/**
 * Whether the car is further from where a camera rig last saw it than one frame of `dt` allows (the shell's teleport
 * test): a rig updated only while its camera is on uses it to notice the frames it missed, and starts over
 */
export function carJumped(lastPos: THREE.Vector3, carPos: THREE.Vector3, carVel: THREE.Vector3, dt: number): boolean {
  const speed = carVel.length();
  const step = Number.isFinite(speed) && dt > 0 ? 2 * speed * dt : 0;
  return lastPos.distanceTo(carPos) > Math.max(5, step);
}

/**
 * Chase camera that trails the car's velocity (so the car visibly yaws in frame through a corner) on a boom scaled
 * by the wheelbase. It surges back under acceleration and in under braking, sways to the outside of a corner, heaves
 * over crests and dips, rises on banking and tilts the horizon slightly with sustained lateral G. Every rate is per
 * 1/60 s and compounded for the frame time, so it frames the car alike at any frame rate. Returns the same output
 * object every call.
 */
export class DynamicChaseCamera {
  private readonly out: ChaseCameraOutput = {
    position: new THREE.Vector3(),
    lookAt: new THREE.Vector3(0, 0, 15),
    up: new THREE.Vector3(0, 1, 0),
    fovDeg: BASE_FOV_DEG,
  };

  private readonly carVelocity = new THREE.Vector3();
  private readonly carVelocityRaw = new THREE.Vector3();
  /** G-force smoothed slowly (sustained load) and quickly (road vibration) */
  private readonly carAccel = new THREE.Vector3();
  private readonly carAccelFast = new THREE.Vector3();
  private readonly gForce = new THREE.Vector3();
  private readonly camDirFlat = new THREE.Vector3(0, 0, 1);

  private readonly carForward = new THREE.Vector3(0, 0, 1);
  private readonly carUp = new THREE.Vector3(0, 1, 0);
  private readonly carRight = new THREE.Vector3(-1, 0, 0);
  private readonly carDirFlat = new THREE.Vector3(0, 0, 1);
  private readonly carRightFlat = new THREE.Vector3(-1, 0, 0);
  private readonly cameraDir = new THREE.Vector3(0, 0, 1);
  private readonly cameraUp = new THREE.Vector3(0, 1, 0);
  private readonly cameraRight = new THREE.Vector3(-1, 0, 0);
  private readonly target = new THREE.Vector3();
  private readonly velFlat = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();

  private camPitch = 0;
  private carSpeedSmooth = 0;
  private rollAdd = 0;
  private boostExtraDist = 0;
  private fovDeg = BASE_FOV_DEG;
  private prevRawVertG = 0;
  private hpfVertG = 0;
  private initialised = false;
  /** Where the car was at the last update, to notice frames this camera missed (another camera was on) */
  private readonly lastCarPos = new THREE.Vector3();

  update(dt: number, input: ChaseCameraInput): ChaseCameraOutput {
    const out = this.out;
    const h = dt > 0 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 0;

    // Updated only while the chase camera is on: a car that has moved further than one frame allows since the last
    // update (another camera was on, a teleport) starts the camera over from its pose rather than from stale smoothing
    if (this.initialised && carJumped(this.lastCarPos, input.carPos, input.carVelocity, dt)) this.initialised = false;
    this.lastCarPos.copy(input.carPos);

    this.carRight.set(-1, 0, 0).applyQuaternion(input.carQuaternion);
    this.carUp.set(0, 1, 0).applyQuaternion(input.carQuaternion);
    this.carForward.set(0, 0, 1).applyQuaternion(input.carQuaternion);
    this.carDirFlat.set(this.carForward.x, 0, this.carForward.z);
    if (this.carDirFlat.lengthSq() > 1e-8) this.carDirFlat.normalize();
    else this.carDirFlat.set(0, 0, 1);
    this.carRightFlat.set(this.carRight.x, 0, this.carRight.z);
    if (this.carRightFlat.lengthSq() > 1e-8) this.carRightFlat.normalize();
    else this.carRightFlat.set(-this.carDirFlat.z, 0, this.carDirFlat.x);

    const halfWheelbaseM = input.wheelbaseM * 0.5;
    const distance = BASE_DISTANCE_M + halfWheelbaseM;
    const lonG = finiteOr(input.longitudinalG, 0);
    const latG = finiteOr(input.lateralG, 0);
    const rawVertG = finiteOr(input.verticalG, 1) - 1;
    const v = input.carVelocity;
    if (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)) this.carVelocityRaw.copy(v);
    else this.carVelocityRaw.set(0, 0, 0);

    if (!this.initialised) {
      this.carVelocity.copy(this.carVelocityRaw);
      this.carSpeedSmooth = this.carVelocityRaw.length();
      this.camPitch = Math.asin(clamp(this.carForward.y, -1, 1));
      this.camDirFlat.copy(this.carDirFlat);
      this.boostExtraDist = input.manualOverrideActive ? BOOST_EXTRA_DIST_M : 0;
      this.fovDeg = BASE_FOV_DEG;
      this.prevRawVertG = rawVertG;
      this.hpfVertG = 0;
      this.carAccel.set(0, 0, 0);
      this.carAccelFast.set(0, 0, 0);
      this.rollAdd = 0;
      this.initialised = true;
    }

    if (h > 0) {
      const aHp = VERT_G_HPF_RC / (VERT_G_HPF_RC + h);
      this.hpfVertG = aHp * (this.hpfVertG + rawVertG - this.prevRawVertG);
      this.prevRawVertG = rawVertG;
      this.gForce.set(latG, this.hpfVertG, lonG);
      this.carAccel.lerp(this.gForce, blend(2 / 60, h));
      this.carAccelFast.lerp(this.gForce, blend(30 / 60, h));
      this.carVelocity.lerp(this.carVelocityRaw, blend(8 / 60, h));
      this.carSpeedSmooth += (this.carVelocityRaw.length() - this.carSpeedSmooth) * blend(32 / 60, h);
    }

    // Pitch with the car's climb or dive; at a crawl, follow the nose rather than the (noisy) velocity
    const speedGate = clamp01(this.carSpeedSmooth - 1);
    const carPitch = Math.asin(clamp(this.carForward.y, -1, 1));
    const velLen = this.carVelocity.length();
    const velDirY = velLen > 1e-5 ? this.carVelocity.y / velLen : this.carForward.y;
    const pitchTarget = carPitch + (Math.asin(clamp(velDirY, -1, 1)) - carPitch) * speedGate;
    this.camPitch += (pitchTarget - this.camPitch) * blend(2 / 60, h);

    const rawSpeed = Math.max(1, this.carVelocityRaw.length());
    this.target.copy(this.carDirFlat).multiplyScalar(rawSpeed);
    this.velFlat.set(this.carVelocity.x, 0, this.carVelocity.z);
    if (this.velFlat.lengthSq() < 1e-6) this.velFlat.copy(this.carDirFlat).multiplyScalar(rawSpeed);
    this.target.lerp(this.velFlat, speedGate);
    this.camDirFlat.lerp(this.target, blend(1 / 60, h));
    this.camDirFlat.y = 0;
    if (this.camDirFlat.lengthSq() > 1e-8) this.camDirFlat.normalize();
    else this.camDirFlat.copy(this.carDirFlat);

    const lagRad = Math.atan2(this.scratch.crossVectors(this.carDirFlat, this.camDirFlat).y, this.camDirFlat.dot(this.carDirFlat));
    if (!(Math.abs(lagRad) <= MAX_LAG_RAD)) {
      this.camDirFlat
        .copy(this.carDirFlat)
        .applyAxisAngle(WORLD_UP, Number.isFinite(lagRad) ? Math.sign(lagRad) * MAX_LAG_RAD : 0)
        .normalize();
    }

    this.cameraDir.copy(this.camDirFlat);
    this.cameraUp.copy(this.carUp).addScaledVector(this.carRightFlat, -this.carUp.dot(this.carRightFlat));
    if (this.cameraUp.lengthSq() < 1e-8) this.cameraUp.set(0, 1, 0);
    this.cameraRight.crossVectors(this.cameraDir, this.cameraUp);
    if (this.cameraRight.lengthSq() > 1e-8) this.cameraRight.normalize();
    else this.cameraRight.copy(this.carRightFlat);
    this.cameraDir.applyAxisAngle(this.cameraRight, this.camPitch).normalize();
    this.cameraRight.crossVectors(this.cameraDir, this.cameraUp);
    if (this.cameraRight.lengthSq() > 1e-8) this.cameraRight.normalize();
    else this.cameraRight.copy(this.carRightFlat);

    const boostTarget = input.manualOverrideActive ? BOOST_EXTRA_DIST_M : 0;
    this.boostExtraDist += (boostTarget - this.boostExtraDist) * blend(8 / 60, h);
    const boomM = distance + (Math.sin(Math.atan(1.5 * this.carAccel.z - 0.258)) + 0.25) * 0.35 + this.boostExtraDist;
    const height = BASE_HEIGHT_M + boomM * Math.tan(-PITCH_RAD);
    const heaveM = clamp(
      Math.sin(Math.atan(-this.carAccel.y)) * 0.32 + Math.sin(Math.atan(-this.carAccelFast.y)) * 0.08 * (this.carSpeedSmooth / 30),
      -VERT_FX_LIMIT_M,
      VERT_FX_LIMIT_M
    );

    const rollAngle = -Math.atan2(
      this.scratch.crossVectors(this.carRight, this.carRightFlat).dot(this.carForward),
      this.carRight.dot(this.carRightFlat)
    );
    const rollSmooth = smootherstep(clamp(Math.abs(rollAngle), 0, ROLL_LIMIT_RAD) / ROLL_LIMIT_RAD);
    const rollTarget = height * 0.65 * Math.tan(rollSmooth * ROLL_LIMIT_RAD);
    this.rollAdd += (rollTarget - this.rollAdd) * blend(1 / 60, h);
    // To the outside of the corner: -carRight in a right-hander (lateral G > 0)
    const lateralSwayM = -Math.sin(Math.atan(this.carAccel.x)) * (input.wheelbaseM / 8);

    out.position
      .copy(input.carPos)
      .addScaledVector(this.cameraDir, -boomM)
      .addScaledVector(this.cameraUp, height + input.cgHeightM + finiteOr(input.rideHeightOffsetM, 0) * 0.5)
      .addScaledVector(this.carUp, this.rollAdd + heaveM + finiteOr(input.kerbShakeM, 0))
      .addScaledVector(this.carRight, lateralSwayM);

    const heavePitchRad = -Math.atan(heaveM / Math.max(0.5, boomM + halfWheelbaseM));
    this.cameraDir.applyAxisAngle(this.cameraRight, heavePitchRad + PITCH_RAD).normalize();
    out.lookAt.copy(out.position).addScaledVector(this.cameraDir, 15);

    // Horizon tilt: about 1° under sustained lateral G, blended toward the car's up on heavy banking
    out.up.copy(WORLD_UP).applyAxisAngle(this.carDirFlat, -DEG2RAD * Math.sin(Math.atan(2 * this.carAccel.x)));
    if (rollSmooth > 1e-4) out.up.lerp(this.carUp, rollSmooth * 0.35);
    out.up.normalize();

    const speedNorm = clamp01((this.carSpeedSmooth * 3.6) / 350);
    const fovTarget = BASE_FOV_DEG + speedNorm * SPEED_FOV_ADD_DEG + (input.manualOverrideActive ? BOOST_FOV_ADD_DEG : 0);
    this.fovDeg += (fovTarget - this.fovDeg) * blend(10 / 60, h);
    out.fovDeg = this.fovDeg;
    return out;
  }

  /** Start over from the car's pose on the next update (a teleport, a restart, the end of a replay) */
  reset(): void {
    this.initialised = false;
  }
}
