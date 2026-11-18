/**
 * Setup sheets per car class, laid out the way drivers expect: the F1 cars share one sheet (aerodynamics,
 * transmission, suspension geometry, suspension, dampers, brakes, tyres, fuel) and the GT3 cars another (tyres,
 * electronics, mechanical grip, dampers, aero, fuel). One sheet serves every car of its class; each car only brings its own baseline
 * (ride heights, wheel rates, bump stops, preload, steering ratio, tyre ranges).
 *
 * A sheet is a view over the setup the cars already take: the chassis offsets (`ChassisSetup`), the tyre setup and
 * the electronics' starting dials. Each parameter reads its game-style value from that state and writes it back.
 */

import type { TyreSetup, VehicleModelId } from "@/types/f1";
import { ARB_DETACHED_PCT, type ChassisSetup, CHASSIS_LIMITS, FUEL_KG_PER_L, FUEL_LOAD, type GarageTuner, STEER_RATIO_BASE, WING_CLICK_DEG } from "./car-setup";
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
function arbParam(key: "arbFrontPct" | "arbRearPct", label: string, detachable: boolean, fx: SetupEffect): SetupParam {
  const lim = CHASSIS_LIMITS[key];
  return {
    id: key,
    label,
    min: detachable ? 0 : 1,
    max: 21,
    step: 1,
    base: 11,
    get: (st) => (st.chassis[key] <= ARB_DETACHED_PCT + 1e-6 ? 0 : Math.max(1, 11 + st.chassis[key] / 5)),
    set: (st, v) => ({
      ...st,
      chassis: { ...st.chassis, [key]: Math.round(v) <= 0 && detachable ? ARB_DETACHED_PCT : clampTo((Math.max(1, Math.round(v)) - 11) * 5, lim) },
    }),
    format: (v) => (v <= 0 ? "Detached" : int(v)),
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
  o: { id?: string; label: string; base: number; perUnit?: number; min: number; max: number; step: number; format: (v: number) => string; fx: SetupEffect }
): SetupParam {
  const k = o.perUnit ?? 1;
  const lim = CHASSIS_LIMITS[key];
  // Range in whole steps from the baseline, so the slider (which snaps to min + n·step) lands on the baseline
  const lo = Math.max(o.min, o.base + Math.min(lim.min * k, lim.max * k));
  const hi = Math.min(o.max, o.base + Math.max(lim.min * k, lim.max * k));
  const eps = 1e-6;
  return {
    id: o.id ?? key,
    label: o.label,
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
  o: { label: string; base: number; min: number; max: number; step: number; format: (v: number) => string; fx: SetupEffect }
): SetupParam {
  return {
    id: key,
    label: o.label,
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
  label: string,
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
    label,
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
const toe = (v: number) => (Math.abs(v) < 0.005 ? "0.00°" : `${Math.abs(v).toFixed(2)}° ${v > 0 ? "in" : "out"}`);
const pct = (v: number) => `${Math.round(v)}%`;
const mm = (v: number) => `${Math.round(v)} mm`;
const int = (v: number) => String(Math.round(v));
/** Diff levels 1–12 on F1's 10–100 % scale */
const diffPct = (lvl: number) => `${Math.round(10 + ((lvl - 1) * 90) / 11)}%`;

const FX = {
  frontWing: { more: "More front grip at speed, looser rear", less: "Steadier rear, more high-speed understeer" },
  rearWing: { more: "More stability and traction, more drag", less: "Faster on straights, nervous rear" },
  diffOn: { more: "More drive, power oversteer", less: "Easier on the rears, inside wheel spins" },
  diffOff: { more: "Stable off throttle, resists turn-in", less: "Rotates on entry, can feel loose" },
  engineBraking: { more: "More rear braking on lift, rotates", less: "Calmer on lift, longer stops" },
  camberFront: { more: "More front grip mid-corner", less: "Better braking, even wear" },
  camberRear: { more: "More rear lateral grip", less: "Better traction out of slow corners" },
  toeFront: { more: "Steadier on the straights, lazier turn-in", less: "Sharper turn-in, twitchy at speed" },
  toeRear: { more: "Stable rear, a little more drag", less: "Rotates more, less stable" },
  springFront: { more: "Sharper response, less bump grip", less: "More front grip over bumps" },
  springRear: { more: "Rotates more, less traction", less: "More traction, lazier rotation" },
  arbFront: { more: "Quick direction changes, understeer", less: "More front grip mid-corner" },
  arbRear: { more: "More rotation, less exit traction", less: "More rear grip, more understeer" },
  rideFront: { more: "Safer over kerbs, less downforce", less: "More downforce, floor can stall" },
  rideRear: { more: "More rake: sharper, looser rear", less: "Calmer rear, more understeer" },
  brakePressure: { more: "Shorter stops, locks sooner", less: "Easier to modulate, longer stops" },
  bias: { more: "Stable braking, fronts lock first", less: "Rotates on entry, rears lock first" },
  migration: { more: "Rotates on trail braking", less: "Balance stays put through release" },
  coldPsi: { more: "Warms up faster, less peak grip", less: "More grip, slower to warm up" },
  blankets: { more: "Warm tyres from the first corner", less: "Cold out of the garage, warm them on the out-lap" },
  tc: { more: "Less wheelspin, slower exits", less: "Faster exits, rear can step out" },
  tc2: { more: "Hard cut: catches slides firmly", less: "Soft cut: keeps more drive" },
  abs: { more: "No lock-ups, longer stops", less: "Shorter stops if you are precise" },
  map: { more: "Softer throttle, less power", less: "Full power, sharper throttle" },
  steerRatio: { more: "Slower steering, less lock", less: "Quicker steering, more lock" },
  wheelRateFront: { more: "Sharper front, less bump grip", less: "More front grip over bumps" },
  wheelRateRear: { more: "Rotates more, less traction", less: "More traction, lazier rotation" },
  bumpStopRate: { more: "Firmer when it hits the stops", less: "Softer landing on the stops" },
  bumpStopRange: { more: "More travel before the stops", less: "Hits the stops sooner, flatter platform" },
  preload: { more: "Stable in fast corners, pushes slow", less: "Rotates on entry, looser exits" },
  bump: { more: "Body moves less, harsher on bumps", less: "Rides bumps, platform moves more" },
  fastBump: { more: "Firm over kerbs", less: "Soaks up kerbs" },
  rebound: { more: "Weight returns slowly, steady exits", less: "Tyres follow the road better" },
  fastRebound: { more: "Wheel stays down slower after kerbs", less: "Wheel drops back quickly" },
  ductFront: { more: "Cooler front brakes, more drag", less: "Hotter front brakes, less drag" },
  ductRear: { more: "Cooler rear brakes, more drag", less: "Hotter rear brakes, less drag" },
  radiator: { more: "Cooler engine, more drag", less: "Less drag, the engine runs hot" },
  gearSet: { more: "Long gears: top speed on long straights", less: "Short gears: quicker out of slow corners" },
  heaveSpring: { more: "Flatter platform at speed, harsher on bumps", less: "Rides bumps, the floor moves more" },
  heavePacker: { more: "More travel before the packer", less: "The packer holds the floor up sooner" },
  cornerPacker: { more: "The stops come sooner, flatter in the corners", less: "More free travel, more roll" },
  tcSlipAngle: { more: "Cuts sooner as the rear slides", less: "Lets the rear slide further on power" },
  motorDeploy: { more: "More electric push, drains the battery", less: "Saves charge, less push" },
  regen: { more: "More charge back, more rear braking", less: "Calmer rear on the brakes, less charge" },
  fuel: { more: "Longer stint, heavier and slower", less: "Lighter and quicker, shorter stint" },
} satisfies Record<string, SetupEffect>;

export const ENGINE_MAP_LABELS = ["", "1 · Max", "2 · Race", "3 · Smooth", "4 · Lean", "5 · Save"];

/**
 * Bump and rebound, slow and fast, front and rear: clicks 0–16 with the baseline at 8, each click 5 % of the
 * car's own baseline damping. Every car shares the page; the physics scales each car's damper curves.
 */
const dampers = (): SetupParam[] => {
  const damper = (key: keyof ChassisSetup, label: string, fx: SetupEffect) =>
    chassisParam(key, { label, base: 8, perUnit: 1 / 5, min: 0, max: 16, step: 1, format: int, fx });
  return [
    damper("bumpFrontPct", "Front bump", FX.bump),
    damper("bumpRearPct", "Rear bump", FX.bump),
    damper("fastBumpFrontPct", "Front fast bump", FX.fastBump),
    damper("fastBumpRearPct", "Rear fast bump", FX.fastBump),
    damper("reboundFrontPct", "Front rebound", FX.rebound),
    damper("reboundRearPct", "Rear rebound", FX.rebound),
    damper("fastReboundFrontPct", "Front fast rebound", FX.fastRebound),
    damper("fastReboundRearPct", "Rear fast rebound", FX.fastRebound),
  ];
};

/**
 * The parameters every car shares on its electronics page, with a car's own: the slip-angle traction dial, a
 * prototype's hybrid dials
 */
const electronics = (vehicle?: VehicleModelId): SetupParam[] => {
  const cfg = vehicle ? CONFIGS[vehicle] : null;
  const dials = cfg?.hybridDials;
  const off = (v: number) => (v === 0 ? "OFF" : int(v));
  return [
    tunerParam("tcLevel", { label: vehicle && TC_SLIP_ANGLE_CARS.has(vehicle) ? "TC slip" : "TC 1", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.tc }),
    tunerParam("tc2Level", { label: vehicle && TC_SLIP_ANGLE_CARS.has(vehicle) ? "TC cut" : "TC 2", base: 6, min: 1, max: 12, step: 1, format: int, fx: FX.tc2 }),
    ...(vehicle && TC_SLIP_ANGLE_CARS.has(vehicle)
      ? [tunerParam("tcSlipAngleLevel", { label: "TC slip angle", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.tcSlipAngle })]
      : []),
    tunerParam("absLevel", { label: "ABS", base: 5, min: 0, max: 12, step: 1, format: off, fx: FX.abs }),
    tunerParam("engineMap", { label: "Engine map", base: 2, min: 1, max: 5, step: 1, format: (v) => ENGINE_MAP_LABELS[v] ?? int(v), fx: FX.map }),
    ...(dials
      ? [
          tunerParam("motorDeployKw", {
            label: "Motor deployment",
            base: dials.deployStepsKw[dials.defaultDeployIndex],
            min: Math.min(...dials.deployStepsKw),
            max: Math.max(...dials.deployStepsKw),
            step: 10,
            format: (v) => `${Math.round(v)} kW`,
            fx: FX.motorDeploy,
          }),
          tunerParam("regenKw", {
            label: "Regeneration",
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
      ["fl", "psiFL", "Front-left pressure"],
      ["fr", "psiFR", "Front-right pressure"],
      ["rl", "psiRL", "Rear-left pressure"],
      ["rr", "psiRR", "Rear-right pressure"],
    ] as const
  ).map(([k, key, label]) =>
    tyreParam(key, label, r.pressurePsi, d.coldPressurePsi[k], (t) => t.coldPressurePsi[k], (t, v) => ({ ...t, coldPressurePsi: { ...t.coldPressurePsi, [k]: v } }), psi, FX.coldPsi)
  );

const cambers = (r: TyreRanges, d: TyreSetup): SetupParam[] => [
  tyreParam("camberFront", "Front camber", r.camberFrontDeg, d.camberDeg.front, (t) => t.camberDeg.front, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, front: v } }), camber, FX.camberFront, true),
  tyreParam("camberRear", "Rear camber", r.camberRearDeg, d.camberDeg.rear, (t) => t.camberDeg.rear, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, rear: v } }), camber, FX.camberRear, true),
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
    label: "Tyre blankets",
    min: 0,
    max: 1,
    step: 1,
    base,
    get: (st) => (st.chassis.tyreBlankets === 0 ? base : st.chassis.tyreBlankets > 0 ? 1 : 0),
    set: (st, v) => ({ ...st, chassis: { ...st.chassis, tyreBlankets: Math.round(v) === base ? 0 : Math.round(v) >= 1 ? 1 : -1 } }),
    format: (v) => (v >= 1 ? "On" : "Off"),
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
    label: "Fuel",
    short: "Fuel",
    params: [chassisParam("fuelDeltaKg", { label: "Starting fuel", base: f.defaultKg, min: f.minKg, max: f.maxKg, step: 1, format, fx: FX.fuel })],
  };
};

/** The F1 sheet: shared by every F1 car */
function f1Sheet(vehicle: VehicleModelId, b: CarBaseline, r: TyreRanges, d: TyreSetup): SetupGroup[] {
  return [
    {
      id: "aero",
      label: "Aerodynamics",
      short: "Aero",
      extras: ["aeroPackage"],
      params: [
        chassisParam("frontWingClicks", { label: "Front wing", base: 25, min: 0, max: 50, step: 1, format: int, fx: FX.frontWing }),
        chassisParam("rearWingClicks", { label: "Rear wing", base: 25, min: 0, max: 50, step: 1, format: int, fx: FX.rearWing }),
      ],
    },
    {
      id: "transmission",
      label: "Transmission",
      short: "Trans.",
      params: [
        tunerParam("diffExit", { label: "Diff on throttle", base: 5, min: 1, max: 12, step: 1, format: diffPct, fx: FX.diffOn }),
        tunerParam("diffEntry", { label: "Diff off throttle", base: 3, min: 1, max: 12, step: 1, format: diffPct, fx: FX.diffOff }),
        chassisParam("engineBrakingPct", { label: "Engine braking", base: 100, min: 50, max: 100, step: 5, format: pct, fx: FX.engineBraking }),
      ],
    },
    {
      id: "geometry",
      label: "Suspension geometry",
      short: "Geometry",
      params: [
        ...cambers(r, d),
        chassisParam("toeFrontDeg", { label: "Front toe", base: b.toeFrontDeg, min: -0.5, max: 0.3, step: 0.01, format: toe, fx: FX.toeFront }),
        chassisParam("toeRearDeg", { label: "Rear toe", base: b.toeRearDeg, min: -0.1, max: 0.5, step: 0.01, format: toe, fx: FX.toeRear }),
      ],
    },
    {
      id: "suspension",
      label: "Suspension",
      short: "Susp.",
      params: [
        // 1–41 as in the games: each step 1.5 % of the baseline rate, 21 the baseline
        chassisParam("springFrontPct", { label: "Front suspension", base: 21, perUnit: 1 / 1.5, min: 1, max: 41, step: 1, format: int, fx: FX.springFront }),
        chassisParam("springRearPct", { label: "Rear suspension", base: 21, perUnit: 1 / 1.5, min: 1, max: 41, step: 1, format: int, fx: FX.springRear }),
        chassisParam("arbFrontPct", { label: "Front anti-roll bar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbFront }),
        chassisParam("arbRearPct", { label: "Rear anti-roll bar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbRear }),
        chassisParam("rideHeightFrontMm", { label: "Front ride height", base: Math.round(b.rideFrontMm), min: Math.round(b.rideFrontMm) - 8, max: Math.round(b.rideFrontMm) + 10, step: 1, format: mm, fx: FX.rideFront }),
        chassisParam("rideHeightRearMm", { label: "Rear ride height", base: Math.round(b.rideRearMm), min: Math.round(b.rideRearMm) - 10, max: Math.round(b.rideRearMm) + 15, step: 1, format: mm, fx: FX.rideRear }),
      ],
    },
    {
      id: "dampers",
      label: "Dampers",
      short: "Dampers",
      params: dampers(),
    },
    {
      id: "brakes",
      label: "Brakes",
      short: "Brakes",
      params: [
        chassisParam("brakePowerPct", { label: "Brake pressure", base: 100, min: 80, max: 100, step: 1, format: pct, fx: FX.brakePressure }),
        tunerParam("brakeBiasPct", { label: "Front brake bias", base: 56, min: 50, max: 70, step: 0.5, format: (v) => `${v.toFixed(1)}%`, fx: FX.bias }),
        tunerParam("brakeMigrationPct", { label: "Brake migration", base: 2.5, min: 0, max: 6, step: 0.5, format: (v) => `${v.toFixed(1)}%`, fx: FX.migration }),
      ],
    },
    {
      id: "tyres",
      label: "Tyres",
      short: "Tyres",
      extras: ["compound", "liveTyres"],
      params: [blanketParam(vehicle), ...tyrePressures(r, d)],
    },
    {
      id: "electronics",
      label: "Electronics",
      short: "Electr.",
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
  const pctOf = (key: keyof ChassisSetup, label: string, fx: SetupEffect) =>
    chassisParam(key, { label, base: 0, min: -100, max: 100, step: CHASSIS_LIMITS[key].step, format: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`, fx });
  const packerMm = (key: keyof ChassisSetup, label: string, baseMm: number, fx: SetupEffect) =>
    chassisParam(key, { label, base: Math.round(baseMm), min: 0, max: 60, step: 1, format: mm, fx });
  const rate = (key: keyof ChassisSetup, label: string, baseNmm: number, fx: SetupEffect) =>
    // The slider runs in % of the baseline; the readout is the rate itself
    chassisParam(key, { label, base: 0, min: -100, max: 100, step: CHASSIS_LIMITS[key].step, format: (v) => `${Math.round(baseNmm * (1 + v / 100))} N/mm`, fx });
  return [
    {
      id: "tyres",
      label: "Tyres",
      short: "Tyres",
      extras: ["compound", "liveTyres"],
      params: [
        blanketParam(vehicle),
        ...tyrePressures(r, d),
        chassisParam("toeFrontDeg", { label: "Front toe", base: b.toeFrontDeg, min: -0.4, max: 0.4, step: 0.01, format: toe, fx: FX.toeFront }),
        chassisParam("toeRearDeg", { label: "Rear toe", base: b.toeRearDeg, min: -0.4, max: 0.4, step: 0.01, format: toe, fx: FX.toeRear }),
        ...cambers(r, d),
      ],
    },
    {
      id: "electronics",
      label: "Electronics",
      short: "Electr.",
      extras: ["assists"],
      params: electronics(vehicle),
    },
    {
      id: "mechanical",
      label: "Mechanical grip",
      short: "Mech.",
      params: [
        arbParam("arbFrontPct", "Front anti-roll bar", susp?.front.allowNoArb === true, FX.arbFront),
        arbParam("arbRearPct", "Rear anti-roll bar", susp?.rear.allowNoArb === true, FX.arbRear),
        chassisParam("brakePowerPct", { label: "Brake power", base: 100, min: 80, max: 100, step: 1, format: pct, fx: FX.brakePressure }),
        tunerParam("brakeBiasPct", {
          label: "Brake bias",
          base: b.brakeBiasPct ?? 71,
          min: b.brakeBiasRangePct?.[0] ?? 60,
          max: b.brakeBiasRangePct?.[1] ?? 78,
          // The adjuster's own click (0.2 % on the prototype's brake-by-wire)
          step: cfg?.brakes.ebbStep && cfg.brakes.ebbStep < 0.005 ? Number((cfg.brakes.ebbStep * 100).toFixed(2)) : 0.5,
          format: (v) => `${v.toFixed(1)}%`,
          fx: FX.bias,
        }),
        ...(cfg?.brakes.brakeByWire !== false && cfg?.brakes.migration
          ? [tunerParam("brakeMigrationPct", { label: "Brake migration", base: cfg.brakes.migration.amount * 100, min: 0, max: 3, step: 0.1, format: (v) => `${v.toFixed(1)}%`, fx: FX.migration })]
          : []),
        // The readout in % of the engine's overrun; the setup keeps the change from the default tune, in % of it
        ...(b.engineBrakingPct !== undefined
          ? [chassisParam("engineBrakingPct", { label: "Engine braking", base: b.engineBrakingPct, perUnit: b.engineBrakingPct / 100, min: 25, max: 100, step: 5, format: pct, fx: FX.engineBraking })]
          : []),
        // A rack slower than 16:1 (the 934's 16.9) keeps its own ratio as the slowest
        chassisParam("steerRatioDelta", { label: "Steering ratio", base: b.steerRatio, min: 10, max: Math.max(16, b.steerRatio), step: 0.2, format: (v) => v.toFixed(1), fx: FX.steerRatio }),
        rate("springFrontPct", "Front wheel rate", b.wheelRateFrontNmm, FX.wheelRateFront),
        rate("springRearPct", "Rear wheel rate", b.wheelRateRearNmm, FX.wheelRateRear),
        rate("bumpStopRateFrontPct", "Front bump stop rate", b.bumpStopRateFrontNmm, FX.bumpStopRate),
        rate("bumpStopRateRearPct", "Rear bump stop rate", b.bumpStopRateRearNmm, FX.bumpStopRate),
        chassisParam("bumpStopRangeFrontMm", { label: "Front bump stop range", base: Math.round(b.bumpStopRangeFrontMm), min: 5, max: Math.max(70, Math.round(b.bumpStopRangeFrontMm) + 10), step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("bumpStopRangeRearMm", { label: "Rear bump stop range", base: Math.round(b.bumpStopRangeRearMm), min: 5, max: Math.max(70, Math.round(b.bumpStopRangeRearMm) + 10), step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("diffPreloadNm", { label: "Diff preload", base: b.diffPreloadNm, min: Math.min(20, b.diffPreloadNm), max: 300, step: 10, format: (v) => `${Math.round(v)} Nm`, fx: FX.preload }),
        packerMm("cornerPackerFrontMm", "Front corner packers", 1000 * (susp?.front.bumpStop.packerGap ?? 0), FX.cornerPacker),
        packerMm("cornerPackerRearMm", "Rear corner packers", 1000 * (susp?.rear.bumpStop.packerGap ?? 0), FX.cornerPacker),
        ...(cfg?.gearSets && cfg.gearSets.length > 1
          ? [
              chassisParam("gearRatioSet", {
                label: "Gear set",
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
            label: "Third elements",
            short: "3rd",
            params: [
              pctOf("heaveSpringFrontPct", "Front third spring", FX.heaveSpring),
              pctOf("heaveSpringRearPct", "Rear third spring", FX.heaveSpring),
              chassisParam("heavePackerFrontMm", { label: "Front third packer", base: Math.round(1000 * (susp?.front.heave.packerGap ?? 0)), min: 0, max: 80, step: 1, format: mm, fx: FX.heavePacker }),
              chassisParam("heavePackerRearMm", { label: "Rear third packer", base: Math.round(1000 * (susp?.rear.heave.packerGap ?? 0)), min: 0, max: 80, step: 1, format: mm, fx: FX.heavePacker }),
              pctOf("heaveBumpFrontPct", "Front third bump", FX.bump),
              pctOf("heaveBumpRearPct", "Rear third bump", FX.bump),
              pctOf("heaveFastBumpFrontPct", "Front third fast bump", FX.fastBump),
              pctOf("heaveFastBumpRearPct", "Rear third fast bump", FX.fastBump),
              pctOf("heaveReboundFrontPct", "Front third rebound", FX.rebound),
              pctOf("heaveReboundRearPct", "Rear third rebound", FX.rebound),
              pctOf("heaveFastReboundFrontPct", "Front third fast rebound", FX.fastRebound),
              pctOf("heaveFastReboundRearPct", "Rear third fast rebound", FX.fastRebound),
            ],
          } satisfies SetupGroup,
        ]
      : []),
    {
      id: "dampers",
      label: "Dampers",
      short: "Dampers",
      params: dampers(),
    },
    {
      id: "aero",
      label: "Aero",
      short: "Aero",
      extras: hasWing ? ["aeroPackage"] : [],
      params: [
        chassisParam("rideHeightFrontMm", { label: "Front ride height", base: Math.round(b.rideFrontMm), min: Math.round(b.rideFrontMm) - 15, max: Math.round(b.rideFrontMm) + 15, step: 1, format: mm, fx: FX.rideFront }),
        chassisParam("rideHeightRearMm", { label: "Rear ride height", base: Math.round(b.rideRearMm), min: Math.round(b.rideRearMm) - 15, max: Math.round(b.rideRearMm) + 15, step: 1, format: mm, fx: FX.rideRear }),
        ...(hasWing ? [chassisParam("rearWingClicks", { label: "Rear wing", base: 5, min: 0, max: 10, step: 1, format: int, fx: FX.rearWing })] : []),
        chassisParam("brakeDuctFront", { label: "Front brake ducts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductFront }),
        chassisParam("brakeDuctRear", { label: "Rear brake ducts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductRear }),
        ...(cfg?.aero.cooling
          ? [chassisParam("radiatorTapeSteps", { label: "Radiator opening", base: 3, min: 1, max: 7, step: 1, format: int, fx: FX.radiator })]
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
