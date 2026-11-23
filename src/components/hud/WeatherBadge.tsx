"use client";

import React from "react";
import { useTranslations } from "use-intl/react";
import { Icon } from "@/components/ui/icons/Icon";
import { SurfaceBadge, type TrackSurface } from "@/components/ui/badges/SurfaceBadge";
import type { HeadlightMode } from "@/lib/render/car-headlights";
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
  /** Player headlights are currently illuminated */
  headlightsOn?: boolean;
  /** Current headlight mode ('auto' | 'on' | 'off') */
  headlightMode?: HeadlightMode;
  /** Automatic headlights would be active (night, dusk, or heavy rain) */
  headlightsAutoOn?: boolean;
  /** The player is flashing the headlights (high beam) right now */
  headlightFlash?: boolean;
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
const WeatherBadgeView: React.FC<{ weather: WeatherHudState; variant?: "pill" | "panel" }> = ({ weather, variant = "pill" }) => {
  const s = surface(weather.waterMm);
  const units = useUnits();
  const tx = useTranslations("hud.weatherBadge");
  const shape =
    variant === "panel"
      ? "flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lc-tile px-3.5 py-2.5" // under the circuit map
      : "inline-flex h-8 items-center gap-3 rounded-full py-1 pe-3.5 ps-3.5";
  const headlightLabel =
    weather.headlightMode === "on"
      ? tx("headlightsForcedOn")
      : weather.headlightMode === "off"
        ? tx("headlightsForcedOff")
        : tx("headlightsOn");
  return (
    <div role="group" className={`${shape} ${HUD_GLASS}`} aria-label={tx("region")}>
      {weather.timeMoving ? <span className="lc-data text-[11px] text-lc-chalk">{clock(weather.clockH)}</span> : null}
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>{tx("air")}</span>
        <span className="lc-data text-[12px] text-lc-chalk">{formatTemp(weather.airC, units)}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className={HUD_LBL}>{tx("track")}</span>
        <span className="lc-data text-[12px] text-lc-chalk">{formatTemp(weather.trackC, units)}</span>
      </span>
      <SurfaceBadge surface={s} size="sm" />
      {weather.rain > 0.05 ? (
        <span className={`inline-flex items-center gap-1 ${HUD_LBL} ${weather.rain > 0.5 ? "text-lc-info" : ""}`}>
          <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" className="size-3" />
          {weather.rain > 0.5 ? tx("heavyRain") : tx("rain")}
        </span>
      ) : null}
      {weather.windSpeedMs !== undefined && weather.windSpeedMs >= 0.5 ? (
        <span className="flex items-center gap-1">
          <span className={HUD_LBL}>{weather.windDirection ?? tx("wind")}</span>
          <span className="lc-data text-[11px] text-lc-fog">
            {formatSpeed(weather.windSpeedMs * 3.6, units)} {speedUnit(units)}
          </span>
        </span>
      ) : null}
      {weather.headlightsOn === true || weather.headlightFlash === true || (weather.headlightMode !== undefined && weather.headlightMode !== "auto") ? (
        <span
          className={`inline-flex items-center gap-1 ${weather.headlightsOn || weather.headlightFlash ? "text-lc-gain" : "text-lc-slate"}`}
          title={
            weather.headlightMode === "on"
              ? tx("headlightsTitleManualOn")
              : weather.headlightMode === "off"
                ? tx("headlightsTitleManualOff")
                : tx("headlightsTitleAuto")
          }
        >
          <Icon name="headlights" size="xs" label={headlightLabel} className={`size-3.5 ${weather.headlightsOn || weather.headlightFlash ? "" : "opacity-60"}`} />
          {weather.headlightFlash ? (
            <span aria-hidden="true" className="lc-chip-text text-[9px] text-lc-gain">
              {tx("chipFlash")}
            </span>
          ) : weather.headlightMode === "on" ? (
            <span aria-hidden="true" className="lc-chip-text text-[9px] text-lc-gain">
              {tx("chipOn")}
            </span>
          ) : null}
          {!weather.headlightFlash && weather.headlightMode === "off" ? (
            <span aria-hidden="true" className="lc-chip-text text-[9px] text-lc-slate">
              {tx("chipOff")}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

/** Memoised: the HUD re-renders 30 times a second, the weather object only changes a few times a second */
export const WeatherBadge = React.memo(WeatherBadgeView);
