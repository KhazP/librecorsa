"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { tyreTempColor } from "./hud-format";

const COMPOUND: Record<TireCompound, { letter: string; color: string }> = {
  soft: { letter: "S", color: "#E10600" },
  medium: { letter: "M", color: "#FFD700" },
  hard: { letter: "H", color: "#FFFFFF" },
};

/** Bottom-left: the four tyres (tread temperature across each one, life %, °C, psi) and the compound */
export const TyrePanel: React.FC<{ telemetry: CarTelemetry; compound: TireCompound }> = ({
  telemetry,
  compound,
}) => {
  const c = COMPOUND[compound];
  const tyre = (idx: number) => {
    const t = telemetry.tireTempsC[idx] || 0;
    const wear = telemetry.tireWearPct?.[idx] ?? 0;
    const bands = telemetry.tireBandTempsC?.[idx] ?? [t, t, t];
    const psi = telemetry.tirePressuresPsi?.[idx];
    return (
      <div className="flex flex-col items-center gap-0.5">
        <div
          className="relative flex h-[46px] w-[32px] overflow-hidden rounded-[7px] border-2"
          style={{ borderColor: tyreTempColor(t) }}
          title={`Tread ${bands.join(" / ")} °C`}
        >
          {/* Tread temperature across the tyre (as seen from behind) */}
          {bands.map((b, i) => (
            <span key={i} className="h-full flex-1" style={{ backgroundColor: `${tyreTempColor(b)}66` }} />
          ))}
          <span className="hud-num absolute inset-x-0 bottom-0.5 text-center text-[10px] text-white/90">
            {Math.max(0, 100 - wear).toFixed(0)}
          </span>
        </div>
        <span className="hud-num text-[13px] text-white">{Math.round(t)}°</span>
        {psi !== undefined ? <span className="hud-num text-[10px] text-white/60">{psi.toFixed(1)}</span> : null}
      </div>
    );
  };

  return (
    <div className="hud-panel flex items-center gap-3 rounded-md px-3 py-2.5">
      <div className="flex flex-col items-center gap-1">
        <span
          className="hud-num flex h-9 w-9 items-center justify-center rounded-full border-[3px] text-[16px] text-white"
          style={{ borderColor: c.color }}
        >
          {c.letter}
        </span>
        <span className="hud-label !text-[10px]">Tyres</span>
        <span className="hud-label !text-[9px] !text-white/40">°C · psi</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {tyre(0)}
        {tyre(1)}
        {tyre(2)}
        {tyre(3)}
      </div>
    </div>
  );
};
