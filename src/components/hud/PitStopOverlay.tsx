"use client";

import React from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { HUD_GLASS } from "./hud-format";

const COMPOUNDS: readonly { id: TireCompound; letter: string; label: string; color: string }[] = [
  { id: "soft", letter: "S", label: "Soft", color: "#ef4444" },
  { id: "medium", letter: "M", label: "Medium", color: "#eab308" },
  { id: "hard", letter: "H", label: "Hard", color: "#f8fafc" },
  { id: "intermediate", letter: "I", label: "Inter", color: "#22c55e" },
  { id: "wet", letter: "W", label: "Wet", color: "#38bdf8" },
];

export interface PitStopOverlayProps {
  telemetry: CarTelemetry;
  currentCompound: TireCompound;
  pitLimiterKey?: string;
}

/**
 * Pure non-interactive pit lane HUD indicator (strategy setup lives in the MFD's PIT page).
 * Displays:
 * - Slow-down warning before the pit entry detection line
 * - Active pit speed limiter status (manual or automatic)
 * - Distance / alignment cue to the player's 3D pit box
 * - Servicing countdown while car controls are locked
 * - Green-light release banner when tyres + repairs finish
 */
export const PitStopOverlay: React.FC<PitStopOverlayProps> = ({
  telemetry,
  currentCompound,
  pitLimiterKey,
}) => {
  const pit = telemetry.pit;
  if (!pit || telemetry.race?.phase === "finished") return null;

  const chosen = COMPOUNDS.find((c) => c.id === (pit.strategy.nextCompound ?? currentCompound)) ?? COMPOUNDS[0];
  const speedKmh = Math.round(Math.abs(telemetry.speedKmh || 0));

  if (pit.phase === "released") {
    return (
      <div className="pointer-events-none fixed top-24 left-1/2 z-40 -translate-x-1/2">
        <div className="flex items-center gap-3 rounded-lc-tile border-2 border-lc-gain bg-lc-void/95 px-6 py-3 shadow-lc-pop">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-lc-gain text-[12px] font-black text-lc-void">
            GO
          </span>
          <div className="flex flex-col">
            <span className="lc-disp text-[20px] leading-none text-lc-gain uppercase">
              Green light · Pit stop complete ({pit.serviceTotalS.toFixed(2)} s)
            </span>
            <span className="text-[11px] font-bold text-lc-chalk">
              Fresh <span style={{ color: chosen.color }}>{chosen.label}</span> tyres fitted
              {pit.strategy.repairDamage && pit.repairDurationS > 0 ? " · Damage repaired" : ""} · Refuelled
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (pit.phase === "servicing") {
    const total = Math.max(0.1, pit.serviceTotalS);
    const doneFrac = Math.max(0, Math.min(1, 1 - pit.serviceRemainingS / total));
    return (
      <div className="pointer-events-none fixed top-24 left-1/2 z-40 w-[356px] -translate-x-1/2">
        <div className="flex flex-col gap-2.5 rounded-lc-tile border-2 border-lc-volt bg-lc-void/95 p-4 shadow-lc-pop">
          <div className="flex items-center justify-between">
            <span className="lc-title text-[14px] font-black tracking-wider text-lc-volt uppercase">
              Pit Box #{pit.assignedBoxIndex + 1} · Controls Locked
            </span>
            <span className="lc-data text-[16px] font-black text-lc-chalk">
              {pit.serviceRemainingS.toFixed(1)} s
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-lc-volt transition-[width] duration-75"
              style={{ width: `${Math.round(doneFrac * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] font-semibold text-lc-fog">
            <span>
              Fitting <strong style={{ color: chosen.color }}>{chosen.label}</strong> ({pit.tyreDurationS.toFixed(2)} s)
            </span>
            <span>
              {pit.repairDurationS > 0
                ? `Repairing +${pit.repairDurationS.toFixed(1)} s`
                : "No repairs needed"}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (pit.phase === "entry_warning") {
    const tooFast = speedKmh > pit.speedLimitKmh;
    return (
      <div className="pointer-events-none fixed top-22 left-1/2 z-40 -translate-x-1/2">
        <div
          className={`flex items-center gap-3 rounded-lc-tile border-2 px-5 py-2.5 shadow-lc-pop ${
            tooFast
              ? "border-lc-loss bg-lc-void/95 text-lc-loss"
              : "border-lc-caution bg-lc-void/95 text-lc-caution"
          }`}
        >
          <span
            className={`rounded px-2 py-0.5 text-[11px] font-black uppercase ${
              tooFast ? "bg-lc-loss text-lc-void" : "bg-lc-caution text-lc-void"
            }`}
          >
            {tooFast ? "SLOW DOWN" : "PIT ENTRY"}
          </span>
          <div className="flex flex-col">
            <span className="lc-disp text-[17px] leading-tight uppercase">
              {tooFast
                ? `Brake to ${pit.speedLimitKmh} km/h before detection`
                : `Pit speed limit ${pit.speedLimitKmh} km/h`}
            </span>
            <span className="lc-data text-[11px] text-lc-fog">
              {pit.distToDetectM !== null ? `Detection line in ${Math.round(pit.distToDetectM)} m · ` : ""}
              Now {speedKmh} km/h
              {pitLimiterKey && pitLimiterKey !== "—" ? ` · Limiter: ${pitLimiterKey}` : ""}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (pit.phase === "lane" || pit.phase === "in_box") {
    return (
      <div className="pointer-events-none fixed top-22 left-1/2 z-40 flex flex-col items-center gap-2 -translate-x-1/2">
        {pit.speedWarning ? (
          <div className="rounded-lc-row border border-lc-loss bg-lc-loss/90 px-4 py-1 text-[12px] font-black tracking-wide text-lc-void uppercase shadow-lc-pop">
            +5s Time Penalty · Pit Lane Speeding
          </div>
        ) : null}
        <div
          className={`flex items-center gap-3 rounded-lc-tile border px-4 py-2.5 ${
            pit.alignedInBox ? "border-lc-gain bg-lc-void/95" : `border-lc-info/70 ${HUD_GLASS}`
          }`}
        >
          <span className="rounded bg-lc-info px-2 py-0.5 text-[10px] font-black text-lc-void uppercase">
            LIM {pit.speedLimitKmh} KM/H · AUTO
          </span>
          <div className="flex flex-col">
            <span
              className={`lc-title text-[13px] font-black uppercase ${
                pit.alignedInBox ? "text-lc-gain" : "text-lc-chalk"
              }`}
            >
              {pit.alignedInBox
                ? `In Pit Box #${pit.assignedBoxIndex + 1} · Stop Completely`
                : pit.distToBoxM !== null && pit.distToBoxM > 0
                  ? `Pit Box #${pit.assignedBoxIndex + 1} in ${Math.round(pit.distToBoxM)} m`
                  : pit.distToBoxM !== null
                    ? `Passed Pit Box #${pit.assignedBoxIndex + 1} (${Math.abs(Math.round(pit.distToBoxM))} m)`
                    : `Pit Lane Active`}
            </span>
            <span className="lc-data text-[10px] text-lc-fog">
              Target <strong style={{ color: chosen.color }}>{chosen.label}</strong>
              {pit.strategy.repairDamage && pit.hasDamage ? ` · Repair ${pit.damagePct}%` : ""}
              {pit.speedingPenaltyCount > 0 ? ` · Speeding penalties: ${pit.speedingPenaltyCount}` : ""}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // On track with manual pit limiter toggled or Box Requested
  if (pit.limiterActive || pit.strategy.boxRequested) {
    return (
      <div className="pointer-events-none fixed top-20 left-1/2 z-30 flex items-center gap-2 -translate-x-1/2">
        {pit.limiterActive ? (
          <div className={`rounded-full border border-lc-info/80 px-3.5 py-1 text-[11px] font-black text-lc-info uppercase ${HUD_GLASS}`}>
            Pit Limiter · {pit.speedLimitKmh} km/h
            {pitLimiterKey && pitLimiterKey !== "—" ? ` (${pitLimiterKey})` : ""}
          </div>
        ) : null}
        {pit.strategy.boxRequested ? (
          <div className={`rounded-full border border-lc-caution/80 px-3.5 py-1 text-[11px] font-black text-lc-caution uppercase ${HUD_GLASS}`}>
            Box This Lap · Bay #{pit.assignedBoxIndex + 1} · {chosen.label}
          </div>
        ) : null}
      </div>
    );
  }

  return null;
};
