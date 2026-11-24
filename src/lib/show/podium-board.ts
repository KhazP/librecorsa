/**
 * The full-screen podium after an offline AI race (hud/PodiumBoard.tsx draws it, render/podium-shot.ts says when):
 * the top three, the rest of the top ten, the race's fastest lap and, in a career round, what the round did to the
 * player's championship. Pure and language-free: built from the classification as it stands (cars still running keep
 * their place until they finish) and, in a career round, the show context the career armed (its rivals' names and
 * numbers, the championship before the round).
 */
import type { RaceResultEntry } from "@/types/f1";
import type { ShowContext, ShowDriver } from "@/lib/show/show-context";
import { pointsFor } from "@/lib/career/ladder";

/** The board's rows go down to this place; the player's own row follows when further back */
export const BOARD_LAST_PLACE = 10;

/** The time or gap a row shows, as the results table words it */
export type BoardGap =
  /** The winner's race time (s) */
  | { kind: "time"; s: number }
  /** Behind the winner (s) */
  | { kind: "gap"; s: number }
  | { kind: "laps"; count: number }
  | { kind: "running" }
  | { kind: "dnf" }
  | { kind: "dsq" };

export interface BoardEntry {
  position: number;
  /** Names, number and colour: the career's rival, or the result's own name and code */
  driver: ShowDriver;
  gap: BoardGap;
}

export interface BoardChampionship {
  /** Points the player scored this round */
  points: number;
  /** The player's points after the round */
  total: number;
  /**
   * The player's place after the round; null while a car that can still score is running, or when level on points
   * with another (the tie-breaks are the career's to settle)
   */
  position: number | null;
  /** The player's place before the round; null on the first round */
  was: number | null;
}

export interface PodiumBoardData {
  /** P1, P2, P3 (the cars that finished there) */
  podium: BoardEntry[];
  /** P4 down to P10, then the player's row when further back */
  rest: BoardEntry[];
  /** The last row of `rest` is the player's, apart from the top ten */
  playerApart: boolean;
  /** The race's fastest lap (the results table's: the quickest best lap of the field) */
  fastest: { driver: ShowDriver; ms: number } | null;
  /** Career rounds: the round's effect on the player's championship */
  championship: BoardChampionship | null;
}

const out = (r: RaceResultEntry) => r.dnf || Boolean(r.dq);
/** The player's line in the championship, whatever code they race under */
const PLAYER: unique symbol = Symbol("player");

/** The row's time or gap: the winner's race time, +gap, +laps, Running, DNF or DSQ (as RaceResults.tsx) */
export function boardGap(r: RaceResultEntry, resultsFinal: boolean): BoardGap {
  if (r.dq) return { kind: "dsq" };
  if (r.dnf) return { kind: "dnf" };
  if (r.finishTimeS === null) return resultsFinal ? { kind: "dnf" } : { kind: "running" };
  if (r.position === 1) return { kind: "time", s: r.finishTimeS };
  if (r.lapsDown > 0) return { kind: "laps", count: r.lapsDown };
  if (r.gapS !== null) return { kind: "gap", s: r.gapS };
  return { kind: "time", s: r.finishTimeS };
}

/** The result's driver: the career's rival (or the player) by code, else the result's own name and code */
export function boardDriver(ctx: ShowContext | null, r: RaceResultEntry): ShowDriver {
  const d = ctx?.drivers[r.driverCode];
  if (d) return { ...d, color: d.color || r.teamColorHex, isPlayer: r.isPlayer };
  return { code: r.driverCode, first: "", last: r.name || r.driverCode, number: null, color: r.teamColorHex, isPlayer: r.isPlayer };
}

/**
 * The player's championship after this round, from the standings before it and the points every car scores in this
 * classification (the career's scale; a retirement or a disqualification scores none). Null outside a career round.
 */
export function boardChampionship(ctx: ShowContext | null, results: readonly RaceResultEntry[], resultsFinal: boolean): BoardChampionship | null {
  if (!ctx) return null;
  const me = results.find((r) => r.isPlayer);
  if (!me) return null;
  const scored = (r: RaceResultEntry) => (out(r) ? 0 : pointsFor(r.position));
  const key = (code: string, isPlayer: boolean): string | typeof PLAYER => (isPlayer ? PLAYER : code);
  const totals = new Map<string | typeof PLAYER, number>();
  for (const s of ctx.standings) totals.set(key(s.code, s.isPlayer), s.points);
  for (const r of results) {
    const k = key(r.driverCode, r.isPlayer);
    totals.set(k, (totals.get(k) ?? 0) + scored(r));
  }
  const mine = totals.get(PLAYER) ?? 0;
  // A car still running in the points can still change places (and points) with another
  const settled = resultsFinal || results.every((r) => r.position > BOARD_LAST_PLACE || r.finishTimeS !== null || out(r));
  let ahead = 0;
  let level = false;
  for (const [k, total] of totals) {
    if (k === PLAYER) continue;
    if (total > mine) ahead++;
    else if (total === mine) level = true;
  }
  const before = ctx.roundIndex > 0 ? (ctx.standings.find((s) => s.isPlayer)?.position ?? null) : null;
  return { points: scored(me), total: mine, position: settled && !level ? ahead + 1 : null, was: before };
}

/** The board for this classification; null without a top three that finished */
export function podiumBoard(results: readonly RaceResultEntry[] | undefined, resultsFinal: boolean, ctx: ShowContext | null): PodiumBoardData | null {
  if (!results?.length) return null;
  const ordered = [...results].sort((a, b) => a.position - b.position);
  const entry = (r: RaceResultEntry): BoardEntry => ({ position: r.position, driver: boardDriver(ctx, r), gap: boardGap(r, resultsFinal) });
  const podium = ordered.filter((r) => r.position <= 3 && r.finishTimeS !== null && !out(r)).map(entry);
  if (podium.length === 0) return null;
  const rest = ordered.filter((r) => r.position > 3 && r.position <= BOARD_LAST_PLACE).map(entry);
  const me = ordered.find((r) => r.isPlayer);
  const playerApart = Boolean(me && me.position > BOARD_LAST_PLACE);
  if (me && playerApart) rest.push(entry(me));
  let fastest: RaceResultEntry | null = null;
  for (const r of ordered) if (r.bestLapMs !== null && r.bestLapMs > 0 && (!fastest || r.bestLapMs < (fastest.bestLapMs ?? Infinity))) fastest = r;
  return {
    podium,
    rest,
    playerApart,
    fastest: fastest?.bestLapMs ? { driver: boardDriver(ctx, fastest), ms: fastest.bestLapMs } : null,
    championship: boardChampionship(ctx, ordered, resultsFinal),
  };
}
