import React from "react";
import { Badge, type BadgeSize, type BadgeVariant } from "../Badge";
import { COMPOUND_LETTER, COMPOUNDS, type Compound } from "./compounds";

/**
 * The tyre-compound glyph: a dark tyre with the compound's coloured stripe and its letter. The single drawing of a
 * compound in the tower, the tyre widget, the MFD and the menus. Readable from 16 px.
 */
export const CompoundGlyph: React.FC<{
  compound: Compound;
  /** Pixels */
  size?: number;
  /** Speak the compound ("Soft tyres"). Off where the word is written beside it. */
  decorative?: boolean;
  className?: string;
}> = ({ compound, size = 16, decorative = false, className = "" }) => {
  const c = COMPOUNDS[compound];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": `${c.name} tyres` })}
      className={`shrink-0 ${className}`}
    >
      <circle cx={12} cy={12} r={11.5} className="fill-lc-void" />
      <circle cx={12} cy={12} r={9} className={c.ring} strokeWidth={2.75} />
      <path d={COMPOUND_LETTER[compound]} className="stroke-lc-chalk" strokeWidth={2.25} />
    </svg>
  );
};

const GLYPH_PX: Record<BadgeSize, number> = { lg: 20, md: 18, sm: 16, hud: 14 };

/** A compound with its name: the glyph (letter always shown) and the word, in the compound's colour */
export const CompoundBadge: React.FC<{
  compound: Compound;
  size?: BadgeSize;
  variant?: BadgeVariant;
  /** Hide the word and keep the glyph and its spoken name (tight HUD rows) */
  short?: boolean;
  className?: string;
}> = ({ compound, size = "md", variant = "soft", short = false, className = "" }) => {
  const c = COMPOUNDS[compound];
  if (short) return <CompoundGlyph compound={compound} size={GLYPH_PX[size]} className={className} />;
  return (
    <Badge
      tone={{ color: c.color }}
      variant={variant}
      size={size}
      leading={<CompoundGlyph compound={compound} size={GLYPH_PX[size]} decorative className="-ml-1.5" />}
      className={className}
    >
      {c.name}
    </Badge>
  );
};
