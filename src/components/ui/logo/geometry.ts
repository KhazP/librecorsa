/**
 * The one source of the LibreCorsa logo: the LC emblem (full and small), the outlined wordmark, the bars and the
 * lock-up proportions. `LibreCorsaLogo.tsx` draws from it at runtime and `scripts/build-brand.ts` writes every file in
 * public/branding and public/favicon.ico from it (`npm run brand`), so no rendition is kept by hand.
 *
 * The hex values below are the mark's own colours and are defined only here. Chalk, volt, void, cyan, crimson and
 * slate are the same values as the `lc-*` tokens in globals.css; the badge, its edge and the two volt gradient stops
 * belong to the emblem alone.
 */

/** The one slant of the logo, in degrees: the emblem's glyphs, the wordmark and the three bars all lean this far */
export const LOGO_SLANT_DEG = 12;

export const LOGO_COLORS = {
  chalk: "#F5F7FA",
  volt: "#CCFF00",
  void: "#08090D",
  cyan: "#00E5FF",
  crimson: "#FF2A3C",
  slate: "#8E96AA",
  badgeTop: "#1A1E2B",
  badgeBottom: "#07080C",
  badgeEdge: "#2C3246",
  voltLight: "#E2FF4D",
  voltDeep: "#A6E000",
} as const;

/** The emblem is drawn in a 128 unit square; the badge fills 6 to 122 and its edge stroke reaches 5 to 123 */
export const EMBLEM_SIZE = 128;
export const EMBLEM_VIEWBOX = "0 0 128 128";
/** The badge and its edge with no margin: favicons and the downloadable emblem */
export const EMBLEM_TIGHT_VIEWBOX = "5 5 118 118";
/** Below this width in CSS px the small emblem takes over (no kerb, no streaks, heavier L and C) */
export const SMALL_EMBLEM_BELOW_PX = 32;

export type GradientId = "badge" | "volt" | "sheen";

export interface LogoGradient {
  id: GradientId;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stops: readonly { offset: number; color: string; opacity?: number }[];
}

/** A colour, or one of the emblem's gradients */
export type Paint = string | { gradient: GradientId };

export interface LogoLayer {
  d: string;
  fill?: Paint;
  stroke?: Paint;
  strokeWidth?: number;
  strokeOpacity?: number;
  dash?: string;
  /** round line caps */
  round?: boolean;
}

/** Badge layers are drawn as they are; glyph layers inside `GLYPH_TRANSFORM` (the slant) */
export interface EmblemDrawing {
  badge: readonly LogoLayer[];
  glyphs: readonly LogoLayer[];
}

export const EMBLEM_GRADIENTS: readonly LogoGradient[] = [
  {
    id: "badge",
    x1: 12,
    y1: 6,
    x2: 116,
    y2: 122,
    stops: [
      { offset: 0, color: LOGO_COLORS.badgeTop },
      { offset: 1, color: LOGO_COLORS.badgeBottom },
    ],
  },
  {
    id: "volt",
    x1: 30,
    y1: 24,
    x2: 96,
    y2: 102,
    stops: [
      { offset: 0, color: LOGO_COLORS.voltLight },
      { offset: 1, color: LOGO_COLORS.voltDeep },
    ],
  },
  {
    id: "sheen",
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 128,
    stops: [
      { offset: 0, color: "#FFFFFF", opacity: 0.16 },
      { offset: 0.5, color: "#FFFFFF", opacity: 0 },
    ],
  },
];

/** The glyphs lean by the logo's slant about the top edge; the shift keeps them centred on the badge */
export const GLYPH_TRANSFORM = `translate(13 0) skewX(-${LOGO_SLANT_DEG})`;

/** Badge: chamfered top-left and bottom-right, like a number board */
export const BADGE_PATH = "M28 6H110Q122 6 122 18V98L98 122H18Q6 122 6 110V28Z";

const L_PATH = "M32 26H48V84H96V100H38Q32 100 32 94Z";
/** The C: centre (77, 57), radius 20, open to the right between 40 degrees above and below */
const C_PATH = "M92.32 44.14A20 20 0 1 0 92.32 69.86";
/** The kerb: the C's apex, the quarter facing the L's corner */
const KERB_PATH = "M73.53 76.7A20 20 0 0 1 57.3 53.53";

const badgeLayers = (edgeWidth: number, accent: LogoLayer): LogoLayer[] => [
  { d: BADGE_PATH, fill: { gradient: "badge" } },
  { d: BADGE_PATH, fill: { gradient: "sheen" } },
  { d: BADGE_PATH, stroke: LOGO_COLORS.badgeEdge, strokeWidth: edgeWidth },
  accent,
];

/**
 * The LC emblem: a forward-leaning volt L with a white C nested in its corner like a car taking an apex. The C's apex
 * is painted as a red and white kerb and a cyan streak leaves the exit.
 */
export const EMBLEM: EmblemDrawing = {
  badge: badgeLayers(2, { d: "M101 117.5L117.5 101", stroke: LOGO_COLORS.volt, strokeWidth: 4, round: true }),
  glyphs: [
    { d: L_PATH, fill: { gradient: "volt" } },
    { d: C_PATH, stroke: LOGO_COLORS.chalk, strokeWidth: 12 },
    { d: KERB_PATH, stroke: LOGO_COLORS.crimson, strokeWidth: 12, dash: "5.2 4.2" },
    { d: "M101 42H112", stroke: LOGO_COLORS.cyan, strokeWidth: 4.5, round: true },
    { d: "M104 51H110", stroke: LOGO_COLORS.cyan, strokeOpacity: 0.45, strokeWidth: 3, round: true },
  ],
};

/*
 * The small emblem, for anything under 32 px (favicons, HUD badges). Laid out on an 8 unit grid, one pixel at 16 px:
 * the L is 20 units thick, the C 14, and 8 units of badge keep them apart, so they stay two shapes in one colour.
 * No kerb and no streaks; the badge edge and the volt corner are heavier so they survive the downsample.
 */
const L_SMALL_PATH = "M30 24H50V82H100V102H38Q30 102 30 94Z";
/** Centre (84, 48), radius 19, stroke 14: the hole is 24 units across, the outside 8 units clear of the L */
const C_SMALL_PATH = "M98.55 35.79A19 19 0 1 0 98.55 60.21";

export const EMBLEM_SMALL: EmblemDrawing = {
  badge: badgeLayers(4, { d: "M99 113.9L113.9 99", stroke: LOGO_COLORS.volt, strokeWidth: 8, round: true }),
  glyphs: [
    { d: L_SMALL_PATH, fill: { gradient: "volt" } },
    { d: C_SMALL_PATH, stroke: LOGO_COLORS.chalk, strokeWidth: 14 },
  ],
};

/**
 * Single-colour emblem: the badge in one colour with the glyphs cut out of it, so it reads on any background and as an
 * alpha-only (monochrome) app icon. The glyph layers are drawn, in order and inside `GLYPH_TRANSFORM`, into the badge's
 * mask: `cut` removes the badge there, `keep` puts it back. A ring of badge is kept round the C so the L and the C
 * never touch, and the kerb stays as stripes across the C's apex.
 */
export interface MonoLayer {
  d: string;
  op: "cut" | "keep";
  /** stroke width; without it the path is filled */
  strokeWidth?: number;
  dash?: string;
  round?: boolean;
}

export interface MonoEmblem {
  shape: string;
  glyphs: readonly MonoLayer[];
}

const MONO_GAP = 4;

export const EMBLEM_MONO: MonoEmblem = {
  shape: BADGE_PATH,
  glyphs: [
    { d: L_PATH, op: "cut" },
    { d: C_PATH, op: "keep", strokeWidth: 12 + 2 * MONO_GAP },
    { d: C_PATH, op: "cut", strokeWidth: 12 },
    { d: KERB_PATH, op: "keep", strokeWidth: 12, dash: "5.2 4.2" },
    { d: "M101 42H112", op: "cut", strokeWidth: 4.5, round: true },
    { d: "M104 51H110", op: "cut", strokeWidth: 3, round: true },
  ],
};

export const EMBLEM_MONO_SMALL: MonoEmblem = {
  shape: BADGE_PATH,
  glyphs: [
    { d: L_SMALL_PATH, op: "cut" },
    { d: C_SMALL_PATH, op: "cut", strokeWidth: 14 },
  ],
};

/** Mask colours: black removes, white keeps */
export const MASK_COLORS = { cut: "#000000", keep: "#FFFFFF" } as const;

/*
 * The wordmark, LIBRE + CORSA, outlined from Orbitron at weight 900 with the app's tracking and the logo's slant.
 * The box is one em tall, the baseline where a `line-height: 1` line box puts it, so it sits where the live text sat.
 * The slanted capitals reach `overhang` past `width` at the right; give the box overflow or padding for that.
 */
// <wordmark:generated> by scripts/brand/outline-text.py from Orbitron 900, do not edit by hand
export const WORDMARK = {
  /** One em, in font units; the box is one em tall with the baseline where `line-height: 1` puts it */
  em: 1000,
  /** Advance of the ten letters with their tracking (0.05 em after each, the last one too) */
  width: 8055,
  baseline: 884,
  capHeight: 720,
  /** How far the slanted capitals reach right of the advance box at cap height */
  overhang: 153,
  libre: "M57 884 210.3 163H365.3L245.2 728H810.2L777 884ZM860 884 1013 164H1166L1013 884ZM1152 884 1305 164H1849Q1889.2 164 1918.4 184Q1947.5 204 1960.9 237.8Q1974.2 271.5 1965.6 312L1936.9 447Q1934.1 460 1930.2 471.5Q1926.2 483 1920.1 493Q1931.1 512 1935.8 537Q1940.4 562 1935.1 587L1903.5 736Q1894.8 776.5 1867.2 810.2Q1839.5 844 1801.5 864Q1763.5 884 1723 884H1152ZM1340.2 728H1748.2Q1748.2 728 1748.2 728Q1748.2 728 1748.2 728L1776.2 596Q1776.2 596 1776.2 596Q1776.2 596 1776.2 596H1368.2Q1368.2 596 1368.2 596Q1368.2 596 1368.2 596L1340.2 728Q1340.2 728 1340.2 728Q1340.2 728 1340.2 728ZM1401.4 440H1781.4Q1781.4 440 1781.4 440Q1781.4 440 1781.4 440L1806.9 320Q1806.9 320 1806.9 320Q1806.9 320 1806.9 320H1426.9Q1426.9 320 1426.9 320Q1426.9 320 1426.9 320L1401.4 440Q1401.4 440 1401.4 440Q1401.4 440 1401.4 440ZM2590 884 2433.9 635H2636.9L2761.3 831L2750 884ZM2031 884 2183.8 165H2754.8Q2795.3 165 2824.8 185Q2854.3 205 2867.6 239Q2880.9 273 2872.4 313L2832.8 499Q2824.3 539 2796.6 573Q2768.9 607 2730.9 627Q2692.9 647 2652.4 647L2236.2 648L2186 884ZM2269.5 491H2677.5Q2677.5 491 2677.5 491Q2677.5 491 2677.5 491L2713.9 320Q2713.9 320 2713.9 320Q2713.9 320 2713.9 320H2305.9Q2305.9 320 2305.9 320Q2305.9 320 2305.9 320L2269.5 491Q2269.5 491 2269.5 491Q2269.5 491 2269.5 491ZM2908 884 3061 164H3726L3692.9 320H3184.9L3158.1 446H3567.1L3533.9 602H3124.9L3098.2 728H3606.2L3573 884Z",
  corsa: "M3870 884Q3829 884 3799.8 864Q3770.5 844 3757.6 810.5Q3744.7 777 3753.5 736L3843.6 312Q3852.3 271 3879.4 237.5Q3906.5 204 3944.3 184Q3982 164 4023 164H4593L4559.9 320H4029.9Q4013.9 320 4003.7 328Q3993.5 336 3989.9 353L3917.2 695Q3913.8 711 3920.5 719.5Q3927.2 728 3943.2 728H4473.2L4440 884ZM4740 884Q4699.5 884 4670 864Q4640.5 844 4627.7 810.2Q4614.8 776.5 4623.5 736L4713.6 312Q4722.2 271.5 4749.4 237.8Q4776.5 204 4814.5 184Q4852.5 164 4893 164H5317Q5357.2 164 5386.4 184Q5415.5 204 5428.9 237.8Q5442.2 271.5 5433.6 312L5343.5 736Q5334.8 776.5 5307.2 810.2Q5279.5 844 5241.8 864Q5204.1 884 5164 884ZM4780.2 728H5188.2Q5188.2 728 5188.2 728Q5188.2 728 5188.2 728L5274.9 320Q5274.9 320 5274.9 320Q5274.9 320 5274.9 320H4866.9Q4866.9 320 4866.9 320Q4866.9 320 4866.9 320L4780.2 728Q4780.2 728 4780.2 728Q4780.2 728 4780.2 728ZM6031 884 5874.9 635H6077.9L6202.3 831L6191 884ZM5472 884 5624.8 165H6195.8Q6236.3 165 6265.8 185Q6295.3 205 6308.6 239Q6321.9 273 6313.4 313L6273.8 499Q6265.3 539 6237.6 573Q6209.9 607 6171.9 627Q6133.9 647 6093.4 647L5677.2 648L5627 884ZM5710.5 491H6118.5Q6118.5 491 6118.5 491Q6118.5 491 6118.5 491L6154.9 320Q6154.9 320 6154.9 320Q6154.9 320 6154.9 320H5746.9Q5746.9 320 5746.9 320Q5746.9 320 5746.9 320L5710.5 491Q5710.5 491 5710.5 491Q5710.5 491 5710.5 491ZM6493 884Q6452.5 884 6423 864Q6393.5 844 6380.7 810.2Q6367.8 776.5 6376.5 736L6390.7 669H6545.7L6533.2 728Q6533.2 728 6533.2 728Q6533.2 728 6533.2 728H6941.2Q6941.2 728 6941.2 728Q6941.2 728 6941.2 728L6967.9 602Q6967.9 602 6967.9 602Q6967.9 602 6967.9 602H6552.9Q6512.4 602 6482.9 582Q6453.4 562 6440.6 528.5Q6427.7 495 6436.4 454L6466.6 312Q6475.2 271.5 6502.4 237.8Q6529.5 204 6567.5 184Q6605.5 164 6646 164H7070Q7110.2 164 7139.4 184Q7168.5 204 7181.9 237.8Q7195.2 271.5 7186.6 312L7172.3 379H7015.3L7027.9 320Q7027.9 320 7027.9 320Q7027.9 320 7027.9 320H6619.9Q6619.9 320 6619.9 320Q6619.9 320 6619.9 320L6593.1 446Q6593.1 446 6593.1 446Q6593.1 446 6593.1 446H7010.1Q7050.2 446 7079.4 466Q7108.6 486 7122 519.5Q7135.3 553 7126.6 594L7096.5 736Q7087.8 776.5 7060.2 810.2Q7032.5 844 6994.8 864Q6957.1 884 6917 884ZM7227 884 7348.6 312Q7357.2 271.5 7384.4 237.8Q7411.5 204 7449.5 184Q7487.5 164 7528 164H7951Q7991.5 164 8021 184Q8050.5 204 8063.9 237.8Q8077.2 271.5 8068.6 312L7947 884H7790L7839.3 652H7431.3L7382 884H7227ZM7464.5 496H7872.5L7909.9 320Q7909.9 320 7909.9 320Q7909.9 320 7909.9 320H7501.9Q7501.9 320 7501.9 320Q7501.9 320 7501.9 320L7464.5 496Z",
} as const;
// </wordmark:generated>

export type LogoTone = "on-dark" | "on-light" | "mono";

/** Wordmark colours per tone (mono draws in the current text colour) */
export const WORDMARK_TONES: Record<LogoTone, { libre: string; corsa: string }> = {
  "on-dark": { libre: LOGO_COLORS.chalk, corsa: LOGO_COLORS.volt },
  "on-light": { libre: LOGO_COLORS.void, corsa: LOGO_COLORS.volt },
  mono: { libre: "currentColor", corsa: "currentColor" },
};

/** The three bars of the full lock-up, in CSS px at the large size: volt, cyan, crimson, slanted like the rest */
export const BARS = {
  width: 16,
  height: 5,
  gap: 3,
  colors: [LOGO_COLORS.volt, LOGO_COLORS.cyan, LOGO_COLORS.crimson],
} as const;

/** The one tagline */
export const LOGO_TAGLINE = "Open-source 500 Hz motorsport sim";

/**
 * Lock-up proportions in CSS px, as the component draws them. `compact` is the small size (the one most screens use),
 * `full` the large size at its widest. The exported files are drawn at these proportions.
 */
export const LOCKUP = {
  compact: { mark: 32, word: 18, gap: 10 },
  full: {
    mark: 64,
    word: 41.6,
    gap: 16,
    /** space between the wordmark and the bars row */
    rowGap: 8,
    /** space between the bars and the tagline */
    barsToTagline: 8,
    tagline: { size: 11, tracking: 0.24, lineHeight: 1.5 },
  },
} as const;

/** Clear space round any lock-up: half the emblem's width. Smallest sizes: emblem 16 px, compact lock-up 96 px wide. */
export const CLEAR_SPACE_RATIO = 0.5;
export const MIN_EMBLEM_PX = 16;
export const MIN_COMPACT_WIDTH_PX = 96;
