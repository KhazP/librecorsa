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

/** The new layouts' surface: a hard dark plate, no radius, with one 45° cut at the bottom right when `cut` */
const PLATE_FILL = "var(--color-lc-void)";
const Plate: React.FC<{ x: number; y: number; w: number; h: number; cut?: boolean }> = ({ x, y, w, h, cut = false }) => {
  const c = cut ? Math.min(2.2, h / 3) : 0;
  return <path d={`M${x} ${y}H${x + w}V${y + h - c}L${x + w - c} ${y + h}H${x}Z`} fill={PLATE_FILL} fillOpacity={0.88} />;
};

/** A three-sector strip: best (purple), personal best (green), the running one (chalk, part done) */
const SectorStrip: React.FC<{ x: number; y: number; w: number }> = ({ x, y, w }) => {
  const step = w / 3;
  return (
    <g>
      <rect x={x} y={y} width={step - 0.6} height={1} fill="var(--color-lc-purple)" />
      <rect x={x + step} y={y} width={step - 0.6} height={1} fill="var(--color-lc-green)" />
      <rect x={x + 2 * step} y={y} width={(step - 0.6) * 0.45} height={1} fill={CHALK} />
    </g>
  );
};

/** The game's own layouts: the five hard-plate ones, Telemetry and Minimal (GT-like and F1-like are in GAME_STYLE) */
const BUILT_IN: Record<string, HudPreviewDraw> = {
  blade: () => (
    <g>
      <Plate x={3} y={3} w={34} h={19} cut />
      <rect x={3} y={3} width={34} height={2.6} fill={CHALK} fillOpacity={0.14} />
      <rect x={3} y={10} width={34} height={2.4} fill={VOLT} />
      <Lines x={6} y={7} w={26} n={5} gap={2.4} />
      <Plate x={125} y={3} w={32} h={14} cut />
      <Lines x={128} y={5.5} w={18} n={1} h={2.2} ragged={false} opacity={0.85} />
      <Lines x={128} y={10} w={26} n={2} gap={2.4} />
      <SectorStrip x={125} y={15.6} w={32} />
      <MiniTrack x={6} y={27} s={0.95} />
      <path d="M33 81 L130 81 L127 88 L30 88 Z" fill={PLATE_FILL} fillOpacity={0.9} />
      <RevRow x={50} y={78.6} w={24} n={8} lit={8} h={1} />
      <RevRow x={86} y={78.6} w={24} n={8} lit={3} h={1} />
      <Lines x={36} y={83} w={30} n={2} gap={2.4} h={1.1} />
      <path d="M75 76 L87 76 L85 88 L73 88 Z" fill={VOLT} />
      <rect x={90} y={83} width={10} height={2.2} fill="var(--color-lc-gain)" />
      <Lines x={104} y={83} w={20} n={2} gap={2.4} h={1.1} />
    </g>
  ),
  trackside: () => (
    <g>
      <path d="M3.6 2.6 L12 2.6 L10.8 7.8 L2.4 7.8 Z" fill={VOLT} />
      <Lines x={15} y={3.6} w={20} n={1} h={2.6} ragged={false} opacity={0.9} />
      <path d="M39.4 3.4 L48 3.4 L47 6.8 L38.4 6.8 Z" fill="var(--color-lc-gain)" />
      <Lines x={4} y={10} w={36} n={2} gap={3} h={1} />
      <Plate x={66} y={2.4} w={28} h={2.8} />
      <MiniTrack x={5} y={21} s={0.9} />
      <Plate x={3} y={68} w={40} h={19} />
      <rect x={3} y={71.8} width={40} height={2.6} fill={VOLT} />
      <Lines x={6} y={69} w={30} n={6} gap={3} />
      <rect x={97.5} y={72} width={4} height={5} fill="var(--color-lc-gain)" />
      <rect x={108} y={72} width={4} height={5} fill="var(--color-lc-gain)" />
      <rect x={97.5} y={80} width={4} height={5} fill="var(--color-lc-gain)" />
      <rect x={108} y={80} width={4} height={5} fill="var(--color-lc-crimson)" />
      <Ring cx={144} cy={72} r={12} f={0.8} color={CHALK} w={1.6} />
      <Ring cx={144} cy={72} r={9.6} f={0.45} color="var(--color-lc-cyan)" w={0.8} />
      <path d="M139.5 67 L146 67 L144.2 76 L137.7 76 Z" fill={VOLT} />
      <circle cx={80} cy={80.7} r={5.4} fill={PLATE_FILL} fillOpacity={0.6} />
      <rect x={79} y={78.5} width={1.6} height={3.4} fill="var(--color-lc-azure)" />
    </g>
  ),
  "pit-wall": () => (
    <g>
      <Plate x={3} y={3} w={29} h={29} />
      <rect x={3} y={3} width={6} height={5} fill={VOLT} />
      <rect x={26} y={3} width={6} height={5} fill="var(--color-lc-gain)" />
      <Lines x={5} y={10.5} w={24} n={8} gap={2.6} />
      <Plate x={59} y={2.8} w={42} h={3.6} />
      <rect x={76} y={3.8} width={4} height={1.6} fill="var(--color-lc-gain)" />
      <rect x={74} y={7.8} width={12} height={2.4} fill="var(--color-lc-amber)" />
      <Plate x={3} y={60} w={35} h={27} />
      <Lines x={5} y={62} w={30} n={6} gap={2.6} />
      <rect x={3} y={70} width={35} height={2.2} fill={VOLT} />
      <rect x={4} y={80} width={5} height={6} fill={VOLT} />
      <Plate x={120} y={62} w={37} h={25} />
      <Lines x={122} y={63.5} w={33} n={1} h={1.2} ragged={false} opacity={0.4} />
      {[0, 1].map((r) =>
        [0, 1].map((c) => (
          <g key={`${r}${c}`}>
            <rect x={122 + c * 17.5} y={67 + r * 8.5} width={4.6} height={3.4} fill={r === 1 && c === 1 ? "var(--color-lc-crimson)" : "var(--color-lc-gain)"} />
            <rect x={127 + c * 17.5} y={67 + r * 8.5} width={4.6} height={3.4} fill={r === 1 && c === 1 ? "var(--color-lc-crimson)" : "var(--color-lc-gain)"} />
            <rect x={132 + c * 17.5} y={67 + r * 8.5} width={4.6} height={3.4} fill={r === 1 && c === 1 ? "var(--color-lc-amber)" : "var(--color-lc-gain)"} />
          </g>
        )),
      )}
      <Lines x={122} y={83.5} w={33} n={1} h={1} ragged={false} opacity={0.5} />
    </g>
  ),
  endurance: () => (
    <g>
      <Plate x={3} y={3} w={37} h={24} />
      <Lines x={6} y={5} w={30} n={8} gap={2.7} />
      <rect x={3} y={9.6} width={37} height={2.4} fill={VOLT} />
      <MiniTrack x={7} y={30} s={0.95} />
      <Plate x={130} y={3} w={27} h={22} />
      <Lines x={132.5} y={5} w={22} n={3} gap={2.8} />
      <rect x={130} y={17.6} width={27} height={4.6} fill="var(--color-lc-gain)" />
      <Plate x={3} y={68} w={37} h={19} />
      {[0, 1].map((r) =>
        [0, 1].map((c) => <Ring key={`${r}${c}`} cx={9 + c * 18} cy={74 + r * 8} r={2.8} f={0.85 - (r + c) * 0.04} color={CHALK} w={0.9} />),
      )}
      <Plate x={122} y={58} w={35} h={29} />
      <path d="M128.5 62 L131 62 L132 74 L127.5 74 Z" fill="none" stroke={CHALK} strokeWidth={0.6} />
      <Ring cx={147} cy={66} r={9} f={0.82} color={CHALK} w={1.4} />
      <rect x={144} y={61.5} width={6} height={6} fill={VOLT} />
      <rect x={124} y={78.4} width={20} height={2} fill="var(--color-lc-amber)" />
      <rect x={124} y={82.4} width={14} height={2} fill="var(--color-lc-cyan)" />
    </g>
  ),
  "racing-line": () => (
    <g>
      <path d="M3.6 3 L10 3 L9 8 L2.6 8 Z" fill={VOLT} />
      <Plate x={11} y={3} w={26} h={5} />
      <Plate x={3} y={8.6} w={34} h={14} cut />
      <rect x={3} y={13.8} width={34} height={2.4} fill={VOLT} />
      <Lines x={6} y={10.4} w={26} n={4} gap={2.8} />
      <Plate x={59} y={2.6} w={42} h={1.6} />
      <rect x={76} y={2.6} width={4} height={1.6} fill="var(--color-lc-gain)" />
      <Lines x={74} y={5.8} w={10} n={1} h={2} ragged={false} fill="var(--color-lc-gain)" opacity={0.9} />
      <Plate x={129} y={3} w={28} h={14} cut />
      <Lines x={131} y={5.4} w={18} n={1} h={2.2} ragged={false} opacity={0.85} />
      <SectorStrip x={131} y={10} w={24} />
      <MiniTrack x={134} y={21} s={0.9} sectors={SECTORS} />
      <RevRow x={59} y={72.6} w={42} n={15} lit={11} h={0.9} />
      <path d="M55 75 L106 75 L104 84 L53 84 Z" fill={PLATE_FILL} fillOpacity={0.9} />
      <path d="M74 75 L87 75 L85 84 L72 84 Z" fill={VOLT} />
      <Lines x={58} y={78} w={12} n={1} h={2.4} ragged={false} opacity={0.9} />
      <rect x={90} y={79} width={13} height={1.2} fill="var(--color-lc-cyan)" />
      <Plate x={53} y={84.8} w={53} h={3} />
      <circle cx={44.6} cy={80.8} r={4.6} fill={PLATE_FILL} fillOpacity={0.6} />
      <Plate x={124} y={68} w={33} h={19} cut />
      <Lines x={126} y={70} w={28} n={5} gap={3.2} />
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

/** A ring gauge: a dim track and an arc filled to `f`, opening at the bottom */
const Ring: React.FC<{ cx: number; cy: number; r: number; f: number; color: string; w?: number }> = ({ cx, cy, r, f, color, w = 1.2 }) => {
  const at = (deg: number) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)] as const;
  const [x0, y0] = at(-150);
  const [x1, y1] = at(-150 + 300 * f);
  const [x2, y2] = at(150);
  return (
    <g fill="none" strokeLinecap="round" strokeWidth={w}>
      <path d={`M${x0} ${y0}A${r} ${r} 0 1 1 ${x2} ${y2}`} stroke={CHALK} strokeOpacity={0.15} />
      <path d={`M${x0} ${y0}A${r} ${r} 0 ${300 * f > 180 ? 1 : 0} 1 ${x1} ${y1}`} stroke={color} />
    </g>
  );
};

/** GT-Like and F1-Like: the game's own look, laid out as a road-racing game and a Formula game lay out their race screens */
const GAME_STYLE: Record<string, HudPreviewDraw> = {
  touring: () => (
    <g>
      {/* Framed position square + lap plate */}
      <Glass x={4} y={3} w={23} h={6.5} r={1.8} />
      <rect x={5.2} y={4.2} width={4.2} height={4.2} rx={0.8} fill="var(--color-lc-well)" stroke={CHALK} strokeOpacity={0.55} strokeWidth={0.4} />
      <Lines x={11} y={5.6} w={13} n={1} h={1.2} ragged={false} opacity={0.8} />
      {/* Windowed running order with Volt player row, protruding gap tab and fastest-lap bar */}
      <Glass x={4} y={11} w={21.5} h={23} r={1.8} />
      <Lines x={6.5} y={13.2} w={15} n={5} gap={2.4} h={0.9} />
      <rect x={5} y={26} width={19.5} height={2.8} rx={0.7} fill={VOLT} />
      <rect x={25.5} y={26} width={6.5} height={2.8} rx={0.7} fill="var(--color-lc-loss)" />
      <Lines x={6.5} y={30.8} w={14} n={1} h={0.9} />
      <Glass x={4} y={35.2} w={21.5} h={4.5} r={1.5} />
      <rect x={4} y={37.6} width={21.5} height={2.1} rx={0.8} fill="var(--color-lc-best)" />
      {/* Three-block segmented lap timer */}
      <Glass x={59} y={3} w={8} h={4.6} r={1} />
      <Glass x={68} y={3} w={20} h={4.6} r={1.2} />
      <Lines x={71.5} y={4.7} w={13} n={1} h={1.3} ragged={false} opacity={0.85} />
      <rect x={89} y={3} width={10} height={4.6} rx={1} fill="var(--color-lc-gain)" />
      {/* Circuit outline and chalk-badged lap list */}
      <Glass x={133} y={3} w={23} h={14.5} r={1.8} />
      <MiniTrack x={135} y={3.8} s={0.78} stroke={CHALK} />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x={133} y={19.2 + i * 3.1} width={3.6} height={2.3} rx={0.6} fill={CHALK} />
          <rect
            x={137.4}
            y={19.2 + i * 3.1}
            width={18.6}
            height={2.3}
            rx={0.6}
            fill={i === 0 ? "var(--color-lc-best)" : "var(--color-lc-void)"}
            fillOpacity={i === 0 ? 1 : 0.8}
            stroke={CHALK}
            strokeOpacity={i === 0 ? 0 : 0.12}
            strokeWidth={0.4}
          />
        </g>
      ))}
      {/* Chassis + four vertical tyre tread bars and session clock */}
      <Glass x={4} y={69} w={12} h={12} r={1.8} />
      <rect x={8.6} y={71.4} width={2.8} height={7.2} rx={1} fill="var(--color-lc-titanium)" />
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={5.6 + (i % 2) * 7.2}
          y={71 + Math.floor(i / 2) * 4.6}
          width={1.6}
          height={3.4}
          rx={0.4}
          fill={CHALK}
          stroke="var(--color-lc-ideal)"
          strokeWidth={0.45}
        />
      ))}
      <Glass x={4} y={82.5} w={16} h={4} r={1.2} />
      {/* Sculpted twin-analog + raised digital core with vertical pedal bars */}
      <circle cx={56.5} cy={78.5} r={8.2} {...GLASS} />
      <circle cx={103.5} cy={78.5} r={8.2} {...GLASS} />
      <path d="M56.5 78.5 L61.5 74 M103.5 78.5 L109.2 77" stroke={CHALK} strokeWidth={0.75} strokeLinecap="round" />
      <path d="M107.2 84.5 A7.4 7.4 0 0 0 110.8 79" stroke="var(--color-lc-crimson)" strokeWidth={0.9} fill="none" />
      <Glass x={66} y={69.5} w={28} h={11.5} r={1.8} />
      <RevRow x={68} y={71} w={24} n={14} lit={9} h={0.85} />
      <Lines x={68.5} y={75} w={8.5} n={1} h={2} ragged={false} opacity={0.85} />
      <rect x={79.5} y={73.4} width={5.6} height={5.6} rx={1} fill={VOLT} />
      <rect x={68} y={82} width={1.8} height={4.8} rx={0.6} fill="var(--color-lc-loss)" />
      <rect x={90.2} y={82} width={1.8} height={4.8} rx={0.6} fill="var(--color-lc-gain)" />
      {/* Car identity plate */}
      <Glass x={135} y={80.5} w={21} h={6.2} r={1.8} />
      <Lines x={137.5} y={83} w={15} n={1} h={1.2} ragged={false} opacity={0.8} />
    </g>
  ),
  formula: () => (
    <g>
      {/* Five-row relative tower with top accent rule */}
      <Glass x={4} y={3} w={25} h={22} r={1.8} />
      <rect x={4} y={3} width={25} height={1} rx={0.4} fill={CHALK} fillOpacity={0.75} />
      <Lines x={8.5} y={5.5} w={12} n={1} h={1.3} ragged={false} opacity={0.85} />
      <Lines x={6.5} y={9.8} w={19} n={5} gap={2.9} h={0.9} />
      <rect x={4} y={14.8} width={25} height={2.8} fill={VOLT} />
      {/* Three-sector timing card + full-bleed green delta bar */}
      <Glass x={133} y={3} w={23} h={17.5} r={1.8} />
      <rect x={133} y={4.8} width={7.4} height={1} fill="var(--color-lc-caution)" />
      <rect x={140.8} y={4.8} width={7.4} height={1} fill={CHALK} />
      <rect x={148.6} y={4.8} width={7.4} height={1} fill="var(--color-lc-line)" />
      <Lines x={135.5} y={8} w={18} n={1} h={2} ragged={false} opacity={0.85} />
      <Lines x={135.5} y={12.4} w={18} n={1} h={1.2} ragged={false} opacity={0.55} />
      <rect x={133} y={16.5} width={23} height={4} rx={1} fill="var(--color-lc-gain)" />
      {/* Sector-coloured circuit map */}
      <Glass x={4} y={72.5} w={21.5} h={14.5} r={1.8} />
      <MiniTrack x={6} y={73.2} s={0.76} sectors={SECTORS} />
      {/* Unified sculpted twin-ring + gear-bridge dial */}
      <path
        d="M66.5 74.8 Q68.5 73.6 70.5 73.6 L89.5 73.6 Q91.5 73.6 93.5 74.8 A6.6 6.6 0 1 1 93.5 85.8 Q91.5 87 89.5 87 L70.5 87 Q68.5 87 66.5 85.8 A6.6 6.6 0 1 1 66.5 74.8 Z"
        {...GLASS}
      />
      <Ring cx={62.8} cy={80.3} r={5.1} f={0.64} color="var(--color-lc-info)" w={1.1} />
      <RevRow x={72.5} y={75} w={15} n={9} lit={6} h={0.85} dots />
      <rect x={77} y={77.2} width={6} height={5.8} rx={1.1} fill={VOLT} />
      <rect x={74} y={84.4} width={12} height={1} rx={0.5} fill="var(--color-lc-info)" />
      <Ring cx={97.2} cy={80.3} r={5.1} f={0.84} color="var(--color-lc-amber)" w={1.1} />
      {/* CAD car-status diagram with four radial tyre-life rings */}
      <Glass x={135.5} y={69.5} w={20.5} h={17.5} r={1.8} />
      <path d="M144 72.5 L147.5 72.5 L146.8 83 L144.7 83 Z" fill="var(--color-lc-titanium)" stroke={CHALK} strokeOpacity={0.35} strokeWidth={0.35} />
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} cx={139.5 + (i % 2) * 12.5} cy={74.5 + Math.floor(i / 2) * 7.8} r={2.2} fill="none" stroke={i === 1 ? "var(--color-lc-caution)" : CHALK} strokeWidth={0.65} strokeOpacity={0.85} />
      ))}
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
  const draw = BUILT_IN[preset] ?? GAME_STYLE[preset] ?? COMMUNITY[preset] ?? THIRD_PARTY[preset] ?? BUILT_IN.blade;
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
