"use client";

import React from "react";
import { t, useI18nState } from "@/i18n/runtime";
import type { MessageKey } from "@/i18n/types";
import type { AssistPreset } from "@/types/f1";
import type { SimRealism } from "@/lib/sim/sim-realism";
import { Badge, type BadgeToneProp, type BadgeVariant } from "@/components/ui/Badge";

export interface LapConditionBadgesProps {
  assists: AssistPreset;
  realism: SimRealism;
  surface?: "dry" | "wet";
  className?: string;
}

/** Each pill's word and tooltip, as message keys */
const REALISM_PILL: Record<SimRealism, { label: MessageKey; tone: BadgeToneProp; variant: BadgeVariant; title: MessageKey }> = {
  full: {
    label: "board.conditions.full",
    tone: "good",
    variant: "soft",
    title: "board.conditions.fullTitle",
  },
  standard: {
    label: "board.conditions.standard",
    tone: "info",
    variant: "soft",
    title: "board.conditions.standardTitle",
  },
  casual: {
    label: "board.conditions.casual",
    tone: "warn",
    variant: "soft",
    title: "board.conditions.casualTitle",
  },
};

const ASSIST_PILL: Record<AssistPreset, { label: MessageKey; tone: BadgeToneProp; variant: BadgeVariant; title: MessageKey }> = {
  pro: {
    label: "board.conditions.pro",
    tone: { color: "chalk" },
    variant: "soft",
    title: "board.conditions.proTitle",
  },
  semi_pro: {
    label: "board.conditions.semiPro",
    tone: { color: "amber" },
    variant: "outline",
    title: "board.conditions.semiProTitle",
  },
  assisted: {
    label: "board.conditions.assisted",
    tone: "warn",
    variant: "outline",
    title: "board.conditions.assistedTitle",
  },
};

/**
 * Prominent condition pills for a leaderboard row or challenge header:
 * Realism (Full / Standard / Casual), Assists (Pro / Semi / Assisted), and Wet when driven on a wet line.
 * Its words come from the language runtime rather than the provider, so it also draws on its own (scripts/verify-awards.ts).
 */
export const LapConditionBadges: React.FC<LapConditionBadgesProps> = ({ assists, realism, surface, className = "" }) => {
  useI18nState();
  const r = REALISM_PILL[realism];
  const a = ASSIST_PILL[assists];
  return (
    <span className={`inline-flex shrink-0 flex-wrap items-center gap-1 ${className}`}>
      <Badge size="sm" tone={r.tone} variant={r.variant} title={t(r.title)} className="px-1.5">
        {t(r.label)}
      </Badge>
      <Badge size="sm" tone={a.tone} variant={a.variant} title={t(a.title)} className="px-1.5">
        {t(a.label)}
      </Badge>
      {surface === "wet" ? (
        <Badge size="sm" tone="info" variant="outline" icon="weatherRain" title={t("board.conditions.wetTitle")} className="px-1.5">
          {t("board.conditions.wet")}
        </Badge>
      ) : null}
    </span>
  );
};
