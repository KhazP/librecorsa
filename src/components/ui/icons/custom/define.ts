import { createLucideIcon, type LucideIcon, type LucideIconNode } from "lucide-react";

/** One element of a symbol: a tag and its SVG attributes, as lucide stores its own icons */
export type SymbolPart = [tag: string, attrs: LucideIconNode[1]];

/**
 * A LibreCorsa symbol drawn on lucide's grid (24 x 24, 2 px stroke, round caps and joins, `currentColor`) and built
 * with lucide's own factory, so it takes the same props, sizes and `aria-hidden` default as a lucide icon.
 */
export function defineSymbol(name: string, parts: readonly SymbolPart[]): LucideIcon {
  return createLucideIcon(
    name,
    parts.map(([tag, attrs], i): LucideIconNode => [tag, { ...attrs, key: `${name}-${i}` }]),
  );
}

/** A dot on the grid: a zero-length line that the round cap turns into a 2 px dot, as lucide draws its dots */
export const dot = (x: number, y: number): SymbolPart => ["path", { d: `M${x} ${y}h.01` }];

/** Filled shape (the few places a symbol fills: kerb blocks, chequers) */
export const FILLED = { fill: "currentColor", stroke: "none" } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Polar point around (cx, cy), angle in degrees clockwise from 3 o'clock (SVG's y runs down) */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r2(cx + r * Math.cos(a)), r2(cy + r * Math.sin(a))];
}

/** Closed band between two radii from angle a0 to a1 (degrees, a1 > a0, under 180 apart) */
export function bandPath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  const [ox0, oy0] = polar(cx, cy, rOut, a0);
  const [ox1, oy1] = polar(cx, cy, rOut, a1);
  const [ix1, iy1] = polar(cx, cy, rIn, a1);
  const [ix0, iy0] = polar(cx, cy, rIn, a0);
  return `M${ox0} ${oy0}A${rOut} ${rOut} 0 0 1 ${ox1} ${oy1}L${ix1} ${iy1}A${rIn} ${rIn} 0 0 0 ${ix0} ${iy0}Z`;
}
