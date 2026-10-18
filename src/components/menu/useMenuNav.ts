"use client";

import { useEffect, useRef, useState } from "react";
import { connectedPads, type PadLike } from "@/lib/input/device-input";

/**
 * Menu navigation from the keyboard (arrows, Enter, Esc) and any standard controller
 * (D-pad / left stick, A select, B back). Button edges only: a button still held from the
 * previous screen does not fire on the next one.
 */
export interface MenuNavOptions {
  enabled?: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onSelect?: () => void;
  onBack?: () => void;
  /** Menu / Start button */
  onStart?: () => void;
  /** Esc / Backspace call onBack (off where another handler owns Esc) */
  keyboardBack?: boolean;
  /** Enter calls onSelect (off where focused buttons should handle Enter themselves) */
  keyboardSelect?: boolean;
}

let suspended = 0;
/** Pauses all menu navigation while a control is being captured for rebinding; returns the resume call */
export function suspendMenuNav(): () => void {
  suspended++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended = Math.max(0, suspended - 1);
  };
}

/** True while a control is being captured for rebinding */
export function isMenuNavSuspended(): boolean {
  return suspended > 0;
}
const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

const STICK_THRESHOLD = 0.6;
const REPEAT_DELAY_MS = 380;
const REPEAT_RATE_MS = 120;

export function useMenuNav(options: MenuNavOptions) {
  const ref = useRef(options);
  ref.current = options;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (suspended > 0 || isTyping(e.target)) return;
      const o = ref.current;
      const call = (fn?: () => void) => {
        if (!fn) return;
        e.preventDefault();
        fn();
      };
      switch (e.code) {
        case "ArrowUp":
          return call(o.onUp);
        case "ArrowDown":
          return call(o.onDown);
        case "ArrowLeft":
          return call(o.onLeft);
        case "ArrowRight":
          return call(o.onRight);
        case "Enter":
        case "NumpadEnter":
          if (o.keyboardSelect === false) return;
          return call(o.onSelect);
        case "Escape":
        case "Backspace":
          if (o.keyboardBack === false) return;
          return call(o.onBack);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    let prev: boolean[] | null = null;
    const repeatAt: Record<string, number> = {};

    const poll = (t: number) => {
      raf = requestAnimationFrame(poll);
      const pad = connectedPads().find((p) => p.mapping === "standard");
      if (!pad) {
        prev = null;
        return;
      }
      const ax = pad.axes;
      const down = (i: number) => Boolean(pad.buttons[i]?.pressed);
      // [up, down, left, right, A, B, Menu]
      const now = [
        down(12) || (ax[1] ?? 0) < -STICK_THRESHOLD,
        down(13) || (ax[1] ?? 0) > STICK_THRESHOLD,
        down(14) || (ax[0] ?? 0) < -STICK_THRESHOLD,
        down(15) || (ax[0] ?? 0) > STICK_THRESHOLD,
        down(0),
        down(1),
        down(9),
      ];
      if (prev === null || suspended > 0) {
        prev = now;
        return;
      }
      const o = ref.current;
      const handlers = [o.onUp, o.onDown, o.onLeft, o.onRight, o.onSelect, o.onBack, o.onStart];
      now.forEach((isDown, i) => {
        const key = String(i);
        if (isDown && !prev![i]) {
          handlers[i]?.();
          repeatAt[key] = t + REPEAT_DELAY_MS;
        } else if (isDown && i < 4 && t >= (repeatAt[key] ?? Infinity)) {
          // Directions auto-repeat while held
          handlers[i]?.();
          repeatAt[key] = t + REPEAT_RATE_MS;
        }
      });
      prev = now;
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
}

/** Index navigation over a vertical list, with wrap-around */
export function useListNav(count: number, options: Omit<MenuNavOptions, "onUp" | "onDown" | "onSelect"> & {
  onSelect: (index: number) => void;
  initialIndex?: number;
}) {
  const [index, setIndex] = useState(options.initialIndex ?? 0);
  const indexRef = useRef(index);
  indexRef.current = index;
  useMenuNav({
    ...options,
    onUp: () => setIndex((i) => (i - 1 + count) % count),
    onDown: () => setIndex((i) => (i + 1) % count),
    onSelect: () => options.onSelect(indexRef.current),
  });
  return [index, setIndex] as const;
}

export interface PadState {
  index: number;
  id: string;
  mapping: string;
  axes: number[];
  buttons: { value: number; pressed: boolean }[];
}

const snapshotPads = (): PadState[] =>
  connectedPads().map((p: PadLike) => ({
    index: p.index,
    id: p.id,
    mapping: p.mapping,
    axes: [...p.axes],
    buttons: p.buttons.map((b) => ({ value: b.value, pressed: b.pressed })),
  }));

/** Live snapshot of every connected Gamepad API device (~30 Hz) for meters and detection */
export function useGamepads(active = true): PadState[] {
  const [pads, setPads] = useState<PadState[]>(() => (active ? snapshotPads() : []));
  useEffect(() => {
    if (!active) return;
    setPads(snapshotPads());
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return;
      last = t;
      setPads(snapshotPads());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return pads;
}
