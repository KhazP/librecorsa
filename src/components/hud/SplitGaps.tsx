"use client";

import React from "react";
import type { RaceSplit, RaceSplits } from "@/types/f1";
import { HUD_GLASS, HUD_GREEN, HUD_LBL, HUD_RED, HUD_SLATE } from "./hud-format";

/** A gap change smaller than this over the trend window reads as steady (s) */
const STEADY_S = 0.05;

/**
 * One side of the split readout. `towardsYou`: the gap shrinking is good news (the car ahead) or bad news (the car
 * behind), so the colour says whether this split is going your way.
 */
const Split: React.FC<{ split: RaceSplit; side: "ahead" | "behind"; wide?: boolean }> = ({ split, side, wide }) => {
  const change = split.changeS;
  const moving = change !== undefined && Math.abs(change) >= STEADY_S;
  // Ahead: closing (gap falling) is good; behind: pulling away (gap rising) is good
  const good = moving && (side === "ahead" ? (change as number) < 0 : (change as number) > 0);
  const color = moving ? (good ? HUD_GREEN : HUD_RED) : "#F5F7FA";
  const sign = side === "ahead" ? "+" : "−";
  return (
    <span className={`flex items-center gap-2 ${wide ? "w-full" : ""}`} aria-label={`${side === "ahead" ? "Car ahead" : "Car behind"} ${split.driverCode}: ${split.gapS.toFixed(3)} seconds`}>
      <span className={`${HUD_LBL} ${wide ? "w-[52px]" : ""}`}>{side === "ahead" ? "Ahead" : "Behind"}</span>
      <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ backgroundColor: split.teamColorHex }} />
      <span className="lc-data text-[12px] tracking-[0.1em] text-[#F5F7FA]">{split.driverCode}</span>
      {wide ? <span className="flex-1" /> : null}
      <span className="lc-data min-w-[52px] text-right text-[13px] tabular-nums" style={{ color }}>
        {sign}
        {split.gapS < 100 ? split.gapS.toFixed(split.gapS < 10 ? 3 : 1) : "99+"}
      </span>
      <span className="lc-data w-[38px] text-[10px] tabular-nums" style={{ color: moving ? color : HUD_SLATE, opacity: change === undefined ? 0 : 1 }}>
        {change === undefined ? "" : `${change < 0 ? "▾" : change > 0 ? "▴" : "·"}${Math.abs(change).toFixed(2)}`}
      </span>
    </span>
  );
};

/**
 * Split gaps to the cars directly ahead and behind in the running order (Speed Dreams' "split differences to nearby
 * opponents"): the time between the two cars at the same point of the track, and how it moved over the last seconds.
 */
export const SplitGaps: React.FC<{ splits: RaceSplits | undefined; variant?: "pill" | "panel" }> = ({ splits, variant = "pill" }) => {
  if (!splits || (!splits.ahead && !splits.behind)) return null;
  if (variant === "panel") {
    // Stacked under the timing tower, so the middle of the screen stays on the road
    return (
      <div className={`flex w-full flex-col gap-1.5 rounded-[18px] px-3.5 py-2.5 ${HUD_GLASS}`} role="status" aria-label="Split gaps">
        {splits.ahead ? <Split split={splits.ahead} side="ahead" wide /> : null}
        {splits.behind ? <Split split={splits.behind} side="behind" wide /> : null}
      </div>
    );
  }
  return (
    <div className={`inline-flex h-9 items-center gap-3 rounded-full py-1 pr-2 pl-4 ${HUD_GLASS}`} role="status" aria-label="Split gaps">
      {splits.ahead ? <Split split={splits.ahead} side="ahead" /> : null}
      {splits.ahead && splits.behind ? <span aria-hidden className="h-4 w-px bg-[#262B3D]" /> : null}
      {splits.behind ? <Split split={splits.behind} side="behind" /> : null}
    </div>
  );
};
