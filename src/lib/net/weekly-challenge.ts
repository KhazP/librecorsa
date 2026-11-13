/**
 * The weekly challenge: one circuit and car for everyone, with the assists and realism fixed, a dry track at full
 * grip, one tyre per car and the lowest fuel load, from Monday 00:00 UTC to the next. It has its own online board (the lap also counts on the open one). The week's
 * scheduled races are on the same circuit and car, except in a week whose circuit is for time trials only.
 *
 * Everything here follows from the clock alone, so the game and the server (cloudflare/api) agree on the week
 * without asking each other. No three.js, no DOM: the Worker imports this file.
 */
import type { AssistPreset, TireCompound, VehicleModelId } from "@/types/f1";
import { lapPhysicsVersion, type LapConditions } from "@/lib/sim/lap-types";
import type { SimRealism } from "@/lib/sim/sim-realism";

export interface ChallengeRules {
  trackId: string;
  vehicle: VehicleModelId;
  assists: AssistPreset;
  realism: SimRealism;
  /** The week's scheduled races: their circuit, car and laps */
  race: { trackId: string; vehicle: VehicleModelId; laps: number };
}

export interface WeeklyChallenge extends ChallengeRules {
  /** ISO week, "2026-W46": the id of its board */
  id: string;
  startsMs: number;
  endsMs: number;
}

/**
 * The circuits, with the 2026 prototype's ideal lap there (s, from the game's speed planner). Only the project's own
 * circuit and circuits used with their author's permission: none converted from a Sketchfab model
 * (`quality: "sketchfab"` in public/tracks/index.json), and no hill climb (a week's races need a lap).
 */
const LAP_S = {
  rwanda_official_short: 91,
  rwanda_official: 105,
  spielberg: 69,
  spielberg_south: 45,
  chang: 76,
  okayama: 73,
  okayama_piper: 43,
  monaco: 76,
  le_mans_82: 198,
  istanbul_park: 95,
  vir: 85,
  oschersleben: 69,
  sachsenring: 64,
  grobnik: 64,
  norisring: 42,
  barbagallo: 43,
} as const;
type Circuit = keyof typeof LAP_S;
/** Dunsfold is for time trials only: that week's races are here, in the 2026 prototype */
const HOME: Circuit = "rwanda_official";
/** The cars, with their lap time as a multiple of the prototype's */
const PACE = {
  lc26: 1,
  "lc-lmdh": 1.15,
  "amg-gt3": 1.2,
  "mtr-496r": 1.22,
  "nissan-r33-jgtc": 1.3,
  "nissan-r32-jtcc": 1.4,
  liana: 1.9,
} as const satisfies Partial<Record<VehicleModelId, number>>;
type Car = keyof typeof PACE;
/** A race lasts about this long (s); drivers are taken to lap a little off the ideal */
const RACE_TARGET_S = 600;
const DRIVER_PACE = 1.06;
const raceLaps = (lapS: number, pace: number): number => Math.max(3, Math.round(RACE_TARGET_S / (lapS * pace * DRIVER_PACE)));

/** Every fourth week is for no assists and the full simulation; the others have some assists so anyone can set a time */
const weekRules = (week: number): Pick<ChallengeRules, "assists" | "realism"> =>
  week % 4 === 3 ? { assists: "pro", realism: "full" } : { assists: "semi_pro", realism: "standard" };

/**
 * The weeks, in order, then round again: the first entry is the week of 9 November 2026, the last the week of
 * 4 October 2027. Written out by hand, a circuit with a car that belongs there, and where a real race weekend at a
 * circuit falls in one of these weeks, that week is on it in the nearest car. The dates only hold for this first time
 * round: write the next list before this one starts again.
 *
 * Dunsfold is not raced on, so in its weeks the races are at RISE Motordrome's Grand Prix layout in the prototype.
 */
const WEEKS: readonly (readonly [Circuit | "dunsfold", Car])[] = [
  ["dunsfold", "liana"], // 9 Nov 2026
  ["le_mans_82", "lc-lmdh"], // 16 Nov
  ["spielberg", "amg-gt3"], // 23 Nov
  ["chang", "mtr-496r"], // 30 Nov
  ["monaco", "liana"], // 7 Dec
  ["rwanda_official", "amg-gt3"], // 14 Dec
  ["okayama", "nissan-r32-jtcc"], // 21 Dec
  ["grobnik", "lc26"], // 28 Dec
  ["oschersleben", "nissan-r33-jgtc"], // 4 Jan 2027
  ["rwanda_official_short", "lc26"], // 11 Jan
  ["vir", "lc-lmdh"], // 18 Jan
  ["sachsenring", "mtr-496r"], // 25 Jan
  ["okayama_piper", "liana"], // 1 Feb
  ["istanbul_park", "amg-gt3"], // 8 Feb
  ["barbagallo", "nissan-r32-jtcc"], // 15 Feb
  ["spielberg", "lc-lmdh"], // 22 Feb
  ["chang", "lc26"], // 1 Mar
  ["norisring", "nissan-r33-jgtc"], // 8 Mar
  ["spielberg_south", "liana"], // 15 Mar
  ["rwanda_official", "mtr-496r"], // 22 Mar
  ["okayama", "nissan-r33-jgtc"], // 29 Mar: the GT season opens here on 3-4 Apr
  ["istanbul_park", "lc-lmdh"], // 5 Apr
  ["dunsfold", "liana"], // 12 Apr
  ["spielberg", "amg-gt3"], // 19 Apr: GT3 race weekend, 23-25 Apr
  ["chang", "amg-gt3"], // 26 Apr: GT3 race weekend, 1-2 May
  ["oschersleben", "amg-gt3"], // 3 May: GT3 race weekend, 7-9 May
  ["sachsenring", "lc26"], // 10 May
  ["vir", "mtr-496r"], // 17 May
  ["barbagallo", "liana"], // 24 May
  ["monaco", "lc26"], // 31 May: the grand prix, 4-6 Jun
  ["le_mans_82", "lc-lmdh"], // 7 Jun: the 24 hours, 12-13 Jun
  ["sachsenring", "nissan-r32-jtcc"], // 14 Jun
  ["rwanda_official_short", "lc-lmdh"], // 21 Jun
  ["norisring", "amg-gt3"], // 28 Jun: GT3 race weekend, 2-4 Jul
  ["spielberg", "lc26"], // 5 Jul: the grand prix, 9-11 Jul
  ["okayama_piper", "nissan-r32-jtcc"], // 12 Jul
  ["chang", "nissan-r33-jgtc"], // 19 Jul
  ["rwanda_official", "lc-lmdh"], // 26 Jul
  ["okayama", "amg-gt3"], // 2 Aug: GT3 race weekend, 7-8 Aug
  ["grobnik", "mtr-496r"], // 9 Aug
  ["vir", "amg-gt3"], // 16 Aug: GT race weekend, 20-22 Aug
  ["spielberg_south", "nissan-r32-jtcc"], // 23 Aug
  ["oschersleben", "mtr-496r"], // 30 Aug
  ["rwanda_official_short", "amg-gt3"], // 6 Sep
  ["barbagallo", "nissan-r33-jgtc"], // 13 Sep
  ["sachsenring", "amg-gt3"], // 20 Sep: GT3 race weekend, 24-26 Sep
  ["istanbul_park", "lc26"], // 27 Sep: the grand prix, 1-3 Oct
  ["le_mans_82", "mtr-496r"], // 4 Oct
];
export const CHALLENGE_ROTATION: readonly ChallengeRules[] = WEEKS.map(([trackId, vehicle], week) => {
  const [raceTrack, raceCar]: readonly [Circuit, Car] = trackId === "dunsfold" ? [HOME, "lc26"] : [trackId, vehicle];
  return { trackId, vehicle, ...weekRules(week), race: { trackId: raceTrack, vehicle: raceCar, laps: raceLaps(LAP_S[raceTrack], PACE[raceCar]) } };
});

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

/**
 * The one tyre a car runs in the challenge: the softest dry compound it has. Every car's softest dry slot is its
 * "soft" (the Liana's street tyre fills every slot, so "soft" is that tyre). Listed here, not read from the car
 * configs, because the Worker imports this file.
 */
const CHALLENGE_TYRES: Readonly<Record<VehicleModelId, { compound: TireCompound; label: string }>> = {
  lc26: { compound: "soft", label: "Soft tyres" },
  "f12026-car": { compound: "soft", label: "Soft tyres" },
  "amg-gt3": { compound: "soft", label: "Soft tyres" },
  "mtr-496r": { compound: "soft", label: "Soft tyres" },
  "lc-lmdh": { compound: "soft", label: "Soft tyres" },
  liana: { compound: "soft", label: "Street tyres" },
  "nissan-r33-jgtc": { compound: "soft", label: "Soft tyres" },
  "nissan-r32-jtcc": { compound: "soft", label: "Soft tyres" },
};

/** The compound every lap of a challenge in this car is driven on */
export function challengeCompound(vehicle: VehicleModelId): TireCompound {
  return CHALLENGE_TYRES[vehicle].compound;
}

/** The challenge's rules in a few words: "Dry track · Soft tyres · Low fuel" */
export function challengeConditionsLabel(vehicle: VehicleModelId): string {
  return `Dry track · ${CHALLENGE_TYRES[vehicle].label} · Low fuel`;
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
    k.compound === challengeCompound(c.vehicle) &&
    k.physicsVersion === lapPhysicsVersion(c.vehicle)
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
