"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, X } from "lucide-react";
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
  /** Why the board refused the last upload (e.g. the name is taken), shown under the buttons */
  submitError?: string | null;
}

/** How long the collapsed toast stays up before it clears itself */
const TOAST_MS = 12_000;

/**
 * Post-lap toast, bottom right (top right on touch screens, clear of the on-screen pedals): lap time, status
 * badge and sector colours, out of the way while driving. It clears itself after a few seconds unless the
 * pointer is on it or a submit is in flight. Clicking it opens the full card with sector splits vs the
 * session best, stats and per-corner speeds, which stays until it is collapsed or closed.
 */
export const LapSummary: React.FC<LapSummaryProps> = (props) => {
  const { summary: s, onClose, submitState = "idle" } = props;
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  // The HUD re-renders every frame with a fresh onClose; the timer must not restart for that
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A new lap starts collapsed again
  useEffect(() => setExpanded(false), [s.lapNumber]);

  useEffect(() => {
    if (expanded || hovered || submitState === "sending") return;
    const id = window.setTimeout(() => closeRef.current(), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [expanded, hovered, submitState, s.lapNumber]);

  // Escape folds the open card back into the toast
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      key={s.lapNumber}
      className="lc-panel-in pointer-events-auto fixed right-3 bottom-28 z-30 w-[min(420px,calc(100vw-1.5rem))] sm:right-4 lg:bottom-4 pointer-coarse:top-44 pointer-coarse:bottom-auto"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {expanded ? (
        <LapCard {...props} onCollapse={() => setExpanded(false)} />
      ) : (
        <LapToast summary={s} onOpen={() => setExpanded(true)} onClose={onClose} />
      )}
    </div>,
    document.body
  );
};

function statusBadge(s: LapSummaryData): React.ReactNode {
  if (!s.valid) return <Pill color={HUD_RED} textColor="#FFFFFF">INVALID</Pill>;
  if (s.isPersonalBest) return <Pill color={HUD_PURPLE} textColor="#FFFFFF">PB</Pill>;
  if (s.deltaToBestMs === null) return null;
  return <Pill color={s.deltaToBestMs <= 0 ? HUD_GREEN : HUD_YELLOW}>{formatDelta(s.deltaToBestMs / 1000)}s</Pill>;
}

/** Collapsed toast: lap time, status and the three sector colours; the whole card opens the details */
const LapToast: React.FC<{ summary: LapSummaryData; onOpen: () => void; onClose: () => void }> = ({
  summary: s,
  onOpen,
  onClose,
}) => (
  <div className="hud-panel ml-auto flex w-fit max-w-full items-stretch overflow-hidden rounded-lg text-[#F5F7FA]">
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Lap ${s.lapNumber}: show sector data`}
      className="flex cursor-pointer items-center gap-3 py-2 pr-2 pl-3 text-left transition-colors hover:bg-[#1B1F2B]/70"
    >
      <span className="flex flex-col">
        <span className="hud-label !text-[9px]">LAP {s.lapNumber}</span>
        <span className="hud-num text-[22px] leading-tight tracking-tight">{formatLapTime(s.lapTimeMs)}</span>
      </span>
      <span className="flex flex-col items-end gap-1.5">
        {statusBadge(s)}
        <span className="flex gap-1" aria-hidden>
          {s.sectorTimesMs.map((t, idx) => (
            <span
              key={idx}
              className="h-1.5 w-5 rounded-full"
              style={{ backgroundColor: sectorColor(t, s.bestSectorTimesMs[idx]) }}
            />
          ))}
        </span>
      </span>
      <span className="flex items-center gap-0.5 self-end font-f1-mono text-[9px] font-bold tracking-wider text-[#8E96AA]">
        SECTORS <ChevronUp className="h-3 w-3" />
      </span>
    </button>
    <button
      type="button"
      onClick={onClose}
      aria-label="Dismiss lap summary"
      className="cursor-pointer border-l border-[#262B3D] px-2 text-[#8E96AA] transition-colors hover:text-[#F5F7FA]"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
);

/** Open card: lap time with status badge, sector splits vs session best, stats, and per-corner speeds */
const LapCard: React.FC<LapSummaryProps & { onCollapse: () => void }> = ({
  summary: s,
  onClose,
  onCollapse,
  onSaveGhost,
  onSubmit,
  submitState = "idle",
  submitRank = null,
  submitError = null,
}) => {
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
      className="hud-panel f1-corner-tr w-full max-h-[calc(100dvh-9rem)] overflow-y-auto pointer-coarse:max-h-[calc(100dvh-12rem)] rounded-lg p-4 text-[#F5F7FA]"
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
        <div className="mt-1 flex shrink-0 items-start gap-2">
          {badge}
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse lap summary"
            className="cursor-pointer rounded border border-[#262B3D] bg-[#08090D] p-1 text-[#8E96AA] transition-colors hover:text-[#F5F7FA]"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
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
          Close
        </button>
      </div>
      {submitState === "error" && submitError ? (
        <p className="mt-2 text-right font-f1-mono text-[11px] leading-snug" style={{ color: HUD_RED }}>
          {submitError}
        </p>
      ) : null}
    </div>
  );
};
