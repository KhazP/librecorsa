/**
 * Shared class recipes of the UI standard (spec §4 "Chosen vs cursor"). Every control builds its states from these,
 * so a chosen pill, the cursor and a disabled part look the same on every screen.
 *
 * Each cursor recipe has a `data-cursor` twin: the kit forces the cursor on a part with `data-cursor` so it shows
 * without a controller, and only one element on a page can really hold the focus.
 */

/** Joins class names, dropping the empty ones */
export const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

/** One timing for every state change: 200 ms on the house curve */
export const MOTION = "transition-[background-color,border-color,box-shadow,color,opacity] duration-200 ease-lc";

/** A pill, segment or tab the setting is on: raised, white text, a lit hairline */
export const CHOSEN_PILL = "bg-lc-line text-lc-chalk inset-ring inset-ring-white/28";

/** A pill under the pointer without the focus (never volt) */
export const HOVER_PILL = "hover:bg-white/4 hover:text-lc-chalk";

/** The cursor on a pill, segment or tab: the volt fill with void ink and the halo. Wins over chosen. */
export const CURSOR_PILL = cx(
  "outline-none focus-visible:outline-none",
  "focus:bg-lc-volt focus:text-lc-void focus:inset-ring-transparent focus:shadow-lc-focus",
  "data-cursor:bg-lc-volt data-cursor:text-lc-void data-cursor:inset-ring-transparent data-cursor:shadow-lc-focus",
);

/** Pressed: one step darker, chosen and cursor alike */
export const PRESSED_PILL = "active:bg-lc-titanium focus:active:bg-lc-volt-dim data-cursor:active:bg-lc-volt-dim";

/** A tile the setting is on: a 1.5 px white edge */
export const CHOSEN_TILE = "border-lc-chalk/60 bg-white/5";

/** A tile that is not chosen (same 1.5 px edge width, so nothing moves when it is picked) */
export const IDLE_TILE = "border-lc-line bg-transparent hover:border-lc-keyline hover:bg-white/3";

/** The cursor on a tile: the volt edge and the halo */
export const CURSOR_TILE = cx(
  "outline-none focus-visible:outline-none",
  "focus:border-lc-volt focus:inset-ring focus:inset-ring-lc-volt focus:shadow-lc-focus",
  "data-cursor:border-lc-volt data-cursor:inset-ring data-cursor:inset-ring-lc-volt data-cursor:shadow-lc-focus",
);

/** The cursor on a full-width row-like button (Disclosure): the row ring, 2 px volt outline and a 6 % volt tint */
export const CURSOR_ROW = cx(
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lc-volt focus-visible:bg-lc-volt/6",
  "in-data-[input=pad]:focus:outline-2 in-data-[input=pad]:focus:outline-offset-1 in-data-[input=pad]:focus:outline-lc-volt in-data-[input=pad]:focus:bg-lc-volt/6 in-data-[input=pad]:focus:shadow-none",
  "data-cursor:outline-2 data-cursor:outline-solid data-cursor:outline-offset-1 data-cursor:outline-lc-volt data-cursor:bg-lc-volt/6",
);

/** Disabled, one recipe everywhere: native `disabled` or `aria-disabled` */
export const DISABLED =
  "disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

/** Touch screens get 44 px targets */
export const TOUCH_TARGET = "pointer-coarse:min-h-11";

/** Ink for a child of a `group` element under the cursor (an icon or count inside a volt pill) */
export const GROUP_CURSOR_INK = "group-focus:text-lc-void group-data-cursor:text-lc-void";

/** Named tones (spec §1 semantic colour) */
export type Tone = "neutral" | "player" | "info" | "good" | "best" | "warn" | "bad";

/** A tone's text colour */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-lc-slate",
  player: "text-lc-volt",
  info: "text-lc-info",
  good: "text-lc-gain",
  best: "text-lc-best",
  warn: "text-lc-caution",
  bad: "text-lc-loss",
};

/** A tone's fill */
export const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-lc-fog",
  player: "bg-lc-volt",
  info: "bg-lc-info",
  good: "bg-lc-gain",
  best: "bg-lc-best",
  warn: "bg-lc-caution",
  bad: "bg-lc-loss",
};

/** A tone's 1 px hairline (inset, so it never changes a part's size) */
export const TONE_HAIRLINE: Record<Tone, string> = {
  neutral: "inset-ring inset-ring-lc-line",
  player: "inset-ring inset-ring-lc-volt/50",
  info: "inset-ring inset-ring-lc-info/50",
  good: "inset-ring inset-ring-lc-gain/50",
  best: "inset-ring inset-ring-lc-best/50",
  warn: "inset-ring inset-ring-lc-caution/50",
  bad: "inset-ring inset-ring-lc-loss/50",
};

/**
 * The zoom a menu root applies to `el` (1 outside a zoomed root): the screen-size step times the player's own
 * interface size, as `.lc-ui-zoom` multiplies them. Divide window pixels by it.
 */
export function uiZoomOf(el: Element | null): number {
  if (!el || typeof window === "undefined" || !el.closest(".lc-ui-zoom")) return 1;
  const style = getComputedStyle(document.documentElement);
  const z = parseFloat(style.getPropertyValue("--lc-ui-zoom"));
  const user = parseFloat(style.getPropertyValue("--lc-ui-scale"));
  return (Number.isFinite(z) && z > 0 ? z : 1) * (Number.isFinite(user) && user > 0 ? user : 1);
}
