"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  brakeGlowColor,
  formatPressureDeltaPsi,
  formatPressurePsi,
  formatTemp,
  pressureUnit,
  TYRE_CONDITION_SHOW,
  HUD_CAUTION,
  HUD_IDEAL,
  HUD_LBL,
  HUD_LOSS,
  HUD_SLATE,
  tyreHeatColor,
} from "./hud-format";

export const CORNERS = ["FL", "FR", "RL", "RR"] as const;

/** Damage / surface conditions shown as badges once they matter: the word always, the tone for how bad */
const CONDITIONS: readonly {
  key: "tireGrainLevel" | "tireBlisterLevel" | "tireFlatSpotSeverity" | "tireDirtyLevel";
  label: string;
  tone: BadgeTone;
  color: string;
  title: string;
}[] = [
  { key: "tireGrainLevel", label: "Grain", tone: "warn", color: HUD_CAUTION, title: "Graining: the tread surface is tearing (too cold underneath while sliding)" },
  { key: "tireBlisterLevel", label: "Blister", tone: "bad", color: HUD_LOSS, title: "Blistering: the core overheated" },
  { key: "tireFlatSpotSeverity", label: "Flat", tone: "bad", color: HUD_LOSS, title: "Flat spot from a lock-up: vibration and less grip" },
  { key: "tireDirtyLevel", label: "Dirt", tone: "neutral", color: HUD_SLATE, title: "Dirt / marbles picked up off line: cleans up over a few corners" },
];

/** Level from which a condition shows its badge */
const CONDITION_SHOW = TYRE_CONDITION_SHOW;

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
  conditions: { label: string; color: string; tone: BadgeTone; level: number; title: string }[];
}

/** Everything one corner shows, from the telemetry */
export function cornerData(t: CarTelemetry, i: number): CornerData {
  const temp = t.tireTempsC[i] || 0;
  const bands = t.tireBandTempsC?.[i] ?? [temp, temp, temp];
  const psi = t.tirePressuresPsi?.[i] ?? null;
  const opt = t.tireOptimalPsi?.[i] ?? null;
  const conditions = CONDITIONS.flatMap((c) => {
    const level = t[c.key]?.[i] ?? 0;
    return level >= CONDITION_SHOW ? [{ label: c.label, color: c.color, tone: c.tone, level, title: c.title }] : [];
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

/** Pressure delta colour: ideal within ±0.5 psi of the optimum, caution to ±1.5, loss past it (the sign is shown too) */
export const psiDeltaColor = (d: number | null) =>
  d === null ? HUD_SLATE : Math.abs(d) <= 0.5 ? HUD_IDEAL : Math.abs(d) <= 1.5 ? HUD_CAUTION : HUD_LOSS;

/**
 * The tyre seen from above: three tread bands (outer / middle / inner), each filled up to the remaining tread
 * in its own temperature colour, inside a carcass ring in the overall temperature. A flat spot shows as a notch.
 */
export const TyreGlyph: React.FC<{
  c: CornerData;
  window?: readonly [number, number];
  className?: string;
}> = ({ c, window, className = "h-[52px] w-[34px]" }) => {
  const flat = c.conditions.find((k) => k.label === "Flat");
  return (
    <span
      className={`relative flex flex-none gap-0.5 rounded-lc-nub border-[2.5px] p-0.75 ${className}`}
      style={{ borderColor: tyreHeatColor(c.temp, window) }}
    >
      {c.bands.map((b, k) => (
        <span key={k} className="relative flex-1 overflow-hidden rounded-xs bg-lc-carbon">
          {/* The remaining tread, scaled from the bottom (transform only) */}
          <span
            className="absolute inset-0 origin-bottom transition-transform duration-300"
            style={{ transform: `scaleY(${Math.max(6, c.life) / 100})`, backgroundColor: tyreHeatColor(b, window) }}
          />
        </span>
      ))}
      {flat ? (
        <span
          aria-hidden
          className="absolute -inset-x-0.75 top-[38%] h-0.75 rounded-full"
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
      className={`relative flex-none overflow-hidden rounded-full bg-lc-carbon ${className}`}
      title={`Brake disc ${formatTemp(c.brake, undefined, true)}${c.brakeCore !== null ? ` · core ${formatTemp(c.brakeCore, undefined, true)}` : ""}${
        c.padMu !== null ? ` · pad bite ${Math.round(c.padMu * 100)}%` : ""
      }`}
    >
      <span
        className="absolute inset-0 origin-bottom rounded-full transition-transform duration-150"
        style={{ transform: `scaleY(${frac})`, backgroundColor: color }}
      />
      {coreFrac !== null ? (
        <span className="absolute inset-x-0 h-0.5 bg-lc-chalk/70" style={{ bottom: `${coreFrac * 100}%` }} />
      ) : null}
    </span>
  );
};

/** One corner card: glyph, brake bar, temps, PSI vs optimum, tread life and condition badges */
export const TyreCornerCard: React.FC<{ t: CarTelemetry; i: number; dense?: boolean }> = ({ t, i, dense = false }) => {
  const c = cornerData(t, i);
  const units = useUnits();
  const window = t.tireOptimalTempC;
  const right = i % 2 === 1;
  const innerLabel = c.innerIdx === 0 ? ["I", "M", "O"] : ["O", "M", "I"];
  const lifeColor = c.life > 65 ? "var(--color-lc-fog)" : c.life > 35 ? HUD_CAUTION : HUD_LOSS;
  const glyph = (
    <span className="flex flex-col items-center gap-0.5">
      <TyreGlyph c={c} window={window} className={dense ? "h-11 w-7.5" : "h-13 w-8.5"} />
      <span className={`flex w-full justify-between px-0.5 ${HUD_LBL} tracking-normal`} title="Outer, middle, inner tread">
        {innerLabel.map((l, k) => (
          <span key={k}>{l}</span>
        ))}
      </span>
    </span>
  );
  const brake = <BrakeBar c={c} className={dense ? "h-11 w-1.5" : "h-13 w-1.75"} />;
  return (
    <div
      className={`flex min-w-0 items-start gap-2 rounded-lc-row border border-lc-titanium bg-lc-well ${dense ? "p-1.5" : "p-2"} ${
        right ? "flex-row-reverse text-right" : ""
      }`}
      title={`${CORNERS[i]} tread ${c.bands.map((b) => formatTemp(b, units)).join(" / ")} (as seen from behind)`}
    >
      {glyph}
      {brake}
      <span className={`flex min-w-0 flex-1 flex-col gap-px ${right ? "items-end" : "items-start"}`}>
        <span className={`flex w-full items-baseline justify-between gap-1 ${right ? "flex-row-reverse" : ""}`}>
          <span className={HUD_LBL}>{CORNERS[i]}</span>
          <span className="lc-data text-[10px]" style={{ color: lifeColor }} title="Tread life">
            {Math.round(c.life)}%
          </span>
        </span>
        <span className={`lc-data leading-tight ${dense ? "text-[14px]" : "text-[16px]"}`} style={{ color: tyreHeatColor(c.temp, window) }}>
          {formatTemp(c.temp, units)}
        </span>
        {c.psi !== null ? (
          // The delta wraps under the pressure as one piece where the card is narrow (the compact HUD panel)
          <span className="lc-data text-[10px] text-lc-fog" title={`Pressure (${pressureUnit(units)})`}>
            {formatPressurePsi(c.psi, units)}
            {c.psiDelta !== null ? (
              <span className="ml-1 inline-block whitespace-nowrap" style={{ color: psiDeltaColor(c.psiDelta) }}>
                ({formatPressureDeltaPsi(c.psiDelta, units)})
              </span>
            ) : (
              <span className="ml-1 text-lc-slate">{pressureUnit(units)}</span>
            )}
          </span>
        ) : null}
        <span className="lc-data text-[10px] text-lc-slate">
          <span style={{ color: brakeGlowColor(c.brake) }}>{formatTemp(c.brake, units)}</span>
          {c.padMu !== null && c.padMu < 0.97 ? <span className="ml-1 text-lc-caution">μ{Math.round(c.padMu * 100)}</span> : null}
        </span>
        {c.conditions.length ? (
          <span className={`mt-0.5 flex flex-wrap gap-0.75 ${right ? "justify-end" : ""}`}>
            {c.conditions.map((k) => (
              <Badge key={k.label} tone={k.tone} variant="solid" size="hud" title={`${k.title} (${Math.round(k.level * 100)}%)`}>
                {k.label}
              </Badge>
            ))}
          </span>
        ) : null}
      </span>
    </div>
  );
};

/** Compound ring with its letter: the kit's one compound drawing */
export const CompoundRing: React.FC<{ compound: TireCompound; size?: number }> = ({ compound, size = 18 }) => (
  <CompoundGlyph compound={compound} size={size} />
);

/** 4-corner tyre & brake matrix in the car's layout, with the working window and compound in the header */
export const TyreBrakeGrid: React.FC<{ t: CarTelemetry; compound?: TireCompound; dense?: boolean; header?: boolean }> = ({
  t,
  compound,
  dense = false,
  header = true,
}) => {
  const w = t.tireOptimalTempC ?? [85, 105];
  const units = useUnits();
  return (
    <div className="@container flex flex-col gap-1.5">
      {header ? (
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap" title="Working window of the tread">
            <span className={HUD_LBL}>Window</span>
            <span className="lc-data text-[10px]" style={{ color: HUD_IDEAL }}>
              {formatTemp(w[0], units)}–{formatTemp(w[1], units, true)}
            </span>
          </span>
          {compound ? <CompoundRing compound={compound} /> : null}
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
  const units = useUnits();
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 rounded-lc-nub border border-lc-titanium bg-lc-well px-1.5 py-1"
      title={`${CORNERS[i]}: tread ${c.bands.map((b) => formatTemp(b, units)).join("/")} · ${
        c.psi !== null ? `${formatPressurePsi(c.psi, units)} ${pressureUnit(units)}` : "--"
      } · brake ${formatTemp(c.brake, units, true)}${worst ? ` · ${worst.label}` : ""}`}
    >
      <span className="flex h-5.5 w-3.75 flex-none gap-px rounded-sm border-[1.5px] p-px" style={{ borderColor: tyreHeatColor(c.temp, window) }}>
        {c.bands.map((b, k) => (
          <span key={k} className="flex-1 rounded-xs" style={{ backgroundColor: tyreHeatColor(b, window) }} />
        ))}
      </span>
      <span className="h-5.5 w-0.75 flex-none overflow-hidden rounded-full bg-lc-carbon">
        <span className="block h-full w-full" style={{ backgroundColor: brakeGlowColor(c.brake), opacity: Math.min(1, 0.25 + c.brake / 900) }} />
      </span>
      <span className="flex min-w-0 flex-col leading-none">
        <span className="flex items-center gap-1">
          <span className={HUD_LBL}>{CORNERS[i]}</span>
          {/* A condition (graining, blistering, flat spot, dirt): a warning sign in its tone, named in the tooltip */}
          {worst ? (
            <span className="inline-flex" style={{ color: worst.color }}>
              <Icon name="warning" size="xs" className="size-2.5" label={worst.label} />
            </span>
          ) : null}
        </span>
        <span className="lc-data text-[12px] text-lc-chalk">{formatTemp(c.temp, units)}</span>
      </span>
      {c.psiDelta !== null ? (
        <span className="lc-data ml-auto text-[10px]" style={{ color: psiDeltaColor(c.psiDelta) }}>
          {formatPressureDeltaPsi(c.psiDelta, units)}
        </span>
      ) : null}
    </div>
  );
};
