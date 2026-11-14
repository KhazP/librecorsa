"use client";

import React from "react";
import { Icon } from "@/components/ui/icons/Icon";
import { SurfaceBadge, type TrackSurface } from "@/components/ui/badges/SurfaceBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { formatSpeed, formatTemp, HUD_GLASS, HUD_LBL, speedUnit } from "./hud-format";

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

/** Track surface from the water on the racing line (the kit's `SurfaceBadge` draws it) */
function surface(waterMm: number): TrackSurface {
  if (waterMm < 0.03) return "dry";
  if (waterMm < 0.14) return "damp";
  if (waterMm < 1.1) return "wet";
  return "flooded";
}

const clock = (h: number) => {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** Small pill: air / track temperature, the track's state and rain */
export const WeatherBadge: React.FC<{ weather: WeatherHudState; variant?: "pill" | "panel" }> = ({ weather, variant = "pill" }) => {
  const s = surface(weather.waterMm);
  const units = useUnits();
  const shape =
    variant === "panel"
      ? "flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lc-tile px-3.5 py-2.5" // under the circuit map
      : "inline-flex h-8 items-center gap-3 rounded-full py-1 pr-3.5 pl-3.5";
  return (
    <div className={`${shape} ${HUD_GLASS}`} aria-label="Weather">
      {weather.timeMoving ? <span className="lc-data text-[11px] text-lc-chalk">{clock(weather.clockH)}</span> : null}
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>Air</span>
        <span className="lc-data text-[12px] text-lc-chalk">{formatTemp(weather.airC, units)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>Track</span>
        <span className="lc-data text-[12px] text-lc-chalk">{formatTemp(weather.trackC, units)}</span>
      </span>
      <SurfaceBadge surface={s} size="sm" />
      {weather.rain > 0.05 ? (
        <span className={`inline-flex items-center gap-1 ${HUD_LBL} ${weather.rain > 0.5 ? "text-lc-info" : ""}`}>
          <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" className="size-3" />
          {weather.rain > 0.5 ? "Heavy rain" : "Rain"}
        </span>
      ) : null}
      {weather.windSpeedMs !== undefined && weather.windSpeedMs >= 0.5 ? (
        <span className="flex items-center gap-1">
          <span className={HUD_LBL}>{weather.windDirection ?? "Wind"}</span>
          <span className="lc-data text-[11px] text-lc-fog">
            {formatSpeed(weather.windSpeedMs * 3.6, units)} {speedUnit(units)}
          </span>
        </span>
      ) : null}
    </div>
  );
};
