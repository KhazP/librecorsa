/**
 * The simulation as the worker runs it: the player's car on the active circuit, driven by commands
 * (`sim-protocol.ts`) and advanced in whole 4 ms ticks, reporting its state after each advance. With an AI race on,
 * the race too: its field round the same car, the track environment every car shares, and the race's standing.
 *
 * It knows nothing of threads or timers: `sim-worker.ts` feeds it messages and wall-clock time, and the headless
 * checks drive it directly (`scripts/verify-sim-runtime.ts`). Nothing here may touch the page (window, storage, DOM).
 */
import type { ControlInputs } from "@/types/f1";
import { setLc26OnRigidBody } from "@/lib/cars/lc26-engine";
import { vehicleModelSpec } from "@/lib/cars/vehicle-models";
import { getActiveTrackData, setActiveTrack, type BuiltTrackData } from "@/lib/track-data";
import type * as THREE from "three";
import type { SimulatorCar } from "../simulator-car";
import { trackRootFromColliderData } from "../track-colliders";
import { AiOpponentField, aiDriversFor } from "../ai-opponents";
import type { OvertakingRaceControl } from "../overtaking-rules";
import { TrackEnvironment } from "../track-environment";
import { blankCarState, captureCarState, PAGE_OWNED_TELEMETRY } from "./car-state";
import { packFieldPoses } from "./field-frame";
import { CAR_CALLABLE, CAR_SETTABLE, SIM_TICK_S, type RaceCommand, type SimCommand, type SimEvent } from "./sim-protocol";

/** A stall longer than this is not caught up (s) */
const MAX_CATCH_UP_S = 0.25;
/**
 * With a race on, no more than this is caught up (s): a machine that cannot keep up with the whole field runs it a
 * little slower than real time, a dozen ticks a wake, rather than a quarter of a second of ticks in one wake with the
 * page hearing nothing meanwhile
 */
const MAX_CATCH_UP_RACE_S = 0.05;
/** The field steps once every this many ticks (8 ms, as the headless races step it at about 1/120 s) */
export const FIELD_TICKS = 2;
/** The race's standing goes to the page every this many field steps (about 20 times a second) */
const STATUS_EVERY = 6;
/** ... and its weather about once a second */
const WEATHER_EVERY = 125;

/** An AI race in this simulation, round its car */
interface WorkerRace {
  id: number;
  epoch: number;
  opponents: number;
  field: AiOpponentField;
  env: TrackEnvironment;
  /** Ticks since the field last stepped (0 .. FIELD_TICKS - 1) */
  tick: number;
  steps: number;
  /** The field stepped since the last state went out */
  fresh: boolean;
  poses: Float64Array | null;
  sentPhase: string;
  sentLights: number;
  sentRolling: boolean;
  rosterSent: boolean;
  /** The car's race control before the race wired its own */
  ownRaceControl: OvertakingRaceControl | null | undefined;
}
/** The whole telemetry goes out with every this-many-th state */
const TELEMETRY_EVERY_STATES = 2;

const settable: ReadonlySet<string> = new Set(CAR_SETTABLE);
const callable: ReadonlySet<string> = new Set(CAR_CALLABLE);

export class SimRuntime {
  private track: BuiltTrackData | null = null;
  private trackRoot: THREE.Object3D | null = null;
  private car: SimulatorCar | null = null;
  private inputs: Partial<ControlInputs> = {};
  /** One-frame presses (paddles, the X-mode button) waiting for the next tick */
  private pressed = { shiftUp: false, shiftDown: false, neutral: false, toggleXMode: false };
  private driving = false;
  private accumulatorS = 0;
  private epoch = 0;
  private carNumber = 0;
  private statesSent = 0;
  private readonly state = blankCarState();
  private ffb: number[] = [];
  private race: WorkerRace | null = null;
  /** A field built ahead (in the menus) for the next race, round the car it was built for */
  private spare: { field: AiOpponentField; env: TrackEnvironment; car: SimulatorCar; opponents: number } | null = null;

  constructor(private readonly emit: (event: SimEvent) => void) {}

  /** The car being simulated (the headless checks read it) */
  get simulatedCar(): SimulatorCar | null {
    return this.car;
  }

  /** The AI race running here, if any (the headless checks read it) */
  get raceField(): AiOpponentField | null {
    return this.race?.field ?? null;
  }

  /** The field built ahead for the next race, if any (the headless checks read it) */
  get preparedField(): AiOpponentField | null {
    return this.spare?.field ?? null;
  }

  handle(command: SimCommand): void {
    switch (command.type) {
      case "ping":
        this.emit({ type: "pong", id: command.id });
        return;
      case "init": {
        setLc26OnRigidBody(command.lc26Rigid);
        if (command.track) {
          setActiveTrack(command.track.id, command.track.raw);
          this.track = getActiveTrackData(1200);
        }
        if (!this.track) throw new Error("The simulation was given a car before its circuit");
        // Another car: a race round the last one ends with it
        this.endRace();
        this.spare = null;
        this.car = vehicleModelSpec(command.vehicle).createSim(this.track, this.trackRoot, command.bodyPlan);
        this.carNumber = command.car;
        this.epoch = 0;
        this.inputs = {};
        this.driving = false;
        this.accumulatorS = 0;
        this.emit({ type: "ready", car: command.car });
        return;
      }
      case "colliders":
        this.trackRoot = trackRootFromColliderData(command.data);
        this.car?.attachTrackRoot?.(this.trackRoot);
        this.race?.field.attachTrackRoot(this.trackRoot);
        this.spare?.field.attachTrackRoot(this.trackRoot);
        return;
      case "set": {
        if (!this.car || !settable.has(command.key)) return;
        (this.car as unknown as Record<string, unknown>)[command.key] = command.value;
        return;
      }
      case "call": {
        if (!this.car || !callable.has(command.name)) return;
        const method = (this.car as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[command.name];
        method?.apply(this.car, command.args);
        if (command.epoch !== undefined) {
          this.epoch = command.epoch;
          // The car stands where it was put: the page sees it there before the next tick
          this.accumulatorS = 0;
          this.report(true);
        }
        return;
      }
      case "steeringAssist":
        if (this.car) this.car.steeringAssist.settings = command.settings;
        return;
      case "inputs": {
        const i = command.inputs;
        this.inputs = i;
        this.pressed.shiftUp ||= i.shiftUp === true;
        this.pressed.shiftDown ||= i.shiftDown === true;
        this.pressed.neutral ||= i.neutral === true;
        this.pressed.toggleXMode ||= i.toggleXMode === true;
        this.driving = true;
        return;
      }
      case "hold":
        this.driving = false;
        this.accumulatorS = 0;
        return;
      case "perf":
        // Timed by the worker's entry (sim-worker.ts), which owns the clock
        return;
      case "race":
        this.handleRace(command);
        return;
    }
  }

  private handleRace(command: RaceCommand): void {
    const car = this.car;
    const track = this.track;
    if (!car || !track) return;
    switch (command.op) {
      case "prepare": {
        // Built while the page shows its menus: the cars' settles and plans happen here, not at the start
        if (this.spare?.car === car && this.spare.opponents === command.opponents) {
          if (this.spare.field.skill !== command.skill) this.spare.field.setSkill(command.skill);
          return;
        }
        this.spare = { ...this.buildField(car, command.opponents, command.skill), car, opponents: command.opponents };
        return;
      }
      case "start": {
        // A restart takes the field of the race running, as a restart on the page does; else the one built ahead
        const running = this.race;
        this.endRace();
        const spare = this.spare;
        const reuse = command.seed === undefined;
        let built: { field: AiOpponentField; env: TrackEnvironment };
        if (reuse && running?.opponents === command.opponents) built = running;
        else if (reuse && spare?.car === car && spare.opponents === command.opponents) {
          built = spare;
          this.spare = null;
        } else built = this.buildField(car, command.opponents, command.skill, command.seed);
        const { field, env } = built;
        if (field.skill !== command.skill) field.setSkill(command.skill);
        env.setSimRealism(command.realism);
        // The page's weather before the start (the cars plan their first laps on its grip) and again after the start's
        // reset of the road: a change of conditions starts the road over from the page's
        env.applyWeatherSync(command.weather);
        const setup = command.setup;
        field.raceLaps = setup.laps;
        field.gridOrder = setup.gridOrder;
        field.playerGrid = setup.playerGrid;
        field.damageLevel = setup.damage;
        field.aggressionAdd = setup.aggressionAdd;
        field.playerDriver = setup.driver;
        field.manualStart = setup.standing && setup.manualStart === true;
        field.lockAidsInYellow = setup.lockAidsInYellow ?? true;
        field.qualifying = setup.qualifying;
        field.startRace(setup.standing);
        env.applyWeatherSync(command.weather);
        const ownRaceControl = car.raceControl;
        // The player's overtaking aids follow the race rules (the page wires its own car's the same way)
        if (car.overtakingRules) {
          car.raceControl = {
            get racing() {
              return field.raceRulesActive;
            },
            get aidsLocked() {
              return field.aidsLockedFor(car);
            },
            earnedAtDetection: () => field.detectionEarnedFor(car),
          };
        }
        this.race = { id: command.race, epoch: 0, opponents: command.opponents, field, env, tick: 0, steps: 0, fresh: true, poses: null, sentPhase: "", sentLights: -1, sentRolling: false, rosterSent: false, ownRaceControl };
        this.epoch = command.epoch;
        this.accumulatorS = 0;
        this.reportRace(true);
        this.report(true);
        return;
      }
      case "skill":
        this.race?.field.setSkill(command.skill);
        return;
      case "penalty":
        if (this.race) {
          this.race.field.playerPenaltyS = command.seconds;
          if (command.dq) this.race.field.playerDisqualified = true;
        }
        return;
      case "rules":
        if (this.race) this.race.field.lockAidsInYellow = command.lockAidsInYellow;
        return;
      case "penalise":
        this.race?.field.penalisePlayer(command.seconds, command.reason, command.detail);
        return;
      case "conditions":
        this.race?.env.setConditions(command.conditions);
        return;
      case "realism":
        this.race?.env.setSimRealism(command.flags);
        return;
      case "restore":
        if (this.race) {
          this.race.field.restoreField(command.poses, command.rewindS);
          this.race.epoch = command.epoch ?? this.race.epoch;
          this.race.tick = 0;
          this.race.fresh = true;
          this.accumulatorS = 0;
          this.reportRace(true);
          this.report(true);
        }
        return;
      case "end":
        this.endRace();
        return;
    }
  }

  /** A field of `opponents` AI cars round `car`, with a track environment of its own */
  private buildField(car: SimulatorCar, opponents: number, skill: number, seed?: number): { field: AiOpponentField; env: TrackEnvironment } {
    const track = this.track as BuiltTrackData;
    const env = new TrackEnvironment(track);
    const field = new AiOpponentField(track, car, aiDriversFor(opponents), env, { skill, seed });
    if (this.trackRoot) field.attachTrackRoot(this.trackRoot);
    return { field, env };
  }

  private endRace(): void {
    const race = this.race;
    if (!race) return;
    this.race = null;
    if (this.car) {
      this.car.raceControl = race.ownRaceControl;
      this.car.gridHold = false;
      this.car.aiSpeedCapMs = Infinity;
      this.car.aiLineBiasM = 0;
    }
  }

  /** Whether the clock is running (the page is driving the car) */
  get running(): boolean {
    return this.driving && this.car !== null;
  }

  /** Whether an AI race is currently running inside this runtime */
  get inRace(): boolean {
    return this.race !== null;
  }

  /** Stops the clock without a command: the page has gone quiet (a hidden tab, a stalled frame loop) */
  hold(): void {
    this.driving = false;
    this.accumulatorS = 0;
  }

  /**
   * Advances by `dtS` of wall-clock time: whole ticks, the rest carried over. Reports the state if any tick ran.
   * Returns the ticks run
   */
  advance(dtS: number): number {
    const car = this.car;
    if (!car || !this.driving || !(dtS > 0)) return 0;
    const race = this.race;
    this.accumulatorS = Math.min(this.accumulatorS + dtS, race ? MAX_CATCH_UP_RACE_S : MAX_CATCH_UP_S);
    let ticks = 0;
    while (this.accumulatorS >= SIM_TICK_S) {
      this.accumulatorS -= SIM_TICK_S;
      const p = this.pressed;
      const held = this.inputs;
      // A press is one tick long: the car sees one edge however many ticks the frame that sent it spans
      const inputs =
        p.shiftUp || p.shiftDown || p.neutral || p.toggleXMode || held.shiftUp || held.shiftDown || held.neutral || held.toggleXMode
          ? { ...held, shiftUp: p.shiftUp, shiftDown: p.shiftDown, neutral: p.neutral, toggleXMode: p.toggleXMode }
          : held;
      p.shiftUp = p.shiftDown = p.neutral = p.toggleXMode = false;
      // A race steps as the page steps one: the road under every car, then the player's car (held on the grid
      // until the lights go out), then the field; the field and the road every FIELD_TICKS ticks
      const fieldDtS = FIELD_TICKS * SIM_TICK_S;
      if (race && race.tick === 0) race.env.update(fieldDtS, race.field.sims());
      // A manual start holds the car on the grid through the lights with its engine live; an assisted one stops it
      const frozen = race?.field.playerFrozen === true;
      const onGrid = frozen && race!.field.manualStart && !race!.field.gridStanding;
      if (race) car.gridHold = onGrid;
      if (!frozen || onGrid) {
        car.step(SIM_TICK_S, inputs);
        const samples = car.telemetry.ffbSubframeSamples;
        if (samples) for (const s of samples) this.ffb.push(s);
      }
      if (race && ++race.tick === FIELD_TICKS) {
        race.tick = 0;
        race.field.update(fieldDtS);
        race.steps++;
        race.fresh = true;
        this.reportRace(false);
      }
      ticks++;
    }
    if (ticks > 0) this.report(false);
    return ticks;
  }

  /** The race's standing to the page, a few times a second and whenever the lights change */
  private reportRace(force: boolean): void {
    const race = this.race;
    const car = this.car;
    if (!race || !car) return;
    const field = race.field;
    const lightsChanged =
      field.phase !== race.sentPhase ||
      field.lightsOn !== race.sentLights ||
      field.isRollingFormation !== race.sentRolling;
    const weatherDue = force || race.steps % WEATHER_EVERY === 0;
    if (!force && !lightsChanged && !weatherDue && race.steps % STATUS_EVERY !== 0) return;
    race.sentPhase = field.phase;
    race.sentLights = field.lightsOn;
    race.sentRolling = field.isRollingFormation;
    const sample = race.env.weatherSampleFor(car);
    const event: Extract<SimEvent, { type: "race" }> = {
      type: "race",
      car: this.carNumber,
      race: race.id,
      epoch: race.epoch,
      status: field.status(),
      frozen: field.playerFrozen,
      rulesActive: field.raceRulesActive,
      road: { wetness: sample ? sample.wetness : null, spray: sample?.sprayIntensity ?? 0, rubber: race.env.trackEvolution.meanRacingLineRubber() },
    };
    if (!race.rosterSent) {
      race.rosterSent = true;
      event.roster = field.aiSlots().map(({ peer }) => ({ peerId: peer.peerId, driverCode: peer.driverCode, teamColorHex: peer.teamColorHex, vehicle: peer.vehicle }));
    }
    if (weatherDue) event.weather = race.env.weather.snapshot();
    this.emit(event);
  }

  private report(withTelemetry: boolean): void {
    const car = this.car;
    if (!car) return;
    const event: Extract<SimEvent, { type: "state" }> = {
      type: "state",
      car: this.carNumber,
      epoch: this.epoch,
      wallMs: 0,
      leadS: this.accumulatorS,
      state: captureCarState(car, this.state),
      ffb: this.ffb,
    };
    const race = this.race;
    if (race?.fresh) {
      race.fresh = false;
      race.poses = packFieldPoses(race.field.aiSlots(), race.poses);
      event.field = { race: race.id, epoch: race.epoch, ageS: race.tick * SIM_TICK_S, poses: race.poses };
    }
    if (withTelemetry || this.statesSent++ % TELEMETRY_EVERY_STATES === 0) {
      const telemetry: Record<string, unknown> = { ...car.telemetry };
      for (const key of PAGE_OWNED_TELEMETRY) delete telemetry[key];
      event.telemetry = telemetry;
    }
    this.emit(event);
    this.ffb = [];
  }
}
