import React from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize, type BadgeTone, type BadgeVariant } from "../Badge";
import type { IconName } from "../icons/registry";

export type ContentState =
  | "new"
  | "beta"
  | "wip"
  | "experimental"
  | "downloaded"
  | "downloading"
  | "updateAvailable"
  | "inUse";

const STATE: Record<ContentState, { tone: BadgeTone; variant: BadgeVariant; icon?: IconName }> = {
  new: { tone: "info", variant: "soft" },
  beta: { tone: "neutral", variant: "outline" },
  wip: { tone: "warn", variant: "outline" },
  experimental: { tone: "warn", variant: "soft", icon: "warning" },
  downloaded: { tone: "good", variant: "soft", icon: "downloaded" },
  downloading: { tone: "neutral", variant: "soft", icon: "downloading" },
  updateAvailable: { tone: "info", variant: "outline", icon: "download" },
  inUse: { tone: "neutral", variant: "solid", icon: "check" },
};

/** The state of a car, circuit or feature: New, Beta, WIP, Experimental, download state, and the one in use */
export const StateBadge: React.FC<{
  state: ContentState;
  size?: BadgeSize;
  /** Replaces the state's own word ("Downloading 40 %") */
  children?: React.ReactNode;
  className?: string;
}> = ({ state, size = "md", children, className = "" }) => {
  const tx = useTranslations("common.state");
  const s = STATE[state];
  return (
    <Badge tone={s.tone} variant={s.variant} icon={s.icon} size={size} className={className}>
      {children ?? tx(state)}
    </Badge>
  );
};
