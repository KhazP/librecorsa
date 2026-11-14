import React from "react";
import { Badge, type BadgeSize } from "../Badge";

/** Marks the player's own row, car or result: "You", in volt */
export const PlayerTag: React.FC<{ size?: BadgeSize; className?: string }> = ({ size = "md", className = "" }) => (
  <Badge tone="player" variant="solid" size={size} className={className}>
    You
  </Badge>
);
