/**
 * Rebindable controls: keyboard codes and controller / wheel buttons per action.
 * The defaults reproduce the original hard-coded layout exactly.
 */

export type KeyAction =
  | "throttle"
  | "brake"
  | "steerLeft"
  | "steerRight"
  | "boostHold"
  | "boostLatch"
  | "aero"
  | "shiftUp"
  | "shiftDown"
  | "neutral"
  | "camera"
  | "racingLine"
  | "mute"
  | "autopilot"
  | "mouseSteer"
  | "restart"
  | "flyingLap"
  | "throttleHalf"
  | "clutch"
  | "replay"
  | "mfdPage"
  | "mfd"
  | "hud"
  | "board";

/** Actions a controller or wheel button can trigger */
export type PadAction =
  | "boost"
  | "aero"
  | "shiftUp"
  | "shiftDown"
  | "neutral"
  | "camera"
  | "racingLine"
  | "restart"
  | "flyingLap"
  | "pause"
  | "mfd"
  | "mfdPage"
  | "hud"
  | "board";

export type KeyBindings = Record<KeyAction, string[]>;

/** Each action shows a primary and an alternative key (more when the defaults have them) */
export const KEY_SLOTS = 2;

export const KEY_ACTIONS: readonly { id: KeyAction; label: string }[] = [
  { id: "throttle", label: "Throttle" },
  { id: "brake", label: "Brake" },
  { id: "steerLeft", label: "Steer left" },
  { id: "steerRight", label: "Steer right" },
  { id: "boostHold", label: "Boost (hold)" },
  { id: "boostLatch", label: "Boost (latch)" },
  { id: "aero", label: "Active aero X / Z" },
  { id: "shiftUp", label: "Gear up" },
  { id: "shiftDown", label: "Gear down" },
  { id: "neutral", label: "Neutral" },
  { id: "camera", label: "Camera (hold: seat & camera)" },
  { id: "racingLine", label: "Racing line" },
  { id: "mute", label: "Mute" },
  { id: "autopilot", label: "Autopilot" },
  { id: "mouseSteer", label: "Mouse steering" },
  { id: "restart", label: "Restart" },
  { id: "flyingLap", label: "Restart lap (flying start)" },
  { id: "throttleHalf", label: "Half throttle (hold)" },
  { id: "clutch", label: "Clutch (hold)" },
  { id: "replay", label: "Instant replay" },
  { id: "mfdPage", label: "Next MFD page" },
  { id: "mfd", label: "Open / close MFD" },
  { id: "hud", label: "Show / hide HUD" },
  { id: "board", label: "Open / close lap board" },
];

export const PAD_ACTIONS: readonly { id: PadAction; label: string }[] = [
  { id: "shiftUp", label: "Gear up" },
  { id: "shiftDown", label: "Gear down" },
  { id: "neutral", label: "Neutral" },
  { id: "boost", label: "Boost" },
  { id: "aero", label: "Active aero X / Z" },
  { id: "camera", label: "Camera (hold: seat & camera)" },
  { id: "racingLine", label: "Racing line" },
  { id: "restart", label: "Restart" },
  { id: "flyingLap", label: "Restart lap (flying start)" },
  { id: "pause", label: "Pause menu" },
  { id: "mfd", label: "Open / close MFD" },
  { id: "mfdPage", label: "Next MFD page" },
  { id: "hud", label: "Show / hide HUD" },
  { id: "board", label: "Open / close lap board" },
];

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  steerLeft: ["KeyA", "ArrowLeft"],
  steerRight: ["KeyD", "ArrowRight"],
  boostHold: ["Space", "ShiftLeft", "ShiftRight"],
  boostLatch: ["KeyB"],
  aero: ["KeyX"],
  shiftUp: ["KeyE"],
  shiftDown: ["KeyQ"],
  neutral: ["KeyN"],
  camera: ["KeyC"],
  racingLine: ["KeyR"],
  mute: ["KeyM"],
  autopilot: ["KeyP"],
  mouseSteer: ["KeyV"],
  restart: ["Backspace"],
  // Outside a race: the lap starts over at speed (in a race it does nothing)
  flyingLap: ["KeyL"],
  throttleHalf: ["KeyF"],
  // No key: the clutch is the car's own until a player wants it
  clutch: [],
  replay: ["KeyT"],
  mfdPage: ["Insert", "KeyI"],
  mfd: ["KeyO"],
  hud: ["KeyH"],
  // Beside the HUD's own key, away from L (which restarts the lap)
  board: ["KeyJ"],
};

/** Keys that cannot be bound: Esc opens the menu, "/" starts the /boost command */
export const RESERVED_CODES: ReadonlySet<string> = new Set(["Escape", "Slash"]);

/** Standard-mapping controller buttons (Xbox layout names) */
export type PadButtonBindings = Record<PadAction, number | null>;

export const DEFAULT_PAD_BUTTONS: PadButtonBindings = {
  boost: 0, // A
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
};

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
export const PAD_PEDAL_LABELS: Record<PadPedal, string> = { throttle: "Throttle", brake: "Brake", clutch: "Clutch" };

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
  if (!source) return "not set";
  if (source.kind === "button") {
    return source.button === PAD_THROTTLE_BUTTON || source.button === PAD_BRAKE_BUTTON ? "trigger" : padButtonLabel(source.button);
  }
  const vertical = source.axis % 2 === 1;
  const way = vertical ? (source.sign < 0 ? "up" : "down") : source.sign < 0 ? "left" : "right";
  return `${source.axis < 2 ? "left" : "right"} stick ${way}`;
}

/** How to press a pedal, for a prompt: "Hold RT", "Push the right stick up" */
export const pressPedalText = (source: PadPedalSource | null): string =>
  !source ? "Press the throttle" : source.kind === "button" ? `Hold ${padButtonLabel(source.button)}` : `Push the ${pedalSourceText(source)}`;

/** `bindings` with every action on a pedal's button unbound (the same object when there is none) */
export function freePedalButtons(bindings: PadButtonBindings, sources: PadPedalSources): PadButtonBindings {
  const taken = (button: number | null) => button !== null && pedalOnButton(sources, button) !== null;
  if (!PAD_ACTIONS.some(({ id }) => taken(bindings[id]))) return bindings;
  const next = { ...bindings };
  for (const { id } of PAD_ACTIONS) if (taken(next[id])) next[id] = null;
  return next;
}

/** Ready-made controller layouts, after the defaults of the racing games players come from */
export type PadLayout = "default" | "gt" | "gtClassic" | "f1" | "forza";

/**
 * Each layout puts what its game has on the same buttons (standard mapping; Xbox names, PlayStation in brackets). An
 * action the game lacks keeps its LibreCorsa default button when that one is free, else takes a free one. All of them
 * leave the D-pad (the MFD's dials) alone, keep Menu on pause and restart on View: restart is not a rewind, and it must
 * not sit under a thumb. A layout also names its throttle / brake set: the trigger layouts leave RT / LT to them, the
 * stick layout shifts on them and leaves R3 free, since the thumb on the pedal stick can click it.
 */
export const PAD_LAYOUTS: Record<PadLayout, { label: string; pedals: PadPedalSet; buttons: PadButtonBindings }> = {
  default: { label: "Default", pedals: "triggers", buttons: DEFAULT_PAD_BUTTONS },
  // Gran Turismo 7: ✕ up, □ down, R1 change view, R3 nitro / overtake, Options pause
  gt: {
    label: "GT style",
    pedals: "triggers",
    buttons: {
      shiftUp: 0, // A (✕)
      shiftDown: 2, // X (□)
      neutral: null,
      boost: 11, // RS (R3)
      camera: 5, // RB (R1)
      pause: 9, // Menu (Options)
      restart: 8, // View (Create)
      flyingLap: null,
      aero: 3, // Y (△)
      mfd: 10, // LS (L3)
      mfdPage: 1, // B (○)
      hud: 4, // LB (L1)
      racingLine: null,
      board: null,
    },
  },
  // Classic Gran Turismo on a pad: right stick up throttle, down brake, R2 up, L2 down; the rest as GT style, with
  // the boost off R3 (now under the pedal thumb) onto ✕ and the HUD onto □, so L1 and the left stick's up / down
  // stay free (a clutch or a starter can go there)
  gtClassic: {
    label: "GT classic",
    pedals: "stick",
    buttons: {
      shiftUp: 7, // RT (R2)
      shiftDown: 6, // LT (L2)
      neutral: null,
      boost: 0, // A (✕)
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
    },
  },
  // F1 24: A up, X down, B overtake, Y DRS, RB next camera, Menu pause
  f1: {
    label: "Formula style",
    pedals: "triggers",
    buttons: {
      shiftUp: 0, // A (✕)
      shiftDown: 2, // X (□)
      neutral: null,
      boost: 1, // B (○)
      aero: 3, // Y (△)
      camera: 5, // RB (R1)
      pause: 9, // Menu (Options)
      restart: 8, // View (Create)
      flyingLap: null,
      mfd: 10, // LS (L3)
      mfdPage: 4, // LB (L1)
      hud: 11, // RS (R3)
      racingLine: null,
      board: null,
    },
  },
  // Forza: B up, X down (manual layout), RB switch camera, LS toggle convertible, Menu pause
  forza: {
    label: "Forza style",
    pedals: "triggers",
    buttons: {
      shiftUp: 1, // B (○)
      shiftDown: 2, // X (□)
      neutral: null,
      boost: 0, // A (✕)
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
    },
  },
};

export const PAD_LAYOUT_IDS = Object.keys(PAD_LAYOUTS) as PadLayout[];

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
  button === null || button === undefined ? "—" : (STANDARD_BUTTON_NAMES[button] ?? `Button ${button}`);

/** Readable label for a KeyboardEvent.code */
export function keyLabel(code: string | undefined): string {
  if (!code) return "—";
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
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
    Insert: "Ins",
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
