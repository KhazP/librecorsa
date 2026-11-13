/**
 * The Grand Prix VF26 for `VehiclePhysics` (same data model as the f12026-car, see `F12026CarConfig`): the car of
 * `vf26-data.ts`, which `F1Physics2026` drives today, laid out for the rigid-body engine. Every number here is read
 * from that file's constants or computed from them, so the two engines run the same car and
 * `scripts/compare-vf26-engines.ts` puts them side by side.
 *
 *  - [data]     a constant of `vf26-data.ts` (its own tags say where each comes from)
 *  - [derived]  computed from those
 *  - [est]      what this engine needs and that file does not have (as the f12026-car's unless noted)
 *
 * `buildVf26Config` takes overrides of that data and applies them before anything is derived from it (roll centres
 * from the tyre radius, the ground-height tables from the ride heights, the tyre's spring from its rate), so a car
 * tuned away from the data (`Vf26Tune.ts`) stays consistent with itself. Without overrides it is the data's car.
 */
import { Lut, type LutPoints } from '../lut';
import { VF26_CG_HEIGHT_M } from '../vf26-aero';
import {
  computeRollCentreHeight,
  VF26_BRAKES,
  VF26_CHASSIS,
  VF26_DRIVETRAIN,
  VF26_ENGINE,
  VF26_ERS,
  VF26_TYRES,
  VF26_WINGS,
  type Vf26AxleSuspension,
  type Vf26TyreSpec,
  type Vf26WingSpec,
} from '../vf26-data';
import {
  deriveRainCompound,
  type AeroData,
  type BrakesData,
  type CarPhysicsConfig,
  type DamperSettingsUnits,
  type EngineData,
  type ERSData,
  type PerformanceModeData,
  type PerformanceModeName,
  type PhysicsTyreCompound,
  type SuspensionsData,
  type TurboData,
  type TyresCompoundData,
  type WingData,
} from './F12026CarConfig';

const at = (points: LutPoints, x: number) => new Lut(points).evaluate(x);

/** Values to use in place of the data's. Everything derived from them follows */
export interface Vf26Overrides {
  front?: Partial<Vf26AxleSuspension>;
  rear?: Partial<Vf26AxleSuspension>;
  /** A compound's tyre on an axle, from the data's */
  tyre?: (spec: Vf26TyreSpec, axle: 'front' | 'rear') => Vf26TyreSpec;
  /** The combustion engine's power against the data's curve */
  icePowerScale?: number;
  /** Crank and flywheel inertia (kg·m²) */
  engineInertia?: number;
  /** Overrun torque against the data's */
  coastScale?: number;
  brakeTorqueNm?: number;
  /** The discs and pads: their grip against temperature, the temperature they start at, the rear ducts' airflow */
  brakes?: Pick<BrakesData, 'padMuCurve' | 'discStartTempC' | 'rearDuctShare'>;
  /** Differential lock under power, as a share of the input torque */
  diffPowerLock?: number;
  /** A managed up-shift: the drive is cut for this long (s) and the engine meets the new gear at the wheels' speed */
  upshiftCutS?: number;
  /** The combustion torque's lag behind the pedal, rising and falling (s) */
  torqueResponseS?: { rise: number; fall: number };
  /** Energy recovery values in place of the data's */
  ers?: Partial<ERSData>;
  /** Where the fuel sits, from the centre of gravity of the car without fuel (m: y up, z forward); absent: at it */
  fuelTank?: { y: number; z: number };
}

// ---------------------------------------------------------------------------
// Power unit
// ---------------------------------------------------------------------------

/**
 * The boost on the curve [data boostCurve: 0 below 4000 rpm, 2.2 bar from 7000 to 10 500, easing to 1.5 at 13 000] as
 * this engine's turbo: full boost 2.2 reached at 7000 rpm. Its lag is the data's (0.32 s up at 10 000 rpm, 0.18 s
 * down); the power curve below carries the boost curve's own shape
 */
const TURBO: TurboData = {
  maxBoost: 2.2,
  referenceRpm: 7000,
  gamma: 2,
  spoolUpS: VF26_ENGINE.turboSpoolTauS,
  spoolRefRpm: 10_000,
  spoolDownS: VF26_ENGINE.turboDecayTauS,
  displayMaxBoostBar: 2.2,
};

/** Crank power with the boost made (kW): the torque curve × (1 + boost) [derived] */
const POWER_CURVE: LutPoints = VF26_ENGINE.torqueCurve
  .filter(([rpm]) => rpm > 0 && rpm <= VF26_ENGINE.maxRpm)
  .map(([rpm, nm]) => [rpm, (nm * (1 + at(VF26_ENGINE.boostCurve, rpm)) * rpm * Math.PI) / 30 / 1000]);

const ENGINE: EngineData = {
  powerCurve: POWER_CURVE,
  // Overrun torque as a positive magnitude [data coastCurve]
  coastCurve: VF26_ENGINE.coastCurve.map(([rpm, nm]) => [rpm, -nm]),
  throttleResponseCurve: [
    [0, 0],
    [1, 1],
  ],
  torqueResponseS: { rise: 0.03, fall: 0.02 },
  wetPedalMap: true,
  turbo: TURBO,
  idleRpm: VF26_ENGINE.idleRpm,
  // Crank and flywheel + the gearbox's input side [data]
  inertia: VF26_ENGINE.inertia + VF26_DRIVETRAIN.gearboxInertia,
  limiterCutS: 0.02,
};

/** MGU-K harvest torque at the crank: the deploy torque's ceiling up to the power limit's knee, then the power hyperbola */
function harvestTorque(maxW: number, maxNm: number): LutPoints {
  const kneeRpm = (maxW / maxNm) * (30 / Math.PI);
  const pts: [number, number][] = [
    [0, maxNm],
    [kneeRpm, maxNm],
  ];
  for (let rpm = 6000; rpm <= 16_000; rpm += 1000) if (rpm > kneeRpm) pts.push([rpm, maxW / ((rpm * Math.PI) / 30)]);
  return pts;
}

const ERS: ERSData = {
  torqueLut: VF26_ERS.kineticTorque,
  coastLut: harvestTorque(VF26_ERS.maxPowerW, 654),
  ERS_MAX_DEPLOY: VF26_ERS.maxPowerW,
  maxHarvestW: VF26_ERS.maxPowerW,
  ERS_MAX_CHARGE: VF26_ERS.batteryJ,
  // The 2026 lap allowances, as the f12026-car's
  deployPerLapJ: 9_000_000,
  harvestPerLapJ: 8_500_000,
  deployEfficiency: 0.95,
  harvestEfficiency: VF26_ERS.harvestEfficiency,
  liftThrottle: 0.15,
  topGearLiftHarvestW: 90_000,
  deployVsGear: VF26_ERS.deployVsGear,
};

/**
 * A delivery map's share of the 350 kW against road speed: the mode's own speed curve at full throttle
 * [data modes.*.speed × the throttle curve's value at 1], under the super-clipping ceiling (full power to 290 km/h,
 * none from 355; with the override, full to 337) [data mgukDeployCapW]
 */
function deployVsSpeed(speed: LutPoints, throttleGain: number, taperFromKmh: number): LutPoints {
  const cap = (kmh: number) => (kmh <= taperFromKmh ? 1 : kmh >= 355 ? 0 : (355 - kmh) / (355 - taperFromKmh));
  const xs = [...new Set([...speed.map(([kmh]) => kmh), taperFromKmh, 355])].sort((a, b) => a - b);
  return xs.map((kmh) => [kmh, Number(Math.min(Math.min(1, throttleGain) * at(speed, kmh), cap(kmh)).toFixed(4))]);
}

const mode = (
  performance_mode_name: PerformanceModeName,
  deploy: LutPoints,
  socFloor: number,
  rest: Partial<PerformanceModeData> = {}
): PerformanceModeData => ({
  performance_mode_name,
  deployFraction: 1,
  deployVsSpeed: deploy,
  socFloor,
  brakeHarvestScale: 1,
  liftHarvestScale: 1,
  topGearClipHarvestW: 0,
  partThrottleHarvestW: 0,
  coastTorqueScale: 1,
  ebbOffset: 0,
  ...rest,
});

const M = VF26_ERS.modes;
const PERFORMANCE_MODES: Record<PerformanceModeName, PerformanceModeData> = {
  // The override: its own map held to 337 km/h, the store used to the bottom
  PSH: mode('PSH', deployVsSpeed(M.PSH.speed, 1, 337), 0),
  // Race: 80 % of the power, the store kept above a fifth [data soc curve]
  RAC: mode('RAC', deployVsSpeed(M.RAC.speed, 0.8, 290), 0.2, { liftHarvestScale: M.RAC.coastHarvest }),
  BAL: mode('BAL', deployVsSpeed(M.BAL.speed, 1, 290), 0.4, { liftHarvestScale: M.BAL.coastHarvest }),
  // Lift and coast: race delivery, harvesting on the lift [est: the data has no such mode]
  LIC: mode('LIC', deployVsSpeed(M.RAC.speed, 0.8, 290), 0.2, { coastTorqueScale: 0.35 }),
  // Charge: no deploy, harvest at part and full throttle [data: its throttle curve is negative throughout]
  CHR: mode('CHR', deployVsSpeed(M.CHR.speed, 0, 290), 0, { deployFraction: 0, topGearClipHarvestW: 120_000, partThrottleHarvestW: 80_000, coastTorqueScale: 1.15 }),
};

// ---------------------------------------------------------------------------
// Suspension
// ---------------------------------------------------------------------------

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});
const NO_DAMPER = damper(0, 0, 0, 0);

/**
 * An axle of the data on this engine: its wheel rate, bump rubber, droop, heave element and bar as they are; the six
 * wishbone points [data] plus a tie rod (front) or toe link (rear) that this engine's solver needs and the data does
 * not have, laid beside the upper wishbone so it adds next to no bump steer [est]
 */
function axle(a: Vf26AxleSuspension, tyreRadius: number, link: [[number, number, number], [number, number, number]]): SuspensionsData['front'] {
  return {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    staticCamber: a.staticCamberDeg,
    camberGainKinematic: a.camberGainDegPerM,
    springs: { wheel_rate: a.springRate, helper_rate: 0, helper_range: 0 },
    heave: { rate: a.heaveRate, gap: 0, packerGap: a.heavePackerTravel, packerRate: a.heavePackerRate, progressiveRate: a.heaveProgressiveRate },
    bumpStop: { range: a.bumpStopTravel, rate: a.bumpStopRate, progression: 0 },
    droopTravel: a.droopTravel,
    rollCentreHeight: Number(computeRollCentreHeight(a, tyreRadius).toFixed(4)),
    arb: a.arbRate,
    hardpoints: [...a.hardpoints.map((p) => [p[0], p[1], p[2]] as [number, number, number]), ...link],
  };
}

function suspensionData(F: Vf26AxleSuspension, R: Vf26AxleSuspension, frontRadius: number, rearRadius: number): SuspensionsData {
  return {
    front: axle(F, frontRadius, [
      [F.hardpoints[0][0], F.hardpoints[0][1], 0.08],
      [F.hardpoints[4][0], F.hardpoints[4][1], 0.08],
    ]),
    rear: axle(R, rearRadius, [
      [R.hardpoints[1][0], R.hardpoints[1][1], -0.06],
      [R.hardpoints[4][0], R.hardpoints[4][1], -0.06],
    ]),
    dampers_controller: {
      front: {
        base: damper(F.damper.bumpSlow, F.damper.bumpFast, F.damper.reboundSlow, F.damper.reboundFast),
        // One rate for the heave damper [data heaveDamping]
        heave: damper(F.heaveDamping, F.heaveDamping, F.heaveDamping, F.heaveDamping),
        roll: NO_DAMPER,
        pitch: NO_DAMPER,
        fastThresholdMs: F.damper.bumpThreshold,
        fastReboundThresholdMs: F.damper.reboundThreshold,
      },
      rear: {
        base: damper(R.damper.bumpSlow, R.damper.bumpFast, R.damper.reboundSlow, R.damper.reboundFast),
        heave: damper(R.heaveDamping, R.heaveDamping, R.heaveDamping, R.heaveDamping),
        roll: NO_DAMPER,
        pitch: NO_DAMPER,
        fastThresholdMs: R.damper.bumpThreshold,
        fastReboundThresholdMs: R.damper.reboundThreshold,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Aero
// ---------------------------------------------------------------------------

const wing = (name: string): Vf26WingSpec => {
  const w = VF26_WINGS.find((x) => x.name === name);
  if (!w) throw new Error(`VF26 has no aero element ${name}`);
  return w;
};
const scale = (points: LutPoints, k: number): LutPoints => points.map(([x, y]) => [x, Number((y * k).toFixed(5))]);
const shiftX = (points: LutPoints, dx: number): LutPoints => points.map(([x, y]) => [Number((x + dx).toFixed(4)), y]);
const flat = (y: number): LutPoints => [
  [-30, Number(y.toFixed(5))],
  [30, Number(y.toFixed(5))],
];
/** CL × (1 + gain × |yaw| in radians) as a table against |yaw| in degrees [data yawClGain] */
const yawTable = (gain: number): LutPoints => [0, 2, 5, 10, 20, 30].map((deg) => [deg, Number(Math.max(0, 1 + (gain * deg * Math.PI) / 180).toFixed(4))]);
/** What an element's flap opening to its straight-line angle does to its lift and drag [data xModeAngleDeg, derived] */
const flap = (w: Vf26WingSpec) => ({
  clMult: Number((at(w.aoaCl, w.xModeAngleDeg) / at(w.aoaCl, w.angleDeg)).toFixed(4)),
  cdMult: Number((at(w.aoaCd, w.xModeAngleDeg) / at(w.aoaCd, w.angleDeg)).toFixed(4)),
});

/** The aero elements of the data with their ground-height tables laid on this engine's reference heights */
function aeroData(F: Vf26AxleSuspension, R: Vf26AxleSuspension): AeroData {
  /** The floor's reference plane below the CG: the floor elements' own height [data] */
  const FLOOR_Y = wing('FLOOR_FL').position[1];
  /** Static ride heights [data]; the body's static nose-down pitch they give */
  const STATIC_PITCH = (R.staticRideHeight - F.staticRideHeight) / VF26_CHASSIS.wheelbase;
  const CG_TO_FRONT = VF26_CHASSIS.wheelbase * (1 - VF26_CHASSIS.frontWeightFraction);
  const CG_TO_REAR = VF26_CHASSIS.wheelbase * VF26_CHASSIS.frontWeightFraction;
  /**
   * The data's ground-height tables are read at each element's own height above the road. This engine reads them at
   * the floor's height at an axle (or the mean), so each table moves by the element's height over that at static ride:
   * its own height over the floor plane, less the pitch across its distance from the axle
   */
  const overFront = (w: Vf26WingSpec) => w.position[1] - FLOOR_Y - (w.position[2] - CG_TO_FRONT) * STATIC_PITCH;
  const overRear = (w: Vf26WingSpec) => w.position[1] - FLOOR_Y - (w.position[2] + CG_TO_REAR) * STATIC_PITCH;

  const FRONT = wing('FRONT_L');
  const REAR = wing('REAR');
  const DRS = wing('DRS');
  const DIFFUSER = wing('DIFFUSER_RL');
  const FLOORS = VF26_WINGS.filter((w) => w.name.startsWith('FLOOR'));
  const BODY = wing('BODY');
  const area = (w: Vf26WingSpec) => w.chord * w.span;
  const floorArea = FLOORS.reduce((a, w) => a + area(w), 0);
  /** The four floor strips as one element: their areas, each with its own gain [derived] */
  const floorClGain = FLOORS.reduce((a, w) => a + area(w) * w.clGain, 0) / floorArea;

  const WINGS: WingData[] = [
    {
      // The two front wing halves [data FRONT_L / FRONT_R]
      name: 'FRONT_WING',
      area: 2 * area(FRONT),
      positionZ: FRONT.position[2],
      angleDeg: FRONT.angleDeg,
      heightRef: 'front',
      lutAOA_CL: scale(FRONT.aoaCl, FRONT.clGain),
      lutAOA_CD: scale(FRONT.aoaCd, FRONT.cdGain),
      lutGH_CL_mult: shiftX(FRONT.ghCl ?? [[0, 1]], -overFront(FRONT)),
      lutGH_CD_mult: shiftX(FRONT.ghCd ?? [[0, 1]], -overFront(FRONT)),
      drs: flap(FRONT),
      lutYaw_CL_mult: yawTable(FRONT.yawClGain),
    },
    {
      // The four floor strips [data FLOOR_*]: the data flies them at a fixed 3.5°, not at the body's rake
      name: 'VENTURI_FLOOR',
      area: floorArea,
      positionZ: FLOORS[0].position[2],
      angleDeg: FLOORS[0].angleDeg,
      heightRef: 'mean',
      lutAOA_CL: flat(at(FLOORS[0].aoaCl, FLOORS[0].angleDeg) * floorClGain),
      lutAOA_CD: flat(at(FLOORS[0].aoaCd, FLOORS[0].angleDeg) * FLOORS[0].cdGain),
      lutGH_CL_mult: FLOORS[0].ghCl ?? [[0, 1]],
      lutGH_CD_mult: FLOORS[0].ghCd ?? [[0, 1]],
      lutYaw_CL_mult: yawTable(FLOORS[0].yawClGain),
    },
    {
      // The two diffuser halves [data DIFFUSER_RL / RR], at their own fixed angle
      name: 'VENTURI_FLOOR',
      area: 2 * area(DIFFUSER),
      positionZ: DIFFUSER.position[2],
      angleDeg: DIFFUSER.angleDeg,
      heightRef: 'rear',
      lutAOA_CL: flat(at(DIFFUSER.aoaCl, DIFFUSER.angleDeg) * DIFFUSER.clGain),
      lutAOA_CD: flat(at(DIFFUSER.aoaCd, DIFFUSER.angleDeg) * DIFFUSER.cdGain),
      lutGH_CL_mult: shiftX(DIFFUSER.ghCl ?? [[0, 1]], -overRear(DIFFUSER)),
      lutGH_CD_mult: shiftX(DIFFUSER.ghCd ?? [[0, 1]], -overRear(DIFFUSER)),
      lutYaw_CL_mult: yawTable(DIFFUSER.yawClGain),
    },
    {
      // The rear wing's main plane [data REAR]
      name: 'REAR_WING',
      area: area(REAR),
      positionZ: REAR.position[2],
      angleDeg: REAR.angleDeg,
      heightRef: 'rear',
      lutAOA_CL: scale(REAR.aoaCl, REAR.clGain),
      lutAOA_CD: scale(REAR.aoaCd, REAR.cdGain),
      lutGH_CL_mult: [[0, 1]],
      lutGH_CD_mult: [[0, 1]],
      lutYaw_CL_mult: yawTable(REAR.yawClGain),
    },
    {
      // ... and its flap, which lies flat in the straight-line mode [data DRS]
      name: 'REAR_WING',
      area: area(DRS),
      positionZ: DRS.position[2],
      angleDeg: DRS.angleDeg,
      heightRef: 'rear',
      lutAOA_CL: scale(DRS.aoaCl, DRS.clGain),
      lutAOA_CD: scale(DRS.aoaCd, DRS.cdGain),
      lutGH_CL_mult: [[0, 1]],
      lutGH_CD_mult: [[0, 1]],
      drs: flap(DRS),
      lutYaw_CL_mult: yawTable(DRS.yawClGain),
    },
  ];

  /** Each element's drag area at its set angle and static height, for the height the total drag acts at [derived] */
  const dragParts: [number, number][] = [
    [area(BODY) * at(BODY.aoaCd, BODY.angleDeg) * BODY.cdGain, BODY.position[1]],
    [2 * area(FRONT) * at(FRONT.aoaCd, FRONT.angleDeg) * FRONT.cdGain, FRONT.position[1]],
    [area(REAR) * at(REAR.aoaCd, REAR.angleDeg) * REAR.cdGain, REAR.position[1]],
    [area(DRS) * at(DRS.aoaCd, DRS.angleDeg) * DRS.cdGain, DRS.position[1]],
    [floorArea * at(FLOORS[0].aoaCd, FLOORS[0].angleDeg) * FLOORS[0].cdGain, FLOOR_Y],
  ];
  const dragArea = dragParts.reduce((a, [cda]) => a + cda, 0);

  return {
    front_lift: 0,
    rear_lift: 0,
    // The body element: drag only at its 3.5° [data BODY]
    drag: Number((area(BODY) * at(BODY.aoaCd, BODY.angleDeg) * BODY.cdGain).toFixed(4)),
    dragCentreY: Number((dragParts.reduce((a, [cda, y]) => a + cda * y, 0) / dragArea).toFixed(3)),
    wings: WINGS,
    front_target_height: F.staticRideHeight,
    rear_target_height: R.staticRideHeight,
    floorOffsetY: FLOOR_Y,
    drsTransitionS: 0.2,
    drsCloseThrottle: 0.5,
    airDensity: 1.225,
  };
}

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

/** Radial stiffness against pressure: 40 % of the rate follows the pressure about its optimum, as `ac-tyre.ts` has it */
const pressureSpring = (rate: number, refPsi: number): LutPoints =>
  [refPsi - 8, refPsi - 4, refPsi, refPsi + 4, refPsi + 8].map((psi) => [psi, Math.round(rate * (0.6 + (0.4 * (psi + 14.7)) / (refPsi + 14.7)))]);

/** The temperatures a grip curve is at its peak between */
function peakWindow(curve: LutPoints): [number, number] {
  const peak = Math.max(...curve.map(([, g]) => g));
  const top = curve.filter(([, g]) => g >= peak - 1e-6);
  return [top[0][0], top[top.length - 1][0]];
}

function modelData(t: Vf26TyreSpec): TyresCompoundData['modelData'] {
  return {
    Dy0: t.dyRef,
    Dx0: t.dxRef,
    lsExpY: t.lsExpY,
    lsExpX: t.lsExpX,
    Fz0: t.fz0,
    dyCurve: t.dyCurve,
    dxCurve: t.dxCurve,
    // A brush tyre on the data's own shape: peak slip angle, sliding level and its decay, the slip ratio of the drive
    // force's peak, the grip lost to sliding speed [data]
    curve: 'brush',
    friction_limit_angle: t.frictionLimitAngleDeg,
    speedSensitivity: t.speedSensitivity,
    pKy2: 4.2,
    slip_ratio_limit: t.peakSlipRatio,
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    use_slip_falloff: true,
    falloff_level: t.falloffLevel,
    falloff_slope: t.falloffSpeed,
    relaxationLengthX: t.relaxationLength,
    relaxationLengthY: t.relaxationLength,
    rollingResistance: t.rollingResistance,
    verticalDamping: t.damp,
    brakeDxMod: t.brakeDxMod ?? 0,
  };
}

type TyreOf = (slot: 'soft' | 'medium' | 'hard', axle: 'front' | 'rear') => Vf26TyreSpec;

function compound(tyre_compound: PhysicsTyreCompound, name: string, shortName: 'S' | 'M' | 'H', slot: 'soft' | 'medium' | 'hard', tyreOf: TyreOf): TyresCompoundData {
  const f = tyreOf(slot, 'front');
  const r = tyreOf(slot, 'rear');
  const rear = modelData(r);
  return {
    name,
    shortName,
    tyre_compound,
    front: { width: f.width, radius: f.radius, rimRadius: f.rimRadius, verticalRateScale: 1 },
    rear: { width: r.width, radius: r.radius, rimRadius: r.rimRadius, verticalRateScale: 1 },
    modelData: modelData(f),
    thermalData: {
      thermalPerformanceCurve: f.thermalCurve,
      optimalTempC: peakWindow(f.thermalCurve),
      // Slow graining and blistering, as the f12026-car's slick [est]
      tread: { grainGain: 0.125, grainGamma: 0.5, blisterGain: 0.125, blisterGamma: 0.5 },
      // The f12026-car slick's heat capacities and cooling; the carcass heats by the tyre's rolling loss [est]
      surfaceHeatCapacity: 1500,
      coreHeatCapacity: 9500,
      slipHeatShare: 0.35,
      hysteresis: 0.0107,
      surfaceToCore: 40,
      surfaceCooling: [5, 0.6],
      coreCooling: [8, 0.2],
      thermalVerticalK: -0.0012,
      thermalVerticalRefC: 100,
    },
    pressureData: {
      optimalPsi: f.pressureRefPsi,
      pressureSpringCurve: pressureSpring(f.rate, f.pressureRefPsi),
      pressureGripSensitivity: 1.0,
      // Out of the blankets, as the f12026-car [est]
      coldRefC: 80,
    },
    camberData: {
      camberGain: f.camberGain,
      contact_camber_c1: f.contactCamberC1,
      contact_camber_c2: f.contactCamberC2,
      dcamber0: f.dcamber0,
      dcamber1: f.dcamber1,
      dcamber0_x: 0,
      dcamber1_x: -6,
    },
    rearOverride: {
      modelData: rear,
      pressureData: { optimalPsi: r.pressureRefPsi, pressureSpringCurve: pressureSpring(r.rate, r.pressureRefPsi) },
      camberData: { camberGain: r.camberGain, dcamber0: r.dcamber0, dcamber1: r.dcamber1 },
    },
  };
}

function tyreCompounds(tyreOf: TyreOf) {
  const MEDIUM = compound('PhysicsTyreCompound_F1_Medium', 'Medium', 'M', 'medium', tyreOf);
  return {
    PhysicsTyreCompound_F1_Soft: compound('PhysicsTyreCompound_F1_Soft', 'Soft', 'S', 'soft', tyreOf),
    PhysicsTyreCompound_F1_Medium: MEDIUM,
    PhysicsTyreCompound_F1_Hard: compound('PhysicsTyreCompound_F1_Hard', 'Hard', 'H', 'hard', tyreOf),
    // Rain tyres on the medium's carcass, as the data builds its own
    PhysicsTyreCompound_F1_Intermediate: deriveRainCompound(MEDIUM, 'intermediate', 'PhysicsTyreCompound_F1_Intermediate', 'Intermediate', true),
    PhysicsTyreCompound_F1_Wet: deriveRainCompound(MEDIUM, 'wet', 'PhysicsTyreCompound_F1_Wet', 'Full Wet', true),
  } satisfies Partial<Record<PhysicsTyreCompound, TyresCompoundData>>;
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

const MASS = VF26_CHASSIS.totalMassKg;
const B = VF26_CHASSIS.inertiaBox;
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

/** The VF26's car data for `VehiclePhysics`: the data's, or with `overrides` in place of some of it */
export function buildVf26Config(overrides: Vf26Overrides = {}) {
  const F: Vf26AxleSuspension = { ...VF26_CHASSIS.front, ...overrides.front };
  const R: Vf26AxleSuspension = { ...VF26_CHASSIS.rear, ...overrides.rear };
  const tyreOf: TyreOf = (slot, axle) => (overrides.tyre ? overrides.tyre(VF26_TYRES[slot][axle], axle) : VF26_TYRES[slot][axle]);
  const softFront = tyreOf('soft', 'front');
  const softRear = tyreOf('soft', 'rear');
  // The body rides where the ride heights put it: a change of their mean lifts the CG with it
  const rideChange = (F.staticRideHeight - VF26_CHASSIS.front.staticRideHeight + R.staticRideHeight - VF26_CHASSIS.rear.staticRideHeight) / 2;
  return {
    screenName: 'vf26',
    chassis: {
      totalMassKg: MASS,
      frontWeightFraction: VF26_CHASSIS.frontWeightFraction,
      wheelbase: VF26_CHASSIS.wheelbase,
      trackWidthFront: F.track,
      trackWidthRear: R.track,
      // Wheel radius + BASEY, the axles' mean [data, derived]
      cgHeight: Number((VF26_CG_HEIGHT_M + rideChange).toFixed(4)),
      inertia: { pitch: box(B.height, B.length), roll: box(B.width, B.height), yaw: box(B.width, B.length) },
      unsprungMassFront: F.unsprungMassKg,
      unsprungMassRear: R.unsprungMassKg,
      ...(overrides.fuelTank ? { fuelTank: overrides.fuelTank } : {}),
      wheelInertiaFront: softFront.angularInertia,
      wheelInertiaRear: softRear.angularInertia,
      maxRoadWheelDeg: VF26_CHASSIS.steering.lockDeg / VF26_CHASSIS.steering.ratio,
      ffbMechanicalTrailM: VF26_CHASSIS.steering.mechanicalTrail,
      // The rack's give under load and the hydraulic assist, as the f12026-car's [est]
      steerComplianceDegPerKN: 0.05,
      powerSteering: { steeringRatio: VF26_CHASSIS.steering.ratio, deadbandNm: 26, rampNm: 6, maxRatio: 0.45 },
    },
    engine: {
      ...ENGINE,
      inertia: (overrides.engineInertia ?? VF26_ENGINE.inertia) + VF26_DRIVETRAIN.gearboxInertia,
      torqueResponseS: overrides.torqueResponseS ?? ENGINE.torqueResponseS,
      powerCurve: overrides.icePowerScale === undefined ? ENGINE.powerCurve : (ENGINE.powerCurve.map(([rpm, kw]) => [rpm, kw * overrides.icePowerScale!]) as LutPoints),
      coastCurve: ENGINE.coastCurve.map(([rpm, nm]) => [rpm, nm * (overrides.coastScale ?? 1)]) as LutPoints,
    },
    ers: overrides.ers ? { ...ERS, ...overrides.ers } : ERS,
    performanceModes: PERFORMANCE_MODES,
    gearbox: {
      ratios: [...VF26_DRIVETRAIN.gearRatios],
      reverse: Math.abs(VF26_DRIVETRAIN.reverseRatio),
      finalDrive: VF26_DRIVETRAIN.finalDrive,
      shiftTimeS: VF26_DRIVETRAIN.upshiftTimeS,
      downshiftTimeS: VF26_DRIVETRAIN.downshiftTimeS,
      shiftTorqueFraction: 0.85,
      ...(overrides.upshiftCutS !== undefined ? { upshiftCutS: overrides.upshiftCutS } : {}),
      efficiency: VF26_DRIVETRAIN.efficiency,
      gears: { redline_rpm: VF26_ENGINE.limiterRpm, upshift_rpm: VF26_DRIVETRAIN.autoUpshiftRpm, downshift_rpm: VF26_DRIVETRAIN.autoDownshiftRpm },
    },
    clutch: {
      maxTorqueNm: VF26_DRIVETRAIN.clutchMaxTorqueNm,
      biteRpm: VF26_DRIVETRAIN.autoClutchStartRpm,
      lockRpm: VF26_DRIVETRAIN.autoClutchFullRpm,
      // In first gear the engine is held where it has its torque: at the anti-stall window it makes a third of it and
      // the car took 4 s to 100 km/h. 7000 rpm is chosen on the launches it gives: 3.0 s with or without traction
      // control, and without it the whole pedal spins the rear wheels past their grip while the car still runs
      // straight (from 7250 rpm up it turns round)
      launchRpm: 7000,
    },
    // Locking torque = preload + POWER / COAST × input torque [data]
    differential: {
      type: 'LSD_Ramp',
      settings: {
        power: overrides.diffPowerLock ?? VF26_DRIVETRAIN.diffPowerLock,
        coast: VF26_DRIVETRAIN.diffCoastLock,
        preload: VF26_DRIVETRAIN.diffPreloadNm,
        friction_faces: 1,
        power_ramp_deg: 45,
        coast_ramp_deg: 45,
      },
      // The f12026-car's halfshafts [est]
      halfshaft: { stiffnessNmPerRad: 13_000, dampingNmsPerRad: 33 },
    },
    // The front share moves 6 % forward by full pedal [data migrationAtFullPedal]
    brakes: {
      maxTorqueNm: overrides.brakeTorqueNm ?? VF26_BRAKES.maxTorqueNm,
      front_bias: VF26_BRAKES.frontBias,
      ebbStep: 0.005,
      migration: { amount: VF26_BRAKES.migrationAtFullPedal, rampStart: 0 },
      ...overrides.brakes,
    },
    suspensions: suspensionData(F, R, softFront.radius, softRear.radius),
    aero: aeroData(F, R),
    tyreCompounds: tyreCompounds(tyreOf),
    compoundSlots: {
      soft: 'PhysicsTyreCompound_F1_Soft',
      medium: 'PhysicsTyreCompound_F1_Medium',
      hard: 'PhysicsTyreCompound_F1_Hard',
      intermediate: 'PhysicsTyreCompound_F1_Intermediate',
      wet: 'PhysicsTyreCompound_F1_Wet',
    },
  } satisfies CarPhysicsConfig;
}

/** The car of the data, as `F1Physics2026` runs it */
export const VF26_CAR_CONFIG = buildVf26Config();
