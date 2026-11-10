/**
 * The weekly challenge: one circuit and car for everyone, with the assists and realism fixed and a dry track, from
 * Monday 00:00 UTC to the next. It has its own online board (the lap also counts on the open one), and its scheduled
 * races run on the same circuit and car.
 *
 * Everything here follows from the clock alone, so the game and the server (cloudflare/api) agree on the week
 * without asking each other. No three.js, no DOM: the Worker imports this file.
 */
import type { AssistPreset, VehicleModelId } from "@/types/f1";
import { PHYSICS_VERSION, type LapConditions } from "@/lib/sim/lap-types";
import type { SimRealism } from "@/lib/sim/sim-realism";

export interface ChallengeRules {
  trackId: string;
  vehicle: VehicleModelId;
  assists: AssistPreset;
  realism: SimRealism;
  /** Laps of the week's scheduled races */
  raceLaps: number;
}

export interface WeeklyChallenge extends ChallengeRules {
  /** ISO week, "2026-W46": the id of its board */
  id: string;
  startsMs: number;
  endsMs: number;
}

/**
 * The weeks, in order, then round again. Mostly with some assists and standard realism so anyone can set a time;
 * every few weeks one for no assists and the full simulation.
 */
export const CHALLENGE_ROTATION: readonly ChallengeRules[] = [
  { trackId: "rwanda", vehicle: "vf26", assists: "semi_pro", realism: "standard", raceLaps: 5 },
  { trackId: "monza", vehicle: "amg-gt3", assists: "semi_pro", realism: "standard", raceLaps: 5 },
  { trackId: "spa", vehicle: "vf26", assists: "pro", realism: "full", raceLaps: 4 },
  { trackId: "dunsfold", vehicle: "liana", assists: "semi_pro", realism: "standard", raceLaps: 6 },
  { trackId: "silverstone", vehicle: "mtr-496r", assists: "semi_pro", realism: "standard", raceLaps: 5 },
  { trackId: "suzuka", vehicle: "vf26", assists: "semi_pro", realism: "standard", raceLaps: 5 },
  { trackId: "spielberg", vehicle: "amg-gt3", assists: "pro", realism: "full", raceLaps: 8 },
  { trackId: "sepang", vehicle: "mtr-496r", assists: "semi_pro", realism: "standard", raceLaps: 5 },
  { trackId: "yas_marina", vehicle: "amg-gt3", assists: "semi_pro", realism: "standard", raceLaps: 6 },
  { trackId: "okayama", vehicle: "liana", assists: "pro", realism: "full", raceLaps: 6 },
];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 1 January 1970 was a Thursday: the Monday of that week is three days before the epoch */
const FIRST_MONDAY_MS = -3 * DAY_MS;

/** Weeks since the Monday before the epoch */
const weekIndex = (nowMs: number): number => Math.floor((nowMs - FIRST_MONDAY_MS) / WEEK_MS);

/** ISO 8601 week of the week starting on `mondayMs`, "2026-W46" (a week belongs to the year of its Thursday) */
export function isoWeekId(mondayMs: number): string {
  const thursday = new Date(mondayMs + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The challenge running at `nowMs` */
export function challengeAt(nowMs: number): WeeklyChallenge {
  const index = weekIndex(nowMs);
  const startsMs = FIRST_MONDAY_MS + index * WEEK_MS;
  const rules = CHALLENGE_ROTATION[((index % CHALLENGE_ROTATION.length) + CHALLENGE_ROTATION.length) % CHALLENGE_ROTATION.length];
  return { ...rules, id: isoWeekId(startsMs), startsMs, endsMs: startsMs + WEEK_MS };
}

/** True when a lap driven on this circuit and car under these conditions is a lap of the challenge */
export function fitsChallenge(lap: { trackId: string; vehicle: string; conditions?: LapConditions }, c: ChallengeRules): boolean {
  const k = lap.conditions;
  return (
    lap.trackId === c.trackId &&
    lap.vehicle === c.vehicle &&
    k !== undefined &&
    k.assists === c.assists &&
    k.realism === c.realism &&
    k.surface === "dry" &&
    k.physicsVersion === PHYSICS_VERSION
  );
}

/** Null when `lap` may go on the board of challenge `eventId` at `nowMs`, else why not */
export function challengeProblem(lap: { trackId: string; vehicle: string; conditions?: LapConditions }, eventId: string, nowMs: number): string | null {
  const now = challengeAt(nowMs);
  if (eventId !== now.id) return "That weekly challenge has ended";
  return fitsChallenge(lap, now) ? null : "This lap was not driven to this week's challenge rules";
}

/** "3 d 4 h", "5 h 12 min", "8 min": time left until `endsMs` */
export function timeLeftLabel(endsMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((endsMs - nowMs) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
