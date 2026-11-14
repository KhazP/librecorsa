import React from "react";
import {
  EMBLEM,
  EMBLEM_GRADIENTS,
  EMBLEM_MONO,
  EMBLEM_MONO_SMALL,
  EMBLEM_SMALL,
  EMBLEM_VIEWBOX,
  GLYPH_TRANSFORM,
  LOGO_TAGLINE,
  MASK_COLORS,
  WORDMARK,
  type EmblemDrawing,
  type LogoLayer,
  type LogoTone,
  type MonoEmblem,
  type Paint,
} from "./logo/geometry";

export type { LogoTone };

export interface LibreCorsaLogoProps {
  /**
   * - "full": emblem + LIBRECORSA wordmark + bars and tagline
   * - "compact": emblem + wordmark (headers, the HUD)
   * - "mark": the emblem alone (favicon, wheel badge)
   */
  variant?: "full" | "compact" | "mark";
  /** Overall size of the lock-up (the mark alone is sized by className) */
  size?: "sm" | "md" | "lg";
  className?: string;
  subtitle?: string;
  /** "on-dark" (default), "on-light" (LIBRE in void) or "mono" (everything in the current text colour) */
  tone?: LogoTone;
}

export interface LibreCorsaMarkProps {
  className?: string;
  /** Accessible name; an empty string makes the emblem decorative */
  title?: string;
  tone?: LogoTone;
  /**
   * "auto" (default) draws the small emblem (no kerb, no streaks, heavier L and C) when the mark is under 32 px wide
   * and the full one from 32 px up; "full" and "small" force one.
   */
  detail?: "auto" | "full" | "small";
}

const SIZES = {
  sm: { mark: "h-8 w-8", word: "text-lg", gap: "gap-2.5" },
  md: { mark: "h-11 w-11", word: "text-2xl", gap: "gap-3" },
  // lg shrinks on a phone (width) and a landscape phone (height) so the lock-up never runs off the screen
  lg: {
    mark: "h-[clamp(2.75rem,min(13vw,12vh),4rem)] w-[clamp(2.75rem,min(13vw,12vh),4rem)]",
    word: "text-[clamp(1.5rem,min(8.4vw,7vh),2.6rem)]",
    gap: "gap-[clamp(0.75rem,3.5vw,1rem)]",
  },
} as const;

const TONES: Record<LogoTone, { libre: string; corsa: string; word: string; bars: readonly string[]; tagline: string }> = {
  "on-dark": {
    libre: "fill-lc-chalk",
    corsa: "fill-lc-volt",
    // keeps the wordmark legible where the lock-up sits over the scene
    word: "drop-shadow-[0_2px_18px_color-mix(in_srgb,var(--color-lc-void)_60%,transparent)]",
    bars: ["bg-lc-volt", "bg-lc-cyan", "bg-lc-crimson"],
    tagline: "text-lc-slate",
  },
  "on-light": {
    libre: "fill-lc-void",
    corsa: "fill-lc-volt",
    word: "",
    bars: ["bg-lc-volt", "bg-lc-cyan", "bg-lc-crimson"],
    tagline: "text-lc-slate",
  },
  mono: { libre: "fill-current", corsa: "fill-current", word: "", bars: ["bg-current", "bg-current", "bg-current"], tagline: "" },
};

const paint = (p: Paint | undefined, ns: string) =>
  p === undefined ? undefined : typeof p === "string" ? p : `url(#${ns}-${p.gradient})`;

const Layer = ({ l, ns }: { l: LogoLayer; ns: string }) => (
  <path
    d={l.d}
    fill={paint(l.fill, ns)}
    stroke={paint(l.stroke, ns)}
    strokeWidth={l.strokeWidth}
    strokeOpacity={l.strokeOpacity}
    strokeDasharray={l.dash}
    strokeLinecap={l.round ? "round" : undefined}
  />
);

const ColourEmblem = ({ d, ns }: { d: EmblemDrawing; ns: string }) => (
  <>
    <defs>
      {EMBLEM_GRADIENTS.map((g) => (
        <linearGradient key={g.id} id={`${ns}-${g.id}`} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} gradientUnits="userSpaceOnUse">
          {g.stops.map((s) => (
            <stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </linearGradient>
      ))}
    </defs>
    {d.badge.map((l, i) => (
      <Layer key={i} l={l} ns={ns} />
    ))}
    <g transform={GLYPH_TRANSFORM}>
      {d.glyphs.map((l, i) => (
        <Layer key={i} l={l} ns={ns} />
      ))}
    </g>
  </>
);

/** The badge in the current colour with the glyphs cut out of it */
const MonoEmblemDrawing = ({ m, ns }: { m: MonoEmblem; ns: string }) => (
  <>
    <defs>
      <mask id={`${ns}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
        <rect width="128" height="128" fill={MASK_COLORS.keep} />
        <g fill="none" transform={GLYPH_TRANSFORM}>
          {m.glyphs.map((g, i) => (
            <path
              key={i}
              d={g.d}
              fill={g.strokeWidth ? undefined : MASK_COLORS[g.op]}
              stroke={g.strokeWidth ? MASK_COLORS[g.op] : undefined}
              strokeWidth={g.strokeWidth}
              strokeDasharray={g.dash}
              strokeLinecap={g.round ? "round" : undefined}
            />
          ))}
        </g>
      </mask>
    </defs>
    <path d={m.shape} fill="currentColor" mask={`url(#${ns}-mask)`} />
  </>
);

function EmblemSvg({
  small,
  tone,
  ns,
  className,
  a11y,
}: {
  small: boolean;
  tone: LogoTone;
  ns: string;
  className: string;
  a11y?: React.SVGAttributes<SVGSVGElement>;
}) {
  return (
    <svg viewBox={EMBLEM_VIEWBOX} fill="none" xmlns="http://www.w3.org/2000/svg" className={className} {...(a11y ?? { "aria-hidden": true })}>
      {tone === "mono" ? (
        <MonoEmblemDrawing m={small ? EMBLEM_MONO_SMALL : EMBLEM_MONO} ns={ns} />
      ) : (
        <ColourEmblem d={small ? EMBLEM_SMALL : EMBLEM} ns={ns} />
      )}
    </svg>
  );
}

/**
 * The LC emblem: a forward-leaning volt "L" with a white "C" nested in its corner like a car taking an apex. The C's
 * apex is painted as a red / white kerb and a cyan streak leaves the exit. Under 32 px it switches to the small
 * drawing by itself (a container query on its own width), so HUD badges stay sharp.
 */
export const LibreCorsaMark: React.FC<LibreCorsaMarkProps> = ({
  className = "h-10 w-10",
  title = "LibreCorsa",
  tone = "on-dark",
  detail = "auto",
}) => {
  const uid = `lc${React.useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const a11y = title
    ? ({ role: "img", "aria-label": title } as const)
    : ({ "aria-hidden": true } as const);
  if (detail !== "auto") return <EmblemSvg small={detail === "small"} tone={tone} ns={uid} className={className} a11y={a11y} />;
  return (
    <span className={`@container inline-block ${className}`} {...a11y}>
      <EmblemSvg small={false} tone={tone} ns={`${uid}f`} className="block size-full @max-[32px]:hidden" />
      <EmblemSvg small tone={tone} ns={`${uid}s`} className="hidden size-full @max-[32px]:block" />
    </span>
  );
};

/** LIBRECORSA as outlines (Orbitron 900, slanted 12 degrees): one em tall, so the text size class sizes it */
const Wordmark = ({ tone }: { tone: LogoTone }) => {
  const t = TONES[tone];
  return (
    <svg
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.em}`}
      xmlns="http://www.w3.org/2000/svg"
      className={`block h-[1em] shrink-0 overflow-visible ${t.word}`}
      style={{ width: `${WORDMARK.width / WORDMARK.em}em` }}
      role="img"
      aria-label="LibreCorsa"
    >
      <path d={WORDMARK.libre} className={t.libre} />
      <path d={WORDMARK.corsa} className={t.corsa} />
    </svg>
  );
};

export const LibreCorsaLogo: React.FC<LibreCorsaLogoProps> = ({
  variant = "full",
  size,
  className = "",
  subtitle = LOGO_TAGLINE,
  tone = "on-dark",
}) => {
  if (variant === "mark") return <LibreCorsaMark className={className || "h-10 w-10"} tone={tone} />;
  const s = SIZES[size ?? (variant === "compact" ? "sm" : "md")];
  const t = TONES[tone];

  return (
    <div translate="no" className={`inline-flex max-w-full items-center select-none ${s.gap} ${className}`}>
      <LibreCorsaMark className={`${s.mark} shrink-0`} title="" tone={tone} />
      <div className="flex min-w-0 flex-col justify-center">
        <div className={s.word}>
          <Wordmark tone={tone} />
        </div>
        {variant === "full" ? (
          <div className="mt-2 flex items-center gap-2">
            <span className="flex -skew-x-12 items-center gap-[3px]" aria-hidden>
              {t.bars.map((b, i) => (
                <span key={i} className={`h-[5px] w-4 ${b}`} />
              ))}
            </span>
            <span className={`font-lc-mono text-[11px] font-bold tracking-[0.24em] text-balance uppercase ${t.tagline}`}>{subtitle}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};
