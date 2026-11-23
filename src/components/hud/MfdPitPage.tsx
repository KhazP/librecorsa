"use client";

/**
 * The MFD's Pit page (after PR #183 by adamikoo): the tyres the crew fits at the next stop, whether they repair the
 * damage, and the call to box this lap; with the stops made against the race's required stops and the lane's limit.
 */
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { PitStrategyState, PitTelemetry, TireCompound } from "@/types/f1";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { HUD_LBL } from "./hud-format";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE } from "./styles/hud-style-parts";

const ORDER: readonly TireCompound[] = ["soft", "medium", "hard", "intermediate", "wet"];

export const MfdPitPage: React.FC<{
  pit: PitTelemetry;
  onChange?: (patch: Partial<PitStrategyState>) => void;
}> = ({ pit, onChange }) => {
  const tx = useTranslations("hud.multiPageMfd.pit");
  const L = useMemo(
    () => ({
      tyres: tx("tyres"),
      repair: tx("repair"),
      box: tx("box"),
      on: tx("on"),
      off: tx("off"),
      boxCalled: tx("boxCalled"),
      callBox: tx("callBox"),
    }),
    [tx]
  );
  const s = pit.strategy;
  const toggle = (on: boolean, label: string, act: () => void, disabled = false) => (
    <button
      type="button"
      disabled={disabled || !onChange}
      onClick={act}
      aria-pressed={on}
      className={`lc-chip-text h-6.5 min-w-14 rounded-full px-2 text-[10px] ${HUD_CONTROL} ${on ? HUD_CHOSEN : `bg-lc-titanium ${HUD_IDLE}`}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className={HUD_LBL}>{L.tyres}</span>
        <div className="flex gap-1" role="radiogroup" aria-label={L.tyres}>
          {ORDER.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={s.nextCompound === c}
              aria-label={COMPOUNDS[c].name}
              title={COMPOUNDS[c].name}
              disabled={!onChange}
              onClick={() => onChange?.({ nextCompound: c })}
              className={`flex h-7 flex-1 items-center justify-center rounded-full ${HUD_CONTROL} ${
                s.nextCompound === c ? HUD_CHOSEN : `bg-lc-titanium ${HUD_IDLE}`
              }`}
            >
              <CompoundGlyph compound={c} size={16} />
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className={HUD_LBL}>{L.repair}</span>
          <span className="lc-data text-[10px] text-lc-fog">
            {pit.damage >= 0.03 ? tx("repairTime", { damage: Math.round(pit.damage * 100), seconds: pit.repairS.toFixed(1) }) : tx("noDamage")}
          </span>
        </span>
        {toggle(s.repairDamage, s.repairDamage ? L.on : L.off, () => onChange?.({ repairDamage: !s.repairDamage }))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-col">
          <span className={HUD_LBL}>{L.box}</span>
          <span className="lc-data text-[10px] text-lc-fog">
            {tx("limit", { limit: pit.limitKmh, box: pit.boxIndex + 1 })}
          </span>
        </span>
        {toggle(s.boxRequested, s.boxRequested ? L.boxCalled : L.callBox, () => onChange?.({ boxRequested: !s.boxRequested }))}
      </div>
      <div className="mt-auto flex items-center justify-between">
        <span className={HUD_LBL}>{tx("stops")}</span>
        <span className={`lc-data text-[12px] ${pit.stopsRequired > pit.stopsMade ? "text-lc-caution" : "text-lc-chalk"}`}>
          {pit.stopsRequired > 0 ? tx("stopsOf", { made: pit.stopsMade, required: pit.stopsRequired }) : pit.stopsMade}
        </span>
      </div>
    </div>
  );
};

/** The folded MFD's one-line Pit summary: the next tyres and the box call */
export const MfdPitPill: React.FC<{ pit: PitTelemetry; className?: string }> = ({ pit, className = "" }) => {
  const tx = useTranslations("hud.multiPageMfd.pit");
  return (
    <span className={`lc-data flex items-center gap-1.5 text-[10px] ${className}`}>
      <CompoundGlyph compound={pit.strategy.nextCompound} size={12} />
      {pit.strategy.boxRequested ? tx("boxCalled") : tx("stopsShort", { made: pit.stopsMade })}
    </span>
  );
};
