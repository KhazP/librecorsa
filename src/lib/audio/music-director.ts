/**
 * Which music plays, from where the player is. Pure: the session asks it every frame (bgm-controller.ts plays the
 * answer), so a state reached without an edge (a rolling start, a restart, a replay opened from the results) still
 * gets the right music.
 *
 * - The menus (title, setup, settings from the title): the menu pool, one track playing on across every menu screen.
 * - Into a session: silence while the circuit loads and the grid waits (the lights, a multiplayer countdown).
 * - Lights out: the race pool. With no lights (practice, qualifying, a flying lap) it starts once the car moves, and
 *   then plays on through restarts until the player leaves for the menus.
 * - The player's flag: the results pool, through the cool-down lap, the podium and the results. Replays play it too.
 * - Paused (the pause menu, the seat panel, a lost wheel): the same music, ducked and muffled.
 *
 * It also names the pool coming next while the grid waits (the race's, at the lights or before a practice car moves),
 * so the player can load it beforehand and start it on the lights out, and the engine's load while the race music
 * plays, which lowers the music a little under a working engine.
 */
import type { MusicPool } from "./music-catalog";

/** Where the player is: AppPhase from drive-session.ts */
export type MusicPhase = "loading" | "title" | "wizard" | "driving";

export interface MusicInputs {
  phase: MusicPhase;
  /** The race's state this frame (`telemetry.race.phase`); undefined with no race (practice, qualifying) */
  racePhase: "lights" | "racing" | "finished" | undefined;
  /** An instant replay is showing */
  replaying: boolean;
  /** The car waits: the pause menu, the seat panel, a lost wheel or GPU */
  frozen: boolean;
  /** The car's speed (m/s): practice music starts once it moves */
  speedMs: number;
  /** How hard the engine works, 0 to 1 (throttle times the share of the rev range) */
  engineLoad: number;
}

export interface MusicCue {
  /** What should play; null fades the music out and holds it */
  pool: MusicPool | null;
  /** The pause duck: -6 dB through a 600 Hz low-pass */
  duck: boolean;
  /** The race carve: a gentle cut at 1 kHz so the engine and tyres sit on top */
  driveEq: boolean;
  /** The pool to load beforehand while nothing plays: it starts the moment it is cued */
  arm: MusicPool | null;
  /** The engine's load under the race music, 0 to 1 (0 anywhere else) */
  load: number;
}

/** Practice music starts above this speed (m/s): the first metres off the grid, or at once on a flying lap */
export const PRACTICE_START_MS = 2;

export class MusicDirector {
  /** Practice music has started this session: restarts keep it going */
  private practiceStarted = false;

  cue(i: MusicInputs): MusicCue {
    if (i.phase !== "driving") {
      this.practiceStarted = false;
      return { pool: i.phase === "loading" ? null : "menu", duck: false, driveEq: false, arm: null, load: 0 };
    }
    let pool: MusicPool | null;
    let arm: MusicPool | null = null;
    if (i.replaying || i.racePhase === "finished") pool = "results";
    else if (i.racePhase === "lights") {
      pool = null;
      arm = "race";
    } else if (i.racePhase === "racing") pool = "race";
    else {
      if (!i.frozen && Math.abs(i.speedMs) > PRACTICE_START_MS) this.practiceStarted = true;
      pool = this.practiceStarted ? "race" : null;
      if (!pool) arm = "race";
    }
    const duck = i.frozen;
    const driveEq = pool === "race" && !duck && !i.replaying;
    const load = driveEq && Number.isFinite(i.engineLoad) ? Math.min(1, Math.max(0, i.engineLoad)) : 0;
    return { pool, duck, driveEq, arm, load };
  }
}

/**
 * A shuffled run through a pool's tracks: each plays once before any plays again, and a new run never starts with
 * the track that ended the last one
 */
export class TrackBag {
  private queue: string[] = [];
  private last: string | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** The next track among `ids` (the pool's playable tracks now), or null with none */
  next(ids: readonly string[], prefer?: readonly string[]): string | null {
    if (ids.length === 0) return null;
    const playable = new Set(ids);
    this.queue = this.queue.filter((id) => playable.has(id));
    if (this.queue.length === 0) {
      const fresh = [...ids];
      for (let i = fresh.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
      }
      if (fresh.length > 1 && fresh[0] === this.last) fresh.push(fresh.shift()!);
      this.queue = fresh;
    }
    // An opener (the first menu track of all): the first of the preferred tracks still queued
    const preferred = prefer?.length ? this.queue.findIndex((id) => prefer.includes(id)) : -1;
    const [id] = this.queue.splice(Math.max(0, preferred), 1);
    this.last = id;
    return id;
  }
}
