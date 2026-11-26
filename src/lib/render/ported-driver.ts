import * as THREE from "three";
import type { CarTelemetry } from "@/types/f1";
import { moveToDriverHeadLayer } from "./layers";

/**
 * The driver in a ported AC car (the GLB's `DRIVER` node, scripts/cars/ac_driver.py): a suit and gloves skinned to
 * the mod's skeleton, the helmet, face and neck brace on its bones, seated as the mod's car poses them.
 *
 * - The arms follow the steering wheel: the GLB's `steer` clip is the mod's steering animation, each key timed at the
 *   rim angle its hands show (0.5 + 0.5 angle / `clipLockDeg`, + = right), scrubbed each frame to the rim's angle.
 * - A gear change flexes the shifting hand's fingers (`shift_up` / `shift_dw`, added on top) over the times
 *   driver3d.ini gives.
 * - The head turns into a corner and leans with g, as driver3d.ini's HEAD_MOVEMENT sets it.
 * - From the driver's eye the nodes driver3d.ini hides (helmet, face) leave the view (`DRIVER_HEAD_LAYER`); the sun
 *   still draws their shadow.
 * - An opponent's driver is posed only while near (the LOD controller's level 0); past it the low-detail figure, at
 *   rest, stands in (`DRV_LOD`), and past the far reach nothing.
 */
export interface PortedDriverExtras {
  model: string;
  steer: {
    clip: string;
    /** driver3d.ini's LOCK */
    lockDeg: number;
    /** The rim's turn (deg) from the clip's centre to its far end: its keys are timed 0.5 + 0.5 angle / clipLockDeg */
    clipLockDeg: number;
    frames: number;
  } | null;
  shift: {
    blendMs: number;
    positiveMs: number;
    staticMs: number;
    negativeMs: number;
    invertHands: boolean;
    shift_up?: string[];
    shift_dw?: string[];
  } | null;
  /** Nodes left out of the driver's-eye view */
  hide: string[];
  head: { node: string; filter: number; maxG: number; rollDeg: number; pitchDeg: number; yawDeg: number } | null;
  lod: { node: string; model: string; draws: number } | null;
}

export interface PortedDriver {
  /**
   * Poses the driver for a frame: the arms to the steering wheel's angle (`rimDeg`, + = right), the fingers through a
   * shift, the head with the car's g
   */
  update(rimDeg: number, telemetry: CarTelemetry | null, dtSeconds: number): void;
  /**
   * An opponent's level: 0 the driver posed, 1 the low-detail figure at rest, 2 none. A player's driver stays at 0.
   */
  setLevel(level: 0 | 1 | 2): void;
  /** The full-detail figure's meshes (the opponent LOD controller leaves them unsimplified) */
  readonly fullDetail: readonly THREE.Object3D[];
  dispose(): void;
}

/** The DRIVER node's extras, or null for a model without a driver */
export function portedDriverExtras(node: THREE.Object3D | undefined | null): PortedDriverExtras | null {
  const extras = node?.userData as Partial<PortedDriverExtras> | undefined;
  return extras && Array.isArray(extras.hide) ? (extras as PortedDriverExtras) : null;
}

const SHIFT_CLIPS = { up: "shift_up", down: "shift_dw" } as const;
const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _pi = new THREE.Quaternion();
const _e = new THREE.Euler();

/**
 * Brings a ported car's `DRIVER` node to life. `clips` are the GLB's animations; `opponent` keeps it off the
 * driver-head layer (an opponent's helmet stays in the player's view) and lets `setLevel` hide it with distance.
 */
export function installPortedDriver(
  node: THREE.Object3D,
  clips: readonly THREE.AnimationClip[],
  options: { opponent: boolean }
): PortedDriver | null {
  const extras = portedDriverExtras(node);
  if (!extras) return null;
  const lod = extras.lod ? node.getObjectByName(extras.lod.node) ?? null : null;
  const fullDetail: THREE.Object3D[] = [];
  const skeletons = new Set<THREE.Skeleton>();
  node.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh || (lod && (o === lod || o.parent === lod))) return;
    fullDetail.push(mesh);
    if (mesh.isSkinnedMesh) {
      skeletons.add(mesh.skeleton);
      // Its bounds would be measured once from whatever pose its bones had; a driver is always inside its car
      mesh.frustumCulled = false;
    }
  });
  if (lod) lod.visible = false;
  if (!options.opponent) {
    for (const name of extras.hide) {
      const hidden = node.getObjectByName(name);
      if (hidden) moveToDriverHeadLayer(hidden);
    }
  }

  const mixer = new THREE.AnimationMixer(node);
  const steerClip = extras.steer ? clips.find((c) => c.name === extras.steer!.clip) : undefined;
  const steer = steerClip ? mixer.clipAction(steerClip) : null;
  if (steer) {
    steer.setLoop(THREE.LoopOnce, 1);
    steer.clampWhenFinished = true;
    steer.play();
    steer.paused = true;
    steer.time = 0.5;
  }
  const shiftAction = (name: string): THREE.AnimationAction | null => {
    const clip = clips.find((c) => c.name === name);
    if (!clip) return null;
    const a = mixer.clipAction(clip, undefined, THREE.AdditiveAnimationBlendMode);
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.play();
    a.paused = true;
    a.time = 0;
    a.weight = 0;
    return a;
  };
  const shifts = extras.shift ? { up: shiftAction(SHIFT_CLIPS.up), down: shiftAction(SHIFT_CLIPS.down) } : null;
  // The shift under way: its action and how long since it started (s)
  let shifting: { action: THREE.AnimationAction; t: number } | null = null;
  let lastGear: number | null = null;

  // Head movement: the head bone and its ancestors up to the driver node (their rotations give the head's frame)
  const head = extras.head ? node.getObjectByName(extras.head.node) ?? null : null;
  const headChain: THREE.Object3D[] = [];
  for (let o = head?.parent ?? null; o && o !== node; o = o.parent) headChain.unshift(o);
  // Its pose before the turn: the clip sets it again each frame where it animates the head, this where it doesn't
  const headRest = head?.quaternion.clone() ?? null;
  const headTurn = { yaw: 0, roll: 0, pitch: 0 };

  let level: 0 | 1 | 2 = 0;
  // Posed at least once after a return to full detail
  let posed = false;

  const update = (rimDeg: number, t: CarTelemetry | null, dtSeconds: number) => {
    if (level !== 0) return;
    const dt = Math.min(0.1, Math.max(0, dtSeconds));
    if (steer && extras.steer) {
      // The clip's times are rim angles (0.5 + 0.5 angle / clipLockDeg): its last key may come before 1
      const u = THREE.MathUtils.clamp(0.5 + (0.5 * rimDeg) / extras.steer.clipLockDeg, 0, 1);
      steer.time = Math.min(u, steer.getClip().duration);
    }
    if (shifts && extras.shift && t) {
      if (lastGear !== null && t.gear !== lastGear) {
        const action = t.gear > lastGear ? shifts.up : shifts.down;
        if (action) {
          if (shifting && shifting.action !== action) shifting.action.weight = 0;
          shifting = { action, t: 0 };
        }
      }
      lastGear = t.gear;
    }
    if (shifting && extras.shift) {
      // AC's shift: the animation forward over POSITIVE_TIME, held STATIC_TIME, back over NEGATIVE_TIME (from the
      // shift to this frame)
      const { positiveMs, staticMs, negativeMs } = extras.shift;
      shifting.t += dt;
      const ms = shifting.t * 1000;
      if (ms >= positiveMs + staticMs + negativeMs) {
        shifting.action.weight = 0;
        shifting = null;
      } else {
        const pos =
          ms < positiveMs ? ms / positiveMs : ms < positiveMs + staticMs ? 1 : 1 - (ms - positiveMs - staticMs) / negativeMs;
        shifting.action.weight = 1;
        shifting.action.time = THREE.MathUtils.clamp(pos, 0, 1) * shifting.action.getClip().duration;
      }
    }
    if (head && headRest) head.quaternion.copy(headRest);
    mixer.update(0);
    posed = true;

    if (head && extras.head && t) {
      // Into the corner and leaning out of it, forward under braking: each to its full angle at MAX_G, filtered
      const h = extras.head;
      const lat = THREE.MathUtils.clamp((t.lateralG || 0) / (h.maxG || 2), -1, 1);
      const lon = THREE.MathUtils.clamp((t.longitudinalG || 0) / (h.maxG || 2), -1, 1);
      const k = 1 - Math.exp(-dt / Math.max(0.02, h.filter || 0.15));
      headTurn.yaw += (-lat * Math.abs(h.yawDeg) - headTurn.yaw) * k;
      headTurn.roll += (-lat * Math.abs(h.rollDeg) - headTurn.roll) * k;
      headTurn.pitch += (-lon * Math.abs(h.pitchDeg) - headTurn.pitch) * k;
      // The turn in the car's axes (x left, y up, z forward), carried into the head's parent's frame
      _e.set(
        THREE.MathUtils.degToRad(headTurn.pitch),
        THREE.MathUtils.degToRad(headTurn.yaw),
        THREE.MathUtils.degToRad(headTurn.roll),
        "YXZ"
      );
      _q.setFromEuler(_e);
      _p.identity();
      for (const o of headChain) _p.multiply(o.quaternion);
      _q.premultiply(_pi.copy(_p).invert()).multiply(_p);
      head.quaternion.premultiply(_q);
    }
  };

  const setLevel = (next: 0 | 1 | 2) => {
    if (!options.opponent || next === level) return;
    level = next;
    for (const m of fullDetail) m.visible = next === 0;
    if (lod) lod.visible = next === 1;
    if (next === 0 && !posed) mixer.update(0);
  };

  return {
    update,
    setLevel,
    fullDetail,
    dispose: () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(node);
      for (const s of skeletons) s.dispose();
    },
  };
}
