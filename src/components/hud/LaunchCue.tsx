"use client";

import React, { useEffect, useState } from "react";
import type { CarTelemetry } from "@/types/f1";
import { JUMP_START_PENALTY_S, launchWindow } from "@/lib/sim/race-start";
import { revRangeFor, SHIFT_BEEP_BELOW_LIMITER_RPM } from "@/lib/sim/rev-range";
import { HUD_GAIN, HUD_GLASS, HUD_RED, HUD_THROTTLE } from "./hud-format";

/** How long the jump start notice stays up once the lights are out (ms) */
const JUMP_NOTICE_MS = 5000;

/**
 * A manual start's cue under the lights: what to hold as the clutch, the revs against the car's launch window, and the
 * jump start once there is one
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

  if (!start || (!held && !jumpShown)) return null;
  const carId = telemetry.f12026?.carId;
  const limiter = revRangeFor(carId)[1] + SHIFT_BEEP_BELOW_LIMITER_RPM;
  const [lo, hi] = launchWindow(carId, limiter);
  const top = Math.max(limiter, hi * 1.15);
  const rpm = Math.max(0, telemetry.rpm || 0);
  const at = (r: number) => `${Math.min(100, (r / top) * 100)}%`;
  const inWindow = rpm >= lo && rpm <= hi;
  const needle = inWindow ? HUD_GAIN : rpm > hi ? HUD_RED : HUD_THROTTLE;

  return (
    <div className={`flex w-[min(320px,86vw)] flex-col items-center gap-2 rounded-lc-row px-4 py-3 ${HUD_GLASS}`} role="status">
      {held ? (
        <>
          <div
            className="relative h-3 w-full overflow-hidden rounded-full bg-lc-well inset-ring inset-ring-lc-titanium"
            role="meter"
            aria-label="Engine speed against the launch window"
            aria-valuemin={0}
            aria-valuemax={Math.round(top)}
            aria-valuenow={Math.round(rpm)}
          >
            <span className="absolute inset-y-0" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})`, backgroundColor: HUD_GAIN, opacity: 0.35 }} />
            <span className="absolute inset-y-0 left-0 transition-[width] duration-75" style={{ width: at(rpm), backgroundColor: needle, opacity: 0.85 }} />
          </div>
          <span className="lc-body hud-text-shadow text-center text-[14px] text-lc-chalk">
            {jumped
              ? `Jump start: +${JUMP_START_PENALTY_S} s at the flag`
              : `Hold ${start.clutch}, keep the revs in the green, let go at lights out`}
          </span>
        </>
      ) : (
        <span className="lc-body hud-text-shadow text-center text-[14px]" style={{ color: HUD_RED }}>
          Jump start: +{JUMP_START_PENALTY_S} s at the flag
        </span>
      )}
    </div>
  );
};
