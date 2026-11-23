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
 *   npx tsx scripts/verify-career.ts
 */
import { readFileSync } from "node:fs";
import { anyCarById } from "../src/lib/cars/car-registry";
import {
  CAREER_SERIES,
  roundsFor,
  seriesById,
  startingSeries,
  type CareerContent,
} from "../src/lib/career/ladder";
import { makeRivals } from "../src/lib/career/rivals";
import {
  chooseSeries,
  endSeason,
  newCareer,
  parseCareerSave,
  racePlan,
  recordRound,
  seasonStandings,
  startSeason,
  updateRaceSettings,
  updateSeasonSettings,
  useMulligan,
  withRun,
  EMPTY_SAVE,
  type CareerRun,
} from "../src/lib/career/career-state";
import { combineCareers } from "../src/lib/account/save-model";

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
  const once = useMulligan(run);
  check("a mulligan within the allowance", once !== null && once.season!.mulligansUsed === 1);
  check("none past it", once !== null && useMulligan(once) === null);
  run = once ?? run;
  const save = withRun(EMPTY_SAVE, run);
  check("a save reads back the same", JSON.stringify(parseCareerSave(JSON.parse(JSON.stringify(save)))) === JSON.stringify(save));
  const other = withRun(EMPTY_SAVE, { ...newCareer("historic", "procar", allContent, 5)! });
  const older = withRun(EMPTY_SAVE, { ...run, updatedAt: run.updatedAt - 1000, score: -1 });
  const merged = JSON.parse(combineCareers(JSON.stringify(older), JSON.stringify(withRun(other, run)))) as typeof save;
  check("two devices' careers combine, the newer copy of one winning", merged.runs.length === 2 && merged.runs.find((r) => r.id === run.id)?.score === run.score);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ncareer: all checks passed");
