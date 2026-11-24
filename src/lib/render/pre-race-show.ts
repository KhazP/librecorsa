/**
 * The career's pre-race show on the drive's scene (show-timeline.ts lays it out): when a career round's session forms
 * (its qualifying, or its grid at the lights) the drive waits under the show, the cameras film what each scene names,
 * and the start card hands the car back to the player. A visual only: the cars stand where the session put them, the
 * physics and the lights wait (the drive treats the show like the pause menu), and anything missing skips a shot.
 *
 * Shots, each built from what every circuit has (the centreline, the grid, the player's car):
 * - title / circuit: the overlay covers the scene (the circuit is drawn there); the camera waits at the first aerial
 *   shot's opening so its scenery is ready when the cut comes.
 * - aerial: the title screen's aerial tour (menu-aerial.ts), cut faster.
 * - tyres: low beside the player's front wheel, sweeping round it, then diving into its hub.
 * - grid intro: high behind the grid, down the whole field. A pair: beside those two cars, drifting across them.
 * - field (qualifying): round the player's car. Start card: in front of it, closing in.
 */
import * as THREE from "three";
import type { BuiltTrackData } from "@/lib/track-data";
import { OVERLAY_LAYER } from "@/lib/render/layers";
import { AERIAL_SHOT_S, MenuAerial, type AerialPose } from "@/lib/render/menu-aerial";
import {
  aerialCut,
  buildShowTimeline,
  DEFAULT_SHOW_MARKERS,
  gridPairs,
  ShowClock,
  type ShowKind,
  type ShowMarkers,
  type ShowSceneId,
  type ShowTimeline,
} from "@/lib/show/show-timeline";
import type { ShowContext } from "@/lib/show/show-context";

/** The car codes in starting order (pole first) with what the cards show of each */
export interface ShowGridRow {
  code: string;
  color: string;
  isPlayer: boolean;
  /** Qualifying lap (ms), when the grid comes from a qualifying session */
  lapMs: number | null;
}

export type ShowStage = "idle" | "playing" | "done";

export interface PreRaceShowUi {
  stage: ShowStage;
  /** Counts the shows started: the overlay starts its animations over on a new one */
  epoch: number;
  kind: ShowKind | null;
  timeline: ShowTimeline | null;
  scene: ShowSceneId | null;
  sceneIndex: number;
  /** gridPair: which pair, 0 = the back of the grid */
  pair: number | null;
  context: ShowContext | null;
  grid: readonly ShowGridRow[];
}

/** What the drive tells the show each frame */
export interface ShowFrame {
  /** Seconds since the last frame (0 while the pause menu is open) */
  dt: number;
  /** The show may play now: not in the menus or a replay, and not `suppressed` */
  allowed: boolean;
  /**
   * The show is not to be had at all (the setting off, online, VR): a session that forms meanwhile counts as shown, so
   * the show never starts later in the middle of it
   */
  suppressed: boolean;
  /** The career round's qualifying session has just formed (its clock not yet started) */
  qualifying: boolean;
  /** The career round's AI race stands at the lights (before lights out; some may be lit already) */
  atLights: boolean;
  /** The grid at the lights (pole first); asked for only while a race show is still to come (`wantsGrid`) */
  grid: readonly ShowGridRow[];
  /** The player's car on the lap (m), for the aerial tour's first shot */
  playerS: number;
  /**
   * Where the show's music is, on the show's clock (s), while it sounds; null while it does not (loading, ended,
   * muted). The clock follows it, so the scenes stay on the music's beats.
   */
  musicS: number | null;
  /** The music will sound (unlocked, its level up): the show waits a moment for it to start before running */
  musicExpected: boolean;
}

/** How long the show waits at its opening for its music to start (s): then it runs without it */
export const MUSIC_WAIT_S = 2;
/** How fast the clock closes on the music (per s): a drift is caught up within a second or so, never run backwards */
const MUSIC_FOLLOW = 2;

/** Where the cameras find the cars this frame */
export interface ShowCars {
  player: { position: THREE.Vector3; quaternion: THREE.Quaternion } | null;
  /** The player's front wheel (world), for the tyres' shot */
  frontWheel: THREE.Vector3 | null;
  /** A car on the grid by its race code (the player's included) */
  carOf: (code: string) => THREE.Vector3 | null;
  /** The scene's fog density (FogExp2), for the aerial shots' distances */
  fogDensity: number;
  /** Hold the first frame of each shot (reduced motion) */
  still: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
/** The shots' vertical field of view (°) */
const FOV_DEG = 40;
const DIVE_FOV_DEG = 18;
/** The tyres' dive into the hub takes the scene's last this long (s) */
export const WHEEL_DIVE_S = 1.1;

const smooth = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

export class PreRaceShowDirector {
  private ctx: ShowContext | null = null;
  /** The shows this round has had: a restart (a mulligan) does not play one again */
  private readonly played = new Set<"qualifying" | "race">();
  private clock: ShowClock | null = null;
  /** How long the show has waited at its opening for the music */
  private musicWaitS = 0;
  private markers: ShowMarkers = DEFAULT_SHOW_MARKERS;
  private grid: readonly ShowGridRow[] = [];
  private epoch = 0;
  private ui: PreRaceShowUi = idleShowUi;
  private readonly listeners = new Set<() => void>();
  private aerial: MenuAerial | null = null;
  private readonly aerialPose: AerialPose = { position: new THREE.Vector3(), lookAt: new THREE.Vector3(), fovDeg: FOV_DEG };
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly focusAt = new THREE.Vector3();
  private hasFocus = false;

  constructor(
    private readonly track: BuiltTrackData,
    /** The show has ended (started from the card, or the round left): the drive's cameras start over */
    private readonly onEnd: () => void
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly getSnapshot = (): PreRaceShowUi => this.ui;

  /** Seconds into the show playing (the overlay's animations read it every frame) */
  readonly timeS = (): number => this.clock?.timeS ?? 0;

  /** The show is on screen and the drive waits under it */
  get playing(): boolean {
    return this.clock !== null;
  }

  /** The round's race, after its qualifying show, opens with the grid show: its grid needs no other showing */
  get gridShowNext(): boolean {
    return this.ctx !== null && this.played.has("qualifying") && !this.played.has("race");
  }

  /**
   * The career round to show (null: no round, nothing plays). A new round clears what was played; the same round
   * armed again (its restart) keeps it, so a mulligan goes straight back to the lights.
   */
  arm(ctx: ShowContext | null, markers?: ShowMarkers): void {
    const same = ctx && this.ctx && ctx.seriesId === this.ctx.seriesId && ctx.roundIndex === this.ctx.roundIndex;
    if (!same) this.played.clear();
    this.ctx = ctx;
    if (markers) this.markers = markers;
    if (!ctx && this.clock) this.end();
  }

  update(f: ShowFrame): void {
    const clock = this.clock;
    if (clock) {
      if (!f.allowed || f.suppressed || !this.ctx) {
        this.end();
        return;
      }
      if (clock.step(this.stepFor(clock, f))) this.publish();
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const qualifying = f.qualifying && !this.played.has("qualifying");
    const race = f.atLights && f.grid.length > 0 && !this.played.has("race");
    if (f.suppressed) {
      // Formed without the show: never played later on in it
      if (qualifying) this.played.add("qualifying");
      if (race) this.played.add("race");
      return;
    }
    if (!f.allowed) return;
    if (qualifying) this.start("qualifying", f, ctx);
    else if (race) this.start(this.played.has("qualifying") ? "grid" : "race", f, ctx);
  }

  /** The career round armed (null outside the career), for what follows the race: the full-screen podium's names */
  get context(): ShowContext | null {
    return this.ctx;
  }

  /** A race show is still to come this round: the drive builds the grid for it */
  get wantsGrid(): boolean {
    return this.ctx !== null && !this.played.has("race");
  }

  /**
   * The clock's step this frame: held at the opening while the music is on its way, then following the music (sped
   * up or slowed, never backwards) once it sounds; on its own dt without music
   */
  private stepFor(clock: ShowClock, f: ShowFrame): number {
    if (f.dt <= 0) return 0;
    if (f.musicS === null) {
      if (f.musicExpected && clock.timeS === 0 && this.musicWaitS < MUSIC_WAIT_S) {
        this.musicWaitS += f.dt;
        return 0;
      }
      return f.dt;
    }
    return Math.max(0, f.dt + (f.musicS - clock.timeS) * Math.min(1, MUSIC_FOLLOW * f.dt));
  }

  /** The start card's button (or a skip on it): the car is the player's */
  startNow(): void {
    if (this.clock) this.end();
  }

  /** Straight to the start card (or, on it, the start) */
  skip(): void {
    const clock = this.clock;
    if (!clock) return;
    if (clock.onReadyCard) this.end();
    else if (clock.skip()) this.publish();
  }

  /** Where the reflections should look from during the show; null when it is not playing */
  get focus(): THREE.Vector3 | null {
    return this.clock && this.hasFocus ? this.focusAt : null;
  }

  /** Places the camera for this frame of the show; false when it is not playing (the drive's own cameras run) */
  placeCamera(camera: THREE.PerspectiveCamera, cars: ShowCars): boolean {
    const clock = this.clock;
    if (!clock) return false;
    const at = clock.at;
    let fov = FOV_DEG;
    let placed = false;
    switch (at.scene.id) {
      case "title":
      case "circuit":
        placed = this.aerialShot(0, 0, camera.aspect, cars);
        fov = this.aerialPose.fovDeg;
        break;
      case "aerial": {
        const cut = aerialCut(at.scene.endS - at.scene.startS, at.localS);
        placed = this.aerialShot(cut.shot, cars.still ? 0 : cut.shotS, camera.aspect, cars);
        fov = this.aerialPose.fovDeg;
        break;
      }
      case "tyres": {
        const span = at.scene.endS - at.scene.startS;
        const r = this.wheelShot(at.localS, span, cars);
        placed = r !== null;
        if (r !== null) fov = r;
        break;
      }
      case "gridIntro":
        placed = this.gridWideShot(at.progress, cars);
        break;
      case "gridPair":
        placed = this.pairShot(at.scene.pair ?? 0, cars.still ? 0 : at.progress, cars);
        break;
      case "field":
      case "ready":
        placed = this.playerShot(at.scene.id === "field" ? at.localS : Math.min(at.localS, 8), at.scene.id, cars);
        break;
    }
    // A shot with nothing to film: the player's car
    if (!placed && !this.playerShot(at.localS, "ready", cars)) return false;
    camera.position.copy(this.pos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.look);
    camera.layers.disable(OVERLAY_LAYER);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    return true;
  }

  private start(kind: ShowKind, f: ShowFrame, ctx: ShowContext): void {
    this.played.add(kind === "qualifying" ? "qualifying" : "race");
    this.grid = kind === "qualifying" ? [] : f.grid;
    const size = kind === "qualifying" ? Object.keys(ctx.drivers).length : f.grid.length;
    this.clock = new ShowClock(buildShowTimeline(kind, size, this.markers));
    this.musicWaitS = 0;
    this.aerial ??= new MenuAerial(this.track);
    this.aerial.restart(f.playerS);
    this.epoch++;
    this.clock.step(0);
    this.publish();
  }

  private end(): void {
    this.clock = null;
    this.hasFocus = false;
    this.publish();
    this.onEnd();
  }

  private publish(): void {
    const clock = this.clock;
    if (!clock) {
      this.ui = { ...idleShowUi, stage: this.epoch > 0 ? "done" : "idle", epoch: this.epoch, context: this.ctx };
    } else {
      const at = clock.at;
      this.ui = {
        stage: "playing",
        epoch: this.epoch,
        kind: clock.timeline.kind,
        timeline: clock.timeline,
        scene: at.scene.id,
        sceneIndex: at.index,
        pair: at.scene.pair ?? null,
        context: this.ctx,
        grid: this.grid,
      };
    }
    for (const listener of this.listeners) listener();
  }

  private aerialShot(shot: number, shotS: number, aspect: number, cars: ShowCars): boolean {
    const aerial = this.aerial;
    if (!aerial) return false;
    const pose = aerial.pose(shot * AERIAL_SHOT_S + Math.min(shotS, AERIAL_SHOT_S - 0.01), aspect, cars.fogDensity, false, this.aerialPose);
    this.pos.copy(pose.position);
    this.look.copy(pose.lookAt);
    this.setFocus(pose.lookAt);
    return true;
  }

  /** Beside the front wheel, sweeping from ahead of it to its side; the scene's last moment dives into the hub */
  private wheelShot(localS: number, span: number, cars: ShowCars): number | null {
    const p = cars.player;
    const w = cars.frontWheel;
    if (!p || !w) return null;
    this.carAxes(p.quaternion);
    // The wheel's side of the car: the camera stands out on that side
    const side = this.a.copy(w).sub(p.position).dot(this.left) >= 0 ? 1 : -1;
    const sweepS = Math.max(0.5, span - WHEEL_DIVE_S);
    const u = cars.still ? 0 : smooth(localS / sweepS);
    const out = 2.9 - 0.85 * u;
    const ahead = 1.5 - 1.9 * u;
    const lift = 0.48 - 0.16 * u;
    this.b.copy(w).addScaledVector(this.left, side * out).addScaledVector(this.fwd, ahead).addScaledVector(UP, lift);
    const dive = cars.still ? 0 : Math.min(1, Math.max(0, (localS - sweepS) / WHEEL_DIVE_S));
    const d = dive * dive * dive;
    this.a.copy(w).addScaledVector(this.left, side * 0.28);
    this.pos.copy(this.b).lerp(this.a, d);
    this.look.copy(w);
    this.setFocus(w);
    return FOV_DEG + (DIVE_FOV_DEG - FOV_DEG) * d;
  }

  /** High behind the last row, looking down the whole grid towards the lights */
  private gridWideShot(progress: number, cars: ShowCars): boolean {
    const front = this.slotPosition(0, cars);
    const back = this.slotPosition(this.grid.length - 1, cars);
    if (!front || !back) return false;
    const dir = this.a.copy(front).sub(back).setY(0);
    const len = dir.length();
    if (len < 1) dir.copy(this.forwardAtGrid());
    else dir.divideScalar(len);
    const e = smooth(progress);
    this.pos.copy(back).addScaledVector(dir, -(22.5 - 5.5 * e)).addScaledVector(UP, 11.5 - 2.8 * e);
    this.look.copy(front).lerp(back, 0.45).addScaledVector(UP, -1.2);
    this.setFocus(this.look);
    return true;
  }

  /** In front of a pair and to the side, drifting across them as their cards are up */
  private pairShot(pair: number, progress: number, cars: ShowCars): boolean {
    const rows = gridPairs(this.grid.map((_, i) => i))[pair];
    if (!rows?.length) return false;
    const a = this.slotPosition(rows[0], cars);
    const b = rows.length > 1 ? this.slotPosition(rows[1], cars) : null;
    if (!a) return false;
    const mid = this.look.copy(a);
    if (b) mid.lerp(b, 0.5);
    const fwd = this.forwardAtGrid();
    // The grid's left (model +X: the cars' left)
    this.left.set(fwd.z, 0, -fwd.x);
    const across = b ? Math.max(3, a.distanceTo(b)) : 3;
    const e = smooth(progress);
    this.pos
      .copy(mid)
      .addScaledVector(fwd, 8.2 + across * 0.65 - 1.4 * e)
      .addScaledVector(this.left, (-0.45 + 0.9 * e) * across)
      .addScaledVector(UP, 2.05 + 0.35 * e);
    // Aimed slightly below the cars so both cars stay centered between the side cards and clear on phones
    this.setFocus(mid);
    mid.addScaledVector(UP, -0.75);
    return true;
  }

  /** Round the player's car (the field), or in front of it closing in (the start card) */
  private playerShot(localS: number, scene: ShowSceneId, cars: ShowCars): boolean {
    const p = cars.player;
    if (!p) return false;
    this.carAxes(p.quaternion);
    if (scene === "field") {
      const ang = (cars.still ? 0 : localS) * 0.12 + 0.6;
      const r = 9.2;
      this.pos
        .copy(p.position)
        .addScaledVector(this.fwd, Math.cos(ang) * r)
        .addScaledVector(this.left, Math.sin(ang) * r)
        .addScaledVector(UP, 3.3);
    } else {
      const e = cars.still ? 0 : smooth(localS / 8);
      this.pos
        .copy(p.position)
        .addScaledVector(this.fwd, 7.6 - 1.4 * e)
        .addScaledVector(this.left, 3.1 - 0.7 * e)
        .addScaledVector(UP, 1.45 + 0.15 * e);
    }
    // The start card's title sits low: the car above it
    this.look.copy(p.position).addScaledVector(UP, scene === "ready" ? -0.55 : 0.4);
    this.setFocus(p.position);
    return true;
  }

  /** A grid place's car (pole = 0), or the circuit's own grid slot where that car is not found */
  private slotPosition(index: number, cars: ShowCars): THREE.Vector3 | null {
    const row = this.grid[index];
    const car = row ? cars.carOf(row.code) : null;
    if (car) return car;
    const slot = this.track.spawnGrid[index];
    return slot ? new THREE.Vector3(slot.position[0], slot.position[1], slot.position[2]) : null;
  }

  /** The way the grid faces (the pole slot's forward, flat) */
  private forwardAtGrid(): THREE.Vector3 {
    const f = this.track.spawnGrid[0]?.forward;
    this.fwd.set(f?.[0] ?? 0, 0, f?.[2] ?? 1);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, 1);
    return this.fwd.normalize();
  }

  /** The car's forward and left (model +Z forward, +X left), flat */
  private carAxes(q: THREE.Quaternion): void {
    this.fwd.set(0, 0, 1).applyQuaternion(q).setY(0);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, 1);
    this.fwd.normalize();
    this.left.set(this.fwd.z, 0, -this.fwd.x);
  }

  private setFocus(v: THREE.Vector3): void {
    this.focusAt.copy(v);
    this.hasFocus = true;
  }
}

export const idleShowUi: PreRaceShowUi = {
  stage: "idle",
  epoch: 0,
  kind: null,
  timeline: null,
  scene: null,
  sceneIndex: -1,
  pair: null,
  context: null,
  grid: [],
};
