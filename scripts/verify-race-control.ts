/**
 * Checks race control and the new HUD data: judged track limits (touch, no advantage, gain, give-back, lift,
 * corner cut, warnings and penalties), penalised classification, the MFD relative and fuel strategy, and the
 * garage setup clamping.
 * Run: npx tsx scripts/verify-race-control.ts
 */
import {
  COURSE_CUT_MARGIN_S,
  COURSE_CUT_MIN_PENALTY_S,
  TrackLimitsMonitor,
  weightedCutPoints,
  type CutInput,
  type TrackLimitsEvent,
  type TrackLimitsFrame,
} from "../src/lib/sim/track-limits";
import { resolveRaceRules } from "../src/lib/sim/race-rules";
import { YellowPassJudge, type YellowPassEvent } from "../src/lib/sim/yellow-passes";
import { BlueFlagJudge, blueFlagYieldTarget, type BlueFlagEvent } from "../src/lib/sim/blue-flags";
import { VscController, vscReferenceSpeedMs, type VscEvent } from "../src/lib/sim/vsc";
import { PenaltyLedger } from "../src/lib/sim/penalty-ledger";
import { parseRaceSetup, rulesForSetup } from "../src/lib/sim/race-setup";
import { VEHICLE_MODELS } from "../src/lib/cars/vehicle-models";
import { classify, raceOrder } from "../src/lib/sim/race-session";
import { stretchTimeS } from "../src/lib/sim/course-limits";
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
import { createLc26Sim } from "../src/lib/sim/f12026-car/Lc26Sim";
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
  // The short lap's link on the Grand Prix lap: off the road at 1,100 m, 685 m round the lap in one frame, still off
  // until it joins the lap again at 1,900 m 3 s after leaving, then a corner of the lap cut on the way out (so a later
  // excursion would be a strike). The reference lap runs at 50 m/s: 16 s from 1,100 to 1,900 m, so the cut saved 13 s
  const L = 5895;
  const ref = new Float64Array(1179).fill(50);
  const stretchRefS = (a: number, b: number) => stretchTimeS(ref, L, a, b);
  const link = (m: TrackLimitsMonitor, ref: typeof stretchRefS | null = stretchRefS, refS = ref ?? undefined) => [
    ...drive(m, 1, { distM: 1100, lapLengthM: L, stretchRefS: refS, deltaS: 0 }),
    ...drive(m, 2, { distM: 1200, lapLengthM: L, stretchRefS: refS, offTrack: true, lateralM: -30, curvature: 0.01, deltaS: 0 }),
    ...drive(m, 1, { distM: 1885, lapLengthM: L, stretchRefS: refS, offTrack: true, lateralM: -30, curvature: 0.01, deltaS: -10 }),
    ...drive(m, 3, { distM: 1900, lapLengthM: L, stretchRefS: refS, deltaS: -10 }),
  ];
  check("the reference lap's time over a stretch", Math.abs(stretchRefS(1100, 1900) - 16) < 1e-9 && Math.abs(stretchRefS(5800, 100) - 195 / 50) < 1e-9);
  const race = new TrackLimitsMonitor();
  race.reset("race");
  const ev = link(race);
  const said = race.snapshot(clock * 1000).message?.text;
  const saved = race.lastCutSavedS ?? 0;
  const pen = ev.filter((e) => e.kind === "penalty");
  check(
    "in a race: the cut deletes the lap, and back on the track it costs the time it saved and 5 s more",
    pen.length === 1 && ev.every((e) => e.kind === "penalty" || e.kind === "lap_invalid") && pen[0].reason === "course_cut" &&
      Math.abs(saved - 13) < 0.05 && pen[0].penaltyS === Math.ceil(saved + COURSE_CUT_MARGIN_S) && race.penaltyTotalS === pen[0].penaltyS &&
      said === `Course cut · +${pen[0].penaltyS?.toFixed(1)}s time penalty`,
    `${JSON.stringify(ev)} ${said}, saved ${saved.toFixed(2)} s`
  );
  check("no warning on top for the rest of that excursion", race.strikes === 0 && !race.judging && race.snapshot(clock * 1000).warnings === 0);
  const blind = new TrackLimitsMonitor();
  blind.reset("race");
  const bev = link(blind, null);
  check("without a reference lap: the least penalty", bev.some((e) => e.kind === "penalty" && e.penaltyS === COURSE_CUT_MIN_PENALTY_S) && blind.penaltyTotalS === COURSE_CUT_MIN_PENALTY_S);
  // The Grand Prix lap's loop driven on the short lap: off the road at 1,100 m, the lap position jumps back to 480 m,
  // then 10 s later ahead to 1,206 m, and the car rejoins at 1,210 m having lost over 10 s on the reference
  const detour = new TrackLimitsMonitor();
  detour.reset("race");
  const dev = [
    ...drive(detour, 1, { distM: 1100, lapLengthM: L, stretchRefS, deltaS: 0 }),
    ...drive(detour, 2, { distM: 1150, lapLengthM: L, stretchRefS, offTrack: true, lateralM: 30, deltaS: 0 }),
    ...drive(detour, 10, { distM: 480, lapLengthM: L, stretchRefS, offTrack: true, lateralM: 180, deltaS: 0 }),
    ...drive(detour, 1, { distM: 1206, lapLengthM: L, stretchRefS, offTrack: true, lateralM: 30, deltaS: 0 }),
    ...drive(detour, 2, { distM: 1210, lapLengthM: L, stretchRefS, deltaS: 0 }),
  ];
  check("a longer way round: the lap is deleted, no penalty", detour.penaltyTotalS === 0 && dev.some((e) => e.kind === "lap_invalid") && (detour.lastCutSavedS ?? 0) < -5,
    `${JSON.stringify(dev)} saved ${detour.lastCutSavedS?.toFixed(1)} s`);
  const practice = new TrackLimitsMonitor();
  practice.reset("practice");
  const pev = link(practice);
  check("in practice: the lap is deleted, no penalty", pev.some((e) => e.kind === "lap_invalid") && practice.penaltyTotalS === 0 && practice.snapshot(clock * 1000).message?.text === "Course cut · lap deleted");
  const plain = new TrackLimitsMonitor();
  plain.reset("race");
  check("without the lap length nothing is read into a jump", drive(plain, 1, { distM: 1100 }).length === 0 && drive(plain, 2, { distM: 1885 }).length === 0);
  // Far off the road between two parts of the lap that lie close: the lap distance jumps there and back
  const between = new TrackLimitsMonitor();
  between.reset("race");
  const there = [
    ...drive(between, 1, { distM: 30, lapLengthM: 932 }),
    ...drive(between, DT, { distM: 210, lapLengthM: 932 }),
    ...drive(between, 3, { distM: 32, lapLengthM: 932 }),
  ];
  check("a jump there and back is no cut", there.length === 0 && between.snapshot(clock * 1000).message === null, JSON.stringify(there));
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

console.log("Track limits · barrier contact");
{
  // The car's contact total grows by `share` of each frame (1 = touching the whole frame)
  let total = 0;
  const walls = (m: TrackLimitsMonitor, seconds: number, share: number, wallRule: TrackLimitsFrame["wallRule"], f: Partial<TrackLimitsFrame> = {}): TrackLimitsEvent[] => {
    const events: TrackLimitsEvent[] = [];
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      total += share * DT;
      events.push(...drive(m, DT, { sector: 1, wallContactS: total, wallRule, ...f }));
    }
    return events;
  };
  const p = new TrackLimitsMonitor();
  p.reset("practice");
  walls(p, 0.5, 0, "ride");
  const brushes = [...walls(p, 0.15, 1, "ride"), ...walls(p, 1.35, 0, "ride"), ...walls(p, 0.15, 1, "ride"), ...walls(p, 3.2, 0, "ride")];
  check("a circuit: two brushes off the wall (0.15 s each) in 3 s keep the lap", brushes.length === 0, JSON.stringify(brushes));
  const ride = walls(p, 1.5, 0.3, "ride");
  check("a circuit: leaning on the wall (a third of the time) deletes the lap once it adds up to 0.35 s", ride.length === 1 && ride[0].kind === "lap_invalid" && ride[0].reason === "wall_contact" && ride[0].lap === 1, JSON.stringify(ride));
  const said = p.snapshot(clock * 1000).message;
  check("and the banner says why", said?.text === "Wall contact · lap deleted" && said?.detail === "Rode the wall", JSON.stringify(said));
  check("scraping on along it is the same breach, one deletion", walls(p, 2, 1, "ride").length === 0);
  walls(p, 3.2, 0, "ride");
  check("a second ride after 3 clean seconds is another", walls(p, 0.5, 1, "ride", { lapCount: 2 }).length === 1);
  walls(p, 3.2, 0, "ride", { lapCount: 2 });
  const touch = walls(p, DT, 0.1, "touch", { lapCount: 3 });
  check("a hill climb: any touch ends the run", touch.length === 1 && p.snapshot(clock * 1000).message?.detail === "Touched the barrier", JSON.stringify(touch));
  walls(p, 3.2, 0, "touch", { lapCount: 3 });
  check("no wall rule (past a hill climb's finish), no verdict", walls(p, 1, 1, undefined, { lapCount: 3 }).length === 0);
  check("the autopilot is not judged", walls(p, 1, 1, "ride", { lapCount: 3, active: false }).length === 0);
  check("the contact the autopilot had is not counted when the driver takes over", walls(p, 0.2, 0, "ride", { lapCount: 3 }).length === 0);

  // A circuit's wall-ride in the last sector is as an excursion there: the lap that starts next goes too
  const w = new TrackLimitsMonitor();
  w.reset("practice");
  walls(w, 0.5, 0, "ride", { sector: 3 });
  const lastCorner = walls(w, 1.0, 0.4, "ride", { sector: 3 });
  check(
    "a circuit: riding the wall in the last sector deletes the lap and the next",
    lastCorner.length === 1 && lastCorner[0].reason === "wall_contact" && lastCorner[0].lap === 1 && w.nextLapForfeit && w.snapshot(clock * 1000).message?.detail === "Next lap too",
    JSON.stringify({ lastCorner, forfeit: w.nextLapForfeit, said: w.snapshot(clock * 1000).message }),
  );
  const overLine = walls(w, 1.0, 0.4, "ride", { lapCount: 2, sector: 1 });
  check("held over the line, the new lap is deleted from its start, for the wall", overLine.length === 1 && overLine[0].kind === "lap_invalid" && overLine[0].reason === "wall_contact" && overLine[0].lap === 2 && !w.nextLapForfeit, JSON.stringify(overLine));
  const saidAtLine = w.snapshot(clock * 1000).message;
  check("and the banner says why", saidAtLine?.text === "Wall contact · lap deleted" && saidAtLine?.detail === "Rode the wall before the line", JSON.stringify(saidAtLine));
  walls(w, 3.2, 0, "ride", { lapCount: 2, sector: 1 });
  check("the lap after that is clean", walls(w, 0.5, 0, "ride", { lapCount: 3, sector: 1 }).length === 0);

  w.reset("practice");
  walls(w, 0.5, 0, "ride", { sector: 3 });
  walls(w, 1.0, 0.4, "ride", { sector: 3 });
  walls(w, 3.2, 0, "ride", { sector: 3 });
  const nextAfterRide = walls(w, 0.3, 0, "ride", { lapCount: 2, sector: 1 });
  check("a ride in the last sector over before the line still deletes the next lap", nextAfterRide.length === 1 && nextAfterRide[0].lap === 2 && nextAfterRide[0].reason === "wall_contact", JSON.stringify(nextAfterRide));

  w.reset("practice");
  walls(w, 0.5, 0, "ride", { sector: 2 });
  walls(w, 1.0, 0.4, "ride", { sector: 2 });
  walls(w, 3.2, 0, "ride", { sector: 3 });
  check("a ride before the last sector leaves the next lap alone", !w.nextLapForfeit && walls(w, 0.5, 0, "ride", { lapCount: 2, sector: 1 }).length === 0);

  // A frame with no sector: a breach still running as the lap starts deletes that lap too
  w.reset("practice");
  walls(w, 0.5, 0, "ride", { sector: undefined });
  walls(w, 1.0, 0.4, "ride", { sector: undefined });
  const noSector = walls(w, 0.5, 0.4, "ride", { lapCount: 2, sector: undefined });
  check("with no sector, a ride still going at the line deletes the new lap", noSector.length === 1 && noSector[0].lap === 2 && noSector[0].reason === "wall_contact", JSON.stringify(noSector));
  // With sectors, only the last one's riding carries: the lap clock going back mid-ride (a restart's first crossing)
  // deletes nothing more for a ride before it
  w.reset("practice");
  walls(w, 0.5, 0, "ride", { lapTimeMs: 20_000 });
  walls(w, 1.0, 0.4, "ride", { lapTimeMs: 21_000 });
  const clockBack = walls(w, 0.3, 0, "ride", { lapTimeMs: 10 });
  check("with sectors, a ride before the last sector carries nothing to a lap clock starting over", clockBack.length === 0 && !w.nextLapForfeit, JSON.stringify(clockBack));

  w.reset("practice");
  walls(w, 0.5, 0, "ride", { sector: 3 });
  walls(w, 1.0, 0.4, "ride", { sector: 3 });
  walls(w, 0.2, 0, "ride", { lapCount: 2, sector: 1, active: false });
  check("a lap the autopilot starts takes the wall's next-lap deletion with it", !w.nextLapForfeit && walls(w, 0.5, 0, "ride", { lapCount: 3, sector: 1 }).length === 0);

  // A hill climb's run ends at its finish: a touch before it is that run's, and the return road is not the next run
  w.reset("practice");
  walls(w, 0.5, 0, "touch", { sector: 3 });
  const bale = walls(w, DT, 0.1, "touch", { sector: 3 });
  const nextRun = walls(w, 0.5, 0, "touch", { lapCount: 2, sector: 1 });
  check("a hill climb: a touch before the finish deletes that run only", bale.length === 1 && !w.nextLapForfeit && nextRun.length === 0, JSON.stringify({ bale, nextRun }));

  // In a race, riding the wall is judged as time off the track: an excursion, warnings and penalties as any other
  const r = new TrackLimitsMonitor();
  r.reset("race");
  walls(r, 0.5, 0, "ride", { deltaS: 0 });
  check("a race: a brush is nothing", walls(r, 0.15, 1, "ride", { deltaS: 0 }).length === 0 && !r.judging);
  walls(r, 3.2, 0, "ride", { deltaS: 0 });
  walls(r, 1.0, 1, "ride", { deltaS: 0, lateralM: 4 });
  check("a race: a wall-ride is under review like an excursion", r.judging);
  const verdict = [...walls(r, 0.4, 0, "ride", { deltaS: -0.5, lateralM: 4 }), ...walls(r, 8, 0, "ride", { deltaS: -0.5 })];
  check("a race: gaining time by it is a warning", verdict.length === 1 && verdict[0].kind === "warning", JSON.stringify(verdict));
  // As a car really rides a wall: bouncing along it, touching it one frame in three
  const b = new TrackLimitsMonitor();
  b.reset("race");
  walls(b, 0.5, 0, "ride", { deltaS: 0 });
  let reviewed = false;
  const bounced: TrackLimitsEvent[] = [];
  for (let k = 0; k < 150; k++) {
    bounced.push(...walls(b, DT, k % 3 === 0 ? 1 : 0, "ride", { deltaS: 0, lateralM: 4 }));
    reviewed ||= b.judging;
  }
  bounced.push(...walls(b, 0.4, 0, "ride", { deltaS: -0.5 }), ...walls(b, 8, 0, "ride", { deltaS: -0.5 }));
  check("a race: bouncing along the wall is one excursion under review, then one verdict", reviewed && bounced.length === 1 && bounced[0].kind === "warning", JSON.stringify(bounced));
  // A ride from the last corner held over the line, as an excursion over it: under review as the lap ends (so that
  // lap can't count), then one verdict, for the lap it began on; the new lap is not deleted for it
  const o = new TrackLimitsMonitor();
  o.reset("race");
  walls(o, 0.5, 0, "ride", { deltaS: 0, sector: 3 });
  walls(o, 1.0, 1, "ride", { deltaS: 0, lateralM: 4, sector: 3 });
  const overTheLine = walls(o, 0.5, 1, "ride", { lapCount: 2, deltaS: 0, lateralM: 4, sector: 1 });
  const reviewedAtLine = o.judging;
  overTheLine.push(...walls(o, 0.4, 0, "ride", { lapCount: 2, deltaS: 0, sector: 1 }), ...walls(o, 8, 0, "ride", { lapCount: 2, deltaS: 0, sector: 1 }));
  check(
    "a race: a ride over the line is under review at the line, then one verdict for the lap it began on",
    reviewedAtLine && overTheLine.length === 1 && overTheLine[0].kind === "warning" && overTheLine[0].lap === 1,
    JSON.stringify(overTheLine),
  );
}

console.log("Track limits · every engine honours strict and judged");
{
  const track = getActiveTrackData(1200);
  const engines = [
    ["2026 Prototype (classic engine)", () => new F1Physics2026(track)],
    ["2026 Prototype (rigid body)", () => createLc26Sim(track)],
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
    ["2026 Prototype (classic engine)", () => new F1Physics2026(track), "lc26", FUEL_LOAD.lc26.minKg],
    ["2026 Prototype (rigid body)", () => createLc26Sim(track), "lc26", FUEL_LOAD["f12026-car"].minKg],
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
    // Burning switched on (the game's sprints run a fixed load): the time trial still burns none
    const used = burn({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
    const held = burn(timeTrialRealism({ ...SIM_REALISM_FLAGS.full, fuelUse: true }));
    check(`${name}: the time trial burns none of its low fuel`, used > 0.05 && held === 0, `${used.toFixed(3)} kg in 10 s flat out at Full, ${held} in the time trial`);
  }
}

console.log("Time trial · race control, the car and the lap recorder together");
{
  const track = getActiveTrackData(1200);
  const car = createLc26Sim(track);
  const monitor = new TrackLimitsMonitor();
  const recorder = new LapRecorder({ trackLengthM: track.totalLengthM, turns: [], trackId: "test", vehicle: "lc26", driverName: "Test", driverCode: "TST" });
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
  const rows = computeRelatives(t, null, L, "soft", "TST");
  const codes = rows.map((r) => r.code).join(",");
  check("ordered by road position around the player", codes === "DWN,AHD,YOU,BHD,LAP", codes);
  const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
  check("a car across the line shows behind on the road", byCode.LAP.dsM === -150);
  check("lap up / lap down", byCode.LAP.lapDiff === 1 && byCode.DWN.lapDiff === -1 && byCode.AHD.lapDiff === 0);
  check("road gap from speed without a reference", Math.abs(byCode.AHD.gapS - 60 / 50) < 1e-9 && byCode.BHD.gapS < 0);
  const practice = computeRelatives({ ...t, race: undefined, peers: [] } as unknown as CarTelemetry, null, L, "soft", "TST");
  check("outside a race the player goes by their own code", practice.find((r) => r.isPlayer)?.code === "TST");
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

    // Live fuel consumption on f12026-car and amg-gt3, burning switched on (the game's sprints run a fixed load)
    const fuelCar = make();
    (fuelCar as { setSimRealism?: (f: SimRealismFlags) => void }).setSimRealism?.({ ...SIM_REALISM_FLAGS.full, fuelUse: true });
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
  check("lc26: the setup changes this car only (the AI cars keep the baseline)", Math.abs(a - b * 1.5) < 1e-6, `${a} vs ${b}`);

  // LC26 ride-height setup affects ground-effect downforce and rideHeightOffsetM
  const vfLow = new F1Physics2026(flat);
  vfLow.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, rideHeightFrontMm: -6, rideHeightRearMm: -6 });
  vfLow.resetToStartGrid(true);
  for (let i = 0; i < 30; i++) vfLow.step(1 / 60, { throttle: 1 });
  const vfHigh = new F1Physics2026(flat);
  vfHigh.applyChassisSetup({ ...DEFAULT_CHASSIS_SETUP, rideHeightFrontMm: 10, rideHeightRearMm: 10 });
  vfHigh.resetToStartGrid(true);
  for (let i = 0; i < 30; i++) vfHigh.step(1 / 60, { throttle: 1 });
  check(
    "lc26: ride-height setup shifts ground-effect downforce and chassis height",
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

console.log("Track limits · weighted points");
{
  const cut = (c: Partial<CutInput>): number =>
    weightedCutPoints({
      gainS: null,
      shortcutM: 0,
      offThrottleAvg: 1,
      brakingZone: false,
      speedGainMs: 0,
      curvatureRad: 0,
      wallRiding: false,
      wallContactS: 0,
      ...c,
    });
  const ladder: [number, number][] = [
    [0.05, 0],
    [0.15, 0.25],
    [0.5, 1],
    [1.5, 3.25],
    [5, 20.5],
  ];
  for (const [g, pts] of ladder) check(`a ${g} s gain flat out scores ${pts} pts`, cut({ gainS: g }) === pts, String(cut({ gainS: g })));
  check("every score is in quarter points", [0.17, 0.33, 0.71, 1.23, 2.9].every((g) => (cut({ gainS: g }) * 4) % 1 === 0));
  check("lifting halves the score", cut({ gainS: 1, offThrottleAvg: 0 }) === Math.round((1.85 + 0.55 * 0.25) * 0.5 * 4) / 4);
  check(
    "a wide exit given back by lifting (lost time, a little shortcut) scores nothing",
    cut({ gainS: -0.4, shortcutM: 5, offThrottleAvg: 0.3 }) === 0,
    String(cut({ gainS: -0.4, shortcutM: 5, offThrottleAvg: 0.3 }))
  );
  check(
    "a chicane cut flat out with no time gained still scores its shortcut",
    cut({ gainS: -0.05, shortcutM: 12, offThrottleAvg: 0.9, curvatureRad: 0.6 }) === 1.5,
    String(cut({ gainS: -0.05, shortcutM: 12, offThrottleAvg: 0.9, curvatureRad: 0.6 }))
  );
  check("riding the wall is at least a point", cut({ wallRiding: true, wallContactS: 0.4 }) === 1);
  check("without a reference only the shortcut scores", cut({ gainS: null, shortcutM: 10 }) === 1.25);
}

/** A strike on a straight: off with a gain, not given back (the 6 s window runs out) */
const strikeWith = (m: TrackLimitsMonitor, gainS: number) => [...wide(m, 0.6, 0, -gainS), ...drive(m, 6.5, { deltaS: -gainS })];

console.log("Track limits · four strikes (open wheel)");
{
  const m = new TrackLimitsMonitor();
  m.reset("race", { scoring: "four_strike", pointsAllowed: 4 });
  const calls: string[] = [];
  for (let i = 0; i < 12; i++) {
    const ev = strikeWith(m, 0.3).filter((e) => e.kind !== "cleared" && e.kind !== "no_advantage");
    calls.push(ev.map((e) => (e.kind === "penalty" ? `+${e.penaltyS}` : e.kind)).join(","));
    if (i === 2) {
      const snap = m.snapshot(clock * 1000);
      check(
        "three strikes: the black-and-white flag, next is +5 s",
        snap.message?.kind === "final_warning" && snap.message.detail === "Time gained · next is +5 s" && snap.ladder?.blackWhite === true,
        JSON.stringify(snap.message)
      );
    }
  }
  check(
    "1-3 warnings, 4 +5 s, 8 +10 s, 12 disqualified",
    calls.join("|") === "warning|warning|warning|+5|warning|warning|warning|+10|warning|warning|warning|disqualified",
    calls.join("|")
  );
  check("the time penalties add up to 15 s", m.penaltyTotalS === 15, String(m.penaltyTotalS));
  check("disqualified", m.disqualified && m.snapshot(clock * 1000).ladder?.disqualified === true);
  check("nothing is judged after the disqualification", strikeWith(m, 0.3).length === 0 && !m.judging);
  const snap = new TrackLimitsMonitor();
  snap.reset("race", { scoring: "four_strike", pointsAllowed: 4 });
  strikeWith(snap, 0.3);
  strikeWith(snap, 0.3);
  const s2 = snap.snapshot(clock * 1000);
  check("the meter shows strikes of four", s2.warnings === 2 && s2.strikesPerPenalty === 4 && s2.ladder?.scoring === "four_strike", JSON.stringify(s2));
}

console.log("Track limits · weighted points (endurance)");
{
  const m = new TrackLimitsMonitor();
  m.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const calls: string[] = [];
  // A 1 s gain flat out is 2 points a time
  for (let i = 0; i < 8; i++) {
    const ev = strikeWith(m, 1).filter((e) => e.kind !== "cleared" && e.kind !== "no_advantage");
    calls.push(ev.map((e) => (e.kind === "penalty" ? `+${e.penaltyS}` : e.kind)).join(","));
  }
  check("2, 4 (flag), 6 +5 s, 8, 10 +10 s, 12, 14, 16 disqualified", calls.join("|") === "warning|warning|+5|warning|+10|warning|warning|disqualified", calls.join("|"));
  check("points total", m.pointsTotal === 16, String(m.pointsTotal));
  const w = new TrackLimitsMonitor();
  w.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  strikeWith(w, 0.3);
  const s = w.snapshot(clock * 1000);
  check("a 0.3 s gain is half a point on the meter", s.warnings === 0.5 && s.ladder?.points === 0.5 && s.message?.detail === "Time gained · 0.50 pts", JSON.stringify(s));
}

console.log("Track limits · cuts measured from the car's path");
{
  /**
   * One excursion along a way the test draws: `at(u)` (u 0..1 through the excursion) gives the lap distance, the
   * world position, the curvature and the lateral offset; the car is on the track just before and just after
   */
  const along = (
    m: TrackLimitsMonitor,
    at: (u: number) => { distM: number; x: number; z: number; curvature?: number; lateralM?: number },
    offS = 1.5,
    deltaAfter = 0
  ) => {
    const events: TrackLimitsEvent[] = [];
    const frame = (u: number, offTrack: boolean, seconds: number, deltaS: number) => {
      const p = at(u);
      events.push(
        ...drive(m, seconds, {
          offTrack,
          distM: p.distM,
          posX: p.x,
          posZ: p.z,
          curvature: p.curvature ?? 0,
          lateralM: p.lateralM ?? 0,
          halfWidthM: 6,
          deltaS,
          speedMs: 30,
        })
      );
    };
    frame(0, false, 0.2, 0);
    const n = Math.round(offS / DT);
    for (let i = 0; i <= n; i++) frame(i / n, true, DT, 0);
    frame(1, false, 2, deltaAfter);
    return events;
  };
  /** A straight 40 m of road the car crosses in `40 − cutM` of its own path (a cut, as far as the measure goes) */
  const straightCut = (m: TrackLimitsMonitor, cutM: number) =>
    along(m, (u) => ({ distM: 1000 + 40 * u, x: 0, z: (40 - cutM) * u, lateralM: -6 }));
  /** A right-hand hairpin, 30 m radius round (0, 0): the car on a circle of radius `r`, or straight across from the inside edge */
  const R = 30;
  const hairpin = (m: TrackLimitsMonitor, path: "outside" | "inside_edge" | "across") =>
    along(m, (u) => {
      const th = Math.PI * u;
      const r = path === "outside" ? R + 8 : R - 6;
      const pos = path === "across" ? { x: (R - 6) * (1 - 2 * u), z: 0 } : { x: r * Math.cos(th), z: r * Math.sin(th) };
      return { distM: 1000 + R * th, ...pos, curvature: 1 / R, lateralM: path === "outside" ? -8 : 6 };
    });

  const big = new TrackLimitsMonitor();
  big.reset("race", { scoring: "four_strike", pointsAllowed: 4 });
  const bev = straightCut(big, 25);
  check("cutting 25 m is +5 s at once", bev.length === 1 && bev[0].kind === "penalty" && bev[0].penaltyS === 5 && !big.judging, JSON.stringify(bev));
  const gain = new TrackLimitsMonitor();
  gain.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const gev = [...wide(gain, 0.6, 0, -2.5)];
  check("gaining 2.5 s is +5 s at once (no give-back)", gev.some((e) => e.kind === "penalty" && e.penaltyS === 5) && !gain.judging, JSON.stringify(gev));
  const mid = new TrackLimitsMonitor();
  mid.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const mev = straightCut(mid, 10);
  check(
    "a 10 m cut with no time gained scores its points on the weighted ladder",
    mev.length === 1 && mev[0].kind === "warning" && mev[0].reason === "corner_cut" && mid.pointsTotal === 1.25,
    JSON.stringify(mev) + " " + mid.pointsTotal
  );
  const four = new TrackLimitsMonitor();
  four.reset("race", { scoring: "four_strike", pointsAllowed: 4 });
  const fev = straightCut(four, 10);
  check("the same cut with no gain is no strike on the open-wheel ladder", fev.length === 1 && fev[0].kind === "no_advantage", JSON.stringify(fev));

  const wideHairpin = new TrackLimitsMonitor();
  wideHairpin.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const wev = hairpin(wideHairpin, "outside");
  check(
    "running wide round a hairpin cuts nothing (no penalty, no points)",
    wev.length === 1 && wev[0].kind === "no_advantage" && wideHairpin.pointsTotal === 0 && wideHairpin.penaltyTotalS === 0,
    JSON.stringify(wev)
  );
  const edge = new TrackLimitsMonitor();
  edge.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const eev = hairpin(edge, "inside_edge");
  check("the inside edge's own line is no cut", eev.every((e) => e.kind !== "penalty") && edge.pointsTotal === 0, JSON.stringify(eev));
  const across = new TrackLimitsMonitor();
  across.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  const aev = hairpin(across, "across");
  check("straight across the hairpin's inside (27 m short) is +5 s at once", aev.length === 1 && aev[0].kind === "penalty" && aev[0].penaltyS === 5, JSON.stringify(aev));

  const legacy = new TrackLimitsMonitor();
  legacy.reset("race");
  check("online's strike ladder takes no notice of the shortcut", straightCut(legacy, 25).every((e) => e.kind === "no_advantage"));
  const off = new TrackLimitsMonitor();
  off.reset("race", { scoring: "disabled", pointsAllowed: 5 });
  check("track limits off: an excursion is not judged", strikeWith(off, 1).length === 0 && straightCut(off, 25).length === 0 && !off.judging);
}

console.log("Track limits · positions gained off the track (points ladders)");
{
  const pass = (m: TrackLimitsMonitor, from: number, to: number) => {
    drive(m, 0.2, { racePosition: from, deltaS: 0 });
    drive(m, 0.5, { offTrack: true, racePosition: to, deltaS: 0.1, throttle: 0.3, lateralM: 6 });
  };
  const m = new TrackLimitsMonitor();
  m.reset("race", { scoring: "weighted_pts", pointsAllowed: 5 });
  pass(m, 4, 3);
  const watched = drive(m, 12.2, { racePosition: 3, deltaS: 0.1 });
  const card = m.snapshot(clock * 1000).pending;
  check("still time to hand it back after 12 s (3 s watched + 15 s)", watched.length === 0 && card?.giveBackPosition === 4, JSON.stringify(card));
  const kept = drive(m, 7.5, { racePosition: 3, deltaS: 0.1 });
  check("one place kept: +5 s", kept.length === 1 && kept[0].kind === "penalty" && kept[0].penaltyS === 5, JSON.stringify(kept));
  pass(m, 5, 3);
  const two = drive(m, 20, { racePosition: 3, deltaS: 0.1 });
  check("two places kept: +10 s", two.length === 1 && two[0].penaltyS === 10, JSON.stringify(two));
  pass(m, 4, 3);
  drive(m, 1.5, { racePosition: 3, deltaS: 0.1 });
  const full = m.snapshot(clock * 1000).pending;
  check("while watched the bar is full", (full?.progress ?? 0) > 0.99 && full?.remainingS === 15, JSON.stringify(full));
  const back = drive(m, 1, { racePosition: 4, deltaS: 0.1 });
  check("handed back: cleared", back.length === 1 && back[0].kind === "cleared");
}

console.log("Race rules · presets by car class");
{
  for (const model of Object.values(VEHICLE_MODELS)) {
    const r = resolveRaceRules(model.classId);
    const f1 = model.classId === "f1";
    check(
      `${model.id}: ${f1 ? "open wheel, four strikes" : "endurance, weighted points"}, standing start`,
      r.preset === (f1 ? "open_wheel" : "endurance_sprint") &&
        r.trackLimits === (f1 ? "four_strike" : "weighted_pts") &&
        r.pointsAllowed === (f1 ? 4 : 5) &&
        r.startKind === "standing" &&
        r.lockAidsInYellow === f1,
      JSON.stringify(r)
    );
  }
  check("a preset picked outright wins over the class", resolveRaceRules("gt3", { rulePreset: "open_wheel" }).trackLimits === "four_strike");
  check("track limits off", resolveRaceRules("f1", { trackLimits: "off" }).trackLimits === "disabled");
  check("a start picked outright", resolveRaceRules("f1", { start: "rolling" }).startKind === "rolling");
  check("old saved setups: a rolling start stays rolling", parseRaceSetup({ start: "rolling" }).startMode === "rolling");
  check("old saved setups: the old standing default becomes auto", parseRaceSetup({ start: "standing" }).startMode === "auto");
  check("the setup's choices reach the rules", rulesForSetup("f1", parseRaceSetup({ rulePreset: "endurance_sprint", trackLimits: "off" })).trackLimits === "disabled");
}

console.log("Classification · disqualified");
{
  const base: RacerProgress = { id: "a", code: "AAA", name: "A", color: "#fff", isPlayer: false, distM: 5000, speedMs: 0, finishTimeS: 300, bestLapMs: null };
  const order = raceOrder(
    [
      { ...base, id: "dq", code: "DQQ", isPlayer: true, finishTimeS: null, distM: 2000, dnf: true, dq: true },
      { ...base, id: "dnf", code: "DNF", finishTimeS: null, distM: 1000, dnf: true },
      { ...base, id: "win", code: "WIN" },
    ],
    1000
  );
  check("a disqualified car is classified behind the retirements", order.map((r) => r.code).join(",") === "WIN,DNF,DQQ", order.map((r) => r.code).join(","));
  const rows = classify(order, 1000, 5, true);
  check("its result says so", rows[2].dq === true && rows[2].dnf === true && !rows[1].dq);
  const track = getActiveTrackData(1200);
  const player = new F1Physics2026(track);
  const field = new AiOpponentField(track, player, [AI_DRIVERS[0]], undefined, { seed: 1, learning: false });
  field.startRace(true);
  field.playerDisqualified = true;
  const st = field.status();
  const me = st.results?.find((r) => r.isPlayer);
  check("the AI race takes the player out, disqualified", st.phase === "finished" && me?.dq === true && me.position === 2, JSON.stringify(me));
  field.startRace(true);
  check("the next start clears it", !field.playerDisqualified && field.status().phase === "lights");
  // A jump start called by the page goes into race control's ledger and onto the feed, with the track-limits time kept apart
  field.playerPenaltyS = 3;
  field.penalisePlayer(10, "jump_start", "Jump start");
  const meNow = field.status().standings.find((e) => e.isPlayer);
  type Feed = { raceControl: { ledger: { entriesOf(code: string): readonly { reason: string; seconds: number }[] }; messages: { kind: string; detail?: string }[] } };
  const rc = (field as unknown as Feed).raceControl;
  check(
    "a jump start is in the ledger and on the feed, added to the track-limits time",
    meNow?.penaltyS === 13 && rc.ledger.entriesOf("YOU").some((e) => e.reason === "jump_start" && e.seconds === 10) && rc.messages.some((m) => m.kind === "penalty" && m.detail === "Jump start"),
    JSON.stringify(meNow)
  );
  // A player racing under an AI driver's code: that driver races renamed, and race control's calls show the race's codes
  const named = new AiOpponentField(track, new F1Physics2026(track), [AI_DRIVERS[0], AI_DRIVERS[1]], undefined, { seed: 1, learning: false });
  named.playerDriver = { code: AI_DRIVERS[0].code, color: "#00ff00" };
  named.qualifying = { playerMs: 1, refLapMs: 90000, refBase: 1 };
  named.startRace(true);
  const shown = named.status().standings.map((e) => e.driverCode);
  const quali = (named.status().qualifying ?? []).map((r) => r.code);
  check(
    "qualifying shows the codes the standings show",
    quali.length === 3 && quali.every((c) => shown.includes(c)) && quali.filter((c) => c === AI_DRIVERS[0].code).length === 1,
    `${quali.join(",")} / ${shown.join(",")}`
  );
  named.playerDisqualified = true;
  const namedFeed = (named as unknown as { raceControl: { messages: { kind: string; text: string }[] } }).raceControl.messages;
  check(
    "the disqualification names the player's own code",
    namedFeed.some((m) => m.kind === "penalty" && m.text === `${AI_DRIVERS[0].code} disqualified`),
    JSON.stringify(namedFeed)
  );
}

console.log("Yellow flags · passing under yellow");
{
  const pass = (j: YellowPassJudge, level: 0 | 1 | 2, exempt = false) => {
    // The other car 5 m ahead, then the player 5 m ahead of it
    j.update(DT, 1000, [{ code: "AAA", distM: 1005, exempt, gone: false }], level, true);
    return j.update(DT, 1010, [{ code: "AAA", distM: 1005, exempt, gone: false }], level, true);
  };
  const hold = (j: YellowPassJudge, seconds: number, meM: number, otherM: number, level: 0 | 1 | 2 = 0) => {
    const ev: YellowPassEvent[] = [];
    for (let t = 0; t < seconds; t += DT) ev.push(...j.update(DT, meM, [{ code: "AAA", distM: otherM, exempt: false, gone: false }], level, true));
    return ev;
  };
  const j = new YellowPassJudge();
  check("passing on a green track is no offence", pass(j, 0).length === 0 && j.owed === null);
  const j2 = new YellowPassJudge();
  const order = pass(j2, 1);
  check("passing under yellow: the place is owed back", order.length === 1 && order[0].kind === "order" && j2.owed?.code === "AAA");
  check("watched first: the hand-back clock shows the full 15 s", j2.owed?.remainingS === 15);
  const back = hold(j2, 1, 1000, 1005);
  check("letting the car back by clears it", back.some((e) => e.kind === "returned") && j2.owed === null, JSON.stringify(back));
  const j3 = new YellowPassJudge();
  pass(j3, 1);
  const kept = hold(j3, 18.5, 1010, 1005);
  check("kept past 3 + 15 s: +5 s", kept.length === 1 && kept[0].kind === "penalty" && kept[0].seconds === 5, JSON.stringify(kept));
  const j4 = new YellowPassJudge();
  pass(j4, 2);
  const keptDouble = hold(j4, 18.5, 1010, 1005);
  check("under a double yellow: +10 s", keptDouble.length === 1 && keptDouble[0].seconds === 10, JSON.stringify(keptDouble));
  const j5 = new YellowPassJudge();
  check("passing the car the flag is out for (or a crawling one) is no offence", pass(j5, 2, true).length === 0);
  const j6 = new YellowPassJudge();
  pass(j6, 1);
  const gone = j6.update(DT, 1010, [{ code: "AAA", distM: 1005, exempt: true, gone: true }], 0, true);
  check("the passed car retires: nothing left to hand back", gone.length === 1 && gone[0].kind === "dropped" && j6.owed === null);
  const j7 = new YellowPassJudge();
  pass(j7, 1);
  for (let t = 0; t < 30; t += DT) j7.update(DT, 1010, [{ code: "AAA", distM: 1005, exempt: false, gone: false }], 0, false);
  check("the clock stops while the player isn't racing (autopilot)", j7.owed?.remainingS === 15);

  const ledger = new PenaltyLedger();
  ledger.add("YOU", { kind: "time_penalty", reason: "yellow_overtake", seconds: 5, atS: 10, label: "" });
  ledger.add("YOU", { kind: "warning", reason: "collision", seconds: 0, atS: 20, label: "" });
  ledger.add("YOU", { kind: "time_penalty", reason: "collision", seconds: 10, atS: 30, label: "" });
  check("the ledger sums the time penalties only", ledger.secondsOf("YOU") === 15 && ledger.entriesOf("YOU").length === 3 && !ledger.disqualified("YOU"));
}

console.log("Blue flags · warnings, penalties and AI yielding");
{
  const L = 5000;
  const bf = new BlueFlagJudge();
  const runBf = (seconds: number, behindM: number, lapperDistM = 6500, speedMs = 60, active = true) => {
    const out: BlueFlagEvent[] = [];
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      out.push(...bf.update(DT, 1000, L, [{ code: "VER", distM: lapperDistM, behindM, speedMs, exempt: false }], active));
    }
    return out;
  };
  check("car on the same lap does not trigger a blue flag", runBf(1, 30, 1030).length === 0 && bf.active === null);
  const evShow = runBf(1, 40, 6000, 60);
  check("lapping car within 1.2 s shows blue flag without immediate warning", evShow.length === 0 && bf.active?.code === "VER" && !bf.active?.warned);
  const evWarn = runBf(5.5, 40, 6000, 60);
  check("ignoring blue flag past 6 s raises a warning", evWarn.some((e) => e.kind === "warning" && e.code === "VER") && bf.active?.warned === true);
  const evPen = runBf(8.5, 40, 6000, 60);
  check("ignoring blue flag past 14 s awards +5 s penalty", evPen.some((e) => e.kind === "penalty" && e.seconds === 5), JSON.stringify(evPen));
  // Letting the lapper pass clears immediately (behindM > L/2 -> ahead on road)
  bf.update(DT, 1000, L, [{ code: "VER", distM: 6050, behindM: L - 5, speedMs: 65, exempt: false }], true);
  check("letting the lapping car past clears the blue flag", bf.active === null);

  // AI yield target: corner -> outside (-insideSign), straight -> off line away from lapper
  const yCorner = blueFlagYieldTarget({ lineLatM: 0, halfRoadM: 6, insideSign: 1, lapperLatM: 0.5, myLatM: 0, gapM: 25, lapperSpeedMs: 65 });
  check("AI blue-flag yield pulls to outside of right-hand corner and lifts decisively", yCorner.targetLatM < -1.5 && yCorner.paceScale <= 0.86);
  const yStraight = blueFlagYieldTarget({ lineLatM: 1, halfRoadM: 6, insideSign: 0, lapperLatM: 1, myLatM: 1, gapM: 20, lapperSpeedMs: 75 });
  check("AI blue-flag yield pulls off-line on straights (not staying on line)", Math.abs(yStraight.targetLatM - 1) >= 2 && yStraight.paceScale <= 0.86);
}

console.log("Virtual Safety Car · deployment, delta enforcement and ending");
{
  const vsc = new VscController();
  let t = 5;
  const stepVsc = (
    seconds: number,
    opts: {
      hasRetiredOnTrack?: boolean;
      hasDoubleYellow?: boolean;
      playerSpeedMs?: number;
      playerOptimalKmh?: number;
      finalLapClosing?: boolean;
      judgePlayer?: boolean;
    } = {}
  ): VscEvent[] => {
    const out: VscEvent[] = [];
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      t += DT;
      out.push(
        ...vsc.update({
          dt: DT,
          raceTimeS: t,
          racing: true,
          finalLapClosing: opts.finalLapClosing ?? false,
          hasRetiredOnTrack: opts.hasRetiredOnTrack ?? false,
          hasDoubleYellow: opts.hasDoubleYellow ?? false,
          playerSpeedMs: opts.playerSpeedMs ?? 30,
          playerOptimalKmh: opts.playerOptimalKmh ?? 180,
          judgePlayer: opts.judgePlayer ?? true,
          rng: () => 0.5,
        })
      );
    }
    return out;
  };

  // Early race (< 15 s): does not deploy during Lap 1 T1 bunching
  check("VSC does not deploy in the first 15 s of a race", stepVsc(5, { hasDoubleYellow: true }).length === 0 && !vsc.active);
  // Advance past 15 s, then trigger via persistent double yellow (3.5 s)
  t = 20;
  const brief = stepVsc(2.0, { hasDoubleYellow: true });
  check("brief double yellow (< 3.5 s) does not deploy VSC", brief.length === 0 && !vsc.active);
  const dep = stepVsc(2.0, { hasDoubleYellow: true });
  check("persistent double yellow deploys VSC", dep.some((e) => e.kind === "deployed") && vsc.phase === "deployed");

  // Driving at reference pace keeps delta positive (no penalty)
  const vRef = vscReferenceSpeedMs(180);
  const clean = stepVsc(6.0, { hasDoubleYellow: true, playerSpeedMs: vRef - 1 });
  check("holding VSC pace keeps delta positive with no penalty", !clean.some((e) => e.kind === "penalty") && (vsc.status()?.deltaS ?? -1) > 0);

  // Speeding well above VSC reference pace past grace + hold draws +5 s penalty
  const fast = stepVsc(7.5, { hasDoubleYellow: true, playerSpeedMs: vRef * 1.65 });
  check("exceeding VSC delta draws +5 s penalty", fast.some((e) => e.kind === "penalty" && e.seconds === 5), JSON.stringify(fast));

  // Clear hazard and run past minimum duration -> ending -> green
  const toEnd = stepVsc(4.0, { hasDoubleYellow: false, playerSpeedMs: vRef * 0.5 });
  check("clearing hazard after minimum duration transitions to VSC ending", toEnd.some((e) => e.kind === "ending") && vsc.phase === "ending", JSON.stringify(toEnd));
  const toGreen = stepVsc(8.0, { hasDoubleYellow: false, playerSpeedMs: vRef * 0.8 });
  check("VSC ending countdown returns to green flag", toGreen.some((e) => e.kind === "green") && !vsc.active, JSON.stringify(toGreen));

  // Cooldown prevents immediate re-deployment
  const duringCd = stepVsc(5.0, { hasRetiredOnTrack: true });
  check("cooldown suppresses immediate VSC re-deployment", duringCd.length === 0 && !vsc.active);

  // Active VSC clears cleanly when racing goes false (race finish / DNF / DQ) without post-finish messages
  t += 90;
  const redep = stepVsc(0.1, { hasRetiredOnTrack: true });
  check("VSC redeploys after cooldown", redep.some((e) => e.kind === "deployed") && vsc.active);
  const postFinish = vsc.update({
    dt: DT,
    raceTimeS: t + DT,
    racing: false,
    finalLapClosing: false,
    hasRetiredOnTrack: true,
    hasDoubleYellow: true,
    playerSpeedMs: 50,
    playerOptimalKmh: 180,
    judgePlayer: true,
    rng: () => 0.5,
  });
  check("active VSC clears silently when racing becomes false", postFinish.length === 0 && !vsc.active && vsc.status() === undefined);
}

console.log(`\n${passed} checks passed`);

