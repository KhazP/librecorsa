import { keyLabel } from "@/lib/input/bindings";
import { PAD_SENSITIVITY } from "@/lib/input/device-input";
import { isTouchDevice } from "@/lib/input/touch-input";
import { ALL_CAMERA_MODES, CAMERA_MODES } from "@/lib/render/camera-modes";
import {
  COCKPIT_FOV_MAX_DEG,
  COCKPIT_FOV_MIN_DEG,
  DEFAULT_PLAYER_SETTINGS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type PlayerSettings,
} from "@/lib/settings/player-settings";
import { SIM_REALISM_LABELS, SIM_REALISM_LEVELS } from "@/lib/sim/sim-realism";
import { ASSIST_SLIDERS, type AssistSliderSpec } from "@/lib/sim/steering-assist";
import type { AssistPreset } from "@/types/f1";
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
  { id: "beginner", label: "Beginner", detail: "Full traction control and ABS, the racing line, grip-limited steering", preset: "assisted", racingLine: true },
  { id: "intermediate", label: "Intermediate", detail: "Light traction control and ABS, the racing line", preset: "semi_pro", racingLine: true },
  { id: "sim", label: "Sim", detail: "No traction control, no ABS, no racing line", preset: "pro", racingLine: false },
];

const levelOf = (preset: AssistPreset): AssistLevel => (preset === "assisted" ? "beginner" : preset === "pro" ? "sim" : "intermediate");

export const assistLevel = choice("tiles", {
  id: "assistLevel",
  label: "Assist level",
  hint: "A starting point: it sets traction control, ABS and the racing line below",
  options: ASSIST_LEVELS,
  read: (env) => levelOf(env.settings.assistPreset),
  write: (env, id) => {
    const level = ASSIST_LEVELS.find((l) => l.id === id) ?? ASSIST_LEVELS[1];
    env.update((s) => ({
      ...s,
      assistPreset: level.preset,
      racingLine: level.racingLine,
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
  hint: (env) => `A braking guide on the track, green to red. Key ${key(env, "racingLine")}`,
  ...top("racingLine"),
});

export const autoGearbox = toggle({
  id: "autoGearbox",
  label: "Automatic gearbox",
  hint: (env) => `Off: shift yourself with ${key(env, "shiftUp")} and ${key(env, "shiftDown")}`,
  ...top("autoGearbox"),
});

export const controllerSteerAssist = toggle({
  id: "gamepadAssist",
  label: "Controller steering assist",
  hint: "The stick steers up to the front tyres' grip limit and helps catch slides",
  ...top("gamepadAssist"),
});

export const throttleHelp = toggle({
  id: "exitAssist",
  label: "Throttle help",
  hint: "Keyboard, with traction control off: eases the throttle key back while the rear tyres slide",
  ...kb("exitAssist"),
});

export const brakeHelp = toggle({
  id: "brakeAssist",
  label: "Brake help",
  hint: "Keyboard, with ABS off: eases the brake key back while the tyres lock",
  ...kb("brakeAssist"),
});

export const realism = choice("segmented", {
  id: "realism",
  label: "Simulation realism",
  hint: (env) => SIM_REALISM_LABELS[env.settings.realism].detail,
  options: SIM_REALISM_LEVELS.map((id) => ({ id, label: SIM_REALISM_LABELS[id].label })),
  ...top("realism"),
});

export const ghost = toggle({
  id: "ghost",
  label: "Race my best-lap ghost",
  hint: "My personal-best lap drives alongside me on this circuit",
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
  hint: (env) => `Steer with the mouse across the screen; throttle and brake stay on the keys. Key ${key(env, "mouseSteer")}`,
  ...top("mouseSteer"),
});

export const keyboardFeel: RowDef[] = [
  slider({ id: "throttleRiseS", label: "Throttle rise", hint: "Time for the throttle key to reach full throttle", advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("throttleRiseS") }),
  slider({ id: "brakeRiseS", label: "Brake rise", hint: "Time for the brake key to reach full brake", advanced: true, min: 0, max: 1, step: 0.01, format: ms, ...kb("brakeRiseS") }),
  slider({
    id: "steerRiseS",
    label: "Steering smoothing",
    hint: "How gently a held key steers in, on top of each car's own curve. Shorter is sharper",
    advanced: true,
    min: 0.05,
    max: 1,
    step: 0.01,
    format: ms,
    ...kb("steerRiseS"),
  }),
  slider({ id: "steerReturnS", label: "Steering return", hint: "How quickly the steering comes back to centre when the key is let go", advanced: true, min: 0.05, max: 1, step: 0.01, format: ms, ...kb("steerReturnS") }),
  slider({ id: "halfThrottle", label: "Half throttle", hint: "Throttle while the Half throttle key is held with throttle", advanced: true, min: 0.2, max: 0.9, step: 0.01, format: pct, ...kb("halfThrottle") }),
];

// ---- Controls > Controller

export const vibration = toggle({
  id: "rumble",
  label: "Vibration",
  hint: "Kerbs, lock-ups, wheelspin and grass through the controller",
  read: (env) => env.rumble,
  write: (env, on) => {
    if (on !== env.rumble) env.onToggleRumble();
  },
  initial: () => true,
});

/** Steering speed and the inner dead zone start from the chosen steering feel */
const feel = (env: SettingsEnv) => PAD_SENSITIVITY[env.settings.padSensitivity];

export const controllerFineTuning: RowDef[] = [
  slider({
    id: "steeringRate",
    label: "Steering speed",
    hint: "How quickly the stick turns the steering",
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
    hint: "Stick travel ignored around centre",
    advanced: true,
    min: 0,
    max: 0.3,
    step: 0.01,
    format: pct,
    ...pad("deadzone"),
    initial: (env) => feel(env).deadzone,
  }),
  slider({ id: "outerDeadzone", label: "Outer dead zone", hint: "Full lock comes before the stick's physical stop", advanced: true, min: 0, max: 0.3, step: 0.01, format: pct, ...pad("outerDeadzone") }),
  slider({
    id: "linearity",
    label: "Stick linearity",
    hint: "Above 1 gives finer control near centre",
    advanced: true,
    min: 0.5,
    max: 3,
    step: 0.05,
    format: (v) => (Math.abs(v - 1) < 0.025 ? "Linear" : v.toFixed(2)),
    ...pad("linearity"),
  }),
  slider({ id: "throttleGamma", label: "Throttle curve", hint: "Above 1 keeps light presses gentler", advanced: true, min: 0.5, max: 3, step: 0.05, format: (v) => curve(v), ...pad("throttleGamma") }),
  slider({ id: "brakeGamma", label: "Brake curve", hint: "Above 1 gives finer brake control at light pressure", advanced: true, min: 0.5, max: 3, step: 0.05, format: (v) => curve(v), ...pad("brakeGamma") }),
];

export const triggerRumble = toggle({
  id: "triggerRumble",
  label: "Trigger rumble",
  hint: "Slip and ABS pulses in the brake trigger, wheelspin in the throttle trigger, on controllers that have them",
  advanced: true,
  ...pad("triggerRumble"),
});

export const triggerSlip = toggle({
  id: "triggerSlipAlwaysOn",
  label: "Trigger slip with ABS and TC on",
  hint: "Tyre-slip vibration in the triggers even while ABS and traction control are on",
  advanced: true,
  off: (env) => (env.settings.padTuning.triggerRumble ? null : "Needs Trigger rumble on"),
  ...pad("triggerSlipAlwaysOn"),
});

// ---- Controls > Wheel

export const wheelSteerFilters: RowDef[] = [
  slider({
    id: "steerDeadzone",
    label: "Centre dead zone",
    hint: "Rim travel ignored around centre",
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
    hint: "Smooths the steering signal; worth a little on a noisy wheel",
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
  hint: "Load-cell brakes usually feel best linear; potentiometer pedals often like 1.3 to 1.6",
  advanced: true,
  min: 0.5,
  max: 2.5,
  step: 0.1,
  format: (v) => curve(v, 1),
  ...wheel("brakeGamma"),
});

// ---- Controls > Touch

const noTouch = () => (isTouchDevice() ? null : "Needs a touch screen");

export const touchMode = choice("segmented", {
  id: "touchMode",
  label: "Touch controls",
  hint: "On-screen pedals and steering. Auto shows them on phones and tablets",
  options: [
    { id: "auto", label: "Auto" },
    { id: "on", label: "On" },
    { id: "off", label: "Off" },
  ],
  ...touch("mode"),
});

export const tiltSteer = toggle({
  id: "tiltSteer",
  label: "Tilt to steer",
  hint: "Tilt the device instead of using the on-screen slider",
  off: noTouch,
  ...touch("tiltSteer"),
});

export const tiltRange = slider({
  id: "tiltRangeDeg",
  label: "Tilt range",
  hint: "Tilt angle for full lock",
  off: (env) => noTouch() ?? (env.settings.touch.tiltSteer ? null : "Needs Tilt to steer on"),
  min: 10,
  max: 60,
  step: 1,
  format: (v) => `${Math.round(v)}°`,
  ...touch("tiltRangeDeg"),
});

// ---- Force feedback

const fx = (id: keyof PlayerSettings["wheel"], label: string, hint: string, step = 5): RowDef =>
  slider({ id, label, hint, advanced: true, min: 0, max: 1, step: step / 100, format: pctOrOff, ...wheel(id as "ffbKerb") });

export const ffbOn = toggle({ id: "ffbEnabled", label: "Force feedback", hint: "Forces from the car through the rim", ...wheel("ffbEnabled") });

export const ffbStrength = slider({
  id: "ffbGain",
  label: "Strength",
  hint: (env) => {
    const own = env.settings.wheel.ffbPerCar?.[env.vehicleModel];
    return own
      ? `This car uses its own strength, ${pct(own.gain)}, set from the force meter. Clear it below to use this one`
      : "Overall force for every car";
  },
  min: 0,
  max: 2,
  step: 0.05,
  format: pct,
  ...wheel("ffbGain"),
});

export const ffbEffects: RowDef[] = [
  fx("ffbDamping", "Damping", "Resists fast rim movement and steadies the wheel at speed", 1),
  fx("ffbKerb", "Kerb vibration", "A buzz over kerbs and rumble strips"),
  fx("ffbAbs", "ABS vibration", "A pulse through the rim while ABS works"),
  fx("ffbSlip", "Slip vibration", "Buzzes from just before the tyres' grip peak: understeer, lock-ups, wheelspin. Browser connection only"),
  fx("ffbShift", "Shift warning", "Buzzes as the revs reach the shift lights, until the next gear. Browser connection only"),
];

export const ffbFineTuning: RowDef[] = [
  slider({
    id: "ffbCurve",
    label: "Force curve",
    hint: "Below 0 lifts light forces (belt and gear wheels); above 0 keeps them light and saves strength for big loads",
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
        ? "This car uses its own minimum force from the force meter"
        : "Lifts the smallest forces so the centre never goes dead",
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
    hint: "A low-pass filter on the force. 0 is raw",
    advanced: true,
    min: 0,
    max: 0.05,
    step: 0.001,
    format: (v) => (v <= 0 ? "Raw" : ms(v)),
    ...wheel("ffbFilterS"),
  }),
  fx("ffbDownforceComp", "Downforce compensation", "Takes the aero load out of the steering weight so fast corners do not clip. Raise Strength to match"),
];

export const ffbFriction = fx("ffbFriction", "Friction", "A steady drag on the rim, run by the wheel itself. Up to 30% of its strength");
export const ffbInertia = fx("ffbInertia", "Inertia", "Weight that resists quick changes of direction, run by the wheel itself. Up to 30% of its strength");

export const collisionGuard = toggle({
  id: "ffbCollisionGuard",
  label: "Collision protection",
  hint: "Holds back the force spike of a hit so it never yanks the rim",
  advanced: true,
  ...wheel("ffbCollisionGuard"),
});

export const revLights = toggle({
  id: "revLeds",
  label: "Rev lights",
  hint: "The rim's lights follow the revs and flash at the shift point",
  advanced: true,
  ...wheel("revLeds"),
});

// ---- Display > Graphics

export const quality = choice("tiles", {
  id: "quality",
  label: "Quality",
  options: [
    { id: "low", label: "Low", detail: "No shadows or bloom, fewer trees, lower resolution. For laptops and phones" },
    { id: "medium", label: "Medium", detail: "Shadows, no bloom, fewer trees" },
    { id: "high", label: "High", detail: "Everything on" },
  ],
  ...graphics("quality"),
});

const RENDER_SCALES = Array.from({ length: 21 }, (_, i) => 0.5 + i * 0.05);

export const renderScale = choice("select", {
  id: "renderScale",
  label: "Render resolution",
  hint: "Against the screen's own. Lower is faster",
  options: RENDER_SCALES.map((v) => ({ id: v.toFixed(2), label: pct(v) })),
  read: (env) => (Math.round(env.settings.graphics.renderScale * 20) / 20).toFixed(2),
  write: (env, id) => env.update((s) => ({ ...s, graphics: { ...s.graphics, renderScale: Number(id) } })),
  initial: () => DEFAULT_PLAYER_SETTINGS.graphics.renderScale.toFixed(2),
});

export const driverBody = toggle({
  id: "driverBody",
  label: "Driver body",
  hint: "Arms on the wheel and a body in the seat, in the cars that have them",
  ...graphics("driverBody"),
});

// ---- Display > HUD

export const HUD_LAYOUTS = [
  { id: "broadcast", label: "Broadcast", detail: "TV graphics: tower, map, telemetry strip" },
  { id: "dash", label: "Wheel dash", detail: "A steering-wheel screen, low and centred" },
  { id: "telemetry", label: "Telemetry", detail: "The dash plus tyres, G, power and inputs" },
  { id: "classic", label: "Classic", detail: "The original corner panels" },
  { id: "minimal", label: "Minimal", detail: "Speed, gear and lap only" },
] as const;

export const hudSize = slider({ id: "hudScale", label: "Size", hint: "The whole HUD, larger or smaller", min: 0.75, max: 1.5, step: 0.05, format: pct, ...hud("scale") });

export const deltaBar = toggle({ id: "deltaBar", label: "Delta bar", hint: "The live gap to your best lap, at the top", ...hud("deltaBar") });
export const lapSummary = toggle({ id: "lapSummary", label: "Lap summary", hint: "Sectors, corner speeds and the theoretical best after each lap", ...hud("lapSummary") });
export const mirror = choice("segmented", {
  id: "virtualMirror",
  label: "Mirror",
  hint: "Auto: onboard views without wing mirrors in sight",
  options: [
    { id: "auto", label: "Auto" },
    { id: "always", label: "Always" },
    { id: "off", label: "Off" },
  ],
  ...hud("virtualMirror"),
});
export const radar = toggle({ id: "radar", label: "Radar", hint: "Fades in when a car is alongside or close behind", ...hud("radar") });

export const hudAdvanced: RowDef[] = [
  toggle({
    id: "inputTrace",
    label: "Input trace",
    hint: "Rolling throttle, brake and steering trace (always on in the Telemetry layout)",
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
  toggle({ id: "splitGaps", label: "Split gaps", hint: "Race gaps to the cars directly ahead and behind", advanced: true, ...hud("splitGaps") }),
  toggle({
    id: "mfdAutoCollapse",
    label: "MFD auto-fold",
    hint: "The MFD folds to its status pill a few seconds after the last press",
    advanced: true,
    ...hud("mfdAutoCollapse"),
  }),
];

// ---- Display > Camera

export const defaultView = choice("select", {
  id: "camera",
  label: "Default view",
  hint: (env) => `The view each drive starts in. Key ${key(env, "camera")} cycles them in the car`,
  options: ALL_CAMERA_MODES.map((id) => ({ id, label: CAMERA_MODES[id].label, detail: CAMERA_MODES[id].blurb })),
  read: (env) => env.settings.camera ?? "chase",
  write: (env, id) => env.update((s) => ({ ...s, camera: id as PlayerSettings["camera"] })),
  initial: () => DEFAULT_PLAYER_SETTINGS.camera ?? "chase",
});

export const fieldOfView = slider({
  id: "cockpitFovDeg",
  label: "Field of view",
  hint: (env) =>
    env.settings.cockpitFovDeg === null
      ? "The car's own, for every car. Onboard views move with it"
      : `For every car; the car's own is ${env.carFovDeg ?? "its default"}°`,
  min: COCKPIT_FOV_MIN_DEG,
  max: COCKPIT_FOV_MAX_DEG,
  step: 1,
  format: (v, env) => (env.settings.cockpitFovDeg === null ? `${v}°, car` : `${v}°`),
  read: (env) => env.settings.cockpitFovDeg ?? Math.round(env.carFovDeg ?? 60),
  // The car's own value is "the car's own" (null): each car then keeps its own on a car change
  write: (env, v) =>
    env.update((s) => ({ ...s, cockpitFovDeg: Math.round(v) === Math.round(env.carFovDeg ?? 60) ? null : Math.round(v) })),
  initial: (env) => Math.round(env.carFovDeg ?? 60),
});

export const headMovement = choice("segmented", {
  id: "headMovement",
  label: "Head movement",
  hint: "Natural moves with the car like a neck; Locked bolts the view to the car",
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
  hint: "Menus and text, on top of the size the screen picks",
  min: UI_SCALE_MIN,
  max: UI_SCALE_MAX,
  step: 0.05,
  format: pct,
  ...ui("scale"),
});

export const palette = choice("select", {
  id: "palette",
  label: "Colour-blind palette",
  hint: "Changes the colours that mean faster, slower, best, hot and cold",
  options: [
    { id: "standard", label: "Standard" },
    { id: "protan", label: "Red-weak", detail: "Protanopia and protanomaly" },
    { id: "deutan", label: "Green-weak", detail: "Deuteranopia and deuteranomaly" },
    { id: "tritan", label: "Blue-weak", detail: "Tritanopia and tritanomaly" },
  ],
  ...ui("palette"),
});

// ---- Audio

export const masterVolume = slider({ id: "volume", label: "Master volume", hint: "Every sound in the game", min: 0, max: 1, step: 0.05, format: pct, ...audio("volume") });
export const mute = toggle({
  id: "muted",
  label: "Mute",
  hint: (env) => `Silences every sound and keeps the volume. Key ${key(env, "mute")}`,
  ...audio("muted"),
});
export const drsBeeps = toggle({ id: "drsBeep", label: "DRS beeps", hint: "Two tones when DRS is available, a chime when the flap opens", ...hud("drsBeep") });
export const shiftBeep = toggle({ id: "shiftBeep", label: "Shift beep", hint: "A short beep 150 rpm before the rev limiter", ...hud("shiftBeep") });

// ---- Profile and data

export const autoUpload = toggle({
  id: "autoUpload",
  label: "Post my best laps online",
  hint: "A new personal best goes on the online lap board by itself",
  ...profile("autoUpload"),
});

export const telemetryOut = toggle({
  id: "telemetryOut",
  label: "Telemetry out",
  hint: "Sends live telemetry over UDP through the local bridge, for dashboards and bass shakers. No wheel needed",
  advanced: true,
  ...wheel("telemetryOut"),
});

export const detail = ui("detail");
