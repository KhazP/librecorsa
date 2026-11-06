"use client";

import { useEffect, useState } from "react";
import { connectedPads, type PadLike } from "@/lib/input/device-input";

/**
 * Shared menu-input plumbing: the rebinding suspend switch (read by useFocusNav) and a live snapshot of the connected
 * Gamepad API devices. The menus' navigation itself lives in useFocusNav.
 */
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

function samePads(a: PadState[], b: PadState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[i];
    if (p.index !== q.index || p.id !== q.id || p.mapping !== q.mapping) return false;
    if (p.axes.length !== q.axes.length || p.buttons.length !== q.buttons.length) return false;
    for (let k = 0; k < p.axes.length; k++) if (p.axes[k] !== q.axes[k]) return false;
    for (let k = 0; k < p.buttons.length; k++) {
      if (p.buttons[k].pressed !== q.buttons[k].pressed || p.buttons[k].value !== q.buttons[k].value) return false;
    }
  }
  return true;
}

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
      // Only a real change re-renders: a new array every tick re-rendered every consumer at 30 Hz with pads idle
      const next = snapshotPads();
      setPads((prev) => (samePads(prev, next) ? prev : next));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return pads;
}
