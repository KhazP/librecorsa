/**
 * Portable car setup sharing: compact baseline-diff schema, `LC1-...` share codes, JSON export/import,
 * and strict validation/clamping so setups shared by other players or downloaded from leaderboards
 * can never hand the physics engine out-of-range or NaN values.
 *
 * Pure TypeScript (zero Three.js / DOM requirements in core encode/decode/parse functions), safe to
 * import from Cloudflare Workers, lap validation, and lightweight pages.
 */
import {
  axlePressures,
  foldVehicleModelId,
  isVehicleModelId,
  type AeroSetupPreset,
  type TireCompound,
  type TyreSetup,
  type VehicleModelId,
} from "@/types/f1";
import { text as t } from "@/lib/text";
import {
  ARB_DETACHED_PCT,
  CHASSIS_LIMITS,
  DEFAULT_CHASSIS_SETUP,
  wheelPressuresOf,
  type ChassisSetup,
  type GaragePreset,
  type GarageTuner,
} from "./car-setup";
import { clampChassisToCarSheet, clampTunerToCarSheet } from "./setup-sheet";

export const SHARE_CODE_PREFIX = "LC1-";
export const MAX_SHARED_SETUP_BYTES = 4096;
const MAX_SETUP_NAME_LEN = 40;

const VALID_COMPOUNDS: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];
const VALID_AERO: readonly AeroSetupPreset[] = ["low_downforce", "balanced", "high_downforce"];

const TUNER_BOUNDS: Readonly<Record<keyof GarageTuner, { min: number; max: number; step: number }>> = {
  tcLevel: { min: 0, max: 12, step: 1 },
  tc2Level: { min: 1, max: 12, step: 1 },
  tcSlipAngleLevel: { min: 0, max: 12, step: 1 },
  absLevel: { min: 0, max: 12, step: 1 },
  brakeBiasPct: { min: 45, max: 80, step: 0.1 },
  brakeMigrationPct: { min: 0, max: 6, step: 0.1 },
  diffEntry: { min: 1, max: 12, step: 1 },
  diffMid: { min: 1, max: 12, step: 1 },
  diffExit: { min: 1, max: 12, step: 1 },
  engineMap: { min: 1, max: 5, step: 1 },
  motorDeployKw: { min: 0, max: 500, step: 5 },
  regenKw: { min: 0, max: 500, step: 5 },
};

const AERO_LABELS = {
  low_downforce: "game.setupShare.aeroLow",
  balanced: "game.setupShare.aeroBalanced",
  high_downforce: "game.setupShare.aeroHigh",
} as const satisfies Readonly<Record<AeroSetupPreset, string>>;

const COMPOUND_LABELS = {
  soft: "game.setupShare.soft",
  medium: "game.setupShare.medium",
  hard: "game.setupShare.hard",
  intermediate: "game.setupShare.intermediate",
  wet: "game.setupShare.wet",
} as const satisfies Readonly<Record<TireCompound, string>>;

/** Portable v1 setup payload attached to recorded laps and encoded in `LC1-...` share codes */
export interface SharedCarSetup {
  v: 1;
  vehicle: VehicleModelId;
  name?: string;
  /** Only chassis offsets that differ from DEFAULT_CHASSIS_SETUP */
  chassis?: Partial<ChassisSetup>;
  tyre?: TyreSetup;
  compound?: TireCompound;
  aero?: AeroSetupPreset;
  tuner?: Partial<GarageTuner>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clampStep = (n: number, min: number, max: number, step: number): number =>
  Number(Math.max(min, Math.min(max, Math.round(n / step) * step)).toFixed(3));

/** Extracts a clean `GarageTuner` object from live telemetry or partial dials */
export function garageTunerFrom(
  src: Partial<Record<keyof GarageTuner, number | null | undefined>> | null | undefined,
): GarageTuner {
  if (!src) return {};
  const out: GarageTuner = {};
  for (const k of Object.keys(TUNER_BOUNDS) as (keyof GarageTuner)[]) {
    const v = src[k];
    if (isFiniteNum(v)) {
      const b = TUNER_BOUNDS[k];
      out[k] = clampStep(v, b.min, b.max, b.step);
    }
  }
  return out;
}

/** Builds a compact, validated `SharedCarSetup` keeping only non-default chassis fields within the car's sheet */
export function buildSharedSetup(input: {
  vehicle: VehicleModelId;
  name?: string;
  chassis?: Partial<ChassisSetup>;
  tyre?: TyreSetup;
  compound?: TireCompound;
  aero?: AeroSetupPreset;
  tuner?: Partial<GarageTuner>;
}): SharedCarSetup {
  const clamped = clampChassisToCarSheet(input.vehicle, input.chassis ?? {});
  const diff: Partial<ChassisSetup> = {};
  for (const k of Object.keys(CHASSIS_LIMITS) as (keyof ChassisSetup)[]) {
    if (clamped[k] !== DEFAULT_CHASSIS_SETUP[k]) diff[k] = clamped[k];
  }
  const cleanName = typeof input.name === "string" ? input.name.trim().slice(0, MAX_SETUP_NAME_LEN) : "";
  const clampedTuner = input.tuner ? clampTunerToCarSheet(input.vehicle, input.tuner) : undefined;
  const raw: SharedCarSetup = {
    v: 1,
    vehicle: input.vehicle,
    ...(cleanName ? { name: cleanName } : {}),
    ...(Object.keys(diff).length > 0 ? { chassis: diff } : {}),
    ...(input.tyre ? { tyre: input.tyre } : {}),
    ...(input.compound ? { compound: input.compound } : {}),
    ...(input.aero ? { aero: input.aero } : {}),
    ...(clampedTuner && Object.keys(clampedTuner).length > 0 ? { tuner: clampedTuner } : {}),
  };
  return parseSharedSetup(raw) ?? { v: 1, vehicle: input.vehicle };
}

/**
 * Strictly validates and clamps an untrusted shared setup (from a share code, JSON file, or uploaded lap)
 * against the car's exact setup sheet ranges. Also accepts a raw `GaragePreset` JSON object for `.json` import.
 */
export function parseSharedSetup(raw: unknown): SharedCarSetup | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== undefined && raw.v !== 1) return null;
  const folded = foldVehicleModelId(raw.vehicle);
  if (!isVehicleModelId(folded)) return null;

  const out: SharedCarSetup = { v: 1, vehicle: folded };

  if (typeof raw.name === "string") {
    const clean = raw.name
      .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\r\n\t]+/g, " ")
      .trim()
      .slice(0, MAX_SETUP_NAME_LEN);
    if (clean) out.name = clean;
  }

  if (raw.chassis !== undefined) {
    if (!isRecord(raw.chassis)) return null;
    const rawChassis: Partial<ChassisSetup> = {};
    for (const k of Object.keys(CHASSIS_LIMITS) as (keyof ChassisSetup)[]) {
      const rawVal = raw.chassis[k];
      if (rawVal === undefined) continue;
      if (!isFiniteNum(rawVal)) return null;
      rawChassis[k] = (k === "arbFrontPct" || k === "arbRearPct") && rawVal <= ARB_DETACHED_PCT ? ARB_DETACHED_PCT : rawVal;
    }
    const clamped = clampChassisToCarSheet(folded, rawChassis);
    const diff: Partial<ChassisSetup> = {};
    for (const k of Object.keys(CHASSIS_LIMITS) as (keyof ChassisSetup)[]) {
      if (clamped[k] !== DEFAULT_CHASSIS_SETUP[k]) diff[k] = clamped[k];
    }
    if (Object.keys(diff).length > 0) out.chassis = diff;
  }

  if (raw.tyre !== undefined) {
    if (!isRecord(raw.tyre)) return null;
    const p = wheelPressuresOf(raw.tyre.coldPressurePsi);
    const c = isRecord(raw.tyre.camberDeg) ? raw.tyre.camberDeg : null;
    if (!p || !c || !isFiniteNum(c.front) || !isFiniteNum(c.rear)) return null;
    out.tyre = {
      coldPressurePsi: {
        fl: clampStep(p.fl, 10, 50, 0.1),
        fr: clampStep(p.fr, 10, 50, 0.1),
        rl: clampStep(p.rl, 10, 50, 0.1),
        rr: clampStep(p.rr, 10, 50, 0.1),
      },
      camberDeg: {
        front: clampStep(c.front, -8, 2, 0.1),
        rear: clampStep(c.rear, -8, 2, 0.1),
      },
    };
  }

  if (raw.compound !== undefined) {
    if (typeof raw.compound !== "string" || !VALID_COMPOUNDS.includes(raw.compound as TireCompound)) return null;
    out.compound = raw.compound as TireCompound;
  }

  if (raw.aero !== undefined) {
    if (typeof raw.aero !== "string" || !VALID_AERO.includes(raw.aero as AeroSetupPreset)) return null;
    out.aero = raw.aero as AeroSetupPreset;
  }

  if (raw.tuner !== undefined) {
    if (!isRecord(raw.tuner)) return null;
    const rawTuner: Partial<GarageTuner> = {};
    for (const k of Object.keys(TUNER_BOUNDS) as (keyof GarageTuner)[]) {
      const val = raw.tuner[k];
      if (val === undefined) continue;
      if (!isFiniteNum(val)) return null;
      const b = TUNER_BOUNDS[k];
      rawTuner[k] = clampStep(val, b.min, b.max, b.step);
    }
    const clampedTuner = clampTunerToCarSheet(folded, rawTuner);
    if (Object.keys(clampedTuner).length > 0) out.tuner = clampedTuner;
  }

  // Enforce strict payload size cap so shared setups never bloat lap uploads or storage
  const json = JSON.stringify(out);
  if (json.length > MAX_SHARED_SETUP_BYTES) return null;
  return out;
}

/** UTF-8 safe base64url encoder that works in both browsers and Node/Workers */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(code: string): string | null {
  try {
    const padded = code.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((code.length + 3) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Encodes a `SharedCarSetup` as a portable `LC1-...` share code */
export function encodeSetupShareCode(setup: SharedCarSetup): string {
  const clean = parseSharedSetup(setup);
  if (!clean) throw new Error("Invalid setup");
  return `${SHARE_CODE_PREFIX}${toBase64Url(JSON.stringify(clean))}`;
}

/**
 * Decodes either an `LC1-...` share code OR raw JSON (SharedCarSetup / GaragePreset).
 * Returns null for invalid, truncated, or out-of-schema input.
 */
export function decodeSetupShareCode(input: string): SharedCarSetup | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_SHARED_SETUP_BYTES * 2) return null;

  // Raw JSON pasted or loaded from a .json file
  if (trimmed.startsWith("{")) {
    try {
      return parseSharedSetup(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }

  // Share code (`LC1-...`, forgiving surrounding whitespace/line wraps from chat apps)
  const compact = trimmed.replace(/\s+/g, "");
  if (!compact.startsWith(SHARE_CODE_PREFIX)) return null;
  const payload = compact.slice(SHARE_CODE_PREFIX.length);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const decoded = fromBase64Url(payload);
  if (!decoded || decoded.length > MAX_SHARED_SETUP_BYTES) return null;
  try {
    return parseSharedSetup(JSON.parse(decoded));
  } catch {
    return null;
  }
}

/**
 * Resolves a `SharedCarSetup` onto the player's current car, clamping every field to the target car's setup sheet.
 * Preserves the receiver's `fuelDeltaKg` (so applying a 5 kg time-trial setup never strands the player out of fuel
 * in a race) and keeps `currentTyre` when the shared setup omits a tyre section.
 */
export function resolveSetupForCar(
  shared: SharedCarSetup,
  targetVehicle: VehicleModelId,
  currentTyre: TyreSetup,
  clampTyre: (t: TyreSetup) => TyreSetup,
  currentCompound: TireCompound,
  currentAero: AeroSetupPreset,
  currentTuner: GarageTuner,
  preserveFuelDeltaKg?: number,
): {
  chassis: ChassisSetup;
  tyre: TyreSetup;
  compound: TireCompound;
  aero: AeroSetupPreset;
  tuner: GarageTuner;
  differentCar: boolean;
} {
  const rawChassis =
    preserveFuelDeltaKg !== undefined
      ? { ...(shared.chassis ?? {}), fuelDeltaKg: preserveFuelDeltaKg }
      : (shared.chassis ?? {});
  const chassis = clampChassisToCarSheet(targetVehicle, rawChassis);
  const rawTyre: TyreSetup = shared.tyre
    ? {
        coldPressurePsi: { ...shared.tyre.coldPressurePsi },
        camberDeg: { ...shared.tyre.camberDeg },
      }
    : {
        coldPressurePsi: { ...axlePressures(currentTyre.coldPressurePsi.fl, currentTyre.coldPressurePsi.rl), ...currentTyre.coldPressurePsi },
        camberDeg: { ...currentTyre.camberDeg },
      };
  const tyre = clampTyre(rawTyre);
  const compound = shared.compound && VALID_COMPOUNDS.includes(shared.compound) ? shared.compound : currentCompound;
  const aero = shared.aero && VALID_AERO.includes(shared.aero) ? shared.aero : currentAero;
  const tuner: GarageTuner = clampTunerToCarSheet(targetVehicle, { ...currentTuner, ...(shared.tuner ?? {}) });
  return {
    chassis,
    tyre,
    compound,
    aero,
    tuner,
    differentCar: shared.vehicle !== targetVehicle,
  };
}

/** Converts a `GaragePreset` into a portable `SharedCarSetup` */
export function presetToSharedSetup(preset: GaragePreset): SharedCarSetup {
  return buildSharedSetup({
    vehicle: preset.vehicle,
    name: preset.name,
    chassis: preset.chassis,
    tyre: preset.tyre,
    compound: preset.compound,
    aero: preset.aero,
    tuner: preset.tuner,
  });
}

/** Short human-readable summary of a shared setup for previews & toasts */
export function summarizeSharedSetup(setup: SharedCarSetup): string {
  const parts: string[] = [];
  if (setup.aero) parts.push(t(AERO_LABELS[setup.aero]));
  if (setup.compound) parts.push(t(COMPOUND_LABELS[setup.compound]));
  const chassisCount = setup.chassis ? Object.keys(setup.chassis).length : 0;
  if (chassisCount > 0) parts.push(t("game.setupShare.chassisChanges", { count: chassisCount }));
  if (setup.tuner?.brakeBiasPct !== undefined) parts.push(t("game.setupShare.brakeBias", { bias: setup.tuner.brakeBiasPct.toFixed(1) }));
  if (parts.length === 0) parts.push(t("game.setupShare.baseline"));
  return parts.join(" · ");
}

/** Downloads a shared setup as a `.json` file in the browser */
export function exportSetupFile(setup: SharedCarSetup, fallbackName = "setup"): void {
  try {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || fallbackName;
    const blob = new Blob([JSON.stringify(setup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `setup-${safe(setup.vehicle)}-${safe(setup.name ?? fallbackName)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Downloads unavailable
  }
}

/** Copies text to the clipboard with legacy fallback; returns true on success */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea copy
  }
  try {
    if (typeof document === "undefined") return false;
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.top = "0";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}
