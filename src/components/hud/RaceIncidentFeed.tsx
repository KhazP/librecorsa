"use client";

import React from "react";
import type { RaceControlFeedMessage, RaceStatus } from "@/types/f1";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { FlagBadge } from "@/components/ui/badges/FlagBadge";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { HUD_GLASS, HUD_LBL } from "./hud-format";
import { SkinBanner, skinCss, skinRootClass, SkinTag, type SkinTone, useHudSkin } from "./styles/third-party-skin";

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

const SKIN_CALL: Record<Kind, { tone: SkinTone; label: string; icon: IconName }> = {
  yellow: { tone: "caution", label: "Yellow", icon: "warning" },
  green: { tone: "gain", label: "Green", icon: "success" },
  warning: { tone: "caution", label: "Warning", icon: "warning" },
  investigation: { tone: "caution", label: "Investigation", icon: "search" },
  penalty: { tone: "loss", label: "Penalty", icon: "penalty" },
  nfa: { tone: "default", label: "No action", icon: "info" },
  retired: { tone: "loss", label: "Out", icon: "damage" },
  info: { tone: "info", label: "Race control", icon: "info" },
};

const CallBadge: React.FC<{ kind: Kind; text?: string }> = ({ kind, text }) => {
  if (kind === "yellow") return <FlagBadge flag={text === "Double yellow" ? "doubleYellow" : "yellow"} variant="solid" size="sm" />;
  if (kind === "green") return <FlagBadge flag="green" variant="solid" size="sm" />;
  if (kind === "warning") return <PenaltyBadge penalty={{ kind: "warning" }} variant="solid" size="sm" />;
  const b = BADGE[kind];
  return (
    <Badge tone={b.tone} variant="solid" size="sm" icon={b.icon}>
      {b.label}
    </Badge>
  );
};

/** Race control's latest calls in an AI race: flags, contact investigations, penalties, retirements */
export const RaceIncidentFeed: React.FC<{
  messages: RaceControlFeedMessage[] | undefined;
  yellow?: boolean;
  /** The yellow is a double yellow */
  doubleYellow?: boolean;
  /** Blue flag: the code of the car lapping the player */
  blueFlag?: string;
  /** True once race control has warned the player to yield under blue flag */
  blueFlagWarn?: boolean;
  /** Virtual Safety Car live delta and phase */
  vsc?: RaceStatus["vsc"];
}> = ({ messages, yellow, doubleYellow, blueFlag, blueFlagWarn, vsc }) => {
  const skin = useHudSkin();
  const latest = messages?.[0];

  // Live VSC delta plate: stays visible whenever VSC is active so the driver can manage the delta even during RC calls
  const vscBar = (() => {
    if (!vsc || skin === "blocks") return null;
    const neg = vsc.deltaS < 0;
    const danger = vsc.deltaS < -0.5;
    const sign = vsc.deltaS >= 0 ? "+" : "−";
    const deltaText = `${sign}${Math.abs(vsc.deltaS).toFixed(2)}s`;
    const tagText = vsc.phase === "ending" ? "VSC ending" : "VSC";
    const cue = danger
      ? "Slow down"
      : vsc.graceS > 0
        ? "Slow to target"
        : vsc.phase === "ending"
          ? "Prepare for green"
          : "No overtaking";
    if (skin !== null) {
      return (
        <SkinBanner
          role={danger ? "alert" : "status"}
          tone={danger ? "loss" : "caution"}
          cut="sm"
          className={`relative mt-1 inline-flex h-8 items-center gap-2 pr-3 pl-2 ${danger ? "lc-alert" : ""}`}
        >
          <SkinTag tone={danger ? "loss" : "caution"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            <FlagIcon flag="doubleYellow" size={14} />
            {tagText}
          </SkinTag>
          <span className={`lc-data text-[15px] font-bold whitespace-nowrap ${neg ? "text-lc-loss" : "text-lc-gain"}`}>{deltaText}</span>
          <span className="text-[12px] font-bold whitespace-nowrap uppercase opacity-85">{cue}</span>
        </SkinBanner>
      );
    }
    return (
      <div
        role={danger ? "alert" : "status"}
        className={`relative mt-1 inline-flex h-9 items-center gap-2.5 rounded-lc-row pr-3.5 pl-1.5 text-lc-chalk inset-ring ${
          danger ? "inset-ring-lc-loss/80 lc-alert" : "inset-ring-lc-caution/70"
        } ${HUD_GLASS}`}
      >
        <FlagBadge flag="doubleYellow" variant="solid" size="sm">
          {tagText}
        </FlagBadge>
        <span className={`lc-data text-[16px] font-bold whitespace-nowrap ${neg ? "text-lc-loss" : "text-lc-gain"}`}>{deltaText}</span>
        <span className={`${HUD_LBL} whitespace-nowrap text-lc-fog`}>{cue}</span>
      </div>
    );
  })();

  if (!latest) {
    if (vscBar) return <div className="flex flex-col items-center gap-1">{vscBar}</div>;
    // The flag stays up while the player is in the zone, after its message has gone; a blue flag while the car is behind
    const flag = doubleYellow ? "doubleYellow" : yellow ? "yellow" : blueFlag ? "blue" : null;
    if (!flag) return null;
    if (skin === "blocks") return null;
    const words =
      flag === "blue"
        ? blueFlagWarn
          ? `Yield now · Let ${blueFlag} through`
          : `Let ${blueFlag} through`
        : flag === "doubleYellow"
          ? "Slow down · no overtaking"
          : "No overtaking";
    const blue = flag === "blue";
    if (skin !== null) {
      return (
        <SkinBanner
          role={blue && blueFlagWarn ? "alert" : "status"}
          tone={blue ? "info" : "caution"}
          cut="sm"
          className={`relative mt-1 inline-flex h-8 items-center gap-2 pr-3 pl-2 ${blue && blueFlagWarn ? "lc-alert" : ""}`}
        >
          <SkinTag tone={blue ? "info" : "caution"} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            <FlagIcon flag={flag} size={14} />
            {blue ? "Blue" : flag === "doubleYellow" ? "Double yellow" : "Yellow"}
          </SkinTag>
          <span className="text-[14px] font-bold whitespace-nowrap uppercase">{words}</span>
        </SkinBanner>
      );
    }
    return (
      <div
        role={blue && blueFlagWarn ? "alert" : "status"}
        className={`relative mt-1 inline-flex h-8 items-center gap-2 rounded-lc-row pr-3 pl-1.5 text-lc-chalk inset-ring ${
          blue ? (blueFlagWarn ? "inset-ring-lc-caution/80 lc-alert" : "inset-ring-lc-info/60") : RING.yellow
        } ${HUD_GLASS}`}
      >
        <FlagBadge flag={flag} variant="solid" size="sm" />
        <span className="lc-disp text-[13px] whitespace-nowrap">{words}</span>
      </div>
    );
  }
  // Bad news and cautions interrupt; the rest is read when convenient. Only bad news pulses (a crimson halo)
  const urgent = latest.kind === "penalty" || latest.kind === "retired" || latest.kind === "yellow" || latest.kind === "warning" || latest.kind === "investigation";
  const bad = latest.kind === "penalty" || latest.kind === "retired";
  if (skin !== null) {
    const call = SKIN_CALL[latest.kind];
    return (
      <div className={`flex flex-col items-center gap-1 ${skinRootClass(skin) ?? ""}`}>
        {vscBar}
        <SkinBanner
          key={latest.id}
          role={urgent ? "alert" : "status"}
          tone={call.tone}
          cut="sm"
          className={`relative mt-1 inline-flex min-h-8 items-center gap-2 py-1 pr-3 pl-2 ${bad ? "lc-alert" : ""}`}
        >
          <SkinTag tone={call.tone} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            <Icon name={call.icon} size="xs" />
            {call.label}
          </SkinTag>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[13px] font-bold whitespace-nowrap sm:text-[14px]">{latest.text}</span>
            {latest.detail ? <span className={`text-[10px] uppercase ${skinCss.inkDim}`}>{latest.detail}</span> : null}
          </span>
        </SkinBanner>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1">
      {vscBar}
      <div
        key={latest.id}
        role={urgent ? "alert" : "status"}
        className={`relative mt-1 inline-flex min-h-9 items-center gap-2 rounded-lc-row py-1 pr-3.5 pl-1.5 text-lc-chalk inset-ring ${RING[latest.kind]} ${
          bad ? "lc-alert" : ""
        } ${HUD_GLASS}`}
      >
        <CallBadge kind={latest.kind} text={latest.text} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[14px] whitespace-nowrap sm:text-[15px]">{latest.text}</span>
          {latest.detail ? <span className={`${HUD_LBL} text-lc-fog`}>{latest.detail}</span> : null}
        </span>
      </div>
    </div>
  );
};
