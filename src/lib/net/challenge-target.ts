/**
 * What the time trial shows while the challenge is driven: the player's best this week, the leader's time, and the
 * player's place with the gap to the place above, from the week's board (`fetchRemoteBoard` with its `event`).
 */
import { text as tx } from "@/lib/text";
import type { RemoteBoard } from "./leaderboard";

export type PaceMedal = "gold" | "silver" | "bronze";

/** Gran Turismo 7 Sport Mode Online Time Trial target thresholds relative to P1 (+3% gold, +5% silver, +10% bronze) */
export const PACE_MEDAL_PCT: Readonly<Record<PaceMedal, number>> = {
  gold: 0.03,
  silver: 0.05,
  bronze: 0.1,
};

/** Lap time ceiling (ms) for a pace medal tier given the board's leading time */
export function paceTargetMs(leaderMs: number, medal: PaceMedal): number {
  return Math.round(leaderMs * (1 + PACE_MEDAL_PCT[medal]));
}

/** Highest pace medal earned for `lapMs` against `leaderMs`, or null */
export function paceMedalOf(lapMs: number | null, leaderMs: number | null): PaceMedal | null {
  if (lapMs === null || leaderMs === null || leaderMs <= 0) return null;
  if (lapMs <= paceTargetMs(leaderMs, "gold")) return "gold";
  if (lapMs <= paceTargetMs(leaderMs, "silver")) return "silver";
  if (lapMs <= paceTargetMs(leaderMs, "bronze")) return "bronze";
  return null;
}

export interface ChallengeTarget {
  /** The player's best lap on the challenge's board (ms); null before their first */
  bestMs: number | null;
  /** The fastest lap on the board (ms); null on an empty board */
  leaderMs: number | null;
  /** The player's place; null without a lap */
  rank: number | null;
  /** How far the player's best is behind the place above (ms); null at the top or when not known */
  gapAboveMs: number | null;
  /** True when driving a permanent trial (such as Middle Gear Lap Board) rather than the rotating weekly challenge */
  permanent?: boolean;
}

/** The target from the challenge's board, as the server answered it for the player's name */
export function challengeTarget(board: RemoteBoard, opts: { permanent?: boolean } = {}): ChallengeTarget {
  const me = board.me;
  const leaderMs = board.entries[0]?.lapTimeMs ?? null;
  const permanent = opts.permanent ? { permanent: true as const } : {};
  if (!me) return { bestMs: null, leaderMs, rank: null, gapAboveMs: null, ...permanent };
  // The server says the time of the place above; an older one does not, and then the listed row stands in
  const aboveMs = me.rank > 1 ? (me.aboveMs ?? board.entries[me.rank - 2]?.lapTimeMs ?? null) : null;
  return {
    bestMs: me.entry.lapTimeMs,
    leaderMs: leaderMs ?? me.entry.lapTimeMs,
    rank: me.rank,
    gapAboveMs: aboveMs !== null ? Math.max(0, me.entry.lapTimeMs - aboveMs) : null,
    ...permanent,
  };
}

/** "P7 · 0.214 to P6", "P1 · fastest this week", "P1 · fastest on the board", or "No time yet" */
export function challengePlaceLabel(t: ChallengeTarget): string {
  if (t.rank === null) return tx("game.challenge.placeNoTime");
  if (t.rank === 1) return tx(t.permanent ? "game.challenge.placeFirstPermanent" : "game.challenge.placeFirst");
  if (t.gapAboveMs === null) return tx("game.challenge.place", { place: String(t.rank) });
  return tx("game.challenge.placeGap", { place: String(t.rank), gap: (t.gapAboveMs / 1000).toFixed(3), above: String(t.rank - 1) });
}
