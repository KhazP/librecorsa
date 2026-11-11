/**
 * Comprehensive Verification Suite for VeloSoft LC-26 (`lc26-f1`)
 * 2026 Narrowed 18-Inch Pirelli Thermal Tyre & Wet-Line Module (`src/lib/cars/lc26/tyres.ts`).
 *
 * Run:
 *   node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify-lc26-tyres.ts
 */

import {
  LC26_ALL_COMPOUND_SPECS,
  LC26_FRONT_TYRE_GEOMETRY,
  LC26_FULL_WET_SPEC,
  LC26_INTERMEDIATE_SPEC,
  LC26_PIRELLI_SLICK_CODES,
  LC26_PIRELLI_SLICK_COMPOUNDS,
  LC26_REAR_TYRE_GEOMETRY,
  LC26_RIM_18_INCH_SPEC,
  LC26_SLICK_SPECS,
  LC26_TYRES_MODULE,
  LC26_TYRE_DIMENSIONS,
  buildLc26CompoundSet,
  computeLc26DefaultBlanketPsi,
  createLc26CornerThermalState,
  evaluateLc26CornerThermalGrip,
  evaluateLc26LoadSensitiveMu,
  evaluateLc26PneumaticTrail,
  evaluateLc26ViscoelasticThermalMultiplier,
  evaluateTyresCompoundThermalLut,
  stepLc26CornerThermal,
  type Lc26CompoundId,
} from '../src/lib/cars/lc26/tyres';
import {
  LC26_CHASSIS_DATA,
  LC26_CONTRACT,
  type Lc26CornerThermalState,
} from '../src/lib/cars/lc26/contract-types';
import { F12026_CAR_CONFIG } from '../src/lib/sim/f12026-car/F12026CarConfig';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { createTyreRuntime, tyrePeakMu, VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';
import { wetnessFromWater } from '../src/lib/sim/wet-tyres';

const failures: string[] = [];
let passedCount = 0;

function check(name: string, ok: boolean, detail = ''): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${name.padEnd(72)} ${detail}`);
  if (ok) {
    passedCount++;
  } else {
    failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  }
}

const fmt = (v: number, digits = 3): string => v.toFixed(digits);
const near = (a: number, b: number, tol = 1e-6): boolean => Math.abs(a - b) <= tol;
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// 1. FIA 2026 Narrowed 18-Inch Pirelli Dimensions (`280/705-R18` & `375/710-R18`)
// ---------------------------------------------------------------------------
console.log('== 1. FIA 2026 Narrowed 18-Inch Pirelli Geometry');
{
  const f = LC26_TYRE_DIMENSIONS.front;
  const r = LC26_TYRE_DIMENSIONS.rear;
  const contractWheels = LC26_CONTRACT.fia2026LegalityBoxes.wheels18InchNarrowed;
  const contractMeta = LC26_CONTRACT.glbSceneGraph.rootMetadataExtras.fields;

  check(
    'Front 280/705-R18 exact dimensions (0.280 m width, 0.705 m OD, 0.3525 m radius)',
    f.designation === '280/705-R18' &&
      near(f.widthM, 0.28) &&
      near(f.outerDiameterM, 0.705) &&
      near(f.unloadedRadiusM, 0.3525) &&
      near(LC26_FRONT_TYRE_GEOMETRY.width, 0.28) &&
      near(LC26_FRONT_TYRE_GEOMETRY.radius, 0.3525),
    `${f.designation}: w=${f.widthM}m, OD=${f.outerDiameterM}m, R=${f.unloadedRadiusM}m`,
  );

  check(
    'Rear 375/710-R18 exact dimensions (0.375 m width, 0.710 m OD, 0.3550 m radius)',
    r.designation === '375/710-R18' &&
      near(r.widthM, 0.375) &&
      near(r.outerDiameterM, 0.71) &&
      near(r.unloadedRadiusM, 0.355) &&
      near(LC26_REAR_TYRE_GEOMETRY.width, 0.375) &&
      near(LC26_REAR_TYRE_GEOMETRY.radius, 0.355),
    `${r.designation}: w=${r.widthM}m, OD=${r.outerDiameterM}m, R=${r.unloadedRadiusM}m`,
  );

  check(
    '18-inch rim radii (0.2286 m bead seat, 0.248 m lip) & 2025 narrowing deltas',
    LC26_RIM_18_INCH_SPEC.nominalDiameterInch === 18 &&
      near(LC26_RIM_18_INCH_SPEC.beadRadiusM, 0.2286) &&
      near(LC26_RIM_18_INCH_SPEC.lipRadiusM, 0.248) &&
      near(LC26_RIM_18_INCH_SPEC.frontVs2025.widthDeltaM, -0.025) &&
      near(LC26_RIM_18_INCH_SPEC.frontVs2025.outerDiameterDeltaM, -0.015) &&
      near(LC26_RIM_18_INCH_SPEC.rearVs2025.widthDeltaM, -0.03) &&
      near(LC26_RIM_18_INCH_SPEC.rearVs2025.outerDiameterDeltaM, -0.01),
    `bead=${LC26_RIM_18_INCH_SPEC.beadRadiusM}m, lip=${LC26_RIM_18_INCH_SPEC.lipRadiusM}m, dW=-25/-30mm, dOD=-15/-10mm`,
  );

  check(
    'Matches specs/lc26-contract.json legality & glTF root metadata exactly',
    near(f.widthM, contractWheels.front.tyreWidthM) &&
      near(r.widthM, contractWheels.rear.tyreWidthM) &&
      near(f.unloadedRadiusM, contractMeta.tyreRadius.front) &&
      near(r.unloadedRadiusM, contractMeta.tyreRadius.rear) &&
      near(f.widthM / 2, contractMeta.tyreHalfWidth.front) &&
      near(r.widthM / 2, contractMeta.tyreHalfWidth.rear),
    `halfWidths=${contractMeta.tyreHalfWidth.front}/${contractMeta.tyreHalfWidth.rear}m`,
  );

  const allSlotsMatchGeometry = Object.values(LC26_TYRES_MODULE.compounds).every(
    ([frontData, rearData]) =>
      near(frontData.front.width, 0.28) &&
      near(frontData.front.radius, 0.3525) &&
      near(frontData.front.rimRadius, 0.2286) &&
      near(rearData.rear.width, 0.375) &&
      near(rearData.rear.radius, 0.355) &&
      near(rearData.rear.rimRadius, 0.2286),
  );
  check('All 5 weekend compound slots enforce narrowed 2026 geometry', allSlotsMatchGeometry);
}

// ---------------------------------------------------------------------------
// 2. Full C1–C5 Slick Graduation & Weekend Compound Mapper
// ---------------------------------------------------------------------------
console.log('\n== 2. C1–C5 Peak Grip, Wear Life, Warmup Rate & Weekend Mapper');
{
  const codes = LC26_PIRELLI_SLICK_CODES;
  const frontMuY = codes.map((c) => LC26_PIRELLI_SLICK_COMPOUNDS[c][0].modelData.Dy0);
  const rearMuY = codes.map((c) => LC26_PIRELLI_SLICK_COMPOUNDS[c][1].modelData.Dy0);
  const frontMuX = codes.map((c) => LC26_PIRELLI_SLICK_COMPOUNDS[c][0].modelData.Dx0);
  const wearKm = codes.map((c) => LC26_SLICK_SPECS[c].wearEnduranceSlidingKm);

  const strictlyInc = (arr: number[]): boolean => arr.every((v, i) => i === 0 || v > arr[i - 1]);
  const strictlyDec = (arr: number[]): boolean => arr.every((v, i) => i === 0 || v < arr[i - 1]);

  check(
    'Peak dry lateral & longitudinal friction strictly ordered C1 < C2 < C3 < C4 < C5',
    strictlyInc(frontMuY) && strictlyInc(rearMuY) && strictlyInc(frontMuX),
    `Front Dy0: ${frontMuY.map((v) => fmt(v, 2)).join(' < ')}`,
  );

  check(
    'Inverse wear endurance distance strictly ordered C1 > C2 > C3 > C4 > C5',
    strictlyDec(wearKm),
    `Endurance km: ${wearKm.map((v) => fmt(v, 1)).join(' > ')}`,
  );

  // Dynamic stint simulation: realistic F1 GP lap duty cycle (alternating loaded corners + straights)
  const lapDutyAt = (timeS: number) => {
    const phase = (timeS % 10) / 10; // 4.2 s cornering complex + 5.8 s straight every 10 s
    const inCorner = phase < 0.42;
    const cornerSign = Math.floor(timeS / 10) % 2 === 0 ? 1 : -1;
    return {
      fzN: inCorner ? 5600 : 6200,
      speedMs: inCorner ? 54 : 78,
      slipAngleRad: inCorner ? cornerSign * 3.9 * DEG2RAD : 0.15 * DEG2RAD,
      slipRatio: inCorner ? 0.022 : 0.008,
    };
  };

  const warmup12sGrip: number[] = [];
  const warmup12sBulkC: number[] = [];
  const stintRemainingLife: number[] = [];
  for (const code of codes) {
    let st = createLc26CornerThermalState(code, false);
    for (let step = 0; step < 2400; step++) {
      const t = step * 0.05;
      const duty = lapDutyAt(t);
      const out = stepLc26CornerThermal(st, {
        dtS: 0.05,
        compound: code,
        isRearAxle: false,
        ...duty,
        ambientTempC: 26,
        trackTempC: 38,
      });
      st = out.state;
      if (step === 240) {
        // t = 12.0 s into out-lap from 70 °C blankets
        warmup12sGrip.push(out.thermalGripMultiplier);
        warmup12sBulkC.push(out.meanBulkC);
      }
    }
    stintRemainingLife.push(st.remainingLife01);
  }

  check(
    'Dynamic stint wear strictly follows C1 (least wear) -> C5 (most wear)',
    strictlyDec(stintRemainingLife),
    `Remaining life after 120s: ${stintRemainingLife.map((v) => fmt(v, 3)).join(' > ')}`,
  );

  check(
    'Warmup rate from 70 °C blankets strictly ordered C1 < C2 < C3 < C4 < C5',
    strictlyInc(warmup12sGrip) && strictlyInc(warmup12sBulkC),
    `12s grip mult: ${warmup12sGrip.map((v) => fmt(v, 4)).join(' < ')}`,
  );

  // Weekend mapper tests
  const silverstoneSet = buildLc26CompoundSet('C1', 'C2', 'C3');
  const monacoSet = buildLc26CompoundSet('C3', 'C4', 'C5');
  const stepSet = buildLc26CompoundSet('C1', 'C3', 'C5');
  let rejectedInvalid = false;
  try {
    buildLc26CompoundSet('C5', 'C3', 'C1');
  } catch {
    rejectedInvalid = true;
  }

  check(
    'buildLc26CompoundSet maps weekend allocations & rejects inverted C-codes',
    silverstoneSet.slickFamilyMapping.hard === 'C1' &&
      monacoSet.slickFamilyMapping.soft === 'C5' &&
      stepSet.compounds.soft[0].modelData.Dy0 > stepSet.compounds.medium[0].modelData.Dy0 &&
      stepSet.compounds.medium[0].modelData.Dy0 > stepSet.compounds.hard[0].modelData.Dy0 &&
      rejectedInvalid,
    `C1/C3/C5 Dy0=${fmt(stepSet.compounds.hard[0].modelData.Dy0, 2)}/${fmt(stepSet.compounds.medium[0].modelData.Dy0, 2)}/${fmt(stepSet.compounds.soft[0].modelData.Dy0, 2)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. 3-Band × 3-Layer Thermals, 70 °C Blankets -> 90–105 °C Window & Ideal Gas
// ---------------------------------------------------------------------------
console.log('\n== 3. 3-Band × 3-Layer Thermal Model, Blanket Pre-heat & Ideal-Gas Pressure');
{
  const c3Init = createLc26CornerThermalState('C3', false);
  const interInit = createLc26CornerThermalState('intermediate', false);
  const wetInit = createLc26CornerThermalState('wet', false);

  check(
    'FIA 2026 pre-heat rules: 70 °C slicks, 60 °C Inter, 35–40 °C unblanketed Full Wet',
    LC26_PIRELLI_SLICK_CODES.every((c) => createLc26CornerThermalState(c, false).coreC === 70) &&
      c3Init.surfaceBandsC.every((t) => t === 70) &&
      c3Init.bulkBandsC.every((t) => t === 70) &&
      interInit.coreC === 60 &&
      wetInit.coreC >= 35 &&
      wetInit.coreC <= 40,
    `Slick=${c3Init.coreC}°C, Inter=${interInit.coreC}°C, Wet=${wetInit.coreC}°C`,
  );

  // Check 70 °C blanket grip vs 90-105 °C peak grip window across all C1-C5 slicks
  const allSlicksPeakInWindow = LC26_PIRELLI_SLICK_CODES.every((c) => {
    const atBlanket70 = evaluateLc26ViscoelasticThermalMultiplier(c, 70);
    const atWindow97 = evaluateLc26ViscoelasticThermalMultiplier(c, 97.5);
    const lutAt97 = evaluateTyresCompoundThermalLut(LC26_PIRELLI_SLICK_COMPOUNDS[c][0], 97.5);
    return atBlanket70 < 0.96 && near(atWindow97, 1.0, 1e-6) && near(lutAt97, 1.0, 1e-4);
  });
  check(
    'All C1–C5 slicks gain grip from 70 °C blankets to 1.000 peak inside 90–105 °C window',
    allSlicksPeakInWindow &&
      LC26_SLICK_SPECS.C3.optimalWindowC[0] === 90 &&
      LC26_SLICK_SPECS.C3.optimalWindowC[1] === 105,
    `C3 70°C=${fmt(evaluateLc26ViscoelasticThermalMultiplier('C3', 70), 3)} -> 97.5°C=${fmt(evaluateLc26ViscoelasticThermalMultiplier('C3', 97.5), 3)}`,
  );

  // Run realistic GP out-lap + flying lap (110 s alternating corners & straights) from 70 °C into 90-105 °C window
  let state = createLc26CornerThermalState('C3', false);
  const gripAt70 = evaluateLc26CornerThermalGrip('C3', state, { isRearAxle: false, fzN: 4500 }).effectiveMuY;
  const setPsi = computeLc26DefaultBlanketPsi('C3', false);
  const gasConst = (psi: number, tempC: number) => (psi + 14.6959) / (tempC + 273.15);

  for (let step = 0; step < 5500; step++) {
    const t = step * 0.02;
    const phase = (t % 10) / 10;
    const inCorner = phase < 0.44;
    const cornerSign = Math.floor(t / 10) % 2 === 0 ? 1 : -1;
    state = stepLc26CornerThermal(state, {
      dtS: 0.02,
      compound: 'C3',
      isRearAxle: false,
      isLeftCorner: true,
      fzN: inCorner ? 5500 : 6200,
      speedMs: inCorner ? 56 : 79,
      slipAngleRad: inCorner ? cornerSign * 4.1 * DEG2RAD : 0.12 * DEG2RAD,
      slipRatio: inCorner ? 0.025 : 0.008,
      camberRad: -3.2 * DEG2RAD,
      ambientTempC: 27,
      trackTempC: 41,
      coldSetPsi: setPsi,
    }).state;
  }
  const warmEval = evaluateLc26CornerThermalGrip('C3', state, { isRearAxle: false, fzN: 4500 });

  check(
    'Out-lap warmup drives surface/bulk into 90–105 °C window & boosts effective mu',
    warmEval.meanBulkC >= 90 &&
      warmEval.meanBulkC <= 105 &&
      warmEval.effectiveMuY > gripAt70 + 0.08,
    `bulk=${fmt(warmEval.meanBulkC, 1)}°C, core=${fmt(state.coreC, 1)}°C, mu=${fmt(gripAt70, 3)}->${fmt(warmEval.effectiveMuY, 3)}`,
  );

  check(
    '3-band negative camber stratification heats inner > middle > outer band',
    state.surfaceBandsC[0] > state.surfaceBandsC[1] &&
      state.surfaceBandsC[1] > state.surfaceBandsC[2] &&
      state.bulkBandsC[0] > state.bulkBandsC[2],
    `surf I/M/O = ${state.surfaceBandsC.map((v) => fmt(v, 1)).join(' / ')} °C`,
  );

  check(
    'Ideal-gas carcass pressure obeys P_abs / T_K invariant & approaches 24.5 psi hot target',
    near(gasConst(state.carcassDynamicPsi, state.coreC), gasConst(setPsi, 70), 1e-6) &&
      Math.abs(state.carcassDynamicPsi - LC26_SLICK_SPECS.C3.front.optimalHotPsi) < 1.2,
    `blanket=${fmt(setPsi, 2)} psi @70°C -> hot=${fmt(state.carcassDynamicPsi, 2)} psi @${fmt(state.coreC, 1)}°C`,
  );
}

// ---------------------------------------------------------------------------
// 4. Cold-Sliding Graining & In-Window Smooth Healing
// ---------------------------------------------------------------------------
console.log('\n== 4. Cold-Sliding Graining & In-Window Abrasion Healing');
{
  // Start C4 tyre cold (56 °C after slow safety-car / pit-exit delay on cold 15 °C track) and slide aggressively
  let grainedState: Lc26CornerThermalState = {
    ...createLc26CornerThermalState('C4', false),
    surfaceBandsC: [56, 56, 56],
    bulkBandsC: [56, 56, 56],
    coreC: 56,
  };

  for (let t = 0; t < 24; t += 0.02) {
    grainedState = stepLc26CornerThermal(grainedState, {
      dtS: 0.02,
      compound: 'C4',
      isRearAxle: false,
      fzN: 4600,
      speedMs: 52,
      slipAngleRad: 9.5 * DEG2RAD, // Severe cold understeer scrubbing
      slipRatio: 0.04,
      ambientTempC: 12,
      trackTempC: 15,
    }).state;
  }

  const peakGrain = grainedState.graining01;
  const cleanEquivalent: Lc26CornerThermalState = { ...grainedState, graining01: 0 };
  const muGrained = evaluateLc26CornerThermalGrip('C4', grainedState).effectiveMuY;
  const muClean = evaluateLc26CornerThermalGrip('C4', cleanEquivalent).effectiveMuY;

  // Now bring bulk into C4's 89-103 °C optimal window and drive smoothly over a 60 s GP lap duty
  let healedState: Lc26CornerThermalState = {
    ...grainedState,
    surfaceBandsC: [96, 95, 94],
    bulkBandsC: [95, 95, 94],
    coreC: 94,
  };
  for (let step = 0; step < 1200; step++) {
    const t = step * 0.05;
    const inCorner = (t % 10) / 10 < 0.42;
    healedState = stepLc26CornerThermal(healedState, {
      dtS: 0.05,
      compound: 'C4',
      isRearAxle: false,
      fzN: 5200,
      speedMs: inCorner ? 58 : 76,
      slipAngleRad: inCorner ? 3.5 * DEG2RAD : 0.15 * DEG2RAD,
      slipRatio: inCorner ? 0.015 : 0.006,
      ambientTempC: 26,
      trackTempC: 40,
    }).state;
  }

  check(
    'High slip on cold tyre builds graining01 & reduces peak friction mu',
    peakGrain > 0.25 && muGrained < muClean * 0.97,
    `graining01=${fmt(peakGrain, 3)}, mu=${fmt(muClean, 3)} -> ${fmt(muGrained, 3)}`,
  );

  check(
    'Smooth driving inside 90–105 °C working window progressively clears graining',
    healedState.graining01 < peakGrain * 0.45,
    `graining01 healed ${fmt(peakGrain, 3)} -> ${fmt(healedState.graining01, 3)}`,
  );
}

// ---------------------------------------------------------------------------
// 5. Overheated-Core Structural Blistering (`118 °C` C5 .. `130 °C` C1)
// ---------------------------------------------------------------------------
console.log('\n== 5. Overheated-Core Structural Blistering');
{
  const thresholds = LC26_PIRELLI_SLICK_CODES.map((c) => LC26_SLICK_SPECS[c].blisterCoreThresholdC);
  check(
    'Core blister thresholds graduate from 118 °C (C5) up to 130 °C (C1)',
    thresholds[0] === 130 &&
      thresholds[4] === 118 &&
      thresholds.every((v, i) => i === 0 || v < thresholds[i - 1]),
    `C1..C5 blister core °C: ${thresholds.join(' > ')}`,
  );

  // Hold both C5 (threshold 118 °C) and C1 (threshold 130 °C) at 125 °C core under high load for 20 s
  let c5Hot: Lc26CornerThermalState = {
    ...createLc26CornerThermalState('C5', true),
    surfaceBandsC: [128, 127, 126],
    bulkBandsC: [126, 126, 125],
    coreC: 125,
  };
  let c1Hot: Lc26CornerThermalState = {
    ...createLc26CornerThermalState('C1', true),
    surfaceBandsC: [128, 127, 126],
    bulkBandsC: [126, 126, 125],
    coreC: 125,
  };

  for (let t = 0; t < 20; t += 0.05) {
    c5Hot = stepLc26CornerThermal(c5Hot, {
      dtS: 0.05,
      compound: 'C5',
      isRearAxle: true,
      fzN: 6200,
      speedMs: 68,
      slipAngleRad: 5.5 * DEG2RAD,
      slipRatio: 0.06,
      ambientTempC: 36,
      trackTempC: 54,
      brakeDiscTempC: 680,
    }).state;
    c1Hot = stepLc26CornerThermal(c1Hot, {
      dtS: 0.05,
      compound: 'C1',
      isRearAxle: true,
      fzN: 6200,
      speedMs: 68,
      slipAngleRad: 5.5 * DEG2RAD,
      slipRatio: 0.06,
      ambientTempC: 36,
      trackTempC: 54,
      brakeDiscTempC: 680,
    }).state;
  }

  const blisterPeakC5 = c5Hot.blistering01;
  // Cool C5 down on a straight with zero slip and verify structural blistering persists
  let c5Cooled = c5Hot;
  for (let t = 0; t < 25; t += 0.05) {
    c5Cooled = stepLc26CornerThermal(c5Cooled, {
      dtS: 0.05,
      compound: 'C5',
      isRearAxle: true,
      fzN: 4500,
      speedMs: 80,
      slipAngleRad: 0,
      slipRatio: 0,
      ambientTempC: 22,
      trackTempC: 30,
      brakeDiscTempC: 300,
    }).state;
  }

  const unblisteredRef = evaluateLc26CornerThermalGrip('C5', { ...c5Cooled, blistering01: 0 }, { isRearAxle: true });
  const blisteredEval = evaluateLc26CornerThermalGrip('C5', c5Cooled, { isRearAxle: true });

  check(
    'At 125 °C core, C5 blisters heavily while C1 (130 °C ceiling) stays blister-free',
    blisterPeakC5 > 0.35 && c1Hot.blistering01 === 0,
    `C5 blistering01=${fmt(blisterPeakC5, 3)}, C1 blistering01=${fmt(c1Hot.blistering01, 3)}`,
  );

  check(
    'Structural blistering persists after cooling & permanently penalizes peak mu',
    c5Cooled.blistering01 >= blisterPeakC5 && blisteredEval.effectiveMuY < unblisteredRef.effectiveMuY * 0.94,
    `post-cool blistering01=${fmt(c5Cooled.blistering01, 3)}, mu=${fmt(unblisteredRef.effectiveMuY, 3)} -> ${fmt(blisteredEval.effectiveMuY, 3)}`,
  );
}

// ---------------------------------------------------------------------------
// 6. Strict Negative Vertical Load Sensitivity (`d_mu / d_Fz < 0` across 1..14 kN)
// ---------------------------------------------------------------------------
console.log('\n== 6. Strict Negative Vertical Load Sensitivity (1 kN .. 14 kN)');
{
  const allCompoundIds: Lc26CompoundId[] = [...LC26_PIRELLI_SLICK_CODES, 'intermediate', 'wet'];
  let allAnalyticalStrictlyNegative = true;
  let allForceStrictlyIncreasing = true;

  for (const cid of allCompoundIds) {
    for (const isRear of [false, true]) {
      for (const axis of ['y', 'x'] as const) {
        for (let fz = 1000; fz < 14_000; fz += 250) {
          const mu1 = evaluateLc26LoadSensitiveMu(cid, fz, isRear, axis);
          const mu2 = evaluateLc26LoadSensitiveMu(cid, fz + 250, isRear, axis);
          if (!(mu2 < mu1)) allAnalyticalStrictlyNegative = false;
          if (!(mu2 * (fz + 250) > mu1 * fz)) allForceStrictlyIncreasing = false;
        }
      }
    }
  }

  // Also check every weekend compound LUT inside VehiclePhysics's `createTyreRuntime` + `tyrePeakMu`
  let allSolverLutStrictlyNegative = true;
  for (const [, [frontData]] of Object.entries(LC26_TYRES_MODULE.compounds)) {
    const rtFront = createTyreRuntime(frontData, false);
    const rtRear = createTyreRuntime(frontData, true);
    for (const rt of [rtFront, rtRear]) {
      for (const axis of ['y', 'x'] as const) {
        for (let fz = 1000; fz < 14_000; fz += 250) {
          if (!(tyrePeakMu(rt, fz + 250, axis) < tyrePeakMu(rt, fz, axis))) {
            allSolverLutStrictlyNegative = false;
          }
        }
      }
    }
  }

  const c3Mu1kN = evaluateLc26LoadSensitiveMu('C3', 1000, false, 'y');
  const c3Mu4kN = evaluateLc26LoadSensitiveMu('C3', 4000, false, 'y');
  const c3Mu14kN = evaluateLc26LoadSensitiveMu('C3', 14_000, false, 'y');

  check(
    'Analytical d_mu / d_Fz < 0 strictly everywhere (1..14 kN, all 7 compounds, F&R, X&Y)',
    allAnalyticalStrictlyNegative && allForceStrictlyIncreasing,
    `C3 Front mu_y: 1kN=${fmt(c3Mu1kN, 3)} > 4kN=${fmt(c3Mu4kN, 3)} > 14kN=${fmt(c3Mu14kN, 3)}`,
  );

  check(
    'Solver dyCurve / dxCurve LUTs preserve strict d_mu / d_Fz < 0 across 1..14 kN',
    allSolverLutStrictlyNegative,
  );
}

// ---------------------------------------------------------------------------
// 7. Pneumatic Trail Decay (`t_p(alpha, Fz)`) & Understeer FFB Lightening
// ---------------------------------------------------------------------------
console.log('\n== 7. Pneumatic Trail Decay & WebHID FFB Understeer Lightening');
{
  const fz = 4800;
  const smallSlip = evaluateLc26PneumaticTrail({ slipAngleRad: 0.25 * DEG2RAD, fzN: fz, compound: 'C3' });
  const alphaPeakRad = smallSlip.peakSlipAngleRad;

  let strictlyDecayingToPeak = true;
  let prevTrail = smallSlip.pneumaticTrailM;
  for (let frac = 0.1; frac <= 1.0; frac += 0.1) {
    const cur = evaluateLc26PneumaticTrail({ slipAngleRad: frac * alphaPeakRad, fzN: fz, compound: 'C3' });
    if (!(cur.pneumaticTrailM < prevTrail)) strictlyDecayingToPeak = false;
    prevTrail = cur.pneumaticTrailM;
  }

  const atHalfPeak = evaluateLc26PneumaticTrail({ slipAngleRad: 0.55 * alphaPeakRad, fzN: fz, compound: 'C3' });
  const atPeak = evaluateLc26PneumaticTrail({ slipAngleRad: 1.0 * alphaPeakRad, fzN: fz, compound: 'C3' });
  const pastPeak = evaluateLc26PneumaticTrail({ slipAngleRad: 1.45 * alphaPeakRad, fzN: fz, compound: 'C3' });

  // Total kingpin steering moment arm = mechanical caster trail (20.4 mm) + pneumatic trail
  const mechTrailM = LC26_CHASSIS_DATA.ffbMechanicalTrailM ?? 0.0204;
  const kpMomentPrePeak = Math.abs(atHalfPeak.lateralForceN) * (mechTrailM + atHalfPeak.pneumaticTrailM);
  const kpMomentUndersteer = Math.abs(pastPeak.lateralForceN) * (mechTrailM + pastPeak.pneumaticTrailM);

  const wetHydroTrail = evaluateLc26PneumaticTrail({
    slipAngleRad: 1.5 * DEG2RAD,
    fzN: fz,
    compound: 'C3',
    waterFilmMm: 1.2,
    speedMs: 68,
  });
  const dryRefTrail = evaluateLc26PneumaticTrail({
    slipAngleRad: 1.5 * DEG2RAD,
    fzN: fz,
    compound: 'C3',
    waterFilmMm: 0,
    speedMs: 68,
  });

  check(
    'Pneumatic trail starts ahead of patch center (> 25 mm) & decays monotonically to peak',
    smallSlip.pneumaticTrailM > 0.025 && strictlyDecayingToPeak,
    `t_p(0.25°)=${fmt(smallSlip.pneumaticTrailM * 1000, 1)}mm -> t_p(alpha_peak)=${fmt(atPeak.pneumaticTrailM * 1000, 2)}mm`,
  );

  check(
    'Trail crosses through zero past alpha_peak (< 0) & lightens kingpin FFB in understeer',
    pastPeak.pneumaticTrailM < 0 &&
      Math.abs(atHalfPeak.aligningTorqueNm) > Math.abs(pastPeak.aligningTorqueNm) &&
      kpMomentUndersteer < kpMomentPrePeak,
    `t_p(1.45*peak)=${fmt(pastPeak.pneumaticTrailM * 1000, 2)}mm, M_kp=${fmt(kpMomentPrePeak, 1)} -> ${fmt(kpMomentUndersteer, 1)} Nm`,
  );

  check(
    'Standing water wedge collapses pneumatic trail earlier to warn of aquaplaning',
    wetHydroTrail.pneumaticTrailM < dryRefTrail.pneumaticTrailM * 0.55,
    `dry=${fmt(dryRefTrail.pneumaticTrailM * 1000, 1)}mm vs 1.2mm wet=${fmt(wetHydroTrail.pneumaticTrailM * 1000, 1)}mm`,
  );
}

// ---------------------------------------------------------------------------
// 8. Water-Film Evacuation (~38 L/s Inter, ~80 L/s Wet), Crossovers & Wet-Line
// ---------------------------------------------------------------------------
console.log('\n== 8. Water Evacuation, Slick/Inter/Wet Crossovers & Dynamic Wet-Line');
{
  const v300Ms = 300 / 3.6;
  const interFront300 = LC26_TYRES_MODULE.evaluateWetContact('intermediate', v300Ms, 4.5, 0, false);
  const interRear300 = LC26_TYRES_MODULE.evaluateWetContact('intermediate', v300Ms, 4.5, 0, true);
  const interMeanLs = 0.5 * (interFront300.evacuatedLitresPerSec + interRear300.evacuatedLitresPerSec);

  const wetFront300 = LC26_TYRES_MODULE.evaluateWetContact('wet', v300Ms, 6.0, 0, false);
  const wetRear300 = LC26_TYRES_MODULE.evaluateWetContact('wet', v300Ms, 6.0, 0, true);
  const wetMeanLs = 0.5 * (wetFront300.evacuatedLitresPerSec + wetRear300.evacuatedLitresPerSec);

  check(
    'Intermediate evacuates ~38 L/s & Full Wet evacuates ~80 L/s at 300 km/h (Rear > Front)',
    near(interMeanLs, 38, 1.5) &&
      near(wetMeanLs, 80, 3.0) &&
      interRear300.evacuatedLitresPerSec > interFront300.evacuatedLitresPerSec &&
      wetRear300.evacuatedLitresPerSec > wetFront300.evacuatedLitresPerSec,
    `Inter=${fmt(interMeanLs, 1)} L/s (${fmt(interFront300.evacuatedLitresPerSec, 1)}F/${fmt(interRear300.evacuatedLitresPerSec, 1)}R), Wet=${fmt(wetMeanLs, 1)} L/s`,
  );

  // Slick rapid hydroplaning onset across 0.5–0.8 mm
  const slick02 = LC26_TYRES_MODULE.evaluateWetContact('medium', 62, 0.2, 0, false);
  const slick06 = LC26_TYRES_MODULE.evaluateWetContact('medium', 62, 0.6, 0, false);
  const slick09 = LC26_TYRES_MODULE.evaluateWetContact('medium', 62, 0.9, 0, false);
  check(
    'Slicks exhibit rapid hydroplaning onset above 0.5–0.8 mm standing water',
    slick02.hydroplaneFactor01 < 0.05 &&
      slick06.hydroplaneFactor01 > 0.45 &&
      slick09.hydroplaneFactor01 > 0.85 &&
      slick09.wetGripMultiplier < 0.2,
    `hydroplane @0.2mm=${fmt(slick02.hydroplaneFactor01, 2)}, @0.6mm=${fmt(slick06.hydroplaneFactor01, 2)}, @0.9mm=${fmt(slick09.hydroplaneFactor01, 2)}`,
  );

  // Compound grip crossover across Dry (0 mm) -> Damp/Drying (1.0 mm) -> Heavy Standing Water (3.5 mm)
  const vRaceMs = 210 / 3.6;
  const drySlick = LC26_TYRES_MODULE.evaluateWetContact('soft', vRaceMs, 0, 0, false).wetGripMultiplier;
  const dryInter = LC26_TYRES_MODULE.evaluateWetContact('intermediate', vRaceMs, 0, 0, false).wetGripMultiplier;
  const dryWet = LC26_TYRES_MODULE.evaluateWetContact('wet', vRaceMs, 0, 0, false).wetGripMultiplier;

  const dampSlick = LC26_TYRES_MODULE.evaluateWetContact('soft', vRaceMs, 1.0, 0.5, false).wetGripMultiplier;
  const dampInter = LC26_TYRES_MODULE.evaluateWetContact('intermediate', vRaceMs, 1.0, 0.5, false).wetGripMultiplier;
  const dampWet = LC26_TYRES_MODULE.evaluateWetContact('wet', vRaceMs, 1.0, 0.5, false).wetGripMultiplier;

  const floodSlick = LC26_TYRES_MODULE.evaluateWetContact('soft', vRaceMs, 3.5, 0.5, false).wetGripMultiplier;
  const floodInter = LC26_TYRES_MODULE.evaluateWetContact('intermediate', vRaceMs, 3.5, 0.5, false).wetGripMultiplier;
  const floodWet = LC26_TYRES_MODULE.evaluateWetContact('wet', vRaceMs, 3.5, 0.5, false).wetGripMultiplier;

  check(
    'Dry (0 mm): Slick > Intermediate > Full Wet',
    drySlick > dryInter && dryInter > dryWet,
    `${fmt(drySlick, 3)} > ${fmt(dryInter, 3)} > ${fmt(dryWet, 3)}`,
  );
  check(
    'Damp/Drying (1.0 mm, inside 0.4–2.2 mm): Intermediate > Full Wet > Slick',
    dampInter > dampWet && dampWet > dampSlick + 0.4,
    `Inter=${fmt(dampInter, 3)} > Wet=${fmt(dampWet, 3)} >> Slick=${fmt(dampSlick, 3)}`,
  );
  check(
    'Heavy Standing Water (3.5 mm, inside 2.0–5.5 mm): Full Wet > Intermediate >> Slick',
    floodWet > floodInter + 0.18 && floodInter > floodSlick,
    `Wet=${fmt(floodWet, 3)} > Inter=${fmt(floodInter, 3)} >> Slick=${fmt(floodSlick, 3)}`,
  );

  // Intermediate overheating on bone-dry rubbered asphalt
  let interDry = createLc26CornerThermalState('intermediate', false);
  let interDamp = createLc26CornerThermalState('intermediate', false);
  for (let t = 0; t < 65; t += 0.05) {
    interDry = stepLc26CornerThermal(interDry, {
      dtS: 0.05,
      compound: 'intermediate',
      isRearAxle: false,
      fzN: 4900,
      speedMs: 62,
      slipAngleRad: 4.5 * DEG2RAD,
      slipRatio: 0.025,
      waterFilmMm: 0,
      trackTempC: 42,
    }).state;
    interDamp = stepLc26CornerThermal(interDamp, {
      dtS: 0.05,
      compound: 'intermediate',
      isRearAxle: false,
      fzN: 4900,
      speedMs: 62,
      slipAngleRad: 4.5 * DEG2RAD,
      slipRatio: 0.025,
      waterFilmMm: 0.9,
      trackTempC: 24,
    }).state;
  }
  const interDryEval = evaluateLc26CornerThermalGrip('intermediate', interDry);
  const interDampEval = evaluateLc26CornerThermalGrip('intermediate', interDamp, { waterFilmMm: 0.9 });
  check(
    'Intermediate overheats & degrades rapidly on bone-dry rubbered asphalt vs damp track',
    interDryEval.meanSurfaceC > LC26_INTERMEDIATE_SPEC.optimalWindowC[1] + 15 &&
      interDryEval.thermalGripMultiplier < interDampEval.thermalGripMultiplier - 0.06 &&
      interDry.remainingLife01 < interDamp.remainingLife01,
    `dry=${fmt(interDryEval.meanSurfaceC, 1)}°C (thMult=${fmt(interDryEval.thermalGripMultiplier, 3)}) vs damp=${fmt(interDampEval.meanSurfaceC, 1)}°C (${fmt(interDampEval.thermalGripMultiplier, 3)})`,
  );

  // Off-line wet-line vs dry-line crossover (`offRubberedLine01`)
  const dryOnLine = LC26_TYRES_MODULE.evaluateWetContact('soft', 55, 0.0, 0.0, false).wetGripMultiplier;
  const dryOffLine = LC26_TYRES_MODULE.evaluateWetContact('soft', 55, 0.0, 1.0, false).wetGripMultiplier;
  const wet04OnLine = LC26_TYRES_MODULE.evaluateWetContact('intermediate', 55, 0.4, 0.0, false).wetGripMultiplier;
  const wet04OffLine = LC26_TYRES_MODULE.evaluateWetContact('intermediate', 55, 0.4, 1.0, false).wetGripMultiplier;
  const wet12OnLine = LC26_TYRES_MODULE.evaluateWetContact('intermediate', 55, 1.2, 0.0, false).wetGripMultiplier;
  const wet12OffLine = LC26_TYRES_MODULE.evaluateWetContact('intermediate', 55, 1.2, 1.0, false).wetGripMultiplier;
  // Drying track: racing line cleared to 0.06 mm while off-line still holds 1.1 mm standing water
  const dryingLineCleared = LC26_TYRES_MODULE.evaluateWetContact('soft', 60, 0.06, 0.0, false).wetGripMultiplier;
  const dryingStayOffLine = LC26_TYRES_MODULE.evaluateWetContact('soft', 60, 1.1, 1.0, false).wetGripMultiplier;

  check(
    'Wet-line physics: off-line beats rubbered line when wet (> 0.3 mm); dry/drying line reverses',
    dryOnLine > dryOffLine &&
      wet04OffLine > wet04OnLine &&
      wet12OffLine > wet12OnLine &&
      dryingLineCleared > dryingStayOffLine * 3.0,
    `dry on=${fmt(dryOnLine, 3)}>off=${fmt(dryOffLine, 3)} | wet(1.2mm) off=${fmt(wet12OffLine, 3)}>on=${fmt(wet12OnLine, 3)} | drying line=${fmt(dryingLineCleared, 3)}>>off=${fmt(dryingStayOffLine, 3)}`,
  );
}

// ---------------------------------------------------------------------------
// 9. Live 6-DOF `VehiclePhysics` Integration Smoke Check
// ---------------------------------------------------------------------------
console.log('\n== 9. Live 6-DOF VehiclePhysics Solver Integration Smoke Check');
{
  const lc26TyreTestConfig = {
    ...F12026_CAR_CONFIG,
    screenName: 'VeloSoft LC-26 Tyre Bench',
    chassis: LC26_CHASSIS_DATA,
    tyreCompounds: {
      PhysicsTyreCompound_F1_Hard: LC26_TYRES_MODULE.compounds.hard[0],
      PhysicsTyreCompound_F1_Medium: LC26_TYRES_MODULE.compounds.medium[0],
      PhysicsTyreCompound_F1_Soft: LC26_TYRES_MODULE.compounds.soft[0],
      PhysicsTyreCompound_F1_Intermediate: LC26_TYRES_MODULE.compounds.intermediate[0],
      PhysicsTyreCompound_F1_Wet: LC26_TYRES_MODULE.compounds.wet[0],
    },
    compoundSlots: {
      hard: 'PhysicsTyreCompound_F1_Hard' as const,
      medium: 'PhysicsTyreCompound_F1_Medium' as const,
      soft: 'PhysicsTyreCompound_F1_Soft' as const,
      intermediate: 'PhysicsTyreCompound_F1_Intermediate' as const,
      wet: 'PhysicsTyreCompound_F1_Wet' as const,
    },
  };

  const dryCar = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: lc26TyreTestConfig,
    compound: 'PhysicsTyreCompound_F1_Soft',
  });
  dryCar.reset(0, 0, 0, 180 / 3.6);
  const startCoreTemps = dryCar.wheels.map((w) => w.coreTempC);

  for (let i = 0; i < 500; i++) {
    dryCar.step(0.002, { throttle: 0.45, brake: 0, steer: -0.08 });
  }

  const wetCar = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: lc26TyreTestConfig,
    compound: 'PhysicsTyreCompound_F1_Wet',
  });
  wetCar.waterMm = 2.6;
  wetCar.wetness = wetnessFromWater(2.6);
  wetCar.reset(0, 0, 0, 180 / 3.6);
  const wetStartCoreTemps = wetCar.wheels.map((w) => w.coreTempC);
  for (let i = 0; i < 500; i++) {
    wetCar.step(0.002, { throttle: 0.35, brake: 0, steer: -0.08 });
  }

  check(
    'VehiclePhysics initializes LC-26 70 °C slick & 37 °C unblanketed wet states cleanly with zero NaNs',
    startCoreTemps.every((t) => near(t, 70, 1e-6)) &&
      wetStartCoreTemps.every((t) => near(t, LC26_FULL_WET_SPEC.blanketPreheatC, 1e-6)) &&
      dryCar.wheels.every((w) => Number.isFinite(w.fy) && Number.isFinite(w.pressurePsi)) &&
      wetCar.wheels.every((w) => Number.isFinite(w.fy) && Number.isFinite(w.pressurePsi)) &&
      Math.abs(dryCar.telemetry.latG) > 1.2 &&
      Math.abs(wetCar.telemetry.latG) > 0.8 &&
      Object.keys(LC26_ALL_COMPOUND_SPECS).length === 7,
    `dryLatG=${fmt(Math.abs(dryCar.telemetry.latG), 2)}g, wetLatG=${fmt(Math.abs(wetCar.telemetry.latG), 2)}g`,
  );
}

console.log(
  failures.length === 0
    ? `\n100% GREEN: All ${passedCount} LC-26 tyre & wet-line verification checks passed.`
    : `\nFAILED ${failures.length} check(s):\n  - ${failures.join('\n  - ')}`,
);
if (failures.length > 0) {
  process.exitCode = 1;
}
