"use client";

import React, { useEffect, useRef, useState } from "react";
import { HUD_GREEN, HUD_RED, HUD_SLATE, formatDelta } from "./hud-format";

/** Trend window: the slope is taken across about this much history */
const TREND_WINDOW_MS = 500;
/** Below this rate (seconds of delta per second) the chevron stays neutral */
const TREND_DEAD_BAND = 0.025;
/** A delta jump bigger than this between samples is a new lap or a new reference, not a trend */
const TREND_RESET_S = 0.4;

type Trend = "gaining" | "losing" | "steady";

/**
 * Rate of change of the live delta, smoothed over ~0.5 s: "gaining" while the delta is falling right now (this
 * corner is quicker than the reference), "losing" while it rises.
 */
export function useDeltaTrend(deltaS: number | null): { trend: Trend; rate: number } {
  const hist = useRef<{ t: number; d: number }[]>([]);
  const rateRef = useRef(0);
  // Only the trend and a quantised strength are state, so this re-renders when the chevron actually changes
  const [out, setOut] = useState<{ trend: Trend; rate: number }>({ trend: "steady", rate: 0 });
  useEffect(() => {
    const now = performance.now();
    const h = hist.current;
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
  }, [deltaS]);
  return out;
}

/** Double chevron pointing the way the delta is moving: left / green while gaining, right / red while losing */
const Chevron: React.FC<{ trend: Trend; rate: number; side: "left" | "right" }> = ({ trend, rate, side }) => {
  const show = (trend === "gaining" && side === "left") || (trend === "losing" && side === "right");
  const color = trend === "gaining" ? HUD_GREEN : HUD_RED;
  // Stronger rate, brighter chevron
  const strength = Math.min(1, Math.abs(rate) / 0.4);
  return (
    <svg
      viewBox="0 0 16 12"
      width={16}
      height={12}
      aria-hidden
      className="shrink-0 transition-opacity duration-150"
      style={{ opacity: show ? 0.45 + strength * 0.55 : 0, transform: side === "left" ? "scaleX(-1)" : undefined }}
    >
      <path d="M2 1l5 5-5 5M8 1l5 5-5 5" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/**
 * Live delta to the reference lap on a ±1 s scale centred at zero.
 * Ahead (negative) fills green to the left; behind (positive) fills red to the right. Chevrons either side of the
 * readout show which way it is moving right now.
 */
export const DeltaBar: React.FC<{ deltaS: number | null; width?: number }> = ({ deltaS, width = 260 }) => {
  const { trend, rate } = useDeltaTrend(deltaS);
  const has = deltaS !== null;
  const d = deltaS ?? 0;
  const ahead = d <= 0;
  const frac = Math.min(1, Math.abs(d)) * 50;
  const aheadPct = has && ahead ? frac : 0;
  const behindPct = has && !ahead ? frac : 0;

  const textColor = has ? (ahead ? HUD_GREEN : HUD_RED) : HUD_SLATE;

  return (
    <div
      className="relative h-[26px]"
      style={{ width }}
      role="meter"
      aria-label="Delta to reference lap"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={has ? Math.max(-1, Math.min(1, d)) : 0}
      aria-valuetext={has ? `${formatDelta(d)} seconds, ${trend}` : "No reference lap"}
    >
      <div className="absolute inset-x-0 top-2 h-2.5 overflow-hidden rounded-full bg-[#08090D]/70 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <span
          className="absolute inset-y-0 right-1/2 transition-[width] duration-[120ms] ease-out"
          style={{ width: `${aheadPct}%`, backgroundColor: HUD_GREEN }}
        />
        <span
          className="absolute inset-y-0 left-1/2 transition-[width] duration-[120ms] ease-out"
          style={{ width: `${behindPct}%`, backgroundColor: HUD_RED }}
        />
        {/* ±0.5 s ticks */}
        <span className="absolute inset-y-0 left-1/4 w-px bg-[#F5F7FA]/15" />
        <span className="absolute inset-y-0 left-3/4 w-px bg-[#F5F7FA]/15" />
        <span className="absolute inset-y-0 left-1/2 w-px bg-[#F5F7FA]/50" />
      </div>
      <span className="absolute top-0 left-1/2 flex -translate-x-1/2 items-center gap-1">
        <Chevron trend={trend} rate={rate} side="left" />
        <span
          className="lc-data rounded-full border border-[#262B3D] bg-[#08090D] px-2.5 py-[5px] text-[12px] leading-none"
          style={{ color: textColor }}
        >
          {has ? `${formatDelta(d)}s` : "—"}
        </span>
        <Chevron trend={trend} rate={rate} side="right" />
      </span>
    </div>
  );
};
