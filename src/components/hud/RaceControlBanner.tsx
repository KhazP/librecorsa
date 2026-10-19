"use client";

import React from "react";
import type { TrackLimitsStatus } from "@/types/f1";
import { HUD_GREEN, HUD_RED, HUD_SLATE, HUD_YELLOW } from "./hud-format";

const TONES = {
  warning: { bg: HUD_YELLOW, fg: "#08090D", badge: "#08090D", badgeFg: HUD_YELLOW },
  penalty: { bg: HUD_RED, fg: "#F5F7FA", badge: "#F5F7FA", badgeFg: HUD_RED },
  lap_invalid: { bg: HUD_RED, fg: "#F5F7FA", badge: "#F5F7FA", badgeFg: HUD_RED },
  cleared: { bg: HUD_GREEN, fg: "#08090D", badge: "#08090D", badgeFg: HUD_GREEN },
  no_advantage: { bg: "rgba(8,9,13,0.86)", fg: "#F5F7FA", badge: "#1B1F2B", badgeFg: HUD_SLATE },
} as const;

/** Strike pips: the warnings of the current cycle towards the next penalty */
const Pips: React.FC<{ n: number; of: number; color: string; empty: string }> = ({ n, of, color, empty }) => (
  <span className="inline-flex gap-1" aria-hidden>
    {Array.from({ length: of }, (_, i) => (
      <span key={i} className="h-2 w-2 rounded-full" style={{ backgroundColor: i < n ? color : empty }} />
    ))}
  </span>
);

/**
 * Top-centre race-control banner for the judged track limits: the excursion under review, what is still to give
 * back, then the decision (warning n/3, a time penalty, lap deleted, advantage given back or no further action).
 */
export const RaceControlBanner: React.FC<{ status: TrackLimitsStatus | undefined; offTrack: boolean; race: boolean }> = ({
  status,
  offTrack,
  race,
}) => {
  const pending = status?.pending ?? null;
  const msg = status?.message ?? null;

  if (pending && pending.stage === "give_back") {
    const gain = pending.gainS;
    const giveBackPos = pending.giveBackPosition ?? null;
    return (
      <div
        role="alert"
        className="lc-alert relative mt-1.5 flex min-w-[300px] flex-col gap-1.5 overflow-hidden rounded-[22px] px-4 pt-2.5 pb-3 text-[#08090D] shadow-[0_12px_34px_rgba(255,179,0,0.3)]"
        style={{ backgroundColor: HUD_YELLOW }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.18em] opacity-70">
            {giveBackPos !== null ? "RACE CONTROL · ILLEGAL OVERTAKE" : "RACE CONTROL"}
          </span>
          <span className="lc-data text-[12px] tabular-nums">{pending.remainingS.toFixed(1)}s</span>
        </div>
        <span className="lc-disp text-[19px] leading-none whitespace-nowrap">
          {giveBackPos !== null
            ? `Hand back position · drop to P${giveBackPos}`
            : gain !== null
              ? `Give back ${gain.toFixed(2)}s`
              : "Lift to give the advantage back"}
        </span>
        <span className="relative h-1.5 w-full overflow-hidden rounded-full bg-[#08090D]/20">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-[#08090D] transition-[width] duration-100"
            style={{ width: `${Math.round(pending.progress * 100)}%` }}
          />
        </span>
      </div>
    );
  }

  if (msg) {
    const tone = TONES[msg.kind];
    return (
      <div
        role="alert"
        className="lc-alert relative mt-1.5 inline-flex min-h-12 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 shadow-[0_12px_34px_rgba(0,0,0,0.4)]"
        style={{ backgroundColor: tone.bg, color: tone.fg }}
      >
        <span
          className="inline-flex h-8 shrink-0 items-center rounded-full px-2.5 font-f1-mono text-[10px] font-extrabold tracking-[0.14em]"
          style={{ backgroundColor: tone.badge, color: tone.badgeFg }}
        >
          RC
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[17px] whitespace-nowrap sm:text-[19px]">{msg.text}</span>
          {msg.detail ? <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.12em] uppercase opacity-75">{msg.detail}</span> : null}
        </span>
        {race && status && (msg.kind === "warning" || msg.kind === "penalty") ? (
          <Pips n={status.warnings} of={status.strikesPerPenalty} color={tone.fg} empty={msg.kind === "warning" ? "rgba(8,9,13,0.25)" : "rgba(245,247,250,0.3)"} />
        ) : null}
      </div>
    );
  }

  if (offTrack || (pending && pending.stage !== "off")) {
    return (
      <div
        role="status"
        className="relative mt-1.5 inline-flex h-11 items-center gap-2.5 rounded-full border border-[#FFB300]/60 bg-[#08090D]/[0.86] pr-5 pl-2 text-[#F5F7FA] shadow-[0_12px_34px_rgba(0,0,0,0.45)]"
      >
        <span className="relative inline-flex h-[28px] w-[28px] items-center justify-center rounded-full" style={{ backgroundColor: HUD_YELLOW }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#08090D" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M12 8v5M12 16.5h.01" />
          </svg>
        </span>
        <span className="lc-disp text-[16px] whitespace-nowrap sm:text-[18px]">Track limits</span>
        <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.14em] text-[#FFB300] uppercase">
          {offTrack ? "Off track" : "Under review"}
        </span>
        {race && status ? <Pips n={status.warnings} of={status.strikesPerPenalty} color={HUD_YELLOW} empty="#262B3D" /> : null}
      </div>
    );
  }
  return null;
};
