/**
 * The podium shot between the chequered flag and the results table: once the top three are known, about six seconds
 * of their cars parked side by side on the start/finish straight (P1 in the middle), under a slow camera move, with
 * their names and places over it. A visual only: the real cars carry on cooling down out of sight (the drawn ones are
 * moved, never the physics), and anything it needs that is missing sends the player straight to the table.
 *
 * After an offline AI race the full-screen podium follows it (hud/PodiumBoard.tsx, its data show/podium-board.ts): up
 * to half a minute of the top three and the top ten over the title screen's aerial tour of the circuit, until a key,
 * a pad button or a tap closes it. A shot that cannot be set up (a car not found, a road too narrow) goes straight to it.
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
import { AERIAL_SHOT_S, MenuAerial, type AerialPose } from "@/lib/render/menu-aerial";
import type { ShowContext } from "@/lib/show/show-context";

/** How long the shot runs (s) */
export const PODIUM_SHOT_S = 6;
/** How long the shot waits for the top three to be known after the player's flag (s); then straight to the table */
export const PODIUM_WAIT_S = 30;
/** How long the full-screen podium stays up unless closed (s) */
export const PODIUM_BOARD_S = 30;
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

/**
 * idle: no race result; waiting: the player is in, the top three not yet; playing: the shot; board: the full-screen
 * podium; done: the table
 */
export type PodiumStage = "idle" | "waiting" | "playing" | "board" | "done";

export interface PodiumUi {
  stage: PodiumStage;
  /** The cars on the podium, P1 first (empty unless the shot or the board is up) */
  rows: readonly PodiumRow[];
  /** The career round the race was (its rivals' names, the championship before it); null or absent otherwise */
  context?: ShowContext | null;
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
 * When the shot plays, per race on track: waits after the player's flag for the top three, plays once, then (when
 * `board` allows it) the full-screen podium, then hands over to the table. A restart or a new race (a frame with no
 * result) starts it over. No three.js: the verify suite drives it.
 */
export class PodiumFlow {
  stage: PodiumStage = "idle";
  rows: readonly PodiumRow[] = [];
  private waitS = 0;
  private playS = 0;
  private boardS = 0;
  /** The full-screen podium may follow the shot (as the last frame said) */
  private boardOk = false;

  /** Seconds into the shot (0..PODIUM_SHOT_S) */
  get elapsedS(): number {
    return this.playS;
  }

  /** Seconds into the full-screen podium (0..PODIUM_BOARD_S) */
  get boardElapsedS(): number {
    return this.boardS;
  }

  /**
   * One frame. `tryStart` builds the shot for the top three and says whether it could; `allowed` false (VR, a replay)
   * goes straight to the table; `board` lets the full-screen podium follow the shot (an offline AI race, the setting
   * on). Returns true when the stage changed.
   */
  step(race: RaceStatus | undefined, dt: number, allowed: boolean, tryStart: (rows: PodiumRow[]) => boolean, board = false): boolean {
    const before = this.stage;
    this.boardOk = board;
    // Over once the result is gone (a restart, a new race, leaving it)
    if (!race?.results) {
      this.stage = "idle";
      this.rows = [];
      this.waitS = 0;
      this.playS = 0;
      this.boardS = 0;
    }
    // Out of the race (a wreck): the table at once, rather than a wait for the others with nothing on screen
    if (this.stage === "idle" && race?.results) this.stage = race.results.some((r) => r.isPlayer && r.dnf) ? "done" : "waiting";
    if (this.stage === "waiting") {
      this.waitS += dt;
      const cue = podiumCue(race);
      if (!allowed) this.stage = "done";
      else if (cue) {
        this.rows = cue;
        if (tryStart(cue)) {
          this.stage = "playing";
          this.playS = 0;
        } else this.toBoard();
      } else if (this.waitS > PODIUM_WAIT_S) this.stage = "done";
    } else if (this.stage === "playing") {
      this.playS = Math.min(PODIUM_SHOT_S, this.playS + dt);
      if (!allowed) this.stage = "done";
      else if (this.playS >= PODIUM_SHOT_S) this.toBoard();
    } else if (this.stage === "board") {
      this.boardS = Math.min(PODIUM_BOARD_S, this.boardS + dt);
      if (!allowed || !board || this.boardS >= PODIUM_BOARD_S) this.stage = "done";
    }
    if (this.stage !== "playing" && this.stage !== "board") this.rows = [];
    return this.stage !== before;
  }

  /** Any key or tap: the shot on to the full-screen podium (or the table), the full-screen podium to the table */
  skip(): boolean {
    if (this.stage === "playing") this.toBoard();
    else if (this.stage === "board") this.stage = "done";
    else return false;
    if (this.stage === "done") this.rows = [];
    return true;
  }

  /** Straight to the table, whatever is up */
  stop(): boolean {
    if (this.stage !== "waiting" && this.stage !== "playing" && this.stage !== "board") return false;
    this.stage = "done";
    this.rows = [];
    return true;
  }

  private toBoard(): void {
    if (this.boardOk) {
      this.stage = "board";
      this.boardS = 0;
    } else this.stage = "done";
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

/** What the drive tells the podium each frame */
export interface PodiumFrame {
  race: RaceStatus | undefined;
  dt: number;
  /** The shot may play: not in VR, not in a replay */
  allowed: boolean;
  /** The full-screen podium may follow it: an offline AI race, the setting on */
  board?: boolean;
  /** The career round being raced (the pre-race show's context), for the full-screen podium's names */
  context?: ShowContext | null;
  /** The cars drawn this frame, to find the top three among */
  peers: readonly InterpolatedPeerState[];
  ground: GroundQuery | null;
}

/** How the full-screen podium's aerial is filmed: the scene's fog, and reduced motion (one held frame) */
export interface PodiumView {
  fogDensity: number;
  still: boolean;
}

/**
 * The shot on the drive's scene: the flow, the parked poses, the drawn cars and the camera, and the snapshot the
 * overlay reads (subscribe / getSnapshot, as the drive's own). Then, under the full-screen podium, the circuit from
 * the air (the title screen's aerial tour, from the start/finish line) with every car where it is.
 */
export class PodiumDirector {
  private readonly flow = new PodiumFlow();
  private set: PodiumSet | null = null;
  /** Podium slot of each remote or AI car on it (by peer id), and the player's */
  private readonly peerSlot = new Map<string, PodiumSlot>();
  private playerSlot: PodiumSlot | null = null;
  private playerHidden = false;
  private context: ShowContext | null = null;
  private ui: PodiumUi = { stage: "idle", rows: [] };
  private readonly listeners = new Set<() => void>();
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private readonly seating: WheelSeating = { ground: null, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  /** The full-screen podium's aerial tour, built on its first use */
  private aerial: MenuAerial | null = null;
  private readonly aerialPose: AerialPose = { position: new THREE.Vector3(), lookAt: new THREE.Vector3(), fovDeg: SHOT_FOV_DEG };
  private hasAerial = false;

  constructor(
    private readonly track: BuiltTrackData,
    /** The podium has let go of the screen (played out or closed): the drive's cameras start over */
    private readonly onEnd: () => void
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): PodiumUi => this.ui;

  /** Seconds into the full-screen podium (its countdown reads it every frame) */
  readonly boardTimeS = (): number => this.flow.boardElapsedS;

  /** The shot or the full-screen podium has the screen (and the keys, the pad and the camera) */
  get playing(): boolean {
    return this.flow.stage === "playing" || this.flow.stage === "board";
  }

  /** The parked-cars shot itself */
  private get shot(): boolean {
    return this.flow.stage === "playing";
  }

  /** Once a frame, after the race status is current */
  update(f: PodiumFrame): void {
    const wasPlaying = this.playing;
    const wasShot = this.shot;
    const wasBoard = this.flow.stage === "board";
    let changed = false;
    if (f.context !== undefined && f.context !== this.context) {
      this.context = f.context;
      changed = this.playing;
    }
    try {
      changed = this.flow.step(f.race, f.dt, f.allowed, (rows) => this.build(rows, f.peers, f.ground), f.board ?? false) || changed;
      // A car on the podium gone from the race (its player left): the shot ends
      if (this.shot && [...this.peerSlot.keys()].some((id) => !f.peers.some((p) => p.peerId === id))) changed = this.flow.skip() || changed;
    } catch (err) {
      console.warn("[podium] shot dropped", err);
      // Straight to the table: the overlay has to hear of it
      changed = this.flow.stop() || changed;
    }
    this.settle(wasPlaying, wasShot, wasBoard);
    if (changed) this.publish();
  }

  /** Any key, pad button or tap: the shot on to the full-screen podium (or the table), the full-screen podium closed */
  skip(): void {
    const wasShot = this.shot;
    const wasBoard = this.flow.stage === "board";
    if (!this.flow.skip()) return;
    this.settle(true, wasShot, wasBoard);
    this.publish();
  }

  /** The cars to draw this frame: during the shot the podium cars parked, every other car out of sight */
  drawPeers(peers: InterpolatedPeerState[]): InterpolatedPeerState[] {
    if (!this.shot) return peers;
    return peers.map((p) => {
      const slot = this.peerSlot.get(p.peerId);
      if (slot) return stillPeer(p, slot.position, slot.quaternion);
      return stillPeer(p, p.position.clone().setY(p.position.y - 1000), p.quaternion);
    });
  }

  /** After the drive has drawn the player's car: parks it on the podium during the shot, or hides it when off it */
  drawPlayer(rig: SimCarRig, telemetry: CarTelemetry, ground: GroundQuery | null, dt: number): void {
    if (!this.shot) {
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

  /**
   * Places the camera during the shot, or the aerial under the full-screen podium (`view`: how; without it the board
   * keeps the drive's own cameras); false otherwise (the drive's own cameras then run)
   */
  placeCamera(camera: THREE.PerspectiveCamera, view?: PodiumView): boolean {
    let fov = SHOT_FOV_DEG;
    const set = this.set;
    if (this.shot && set) {
      podiumCameraAt(set, this.flow.elapsedS / PODIUM_SHOT_S, camera.aspect, this.camPos, this.camLook);
    } else if (this.flow.stage === "board" && view && this.aerial) {
      const t = view.still ? 0 : Math.min(this.flow.boardElapsedS, 2 * AERIAL_SHOT_S - 0.01);
      const pose = this.aerial.pose(t, camera.aspect, view.fogDensity, view.still, this.aerialPose);
      this.camPos.copy(pose.position);
      this.camLook.copy(pose.lookAt);
      this.hasAerial = true;
      fov = pose.fovDeg;
    } else return false;
    camera.position.copy(this.camPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.camLook);
    // No driving aids (the racing line) in the shot; the drive's onEnd puts them back
    camera.layers.disable(OVERLAY_LAYER);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  /** Where the camera looks, for what follows it (the reflections); null when it is the drive's */
  get focus(): THREE.Vector3 | null {
    if (this.shot && this.set) return this.set.centre;
    return this.flow.stage === "board" && this.hasAerial ? this.camLook : null;
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

  /** After a change of stage: the shot's parked cars let go, the aerial set up, the drive's cameras given back */
  private settle(wasPlaying: boolean, wasShot: boolean, wasBoard: boolean): void {
    if (wasShot && !this.shot) {
      this.peerSlot.clear();
      this.playerSlot = null;
      this.set = null;
    }
    if (!wasBoard && this.flow.stage === "board") {
      // From the start/finish line, where the podium stood
      const pole = this.track.spawnGrid[0];
      this.aerial ??= new MenuAerial(this.track);
      this.aerial.restart(pole && Number.isFinite(pole.s) ? pole.s : 0);
      this.hasAerial = false;
    }
    if (wasPlaying && !this.playing) {
      this.hasAerial = false;
      this.onEnd();
    }
  }

  private publish(): void {
    this.ui = { stage: this.flow.stage, rows: this.flow.rows, context: this.context };
    for (const listener of this.listeners) listener();
  }
}
