/**
 * Rolling Start verification suite:
 *   npx tsx scripts/verify/verify-rolling-start.ts
 *
 * Verifies:
 *  1. Pure state machine: `applySpeedLimiter` throttling/overspeed clamping and `rollingFormationStep` monotonic
 *     progression (`formation -> ready -> 3 -> 2 -> 1`).
 *  2. Physics formation speed limiter across multiple car classes (`f12026-car`, `amg-gt3`, `lc-lmdh`, `liana`, `lc26`):
 *     holding 100% throttle stays smoothly clamped at ~60-70 km/h (65 km/h target) until P1 crosses S/F, then releases
 *     instantly on GREEN FLAG and accelerates to full race pace.
 *  3. AI field rolling start (player at back & player on pole): matching AI formation pace/spacing, 3-2-1 countdown
 *     progression, green flag when P1 crosses S/F, and zero collisions/retirements during formation.
 *  4. Simulation worker (`SimRuntime` + `WorkerAiField`) rolling start parity: limiter engages/releases in worker and
 *     every stage/countdown transition pushes immediately to the HUD status.
 *  5. Multiplayer rolling start (`MultiplayerRace`): formation limiter + 3-2-1 countdown + green flag on P1 crossing,
 *     with standing starts unaffected.
 *  6. No regressions: standing starts and solo flying-lap spawns (`fieldSize === undefined`) remain speed-limiter-free.
 */
import { createFlatTestTrack } from "../lib/flat-track";
import { vehicleModelSpec } from "../../src/lib/cars/vehicle-models";
import { AiOpponentField, aiDriversFor } from "../../src/lib/sim/ai-opponents";
import { applySpeedLimiter, rollingFormationStep } from "../../src/lib/sim/race-start";
import { MultiplayerRace } from "../../src/lib/sim/race-session";
import type { RaceStartInfo } from "../../src/lib/sim/multiplayer-sync";
import { createSimHost, loopbackTransport } from "../../src/lib/sim/runtime/sim-host";
import { SIM_TICK_S } from "../../src/lib/sim/runtime/sim-protocol";
import { WorkerAiField } from "../../src/lib/sim/runtime/worker-ai-field";
import { ROLLING_SLOT_SPACING_M, ROLLING_START_MAX_LEAD_M, ROLLING_START_PACE_MS } from "../../src/lib/sim/simulator-car";
import { TrackEnvironment } from "../../src/lib/sim/track-environment";
import type { VehicleModelId } from "../../src/types/f1";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(68)} ${detail}`);
  if (!ok) failures.push(name);
};

// 1. Pure state machine checks
console.log("== Rolling start pure helpers");
{
  const targetKmh = ROLLING_START_PACE_MS * 3.6;
  check("ROLLING_START_PACE_MS is in the 60-70 km/h window", targetKmh >= 60 && targetKmh <= 70, `${targetKmh.toFixed(1)} km/h`);

  const off = applySpeedLimiter(80, undefined, 1, 0);
  check("speed limiter inactive passes throttle & brake through untouched", !off.active && off.throttle === 1 && off.brake === 0 && off.ignitionCut === 1);

  const below = applySpeedLimiter(ROLLING_START_PACE_MS - 3, ROLLING_START_PACE_MS, 1, 0);
  check("well below formation speed: full throttle allowed", below.active && below.throttle === 1 && below.brake === 0 && below.ignitionCut === 1);

  const atLimit = applySpeedLimiter(ROLLING_START_PACE_MS, ROLLING_START_PACE_MS, 1, 0);
  check("at formation speed: throttle smoothly tapered", atLimit.active && atLimit.throttle > 0 && atLimit.throttle < 0.4 && atLimit.brake === 0, `throttle=${atLimit.throttle.toFixed(2)}`);

  const over = applySpeedLimiter(ROLLING_START_PACE_MS + 1.5, ROLLING_START_PACE_MS, 1, 0);
  check("above formation speed: throttle/ignition cut + gentle overspeed brake", over.active && over.throttle === 0 && over.ignitionCut === 0 && over.brake > 0 && over.brake <= 0.5, `brake=${over.brake.toFixed(2)}`);

  const driverBrake = applySpeedLimiter(ROLLING_START_PACE_MS - 2, ROLLING_START_PACE_MS, 0, 0.8);
  check("driver braking always preserved under formation limiter", driverBrake.active && driverBrake.brake === 0.8);

  // Countdown progression as P1 closes from 165 m to 0 m at 65 km/h
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
}

const track = createFlatTestTrack(4000, 400);
const DT = 1 / 120;

// 2. Full physics speed limiter & green-flag release across car classes
console.log("\n== Formation speed limiter across vehicle classes");
const TEST_CARS: VehicleModelId[] = ["f12026-car", "amg-gt3", "lc-lmdh", "liana", "lc26"];
for (const carId of TEST_CARS) {
  const player = vehicleModelSpec(carId).createSim(track, null);
  player.autoGearbox = true;
  const env = new TrackEnvironment(track);
  const field = new AiOpponentField(track, player, aiDriversFor(3), env, { skill: 75, seed: 21, learning: false });
  field.playerGrid = "front";
  field.raceLaps = 2;
  field.startRace(false);

  const initSt = field.status();
  const initRf = initSt.rollingFormation;
  const paceKmh = (initRf?.paceMs ?? 0) * 3.6;
  check(
    `${carId}: spawns in rolling formation at ~65 km/h with limiter on`,
    Boolean(initRf && initRf.stage === "formation" && initRf.limiterActive && paceKmh >= 60 && paceKmh <= 70 && initRf.distanceToLineM <= ROLLING_START_MAX_LEAD_M + 2),
    `pace=${paceKmh.toFixed(1)} km/h, dist=${initRf?.distanceToLineM} m`,
  );

  let maxBeforeGreenKmh = 0;
  let minBeforeGreenKmh = Infinity;
  let greenDistM = -Infinity;
  const stages: string[] = [];
  for (let i = 0; i < 120 * 16; i++) {
    // Player holds 100% throttle the entire time: limiter must hold ~65 km/h cleanly
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
    const rf = field.status().rollingFormation;
    if (rf) {
      maxBeforeGreenKmh = Math.max(maxBeforeGreenKmh, player.vxMs * 3.6);
      minBeforeGreenKmh = Math.min(minBeforeGreenKmh, player.vxMs * 3.6);
      const tag = rf.stage === "countdown" ? String(rf.countdown) : rf.stage;
      if (stages[stages.length - 1] !== tag) stages.push(tag);
    } else {
      greenDistM = field.status().standings.find((s) => s.isPlayer)?.raceDistM ?? 0;
      break;
    }
  }
  check(
    `${carId}: full-throttle clamped to 60-70 km/h through formation`,
    !field.isRollingFormation && maxBeforeGreenKmh <= 70 && minBeforeGreenKmh >= 58 && player.speedLimiterMs === undefined,
    `range=${minBeforeGreenKmh.toFixed(1)}..${maxBeforeGreenKmh.toFixed(1)} km/h`,
  );
  check(
    `${carId}: 3-2-1 countdown & green flag at S/F`,
    stages.join("->") === "formation->ready->3->2->1" && greenDistM >= -1 && greenDistM < 15,
    `stages=${stages.join("->")}, greenDist=${greenDistM.toFixed(1)} m`,
  );

  // Immediately after GREEN FLAG, holding full throttle accelerates freely well past formation pace
  for (let i = 0; i < 120 * 3; i++) {
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
  }
  const postGreenKmh = player.vxMs * 3.6;
  check(
    `${carId}: limiter releases on green and car accelerates freely`,
    postGreenKmh > paceKmh + 15,
    `3s after green: ${postGreenKmh.toFixed(1)} km/h (vs ${paceKmh.toFixed(1)} km/h limit)`,
  );
}

// 3. Player at back of 6-car field: AI pack formation spacing, pace & clean launch
console.log("\n== Full pack formation (player P6 behind 5 AI)");
{
  const player = vehicleModelSpec("amg-gt3").createSim(track, null);
  player.autoGearbox = true;
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
  for (let i = 0; i < 120 * 16; i++) {
    player.step(DT, { throttle: 1, brake: 0 });
    field.update(DT);
    const st = field.status();
    if (st.rollingFormation) {
      maxPlayerKmh = Math.max(maxPlayerKmh, player.vxMs * 3.6);
      for (const ai of field.aiSims()) maxAiKmh = Math.max(maxAiKmh, ai.vxMs * 3.6);
      const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
      if (stages[stages.length - 1] !== tag) stages.push(tag);
    } else {
      leaderDistAtGreen = st.standings[0]?.raceDistM ?? -Infinity;
      break;
    }
  }
  const rep = field.report();
  const anyFormationContact = rep.cars.some((c) => c.stats.contacts > 0 || c.retired);
  check(
    "player P6 and AI pack hold 60-70 km/h cleanly with zero formation contact",
    maxPlayerKmh <= 70 && maxAiKmh <= 72 && !anyFormationContact && leaderDistAtGreen >= -1 && leaderDistAtGreen < 15,
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

    const seen: string[] = [];
    let maxWorkerKmh = 0;
    let sawGreen = false;
    for (let tick = 0; tick < Math.round(14 / SIM_TICK_S); tick++) {
      car.step(SIM_TICK_S, { throttle: 1, brake: 0 });
      loop.advance(SIM_TICK_S);
      race.update();
      const st = race.status();
      if (st.rollingFormation) {
        maxWorkerKmh = Math.max(maxWorkerKmh, car.vxMs * 3.6);
        const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
        if (seen[seen.length - 1] !== tag) seen.push(tag);
      } else if (seen.length > 0) {
        sawGreen = true;
        break;
      }
    }
    check(
      "worker rolling start clamps speed and pushes every 3-2-1 stage + green flag",
      sawGreen && maxWorkerKmh <= 70 && seen.join("->") === "formation->ready->3->2->1",
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
  const mp = new MultiplayerRace(mpStart, L, "me", { name: "Me", code: "MEE", color: "#00ff00" }, roster);
  mp.lapClock.reset(L - 160);
  mp.startRollingFormation(ROLLING_START_PACE_MS);

  const pre = mp.frame(9_000);
  const preSt = mp.status(pre, ROLLING_START_PACE_MS);
  check("MP rolling start: countdown phase before lightsStartHostMs has no rollingFormation yet", preSt.phase === "lights" && preSt.rollingFormation === undefined);

  const mpStages: string[] = [];
  let releasedAtDist = -Infinity;
  let limiterAlwaysActive = true;
  for (let ms = 10_000; ms <= 25_000; ms += 100) {
    const f = mp.frame(ms);
    const nextS = (((L - 160 + (ms - 10_000) / 1000 * ROLLING_START_PACE_MS) % L) + L) % L;
    if (ms > 10_000) mp.lapClock.update(nextS, f.raceTimeS, 3, false);
    const st = mp.status(f, ROLLING_START_PACE_MS);
    if (st.rollingFormation) {
      if (mp.rollingLimiterMs !== ROLLING_START_PACE_MS) limiterAlwaysActive = false;
      const tag = st.rollingFormation.stage === "countdown" ? String(st.rollingFormation.countdown) : st.rollingFormation.stage;
      if (mpStages[mpStages.length - 1] !== tag) mpStages.push(tag);
    } else {
      releasedAtDist = mp.lapClock.distM;
      break;
    }
  }
  check(
    "MP rolling start: limiter active through 3-2-1 countdown & releases at S/F",
    limiterAlwaysActive && mpStages.join("->") === "formation->ready->3->2->1" && mp.rollingLimiterMs === undefined && releasedAtDist >= 0,
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
