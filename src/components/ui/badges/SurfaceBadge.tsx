import React from "react";
import { useTranslations } from "use-intl/react";
import { Badge, type BadgeSize, type BadgeTone, type BadgeVariant } from "../Badge";
import type { IconName } from "../icons/registry";

export type TrackSurface = "dry" | "damp" | "wet" | "flooded";

const SURFACE: Record<TrackSurface, { icon: IconName; tone: BadgeTone; variant: BadgeVariant }> = {
  dry: { icon: "weatherClear", tone: "neutral", variant: "soft" },
  damp: { icon: "weatherDrizzle", tone: "warn", variant: "soft" },
  wet: { icon: "weatherRain", tone: "info", variant: "soft" },
  flooded: { icon: "weatherStorm", tone: "info", variant: "solid" },
};

/** Water on the racing line: Dry, Damp, Wet, Flooded (wet is information cyan, never the PB green) */
export const SurfaceBadge: React.FC<{ surface: TrackSurface; size?: BadgeSize; className?: string }> = ({
  surface,
  size = "md",
  className = "",
}) => {
  const tx = useTranslations("common.surface");
  const s = SURFACE[surface];
  return (
    <Badge tone={s.tone} variant={s.variant} icon={s.icon} size={size} className={className}>
      {tx(surface)}
    </Badge>
  );
};
