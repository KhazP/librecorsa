import React from "react";
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

const STATE: Record<ContentState, { label: string; tone: BadgeTone; variant: BadgeVariant; icon?: IconName }> = {
  new: { label: "New", tone: "info", variant: "soft" },
  beta: { label: "Beta", tone: "neutral", variant: "outline" },
  wip: { label: "WIP", tone: "warn", variant: "outline" },
  experimental: { label: "Experimental", tone: "warn", variant: "soft", icon: "warning" },
  downloaded: { label: "Downloaded", tone: "good", variant: "soft", icon: "downloaded" },
  downloading: { label: "Downloading", tone: "neutral", variant: "soft", icon: "downloading" },
  updateAvailable: { label: "Update available", tone: "info", variant: "outline", icon: "download" },
  inUse: { label: "In use", tone: "neutral", variant: "solid", icon: "check" },
};

/** The state of a car, circuit or feature: New, Beta, WIP, Experimental, download state, and the one in use */
export const StateBadge: React.FC<{
  state: ContentState;
  size?: BadgeSize;
  /** Replaces the state's own word ("Downloading 40 %") */
  children?: React.ReactNode;
  className?: string;
}> = ({ state, size = "md", children, className = "" }) => {
  const s = STATE[state];
  return (
    <Badge tone={s.tone} variant={s.variant} icon={s.icon} size={size} className={className}>
      {children ?? s.label}
    </Badge>
  );
};
