"use client";

import React from "react";
import type { AssistPreset } from "@/types/f1";
import type { SimRealism } from "@/lib/sim/sim-realism";
import { Badge, type BadgeToneProp, type BadgeVariant } from "@/components/ui/Badge";

export interface LapConditionBadgesProps {
  assists: AssistPreset;
  realism: SimRealism;
  surface?: "dry" | "wet";
  className?: string;
}

const REALISM_PILL: Record<SimRealism, { label: string; tone: BadgeToneProp; variant: BadgeVariant; title: string }> = {
  full: {
    label: "Full",
    tone: "good",
    variant: "soft",
    title: "Full realism — complete tyre wear, thermal grip and wet-weather model",
  },
  standard: {
    label: "Standard",
    tone: "info",
    variant: "soft",
    title: "Standard realism — tyre wear on, softened tyre temperatures",
  },
  casual: {
    label: "Casual",
    tone: "warn",
    variant: "soft",
    title: "Casual realism — no tyre wear, forgiving tyre temperatures",
  },
};

const ASSIST_PILL: Record<AssistPreset, { label: string; tone: BadgeToneProp; variant: BadgeVariant; title: string }> = {
  pro: {
    label: "Pro",
    tone: { color: "chalk" },
    variant: "soft",
    title: "Pro — no driving assists",
  },
  semi_pro: {
    label: "Semi",
    tone: { color: "amber" },
    variant: "outline",
    title: "Semi-Pro — some driving assists",
  },
  assisted: {
    label: "Assisted",
    tone: "warn",
    variant: "outline",
    title: "Assisted — full driving assists",
  },
};

/**
 * Prominent condition pills for a leaderboard row or challenge header:
 * Realism (Full / Standard / Casual), Assists (Pro / Semi / Assisted), and Wet when driven on a wet line.
 */
export const LapConditionBadges: React.FC<LapConditionBadgesProps> = ({ assists, realism, surface, className = "" }) => {
  const r = REALISM_PILL[realism];
  const a = ASSIST_PILL[assists];
  return (
    <span className={`inline-flex shrink-0 flex-wrap items-center gap-1 ${className}`}>
      <Badge size="sm" tone={r.tone} variant={r.variant} title={r.title} className="px-1.5">
        {r.label}
      </Badge>
      <Badge size="sm" tone={a.tone} variant={a.variant} title={a.title} className="px-1.5">
        {a.label}
      </Badge>
      {surface === "wet" ? (
        <Badge size="sm" tone="info" variant="outline" icon="weatherRain" title="Wet racing line" className="px-1.5">
          Wet
        </Badge>
      ) : null}
    </span>
  );
};
