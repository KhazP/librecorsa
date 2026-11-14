"use client";

import React, { useEffect, useRef, useState } from "react";
import { Trend as TrendArrow } from "@/components/ui/icons/Trend";
import { HUD_GAIN, HUD_LOSS, HUD_SLATE, NO_TIME, formatDelta } from "./hud-format";

/** Trend window: the slope is taken across about this much history */
const TREND_WINDOW_MS = 500;
/** Below this rate (seconds of delta per second) the chevron stays neutral */
const TREND_DEAD_BAND = 0.025;
/** A delta jump bigger than this between samples is a new lap or a new reference, not a trend */
const TREND_RESET_S = 0.4;

type Trend = "gaining" | "losing" | "steady";

/**
 * Rate of change of the live delta, smoothed over ~0.5 s: "gaining" while the delta is falling right now (this
 * corner is quicker than the reference), "losing" while it rises. It samples on every render (the HUD renders with
 * each telemetry frame), so a delta that stops moving decays to steady instead of keeping its last chevron, and a new
 * run (`runId`) starts from an empty history.
 */
export function useDeltaTrend(deltaS: number | null, runId = 0): { trend: Trend; rate: number } {
  const hist = useRef<{ t: number; d: number }[]>([]);
  const rateRef = useRef(0);
  const runRef = useRef(runId);
  // Only the trend and a quantised strength are state, so this re-renders when the chevron actually changes
  const [out, setOut] = useState<{ trend: Trend; rate: number }>({ trend: "steady", rate: 0 });
  useEffect(() => {
    const now = performance.now();
    const h = hist.current;
    if (runRef.current !== runId) {
      runRef.current = runId;
      h.length = 0;
      rateRef.current = 0;
    }
    if (deltaS === null) {
      h.length = 0;
      rateRef.current = 0;
    } else {
      const last = h[h.length - 1];
      if (last && Math.abs(deltaS - last.d) > TREND_RESET_S) {
        h.length = 0;
        rateRef.current = 0;
      }
      h.push({ t: now, d: deltaS });
      while (h.length > 2 && now - h[0].t > TREND_WINDOW_MS) h.shift();
      const first = h[0];
      const span = (now - first.t) / 1000;
      if (span > 0.12) rateRef.current += ((deltaS - first.d) / span - rateRef.current) * 0.35;
    }
    const rate = rateRef.current;
    const trend: Trend = rate < -TREND_DEAD_BAND ? "gaining" : rate > TREND_DEAD_BAND ? "losing" : "steady";
    const q = Math.round(Math.min(0.4, Math.abs(rate)) * 10) / 10;
    setOut((o) => (o.trend === trend && o.rate === q ? o : { trend, rate: q }));
  });
  return out;
}

/** The kit's gain / loss arrow on the side the delta is moving: up on the left while gaining, down on the right while losing */
const Chevron: React.FC<{ trend: Trend; rate: number; side: "left" | "right" }> = ({ trend, rate, side }) => {
  const show = (trend === "gaining" && side === "left") || (trend === "losing" && side === "right");
  // Stronger rate, brighter arrow
  const strength = Math.min(1, Math.abs(rate) / 0.4);
  return (
    <span
      aria-hidden
      className="inline-flex w-3.5 shrink-0 justify-center transition-opacity duration-150"
      style={{ opacity: show ? 0.45 + strength * 0.55 : 0, color: side === "left" ? HUD_GAIN : HUD_LOSS }}
    >
      <TrendArrow direction={side === "left" ? "up" : "down"} size={12} />
    </span>
  );
};

/**
 * Live delta to the reference lap on a ±1 s scale centred at zero.
 * Ahead (negative) fills green to the left; behind (positive) fills red to the right. Chevrons either side of the
 * readout show which way it is moving right now.
 */
export const DeltaBar: React.FC<{ deltaS: number | null; width?: number; /** The shell's run counter (telemetry.runId) */ runId?: number }> = ({
  deltaS,
  width = 260,
  runId = 0,
}) => {
  const { trend, rate } = useDeltaTrend(deltaS, runId);
  const has = deltaS !== null;
  const d = deltaS ?? 0;
  const ahead = d <= 0;
  const frac = Math.min(1, Math.abs(d));
  const aheadK = has && ahead ? frac : 0;
  const behindK = has && !ahead ? frac : 0;

  const textColor = has ? (ahead ? HUD_GAIN : HUD_LOSS) : HUD_SLATE;

  return (
    <div
      className="relative h-6.5"
      style={{ width }}
      role="meter"
      aria-label="Delta to reference lap"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={has ? Math.max(-1, Math.min(1, d)) : 0}
      aria-valuetext={has ? `${formatDelta(d)} seconds, ${trend}` : "No reference lap"}
    >
      <div className="absolute inset-x-0 top-2 h-2.5 overflow-hidden rounded-full bg-lc-void/70 inset-ring inset-ring-white/8">
        {/* Each half scales from the centre line (transform only, so the bar never re-lays out) */}
        <span
          className="absolute inset-y-0 right-1/2 w-1/2 origin-right bg-lc-gain transition-transform duration-[120ms] ease-out"
          style={{ transform: `scaleX(${aheadK})` }}
        />
        <span
          className="absolute inset-y-0 left-1/2 w-1/2 origin-left bg-lc-loss transition-transform duration-[120ms] ease-out"
          style={{ transform: `scaleX(${behindK})` }}
        />
        {/* ±0.5 s ticks */}
        <span className="absolute inset-y-0 left-1/4 w-px bg-lc-chalk/15" />
        <span className="absolute inset-y-0 left-3/4 w-px bg-lc-chalk/15" />
        <span className="absolute inset-y-0 left-1/2 w-px bg-lc-chalk/50" />
      </div>
      <span className="absolute top-0 left-1/2 flex -translate-x-1/2 items-center gap-1">
        <Chevron trend={trend} rate={rate} side="left" />
        <span
          className="lc-data rounded-full border border-white/7 bg-lc-void px-2.5 py-1.25 text-[12px] leading-none"
          style={{ color: textColor }}
        >
          {has ? formatDelta(d) : NO_TIME}
        </span>
        <Chevron trend={trend} rate={rate} side="right" />
      </span>
    </div>
  );
};
