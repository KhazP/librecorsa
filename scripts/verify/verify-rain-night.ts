/**
 * Targeted checks for closed-cockpit rain masking, night lighting & headlights, and heavy-rain performance budgets.
 *
 *   node scripts/verify/run-verify.mjs rain-night
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import {
  carHasClosedCockpit,
  clipRainStreakAgainstCockpit,
  cockpitRainVolumeFor,
  createRainFx,
  RAIN_STREAK_BUDGET,
  rainStreakCountFor,
  type CockpitRainVolume,
} from "../../src/lib/render/rain-fx";
import {
  AUTO_HEADLIGHT_RAIN,
  AUTO_HEADLIGHT_SUN_DEG,
  BEAM_ANGLE,
  BEAM_PENUMBRA,
  CarHeadlights,
  HEADLIGHT_BEAM_DECAY,
  HEADLIGHT_SPOT_HEIGHT_LIFT_M,
  headlightProfileFor,
  headlightSpotCountFor,
  LOW_BEAM_AIM_M,
  LOW_BEAM_AIM_Y_M,
  resolveHeadlightStates,
  shouldHeadlightsBeOn,
} from "../../src/lib/render/car-headlights";
import { evaluateSkyLighting, nightShareOf } from "../../src/lib/render/golden-hour-environment";
import { NIGHT_SKY_HORIZON, NIGHT_SKY_ZENITH } from "../../src/lib/render/night-sky";
import { DETAIL_LAYER } from "../../src/lib/render/layers";
import { FlashTimer, HeadlightButton, LIGHTS_HOLD_MS, MIN_FLASH_MS } from "../../src/lib/input/headlight-button";
import { DEFAULT_SESSION_CONDITIONS, sunPosition, TIME_OF_DAY_HOURS } from "../../src/lib/sim/weather";
import { OPPONENT_SPRAY_DIST_M, PARTICLE_BUDGET, SimVisualFxManager } from "../../src/lib/sim/visual-fx";
import type { CarId } from "../../src/lib/cars/car-registry";
import type { SimulatorWheel } from "../../src/lib/sim/simulator-car";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(62)} ${detail}`);
  if (!ok) failures.push(name);
};

const CLOSED_CARS: readonly CarId[] = [
  "amg-gt3",
  "bmw-m4-gt3",
  "lc-lmdh",
  "mtr-496r",
  "liana",
  "nissan-r33-jgtc",
  "nissan-r32-jtcc",
  "bmw-m1-procar",
  "vw-scirocco-gtx",
  "chaparral-2d",
  "chaparral-2d-67",
  "porsche-934-rsr",
];

function pointStrictlyInsideVolume(p: readonly [number, number, number], vol: CockpitRainVolume, eps = 1e-3): boolean {
  const [x, y, z] = p;
  if (x <= vol.min[0] + eps || x >= vol.max[0] - eps) return false;
  if (y <= vol.min[1] + eps || y >= vol.max[1] - eps) return false;
  if (z <= vol.min[2] + eps || z >= vol.max[2] - eps) return false;
  const [nx, ny, nz, d] = vol.windscreenPlane;
  return nx * x + ny * y + nz * z < d - eps;
}

// ---------------------------------------------------------------------------
// 1. Closed-cockpit rain masking
// ---------------------------------------------------------------------------
console.log("\n== Closed-cockpit rain masking");
{
  check(
    "Open-cockpit F1 (lc26) is not masked as a closed cockpit",
    !carHasClosedCockpit("lc26") && cockpitRainVolumeFor("lc26") === null,
    "lc26 -> null"
  );

  let allClosedValid = true;
  for (const id of CLOSED_CARS) {
    const vol = cockpitRainVolumeFor(id);
    const hl = headlightProfileFor(id);
    const eyeOk = vol !== null && carHasClosedCockpit(id) && vol.min[0] < -0.5 && vol.max[0] > 0.5 && vol.max[1] > vol.min[1] + 0.6;
    // Cabin front must never protrude past the car's front lamps (exterior rain over the hood stays visible)
    const boundsOk = vol !== null && vol.max[2] < hl.frontZM && vol.min[2] < vol.max[2] - 1.0;
    if (!eyeOk || !boundsOk) allClosedValid = false;
  }
  check(
    "Every closed-cockpit car resolves a tight cabin volume behind its nose",
    allClosedValid,
    `${CLOSED_CARS.length} closed cars`
  );

  // AMG GT3 with actual measured cockpit eye (+0.403, 0.955, -0.58) and dash lens (+0.403, 0.975, -0.02)
  const gt3Eye = { x: 0.403, y: 0.955, z: -0.58 };
  const gt3Dash = [0.403, 0.975, -0.02] as const;
  const gt3Vol = cockpitRainVolumeFor("amg-gt3", gt3Eye)!;
  check(
    "GT3 cockpit volume encloses both driver eye and dash camera",
    pointStrictlyInsideVolume([gt3Eye.x, gt3Eye.y, gt3Eye.z], gt3Vol) &&
      pointStrictlyInsideVolume(gt3Dash, gt3Vol) &&
      pointStrictlyInsideVolume([-0.35, 0.85, -0.45], gt3Vol),
    `z=[${gt3Vol.min[2].toFixed(2)}, ${gt3Vol.max[2].toFixed(2)}]`
  );

  // LC-LMDH canopy volume encloses driver eye and dash while keeping exterior rain visible ahead of nose
  const lmdhEye = { x: 0.2, y: 0.8, z: -0.25 };
  const lmdhVol = cockpitRainVolumeFor("lc-lmdh", lmdhEye)!;
  check(
    "LC-LMDH cockpit volume encloses driver eye and keeps exterior front rain clear",
    pointStrictlyInsideVolume([lmdhEye.x, lmdhEye.y, lmdhEye.z], lmdhVol) &&
      !pointStrictlyInsideVolume([0, 0.9, 1.5], lmdhVol),
    `x=[${lmdhVol.min[0].toFixed(2)}, ${lmdhVol.max[0].toFixed(2)}]`
  );

  // Deterministic PRNG test: 1000 streaks in & around GT3 cabin — ZERO interior points survive clipping
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let insideCulled = 0;
  let insideTotal = 0;
  let piercedClipped = 0;
  let exteriorIntact = 0;
  let interiorLeaks = 0;

  // Test wholly interior streaks
  for (let i = 0; i < 200; i++) {
    const h: [number, number, number] = [
      THREE.MathUtils.lerp(gt3Vol.min[0] + 0.1, gt3Vol.max[0] - 0.1, rnd()),
      THREE.MathUtils.lerp(gt3Vol.min[1] + 0.1, gt3Vol.max[1] - 0.15, rnd()),
      THREE.MathUtils.lerp(gt3Vol.min[2] + 0.1, gt3Vol.min[2] + 0.8, rnd()),
    ];
    const t: [number, number, number] = [h[0], h[1] - 0.08, h[2] - 0.12];
    if (pointStrictlyInsideVolume(h, gt3Vol) && pointStrictlyInsideVolume(t, gt3Vol)) {
      insideTotal++;
      const res = clipRainStreakAgainstCockpit(h, t, gt3Vol);
      if (!res.visible) insideCulled++;
    }
  }

  // Test 1000 high-speed streaks approaching the car from ahead/above/sides
  for (let i = 0; i < 1000; i++) {
    const hx = (rnd() - 0.5) * 4.0;
    const hy = rnd() * 2.5;
    const hz = (rnd() - 0.3) * 5.0;
    const head: [number, number, number] = [hx, hy, hz];
    // High-speed relative streak pointing backward (-Z) and slightly down (-Y)
    const tail: [number, number, number] = [hx + (rnd() - 0.5) * 0.2, hy - 0.25, hz - 1.5];
    const res = clipRainStreakAgainstCockpit(head, tail, gt3Vol);
    if (res.clipped && res.visible) piercedClipped++;
    if (res.visible) {
      for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
        const u = res.t0 + (res.t1 - res.t0) * frac;
        const px = head[0] + (tail[0] - head[0]) * u;
        const py = head[1] + (tail[1] - head[1]) * u;
        const pz = head[2] + (tail[2] - head[2]) * u;
        if (pointStrictlyInsideVolume([px, py, pz], gt3Vol, 1e-2)) interiorLeaks++;
      }
    }
  }

  // Exterior streaks clearly ahead of the windscreen / over the hood remain unclipped
  for (let i = 0; i < 100; i++) {
    const head: [number, number, number] = [(rnd() - 0.5) * 2.0, 0.6 + rnd() * 1.5, 2.2 + rnd() * 6.0];
    const tail: [number, number, number] = [head[0], head[1] - 0.2, head[2] - 1.0];
    const res = clipRainStreakAgainstCockpit(head, tail, gt3Vol);
    if (!res.clipped && res.visible) exteriorIntact++;
  }

  check(
    "Wholly interior rain streaks are 100% culled",
    insideTotal > 100 && insideCulled === insideTotal,
    `${insideCulled}/${insideTotal} culled`
  );
  check(
    "High-speed rain streaks never leak inside closed cockpit after clipping",
    interiorLeaks === 0 && piercedClipped > 20,
    `leaks=${interiorLeaks}, windscreen/roof clips=${piercedClipped}`
  );
  check(
    "Exterior rain streaks ahead of the windscreen stay 100% visible",
    exteriorIntact === 100,
    `${exteriorIntact}/100 intact`
  );

  // RainFx object layer & occlusion uniform plumbing
  const scene = new THREE.Scene();
  const rainFx = createRainFx(scene);
  const mat = rainFx.object.material as THREE.ShaderMaterial;
  const chassisMat = new THREE.Matrix4().makeTranslation(12, 0.4, -30);
  rainFx.setCockpitOcclusion(gt3Vol, chassisMat);
  const enabledOk = mat.uniforms.uCockpitEnabled.value === 1;
  rainFx.setCockpitOcclusion(null, null);
  const disabledOk = mat.uniforms.uCockpitEnabled.value === 0;
  const detailLayerMask = new THREE.Layers();
  detailLayerMask.set(DETAIL_LAYER);
  const onDetailLayer = rainFx.object.layers.mask === detailLayerMask.mask;
  rainFx.dispose();
  check(
    "RainFx sets DETAIL_LAYER (skipped by mirrors/probe) and toggles cockpit occlusion uniforms",
    enabledOk && disabledOk && onDetailLayer,
    `enabled=${enabledOk}, disabled=${disabledOk}, detailLayer=${onDetailLayer}`
  );
}

// ---------------------------------------------------------------------------
// 2. Night lighting, headlights auto-enable, toggle, and track readability
// ---------------------------------------------------------------------------
console.log("\n== Night lighting & headlights");
{
  const dawnElev = sunPosition(TIME_OF_DAY_HOURS.dawn).elevationDeg;
  const duskElev = sunPosition(TIME_OF_DAY_HOURS.dusk).elevationDeg;
  const nightElev = sunPosition(TIME_OF_DAY_HOURS.night).elevationDeg;
  const goldenElev = sunPosition(TIME_OF_DAY_HOURS.golden_hour).elevationDeg;
  const noonElev = sunPosition(TIME_OF_DAY_HOURS.noon).elevationDeg;

  check(
    "Auto headlights turn on at dawn, dusk, night, light rain, and heavy rain; off in clear day",
    shouldHeadlightsBeOn("auto", dawnElev, 0) &&
      shouldHeadlightsBeOn("auto", duskElev, 0) &&
      shouldHeadlightsBeOn("auto", nightElev, 0) &&
      shouldHeadlightsBeOn("auto", noonElev, 0.3) &&
      shouldHeadlightsBeOn("auto", noonElev, 0.85) &&
      !shouldHeadlightsBeOn("auto", goldenElev, 0) &&
      !shouldHeadlightsBeOn("auto", noonElev, 0),
    `sunThresh=${AUTO_HEADLIGHT_SUN_DEG}°, rainThresh=${AUTO_HEADLIGHT_RAIN}`
  );

  const dayClear = { ...DEFAULT_SESSION_CONDITIONS, timeOfDay: "noon" as const, weather: "clear" as const, timeScale: 0 };
  check(
    "Manual headlight toggle ON allocates real SpotLights even in a clear daytime session",
    headlightSpotCountFor(dayClear, "high", false) === 0 &&
      headlightSpotCountFor(dayClear, "high", true) === 2 &&
      headlightSpotCountFor(dayClear, "medium", true) === 1 &&
      headlightSpotCountFor(dayClear, "low", true) === 1,
    "autoDay=0, manualOn high=2/med=1/low=1"
  );

  // HeadlightButton & FlashTimer toggle/flash flow
  const btn = new HeadlightButton();
  const flash = new FlashTimer();
  const tap0 = btn.update(true, true, 0, true);
  const tap1 = btn.update(false, false, 80, true);
  const flashHeldShort = flash.update(tap0.flash, 0, true) && flash.update(tap1.flash, 80, true);
  const flashEnded = !flash.update(false, MIN_FLASH_MS + 10, true);
  btn.update(true, true, 500, true);
  const holdToggle = btn.update(false, true, 500 + LIGHTS_HOLD_MS, true);
  const holdNoRepeat = btn.update(false, true, 500 + LIGHTS_HOLD_MS + 100, true);
  check(
    "HeadlightButton tap flashes (>= MIN_FLASH_MS) and hold toggles once",
    tap0.flash && !tap0.toggle && flashHeldShort && flashEnded && holdToggle.toggle && !holdNoRepeat.toggle,
    `holdMs=${LIGHTS_HOLD_MS}, minFlashMs=${MIN_FLASH_MS}`
  );

  // Physical road illumination check: evaluate twin GT3 low beam & single Medium spot out to 110 m
  const evalAsphaltRgb = (carId: CarId, spotCount: 1 | 2, highBeam: boolean, distM: number) => {
    const hl = new CarHeadlights(carId, { spotCount });
    hl.setFlash(highBeam);
    hl.setEnabled(true, false);
    const spots = hl.group.children.filter((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    let irr = 0;
    const roadPt = new THREE.Vector3(0, 0, headlightProfileFor(carId).frontZM + distM);
    for (const s of spots) {
      const toRoad = roadPt.clone().sub(s.position);
      const d = toRoad.length();
      const dirToRoad = toRoad.clone().divideScalar(d);
      const aimDir = s.target.position.clone().sub(s.position).normalize();
      const coneCos = Math.cos(s.angle);
      const penCos = Math.cos(s.angle * (1 - s.penumbra));
      const t = THREE.MathUtils.clamp((dirToRoad.dot(aimDir) - coneCos) / Math.max(1e-6, penCos - coneCos), 0, 1);
      const spotAtten = t * t * (3 - 2 * t);
      const r = d / s.distance;
      const win = Math.pow(Math.max(0, 1 - r ** 4), 2);
      const distAtten = win / Math.max(Math.pow(d, s.decay), 0.01);
      const ndl = Math.max(0, s.position.y / d);
      irr += s.intensity * distAtten * spotAtten * ndl;
    }
    hl.dispose();
    const nightLit = evaluateSkyLighting(nightElev, 0, 0);
    const lin = (irr * 0.08 / Math.PI) * nightLit.exposure;
    const tm = lin / (1 + lin * 0.85);
    const srgb = Math.pow(Math.max(0, tm), 1 / 2.2);
    const graded = THREE.MathUtils.clamp((srgb - 0.5) * (1 + nightLit.gradeContrast) + 0.5, 0, 1);
    return Math.round(graded * 255);
  };

  const gt3At25 = evalAsphaltRgb("amg-gt3", 2, false, 25);
  const gt3At50 = evalAsphaltRgb("amg-gt3", 2, false, 50);
  const gt3At80 = evalAsphaltRgb("amg-gt3", 2, false, 80);
  const gt3At110 = evalAsphaltRgb("amg-gt3", 2, false, 110);
  const gt3MedAt50 = evalAsphaltRgb("amg-gt3", 1, false, 50);
  const gt3HighAt140 = evalAsphaltRgb("amg-gt3", 2, true, 140);
  const lmdhAt80 = evalAsphaltRgb("lc-lmdh", 2, false, 80);
  const roadAt80 = evalAsphaltRgb("liana", 2, false, 80);

  check(
    "Headlights illuminate asphalt cleanly out to 110 m (never crushed to pitch black)",
    HEADLIGHT_BEAM_DECAY < 1 &&
      HEADLIGHT_SPOT_HEIGHT_LIFT_M >= 0.45 &&
      BEAM_ANGLE >= 0.9 &&
      BEAM_PENUMBRA <= 0.78 &&
      LOW_BEAM_AIM_M >= 85 &&
      LOW_BEAM_AIM_Y_M > 0 &&
      gt3At25 >= 75 &&
      gt3At50 >= 40 &&
      gt3At80 >= 25 &&
      gt3At110 >= 18 &&
      gt3MedAt50 >= 38 &&
      gt3HighAt140 >= 24 &&
      lmdhAt80 >= 25 &&
      roadAt80 >= 22,
    `GT3 rgb: 25m=${gt3At25}, 50m=${gt3At50} (med=${gt3MedAt50}), 80m=${gt3At80}, 110m=${gt3At110}, high@140m=${gt3HighAt140}`
  );

  // Night ambient lighting floor & daytime preservation
  const golden = evaluateSkyLighting(14, 0, 0);
  const twilight = evaluateSkyLighting(-3, 0, 0);
  const clearNight = evaluateSkyLighting(nightElev, 0, 0);
  const stormyNight = evaluateSkyLighting(nightElev, 1, 0.85);
  check(
    "Golden-hour daytime lighting curves remain exact",
    Math.abs(golden.keyIntensity - 5.0) < 1e-6 &&
      Math.abs(golden.fillIntensity - 0.13) < 1e-6 &&
      Math.abs(golden.environmentIntensity - 1.0) < 1e-6 &&
      Math.abs(golden.exposure - 1.15) < 1e-6 &&
      Math.abs(golden.gradeContrast - 0.12) < 1e-6,
    `key=${golden.keyIntensity}, fill=${golden.fillIntensity}, exp=${golden.exposure}`
  );
  check(
    "Night, twilight, and stormy-night maintain a readable ambient floor without black-crush",
    nightShareOf(nightElev) === 1 &&
      twilight.keyIntensity >= 0.15 &&
      clearNight.keyIntensity >= 0.65 &&
      clearNight.fillIntensity >= 0.2 &&
      clearNight.environmentIntensity >= 0.32 &&
      clearNight.gradeContrast <= 0.04 &&
      stormyNight.keyIntensity >= 0.3 &&
      stormyNight.fillIntensity >= 0.5 &&
      NIGHT_SKY_HORIZON[2] > NIGHT_SKY_ZENITH[2],
    `night key=${clearNight.keyIntensity.toFixed(2)}/fill=${clearNight.fillIntensity.toFixed(2)}, storm key=${stormyNight.keyIntensity.toFixed(2)}/fill=${stormyNight.fillIntensity.toFixed(2)}, contrast=${clearNight.gradeContrast.toFixed(2)}`
  );

  // Opponent lights remain independent of player manual toggle
  const offAtNight = resolveHeadlightStates("off", nightElev, 0);
  check(
    "Opponents keep automatic headlights at night even if player switches theirs off",
    !offAtNight.player && offAtNight.opponents,
    `player=${offAtNight.player}, opp=${offAtNight.opponents}`
  );
}

// ---------------------------------------------------------------------------
// 3. Heavy-rain performance budgets & hot-loop efficiency
// ---------------------------------------------------------------------------
console.log("\n== Heavy-rain performance budgets");
{
  const lowHeavy = rainStreakCountFor(1.0, "low", 1.0);
  const medHeavy = rainStreakCountFor(1.0, "medium", 1.0);
  const highHeavy = rainStreakCountFor(1.0, "high", 1.0);
  const highSteppedDown = rainStreakCountFor(1.0, "high", 0.7);
  check(
    "Rain streak counts respect per-tier budgets and adaptive LOD scaling",
    rainStreakCountFor(0, "high", 1) === 0 &&
      lowHeavy === RAIN_STREAK_BUDGET.low &&
      lowHeavy <= 1200 &&
      medHeavy === RAIN_STREAK_BUDGET.medium &&
      medHeavy <= 2800 &&
      highHeavy === RAIN_STREAK_BUDGET.high &&
      highHeavy <= 4800 &&
      highSteppedDown < highHeavy * 0.75,
    `low=${lowHeavy}, med=${medHeavy}, high=${highHeavy}, lod0.7=${highSteppedDown}`
  );

  const scene = new THREE.Scene();
  const rainFx = createRainFx(scene);
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const vel = new THREE.Vector3(0, 0, 70);
  const gt3Vol = cockpitRainVolumeFor("amg-gt3")!;
  const chassisMat = new THREE.Matrix4().makeTranslation(0, 0.3, 0);
  rainFx.setQuality("medium", 0.85);
  rainFx.setCockpitOcclusion(gt3Vol, chassisMat);
  rainFx.update(1 / 60, 0.9, cam, vel, 0.3, 4, -2, 0.6);
  const expectedStreaks = rainStreakCountFor(0.9, "medium", 0.85);
  const drawRangeOk = rainFx.object.visible && rainFx.object.geometry.instanceCount === expectedStreaks;

  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    cam.position.z = i * 1.1;
    rainFx.setCockpitOcclusion(gt3Vol, chassisMat);
    rainFx.update(1 / 60, 0.9, cam, vel, 0.3, 4, -2, 0.6);
  }
  const rainMs = performance.now() - t0;
  rainFx.update(1 / 60, 0, cam, vel, 1.0, 0, 0, 0);
  const hidesDry = !rainFx.object.visible;
  rainFx.dispose();
  check(
    "RainFx draws one streak per drop accurately, hides in dry, and runs 1000 heavy-rain frames fast",
    drawRangeOk && hidesDry && rainMs < 40,
    `streaks=${expectedStreaks}, 1000 frames=${rainMs.toFixed(2)} ms`
  );

  // SimVisualFxManager spray compaction, quality budgets, and distance culling
  const fx = new SimVisualFxManager();
  check(
    "SimVisualFxManager starts with 0 drawn puff instances when idle",
    fx.activeParticleCount === 0 && fx.particleDrawCount === 0,
    `count=${fx.particleDrawCount}`
  );
  fx.setWetness(1.0);
  const makeWheel = (x: number, z: number): SimulatorWheel =>
    ({
      worldPos: new THREE.Vector3(x, 0.33, z),
      zRoad: 0,
      fzN: 3500,
      spinVel: 200,
      combinedSlipNorm: 0.1,
      slideSpeedMs: 0.2,
      lockShare: 0,
      surfaceType: "asphalt",
    }) as unknown as SimulatorWheel;
  const wheels = [makeWheel(-0.9, 1.5), makeWheel(0.9, 1.5), makeWheel(-0.9, -1.5), makeWheel(0.9, -1.5)] as const;
  const quat = new THREE.Quaternion();

  fx.setGraphicsQuality("high");
  const tFx0 = performance.now();
  for (let i = 0; i < 300; i++) {
    fx.update(1 / 60, quat, 72, wheels, [], true);
  }
  const fxMs = performance.now() - tFx0;
  const highActive = fx.activeParticleCount;
  const highDraw = fx.particleDrawCount;

  fx.setGraphicsQuality("low");
  const lowAfterTrim = fx.particleDrawCount;
  for (let i = 0; i < 120; i++) {
    fx.update(1 / 60, quat, 72, wheels, [], true);
  }
  const lowSustained = fx.particleDrawCount;

  // Let all particles expire when emission stops
  for (let i = 0; i < 120; i++) {
    fx.update(1 / 60, quat, 0, wheels, [], false);
  }
  const drainedToZero = fx.activeParticleCount === 0 && fx.particleDrawCount === 0;
  check(
    "Spray particles compact tightly, respect quality budgets, and drain to 0 draws",
    highActive > 0 &&
      highActive === highDraw &&
      highDraw <= PARTICLE_BUDGET.high &&
      lowAfterTrim <= PARTICLE_BUDGET.low &&
      lowSustained <= PARTICLE_BUDGET.low &&
      OPPONENT_SPRAY_DIST_M.low < OPPONENT_SPRAY_DIST_M.high &&
      drainedToZero &&
      fxMs < 50,
    `high=${highDraw}/${PARTICLE_BUDGET.high}, low=${lowSustained}/${PARTICLE_BUDGET.low}, 300 wet steps=${fxMs.toFixed(2)} ms`
  );

  // Verify shader hot-path guards stay intact
  const rainSrc = readFileSync(resolve(process.cwd(), "src/lib/render/rain-fx.ts"), "utf8");
  const visualFxSrc = readFileSync(resolve(process.cwd(), "src/lib/sim/visual-fx.ts"), "utf8");
  const asphaltSrc = readFileSync(resolve(process.cwd(), "src/lib/render/asphalt-sheen.ts"), "utf8");
  const scenerySrc = readFileSync(resolve(process.cwd(), "src/lib/render/scenery-detail.ts"), "utf8");
  check(
    "Heavy-rain shader guards (sphere cull, ALU puff hash, distance-gated road/water splashes) are active",
    rainSrc.includes("midDist > reach + 1.5") &&
      rainSrc.includes("if (a < 0.003) discard;") &&
      visualFxSrc.includes("if (r >= 1.0 || vAlpha < 0.003) discard;") &&
      !visualFxSrc.includes("new THREE.Vector3(0, 0, 1).applyQuaternion(peer.quaternion)") &&
      asphaltSrc.includes("if ( lc26Dist < 42.0 && uRainIntensity > 0.02") &&
      scenerySrc.includes("if ( scnDist < 45.0 && uRainIntensity > 0.02"),
    "shader guards verified"
  );
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(", ")}` : "\nAll rain & night checks passed.");
if (failures.length) process.exit(1);
