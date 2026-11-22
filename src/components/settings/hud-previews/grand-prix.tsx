import React from "react";
import type { HudPreviewDraw } from "../hud-preview";
import { Lines, MiniTrack } from "../hud-preview";
import palette from "../../hud/styles/grand-prix.module.css";

/**
 * Grand Prix: timing tower top-left, curved Halo speed/ERS/gear cluster in the centre,
 * compact driver card bottom-left, and delta/sector card top-right.
 */
export const draw: HudPreviewDraw = () => (
  <g className={palette.palette}>
    {/* Top-left timing tower */}
    <rect x={4} y={4} width={28} height={52} rx={2} fill="var(--gp-panel)" stroke="var(--gp-edge)" strokeWidth={0.5} />
    <rect x={4} y={4} width={28} height={7} rx={2} fill="var(--gp-panel-deep)" />
    <rect x={7} y={6.2} width={6} height={2} rx={0.5} fill="#e10600" />
    <rect x={15} y={6.2} width={13} height={2} rx={0.5} fill="var(--gp-ink)" opacity={0.8} />
    <rect x={6} y={13} width={4} height={2.5} rx={0.5} fill="#e10600" />
    <Lines x={11.5} y={13.5} w={18} n={10} gap={3.8} h={1.1} fill="var(--gp-ink)" opacity={0.65} />

    {/* Curved Halo HUD center cluster */}
    <path
      d="M 46 60 Q 80 34 114 60"
      fill="none"
      stroke="rgba(10, 16, 26, 0.75)"
      strokeWidth={10}
      strokeLinecap="round"
    />
    <path d="M 48 56 Q 80 31 112 56" fill="none" stroke="#22d3ee" strokeOpacity={0.4} strokeWidth={0.6} />
    {/* Left & right curved bars */}
    <rect x={58} y={39} width={4} height={11} rx={1} fill="#38bdf8" opacity={0.8} />
    <rect x={98} y={39} width={4} height={11} rx={1} fill="#10b981" opacity={0.85} />
    {/* Center speed pod */}
    <circle cx={80} cy={43} r={11.5} fill="var(--gp-panel-deep)" stroke="#22d3ee" strokeWidth={0.9} />
    <rect x={73} y={38} width={14} height={4.5} rx={1} fill="var(--gp-ink)" opacity={0.92} />
    <rect x={72} y={44.5} width={16} height={2.4} rx={1.2} fill="#10b981" />
    <rect x={75} y={48.5} width={10} height={2} rx={0.8} fill="var(--gp-dim)" opacity={0.8} />

    {/* Bottom-left driver card */}
    <rect x={4} y={66} width={38} height={18} rx={2} fill="var(--gp-panel)" stroke="var(--gp-edge)" strokeWidth={0.5} />
    <rect x={4} y={71} width={38} height={0.8} fill="#22d3ee" />
    <Lines x={7} y={67.5} w={26} n={1} h={1.5} fill="var(--gp-ink)" opacity={0.85} />
    <Lines x={7} y={74.5} w={30} n={2} gap={3.5} h={1.3} fill="var(--gp-ink)" opacity={0.75} />

    {/* Top-right sector/delta card + bottom-right circuit preview */}
    <rect x={122} y={4} width={34} height={18} rx={2} fill="var(--gp-panel)" stroke="var(--gp-edge)" strokeWidth={0.5} />
    <rect x={124} y={6} width={9} height={2} rx={0.5} fill="var(--color-lc-best)" />
    <rect x={134.5} y={6} width={9} height={2} rx={0.5} fill="var(--color-lc-gain)" />
    <rect x={145} y={6} width={9} height={2} rx={0.5} fill="#38bdf8" />
    <Lines x={125} y={10.5} w={28} n={2} gap={4.5} h={1.4} fill="var(--gp-ink)" opacity={0.85} />
    <MiniTrack x={128} y={64} s={1} stroke="#22d3ee" />
  </g>
);
