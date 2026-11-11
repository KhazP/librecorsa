/**
 * The podium shot between the chequered flag and the results table: once the top three are known, about six seconds
 * of their cars parked side by side on the start/finish straight (P1 in the middle), under a slow camera move, with
 * their names and places over it. A visual only: the real cars carry on cooling down out of sight (the drawn ones are
 * moved, never the physics), and anything it needs that is missing sends the player straight to the table.
 */
import * as THREE from "three";
import type { CarTelemetry, RaceResultEntry, RaceStatus } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";
import type { InterpolatedPeerState } from "@/lib/sim/multiplayer-sync";
import type { GroundHit, GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";
import type { SimCarRig } from "@/lib/car-builder-2026";
import type { WheelSeating } from "@/lib/render/corner-rig";
import { seatContactShadow } from "@/lib/render/contact-shadow";
import { OVERLAY_LAYER } from "@/lib/render/layers";

/** How long the shot runs (s) */
export const PODIUM_SHOT_S = 6;
/** How long the shot waits for the top three to be known after the player's flag (s); then straight to the table */
export const PODIUM_WAIT_S = 30;
/** Centre-to-centre spacing of the parked cars (m), less on a narrow straight */
const SLOT_SPACING_M = 4.2;
/** Narrower than this (m) three cars do not fit side by side */
const MIN_SPACING_M = 2.7;
/** Vertical field of view of the shot (°) */
const SHOT_FOV_DEG = 38;
/** Half the width the shot keeps in frame round the centre car (m): three cars and some air */
const FRAME_HALF_M = 7;

export interface PodiumRow {
  position: number;
  driverCode: string;
  name: string;
  teamColorHex: string;
  isPlayer: boolean;
}

/** idle: no race result; waiting: the player is in, the top three not yet; playing: the shot; done: the table */
export type PodiumStage = "idle" | "waiting" | "playing" | "done";

export interface PodiumUi {
  stage: PodiumStage;
  /** The cars on the podium, P1 first (empty unless the shot plays) */
  rows: readonly PodiumRow[];
}

const finishedRow = (r: RaceResultEntry) => r.finishTimeS !== null && !r.dnf;

/**
 * The top three once they are known: the first three places have all taken the flag, or the classification is final
 * (then whoever finished in the top three). Null while one of them is still running.
 */
export function podiumCue(race: Pick<RaceStatus, "results" | "resultsFinal"> | undefined): PodiumRow[] | null {
  const results = race?.results;
  if (!results?.length) return null;
  const top = [...results].sort((a, b) => a.position - b.position).slice(0, 3);
  if (!race?.resultsFinal && !top.every(finishedRow)) return null;
  const rows = top.filter(finishedRow).map(({ position, driverCode, name, teamColorHex, isPlayer }) => ({
    position,
    driverCode,
    name,
    teamColorHex,
    isPlayer,
  }));
  return rows.length > 0 ? rows : null;
}

/**
 * When the shot plays, per race on track: waits after the player's flag for the top three, plays once, then hands
 * over to the table. A new run (restart, a new race) starts it over. No three.js: the verify suite drives it.
 */
export class PodiumFlow {
  stage: PodiumStage = "idle";
  rows: readonly PodiumRow[] = [];
  private runKey: number | null = null;
  private waitS = 0;
  private playS = 0;

  /** Seconds into the shot (0..PODIUM_SHOT_S) */
  get elapsedS(): number {
    return this.playS;
  }

  /**
   * One frame. `tryStart` builds the shot for the top three and says whether it could; `allowed` false (VR, a replay)
   * goes straight to the table. Returns true when the stage changed.
   */
  step(race: RaceStatus | undefined, runKey: number, dt: number, allowed: boolean, tryStart: (rows: PodiumRow[]) => boolean): boolean {
    const before = this.stage;
    if (runKey !== this.runKey || !race?.results) {
      this.runKey = runKey;
      this.stage = "idle";
      this.rows = [];
      this.waitS = 0;
      this.playS = 0;
    }
    // Out of the race (a wreck): the table at once, rather than a wait for the others with nothing on screen
    if (this.stage === "idle" && race?.results) this.stage = race.results.some((r) => r.isPlayer && r.dnf) ? "done" : "waiting";
    if (this.stage === "waiting") {
      this.waitS += dt;
      const cue = podiumCue(race);
      if (!allowed) this.stage = "done";
      else if (cue) {
        if (tryStart(cue)) {
          this.stage = "playing";
          this.rows = cue;
          this.playS = 0;
        } else this.stage = "done";
      } else if (this.waitS > PODIUM_WAIT_S) this.stage = "done";
    } else if (this.stage === "playing") {
      this.playS = Math.min(PODIUM_SHOT_S, this.playS + dt);
      if (!allowed || this.playS >= PODIUM_SHOT_S) this.stage = "done";
    }
    if (this.stage !== "playing" && before === "playing") this.rows = [];
    return this.stage !== before;
  }

  /** Any key or tap: straight to the table */
  skip(): boolean {
    if (this.stage !== "playing") return false;
    this.stage = "done";
    this.rows = [];
    return true;
  }
}

export interface PodiumSlot {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** Where the shot is set: the centre car's pose, the straight's forward and the car's left (world) */
export interface PodiumSet {
  slots: PodiumSlot[];
  centre: THREE.Vector3;
  forward: THREE.Vector3;
  left: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);
const groundHit = {} as GroundHit;

/**
 * Three parking places on the start/finish straight at the front of the grid, side by side across the road: P1 on
 * the centre line, P2 on the cars' right (the left as the camera in front sees them), P3 on their left. Seated on the
 * track collider where there is one. Null when the road is too narrow or the circuit gives no usable pose.
 */
export function podiumSet(track: Pick<BuiltTrackData, "totalLengthM" | "getSampleAtDistance" | "spawnGrid">, ground: GroundQuery | null): PodiumSet | null {
  const L = track.totalLengthM;
  if (!(L > 0)) return null;
  const pole = track.spawnGrid[0];
  const s = pole && Number.isFinite(pole.s) ? pole.s : L - 30;
  const sample = track.getSampleAtDistance(((s % L) + L) % L);
  const forward = new THREE.Vector3(sample.tangent.x, 0, sample.tangent.z);
  if (!(forward.lengthSq() > 1e-6)) return null;
  forward.normalize();
  const yaw = Math.atan2(forward.x, forward.z);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
  // Model +X is the car's left
  const left = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
  const spacing = Math.min(SLOT_SPACING_M, sample.width / 2 - 1.2);
  if (!(spacing >= MIN_SPACING_M)) return null;
  const centre = sample.position.clone();
  const seat = (p: THREE.Vector3): THREE.Vector3 | null => {
    if (ground?.query(p.x, p.z, p.y + 4, groundHit)) p.y = groundHit.height;
    return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
  };
  const places = [0, -1, 1].map((side) => seat(centre.clone().addScaledVector(left, side * spacing)));
  if (places.some((p) => p === null)) return null;
  const slots = (places as THREE.Vector3[]).map((position) => ({ position, quaternion: quaternion.clone() }));
  return { slots, centre: slots[0].position.clone(), forward, left };
}

/**
 * The camera at `u` (0..1) through the shot: in front of the cars, drifting across from their right to their left,
 * closing in and rising a little, always on the centre car. Further back on a narrow screen so all three stay in frame.
 */
export function podiumCameraAt(set: PodiumSet, u: number, aspect: number, outPos: THREE.Vector3, outLook: THREE.Vector3): void {
  const e = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);
  const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(SHOT_FOV_DEG / 2)) * Math.max(0.2, aspect));
  const fit = Math.max(1, FRAME_HALF_M / Math.tan(halfH) / 13);
  const dist = (16 - 4 * e) * fit;
  // The drift across stays within the road whatever the distance
  const across = -3.8 + 7.6 * e;
  const height = 1.3 + 0.9 * e;
  outPos.copy(set.centre).addScaledVector(set.forward, dist).addScaledVector(set.left, across).addScaledVector(UP, height);
  outLook.copy(set.centre).addScaledVector(UP, 0.7);
}

/** A peer drawn somewhere it is not: still, solid, its wheels at rest */
const stillPeer = (p: InterpolatedPeerState, position: THREE.Vector3, quaternion: THREE.Quaternion): InterpolatedPeerState => ({
  ...p,
  position,
  quaternion,
  linearVelocity: new THREE.Vector3(),
  steerAngle: 0,
  wheelRPMs: [0, 0, 0, 0],
  throttle: 0,
  brake: 0,
  speedKmh: 0,
  rpm: undefined,
  gear: undefined,
  ghost: false,
  passThrough: false,
  contact: false,
  wheels: p.wheels ? { ground: p.wheels.ground } : undefined,
});

/** The race car of a podium row among the cars drawn: by code, then by name; null when not one car */
export function podiumPeerFor(row: PodiumRow, peers: readonly InterpolatedPeerState[]): InterpolatedPeerState | null {
  const byCode = peers.filter((p) => !p.ghost && p.driverCode === row.driverCode);
  if (byCode.length === 1) return byCode[0];
  const byName = byCode.filter((p) => (p.name ?? p.driverCode) === row.name);
  return byName.length === 1 ? byName[0] : null;
}

/**
 * The shot on the drive's scene: the flow, the parked poses, the drawn cars and the camera, and the snapshot the
 * overlay reads (subscribe / getSnapshot, as the drive's own).
 */
export class PodiumDirector {
  private readonly flow = new PodiumFlow();
  private set: PodiumSet | null = null;
  /** Podium slot of each remote or AI car on it (by peer id), and the player's */
  private readonly peerSlot = new Map<string, PodiumSlot>();
  private playerSlot: PodiumSlot | null = null;
  private playerHidden = false;
  private ui: PodiumUi = { stage: "idle", rows: [] };
  private readonly listeners = new Set<() => void>();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly seating: WheelSeating = { ground: null, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

  constructor(
    private readonly track: Pick<BuiltTrackData, "totalLengthM" | "getSampleAtDistance" | "spawnGrid">,
    /** The shot has ended (played out or skipped): the drive's cameras start over */
    private readonly onEnd: () => void
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): PodiumUi => this.ui;

  get playing(): boolean {
    return this.flow.stage === "playing";
  }

  /**
   * Once a frame, after the race status is current. `allowed`: the shot may play (not in VR, not in a replay);
   * `peers`: the cars drawn this frame, to find the top three among
   */
  update(f: {
    race: RaceStatus | undefined;
    runKey: number;
    dt: number;
    allowed: boolean;
    peers: readonly InterpolatedPeerState[];
    ground: GroundQuery | null;
  }): void {
    const wasPlaying = this.playing;
    let changed = false;
    try {
      changed = this.flow.step(f.race, f.runKey, f.dt, f.allowed, (rows) => this.build(rows, f.peers, f.ground));
      // A car on the podium gone from the race (its player left): the table instead
      if (this.playing && [...this.peerSlot.keys()].some((id) => !f.peers.some((p) => p.peerId === id))) changed = this.flow.skip() || changed;
    } catch (err) {
      console.warn("[podium] shot dropped", err);
      changed = this.flow.skip() || changed;
      if (this.flow.stage === "waiting") this.flow.stage = "done";
    }
    if (wasPlaying && !this.playing) this.finish();
    if (changed) this.publish();
  }

  /** Any key or tap during the shot */
  skip(): void {
    if (!this.flow.skip()) return;
    this.finish();
    this.publish();
  }

  /** The cars to draw this frame: during the shot the podium cars parked, every other car out of sight */
  drawPeers(peers: InterpolatedPeerState[]): InterpolatedPeerState[] {
    if (!this.playing) return peers;
    return peers.map((p) => {
      const slot = this.peerSlot.get(p.peerId);
      if (slot) return stillPeer(p, slot.position, slot.quaternion);
      return stillPeer(p, p.position.clone().setY(p.position.y - 1000), p.quaternion);
    });
  }

  /** After the drive has drawn the player's car: parks it on the podium during the shot, or hides it when off it */
  drawPlayer(rig: SimCarRig, telemetry: CarTelemetry, ground: GroundQuery | null, dt: number): void {
    if (!this.playing) {
      if (this.playerHidden) rig.root.visible = true;
      this.playerHidden = false;
      return;
    }
    const slot = this.playerSlot;
    if (!slot) {
      rig.root.visible = false;
      this.playerHidden = true;
      return;
    }
    rig.root.position.copy(slot.position);
    rig.root.quaternion.copy(slot.quaternion);
    rig.chassisGroup.position.y = 0;
    const seat = this.seating;
    seat.ground = ground;
    seat.position.copy(slot.position);
    seat.quaternion.copy(slot.quaternion);
    const still: CarTelemetry = { ...telemetry, speedKmh: 0, throttle: 0, brake: 0, steering: 0 };
    rig.updateFromTelemetry(still, 0, 0, 0, dt, seat);
    seatContactShadow(rig.root, seat);
  }

  /** Places the camera during the shot; false otherwise (the drive's own cameras then run) */
  placeCamera(camera: THREE.PerspectiveCamera): boolean {
    const set = this.set;
    if (!this.playing || !set) return false;
    podiumCameraAt(set, this.flow.elapsedS / PODIUM_SHOT_S, camera.aspect, this.camPos, this.camLook);
    camera.position.copy(this.camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.camLook);
    // No driving aids (the racing line) in the shot; the drive's onEnd puts them back
    camera.layers.disable(OVERLAY_LAYER);
    if (camera.fov !== SHOT_FOV_DEG) {
      camera.fov = SHOT_FOV_DEG;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  /** Where the shot is, for what follows the camera (the reflections); null when not playing */
  get focus(): THREE.Vector3 | null {
    return this.playing && this.set ? this.set.centre : null;
  }

  private build(rows: PodiumRow[], peers: readonly InterpolatedPeerState[], ground: GroundQuery | null): boolean {
    const set = podiumSet(this.track, ground);
    if (!set) return false;
    this.peerSlot.clear();
    this.playerSlot = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const slot = set.slots[i];
      if (row.isPlayer) {
        this.playerSlot = slot;
        continue;
      }
      const peer = podiumPeerFor(row, peers);
      if (!peer || this.peerSlot.has(peer.peerId)) return false;
      this.peerSlot.set(peer.peerId, slot);
    }
    this.set = set;
    return true;
  }

  private finish(): void {
    this.peerSlot.clear();
    this.playerSlot = null;
    this.set = null;
    this.onEnd();
  }

  private publish(): void {
    this.ui = { stage: this.flow.stage, rows: this.flow.rows };
    for (const listener of this.listeners) listener();
  }
}
