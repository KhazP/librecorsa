"use client";

/**
 * The MFD's Pit page (after PR #183 by adamikoo): the tyres the crew fits at the next stop, whether they repair the
 * damage, and the call to box this lap; with the stops made against the race's required stops and the lane's limit.
 *
 * On the D-pad (keys , . − =) as the Electronics page is: left / right move the cursor between the three settings, up /
 * down change the one under it (the MFD reads the D-pad and calls `pitDial`, mfd-input.ts). The pointer sets them
 * directly.
 */
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { PitStrategyState, PitTelemetry } from "@/types/f1";
import { PIT_COMPOUNDS, type PitItem } from "@/lib/input/mfd-input";
import { useInputMode } from "@/components/menu/input-mode";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import { KeyCap, PadGlyph } from "@/components/ui/prompts";
import { HUD_LBL } from "./hud-format";
import { HUD_CHOSEN, HUD_CONTROL, HUD_IDLE } from "./styles/hud-style-parts";

/** The row under the cursor: a volt hairline round it and a faint volt wash (the cursor's colour, UI standard §6) */
const ROW = "rounded-lc-nub px-1.5 py-1 transition-shadow duration-200 ease-lc";
const ROW_CURSOR = "bg-lc-volt/6 inset-ring-[1.5px] inset-ring-lc-volt";

export const MfdPitPage: React.FC<{
  pit: PitTelemetry;
  onChange?: (patch: Partial<PitStrategyState>) => void;
  /** The setting under the D-pad's cursor */
  cursor?: PitItem;
  /** The pointer set a row: the cursor follows it */
  onCursor?: (item: PitItem) => void;
}> = ({ pit, onChange, cursor = "tyres", onCursor }) => {
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
      pick: tx("pick"),
      change: tx("change"),
    }),
    [tx]
  );
  const s = pit.strategy;
  const set = (item: PitItem, patch: Partial<PitStrategyState>) => {
    onCursor?.(item);
    onChange?.(patch);
  };
  const row = (item: PitItem) => `${ROW} ${onChange && cursor === item ? ROW_CURSOR : ""}`;
  const toggle = (item: PitItem, on: boolean, label: string, act: () => void) => (
    <button
      type="button"
      disabled={!onChange}
      onClick={() => {
        onCursor?.(item);
        act();
      }}
      aria-pressed={on}
      className={`lc-chip-text h-6.5 min-w-14 rounded-full px-2 text-[10px] ${HUD_CONTROL} ${on ? HUD_CHOSEN : `bg-lc-titanium ${HUD_IDLE}`}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full flex-col gap-1">
      <div className={`flex flex-col gap-1 ${row("tyres")}`}>
        <span className={HUD_LBL}>{L.tyres}</span>
        <div className="flex gap-1" role="radiogroup" aria-label={L.tyres}>
          {PIT_COMPOUNDS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={s.nextCompound === c}
              aria-label={COMPOUNDS[c].name}
              title={COMPOUNDS[c].name}
              disabled={!onChange}
              onClick={() => set("tyres", { nextCompound: c })}
              className={`flex h-7 flex-1 items-center justify-center rounded-full ${HUD_CONTROL} ${
                s.nextCompound === c ? HUD_CHOSEN : `bg-lc-titanium ${HUD_IDLE}`
              }`}
            >
              <CompoundGlyph compound={c} size={16} />
            </button>
          ))}
        </div>
      </div>
      <div className={`flex items-center justify-between gap-2 ${row("repair")}`}>
        <span className="flex flex-col">
          <span className={HUD_LBL}>{L.repair}</span>
          <span className="lc-data text-[10px] text-lc-fog">
            {pit.damage >= 0.03 ? tx("repairTime", { damage: Math.round(pit.damage * 100), seconds: pit.repairS.toFixed(1) }) : tx("noDamage")}
          </span>
        </span>
        {toggle("repair", s.repairDamage, s.repairDamage ? L.on : L.off, () => onChange?.({ repairDamage: !s.repairDamage }))}
      </div>
      <div className={`flex items-center justify-between gap-2 ${row("box")}`}>
        <span className="flex flex-col">
          <span className={HUD_LBL}>{L.box}</span>
          <span className="lc-data text-[10px] text-lc-fog">
            {tx("limit", { limit: pit.limitKmh, box: pit.boxIndex + 1 })}
          </span>
        </span>
        {toggle("box", s.boxRequested, s.boxRequested ? L.boxCalled : L.callBox, () => onChange?.({ boxRequested: !s.boxRequested }))}
      </div>
      {/* The stop count stays whole: where the line is too short for it beside the hint (de, fr, pt-BR), it moves under it */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1.5">
        {onChange ? <DialHint pick={L.pick} change={L.change} /> : <span />}
        <span className="ms-auto flex items-center gap-2 whitespace-nowrap">
          <span className={HUD_LBL}>{tx("stops")}</span>
          <span className={`lc-data text-[12px] ${pit.stopsRequired > pit.stopsMade ? "text-lc-caution" : "text-lc-chalk"}`}>
            {pit.stopsRequired > 0 ? tx("stopsOf", { made: pit.stopsMade, required: pit.stopsRequired }) : pit.stopsMade}
          </span>
        </span>
      </div>
    </div>
  );
};

/** How the D-pad works the page, in the input last used: the pad's D-pad, else the keys */
const DialHint: React.FC<{ pick: string; change: string }> = ({ pick, change }) => {
  const input = useInputMode();
  const pad = input.mode === "pad";
  const item = "inline-flex items-center gap-1";
  const word = `${HUD_LBL} tracking-[0.1em]`;
  return (
    <span className="flex items-center gap-2.5">
      <span className={item}>
        {pad ? (
          <PadGlyph button="dpad-horizontal" family={input.family} />
        ) : (
          <>
            {/* Lifted off the baseline, so they sit in the middle of their caps as the other keys' signs do */}
            <KeyCap>
              <span className="relative -top-[3px]">,</span>
            </KeyCap>
            <KeyCap>
              <span className="relative -top-[3px]">.</span>
            </KeyCap>
          </>
        )}
        <span className={word}>{pick}</span>
      </span>
      <span className={item}>
        {pad ? (
          <PadGlyph button="dpad-vertical" family={input.family} />
        ) : (
          <>
            <KeyCap>-</KeyCap>
            <KeyCap>=</KeyCap>
          </>
        )}
        <span className={word}>{change}</span>
      </span>
    </span>
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
