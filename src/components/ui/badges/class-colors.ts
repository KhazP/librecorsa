import type { PaletteColor } from "../Badge";

/** Car classes, by the code shown on the tag */
export type CarClassCode = "openWheel" | "gt3" | "proto" | "road";

/**
 * The one table of class colours (a data palette, so not the tones). Volt is the player's, so no class wears it.
 * The registry's class ids map onto these codes at the call site.
 */
export const CLASS_COLORS: Record<CarClassCode, { label: string; color: PaletteColor }> = {
  openWheel: { label: "Open-wheel", color: "pink" },
  gt3: { label: "GT3", color: "cyan" },
  proto: { label: "Proto", color: "purple" },
  road: { label: "Road", color: "amber" },
};
