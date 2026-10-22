"use client";

import React from "react";
import type { CarTelemetry, RaceStatus, TireCompound } from "@/types/f1";
import {
  HUD_CYAN,
  HUD_GLASS,
  HUD_GREEN,
  HUD_LBL,
  HUD_PURPLE,
  HUD_RED,
  HUD_SLATE,
  HUD_VOLT,
  HUD_YELLOW,
  formatDelta,
  formatLapTime,
  formatSectorTime,
} from "./hud-format";
import { LibreCorsaMark } from "../ui/LibreCorsaLogo";

/** Black / white chequer tile for finished-car markers */
const CHEQUER_BG = "repeating-conic-gradient(#F5F7FA 0% 25%, #08090D 0% 50%) 0 0 / 6px 6px";

const TOWER_COMPOUND: Record<TireCompound, string> = {
  soft: HUD_RED,
  medium: HUD_YELLOW,
  hard: "#F5F7FA",
  intermediate: "#3CCB4A",
  wet: "#2E7BFF",
};

/**
 * The tower's lines: position, livery bar, driver code with the tyre, fastest-lap and penalty badges, the gap (to the
 * car ahead or to the leader) and the last lap against the player's (yours against your best on your own line).
 */
export const TowerRows: React.FC<{ race: RaceStatus; gaps?: "interval" | "leader"; mono?: boolean }> = ({ race, gaps = "interval", mono = false }) => {
  const st = race.standings;
  const me = st.find((e) => e.isPlayer);
  const fastest = st.reduce<number | null>((m, e) => (e.bestLapMs && (m === null || e.bestLapMs < m) ? e.bestLapMs : m), null);
  return (
    <ol className="m-0 list-none pt-1.5 pb-2">
      {st.map((e, i) => {
        const gap = i === 0 ? null : gaps === "leader" ? e.gapToLeaderS : (e.intervalS ?? e.gapToLeaderS - st[i - 1].gapToLeaderS);
        // Their last lap against yours: − (red) they were quicker, + (green) you were
        const lastD = e.isPlayer
          ? e.lastLapMs && e.bestLapMs
            ? (e.lastLapMs - e.bestLapMs) / 1000
            : null
          : e.lastLapMs && me?.lastLapMs
            ? (e.lastLapMs - me.lastLapMs) / 1000
            : null;
        const lastColor = lastD === null ? HUD_SLATE : e.isPlayer ? (lastD <= 0.0005 ? HUD_PURPLE : HUD_YELLOW) : lastD < 0 ? HUD_RED : HUD_GREEN;
        const purple = fastest !== null && e.bestLapMs === fastest;
        return (
          <li
            key={`${i}-${e.driverCode}`}
            title={e.name && e.name !== e.driverCode ? e.name : undefined}
            className={`grid h-[30px] grid-cols-[22px_4px_1fr_auto_40px] items-center gap-2 text-[13px] tabular-nums ${
              mono ? "font-f1-mono font-extrabold" : "lc-data"
            } ${e.isPlayer ? "mx-1.5 my-0.5 rounded-full bg-[#CCFF00] pr-2.5 pl-0.5 text-[#08090D]" : "pr-2.5 pl-2 text-[#F5F7FA]"}`}
          >
            <span className={`text-center italic ${e.isPlayer ? "" : "text-[#8E96AA]"}`}>{i + 1}</span>
            <span className="h-4 rounded-full" style={{ backgroundColor: e.isPlayer ? "#08090D" : e.teamColorHex }} />
            <span className="flex min-w-0 items-center gap-1.5 tracking-[0.1em]">
              <span className="truncate">{e.driverCode}</span>
              {e.compound ? (
                <span
                  className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border-[2px] text-[7px] leading-none tracking-normal"
                  style={{ borderColor: TOWER_COMPOUND[e.compound], backgroundColor: e.isPlayer ? "#08090D" : "transparent", color: "#F5F7FA" }}
                  aria-label={`${e.compound} tyres`}
                >
                  {e.compound[0].toUpperCase()}
                </span>
              ) : null}
              {purple ? (
                <span className="shrink-0 rounded-[4px] bg-[#B845FF] px-1 text-[8px] leading-[14px] tracking-[0.06em] text-[#F5F7FA]" title="Fastest lap">
                  FL
                </span>
              ) : null}
              {e.penaltyS ? (
                <span className="shrink-0 rounded-[4px] bg-[#FF2A3C] px-1 text-[8px] leading-[14px] tracking-normal text-[#F5F7FA]">+{e.penaltyS.toFixed(0)}s</span>
              ) : null}
              {e.finished ? <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: CHEQUER_BG }} /> : null}
            </span>
            <span className={`text-[12px] ${e.isPlayer ? "" : i === 0 ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>
              {gap === null ? (gaps === "leader" ? "Leader" : "Lead") : `+${gap.toFixed(1)}`}
            </span>
            <span
              className="text-right text-[10px]"
              style={{ color: e.isPlayer && lastD !== null ? "#08090D" : lastColor, opacity: lastD === null ? 0.5 : 1 }}
              title={e.isPlayer ? "Last lap against your best" : "Their last lap against yours"}
            >
              {lastD === null ? "" : e.isPlayer && lastD <= 0.0005 ? "PB" : `${lastD > 0 ? "+" : "−"}${Math.abs(lastD).toFixed(2)}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** Race order (LibreCorsa telemetry timing tower): position, class/livery bar, driver code, gaps and last laps */
export const TimingTower: React.FC<{ race: RaceStatus; trackCode?: string; gaps?: "interval" | "leader" }> = ({ race, trackCode, gaps }) => (
  <section aria-label="Timing tower" className={`w-[264px] overflow-hidden rounded-[20px] ${HUD_GLASS}`}>
    {/* Pitboard header: mark, lap of laps, position and track code */}
    <div className="flex h-11 items-center gap-2.5 rounded-t-[20px] rounded-b-[14px] bg-[#F5F7FA] pr-3 pl-2 text-[#08090D]">
      <LibreCorsaMark className="h-7 w-7 shrink-0" />
      <span className="lc-disp flex-1 text-[18px] leading-none">
        Lap {race.lap}
        {race.totalLaps ? <span className="opacity-40">/{race.totalLaps}</span> : null}
      </span>
      <span className="lc-data rounded-full bg-[#08090D] px-2 py-0.5 text-[11px] text-[#CCFF00]">
        P{race.position}/{race.fieldSize}
      </span>
      {trackCode ? (
        <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.18em] opacity-60">{trackCode}</span>
      ) : null}
    </div>
    <TowerRows race={race} gaps={gaps} />
  </section>
);

interface LapPanelProps {
  telemetry: CarTelemetry;
  deltaS: number | null;
  /** Minimal HUD: a lap pill with a one-line sector and lap-time strip under it */
  variant?: "full" | "minimal";
  /** The running lap was cut: its clock stays crimson until the next lap */
  lapInvalid?: boolean;
}

/** Sector state: purple for a session best, amber slower, cyan in progress, dim to come */
function sectorCells(telemetry: CarTelemetry) {
  return [0, 1, 2].map((idx) => {
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
}

/** Current lap time, live delta bar & badge, 3-sector telemetry cells, and last / best lap comparison */
export const LapPanel: React.FC<LapPanelProps> = ({ telemetry, deltaS, variant = "full", lapInvalid = telemetry.offTrack }) => {
  const sectors = sectorCells(telemetry);
  const lap = Math.max(1, telemetry.lapCount);
  // A cut lap is invalid: the clock shows it in crimson until the next lap starts
  const timeColor = lapInvalid ? HUD_RED : "#F5F7FA";

  if (variant === "minimal") {
    return (
      <div className="flex flex-col items-start gap-1.5">
        <section aria-label="Lap" className={`flex items-center gap-3.5 rounded-full py-2 pr-[18px] pl-2 ${HUD_GLASS}`}>
          <span className="lc-data inline-flex h-10 items-center rounded-full bg-[#1B1F2B] px-3.5 text-[12px] tracking-[0.1em] text-[#F5F7FA]">
            LAP {lap}
          </span>
          <span className="lc-data text-[30px] leading-none" style={{ color: timeColor }}>
            {formatLapTime(telemetry.currentLapTimeMs)}
          </span>
        </section>
        {/* Sectors, delta and last / best on one quiet line */}
        <div className="lc-data hidden items-center gap-2.5 rounded-full bg-[#08090D]/60 px-3 py-1 text-[10px] text-[#8E96AA] sm:flex">
          {sectors.map((s) => (
            <span key={s.sec} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-full" style={{ backgroundColor: s.color }} />
              <span style={{ color: s.active ? HUD_CYAN : undefined }}>S{s.sec}</span>
              <span className={s.done ? "text-[#F5F7FA]" : ""}>{s.done ? formatSectorTime(s.t) : "--.---"}</span>
            </span>
          ))}
          {deltaS !== null ? (
            <span style={{ color: deltaS <= 0 ? HUD_GREEN : HUD_RED }}>{formatDelta(deltaS)}s</span>
          ) : null}
          <span>
            LAST <span className="text-[#F5F7FA]/90">{formatLapTime(telemetry.lastLapTimeMs)}</span>
          </span>
          <span>
            <span style={{ color: HUD_PURPLE }}>BEST</span>{" "}
            <span className="text-[#F5F7FA]">{formatLapTime(telemetry.bestLapTimeMs)}</span>
          </span>
        </div>
      </div>
    );
  }

  // Normalized delta bar (-1.0s to +1.0s): ahead fills green to the left of centre, behind red to the right
  const deltaNorm = deltaS !== null ? Math.max(-1, Math.min(1, deltaS / 1.0)) : 0;

  return (
    <section aria-label="Lap" className={`w-[256px] rounded-[22px] p-3.5 ${HUD_GLASS}`}>
      {/* Header: lap counter and live delta pill */}
      <div className="flex items-center justify-between gap-2">
        <span className="lc-data inline-flex items-center gap-2 text-[13px] tracking-[0.1em] text-[#F5F7FA]">
          <span className="h-[7px] w-[7px] rounded-full bg-[#CCFF00]" />
          LAP {lap}
        </span>
        {deltaS !== null ? (
          <span
            className="lc-data rounded-full px-2.5 py-[3px] text-[12px]"
            style={{
              backgroundColor: deltaS <= 0 ? HUD_GREEN : HUD_RED,
              color: deltaS <= 0 ? "#08090D" : "#F5F7FA",
            }}
          >
            {formatDelta(deltaS)}s
          </span>
        ) : (
          <span className={HUD_LBL}>No ref lap</span>
        )}
      </div>

      {/* Live delta gauge */}
      <div className="relative my-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1B1F2B]">
        <span className="absolute inset-y-0 left-1/2 w-px bg-[#F5F7FA]/50" />
        {deltaS !== null ? (
          <span
            className="absolute inset-y-0 transition-[width] duration-75"
            style={
              deltaNorm <= 0
                ? { right: "50%", width: `${Math.abs(deltaNorm) * 50}%`, backgroundColor: HUD_GREEN }
                : { left: "50%", width: `${deltaNorm * 50}%`, backgroundColor: HUD_RED }
            }
          />
        ) : null}
      </div>

      {/* Current lap clock */}
      <div className="lc-data text-[38px] leading-none tracking-[-0.01em]" style={{ color: timeColor }}>
        {formatLapTime(telemetry.currentLapTimeMs)}
      </div>

      {/* Sector cells */}
      <div className="mt-2.5 grid grid-cols-3 gap-1">
        {sectors.map((s) => (
          <div key={s.sec} className="rounded-[10px] bg-white/[0.05] px-2 py-1.5">
            <div className="h-1 rounded-full" style={{ backgroundColor: s.color }} />
            <div className={`${HUD_LBL} mt-[5px]`} style={s.active ? { color: HUD_CYAN } : undefined}>
              S{s.sec}
            </div>
            <div className="lc-data text-[12px]" style={{ color: s.done ? "#F5F7FA" : HUD_SLATE }}>
              {s.done ? formatSectorTime(s.t) : "--.---"}
            </div>
          </div>
        ))}
      </div>

      {/* Last and best lap */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-[#262B3D] pt-2.5">
        <div>
          <div className={HUD_LBL}>Last lap</div>
          <div className="lc-data text-[15px] text-[#F5F7FA]/90">{formatLapTime(telemetry.lastLapTimeMs)}</div>
        </div>
        <div className="text-right">
          <div className={HUD_LBL} style={{ color: HUD_PURPLE }}>
            Best lap
          </div>
          <div className="lc-data text-[15px] text-[#F5F7FA]">{formatLapTime(telemetry.bestLapTimeMs)}</div>
        </div>
      </div>
    </section>
  );
};
