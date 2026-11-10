/**
 * The part of a car that changes as it drives (pose, speeds, wheels, tyres), as plain data that crosses to another
 * thread, and a view that holds it in the shapes the rest of the game reads from a `SimulatorCar`.
 *
 * The simulation worker captures its car into a `CarState` after every tick; the page applies the newest one to a
 * `CarStateView`, which its stand-in for the car (`remote-car.ts`) reads from.
 */
import * as THREE from "three";
import type { ActiveAeroMode, CarTelemetry, SurfaceType } from "@/types/f1";
import type { SimulatorCar, SimulatorWheel, TyreVisualState } from "../simulator-car";
import type { SteeringSource } from "../steering-assist";

export interface WheelState {
  x: number;
  y: number;
  z: number;
  zRoad: number;
  fzN: number;
  combinedSlipNorm: number;
  surfaceType: SurfaceType;
  spinVel: number;
}

export interface CarState {
  /** Position, orientation (x, y, z, w) and world velocity (null on a car that reports none) */
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number] | null;
  sMeters: number;
  lateralOffsetM: number;
  vxMs: number;
  vyMs: number;
  yawRateRadS: number;
  steerAngleNorm: number;
  pitchRad: number;
  rollRad: number;
  rideHeightOffsetM: number;
  wheelRotationRad: number;
  ersEnergyJ: number;
  activeAeroMode: ActiveAeroMode;
  steerSource: SteeringSource | null;
  wheels: [WheelState, WheelState, WheelState, WheelState];
  tyres: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState] | null;
}

const blankWheel = (): WheelState => ({ x: 0, y: 0, z: 0, zRoad: 0, fzN: 0, combinedSlipNorm: 0, surfaceType: "asphalt", spinVel: 0 });
const blankTyre = (): TyreVisualState => ({ loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0, onRoad: true });

export function blankCarState(): CarState {
  return {
    p: [0, 0, 0],
    q: [0, 0, 0, 1],
    v: null,
    sMeters: 0,
    lateralOffsetM: 0,
    vxMs: 0,
    vyMs: 0,
    yawRateRadS: 0,
    steerAngleNorm: 0,
    pitchRad: 0,
    rollRad: 0,
    rideHeightOffsetM: 0,
    wheelRotationRad: 0,
    ersEnergyJ: 0,
    activeAeroMode: "Z_MODE",
    steerSource: null,
    wheels: [blankWheel(), blankWheel(), blankWheel(), blankWheel()],
    tyres: null,
  };
}

function copyTyre(from: TyreVisualState, to: TyreVisualState): void {
  to.loadedRadiusM = from.loadedRadiusM;
  to.verticalDeflectionM = from.verticalDeflectionM;
  to.lateralForceN = from.lateralForceN;
  to.camberRad = from.camberRad;
  to.carcassDeflectionXM = from.carcassDeflectionXM;
  to.carcassDeflectionYM = from.carcassDeflectionYM;
  to.onRoad = from.onRoad;
  const c = from.contactInCar;
  if (!c) to.contactInCar = undefined;
  else if (to.contactInCar) {
    to.contactInCar.x = c.x;
    to.contactInCar.y = c.y;
    to.contactInCar.z = c.z;
  } else to.contactInCar = { x: c.x, y: c.y, z: c.z };
}

/** Writes the car's moving state into `out` (reused from tick to tick: nothing is allocated once it is shaped) */
export function captureCarState(car: SimulatorCar, out: CarState): CarState {
  const p = car.worldPosition;
  const q = car.worldQuaternion;
  out.p[0] = p.x;
  out.p[1] = p.y;
  out.p[2] = p.z;
  out.q[0] = q.x;
  out.q[1] = q.y;
  out.q[2] = q.z;
  out.q[3] = q.w;
  const v = car.worldVelocity;
  if (v) {
    out.v ??= [0, 0, 0];
    out.v[0] = v.x;
    out.v[1] = v.y;
    out.v[2] = v.z;
  } else out.v = null;
  out.sMeters = car.sMeters;
  out.lateralOffsetM = car.lateralOffsetM;
  out.vxMs = car.vxMs;
  out.vyMs = car.vyMs;
  out.yawRateRadS = car.yawRateRadS;
  out.steerAngleNorm = car.steerAngleNorm;
  out.pitchRad = car.pitchRad;
  out.rollRad = car.rollRad;
  out.rideHeightOffsetM = car.rideHeightOffsetM;
  out.wheelRotationRad = car.wheelRotationRad;
  out.ersEnergyJ = car.ersEnergyJ;
  out.activeAeroMode = car.activeAeroMode;
  out.steerSource = car.steeringAssist.source;
  for (let i = 0; i < 4; i++) {
    const w = car.wheels[i];
    const o = out.wheels[i];
    o.x = w.worldPos.x;
    o.y = w.worldPos.y;
    o.z = w.worldPos.z;
    o.zRoad = w.zRoad;
    o.fzN = w.fzN;
    o.combinedSlipNorm = w.combinedSlipNorm;
    o.surfaceType = w.surfaceType;
    o.spinVel = w.spinVel;
  }
  const tyres = car.tyreVisuals;
  if (tyres) {
    out.tyres ??= [blankTyre(), blankTyre(), blankTyre(), blankTyre()];
    for (let i = 0; i < 4; i++) copyTyre(tyres[i], out.tyres[i]);
  } else out.tyres = null;
  return out;
}

/** Telemetry fields the page fills in itself each frame (the race, its radar, race control): never taken from the worker */
export const PAGE_OWNED_TELEMETRY: readonly (keyof CarTelemetry)[] = ["race", "runId", "radar", "peers", "trackLimits", "ffbSubframeSamples"];

const _up = new THREE.Vector3(0, 1, 0);
const _turn = new THREE.Quaternion();

/** A car's moving state in the shapes a `SimulatorCar` has it, filled from `CarState`s */
export class CarStateView {
  readonly worldPosition = new THREE.Vector3();
  readonly worldQuaternion = new THREE.Quaternion();
  worldVelocity: THREE.Vector3 | undefined = undefined;
  private readonly velocity = new THREE.Vector3();
  readonly wheels: [SimulatorWheel, SimulatorWheel, SimulatorWheel, SimulatorWheel];
  tyreVisuals: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState] | undefined = undefined;
  private readonly tyres: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState] = [blankTyre(), blankTyre(), blankTyre(), blankTyre()];
  sMeters = 0;
  lateralOffsetM = 0;
  vxMs = 0;
  vyMs = 0;
  yawRateRadS = 0;
  steerAngleNorm = 0;
  pitchRad = 0;
  rollRad = 0;
  rideHeightOffsetM = 0;
  wheelRotationRad = 0;
  ersEnergyJ = 0;
  activeAeroMode: ActiveAeroMode = "Z_MODE";
  steerSource: SteeringSource | null = null;
  /** The pose and the wheels as the last state gave them: `carryForward` works from these */
  private readonly statePosition = new THREE.Vector3();
  private readonly stateQuaternion = new THREE.Quaternion();
  private readonly stateWheels = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  /** `telemetry` starts as a copy of the car's own, so every field the HUD reads is there before the first update */
  constructor(readonly telemetry: CarTelemetry) {
    const wheel = (): SimulatorWheel => ({ worldPos: { x: 0, y: 0, z: 0 }, zRoad: 0, fzN: 0, combinedSlipNorm: 0, surfaceType: "asphalt", spinVel: 0 });
    this.wheels = [wheel(), wheel(), wheel(), wheel()];
  }

  apply(state: CarState): void {
    this.worldPosition.set(state.p[0], state.p[1], state.p[2]);
    this.worldQuaternion.set(state.q[0], state.q[1], state.q[2], state.q[3]);
    this.statePosition.copy(this.worldPosition);
    this.stateQuaternion.copy(this.worldQuaternion);
    this.worldVelocity = state.v ? this.velocity.set(state.v[0], state.v[1], state.v[2]) : undefined;
    this.sMeters = state.sMeters;
    this.lateralOffsetM = state.lateralOffsetM;
    this.vxMs = state.vxMs;
    this.vyMs = state.vyMs;
    this.yawRateRadS = state.yawRateRadS;
    this.steerAngleNorm = state.steerAngleNorm;
    this.pitchRad = state.pitchRad;
    this.rollRad = state.rollRad;
    this.rideHeightOffsetM = state.rideHeightOffsetM;
    this.wheelRotationRad = state.wheelRotationRad;
    this.ersEnergyJ = state.ersEnergyJ;
    this.activeAeroMode = state.activeAeroMode;
    this.steerSource = state.steerSource;
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      const o = this.wheels[i];
      o.worldPos.x = w.x;
      o.worldPos.y = w.y;
      o.worldPos.z = w.z;
      this.stateWheels[i].set(w.x, w.y, w.z);
      o.zRoad = w.zRoad;
      o.fzN = w.fzN;
      o.combinedSlipNorm = w.combinedSlipNorm;
      o.surfaceType = w.surfaceType;
      o.spinVel = w.spinVel;
    }
    if (state.tyres) {
      for (let i = 0; i < 4; i++) copyTyre(state.tyres[i], this.tyres[i]);
      this.tyreVisuals = this.tyres;
    } else this.tyreVisuals = undefined;
  }

  /**
   * Carries the pose forward by `leadS`: the state is from a tick a few milliseconds back, the frame is drawn now.
   * The position and the wheels move with the car's velocity, the heading turns with its yaw rate. Always from the
   * state as it arrived, so calling it again (a frame with no newer state) does not add up.
   */
  carryForward(leadS: number): void {
    const v = this.worldVelocity;
    if (!v || !(leadS > 0)) return;
    this.worldPosition.copy(this.statePosition).addScaledVector(v, leadS);
    // Yaw rate is + to the right, a turn about the car's own up axis the other way
    this.worldQuaternion.copy(this.stateQuaternion).multiply(_turn.setFromAxisAngle(_up, -this.yawRateRadS * leadS));
    for (let i = 0; i < 4; i++) {
      const from = this.stateWheels[i];
      const o = this.wheels[i].worldPos;
      o.x = from.x + v.x * leadS;
      o.y = from.y + v.y * leadS;
      o.z = from.z + v.z * leadS;
    }
  }

  /** Takes the worker's telemetry, leaving the fields the page fills in itself as they are */
  applyTelemetry(telemetry: Partial<CarTelemetry>): void {
    const mine = this.telemetry as unknown as Record<string, unknown>;
    const kept = PAGE_OWNED_TELEMETRY.map((key) => mine[key]);
    Object.assign(this.telemetry, telemetry);
    PAGE_OWNED_TELEMETRY.forEach((key, i) => (mine[key] = kept[i]));
  }
}
