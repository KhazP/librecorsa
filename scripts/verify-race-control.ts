/**
 * Checks race control and the new HUD data: judged track limits (touch, no advantage, gain, give-back, lift,
 * corner cut, warnings and penalties), penalised classification, the MFD relative and fuel strategy, and the
 * garage setup clamping.
 * Run: npx tsx scripts/verify-race-control.ts
 */
import { TrackLimitsMonitor, type TrackLimitsEvent, type TrackLimitsFrame } from "../src/lib/sim/track-limits";
import { classifiedTimeS, type RacerProgress } from "../src/lib/sim/race-session";
import { computeRelatives, fuelStrategy, type LapRecord } from "../src/components/hud/mfd-data";
import { clampChassisSetup, DEFAULT_CHASSIS_SETUP, FUEL_LOAD } from "../src/lib/sim/car-setup";
import { applyTimeTrial, lowestFuelSetup, timeTrialRealism, timeTrialRules } from "../src/lib/sim/time-trial";
import { SIM_REALISM_FLAGS, type SimRealismFlags } from "../src/lib/sim/sim-realism";
import { TrackEvolutionState } from "../src/lib/sim/track-evolution";
import { LapRecorder } from "../src/lib/sim/lap-recorder";
import type { CarTelemetry, RaceStandingEntry } from "../src/types/f1";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { createAmgGt3Sim } from "../src/lib/sim/gt3/AmgGt3Sim";
import { createMtr496rSim } from "../src/lib/sim/proto/Mtr496rSim";
import { createSuzukiLianaSim } from "../src/lib/sim/road/SuzukiLianaSim";
import { createVf26Sim } from "../src/lib/sim/f12026-car/Vf26Sim";
import type { SimulatorCar } from "../src/lib/sim/simulator-car";
import { F1Physics2026 } from "../src/lib/f1-physics-2026";
import { createFlatTestTrack } from "./lib/flat-track";
import { AiOpponentField, AI_DRIVERS } from "../src/lib/sim/ai-opponents";
import { getActiveTrackData } from "../src/lib/track-data";

let passed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) {
    console.error(`FAIL ${name} ${detail}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}`);
}

const DT = 1 / 60;
let clock = 0;

/** Drives the monitor for `seconds` with a frame built from `f`; returns every event raised */
function drive(m: TrackLimitsMonitor, seconds: number, f: Partial<TrackLimitsFrame>): TrackLimitsEvent[] {
  const events: TrackLimitsEvent[] = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    clock += DT;
    const ev = m.update({
      nowMs: clock * 1000,
      dtS: DT,
      lapCount: 1,
      distM: 1000,
      offTrack: false,
      throttle: 1,
      brake: 0,
      lateralM: 0,
      curvature: 0,
      deltaS: 0,
      active: true,
      ...f,
    });
    if (ev) events.push(ev);
  }
  return events;
}

/** One excursion off the outside of a straight with the given delta before and after */
function wide(m: TrackLimitsMonitor, offS: number, entryDelta: number | null, exitDelta: number | null, throttle = 1): TrackLimitsEvent[] {
  return [
    ...drive(m, 0.2, { deltaS: entryDelta }),
    ...drive(m, offS, { offTrack: true, deltaS: entryDelta, throttle, lateralM: 6 }),
    ...drive(m, 0.5, { deltaS: exitDelta }),
    ...drive(m, 1.5, { deltaS: exitDelta }),
  ];
}

console.log("Track limits · judging");
{
  const m = new TrackLimitsMonitor();
  m.reset("race");
  const ev = wide(m, 0.06, 0, 0);
  check("a touch shorter than the minimum is ignored", ev.length === 0 && !m.judging);

  const ev2 = wide(m, 0.6, 0.0, 0.25);
  check("running wide and losing time: no advantage", ev2.length === 1 && ev2[0].kind === "no_advantage", JSON.stringify(ev2));
  check("no warning for it", m.snapshot(clock * 1000).warnings === 0);

  const ev3 = wide(m, 0.6, 0.0, -0.3);
  check("gaining time puts it under review (no decision yet)", ev3.length === 0 && m.judging);
  const pend = m.snapshot(clock * 1000).pending;
  check("give-back card with the gain", pend?.stage === "give_back" && Math.abs((pend?.gainS ?? 0) - 0.3) < 1e-6, JSON.stringify(pend));
  const ev4 = drive(m, 6.5, { deltaS: -0.3 });
  check("not given back in the window: warning 1/3", ev4.length === 1 && ev4[0].kind === "warning" && ev4[0].reason === "gained");
  check("warning counted", m.snapshot(clock * 1000).warnings === 1 && m.strikes === 1);

  wide(m, 0.6, 0.0, -0.3);
  const ev5 = [...drive(m, 1.0, { deltaS: -0.1 }), ...drive(m, 1.0, { deltaS: 0.02 })];
  check("giving the time back clears it", ev5.length === 1 && ev5[0].kind === "cleared", JSON.stringify(ev5));
  check("still one warning", m.snapshot(clock * 1000).warnings === 1);
}

console.log("Track limits · without a reference lap");
{
  const m = new TrackLimitsMonitor();
  m.reset("race");
  const ev = wide(m, 0.5, null, null, 0.2);
  check("lifted while off: no advantage", ev.length === 1 && ev[0].kind === "no_advantage");
  const ev2 = wide(m, 0.5, null, null, 1);
  check("flat out while off: lift owed", ev2.length === 0 && m.snapshot(clock * 1000).pending?.stage === "give_back");
  const ev3 = drive(m, 1.0, { deltaS: null, throttle: 0 });
  check("lifting for long enough clears it", ev3.length === 1 && ev3[0].kind === "cleared", JSON.stringify(ev3));

  // Inside of a right-hander, lifting while off still is a cut
  const ev4 = [
    ...drive(m, 0.2, { deltaS: null }),
    ...drive(m, 0.5, { offTrack: true, deltaS: null, throttle: 0.2, lateralM: 5, curvature: 1 / 80 }),
    ...drive(m, 2.0, { deltaS: null }),
    ...drive(m, 6.5, { deltaS: null, throttle: 1 }),
  ];
  check("a corner cut is a strike even when lifting", ev4.length === 1 && ev4[0].kind === "warning" && ev4[0].reason === "corner_cut", JSON.stringify(ev4));
  const outside = [
    ...drive(m, 0.2, { deltaS: null }),
    ...drive(m, 0.5, { offTrack: true, deltaS: null, throttle: 0.2, lateralM: -5, curvature: 1 / 80 }),
    ...drive(m, 2.0, { deltaS: null }),
  ];
  check("the outside of the same corner is not a cut", outside.length === 1 && outside[0].kind === "no_advantage", JSON.stringify(outside));
}

console.log("Track limits · warnings and penalties");
{
  const m = new TrackLimitsMonitor();
  m.reset("race");
  const strike = () => [...wide(m, 0.6, 0, -0.3), ...drive(m, 6.5, { deltaS: -0.3 })];
  const kinds = [strike(), strike(), strike()].map((e) => e.map((x) => x.kind).join(","));
  check("warnings 1, 2, then a penalty", kinds.join("|") === "warning|warning|penalty", kinds.join("|"));
  check("first penalty is +3 s", m.penaltyTotalS === 3);
  check("the warnings start again after a penalty", m.snapshot(clock * 1000).warnings === 0);
  strike();
  strike();
  const third = strike();
  check("second penalty is +5 s", third[0]?.kind === "penalty" && third[0].penaltyS === 5 && m.penaltyTotalS === 8);
  check("race control banner text", m.snapshot(clock * 1000).message?.text === "+5.0s time penalty", m.snapshot(clock * 1000).message?.text);


  const q = new TrackLimitsMonitor();
  q.reset("race");
  drive(q, 0.2, {});
  drive(q, 0.5, { offTrack: true, lateralM: 6 });
  drive(q, 0.1, { active: false });
  check("going inactive (lights, pause, autopilot) drops the excursion", !q.judging);

  const g = new TrackLimitsMonitor();
  g.reset("race");
  wide(g, 0.6, 0.0, -0.3);
  const owed = g.snapshot(clock * 1000).pending;
  drive(g, 3, { active: false, deltaS: -0.3 });
  check("a give-back still owed waits while not judged (autopilot on)", g.judging && g.snapshot(clock * 1000).pending === null);
  drive(g, DT, { deltaS: -0.3 });
  const resumed = g.snapshot(clock * 1000).pending;
  check(
    "its window stood still meanwhile",
    resumed?.stage === "give_back" && owed !== null && Math.abs(resumed.remainingS - (owed.remainingS - DT)) < 1e-6,
    `${owed?.remainingS} then ${resumed?.remainingS}`
  );
  const verdict = drive(g, 6.5, { deltaS: -0.3 });
  check("and it is decided once the driver drives again", verdict.length === 1 && verdict[0].kind === "warning", JSON.stringify(verdict));

  const again = new TrackLimitsMonitor();
  again.reset("race");
  wide(again, 0.6, 0.0, -0.3);
  drive(again, 0.3, { offTrack: true, lateralM: 6, deltaS: -0.3 });
  check("going off again while giving back drops the gain measured before", again.snapshot(clock * 1000).pending?.gainS === null);
  drive(again, 2.0, { deltaS: null });
  const relifted = again.snapshot(clock * 1000).pending;
  check("judged again without a reference: no stale gain on the card", relifted?.stage === "give_back" && relifted.gainS === null, JSON.stringify(relifted));
}

console.log("Track limits · a course cut");
{
  // The short lap's link on the Grand Prix lap: off the track on its way in, 685 m round the lap in one frame, still off
  // until it joins the lap again, then a corner of the lap cut on the way out (so a later excursion would be a strike)
  const L = 5895;
  const link = (m: TrackLimitsMonitor) => [
    ...drive(m, 1, { distM: 1100, lapLengthM: L, deltaS: 0 }),
    ...drive(m, 2, { distM: 1200, lapLengthM: L, offTrack: true, lateralM: -30, curvature: 0.01, deltaS: 0 }),
    ...drive(m, 1, { distM: 1885, lapLengthM: L, offTrack: true, lateralM: -30, curvature: 0.01, deltaS: -10 }),
    ...drive(m, 3, { distM: 1900, lapLengthM: L, deltaS: -10 }),
  ];
  const race = new TrackLimitsMonitor();
  race.reset("race");
  const ev = link(race);
  const said = race.snapshot(clock * 1000).message?.text;
  check(
    "in a race: the cut is said as such, and the rest of that excursion is no warning on top",
    ev.length === 1 && ev[0].kind === "lap_invalid" && said === "Course cut · lap not counted" && race.strikes === 0 && !race.judging,
    `${JSON.stringify(ev)} ${said}`
  );
  const practice = new TrackLimitsMonitor();
  practice.reset("practice");
  const pev = link(practice);
  check("in practice: the lap is deleted", pev.some((e) => e.kind === "lap_invalid") && practice.snapshot(clock * 1000).message?.text === "Course cut · lap deleted");
  const plain = new TrackLimitsMonitor();
  plain.reset("race");
  check("without the lap length nothing is read into a jump", drive(plain, 1, { distM: 1100 }).length === 0 && drive(plain, 1, { distM: 1885 }).length === 0);
}

console.log("Track limits · strict outside a race");
{
  const p = new TrackLimitsMonitor();
  p.reset("practice");
  drive(p, 0.2, { sector: 1 });
  const touch = drive(p, 0.05, { offTrack: true, sector: 1, lateralM: 6 });
  check("practice: even a touch off the track deletes the lap at once", touch.length === 1 && touch[0].kind === "lap_invalid" && touch[0].lap === 1, JSON.stringify(touch));
  check("practice: nothing to give back, nothing under review", !p.judging && p.snapshot(clock * 1000).pending === null && p.penaltyTotalS === 0);
  check("practice: the banner says the lap is deleted", p.snapshot(clock * 1000).message?.kind === "lap_invalid" && p.snapshot(clock * 1000).message?.detail === "Off the track");
  const gained = [...wide(p, 0.6, 0, -0.3), ...drive(p, 6.5, { deltaS: -0.3 })];
  check("practice: no give-back and no time test, one deletion per excursion", gained.length === 1 && gained[0].kind === "lap_invalid", JSON.stringify(gained));
  const next = drive(p, 0.5, { lapCount: 2, sector: 1 });
  check("practice: an excursion before the last sector leaves the next lap alone", next.length === 0 && !p.nextLapForfeit);

  drive(p, 0.2, { lapCount: 2, sector: 3 });
  const late = drive(p, 0.4, { lapCount: 2, sector: 3, offTrack: true, lateralM: 6 });
  check("practice: an excursion in the last sector deletes the lap and the next", late.length === 1 && p.nextLapForfeit && p.snapshot(clock * 1000).message?.detail === "Next lap too", JSON.stringify(late));
  drive(p, 0.3, { lapCount: 2, sector: 3 });
  const onNext = drive(p, 0.3, { lapCount: 3, sector: 1 });
  check("practice: the next lap is deleted from its start", onNext.length === 1 && onNext[0].kind === "lap_invalid" && onNext[0].lap === 3 && !p.nextLapForfeit, JSON.stringify(onNext));
  check("practice: and the banner says why", p.snapshot(clock * 1000).message?.detail === "Off before the line");
  check("practice: the lap after that is clean", drive(p, 0.3, { lapCount: 4, sector: 1 }).length === 0);

  // A flying restart: the run-up is in the last sector, and the first crossing only restarts the lap clock
  p.reset("practice");
  drive(p, 0.2, { lapCount: 0, lapTimeMs: 1000, sector: 3 });
  drive(p, 0.2, { lapCount: 0, lapTimeMs: 1200, sector: 3, offTrack: true, lateralM: 6 });
  drive(p, 0.2, { lapCount: 0, lapTimeMs: 1400, sector: 3 });
  const first = drive(p, DT, { lapCount: 0, lapTimeMs: 10, sector: 1 });
  check("practice: off on the run-up deletes the first timed lap", first.length === 1 && first[0].lap === 0, JSON.stringify(first));
  check("practice: and only that one", drive(p, 0.2, { lapCount: 1, lapTimeMs: 10, sector: 1 }).length === 0);

  drive(p, 0.2, { lapCount: 1, sector: 3, offTrack: true, lateralM: 6 });
  p.reset("practice");
  check("practice: a restart clears the next lap's deletion", !p.nextLapForfeit && drive(p, 0.3, { lapCount: 2, sector: 1 }).length === 0);

  check("practice: the autopilot is not judged", drive(p, 0.3, { offTrack: true, active: false, sector: 1 }).length === 0);
  drive(p, 0.2, { lapCount: 2, sector: 3, offTrack: true, lateralM: 6 });
  drive(p, 0.2, { lapCount: 3, sector: 1, active: false });
  check("practice: a lap the autopilot starts takes the next lap's deletion with it", !p.nextLapForfeit && drive(p, 0.2, { lapCount: 4, sector: 1 }).length === 0);
}

console.log("Track limits · every engine honours strict and judged");
{
  const track = getActiveTrackData(1200);
  const engines = [
    ["2026 Prototype (classic engine)", () => new F1Physics2026(track)],
    ["2026 Prototype (rigid body)", () => createVf26Sim(track)],
    ["AMG GT3", () => createAmgGt3Sim(track)],
    ["MTR 496R", () => createMtr496rSim(track)],
    ["Suzuki Liana", () => createSuzukiLianaSim(track)],
  ] as const;
  /** From a flying start, steered off the road: whether the running lap reads deleted once the car is off */
  const offLap = (make: () => SimulatorCar, mode: "strict" | "judged") => {
    const car = make();
    car.trackLimitsMode = mode;
    car.resetToStartGrid(true);
    for (let i = 0; i < 60 * 8; i++) {
      car.step(1 / 60, { throttle: 0.5, brake: 0, steerLeft: 0, steerRight: 0, analogSteer: 0.7, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false });
      if (car.telemetry.offTrack) {
        for (let k = 0; k < 3; k++) car.step(1 / 60, {});
        return { off: true, deleted: car.telemetry.lapInvalid === true };
      }
    }
    return { off: false, deleted: car.telemetry.lapInvalid === true };
  };
  for (const [name, make] of engines) {
    const strict = offLap(make, "strict");
    const judged = offLap(make, "judged");
    check(`${name}: strict deletes the lap off the track, judged leaves it to race control`, strict.off && strict.deleted && judged.off && !judged.deleted, JSON.stringify({ strict, judged }));
  }
}

console.log("Time trial · fixed conditions");
{
  const track = getActiveTrackData(1200);
  const cars = [
    ["2026 Prototype (classic engine)", () => new F1Physics2026(track), "vf26", FUEL_LOAD.vf26.minKg],
    ["2026 Prototype (rigid body)", () => createVf26Sim(track), "vf26", FUEL_LOAD["f12026-car"].minKg],
    ["AMG GT3", () => createAmgGt3Sim(track), "amg-gt3", FUEL_LOAD["amg-gt3"].minKg],
    ["MTR 496R", () => createMtr496rSim(track), "mtr-496r", FUEL_LOAD["mtr-496r"].minKg],
    ["Suzuki Liana", () => createSuzukiLianaSim(track), "liana", FUEL_LOAD.liana.minKg],
  ] as const;
  for (const [name, make, vehicle, minKg] of cars) {
    const car: SimulatorCar = make();
    const garage = { ...DEFAULT_CHASSIS_SETUP, fuelDeltaKg: 20, frontWingClicks: 3 };
    car.applyChassisSetup?.(garage);
    car.tireCompound = "hard";
    car.resetToStartGrid(false);
    const own = car.telemetry.fuelKg;
    const road = new TrackEvolutionState(track.totalLengthM);
    applyTimeTrial(car, timeTrialRules(vehicle), garage, road, (c) => (car.tireCompound = c));
    car.resetToStartGrid(true);
    const first = car.telemetry.fuelKg;
    for (let i = 0; i < 120; i++) car.step(1 / 60, { throttle: 1 });
    applyTimeTrial(car, timeTrialRules(vehicle), garage, road, (c) => (car.tireCompound = c));
    car.resetToStartGrid(true);
    const kept = car.getChassisSetup?.();
    check(
      `${name}: the lowest fuel it allows and its one tyre, at every flying restart, the rest of the setup kept`,
      Math.abs(first - minKg) < 0.01 && Math.abs(car.telemetry.fuelKg - minKg) < 0.01 && own > minKg + 5 && car.tireCompound === timeTrialRules(vehicle).compound && kept?.frontWingClicks === 3,
      `${own.toFixed(1)} kg own, ${first.toFixed(2)} then ${car.telemetry.fuelKg.toFixed(2)} kg, ${car.tireCompound}`
    );
  }
  const road = new TrackEvolutionState(track.totalLengthM);
  road.reset("green");
  road.holdFullGrip(true);
  road.reset("green");
  for (let i = 0; i < 600; i++) road.depositCarPass(500, 6, 0, 40_000, 1 / 60);
  road.weatherWash(1, 600);
  const held = road.sample(500, 6, 0);
  const onLine = road.sample(500, 0, 0);
  check(
    "the road is held fully rubbered: no green reset, no marbles, no wash",
    road.meanRacingLineRubber() === 1 && held.marbleLevel === 0 && onLine.gripMultiplier > 1.02,
    `rubber ${road.meanRacingLineRubber()}, grip ${onLine.gripMultiplier.toFixed(4)}`
  );
  road.holdFullGrip(false);
  road.reset("natural");
  check("let go, the road takes the session's rubber again", Math.abs(road.meanRacingLineRubber() - 0.65) < 1e-9);
  for (const [name, make] of [["AMG GT3", () => createAmgGt3Sim(track)], ["MTR 496R", () => createMtr496rSim(track)]] as const) {
    const burn = (flags: SimRealismFlags) => {
      const car = make();
      car.applyChassisSetup?.(lowestFuelSetup(DEFAULT_CHASSIS_SETUP));
      car.setSimRealism?.(flags);
      car.resetToStartGrid(true);
      const before = car.telemetry.fuelKg;
      for (let i = 0; i < 60 * 10; i++) car.step(1 / 60, { throttle: 1, brake: 0, steerLeft: 0, steerRight: 0, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false });
      return before - car.telemetry.fuelKg;
    };
    const used = burn(SIM_REALISM_FLAGS.full);
    const held = burn(timeTrialRealism(SIM_REALISM_FLAGS.full));
    check(`${name}: the time trial burns none of its low fuel`, used > 0.05 && held === 0, `${used.toFixed(3)} kg in 10 s flat out at Full, ${held} in the time trial`);
  }
}

console.log("Time trial · race control, the car and the lap recorder together");
{
  const track = getActiveTrackData(1200);
  const car = createVf26Sim(track);
  const monitor = new TrackLimitsMonitor();
  const recorder = new LapRecorder({ trackLengthM: track.totalLengthM, turns: [], trackId: "test", vehicle: "vf26", driverName: "Test", driverCode: "TST" });
  /** One frame as the drive session runs it: the car, race control (its deletion on the car), then the recorder */
  const frame = (offTrack?: boolean) => {
    car.step(DT, {});
    const t = car.telemetry;
    clock += DT;
    const ev = monitor.update({
      nowMs: clock * 1000,
      dtS: DT,
      lapCount: t.lapCount,
      lapTimeMs: t.currentLapTimeMs,
      sector: t.currentSector,
      distM: t.trackDistanceM,
      offTrack: offTrack ?? t.offTrack,
      throttle: t.throttle,
      brake: t.brake,
      lateralM: car.lateralOffsetM,
      curvature: 0,
      deltaS: null,
      active: true,
    });
    if (ev && ev.kind === "lap_invalid" && ev.lap === t.lapCount) car.invalidateLap?.();
    return { ev, done: recorder.update({ telemetry: t, position: car.worldPosition, quaternion: car.worldQuaternion }) };
  };
  car.trackLimitsMode = "strict";
  car.aiAutopilot = true;
  monitor.reset("practice");
  car.resetToStartGrid(true);
  const laps: boolean[] = [];
  let offDone = false;
  for (let i = 0; i < 60 * 600 && laps.length < 3; i++) {
    const t = car.telemetry;
    // Once into the first timed lap's last sector, a moment off the track (as race control is told it)
    const off = !offDone && laps.length === 0 && t.currentSector === 3 && t.currentLapTimeMs > 20_000;
    if (off) offDone = true;
    const { done } = frame(off || undefined);
    if (done) laps.push(done.summary.valid);
  }
  check("an off in the last sector deletes that lap and the next, and the one after counts", laps.join() === "false,false,true", laps.join());

  // Off in the gravel, then a flying restart from there: a clean lap from the first frame
  car.aiAutopilot = false;
  for (let i = 0; i < 60 * 8 && !car.telemetry.offTrack; i++) {
    car.step(DT, { throttle: 0.5, brake: 0, steerLeft: 0, steerRight: 0, analogSteer: 0.7, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false });
  }
  const wentOff = car.telemetry.offTrack;
  monitor.reset("practice");
  recorder.reset();
  car.resetToStartGrid(true);
  car.aiAutopilot = true;
  const after = [frame(), frame(), frame(), frame(), frame()];
  check(
    "a flying restart from off the track starts clean",
    wentOff && !car.telemetry.offTrack && car.telemetry.lapInvalid === false && after.every((f) => f.ev === null) && !monitor.nextLapForfeit,
    JSON.stringify({ wentOff, off: car.telemetry.offTrack, invalid: car.telemetry.lapInvalid })
  );
}

console.log("Classification with penalties");
{
  const a: RacerProgress = { id: "a", distM: 0, finishTimeS: 100, penaltyS: 5 } as RacerProgress;
  const b: RacerProgress = { id: "b", distM: 0, finishTimeS: 103 } as RacerProgress;
  check("penalty added to the race time", classifiedTimeS(a) === 105 && classifiedTimeS(b) === 103);
}

console.log("MFD relative");
{
  const L = 5000;
  const st = (code: string, trackS: number, raceDistM: number, isPlayer = false): RaceStandingEntry => ({
    driverCode: code,
    teamColorHex: "#fff",
    isPlayer,
    lap: 1,
    gapToLeaderS: 0,
    trackS,
    raceDistM,
  });
  const t = {
    trackDistanceM: 100,
    speedMs: 50,
    race: {
      phase: "racing",
      lightsOn: 0,
      position: 2,
      fieldSize: 4,
      lap: 2,
      standings: [st("LAP", 4950, 9950), st("YOU", 100, 5100, true), st("AHD", 160, 5160), st("BHD", 40, 5040), st("DWN", 300, 300)],
    },
  } as unknown as CarTelemetry;
  const rows = computeRelatives(t, null, L, "soft");
  const codes = rows.map((r) => r.code).join(",");
  check("ordered by road position around the player", codes === "DWN,AHD,YOU,BHD,LAP", codes);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  check("a car across the line shows behind on the road", byCode.LAP.dsM === -150);
  check("lap up / lap down", byCode.LAP.lapDiff === 1 && byCode.DWN.lapDiff === -1 && byCode.AHD.lapDiff === 0);
  check("road gap from speed without a reference", Math.abs(byCode.AHD.gapS - 60 / 50) < 1e-9 && byCode.BHD.gapS < 0);
}

console.log("Fuel strategy");
{
  const lap = (fuelKg: number): LapRecord => ({ lap: 1, timeMs: 90_000, sectorsMs: [30_000, 30_000, 30_000], valid: true, fuelKg, ersPct: 2, wearPct: 0.5 });
  const t = {
    fuelKg: 10,
    ersBatteryPercent: 50,
    trackProgress: 0,
    race: { phase: "racing", totalLaps: 10, lap: 3, standings: [{ isPlayer: true, raceDistM: 2 * 5000 }] },
  } as unknown as CarTelemetry;
  const f = fuelStrategy(t, [lap(1.4), lap(1.5), lap(1.6), lap(1.5)], 5000);
  check("three-lap rolling average", Math.abs((f.avgFuelKg ?? 0) - (1.5 + 1.6 + 1.5) / 3) < 1e-9 && f.samples === 3);
  check("race laps to go from race distance", f.raceLapsLeft === 8);
  check("target per lap and the saving needed", Math.abs((f.targetKg ?? 0) - 1.25) < 1e-9 && (f.saveKg ?? 0) > 0.28 && (f.liftS ?? 0) > 0);
  const none = fuelStrategy({ ...t, fuelKg: 0 } as CarTelemetry, [lap(0)], 5000);
  check("cars without a fuel model report energy only", !none.hasFuel && none.avgFuelKg === null && none.avgErsPct === 2);
}

console.log("Garage setup");
{
  const s = clampChassisSetup({ frontWingClicks: 31, rearWingClicks: -2.4, springFrontPct: 11, arbFrontPct: -63, arbRearPct: "x", toeFrontDeg: 0.123, bogus: 1 });
  check(
    "clamped and snapped to the steps",
    s.frontWingClicks === 25 && s.rearWingClicks === -2 && s.springFrontPct === 10.5 && s.arbFrontPct === -50 && s.arbRearPct === 0 && s.toeFrontDeg === 0.12,
    JSON.stringify({ fw: s.frontWingClicks, rw: s.rearWingClicks, sp: s.springFrontPct, arbF: s.arbFrontPct, arbR: s.arbRearPct, toe: s.toeFrontDeg })
  );
  check("old single bump / rebound values carry over to all four dampers", (() => {
    const m = clampChassisSetup({ bumpPct: 15, reboundPct: -10, fastBumpRearPct: 5 });
    return m.bumpFrontPct === 15 && m.bumpRearPct === 15 && m.fastBumpFrontPct === 15 && m.fastBumpRearPct === 5 && m.reboundFrontPct === -10 && m.fastReboundRearPct === -10;
  })());
  check("junk gives the baseline", JSON.stringify(clampChassisSetup(null)) === JSON.stringify(DEFAULT_CHASSIS_SETUP));
}

console.log("Garage on the sims");
{
  const flat = createFlatTestTrack(20_000);
  type Inner = {
    vehicle: { wheels: { coldPressurePsi: number; isFront: boolean }[] };
    config: { suspensions: { front: { springs: { wheel_rate: number } } } };
  };
  const makers = [
    ["f12026-car", () => new F12026CarSim(flat)],
    ["amg-gt3", () => createAmgGt3Sim(flat)],
  ] as const;
  for (const [name, make] of makers) {
    const car = make();
    car.resetToStartGrid(false);
    const inner = car as unknown as Inner;
    const setup = car.getTyreSetup();
    const psi = setup.coldPressurePsi.fl - 1;
    car.setTyreSetup({ ...setup, coldPressurePsi: { ...setup.coldPressurePsi, fl: psi, fr: psi } });
    car.resetToStartGrid(false);
    car.teleportToDistance(500, 20);
    const fronts = inner.vehicle.wheels.filter((w) => w.isFront).map((w) => w.coldPressurePsi);
    check(`${name}: cold pressures survive a reset and a teleport`, fronts.every((v) => Math.abs(v - psi) < 1e-9), JSON.stringify(fronts));

    const baseRate = inner.config.suspensions.front.springs.wheel_rate;
    car.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP, springFrontPct: 21 });
    check(`${name}: stiffer front springs`, Math.abs(inner.config.suspensions.front.springs.wheel_rate - baseRate * 1.21) < 1e-6);
    car.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP });
    check(`${name}: back to the baseline`, Math.abs(inner.config.suspensions.front.springs.wheel_rate - baseRate) < 1e-6);

    // Ride height: the car settles higher with +8 mm at both ends
    const settle = (mm: number) => {
      const c = make();
      c.applyChassisSetup?.({ ...DEFAULT_CHASSIS_SETUP, rideHeightFrontMm: mm, rideHeightRearMm: mm });
      c.resetToStartGrid(false);
      for (let i = 0; i < 180; i++) c.step(1 / 60, { brake: 1 });
      const rh = c.telemetry.wheelRideHeightsMm;
      return (rh[0] + rh[1] + rh[2] + rh[3]) / 4;
    };
    const lift = settle(8) - settle(0);
    check(`${name}: +8 mm ride height settles about 8 mm higher`, lift > 5 && lift < 11, `${lift.toFixed(2)} mm`);

    // Live fuel consumption on f12026-car and amg-gt3
    const fuelCar = make();
    fuelCar.resetToStartGrid(true);
    const startFuel = fuelCar.telemetry.fuelKg;
    for (let i = 0; i < 60; i++) fuelCar.step(1 / 60, { throttle: 1 });
    const afterFuel = fuelCar.telemetry.fuelKg;
    check(`${name}: starts with fuel and burns fuel on throttle`, startFuel > 20 && afterFuel < startFuel, `${startFuel.toFixed(3)} -> ${afterFuel.toFixed(3)} kg`);
  }
  const vf = new F1Physics2026(flat);
  vf.resetToStartGrid(false);
  const other = new F1Physics2026(flat);
  vf.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, arbRearPct: 50 });
  type VfAxles = { axles: { spec: { arbRate: number } }[] };
  const a = (vf as unknown as VfAxles).axles[1].spec.arbRate;
  const b = (other as unknown as VfAxles).axles[1].spec.arbRate;
  check("vf26: the setup changes this car only (the AI cars keep the baseline)", Math.abs(a - b * 1.5) < 1e-6, `${a} vs ${b}`);

  // VF26 ride-height setup affects ground-effect downforce and rideHeightOffsetM
  const vfLow = new F1Physics2026(flat);
  vfLow.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, rideHeightFrontMm: -6, rideHeightRearMm: -6 });
  vfLow.resetToStartGrid(true);
  for (let i = 0; i < 30; i++) vfLow.step(1 / 60, { throttle: 1 });
  const vfHigh = new F1Physics2026(flat);
  vfHigh.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, rideHeightFrontMm: 10, rideHeightRearMm: 10 });
  vfHigh.resetToStartGrid(true);
  for (let i = 0; i < 30; i++) vfHigh.step(1 / 60, { throttle: 1 });
  check(
    "vf26: ride-height setup shifts ground-effect downforce and chassis height",
    Math.abs(vfHigh.telemetry.downforceN - vfLow.telemetry.downforceN) > 50 &&
      vfHigh.rideHeightOffsetM > vfLow.rideHeightOffsetM + 0.01,
    `df: ${vfLow.telemetry.downforceN.toFixed(0)} vs ${vfHigh.telemetry.downforceN.toFixed(0)} N`
  );
}

console.log("Track limits · illegal overtake position hand-back");
{
  const m = new TrackLimitsMonitor();
  m.reset("race");
  drive(m, 0.2, { racePosition: 4, deltaS: 0 });
  drive(m, 0.5, { offTrack: true, racePosition: 3, deltaS: 0.1, throttle: 0.3, lateralM: 6 });
  const rejoins = drive(m, 2.0, { racePosition: 3, deltaS: 0.1 });
  const pend = m.snapshot(clock * 1000).pending;
  check("off-track overtake triggers giveBackPosition stage", rejoins.length === 0 && Boolean(pend?.giveBackPosition), JSON.stringify(pend));
  const givenBack = drive(m, 1.0, { racePosition: 4, deltaS: 0.1 });
  check("returning the position clears the illegal overtake", givenBack.length === 1 && givenBack[0].kind === "cleared", JSON.stringify(givenBack));

  // Keeping the position past the 10 s window triggers an immediate +5 s penalty
  drive(m, 0.2, { racePosition: 4, deltaS: 0 });
  drive(m, 0.5, { offTrack: true, racePosition: 3, deltaS: 0.1, throttle: 0.3, lateralM: 6 });
  const kept = drive(m, 12.2, { racePosition: 3, deltaS: 0.1 });
  check(
    "keeping an off-track overtake past 10 s gives +5 s penalty",
    kept.length === 1 && kept[0].kind === "penalty" && kept[0].reason === "illegal_overtake" && kept[0].penaltyS === 5,
    JSON.stringify(kept)
  );

  // The overtake penalty is its own: the first track-limits penalty after it is still +3 s
  const strike = () => [...wide(m, 0.6, 0, -0.3), ...drive(m, 6.5, { deltaS: -0.3 })];
  const limits = [strike(), strike(), strike()].flat().filter((e) => e.kind === "penalty");
  check(
    "after an overtake penalty, the first track-limits penalty is +3 s",
    limits.length === 1 && limits[0].penaltyS === 3 && m.penaltyTotalS === 8,
    JSON.stringify(limits)
  );
}

console.log("AI race · overtaking-aid rules per car");
{
  const track = getActiveTrackData(1200);
  const player = new F1Physics2026(track);
  const field = new AiOpponentField(track, player, [AI_DRIVERS[0]], undefined, { seed: 1, learning: false });
  const ai = field.aiSims()[0];
  check("a field built but never started applies no race rules", !field.raceRulesActive && ai.raceControl?.racing === false);
  field.startRace(true);
  check("the rules apply from the start lights", field.raceRulesActive && ai.raceControl?.racing === true);
  type Inner = { cars: { isPlayer: boolean; clock: { finishTimeS: number | null } }[] };
  const cars = (field as unknown as Inner).cars;
  const playerCar = cars.find((c) => c.isPlayer);
  const aiCar = cars.find((c) => !c.isPlayer);
  if (playerCar) playerCar.clock.finishTimeS = 300;
  field.phase = "finished";
  check("the player's flag frees the player's aids", !field.raceRulesActive);
  check("an AI car still racing stays under the rules", ai.raceControl?.racing === true);
  if (aiCar) aiCar.clock.finishTimeS = 305;
  check("and is free after its own flag", ai.raceControl?.racing === false);
  // The result carries each car's place on the grid (1 = pole), for places gained and lost
  const rows = field.status().results ?? [];
  const grid = (field.report().cars as { code: string; gridPos: number }[]).map((c) => [c.code, c.gridPos] as const);
  check(
    "every result row carries its car's grid place",
    rows.length === 2 && rows.every((r) => r.gridPosition === grid.find(([code]) => code === r.driverCode)?.[1]),
    JSON.stringify(rows.map((r) => [r.driverCode, r.gridPosition]))
  );
}

console.log(`\n${passed} checks passed`);

