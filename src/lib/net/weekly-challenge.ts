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
 * The circuits raced on, with the 2026 prototype's ideal lap there (s, from the game's speed planner). Only the
 * project's own circuit and circuits used with their author's permission: none converted from a Sketchfab model
 * (`quality: "sketchfab"` in public/tracks/index.json).
 */
const CIRCUITS: readonly { trackId: string; lapS: number }[] = [
  { trackId: "rwanda_official_short", lapS: 91 },
  { trackId: "spielberg", lapS: 69 },
  { trackId: "chang", lapS: 76 },
  { trackId: "okayama_piper", lapS: 43 },
  { trackId: "rwanda_official", lapS: 105 },
  { trackId: "monaco", lapS: 76 },
  { trackId: "okayama", lapS: 73 },
  { trackId: "spielberg_south", lapS: 45 },
];
/** The cars, with their lap time as a multiple of the prototype's */
const CARS: readonly { vehicle: VehicleModelId; pace: number }[] = [
  { vehicle: "vf26", pace: 1 },
  { vehicle: "amg-gt3", pace: 1.2 },
  { vehicle: "mtr-496r", pace: 1.22 },
  { vehicle: "liana", pace: 1.9 },
];
/** A race lasts about this long (s); drivers are taken to lap a little off the ideal */
const RACE_TARGET_S = 600;
const DRIVER_PACE = 1.06;
const raceLaps = (lapS: number, pace: number): number => Math.max(3, Math.round(RACE_TARGET_S / (lapS * pace * DRIVER_PACE)));

/** Every fourth week is for no assists and the full simulation; the others have some assists so anyone can set a time */
const weekRules = (week: number): Pick<ChallengeRules, "assists" | "realism"> =>
  week % 4 === 3 ? { assists: "pro", realism: "full" } : { assists: "semi_pro", realism: "standard" };

/**
 * The weeks, in order, then round again: the first entry is the week of 9 November 2026.
 *
 * Each round of nine weeks opens with the time trial of the Suzuki Liana at Dunsfold. Dunsfold is not raced on, so
 * that week's races are at RISE Motordrome's Grand Prix layout in the prototype. Then come the eight circuits, each
 * with the next car along from the round before, so over four rounds every circuit is driven in every car.
 */
export const CHALLENGE_ROTATION: readonly ChallengeRules[] = Array.from({ length: (1 + CIRCUITS.length) * CARS.length }, (_, week) => {
  const round = Math.floor(week / (1 + CIRCUITS.length));
  const slot = week % (1 + CIRCUITS.length);
  if (slot === 0) {
    const home = CIRCUITS[4];
    return { trackId: "dunsfold", vehicle: "liana", ...weekRules(week), race: { trackId: home.trackId, vehicle: CARS[0].vehicle, laps: raceLaps(home.lapS, CARS[0].pace) } };
  }
  const circuit = CIRCUITS[slot - 1];
  const car = CARS[(slot - 1 + round) % CARS.length];
  return { trackId: circuit.trackId, vehicle: car.vehicle, ...weekRules(week), race: { trackId: circuit.trackId, vehicle: car.vehicle, laps: raceLaps(circuit.lapS, car.pace) } };
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
  vf26: { compound: "soft", label: "Soft tyres" },
  "f12026-car": { compound: "soft", label: "Soft tyres" },
  "amg-gt3": { compound: "soft", label: "Soft tyres" },
  "mtr-496r": { compound: "soft", label: "Soft tyres" },
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
