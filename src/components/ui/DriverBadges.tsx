import React from "react";
import { badgeDetail, badgeLabel, badgeName, sortBadges, type BadgeType, type DriverBadge } from "@/lib/net/awards";
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
  track_record: { icon: "lapTimes", tone: "best", variant: "soft", short: "TR" },
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

/** A driver's earned badges (weekly podiums, track records, OG, Bulb) as accessible design-token pills */
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
