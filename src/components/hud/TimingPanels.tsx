"use client";

import React from "react";
import type { CarTelemetry, RaceStatus } from "@/types/f1";
import {
  HUD_CYAN,
  HUD_GREEN,
  HUD_PURPLE,
  HUD_RED,
  HUD_VOLT,
  HUD_YELLOW,
  formatDelta,
  formatLapTime,
  formatSectorTime,
} from "./hud-format";

/** Black / white chequer tile for finished-car markers */
const CHEQUER_BG = "repeating-conic-gradient(#F5F7FA 0% 25%, #08090D 0% 50%) 0 0 / 6px 6px";

/** Race order (LibreCorsa telemetry timing tower): position, class/livery bar, driver code, interval to leader */
export const TimingTower: React.FC<{ race: RaceStatus }> = ({ race }) => (
  <div className="hud-panel w-[244px] overflow-hidden rounded-lg">
    <div className="flex items-center justify-between border-b border-[#262B3D] bg-[#11131A] px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="h-3.5 w-1 rounded-full bg-[#CCFF00]" />
        <span className="hud-num text-[14px] italic tracking-wider text-[#F5F7FA]">
          LAP {race.lap}
          {race.totalLaps ? `/${race.totalLaps}` : ""}
        </span>
      </div>
      <span className="rounded-sm bg-[#CCFF00] px-1.5 py-0.5 font-f1-mono text-[11px] font-black text-[#08090D]">
        P{race.position}/{race.fieldSize}
      </span>
    </div>
    <ol className="divide-y divide-[#262B3D]/50">
      {race.standings.map((e, i) => (
        <li
          key={`${i}-${e.driverCode}`}
          title={e.name && e.name !== e.driverCode ? e.name : undefined}
          className={`flex h-8 items-center gap-2 px-2.5 transition-colors ${
            e.isPlayer
              ? "border-l-2 border-l-[#CCFF00] bg-[#CCFF00]/14 text-[#F5F7FA]"
              : i % 2
                ? "bg-white/[0.02] text-[#F5F7FA]"
                : "text-[#F5F7FA]"
          }`}
        >
          <span
            className={`hud-num w-5 text-right text-[14px] ${
              e.isPlayer ? "text-[#CCFF00]" : "text-[#8E96AA]"
            }`}
          >
            {i + 1}
          </span>
          <span
            className="h-4 w-1 rounded-full"
            style={{ backgroundColor: e.isPlayer ? HUD_VOLT : e.teamColorHex }}
          />
          <span
            className={`hud-num flex-1 text-[14px] tracking-wider ${
              e.isPlayer ? "text-[#CCFF00]" : "text-[#F5F7FA]"
            }`}
          >
            {e.driverCode}
          </span>
          {e.finished ? (
            <span className="h-2.5 w-2.5 shrink-0" style={{ background: CHEQUER_BG }} />
          ) : null}
          <span
            className={`font-f1-mono text-[12px] font-bold tabular-nums ${
              i === 0 ? "text-[#CCFF00]" : e.isPlayer ? "text-[#F5F7FA]" : "text-[#8E96AA]"
            }`}
          >
            {i === 0 ? "LEADER" : `+${e.gapToLeaderS.toFixed(1)}s`}
          </span>
        </li>
      ))}
    </ol>
  </div>
);

interface LapPanelProps {
  telemetry: CarTelemetry;
  deltaS: number | null;
}

/** Current lap time, live delta bar & badge, 3-sector telemetry cells, and last / best lap comparison */
export const LapPanel: React.FC<LapPanelProps> = ({ telemetry, deltaS }) => {
  const sectors = [0, 1, 2].map((idx) => {
    const sec = (idx + 1) as 1 | 2 | 3;
    const done = sec < telemetry.currentSector;
    const active = sec === telemetry.currentSector;
    const t = done ? telemetry.sectorTimesMs[idx] : null;
    const best = telemetry.bestSectorTimesMs[idx];
    const color = !done
      ? active
        ? HUD_CYAN
        : "rgba(255,255,255,0.12)"
      : best !== null && t !== null && t <= best
        ? HUD_PURPLE
        : HUD_YELLOW;
    return { sec, t, color, done, active };
  });

  // Normalized delta bar (-1.0s to +1.0s)
  const deltaNorm = deltaS !== null ? Math.max(-1, Math.min(1, deltaS / 1.0)) : 0;

  return (
    <div className="hud-panel f1-corner-tr w-[244px] rounded-lg px-3.5 py-2.5">
      {/* Header: Lap Counter & Live Delta Pill */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#CCFF00]" />
          <span className="hud-label !text-[#F5F7FA]">
            LAP {Math.max(1, telemetry.lapCount)}
          </span>
        </div>
        {deltaS !== null ? (
          <span
            className="hud-num rounded px-1.5 py-0.5 text-[14px]"
            style={{
              backgroundColor: deltaS <= 0 ? HUD_GREEN : HUD_RED,
              color: deltaS <= 0 ? "#08090D" : "#FFFFFF",
            }}
          >
            {formatDelta(deltaS)}s
          </span>
        ) : (
          <span className="hud-label !text-[9px]">NO REF LAP</span>
        )}
      </div>

      {/* Live Visual Delta Gauge (Center = 0.000s, Right = Faster Green, Left = Slower Red) */}
      <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[#08090D] border border-[#262B3D]">
        <span className="absolute inset-y-0 left-1/2 z-10 w-[1.5px] -translate-x-1/2 bg-white/50" />
        {deltaS !== null ? (
          <span
            className="absolute inset-y-0 transition-all duration-75"
            style={
              deltaNorm <= 0
                ? {
                    left: "50%",
                    width: `${Math.abs(deltaNorm) * 50}%`,
                    backgroundColor: HUD_GREEN,
                  }
                : {
                    right: "50%",
                    width: `${deltaNorm * 50}%`,
                    backgroundColor: HUD_RED,
                  }
            }
          />
        ) : null}
      </div>

      {/* Main Current Lap Timer */}
      <div className="hud-num mt-2 text-[36px] tracking-tight text-[#F5F7FA]">
        {formatLapTime(telemetry.currentLapTimeMs)}
      </div>

      {/* 3-Sector Telemetry Cells */}
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        {sectors.map((s) => (
          <div
            key={s.sec}
            className="overflow-hidden rounded bg-[#08090D] border border-[#262B3D] px-1.5 pb-1 pt-0.5"
          >
            <div className="-mx-1.5 -mt-0.5 mb-1 h-1" style={{ backgroundColor: s.color }} />
            <div className="flex items-baseline justify-between">
              <span
                className="font-f1-mono text-[9px] font-bold"
                style={{ color: s.active ? HUD_CYAN : "#8E96AA" }}
              >
                S{s.sec}
              </span>
              <span className="hud-num text-[11px] text-[#F5F7FA]">
                {s.done ? formatSectorTime(s.t) : "--.-"}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Last & Best Lap Footer */}
      <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-[#262B3D] pt-2">
        <div>
          <div className="hud-label !text-[9px]">LAST LAP</div>
          <div className="hud-num mt-0.5 text-[15px] text-[#F5F7FA]/90">
            {formatLapTime(telemetry.lastLapTimeMs)}
          </div>
        </div>
        <div className="text-right">
          <div className="hud-label !text-[9px]" style={{ color: HUD_PURPLE }}>
            BEST LAP
          </div>
          <div className="hud-num mt-0.5 text-[15px] text-[#F5F7FA]">
            {formatLapTime(telemetry.bestLapTimeMs)}
          </div>
        </div>
      </div>
    </div>
  );
};
