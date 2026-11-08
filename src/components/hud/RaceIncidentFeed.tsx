"use client";

import React from "react";
import type { RaceControlFeedMessage } from "@/types/f1";
import { HUD_BORDER, HUD_GREEN, HUD_RED, HUD_SLATE, HUD_WHITE, HUD_YELLOW } from "./hud-format";

const TONES: Record<RaceControlFeedMessage["kind"], { bg: string; fg: string; badge: string; badgeFg: string; label: string }> = {
  yellow: { bg: HUD_YELLOW, fg: "#08090D", badge: "#08090D", badgeFg: HUD_YELLOW, label: "FLAG" },
  green: { bg: HUD_GREEN, fg: "#08090D", badge: "#08090D", badgeFg: HUD_GREEN, label: "FLAG" },
  investigation: { bg: "rgba(8,9,13,0.9)", fg: HUD_WHITE, badge: HUD_YELLOW, badgeFg: "#08090D", label: "RC" },
  penalty: { bg: HUD_RED, fg: HUD_WHITE, badge: HUD_WHITE, badgeFg: HUD_RED, label: "RC" },
  warning: { bg: HUD_YELLOW, fg: "#08090D", badge: "#08090D", badgeFg: HUD_YELLOW, label: "RC" },
  nfa: { bg: "rgba(8,9,13,0.86)", fg: HUD_WHITE, badge: "#1B1F2B", badgeFg: HUD_SLATE, label: "RC" },
  retired: { bg: "rgba(8,9,13,0.9)", fg: HUD_WHITE, badge: HUD_RED, badgeFg: HUD_WHITE, label: "OUT" },
  info: { bg: "rgba(8,9,13,0.86)", fg: HUD_WHITE, badge: "#1B1F2B", badgeFg: HUD_SLATE, label: "RC" },
};

/** Race control's latest calls in an AI race: flags, contact investigations, penalties, retirements */
export const RaceIncidentFeed: React.FC<{ messages: RaceControlFeedMessage[] | undefined; yellow?: boolean }> = ({ messages, yellow }) => {
  const latest = messages?.[0];
  if (!latest) {
    // The flag stays up while the player is in the zone, after its message has gone
    if (!yellow) return null;
    return (
      <div
        role="status"
        className="relative mt-1 inline-flex h-9 items-center gap-2 rounded-full pr-4 pl-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.4)]"
        style={{ backgroundColor: HUD_YELLOW, color: "#08090D" }}
      >
        <span className="inline-flex h-6 items-center rounded-full bg-[#08090D] px-2 font-f1-mono text-[9px] font-extrabold tracking-[0.14em] text-[#FFB300]">
          FLAG
        </span>
        <span className="lc-disp text-[15px] whitespace-nowrap">Yellow · no overtaking</span>
      </div>
    );
  }
  const tone = TONES[latest.kind];
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        key={latest.id}
        role="alert"
        className="lc-alert relative mt-1 inline-flex min-h-11 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 shadow-[0_12px_34px_rgba(0,0,0,0.4)]"
        style={{ backgroundColor: tone.bg, color: tone.fg, border: tone.bg.startsWith("rgba") ? `1px solid ${HUD_BORDER}` : undefined }}
      >
        <span
          className="inline-flex h-7 shrink-0 items-center rounded-full px-2.5 font-f1-mono text-[10px] font-extrabold tracking-[0.14em]"
          style={{ backgroundColor: tone.badge, color: tone.badgeFg }}
        >
          {tone.label}
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[16px] whitespace-nowrap sm:text-[18px]">{latest.text}</span>
          {latest.detail ? <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.12em] uppercase opacity-75">{latest.detail}</span> : null}
        </span>
      </div>
      {messages && messages[1] ? (
        <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#8E96AA] uppercase">
          {messages[1].text}
          {messages[1].detail ? ` · ${messages[1].detail}` : ""}
        </span>
      ) : null}
    </div>
  );
};
