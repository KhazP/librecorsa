/**
 * Setup sheets per car class, laid out the way drivers expect: the F1 cars share one sheet (aerodynamics,
 * transmission, suspension geometry, suspension, dampers, brakes, tyres, fuel) and the GT3 cars another (tyres,
 * electronics, mechanical grip, dampers, aero, fuel). One sheet serves every car of its class; each car only brings its own baseline
 * (ride heights, wheel rates, bump stops, preload, steering ratio, tyre ranges).
 *
 * A sheet is a view over the setup the cars already take: the chassis offsets (`ChassisSetup`), the tyre setup and
 * the electronics' starting dials. Each parameter reads its game-style value from that state and writes it back.
 */

import { text as tx } from "@/lib/text";
import type { Messages } from "@/i18n/types";
import type { TyreSetup, VehicleModelId } from "@/types/f1";
import { ARB_DETACHED_PCT, type ChassisSetup, CHASSIS_LIMITS, DEFAULT_CHASSIS_SETUP, FUEL_KG_PER_L, FUEL_LOAD, type GarageTuner, STEER_RATIO_BASE, WING_CLICK_DEG } from "./car-setup";
import { LC26_CHASSIS } from "./lc26-data";
import { F12026_CAR_CONFIG } from "./f12026-car/F12026CarConfig";
import { AMG_GT3_CONFIG } from "./gt3/AmgGt3Config";
import { SUZUKI_LIANA_CONFIG } from "./road/SuzukiLianaConfig";
import { MTR_496R_CONFIG } from "./proto/Mtr496rConfig";
import { LC_LMDH_CONFIG } from "./proto/LcLmdhConfig";
import { NISSAN_R33_CONFIG } from "./classic/NissanR33Config";
import { NISSAN_R32_CONFIG } from "./classic/NissanR32Config";
import { BMW_M1_PROCAR_CONFIG } from "./classic/BmwM1ProcarConfig";
import { CHAPARRAL_2D_67_CONFIG, CHAPARRAL_2D_CONFIG, CHAPARRAL_ENGINE_BRAKING } from "./classic/Chaparral2dConfig";
import { PORSCHE_934_RSR_CONFIG } from "./classic/Porsche934RsrConfig";
import { VW_SCIROCCO_CONFIG } from "./road/VwSciroccoConfig";
import { type CarPhysicsConfig, racesOnBlankets } from "./f12026-car/F12026CarConfig";

export type SetupClassId = "f1" | "gt3";

export const SETUP_CLASS: Record<VehicleModelId, SetupClassId> = {
  lc26: "f1",
  "f12026-car": "f1",
  "amg-gt3": "gt3",
  // A closed road car: the GT3 sheet (tyres, electronics, mechanical grip, dampers, fuel)
  liana: "gt3",
  // A closed-wheel car on a rear wing: the GT3 sheet
  "mtr-496r": "gt3",
  "lc-lmdh": "gt3",
  // The classic cars: closed-wheel race cars, the GT3 sheet
  "nissan-r33-jgtc": "gt3",
  "nissan-r32-jtcc": "gt3",
  "bmw-m1-procar": "gt3",
  // A closed road car, as the Liana
  "vw-scirocco-gtx": "gt3",
  "chaparral-2d": "gt3",
  "chaparral-2d-67": "gt3",
  "porsche-934-rsr": "gt3",
};

export interface SetupState {
  chassis: ChassisSetup;
  tyre: TyreSetup;
  tuner: GarageTuner;
}

interface Range {
  min: number;
  max: number;
  step: number;
}

export interface TyreRanges {
  pressurePsi: Range;
  camberFrontDeg: Range;
  camberRearDeg: Range;
}

/** A parameter's name, as its key in the messages (src/i18n/messages/en/game.json, setupSheet) */
type SetupLabel = keyof Messages["game"]["setupSheet"];

/** What raising (`more`) or lowering (`less`) a value does, in a few words */
export interface SetupEffect {
  more: string;
  less: string;
}

export interface SetupParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** The value the car leaves the factory with (for the electronics, a typical value: each car brings its own) */
  base: number;
  get(st: SetupState): number;
  set(st: SetupState, v: number): SetupState;
  format(v: number): string;
  fx: SetupEffect;
  /** `fx.more` is the slider's left side (more negative camber) */
  invert?: boolean;
  /** Which of the car's setup channels it writes (the garage can only change the ones it is given) */
  writes: "chassis" | "tyre" | "tuner";
  /** An off / on choice (0 / 1), drawn as a switch rather than a slider */
  toggle?: boolean;
}

export type SetupExtra = "compound" | "aeroPackage" | "assists" | "liveTyres";

export interface SetupGroup {
  id: string;
  label: string;
  short: string;
  params: SetupParam[];
  /** Pickers the garage draws above the group's sliders */
  extras?: SetupExtra[];
}

/** A car's own baseline, in the units the sheets show */
interface CarBaseline {
  rideFrontMm: number;
  rideRearMm: number;
  toeFrontDeg: number;
  toeRearDeg: number;
  wheelRateFrontNmm: number;
  wheelRateRearNmm: number;
  bumpStopRateFrontNmm: number;
  bumpStopRateRearNmm: number;
  bumpStopRangeFrontMm: number;
  bumpStopRangeRearMm: number;
  diffPreloadNm: number;
  steerRatio: number;
  /** Front brake share (%) a reset puts back; absent: the class's default */
  brakeBiasPct?: number;
  /** The brake-bias adjuster's range (%); absent: the GT3 sheet's 60–78 */
  brakeBiasRangePct?: readonly [number, number];
  /** The default tune's engine braking (% of the engine's overrun); present: the GT3 sheet shows the slider */
  engineBrakingPct?: number;
}

const rigidBaseline = (
  cfg: typeof F12026_CAR_CONFIG | typeof AMG_GT3_CONFIG | typeof SUZUKI_LIANA_CONFIG | typeof MTR_496R_CONFIG | CarPhysicsConfig,
  vehicle: VehicleModelId
): CarBaseline => ({
  rideFrontMm: cfg.aero.front_target_height * 1000,
  rideRearMm: cfg.aero.rear_target_height * 1000,
  toeFrontDeg: 0,
  toeRearDeg: 0,
  wheelRateFrontNmm: cfg.suspensions.front.springs.wheel_rate / 1000,
  wheelRateRearNmm: cfg.suspensions.rear.springs.wheel_rate / 1000,
  bumpStopRateFrontNmm: cfg.suspensions.front.bumpStop.rate / 1000,
  bumpStopRateRearNmm: cfg.suspensions.rear.bumpStop.rate / 1000,
  bumpStopRangeFrontMm: cfg.suspensions.front.bumpStop.range * 1000,
  bumpStopRangeRearMm: cfg.suspensions.rear.bumpStop.range * 1000,
  diffPreloadNm: cfg.differential.settings.preload,
  steerRatio: STEER_RATIO_BASE[vehicle],
  brakeBiasPct: Number((cfg.brakes.front_bias * 100).toFixed(1)),
});

const BASELINES: Record<VehicleModelId, CarBaseline> = {
  lc26: {
    rideFrontMm: LC26_CHASSIS.front.staticRideHeight * 1000,
    rideRearMm: LC26_CHASSIS.rear.staticRideHeight * 1000,
    toeFrontDeg: LC26_CHASSIS.front.staticToeDeg,
    toeRearDeg: LC26_CHASSIS.rear.staticToeDeg,
    wheelRateFrontNmm: LC26_CHASSIS.front.springRate / 1000,
    wheelRateRearNmm: LC26_CHASSIS.rear.springRate / 1000,
    bumpStopRateFrontNmm: 0,
    bumpStopRateRearNmm: 0,
    bumpStopRangeFrontMm: 0,
    bumpStopRangeRearMm: 0,
    diffPreloadNm: 0,
    steerRatio: STEER_RATIO_BASE.lc26,
  },
  "f12026-car": rigidBaseline(F12026_CAR_CONFIG, "f12026-car"),
  "amg-gt3": { ...rigidBaseline(AMG_GT3_CONFIG, "amg-gt3"), brakeBiasRangePct: [56, 70] },
  liana: rigidBaseline(SUZUKI_LIANA_CONFIG, "liana"),
  // Its 58 % sits below a GT3's bias range: the mod's adjuster runs from 52 % [spec setup.ini FRONT_BIAS] to the 78 %
  // every car stops at
  "mtr-496r": { ...rigidBaseline(MTR_496R_CONFIG, "mtr-496r"), brakeBiasRangePct: [52, 78] },
  // Its 56 % sits below a GT3's bias range [est]
  "lc-lmdh": { ...rigidBaseline(LC_LMDH_CONFIG, "lc-lmdh"), brakeBiasRangePct: [48, 68], toeFrontDeg: -0.12, toeRearDeg: 0.12 },
  // The classic Nissans' adjusters [spec setup.ini FRONT_BIAS]
  "nissan-r33-jgtc": { ...rigidBaseline(NISSAN_R33_CONFIG, "nissan-r33-jgtc"), brakeBiasRangePct: [50, 80] },
  "nissan-r32-jtcc": { ...rigidBaseline(NISSAN_R32_CONFIG, "nissan-r32-jtcc"), brakeBiasRangePct: [52, 80] },
  // Its adjuster [spec setup.ini FRONT_BIAS]
  "bmw-m1-procar": { ...rigidBaseline(BMW_M1_PROCAR_CONFIG, "bmw-m1-procar"), brakeBiasRangePct: [48, 80] },
  // No bias adjuster in the cockpit [spec brakes.ini COCKPIT_ADJUSTABLE 0]
  "vw-scirocco-gtx": rigidBaseline(VW_SCIROCCO_CONFIG, "vw-scirocco-gtx"),
  // Their adjuster [spec setup.ini FRONT_BIAS]
  "chaparral-2d": { ...rigidBaseline(CHAPARRAL_2D_CONFIG, "chaparral-2d"), brakeBiasRangePct: [48, 80], engineBrakingPct: 100 * CHAPARRAL_ENGINE_BRAKING },
  "chaparral-2d-67": { ...rigidBaseline(CHAPARRAL_2D_67_CONFIG, "chaparral-2d-67"), brakeBiasRangePct: [48, 80], engineBrakingPct: 100 * CHAPARRAL_ENGINE_BRAKING },
  // Its adjuster [spec setup.ini FRONT_BIAS]
  "porsche-934-rsr": { ...rigidBaseline(PORSCHE_934_RSR_CONFIG, "porsche-934-rsr"), brakeBiasRangePct: [52, 80] },
};

const clampTo = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v));

/** Each car's physics data, for the parts of a sheet that depend on what the car has */
const CONFIGS: Record<VehicleModelId, CarPhysicsConfig | null> = {
  lc26: null,
  "f12026-car": F12026_CAR_CONFIG as unknown as CarPhysicsConfig,
  "amg-gt3": AMG_GT3_CONFIG as unknown as CarPhysicsConfig,
  liana: SUZUKI_LIANA_CONFIG as unknown as CarPhysicsConfig,
  "mtr-496r": MTR_496R_CONFIG as unknown as CarPhysicsConfig,
  "lc-lmdh": LC_LMDH_CONFIG as unknown as CarPhysicsConfig,
  "nissan-r33-jgtc": NISSAN_R33_CONFIG as unknown as CarPhysicsConfig,
  "nissan-r32-jtcc": NISSAN_R32_CONFIG as unknown as CarPhysicsConfig,
  "bmw-m1-procar": BMW_M1_PROCAR_CONFIG as unknown as CarPhysicsConfig,
  "vw-scirocco-gtx": VW_SCIROCCO_CONFIG as unknown as CarPhysicsConfig,
  "chaparral-2d": CHAPARRAL_2D_CONFIG as unknown as CarPhysicsConfig,
  "chaparral-2d-67": CHAPARRAL_2D_67_CONFIG as unknown as CarPhysicsConfig,
  "porsche-934-rsr": PORSCHE_934_RSR_CONFIG as unknown as CarPhysicsConfig,
};

/** Cars whose electronics have the third traction dial, for the driven axle's slide */
const TC_SLIP_ANGLE_CARS: ReadonlySet<VehicleModelId> = new Set(["amg-gt3", "lc-lmdh"]);

/**
 * An anti-roll bar on the games' 1–21 scale (11 the baseline, 5 % a step), with 0 "Detached" (the bar off, −100 %) on
 * a car whose data allows it
 */
function arbParam(key: "arbFrontPct" | "arbRearPct", label: SetupLabel, detachable: boolean, fx: SetupEffect): SetupParam {
  const lim = CHASSIS_LIMITS[key];
  return {
    id: key,
    get label() { return tx(`game.setupSheet.${label}`); },
    min: detachable ? 0 : 1,
    max: 21,
    step: 1,
    base: 11,
    get: (st) => (st.chassis[key] <= ARB_DETACHED_PCT + 1e-6 ? 0 : Math.max(1, 11 + st.chassis[key] / 5)),
    set: (st, v) => ({
      ...st,
      chassis: { ...st.chassis, [key]: Math.round(v) <= 0 && detachable ? ARB_DETACHED_PCT : clampTo((Math.max(1, Math.round(v)) - 11) * 5, lim) },
    }),
    format: (v) => (v <= 0 ? tx("game.setupSheet.detached") : int(v)),
    fx,
    writes: "chassis",
  };
}

/**
 * A chassis offset shown on a game-style scale: display = base + offset × perUnit. The slider runs over the
 * display range [min, max] (clipped to what the offset allows).
 */
function chassisParam(
  key: keyof ChassisSetup,
  o: { id?: string; label: SetupLabel; base: number; perUnit?: number; min: number; max: number; step: number; format: (v: number) => string; fx: SetupEffect }
): SetupParam {
  const k = o.perUnit ?? 1;
  const lim = CHASSIS_LIMITS[key];
  // Range in whole steps from the baseline, so the slider (which snaps to min + n·step) lands on the baseline
  const lo = Math.max(o.min, o.base + Math.min(lim.min * k, lim.max * k));
  const hi = Math.min(o.max, o.base + Math.max(lim.min * k, lim.max * k));
  const eps = 1e-6;
  return {
    id: o.id ?? key,
    get label() { return tx(`game.setupSheet.${o.label}`); },
    min: Number((o.base + Math.ceil((lo - o.base) / o.step - eps) * o.step).toFixed(4)),
    max: Number((o.base + Math.floor((hi - o.base) / o.step + eps) * o.step).toFixed(4)),
    step: o.step,
    base: o.base,
    get: (st) => Number((o.base + st.chassis[key] * k).toFixed(4)),
    set: (st, v) => ({ ...st, chassis: { ...st.chassis, [key]: clampTo(Number(((v - o.base) / k).toFixed(4)), lim) } }),
    format: o.format,
    fx: o.fx,
    writes: "chassis",
  };
}

function tunerParam(
  key: keyof GarageTuner,
  o: { label: SetupLabel; base: number; min: number; max: number; step: number; format: (v: number) => string; fx: SetupEffect }
): SetupParam {
  return {
    id: key,
    get label() { return tx(`game.setupSheet.${o.label}`); },
    min: o.min,
    max: o.max,
    step: o.step,
    base: o.base,
    get: (st) => st.tuner[key] ?? o.base,
    set: (st, v) => ({ ...st, tuner: { ...st.tuner, [key]: v } }),
    format: o.format,
    fx: o.fx,
    writes: "tuner",
  };
}

function tyreParam(
  id: string,
  label: SetupLabel,
  r: Range,
  base: number,
  get: (t: TyreSetup) => number,
  put: (t: TyreSetup, v: number) => TyreSetup,
  format: (v: number) => string,
  fx: SetupEffect,
  invert = false
): SetupParam {
  return {
    id,
    get label() { return tx(`game.setupSheet.${label}`); },
    ...r,
    base,
    get: (st) => get(st.tyre),
    set: (st, v) => ({ ...st, tyre: put(st.tyre, v) }),
    format,
    fx,
    invert,
    writes: "tyre",
  };
}

const psi = (v: number) => `${v.toFixed(1)} psi`;
const deg2 = (v: number) => `${v.toFixed(2)}°`;
const camber = (v: number) => `${v.toFixed(1)}°`;
const toe = (v: number) =>
  Math.abs(v) < 0.005 ? "0.00°" : tx(v > 0 ? "game.setupSheet.toeIn" : "game.setupSheet.toeOut", { angle: `${Math.abs(v).toFixed(2)}°` });
const pct = (v: number) => `${Math.round(v)}%`;
const mm = (v: number) => `${Math.round(v)} mm`;
const int = (v: number) => String(Math.round(v));
/** Diff levels 1–12 on F1's 10–100 % scale */
const diffPct = (lvl: number) => `${Math.round(10 + ((lvl - 1) * 90) / 11)}%`;

/** What a value does, in the current language */
const effect = (key: keyof Messages["game"]["setupFx"]): SetupEffect => ({
  get more() { return tx(`game.setupFx.${key}.more`); },
  get less() { return tx(`game.setupFx.${key}.less`); },
});

const FX = {
  frontWing: effect("frontWing"),
  rearWing: effect("rearWing"),
  diffOn: effect("diffOn"),
  diffOff: effect("diffOff"),
  engineBraking: effect("engineBraking"),
  camberFront: effect("camberFront"),
  camberRear: effect("camberRear"),
  toeFront: effect("toeFront"),
  toeRear: effect("toeRear"),
  springFront: effect("springFront"),
  springRear: effect("springRear"),
  arbFront: effect("arbFront"),
  arbRear: effect("arbRear"),
  rideFront: effect("rideFront"),
  rideRear: effect("rideRear"),
  brakePressure: effect("brakePressure"),
  bias: effect("bias"),
  migration: effect("migration"),
  coldPsi: effect("coldPsi"),
  blankets: effect("blankets"),
  tc: effect("tc"),
  tc2: effect("tc2"),
  abs: effect("abs"),
  map: effect("map"),
  steerRatio: effect("steerRatio"),
  wheelRateFront: effect("wheelRateFront"),
  wheelRateRear: effect("wheelRateRear"),
  bumpStopRate: effect("bumpStopRate"),
  bumpStopRange: effect("bumpStopRange"),
  preload: effect("preload"),
  bump: effect("bump"),
  fastBump: effect("fastBump"),
  rebound: effect("rebound"),
  fastRebound: effect("fastRebound"),
  ductFront: effect("ductFront"),
  ductRear: effect("ductRear"),
  radiator: effect("radiator"),
  gearSet: effect("gearSet"),
  heaveSpring: effect("heaveSpring"),
  heavePacker: effect("heavePacker"),
  cornerPacker: effect("cornerPacker"),
  tcSlipAngle: effect("tcSlipAngle"),
  motorDeploy: effect("motorDeploy"),
  regen: effect("regen"),
  fuel: effect("fuel"),
} satisfies Record<string, SetupEffect>;

export const ENGINE_MAP_LABELS: readonly string[] = Object.defineProperties(["", "1 · Max", "2 · Race", "3 · Smooth", "4 · Lean", "5 · Save"], {
  1: { get: () => tx("game.setupSheet.engineMapMax"), enumerable: true },
  2: { get: () => tx("game.setupSheet.engineMapRace"), enumerable: true },
  3: { get: () => tx("game.setupSheet.engineMapSmooth"), enumerable: true },
  4: { get: () => tx("game.setupSheet.engineMapLean"), enumerable: true },
  5: { get: () => tx("game.setupSheet.engineMapSave"), enumerable: true },
});

/**
 * Bump and rebound, slow and fast, front and rear: clicks 0–16 with the baseline at 8, each click 5 % of the
 * car's own baseline damping. Every car shares the page; the physics scales each car's damper curves.
 */
const dampers = (): SetupParam[] => {
  const damper = (key: keyof ChassisSetup, label: SetupLabel, fx: SetupEffect) =>
    chassisParam(key, { label, base: 8, perUnit: 1 / 5, min: 0, max: 16, step: 1, format: int, fx });
  return [
    damper("bumpFrontPct", "frontBump", FX.bump),
    damper("bumpRearPct", "rearBump", FX.bump),
    damper("fastBumpFrontPct", "frontFastBump", FX.fastBump),
    damper("fastBumpRearPct", "rearFastBump", FX.fastBump),
    damper("reboundFrontPct", "frontRebound", FX.rebound),
    damper("reboundRearPct", "rearRebound", FX.rebound),
    damper("fastReboundFrontPct", "frontFastRebound", FX.fastRebound),
    damper("fastReboundRearPct", "rearFastRebound", FX.fastRebound),
  ];
};

/**
 * The parameters every car shares on its electronics page, with a car's own: the slip-angle traction dial, a
 * prototype's hybrid dials
 */
const electronics = (vehicle?: VehicleModelId): SetupParam[] => {
  const cfg = vehicle ? CONFIGS[vehicle] : null;
  const dials = cfg?.hybridDials;
  const off = (v: number) => (v === 0 ? tx("game.setupSheet.dialOff") : int(v));
  return [
    tunerParam("tcLevel", { label: vehicle && TC_SLIP_ANGLE_CARS.has(vehicle) ? "tcSlip" : "tc1", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.tc }),
    tunerParam("tc2Level", { label: vehicle && TC_SLIP_ANGLE_CARS.has(vehicle) ? "tcCut" : "tc2", base: 6, min: 1, max: 12, step: 1, format: int, fx: FX.tc2 }),
    ...(vehicle && TC_SLIP_ANGLE_CARS.has(vehicle)
      ? [tunerParam("tcSlipAngleLevel", { label: "tcSlipAngle", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.tcSlipAngle })]
      : []),
    tunerParam("absLevel", { label: "abs", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.abs }),
    tunerParam("engineMap", { label: "engineMap", base: 2, min: 1, max: 5, step: 1, format: (v) => ENGINE_MAP_LABELS[v] ?? int(v), fx: FX.map }),
    ...(dials
      ? [
          tunerParam("motorDeployKw", {
            label: "motorDeployment",
            base: dials.deployStepsKw[dials.defaultDeployIndex],
            min: Math.min(...dials.deployStepsKw),
            max: Math.max(...dials.deployStepsKw),
            step: 10,
            format: (v) => `${Math.round(v)} kW`,
            fx: FX.motorDeploy,
          }),
          tunerParam("regenKw", {
            label: "regeneration",
            base: dials.regenStepsKw[dials.defaultRegenIndex],
            min: Math.min(...dials.regenStepsKw),
            max: Math.max(...dials.regenStepsKw),
            step: 10,
            format: (v) => `${Math.round(v)} kW`,
            fx: FX.regen,
          }),
        ]
      : []),
  ];
};

/** One cold pressure per tyre (a real car's pressures are set wheel by wheel) */
const tyrePressures = (r: TyreRanges, d: TyreSetup): SetupParam[] =>
  (
    [
      ["fl", "psiFL", "frontLeftPressure"],
      ["fr", "psiFR", "frontRightPressure"],
      ["rl", "psiRL", "rearLeftPressure"],
      ["rr", "psiRR", "rearRightPressure"],
    ] as const
  ).map(([k, key, label]) =>
    tyreParam(key, label, r.pressurePsi, d.coldPressurePsi[k], (t) => t.coldPressurePsi[k], (t, v) => ({ ...t, coldPressurePsi: { ...t.coldPressurePsi, [k]: v } }), psi, FX.coldPsi)
  );

const cambers = (r: TyreRanges, d: TyreSetup): SetupParam[] => [
  tyreParam("camberFront", "frontCamber", r.camberFrontDeg, d.camberDeg.front, (t) => t.camberDeg.front, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, front: v } }), camber, FX.camberFront, true),
  tyreParam("camberRear", "rearCamber", r.camberRearDeg, d.camberDeg.rear, (t) => t.camberDeg.rear, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, rear: v } }), camber, FX.camberRear, true),
];

/**
 * Tyre blankets, on or off: the car's own way unless the player picks (a car raced on blankets has them on; the LC26,
 * with no config here, is one). On, the tyres leave the garage at the blankets' warmth at every start; off, a car
 * raced on blankets leaves on cold tyres too when its start is a cold one
 */
const blanketParam = (vehicle: VehicleModelId): SetupParam => {
  const cfg = CONFIGS[vehicle];
  const base = !cfg || racesOnBlankets(cfg.tyreCompounds[cfg.compoundSlots.soft]!.pressureData) ? 1 : 0;
  return {
    id: "tyreBlankets",
    get label() { return tx("game.setupSheet.tyreBlankets"); },
    min: 0,
    max: 1,
    step: 1,
    base,
    get: (st) => (st.chassis.tyreBlankets === 0 ? base : st.chassis.tyreBlankets > 0 ? 1 : 0),
    set: (st, v) => ({ ...st, chassis: { ...st.chassis, tyreBlankets: Math.round(v) === base ? 0 : Math.round(v) >= 1 ? 1 : -1 } }),
    format: (v) => (v >= 1 ? tx("game.setupSheet.blanketsOn") : tx("game.setupSheet.blanketsOff")),
    fx: FX.blankets,
    writes: "chassis",
    toggle: true,
  };
};

/** Starting fuel (kg on the F1 cars, litres beside it on the GT3s, which are fuelled by the litre) */
const fuelGroup = (vehicle: VehicleModelId): SetupGroup => {
  const f = FUEL_LOAD[vehicle];
  const litres = SETUP_CLASS[vehicle] === "gt3";
  const format = (v: number) => (litres ? `${Math.round(v / FUEL_KG_PER_L)} L · ${Math.round(v)} kg` : `${Math.round(v)} kg`);
  return {
    id: "fuel",
    get label() { return tx("game.setupGroups.fuel"); },
    get short() { return tx("game.setupGroups.fuelShort"); },
    params: [chassisParam("fuelDeltaKg", { label: "startingFuel", base: f.defaultKg, min: f.minKg, max: f.maxKg, step: 1, format, fx: FX.fuel })],
  };
};

/** The F1 sheet: shared by every F1 car */
function f1Sheet(vehicle: VehicleModelId, b: CarBaseline, r: TyreRanges, d: TyreSetup): SetupGroup[] {
  return [
    {
      id: "aero",
      get label() { return tx("game.setupGroups.aerodynamics"); },
      get short() { return tx("game.setupGroups.aerodynamicsShort"); },
      extras: ["aeroPackage"],
      params: [
        chassisParam("frontWingClicks", { label: "frontWing", base: 25, min: 0, max: 50, step: 1, format: int, fx: FX.frontWing }),
        chassisParam("rearWingClicks", { label: "rearWing", base: 25, min: 0, max: 50, step: 1, format: int, fx: FX.rearWing }),
      ],
    },
    {
      id: "transmission",
      get label() { return tx("game.setupGroups.transmission"); },
      get short() { return tx("game.setupGroups.transmissionShort"); },
      params: [
        tunerParam("diffExit", { label: "diffOnThrottle", base: 5, min: 1, max: 12, step: 1, format: diffPct, fx: FX.diffOn }),
        tunerParam("diffEntry", { label: "diffOffThrottle", base: 3, min: 1, max: 12, step: 1, format: diffPct, fx: FX.diffOff }),
        chassisParam("engineBrakingPct", { label: "engineBraking", base: 100, min: 50, max: 100, step: 5, format: pct, fx: FX.engineBraking }),
      ],
    },
    {
      id: "geometry",
      get label() { return tx("game.setupGroups.suspensionGeometry"); },
      get short() { return tx("game.setupGroups.suspensionGeometryShort"); },
      params: [
        ...cambers(r, d),
        chassisParam("toeFrontDeg", { label: "frontToe", base: b.toeFrontDeg, min: -0.5, max: 0.3, step: 0.01, format: toe, fx: FX.toeFront }),
        chassisParam("toeRearDeg", { label: "rearToe", base: b.toeRearDeg, min: -0.1, max: 0.5, step: 0.01, format: toe, fx: FX.toeRear }),
      ],
    },
    {
      id: "suspension",
      get label() { return tx("game.setupGroups.suspension"); },
      get short() { return tx("game.setupGroups.suspensionShort"); },
      params: [
        // 1–41 as in the games: each step 1.5 % of the baseline rate, 21 the baseline
        chassisParam("springFrontPct", { label: "frontSuspension", base: 21, perUnit: 1 / 1.5, min: 1, max: 41, step: 1, format: int, fx: FX.springFront }),
        chassisParam("springRearPct", { label: "rearSuspension", base: 21, perUnit: 1 / 1.5, min: 1, max: 41, step: 1, format: int, fx: FX.springRear }),
        chassisParam("arbFrontPct", { label: "frontAntiRollBar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbFront }),
        chassisParam("arbRearPct", { label: "rearAntiRollBar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbRear }),
        chassisParam("rideHeightFrontMm", { label: "frontRideHeight", base: Math.round(b.rideFrontMm), min: Math.round(b.rideFrontMm) - 8, max: Math.round(b.rideFrontMm) + 10, step: 1, format: mm, fx: FX.rideFront }),
        chassisParam("rideHeightRearMm", { label: "rearRideHeight", base: Math.round(b.rideRearMm), min: Math.round(b.rideRearMm) - 10, max: Math.round(b.rideRearMm) + 15, step: 1, format: mm, fx: FX.rideRear }),
      ],
    },
    {
      id: "dampers",
      get label() { return tx("game.setupGroups.dampers"); },
      get short() { return tx("game.setupGroups.dampersShort"); },
      params: dampers(),
    },
    {
      id: "brakes",
      get label() { return tx("game.setupGroups.brakes"); },
      get short() { return tx("game.setupGroups.brakesShort"); },
      params: [
        chassisParam("brakePowerPct", { label: "brakePressure", base: 100, min: 80, max: 100, step: 1, format: pct, fx: FX.brakePressure }),
        tunerParam("brakeBiasPct", { label: "frontBrakeBias", base: 56, min: 50, max: 70, step: 0.5, format: (v) => `${v.toFixed(1)}%`, fx: FX.bias }),
        tunerParam("brakeMigrationPct", { label: "brakeMigration", base: 2.5, min: 0, max: 6, step: 0.5, format: (v) => `${v.toFixed(1)}%`, fx: FX.migration }),
      ],
    },
    {
      id: "tyres",
      get label() { return tx("game.setupGroups.tyres"); },
      get short() { return tx("game.setupGroups.tyresShort"); },
      extras: ["compound", "liveTyres"],
      params: [blanketParam(vehicle), ...tyrePressures(r, d)],
    },
    {
      id: "electronics",
      get label() { return tx("game.setupGroups.electronics"); },
      get short() { return tx("game.setupGroups.electronicsShort"); },
      extras: ["assists"],
      params: electronics(vehicle),
    },
    fuelGroup(vehicle),
  ];
}

/**
 * The GT3 sheet: shared by every GT3 car, and by the road cars (closed-wheel cars with ABS / TC). The brake bias,
 * bump-stop and preload ranges reach each car's own baseline; the rear wing and aero packages only show on a car
 * that has a wing.
 */
function gt3Sheet(vehicle: VehicleModelId, b: CarBaseline, r: TyreRanges, d: TyreSetup): SetupGroup[] {
  const hasWing = WING_CLICK_DEG[vehicle].rear > 0;
  const cfg = CONFIGS[vehicle];
  const susp = cfg?.suspensions;
  const hasThird = (susp?.front.heave.rate ?? 0) > 0 || (susp?.rear.heave.rate ?? 0) > 0;
  const pctOf = (key: keyof ChassisSetup, label: SetupLabel, fx: SetupEffect) =>
    chassisParam(key, { label, base: 0, min: -100, max: 100, step: CHASSIS_LIMITS[key].step, format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`, fx });
  const packerMm = (key: keyof ChassisSetup, label: SetupLabel, baseMm: number, fx: SetupEffect) =>
    chassisParam(key, { label, base: Math.round(baseMm), min: 0, max: 60, step: 1, format: mm, fx });
  const rate = (key: keyof ChassisSetup, label: SetupLabel, baseNmm: number, fx: SetupEffect) =>
    // The slider runs in % of the baseline; the readout is the rate itself
    chassisParam(key, { label, base: 0, min: -100, max: 100, step: CHASSIS_LIMITS[key].step, format: (v) => `${Math.round(baseNmm * (1 + v / 100))} N/mm`, fx });
  return [
    {
      id: "tyres",
      get label() { return tx("game.setupGroups.tyres"); },
      get short() { return tx("game.setupGroups.tyresShort"); },
      extras: ["compound", "liveTyres"],
      params: [
        blanketParam(vehicle),
        ...tyrePressures(r, d),
        chassisParam("toeFrontDeg", { label: "frontToe", base: b.toeFrontDeg, min: -0.4, max: 0.4, step: 0.01, format: toe, fx: FX.toeFront }),
        chassisParam("toeRearDeg", { label: "rearToe", base: b.toeRearDeg, min: -0.4, max: 0.4, step: 0.01, format: toe, fx: FX.toeRear }),
        ...cambers(r, d),
      ],
    },
    {
      id: "electronics",
      get label() { return tx("game.setupGroups.electronics"); },
      get short() { return tx("game.setupGroups.electronicsShort"); },
      extras: ["assists"],
      params: electronics(vehicle),
    },
    {
      id: "mechanical",
      get label() { return tx("game.setupGroups.mechanicalGrip"); },
      get short() { return tx("game.setupGroups.mechanicalGripShort"); },
      params: [
        arbParam("arbFrontPct", "frontAntiRollBar", susp?.front.allowNoArb === true, FX.arbFront),
        arbParam("arbRearPct", "rearAntiRollBar", susp?.rear.allowNoArb === true, FX.arbRear),
        chassisParam("brakePowerPct", { label: "brakePower", base: 100, min: 80, max: 100, step: 1, format: pct, fx: FX.brakePressure }),
        tunerParam("brakeBiasPct", {
          label: "brakeBias",
          base: b.brakeBiasPct ?? 71,
          min: b.brakeBiasRangePct?.[0] ?? 60,
          max: b.brakeBiasRangePct?.[1] ?? 78,
          // The adjuster's own click (0.2 % on the prototype's brake-by-wire)
          step: cfg?.brakes.ebbStep && cfg.brakes.ebbStep < 0.005 ? Number((cfg.brakes.ebbStep * 100).toFixed(2)) : 0.5,
          format: (v) => `${v.toFixed(1)}%`,
          fx: FX.bias,
        }),
        ...(cfg?.brakes.brakeByWire !== false && cfg?.brakes.migration
          ? [tunerParam("brakeMigrationPct", { label: "brakeMigration", base: cfg.brakes.migration.amount * 100, min: 0, max: 3, step: 0.1, format: (v) => `${v.toFixed(1)}%`, fx: FX.migration })]
          : []),
        // The readout in % of the engine's overrun; the setup keeps the change from the default tune, in % of it
        ...(b.engineBrakingPct !== undefined
          ? [chassisParam("engineBrakingPct", { label: "engineBraking", base: b.engineBrakingPct, perUnit: b.engineBrakingPct / 100, min: 25, max: 100, step: 5, format: pct, fx: FX.engineBraking })]
          : []),
        // A rack slower than 16:1 (the 934's 16.9) keeps its own ratio as the slowest
        chassisParam("steerRatioDelta", { label: "steeringRatio", base: b.steerRatio, min: 10, max: Math.max(16, b.steerRatio), step: 0.2, format: (v) => v.toFixed(1), fx: FX.steerRatio }),
        rate("springFrontPct", "frontWheelRate", b.wheelRateFrontNmm, FX.wheelRateFront),
        rate("springRearPct", "rearWheelRate", b.wheelRateRearNmm, FX.wheelRateRear),
        rate("bumpStopRateFrontPct", "frontBumpStopRate", b.bumpStopRateFrontNmm, FX.bumpStopRate),
        rate("bumpStopRateRearPct", "rearBumpStopRate", b.bumpStopRateRearNmm, FX.bumpStopRate),
        chassisParam("bumpStopRangeFrontMm", { label: "frontBumpStopRange", base: Math.round(b.bumpStopRangeFrontMm), min: 5, max: Math.max(70, Math.round(b.bumpStopRangeFrontMm) + 10), step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("bumpStopRangeRearMm", { label: "rearBumpStopRange", base: Math.round(b.bumpStopRangeRearMm), min: 5, max: Math.max(70, Math.round(b.bumpStopRangeRearMm) + 10), step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("diffPreloadNm", { label: "diffPreload", base: b.diffPreloadNm, min: Math.min(20, b.diffPreloadNm), max: 300, step: 10, format: (v) => `${Math.round(v)} Nm`, fx: FX.preload }),
        packerMm("cornerPackerFrontMm", "frontCornerPackers", 1000 * (susp?.front.bumpStop.packerGap ?? 0), FX.cornerPacker),
        packerMm("cornerPackerRearMm", "rearCornerPackers", 1000 * (susp?.rear.bumpStop.packerGap ?? 0), FX.cornerPacker),
        ...(cfg?.gearSets && cfg.gearSets.length > 1
          ? [
              chassisParam("gearRatioSet", {
                label: "gearSet",
                base: 0,
                min: 0,
                max: cfg.gearSets.length - 1,
                step: 1,
                format: (v) => cfg.gearSets?.[Math.round(v)]?.label ?? int(v),
                fx: FX.gearSet,
              }),
            ]
          : []),
      ],
    },
    ...(hasThird
      ? [
          {
            id: "third",
            get label() { return tx("game.setupGroups.thirdElements"); },
            get short() { return tx("game.setupGroups.thirdElementsShort"); },
            params: [
              pctOf("heaveSpringFrontPct", "frontThirdSpring", FX.heaveSpring),
              pctOf("heaveSpringRearPct", "rearThirdSpring", FX.heaveSpring),
              chassisParam("heavePackerFrontMm", { label: "frontThirdPacker", base: Math.round(1000 * (susp?.front.heave.packerGap ?? 0)), min: 0, max: 80, step: 1, format: mm, fx: FX.heavePacker }),
              chassisParam("heavePackerRearMm", { label: "rearThirdPacker", base: Math.round(1000 * (susp?.rear.heave.packerGap ?? 0)), min: 0, max: 80, step: 1, format: mm, fx: FX.heavePacker }),
              pctOf("heaveBumpFrontPct", "frontThirdBump", FX.bump),
              pctOf("heaveBumpRearPct", "rearThirdBump", FX.bump),
              pctOf("heaveFastBumpFrontPct", "frontThirdFastBump", FX.fastBump),
              pctOf("heaveFastBumpRearPct", "rearThirdFastBump", FX.fastBump),
              pctOf("heaveReboundFrontPct", "frontThirdRebound", FX.rebound),
              pctOf("heaveReboundRearPct", "rearThirdRebound", FX.rebound),
              pctOf("heaveFastReboundFrontPct", "frontThirdFastRebound", FX.fastRebound),
              pctOf("heaveFastReboundRearPct", "rearThirdFastRebound", FX.fastRebound),
            ],
          } satisfies SetupGroup,
        ]
      : []),
    {
      id: "dampers",
      get label() { return tx("game.setupGroups.dampers"); },
      get short() { return tx("game.setupGroups.dampersShort"); },
      params: dampers(),
    },
    {
      id: "aero",
      get label() { return tx("game.setupGroups.aero"); },
      get short() { return tx("game.setupGroups.aeroShort"); },
      extras: hasWing ? ["aeroPackage"] : [],
      params: [
        chassisParam("rideHeightFrontMm", { label: "frontRideHeight", base: Math.round(b.rideFrontMm), min: Math.round(b.rideFrontMm) - 15, max: Math.round(b.rideFrontMm) + 15, step: 1, format: mm, fx: FX.rideFront }),
        chassisParam("rideHeightRearMm", { label: "rearRideHeight", base: Math.round(b.rideRearMm), min: Math.round(b.rideRearMm) - 15, max: Math.round(b.rideRearMm) + 15, step: 1, format: mm, fx: FX.rideRear }),
        ...(hasWing ? [chassisParam("rearWingClicks", { label: "rearWing", base: 5, min: 0, max: 10, step: 1, format: int, fx: FX.rearWing })] : []),
        chassisParam("brakeDuctFront", { label: "frontBrakeDucts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductFront }),
        chassisParam("brakeDuctRear", { label: "rearBrakeDucts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductRear }),
        ...(cfg?.aero.cooling
          ? [chassisParam("radiatorTapeSteps", { label: "radiatorOpening", base: 3, min: 1, max: 7, step: 1, format: int, fx: FX.radiator })]
          : []),
      ],
    },
    fuelGroup(vehicle),
  ];
}

/** The setup sheet of a car: its class's parameters on that car's baseline */
export function setupSheet(vehicle: VehicleModelId, tyreRanges: TyreRanges, tyreDefaults: TyreSetup): SetupGroup[] {
  const b = BASELINES[vehicle];
  return SETUP_CLASS[vehicle] === "gt3" ? gt3Sheet(vehicle, b, tyreRanges, tyreDefaults) : f1Sheet(vehicle, b, tyreRanges, tyreDefaults);
}

const DUMMY_TYRE_RANGES: TyreRanges = {
  pressurePsi: { min: 15, max: 35, step: 0.5 },
  camberFrontDeg: { min: -5, max: 0, step: 0.1 },
  camberRearDeg: { min: -5, max: 0, step: 0.1 },
};
const DUMMY_TYRE_SETUP: TyreSetup = {
  coldPressurePsi: { fl: 25, fr: 25, rl: 25, rr: 25 },
  camberDeg: { front: -2, rear: -1.5 },
};

/**
 * Clamps a full garage setup (chassis, tyres, and tuner dials) through a specific car's own setup sheet.
 * Any chassis offset not present on that car's sheet resets to baseline (0), so forged or cross-car setups can
 * never hand the physics engine a value no slider on that car can produce.
 */
export function clampSetupToSheet(
  vehicle: VehicleModelId,
  state: SetupState,
  tyreRanges: TyreRanges,
  tyreDefaults: TyreSetup,
): SetupState {
  const sheet = setupSheet(vehicle, tyreRanges, tyreDefaults);
  const input: SetupState = {
    chassis: { ...DEFAULT_CHASSIS_SETUP, ...state.chassis },
    tyre: state.tyre,
    tuner: state.tuner ?? {},
  };
  let out: SetupState = {
    chassis: { ...DEFAULT_CHASSIS_SETUP },
    tyre: {
      coldPressurePsi: { ...state.tyre.coldPressurePsi },
      camberDeg: { ...state.tyre.camberDeg },
    },
    tuner: {},
  };
  for (const group of sheet) {
    for (const param of group.params) {
      if (param.writes === "tuner") {
        const key = param.id as keyof GarageTuner;
        const rawVal = input.tuner[key];
        if (rawVal === undefined) continue;
        const safe = Number.isFinite(rawVal) ? Math.min(param.max, Math.max(param.min, rawVal)) : param.base;
        out = param.set(out, Number(safe.toFixed(3)));
        continue;
      }
      const v = param.get(input);
      const clamped = Number.isFinite(v) ? Math.min(param.max, Math.max(param.min, v)) : param.base;
      // Snap chassis parameters to real slider steps so between-step values (e.g. 2.37 clicks or 0.5 gear set) cannot pass through
      const safe =
        param.writes === "chassis" && param.step > 0
          ? Math.min(param.max, Math.max(param.min, Number((param.min + Math.round((clamped - param.min) / param.step) * param.step).toFixed(4))))
          : clamped;
      out = param.set(out, safe);
    }
  }
  // MFD-adjustable differential dials (usable in-car on both F1 and GT3-class cars via TunerMfdPanel)
  for (const diffKey of ["diffEntry", "diffMid", "diffExit"] as const) {
    if (out.tuner[diffKey] === undefined && input.tuner[diffKey] !== undefined && Number.isFinite(input.tuner[diffKey])) {
      out.tuner = { ...out.tuner, [diffKey]: Math.min(12, Math.max(1, Math.round(input.tuner[diffKey]!))) };
    }
  }
  return out;
}

/** Clamps a chassis setup to the exact slider ranges (and available parameters) of `vehicle`'s setup sheet */
export function clampChassisToCarSheet(vehicle: VehicleModelId, chassis: Partial<ChassisSetup>): ChassisSetup {
  return clampSetupToSheet(
    vehicle,
    { chassis: { ...DEFAULT_CHASSIS_SETUP, ...chassis }, tyre: DUMMY_TYRE_SETUP, tuner: {} },
    DUMMY_TYRE_RANGES,
    DUMMY_TYRE_SETUP,
  ).chassis;
}

/** Clamps a partial tuner object to the exact ranges (and available dials) of `vehicle`'s setup sheet */
export function clampTunerToCarSheet(vehicle: VehicleModelId, tuner: Partial<GarageTuner>): GarageTuner {
  return clampSetupToSheet(
    vehicle,
    { chassis: DEFAULT_CHASSIS_SETUP, tyre: DUMMY_TYRE_SETUP, tuner },
    DUMMY_TYRE_RANGES,
    DUMMY_TYRE_SETUP,
  ).tuner;
}
