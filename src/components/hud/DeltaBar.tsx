"use client";

import React from "react";
import { HUD_GREEN, HUD_RED, HUD_SLATE, formatDelta } from "./hud-format";

/**
 * Live delta to the reference lap on a ±1 s scale centred at zero.
 * Ahead (negative) fills green to the left; behind (positive) fills red to the right.
 */
export const DeltaBar: React.FC<{ deltaS: number | null }> = ({ deltaS }) => {
  const has = deltaS !== null;
  const d = deltaS ?? 0;
  const ahead = d <= 0;
  const frac = Math.min(1, Math.abs(d)) * 50;
  const aheadPct = has && ahead ? frac : 0;
  const behindPct = has && !ahead ? frac : 0;

  const textColor = has ? (ahead ? HUD_GREEN : HUD_RED) : HUD_SLATE;

  return (
    <div
      className="relative h-5 w-[240px]"
      role="meter"
      aria-label="Delta to reference lap"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={has ? Math.max(-1, Math.min(1, d)) : 0}
    >
      <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 overflow-hidden rounded-sm border border-[#262B3D] bg-[#08090D]">
        <span
          className="absolute inset-y-0 right-1/2 transition-[width] duration-[120ms] ease-out"
          style={{ width: `${aheadPct}%`, backgroundColor: HUD_GREEN }}
        />
        <span
          className="absolute inset-y-0 left-1/2 transition-[width] duration-[120ms] ease-out"
          style={{ width: `${behindPct}%`, backgroundColor: HUD_RED }}
        />
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/50" />
      </div>
      <span
        className="hud-num absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-[#08090D]/90 px-1.5 py-0.5 text-[12px]"
        style={{ color: textColor }}
      >
        {has ? `${formatDelta(d)}s` : "—"}
      </span>
    </div>
  );
};
