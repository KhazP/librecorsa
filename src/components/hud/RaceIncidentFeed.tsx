"use client";

import React from "react";
import type { RaceControlFeedMessage } from "@/types/f1";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { IconName } from "@/components/ui/icons/registry";
import { FlagBadge } from "@/components/ui/badges/FlagBadge";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { HUD_GLASS, HUD_LBL } from "./hud-format";

type Kind = RaceControlFeedMessage["kind"];

/** The badge each call wears (word and icon), and the hairline of its pill */
const BADGE: Record<Exclude<Kind, "yellow" | "green" | "warning">, { tone: BadgeTone; label: string; icon: IconName }> = {
  investigation: { tone: "warn", label: "Investigation", icon: "search" },
  penalty: { tone: "bad", label: "Penalty", icon: "penalty" },
  nfa: { tone: "neutral", label: "No action", icon: "info" },
  retired: { tone: "bad", label: "Out", icon: "damage" },
  info: { tone: "neutral", label: "Race control", icon: "info" },
};

const RING: Record<Kind, string> = {
  yellow: "inset-ring-lc-caution/60",
  green: "inset-ring-lc-gain/60",
  investigation: "inset-ring-lc-caution/60",
  penalty: "inset-ring-lc-loss/70",
  warning: "inset-ring-lc-caution/60",
  nfa: "inset-ring-white/7",
  retired: "inset-ring-lc-loss/70",
  info: "inset-ring-white/7",
};

const CallBadge: React.FC<{ kind: Kind }> = ({ kind }) => {
  if (kind === "yellow") return <FlagBadge flag="yellow" variant="solid" size="lg" />;
  if (kind === "green") return <FlagBadge flag="green" variant="solid" size="lg" />;
  if (kind === "warning") return <PenaltyBadge penalty={{ kind: "warning" }} variant="solid" size="lg" />;
  const b = BADGE[kind];
  return (
    <Badge tone={b.tone} variant="solid" size="lg" icon={b.icon}>
      {b.label}
    </Badge>
  );
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
        className={`relative mt-1 inline-flex h-10 items-center gap-2.5 rounded-full pr-4 pl-1.5 text-lc-chalk inset-ring ${RING.yellow} ${HUD_GLASS}`}
      >
        <FlagBadge flag="yellow" variant="solid" size="lg" />
        <span className="lc-disp text-[15px] whitespace-nowrap">No overtaking</span>
      </div>
    );
  }
  // Bad news and cautions interrupt; the rest is read when convenient. Only bad news pulses (a crimson halo)
  const urgent = latest.kind === "penalty" || latest.kind === "retired" || latest.kind === "yellow" || latest.kind === "warning" || latest.kind === "investigation";
  const bad = latest.kind === "penalty" || latest.kind === "retired";
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        key={latest.id}
        role={urgent ? "alert" : "status"}
        className={`relative mt-1 inline-flex min-h-11 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 text-lc-chalk inset-ring ${RING[latest.kind]} ${
          bad ? "lc-alert" : ""
        } ${HUD_GLASS}`}
      >
        <CallBadge kind={latest.kind} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[16px] whitespace-nowrap sm:text-[18px]">{latest.text}</span>
          {latest.detail ? <span className={`${HUD_LBL} text-lc-fog`}>{latest.detail}</span> : null}
        </span>
      </div>
      {messages && messages[1] ? (
        <span className={`${HUD_LBL} hud-text-shadow text-lc-fog`}>
          {messages[1].text}
          {messages[1].detail ? ` · ${messages[1].detail}` : ""}
        </span>
      ) : null}
    </div>
  );
};
