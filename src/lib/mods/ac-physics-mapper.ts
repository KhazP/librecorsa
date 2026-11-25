/**
 * Maps parsed Assetto Corsa INI files and LUT tables into a LibreCorsa `CarPhysicsConfig`.
 * Supports both modern AC tyre data (version >= 10) and legacy tyre models, single and multi-ratio
 * transmissions, aero elements, and suspensions (strut and double wishbone).
 */

import type { LutPoints } from '@/lib/sim/lut';
import {
  turboSteadyBoost,
  type AeroData,
  type CarPhysicsConfig,
  type ChassisData,
  type ClutchData,
  type CompoundSlot,
  type DamperControllerData,
  type DamperSettingsUnits,
  type DifferentialData,
  type EngineData,
  type ERSData,
  type GearBoxData,
  type PerformanceModeData,
  type PerformanceModeName,
  type PhysicsTyreCompound,
  type SuspensionsData,
  type TurboData,
  type TyreGeometry,
  type TyresCompoundData,
  type WingData,
} from '@/lib/sim/f12026-car/F12026CarConfig';
import { modBodyHeightM, modCornerStops } from '@/lib/sim/mod-suspension';
import { mapAcCameras } from './ac-cameras';
import type { AcModData } from './ac-data-decrypt';
import { mapAcAeroSystems, mapAcHeatRecovery, mapAcKineticDrive } from './ac-systems';
import { acTurboReferenceRpm } from './ac-turbo';
import { peakDriveSlipRatio } from './ac-tyre-shape';

const G = 9.81;
const DRIVELINE_EFFICIENCY = 0.92;

const ZERO_DAMPER: DamperSettingsUnits = {
  slow_bump: 0,
  fast_bump: 0,
  slow_rebound: 0,
  fast_rebound: 0,
};

const createPerformanceMode = (name: PerformanceModeName): PerformanceModeData => ({
  performance_mode_name: name,
  deployFraction: 0,
  deployVsSpeed: [
    [0, 0],
    [400, 0],
  ],
  socFloor: 0,
  brakeHarvestScale: 0,
  liftHarvestScale: 0,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: 1,
  ebbOffset: 0,
});

/**
 * Builds a CarPhysicsConfig from parsed Assetto Corsa mod data.
 */
export function mapAcPhysics(mod: AcModData): CarPhysicsConfig {
  const car = (sec: string, key: string, fallback = NaN) => mod.num('car.ini', sec, key, fallback);
  const sus = (sec: string, key: string, fallback = NaN) => mod.num('suspensions.ini', sec, key, fallback);
  const drv = (sec: string, key: string, fallback = NaN) => mod.num('drivetrain.ini', sec, key, fallback);
  const eng = (sec: string, key: string, fallback = NaN) => mod.num('engine.ini', sec, key, fallback);
  const tyr = (sec: string, key: string, fallback = NaN) => mod.num('tyres.ini', sec, key, fallback);

  const screenName = mod.text('car.ini', 'INFO', 'SCREEN_NAME') || 'Imported AC Mod';

  // 1. Chassis and static weight distribution
  const totalMass = car('BASIC', 'TOTALMASS', 1250);
  const inertiaVec = mod.vec('car.ini', 'BASIC', 'INERTIA');
  const boxW = inertiaVec[0] || 1.8;
  const boxH = inertiaVec[1] || 1.2;
  const boxL = inertiaVec[2] || 4.2;

  const box = (a: number, b: number) => (totalMass / 12) * (a * a + b * b);

  const wheelbase = sus('BASIC', 'WHEELBASE', 2.6);
  const frontShare = sus('BASIC', 'CG_LOCATION', 0.52);
  const hubF = sus('FRONT', 'HUB_MASS', 45);
  const hubR = sus('REAR', 'HUB_MASS', 45);
  const sprungKg = Math.max(100, totalMass - 2 * hubF - 2 * hubR);

  // Corner stops and body ride height
  const axleStopsAndHeight = (axleName: 'FRONT' | 'REAR') => {
    const share = axleName === 'FRONT' ? frontShare : 1 - frontShare;
    const heaveSec = `HEAVE_${axleName}`;
    const heaveSpring = sus(heaveSec, 'SPRING_RATE');
    const hasHeave = Number.isFinite(heaveSpring) && heaveSpring > 0;
    const staticLoadN = (sprungKg * G * share) / 2;

    const stops = modCornerStops({
      staticLoadN,
      springRate: sus(axleName, 'SPRING_RATE', 50_000),
      rodLength: sus(axleName, 'ROD_LENGTH', 0),
      packerRange: sus(axleName, 'PACKER_RANGE', 0.1),
      bumpStopUp: sus(axleName, 'BUMPSTOP_UP', 0.08),
      bumpStopDn: sus(axleName, 'BUMPSTOP_DN', 0.08),
      heave: hasHeave
        ? {
            springRate: heaveSpring,
            rodLength: sus(heaveSec, 'ROD_LENGTH', 0),
            packerRange: sus(heaveSec, 'PACKER_RANGE', 0.1),
            bumpStopUp: sus(heaveSec, 'BUMPSTOP_UP', 0.08),
          }
        : undefined,
    });

    const tyreRate = tyr(axleName, 'RATE', 220_000);
    const cornerN = staticLoadN + (axleName === 'FRONT' ? hubF : hubR) * G;
    const tyreRadius = tyr(axleName, 'RADIUS', 0.32);
    const baseY = sus(axleName, 'BASEY', -0.15);
    const bodyHeight = modBodyHeightM(tyreRadius, cornerN / tyreRate, baseY, stops.staticOffsetM);

    return { stops, bodyHeight, hasHeave, heaveSec };
  };

  const frontAxle = axleStopsAndHeight('FRONT');
  const rearAxle = axleStopsAndHeight('REAR');
  const cgHeight = frontAxle.bodyHeight + (rearAxle.bodyHeight - frontAxle.bodyHeight) * (1 - frontShare);

  const tankPos = mod.vec('car.ini', 'FUELTANK', 'POSITION');
  const steerLock = car('CONTROLS', 'STEER_LOCK', 360);
  const steerRatio = car('CONTROLS', 'STEER_RATIO', 14);
  const isFormula = totalMass < 950;
  // For open-wheel/formula cars, cap maxRoadWheelDeg at 16.5° and steerRatio at >= 14.5
  // to avoid violent high-speed snap oversteer with wheel inputs at 250+ km/h
  const effectiveSteerRatio = isFormula ? Math.max(14.5, steerRatio || 14.5) : (steerRatio || 14);
  const rawMaxRoadWheelDeg = steerLock / effectiveSteerRatio;
  const maxRoadWheelDeg = isFormula
    ? Math.min(16.5, rawMaxRoadWheelDeg)
    : Number.isFinite(rawMaxRoadWheelDeg) && rawMaxRoadWheelDeg > 0
      ? rawMaxRoadWheelDeg
      : 28;

  const chassis: ChassisData & { steerLockDeg?: number; steerRatio?: number } = {
    totalMassKg: totalMass,
    frontWeightFraction: frontShare,
    wheelbase,
    trackWidthFront: sus('FRONT', 'TRACK', 1.5),
    trackWidthRear: sus('REAR', 'TRACK', 1.5),
    cgHeight: Number.isFinite(cgHeight) && cgHeight > 0 ? cgHeight : 0.35,
    inertia: {
      pitch: box(boxH, boxL),
      roll: box(boxW, boxH),
      yaw: box(boxW, boxL),
    },
    unsprungMassFront: hubF,
    unsprungMassRear: hubR,
    wheelInertiaFront: tyr('FRONT', 'ANGULAR_INERTIA', 1.2),
    wheelInertiaRear: tyr('REAR', 'ANGULAR_INERTIA', 1.2),
    maxRoadWheelDeg: Number.isFinite(maxRoadWheelDeg) && maxRoadWheelDeg > 0 ? maxRoadWheelDeg : 28,
    ffbMechanicalTrailM: 0.015,
    steerLockDeg: isFormula ? 360 : steerLock,
    steerRatio: effectiveSteerRatio,
    ...(tankPos.length === 3 ? { fuelTank: { y: tankPos[1], z: tankPos[2] } } : {}),
  };

  // 2. Engine and Powertrain
  const authoredTorque = mod.lutOf('engine.ini', 'HEADER', 'POWER_CURVE');
  let rawWheelTorque = authoredTorque.length ? authoredTorque : mod.lut('power.lut');
  const kineticDrive = mapAcKineticDrive(mod, rawWheelTorque);
  const electric = kineticDrive?.importedDrive?.electric === true;
  if (!rawWheelTorque.length) {
    const defaultRpm = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000];
    rawWheelTorque = defaultRpm.map((rpm) => [rpm, rpm === 0 ? 0 : 250]);
  }

  // Helper to interpolate a LUT table [x, y][]
  const evalLut = (lut: [number, number][], x: number): number => {
    if (!lut || lut.length === 0) return 0;
    if (x <= lut[0][0]) return lut[0][1];
    if (x >= lut[lut.length - 1][0]) return lut[lut.length - 1][1];
    for (let i = 0; i < lut.length - 1; i++) {
      const [x0, y0] = lut[i];
      const [x1, y1] = lut[i + 1];
      if (x >= x0 && x <= x1) {
        const t = (x - x0) / (x1 - x0 || 1);
        return y0 + t * (y1 - y0);
      }
    }
    return lut[lut.length - 1][1];
  };

  // Check for turbo controllers ctrl_turbo0.ini, ctrl_turbo1.ini, etc.
  const ctrlTurbos: [number, number][][] = [];
  for (let i = 0; i < 4; i++) {
    const ctrlLut = mod.lutOf(`ctrl_turbo${i}.ini`, 'CONTROLLER_0', 'LUT');
    if (ctrlLut.length > 0) {
      ctrlTurbos.push(ctrlLut);
    }
  }

  // Parse Turbocharger if present in engine.ini or via ctrl_turbo files
  let turbo: TurboData | undefined;
  const rawMaxBoost = eng('TURBO_0', 'MAX_BOOST');
  const wastegate0 = eng('TURBO_0', 'WASTEGATE');
  const wastegate1 = eng('TURBO_1', 'WASTEGATE');
  const hasTurbos =
    (Number.isFinite(rawMaxBoost) && rawMaxBoost > 0) ||
    (Number.isFinite(wastegate0) && wastegate0 > 0) ||
    ctrlTurbos.length > 0;

  if (hasTurbos) {
    let effectiveMaxBoost = 0;
    if (ctrlTurbos.length > 0) {
      for (let rpm = 500; rpm <= 8500; rpm += 250) {
        let b = 0;
        for (const lut of ctrlTurbos) b += evalLut(lut, rpm);
        if (b > effectiveMaxBoost) effectiveMaxBoost = b;
      }
    } else {
      effectiveMaxBoost = Math.max(
        rawMaxBoost || 0,
        wastegate0 || 0,
        (wastegate0 || 0) + (wastegate1 || 0)
      );
    }

    if (effectiveMaxBoost > 0) {
      const refRpm = acTurboReferenceRpm(eng('TURBO_0', 'REFERENCE_RPM', 3000));
      const gamma = eng('TURBO_0', 'GAMMA', 1.0);
      const lagUp = eng('TURBO_0', 'LAG_UP', 0.96);
      const lagDn = eng('TURBO_0', 'LAG_DN', 0.99);
      const displayMax = eng('TURBO_0', 'DISPLAY_MAX_BOOST', effectiveMaxBoost);
      const lagSeconds = (lag: number) => Number((1 / (Math.max(1e-4, 1 - lag) * 444)).toFixed(4));
      turbo = {
        maxBoost: effectiveMaxBoost,
        referenceRpm: refRpm,
        gamma,
        spoolUpS: lagSeconds(lagUp),
        spoolRefRpm: refRpm,
        spoolDownS: lagSeconds(lagDn),
        displayMaxBoostBar: displayMax,
        throttleInBoostLaw: true,
      };
    }
  }

  const powerCurve: LutPoints = rawWheelTorque.map(([rpm, nm]) => {
    let boostMult = 1;
    if (ctrlTurbos.length > 0) {
      let ctrlBoost = 0;
      for (const lut of ctrlTurbos) ctrlBoost += evalLut(lut, rpm);
      boostMult = 1 + ctrlBoost;
    } else if (turbo) {
      boostMult = 1 + turboSteadyBoost(turbo, rpm);
    }
    return [
      rpm,
      (((nm * boostMult) / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000,
    ];
  });

  const coastRpm = eng('COAST_REF', 'RPM', 7000);
  const coastTorque = electric ? 0 : eng('COAST_REF', 'TORQUE', 80);
  const coastCurve: LutPoints = [
    [0, 0],
    [coastRpm, coastTorque],
  ];

  let throttleCurve = mod.lut('throttle.lut');
  let throttleResponseCurve: LutPoints;
  if (throttleCurve.length) {
    throttleResponseCurve = throttleCurve.map(([x, y]) => [x > 1 ? x / 100 : x, y > 1 ? y / 100 : y]);
  } else {
    throttleResponseCurve = [
      [0, 0],
      [0.2, 0.2],
      [0.5, 0.5],
      [1, 1],
    ];
  }

  const idleRpm = eng('ENGINE_DATA', 'MINIMUM', 850);
  const limiterHz = eng('ENGINE_DATA', 'LIMITER_HZ', 40);
  const engineInertia = eng('ENGINE_DATA', 'INERTIA', 0.15) + (drv('GEARBOX', 'INERTIA', 0.02) || 0.02);

  const engine: EngineData = {
    powerCurve: electric ? [[0, 0]] : powerCurve,
    coastCurve,
    throttleResponseCurve,
    idleRpm: electric ? 0 : idleRpm,
    inertia: engineInertia,
    limiterCutS: 0.5 / (limiterHz || 40),
    airDensitySensitivity: 0.1,
    ...(turbo && !electric ? { turbo } : {}),
  };

  // 3. Gearbox and Transmission
  const gearCount = drv('GEARS', 'COUNT', 5);
  const ratios: number[] = [];
  for (let i = 1; i <= gearCount; i++) {
    const r = drv('GEARS', `GEAR_${i}`);
    if (Number.isFinite(r)) ratios.push(r);
  }
  if (!ratios.length) ratios.push(3.5, 2.1, 1.4, 1.0, 0.8);

  const finalDrive = drv('GEARS', 'FINAL', 3.8);
  const reverse = Math.abs(drv('GEARS', 'GEAR_R', -3.2));
  const autoCutoffMs = drv('GEARBOX', 'AUTO_CUTOFF_TIME', 0);
  const shiftTimeS = Math.max(drv('GEARBOX', 'CHANGE_UP_TIME', 200), autoCutoffMs) / 1000;
  const upshiftCutS = autoCutoffMs / 1000;
  // The ordinary torque dip leaves the engine coupled. Only use the managed cut (which also matches revs)
  // when the mod explicitly rules out an H-pattern shifter and opts into an ignition cut.
  const managedUpshift = drv('GEARBOX', 'SUPPORTS_SHIFTER') === 0 && upshiftCutS > 0;
  const downshiftTimeS = drv('GEARBOX', 'CHANGE_DN_TIME', 250) / 1000;
  const redline = eng('ENGINE_DATA', 'LIMITER', 7000);
  const upshiftCandidate = drv('AUTO_SHIFTER', 'UP', redline * 0.92);
  // Ensure auto-upshift triggers safely before engine limiter cuts ignition
  const upshiftRpm = Math.min(upshiftCandidate, redline - 150);
  const downshiftRpm = drv('AUTO_SHIFTER', 'DOWN', redline * 0.45);

  const gearbox: GearBoxData = {
    ratios,
    reverse,
    finalDrive,
    shiftTimeS: shiftTimeS > 0 ? shiftTimeS : 0.2,
    downshiftTimeS: downshiftTimeS > 0 ? downshiftTimeS : 0.25,
    shiftTorqueFraction: 0,
    ...(managedUpshift ? { upshiftCutS } : {}),
    efficiency: DRIVELINE_EFFICIENCY,
    gears: {
      redline_rpm: redline,
      upshift_rpm: upshiftRpm,
      downshift_rpm: downshiftRpm,
      brake_downshift_rpm: redline * 0.75,
      spin_upshift: true,
    },
  };

  // 4. Clutch and Differential
  const clutch: ClutchData = {
    maxTorqueNm: drv('CLUTCH', 'MAX_TORQUE', 500),
    biteRpm: drv('AUTOCLUTCH', 'MIN_RPM', 1000),
    lockRpm: drv('AUTOCLUTCH', 'MAX_RPM', 2200),
  };

  const tractionType = (mod.text('drivetrain.ini', 'TRACTION', 'TYPE') ?? 'RWD').toUpperCase();
  const drivenAxle: 'front' | 'rear' = tractionType === 'FWD' ? 'front' : 'rear';

  const diffPower = drv('DIFFERENTIAL', 'POWER', 0.25);
  const diffCoast = drv('DIFFERENTIAL', 'COAST', 0.4);
  const diffPreload = drv('DIFFERENTIAL', 'PRELOAD', 40);

  const differential: DifferentialData = {
    type: 'LSD_Ramp',
    settings: {
      power: diffPower,
      coast: diffCoast,
      preload: diffPreload,
      friction_faces: 1,
      power_ramp_deg: 45,
      coast_ramp_deg: 45,
    },
  };

  // 5. Brakes
  const brakeTorque = mod.num('brakes.ini', 'DATA', 'MAX_TORQUE', 2400);
  const brakeFrontShare = mod.num('brakes.ini', 'DATA', 'FRONT_SHARE', 0.65);
  const handbrakeTorque = mod.num('brakes.ini', 'DATA', 'HANDBRAKE_TORQUE', 0);
  const ebbStep = (mod.num('brakes.ini', 'DATA', 'ADJUST_STEP', 0.5) || 0.5) / 100;

  const brakes = {
    maxTorqueNm: brakeTorque,
    front_bias: brakeFrontShare,
    ...(handbrakeTorque > 0 ? { handbrakeTorqueNm: handbrakeTorque } : {}),
    ebbStep,
    brakeByWire: false,
  };

  // 6. Suspensions
  const buildAxleSuspension = (axleName: 'FRONT' | 'REAR', stopsInfo: typeof frontAxle) => {
    const isStrut = mod.text('suspensions.ini', axleName, 'TYPE') === 'STRUT';
    const springRate = sus(axleName, 'SPRING_RATE', 40_000);
    const arbRate = sus('ARB', axleName, 20_000);
    const staticCamber = sus(axleName, 'STATIC_CAMBER', -1.0);
    const st = stopsInfo.stops;

    const stopRate = isStrut ? 500_000 : sus(axleName, 'BUMP_STOP_RATE', 100_000);
    const packerFirst = st.packerGapM <= st.bumpStopGapM;
    const together = Math.abs(st.packerGapM - st.bumpStopGapM) < 1e-4;
    const firstRate = together ? sus(axleName, 'BUMP_STOP_RATE', 100_000) + stopRate : stopRate;

    const hardpointKeys = [
      'WBCAR_TOP_FRONT',
      'WBCAR_TOP_REAR',
      'WBCAR_BOTTOM_FRONT',
      'WBCAR_BOTTOM_REAR',
      'WBTYRE_TOP',
      'WBTYRE_BOTTOM',
      'WBCAR_STEER',
      'WBTYRE_STEER',
    ];

    const hardpoints: [number, number, number][] = [];
    let hasAllHardpoints = true;
    for (const key of hardpointKeys) {
      const strutKey = isStrut && key === 'WBTYRE_TOP' ? 'STRUT_CAR' : isStrut && key === 'WBTYRE_BOTTOM' ? 'STRUT_TYRE' : key;
      const v = mod.vec('suspensions.ini', axleName, strutKey);
      if (v.length === 3 && v.every(Number.isFinite)) {
        hardpoints.push([v[0], v[1], v[2]]);
      } else {
        hasAllHardpoints = false;
        break;
      }
    }

    const isFormula = totalMass < 950;
    return {
      type: isStrut ? ('SuspensionType_Strut' as const) : ('SuspensionType_DoubleWishbone' as const),
      actuation: 'push_rod' as const,
      staticCamber,
      camberGainKinematic: isStrut ? -20 : -32,
      springs: { wheel_rate: springRate, helper_rate: 0, helper_range: 0 },
      arb: arbRate,
      bumpStop: {
        range: isFormula
          ? Math.min(0.028, Math.max(0.015, st.packerGapM))
          : Math.min(Math.max(0.005, st.packerGapM), Math.max(0.005, st.bumpStopGapM)),
        rate: isFormula ? Math.max(firstRate, 160_000) : firstRate,
        progression: isFormula ? 8_000_000 : 0,
      },
      droopTravel: Math.max(0.02, st.droopM),
      rollCentreHeight: 0.08,
      heave: stopsInfo.hasHeave
        ? {
            rate: sus(stopsInfo.heaveSec, 'SPRING_RATE', 0),
            gap: 0,
            packerGap: Math.max(0, st.heavePackerGapM),
            packerRate: sus(stopsInfo.heaveSec, 'BUMP_STOP_RATE', 200_000),
            progressiveRate: sus(stopsInfo.heaveSec, 'PROGRESSIVE_SPRING_RATE', 0),
          }
        : { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
      ...(hasAllHardpoints && hardpoints.length === 8 ? { hardpoints } : {}),
    };
  };

  const frontSuspension = buildAxleSuspension('FRONT', frontAxle);
  const rearSuspension = buildAxleSuspension('REAR', rearAxle);

  const buildDamperController = (axleName: 'FRONT' | 'REAR'): DamperControllerData => {
    const s = (k: string, fb: number) => sus(axleName, k, fb);
    const heaveSec = `HEAVE_${axleName}`;
    const hasHeave = sus(heaveSec, 'SPRING_RATE', 0) > 0;
    const heaveBumpKnee = sus(heaveSec, 'DAMP_FAST_BUMPTHRESHOLD');
    const heaveReboundKnee = sus(heaveSec, 'DAMP_FAST_REBOUNDTHRESHOLD');
    return {
      base: {
        slow_bump: s('DAMP_BUMP', 3000),
        fast_bump: s('DAMP_FAST_BUMP', 1500),
        slow_rebound: s('DAMP_REBOUND', 4500),
        fast_rebound: s('DAMP_FAST_REBOUND', 2500),
      },
      heave: hasHeave
        ? {
            slow_bump: sus(heaveSec, 'DAMP_BUMP', 0),
            fast_bump: sus(heaveSec, 'DAMP_FAST_BUMP', 0),
            slow_rebound: sus(heaveSec, 'DAMP_REBOUND', 0),
            fast_rebound: sus(heaveSec, 'DAMP_FAST_REBOUND', 0),
          }
        : ZERO_DAMPER,
      roll: ZERO_DAMPER,
      pitch: ZERO_DAMPER,
      fastThresholdMs: s('DAMP_FAST_BUMPTHRESHOLD', 0.15),
      fastReboundThresholdMs: s('DAMP_FAST_REBOUNDTHRESHOLD', 0.15),
      ...(hasHeave && Number.isFinite(heaveBumpKnee) ? { heaveFastThresholdMs: heaveBumpKnee } : {}),
      ...(hasHeave && Number.isFinite(heaveReboundKnee) ? { heaveFastReboundThresholdMs: heaveReboundKnee } : {}),
    };
  };

  const suspensions: SuspensionsData = {
    front: frontSuspension,
    rear: rearSuspension,
    dampers_controller: {
      front: buildDamperController('FRONT'),
      rear: buildDamperController('REAR'),
    },
  };

  // 7. Aerodynamics
  const wings: WingData[] = [];
  const wingSections = mod.sections('aero.ini').filter((s) => /^WING_\d+$/i.test(s));
  for (const sec of wingSections) {
    const chord = mod.num('aero.ini', sec, 'CHORD', 0.2);
    const span = mod.num('aero.ini', sec, 'SPAN', 1.0);
    const area = chord * span;
    const pos = mod.vec('aero.ini', sec, 'POSITION');
    const angle = mod.num('aero.ini', sec, 'ANGLE', 0);
    const clGain = mod.num('aero.ini', sec, 'CL_GAIN', 1);
    const cdGain = mod.num('aero.ini', sec, 'CD_GAIN', 1);

    const clLut = mod.lutOf('aero.ini', sec, 'LUT_AOA_CL').map(([x, y]) => [x, y * clGain] as const);
    const cdLut = mod.lutOf('aero.ini', sec, 'LUT_AOA_CD').map(([x, y]) => [x, y * cdGain] as const);
    // Clamp minimum ground height multiplier to avoid complete catastrophic downforce collapse
    // when suspension compresses into the road (e.g. bump stops or downhill compressions)
    const minGhMult = isFormula ? 0.85 : 0.65;
    const ghClLut = mod.lutOf('aero.ini', sec, 'LUT_GH_CL').map(([h, val]) => [h, Math.max(minGhMult, val)] as const);
    const ghCdLut = mod.lutOf('aero.ini', sec, 'LUT_GH_CD');

    const rawName = (mod.text('aero.ini', sec, 'NAME') || sec).toUpperCase();
    const isFloorOrDiff = /diff|floor|under|body/i.test(rawName);
    const isFront = /front|fw|nose/i.test(rawName);
    const isRear = /rear|rw|drs|monkey|fin|beam/i.test(rawName);

    const wingName: 'FRONT_WING' | 'VENTURI_FLOOR' | 'REAR_WING' =
      isFloorOrDiff
        ? 'VENTURI_FLOOR'
        : isFront
          ? 'FRONT_WING'
          : isRear
            ? 'REAR_WING'
            : (pos[2] || 0) > 0.8
              ? 'FRONT_WING'
              : (pos[2] || 0) < -0.8
                ? 'REAR_WING'
                : 'VENTURI_FLOOR';

    wings.push({
      name: wingName,
      area: area > 0 ? area : 0.5,
      positionZ: pos[2] || 0,
      angleDeg: angle,
      ...(wingName === 'VENTURI_FLOOR' ? { aoaReference: 'setup' as const } : {}),
      heightRef: wingName === 'FRONT_WING' ? 'front' : wingName === 'REAR_WING' ? 'rear' : 'mean',
      lutAOA_CL: clLut.length ? clLut : [[0, 0]],
      lutAOA_CD: cdLut.length ? cdLut : [[0, 0]],
      lutGH_CL_mult: ghClLut.length ? ghClLut : [[0, 1], [0.5, 1]],
      lutGH_CD_mult: ghCdLut.length ? ghCdLut : [[0, 1], [0.5, 1]],
    });
  }

  // Calibrate aerodynamic Center of Pressure (downforce balance):
  // An aero balance too far forward (e.g. > 48% front on open-wheelers or > frontShare) causes violent high-speed snap oversteer.
  // Formula / open-wheel cars operate stably with ~42%–45% front aero downforce.
  if (wings.length > 0) {
    let frontDownSum = 0;
    let rearDownSum = 0;
    const cgToRear = wheelbase * frontShare;

    for (const w of wings) {
      const cl =
        evalLut(w.lutAOA_CL as [number, number][], w.angleDeg) *
        evalLut(w.lutGH_CL_mult as [number, number][], 0.05);
      const fd = Math.max(0, cl * w.area);
      const armShare = (w.positionZ + cgToRear) / wheelbase;
      frontDownSum += fd * armShare;
      rearDownSum += fd * (1 - armShare);
    }

    const totalDown = frontDownSum + rearDownSum;
    const currentFrontShare = totalDown > 0 ? frontDownSum / totalDown : 0.5;
    const isSingleSeater = totalMass < 950;
    const targetFrontShare = isSingleSeater ? 0.415 : Math.min(0.48, frontShare - 0.02);

    if (currentFrontShare > targetFrontShare && totalDown > 0) {
      const frontScale = (targetFrontShare / (1 - targetFrontShare)) / (currentFrontShare / (1 - currentFrontShare));
      if (frontScale > 0.1 && frontScale < 0.95) {
        for (const w of wings) {
          if (w.name === 'FRONT_WING') {
            w.area *= frontScale;
          }
        }
      }
    }
  }

  const isSingleSeaterCar = totalMass < 950;
  const importedDrs = mapAcAeroSystems(mod, wingSections, wings);
  const aero: AeroData = {
    front_lift: mod.num('aero.ini', 'HEADER', 'CL_FRONT', 0),
    rear_lift: mod.num('aero.ini', 'HEADER', 'CL_REAR', 0),
    drag: mod.num('aero.ini', 'HEADER', 'CD', wings.length > 0 ? 0 : 0.34),
    wings,
    front_target_height: frontAxle.bodyHeight,
    rear_target_height: rearAxle.bodyHeight,
    floorOffsetY: isSingleSeaterCar
      ? -cgHeight + 0.025
      : (Number.isFinite(car('RIDE', 'PICKUP_FRONT_HEIGHT')) ? car('RIDE', 'PICKUP_FRONT_HEIGHT') : -cgHeight + 0.05),
    plank: isSingleSeaterCar
      ? {
          y: -cgHeight + 0.038,
          frontZ: Math.min(1.4, wheelbase * frontShare * 0.75),
          rearZ: -Math.min(1.2, wheelbase * (1 - frontShare) * 0.75),
        }
      : undefined,
    drsTransitionS: 0.3,
    drsCloseThrottle: 0.95,
    ...(importedDrs ? { importedDrs } : {}),
    airDensity: 1.225,
  };

  // 8. Tyres and compounds
  const tyreVersion = mod.num('tyres.ini', 'HEADER', 'VERSION', 10);
  const frontTyreGeom: TyreGeometry = {
    width: tyr('FRONT', 'WIDTH', 0.225),
    radius: tyr('FRONT', 'RADIUS', 0.32),
    rimRadius: tyr('FRONT', 'RIM_RADIUS', 0.215),
    verticalRateScale: 1,
    radiusGrowthPerRadS: tyr('FRONT', 'RADIUS_ANGULAR_K', 0) / 1000 || undefined,
  };

  const rearTyreGeom: TyreGeometry = {
    width: tyr('REAR', 'WIDTH', frontTyreGeom.width),
    radius: tyr('REAR', 'RADIUS', frontTyreGeom.radius),
    rimRadius: tyr('REAR', 'RIM_RADIUS', frontTyreGeom.rimRadius),
    verticalRateScale: 1,
    radiusGrowthPerRadS: tyr('REAR', 'RADIUS_ANGULAR_K', 0) / 1000 || undefined,
  };

  // RATE is the tyre's radial stiffness at PRESSURE_STATIC, not at 32 psi.
  // Its pressure gain and reference are independent for the front and rear.
  const fallbackTyreRate = tyr('FRONT', 'RATE', 220_000);
  const fallbackPressureSpring: LutPoints = [
    [20, fallbackTyreRate - 20_000],
    [32, fallbackTyreRate],
    [44, fallbackTyreRate + 20_000],
  ];
  const pressureSpring = (axle: 'FRONT' | 'REAR', fallback: LutPoints): LutPoints => {
    const rate = tyr(axle, 'RATE');
    const staticPsi = tyr(axle, 'PRESSURE_STATIC');
    const gain = tyr(axle, 'PRESSURE_SPRING_GAIN');
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(staticPsi) || staticPsi <= 0 ||
      !Number.isFinite(gain) || gain < 0) return fallback;
    const idealPsi = tyr(axle, 'PRESSURE_IDEAL', staticPsi);
    const low = Math.min(10, staticPsi);
    const high = Math.max(45, staticPsi, idealPsi + 10);
    const minRate = 10_000;
    const floorPsi = gain > 0 ? staticPsi + (minRate - rate) / gain : low;
    const points = [low, staticPsi, high];
    // Keep the authored linear law above the floor even if an extreme low
    // pressure would otherwise imply a negative spring rate.
    if (floorPsi > low && floorPsi < staticPsi) points.push(floorPsi);
    return [...new Set(points)].sort((a, b) => a - b).map((psi) =>
      [psi, Math.max(minRate, rate + gain * (psi - staticPsi))] as const);
  };
  const frontPressureSpring = pressureSpring('FRONT', fallbackPressureSpring);
  const rearPressureSpring = pressureSpring('REAR', frontPressureSpring);

  const rawFrictionLimit = tyr('FRONT', 'FRICTION_LIMIT_ANGLE', 10);
  const frictionLimitAngle = isFormula ? Math.max(8.5, rawFrictionLimit) : rawFrictionLimit;
  const fz0 = tyr('FRONT', 'FZ0', (totalMass * G * frontShare) / 2);
  const dyCurve = mod.lutOf('tyres.ini', 'FRONT', 'DY_CURVE');
  const dxCurve = mod.lutOf('tyres.ini', 'FRONT', 'DX_CURVE');

  const hasRearSection = mod.sections('tyres.ini').some((s) => s.toUpperCase() === 'REAR');
  const rawRearFrictionLimit = tyr('REAR', 'FRICTION_LIMIT_ANGLE', frictionLimitAngle);
  const rearFrictionLimitAngle = isFormula ? Math.max(8.5, rawRearFrictionLimit) : rawRearFrictionLimit;
  const rearFz0 = tyr('REAR', 'FZ0', (totalMass * G * (1 - frontShare)) / 2);
  const rearDyCurve = mod.lutOf('tyres.ini', 'REAR', 'DY_CURVE');
  const rearDxCurve = mod.lutOf('tyres.ini', 'REAR', 'DX_CURVE');

  const rawFalloffLevel = tyr('FRONT', 'FALLOFF_LEVEL', 0.85);
  const falloffLevel = isFormula ? Math.max(0.92, rawFalloffLevel) : rawFalloffLevel;
  const rawFalloffSpeed = tyr('FRONT', 'FALLOFF_SPEED', 2.0);
  const falloffSpeed = isFormula ? Math.min(0.6, rawFalloffSpeed) : rawFalloffSpeed;
  const frontLongStiffness = tyr('FRONT', 'CX_MULT', 1);
  const rearLongStiffness = tyr('REAR', 'CX_MULT', frontLongStiffness);

  const defaultCompound: TyresCompoundData = {
    name: mod.text('tyres.ini', 'FRONT', 'NAME') || 'Standard',
    shortName: 'M',
    tyre_compound: 'PhysicsTyreCompound_Road_Street',
    front: frontTyreGeom,
    rear: rearTyreGeom,
    modelData: {
      curve: 'brush',
      friction_limit_angle: frictionLimitAngle,
      Fz0: fz0,
      lsExpY: tyr('FRONT', 'LS_EXPY', 0.85),
      lsExpX: tyr('FRONT', 'LS_EXPX', 0.85),
      Dy0: tyr('FRONT', 'DY_REF', tyr('FRONT', 'DY0', 1.2)),
      Dx0: tyr('FRONT', 'DX_REF', tyr('FRONT', 'DX0', 1.2)),
      curveFullness: tyr('FRONT', 'XMU', 0),
      dyCurve: dyCurve.length ? (dyCurve as LutPoints) : undefined,
      dxCurve: dxCurve.length ? (dxCurve as LutPoints) : undefined,
      peakSlipLoadGain: tyr('FRONT', 'FLEX_GAIN', 0.05),
      peakSlipPressureGain: tyr('FRONT', 'PRESSURE_FLEX_GAIN', 0),
      combinedExponent: tyr('FRONT', 'COMBINED_FACTOR', 2),
      longStiffnessMult: frontLongStiffness,
      use_slip_falloff: tyreVersion >= 10,
      falloff_level: falloffLevel,
      falloff_slope: falloffSpeed,
      slip_ratio_limit: peakDriveSlipRatio(frictionLimitAngle, frontLongStiffness),
      speedSensitivity: tyr('FRONT', 'SPEED_SENSITIVITY', 0.005),
      relaxationLengthX: tyr('FRONT', 'RELAXATION_LENGTH', 0.12),
      relaxationLengthY: tyr('FRONT', 'RELAXATION_LENGTH', 0.12),
      rollingResistance: tyr('FRONT', 'ROLLING_RESISTANCE_0', 10) / 1000,
      brakeDxMod: tyr('FRONT', 'BRAKE_DX_MOD', 0),
      verticalDamping: tyr('FRONT', 'DAMP', 600),
      pKy2: Number((5910 / fz0).toFixed(2)),
      new_combined: false,
      fx_shift_SA: 0,
      fx_scale_SA: 0,
      fy_shift_SR: 0,
      fy_scale_SR: 0,
    },
    rearOverride: hasRearSection
      ? {
          modelData: {
            friction_limit_angle: rearFrictionLimitAngle,
            Fz0: rearFz0,
            lsExpY: tyr('REAR', 'LS_EXPY', tyr('FRONT', 'LS_EXPY', 0.85)),
            lsExpX: tyr('REAR', 'LS_EXPX', tyr('FRONT', 'LS_EXPX', 0.85)),
            Dy0: tyr('REAR', 'DY_REF', tyr('REAR', 'DY0', tyr('FRONT', 'DY_REF', 1.2))),
            Dx0: tyr('REAR', 'DX_REF', tyr('REAR', 'DX0', tyr('FRONT', 'DX_REF', 1.2))),
            curveFullness: tyr('REAR', 'XMU', tyr('FRONT', 'XMU', 0)),
            dyCurve: rearDyCurve.length ? (rearDyCurve as LutPoints) : undefined,
            dxCurve: rearDxCurve.length ? (rearDxCurve as LutPoints) : undefined,
            peakSlipLoadGain: tyr('REAR', 'FLEX_GAIN', tyr('FRONT', 'FLEX_GAIN', 0.05)),
            peakSlipPressureGain: tyr('REAR', 'PRESSURE_FLEX_GAIN', tyr('FRONT', 'PRESSURE_FLEX_GAIN', 0)),
            combinedExponent: tyr('REAR', 'COMBINED_FACTOR', tyr('FRONT', 'COMBINED_FACTOR', 2)),
            longStiffnessMult: rearLongStiffness,
            use_slip_falloff: tyreVersion >= 10,
            falloff_level: isFormula ? Math.max(0.92, tyr('REAR', 'FALLOFF_LEVEL', falloffLevel)) : tyr('REAR', 'FALLOFF_LEVEL', 0.85),
            falloff_slope: isFormula ? Math.min(0.6, tyr('REAR', 'FALLOFF_SPEED', falloffSpeed)) : tyr('REAR', 'FALLOFF_SPEED', 2.0),
            slip_ratio_limit: peakDriveSlipRatio(rearFrictionLimitAngle, rearLongStiffness),
            speedSensitivity: tyr('REAR', 'SPEED_SENSITIVITY', tyr('FRONT', 'SPEED_SENSITIVITY', 0.005)),
            relaxationLengthX: tyr('REAR', 'RELAXATION_LENGTH', tyr('FRONT', 'RELAXATION_LENGTH', 0.12)),
            relaxationLengthY: tyr('REAR', 'RELAXATION_LENGTH', tyr('FRONT', 'RELAXATION_LENGTH', 0.12)),
            rollingResistance: tyr('REAR', 'ROLLING_RESISTANCE_0', 10) / 1000,
            brakeDxMod: tyr('REAR', 'BRAKE_DX_MOD', tyr('FRONT', 'BRAKE_DX_MOD', 0)),
            verticalDamping: tyr('REAR', 'DAMP', tyr('FRONT', 'DAMP', 600)),
            pKy2: Number((5910 / rearFz0).toFixed(2)),
          },
          pressureData: {
            optimalPsi: tyr('REAR', 'PRESSURE_IDEAL', tyr('FRONT', 'PRESSURE_IDEAL', 32)),
            pressureSpringCurve: rearPressureSpring,
          },
          camberData: {
            camberGain: tyr('REAR', 'CAMBER_GAIN', tyr('FRONT', 'CAMBER_GAIN', 0.05)),
            dcamber0: tyr('REAR', 'DCAMBER_0', tyr('FRONT', 'DCAMBER_0', 1.1)),
            dcamber1: tyr('REAR', 'DCAMBER_1', tyr('FRONT', 'DCAMBER_1', 0.9)),
          },
        }
      : undefined,
    pressureData: {
      optimalPsi: tyr('FRONT', 'PRESSURE_IDEAL', 32),
      pressureSpringCurve: frontPressureSpring,
      pressureRollingGain: tyr('FRONT', 'PRESSURE_RR_GAIN', 0.001),
      pressureGripSensitivity: 1.0,
      pressureGripLossPerPsi: tyr('FRONT', 'PRESSURE_D_GAIN', 0.005),
      coldRefC: 25,
    },
    camberData: {
      camberGain: tyr('FRONT', 'CAMBER_GAIN', 0.05),
      contact_camber_c1: 1,
      contact_camber_c2: 40,
      dcamber0: tyr('FRONT', 'DCAMBER_0', 1.1),
      dcamber1: tyr('FRONT', 'DCAMBER_1', 0.9),
      dcamber0_x: 0,
      dcamber1_x: 0,
    },
    thermalData: {
      thermalPerformanceCurve: [
        [0, 0.96],
        [20, 0.97],
        [40, 0.98],
        [60, 0.995],
        [75, 1],
        [85, 1],
        [100, 0.99],
        [140, 0.95],
        [220, 0.85],
      ],
      optimalTempC: [75, 85],
      surfaceHeatCapacity: 1200,
      coreHeatCapacity: 7000,
      slipHeatShare: 0.35,
      hysteresis: 0.003,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [4, 0.1],
      thermalVerticalK: -0.001,
      thermalVerticalRefC: 80,
      rimGas: {
        rimHeatCapacityJK: 4600,
        rimBrakeOverlapAreaM2: 0.07,
        discToRimEmissivity: 0.58,
        discToRimConvectionWK: [2.8, 0.08],
        rimToAmbientConvectionWK: [3, 0.2],
        rimToGasConductanceWK: 16.5,
        carcassToGasConductanceWK: 22,
        gasHeatCapacityJK: 52,
      },
    },
  };

  const tyreCompounds: Partial<Record<PhysicsTyreCompound, TyresCompoundData>> = {
    PhysicsTyreCompound_Road_Street: defaultCompound,
  };

  const compoundSlots: Record<CompoundSlot, PhysicsTyreCompound> = {
    soft: 'PhysicsTyreCompound_Road_Street',
    medium: 'PhysicsTyreCompound_Road_Street',
    hard: 'PhysicsTyreCompound_Road_Street',
    intermediate: 'PhysicsTyreCompound_Road_Street',
    wet: 'PhysicsTyreCompound_Road_Street',
  };

  // 9. ERS & Performance Modes (disabled if no valid AC kinetic unit was authored)
  const NONE_LUT: LutPoints = [
    [0, 0],
    [10000, 0],
  ];
  const baseErs: ERSData = kineticDrive ?? {
    torqueLut: NONE_LUT,
    coastLut: NONE_LUT,
    ERS_MAX_DEPLOY: 0,
    maxHarvestW: 0,
    ERS_MAX_CHARGE: 1,
    deployPerLapJ: 0,
    harvestPerLapJ: 0,
    deployEfficiency: 1,
    harvestEfficiency: 1,
    liftThrottle: 0,
    topGearLiftHarvestW: 0,
  };
  const heat = engine.turbo && baseErs.importedDrive && mapAcHeatRecovery(mod);
  const ers = heat && baseErs.importedDrive
    ? { ...baseErs, importedDrive: { ...baseErs.importedDrive, heat } }
    : baseErs;

  const performanceModes: Record<PerformanceModeName, PerformanceModeData> = {
    PSH: createPerformanceMode('PSH'),
    RAC: createPerformanceMode('RAC'),
    BAL: createPerformanceMode('BAL'),
    LIC: createPerformanceMode('LIC'),
    CHR: createPerformanceMode('CHR'),
  };

  // 10. Digital Instruments / Rev Lights
  let revRange: [number, number] | undefined;
  const ledSecs = mod.sections('digital_instruments.ini').filter((s) => /^LED_\d+$/i.test(s));
  const leds: { node: string; rpm: number; color: [number, number, number] }[] = [];
  let blinkRpm: number | undefined;
  let blinkHz: number | undefined;

  for (const s of ledSecs) {
    const node = mod.text('digital_instruments.ini', s, 'OBJECT_NAME') || s;
    const rpm = mod.num('digital_instruments.ini', s, 'RPM_SWITCH', 0);
    const blink = mod.num('digital_instruments.ini', s, 'BLINK_SWITCH', 0);
    const hz = mod.num('digital_instruments.ini', s, 'BLINK_HZ', 5);
    const emissiveStr = mod.text('digital_instruments.ini', s, 'EMISSIVE');
    let color: [number, number, number] = [0, 1, 0];
    if (emissiveStr) {
      const parts = emissiveStr.split(',').map((p) => parseFloat(p.trim()) || 0);
      if (parts.length >= 3) {
        const maxVal = Math.max(...parts, 1);
        color = [parts[0] / maxVal, parts[1] / maxVal, parts[2] / maxVal];
      }
    }
    if (rpm > 0) {
      leds.push({ node, rpm, color });
      if (blink > 0) blinkRpm = blink;
      if (hz > 0) blinkHz = hz;
    }
  }

  if (leds.length > 0) {
    leds.sort((a, b) => a.rpm - b.rpm);
    const startRpm = leds[0].rpm;
    const fullRpm = blinkRpm || leds[leds.length - 1].rpm;
    revRange = [startRpm, fullRpm];
  } else {
    const fullRpm = upshiftRpm || redline - 150;
    revRange = [Math.round(fullRpm * 0.82), fullRpm];
  }

  const revLeds = leds.length > 0 ? { leds, blinkRpm, blinkHz } : undefined;

  return {
    screenName,
    drivenAxle,
    chassis,
    engine,
    ers,
    performanceModes,
    gearbox,
    clutch,
    differential,
    brakes,
    suspensions,
    aero,
    tyreCompounds,
    compoundSlots,
    revRange,
    revLeds,
    cameras: mapAcCameras(mod),
  };
}
