import React from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize } from "../Badge";

/** Marks the player's own row, car or result: "You", in volt */
export const PlayerTag: React.FC<{ size?: BadgeSize; className?: string }> = ({ size = "md", className = "" }) => {
  const tx = useTranslations("common.badges");
  return (
    <Badge tone="player" variant="solid" size={size} className={className}>
      {tx("you")}
    </Badge>
  );
};
