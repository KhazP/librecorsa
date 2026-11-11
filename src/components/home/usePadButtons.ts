"use client";

import { useEffect, useRef } from "react";

/** Standard-mapping button numbers */
const BUTTONS = { lb: 4, rb: 5, start: 9 } as const;
export type PadButton = keyof typeof BUTTONS;
const NAMES = Object.keys(BUTTONS) as PadButton[];

/**
 * A controller's bumpers and Start on the home page: each handler runs once per press. Only pads with the standard
 * layout are read (a wheel's buttons mean other things), and only while one is connected.
 */
export function usePadButtons(handlers: Partial<Record<PadButton, () => void>>): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return;
    let held = new Map<string, boolean[]>();
    let raf = 0;

    const pads = () => navigator.getGamepads().filter((p): p is Gamepad => Boolean(p?.connected && p.mapping === "standard"));
    const tick = () => {
      const now = pads();
      if (!now.length) {
        raf = 0;
        held = new Map();
        return;
      }
      raf = requestAnimationFrame(tick);
      const next = new Map<string, boolean[]>();
      for (const p of now) {
        const key = `${p.index}:${p.id}`;
        const down = NAMES.map((n) => Boolean(p.buttons[BUTTONS[n]]?.pressed));
        const before = held.get(key);
        if (before) NAMES.forEach((n, i) => down[i] && !before[i] && latest.current[n]?.());
        next.set(key, down);
      }
      held = next;
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };

    if (pads().length) start();
    window.addEventListener("gamepadconnected", start);
    return () => {
      window.removeEventListener("gamepadconnected", start);
      cancelAnimationFrame(raf);
    };
  }, []);
}
