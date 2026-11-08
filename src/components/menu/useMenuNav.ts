"use client";

import { useEffect, useState } from "react";
import { connectedPads, type PadLike } from "@/lib/input/device-input";

/**
 * Shared menu-input plumbing: the rebinding suspend switch (read by useFocusNav), pad edge helpers and a live snapshot
 * of the connected Gamepad API devices. The menus' navigation itself lives in useFocusNav.
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

/**
 * A connected pad's identity across frames: its slot and id. Pollers that read "the first standard pad" compare it
 * frame to frame and start a fresh baseline when it changes, so another pad's buttons never read as presses.
 */
export const padKey = (p: { index: number; id: string }): string => `${p.index}:${p.id}`;

/**
 * Per-pad press edges for a poller: call it once a frame with the pads to watch; true when one of them pressed one of
 * `buttons` (default: any) since the last call. A pad seen for the first time only sets its baseline, so a pad that
 * connects with a button held, or one released while another pad still holds one, is no press.
 */
export function padPressTracker(buttons?: readonly number[]): (pads: readonly PadLike[]) => boolean {
  let prev = new Map<string, boolean[]>();
  return (pads) => {
    const next = new Map<string, boolean[]>();
    let pressed = false;
    for (const p of pads) {
      const now = buttons ? buttons.map((i) => Boolean(p.buttons[i]?.pressed)) : p.buttons.map((b) => b.pressed);
      const before = prev.get(padKey(p));
      if (before && now.some((d, i) => d && !before[i])) pressed = true;
      next.set(padKey(p), now);
    }
    prev = next;
    return pressed;
  };
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
