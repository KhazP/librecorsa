/**
 * The race's last lap, read off its standing: when the race is on it (the leader has started it), and when the player
 * is on their own last one, the lap that ends in the chequered flag. A car a lap or more down is flagged on its first
 * line crossing after the leader finishes (race-session.ts), so its last lap starts later than the leader's, and its
 * lap counter never reads the race's last lap.
 *
 * `FinalLapCue` times the top-centre notice: up for a few seconds as the leader starts the last lap.
 *
 * Pure, no three.js or DOM: the HUD feeds each `RaceStatus` with the page's clock.
 */
import type { RaceStatus } from "@/types/f1";

export interface FinalLapState {
  /** The leader has started the last lap (or has finished: the flag is out) */
  race: boolean;
  /** The player is on their own last lap: their next line crossing takes the chequered flag */
  player: boolean;
}

const NONE: FinalLapState = { race: false, player: false };

/**
 * Where the race stands on its last lap. The player's last lap is theirs once they start a lap after the leader has
 * started the race's last one: on the lead lap that is the race's last lap, a lap down it is the next one they start.
 * Read without lap lengths: with the leader on the last lap, the player's lap ends after the leader's when the player
 * is behind the leader on the lap (both at about the same pace), so the flag will be out by then.
 */
export function finalLapState(race: RaceStatus | undefined): FinalLapState {
  if (!race || race.phase !== "racing" || !race.totalLaps) return NONE;
  const total = race.totalLaps;
  const out = (e: RaceStatus["standings"][number]) => Boolean(e.retired || e.dq);
  const flagOut = race.standings.some((e) => e.finished && !out(e));
  const leader = race.standings.find((e) => !out(e));
  const raceFinal = flagOut || (leader ? leader.lap >= total : race.lap >= total);
  const me = race.standings.find((e) => e.isPlayer);
  if (me && (me.finished || out(me))) return { race: raceFinal, player: false };
  let player = race.lap >= total || flagOut;
  if (!player && raceFinal && leader && me && leader !== me && leader.trackS !== undefined && me.trackS !== undefined) {
    player = me.trackS <= leader.trackS;
  }
  return { race: raceFinal, player };
}

/** How long the notice stays up once the leader starts the last lap (ms) */
export const FINAL_LAP_NOTICE_MS = 6000;

/**
 * The final-lap notice's timing: shown from the frame the leader starts the last lap, for `FINAL_LAP_NOTICE_MS`.
 * Only a race seen before its last lap (at the lights, on a rolling start's formation lap, or racing) gets it, so a HUD
 * that comes up in the middle of the last lap stays quiet; a restart (the lights again) arms it once more. Not once the
 * player has taken the flag.
 */
export class FinalLapCue {
  private armed = false;
  private shownAtMs: number | null = null;

  /** One frame: true while the notice is up. Calling it twice for one frame changes nothing */
  update(race: RaceStatus | undefined, nowMs: number): boolean {
    if (!race) {
      this.armed = false;
      this.shownAtMs = null;
      return false;
    }
    if (race.phase === "finished") return false;
    const s = finalLapState(race);
    // The lights and a rolling start's formation lap arm it (a one-lap race's last lap starts at the green)
    if (race.phase === "lights" || race.rollingFormation || !s.race) {
      this.armed = true;
      this.shownAtMs = null;
      return false;
    }
    if (this.armed) {
      this.armed = false;
      this.shownAtMs = nowMs;
    }
    return this.shownAtMs !== null && nowMs - this.shownAtMs < FINAL_LAP_NOTICE_MS;
  }
}
