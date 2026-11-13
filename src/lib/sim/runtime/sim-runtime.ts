/**
 * The simulation as the worker runs it: the player's car on the active circuit, driven by commands
 * (`sim-protocol.ts`) and advanced in whole 4 ms ticks, reporting its state after each advance.
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
import { blankCarState, captureCarState, PAGE_OWNED_TELEMETRY } from "./car-state";
import { CAR_CALLABLE, CAR_SETTABLE, SIM_TICK_S, type SimCommand, type SimEvent } from "./sim-protocol";

/** A stall longer than this is not caught up (s) */
const MAX_CATCH_UP_S = 0.25;
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
  private pressed = { shiftUp: false, shiftDown: false, toggleXMode: false };
  private driving = false;
  private accumulatorS = 0;
  private epoch = 0;
  private carNumber = 0;
  private statesSent = 0;
  private readonly state = blankCarState();
  private ffb: number[] = [];

  constructor(private readonly emit: (event: SimEvent) => void) {}

  /** The car being simulated (the headless checks read it) */
  get simulatedCar(): SimulatorCar | null {
    return this.car;
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
        this.car = vehicleModelSpec(command.vehicle).createSim(this.track, this.trackRoot);
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
        this.pressed.toggleXMode ||= i.toggleXMode === true;
        this.driving = true;
        return;
      }
      case "hold":
        this.driving = false;
        this.accumulatorS = 0;
        return;
    }
  }

  /** Whether the clock is running (the page is driving the car) */
  get running(): boolean {
    return this.driving && this.car !== null;
  }

  /** Stops the clock without a command: the page has gone quiet (a hidden tab, a stalled frame loop) */
  hold(): void {
    this.driving = false;
    this.accumulatorS = 0;
  }

  /** Advances by `dtS` of wall-clock time: whole ticks, the rest carried over. Reports the state if any tick ran */
  advance(dtS: number): void {
    const car = this.car;
    if (!car || !this.driving || !(dtS > 0)) return;
    this.accumulatorS = Math.min(this.accumulatorS + dtS, MAX_CATCH_UP_S);
    let ticks = 0;
    while (this.accumulatorS >= SIM_TICK_S) {
      this.accumulatorS -= SIM_TICK_S;
      const p = this.pressed;
      const held = this.inputs;
      // A press is one tick long: the car sees one edge however many ticks the frame that sent it spans
      const inputs = p.shiftUp || p.shiftDown || p.toggleXMode || held.shiftUp || held.shiftDown || held.toggleXMode
        ? { ...held, shiftUp: p.shiftUp, shiftDown: p.shiftDown, toggleXMode: p.toggleXMode }
        : held;
      p.shiftUp = p.shiftDown = p.toggleXMode = false;
      car.step(SIM_TICK_S, inputs);
      const samples = car.telemetry.ffbSubframeSamples;
      if (samples) for (const s of samples) this.ffb.push(s);
      ticks++;
    }
    if (ticks > 0) this.report(false);
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
    if (withTelemetry || this.statesSent++ % TELEMETRY_EVERY_STATES === 0) {
      const telemetry: Record<string, unknown> = { ...car.telemetry };
      for (const key of PAGE_OWNED_TELEMETRY) delete telemetry[key];
      event.telemetry = telemetry;
    }
    this.emit(event);
    this.ffb = [];
  }
}
