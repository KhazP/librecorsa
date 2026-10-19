"use client";

import React from "react";
import { HUD_CYAN, HUD_GLASS, HUD_LBL, HUD_RED, HUD_WHITE } from "./hud-format";

interface FfbMeterProps {
  /** Current rim force, -1..1 (+ = right) */
  force: number;
  clipping: boolean;
  /** Recent peak |force|, 0..>1 */
  peak: number;
  /** Suggested FFB gain; shows a button when it is a number */
  suggestedGain?: number | null;
  onApplySuggestedGain?: () => void;
}

const clampForce = (v: number) => Math.max(-1, Math.min(1, v));

/** Compact centred force-feedback meter: live force, peak hold ticks, clipping lamp and gain suggestion */
export const FfbMeter: React.FC<FfbMeterProps> = ({
  force,
  clipping,
  peak,
  suggestedGain = null,
  onApplySuggestedGain,
}) => {
  const f = clampForce(force);
  const magPct = Math.abs(f) * 50;
  const peakMag = Math.abs(peak);
  const peakPct = Math.min(1, peakMag) * 50;
  const fillColor = clipping ? HUD_RED : HUD_CYAN;

  return (
    <section aria-label="Force feedback" className={`w-[256px] rounded-[22px] px-3.5 py-3 ${HUD_GLASS}`}>
      {/* Header: label and clipping lamp */}
      <div className="mb-2 flex items-center justify-between">
        <span className="lc-data inline-flex items-center gap-2 text-[11px] tracking-[0.12em] text-[#F5F7FA]">
          <span className="h-[7px] w-[7px] rounded-full bg-[#00E5FF]" />
          FFB · RIM
        </span>
        <span
          className={`lc-data rounded-full px-2 py-0.5 text-[9px] tracking-[0.1em] transition-colors ${
            clipping ? "bg-[#FF2A3C] text-[#F5F7FA]" : "border border-[#262B3D] text-[#8E96AA]"
          }`}
        >
          CLIPPING
        </span>
      </div>

      {/* Centred force bar */}
      <div className="relative h-2.5 overflow-hidden rounded-full bg-[#1B1F2B]">
        <span
          className="absolute inset-y-0 left-1/2 transition-[width] duration-75"
          style={{ width: `${f > 0 ? magPct : 0}%`, backgroundColor: fillColor }}
        />
        <span
          className="absolute inset-y-0 right-1/2 transition-[width] duration-75"
          style={{ width: `${f < 0 ? magPct : 0}%`, backgroundColor: fillColor }}
        />
        {peakPct > 0 ? (
          <>
            <span
              className="absolute inset-y-0 w-px bg-white/80"
              style={{ left: `${50 - peakPct}%` }}
              title="Peak (left)"
            />
            <span
              className="absolute inset-y-0 w-px bg-white/80"
              style={{ left: `${50 + peakPct}%` }}
              title="Peak (right)"
            />
          </>
        ) : null}
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[#F5F7FA]/50" />
      </div>

      {/* Readouts */}
      <div className="mt-2 flex items-baseline justify-between">
        <span className="lc-data text-[18px] leading-none" style={{ color: clipping ? HUD_RED : HUD_WHITE }}>
          {f >= 0 ? "+" : "−"}
          {Math.round(Math.abs(f) * 100)}%
        </span>
        <span className={HUD_LBL}>
          Peak <span className="lc-data text-[11px] tracking-normal text-[#C5CBD8]">{Math.round(peakMag * 100)}%</span>
        </span>
      </div>

      {/* Gain suggestion */}
      {typeof suggestedGain === "number" ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onApplySuggestedGain}
            disabled={!onApplySuggestedGain}
            className="lc-data cursor-pointer rounded-full bg-[#CCFF00] px-3 py-1 text-[10px] uppercase text-[#08090D] transition-colors hover:bg-[#E2FF4D] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Set gain to {suggestedGain.toFixed(2)}
          </button>
        </div>
      ) : null}
    </section>
  );
};
