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
 * The weeks, in order, then round again: the first entry is the week of 9 November 2026. Mostly with some assists
 * and standard realism so anyone can set a time; every few weeks one for no assists and the full simulation.
 *
 * Only the project's own circuit and circuits used with their author's permission: none converted from a Sketchfab
 * model (`quality: "sketchfab"` in public/tracks/index.json), and not Dunsfold, which has no permission on record.
 * The race laps make a race of about ten minutes in that car.
 */
export const CHALLENGE_ROTATION: readonly ChallengeRules[] = [
  { trackId: "rwanda_official_short", vehicle: "vf26", assists: "semi_pro", realism: "standard", raceLaps: 6 },
  { trackId: "rwanda_official", vehicle: "vf26", assists: "pro", realism: "full", raceLaps: 5 },
  { trackId: "spielberg", vehicle: "amg-gt3", assists: "semi_pro", realism: "standard", raceLaps: 7 },
  { trackId: "chang", vehicle: "mtr-496r", assists: "semi_pro", realism: "standard", raceLaps: 6 },
  { trackId: "okayama_piper", vehicle: "liana", assists: "semi_pro", realism: "standard", raceLaps: 7 },
  { trackId: "monaco", vehicle: "amg-gt3", assists: "semi_pro", realism: "standard", raceLaps: 6 },
  { trackId: "okayama", vehicle: "mtr-496r", assists: "pro", realism: "full", raceLaps: 6 },
  { trackId: "spielberg_south", vehicle: "liana", assists: "semi_pro", realism: "standard", raceLaps: 7 },
];

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 1 January 1970 was a Thursday: the Monday of that week is three days before the epoch */
const FIRST_MONDAY_MS = -3 * DAY_MS;

/** Weeks since the Monday before the epoch */
const weekIndex = (nowMs: number): number => Math.floor((nowMs - FIRST_MONDAY_MS) / WEEK_MS);
/** The week the rotation's first entry ran: Monday 9 November 2026 */
const ROTATION_FIRST_WEEK = weekIndex(Date.UTC(2026, 10, 9));

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
  const n = CHALLENGE_ROTATION.length;
  const rules = CHALLENGE_ROTATION[(((index - ROTATION_FIRST_WEEK) % n) + n) % n];
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
