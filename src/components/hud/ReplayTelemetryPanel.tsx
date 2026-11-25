"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { ReplayCarState } from "@/lib/sim/lap-types";
import type { ReplayCarOption, ReplayCarTelemetrySnapshot } from "@/lib/drive-session";
import { Select } from "@/components/ui/Select";
import { HUD_LBL } from "./hud-format";

export interface ReplayTelemetryPanelProps {
  timeS: number;
  cars: readonly ReplayCarOption[];
  focusedCarId: string;
  compareCarId: string | null;
  focusTelemetry: ReplayCarTelemetrySnapshot | null;
  compareTelemetry: ReplayCarTelemetrySnapshot | null;
  onSelectCompareCar: (carId: string | null) => void;
  sampleSeries?: (carId: string, fromS: number, toS: number, maxPoints?: number) => ReplayCarState[];
}

const TRACE_W = 280;
const TRACE_H = 68;

function buildPath(samples: readonly ReplayCarState[], accessor: (s: ReplayCarState) => number, maxVal: number): string {
  if (samples.length < 2) return "";
  const denom = Math.max(1, samples.length - 1);
  return samples
    .map((s, idx) => {
      const x = (idx / denom) * TRACE_W;
      const y = TRACE_H - Math.min(1, Math.max(0, accessor(s) / maxVal)) * (TRACE_H - 8) - 4;
      return `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export const ReplayTelemetryPanel: React.FC<ReplayTelemetryPanelProps> = ({
  timeS,
  cars,
  focusedCarId,
  compareCarId,
  focusTelemetry,
  compareTelemetry,
  onSelectCompareCar,
  sampleSeries,
}) => {
  const tx = useTranslations("hud.replayBar.studio");
  const focusCar = cars.find((c) => c.id === focusedCarId) ?? cars[0] ?? null;
  const compareCar = compareCarId ? cars.find((c) => c.id === compareCarId) ?? null : null;

  const compareOptions = useMemo(() => {
    const opts = [{ id: "", label: tx("noCompare") }];
    for (const c of cars) {
      if (c.id !== focusedCarId) opts.push({ id: c.id, label: c.label });
    }
    return opts;
  }, [cars, focusedCarId, tx]);

  // Sample 15s window quantized to 0.5s steps to avoid recomputing SVG paths on every animation frame
  const windowEnd = Math.floor(timeS * 2) / 2;
  const { focusPath, comparePath } = useMemo(() => {
    if (!sampleSeries || !focusCar) return { focusPath: "", comparePath: "" };
    const fromS = Math.max(0, windowEnd - 15);
    const fSamples = sampleSeries(focusCar.id, fromS, windowEnd, 90);
    const cSamples = compareCar ? sampleSeries(compareCar.id, fromS, windowEnd, 90) : [];
    const maxSpeed = Math.max(
      120,
      ...fSamples.map((s) => s.speedKmh),
      ...cSamples.map((s) => s.speedKmh)
    );
    return {
      focusPath: buildPath(fSamples, (s) => s.speedKmh, maxSpeed),
      comparePath: buildPath(cSamples, (s) => s.speedKmh, maxSpeed),
    };
  }, [sampleSeries, focusCar, compareCar, windowEnd]);

  if (!focusTelemetry) return null;

  const speedDelta =
    compareTelemetry !== null ? focusTelemetry.speedKmh - compareTelemetry.speedKmh : null;

  return (
    <div className="w-[320px] rounded-lc-tile border border-white/10 bg-lc-void/88 p-3 shadow-lc-pop backdrop-blur-md">
      <div className="flex items-center justify-between gap-2 border-b border-lc-line pb-2">
        <div className="flex items-center gap-2">
          {focusCar ? (
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: focusCar.color }}
            />
          ) : null}
          <span className="lc-disp text-[13px] font-bold italic text-lc-chalk">
            {focusCar?.label ?? focusTelemetry.id}
          </span>
          {focusTelemetry.position ? (
            <span className="lc-mono rounded-lc-nub bg-lc-titanium px-1.5 py-0.5 text-[11px] font-bold text-lc-volt">
              P{focusTelemetry.position}
            </span>
          ) : null}
          {focusTelemetry.lap !== undefined ? (
            <span className="lc-mono text-[11px] text-lc-slate">
              {tx("lap")} {focusTelemetry.lap}
            </span>
          ) : null}
        </div>
        {cars.length > 1 ? (
          <div className="w-[126px]">
            <Select
              aria-label={tx("compareDriver")}
              className="h-8 w-[126px] text-[12px]"
              value={compareCarId ?? ""}
              options={compareOptions}
              onChange={(v) => onSelectCompareCar(v || null)}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <div className="rounded-lc-row border border-lc-line bg-lc-well px-2.5 py-1.5">
          <div className={HUD_LBL}>{tx("speed")}</div>
          <div className="lc-mono text-[15px] font-bold text-lc-chalk">
            {Math.round(focusTelemetry.speedKmh)} <span className="text-[11px] text-lc-slate">km/h</span>
          </div>
        </div>
        <div className="rounded-lc-row border border-lc-line bg-lc-well px-2.5 py-1.5">
          <div className={HUD_LBL}>{tx("gear")}</div>
          <div className="lc-mono text-[15px] font-bold text-lc-volt">
            {focusTelemetry.gear === 0 ? "N" : focusTelemetry.gear < 0 ? "R" : focusTelemetry.gear}
          </div>
        </div>
        <div className="rounded-lc-row border border-lc-line bg-lc-well px-2.5 py-1.5">
          <div className={HUD_LBL}>{tx("rpm")}</div>
          <div className="lc-mono text-[15px] font-bold text-lc-chalk">
            {Math.round(focusTelemetry.rpm)}
          </div>
        </div>
      </div>

      <div className="mt-2.5 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={`${HUD_LBL} w-16 shrink-0`}>{tx("throttle")}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-lc-titanium">
            <div
              className="h-full transition-[width] duration-75"
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, focusTelemetry.throttle)) * 100)}%`,
                backgroundColor: "var(--lc-sem-throttle, var(--color-lc-gain))",
              }}
            />
          </div>
          <span className="lc-mono w-9 text-right text-[11px] text-lc-fog">
            {Math.round(focusTelemetry.throttle * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`${HUD_LBL} w-16 shrink-0`}>{tx("brake")}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-lc-titanium">
            <div
              className="h-full transition-[width] duration-75"
              style={{
                width: `${Math.round(Math.min(1, Math.max(0, focusTelemetry.brake)) * 100)}%`,
                backgroundColor: "var(--lc-sem-brake, var(--color-lc-loss))",
              }}
            />
          </div>
          <span className="lc-mono w-9 text-right text-[11px] text-lc-fog">
            {Math.round(focusTelemetry.brake * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`${HUD_LBL} w-16 shrink-0`}>{tx("steer")}</span>
          <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-lc-titanium">
            <div
              className="absolute top-0 h-full w-2 -translate-x-1/2 rounded-full bg-lc-chalk"
              style={{
                left: `${50 + Math.max(-1, Math.min(1, focusTelemetry.steer)) * 45}%`,
              }}
            />
          </div>
          <span className="lc-mono w-9 text-right text-[11px] text-lc-fog">
            {Math.round(focusTelemetry.steer * 100)}%
          </span>
        </div>
      </div>

      {compareTelemetry && compareCar ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2 border-t border-lc-line pt-2">
          <div className="rounded-lc-row border border-lc-line bg-lc-well px-2.5 py-1.5">
            <div className={HUD_LBL}>{tx("distance")}</div>
            <div className="lc-mono text-[13px] font-bold text-lc-cyan">
              {focusTelemetry.distanceToCompareM !== null && focusTelemetry.distanceToCompareM !== undefined
                ? `${focusTelemetry.distanceToCompareM.toFixed(1)} m`
                : "—"}
            </div>
          </div>
          <div className="rounded-lc-row border border-lc-line bg-lc-well px-2.5 py-1.5">
            <div className={HUD_LBL}>{tx("speedDelta")}</div>
            <div
              className={`lc-mono text-[13px] font-bold ${
                (speedDelta ?? 0) >= 0 ? "text-lc-gain" : "text-lc-loss"
              }`}
            >
              {speedDelta !== null ? `${speedDelta >= 0 ? "+" : ""}${Math.round(speedDelta)} km/h` : "—"}
            </div>
          </div>
        </div>
      ) : null}

      {focusPath ? (
        <div className="mt-2.5 border-t border-lc-line pt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className={HUD_LBL}>{tx("traceWindow")}</span>
            {compareCar ? (
              <span className="lc-mono text-[10px] text-lc-cyan">vs {compareCar.label}</span>
            ) : null}
          </div>
          <svg
            viewBox={`0 0 ${TRACE_W} ${TRACE_H}`}
            className="h-[68px] w-full rounded-lc-row border border-lc-line bg-lc-well"
            aria-label={tx("traceWindow")}
          >
            {comparePath ? (
              <path
                d={comparePath}
                fill="none"
                stroke={compareCar?.color ?? "var(--color-lc-cyan)"}
                strokeWidth="1.5"
                strokeDasharray="3 2"
                opacity="0.85"
              />
            ) : null}
            <path d={focusPath} fill="none" stroke="var(--color-lc-volt)" strokeWidth="2" />
          </svg>
        </div>
      ) : null}
    </div>
  );
};
