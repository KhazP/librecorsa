"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { formatLapTime, formatSectorTime, HUD_PURPLE } from "../hud-format";
import { TyreBrakeGrid } from "../TyreBrakeWidget";
import { InputTrace } from "../InputTrace";
import { PedalBars, pedalLayers } from "../PedalBars";
import { F12026ChannelsPanel } from "../F12026ChannelsPanel";
import { BroadcastMap, BroadcastTower } from "./BroadcastHud";
import { WheelDash } from "./WheelDashHud";
import { anchor, HUD_GLASS, HUD_LBL, sectorColor, type HudDesignProps } from "./hud-style-parts";

const CARD = `w-full rounded-[20px] px-3 py-2.5 ${HUD_GLASS}`;
const LABEL = HUD_LBL;

/** Sector table with best sectors, the theoretical best and top speeds */
const LapAnalysis: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const bests = t.bestSectorTimesMs;
  const ideal = bests.every((b) => b) ? bests.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  return (
    <section aria-label="Lap analysis" className={CARD}>
      <div className="grid grid-cols-[24px_1fr_1fr] items-baseline gap-x-2 gap-y-1 font-f1-mono">
        <span className={LABEL}>S</span>
        <span className={`${LABEL} text-right`}>This lap</span>
        <span className={`${LABEL} text-right`}>Best</span>
        {[0, 1, 2].map((i) => {
          const done = i + 1 < t.currentSector;
          const ms = t.sectorTimesMs[i];
          return (
            <React.Fragment key={i}>
              <span className={`lc-data text-[12px] ${i + 1 === t.currentSector ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>{i + 1}</span>
              <span className="lc-data text-right text-[12px]" style={{ color: done ? sectorColor(ms, bests[i]) : "#5B6275" }}>
                {done ? formatSectorTime(ms) : "--.---"}
              </span>
              <span className="lc-data text-right text-[12px] text-[#B845FF]">{formatSectorTime(bests[i])}</span>
            </React.Fragment>
          );
        })}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-[#262B3D] pt-2">
        <div>
          <div className={LABEL}>Ideal lap</div>
          <div className="lc-data text-[12px]" style={{ color: HUD_PURPLE }}>
            {formatLapTime(ideal)}
          </div>
        </div>
        <div className="text-right">
          <div className={LABEL}>Top speed</div>
          <div className="lc-data text-[12px] text-[#F5F7FA]">
            {Math.round(t.topSpeedThisLapKmh)} <span className="text-[#8E96AA]">/ {Math.round(t.allTimeTopSpeedKmh)}</span>
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
    <span className="lc-data text-[12px]" style={{ color: color ?? "#F5F7FA" }}>
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
        <circle r={48} fill="#050608" stroke="#262B3D" />
        {[16, 32].map((r) => (
          <circle key={r} r={r} fill="none" stroke="rgba(255,255,255,0.08)" />
        ))}
        <line x1={-48} x2={48} stroke="rgba(255,255,255,0.08)" />
        <line y1={-48} y2={48} stroke="rgba(255,255,255,0.08)" />
        <circle cx={x} cy={y} r={6} fill="#CCFF00" style={{ filter: "drop-shadow(0 0 4px #CCFF00)" }} />
      </svg>
      <div className="grid flex-1 gap-0.5">
        <Row label="Lateral" value={`${Math.abs(t.lateralG).toFixed(1)}g`} />
        <Row label="Long" value={`${Math.abs(t.longitudinalG).toFixed(1)}g`} />
        <Row label="DF" value={`${Math.round(t.downforceKgf)}kg`} />
        <Row label="Power" value={`${Math.round(t.totalPowerKw)} kW`} className="mt-1 border-t border-[#262B3D] pt-1" />
        {hasErs ? (
          <Row
            label="MGU-K"
            value={`${t.mgukPowerKw > 0 ? "+" : ""}${Math.round(t.mgukPowerKw)} kW`}
            color={t.mgukPowerKw > 0 ? "#00E5FF" : t.mgukPowerKw < 0 ? "#00E676" : undefined}
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
export const TelemetryHud: React.FC<HudDesignProps> = ({ t, deltaS, map, compound = "soft", revRange, scale, trackCode, ffb, mfd, lapInvalid, towerGaps, mapMode }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-5 left-5 flex w-[252px] flex-col gap-2" style={anchor(scale, "top left")}>
      <BroadcastTower t={t} trackCode={trackCode} lapInvalid={lapInvalid} gaps={towerGaps} />
      <div className="compact:hidden">
        <LapAnalysis t={t} />
      </div>
    </div>

    <div className="absolute top-5 right-5 hidden w-[252px] flex-col items-end gap-2 md:flex" style={anchor(scale, "top right")}>
      <BroadcastMap t={t} map={map} mapMode={mapMode} />
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
              throttleOut: p.throttleOut,
              brakeOut: p.brakeOut,
              ffbClip: p.ffbClip,
            }}
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
      {t.f12026 ? <F12026ChannelsPanel channels={t.f12026} /> : null}
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
