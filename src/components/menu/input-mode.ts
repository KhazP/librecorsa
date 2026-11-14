"use client";

import { useEffect, useState } from "react";
import { padButtonLabel } from "@/lib/input/bindings";
import { connectedPads } from "@/lib/input/device-input";

/**
 * Which input the player used last (keyboard, mouse / touch or a controller), so the menus show the
 * matching button prompts and a controller always sees where the focus is. Mirrored on
 * `<html data-input="…">` for the focus styles.
 */
export type InputMode = "keyboard" | "pointer" | "pad";
/**
 * The pad's button names to show: Xbox (A B X Y), PlayStation (cross, circle, square, triangle) or a generic pad (any
 * other standard-mapping controller), whose face buttons go by position and are named A B X Y like an Xbox pad's
 */
export type PadFamily = "xbox" | "playstation" | "generic";

/** Standard-mapping buttons 0..11 as named on each pad family (words, never shape characters) */
export const PAD_BUTTON_NAMES: Record<PadFamily, Record<number, string>> = {
  xbox: { 0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB", 6: "LT", 7: "RT", 8: "View", 9: "Menu", 10: "LS", 11: "RS" },
  playstation: {
    0: "Cross",
    1: "Circle",
    2: "Square",
    3: "Triangle",
    4: "L1",
    5: "R1",
    6: "L2",
    7: "R2",
    8: "Create",
    9: "Options",
    10: "L3",
    11: "R3",
  },
  generic: { 0: "A", 1: "B", 2: "X", 3: "Y", 4: "LB", 5: "RB", 6: "LT", 7: "RT", 8: "Select", 9: "Start", 10: "LS", 11: "RS" },
};

/** A standard-mapping button's name on this pad family ("None" when unbound) */
export const padButtonName = (button: number | null | undefined, family: PadFamily): string =>
  button === null || button === undefined ? "None" : (PAD_BUTTON_NAMES[family][button] ?? padButtonLabel(button));

let mode: InputMode = "pointer";
let family: PadFamily = "xbox";
const listeners = new Set<() => void>();
let users = 0;
let raf = 0;
let detach: (() => void) | null = null;

function set(next: InputMode, nextFamily = family): void {
  if (next === mode && nextFamily === family) return;
  mode = next;
  family = nextFamily;
  if (typeof document !== "undefined") document.documentElement.dataset.input = next;
  for (const l of listeners) l();
}

/** Called by the menu navigation when a controller button or stick was used */
export function notePadInput(padId: string): void {
  set("pad", padFamilyOf(padId));
}

export function padFamilyOf(id: string): PadFamily {
  // Chrome names the Xbox pad "Xbox Wireless Controller (… Vendor: 045e …)": check Microsoft first, since
  // "wireless controller" alone also matches Sony's "Wireless Controller" / "DualSense Wireless Controller"
  if (/045e|xbox|xinput/i.test(id)) return "xbox";
  if (/054c|playstation|dualsense|dualshock|wireless controller/i.test(id)) return "playstation";
  return "generic";
}

export function currentInputMode(): InputMode {
  return mode;
}

function start(): void {
  const onKey = () => set("keyboard");
  let lastX = -1;
  let lastY = -1;
  const onPointer = (e: PointerEvent) => {
    // Ignore the tiny jitter some mice report while a controller is in use
    if (e.type === "pointermove" && lastX >= 0 && Math.hypot(e.clientX - lastX, e.clientY - lastY) < 6) return;
    lastX = e.clientX;
    lastY = e.clientY;
    set("pointer");
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointermove", onPointer, true);
  window.addEventListener("pointerdown", onPointer, true);
  // Edges only: a stick resting past the threshold (drift) or a button held down must not keep pulling the prompts
  // back to the controller while the player types
  const wasActive = new Map<string, boolean>();
  const poll = () => {
    raf = requestAnimationFrame(poll);
    // Every pad's state is recorded each frame, even after the first one that woke up
    let woke: string | null = null;
    for (const p of connectedPads()) {
      if (p.mapping !== "standard") continue;
      const active = p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5);
      const was = wasActive.get(p.id) ?? false;
      wasActive.set(p.id, active);
      if (active && !was && woke === null) woke = p.id;
    }
    if (woke !== null) notePadInput(woke);
  };
  raf = requestAnimationFrame(poll);
  document.documentElement.dataset.input = mode;
  detach = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointermove", onPointer, true);
    window.removeEventListener("pointerdown", onPointer, true);
  };
}

/** The last-used input, re-rendering when it changes */
export function useInputMode(): { mode: InputMode; family: PadFamily } {
  const [state, setState] = useState({ mode, family });
  useEffect(() => {
    if (users++ === 0) start();
    const l = () => setState({ mode, family });
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
      if (--users === 0) {
        detach?.();
        detach = null;
      }
    };
  }, []);
  return state;
}
