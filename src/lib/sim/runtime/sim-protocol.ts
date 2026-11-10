/**
 * Messages between the page and the simulation worker (`sim-worker.ts`, `sim-runtime.ts`). Plain data only:
 * everything here crosses `postMessage`, so no class instances, functions or three.js objects.
 */
import type { CarTelemetry, ControlInputs, VehicleModelId } from "@/types/f1";
import type { RawTrackJson } from "@/lib/track-data";
import type { SteeringAssistSettings } from "../steering-assist";
import type { TrackColliderData } from "../track-colliders";
import type { CarState } from "./car-state";

/** The simulation's tick (s): the cars' own control tick, 250 Hz. The worker advances whole ticks of this */
export const SIM_TICK_S = 0.004;

/** Car properties the page sets on its stand-in that the worker's car takes as they are */
export const CAR_SETTABLE = [
  "aiAutopilot",
  "aiPaceScale",
  "aiLineBiasM",
  "aiSpeedCapMs",
  "aiSteerGain",
  "aeroPreset",
  "assistPreset",
  "gamepadAssistEnabled",
  "autoGearbox",
  "autoXMode",
  "activeAeroMode",
  "tireCompound",
  "trackLimitsMode",
  "trackLimitsHold",
  "aiSelfRecovery",
  "vxMs",
  "sMeters",
  "lateralOffsetM",
] as const;
export type CarSettable = (typeof CAR_SETTABLE)[number];

/** Car methods the page calls on its stand-in that the worker's car runs too (their arguments are plain data) */
export const CAR_CALLABLE = [
  "resetToStartGrid",
  "teleportToDistance",
  "teleportToTurn",
  "restorePose",
  "setTyreSetup",
  "applyChassisSetup",
  "setLiveTuner",
  "setOvertakingRules",
  "invalidateLap",
  "setDamageEffects",
  "setAeroWakeState",
  "setTrackEvolutionSample",
  "setWeatherSample",
  "setSimRealism",
  "activateBoostOverride",
  "applyRigidBodyCollision",
] as const;
export type CarCallable = (typeof CAR_CALLABLE)[number];

/** Page → worker */
export type SimCommand =
  | { type: "ping"; id: number }
  /**
   * The car to simulate, and with the first one the circuit; answered with `ready`. A later `init` replaces the car
   * (a car change). `car` numbers the cars: the events about one carry its number
   */
  | { type: "init"; car: number; track?: { id: string; raw: RawTrackJson }; vehicle: VehicleModelId; vf26Rigid: boolean }
  /** The circuit's colliders, once its mesh has loaded on the page */
  | { type: "colliders"; data: TrackColliderData }
  | { type: "set"; key: CarSettable; value: unknown }
  /** `epoch` is set on a call that places the car: states sent from then on carry it */
  | { type: "call"; name: CarCallable; args: unknown[]; epoch?: number }
  | { type: "steeringAssist"; settings: SteeringAssistSettings }
  /** This frame's controls; the car is driven with them until the next arrive. `epoch` as for `call` */
  | { type: "inputs"; inputs: Partial<ControlInputs> }
  /** Stop the clock (pause, a menu, the replay) until the next `inputs` */
  | { type: "hold" };

/** Worker → page */
export type SimEvent =
  | { type: "pong"; id: number }
  | { type: "ready"; car: number }
  | {
      type: "state";
      car: number;
      /** The last placement (`call.epoch`) the car has taken */
      epoch: number;
      /** Wall clock of the tick that produced it (ms, `performance.timeOrigin + performance.now()`) */
      wallMs: number;
      /** Time the tick had not yet simulated then (s, under one tick): the state is that much older than `wallMs` */
      leadS: number;
      state: CarState;
      /** Steering-torque samples of the ticks since the last state (500 Hz, oldest first) */
      ffb: number[];
      /** Every few states: the whole telemetry */
      telemetry?: Partial<CarTelemetry>;
    }
  | { type: "error"; message: string };
