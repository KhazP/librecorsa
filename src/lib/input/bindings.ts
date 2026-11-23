/**
 * Rebindable controls: keyboard codes and controller / wheel buttons per action.
 * The defaults reproduce the original hard-coded layout exactly.
 */

import { text as t } from "@/lib/text";
import { perLanguage } from "@/lib/per-language";
import type { StartClutchControl } from "@/types/f1";
import { printedKey } from "./key-layout";

export type KeyAction =
  | "throttle"
  | "brake"
  | "steerLeft"
  | "steerRight"
  | "boostHold"
  | "boostLatch"
  | "overtake"
  | "aero"
  | "shiftUp"
  | "shiftDown"
  | "neutral"
  | "camera"
  | "freeCamera"
  | "tvCamera"
  | "racingLine"
  | "mute"
  | "nextTrack"
  | "autopilot"
  | "mouseSteer"
  | "restart"
  | "flyingLap"
  | "throttleHalf"
  | "brakeHalf"
  | "clutch"
  | "replay"
  | "mfdPage"
  | "mfd"
  | "hud"
  | "board"
  | "headlights"
  | "headlightFlash";

/** Actions a controller or wheel button can trigger */
export type PadAction =
  | "boost"
  | "overtake"
  | "aero"
  | "shiftUp"
  | "shiftDown"
  | "neutral"
  | "camera"
  | "freeCamera"
  | "tvCamera"
  | "racingLine"
  | "restart"
  | "flyingLap"
  | "pause"
  | "mfd"
  | "mfdPage"
  | "hud"
  | "board"
  | "headlights"
  | "headlightFlash";

export type KeyBindings = Record<KeyAction, string[]>;

/** Each action shows a primary and an alternative key (more when the defaults have them) */
export const KEY_SLOTS = 2;

export const KEY_ACTIONS: readonly { id: KeyAction; label: string }[] = [
  { id: "throttle", get label() { return t("game.keyActions.throttle"); } },
  { id: "brake", get label() { return t("game.keyActions.brake"); } },
  { id: "steerLeft", get label() { return t("game.keyActions.steerLeft"); } },
  { id: "steerRight", get label() { return t("game.keyActions.steerRight"); } },
  { id: "boostHold", get label() { return t("game.keyActions.boostHold"); } },
  { id: "boostLatch", get label() { return t("game.keyActions.boostLatch"); } },
  { id: "overtake", get label() { return t("game.keyActions.overtake"); } },
  { id: "aero", get label() { return t("game.keyActions.aero"); } },
  { id: "shiftUp", get label() { return t("game.keyActions.shiftUp"); } },
  { id: "shiftDown", get label() { return t("game.keyActions.shiftDown"); } },
  { id: "neutral", get label() { return t("game.keyActions.neutral"); } },
  { id: "camera", get label() { return t("game.keyActions.camera"); } },
  { id: "freeCamera", get label() { return t("game.keyActions.freeCamera"); } },
  { id: "tvCamera", get label() { return t("game.keyActions.tvCamera"); } },
  { id: "racingLine", get label() { return t("game.keyActions.racingLine"); } },
  { id: "mute", get label() { return t("game.keyActions.mute"); } },
  { id: "nextTrack", get label() { return t("game.keyActions.nextTrack"); } },
  { id: "autopilot", get label() { return t("game.keyActions.autopilot"); } },
  { id: "mouseSteer", get label() { return t("game.keyActions.mouseSteer"); } },
  { id: "restart", get label() { return t("game.keyActions.restart"); } },
  { id: "flyingLap", get label() { return t("game.keyActions.flyingLap"); } },
  { id: "throttleHalf", get label() { return t("game.keyActions.throttleHalf"); } },
  { id: "brakeHalf", get label() { return t("game.keyActions.brakeHalf"); } },
  { id: "clutch", get label() { return t("game.keyActions.clutch"); } },
  { id: "replay", get label() { return t("game.keyActions.replay"); } },
  { id: "mfdPage", get label() { return t("game.keyActions.mfdPage"); } },
  { id: "mfd", get label() { return t("game.keyActions.mfd"); } },
  { id: "hud", get label() { return t("game.keyActions.hud"); } },
  { id: "board", get label() { return t("game.keyActions.board"); } },
  { id: "headlights", get label() { return t("game.keyActions.headlights"); } },
  { id: "headlightFlash", get label() { return t("game.keyActions.headlightFlash"); } },
];

export const PAD_ACTIONS: readonly { id: PadAction; label: string }[] = [
  { id: "shiftUp", get label() { return t("game.padActions.shiftUp"); } },
  { id: "shiftDown", get label() { return t("game.padActions.shiftDown"); } },
  { id: "neutral", get label() { return t("game.padActions.neutral"); } },
  { id: "boost", get label() { return t("game.padActions.boost"); } },
  { id: "overtake", get label() { return t("game.padActions.overtake"); } },
  { id: "aero", get label() { return t("game.padActions.aero"); } },
  { id: "camera", get label() { return t("game.padActions.camera"); } },
  { id: "freeCamera", get label() { return t("game.padActions.freeCamera"); } },
  { id: "tvCamera", get label() { return t("game.padActions.tvCamera"); } },
  { id: "racingLine", get label() { return t("game.padActions.racingLine"); } },
  { id: "restart", get label() { return t("game.padActions.restart"); } },
  { id: "flyingLap", get label() { return t("game.padActions.flyingLap"); } },
  { id: "pause", get label() { return t("game.padActions.pause"); } },
  { id: "mfd", get label() { return t("game.padActions.mfd"); } },
  { id: "mfdPage", get label() { return t("game.padActions.mfdPage"); } },
  { id: "hud", get label() { return t("game.padActions.hud"); } },
  { id: "board", get label() { return t("game.padActions.board"); } },
  // One button for both, as GT7's L3 carries the switch and the flash: a tap flashes, a hold switches them on or off
  // (headlight-button.ts)
  { id: "headlights", get label() { return t("game.padActions.headlights"); } },
  { id: "headlightFlash", get label() { return t("game.padActions.headlightFlash"); } },
];

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  steerLeft: ["KeyA", "ArrowLeft"],
  steerRight: ["KeyD", "ArrowRight"],
  boostHold: ["Space", "ShiftLeft", "ShiftRight"],
  boostLatch: ["KeyB"],
  // The one free key by the left hand (EA's M is the mute here)
  overtake: ["KeyZ"],
  aero: ["KeyX"],
  shiftUp: ["KeyE"],
  shiftDown: ["KeyQ"],
  neutral: ["KeyN"],
  camera: ["KeyC"],
  freeCamera: ["F7"],
  tvCamera: ["F8"],
  racingLine: ["KeyR"],
  mute: ["KeyM"],
  // N is Neutral: K, free in the car and in the menus
  nextTrack: ["KeyK"],
  autopilot: ["KeyP"],
  mouseSteer: ["KeyV"],
  restart: ["Backspace"],
  // Outside a race: the lap starts over at speed (in a race it does nothing)
  flyingLap: ["KeyL"],
  throttleHalf: ["KeyF"],
  // Beside Half throttle
  brakeHalf: ["KeyG"],
  // No key: the clutch is the car's own until a player wants it
  clutch: [],
  replay: ["KeyT"],
  mfdPage: ["Insert", "KeyI"],
  mfd: ["KeyO"],
  hud: ["KeyH"],
  // Beside the HUD's own key, away from L (which restarts the lap)
  board: ["KeyJ"],
  headlights: ["KeyU"],
  // Beside the headlights' own key (on QWERTZ the key printed Z, still beside U)
  headlightFlash: ["KeyY"],
};

/** Keys that cannot be bound: Esc opens the menu, "/" starts the /boost command */
export const RESERVED_CODES: ReadonlySet<string> = new Set(["Escape", "Slash"]);

/** Standard-mapping controller buttons (Xbox layout names) */
export type PadButtonBindings = Record<PadAction, number | null>;

/**
 * Gears on the bumpers, the layout every controller had before GT style became the default (17 Nov 2026). A saved
 * button map dates from then at the latest, so an action missing from one falls back to this, not to the new default.
 */
export const BUMPER_SHIFT_BUTTONS: PadButtonBindings = {
  boost: 0, // A
  overtake: null,
  aero: 2, // X
  camera: 3, // Y
  shiftDown: 4, // LB
  shiftUp: 5, // RB
  // Gear up and gear down pressed together are neutral too, on every layout
  neutral: null,
  racingLine: null,
  restart: 8, // View
  flyingLap: null,
  pause: 9, // Menu
  mfd: 10, // LS click (L3)
  mfdPage: 1, // B
  hud: 11, // RS click (R3)
  // Every button has a job already: a player can give it one
  board: null,
  headlights: null,
  headlightFlash: null,
  freeCamera: null,
  tvCamera: null,
};

/**
 * Gran Turismo 7: ✕ up, □ down, R1 change view, R3 nitro / overtake, L3 headlights (the switch and the flash on the
 * one button), Options pause. The right thumb is free in a drive. L3 was the MFD's own button: the MFD has none now,
 * since a D-pad press opens it and it folds itself away again
 */
export const GT_STYLE_BUTTONS: PadButtonBindings = {
  shiftUp: 0, // A (✕)
  shiftDown: 2, // X (□)
  // Gear up and gear down pressed together are neutral too, on every layout
  neutral: null,
  boost: 11, // RS (R3)
  // Every button has a job: bind one, or let the assist use it (GT7 has one nitro / overtake button)
  overtake: null,
  camera: 5, // RB (R1)
  pause: 9, // Menu (Options)
  restart: 8, // View (Create)
  flyingLap: null,
  aero: 3, // Y (△)
  headlights: 10, // LS (L3)
  mfd: null,
  mfdPage: 1, // B (○)
  hud: 4, // LB (L1)
  racingLine: null,
  board: null,
  headlightFlash: null,
  freeCamera: null,
  tvCamera: null,
};

/**
 * GT style as it was until 22 Nov 2026 (L3 the MFD, no headlights). A saved map that is exactly this is a player who
 * picked GT style (or kept the default) then, and moves on to GT style as it is now (parsePlayerSettings)
 */
export const RETIRED_GT_STYLE_BUTTONS: PadButtonBindings = {
  ...GT_STYLE_BUTTONS,
  headlights: null,
  mfd: 10,
};

/** A new player's buttons: GT style, gears under the right thumb, which also holds Gear up as the clutch at a manual start */
export const DEFAULT_PAD_BUTTONS: PadButtonBindings = GT_STYLE_BUTTONS;

/** Fixed standard-mapping buttons: the triggers, the stick clicks */
export const PAD_THROTTLE_BUTTON = 7; // RT
export const PAD_BRAKE_BUTTON = 6; // LT
export const PAD_LEFT_STICK_BUTTON = 10; // LS (L3)
export const PAD_RIGHT_STICK_BUTTON = 11; // RS (R3)

/**
 * The pedals a controller drives. Each one reads from its own source ({@link PadPedalSources}), so another pedal
 * joins by adding its id here, a source in the saved map and a label. The clutch is 0..1 with 1 pressed (open), and
 * has no source until the player gives it one.
 */
export type PadPedal = "throttle" | "brake" | "clutch";
export const PAD_PEDALS = ["throttle", "brake", "clutch"] as const satisfies readonly PadPedal[];
export const PAD_PEDAL_LABELS: Record<PadPedal, string> = {
  get throttle() { return t("game.pedals.throttle"); },
  get brake() { return t("game.pedals.brake"); },
  get clutch() { return t("game.pedals.clutch"); },
};

/**
 * Where one pedal is read on a standard-mapping controller: an analogue button's travel (a trigger), or one half of a
 * stick axis (sign −1 the up / left half, 1 the down / right half; Gamepad API axes are + right / down)
 */
export type PadPedalSource = { kind: "button"; button: number } | { kind: "axis"; axis: number; sign: -1 | 1 };

/** Each pedal's source; null leaves that pedal off the controller (it reads 0) */
export type PadPedalSources = Record<PadPedal, PadPedalSource | null>;

/** The ready-made throttle / brake pairs the controller screen offers */
export type PadPedalSet = "triggers" | "stick";
export const PAD_PEDAL_SETS: Record<PadPedalSet, Pick<PadPedalSources, "throttle" | "brake">> = {
  triggers: { throttle: { kind: "button", button: PAD_THROTTLE_BUTTON }, brake: { kind: "button", button: PAD_BRAKE_BUTTON } },
  // Right stick, vertical: up throttle, down brake (classic Gran Turismo on a pad)
  stick: { throttle: { kind: "axis", axis: 3, sign: -1 }, brake: { kind: "axis", axis: 3, sign: 1 } },
};
export const PAD_PEDAL_SET_IDS = Object.keys(PAD_PEDAL_SETS) as PadPedalSet[];
export const DEFAULT_PAD_PEDAL_SOURCES: PadPedalSources = { ...PAD_PEDAL_SETS.triggers, clutch: null };

export const samePedalSource = (a: PadPedalSource | null, b: PadPedalSource | null): boolean =>
  a === null || b === null
    ? a === b
    : a.kind === "button"
      ? b.kind === "button" && a.button === b.button
      : b.kind === "axis" && a.axis === b.axis && a.sign === b.sign;

/** The ready-made set the throttle and brake are on (other pedals are not part of a set), or null */
export function matchPedalSet(sources: PadPedalSources): PadPedalSet | null {
  return (
    PAD_PEDAL_SET_IDS.find((id) =>
      (Object.keys(PAD_PEDAL_SETS[id]) as (keyof (typeof PAD_PEDAL_SETS)[PadPedalSet])[]).every((p) =>
        samePedalSource(sources[p], PAD_PEDAL_SETS[id][p]),
      ),
    ) ?? null
  );
}

/** `sources` with a ready-made set's throttle and brake; any other pedal keeps its own */
export const withPedalSet = (sources: PadPedalSources, set: PadPedalSet): PadPedalSources => ({ ...sources, ...PAD_PEDAL_SETS[set] });

/** The pedal a button drives, if any: a button that is a pedal can do nothing else */
export const pedalOnButton = (sources: PadPedalSources, button: number): PadPedal | null =>
  PAD_PEDALS.find((p) => {
    const s = sources[p];
    return s?.kind === "button" && s.button === button;
  }) ?? null;

/** The stick click under each pedal stick's thumb (a firm push on the stick can press it) */
export function pedalStickClicks(sources: PadPedalSources): number[] {
  const clicks = new Set<number>();
  for (const p of PAD_PEDALS) {
    const s = sources[p];
    if (s?.kind === "axis") clicks.add(s.axis < 2 ? PAD_LEFT_STICK_BUTTON : PAD_RIGHT_STICK_BUTTON);
  }
  return [...clicks];
}

/** Both triggers are their usual pedals (throttle RT, brake LT): what trigger rumble and adaptive triggers act on */
export const pedalsOnTriggers = (sources: PadPedalSources): boolean =>
  pedalOnButton(sources, PAD_THROTTLE_BUTTON) === "throttle" && pedalOnButton(sources, PAD_BRAKE_BUTTON) === "brake";

/** Where a pedal is read, in words: "trigger" (RT / LT), "right stick up", another button's name, or "not set" */
export function pedalSourceText(source: PadPedalSource | null): string {
  const words = sourceWords();
  if (!source) return words.notSet;
  if (source.kind === "button") {
    return source.button === PAD_THROTTLE_BUTTON || source.button === PAD_BRAKE_BUTTON ? words.trigger : padButtonLabel(source.button);
  }
  const { side, way } = stickWay(source);
  return words.stick[side][way];
}

const STICK_WAYS = ["up", "down", "left", "right"] as const;
const stickWords = (side: "left" | "right") =>
  Object.fromEntries(STICK_WAYS.map((way) => [way, t("game.pedals.stick", { side, way })])) as Record<(typeof STICK_WAYS)[number], string>;

/** The words for where a pedal is read, once per language: the start cue asks for the clutch's every frame */
const sourceWords = perLanguage(() => ({
  notSet: t("game.pedals.notSet"),
  trigger: t("game.pedals.trigger"),
  stick: { left: stickWords("left"), right: stickWords("right") },
  clutchPedal: t("game.pedals.clutchPedal"),
}));

/** Which stick and which way a stick pedal is pushed, for the messages that say it */
function stickWay(source: Extract<PadPedalSource, { kind: "axis" }>): { side: "left" | "right"; way: "up" | "down" | "left" | "right" } {
  const vertical = source.axis % 2 === 1;
  const way = vertical ? (source.sign < 0 ? "up" : "down") : source.sign < 0 ? "left" : "right";
  return { side: source.axis < 2 ? "left" : "right", way };
}

/** How to press a pedal, for a prompt: "Hold RT", "Push the right stick up" */
export const pressPedalText = (source: PadPedalSource | null): string =>
  !source
    ? t("game.pedals.pressThrottle")
    : source.kind === "button"
      ? t("game.pedals.holdButton", { button: padButtonLabel(source.button) })
      : t("game.pedals.pushStick", stickWay(source));

/** `bindings` with every action on a pedal's button unbound (the same object when there is none) */
export function freePedalButtons(bindings: PadButtonBindings, sources: PadPedalSources): PadButtonBindings {
  const taken = (button: number | null) => button !== null && pedalOnButton(sources, button) !== null;
  if (!PAD_ACTIONS.some(({ id }) => taken(bindings[id]))) return bindings;
  const next = { ...bindings };
  for (const { id } of PAD_ACTIONS) if (taken(next[id])) next[id] = null;
  return next;
}

/** Ready-made controller layouts, after the defaults of the racing games players come from */
export type PadLayout = "gt" | "gtClassic" | "f1" | "forza" | "bumper";

/**
 * Each layout puts what its game has on the same buttons (standard mapping; Xbox names, PlayStation in brackets). An
 * action the game lacks keeps its Bumper shift button when that one is free, else takes a free one. All of them
 * leave the D-pad (the MFD's dials) alone, keep Menu on pause and restart on View: restart is not a rewind, and it must
 * not sit under a thumb. A layout also names its throttle / brake set: the trigger layouts leave RT / LT to them, the
 * stick layout shifts on them and leaves R3 free, since the thumb on the pedal stick can click it.
 */
export const PAD_LAYOUTS: Record<PadLayout, { label: string; pedals: PadPedalSet; buttons: PadButtonBindings }> = {
  // The default
  gt: { get label() { return t("game.padLayouts.gt"); }, pedals: "triggers", buttons: GT_STYLE_BUTTONS },
  // Classic Gran Turismo on a pad: right stick up throttle, down brake, R2 up, L2 down; the rest as GT style, with
  // the boost off R3 (now under the pedal thumb) onto ✕ and the HUD onto □, so L1 and the left stick's up / down
  // stay free (a clutch or a starter can go there). No headlight button found in GT4 to GT6, so none here
  gtClassic: {
    get label() { return t("game.padLayouts.gtClassic"); },
    pedals: "stick",
    buttons: {
      shiftUp: 7, // RT (R2)
      shiftDown: 6, // LT (L2)
      neutral: null,
      boost: 0, // A (✕)
      overtake: null,
      camera: 5, // RB (R1)
      pause: 9, // Menu (Options)
      restart: 8, // View (Create)
      flyingLap: null,
      aero: 3, // Y (△)
      mfd: 10, // LS (L3)
      mfdPage: 1, // B (○)
      hud: 2, // X (□)
      racingLine: null,
      board: null,
      headlights: null,
      headlightFlash: null,
      freeCamera: null,
      tvCamera: null,
    },
  },
  // F1 24: A up, X down, B overtake, Y DRS, RB next camera, Menu pause; F1 25's 2026 pack: LB its Overtake / Boost
  // (EA's controls hub), so Overtake there, and the MFD's pages on the D-pad that opens it. No headlight control found
  // in the F1 games
  f1: {
    get label() { return t("game.padLayouts.f1"); },
    pedals: "triggers",
    buttons: {
      shiftUp: 0, // A (✕)
      shiftDown: 2, // X (□)
      neutral: null,
      boost: 1, // B (○)
      overtake: 4, // LB (L1)
      aero: 3, // Y (△)
      camera: 5, // RB (R1)
      pause: 9, // Menu (Options)
      restart: 8, // View (Create)
      flyingLap: null,
      mfd: 10, // LS (L3)
      mfdPage: null,
      hud: 11, // RS (R3)
      racingLine: null,
      board: null,
      headlights: null,
      headlightFlash: null,
      freeCamera: null,
      tvCamera: null,
    },
  },
  // Forza: B up, X down (manual layout), RB switch camera, LS toggle convertible, Menu pause. No headlight control
  // found in Forza Motorsport (its players say the lights follow the time of day)
  forza: {
    get label() { return t("game.padLayouts.forza"); },
    pedals: "triggers",
    buttons: {
      shiftUp: 1, // B (○)
      shiftDown: 2, // X (□)
      neutral: null,
      boost: 0, // A (✕)
      overtake: null,
      camera: 5, // RB (R1)
      aero: 10, // LS (L3)
      pause: 9, // Menu (Options)
      restart: 8, // View (Create)
      flyingLap: null,
      mfd: 4, // LB (L1)
      mfdPage: 3, // Y (△)
      hud: 11, // RS (R3)
      racingLine: null,
      board: null,
      headlights: null,
      headlightFlash: null,
      freeCamera: null,
      tvCamera: null,
    },
  },
  // Gears on the bumpers: the default until 17 Nov 2026, so the layout most saved settings still have
  bumper: { get label() { return t("game.padLayouts.bumper"); }, pedals: "triggers", buttons: BUMPER_SHIFT_BUTTONS },
};

export const PAD_LAYOUT_IDS = Object.keys(PAD_LAYOUTS) as PadLayout[];

/**
 * Formula style as it was until 23 Nov 2026 (LB the MFD's pages, no Overtake button). A saved map that is exactly this
 * is a player who picked Formula style then, and moves on to it as it is now (parsePlayerSettings)
 */
export const RETIRED_FORMULA_STYLE_BUTTONS: PadButtonBindings = {
  ...PAD_LAYOUTS.f1.buttons,
  overtake: null,
  mfdPage: 4,
};

/** The ready-made layout these bindings and pedals are, or null once the player has rebound a button or moved the pedals */
export function matchPadLayout(bindings: PadButtonBindings, sources: PadPedalSources = DEFAULT_PAD_PEDAL_SOURCES): PadLayout | null {
  const set = matchPedalSet(sources);
  return (
    PAD_LAYOUT_IDS.find(
      (id) =>
        PAD_LAYOUTS[id].pedals === set &&
        PAD_ACTIONS.every(({ id: action }) => (bindings[action] ?? null) === PAD_LAYOUTS[id].buttons[action]),
    ) ?? null
  );
}

/** Window events the game loop fires for the HUD's own pad toggles (the MFD and the HUD listen for them) */
export const HUD_TOGGLE_EVENT = { mfd: "lc:toggle-mfd", mfdPage: "lc:mfd-page", hud: "lc:toggle-hud", board: "lc:toggle-board" } as const;

export const STANDARD_BUTTON_NAMES: Record<number, string> = {
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "LB",
  5: "RB",
  6: "LT",
  7: "RT",
  8: "View",
  9: "Menu",
  10: "LS",
  11: "RS",
  12: "D-pad ↑",
  13: "D-pad ↓",
  14: "D-pad ←",
  15: "D-pad →",
  16: "Home",
};

export const padButtonLabel = (button: number | null | undefined) =>
  button === null || button === undefined ? "—" : (STANDARD_BUTTON_NAMES[button] ?? t("game.pedals.button", { number: String(button) }));

/** Dead keys' combining accents, as the spacing characters printed on the key */
const DEAD_KEY_CAPS: Record<string, string> = {
  "̀": "`",
  "́": "´",
  "̂": "^",
  "̃": "~",
  "̈": "¨",
  "̊": "°",
  "̧": "¸",
};

/**
 * Readable label for a KeyboardEvent.code: the key as printed on the player's keyboard where the browser says (on
 * AZERTY, KeyW is "Z"), else its US name. The number row keeps its digits, which every layout prints on those keys.
 */
export function keyLabel(code: string | undefined): string {
  if (!code) return "—";
  const printed = code.startsWith("Digit") ? undefined : printedKey(code);
  // A dead key reports its combining accent: the cap shows the accent on its own (AZERTY's ^ key)
  if (printed && /^\p{M}$/u.test(printed) && DEAD_KEY_CAPS[printed]) return DEAD_KEY_CAPS[printed];
  // A space or an unknown combining mark prints nothing readable on a key cap. Upper case only where it keeps the
  // length: the German ß key would read "SS"
  if (printed && printed.trim() && !/^\p{M}+$/u.test(printed)) {
    const upper = printed.toUpperCase();
    return upper.length === printed.length ? upper : printed;
  }
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Space: "Space",
    ShiftLeft: "L-Shift",
    ShiftRight: "R-Shift",
    ControlLeft: "L-Ctrl",
    ControlRight: "R-Ctrl",
    AltLeft: "L-Alt",
    AltRight: "R-Alt",
    // Geist Mono has no ⌫: the word, so the key cap never falls back to another font
    Backspace: "Bksp",
    Enter: "Enter",
    Tab: "Tab",
    CapsLock: "Caps",
    Comma: ",",
    Period: ".",
    Semicolon: ";",
    Slash: "/",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Insert: "Ins",
    // Keys a US keyboard lacks (ISO, Japanese), named when the browser can't say what they print
    IntlBackslash: "ISO \\",
    IntlRo: "Ro",
    IntlYen: "Yen",
  };
  return named[code] ?? code;
}

/** code → action lookup for the key handlers */
export function buildKeyLookup(bindings: KeyBindings): Map<string, KeyAction> {
  const map = new Map<string, KeyAction>();
  for (const { id } of KEY_ACTIONS) {
    for (const code of bindings[id] ?? []) {
      if (code && !map.has(code)) map.set(code, id);
    }
  }
  return map;
}

/**
 * Binds `code` to `action`'s `slot`. A key already used elsewhere moves here, and the
 * binding it replaces moves to where that key was (a swap), so no action silently loses its key.
 */
export function rebindKey(bindings: KeyBindings, action: KeyAction, slot: number, code: string): KeyBindings {
  if (RESERVED_CODES.has(code)) return bindings;
  const next: KeyBindings = Object.fromEntries(
    Object.entries(bindings).map(([k, v]) => [k, [...v]])
  ) as KeyBindings;
  const previous = next[action][slot];
  for (const { id } of KEY_ACTIONS) {
    const idx = next[id].indexOf(code);
    if (idx === -1) continue;
    if (id === action && idx === slot) return bindings;
    if (previous) next[id][idx] = previous;
    else next[id].splice(idx, 1);
  }
  while (next[action].length <= slot) next[action].push("");
  next[action][slot] = code;
  next[action] = next[action].filter(Boolean);
  return next;
}

/** Removes the key in `action`'s `slot` */
export function clearKey(bindings: KeyBindings, action: KeyAction, slot: number): KeyBindings {
  const next = { ...bindings, [action]: bindings[action].filter((_, i) => i !== slot) };
  return next;
}

/** Binds a controller button; a button already used by another action is unbound there */
export function rebindPadButton(bindings: PadButtonBindings, action: PadAction, button: number): PadButtonBindings {
  const next = { ...bindings };
  for (const key of Object.keys(next) as PadAction[]) {
    if (next[key] === button) next[key] = null;
  }
  next[action] = button;
  return next;
}

/**
 * Whether the active input device has a clutch bound, plus the control prompt to display in the start / stall cue.
 * Scoped strictly to the active device so a leftover keyboard clutch binding never soft-locks a controller, wheel or
 * touch player whose own device has no clutch bound, while an idle plugged-in gamepad/HID never disables a keyboard
 * player's manual clutch.
 */
export function resolveActiveClutchBinding(params: {
  deviceSource: "wheel" | "controller" | "legacy" | null;
  touchActive: boolean;
  keyClutchCodes: readonly string[];
  padClutchSource: PadPedalSource | null;
  wheelClutchBound: boolean;
  settingsDevice?: "keyboard" | "controller" | "wheel";
  lastDrivingInput?: "keyboard" | "controller" | "wheel" | "touch" | null;
}): {
  bound: boolean;
  control: StartClutchControl | undefined;
  activeDevice: "keyboard" | "controller" | "wheel" | "touch";
} {
  if (params.touchActive) {
    return { bound: false, control: undefined, activeDevice: "touch" };
  }
  // Ignore stale lastDrivingInput if that device has since disconnected or been turned off
  const validLast =
    params.lastDrivingInput === "touch"
      ? null
      : (params.lastDrivingInput === "controller" || params.lastDrivingInput === "wheel") && params.deviceSource === null
        ? null
        : params.lastDrivingInput ?? null;

  let activeDevice: "keyboard" | "controller" | "wheel";
  if (validLast === "keyboard" || validLast === "controller" || validLast === "wheel") {
    activeDevice = validLast;
  } else if (params.deviceSource === "wheel") {
    activeDevice = "wheel";
  } else if (params.settingsDevice === "controller") {
    activeDevice = "controller";
  } else if (params.settingsDevice === "wheel") {
    activeDevice = "wheel";
  } else if (params.settingsDevice === "keyboard") {
    activeDevice = params.deviceSource === "legacy" && params.wheelClutchBound ? "wheel" : "keyboard";
  } else if (params.deviceSource === "controller") {
    activeDevice = "controller";
  } else if (params.deviceSource === "legacy") {
    activeDevice = "wheel";
  } else {
    activeDevice = "keyboard";
  }

  if (activeDevice === "controller") {
    if (params.padClutchSource === null) return { bound: false, control: undefined, activeDevice };
    const control: StartClutchControl =
      params.padClutchSource.kind === "button"
        ? { pad: params.padClutchSource.button }
        : { name: pedalSourceText(params.padClutchSource) };
    return { bound: true, control, activeDevice };
  }
  if (activeDevice === "wheel") {
    return params.wheelClutchBound
      ? { bound: true, control: { name: sourceWords().clutchPedal }, activeDevice }
      : { bound: false, control: undefined, activeDevice };
  }
  const firstKey = params.keyClutchCodes[0];
  return firstKey
    ? { bound: true, control: { key: keyLabel(firstKey) }, activeDevice }
    : { bound: false, control: undefined, activeDevice };
}
