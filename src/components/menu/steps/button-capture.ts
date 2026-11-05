"use client";

import { useEffect, useRef } from "react";
import { connectedPads, newlyPressedButton, snapshotButtons, type ButtonBinding } from "@/lib/input/device-input";
import { suspendMenuNav } from "../useMenuNav";

/** Longest the menus stay suspended after a capture waiting for every button to come up (a pad resting "pressed") */
const RELEASE_WAIT_MAX_MS = 2000;

/**
 * Waits for the next button press and reports it; Esc cancels. Menu navigation is suspended while capturing, and
 * afterwards until the captured button is released, so it does not also act on the menu. `standardOnly` limits it to
 * standard-mapping controllers (the controller step); otherwise any device counts (wheel rim, button box, shifter).
 */
export function useButtonCapture(
  active: boolean,
  onButton: (b: ButtonBinding) => void,
  onCancel: () => void,
  options: { standardOnly?: boolean } = {}
): void {
  // Through refs: callers pass fresh closures each render, which must not restart the capture
  const onButtonRef = useRef(onButton);
  const onCancelRef = useRef(onCancel);
  onButtonRef.current = onButton;
  onCancelRef.current = onCancel;
  const standardOnly = options.standardOnly === true;

  useEffect(() => {
    if (!active) return;
    const resume = suspendMenuNav();
    let prev = snapshotButtons(connectedPads());
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const all = connectedPads();
      const hit = newlyPressedButton(prev, standardOnly ? all.filter((p) => p.mapping === "standard") : all);
      prev = snapshotButtons(all);
      if (hit) onButtonRef.current(hit);
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, { capture: true });
      // Hold the menus until the captured button is released, but not forever: a pad reporting a button pressed at
      // rest (a stuck trigger) would otherwise leave every menu dead
      const until = performance.now() + RELEASE_WAIT_MAX_MS;
      const wait = () => {
        if (performance.now() < until && connectedPads().some((p) => p.buttons.some((b) => b.pressed))) {
          requestAnimationFrame(wait);
        } else resume();
      };
      wait();
    };
  }, [active, standardOnly]);
}
