"use client";

import React from "react";
import type { TrackLimitsStatus } from "@/types/f1";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { HUD_GLASS, HUD_LBL } from "./hud-format";

type MessageKind = NonNullable<TrackLimitsStatus["message"]>["kind"];

/**
 * Each decision as the kit's badge (word and icon, in its tone) on a HUD glass pill with a hairline in the same tone.
 * Tone comes from the badge and the hairline, never a full fill; only the bad news pulses (`lc-alert` is a crimson halo).
 */
const TONES: Record<MessageKind, { tone: BadgeTone; ring: string; label: string; icon?: IconName }> = {
  warning: { tone: "warn", ring: "inset-ring-lc-caution/60", label: "Warning" },
  penalty: { tone: "bad", ring: "inset-ring-lc-loss/70", label: "Penalty", icon: "penalty" },
  lap_invalid: { tone: "bad", ring: "inset-ring-lc-loss/70", label: "Lap deleted", icon: "trackLimits" },
  cleared: { tone: "good", ring: "inset-ring-lc-gain/60", label: "Cleared", icon: "success" },
  no_advantage: { tone: "neutral", ring: "inset-ring-white/7", label: "No action", icon: "info" },
};

/** Strike pips: the warnings of the current cycle towards the next penalty, filled and outlined (never colour alone) */
const Pips: React.FC<{ n: number; of: number }> = ({ n, of }) => (
  <span className="inline-flex gap-1" role="img" aria-label={`${n} of ${of} warnings`}>
    {Array.from({ length: of }, (_, i) => (
      <span key={i} className={`size-2 rounded-full ${i < n ? "bg-lc-caution" : "inset-ring-[1.5px] inset-ring-lc-keyline"}`} />
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
        className={`relative mt-1.5 flex min-w-75 flex-col gap-2 overflow-hidden rounded-lc-card px-3 pt-2.5 pb-3 text-lc-chalk inset-ring inset-ring-lc-caution/60 ${HUD_GLASS}`}
      >
        {/* The call's badge, what to do, and the time left, on one line (the badge is the call, not a title) */}
        <div className="flex items-center gap-3">
          <Badge tone="warn" variant="solid" size="lg" icon={giveBackPos !== null ? "overtake" : "trackLimits"}>
            {giveBackPos !== null ? "Illegal overtake" : "Track limits"}
          </Badge>
          <span className="lc-disp flex-1 text-[19px] leading-none whitespace-nowrap">
            {giveBackPos !== null
              ? `Hand back position · drop to P${giveBackPos}`
              : gain !== null
                ? `Give back ${gain.toFixed(2)} s`
                : "Lift to give the advantage back"}
          </span>
          <span className="lc-data text-[12px] text-lc-caution">{pending.remainingS.toFixed(1)} s</span>
        </div>
        <span className="relative h-1.5 w-full overflow-hidden rounded-full bg-lc-titanium">
          <span
            className="absolute inset-0 origin-left rounded-full bg-lc-caution transition-transform duration-100"
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, pending.progress))})` }}
          />
        </span>
      </div>
    );
  }

  if (msg) {
    const tone = TONES[msg.kind];
    const bad = tone.tone === "bad";
    return (
      <div
        role={bad || msg.kind === "warning" ? "alert" : "status"}
        className={`relative mt-1.5 inline-flex min-h-12 items-center gap-3 rounded-full py-1.5 pr-5 pl-2 text-lc-chalk inset-ring ${tone.ring} ${
          bad ? "lc-alert" : ""
        } ${HUD_GLASS}`}
      >
        {msg.kind === "warning" ? (
          <PenaltyBadge penalty={{ kind: "warning" }} size="lg" variant="solid" />
        ) : (
          <Badge tone={tone.tone} variant="solid" size="lg" icon={tone.icon}>
            {tone.label}
          </Badge>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[17px] whitespace-nowrap sm:text-[19px]">{msg.text}</span>
          {msg.detail ? <span className={`${HUD_LBL} text-lc-fog`}>{msg.detail}</span> : null}
        </span>
        {race && status && (msg.kind === "warning" || msg.kind === "penalty") ? <Pips n={status.warnings} of={status.strikesPerPenalty} /> : null}
      </div>
    );
  }

  if (offTrack || (pending && pending.stage !== "off")) {
    return (
      <div
        role="status"
        className={`relative mt-1.5 inline-flex h-11 items-center gap-2.5 rounded-full pr-5 pl-2 text-lc-chalk inset-ring inset-ring-lc-caution/60 ${HUD_GLASS}`}
      >
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-lc-caution text-lc-void">
          <Icon name="trackLimits" size="xs" />
        </span>
        <span className="lc-disp text-[16px] whitespace-nowrap sm:text-[18px]">Track limits</span>
        <span className={`${HUD_LBL} text-lc-caution`}>{offTrack ? "Off track" : "Under review"}</span>
        {race && status ? <Pips n={status.warnings} of={status.strikesPerPenalty} /> : null}
      </div>
    );
  }
  return null;
};
