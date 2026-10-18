"use client";

import { useEffect, useRef } from "react";
import { connectedPads } from "@/lib/input/device-input";
import { isMenuNavSuspended } from "./useMenuNav";
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
  /** Esc calls onBack (off where another handler owns Esc); Backspace always does */
  keyboardBack?: boolean;
  /** Focus a control when the screen opens (default true) */
  autoFocus?: boolean;
}

type Dir = "up" | "down" | "left" | "right";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 360;
const REPEAT_RATE_MS = 110;

const lastInZone = new WeakMap<Element, HTMLElement>();

const isTextEntry = (el: Element | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "color"].includes(el.type));

/** The box a control is seen as: a visually-hidden input inside a label is the label */
function boxOf(el: HTMLElement): DOMRect {
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

function zoneOf(el: Element, root: Element): Element {
  const z = el.closest("[data-nav-zone]");
  return z && root.contains(z) ? z : root;
}

function focusEl(el: HTMLElement): void {
  (el.focus as (o?: { preventScroll?: boolean; focusVisible?: boolean }) => void)({ preventScroll: true, focusVisible: true });
  const target = el.closest("label") ?? el;
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** The control a zone (or the root) starts on: its last focus, else its marked default, else its first */
function entryOf(zone: Element): HTMLElement | null {
  const last = lastInZone.get(zone);
  if (last && last.isConnected && zone.contains(last) && visible(last)) return last;
  const items = focusables(zone);
  return (
    items.find((e) => e.hasAttribute("data-nav-default")) ??
    items.find((e) => e.getAttribute("aria-selected") === "true" || e.getAttribute("aria-pressed") === "true") ??
    items[0] ??
    null
  );
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

export function useFocusNav(rootRef: React.RefObject<HTMLElement | null>, options: FocusNavOptions = {}) {
  const ref = useRef(options);
  ref.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const root = () => rootRef.current;

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

    const move = (dir: Dir, big = false) => {
      const r = root();
      if (!r) return;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !r.contains(active) || active === r) {
        const el = entryOf(r);
        if (el) focusEl(el);
        return;
      }
      if (adjust(active, dir, big)) return;
      const items = focusables(r);
      const target = nearest(active, items, dir);
      if (!target) return;
      // Entering another zone resumes where that zone was left
      const fromZone = zoneOf(active, r);
      const toZone = zoneOf(target, r);
      if (toZone !== fromZone && toZone !== r && !toZone.contains(active)) {
        const entry = lastInZone.get(toZone);
        if (entry && entry.isConnected && visible(entry)) return focusEl(entry);
      }
      focusEl(target);
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

    const onKey = (e: KeyboardEvent) => {
      if (isMenuNavSuspended() || e.defaultPrevented) return;
      const o = ref.current;
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
          if (isTextEntry(target) && (e.code === "ArrowLeft" || e.code === "ArrowRight")) return;
          if (target instanceof HTMLSelectElement && (e.code === "ArrowUp" || e.code === "ArrowDown")) return;
          e.preventDefault();
          const dir = e.code.slice(5).toLowerCase() as Dir;
          move(dir, e.shiftKey);
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
            (target as HTMLElement).blur();
            const r = root();
            if (r && target) {
              const el = target.closest("label") ?? target;
              const f = focusables(r).find((x) => x === target || el.contains(x));
              if (f) focusEl(f);
            }
            e.preventDefault();
            return;
          }
          return call(o.onBack);
        case "Backspace":
          if (typing) return;
          return call(o.onBack);
        case "KeyQ":
          if (typing || e.repeat) return;
          return call(o.onPrevTab);
        case "KeyE":
          if (typing || e.repeat) return;
          return call(o.onNextTab);
      }
    };
    window.addEventListener("keydown", onKey);

    // Controller: the first standard-mapping pad, button edges only (a button still held from the
    // previous screen does not fire), directions auto-repeat while held
    let raf = 0;
    let prev: boolean[] | null = null;
    const repeatAt: number[] = [];
    const poll = (t: number) => {
      raf = requestAnimationFrame(poll);
      const pad = connectedPads().find((p) => p.mapping === "standard");
      if (!pad) {
        prev = null;
        return;
      }
      const ax = pad.axes;
      const down = (i: number) => Boolean(pad.buttons[i]?.pressed);
      // up, down, left, right, A, B, Menu, LB, RB, LT/RT (held: bigger slider steps)
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
      ];
      if (prev === null || isMenuNavSuspended()) {
        prev = now;
        return;
      }
      if (now.some((d, i) => d && !prev![i])) notePadInput(pad.id);
      const big = down(6) || down(7);
      const o = ref.current;
      const dirs: Dir[] = ["up", "down", "left", "right"];
      const handlers: (() => void)[] = [
        ...dirs.map((d) => () => move(d, big)),
        press,
        () => {
          // Ⓑ in a text field just leaves the field
          const a = document.activeElement;
          if (isTextEntry(a)) {
            (a as HTMLElement).blur();
            focusEl(a as HTMLElement);
            return;
          }
          o.onBack?.();
        },
        () => o.onStart?.(),
        () => o.onPrevTab?.(),
        () => o.onNextTab?.(),
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
    };
  }, [enabled, rootRef]);
}

/** Focuses a control under the pointer (hover and focus are the same highlight in the menus) */
export function focusOnHover(e: React.PointerEvent<HTMLElement>): void {
  if (e.pointerType !== "mouse") return;
  const active = document.activeElement;
  if (isTextEntry(active) || active instanceof HTMLSelectElement) return;
  if (active !== e.currentTarget) (e.currentTarget.focus as (o?: object) => void)({ preventScroll: true });
}
