/**
 * Comprehensive Verification Suite for Agent 6 (`cockpit-audio-ai`) Systems of
 * VeloSoft LC-26 (`lc26-f1`):
 *  1. Steering-Wheel MFD State, 15-LED Shift Bar, Live Mode Pills, 2D Canvas Renderer & React HUD Overlay
 *  2. Garage Setup Schema, Fuel-in-kg Invariance, Named Presets & Physics Config Applier
 *  3. 2026 MGU-H-Free Multi-Layer Procedural WebAudio Synthesizer
 *  4. `public/ai/lc26-f1*.json` Schemas & Pure 2026 AI Racecraft Controller
 *
 * Run: node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify-lc26-systems.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';

import {
  LC26_CHASSIS_DATA,
  LC26_FIA_POWERTRAIN_LIMITS,
  LC26_GLB_NODE_NAMES,
  LC26_VEHICLE_ID,
  type AeroData,
  type BrakesData,
  type DifferentialData,
  type Lc26AiTuningSchema,
  type Lc26GarageSetup,
  type Lc26MfdPageId,
  type SuspensionsData,
} from '../src/lib/cars/lc26/contract-types';
import {
  applyLc26SetupToPhysicsConfig,
  formatLc26PirelliCompoundCode,
  LC26_AI_MIN_SOC_RESERVE_01,
  LC26_BASELINE_SETUP,
  LC26_CIRCUIT_SLICK_ALLOCATIONS,
  LC26_ENUM_PARAMETERS,
  LC26_PARAMETER_BY_ID,
  LC26_SETUP_PARAMETERS,
  LC26_SETUP_PRESETS,
  LC26_SETUP_TABS,
  resolveLc26AiCircuitEntry,
  resolveLc26TireCompound,
  sanitizeLc26GarageSetup,
  stepLc26AiRacecraft,
  validateLc26AiTuningSchema,
  validateLc26GarageSetup,
} from '../src/lib/cars/lc26/setup';
import {
  buildLc26MfdViewModel,
  computeLc26ShiftLedState,
  LC26_LED_COLORS,
  LC26_MFD_PAGES,
  Lc26WheelMfdRig,
  nextLc26MfdPage,
  prevLc26MfdPage,
  renderLc26WheelMfdCanvas,
  resolveLc26LiveMode,
  type Lc26Canvas2DContext,
  type Lc26LiveModeId,
} from '../src/lib/cars/lc26/mfd';
import {
  createLc26AudioController,
  LC26_SEAMLESS_UPSHIFT_CUT_MS,
  Lc26AudioController,
  type Lc26AudioFrameInput,
} from '../src/lib/cars/lc26/audio';
import { Lc26MfdOverlay } from '../src/components/hud/Lc26MfdOverlay';
import { resolveAiTuning, sanitizeTuningFile, type AiTuningLibrary } from '../src/lib/sim/ai-tuning';

let passed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (!condition) {
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
  passed++;
  console.log(`  ok  ${name}${detail ? `  (${detail})` : ''}`);
}

function near(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) <= eps;
}

// ===========================================================================
// 1. STEERING-WHEEL MFD, 15 SHIFT LEDS, 2D CANVAS & REACT HUD OVERLAY
// ===========================================================================
console.log('\n1. Steering-Wheel MFD, 15 Shift LEDs, 2D Canvas & React HUD Overlay');

{
  // 1a. 15-LED colors & RPM progression
  const idleLeds = computeLc26ShiftLedState({ rpm: 4000 });
  check(
    '15 shift LEDs all off at idle (4000 RPM)',
    idleLeds.colorsHex.length === 15 &&
      idleLeds.litCount === 0 &&
      idleLeds.colorsHex.every((c) => c === LC26_LED_COLORS.off) &&
      !idleLeds.shiftFlashActive &&
      !idleLeds.pitLimiterBlink &&
      !idleLeds.overtakeStrobeActive,
  );

  // Full normal sweep just below shift flash (e.g. 11900 RPM with shiftFlashRpm = 11950 -> 15 LEDs lit)
  const fullBand = computeLc26ShiftLedState({ rpm: 11920, ledStartRpm: 9400, shiftFlashRpm: 11950 });
  check('Full pre-flash bar lights all 15 LEDs', fullBand.litCount === 15 && !fullBand.shiftFlashActive);
  check(
    'LEDs 1..5 are green (#22c55e)',
    fullBand.colorsHex.slice(0, 5).every((c) => c === '#22c55e'),
    fullBand.colorsHex.slice(0, 5).join(','),
  );
  check(
    'LEDs 6..10 are red (#ef4444)',
    fullBand.colorsHex.slice(5, 10).every((c) => c === '#ef4444'),
    fullBand.colorsHex.slice(5, 10).join(','),
  );
  check(
    'LEDs 11..15 are blue/violet (#3b82f6 / #a855f7)',
    fullBand.colorsHex.slice(10, 15).every((c) => c === '#3b82f6' || c === '#a855f7') &&
      fullBand.colorsHex.slice(10, 15).includes('#3b82f6') &&
      fullBand.colorsHex.slice(10, 15).includes('#a855f7'),
    fullBand.colorsHex.slice(10, 15).join(','),
  );

  // Monotonicity across RPM
  let monotonic = true;
  let prevLit = 0;
  for (let rpm = 9000; rpm <= 11940; rpm += 120) {
    const st = computeLc26ShiftLedState({ rpm, ledStartRpm: 9400, shiftFlashRpm: 11950 });
    if (st.litCount < prevLit) monotonic = false;
    prevLit = st.litCount;
  }
  check('Shift LED litCount rises monotonically across RPM sweep', monotonic);

  // Shift flash ON vs OFF blink phases
  const flashPhase0 = computeLc26ShiftLedState({ rpm: 12100, nowMs: 0 });
  const flashPhase1 = computeLc26ShiftLedState({ rpm: 12100, nowMs: 70 });
  check(
    'Shift flash triggers at >= 11950 RPM and alternates ON/OFF phases',
    flashPhase0.shiftFlashActive &&
      flashPhase1.shiftFlashActive &&
      flashPhase0.colorsHex.every((c) => c !== LC26_LED_COLORS.off) &&
      flashPhase1.colorsHex.every((c) => c === LC26_LED_COLORS.off),
  );

  // Pit limiter blink
  const pit0 = computeLc26ShiftLedState({ rpm: 6500, pitLimiterActive: true, nowMs: 0 });
  const pit1 = computeLc26ShiftLedState({ rpm: 6500, pitLimiterActive: true, nowMs: 140 });
  check(
    'Pit-limiter blink alternates even/odd LED segments',
    pit0.pitLimiterBlink &&
      pit1.pitLimiterBlink &&
      pit0.colorsHex[0] !== LC26_LED_COLORS.off &&
      pit0.colorsHex[1] === LC26_LED_COLORS.off &&
      pit1.colorsHex[0] === LC26_LED_COLORS.off &&
      pit1.colorsHex[1] !== LC26_LED_COLORS.off,
  );

  // Overtake strobe
  const ovtStrobe = computeLc26ShiftLedState({ rpm: 10300, overtakeActive: true, nowMs: 0 });
  check(
    'Overtake strobe lights violet/magenta outer wingtip LEDs',
    ovtStrobe.overtakeStrobeActive &&
      ovtStrobe.colorsHex[0] === '#a855f7' &&
      ovtStrobe.colorsHex[14] === '#a855f7',
  );

  // 1b. Live Mode Pill across all 7 required states
  const modeCases: readonly [Lc26LiveModeId, Parameters<typeof resolveLc26LiveMode>[0]][] = [
    ['CM', { aeroMode: 'corner-mode', smProgress01: 0, mgukPowerKw: 120 }],
    ['SM', { aeroMode: 'straight-mode', smProgress01: 1, throttle01: 1, speedKmh: 305, mgukPowerKw: 200 }],
    ['WET SM', { aeroMode: 'partial-wet-fw-only', smProgress01: 1, throttle01: 1, speedKmh: 265, mgukPowerKw: 140 }],
    ['SUPER CLIP', { aeroMode: 'straight-mode', smProgress01: 1, throttle01: 0.98, brake01: 0, speedKmh: 318, mgukPowerKw: -240 }],
    ['OVERTAKE READY', { aeroMode: 'corner-mode', overtakeAvailable: true, mgukPowerKw: 80 }],
    ['OVERTAKE', { aeroMode: 'straight-mode', smProgress01: 1, overtakeAvailable: true, overtakeActive: true, mgukPowerKw: 350 }],
    ['BOOST', { aeroMode: 'straight-mode', smProgress01: 1, boostActive: true, mgukPowerKw: 350 }],
  ];
  for (const [expectedMode, modeInput] of modeCases) {
    const badge = resolveLc26LiveMode(modeInput);
    check(`Live mode pill resolves "${expectedMode}"`, badge.mode === expectedMode, `aeroBadge=${badge.aeroBadge}`);
  }

  // 1c. MFD View-Model across all 5 pages + 8.5/9.0 MJ & 4.0/4.5 MJ energy budgets + Plank legality
  const stdVm = buildLc26MfdViewModel({
    rpm: 11200,
    gear: 7,
    speedKmh: 298,
    throttle01: 1.0,
    brake01: 0,
    soc01: 0.64,
    mgukPowerKw: 300,
    lapHarvestedJ: 6_200_000,
    lapDeployedJ: 2_800_000,
    fuelKg: 54.5,
  });
  check(
    'Standard lap caps are 8.5 MJ harvest & 4.0 MJ deploy',
    stdVm.lapHarvestCapMj === 8.5 && stdVm.lapDeployCapMj === 4.0 && near(stdVm.lapHarvestMj, 6.2) && near(stdVm.lapDeployMj, 2.8),
  );

  const ovtVm = buildLc26MfdViewModel({
    rpm: 11650,
    gear: 8,
    speedKmh: 334,
    throttle01: 1.0,
    brake01: 0,
    soc01: 0.52,
    mgukPowerKw: 350,
    overtakeAvailable: true,
    overtakeModeActive: true,
    lapHarvestedJ: 8_750_000,
    lapDeployedJ: 4_350_000,
    fuelKg: 41.0,
    plankWear: { frontSplitterMm: 8.85, midFloorMm: 9.4, rearTeaTrayMm: 9.6, sparkIntensity01: 0.7 },
  });
  check(
    'Overtake lap caps expand to 9.0 MJ harvest & 4.5 MJ deploy (+0.5 MJ FIA allowance)',
    ovtVm.lapHarvestCapMj === 9.0 &&
      ovtVm.lapDeployCapMj === 4.5 &&
      near(ovtVm.lapHarvestMj, 8.75) &&
      near(ovtVm.lapDeployMj, 4.35),
  );
  check(
    'Plank wear flags < 9.0 mm skid thickness as illegal',
    !ovtVm.plank.legal && near(ovtVm.plank.worstWearMm, 1.15),
  );

  // Cycle through all 5 MFD pages
  let cursor: Lc26MfdPageId = 'race-main';
  const visited: Lc26MfdPageId[] = [];
  for (let i = 0; i < LC26_MFD_PAGES.length; i++) {
    visited.push(cursor);
    cursor = nextLc26MfdPage(cursor);
  }
  check(
    'nextLc26MfdPage / prevLc26MfdPage cycle cleanly across all 5 MFD pages',
    cursor === 'race-main' &&
      visited.length === 5 &&
      new Set(visited).size === 5 &&
      prevLc26MfdPage('race-main') === 'fuel-plank',
    visited.join(' -> '),
  );

  // 1d. Mock 2D CanvasRenderingContext2D draw-call verification across all 5 pages & modes
  class MockCanvas2D implements Lc26Canvas2DContext {
    fillStyle: string | CanvasGradient | CanvasPattern = '#000';
    strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
    lineWidth = 1;
    font = '10px sans-serif';
    textAlign: CanvasTextAlign = 'start';
    textBaseline: CanvasTextBaseline = 'alphabetic';
    fillRects: { x: number; y: number; w: number; h: number; style: string }[] = [];
    texts: { text: string; x: number; y: number }[] = [];
    saveDepth = 0;

    fillRect(x: number, y: number, w: number, h: number): void {
      if (![x, y, w, h].every(Number.isFinite)) throw new Error('Non-finite fillRect coordinate');
      this.fillRects.push({ x, y, w, h, style: String(this.fillStyle) });
    }
    strokeRect(x: number, y: number, w: number, h: number): void {
      if (![x, y, w, h].every(Number.isFinite)) throw new Error('Non-finite strokeRect coordinate');
    }
    clearRect(x: number, y: number, w: number, h: number): void {
      if (![x, y, w, h].every(Number.isFinite)) throw new Error('Non-finite clearRect coordinate');
    }
    fillText(text: string, x: number, y: number): void {
      if (![x, y].every(Number.isFinite)) throw new Error('Non-finite fillText coordinate');
      this.texts.push({ text, x, y });
    }
    beginPath(): void {}
    moveTo(x: number, y: number): void {
      if (![x, y].every(Number.isFinite)) throw new Error('Non-finite moveTo');
    }
    lineTo(x: number, y: number): void {
      if (![x, y].every(Number.isFinite)) throw new Error('Non-finite lineTo');
    }
    stroke(): void {}
    save(): void {
      this.saveDepth++;
    }
    restore(): void {
      this.saveDepth--;
    }
  }

  for (const page of LC26_MFD_PAGES) {
    const mockCtx = new MockCanvas2D();
    const vm = buildLc26MfdViewModel({
      activePage: page.id,
      rpm: 11400,
      gear: 6,
      speedKmh: 284,
      throttle01: 0.96,
      brake01: 0,
      soc01: 0.58,
      mgukPowerKw: -210, // triggers SUPER CLIP at high speed & full throttle
      lapHarvestedJ: 5_400_000,
      lapDeployedJ: 2_900_000,
      fuelKg: 62.5,
      flaps: { mode: 'straight-mode', smProgress01: 1.0 },
    });
    renderLc26WheelMfdCanvas(mockCtx, 512, 312, vm);
    check(
      `2D Canvas MFD renders page "${page.id}" cleanly with balanced save/restore`,
      mockCtx.saveDepth === 0 &&
        mockCtx.fillRects.length >= 20 &&
        mockCtx.texts.some((t) => t.text === 'SUPER CLIP') &&
        mockCtx.texts.some((t) => t.text.includes(`${page.tag} ${page.index}/5`)),
      `rects=${mockCtx.fillRects.length}, texts=${mockCtx.texts.length}`,
    );
  }

  // 1e. Three.js Lc26WheelMfdRig shift LED node binding & clean dispose()
  const wheelRoot = new THREE.Group();
  wheelRoot.name = LC26_GLB_NODE_NAMES.steeringWheel;
  const sharedLedMat = new THREE.MeshStandardMaterial({ name: 'LED_BASE', color: 0x111111 });
  for (const ledName of LC26_GLB_NODE_NAMES.shiftLeds) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.002), sharedLedMat);
    mesh.name = ledName;
    wheelRoot.add(mesh);
  }
  const rig = new Lc26WheelMfdRig(wheelRoot);
  rig.update(ovtVm, 100);
  const firstLedMesh = wheelRoot.getObjectByName('led_shift_01') as THREE.Mesh;
  const litEmissive = (firstLedMesh.material as THREE.MeshStandardMaterial).emissiveIntensity;
  rig.dispose();
  check(
    'Lc26WheelMfdRig binds all 15 glTF shift LEDs, updates emissive intensity, and restores materials on dispose()',
    rig.foundLedCount === 15 && litEmissive > 2.0 && firstLedMesh.material === sharedLedMat,
  );

  // 1f. React SSR verification of Lc26MfdOverlay.tsx
  const html = renderToStaticMarkup(
    React.createElement(Lc26MfdOverlay, { viewModel: ovtVm }),
  );
  check(
    'Lc26MfdOverlay.tsx renders RPM, 15 LEDs, Gear 8, OVERTAKE pill, 9.0/4.5 MJ bars, BBW migration, kg fuel & 4-corner tyres',
    html.includes('LC-26') &&
      html.includes('OVERTAKE') &&
      html.includes('8.8/9.0 MJ') &&
      html.includes('4.3/4.5 MJ') &&
      html.includes('41.0 kg') &&
      html.includes('+2.0%') &&
      html.includes('FL') &&
      html.includes('FR') &&
      html.includes('RL') &&
      html.includes('RR'),
  );
}

// ===========================================================================
// 2. GARAGE SETUP SCHEMA, FUEL-IN-KG, PRESETS & PHYSICS APPLIER
// ===========================================================================
console.log('\n2. Garage Setup Schema, Fuel-in-kg, Presets & Physics Config Applier');

{
  check('Garage setup defines 6 structured engineering tabs', LC26_SETUP_TABS.length === 6);
  check('Garage setup defines 28 numeric parameters + 3 enum selectors', LC26_SETUP_PARAMETERS.length === 28 && Object.keys(LC26_ENUM_PARAMETERS).length === 3);

  // Fuel strictly in kg (5..100 kg, 0.5 kg steps) & zero liter units anywhere
  const fuelMeta = LC26_PARAMETER_BY_ID.fuelLoadKg;
  check(
    'Fuel parameter is strictly in kg (5.0–100.0 kg, 0.5 kg step)',
    fuelMeta.unit === 'kg' && fuelMeta.min === 5.0 && fuelMeta.max === 100.0 && fuelMeta.step === 0.5,
  );
  check(
    'Zero setup parameters use liters (L)',
    LC26_SETUP_PARAMETERS.every((p) => p.unit.toLowerCase() !== 'l' && p.unit.toLowerCase() !== 'liters'),
  );

  // Parameter range, baseline on-grid, round-trip & channel isolation
  const paramIssues: string[] = [];
  for (const p of LC26_SETUP_PARAMETERS) {
    if (!(p.min < p.max && p.step > 0)) {
      paramIssues.push(`${p.id}: invalid min/max/step`);
    }
    const baseVal = p.get(LC26_BASELINE_SETUP);
    if (!near(baseVal, p.baseline)) {
      paramIssues.push(`${p.id}: baseline mismatch (${baseVal} vs ${p.baseline})`);
    }
    for (const target of [p.min, p.max, p.baseline]) {
      const updated = p.set(LC26_BASELINE_SETUP, target);
      const readBack = p.get(updated);
      if (!near(readBack, target, 1e-4)) {
        paramIssues.push(`${p.id}: set(${target}) read back ${readBack}`);
      }
      // Check other channels untouched (except front/rear axle camber pairs which intentionally set axle pair)
      for (const other of LC26_SETUP_PARAMETERS) {
        if (other.id === p.id) continue;
        if (!near(other.get(updated), other.get(LC26_BASELINE_SETUP))) {
          paramIssues.push(`${p.id} mutated ${other.id}`);
        }
      }
    }
    if (!p.tooltip || p.tooltip.length < 15) {
      paramIssues.push(`${p.id}: missing descriptive tooltip`);
    }
  }
  check('All 28 numeric setup parameters pass range, step-grid, round-trip & channel-isolation checks', paramIssues.length === 0, paramIssues.join('; '));

  // Clamping & out-of-bounds sanitization
  const clamped = sanitizeLc26GarageSetup({
    fuelLoadKg: 145.3,
    coolingGillLevel: 9,
    frontWingAngleDeg: -4,
    rearWingAngleDeg: 99,
    frontRideHeightMm: 10,
    rearRideHeightMm: 5, // lower than front -> sanitizer enforces non-negative rake
    brakeBiasFrontPct: 40.11,
    compound: 'C5',
    ersDeployMode: 'INVALID',
  });
  const clampedLowFuel = sanitizeLc26GarageSetup({ fuelLoadKg: 1.2 });
  const quantizedFuel = sanitizeLc26GarageSetup({ fuelLoadKg: 42.26 });
  check(
    'Sanitizer clamps fuel strictly to [5.0, 100.0] kg on 0.5 kg steps and resolves C1–C5 compound codes',
    clamped.fuelLoadKg === 100.0 &&
      clampedLowFuel.fuelLoadKg === 5.0 &&
      quantizedFuel.fuelLoadKg === 42.5 &&
      clamped.coolingGillLevel === 5 &&
      clamped.frontWingAngleDeg === 0 &&
      clamped.rearWingAngleDeg === 16 &&
      clamped.rearRideHeightMm >= clamped.frontRideHeightMm &&
      clamped.compound === 'soft' &&
      clamped.ersDeployMode === LC26_BASELINE_SETUP.ersDeployMode &&
      validateLc26GarageSetup(clamped).valid,
  );

  // Preset invariance across all 4 named presets
  for (const presetId of ['baseline', 'low-drag-monza', 'high-downforce-monaco', 'wet-race'] as const) {
    const preset = LC26_SETUP_PRESETS[presetId];
    const validation = validateLc26GarageSetup(preset.setup);
    const sanitized = sanitizeLc26GarageSetup(preset.setup);
    check(
      `Preset "${presetId}" passes validation and is 100% invariant under sanitizeLc26GarageSetup()`,
      validation.valid && JSON.stringify(sanitized) === JSON.stringify(preset.setup),
      validation.issues.join('; '),
    );
  }

  // Pirelli C1-C5 <-> Soft/Medium/Hard/Inter/Wet mapping
  check(
    'Pirelli C1–C5 & rain compound mapping works across circuit allocations',
    resolveLc26TireCompound('C1') === 'hard' &&
      resolveLc26TireCompound('C3') === 'medium' &&
      resolveLc26TireCompound('C5') === 'soft' &&
      resolveLc26TireCompound('wet') === 'wet' &&
      formatLc26PirelliCompoundCode('soft', LC26_CIRCUIT_SLICK_ALLOCATIONS.silverstone) === 'C3' &&
      formatLc26PirelliCompoundCode('hard', LC26_CIRCUIT_SLICK_ALLOCATIONS.monza) === 'C3' &&
      formatLc26PirelliCompoundCode('intermediate') === 'INT',
  );

  // Physics Config Applier non-mutation & physical scaling
  const mockAero: AeroData = {
    front_lift: 1.2,
    rear_lift: 1.5,
    drag: 0.88,
    wings: [
      { name: 'FRONT_WING', area: 1.4, positionZ: 2.5, angleDeg: 5.5, heightRef: 'front', lutAOA_CL: [[0, 1]], lutAOA_CD: [[0, 0.1]], lutGH_CL_mult: [[0.03, 1]], lutGH_CD_mult: [[0.03, 1]] },
      { name: 'REAR_WING', area: 1.1, positionZ: -1.9, angleDeg: 9.0, heightRef: 'rear', lutAOA_CL: [[0, 1]], lutAOA_CD: [[0, 0.1]], lutGH_CL_mult: [[0.05, 1]], lutGH_CD_mult: [[0.05, 1]] },
    ],
    front_target_height: 0.032,
    rear_target_height: 0.058,
    floorOffsetY: -0.202,
    drsTransitionS: 0.35,
    drsCloseThrottle: 0.85,
    airDensity: 1.225,
  };
  const mockSusp: SuspensionsData = {
    front: {
      type: 'SuspensionType_DoubleWishbone',
      actuation: 'pull_rod',
      staticCamber: -3.25,
      camberGainKinematic: -18,
      springs: { wheel_rate: 165000, helper_rate: 0, helper_range: 0 },
      heave: { rate: 270000, gap: 0, packerGap: 0.011, packerRate: 800000 },
      bumpStop: { range: 0.035, rate: 500000, progression: 0 },
      droopTravel: 0.035,
      rollCentreHeight: 0.0255,
      arb: 90000,
    },
    rear: {
      type: 'SuspensionType_DoubleWishbone',
      actuation: 'push_rod',
      staticCamber: -1.75,
      camberGainKinematic: -14,
      springs: { wheel_rate: 140000, helper_rate: 0, helper_range: 0 },
      heave: { rate: 190000, gap: 0, packerGap: 0.018, packerRate: 700000 },
      bumpStop: { range: 0.04, rate: 500000, progression: 0 },
      droopTravel: 0.035,
      rollCentreHeight: 0.0689,
      arb: 60000,
    },
    dampers_controller: {
      front: { base: { slow_bump: 4000, fast_bump: 2000, slow_rebound: 5000, fast_rebound: 2500 }, heave: { slow_bump: 5000, fast_bump: 2500, slow_rebound: 6000, fast_rebound: 3000 }, roll: { slow_bump: 2000, fast_bump: 1000, slow_rebound: 2500, fast_rebound: 1200 }, pitch: { slow_bump: 1000, fast_bump: 500, slow_rebound: 1000, fast_rebound: 500 }, fastThresholdMs: 0.08 },
      rear: { base: { slow_bump: 3800, fast_bump: 1900, slow_rebound: 4800, fast_rebound: 2400 }, heave: { slow_bump: 4500, fast_bump: 2200, slow_rebound: 5500, fast_rebound: 2800 }, roll: { slow_bump: 1800, fast_bump: 900, slow_rebound: 2200, fast_rebound: 1100 }, pitch: { slow_bump: 1000, fast_bump: 500, slow_rebound: 1000, fast_rebound: 500 }, fastThresholdMs: 0.08 },
    },
  };
  const mockBrakes: BrakesData = { maxTorqueNm: 5200, brakeByWire: true, front_bias: 0.56, ebbStep: 0.005, migration: { amount: 0.02, rampStart: 0.2 } };
  const mockDiff: DifferentialData = { type: 'LSD_Ramp', settings: { power: 0.3, coast: 0.25, preload: 75, friction_faces: 8, power_ramp_deg: 45, coast_ramp_deg: 65 } };

  const monzaApplied = applyLc26SetupToPhysicsConfig(LC26_SETUP_PRESETS['low-drag-monza'].setup, {
    chassis: LC26_CHASSIS_DATA,
    aero: mockAero,
    suspensions: mockSusp,
    brakes: mockBrakes,
    differential: mockDiff,
  });
  const monacoApplied = applyLc26SetupToPhysicsConfig(LC26_SETUP_PRESETS['high-downforce-monaco'].setup, {
    chassis: LC26_CHASSIS_DATA,
    aero: mockAero,
    suspensions: mockSusp,
    brakes: mockBrakes,
    differential: mockDiff,
  });

  check(
    'Physics applier sets wetStartMassKg = 768 kg + fuelLoadKg without mutating source objects',
    near(monzaApplied.wetStartMassKg, 768 + 94) &&
      near(monacoApplied.wetStartMassKg, 768 + 88) &&
      mockAero.wings[0].angleDeg === 5.5 &&
      mockSusp.front.springs.wheel_rate === 165000,
  );
  check(
    'Monza setup yields lower aero drag, stiffer heave rates, and lower cooling heat multiplier than Monaco',
    monzaApplied.aero!.drag < monacoApplied.aero!.drag &&
      monzaApplied.suspensions!.front.heave.rate > monacoApplied.suspensions!.front.heave.rate &&
      monzaApplied.coolingHeatRejectMultiplier < monacoApplied.coolingHeatRejectMultiplier &&
      monzaApplied.differential!.settings.preload === 85 &&
      near(monzaApplied.brakes!.front_bias, 0.57),
  );
}

// ===========================================================================
// 3. 2026 MGU-H-FREE PROCEDURAL WEBAUDIO SYNTHESIZER
// ===========================================================================
console.log('\n3. 2026 MGU-H-Free Multi-Layer Procedural WebAudio');

{
  class MockAudioParam {
    value = 0;
    setTargetCalls = 0;
    setTargetAtTime(target: number): MockAudioParam {
      this.value = target;
      this.setTargetCalls++;
      return this;
    }
  }

  class MockAudioNode {
    connections: unknown[] = [];
    disconnected = false;
    connect(dest: unknown): unknown {
      this.connections.push(dest);
      return dest;
    }
    disconnect(): void {
      this.disconnected = true;
    }
  }

  class MockGainNode extends MockAudioNode {
    gain = new MockAudioParam();
  }

  class MockOscillatorNode extends MockAudioNode {
    type: OscillatorType = 'sine';
    frequency = new MockAudioParam();
    detune = new MockAudioParam();
    started = false;
    stopped = false;
    start(): void {
      this.started = true;
    }
    stop(): void {
      this.stopped = true;
    }
  }

  class MockBiquadFilterNode extends MockAudioNode {
    type: BiquadFilterType = 'lowpass';
    frequency = new MockAudioParam();
    Q = new MockAudioParam();
    gain = new MockAudioParam();
  }

  class MockWaveShaperNode extends MockAudioNode {
    curve: Float32Array | null = null;
    oversample: OverSampleType = 'none';
  }

  class MockAudioBufferSourceNode extends MockAudioNode {
    buffer: unknown = null;
    loop = false;
    started = false;
    stopped = false;
    start(): void {
      this.started = true;
    }
    stop(): void {
      this.stopped = true;
    }
  }

  class MockAudioContext {
    sampleRate = 48000;
    currentTime = 0;
    destination = new MockAudioNode();
    oscillators: MockOscillatorNode[] = [];
    gains: MockGainNode[] = [];
    filters: MockBiquadFilterNode[] = [];
    shapers: MockWaveShaperNode[] = [];
    bufferSources: MockAudioBufferSourceNode[] = [];

    createGain(): GainNode {
      const g = new MockGainNode();
      this.gains.push(g);
      return g as unknown as GainNode;
    }
    createOscillator(): OscillatorNode {
      const o = new MockOscillatorNode();
      this.oscillators.push(o);
      return o as unknown as OscillatorNode;
    }
    createBiquadFilter(): BiquadFilterNode {
      const f = new MockBiquadFilterNode();
      this.filters.push(f);
      return f as unknown as BiquadFilterNode;
    }
    createWaveShaper(): WaveShaperNode {
      const s = new MockWaveShaperNode();
      this.shapers.push(s);
      return s as unknown as WaveShaperNode;
    }
    createBufferSource(): AudioBufferSourceNode {
      const bs = new MockAudioBufferSourceNode();
      this.bufferSources.push(bs);
      return bs as unknown as AudioBufferSourceNode;
    }
    createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
      const data = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    }
  }

  const mockAudioCtx = new MockAudioContext();
  const audio: Lc26AudioController = createLc26AudioController();
  audio.init(mockAudioCtx as unknown as AudioContext);

  check(
    'WebAudio graph initializes 8 oscillators, waveshaper, formant/bandpass filters & procedural turbulence loop',
    mockAudioCtx.oscillators.length === 8 &&
      mockAudioCtx.oscillators.every((o) => o.started) &&
      mockAudioCtx.shapers.length === 1 &&
      mockAudioCtx.shapers[0].curve !== null &&
      mockAudioCtx.bufferSources.length === 1 &&
      mockAudioCtx.bufferSources[0].started &&
      mockAudioCtx.filters.length >= 8,
    `osc=${mockAudioCtx.oscillators.length}, filters=${mockAudioCtx.filters.length}`,
  );

  const baseFrame: Lc26AudioFrameInput = {
    rpm: 10800, // f0 = 180 Hz
    revLimitRpm: LC26_FIA_POWERTRAIN_LIMITS.revLimitRpm,
    throttle01: 1.0,
    pedal01: 1.0,
    gear: 6,
    speedKmh: 280,
    boostBarGauge: 3.4,
    mgukPowerKw: 340, // +340 kW deploy
    straightModeProgress01: 0.0,
    tyreSlipPeak01: 0.08,
    plankSparkIntensity01: 0.0,
    cameraInterior: false,
  };

  for (let i = 0; i < 6; i++) {
    mockAudioCtx.currentTime += 0.016;
    audio.update(baseFrame, 0.016);
  }
  const deploySnap = audio.getDiagnosticSnapshot();
  check(
    'V6 engine-order harmonics lock accurately to 1.5x, 3x, 4.5x & 6x crankshaft fundamental (180 Hz at 10,800 RPM)',
    near(deploySnap.fundamentalHz, 180, 0.05) &&
      near(deploySnap.engineOrderHz[0], 270, 0.1) &&
      near(deploySnap.engineOrderHz[1], 540, 0.1) &&
      near(deploySnap.engineOrderHz[2], 810, 0.1) &&
      near(deploySnap.engineOrderHz[3], 1080, 0.1),
    deploySnap.engineOrderHz.join(', '),
  );
  check(
    'Positive 350 kW MGU-K deployment activates prominent electrical whine in "deploy" mode',
    deploySnap.mgukMode === 'deploy' && deploySnap.mgukGain > 0.18,
    `gain=${deploySnap.mgukGain}, helical=${deploySnap.mgukHelicalHz}Hz, inv=${deploySnap.mgukInverterHz}Hz`,
  );

  // Negative Super Clipping at full throttle & high speed -> distinct pitch/timbre vs deploy!
  audio.update({ ...baseFrame, speedKmh: 312, mgukPowerKw: -290 }, 0.016);
  const superClipSnap = audio.getDiagnosticSnapshot();
  check(
    'Negative MGU-K Super Clipping (-290 kW at WOT) stays prominent with distinct pitch & timbre modulation vs deploy',
    superClipSnap.mgukMode === 'super-clip' &&
      superClipSnap.mgukGain > 0.16 &&
      superClipSnap.mgukHelicalHz < deploySnap.mgukHelicalHz &&
      Math.abs(superClipSnap.mgukInverterHz - deploySnap.mgukInverterHz) > 250,
    `deploy=${deploySnap.mgukHelicalHz}/${deploySnap.mgukInverterHz}Hz vs clip=${superClipSnap.mgukHelicalHz}/${superClipSnap.mgukInverterHz}Hz`,
  );

  // Off-throttle MGU-H-free wastegate bark & BBW braking harvest
  audio.update({ ...baseFrame, throttle01: 0.02, pedal01: 0, mgukPowerKw: -310, boostBarGauge: 2.8 }, 0.016);
  const liftSnap = audio.getDiagnosticSnapshot();
  check(
    'Rapid throttle lift triggers MGU-H-free wastegate bark/flutter and BBW "harvest" whine',
    liftSnap.wastegateBarkGain > 0.05 && liftSnap.mgukMode === 'harvest' && liftSnap.mgukGain > 0.16,
    `wastegateBark=${liftSnap.wastegateBarkGain}, mgukMode=${liftSnap.mgukMode}`,
  );

  // Crisp 28 ms seamless upshift ignition-cut crack
  audio.update(baseFrame, 0.016);
  const preShiftGain = audio.getDiagnosticSnapshot().engineDriveGain;
  audio.triggerGearShift('up');
  audio.update(baseFrame, 0.01); // 10 ms into 28 ms cut -> still in cut!
  const midCutSnap = audio.getDiagnosticSnapshot();
  audio.update(baseFrame, 0.022); // +22 ms = 32 ms elapsed -> past 28 ms cut!
  const postCutSnap = audio.getDiagnosticSnapshot();
  check(
    `Seamless upshift enforces exact ${LC26_SEAMLESS_UPSHIFT_CUT_MS} ms ignition cut + tailpipe crack and recovers cleanly`,
    midCutSnap.upshiftCutRemainingMs > 15 &&
      midCutSnap.engineDriveGain < preShiftGain * 0.25 &&
      midCutSnap.shiftTransientGain > 0.2 &&
      postCutSnap.upshiftCutRemainingMs === 0 &&
      near(postCutSnap.engineDriveGain, preShiftGain, 0.02),
    `pre=${preShiftGain}, midCut=${midCutSnap.engineDriveGain}, post=${postCutSnap.engineDriveGain}`,
  );

  // Downshift blip bark
  audio.triggerGearShift('down');
  audio.update({ ...baseFrame, rpm: 9600, throttle01: 0 }, 0.01);
  const downshiftSnap = audio.getDiagnosticSnapshot();
  check(
    'Downshift triggers electronic throttle-blip RPM flare & overrun bark',
    downshiftSnap.fundamentalHz > 9600 / 60 + 8 && downshiftSnap.shiftTransientGain > 0.15,
    `fundamentalHz=${downshiftSnap.fundamentalHz}`,
  );

  // Straight Mode wind-tone drop & Titanium plank sparks
  audio.update({ ...baseFrame, speedKmh: 315, straightModeProgress01: 0, plankSparkIntensity01: 0 }, 0.016);
  const cmWind = audio.getDiagnosticSnapshot();
  audio.update({ ...baseFrame, speedKmh: 315, straightModeProgress01: 1, plankSparkIntensity01: 0.9 }, 0.016);
  const smSpark = audio.getDiagnosticSnapshot();
  check(
    'Straight Mode drops aero wind-tone cutoff & amplitude while bottoming triggers Ti-6Al-4V spark crackle',
    smSpark.aeroWindCutoffHz < cmWind.aeroWindCutoffHz * 0.7 &&
      smSpark.aeroWindGain < cmWind.aeroWindGain * 0.8 &&
      cmWind.plankSparkGain === 0 &&
      smSpark.plankSparkGain > 0.1,
    `windHz: ${cmWind.aeroWindCutoffHz} -> ${smSpark.aeroWindCutoffHz} Hz, sparkGain=${smSpark.plankSparkGain}`,
  );

  // Mute & Dispose
  audio.setMuted(true);
  audio.update(baseFrame, 0.016);
  check('setMuted(true) zeroes master output gain', mockAudioCtx.gains[0].gain.value === 0);
  audio.dispose();
  check(
    'dispose() stops all oscillators and noise buffer cleanly',
    !audio.getDiagnosticSnapshot().initialized &&
      mockAudioCtx.oscillators.every((o) => o.stopped) &&
      mockAudioCtx.bufferSources[0].stopped,
  );
}

// ===========================================================================
// 4. AI RACECRAFT JSON SCHEMAS & 2026 AI RACECRAFT CONTROLLER INVARIANTS
// ===========================================================================
console.log('\n4. public/ai/lc26-f1*.json Schemas & 2026 AI Racecraft Controller');

{
  const circuitIds = [
    'monza',
    'silverstone',
    'spa',
    'suzuka',
    'marina_bay',
    'yas_marina',
    'spielberg',
  ] as const;

  const basePath = join('public', 'ai', 'lc26-f1.json');
  check('public/ai/lc26-f1.json exists', existsSync(basePath));
  const baseSchema = JSON.parse(readFileSync(basePath, 'utf8')) as Lc26AiTuningSchema;
  const baseValid = validateLc26AiTuningSchema(baseSchema);
  check(
    'public/ai/lc26-f1.json passes Lc26AiTuningSchema validation with >= 12% SoC reserve',
    baseValid.valid && baseSchema.carId === LC26_VEHICLE_ID && baseSchema.defaults.overtakeSocReserve01 >= LC26_AI_MIN_SOC_RESERVE_01,
    baseValid.issues.join('; '),
  );

  const tuningLib: Record<string, ReturnType<typeof sanitizeTuningFile>> = {
    'f1-2026': sanitizeTuningFile(baseSchema),
  };

  for (const cid of circuitIds) {
    const filePath = join('public', 'ai', `lc26-f1.${cid}.json`);
    check(`public/ai/lc26-f1.${cid}.json exists`, existsSync(filePath));
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Lc26AiTuningSchema & { sections?: unknown[] };
    const schemaCheck = validateLc26AiTuningSchema(raw);
    const sanitizedForSim = sanitizeTuningFile(raw);
    tuningLib[`f1-2026.${cid}`] = sanitizedForSim;

    const entry = resolveLc26AiCircuitEntry(baseSchema, cid);
    check(
      `lc26-f1.${cid}.json validates cleanly (Lc26AiTuningSchema + AiTuningFile sections, SoC reserve >= 12%)`,
      schemaCheck.valid &&
        entry.overtakeSocReserve01 >= LC26_AI_MIN_SOC_RESERVE_01 &&
        (sanitizedForSim.sections?.length ?? 0) >= 5,
      `reserve=${(entry.overtakeSocReserve01 * 100).toFixed(0)}%, sections=${sanitizedForSim.sections?.length ?? 0}`,
    );
  }

  // Verify LibreCorsa resolveAiTuning compatibility across all circuits
  const resolvedSpielberg = resolveAiTuning(
    { classId: 'f1-2026', vehicleId: LC26_VEHICLE_ID, trackId: 'spielberg' },
    tuningLib as AiTuningLibrary,
  );
  check(
    'resolveAiTuning layers lc26-f1 class, vehicle & spielberg sections cleanly',
    resolvedSpielberg.sections.length >= 5 && resolvedSpielberg.sources.some((s) => s.includes('lc26-f1')),
    resolvedSpielberg.sources.join(' > '),
  );

  // AI Racecraft Controller Invariant 1: Straight Mode activation requires legal SM zone & throttle > 90%
  const smActive = stepLc26AiRacecraft({
    throttle01: 0.96,
    brake01: 0,
    speedKmh: 265,
    lateralG: 0.25,
    inLegalSmZone: true,
    smZoneProgress01: 0.25,
    soc01: 0.62,
    gapAheadSeconds: null,
  });
  const smBelow90Throttle = stepLc26AiRacecraft({
    throttle01: 0.89,
    brake01: 0,
    speedKmh: 265,
    lateralG: 0.25,
    inLegalSmZone: true,
    smZoneProgress01: 0.25,
    soc01: 0.62,
    gapAheadSeconds: null,
  });
  const smOutsideZone = stepLc26AiRacecraft({
    throttle01: 1.0,
    brake01: 0,
    speedKmh: 280,
    lateralG: 0.2,
    inLegalSmZone: false,
    soc01: 0.62,
    gapAheadSeconds: null,
  });
  const smDampPartial = stepLc26AiRacecraft({
    throttle01: 0.98,
    brake01: 0,
    speedKmh: 255,
    lateralG: 0.2,
    inLegalSmZone: true,
    trackWetness01: 0.35,
    rearFlapAllowedInWet: false,
    soc01: 0.62,
    gapAheadSeconds: null,
  });
  check(
    'AI activates Straight Mode in legal SM zones strictly when throttle > 90% (and partial-wet-fw-only in damp)',
    smActive.requestStraightMode &&
      smActive.expectedAeroMode === 'straight-mode' &&
      !smBelow90Throttle.requestStraightMode &&
      !smOutsideZone.requestStraightMode &&
      smDampPartial.requestStraightMode &&
      smDampPartial.expectedAeroMode === 'partial-wet-fw-only',
  );

  // AI Racecraft Controller Invariant 2: Overtake Mode & Tactical Boost when < 1.0 s behind car ahead
  const overtakeAttack = stepLc26AiRacecraft({
    throttle01: 0.98,
    brake01: 0,
    speedKmh: 295,
    lateralG: 0.15,
    inLegalSmZone: true,
    smZoneProgress01: 0.35,
    soc01: 0.55,
    gapAheadSeconds: 0.68,
    overtakeEarned: true,
  });
  const cleanAirCruise = stepLc26AiRacecraft({
    throttle01: 0.98,
    brake01: 0,
    speedKmh: 295,
    lateralG: 0.15,
    inLegalSmZone: true,
    smZoneProgress01: 0.35,
    soc01: 0.55,
    gapAheadSeconds: 1.45,
    overtakeEarned: false,
  });
  check(
    'AI arms & deploys Overtake Mode + PSH boost when < 1.0 s behind a car ahead, and holds off when >= 1.0 s',
    overtakeAttack.armOvertakeMode &&
      overtakeAttack.activateOvertakeBoost &&
      overtakeAttack.ersDeployMode === 'PSH' &&
      !cleanAirCruise.armOvertakeMode &&
      !cleanAirCruise.activateOvertakeBoost,
  );

  // AI Racecraft Controller Invariant 3: Straight-end Super Clipping & >= 12% SoC reserve protection across multi-straight stint
  const straightEndClip = stepLc26AiRacecraft(
    {
      throttle01: 0.99,
      brake01: 0,
      speedKmh: 322,
      lateralG: 0.1,
      inLegalSmZone: true,
      smZoneProgress01: 0.88,
      soc01: 0.42,
      gapAheadSeconds: null,
    },
    resolveLc26AiCircuitEntry(baseSchema, 'monza'),
  );
  check(
    'AI activates Super Clipping at straight ends to harvest energy cleanly before braking',
    straightEndClip.superClipHarvestActive &&
      straightEndClip.superClipTargetKw >= 120 &&
      !straightEndClip.activateOvertakeBoost,
    `clipKw=${straightEndClip.superClipTargetKw} kW, mode=${straightEndClip.ersDeployMode}`,
  );

  // Simulate an aggressive 4-straight Monza lap starting from low 22% SoC while < 1.0 s behind a rival:
  // confirm the AI never drains below >= 12% SoC mid-straight!
  let simSoc01 = 0.22;
  let minObservedSoc01 = simSoc01;
  let lapDepJ = 0;
  let lapHarvJ = 0;
  const monzaTuning = resolveLc26AiCircuitEntry(baseSchema, 'monza'); // reserve = 0.18 >= 0.12
  for (let step = 0; step < 400; step++) {
    const dt = 0.1;
    const progress = (step % 100) / 100; // 4 straights + braking zones
    const inBraking = progress >= 0.9;
    const dec = stepLc26AiRacecraft(
      {
        throttle01: inBraking ? 0 : 1.0,
        brake01: inBraking ? 0.9 : 0,
        speedKmh: inBraking ? 160 : 240 + progress * 95,
        lateralG: inBraking ? 1.2 : 0.15,
        inLegalSmZone: !inBraking,
        smZoneProgress01: progress / 0.9,
        soc01: simSoc01,
        lapDeployedJ: lapDepJ,
        lapHarvestedJ: lapHarvJ,
        gapAheadSeconds: 0.72,
        overtakeEarned: true,
      },
      monzaTuning,
    );

    let netBatteryW = 0;
    if (inBraking) {
      netBatteryW = +260_000; // BBW regen
    } else if (dec.superClipHarvestActive) {
      netBatteryW = +dec.superClipTargetKw * 1000;
    } else if (dec.activateOvertakeBoost) {
      netBatteryW = -350_000;
    } else if (dec.ersDeployMode === 'RAC') {
      netBatteryW = -180_000;
    } else if (dec.ersDeployMode === 'BAL') {
      netBatteryW = -80_000;
    }

    const dJ = netBatteryW * dt;
    if (dJ < 0) lapDepJ += -dJ;
    else lapHarvJ += dJ;
    simSoc01 = Math.max(0, Math.min(1, simSoc01 + dJ / LC26_FIA_POWERTRAIN_LIMITS.esMaxUsableDeltaSocJ));
    minObservedSoc01 = Math.min(minObservedSoc01, simSoc01);
  }
  check(
    'Multi-straight racecraft simulation keeps SoC healthy (>= 12% reserve, never flat mid-straight)',
    minObservedSoc01 >= LC26_AI_MIN_SOC_RESERVE_01,
    `minSoc=${(minObservedSoc01 * 100).toFixed(1)}%, endSoc=${(simSoc01 * 100).toFixed(1)}%`,
  );
}

console.log(`\nLC-26 Systems Verification: ALL ${passed} checks passed!`);
