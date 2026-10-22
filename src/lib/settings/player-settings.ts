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
import { AI_SKILL_DEFAULT } from "@/lib/sim/ai-tuning";
import { SIM_REALISM_LEVELS, type SimRealism } from "@/lib/sim/sim-realism";
import { DEFAULT_SESSION_CONDITIONS, sanitizeConditions, type SessionConditions } from "@/lib/sim/weather";

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
  /** Controller stick / trigger shaping (the sensitivity presets fill in its rate and dead zone) */
  padTuning: PadTuning;
  /** Keyboard pedal / steering ramps and the half-throttle key */
  keyboardTuning: KeyboardTuning;
  hud: HudSettings;
  graphics: GraphicsSettings;
  touch: TouchSettings;
  /** Name, three-letter code and colour other players see */
  profile: DriverProfile;
  /** Race the ghost of the personal-best lap for this circuit and car */
  ghost: boolean;
  /** AI opponents' skill, 0 (Rookie) to 100 (Alien); 70 = Pro */
  aiSkill: number;
  /** Simulation realism: tyre wear, temperature grip, fuel use and how hard rain bites (Full = the whole model) */
  realism: SimRealism;
  /** Weather, time of day and time multiplier for offline sessions (the host's apply online) */
  conditions: SessionConditions;
}

export interface PadTuning {
  /** Stick smoothing rate multiplier of the steering assist (higher = quicker) */
  steeringRate: number;
  /** Inner stick dead zone (0..0.3) */
  deadzone: number;
  /** Outer dead zone: stick travel past 1 − this reads as full (0..0.3) */
  outerDeadzone: number;
  /** Stick response curve: 1 linear, > 1 finer near centre (0.5..3) */
  linearity: number;
  /** Trigger response curves: 1 linear, > 1 finer at light pressure (0.5..3) */
  throttleGamma: number;
  brakeGamma: number;
  /** Impulse-trigger rumble (Xbox): ABS in LT, wheelspin in RT */
  triggerRumble: boolean;
}

export interface KeyboardTuning {
  /** Pedal ramp times 0 → 1 (s) */
  throttleRiseS: number;
  brakeRiseS: number;
  /** Steering ramp to the speed limit and back to centre (s) */
  steerRiseS: number;
  steerReturnS: number;
  /** Throttle while the half-throttle key is held with throttle (0.2..0.9) */
  halfThrottle: number;
  /** Eases the throttle in on corner exit while the rear tyres are near their slip limit */
  exitAssist: boolean;
}

/**
 * In-race HUD style: Broadcast (TV graphics), Wheel Dash (steering-wheel screen), Telemetry (the dash
 * plus tyres, channels and inputs), or the earlier Classic layout and its Minimal cut.
 */
export type HudPreset = "broadcast" | "dash" | "telemetry" | "classic" | "minimal";
export const HUD_PRESETS: readonly HudPreset[] = ["broadcast", "dash", "telemetry", "classic", "minimal"];

export interface HudSettings {
  preset: HudPreset;
  /** Overall HUD size (0.75..1.5) */
  scale: number;
  /** Rolling throttle / brake / steering trace */
  inputTrace: boolean;
  /** Live delta bar against the best lap */
  deltaBar: boolean;
  /** Card with sectors, corner speeds and the theoretical best after every lap */
  lapSummary: boolean;
  /** HUD rear-view mirror: auto = onboard views without wing mirrors on screen */
  virtualMirror: VirtualMirrorMode;
  /** Timing tower gaps: to the car ahead (interval) or to the leader */
  towerGaps: "interval" | "leader";
  /** Circuit map: the whole lap, or a zoomed heading-up map around the car */
  mapMode: "full" | "local";
  /** Proximity radar: fades in when a car is alongside or close behind */
  radar: boolean;
  /** Race split gaps: time to the cars directly ahead and behind */
  splitGaps: boolean;
  /** The MFD folds to its status pill after a few seconds without input */
  mfdAutoCollapse: boolean;
  /** Cockpit beeps: DRS available (two tones) and DRS open (chime) */
  drsBeep: boolean;
  /** Short beep 150 rpm before the rev limiter */
  shiftBeep: boolean;
  /** Onboard camera turns gently into the car's direction of travel (feel the rear slide) */
  neckFx: boolean;
}

export type VirtualMirrorMode = "auto" | "always" | "off";

export type GraphicsQuality = "low" | "medium" | "high";

export interface GraphicsSettings {
  quality: GraphicsQuality;
  /** Render resolution relative to the screen (0.5..1.5) */
  renderScale: number;
}

export type TouchMode = "auto" | "on" | "off";

export interface TouchSettings {
  /** On-screen pedals and steering: auto shows them on touch screens */
  mode: TouchMode;
  /** Steer by tilting the device instead of the on-screen slider */
  tiltSteer: boolean;
  /** Tilt angle for full lock (degrees, 10..60) */
  tiltRangeDeg: number;
}

export interface DriverProfile {
  name: string;
  /** Three letters, upper case */
  code: string;
  /** #RRGGBB */
  color: string;
  /** The game picked the name (first run): the first leaderboard upload asks the player to keep or change it */
  generated: boolean;
}

export const DEFAULT_PAD_TUNING: PadTuning = {
  steeringRate: PAD_SENSITIVITY.default.steeringRate,
  deadzone: PAD_SENSITIVITY.default.deadzone,
  outerDeadzone: 0.02,
  linearity: 1,
  throttleGamma: 1,
  brakeGamma: 1,
  triggerRumble: true,
};

export const DEFAULT_KEYBOARD_TUNING: KeyboardTuning = {
  throttleRiseS: 0.25,
  brakeRiseS: 0.17,
  steerRiseS: 0.22,
  steerReturnS: 0.14,
  halfThrottle: 0.5,
  exitAssist: true,
};

export const DEFAULT_HUD_SETTINGS: HudSettings = {
  preset: "broadcast",
  scale: 1,
  inputTrace: false,
  deltaBar: true,
  lapSummary: true,
  virtualMirror: "auto",
  towerGaps: "interval",
  mapMode: "full",
  radar: true,
  splitGaps: true,
  mfdAutoCollapse: true,
  drsBeep: true,
  shiftBeep: false,
  neckFx: true,
};

export const DEFAULT_GRAPHICS_SETTINGS: GraphicsSettings = { quality: "high", renderScale: 1 };

export const DEFAULT_TOUCH_SETTINGS: TouchSettings = { mode: "auto", tiltSteer: false, tiltRangeDeg: 30 };

export const DEFAULT_DRIVER_PROFILE: DriverProfile = { name: "Driver", code: "DRV", color: "#E10600", generated: false };

/** Words for generated names; any pair plus " 99" fits the 16-character name limit */
const NAME_WORDS = [
  ["Apex", "Late", "Slick", "Turbo", "Rapid", "Swift", "Bold", "Wild", "Lucky", "Iron", "Neon", "Volt", "Prime", "Sharp", "Clean", "Flat"],
  ["Falcon", "Comet", "Viper", "Arrow", "Lynx", "Hornet", "Raven", "Mako", "Puma", "Bolt", "Racer", "Pilot", "Fox", "Hawk", "Orca", "Wasp"],
] as const;

/**
 * A readable random driver ("Apex Falcon 27", code FAL) so new players never share the default
 * "Driver" on the leaderboard, where a taken name is refused.
 */
export function randomDriverProfile(rand: () => number = Math.random): DriverProfile {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const noun = pick(NAME_WORDS[1]);
  const name = `${pick(NAME_WORDS[0])} ${noun} ${10 + Math.floor(rand() * 90)}`;
  return { ...DEFAULT_DRIVER_PROFILE, name, code: sanitizeDriverCode(noun), generated: true };
}

/** Code for a name the player typed: its first three letters (or the default code's to fill in) */
export const codeFromName = (name: string) => sanitizeDriverCode(name);

/** Three upper-case letters from any input ("" → the default code) */
export const sanitizeDriverCode = (v: string) => {
  const letters = v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  return letters.length === 3 ? letters : (letters + DEFAULT_DRIVER_PROFILE.code).slice(0, 3);
};
/** Printable name of at most 16 characters */
export const sanitizeDriverName = (v: string) =>
  v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 16) || DEFAULT_DRIVER_PROFILE.name;
export const sanitizeColor = (v: string) => (/^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : DEFAULT_DRIVER_PROFILE.color);

export const SETTINGS_STORAGE_KEY = "bugesera.settings.v1";
/** Set once the force direction was flipped to match DirectInput / PID: an older save's `ffbInvert: true` is reset once */
export const FFB_POLARITY_V2_KEY = "bugesera.ffb_polarity_v2";

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
  padTuning: DEFAULT_PAD_TUNING,
  keyboardTuning: DEFAULT_KEYBOARD_TUNING,
  hud: DEFAULT_HUD_SETTINGS,
  graphics: DEFAULT_GRAPHICS_SETTINGS,
  touch: DEFAULT_TOUCH_SETTINGS,
  profile: DEFAULT_DRIVER_PROFILE,
  ghost: true,
  aiSkill: AI_SKILL_DEFAULT,
  realism: "full",
  conditions: DEFAULT_SESSION_CONDITIONS,
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
    ffbDamping: num(v.ffbDamping, 0, 1, d.ffbDamping),
    ffbFilterS: num(v.ffbFilterS, 0, 0.05, d.ffbFilterS),
    ffbPerCar: parsePerCarFfb(v.ffbPerCar),
    hidFfb: bool(v.hidFfb, d.hidFfb),
    telemetryOut: bool(v.telemetryOut, d.telemetryOut),
    telemetryPort: Math.round(num(v.telemetryPort, 1024, 65535, d.telemetryPort)),
    buttons,
  };
}

function parsePerCarFfb(v: unknown): WheelSettings["ffbPerCar"] {
  const out: WheelSettings["ffbPerCar"] = {};
  if (!isObj(v)) return out;
  for (const [car, entry] of Object.entries(v).slice(0, 16)) {
    if (isObj(entry) && isNum(entry.gain) && isNum(entry.minForce)) {
      out[car.slice(0, 32)] = { gain: num(entry.gain, 0, 2, 1), minForce: num(entry.minForce, 0, 0.2, 0) };
    }
  }
  return out;
}

function parsePadTuning(v: unknown): PadTuning {
  const d = DEFAULT_PAD_TUNING;
  if (!isObj(v)) return d;
  return {
    steeringRate: num(v.steeringRate, 0.1, 1.5, d.steeringRate),
    deadzone: num(v.deadzone, 0, 0.3, d.deadzone),
    outerDeadzone: num(v.outerDeadzone, 0, 0.3, d.outerDeadzone),
    linearity: num(v.linearity, 0.5, 3, d.linearity),
    throttleGamma: num(v.throttleGamma, 0.5, 3, d.throttleGamma),
    brakeGamma: num(v.brakeGamma, 0.5, 3, d.brakeGamma),
    triggerRumble: bool(v.triggerRumble, d.triggerRumble),
  };
}

function parseKeyboardTuning(v: unknown): KeyboardTuning {
  const d = DEFAULT_KEYBOARD_TUNING;
  if (!isObj(v)) return d;
  return {
    throttleRiseS: num(v.throttleRiseS, 0, 1, d.throttleRiseS),
    brakeRiseS: num(v.brakeRiseS, 0, 1, d.brakeRiseS),
    steerRiseS: num(v.steerRiseS, 0.05, 1, d.steerRiseS),
    steerReturnS: num(v.steerReturnS, 0.05, 1, d.steerReturnS),
    halfThrottle: num(v.halfThrottle, 0.2, 0.9, d.halfThrottle),
    exitAssist: bool(v.exitAssist, d.exitAssist),
  };
}

function parseHud(v: unknown): HudSettings {
  const d = DEFAULT_HUD_SETTINGS;
  if (!isObj(v)) return d;
  return {
    // Older saves: "full" (the old default) moves to the new default, "engineer" to Telemetry
    preset: v.preset === "engineer" ? "telemetry" : oneOf(v.preset, HUD_PRESETS, d.preset),
    scale: num(v.scale, 0.75, 1.5, d.scale),
    inputTrace: bool(v.inputTrace, d.inputTrace),
    deltaBar: bool(v.deltaBar, d.deltaBar),
    lapSummary: bool(v.lapSummary, d.lapSummary),
    virtualMirror: oneOf(v.virtualMirror, ["auto", "always", "off"] as const, d.virtualMirror),
    towerGaps: oneOf(v.towerGaps, ["interval", "leader"] as const, d.towerGaps),
    mapMode: oneOf(v.mapMode, ["full", "local"] as const, d.mapMode),
    radar: bool(v.radar, d.radar),
    splitGaps: bool(v.splitGaps, d.splitGaps),
    mfdAutoCollapse: bool(v.mfdAutoCollapse, d.mfdAutoCollapse),
    drsBeep: bool(v.drsBeep, d.drsBeep),
    shiftBeep: bool(v.shiftBeep, d.shiftBeep),
    neckFx: bool(v.neckFx, d.neckFx),
  };
}

function parseGraphics(v: unknown): GraphicsSettings {
  const d = DEFAULT_GRAPHICS_SETTINGS;
  if (!isObj(v)) return d;
  return {
    quality: oneOf(v.quality, ["low", "medium", "high"] as const, d.quality),
    renderScale: num(v.renderScale, 0.5, 1.5, d.renderScale),
  };
}

function parseTouch(v: unknown): TouchSettings {
  const d = DEFAULT_TOUCH_SETTINGS;
  if (!isObj(v)) return d;
  return {
    mode: oneOf(v.mode, ["auto", "on", "off"] as const, d.mode),
    tiltSteer: bool(v.tiltSteer, d.tiltSteer),
    tiltRangeDeg: num(v.tiltRangeDeg, 10, 60, d.tiltRangeDeg),
  };
}

function parseProfile(v: unknown): DriverProfile {
  if (!isObj(v)) return DEFAULT_DRIVER_PROFILE;
  return {
    name: sanitizeDriverName(isStr(v.name) ? v.name : ""),
    code: sanitizeDriverCode(isStr(v.code) ? v.code : ""),
    color: sanitizeColor(isStr(v.color) ? v.color : ""),
    generated: bool(v.generated, false),
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
    padTuning: isObj(raw.padTuning)
      ? parsePadTuning(raw.padTuning)
      : // Older saves only have the preset: start the tuning from it
        {
          ...DEFAULT_PAD_TUNING,
          steeringRate: PAD_SENSITIVITY[oneOf(raw.padSensitivity, Object.keys(PAD_SENSITIVITY) as PadSensitivity[], d.padSensitivity)].steeringRate,
          deadzone: PAD_SENSITIVITY[oneOf(raw.padSensitivity, Object.keys(PAD_SENSITIVITY) as PadSensitivity[], d.padSensitivity)].deadzone,
        },
    keyboardTuning: parseKeyboardTuning(raw.keyboardTuning),
    hud: parseHud(raw.hud),
    graphics: parseGraphics(raw.graphics),
    touch: parseTouch(raw.touch),
    profile: parseProfile(raw.profile),
    ghost: bool(raw.ghost, d.ghost),
    aiSkill: Math.round(num(raw.aiSkill, 0, 100, d.aiSkill)),
    realism: oneOf(raw.realism, SIM_REALISM_LEVELS, d.realism),
    conditions: sanitizeConditions(raw.conditions),
  };
}

export function loadPlayerSettings(): PlayerSettings {
  let settings = DEFAULT_PLAYER_SETTINGS;
  let rawProfile: unknown = undefined;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const polarityV2 = localStorage.getItem(FFB_POLARITY_V2_KEY) === "1";
    if (raw) {
      const json: unknown = JSON.parse(raw);
      rawProfile = isObj(json) ? json.profile : undefined;
      settings = parsePlayerSettings(json);
      if (!polarityV2 && settings.wheel.ffbInvert) {
        settings = { ...settings, wheel: { ...settings.wheel, ffbInvert: false } };
      }
    }
    if (!polarityV2) localStorage.setItem(FFB_POLARITY_V2_KEY, "1");
  } catch {
    // Storage unavailable or corrupt JSON: defaults
  }
  // First run, or a save from before generated names that still has the shared default: a name of its own.
  // A save that records `generated` keeps whatever it has, even a player who chose "Driver".
  const untouched = !isObj(rawProfile) || (rawProfile.generated === undefined && settings.profile.name === DEFAULT_DRIVER_PROFILE.name);
  if (untouched) {
    const fresh = randomDriverProfile();
    const p = settings.profile;
    settings = {
      ...settings,
      profile: { ...fresh, code: p.code === DEFAULT_DRIVER_PROFILE.code ? fresh.code : p.code, color: p.color },
    };
  }
  return settings;
}

export function savePlayerSettings(settings: PlayerSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    localStorage.setItem(FFB_POLARITY_V2_KEY, "1");
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
