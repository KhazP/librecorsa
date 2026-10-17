/**
 * The player's saved controls and driving preferences (localStorage, `bugesera.*` keys).
 * Everything is validated on load: a corrupt or partial save falls back field by field to the defaults.
 */
import type { AssistPreset, CameraMode } from "@/types/f1";
import {
  DEFAULT_KEY_BINDINGS,
  DEFAULT_PAD_BUTTONS,
  KEY_ACTIONS,
  PAD_ACTIONS,
  type KeyBindings,
  type PadButtonBindings,
} from "@/lib/input/bindings";
import {
  DEFAULT_WHEEL_SETTINGS,
  PAD_SENSITIVITY,
  type AxisBinding,
  type ButtonBinding,
  type InputDevice,
  type PadSensitivity,
  type PedalBinding,
  type WheelSettings,
} from "@/lib/input/device-input";

export interface PlayerSettings {
  device: InputDevice;
  keys: KeyBindings;
  padButtons: PadButtonBindings;
  padSensitivity: PadSensitivity;
  wheel: WheelSettings;
  assistPreset: AssistPreset;
  racingLine: boolean;
  gamepadAssist: boolean;
  mouseSteer: boolean;
  liveryId: string | null;
  camera: CameraMode | null;
  /**
   * Driver's-eye vertical FOV (degrees); null = the car's own. The other onboard cameras move by the same amount.
   */
  cockpitFovDeg: number | null;
}

export const SETTINGS_STORAGE_KEY = "bugesera.settings.v1";

/** Driver's-eye vertical FOV range (a calculated single-screen FOV is often near 30°) */
export const COCKPIT_FOV_MIN_DEG = 25;
export const COCKPIT_FOV_MAX_DEG = 90;
export const clampFov = (deg: number) => Math.min(COCKPIT_FOV_MAX_DEG, Math.max(COCKPIT_FOV_MIN_DEG, deg));
export const ONBOARDED_STORAGE_KEY = "bugesera.onboarded";

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  device: "keyboard",
  keys: DEFAULT_KEY_BINDINGS,
  padButtons: DEFAULT_PAD_BUTTONS,
  padSensitivity: "default",
  wheel: DEFAULT_WHEEL_SETTINGS,
  assistPreset: "semi_pro",
  racingLine: true,
  gamepadAssist: true,
  mouseSteer: false,
  liveryId: null,
  camera: null,
  cockpitFovDeg: null,
};

const CAMERA_MODES: readonly CameraMode[] = ["chase", "tv_pod", "cockpit_shoulder", "cockpit", "nose", "helicopter", "tv_side"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, lo: number, hi: number, fallback: number) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
const index = (v: unknown) => isNum(v) && Number.isInteger(v) && v >= 0 && v < 64;

function parseKeys(v: unknown): KeyBindings {
  if (!isObj(v)) return DEFAULT_KEY_BINDINGS;
  const out = { ...DEFAULT_KEY_BINDINGS };
  for (const { id } of KEY_ACTIONS) {
    const codes = v[id];
    if (Array.isArray(codes)) out[id] = codes.filter(isStr).slice(0, 4);
  }
  return out;
}

function parsePadButtons(v: unknown): PadButtonBindings {
  if (!isObj(v)) return DEFAULT_PAD_BUTTONS;
  const out = { ...DEFAULT_PAD_BUTTONS };
  for (const { id } of PAD_ACTIONS) {
    if (v[id] === null) out[id] = null;
    else if (index(v[id])) out[id] = v[id] as number;
  }
  return out;
}

function parseAxis(v: unknown): AxisBinding | null {
  if (!isObj(v) || !isStr(v.padId) || !index(v.axis)) return null;
  return { padId: v.padId, axis: v.axis as number, center: num(v.center, -1, 1, 0), invert: bool(v.invert, false) };
}

function parsePedal(v: unknown): PedalBinding | null {
  if (!isObj(v) || !isStr(v.padId) || !index(v.axis) || !isNum(v.idle) || !isNum(v.full)) return null;
  return { padId: v.padId, axis: v.axis as number, idle: num(v.idle, -1, 1, 0), full: num(v.full, -1, 1, 1) };
}

function parseButton(v: unknown): ButtonBinding | null {
  if (!isObj(v) || !isStr(v.padId) || !index(v.button)) return null;
  return { padId: v.padId, button: v.button as number };
}

function parseWheel(v: unknown): WheelSettings {
  const d = DEFAULT_WHEEL_SETTINGS;
  if (!isObj(v)) return d;
  const buttons = { ...d.buttons };
  if (isObj(v.buttons)) {
    for (const { id } of PAD_ACTIONS) buttons[id] = parseButton(v.buttons[id]);
  }
  return {
    type: oneOf(v.type, ["direct_drive", "belt_gear"] as const, d.type),
    rotationDeg: num(v.rotationDeg, 180, 2520, d.rotationDeg),
    steer: parseAxis(v.steer),
    throttle: parsePedal(v.throttle),
    brake: parsePedal(v.brake),
    brakeGamma: num(v.brakeGamma, 0.5, 3, d.brakeGamma),
    steerDeadzone: num(v.steerDeadzone, 0, 0.2, d.steerDeadzone),
    steerSmoothingS: num(v.steerSmoothingS, 0, 0.2, d.steerSmoothingS),
    ffbEnabled: bool(v.ffbEnabled, d.ffbEnabled),
    ffbGain: num(v.ffbGain, 0, 2, d.ffbGain),
    ffbMinForce: num(v.ffbMinForce, 0, 0.2, d.ffbMinForce),
    ffbKerb: num(v.ffbKerb, 0, 1, d.ffbKerb),
    ffbAbs: num(v.ffbAbs, 0, 1, d.ffbAbs),
    ffbInvert: bool(v.ffbInvert, d.ffbInvert),
    buttons,
  };
}

/** Validates a parsed save; unknown or invalid fields take their defaults */
export function parsePlayerSettings(raw: unknown): PlayerSettings {
  const d = DEFAULT_PLAYER_SETTINGS;
  if (!isObj(raw)) return d;
  return {
    device: oneOf(raw.device, ["keyboard", "controller", "wheel"] as const, d.device),
    keys: parseKeys(raw.keys),
    padButtons: parsePadButtons(raw.padButtons),
    padSensitivity: oneOf(raw.padSensitivity, Object.keys(PAD_SENSITIVITY) as PadSensitivity[], d.padSensitivity),
    wheel: parseWheel(raw.wheel),
    assistPreset: oneOf(raw.assistPreset, ["pro", "semi_pro", "assisted"] as const, d.assistPreset),
    racingLine: bool(raw.racingLine, d.racingLine),
    gamepadAssist: bool(raw.gamepadAssist, d.gamepadAssist),
    mouseSteer: bool(raw.mouseSteer, d.mouseSteer),
    liveryId: isStr(raw.liveryId) ? raw.liveryId : null,
    camera: CAMERA_MODES.includes(raw.camera as CameraMode) ? (raw.camera as CameraMode) : null,
    cockpitFovDeg:
      typeof raw.cockpitFovDeg === "number" && Number.isFinite(raw.cockpitFovDeg)
        ? Math.round(clampFov(raw.cockpitFovDeg))
        : null,
  };
}

export function loadPlayerSettings(): PlayerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? parsePlayerSettings(JSON.parse(raw)) : DEFAULT_PLAYER_SETTINGS;
  } catch {
    // Storage unavailable or corrupt JSON: defaults
    return DEFAULT_PLAYER_SETTINGS;
  }
}

export function savePlayerSettings(settings: PlayerSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: the settings last for this session only
  }
}

export function loadOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable: the setup shows again next visit
  }
}
