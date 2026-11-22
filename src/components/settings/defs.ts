import { keyLabel, PAD_PEDALS, pedalsOnTriggers } from "@/lib/input/bindings";
import { PAD_SENSITIVITY } from "@/lib/input/device-input";
import { isTouchDevice, requestTiltPermission } from "@/lib/input/touch-input";
import { CAMERA_MODES, DRIVING_CAMERA_MODES } from "@/lib/render/camera-modes";
import {
  COCKPIT_FOV_MAX_DEG,
  COCKPIT_FOV_MIN_DEG,
  DEFAULT_PLAYER_SETTINGS,
  defaultPlayerSettings,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type PlayerSettings,
} from "@/lib/settings/player-settings";
import { RACE_START_MODE_HINTS, RACE_START_MODE_LABELS, RACE_START_MODES, type RaceStartMode } from "@/lib/sim/race-start";
import { SIM_REALISM_LABELS, SIM_REALISM_LEVELS } from "@/lib/sim/sim-realism";
import { ASSIST_SLIDERS, type AssistSliderSpec } from "@/lib/sim/steering-assist";
import type { AssistPreset } from "@/types/f1";
import { MUSIC_TRACKS, type MusicPool } from "@/lib/audio/music-catalog";
import type { SettingsEnv } from "./env";
import {
  audio,
  choice,
  graphics,
  hud,
  kb,
  lens,
  pad,
  pct,
  pctOrOff,
  profile,
  slider,
  toggle,
  top,
  touch,
  wheel,
  type RowDef,
} from "./fields";

/**
 * Every plain setting (a switch, a slider, a choice) with its one label, hint and default, as settings-tree.md
 * names them. Rows that need their own drawing (key bindings, calibration, the driver's colour) live with their pane.
 */

const key = (env: SettingsEnv, action: keyof PlayerSettings["keys"]) => keyLabel(env.settings.keys[action][0]);
const ms = (v: number) => `${Math.round(v * 1000)} ms`;
const curve = (v: number, digits = 2) =>
  Math.abs(v - 1) < 0.025 ? "Linear" : v > 1 ? `Progressive ${v.toFixed(digits)}` : `Aggressive ${v.toFixed(digits)}`;
const ui = <K extends keyof PlayerSettings["ui"]>(k: K) =>
  lens<PlayerSettings["ui"][K]>((s) => s.ui[k], (s, v) => ({ ...s, ui: { ...s.ui, [k]: v } }));
const units = <K extends keyof PlayerSettings["ui"]["units"]>(k: K) =>
  lens<PlayerSettings["ui"]["units"][K]>(
    (s) => s.ui.units[k],
    (s, v) => ({ ...s, ui: { ...s.ui, units: { ...s.ui.units, [k]: v } } }),
  );

// ---- Driving > Assists

export type AssistLevel = "beginner" | "intermediate" | "sim";

export const ASSIST_LEVELS: readonly { id: AssistLevel; label: string; detail: string; preset: AssistPreset; racingLine: boolean }[] = [
  { id: "beginner", label: "Beginner", detail: "Full TC & ABS, racing line, steering assist", preset: "assisted", racingLine: true },
  { id: "intermediate", label: "Intermediate", detail: "TC & ABS, racing line", preset: "semi_pro", racingLine: true },
  { id: "sim", label: "Sim", detail: "No TC, no ABS, no racing line", preset: "pro", racingLine: false },
];

const levelOf = (preset: AssistPreset): AssistLevel => (preset === "assisted" ? "beginner" : preset === "pro" ? "sim" : "intermediate");

export const assistLevel = choice("tiles", {
  id: "assistLevel",
  label: "Assist level",
  options: ASSIST_LEVELS,
  read: (env) => levelOf(env.settings.assistPreset),
  write: (env, id) => {
    const level = ASSIST_LEVELS.find((l) => l.id === id) ?? ASSIST_LEVELS[1];
    env.update((s) => ({
      ...s,
      assistPreset: level.preset,
      racingLine: level.racingLine,
      // Beginner and Intermediate keep auto-clutch on so players don't stall unexpectedly; Sim leaves it as set
      autoClutch: level.id === "sim" ? s.autoClutch : true,
      // Beginners on a controller get its steering assist too
      gamepadAssist: level.id === "beginner" && s.device === "controller" ? true : s.gamepadAssist,
    }));
  },
  initial: () => levelOf(DEFAULT_PLAYER_SETTINGS.assistPreset),
});

export const tcAbs = choice("segmented", {
  id: "assistPreset",
  label: "Traction control & ABS",
  options: [
    { id: "pro", label: "Off" },
    { id: "semi_pro", label: "TC + ABS" },
    { id: "assisted", label: "Full" },
  ],
  ...top("assistPreset"),
});

export const racingLine = toggle({
  id: "racingLine",
  label: "Racing line",
  hint: (env) => `Key ${key(env, "racingLine")}`,
  ...top("racingLine"),
});

export const autoGearbox = toggle({
  id: "autoGearbox",
  label: "Automatic gearbox",
  hint: (env) => `Manual keys: ${key(env, "shiftUp")} / ${key(env, "shiftDown")}`,
  ...top("autoGearbox"),
});

function autoClutchBlockReason(s: PlayerSettings): string | null {
  if (s.autoGearbox) return "Requires manual gearbox";
  if (s.device === "wheel") return s.wheel.clutch !== null ? null : "Bind clutch under Controls > Wheel";
  if (s.device === "controller") return s.padTuning.pedalSources.clutch !== null ? null : "Bind clutch under Controls > Controller";
  const touchActive = s.touch.mode === "on" || (s.touch.mode === "auto" && isTouchDevice());
  if (touchActive) return "Unavailable with touch controls";
  return s.keys.clutch.length > 0 ? null : "Bind Clutch under Controls > Keyboard";
}

export const autoClutch = toggle({
  id: "autoClutch",
  label: "Auto clutch",
  hint: (env) => {
    const reason = autoClutchBlockReason(env.settings);
    if (!env.settings.autoClutch && reason) {
      return `Temporarily overridden (${reason.toLowerCase()}); turn on to restore default`;
    }
    return "Prevents stalling; disable for manual clutch launches";
  },
  // Only block switching auto clutch OFF when no manual clutch is usable; if already off, keep it clickable so players can turn it back on or reset it
  off: (env) => (env.settings.autoClutch ? autoClutchBlockReason(env.settings) : null),
  ...top("autoClutch"),
});

export const controllerSteerAssist = toggle({
  id: "gamepadAssist",
  label: "Controller steering assist",
  hint: "Limits lock to front tyre grip and catches slides",
  ...top("gamepadAssist"),
});

export const throttleHelp = toggle({
  id: "exitAssist",
  label: "Throttle help",
  hint: "Modulates throttle on rear slip (keyboard, TC off)",
  ...kb("exitAssist"),
});

export const brakeHelp = toggle({
  id: "brakeAssist",
  label: "Brake help",
  hint: "Modulates brake on lock-up (keyboard, ABS off)",
  ...kb("brakeAssist"),
});

export const realism = choice("segmented", {
  id: "realism",
  label: "Simulation realism",
  hint: (env) => SIM_REALISM_LABELS[env.settings.realism].detail,
  options: SIM_REALISM_LEVELS.map((id) => ({ id, label: SIM_REALISM_LABELS[id].label })),
  ...top("realism"),
});

/** A standing start's launch, kept with the race setup: the pre-race rules show the same choice */
export const launch = choice("segmented", {
  id: "launch",
  label: "Launch",
  hint: (env) => RACE_START_MODE_HINTS[env.settings.race.launch],
  options: RACE_START_MODES.map((id) => ({ id, label: RACE_START_MODE_LABELS[id] })),
  read: (env) => env.settings.race.launch,
  initial: () => DEFAULT_PLAYER_SETTINGS.race.launch,
  write: (env, id) => env.update((s) => ({ ...s, race: { ...s.race, launch: id as RaceStartMode } })),
});

export const ghost = toggle({
  id: "ghost",
  label: "Best-lap ghost",
  ...top("ghost"),
});

// ---- Driving > Steering help

/** A device's steering assist sliders; the countersteer cap stops at the current car's lock */
export function assistSliders(device: "keyboard" | "controller"): RowDef[] {
  const field = device === "keyboard" ? kb : pad;
  return ASSIST_SLIDERS.map((spec: AssistSliderSpec) => {
    const lockMax = (env: SettingsEnv) =>
      spec.key === "maxSelfSteerAngleDeg" && env.steerLockDeg !== undefined
        ? Math.max(spec.min, Math.min(spec.max, Math.floor(env.steerLockDeg)))
        : spec.max;
    return slider({
      id: `${device}-${spec.key}`,
      label: spec.label,
      hint: spec.hint,
      advanced: true,
      min: spec.min,
      max: lockMax,
      step: spec.step,
      format: (v, env) => (spec.key === "maxSelfSteerAngleDeg" && v >= lockMax(env) && env.steerLockDeg !== undefined ? `${spec.format(v)}, full lock` : spec.format(v)),
      ...field(spec.key),
    });
  });
}

export const pedalHelpStrength = slider({
  id: "pedalAssistStrength",
  label: "Pedal help strength",
  hint: "How early and how far Throttle help and Brake help ease the keys back",
  advanced: true,
  min: 0,
  max: 1,
  step: 0.05,
  format: pct,
  ...kb("pedalAssistStrength"),
});

// ---- Controls > Keyboard

export const mouseSteer = toggle({
  id: "mouseSteer",
  label: "Mouse steering",
  hint: (env) => `Key ${key(env, "mouseSteer")}`,
  ...top("mouseSteer"),
});

export const keyboardFeel: RowDef[] = [
  slider({ id: "throttleRiseS", label: "Throttle rise", advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("throttleRiseS") }),
  slider({ id: "brakeRiseS", label: "Brake rise", advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("brakeRiseS") }),
  slider({
    id: "steerRiseS",
    label: "Steering smoothing",
    hint: "Lower is sharper",
    advanced: true,
    min: 0.05,
    max: 1,
    step: 0.01,
    format: ms,
    ...kb("steerRiseS"),
  }),
  slider({ id: "steerReturnS", label: "Steering return", advanced: true, min: 0.05, max: 1, step: 0.01, format: ms, ...kb("steerReturnS") }),
  slider({ id: "halfThrottle", label: "Half throttle", advanced: true, min: 0.2, max: 0.9, step: 0.01, format: pct, ...kb("halfThrottle") }),
  slider({ id: "halfBrake", label: "Half brake", advanced: true, min: 0.2, max: 0.9, step: 0.01, format: pct, ...kb("halfBrake") }),
];

// ---- Controls > Controller

export const vibration = toggle({
  id: "rumble",
  label: "Vibration",
  read: (env) => env.rumble,
  write: (env, on) => {
    if (on !== env.rumble) env.onToggleRumble();
  },
  initial: () => true,
});

/** Steering speed and the inner dead zone start from the chosen steering feel */
const feel = (env: SettingsEnv) => PAD_SENSITIVITY[env.settings.padSensitivity];

/** With the pedals off the triggers (stick pedals), the triggers shift gears: nothing pulses in them */
export const needsTriggerPedals = (env: SettingsEnv) =>
  pedalsOnTriggers(env.settings.padTuning.pedalSources) ? null : "Requires trigger pedals";
const onStick = (env: SettingsEnv) => PAD_PEDALS.some((p) => env.settings.padTuning.pedalSources[p]?.kind === "axis");

export const controllerFineTuning: RowDef[] = [
  slider({
    id: "steeringRate",
    label: "Steering speed",
    advanced: true,
    min: 0.1,
    max: 1.5,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}x`,
    ...pad("steeringRate"),
    initial: (env) => feel(env).steeringRate,
  }),
  slider({
    id: "deadzone",
    label: "Inner dead zone",
    advanced: true,
    min: 0,
    max: 0.3,
    step: 0.01,
    format: pct,
    ...pad("deadzone"),
    initial: (env) => feel(env).deadzone,
  }),
  slider({ id: "outerDeadzone", label: "Outer dead zone", advanced: true, min: 0, max: 0.3, step: 0.01, format: pct, ...pad("outerDeadzone") }),
  slider({
    id: "linearity",
    label: "Stick linearity",
    hint: "Above 1 softens centre",
    advanced: true,
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => (Math.abs(v - 1) < 0.025 ? "Linear" : v.toFixed(2)),
    ...pad("linearity"),
  }),
  slider({ id: "throttleGamma", label: "Throttle curve", hint: "Above 1 softens low input", advanced: true, min: 0.5, max: 3, step: 0.05, format: (v) => curve(v), ...pad("throttleGamma") }),
  slider({ id: "brakeGamma", label: "Brake curve", hint: "Above 1 softens light braking", advanced: true, min: 0.5, max: 3, step: 0.05, format: (v) => curve(v), ...pad("brakeGamma") }),
  slider({
    id: "stickPedalDeadzone",
    label: "Pedal stick dead zone",
    advanced: true,
    min: 0,
    max: 0.3,
    step: 0.01,
    format: pct,
    off: (env) => (onStick(env) ? null : "Requires stick pedals"),
    ...pad("stickPedalDeadzone"),
  }),
];

export const triggerRumble = toggle({
  id: "triggerRumble",
  label: "Trigger rumble",
  hint: "Slip, ABS and wheelspin feedback in triggers",
  advanced: true,
  off: needsTriggerPedals,
  ...pad("triggerRumble"),
});

export const triggerSlip = toggle({
  id: "triggerSlipAlwaysOn",
  label: "Trigger slip with ABS/TC on",
  advanced: true,
  off: (env) => needsTriggerPedals(env) ?? (env.settings.padTuning.triggerRumble ? null : "Requires Trigger rumble"),
  ...pad("triggerSlipAlwaysOn"),
});

// ---- Controls > Wheel

export const wheelSteerFilters: RowDef[] = [
  slider({
    id: "steerDeadzone",
    label: "Centre dead zone",
    advanced: true,
    min: 0,
    max: 0.1,
    step: 0.005,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    ...wheel("steerDeadzone"),
  }),
  slider({
    id: "steerSmoothingS",
    label: "Input filter",
    advanced: true,
    min: 0,
    max: 0.08,
    step: 0.005,
    format: (v) => (v <= 0 ? "Off" : ms(v)),
    ...wheel("steerSmoothingS"),
  }),
];

export const wheelBrakeCurve = slider({
  id: "wheelBrakeGamma",
  label: "Brake curve",
  hint: "1.0 for load cell · 1.3 to 1.6 for potentiometers",
  advanced: true,
  min: 0.5,
  max: 2.5,
  step: 0.1,
  format: (v) => curve(v, 1),
  ...wheel("brakeGamma"),
});

// ---- Controls > Touch

const noTouch = () => (isTouchDevice() ? null : "Requires a touch screen");

export const touchMode = choice("segmented", {
  id: "touchMode",
  label: "Touch controls",
  options: [
    { id: "auto", label: "Auto" },
    { id: "on", label: "On" },
    { id: "off", label: "Off" },
  ],
  ...touch("mode"),
});

export const touchLayout = choice("segmented", {
  id: "touchLayout",
  label: "Touch style",
  hint: "Analogue drag sliders or digital buttons",
  off: (env) => (env.settings.touch.mode === "off" ? "Touch controls are off" : null),
  options: [
    { id: "sliders", label: "Sliders" },
    { id: "buttons", label: "Buttons" },
  ],
  ...touch("layout"),
});

const tiltSteerLens = touch("tiltSteer");

export const tiltSteer = toggle({
  id: "tiltSteer",
  label: "Tilt to steer",
  off: noTouch,
  ...tiltSteerLens,
  // iOS sends tilt only once the player allows it, and shows its prompt only to a request made inside a tap: this
  // switch's tap is one, so the prompt comes as tilt is turned on (as it does in the setup's Tilt choice). Refused,
  // the touch controls fall back to the slider and offer a retry on track.
  write: (env, on) => {
    if (on) void requestTiltPermission();
    tiltSteerLens.write(env, on);
  },
});

export const tiltRange = slider({
  id: "tiltRangeDeg",
  label: "Tilt range",
  off: (env) => noTouch() ?? (env.settings.touch.tiltSteer ? null : "Requires Tilt to steer"),
  min: 10,
  max: 60,
  step: 1,
  format: (v) => `${Math.round(v)}°`,
  ...touch("tiltRangeDeg"),
});

// ---- Force feedback

const fx = (id: keyof PlayerSettings["wheel"], label: string, hint?: string, step = 5): RowDef =>
  slider({ id, label, hint, advanced: true, min: 0, max: 1, step: step / 100, format: pctOrOff, ...wheel(id as "ffbKerb") });

export const ffbOn = toggle({ id: "ffbEnabled", label: "Force feedback", ...wheel("ffbEnabled") });

export const ffbStrength = slider({
  id: "ffbGain",
  label: "Strength",
  hint: (env) => {
    const own = env.settings.wheel.ffbPerCar?.[env.vehicleModel];
    return own ? `Overridden by per-car gain (${pct(own.gain)}) below` : undefined;
  },
  min: 0,
  max: 2,
  step: 0.05,
  format: pct,
  mark: 1,
  ...wheel("ffbGain"),
});

export const ffbEffects: RowDef[] = [
  fx("ffbDamping", "Damping", undefined, 1),
  fx("ffbKerb", "Kerb vibration"),
  fx("ffbAbs", "ABS vibration"),
  fx("ffbSlip", "Slip vibration", "WebHID only"),
  fx("ffbShift", "Shift warning", "WebHID only"),
];

export const ffbFineTuning: RowDef[] = [
  slider({
    id: "ffbCurve",
    label: "Force curve",
    hint: "Negative lifts low forces · positive reserves peak headroom",
    advanced: true,
    min: -50,
    max: 50,
    step: 5,
    format: (v) => (v === 0 ? "Linear" : `${v > 0 ? "+" : ""}${v}`),
    read: (env) => Math.round(50 * Math.log2(env.settings.wheel.ffbCurve)),
    write: (env, v) => env.update((s) => ({ ...s, wheel: { ...s.wheel, ffbCurve: 2 ** (v / 50) } })),
    initial: () => Math.round(50 * Math.log2(DEFAULT_PLAYER_SETTINGS.wheel.ffbCurve)),
  }),
  slider({
    id: "ffbMinForce",
    label: "Minimum force",
    hint: (env) =>
      env.settings.wheel.ffbPerCar?.[env.vehicleModel]
        ? "Overridden by per-car minimum force"
        : "Eliminates centre deadzone",
    advanced: true,
    min: 0,
    max: 0.2,
    step: 0.01,
    format: pctOrOff,
    ...wheel("ffbMinForce"),
  }),
  slider({
    id: "ffbFilterS",
    label: "Smoothing",
    advanced: true,
    min: 0,
    max: 0.05,
    step: 0.001,
    format: (v) => (v <= 0 ? "Raw" : ms(v)),
    ...wheel("ffbFilterS"),
  }),
  fx("ffbDownforceComp", "Downforce compensation", "Reduces high-speed aero clipping"),
];

export const ffbFriction = fx("ffbFriction", "Friction", "Hardware wheel effect");
export const ffbInertia = fx("ffbInertia", "Inertia", "Hardware wheel effect");

export const collisionGuard = toggle({
  id: "ffbCollisionGuard",
  label: "Collision protection",
  hint: "Caps impact force spikes",
  advanced: true,
  ...wheel("ffbCollisionGuard"),
});

export const revLights = toggle({
  id: "revLeds",
  label: "Rev lights",
  advanced: true,
  ...wheel("revLeds"),
});

// ---- Display > Graphics

export const quality = choice("tiles", {
  id: "quality",
  label: "Quality",
  // Phones and tablets draw without MSAA at every level (drive-session.ts): only they are told so
  options: () => {
    const touch = isTouchDevice();
    return [
      { id: "low", label: "Low", detail: "No shadows or bloom, lower res" },
      { id: "medium", label: "Medium", detail: touch ? "Shadows, no bloom or MSAA" : "Shadows, no bloom" },
      { id: "high", label: "High", detail: touch ? "Full effects except MSAA" : "Full effects" },
    ];
  },
  ...graphics("quality"),
});

export const sharpLow = toggle({
  id: "sharpLow",
  label: "Sharp Low",
  hint: "Draws Low at Medium resolution; auto quality can turn it off",
  off: (env) => (env.settings.graphics.quality === "low" ? null : "Needs Quality set to Low"),
  ...graphics("sharpLow"),
});

const RENDER_SCALES = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05);

export const renderScale = choice("select", {
  id: "renderScale",
  label: "Render resolution",
  options: RENDER_SCALES.map((v) => ({ id: v.toFixed(2), label: pct(v) })),
  read: (env) => (Math.round(env.settings.graphics.renderScale * 20) / 20).toFixed(2),
  write: (env, id) => env.update((s) => ({ ...s, graphics: { ...s.graphics, renderScale: Number(id) } })),
  initial: () => DEFAULT_PLAYER_SETTINGS.graphics.renderScale.toFixed(2),
});

export const sharpen = toggle({
  id: "sharpen",
  label: "Sharpen",
  hint: "Crisps edges and tarmac after scaling",
  ...graphics("sharpen"),
});

export const frameRate = choice("segmented", {
  id: "fpsCap",
  label: "Frame rate",
  hint: "30 fps lowers heat on mobile",
  options: [
    { id: "0", label: "Full" },
    { id: "30", label: "30 fps" },
  ],
  read: (env) => String(env.settings.graphics.fpsCap),
  write: (env, id) => env.update((s) => ({ ...s, graphics: { ...s.graphics, fpsCap: id === "30" ? 30 : 0 } })),
  initial: () => String(defaultPlayerSettings().graphics.fpsCap),
});

export const autoQuality = toggle({
  id: "autoQuality",
  label: "Automatic quality",
  hint: (env) => (env.autoQualityLowered ? `Scaled down: ${env.autoQualityLowered}` : "Steps down on sustained frame drops"),
  ...graphics("autoQuality"),
});

export const driverBody = toggle({
  id: "driverBody",
  label: "Driver body",
  ...graphics("driverBody"),
});

// ---- Display > HUD

/* The layout itself is chosen in its own picker (HudLayoutPicker, the list in hud-layouts.ts) */

export const hudSize = slider({ id: "hudScale", label: "Size", min: 0.75, max: 1.5, step: 0.05, format: pct, mark: 1, ...hud("scale") });

export const deltaBar = toggle({ id: "deltaBar", label: "Delta bar", ...hud("deltaBar") });
export const lapSummary = toggle({ id: "lapSummary", label: "Lap summary", ...hud("lapSummary") });
export const mirror = choice("segmented", {
  id: "virtualMirror",
  label: "Mirror",
  options: [
    { id: "auto", label: "Auto" },
    { id: "always", label: "Always" },
    { id: "off", label: "Off" },
  ],
  ...hud("virtualMirror"),
});
export const radar = toggle({ id: "radar", label: "Proximity radar", ...hud("radar") });
export const playerNames = toggle({
  id: "showPlayerNames",
  label: "Player nameplates",
  ...hud("showPlayerNames"),
});
export const boardWidget = choice("segmented", {
  id: "boardWidget",
  label: "Lap board",
  options: [
    { id: "lapEnd", label: "At lap end" },
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
  ],
  ...hud("boardWidget"),
});

export const hudAdvanced: RowDef[] = [
  toggle({
    id: "inputTrace",
    label: "Input trace",
    advanced: true,
    ...hud("inputTrace"),
  }),
  choice("segmented", {
    id: "towerGaps",
    label: "Timing tower gaps",
    advanced: true,
    options: [
      { id: "interval", label: "Interval" },
      { id: "leader", label: "To leader" },
    ],
    ...hud("towerGaps"),
  }),
  choice("segmented", {
    id: "mapMode",
    label: "Map mode",
    advanced: true,
    options: [
      { id: "full", label: "Full lap" },
      { id: "local", label: "Zoomed" },
    ],
    ...hud("mapMode"),
  }),
  toggle({ id: "splitGaps", label: "Split gaps", advanced: true, ...hud("splitGaps") }),
  toggle({
    id: "mfdAutoCollapse",
    label: "MFD auto-fold",
    advanced: true,
    ...hud("mfdAutoCollapse"),
  }),
];

// ---- Display > Camera

export const defaultView = choice("select", {
  id: "camera",
  label: "Default view",
  hint: (env) => `Key ${key(env, "camera")}`,
  options: DRIVING_CAMERA_MODES.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
  read: (env) => env.settings.camera ?? "chase",
  write: (env, id) => env.update((s) => ({ ...s, camera: id as PlayerSettings["camera"] })),
  initial: () => DEFAULT_PLAYER_SETTINGS.camera ?? "chase",
});

export const fieldOfView = slider({
  id: "cockpitFovDeg",
  label: "Field of view",
  hint: (env) =>
    env.settings.cockpitFovDeg === null
      ? "Using each car's default"
      : `Car default: ${env.carFovDeg ?? 60}°`,
  min: COCKPIT_FOV_MIN_DEG,
  max: COCKPIT_FOV_MAX_DEG,
  step: 1,
  format: (v, env) => (env.settings.cockpitFovDeg === null ? `${v}° (car)` : `${v}°`),
  read: (env) => env.settings.cockpitFovDeg ?? Math.round(env.carFovDeg ?? 60),
  // The car's own value is "the car's own" (null): each car then keeps its own on a car change
  write: (env, v) =>
    env.update((s) => ({ ...s, cockpitFovDeg: Math.round(v) === Math.round(env.carFovDeg ?? 60) ? null : Math.round(v) })),
  initial: (env) => Math.round(env.carFovDeg ?? 60),
});

export const headMovement = choice("segmented", {
  id: "headMovement",
  label: "Head movement",
  options: [
    { id: "natural", label: "Natural" },
    { id: "static", label: "Locked" },
  ],
  ...hud("headMovement"),
});

// ---- Display > Interface

export const speedUnit = choice("segmented", { id: "speedUnit", label: "Speed", options: [{ id: "kmh", label: "km/h" }, { id: "mph", label: "mph" }], ...units("speed") });
export const temperatureUnit = choice("segmented", { id: "temperatureUnit", label: "Temperature", options: [{ id: "c", label: "°C" }, { id: "f", label: "°F" }], ...units("temperature") });
export const pressureUnit = choice("segmented", { id: "pressureUnit", label: "Tyre pressure", options: [{ id: "bar", label: "bar" }, { id: "psi", label: "psi" }], ...units("pressure") });

export const uiScale = slider({
  id: "uiScale",
  label: "Interface size",
  min: UI_SCALE_MIN,
  max: UI_SCALE_MAX,
  step: 0.05,
  format: pct,
  mark: 1,
  ...ui("scale"),
});

export const palette = choice("select", {
  id: "palette",
  label: "Colour-blind palette",
  options: [
    { id: "standard", label: "Standard" },
    { id: "protan", label: "Red-weak", detail: "Protanopia and protanomaly" },
    { id: "deutan", label: "Green-weak", detail: "Deuteranopia and deuteranomaly" },
    { id: "tritan", label: "Blue-weak", detail: "Tritanopia and tritanomaly" },
  ],
  ...ui("palette"),
});

// ---- Audio

export const masterVolume = slider({ id: "volume", label: "Master volume", min: 0, max: 1, step: 0.05, format: pct, ...audio("volume") });
// The kerbs go up to 150 %: the named 100 % keeps it from reading like Master volume, whose 100 % is the end
export const kerbVolume = slider({ id: "kerbs", label: "Kerbs", min: 0, max: 1.5, step: 0.05, format: pct, mark: 1, ...audio("kerbs") });
export const mute = toggle({
  id: "muted",
  label: "Mute",
  hint: (env) => `Key ${key(env, "mute")}`,
  ...audio("muted"),
});
export const drsBeeps = toggle({ id: "drsBeep", label: "DRS beeps", ...hud("drsBeep") });
export const shiftBeep = toggle({ id: "shiftBeep", label: "Shift beep", ...hud("shiftBeep") });

export const musicOn = toggle({
  id: "musicOn",
  label: "Music",
  ...lens<boolean>(
    (st) => !st.audio.musicMuted,
    (st, on) => ({ ...st, audio: { ...st.audio, musicMuted: !on } }),
  ),
});
export const menuMusic = slider({ id: "menuMusic", label: "Menu music", min: 0, max: 1, step: 0.05, format: pctOrOff, ...audio("menuMusic") });
export const raceMusicOn = toggle({ id: "raceMusicOn", label: "Music while driving", ...audio("raceMusicOn") });
export const raceMusic = slider({
  id: "raceMusic",
  label: "Race music",
  hint: (env) => `Skip track: ${key(env, "nextTrack")}`,
  off: (env) => (env.settings.audio.raceMusicOn ? null : "Music while driving is off"),
  min: 0,
  max: 1,
  step: 0.05,
  format: pctOrOff,
  ...audio("raceMusic"),
});
export const replayMusic = slider({ id: "replayMusic", label: "Results & replay music", min: 0, max: 1, step: 0.05, format: pctOrOff, ...audio("replayMusic") });

/** One switch per soundtrack track, by pool (Advanced): a track switched off never plays */
export const musicTrackRows = (pool: MusicPool) =>
  MUSIC_TRACKS.filter((t) => t.pool === pool).map((t) =>
    toggle({
      id: `music-${t.id}`,
      label: t.title,
      hint: `${t.composer}, ${t.performer}`,
      advanced: true,
      ...lens<boolean>(
        (st) => !st.audio.musicOff.includes(t.id),
        (st, on) => ({
          ...st,
          audio: { ...st.audio, musicOff: on ? st.audio.musicOff.filter((id) => id !== t.id) : [...st.audio.musicOff, t.id] },
        }),
      ),
    }),
  );

// ---- Profile and data

export const autoUpload = toggle({
  id: "autoUpload",
  label: "Auto-upload best laps",
  ...profile("autoUpload"),
});

export const telemetryOut = toggle({
  id: "telemetryOut",
  label: "UDP telemetry",
  hint: "Sends live telemetry to local bridge (dashboards, bass shakers)",
  advanced: true,
  ...wheel("telemetryOut"),
});

export const detail = ui("detail");
