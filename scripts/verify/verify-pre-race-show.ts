/**
 * Checks the career's pre-race show (`src/lib/show/show-timeline.ts`, `src/lib/show/circuit-stage.ts`,
 * `src/lib/render/pre-race-show.ts`): the scenes of each show land on the music's sections, pole lands on the peak
 * for a usual grid, a skip goes to the start card and the card waits, the grid's pairs run from the back, the aerial
 * cuts share their scene, the circuit drawing's projection, and the director: when a show starts (a round's qualifying,
 * its grid at the lights), that a restart does not play it again, that its cameras always place, and that the start
 * card's start hands the camera back.
 * Run: npx tsx scripts/verify/verify-pre-race-show.ts
 */
import * as THREE from "three";
import { getActiveTrackData, TURN_METADATA } from "../../src/lib/track-data";
import {
  aerialCut,
  buildShowTimeline,
  DEFAULT_SHOW_MARKERS,
  GRID_INTRO_S,
  gridPairs,
  PAIR_MAX_S,
  PAIR_MIN_S,
  sceneAt,
  ShowClock,
  TITLE_S,
} from "../../src/lib/show/show-timeline";
import { circuitStageModel, projectStage, type Projected } from "../../src/lib/show/circuit-stage";
import { PreRaceShowDirector, type ShowCars, type ShowFrame, type ShowGridRow } from "../../src/lib/render/pre-race-show";
import type { ShowContext } from "../../src/lib/show/show-context";

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

// --- Timeline -------------------------------------------------------------------------------------------------
console.log("timeline");
{
  const m = DEFAULT_SHOW_MARKERS;
  const race = buildShowTimeline("race", 20, m);
  const ids = race.scenes.map((s) => s.id);
  check("race: title, circuit, aerial, tyres, grid intro, the pairs, the card", ids.join(",") === ["title", "circuit", "aerial", "tyres", "gridIntro", ...Array(10).fill("gridPair"), "ready"].join(","), ids.join(","));
  check("scenes follow each other without gaps", race.scenes.every((s, i) => i === 0 || near(s.startS, race.scenes[i - 1].endS)));
  check("the title runs first, for its own length", race.scenes[0].startS === 0 && near(race.scenes[0].endS, TITLE_S));
  check("the tyres come in on the music's section", near(race.scenes.find((s) => s.id === "tyres")!.startS, m.tyresAtS));
  check("the grid comes in on its section", near(race.scenes.find((s) => s.id === "gridIntro")!.startS, m.gridAtS));
  const pairs = race.scenes.filter((s) => s.id === "gridPair");
  check("20 cars: 10 pairs, numbered from the back", pairs.length === 10 && pairs.every((s, i) => s.pair === i));
  check("pole lands on the music's peak", near(pairs[pairs.length - 1].endS, m.climaxS, 1e-6), `${pairs[pairs.length - 1].endS} vs ${m.climaxS}`);
  check("the start card has no end and follows the last pair", race.scenes[race.scenes.length - 1].endS === Infinity && near(race.readyAtS, pairs[pairs.length - 1].endS));
  check("the race show plays its cue from the top", race.musicFromS === 0);

  const small = buildShowTimeline("race", 4, m);
  check("a small grid's pairs are held at their longest (pole early, never stretched)", near(small.pairS, PAIR_MAX_S));
  const big = buildShowTimeline("race", 40, m);
  check("a big grid's pairs never go under their shortest", near(big.pairS, PAIR_MIN_S));
  const odd = buildShowTimeline("race", 7, m);
  check("7 cars: 4 pairs", odd.scenes.filter((s) => s.id === "gridPair").length === 4);

  const quali = buildShowTimeline("qualifying", 12, m);
  const qIds = quali.scenes.map((s) => s.id);
  check("qualifying: the opening, the field, the card (no grid)", qIds.join(",") === "title,circuit,aerial,tyres,field,ready", qIds.join(","));
  const grid = buildShowTimeline("grid", 12, m);
  check("the grid after qualifying: its card and pairs only", grid.scenes[0].id === "gridIntro" && grid.scenes.every((s) => s.id === "gridIntro" || s.id === "gridPair" || s.id === "ready"));
  check("…its cue starts inside the grid's section", grid.musicFromS >= m.gridAtS && grid.musicFromS < m.climaxS, String(grid.musicFromS));
  check("…late enough for pole to land on the peak (12 cars)", near(grid.readyAtS + grid.musicFromS, m.climaxS), `${grid.readyAtS + grid.musicFromS}`);
  const grid20 = buildShowTimeline("grid", 20, m);
  check("…and with 20 cars, from the grid's section itself", near(grid20.musicFromS, m.gridAtS) && near(grid20.readyAtS + grid20.musicFromS, m.climaxS));
  const broken = buildShowTimeline("race", 10, { tyresAtS: Number.NaN, gridAtS: 3, climaxS: 1 });
  check("markers out of order fall back to sane ones", broken.scenes.every((s, i) => i === 0 || s.startS >= broken.scenes[i - 1].startS) && broken.readyAtS > GRID_INTRO_S);
  check("no grid at all: straight to the card after the tyres", buildShowTimeline("race", 0, m).scenes.map((s) => s.id).join(",") === "title,circuit,aerial,tyres,ready");

  const at = sceneAt(race, m.tyresAtS + 1);
  check("sceneAt: a second into the tyres", at.scene.id === "tyres" && near(at.localS, 1) && at.progress > 0 && at.progress < 1);
  check("sceneAt: before 0 is the title, far past the end is the card", sceneAt(race, -5).scene.id === "title" && sceneAt(race, 1e6).scene.id === "ready");
}

console.log("clock");
{
  const clock = new ShowClock(buildShowTimeline("race", 8));
  check("a new clock names its first scene once", clock.step(0) && !clock.step(0));
  check("a frame's step is capped (a stall does not skip scenes)", (clock.step(5), near(clock.timeS, 0.25)));
  check("a paused frame (dt 0) does not move it", (clock.step(0), near(clock.timeS, 0.25)));
  check("skip: straight to the card", clock.skip() && clock.onReadyCard && clock.at.scene.id === "ready");
  check("skip on the card does nothing", !clock.skip());
  for (let i = 0; i < 400; i++) clock.step(0.25);
  check("the card waits however long", clock.at.scene.id === "ready");
}

console.log("grid pairs and aerial cuts");
{
  const order = ["P1", "P2", "P3", "P4", "P5"];
  const pairs = gridPairs(order);
  check("from the back: the odd car out alone first, the front row last", JSON.stringify(pairs) === JSON.stringify([["P5"], ["P3", "P4"], ["P1", "P2"]]), JSON.stringify(pairs));
  const cut = aerialCut(19.6, 0);
  check("a 19.6 s aerial scene: three shots of 6.53 s", cut.shot === 0 && near(cut.cutS, 19.6 / 3));
  check("…the last shot holds to the scene's end", aerialCut(19.6, 19.59).shot === 2 && aerialCut(19.6, 50).shot === 2);
  check("…each shot starts from its own beginning", near(aerialCut(19.6, 19.6 / 3 + 1).shotS, 1));
}

// --- The circuit drawing ------------------------------------------------------------------------------------------
console.log("circuit stage");
const track = getActiveTrackData();
{
  const model = circuitStageModel(track.samples, track.totalLengthM, TURN_METADATA, !track.pointToPoint)!;
  check("the active circuit gives a drawing", model !== null && model.points.length >= 300, String(model?.points.length));
  check("its points are centred on the circuit's middle", Math.abs(model.points.reduce((a, p) => a + p.x, 0) / model.points.length) < model.radius * 0.5);
  check("its corners are on the drawing", model.turns.length === TURN_METADATA.length && model.turns.every((t) => t.at >= 0 && t.at < model.points.length));
  check("the share of the lap rises along the points", model.points.every((p, i) => i === 0 || p.u >= model.points[i - 1].u));
  const view = { yaw: 0.4, pitch: (54 * Math.PI) / 180, width: 1600, height: 900, centreX: 800, centreY: 414, fill: 0.86 };
  const out: Projected = { x: 0, y: 0, depth: 0 };
  let inFrame = 0;
  for (const p of model.points) {
    projectStage(model, view, p.x, p.y, p.z, out);
    if (out.x >= 0 && out.x <= 1600 && out.y >= 0 && out.y <= 900 && out.depth > 0) inFrame++;
  }
  check("the whole lap is on a wide screen", inFrame === model.points.length, `${inFrame}/${model.points.length}`);
  const centre = projectStage(model, view, 0, 0, 0, { x: 0, y: 0, depth: 0 });
  check("the circuit's middle projects to the frame's centre point", near(centre.x, 800, 1e-6) && near(centre.y, 414, 1e-6));
  const upper = projectStage(model, view, 0, 50, 0, { x: 0, y: 0, depth: 0 });
  check("a raised point is drawn higher and nearer (the wall rises towards the eye)", upper.y < centre.y && upper.depth < centre.depth);
  const far = projectStage(model, view, 0, 0, 200, { x: 0, y: 0, depth: 0 });
  check("the far side (+z turned) is further away", far.depth > centre.depth || projectStage(model, { ...view, yaw: 0 }, 0, 0, 200, { x: 0, y: 0, depth: 0 }).depth > centre.depth);
  check("too few samples: no drawing", circuitStageModel(track.samples.slice(0, 4), track.totalLengthM, [], true) === null);
}

// --- The director ------------------------------------------------------------------------------------------------
console.log("director");
{
  let ended = 0;
  const show = new PreRaceShowDirector(track, () => ended++);
  const ctx: ShowContext = {
    seriesId: "clubCup",
    roundIndex: 1,
    rounds: 6,
    laps: 8,
    pitStops: 0,
    qualifyingMin: 10,
    drivers: { AAA: { code: "AAA", first: "Ann", last: "Ash", number: 7, color: "#ff0000", isPlayer: false }, ME: { code: "ME", first: "", last: "Me", number: null, color: "#ccff00", isPlayer: true } },
    standings: [],
    weather: "clear",
    timeOfDay: "afternoon",
  };
  const grid: ShowGridRow[] = [
    { code: "AAA", color: "#ff0000", isPlayer: false, lapMs: 90000 },
    { code: "ME", color: "#ccff00", isPlayer: true, lapMs: 90500 },
  ];
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
  show.update(frame({ qualifying: true }));
  check("not armed: nothing plays", !show.playing);
  show.arm(ctx);
  show.update(frame({ qualifying: true, allowed: false }));
  check("not allowed for now (the menus, a replay): nothing plays", !show.playing);
  show.update(frame({ qualifying: true }));
  check("a round's qualifying starts the qualifying show", show.playing && show.getSnapshot().kind === "qualifying");
  const p = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 6000);
  const cars: ShowCars = {
    player: { position: new THREE.Vector3(track.spawnGrid[1].position[0], track.spawnGrid[1].position[1], track.spawnGrid[1].position[2]), quaternion: new THREE.Quaternion() },
    frontWheel: null,
    carOf: () => null,
    fogDensity: 0.00035,
    still: false,
  };
  let allPlaced = true;
  for (let i = 0; i < 70 * 4; i++) {
    show.update(frame({ qualifying: true, dt: 0.25 }));
    if (!show.placeCamera(p, cars) || !Number.isFinite(p.position.x)) allPlaced = false;
  }
  check("every qualifying scene places the camera (a wheel shot without a wheel films the car)", allPlaced);
  check("…and it waits on its card", show.playing && show.getSnapshot().scene === "ready");
  show.startNow();
  check("Start hands the camera back once", !show.playing && ended === 1 && !show.placeCamera(p, cars));
  show.update(frame({ qualifying: true }));
  check("the same qualifying does not play twice", !show.playing);
  show.update(frame({ atLights: true, grid }));
  check("its race at the lights: the grid show", show.playing && show.getSnapshot().kind === "grid" && show.getSnapshot().grid.length === 2);
  allPlaced = true;
  for (let i = 0; i < 60 * 4; i++) {
    show.update(frame({ atLights: true, grid, dt: 0.25 }));
    if (!show.placeCamera(p, cars)) allPlaced = false;
  }
  check("every grid scene places the camera (cars found by their grid slots)", allPlaced);
  show.skip();
  check("a skip on the card starts", !show.playing && ended === 2);
  show.update(frame({ atLights: true, grid }));
  check("a restart at the lights (a mulligan) does not play it again", !show.playing);
  show.arm({ ...ctx, roundIndex: 2, qualifyingMin: 0 });
  show.update(frame({ atLights: true, grid }));
  check("the next round, raced from the grid: the full race show", show.playing && show.getSnapshot().kind === "race");
  show.update(frame({ allowed: false, atLights: true, grid }));
  check("no longer allowed (the round left): it ends", !show.playing && ended === 3);
  show.arm({ ...ctx, roundIndex: 4, qualifyingMin: 0 });
  show.update(frame({ suppressed: true, atLights: true, grid }));
  check("the setting off as the grid forms: nothing plays", !show.playing);
  show.update(frame({ atLights: true, grid }));
  check("…nor later at the same lights once it is back on", !show.playing && !show.wantsGrid);
  show.arm({ ...ctx, roundIndex: 5, qualifyingMin: 0 });
  show.update(frame({ atLights: true, grid }));
  show.update(frame({ suppressed: true, atLights: true, grid }));
  check("suppressed mid-show (VR, the setting off): it ends", !show.playing && ended === 4);
  show.arm({ ...ctx, roundIndex: 3, qualifyingMin: 0 });
  show.update(frame({ atLights: true, grid }));
  show.arm(null);
  check("disarmed mid-show: it ends", !show.playing && ended === 5);

  // The music: the show waits a moment for it, then follows it
  const tuned = new PreRaceShowDirector(track, () => {});
  tuned.arm({ ...ctx, roundIndex: 9, qualifyingMin: 0 });
  tuned.update(frame({ atLights: true, grid, musicExpected: true }));
  for (let i = 0; i < 30; i++) tuned.update(frame({ atLights: true, grid, musicExpected: true, dt: 1 / 30 }));
  check("music on its way: the show holds at its opening", tuned.timeS() === 0);
  for (let i = 0; i < 40; i++) tuned.update(frame({ atLights: true, grid, musicExpected: true, dt: 1 / 30 }));
  check("…for a moment only: then it runs without it", tuned.timeS() > 0);
  const t0 = tuned.timeS();
  for (let i = 0; i < 60; i++) tuned.update(frame({ atLights: true, grid, musicS: t0 + 3 + i / 30, dt: 1 / 30 }));
  check("music ahead: the clock catches it up within a couple of seconds", Math.abs(tuned.timeS() - (t0 + 3 + 59 / 30)) < 0.4, `${tuned.timeS()} vs ${t0 + 3 + 59 / 30}`);
  const t1 = tuned.timeS();
  tuned.update(frame({ atLights: true, grid, musicS: t1 - 5, dt: 1 / 30 }));
  check("music behind: the clock never runs backwards", tuned.timeS() >= t1);
}

console.log(`\n${passed} checks passed`);
