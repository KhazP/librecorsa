/**
 * A player's careers (iRacing's Career Mode): each a run up one discipline's ladder (ladder.ts), a season at a time.
 *
 * - **A season** starts in pre-season: the series picked, the car, the calendar's length and circuits, and the
 *   mulligans chosen; a test day if the player likes. Starting the season locks those. Race settings (race length,
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
import {
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
import { careerRng, drawGrid, makeRivals, rivalCode, type CareerRival } from "./rivals";

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

/** Three objectives for a season, drawn by its seed, their targets fitted to the grid and the rounds */
export function drawObjectives(seed: number, gridSize: number, rounds: number, final: boolean): BonusObjective[] {
  const rng = careerRng(seed);
  const pool = [...POOL];
  const out: BonusObjective[] = [];
  while (out.length < 3 && pool.length) {
    const kind = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    out.push({ kind, target: objectiveTarget(kind, gridSize, rounds, final) });
  }
  return out;
}

function objectiveTarget(kind: ObjectiveKind, grid: number, rounds: number, final: boolean): number {
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
      return Math.max(2, rounds * 2);
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
  /** Where it stands (a place, an average, a count), null before any round */
  value: number | null;
}

/** Where an objective stands after the rounds raced */
export function objectiveProgress(o: BonusObjective, season: SeasonState): ObjectiveProgress {
  const raced = season.rounds.filter((r): r is RoundResult => r !== null);
  const left = season.rounds.length - raced.length;
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  switch (o.kind) {
    case "poleThreat": {
      const best = raced.length ? Math.min(...raced.map((r) => r.grid)) : null;
      return { value: best, done: best !== null && best <= o.target, failed: left === 0 && !(best !== null && best <= o.target) };
    }
    case "podiumThreat": {
      const best = raced.length ? Math.min(...raced.map((r) => (r.dnf ? 99 : r.position))) : null;
      return { value: best, done: best !== null && best <= o.target, failed: left === 0 && !(best !== null && best <= o.target) };
    }
    case "qualifyPro": {
      const v = avg(raced.map((r) => r.grid));
      const done = left === 0 && v !== null && v <= o.target;
      return { value: v, done, failed: left === 0 && !done };
    }
    case "consistent": {
      const v = avg(raced.map((r) => (r.dnf ? season.race.gridSize : r.position)));
      const done = left === 0 && v !== null && v <= o.target;
      return { value: v, done, failed: left === 0 && !done };
    }
    case "cleanRacer": {
      const n = raced.filter((r) => !r.dnf && r.penaltyS <= 0).length;
      return { value: n, done: n >= o.target, failed: n + left < o.target };
    }
    case "leadTheCharge": {
      const n = raced.reduce((a, r) => a + r.lapsLed, 0);
      return { value: n, done: n >= o.target, failed: left === 0 && n < o.target };
    }
    case "putInTheWork": {
      const total = raced.reduce((a, r) => a + r.laps, 0);
      const done = raced.reduce((a, r) => a + r.lapsCompleted, 0);
      const pct = total ? Math.round((done / total) * 100) : null;
      const ok = left === 0 && pct !== null && pct >= o.target;
      return { value: pct, done: ok, failed: left === 0 && !ok };
    }
    case "fastestLap": {
      const n = raced.filter((r) => r.fastestLap).length;
      return { value: n, done: n >= o.target, failed: left === 0 && n < o.target };
    }
  }
}

// ---- Score

const AI_MULT: Record<AiLevel, number> = { low: 8, medium: 14, high: 20, expert: 26 };
const DAMAGE_MULT: Record<DamageLevel, number> = { off: 0, reduced: 1, full: 3 };
const LENGTH_MULT: Record<RaceLength, number> = { short: 0, medium: 2, long: 4, full: 6 };

/** A race's multiplier: the challenge the player took on */
export function raceMultiplier(race: RaceSettings): number {
  return AI_MULT[race.aiLevel] + DAMAGE_MULT[race.damage] + LENGTH_MULT[race.raceLength];
}

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
  const clean = !r.dnf && r.penaltyS <= 0 ? 40 : 0;
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
  const mulligans = Math.max(0, MAX_MULLIGANS - season.settings.mulligans) * 300;
  const mult = Math.max(3, 7 - season.attempt);
  return { races, championship, points, objectives, firstClear, mulligans, mult, score: (races + championship + points + objectives + firstClear + mulligans) * mult };
}

// ---- Careers

const now = () => Date.now();

/** What a season's race settings start from: the series' grid within what this game can run */
function raceSettingsFor(series: CareerSeries, prev?: RaceSettings): RaceSettings {
  return {
    ...DEFAULT_RACE_SETTINGS,
    ...(prev ?? {}),
    gridSize: Math.min(series.grid, prev?.gridSize ?? series.grid, 12),
  };
}

/** A new season in a series: pre-season, the calendar's first circuits, the series' first car */
export function newSeason(run: CareerRun, seriesId: string, content: CareerContent, attempt = 1, prev?: SeasonState): SeasonState | null {
  const series = seriesById(seriesId);
  if (!series) return null;
  const { calendar, cars } = seriesContent(series, content);
  if (!cars.length || calendar.length < 3) return null;
  const length: SeasonLength = prev?.settings.length ?? "medium";
  const n = roundsFor(length, calendar.length);
  const race = raceSettingsFor(series, prev?.race);
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
    grid = drawGrid(run.rivals, race.gridSize - 1, season.carried, new Set(), run.seed ^ (run.history.length * 7919) ^ (season.attempt * 104729));
  }
  return touch({ ...run, season: { ...season, race, grid } });
}

/** Start the season: its settings locked, its rounds and objectives set */
export function startSeason(run: CareerRun): CareerRun {
  const season = run.season;
  if (!season || season.started) return run;
  const series = seriesById(season.seriesId)!;
  const objectives = drawObjectives(run.seed ^ (run.history.length * 31) ^ season.attempt, season.race.gridSize, season.settings.circuits.length, Boolean(series.final));
  return touch({
    ...run,
    raced: [...new Set([...(run.raced ?? []), ...season.grid])],
    season: { ...season, started: true, rounds: season.settings.circuits.map(() => null), objectives, mulligansUsed: 0 },
  });
}

/** Pick the next series after a promotion */
export function chooseSeries(run: CareerRun, seriesId: string, content: CareerContent): CareerRun {
  if (run.season || !run.choices.includes(seriesId)) return run;
  const season = newSeason(run, seriesId, content, 1, run.history.length ? lastSeasonAsPrev(run) : undefined);
  if (!season) return run;
  return touch({ ...run, season, choices: [] });
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
  return touch({ ...run, season: { ...season, rounds } });
}

/** A mulligan: the round raced again (none recorded); false when none are left */
export function useMulligan(run: CareerRun): CareerRun | null {
  const season = run.season;
  if (!season || season.mulligansUsed >= season.settings.mulligans) return null;
  return touch({ ...run, season: { ...season, mulligansUsed: season.mulligansUsed + 1 } });
}

/** A round given up without a mulligan: the player out of it (last, no points), the field as it was not raced */
export function retireFromRound(run: CareerRun, plan: CareerRacePlan): CareerRun {
  const season = run.season;
  if (!season || nextRound(season) !== plan.roundIndex) return run;
  const lines: RoundLine[] = [
    ...plan.drivers.map((d, i) => ({ who: d.id, position: i + 1, points: pointsFor(i + 1) })),
    { who: "me", position: plan.drivers.length + 1, points: 0, dnf: true },
  ];
  return recordRound(run, plan, {
    results: lines.map((l) => ({ code: l.who === "me" ? "" : plan.drivers.find((d) => d.id === l.who)!.code, isPlayer: l.who === "me", position: l.position, dnf: l.dnf })),
    laps: 0,
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
  };
  // The best of the rest move up too (at most three)
  const alongside = rows.filter((r) => r.who !== "me").slice(0, Math.min(3, places)).map((r) => r.who);
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
  const runs = r.runs.filter(
    (c): c is CareerRun =>
      Boolean(c) &&
      typeof c === "object" &&
      typeof c.id === "string" &&
      (c.discipline === "road" || c.discipline === "historic") &&
      Array.isArray(c.rivals) &&
      Array.isArray(c.history) &&
      (c.season === null || (typeof c.season === "object" && Boolean(seriesById(c.season.seriesId))))
  );
  return { v: 1, runs, activeId: typeof r.activeId === "string" && runs.some((c) => c.id === r.activeId) ? r.activeId : (runs[0]?.id ?? null) };
}

/** Replace one career in the save (or add it), and make it the one shown */
export function withRun(save: CareerSave, run: CareerRun): CareerSave {
  const runs = save.runs.some((c) => c.id === run.id) ? save.runs.map((c) => (c.id === run.id ? run : c)) : [...save.runs, run];
  return { ...save, runs, activeId: run.id };
}

export function withoutRun(save: CareerSave, id: string): CareerSave {
  const runs = save.runs.filter((c) => c.id !== id);
  return { ...save, runs, activeId: save.activeId === id ? (runs[0]?.id ?? null) : save.activeId };
}
