"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
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
  // The meter re-renders with the force every frame: its words are resolved once per language (the valued ones per value)
  const tx = useTranslations("hud.ffbMeter");
  const L = useMemo(() => ({ title: tx("title"), clipping: tx("clipping"), inRange: tx("inRange") }), [tx]);
  const peakValue = Math.round(peakMag * 100);
  const peakText = useMemo(
    () => tx.rich("peak", { value: peakValue, v: (chunks) => <span className="lc-mono text-[11px] tracking-normal text-lc-fog">{chunks}</span> }),
    [tx, peakValue]
  );
  const gainValue = typeof suggestedGain === "number" ? Math.round(suggestedGain * 100) : null;
  const setCarText = useMemo(() => (gainValue === null ? "" : tx("setCar", { value: gainValue })), [tx, gainValue]);

  return (
    <section aria-label={L.title} className={`w-64 rounded-lc-tile px-3.5 py-3 ${HUD_GLASS}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className={HUD_LBL}>{L.title}</span>
        <Badge size="hud" tone={clipping ? "bad" : "neutral"} variant={clipping ? "solid" : "outline"}>
          {clipping ? L.clipping : L.inRange}
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
            {/* Peak ticks moved by transform (no layout every tick) */}
            <span className="absolute inset-0" style={{ transform: `translateX(${-peakPct}%)` }}>
              <span className="absolute inset-y-0 left-1/2 w-px bg-white/80" />
            </span>
            <span className="absolute inset-0" style={{ transform: `translateX(${peakPct}%)` }}>
              <span className="absolute inset-y-0 left-1/2 w-px bg-white/80" />
            </span>
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
          {peakText}
        </span>
      </div>

      {typeof suggestedGain === "number" ? (
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="secondary" onClick={onApplySuggestedGain} disabled={!onApplySuggestedGain}>
            {setCarText}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
