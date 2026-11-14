/**
 * Serialises the logo geometry (src/components/ui/logo/geometry.ts) to standalone SVG markup for the brand files.
 * The React component draws the same layers as JSX; neither holds a path of its own.
 */
import {
  BARS,
  EMBLEM,
  EMBLEM_GRADIENTS,
  EMBLEM_MONO,
  EMBLEM_MONO_SMALL,
  EMBLEM_SMALL,
  GLYPH_TRANSFORM,
  LOCKUP,
  LOGO_COLORS,
  LOGO_SLANT_DEG,
  MASK_COLORS,
  SMALL_EMBLEM_BELOW_PX,
  WORDMARK,
  WORDMARK_TONES,
  type EmblemDrawing,
  type LogoLayer,
  type LogoTone,
  type MonoEmblem,
  type Paint,
} from "../../src/components/ui/logo/geometry";
import { TAGLINE_OUTLINE } from "./tagline-outline";

const n = (v: number) => String(Math.round(v * 1000) / 1000);
const paint = (p: Paint | undefined, ns: string) =>
  p === undefined ? undefined : typeof p === "string" ? p : `url(#${ns}-${p.gradient})`;

function attrs(a: Record<string, string | number | undefined>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
}

function layer(l: LogoLayer, ns: string): string {
  return `<path${attrs({
    d: l.d,
    fill: l.fill === undefined ? undefined : paint(l.fill, ns),
    stroke: paint(l.stroke, ns),
    "stroke-width": l.strokeWidth,
    "stroke-opacity": l.strokeOpacity,
    "stroke-dasharray": l.dash,
    "stroke-linecap": l.round ? "round" : undefined,
  })}/>`;
}

function gradients(ns: string): string {
  return EMBLEM_GRADIENTS.map(
    (g) =>
      `<linearGradient id="${ns}-${g.id}" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" gradientUnits="userSpaceOnUse">${g.stops
        .map((s) => `<stop${attrs({ offset: s.offset, "stop-color": s.color, "stop-opacity": s.opacity })}/>`)
        .join("")}</linearGradient>`,
  ).join("");
}

function colourEmblem(d: EmblemDrawing, ns: string): string {
  return `${d.badge.map((l) => layer(l, ns)).join("")}<g transform="${GLYPH_TRANSFORM}">${d.glyphs.map((l) => layer(l, ns)).join("")}</g>`;
}

function monoEmblem(m: MonoEmblem, ns: string, id: string): string {
  const glyphs = m.glyphs
    .map(
      (g) =>
        `<path${attrs({
          d: g.d,
          fill: g.strokeWidth ? undefined : MASK_COLORS[g.op],
          stroke: g.strokeWidth ? MASK_COLORS[g.op] : undefined,
          "stroke-width": g.strokeWidth,
          "stroke-dasharray": g.dash,
          "stroke-linecap": g.round ? "round" : undefined,
        })}/>`,
    )
    .join("");
  return (
    `<mask id="${ns}-${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">` +
    `<rect width="128" height="128" fill="${MASK_COLORS.keep}"/><g fill="none" transform="${GLYPH_TRANSFORM}">${glyphs}</g></mask>` +
    `<path d="${m.shape}" fill="currentColor" mask="url(#${ns}-${id})"/>`
  );
}

export type EmblemKind = "color" | "mono";
export type EmblemDetail = "full" | "small" | "adaptive";

/**
 * The emblem's inner markup (no <svg> wrapper). "adaptive" holds both drawings: the full one shows by default, so a
 * renderer that ignores CSS draws the full emblem, and a media query (which, in an SVG used as an image or favicon,
 * reads the image's own size) swaps in the small one below 32 px.
 */
export function emblemMarkup(kind: EmblemKind, detail: EmblemDetail, ns = "lc"): string {
  const full = kind === "color" ? colourEmblem(EMBLEM, ns) : monoEmblem(EMBLEM_MONO, ns, "m");
  const small = kind === "color" ? colourEmblem(EMBLEM_SMALL, ns) : monoEmblem(EMBLEM_MONO_SMALL, ns, "ms");
  const defs = kind === "color" ? `<defs>${gradients(ns)}</defs>` : "";
  if (detail === "full") return defs + full;
  if (detail === "small") return defs + small;
  return (
    `<style>@media (max-width: ${SMALL_EMBLEM_BELOW_PX - 0.02}px) { .${ns}-full { display: none } .${ns}-small { display: inline } }</style>` +
    defs +
    `<g class="${ns}-full">${full}</g><g class="${ns}-small" display="none">${small}</g>`
  );
}

export interface SvgOptions {
  viewBox: string;
  width?: number;
  height?: number;
  title?: string;
  /** colour that currentColor resolves to in a standalone file */
  color?: string;
}

export function svgDoc(inner: string, o: SvgOptions): string {
  const [, , vw, vh] = o.viewBox.split(/\s+/).map(Number);
  const w = o.width ?? vw;
  const h = o.height ?? Math.round((w * vh) / vw * 1000) / 1000;
  return `<svg xmlns="http://www.w3.org/2000/svg"${attrs({ viewBox: o.viewBox, width: n(w), height: n(h), fill: "none", color: o.color })}>${
    o.title ? `<title>${o.title}</title>` : ""
  }${inner}</svg>\n`;
}

/**
 * The full lock-up (emblem, wordmark, bars, tagline) laid out exactly as the component lays out its large size,
 * scaled so the emblem is 128 units. Returns the markup and its view box.
 */
export function fullLockup(tone: LogoTone): { inner: string; viewBox: string; width: number; height: number } {
  const L = LOCKUP.full;
  const s = 128 / L.mark;
  const word = L.word * s;
  const gap = L.gap * s;
  const tagSize = L.tagline.size * s;
  const rowH = Math.max(BARS.height * s, tagSize * L.tagline.lineHeight);
  const colH = word + L.rowGap * s + rowH;
  const colTop = (128 - colH) / 2;
  const x0 = 128 + gap;

  const ws = word / WORDMARK.em;
  const fills = WORDMARK_TONES[tone];
  const wordmark =
    `<g transform="translate(${n(x0)} ${n(colTop)}) scale(${n(ws)})">` +
    `<path d="${WORDMARK.libre}" fill="${fills.libre}"/><path d="${WORDMARK.corsa}" fill="${fills.corsa}"/></g>`;

  const rowMid = colTop + word + L.rowGap * s + rowH / 2;
  const bw = BARS.width * s;
  const bh = BARS.height * s;
  const bg = BARS.gap * s;
  const tan = Math.tan((LOGO_SLANT_DEG * Math.PI) / 180);
  const barColors = tone === "mono" ? ["currentColor", "currentColor", "currentColor"] : BARS.colors;
  const bars = barColors
    .map((c, i) => {
      const x = x0 + i * (bw + bg);
      const top = rowMid - bh / 2;
      const bot = rowMid + bh / 2;
      // skewed about the row's middle, leaning forward like the glyphs
      const lean = (y: number) => -tan * (y - rowMid);
      const pts = [
        [x + lean(top), top],
        [x + bw + lean(top), top],
        [x + bw + lean(bot), bot],
        [x + lean(bot), bot],
      ];
      return `<polygon points="${pts.map(([a, b]) => `${n(a)},${n(b)}`).join(" ")}" fill="${c}"/>`;
    })
    .join("");

  const tagX = x0 + 3 * bw + 2 * bg + L.barsToTagline * s;
  // the tagline's one-em box sits in the middle of its line box
  const tagTop = rowMid - tagSize / 2;
  const tagColor = tone === "mono" ? "currentColor" : LOGO_COLORS.slate;
  const ts = tagSize / TAGLINE_OUTLINE.em;
  const tagline = `<path transform="translate(${n(tagX)} ${n(tagTop)}) scale(${n(ts)})" d="${TAGLINE_OUTLINE.d}" fill="${tagColor}"/>`;

  // ink extents: the slanted wordmark's overhang, the tagline without its trailing tracking
  const tagRight = tagX + (TAGLINE_OUTLINE.width - L.tagline.tracking * TAGLINE_OUTLINE.em) * ts;
  const wordRight = x0 + (WORDMARK.width + WORDMARK.overhang) * ws;
  const width = Math.ceil(Math.max(tagRight, wordRight) + 6);
  const emblem = emblemMarkup(tone === "mono" ? "mono" : "color", "full", `lc${tone.replace("-", "")}`);
  return { inner: emblem + wordmark + bars + tagline, viewBox: `0 0 ${width} 128`, width, height: 128 };
}
