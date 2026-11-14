import React from "react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";

/**
 * A place in "P1" form, everywhere (tables, HUD, results). The player's own place is volt; the winner's is purple;
 * every other place is neutral. No medals.
 */
export const PositionBadge: React.FC<{
  position: number;
  /** The player's own place */
  player?: boolean;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ position, player = false, size = "md", variant, className = "" }) => (
  <Badge
    tone={player ? "player" : position === 1 ? "best" : "neutral"}
    variant={variant ?? (player ? "solid" : "soft")}
    size={size}
    aria-label={`Position ${position}`}
    className={`lc-mono justify-center tabular-nums ${className}`}
  >
    P{position}
  </Badge>
);
