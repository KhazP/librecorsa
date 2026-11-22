/**
 * An AI race run by the simulation worker, as the page holds it: the game starts and steers it here as it would the
 * field itself (`AiRace`), and draws it from what the worker reports (`sim-runtime.ts`): the AI cars' poses after each
 * step of the field, and the race's standing a few times a second.
 *
 * The worker runs the whole race, the player's car included: its stand-in (`remote-car.ts`) is driven by the worker
 * from the start, and the page sends it the controls every frame, through the start lights too (the worker holds the
 * car on the grid itself). The page's track environment goes on stepping the weather for drawing it; the worker's
 * weather is eased into it about once a second, and the road under the player (water, spray, rubber) is the worker's.
 */
import type { QualifyingGridInput } from "../qualifying";
import * as THREE from "three";
import type { RaceStatus } from "@/types/f1";
import type { AiRace, FieldCarRestorePose, RaceDriverLabel, WorkerRaceView } from "../ai-race";
import type { DamageLevel } from "../car-damage";
import type { PenaltyReason } from "../penalty-ledger";
import type { GroundQuery } from "../f12026-car/TrackColliderQuery";
import type { InterpolatedPeerState } from "../multiplayer-sync";
import type { AiGridOrder, PlayerGridSlot } from "../race-setup";
import type { SimRealismFlags } from "../sim-realism";
import type { SimulatorCar } from "../simulator-car";
import type { TrackEnvironment } from "../track-environment";
import { sameConditions, type SessionConditions } from "../weather";
import { FieldPeers } from "./field-frame";
import type { SimRaceLink } from "./sim-host";
import type { SimEvent } from "./sim-protocol";

/** The AI cars are carried forward (or back, when the poses are from after the frame's time) no further than this (s), as the player's car is */
const MAX_RENDER_LEAD_S = 0.05;
/** A frame this long after the last one is the first after a stop (a pause, the menus): nothing is carried forward (ms) */
const RESUME_GAP_MS = 100;

let raceNumber = 0;

export class WorkerAiField implements AiRace, WorkerRaceView {
  raceLaps = 5;
  gridOrder: AiGridOrder = "pace";
  playerGrid: PlayerGridSlot = "back";
  damageLevel: DamageLevel = "reduced";
  aggressionAdd = 0;
  playerDriver: RaceDriverLabel | null = null;
  playerPenaltyS = 0;
  manualStart = false;
  playerDisqualified = false;
  lockAidsInYellow = true;

  penalisePlayer(seconds: number, reason: PenaltyReason, detail: string): void {
    if (this.race) this.link.post({ type: "race", op: "penalise", seconds, reason, detail });
  }
  private sentLockAids = true;
  qualifying: QualifyingGridInput | undefined = undefined;
  readonly worker: WorkerRaceView = this;
  /** The field's seed for the next start (a headless check replays one); unset, the worker draws one */
  seed: number | undefined = undefined;

  private skillLevel: number;
  private race = 0;
  private fieldEpoch = 0;
  private latest: RaceStatus | null = null;
  private frozen = false;
  private rulesActive = false;
  private placeholderPhase: RaceStatus["phase"] = "lights";
  private fieldPeers: FieldPeers | null = null;
  private peersDirty = false;
  private hasShownPeers = false;
  /** The AI poses' time: the state they came with (wall clock, its lead) and how much older they are than it */
  private posesWallMs = 0;
  private posesLeadS = 0;
  private sentPenaltyS = 0;
  private sentDq = false;
  private sentConditions: SessionConditions | null = null;
  private sentRealism: Readonly<SimRealismFlags> | null = null;
  private unlisten: (() => void) | null = null;
  private road: { wetness: number | null; spray: number; rubber: number } | null = null;
  /**
   * How far the AI cars are carried forward from their last poses (s), taken once a frame in `update` as the player's
   * car is in its `step`: both are drawn at the same instant, and while the page does not drive (a pause, the replay)
   * neither moves on
   */
  private leadS = 0;
  private frameDtS = 0;
  private lastUpdateMs = -Infinity;
  private stopped = false;

  constructor(
    private readonly link: SimRaceLink,
    /** The page's track environment, which the race's weather is mirrored into */
    private readonly env: TrackEnvironment,
    /** The player's car as the game holds it (the stand-in) */
    private readonly player: SimulatorCar,
    private readonly opponents: number,
    skill: number,
    /** The circuit's ground, which the AI cars' wheels are seated on as they are drawn */
    private readonly ground: () => GroundQuery | null
  ) {
    this.skillLevel = skill;
  }

  get skill(): number {
    return this.skillLevel;
  }

  setSkill(skill: number): void {
    this.skillLevel = THREE.MathUtils.clamp(skill, 0, 100);
    if (this.race) this.link.post({ type: "race", op: "skill", skill: this.skillLevel });
  }

  startRace(standing: boolean): void {
    this.race = ++raceNumber;
    this.fieldEpoch = 0;
    this.latest = null;
    this.fieldPeers = null;
    this.peersDirty = false;
    this.hasShownPeers = false;
    this.road = null;
    this.frozen = standing;
    this.rulesActive = true;
    this.placeholderPhase = standing ? "lights" : "racing";
    this.playerPenaltyS = this.sentPenaltyS = 0;
    this.playerDisqualified = this.sentDq = false;
    this.sentLockAids = this.lockAidsInYellow;
    this.unlisten ??= this.link.listen((event) => this.receive(event));
    // The road starts over with the race, as it does for a field on the page
    this.env.reset();
    // The player's car on the grid at once: the worker places it in its own slot of the field, which the page can only
    // tell for a fixed slot (the twin is shown until the worker's car is there, a frame or two)
    const cars = this.opponents + 1;
    const slot = this.playerGrid === "front" ? 0 : this.playerGrid === "middle" ? Math.floor((cars - 1) / 2) : this.playerGrid === "back" ? cars - 1 : 0;
    const epoch = this.link.placeTwin((twin) => twin.resetToStartGrid(!standing, slot, standing ? undefined : cars));
    this.player.aiAutopilot = false;
    this.sentConditions = this.env.weather.conditions;
    this.sentRealism = this.env.simRealism;
    this.link.post({
      type: "race",
      op: "start",
      race: this.race,
      opponents: this.opponents,
      skill: this.skillLevel,
      setup: {
        laps: this.raceLaps,
        gridOrder: this.gridOrder,
        playerGrid: this.playerGrid,
        damage: this.damageLevel,
        aggressionAdd: this.aggressionAdd,
        standing,
        manualStart: standing && this.manualStart,
        driver: this.playerDriver,
        lockAidsInYellow: this.lockAidsInYellow,
        qualifying: this.qualifying ? { ...this.qualifying } : undefined,
      },
      epoch,
      weather: this.env.weather.snapshot(),
      realism: { ...this.env.simRealism },
      seed: this.seed,
    });
  }

  private receive(event: SimEvent): void {
    if (event.type === "race") {
      if (event.race !== this.race || (event.epoch ?? 0) !== this.fieldEpoch) return;
      this.latest = event.status;
      this.frozen = event.frozen;
      this.rulesActive = event.rulesActive;
      this.road = event.road;
      if (event.roster) {
        this.fieldPeers = new FieldPeers(event.roster, this.ground());
        this.peersDirty = true;
        this.hasShownPeers = false;
      }
      // The worker's weather into the page's, for the sky and the road; not across a change of conditions the worker
      // has yet to take (it would undo the player's choice)
      if (event.weather && sameConditions(event.weather.conditions, this.env.weather.conditions)) this.env.applyWeatherSync(event.weather);
      return;
    }
    if (event.type === "state" && event.field && event.field.race === this.race && (event.field.epoch ?? 0) === this.fieldEpoch) {
      this.fieldPeers?.apply(event.field.poses);
      if (!this.hasShownPeers) this.peersDirty = true;
      this.posesWallMs = event.wallMs;
      this.posesLeadS = event.leadS + event.field.ageS;
    }
  }

  get phase(): RaceStatus["phase"] {
    return this.latest?.phase ?? this.placeholderPhase;
  }

  get lightsOn(): number {
    return this.latest?.lightsOn ?? 0;
  }

  get gridStanding(): boolean {
    return this.phase === "lights" && (this.latest?.countdownS ?? 0) > 0;
  }

  get playerFrozen(): boolean {
    return this.frozen;
  }

  get raceRulesActive(): boolean {
    return this.race !== 0 && this.rulesActive;
  }

  /** The player's car's aids are judged in the worker, where the car is driven */
  detectionEarnedFor(): boolean {
    return false;
  }

  attachTrackRoot(): void {
    // The worker has the circuit's colliders from the car's own link (sim-host.ts)
  }

  update(): void {
    if (!this.race) return;
    // (not on the first frame after a stop, as the player's car is not: the worker's newest poses are from before it)
    const now = this.link.wallNowMs();
    const gapMs = now - this.lastUpdateMs;
    const resumed = gapMs > RESUME_GAP_MS;
    this.frameDtS = resumed || gapMs <= 0 ? 0 : Math.min(gapMs / 1000, 0.1);
    this.lastUpdateMs = now;
    this.leadS = resumed ? 0 : THREE.MathUtils.clamp((now - this.posesWallMs) / 1000 + this.posesLeadS, -MAX_RENDER_LEAD_S, MAX_RENDER_LEAD_S);
    this.peersDirty = true;
    if (this.lockAidsInYellow !== this.sentLockAids) {
      this.sentLockAids = this.lockAidsInYellow;
      this.link.post({ type: "race", op: "rules", lockAidsInYellow: this.lockAidsInYellow });
    }
    if (this.playerPenaltyS !== this.sentPenaltyS || this.playerDisqualified !== this.sentDq) {
      this.sentPenaltyS = this.playerPenaltyS;
      this.sentDq = this.playerDisqualified;
      this.link.post({ type: "race", op: "penalty", seconds: this.playerPenaltyS, dq: this.playerDisqualified || undefined });
    }
    const conditions = this.env.weather.conditions;
    if (this.sentConditions && !sameConditions(conditions, this.sentConditions)) {
      this.sentConditions = conditions;
      this.link.post({ type: "race", op: "conditions", conditions: { ...conditions } });
    }
    const realism = this.env.simRealism;
    if (realism !== this.sentRealism) {
      this.sentRealism = realism;
      this.link.post({ type: "race", op: "realism", flags: { ...realism } });
    }
  }

  status(): RaceStatus {
    return (
      this.latest ?? {
        phase: this.placeholderPhase,
        lightsOn: 0,
        position: this.opponents + 1,
        fieldSize: this.opponents + 1,
        lap: 1,
        totalLaps: this.raceLaps,
        standings: [],
      }
    );
  }

  peers(): InterpolatedPeerState[] {
    if (!this.fieldPeers) return [];
    if (this.peersDirty) {
      this.peersDirty = false;
      this.hasShownPeers = true;
      return this.fieldPeers.shownAt(this.leadS, this.frameDtS);
    }
    return this.fieldPeers.current();
  }

  sims(): readonly SimulatorCar[] {
    return [];
  }

  get playerWetness(): number | null {
    return this.road?.wetness ?? null;
  }

  get playerSpray(): number {
    return this.road?.spray ?? 0;
  }

  get rubber(): number | null {
    return this.road?.rubber ?? null;
  }

  get failed(): boolean {
    return this.link.failed;
  }

  /** Rewinds AI cars in the worker to their Flashback poses and updates the page's peer buffer immediately */
  restoreField(poses: readonly FieldCarRestorePose[], rewindS: number): void {
    if (!this.race || this.phase !== "racing") return;
    const epoch = ++this.fieldEpoch;
    this.leadS = 0;
    this.frameDtS = 0;
    this.peersDirty = true;
    this.fieldPeers?.restorePoses(poses);
    this.link.post({ type: "race", op: "restore", poses: poses.map((p) => ({ ...p })), rewindS, epoch });
  }

  /** The session has left the race: the worker drops it, and its car drives on alone */
  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unlisten?.();
    this.unlisten = null;
    if (this.race) this.link.post({ type: "race", op: "end" });
  }
}
