/**
 * The official result of a multiplayer race. Each car reports its finish once (a `finish` message); the race server
 * (cloudflare/api/race.ts), or a room's host, keeps the reports in a result book, classifies them with the game's own
 * running order (src/lib/sim/race-order.ts) and sends `result`: provisional as the finishes come in, final once every
 * car on the grid has finished or RESULT_CLOSE_MS after the first finish, with the rest DNF.
 *
 * The book is plain data, so the race server can keep it in its storage. No three.js and no DOM: the Worker imports
 * this file.
 */
import { raceOrder, type RacerProgress } from "../sim/race-order";
import type { ControlMessage, OfficialResultRow, RaceStartInfo } from "./wire";

/** The result is final this long after the first finish, as the game's own classification closes (ms) */
export const RESULT_CLOSE_MS = 90_000;
/** A report may claim a finish this much later than the race clock of whoever checks it allows (s): clocks differ */
const FINISH_CLOCK_SLACK_S = 10;

export type FinishMessage = Extract<ControlMessage, { type: "finish" }>;
export type ResultMessage = Extract<ControlMessage, { type: "result" }>;

export interface FinishReport {
  /** Race time at the flag (s), penalties not added */
  timeS: number;
  penaltyS: number;
  laps: number;
  bestLapMs: number | null;
}

export interface ResultBook {
  id: string;
  /** Peer ids in grid order */
  grid: string[];
  laps: number;
  reports: Record<string, FinishReport>;
  /** The keeper's clock (ms) at the first finish accepted; null before one */
  firstFinishMs: number | null;
  final: boolean;
}

export const newResultBook = (start: Pick<RaceStartInfo, "id" | "grid" | "laps">): ResultBook => ({
  id: start.id,
  grid: [...start.grid],
  laps: start.laps,
  reports: {},
  firstFinishMs: null,
  final: false,
});

export interface FinishCheck {
  /** No lap of this race is believable under this (s) */
  minLapS: number;
  /** Race time by the keeper's clock (s since lights out) */
  raceTimeS: number;
  /** The car has sent its state during the race */
  sentState: boolean;
}

/** Null when `peer`'s report may go in the book, else why not */
export function finishProblem(book: ResultBook, peer: string, f: FinishMessage, check: FinishCheck): string | null {
  if (f.id !== book.id) return "another race";
  if (!book.grid.includes(peer)) return "not on the grid";
  if (book.final) return "the result is final";
  if (!check.sentState) return "no state from this car";
  if (f.laps < 1 || f.laps > book.laps) return "laps out of range";
  if (f.timeS < check.minLapS * f.laps) return "faster than a lap can be";
  if (f.timeS > check.raceTimeS + FINISH_CLOCK_SLACK_S) return "finished in the future";
  return null;
}

/** Puts a report in the book at the keeper's clock `nowMs`; false when the car already has one (the first stands) */
export function addFinish(book: ResultBook, peer: string, f: FinishMessage, nowMs: number): boolean {
  if (book.reports[peer]) return false;
  book.reports[peer] = { timeS: f.timeS, penaltyS: f.penaltyS, laps: f.laps, bestLapMs: f.bestLapMs };
  book.firstFinishMs ??= nowMs;
  return true;
}

/** When the result turns final unless everyone is in sooner (the keeper's clock, ms); null before a finish or once final */
export const resultCloseMs = (book: ResultBook): number | null =>
  book.final || book.firstFinishMs === null ? null : book.firstFinishMs + RESULT_CLOSE_MS;

/** True when the result should turn final now: everyone on the grid has finished, or the close time has come */
export function resultDue(book: ResultBook, nowMs: number): boolean {
  const close = resultCloseMs(book);
  if (close === null) return false;
  return nowMs >= close || book.grid.every((p) => book.reports[p] !== undefined);
}

/** What the keeper knows of a car still out: its race distance (m) and laps done, for the order of the cars still out */
export type CarProgress = (peer: string) => { distM: number; laps?: number } | undefined;

/**
 * The classification: finishers by laps then time (penalties included), then the cars still out by distance (DNF
 * once final), ties on the grid
 */
export function resultRows(book: ResultBook, final: boolean, progress?: CarProgress): OfficialResultRow[] {
  const field: RacerProgress[] = book.grid.map((peer, i) => {
    const f = book.reports[peer];
    return {
      id: peer,
      code: "",
      name: "",
      color: "",
      isPlayer: false,
      distM: progress?.(peer)?.distM ?? -i,
      speedMs: 0,
      finishTimeS: f ? f.timeS : null,
      penaltyS: f?.penaltyS,
      finishLaps: f?.laps,
      bestLapMs: f?.bestLapMs ?? null,
      grid: i,
    };
  });
  return raceOrder(field).map((r, i) => {
    const f = book.reports[r.id];
    return {
      peer: r.id,
      position: i + 1,
      timeS: f ? f.timeS + f.penaltyS : null,
      penaltyS: f?.penaltyS ?? 0,
      laps: f ? f.laps : Math.max(0, Math.min(book.laps, Math.floor(progress?.(r.id)?.laps ?? 0))),
      bestLapMs: f?.bestLapMs ?? null,
      dnf: final && !f,
      grid: (r.grid ?? 0) + 1,
    };
  });
}

/** The `result` message for the book as it stands */
export const resultMessage = (book: ResultBook, progress?: CarProgress): ResultMessage => ({
  type: "result",
  id: book.id,
  final: book.final,
  rows: resultRows(book, book.final, progress),
});
