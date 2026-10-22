"use client";

import React from "react";
import { HUD_CYAN, HUD_GLASS, HUD_LBL, HUD_SLATE, HUD_YELLOW } from "./hud-format";

/** What the HUD shows of the weather (LibreCorsaSimulator samples the session's WeatherState a few times a second) */
export interface WeatherHudState {
  airC: number;
  trackC: number;
  /** Water on the racing line (mm) */
  waterMm: number;
  /** Rain intensity 0..1 */
  rain: number;
  /** Clock (hours) */
  clockH: number;
  /** Time of day moves in this session: the badge shows the clock */
  timeMoving: boolean;
  /** Relative humidity (%) */
  humidityPct?: number;
  /** Wind speed (m/s) */
  windSpeedMs?: number;
  /** Wind cardinal/octant direction */
  windDirection?: string;
}

/** Track surface word and colour from the water on the racing line */
function surface(waterMm: number): { label: string; color: string } {
  if (waterMm < 0.03) return { label: "Dry", color: "#F5F7FA" };
  if (waterMm < 0.14) return { label: "Damp", color: HUD_YELLOW };
  if (waterMm < 1.1) return { label: "Wet", color: "#3CCB4A" };
  return { label: "Flooded", color: "#2E7BFF" };
}

const clock = (h: number) => {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Small pill: air / track temperature, the track's state and rain */
export const WeatherBadge: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const s = surface(weather.waterMm);
  return (
    <div className={`inline-flex h-8 items-center gap-3 rounded-full py-1 pr-3.5 pl-3.5 ${HUD_GLASS}`} role="status" aria-label="Weather">
      {weather.timeMoving ? <span className="lc-data text-[11px] tabular-nums text-[#F5F7FA]">{clock(weather.clockH)}</span> : null}
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>Air</span>
        <span className="lc-data text-[12px] tabular-nums text-[#F5F7FA]">{weather.airC.toFixed(0)}°</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>Track</span>
        <span className="lc-data text-[12px] tabular-nums text-[#F5F7FA]">{weather.trackC.toFixed(0)}°</span>
      </span>
      <span aria-hidden className="h-4 w-px bg-[#262B3D]" />
      <span className="lc-data text-[11px] tracking-[0.1em] uppercase" style={{ color: s.color }}>
        {s.label}
      </span>
      {weather.rain > 0.05 ? (
        <span className="lc-data text-[11px] tracking-[0.1em] uppercase" style={{ color: weather.rain > 0.5 ? HUD_CYAN : HUD_SLATE }}>
          {weather.rain > 0.5 ? "Heavy rain" : "Rain"}
        </span>
      ) : null}
      {weather.windSpeedMs !== undefined && weather.windSpeedMs >= 0.5 ? (
        <span className="flex items-center gap-1">
          <span className={HUD_LBL}>{weather.windDirection ?? "Wind"}</span>
          <span className="lc-data text-[11px] tabular-nums text-[#C5CBD8]">{Math.round(weather.windSpeedMs * 3.6)} km/h</span>
        </span>
      ) : null}
    </div>
  );
};
