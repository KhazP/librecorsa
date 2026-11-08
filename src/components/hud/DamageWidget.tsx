"use client";

import React from "react";
import type { PlayerDamageStatus } from "@/types/f1";
import { HUD_GREEN, HUD_LBL, HUD_RED, HUD_SLATE, HUD_YELLOW } from "./hud-format";

/** Green → yellow → red with the damage */
function damageColor(d: number): string {
  if (d < 0.05) return "#2A3142";
  if (d < 0.35) return HUD_GREEN;
  if (d < 0.7) return HUD_YELLOW;
  return HUD_RED;
}

const pct = (d: number) => `${Math.round(d * 100)}%`;

/** The part that is worst off, in a word or two */
function worstPart(d: PlayerDamageStatus): string {
  const susp = Math.max(...d.suspension);
  const parts: [string, number][] = [
    ["Front wing", d.front],
    ["Rear wing", d.rear],
    ["Floor", Math.max(d.left, d.right)],
    ["Suspension", susp],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  return parts[0][0];
}

/**
 * The player's car from above: front wing, sidepods, rear wing and each corner coloured by its damage, a puncture
 * marked on its tyre. Shown in an AI race once something is broken.
 */
export const DamageWidget: React.FC<{ damage: PlayerDamageStatus | undefined }> = ({ damage }) => {
  if (!damage) return null;
  // Wheels as drawn: FL, FR, RL, RR from the status order FR, FL, RR, RL
  const wheels = [
    { x: 6, y: 16, i: 1 },
    { x: 42, y: 16, i: 0 },
    { x: 6, y: 66, i: 3 },
    { x: 42, y: 66, i: 2 },
  ];
  const title =
    `Front ${pct(damage.front)} · rear ${pct(damage.rear)} · left ${pct(damage.left)} · right ${pct(damage.right)}` +
    (damage.punctured.some(Boolean) ? " · puncture" : "");
  return (
    <div className="pointer-events-none flex items-center gap-2.5 rounded-2xl border border-[#262B3D] bg-[#08090D]/80 px-3 py-2" title={title}>
      <svg viewBox="0 0 56 100" width="34" height="60" aria-hidden="true">
        {/* front wing */}
        <rect x="8" y="2" width="40" height="7" rx="2" fill={damageColor(damage.front)} />
        {/* nose and tub */}
        <path d="M24 9 h8 l3 22 v34 h-14 v-34 z" fill="#1B1F2B" stroke="#3A4256" strokeWidth="1" />
        {/* sidepods */}
        <rect x="14" y="36" width="7" height="26" rx="3" fill={damageColor(damage.left)} />
        <rect x="35" y="36" width="7" height="26" rx="3" fill={damageColor(damage.right)} />
        {/* rear wing */}
        <rect x="12" y="88" width="32" height="8" rx="2" fill={damageColor(damage.rear)} />
        {wheels.map((w) => (
          <g key={w.i}>
            <rect x={w.x} y={w.y} width="8" height="16" rx="2.5" fill={damageColor(damage.suspension[w.i])} stroke={damage.punctured[w.i] ? HUD_RED : "#3A4256"} strokeWidth={damage.punctured[w.i] ? 2 : 1} />
            {damage.punctured[w.i] ? <circle cx={w.x + 4} cy={w.y + 8} r="2" fill={HUD_RED} /> : null}
          </g>
        ))}
      </svg>
      <div className="flex flex-col gap-0.5">
        <span className={HUD_LBL}>Damage</span>
        <span className="lc-data text-[18px] leading-none tabular-nums" style={{ color: damage.terminal ? HUD_RED : damageColor(Math.max(0.05, damage.overall)) }}>
          {damage.terminal ? "OUT" : pct(damage.overall)}
        </span>
        {damage.punctured.some(Boolean) ? (
          <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.14em] text-[#FF2A3C] uppercase">Puncture</span>
        ) : (
          <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.14em] uppercase" style={{ color: HUD_SLATE }}>
            {worstPart(damage)}
          </span>
        )}
      </div>
    </div>
  );
};
