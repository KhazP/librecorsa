/**
 * Exhaustive Clean-Room Verification Suite for VeloSoft LC-26 (`lc26-f1`)
 * 2026 50/50 Hybrid Powertrain, Super Clipping, Overtake Mode, BBW & 8-Speed ECU.
 *
 * Run:
 *   node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify-lc26-powertrain.ts
 */

import {
  LC26_CHASSIS_DATA,
  LC26_FIA_POWERTRAIN_LIMITS,
} from '../src/lib/cars/lc26/contract-types';
import {
  applyGarageSetupToLc26Powertrain,
  computeLc26FiaFuelFlowCap,
  computeLc26FiaMgukPowerCapKw,
  computeLc26RoadCoupledRpm,
  createLc26PowertrainModule,
  DEFAULT_LC26_BBW_PARAMS,
  evaluateCleanRoomIceSteadyPowerKw,
  evaluateCleanRoomMgukCrankTorqueCapNm,
  LC26_BRAKES_DATA,
  LC26_CLUTCH_DATA,
  LC26_DIFFERENTIAL_DATA,
  LC26_ENGINE_DATA,
  LC26_ERS_DATA,
  LC26_GEARBOX_DATA,
  LC26_PERFORMANCE_MODES,
  LC26_POWERTRAIN_MODULE,
  Lc26EcuController,
  solveLc26BrakeByWire,
  solveLc26Differential,
} from '../src/lib/cars/lc26/powertrain';
import {
  compoundData,
  F12026_CAR_CONFIG,
  type CarPhysicsConfig,
} from '../src/lib/sim/f12026-car/F12026CarConfig';
import { FlatGroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';

const DT_500HZ = 1 / 500; // 0.002 s

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`${status}  ${name.padEnd(72)} ${detail}`);
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` (${detail})` : ''}`);
  }
}

const fmt = (n: number, digits = 2): string => n.toFixed(digits);

// ============================================================================
// 1. MGU-H-Free 1.6L 90° V6 ICE & FIA C5.4.3 Sustainable Fuel Mass Model (kg)
// ============================================================================
console.log('\n=== 1. 1.6L 90° V6 ICE Thermodynamics & FIA C5.4.3 Fuel Energy/Mass Cap ===');
{
  let peakKw = 0;
  let peakRpm = 0;
  for (let rpm = 3800; rpm <= 15000; rpm += 25) {
    const p = evaluateCleanRoomIceSteadyPowerKw(rpm);
    if (p > peakKw) {
      peakKw = p;
      peakRpm = rpm;
    }
  }
  const peakHp = peakKw * 1.341022;
  check(
    'ICE peak crank power sits inside ~400–405 kW (~536–543 hp)',
    peakKw >= 400.0 && peakKw <= 405.5,
    `peak=${fmt(peakKw, 2)} kW (${fmt(peakHp, 1)} hp) @ ${peakRpm} RPM`,
  );

  const p10300 = evaluateCleanRoomIceSteadyPowerKw(10300);
  const p11850 = evaluateCleanRoomIceSteadyPowerKw(11850);
  const p13500 = evaluateCleanRoomIceSteadyPowerKw(13500);
  check(
    'Optimal upshift window sits in 11,600–12,200 RPM (rolls off past 12.2k up to 15k ceiling)',
    LC26_GEARBOX_DATA.gears.upshift_rpm >= 11600 &&
      LC26_GEARBOX_DATA.gears.upshift_rpm <= 12200 &&
      LC26_GEARBOX_DATA.gears.redline_rpm === 12200 &&
      p11850 > 392 &&
      p10300 > 390 &&
      p13500 < p11850 - 30,
    `upshift=${LC26_GEARBOX_DATA.gears.upshift_rpm} RPM, P(10.3k)=${fmt(p10300)} kW, P(11.85k)=${fmt(p11850)} kW, P(13.5k)=${fmt(p13500)} kW`,
  );

  // FIA Article C5.12.2: torque slope >= -0.045 Nm/rpm above 4,000 RPM
  let minTorqueSlope = Infinity;
  for (let rpm = 4050; rpm <= 15000; rpm += 50) {
    const t0 = (evaluateCleanRoomIceSteadyPowerKw(rpm - 50) * 1000) / ((rpm - 50) * (Math.PI / 30));
    const t1 = (evaluateCleanRoomIceSteadyPowerKw(rpm) * 1000) / (rpm * (Math.PI / 30));
    minTorqueSlope = Math.min(minTorqueSlope, (t1 - t0) / 50);
  }
  check(
    'FIA C5.12.2 torque gradient >= -0.045 Nm/rpm across 4,000..15,000 RPM',
    minTorqueSlope >= -0.045,
    `minSlope=${fmt(minTorqueSlope, 4)} Nm/rpm`,
  );

  // Exact FIA C5.4.3 / C5.2.3-4 fuel energy flow formula
  const f6000 = LC26_POWERTRAIN_MODULE.computeFiaFuelFlowCap(6000);
  const f10499 = LC26_POWERTRAIN_MODULE.computeFiaFuelFlowCap(10499);
  const f10500 = LC26_POWERTRAIN_MODULE.computeFiaFuelFlowCap(10500);
  const f12200 = LC26_POWERTRAIN_MODULE.computeFiaFuelFlowCap(12200);
  const expected6000 = 0.27 * 6000 + 165; // 1785 MJ/h
  const expectedMassAt3000 = 3000 / (43.5 * 3600); // 0.019157088 kg/s
  check(
    'FIA C5.4.3 fuel energy cap: (0.27*rpm + 165) < 10,500 RPM and 3000 MJ/h >= 10,500 RPM',
    Math.abs(f6000.maxEnergyMjH - expected6000) < 1e-9 &&
      f10499.maxEnergyMjH < 3000 &&
      Math.abs(f10500.maxEnergyMjH - 3000) < 1e-9 &&
      Math.abs(f12200.maxEnergyMjH - 3000) < 1e-9 &&
      Math.abs(f10500.maxMassKgS - expectedMassAt3000) < 1e-9,
    `6k=${fmt(f6000.maxEnergyMjH, 1)} MJ/h, 10.5k=${fmt(f10500.maxEnergyMjH, 1)} MJ/h (${fmt(f10500.maxMassKgS * 3600, 2)} kg/h @ 43.5 MJ/kg)`,
  );

  // Fuel mass consumption strictly in kg + empty-tank flameout
  const ecu = new Lc26EcuController({ initialFuelKg: 0.015, initialGear: 7, initialRpm: 11200 });
  let maxObservedMjH = 0;
  let burnedToZero = false;
  let postEmptyIcePower = 0;
  for (let i = 0; i < 1200; i++) {
    const stepOut = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 300,
      externalRpmOverride: 11200,
    });
    maxObservedMjH = Math.max(maxObservedMjH, stepOut.telemetry.fuelEnergyFlowMjH);
    if (stepOut.state.fuelMassKg === 0) {
      burnedToZero = true;
      postEmptyIcePower = stepOut.telemetry.icePowerKw;
    }
  }
  check(
    'Fuel mass tracked strictly in kg, never exceeds 3000 MJ/h, and cuts ICE at 0.0 kg',
    burnedToZero &&
      maxObservedMjH <= 3000.0 + 1e-6 &&
      Math.abs(ecu.state.fuelConsumedKg - 0.015) < 1e-6 &&
      postEmptyIcePower <= 0,
    `maxFlow=${fmt(maxObservedMjH, 1)} MJ/h, consumed=${fmt(ecu.state.fuelConsumedKg, 4)} kg, postEmptyIce=${fmt(postEmptyIcePower, 2)} kW`,
  );
}

// ============================================================================
// 2. Physical MGU-H-Free Turbo Inertia, Wastegate (<= 4.8 barA) & MGU-K Torque-Fill
// ============================================================================
console.log('\n=== 2. Physical Turbo Lag (<= 4.8 barA) & Low-RPM MGU-K Anti-Lag Torque-Fill ===');
{
  const ecu = new Lc26EcuController({ initialFuelKg: 50, initialSoc01: 0.85, initialGear: 3, initialRpm: 6800 });
  // Coast off-throttle for 0.5 s into corner apex so turbo shaft spins down
  for (let i = 0; i < 250; i++) {
    ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 0,
      brakePedal01: 0,
      speedKmh: 115,
      externalRpmOverride: 6800,
    });
  }
  const apexShaftRadS = ecu.state.turboShaftRadS;
  const apexBoostBarA = ecu.state.boostPressureBarA;

  // Snap to 100% throttle on corner exit at 6,800 RPM
  let early40msOut = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 115,
    deployMode: 'RAC',
    externalRpmOverride: 6800,
  });
  for (let i = 1; i < 20; i++) {
    early40msOut = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 116,
      deployMode: 'RAC',
      externalRpmOverride: 6850,
    });
  }

  // Continue full throttle for 1.2 s so turbo spools to full boost and wastegate regulates <= 4.8 barA
  let peakBoostBarA = early40msOut.telemetry.boostPressureBarA;
  let peakWastegate = 0;
  let spooledOut = early40msOut;
  for (let i = 0; i < 600; i++) {
    spooledOut = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 145,
      deployMode: 'RAC',
      externalRpmOverride: 8200,
    });
    peakBoostBarA = Math.max(peakBoostBarA, spooledOut.telemetry.boostPressureBarA);
    peakWastegate = Math.max(peakWastegate, spooledOut.state.wastegateOpen01);
  }

  check(
    'MGU-H-free turbo exhibits physical spool lag at 40 ms after corner-exit throttle snap',
    early40msOut.telemetry.boostPressureBarA > apexBoostBarA &&
      early40msOut.telemetry.boostPressureBarA < 2.8 &&
      early40msOut.turboLagDeficitNm > 60 &&
      spooledOut.state.turboShaftRadS > apexShaftRadS + 5000,
    `apex=${fmt(apexBoostBarA, 2)} barA -> 40ms=${fmt(early40msOut.telemetry.boostPressureBarA, 2)} barA (lagDeficit=${fmt(early40msOut.turboLagDeficitNm, 1)} Nm)`,
  );

  check(
    'Low-RPM MGU-K anti-lag torque-fill compensates turbo lag on corner exit within 500 Nm cap',
    early40msOut.antiLagTorqueFillNm > 15 &&
      early40msOut.telemetry.mgukTorqueNm <= 500.0 + 1e-6 &&
      early40msOut.netCrankTorqueNm > early40msOut.steadyBoostedIceTorqueNm,
    `antiLagFill=+${fmt(early40msOut.antiLagTorqueFillNm, 1)} Nm, mgukT=${fmt(early40msOut.telemetry.mgukTorqueNm, 1)} Nm, netCrank=${fmt(early40msOut.netCrankTorqueNm, 1)} Nm`,
  );

  check(
    'Electronic wastegate regulates plenum boost near 4.76 barA and strictly < 4.80 barA FIA limit',
    peakBoostBarA > 4.55 && peakBoostBarA < LC26_FIA_POWERTRAIN_LIMITS.maxBoostPlenumBarA && peakWastegate > 0.25,
    `peakBoost=${fmt(peakBoostBarA, 3)} barA (< 4.800), wastegate=${fmt(peakWastegate, 2)}`,
  );
}

// ============================================================================
// 3. 350 kW MGU-K, Standard (290->345 km/h) vs Overtake (<1.0s, +0.5 MJ, 337.5->355 km/h)
// ============================================================================
console.log('\n=== 3. 350 kW / 500 Nm MGU-K, Standard C5.2.8 Taper & Overtake Mode ===');
{
  // Exact Standard FIA C5.2.8(i) points
  const std280 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(280, false);
  const std290 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(290, false);
  const std315 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(315, false); // 1800 - 5*315 = 225 kW
  const std340 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(340, false); // 1800 - 1700 = 100 kW
  const std3425 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(342.5, false); // 6900 - 20*342.5 = 50 kW
  const std345 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(345, false); // 0 kW
  const std352 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(352, false); // 0 kW

  check(
    'Standard FIA C5.2.8(i) speed taper matches exact piecewise equations (290->340->345 km/h)',
    std280 === 350 &&
      std290 === 350 &&
      Math.abs(std315 - 225) < 1e-9 &&
      Math.abs(std340 - 100) < 1e-9 &&
      Math.abs(std3425 - 50) < 1e-9 &&
      std345 === 0 &&
      std352 === 0,
    `290:${std290}, 315:${std315}, 340:${std340}, 342.5:${std3425}, 345:${std345} kW`,
  );

  // Exact Overtake FIA C5.2.8(ii) points
  const ovt337 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(337, true);
  const ovt3375 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(337.5, true);
  const ovt345 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(345, true); // 7100 - 20*345 = 200 kW
  const ovt350 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(350, true); // 7100 - 20*350 = 100 kW
  const ovt355 = LC26_POWERTRAIN_MODULE.computeFiaMgukPowerCapKw(355, true); // 0 kW

  check(
    'Overtake FIA C5.2.8(ii) holds 350 kW through 337.5 km/h and tapers (7100-20*v) to 0 at 355 km/h',
    ovt337 === 350 &&
      ovt3375 === 350 &&
      Math.abs(ovt345 - 200) < 1e-9 &&
      Math.abs(ovt350 - 100) < 1e-9 &&
      ovt355 === 0,
    `337:${ovt337}, 337.5:${ovt3375}, 345:${ovt345}, 350:${ovt350}, 355:${ovt355} kW`,
  );

  // Smooth Phase 2 calibration check: never exceeds legal FIA C5.2.8 cap
  const smoothMod = createLc26PowertrainModule({ ersCalibration: { cornerSmoothingWidthKmh: 4.0 } });
  let smoothExceedsLegal = false;
  for (let v = 0; v <= 360; v += 0.5) {
    if (smoothMod.computeFiaMgukPowerCapKw(v, false) > computeLc26FiaMgukPowerCapKw(v, false) + 1e-9) {
      smoothExceedsLegal = true;
    }
    if (smoothMod.computeFiaMgukPowerCapKw(v, true) > computeLc26FiaMgukPowerCapKw(v, true) + 1e-9) {
      smoothExceedsLegal = true;
    }
  }
  check(
    'Smooth corner-rounding calibration option stays strictly <= FIA C5.2.8 legal envelope',
    !smoothExceedsLegal,
    'verified across 0..360 km/h',
  );

  // Crank torque cap <= 500 Nm everywhere
  let maxTorqueCap = 0;
  for (let rpm = 0; rpm <= 15000; rpm += 100) {
    maxTorqueCap = Math.max(maxTorqueCap, evaluateCleanRoomMgukCrankTorqueCapNm(rpm, 350));
  }
  check(
    'MGU-K crank torque strictly <= 500 Nm across 0..15,000 RPM (FIA C5.2.11)',
    Math.abs(maxTorqueCap - 500) < 1e-6,
    `maxCrankTorque=${fmt(maxTorqueCap, 2)} Nm`,
  );

  // Detection-point arming (< 1.0 s arms, >= 1.0 s disarms) & +0.5 MJ deploy/harvest ceiling
  const ecu = new Lc26EcuController({ initialSoc01: 0.9, initialGear: 8, initialRpm: 11400 });
  // Cross detection at 1.25 s behind -> must NOT arm
  ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 330,
    trackProgress01: 0.87,
    detectionZoneProgress01: 0.88,
    gapAheadSeconds: 1.25,
    overtakeButtonActive: true,
  });
  const notArmedOut = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 335,
    trackProgress01: 0.89,
    detectionZoneProgress01: 0.88,
    gapAheadSeconds: 1.25,
    overtakeButtonActive: true,
  });

  // Cross detection at 0.74 s behind -> MUST arm Overtake Mode (+0.5 MJ -> 4.5 MJ deploy / 9.0 MJ harvest)
  ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 335,
    trackProgress01: 0.87,
    detectionZoneProgress01: 0.88,
    gapAheadSeconds: 0.74,
    overtakeButtonActive: true,
  });
  const armedOut = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 335,
    trackProgress01: 0.89,
    detectionZoneProgress01: 0.88,
    gapAheadSeconds: 0.74,
    overtakeButtonActive: true,
  });

  check(
    'Overtake detection: >= 1.0 s stays disarmed (4.0/8.5 MJ); < 1.0 s arms Overtake (4.5/9.0 MJ & 350 kW @ 335 km/h)',
    !notArmedOut.state.overtakeArmed &&
      !notArmedOut.telemetry.overtakeModeActive &&
      notArmedOut.activeDeployCeilingJ === 4_000_000 &&
      notArmedOut.activeHarvestCeilingJ === 8_500_000 &&
      armedOut.state.overtakeArmed &&
      armedOut.telemetry.overtakeModeActive &&
      armedOut.activeDeployCeilingJ === 4_500_000 &&
      armedOut.activeHarvestCeilingJ === 9_000_000 &&
      armedOut.telemetry.speedDerateCapKw === 350,
    `gap 1.25s -> armed=${notArmedOut.state.overtakeArmed}; gap 0.74s -> armed=${armedOut.state.overtakeArmed}, deployCap=${armedOut.activeDeployCeilingJ / 1e6} MJ, harvCap=${armedOut.activeHarvestCeilingJ / 1e6} MJ`,
  );
}

// ============================================================================
// 4. ECU Super Clipping (250–350 kW, Smooth dP/dt Slew, Straight Mode OPEN) & Boost Override
// ============================================================================
console.log('\n=== 4. ECU Super Clipping (Smooth dP/dt, Straight Mode Invariant) & Boost Button ===');
{
  const ecu = new Lc26EcuController({ initialSoc01: 0.25, initialGear: 8, initialRpm: 11500 });
  // Run at 250 km/h first so MGU-K is deploying positive power
  for (let i = 0; i < 150; i++) {
    ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 250,
      deployMode: 'RAC',
      externalRpmOverride: 10800,
    });
  }
  const preClipPowerKw = ecu.state.slewedMgukPowerKw;

  // Enter high-speed end-of-straight zone (305 km/h, 100% throttle, 300 kW Super Clip ceiling)
  let maxSingleStepPowerDeltaKw = 0;
  let maxSingleStepRearTorqueJumpNm = 0;
  let minPassthroughThrottle = 1.0;
  let prevKw = preClipPowerKw;
  let prevRearNm =
    ((evaluateCleanRoomIceSteadyPowerKw(11400) + preClipPowerKw) * 1000 / (11400 * (Math.PI / 30))) *
    (LC26_GEARBOX_DATA.ratios[7] * LC26_GEARBOX_DATA.finalDrive) *
    LC26_GEARBOX_DATA.efficiency;

  // Prime first step at 305 km/h / 11,400 RPM to measure transient slew across Super Clipping entry
  const firstStep = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 305,
    deployMode: 'RAC',
    superClipCeilingKw: 300,
    superClipTargetSoc01: 0.65,
    externalRpmOverride: 11400,
  });
  prevKw = firstStep.telemetry.mgukPowerKw;
  prevRearNm = firstStep.rearAxleDriveTorqueNm;

  let settledClipOut = firstStep;
  for (let i = 0; i < 1200; i++) {
    settledClipOut = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 305,
      deployMode: 'RAC',
      superClipCeilingKw: 300,
      superClipTargetSoc01: 0.65,
      externalRpmOverride: 11400,
    });
    maxSingleStepPowerDeltaKw = Math.max(
      maxSingleStepPowerDeltaKw,
      Math.abs(settledClipOut.telemetry.mgukPowerKw - prevKw),
    );
    maxSingleStepRearTorqueJumpNm = Math.max(
      maxSingleStepRearTorqueJumpNm,
      Math.abs(settledClipOut.rearAxleDriveTorqueNm - prevRearNm),
    );
    minPassthroughThrottle = Math.min(minPassthroughThrottle, settledClipOut.passthroughThrottlePedal01);
    prevKw = settledClipOut.telemetry.mgukPowerKw;
    prevRearNm = settledClipOut.rearAxleDriveTorqueNm;
  }

  check(
    'ECU Super Clipping harvests ~300 kW at 100% throttle while keeping passthroughThrottle === 1.0 (Straight Mode OPEN)',
    settledClipOut.state.superClippingActive &&
      Math.abs(settledClipOut.telemetry.mgukPowerKw - -300) < 2.0 &&
      minPassthroughThrottle === 1.0 &&
      settledClipOut.state.soc01 > 0.25,
    `pre=${fmt(preClipPowerKw, 1)} kW -> clip=${fmt(settledClipOut.telemetry.mgukPowerKw, 1)} kW, passthroughThrottle=${minPassthroughThrottle.toFixed(2)}, SoC=${fmt(settledClipOut.state.soc01 * 100, 1)}%`,
  );

  check(
    'Super Clipping enforces smooth dP/dt slew (< 1.0 kW & < 5 Nm rear axle delta per 2 ms step — zero step shock)',
    maxSingleStepPowerDeltaKw < 1.0 && maxSingleStepRearTorqueJumpNm < 5.0,
    `maxStep |dP|=${fmt(maxSingleStepPowerDeltaKw, 3)} kW, maxStep |dT_rear|=${fmt(maxSingleStepRearTorqueJumpNm, 2)} Nm @ 500 Hz`,
  );

  // Driver presses Boost / Anti-Clip button while still at 100% throttle at 305 km/h:
  // Legal C5.2.8 cap at 305 km/h = 1800 - 5*305 = 275 kW!
  let boostOut = settledClipOut;
  const socBeforeBoost = ecu.state.soc01;
  for (let i = 0; i < 300; i++) {
    boostOut = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      speedKmh: 305,
      deployMode: 'CHR', // Even in conservative Charge mode, Boost overrides to peak legal deploy!
      boostButtonActive: true,
      externalRpmOverride: 11400,
    });
  }
  check(
    'Boost button overrides Super Clipping & Charge map to command full legal 275 kW @ 305 km/h',
    !boostOut.state.superClippingActive &&
      Math.abs(boostOut.telemetry.mgukPowerKw - 275) < 1.0 &&
      boostOut.state.soc01 < socBeforeBoost,
    `boostPower=${fmt(boostOut.telemetry.mgukPowerKw, 1)} kW (legalCap=275 kW), SoC ${fmt(socBeforeBoost * 100, 2)}% -> ${fmt(boostOut.state.soc01 * 100, 2)}%`,
  );
}

// ============================================================================
// 5. True Brake-by-Wire (BBW): Zero Rear Torque Spike/Sag Across All Boundaries
// ============================================================================
console.log('\n=== 5. True Brake-by-Wire (BBW) Zero-Spike Invariance & >= 2500 Nm Fail-Safe ===');
{
  check(
    'Rear hydraulic fail-safe mechanical capacity >= 2500 Nm without MGU-K (FIA C11.6)',
    DEFAULT_LC26_BBW_PARAMS.rearHydraulicMaxAxleTorqueNm >= LC26_FIA_POWERTRAIN_LIMITS.minRearHydraulicBrakeTorqueNm,
    `rearHydCap=${DEFAULT_LC26_BBW_PARAMS.rearHydraulicMaxAxleTorqueNm} Nm (>= 2500 Nm)`,
  );

  // Sweep SoC from 99.0% -> 99.8% -> 100.0% at 85% brake pedal, 310 km/h, 11,200 RPM
  let maxSocRearDeviationNm = 0;
  let maxSocStepDeltaNm = 0;
  const refBbw = LC26_POWERTRAIN_MODULE.solveBrakeByWire(0.85, 310, 11200, 0.5, 2_000_000, 0.56, 0.025);
  const refRearTotalNm = refBbw.rearHydraulicTorqueNm + refBbw.rearMgukRegenTorqueNm;
  let prevRearTotalNm = refRearTotalNm;
  let bbwAt998 = refBbw;
  let bbwAt100 = refBbw;

  for (let i = 0; i <= 200; i++) {
    const soc = 0.99 + (i / 200) * 0.01;
    const res = LC26_POWERTRAIN_MODULE.solveBrakeByWire(0.85, 310, 11200, soc, 2_000_000, 0.56, 0.025);
    const totalRear = res.rearHydraulicTorqueNm + res.rearMgukRegenTorqueNm;
    maxSocRearDeviationNm = Math.max(maxSocRearDeviationNm, Math.abs(totalRear - refRearTotalNm));
    maxSocStepDeltaNm = Math.max(maxSocStepDeltaNm, Math.abs(totalRear - prevRearTotalNm));
    prevRearTotalNm = totalRear;
    if (Math.abs(soc - 0.998) < 1e-6) bbwAt998 = res;
    if (i === 200) bbwAt100 = res;
  }

  check(
    'BBW zero rear torque spike/sag across 99.8% -> 100.0% SoC saturation',
    maxSocRearDeviationNm < 1e-6 &&
      maxSocStepDeltaNm < 1e-6 &&
      bbwAt998.rearMgukRegenTorqueNm > 0 &&
      bbwAt100.rearMgukRegenTorqueNm === 0 &&
      bbwAt100.rearHydraulicTorqueNm >= 2500,
    `totalRear=${fmt(refRearTotalNm, 1)} Nm, maxDev=${maxSocRearDeviationNm.toExponential(2)} Nm, @100% SoC hyd=${fmt(bbwAt100.rearHydraulicTorqueNm, 1)} Nm / regen=${fmt(bbwAt100.rearMgukRegenTorqueNm, 1)} Nm`,
  );

  // Sweep per-lap harvested energy across 8.45 -> 8.49 -> 8.50 MJ standard cap (and 8.99 -> 9.00 MJ Overtake cap)
  let maxHarvRearDeviationNm = 0;
  let bbwAt849 = refBbw;
  let bbwAt850 = refBbw;
  for (let j = 8_440_000; j <= 8_510_000; j += 1000) {
    const res = LC26_POWERTRAIN_MODULE.solveBrakeByWire(0.85, 310, 11200, 0.65, j, 0.56, 0.025);
    const totalRear = res.rearHydraulicTorqueNm + res.rearMgukRegenTorqueNm;
    maxHarvRearDeviationNm = Math.max(maxHarvRearDeviationNm, Math.abs(totalRear - refRearTotalNm));
    if (j === 8_490_000) bbwAt849 = res;
    if (j === 8_500_000) bbwAt850 = res;
  }
  const ovt899 = solveLc26BrakeByWire(0.85, 310, 11200, 0.65, 8_990_000, 0.56, 0.025, true);
  const ovt900 = solveLc26BrakeByWire(0.85, 310, 11200, 0.65, 9_000_000, 0.56, 0.025, true);

  check(
    'BBW zero rear torque spike/sag across 8.49 -> 8.50 MJ (and 8.99 -> 9.00 MJ Overtake) harvest cap',
    maxHarvRearDeviationNm < 1e-6 &&
      bbwAt849.rearMgukRegenTorqueNm > 0 &&
      bbwAt850.rearMgukRegenTorqueNm === 0 &&
      ovt899.rearMgukRegenTorqueNm > 0 &&
      ovt900.rearMgukRegenTorqueNm === 0 &&
      Math.abs(ovt900.rearHydraulicTorqueNm - refRearTotalNm) < 1e-6,
    `8.49MJ regen=${fmt(bbwAt849.rearMgukRegenTorqueNm, 1)} -> 8.50MJ regen=${fmt(bbwAt850.rearMgukRegenTorqueNm, 1)} Nm; Ovt 8.99MJ regen=${fmt(ovt899.rearMgukRegenTorqueNm, 1)} -> 9.00MJ regen=0`,
  );

  // Low-speed / low-RPM regen taper & dynamic brake migration check
  let maxSpeedSweepDevNm = 0;
  for (const [vKmh, rpm] of [
    [320, 11500],
    [180, 9200],
    [60, 5500],
    [20, 4200],
    [5, 3800],
  ] as const) {
    const res = LC26_POWERTRAIN_MODULE.solveBrakeByWire(0.7, vKmh, rpm, 0.6, 1_000_000, 0.56, 0.03);
    const expectedBias = 0.56 + 0.03 * 0.7;
    const expectedRear = 2 * 0.7 * DEFAULT_LC26_BBW_PARAMS.maxWheelPairTorqueNm * (1 - expectedBias);
    maxSpeedSweepDevNm = Math.max(
      maxSpeedSweepDevNm,
      Math.abs(res.rearHydraulicTorqueNm + res.rearMgukRegenTorqueNm - expectedRear),
    );
  }
  const fwdMig = LC26_POWERTRAIN_MODULE.solveBrakeByWire(1.0, 250, 10500, 0.6, 0, 0.56, 0.04);
  const rwdMig = LC26_POWERTRAIN_MODULE.solveBrakeByWire(1.0, 250, 10500, 0.6, 0, 0.56, -0.03);
  check(
    'BBW holds exact rear demand across low-speed fade & forward/rearward brake migration',
    maxSpeedSweepDevNm < 1e-6 &&
      Math.abs(fwdMig.effectiveFrontBias01 - 0.6) < 1e-9 &&
      Math.abs(rwdMig.effectiveFrontBias01 - 0.53) < 1e-9,
    `maxSpeedSweepDev=${maxSpeedSweepDevNm.toExponential(2)} Nm, fwdBias=${fmt(fwdMig.effectiveFrontBias01 * 100, 1)}%, rwdBias=${fmt(rwdMig.effectiveFrontBias01 * 100, 1)}%`,
  );
}

// ============================================================================
// 6. 8-Speed Seamless Gearbox (28 ms), Downshift Protection & N/R Interlock
// ============================================================================
console.log('\n=== 6. 8-Speed 28 ms Seamless Gearbox, Over-Rev Protection & N/R Interlock ===');
{
  check(
    '8 forward gears + 28 ms seamless upshift cut configured accurately',
    LC26_GEARBOX_DATA.ratios.length === 8 &&
      LC26_GEARBOX_DATA.shiftTimeS === 0.028 &&
      LC26_GEARBOX_DATA.upshiftCutS === 0.028,
    `gears=${LC26_GEARBOX_DATA.ratios.length}, shiftTime=${LC26_GEARBOX_DATA.shiftTimeS * 1000} ms`,
  );

  // Test 28 ms seamless upshift + pending shift queue + over-rev downshift protection
  const ecu = new Lc26EcuController({ initialGear: 3, initialRpm: 11800 });
  const shiftStart = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 168,
    shiftUp: true,
  });
  // Press upshift again 6 ms into the 28 ms shift -> must queue pendingShift and fire right after 28 ms
  ecu.step({ dtS: DT_500HZ, throttlePedal01: 1.0, brakePedal01: 0, speedKmh: 168, shiftUp: false });
  ecu.step({ dtS: DT_500HZ, throttlePedal01: 1.0, brakePedal01: 0, speedKmh: 168, shiftUp: false });
  const queuedDuringShift = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    speedKmh: 168,
    shiftUp: true,
  });
  for (let i = 0; i < 14; i++) {
    ecu.step({ dtS: DT_500HZ, throttlePedal01: 1.0, brakePedal01: 0, speedKmh: 168, shiftUp: false });
  }
  const after28ms = ecu.state.gear;

  check(
    'Seamless 28 ms upshift transitions 3->4 immediately and queues rapid 4->5 paddle after 28 ms',
    shiftStart.state.gear === 4 && queuedDuringShift.state.gear === 4 && after28ms === 5,
    `t=2ms: G${shiftStart.state.gear}, t=8ms (queued): G${queuedDuringShift.state.gear}, t>28ms: G${after28ms}`,
  );

  // Over-rev downshift protection: at 245 km/h in 6th gear, 5th gear is ~12,055 RPM (> 12,000 limit) -> REFUSED!
  const ecuHighSpd = new Lc26EcuController({ initialGear: 6, initialRpm: 10400 });
  const overRevAttempt = ecuHighSpd.step({
    dtS: DT_500HZ,
    throttlePedal01: 0,
    brakePedal01: 0.8,
    speedKmh: 245,
    shiftDown: true,
  });
  const prospective5thRpm = computeLc26RoadCoupledRpm(5, 245);
  check(
    'Strict over-rev downshift protection refuses 6->5 shift when 5th would exceed 12,000 RPM',
    overRevAttempt.downshiftRejectedOverRev && overRevAttempt.state.gear === 6 && prospective5thRpm > 12000,
    `245 km/h -> G5 would be ${fmt(prospective5thRpm, 0)} RPM (> 12,000), stayed in G${overRevAttempt.state.gear}`,
  );

  // Neutral (0) & Reverse (-1) safety interlock
  const ecuInterlock = new Lc26EcuController({ initialGear: 1, initialRpm: 5000 });
  const paddleDownAtSpeed = ecuInterlock.step({
    dtS: DT_500HZ,
    throttlePedal01: 0.2,
    brakePedal01: 0,
    speedKmh: 65,
    shiftDown: true,
  });
  ecuInterlock.step({ dtS: DT_500HZ, throttlePedal01: 0.2, brakePedal01: 0, speedKmh: 65, shiftDown: false });
  const neutralButtonAtSpeed = ecuInterlock.step({
    dtS: DT_500HZ,
    throttlePedal01: 0,
    brakePedal01: 0.5,
    speedKmh: 40,
    neutralButtonActive: true,
  });
  const neutralButtonStationary = ecuInterlock.step({
    dtS: DT_500HZ,
    throttlePedal01: 0,
    brakePedal01: 0.5,
    speedKmh: 0,
    neutralButtonActive: true,
  });
  const reverseWithoutBrake = ecuInterlock.step({
    dtS: DT_500HZ,
    throttlePedal01: 0,
    brakePedal01: 0.0, // No brake!
    speedKmh: 0,
    reverseButtonActive: true,
  });
  const reverseWithBrakeAndButton = ecuInterlock.step({
    dtS: DT_500HZ,
    throttlePedal01: 0,
    brakePedal01: 0.6,
    speedKmh: 0,
    reverseButtonActive: true,
  });

  check(
    'Neutral (0) & Reverse (-1) safety interlock blocks at speed/without brake and engages stationary with button+brake',
    paddleDownAtSpeed.state.gear === 1 &&
      paddleDownAtSpeed.neutralReverseInterlockBlocked &&
      neutralButtonAtSpeed.state.gear === 1 &&
      neutralButtonStationary.state.gear === 0 &&
      reverseWithoutBrake.state.gear === 0 &&
      reverseWithoutBrake.neutralReverseInterlockBlocked &&
      reverseWithBrakeAndButton.state.gear === -1,
    `65kph down->G${paddleDownAtSpeed.state.gear}, 40kph N-btn->G${neutralButtonAtSpeed.state.gear}, 0kph N-btn->G${neutralButtonStationary.state.gear}, 0kph R-no-brk->G${reverseWithoutBrake.state.gear}, 0kph R+brk->G${reverseWithBrakeAndButton.state.gear}`,
  );
}

// ============================================================================
// 7. 5-Second Grid Launch Rev-Hold Anti-Lag (~7500 RPM, Pre-Boost & Timeout)
// ============================================================================
console.log('\n=== 7. 5-Second Grid Launch Rev-Hold Anti-Lag & FIA C5.2.12 50 km/h Gate ===');
{
  const ecu = new Lc26EcuController({
    initialGear: 1,
    initialRpm: 3800,
    initialSoc01: 1.0,
    standingStart: true,
  });

  // Hold clutch + launch button + 100% throttle for 3.5 s (< 5.0 s limit)
  let holdAt3_5s = ecu.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    clutchPedal01: 1.0,
    launchButtonActive: true,
    speedKmh: 0,
  });
  for (let i = 1; i < Math.round(3.5 / DT_500HZ); i++) {
    holdAt3_5s = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      clutchPedal01: 1.0,
      launchButtonActive: true,
      speedKmh: 0,
    });
  }

  check(
    'Grid launch hold stabilizes around ~7,500 RPM with > 2.4 barA turbo anti-lag pre-boost inside 5.0 s',
    holdAt3_5s.state.launchHoldActive &&
      !holdAt3_5s.state.launchTimeoutTripped &&
      holdAt3_5s.state.rpm >= 7250 &&
      holdAt3_5s.state.rpm <= 7750 &&
      holdAt3_5s.telemetry.boostPressureBarA >= 2.4 &&
      holdAt3_5s.telemetry.mgukPowerKw === 0,
    `t=3.5s: rpm=${fmt(holdAt3_5s.state.rpm, 0)}, preBoost=${fmt(holdAt3_5s.telemetry.boostPressureBarA, 2)} barA, mguk=${fmt(holdAt3_5s.telemetry.mgukPowerKw, 1)} kW`,
  );

  // Hold past 5.0 s (to 6.4 s) -> timeout protection must trip at 5.0 s, opening wastegate & spinning crank down to idle!
  let holdAfterTimeout = holdAt3_5s;
  for (let i = 0; i < Math.round(2.9 / DT_500HZ); i++) {
    holdAfterTimeout = ecu.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      clutchPedal01: 1.0,
      launchButtonActive: true,
      speedKmh: 0,
    });
  }

  check(
    'Holding launch anti-lag past 5.0 s trips thermal timeout protection (opens wastegate & drops RPM)',
    holdAfterTimeout.state.launchTimeoutTripped &&
      !holdAfterTimeout.state.launchHoldActive &&
      holdAfterTimeout.state.wastegateOpen01 === 1 &&
      holdAfterTimeout.state.rpm < 4800 &&
      holdAfterTimeout.telemetry.boostPressureBarA < 1.35,
    `t=6.4s: timeout=${holdAfterTimeout.state.launchTimeoutTripped}, rpm=${fmt(holdAfterTimeout.state.rpm, 0)}, boost=${fmt(holdAfterTimeout.state.boostPressureBarA, 2)} barA`,
  );

  // Verify FIA C5.2.12 standing-start MGU-K gate: 0 kW at 35 km/h (< 50 km/h), active at 65 km/h (>= 50 km/h)
  const launchGo = new Lc26EcuController({
    initialGear: 1,
    initialRpm: 7500,
    initialSoc01: 1.0,
    standingStart: true,
  });
  let maxBelow50Kw = 0;
  for (let i = 0; i < 25; i++) {
    const out35 = launchGo.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      clutchPedal01: 0.2,
      speedKmh: 35,
      deployMode: 'PSH',
      externalRpmOverride: 6500,
    });
    maxBelow50Kw = Math.max(maxBelow50Kw, Math.abs(out35.telemetry.mgukPowerKw));
  }
  let at65Kmh = launchGo.step({
    dtS: DT_500HZ,
    throttlePedal01: 1.0,
    brakePedal01: 0,
    clutchPedal01: 0.0,
    speedKmh: 65,
    deployMode: 'PSH',
    externalRpmOverride: 7500,
  });
  for (let i = 1; i < 25; i++) {
    at65Kmh = launchGo.step({
      dtS: DT_500HZ,
      throttlePedal01: 1.0,
      brakePedal01: 0,
      clutchPedal01: 0.0,
      speedKmh: 65,
      deployMode: 'PSH',
      externalRpmOverride: 7500,
    });
  }
  check(
    'FIA C5.2.12 standing-start MGU-K inhibit holds 0 kW below 50 km/h and enables deploy >= 50 km/h',
    maxBelow50Kw === 0 && at65Kmh.telemetry.mgukPowerKw > 150,
    `@35 km/h: ${fmt(maxBelow50Kw, 1)} kW, @65 km/h: ${fmt(at65Kmh.telemetry.mgukPowerKw, 1)} kW`,
  );
}

// ============================================================================
// 8. 3-Phase Clutch-Pack + Viscous Differential (Entry / Mid / Exit Torque Split)
// ============================================================================
console.log('\n=== 8. 3-Phase Electronic Clutch-Pack + Viscous Differential ===');
{
  const entryDiff = solveLc26Differential({
    ringGearTorqueNm: -1800,
    rearLeftWheelOmegaRadS: 148,
    rearRightWheelOmegaRadS: 152,
    throttlePedal01: 0,
    brakePedal01: 0.75,
    steeringNormalized: 0.15,
    speedKmh: 190,
    entryLockPct: 32,
    midCoastLockPct: 16,
    exitPowerLockPct: 48,
  });

  const midDiff = solveLc26Differential({
    ringGearTorqueNm: -120,
    rearLeftWheelOmegaRadS: 92,
    rearRightWheelOmegaRadS: 96,
    throttlePedal01: 0.05,
    brakePedal01: 0.0,
    steeringNormalized: 0.55,
    speedKmh: 118,
    entryLockPct: 32,
    midCoastLockPct: 16,
    exitPowerLockPct: 48,
  });

  // Corner exit under heavy power with inside left wheel spinning faster (omegaL = 132 > omegaR = 118)
  const exitDiff = solveLc26Differential({
    ringGearTorqueNm: 3200,
    rearLeftWheelOmegaRadS: 132,
    rearRightWheelOmegaRadS: 118,
    throttlePedal01: 0.95,
    brakePedal01: 0,
    steeringNormalized: 0.2,
    speedKmh: 155,
    entryLockPct: 32,
    midCoastLockPct: 16,
    exitPowerLockPct: 48,
  });

  check(
    '3-Phase differential cleanly selects ENTRY (braking), MID (apex coast), and EXIT (power) maps',
    entryDiff.activePhase === 'ENTRY' &&
      midDiff.activePhase === 'MID' &&
      exitDiff.activePhase === 'EXIT' &&
      midDiff.effectiveLockFraction01 < entryDiff.effectiveLockFraction01 &&
      entryDiff.effectiveLockFraction01 < exitDiff.effectiveLockFraction01,
    `lockFracs: MID=${fmt(midDiff.effectiveLockFraction01 * 100, 1)}% < ENTRY=${fmt(entryDiff.effectiveLockFraction01 * 100, 1)}% < EXIT=${fmt(exitDiff.effectiveLockFraction01 * 100, 1)}%`,
  );

  check(
    'Exit clutch-pack + viscous shear transfers drive torque from spinning inside wheel to gripping outside wheel',
    exitDiff.viscousLockTorqueNm > 150 &&
      exitDiff.rearRightTorqueNm > exitDiff.rearLeftTorqueNm + 1000 &&
      Math.abs(exitDiff.rearLeftTorqueNm + exitDiff.rearRightTorqueNm - 3200) < 1e-6,
    `ring=3200 Nm -> spinning RL=${fmt(exitDiff.rearLeftTorqueNm, 0)} Nm, gripping RR=${fmt(exitDiff.rearRightTorqueNm, 0)} Nm (viscous=${fmt(exitDiff.viscousLockTorqueNm, 0)} Nm)`,
  );
}

// ============================================================================
// 9. Garage Setup Wiring & Live 6-DOF VehiclePhysics End-to-End Integration
// ============================================================================
console.log('\n=== 9. Garage Setup Applier & Live 6-DOF VehiclePhysics (500/2000 Hz) Integration ===');
{
  const applied = applyGarageSetupToLc26Powertrain({
    brakeBiasFrontPct: 57.5,
    brakeMigrationPct: 3.0,
    diffEntryLockPct: 35,
    diffMidCoastLockPct: 20,
    diffHighSpeedPreloadNm: 90,
    engineBrakingLevel: 3,
    ersDeployMode: 'PSH',
    fuelLoadKg: 14.5,
  });
  check(
    'Garage setup applier maps fuel in kg, brake bias/migration, diff preload & engine braking cleanly',
    applied.fuelLoadKg === 14.5 &&
      applied.ersDeployMode === 'PSH' &&
      Math.abs(applied.module.brakes.front_bias - 0.575) < 1e-9 &&
      applied.module.differential.settings.preload === 90,
    `fuel=${applied.fuelLoadKg} kg, bias=${applied.module.brakes.front_bias * 100}%, preload=${applied.module.differential.settings.preload} Nm`,
  );

  // Assemble a live 6-DOF VehiclePhysics rig substituting our clean-room LC-26 Powertrain + Chassis
  const testConfig: CarPhysicsConfig = {
    ...F12026_CAR_CONFIG,
    screenName: 'VeloSoft LC-26 Powertrain Test Rig',
    chassis: LC26_CHASSIS_DATA,
    engine: LC26_ENGINE_DATA,
    ers: LC26_ERS_DATA,
    performanceModes: LC26_PERFORMANCE_MODES,
    gearbox: LC26_GEARBOX_DATA,
    clutch: LC26_CLUTCH_DATA,
    differential: LC26_DIFFERENTIAL_DATA,
    brakes: LC26_BRAKES_DATA,
  };

  const sim = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: testConfig,
    performanceMode: 'PSH',
    airDensity: 1.2,
  });
  sim.setFuelMass(20.0); // 20 kg sustainable fuel
  sim.reset(0, 0, 0, 0);

  // 1) Grid standstill check (5 s in 1st gear, 0% pedal -> stays still, idles ~3800 RPM)
  let maxGridCreepMs = 0;
  for (let i = 0; i < 5 / DT_500HZ; i++) {
    sim.step(DT_500HZ, { throttle: 0, brake: 0, steer: 0 });
    maxGridCreepMs = Math.max(maxGridCreepMs, Math.abs(sim.speedMs));
  }
  check(
    'Live 6-DOF VehiclePhysics: stands still on grid in 1st gear at ~3,800 RPM idle',
    maxGridCreepMs < 0.02 && sim.rpm > 3500 && sim.rpm < 4200 && sim.fuelMassKg === 20.0,
    `creep=${fmt(maxGridCreepMs * 3.6, 3)} km/h, idle=${fmt(sim.rpm, 0)} RPM, fuel=${sim.fuelMassKg} kg`,
  );

  // 2) Progressive traction-modulated launch through 8-speed seamless shifts past 280 km/h
  let maxGearReached = 1;
  let peakBoostSeen = 1;
  for (let i = 0; i < 15 / DT_500HZ; i++) {
    const launchThrottle = Math.min(1, Math.max(0.45, 0.45 + sim.speedMs * 0.025));
    sim.step(DT_500HZ, { throttle: launchThrottle, brake: 0, steer: 0 });
    maxGearReached = Math.max(maxGearReached, sim.gear);
    peakBoostSeen = Math.max(peakBoostSeen, sim.turboBoostBar);
  }
  const topSpeedReachedKmh = sim.speedMs * 3.6;
  check(
    'Live 6-DOF VehiclePhysics: launches cleanly through gears past 280 km/h with < 4.8 barA boost & zero NaN',
    Number.isFinite(topSpeedReachedKmh) &&
      topSpeedReachedKmh > 280 &&
      maxGearReached >= 7 &&
      peakBoostSeen > 4.5 &&
      peakBoostSeen < 4.8,
    `v=${fmt(topSpeedReachedKmh, 1)} km/h in G${maxGearReached}, boost=${fmt(peakBoostSeen, 2)} barA`,
  );

  // 3) Live 6-DOF VehiclePhysics brake-by-wire check at 250 km/h: rear caliper + MGU-K harvest matches rear brake demand
  const bbwCar = new VehiclePhysics({
    ground: new FlatGroundQuery(0),
    config: testConfig,
    performanceMode: 'RAC',
    airDensity: 1.2,
  });
  bbwCar.reset(0, 0, 0, 250 / 3.6);
  for (let i = 0; i < 1.0 / DT_500HZ; i++) {
    bbwCar.step(DT_500HZ, { throttle: 1, brake: 0, steer: 0 });
  }
  let rearMeasuredSum = 0;
  let rearDemandSum = 0;
  let drivetrainRegenSum = 0;
  const rearTyre = compoundData(testConfig, testConfig.compoundSlots.soft).modelData;
  for (let i = 0; i < 0.8 / DT_500HZ; i++) {
    bbwCar.step(DT_500HZ, { throttle: 0, brake: 0.28, steer: 0 });
    if (i < 0.3 / DT_500HZ) continue;
    for (const k of [2, 3]) {
      const w = bbwCar.wheels[k];
      const rolling =
        w.fz * (rearTyre.rollingResistance + (rearTyre.rollingResistanceSpeedSq ?? 0) * w.vx * w.vx) * w.rollingRadius;
      rearMeasuredSum += w.brakeTorqueNm - rolling - w.driveTorqueNm;
      drivetrainRegenSum += -w.driveTorqueNm;
    }
    rearDemandSum += 2 * 0.28 * testConfig.brakes.maxTorqueNm * (1 - bbwCar.dynamicBrakeBias);
  }
  const liveBbwRatio = rearMeasuredSum / rearDemandSum;
  check(
    'Live 6-DOF VehiclePhysics: BBW rear caliper + MGU-K regen matches rear brake demand within 3%',
    drivetrainRegenSum / rearDemandSum > 0.45 && Math.abs(liveBbwRatio - 1) < 0.03,
    `ratio=${fmt(liveBbwRatio, 3)}, regenShare=${fmt((drivetrainRegenSum / rearDemandSum) * 100, 1)}%`,
  );
}

// ============================================================================
// Summary
// ============================================================================
console.log('\n================================================================================');
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s) (${passed} passed):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log(`ALL ${passed} LC-26 POWERTRAIN, SUPER CLIPPING, OVERTAKE & BBW CHECKS PASSED!`);
}
