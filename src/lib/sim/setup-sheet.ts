/**
 * Setup sheets per car class, laid out the way drivers expect: the F1 cars share one sheet (aerodynamics,
 * transmission, suspension geometry, suspension, brakes, tyres) and the GT3 cars another (tyres, electronics,
 * mechanical grip, dampers, aero). One sheet serves every car of its class; each car only brings its own baseline
 * (ride heights, wheel rates, bump stops, preload, steering ratio, tyre ranges).
 *
 * A sheet is a view over the setup the cars already take: the chassis offsets (`ChassisSetup`), the tyre setup and
 * the electronics' starting dials. Each parameter reads its game-style value from that state and writes it back.
 */

import type { TyreSetup, VehicleModelId } from "@/types/f1";
import { type ChassisSetup, CHASSIS_LIMITS, type GarageTuner, STEER_RATIO_BASE } from "./car-setup";
import { VF26_CHASSIS } from "./vf26-data";
import { F12026_CAR_CONFIG } from "./f12026-car/F12026CarConfig";
import { AMG_GT3_CONFIG } from "./gt3/AmgGt3Config";

export type SetupClassId = "f1" | "gt3";

export const SETUP_CLASS: Record<VehicleModelId, SetupClassId> = {
  vf26: "f1",
  "f12026-car": "f1",
  "amg-gt3": "gt3",
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
}

const rigidBaseline = (cfg: typeof F12026_CAR_CONFIG | typeof AMG_GT3_CONFIG, vehicle: VehicleModelId): CarBaseline => ({
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
});

const BASELINES: Record<VehicleModelId, CarBaseline> = {
  vf26: {
    rideFrontMm: VF26_CHASSIS.front.staticRideHeight * 1000,
    rideRearMm: VF26_CHASSIS.rear.staticRideHeight * 1000,
    toeFrontDeg: VF26_CHASSIS.front.staticToeDeg,
    toeRearDeg: VF26_CHASSIS.rear.staticToeDeg,
    wheelRateFrontNmm: VF26_CHASSIS.front.springRate / 1000,
    wheelRateRearNmm: VF26_CHASSIS.rear.springRate / 1000,
    bumpStopRateFrontNmm: 0,
    bumpStopRateRearNmm: 0,
    bumpStopRangeFrontMm: 0,
    bumpStopRangeRearMm: 0,
    diffPreloadNm: 0,
    steerRatio: STEER_RATIO_BASE.vf26,
  },
  "f12026-car": rigidBaseline(F12026_CAR_CONFIG, "f12026-car"),
  "amg-gt3": rigidBaseline(AMG_GT3_CONFIG, "amg-gt3"),
};

const clampTo = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v));

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
} satisfies Record<string, SetupEffect>;

export const ENGINE_MAP_LABELS = ["", "1 · Max", "2 · Race", "3 · Smooth", "4 · Lean", "5 · Save"];

/** The parameters every car shares on its electronics page */
const electronics = (): SetupParam[] => [
  tunerParam("tcLevel", { label: "TC 1", base: 5, min: 0, max: 12, step: 1, format: (v) => (v === 0 ? "OFF" : int(v)), fx: FX.tc }),
  tunerParam("tc2Level", { label: "TC 2", base: 6, min: 1, max: 12, step: 1, format: int, fx: FX.tc2 }),
  tunerParam("absLevel", { label: "ABS", base: 5, min: 0, max: 12, step: 1, format: (v) => (v === 0 ? "OFF" : int(v)), fx: FX.abs }),
  tunerParam("engineMap", { label: "Engine map", base: 2, min: 1, max: 5, step: 1, format: (v) => ENGINE_MAP_LABELS[v] ?? int(v), fx: FX.map }),
];

const tyrePressures = (r: TyreRanges, d: TyreSetup): SetupParam[] => [
  tyreParam("psiFront", "Front pressure", r.pressurePsi, d.coldPressurePsi.front, (t) => t.coldPressurePsi.front, (t, v) => ({ ...t, coldPressurePsi: { ...t.coldPressurePsi, front: v } }), psi, FX.coldPsi),
  tyreParam("psiRear", "Rear pressure", r.pressurePsi, d.coldPressurePsi.rear, (t) => t.coldPressurePsi.rear, (t, v) => ({ ...t, coldPressurePsi: { ...t.coldPressurePsi, rear: v } }), psi, FX.coldPsi),
];

const cambers = (r: TyreRanges, d: TyreSetup): SetupParam[] => [
  tyreParam("camberFront", "Front camber", r.camberFrontDeg, d.camberDeg.front, (t) => t.camberDeg.front, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, front: v } }), camber, FX.camberFront, true),
  tyreParam("camberRear", "Rear camber", r.camberRearDeg, d.camberDeg.rear, (t) => t.camberDeg.rear, (t, v) => ({ ...t, camberDeg: { ...t.camberDeg, rear: v } }), camber, FX.camberRear, true),
];

/** The F1 sheet: shared by every F1 car */
function f1Sheet(b: CarBaseline, r: TyreRanges, d: TyreSetup): SetupGroup[] {
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
      params: tyrePressures(r, d),
    },
    {
      id: "electronics",
      label: "Electronics",
      short: "Electr.",
      extras: ["assists"],
      params: electronics(),
    },
  ];
}

/** The GT3 sheet: shared by every GT3 car */
function gt3Sheet(b: CarBaseline, r: TyreRanges, d: TyreSetup): SetupGroup[] {
  const damper = (key: keyof ChassisSetup, label: string, fx: SetupEffect) =>
    // Clicks 0–16 with the baseline at 8: each click 5 % of the baseline damping
    chassisParam(key, { label, base: 8, perUnit: 1 / 5, min: 0, max: 16, step: 1, format: int, fx });
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
      params: electronics(),
    },
    {
      id: "mechanical",
      label: "Mechanical grip",
      short: "Mech.",
      params: [
        chassisParam("arbFrontPct", { label: "Front anti-roll bar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbFront }),
        chassisParam("arbRearPct", { label: "Rear anti-roll bar", base: 11, perUnit: 1 / 5, min: 1, max: 21, step: 1, format: int, fx: FX.arbRear }),
        chassisParam("brakePowerPct", { label: "Brake power", base: 100, min: 80, max: 100, step: 1, format: pct, fx: FX.brakePressure }),
        tunerParam("brakeBiasPct", { label: "Brake bias", base: 71, min: 60, max: 78, step: 0.5, format: (v) => `${v.toFixed(1)}%`, fx: FX.bias }),
        chassisParam("steerRatioDelta", { label: "Steering ratio", base: b.steerRatio, min: 10, max: 16, step: 0.2, format: (v) => v.toFixed(1), fx: FX.steerRatio }),
        rate("springFrontPct", "Front wheel rate", b.wheelRateFrontNmm, FX.wheelRateFront),
        rate("springRearPct", "Rear wheel rate", b.wheelRateRearNmm, FX.wheelRateRear),
        rate("bumpStopRateFrontPct", "Front bump stop rate", b.bumpStopRateFrontNmm, FX.bumpStopRate),
        rate("bumpStopRateRearPct", "Rear bump stop rate", b.bumpStopRateRearNmm, FX.bumpStopRate),
        chassisParam("bumpStopRangeFrontMm", { label: "Front bump stop range", base: Math.round(b.bumpStopRangeFrontMm), min: 5, max: 40, step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("bumpStopRangeRearMm", { label: "Rear bump stop range", base: Math.round(b.bumpStopRangeRearMm), min: 5, max: 40, step: 1, format: mm, fx: FX.bumpStopRange }),
        chassisParam("diffPreloadNm", { label: "Diff preload", base: b.diffPreloadNm, min: 20, max: 300, step: 10, format: (v) => `${Math.round(v)} Nm`, fx: FX.preload }),
      ],
    },
    {
      id: "dampers",
      label: "Dampers",
      short: "Dampers",
      params: [
        damper("bumpFrontPct", "Front bump", FX.bump),
        damper("bumpRearPct", "Rear bump", FX.bump),
        damper("fastBumpFrontPct", "Front fast bump", FX.fastBump),
        damper("fastBumpRearPct", "Rear fast bump", FX.fastBump),
        damper("reboundFrontPct", "Front rebound", FX.rebound),
        damper("reboundRearPct", "Rear rebound", FX.rebound),
        damper("fastReboundFrontPct", "Front fast rebound", FX.fastRebound),
        damper("fastReboundRearPct", "Rear fast rebound", FX.fastRebound),
      ],
    },
    {
      id: "aero",
      label: "Aero",
      short: "Aero",
      extras: ["aeroPackage"],
      params: [
        chassisParam("rideHeightFrontMm", { label: "Front ride height", base: Math.round(b.rideFrontMm), min: Math.round(b.rideFrontMm) - 15, max: Math.round(b.rideFrontMm) + 15, step: 1, format: mm, fx: FX.rideFront }),
        chassisParam("rideHeightRearMm", { label: "Rear ride height", base: Math.round(b.rideRearMm), min: Math.round(b.rideRearMm) - 15, max: Math.round(b.rideRearMm) + 15, step: 1, format: mm, fx: FX.rideRear }),
        chassisParam("rearWingClicks", { label: "Rear wing", base: 5, min: 0, max: 10, step: 1, format: int, fx: FX.rearWing }),
        chassisParam("brakeDuctFront", { label: "Front brake ducts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductFront }),
        chassisParam("brakeDuctRear", { label: "Rear brake ducts", base: 3, min: 0, max: 6, step: 1, format: int, fx: FX.ductRear }),
      ],
    },
  ];
}

/** The setup sheet of a car: its class's parameters on that car's baseline */
export function setupSheet(vehicle: VehicleModelId, tyreRanges: TyreRanges, tyreDefaults: TyreSetup): SetupGroup[] {
  const b = BASELINES[vehicle];
  return SETUP_CLASS[vehicle] === "gt3" ? gt3Sheet(b, tyreRanges, tyreDefaults) : f1Sheet(b, tyreRanges, tyreDefaults);
}
