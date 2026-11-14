"use client";

import React from "react";
import type { PlayerDamageStatus } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { HUD_CAUTION, HUD_GLASS, HUD_LBL, HUD_LOSS } from "./hud-format";

/** Untouched line grey → fog for a scratch → caution → loss, with the damage (the % and the worst part are written beside it) */
function damageColor(d: number): string {
  if (d < 0.05) return "var(--color-lc-line)";
  if (d < 0.35) return "var(--color-lc-fog)";
  if (d < 0.7) return HUD_CAUTION;
  return HUD_LOSS;
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
    <div className={`pointer-events-none flex items-center gap-2.5 rounded-lc-tile px-3 py-2 ${HUD_GLASS}`} title={title}>
      <svg viewBox="0 0 56 100" width="34" height="60" aria-hidden="true">
        {/* front wing */}
        <rect x="8" y="2" width="40" height="7" rx="2" fill={damageColor(damage.front)} />
        {/* nose and tub */}
        <path d="M24 9 h8 l3 22 v34 h-14 v-34 z" fill="var(--color-lc-titanium)" stroke="var(--color-lc-keyline)" strokeWidth="1" />
        {/* sidepods */}
        <rect x="14" y="36" width="7" height="26" rx="3" fill={damageColor(damage.left)} />
        <rect x="35" y="36" width="7" height="26" rx="3" fill={damageColor(damage.right)} />
        {/* rear wing */}
        <rect x="12" y="88" width="32" height="8" rx="2" fill={damageColor(damage.rear)} />
        {wheels.map((w) => (
          <g key={w.i}>
            <rect
              x={w.x}
              y={w.y}
              width="8"
              height="16"
              rx="2.5"
              fill={damageColor(damage.suspension[w.i])}
              stroke={damage.punctured[w.i] ? HUD_LOSS : "var(--color-lc-keyline)"}
              strokeWidth={damage.punctured[w.i] ? 2 : 1}
            />
            {damage.punctured[w.i] ? <circle cx={w.x + 4} cy={w.y + 8} r="2" fill={HUD_LOSS} /> : null}
          </g>
        ))}
      </svg>
      <div className="flex flex-col gap-0.5">
        <span className={HUD_LBL}>Damage</span>
        <span className="lc-data text-[18px] leading-none" style={{ color: damage.terminal ? HUD_LOSS : damageColor(Math.max(0.05, damage.overall)) }}>
          {damage.terminal ? "Out" : pct(damage.overall)}
        </span>
        {damage.punctured.some(Boolean) ? (
          <span className={`${HUD_LBL} inline-flex items-center gap-1 text-lc-loss`}>
            <Icon name="puncture" size="xs" className="size-3" />
            Puncture
          </span>
        ) : (
          <span className={HUD_LBL}>{worstPart(damage)}</span>
        )}
      </div>
    </div>
  );
};
