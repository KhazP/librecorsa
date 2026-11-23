import React from "react";
import { FILLED_ICONS, ICONS, SPINNING_ICONS, type IconName } from "./registry";

export type IconSize = "xs" | "sm" | "md" | "lg";

/** The four icon sizes (UI standard §5); the stroke is 2 px at every size */
export const ICON_PX: Record<IconSize, number> = { xs: 14, sm: 16, md: 20, lg: 24 };

export interface IconProps {
  /** The concept to draw (registry.ts) */
  name: IconName;
  size?: IconSize;
  /** Spoken name. Without it the icon is decorative and hidden from assistive tech; an icon that is a control's only
   *  content needs one (or the control's own `aria-label`). */
  label?: string;
  className?: string;
}

/** Every icon in the game: one concept, one drawing, one weight */
/** Icons that point the way the page reads (on, back): mirrored right to left. Key caps (keyLeft) name a key and stay. */
const READING_ICONS: ReadonlySet<IconName> = new Set<IconName>(["next", "previous", "back"]);

export const Icon: React.FC<IconProps> = ({ name, size = "sm", label, className = "" }) => {
  const Glyph = ICONS[name];
  const spin = SPINNING_ICONS.has(name) ? "motion-safe:animate-spin" : "";
  // :dir() follows the nearest dir attribute, so the left-to-right HUD keeps its arrows as drawn
  const reading = READING_ICONS.has(name) ? "[&:dir(rtl)]:-scale-x-100" : "";
  return (
    <Glyph
      size={ICON_PX[size]}
      strokeWidth={2}
      fill={FILLED_ICONS.has(name) ? "currentColor" : "none"}
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={`shrink-0 ${spin} ${reading} ${className}`}
    />
  );
};
