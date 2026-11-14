import React from "react";
import { Icon } from "./icons/Icon";
import type { IconName } from "./icons/registry";

/**
 * The one pill for status, tags and counts (UI standard §6). Replaces `Chip` and every hand-rolled pill.
 * Tones are named; a data palette (car class, tyre compound) passes `{ color }` from its own named table.
 */

/** What the badge means */
export type BadgeTone = "neutral" | "player" | "info" | "good" | "best" | "warn" | "bad";
/** Token colours a data table may use (never volt, which belongs to the player and the cursor) */
export type PaletteColor = "crimson" | "amber" | "lemon" | "green" | "cyan" | "purple" | "pink" | "chalk" | "slate";
export type BadgeToneProp = BadgeTone | { color: PaletteColor };
export type BadgeVariant = "solid" | "soft" | "outline";
export type BadgeSize = "lg" | "md" | "sm" | "hud";

/** The named tones wear the semantic colours, so the colour-blind palette moves them; a data colour stays its hue */
type Swatch = "neutral" | "volt" | "info" | "gain" | "best" | "caution" | "loss" | PaletteColor;

const TONE_SWATCH: Record<BadgeTone, Swatch> = {
  neutral: "neutral",
  player: "volt",
  info: "info",
  good: "gain",
  best: "best",
  warn: "caution",
  bad: "loss",
};

/* Written out in full so Tailwind finds every class. Solid ink: void on every fill (5:1 or more on each, in each
   palette). Soft and outline text on the crimson and purple hues (and on loss and best) takes the lighter `-hi` / `-ink`
   tone, which holds 4.5:1 on its 12 % fill over carbon and titanium. */
const SWATCH: Record<Swatch, Record<BadgeVariant | "dot" | "inkDot", string>> = {
  neutral: {
    solid: "bg-lc-line text-lc-chalk",
    soft: "bg-lc-slate/12 text-lc-fog",
    outline: "border-lc-line text-lc-slate",
    dot: "bg-lc-slate",
    inkDot: "bg-lc-chalk",
  },
  volt: {
    solid: "bg-lc-volt text-lc-void",
    soft: "bg-lc-volt/12 text-lc-volt",
    outline: "border-lc-volt text-lc-volt",
    dot: "bg-lc-volt",
    inkDot: "bg-lc-void",
  },
  info: {
    solid: "bg-lc-info text-lc-void",
    soft: "bg-lc-info/12 text-lc-info",
    outline: "border-lc-info text-lc-info",
    dot: "bg-lc-info",
    inkDot: "bg-lc-void",
  },
  gain: {
    solid: "bg-lc-gain text-lc-void",
    soft: "bg-lc-gain/12 text-lc-gain",
    outline: "border-lc-gain text-lc-gain",
    dot: "bg-lc-gain",
    inkDot: "bg-lc-void",
  },
  best: {
    solid: "bg-lc-best text-lc-void",
    soft: "bg-lc-best/12 text-lc-best-ink",
    outline: "border-lc-best text-lc-best-ink",
    dot: "bg-lc-best",
    inkDot: "bg-lc-void",
  },
  caution: {
    solid: "bg-lc-caution text-lc-void",
    soft: "bg-lc-caution/12 text-lc-caution",
    outline: "border-lc-caution text-lc-caution",
    dot: "bg-lc-caution",
    inkDot: "bg-lc-void",
  },
  loss: {
    solid: "bg-lc-loss text-lc-void",
    soft: "bg-lc-loss/12 text-lc-loss-ink",
    outline: "border-lc-loss text-lc-loss-ink",
    dot: "bg-lc-loss",
    inkDot: "bg-lc-void",
  },
  cyan: {
    solid: "bg-lc-cyan text-lc-void",
    soft: "bg-lc-cyan/12 text-lc-cyan",
    outline: "border-lc-cyan text-lc-cyan",
    dot: "bg-lc-cyan",
    inkDot: "bg-lc-void",
  },
  green: {
    solid: "bg-lc-green text-lc-void",
    soft: "bg-lc-green/12 text-lc-green",
    outline: "border-lc-green text-lc-green",
    dot: "bg-lc-green",
    inkDot: "bg-lc-void",
  },
  purple: {
    solid: "bg-lc-purple text-lc-void",
    soft: "bg-lc-purple/12 text-lc-purple-hi",
    outline: "border-lc-purple text-lc-purple-hi",
    dot: "bg-lc-purple",
    inkDot: "bg-lc-void",
  },
  amber: {
    solid: "bg-lc-amber text-lc-void",
    soft: "bg-lc-amber/12 text-lc-amber",
    outline: "border-lc-amber text-lc-amber",
    dot: "bg-lc-amber",
    inkDot: "bg-lc-void",
  },
  lemon: {
    solid: "bg-lc-lemon text-lc-void",
    soft: "bg-lc-lemon/12 text-lc-lemon",
    outline: "border-lc-lemon text-lc-lemon",
    dot: "bg-lc-lemon",
    inkDot: "bg-lc-void",
  },
  crimson: {
    solid: "bg-lc-crimson text-lc-void",
    soft: "bg-lc-crimson/12 text-lc-crimson-hi",
    outline: "border-lc-crimson text-lc-crimson-hi",
    dot: "bg-lc-crimson",
    inkDot: "bg-lc-void",
  },
  pink: {
    solid: "bg-lc-pink text-lc-void",
    soft: "bg-lc-pink/12 text-lc-pink",
    outline: "border-lc-pink text-lc-pink",
    dot: "bg-lc-pink",
    inkDot: "bg-lc-void",
  },
  chalk: {
    solid: "bg-lc-chalk text-lc-void",
    soft: "bg-lc-chalk/12 text-lc-chalk",
    outline: "border-lc-chalk text-lc-chalk",
    dot: "bg-lc-chalk",
    inkDot: "bg-lc-void",
  },
  slate: {
    solid: "bg-lc-slate text-lc-void",
    soft: "bg-lc-slate/12 text-lc-slate",
    outline: "border-lc-slate text-lc-slate",
    dot: "bg-lc-slate",
    inkDot: "bg-lc-void",
  },
};

const SIZE: Record<BadgeSize, string> = {
  lg: "h-7 gap-1.5 px-3 text-xs",
  md: "h-6 gap-1.5 px-2.5 text-[11px]",
  sm: "h-5 gap-1 px-2 text-[11px] tracking-[0.04em]",
  hud: "h-4 gap-1 px-1.5 text-[9px] tracking-[0.1em]",
};

/** Leading icon box per size: 14 px, 12 px in the 16 px HUD pill */
const ICON_BOX: Record<BadgeSize, string> = { lg: "", md: "", sm: "", hud: "size-3" };

const swatchOf = (tone: BadgeToneProp): Swatch => (typeof tone === "string" ? TONE_SWATCH[tone] : tone.color);

/** The classes of a tone in a variant, for parts that wear a badge's colours without being one */
export function badgeToneClass(tone: BadgeToneProp, variant: BadgeVariant): string {
  return SWATCH[swatchOf(tone)][variant];
}

export interface BadgeProps {
  children?: React.ReactNode;
  tone?: BadgeToneProp;
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** Leading icon by concept (14 px) */
  icon?: IconName;
  /** Any other leading glyph (a flag, a compound ring); sized by the caller */
  leading?: React.ReactNode;
  /** Leading status dot; "live" pulses slowly */
  dot?: boolean | "live";
  title?: string;
  className?: string;
  "aria-label"?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  tone = "neutral",
  variant = "soft",
  size = "md",
  icon,
  leading,
  dot,
  title,
  className = "",
  "aria-label": ariaLabel,
}) => {
  const sw = SWATCH[swatchOf(tone)];
  return (
    <span
      title={title}
      {...(ariaLabel ? { role: "img", "aria-label": ariaLabel } : {})}
      className={`lc-chip-text inline-flex shrink-0 items-center rounded-full border leading-none whitespace-nowrap ${
        variant === "outline" ? "" : "border-transparent"
      } ${sw[variant]} ${SIZE[size]} ${className}`}
    >
      {dot ? (
        <StatusDotMark className={variant === "solid" ? sw.inkDot : sw.dot} live={dot === "live"} />
      ) : null}
      {icon ? <Icon name={icon} size="xs" className={`shrink-0 ${ICON_BOX[size]}`} /> : null}
      {leading}
      {children}
    </span>
  );
};

const StatusDotMark: React.FC<{ className: string; live?: boolean }> = ({ className, live }) => (
  <span aria-hidden className="relative inline-flex size-1.5 shrink-0">
    {live ? <span className={`lc-ping absolute inset-0 rounded-full motion-reduce:hidden ${className}`} /> : null}
    <span className={`relative size-1.5 rounded-full ${className}`} />
  </span>
);

/** The one status dot: 6 px, tone by name, an optional slow pulse while something is live */
export const StatusDot: React.FC<{
  tone?: BadgeToneProp;
  live?: boolean;
  /** Spoken name of the state, when nothing beside the dot says it */
  label?: string;
  className?: string;
}> = ({ tone = "neutral", live, label, className = "" }) => {
  const mark = <StatusDotMark className={SWATCH[swatchOf(tone)].dot} live={live} />;
  return label ? (
    <span role="img" aria-label={label} className={`inline-flex ${className}`}>
      {mark}
    </span>
  ) : (
    <span className={`inline-flex ${className}`}>{mark}</span>
  );
};
