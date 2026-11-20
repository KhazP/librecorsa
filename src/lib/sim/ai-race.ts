/**
 * An AI race as the game sees it, wherever it runs: on the page (`AiOpponentField` itself) or in the simulation worker
 * (`runtime/worker-ai-field.ts`, a stand-in fed by the worker's field). The game starts, steers and draws a race only
 * through this.
 */
import type * as THREE from 'three';
import type { RaceStatus } from '@/types/f1';
import type { QualifyingGridInput } from './qualifying';
import type { DamageLevel } from './car-damage';
import type { InterpolatedPeerState } from './multiplayer-sync';
import type { AiGridOrder, PlayerGridSlot } from './race-setup';
import type { PenaltyReason } from './penalty-ledger';
import type { SimulatorCar } from './simulator-car';

/** The player in a race against the AI: their three-letter code and colour (Settings > Display > Driver) */
export interface RaceDriverLabel {
  code: string;
  color: string;
}

/** Recorded pose of one car in an AI race, for Flashback rewind */
export interface FieldCarRestorePose {
  id: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  yawRad: number;
  speedMs: number;
  s?: number;
  distM?: number;
}

export interface AiRace {
  /** Race setup, read at the next `startRace` (race-setup.ts `startAiRace` writes them) */
  raceLaps: number;
  gridOrder: AiGridOrder;
  playerGrid: PlayerGridSlot;
  damageLevel: DamageLevel;
  aggressionAdd: number;
  /** The player's code and colour on the timing, the results and race control's messages; null: 'YOU' in red */
  playerDriver: RaceDriverLabel | null;
  /** Lines the field up and starts it: a standing start behind the lights, or a rolling one */
  startRace(standing: boolean): void;
  /** The player makes the standing start on the clutch: held on the grid through the lights with the engine live */
  manualStart: boolean;
  /**
   * The grid comes from qualifying (qualifying.ts): the player's best clean lap against the AI cars' own times.
   * Undefined: no qualifying, the grid slot and the AI grid order apply. Read at `startRace`
   */
  qualifying: QualifyingGridInput | undefined;
  readonly skill: number;
  setSkill(skill: number): void;
  attachTrackRoot(root: THREE.Object3D): void;
  readonly phase: RaceStatus['phase'];
  readonly lightsOn: number;
  /** The player is held on the grid until the lights go out */
  readonly playerFrozen: boolean;
  /**
   * The grid stands before its first red light (after qualifying, for its order to be read): the player's car stays
   * still, and a manual start's hold (and its jump-start watch) begins only with the lights
   */
  readonly gridStanding?: boolean;
  /** Time penalties the player serves at the flag (track limits), in seconds */
  playerPenaltyS: number;
  /** Disqualified by race control (track limits): out of the race, classified last; cleared by the next start */
  playerDisqualified: boolean;
  /** Race control's time penalty on the player for a call the page makes (a jump start): in the ledger and on the feed */
  penalisePlayer(seconds: number, reason: PenaltyReason, detail: string): void;
  /** The race's rules close the overtaking aids inside a yellow zone (race-rules.ts) */
  lockAidsInYellow: boolean;
  /** A car on this page has its overtaking aids closed by a yellow flag (a field in the worker answers there) */
  aidsLockedFor?(sim: SimulatorCar): boolean;
  /** The race rules for the player's overtaking aids apply */
  readonly raceRulesActive: boolean;
  detectionEarnedFor(sim: SimulatorCar): boolean;
  /** Once per frame, after the player's step */
  update(dt: number): void;
  status(): RaceStatus;
  /** Render / HUD states of the AI cars (the player is drawn by the caller) */
  peers(): InterpolatedPeerState[];
  /** The cars this page simulates for the race, the player's included (for the shared track environment) */
  sims(): readonly SimulatorCar[];
  /**
   * Set when the race runs in the simulation worker: the page steps the player's car (its stand-in) through the start
   * lights too, as the worker holds it there itself, and draws the road from what the worker's cars do to it
   */
  readonly worker?: WorkerRaceView;
  /** Rewinds AI cars and race clocks to a recorded Flashback frame, and invalidates the player's current race lap */
  restoreField?(poses: readonly FieldCarRestorePose[], rewindS: number): void;
  /** The session has left the race (another race, practice) */
  dispose?(): void;
}

/** What a race in the worker tells the page about the road, for drawing it */
export interface WorkerRaceView {
  /** Water under the player's car (wetness 0..1) and the spray it is driving into, from the worker's last report */
  readonly playerWetness: number | null;
  readonly playerSpray: number;
  /** Mean rubber on the racing line (the groove the circuit draws) */
  readonly rubber: number | null;
  /** The worker stopped: the race cannot go on there */
  readonly failed: boolean;
}
