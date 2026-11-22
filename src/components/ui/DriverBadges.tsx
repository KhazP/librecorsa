import React from "react";
import { BADGE_TYPES, badgeDetail, badgeLabel, badgeName, sortBadges, type BadgeType, type DriverBadge } from "@/lib/net/awards";
import { Badge, type BadgeToneProp, type BadgeVariant } from "./Badge";
import type { IconName } from "./icons/registry";

interface BadgeStyle {
  icon: IconName;
  tone: BadgeToneProp;
  variant: BadgeVariant;
  /** Short tag for compact board rows so every badge is told apart without relying on colour alone */
  short: string;
}

const STYLE: Record<BadgeType, BadgeStyle> = {
  weekly_gold: { icon: "challenge", tone: { color: "amber" }, variant: "soft", short: "G" },
  weekly_silver: { icon: "medal", tone: { color: "chalk" }, variant: "soft", short: "S" },
  weekly_bronze: { icon: "medal", tone: { color: "amber" }, variant: "outline", short: "B" },
  track_record: { icon: "lapTimes", tone: "best", variant: "soft", short: "FL" },
  og: { icon: "favouriteOn", tone: { color: "cyan" }, variant: "soft", short: "OG" },
  bulb: { icon: "idea", tone: { color: "lemon" }, variant: "soft", short: "" },
};

export interface DriverBadgesProps {
  badges: readonly DriverBadge[];
  /** Compact inline pills for timing rows; omit for full badge names */
  compact?: boolean;
  className?: string;
}

function tooltipOf(b: DriverBadge): string {
  const label = badgeLabel(b);
  if (b.type === "bulb") return label;
  const detail = badgeDetail(b);
  return detail ? `${label} — ${detail}` : label;
}

/** A driver's earned badges (weekly podiums, fastest laps, OG, Bulb) as accessible design-token pills */
export const DriverBadges: React.FC<DriverBadgesProps> = ({ badges, compact = false, className = "" }) => {
  if (badges.length === 0) return null;
  const ordered = sortBadges(badges);
  return (
    <span className={`inline-flex shrink-0 flex-wrap items-center gap-1 ${className}`}>
      {ordered.map((b) => {
        const s = STYLE[b.type];
        const countText = b.count > 1 ? `×${b.count}` : "";
        const text = compact
          ? s.short
            ? `${s.short}${countText}`
            : countText || null
          : `${badgeName(b.type)}${b.count > 1 ? ` ${countText}` : ""}`;
        return (
          <Badge
            key={b.type}
            tone={s.tone}
            variant={s.variant}
            size={compact ? "sm" : "md"}
            icon={s.icon}
            title={tooltipOf(b)}
            aria-label={badgeLabel(b)}
            className={compact ? "px-1.5" : undefined}
          >
            {text}
          </Badge>
        );
      })}
    </span>
  );
};

/** One line per badge for the key under a board */
const MEANING: Record<BadgeType, string> = {
  weekly_gold: "Won a weekly challenge",
  weekly_silver: "2nd in a weekly challenge",
  weekly_bronze: "3rd in a weekly challenge",
  track_record: "Fastest lap: holds a board's best time",
  og: "Original driver: raced on Physics V1",
  bulb: "Idea that went into the game",
};

export interface BadgeLegendProps {
  /** The badges a board shows; each kind gets one line, in the badges' own order */
  badges: readonly DriverBadge[];
  className?: string;
}

/**
 * What the compact pills on a board mean, for the kinds the board shows. The pills' tooltips need a mouse, so on a
 * phone this key is the only place the letters are spelled out.
 */
export const BadgeLegend: React.FC<BadgeLegendProps> = ({ badges, className = "" }) => {
  const present = new Set(badges.map((b) => b.type));
  const types = BADGE_TYPES.filter((t) => present.has(t));
  if (types.length === 0) return null;
  const counted = badges.some((b) => b.count > 1);
  return (
    <ul className={`m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0 ${className}`} aria-label="What the badges mean">
      {types.map((t) => {
        const s = STYLE[t];
        return (
          <li key={t} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex">
              <Badge tone={s.tone} variant={s.variant} size="sm" icon={s.icon} className="px-1.5">
                {s.short || null}
              </Badge>
            </span>
            <span className="lc-hint">{MEANING[t]}</span>
          </li>
        );
      })}
      {counted ? (
        <li className="lc-hint">
          <span className="lc-mono font-bold text-lc-fog">×N</span> N times
        </li>
      ) : null}
    </ul>
  );
};
