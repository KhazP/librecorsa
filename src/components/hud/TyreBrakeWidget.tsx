"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { brakeGlowColor, HUD_CYAN, HUD_GREEN, HUD_LBL, HUD_RED, HUD_WHITE, HUD_YELLOW, tyreHeatColor } from "./hud-format";

export const CORNERS = ["FL", "FR", "RL", "RR"] as const;

const COMPOUND: Record<TireCompound, { letter: string; color: string }> = {
  soft: { letter: "S", color: HUD_RED },
  medium: { letter: "M", color: HUD_YELLOW },
  hard: { letter: "H", color: HUD_WHITE },
};

/** Damage / surface conditions shown as badges once they matter */
const CONDITIONS = [
  { key: "tireGrainLevel", label: "GRAIN", color: HUD_YELLOW, title: "Graining: the tread surface is tearing (too cold underneath while sliding)" },
  { key: "tireBlisterLevel", label: "BLIST", color: HUD_RED, title: "Blistering: the core overheated" },
  { key: "tireFlatSpotSeverity", label: "FLAT", color: "#FF6B8A", title: "Flat spot from a lock-up: vibration and less grip" },
  { key: "tireDirtyLevel", label: "DIRT", color: "#C08A4A", title: "Dirt / marbles picked up off line: cleans up over a few corners" },
] as const;

/** Level from which a condition shows its badge */
const CONDITION_SHOW = 0.12;

export interface CornerData {
  /** Bands left → right as seen from behind, the overall tread temperature, carcass/core */
  bands: [number, number, number];
  temp: number;
  /** Inner band index in `bands` (0 on the right-hand tyres, 2 on the left ones) */
  innerIdx: 0 | 2;
  psi: number | null;
  psiDelta: number | null;
  life: number;
  brake: number;
  brakeCore: number | null;
  padMu: number | null;
  conditions: { label: string; color: string; level: number; title: string }[];
}

/** Everything one corner shows, from the telemetry */
export function cornerData(t: CarTelemetry, i: number): CornerData {
  const temp = t.tireTempsC[i] || 0;
  const bands = t.tireBandTempsC?.[i] ?? [temp, temp, temp];
  const psi = t.tirePressuresPsi?.[i] ?? null;
  const opt = t.tireOptimalPsi?.[i] ?? null;
  const conditions = CONDITIONS.flatMap((c) => {
    const level = t[c.key]?.[i] ?? 0;
    return level >= CONDITION_SHOW ? [{ label: c.label, color: c.color, level, title: c.title }] : [];
  });
  return {
    bands: [bands[0], bands[1], bands[2]],
    temp,
    innerIdx: i % 2 === 0 ? 2 : 0,
    psi,
    psiDelta: psi !== null && opt !== null ? psi - opt : null,
    life: Math.max(0, 100 - (t.tireWearPct?.[i] ?? 0)),
    brake: t.brakeTempsC[i] ?? 0,
    brakeCore: t.brakeCoreTempsC?.[i] ?? null,
    padMu: t.brakePadMuFactor?.[i] ?? null,
    conditions,
  };
}

/** Pressure delta colour: green within ±0.5 psi of the optimum, amber to ±1.5, red past it */
export const psiDeltaColor = (d: number | null) =>
  d === null ? "#8E96AA" : Math.abs(d) <= 0.5 ? HUD_GREEN : Math.abs(d) <= 1.5 ? HUD_YELLOW : HUD_RED;

const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`;

/**
 * The tyre seen from above: three tread bands (outer / middle / inner), each filled up to the remaining tread
 * in its own temperature colour, inside a carcass ring in the overall temperature. A flat spot shows as a notch.
 */
export const TyreGlyph: React.FC<{
  c: CornerData;
  window?: readonly [number, number];
  className?: string;
}> = ({ c, window, className = "h-[52px] w-[34px]" }) => {
  const flat = c.conditions.find((k) => k.label === "FLAT");
  return (
    <span
      className={`relative flex flex-none gap-[2px] rounded-[10px] border-[2.5px] p-[3px] ${className}`}
      style={{ borderColor: tyreHeatColor(c.temp, window), boxShadow: `0 0 10px ${tyreHeatColor(c.temp, window)}40` }}
    >
      {c.bands.map((b, k) => (
        <span key={k} className="relative flex-1 overflow-hidden rounded-[3px] bg-[#11131A]">
          <span
            className="absolute inset-x-0 bottom-0 transition-[height,background-color] duration-300"
            style={{ height: `${Math.max(6, c.life)}%`, backgroundColor: tyreHeatColor(b, window) }}
          />
        </span>
      ))}
      {flat ? (
        <span
          aria-hidden
          className="absolute inset-x-[-3px] top-[38%] h-[3px] rounded-full"
          style={{ backgroundColor: flat.color, opacity: 0.4 + 0.6 * Math.min(1, flat.level) }}
        />
      ) : null}
    </span>
  );
};

/** Vertical brake disc glow bar with the core temperature as a tick */
export const BrakeBar: React.FC<{ c: CornerData; className?: string }> = ({ c, className = "h-[52px] w-[7px]" }) => {
  const frac = Math.max(0.04, Math.min(1, c.brake / 1100));
  const coreFrac = c.brakeCore !== null ? Math.max(0, Math.min(1, c.brakeCore / 1100)) : null;
  const color = brakeGlowColor(c.brake);
  return (
    <span
      className={`relative flex-none overflow-hidden rounded-full bg-[#11131A] ${className}`}
      title={`Brake disc ${Math.round(c.brake)} °C${c.brakeCore !== null ? ` · core ${Math.round(c.brakeCore)} °C` : ""}${
        c.padMu !== null ? ` · pad bite ${Math.round(c.padMu * 100)}%` : ""
      }`}
    >
      <span
        className="absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-150"
        style={{ height: `${frac * 100}%`, backgroundColor: color, boxShadow: c.brake > 450 ? `0 0 8px ${color}` : undefined }}
      />
      {coreFrac !== null ? (
        <span className="absolute inset-x-0 h-[2px] bg-[#F5F7FA]/70" style={{ bottom: `${coreFrac * 100}%` }} />
      ) : null}
    </span>
  );
};

/** One corner card: glyph, brake bar, temps, PSI vs optimum, tread life and condition badges */
export const TyreCornerCard: React.FC<{ t: CarTelemetry; i: number; dense?: boolean }> = ({ t, i, dense = false }) => {
  const c = cornerData(t, i);
  const window = t.tireOptimalTempC;
  const right = i % 2 === 1;
  const innerLabel = c.innerIdx === 0 ? ["I", "M", "O"] : ["O", "M", "I"];
  const lifeColor = c.life > 65 ? "#C7CCD8" : c.life > 35 ? HUD_YELLOW : HUD_RED;
  const glyph = (
    <span className="flex flex-col items-center gap-0.5">
      <TyreGlyph c={c} window={window} className={dense ? "h-[44px] w-[30px]" : "h-[52px] w-[34px]"} />
      <span className="flex w-full justify-between px-[3px] font-f1-mono text-[7px] font-extrabold text-[#5B6275]">
        {innerLabel.map((l, k) => (
          <span key={k}>{l}</span>
        ))}
      </span>
    </span>
  );
  const brake = <BrakeBar c={c} className={dense ? "h-[44px] w-[6px]" : "h-[52px] w-[7px]"} />;
  return (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-[14px] border border-[#1B1F2B] bg-[#050608] ${dense ? "p-1.5" : "p-2"} ${
        right ? "flex-row-reverse text-right" : ""
      }`}
      title={`${CORNERS[i]} tread ${c.bands.map((b) => Math.round(b)).join(" / ")} °C (as seen from behind)`}
    >
      {glyph}
      {brake}
      <span className={`flex min-w-0 flex-1 flex-col gap-[1px] ${right ? "items-end" : "items-start"}`}>
        <span className={`flex w-full items-baseline justify-between gap-1 ${right ? "flex-row-reverse" : ""}`}>
          <span className={HUD_LBL}>{CORNERS[i]}</span>
          <span className="lc-data text-[10px]" style={{ color: lifeColor }} title="Tread life">
            {Math.round(c.life)}%
          </span>
        </span>
        <span className={`lc-data leading-tight ${dense ? "text-[14px]" : "text-[16px]"}`} style={{ color: tyreHeatColor(c.temp, window) }}>
          {Math.round(c.temp)}°
        </span>
        {c.psi !== null ? (
          <span className="lc-data text-[10px] whitespace-nowrap text-[#C7CCD8]">
            {c.psi.toFixed(1)}
            {c.psiDelta !== null ? (
              <span className="ml-1" style={{ color: psiDeltaColor(c.psiDelta) }}>
                ({signed(c.psiDelta)})
              </span>
            ) : (
              <span className="ml-1 text-[#8E96AA]">psi</span>
            )}
          </span>
        ) : null}
        <span className="lc-data text-[10px] text-[#8E96AA]">
          <span style={{ color: brakeGlowColor(c.brake) }}>{Math.round(c.brake)}°</span>
          {c.padMu !== null && c.padMu < 0.97 ? <span className="ml-1 text-[#FFB300]">μ{Math.round(c.padMu * 100)}</span> : null}
        </span>
        {c.conditions.length ? (
          <span className={`mt-0.5 flex flex-wrap gap-[3px] ${right ? "justify-end" : ""}`}>
            {c.conditions.map((k) => (
              <span
                key={k.label}
                title={`${k.title} (${Math.round(k.level * 100)}%)`}
                className="rounded-full px-[5px] py-px font-f1-mono text-[7.5px] font-extrabold tracking-[0.06em] text-[#08090D]"
                style={{ backgroundColor: k.color, opacity: 0.55 + 0.45 * Math.min(1, k.level) }}
              >
                {k.label}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
};

/** Compound ring with its letter */
export const CompoundRing: React.FC<{ compound: TireCompound; size?: number }> = ({ compound, size = 18 }) => {
  const c = COMPOUND[compound];
  return (
    <span
      className="lc-disp inline-flex shrink-0 items-center justify-center rounded-full text-[#F5F7FA]"
      style={{ width: size, height: size, border: `${Math.max(2, Math.round(size / 6))}px solid ${c.color}`, fontSize: Math.round(size * 0.48) }}
      aria-label={`${compound} tyres`}
    >
      {c.letter}
    </span>
  );
};

/** 4-corner tyre & brake matrix in the car's layout, with the working window and compound in the header */
export const TyreBrakeGrid: React.FC<{ t: CarTelemetry; compound?: TireCompound; dense?: boolean; header?: boolean }> = ({
  t,
  compound,
  dense = false,
  header = true,
}) => {
  const w = t.tireOptimalTempC ?? [85, 105];
  return (
    <div className="flex flex-col gap-1.5">
      {header ? (
        <div className="flex items-center justify-between gap-2">
          <span className="lc-data inline-flex items-center gap-2 text-[10px] tracking-[0.12em] text-[#F5F7FA]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#CCFF00]" />
            TYRES · O/M/I · BRAKES
          </span>
          <span className="flex items-center gap-2">
            <span className="font-f1-mono text-[9px] font-extrabold tracking-[0.1em] text-[#8E96AA]" title="Working window of the tread">
              <span style={{ color: HUD_CYAN }}>◂</span>
              <span style={{ color: HUD_GREEN }}>
                {Math.round(w[0])}–{Math.round(w[1])}°
              </span>
              <span style={{ color: HUD_RED }}>▸</span>
            </span>
            {compound ? <CompoundRing compound={compound} /> : null}
          </span>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <TyreCornerCard key={i} t={t} i={i} dense={dense} />
        ))}
      </div>
    </div>
  );
};

/**
 * Compact corner for the wheel dash: a mini O/M/I glyph with the brake glow, tread temperature and the PSI delta,
 * plus a dot when a condition (graining, blistering, flat spot, dirt) is active.
 */
export const TyreMini: React.FC<{ t: CarTelemetry; i: number }> = ({ t, i }) => {
  const c = cornerData(t, i);
  const window = t.tireOptimalTempC;
  const worst = c.conditions.reduce<CornerData["conditions"][number] | null>((a, k) => (!a || k.level > a.level ? k : a), null);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-[10px] border border-[#1B1F2B] bg-[#050608] px-1.5 py-1"
      title={`${CORNERS[i]}: tread ${c.bands.map((b) => Math.round(b)).join("/")} °C · ${c.psi?.toFixed(1) ?? "--"} psi · brake ${Math.round(c.brake)} °C${
        worst ? ` · ${worst.label}` : ""
      }`}
    >
      <span className="flex h-[22px] w-[15px] flex-none gap-px rounded-[4px] border-[1.5px] p-px" style={{ borderColor: tyreHeatColor(c.temp, window) }}>
        {c.bands.map((b, k) => (
          <span key={k} className="flex-1 rounded-[1px]" style={{ backgroundColor: tyreHeatColor(b, window) }} />
        ))}
      </span>
      <span className="h-[22px] w-[3px] flex-none overflow-hidden rounded-full bg-[#11131A]">
        <span className="block w-full" style={{ height: "100%", backgroundColor: brakeGlowColor(c.brake), opacity: Math.min(1, 0.25 + c.brake / 900) }} />
      </span>
      <span className="flex min-w-0 flex-col leading-none">
        <span className="flex items-center gap-1">
          <span className={HUD_LBL}>{CORNERS[i]}</span>
          {worst ? <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: worst.color }} /> : null}
        </span>
        <span className="lc-data text-[12px] text-[#F5F7FA]">{Math.round(c.temp)}°</span>
      </span>
      {c.psiDelta !== null ? (
        <span className="lc-data ml-auto text-[10px]" style={{ color: psiDeltaColor(c.psiDelta) }}>
          {signed(c.psiDelta)}
        </span>
      ) : null}
    </div>
  );
};
