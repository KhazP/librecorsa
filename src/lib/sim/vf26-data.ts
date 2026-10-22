/**
 * Vehicle constants for the 2026 "Grand Prix VF26".
 *
 * Source: the VF26 car data package (see CREDITS.md).
 *
 * Parameters transcribed and adapted into TypeScript:
 *  - [mod]: Direct extraction from mod data files
 *  - [setup]: Default garage setup parameters
 *  - [derived]: Computed/inferred geometric and physical properties
 *  - [assumed]: FIA 2026 technical regulations baseline
 *
 * Provenance, copyright & licenses: see CREDITS.md in repository root.
 */

import type { TireCompound } from '@/types/f1';
import type { LutPoints } from './lut';
import { WET_TYRE_TRAITS, type WetTyreTraits } from './wet-tyres';

// ---------------------------------------------------------------------------
// Tyres  (`tyres/f1_2026/f12026_*_305_720_18.tyre` / `*_405_720_18.tyre`)
// ---------------------------------------------------------------------------

export interface Vf26TyreSpec {
  name: string;
  /** Section width (m) [mod] */
  width: number;
  /** Unloaded radius (m) [mod] */
  radius: number;
  /** Rim radius (m) [mod] */
  rimRadius: number;
  /** Radial (vertical) stiffness (N/m) [mod] */
  rate: number;
  /** Radial damping (N·s/m) [mod] */
  damp: number;
  /** Lateral reference friction at FZ0 (DY_REF) [mod] */
  dyRef: number;
  /** Longitudinal reference friction at FZ0 (DX_REF) [mod] */
  dxRef: number;
  /** Lateral load-sensitivity exponent (LS_EXPY) [mod] */
  lsExpY: number;
  /** Longitudinal load-sensitivity exponent (LS_EXPX) [mod] */
  lsExpX: number;
  /** Reference load for DX/DY_REF (N) [mod] */
  fz0: number;
  /** Slip angle of peak lateral force (deg, FRICTION_LIMIT_ANGLE) [mod] */
  frictionLimitAngleDeg: number;
  /** Slip ratio of peak longitudinal force [mod] */
  peakSlipRatio: number;
  /** Grip retained deep in the slide (FALLOFF_LEVEL) [mod] */
  falloffLevel: number;
  /** How quickly grip falls off past the peak (FALLOFF_SPEED) [mod] */
  falloffSpeed: number;
  /** Camber grip polynomial: 1 + DCAMBER_0*γ + DCAMBER_1*γ² (γ in rad) [mod] */
  dcamber0: number;
  dcamber1: number;
  /** Grip loss per m/s of sliding speed (SPEED_SENSITIVITY) [mod] */
  speedSensitivity: number;
  /** Rolling resistance coefficient [mod] */
  rollingResistance: number;
  /** Rotational inertia of wheel + tyre (kg·m²) [assumed: 18" F1 wheel assembly] */
  angularInertia: number;
  /** Lateral relaxation length (m) [assumed] */
  relaxationLength: number;
  /** Running (hot) inflation pressure at which grip peaks (psi) [assumed: 2026 Pirelli window] */
  pressureRefPsi: number;
  /** Performance vs. temperature (°C → grip multiplier) [mod] */
  thermalCurve: LutPoints;
  /** Tread wear per joule of sliding friction energy in the contact patch (1/J) [assumed, per compound] */
  wearPerJ: number;
  /** Extra longitudinal friction multiplier under braking (`BRAKE_DX_MOD`, default 0.05 = +5 %) */
  brakeDxMod?: number;
  /** Optional 16-point non-power-law lateral load-sensitivity LUT (Fz [N] → μ_y) */
  dyCurve?: LutPoints;
  /** Optional 16-point non-power-law longitudinal load-sensitivity LUT (Fz [N] → μ_x) */
  dxCurve?: LutPoints;
  /** Behaviour on a wet road (`wet-tyres.ts`); absent = a slick */
  wet?: WetTyreTraits;
}

/**
 * Builds a 16-point non-power-law load-sensitivity LUT (Fz [N] → μ) for 2026 F1 front (305/720-18) and
 * rear (405/720-18) slicks: matches D_REF · (Fz / Fz0)^(lsExp − 1) across nominal loads with realistic
 * contact-patch shoulder saturation at extreme aero + curb loads (> 6.5 kN).
 */
function buildVf26LoadCurve(dRef: number, fz0: number, lsExp: number): LutPoints {
  const loads = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10500];
  return loads.map((fz) => {
    const ratio = Math.max(0.18, fz / fz0);
    const baseMu = dRef * Math.pow(ratio, lsExp - 1);
    const highLoadSaturation = fz > 6500 ? 1 - 0.01 * Math.pow((fz - 6500) / 3500, 1.3) : 1;
    return [fz, Number((baseMu * highLoadSaturation).toFixed(4))] as [number, number];
  });
}

/**
 * Tread wear per joule of contact-patch sliding energy. Calibrated so the soft loses ≈3 % of its tread
 * per lap at Rwanda (`scripts/tyre-stint-report.ts 3 soft`); medium and hard scale down by their rubber
 * wear ratio [assumed]
 */
const WEAR_PER_J_SOFT = 4.1e-8;
const WEAR_PER_J: Record<'soft' | 'medium' | 'hard', number> = {
  soft: WEAR_PER_J_SOFT,
  medium: 0.65 * WEAR_PER_J_SOFT,
  hard: 0.45 * WEAR_PER_J_SOFT,
};

const TCURVE_SOFT: LutPoints = [
  [0, 0.75], [20, 0.8], [40, 0.85], [60, 0.9], [90, 0.995], [95, 1], [110, 1],
  [115, 0.995], [140, 0.96], [180, 0.94], [240, 0.88], [300, 0.6],
];
const TCURVE_MED: LutPoints = [
  [0, 0.75], [20, 0.8], [40, 0.85], [60, 0.93], [95, 0.99], [100, 1], [125, 1],
  [140, 0.98], [180, 0.95], [240, 0.88], [300, 0.7],
];
const TCURVE_HARD: LutPoints = [
  [0, 0.75], [20, 0.8], [40, 0.85], [60, 0.95], [100, 0.99], [105, 1], [140, 1],
  [150, 0.99], [180, 0.97], [240, 0.9], [300, 0.75],
];

const FRONT_COMMON = {
  width: 0.305,
  radius: 0.35975,
  rimRadius: 0.2286,
  lsExpY: 0.894284,
  lsExpX: 0.929284,
  fz0: 3930,
  frictionLimitAngleDeg: 6.71311,
  peakSlipRatio: 0.10051,
  falloffSpeed: 2,
  dcamber0: 1.2,
  dcamber1: -11,
  speedSensitivity: 0.002,
  rollingResistance: 0.011,
  angularInertia: 1.15,
  relaxationLength: 0.12,
  pressureRefPsi: 23.5,
  brakeDxMod: 0.05,
} as const;

const REAR_COMMON = {
  width: 0.405,
  radius: 0.3582,
  rimRadius: 0.2286,
  // Wider 405/720-18 rear carcass has a flatter load-sensitivity curve than the 305 front so rear grip holds up
  // under combined aero + longitudinal acceleration load transfer
  lsExpY: 0.9125,
  lsExpX: 0.9445,
  fz0: 4080,
  frictionLimitAngleDeg: 6.53704,
  peakSlipRatio: 0.10051,
  falloffSpeed: 2,
  dcamber0: 1.32,
  dcamber1: -11,
  speedSensitivity: 0.002,
  rollingResistance: 0.011,
  angularInertia: 1.45,
  relaxationLength: 0.14,
  pressureRefPsi: 21.5,
  brakeDxMod: 0.05,
} as const;

const VF26_SLICKS: Record<'soft' | 'medium' | 'hard', { front: Vf26TyreSpec; rear: Vf26TyreSpec }> = {
  soft: {
    front: {
      ...FRONT_COMMON,
      name: 'Slick Soft (S)',
      rate: 332218,
      damp: 1367.08,
      dyRef: 1.85569,
      dxRef: 1.96326,
      dyCurve: buildVf26LoadCurve(1.85569, FRONT_COMMON.fz0, FRONT_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(1.96326, FRONT_COMMON.fz0, FRONT_COMMON.lsExpX),
      falloffLevel: 0.81,
      thermalCurve: TCURVE_SOFT,
      wearPerJ: WEAR_PER_J.soft,
    },
    rear: {
      ...REAR_COMMON,
      name: 'Slick Soft (S)',
      rate: 364491,
      damp: 1499.88,
      dyRef: 1.93114,
      dxRef: 2.04199,
      dyCurve: buildVf26LoadCurve(1.93114, REAR_COMMON.fz0, REAR_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(2.04199, REAR_COMMON.fz0, REAR_COMMON.lsExpX),
      falloffLevel: 0.81,
      thermalCurve: TCURVE_SOFT,
      wearPerJ: WEAR_PER_J.soft,
    },
  },
  medium: {
    front: {
      ...FRONT_COMMON,
      name: 'Slick Medium (M)',
      rate: 345507,
      damp: 1421.76,
      dyRef: 1.8115,
      dxRef: 1.91707,
      dyCurve: buildVf26LoadCurve(1.8115, FRONT_COMMON.fz0, FRONT_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(1.91707, FRONT_COMMON.fz0, FRONT_COMMON.lsExpX),
      falloffLevel: 0.8,
      thermalCurve: TCURVE_MED,
      wearPerJ: WEAR_PER_J.medium,
    },
    rear: {
      ...REAR_COMMON,
      name: 'Slick Medium (M)',
      rate: 364491,
      damp: 1499.88,
      dyRef: 1.88516,
      dxRef: 1.99395,
      dyCurve: buildVf26LoadCurve(1.88516, REAR_COMMON.fz0, REAR_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(1.99395, REAR_COMMON.fz0, REAR_COMMON.lsExpX),
      falloffLevel: 0.8,
      thermalCurve: TCURVE_MED,
      wearPerJ: WEAR_PER_J.medium,
    },
  },
  hard: {
    front: {
      ...FRONT_COMMON,
      name: 'Slick Hard (H)',
      rate: 345507,
      damp: 1421.76,
      dyRef: 1.76732,
      dxRef: 1.87087,
      dyCurve: buildVf26LoadCurve(1.76732, FRONT_COMMON.fz0, FRONT_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(1.87087, FRONT_COMMON.fz0, FRONT_COMMON.lsExpX),
      falloffLevel: 0.79,
      thermalCurve: TCURVE_HARD,
      wearPerJ: WEAR_PER_J.hard,
    },
    rear: {
      ...REAR_COMMON,
      name: 'Slick Hard (H)',
      rate: 364491,
      damp: 1499.88,
      dyRef: 1.83918,
      dxRef: 1.9459,
      dyCurve: buildVf26LoadCurve(1.83918, REAR_COMMON.fz0, REAR_COMMON.lsExpY),
      dxCurve: buildVf26LoadCurve(1.9459, REAR_COMMON.fz0, REAR_COMMON.lsExpX),
      falloffLevel: 0.79,
      thermalCurve: TCURVE_HARD,
      wearPerJ: WEAR_PER_J.hard,
    },
  },
};

/**
 * A treaded rain tyre built on the medium slick's carcass [assumed]: the grip tables scaled by the compound's dry grip,
 * the temperature curve moved down to its cooler window (and falling off faster above it, so a rain tyre on a dry
 * track overheats), a longer, softer tread (relaxation length, peak slip angle) and the medium's wear rate. Its water
 * behaviour, extra heat and wear on a dry road come from `wet` at run time
 */
function deriveVf26RainTyre(base: Vf26TyreSpec, kind: 'intermediate' | 'wet'): Vf26TyreSpec {
  const traits = WET_TYRE_TRAITS[kind];
  const k = traits.dryGrip;
  const peakC = 102.5;
  const thermalCurve: LutPoints = base.thermalCurve.map(([t, g]) => {
    const shifted = t + traits.tempShiftC;
    // Above the shifted peak the rubber goes off half as fast again as the slick's
    const over = Math.max(0, t - peakC);
    return [Math.max(-20, shifted), Number(Math.max(0.5, 1 - (1 - g) * (1 + 0.5 * Math.min(1, over / 40))).toFixed(4))] as [number, number];
  });
  return {
    ...base,
    name: kind === 'wet' ? 'Full Wet (W)' : 'Intermediate (I)',
    dyRef: base.dyRef * k,
    dxRef: base.dxRef * k,
    dyCurve: base.dyCurve?.map(([fz, mu]) => [fz, Number((mu * k).toFixed(4))] as [number, number]),
    dxCurve: base.dxCurve?.map(([fz, mu]) => [fz, Number((mu * k).toFixed(4))] as [number, number]),
    frictionLimitAngleDeg: base.frictionLimitAngleDeg * (kind === 'wet' ? 1.12 : 1.06),
    peakSlipRatio: base.peakSlipRatio * (kind === 'wet' ? 1.12 : 1.06),
    relaxationLength: base.relaxationLength * (kind === 'wet' ? 1.10 : 1.05),
    falloffLevel: Math.min(0.92, base.falloffLevel + (kind === 'wet' ? 0.06 : 0.04)),
    thermalCurve,
    wearPerJ: WEAR_PER_J.medium,
    wet: traits,
  };
}

export const VF26_TYRES: Record<TireCompound, { front: Vf26TyreSpec; rear: Vf26TyreSpec }> = {
  ...VF26_SLICKS,
  intermediate: {
    front: deriveVf26RainTyre(VF26_SLICKS.medium.front, 'intermediate'),
    rear: deriveVf26RainTyre(VF26_SLICKS.medium.rear, 'intermediate'),
  },
  wet: {
    front: deriveVf26RainTyre(VF26_SLICKS.medium.front, 'wet'),
    rear: deriveVf26RainTyre(VF26_SLICKS.medium.rear, 'wet'),
  },

};

// ---------------------------------------------------------------------------
// Chassis  (`data/cardata.car` section 1 / 2, `data/setup/vf26_setup.carsetup`)
// ---------------------------------------------------------------------------

export interface Vf26AxleSuspension {
  /** Wheel rate of the corner spring (N/m) [setup] */
  springRate: number;
  /** Progressive spring rate (N/m per m of travel) [mod] */
  progressiveRate: number;
  /** Bump travel from static before the bump rubber (m) [setup] */
  bumpStopTravel: number;
  /** Bump rubber rate (N/m) [assumed — mod rubber rate is tied to a common_phsx curve] */
  bumpStopRate: number;
  /** Droop travel from static before the rebound stop (m) [setup] */
  droopTravel: number;
  /** Damper: slow/fast bump & rebound (N·s/m) and knee speeds (m/s) [mod] */
  damper: {
    bumpSlow: number;
    bumpFast: number;
    reboundSlow: number;
    reboundFast: number;
    bumpThreshold: number;
    reboundThreshold: number;
  };
  /** Third (heave) element rate (N/m) [mod] */
  heaveRate: number;
  /** Heave progressive rate (N/m per m) [mod] */
  heaveProgressiveRate: number;
  /** Heave travel before the heave packer engages (m) [mod] */
  heavePackerTravel: number;
  /** Heave packer rate (N/m) [assumed] */
  heavePackerRate: number;
  /** Heave damper (N·s/m) [assumed — mod uses an external Multimatic curve] */
  heaveDamping: number;
  /** Anti-roll bar wheel rate (N/m) [setup] */
  arbRate: number;
  /** Unsprung mass per corner (kg) [assumed] */
  unsprungMassKg: number;
  /**
   * Static camber at static ride height (deg, negative = top in) [setup: the camber setting, field 4.2. The
   * setup's field 4.5 (-2.74 / -0.72) is the STATIC_CAMBER offset the game solved at the hardpoint reference
   * so that the car sits at the set camber; it is not the static camber]
   */
  staticCamberDeg: number;
  /**
   * Camber change per metre of bump (deg/m, negative = more negative camber in bump) [derived from hardpoints:
   * 3D wishbone kinematics with the inclined arm axes. Consistent with the setup's 4.2 vs 4.5 offsets]
   */
  camberGainDegPerM: number;
  /** Static toe (deg, + = toe-in) [setup: the toe setting, field 4.3; field 4.6 is the solved TOE_OUT rod offset] */
  staticToeDeg: number;
  /** Static floor ride height at this axle (m) [setup] */
  staticRideHeight: number;
  /** Track width (m) [mod] */
  track: number;
  /** Distance from CG to wheel center vertically (BASEY, m) [mod] */
  baseY: number;
  /**
   * Double-wishbone hardpoints (x inboard from wheel centre, y up from wheel centre, z forward)
   * [carTopFront, carTopRear, carBottomFront, carBottomRear, tyreTop, tyreBottom] [mod]
   */
  hardpoints: ReadonlyArray<readonly [number, number, number]>;
}

export const VF26_CHASSIS = {
  name: 'VF26 2026',
  /** Total mass incl. driver, excluding fuel (kg) [mod] */
  totalMassKg: 768,
  /** Default race fuel (kg) [setup] */
  fuelKg: 40,
  /** Tank capacity (kg) [assumed — 110 is not in the package; cardata field 1.6 = 120 may be the tank size] */
  fuelTankKg: 110,
  /** Fuel use at full throttle (kg/s) — 2026 energy-flow limit (≈ 70 kg/h) [assumed] */
  fuelFlowKgS: 0.0194,
  /** Uniform-box dimensions W×H×L (m) used to compute principal chassis moments of inertia */
  inertiaBox: { width: 1.93, height: 0.82, length: 5.0 },
  /** Wheelbase (m) [mod] */
  wheelbase: 3.4,
  /** Static fraction of weight on the front axle (CG_LOCATION) [mod] */
  frontWeightFraction: 0.454,
  steering: {
    /** Steering-wheel lock (deg) [mod] */
    lockDeg: 270,
    /** Steering ratio [setup] */
    ratio: 14,
    /** Force feedback multiplier [mod] */
    ffbMult: 1.1,
    /** Mechanical trail (m) [assumed] */
    mechanicalTrail: 0.012,
    /** Maximum hand steering speed at the steering wheel (deg/s) [assumed — human limit] */
    maxWheelSpeedDegS: 900,
  },
  front: {
    springRate: 200000,
    progressiveRate: 25000,
    bumpStopTravel: 0.03831,
    bumpStopRate: 250000,
    droopTravel: 0.01031,
    damper: { bumpSlow: 1100, bumpFast: 1460, reboundSlow: 3500, reboundFast: 3850, bumpThreshold: 0.05, reboundThreshold: 0.12 },
    heaveRate: 60000,
    heaveProgressiveRate: 15000,
    heavePackerTravel: 0.035,
    heavePackerRate: 600000,
    heaveDamping: 7000,
    arbRate: 64000,
    unsprungMassKg: 13,
    staticCamberDeg: -2.6,
    camberGainDegPerM: 4.6,
    staticToeDeg: 0.1,
    staticRideHeight: 0.044,
    track: 1.55,
    baseY: -0.072,
    hardpoints: [
      [0.68522, 0.223332, -0.0138],
      [0.64544, 0.157367, -0.3252],
      [0.6874, 0.021199, 0.0715],
      [0.64544, -0.017681, -0.3252],
      [0.12506, 0.17361, -0.0138],
      [0.0725, -0.025136, 0.0185],
    ],
  } satisfies Vf26AxleSuspension,
  rear: {
    springRate: 185000,
    progressiveRate: 20000,
    bumpStopTravel: 0.0466301,
    bumpStopRate: 250000,
    droopTravel: 0.02063,
    damper: { bumpSlow: 1460, bumpFast: 2060, reboundSlow: 4990, reboundFast: 5560, bumpThreshold: 0.05, reboundThreshold: 0.12 },
    heaveRate: 50000,
    heaveProgressiveRate: 10000,
    heavePackerTravel: 0.016,
    heavePackerRate: 600000,
    heaveDamping: 8000,
    arbRate: 20000,
    unsprungMassKg: 15,
    staticCamberDeg: -1.0,
    camberGainDegPerM: -12.7,
    staticToeDeg: 0.2,
    staticRideHeight: 0.06,
    track: 1.476,
    baseY: -0.074,
    hardpoints: [
      [0.66332, 0.103062, 0.342009],
      [0.738479, 0.182562, 0.079167],
      [0.69821, 0.025027, 0.052143],
      [0.74228, -0.01693, -0.212241],
      [0.119245, 0.196534, 0.06647],
      [0.09259, 0.0129, 0.052143],
    ],
  } satisfies Vf26AxleSuspension,
} as const;

// ---------------------------------------------------------------------------
// Aerodynamics  (`data/cardata.car` section 12 + `data/aero/*.wing|*.curve`)
// Aero model: F = ½ρV² · chord·span · CL(AoA) · CL_GAIN · GH_CL(height)
// ---------------------------------------------------------------------------

export interface Vf26WingSpec {
  name: string;
  chord: number;
  span: number;
  /** Position relative to CG (m): x = lateral, y = vertical, z = longitudinal (+ forward) [mod] */
  position: readonly [number, number, number];
  aoaCl: LutPoints;
  aoaCd: LutPoints;
  /** Ground-height LUTs, evaluated at the element's own height above the road (m) [mod] */
  ghCl?: LutPoints;
  ghCd?: LutPoints;
  clGain: number;
  cdGain: number;
  /** Default wing angle (deg) [mod] */
  angleDeg: number;
  /** Angle used in 2026 X-Mode (straight-line low-drag) (deg) [assumed per 2026 regs] */
  xModeAngleDeg: number;
  /** CL change with yaw (per rad) [mod] */
  yawClGain: number;
}

const AOA_BODY_CL: LutPoints = [[-10, -0.2], [0, 0], [2, 0], [5, 0], [8, 0], [10, 0.2]];
const AOA_BODY_CD: LutPoints = [[-10, 1], [-2, 0.488], [2, 0.478], [3, 0.48], [4, 0.49], [5, 0.51], [8, 0.59], [10, 0.68], [12, 0.69], [14, 0.71], [16, 0.73], [20, 0.75], [24, 0.94], [26, 0.96], [30, 1]];
const AOA_FRONT_CL: LutPoints = [[-10, 0.11], [-4, 0.53], [0, 0.68], [15, 0.9]];
const AOA_FRONT_CD: LutPoints = [[-20, 0.06], [-15, 0.05], [0, 0.1], [15, 0.38]];
const AOA_REAR_CL: LutPoints = [[-10, -0.7], [5, 0.19], [20, 1.4]];
const AOA_REAR_CD: LutPoints = [[-20, 0.15], [0, 0.06], [30, 0.508]];
const AOA_REAR2_CL: LutPoints = [[-10, -0.05], [0, 0.11], [15, 0.442]];
const AOA_REAR2_CD: LutPoints = [[-10, 0.9], [0, 0.02], [15, 0.181], [16, 0.188], [17, 0.193], [18, 0.195], [20, 0.21], [25, 0.26], [28, 0.28], [33, 0.3]];
const AOA_DIFF_CL: LutPoints = [[0, 0.8], [3, 0.86], [3.5, 0.8], [4.115, 0.393333], [5.16353, 0.128333], [10, 0]];
const AOA_DIFF_CD: LutPoints = [[-10, 1], [0, 0.04], [2, 0.06], [3, 0.09], [3.5, 0.1], [4, 0.11], [5, 0.14], [10, 0.35]];
const GH_FRONTWING_CL: LutPoints = [[0, 0.4], [0.019, 0.438], [0.0537562, 0.468], [0.134525, 0.48], [0.16825, 0.486], [0.18887, 0.483]];
const GH_FRONTWING_CD: LutPoints = [[0, 0.97], [0.005, 0.99], [0.01, 0.994], [0.02, 0.998], [0.03, 1], [0.04, 1.002], [0.05, 1.004], [0.06, 1.006]];
const GH_FLOOR_CL: LutPoints = [[0, 0], [0.016, 0.15], [0.02, 0.39], [0.033, 0.815], [0.0436075, 0.787], [0.05, 0.59], [0.08, 0.48], [0.1, 0.3]];
const GH_FLOOR_CD: LutPoints = [[0, 0.97], [0.005, 0.99], [0.01, 0.994], [0.016, 0.9967], [0.02, 0.998], [0.03, 1], [0.033, 1.0006], [0.04, 1.002], [0.045, 1.003], [0.05, 1.004], [0.06, 1.006], [0.08, 1.0085], [0.1, 1.01]];
const GH_DIFF_REAR_CL: LutPoints = [[0, 0.63], [0.006, 0.79], [0.0124, 0.91], [0.02, 1], [0.035, 0.9929], [0.0479683, 0.972767], [0.0570862, 0.92495], [0.0717542, 0.7287], [0.0943508, 0.493], [0.12, 0.388], [0.14668, 0.327], [0.205, 0.274], [0.4, 0.14]];
const GH_DIFF_REAR_CD: LutPoints = [[0, 1], [0.012, 1], [0.0124, 1], [0.02, 0.7], [0.035, 0.6], [0.06, 0.6], [0.0688562, 0.53], [0.0737, 0.45], [0.08, 0.28], [0.0944, 0.18], [0.12, 0.09], [0.1467, 0.04], [0.205, 0.03], [0.4, 0.03]];

/** Field 11 of each `.wing` record is CD_GAIN and field 12 CL_GAIN (verified via L/D ≈ 3.6 and neutral aero balance). */
export const VF26_WINGS: ReadonlyArray<Vf26WingSpec> = [
  { name: 'BODY', chord: 1, span: 1.366, position: [0, 0.15, -0.08], aoaCl: AOA_BODY_CL, aoaCd: AOA_BODY_CD, clGain: 0.9, cdGain: 0.5, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -0.2 },
  { name: 'FRONT_L', chord: 1, span: 0.42, position: [-0.56, -0.09, 2.9], aoaCl: AOA_FRONT_CL, aoaCd: AOA_FRONT_CD, ghCl: GH_FRONTWING_CL, ghCd: GH_FRONTWING_CD, clGain: 2.93, cdGain: 1.25, angleDeg: 6, xModeAngleDeg: -2, yawClGain: -0.571 },
  { name: 'FRONT_R', chord: 1, span: 0.42, position: [0.56, -0.09, 2.9], aoaCl: AOA_FRONT_CL, aoaCd: AOA_FRONT_CD, ghCl: GH_FRONTWING_CL, ghCd: GH_FRONTWING_CD, clGain: 2.93, cdGain: 1.25, angleDeg: 6, xModeAngleDeg: -2, yawClGain: -0.571 },
  { name: 'REAR', chord: 0.45, span: 2, position: [0, 0.55, -1.7], aoaCl: AOA_REAR_CL, aoaCd: AOA_REAR_CD, clGain: 0.7, cdGain: 1.5, angleDeg: 12, xModeAngleDeg: 12, yawClGain: -1.5 },
  { name: 'DRS', chord: 1, span: 1.366, position: [0, 0.59, -1.8], aoaCl: AOA_REAR2_CL, aoaCd: AOA_REAR2_CD, clGain: 0.98, cdGain: 1.7, angleDeg: 17, xModeAngleDeg: 0, yawClGain: -1 },
  { name: 'DIFFUSER_RL', chord: 1, span: 0.683, position: [-0.3423, -0.175, -1.57], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_DIFF_REAR_CL, ghCd: GH_DIFF_REAR_CD, clGain: 0.7, cdGain: 0.55, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -1 },
  { name: 'DIFFUSER_RR', chord: 1, span: 0.683, position: [0.3423, -0.175, -1.57], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_DIFF_REAR_CL, ghCd: GH_DIFF_REAR_CD, clGain: 0.7, cdGain: 0.55, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -1 },
  { name: 'FLOOR_FL', chord: 2.5, span: 0.35, position: [0.31, -0.16, 0], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_FLOOR_CL, ghCd: GH_FLOOR_CD, clGain: 2, cdGain: 0.83, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -0.07 },
  { name: 'FLOOR_FLL', chord: 2.5, span: 0.35, position: [0.66, -0.16, 0], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_FLOOR_CL, ghCd: GH_FLOOR_CD, clGain: 1, cdGain: 0.83, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -0.07 },
  { name: 'FLOOR_FRR', chord: 2.5, span: 0.35, position: [-0.66, -0.16, 0], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_FLOOR_CL, ghCd: GH_FLOOR_CD, clGain: 1, cdGain: 0.83, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -0.07 },
  { name: 'FLOOR_FR', chord: 2.5, span: 0.35, position: [-0.31, -0.16, 0], aoaCl: AOA_DIFF_CL, aoaCd: AOA_DIFF_CD, ghCl: GH_FLOOR_CL, ghCd: GH_FLOOR_CD, clGain: 2, cdGain: 0.83, angleDeg: 3.5, xModeAngleDeg: 3.5, yawClGain: -0.07 },
];

/** 2026 active aero actuator: full Z↔X transition time, each way (s) [assumed — 0.2 s actuator delay] */
export const VF26_ACTIVE_AERO_TRANSITION_S = 0.2;

// ---------------------------------------------------------------------------
// Power unit  (`data/vf26_ref.carengine`, `*.turbo`, `data/kers/*`)
// ---------------------------------------------------------------------------

export const VF26_ENGINE = {
  /** Crank + flywheel inertia (kg·m²) [mod] */
  inertia: 0.05,
  /** Idle speed held by the anti-stall (rpm) [assumed — mod clutch engages 4000→5500 rpm] */
  idleRpm: 4000,
  /** Rev limiter (rpm) [mod] */
  limiterRpm: 12500,
  /** Absolute maximum rpm (rpm) [mod] */
  maxRpm: 15500,
  /** Naturally-aspirated torque curve, multiplied by (1 + boost) (rpm → Nm) [mod: header_power.curve] */
  torqueCurve: [
    [0, 105.6], [1000, 105.6], [1500, 105.6], [2000, 105.6], [2743.31, 107.36], [3250.74, 109.12], [3742.32, 110.88],
    [4107.04, 110.88], [4500, 115.28], [4884.04, 120.56], [5296.33, 128.48], [5740.34, 129.36], [6358.77, 129.36],
    [6961.35, 132], [7452.92, 133.76], [8023.79, 134.64], [8499.5, 137.28], [9165.51, 139.04], [11528.2, 140.8],
    [11972.2, 139.92], [12500, 140.8], [13082.3, 136.4], [13558, 140.8], [14033.7, 127.6], [14500, 123.2],
    [15000, 105.6], [15500, 52.8], [16000, 0],
  ] as LutPoints,
  /** Closed-throttle engine braking torque (rpm → Nm, negative = braking) [mod: coast_smooth.curve] */
  coastCurve: [
    [0, 0], [3000, -0.539419], [15000, -30],
  ] as LutPoints,
  /** Turbo boost target vs rpm (bar, controller override) [mod: ctrl_turbo0controller_0.curve] */
  boostCurve: [
    [0, 0], [4000, 0], [4500, 0.9], [5500, 1.6], [6000, 1.8], [7000, 2.2], [10500, 2.2], [12000, 2], [13000, 1.5], [17000, 1],
  ] as LutPoints,
  /** Turbo spool / decay time constants (s) [assumed — no MGU-H in 2026] */
  turboSpoolTauS: 0.32,
  turboDecayTauS: 0.18,
} as const;

export const VF26_ERS = {
  /** MGU-K deploy torque at the crank (rpm → Nm) [mod: ers_kinetic_torque.curve] */
  kineticTorque: [
    [500, 654], [5730, 654], [6000, 654], [6500, 610], [7000, 543], [7500, 547], [8000, 494], [8500, 445], [9000, 448],
    [9500, 433], [10000, 390], [10500, 385], [11000, 370], [11500, 363], [12000, 360], [12500, 358], [13000, 348],
    [13500, 322], [14000, 300], [14500, 285], [15000, 272], [15500, 241], [16000, 0],
  ] as LutPoints,
  /** MGU-K maximum electrical power (W) — FIA 2026 [regulation] */
  maxPowerW: 350_000,
  /** Usable state-of-charge window (J) — FIA 2026 [regulation] */
  batteryJ: 4_000_000,
  /** Round-trip efficiency on harvest [assumed] */
  harvestEfficiency: 0.9,
  /**
   * Lift-off (no brake) harvest is limited at the rear axle like an engine-braking map, so a
   * full 350 kW coast harvest can't lock the rear wheels in low gears (≈0.3 g at the rear) [assumed]
   */
  coastHarvestMaxAxleTorqueNm: 900,
  /** Per-gear MGU-K torque clipping ceiling (1st = 33.3 %, 2nd = 66.6 %, 3rd = 90.0 %, 4th–8th = 100 %) [ref_ers_gear.lut] */
  deployVsGear: [
    [0, 0],
    [1, 0.333],
    [2, 0.666],
    [3, 0.9],
    [4, 1],
    [8, 1],
  ] as LutPoints,
  /** Per-mode controller LUTs (throttle 0..1, speed km/h, gear, SoC 0..1) [mod: data/kers/<mode>/*.curve] */
  modes: {
    RAC: {
      throttle: [[0.02, 0], [0.2, 0], [1, 0.8]] as LutPoints,
      speed: [[0, 0], [100, 0], [120, 0.75], [160, 1], [260, 1], [270, 1], [300, 0.75], [310, 0.2], [320, 0], [340, 0]] as LutPoints,
      gear: [[0, 0], [1, 0.333], [2, 0.666], [3, 0.9], [4, 0.95], [5, 1], [6, 1], [7, 0.85], [8, 0.6]] as LutPoints,
      soc: [[0.15, 0], [0.2, 0.5], [0.3, 1], [1, 1]] as LutPoints,
      // The mod's RAC throttle_coast curve multiplies a zero throttle term, so RAC barely
      // harvests on lift-off (that is the LIC mode's job) [mod: race/ers_controller_throttle_coast_rac]
      coastHarvest: 0.1,
    },
    BAL: {
      throttle: [[0, 0], [0.02, 0], [1, 2]] as LutPoints,
      speed: [[0, 0], [100, 0], [120, 0.5], [160, 1], [340, 1]] as LutPoints,
      gear: [[0, 0], [1, 0.333], [2, 0.666], [3, 0.9], [4, 1], [8, 1]] as LutPoints,
      soc: [[0.4, 1], [1, 1]] as LutPoints,
      coastHarvest: 0.035,
    },
    PSH: {
      throttle: [[0, 0], [0.02, 0], [0.4, -1], [0.6, 1], [1, 1]] as LutPoints,
      speed: [[0, 0], [100, 0], [120, 0.5], [160, 1], [290, 1], [310, 0.5], [320, 0.3], [330, 0.2], [340, 0.1]] as LutPoints,
      gear: [[0, 0], [1, 0.333], [2, 0.666], [3, 0.9], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]] as LutPoints,
      soc: [[0.4, 1], [1, 1]] as LutPoints,
      coastHarvest: 1,
    },
    CHR: {
      throttle: [[0, 0], [0.02, 0], [0.8, -1.5], [1, -0.7]] as LutPoints,
      speed: [[0, 0], [100, 0], [120, 0.5], [160, 1], [250, 1], [260, 0], [340, 0]] as LutPoints,
      gear: [[0, 0], [1, 0.333], [2, 0.666], [3, 0.9], [4, 1], [8, 1]] as LutPoints,
      soc: [[0.75, 1], [1, 1]] as LutPoints,
      coastHarvest: 1,
    },
  },
} as const;

/** Speed (km/h) at which MGU-K deploy starts to taper, and the speed at which it reaches zero */
const MGUK_TAPER_START_KMH = 290;
const MGUK_OVERRIDE_TAPER_START_KMH = 337;
const MGUK_ZERO_KMH = 355;

/**
 * Super-clipping: the MGU-K deploy power ceiling (W) at a road speed. Full 350 kW up to 290 km/h, then a
 * linear taper to zero at 355 km/h. With Manual Override the full power is held to 337 km/h before the same
 * taper. The harvest path is not limited by this.
 */
export function mgukDeployCapW(speedKmh: number, overrideActive: boolean): number {
  const start = overrideActive ? MGUK_OVERRIDE_TAPER_START_KMH : MGUK_TAPER_START_KMH;
  if (speedKmh <= start) return VF26_ERS.maxPowerW;
  if (speedKmh >= MGUK_ZERO_KMH) return 0;
  return (VF26_ERS.maxPowerW * (MGUK_ZERO_KMH - speedKmh)) / (MGUK_ZERO_KMH - start);
}

// ---------------------------------------------------------------------------
// Drivetrain  (`data/vf26_ref.gearbox|.clutch|.drivetrain`)
// ---------------------------------------------------------------------------

export const VF26_DRIVETRAIN = {
  /** Forward gear ratios 1..8 [mod] */
  gearRatios: [2.9688, 2.3978, 2.0334, 1.7155, 1.48, 1.28, 1.1111, 0.9667] as const,
  reverseRatio: -4.5,
  /** Final drive [mod] */
  finalDrive: 4.75,
  /** Seamless shift durations (s) [mod] */
  upshiftTimeS: 0.015,
  downshiftTimeS: 0.02,
  /** Auto-shifter thresholds (rpm) [mod] */
  autoUpshiftRpm: 12200,
  autoDownshiftRpm: 8000,
  /** Gearbox + driveshaft inertia on the engine side (kg·m²) [mod] */
  gearboxInertia: 0.01,
  /** Driveline efficiency [assumed] */
  efficiency: 0.95,
  /** Clutch capacity (Nm) and launch auto-clutch rpm window [mod] */
  clutchMaxTorqueNm: 1600,
  autoClutchStartRpm: 4000,
  autoClutchFullRpm: 5500,
  /** Engine speed the auto-clutch holds off the line at full pedal (rpm) [assumed: typical F1 launch] */
  launchRpm: 10500,
  /**
   * Limited-slip differential [setup: default setup power 0.20 / coast 0.10 / preload 45 Nm; field
   * order inferred from the setup limits 0–0.5 / 0–0.5 / 0–150 Nm. The drivetrain base is 0.15 / 0.3 / 150]
   */
  diffPreloadNm: 45,
  diffPowerLock: 0.2,
  diffCoastLock: 0.1,
} as const;

// ---------------------------------------------------------------------------
// Brakes  (`data/vf26_ref.brakesystem`, setup)
// ---------------------------------------------------------------------------

export const VF26_BRAKES = {
  /** Max brake torque per wheel scaled by share (MAX_TORQUE) (Nm) [mod] */
  maxTorqueNm: 6500,
  /** Front brake share [setup: 56 %] */
  frontBias: 0.56,
  /** Brake power [setup] */
  powerMult: 1.0,
  /**
   * Brake migration: front-share shift at full pedal, linear in the pedal [brakesystem presets Mig0–Mig8 =
   * ebb_controller_migration_N.curve `0|0 1|N/100`; setup default Mig6]
   */
  migrationAtFullPedal: 0.06,
} as const;

/**
 * Reference performance envelope recorded by the mod's own AI calibration
 * (`aicardata`). Used by `scripts/verify-sim.ts` as validation targets.
 */
export const VF26_AI_REFERENCE = {
  topSpeedKmh: 331,
  /** Seconds from standstill to speed (m/s) */
  accel: [[2.817, 24.0], [5.496, 54.75], [8.181, 73.94], [12.585, 83.74]] as LutPoints,
  /** Lateral acceleration limit (m/s → m/s²) */
  lateral: [[24, 23.3], [40, 26.1], [50, 28.6], [60, 32.6], [69, 39.1]] as LutPoints,
} as const;

/**
 * Computes the kinematic roll-centre height (m above ground) of a double-wishbone axle
 * from its hardpoints (front view instant-centre construction).
 */
export function computeRollCentreHeight(axle: Vf26AxleSuspension, tyreRadius: number): number {
  const hp = axle.hardpoints;
  const avg = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5] as const;
  const upperCar = avg(hp[0], hp[1]);
  const lowerCar = avg(hp[2], hp[3]);
  const upperTyre = [hp[4][0], hp[4][1]] as const;
  const lowerTyre = [hp[5][0], hp[5][1]] as const;

  const su = (upperCar[1] - upperTyre[1]) / (upperCar[0] - upperTyre[0]);
  const sl = (lowerCar[1] - lowerTyre[1]) / (lowerCar[0] - lowerTyre[0]);
  if (Math.abs(su - sl) < 1e-6) {
    // Parallel arms: roll centre on the ground-plane projection of the arm slope
    return Math.max(0, tyreRadius + lowerTyre[1] + sl * (axle.track * 0.5 - lowerTyre[0]));
  }
  // Instant centre (u inboard from wheel centre, v up from wheel centre)
  const icU = (lowerTyre[1] - sl * lowerTyre[0] - upperTyre[1] + su * upperTyre[0]) / (su - sl);
  const icV = upperTyre[1] + su * (icU - upperTyre[0]);
  // Line from contact patch (0, -R) through IC, evaluated at the car centreline
  const slope = (icV + tyreRadius) / icU;
  const v = -tyreRadius + slope * (axle.track * 0.5);
  return Math.max(0, v + tyreRadius);
}
