/**
 * The AI cars of a race in the simulation worker, as the page draws them: the worker packs every car's pose, wheels
 * and tyres into one array after each step of its field (`packFieldPoses`), and the page unpacks it into the render
 * states the game draws AI cars from (`FieldPeers`), carried forward to the frame as the player's own car is.
 */
import * as THREE from "three";
import type { FieldCarRestorePose } from "../ai-race";
import type { GroundQuery } from "../f12026-car/TrackColliderQuery";
import type { InterpolatedPeerState } from "../multiplayer-sync";
import type { SimulatorCar, TyreVisualState } from "../simulator-car";
import type { RaceRosterEntry } from "./sim-protocol";

/** Numbers per car: pose (10), yaw rate, steer, wheel rpm (4), pedals, lap position, speed, rpm, gear, flags, tyres */
const TYRE = 10;
const TYRES_AT = 25;
export const FIELD_POSE_STRIDE = TYRES_AT + 4 * TYRE;

/** What the worker's field gives for each AI car (`AiOpponentField.aiSlots`) */
export interface FieldSlot {
  readonly peer: InterpolatedPeerState;
  readonly sim: SimulatorCar;
  readonly removed: boolean;
}

/** Packs every AI car into `out` (grown as needed); returns the array holding them */
export function packFieldPoses(slots: readonly FieldSlot[], out: Float64Array | null): Float64Array {
  const need = slots.length * FIELD_POSE_STRIDE;
  const a = out && out.length === need ? out : new Float64Array(need);
  for (let k = 0; k < slots.length; k++) {
    const { peer: p, sim, removed } = slots[k];
    const o = k * FIELD_POSE_STRIDE;
    a[o] = p.position.x;
    a[o + 1] = p.position.y;
    a[o + 2] = p.position.z;
    a[o + 3] = p.quaternion.x;
    a[o + 4] = p.quaternion.y;
    a[o + 5] = p.quaternion.z;
    a[o + 6] = p.quaternion.w;
    a[o + 7] = p.linearVelocity.x;
    a[o + 8] = p.linearVelocity.y;
    a[o + 9] = p.linearVelocity.z;
    a[o + 10] = sim.yawRateRadS;
    a[o + 11] = p.steerAngle;
    for (let i = 0; i < 4; i++) a[o + 12 + i] = p.wheelRPMs[i];
    a[o + 16] = p.throttle;
    a[o + 17] = p.brake;
    a[o + 18] = p.trackS;
    a[o + 19] = p.speedKmh;
    a[o + 20] = p.rpm ?? NaN;
    a[o + 21] = p.gear ?? NaN;
    a[o + 22] = p.contact ? 1 : 0;
    a[o + 23] = removed ? 1 : 0;
    const tyres = p.wheels?.tyres;
    a[o + 24] = tyres ? 1 : 0;
    if (!tyres) continue;
    for (let i = 0; i < 4; i++) {
      const t = tyres[i];
      const q = o + TYRES_AT + i * TYRE;
      a[q] = t.loadedRadiusM;
      a[q + 1] = t.verticalDeflectionM;
      a[q + 2] = t.lateralForceN;
      a[q + 3] = t.camberRad;
      a[q + 4] = t.carcassDeflectionXM ?? NaN;
      a[q + 5] = t.carcassDeflectionYM ?? NaN;
      a[q + 6] = t.contactInCar ? t.contactInCar.x : NaN;
      a[q + 7] = t.contactInCar ? t.contactInCar.y : NaN;
      a[q + 8] = t.contactInCar ? t.contactInCar.z : NaN;
      a[q + 9] = t.onRoad ? 1 : 0;
    }
  }
  return a;
}

const _up = new THREE.Vector3(0, 1, 0);
const _turn = new THREE.Quaternion();
const _predPos = new THREE.Vector3();
const _predQuat = new THREE.Quaternion();
const _deltaPos = new THREE.Vector3();
const _invQ = new THREE.Quaternion();
const _identQ = new THREE.Quaternion();
const blankTyre = (): TyreVisualState => ({ loadedRadiusM: 0, verticalDeflectionM: 0, lateralForceN: 0, camberRad: 0, onRoad: true });

/** Maximum position discrepancy smoothed out instead of snapped (m); larger jumps are teleports/resets */
const SMOOTH_MAX_ERR_M = 6.0;
/** Time constant for decaying residual worker jitter error (s) */
const SMOOTH_ERR_TAU_S = 0.055;

interface PeerSlot {
  readonly peer: InterpolatedPeerState;
  readonly tyres: [TyreVisualState, TyreVisualState, TyreVisualState, TyreVisualState];
  /** The pose as packed, which `shownAt` moves on from */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Last pose & velocity shown on screen, plus exponentially decayed prediction-error offset */
  readonly drawnPos: THREE.Vector3;
  readonly drawnQuat: THREE.Quaternion;
  readonly drawnVel: THREE.Vector3;
  drawnYawRate: number;
  readonly errPos: THREE.Vector3;
  readonly errQuat: THREE.Quaternion;
  hasDrawn: boolean;
  dirty: boolean;
  yawRate: number;
  removed: boolean;
}

/** The page's render states of the worker's AI cars */
export class FieldPeers {
  private readonly slots: PeerSlot[];
  private readonly shown: InterpolatedPeerState[] = [];
  private received = false;

  constructor(roster: readonly RaceRosterEntry[], ground: GroundQuery | null) {
    this.slots = roster.map((r) => {
      const tyres: PeerSlot["tyres"] = [blankTyre(), blankTyre(), blankTyre(), blankTyre()];
      return {
        peer: {
          peerId: r.peerId,
          driverCode: r.driverCode,
          teamColorHex: r.teamColorHex,
          vehicle: r.vehicle,
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
          linearVelocity: new THREE.Vector3(),
          steerAngle: 0,
          wheelRPMs: [0, 0, 0, 0],
          throttle: 0,
          brake: 0,
          trackS: 0,
          speedKmh: 0,
          isAiPeer: true,
          wheels: { tyres, ground },
        },
        tyres,
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        drawnPos: new THREE.Vector3(),
        drawnQuat: new THREE.Quaternion(),
        drawnVel: new THREE.Vector3(),
        drawnYawRate: 0,
        errPos: new THREE.Vector3(),
        errQuat: new THREE.Quaternion(),
        hasDrawn: false,
        dirty: false,
        yawRate: 0,
        removed: false,
      };
    });
  }

  get count(): number {
    return this.slots.length;
  }

  /** The worker's newest poses */
  apply(a: Float64Array): void {
    if (a.length !== this.slots.length * FIELD_POSE_STRIDE) return;
    this.received = true;
    for (let k = 0; k < this.slots.length; k++) {
      const s = this.slots[k];
      const p = s.peer;
      const o = k * FIELD_POSE_STRIDE;
      s.position.set(a[o], a[o + 1], a[o + 2]);
      s.quaternion.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6]);
      s.dirty = true;
      p.position.copy(s.position);
      p.quaternion.copy(s.quaternion);
      p.linearVelocity.set(a[o + 7], a[o + 8], a[o + 9]);
      s.yawRate = a[o + 10];
      p.yawRateRadS = s.yawRate;
      p.steerAngle = a[o + 11];
      for (let i = 0; i < 4; i++) p.wheelRPMs[i] = a[o + 12 + i];
      p.throttle = a[o + 16];
      p.brake = a[o + 17];
      p.trackS = a[o + 18];
      p.speedKmh = a[o + 19];
      p.rpm = Number.isNaN(a[o + 20]) ? undefined : a[o + 20];
      p.gear = Number.isNaN(a[o + 21]) ? undefined : a[o + 21];
      p.contact = a[o + 22] === 1;
      s.removed = a[o + 23] === 1;
      const wheels = p.wheels as { tyres?: readonly TyreVisualState[]; ground: GroundQuery | null };
      if (a[o + 24] !== 1) {
        wheels.tyres = undefined;
        continue;
      }
      wheels.tyres = s.tyres;
      for (let i = 0; i < 4; i++) {
        const t = s.tyres[i];
        const q = o + TYRES_AT + i * TYRE;
        t.loadedRadiusM = a[q];
        t.verticalDeflectionM = a[q + 1];
        t.lateralForceN = a[q + 2];
        t.camberRad = a[q + 3];
        t.carcassDeflectionXM = Number.isNaN(a[q + 4]) ? undefined : a[q + 4];
        t.carcassDeflectionYM = Number.isNaN(a[q + 5]) ? undefined : a[q + 5];
        if (Number.isNaN(a[q + 6])) t.contactInCar = undefined;
        else if (t.contactInCar) {
          t.contactInCar.x = a[q + 6];
          t.contactInCar.y = a[q + 7];
          t.contactInCar.z = a[q + 8];
        } else t.contactInCar = { x: a[q + 6], y: a[q + 7], z: a[q + 8] };
        t.onRoad = a[q + 9] === 1;
      }
    }
  }

  /** Immediately places the page's AI peers at their rewound Flashback poses so there is no single-frame snap */
  restorePoses(poses: readonly FieldCarRestorePose[]): void {
    const byId = new Map<string, FieldCarRestorePose>();
    for (const p of poses) byId.set(p.id, p);
    for (const s of this.slots) {
      const p = byId.get(s.peer.peerId);
      if (!p) continue;
      s.position.set(p.x, p.y, p.z);
      s.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      s.errPos.set(0, 0, 0);
      s.errQuat.identity();
      s.hasDrawn = false;
      s.dirty = false;
      s.yawRate = 0;
      s.peer.position.copy(s.position);
      s.peer.quaternion.copy(s.quaternion);
      s.peer.linearVelocity.set(0, 0, 0);
      s.peer.speedKmh = p.speedMs * 3.6;
      if (p.s !== undefined) s.peer.trackS = p.s;
    }
  }

  /** The poses already computed by the last `shownAt` call (idempotent within a frame and frozen while paused) */
  current(): InterpolatedPeerState[] {
    return this.received ? this.shown : [];
  }

  /**
   * The cars on the track, carried `leadS` on from the poses as packed (back, when it is negative: poses from after the
   * frame's time): the position with the car's velocity, the heading with its yaw rate, plus exponentially-decayed
   * jitter damping so late worker packets never snap backwards.
   */
  shownAt(leadS: number, dtS = 0): InterpolatedPeerState[] {
    const out = this.shown;
    out.length = 0;
    if (!this.received) return out;
    const lead = Number.isFinite(leadS) ? leadS : 0;
    const dt = dtS > 0 ? Math.min(dtS, 0.1) : 0;
    const decay = dt > 0 ? Math.exp(-dt / SMOOTH_ERR_TAU_S) : 0;
    for (const s of this.slots) {
      if (s.removed) continue;
      const p = s.peer;
      p.position.copy(s.position).addScaledVector(p.linearVelocity, lead);
      // Yaw rate is + to the right, a turn about the car's own up axis the other way
      p.quaternion.copy(s.quaternion).multiply(_turn.setFromAxisAngle(_up, -s.yawRate * lead));
      if (dt > 0) {
        if (s.dirty && s.hasDrawn) {
          // Compare where the car smoothly continued from last frame vs the new carried-forward worker pose.
          // On a steady stream this difference is 0 (zero lag); on a late packet it absorbs only the jump.
          // On barrier/car contact or sharp impact velocity change (> 3 m/s), snap cleanly so the car never clips into walls.
          const dvSq = s.drawnVel.distanceToSquared(p.linearVelocity);
          _predPos.copy(s.drawnPos).addScaledVector(s.drawnVel, dt);
          _deltaPos.subVectors(_predPos, p.position);
          const errSq = _deltaPos.lengthSq();
          if (!p.contact && dvSq <= 9 && errSq < SMOOTH_MAX_ERR_M * SMOOTH_MAX_ERR_M) {
            s.errPos.copy(_deltaPos);
            _predQuat.copy(s.drawnQuat).multiply(_turn.setFromAxisAngle(_up, -s.drawnYawRate * dt));
            s.errQuat.copy(_invQ.copy(p.quaternion).invert()).multiply(_predQuat);
            if (s.errQuat.w < 0) s.errQuat.set(-s.errQuat.x, -s.errQuat.y, -s.errQuat.z, -s.errQuat.w);
          } else {
            s.errPos.set(0, 0, 0);
            s.errQuat.identity();
          }
        }
        s.dirty = false;
        if (s.errPos.lengthSq() > 1e-8) {
          s.errPos.multiplyScalar(decay);
          s.errQuat.slerp(_identQ, 1 - decay);
          p.position.add(s.errPos);
          p.quaternion.multiply(s.errQuat);
        } else {
          s.errPos.set(0, 0, 0);
          s.errQuat.identity();
        }
      } else {
        s.dirty = false;
        s.errPos.set(0, 0, 0);
        s.errQuat.identity();
      }
      s.drawnPos.copy(p.position);
      s.drawnQuat.copy(p.quaternion);
      s.drawnVel.copy(p.linearVelocity);
      s.drawnYawRate = s.yawRate;
      s.hasDrawn = true;
      out.push(p);
    }
    return out;
  }
}
