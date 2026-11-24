"use client";

import React, { useMemo, useState } from "react";
import { Button, Card, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { analyzeLaps, type AnalysisPoint } from "@/lib/sim/lap-analysis";
import type { LapRecording } from "@/lib/sim/lap-types";
import type { TurnMetadata } from "@/types/f1";

export interface LapAnalysisModalProps {
  laps: readonly LapRecording[];
  turns?: readonly TurnMetadata[];
  trackName: string;
  onClose: () => void;
}

function formatMs(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.floor(abs / 60_000);
  const secs = Math.floor((abs % 60_000) / 1000);
  const millis = Math.round(abs % 1000);
  const prefix = mins > 0 ? `${mins}:${String(secs).padStart(2, "0")}` : `${secs}`;
  return `${prefix}.${String(millis).padStart(3, "0")}`;
}

function formatDeltaMs(ms: number): string {
  const sign = ms > 0 ? "+" : ms < 0 ? "-" : "";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)} s`;
}

export const LapAnalysisModal: React.FC<LapAnalysisModalProps> = ({
  laps,
  turns = [],
  trackName,
  onClose,
}) => {
  const [refIdx, setRefIdx] = useState(0);
  const [cmpIdx, setCmpIdx] = useState(laps.length > 1 ? 1 : 0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const refLap = laps[refIdx] ?? laps[0];
  const cmpLap = laps[cmpIdx] ?? laps[0];

  const analysis = useMemo(
    () =>
      refLap && cmpLap
        ? analyzeLaps(refLap, cmpLap, turns, {
            refLabel: `Lap ${refIdx + 1} (${formatMs(refLap.lapTimeMs)})`,
            cmpLabel: `Lap ${cmpIdx + 1} (${formatMs(cmpLap.lapTimeMs)})`,
          })
        : null,
    [refLap, cmpLap, refIdx, cmpIdx, turns],
  );

  if (!analysis) return null;

  const activePt: AnalysisPoint =
    hoverIdx !== null && analysis.points[hoverIdx]
      ? analysis.points[hoverIdx]
      : analysis.points[0];

  const maxSpeed = Math.max(
    100,
    ...analysis.points.map((p) => Math.max(p.refSpeedKmh, p.cmpSpeedKmh)),
  );
  const maxAbsDelta = Math.max(
    0.2,
    ...analysis.points.map((p) => Math.abs(p.deltaS)),
  );

  // Track map bounds
  const xs = analysis.points.map((p) => p.refX);
  const zs = analysis.points.map((p) => p.refZ);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const span = Math.max(1, maxX - minX, maxZ - minZ);
  const mapX = (x: number) => 12 + ((x - minX) / span) * 196;
  const mapY = (z: number) => 12 + ((z - minZ) / span) * 196;

  const buildPolyline = (
    getter: (p: AnalysisPoint) => number,
    minVal: number,
    maxVal: number,
    w = 640,
    h = 72,
  ) => {
    const range = Math.max(1e-4, maxVal - minVal);
    return analysis.points
      .map((p, i) => {
        const x = (i / Math.max(1, analysis.points.length - 1)) * w;
        const y = h - 4 - ((getter(p) - minVal) / range) * (h - 8);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const handleChartMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
    setHoverIdx(Math.round(frac * (analysis.points.length - 1)));
  };

  const cursorX =
    hoverIdx !== null ? (hoverIdx / Math.max(1, analysis.points.length - 1)) * 640 : 0;

  return (
    <div className="lc-ui-zoom pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-lc-void/75 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Advanced Lap Analysis"
        className="lc-glass flex max-h-full w-full max-w-[1120px] flex-col gap-3.5 overflow-y-auto rounded-lc-sheet p-5 text-lc-chalk shadow-lc-sheet"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-lc-line pb-3">
          <div className="flex flex-col gap-0.5">
            <h2 className="lc-h2 text-lc-chalk">Advanced Lap Analysis</h2>
            <span className="lc-hint">{trackName}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Reference lap"
              value={refIdx}
              onChange={(e) => setRefIdx(Number(e.target.value))}
              className="rounded-lc-nub border border-lc-line bg-lc-carbon px-2.5 py-1.5 text-[12px] font-semibold text-lc-volt"
            >
              {laps.map((l, i) => (
                <option key={i} value={i}>
                  Ref: Lap {i + 1} · {formatMs(l.lapTimeMs)}
                </option>
              ))}
            </select>
            <span className="lc-hint text-[12px]">vs</span>
            <select
              aria-label="Comparison lap"
              value={cmpIdx}
              onChange={(e) => setCmpIdx(Number(e.target.value))}
              className="rounded-lc-nub border border-lc-line bg-lc-carbon px-2.5 py-1.5 text-[12px] font-semibold text-lc-info"
            >
              {laps.map((l, i) => (
                <option key={i} value={i}>
                  Cmp: Lap {i + 1} · {formatMs(l.lapTimeMs)}
                </option>
              ))}
            </select>
            <Badge tone={analysis.totalDeltaMs <= 0 ? "good" : "warn"}>
              {formatDeltaMs(analysis.totalDeltaMs)}
            </Badge>
            <Button variant="ghost" size="sm" icon={<Icon name="close" />} onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {/* Sector Deltas + Live Cursor Readout */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {analysis.sectors.map((s) => (
            <Well key={s.sector} className="flex flex-col gap-0.5 px-3 py-2">
              <span className="lc-lbl">Sector {s.sector}</span>
              <span
                className={`lc-mono text-[16px] font-bold ${
                  s.deltaMs <= 0 ? "text-lc-gain" : "text-lc-loss"
                }`}
              >
                {s.refMs > 0 && s.cmpMs > 0 ? formatDeltaMs(s.deltaMs) : "—"}
              </span>
            </Well>
          ))}
          <Well className="flex flex-col gap-0.5 px-3 py-2">
            <span className="lc-lbl">Cursor @ {Math.round(activePt.s)} m</span>
            <span
              className={`lc-mono text-[16px] font-bold ${
                activePt.deltaS <= 0 ? "text-lc-gain" : "text-lc-loss"
              }`}
            >
              {activePt.deltaS > 0 ? "+" : ""}
              {activePt.deltaS.toFixed(3)} s
            </span>
          </Well>
        </div>

        {/* Main Grid: Synchronized Telemetry Charts (left) + Track Map & Insights (right) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="flex flex-col gap-2.5 lg:col-span-8">
            <Card title="Synchronized Telemetry (Hover to Scrub)">
              <div className="flex flex-col gap-2">
                {/* Time Delta */}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="lc-lbl">Cumulative Delta (s)</span>
                  <span className="lc-mono text-lc-fog">
                    {activePt.deltaS > 0 ? "+" : ""}
                    {activePt.deltaS.toFixed(3)} s
                  </span>
                </div>
                <svg
                  viewBox="0 0 640 68"
                  className="h-16 w-full cursor-crosshair rounded bg-lc-void/60"
                  onMouseMove={handleChartMove}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <line x1="0" y1="34" x2="640" y2="34" stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                  <polyline
                    fill="none"
                    stroke="var(--color-lc-volt)"
                    strokeWidth="2"
                    points={buildPolyline((p) => p.deltaS, -maxAbsDelta, maxAbsDelta, 640, 68)}
                  />
                  {hoverIdx !== null ? (
                    <line x1={cursorX} y1="0" x2={cursorX} y2="68" stroke="#ffffff" strokeWidth="1" opacity="0.6" />
                  ) : null}
                </svg>

                {/* Speed */}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="lc-lbl">Speed (km/h)</span>
                  <span className="lc-mono">
                    <span className="text-lc-volt">{Math.round(activePt.refSpeedKmh)}</span>
                    {" vs "}
                    <span className="text-lc-info">{Math.round(activePt.cmpSpeedKmh)}</span>
                  </span>
                </div>
                <svg
                  viewBox="0 0 640 72"
                  className="h-18 w-full cursor-crosshair rounded bg-lc-void/60"
                  onMouseMove={handleChartMove}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <polyline
                    fill="none"
                    stroke="var(--color-lc-volt)"
                    strokeWidth="1.8"
                    points={buildPolyline((p) => p.refSpeedKmh, 0, maxSpeed, 640, 72)}
                  />
                  <polyline
                    fill="none"
                    stroke="var(--color-lc-info)"
                    strokeWidth="1.8"
                    points={buildPolyline((p) => p.cmpSpeedKmh, 0, maxSpeed, 640, 72)}
                  />
                  {hoverIdx !== null ? (
                    <line x1={cursorX} y1="0" x2={cursorX} y2="72" stroke="#ffffff" strokeWidth="1" opacity="0.6" />
                  ) : null}
                </svg>

                {/* Throttle & Brake */}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="lc-lbl">Throttle / Brake (%)</span>
                  <span className="lc-mono text-lc-fog">
                    THR {Math.round(activePt.cmpThrottle * 100)}% · BRK {Math.round(activePt.cmpBrake * 100)}% · G
                    {activePt.cmpGear}
                  </span>
                </div>
                <svg
                  viewBox="0 0 640 60"
                  className="h-14 w-full cursor-crosshair rounded bg-lc-void/60"
                  onMouseMove={handleChartMove}
                  onMouseLeave={() => setHoverIdx(null)}
                >
                  <polyline
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth="1.5"
                    points={buildPolyline((p) => p.cmpThrottle, 0, 1, 640, 60)}
                  />
                  <polyline
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="1.5"
                    points={buildPolyline((p) => p.cmpBrake, 0, 1, 640, 60)}
                  />
                  {hoverIdx !== null ? (
                    <line x1={cursorX} y1="0" x2={cursorX} y2="60" stroke="#ffffff" strokeWidth="1" opacity="0.6" />
                  ) : null}
                </svg>
              </div>
            </Card>
          </div>

          {/* Track Map + Actionable Insights */}
          <div className="flex flex-col gap-3 lg:col-span-4">
            <Card title="Circuit Driving Line">
              <svg viewBox="0 0 220 220" className="mx-auto h-48 w-48">
                <polyline
                  fill="none"
                  stroke="rgba(255,255,255,0.22)"
                  strokeWidth="4"
                  points={analysis.points.map((p) => `${mapX(p.refX).toFixed(1)},${mapY(p.refZ).toFixed(1)}`).join(" ")}
                />
                <circle
                  cx={mapX(activePt.cmpX)}
                  cy={mapY(activePt.cmpZ)}
                  r="5"
                  fill="var(--color-lc-volt)"
                  stroke="#000"
                  strokeWidth="1.5"
                />
              </svg>
            </Card>

            <Card title="Actionable Insights">
              {analysis.insights.length === 0 ? (
                <p className="lc-hint m-0">Laps are closely matched with no major telemetry outliers.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {analysis.insights.map((ins) => (
                    <li key={ins.id} className="rounded-lc-nub border border-lc-line bg-lc-carbon/70 px-3 py-2">
                      <div className="text-[12px] font-bold text-lc-chalk">{ins.title}</div>
                      <div className="lc-hint text-[11px] leading-snug">{ins.detail}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};
