import React from "react";
import { Badge, type BadgeSize, type BadgeTone, type BadgeVariant } from "../Badge";

/**
 * Where a circuit or car comes from, or how its physics are graded ("Original", "Sim grade", "Scan", "Own physics").
 * The registry-aware wrappers (`TrackQualityBadge`, `CarQualityBadge` in menu-content-ui.tsx) pass the label, tone and
 * description in, so this part never imports the registries.
 */
export const QualityBadge: React.FC<{
  label: string;
  tone: Exclude<BadgeTone, "player">;
  /** Shown on hover */
  description?: string;
  size?: BadgeSize;
  variant?: BadgeVariant;
  className?: string;
}> = ({ label, tone, description, size = "md", variant = "soft", className = "" }) => (
  <Badge
    tone={tone}
    variant={variant}
    size={size}
    dot
    title={description}
    className={`max-w-full min-w-0 overflow-hidden ${className}`}
  >
    <span className="truncate py-0.5 leading-none">{label}</span>
    {/* The description in the badge's text for assistive tech (on screen it sits in the detail pane or a legend) */}
    {description ? <span className="sr-only">: {description}</span> : null}
  </Badge>
);
