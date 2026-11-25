"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useTranslations } from "use-intl/react";
import {
  analyzeLaps,
  buildLapChoices,
  type AnalysisPoint,
  type LapChoice,
  type LapInsight,
  type SessionLapEntry,
} from "@/lib/sim/lap-analysis";
import type { LapRecording } from "@/lib/sim/lap-types";
import type { TurnMetadata } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import { HEIGHT_LABEL, SPEED_LABEL, heightIn, speedIn } from "@/lib/settings/units";
import { Card, Select, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import {
  HUD_BEST,
  HUD_BORDER,
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_GAIN,
  HUD_INFO,
  HUD_LOSS,
  HUD_PINK,
  HUD_SLATE,
  HUD_THROTTLE,
  HUD_VOID,
  HUD_VOLT,
  HUD_WHITE,
  formatDelta,
  formatLapTime,
  formatSectorTime,
} from "./hud-format";

export interface LapTelemetryViewProps {
  sessionLaps?: readonly SessionLapEntry[];
  bestLap?: LapRecording | null;
  latestLap?: LapRecording | null;
  turns?: readonly TurnMetadata[];
  sectorSplitsM?: readonly [number, number] | null;
  /** Wrap inside a Card (for the Lap times Analysis tab); false inside a Modal */
  embedded?: boolean;
}

const W = 720;
const H = 84;
const PAD_L = 42;
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
  sectorFractions: readonly [number, number];
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  minY: number;
  maxY: number;
  ticks: readonly number[];
  refLabel: string;
  cmpLabel: string;
  refVal: (p: AnalysisPoint) => number;
  cmpVal: (p: AnalysisPoint) => number;
  refColor: string;
  cmpColor: string;
  zeroLine?: boolean;
  formatVal?: (v: number) => string;
}

const ChannelChart: React.FC<ChannelChartProps> = ({
  title,
  unit,
  points,
  sectorFractions,
  hoverIdx,
  onHoverIdx,
  minY,
  maxY,
  ticks,
  refLabel,
  cmpLabel,
  refVal,
  cmpVal,
  refColor,
  cmpColor,
  zeroLine = false,
  formatVal = (v) => v.toFixed(0),
}) => {
  const refPath = useMemo(() => buildPath(points, refVal, minY, maxY), [points, refVal, minY, maxY]);
  const cmpPath = useMemo(() => buildPath(points, cmpVal, minY, maxY), [points, cmpVal, minY, maxY]);
  const span = maxY - minY || 1;
  const zeroY = PAD_T + (1 - (0 - minY) / span) * PLOT_H;
  const cursorPt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorX = cursorPt ? PAD_L + cursorPt.progress * PLOT_W : null;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length < 2) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const norm = Math.max(0, Math.min(1, (relX * W - PAD_L) / PLOT_W));
    onHoverIdx(Math.round(norm * (points.length - 1)));
  };

  return (
    <div className="border-b border-lc-line bg-lc-well last:border-b-0">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 px-2.5 py-1 text-[11px]">
        <span className="font-semibold tracking-wide text-lc-chalk">
          {title} <span className="text-lc-slate">[{unit}]</span>
        </span>
        {cursorPt ? (
          <div className="lc-mono flex items-center gap-3 text-[11px]">
            <span style={{ color: refColor }}>
              {refLabel}: {formatVal(refVal(cursorPt))}
            </span>
            <span style={{ color: cmpColor }}>
              {cmpLabel}: {formatVal(cmpVal(cursorPt))}
            </span>
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
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={HUD_BORDER} strokeOpacity="0.55" strokeWidth="1" />
              <text
                x={PAD_L - 5}
                y={y + 3.5}
                textAnchor="end"
                fill={HUD_SLATE}
                fontSize="11"
                fontFamily="var(--font-lc-mono)"
              >
                {t}
              </text>
            </g>
          );
        })}
        {sectorFractions.map((frac, idx) => {
          const sx = PAD_L + frac * PLOT_W;
          return (
            <line
              key={idx}
              x1={sx}
              y1={PAD_T}
              x2={sx}
              y2={PAD_T + PLOT_H}
              stroke={HUD_SLATE}
              strokeOpacity="0.35"
              strokeWidth="1"
            />
          );
        })}
        {zeroLine && zeroY >= PAD_T && zeroY <= PAD_T + PLOT_H ? (
          <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke={HUD_SLATE} strokeOpacity="0.45" strokeWidth="1" />
        ) : null}
        <path d={refPath} fill="none" stroke={refColor} strokeWidth="1.6" strokeDasharray="6 4" strokeOpacity="0.92" />
        <path d={cmpPath} fill="none" stroke={cmpColor} strokeWidth="1.6" strokeOpacity="0.95" />
        {cursorX !== null ? (
          <line x1={cursorX} y1={PAD_T} x2={cursorX} y2={PAD_T + PLOT_H} stroke={HUD_WHITE} strokeOpacity="0.65" strokeWidth="1" />
        ) : null}
      </svg>
    </div>
  );
};

export const LapTelemetryView: React.FC<LapTelemetryViewProps> = ({
  sessionLaps,
  bestLap = null,
  latestLap = null,
  turns = [],
  sectorSplitsM = null,
  embedded = true,
}) => {
  const tx = useTranslations("hud.lapTelemetry");
  const units = useUnits();
  const speedUnitLabel = SPEED_LABEL[units.speed];
  const distUnitLabel = HEIGHT_LABEL[units.speed];

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { choices, defaultRefId, defaultCmpId } = useMemo(
    () => buildLapChoices({ sessionLaps, allTimeBest: bestLap, latestLap }),
    [sessionLaps, bestLap, latestLap],
  );

  const [pickedRefId, setPickedRefId] = useState<string | null>(defaultRefId);
  const [pickedCmpId, setPickedCmpId] = useState<string | null>(defaultCmpId);

  // Follow fresh defaults whenever the available set of laps changes (e.g. a new lap completed or car switched)
  useEffect(() => {
    setPickedRefId(defaultRefId);
    setPickedCmpId(defaultCmpId);
    setHoverIdx(null);
  }, [defaultRefId, defaultCmpId]);

  const refChoice = choices.find((c) => c.id === pickedRefId) ?? choices.find((c) => c.id === defaultRefId) ?? choices[0] ?? null;
  const cmpChoice = choices.find((c) => c.id === pickedCmpId) ?? choices.find((c) => c.id === defaultCmpId) ?? choices[0] ?? null;

  const analysis = useMemo(
    () =>
      refChoice && cmpChoice
        ? analyzeLaps(refChoice.recording, cmpChoice.recording, turns, { sectorSplitsM })
        : null,
    [refChoice, cmpChoice, turns, sectorSplitsM],
  );

  const mapData = useMemo(() => {
    if (!analysis || analysis.points.length < 2) return null;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
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

    const refLine = analysis.points
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
      let color = HUD_SLATE;
      if (d < -0.002 && d <= minSegDelta * 0.65 && minSegDelta < -0.008) color = HUD_BEST;
      else if (d < -0.002) color = HUD_GAIN;
      else if (d > 0.002) color = HUD_LOSS;
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
    }

    const startPt = proj(analysis.points[0].cmpX, analysis.points[0].cmpZ);
    return { vbW, vbH, refLine, segments, startPt, proj };
  }, [analysis]);

  const choiceLabel = (c: LapChoice): string => {
    const base =
      c.kind === "best"
        ? tx("allTimeBest")
        : c.kind === "latest"
          ? tx("latestLap")
          : tx("sessionLap", { lap: c.lapNumber ?? 1 });
    return c.valid ? base : `${base} · ${tx("invalidTag")}`;
  };

  const formatDist = (metres: number): string => `${Math.round(heightIn(metres, units.speed))} ${distUnitLabel}`;

  const renderInsight = (ins: LapInsight): { title: string; detail: string } => {
    if (ins.kind === "sector") {
      const seconds = Math.abs(ins.deltaS).toFixed(2);
      return ins.tone === "loss"
        ? {
            title: tx("insight.sectorLossTitle", { sector: ins.sector }),
            detail: tx("insight.sectorLossDetail", { sector: ins.sector, seconds }),
          }
        : {
            title: tx("insight.sectorGainTitle", { sector: ins.sector }),
            detail: tx("insight.sectorGainDetail", { sector: ins.sector, seconds }),
          };
    }
    if (ins.kind === "apex") {
      const speedVal = Math.max(1, Math.round(speedIn(Math.abs(ins.speedDiffKmh), units.speed)));
      const title = ins.turnName
        ? tx("insight.apexNamedTitle", { turn: ins.turnNumber, name: ins.turnName })
        : tx("insight.apexTitle", { turn: ins.turnNumber });
      const detail =
        ins.speedDiffKmh > 0
          ? tx("insight.apexFasterDetail", { turn: ins.turnNumber, speed: speedVal, unit: speedUnitLabel })
          : tx("insight.apexSlowerDetail", { turn: ins.turnNumber, speed: speedVal, unit: speedUnitLabel });
      return { title, detail };
    }
    const distVal = Math.max(1, Math.round(heightIn(Math.abs(ins.diffM), units.speed)));
    const title = ins.turnName
      ? tx("insight.brakeNamedTitle", { turn: ins.turnNumber, name: ins.turnName })
      : tx("insight.brakeTitle", { turn: ins.turnNumber });
    const detail =
      ins.diffM < 0
        ? tx("insight.brakeEarlierDetail", { turn: ins.turnNumber, distance: distVal, unit: distUnitLabel })
        : tx("insight.brakeLaterDetail", { turn: ins.turnNumber, distance: distVal, unit: distUnitLabel });
    return { title, detail };
  };

  if (!analysis || !refChoice || !cmpChoice || analysis.points.length === 0) return null;

  const points = analysis.points;
  const maxSpeedDisplay = Math.max(
    80,
    Math.ceil(
      Math.max(...points.map((p) => Math.max(speedIn(p.refSpeedKmh, units.speed), speedIn(p.cmpSpeedKmh, units.speed)))) /
        50,
    ) * 50,
  );
  const maxDelta = Math.max(0.5, ...points.map((p) => Math.abs(p.deltaS)));
  const activePt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorMap = activePt && mapData ? mapData.proj(activePt.cmpX, activePt.cmpZ) : null;

  const selectOptions = choices.map((c) => ({
    id: c.id,
    label: `${choiceLabel(c)} · ${formatLapTime(c.recording.lapTimeMs)}`,
  }));

  const headerControls = (
    <div className="lc-mono flex flex-wrap items-center gap-2.5 text-[12px]">
      {choices.length > 1 ? (
        <>
          <Select
            aria-label={tx("reference")}
            className="w-52 max-w-full"
            value={refChoice.id}
            onChange={setPickedRefId}
            options={selectOptions}
          />
          <Select
            aria-label={tx("compared")}
            className="w-52 max-w-full"
            value={cmpChoice.id}
            onChange={setPickedCmpId}
            options={selectOptions}
          />
        </>
      ) : (
        <span className="flex items-center gap-1.5 text-lc-volt">
          <span className="inline-block w-4 border-t-2 border-dashed border-lc-volt" />
          {choiceLabel(refChoice)}: {formatLapTime(refChoice.recording.lapTimeMs)}
        </span>
      )}
      <Badge tone={analysis.totalDeltaMs <= 0 ? "good" : "warn"}>
        {formatDelta(analysis.totalDeltaMs / 1000)} {tx("units.seconds")}
      </Badge>
    </div>
  );

  const legendStrip = (
    <div className="lc-mono flex flex-wrap items-center justify-between gap-2 text-[11px] text-lc-fog">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-lc-volt">
          <span className="inline-block w-4 border-t-2 border-dashed border-lc-volt" />
          {tx("reference")}: {formatLapTime(refChoice.recording.lapTimeMs)}
        </span>
        <span className="flex items-center gap-1.5 text-lc-info">
          <span className="inline-block w-4 border-t-2 border-solid border-lc-info" />
          {tx("compared")}: {formatLapTime(cmpChoice.recording.lapTimeMs)}
        </span>
      </div>
      {activePt ? (
        <span className="text-lc-chalk">
          {tx("cursorAt", { distance: formatDist(activePt.s) })} · {formatDelta(activePt.deltaS)}{" "}
          {tx("units.seconds")}
        </span>
      ) : null}
    </div>
  );

  const body = (
    <div className="flex flex-col gap-3">
      {!embedded ? <div className="flex flex-wrap items-center justify-between gap-2">{headerControls}</div> : null}
      {legendStrip}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_224px]">
        {/* Synchronized stacked telemetry channels */}
        <div className="overflow-hidden rounded-lc-row border border-lc-line bg-lc-well">
          <ChannelChart
            title={tx("channels.brake")}
            unit={tx("units.percent")}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={(p) => p.refBrake * 100}
            cmpVal={(p) => p.cmpBrake * 100}
            refColor={HUD_CAUTION}
            cmpColor={HUD_BRAKE}
          />
          <ChannelChart
            title={tx("channels.speed")}
            unit={speedUnitLabel}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={maxSpeedDisplay}
            ticks={[0, Math.round(maxSpeedDisplay / 2), maxSpeedDisplay]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={(p) => speedIn(p.refSpeedKmh, units.speed)}
            cmpVal={(p) => speedIn(p.cmpSpeedKmh, units.speed)}
            refColor={HUD_VOLT}
            cmpColor={HUD_INFO}
          />
          <ChannelChart
            title={tx("channels.throttle")}
            unit={tx("units.percent")}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={(p) => p.refThrottle * 100}
            cmpVal={(p) => p.cmpThrottle * 100}
            refColor={HUD_VOLT}
            cmpColor={HUD_THROTTLE}
          />
          <ChannelChart
            title={tx("channels.gear")}
            unit={tx("units.gear")}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={1}
            maxY={8}
            ticks={[2, 4, 6, 8]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={(p) => p.refGear}
            cmpVal={(p) => p.cmpGear}
            refColor={HUD_CAUTION}
            cmpColor={HUD_INFO}
          />
          <ChannelChart
            title={tx("channels.steering")}
            unit={tx("units.percent")}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-100}
            maxY={100}
            ticks={[-100, 0, 100]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={(p) => p.refSteer * 100}
            cmpVal={(p) => p.cmpSteer * 100}
            refColor={HUD_BEST}
            cmpColor={HUD_PINK}
            zeroLine
          />
          <ChannelChart
            title={tx("channels.delta")}
            unit={tx("units.seconds")}
            points={points}
            sectorFractions={analysis.sectorFractions}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-maxDelta}
            maxY={maxDelta}
            ticks={[Number((-maxDelta).toFixed(1)), 0, Number(maxDelta.toFixed(1))]}
            refLabel={tx("reference")}
            cmpLabel={tx("compared")}
            refVal={() => 0}
            cmpVal={(p) => p.deltaS}
            refColor={HUD_SLATE}
            cmpColor={HUD_GAIN}
            zeroLine
            formatVal={(v) => formatDelta(v)}
          />
          <div className="lc-mono flex justify-between gap-2 border-t border-lc-line px-2.5 py-1 text-[11px] text-lc-slate">
            <span>{formatDist(0)}</span>
            <span>{tx("sectorSplit", { sector: 1, distance: formatDist(analysis.sectorSplitsM[0]) })}</span>
            <span>{tx("sectorSplit", { sector: 2, distance: formatDist(analysis.sectorSplitsM[1]) })}</span>
            <span>{formatDist(analysis.trackLengthM)}</span>
          </div>
        </div>

        {/* Right column: Track driving line + Sector deltas + Key observations */}
        <div className="flex flex-col gap-2.5">
          {mapData ? (
            <Well className="p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-lc-fog">
                <span>{tx("drivingLine")}</span>
                <span className="lc-mono flex items-center gap-1 text-[11px] text-lc-slate">
                  <span>{tx("startFinish")}</span>
                  <span className="inline-block size-2 border border-lc-void bg-lc-chalk" aria-hidden />
                </span>
              </div>
              <svg viewBox={`0 0 ${mapData.vbW} ${mapData.vbH}`} className="block w-full">
                <path
                  d={mapData.refLine}
                  fill="none"
                  stroke={HUD_SLATE}
                  strokeOpacity="0.45"
                  strokeWidth="2.5"
                  strokeDasharray="4 3"
                />
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
                <rect
                  x={mapData.startPt.x - 3}
                  y={mapData.startPt.y - 3}
                  width="6"
                  height="6"
                  fill={HUD_WHITE}
                  stroke={HUD_VOID}
                  strokeWidth="1"
                />
                {cursorMap ? (
                  <circle cx={cursorMap.x} cy={cursorMap.y} r="4.5" fill={HUD_WHITE} stroke={HUD_VOID} strokeWidth="1.5" />
                ) : null}
              </svg>
              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-white/5 pt-1.5 text-[11px] text-lc-fog">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-lc-best" />
                  {tx("legend.fastest")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-lc-gain" />
                  {tx("legend.faster")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-lc-slate" />
                  {tx("legend.same")}
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-lc-loss" />
                  {tx("legend.slower")}
                </span>
              </div>
            </Well>
          ) : null}

          <Well className="flex flex-col gap-1.5 p-2.5">
            <div className="text-[11px] font-semibold text-lc-fog">{tx("sectors")}</div>
            {analysis.sectors.map((sec) => {
              const hasBoth = sec.refMs > 0 && sec.cmpMs > 0;
              return (
                <div key={sec.sector} className="lc-mono flex items-center justify-between text-[11px]">
                  <span className="text-lc-slate">{tx("sectorShort", { sector: sec.sector })}</span>
                  <span className="text-lc-chalk">
                    {formatSectorTime(sec.cmpMs)} {tx("units.seconds")}
                  </span>
                  <span className={!hasBoth ? "text-lc-slate" : sec.deltaMs <= 0 ? "text-lc-gain" : "text-lc-caution"}>
                    {hasBoth ? `${formatDelta(sec.deltaMs / 1000)} ${tx("units.seconds")}` : "—"}
                  </span>
                </div>
              );
            })}
          </Well>

          <Well className="flex flex-col gap-1.5 p-2.5">
            <div className="text-[11px] font-semibold text-lc-fog">{tx("insights")}</div>
            {analysis.insights.length === 0 ? (
              <p className="m-0 text-[11px] leading-snug text-lc-slate">{tx("noInsights")}</p>
            ) : (
              analysis.insights.map((ins) => {
                const { title, detail } = renderInsight(ins);
                return (
                  <div key={ins.id} className="text-[11px] leading-snug text-lc-fog">
                    <span className="font-semibold text-lc-chalk">{title}: </span>
                    {detail}
                  </div>
                );
              })
            )}
          </Well>
        </div>
      </div>
    </div>
  );

  if (!embedded) return body;

  return (
    <Card title={tx("title")} description={tx("description")} action={headerControls}>
      {body}
    </Card>
  );
};
