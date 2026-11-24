"use client";

import React, { useMemo, useState } from "react";
import { analyzeLaps, type AnalysisPoint } from "@/lib/sim/lap-analysis";
import type { LapRecording } from "@/lib/sim/lap-types";
import { Card, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { formatDelta, formatLapTime } from "./hud-format";

export interface AcTelemetryAnalysisProps {
  laps: readonly LapRecording[];
  bestLap?: LapRecording | null;
  latestLap?: LapRecording | null;
}

const W = 720;
const H = 84;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 10;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

function buildPath(
  points: readonly AnalysisPoint[],
  getY: (p: AnalysisPoint) => number,
  minY: number,
  maxY: number,
): string {
  if (points.length === 0) return "";
  const span = maxY - minY || 1;
  return points
    .map((p, i) => {
      const x = PAD_L + p.progress * PLOT_W;
      const y = PAD_T + (1 - (getY(p) - minY) / span) * PLOT_H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${Math.max(PAD_T, Math.min(PAD_T + PLOT_H, y)).toFixed(1)}`;
    })
    .join(" ");
}

interface ChannelChartProps {
  title: string;
  unit: string;
  points: readonly AnalysisPoint[];
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  minY: number;
  maxY: number;
  ticks: readonly number[];
  bestVal: (p: AnalysisPoint) => number;
  latestVal: (p: AnalysisPoint) => number;
  bestColor?: string;
  latestColor?: string;
  zeroLine?: boolean;
  formatVal?: (v: number) => string;
}

const ChannelChart: React.FC<ChannelChartProps> = ({
  title,
  unit,
  points,
  hoverIdx,
  onHoverIdx,
  minY,
  maxY,
  ticks,
  bestVal,
  latestVal,
  bestColor = "#CCFF00",
  latestColor = "#38BDF8",
  zeroLine = false,
  formatVal = (v) => v.toFixed(0),
}) => {
  const bestPath = useMemo(() => buildPath(points, bestVal, minY, maxY), [points, bestVal, minY, maxY]);
  const latestPath = useMemo(() => buildPath(points, latestVal, minY, maxY), [points, latestVal, minY, maxY]);
  const span = maxY - minY || 1;
  const zeroY = PAD_T + (1 - (0 - minY) / span) * PLOT_H;
  const cursorPt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorX = cursorPt ? PAD_L + cursorPt.progress * PLOT_W : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const norm = Math.max(0, Math.min(1, (relX * W - PAD_L) / PLOT_W));
    onHoverIdx(Math.round(norm * (points.length - 1)));
  };

  return (
    <div className="border-b border-white/10 bg-[#050608] last:border-b-0">
      <div className="flex items-center justify-between border-b border-white/5 px-2.5 py-1 text-[11px]">
        <span className="font-semibold tracking-wide text-lc-chalk">
          {title} <span className="text-lc-slate">[{unit}]</span>
        </span>
        {cursorPt ? (
          <div className="lc-mono flex items-center gap-3 text-[11px]">
            <span style={{ color: bestColor }}>Best: {formatVal(bestVal(cursorPt))}</span>
            <span style={{ color: latestColor }}>Latest: {formatVal(latestVal(cursorPt))}</span>
          </div>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[84px] w-full cursor-crosshair select-none"
        onMouseMove={handleMove}
        onMouseLeave={() => onHoverIdx(null)}
      >
        {ticks.map((t) => {
          const y = PAD_T + (1 - (t - minY) / span) * PLOT_H;
          return (
            <g key={t}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
              <text x={PAD_L - 4} y={y + 3} textAnchor="end" fill="rgba(255,255,255,0.45)" fontSize="9" fontFamily="monospace">
                {t}
              </text>
            </g>
          );
        })}
        {[0.333, 0.667].map((sec) => {
          const sx = PAD_L + sec * PLOT_W;
          return <line key={sec} x1={sx} y1={PAD_T} x2={sx} y2={PAD_T + PLOT_H} stroke="rgba(255,255,255,0.14)" strokeWidth="1" />;
        })}
        {zeroLine && zeroY >= PAD_T && zeroY <= PAD_T + PLOT_H ? (
          <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="rgba(255,255,255,0.22)" strokeWidth="1" />
        ) : null}
        {/* Best lap: dashed ("crossed") line */}
        <path d={bestPath} fill="none" stroke={bestColor} strokeWidth="1.6" strokeDasharray="6 4" opacity="0.92" />
        {/* Latest lap: solid (full) line */}
        <path d={latestPath} fill="none" stroke={latestColor} strokeWidth="1.6" opacity="0.95" />
        {cursorX !== null ? (
          <line x1={cursorX} y1={PAD_T} x2={cursorX} y2={PAD_T + PLOT_H} stroke="#FFFFFF" strokeWidth="1" opacity="0.65" />
        ) : null}
      </svg>
    </div>
  );
};

export const AcTelemetryAnalysis: React.FC<AcTelemetryAnalysisProps> = ({
  laps,
  bestLap: allTimeBestProp,
  latestLap: latestProp,
}) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { bestLap, latestLap } = useMemo(() => {
    const sessionBest = laps.length > 0 ? laps.reduce((a, b) => (b.lapTimeMs < a.lapTimeMs ? b : a), laps[0]) : null;
    const best =
      allTimeBestProp && (!sessionBest || allTimeBestProp.lapTimeMs <= sessionBest.lapTimeMs)
        ? allTimeBestProp
        : sessionBest ?? allTimeBestProp ?? null;
    const latest = latestProp ?? laps[0] ?? best;
    return { bestLap: best, latestLap: latest };
  }, [laps, allTimeBestProp, latestProp]);

  const analysis = useMemo(
    () => (bestLap && latestLap ? analyzeLaps(bestLap, latestLap) : null),
    [bestLap, latestLap],
  );

  const mapData = useMemo(() => {
    if (!analysis || analysis.points.length < 2) return null;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of analysis.points) {
      minX = Math.min(minX, p.refX, p.cmpX);
      maxX = Math.max(maxX, p.refX, p.cmpX);
      minZ = Math.min(minZ, p.refZ, p.cmpZ);
      maxZ = Math.max(maxZ, p.refZ, p.cmpZ);
    }
    const dx = Math.max(1, maxX - minX);
    const dz = Math.max(1, maxZ - minZ);
    const pad = 12;
    const vbW = 200;
    const innerW = vbW - pad * 2;
    const innerH = Math.max(76, Math.min(180, Math.round((dz / dx) * innerW)));
    const vbH = innerH + pad * 2;
    const scale = Math.min(innerW / dx, innerH / dz);
    const offX = pad + (innerW - dx * scale) / 2;
    const offY = pad + (innerH - dz * scale) / 2;
    const proj = (x: number, z: number) => ({
      x: offX + (x - minX) * scale,
      y: offY + (z - minZ) * scale,
    });

    const bestLine = analysis.points
      .map((p, i) => {
        const pt = proj(p.refX, p.refZ);
        return `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      })
      .join(" ");

    const segDeltas = analysis.points.map((p, i) => (i === 0 ? 0 : p.deltaS - analysis.points[i - 1].deltaS));
    const minSegDelta = Math.min(...segDeltas);
    const segments: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
    for (let i = 1; i < analysis.points.length; i++) {
      const a = proj(analysis.points[i - 1].cmpX, analysis.points[i - 1].cmpZ);
      const b = proj(analysis.points[i].cmpX, analysis.points[i].cmpZ);
      const d = segDeltas[i];
      let color = "#94A3B8"; // grey: same
      if (d < -0.002 && d <= minSegDelta * 0.65 && minSegDelta < -0.008) color = "#A855F7"; // purple: fastest
      else if (d < -0.002) color = "#22C55E"; // green: faster
      else if (d > 0.002) color = "#EF4444"; // red: slower
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
    }

    const startPt = proj(analysis.points[0].cmpX, analysis.points[0].cmpZ);
    return { vbW, vbH, bestLine, segments, startPt, proj };
  }, [analysis]);

  if (!analysis || !bestLap || !latestLap) return null;

  const points = analysis.points;
  const maxSpeed = Math.max(120, Math.ceil(Math.max(...points.map((p) => Math.max(p.refSpeedKmh, p.cmpSpeedKmh))) / 50) * 50);
  const maxDelta = Math.max(0.5, ...points.map((p) => Math.abs(p.deltaS)));
  const activePt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorMap = activePt && mapData ? mapData.proj(activePt.cmpX, activePt.cmpZ) : null;

  return (
    <Card
      title="Telemetry Analysis"
      description="All-time best lap (dashed) vs Latest lap (solid) · Hover any channel to inspect"
      action={
        <div className="lc-mono flex flex-wrap items-center gap-3 text-[12px]">
          <span className="flex items-center gap-1.5 text-lc-volt">
            <span className="inline-block w-4 border-t-2 border-dashed border-lc-volt" />
            All-Time Best: {formatLapTime(bestLap.lapTimeMs)}
          </span>
          <span className="flex items-center gap-1.5 text-sky-400">
            <span className="inline-block w-4 border-t-2 border-solid border-sky-400" />
            Latest: {formatLapTime(latestLap.lapTimeMs)}
          </span>
          <Badge tone={analysis.totalDeltaMs <= 0 ? "good" : "warn"}>
            {formatDelta(analysis.totalDeltaMs / 1000)}s
          </Badge>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
        {/* Assetto Corsa / MoTeC-style stacked channels */}
        <div className="overflow-hidden rounded border border-white/15 bg-[#050608]">
          <ChannelChart
            title="Brake"
            unit="%"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            bestVal={(p) => p.refBrake * 100}
            latestVal={(p) => p.cmpBrake * 100}
            bestColor="#F87171"
            latestColor="#EF4444"
          />
          <ChannelChart
            title="Speed"
            unit="km/h"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={maxSpeed}
            ticks={[0, Math.round(maxSpeed / 2), maxSpeed]}
            bestVal={(p) => p.refSpeedKmh}
            latestVal={(p) => p.cmpSpeedKmh}
            bestColor="#CCFF00"
            latestColor="#38BDF8"
          />
          <ChannelChart
            title="Throttle"
            unit="%"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            bestVal={(p) => p.refThrottle * 100}
            latestVal={(p) => p.cmpThrottle * 100}
            bestColor="#4ADE80"
            latestColor="#22C55E"
          />
          <ChannelChart
            title="Gear"
            unit="#"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={1}
            maxY={8}
            ticks={[2, 4, 6, 8]}
            bestVal={(p) => p.refGear}
            latestVal={(p) => p.cmpGear}
            bestColor="#FACC15"
            latestColor="#38BDF8"
          />
          <ChannelChart
            title="Steering"
            unit="%"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-100}
            maxY={100}
            ticks={[-100, 0, 100]}
            bestVal={(p) => p.refSteer * 100}
            latestVal={(p) => p.cmpSteer * 100}
            bestColor="#C084FC"
            latestColor="#E879F9"
            zeroLine
          />
          <ChannelChart
            title="Time Lost / Delta"
            unit="s"
            points={points}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-maxDelta}
            maxY={maxDelta}
            ticks={[Number((-maxDelta).toFixed(1)), 0, Number(maxDelta.toFixed(1))]}
            bestVal={() => 0}
            latestVal={(p) => p.deltaS}
            bestColor="#94A3B8"
            latestColor="#22C55E"
            zeroLine
            formatVal={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
          />
          <div className="flex justify-between border-t border-white/10 px-2.5 py-1 text-[10px] text-lc-slate lc-mono">
            <span>0 m</span>
            <span>S1 ({Math.round(analysis.trackLengthM * 0.333)} m)</span>
            <span>S2 ({Math.round(analysis.trackLengthM * 0.667)} m)</span>
            <span>{Math.round(analysis.trackLengthM)} m</span>
          </div>
        </div>

        {/* Right column: Track line + Sectors + Key observations */}
        <div className="flex flex-col gap-2.5">
          {mapData ? (
            <Well className="p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-lc-fog">
                <span>Driving Line</span>
                <span className="lc-mono text-[10px] text-lc-slate">S/F ■</span>
              </div>
              <svg viewBox={`0 0 ${mapData.vbW} ${mapData.vbH}`} className="block w-full">
                <path d={mapData.bestLine} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2.5" strokeDasharray="4 3" />
                {mapData.segments.map((seg, i) => (
                  <line
                    key={i}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    stroke={seg.color}
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                ))}
                <rect x={mapData.startPt.x - 3} y={mapData.startPt.y - 3} width="6" height="6" fill="#FFFFFF" stroke="#000" strokeWidth="1" />
                {cursorMap ? <circle cx={cursorMap.x} cy={cursorMap.y} r="4.5" fill="#FFFFFF" stroke="#000" strokeWidth="1.5" /> : null}
              </svg>
              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-white/5 pt-1.5 text-[10px] text-lc-fog">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-purple-500" />Fastest</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Faster</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-400" />Same</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />Slower</span>
              </div>
            </Well>
          ) : null}

          <Well className="flex flex-col gap-1.5 p-2.5">
            <div className="text-[11px] font-semibold text-lc-fog">Sectors</div>
            {analysis.sectors.map((sec) => (
              <div key={sec.sector} className="lc-mono flex items-center justify-between text-[11px]">
                <span className="text-lc-slate">S{sec.sector}</span>
                <span className="text-lc-chalk">{(sec.cmpMs / 1000).toFixed(3)}s</span>
                <span className={sec.deltaMs <= 0 ? "text-emerald-400" : "text-amber-400"}>
                  {sec.deltaMs >= 0 ? "+" : ""}
                  {(sec.deltaMs / 1000).toFixed(3)}s
                </span>
              </div>
            ))}
          </Well>

          {analysis.insights.length > 0 ? (
            <Well className="flex flex-col gap-1.5 p-2.5">
              <div className="text-[11px] font-semibold text-lc-fog">Insights</div>
              {analysis.insights.slice(0, 3).map((ins) => (
                <div key={ins.id} className="text-[11px] leading-snug text-lc-fog">
                  <span className="font-semibold text-lc-chalk">{ins.title}: </span>
                  {ins.detail}
                </div>
              ))}
            </Well>
          ) : null}
        </div>
      </div>
    </Card>
  );
};
