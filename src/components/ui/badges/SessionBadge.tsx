import React from "react";
import { Badge, type BadgeSize, type BadgeTone, type BadgeVariant } from "../Badge";
import type { IconName } from "../icons/registry";

export type SessionKind = "practice" | "race" | "timeAttack" | "hillClimb" | "online" | "offline" | "host";

const SESSION: Record<SessionKind, { label: string; icon: IconName; tone: BadgeTone }> = {
  practice: { label: "Practice", icon: "drive", tone: "neutral" },
  race: { label: "Race", icon: "race", tone: "neutral" },
  timeAttack: { label: "Time attack", icon: "lapTimes", tone: "neutral" },
  hillClimb: { label: "Hill climb", icon: "trackHillClimb", tone: "neutral" },
  online: { label: "Online", icon: "online", tone: "info" },
  offline: { label: "Offline", icon: "offline", tone: "neutral" },
  host: { label: "Host", icon: "host", tone: "info" },
};

/** What kind of session this is, and how it is connected */
export const SessionBadge: React.FC<{
  session: SessionKind;
  size?: BadgeSize;
  variant?: BadgeVariant;
  /** Replaces the session's own word ("Race · 12 laps") */
  children?: React.ReactNode;
  className?: string;
}> = ({ session, size = "md", variant = "soft", children, className = "" }) => {
  const s = SESSION[session];
  return (
    <Badge tone={s.tone} icon={s.icon} variant={variant} size={size} className={className}>
      {children ?? s.label}
    </Badge>
  );
};
