/**
 * Messages between the page and the simulation worker (`sim-worker.ts`, `sim-runtime.ts`). Plain data only:
 * everything here crosses `postMessage`, so no class instances, functions or three.js objects.
 */
import type { QualifyingGridInput } from "../qualifying";
import type { CarTelemetry, ControlInputs, RaceStatus, VehicleModelId } from "@/types/f1";
import type { RawTrackJson } from "@/lib/track-data";
import type { FieldCarRestorePose, RaceDriverLabel } from "../ai-race";
import type { DamageLevel } from "../car-damage";
import type { PenaltyReason } from "../penalty-ledger";
import type { AiGridOrder, PlayerGridSlot } from "../race-setup";
import type { SimRealismFlags } from "../sim-realism";
import type { SessionConditions, WeatherSyncState } from "../weather";
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
  "aiTopSpeedOpen",
  "aiSteerGain",
  "aeroPreset",
  "assistPreset",
  "gamepadAssistEnabled",
  "autoGearbox",
  "autoClutch",
  "autoXMode",
  "autoOvertake",
  "activeAeroMode",
  "tireCompound",
  "trackLimitsMode",
  "trackLimitsHold",
  "gridHold",
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
  "setEnergySession",
  "activateBoostOverride",
  "applyRigidBodyCollision",
] as const;
export type CarCallable = (typeof CAR_CALLABLE)[number];

/** An AI race's setup, as `startAiRace` gives it to the field */
export interface RaceStartSetup {
  laps: number;
  gridOrder: AiGridOrder;
  playerGrid: PlayerGridSlot;
  damage: DamageLevel;
  aggressionAdd: number;
  standing: boolean;
  /** A standing start the player makes on the clutch: the car held on the grid with its engine live */
  manualStart?: boolean;
  /** The player's code and colour (`AiRace.playerDriver`) */
  driver: RaceDriverLabel | null;
  /** The rules close the overtaking aids inside a yellow zone */
  lockAidsInYellow?: boolean;
  /** The grid from qualifying (`AiRace.qualifying`); absent: none */
  qualifying?: QualifyingGridInput;
}

/**
 * An AI race in the worker (`sim-runtime.ts`), around the car it simulates: built ahead in the menus (`prepare`),
 * started (the car is placed on the grid: `epoch` as for `call`), steered, and ended. `race` numbers the races: the
 * events about one carry its number
 */
export type RaceCommand =
  | { type: "race"; op: "prepare"; opponents: number; skill: number }
  | {
      type: "race";
      op: "start";
      race: number;
      opponents: number;
      skill: number;
      setup: RaceStartSetup;
      epoch: number;
      /** The page's weather and realism: the race's road starts from them */
      weather: WeatherSyncState;
      realism: SimRealismFlags;
      /** The field's seed (a headless check replays one); a field built ahead with another is built again */
      seed?: number;
    }
  | { type: "race"; op: "skill"; skill: number }
  | { type: "race"; op: "penalty"; seconds: number; dq?: boolean }
  | { type: "race"; op: "rules"; lockAidsInYellow: boolean }
  | { type: "race"; op: "penalise"; seconds: number; reason: PenaltyReason; detail: string }
  | { type: "race"; op: "conditions"; conditions: SessionConditions }
  | { type: "race"; op: "realism"; flags: SimRealismFlags }
  | { type: "race"; op: "restore"; poses: FieldCarRestorePose[]; rewindS: number; epoch?: number }
  | { type: "race"; op: "end" };

/** An AI car of the race, as the page draws it */
export interface RaceRosterEntry {
  peerId: string;
  driverCode: string;
  teamColorHex: string;
  vehicle?: VehicleModelId;
}

/** Page → worker */
export type SimCommand =
  | { type: "ping"; id: number }
  /**
   * The car to simulate, and with the first one the circuit; answered with `ready`. A later `init` replaces the car
   * (a car change). `car` numbers the cars: the events about one carry its number
   */
  | {
      type: "init";
      car: number;
      track?: { id: string; raw: RawTrackJson };
      vehicle: VehicleModelId;
      /** The plan of another body the car wears (`CarDefinition.bodyPlan`) */
      bodyPlan?: [number, number][];
      lc26Rigid: boolean;
    }
  /** The circuit's colliders, once its mesh has loaded on the page */
  | { type: "colliders"; data: TrackColliderData }
  | { type: "set"; key: CarSettable; value: unknown }
  /** `epoch` is set on a call that places the car: states sent from then on carry it */
  | { type: "call"; name: CarCallable; args: unknown[]; epoch?: number }
  | { type: "steeringAssist"; settings: SteeringAssistSettings }
  /** This frame's controls; the car is driven with them until the next arrive. `epoch` as for `call` */
  | { type: "inputs"; inputs: Partial<ControlInputs> }
  /** Stop the clock (pause, a menu, the replay) until the next `inputs` */
  | { type: "hold" }
  /** `?perf=1`: time the simulation's work and send a `perf` event about once a second (or stop) */
  | { type: "perf"; on: boolean }
  | RaceCommand;

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
      /**
       * With an AI race on, after each step of its field: every AI car's pose (`field-frame.ts`), as of `ageS` before
       * this state's own time (the field steps every other tick)
       */
      field?: { race: number; epoch?: number; ageS: number; poses: Float64Array };
    }
  /**
   * An AI race's standing, a few times a second and whenever the start lights change: the race status for the HUD,
   * and what the page draws the road from. `roster` with the first after the start, `weather` about once a second
   */
  | {
      type: "race";
      car: number;
      race: number;
      epoch?: number;
      status: RaceStatus;
      frozen: boolean;
      rulesActive: boolean;
      roster?: RaceRosterEntry[];
      road: { wetness: number | null; spray: number; rubber: number };
      weather?: WeatherSyncState;
    }
  /**
   * The simulation's own timing since the last one (with `perf` on): `ticks` simulated in `spanMs` of wall time,
   * `busyMs` spent simulating and sending them, `maxWakeMs` the longest single wake. Not about any one car
   */
  | { type: "perf"; spanMs: number; ticks: number; busyMs: number; maxWakeMs: number }
  | { type: "error"; message: string };
