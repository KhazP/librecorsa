"use client";

import React, { useEffect, useState } from "react";
import { formatDelta, formatLapTime, formatSectorTime, HUD_RED, tyreTempColor } from "../hud-format";
import { anchor, deltaColor, gearLabel, MiniMap, raceNeighbours, useSectorFlash, type HudDesignProps } from "./hud-style-parts";

const LEDS = 15;
const LED_COLORS = [...Array(5).fill("#00E676"), ...Array(5).fill("#FF2A3C"), ...Array(5).fill("#2F8BE5")] as string[];

/** Bordered cell of the dash screen */
const Cell: React.FC<{ label: string; children: React.ReactNode; className?: string; tone?: string }> = ({ label, children, className = "", tone }) => (
  <div className={`flex flex-col justify-between rounded-[4px] border border-[#262B3D] bg-black px-2 py-1 ${className}`}>
    <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.18em]" style={{ color: tone ?? "#8E96AA" }}>
      {label}
    </span>
    {children}
  </div>
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

/** The steering-wheel screen: shift lights, gear, speed, delta, energy, pedals, tyres and brakes */
export const WheelDash: React.FC<Pick<HudDesignProps, "t" | "deltaS" | "revRange">> = ({ t, deltaS, revRange }) => {
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = t.rpm >= revFull;
  const blink = useBlink(shift);
  const flash = useSectorFlash(t);
  const nb = raceNeighbours(t);
  const hasErs = t.f12026?.hasErs ?? true;

  return (
    <div className="rounded-[18px] border border-[#2C3246] bg-gradient-to-b from-[#161924] to-[#07080B] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.75),inset_0_1px_0_rgba(255,255,255,0.08)]">
      {/* Shift lights */}
      <div className="mb-2 flex justify-center gap-[6px] px-6">
        {Array.from({ length: LEDS }, (_, i) => {
          const on = shift ? blink : i < lit;
          const c = shift ? "#B845FF" : LED_COLORS[i];
          return (
            <span
              key={i}
              className="h-[11px] w-[11px] rounded-full"
              style={{
                backgroundColor: on ? c : "#1B1F2B",
                boxShadow: on ? `0 0 10px ${c}, 0 0 2px ${c}` : "inset 0 1px 2px rgba(0,0,0,0.8)",
              }}
            />
          );
        })}
      </div>

      {/* Screen */}
      <div className="grid grid-cols-[1fr_118px_1fr] gap-1.5 rounded-[10px] border border-[#262B3D] bg-black p-1.5">
        <div className="grid grid-rows-[1fr_auto_auto] gap-1.5">
          <Cell label="SPEED">
            <span className="hud-num text-right font-f1-mono text-[34px] text-[#F5F7FA]">{Math.round(t.speedKmh)}</span>
          </Cell>
          {hasErs ? (
            <Cell label="ERS · BATTERY" tone="#00E5FF">
              <span className="relative mt-1 h-[9px] overflow-hidden rounded-[2px] bg-[#11131A]">
                <span className="absolute inset-y-0 left-0 bg-[#00E5FF]" style={{ width: `${t.ersBatteryPercent}%` }} />
                {[25, 50, 75].map((m) => (
                  <span key={m} className="absolute inset-y-0 w-px bg-black" style={{ left: `${m}%` }} />
                ))}
              </span>
              <span className="mt-0.5 flex justify-between font-f1-mono text-[11px] font-bold">
                <span className="text-[#F5F7FA]">{Math.round(t.ersBatteryPercent)}%</span>
                <span style={{ color: t.mgukPowerKw > 0 ? "#00E5FF" : t.mgukPowerKw < 0 ? "#00E676" : "#8E96AA" }}>
                  {t.mgukPowerKw > 0 ? "DEPLOY" : t.mgukPowerKw < 0 ? "HARVEST" : "—"}
                </span>
              </span>
            </Cell>
          ) : (
            <Cell label="TOP SPEED">
              <span className="text-right font-f1-mono text-[16px] font-extrabold text-[#F5F7FA]">{Math.round(t.topSpeedThisLapKmh)}</span>
            </Cell>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <Cell label="THR" tone="#00E676">
              <span className="relative mt-1 h-[6px] overflow-hidden rounded-[2px] bg-[#11131A]">
                <span className="absolute inset-y-0 left-0 bg-[#00E676]" style={{ width: `${t.throttle * 100}%` }} />
              </span>
            </Cell>
            <Cell label="BRK" tone={HUD_RED}>
              <span className="relative mt-1 h-[6px] overflow-hidden rounded-[2px] bg-[#11131A]">
                <span className="absolute inset-y-0 left-0 bg-[#FF2A3C]" style={{ width: `${t.brake * 100}%` }} />
              </span>
            </Cell>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between rounded-[6px] border border-[#262B3D] bg-[#050507] py-1.5">
          <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.18em] text-[#8E96AA]">GEAR</span>
          <span
            className="font-f1-mono text-[84px] leading-[0.9] font-extrabold"
            style={{ color: shift ? "#B845FF" : "#F5F7FA", textShadow: shift ? "0 0 18px #B845FF" : "none" }}
          >
            {gearLabel(t.gear)}
          </span>
          {hasErs ? (
            <span
              className={`rounded-[3px] px-2 font-f1-mono text-[10px] font-extrabold tracking-[0.14em] ${
                t.activeAeroMode === "X_MODE" ? "bg-[#CCFF00] text-black" : "bg-[#1B1F2B] text-[#8E96AA]"
              }`}
            >
              {t.activeAeroMode === "X_MODE" ? "X-MODE" : "Z-MODE"}
            </span>
          ) : (
            <span className="font-f1-mono text-[10px] font-bold text-[#8E96AA]">{Math.round(t.rpm)}</span>
          )}
        </div>

        <div className="grid grid-rows-[1fr_auto_auto] gap-1.5">
          <Cell label="DELTA" tone={deltaColor(deltaS)}>
            <span className="hud-num text-right font-f1-mono text-[34px]" style={{ color: deltaColor(deltaS) }}>
              {deltaS === null ? "--.---" : formatDelta(deltaS)}
            </span>
          </Cell>
          <Cell label={flash ? (flash.sector ? `SECTOR ${flash.sector}` : "LAP") : "LAP TIME"} tone={flash?.color}>
            <span
              className="text-right font-f1-mono text-[18px] font-extrabold"
              style={{ color: flash?.color ?? (t.offTrack ? "#FF2A3C" : "#F5F7FA") }}
            >
              {flash ? (flash.sector ? formatSectorTime(flash.ms) : formatLapTime(flash.ms)) : formatLapTime(t.currentLapTimeMs)}
            </span>
          </Cell>
          <div className="grid grid-cols-2 gap-1.5">
            <Cell label="BEST" tone="#B845FF">
              <span className="text-right font-f1-mono text-[11px] font-bold text-[#F5F7FA]">{formatLapTime(t.bestLapTimeMs)}</span>
            </Cell>
            <Cell label={nb ? "GAP ▲" : "LAST"}>
              <span className="text-right font-f1-mono text-[11px] font-bold text-[#F5F7FA]">
                {nb ? (nb.ahead ? nb.ahead.gap.toFixed(2) : "LEAD") : formatLapTime(t.lastLapTimeMs)}
              </span>
            </Cell>
          </div>
        </div>
      </div>

      {/* Tyres, brakes, fuel */}
      <div className={`mt-1.5 grid gap-1.5 px-0.5 ${t.fuelKg > 0 ? "grid-cols-[1fr_auto]" : "grid-cols-1"}`}>
        <div className="grid grid-cols-4 gap-1">
          {(["FL", "FR", "RL", "RR"] as const).map((n, i) => (
            <div key={n} className="flex items-center gap-1.5 rounded-[4px] border border-[#262B3D] bg-black px-1.5 py-[3px]">
              <span className="h-5 w-[6px] rounded-[2px]" style={{ backgroundColor: tyreTempColor(t.tireTempsC[i]) }} />
              <span className="flex flex-col font-f1-mono leading-[1.05]">
                <span className="text-[9px] font-extrabold tracking-[0.12em] text-[#8E96AA]">{n}</span>
                <span className="text-[12px] font-bold text-[#F5F7FA]">{Math.round(t.tireTempsC[i])}°</span>
              </span>
              <span
                className="ml-auto font-f1-mono text-[10px] font-bold"
                style={{ color: t.brakeTempsC[i] > 850 ? "#FF2A3C" : t.brakeTempsC[i] > 600 ? "#FFB300" : "#8E96AA" }}
              >
                {Math.round(t.brakeTempsC[i])}
              </span>
            </div>
          ))}
        </div>
        {t.fuelKg > 0 ? (
          <div className="flex flex-col justify-center rounded-[4px] border border-[#262B3D] bg-black px-2 font-f1-mono leading-tight">
            <span className="text-[9px] font-extrabold tracking-[0.18em] text-[#8E96AA]">FUEL</span>
            <span className="text-[12px] font-bold text-[#F5F7FA]">{t.fuelKg.toFixed(1)}kg</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** Position / lap tag */
export const PositionTag: React.FC<{ t: HudDesignProps["t"] }> = ({ t }) => {
  const race = t.race;
  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-[#262B3D] bg-black/80 font-f1-mono font-extrabold backdrop-blur-md">
      {race ? <span className="flex items-center bg-[#CCFF00] px-2.5 text-[20px] text-[#08090D]">P{race.position}</span> : null}
      <span className="flex flex-col justify-center px-2.5 py-1 leading-tight">
        <span className="text-[9px] tracking-[0.18em] text-[#8E96AA]">LAP</span>
        <span className="text-[15px] text-[#F5F7FA]">{race ? `${race.lap}${race.totalLaps ? `/${race.totalLaps}` : ""}` : Math.max(1, t.lapCount)}</span>
      </span>
    </div>
  );
};

/**
 * Wheel Dash: the car's own steering-wheel display, centred low where a wheel's screen sits.
 * Shift lights across the top, the gear dead centre, delta and pace to the right, energy and
 * tyres below. Everything the engineer would show you in one place, nothing in the corners.
 */
export const WheelDashHud: React.FC<HudDesignProps> = ({ t, deltaS, map, revRange, scale }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-4 left-4" style={anchor(scale, "top left")}>
      <PositionTag t={t} />
    </div>

    <div className="absolute top-3 right-4 hidden w-[170px] opacity-90 md:block" style={anchor(scale, "top right")}>
      <MiniMap map={map} t={t} className="h-[120px] w-full drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" stroke={18} />
    </div>

    <div className="absolute bottom-4 left-1/2 w-[min(640px,calc(100vw-24px))] -translate-x-1/2" style={anchor(scale, "bottom center")}>
      <WheelDash t={t} deltaS={deltaS} revRange={revRange} />
    </div>
  </div>
);
