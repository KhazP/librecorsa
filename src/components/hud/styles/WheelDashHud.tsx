"use client";

import React, { useEffect, useState } from "react";
import { formatDelta, formatLapTime, formatSectorTime } from "../hud-format";
import { TyreMini } from "../TyreBrakeWidget";
import { anchor, arcPoints, deltaColor, gearLabel, HUD_GLASS, HUD_LBL, MiniMap, raceNeighbours, useSectorFlash, type HudDesignProps } from "./hud-style-parts";
import { PedalBars } from "../PedalBars";

const LEDS = 15;
const LED_COLORS = [...Array(5).fill("#00E676"), ...Array(5).fill("#FF2A3C"), ...Array(5).fill("#2F8BE5")] as string[];
/** Shift lights along the top of the wheel screen, in a 320 × 52 box starting at x = 160 */
const LED_ARC = arcPoints(LEDS, 320, 300.2, 290.2, 56);

/** Rounded cell of the dash screen */
const Cell: React.FC<{ label: string; children: React.ReactNode; className?: string; tone?: string; style?: React.CSSProperties }> = ({
  label,
  children,
  className = "",
  tone,
  style,
}) => (
  <div
    className={`flex min-w-0 flex-col justify-between gap-1 rounded-[12px] border border-[#1B1F2B] bg-[#050608] px-2.5 py-1.5 @max-[600px]:px-2 ${className}`}
    style={style}
  >
    <span className={HUD_LBL} style={tone ? { color: tone } : undefined}>
      {label}
    </span>
    {children}
  </div>
);

/** Slim pill bar inside a cell */
const Bar: React.FC<{ pct: number; color: string; className?: string }> = ({ pct, color, className = "h-1.5" }) => (
  <span className={`relative overflow-hidden rounded-full bg-[#11131A] ${className}`}>
    <span className="absolute inset-y-0 left-0" style={{ width: `${pct}%`, backgroundColor: color }} />
  </span>
);

/** Shift lights blink at the shift point */
function useBlink(on: boolean, periodMs = 70): boolean {
  const [phase, setPhase] = useState(false);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setPhase((p) => !p), periodMs);
    return () => window.clearInterval(id);
  }, [on, periodMs]);
  return on && phase;
}

/** The steering-wheel screen: shift lights, gear, speed, delta, energy, pedals, tyres and brakes. Fills its parent's width. */
export const WheelDash: React.FC<Pick<HudDesignProps, "t" | "deltaS" | "revRange" | "lapInvalid">> = ({
  t,
  deltaS,
  revRange,
  lapInvalid = t.offTrack,
}) => {
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = t.rpm >= revFull;
  const blink = useBlink(shift);
  const flash = useSectorFlash(t);
  const nb = raceNeighbours(t);
  const hasErs = t.f12026?.hasErs ?? true;

  return (
    <section
      aria-label="Wheel dash"
      className="@container rounded-[96px_96px_24px_24px/48px_48px_24px_24px] border border-[#2C3246] bg-gradient-to-b from-[#171A25] to-[#07080B] px-3 pt-2.5 pb-2.5 shadow-[0_24px_60px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.08)]"
    >
      {/* Shift lights */}
      <svg viewBox="160 0 320 52" className="mx-auto mb-1 block h-auto w-[40%]" aria-label={`Shift lights: ${shift ? LEDS : lit} of ${LEDS} lit`}>
        {LED_ARC.map(([x, y], i) => {
          const on = shift ? blink : i < lit;
          return <circle key={i} cx={x} cy={y} r={7.5} fill={on ? (shift ? "#B845FF" : LED_COLORS[i]) : "#1B1F2B"} />;
        })}
      </svg>

      {/* Screen */}
      <div className="grid grid-cols-[1fr_112px_1fr] gap-1.5 rounded-[18px] border border-[#1B1F2B] bg-black p-1.5 @max-[600px]:grid-cols-[1fr_92px_1fr]">
        <div className="grid grid-rows-[1fr_auto] gap-1.5">
          <Cell label="Speed">
            <span className="flex items-end justify-between gap-2">
              <PedalBars t={t} size="compact" showClutch={false} />
              <span className="lc-data text-[32px] leading-none text-[#F5F7FA] @max-[600px]:text-[28px]">{Math.round(t.speedKmh)}</span>
            </span>
          </Cell>
          {hasErs ? (
            <Cell label="ERS · battery" tone="#00E5FF">
              <span className="lc-data flex items-center gap-2 text-[12px] @max-[600px]:text-[11px]">
                <span className="text-[#F5F7FA]">{Math.round(t.ersBatteryPercent)}%</span>
                <Bar pct={t.ersBatteryPercent} color="#00E5FF" className="h-1.5 flex-1" />
                <span style={{ color: t.mgukPowerKw > 0 ? "#00E5FF" : t.mgukPowerKw < 0 ? "#00E676" : "#8E96AA" }}>
                  {t.mgukPowerKw > 0 ? "DEP" : t.mgukPowerKw < 0 ? "HRV" : "—"}
                </span>
              </span>
            </Cell>
          ) : (
            <Cell label="Top speed">
              <span className="lc-data self-end text-[14px] text-[#F5F7FA]">{Math.round(t.topSpeedThisLapKmh)}</span>
            </Cell>
          )}
        </div>

        <div className="flex flex-col items-center justify-between rounded-[14px] border border-[#1B1F2B] bg-[#050608] py-1.5">
          <span className={HUD_LBL}>Gear</span>
          <span className="lc-data text-[68px] leading-[0.9] @max-[600px]:text-[58px]" style={{ color: shift ? "#B845FF" : "#F5F7FA", textShadow: shift ? "0 0 18px #B845FF" : "none" }}>
            {gearLabel(t.gear)}
          </span>
          {hasErs ? (
            <span
              className={`rounded-full px-2 py-px font-f1-mono text-[9px] font-extrabold tracking-[0.12em] ${
                t.activeAeroMode === "X_MODE" ? "bg-[#CCFF00] text-[#08090D]" : "bg-[#1B1F2B] text-[#8E96AA]"
              }`}
            >
              {t.activeAeroMode === "X_MODE" ? "X-MODE" : "Z-MODE"}
            </span>
          ) : (
            <span className="lc-data text-[10px] text-[#8E96AA]">{Math.round(t.rpm)}</span>
          )}
        </div>

        <div className="grid grid-rows-[1fr_auto] gap-1.5">
          <Cell label="Delta" tone={deltaColor(deltaS)}>
            <span className="lc-data self-end text-[32px] leading-none @max-[600px]:text-[28px]" style={{ color: deltaColor(deltaS) }}>
              {deltaS === null ? "--.---" : formatDelta(deltaS)}
            </span>
          </Cell>
          <div className="grid grid-cols-2 gap-1.5">
            <Cell
              label={flash ? (flash.sector ? `S${flash.sector}` : "Lap") : "Lap time"}
              tone={flash?.color}
              style={flash ? { borderColor: `${flash.color}80`, backgroundColor: `${flash.color}14` } : undefined}
            >
              <span className="lc-data text-[12px] whitespace-nowrap @max-[600px]:text-[11px]" style={{ color: flash?.color ?? (lapInvalid ? "#FF2A3C" : "#F5F7FA") }}>
                {flash ? (flash.sector ? formatSectorTime(flash.ms) : formatLapTime(flash.ms)) : formatLapTime(t.currentLapTimeMs)}
              </span>
            </Cell>
            <div className="flex min-w-0 flex-col justify-center gap-1 rounded-[12px] border border-[#1B1F2B] bg-[#050608] px-2.5 py-1.5 @max-[600px]:px-2">
              <span className="flex items-baseline justify-between gap-2">
                <span className={HUD_LBL} style={{ color: "#B845FF" }}>
                  Best
                </span>
                <span className="lc-data text-[12px] whitespace-nowrap text-[#F5F7FA] @max-[600px]:text-[11px]">{formatLapTime(t.bestLapTimeMs)}</span>
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className={HUD_LBL}>{nb ? "Gap ▲" : "Last"}</span>
                <span className="lc-data text-[12px] whitespace-nowrap text-[#F5F7FA] @max-[600px]:text-[11px]">
                  {nb ? (nb.ahead ? nb.ahead.gap.toFixed(2) : "LEAD") : formatLapTime(t.lastLapTimeMs)}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Tyres, brakes, fuel */}
      <div className={`mt-1.5 grid gap-1.5 ${t.fuelKg > 0 ? "grid-cols-[1fr_auto]" : "grid-cols-1"}`}>
        <div className="grid grid-cols-4 gap-1.5">
          {[0, 1, 2, 3].map((i) => (
            <TyreMini key={i} t={t} i={i} />
          ))}
        </div>
        {t.fuelKg > 0 ? (
          <div className="flex items-center gap-1.5 rounded-[10px] border border-[#1B1F2B] bg-[#050608] px-2">
            <span className={HUD_LBL}>Fuel</span>
            <span className="lc-data text-[12px] text-[#F5F7FA]">{t.fuelKg.toFixed(1)}kg</span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

/** Position / lap tag */
export const PositionTag: React.FC<{ t: HudDesignProps["t"] }> = ({ t }) => {
  const race = t.race;
  return (
    <div className={`flex items-center gap-2.5 rounded-full py-1.5 pr-4 pl-1.5 font-f1-mono ${HUD_GLASS}`}>
      {race ? (
        <span className="lc-data flex h-9 items-center rounded-full bg-[#CCFF00] px-3 text-[18px] text-[#08090D]">P{race.position}</span>
      ) : (
        <span className="flex h-9 items-center rounded-full bg-[#1B1F2B] px-3 text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA]">PRACTICE</span>
      )}
      <span className="flex flex-col leading-[1.05]">
        <span className={HUD_LBL}>Lap</span>
        <span className="lc-data text-[18px] text-[#F5F7FA]">
          {race ? `${race.lap}${race.totalLaps ? `/${race.totalLaps}` : ""}` : Math.max(1, t.lapCount)}
        </span>
      </span>
    </div>
  );
};

/**
 * Wheel Dash: the car's own steering-wheel display, centred low where a wheel's screen sits.
 * Shift lights across the top, the gear dead centre, delta and pace to the right, energy and
 * tyres below. Everything the engineer would show you in one place, nothing in the corners.
 */
export const WheelDashHud: React.FC<HudDesignProps> = ({ t, deltaS, map, revRange, scale, mfd, lapInvalid, mapMode }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-[clamp(14px,2.2vw,24px)] left-[clamp(14px,2.2vw,24px)]" style={anchor(scale, "top left")}>
      <PositionTag t={t} />
    </div>

    <div className="absolute top-[clamp(14px,2.2vw,24px)] right-[clamp(14px,2.2vw,24px)] hidden w-[180px] md:block" style={anchor(scale, "top right")}>
      <MiniMap map={map} t={t} local={mapMode === "local"} className="block h-[130px] w-full drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" stroke={18} />
    </div>

    {mfd ? (
      <div className="absolute right-[clamp(14px,2.2vw,24px)] bottom-[clamp(14px,2.2vw,24px)] hidden lg:block" style={anchor(scale, "bottom right")}>
        {mfd}
      </div>
    ) : null}

    <div
      data-hud-avoid
      className="absolute bottom-[clamp(14px,2.2vw,24px)] left-1/2 w-[min(660px,calc(100vw-24px))] -translate-x-1/2"
      style={anchor(scale, "bottom center")}
    >
      <WheelDash t={t} deltaS={deltaS} revRange={revRange} lapInvalid={lapInvalid} />
    </div>
  </div>
);
