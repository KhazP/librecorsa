"use client";

import React from "react";
import type { HudPreset } from "@/lib/settings/hud-layouts";
import { draw as irdashiesDraw } from "./hud-previews/irdashies";
import { draw as racevisionDraw } from "./hud-previews/racevision";
import { draw as h2hDraw } from "./hud-previews/h2h";
import { draw as retroDraw } from "./hud-previews/retro";
import { draw as blocksDraw } from "./hud-previews/blocks";
import { draw as grandPrixDraw } from "./hud-previews/grand-prix";

/**
 * A HUD layout's picture for the pickers: the driving view in miniature (sky, ground, the road running to the horizon)
 * with the layout's panels drawn where they sit and in their own colours. Plain SVG drawn once, never the live HUD:
 * the pickers show ten of these, also in the pause menu and on phones.
 *
 * The box is 160 × 90 (16:9). A layout's drawing is a `<g>` of shapes in that box.
 */
export type HudPreviewDraw = () => React.ReactElement;

/* The game's own look: the HUD glass, the volt gear, the sector colours */
const GLASS = { fill: "var(--color-lc-void)", fillOpacity: 0.8, stroke: "var(--color-lc-chalk)", strokeOpacity: 0.12, strokeWidth: 0.5 } as const;
const CHALK = "var(--color-lc-chalk)";
const SLATE = "var(--color-lc-slate)";
const VOLT = "var(--color-lc-volt)";

/** A rounded panel of the game's HUD glass */
export const Glass: React.FC<{ x: number; y: number; w: number; h: number; r?: number }> = ({ x, y, w, h, r = 2.5 }) => (
  <rect x={x} y={y} width={w} height={h} rx={r} {...GLASS} />
);

/** Text lines as thin bars (`n` of them, `gap` apart), the way a thumbnail shows writing */
export const Lines: React.FC<{ x: number; y: number; w: number; n: number; gap?: number; fill?: string; opacity?: number; h?: number; ragged?: boolean }> = ({
  x,
  y,
  w,
  n,
  gap = 3,
  fill = CHALK,
  opacity = 0.55,
  h = 1,
  ragged = true,
}) => (
  <g fill={fill} fillOpacity={opacity}>
    {Array.from({ length: n }, (_, i) => (
      <rect key={i} x={x} y={y + i * gap} width={ragged ? w * (0.62 + ((i * 37) % 30) / 80) : w} height={h} rx={h / 2} />
    ))}
  </g>
);

/** A small circuit outline (one fixed shape, drawn in `stroke`) */
export const MiniTrack: React.FC<{ x: number; y: number; s?: number; stroke?: string; width?: number; sectors?: readonly string[] }> = ({
  x,
  y,
  s = 1,
  stroke = CHALK,
  width = 1.2,
  sectors,
}) => {
  const d = "M2 14 L9 3 L12 6 L16 4 L22 8 L19 12 L12 11 L7 16 Z";
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill="none" strokeLinejoin="round" strokeLinecap="round">
      {sectors ? (
        <>
          <path d="M2 14 L9 3 L12 6" stroke={sectors[0]} strokeWidth={width / s} />
          <path d="M12 6 L16 4 L22 8 L19 12" stroke={sectors[1]} strokeWidth={width / s} />
          <path d="M19 12 L12 11 L7 16 L2 14" stroke={sectors[2]} strokeWidth={width / s} />
        </>
      ) : (
        <path d={d} stroke={stroke} strokeWidth={width / s} />
      )}
    </g>
  );
};

/** Rev lights as a row of dots or bars, the first `lit` in green, yellow, red */
export const RevRow: React.FC<{ x: number; y: number; w: number; n: number; lit: number; h?: number; dots?: boolean; off?: string }> = ({
  x,
  y,
  w,
  n,
  lit,
  h = 1.2,
  dots = false,
  off = "var(--color-lc-titanium)",
}) => {
  const step = w / n;
  const color = (i: number) => (i < n / 3 ? "var(--color-lc-green)" : i < (2 * n) / 3 ? "var(--color-lc-amber)" : "var(--color-lc-crimson)");
  return (
    <g>
      {Array.from({ length: n }, (_, i) =>
        dots ? (
          <circle key={i} cx={x + step * (i + 0.5)} cy={y + h / 2} r={Math.min(step * 0.36, h)} fill={i < lit ? color(i) : off} />
        ) : (
          <rect key={i} x={x + step * i + 0.25} y={y} width={step - 0.5} height={h} rx={h / 2} fill={i < lit ? color(i) : off} />
        ),
      )}
    </g>
  );
};

const SECTORS = ["var(--color-lc-cyan)", VOLT, "var(--color-lc-pink)"] as const;

/** The game's own five layouts */
const BUILT_IN: Record<string, HudPreviewDraw> = {
  broadcast: () => (
    <g>
      <Glass x={4} y={4} w={30} h={34} />
      <rect x={4} y={4} width={30} height={6} rx={2.5} fill={CHALK} />
      <Lines x={7} y={14} w={22} n={7} gap={3.2} />
      <Glass x={128} y={4} w={28} h={22} />
      <MiniTrack x={130} y={6} s={1.0} sectors={SECTORS} />
      <Glass x={48} y={72} w={64} h={14} r={3} />
      <RevRow x={52} y={74} w={56} n={14} lit={9} h={0.9} />
      <Lines x={54} y={79} w={14} n={2} gap={3} h={1.4} ragged={false} opacity={0.8} />
      <rect x={72} y={77} width={8} height={7.5} rx={1.5} fill={VOLT} />
      <rect x={96} y={77} width={13} height={7.5} rx={1.5} fill="var(--color-lc-gain)" />
    </g>
  ),
  dash: () => (
    <g>
      <rect x={4} y={4} width={18} height={6} rx={3} {...GLASS} />
      <rect x={5} y={5} width={6} height={4} rx={2} fill={VOLT} />
      <MiniTrack x={130} y={4} s={1.05} stroke={CHALK} />
      <path d="M48 88 L48 70 Q80 60 112 70 L112 88 Z" fill="var(--color-lc-carbon)" stroke="var(--color-lc-keyline)" strokeWidth={0.5} />
      <RevRow x={64} y={66.5} w={32} n={10} lit={7} h={1.2} dots />
      <rect x={52} y={71} width={56} height={14} rx={1.5} fill="var(--color-lc-void)" />
      <rect x={76} y={72.5} width={8} height={11} rx={1} fill="var(--color-lc-well)" />
      <Lines x={55} y={74} w={16} n={3} gap={3.2} h={1.2} />
      <Lines x={89} y={74} w={16} n={3} gap={3.2} h={1.2} />
    </g>
  ),
  telemetry: () => (
    <g>
      <Glass x={4} y={4} w={28} h={18} />
      <rect x={4} y={4} width={28} height={5} rx={2.5} fill={CHALK} />
      <Lines x={7} y={12} w={20} n={3} gap={3} />
      <Glass x={4} y={24} w={28} h={14} />
      <Lines x={7} y={27} w={20} n={4} gap={2.6} />
      <Glass x={128} y={4} w={28} h={20} />
      <MiniTrack x={130} y={6} s={0.95} sectors={SECTORS} />
      <Glass x={128} y={26} w={28} h={14} />
      <circle cx={135} cy={33} r={4.5} fill="none" stroke={CHALK} strokeOpacity={0.3} strokeWidth={0.5} />
      <circle cx={136} cy={32} r={1} fill={VOLT} />
      <Glass x={4} y={62} w={30} h={24} />
      <path d="M7 70 L12 66 L17 69 L22 64 L30 67" stroke="var(--color-lc-green)" strokeWidth={0.7} fill="none" />
      <path d="M7 74 L13 74 L16 71 L20 74 L30 74" stroke="var(--color-lc-crimson)" strokeWidth={0.7} fill="none" />
      <Glass x={128} y={64} w={28} h={22} />
      <Lines x={131} y={68} w={22} n={5} gap={3.2} />
      <path d="M56 88 L56 72 Q80 64 104 72 L104 88 Z" fill="var(--color-lc-carbon)" />
      <rect x={59} y={74} width={42} height={12} rx={1.5} fill="var(--color-lc-void)" />
      <rect x={77} y={75} width={6} height={10} rx={1} fill="var(--color-lc-well)" />
    </g>
  ),
  classic: () => (
    <g>
      <Glass x={4} y={4} w={26} h={22} />
      <Lines x={7} y={8} w={18} n={5} gap={3.4} />
      <Glass x={130} y={4} w={26} h={20} />
      <MiniTrack x={132} y={6} s={0.9} stroke={CHALK} />
      <Glass x={4} y={62} w={24} h={24} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={8 + (i % 2) * 10} y={66 + Math.floor(i / 2) * 10} width={6} height={8} rx={1.2} fill="var(--color-lc-ideal)" fillOpacity={0.8} />
      ))}
      <Glass x={58} y={70} w={44} h={16} r={4} />
      <rect x={74} y={73} width={12} height={10} rx={2} fill={VOLT} />
      <Glass x={128} y={62} w={28} h={24} />
      <Lines x={131} y={66} w={22} n={5} gap={3.6} />
    </g>
  ),
  minimal: () => (
    <g>
      <Glass x={4} y={4} w={26} h={12} />
      <Lines x={7} y={7} w={18} n={2} gap={4} h={1.4} />
      <Glass x={124} y={76} w={32} h={10} r={5} />
      <rect x={127} y={78} width={9} height={6} rx={3} fill={VOLT} />
      <Lines x={139} y={79} w={14} n={1} h={1.6} ragged={false} opacity={0.8} />
    </g>
  ),
};

/** The community layouts' drawings (hud-previews/*.tsx) */
const COMMUNITY: Record<string, HudPreviewDraw> = {
  "grand-prix": grandPrixDraw,
};

/** The third-party layouts' drawings (hud-previews/*.tsx) */
const THIRD_PARTY: Record<string, HudPreviewDraw> = {
  irdashies: irdashiesDraw,
  racevision: racevisionDraw,
  h2h: h2hDraw,
  retro: retroDraw,
  blocks: blocksDraw,
};

/** A layout's picture: the driving view with the layout's panels on it */
export const HudPreview: React.FC<{ preset: HudPreset; className?: string }> = ({ preset, className = "" }) => {
  const draw = BUILT_IN[preset] ?? COMMUNITY[preset] ?? THIRD_PARTY[preset] ?? BUILT_IN.broadcast;
  return (
    <svg viewBox="0 0 160 90" aria-hidden className={`block aspect-video h-auto w-full ${className}`} preserveAspectRatio="xMidYMid slice">
      {/* Sky, ground and the road to the horizon: dim, so the panels read */}
      <rect width={160} height={90} fill="var(--color-lc-carbon)" />
      <rect y={48} width={160} height={42} fill="var(--color-lc-well)" />
      <path d="M72 48 L88 48 L132 90 L28 90 Z" fill="var(--color-lc-titanium)" />
      <path d="M80 50 L80 54 M80 58 L80 64 M80 69 L80 78" stroke={SLATE} strokeOpacity={0.5} strokeWidth={0.8} />
      {draw()}
    </svg>
  );
};
