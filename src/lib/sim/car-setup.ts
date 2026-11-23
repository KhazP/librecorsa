/**
 * Engineer's garage setup: chassis changes as offsets from each car's own baseline (so one setup shape fits every
 * car), and saved presets per car (wing, ride height, springs, bars, dampers, tyres, compound, aero package and the
 * electronics' starting dials).
 */

import { text as t } from "@/lib/text";
import type { AeroSetupPreset, LiveTunerPatch, TireCompound, TyreSetup, VehicleModelId, WheelPressures } from "@/types/f1";
import { axlePressures } from "@/types/f1";
import { LC26_CHASSIS } from "./lc26-data";

export interface ChassisSetup {
  /** Wing steps from the baseline (see WING_CLICK_DEG for a step's size on each car) */
  frontWingClicks: number;
  rearWingClicks: number;
  /** Static ride height from the baseline (mm) */
  rideHeightFrontMm: number;
  rideHeightRearMm: number;
  /** Corner springs and anti-roll bars, % stiffer (+) or softer (−) than the baseline */
  springFrontPct: number;
  springRearPct: number;
  arbFrontPct: number;
  arbRearPct: number;
  /** Dampers per axle, % stiffer or softer than the baseline: slow (body motion) and fast (kerbs, bumps) */
  bumpFrontPct: number;
  bumpRearPct: number;
  fastBumpFrontPct: number;
  fastBumpRearPct: number;
  reboundFrontPct: number;
  reboundRearPct: number;
  fastReboundFrontPct: number;
  fastReboundRearPct: number;
  /** Static toe from the baseline (deg, + = more toe-in) */
  toeFrontDeg: number;
  toeRearDeg: number;
  /** Brake pressure / power, % of the baseline's full-pedal torque (0 = 100 %) */
  brakePowerPct: number;
  /** Closed-throttle engine braking, % of the baseline (0 = 100 %) */
  engineBrakingPct: number;
  /** Steering ratio from the baseline (higher = slower steering, less lock) */
  steerRatioDelta: number;
  /** Bump stops: rate % of the baseline and free travel to the rubber (mm) */
  bumpStopRateFrontPct: number;
  bumpStopRateRearPct: number;
  bumpStopRangeFrontMm: number;
  bumpStopRangeRearMm: number;
  /** Limited-slip preload from the baseline (Nm) */
  diffPreloadNm: number;
  /** Brake duct openings from the baseline (steps of a 0–6 scale) */
  brakeDuctFront: number;
  brakeDuctRear: number;
  /** Starting fuel load from the car's default (kg, see FUEL_LOAD) */
  fuelDeltaKg: number;
  /** Third (heave) springs, % stiffer or softer than the baseline, on a car that has them */
  heaveSpringFrontPct: number;
  heaveSpringRearPct: number;
  /** Third-spring packers: free heave travel before they touch, from the baseline (mm, + = more travel) */
  heavePackerFrontMm: number;
  heavePackerRearMm: number;
  /** Corner packers on the damper shafts (mm), taking free travel off the bump rubbers */
  cornerPackerFrontMm: number;
  cornerPackerRearMm: number;
  /** Third dampers, % stiffer or softer than the baseline: slow and fast, bump and rebound */
  heaveBumpFrontPct: number;
  heaveBumpRearPct: number;
  heaveFastBumpFrontPct: number;
  heaveFastBumpRearPct: number;
  heaveReboundFrontPct: number;
  heaveReboundRearPct: number;
  heaveFastReboundFrontPct: number;
  heaveFastReboundRearPct: number;
  /** Radiator opening in steps from the baseline (− = taped up: less drag, a hotter engine) */
  radiatorTapeSteps: number;
  /** Which of the car's homologated gear sets (`CarPhysicsConfig.gearSets`): 0 its first, the sprint set */
  gearRatioSet: number;
  /**
   * Tyre blankets: 1 on (the tyres leave the garage warm at every start), −1 off, 0 the car's own way (on for a car
   * raced on blankets, `racesOnBlankets`)
   */
  tyreBlankets: number;
}

export const DEFAULT_CHASSIS_SETUP: ChassisSetup = {
  frontWingClicks: 0,
  rearWingClicks: 0,
  rideHeightFrontMm: 0,
  rideHeightRearMm: 0,
  springFrontPct: 0,
  springRearPct: 0,
  arbFrontPct: 0,
  arbRearPct: 0,
  bumpFrontPct: 0,
  bumpRearPct: 0,
  fastBumpFrontPct: 0,
  fastBumpRearPct: 0,
  reboundFrontPct: 0,
  reboundRearPct: 0,
  fastReboundFrontPct: 0,
  fastReboundRearPct: 0,
  toeFrontDeg: 0,
  toeRearDeg: 0,
  brakePowerPct: 0,
  engineBrakingPct: 0,
  steerRatioDelta: 0,
  bumpStopRateFrontPct: 0,
  bumpStopRateRearPct: 0,
  bumpStopRangeFrontMm: 0,
  bumpStopRangeRearMm: 0,
  diffPreloadNm: 0,
  brakeDuctFront: 0,
  brakeDuctRear: 0,
  fuelDeltaKg: 0,
  heaveSpringFrontPct: 0,
  heaveSpringRearPct: 0,
  heavePackerFrontMm: 0,
  heavePackerRearMm: 0,
  cornerPackerFrontMm: 0,
  cornerPackerRearMm: 0,
  heaveBumpFrontPct: 0,
  heaveBumpRearPct: 0,
  heaveFastBumpFrontPct: 0,
  heaveFastBumpRearPct: 0,
  heaveReboundFrontPct: 0,
  heaveReboundRearPct: 0,
  heaveFastReboundFrontPct: 0,
  heaveFastReboundRearPct: 0,
  radiatorTapeSteps: 0,
  gearRatioSet: 0,
  tyreBlankets: 0,
};

export interface SetupRange {
  min: number;
  max: number;
  step: number;
}

/** The widest each offset can go on any car (a class's setup sheet narrows it, see setup-sheet.ts) */
export const CHASSIS_LIMITS: Record<keyof ChassisSetup, SetupRange> = {
  frontWingClicks: { min: -25, max: 25, step: 1 },
  rearWingClicks: { min: -25, max: 25, step: 1 },
  rideHeightFrontMm: { min: -15, max: 15, step: 1 },
  rideHeightRearMm: { min: -15, max: 15, step: 1 },
  springFrontPct: { min: -30, max: 30, step: 1.5 },
  springRearPct: { min: -30, max: 30, step: 1.5 },
  // Below −50 % only −100 % itself: the bar disconnected, on a car whose data allows it (`AxleSuspensionData.allowNoArb`)
  arbFrontPct: { min: -50, max: 50, step: 5 },
  arbRearPct: { min: -50, max: 50, step: 5 },
  bumpFrontPct: { min: -40, max: 40, step: 5 },
  bumpRearPct: { min: -40, max: 40, step: 5 },
  fastBumpFrontPct: { min: -40, max: 40, step: 5 },
  fastBumpRearPct: { min: -40, max: 40, step: 5 },
  reboundFrontPct: { min: -40, max: 40, step: 5 },
  reboundRearPct: { min: -40, max: 40, step: 5 },
  fastReboundFrontPct: { min: -40, max: 40, step: 5 },
  fastReboundRearPct: { min: -40, max: 40, step: 5 },
  toeFrontDeg: { min: -0.6, max: 0.6, step: 0.01 },
  toeRearDeg: { min: -0.6, max: 0.6, step: 0.01 },
  brakePowerPct: { min: -20, max: 0, step: 1 },
  // Up to +100: a car whose default tune halves the overrun (the Chaparral 2Ds) can put all of it back
  engineBrakingPct: { min: -50, max: 100, step: 5 },
  steerRatioDelta: { min: -2.6, max: 3.4, step: 0.1 },
  bumpStopRateFrontPct: { min: -60, max: 100, step: 10 },
  bumpStopRateRearPct: { min: -60, max: 100, step: 10 },
  bumpStopRangeFrontMm: { min: -15, max: 20, step: 1 },
  bumpStopRangeRearMm: { min: -15, max: 20, step: 1 },
  diffPreloadNm: { min: -80, max: 200, step: 10 },
  brakeDuctFront: { min: -3, max: 3, step: 1 },
  brakeDuctRear: { min: -3, max: 3, step: 1 },
  fuelDeltaKg: { min: -50, max: 80, step: 1 },
  heaveSpringFrontPct: { min: -40, max: 60, step: 2 },
  heaveSpringRearPct: { min: -40, max: 60, step: 2 },
  heavePackerFrontMm: { min: -15, max: 25, step: 1 },
  heavePackerRearMm: { min: -15, max: 25, step: 1 },
  cornerPackerFrontMm: { min: 0, max: 25, step: 1 },
  cornerPackerRearMm: { min: 0, max: 25, step: 1 },
  heaveBumpFrontPct: { min: -40, max: 40, step: 5 },
  heaveBumpRearPct: { min: -40, max: 40, step: 5 },
  heaveFastBumpFrontPct: { min: -40, max: 40, step: 5 },
  heaveFastBumpRearPct: { min: -40, max: 40, step: 5 },
  heaveReboundFrontPct: { min: -40, max: 40, step: 5 },
  heaveReboundRearPct: { min: -40, max: 40, step: 5 },
  heaveFastReboundFrontPct: { min: -40, max: 40, step: 5 },
  heaveFastReboundRearPct: { min: -40, max: 40, step: 5 },
  radiatorTapeSteps: { min: -2, max: 4, step: 1 },
  gearRatioSet: { min: 0, max: 1, step: 1 },
  tyreBlankets: { min: -1, max: 1, step: 1 },
};

/** Element angle one wing step adds (deg): F1 cars on a 0–50 scale, the GT3 rear wing in its own clicks */
export const WING_CLICK_DEG: Record<VehicleModelId, { front: number; rear: number }> = {
  lc26: { front: 0.1, rear: 0.14 },
  "f12026-car": { front: 0.2, rear: 0.2 },
  "amg-gt3": { front: 0.4, rear: 0.6 },
  // No wings
  liana: { front: 0, rear: 0 },
  // A fixed splitter; the rear wing in its 1° setup clicks [spec setup.ini WING_2]
  "mtr-496r": { front: 0, rear: 1 },
  // A fixed splitter; the rear wing in half-degree steps over its 1–9° [est]
  "lc-lmdh": { front: 0, rear: 0.5 },
  // Splitter and rear wing in 1° clicks [spec setup.ini WING_0, WING_1]
  "nissan-r33-jgtc": { front: 1, rear: 1 },
  // No wing adjusters in its setup
  "nissan-r32-jtcc": { front: 0, rear: 0 },
  // A fixed front spoiler; the rear wing in its 1° setup clicks [spec setup.ini WING_1 STEP 0, WING_2]
  "bmw-m1-procar": { front: 0, rear: 1 },
  // No wings
  "vw-scirocco-gtx": { front: 0, rear: 0 },
  // Their aero kits are switches, not clicks (the aero package picks them) [spec setup.ini WING_3, WING_4: 0 or 50]
  "chaparral-2d": { front: 0, rear: 0 },
  "chaparral-2d-67": { front: 0, rear: 0 },
  // A fixed spoiler and wing (setup.ini has no wing entry)
  "porsche-934-rsr": { front: 0, rear: 0 },
};

/**
 * Fuel each car can leave the garage with (kg): the default it has always started on, the lightest load the garage
 * allows and the tank. The GT3's tank is 120 L of race fuel at 0.74 kg/L.
 */
export const FUEL_LOAD: Record<VehicleModelId, { defaultKg: number; minKg: number; maxKg: number }> = {
  lc26: { defaultKg: LC26_CHASSIS.fuelKg, minKg: 5, maxKg: LC26_CHASSIS.fuelTankKg },
  "f12026-car": { defaultKg: 35, minKg: 5, maxKg: 110 },
  // A sprint's fixed 30 kg (≈ 40 l) [est]
  "amg-gt3": { defaultKg: 30, minKg: 5, maxKg: 74 },
  // 30 l of a 50 l tank of petrol [spec car.ini FUEL / MAX_FUEL]
  liana: { defaultKg: 22, minKg: 4, maxKg: 37 },
  // 30 l of a 90 l tank [spec car.ini FUEL / MAX_FUEL]
  "mtr-496r": { defaultKg: 22, minKg: 4, maxKg: 67 },
  // A sprint's fixed 28 kg (≈ 38 l) [est]: the regulations ask for a cell of at least 110 l (Art. 13.14) [spec], 81.4 kg
  // of race fuel, and hold the class to an energy per stint
  "lc-lmdh": { defaultKg: 28, minKg: 5, maxKg: 82 },
  // 40 l of a 100 l tank [spec car.ini FUEL / MAX_FUEL]
  "nissan-r33-jgtc": { defaultKg: 30, minKg: 4, maxKg: 74 },
  // 30 l of a 120 l tank [spec car.ini FUEL / MAX_FUEL]
  "nissan-r32-jtcc": { defaultKg: 22, minKg: 4, maxKg: 89 },
  // 30 l of a 70 l tank [spec car.ini FUEL / MAX_FUEL]
  "bmw-m1-procar": { defaultKg: 22, minKg: 4, maxKg: 52 },
  // 30 l of a 55 l tank [spec car.ini FUEL / MAX_FUEL]
  "vw-scirocco-gtx": { defaultKg: 22, minKg: 4, maxKg: 41 },
  // 30 l of a 160 l tank [spec car.ini FUEL / MAX_FUEL], filled as far as the garage's +80 kg goes (138 l)
  "chaparral-2d": { defaultKg: 22, minKg: 4, maxKg: 102 },
  "chaparral-2d-67": { defaultKg: 22, minKg: 4, maxKg: 102 },
  // 30 l of a 120 l tank [spec car.ini FUEL / MAX_FUEL], filled as far as the garage's +80 kg goes (138 l)
  "porsche-934-rsr": { defaultKg: 22, minKg: 4, maxKg: 89 },
};

/**
 * The default loads a garage save made before 18 Nov 2026 has its fuel offset from, where today's differ (kg): the GT3
 * started on 50 kg and the LMDh on 38 until the sprints' fixed loads
 */
const FUEL_DEFAULT_BEFORE_NOV_18_KG: Partial<Record<VehicleModelId, number>> = { "amg-gt3": 50, "lc-lmdh": 38 };

/**
 * A saved setup's fuel offset carried over to today's default. Every save since 18 Nov 2026 holds a `tyreBlankets`
 * entry; one without it was made against the defaults before then, and a load the driver chose (any offset but 0) keeps
 * its kilograms, as far as today's tank goes. An offset of 0 was the default then and stays the default now
 */
function rebaseSavedFuel(vehicle: VehicleModelId, saved: unknown): unknown {
  const before = FUEL_DEFAULT_BEFORE_NOV_18_KG[vehicle];
  if (before === undefined || !saved || typeof saved !== "object" || "tyreBlankets" in saved) return saved;
  const delta = (saved as { fuelDeltaKg?: unknown }).fuelDeltaKg;
  if (typeof delta !== "number" || !Number.isFinite(delta) || delta === 0) return saved;
  const f = FUEL_LOAD[vehicle];
  const kg = Math.max(f.minKg, Math.min(f.maxKg, before + delta));
  return { ...saved, fuelDeltaKg: kg - f.defaultKg };
}

/** Race fuel density (kg per litre), for the litre readouts */
export const FUEL_KG_PER_L = 0.74;

/** The fuel a car starts a run with under a garage setup (kg) */
export function startingFuelKg(vehicle: VehicleModelId, setup: Pick<ChassisSetup, "fuelDeltaKg">): number {
  const f = FUEL_LOAD[vehicle];
  const delta = Number.isFinite(setup.fuelDeltaKg) ? setup.fuelDeltaKg : 0;
  return Math.max(f.minKg, Math.min(f.maxKg, f.defaultKg + delta));
}

/** Brake cooling of a duct step (fraction of the baseline's airflow) */
export const BRAKE_DUCT_STEP = 0.18;

/** Steering ratio each car is built with (steering-wheel degrees per road-wheel degree) */
export const STEER_RATIO_BASE: Record<VehicleModelId, number> = {
  lc26: 11,
  "f12026-car": 11,
  "amg-gt3": 12.6,
  liana: 15,
  "mtr-496r": 14,
  // 527° of rim lock for 20° at the road wheels [est]
  "lc-lmdh": 13.175,
  // [spec car.ini STEER_RATIO]
  "nissan-r33-jgtc": 15,
  "nissan-r32-jtcc": 12.4,
  "bmw-m1-procar": 16,
  "vw-scirocco-gtx": 14,
  "chaparral-2d": 14.1,
  "chaparral-2d-67": 14.1,
  "porsche-934-rsr": 16.9,
};

export function clampChassisSetup(v: unknown): ChassisSetup {
  const src = { ...((v && typeof v === "object" ? v : {}) as Record<string, unknown>) };
  // Saved before the dampers were split per axle and stage: one bump and one rebound for all of them
  for (const [old, keys] of [
    ["bumpPct", ["bumpFrontPct", "bumpRearPct", "fastBumpFrontPct", "fastBumpRearPct"]],
    ["reboundPct", ["reboundFrontPct", "reboundRearPct", "fastReboundFrontPct", "fastReboundRearPct"]],
  ] as const) {
    if (typeof src[old] === "number") for (const k of keys) if (src[k] === undefined) src[k] = src[old];
  }
  const out = { ...DEFAULT_CHASSIS_SETUP };
  for (const k of Object.keys(CHASSIS_LIMITS) as (keyof ChassisSetup)[]) {
    const n = src[k];
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    if ((k === "arbFrontPct" || k === "arbRearPct") && n <= ARB_DETACHED_PCT) {
      out[k] = ARB_DETACHED_PCT;
      continue;
    }
    const r = CHASSIS_LIMITS[k];
    out[k] = Number(Math.max(r.min, Math.min(r.max, Math.round(n / r.step) * r.step)).toFixed(3));
  }
  return out;
}

/** The anti-roll bar setting that disconnects it (−100 %: 0 N/m) */
export const ARB_DETACHED_PCT = -100;

/** 1 + pct / 100, for scaling a baseline */
export const pctScale = (pct: number) => 1 + pct / 100;

/** The electronics a preset sets as the car leaves the garage */
export type GarageTuner = Pick<
  LiveTunerPatch,
  | "tcLevel"
  | "tc2Level"
  | "tcSlipAngleLevel"
  | "absLevel"
  | "brakeBiasPct"
  | "brakeMigrationPct"
  | "diffEntry"
  | "diffMid"
  | "diffExit"
  | "engineMap"
  | "motorDeployKw"
  | "regenKw"
>;

export interface GaragePreset {
  id: string;
  name: string;
  savedAt: number;
  vehicle: VehicleModelId;
  chassis: ChassisSetup;
  tyre: TyreSetup;
  compound: TireCompound;
  aero: AeroSetupPreset;
  tuner: GarageTuner;
}

/** A setup the car comes with: its overrides on top of the car's baseline (the electronics and compound stay as set) */
export interface FactoryPreset {
  id: string;
  name: string;
  aero: AeroSetupPreset;
  chassis: Partial<ChassisSetup>;
  camberDeg?: { front: number; rear: number };
}

/** The endurance cars' low-drag trims for long-straight circuits: low-downforce aero on the long gear set */
export const FACTORY_PRESETS: Partial<Record<VehicleModelId, readonly FactoryPreset[]>> = {
  "amg-gt3": [
    {
      id: "low_drag_gt3",
      get name() { return t("game.setupShare.factoryLowDrag"); },
      aero: "low_downforce",
      chassis: { gearRatioSet: 1 },
    },
  ],
  // The prototype also runs its rear bar detached and less camber for the straights
  "lc-lmdh": [
    {
      id: "low_drag_proto",
      get name() { return t("game.setupShare.factoryLowDrag"); },
      aero: "low_downforce",
      chassis: { gearRatioSet: 1, arbRearPct: ARB_DETACHED_PCT },
      camberDeg: { front: -1.2, rear: -1.0 },
    },
  ],
};

const chassisKey = (v: VehicleModelId) => `lc.garage.chassis.${v}`;
const presetsKey = (v: VehicleModelId) => `lc.garage.presets.${v}`;
/** Saved setups kept per car */
export const GARAGE_PRESETS_MAX = 24;
/** A saved item under the model's id, or under the id the 2026 Prototype had before it was renamed */
const readSaved = (key: (v: VehicleModelId) => string, v: VehicleModelId): string | null =>
  window.localStorage.getItem(key(v)) ?? (v === "lc26" ? window.localStorage.getItem(key("vf26" as VehicleModelId)) : null); // keep-old-id

export function loadChassisSetup(vehicle: VehicleModelId): ChassisSetup {
  try {
    const raw = readSaved(chassisKey, vehicle);
    return raw ? clampChassisSetup(rebaseSavedFuel(vehicle, JSON.parse(raw))) : { ...DEFAULT_CHASSIS_SETUP };
  } catch {
    return { ...DEFAULT_CHASSIS_SETUP };
  }
}

export function saveChassisSetup(vehicle: VehicleModelId, setup: ChassisSetup): void {
  try {
    window.localStorage.setItem(chassisKey(vehicle), JSON.stringify(setup));
  } catch {
    // Storage blocked: the setup lasts for this session
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Saved cold pressures: per wheel, or as the `{ front, rear }` saved before pressures were per wheel, spread to both
 * tyres of each axle. Null when they are neither.
 */
export function wheelPressuresOf(value: unknown): WheelPressures | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (isFiniteNumber(v.fl) && isFiniteNumber(v.fr) && isFiniteNumber(v.rl) && isFiniteNumber(v.rr)) {
    return { fl: v.fl, fr: v.fr, rl: v.rl, rr: v.rr };
  }
  return isFiniteNumber(v.front) && isFiniteNumber(v.rear) ? axlePressures(v.front, v.rear) : null;
}

/** A preset's tyre setup with per-wheel pressures (an unreadable pressure is left for the car to ignore) */
function perWheelTyreSetup(tyre: TyreSetup): TyreSetup {
  const coldPressurePsi = wheelPressuresOf(tyre?.coldPressurePsi);
  return coldPressurePsi ? { ...tyre, coldPressurePsi } : tyre;
}

export function loadGaragePresets(vehicle: VehicleModelId): GaragePreset[] {
  try {
    const raw = readSaved(presetsKey, vehicle);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((p): p is GaragePreset => Boolean(p) && typeof p === "object" && typeof (p as GaragePreset).name === "string")
      .map((p) => ({ ...p, vehicle, chassis: clampChassisSetup(rebaseSavedFuel(vehicle, p.chassis)), tyre: perWheelTyreSetup(p.tyre) }));
  } catch {
    return [];
  }
}

export function saveGaragePresets(vehicle: VehicleModelId, presets: GaragePreset[]): boolean {
  try {
    window.localStorage.setItem(presetsKey(vehicle), JSON.stringify(presets.slice(0, GARAGE_PRESETS_MAX)));
    return true;
  } catch {
    return false;
  }
}
