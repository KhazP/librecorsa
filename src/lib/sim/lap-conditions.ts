/**
 * The conditions a lap was driven in (driver aids, input device, tyres, weather, realism) and the condition class
 * it ranks in. Personal bests, ghosts and the online boards are keyed by (track, vehicle model, physics version,
 * condition class), so an assisted lap in the wet never sits on, or becomes the ghost of, a dry lap without aids.
 *
 * The classes are deliberately few: `pro` (no aids at all, full realism) and `assisted` (anything else), each in
 * the dry or the wet. Laps where the racing-line autopilot drove at any moment are `autopilot`: kept for the summary
 * card but never stored as a best, never used as a ghost and never uploaded. Recordings made before conditions were
 * recorded are `legacy`: they still load and play as ghosts, but they rank only against other legacy laps.
 *
 * Mirrored by scripts/leaderboard-supabase (lap_condition_class) and scripts/leaderboard-worker (conditionClass):
 * change the rules in all three places.
 */
import type { AssistPreset, TireCompound } from "@/types/f1";
import type { SimRealism } from "./sim-realism";
import type { WeatherPresetId } from "./weather";
import { DAMP_MM, STANDING_WATER_MM, WET_MM } from "./wet-tyres";

export type InputDeviceClass = "wheel" | "pad" | "keyboard" | "touch" | "mouse";
/** How wet the racing line got during the lap: < 0.08 mm dry, < 0.5 mm damp, < 1.5 mm wet, else flooded */
export type WetnessBand = "dry" | "damp" | "wet" | "flooded";

export const ASSIST_PRESETS: readonly AssistPreset[] = ["pro", "semi_pro", "assisted"];
export const INPUT_DEVICE_CLASSES: readonly InputDeviceClass[] = ["wheel", "pad", "keyboard", "touch", "mouse"];
export const WETNESS_BANDS: readonly WetnessBand[] = ["dry", "damp", "wet", "flooded"];
export const TYRE_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];
export const WEATHER_IDS: readonly WeatherPresetId[] = ["clear", "overcast", "light_rain", "heavy_rain", "drying", "dynamic"];
/** Realism levels from least to most realistic */
export const REALISM_LEVELS: readonly SimRealism[] = ["casual", "standard", "full"];

/** Conditions of a whole lap, each the most helpful value seen during it (a lap with TC on for one corner had TC) */
export interface LapConditions {
  /** Most assisted driver-aid preset selected during the lap */
  assistPreset: AssistPreset;
  /** Highest traction-control and ABS dial positions during the lap (0 = off) */
  tcLevel: number;
  absLevel: number;
  /** Traction control (the car's TC, or the keyboard's exit assist) helped at some point */
  tractionControl: boolean;
  abs: boolean;
  /** The controller steering assist shaped the steering at some point */
  steeringAssist: boolean;
  /** The gearbox shifted by itself at some point */
  autoGearbox: boolean;
  /** The racing-line autopilot drove at some point: the lap never ranks */
  autopilot: boolean;
  /** Device that did most of the steering */
  inputDevice: InputDeviceClass;
  /** Tyres on the car when the lap ended */
  tyreCompound: TireCompound;
  /** Weather setting when the lap ended */
  weather: WeatherPresetId;
  /** Wettest the racing line got during the lap */
  wetness: WetnessBand;
  /** Least realistic simulation level during the lap */
  realism: SimRealism;
  /** The car body driven (`CarId`); the vehicle model is the recording's `vehicle` */
  car: string | null;
}

/** One frame's conditions, as the simulator sees them; LapConditionsTracker folds them into a lap */
export interface LapConditionsFrame {
  assistPreset: AssistPreset;
  tcLevel: number;
  absLevel: number;
  /** Keyboard exit assist (throttle held back on wheelspin) active this frame */
  throttleAssist: boolean;
  steeringAssist: boolean;
  autoGearbox: boolean;
  autopilot: boolean;
  /** Device steering this frame; null when nothing is being touched */
  inputDevice: InputDeviceClass | null;
  tyreCompound: TireCompound;
  weather: WeatherPresetId;
  /** Water film on the racing line (mm) */
  lineWaterMm: number;
  realism: SimRealism;
  car: string | null;
}

export type ConditionClass = "pro-dry" | "pro-wet" | "assisted-dry" | "assisted-wet" | "autopilot" | "legacy";
/** Classes that rank, in the order the board filter lists them */
export const RANKED_CLASSES: readonly ConditionClass[] = ["pro-dry", "assisted-dry", "pro-wet", "assisted-wet"];
export const CONDITION_CLASSES: readonly ConditionClass[] = [...RANKED_CLASSES, "autopilot", "legacy"];

export const CONDITION_CLASS_LABELS: Record<ConditionClass, { label: string; short: string; detail: string }> = {
  "pro-dry": { label: "Pro · Dry", short: "PRO DRY", detail: "No driver aids, full realism, dry track" },
  "pro-wet": { label: "Pro · Wet", short: "PRO WET", detail: "No driver aids, full realism, damp or wet track" },
  "assisted-dry": { label: "Assisted · Dry", short: "AST DRY", detail: "Any driver aid or reduced realism, dry track" },
  "assisted-wet": { label: "Assisted · Wet", short: "AST WET", detail: "Any driver aid or reduced realism, damp or wet track" },
  autopilot: { label: "Autopilot", short: "AUTO", detail: "The racing-line autopilot drove part of the lap: not ranked" },
  legacy: { label: "Legacy", short: "LEGACY", detail: "Recorded before lap conditions were saved: conditions unknown" },
};

export function wetnessBand(lineWaterMm: number): WetnessBand {
  if (!(lineWaterMm >= DAMP_MM)) return "dry";
  if (lineWaterMm < WET_MM) return "damp";
  if (lineWaterMm < STANDING_WATER_MM) return "wet";
  return "flooded";
}

/** The class a lap ranks in; `null` conditions (a legacy recording) are `legacy` */
export function conditionClass(c: LapConditions | null): ConditionClass {
  if (!c) return "legacy";
  if (c.autopilot) return "autopilot";
  const pro = !c.tractionControl && !c.abs && !c.steeringAssist && !c.autoGearbox && c.realism === "full";
  const wet = c.wetness !== "dry";
  return pro ? (wet ? "pro-wet" : "pro-dry") : wet ? "assisted-wet" : "assisted-dry";
}

export function isRankedClass(c: ConditionClass): boolean {
  return RANKED_CLASSES.includes(c);
}

/** The class a player driving in this frame's conditions would be in now (the board filter's default) */
export function frameConditionClass(frame: LapConditionsFrame): ConditionClass {
  const t = new LapConditionsTracker();
  t.add(frame);
  return conditionClass(t.result());
}

const rankOf = <T>(list: readonly T[], v: T) => list.indexOf(v);

/** Folds a lap's frames into its LapConditions: each field takes the most helpful value seen */
export class LapConditionsTracker {
  private acc: Omit<LapConditions, "inputDevice" | "wetness"> | null = null;
  private maxWaterMm = 0;
  private deviceFrames = new Map<InputDeviceClass, number>();
  private lastDevice: InputDeviceClass | null = null;

  reset(): void {
    this.acc = null;
    this.maxWaterMm = 0;
    this.deviceFrames.clear();
    this.lastDevice = null;
  }

  get empty(): boolean {
    return this.acc === null;
  }

  add(f: LapConditionsFrame): void {
    const tc = Number.isFinite(f.tcLevel) ? Math.max(0, Math.round(f.tcLevel)) : 0;
    const abs = Number.isFinite(f.absLevel) ? Math.max(0, Math.round(f.absLevel)) : 0;
    if (Number.isFinite(f.lineWaterMm)) this.maxWaterMm = Math.max(this.maxWaterMm, f.lineWaterMm);
    if (f.inputDevice) {
      this.deviceFrames.set(f.inputDevice, (this.deviceFrames.get(f.inputDevice) ?? 0) + 1);
      this.lastDevice = f.inputDevice;
    }
    const a = this.acc;
    if (!a) {
      this.acc = {
        assistPreset: f.assistPreset,
        tcLevel: tc,
        absLevel: abs,
        tractionControl: tc > 0 || f.throttleAssist,
        abs: abs > 0,
        steeringAssist: f.steeringAssist,
        autoGearbox: f.autoGearbox,
        autopilot: f.autopilot,
        tyreCompound: f.tyreCompound,
        weather: f.weather,
        realism: f.realism,
        car: f.car,
      };
      return;
    }
    if (rankOf(ASSIST_PRESETS, f.assistPreset) > rankOf(ASSIST_PRESETS, a.assistPreset)) a.assistPreset = f.assistPreset;
    a.tcLevel = Math.max(a.tcLevel, tc);
    a.absLevel = Math.max(a.absLevel, abs);
    a.tractionControl ||= tc > 0 || f.throttleAssist;
    a.abs ||= abs > 0;
    a.steeringAssist ||= f.steeringAssist;
    a.autoGearbox ||= f.autoGearbox;
    a.autopilot ||= f.autopilot;
    a.tyreCompound = f.tyreCompound;
    a.weather = f.weather;
    if (rankOf(REALISM_LEVELS, f.realism) < rankOf(REALISM_LEVELS, a.realism)) a.realism = f.realism;
    a.car = f.car;
  }

  /** The lap's conditions, or null when no frame was added */
  result(): LapConditions | null {
    if (!this.acc) return null;
    let device: InputDeviceClass = this.lastDevice ?? "keyboard";
    let most = 0;
    for (const [d, n] of this.deviceFrames) {
      if (n > most) {
        most = n;
        device = d;
      }
    }
    return { ...this.acc, inputDevice: device, wetness: wetnessBand(this.maxWaterMm) };
  }
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const isDial = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;

/** Strict validation of untrusted conditions (imported files, downloads): a clean copy or null */
export function validateLapConditions(raw: unknown): LapConditions | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isOneOf(ASSIST_PRESETS, r.assistPreset)) return null;
  if (!isDial(r.tcLevel) || !isDial(r.absLevel)) return null;
  for (const k of ["tractionControl", "abs", "steeringAssist", "autoGearbox", "autopilot"] as const) {
    if (typeof r[k] !== "boolean") return null;
  }
  // A dial above zero is that aid on
  if ((r.tcLevel > 0 && r.tractionControl !== true) || (r.absLevel > 0 && r.abs !== true)) return null;
  if (!isOneOf(INPUT_DEVICE_CLASSES, r.inputDevice)) return null;
  if (!isOneOf(TYRE_COMPOUNDS, r.tyreCompound)) return null;
  if (!isOneOf(WEATHER_IDS, r.weather)) return null;
  if (!isOneOf(WETNESS_BANDS, r.wetness)) return null;
  if (!isOneOf(REALISM_LEVELS, r.realism)) return null;
  if (r.car !== null && (typeof r.car !== "string" || !/^[a-z0-9-]{1,32}$/.test(r.car))) return null;
  return {
    assistPreset: r.assistPreset,
    tcLevel: r.tcLevel,
    absLevel: r.absLevel,
    tractionControl: r.tractionControl as boolean,
    abs: r.abs as boolean,
    steeringAssist: r.steeringAssist as boolean,
    autoGearbox: r.autoGearbox as boolean,
    autopilot: r.autopilot as boolean,
    inputDevice: r.inputDevice,
    tyreCompound: r.tyreCompound,
    weather: r.weather,
    wetness: r.wetness,
    realism: r.realism,
    car: r.car as string | null,
  };
}

/** Short list of what helped on the lap, for tooltips: e.g. "TC 5 · ABS 5 · Auto gears · Pad" */
export function describeConditions(c: LapConditions | null): string {
  if (!c) return "Conditions not recorded";
  const parts: string[] = [];
  if (c.autopilot) parts.push("Autopilot");
  if (c.tractionControl) parts.push(c.tcLevel > 0 ? `TC ${c.tcLevel}` : "Exit assist");
  if (c.abs) parts.push(`ABS ${c.absLevel}`);
  if (c.steeringAssist) parts.push("Steering assist");
  if (c.autoGearbox) parts.push("Auto gears");
  if (parts.length === 0) parts.push("No aids");
  parts.push(c.inputDevice[0].toUpperCase() + c.inputDevice.slice(1));
  parts.push(`${c.tyreCompound[0].toUpperCase()}${c.tyreCompound.slice(1)} tyres`);
  parts.push(c.wetness === "dry" ? "Dry" : c.wetness[0].toUpperCase() + c.wetness.slice(1));
  if (c.realism !== "full") parts.push(`${c.realism[0].toUpperCase()}${c.realism.slice(1)} realism`);
  return parts.join(" · ");
}
