"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStatus, TrackLimitsStatus } from "@/types/f1";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { FlagIcon } from "@/components/ui/badges/FlagIcon";
import { FlagBadge } from "@/components/ui/badges/FlagBadge";
import { HUD_GLASS, HUD_LBL } from "./hud-format";
import { SkinBanner, skinCss, SkinPanel, SkinTag, type SkinTone, useHudSkin } from "./styles/third-party-skin";

type MessageKind = NonNullable<TrackLimitsStatus["message"]>["kind"];

/**
 * Each decision as the kit's badge (word and icon, in its tone) on a HUD glass pill with a hairline in the same tone.
 * Tone comes from the badge and the hairline, never a full fill; only the bad news pulses (`lc-alert` is a crimson halo).
 */
const TONES: Record<MessageKind, { tone: BadgeTone; ring: string; icon?: IconName }> = {
  warning: { tone: "warn", ring: "inset-ring-lc-caution/60" },
  final_warning: { tone: "warn", ring: "inset-ring-lc-caution/80" },
  penalty: { tone: "bad", ring: "inset-ring-lc-loss/70", icon: "penalty" },
  disqualified: { tone: "bad", ring: "inset-ring-lc-loss/80" },
  lap_invalid: { tone: "bad", ring: "inset-ring-lc-loss/70", icon: "trackLimits" },
  cleared: { tone: "good", ring: "inset-ring-lc-gain/60", icon: "success" },
  no_advantage: { tone: "neutral", ring: "inset-ring-white/7", icon: "info" },
};

const SKIN_TONES: Record<MessageKind, SkinTone> = {
  warning: "caution",
  final_warning: "caution",
  penalty: "loss",
  disqualified: "loss",
  lap_invalid: "loss",
  cleared: "gain",
  no_advantage: "default",
};

/** Strike pips: the warnings of the current cycle towards the next penalty, filled and outlined (never colour alone) */
const Pips: React.FC<{ n: number; of: number; skinned?: boolean }> = ({ n, of, skinned = false }) => {
  const tx = useTranslations("hud.raceControlBanner");
  const label = useMemo(() => tx("warningsMeter", { count: n, total: of }), [tx, n, of]);
  return (
    <span className="inline-flex gap-1" role="img" aria-label={label}>
      {Array.from({ length: of }, (_, i) => (
        <span
          key={i}
          className={
            skinned
              ? `size-2 ${skinCss.pip} ${i < n ? skinCss.fillCaution : skinCss.pipOff}`
              : `size-2 rounded-full ${i < n ? "bg-lc-caution" : "inset-ring-[1.5px] inset-ring-lc-keyline"}`
          }
        />
      ))}
    </span>
  );
};

/**
 * The meter towards the next track-limits step: pips for strikes, the points for the weighted ladder (quarter points
 * don't fit pips)
 */
const Meter: React.FC<{ status: TrackLimitsStatus; skinned?: boolean }> = ({ status, skinned = false }) => {
  const tx = useTranslations("hud.raceControlBanner");
  const ladder = status.ladder;
  const points = status.warnings.toFixed(2);
  const allowed = ladder?.pointsAllowed;
  const pointsLabel = useMemo(() => (allowed === undefined ? "" : tx("pointsMeter", { points, allowed })), [tx, points, allowed]);
  if (status.strikesPerPenalty <= 0) return null;
  if (ladder?.scoring === "weighted_pts") {
    return (
      <span
        className={`lc-data text-[12px] whitespace-nowrap ${skinned ? skinCss.inkCaution : "text-lc-caution"}`}
        aria-label={pointsLabel}
      >
        {status.warnings.toFixed(2)}/{ladder.pointsAllowed.toFixed(1)}
      </span>
    );
  }
  return <Pips skinned={skinned} n={Math.floor(status.warnings)} of={status.strikesPerPenalty} />;
};

/** The ladder's calls that show the meter */
const METERED: readonly MessageKind[] = ["warning", "final_warning", "penalty"];

/**
 * Top-centre race-control banner for the judged track limits: the excursion under review, what is still to give
 * back, then the decision (warning n/3, a time penalty, lap deleted, advantage given back or no further action).
 */
export const RaceControlBanner: React.FC<{
  status: TrackLimitsStatus | undefined;
  offTrack: boolean;
  race: boolean;
  yellow?: boolean;
  /** A place owed back after passing under yellow (AI race) */
  yellowGiveBack?: RaceStatus["giveBack"];
}> = ({ status, offTrack, race, yellow, yellowGiveBack }) => {
  const skin = useHudSkin();
  // The banner re-renders every frame: its words are resolved once per language
  const tx = useTranslations("hud.raceControlBanner");
  const L = useMemo(
    () => ({
      decisions: {
        warning: tx("decisions.warning"),
        final_warning: tx("decisions.finalWarning"),
        penalty: tx("decisions.penalty"),
        disqualified: tx("decisions.disqualified"),
        lap_invalid: tx("decisions.lapInvalid"),
        cleared: tx("decisions.cleared"),
        no_advantage: tx("decisions.noAdvantage"),
      } satisfies Record<MessageKind, string>,
      slowDown: tx("giveBack.slowDown"),
      underYellow: tx("giveBack.underYellow"),
      illegalOvertake: tx("giveBack.illegalOvertake"),
      giveBackTrackLimits: tx("giveBack.trackLimits"),
      trackLimits: tx("offTrack.trackLimits"),
      offTrack: tx("offTrack.offTrack"),
      underReview: tx("offTrack.underReview"),
    }),
    [tx]
  );
  const tlPending = status?.pending ?? null;
  const msg = status?.message ?? null;
  // A yellow-flag pass owed back shows in the same card when track limits owe nothing
  const pending =
    tlPending?.stage === "give_back" || !yellowGiveBack
      ? tlPending
      : { stage: "give_back" as const, gainS: null, giveBackPosition: null, progress: yellowGiveBack.progress, remainingS: yellowGiveBack.remainingS };
  const yellowPass = pending !== tlPending && yellowGiveBack ? yellowGiveBack : null;

  if (pending && pending.stage === "give_back") {
    const gain = pending.gainS;
    const giveBackPos = pending.giveBackPosition ?? null;
    const actionText = yellowPass
      ? tx("giveBack.toCar", { code: yellowPass.code })
      : giveBackPos !== null
        ? tx("giveBack.dropTo", { position: giveBackPos })
        : gain !== null
          ? tx("giveBack.time", { seconds: gain.toFixed(2) })
          : L.slowDown;
    const flag = yellowPass ? (yellowPass.double ? "doubleYellow" : "yellow") : null;
    if (skin !== null) {
      return (
        <SkinPanel
          role="alert"
          cut="sm"
          tone="caution"
          className="mt-1 min-w-60"
          innerClassName="flex flex-col gap-1.5 px-2.5 pt-1.5 pb-2"
        >
          <div className="flex items-center gap-3">
            <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
              {flag ? <FlagIcon flag={flag} size={14} /> : <Icon name={giveBackPos !== null ? "overtake" : "trackLimits"} size="xs" />}
              {flag ? L.underYellow : giveBackPos !== null ? L.illegalOvertake : L.giveBackTrackLimits}
            </SkinTag>
            <span className="flex-1 text-[13px] leading-none font-bold whitespace-nowrap">{actionText}</span>
            <span className={`lc-data text-[12px] ${skinCss.inkCaution}`}>{pending.remainingS.toFixed(1)} s</span>
          </div>
          <span className={`relative h-1 w-full overflow-hidden ${skinCss.bgDeep} ${skinCss.radiusSm}`}>
            <span
              className={`absolute inset-0 origin-left transition-transform duration-100 ease-linear ${skinCss.fillCaution}`}
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, pending.progress))})` }}
            />
          </span>
        </SkinPanel>
      );
    }
    return (
      <div
        role="alert"
        className={`relative mt-1 flex min-w-60 flex-col gap-1.5 overflow-hidden rounded-lc-row px-2.5 pt-1.5 pb-2 text-lc-chalk inset-ring inset-ring-lc-caution/60 ${HUD_GLASS}`}
      >
        {/* The call's badge, what to do, and the time left, on one line (the badge is the call, not a title) */}
        <div className="flex items-center gap-3">
          {flag ? (
            <FlagBadge flag={flag} variant="solid" size="sm">
              {L.underYellow}
            </FlagBadge>
          ) : (
            <Badge tone="warn" variant="solid" size="sm" icon={giveBackPos !== null ? "overtake" : "trackLimits"}>
              {giveBackPos !== null ? L.illegalOvertake : L.giveBackTrackLimits}
            </Badge>
          )}
          <span className="lc-disp flex-1 text-[15px] leading-none whitespace-nowrap">{actionText}</span>
          <span className="lc-data text-[12px] text-lc-caution">{pending.remainingS.toFixed(1)} s</span>
        </div>
        <span className="relative h-1 w-full overflow-hidden rounded-full bg-lc-titanium">
          <span
            className="absolute inset-0 origin-left rounded-full bg-lc-caution transition-transform duration-100 ease-linear"
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, pending.progress))})` }}
          />
        </span>
      </div>
    );
  }

  if (msg) {
    if (skin === "blocks" && !yellow && msg.kind === "lap_invalid" && !msg.detail) return null;
    const tone = TONES[msg.kind];
    const bad = tone.tone === "bad";
    if (skin !== null) {
      const skinTone = SKIN_TONES[msg.kind];
      return (
        <SkinBanner
          role={bad || msg.kind === "warning" ? "alert" : "status"}
          tone={skinTone}
          cut="sm"
          className={`relative mt-1 inline-flex min-h-8 items-center gap-2 py-1 pe-3 ps-2 ${bad ? "lc-alert" : ""}`}
        >
          <SkinTag tone={skinTone} filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            {msg.kind === "final_warning" || msg.kind === "disqualified" ? (
              <FlagIcon flag={msg.kind === "disqualified" ? "black" : "blackWhite"} size={14} />
            ) : (
              <Icon name={msg.kind === "warning" ? "warning" : (tone.icon ?? "info")} size="xs" />
            )}
            {L.decisions[msg.kind]}
          </SkinTag>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[13px] font-bold whitespace-nowrap sm:text-[14px]">{msg.text}</span>
            {msg.detail ? <span className={`text-[10px] uppercase ${skinCss.inkDim}`}>{msg.detail}</span> : null}
          </span>
          {race && status && METERED.includes(msg.kind) ? <Meter skinned status={status} /> : null}
        </SkinBanner>
      );
    }
    return (
      <div
        role={bad || msg.kind === "warning" ? "alert" : "status"}
        className={`relative mt-1 inline-flex min-h-9 items-center gap-2 rounded-lc-row py-1 pe-3.5 ps-1.5 text-lc-chalk inset-ring ${tone.ring} ${
          bad ? "lc-alert" : ""
        } ${HUD_GLASS}`}
      >
        {msg.kind === "warning" ? (
          <PenaltyBadge penalty={{ kind: "warning" }} size="sm" variant="solid" />
        ) : msg.kind === "disqualified" ? (
          <PenaltyBadge penalty={{ kind: "disqualified" }} size="sm" variant="solid" />
        ) : msg.kind === "final_warning" ? (
          <Badge tone="warn" variant="solid" size="sm" leading={<FlagIcon flag="blackWhite" size={16} />}>
            {L.decisions[msg.kind]}
          </Badge>
        ) : (
          <Badge tone={tone.tone} variant="solid" size="sm" icon={tone.icon}>
            {L.decisions[msg.kind]}
          </Badge>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="lc-disp text-[14px] whitespace-nowrap sm:text-[15px]">{msg.text}</span>
          {msg.detail ? <span className={`${HUD_LBL} text-lc-fog`}>{msg.detail}</span> : null}
        </span>
        {race && status && METERED.includes(msg.kind) ? <Meter status={status} /> : null}
      </div>
    );
  }

  if (offTrack || (pending && pending.stage !== "off")) {
    if (skin === "blocks" && !yellow && offTrack && (!pending || pending.stage === "off")) return null;
    if (skin !== null) {
      return (
        <SkinBanner role="status" tone="caution" cut="sm" className="relative mt-1 inline-flex h-8 items-center gap-2 pe-3 ps-2">
          <SkinTag tone="caution" filled className="px-2 py-0.5 text-[11px] font-bold uppercase">
            <Icon name="trackLimits" size="xs" />
            {L.trackLimits}
          </SkinTag>
          <span className={`text-[12px] font-semibold uppercase ${skinCss.inkCaution}`}>{offTrack ? L.offTrack : L.underReview}</span>
          {race && status ? <Meter skinned status={status} /> : null}
        </SkinBanner>
      );
    }
    return (
      <div
        role="status"
        className={`relative mt-1 inline-flex h-8 items-center gap-2 rounded-lc-row pe-3.5 ps-1.5 text-lc-chalk inset-ring inset-ring-lc-caution/60 ${HUD_GLASS}`}
      >
        <span className="inline-flex size-5 items-center justify-center rounded-lc-nub bg-lc-caution text-lc-void">
          <Icon name="trackLimits" size="xs" />
        </span>
        <span className="lc-disp text-[14px] whitespace-nowrap">{L.trackLimits}</span>
        <span className={`${HUD_LBL} text-lc-caution`}>{offTrack ? L.offTrack : L.underReview}</span>
        {race && status ? <Meter status={status} /> : null}
      </div>
    );
  }
  return null;
};
