/**
 * Checks the career's test day: its show (`src/lib/show/show-timeline.ts` "test", the director in
 * `src/lib/render/pre-race-show.ts`), and its programme on the season (`src/lib/career/career-state.ts`):
 *   - the test show: the opening cut short, the car, the start card; the tyres land on their section of the cue; it
 *     plays as the test day forms (the car standing in the practice), never once the run is under way, never twice;
 *     a test day never gets a round's show, and a round never gets the test show;
 *   - where a test day runs (the next round's circuit, the first before the season starts);
 *   - its laps kept on the season, summed per circuit and car, the better best and the newest target;
 *   - the target: slower against a weaker field, at the pace of the last promotion place; its reference lap at once
 *     from a circuit's line check (a lap driven instead is some seconds of work: the browser run covers it);
 *   - a save from before test days reads back unchanged (the same text), a malformed one loses only what is broken, and
 *     two devices' careers keep them.
 *
 *   npx tsx scripts/verify-career-test-day.ts
 */
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { anyCarById } from "../src/lib/cars/car-registry";
import { CAREER_SERIES, seriesById, type CareerContent } from "../src/lib/career/ladder";
import {
  newCareer,
  parseCareerSave,
  promotionPlaces,
  recordRound,
  racePlan,
  recordTestDay,
  seasonTest,
  startSeason,
  testCircuit,
  testTargetMs,
  updateRaceSettings,
  withRun,
  EMPTY_SAVE,
  type CareerRun,
  type TestDayResult,
} from "../src/lib/career/career-state";
import { rivalPace } from "../src/lib/career/rivals";
import { combineCareers } from "../src/lib/account/save-model";
import { getActiveTrackData, getActiveTrackMetadata } from "../src/lib/track-data";
import { ReferenceLap } from "../src/lib/sim/reference-lap";
import { LINE_CHECK_REF_BASE } from "../src/lib/sim/qualifying";
import { buildShowTimeline, CAR_S, DEFAULT_SHOW_MARKERS, TITLE_S, type ShowKind } from "../src/lib/show/show-timeline";
import { PreRaceShowDirector, type ShowCars, type ShowFrame, type ShowGridRow } from "../src/lib/render/pre-race-show";
import type { ShowContext } from "../src/lib/show/show-context";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- The test show's timeline --------------------------------------------------------------------------------------
console.log("timeline");
{
  const m = DEFAULT_SHOW_MARKERS;
  const test = buildShowTimeline("test", 1, m);
  const ids = test.scenes.map((s) => s.id);
  check("test: title, circuit, aerial, tyres, the car, the card", ids.join(",") === "title,circuit,aerial,tyres,car,ready", ids.join(","));
  check("scenes follow each other without gaps", test.scenes.every((s, i) => i === 0 || near(s.startS, test.scenes[i - 1].endS)));
  check("the title runs first, for its own length", test.scenes[0].startS === 0 && near(test.scenes[0].endS, TITLE_S));
  const tyres = test.scenes.find((s) => s.id === "tyres")!;
  check("its cue starts late enough for the tyres to land on their section", near(tyres.startS + test.musicFromS, m.tyresAtS), `${tyres.startS + test.musicFromS}`);
  check("the tyres keep their section's length", near(tyres.endS - tyres.startS, m.gridAtS - m.tyresAtS));
  const car = test.scenes.find((s) => s.id === "car")!;
  check("the car follows the tyres, for its own length", near(car.startS, tyres.endS) && near(car.endS - car.startS, CAR_S));
  check("the card has no end and follows the car", test.scenes[test.scenes.length - 1].endS === Infinity && near(test.readyAtS, car.endS));
  const race = buildShowTimeline("race", 12, m);
  check("a short version: well under the race show's opening", test.readyAtS < race.scenes.find((s) => s.id === "gridIntro")!.startS);
  check("no grid, no field", !ids.includes("gridIntro") && !ids.includes("gridPair") && !ids.includes("field") && test.pairS === 0);
  check("the grid size does not matter to it", JSON.stringify(buildShowTimeline("test", 20, m)) === JSON.stringify(test));
  const early = buildShowTimeline("test", 1, { tyresAtS: 14, gridAtS: 24, climaxS: 70 });
  check("a cue whose tyres come early: played from its top", early.musicFromS === 0 && early.scenes.every((s, i) => i === 0 || s.startS >= early.scenes[i - 1].startS));
  check("the round's shows have no car", (["race", "qualifying", "grid"] as ShowKind[]).every((k) => !buildShowTimeline(k, 12, m).scenes.some((s) => s.id === "car")));
}

// --- The director --------------------------------------------------------------------------------------------------
console.log("director");
{
  const track = getActiveTrackData();
  let ended = 0;
  const show = new PreRaceShowDirector(track, () => ended++);
  const me = { code: "ME", first: "", last: "Me", number: null, color: "#ccff00", isPlayer: true };
  const testCtx: ShowContext = {
    seriesId: "clubCup_europe",
    roundIndex: 0,
    rounds: 6,
    laps: 0,
    pitStops: 0,
    qualifyingMin: 0,
    drivers: { ME: me },
    standings: [],
    weather: "clear",
    timeOfDay: "afternoon",
    test: { car: "liana", massKg: 1050, frontPct: 61, drivetrain: "fwd", limiterRpm: 6800, targetMs: null },
  };
  const grid: ShowGridRow[] = [{ code: "ME", color: "#ccff00", isPlayer: true, lapMs: null }];
  const frame = (f: Partial<ShowFrame>): ShowFrame => ({
    dt: 1 / 60,
    allowed: true,
    suppressed: false,
    qualifying: false,
    atLights: false,
    grid: [],
    playerS: 0,
    musicS: null,
    musicExpected: false,
    ...f,
  });
  show.arm(testCtx);
  show.update(frame({}));
  check("outside a practice: nothing plays", !show.playing);
  show.update(frame({ practice: "standing", allowed: false }));
  check("in the menus: nothing plays yet", !show.playing);
  check("a test day builds no grid", !show.wantsGrid && !show.gridShowNext);
  show.update(frame({ qualifying: true, atLights: true, grid }));
  check("a test day never gets a round's show", !show.playing);
  show.update(frame({ practice: "standing" }));
  check("the test day forms (the car standing in its practice): the test show", show.playing && show.getSnapshot().kind === "test");
  check("…told of the car", show.getSnapshot().context?.test?.car === "liana");
  show.arm({ ...testCtx, test: { ...testCtx.test!, targetMs: 81234 } });
  check("the target once known reaches the show under way", show.playing && show.getSnapshot().context?.test?.targetMs === 81234);
  const p = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 6000);
  const slot = track.spawnGrid[0].position;
  const cars: ShowCars = {
    player: { position: new THREE.Vector3(slot[0], slot[1], slot[2]), quaternion: new THREE.Quaternion() },
    frontWheel: null,
    carOf: () => null,
    fogDensity: 0.00035,
    still: false,
  };
  let allPlaced = true;
  const seen = new Set<string>();
  for (let i = 0; i < 60 * 4; i++) {
    show.update(frame({ practice: "standing", dt: 0.25 }));
    seen.add(show.getSnapshot().scene ?? "");
    if (!show.placeCamera(p, cars) || !Number.isFinite(p.position.x)) allPlaced = false;
  }
  check("every test scene places the camera (the car scene round the player's car)", allPlaced && seen.has("car"), [...seen].join(","));
  check("…and it waits on its card", show.playing && show.getSnapshot().scene === "ready");
  show.startNow();
  check("Go hands the camera back once", !show.playing && ended === 1);
  show.update(frame({ practice: "standing" }));
  check("a restart of the same test day does not play it again", !show.playing);

  // Never mid-run
  const run = new PreRaceShowDirector(track, () => {});
  run.arm({ ...testCtx, roundIndex: 2 });
  run.update(frame({ practice: "moving", dt: 0.1 }));
  check("a moment's movement as it forms (the car settling) does not count", !run.playing);
  for (let i = 0; i < 8; i++) run.update(frame({ practice: "moving", dt: 0.1 }));
  run.update(frame({ practice: "standing" }));
  check("the car under way before the show could start: never later in the run", !run.playing);
  const off = new PreRaceShowDirector(track, () => {});
  off.arm({ ...testCtx, roundIndex: 3 });
  off.update(frame({ practice: "standing", suppressed: true }));
  off.update(frame({ practice: "standing" }));
  check("the setting off as it forms: nothing plays, nor later", !off.playing);
  off.arm({ ...testCtx, roundIndex: 3, test: undefined });
  off.update(frame({ practice: "standing" }));
  check("a round never gets the test show from a practice", !off.playing);
  off.arm({ ...testCtx, roundIndex: 4 });
  off.update(frame({ practice: "standing" }));
  check("a new test day: its show again", off.playing && off.getSnapshot().kind === "test");
  off.arm(null);
  check("disarmed (back to the career): it ends", !off.playing);
}

// --- The programme on the season -----------------------------------------------------------------------------------
console.log("programme");
const index = JSON.parse(readFileSync("public/tracks/index.json", "utf8")) as { id: string }[];
const allCars = [...new Set(CAREER_SERIES.flatMap((s) => s.cars))].filter((id) => anyCarById(id));
const content: CareerContent = { tracks: new Set(index.map((t) => t.id)), cars: new Set(allCars) };
{
  let run = newCareer("road", "clubCup_europe", content, 42)!;
  const season = run.season!;
  check("before the season starts: on the first circuit", testCircuit(season)?.trackId === season.settings.circuits[0] && testCircuit(season)?.roundIndex === 0);
  run = startSeason(run);
  const plan = racePlan(run, () => 4000, "ME")!;
  run = recordRound(run, plan, { results: [{ code: "", isPlayer: true, position: 1, lapsCompleted: plan.laps }], laps: plan.laps, lapsLed: 0 });
  check("during the season: on the next round's circuit", testCircuit(run.season!)?.trackId === run.season!.settings.circuits[1] && testCircuit(run.season!)?.roundIndex === 1);

  const car = run.season!.settings.car;
  const at = run.season!.settings.circuits[1];
  const lap = (bestMs: number | null, targetMs: number | null = 80000): TestDayResult => ({ trackId: at, car, laps: 1, bestMs, targetMs });
  check("no lap: nothing kept", recordTestDay(run, { ...lap(79000), laps: 0 }) === run);
  let r = recordTestDay(run, lap(null, null));
  r = recordTestDay(r, lap(82000));
  r = recordTestDay(r, lap(81000));
  r = recordTestDay(r, lap(null, 79500));
  const kept = seasonTest(r.season!, at, car);
  check("laps summed, the better best, the newest target", kept?.laps === 4 && kept.bestMs === 81000 && kept.targetMs === 79500, JSON.stringify(kept));
  r = recordTestDay(r, { ...lap(70000), car: "vw-scirocco-gtx" });
  r = recordTestDay(r, { ...lap(90000), trackId: run.season!.settings.circuits[2] });
  check("one result per circuit and car", r.season!.tests?.length === 3 && seasonTest(r.season!, at, car)?.bestMs === 81000);
  check("the record changes the career's time (the newer copy wins a sync)", r.updatedAt >= run.updatedAt);
  check("a season started keeps its pre-season test", (() => {
    const pre = recordTestDay(newCareer("road", "clubCup_europe", content, 43)!, { trackId: "x", car, laps: 3, bestMs: 70000, targetMs: 71000 });
    return startSeason(pre).season!.tests?.[0]?.laps === 3;
  })());
}

console.log("target");
{
  const run = startSeason(newCareer("road", "clubCup_europe", content, 7)!);
  const season = run.season!;
  const series = seriesById(season.seriesId)!;
  const t = testTargetMs(run, 80000, 1)!;
  check("a target from the reference lap", t !== null && t > 80000 && t < 80000 * 1.1, String(t));
  const slower = testTargetMs(updateRaceSettings(run, { aiLevel: "low" }), 80000, 1)!;
  const faster = testTargetMs(updateRaceSettings(run, { aiLevel: "expert" }), 80000, 1)!;
  check("a weaker field: a slower target; a stronger one: quicker", slower > t && faster < t, `${slower} ${t} ${faster}`);
  check("the line check's reference (a shade slower) gives a quicker target than a lone autopilot lap's", testTargetMs(run, 80000, 0.995)! < t);
  // At the last promotion place: the field's pace there, as the qualifying lap would be
  const paces = season.grid.map((id) => rivalPace(run.rivals.find((r) => r.id === id)!)).sort((a, b) => b - a);
  const places = promotionPlaces(series, season.race.gridSize);
  const quicker = testTargetMs({ ...run, rivals: run.rivals.map((r) => (season.grid.indexOf(r.id) >= 0 && rivalPace(r) <= paces[places - 1] ? { ...r, rating: 1 } : r)) }, 80000, 1)!;
  check("the cut's pace decides it: the slower drivers made quick, the target quickens", quicker < t, `${quicker} vs ${t}`);
  check("no reference, or no season: no target", testTargetMs(run, 0, 1) === null && testTargetMs({ ...run, season: null }, 80000, 1) === null);
}

console.log("reference lap");
{
  const ref = new ReferenceLap("lc26");
  const lineCheck = getActiveTrackMetadata().aiPlans?.lc26;
  check(
    "a circuit's line check for the car: the reference at once, at the line check's level",
    ref.done && lineCheck !== undefined && ref.lapMs === Math.round(lineCheck.physicsLapS * 1000) && ref.base === LINE_CHECK_REF_BASE,
    `${ref.lapMs} ${ref.base}`
  );
  check("…stepping it does nothing more", ref.step(5) && ref.lapMs === Math.round(lineCheck!.physicsLapS * 1000));
}

// --- The save --------------------------------------------------------------------------------------------------------
console.log("save");
{
  const run = startSeason(newCareer("road", "clubCup_europe", content, 99)!);
  const old = withRun(EMPTY_SAVE, run);
  const oldText = JSON.stringify(old);
  check("a save from before test days has none", !oldText.includes('"tests"'));
  const back = parseCareerSave(JSON.parse(oldText));
  check("…and reads back as it was, the same text (the cloud save hashes it)", JSON.stringify(back) === oldText);
  check("…its season without test days", back.runs[0].season!.tests === undefined && testCircuit(back.runs[0].season!) !== null);

  const tested = recordTestDay(run, { trackId: run.season!.settings.circuits[0], car: run.season!.settings.car, laps: 5, bestMs: 81000, targetMs: 80000 });
  // Changed after the copy without it (a record moves the career's time on; the same millisecond here)
  const withTests = withRun(EMPTY_SAVE, { ...tested, updatedAt: run.updatedAt + 1 });
  const text = JSON.stringify(withTests);
  check("a save with a test day reads back the same", JSON.stringify(parseCareerSave(JSON.parse(text))) === text);

  const broken = JSON.parse(text) as { runs: CareerRun[] };
  (broken.runs[0].season as unknown as { tests: unknown[] }).tests.push({ trackId: 3, laps: "x" }, null, { trackId: "a", car: "liana", laps: 2, bestMs: -5, targetMs: null });
  const fixed = parseCareerSave(broken);
  check("broken entries dropped, the good one kept", fixed.runs.length === 1 && fixed.runs[0].season!.tests?.length === 1 && fixed.runs[0].season!.tests[0].laps === 5);
  const notList = JSON.parse(text) as { runs: CareerRun[] };
  (notList.runs[0].season as unknown as { tests: unknown }).tests = "nonsense";
  const cleaned = parseCareerSave(notList);
  check("test days that are not a list: dropped, the career kept", cleaned.runs.length === 1 && cleaned.runs[0].season!.tests === undefined);

  const combined = parseCareerSave(JSON.parse(combineCareers(oldText, text)));
  check("two devices: the copy with the test day (changed last) wins, its test day kept", combined.runs[0].season!.tests?.[0]?.bestMs === 81000);
}

console.log(`\n${passed} checks passed`);
