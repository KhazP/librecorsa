/**
 * Checks race control and the new HUD data: judged track limits (touch, no advantage, gain, give-back, lift,
 * corner cut, warnings and penalties), penalised classification, the MFD relative and fuel strategy, and the
 * garage setup clamping.
 * Run: npx tsx scripts/verify-race-control.ts
 */
import { TrackLimitsMonitor, type TrackLimitsEvent, type TrackLimitsFrame } from "../src/lib/sim/track-limits";
import { classifiedTimeS, type RacerProgress } from "../src/lib/sim/race-session";
import { computeRelatives, fuelStrategy, type LapRecord } from "../src/components/hud/mfd-data";
import { clampChassisSetup, DEFAULT_CHASSIS_SETUP } from "../src/lib/sim/car-setup";
import type { CarTelemetry, RaceStandingEntry } from "../src/types/f1";
import { F12026CarSim } from "../src/lib/sim/f12026-car/F12026CarSim";
import { createAmgGt3Sim } from "../src/lib/sim/gt3/AmgGt3Sim";
import { F1Physics2026 } from "../src/lib/f1-physics-2026";
import { createFlatTestTrack } from "./lib/flat-track";

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

  const p = new TrackLimitsMonitor();
  p.reset("practice");
  const pe = [...wide(p, 0.6, 0, -0.3), ...drive(p, 6.5, { deltaS: -0.3 })];
  check("practice: a strike deletes the lap", pe.length === 1 && pe[0].kind === "lap_invalid" && p.penaltyTotalS === 0);

  const q = new TrackLimitsMonitor();
  q.reset("race");
  drive(q, 0.2, {});
  drive(q, 0.5, { offTrack: true, lateralM: 6 });
  drive(q, 0.1, { active: false });
  check("going inactive (lights, pause, autopilot) drops the excursion", !q.judging);
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
    const psi = setup.coldPressurePsi.front - 1;
    car.setTyreSetup({ ...setup, coldPressurePsi: { ...setup.coldPressurePsi, front: psi } });
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
}

console.log(`\n${passed} checks passed`);

