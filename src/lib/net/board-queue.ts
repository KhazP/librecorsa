/**
 * Posting laps to the online board, and sending again the ones that couldn't reach it (issue #122).
 *
 * A lap that got no answer from the board is remembered as a failed upload marked `retry` (leaderboard.ts
 * `saveBoardMiss`), and its recording is held for the session. Once the board answers again (online-config.ts), the
 * game calls `flushQueuedLaps`: each such lap goes up once, one after another, from the recording held here or, after
 * a reload, from its board's saved best when it is that very lap. A lap the board turns down is not sent again by
 * itself, and neither is one that has had its tries: Your best laps keeps it with Retry.
 *
 * Kept free of React and the scene, so scripts/verify-board-retry.ts drives the same code the game does.
 */
import type { VehicleModelId } from "@/types/f1";
import { lapGoesOnBoards, type LapRecording } from "@/lib/sim/lap-types";
import { challengeAt, fitsChallenge } from "./weekly-challenge";
import {
  BOARD_UNREACHABLE_GAVE_UP,
  boardKeyOf,
  clearBoardMiss,
  MOD_LAP,
  queuedBoardMisses,
  saveBoardBest,
  saveBoardMiss,
  saveChallengeBest,
  settleBoardMiss,
  submitLap,
  type QueuedMiss,
  type SubmitResult,
} from "./leaderboard";

/**
 * Laps sent from the queue in one go. A queue holds at most one lap per board (circuit, car and class), so a few cover
 * a session; the rest go on the next flush. With BOARD_LIMIT at 20 a minute and 30 an hour per address on the board
 * (cloudflare/api/board.ts), a flush never spends more than a sixth of the hour's uploads
 */
export const FLUSH_MAX_LAPS = 5;
/**
 * Sends of one lap from the queue in a session before the game stops trying by itself. Only a send counts: while the
 * board itself is out of reach nothing is sent, and the lap waits for as long as the session lasts. When the board
 * answers but the uploads don't, each upload with no answer makes the next try wait longer (online-config.ts
 * `markUnreachable`): sends about 5, 15, 35, 75 and 135 s after the first failure, so about three minutes of trying
 */
export const FLUSH_MAX_TRIES = 5;

/** How a lap went up: by itself (automatic posting), or because the player pressed Post */
export type PostedBy = "auto" | "hand";

/** Recordings of the laps waiting this session, by board: one that isn't the saved best has no other copy */
const held = new Map<string, LapRecording>();
/** Sends of each waiting lap from the queue this session, by `${board}|${recordedAt}` */
const tries = new Map<string, number>();

/** The weekly challenge a lap was driven to (its id), if it fits this week's */
export function challengeOf(rec: LapRecording, nowMs = Date.now()): string | undefined {
  const week = challengeAt(nowMs);
  return fitsChallenge(rec, week) ? week.id : undefined;
}

/**
 * Uploads a lap under the driver's name now, to this week's challenge board too when it fits; remembers the lap each
 * board took (or refused for a faster one of the driver's), so only a faster one is sent next time. A lap that
 * couldn't reach the board is kept to send again; one turned down is remembered with the reason (Your best laps).
 */
export async function postLap(rec: LapRecording, driver: { name: string; code: string }, by: PostedBy): Promise<SubmitResult> {
  // A lap with mod content never goes up, and isn't kept as a miss either: a mod car's would sit on its model's board
  if (!lapGoesOnBoards(rec)) return { ok: false, error: MOD_LAP };
  // Under the name the driver has now: a lap recorded before a rename must not claim the old name back
  const named: LapRecording = { ...rec, driverName: driver.name, driverCode: driver.code };
  const event = challengeOf(named);
  const res = await submitLap(named, { event }).catch((): SubmitResult => ({ ok: false }));
  if (res.ok && event && res.eventRank !== undefined) saveChallengeBest(event, rec.lapTimeMs);
  const board = boardKeyOf(named);
  if (board && (res.ok || res.notFaster)) {
    saveBoardBest(board, rec.lapTimeMs);
    clearBoardMiss(board, rec.lapTimeMs);
    const waiting = held.get(board);
    if (waiting && waiting.lapTimeMs >= rec.lapTimeMs) held.delete(board);
  } else if (!res.ok) {
    // Your best laps says so, and why, after the lap card is gone; a lap that never reached the board waits to go up
    saveBoardMiss(rec, res.error ?? "Could not reach the leaderboard", res.unreachable ? by : undefined);
    if (res.unreachable && board) {
      const known = held.get(board);
      if (!known || rec.lapTimeMs <= known.lapTimeMs) held.set(board, rec);
    }
  }
  return res;
}

export interface FlushOptions {
  /** The name laps go up under now; null while it can't be used (refused here, or taken on the board) */
  driver: () => { name: string; code: string } | null;
  /** Automatic posting is on: laps it queued may go up. Laps the player sent by hand always may */
  autoUpload: () => boolean;
  /** A board's saved best (ghost-store `loadBestLap`) */
  loadBest: (trackId: string, vehicle: VehicleModelId, board: string) => Promise<LapRecording | null>;
  /** Called with each lap sent and the board's answer, as it comes */
  onPosted?: (rec: LapRecording, res: SubmitResult) => void;
}

/** The recording of a waiting lap: held this session, else its board's saved best when it is that lap; null when gone */
async function recordingOf(miss: QueuedMiss, loadBest: FlushOptions["loadBest"]): Promise<LapRecording | null> {
  const same = (r: LapRecording | null | undefined): r is LapRecording =>
    !!r && r.lapTimeMs === miss.lapTimeMs && r.recordedAt === miss.recordedAt;
  const kept = held.get(miss.key);
  if (same(kept)) return kept;
  const best = await loadBest(miss.trackId, miss.vehicle, miss.board).catch(() => null);
  return same(best) ? best : null;
}

let flushing: Promise<number> | null = null;

/**
 * Sends the laps that couldn't reach the board, oldest first, one at a time (FLUSH_MAX_LAPS at most). Stops at the
 * first that still gets no answer, or is turned away for too many uploads. One flush at a time: a call while one runs
 * gets that one. Resolves with the number of laps sent.
 */
export function flushQueuedLaps(opts: FlushOptions): Promise<number> {
  flushing ??= runFlush(opts).finally(() => {
    flushing = null;
  });
  return flushing;
}

async function runFlush(opts: FlushOptions): Promise<number> {
  let sent = 0;
  for (const miss of queuedBoardMisses()) {
    if (sent >= FLUSH_MAX_LAPS) break;
    if (miss.retry === "auto" && !opts.autoUpload()) continue;
    const driver = opts.driver();
    if (!driver) break;
    const rec = await recordingOf(miss, opts.loadBest);
    if (!rec) {
      // Neither held nor the saved best any more (a reload, a faster lap since): nothing left to send
      settleBoardMiss(miss.key, miss.recordedAt, BOARD_UNREACHABLE_GAVE_UP);
      continue;
    }
    const id = `${miss.key}|${miss.recordedAt}`;
    const n = tries.get(id) ?? 0;
    if (n >= FLUSH_MAX_TRIES) {
      settleBoardMiss(miss.key, miss.recordedAt, BOARD_UNREACHABLE_GAVE_UP);
      held.delete(miss.key);
      continue;
    }
    tries.set(id, n + 1);
    sent++;
    const res = await postLap(rec, driver, miss.retry);
    opts.onPosted?.(rec, res);
    if (res.unreachable || res.limited) break;
  }
  return sent;
}

/** Forgets the session's held laps and tries (the verify suite runs several sessions in one process) */
export function resetLapQueueForTests(): void {
  held.clear();
  tries.clear();
}
