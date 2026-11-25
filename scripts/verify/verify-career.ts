/**
 * The career (src/lib/career/): its ladders, rivals, seasons and save.
 *   - every series' cars and circuits exist, its circuits have a pit lane and are no hill climbs, its next series exist,
 *     and every series can be reached from its discipline's start;
 *   - the rivals are made up: no real driver's code, each code and number once;
 *   - a season credits each rival with the place the race gave them (by the codes the race used), and the standings
 *     follow;
 *   - a career that wins its seasons climbs to the top and completes; one that loses them is over after three attempts;
 *   - mulligans are limited; a save reads back the same, and two devices' careers combine.
 *
 *   npx tsx scripts/verify/verify-career.ts
 */
import { readFileSync } from "node:fs";
import { anyCarById } from "../../src/lib/cars/car-registry";
import {
  CAREER_SERIES,
  roundsFor,
  seriesById,
  startingSeries,
  type CareerContent,
} from "../../src/lib/career/ladder";
import { makeRivals } from "../../src/lib/career/rivals";
import {
  chooseSeries,
  endSeason,
  newCareer,
  objectiveProgress,
  parseCareerSave,
  racePlan,
  recordRound,
  seasonStandings,
  startSeason,
  updateRaceSettings,
  updateSeasonSettings,
  spendMulligan,
  retireFromRound,
  withoutRun,
  withRun,
  EMPTY_SAVE,
  type CareerRun,
  type RoundResult,
  type SeasonState,
} from "../../src/lib/career/career-state";
import { combineCareers } from "../../src/lib/account/save-model";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
};

const index = JSON.parse(readFileSync("public/tracks/index.json", "utf8")) as { id: string; type?: string; lengthM: number }[];
const NO_PIT = new Set(["borgloh", "goodwood", "dunsfold", "spielberg_inner", "okayama_drift"]);
const allCars = [...new Set(CAREER_SERIES.flatMap((s) => s.cars))].filter((id) => anyCarById(id));
const allContent: CareerContent = { tracks: new Set(index.map((t) => t.id)), cars: new Set(allCars) };

// ---- Ladders
for (const s of CAREER_SERIES) {
  const badCars = s.cars.filter((c) => !anyCarById(c));
  const badTracks = s.calendar.filter((t) => !allContent.tracks.has(t) || NO_PIT.has(t) || index.find((x) => x.id === t)?.type === "hillclimb");
  const badNext = s.next.filter((n) => !seriesById(n) || seriesById(n)!.discipline !== s.discipline || seriesById(n)!.tier <= s.tier);
  check(`${s.id}: cars, circuits with a pit lane, next series up the ladder`, !badCars.length && !badTracks.length && !badNext.length, [...badCars, ...badTracks, ...badNext].join(","));
  check(`${s.id}: ends the ladder or leads on`, Boolean(s.final) !== s.next.length > 0);
}
for (const d of ["road", "historic"] as const) {
  const reach = new Set<string>(startingSeries(d).map((s) => s.id));
  for (let pass = 0; pass < 10; pass++) for (const id of [...reach]) seriesById(id)!.next.forEach((n) => reach.add(n));
  const missing = CAREER_SERIES.filter((s) => s.discipline === d && !reach.has(s.id)).map((s) => s.id);
  check(`${d}: every series reachable from the start`, !missing.length, missing.join(","));
  check(`${d}: one top`, CAREER_SERIES.filter((s) => s.discipline === d && s.final).length === 1);
}
check("season lengths: 3 rounds at least, never more than the calendar", [3, 5, 7, 10].every((n) => (["short", "medium", "long", "full"] as const).every((l) => roundsFor(l, n) >= Math.min(3, n) && roundsFor(l, n) <= n)));

// ---- Rivals
const REAL = ["VER", "HAM", "LEC", "NOR", "PIA", "RUS", "SAI", "ALO", "GAS", "OCO", "ALB", "STR", "HUL", "TSU", "BOT", "ANT", "HAD", "BOR"];
const rivals = makeRivals(1234);
check("48 rivals", rivals.length === 48, String(rivals.length));
check("no real driver's code", !rivals.some((r) => REAL.includes(r.code) || REAL.includes(r.altCode)));
check("codes and numbers each once", new Set(rivals.map((r) => r.code)).size === rivals.length && new Set(rivals.map((r) => r.number)).size === rivals.length);
check("a rival's second code differs from its first", rivals.every((r) => r.altCode !== r.code && r.altCode.length === 3));
check("the same seed makes the same drivers", JSON.stringify(makeRivals(1234)) === JSON.stringify(rivals));

// ---- Seasons
const lapLen = (id: string) => index.find((t) => t.id === id)?.lengthM ?? 4000;

/** Race the next round: `playerPlace` for the player, the rivals in their grid order around them */
function raceRound(run: CareerRun, playerPlace: number, playerCode = "ZZZ"): CareerRun {
  const plan = racePlan(run, lapLen, playerCode)!;
  const order = [...plan.drivers];
  // A different winner every round: rotate the field
  const k = run.season!.rounds.filter(Boolean).length % order.length;
  const rotated = [...order.slice(k), ...order.slice(0, k)];
  const results: { code: string; isPlayer: boolean; position: number; gridPosition?: number; lapsCompleted?: number; bestLapMs?: number }[] = [];
  let pos = 1;
  for (const d of rotated) {
    if (pos === playerPlace) results.push({ code: playerCode, isPlayer: true, position: pos++, gridPosition: playerPlace, lapsCompleted: plan.laps, bestLapMs: 90000 });
    results.push({ code: d.code, isPlayer: false, position: pos++, lapsCompleted: plan.laps, bestLapMs: 91000 + pos });
  }
  if (!results.some((r) => r.isPlayer)) results.push({ code: playerCode, isPlayer: true, position: pos, gridPosition: pos, lapsCompleted: plan.laps, bestLapMs: 95000 });
  return recordRound(run, plan, { results, laps: plan.laps, lapsLed: playerPlace === 1 ? plan.laps : 0 });
}

{
  let run = newCareer("road", "clubCup_europe", allContent, 42)!;
  check("a new career starts in pre-season", Boolean(run) && run.season?.started === false && run.season.seriesId === "clubCup_europe");
  run = updateSeasonSettings(run, { length: "short" }, allContent);
  run = updateRaceSettings(run, { gridSize: 6 });
  run = startSeason(run);
  const s = run.season!;
  check("a started season has its rounds, three objectives and a grid of rivals", s.started && s.rounds.length === roundsFor("short", seriesById(s.seriesId)!.calendar.length) && s.objectives.length === 3 && s.grid.length === 5);
  // One round: check the rivals are credited by code
  const plan = racePlan(run, lapLen, "ZZZ")!;
  const winner = plan.drivers[0];
  run = raceRound(run, 3);
  const round = run.season!.rounds[0]!;
  const winnerLine = round.lines.find((l) => l.who === winner.id);
  check("the race's winner is credited with the win (by its code)", winnerLine?.position === 1 && winnerLine.points === 25, JSON.stringify(winnerLine));
  check("the player's place and points are recorded", round.position === 3 && round.points === 15);
  const rows = seasonStandings(run.season!);
  check("standings follow the round", rows[0].who === winner.id && rows[0].points === 25 && rows.find((r) => r.who === "me")?.points === 15);
  // Code clash: a player under a rival's code races against its second code
  const clashRun = newCareer("road", "clubCup_europe", allContent, 42)!;
  const started = startSeason(clashRun);
  const rival = started.rivals.find((r) => r.id === started.season!.grid[0])!;
  const clashPlan = racePlan(started, lapLen, rival.code)!;
  check("a rival whose code is the player's races under its second code", clashPlan.drivers[0].code === rival.altCode);
}

{
  // A career won all the way up
  let run = newCareer("road", "clubCup_americas", allContent, 7)!;
  let seasons = 0;
  let path: string[] = [];
  while (run.status === "active" && seasons < 12) {
    if (!run.season) {
      // Promoted: take the first choice
      run = chooseSeries(run, run.choices[0], allContent);
    }
    run = updateSeasonSettings(run, { length: "short" }, allContent);
    run = startSeason(run);
    while (run.season!.rounds.some((r) => r === null)) run = raceRound(run, 1);
    const end = endSeason(run, allContent)!;
    path.push(`${end.record.seriesId}:${end.outcome}`);
    run = end.run;
    seasons++;
  }
  check("winning every season climbs to the top and completes the career", run.status === "complete" && path[path.length - 1].startsWith("grandPrix"), path.join(" > "));
  check("the career score adds up its seasons", run.score === run.history.reduce((a, h) => a + h.score, 0) && run.score > 0);
}

{
  // A career lost: three attempts, then over
  let run = newCareer("historic", "procar", allContent, 9)!;
  const outcomes: string[] = [];
  const grids: string[] = [];
  for (let i = 0; i < 4 && run.status === "active"; i++) {
    run = updateSeasonSettings(run, { length: "short" }, allContent);
    run = startSeason(run);
    grids.push([...run.season!.grid].sort().join(","));
    while (run.season!.rounds.some((r) => r === null)) run = raceRound(run, 99);
    const end = endSeason(run, allContent)!;
    outcomes.push(end.outcome);
    run = end.run;
  }
  check("three seasons missed: retry, retry, over", outcomes.join(",") === "retry,retry,over" && run.status === "over", outcomes.join(","));
  check("a retried season keeps its rivals", grids.length === 3 && grids[0] === grids[1] && grids[1] === grids[2], grids.join(" | "));
}

{
  let run = startSeason(updateSeasonSettings(newCareer("road", "clubCup_asiaPacific", allContent, 3)!, { mulligans: 1 }, allContent));
  const once = spendMulligan(run);
  check("a mulligan within the allowance", once !== null && once.season!.mulligansUsed === 1);
  check("none past it", once !== null && spendMulligan(once) === null);
  run = once ?? run;
  const save = withRun(EMPTY_SAVE, run);
  check("a save reads back the same", JSON.stringify(parseCareerSave(JSON.parse(JSON.stringify(save)))) === JSON.stringify(save));
  const other = withRun(EMPTY_SAVE, { ...newCareer("historic", "procar", allContent, 5)! });
  const older = withRun(EMPTY_SAVE, { ...run, updatedAt: run.updatedAt - 1000, score: -1 });
  const merged = JSON.parse(combineCareers(JSON.stringify(older), JSON.stringify(withRun(other, run)))) as typeof save;
  check("two devices' careers combine, the newer copy of one winning", merged.runs.length === 2 && merged.runs.find((r) => r.id === run.id)?.score === run.score);
}

{
  // The grid grows with the ladder; a player's smaller grid stays as many short
  let run = newCareer("road", "clubCup_europe", allContent, 11)!;
  const grids: string[] = [];
  for (let i = 0; i < 4; i++) {
    if (!run.season) run = chooseSeries(run, run.choices[0], allContent);
    run = startSeason(updateSeasonSettings(run, { length: "short" }, allContent));
    grids.push(`${run.season!.seriesId}:${run.season!.race.gridSize}`);
    while (run.season!.rounds.some((r) => r === null)) run = raceRound(run, 1);
    run = endSeason(run, allContent)!.run;
  }
  const sizes = grids.map((g) => Number(g.split(":")[1]));
  check("each series races its own grid (it grows up the ladder)", sizes[2] > sizes[0], grids.join(" > "));
}
{
  // Objectives: never a grid objective without qualifying, never two of one kind
  const kinds = { q: ["poleThreat", "qualifyPro"], f: ["podiumThreat", "consistent"], p: ["fastestLap", "leadTheCharge"], c: ["cleanRacer", "putInTheWork"] };
  let ok = true;
  let noQual = true;
  for (let seed = 1; seed < 60; seed++) {
    let run = newCareer("road", "clubCup_europe", allContent, seed)!;
    run = updateRaceSettings(run, { qualifying: seed % 2 ? 0 : 5 });
    run = startSeason(run);
    const objs = run.season!.objectives.map((o) => o.kind);
    for (const list of Object.values(kinds)) if (objs.filter((k) => list.includes(k)).length > 1) ok = false;
    if (seed % 2 && objs.some((k) => kinds.q.includes(k))) noQual = false;
  }
  check("a season's objectives are each of another kind", ok);
  check("no grid objective in a season without qualifying", noQual);
}
{
  // The series of a level can be swapped until the season starts
  let run = newCareer("road", "clubCup_europe", allContent, 21)!;
  run = chooseSeries(run, "clubCup_americas", allContent);
  check("before the first season starts, the other regions can be chosen", run.season?.seriesId === "clubCup_americas" && run.choices.length === 3);
  run = startSeason(run);
  check("once it starts, the choice is made", run.choices.length === 0 && chooseSeries(run, "clubCup_europe", allContent) === run);
}
{
  // A season missed has nobody "promoted alongside"; a retirement is not always a win for the same rival
  let run = startSeason(updateSeasonSettings(newCareer("historic", "procar", allContent, 31)!, { length: "short" }, allContent));
  while (run.season!.rounds.some((r) => r === null)) run = raceRound(run, 99);
  const end = endSeason(run, allContent)!;
  check("nobody moves up alongside a player who did not", end.outcome === "retry" && end.alongside.length === 0);
  check("a season's record keeps its rounds and standings for the history", Boolean(end.record.archive?.rounds.length && end.record.archive.standings.length));
  const winners = new Set<string>();
  for (let seed = 1; seed < 12; seed++) {
    const r = startSeason(newCareer("road", "clubCup_europe", allContent, seed * 7)!);
    const plan = racePlan(r, lapLen, "ZZZ")!;
    const after = retireFromRound(r, plan);
    winners.add(after.season!.rounds[0]!.lines.find((l) => l.position === 1)!.who === plan.drivers[0].id ? "first" : "other");
  }
  check("a retirement credits the field by pace and luck, not always the first on the grid", winners.has("other"));
}
{
  const codes = makeRivals(99).flatMap((r) => [r.code, r.altCode]);
  check("every first and second code is a different one", new Set(codes).size === codes.length);
  const a = withRun(EMPTY_SAVE, newCareer("road", "clubCup_europe", allContent, 1)!);
  const deleted = withoutRun(a, a.runs[0].id);
  const merged = JSON.parse(combineCareers(JSON.stringify(a), JSON.stringify(deleted))) as typeof a;
  check("a career deleted on one device stays deleted when the saves combine", merged.runs.length === 0);
}

{
  // An average objective is judged at one decimal both ways: never "failed" while the rounds left can still bring it in
  const base = startSeason(updateRaceSettings(newCareer("road", "clubCup_europe", allContent, 5)!, { gridSize: 10 })).season!;
  const finishes = (places: number[]): SeasonState => ({
    ...base,
    objectives: [{ kind: "consistent", target: 4.8 }],
    rounds: Array.from({ length: 6 }, (_, i) => (i < places.length ? ({ position: places[i], grid: places[i], dnf: false } as unknown as RoundResult) : null)),
  });
  const five = objectiveProgress({ kind: "consistent", target: 4.8 }, finishes([5, 5, 6, 6, 6]));
  check("an average a win in the last round still brings in is not failed", !five.failed, JSON.stringify(five));
  const six = objectiveProgress({ kind: "consistent", target: 4.8 }, finishes([5, 5, 6, 6, 6, 1]));
  check("...and that win completes it, not failed", six.done && !six.failed, JSON.stringify(six));
  const out = objectiveProgress({ kind: "consistent", target: 4.8 }, finishes([6, 6, 6, 6, 6]));
  check("an average out of reach is failed before the last round", out.failed && !out.done, JSON.stringify(out));
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncareer: all checks passed");
