"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import { aidsActive, formatLapTime, formatSectorTime, formatSpeed, HUD_BEST, HUD_GAIN, HUD_INFO, LAP_MARK_COLOR, lapMark, NO_TIME, speedUnit } from "../hud-format";
import { aeroReadout } from "../aero-label";
import { TyreBrakeGrid } from "../TyreBrakeWidget";
import { InputTrace } from "../InputTrace";
import { PedalBars, pedalLayers } from "../PedalBars";
import { F12026ChannelsPanel } from "../F12026ChannelsPanel";
import { BroadcastMap, BroadcastTower } from "./BroadcastHud";
import { WheelDash } from "./WheelDashHud";
import { anchor, HUD_GLASS, HUD_LBL, LapMarkGlyph, type HudDesignProps } from "./hud-style-parts";

const CARD = `w-full rounded-lc-tile px-3 py-2.5 ${HUD_GLASS}`;
const LABEL = HUD_LBL;

/** Sector table with best sectors, the theoretical best and top speeds */
const LapAnalysis: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const bests = t.bestSectorTimesMs;
  const ideal = bests.every((b) => b) ? bests.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  // On your own your bests are the session's (purple); in a race only your own (green)
  const bestColor = t.race ? HUD_GAIN : HUD_BEST;
  const units = useUnits();
  return (
    <section aria-label="Lap analysis" className={CARD}>
      <div className="grid grid-cols-[24px_1fr_1fr] items-baseline gap-x-2 gap-y-1 lc-mono">
        <span className={LABEL}>S</span>
        <span className={`${LABEL} text-right`}>This lap</span>
        <span className={`${LABEL} text-right`}>Best</span>
        {[0, 1, 2].map((i) => {
          const done = i + 1 < t.currentSector;
          const ms = t.sectorTimesMs[i];
          const mark = done ? lapMark(ms, bests[i], !t.race) : null;
          return (
            <React.Fragment key={i}>
              <span className={`lc-data text-[12px] ${i + 1 === t.currentSector ? "text-lc-info" : "text-lc-slate"}`}>{i + 1}</span>
              <span
                className="lc-data inline-flex items-center justify-end gap-1 text-[12px]"
                style={{ color: mark ? LAP_MARK_COLOR[mark] : "var(--color-lc-slate)" }}
              >
                {mark ? <LapMarkGlyph mark={mark} /> : null}
                {done ? formatSectorTime(ms) : NO_TIME}
              </span>
              <span className="lc-data text-right text-[12px]" style={{ color: bests[i] ? bestColor : "var(--color-lc-slate)" }}>
                {formatSectorTime(bests[i])}
              </span>
            </React.Fragment>
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-lc-line pt-2">
        <div>
          <div className={LABEL}>Ideal lap</div>
          <div className="lc-data text-[12px]" style={{ color: ideal ? bestColor : "var(--color-lc-slate)" }}>
            {formatLapTime(ideal)}
          </div>
        </div>
        <div className="text-right">
          <div className={LABEL}>Top · {speedUnit(units)}</div>
          <div className="lc-data text-[12px] text-lc-chalk">
            {formatSpeed(t.topSpeedThisLapKmh, units)} <span className="text-lc-slate">/ {formatSpeed(t.allTimeTopSpeedKmh, units)}</span>
          </div>
        </div>
      </div>
    </section>
  );
};

/** Label / value row of the G and power card */
const Row: React.FC<{ label: string; value: string; color?: string; className?: string }> = ({ label, value, color, className = "" }) => (
  <div className={`flex items-baseline justify-between gap-2 ${className}`}>
    <span className={LABEL}>{label}</span>
    <span className="lc-data text-[12px]" style={{ color: color ?? "var(--color-lc-chalk)" }}>
      {value}
    </span>
  </div>
);

/** Friction circle with the G readout, then the power unit and aero numbers */
const GPowerCard: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const x = Math.max(-1, Math.min(1, t.lateralG / 5)) * 44;
  const y = Math.max(-1, Math.min(1, -t.longitudinalG / 5)) * 44;
  const hasErs = t.f12026?.hasErs ?? true;
  return (
    <section aria-label="G-meter and power" className={`flex items-center gap-3 ${CARD}`}>
      <svg viewBox="-50 -50 100 100" className="h-[72px] w-[72px] shrink-0" aria-hidden>
        <circle r={48} fill="var(--color-lc-well)" stroke="var(--color-lc-line)" />
        {[16, 32].map((r) => (
          <circle key={r} r={r} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.08} />
        ))}
        <line x1={-48} x2={48} stroke="var(--color-lc-chalk)" strokeOpacity={0.08} />
        <line y1={-48} y2={48} stroke="var(--color-lc-chalk)" strokeOpacity={0.08} />
        <circle cx={x} cy={y} r={6} fill="var(--color-lc-volt)" />
      </svg>
      <div className="grid flex-1 gap-0.5">
        <Row label="Lateral" value={`${Math.abs(t.lateralG).toFixed(1)} g`} />
        <Row label="Long" value={`${Math.abs(t.longitudinalG).toFixed(1)} g`} />
        <Row label="DF" value={`${Math.round(t.downforceKgf)} kg`} />
        <Row label="Power" value={`${Math.round(t.totalPowerKw)} kW`} className="mt-1 border-t border-lc-line pt-1" />
        {hasErs ? (
          <Row
            label="MGU-K"
            value={`${t.mgukPowerKw > 0 ? "+" : ""}${Math.round(t.mgukPowerKw)} kW`}
            color={t.mgukPowerKw > 0 ? HUD_INFO : undefined}
          />
        ) : null}
        <Row label="Drag" value={`${(t.dragN / 1000).toFixed(1)} kN`} />
        {t.fuelKg > 0 ? <Row label="Fuel" value={`${t.fuelKg.toFixed(1)} kg`} /> : null}
      </div>
    </section>
  );
};

const TyreDetail: React.FC<{ t: CarTelemetry; compound: TireCompound }> = ({ t, compound }) => (
  <section aria-label="Tyres" className={CARD}>
    <TyreBrakeGrid t={t} compound={compound} dense />
  </section>
);

/**
 * Telemetry: the Wheel Dash with the engineer's pit wall around it. Session card and sector
 * analysis top-left, map and the G / power card top-right, inputs and tyre detail bottom-left,
 * the car's channels, wheel force and the tuner bottom-right. The side panels give way on small
 * screens, leaving the dash.
 */
export const TelemetryHud: React.FC<HudDesignProps> = ({ t, deltaS, map, compound = "soft", revRange, scale, trackCode, ffb, mfd, lapInvalid, towerGaps, mapMode, leftExtra, rightExtra }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-5 left-5 flex w-[252px] flex-col gap-2" style={anchor(scale, "top left")}>
      <BroadcastTower t={t} trackCode={trackCode} lapInvalid={lapInvalid} gaps={towerGaps} />
      {leftExtra}
      <div className="compact:hidden">
        <LapAnalysis t={t} />
      </div>
    </div>

    <div className="absolute top-5 right-5 hidden w-[252px] flex-col items-end gap-2 md:flex" style={anchor(scale, "top right")}>
      <BroadcastMap t={t} map={map} mapMode={mapMode} />
      {rightExtra}
      <div className="flex w-full flex-col items-end gap-2 compact:hidden">
        <GPowerCard t={t} />
      </div>
    </div>

    <div className="absolute bottom-5 left-5 flex w-[252px] flex-col items-start gap-2 compact:hidden" style={anchor(scale, "bottom left")}>
      {(() => {
        const p = pedalLayers(t);
        return (
          <InputTrace
            sample={{
              throttle: t.throttle,
              brake: t.brake,
              steering: t.steering,
              steerInput: t.steerInput,
              throttleOut: p.throttleOut,
              brakeOut: p.brakeOut,
              ffbClip: p.ffbClip,
            }}
            steerLockDeg={t.steerLockDeg}
            width={148}
            aside={<PedalBars t={t} />}
          />
        );
      })()}
      <TyreDetail t={t} compound={compound} />
    </div>

    <div data-hud-avoid className="absolute right-5 bottom-5 flex flex-col items-end gap-2 compact:hidden" style={anchor(scale, "bottom right")}>
      {/* The MFD on top: folding it moves nothing else in the corner */}
      {mfd}
      {t.f12026 ? <F12026ChannelsPanel channels={t.f12026} aero={aeroReadout(t)} aids={aidsActive(t)} /> : null}
      {ffb}
    </div>

    {/* Narrower while the tyre and input panels sit either side */}
    <div
      data-hud-avoid
      className="absolute bottom-5 left-1/2 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 not-compact:w-[min(560px,calc(100vw-620px))]"
      style={anchor(scale, "bottom center")}
    >
      <WheelDash t={t} deltaS={deltaS} revRange={revRange} lapInvalid={lapInvalid} />
    </div>
  </div>
);
