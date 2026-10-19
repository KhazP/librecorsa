/**
 * Engineer's garage setup: chassis changes as offsets from each car's own baseline (so one setup shape fits every
 * car), and saved presets per car (wing, ride height, springs, bars, dampers, tyres, compound, aero package and the
 * electronics' starting dials).
 */

import type { AeroSetupPreset, LiveTunerPatch, TireCompound, TyreSetup, VehicleModelId } from "@/types/f1";

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
  engineBrakingPct: { min: -50, max: 0, step: 5 },
  steerRatioDelta: { min: -2.6, max: 3.4, step: 0.1 },
  bumpStopRateFrontPct: { min: -60, max: 100, step: 10 },
  bumpStopRateRearPct: { min: -60, max: 100, step: 10 },
  bumpStopRangeFrontMm: { min: -15, max: 20, step: 1 },
  bumpStopRangeRearMm: { min: -15, max: 20, step: 1 },
  diffPreloadNm: { min: -80, max: 200, step: 10 },
  brakeDuctFront: { min: -3, max: 3, step: 1 },
  brakeDuctRear: { min: -3, max: 3, step: 1 },
};

/** Element angle one wing step adds (deg): F1 cars on a 0–50 scale, the GT3 rear wing in its own clicks */
export const WING_CLICK_DEG: Record<VehicleModelId, { front: number; rear: number }> = {
  vf26: { front: 0.1, rear: 0.14 },
  "f12026-car": { front: 0.2, rear: 0.2 },
  "amg-gt3": { front: 0.4, rear: 0.6 },
};

/** Brake cooling of a duct step (fraction of the baseline's airflow) */
export const BRAKE_DUCT_STEP = 0.18;

/** Steering ratio each car is built with (steering-wheel degrees per road-wheel degree) */
export const STEER_RATIO_BASE: Record<VehicleModelId, number> = {
  vf26: 11,
  "f12026-car": 11,
  "amg-gt3": 12.6,
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
    const r = CHASSIS_LIMITS[k];
    out[k] = Number(Math.max(r.min, Math.min(r.max, Math.round(n / r.step) * r.step)).toFixed(3));
  }
  return out;
}

/** 1 + pct / 100, for scaling a baseline */
export const pctScale = (pct: number) => 1 + pct / 100;

/** The electronics a preset sets as the car leaves the garage */
export type GarageTuner = Pick<
  LiveTunerPatch,
  "tcLevel" | "tc2Level" | "absLevel" | "brakeBiasPct" | "brakeMigrationPct" | "diffEntry" | "diffMid" | "diffExit" | "engineMap"
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

const chassisKey = (v: VehicleModelId) => `lc.garage.chassis.${v}`;
const presetsKey = (v: VehicleModelId) => `lc.garage.presets.${v}`;

export function loadChassisSetup(vehicle: VehicleModelId): ChassisSetup {
  try {
    const raw = window.localStorage.getItem(chassisKey(vehicle));
    return raw ? clampChassisSetup(JSON.parse(raw)) : { ...DEFAULT_CHASSIS_SETUP };
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

export function loadGaragePresets(vehicle: VehicleModelId): GaragePreset[] {
  try {
    const raw = window.localStorage.getItem(presetsKey(vehicle));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((p): p is GaragePreset => Boolean(p) && typeof p === "object" && typeof (p as GaragePreset).name === "string")
      .map((p) => ({ ...p, vehicle, chassis: clampChassisSetup(p.chassis) }));
  } catch {
    return [];
  }
}

export function saveGaragePresets(vehicle: VehicleModelId, presets: GaragePreset[]): boolean {
  try {
    window.localStorage.setItem(presetsKey(vehicle), JSON.stringify(presets.slice(0, 24)));
    return true;
  } catch {
    return false;
  }
}
