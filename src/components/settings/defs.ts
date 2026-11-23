import { keyLabel, PAD_PEDALS, pedalsOnTriggers } from "@/lib/input/bindings";
import { PAD_SENSITIVITY } from "@/lib/input/device-input";
import { isTouchDevice, requestTiltPermission } from "@/lib/input/touch-input";
import { CAMERA_MODES, DRIVING_CAMERA_MODES } from "@/lib/render/camera-modes";
import { RENDER_SCALE_FLOOR, sharpLowStepAllowed } from "@/lib/render/adaptive-quality";
import {
  AUTO_QUALITY_MIN_SCALES,
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
import { DAMAGE_LEVEL_LABELS, DAMAGE_LEVELS, type DamageLevel } from "@/lib/sim/car-damage";
import { ASSIST_SLIDERS, type AssistSliderSpec } from "@/lib/sim/steering-assist";
import type { AssistPreset } from "@/types/f1";
import { MUSIC_TRACKS, type MusicPool } from "@/lib/audio/music-catalog";
import { languageChoices } from "@/i18n/catalogs";
import { t } from "@/i18n/runtime";
import type { Messages } from "@/i18n/types";
import type { MessageKeys, NestedKeyOf } from "use-intl";
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
 *
 * The text is read from the messages (settings.rows.<row id>) each time a row is drawn, never once at load, so a change
 * of language shows at once: labels are getters; hints, options and off reasons are functions.
 */

type Rows = Messages["settings"]["rows"];
/** A message under settings.rows, such as "racingLine.hint" */
type RowKey = MessageKeys<Rows, NestedKeyOf<Rows>>;
const rt = (key: RowKey, values?: Record<string, string | number>) => t(`settings.rows.${key}`, values);

const key = (env: SettingsEnv, action: keyof PlayerSettings["keys"]) => keyLabel(env.settings.keys[action][0]);
const ms = (v: number) => `${Math.round(v * 1000)} ms`;
const curve = (v: number, digits = 2) =>
  Math.abs(v - 1) < 0.025
    ? t("settings.values.linear")
    : t(v > 1 ? "settings.values.progressive" : "settings.values.aggressive", { value: v.toFixed(digits) });
const ui = <K extends keyof PlayerSettings["ui"]>(k: K) =>
  lens<PlayerSettings["ui"][K]>((s) => s.ui[k], (s, v) => ({ ...s, ui: { ...s.ui, [k]: v } }));
const units = <K extends keyof PlayerSettings["ui"]["units"]>(k: K) =>
  lens<PlayerSettings["ui"]["units"][K]>(
    (s) => s.ui.units[k],
    (s, v) => ({ ...s, ui: { ...s.ui, units: { ...s.ui.units, [k]: v } } }),
  );

// ---- Driving > Assists

export type AssistLevel = "beginner" | "intermediate" | "sim";

export const ASSIST_LEVELS: readonly { id: AssistLevel; label: string; detail: string; preset: AssistPreset; racingLine: boolean }[] = (
  [
    { id: "beginner", preset: "assisted", racingLine: true },
    { id: "intermediate", preset: "semi_pro", racingLine: true },
    { id: "sim", preset: "pro", racingLine: false },
  ] as const
).map((level) => ({
  ...level,
  get label() { return rt(`assistLevel.options.${level.id}`); },
  get detail() { return rt(`assistLevel.details.${level.id}`); },
}));

const levelOf = (preset: AssistPreset): AssistLevel => (preset === "assisted" ? "beginner" : preset === "pro" ? "sim" : "intermediate");

export const assistLevel = choice("tiles", {
  id: "assistLevel",
  get label() { return rt("assistLevel.label"); },
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
  get label() { return rt("assistPreset.label"); },
  options: () => [
    { id: "pro", label: rt("assistPreset.options.pro") },
    { id: "semi_pro", label: rt("assistPreset.options.semi_pro") },
    { id: "assisted", label: rt("assistPreset.options.assisted") },
  ],
  ...top("assistPreset"),
});

export const racingLine = toggle({
  id: "racingLine",
  get label() { return rt("racingLine.label"); },
  hint: (env) => rt("racingLine.hint", { key: key(env, "racingLine") }),
  ...top("racingLine"),
});

export const autoGearbox = toggle({
  id: "autoGearbox",
  get label() { return rt("autoGearbox.label"); },
  hint: (env) => rt("autoGearbox.hint", { up: key(env, "shiftUp"), down: key(env, "shiftDown") }),
  ...top("autoGearbox"),
});

export const autoOvertake = toggle({
  id: "autoOvertake",
  get label() { return rt("autoOvertake.label"); },
  hint: (env) => rt("autoOvertake.hint", { key: key(env, "overtake") }),
  ...top("autoOvertake"),
});

/** Why no manual clutch is usable right now, or null when one is */
function autoClutchBlockReason(s: PlayerSettings): "gearbox" | "wheel" | "controller" | "touch" | "keyboard" | null {
  if (s.autoGearbox) return "gearbox";
  if (s.device === "wheel") return s.wheel.clutch !== null ? null : "wheel";
  if (s.device === "controller") return s.padTuning.pedalSources.clutch !== null ? null : "controller";
  const touchActive = s.touch.mode === "on" || (s.touch.mode === "auto" && isTouchDevice());
  if (touchActive) return "touch";
  return s.keys.clutch.length > 0 ? null : "keyboard";
}

export const autoClutch = toggle({
  id: "autoClutch",
  get label() { return rt("autoClutch.label"); },
  hint: (env) => {
    const reason = autoClutchBlockReason(env.settings);
    if (!env.settings.autoClutch && reason) return rt(`autoClutch.overridden.${reason}`);
    return rt("autoClutch.hint");
  },
  // Only block switching auto clutch OFF when no manual clutch is usable; if already off, keep it clickable so players can turn it back on or reset it
  off: (env) => {
    const reason = env.settings.autoClutch ? autoClutchBlockReason(env.settings) : null;
    return reason && rt(`autoClutch.off.${reason}`);
  },
  ...top("autoClutch"),
});

export const controllerSteerAssist = toggle({
  id: "gamepadAssist",
  get label() { return rt("gamepadAssist.label"); },
  hint: () => rt("gamepadAssist.hint"),
  ...top("gamepadAssist"),
});

export const throttleHelp = toggle({
  id: "exitAssist",
  get label() { return rt("exitAssist.label"); },
  hint: () => rt("exitAssist.hint"),
  ...kb("exitAssist"),
});

export const brakeHelp = toggle({
  id: "brakeAssist",
  get label() { return rt("brakeAssist.label"); },
  hint: () => rt("brakeAssist.hint"),
  ...kb("brakeAssist"),
});

export const realism = choice("segmented", {
  id: "realism",
  get label() { return rt("realism.label"); },
  hint: (env) => SIM_REALISM_LABELS[env.settings.realism].detail,
  options: () => SIM_REALISM_LEVELS.map((id) => ({ id, label: SIM_REALISM_LABELS[id].label })),
  ...top("realism"),
});

/** What each practice damage level does (an AI race sets its own in the race rules, an online race the room's) */
const PRACTICE_DAMAGE_HINTS: Record<DamageLevel, string> = {
  get off() { return rt("practiceDamage.hints.off"); },
  get reduced() { return rt("practiceDamage.hints.reduced"); },
  get full() { return rt("practiceDamage.hints.full"); },
};

export const practiceDamage = choice("segmented", {
  id: "practiceDamage",
  get label() { return rt("practiceDamage.label"); },
  hint: (env) => PRACTICE_DAMAGE_HINTS[env.settings.practiceDamage],
  options: () => DAMAGE_LEVELS.map((id) => ({ id, label: DAMAGE_LEVEL_LABELS[id] })),
  ...top("practiceDamage"),
});

/** A standing start's launch, kept with the race setup: the pre-race rules show the same choice */
export const launch = choice("segmented", {
  id: "launch",
  get label() { return rt("launch.label"); },
  hint: (env) => RACE_START_MODE_HINTS[env.settings.race.launch],
  options: () => RACE_START_MODES.map((id) => ({ id, label: RACE_START_MODE_LABELS[id] })),
  read: (env) => env.settings.race.launch,
  initial: () => DEFAULT_PLAYER_SETTINGS.race.launch,
  write: (env, id) => env.update((s) => ({ ...s, race: { ...s.race, launch: id as RaceStartMode } })),
});

export const ghost = toggle({
  id: "ghost",
  get label() { return rt("ghost.label"); },
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
      get label() { return spec.label; },
      hint: () => spec.hint,
      advanced: true,
      min: spec.min,
      max: lockMax,
      step: spec.step,
      format: (v, env) =>
        spec.key === "maxSelfSteerAngleDeg" && v >= lockMax(env) && env.steerLockDeg !== undefined
          ? t("settings.values.fullLock", { value: spec.format(v) })
          : spec.format(v),
      ...field(spec.key),
    });
  });
}

export const pedalHelpStrength = slider({
  id: "pedalAssistStrength",
  get label() { return rt("pedalAssistStrength.label"); },
  hint: () => rt("pedalAssistStrength.hint"),
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
  get label() { return rt("mouseSteer.label"); },
  hint: (env) => rt("mouseSteer.hint", { key: key(env, "mouseSteer") }),
  ...top("mouseSteer"),
});

export const keyboardFeel: RowDef[] = [
  slider({ id: "throttleRiseS", get label() { return rt("throttleRiseS.label"); }, advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("throttleRiseS") }),
  slider({ id: "brakeRiseS", get label() { return rt("brakeRiseS.label"); }, advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("brakeRiseS") }),
  slider({
    id: "steerRiseS",
    get label() { return rt("steerRiseS.label"); },
    hint: () => rt("steerRiseS.hint"),
    advanced: true,
    min: 0.05,
    max: 1,
    step: 0.01,
    format: ms,
    ...kb("steerRiseS"),
  }),
  slider({ id: "steerReturnS", get label() { return rt("steerReturnS.label"); }, advanced: true, min: 0.05, max: 1, step: 0.01, format: ms, ...kb("steerReturnS") }),
  slider({ id: "halfThrottle", get label() { return rt("halfThrottle.label"); }, advanced: true, min: 0.2, max: 0.9, step: 0.01, format: pct, ...kb("halfThrottle") }),
  slider({ id: "halfBrake", get label() { return rt("halfBrake.label"); }, advanced: true, min: 0.2, max: 0.9, step: 0.01, format: pct, ...kb("halfBrake") }),
];

// ---- Controls > Controller

export const vibration = toggle({
  id: "rumble",
  get label() { return rt("rumble.label"); },
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
  pedalsOnTriggers(env.settings.padTuning.pedalSources) ? null : t("settings.off.triggerPedals");
const onStick = (env: SettingsEnv) => PAD_PEDALS.some((p) => env.settings.padTuning.pedalSources[p]?.kind === "axis");

export const controllerFineTuning: RowDef[] = [
  slider({
    id: "steeringRate",
    get label() { return rt("steeringRate.label"); },
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
    get label() { return rt("deadzone.label"); },
    advanced: true,
    min: 0,
    max: 0.3,
    step: 0.01,
    format: pct,
    ...pad("deadzone"),
    initial: (env) => feel(env).deadzone,
  }),
  slider({ id: "outerDeadzone", get label() { return rt("outerDeadzone.label"); }, advanced: true, min: 0, max: 0.3, step: 0.01, format: pct, ...pad("outerDeadzone") }),
  slider({
    id: "linearity",
    get label() { return rt("linearity.label"); },
    hint: () => rt("linearity.hint"),
    advanced: true,
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => (Math.abs(v - 1) < 0.025 ? t("settings.values.linear") : v.toFixed(2)),
    ...pad("linearity"),
  }),
  slider({
    id: "throttleGamma",
    get label() { return rt("throttleGamma.label"); },
    hint: () => rt("throttleGamma.hint"),
    advanced: true,
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => curve(v),
    ...pad("throttleGamma"),
  }),
  slider({
    id: "brakeGamma",
    get label() { return rt("brakeGamma.label"); },
    hint: () => rt("brakeGamma.hint"),
    advanced: true,
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => curve(v),
    ...pad("brakeGamma"),
  }),
  slider({
    id: "stickPedalDeadzone",
    get label() { return rt("stickPedalDeadzone.label"); },
    advanced: true,
    min: 0,
    max: 0.3,
    step: 0.01,
    format: pct,
    off: (env) => (onStick(env) ? null : rt("stickPedalDeadzone.off")),
    ...pad("stickPedalDeadzone"),
  }),
];

export const triggerRumble = toggle({
  id: "triggerRumble",
  get label() { return rt("triggerRumble.label"); },
  hint: () => rt("triggerRumble.hint"),
  advanced: true,
  off: needsTriggerPedals,
  ...pad("triggerRumble"),
});

export const triggerSlip = toggle({
  id: "triggerSlipAlwaysOn",
  get label() { return rt("triggerSlipAlwaysOn.label"); },
  advanced: true,
  off: (env) => needsTriggerPedals(env) ?? (env.settings.padTuning.triggerRumble ? null : rt("triggerSlipAlwaysOn.off")),
  ...pad("triggerSlipAlwaysOn"),
});

// ---- Controls > Wheel

export const wheelSteerFilters: RowDef[] = [
  slider({
    id: "steerDeadzone",
    get label() { return rt("steerDeadzone.label"); },
    advanced: true,
    min: 0,
    max: 0.1,
    step: 0.005,
    format: (v) => `${(v * 100).toFixed(1)}%`,
    ...wheel("steerDeadzone"),
  }),
  slider({
    id: "steerSmoothingS",
    get label() { return rt("steerSmoothingS.label"); },
    advanced: true,
    min: 0,
    max: 0.08,
    step: 0.005,
    format: (v) => (v <= 0 ? t("settings.values.off") : ms(v)),
    ...wheel("steerSmoothingS"),
  }),
];

export const wheelBrakeCurve = slider({
  id: "wheelBrakeGamma",
  get label() { return rt("wheelBrakeGamma.label"); },
  hint: () => rt("wheelBrakeGamma.hint"),
  advanced: true,
  min: 0.5,
  max: 2.5,
  step: 0.1,
  format: (v) => curve(v, 1),
  ...wheel("brakeGamma"),
});

// ---- Controls > Touch

const noTouch = () => (isTouchDevice() ? null : t("settings.off.touchScreen"));

export const touchMode = choice("segmented", {
  id: "touchMode",
  get label() { return rt("touchMode.label"); },
  options: () => [
    { id: "auto", label: rt("touchMode.options.auto") },
    { id: "on", label: rt("touchMode.options.on") },
    { id: "off", label: rt("touchMode.options.off") },
  ],
  ...touch("mode"),
});

export const touchLayout = choice("segmented", {
  id: "touchLayout",
  get label() { return rt("touchLayout.label"); },
  hint: () => rt("touchLayout.hint"),
  off: (env) => (env.settings.touch.mode === "off" ? rt("touchLayout.off") : null),
  options: () => [
    { id: "sliders", label: rt("touchLayout.options.sliders") },
    { id: "buttons", label: rt("touchLayout.options.buttons") },
  ],
  ...touch("layout"),
});

const tiltSteerLens = touch("tiltSteer");

export const tiltSteer = toggle({
  id: "tiltSteer",
  get label() { return rt("tiltSteer.label"); },
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
  get label() { return rt("tiltRangeDeg.label"); },
  off: (env) => noTouch() ?? (env.settings.touch.tiltSteer ? null : rt("tiltRangeDeg.off")),
  min: 10,
  max: 60,
  step: 1,
  format: (v) => `${Math.round(v)}°`,
  ...touch("tiltRangeDeg"),
});

// ---- Force feedback

/** An effect's strength slider; its label and hint are read from the messages when drawn */
const fx = (id: keyof PlayerSettings["wheel"], label: () => string, hint?: () => string, step = 5): RowDef =>
  slider({
    id,
    get label() { return label(); },
    hint,
    advanced: true,
    min: 0,
    max: 1,
    step: step / 100,
    format: pctOrOff,
    ...wheel(id as "ffbKerb"),
  });

export const ffbOn = toggle({ id: "ffbEnabled", get label() { return rt("ffbEnabled.label"); }, ...wheel("ffbEnabled") });

export const ffbStrength = slider({
  id: "ffbGain",
  get label() { return rt("ffbGain.label"); },
  hint: (env) => {
    const own = env.settings.wheel.ffbPerCar?.[env.vehicleModel];
    return own ? rt("ffbGain.hintPerCar", { gain: pct(own.gain) }) : undefined;
  },
  min: 0,
  max: 2,
  step: 0.05,
  format: pct,
  mark: 1,
  ...wheel("ffbGain"),
});

export const ffbEffects: RowDef[] = [
  fx("ffbDamping", () => rt("ffbDamping.label"), undefined, 1),
  fx("ffbKerb", () => rt("ffbKerb.label")),
  fx("ffbAbs", () => rt("ffbAbs.label")),
  fx("ffbSlip", () => rt("ffbSlip.label"), () => rt("ffbSlip.hint")),
  fx("ffbShift", () => rt("ffbShift.label"), () => rt("ffbShift.hint")),
];

export const ffbFineTuning: RowDef[] = [
  slider({
    id: "ffbCurve",
    get label() { return rt("ffbCurve.label"); },
    hint: () => rt("ffbCurve.hint"),
    advanced: true,
    min: -50,
    max: 50,
    step: 5,
    format: (v) => (v === 0 ? t("settings.values.linear") : `${v > 0 ? "+" : ""}${v}`),
    read: (env) => Math.round(50 * Math.log2(env.settings.wheel.ffbCurve)),
    write: (env, v) => env.update((s) => ({ ...s, wheel: { ...s.wheel, ffbCurve: 2 ** (v / 50) } })),
    initial: () => Math.round(50 * Math.log2(DEFAULT_PLAYER_SETTINGS.wheel.ffbCurve)),
  }),
  slider({
    id: "ffbMinForce",
    get label() { return rt("ffbMinForce.label"); },
    hint: (env) => (env.settings.wheel.ffbPerCar?.[env.vehicleModel] ? rt("ffbMinForce.hintPerCar") : rt("ffbMinForce.hint")),
    advanced: true,
    min: 0,
    max: 0.2,
    step: 0.01,
    format: pctOrOff,
    ...wheel("ffbMinForce"),
  }),
  slider({
    id: "ffbFilterS",
    get label() { return rt("ffbFilterS.label"); },
    advanced: true,
    min: 0,
    max: 0.05,
    step: 0.001,
    format: (v) => (v <= 0 ? t("settings.values.raw") : ms(v)),
    ...wheel("ffbFilterS"),
  }),
  fx("ffbDownforceComp", () => rt("ffbDownforceComp.label"), () => rt("ffbDownforceComp.hint")),
];

export const ffbFriction = fx("ffbFriction", () => rt("ffbFriction.label"), () => rt("ffbFriction.hint"));
export const ffbInertia = fx("ffbInertia", () => rt("ffbInertia.label"), () => rt("ffbInertia.hint"));

export const collisionGuard = toggle({
  id: "ffbCollisionGuard",
  get label() { return rt("ffbCollisionGuard.label"); },
  hint: () => rt("ffbCollisionGuard.hint"),
  advanced: true,
  ...wheel("ffbCollisionGuard"),
});

export const revLights = toggle({
  id: "revLeds",
  get label() { return rt("revLeds.label"); },
  advanced: true,
  ...wheel("revLeds"),
});

// ---- Display > Graphics

export const quality = choice("tiles", {
  id: "quality",
  get label() { return rt("quality.label"); },
  // Phones and tablets draw without MSAA at every level (drive-session.ts): only they are told so
  options: () => {
    const touch = isTouchDevice();
    return [
      { id: "low", label: rt("quality.options.low"), detail: rt("quality.details.low") },
      { id: "medium", label: rt("quality.options.medium"), detail: rt(touch ? "quality.details.mediumTouch" : "quality.details.medium") },
      { id: "high", label: rt("quality.options.high"), detail: rt(touch ? "quality.details.highTouch" : "quality.details.high") },
    ];
  },
  ...graphics("quality"),
});

export const sharpLow = toggle({
  id: "sharpLow",
  get label() { return rt("sharpLow.label"); },
  // From a Lowest resolution of 70% up, automatic quality keeps it on (adaptive-quality.ts, SHARP_LOW_OFF_SCALE)
  hint: (env) => rt(sharpLowStepAllowed(env.settings.graphics.autoQualityMinScale) ? "sharpLow.hintAuto" : "sharpLow.hint"),
  off: (env) => (env.settings.graphics.quality === "low" ? null : rt("sharpLow.off")),
  ...graphics("sharpLow"),
});

const RENDER_SCALES = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05);

export const renderScale = choice("select", {
  id: "renderScale",
  get label() { return rt("renderScale.label"); },
  options: RENDER_SCALES.map((v) => ({ id: v.toFixed(2), label: pct(v) })),
  read: (env) => (Math.round(env.settings.graphics.renderScale * 20) / 20).toFixed(2),
  write: (env, id) => env.update((s) => ({ ...s, graphics: { ...s.graphics, renderScale: Number(id) } })),
  initial: () => DEFAULT_PLAYER_SETTINGS.graphics.renderScale.toFixed(2),
});

export const sharpen = toggle({
  id: "sharpen",
  get label() { return rt("sharpen.label"); },
  hint: () => rt("sharpen.hint"),
  ...graphics("sharpen"),
});

export const frameRate = choice("segmented", {
  id: "fpsCap",
  get label() { return rt("fpsCap.label"); },
  hint: () => rt("fpsCap.hint"),
  options: () => [
    { id: "0", label: rt("fpsCap.options.full") },
    { id: "30", label: rt("fpsCap.options.fps30") },
  ],
  read: (env) => String(env.settings.graphics.fpsCap),
  write: (env, id) => env.update((s) => ({ ...s, graphics: { ...s.graphics, fpsCap: id === "30" ? 30 : 0 } })),
  initial: () => String(defaultPlayerSettings().graphics.fpsCap),
});

export const autoQuality = toggle({
  id: "autoQuality",
  get label() { return rt("autoQuality.label"); },
  hint: (env) => (env.autoQualityLowered ? rt("autoQuality.hintLowered", { what: env.autoQualityLowered }) : rt("autoQuality.hint")),
  ...graphics("autoQuality"),
});

/**
 * The lowest Render resolution automatic quality may step down to (adaptive-quality.ts): the same units as Render
 * resolution, so at 100% (with Render resolution at 100% or less) only the effects step down
 */
export const autoQualityMinScale = choice("select", {
  id: "autoQualityMinScale",
  get label() { return rt("autoQualityMinScale.label"); },
  advanced: true,
  hint: (env) => {
    const g = env.settings.graphics;
    if (g.autoQualityMinScale < 1 || g.renderScale > 1) return rt("autoQualityMinScale.hint");
    // Low has no effects on its ladder: at 100% nothing is left to step down
    return rt(g.quality === "low" ? "autoQualityMinScale.hintLow" : "autoQualityMinScale.hintEffects");
  },
  off: (env) => (env.settings.graphics.autoQuality ? null : rt("autoQualityMinScale.off")),
  options: AUTO_QUALITY_MIN_SCALES.map((v) => ({ id: v.toFixed(1), label: pct(v) })),
  read: (env) => env.settings.graphics.autoQualityMinScale.toFixed(1),
  write: (env, id) =>
    env.update((s) => ({
      ...s,
      graphics: { ...s.graphics, autoQualityMinScale: AUTO_QUALITY_MIN_SCALES.find((v) => v.toFixed(1) === id) ?? RENDER_SCALE_FLOOR },
    })),
  initial: () => defaultPlayerSettings().graphics.autoQualityMinScale.toFixed(1),
});

export const driverBody = toggle({
  id: "driverBody",
  get label() { return rt("driverBody.label"); },
  ...graphics("driverBody"),
});

// ---- Display > HUD

/* The layout itself is chosen in its own picker (HudLayoutPicker, the list in hud-layouts.ts) */

export const hudSize = slider({ id: "hudScale", get label() { return rt("hudScale.label"); }, min: 0.75, max: 1.5, step: 0.05, format: pct, mark: 1, ...hud("scale") });

export const deltaBar = toggle({ id: "deltaBar", get label() { return rt("deltaBar.label"); }, ...hud("deltaBar") });
export const lapSummary = toggle({ id: "lapSummary", get label() { return rt("lapSummary.label"); }, ...hud("lapSummary") });
export const mirror = choice("segmented", {
  id: "virtualMirror",
  get label() { return rt("virtualMirror.label"); },
  options: () => [
    { id: "auto", label: rt("virtualMirror.options.auto") },
    { id: "always", label: rt("virtualMirror.options.always") },
    { id: "off", label: rt("virtualMirror.options.off") },
  ],
  ...hud("virtualMirror"),
});
export const radar = toggle({ id: "radar", get label() { return rt("radar.label"); }, ...hud("radar") });
export const playerNames = toggle({
  id: "showPlayerNames",
  get label() { return rt("showPlayerNames.label"); },
  ...hud("showPlayerNames"),
});
export const boardWidget = choice("segmented", {
  id: "boardWidget",
  get label() { return rt("boardWidget.label"); },
  options: () => [
    { id: "lapEnd", label: rt("boardWidget.options.lapEnd") },
    { id: "open", label: rt("boardWidget.options.open") },
    { id: "closed", label: rt("boardWidget.options.closed") },
  ],
  ...hud("boardWidget"),
});

export const hudAdvanced: RowDef[] = [
  toggle({
    id: "inputTrace",
    get label() { return rt("inputTrace.label"); },
    advanced: true,
    ...hud("inputTrace"),
  }),
  choice("segmented", {
    id: "towerGaps",
    get label() { return rt("towerGaps.label"); },
    advanced: true,
    options: () => [
      { id: "interval", label: rt("towerGaps.options.interval") },
      { id: "leader", label: rt("towerGaps.options.leader") },
    ],
    ...hud("towerGaps"),
  }),
  choice("segmented", {
    id: "mapMode",
    get label() { return rt("mapMode.label"); },
    advanced: true,
    options: () => [
      { id: "full", label: rt("mapMode.options.full") },
      { id: "local", label: rt("mapMode.options.local") },
    ],
    ...hud("mapMode"),
  }),
  toggle({ id: "splitGaps", get label() { return rt("splitGaps.label"); }, advanced: true, ...hud("splitGaps") }),
  toggle({
    id: "mfdAutoCollapse",
    get label() { return rt("mfdAutoCollapse.label"); },
    advanced: true,
    ...hud("mfdAutoCollapse"),
  }),
];

// ---- Display > Camera

export const defaultView = choice("select", {
  id: "camera",
  get label() { return rt("camera.label"); },
  hint: (env) => rt("camera.hint", { key: key(env, "camera") }),
  options: () => DRIVING_CAMERA_MODES.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
  read: (env) => env.settings.camera ?? "chase",
  write: (env, id) => env.update((s) => ({ ...s, camera: id as PlayerSettings["camera"] })),
  initial: () => DEFAULT_PLAYER_SETTINGS.camera ?? "chase",
});

export const fieldOfView = slider({
  id: "cockpitFovDeg",
  get label() { return rt("cockpitFovDeg.label"); },
  hint: (env) =>
    env.settings.cockpitFovDeg === null
      ? rt("cockpitFovDeg.hintCarOwn")
      : rt("cockpitFovDeg.hintCarDefault", { degrees: String(env.carFovDeg ?? 60) }),
  min: COCKPIT_FOV_MIN_DEG,
  max: COCKPIT_FOV_MAX_DEG,
  step: 1,
  format: (v, env) => (env.settings.cockpitFovDeg === null ? rt("cockpitFovDeg.valueCar", { value: String(v) }) : `${v}°`),
  read: (env) => env.settings.cockpitFovDeg ?? Math.round(env.carFovDeg ?? 60),
  // The car's own value is "the car's own" (null): each car then keeps its own on a car change
  write: (env, v) =>
    env.update((s) => ({ ...s, cockpitFovDeg: Math.round(v) === Math.round(env.carFovDeg ?? 60) ? null : Math.round(v) })),
  initial: (env) => Math.round(env.carFovDeg ?? 60),
});

export const headMovement = choice("segmented", {
  id: "headMovement",
  get label() { return rt("headMovement.label"); },
  options: () => [
    { id: "natural", label: rt("headMovement.options.natural") },
    { id: "static", label: rt("headMovement.options.static") },
  ],
  ...hud("headMovement"),
});

// ---- Display > Interface

/** Automatic follows the browser; each language is listed under its own name, as its speakers look for it */
export const language = choice("select", {
  id: "language",
  get label() { return rt("language.label"); },
  options: () => [
    { id: "auto", label: rt("language.options.auto"), detail: rt("language.details.auto") },
    ...languageChoices().map(({ code, name }) => ({ id: code, label: name })),
  ],
  ...ui("language"),
});

export const speedUnit = choice("segmented", {
  id: "speedUnit",
  get label() { return rt("speedUnit.label"); },
  options: [{ id: "kmh", label: "km/h" }, { id: "mph", label: "mph" }],
  ...units("speed"),
});
export const temperatureUnit = choice("segmented", {
  id: "temperatureUnit",
  get label() { return rt("temperatureUnit.label"); },
  options: [{ id: "c", label: "°C" }, { id: "f", label: "°F" }],
  ...units("temperature"),
});
export const pressureUnit = choice("segmented", {
  id: "pressureUnit",
  get label() { return rt("pressureUnit.label"); },
  options: [{ id: "bar", label: "bar" }, { id: "psi", label: "psi" }],
  ...units("pressure"),
});

export const uiScale = slider({
  id: "uiScale",
  get label() { return rt("uiScale.label"); },
  min: UI_SCALE_MIN,
  max: UI_SCALE_MAX,
  step: 0.05,
  format: pct,
  mark: 1,
  ...ui("scale"),
});

export const palette = choice("select", {
  id: "palette",
  get label() { return rt("palette.label"); },
  options: () => [
    { id: "standard", label: rt("palette.options.standard") },
    { id: "protan", label: rt("palette.options.protan"), detail: rt("palette.details.protan") },
    { id: "deutan", label: rt("palette.options.deutan"), detail: rt("palette.details.deutan") },
    { id: "tritan", label: rt("palette.options.tritan"), detail: rt("palette.details.tritan") },
  ],
  ...ui("palette"),
});

// ---- Audio

export const masterVolume = slider({ id: "volume", get label() { return rt("volume.label"); }, min: 0, max: 1, step: 0.05, format: pct, ...audio("volume") });
// The kerbs go up to 150 %: the named 100 % keeps it from reading like Master volume, whose 100 % is the end
export const kerbVolume = slider({ id: "kerbs", get label() { return rt("kerbs.label"); }, min: 0, max: 1.5, step: 0.05, format: pct, mark: 1, ...audio("kerbs") });
export const mute = toggle({
  id: "muted",
  get label() { return rt("muted.label"); },
  hint: (env) => rt("muted.hint", { key: key(env, "mute") }),
  ...audio("muted"),
});
export const drsBeeps = toggle({ id: "drsBeep", get label() { return rt("drsBeep.label"); }, ...hud("drsBeep") });
export const shiftBeep = toggle({ id: "shiftBeep", get label() { return rt("shiftBeep.label"); }, ...hud("shiftBeep") });

export const musicOn = toggle({
  id: "musicOn",
  get label() { return rt("musicOn.label"); },
  ...lens<boolean>(
    (st) => !st.audio.musicMuted,
    (st, on) => ({ ...st, audio: { ...st.audio, musicMuted: !on } }),
  ),
});
export const menuMusic = slider({ id: "menuMusic", get label() { return rt("menuMusic.label"); }, min: 0, max: 1, step: 0.05, format: pctOrOff, ...audio("menuMusic") });
export const raceMusicOn = toggle({ id: "raceMusicOn", get label() { return rt("raceMusicOn.label"); }, ...audio("raceMusicOn") });
export const raceMusic = slider({
  id: "raceMusic",
  get label() { return rt("raceMusic.label"); },
  hint: (env) => rt("raceMusic.hint", { key: key(env, "nextTrack") }),
  off: (env) => (env.settings.audio.raceMusicOn ? null : rt("raceMusic.off")),
  min: 0,
  max: 1,
  step: 0.05,
  format: pctOrOff,
  ...audio("raceMusic"),
});
export const replayMusic = slider({ id: "replayMusic", get label() { return rt("replayMusic.label"); }, min: 0, max: 1, step: 0.05, format: pctOrOff, ...audio("replayMusic") });

/** One switch per soundtrack track, by pool (Advanced): a track switched off never plays */
export const musicTrackRows = (pool: MusicPool) =>
  MUSIC_TRACKS.filter((track) => track.pool === pool).map((track) =>
    toggle({
      id: `music-${track.id}`,
      label: track.title,
      hint: `${track.composer}, ${track.performer}`,
      advanced: true,
      ...lens<boolean>(
        (st) => !st.audio.musicOff.includes(track.id),
        (st, on) => ({
          ...st,
          audio: { ...st.audio, musicOff: on ? st.audio.musicOff.filter((id) => id !== track.id) : [...st.audio.musicOff, track.id] },
        }),
      ),
    }),
  );

// ---- Profile and data

export const autoUpload = toggle({
  id: "autoUpload",
  get label() { return rt("autoUpload.label"); },
  ...profile("autoUpload"),
});

export const telemetryOut = toggle({
  id: "telemetryOut",
  get label() { return rt("telemetryOut.label"); },
  hint: () => rt("telemetryOut.hint"),
  advanced: true,
  ...wheel("telemetryOut"),
});

export const detail = ui("detail");
