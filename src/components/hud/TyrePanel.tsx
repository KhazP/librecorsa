"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { HUD_GREEN, HUD_RED, HUD_WHITE, HUD_YELLOW, tyreTempColor } from "./hud-format";

const COMPOUND: Record<TireCompound, { letter: string; name: string; color: string }> = {
  soft: { letter: "S", name: "SOFT", color: HUD_RED },
  medium: { letter: "M", name: "MED", color: HUD_YELLOW },
  hard: { letter: "H", name: "HARD", color: HUD_WHITE },
};

const CORNER_LABELS = ["FL", "FR", "RL", "RR"] as const;

/** Bottom-left LibreCorsa 4-corner tyre thermal, wear, and pressure matrix */
export const TyrePanel: React.FC<{ telemetry: CarTelemetry; compound: TireCompound }> = ({
  telemetry,
  compound,
}) => {
  const c = COMPOUND[compound];

  const tyreCard = (idx: number) => {
    const t = telemetry.tireTempsC[idx] || 0;
    const wear = telemetry.tireWearPct?.[idx] ?? 0;
    const life = Math.max(0, 100 - wear);
    const bands = telemetry.tireBandTempsC?.[idx] ?? [t, t, t];
    const psi = telemetry.tirePressuresPsi?.[idx];
    const lifeColor = life > 65 ? HUD_GREEN : life > 35 ? HUD_YELLOW : HUD_RED;

    return (
      <div
        key={idx}
        className="flex items-center gap-2 rounded bg-[#08090D] border border-[#262B3D] p-1.5"
        title={`${CORNER_LABELS[idx]} Tread I/M/O: ${bands.map((b) => Math.round(b)).join(" / ")} °C`}
      >
        {/* 3-Band Tread Carcass + Life Bar */}
        <div className="flex items-center gap-1">
          <div
            className="relative flex h-[40px] w-[26px] overflow-hidden rounded-[5px] border"
            style={{ borderColor: tyreTempColor(t) }}
          >
            {bands.map((b, i) => (
              <span
                key={i}
                className="h-full flex-1"
                style={{ backgroundColor: `${tyreTempColor(b)}80` }}
              />
            ))}
            <span className="hud-num absolute inset-x-0 bottom-0.5 text-center text-[9px] text-[#F5F7FA] drop-shadow">
              {life.toFixed(0)}%
            </span>
          </div>
          {/* Vertical Tyre Life Strip */}
          <div className="relative h-[40px] w-[3px] overflow-hidden rounded-full bg-white/10">
            <div
              className="absolute inset-x-0 bottom-0 rounded-full"
              style={{ height: `${life}%`, backgroundColor: lifeColor }}
            />
          </div>
        </div>

        {/* Corner Readouts: Tag, Temp °C, Pressure PSI */}
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="font-f1-mono text-[9px] font-extrabold text-[#8E96AA]">
              {CORNER_LABELS[idx]}
            </span>
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: tyreTempColor(t) }}
            />
          </div>
          <div className="hud-num text-[14px] text-[#F5F7FA]">{Math.round(t)}°C</div>
          {psi !== undefined ? (
            <div className="font-f1-mono text-[9px] font-bold tabular-nums text-[#8E96AA]">
              {psi.toFixed(1)} <span className="text-[8px]">PSI</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="hud-panel w-[244px] rounded-lg px-3 py-2.5">
      {/* Header: Tyre Telemetry & Compound Pill */}
      <div className="mb-2 flex items-center justify-between border-b border-[#262B3D] pb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#CCFF00]" />
          <span className="hud-label !text-[#F5F7FA]">TYRES · I/M/O</span>
        </div>
        <span className="flex items-center gap-1 rounded bg-[#08090D] border border-[#262B3D] px-1.5 py-0.5">
          <span
            className="flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-black text-[#F5F7FA]"
            style={{ borderColor: c.color }}
          >
            {c.letter}
          </span>
          <span className="font-f1-mono text-[9px] font-bold" style={{ color: c.color }}>
            {c.name}
          </span>
        </span>
      </div>

      {/* 4-Corner Chassis Matrix */}
      <div className="grid grid-cols-2 gap-1.5">
        {tyreCard(0)}
        {tyreCard(1)}
        {tyreCard(2)}
        {tyreCard(3)}
      </div>
    </div>
  );
};
