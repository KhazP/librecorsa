import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
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
}> = ({ position, player = false, size = "md", variant, className = "" }) => {
  const tx = useTranslations("common.badges");
  // The HUD redraws it many times a second: the words are resolved when the place or the language changes
  const spoken = useMemo(() => tx("position", { position: String(position) }), [tx, position]);
  return (
    <Badge
      tone={player ? "player" : position === 1 ? "best" : "neutral"}
      variant={variant ?? (player ? "solid" : "soft")}
      size={size}
      aria-label={spoken}
      className={`lc-mono justify-center tabular-nums ${className}`}
    >
      P{position}
    </Badge>
  );
};
