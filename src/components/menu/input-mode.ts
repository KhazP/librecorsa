"use client";

import { useEffect, useState } from "react";
import { connectedPads } from "@/lib/input/device-input";

/**
 * Which input the player used last (keyboard, mouse / touch or a controller), so the menus show the
 * matching button prompts and a controller always sees where the focus is. Mirrored on
 * `<html data-input="…">` for the focus styles.
 */
export type InputMode = "keyboard" | "pointer" | "pad";
/** Face-button labels to show: Xbox (A B X Y) or PlayStation (✕ ○ □ △) */
export type PadFamily = "xbox" | "playstation";

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
  return /054c|playstation|dualsense|dualshock|wireless controller/i.test(id) ? "playstation" : "xbox";
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
    for (const p of connectedPads()) {
      if (p.mapping !== "standard") continue;
      const active = p.buttons.some((b) => b.pressed) || p.axes.some((a) => Math.abs(a) > 0.5);
      const was = wasActive.get(p.id) ?? false;
      wasActive.set(p.id, active);
      if (active && !was) {
        notePadInput(p.id);
        return;
      }
    }
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
