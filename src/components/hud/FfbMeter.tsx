"use client";

import React from "react";
import { HUD_CYAN, HUD_RED, HUD_WHITE } from "./hud-format";

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
    <div className="hud-panel w-[260px] rounded-md px-3 py-2">
      {/* Header: label and clipping lamp */}
      <div className="mb-1.5 flex items-center justify-between">
        <span className="hud-label !text-[9px] !text-[#F5F7FA]">FFB · RIM</span>
        <span
          className={`rounded-sm px-1.5 py-0.5 font-f1-mono text-[9px] font-black tracking-wider transition-colors ${
            clipping ? "bg-[#FF2A3C] text-white" : "border border-[#262B3D] text-[#8E96AA]"
          }`}
        >
          CLIPPING
        </span>
      </div>

      {/* Centred force bar */}
      <div className="relative h-3 overflow-hidden rounded-sm border border-[#262B3D] bg-[#08090D]">
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
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/50" />
      </div>

      {/* Readouts */}
      <div className="mt-1.5 flex items-baseline justify-between font-f1-mono">
        <span className="hud-num text-[18px]" style={{ color: clipping ? HUD_RED : HUD_WHITE }}>
          {f >= 0 ? "+" : "−"}
          {Math.round(Math.abs(f) * 100)}%
        </span>
        <span className="text-[10px] font-bold tabular-nums text-[#8E96AA]">
          Peak {Math.round(peakMag * 100)}%
        </span>
      </div>

      {/* Gain suggestion */}
      {typeof suggestedGain === "number" ? (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onApplySuggestedGain}
            disabled={!onApplySuggestedGain}
            className="cursor-pointer rounded border border-[#CCFF00] bg-[#CCFF00]/10 px-2 py-1 font-f1-mono text-[10px] font-bold uppercase text-[#CCFF00] transition-colors hover:bg-[#CCFF00]/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Set gain to {suggestedGain.toFixed(2)}
          </button>
        </div>
      ) : null}
    </div>
  );
};
