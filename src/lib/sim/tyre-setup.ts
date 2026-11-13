/**
 * Tyre setup per vehicle model: the slider ranges (each model's own clamps, so the sliders never go further than the
 * car will) and the setup saved between sessions.
 */

import type { TyreSetup, VehicleModelId, WheelPressures } from "@/types/f1";
import { VEHICLE_MODELS, type TyreSetupRanges } from "@/lib/cars/vehicle-models";
import { wheelPressuresOf } from "./car-setup";

interface SliderLimits {
  min: number;
  max: number;
  step: number;
}
export interface TyreSetupLimits {
  pressurePsi: SliderLimits;
  camberFrontDeg: SliderLimits;
  camberRearDeg: SliderLimits;
}

const limitsOf = (r: TyreSetupRanges): TyreSetupLimits => ({
  pressurePsi: { min: r.coldPsiRange[0], max: r.coldPsiRange[1], step: 0.5 },
  camberFrontDeg: { min: r.frontCamberRange[0], max: r.frontCamberRange[1], step: 0.1 },
  camberRearDeg: { min: r.rearCamberRange[0], max: r.rearCamberRange[1], step: 0.1 },
});

/** Slider ranges for the tyre setup per vehicle model, also used to check a saved setup */
export const TYRE_SETUP_LIMITS: Record<VehicleModelId, TyreSetupLimits> = {
  lc26: limitsOf(VEHICLE_MODELS.lc26.tyreSetupRanges),
  "f12026-car": limitsOf(VEHICLE_MODELS["f12026-car"].tyreSetupRanges),
  "amg-gt3": limitsOf(VEHICLE_MODELS["amg-gt3"].tyreSetupRanges),
  liana: limitsOf(VEHICLE_MODELS.liana.tyreSetupRanges),
  "mtr-496r": limitsOf(VEHICLE_MODELS["mtr-496r"].tyreSetupRanges),
};

/** Tyre setups are saved per vehicle model (the LC26 keeps the original key) */
const STORAGE_KEYS: Record<VehicleModelId, string> = {
  lc26: "bugesera.tyreSetup",
  "f12026-car": "bugesera.tyreSetup.f12026-car",
  "amg-gt3": "bugesera.tyreSetup.amg-gt3",
  liana: "bugesera.tyreSetup.liana",
  "mtr-496r": "bugesera.tyreSetup.mtr-496r",
};

const clampTo = (x: number, range: { min: number; max: number }) => Math.min(range.max, Math.max(range.min, x));
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readCamber(value: unknown, limits: TyreSetupLimits): TyreSetup["camberDeg"] | null {
  if (!value || typeof value !== "object") return null;
  const pair = value as { front?: unknown; rear?: unknown };
  if (!isFiniteNumber(pair.front) || !isFiniteNumber(pair.rear)) return null;
  return { front: clampTo(pair.front, limits.camberFrontDeg), rear: clampTo(pair.rear, limits.camberRearDeg) };
}

function readPressures(value: unknown, limits: TyreSetupLimits): WheelPressures | null {
  const p = wheelPressuresOf(value);
  if (!p) return null;
  const r = limits.pressurePsi;
  return { fl: clampTo(p.fl, r), fr: clampTo(p.fr, r), rl: clampTo(p.rl, r), rr: clampTo(p.rr, r) };
}

/** The tyre setup saved from an earlier session, inside today's ranges; null when none is saved or it is unusable */
export function loadTyreSetup(vehicle: VehicleModelId): TyreSetup | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[vehicle]);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { coldPressurePsi?: unknown; camberDeg?: unknown } | null;
    const limits = TYRE_SETUP_LIMITS[vehicle];
    const coldPressurePsi = readPressures(saved?.coldPressurePsi, limits);
    const camberDeg = readCamber(saved?.camberDeg, limits);
    return coldPressurePsi && camberDeg ? { coldPressurePsi, camberDeg } : null;
  } catch {
    // Storage unavailable or corrupt JSON: the car's defaults apply
    return null;
  }
}

export function saveTyreSetup(vehicle: VehicleModelId, setup: TyreSetup): void {
  try {
    localStorage.setItem(STORAGE_KEYS[vehicle], JSON.stringify(setup));
  } catch {
    // Storage unavailable: the setup still applies for this session
  }
}
