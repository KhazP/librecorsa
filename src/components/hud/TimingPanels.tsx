"use client";

import React from "react";
import type { CarTelemetry, RaceStatus } from "@/types/f1";
import {
  HUD_GREEN,
  HUD_PURPLE,
  HUD_RED,
  HUD_YELLOW,
  formatDelta,
  formatLapTime,
  formatSectorTime,
} from "./hud-format";

/** Race order (F1 TV timing tower): position, team colour, driver code, gap to the leader */
export const TimingTower: React.FC<{ race: RaceStatus }> = ({ race }) => (
  <div className="hud-panel w-[230px] overflow-hidden rounded-md">
    <div className="flex items-center justify-between bg-[#E10600] px-3 py-1.5">
      <span className="hud-num text-[15px] italic text-white">
        LAP {race.lap}
      </span>
      <span className="hud-label !text-white/85">
        P{race.position}/{race.fieldSize}
      </span>
    </div>
    <ol>
      {race.standings.map((e, i) => (
        <li
          key={e.driverCode}
          className={`flex h-8 items-center gap-2 px-2 ${
            e.isPlayer ? "bg-white text-[#111]" : i % 2 ? "bg-white/[0.03] text-white" : "text-white"
          }`}
        >
          <span className="hud-num w-5 text-right text-[15px]">{i + 1}</span>
          <span className="h-5 w-1 rounded-sm" style={{ backgroundColor: e.teamColorHex }} />
          <span className="hud-num flex-1 text-[15px] tracking-wider">{e.driverCode}</span>
          <span
            className={`hud-num text-[14px] ${e.isPlayer ? "text-[#111]" : "text-white/80"}`}
          >
            {i === 0 ? "LEADER" : `+${e.gapToLeaderS.toFixed(1)}`}
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

/** Current lap time, live delta to the best lap, sector boxes and last / best lap */
export const LapPanel: React.FC<LapPanelProps> = ({ telemetry, deltaS }) => {
  const sectors = [0, 1, 2].map((idx) => {
    const sec = (idx + 1) as 1 | 2 | 3;
    const done = sec < telemetry.currentSector;
    const t = done ? telemetry.sectorTimesMs[idx] : null;
    const best = telemetry.bestSectorTimesMs[idx];
    const color = !done
      ? sec === telemetry.currentSector
        ? "rgba(255,255,255,0.18)"
        : "rgba(255,255,255,0.08)"
      : best !== null && t !== null && t <= best
        ? HUD_PURPLE
        : HUD_YELLOW;
    return { sec, t, color, done };
  });

  return (
    <div className="hud-panel w-[230px] rounded-md px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="hud-label">Lap {Math.max(1, telemetry.lapCount)}</span>
        {deltaS !== null ? (
          <span
            className="hud-num rounded px-1.5 py-0.5 text-[15px] text-white"
            style={{ backgroundColor: deltaS <= 0 ? HUD_GREEN : HUD_RED }}
          >
            {formatDelta(deltaS)}
          </span>
        ) : null}
      </div>
      <div className="hud-num mt-1 text-[34px] text-white">
        {formatLapTime(telemetry.currentLapTimeMs)}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {sectors.map((s) => (
          <div key={s.sec}>
            <div className="h-1.5 rounded-sm" style={{ backgroundColor: s.color }} />
            <div className="mt-1 flex justify-between">
              <span className="hud-label !text-[10px]">S{s.sec}</span>
              <span className="hud-num text-[12px] text-white/85">{s.done ? formatSectorTime(s.t) : ""}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-white/10 pt-2">
        <div>
          <div className="hud-label !text-[10px]">Last</div>
          <div className="hud-num text-[16px] text-white/90">{formatLapTime(telemetry.lastLapTimeMs)}</div>
        </div>
        <div className="text-right">
          <div className="hud-label !text-[10px]" style={{ color: HUD_PURPLE }}>
            Best
          </div>
          <div className="hud-num text-[16px] text-white">{formatLapTime(telemetry.bestLapTimeMs)}</div>
        </div>
      </div>
    </div>
  );
};
