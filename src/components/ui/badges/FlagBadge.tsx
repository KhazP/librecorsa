import React from "react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { FLAGS, FlagIcon, type FlagKind } from "./FlagIcon";

const FLAG_PX: Record<BadgeSize, number> = { lg: 20, md: 18, sm: 16, hud: 14 };

/** A race-control flag: the drawn flag and its word, always together */
export const FlagBadge: React.FC<{
  flag: FlagKind;
  size?: BadgeSize;
  variant?: BadgeVariant;
  /** Replaces the flag's own word ("Yellow flag, sector 2") */
  children?: React.ReactNode;
  className?: string;
}> = ({ flag, size = "md", variant = "soft", children, className = "" }) => (
  <Badge
    tone={FLAGS[flag].tone}
    variant={variant}
    size={size}
    leading={<FlagIcon flag={flag} size={FLAG_PX[size]} className="-ml-0.5" />}
    className={className}
  >
    {children ?? FLAGS[flag].label}
  </Badge>
);
