"use client";

import React from "react";
import { Fuel, Zap } from "lucide-react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { formatDelta, formatLapTime, formatSectorTime, HUD_RED, tyreHeatColor } from "../hud-format";
import { LibreCorsaMark } from "../../ui/LibreCorsaLogo";
import { anchor, COMPOUND_COLORS, gearLabel, HUD_GLASS, MiniMap, sectorColor, type HudDesignProps } from "./hud-style-parts";
import { PedalBars } from "../PedalBars";
import { TowerRows } from "../TimingPanels";

/** Timing tower in a race, the session card (lap time, sectors, best / last) in practice. Fills its parent's width. */
export const BroadcastTower: React.FC<{
  t: CarTelemetry;
  trackCode?: string;
  className?: string;
  lapInvalid?: boolean;
  gaps?: "interval" | "leader";
}> = ({ t, trackCode = "LC", className = "", lapInvalid = t.offTrack, gaps }) => {
  const race = t.race;
  return (
    <section aria-label={race ? "Timing tower" : "Session"} className={`w-full overflow-hidden rounded-[20px] ${HUD_GLASS} ${className}`}>
      <div className="flex h-11 items-center gap-2.5 rounded-[20px_20px_14px_14px] bg-[#F5F7FA] pr-3 pl-2 text-[#08090D]">
        <LibreCorsaMark className="h-7 w-7 shrink-0" />
        <div className="lc-disp flex-1 truncate text-[18px]">
          {race ? (
            <>
              Lap {race.lap}
              {race.totalLaps ? <span className="opacity-40">/{race.totalLaps}</span> : null}
            </>
          ) : (
            <>
              Practice <span className="opacity-45">· Lap {Math.max(1, t.lapCount)}</span>
            </>
          )}
        </div>
        <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.18em] opacity-60">{trackCode}</span>
      </div>
      {race ? (
        <TowerRows race={race} gaps={gaps} mono />
      ) : (
        <div className="px-3 pt-2.5 pb-3">
          <div className={`lc-data text-[30px] leading-none ${lapInvalid ? "text-[#FF2A3C]" : "text-[#F5F7FA]"}`}>
            {formatLapTime(t.currentLapTimeMs)}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => {
              const done = i + 1 < t.currentSector;
              const active = i + 1 === t.currentSector;
              const ms = t.sectorTimesMs[i];
              return (
                <div key={i} className="rounded-lg bg-white/[0.05] px-1.5 py-[5px]">
                  <div
                    className="h-[3px] rounded-full"
                    style={{ backgroundColor: done ? sectorColor(ms, t.bestSectorTimesMs[i]) : active ? "#F5F7FA" : "#262B3D" }}
                  />
                  <div className={`lc-data mt-1 text-[11px] ${done || active ? "text-[#F5F7FA]" : "text-[#8E96AA]"}`}>
                    {done ? formatSectorTime(ms) : `S${i + 1}`}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="lc-data mt-2 flex justify-between gap-2 text-[11px]">
            <span className="text-[#8E96AA]">
              BEST <span className="text-[#B845FF]">{formatLapTime(t.bestLapTimeMs)}</span>
            </span>
            <span className="text-[#8E96AA]">
              LAST <span className="text-[#F5F7FA]">{formatLapTime(t.lastLapTimeMs)}</span>
            </span>
          </div>
        </div>
      )}
    </section>
  );
};

/** Circuit map card with the sector and the corner you are in. Fills its parent's width. */
export const BroadcastMap: React.FC<Pick<HudDesignProps, "t" | "map" | "mapMode">> = ({ t, map, mapMode = "full" }) => (
  <section aria-label="Circuit map" className={`w-full rounded-[22px] px-3.5 py-3 ${HUD_GLASS}`}>
    <MiniMap map={map} t={t} sectors local={mapMode === "local"} className={`block w-full ${mapMode === "local" ? "h-[180px]" : "h-[140px]"}`} stroke={22} />
    <div className="mt-1.5 flex items-center justify-between font-f1-mono text-[10px] font-extrabold tracking-[0.16em] text-[#8E96AA] uppercase">
      <span className="shrink-0">Sector {t.currentSector}</span>
      <span className="truncate pl-2 text-[#F5F7FA]">
        {t.currentTurnNumber ? `T${t.currentTurnNumber} ${t.currentTurnName}` : "Straight"}
      </span>
    </div>
  </section>
);

/** Rev lights: 18 segments along the top of the pod */
const LEDS = 18;
const ledColor = (i: number) => (i < 8 ? "#00E676" : i < 14 ? HUD_RED : "#2F8BE5");

/**
 * Broadcast: the look of a TV world feed. Timing tower top-left, a sector-coloured map top-right,
 * and one telemetry pod along the bottom, a strip of rev lights over speed, gear, energy and the
 * delta: everything reads at a glance from the sofa, nothing covers the racing line.
 */
export const BroadcastHud: React.FC<HudDesignProps> = ({ t, deltaS, map, compound = "soft", revRange, scale, trackCode, mfd, lapInvalid, towerGaps, mapMode }) => {
  const race = t.race;
  const [revStart, revFull] = revRange;
  const lit = Math.round(Math.min(1, Math.max(0, (t.rpm - revStart) / (revFull - revStart))) * LEDS);
  const shift = t.rpm >= revFull;
  const hasErs = t.f12026?.hasErs ?? true;
  const ahead = race && race.position > 1 ? race.standings[race.position - 2] : null;
  const me = race?.standings[race.position - 1];

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <div className="absolute top-[clamp(14px,2.2vw,24px)] left-[clamp(14px,2.2vw,24px)] w-[264px]" style={anchor(scale, "top left")}>
        <BroadcastTower t={t} trackCode={trackCode} lapInvalid={lapInvalid} gaps={towerGaps} />
      </div>

      <div className="absolute top-[clamp(14px,2.2vw,24px)] right-[clamp(14px,2.2vw,24px)] hidden w-[236px] md:block" style={anchor(scale, "top right")}>
        <BroadcastMap t={t} map={map} mapMode={mapMode} />
      </div>

      {mfd ? (
        // Beside the pod on a wide screen, above it on a laptop
        <div
          className="absolute right-[clamp(14px,2.2vw,24px)] bottom-[136px] hidden lg:block xl:bottom-[clamp(14px,2.2vw,24px)]"
          style={anchor(scale, "bottom right")}
        >
          {mfd}
        </div>
      ) : null}

      {/* Bottom telemetry pod */}
      <div
        className="absolute bottom-[clamp(14px,2.2vw,24px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5"
        style={anchor(scale, "bottom center")}
      >
        {ahead && me ? (
          <div
            className={`inline-flex h-[30px] items-center gap-2.5 rounded-full px-4 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA] ${HUD_GLASS}`}
          >
            <span className="text-[#F5F7FA]">P{race!.position}</span> CHASING
            <span style={{ color: ahead.teamColorHex }}>{ahead.driverCode}</span>
            <span className="text-[#F5F7FA] tabular-nums">{(me.gapToLeaderS - ahead.gapToLeaderS).toFixed(3)}s</span>
          </div>
        ) : null}

        <div data-hud-avoid className={`flex flex-col gap-2 rounded-[28px] p-2 ${HUD_GLASS}`}>
          {/* Rev lights; all blue at the shift point */}
          <div className="flex gap-[3px] px-4 pt-1" aria-hidden>
            {Array.from({ length: LEDS }, (_, i) => (
              <span
                key={i}
                className="h-[5px] flex-1 rounded-full"
                style={{ backgroundColor: shift ? "#2F8BE5" : i < lit ? ledColor(i) : "rgba(255,255,255,0.08)" }}
              />
            ))}
          </div>

          <div className="flex items-center gap-1">
            {/* Tyres */}
            <div className="hidden items-center gap-2.5 pr-3 pl-3 lg:flex">
              <span
                className="lc-disp flex h-[34px] w-[34px] items-center justify-center rounded-full border-4 text-[14px] text-[#F5F7FA]"
                style={{ borderColor: COMPOUND_COLORS[compound as TireCompound] }}
              >
                {compound[0]}
              </span>
              <span className="grid grid-cols-[repeat(2,15px)] gap-[3px]" aria-label="Tyre temperatures, inner / middle / outer">
                {t.tireTempsC.map((c, i) => {
                  const bands = t.tireBandTempsC?.[i] ?? [c, c, c];
                  const flagged = (t.tireGrainLevel?.[i] ?? 0) > 0.12 || (t.tireBlisterLevel?.[i] ?? 0) > 0.12 || (t.tireFlatSpotSeverity?.[i] ?? 0) > 0.12;
                  return (
                    <span
                      key={i}
                      className="flex h-[18px] gap-px rounded-[4px] border-[1.5px] p-px"
                      style={{ borderColor: flagged ? "#FF6B8A" : tyreHeatColor(c, t.tireOptimalTempC) }}
                    >
                      {bands.map((b, k) => (
                        <span key={k} className="flex-1 rounded-[1px]" style={{ backgroundColor: tyreHeatColor(b, t.tireOptimalTempC) }} />
                      ))}
                    </span>
                  );
                })}
              </span>
            </div>

            {/* Speed and pedals */}
            <div className="flex items-center gap-3.5 px-4 lg:border-l lg:border-white/[0.08]">
              <div className="flex flex-col items-end">
                <span className="lc-data w-[84px] text-right text-[42px] leading-none tracking-[-0.02em] text-[#F5F7FA] tabular-nums">
                  {Math.round(t.speedKmh)}
                </span>
                <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.16em] text-[#8E96AA]">KM/H</span>
              </div>
              <PedalBars t={t} size="compact" />
            </div>

            {/* Gear */}
            <span
              className={`flex h-[68px] w-[68px] shrink-0 items-center justify-center rounded-[20px] transition-colors duration-75 ${
                shift ? "bg-[#2F8BE5] text-[#F5F7FA]" : "bg-[#CCFF00] text-[#08090D]"
              }`}
            >
              <span className="lc-disp text-[48px] leading-none">{gearLabel(t.gear)}</span>
            </span>

            {/* Energy and aero (F1), fuel (GT3) */}
            <div className="hidden w-[118px] shrink-0 flex-col gap-1.5 px-4 sm:flex">
              {hasErs ? (
                <>
                  <span className="flex items-center justify-between font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA]">
                    <span className="inline-flex items-center gap-1">
                      <Zap aria-hidden className="h-3 w-3 text-[#00E5FF]" fill={t.mgukPowerKw > 0 ? "#00E5FF" : "none"} />
                      ERS
                    </span>
                    <span className="text-[#F5F7FA] tabular-nums">{Math.round(t.ersBatteryPercent)}%</span>
                  </span>
                  <span className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-[#00E5FF]" style={{ width: `${t.ersBatteryPercent}%` }} />
                  </span>
                  <span
                    className={`w-fit rounded-full px-2 py-0.5 font-f1-mono text-[10px] font-extrabold tracking-[0.1em] ${
                      t.activeAeroMode === "X_MODE" ? "bg-[#CCFF00] text-[#08090D]" : "bg-[#1B1F2B] text-[#8E96AA]"
                    }`}
                  >
                    {t.activeAeroMode === "X_MODE" ? "X-MODE" : "Z-MODE"}
                  </span>
                </>
              ) : t.fuelKg > 0 ? (
                <>
                  <span className="flex items-center gap-1.5 font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA]">
                    <Fuel aria-hidden className="h-3 w-3" /> FUEL
                  </span>
                  <span className="lc-data text-[18px] leading-none whitespace-nowrap text-[#F5F7FA]">{t.fuelKg.toFixed(1)} kg</span>
                </>
              ) : (
                <>
                  <span className="font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#8E96AA]">RPM</span>
                  <span className="lc-data text-[18px] leading-none text-[#F5F7FA] tabular-nums">{Math.round(t.rpm)}</span>
                </>
              )}
            </div>

            {/* Delta: fixed width so the number never reflows the pod */}
            <div
              className={`flex h-[68px] w-[132px] shrink-0 flex-col justify-center gap-1 rounded-[20px] px-4 ${
                deltaS === null ? "bg-[#1B1F2B] text-[#8E96AA]" : deltaS <= 0 ? "bg-[#00E676] text-[#08090D]" : "bg-[#FF2A3C] text-[#08090D]"
              }`}
            >
              <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.18em] opacity-70">DELTA</span>
              <span className="lc-data text-[24px] leading-none whitespace-nowrap tabular-nums">
                {deltaS === null ? "--.---" : formatDelta(Math.max(-99.999, Math.min(99.999, deltaS)))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
