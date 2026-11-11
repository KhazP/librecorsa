/**
 * Deterministic Clean-Room Verification Suite for Agent 2 (`suspension-ffb`):
 * VeloSoft LC-26 (`lc26-f1`) 6-DOF Multibody Suspension, 10 mm Plank Wear & 500 Hz Kingpin WebHID FFB.
 *
 * Run via:
 *   node --disable-warning=THREE_CJS_DEPRECATED --import tsx scripts/verify-lc26-suspension.ts
 */

import assert from 'node:assert/strict';
import {
  LC26_CHASSIS_DATA,
  LC26_FIA_DATUM_PLANES,
  LC26_MASS_AND_INERTIA,
  LC26_PLANK_SPEC,
  LC26_SOLVER_RATES,
  LC26_TYRE_DIMENSIONS,
} from '../src/lib/cars/lc26/contract-types';
import {
  LC26_CHASSIS_WITH_POWER_STEERING,
  LC26_POWER_STEERING,
  LC26_SUSPENSIONS_DATA,
  LC26_SUSPENSION_MODULE,
  LC26_WEBHID_NOMINAL_MAX_TORQUE_NM,
  applyLc26GarageSuspensionSetup,
  arbNmDegToWheelRateNm,
  computeLc26FrontPneumaticAligningNm,
  computeLc26KingpinFfb,
  computeLc26PlankStrikeClearancesM,
  computeLc26StaticSpringPreload,
  createInitialPlankWearState,
  evaluateLc26ActuationRod,
  evaluateLc26AxleKinematics,
  evaluateLc26FloorStallTrigger,
  evaluateLc26PlankLegality,
  evaluateLc26SuspensionForces,
  stepLc26PlankWear,
  wheelRateNmToArbNmDeg,
} from '../src/lib/cars/lc26/suspension';
import type {
  CarPhysicsConfig,
  PerformanceModeData,
  PerformanceModeName,
  TyresCompoundData,
} from '../src/lib/sim/f12026-car/F12026CarConfig';
import type { GroundHit, GroundQuery } from '../src/lib/sim/f12026-car/TrackColliderQuery';
import { DEFAULT_SURFACE_TABLE } from '../src/lib/sim/track-surfaces';
import { VehiclePhysics } from '../src/lib/sim/f12026-car/VehiclePhysics';

const FLAT_GROUND: GroundQuery = {
  smooth: true,
  query(_x: number, _z: number, _probeY: number, out: GroundHit): boolean {
    out.height = 0;
    out.nx = 0;
    out.ny = 1;
    out.nz = 0;
    out.surface = 'road';
    out.grip = DEFAULT_SURFACE_TABLE.road.friction;
    out.props = DEFAULT_SURFACE_TABLE.road;
    out.source = 'flat_asphalt';
    return true;
  },
};

const DEG2RAD = Math.PI / 180;
const GRAVITY_MS2 = 9.81;

// ---------------------------------------------------------------------------
// Clean-Room First-Principles LC-26 Test Harness (`CarPhysicsConfig`)
// Zero curves or constants imported from any legacy/ported car config.
// ---------------------------------------------------------------------------

function buildCleanRoomLc26TestConfig(): CarPhysicsConfig {
  const sinPitch0 =
    (LC26_FIA_DATUM_PLANES.staticRearRideHeightM - LC26_FIA_DATUM_PLANES.staticFrontRideHeightM) /
    LC26_CHASSIS_DATA.wheelbase;
  const cosPitch0 = Math.sqrt(1 - sinPitch0 * sinPitch0);
  const floorOffsetY =
    (LC26_FIA_DATUM_PLANES.staticFrontRideHeightM -
      LC26_CHASSIS_DATA.cgHeight +
      LC26_FIA_DATUM_PLANES.frontAxleGltfZM * sinPitch0) /
    cosPitch0;

  const baseMode: Omit<PerformanceModeData, 'performance_mode_name'> = {
    deployFraction: 1.0,
    deployVsSpeed: [
      [0, 1.0],
      [290, 1.0],
      [340, 0.25],
      [355, 0.0],
    ],
    socFloor: 0.05,
    brakeHarvestScale: 1.0,
    liftHarvestScale: 1.0,
    topGearClipHarvestW: 0,
    partThrottleHarvestW: 0,
    coastTorqueScale: 1.0,
    ebbOffset: 0,
  };

  const performanceModes: Record<PerformanceModeName, PerformanceModeData> = {
    PSH: { ...baseMode, performance_mode_name: 'PSH' },
    RAC: { ...baseMode, performance_mode_name: 'RAC' },
    BAL: { ...baseMode, performance_mode_name: 'BAL', deployFraction: 0.8 },
    LIC: { ...baseMode, performance_mode_name: 'LIC', deployFraction: 0.5 },
    CHR: { ...baseMode, performance_mode_name: 'CHR', deployFraction: 0.2 },
  };

  const mediumSlick: TyresCompoundData = {
    name: 'LC-26 Clean-Room C3 Medium',
    shortName: 'M',
    tyre_compound: 'PhysicsTyreCompound_F1_Medium',
    front: {
      width: LC26_TYRE_DIMENSIONS.front.widthM,
      radius: LC26_TYRE_DIMENSIONS.front.unloadedRadiusM,
      rimRadius: 0.2286,
      verticalRateScale: 1.0,
    },
    rear: {
      width: LC26_TYRE_DIMENSIONS.rear.widthM,
      radius: LC26_TYRE_DIMENSIONS.rear.unloadedRadiusM,
      rimRadius: 0.2286,
      verticalRateScale: 1.07,
    },
    modelData: {
      Dy0: 1.92,
      Dx0: 1.98,
      lsExpY: 0.9,
      lsExpX: 0.91,
      Fz0: 3_500,
      friction_limit_angle: 5.5,
      pKy2: 2.1,
      slip_ratio_limit: 0.09,
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
      use_slip_falloff: true,
      falloff_level: 0.84,
      falloff_slope: 0.55,
      relaxationLengthX: 0.06,
      relaxationLengthY: 0.11,
      rollingResistance: 0.011,
      verticalDamping: 1_250,
    },
    thermalData: {
      thermalPerformanceCurve: [
        [20, 0.85],
        [70, 0.98],
        [95, 1.0],
        [115, 1.0],
        [145, 0.88],
      ],
      optimalTempC: [90, 112],
      surfaceHeatCapacity: 4_800,
      coreHeatCapacity: 24_000,
      slipHeatShare: 0.65,
      hysteresis: 0.008,
      surfaceToCore: 95,
      surfaceCooling: [24, 1.1],
      coreCooling: [8, 0.35],
      thermalVerticalK: 0.0005,
      thermalVerticalRefC: 95,
    },
    pressureData: {
      optimalPsi: 23.0,
      setPsi: 21.5,
      pressureSpringCurve: [
        [18, 305_000],
        [23, 360_000],
        [28, 415_000],
      ],
      pressureGripSensitivity: 0.35,
      coldRefC: 70,
    },
    camberData: {
      camberGain: 0.45,
      contact_camber_c1: 0.9,
      contact_camber_c2: 1.8,
      dcamber0: 0.22,
      dcamber1: -2.4,
      dcamber0_x: -0.15,
      dcamber1_x: -1.6,
    },
  };

  return {
    screenName: 'VeloSoft LC-26 Clean-Room Suspension Rig',
    drivenAxle: 'rear',
    chassis: LC26_CHASSIS_WITH_POWER_STEERING,
    suspensions: LC26_SUSPENSIONS_DATA,
    engine: {
      powerCurve: [
        [3800, 160],
        [7000, 315],
        [10500, 405],
        [12200, 398],
      ],
      coastCurve: [
        [3800, 55],
        [12200, 115],
      ],
      throttleResponseCurve: [
        [0, 0],
        [1, 1],
      ],
      idleRpm: 3800,
      inertia: 0.115,
      limiterCutS: 0.025,
    },
    ers: {
      torqueLut: [
        [0, 500],
        [9550, 350],
        [12200, 274],
      ],
      coastLut: [
        [0, 380],
        [12200, 274],
      ],
      ERS_MAX_DEPLOY: 350_000,
      maxHarvestW: 350_000,
      ERS_MAX_CHARGE: 4_000_000,
      deployPerLapJ: 4_000_000,
      harvestPerLapJ: 8_500_000,
      deployEfficiency: 0.95,
      harvestEfficiency: 0.93,
      liftThrottle: 0.08,
      topGearLiftHarvestW: 120_000,
    },
    performanceModes,
    gearbox: {
      ratios: [3.12, 2.42, 1.96, 1.63, 1.38, 1.19, 1.05, 0.94],
      reverse: 3.3,
      finalDrive: 3.62,
      shiftTimeS: 0.018,
      shiftTorqueFraction: 0.7,
      upshiftCutS: 0.015,
      efficiency: 0.965,
      gears: {
        redline_rpm: 12200,
        upshift_rpm: 11850,
        downshift_rpm: 9400,
        brake_downshift_rpm: 10300,
      },
    },
    clutch: {
      maxTorqueNm: 1_250,
      biteRpm: 4200,
      lockRpm: 5600,
    },
    differential: {
      type: 'LSD_Ramp',
      settings: {
        power: 0.36,
        coast: 0.24,
        preload: 85,
        friction_faces: 8,
        power_ramp_deg: 45,
        coast_ramp_deg: 60,
      },
      threePhase: true,
      diffEntryLevel: 4,
      diffMidLevel: 5,
      diffExitLevel: 6,
      hiSpdSwitchKmh: 250,
    },
    brakes: {
      maxTorqueNm: 5_400,
      brakeByWire: true,
      front_bias: 0.57,
      ebbStep: 0.005,
      discMaterial: 'carbon-ceramic',
      discStartTempC: 450,
      migration: { amount: 0.02, rampStart: 0.15 },
    },
    aero: {
      front_lift: 0.12,
      rear_lift: 0.14,
      drag: 0.42,
      dragCentreY: 0.06,
      front_target_height: LC26_FIA_DATUM_PLANES.staticFrontRideHeightM,
      rear_target_height: LC26_FIA_DATUM_PLANES.staticRearRideHeightM,
      floorOffsetY,
      plank: {
        y: floorOffsetY - LC26_PLANK_SPEC.thicknessNewMm / 1000,
        frontZ: LC26_PLANK_SPEC.strikes.frontSplitter.gltfStaticM[2],
        rearZ: LC26_PLANK_SPEC.strikes.rearTeaTray.gltfStaticM[2],
      },
      drsTransitionS: 0.35,
      drsCloseThrottle: 0.25,
      airDensity: 1.225,
      wings: [
        {
          name: 'FRONT_WING',
          area: 1.0,
          positionZ: 2.15,
          angleDeg: 4.0,
          heightRef: 'front',
          lutAOA_CL: [
            [0, 0.62],
            [4, 0.92],
            [8, 1.18],
          ],
          lutAOA_CD: [
            [0, 0.09],
            [4, 0.14],
            [8, 0.21],
          ],
          lutGH_CL_mult: [
            [0.005, 1.08],
            [0.020, 1.04],
            [0.050, 0.96],
          ],
          lutGH_CD_mult: [
            [0.005, 1.02],
            [0.050, 1.0],
          ],
          drs: { clMult: 0.46, cdMult: 0.52 },
        },
        {
          name: 'VENTURI_FLOOR',
          area: 1.0,
          positionZ: -0.18,
          angleDeg: 0,
          heightRef: 'mean',
          lutAOA_CL: [
            [-0.5, 1.95],
            [0.44, 2.18],
            [1.5, 2.05],
          ],
          lutAOA_CD: [
            [-0.5, 0.16],
            [0.44, 0.18],
            [1.5, 0.22],
          ],
          lutGH_CL_mult: [
            [0.006, 0.88],
            [0.018, 1.06],
            [0.035, 1.0],
            [0.065, 0.82],
          ],
          lutGH_CD_mult: [
            [0.006, 1.05],
            [0.035, 1.0],
            [0.065, 0.96],
          ],
        },
        {
          name: 'REAR_WING',
          area: 1.0,
          positionZ: -1.95,
          angleDeg: 6.0,
          heightRef: 'rear',
          lutAOA_CL: [
            [0, 0.48],
            [6, 0.78],
            [12, 1.02],
          ],
          lutAOA_CD: [
            [0, 0.12],
            [6, 0.24],
            [12, 0.36],
          ],
          lutGH_CL_mult: [
            [0.01, 1.0],
            [0.08, 1.0],
          ],
          lutGH_CD_mult: [
            [0.01, 1.0],
            [0.08, 1.0],
          ],
          drs: { clMult: 0.38, cdMult: 0.42 },
        },
      ],
    },
    tyreCompounds: {
      PhysicsTyreCompound_F1_Soft: mediumSlick,
      PhysicsTyreCompound_F1_Medium: mediumSlick,
      PhysicsTyreCompound_F1_Hard: mediumSlick,
      PhysicsTyreCompound_F1_Intermediate: mediumSlick,
      PhysicsTyreCompound_F1_Wet: mediumSlick,
    },
    compoundSlots: {
      soft: 'PhysicsTyreCompound_F1_Soft',
      medium: 'PhysicsTyreCompound_F1_Medium',
      hard: 'PhysicsTyreCompound_F1_Hard',
      intermediate: 'PhysicsTyreCompound_F1_Intermediate',
      wet: 'PhysicsTyreCompound_F1_Wet',
    },
  };
}

function stdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------------------
// 1. Static Mass, Inertia & 46.0% Weight Split Verification
// ---------------------------------------------------------------------------

function verifyStaticMassAndWeightDistribution(cfg: CarPhysicsConfig): string {
  const ch = LC26_SUSPENSION_MODULE.chassis;
  assert.equal(ch.totalMassKg, 768, 'Minimum dry+driver mass must equal 768 kg');
  assert.equal(ch.frontWeightFraction, 0.46, 'Static front weight distribution must equal 46.0%');
  const sprungKg = ch.totalMassKg - 2 * ch.unsprungMassFront - 2 * ch.unsprungMassRear;
  assert.equal(sprungKg, LC26_MASS_AND_INERTIA.sprungDryWithDriverKg, 'Sprung mass must equal 660 kg');

  const phys = new VehiclePhysics({ ground: FLAT_GROUND, config: cfg });
  phys.reset(0, 0, 0, 0);
  assert.equal(phys.stateIsSane(), true, 'VehiclePhysics static settle must remain finite & sane');

  const fzFront = phys.wheels[0].fz + phys.wheels[1].fz;
  const fzRear = phys.wheels[2].fz + phys.wheels[3].fz;
  const fzTotal = fzFront + fzRear;
  const expectedTotalN = 768 * GRAVITY_MS2;
  const frontShare = fzFront / fzTotal;

  assert.ok(
    Math.abs(fzTotal - expectedTotalN) < 1.5,
    `Total settled normal load ${fzTotal.toFixed(2)} N must match 768*g = ${expectedTotalN.toFixed(2)} N`,
  );
  const analyticalFrontN = 2 * computeLc26StaticSpringPreload('front').staticCornerTotalFzN;
  const analyticalRearN = 2 * computeLc26StaticSpringPreload('rear').staticCornerTotalFzN;
  assert.ok(
    Math.abs(analyticalFrontN / (analyticalFrontN + analyticalRearN) - 0.46) < 1e-12,
    'Analytical static front axle load fraction must equal exact 46.000%',
  );

  // Multibody 5-mass equilibrium: 660 kg sprung mass at 46.0% + 2*25.5 kg front / 2*28.5 kg rear unsprung hubs
  const expectedMultibodyShare = (0.46 * sprungKg + 2 * ch.unsprungMassFront) / ch.totalMassKg;
  assert.ok(
    Math.abs(frontShare - expectedMultibodyShare) < 0.0005 && Math.abs(frontShare - 0.46) < 0.002,
    `Settled 5-body front weight fraction ${(frontShare * 100).toFixed(3)}% must match ${
      (expectedMultibodyShare * 100).toFixed(3)
    }% (~46.0%)`,
  );

  // Step 0.2 s at rest so applyAero populates rideFront / rideRear (within ~1 mm road micro-texture)
  phys.step(0.2, { throttle: 0, brake: 1, steer: 0 });
  assert.ok(
    Math.abs(phys.telemetry.aeroHeightFront - 0.032) < 0.0012,
    `Settled static FRH ${(phys.telemetry.aeroHeightFront * 1000).toFixed(2)} mm must match 32.0 mm`,
  );
  assert.ok(
    Math.abs(phys.telemetry.aeroHeightRear - 0.058) < 0.0012,
    `Settled static RRH ${(phys.telemetry.aeroHeightRear * 1000).toFixed(2)} mm must match 58.0 mm`,
  );
  for (const w of phys.wheels) {
    assert.ok(
      Math.abs(w.compression) < 0.0012,
      `Static wheel ${w.name} compression ${(w.compression * 1000).toFixed(3)} mm must sit at datum`,
    );
  }

  return `768.0 kg (${(frontShare * 100).toFixed(2)}% F / ${((1 - frontShare) * 100).toFixed(2)}% R), static RH = ${(phys.telemetry.aeroHeightFront * 1000).toFixed(2)} / ${(phys.telemetry.aeroHeightRear * 1000).toFixed(2)} mm`;
}

// ---------------------------------------------------------------------------
// 2. 3D Front Pull-Rod & Rear Push-Rod Kinematics Verification
// ---------------------------------------------------------------------------

function verify3DKinematicsAndActuation(): string {
  const front0 = evaluateLc26AxleKinematics('front', 0, 0, 0);
  const rear0 = evaluateLc26AxleKinematics('rear', 0, 0, 0);

  // Contract static targets
  assert.ok(Math.abs(front0.kpiDeg - 7.70) < 0.05, `Front KPI ${front0.kpiDeg.toFixed(2)}° != 7.70°`);
  assert.ok(Math.abs(front0.casterDeg - 4.64) < 0.05, `Front caster ${front0.casterDeg.toFixed(2)}° != 4.64°`);
  assert.ok(Math.abs(front0.scrubRadiusMm - 24.6) < 0.15, `Front scrub ${front0.scrubRadiusMm.toFixed(2)} mm != 24.6 mm`);
  assert.ok(Math.abs(front0.mechanicalTrailMm - 20.4) < 0.15, `Front trail ${front0.mechanicalTrailMm.toFixed(2)} mm != 20.4 mm`);
  assert.ok(Math.abs(front0.rollCentreHeightM * 1000 - 25.5) < 0.5, `Front RC ${(front0.rollCentreHeightM * 1000).toFixed(2)} mm != 25.5 mm`);
  assert.ok(front0.antiDivePct > 45 && front0.antiDivePct < 85, `Front anti-dive ${front0.antiDivePct.toFixed(1)}% out of expected F1 range`);

  assert.ok(Math.abs(rear0.kpiDeg - 5.56) < 0.05, `Rear KPI ${rear0.kpiDeg.toFixed(2)}° != 5.56°`);
  assert.ok(Math.abs(rear0.casterDeg - 3.34) < 0.05, `Rear caster ${rear0.casterDeg.toFixed(2)}° != 3.34°`);
  assert.ok(Math.abs(rear0.rollCentreHeightM * 1000 - 68.9) < 0.5, `Rear RC ${(rear0.rollCentreHeightM * 1000).toFixed(2)} mm != 68.9 mm`);
  assert.ok(rear0.antiSquatPct > 45 && rear0.antiSquatPct < 75, `Rear anti-squat ${rear0.antiSquatPct.toFixed(1)}% out of expected F1 range`);

  // Jounce / rebound sweep [-35 mm, +45 mm]
  let prevFrontCamber = Infinity;
  let prevRearCamber = Infinity;
  let prevFrontMr = -Infinity;
  let prevRearMr = -Infinity;
  let maxFrontBumpSteerDeg = 0;
  let maxRearBumpSteerDeg = 0;

  for (let zMm = -35; zMm <= 45; zMm += 5) {
    const zM = zMm / 1000;
    const fKin = evaluateLc26AxleKinematics('front', zM, zM, 0);
    const rKin = evaluateLc26AxleKinematics('rear', zM, zM, 0);
    const fRod = evaluateLc26ActuationRod('front', zM, 0, true);
    const rRod = evaluateLc26ActuationRod('rear', zM, 0, true);

    assert.ok(
      fKin.leftTotalCamberDeg < prevFrontCamber,
      `Front camber must become more negative monotonically in jounce at ${zMm} mm`,
    );
    assert.ok(
      rKin.leftTotalCamberDeg < prevRearCamber,
      `Rear camber must become more negative monotonically in jounce at ${zMm} mm`,
    );
    prevFrontCamber = fKin.leftTotalCamberDeg;
    prevRearCamber = rKin.leftTotalCamberDeg;

    maxFrontBumpSteerDeg = Math.max(maxFrontBumpSteerDeg, Math.abs(fKin.leftBumpSteerToeInDeg));
    maxRearBumpSteerDeg = Math.max(maxRearBumpSteerDeg, Math.abs(rKin.leftBumpSteerToeInDeg));

    assert.ok(
      fRod.effectiveMotionRatio > prevFrontMr,
      `Front pull-rod motion ratio must rise progressively in jounce at ${zMm} mm`,
    );
    assert.ok(
      rRod.effectiveMotionRatio > prevRearMr,
      `Rear push-rod motion ratio must rise progressively in jounce at ${zMm} mm`,
    );
    prevFrontMr = fRod.effectiveMotionRatio;
    prevRearMr = rRod.effectiveMotionRatio;

    if (zMm > 0) {
      assert.ok(fRod.signedLengthDeltaM > 0, 'Front pull-rod must extend in tension under jounce');
      assert.ok(rRod.signedLengthDeltaM < 0, 'Rear push-rod must shorten in compression under jounce');
      assert.ok(rKin.leftBumpSteerToeInDeg > 0, 'Rear toe-link must induce slight stabilizing toe-in under bump');
    } else if (zMm < 0) {
      assert.ok(fRod.signedLengthDeltaM < 0, 'Front pull-rod must shorten under rebound droop');
      assert.ok(rRod.signedLengthDeltaM > 0, 'Rear push-rod must extend under rebound droop');
    }
  }

  assert.ok(maxFrontBumpSteerDeg < 0.085, `Front bump steer ${maxFrontBumpSteerDeg.toFixed(4)}° must stay < 0.085°`);
  assert.ok(maxRearBumpSteerDeg < 0.040, `Rear bump steer ${maxRearBumpSteerDeg.toFixed(4)}° must stay < 0.040°`);

  // Steering sweep [-18.75°, +18.75°]
  const lockLeft = evaluateLc26AxleKinematics('front', 0, 0, 18.75 * DEG2RAD);
  const lockRight = evaluateLc26AxleKinematics('front', 0, 0, -18.75 * DEG2RAD);

  // Left turn (+nominalSteer): left wheel is inside, right wheel is heavily-loaded outside wheel.
  // Modern F1 front-mounted rack (`tyreSteer.z = +0.112 m`) intentionally produces slight Anti-Ackermann
  // (~0.58° at full lock) so the heavily loaded outside slick reaches its higher peak slip angle without scrubbing the unloaded inner tyre.
  assert.ok(
    lockLeft.rightRoadSteerDeg > lockLeft.leftRoadSteerDeg &&
      lockLeft.rightRoadSteerDeg - lockLeft.leftRoadSteerDeg < 1.2,
    `F1 front-rack Anti-Ackermann required in left turn: outside ${lockLeft.rightRoadSteerDeg.toFixed(2)}° > inside ${lockLeft.leftRoadSteerDeg.toFixed(2)}°`,
  );
  // Right turn (-nominalSteer): right wheel is inside, left wheel is outside
  assert.ok(
    Math.abs(lockRight.leftRoadSteerDeg) > Math.abs(lockRight.rightRoadSteerDeg) &&
      Math.abs(lockRight.leftRoadSteerDeg) - Math.abs(lockRight.rightRoadSteerDeg) < 1.2,
    `F1 front-rack Anti-Ackermann required in right turn: outside ${Math.abs(lockRight.leftRoadSteerDeg).toFixed(2)}° > inside ${Math.abs(lockRight.rightRoadSteerDeg).toFixed(2)}°`,
  );
  // Symmetry check
  assert.ok(
    Math.abs(lockLeft.leftRoadSteerDeg + lockRight.rightRoadSteerDeg) < 1e-6,
    'Left/right Ackermann geometry must be anti-symmetric',
  );
  // Caster + KPI camber support on outside wheel in turn
  assert.ok(
    lockRight.leftTotalCamberDeg < front0.leftTotalCamberDeg,
    'Outside front wheel (FL in right turn) must gain negative camber from caster + KPI',
  );

  return `KPI ${front0.kpiDeg.toFixed(2)}°/${rear0.kpiDeg.toFixed(2)}°, Caster ${front0.casterDeg.toFixed(2)}°/${rear0.casterDeg.toFixed(2)}°, Scrub ${front0.scrubRadiusMm.toFixed(1)} mm, Trail ${front0.mechanicalTrailMm.toFixed(1)} mm, RC ${(front0.rollCentreHeightM * 1000).toFixed(1)}/${(rear0.rollCentreHeightM * 1000).toFixed(1)} mm, BumpSteerMax ${maxFrontBumpSteerDeg.toFixed(3)}°/${maxRearBumpSteerDeg.toFixed(3)}°`;
}

// ---------------------------------------------------------------------------
// 3. Torsion Bars, 3rd Heave Springs, Packers, ARBs & 4-Way Dampers
// ---------------------------------------------------------------------------

function verifySpringsPackersArbsAndDampers(): string {
  const fEq = computeLc26StaticSpringPreload('front');
  const rEq = computeLc26StaticSpringPreload('rear');
  const staticEval = evaluateLc26SuspensionForces({
    compressionM: [0, 0, 0, 0],
    compressionVelMs: [0, 0, 0, 0],
  });

  assert.ok(
    Math.abs(staticEval.corners[0].totalWheelForceN - fEq.staticCornerSprungLoadN) < 1e-6,
    'Static front suspension force must balance exact sprung corner weight',
  );
  assert.ok(
    Math.abs(staticEval.corners[2].totalWheelForceN - rEq.staticCornerSprungLoadN) < 1e-6,
    'Static rear suspension force must balance exact sprung corner weight',
  );
  assert.equal(staticEval.frontPackerEngaged, false, 'Front packer must not touch at static ride height');
  assert.equal(staticEval.rearPackerEngaged, false, 'Rear packer must not touch at static ride height');

  // Compare symmetric 7 mm front heave (packer engaged > 3.8 mm) vs 7 mm single-wheel warp (heave = 3.5 mm < 3.8 mm!)
  const symHeave7Mm = evaluateLc26SuspensionForces({
    compressionM: [0.007, 0.007, 0, 0],
    compressionVelMs: [0, 0, 0, 0],
  });
  const singleWheel7Mm = evaluateLc26SuspensionForces({
    compressionM: [0.007, 0, 0, 0],
    compressionVelMs: [0, 0, 0, 0],
  });
  assert.equal(symHeave7Mm.frontPackerEngaged, true, 'Front packer must engage in 7 mm symmetric aero heave');
  assert.equal(singleWheel7Mm.frontPackerEngaged, false, 'Front packer must stay clear in 7 mm single-wheel kerb warp');
  assert.ok(
    symHeave7Mm.corners[0].packerN > 2_500,
    'Symmetric aero heave past packer gap must build strong packer support',
  );

  // Verify 2000 Hz symplectic Euler stability margins (alpha = c_1w * subDt / m_u < 0.35)
  const subDt = LC26_SOLVER_RATES.innerSubDtS; // 0.0005 s
  const df = LC26_SUSPENSIONS_DATA.dampers_controller.front;
  const dr = LC26_SUSPENSIONS_DATA.dampers_controller.rear;
  const frontSlowReb1W =
    df.base.slow_rebound + 0.5 * df.roll.slow_rebound + 0.25 * df.heave.slow_rebound + 0.125 * df.pitch.slow_rebound;
  const rearSlowReb1W =
    dr.base.slow_rebound + 0.5 * dr.roll.slow_rebound + 0.25 * dr.heave.slow_rebound + 0.125 * dr.pitch.slow_rebound;
  const frontAlpha = (frontSlowReb1W * subDt) / LC26_CHASSIS_DATA.unsprungMassFront;
  const rearAlpha = (rearSlowReb1W * subDt) / LC26_CHASSIS_DATA.unsprungMassRear;
  assert.ok(frontAlpha < 0.30, `Front 2 kHz damper alpha ${frontAlpha.toFixed(3)} must be < 0.30`);
  assert.ok(rearAlpha < 0.30, `Rear 2 kHz damper alpha ${rearAlpha.toFixed(3)} must be < 0.30`);

  // ARB conversion & Garage setup round-trip
  const frontNmDeg = wheelRateNmToArbNmDeg(LC26_SUSPENSIONS_DATA.front.arb, LC26_CHASSIS_DATA.trackWidthFront);
  const roundTripArb = arbNmDegToWheelRateNm(frontNmDeg, LC26_CHASSIS_DATA.trackWidthFront);
  assert.ok(Math.abs(roundTripArb - LC26_SUSPENSIONS_DATA.front.arb) < 1e-6, 'ARB unit conversion must round-trip');

  const customGarage = applyLc26GarageSuspensionSetup({
    frontRideHeightMm: 30,
    rearRideHeightMm: 55,
    frontHeaveRateNmm: 420,
    rearHeaveRateNmm: 290,
    frontCornerRateNmm: 155,
    rearCornerRateNmm: 120,
    frontArbStiffnessNmDeg: 4_100,
    rearArbStiffnessNmDeg: 2_300,
    frontPackerGapMm: 5.0,
    rearPackerGapMm: 13.0,
    camberDeg: [-3.3, -3.3, -1.9, -1.9],
    toeDeg: [0.12, 0.20],
  });
  assert.equal(customGarage.suspensions.front.heave.rate, 420_000);
  assert.equal(customGarage.suspensions.front.springs.wheel_rate, 155_000);
  assert.ok(customGarage.staticToeInRad.front < 0 && customGarage.staticToeInRad.rear > 0);

  return `2 kHz damper alpha = ${frontAlpha.toFixed(3)} F / ${rearAlpha.toFixed(3)} R, ARB = ${frontNmDeg.toFixed(0)} / ${wheelRateNmToArbNmDeg(LC26_SUSPENSIONS_DATA.rear.arb, LC26_CHASSIS_DATA.trackWidthRear).toFixed(0)} Nm/deg`;
}

// ---------------------------------------------------------------------------
// 4. 345 km/h High-Downforce Platform Stability Verification
// ---------------------------------------------------------------------------

function verify345KmhPlatformStability(cfg: CarPhysicsConfig): string {
  const targetSpeedMs = 345 / 3.6; // 95.8333 m/s
  const phys = new VehiclePhysics({ ground: FLAT_GROUND, config: cfg });
  phys.reset(0, 0, 0, targetSpeedMs);
  assert.equal(phys.stateIsSane(), true, '345 km/h rolling settle must be sane');

  // Inject an 8 mm downward heave/pitch bump disturbance at 345 km/h to verify zero bottoming oscillation / porpoising
  phys.position.y -= 0.008;
  phys.velocity.y = -0.35;

  const frhTail: number[] = [];
  const rrhTail: number[] = [];
  let minFrh = Infinity;
  let minRrh = Infinity;
  let plankState = createInitialPlankWearState();

  const totalSteps = 1_500; // 3.0 s at 500 Hz = 6,000 inner 2 kHz substeps
  for (let i = 0; i < totalSteps; i++) {
    // Hold exact 345 km/h straight-line speed so aero dynamic pressure remains constant at 5.625 kPa
    phys.velocity.z = targetSpeedMs;
    phys.step(LC26_SOLVER_RATES.outerDtS, { throttle: 0.65, brake: 0, steer: 0 });
    assert.equal(phys.stateIsSane(), true, `Solver must stay sane at step ${i}`);

    const frh = phys.telemetry.aeroHeightFront;
    const rrh = phys.telemetry.aeroHeightRear;
    minFrh = Math.min(minFrh, frh);
    minRrh = Math.min(minRrh, rrh);

    // Steady-state tail after initial 8 mm impulse damps out (last 1.5 s)
    if (i >= 750) {
      frhTail.push(frh);
      rrhTail.push(rrh);
      plankState = LC26_SUSPENSION_MODULE.stepPlankWear(
        plankState,
        frh,
        rrh,
        phys.velocity.y,
        phys.speedMs,
        LC26_SOLVER_RATES.outerDtS,
      );
    }
  }

  const steadyFrhMm = (frhTail.reduce((a, b) => a + b, 0) / frhTail.length) * 1000;
  const steadyRrhMm = (rrhTail.reduce((a, b) => a + b, 0) / rrhTail.length) * 1000;
  const frhStdMm = stdDev(frhTail) * 1000;
  const rrhStdMm = stdDev(rrhTail) * 1000;

  assert.ok(steadyFrhMm > 8.0, `Steady 345 km/h Corner Mode FRH ${steadyFrhMm.toFixed(2)} mm must stay > 8.0 mm above ground`);
  assert.ok(steadyRrhMm > 22.0, `Steady 345 km/h Corner Mode RRH ${steadyRrhMm.toFixed(2)} mm must stay > 22.0 mm above ground`);
  assert.ok(frhStdMm < 0.15, `345 km/h FRH stdDev ${frhStdMm.toFixed(4)} mm must show zero bottoming oscillation (< 0.15 mm)`);
  assert.ok(rrhStdMm < 0.15, `345 km/h RRH stdDev ${rrhStdMm.toFixed(4)} mm must show zero porpoising (< 0.15 mm)`);
  assert.equal(plankState.frontSplitterMm, 10.0, 'Steady 345 km/h flat-asphalt running must not grind the titanium plank');

  // Now toggle Straight Mode (DRS/Active Aero flaps open) at 345 km/h and verify ride height rises cleanly
  phys.step(LC26_SOLVER_RATES.outerDtS, { throttle: 0.85, brake: 0, steer: 0, drs: true });
  for (let i = 0; i < 400; i++) {
    phys.velocity.z = targetSpeedMs;
    phys.step(LC26_SOLVER_RATES.outerDtS, { throttle: 0.85, brake: 0, steer: 0, drs: false });
  }
  const smFrhMm = phys.telemetry.aeroHeightFront * 1000;
  const smRrhMm = phys.telemetry.aeroHeightRear * 1000;
  assert.ok(
    smFrhMm > steadyFrhMm + 2.5 && smRrhMm > steadyRrhMm + 2.5,
    `Straight Mode RH (${smFrhMm.toFixed(1)}/${smRrhMm.toFixed(1)} mm) must rise cleanly above Corner Mode (${steadyFrhMm.toFixed(1)}/${steadyRrhMm.toFixed(1)} mm)`,
  );

  return `345 km/h CM RH = ${steadyFrhMm.toFixed(2)}/${steadyRrhMm.toFixed(2)} mm (osc stdDev = ${frhStdMm.toFixed(4)}/${rrhStdMm.toFixed(4)} mm), SM RH = ${smFrhMm.toFixed(2)}/${smRrhMm.toFixed(2)} mm`;
}

// ---------------------------------------------------------------------------
// 5. 32 mm Raised Serrated Kerb Impact Absorption at 2000 Hz
// ---------------------------------------------------------------------------

function create32MmKerbGround(kerbStartZ: number, kerbEndZ: number): GroundQuery {
  const kerbHeightM = 0.032; // Exact 32 mm FIA raised apex/exit kerb
  const rampLenM = 2.8; // ~3.5° shallow grazing entry/exit across FIA bevelled kerb face
  const blockPitchM = 1.15; // Standard FIA precast serrated kerb block pitch
  return {
    query(x: number, z: number, _probeFromY: number, out: GroundHit): boolean {
      let h = 0;
      let dhdz = 0;
      let dhdx = 0;

      // Left-side kerb under FL & RL wheels (x > 0.35 m)
      if (x > 0.35 && z >= kerbStartZ && z <= kerbEndZ) {
        const crossBlend = Math.min(1, (x - 0.35) / 0.18);
        let profile = 1;
        let dProfileDz = 0;
        if (z < kerbStartZ + rampLenM) {
          const u = (z - kerbStartZ) / rampLenM;
          profile = u * u * (3 - 2 * u);
          dProfileDz = (6 * u * (1 - u)) / rampLenM;
        } else if (z > kerbEndZ - rampLenM) {
          const u = (kerbEndZ - z) / rampLenM;
          profile = u * u * (3 - 2 * u);
          dProfileDz = -(6 * u * (1 - u)) / rampLenM;
        }
        // 1.5 mm serrated kerb block ripple along plateau
        const serration =
          profile > 0.95 ? 0.0015 * Math.sin(((z - kerbStartZ) * 2 * Math.PI) / blockPitchM) : 0;
        const dSerrationDz =
          profile > 0.95
            ? ((0.0015 * 2 * Math.PI) / blockPitchM) *
              Math.cos(((z - kerbStartZ) * 2 * Math.PI) / blockPitchM)
            : 0;
        h = crossBlend * (kerbHeightM * profile + serration);
        dhdz = crossBlend * (kerbHeightM * dProfileDz + dSerrationDz);
        dhdx = x < 0.53 ? (kerbHeightM * profile) / 0.18 : 0;
      }

      const invLen = 1 / Math.hypot(dhdx, 1, dhdz);
      const onKerb = h > 0.001;
      out.height = h;
      out.nx = -dhdx * invLen;
      out.ny = invLen;
      out.nz = -dhdz * invLen;
      out.surface = onKerb ? 'kerb' : 'road';
      out.grip = onKerb ? DEFAULT_SURFACE_TABLE.kerb.friction : DEFAULT_SURFACE_TABLE.road.friction;
      out.props = onKerb ? DEFAULT_SURFACE_TABLE.kerb : DEFAULT_SURFACE_TABLE.road;
      out.source = onKerb ? 'fia_32mm_kerb' : 'flat_asphalt';
      return true;
    },
  };
}

function verify32MmKerbAbsorptionAt2000Hz(cfg: CarPhysicsConfig): string {
  const kerbStartZ = 14.0;
  const kerbEndZ = 22.5;
  const kerbGround = create32MmKerbGround(kerbStartZ, kerbEndZ);
  const speedMs = 195 / 3.6; // 54.17 m/s fast corner-exit kerb strike

  const phys = new VehiclePhysics({ ground: kerbGround, config: cfg });
  phys.reset(0, 0, 0, speedMs);
  const baselineCgY = phys.position.y;

  let hitKerb = false;
  let minFlFzOnPlateau = Infinity;
  let maxFlCompressionMm = 0;
  let maxFlTyreDeflectionMm = 0;
  let maxHubVyAbs = 0;
  const postKerbCgY: number[] = [];

  // Run 1.5 s (750 outer steps = 3,000 inner 2000 Hz substeps) across and well past the 32 mm kerb
  for (let step = 0; step < 750; step++) {
    phys.velocity.z = speedMs;
    phys.step(LC26_SOLVER_RATES.outerDtS, { throttle: 0.45, brake: 0, steer: 0 });
    assert.equal(phys.stateIsSane(), true, `2000 Hz kerb integration must stay sane at step ${step}`);

    const fl = phys.wheels[0];
    maxFlCompressionMm = Math.max(maxFlCompressionMm, fl.compression * 1000);
    maxFlTyreDeflectionMm = Math.max(maxFlTyreDeflectionMm, fl.deflection * 1000);
    maxHubVyAbs = Math.max(maxHubVyAbs, Math.abs(fl.hubVy));

    if (fl.hardpointWorld.z >= kerbStartZ + 2.9 && fl.hardpointWorld.z <= kerbEndZ - 2.9) {
      hitKerb = true;
      minFlFzOnPlateau = Math.min(minFlFzOnPlateau, fl.fz);
    }

    // More than 0.40 s after rear wheels clear the kerb (z - 1.564 > 22.5 + 21.7 = 44.2 m)
    if (phys.position.z > 47.5) {
      postKerbCgY.push(phys.position.y);
    }
  }

  assert.equal(hitKerb, true, 'FL wheel must traverse the 32 mm kerb plateau');
  assert.ok(
    minFlFzOnPlateau > 250,
    `FL wheel must maintain positive road contact across serrated 32 mm kerb without skipping (min Fz = ${minFlFzOnPlateau.toFixed(0)} N)`,
  );
  assert.ok(
    maxFlCompressionMm > 8.0 && maxFlCompressionMm < 38.0,
    `FL suspension compression ${maxFlCompressionMm.toFixed(1)} mm must absorb 32 mm kerb within travel`,
  );
  assert.ok(maxHubVyAbs < 5.0, `Hub vertical velocity ${maxHubVyAbs.toFixed(2)} m/s must not overshoot at 2000 Hz`);
  assert.ok(postKerbCgY.length > 50, 'Must record post-kerb recovery window');
  const postMaxOvershootMm = Math.max(...postKerbCgY.map((y) => Math.abs(y - baselineCgY))) * 1000;
  assert.ok(
    postMaxOvershootMm < 2.5,
    `Chassis CG must settle within 2.5 mm of baseline after clearing 32 mm kerb (got ${postMaxOvershootMm.toFixed(2)} mm)`,
  );

  return `32 mm kerb @ 195 km/h: max FL susp = ${maxFlCompressionMm.toFixed(1)} mm (tyre = ${maxFlTyreDeflectionMm.toFixed(1)} mm), min plateau Fz = ${minFlFzOnPlateau.toFixed(0)} N, post-kerb settle = ${postMaxOvershootMm.toFixed(2)} mm`;
}

// ---------------------------------------------------------------------------
// 6. 10 mm Ti-6Al-4V Plank Contact, Sliding Wear, Sparks & Legality (< 9.0 mm)
// ---------------------------------------------------------------------------

function verifyPlankContactWearAndStall(): string {
  const fresh = createInitialPlankWearState();
  const staticClearances = computeLc26PlankStrikeClearancesM(0.032, 0.058, fresh);

  assert.ok(
    Math.abs(staticClearances[0] - LC26_PLANK_SPEC.strikes.frontSplitter.gltfStaticM[1]) < 5e-5 &&
      Math.abs(staticClearances[1] - LC26_PLANK_SPEC.strikes.midFloor.gltfStaticM[1]) < 5e-5 &&
      Math.abs(staticClearances[2] - LC26_PLANK_SPEC.strikes.rearTeaTray.gltfStaticM[1]) < 5e-5,
    'Static plank clearances must match contract gltfStaticM[1] coordinates to < 0.05 mm',
  );

  const staticStep = stepLc26PlankWear(fresh, 0.032, 0.058, 0, 95.8, 0.002);
  assert.deepEqual(staticStep.strikeForcesN, [0, 0, 0], 'Clear plank must generate zero strike forces');
  assert.equal(staticStep.sparkIntensity01, 0, 'Clear plank must emit zero sparks');
  assert.equal(evaluateLc26PlankLegality(staticStep).isLegal, true);

  // Non-linear Ti-6Al-4V stiffness & damping directionality
  // At FRH = 0.004 m, RRH = 0.025 m -> frontSplitter refPlane = 0.00709 m -> penetration = 2.91 mm
  const hit2Mm = stepLc26PlankWear(fresh, 0.00491, 0.025, 0, 80, 0.002); // ~2.0 mm front penetration
  const hit4Mm = stepLc26PlankWear(fresh, 0.00291, 0.025, 0, 80, 0.002); // ~4.0 mm front penetration
  assert.ok(
    hit4Mm.strikeForcesN[0] > 2.05 * hit2Mm.strikeForcesN[0],
    `Non-linear Ti-6Al-4V strike stiffness required: F(4mm)=${hit4Mm.strikeForcesN[0].toFixed(0)} N > 2*F(2mm)=${(2 * hit2Mm.strikeForcesN[0]).toFixed(0)} N`,
  );

  const plungingHit = stepLc26PlankWear(fresh, 0.004, 0.025, -0.4, 80, 0.002);
  const reboundingHit = stepLc26PlankWear(fresh, 0.004, 0.025, +0.4, 80, 0.002);
  assert.ok(
    plungingHit.strikeForcesN[0] > reboundingHit.strikeForcesN[0],
    'Downward impact velocity must increase normal strike reaction above rebound',
  );

  // Archard sliding wear proportional to normalForce * speed * dt
  const wearV1 = stepLc26PlankWear(fresh, 0.004, 0.025, 0, 45, 0.002);
  const wearV2 = stepLc26PlankWear(fresh, 0.004, 0.025, 0, 90, 0.002);
  const worn1 = 10.0 - wearV1.frontSplitterMm;
  const worn2 = 10.0 - wearV2.frontSplitterMm;
  assert.ok(Math.abs(worn2 / worn1 - 2.0) < 1e-6, 'Plank wear must scale linearly with sliding speed');

  const stationaryStrike = stepLc26PlankWear(fresh, 0.004, 0.025, 0, 0, 0.002);
  assert.equal(stationaryStrike.frontSplitterMm, 10.0, 'Zero sliding speed must produce zero frictional wear');
  assert.equal(stationaryStrike.sparkIntensity01, 0, 'Zero sliding speed must produce zero sparks');

  // Simulate repeated high-speed bottoming strikes untilplank crosses < 9.0 mm DSQ threshold
  let state = fresh;
  let peakSparks = 0;
  let crossedIllegalAtStep = -1;
  for (let k = 0; k < 25_000; k++) {
    state = LC26_SUSPENSION_MODULE.stepPlankWear(state, 0.0032, 0.018, -0.05, 95.833, 0.002);
    assert.ok(state.sparkIntensity01 >= 0 && state.sparkIntensity01 <= 1, 'sparkIntensity01 must stay in [0, 1]');
    peakSparks = Math.max(peakSparks, state.sparkIntensity01);
    const leg = evaluateLc26PlankLegality(state);
    if (!leg.isLegal && crossedIllegalAtStep < 0 && leg.minThicknessMm < 8.99) {
      crossedIllegalAtStep = k;
      break;
    }
  }
  assert.ok(peakSparks > 0.75, `Heavy 345 km/h titanium skid strike must emit bright sparks (got ${peakSparks.toFixed(2)})`);
  assert.ok(crossedIllegalAtStep > 0, 'Extended heavy bottoming must wear plank below 9.0 mm FIA legality limit');
  const illegalReport = evaluateLc26PlankLegality(state);
  assert.equal(illegalReport.isLegal, false);
  assert.ok(illegalReport.minThicknessMm < 9.0 && illegalReport.maxWearMm > 1.0);

  // Spark cooling decay when car lifts clear of ground
  let cooled = state;
  for (let k = 0; k < 200; k++) {
    cooled = LC26_SUSPENSION_MODULE.stepPlankWear(cooled, 0.030, 0.055, 0, 95.833, 0.002);
  }
  assert.equal(cooled.sparkIntensity01, 0, 'Sparks must decay cleanly back to 0 once skids clear asphalt');

  // Floor stall trigger evaluation
  const attachedFlow = evaluateLc26FloorStallTrigger(0.015, 0.032);
  const chokedFlow = evaluateLc26FloorStallTrigger(0.0035, 0.011, plungingHit);
  assert.equal(attachedFlow.stallTriggered, false, 'Normal aero ride height must keep Venturi floor attached');
  assert.equal(chokedFlow.stallTriggered, true, 'Severe bottoming must trigger Venturi throat stall');
  assert.ok(chokedFlow.stallSeverity01 > 0.85, 'Deep bottoming must approach full throat choke');

  return `Non-linear strike OK, peak sparks = ${peakSparks.toFixed(2)}, DSQ < 9.0 mm triggered at ${illegalReport.minThicknessMm.toFixed(3)} mm (${illegalReport.maxWearMm.toFixed(3)} mm worn), throat stall = ${chokedFlow.stallSeverity01.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// 7. 500 Hz Kingpin WebHID FFB Curves & Straight-Ahead Stability
// ---------------------------------------------------------------------------

function lateralGripCurveFraction(slipRatioToPeak: number): number {
  const s = Math.abs(slipRatioToPeak);
  if (s <= 1) {
    // Smooth Magic-Formula / cubic-brush rising branch peaking at s = 1 with dF/ds(1) = 0
    return Math.sin(0.5 * Math.PI * s);
  }
  const d = s - 1;
  return 0.82 + 0.18 * Math.exp(-0.75 * d * d);
}

function verifyKingpinWebHidFfb(cfg: CarPhysicsConfig): string {
  const peakSlipDeg = 5.5;
  const muPeak = 1.88;
  const fzInside = 3_100;
  const fzOutside = 5_900;

  // A. Monotonic build-up to peak slip (0° -> 5.5°) and natural lightening past peak slip (5.5° -> 12.5°)
  const prePeakSamples: number[] = [];
  let zeroSlipTorque = 0;
  let peakGripTorqueNm = 0;
  let peakGripWebHid = 0;
  let understeer12DegTorqueNm = 0;
  let understeer12DegWebHid = 0;

  const slipAnglesDeg = [0, 0.5, 1.0, 2.0, 3.0, 4.0, 4.8, 5.5, 6.5, 8.0, 10.0, 12.5];
  for (const alphaDeg of slipAnglesDeg) {
    const s = alphaDeg / peakSlipDeg;
    const fShape = lateralGripCurveFraction(s);
    // Right-hand cornering: road pushes tyres RIGHT (-Fy), steer wheel turned right (+steerNorm)
    const fyFl = -muPeak * fzOutside * fShape; // FL is outside wheel in right turn
    const fyFr = -muPeak * fzInside * fShape;
    const mzFl = computeLc26FrontPneumaticAligningNm(fyFl, fzOutside, s);
    const mzFr = computeLc26FrontPneumaticAligningNm(fyFr, fzInside, s);

    const out = LC26_SUSPENSION_MODULE.computeKingpinFfb({
      dtS: LC26_SOLVER_RATES.outerDtS,
      speedMs: 240 / 3.6,
      steeringWheelNormalized: Math.min(0.65, (alphaDeg / 18.75) * 1.35),
      frontLateralForceN: [fyFl, fyFr],
      frontLongitudinalForceN: [0, 0],
      frontVerticalLoadN: [fzOutside, fzInside],
      frontPneumaticAligningNm: [mzFl, mzFr],
      frontHeaveM: [0.007, 0.004],
    });

    if (alphaDeg === 0) {
      // At zero slip with asymmetric vertical load only if steered=0, wait: here steerNorm=0 and Fz differs if mid-roll,
      // check symmetric straight-ahead separately below
      zeroSlipTorque = out.columnTorqueNm;
    }
    if (alphaDeg <= peakSlipDeg) {
      prePeakSamples.push(out.columnTorqueNm);
    }
    if (alphaDeg === peakSlipDeg) {
      peakGripTorqueNm = out.columnTorqueNm;
      peakGripWebHid = out.webHidNormalized;
    }
    if (alphaDeg === 12.5) {
      understeer12DegTorqueNm = out.columnTorqueNm;
      understeer12DegWebHid = out.webHidNormalized;
    }
    if (alphaDeg > 0) {
      assert.ok(out.columnTorqueNm > 0, `Right-turn self-aligning column torque must stay > 0 at ${alphaDeg}°`);
      assert.ok(out.rackForceN > 0, `Right-turn steering rack force must stay > 0 at ${alphaDeg}°`);
    }
  }

  for (let i = 1; i < prePeakSamples.length; i++) {
    assert.ok(
      prePeakSamples[i] > prePeakSamples[i - 1],
      `Column FFB torque must build strictly monotonically up to peak grip (step ${i}: ${prePeakSamples[i].toFixed(3)} <= ${prePeakSamples[i - 1].toFixed(3)})`,
    );
  }
  assert.ok(
    peakGripTorqueNm > 9.5 && peakGripTorqueNm < LC26_WEBHID_NOMINAL_MAX_TORQUE_NM,
    `Peak grip column torque ${peakGripTorqueNm.toFixed(2)} Nm must sit cleanly inside 9.5..15.0 Nm DD window without clipping`,
  );
  assert.ok(peakGripWebHid > 0.63 && peakGripWebHid < 1.0, 'Peak grip WebHID command must not flat-top at 1.0');
  assert.ok(
    understeer12DegTorqueNm < 0.70 * peakGripTorqueNm && understeer12DegTorqueNm > 2.5,
    `Front understeer at 12.5° (${understeer12DegTorqueNm.toFixed(2)} Nm) must lighten >30% below peak (${peakGripTorqueNm.toFixed(2)} Nm) without sign flip`,
  );
  assert.ok(understeer12DegWebHid < 0.70 * peakGripWebHid);
  void zeroSlipTorque;

  // B. Natural FFB lightening in Straight Mode vs Corner Mode (310 km/h fast sweep at 2.2° slip)
  const sFast = 2.2 / peakSlipDeg;
  const shapeFast = lateralGripCurveFraction(sFast);
  const evalModeFfb = (fzLeft: number, fzRight: number, heaveM: number) => {
    const fyL = -muPeak * fzLeft * shapeFast;
    const fyR = -muPeak * fzRight * shapeFast;
    return computeLc26KingpinFfb({
      dtS: 0.002,
      speedMs: 310 / 3.6,
      steeringWheelNormalized: 0.16,
      frontLateralForceN: [fyL, fyR],
      frontLongitudinalForceN: [0, 0],
      frontVerticalLoadN: [fzLeft, fzRight],
      frontPneumaticAligningNm: [
        computeLc26FrontPneumaticAligningNm(fyL, fzLeft, sFast),
        computeLc26FrontPneumaticAligningNm(fyR, fzRight, sFast),
      ],
      frontHeaveM: [heaveM, heaveM],
    });
  };
  const cornerModeFfb = evalModeFfb(5_200, 3_800, 0.0072);
  const straightModeFfb = evalModeFfb(3_100, 2_300, 0.0048);
  assert.ok(
    straightModeFfb.columnTorqueNm < 0.72 * cornerModeFfb.columnTorqueNm,
    `Straight Mode FFB (${straightModeFfb.columnTorqueNm.toFixed(2)} Nm) must lighten >28% vs Corner Mode (${cornerModeFfb.columnTorqueNm.toFixed(2)} Nm)`,
  );

  // C. Asymmetric kerb strike impulse vs symmetric straight-line load cancellation
  const straight345 = LC26_SUSPENSION_MODULE.computeKingpinFfb({
    dtS: 0.002,
    speedMs: 345 / 3.6,
    steeringWheelNormalized: 0,
    frontLateralForceN: [0, 0],
    frontLongitudinalForceN: [-180, -180],
    frontVerticalLoadN: [6_400, 6_400],
    frontPneumaticAligningNm: [0, 0],
    frontHeaveM: [0.0075, 0.0075],
  });
  assert.equal(straight345.columnTorqueNm, 0, 'Balanced straight-ahead 345 km/h kingpin torque must equal exact 0 Nm');
  assert.equal(straight345.webHidNormalized, 0, 'Balanced straight-ahead 345 km/h WebHID output must equal exact 0');

  const leftKerbTug = LC26_SUSPENSION_MODULE.computeKingpinFfb({
    dtS: 0.002,
    speedMs: 220 / 3.6,
    steeringWheelNormalized: 0,
    frontLateralForceN: [0, 0],
    frontLongitudinalForceN: [0, 0],
    frontVerticalLoadN: [4_000, 4_000],
    frontPneumaticAligningNm: [0, 0],
    frontHeaveM: [0.018, 0.004],
    frontKerbImpulseN: [3_500, 0],
  });
  assert.ok(
    Math.abs(leftKerbTug.columnTorqueNm) > 0.4,
    `One-wheel 3.5 kN kerb impulse must transmit physical KPI/scrub tug to steering column (got ${leftKerbTug.columnTorqueNm.toFixed(2)} Nm)`,
  );
  assert.ok(
    Math.abs(leftKerbTug.columnTorqueNm) <= LC26_POWER_STEERING.deadbandNm * 2.5,
    'One-wheel kerb impulse must remain realistic without violent DD spike',
  );

  // D. Live 500 Hz straight-ahead run at 345 km/h: zero sign-flip center oscillation
  //    1) Pure LC-26 kingpin solver under live 345 km/h heave/pitch oscillation -> exact 0 Nm & 0 sign flips
  //    2) Full VehiclePhysics (which adds procedural ~0.2 mm asphalt grain texture) -> 0 chatter sign flips > 0.01 norm
  const phys = new VehiclePhysics({ ground: FLAT_GROUND, config: cfg });
  phys.reset(0, 0, 0, 345 / 3.6);
  const liveSamples: number[] = [];
  let chatterSignFlips = 0;
  let kingpinDirectMaxAbs = 0;

  for (let i = 0; i < 500; i++) {
    phys.velocity.z = 345 / 3.6;
    phys.step(LC26_SOLVER_RATES.outerDtS, { throttle: 0.65, brake: 0, steer: 0 });
    const meanHeave = 0.5 * (phys.wheels[0].compression + phys.wheels[1].compression);
    const meanFz = 0.5 * (phys.wheels[0].fz + phys.wheels[1].fz);
    const meanFx = 0.5 * (phys.wheels[0].fx + phys.wheels[1].fx);
    const directCenter = LC26_SUSPENSION_MODULE.computeKingpinFfb({
      dtS: LC26_SOLVER_RATES.outerDtS,
      speedMs: phys.speedMs,
      steeringWheelNormalized: 0,
      frontLateralForceN: [0, 0],
      frontLongitudinalForceN: [meanFx, meanFx],
      frontVerticalLoadN: [meanFz, meanFz],
      frontPneumaticAligningNm: [0, 0],
      frontHeaveM: [meanHeave, meanHeave],
    });
    kingpinDirectMaxAbs = Math.max(kingpinDirectMaxAbs, Math.abs(directCenter.columnTorqueNm));

    const sub = phys.takeFfbSubframeSamples();
    for (const sVal of sub) {
      if (liveSamples.length > 0) {
        const prev = liveSamples[liveSamples.length - 1];
        // Above procedural road-grain micro-texture (~0.002), zero center chatter sign flips may occur
        if (Math.abs(prev) > 0.008 && Math.abs(sVal) > 0.008 && prev * sVal < 0) {
          chatterSignFlips++;
        }
      }
      liveSamples.push(sVal);
    }
  }
  const maxCenterAbs = Math.max(...liveSamples.map(Math.abs));
  assert.ok(kingpinDirectMaxAbs < 1e-6, `Symmetric kingpin center torque must remain ~0 Nm (got ${kingpinDirectMaxAbs})`);
  assert.equal(
    chatterSignFlips,
    0,
    `Straight-ahead 345 km/h 500 Hz FFB must exhibit zero sign-flip chatter (got ${chatterSignFlips})`,
  );
  assert.ok(
    maxCenterAbs < 0.04,
    `Straight-ahead 345 km/h FFB center road-grain amplitude ${maxCenterAbs.toFixed(6)} must stay < 0.04 (< 0.6 Nm)`,
  );

  return `Peak = ${peakGripTorqueNm.toFixed(2)} Nm -> 12.5° understeer = ${understeer12DegTorqueNm.toFixed(2)} Nm (-${((1 - understeer12DegTorqueNm / peakGripTorqueNm) * 100).toFixed(1)}%), SM = ${straightModeFfb.columnTorqueNm.toFixed(2)} Nm vs CM = ${cornerModeFfb.columnTorqueNm.toFixed(2)} Nm, 345 km/h center chatter flips = ${chatterSignFlips} (road-grain max |ffb| = ${maxCenterAbs.toFixed(5)})`;
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

function main(): void {
  const cfg = buildCleanRoomLc26TestConfig();

  const r1 = verifyStaticMassAndWeightDistribution(cfg);
  console.log(`[PASS] 1. Mass & Static Weight Split: ${r1}`);

  const r2 = verify3DKinematicsAndActuation();
  console.log(`[PASS] 2. 3D Wishbone + Tie-Rod + Pull/Pushrod Kinematics: ${r2}`);

  const r3 = verifySpringsPackersArbsAndDampers();
  console.log(`[PASS] 3. Torsion Bars, 3rd Heave, Packers, ARBs & 4-Way Dampers: ${r3}`);

  const r4 = verify345KmhPlatformStability(cfg);
  console.log(`[PASS] 4. 345 km/h High-Downforce Platform Stability: ${r4}`);

  const r5 = verify32MmKerbAbsorptionAt2000Hz(cfg);
  console.log(`[PASS] 5. 32 mm Raised Kerb Absorption @ 2000 Hz: ${r5}`);

  const r6 = verifyPlankContactWearAndStall();
  console.log(`[PASS] 6. 10 mm Ti-6Al-4V Plank Contact, Wear, Sparks & Legality: ${r6}`);

  const r7 = verifyKingpinWebHidFfb(cfg);
  console.log(`[PASS] 7. 500 Hz Kingpin WebHID FFB & Hydraulic Boost: ${r7}`);

  console.log('\nALL 7 LC-26 SUSPENSION, PLANK WEAR & 500 HZ KINGPIN FFB VERIFICATION SUITES PASSED.');
}

main();
