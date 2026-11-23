"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceSplit, RaceSplits } from "@/types/f1";
import { Trend } from "@/components/ui/icons/Trend";
import { formatGap, HUD_GAIN, HUD_GLASS, HUD_LBL, HUD_LOSS, HUD_SLATE } from "./hud-format";

/** A gap change smaller than this over the trend window reads as steady (s) */
const STEADY_S = 0.05;

/**
 * One side of the split readout. `towardsYou`: the gap shrinking is good news (the car ahead) or bad news (the car
 * behind), so the colour says whether this split is going your way.
 */
const Split: React.FC<{ split: RaceSplit; side: "ahead" | "behind"; wide?: boolean }> = ({ split, side, wide }) => {
  // The splits re-render every frame: the words are resolved once per language, the spoken gap once per value
  const tx = useTranslations("hud.splitGaps");
  const L = useMemo(
    () => ({ ahead: tx("ahead"), behind: tx("behind"), yourWay: tx("goingYourWay"), against: tx("goingAgainstYou"), steady: tx("steady") }),
    [tx]
  );
  const gap = split.gapS.toFixed(3);
  const label = useMemo(() => tx(side === "ahead" ? "carAhead" : "carBehind", { driver: split.driverCode, gap }), [tx, side, split.driverCode, gap]);
  const change = split.changeS;
  const moving = change !== undefined && Math.abs(change) >= STEADY_S;
  // Ahead: closing (gap falling) is good; behind: pulling away (gap rising) is good
  const good = moving && (side === "ahead" ? (change as number) < 0 : (change as number) > 0);
  const color = moving ? (good ? HUD_GAIN : HUD_LOSS) : "var(--color-lc-chalk)";
  return (
    <span className={`flex items-center gap-2 ${wide ? "w-full" : ""}`} aria-label={label}>
      <span className={`${HUD_LBL} ${wide ? "w-13" : ""}`}>{side === "ahead" ? L.ahead : L.behind}</span>
      <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ backgroundColor: split.teamColorHex }} />
      <span className="lc-data text-[12px] tracking-[0.1em] text-lc-chalk">{split.driverCode}</span>
      {wide ? <span className="flex-1" /> : null}
      {/* The side says which way; the number is the time between the cars */}
      <span className="lc-data min-w-13 text-end text-[13px]" style={{ color }}>
        {formatGap(split.gapS, true)}
      </span>
      {/* How the gap moved: up when it went your way, down when it did not */}
      <span
        className="lc-data inline-flex w-11 items-center gap-0.5 text-[10px]"
        style={{ color: moving ? color : HUD_SLATE, opacity: change === undefined ? 0 : 1 }}
      >
        {change === undefined ? null : (
          <>
            <Trend direction={moving ? (good ? "up" : "down") : "level"} label={moving ? (good ? L.yourWay : L.against) : L.steady} />
            {Math.abs(change).toFixed(2)}
          </>
        )}
      </span>
    </span>
  );
};

/**
 * Split gaps to the cars directly ahead and behind in the running order: the time between the two cars at the same
 * point of the track, and how it moved over the last seconds.
 */
export const SplitGaps: React.FC<{ splits: RaceSplits | undefined; variant?: "pill" | "panel" }> = ({ splits, variant = "pill" }) => {
  const tx = useTranslations("hud.splitGaps");
  const region = useMemo(() => tx("region"), [tx]);
  if (!splits || (!splits.ahead && !splits.behind)) return null;
  if (variant === "panel") {
    // Stacked under the timing tower, so the middle of the screen stays on the road
    return (
      <div className={`flex w-full flex-col gap-1.5 rounded-lc-tile px-3.5 py-2.5 ${HUD_GLASS}`} aria-label={region}>
        {splits.ahead ? <Split split={splits.ahead} side="ahead" wide /> : null}
        {splits.behind ? <Split split={splits.behind} side="behind" wide /> : null}
      </div>
    );
  }
  return (
    <div className={`inline-flex h-9 items-center gap-3 rounded-full py-1 pe-2 ps-4 ${HUD_GLASS}`} aria-label={region}>
      {splits.ahead ? <Split split={splits.ahead} side="ahead" /> : null}
      {splits.ahead && splits.behind ? <span aria-hidden className="h-4 w-px bg-lc-line" /> : null}
      {splits.behind ? <Split split={splits.behind} side="behind" /> : null}
    </div>
  );
};
