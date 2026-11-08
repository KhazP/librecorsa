"use client";

import { useEffect, useRef } from "react";
import { connectedPads, newlyPressedButton, snapshotButtons, type ButtonBinding, type PadLike } from "@/lib/input/device-input";
import { suspendMenuNav } from "../useMenuNav";

/** Longest the menus stay suspended after a capture waiting for every button to come up (a pad resting "pressed") */
const RELEASE_WAIT_MAX_MS = 2000;

/**
 * A capture with nothing pressed gives up after this long: every pad button binds, so a controller has no button left
 * to cancel with. The prompts name the wait.
 */
export const CAPTURE_TIMEOUT_S = 6;

/**
 * Waits for the next button press and reports it; Esc cancels, and so does pressing nothing for CAPTURE_TIMEOUT_S.
 * Menu navigation is suspended while capturing, and afterwards until the captured button is released, so it does not
 * also act on the menu. `target` names what is being bound (null = not capturing); a new target starts a fresh wait.
 * `standardOnly` limits it to standard-mapping controllers (the controller step); otherwise any device counts (wheel
 * rim, button box, shifter).
 */
export function useButtonCapture(
  target: string | null,
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
    if (target === null) return;
    const resume = suspendMenuNav();
    const watched = (): PadLike[] => {
      const all = connectedPads();
      return standardOnly ? all.filter((p) => p.mapping === "standard") : all;
    };
    // One predicate for "down" throughout: the capture's own (pressed, or an analogue button past half)
    const anyDown = () => [...snapshotButtons(watched()).values()].some((buttons) => buttons.includes(true));
    let prev = snapshotButtons(watched());
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const pads = watched();
      const hit = newlyPressedButton(prev, pads);
      prev = snapshotButtons(pads);
      if (hit) onButtonRef.current(hit);
    };
    raf = requestAnimationFrame(poll);
    const timeout = window.setTimeout(() => onCancelRef.current(), CAPTURE_TIMEOUT_S * 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancelRef.current();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timeout);
      window.removeEventListener("keydown", onKey, { capture: true });
      // Hold the menus until the captured button is released, but not forever: a pad reporting a button pressed at
      // rest (a stuck trigger) would otherwise leave every menu dead
      const until = performance.now() + RELEASE_WAIT_MAX_MS;
      const wait = () => {
        if (performance.now() < until && anyDown()) requestAnimationFrame(wait);
        else resume();
      };
      wait();
    };
  }, [target, standardOnly]);
}
