/**
 * Standalone Deterministic Verification Suite for Agent 3 (`active-aero`):
 * 3D Ride-Height Active Aero Maps, Ground-Effect Stall, Circuit Straight Mode
 * Zones & FIA Safety Interlocks for "VeloSoft LC-26" (`lc26-f1`).
 *
 * Run:
 *   node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify-lc26-aero.ts
 */

import {
  LC26_ACTIVE_AERO_HINGES,
  LC26_FIA_DATUM_PLANES,
  type Lc26AeroStepInput,
  type Lc26CoolingGillLevel,
} from '../src/lib/cars/lc26/contract-types';
import {
  buildLc26AeroData,
  evaluateLc26AeroElasticCompliance,
  evaluateLc26CleanRoomAeroSurface,
  evaluateLc26SmInterlock,
  evaluateLc26WakeEffect,
  LC26_AERO_MODULE,
  LC26_COOLING_GILL_SPECS,
} from '../src/lib/cars/lc26/aero';
import {
  detectGenericStraightModeZones,
  findActiveSmZone,
  getCircuitSmZones,
  isInStraightModeZone,
  isProgressInSmSegment,
  LC26_CIRCUIT_SM_ZONES,
  smSegmentLengthM,
  toLegacyDrsZones,
  type Lc26GenericTrackSample,
} from '../src/lib/cars/lc26/sm-zones';

let totalAssertions = 0;
let passedSections = 0;

function assert(condition: boolean, message: string): void {
  totalAssertions++;
  if (!condition) {
    throw new Error(`[FAIL] Assertion #${totalAssertions}: ${message}`);
  }
}

function assertNear(actual: number, expected: number, tol: number, label: string): void {
  totalAssertions++;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(
      `[FAIL] ${label}: expected ${expected.toFixed(5)} ± ${tol.toFixed(5)}, got ${actual}`,
    );
  }
}

function makeBaseInput(overrides: Partial<Lc26AeroStepInput> = {}): Lc26AeroStepInput {
  return {
    dtS: 0.002, // 500 Hz physics substep
    speedMs: 240 / 3.6,
    airDensityKgM3: 1.225,
    frontRideHeightM: 0.020,
    rearRideHeightM: 0.042,
    yawSlipRad: 0,
    rollRad: 0,
    steerRad: 0,
    driverRequestsStraightMode: false,
    inAuthorizedSmZone: false,
    brakePedal01: 0,
    throttlePedal01: 1.0,
    lateralG: 0,
    trackWetness01: 0,
    rearFlapAllowedInWet: true,
    actuatorFault: false,
    gapAheadSeconds: null,
    coolingGillLevel: 3,
    preset: 'balanced',
    frontWingTrimDeg: 0,
    rearWingTrimDeg: 0,
    ...overrides,
  };
}

function stepForDuration(
  initialState: ReturnType<typeof LC26_AERO_MODULE.createInitialState>,
  input: Lc26AeroStepInput,
  durationS: number,
  dtS = 0.002,
) {
  let flaps = initialState;
  let out = LC26_AERO_MODULE.stepAero(flaps, { ...input, dtS });
  const steps = Math.max(1, Math.round(durationS / dtS));
  for (let i = 0; i < steps; i++) {
    out = LC26_AERO_MODULE.stepAero(flaps, { ...input, dtS });
    flaps = out.flaps;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. 3D Clean-Room Surface & `AeroData` / `AeroRideHeightMap` Integrity
// ---------------------------------------------------------------------------
function verify3dRideHeightSurfaceAndAeroData(): void {
  for (let frhMm = 0; frhMm <= 95; frhMm += 5) {
    for (let rrhMm = 10; rrhMm <= 115; rrhMm += 7) {
      const pt = evaluateLc26CleanRoomAeroSurface(frhMm / 1000, rrhMm / 1000, 0.04, 0.02, 0.05);
      assert(Number.isFinite(pt.clATotalM2) && pt.clATotalM2 > 1.2, `Finite positive CL·A at (${frhMm},${rrhMm}) mm`);
      assert(Number.isFinite(pt.cdABaseM2) && pt.cdABaseM2 > 0.5, `Finite positive CD·A at (${frhMm},${rrhMm}) mm`);
      assert(
        pt.aeroBalanceFront01 > 0.25 && pt.aeroBalanceFront01 < 0.65,
        `Physical CoP at (${frhMm},${rrhMm}) mm: ${pt.aeroBalanceFront01}`,
      );
      assert(
        pt.floorStallFactor01 >= 0 && pt.floorStallFactor01 <= 1,
        `Bounded floorStallFactor01 at (${frhMm},${rrhMm}) mm`,
      );
    }
  }

  // Venturi ground-effect suction peak near optimal FRH (~17–19 mm) > static 32 mm > high 75 mm
  const highRide = evaluateLc26CleanRoomAeroSurface(0.075, 0.095);
  const staticRide = evaluateLc26CleanRoomAeroSurface(0.032, 0.058);
  const optimalRide = evaluateLc26CleanRoomAeroSurface(0.018, 0.042);
  assert(
    optimalRide.clATotalM2 > staticRide.clATotalM2 && staticRide.clATotalM2 > highRide.clATotalM2,
    `Venturi ground-effect suction peak ordering (${optimalRide.clATotalM2.toFixed(3)} > ${staticRide.clATotalM2.toFixed(3)} > ${highRide.clATotalM2.toFixed(3)})`,
  );

  // 3D Yaw, Roll & Steer symmetry and physical sign
  const zeroAtt = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, 0, 0, 0);
  const yawLeft = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, -0.10, 0, 0);
  const yawRight = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, +0.10, 0, 0);
  assertNear(yawLeft.clATotalM2, yawRight.clATotalM2, 1e-9, 'Symmetric yaw CL·A');
  assertNear(yawLeft.cdABaseM2, yawRight.cdABaseM2, 1e-9, 'Symmetric yaw CD·A');
  assert(yawRight.clATotalM2 < zeroAtt.clATotalM2 && yawRight.cdABaseM2 > zeroAtt.cdABaseM2, 'Yaw sheds floor seal & adds drag');

  const rollLeft = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, 0, -0.035, 0);
  const rollRight = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, 0, +0.035, 0);
  assertNear(rollLeft.clATotalM2, rollRight.clATotalM2, 1e-9, 'Symmetric roll CL·A');
  assert(rollRight.clATotalM2 < zeroAtt.clATotalM2, 'Roll raises windward floor edge & reduces suction');

  const steered = evaluateLc26CleanRoomAeroSurface(0.020, 0.042, 0, 0, 0.18);
  assert(steered.clATotalM2 < zeroAtt.clATotalM2 && steered.cdABaseM2 > zeroAtt.cdABaseM2, 'Steer wake trims CL & adds tyre wake drag');

  // Verify `AeroData` & `AeroRideHeightMap` consistency with FIA datum planes
  const aeroData = buildLc26AeroData();
  assertNear(aeroData.front_target_height, LC26_FIA_DATUM_PLANES.staticFrontRideHeightM, 1e-6, 'AeroData front_target_height');
  assertNear(aeroData.rear_target_height, LC26_FIA_DATUM_PLANES.staticRearRideHeightM, 1e-6, 'AeroData rear_target_height');
  assertNear(aeroData.drsCloseThrottle, 0.90, 1e-6, 'AeroData drsCloseThrottle = 0.90');
  assert(aeroData.drsTransitionS <= 0.40, 'AeroData drsTransitionS <= 400 ms');
  assert(Boolean(aeroData.rhMap), 'AeroData includes populated 2D/3D rhMap');
  const rhMap = aeroData.rhMap!;
  assert(rhMap.cl.length === rhMap.rearRh.length && rhMap.cl[0].length === rhMap.frontRh.length, 'rhMap matrix dimensions match axes');
  assert(rhMap.rollCl[0][0] < 0 && rhMap.rollCl[rhMap.rollCl.length - 1][0] > 0, 'Signed symmetric roll LUT');
  assert(rhMap.yawCl[0][0] < 0 && rhMap.yawCl[rhMap.yawCl.length - 1][0] > 0, 'Signed symmetric yaw LUT');

  passedSections++;
  console.log('  [PASS] 1. 3D ride-height & attitude surface (FRH x RRH x Yaw x Roll x Steer) + AeroData');
}

// ---------------------------------------------------------------------------
// 2. Floor Vortex Stall (`FRH < 4 mm`) & Excessive Rake Diffuser Separation
// ---------------------------------------------------------------------------
function verifyFloorStallAndDiffuserSeparation(): void {
  const attached18mm = evaluateLc26CleanRoomAeroSurface(0.018, 0.040);
  const threshold4mm = evaluateLc26CleanRoomAeroSurface(0.004, 0.036);
  const stall3mm = evaluateLc26CleanRoomAeroSurface(0.003, 0.036);
  const stall2mm = evaluateLc26CleanRoomAeroSurface(0.002, 0.036);
  const stall1mm = evaluateLc26CleanRoomAeroSurface(0.001, 0.036);

  assert(attached18mm.floorStallFactor01 === 0, 'Zero floor stall at nominal 18 mm FRH');
  assert(
    stall3mm.floorStallFactor01 > threshold4mm.floorStallFactor01 &&
      stall2mm.floorStallFactor01 > stall3mm.floorStallFactor01 &&
      stall1mm.floorStallFactor01 > stall2mm.floorStallFactor01,
    'Progressive floor stall increases monotonically below FRH < 4 mm (0.004 m)',
  );
  assert(stall2mm.floorStallFactor01 > 0.60, `Substantial vortex burst at FRH = 2 mm (${stall2mm.floorStallFactor01.toFixed(3)})`);
  assert(stall1mm.floorStallFactor01 > 0.90, `Deep floor choke at FRH = 1 mm (${stall1mm.floorStallFactor01.toFixed(3)})`);
  assert(
    stall1mm.clATotalM2 < 0.78 * attached18mm.clATotalM2,
    `Bottoming stall sheds >22% total downforce (${stall1mm.clATotalM2.toFixed(3)} vs ${attached18mm.clATotalM2.toFixed(3)} m²)`,
  );

  // Excessive pitch/rake diffuser separation on flatter 2026 diffuser
  const excessiveRake = evaluateLc26CleanRoomAeroSurface(0.012, 0.105);
  assert(
    excessiveRake.floorStallFactor01 > 0.65 && excessiveRake.clATotalM2 < 0.78 * attached18mm.clATotalM2,
    `Excessive rake separates flatter 2026 diffuser (stall=${excessiveRake.floorStallFactor01.toFixed(3)})`,
  );
  assert(
    excessiveRake.aeroBalanceFront01 > attached18mm.aeroBalanceFront01 + 0.03,
    'Rear diffuser separation shifts CoP forward realistically',
  );

  passedSections++;
  console.log('  [PASS] 2. Ground-effect venturi floor stall (FRH < 4 mm) & excessive-rake diffuser separation');
}

// ---------------------------------------------------------------------------
// 3. `240 km/h` Corner Mode CoP (~1.5% behind static CoG) & Straight Mode `< 1.5%` Shift
// ---------------------------------------------------------------------------
function verifyCornerAndStraightModeBalanceAndSpeedTrap(): void {
  // Static front weight is 0.460 -> target CoP at 240 km/h is ~0.445 (1.5% rearward)
  const cm240StaticRh = LC26_AERO_MODULE.stepAero(
    LC26_AERO_MODULE.createInitialState(),
    makeBaseInput({
      speedMs: 240 / 3.6,
      frontRideHeightM: LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
      rearRideHeightM: LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
    }),
  );
  const cm240DynamicRh = LC26_AERO_MODULE.stepAero(
    LC26_AERO_MODULE.createInitialState(),
    makeBaseInput({
      speedMs: 240 / 3.6,
      frontRideHeightM: 0.020,
      rearRideHeightM: 0.042,
    }),
  );

  assertNear(cm240StaticRh.aeroBalanceFront01, 0.445, 0.005, '240 km/h Corner Mode CoP at static datum RH (~44.5% front)');
  assertNear(cm240DynamicRh.aeroBalanceFront01, 0.445, 0.005, '240 km/h Corner Mode CoP at settled 240 km/h RH (~44.5% front)');

  // Slew rate <= 400 ms and exact hinge target angles in Straight Mode
  let state = LC26_AERO_MODULE.createInitialState();
  const smInput = makeBaseInput({
    speedMs: 300 / 3.6,
    inAuthorizedSmZone: true,
    driverRequestsStraightMode: true,
    throttlePedal01: 1.0,
    brakePedal01: 0,
  });

  // Step 200 * 2 ms = 400.0 ms
  for (let i = 0; i < 200; i++) {
    const stepOut = LC26_AERO_MODULE.stepAero(state, smInput);
    // Verify < 1.5% balance shift at EVERY intermediate millisecond during the transition!
    assert(
      Math.abs(stepOut.aeroBalanceFront01 - cm240DynamicRh.aeroBalanceFront01) < 0.015,
      `Mid-transition step ${i} balance shift < 1.5%`,
    );
    state = stepOut.flaps;
  }
  assert(state.mode === 'straight-mode', 'Entered straight-mode');
  assertNear(state.smProgress01, 1.0, 1e-6, '100% Straight Mode reached within <= 400 ms');
  assertNear(state.fwFlap2Deg, LC26_ACTIVE_AERO_HINGES.fwFlap2.straightModeAngleDeg, 1e-6, 'fw_flap_2 = -9.5 deg');
  assertNear(state.fwFlap3Deg, LC26_ACTIVE_AERO_HINGES.fwFlap3.straightModeAngleDeg, 1e-6, 'fw_flap_3 = -16.5 deg');
  assertNear(state.rwFlap2Deg, LC26_ACTIVE_AERO_HINGES.rwFlap2.straightModeAngleDeg, 1e-6, 'rw_flap_2 = -12.0 deg');
  assertNear(state.rwFlap3Deg, LC26_ACTIVE_AERO_HINGES.rwFlap3.straightModeAngleDeg, 1e-6, 'rw_flap_3 = -19.0 deg');

  // Sweep 200..355 km/h across all presets: |aeroBalanceFront01(SM) - aeroBalanceFront01(CM)| < 0.015 (< 1.5%)
  const presets = ['low_downforce', 'balanced', 'high_downforce'] as const;
  let maxBalDelta = 0;
  for (const preset of presets) {
    for (let kmh = 200; kmh <= 355; kmh += 5) {
      const cmOut = LC26_AERO_MODULE.stepAero(
        LC26_AERO_MODULE.createInitialState(),
        makeBaseInput({ speedMs: kmh / 3.6, preset }),
      );
      const smOut = LC26_AERO_MODULE.stepAero(
        state,
        makeBaseInput({
          speedMs: kmh / 3.6,
          preset,
          inAuthorizedSmZone: true,
          driverRequestsStraightMode: true,
          throttlePedal01: 1.0,
        }),
      );
      const delta = Math.abs(smOut.aeroBalanceFront01 - cmOut.aeroBalanceFront01);
      if (delta > maxBalDelta) maxBalDelta = delta;
      assert(
        delta < 0.015,
        `SM vs CM balance delta (${delta.toFixed(5)}) < 0.015 at ${kmh} km/h (${preset})`,
      );
      assert(
        smOut.totalDragN < 0.63 * cmOut.totalDragN,
        `Sharp SM drag reduction (>37% off CM) at ${kmh} km/h (${preset})`,
      );
    }
  }

  // 1D Straight-Line Speed Trap Simulation (1000 m Monza Rettifilo from 175 km/h corner exit):
  // 400 kW ICE + FIA C5.2.8 tapering 350 kW MGU-K (`P_mguk_kW = clamp(1800 - 5*v_kmh, 0, 350)`)
  let vMs = 175 / 3.6;
  let distM = 0;
  const massKg = 798; // 768 kg dry + 30 kg race fuel
  const dt = 0.005;
  let smFlaps = state;
  while (distM < 1050) {
    const vKmh = vMs * 3.6;
    const aero = LC26_AERO_MODULE.stepAero(
      smFlaps,
      makeBaseInput({
        dtS: dt,
        speedMs: vMs,
        frontRideHeightM: 0.016,
        rearRideHeightM: 0.036,
        inAuthorizedSmZone: true,
        driverRequestsStraightMode: true,
        throttlePedal01: 1.0,
      }),
    );
    smFlaps = aero.flaps;
    const pIceW = 400_000;
    const pMgukW = vKmh < 290 ? 350_000 : vKmh < 340 ? (1800 - 5 * vKmh) * 1000 : vKmh < 345 ? (6900 - 20 * vKmh) * 1000 : 0;
    const wheelDriveForceN = ((pIceW + Math.max(0, pMgukW)) * 0.94) / Math.max(vMs, 10);
    const rollingResN = 0.0135 * (massKg * 9.81 + aero.totalDownforceN);
    const accelMs2 = (wheelDriveForceN - aero.totalDragN - rollingResN) / massKg;
    vMs += accelMs2 * dt;
    distM += vMs * dt;
  }
  const trapKmh = vMs * 3.6;
  assert(
    trapKmh >= 325 && trapKmh <= 350,
    `Realistic 2026 Straight Mode speed trap (${trapKmh.toFixed(1)} km/h inside [325, 350] km/h)`,
  );

  passedSections++;
  console.log(
    `  [PASS] 3. 240 km/h CoP=${cm240DynamicRh.aeroBalanceFront01.toFixed(4)}, max SM balance shift=${(maxBalDelta * 100).toFixed(2)}% (<1.5%), trap=${trapKmh.toFixed(1)} km/h`,
  );
}

// ---------------------------------------------------------------------------
// 4. Wet Partial Mode (`partial-wet-fw-only`), Cooling Gills `1..5`, Flex & Wake
// ---------------------------------------------------------------------------
function verifyWetPartialCoolingElasticAndWake(): void {
  const dryCm = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    makeBaseInput({ speedMs: 270 / 3.6 }),
    0.45,
  );
  const drySm = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    makeBaseInput({
      speedMs: 270 / 3.6,
      inAuthorizedSmZone: true,
      driverRequestsStraightMode: true,
      throttlePedal01: 1.0,
    }),
    0.45,
  );

  // Case A: Inter/Wet tyre lockout (`rearFlapAllowedInWet = false` even on drying line)
  const wetTyrePartial = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    makeBaseInput({
      speedMs: 270 / 3.6,
      inAuthorizedSmZone: true,
      driverRequestsStraightMode: true,
      throttlePedal01: 1.0,
      rearFlapAllowedInWet: false,
      trackWetness01: 0.10,
    }),
    0.45,
  );
  assert(wetTyrePartial.flaps.mode === 'partial-wet-fw-only', 'Wet tyre compound triggers partial-wet-fw-only');
  assertNear(wetTyrePartial.flaps.fwFlap2Deg, -9.5, 1e-5, 'Wet partial opens fw_flap_2');
  assertNear(wetTyrePartial.flaps.fwFlap3Deg, -16.5, 1e-5, 'Wet partial opens fw_flap_3');
  assertNear(wetTyrePartial.flaps.rwFlap2Deg, 0.0, 1e-5, 'Wet partial locks rw_flap_2 at 0 deg');
  assertNear(wetTyrePartial.flaps.rwFlap3Deg, 0.0, 1e-5, 'Wet partial locks rw_flap_3 at 0 deg');
  assert(
    wetTyrePartial.totalDragN < dryCm.totalDragN && wetTyrePartial.totalDragN > drySm.totalDragN,
    'Wet partial drag sits strictly between Corner Mode and full dry Straight Mode',
  );
  assert(
    wetTyrePartial.aeroBalanceFront01 < dryCm.aeroBalanceFront01,
    'Wet partial shifts CoP rearward to keep rear axle planted on standing water',
  );

  // Case B: High water film (`trackWetness01 >= 0.25`) even if `rearFlapAllowedInWet = true`
  const wetFilmPartial = stepForDuration(
    drySm.flaps,
    makeBaseInput({
      speedMs: 270 / 3.6,
      inAuthorizedSmZone: true,
      driverRequestsStraightMode: true,
      throttlePedal01: 1.0,
      rearFlapAllowedInWet: true,
      trackWetness01: 0.42,
    }),
    0.40,
  );
  assert(wetFilmPartial.flaps.mode === 'partial-wet-fw-only', 'Standing water film triggers partial-wet-fw-only');
  assertNear(wetFilmPartial.flaps.rwFlap3Deg, 0.0, 1e-5, 'Rear flap closes within <= 400 ms upon hitting wet patch');

  // Cooling Gills `1..5` monotonic drag & heat rejection (`0.88..1.16`)
  const gillLevels: readonly Lc26CoolingGillLevel[] = [1, 2, 3, 4, 5];
  let prevDrag = -Infinity;
  let prevReject = -Infinity;
  for (const level of gillLevels) {
    const out = LC26_AERO_MODULE.stepAero(
      LC26_AERO_MODULE.createInitialState(),
      makeBaseInput({ speedMs: 280 / 3.6, coolingGillLevel: level }),
    );
    assert(out.totalDragN > prevDrag, `Cooling gill level ${level} increases drag monotonically`);
    assert(out.coolingRejectMultiplier > prevReject, `Cooling gill level ${level} increases heat rejection monotonically`);
    prevDrag = out.totalDragN;
    prevReject = out.coolingRejectMultiplier;
  }
  assertNear(LC26_COOLING_GILL_SPECS[1].coolingRejectMultiplier, 0.88, 0.01, 'Gill level 1 reject ~0.88');
  assertNear(LC26_COOLING_GILL_SPECS[5].coolingRejectMultiplier, 1.16, 0.01, 'Gill level 5 reject ~1.16');

  // High-q Aero-Elastic Trailing-Edge Compliance above `280 km/h`
  const q260 = 0.5 * 1.225 * (260 / 3.6) ** 2;
  const q345 = 0.5 * 1.225 * (345 / 3.6) ** 2;
  const flex260 = evaluateLc26AeroElasticCompliance(q260, 0, 0);
  const flex345 = evaluateLc26AeroElasticCompliance(q345, 0, 0);
  assert(flex260.compliance01 === 0, 'Zero aero-elastic bleed below 280 km/h');
  assert(flex345.compliance01 > 0.5 && flex345.dCdAM2 < -0.015, 'Active high-q trailing-edge drag bleed at 345 km/h');

  // 2026 Improved Dirty-Air Wake (`gapAheadSeconds`)
  const wakeClean = evaluateLc26WakeEffect(null);
  const wake04s = evaluateLc26WakeEffect(0.4);
  const wake12s = evaluateLc26WakeEffect(1.2);
  const wake35s = evaluateLc26WakeEffect(3.5);
  assertNear(wakeClean.wakeRetention01, 1.0, 1e-9, 'Clean air wakeRetention01 = 1.0');
  assertNear(wake35s.wakeRetention01, 1.0, 1e-9, 'Far gap (3.5 s) wakeRetention01 = 1.0');
  assert(
    wake04s.wakeRetention01 > 0.82 && wake04s.wakeRetention01 < wake12s.wakeRetention01 && wake12s.wakeRetention01 < 1.0,
    `2026 wake curve retains >82% downforce at 0.4 s (${wake04s.wakeRetention01.toFixed(3)}) and recovers monotonically`,
  );
  assert(wake04s.dragWakeMultiplier < 0.94, 'Dirty-air wake also provides slipstream drag tow');

  passedSections++;
  console.log('  [PASS] 4. Wet Partial Mode, cooling gills 1..5 (0.88..1.16), aero-elastic flex & 2026 wake');
}

// ---------------------------------------------------------------------------
// 5. All Circuit Straight Mode Zones & Generic Fallback Detector
// ---------------------------------------------------------------------------
function verifyCircuitStraightModeZones(): void {
  const requiredCircuits = [
    'monza',
    'silverstone',
    'spa',
    'suzuka',
    'marina_bay',
    'yas_marina',
    'spielberg',
  ];

  for (const id of requiredCircuits) {
    const table = getCircuitSmZones(id);
    assert(table !== null, `Circuit SM zone table exists for ${id}`);
    assert(table!.zones.length >= 3, `${id} has >= 3 2026 Straight Mode zones (got ${table!.zones.length})`);
    for (const seg of table!.zones) {
      const lenM = smSegmentLengthM(seg, table!.trackLengthM);
      assert(lenM >= 180 && lenM <= 1500, `${id} zone ${seg.zoneId} has realistic length (${lenM.toFixed(0)} m)`);
      assert(seg.minActivationSpeedKmh >= 150 && seg.minActivationSpeedKmh <= 220, `${id} minActivationSpeedKmh valid`);
      assert(seg.maxLateralG >= 1.0 && seg.maxLateralG <= 1.6, `${id} maxLateralG valid`);
    }
    const legacy = toLegacyDrsZones(table!);
    assert(legacy.length === table!.zones.length, `toLegacyDrsZones maps all ${id} zones`);
  }

  // Alias lookup (`red_bull_ring` -> `spielberg`)
  assert(getCircuitSmZones('red_bull_ring')?.circuitId === 'spielberg', 'Alias red_bull_ring resolves to spielberg');
  assert(Object.keys(LC26_CIRCUIT_SM_ZONES).length >= 22, 'Covers all 22 LibreCorsa circuits');

  // Wrap-around start/finish straight check on Monza (`0.895 .. 0.084`)
  assert(isInStraightModeZone('monza', 0.95, 290, 0.2) === true, 'Monza S/F wrap-around before line (0.95) active');
  assert(isInStraightModeZone('monza', 0.03, 325, 0.1) === true, 'Monza S/F wrap-around after line (0.03) active');
  assert(isInStraightModeZone('monza', 0.11, 90, 1.8) === false, 'Monza T1 Rettifilo chicane (0.11) inactive');
  assert(isInStraightModeZone('monza', 0.95, 130, 0.1) === false, 'Monza S/F below min speed (130 km/h) inactive');
  assert(isInStraightModeZone('monza', 0.95, 260, 1.55) === false, 'Monza S/F above maxLateralG (1.55 g) inactive');
  assert(isProgressInSmSegment(1.02, { startProgress01: 0.92, endProgress01: 0.05 }) === true, 'Progress > 1 wraps cleanly');
  assert(isProgressInSmSegment(-0.03, { startProgress01: 0.92, endProgress01: 0.05 }) === true, 'Negative progress wraps cleanly');

  // Generic curvature + braking-zone fallback straight detector on synthetic 4000 m circuit
  const n = 400;
  const syntheticSamples: Lc26GenericTrackSample[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // Two long straights: wrap-around [0.90..0.12] and back straight [0.40..0.62]
    const onStraightA = t >= 0.90 || t <= 0.12;
    const onStraightB = t >= 0.40 && t <= 0.62;
    const heavyBraking = (t > 0.10 && t <= 0.14) || (t > 0.60 && t <= 0.64);
    syntheticSamples.push({
      t,
      s: t * 4000,
      curvature: onStraightA || onStraightB ? 0.0004 : 0.018,
      brakingZone: heavyBraking ? 1 : 0,
    });
  }
  const detected = detectGenericStraightModeZones('custom_gp_test', 4000, syntheticSamples);
  assert(detected.zones.length === 2, `Generic detector found exact 2 straights (got ${detected.zones.length})`);
  assert(
    findActiveSmZone('unknown_procedural_track', 0.50, syntheticSamples, 4000) !== null,
    'findActiveSmZone uses generic fallback detector for unknown circuits',
  );
  assert(
    isInStraightModeZone('unknown_procedural_track', 0.50, 240, 0.3, syntheticSamples, 4000) === true,
    'isInStraightModeZone activates via generic fallback on back straight',
  );
  assert(
    isInStraightModeZone('unknown_procedural_track', 0.25, 240, 2.2, syntheticSamples, 4000) === false,
    'isInStraightModeZone rejects high-curvature corner on unknown circuit',
  );

  passedSections++;
  console.log('  [PASS] 5. All 22 LibreCorsa circuit Straight Mode zones + generic curvature straight detector');
}

// ---------------------------------------------------------------------------
// 6. Exact FIA Safety Interlocks & NON-NEGOTIABLE Super-Clipping Invariant
// ---------------------------------------------------------------------------
function verifyFiaSafetyInterlocksAndSuperClipping(): void {
  const openReadyInput = makeBaseInput({
    speedMs: 320 / 3.6,
    inAuthorizedSmZone: true,
    driverRequestsStraightMode: true,
    throttlePedal01: 1.0,
    brakePedal01: 0.0,
    lateralG: 0.15,
  });

  // Open Straight Mode fully (<= 400 ms)
  const fullyOpen = stepForDuration(LC26_AERO_MODULE.createInitialState(), openReadyInput, 0.40);
  assert(fullyOpen.flaps.mode === 'straight-mode' && fullyOpen.flaps.smProgress01 === 1.0, 'SM opens fully in <= 400 ms');

  // Interlock A: Denied outside authorized SM zone
  const outsideZone = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    { ...openReadyInput, inAuthorizedSmZone: false },
    0.40,
  );
  assert(outsideZone.flaps.mode === 'corner-mode' && outsideZone.flaps.smProgress01 === 0, 'SM denied outside SM zone');

  // Interlock B: Strict `throttlePedal01 > 0.90` boundary (`0.90` stays closed, `0.905` opens)
  const at90Pct = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    { ...openReadyInput, throttlePedal01: 0.90 },
    0.40,
  );
  assert(at90Pct.flaps.mode === 'corner-mode' && at90Pct.flaps.smProgress01 === 0, 'throttlePedal01 === 0.90 stays closed');
  const at905Pct = stepForDuration(
    LC26_AERO_MODULE.createInitialState(),
    { ...openReadyInput, throttlePedal01: 0.905 },
    0.40,
  );
  assert(at905Pct.flaps.mode === 'straight-mode' && at905Pct.flaps.smProgress01 === 1.0, 'throttlePedal01 === 0.905 opens SM');

  // Interlock C: Immediate snap-back (`<= 400 ms`) upon brake application (`brakePedal01 > 0.01`)
  const brakeSnap = stepForDuration(fullyOpen.flaps, { ...openReadyInput, brakePedal01: 0.02 }, 0.35);
  assert(
    brakeSnap.flaps.mode === 'corner-mode' && brakeSnap.flaps.smProgress01 === 0 && brakeSnap.flaps.rwFlap3Deg === 0,
    'Brake application (brakePedal01 = 0.02 > 0.01) snaps flaps shut within <= 400 ms',
  );

  // Interlock D: Immediate snap-back (`<= 400 ms`) upon manual throttle lift (`throttlePedal01 <= 0.90`)
  const liftSnap = stepForDuration(fullyOpen.flaps, { ...openReadyInput, throttlePedal01: 0.88 }, 0.35);
  assert(
    liftSnap.flaps.mode === 'corner-mode' && liftSnap.flaps.smProgress01 === 0 && liftSnap.flaps.fwFlap3Deg === 0,
    'Manual throttle lift (throttlePedal01 = 0.88 <= 0.90) snaps flaps shut within <= 400 ms',
  );

  // Interlock E: Immediate snap-back (`<= 400 ms`) on leaving SM zone
  const exitZoneSnap = stepForDuration(fullyOpen.flaps, { ...openReadyInput, inAuthorizedSmZone: false }, 0.35);
  assert(exitZoneSnap.flaps.mode === 'corner-mode' && exitZoneSnap.flaps.smProgress01 === 0, 'Zone exit snaps shut <= 400 ms');

  // Interlock F: Actuator fault -> `failsafe-corner` within `<= 400 ms`
  const faultSnap = stepForDuration(fullyOpen.flaps, { ...openReadyInput, actuatorFault: true }, 0.30);
  assert(
    faultSnap.flaps.mode === 'failsafe-corner' && faultSnap.flaps.smProgress01 === 0,
    'Actuator fault snaps to failsafe-corner within <= 400 ms',
  );

  // =========================================================================
  // NON-NEGOTIABLE INVARIANT: ECU Super Clipping at 100% Driver Throttle
  // =========================================================================
  // At 335–345 km/h end-of-straight, the driver holds 100% throttle (`throttlePedal01 === 1.0`)
  // while the 2026 ECU harvests `-250 kW` to `-350 kW` on the MGU-K (causing net rear wheel
  // torque to drop sharply or even become slightly negative relative to drag).
  // Straight Mode MUST remain 100% OPEN throughout!
  let superClipFlaps = fullyOpen.flaps;
  for (const mgukHarvestKw of [-250, -300, -350]) {
    const decision = evaluateLc26SmInterlock(
      {
        speedMs: 338 / 3.6,
        driverRequestsStraightMode: true,
        inAuthorizedSmZone: true,
        brakePedal01: 0.0,
        throttlePedal01: 1.0, // Driver foot flat on the floor!
        lateralG: 0.08,
        trackWetness01: 0.0,
        rearFlapAllowedInWet: true,
        actuatorFault: false,
      },
      { mgukPowerKw: mgukHarvestKw, netWheelTorqueNm: -180 },
    );
    assert(
      decision.targetMode === 'straight-mode' && decision.targetFwOpen01 === 1 && decision.targetRwOpen01 === 1,
      `Super Clipping (${mgukHarvestKw} kW MGU-K harvest at 100% throttle) keeps targetMode = straight-mode`,
    );

    const stepOut = stepForDuration(
      superClipFlaps,
      makeBaseInput({
        speedMs: 338 / 3.6,
        inAuthorizedSmZone: true,
        driverRequestsStraightMode: true,
        throttlePedal01: 1.0,
        brakePedal01: 0.0,
      }),
      0.50,
    );
    superClipFlaps = stepOut.flaps;
    assert(
      stepOut.flaps.mode === 'straight-mode' &&
        stepOut.flaps.smProgress01 === 1.0 &&
        stepOut.flaps.fwFlap3Deg === -16.5 &&
        stepOut.flaps.rwFlap3Deg === -19.0,
      `Super Clipping (${mgukHarvestKw} kW) keeps Straight Mode 100% OPEN across 0.5 s @ 500 Hz`,
    );
  }

  passedSections++;
  console.log('  [PASS] 6. All FIA safety interlocks + ECU Super-Clipping @ 100% throttle keeps SM OPEN');
}

function main(): void {
  console.log('=== VeloSoft LC-26 Active Aero & Track SM Zones Verification ===');
  verify3dRideHeightSurfaceAndAeroData();
  verifyFloorStallAndDiffuserSeparation();
  verifyCornerAndStraightModeBalanceAndSpeedTrap();
  verifyWetPartialCoolingElasticAndWake();
  verifyCircuitStraightModeZones();
  verifyFiaSafetyInterlocksAndSuperClipping();
  console.log(
    `=== ALL ${passedSections}/6 SECTIONS PASSED (${totalAssertions} deterministic assertions green) ===`,
  );
}

main();
