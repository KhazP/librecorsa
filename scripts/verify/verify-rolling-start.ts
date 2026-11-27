/**
 * Rolling Start verification suite:
 *   npx tsx scripts/verify/verify-rolling-start.ts
 *
 * Verifies:
 *  1. Pure helpers: `rollingStartLimitMs` matches each circuit's pit lane speed limit (60/80 km/h),
 *     `RollingStartSpeedWatch` penalizes sustained/gross overspeed during formation while ignoring brief ripples,
 *     `applySpeedLimiter` smoothly holds limit when engaged, `rollingFormationStep` progresses monotonically, and
 *     `rollingSpeedGauge` classifies slow / hold / fast zones.
 *  2. Player-controlled speed + pit speed limiter across multiple car classes (`f12026-car`, `amg-gt3`, `lc-lmdh`,
 *     `liana`, `lc26`):
 *     - Without the pit limiter engaged, the player is NOT artificially capped and can accelerate freely past the limit
 *       (triggering red gauge + rolling-start speeding penalty).
 *     - With the pit speed limiter toggled ON (`PitStopManager`), holding 100% throttle holds the track's pit lane
 *       speed limit (tested at both 60 km/h and 80 km/h) cleanly in the green hold zone until GREEN FLAG, where
 *       `releaseManualLimiter()` releases it cleanly.
 *  3. AI field rolling start (player at back & player on pole): matching AI formation pace/spacing, 3-2-1 countdown
 *     progression, green flag when P1 crosses S/F, and zero collisions/retirements during formation.
 *  4. Simulation worker (`SimRuntime` + `WorkerAiField`) rolling start parity.
 *  5. Multiplayer rolling start (`MultiplayerRace`): pit-lane speed limit, no forced speed cap (`rollingLimiterMs`
 *     undefined, `limiterActive: false`), 3-2-1 countdown + green flag on P1 crossing, with standing starts unaffected.
 *  6. No regressions: standing starts and solo flying-lap spawns (`fieldSize === undefined`) remain speed-limiter-free.
 */
import { createFlatTestTrack } from "../lib/flat-track";
import { vehicleModelSpec } from "../../src/lib/cars/vehicle-models";
import { AiOpponentField, aiDriversFor } from "../../src/lib/sim/ai-opponents";
import {
  applySpeedLimiter,
  ROLLING_GAUGE_HEADROOM,
  ROLLING_SPEED_PENALTY_S,
  rollingFormationStep,
  rollingSpeedGauge,
  rollingStartLimitMs,
  RollingStartSpeedWatch,
} from "../../src/lib/sim/race-start";
import { PitStopManager } from "../../src/lib/sim/pit/pit-stop";
import { PIT_LIMIT_KMH_DEFAULT, type PitLaneModel } from "../../src/lib/sim/pit/pit-lane";
import { MultiplayerRace } from "../../src/lib/sim/race-session";
import type { RaceStartInfo } from "../../src/lib/sim/multiplayer-sync";
import { createSimHost, loopbackTransport } from "../../src/lib/sim/runtime/sim-host";
import { SIM_TICK_S } from "../../src/lib/sim/runtime/sim-protocol";
import { WorkerAiField } from "../../src/lib/sim/runtime/worker-ai-field";
import {
  ROLLING_SLOT_SPACING_M,
  ROLLING_START_MAX_LEAD_M,
  ROLLING_START_PACE_MS,
  rollingStartSpeedMs,
} from "../../src/lib/sim/simulator-car";
import { TrackEnvironment } from "../../src/lib/sim/track-environment";
import type { ControlInputs, VehicleModelId } from "../../src/types/f1";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(68)} ${detail}`);
  if (!ok) failures.push(name);
};

// 1. Pure state machine & pit-lane speed limit checks
console.log("== Rolling start pure helpers & pit-lane speed limit");
{
  const defaultKmh = ROLLING_START_PACE_MS * 3.6;
  check("ROLLING_START_PACE_MS matches PIT_LIMIT_KMH_DEFAULT (60 km/h)", Math.abs(defaultKmh - PIT_LIMIT_KMH_DEFAULT) < 1e-6, `${defaultKmh.toFixed(1)} km/h`);
  check(
    "rollingStartLimitMs uses circuit pit limit (60/80/100) and falls back to 60 km/h",
    Math.abs(rollingStartLimitMs(80) * 3.6 - 80) < 1e-6 &&
      Math.abs(rollingStartLimitMs(60) * 3.6 - 60) < 1e-6 &&
      Math.abs(rollingStartLimitMs(100) * 3.6 - 100) < 1e-6 &&
      Math.abs(rollingStartLimitMs(undefined) * 3.6 - PIT_LIMIT_KMH_DEFAULT) < 1e-6 &&
      Math.abs(rollingStartLimitMs(null) * 3.6 - PIT_LIMIT_KMH_DEFAULT) < 1e-6,
    `80->${(rollingStartLimitMs(80) * 3.6).toFixed(0)}, default->${(rollingStartLimitMs(undefined) * 3.6).toFixed(0)}`,
  );

  // rollingStartSpeedMs follows track.pitLane.limitKmh on both 60 km/h and 80 km/h tracks
  const flat60 = createFlatTestTrack(4000, 400);
  const flat80 = Object.assign(createFlatTestTrack(4000, 400), {
    pitLane: { limitKmh: 80 } as unknown as PitLaneModel,
  });
  const sp60 = rollingStartSpeedMs(flat60, { s: 3840, cornerS: null }, 6, () => 60, 60) * 3.6;
  const sp80 = rollingStartSpeedMs(flat80, { s: 3840, cornerS: null }, 6, () => 60, 60) * 3.6;
  check(
    "rollingStartSpeedMs uses circuit pit lane speed limit (60 km/h default, 80 km/h track)",
    Math.abs(sp60 - 60) < 0.2 && Math.abs(sp80 - 80) < 0.2,
    `sp60=${sp60.toFixed(1)}, sp80=${sp80.toFixed(1)} km/h`,
  );

  const off = applySpeedLimiter(80, undefined, 1, 0);
  check("speed limiter inactive passes throttle & brake through untouched", !off.active && off.throttle === 1 && off.brake === 0 && off.ignitionCut === 1);

  const below = applySpeedLimiter(ROLLING_START_PACE_MS - 3, ROLLING_START_PACE_MS, 1, 0);
  check("well below formation speed: full throttle allowed", below.active && below.throttle === 1 && below.brake === 0 && below.ignitionCut === 1);

  const atLimit = applySpeedLimiter(ROLLING_START_PACE_MS, ROLLING_START_PACE_MS, 1, 0);
  check("at formation speed: throttle smoothly tapered", atLimit.active && atLimit.throttle > 0 && atLimit.throttle < 0.4 && atLimit.brake === 0, `throttle=${atLimit.throttle.toFixed(2)}`);

  const over = applySpeedLimiter(ROLLING_START_PACE_MS + 1.5, ROLLING_START_PACE_MS, 1, 0);
  check("above formation speed: throttle/ignition cut + gentle overspeed brake", over.active && over.throttle === 0 && over.ignitionCut === 0 && over.brake > 0 && over.brake <= 0.5, `brake=${over.brake.toFixed(2)}`);

  const driverBrake = applySpeedLimiter(ROLLING_START_PACE_MS - 2, ROLLING_START_PACE_MS, 0, 0.8);
  check("driver braking always preserved under limiter", driverBrake.active && driverBrake.brake === 0.8);

  // RollingStartSpeedWatch: clean hold, brief ripple, sustained speeding, and gross jump
  const watchClean = new RollingStartSpeedWatch();
  let cleanCall: string | null = null;
  for (let i = 0; i < 600; i++) cleanCall ??= watchClean.update(1 / 60, true, 62, 60 / 3.6);
  check("RollingStartSpeedWatch: holding near pit limit (+2 km/h) never penalizes", cleanCall === null && !watchClean.penalised && watchClean.penaltyS === 0);

  const watchSustained = new RollingStartSpeedWatch();
  let sustainedCall: string | null = null;
  for (let i = 0; i < 120; i++) sustainedCall ??= watchSustained.update(1 / 60, true, 68, 60 / 3.6);
  check(
    "RollingStartSpeedWatch: sustained speeding (+8 km/h for >1.5s) issues +5s penalty once",
    sustainedCall === "penalty" && watchSustained.penalised && watchSustained.penaltyS === ROLLING_SPEED_PENALTY_S && watchSustained.update(1, true, 90, 60 / 3.6) === null,
    `penalty=${watchSustained.penaltyS}s`,
  );

  const watchJump = new RollingStartSpeedWatch();
  let jumpCall: string | null = null;
  for (let i = 0; i < 40; i++) jumpCall ??= watchJump.update(1 / 60, true, 98, 80 / 3.6);
  check("RollingStartSpeedWatch: gross jump (+18 km/h for >0.5s) issues +5s penalty", jumpCall === "penalty" && watchJump.penaltyS === ROLLING_SPEED_PENALTY_S);

  // PitStopManager: manual limiter works on track (both 80 km/h pit lane & pitless 60 km/h track) and releases cleanly on green
  const mockLane80 = { limitKmh: 80, boxes: [], besideLap: () => false } as unknown as PitLaneModel;
  const pit80 = new PitStopManager(mockLane80, "soft");
  const pitNone = new PitStopManager(null, "soft");
  pit80.toggleLimiter();
  pitNone.toggleLimiter();
  const inp80: ControlInputs = { throttle: 1, brake: 0, steerLeft: 0, steerRight: 0, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false };
  pit80.filterInputs(inp80, 86 / 3.6);
  const inp60: ControlInputs = { throttle: 1, brake: 0, steerLeft: 0, steerRight: 0, manualOverride: false, toggleXMode: false, shiftUp: false, shiftDown: false };
  pitNone.filterInputs(inp60, 66 / 3.6);
  pit80.releaseManualLimiter();
  pitNone.releaseManualLimiter();
  check(
    "PitStopManager manual limiter works on track (80 km/h & pitless 60 km/h) and releases at green",
    pit80.limitKmh === 80 &&
      pitNone.limitKmh === 60 &&
      inp80.throttle === 0 &&
      inp80.brake > 0 &&
      inp60.throttle === 0 &&
      inp60.brake > 0 &&
      !pit80.limiterOn &&
      !pitNone.limiterOn,
  );

  // Countdown progression as P1 closes from 165 m to 0 m at 60 km/h
  const seq: string[] = [];
  let prev = 0;
  let monotonic = true;
  for (let d = 165; d >= 1; d -= 2) {
    const s = rollingFormationStep(d, ROLLING_START_PACE_MS, ROLLING_START_PACE_MS, prev);
    if (s.stageOrder < prev) monotonic = false;
    prev = s.stageOrder;
    const tag = s.stage === "countdown" ? String(s.countdown) : s.stage;
    if (seq[seq.length - 1] !== tag) seq.push(tag);
  }
  check("countdown progresses monotonically formation -> ready -> 3 -> 2 -> 1", monotonic && seq.join("->") === "formation->ready->3->2->1", seq.join("->"));

  // Speed ripple must never regress stage backwards
  const at3 = rollingFormationStep(45, ROLLING_START_PACE_MS, ROLLING_START_PACE_MS, 0);
  const rippled = rollingFormationStep(46, ROLLING_START_PACE_MS * 0.85, ROLLING_START_PACE_MS, at3.stageOrder);
  check("stage latch prevents backward flicker on speed/distance ripple", at3.countdown === 3 && rippled.countdown === 3, `at3=${at3.countdown}, rippled=${rippled.countdown}`);

  // Fixed rolling-start speed gauge (shared across all HUDs)
  const pace80Ms = 80 / 3.6;
  const gZero = rollingSpeedGauge(0, pace80Ms);
  const gSlow = rollingSpeedGauge(65, pace80Ms);
  const gHold = rollingSpeedGauge(79.5, pace80Ms);
  const gExact = rollingSpeedGauge(80, pace80Ms);
  const gFast = rollingSpeedGauge(95, pace80Ms);
  const gCornerHold = rollingSpeedGauge(42, 45 / 3.6);
  const gCornerSlow = rollingSpeedGauge(39, 45 / 3.6);
  check(
    "rollingSpeedGauge classifies slow / hold / fast zones around pit-limit pace",
    gZero.zone === "slow" &&
      gSlow.zone === "slow" &&
      gHold.zone === "hold" &&
      gExact.zone === "hold" &&
      gFast.zone === "fast" &&
      gCornerHold.zone === "hold" &&
      gCornerSlow.zone === "slow",
    `zero=${gZero.zone}, slow=${gSlow.zone}, hold=${gHold.zone}, fast=${gFast.zone}`,
  );
  check(
    "rollingSpeedGauge fills monotonically and hits targetFraction at exact pace",
    gZero.fillFraction === 0 &&
      gSlow.fillFraction < gHold.fillFraction &&
      Math.abs(gExact.fillFraction - gExact.targetFraction) < 1e-6 &&
      Math.abs(gExact.targetFraction - 1 / ROLLING_GAUGE_HEADROOM) < 1e-6 &&
      gFast.fillFraction === 1 &&
      rollingSpeedGauge(Number.NaN, pace80Ms).fillFraction === 0,
    `exact=${gExact.fillFraction.toFixed(4)}, target=${gExact.targetFraction.toFixed(4)}`,
  );
}

const track = createFlatTestTrack(4000, 400);
const DT = 1 / 120;

// 2. Player-controlled speed (no forced cap) & optional pit limiter across vehicle classes
console.log("\n== Player speed control & pit limiter across vehicle classes");
const TEST_CARS: VehicleModelId[] = ["f12026-car", "amg-gt3", "lc-lmdh", "liana", "lc26"];
for (const carId of TEST_CARS) {
  // 2a. Without pit limiter engaged, car accelerates freely past the pit-lane limit (no artificial cap)
  {
    const freeCar = vehicleModelSpec(carId).createSim(track, null);
    freeCar.autoGearbox = true;
    freeCar.resetToStartGrid(true, 0, 4, true);
    const spawnKmh = freeCar.vxMs * 3.6;
    const watch = new RollingStartSpeedWatch();
    let pen = false;
    for (let i = 0; i < 120 * 3; i++) {
      freeCar.speedLimiterMs = undefined;
      freeCar.step(DT, { throttle: 1, brake: 0 });
      if (watch.update(DT, true, freeCar.vxMs * 3.6, rollingStartLimitMs(null)) === "penalty") pen = true;
    }
    const freeKmh = freeCar.vxMs * 3.6;
    check(
      `${carId}: unthrottled without pit limiter accelerates freely (>80 km/h) and trips speed watch`,
      spawnKmh >= 55 && spawnKmh <= 63 && freeKmh > 80 && pen,
      `spawn=${spawnKmh.toFixed(1)}, 3.0s=${freeKmh.toFixed(1)} km/h, pen=${pen}`,
    );
  }

  // 2b. With pit limiter engaged during rolling formation, full throttle holds the track's pit lane speed limit cleanly
  const player = vehicleModelSpec(carId).createSim(track, null);
  player.autoGearbox = true;
  const pit = new PitStopManager(null, "soft");
  pit.toggleLimiter(); // Player engages pit limiter for rolling start
  const env = new TrackEnvironment(track);
  const field = new AiOpponentField(track, player, aiDriversFor(3), env, { skill: 75, seed: 21, learning: false });
  field.playerGrid = "front";
  field.raceLaps = 2;
  field.startRace(false);

  const initSt = field.status();
  const initRf = initSt.rollingFormation;
  const paceKmh = (initRf?.paceMs ?? 0) * 3.6;
  check(
    `${carId}: spawns in rolling formation at track pit limit (~60 km/h)`,
    Boolean(initRf && initRf.stage === "formation" && paceKmh >= 56 && paceKmh <= 64 && initRf.distanceToLineM <= ROLLING_START_MAX_LEAD_M + 2),
    `pace=${paceKmh.toFixed(1)} km/h, dist=${initRf?.distanceToLineM} m`,
  );

  let maxBeforeGreenKmh = 0;
  let minBeforeGreenKmh = Infinity;
  let allGaugeInHold = true;
  let greenDistM = -Infinity;
  const stages: string[] = [];
  for (let i = 0; i < 120 * 18; i++) {
    // Player holds 100% throttle with pit limiter ON: holds pit lane limit cleanly
    player.speedLimiterMs = pit.limiterOn ? pit.limitKmh / 3.6 : undefined;
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
    const rf = field.status().rollingFormation;
    if (rf) {
      const kmh = player.vxMs * 3.6;
      maxBeforeGreenKmh = Math.max(maxBeforeGreenKmh, kmh);
      minBeforeGreenKmh = Math.min(minBeforeGreenKmh, kmh);
      if (rollingSpeedGauge(kmh, rf.paceMs).zone !== "hold") allGaugeInHold = false;
      const tag = rf.stage === "countdown" ? String(rf.countdown) : rf.stage;
      if (stages[stages.length - 1] !== tag) stages.push(tag);
    } else {
      pit.releaseManualLimiter();
      player.speedLimiterMs = undefined;
      greenDistM = field.status().standings.find((s) => s.isPlayer)?.raceDistM ?? 0;
      break;
    }
  }
  check(
    `${carId}: pit limiter holds 56-64 km/h in green hold zone and releases on green`,
    !field.isRollingFormation && maxBeforeGreenKmh <= 65 && minBeforeGreenKmh >= 54 && allGaugeInHold && !pit.limiterOn && player.speedLimiterMs === undefined,
    `range=${minBeforeGreenKmh.toFixed(1)}..${maxBeforeGreenKmh.toFixed(1)} km/h, hold=${allGaugeInHold}`,
  );
  check(
    `${carId}: 3-2-1 countdown & green flag at S/F`,
    stages.join("->") === "formation->ready->3->2->1" && greenDistM >= -1 && greenDistM < 15,
    `stages=${stages.join("->")}, greenDist=${greenDistM.toFixed(1)} m`,
  );

  // Immediately after GREEN FLAG, holding full throttle accelerates freely well past pit limit
  for (let i = 0; i < 120 * 3; i++) {
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
  }
  const postGreenKmh = player.vxMs * 3.6;
  check(
    `${carId}: car accelerates freely after green flag`,
    postGreenKmh > paceKmh + 15,
    `3s after green: ${postGreenKmh.toFixed(1)} km/h (vs ${paceKmh.toFixed(1)} km/h limit)`,
  );
}

// 3. Player at back of 6-car field: AI pack formation spacing, pace & clean launch
console.log("\n== Full pack formation (player P6 behind 5 AI)");
{
  const player = vehicleModelSpec("amg-gt3").createSim(track, null);
  player.autoGearbox = true;
  const pit = new PitStopManager(null, "soft");
  pit.toggleLimiter();
  const env = new TrackEnvironment(track);
  const field = new AiOpponentField(track, player, aiDriversFor(5), env, { skill: 80, seed: 99, learning: false });
  field.playerGrid = "back";
  field.damageLevel = "full";
  field.raceLaps = 2;
  field.startRace(false);

  const initialSlots = field.status().standings.map((s) => s.raceDistM ?? 0);
  const slotSpanM = Math.max(...initialSlots) - Math.min(...initialSlots);
  check(
    "6-car rolling grid uses tight staggered spacing (~5 * 14 m)",
    slotSpanM > 55 && slotSpanM < 90,
    `span=${slotSpanM.toFixed(1)} m (expected ~${5 * ROLLING_SLOT_SPACING_M} m)`,
  );

  let maxAiKmh = 0;
  let maxPlayerKmh = 0;
  const stages: string[] = [];
  let leaderDistAtGreen = -Infinity;
  for (let i = 0; i < 120 * 18; i++) {
    player.speedLimiterMs = pit.limiterOn ? pit.limitKmh / 3.6 : undefined;
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
    const st = field.status();
    if (st.rollingFormation) {
      maxPlayerKmh = Math.max(maxPlayerKmh, player.vxMs * 3.6);
      for (const ai of field.aiSims()) maxAiKmh = Math.max(maxAiKmh, ai.vxMs * 3.6);
      const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
      if (stages[stages.length - 1] !== tag) stages.push(tag);
    } else {
      pit.releaseManualLimiter();
      player.speedLimiterMs = undefined;
      leaderDistAtGreen = st.standings[0]?.raceDistM ?? -Infinity;
      break;
    }
  }
  const rep = field.report();
  const anyFormationContact = rep.cars.some((c) => c.stats.contacts > 0 || c.retired);
  check(
    "player P6 (on pit limiter) and AI pack hold 60 km/h cleanly with zero formation contact",
    maxPlayerKmh <= 65 && maxAiKmh <= 67 && !anyFormationContact && leaderDistAtGreen >= -1 && leaderDistAtGreen < 15,
    `playerMax=${maxPlayerKmh.toFixed(1)}, aiMax=${maxAiKmh.toFixed(1)} km/h, leaderDist=${leaderDistAtGreen.toFixed(1)} m, contacts=${anyFormationContact}`,
  );
  check("P6 HUD receives full formation -> ready -> 3 -> 2 -> 1 sequence", stages.join("->") === "formation->ready->3->2->1", stages.join("->"));
}

// 4. Simulation worker parity (`SimRuntime` + `WorkerAiField`)
console.log("\n== Worker rolling start parity");
{
  const loop = loopbackTransport();
  const host = createSimHost(loop.transport, loop.wallNowMs);
  const twin = vehicleModelSpec("amg-gt3").createSim(track, null);
  const car = host.adopt(twin, "amg-gt3", null);
  car.autoGearbox = true;
  car.resetToStartGrid(false);
  host.endFrame(true);
  const link = host.raceLink();
  check("worker race link ready", link !== null);
  if (link) {
    const env = new TrackEnvironment(track);
    const race = new WorkerAiField(link, env, car, 3, 75, () => null);
    race.seed = 42;
    race.playerGrid = "front";
    race.startRace(false);
    const pit = new PitStopManager(null, "soft");
    pit.toggleLimiter();

    const seen: string[] = [];
    let maxWorkerKmh = 0;
    let sawGreen = false;
    for (let tick = 0; tick < Math.round(16 / SIM_TICK_S); tick++) {
      car.speedLimiterMs = pit.limiterOn ? pit.limitKmh / 3.6 : undefined;
      car.step(SIM_TICK_S, { throttle: 1, brake: 0 });
      loop.advance(SIM_TICK_S);
      race.update();
      const st = race.status();
      if (st.rollingFormation) {
        maxWorkerKmh = Math.max(maxWorkerKmh, car.vxMs * 3.6);
        const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
        if (seen[seen.length - 1] !== tag) seen.push(tag);
      } else if (seen.length > 0) {
        pit.releaseManualLimiter();
        car.speedLimiterMs = undefined;
        sawGreen = true;
        break;
      }
    }
    check(
      "worker rolling start holds pit-limiter speed and pushes every 3-2-1 stage + green flag",
      sawGreen && maxWorkerKmh <= 65 && seen.join("->") === "formation->ready->3->2->1",
      `max=${maxWorkerKmh.toFixed(1)} km/h, stages=${seen.join("->")}, green=${sawGreen}`,
    );
    race.dispose();
    check("disposing worker race clears speed limiter", loop.runtime.simulatedCar?.speedLimiterMs === undefined);
  }
}

// 5. Multiplayer rolling start vs standing start
console.log("\n== Multiplayer rolling & standing start");
{
  const L = 4000;
  const roster = [
    { peerId: "p1", name: "Pole", code: "POL", color: "#ff0000" },
    { peerId: "me", name: "Me", code: "MEE", color: "#00ff00" },
  ];
  const mpStart: RaceStartInfo = {
    id: "mp-roll",
    lightsStartHostMs: 10_000,
    holdMs: 0,
    laps: 3,
    collisions: "protected",
    carClass: "gt3",
    trackId: "flat",
    grid: ["me", "p1"],
    startType: "rolling",
    manualStart: false,
  };
  const pace80Ms = rollingStartLimitMs(80);
  const mp = new MultiplayerRace(mpStart, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
  mp.lapClock.reset(L - 160);
  mp.startRollingFormation(pace80Ms, 80);

  const pre = mp.frame(9_000);
  const preSt = mp.status(pre, pace80Ms);
  check("MP rolling start: countdown phase before lightsStartHostMs has no rollingFormation yet", preSt.phase === "lights" && preSt.rollingFormation === undefined);

  const mpStages: string[] = [];
  let releasedAtDist = -Infinity;
  let neverForcedLimiter = true;
  let paceMatched80 = true;
  for (let ms = 10_000; ms <= 25_000; ms += 100) {
    const f = mp.frame(ms);
    const nextS = (((L - 160 + (ms - 10_000) / 1000 * pace80Ms) % L) + L) % L;
    if (ms > 10_000) mp.lapClock.update(nextS, f.raceTimeS, 3, false);
    const st = mp.status(f, pace80Ms);
    if (st.rollingFormation) {
      if (mp.rollingLimiterMs !== undefined || st.rollingFormation.limiterActive) neverForcedLimiter = false;
      if (Math.abs(st.rollingFormation.paceMs - pace80Ms) > 1e-4) paceMatched80 = false;
      const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
      if (mpStages[mpStages.length - 1] !== tag) mpStages.push(tag);
    } else {
      releasedAtDist = mp.lapClock.distM;
      break;
    }
  }
  check(
    "MP rolling start: uses 80 km/h pit limit, does NOT force limiter, runs 3-2-1 & releases at S/F",
    neverForcedLimiter && paceMatched80 && mpStages.join("->") === "formation->ready->3->2->1" && mp.rollingTargetPaceMs === undefined && releasedAtDist >= 0,
    `stages=${mpStages.join("->")}, releasedAt=${releasedAtDist.toFixed(1)} m`,
  );

  // Standing multiplayer start stays completely untouched
  const mpStand = new MultiplayerRace({ ...mpStart, id: "mp-stand", startType: "standing", holdMs: 1000 }, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
  mpStand.lapClock.reset(L - 12);
  mpStand.startRollingFormation(0);
  const stFrame = mpStand.frame(12_500);
  const stStatus = mpStand.status(stFrame, 0);
  check(
    "MP standing start: 5 red lights intact and no rolling formation / limiter",
    stStatus.phase === "lights" && stStatus.lightsOn === 3 && stStatus.rollingFormation === undefined && mpStand.rollingLimiterMs === undefined,
    `phase=${stStatus.phase}, lights=${stStatus.lightsOn}`,
  );
}

// 6. Regressions: standing start & solo flying lap
console.log("\n== Regression checks (standing start & flying lap)");
{
  const player = vehicleModelSpec("lc-lmdh").createSim(track, null);
  const env = new TrackEnvironment(track);
  const field = new AiOpponentField(track, player, aiDriversFor(3), env, { skill: 75, seed: 5, learning: false });
  field.startRace(true);
  check("AI standing start: lights phase, no rollingFormation, no speed limiter", field.phase === "lights" && !field.isRollingFormation && player.speedLimiterMs === undefined);

  // Solo flying lap (`fieldSize === undefined`) must spawn at full flying speed with no speed limiter
  const flyCar = vehicleModelSpec("lc-lmdh").createSim(track, null);
  flyCar.resetToStartGrid(true);
  check(
    "solo flying lap spawns at full speed (> 150 km/h) with speed limiter off",
    flyCar.vxMs * 3.6 > 150 && flyCar.speedLimiterMs === undefined,
    `spawn=${(flyCar.vxMs * 3.6).toFixed(1)} km/h`,
  );
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nAll rolling-start checks passed.");
