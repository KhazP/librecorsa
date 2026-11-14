"use client";

import { useEffect, useRef } from "react";
import { connectedPads } from "@/lib/input/device-input";
import { isMenuNavSuspended, padKey } from "./useMenuNav";
import { notePadInput } from "./input-mode";

/**
 * Spatial focus navigation for a whole menu screen: the D-pad, left stick and arrow keys move the
 * real DOM focus to the nearest control in that direction, Ⓐ / Enter presses it, Ⓑ / Esc goes back,
 * LB / RB (or Q / E) switch tabs and Menu is the screen's main action. Sliders and drop-downs take
 * left / right as value changes. Every button, toggle and slider inside `root` is reachable without
 * any per-control wiring.
 *
 * Zones: put `data-nav-zone` on a group (the menu rail, a tab strip, a panel). Moving into a zone
 * returns to the control focused there last, and `focusZone()` jumps to it (used by Back).
 * `data-nav-default` (or `aria-pressed="true"` / `aria-selected="true"`) marks where a zone starts.
 */
export interface FocusNavOptions {
  enabled?: boolean;
  /** Ⓑ / Esc (Backspace too) */
  onBack?: () => void;
  /** Menu / Start */
  onStart?: () => void;
  /** LB / Q */
  onPrevTab?: () => void;
  /** RB / E */
  onNextTab?: () => void;
  /** Y (pad) / Y (key): the screen's one extra action, such as Settings' Simple / Advanced switch */
  onAlt?: () => void;
  /** Esc calls onBack (off where another handler owns Esc); Backspace always does */
  keyboardBack?: boolean;
  /** Focus a control when the screen opens (default true) */
  autoFocus?: boolean;
  /**
   * Delete / pad X put the focused setting row back to its default (its `[data-row-reset]` button). Off by default:
   * only Settings asks for it, so X and Delete do nothing in the Garage, first-run setup and the other menus.
   */
  rowReset?: boolean;
}

export type Dir = "up" | "down" | "left" | "right";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 360;
const REPEAT_RATE_MS = 110;

const lastInZone = new WeakMap<Element, HTMLElement>();

/**
 * The enabled screens, oldest first. Only the newest takes input: a screen opened over another (controls over the
 * pause menu, say) must not have one press drive both. Closing it hands input back to the one below.
 */
const owners: object[] = [];

/**
 * Back steps owned by a part of a screen (a browser's detail pane → its grid → closing it), asked before the screen's
 * own onBack: the newest first, and the first that returns true has handled Ⓑ / Esc. Each checks where the focus is
 * itself, so one only acts while the player is inside it.
 */
const backHandlers: (() => boolean)[] = [];

function interceptBack(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return true;
  return false;
}

/**
 * Moves owned by a part of a screen that knows its own layout better than the nearest-box search (a card grid walks
 * row by row). Asked newest first before the spatial move; true = handled. Each checks the focus is its own.
 */
const moveHandlers: ((dir: Dir) => boolean)[] = [];

/** Registers a move override (see `moveHandlers`) while mounted */
export function useMoveHandler(handler: (dir: Dir) => boolean): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = (dir: Dir) => ref.current(dir);
    moveHandlers.push(fn);
    return () => {
      const i = moveHandlers.lastIndexOf(fn);
      if (i >= 0) moveHandlers.splice(i, 1);
    };
  }, []);
}

/** Registers a back step (see `backHandlers`) while mounted and `enabled` */
export function useBackHandler(handler: () => boolean, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const fn = () => ref.current();
    backHandlers.push(fn);
    return () => {
      const i = backHandlers.lastIndexOf(fn);
      if (i >= 0) backHandlers.splice(i, 1);
    };
  }, [enabled]);
}

const isTextEntry = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "color"].includes(el.type));

/** A part the cursor can land on: not skipped, and not at tabindex -1 unless it is a roving option of a group */
const landable = (el: HTMLElement): boolean =>
  !el.closest("[data-nav-skip]") &&
  (el.tabIndex >= 0 || ["radio", "tab", "option"].includes(el.getAttribute("role") ?? ""));

/**
 * The box a control is seen as: the control alone in a settings row is the whole row (`data-setting-row`), so the
 * D-pad treats the row as the target; a visually-hidden input inside a label is the label. A row holding more than
 * one control the cursor can land on (a segmented row) keeps each control's own box, or they would share one box and
 * could not be told apart. A reset button is skipped by the cursor, so it does not count.
 */

function boxOf(el: HTMLElement): DOMRect {
  const row = el.closest("[data-setting-row]");
  // Counted as the cursor sees the row, so a reset button appearing beside a changed value does not change the box
  if (row && Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(landable).length === 1) {
    return row.getBoundingClientRect();
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) {
    const label = el.closest("label");
    if (label) return label.getBoundingClientRect();
  }
  return r;
}

function visible(el: HTMLElement): boolean {
  if (el.closest("[inert], [aria-hidden='true'], [data-nav-skip]")) return false;
  const box = boxOf(el);
  if (box.width === 0 && box.height === 0) return false;
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (check && !check.call(el.closest("label") ?? el, { visibilityProperty: true, opacityProperty: false })) return false;
  return true;
}

export function focusables(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

/**
 * What the Tab key itself stops on inside `root`, in order: shown, not inert, and not at tabindex -1 (a roving
 * option). Unlike `focusables`, it keeps parts the arrows skip (`data-nav-skip`), which Tab still reaches.
 */
export function tabStops(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest("[inert], [aria-hidden='true']")) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
    return !check || check.call(el.closest("label") ?? el, { visibilityProperty: true, opacityProperty: false });
  });
}

/** A remembered control can still take the focus: still there, shown, and not disabled since (greyed out mid-capture) */
const canResume = (el: HTMLElement | undefined): el is HTMLElement =>
  Boolean(el && el.isConnected && !el.matches(":disabled") && visible(el));

function focusEl(el: HTMLElement): void {
  (el.focus as (o?: { preventScroll?: boolean; focusVisible?: boolean }) => void)({ preventScroll: true, focusVisible: true });
  const target = el.closest("label") ?? el;
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The control a zone (or the root) starts on: its last focus, else its marked default, else its first */
function entryOf(zone: Element): HTMLElement | null {
  const last = lastInZone.get(zone);
  if (canResume(last) && zone.contains(last)) return last;
  const items = focusables(zone);
  return (
    items.find((e) => e.hasAttribute("data-nav-default")) ??
    items.find(
      (e) =>
        e.getAttribute("aria-selected") === "true" ||
        e.getAttribute("aria-pressed") === "true" ||
        e.getAttribute("aria-checked") === "true",
    ) ??
    items[0] ??
    null
  );
}

/**
 * Where a move into new ground lands: the outermost zone being entered resumes its last focus, else starts on its
 * marked default; a radio group is entered on the option it is set to (not whichever end is nearest).
 */
function landingFor(target: HTMLElement, active: HTMLElement, root: Element): HTMLElement {
  let entered: Element | null = null;
  let z: Element | null = target.closest("[data-nav-zone]");
  while (z && z !== root && root.contains(z) && !z.contains(active)) {
    entered = z;
    z = z.parentElement?.closest("[data-nav-zone]") ?? null;
  }
  if (entered) {
    const last = lastInZone.get(entered);
    if (canResume(last) && entered.contains(last)) return last;
    const def = focusables(entered).find((e) => e.hasAttribute("data-nav-default"));
    if (def) return def;
  }
  const group = target.closest('[role="radiogroup"]');
  if (group && !group.contains(active)) {
    const checked = focusables(group).find((e) => e.getAttribute("aria-checked") === "true");
    if (checked) return checked;
  }
  return target;
}

/** Moves the focus into a zone (by its `data-nav-zone` name) inside `root` */
export function focusZone(root: Element | null, name: string): boolean {
  const zone = root?.querySelector(`[data-nav-zone="${name}"]`);
  const el = zone ? entryOf(zone) : null;
  if (!el) return false;
  focusEl(el);
  return true;
}

/** True when the focus is inside the named zone */
export function focusInZone(root: Element | null, name: string): boolean {
  const zone = root?.querySelector(`[data-nav-zone="${name}"]`);
  return Boolean(zone && document.activeElement && zone.contains(document.activeElement));
}

/**
 * A control scrolled wholly out of its `data-nav-scroll` box (a card grid that scrolls on its own) is no target from
 * outside that box: it would be picked for its hidden position, behind the header above the grid.
 */
function scrolledAway(el: HTMLElement, from: Element): boolean {
  const box = el.closest("[data-nav-scroll]");
  if (!box || box.contains(from)) return false;
  const b = boxOf(el);
  const c = box.getBoundingClientRect();
  return b.bottom <= c.top || b.top >= c.bottom || b.right <= c.left || b.left >= c.right;
}

/** Nearest control from `from` in a direction: gap along the direction plus twice the sideways miss */
function nearest(from: HTMLElement, items: HTMLElement[], dir: Dir): HTMLElement | null {
  const a = boxOf(from);
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === from) continue;
    const b = boxOf(el);
    if (b.left === a.left && b.top === a.top && b.width === a.width && b.height === a.height) continue;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    let gap: number;
    let side: number;
    if (dir === "down" || dir === "up") {
      const ahead = dir === "down" ? by - ay : ay - by;
      if (ahead <= 2) continue;
      gap = Math.max(0, dir === "down" ? b.top - a.bottom : a.top - b.bottom);
      side = Math.max(0, b.left - a.right, a.left - b.right);
      if (side === 0) side = Math.abs(bx - ax) * 0.05;
    } else {
      const ahead = dir === "right" ? bx - ax : ax - bx;
      if (ahead <= 2) continue;
      gap = Math.max(0, dir === "right" ? b.left - a.right : a.left - b.right);
      side = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      if (side === 0) side = Math.abs(by - ay) * 0.05;
    }
    const score = gap + side * 2.5;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

/** Sets a form control's value so React's onChange fires */
function setNativeValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Left / right on a slider or drop-down changes its value; returns true when it did */
/**
 * Puts the focused setting back to its default: presses the row's own reset button (`[data-row-reset]` inside the
 * `[data-setting-row]` the focus is in). The button is kept out of the cursor's path, so left / right on a row only
 * ever change its value; Delete or Ⓧ is how keys and a pad reach it. False when the row has nothing to reset.
 */
function resetRow(): boolean {
  const reset = document.activeElement?.closest("[data-setting-row]")?.querySelector<HTMLElement>("[data-row-reset]");
  if (!reset) return false;
  reset.click();
  return true;
}

function adjust(el: Element | null, dir: Dir, big: boolean): boolean {
  if (dir !== "left" && dir !== "right") return false;
  const sign = dir === "right" ? 1 : -1;
  if (el instanceof HTMLInputElement && el.type === "range") {
    const step = Number(el.step) || 1;
    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const count = big ? Math.max(1, Math.round((max - min) / step / 10)) : 1;
    const next = Math.min(max, Math.max(min, Number(el.value) + sign * step * count));
    const decimals = (String(step).split(".")[1] ?? "").length;
    setNativeValue(el, next.toFixed(decimals));
    return true;
  }
  if (el instanceof HTMLSelectElement) {
    const i = Math.min(el.options.length - 1, Math.max(0, el.selectedIndex + sign));
    if (i !== el.selectedIndex) setNativeValue(el, el.options[i].value);
    return true;
  }
  return false;
}

/** A control whose own arrow keys change its value: an arrow with nowhere to go must still not reach it */
const ownsArrows = (el: Element | null): boolean =>
  el instanceof HTMLSelectElement ||
  (el instanceof HTMLInputElement && (el.type === "range" || el.type === "number" || el.type === "radio"));

/**
 * A drop-down's list is open, so its arrow keys are the list's. Where the browser says so (`:open`), that is the answer.
 * Otherwise only Firefox matters: it sends a key pressed in the open list to the page too, where Chrome and Safari keep
 * those keys to the list (and a flag set here would stick: the Esc that closed the list never arrives). For Firefox a
 * flag follows it: a press on the control opens it, so do Space, F4 and Alt + up / down; picking, Esc, Enter, Tab or
 * leaving the control closes it.
 */
const openSelector = typeof CSS !== "undefined" && CSS.supports?.("selector(:open)");
const firefox = typeof navigator !== "undefined" && /\bFirefox\//.test(navigator.userAgent);
let pickerOpen = false;
const listOpen = (el: HTMLSelectElement): boolean => (openSelector ? el.matches(":open") : firefox && pickerOpen);
if (typeof window !== "undefined" && !openSelector && firefox) {
  const onSelect = (e: Event) => e.target instanceof HTMLSelectElement;
  window.addEventListener("pointerdown", (e) => void (pickerOpen = onSelect(e)), { capture: true, passive: true });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!onSelect(e)) return;
      if (e.code === "Escape" || e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Tab") pickerOpen = false;
      else if (e.code === "Space") pickerOpen = true;
      else if (e.code === "F4" || (e.altKey && (e.code === "ArrowDown" || e.code === "ArrowUp"))) pickerOpen = !pickerOpen;
    },
    { capture: true },
  );
  for (const type of ["change", "focusout"] as const) {
    window.addEventListener(type, (e) => void (onSelect(e) && (pickerOpen = false)), { capture: true });
  }
}

/** Scrolls the nearest box that can scroll that way (the stick has no native scrolling to fall back on) */
function scrollPast(from: Element | null, dir: "up" | "down"): void {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const room = dir === "down" ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
    if (room < 1) continue;
    // About an arrow key's own pace while the stick is held (a step every repeat)
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ top: (dir === "down" ? 1 : -1) * Math.min(room, 120), behavior: still ? "auto" : "smooth" });
    return;
  }
}

export function useFocusNav(rootRef: React.RefObject<HTMLElement | null>, options: FocusNavOptions = {}) {
  const ref = useRef(options);
  ref.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const token = {};
    owners.push(token);
    const owns = () => owners[owners.length - 1] === token;
    const root = () => rootRef.current;
    /**
     * Esc / Ⓑ in a text field: stop typing and move the cursor to the next control (else the previous one). Focusing
     * the field itself again, as this used to, puts the caret straight back and the key does nothing.
     */
    const leaveTextField = (field: HTMLElement) => {
      field.blur();
      const r = root();
      if (!r) return;
      const list = focusables(r);
      const at = list.findIndex((x) => x === field || x.contains(field) || field.contains(x));
      const after = list.slice(at + 1).find((x) => !isTextEntry(x));
      const before = list.slice(0, Math.max(0, at)).reverse().find((x) => !isTextEntry(x));
      const next = after ?? before;
      if (next) focusEl(next);
    };

    const remember = (e: FocusEvent) => {
      const r = root();
      const t = e.target;
      if (!r || !(t instanceof HTMLElement) || !r.contains(t)) return;
      let z: Element | null = t.closest("[data-nav-zone]");
      while (z && r.contains(z)) {
        lastInZone.set(z, t);
        z = z.parentElement?.closest("[data-nav-zone]") ?? null;
      }
      lastInZone.set(r, t);
    };
    document.addEventListener("focusin", remember);

    /** Returns false when there was nothing in that direction (the key can scroll the page instead) */
    const move = (dir: Dir, big = false): boolean => {
      const r = root();
      if (!r) return false;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !r.contains(active) || active === r) {
        const el = entryOf(r);
        if (el) focusEl(el);
        return Boolean(el);
      }
      if (adjust(active, dir, big)) return true;
      for (let i = moveHandlers.length - 1; i >= 0; i--) if (moveHandlers[i](dir)) return true;
      const items = focusables(r).filter((el) => !scrolledAway(el, active));
      const target = nearest(active, items, dir);
      if (!target) return false;
      // Entering another zone resumes where that zone was left (or starts at its default)
      focusEl(landingFor(target, active, r));
      return true;
    };

    const press = () => {
      const r = root();
      const active = document.activeElement as HTMLElement | null;
      if (!r || !active || !r.contains(active)) {
        move("down");
        return;
      }
      if (isTextEntry(active)) {
        active.select?.();
        return;
      }
      if (active instanceof HTMLSelectElement || (active instanceof HTMLInputElement && active.type === "range")) return;
      active.click();
    };

    const goBack = () => {
      if (!interceptBack()) ref.current.onBack?.();
    };

    const onKey = (e: KeyboardEvent) => {
      if (isMenuNavSuspended() || e.defaultPrevented || !owns()) return;
      // Alt / Cmd + ← is the browser's Back, Ctrl + Q its own shortcut: none of them are menu keys (Shift is: big steps)
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const o = ref.current;
      const back = o.onBack || backHandlers.length ? goBack : undefined;
      const target = e.target as Element | null;
      const typing = isTextEntry(target) || target instanceof HTMLSelectElement;
      const call = (fn?: () => void) => {
        if (!fn) return;
        e.preventDefault();
        fn();
      };
      switch (e.code) {
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          // A text area's arrows move its caret, all four; Esc / Tab leave it
          if (target instanceof HTMLTextAreaElement) return;
          if (isTextEntry(target) && (e.code === "ArrowLeft" || e.code === "ArrowRight")) return;
          // A drop-down's open list takes the arrows; closed, up / down move on and left / right step its options
          if (target instanceof HTMLSelectElement && listOpen(target)) return;
          const dir = e.code.slice(5).toLowerCase() as Dir;
          // Nothing that way: the key scrolls the screen as it would anywhere else (not on a control whose own arrow
          // keys would change its value instead)
          if (move(dir, e.shiftKey) || ownsArrows(target)) e.preventDefault();
          return;
        }
        case "Enter":
        case "NumpadEnter":
          // Buttons press themselves; checkboxes and the rest need a nudge
          if (target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || typing) return;
          return call(press);
        case "Escape":
          if (o.keyboardBack === false) return;
          if (isTextEntry(target)) {
            leaveTextField(target as HTMLElement);
            e.preventDefault();
            return;
          }
          return call(back);
        case "Backspace":
          if (typing) return;
          return call(back);
        case "Delete":
          if (!o.rowReset || typing || e.repeat) return;
          if (resetRow()) e.preventDefault();
          return;
        case "KeyQ":
          if (typing || e.repeat) return;
          return call(o.onPrevTab);
        case "KeyE":
          if (typing || e.repeat) return;
          return call(o.onNextTab);
        case "KeyY":
          if (typing || e.repeat) return;
          return call(o.onAlt);
      }
    };
    window.addEventListener("keydown", onKey);

    // Controller: the first standard-mapping pad, button edges only (a button still held from the
    // previous screen does not fire), directions auto-repeat while held
    let raf = 0;
    let prev: boolean[] | null = null;
    // Which pad `prev` was read from: when the first pad changes (one of two unplugged), its buttons are a new baseline
    let prevPad: string | null = null;
    const repeatAt: number[] = [];
    const poll = (t: number) => {
      raf = requestAnimationFrame(poll);
      const pad = connectedPads().find((p) => p.mapping === "standard");
      if (!pad) {
        prev = null;
        prevPad = null;
        return;
      }
      if (padKey(pad) !== prevPad) {
        prev = null;
        prevPad = padKey(pad);
      }
      const ax = pad.axes;
      const down = (i: number) => Boolean(pad.buttons[i]?.pressed);
      // up, down, left, right, A, B, Menu, LB, RB, X, Y; LT/RT held: bigger slider steps
      const now = [
        down(12) || (ax[1] ?? 0) < -STICK_THRESHOLD,
        down(13) || (ax[1] ?? 0) > STICK_THRESHOLD,
        down(14) || (ax[0] ?? 0) < -STICK_THRESHOLD,
        down(15) || (ax[0] ?? 0) > STICK_THRESHOLD,
        down(0),
        down(1),
        down(9),
        down(4),
        down(5),
        down(2),
        down(3),
      ];
      // Not the screen on top: keep the baseline current, so a button held as it takes over does not fire
      if (prev === null || isMenuNavSuspended() || !owns()) {
        prev = now;
        return;
      }
      if (now.some((d, i) => d && !prev![i])) notePadInput(pad.id);
      const big = down(6) || down(7);
      const o = ref.current;
      const dirs: Dir[] = ["up", "down", "left", "right"];
      const handlers: (() => void)[] = [
        ...dirs.map((d) => () => {
          // Past the last control up or down, the stick scrolls on to the text below (or above) it
          if (!move(d, big) && (d === "up" || d === "down")) scrollPast(document.activeElement ?? root(), d);
        }),
        press,
        () => {
          // Ⓑ in a text field just leaves the field
          const a = document.activeElement;
          if (isTextEntry(a)) {
            leaveTextField(a as HTMLElement);
            return;
          }
          goBack();
        },
        () => o.onStart?.(),
        () => o.onPrevTab?.(),
        () => o.onNextTab?.(),
        () => void (o.rowReset && resetRow()),
        () => o.onAlt?.(),
      ];
      now.forEach((isDown, i) => {
        if (isDown && !prev![i]) {
          handlers[i]();
          repeatAt[i] = t + REPEAT_DELAY_MS;
        } else if (isDown && i < 4 && t >= (repeatAt[i] ?? Infinity)) {
          handlers[i]();
          repeatAt[i] = t + REPEAT_RATE_MS;
        }
      });
      prev = now;
    };
    raf = requestAnimationFrame(poll);

    // Start on the screen's default control so a controller has a visible focus at once
    if (ref.current.autoFocus !== false) {
      requestAnimationFrame(() => {
        const r = root();
        if (!r || (document.activeElement && r.contains(document.activeElement))) return;
        const el = entryOf(r);
        if (el) (el.focus as (o?: object) => void)({ preventScroll: true });
      });
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", remember);
      const i = owners.lastIndexOf(token);
      if (i >= 0) owners.splice(i, 1);
    };
  }, [enabled, rootRef]);
}

/**
 * Where the mouse last really moved to. A layout change (a panel opening reflows the rail) slides a new control under
 * a resting pointer and the browser sends it a pointerenter at the same spot: that is not the player pointing at it.
 */
let lastMove: { x: number; y: number } | null = null;
if (typeof window !== "undefined") {
  const note = (e: PointerEvent) => {
    if (e.pointerType === "mouse") lastMove = { x: e.clientX, y: e.clientY };
  };
  // A press counts too: the click that opens a panel is where the pointer rests while the rail reflows under it
  for (const type of ["pointermove", "pointerdown"] as const) window.addEventListener(type, note, { capture: true, passive: true });
}

/** Focuses a control under the pointer (hover and focus are the same highlight in the menus) */
export function focusOnHover(e: React.PointerEvent<HTMLElement>): void {
  if (e.pointerType !== "mouse") return;
  if (lastMove && lastMove.x === e.clientX && lastMove.y === e.clientY) return;
  const active = document.activeElement;
  if (isTextEntry(active) || active instanceof HTMLSelectElement) return;
  if (active !== e.currentTarget) (e.currentTarget.focus as (o?: object) => void)({ preventScroll: true });
}
