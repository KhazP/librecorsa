"use client";

import React, { useMemo } from "react";
import type { CarTelemetry } from "@/types/f1";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { HUD_CYAN, HUD_GLASS, HUD_LBL, HUD_PINK, HUD_RED, HUD_VOLT, HUD_WELL } from "./hud/hud-format";

const SECTOR_LEGEND = [
  ["Sector 1", HUD_CYAN],
  ["Sector 2", HUD_VOLT],
  ["Sector 3", HUD_PINK],
] as const;

interface TrackMinimapProps {
  track: BuiltTrackData;
  telemetry: CarTelemetry;
  onSelectTurn: (turnNumber: number) => void;
}

export const TrackMinimap: React.FC<TrackMinimapProps> = ({
  track,
  telemetry,
  onSelectTurn,
}) => {
  const trackInfo = getTrackInfo(track.id ?? "rwanda");

  const {
    svgData,
    carPoint,
    turnPoints,
    startFinishPoint,
    elevationPath,
    elevationAreaPath,
    elevation,
  } = useMemo(() => {
    const samples = track.samples;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (const s of samples) {
      if (s.position.x < minX) minX = s.position.x;
      if (s.position.x > maxX) maxX = s.position.x;
      if (s.position.z < minZ) minZ = s.position.z;
      if (s.position.z > maxZ) maxZ = s.position.z;
    }

    const pad = 80;
    const width = maxX - minX + pad * 2;
    const height = maxZ - minZ + pad * 2;
    const viewW = 280;
    const viewH = 200;

    const toSvg = (x: number, z: number) => {
      const nx = (x - (minX - pad)) / width;
      const nz = (z - (minZ - pad)) / height;
      return {
        x: Math.round(nx * viewW * 100) / 100,
        y: Math.round(nz * viewH * 100) / 100,
      };
    };

    const s1Segs: string[] = [];
    const s2Segs: string[] = [];
    const s3Segs: string[] = [];

    for (let i = 0; i < samples.length; i += 2) {
      const s0 = samples[i];
      const s1 = samples[(i + 2) % samples.length];
      const p0 = toSvg(s0.position.x, s0.position.z);
      const p1 = toSvg(s1.position.x, s1.position.z);
      const seg = `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
      if (s0.sector === 1) s1Segs.push(seg);
      else if (s0.sector === 2) s2Segs.push(seg);
      else s3Segs.push(seg);
    }

    const sfSample = track.getSampleAtDistance(0);
    const sfPt = toSvg(sfSample.position.x, sfSample.position.z);

    const tPts = TURN_METADATA.map((tm) => {
      const idx = samples.findIndex((s) => s.turnNumber === tm.number);
      const s = idx >= 0 ? samples[idx] : track.getSampleAtDistance(tm.sApprox);
      const pt = toSvg(s.position.x, s.position.z);
      return {
        ...tm,
        x: pt.x,
        y: pt.y,
      };
    });

    const elevW = 252;
    const elevH = 44;
    let low = samples[0];
    let high = samples[0];
    for (const s of samples) {
      if (s.position.y < low.position.y) low = s;
      if (s.position.y > high.position.y) high = s;
    }
    const yMin = low.position.y;
    const ySpan = Math.max(1, high.position.y - yMin);
    const toElevY = (y: number) => elevH - ((y - yMin) / ySpan) * (elevH - 8) - 4;
    const toElevX = (s: number) => (s / track.totalLengthM) * elevW;
    const turnAt = (s: (typeof samples)[number]) => (s.turnNumber ? `T${s.turnNumber} ` : "");
    const elevPts: string[] = [];
    for (let i = 0; i < samples.length; i += 6) {
      const s = samples[i];
      const ex = toElevX(s.s);
      const ey = toElevY(s.position.y);
      elevPts.push(
        `${elevPts.length === 0 ? "M" : "L"} ${ex.toFixed(1)} ${ey.toFixed(1)}`
      );
    }
    const ePath = elevPts.join(" ");
    const eArea = `${ePath} L ${elevW} ${elevH} L 0 ${elevH} Z`;

    return {
      svgData: {
        s1: s1Segs.join(" "),
        s2: s2Segs.join(" "),
        s3: s3Segs.join(" "),
      },
      carPoint: toSvg,
      turnPoints: tPts,
      startFinishPoint: sfPt,
      elevationPath: ePath,
      elevationAreaPath: eArea,
      elevation: {
        toY: toElevY,
        span: Math.round(ySpan),
        sfLabel: `S/F ${Math.round(samples[0].position.y - yMin)}m`,
        low: { x: toElevX(low.s), label: `${turnAt(low)}+0m` },
        high: { x: toElevX(high.s), label: `${turnAt(high)}+${Math.round(ySpan)}m` },
      },
    };
  }, [track]);

  const currentSample = track.getSampleAtDistance(telemetry.trackDistanceM);
  const carSvg = carPoint(currentSample.position.x, currentSample.position.z);
  const elevProgressX = (telemetry.trackDistanceM / track.totalLengthM) * 252;
  const elevProgressY = elevation.toY(telemetry.trackElevationM);

  // Elevation extremes, in lap order for the label row under the profile
  const lowFirst = elevation.low.x <= elevation.high.x;
  const lowMark = <span className={`${HUD_LBL} !text-[8px]`}>{elevation.low.label}</span>;
  const highMark = (
    <span className={`${HUD_LBL} !text-[8px]`} style={{ color: HUD_VOLT }}>
      {elevation.high.label}
    </span>
  );

  return (
    <section
      aria-label="Circuit map"
      className={`flex w-[290px] flex-col rounded-[22px] p-3.5 text-[#F5F7FA] select-none ${HUD_GLASS}`}
    >
      {/* Circuit name, country, length and turns */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="lc-title truncate text-[14px] leading-tight">{trackInfo.name}</div>
          <p className={`${HUD_LBL} mt-0.5`}>
            {trackInfo.country} · {(track.totalLengthM / 1000).toFixed(2)} km · {TURN_METADATA.length} turns
          </p>
        </div>
        <span className="lc-data shrink-0 rounded-full bg-[#CCFF00] px-[7px] py-0.5 text-[9px] text-[#08090D]">GPS</span>
      </div>

      {/* Circuit map: sector 1 cyan, sector 2 volt, sector 3 pink */}
      <svg viewBox="0 0 280 200" className="mt-2 block h-[150px] w-full" role="img" aria-label={`Circuit map${telemetry.currentTurnNumber ? `; you are at turn ${telemetry.currentTurnNumber}` : ""}`}>
        {/* Track ribbon */}
        <path
          d={`${svgData.s1} ${svgData.s2} ${svgData.s3}`}
          fill="none"
          stroke="#1B1F2B"
          strokeWidth="11"
          strokeLinecap="round"
        />
        <path d={svgData.s1} fill="none" stroke={HUD_CYAN} strokeWidth="3.6" strokeLinecap="round" />
        <path d={svgData.s2} fill="none" stroke={HUD_VOLT} strokeWidth="3.6" strokeLinecap="round" />
        <path d={svgData.s3} fill="none" stroke={HUD_PINK} strokeWidth="3.6" strokeLinecap="round" />

        {/* Start / finish line */}
        <line
          x1={startFinishPoint.x}
          y1={startFinishPoint.y - 7}
          x2={startFinishPoint.x}
          y2={startFinishPoint.y + 7}
          stroke="#F5F7FA"
          strokeWidth="3"
        />

        {/* Turn numbers: click to jump there */}
        {turnPoints.map((tp) => {
          const isCurrent = telemetry.currentTurnNumber === tp.number;
          return (
            <g
              key={tp.number}
              className="cursor-pointer opacity-95 hover:opacity-100"
              onClick={() => onSelectTurn(tp.number)}
            >
              <circle
                cx={tp.x}
                cy={tp.y}
                r={isCurrent ? 7.4 : 6.4}
                fill={isCurrent ? HUD_VOLT : "#11131A"}
                stroke={isCurrent ? "#08090D" : "#5B6275"}
                strokeWidth={isCurrent ? 1.4 : 1}
              />
              <text
                x={tp.x}
                y={tp.y + 2.4}
                textAnchor="middle"
                fill={isCurrent ? "#08090D" : "#F5F7FA"}
                fontSize="6.6"
                fontWeight="800"
                fontFamily="var(--font-jetbrains), ui-monospace, monospace"
              >
                {tp.number}
              </text>
            </g>
          );
        })}

        {/* Opponents and multiplayer peers */}
        {(telemetry.peers ?? []).map((peer) => {
          const pSample = track.getSampleAtDistance(peer.trackDistanceM);
          const pSvg = carPoint(pSample.position.x, pSample.position.z);
          return (
            <g key={peer.peerId}>
              <circle cx={pSvg.x} cy={pSvg.y} r="4.6" fill={peer.teamColorHex} stroke="#08090D" strokeWidth="1.4" />
              <text
                x={pSvg.x}
                y={pSvg.y - 6.5}
                textAnchor="middle"
                fill={peer.teamColorHex}
                fontSize="6.2"
                fontWeight="800"
                fontFamily="var(--font-jetbrains), ui-monospace, monospace"
              >
                {peer.driverCode}
              </text>
            </g>
          );
        })}

        {/* You */}
        <circle cx={carSvg.x} cy={carSvg.y} r="6" fill={HUD_VOLT} stroke="#08090D" strokeWidth="2.4" />
      </svg>

      {/* Sector legend */}
      <div className="mt-1.5 flex gap-3">
        {SECTOR_LEGEND.map(([label, color]) => (
          <span key={label} className={`${HUD_LBL} inline-flex items-center gap-[5px]`}>
            <span className="h-2 w-2 rounded-[3px]" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>

      {/* Elevation profile */}
      <div className={`mt-2.5 rounded-[14px] p-2.5 ${HUD_WELL}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={HUD_LBL}>Elevation profile</span>
          <span className="lc-data text-[12px] text-[#F5F7FA]">
            {telemetry.trackElevationM >= 0 ? "+" : ""}
            {telemetry.trackElevationM.toFixed(1)}m
            <span className="ml-1 text-[#8E96AA]">Δ {elevation.span}m</span>
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between">
          <span className={`${HUD_LBL} !text-[8px]`}>ALT {telemetry.altitudeM.toFixed(0)} M</span>
          <span className={`${HUD_LBL} !text-[8px]`}>
            GRADE {telemetry.slopePercent >= 0 ? "+" : ""}
            {telemetry.slopePercent.toFixed(1)}%
          </span>
        </div>
        <svg viewBox="0 0 252 44" className="mt-1.5 block h-11 w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="lcElevGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={HUD_RED} stopOpacity="0.38" />
              <stop offset="50%" stopColor={HUD_CYAN} stopOpacity="0.38" />
              <stop offset="100%" stopColor={HUD_VOLT} stopOpacity="0.38" />
            </linearGradient>
          </defs>
          <path d={elevationAreaPath} fill="url(#lcElevGrad)" />
          <path d={elevationPath} fill="none" stroke="#F5F7FA" strokeWidth="1.5" />
          <circle cx={elevProgressX} cy={elevProgressY} r="4" fill={HUD_VOLT} />
        </svg>
        <div className="mt-0.5 flex items-center justify-between">
          <span className={`${HUD_LBL} !text-[8px]`}>{elevation.sfLabel}</span>
          {lowFirst ? lowMark : highMark}
          {lowFirst ? highMark : lowMark}
        </div>
      </div>
    </section>
  );
};
