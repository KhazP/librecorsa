"use client";

/**
 * The lap board's Analysis view: two laps of this car on this circuit compared channel by channel (brake, speed,
 * throttle, gear, steering and the time gap), with the driving line coloured by where time went, the sector splits and
 * a few notes on the corners. The reference lap is dashed, the compared one solid.
 */
import React, { useMemo, useState } from "react";
import { useTranslations } from "use-intl/react";
import { analyzeLaps, type AnalysisPoint, type LapInsight } from "@/lib/sim/lap-analysis";
import type { LapRecording } from "@/lib/sim/lap-types";
import { useUnits } from "@/lib/settings/ui-prefs";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import type { TurnMetadata } from "@/types/f1";
import { Card, EmptyState, Select, Well } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { formatDelta, formatLapTime, HUD_BORDER, HUD_GAIN, HUD_INFO, HUD_LOSS, HUD_PURPLE, HUD_SLATE, HUD_VOLT, HUD_WHITE } from "./hud-format";

export interface LapTelemetryAnalysisProps {
  /** This car's personal best on this circuit, on the board being driven */
  best: LapRecording | null;
  /** The last lap finished here with this car, kept across visits */
  latest: LapRecording | null;
  /** This visit's laps, newest first */
  session: readonly LapRecording[];
  /** The circuit's corners, for the notes on apex speed and braking points */
  turns?: readonly TurnMetadata[];
}

/** The reference lap's lines, and the compared lap's */
const REF_COLOR = HUD_VOLT;
const CMP_COLOR = HUD_INFO;

const W = 720;
const H = 84;
const PAD_L = 38;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 10;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

interface LapChoice {
  id: string;
  label: string;
  lap: LapRecording;
}

const lapKey = (l: LapRecording) => `${l.recordedAt}:${l.lapTimeMs}`;

function buildPath(points: readonly AnalysisPoint[], getY: (p: AnalysisPoint) => number, minY: number, maxY: number): string {
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
  points: readonly AnalysisPoint[];
  /** Where the sector lines go, as shares of the lap */
  sectorMarks: readonly number[];
  hoverIdx: number | null;
  onHoverIdx: (idx: number | null) => void;
  minY: number;
  maxY: number;
  ticks: readonly number[];
  refVal: (p: AnalysisPoint) => number;
  cmpVal: (p: AnalysisPoint) => number;
  /** The time gap has no reference line, only zero */
  noRef?: boolean;
  zeroLine?: boolean;
  formatVal?: (v: number) => string;
}

const ChannelChart: React.FC<ChannelChartProps> = ({
  title,
  points,
  sectorMarks,
  hoverIdx,
  onHoverIdx,
  minY,
  maxY,
  ticks,
  refVal,
  cmpVal,
  noRef = false,
  zeroLine = false,
  formatVal = (v) => v.toFixed(0),
}) => {
  const refPath = useMemo(() => (noRef ? "" : buildPath(points, refVal, minY, maxY)), [noRef, points, refVal, minY, maxY]);
  const cmpPath = useMemo(() => buildPath(points, cmpVal, minY, maxY), [points, cmpVal, minY, maxY]);
  const span = maxY - minY || 1;
  const zeroY = PAD_T + (1 - (0 - minY) / span) * PLOT_H;
  const cursorPt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorX = cursorPt ? PAD_L + cursorPt.progress * PLOT_W : null;

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const norm = Math.max(0, Math.min(1, (relX * W - PAD_L) / PLOT_W));
    onHoverIdx(Math.round(norm * (points.length - 1)));
  };

  return (
    <div className="border-b border-lc-line last:border-b-0">
      <div className="flex items-center justify-between px-2.5 py-1 text-[11px]">
        <span className="font-semibold text-lc-chalk">{title}</span>
        {cursorPt ? (
          <span className="lc-data flex items-center gap-3">
            {noRef ? null : <span style={{ color: REF_COLOR }}>{formatVal(refVal(cursorPt))}</span>}
            <span style={{ color: CMP_COLOR }}>{formatVal(cmpVal(cursorPt))}</span>
          </span>
        ) : null}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-[84px] w-full cursor-crosshair touch-none select-none"
        onPointerMove={handleMove}
        onPointerDown={handleMove}
        onPointerLeave={() => onHoverIdx(null)}
        aria-hidden
      >
        {ticks.map((t) => {
          const y = PAD_T + (1 - (t - minY) / span) * PLOT_H;
          return (
            <g key={t}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke={HUD_BORDER} strokeWidth="1" />
              <text x={PAD_L - 4} y={y + 3} textAnchor="end" fill={HUD_SLATE} fontSize="9" className="lc-data">
                {t}
              </text>
            </g>
          );
        })}
        {sectorMarks.map((m) => {
          const sx = PAD_L + m * PLOT_W;
          return <line key={m} x1={sx} y1={PAD_T} x2={sx} y2={PAD_T + PLOT_H} stroke={HUD_SLATE} strokeWidth="1" opacity="0.6" />;
        })}
        {zeroLine && zeroY >= PAD_T && zeroY <= PAD_T + PLOT_H ? (
          <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke={HUD_SLATE} strokeWidth="1" />
        ) : null}
        {noRef ? null : <path d={refPath} fill="none" stroke={REF_COLOR} strokeWidth="1.6" strokeDasharray="6 4" opacity="0.92" />}
        <path d={cmpPath} fill="none" stroke={CMP_COLOR} strokeWidth="1.6" />
        {cursorX !== null ? <line x1={cursorX} y1={PAD_T} x2={cursorX} y2={PAD_T + PLOT_H} stroke={HUD_WHITE} strokeWidth="1" opacity="0.65" /> : null}
      </svg>
    </div>
  );
};

export const LapTelemetryAnalysis: React.FC<LapTelemetryAnalysisProps> = ({ best, latest, session, turns = [] }) => {
  const tx = useTranslations("hud.lapAnalysis");
  const units = useUnits();
  const speedUnit = SPEED_LABEL[units.speed];
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // The laps to pick from: the best, the latest, then this visit's others, each once
  const choices = useMemo(() => {
    const out: LapChoice[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string, lap: LapRecording | null) => {
      if (!lap || seen.has(lapKey(lap))) return;
      seen.add(lapKey(lap));
      out.push({ id, label, lap });
    };
    add("best", tx("lapBest", { time: formatLapTime(best?.lapTimeMs) }), best);
    add("latest", tx("lapLatest", { time: formatLapTime(latest?.lapTimeMs) }), latest);
    session.forEach((lap, i) => add(`lap-${lapKey(lap)}`, tx("lapNumber", { lap: session.length - i, time: formatLapTime(lap.lapTimeMs) }), lap));
    return out;
  }, [best, latest, session, tx]);

  const [refPick, setRefPick] = useState<string | null>(null);
  const [cmpPick, setCmpPick] = useState<string | null>(null);
  const ref = choices.find((c) => c.id === refPick) ?? choices[0] ?? null;
  const cmp = choices.find((c) => c.id === cmpPick) ?? choices.find((c) => c !== ref) ?? null;

  const analysis = useMemo(() => (ref && cmp ? analyzeLaps(ref.lap, cmp.lap, turns) : null), [ref, cmp, turns]);

  const mapData = useMemo(() => {
    if (!analysis || analysis.points.length < 2) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
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
    const proj = (x: number, z: number) => ({ x: offX + (x - minX) * scale, y: offY + (z - minZ) * scale });

    const refLine = analysis.points
      .map((p, i) => {
        const pt = proj(p.refX, p.refZ);
        return `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
      })
      .join(" ");

    // Each stretch of the compared lap by the time it gained (purple: among its biggest gains) or lost there
    const stretch = analysis.points.map((p, i) => (i === 0 ? 0 : p.deltaS - analysis.points[i - 1].deltaS));
    const biggestGain = Math.min(...stretch);
    const segments: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
    for (let i = 1; i < analysis.points.length; i++) {
      const a = proj(analysis.points[i - 1].cmpX, analysis.points[i - 1].cmpZ);
      const b = proj(analysis.points[i].cmpX, analysis.points[i].cmpZ);
      const d = stretch[i];
      let color = HUD_SLATE;
      if (d < -0.002 && d <= biggestGain * 0.65 && biggestGain < -0.008) color = HUD_PURPLE;
      else if (d < -0.002) color = HUD_GAIN;
      else if (d > 0.002) color = HUD_LOSS;
      segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color });
    }
    return { vbW, vbH, refLine, segments, startPt: proj(analysis.points[0].cmpX, analysis.points[0].cmpZ), proj };
  }, [analysis]);

  if (choices.length < 2 || !ref || !cmp || !analysis) {
    return (
      <EmptyState icon={<Icon name="lapTimes" />}>{choices.length === 0 ? tx("emptyNoLaps") : tx("emptyOneLap")}</EmptyState>
    );
  }

  const options = choices.map((c) => ({ id: c.id, label: c.label }));
  const points = analysis.points;
  const speedOf = (kmh: number) => speedIn(kmh, units.speed);
  const peak = Math.max(...points.map((p) => Math.max(p.refSpeedKmh, p.cmpSpeedKmh)));
  const maxSpeed = Math.max(100, Math.ceil(speedOf(peak) / 50) * 50);
  const maxDelta = Math.max(0.5, ...points.map((p) => Math.abs(p.deltaS)));
  const sectorMarks = analysis.sectorEndsM.map((s) => s / analysis.trackLengthM);
  const activePt = hoverIdx !== null ? points[hoverIdx] : null;
  const cursorMap = activePt && mapData ? mapData.proj(activePt.cmpX, activePt.cmpZ) : null;
  const turnName = (t: TurnMetadata) => (t.name ? tx("turnNamed", { turn: t.number, name: t.name }) : tx("turn", { turn: t.number }));
  const insightText = (ins: LapInsight): string => {
    switch (ins.kind) {
      case "sector":
        return tx(ins.deltaMs > 0 ? "noteSectorLost" : "noteSectorGained", { sector: ins.sector, time: (Math.abs(ins.deltaMs) / 1000).toFixed(2) });
      case "apexSpeed":
        return tx(ins.diffKmh > 0 ? "noteApexMore" : "noteApexLess", {
          turn: turnName(ins.turn),
          speed: Math.round(Math.abs(speedOf(ins.diffKmh))),
          unit: speedUnit,
        });
      case "brakePoint":
        return tx(ins.diffM > 0 ? "noteBrakeLater" : "noteBrakeEarlier", { turn: turnName(ins.turn), distance: Math.round(Math.abs(ins.diffM)) });
    }
  };
  // A braking point is neither good nor bad on its own: only the time and the apex speed are
  const insightClass = (ins: LapInsight): string =>
    ins.kind === "brakePoint" ? "text-lc-fog" : (ins.kind === "sector" ? ins.deltaMs <= 0 : ins.diffKmh > 0) ? "text-lc-gain" : "text-lc-loss";

  return (
    <Card
      title={tx("title")}
      description={tx("description")}
      action={
        <Badge tone={analysis.totalDeltaMs <= 0 ? "good" : "warn"}>{formatDelta(analysis.totalDeltaMs / 1000)}</Badge>
      }
    >
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: REF_COLOR }} aria-hidden />
        <Select aria-label={tx("reference")} className="w-60 max-w-full" value={ref.id} onChange={setRefPick} options={options} />
        <span className="lc-hint">{tx("versus")}</span>
        <span className="inline-block w-4 border-t-2" style={{ borderColor: CMP_COLOR }} aria-hidden />
        <Select aria-label={tx("compared")} className="w-60 max-w-full" value={cmp.id} onChange={setCmpPick} options={options} />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
        <div className="overflow-hidden rounded-lc-row border border-lc-line bg-lc-void/60">
          <ChannelChart
            title={tx("brake")}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            refVal={(p) => p.refBrake * 100}
            cmpVal={(p) => p.cmpBrake * 100}
            formatVal={(v) => tx("percent", { value: Math.round(v) })}
          />
          <ChannelChart
            title={tx("speed", { unit: speedUnit })}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={maxSpeed}
            ticks={[0, Math.round(maxSpeed / 2), maxSpeed]}
            refVal={(p) => speedOf(p.refSpeedKmh)}
            cmpVal={(p) => speedOf(p.cmpSpeedKmh)}
          />
          <ChannelChart
            title={tx("throttle")}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={0}
            maxY={100}
            ticks={[0, 50, 100]}
            refVal={(p) => p.refThrottle * 100}
            cmpVal={(p) => p.cmpThrottle * 100}
            formatVal={(v) => tx("percent", { value: Math.round(v) })}
          />
          <ChannelChart
            title={tx("gear")}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={1}
            maxY={8}
            ticks={[2, 4, 6, 8]}
            refVal={(p) => p.refGear}
            cmpVal={(p) => p.cmpGear}
          />
          <ChannelChart
            title={tx("steering")}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-100}
            maxY={100}
            ticks={[-100, 0, 100]}
            refVal={(p) => p.refSteer * 100}
            cmpVal={(p) => p.cmpSteer * 100}
            zeroLine
            formatVal={(v) => tx("percent", { value: Math.round(v) })}
          />
          <ChannelChart
            title={tx("gap")}
            points={points}
            sectorMarks={sectorMarks}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
            minY={-maxDelta}
            maxY={maxDelta}
            ticks={[Number((-maxDelta).toFixed(1)), 0, Number(maxDelta.toFixed(1))]}
            refVal={() => 0}
            cmpVal={(p) => p.deltaS}
            noRef
            zeroLine
            formatVal={(v) => formatDelta(v)}
          />
          <div className="lc-data flex justify-between border-t border-lc-line px-2.5 py-1 text-[10px] text-lc-slate">
            <span>{tx("distance", { m: 0 })}</span>
            {analysis.sectorEndsM.map((s, i) => (
              <span key={i}>{tx("sectorEnd", { sector: i + 1, m: Math.round(s) })}</span>
            ))}
            <span>{tx("distance", { m: Math.round(analysis.trackLengthM) })}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {mapData ? (
            <Well className="p-2.5">
              <div className="mb-1.5 text-[11px] font-semibold text-lc-fog">{tx("drivingLine")}</div>
              <svg viewBox={`0 0 ${mapData.vbW} ${mapData.vbH}`} className="block w-full" aria-hidden>
                <path d={mapData.refLine} fill="none" stroke={HUD_SLATE} strokeWidth="2.5" strokeDasharray="4 3" />
                {mapData.segments.map((seg, i) => (
                  <line key={i} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke={seg.color} strokeWidth="3" strokeLinecap="round" />
                ))}
                <rect x={mapData.startPt.x - 3} y={mapData.startPt.y - 3} width="6" height="6" fill={HUD_WHITE} />
                {cursorMap ? <circle cx={cursorMap.x} cy={cursorMap.y} r="4.5" fill={HUD_WHITE} /> : null}
              </svg>
              <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-lc-line pt-1.5 text-[10px] text-lc-fog">
                {(
                  [
                    [HUD_PURPLE, "legendMostGained"],
                    [HUD_GAIN, "legendGained"],
                    [HUD_SLATE, "legendEven"],
                    [HUD_LOSS, "legendLost"],
                  ] as const
                ).map(([color, key]) => (
                  <span key={key} className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                    {tx(key)}
                  </span>
                ))}
              </div>
            </Well>
          ) : null}

          <Well className="flex flex-col gap-1.5 p-2.5">
            <div className="text-[11px] font-semibold text-lc-fog">{tx("sectors")}</div>
            {analysis.sectors.map((sec) => (
              <div key={sec.sector} className="lc-data flex items-center justify-between text-[11px]">
                <span className="text-lc-slate">{tx("sectorShort", { sector: sec.sector })}</span>
                <span className="text-lc-chalk">{sec.cmpMs > 0 ? formatLapTime(sec.cmpMs) : "—"}</span>
                <span className={sec.deltaMs <= 0 ? "text-lc-gain" : "text-lc-loss"}>
                  {sec.refMs > 0 && sec.cmpMs > 0 ? formatDelta(sec.deltaMs / 1000) : "—"}
                </span>
              </div>
            ))}
          </Well>

          {analysis.insights.length > 0 ? (
            <Well className="flex flex-col gap-1.5 p-2.5">
              <div className="text-[11px] font-semibold text-lc-fog">{tx("notes")}</div>
              {analysis.insights.map((ins, i) => (
                <div key={i} className={`text-[11px] leading-snug ${insightClass(ins)}`}>
                  {insightText(ins)}
                </div>
              ))}
            </Well>
          ) : null}
        </div>
      </div>
    </Card>
  );
};
