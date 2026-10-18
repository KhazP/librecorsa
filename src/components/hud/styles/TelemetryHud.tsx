"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { formatLapTime, formatSectorTime, HUD_PURPLE, tyreTempColor } from "../hud-format";
import { InputTrace } from "../InputTrace";
import { F12026ChannelsPanel } from "../F12026ChannelsPanel";
import { BroadcastMap, BroadcastTower } from "./BroadcastHud";
import { WheelDash } from "./WheelDashHud";
import { anchor, COMPOUND_COLORS, sectorColor, type HudDesignProps } from "./hud-style-parts";

const CARD = "rounded-md border border-[#262B3D] bg-[#08090D]/85 p-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.55)] backdrop-blur-md";
const LABEL = "font-f1-mono text-[9px] font-extrabold tracking-[0.18em] text-[#8E96AA] uppercase";

/** Sector table with best sectors, the theoretical best and top speeds */
const LapAnalysis: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const bests = t.bestSectorTimesMs;
  const ideal = bests.every((b) => b) ? bests.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  return (
    <div className={`w-[232px] ${CARD}`}>
      <div className="mb-1.5 grid grid-cols-[28px_1fr_1fr] gap-x-2 font-f1-mono">
        <span className={LABEL}>S</span>
        <span className={`${LABEL} text-right`}>This lap</span>
        <span className={`${LABEL} text-right`}>Best</span>
        {[0, 1, 2].map((i) => {
          const done = i + 1 < t.currentSector;
          const ms = t.sectorTimesMs[i];
          return (
            <React.Fragment key={i}>
              <span className={`text-[11px] font-extrabold ${i + 1 === t.currentSector ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>{i + 1}</span>
              <span className="text-right text-[12px] font-bold" style={{ color: done ? sectorColor(ms, bests[i]) : "#5B6275" }}>
                {done ? formatSectorTime(ms) : "--.---"}
              </span>
              <span className="text-right text-[12px] font-bold text-[#B845FF]">{formatSectorTime(bests[i])}</span>
            </React.Fragment>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-1.5 border-t border-[#262B3D] pt-1.5 font-f1-mono">
        <div>
          <div className={LABEL}>Ideal lap</div>
          <div className="text-[12px] font-bold" style={{ color: HUD_PURPLE }}>
            {formatLapTime(ideal)}
          </div>
        </div>
        <div className="text-right">
          <div className={LABEL}>Top speed</div>
          <div className="text-[12px] font-bold text-[#F5F7FA]">
            {Math.round(t.topSpeedThisLapKmh)} <span className="text-[#8E96AA]">/ {Math.round(t.allTimeTopSpeedKmh)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};

/** Friction circle and the G readout */
const GMeter: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const x = Math.max(-1, Math.min(1, t.lateralG / 5)) * 44;
  const y = Math.max(-1, Math.min(1, -t.longitudinalG / 5)) * 44;
  return (
    <div className={`flex w-[210px] items-center gap-3 ${CARD}`}>
      <svg viewBox="-50 -50 100 100" className="h-[78px] w-[78px] shrink-0" aria-hidden>
        <circle r={48} fill="#050507" stroke="#262B3D" />
        {[16, 32].map((r) => (
          <circle key={r} r={r} fill="none" stroke="rgba(255,255,255,0.08)" />
        ))}
        <line x1={-48} x2={48} stroke="rgba(255,255,255,0.08)" />
        <line y1={-48} y2={48} stroke="rgba(255,255,255,0.08)" />
        <circle cx={x} cy={y} r={5} fill="#CCFF00" style={{ filter: "drop-shadow(0 0 4px #CCFF00)" }} />
      </svg>
      <div className="grid flex-1 gap-1 font-f1-mono">
        {[
          ["Lateral", t.lateralG],
          ["Long", t.longitudinalG],
          ["DF", null],
        ].map(([label, g]) => (
          <div key={label as string} className="flex items-baseline justify-between">
            <span className={LABEL}>{label as string}</span>
            <span className="text-[12px] font-bold text-[#F5F7FA]">
              {g === null ? `${Math.round(t.downforceKgf)}kg` : `${Math.abs(g as number).toFixed(1)}g`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** One corner: tread temperatures across the tyre, pressure, wear and the brake */
const TyreCorner: React.FC<{ t: CarTelemetry; i: number; name: string }> = ({ t, i, name }) => {
  const bands = t.tireBandTempsC?.[i] ?? [t.tireTempsC[i], t.tireTempsC[i], t.tireTempsC[i]];
  const brake = t.brakeTempsC[i];
  const wear = t.tireWearPct[i] ?? 0;
  return (
    <div className="rounded-[4px] border border-[#262B3D] bg-black p-1.5 font-f1-mono">
      <div className="flex items-baseline justify-between">
        <span className={LABEL}>{name}</span>
        <span className="text-[13px] font-extrabold" style={{ color: tyreTempColor(t.tireTempsC[i]) }}>
          {Math.round(t.tireTempsC[i])}°
        </span>
      </div>
      <div className="mt-1 flex h-[22px] gap-[2px]">
        {bands.map((c, k) => (
          <span key={k} className="flex-1 rounded-[2px]" style={{ backgroundColor: tyreTempColor(c), opacity: 0.85 }} />
        ))}
      </div>
      <div className="mt-1 grid grid-cols-3 text-[10px] font-bold">
        <span className="text-[#C7CCD8]">{t.tirePressuresPsi ? t.tirePressuresPsi[i].toFixed(1) : "--"}</span>
        <span className="text-center" style={{ color: wear > 60 ? "#FF2A3C" : wear > 35 ? "#FFB300" : "#C7CCD8" }}>
          {Math.round(100 - wear)}%
        </span>
        <span className="text-right" style={{ color: brake > 850 ? "#FF2A3C" : brake > 600 ? "#FFB300" : "#8E96AA" }}>
          {Math.round(brake)}°
        </span>
      </div>
    </div>
  );
};

const TyreDetail: React.FC<{ t: CarTelemetry; compound: TireCompound }> = ({ t, compound }) => (
  <div className={`w-[244px] ${CARD}`}>
    <div className="mb-1.5 flex items-center justify-between">
      <span className={LABEL}>Tyres · psi · life · brake</span>
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full border-2 font-f1-italic text-[10px] text-[#F5F7FA] uppercase"
        style={{ borderColor: COMPOUND_COLORS[compound] }}
      >
        {compound[0]}
      </span>
    </div>
    <div className="grid grid-cols-2 gap-1">
      {(["FL", "FR", "RL", "RR"] as const).map((n, i) => (
        <TyreCorner key={n} t={t} i={i} name={n} />
      ))}
    </div>
  </div>
);

/** Power unit and aero numbers */
const PowerAero: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const hasErs = t.f12026?.hasErs ?? true;
  const rows: [string, string, string?][] = [
    ["Power", `${Math.round(t.totalPowerKw)} kW`],
    ...(hasErs
      ? [["MGU-K", `${t.mgukPowerKw > 0 ? "+" : ""}${Math.round(t.mgukPowerKw)} kW`, t.mgukPowerKw > 0 ? "#00E5FF" : t.mgukPowerKw < 0 ? "#00E676" : undefined] as [string, string, string?]]
      : []),
    ["Drag", `${(t.dragN / 1000).toFixed(1)} kN`],
    ...(t.fuelKg > 0 ? [["Fuel", `${t.fuelKg.toFixed(1)} kg`] as [string, string]] : []),
  ];
  return (
    <div className={`w-[210px] ${CARD}`}>
      {rows.map(([label, value, color]) => (
        <div key={label} className="flex items-baseline justify-between font-f1-mono leading-[1.5]">
          <span className={LABEL}>{label}</span>
          <span className="text-[12px] font-bold" style={{ color: color ?? "#F5F7FA" }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
};

/**
 * Telemetry: the Wheel Dash with the engineer's pit wall around it. Tower and sector analysis
 * top-left, map, G-meter and power / aero top-right, tyre detail bottom-left, inputs and the
 * car's channels bottom-right. The side panels give way on small screens, leaving the dash.
 */
export const TelemetryHud: React.FC<HudDesignProps> = ({ t, deltaS, map, compound = "soft", revRange, scale, trackCode, ffb }) => (
  <div className="pointer-events-none absolute inset-0 select-none">
    <div className="absolute top-4 left-4 flex flex-col gap-2" style={anchor(scale, "top left")}>
      <BroadcastTower t={t} trackCode={trackCode} />
      <div className="compact:hidden">
        <LapAnalysis t={t} />
      </div>
    </div>

    <div className="absolute top-4 right-4 hidden flex-col items-end gap-2 md:flex" style={anchor(scale, "top right")}>
      <BroadcastMap t={t} map={map} />
      <div className="flex flex-col items-end gap-2 compact:hidden">
        <GMeter t={t} />
        <PowerAero t={t} />
      </div>
    </div>

    <div className="absolute bottom-4 left-4 compact:hidden" style={anchor(scale, "bottom left")}>
      <TyreDetail t={t} compound={compound} />
    </div>

    <div className="absolute right-4 bottom-4 flex flex-col items-end gap-2 compact:hidden" style={anchor(scale, "bottom right")}>
      {t.f12026 ? <F12026ChannelsPanel channels={t.f12026} /> : null}
      {ffb}
      <InputTrace sample={{ throttle: t.throttle, brake: t.brake, steering: t.steering }} />
    </div>

    {/* Narrower while the tyre and input panels sit either side */}
    <div
      className="absolute bottom-4 left-1/2 w-[min(600px,calc(100vw-24px))] -translate-x-1/2 not-compact:w-[min(600px,calc(100vw-560px))]"
      style={anchor(scale, "bottom center")}
    >
      <WheelDash t={t} deltaS={deltaS} revRange={revRange} />
    </div>
  </div>
);
