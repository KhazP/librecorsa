"use client";

import React, { useEffect, useState } from "react";
import type { CarTelemetry, StartClutchControl } from "@/types/f1";
import { JUMP_START_PENALTY_S, launchWindow } from "@/lib/sim/race-start";
import { revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from "@/lib/sim/rev-range";
import { useInputMode } from "@/components/menu/input-mode";
import { Icon } from "@/components/ui/icons/Icon";
import { KeyCap, PadGlyph, type PadButtonName } from "@/components/ui/prompts";
import { HUD_GAIN, HUD_GLASS, HUD_RED, HUD_SLATE, HUD_WHITE } from "./hud-format";

/** How long the jump start notice stays up once the lights are out (ms) */
const JUMP_NOTICE_MS = 5000;
/** Clutch travel that counts as held in */
const CLUTCH_IN = 0.9;
/** Standard-mapping buttons 0–11 as glyphs */
const PAD_GLYPHS: readonly PadButtonName[] = ["a", "b", "x", "y", "lb", "rb", "lt", "rt", "view", "menu", "l3", "r3"];

const RING_R = 9;
const RING_C = 2 * Math.PI * RING_R;

/** One step's ring: fills with its progress in white, full, green and ticked once the step is done */
const StepRing: React.FC<{ progress: number; color: string; done: boolean }> = ({ progress, color, done }) => (
  <span className="relative inline-flex size-7.5 shrink-0 items-center justify-center">
    <svg viewBox="0 0 24 24" className="absolute inset-0 size-7.5 -rotate-90" aria-hidden>
      <circle cx="12" cy="12" r={RING_R} fill="none" stroke={HUD_SLATE} strokeOpacity={0.55} strokeWidth="2.75" />
      <circle
        cx="12"
        cy="12"
        r={RING_R}
        fill="none"
        stroke={color}
        strokeWidth="2.75"
        strokeLinecap="round"
        strokeDasharray={RING_C}
        strokeDashoffset={RING_C * (1 - Math.min(1, Math.max(0, progress)))}
        className="transition-[stroke-dashoffset] duration-75"
      />
    </svg>
    {done ? (
      <span className="relative inline-flex" style={{ color }}>
        <Icon name="check" size="xs" className="size-3.5!" />
      </span>
    ) : null}
  </span>
);

const Step: React.FC<{ ring: React.ReactNode; prompt?: React.ReactNode; label: string; color?: string }> = ({ ring, prompt, label, color }) => (
  <div className="flex items-center gap-3">
    {ring}
    {/* The glyph caps are drawn at 22 px: grown with the text */}
    {prompt ? <span className="mx-0.5 inline-flex scale-125">{prompt}</span> : null}
    <span className="lc-title hud-text-shadow text-[16px] whitespace-nowrap uppercase sm:text-[18px]" style={{ color: color ?? HUD_WHITE }}>
      {label}
    </span>
  </div>
);

/** The clutch as its button or key, or nothing for a named control (the label names it) */
const ClutchPrompt: React.FC<{ control: StartClutchControl }> = ({ control }) => {
  const { family } = useInputMode();
  if ("pad" in control) {
    const glyph = PAD_GLYPHS[control.pad];
    return glyph ? <PadGlyph button={glyph} family={family} /> : <KeyCap>{`B${control.pad}`}</KeyCap>;
  }
  if ("key" in control) return <KeyCap>{control.key}</KeyCap>;
  return null;
};

/**
 * A manual start's checklist under the lights, as the F1 games show it: hold the clutch, get the revs up to the car's
 * launch revs. Each step has a ring that fills as the player gets there. A jump start turns it into the penalty.
 */
export const LaunchCue: React.FC<{ telemetry: CarTelemetry }> = ({ telemetry }) => {
  const start = telemetry.start;
  const held = start?.held === true;
  const jumped = start?.jumped === true;
  // The jump start notice outlives the lights by a few seconds
  const [jumpShown, setJumpShown] = useState(false);
  useEffect(() => {
    if (!jumped) {
      setJumpShown(false);
      return;
    }
    setJumpShown(true);
    if (held) return;
    const timer = window.setTimeout(() => setJumpShown(false), JUMP_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [jumped, held]);

  if (telemetry.engineStalled && !held) {
    return (
      <div
        role="status"
        aria-label="Engine stalled: hold clutch or shift to neutral to restart"
        className={`flex items-center gap-3 rounded-lc-row py-2.5 pr-5 pl-3 ${HUD_GLASS}`}
      >
        <StepRing progress={1} color={HUD_RED} done={false} />
        <span className="lc-title hud-text-shadow text-[16px] whitespace-nowrap uppercase sm:text-[18px]" style={{ color: HUD_RED }}>
          Engine stalled · Hold clutch or shift to N
        </span>
      </div>
    );
  }

  if (!start || (!held && !jumpShown)) return null;

  if (jumped) {
    return (
      <div role="status" className={`flex items-center gap-3 rounded-lc-row py-2.5 pr-5 pl-3 ${HUD_GLASS}`}>
        <StepRing progress={1} color={HUD_RED} done={false} />
        <span className="lc-title hud-text-shadow text-[16px] whitespace-nowrap uppercase sm:text-[18px]" style={{ color: HUD_RED }}>
          Jump start: +{start.penaltyS ?? JUMP_START_PENALTY_S} s at the flag
        </span>
      </div>
    );
  }

  const carId = telemetry.f12026?.carId;
  const limiter = revRangeFor(carId)[1] + SHIFT_BEEP_BELOW_LIMITER_RPM;
  // Revs from the window's floor up to the limiter launch as well as each other (race-start.ts): any of them is green
  const [lo] = launchWindow(carId, limiter);
  const rpm = Math.max(0, telemetry.rpm || 0);
  const revsUp = rpm >= lo;
  const clutchIn = start.clutchIn >= CLUTCH_IN;
  const named = "name" in start.clutch ? start.clutch.name : null;

  return (
    <div
      role="status"
      aria-label={`Manual start: ${clutchIn ? "clutch held" : "hold the clutch"}, ${revsUp ? "revs up" : "bring the revs up"}`}
      className={`flex flex-col gap-2.5 rounded-lc-row py-3 pr-5 pl-3 ${HUD_GLASS}`}
    >
      <Step
        ring={<StepRing progress={start.clutchIn} color={clutchIn ? HUD_GAIN : HUD_WHITE} done={clutchIn} />}
        prompt={<ClutchPrompt control={start.clutch} />}
        label={named ? `Hold the ${named}` : "Hold clutch"}
      />
      <Step
        ring={<StepRing progress={rpm / lo} color={revsUp ? HUD_GAIN : HUD_WHITE} done={revsUp} />}
        label="Revs up"
      />
    </div>
  );
};
