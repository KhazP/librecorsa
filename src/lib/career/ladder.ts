/**
 * The career's ladders (iRacing's Career Mode, Project CARS 1's tiers): each discipline a run of series from club racing
 * to its top, some steps offered in three regions (Americas, Europe, Asia-Pacific) with their own calendars, and a
 * branch where two series lead on. A season in a series is won through by finishing inside its promotion places; the
 * series it leads to then open (`next`).
 *
 * Road: Club Cup (Suzuki Liana) → Touring Cup (VW Scirocco GTX) → Classic GT (Nissan R32 / R33) or Prototype Cup
 * (MTRacing 496R) → GT3 (BMW M4 / Mercedes-AMG) → Endurance Prototypes (LC-LMDH) → Grand Prix (2026 Prototype).
 * Historic: Procar Series (BMW M1 Procar) → Group 4 Classic (Porsche 934 RSR) → Can-Am Legends (Chaparral 2D).
 *
 * The AI field drives the player's own car (ai-opponents.ts), so a series with two cars is raced in the one the player
 * picks, by the whole grid. Calendars use circuits with a pit lane only (pit/pit-lane.ts); a circuit or car this build
 * does not list is left out (`seriesAvailable`).
 *
 * Pure data and arithmetic, no React.
 */
import type { CarId } from "@/lib/cars/car-registry";
import type { DamageLevel } from "@/lib/sim/car-damage";

export type CareerDisciplineId = "road" | "historic";
export type CareerRegion = "americas" | "europe" | "asiaPacific";
/** Series family: the name of a series in every region */
export type CareerSeriesFamily =
  | "clubCup"
  | "touringCup"
  | "classicGt"
  | "protoCup"
  | "gt3"
  | "endurance"
  | "grandPrix"
  | "procar"
  | "group4"
  | "canAm";

export type SeasonLength = "short" | "medium" | "long" | "full";
export type RaceLength = "short" | "medium" | "long" | "full";
export type AiLevel = "low" | "medium" | "high" | "expert";

export const SEASON_LENGTHS: readonly SeasonLength[] = ["short", "medium", "long", "full"];
export const RACE_LENGTHS: readonly RaceLength[] = ["short", "medium", "long", "full"];
export const AI_LEVELS: readonly AiLevel[] = ["low", "medium", "high", "expert"];

export interface CareerSeries {
  id: string;
  family: CareerSeriesFamily;
  discipline: CareerDisciplineId;
  /** Column on the ladder (0 = where a career starts) */
  tier: number;
  region?: CareerRegion;
  /** The cars it is raced in (the player picks one; the grid races the same) */
  cars: readonly CarId[];
  /** Its circuits, the best first: a shorter season races the first ones (or the player's own pick) */
  calendar: readonly string[];
  /** A race's full distance (km); shorter race lengths are a share of it */
  raceKm: number;
  /** Cars on the grid, the player's included, by default */
  grid: number;
  /** AI skill (0-100) of its field at the High level */
  skill: number;
  /** Promotion: finish the season in this place or better */
  promoteTop: number;
  /** Stops a race requires, by race length (absent: none) */
  stops?: Partial<Record<RaceLength, number>>;
  /** The series a promotion opens */
  next: readonly string[];
  /** The top of its ladder: promotion here completes the career */
  final?: boolean;
}

const AMERICAS_SHORT = ["vir_patriot", "watkins_glen_short", "riverside_short", "speedvegas", "vir_south", "bridgehampton", "vir_north"];
const EUROPE_SHORT = ["sachsenring_short", "spielberg_south", "oschersleben", "norisring", "grobnik", "sachsenring"];
const ASIA_SHORT = ["rwanda_official_short", "okayama_piper", "barbagallo", "okayama", "chang"];

export const CAREER_SERIES: readonly CareerSeries[] = [
  // ---- Road: club racing in a road car, by region (the Liana or the Golf-based Scirocco, the player's pick)
  ...(["americas", "europe", "asiaPacific"] as const).map<CareerSeries>((region) => ({
    id: `clubCup_${region}`,
    family: "clubCup",
    discipline: "road",
    tier: 0,
    region,
    cars: ["liana", "vw-scirocco-gtx"],
    calendar: region === "americas" ? AMERICAS_SHORT : region === "europe" ? EUROPE_SHORT : ASIA_SHORT,
    raceKm: 40,
    grid: 8,
    skill: 70,
    promoteTop: 3,
    next: [`touringCup_${region}`],
  })),
  ...(["americas", "europe", "asiaPacific"] as const).map<CareerSeries>((region) => ({
    id: `touringCup_${region}`,
    family: "touringCup",
    discipline: "road",
    tier: 1,
    region,
    // A real touring car, a step up from the club's road cars
    cars: ["nissan-r32-jtcc"],
    calendar:
      region === "americas"
        ? ["vir_north", "watkins_glen_short", "riverside", "bridgehampton", "speedvegas", "vir_patriot_reverse", "vir_south"]
        : region === "europe"
          ? ["sachsenring", "spielberg_south", "oschersleben", "norisring", "grobnik", "sachsenring_short"]
          : ["okayama", "barbagallo", "rwanda_official_short", "chang", "okayama_piper"],
    raceKm: 60,
    grid: 8,
    skill: 74,
    promoteTop: 3,
    next: ["classicGt", "protoCup"],
  })),
  {
    id: "classicGt",
    family: "classicGt",
    discipline: "road",
    tier: 2,
    cars: ["nissan-r33-jgtc"],
    calendar: ["okayama", "chang", "sachsenring", "riverside", "barbagallo", "watkins_glen", "norisring", "le_mans_82"],
    raceKm: 90,
    grid: 10,
    skill: 78,
    promoteTop: 4,
    stops: { long: 1, full: 1 },
    next: ["gt3_americas", "gt3_europe", "gt3_asiaPacific"],
  },
  {
    id: "protoCup",
    family: "protoCup",
    discipline: "road",
    tier: 2,
    cars: ["mtr-496r"],
    calendar: ["vir", "oschersleben", "spielberg_south", "okayama", "rwanda_official_short", "watkins_glen_short", "grobnik"],
    raceKm: 80,
    grid: 10,
    skill: 78,
    promoteTop: 4,
    stops: { long: 1, full: 1 },
    next: ["endurance", "gt3_americas", "gt3_europe", "gt3_asiaPacific"],
  },
  ...(["americas", "europe", "asiaPacific"] as const).map<CareerSeries>((region) => ({
    id: `gt3_${region}`,
    family: "gt3",
    discipline: "road",
    tier: 3,
    region,
    cars: ["bmw-m4-gt3", "amg-gt3"],
    calendar:
      region === "americas"
        ? ["vir", "watkins_glen", "riverside", "vir_grand_east", "bridgehampton", "vir_grand_west"]
        : region === "europe"
          ? ["spielberg", "sachsenring", "istanbul_park", "norisring", "grobnik", "le_mans_82", "oschersleben"]
          : ["chang", "okayama", "rwanda_official", "barbagallo", "qiddiya"],
    raceKm: 120,
    grid: 10,
    // Above the ladder's step of 4 (endurance races at 86): at 82 the leader planned on 0.95-0.97 of the grip the AMG
    // drives cleanly, 2-4 % off real 2024 GT3 poles. At 88 its planned lap is 0.3-0.6 s quicker (Spielberg 89.0 →
    // 88.4 s, pole 87.9), and in 45 headless races the field spun less (72 → 53) and touched less (170 → 99)
    skill: 88,
    promoteTop: 4,
    stops: { medium: 1, long: 1, full: 1 },
    next: ["endurance"],
  })),
  {
    id: "endurance",
    family: "endurance",
    discipline: "road",
    tier: 4,
    cars: ["lc-lmdh"],
    calendar: ["le_mans_82", "spielberg", "watkins_glen", "chang", "istanbul_park", "vir_grand_west", "rwanda_official", "qiddiya"],
    raceKm: 240,
    grid: 10,
    skill: 86,
    promoteTop: 4,
    stops: { short: 1, medium: 1, long: 2, full: 2 },
    next: ["grandPrix"],
  },
  {
    id: "grandPrix",
    family: "grandPrix",
    discipline: "road",
    tier: 5,
    cars: ["lc26"],
    calendar: ["rwanda_official", "spielberg", "istanbul_park", "monaco", "chang", "qiddiya", "watkins_glen", "sachsenring", "vir_grand_east", "okayama"],
    raceKm: 305,
    grid: 12,
    skill: 90,
    promoteTop: 3,
    stops: { medium: 1, long: 1, full: 1 },
    next: [],
    final: true,
  },
  // ---- Historic
  {
    id: "procar",
    family: "procar",
    discipline: "historic",
    tier: 0,
    cars: ["bmw-m1-procar"],
    calendar: ["norisring", "spielberg", "watkins_glen", "riverside", "oschersleben", "okayama", "le_mans_82"],
    raceKm: 60,
    grid: 8,
    skill: 74,
    promoteTop: 3,
    next: ["group4"],
  },
  {
    id: "group4",
    family: "group4",
    discipline: "historic",
    tier: 1,
    cars: ["porsche-934-rsr"],
    calendar: ["le_mans_82", "watkins_glen", "riverside", "norisring", "spielberg", "sachsenring", "bridgehampton"],
    raceKm: 100,
    grid: 10,
    skill: 80,
    promoteTop: 4,
    stops: { long: 1, full: 1 },
    next: ["canAm"],
  },
  {
    id: "canAm",
    family: "canAm",
    discipline: "historic",
    tier: 2,
    cars: ["chaparral-2d", "chaparral-2d-67"],
    calendar: ["riverside", "bridgehampton", "watkins_glen", "vir", "willow_springs", "riverside_short"],
    raceKm: 150,
    grid: 10,
    skill: 86,
    promoteTop: 3,
    stops: { long: 1, full: 1 },
    next: [],
    final: true,
  },
];

export const CAREER_DISCIPLINES: readonly CareerDisciplineId[] = ["road", "historic"];

export function seriesById(id: string): CareerSeries | undefined {
  return CAREER_SERIES.find((s) => s.id === id);
}

export function seriesOf(discipline: CareerDisciplineId): CareerSeries[] {
  return CAREER_SERIES.filter((s) => s.discipline === discipline);
}

/** Where a career in a discipline starts: its first column */
export function startingSeries(discipline: CareerDisciplineId): CareerSeries[] {
  return CAREER_SERIES.filter((s) => s.discipline === discipline && s.tier === 0);
}

/** What this build can race: the circuits it lists and the cars it has */
export interface CareerContent {
  tracks: ReadonlySet<string>;
  cars: ReadonlySet<string>;
}

/** A series' calendar and cars this build has */
export function seriesContent(series: CareerSeries, content: CareerContent): { calendar: string[]; cars: CarId[] } {
  return {
    calendar: series.calendar.filter((id) => content.tracks.has(id)),
    cars: series.cars.filter((id) => content.cars.has(id)),
  };
}

/** A series can be raced: one of its cars and three of its circuits are in this build */
export function seriesAvailable(series: CareerSeries, content: CareerContent): boolean {
  const c = seriesContent(series, content);
  return c.cars.length > 0 && c.calendar.length >= 3;
}

/** Rounds in a season of this length out of a calendar of `circuits` */
export function roundsFor(length: SeasonLength, circuits: number): number {
  const share = { short: 0.4, medium: 0.6, long: 0.8, full: 1 }[length];
  return Math.max(Math.min(3, circuits), Math.min(circuits, Math.round(circuits * share)));
}

/** Laps of a race of this length on a circuit of `lapM` metres */
export function lapsFor(series: CareerSeries, length: RaceLength, lapM: number): number {
  const share = { short: 0.25, medium: 0.5, long: 0.75, full: 1 }[length];
  // Never under three laps: a start, a race and a last lap
  return Math.max(3, Math.min(60, Math.round((series.raceKm * 1000 * share) / Math.max(800, lapM))));
}

/** Stops a race requires: by the series and length, and never in a race too short to make one */
export function stopsFor(series: CareerSeries, length: RaceLength, laps: number): number {
  // A stop needs a race long enough to spread the field's over several laps: one from five laps, two from eight
  const n = series.stops?.[length] ?? 0;
  return Math.min(n, laps >= 8 ? 2 : laps >= 5 ? 1 : 0);
}

/** AI skill for the field: the series' own at High, less at Low and Medium, more at Expert */
export function aiSkillFor(series: CareerSeries, level: AiLevel): number {
  const offset = { low: -16, medium: -8, high: 0, expert: 7 }[level];
  return Math.max(20, Math.min(100, series.skill + offset));
}

/** Championship points by finishing place (the F1 scale) */
export const CAREER_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;
export const pointsFor = (position: number): number => CAREER_POINTS[position - 1] ?? 0;

/** Default damage for a series' race settings */
export const DEFAULT_CAREER_DAMAGE: DamageLevel = "reduced";
