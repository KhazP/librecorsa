"use client";

import React from "react";
import { Button } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { cx } from "@/components/ui/styles";
import { HUD_GLASS, HUD_LBL } from "./hud-format";

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

/**
 * Compact centred force feedback meter: live force, peak hold ticks, a clipping badge and, when the force clips or
 * stays light, a strength for this car (it shows in Settings > Force feedback, where it can be cleared).
 */
export const FfbMeter: React.FC<FfbMeterProps> = ({ force, clipping, peak, suggestedGain = null, onApplySuggestedGain }) => {
  const f = clampForce(force);
  const mag = Math.abs(f) / 2;
  const peakMag = Math.abs(peak);
  const peakPct = Math.min(1, peakMag) * 50;
  const fill = clipping ? "bg-lc-loss" : "bg-lc-info";

  return (
    <section aria-label="Force feedback" className={`w-64 rounded-lc-tile px-3.5 py-3 ${HUD_GLASS}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={HUD_LBL}>Force feedback</span>
        <Badge size="hud" tone={clipping ? "bad" : "neutral"} variant={clipping ? "solid" : "outline"}>
          {clipping ? "Clipping" : "In range"}
        </Badge>
      </div>

      {/* Centred force bar: scaled from the centre, so it only animates transform */}
      <div className="relative h-2.5 overflow-hidden rounded-full bg-lc-titanium">
        <span
          className={cx("absolute inset-y-0 left-1/2 w-1/2 origin-left", fill)}
          style={{ transform: `scaleX(${f > 0 ? mag * 2 : 0})` }}
        />
        <span
          className={cx("absolute inset-y-0 right-1/2 w-1/2 origin-right", fill)}
          style={{ transform: `scaleX(${f < 0 ? mag * 2 : 0})` }}
        />
        {peakPct > 0 ? (
          <>
            <span className="absolute inset-y-0 w-px bg-white/80" style={{ left: `${50 - peakPct}%` }} />
            <span className="absolute inset-y-0 w-px bg-white/80" style={{ left: `${50 + peakPct}%` }} />
          </>
        ) : null}
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-lc-chalk/50" />
      </div>

      <div className="mt-2 flex items-baseline justify-between">
        <span className={cx("lc-data text-[18px] leading-none", clipping ? "text-lc-loss" : "text-lc-chalk")}>
          {f >= 0 ? "+" : "-"}
          {Math.round(Math.abs(f) * 100)}%
        </span>
        <span className={HUD_LBL}>
          Peak <span className="lc-mono text-[11px] tracking-normal text-lc-fog">{Math.round(peakMag * 100)}%</span>
        </span>
      </div>

      {typeof suggestedGain === "number" ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="secondary" onClick={onApplySuggestedGain} disabled={!onApplySuggestedGain}>
            {`Set this car to ${Math.round(suggestedGain * 100)}%`}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
