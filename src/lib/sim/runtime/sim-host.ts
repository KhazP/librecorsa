/**
 * The page's end of the simulation: gives the game a stand-in for the player's car (`remote-car.ts`) and decides,
 * frame by frame, whether the simulation behind the transport drives it or the page does.
 *
 * The transport is the worker (`worker-sim-host.ts`), or for the headless checks a `SimRuntime` in the same thread
 * whose every message is cloned as `postMessage` would (`loopbackTransport`).
 */
import type * as THREE from "three";
import type { VehicleModelId } from "@/types/f1";
import { lc26OnRigidBody } from "@/lib/cars/lc26-engine";
import { getActiveTrackSource } from "@/lib/track-data";
import type { SimulatorCar } from "../simulator-car";
import { trackColliderData } from "../track-colliders";
import { createRemoteCar, type RemoteCar } from "./remote-car";
import type { RaceCommand, SimCommand, SimEvent } from "./sim-protocol";
import { SimRuntime } from "./sim-runtime";

export interface SimTransport {
  post(command: SimCommand): void;
  /** Calls `listener` with every event from the simulation; returns the unsubscribe */
  listen(listener: (event: SimEvent) => void): () => void;
  dispose(): void;
}

export interface SimHost {
  /**
   * The car to hand to the game in place of `twin` (the page's own car of that model). `trackRoot`: the circuit's
   * loaded mesh when the twin was built on it already (a root loaded later reaches the car's `attachTrackRoot`).
   * `bodyPlan`: the plan of another body the car wears, as the twin was given it
   */
  adopt(
    twin: SimulatorCar,
    vehicle: VehicleModelId,
    trackRoot?: THREE.Object3D | null,
    bodyPlan?: readonly (readonly [number, number])[]
  ): SimulatorCar;
  /**
   * Once per frame, after the frame's step: the simulation behind the transport drives the adopted car when
   * `wantRemote` and it is able to, else the page does
   */
  endFrame(wantRemote: boolean): void;
  /** The simulation behind the transport is driving the adopted car */
  readonly remote: boolean;
  /**
   * The way to an AI race in the simulation behind the transport, round the adopted car (one still being made there
   * included): null when the simulation failed
   */
  raceLink(): SimRaceLink | null;
  dispose(): void;
}

/** An AI race's line to the simulation behind the transport, for one adopted car (`worker-ai-field.ts`) */
export interface SimRaceLink {
  post(command: RaceCommand): void;
  /** Calls `listener` with the simulation's events about this car (states and the race's own); returns the unsubscribe */
  listen(listener: (event: SimEvent) => void): () => void;
  /** `RemoteCar.placeTwin` of the adopted car, which the simulation then drives (`setRemote`) */
  placeTwin(place: (twin: SimulatorCar) => void): number;
  /** The simulation failed, or the car has been replaced: the race cannot go on there */
  readonly failed: boolean;
  /** The time the frame is drawn for, on the clock the simulation stamps its states with */
  wallNowMs(): number;
}

const pageWallNowMs = () => performance.timeOrigin + performance.now();

/**
 * `wallNowMs`: the time the frame is drawn for, on the clock the transport's simulation stamps its states with (the
 * worker's and the page's agree). The game passes its frames' timestamps; the default reads the clock
 */
export function createSimHost(transport: SimTransport, wallNowMs: () => number = pageWallNowMs): SimHost {
  let carNumber = 0;
  let current: RemoteCar | null = null;
  let trackSent = false;
  const sentRoots = new WeakSet<THREE.Object3D>();
  const raceListeners = new Set<(event: SimEvent) => void>();
  const unlisten = transport.listen((event) => {
    // An event about a car that has since been replaced is dropped
    if ((event.type === "ready" || event.type === "state" || event.type === "race") && event.car !== carNumber) return;
    if (event.type !== "race") current?.receive(event);
    if (event.type === "state" || event.type === "race" || event.type === "error") for (const listener of raceListeners) listener(event);
  });
  return {
    adopt(twin, vehicle, trackRoot, bodyPlan) {
      const mine = ++carNumber;
      const sendColliders = (root: THREE.Object3D) => {
        if (sentRoots.has(root)) return;
        sentRoots.add(root);
        transport.post({ type: "colliders", data: trackColliderData(root) });
      };
      current = createRemoteCar(
        twin,
        {
          post: (command) => {
            if (mine === carNumber) transport.post(command);
          },
          sendColliders,
        },
        wallNowMs
      );
      if (trackRoot) sendColliders(trackRoot);
      // Before anything the game sets on the car: its commands follow, so the simulation's car is set up alike
      transport.post({
        type: "init",
        car: mine,
        track: trackSent ? undefined : getActiveTrackSource(),
        vehicle,
        ...(bodyPlan ? { bodyPlan: bodyPlan.map(([x, z]) => [x, z] as [number, number]) } : {}),
        lc26Rigid: lc26OnRigidBody(),
      });
      trackSent = true;
      return current.car;
    },
    endFrame(wantRemote) {
      if (!current) return;
      // (a car not ready yet stays as it is: the page's, or held for the worker by a race it placed)
      if (!wantRemote) current.setRemote(false);
      else if (current.ready) current.setRemote(true);
      current.endFrame();
    },
    get remote() {
      return current?.remote ?? false;
    },
    raceLink() {
      const car = current;
      const mine = carNumber;
      // A car the worker is still making will do: the race's start waits behind it, and its car with it
      if (!car || car.failed) return null;
      return {
        post: (command) => {
          if (mine === carNumber) transport.post(command);
        },
        listen: (listener) => {
          raceListeners.add(listener);
          return () => raceListeners.delete(listener);
        },
        // The worker drives the car from the start of the race: the twin is fresh on the grid, so it can take it at once
        placeTwin: (place) => {
          const epoch = car.placeTwin(place);
          car.setRemote(true);
          return epoch;
        },
        get failed() {
          return car.failed || mine !== carNumber;
        },
        wallNowMs,
      };
    },
    dispose() {
      raceListeners.clear();
      unlisten();
      transport.dispose();
      current = null;
    },
  };
}

/**
 * A simulation in this thread behind the same messages as the worker's: every command and event is cloned as
 * `postMessage` clones it, so anything that would not cross to a worker fails here too. `advance` is its clock.
 */
export function loopbackTransport(): { transport: SimTransport; runtime: SimRuntime; advance(dtS: number): void; wallNowMs(): number } {
  const listeners = new Set<(event: SimEvent) => void>();
  let wallMs = 0;
  const runtime = new SimRuntime((event) => {
    if (event.type === "state") event.wallMs = wallMs;
    const sent = structuredClone(event);
    for (const listener of listeners) listener(sent);
  });
  return {
    transport: {
      post: (command) => runtime.handle(structuredClone(command)),
      listen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => listeners.clear(),
    },
    runtime,
    advance: (dtS) => {
      wallMs += dtS * 1000;
      runtime.advance(dtS);
    },
    wallNowMs: () => wallMs,
  };
}
