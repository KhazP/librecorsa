/**
 * A player's careers (iRacing's Career Mode): each a run up one discipline's ladder (ladder.ts), a season at a time.
 *
 * - **A season** starts in pre-season: the series picked, the car, the calendar's length and circuits, and the
 *   mulligans chosen. Starting the season locks those.
 * - **Test days**: optional practice in the season's car on the next round's circuit (the first before the season
 *   starts), at any time: the laps run and the best clean lap against a target, the pace of the promotion places, kept
 *   on the season per circuit and car. Race settings (race length,
 *   AI level, damage, grid size, qualifying) can change before any round.
 * - **Promotion**: finish the season inside the series' promotion places. Miss them and the season is raced again (an
 *   attempt used); three seasons missed in the same series end the career. Promotion at the top of a ladder completes it.
 * - **Mulligans**: a round raced again, its result thrown away (a restart, or a race left early). Fewer allowed is worth
 *   more score.
 * - **Bonus objectives**: three per season, from a pool, their targets fitted to the grid and the calendar.
 * - **Score** (iRacing's scheme, in this game's numbers): each race scores the result, the grid, laps led, laps
 *   completed and a clean race, times a multiplier of the challenge (AI level, damage, race length). A season adds its
 *   championship place, its objectives and a first-time clear, times a multiplier for the attempts it took. The career
 *   score is the seasons' sum.
 *
 * Saved as one localStorage key (`librecorsa.career`), synced in the account's cloud save (account/save-model.ts).
 * Pure: no React, no DOM besides the save.
 */
import type { CarId } from "@/lib/cars/car-registry";
import type { DamageLevel } from "@/lib/sim/car-damage";
import type { QualifyingMinutes } from "@/lib/sim/qualifying";
import type { TimeOfDayId, WeatherPresetId } from "@/lib/sim/weather";
import { aiSkillModifiers } from "@/lib/sim/ai-tuning";
import { aiQualifyingMs } from "@/lib/sim/qualifying";
import {
  CAREER_SERIES,
  aiSkillFor,
  lapsFor,
  pointsFor,
  roundsFor,
  seriesById,
  stopsFor,
  type AiLevel,
  type CareerContent,
  type CareerDisciplineId,
  type CareerSeries,
  type RaceLength,
  type SeasonLength,
  seriesContent,
} from "./ladder";
import { careerRng, drawGrid, makeRivals, rivalCode, rivalPace, type CareerRival } from "./rivals";

export const CAREER_STORAGE_KEY = "librecorsa.career";
export const MAX_ATTEMPTS = 3;
export const MAX_MULLIGANS = 6;

export type ObjectiveKind = "poleThreat" | "qualifyPro" | "podiumThreat" | "consistent" | "cleanRacer" | "leadTheCharge" | "putInTheWork" | "fastestLap";

export interface BonusObjective {
  kind: ObjectiveKind;
  /** The target (a place, an average place, a count of races or laps, by kind) */
  target: number;
}

export interface RaceSettings {
  raceLength: RaceLength;
  aiLevel: AiLevel;
  damage: DamageLevel;
  /** Cars on the grid, the player's included */
  gridSize: number;
  qualifying: QualifyingMinutes;
}

export interface SeasonSettings {
  length: SeasonLength;
  /** The circuits raced, in order */
  circuits: string[];
  mulligans: number;
  car: CarId;
}

/** A finisher's line in a round: a rival (by id) or the player ("me") */
export interface RoundLine {
  who: string;
  position: number;
  points: number;
  dnf?: boolean;
}

export interface RoundResult {
  trackId: string;
  laps: number;
  position: number;
  grid: number;
  points: number;
  lapsCompleted: number;
  lapsLed: number;
  fastestLap: boolean;
  penaltyS: number;
  dnf: boolean;
  /** The race's score (after its multiplier) */
  score: number;
  /** The race's multiplier */
  mult: number;
  /** The whole field's places */
  lines: RoundLine[];
}

export interface SeasonState {
  seriesId: string;
  attempt: number;
  /** Started (the season's settings locked) */
  started: boolean;
  settings: SeasonSettings;
  race: RaceSettings;
  /** The rivals on the grid (ids) */
  grid: string[];
  /** One per circuit: null until raced */
  rounds: (RoundResult | null)[];
  mulligansUsed: number;
  objectives: BonusObjective[];
  /** Rivals carried over from the season before (promoted alongside) */
  carried: string[];
  /**
   * The round under way (its index), saved at its start: a round left without a result (the tab closed, a crash) is
   * settled the next time the career opens, a mulligan or a retirement, never a free run again
   */
  racing?: number;
  /** The season's test days, one per circuit and car (absent before the first, and in saves from before they were kept) */
  tests?: TestDayResult[];
}

/** A season's test day on one circuit in one car: its laps, the player's best, the lap aimed at */
export interface TestDayResult {
  trackId: string;
  car: CarId;
  /** Laps completed, on the autopilot too */
  laps: number;
  /** The best clean lap the player drove themselves (ms); null without one */
  bestMs: number | null;
  /** The lap aimed at (ms, `testTargetMs`); null where no reference lap could be had */
  targetMs: number | null;
}

export interface SeasonRecord {
  seriesId: string;
  attempt: number;
  car: CarId;
  position: number;
  points: number;
  promoted: boolean;
  objectivesDone: number;
  objectivesTotal: number;
  mulligansUsed: number;
  rounds: number;
  wins: number;
  podiums: number;
  score: number;
  endedAt: number;
  /** The season kept for its page in the history (absent in saves from before it was kept) */
  archive?: {
    circuits: string[];
    rounds: (RoundResult | null)[];
    standings: StandingRow[];
    objectives: { kind: ObjectiveKind; target: number; done: boolean }[];
    parts: SeasonScoreParts;
    alongside: string[];
    race: RaceSettings;
  };
}

export type CareerStatus = "active" | "complete" | "over";

export interface CareerRun {
  id: string;
  discipline: CareerDisciplineId;
  status: CareerStatus;
  seed: number;
  startedAt: number;
  updatedAt: number;
  rivals: CareerRival[];
  history: SeasonRecord[];
  /** The season under way (null between a promotion and the next series' choice, or once the career is over) */
  season: SeasonState | null;
  /** After a promotion: the series the player may go on to */
  choices: string[];
  score: number;
  /** Rivals this career has raced with (a new grid takes new faces first) */
  raced: string[];
  /** The season just finished, kept for the next one: its race settings and who moved up with the player */
  lastSeason?: SeasonState | null;
}

export interface CareerSave {
  v: 1;
  runs: CareerRun[];
  /** The career shown when the career screen opens */
  activeId: string | null;
  /** Careers deleted (their ids): another device's copy does not bring them back when the saves combine */
  removed?: string[];
}

export const EMPTY_SAVE: CareerSave = { v: 1, runs: [], activeId: null };

export const DEFAULT_RACE_SETTINGS: Omit<RaceSettings, "gridSize"> = {
  raceLength: "short",
  aiLevel: "medium",
  damage: "reduced",
  qualifying: 5,
};

// ---- Standings

export interface StandingRow {
  who: string;
  points: number;
  wins: number;
  podiums: number;
  /** Rounds raced (with a place) */
  starts: number;
  best: number;
}

/** The championship after the rounds raced: points, then wins, then podiums, then the best finish */
export function seasonStandings(season: SeasonState): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  const row = (who: string) => {
    let r = rows.get(who);
    if (!r) rows.set(who, (r = { who, points: 0, wins: 0, podiums: 0, starts: 0, best: 99 }));
    return r;
  };
  row("me");
  for (const id of season.grid) row(id);
  for (const round of season.rounds) {
    if (!round) continue;
    for (const l of round.lines) {
      const r = row(l.who);
      r.points += l.points;
      r.starts++;
      if (!l.dnf) {
        if (l.position === 1) r.wins++;
        if (l.position <= 3) r.podiums++;
        r.best = Math.min(r.best, l.position);
      }
    }
  }
  return [...rows.values()].sort(
    (a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.best - b.best || (a.who === "me" ? -1 : b.who === "me" ? 1 : 0)
  );
}

/** Promotion places with this grid: the series' own, scaled when the grid is smaller */
export function promotionPlaces(series: CareerSeries, gridSize: number): number {
  return Math.max(1, Math.round((series.promoteTop * gridSize) / series.grid));
}

// ---- Objectives

const POOL: readonly ObjectiveKind[] = ["poleThreat", "qualifyPro", "podiumThreat", "consistent", "cleanRacer", "leadTheCharge", "putInTheWork", "fastestLap"];

/** Objectives of one kind of skill: a season draws one from each of three kinds, never two of the same */
const CATEGORIES: readonly (readonly ObjectiveKind[])[] = [
  ["poleThreat", "qualifyPro"],
  ["podiumThreat", "consistent"],
  ["fastestLap", "leadTheCharge"],
  ["cleanRacer", "putInTheWork"],
];

/**
 * Three objectives for a season, drawn by its seed from three kinds of skill, their targets fitted to the grid, the
 * rounds and the laps. Without qualifying the grid is the back of the field, so no grid objective is drawn
 */
export function drawObjectives(
  seed: number,
  gridSize: number,
  rounds: number,
  final: boolean,
  opts: { qualifying?: boolean; seasonLaps?: number } = {}
): BonusObjective[] {
  const rng = careerRng(seed);
  const kinds = CATEGORIES.map((c) => c.filter((k) => opts.qualifying !== false || (k !== "poleThreat" && k !== "qualifyPro"))).filter((c) => c.length);
  const out: BonusObjective[] = [];
  while (out.length < 3 && kinds.length) {
    const cat = kinds.splice(Math.floor(rng() * kinds.length), 1)[0];
    const kind = cat[Math.floor(rng() * cat.length)];
    out.push({ kind, target: objectiveTarget(kind, gridSize, rounds, final, opts.seasonLaps ?? rounds * 5) });
  }
  return out;
}

function objectiveTarget(kind: ObjectiveKind, grid: number, rounds: number, final: boolean, seasonLaps: number): number {
  switch (kind) {
    case "poleThreat":
      return grid >= 10 ? 3 : 2;
    case "qualifyPro":
      return Math.max(2, Math.round(grid * 0.45 * 10) / 10);
    case "podiumThreat":
      return final ? 2 : 3;
    case "consistent":
      return Math.max(2, Math.round(grid * 0.4 * 10) / 10);
    case "cleanRacer":
      return Math.max(1, Math.ceil(rounds * 0.6));
    case "leadTheCharge":
      return Math.max(2, Math.round(seasonLaps * 0.2));
    case "putInTheWork":
      return 90;
    case "fastestLap":
      return 1;
  }
}

export interface ObjectiveProgress {
  done: boolean;
  /** Can no longer be done this season */
  failed: boolean;
  /** Not done yet, but where it stands would do it by the season's end */
  onPace: boolean;
  /** Where it stands (a place, an average, a count), null before any round */
  value: number | null;
}

/** Where an objective stands after the rounds raced */
export function objectiveProgress(o: BonusObjective, season: SeasonState): ObjectiveProgress {
  const raced = season.rounds.filter((r): r is RoundResult => r !== null);
  const n = raced.length;
  const left = season.rounds.length - n;
  const total = season.rounds.length || 1;
  // Averages to one decimal, as shown and as judged: the reach check rounds the same way, or a season P1 in every round
  // left would still complete could read failed first
  const tenth = (v: number) => Math.round(v * 10) / 10;
  const avg = (xs: number[]) => (xs.length ? tenth(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  /** An average out of reach: even P1 in every round left would not bring it to the target */
  const averageOut = (xs: number[]) => n > 0 && tenth((xs.reduce((a, b) => a + b, 0) + left) / total) > o.target;
  const once = (best: number | null) => {
    const done = best !== null && best <= o.target;
    return { value: best, done, failed: left === 0 && !done, onPace: false };
  };
  switch (o.kind) {
    case "poleThreat":
      return once(n ? Math.min(...raced.map((r) => r.grid)) : null);
    case "podiumThreat":
      return once(n ? Math.min(...raced.map((r) => (r.dnf ? 99 : r.position))) : null);
    case "qualifyPro":
    case "consistent": {
      const xs = raced.map((r) => (o.kind === "qualifyPro" ? r.grid : r.dnf ? season.race.gridSize : r.position));
      const v = avg(xs);
      const done = left === 0 && v !== null && v <= o.target;
      const failed = (left === 0 && !done) || averageOut(xs);
      return { value: v, done, failed, onPace: !done && !failed && v !== null && v <= o.target };
    }
    case "cleanRacer": {
      const c = raced.filter((r) => !r.dnf && r.penaltyS <= 0).length;
      const done = c >= o.target;
      return { value: c, done, failed: c + left < o.target, onPace: !done && n > 0 && (c / n) * total >= o.target };
    }
    case "leadTheCharge": {
      const c = raced.reduce((a, r) => a + r.lapsLed, 0);
      const done = c >= o.target;
      return { value: c, done, failed: left === 0 && !done, onPace: !done && n > 0 && (c / n) * total >= o.target };
    }
    case "putInTheWork": {
      const laps = raced.reduce((a, r) => a + r.laps, 0);
      const ran = raced.reduce((a, r) => a + r.lapsCompleted, 0);
      const pct = laps ? Math.round((ran / laps) * 100) : null;
      const done = left === 0 && pct !== null && pct >= o.target;
      return { value: pct, done, failed: left === 0 && !done, onPace: !done && left > 0 && pct !== null && pct >= o.target };
    }
    case "fastestLap": {
      const c = raced.filter((r) => r.fastestLap).length;
      const done = c >= o.target;
      return { value: c, done, failed: left === 0 && !done, onPace: false };
    }
  }
}

// ---- Score

const AI_MULT: Record<AiLevel, number> = { low: 8, medium: 14, high: 20, expert: 26 };
const DAMAGE_MULT: Record<DamageLevel, number> = { off: 0, reduced: 1, full: 3 };
const LENGTH_MULT: Record<RaceLength, number> = { short: 0, medium: 2, long: 4, full: 6 };

/** A race's multiplier and what makes it up: the challenge the player took on */
export function raceMultiplierParts(race: RaceSettings): { ai: number; damage: number; length: number; total: number } {
  const ai = AI_MULT[race.aiLevel];
  const damage = DAMAGE_MULT[race.damage];
  const length = LENGTH_MULT[race.raceLength];
  return { ai, damage, length, total: ai + damage + length };
}

export function raceMultiplier(race: RaceSettings): number {
  return raceMultiplierParts(race).total;
}

/** The season's bonus for allowing fewer mulligans than the most */
export const mulliganBonus = (mulligans: number): number => Math.max(0, MAX_MULLIGANS - mulligans) * 300;

export interface RaceScoreParts {
  finish: number;
  grid: number;
  led: number;
  completed: number;
  clean: number;
  podium: number;
  total: number;
  mult: number;
  score: number;
}

/** A race's score: the result and how it was got, times its multiplier */
export function raceScore(
  r: Pick<RoundResult, "position" | "grid" | "lapsLed" | "lapsCompleted" | "laps" | "penaltyS" | "dnf">,
  gridSize: number,
  race: RaceSettings
): RaceScoreParts {
  const finish = r.dnf ? 0 : Math.max(0, gridSize + 1 - r.position) * 12;
  const grid = Math.max(0, gridSize + 1 - r.grid) * 4;
  const led = r.lapsLed * 5;
  const completed = Math.round((100 * r.lapsCompleted) / Math.max(1, r.laps));
  // A clean race in full; one with a small penalty (up to 3 s) in part
  const clean = r.dnf ? 0 : r.penaltyS <= 0 ? 40 : r.penaltyS <= 3 ? 15 : 0;
  const podium = r.dnf ? 0 : r.position === 1 ? 60 : r.position <= 3 ? 25 : 0;
  const total = finish + grid + led + completed + clean + podium;
  const mult = raceMultiplier(race);
  return { finish, grid, led, completed, clean, podium, total, mult, score: total * mult };
}

export interface SeasonScoreParts {
  races: number;
  championship: number;
  points: number;
  objectives: number;
  firstClear: number;
  mulligans: number;
  mult: number;
  score: number;
}

/** A season's score: its races and its result, times a multiplier for the attempts it took */
export function seasonScore(season: SeasonState, series: CareerSeries, promoted: boolean): SeasonScoreParts {
  const rows = seasonStandings(season);
  const place = rows.findIndex((r) => r.who === "me") + 1;
  const me = rows[place - 1];
  const races = season.rounds.reduce((a, r) => a + (r?.score ?? 0), 0);
  const championship = Math.max(0, season.race.gridSize + 1 - place) * 400;
  const points = (me?.points ?? 0) * 20;
  const objectives = season.objectives.filter((o) => objectiveProgress(o, season).done).length * 2000;
  const firstClear = promoted && season.attempt === 1 ? 10000 : 0;
  const mulligans = mulliganBonus(season.settings.mulligans);
  const mult = Math.max(3, 7 - season.attempt);
  return { races, championship, points, objectives, firstClear, mulligans, mult, score: (races + championship + points + objectives + firstClear + mulligans) * mult };
}

// ---- Careers

const now = () => Date.now();

/** What a season's race settings start from: the series' grid within what this game can run */
function raceSettingsFor(series: CareerSeries, prev?: RaceSettings, prevSeries?: CareerSeries): RaceSettings {
  // The series' own grid; the same series again keeps the player's; a player who ran the last series with fewer cars than
  // its own (for the frame rate) runs this one as many short
  const short = prev && prevSeries ? Math.max(0, prevSeries.grid - prev.gridSize) : 0;
  const grid = prev && prevSeries?.id === series.id ? prev.gridSize : series.grid - short;
  return { ...DEFAULT_RACE_SETTINGS, ...(prev ?? {}), gridSize: Math.max(4, Math.min(series.grid, grid, 12)) };
}

/** A new season in a series: pre-season, the calendar's first circuits, the series' first car */
export function newSeason(run: CareerRun, seriesId: string, content: CareerContent, attempt = 1, prev?: SeasonState): SeasonState | null {
  const series = seriesById(seriesId);
  if (!series) return null;
  const { calendar, cars } = seriesContent(series, content);
  if (!cars.length || calendar.length < 3) return null;
  const length: SeasonLength = prev?.settings.length ?? "medium";
  const n = roundsFor(length, calendar.length);
  const race = raceSettingsFor(series, prev?.race, prev ? seriesById(prev.seriesId) : undefined);
  const used = new Set(run.raced ?? []);
  const carried = attempt > 1 && prev ? prev.grid : (prev?.carried ?? []);
  const gridSeed = run.seed ^ (run.history.length * 7919) ^ (attempt * 104729);
  const grid = drawGrid(run.rivals, race.gridSize - 1, carried, used, gridSeed);
  const circuits = prev && prev.seriesId === seriesId ? prev.settings.circuits.filter((c) => calendar.includes(c)) : calendar.slice(0, n);
  return {
    seriesId,
    attempt,
    started: false,
    settings: {
      length,
      circuits: circuits.length >= 3 ? circuits : calendar.slice(0, n),
      mulligans: prev?.settings.mulligans ?? 3,
      car: prev && cars.includes(prev.settings.car) ? prev.settings.car : cars[0],
    },
    race,
    grid,
    rounds: [],
    mulligansUsed: 0,
    objectives: [],
    carried,
  };
}

/** A new career in a discipline, starting in `seriesId` */
export function newCareer(discipline: CareerDisciplineId, seriesId: string, content: CareerContent, seed = Math.floor(Math.random() * 2 ** 31)): CareerRun | null {
  const run: CareerRun = {
    id: `c${seed.toString(36)}${now().toString(36)}`,
    discipline,
    status: "active",
    seed,
    startedAt: now(),
    updatedAt: now(),
    rivals: makeRivals(seed),
    history: [],
    season: null,
    choices: [],
    score: 0,
    raced: [],
  };
  const season = newSeason(run, seriesId, content);
  if (!season) return null;
  run.season = season;
  // The other starting series (regions) stay open until the first season starts
  run.choices = CAREER_SERIES.filter((s) => s.discipline === discipline && s.tier === 0 && seriesContent(s, content).cars.length && seriesContent(s, content).calendar.length >= 3).map((s) => s.id);
  return run;
}

/** Pre-season changes: the series (among the choices), the car, the season's length and circuits, the mulligans */
export function updateSeasonSettings(run: CareerRun, patch: Partial<SeasonSettings>, content: CareerContent): CareerRun {
  const season = run.season;
  if (!season || season.started) return run;
  const series = seriesById(season.seriesId)!;
  const { calendar, cars } = seriesContent(series, content);
  const next = { ...season.settings, ...patch };
  if (!cars.includes(next.car)) next.car = cars[0];
  next.mulligans = Math.max(0, Math.min(MAX_MULLIGANS, Math.round(next.mulligans)));
  const n = roundsFor(next.length, calendar.length);
  if (patch.length && !patch.circuits) next.circuits = calendar.slice(0, n);
  next.circuits = [...new Set(next.circuits.filter((c) => calendar.includes(c)))];
  if (next.circuits.length !== n) {
    // Keep the player's picks and fill (or trim) to the season's length in calendar order
    const fill = calendar.filter((c) => !next.circuits.includes(c));
    next.circuits = [...next.circuits, ...fill].slice(0, n);
  }
  return touch({ ...run, season: { ...season, settings: next } });
}

/** Race settings: any time between rounds */
export function updateRaceSettings(run: CareerRun, patch: Partial<RaceSettings>): CareerRun {
  const season = run.season;
  if (!season) return run;
  const series = seriesById(season.seriesId)!;
  const race = { ...season.race, ...patch };
  // The grid's size is part of the season once it is under way (its drivers are drawn)
  race.gridSize = season.started ? season.race.gridSize : Math.max(4, Math.min(12, series.grid, Math.round(race.gridSize)));
  let grid = season.grid;
  if (!season.started && race.gridSize !== season.race.gridSize) {
    grid = drawGrid(run.rivals, race.gridSize - 1, season.carried, new Set(run.raced ?? []), run.seed ^ (run.history.length * 7919) ^ (season.attempt * 104729));
  }
  return touch({ ...run, season: { ...season, race, grid } });
}

/** Start the season: its settings locked, its rounds and objectives set */
export function startSeason(run: CareerRun): CareerRun {
  const season = run.season;
  if (!season || season.started) return run;
  const series = seriesById(season.seriesId)!;
  // The season's laps, near enough for the objectives' targets: each round at a mid-length lap
  const seasonLaps = season.settings.circuits.length * lapsFor(series, season.race.raceLength, 4000);
  const objectives = drawObjectives(
    run.seed ^ (run.history.length * 31) ^ season.attempt,
    season.race.gridSize,
    season.settings.circuits.length,
    Boolean(series.final),
    { qualifying: season.race.qualifying > 0, seasonLaps }
  );
  return touch({
    ...run,
    // The choice of series is made now
    choices: [],
    raced: [...new Set([...(run.raced ?? []), ...season.grid])],
    season: { ...season, started: true, rounds: season.settings.circuits.map(() => null), objectives, mulligansUsed: 0 },
  });
}

/**
 * Pick the series to race next: after a promotion, or at the start of a career, among the series open to the player.
 * Until the season starts the player can still change their mind (iRacing: try another path open at this level before
 * the first race), so the choices stay open until `startSeason`
 */
export function chooseSeries(run: CareerRun, seriesId: string, content: CareerContent): CareerRun {
  if (run.season?.started || !run.choices.includes(seriesId) || run.season?.seriesId === seriesId) return run;
  const attempt = 1;
  const season = newSeason(run, seriesId, content, attempt, run.history.length ? lastSeasonAsPrev(run) : undefined);
  if (!season) return run;
  return touch({ ...run, season });
}

/** The season just finished, as far as the next one keeps from it: race settings and who moves up */
function lastSeasonAsPrev(run: CareerRun): SeasonState | undefined {
  return run.lastSeason ?? undefined;
}

/** The round to race next (index), or null when the season is done */
export function nextRound(season: SeasonState): number | null {
  if (!season.started) return null;
  const i = season.rounds.findIndex((r) => r === null);
  return i < 0 ? null : i;
}

/**
 * A round's conditions, the same every time it is raced (from the career's seed): mostly dry, by day, with now and then
 * an overcast or a wet round in the series that race in all weathers; a circuit raced under lights keeps its night
 */
export function roundConditions(
  run: Pick<CareerRun, "seed" | "history">,
  seriesId: string,
  roundIndex: number,
  circuitNight: boolean
): { weather: WeatherPresetId; timeOfDay: TimeOfDayId } {
  const rng = careerRng(run.seed ^ (run.history.length * 7349) ^ ((roundIndex + 1) * 1597) ^ seriesId.length * 31);
  const family = seriesById(seriesId)?.family;
  const allWeather = family === "gt3" || family === "endurance" || family === "grandPrix" || family === "touringCup";
  const w = rng();
  const weather: WeatherPresetId = allWeather && w < 0.12 ? "light_rain" : w < (allWeather ? 0.3 : 0.15) ? "overcast" : "clear";
  const days: readonly TimeOfDayId[] = ["morning", "noon", "afternoon", "afternoon", "golden_hour"];
  const timeOfDay: TimeOfDayId = circuitNight ? "night" : days[Math.floor(rng() * days.length)];
  return { weather, timeOfDay };
}

// ---- Test days

/** Where a test day runs: the next round's circuit (the first before the season starts), and that round */
export function testCircuit(season: SeasonState): { trackId: string; roundIndex: number } | null {
  const roundIndex = season.started ? (nextRound(season) ?? 0) : 0;
  const trackId = season.settings.circuits[roundIndex];
  return trackId ? { trackId, roundIndex } : null;
}

/** The season's test day on a circuit in a car, once one has a lap */
export function seasonTest(season: SeasonState, trackId: string, car: CarId): TestDayResult | null {
  return season.tests?.find((t) => t.trackId === trackId && t.car === car) ?? null;
}

const better = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** Laps of a test day added to the season's on that circuit in that car: the laps summed, the better best, the newest target */
export function recordTestDay(run: CareerRun, add: TestDayResult): CareerRun {
  const season = run.season;
  if (!season || add.laps <= 0) return run;
  const tests = season.tests ?? [];
  const had = seasonTest(season, add.trackId, add.car);
  const merged: TestDayResult = had
    ? { ...had, laps: had.laps + add.laps, bestMs: better(had.bestMs, add.bestMs), targetMs: add.targetMs ?? had.targetMs }
    : { ...add };
  return touch({ ...run, season: { ...season, tests: had ? tests.map((t) => (t === had ? merged : t)) : [...tests, merged] } });
}

/**
 * The lap a test day aims at (ms): the qualifying lap the season's field would do here at the pace of its last
 * promotion place (the AI car the player must beat to finish inside the places), from a reference lap of the car on
 * the circuit (`refLapMs` at `refBase`, as qualifying takes the AI cars' laps from it: qualifying.ts). The field's
 * pace as the race sets it (ai-opponents.ts): each rival's own, spread and scaled by the series' AI level
 */
export function testTargetMs(run: CareerRun, refLapMs: number, refBase: number): number | null {
  const season = run.season;
  const series = season ? seriesById(season.seriesId) : undefined;
  if (!season || !series || !(refLapMs > 0) || !(refBase > 0)) return null;
  const mods = aiSkillModifiers(aiSkillFor(series, season.race.aiLevel));
  const paces = season.grid
    .map((id) => run.rivals.find((r) => r.id === id))
    .filter((r): r is CareerRival => Boolean(r))
    .map((r) => Math.min(0.999, (1 - (1 - rivalPace(r)) * mods.spread) * mods.paceMult))
    .sort((a, b) => b - a);
  if (!paces.length) return null;
  const places = promotionPlaces(series, season.race.gridSize);
  return aiQualifyingMs(refLapMs, refBase, paces[Math.min(paces.length - 1, Math.max(0, places - 1))]);
}

/** What the race of the next round is: its circuit, laps, stops, the field's skill and drivers */
export interface CareerRacePlan {
  roundIndex: number;
  trackId: string;
  laps: number;
  pitStops: number;
  aiSkill: number;
  damage: DamageLevel;
  qualifying: QualifyingMinutes;
  car: CarId;
  /** The rivals in grid order (ids), and the codes they race under */
  drivers: { id: string; code: string }[];
}

export function racePlan(run: CareerRun, lapLengthM: (trackId: string) => number, playerCode: string): CareerRacePlan | null {
  const season = run.season;
  if (!season) return null;
  const i = nextRound(season);
  if (i === null) return null;
  const series = seriesById(season.seriesId)!;
  const trackId = season.settings.circuits[i];
  const laps = lapsFor(series, season.race.raceLength, lapLengthM(trackId));
  return {
    roundIndex: i,
    trackId,
    laps,
    pitStops: stopsFor(series, season.race.raceLength, laps),
    aiSkill: aiSkillFor(series, season.race.aiLevel),
    damage: season.race.damage,
    qualifying: season.race.qualifying,
    car: season.settings.car,
    drivers: season.grid.map((id) => {
      const r = run.rivals.find((x) => x.id === id)!;
      return { id, code: rivalCode(r, playerCode) };
    }),
  };
}

/** A finished race as the race reports it: places by the code the race showed */
export interface RaceOutcome {
  /** In finishing order */
  results: { code: string; isPlayer: boolean; position: number; dnf?: boolean; dq?: boolean; gridPosition?: number; lapsCompleted?: number; bestLapMs?: number | null; penaltyS?: number }[];
  laps: number;
  lapsLed: number;
}

/** Record the next round's result (by the codes of the plan the race was run from) */
export function recordRound(run: CareerRun, plan: CareerRacePlan, outcome: RaceOutcome): CareerRun {
  const season = run.season;
  if (!season || nextRound(season) !== plan.roundIndex) return run;
  const byCode = new Map(plan.drivers.map((d) => [d.code, d.id]));
  const lines: RoundLine[] = [];
  let fastest: { who: string; ms: number } | null = null;
  for (const r of outcome.results) {
    const who = r.isPlayer ? "me" : byCode.get(r.code);
    if (!who) continue;
    const out = Boolean(r.dnf || r.dq);
    lines.push({ who, position: r.position, points: out ? 0 : pointsFor(r.position), dnf: out || undefined });
    if (!out && r.bestLapMs && (!fastest || r.bestLapMs < fastest.ms)) fastest = { who, ms: r.bestLapMs };
  }
  const me = outcome.results.find((r) => r.isPlayer);
  const dnf = !me || Boolean(me.dnf || me.dq);
  const base = {
    position: me?.position ?? season.race.gridSize,
    grid: me?.gridPosition ?? season.race.gridSize,
    lapsLed: outcome.lapsLed,
    lapsCompleted: me?.lapsCompleted ?? 0,
    laps: outcome.laps,
    penaltyS: me?.penaltyS ?? 0,
    dnf,
  };
  const sc = raceScore(base, season.race.gridSize, season.race);
  const result: RoundResult = {
    trackId: plan.trackId,
    ...base,
    points: lines.find((l) => l.who === "me")?.points ?? 0,
    fastestLap: fastest?.who === "me",
    score: sc.score,
    mult: sc.mult,
    lines,
  };
  const rounds = season.rounds.slice();
  rounds[plan.roundIndex] = result;
  return touch({ ...run, season: { ...season, rounds, racing: undefined } });
}

/** A mulligan: the round raced again (none recorded); null when none are left */
export function spendMulligan(run: CareerRun): CareerRun | null {
  const season = run.season;
  if (!season || season.mulligansUsed >= season.settings.mulligans) return null;
  return touch({ ...run, season: { ...season, mulligansUsed: season.mulligansUsed + 1, racing: undefined } });
}

/** The next round has started: kept in the save until it has a result or a mulligan */
export function markRoundStarted(run: CareerRun, roundIndex: number): CareerRun {
  const season = run.season;
  if (!season || nextRound(season) !== roundIndex) return run;
  return touch({ ...run, season: { ...season, racing: roundIndex } });
}

/** A round given up without a mulligan: the player out of it (last, no points), the field as it was not raced */
export function retireFromRound(run: CareerRun, plan: CareerRacePlan): CareerRun {
  const season = run.season;
  if (!season || nextRound(season) !== plan.roundIndex) return run;
  // The field's finish the round would likely have had: the quicker drivers first, with some luck in it
  const rng = careerRng(run.seed ^ (plan.roundIndex * 2654435761) ^ (run.history.length * 97));
  const order = plan.drivers
    .map((d) => ({ d, k: (run.rivals.find((r) => r.id === d.id)?.rating ?? 0.5) + (rng() - 0.5) * 0.5 }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.d);
  return recordRound(run, plan, {
    results: [
      ...order.map((d, i) => ({ code: d.code, isPlayer: false, position: i + 1, lapsCompleted: plan.laps })),
      { code: "", isPlayer: true, position: order.length + 1, dnf: true, lapsCompleted: 0 },
    ],
    laps: plan.laps,
    lapsLed: 0,
  });
}

export interface SeasonEnd {
  run: CareerRun;
  record: SeasonRecord;
  /** promoted (to `choices`), complete (top of the ladder), retry (another attempt), over (attempts used up) */
  outcome: "promoted" | "complete" | "retry" | "over";
  /** Rivals promoted with the player */
  alongside: string[];
  parts: SeasonScoreParts;
}

/** Close a season whose rounds are all raced */
export function endSeason(run: CareerRun, content: CareerContent): SeasonEnd | null {
  const season = run.season;
  if (!season || !season.started || nextRound(season) !== null) return null;
  const series = seriesById(season.seriesId)!;
  const rows = seasonStandings(season);
  const place = rows.findIndex((r) => r.who === "me") + 1;
  const places = promotionPlaces(series, season.race.gridSize);
  const promoted = place <= places;
  const parts = seasonScore(season, series, promoted);
  const me = rows[place - 1];
  const record: SeasonRecord = {
    seriesId: season.seriesId,
    attempt: season.attempt,
    car: season.settings.car,
    position: place,
    points: me?.points ?? 0,
    promoted,
    objectivesDone: season.objectives.filter((o) => objectiveProgress(o, season).done).length,
    objectivesTotal: season.objectives.length,
    mulligansUsed: season.mulligansUsed,
    rounds: season.rounds.length,
    wins: me?.wins ?? 0,
    podiums: me?.podiums ?? 0,
    score: parts.score,
    endedAt: now(),
    archive: {
      circuits: season.settings.circuits,
      rounds: season.rounds,
      standings: rows,
      objectives: season.objectives.map((o) => ({ kind: o.kind, target: o.target, done: objectiveProgress(o, season).done })),
      parts,
      alongside: [],
      race: season.race,
    },
  };
  // The best of the rest move up too (at most three), when the player does and there is a step up
  const alongside = promoted && !series.final ? rows.filter((r) => r.who !== "me").slice(0, Math.min(3, places)).map((r) => r.who) : [];
  record.archive!.alongside = alongside;
  const history = [...run.history, record];
  const score = run.score + parts.score;
  let next: CareerRun;
  let outcome: SeasonEnd["outcome"];
  if (promoted && series.final) {
    outcome = "complete";
    next = { ...run, history, score, season: null, choices: [], status: "complete", lastSeason: { ...season, carried: alongside } };
  } else if (promoted) {
    outcome = "promoted";
    const choices = series.next.filter((id) => {
      const s = seriesById(id);
      return s && seriesContent(s, content).cars.length > 0 && seriesContent(s, content).calendar.length >= 3;
    });
    next = { ...run, history, score, season: null, choices, lastSeason: { ...season, carried: alongside } };
    if (!choices.length) {
      outcome = "complete";
      next.status = "complete";
    }
  } else if (season.attempt < MAX_ATTEMPTS) {
    outcome = "retry";
    const again = newSeason({ ...run, history }, season.seriesId, content, season.attempt + 1, season);
    next = { ...run, history, score, season: again, choices: [] };
  } else {
    outcome = "over";
    next = { ...run, history, score, season: null, choices: [], status: "over" };
  }
  return { run: touch(next), record, outcome, alongside, parts };
}

function touch(run: CareerRun): CareerRun {
  return { ...run, updatedAt: now() };
}

// ---- Save

export function loadCareerSave(): CareerSave {
  if (typeof window === "undefined") return EMPTY_SAVE;
  try {
    const raw = window.localStorage.getItem(CAREER_STORAGE_KEY);
    return raw ? parseCareerSave(JSON.parse(raw)) : EMPTY_SAVE;
  } catch {
    return EMPTY_SAVE;
  }
}

/** Writes the save; its text is stable for the same careers (the cloud save hashes it) */
export function storeCareerSave(save: CareerSave): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CAREER_STORAGE_KEY, JSON.stringify(save));
  } catch {
    // Storage full or blocked: progress lasts for this session only
  }
}

/** A save read back: anything that is not a career this build understands is dropped */
export function parseCareerSave(raw: unknown): CareerSave {
  if (!raw || typeof raw !== "object") return EMPTY_SAVE;
  const r = raw as Partial<CareerSave>;
  if (r.v !== 1 || !Array.isArray(r.runs)) return EMPTY_SAVE;
  const runs = r.runs
    .filter(
      (c): c is CareerRun =>
        Boolean(c) &&
        typeof c === "object" &&
        typeof c.id === "string" &&
        (c.discipline === "road" || c.discipline === "historic") &&
        Array.isArray(c.rivals) &&
        Array.isArray(c.history) &&
        (c.season === null || (typeof c.season === "object" && Boolean(seriesById(c.season.seriesId))))
    )
    .map(cleanTestDays);
  const removed = Array.isArray(r.removed) ? r.removed.filter((id): id is string => typeof id === "string") : [];
  return {
    v: 1,
    runs: runs.filter((c) => !removed.includes(c.id)),
    activeId: typeof r.activeId === "string" && runs.some((c) => c.id === r.activeId) ? r.activeId : (runs[0]?.id ?? null),
    ...(removed.length ? { removed } : {}),
  };
}

/** A career's test days as saved, anything malformed dropped; a career without any comes back as it was (the same object) */
function cleanTestDays(run: CareerRun): CareerRun {
  const season = cleanSeasonTests(run.season);
  const last = cleanSeasonTests(run.lastSeason);
  return season === run.season && last === run.lastSeason ? run : { ...run, season: season ?? null, ...(last !== undefined ? { lastSeason: last } : {}) };
}

function cleanSeasonTests<T extends SeasonState | null | undefined>(season: T): T {
  if (!season || typeof season !== "object" || !("tests" in season)) return season;
  const raw: unknown = season.tests;
  const tests = Array.isArray(raw) ? raw.filter(isTestDayResult) : [];
  if (Array.isArray(raw) && tests.length === raw.length) return season;
  const { tests: _dropped, ...rest } = season;
  void _dropped;
  return (tests.length ? { ...rest, tests } : rest) as T;
}

function isTestDayResult(t: unknown): t is TestDayResult {
  if (!t || typeof t !== "object") return false;
  const x = t as Record<string, unknown>;
  const ms = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
  return (
    typeof x.trackId === "string" &&
    typeof x.car === "string" &&
    typeof x.laps === "number" &&
    Number.isInteger(x.laps) &&
    x.laps >= 0 &&
    ms(x.bestMs) &&
    ms(x.targetMs)
  );
}

/** Replace one career in the save (or add it), and make it the one shown */
export function withRun(save: CareerSave, run: CareerRun): CareerSave {
  const runs = save.runs.some((c) => c.id === run.id) ? save.runs.map((c) => (c.id === run.id ? run : c)) : [...save.runs, run];
  return { ...save, runs, activeId: run.id };
}

export function withoutRun(save: CareerSave, id: string): CareerSave {
  const runs = save.runs.filter((c) => c.id !== id);
  const removed = [...new Set([...(save.removed ?? []), id])];
  return { ...save, runs, removed, activeId: save.activeId === id ? (runs[0]?.id ?? null) : save.activeId };
}
