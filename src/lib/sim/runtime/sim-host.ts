/**
 * The page's end of the simulation: gives the game a stand-in for the player's car (`remote-car.ts`) and decides,
 * frame by frame, whether the simulation behind the transport drives it or the page does.
 *
 * The transport is the worker (`worker-sim-host.ts`), or for the headless checks a `SimRuntime` in the same thread
 * whose every message is cloned as `postMessage` would (`loopbackTransport`).
 */
import type * as THREE from "three";
import type { VehicleModelId } from "@/types/f1";
import { vf26OnRigidBody } from "@/lib/cars/vf26-engine";
import { getActiveTrackSource } from "@/lib/track-data";
import type { SimulatorCar } from "../simulator-car";
import { trackColliderData } from "../track-colliders";
import { createRemoteCar, type RemoteCar } from "./remote-car";
import type { SimCommand, SimEvent } from "./sim-protocol";
import { SimRuntime } from "./sim-runtime";

export interface SimTransport {
  post(command: SimCommand): void;
  /** Calls `listener` with every event from the simulation; returns the unsubscribe */
  listen(listener: (event: SimEvent) => void): () => void;
  dispose(): void;
}

export interface SimHost {
  /** The car to hand to the game in place of `twin` (the page's own car of that model) */
  adopt(twin: SimulatorCar, vehicle: VehicleModelId): SimulatorCar;
  /**
   * Once per frame, after the frame's step: the simulation behind the transport drives the adopted car when
   * `wantRemote` and it is able to, else the page does
   */
  endFrame(wantRemote: boolean): void;
  /** The simulation behind the transport is driving the adopted car */
  readonly remote: boolean;
  dispose(): void;
}

const pageWallNowMs = () => performance.timeOrigin + performance.now();

/** `wallNowMs`: the clock the transport's simulation stamps its states with (the worker's and the page's agree) */
export function createSimHost(transport: SimTransport, wallNowMs: () => number = pageWallNowMs): SimHost {
  let carNumber = 0;
  let current: RemoteCar | null = null;
  let trackSent = false;
  const sentRoots = new WeakSet<THREE.Object3D>();
  const unlisten = transport.listen((event) => {
    // An event about a car that has since been replaced is dropped
    if ((event.type === "ready" || event.type === "state") && event.car !== carNumber) return;
    current?.receive(event);
  });
  return {
    adopt(twin, vehicle) {
      const mine = ++carNumber;
      current = createRemoteCar(twin, {
        post: (command) => {
          if (mine === carNumber) transport.post(command);
        },
        sendColliders: (root) => {
          if (sentRoots.has(root)) return;
          sentRoots.add(root);
          transport.post({ type: "colliders", data: trackColliderData(root) });
        },
      }, wallNowMs);
      // Before anything the game sets on the car: its commands follow, so the simulation's car is set up alike
      transport.post({ type: "init", car: mine, track: trackSent ? undefined : getActiveTrackSource(), vehicle, vf26Rigid: vf26OnRigidBody() });
      trackSent = true;
      return current.car;
    },
    endFrame(wantRemote) {
      if (!current) return;
      current.setRemote(wantRemote && current.ready);
      current.endFrame();
    },
    get remote() {
      return current?.remote ?? false;
    },
    dispose() {
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
