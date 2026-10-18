"use client";

import React from "react";
import { Fuel, Zap } from "lucide-react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { formatDelta, formatLapTime, formatSectorTime, HUD_RED, tyreTempColor } from "../hud-format";
import { LibreCorsaMark } from "../../ui/LibreCorsaLogo";
import { anchor, COMPOUND_COLORS, gearLabel, MiniMap, sectorColor, type HudDesignProps } from "./hud-style-parts";

/** Timing tower in a race, the session card (lap time, sectors, best / last) in practice */
export const BroadcastTower: React.FC<{ t: CarTelemetry; trackCode?: string; className?: string }> = ({ t, trackCode = "LC", className = "" }) => {
  const race = t.race;
  return (
    <div className={`w-[232px] overflow-hidden rounded-sm shadow-[0_10px_30px_rgba(0,0,0,0.6)] ${className}`}>
      <div className="flex items-center gap-2 bg-[#F5F7FA] px-2.5 py-1.5 text-[#08090D]">
        <LibreCorsaMark className="h-6 w-6" />
        <div className="flex-1 font-f1-italic text-[15px] leading-none tracking-wider uppercase">
          {race ? (
            <>
              Lap {race.lap}
              {race.totalLaps ? <span className="text-[#08090D]/45">/{race.totalLaps}</span> : null}
            </>
          ) : (
            <>
              Practice <span className="text-[#08090D]/45">· Lap {Math.max(1, t.lapCount)}</span>
            </>
          )}
        </div>
        <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.18em] text-[#08090D]/60">{trackCode}</span>
      </div>
      {race ? (
        <ol className="bg-[#08090D]/88 backdrop-blur-md">
          {race.standings.map((e, i) => (
            <li
              key={`${e.driverCode}-${i}`}
              className={`flex h-[27px] items-center gap-2 border-t border-white/[0.06] pr-2.5 font-f1-mono text-[12.5px] font-bold ${
                e.isPlayer ? "bg-[#CCFF00] text-[#08090D]" : "text-[#F5F7FA]"
              }`}
            >
              <span className="w-7 text-center font-f1-italic text-[14px]">{i + 1}</span>
              <span className="h-4 w-[3px] rounded-full" style={{ backgroundColor: e.isPlayer ? "#08090D" : e.teamColorHex }} />
              <span className="flex-1 truncate tracking-[0.12em]">{e.driverCode}</span>
              <span className={e.isPlayer ? "" : "text-[#8E96AA]"}>
                {e.finished ? "Flag" : i === 0 ? "Leader" : `+${e.gapToLeaderS.toFixed(3)}`}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="bg-[#08090D]/88 px-3 pt-2 pb-2.5 backdrop-blur-md">
          <div className={`hud-num font-f1-mono text-[28px] ${t.offTrack ? "text-[#FF2A3C]" : "text-[#F5F7FA]"}`}>
            {formatLapTime(t.currentLapTimeMs)}
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => {
              const done = i + 1 < t.currentSector;
              const active = i + 1 === t.currentSector;
              const ms = t.sectorTimesMs[i];
              return (
                <div key={i} className="rounded-[2px] bg-white/[0.06] px-1.5 py-1">
                  <div
                    className="mb-1 h-[3px] rounded-full"
                    style={{ backgroundColor: done ? sectorColor(ms, t.bestSectorTimesMs[i]) : active ? "#F5F7FA" : "#262B3D" }}
                  />
                  <div className="font-f1-mono text-[11px] font-bold text-[#F5F7FA]">{done ? formatSectorTime(ms) : `S${i + 1}`}</div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between font-f1-mono text-[11px] font-bold">
            <span className="text-[#8E96AA]">
              BEST <span className="text-[#B845FF]">{formatLapTime(t.bestLapTimeMs)}</span>
            </span>
            <span className="text-[#8E96AA]">
              LAST <span className="text-[#F5F7FA]">{formatLapTime(t.lastLapTimeMs)}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

/** Circuit map card with the sector and the corner you are in */
export const BroadcastMap: React.FC<Pick<HudDesignProps, "t" | "map">> = ({ t, map }) => (
  <div className="w-[210px] rounded-sm bg-[#08090D]/70 p-2 shadow-[0_10px_30px_rgba(0,0,0,0.5)] backdrop-blur-md">
    <MiniMap map={map} t={t} sectors className="h-[130px] w-full" stroke={20} />
    <div className="mt-1 flex items-center justify-between font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA] uppercase">
      <span className="shrink-0">Sector {t.currentSector}</span>
      <span className="truncate pl-2 text-[#F5F7FA]">
        {t.currentTurnNumber ? `T${t.currentTurnNumber} ${t.currentTurnName}` : "Straight"}
      </span>
    </div>
  </div>
);

/**
 * Broadcast: the look of a TV world feed. Timing tower top-left, a sector-coloured map top-right,
 * and one slim slanted telemetry strip along the bottom: everything reads at a glance from the
 * sofa, nothing covers the racing line.
 */
export const BroadcastHud: React.FC<HudDesignProps> = ({ t, deltaS, map, compound = "soft", revRange, scale, trackCode }) => {
  const race = t.race;
  const [revStart, revFull] = revRange;
  const leds = 18;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * leds);
  const shift = t.rpm >= revFull;
  const hasErs = t.f12026?.hasErs ?? true;
  const ahead = race && race.position > 1 ? race.standings[race.position - 2] : null;
  const me = race?.standings[race.position - 1];

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <div className="absolute top-4 left-4" style={anchor(scale, "top left")}>
        <BroadcastTower t={t} trackCode={trackCode} />
      </div>

      <div className="absolute top-4 right-4 hidden md:block" style={anchor(scale, "top right")}>
        <BroadcastMap t={t} map={map} />
      </div>

      {/* Bottom telemetry strip */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2" style={anchor(scale, "bottom center")}>
        {ahead && me ? (
          <div className="mb-2 flex justify-center">
            <div className="hud-slant flex items-center gap-2 bg-[#08090D]/80 px-5 py-1 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA] backdrop-blur-md">
              <span className="text-[#F5F7FA]">P{race!.position}</span> CHASING
              <span style={{ color: ahead.teamColorHex }}>{ahead.driverCode}</span>
              <span className="text-[#F5F7FA]">{(me.gapToLeaderS - ahead.gapToLeaderS).toFixed(3)}s</span>
            </div>
          </div>
        ) : null}
        <div className="flex items-stretch drop-shadow-[0_10px_24px_rgba(0,0,0,0.7)]">
          {/* Tyres */}
          <div className="hud-slant mr-1 hidden items-center gap-1.5 bg-[#08090D]/85 py-2 pr-4 pl-5 backdrop-blur-md sm:flex">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full border-[3px] font-f1-italic text-[12px] text-[#F5F7FA] uppercase"
              style={{ borderColor: COMPOUND_COLORS[compound as TireCompound] }}
            >
              {compound[0]}
            </span>
            <div className="grid grid-cols-2 gap-[3px]">
              {t.tireTempsC.map((c, i) => (
                <span key={i} className="h-[13px] w-[9px] rounded-[2px]" style={{ backgroundColor: tyreTempColor(c) }} />
              ))}
            </div>
          </div>

          {/* Gear */}
          <div className="hud-slant flex w-[74px] items-center justify-center bg-[#CCFF00] text-[#08090D]">
            <span className="font-f1-italic text-[44px] leading-none">{gearLabel(t.gear)}</span>
          </div>

          {/* Speed, revs, pedals */}
          <div className="hud-slant -ml-1 flex flex-col justify-center gap-1.5 bg-[#08090D]/85 py-2 pr-6 pl-6 backdrop-blur-md">
            <div className="flex gap-[3px]">
              {Array.from({ length: leds }, (_, i) => {
                const color = shift ? "#2F8BE5" : i < 8 ? "#00E676" : i < 14 ? HUD_RED : "#2F8BE5";
                return (
                  <span
                    key={i}
                    className="h-[5px] w-[11px] -skew-x-12 rounded-[1px]"
                    style={{ backgroundColor: shift || i < lit ? color : "rgba(255,255,255,0.08)" }}
                  />
                );
              })}
            </div>
            <div className="flex items-end gap-4">
              <div className="flex items-baseline gap-1.5">
                <span className="hud-num w-[78px] text-right font-f1-mono text-[36px] text-[#F5F7FA]">{Math.round(t.speedKmh)}</span>
                <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.18em] text-[#8E96AA]">KM/H</span>
              </div>
              <div className="mb-1 flex flex-col gap-[5px]">
                <span className="relative h-[6px] w-[120px] overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-[#00E676]" style={{ width: `${t.throttle * 100}%` }} />
                </span>
                <span className="relative h-[6px] w-[120px] overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-[#FF2A3C]" style={{ width: `${t.brake * 100}%` }} />
                </span>
              </div>
            </div>
          </div>

          {/* Energy and aero (F1), fuel (GT3) */}
          <div className="hud-slant -ml-1 hidden flex-col justify-center gap-1 bg-[#11131A]/90 py-2 pr-6 pl-6 backdrop-blur-md sm:flex">
            {hasErs ? (
              <>
                <div className="flex items-center gap-1.5 font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA]">
                  <Zap aria-hidden className="h-3 w-3 text-[#00E5FF]" fill={t.mgukPowerKw > 0 ? "#00E5FF" : "none"} />
                  ERS <span className="text-[#F5F7FA]">{Math.round(t.ersBatteryPercent)}%</span>
                </div>
                <span className="relative h-[6px] w-[86px] overflow-hidden rounded-full bg-white/10">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-[#00E5FF]" style={{ width: `${t.ersBatteryPercent}%` }} />
                </span>
                <span
                  className={`mt-0.5 w-fit rounded-[2px] px-1.5 font-f1-mono text-[10px] font-extrabold tracking-[0.12em] ${
                    t.activeAeroMode === "X_MODE" ? "bg-[#CCFF00] text-[#08090D]" : "bg-white/10 text-[#8E96AA]"
                  }`}
                >
                  {t.activeAeroMode === "X_MODE" ? "X-MODE" : "Z-MODE"}
                </span>
              </>
            ) : t.fuelKg > 0 ? (
              <>
                <div className="flex items-center gap-1.5 font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA]">
                  <Fuel aria-hidden className="h-3 w-3" /> FUEL
                </div>
                <span className="font-f1-mono text-[16px] font-extrabold text-[#F5F7FA]">{t.fuelKg.toFixed(1)} kg</span>
              </>
            ) : (
              <>
                <div className="font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#8E96AA]">RPM</div>
                <span className="font-f1-mono text-[16px] font-extrabold text-[#F5F7FA]">{Math.round(t.rpm)}</span>
              </>
            )}
          </div>

          {/* Delta */}
          <div
            className="hud-slant -ml-1 flex flex-col justify-center py-2 pr-6 pl-6"
            style={{ backgroundColor: deltaS === null ? "rgba(17,19,26,0.9)" : deltaS <= 0 ? "rgba(0,230,118,0.92)" : "rgba(255,42,60,0.92)" }}
          >
            <span className={`font-f1-mono text-[10px] font-extrabold tracking-[0.18em] ${deltaS === null ? "text-[#8E96AA]" : "text-[#08090D]/70"}`}>
              DELTA
            </span>
            <span className={`hud-num font-f1-mono text-[22px] ${deltaS === null ? "text-[#8E96AA]" : "text-[#08090D]"}`}>
              {deltaS === null ? "--.---" : formatDelta(deltaS)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};
