/**
 * The page's stand-in for a car that the simulation worker drives.
 *
 * The page keeps its own car (the twin): the garage, the menus and every setting read and write it as before, and each
 * change is sent on to the worker's car, so the two are set up alike. While the worker drives, the twin stands still
 * and everything that moves (pose, speeds, wheels, telemetry) is read from the worker's latest state instead. When the
 * worker does not drive (it is not ready, it failed, or an AI or online race is on, which still run on the page), the
 * stand-in is the twin: it steps it and reads it.
 *
 * A call that places the car (the grid, a teleport) is made on the twin at once, and the twin is what
 * is read until the worker's first state from after that placement arrives: the game never sees the car where it was.
 *
 * The worker takes the car over only fresh on the grid (a new car, a session start, a restart), where its car and the
 * twin are alike: a car on the move has tyre heat, wear and fuel the other does not, so once the page has driven the
 * twin it keeps it until the next grid start. The page can take the car back at any time (a race starting), from where
 * the worker had it.
 */
import * as THREE from "three";
import type { CarTelemetry, ControlInputs } from "@/types/f1";
import type { SimulatorCar } from "../simulator-car";
import { CarStateView } from "./car-state";
import { CAR_CALLABLE, CAR_SETTABLE, type CarCallable, type CarSettable, type SimCommand, type SimEvent } from "./sim-protocol";

/**
 * How the stand-in treats each member of a car. Typed over every `SimulatorCar` member, so a new one does not compile
 * until it is given a kind here.
 *
 * - `moving`: read from the worker's state while it drives, never written
 * - `movingSet`: read from the worker's state; a write goes to the twin and the worker
 * - `config`: read from the twin; a write goes to the twin and the worker
 * - `local`: the twin's alone (data the worker's own car has for itself, or that cannot cross threads)
 * - `call`: run on the twin and sent to the worker
 * - `liveCall`: run on the twin, sent to the worker only while it drives (per-frame feeds, contact)
 * - `place`: as `call`, and the twin is read until the worker has caught up
 * - `localCall`: run on the twin alone
 * - `own`: handled by name below
 */
type MemberKind = "moving" | "movingSet" | "config" | "local" | "call" | "liveCall" | "place" | "localCall" | "own";

const MEMBERS: Record<keyof SimulatorCar, MemberKind> = {
  telemetry: "moving",
  worldPosition: "moving",
  worldQuaternion: "moving",
  worldVelocity: "moving",
  wheels: "moving",
  tyreVisuals: "moving",
  vyMs: "moving",
  yawRateRadS: "moving",
  steerAngleNorm: "moving",
  pitchRad: "moving",
  rollRad: "moving",
  rideHeightOffsetM: "moving",
  wheelRotationRad: "moving",
  ersEnergyJ: "moving",
  sMeters: "movingSet",
  lateralOffsetM: "movingSet",
  vxMs: "movingSet",
  activeAeroMode: "movingSet",

  aiAutopilot: "config",
  aiPaceScale: "config",
  aiLineBiasM: "config",
  aiSpeedCapMs: "config",
  aiTopSpeedOpen: "config",
  aiSteerGain: "config",
  aeroPreset: "config",
  assistPreset: "config",
  gamepadAssistEnabled: "config",
  autoGearbox: "config",
  autoXMode: "config",
  tireCompound: "config",
  trackLimitsMode: "config",
  trackLimitsHold: "config",
  aiSelfRecovery: "config",

  groundQuery: "local",
  wheelbaseM: "local",
  cgHeightM: "local",
  maxSteerAngleRad: "local",
  contactMassKg: "local",
  contactYawInertiaKgM2: "local",
  brakingGuide: "local",
  vehicleId: "local",
  racingLineId: "local",
  overtakingRules: "local",
  // Race control's callbacks cannot cross threads; the worker drives practice only, where the aids are free
  raceControl: "local",
  // The AI field's plans for its own cars: never the player's in practice
  aiTargetSpeedMs: "local",
  aiPlan: "local",
  aiAutoTyres: "local",

  setTyreSetup: "call",
  applyChassisSetup: "call",
  setLiveTuner: "call",
  setOvertakingRules: "call",
  setDamageEffects: "call",
  setSimRealism: "call",
  invalidateLap: "liveCall",
  setAeroWakeState: "liveCall",
  setTrackEvolutionSample: "liveCall",
  setWeatherSample: "liveCall",
  activateBoostOverride: "liveCall",
  applyRigidBodyCollision: "liveCall",
  resetToStartGrid: "place",
  teleportToDistance: "place",
  teleportToTurn: "place",
  restorePose: "place",

  getTyreSetup: "localCall",
  getChassisSetup: "localCall",
  getLiveTunerState: "localCall",
  aiPlanGrip: "localCall",
  aiBaseSpeedProfile: "localCall",
  createAiPeerCar: "localCall",

  renderLeadS: "own",
  steeringAssist: "own",
  step: "own",
  attachTrackRoot: "own",
};

const settable: ReadonlySet<string> = new Set(CAR_SETTABLE);
const callable: ReadonlySet<string> = new Set(CAR_CALLABLE);
const kindOf = (key: string | symbol): MemberKind | undefined =>
  typeof key === "string" && Object.hasOwn(MEMBERS, key) ? MEMBERS[key as keyof SimulatorCar] : undefined;

/** The state is carried forward no further than this when the worker's latest is older (s) */
const MAX_RENDER_LEAD_S = 0.05;
/** Steering-torque samples kept while the game does not take them (a quarter of a second at 500 Hz) */
const MAX_PENDING_FFB = 128;

export interface RemoteCarLink {
  /** Sends a command about this car to the worker (dropped once the worker has been given another car) */
  post(command: SimCommand): void;
  /** Sends the track root's colliders to the worker, once per root */
  sendColliders(root: THREE.Object3D): void;
}

export interface RemoteCar {
  /** The stand-in: hand it to the game as the player's car */
  readonly car: SimulatorCar;
  /** The page's own car behind it */
  readonly twin: SimulatorCar;
  /** The worker has built its car and can drive it */
  readonly ready: boolean;
  /** The worker is driving */
  readonly remote: boolean;
  /** Hands the car to the worker (true: only once it is ready, and the car fresh on the grid) or back to the page */
  setRemote(on: boolean): void;
  /** Once per frame, after the frame's step (if any): stops the worker's clock when the game stopped driving */
  endFrame(): void;
  /** The worker's events about this car */
  receive(event: SimEvent): void;
}

const _forward = new THREE.Vector3();

/** `wallNowMs`: the clock the simulation stamps its states with (`performance.timeOrigin + performance.now()`) */
export function createRemoteCar(twin: SimulatorCar, link: RemoteCarLink, wallNowMs: () => number): RemoteCar {
  const view = new CarStateView(structuredClone(twin.telemetry) as CarTelemetry);
  let ready = false;
  let failed = false;
  let remote = false;
  /** Placements made so far, and the one the worker's latest state is from */
  let epoch = 0;
  let stateEpoch = -1;
  let stateWallMs = 0;
  let stateLeadS = 0;
  let pendingFfb: number[] = [];
  let stepped = false;
  let wasStepping = false;
  /** The twin is as the last grid start left it: the worker's car, given the same calls, is its like */
  let twinFresh = false;
  /** The worker drives and its state is from after the last placement: what moves is read from it */
  const live = () => remote && stateEpoch === epoch;

  const yawOf = (q: THREE.Quaternion) => {
    _forward.set(0, 0, 1).applyQuaternion(q);
    return Math.atan2(_forward.x, _forward.z);
  };
  /** Puts the twin where the worker's car is (the page takes the car back) */
  const syncTwinToWorker = () => {
    if (stateEpoch !== epoch) return;
    const p = view.worldPosition;
    if (twin.restorePose) twin.restorePose({ x: p.x, z: p.z, yawRad: yawOf(view.worldQuaternion), speedMs: view.vxMs, s: view.sMeters });
    else twin.teleportToDistance(view.sMeters, view.vxMs, view.lateralOffsetM);
    twinFresh = false;
  };

  const step = (dtSeconds: number, inputs: Partial<ControlInputs>): unknown => {
    if (!remote) {
      twinFresh = false;
      return twin.step(dtSeconds, inputs);
    }
    stepped = true;
    link.post({ type: "inputs", inputs });
    // The steering torque of the ticks since the last frame, for the force feedback to play
    view.telemetry.ffbSubframeSamples = pendingFfb;
    pendingFfb = [];
    if (!live()) return twin.telemetry;
    // The worker's state is a few milliseconds old by the time the frame is drawn: carried forward to now
    if (wasStepping) view.carryForward(THREE.MathUtils.clamp((wallNowMs() - stateWallMs) / 1000 + stateLeadS, 0, MAX_RENDER_LEAD_S));
    return view.telemetry;
  };

  const steeringAssist: SimulatorCar["steeringAssist"] = {
    get settings() {
      return twin.steeringAssist.settings;
    },
    set settings(value) {
      twin.steeringAssist.settings = value;
      link.post({ type: "steeringAssist", settings: value });
    },
    get source() {
      return live() ? view.steerSource : twin.steeringAssist.source;
    },
  };

  const attachTrackRoot = twin.attachTrackRoot
    ? (root: THREE.Object3D) => {
        twin.attachTrackRoot?.(root);
        link.sendColliders(root);
      }
    : undefined;

  const twinMembers = twin as unknown as Record<string | symbol, unknown>;
  const viewMembers = view as unknown as Record<string | symbol, unknown>;
  const wrappers = new Map<string, (...args: unknown[]) => unknown>();
  /** The twin's method, also sent to the worker when `send` says so; undefined when the twin has no such method */
  const wrapped = (name: string, kind: "call" | "liveCall" | "place") => {
    const method = twinMembers[name];
    if (typeof method !== "function") return undefined;
    let wrapper = wrappers.get(name);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        const result = (method as (...a: unknown[]) => unknown).apply(twin, args);
        if (name === "resetToStartGrid") twinFresh = true;
        if (callable.has(name) && (kind !== "liveCall" || remote)) {
          link.post(kind === "place" ? { type: "call", name: name as CarCallable, args, epoch: ++epoch } : { type: "call", name: name as CarCallable, args });
        }
        return result;
      };
      wrappers.set(name, wrapper);
    }
    return wrapper;
  };

  const car = new Proxy(twin, {
    get(_target, key) {
      const kind = kindOf(key);
      switch (kind) {
        case "moving":
        case "movingSet":
          return live() ? viewMembers[key] : twinMembers[key];
        case "call":
        case "liveCall":
        case "place":
          return wrapped(key as string, kind);
        case "own":
          if (key === "step") return step;
          if (key === "steeringAssist") return steeringAssist;
          if (key === "attachTrackRoot") return attachTrackRoot;
          // The worker's pose is already carried forward to the frame (`step`)
          return live() ? 0 : twin.renderLeadS;
        default: {
          const value = twinMembers[key];
          return typeof value === "function" ? value.bind(twin) : value;
        }
      }
    },
    set(_target, key, value) {
      const kind = kindOf(key);
      // A setting written again with the value it has (the game sets several every frame) is not sent again; what
      // moves is always sent, the twin's own value of it being stale while the worker drives
      const unchanged = kind === "config" && twinMembers[key] === value;
      twinMembers[key] = value;
      if (!unchanged && (kind === "config" || kind === "movingSet") && settable.has(key as string)) {
        link.post({ type: "set", key: key as CarSettable, value });
      }
      return true;
    },
  });

  return {
    car,
    twin,
    get ready() {
      return ready && !failed;
    },
    get remote() {
      return remote;
    },
    setRemote(on) {
      if (on === remote || (on && (!ready || failed || !twinFresh))) return;
      if (on) {
        remote = true;
      } else {
        syncTwinToWorker();
        remote = false;
        wasStepping = stepped = false;
        pendingFfb = [];
        link.post({ type: "hold" });
      }
    },
    endFrame() {
      if (remote && wasStepping && !stepped) link.post({ type: "hold" });
      wasStepping = stepped;
      stepped = false;
    },
    receive(event) {
      if (event.type === "ready") {
        ready = true;
      } else if (event.type === "error") {
        // The page's own car carries on from where the worker's was
        failed = true;
        if (remote) {
          syncTwinToWorker();
          remote = false;
        }
      } else if (event.type === "state" && event.epoch === epoch) {
        view.apply(event.state);
        if (event.telemetry) view.applyTelemetry(event.telemetry);
        stateEpoch = event.epoch;
        stateWallMs = event.wallMs;
        stateLeadS = event.leadS;
        if (remote) {
          for (const sample of event.ffb) pendingFfb.push(sample);
          if (pendingFfb.length > MAX_PENDING_FFB) pendingFfb.splice(0, pendingFfb.length - MAX_PENDING_FFB);
        }
      }
    },
  };
}
