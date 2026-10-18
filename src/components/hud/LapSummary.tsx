"use client";

import React, { useEffect } from "react";
import type { CornerStat, LapSummaryData } from "@/lib/sim/lap-types";
import {
  HUD_GREEN,
  HUD_PURPLE,
  HUD_RED,
  HUD_SLATE,
  HUD_VOLT,
  HUD_YELLOW,
  formatDelta,
  formatLapTime,
  formatSectorTime,
} from "./hud-format";

const EMPTY = "—";
const MINUS = "−";

/** Coloured badge used for the lap-status pill */
const Pill: React.FC<{ color: string; textColor?: string; children: React.ReactNode }> = ({
  color,
  textColor = "#08090D",
  children,
}) => (
  <span
    className="hud-num rounded-sm px-1.5 py-1 text-[12px] tracking-wider"
    style={{ backgroundColor: color, color: textColor }}
  >
    {children}
  </span>
);

/** Corner delta vs the best minimum speed: green faster, yellow slower, dash when there is no reference */
function cornerDelta(c: CornerStat): { text: string; color: string } {
  if (c.bestMinSpeedKmh === null) return { text: EMPTY, color: HUD_SLATE };
  const d = c.minSpeedKmh - c.bestMinSpeedKmh;
  if (Math.abs(d) < 0.05) return { text: "0.0", color: HUD_SLATE };
  return d > 0
    ? { text: `+${d.toFixed(1)}`, color: HUD_GREEN }
    : { text: `${MINUS}${Math.abs(d).toFixed(1)}`, color: HUD_YELLOW };
}

/** Purple when at or inside the session best (or no best yet), yellow when slower */
function sectorColor(time: number, best: number | null): string {
  return best === null || time <= best ? HUD_PURPLE : HUD_YELLOW;
}

interface LapSummaryProps {
  summary: LapSummaryData;
  onClose: () => void;
  onSaveGhost?: () => void;
  onSubmit?: () => void;
  submitState?: "idle" | "sending" | "sent" | "error";
  submitRank?: number | null;
}

/** Post-lap card: lap time with status badge, sector splits vs session best, stats, and per-corner speeds */
export const LapSummary: React.FC<LapSummaryProps> = ({
  summary: s,
  onClose,
  onSaveGhost,
  onSubmit,
  submitState = "idle",
  submitRank = null,
}) => {
  // Escape dismisses the card
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  let badge: React.ReactNode = null;
  if (!s.valid) {
    badge = <Pill color={HUD_RED} textColor="#FFFFFF">INVALID · TRACK LIMITS</Pill>;
  } else if (s.isPersonalBest) {
    badge = <Pill color={HUD_PURPLE} textColor="#FFFFFF">PERSONAL BEST</Pill>;
  } else if (s.deltaToBestMs !== null) {
    const ahead = s.deltaToBestMs <= 0;
    badge = (
      <Pill color={ahead ? HUD_GREEN : HUD_YELLOW}>{formatDelta(s.deltaToBestMs / 1000)}s</Pill>
    );
  }

  const submitLabel =
    submitState === "sending"
      ? "Sending…"
      : submitState === "sent"
        ? submitRank != null
          ? `Sent · P${submitRank}`
          : "Sent"
        : submitState === "error"
          ? "Failed — retry"
          : "Submit to leaderboard";
  const submitDisabled = !s.valid || submitState === "sending" || submitState === "sent";

  const stats: { label: string; value: string }[] = [
    { label: "TOP KM/H", value: `${Math.round(s.topSpeedKmh)}` },
    { label: "AVG KM/H", value: `${Math.round(s.avgSpeedKmh)}` },
    { label: "FULL THR", value: `${s.fullThrottlePct.toFixed(0)}%` },
    { label: "BRAKING", value: `${s.brakingPct.toFixed(0)}%` },
  ];

  return (
    <div
      role="dialog"
      aria-label={`Lap ${s.lapNumber} summary`}
      className="hud-panel f1-corner-tr pointer-events-auto w-full max-w-[420px] rounded-lg p-4 text-[#F5F7FA]"
    >
      {/* Header: lap number, big lap time, status badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[#CCFF00]" />
            <span className="hud-label !text-[#F5F7FA]">LAP {s.lapNumber}</span>
          </div>
          <div className="hud-num mt-1.5 text-[40px] tracking-tight text-[#F5F7FA]">
            {formatLapTime(s.lapTimeMs)}
          </div>
        </div>
        <div className="mt-1 shrink-0">{badge}</div>
      </div>

      {/* Sector splits, coloured against the session best */}
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {s.sectorTimesMs.map((t, idx) => {
          const color = sectorColor(t, s.bestSectorTimesMs[idx]);
          return (
            <div
              key={idx}
              className="overflow-hidden rounded border border-[#262B3D] bg-[#08090D] px-1.5 pb-1 pt-0.5"
            >
              <div className="-mx-1.5 -mt-0.5 mb-1 h-1" style={{ backgroundColor: color }} />
              <div className="flex items-baseline justify-between">
                <span className="font-f1-mono text-[9px] font-bold text-[#8E96AA]">S{idx + 1}</span>
                <span className="hud-num text-[12px]" style={{ color }}>
                  {formatSectorTime(t)}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Theoretical best */}
      <div className="mt-2.5 flex items-baseline justify-between border-t border-[#262B3D] pt-2">
        <span className="hud-label !text-[9px]" style={{ color: HUD_PURPLE }}>
          THEORETICAL BEST
        </span>
        <span className="hud-num text-[15px] text-[#F5F7FA]">
          {s.theoreticalBestMs === null ? EMPTY : formatLapTime(s.theoreticalBestMs)}
        </span>
      </div>

      {/* Stats row */}
      <div className="mt-2.5 grid grid-cols-4 gap-1.5">
        {stats.map((st) => (
          <div key={st.label} className="rounded border border-[#262B3D] bg-[#08090D] px-1.5 py-1">
            <div className="font-f1-mono text-[8px] font-bold tracking-wider text-[#8E96AA]">{st.label}</div>
            <div className="hud-num mt-0.5 text-[15px] text-[#F5F7FA]">{st.value}</div>
          </div>
        ))}
      </div>

      {/* Corner table */}
      <div className="mt-3">
        <div className="mb-1 grid grid-cols-[40px_1fr_56px_56px] gap-2 font-f1-mono text-[9px] font-bold tracking-wider text-[#8E96AA]">
          <span>TURN</span>
          <span>NAME</span>
          <span className="text-right">MIN KM/H</span>
          <span className="text-right">Δ BEST</span>
        </div>
        <div className="max-h-[180px] overflow-y-auto divide-y divide-[#262B3D]/60">
          {s.corners.length === 0 ? (
            <div className="py-2 font-f1-mono text-[11px] text-[#8E96AA]">No corner data</div>
          ) : (
            s.corners.map((c) => {
              const d = cornerDelta(c);
              return (
                <div
                  key={c.turnNumber}
                  className="grid grid-cols-[40px_1fr_56px_56px] items-center gap-2 py-1 font-f1-mono text-[11px]"
                >
                  <span className="hud-num text-[13px] text-[#CCFF00]">T{c.turnNumber}</span>
                  <span className="min-w-0 truncate text-[#F5F7FA]">{c.name}</span>
                  <span className="hud-num text-right text-[13px] text-[#F5F7FA]">
                    {Math.round(c.minSpeedKmh)}
                  </span>
                  <span className="hud-num text-right text-[12px]" style={{ color: d.color }}>
                    {d.text}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-[#262B3D] pt-3">
        {onSaveGhost ? (
          <button
            type="button"
            onClick={onSaveGhost}
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-3 py-1.5 font-f1-mono text-[11px] font-bold uppercase text-[#8E96AA] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00]"
          >
            Save ghost file
          </button>
        ) : null}
        {onSubmit ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={submitDisabled}
            className="cursor-pointer rounded border px-3 py-1.5 font-f1-mono text-[11px] font-bold uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            style={
              submitState === "error"
                ? { borderColor: HUD_RED, color: HUD_RED, backgroundColor: "#08090D" }
                : submitState === "sent"
                  ? { borderColor: HUD_GREEN, color: HUD_GREEN, backgroundColor: "#08090D" }
                  : { borderColor: HUD_VOLT, color: "#08090D", backgroundColor: HUD_VOLT }
            }
          >
            {submitLabel}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-3 py-1.5 font-f1-mono text-[11px] font-bold uppercase text-[#F5F7FA] transition-colors hover:border-[#8E96AA]"
        >
          Close <span className="text-[#8E96AA]">Esc</span>
        </button>
      </div>
    </div>
  );
};
