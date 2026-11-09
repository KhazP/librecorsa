/**
 * Suzuki Liana 1.6 GLX (2002) vehicle data for `VehiclePhysics` (same data model as the f12026-car, see
 * `F12026CarConfig`): the Top Gear "Star in a Reasonably Priced Car" Liana.
 *
 * The numbers come from alekabul's "Physics reworked for Top Gear Liana 1.6 GLX" (OverTake, Assetto Corsa), mapped
 * onto this model:
 *  - [spec]     taken from the mod's data (car / engine / drivetrain / suspensions / tyres / aero / brakes /
 *               electronics); the AC file and key are named where it helps
 *  - [derived]  computed from other values in this file
 *  - [est]      an estimate where this model needs a value the mod's data doesn't have
 *
 * Front-wheel drive through an open differential, a five-speed manual, MacPherson struts at the front (solved here
 * as a double wishbone with a long virtual upper arm square to the strut, which gives a strut's camber curve and roll
 * centre) and double wishbones at the rear. No hybrid, DRS, heave spring or downforce: the body lifts a little at
 * speed. One tyre, the 185/65 R14 street tyre, in every slot: a road car has no slicks or rain tyres to change to.
 */
import type { LutPoints } from '../lut';
import type {
  AeroData,
  CarPhysicsConfig,
  DamperSettingsUnits,
  PerformanceModeData,
  PerformanceModeName,
  SuspensionsData,
  TyreGeometry,
  TyresCompoundData,
} from '../f12026-car/F12026CarConfig';
import type { WetTyreTraits } from '../wet-tyres';
import { modBodyHeightM, modCornerStops } from '../mod-suspension';

/** Driveline efficiency of this model; the wheel torque curve is divided by it for crank torque */
const DRIVELINE_EFFICIENCY = 0.92;

/** Wheel torque curve (rpm → Nm) [spec power.lut]: 144 Nm at 4000 rpm, 102 bhp at 5500 */
const WHEEL_TORQUE: [number, number][] = [
  [0, 0],
  [1000, 60],
  [1500, 86],
  [2000, 104],
  [2500, 117],
  [3000, 130],
  [4000, 144],
  [4500, 143],
  [5000, 139],
  [5500, 132],
  [6000, 117],
  [6500, 100],
  [7000, 72],
  [7500, 0],
];

/** Crank power (kW) at the curve's points [derived] */
const POWER_CURVE: LutPoints = WHEEL_TORQUE.map(([rpm, nm]) => [rpm, ((nm / DRIVELINE_EFFICIENCY) * rpm * Math.PI) / 30 / 1000]);

const ENGINE = {
  powerCurve: POWER_CURVE,
  // Linear overrun torque, 80 Nm at 7000 rpm [spec COAST_REF, NON_LINEARITY 0]
  coastCurve: [
    [0, 0],
    [7000, 80],
    [7500, 85.7],
  ] as LutPoints,
  // Pedal → throttle: a quick first tenth, then near linear [spec throttle.lut]
  throttleResponseCurve: [
    [0, 0],
    [0.1, 0.25],
    [0.2, 0.35],
    [0.3, 0.45],
    [0.4, 0.55],
    [0.5, 0.65],
    [0.6, 0.7],
    [0.7, 0.75],
    [0.8, 0.8],
    [0.9, 0.9],
    [1, 1],
  ] as LutPoints,
  idleRpm: 850,
  // Engine 0.165 + gearbox 0.017 [spec engine.ini / drivetrain.ini INERTIA]
  inertia: 0.182,
  // 40 Hz limiter: half a cycle cut [spec LIMITER_HZ]
  limiterCutS: 0.0125,
};

const NONE: LutPoints = [
  [0, 0],
  [10000, 0],
];

/** No hybrid. The store holds 1 J only so the state-of-charge maths stays finite. */
const ERS = {
  torqueLut: NONE,
  coastLut: NONE,
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

const mode = (performance_mode_name: PerformanceModeName): PerformanceModeData => ({
  performance_mode_name,
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
 * Five-speed manual on a 4.11 final drive [spec drivetrain.ini]: ≈ 185 km/h in fifth at the 7000 rpm limiter, past
 * the drag-limited top speed. No ignition cut: the clutch is out for the quarter-second shift [spec CHANGE_UP_TIME]
 */
const GEARBOX = {
  ratios: [3.55, 1.9, 1.31, 0.97, 0.82],
  reverse: 3.25,
  finalDrive: 4.11,
  shiftTimeS: 0.25,
  shiftTorqueFraction: 0,
  efficiency: DRIVELINE_EFFICIENCY,
  gears: {
    // [spec LIMITER]
    redline_rpm: 7000,
    // Past 6500 rpm the next gear pulls harder than this one [derived power.lut, ratios]
    upshift_rpm: 6500,
    downshift_rpm: 3000,
    // Into a braking zone the auto box clicks down while the lower gear lands under 5500 rpm, near peak power [est]
    brake_downshift_rpm: 5500,
  },
};

const damper = (slow_bump: number, fast_bump: number, slow_rebound: number, fast_rebound: number): DamperSettingsUnits => ({
  slow_bump,
  fast_bump,
  slow_rebound,
  fast_rebound,
});

const NO_DAMPER = damper(0, 0, 0, 0);

/** Sprung load on a front / rear spring at static ride (N): 1250 kg less its hubs (90 / 85 kg), 64 % forward [derived] */
const SPRUNG_KG = 1250 - 2 * 90 - 2 * 85;
const FRONT_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * 0.64) / 2;
const REAR_STATIC_LOAD_N = (SPRUNG_KG * 9.81 * 0.36) / 2;
/**
 * The mod measures its stops from the suspension's design position, with the springs working on their rod lengths
 * (`mod-suspension.ts`): at static ride the soft springs have the fronts 3.5 mm short of that position and the rears
 * 22.5 mm past it, so the stops are these far from static [spec ROD_LENGTH, PACKER_RANGE, BUMPSTOP_UP / DN; derived]
 */
const FRONT_STOPS = modCornerStops({ staticLoadN: FRONT_STATIC_LOAD_N, springRate: 36_000, rodLength: 0.082, packerRange: 0.15, bumpStopUp: 0.075, bumpStopDn: 0.075 });
const REAR_STOPS = modCornerStops({ staticLoadN: REAR_STATIC_LOAD_N, springRate: 20_000, rodLength: 0.057, packerRange: 0.15, bumpStopUp: 0.055, bumpStopDn: 0.05 });
const mm = (m: number) => Number(m.toFixed(4));

/**
 * The mod's wheel rates, front anti-roll bar (no rear bar), bump stops and two-stage dampers [spec suspensions.ini],
 * the stops at their distance from static ride (above): the front strut's packer 72 mm up, its rigid bump stop
 * (500 kN/m, as a strut's is) 79 mm up; the rear's bump stop 33 mm up, its packer 71 mm up; droop 72 / 73 mm.
 * Hardpoints are [x inboard, y up, z forward] from the wheel centre:
 *  - front: the strut's top mount stands in for the upper ball joint, with a 1 m virtual upper arm square to the
 *    strut axis (STRUT_CAR → STRUT_TYRE) [derived]; lower arm and tie rod [spec]. KPI 10.4°, caster 3.3°, within the
 *    real car's alignment specification (SAI 10.9–14.9°, caster 0.2–4.2°)
 *  - rear: double wishbone and toe link [spec]
 * Camber gain and roll-centre heights are what the kinematic solver gives on these points at static [derived].
 */
const SUSPENSIONS: SuspensionsData = {
  front: {
    type: 'SuspensionType_Strut',
    actuation: 'push_rod',
    // [spec STATIC_CAMBER]
    staticCamber: -0.5,
    camberGainKinematic: -21,
    springs: { wheel_rate: 36_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    // [spec PACKER_RANGE, BUMP_STOP_RATE; BUMPSTOP_UP, a strut's rigid stop; BUMPSTOP_DN]
    bumpStop: { range: mm(FRONT_STOPS.packerGapM), rate: 30_000, progression: 0, hardStop: { range: mm(FRONT_STOPS.bumpStopGapM), rate: 500_000 } },
    droopTravel: mm(FRONT_STOPS.droopM),
    rollCentreHeight: 0.054,
    // [spec ARB FRONT]
    arb: 12_000,
    hardpoints: [
      [1.1157, 0.2083, 0.1395],
      [1.1157, 0.2083, -0.1605],
      [0.41, -0.057, 0.325],
      [0.39, -0.05, -0.04],
      [0.132, 0.388, -0.0105],
      [0.052, -0.05, 0.015],
      [0.39, -0.0525, 0.06],
      [0.052, -0.05, 0.15],
    ],
  },
  rear: {
    type: 'SuspensionType_DoubleWishbone',
    actuation: 'push_rod',
    // Positive camber at the rear, as the mod has it [spec STATIC_CAMBER]
    staticCamber: 1.3,
    camberGainKinematic: -41,
    springs: { wheel_rate: 20_000, helper_rate: 0, helper_range: 0 },
    heave: { rate: 0, gap: 1, packerGap: 1, packerRate: 0 },
    // [spec BUMPSTOP_UP, PACKER_RANGE, BUMP_STOP_RATE; BUMPSTOP_DN]
    bumpStop: { range: mm(REAR_STOPS.bumpStopGapM), rate: 50_000, progression: 0, hardStop: { range: mm(REAR_STOPS.packerGapM), rate: 50_000 } },
    droopTravel: mm(REAR_STOPS.droopM),
    rollCentreHeight: 0.098,
    // No rear bar [spec ARB REAR]
    arb: 0,
    hardpoints: [
      [0.34842, 0.0737, 0.2214],
      [0.418, 0.0654, 0.0308],
      [0.37702, -0.11686, 0.3042],
      [0.47702, -0.11686, -0.1154],
      [0.06622, 0.1207, -0.0065],
      [0.04602, -0.12706, 0.0187],
      [0.48002, -0.07906, -0.1054],
      [0.04602, -0.07506, -0.0454],
    ],
  },
  dampers_controller: {
    front: {
      base: damper(1400, 1134, 3000, 2889),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.14,
    },
    rear: {
      base: damper(2000, 1542, 2500, 2000),
      heave: NO_DAMPER,
      roll: NO_DAMPER,
      pitch: NO_DAMPER,
      fastThresholdMs: 0.1,
      fastReboundThresholdMs: 0.14,
    },
  },
};

const WHEELBASE = 2.46;
/**
 * The body's height at each axle: the tyre's loaded radius (0.288 m less ≈ 10 / 8 mm of deflection at its hot
 * pressure) less the wheel centre's height in the body frame (BASEY −0.25, plus the static offset): 0.531 m at the
 * front, 0.508 m at the rear, so the CG, 64 % of the sprung weight forward, rides 0.523 m up [spec BASEY, RADIUS, RATE;
 * derived]
 */
const FRONT_BODY_HEIGHT = modBodyHeightM(0.288, (FRONT_STATIC_LOAD_N + 90 * 9.81) / 367_840, -0.25, FRONT_STOPS.staticOffsetM);
const REAR_BODY_HEIGHT = modBodyHeightM(0.288, (REAR_STATIC_LOAD_N + 85 * 9.81) / 309_760, -0.25, REAR_STOPS.staticOffsetM);
const CG_HEIGHT = Number((FRONT_BODY_HEIGHT + (REAR_BODY_HEIGHT - FRONT_BODY_HEIGHT) * 0.36).toFixed(4));
/** Ride-height pickups 0.37 m (front) and 0.35 m (rear) below the CG's level [spec RIDE, derived] */
const FRONT_TARGET_HEIGHT = Number((FRONT_BODY_HEIGHT - 0.37).toFixed(4));
const REAR_TARGET_HEIGHT = Number((REAR_BODY_HEIGHT - 0.35).toFixed(4));
/** Body and boot elements: chord 1 × span 2 m [spec aero.ini] */
const AERO_AREA = 2;
/** The boot's lift (CL −0.134 × CL_GAIN 0.5 × area) acts 1.47 m behind the CG, 0.10 m ahead of the rear axle [derived] */
const BOOT_LIFT = -0.134 * 0.5 * AERO_AREA;
const BOOT_FRONT_SHARE = (-1.47 + 0.64 * WHEELBASE) / WHEELBASE;

/**
 * Drag and a little lift, no downforce [spec aero.ini, at 0°]: the body's CD 0.36 and the boot element's 0.1 × 0.36
 * (CdA 0.79 m²); the boot element lifts (CL·A −0.134), split between the axles by where it acts.
 */
const AERO: AeroData = {
  front_lift: BOOT_LIFT * BOOT_FRONT_SHARE,
  rear_lift: BOOT_LIFT * (1 - BOOT_FRONT_SHARE),
  drag: 0.36 * AERO_AREA * 1.1,
  wings: [],
  front_target_height: FRONT_TARGET_HEIGHT,
  rear_target_height: REAR_TARGET_HEIGHT,
  floorOffsetY: -(CG_HEIGHT - 0.5 * (FRONT_TARGET_HEIGHT + REAR_TARGET_HEIGHT)),
  drsTransitionS: 0.25,
  drsCloseThrottle: 0.5,
  airDensity: 1.225,
};

/** 185/65 R14 street tyre: section 0.185 m, radius 0.288 m, rim radius 0.1908 m [spec tyres.ini] */
const STREET: TyreGeometry = { width: 0.185, radius: 0.288, rimRadius: 0.1908, verticalRateScale: 1 };

/** The load the mod's v3 tyre data states its load sensitivity over (N): DY1 / DX1 are the change in μ per this much load */
const LOAD_SENSITIVITY_REF_N = 2000;
/**
 * The mod's v3 tyre grip falls linearly with load: μ = DY0 + DY1 · Fz / 2000 N [spec DY0 1.2557 / DY1 −0.050,
 * DX0 1.1967 / DX1 −0.048]: 1.16 at the front's static 3.9 kN. Tabulated so this model's load-sensitivity curve
 * follows it exactly.
 */
const linearLoadCurve = (mu0: number, perRef: number): LutPoints =>
  [0, 1000, 2000, 3000, 4000, 5000, 6000, 8000, 10000].map((fz) => [fz, Number(Math.max(0.5, muAt(mu0, perRef, fz)).toFixed(4))]);

/** Static corner loads (N) [derived]: the reference loads for Dy0 / Dx0 and the power-law fallback */
const MASS = 1250;
const FZ0_FRONT = (MASS * 9.81 * 0.64) / 2;
const FZ0_REAR = (MASS * 9.81 * 0.36) / 2;
function muAt(mu0: number, perRef: number, fz: number): number {
  return mu0 + (perRef * fz) / LOAD_SENSITIVITY_REF_N;
}
/** Local load-sensitivity exponent of the linear law at `fz` [derived] */
const lsExpAt = (mu0: number, perRef: number, fz: number) => 1 + (perRef * fz) / LOAD_SENSITIVITY_REF_N / muAt(mu0, perRef, fz);

/**
 * A road tyre's tread clears water well, unlike a slick, and grips on a wet road at about two thirds of its dry level
 * [est]; it is its own dry tyre, so the grip tables and working window stay as they are.
 */
const STREET_TYRE_TRAITS: WetTyreTraits = {
  dryGrip: 1,
  wetGrip: 0.7,
  clearMm: 2.2,
  treadDepthMm: 7,
  tempShiftC: 0,
  dryWearScale: 1,
  dryHeatScale: 1,
  wetWearScale: 0.7,
};

const STREET_COMPOUND: TyresCompoundData = {
  name: 'Street',
  shortName: 'S',
  tyre_compound: 'PhysicsTyreCompound_Road_Street',
  wetTraits: STREET_TYRE_TRAITS,
  // Grip (% of new) against km slid [spec street_front.lut]
  wear: { curve: [[0, 100], [0.3, 100], [0.5, 99.5], [1, 99], [1.5, 98.5], [4, 98], [10, 97], [11, 96]] },
  front: STREET,
  rear: STREET,
  modelData: {
    Dy0: Number(muAt(1.2557, -0.05, FZ0_FRONT).toFixed(4)),
    Dx0: Number(muAt(1.1967, -0.048, FZ0_FRONT).toFixed(4)),
    lsExpY: Number(lsExpAt(1.2557, -0.05, FZ0_FRONT).toFixed(4)),
    lsExpX: Number(lsExpAt(1.1967, -0.048, FZ0_FRONT).toFixed(4)),
    Fz0: Math.round(FZ0_FRONT),
    dyCurve: linearLoadCurve(1.2557, -0.05),
    dxCurve: linearLoadCurve(1.1967, -0.048),
    // A brush tyre on the mod's v3 shape data: the peak slip angle [spec FRICTION_LIMIT_ANGLE], a fuller rise to it
    // [spec XMU], the peak angle growing 5 % per 2 kN of load [derived from FLEX 0.000984], and the grip lost to
    // sliding speed, 6.4 % at 10 m/s [spec SPEED_SENSITIVITY]. A v3 tyre has no falloff: past the peak it holds its
    // grip but for the sliding speed, which is what makes a street tyre forgiving. One curve for both directions
    // [approx: the data states its slip against the road speed, this family against the wheel's]
    curve: 'brush',
    friction_limit_angle: 13.2,
    curveFullness: 0.28,
    peakSlipLoadGain: 0.05,
    peakSlipLoadRefN: 2000,
    longStiffnessMult: 1,
    speedSensitivity: 0.006383,
    // Unused by a brush tyre (the magic-formula family's stiffness law)
    pKy2: Number((5910 / FZ0_FRONT).toFixed(2)),
    // The slip the driver aids are scaled to: the mod's ABS (8 %) and TC (12 %) targets sit either side [est]
    slip_ratio_limit: 0.11,
    new_combined: false,
    fx_shift_SA: 0,
    fx_scale_SA: 0,
    fy_shift_SR: 0,
    fy_scale_SR: 0,
    use_slip_falloff: false,
    falloff_level: 1,
    falloff_slope: 0,
    // [spec RELAXATION_LENGTH]
    relaxationLengthX: 0.04741,
    relaxationLengthY: 0.04741,
    rollingResistance: 0.01,
    // [spec DAMP]
    verticalDamping: 1500,
    pneumaticTrail: 0.035,
  },
  thermalData: {
    // Grip against tread temperature (°C) [spec tcurve_street.lut]
    thermalPerformanceCurve: [
      [0, 0.96],
      [20, 0.97],
      [40, 0.98],
      [60, 0.995],
      [75, 1],
      [85, 1],
      [100, 0.99],
      [110, 0.97],
      [140, 0.97],
      [160, 0.95],
      [220, 0.9],
      [250, 0.85],
    ],
    optimalTempC: [75, 85],
    // [spec GRAIN_GAIN / GRAIN_GAMMA, BLISTER_GAIN / BLISTER_GAMMA]
    tread: { grainGain: 0.4, grainGamma: 2, blisterGain: 0.3, blisterGamma: 1.5 },
    // A lighter tyre than a GT3 slick heats and cools faster: the GT3's capacities × 0.6 [est]
    surfaceHeatCapacity: 1100,
    coreHeatCapacity: 6600,
    slipHeatShare: 0.35,
    hysteresis: 0.0028,
    surfaceToCore: 40,
    surfaceCooling: [5, 0.6],
    coreCooling: [8, 0.2],
    thermalVerticalK: -0.001,
    thermalVerticalRefC: 80,
  },
  pressureData: {
    // [spec PRESSURE_IDEAL]
    optimalPsi: 42,
    // RATE 309 760 N/m at the 36 psi static pressure + 9680 N/m per psi [spec RATE, PRESSURE_SPRING_GAIN]
    pressureSpringCurve: [
      [15, 106_480],
      [25, 203_280],
      [36, 309_760],
      [42, 367_840],
      [50, 445_280],
    ],
    pressureGripSensitivity: 1.0,
    // 0.2 % of grip per psi off the ideal [spec PRESSURE_D_GAIN]
    pressureGripLossPerPsi: 0.002,
    // Set cold in the pits, not on blankets [est]
    coldRefC: 25,
  },
  camberData: {
    // [spec CAMBER_GAIN, DCAMBER_0, DCAMBER_1]
    camberGain: 0.132,
    contact_camber_c1: 1,
    contact_camber_c2: 40,
    dcamber0: 1.5,
    dcamber1: -13,
    dcamber0_x: 0,
    dcamber1_x: -6,
  },
  // The rear's own reference load and pressures [spec REAR]
  rearOverride: {
    modelData: {
      Dy0: Number(muAt(1.2557, -0.05, FZ0_REAR).toFixed(4)),
      Dx0: Number(muAt(1.1967, -0.048, FZ0_REAR).toFixed(4)),
      lsExpY: Number(lsExpAt(1.2557, -0.05, FZ0_REAR).toFixed(4)),
      lsExpX: Number(lsExpAt(1.1967, -0.048, FZ0_REAR).toFixed(4)),
      Fz0: Math.round(FZ0_REAR),
      // The same tyre's ≈ 5.9 kN stiffness peak over the lighter rear's Fz0
      pKy2: Number((5910 / FZ0_REAR).toFixed(2)),
    },
    pressureData: {
      optimalPsi: 40,
      // RATE 290 400 N/m at the 38 psi static pressure + 9680 N/m per psi [spec REAR]
      pressureSpringCurve: [
        [15, 67_760],
        [25, 164_560],
        [38, 290_400],
        [42, 329_120],
        [50, 406_560],
      ],
    },
  },
};

/** Equivalent box 1.69 × 1.55 × 4.23 m [spec INERTIA, derived] */
const box = (a: number, b: number) => (MASS / 12) * (a * a + b * b);

export const SUZUKI_LIANA_CONFIG = {
  screenName: 'Suzuki Liana 1.6',
  drivenAxle: 'front',
  chassis: {
    // With driver, no fuel [spec TOTALMASS]
    totalMassKg: MASS,
    // [spec CG_LOCATION]
    frontWeightFraction: 0.64,
    wheelbase: WHEELBASE,
    trackWidthFront: 1.428,
    trackWidthRear: 1.432,
    // Wheel centres 0.25 m below the CG on 0.288 m tyres [spec BASEY, derived]
    cgHeight: CG_HEIGHT,
    inertia: { pitch: box(1.55, 4.23), roll: box(1.69, 1.55), yaw: box(1.69, 4.23) },
    // [spec HUB_MASS]
    unsprungMassFront: 90,
    unsprungMassRear: 85,
    // [spec ANGULAR_INERTIA]
    wheelInertiaFront: 1.65,
    wheelInertiaRear: 1.62,
    // 540° lock each way on a 15:1 rack [spec STEER_LOCK, STEER_RATIO]
    maxRoadWheelDeg: 540 / 15,
    // 3.3° caster on a 0.288 m tyre [derived]
    ffbMechanicalTrailM: 0.017,
  },
  engine: ENGINE,
  ers: ERS,
  performanceModes: { PSH: mode('PSH'), RAC: mode('RAC'), BAL: mode('BAL'), LIC: mode('LIC'), CHR: mode('CHR') },
  gearbox: GEARBOX,
  // 300 Nm clutch; the auto clutch bites at 1200 rpm and closes by 1800 [spec CLUTCH, AUTOCLUTCH]
  clutch: { maxTorqueNm: 300, biteRpm: 1200, lockRpm: 1800 },
  // Open differential: 4 % lock under power and on the overrun, no preload [spec DIFFERENTIAL]
  differential: {
    type: 'LSD_Ramp',
    settings: { power: 0.04, coast: 0.04, preload: 0, friction_faces: 1, power_ramp_deg: 45, coast_ramp_deg: 45 },
  },
  // Iron discs, 1600 Nm per wheel at full pedal, 75 % front, no bias adjuster [spec brakes.ini]
  brakes: { maxTorqueNm: 1600, front_bias: 0.75, ebbStep: 0.005, brakeByWire: false, discMaterial: 'endurance-steel', migration: { amount: 0, rampStart: 0 } },
  suspensions: SUSPENSIONS,
  aero: AERO,
  tyreCompounds: { PhysicsTyreCompound_Road_Street: STREET_COMPOUND },
  compoundSlots: {
    soft: 'PhysicsTyreCompound_Road_Street',
    medium: 'PhysicsTyreCompound_Road_Street',
    hard: 'PhysicsTyreCompound_Road_Street',
    intermediate: 'PhysicsTyreCompound_Road_Street',
    wet: 'PhysicsTyreCompound_Road_Street',
  },
} satisfies CarPhysicsConfig;

/**
 * ABS at 8 % lock slip and TC at 12 % wheelspin by default, cycling at 18 Hz and 15 Hz (an early-2000s ABS pump),
 * and no traction control under 20 km/h [spec electronics.ini]. The other switch positions step 1 % either side [est].
 */
export const SUZUKI_LIANA_ELECTRONICS = {
  absLevels: [0.05, 0.06, 0.07, 0.08, 0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16],
  absDefault: 0.08,
  absRateHz: 18,
  tcLevels: [0.09, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.2],
  tcDefault: 0.12,
  tcRateHz: 15,
  tcMinSpeedKmh: 20,
  tcLateralTightening: { gain: 0.05, exponent: 1.3, floor: 0.6 },
};
