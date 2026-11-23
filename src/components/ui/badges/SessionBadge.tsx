import React from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize, type BadgeTone, type BadgeVariant } from "../Badge";
import type { IconName } from "../icons/registry";

export type SessionKind = "practice" | "race" | "timeAttack" | "hillClimb" | "online" | "offline" | "host";

const SESSION: Record<SessionKind, { icon: IconName; tone: BadgeTone }> = {
  practice: { icon: "drive", tone: "neutral" },
  race: { icon: "race", tone: "neutral" },
  timeAttack: { icon: "lapTimes", tone: "neutral" },
  hillClimb: { icon: "trackHillClimb", tone: "neutral" },
  online: { icon: "online", tone: "info" },
  offline: { icon: "offline", tone: "neutral" },
  host: { icon: "host", tone: "info" },
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
  const tx = useTranslations("common.session");
  const s = SESSION[session];
  return (
    <Badge tone={s.tone} icon={s.icon} variant={variant} size={size} className={className}>
      {children ?? tx(session)}
    </Badge>
  );
};
