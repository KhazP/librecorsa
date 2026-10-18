"use client";

import React, { useMemo } from "react";
import type { CarTelemetry } from "@/types/f1";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";
import { HUD_CYAN, HUD_RED, HUD_VOLT } from "./hud/hud-format";

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

  return (
    <div className="hud-panel f1-corner-tr flex w-[284px] flex-col gap-2 rounded-lg p-3 text-[#F5F7FA] select-none">
      {/* LibreCorsa Circuit Map Header */}
      <div className="flex items-start justify-between border-b border-[#262B3D] pb-1.5">
        <div className="min-w-0 pr-2">
          <div className="truncate font-f1-italic text-[14px] leading-none tracking-wider text-[#F5F7FA] uppercase">
            {trackInfo.name}
          </div>
          <p className="mt-1 font-f1-mono text-[9px] font-bold tracking-wide text-[#8E96AA] uppercase">
            {trackInfo.country} · {(track.totalLengthM / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
          </p>
        </div>
        <span className="shrink-0 rounded-sm bg-[#CCFF00] px-1.5 py-0.5 font-f1-display text-[8px] font-black tracking-wider text-[#08090D] uppercase">
          GPS
        </span>
      </div>

      {/* 2D SVG Circuit Map with LibreCorsa Sector Colors (S1 Monza Rosso, S2 Slipstream Cyan, S3 Corsa Volt) */}
      <div className="relative h-[156px] w-full overflow-hidden rounded border border-[#262B3D] bg-[#08090D]">
        <svg viewBox="0 0 280 200" className="h-full w-full">
          {/* Track Outline Shadow */}
          <path
            d={`${svgData.s1} ${svgData.s2} ${svgData.s3}`}
            fill="none"
            stroke="#1B1F2B"
            strokeWidth="7.5"
            strokeLinecap="round"
          />
          {/* Sector 1: Monza Rosso (#FF2A3C) */}
          <path
            d={svgData.s1}
            fill="none"
            stroke={HUD_RED}
            strokeWidth="3.6"
            strokeLinecap="round"
          />
          {/* Sector 2: Slipstream Cyan (#00E5FF) */}
          <path
            d={svgData.s2}
            fill="none"
            stroke={HUD_CYAN}
            strokeWidth="3.6"
            strokeLinecap="round"
          />
          {/* Sector 3: Corsa Volt (#CCFF00) */}
          <path
            d={svgData.s3}
            fill="none"
            stroke={HUD_VOLT}
            strokeWidth="3.6"
            strokeLinecap="round"
          />

          {/* Start/Finish Line Marker */}
          <line
            x1={startFinishPoint.x}
            y1={startFinishPoint.y - 6}
            x2={startFinishPoint.x}
            y2={startFinishPoint.y + 6}
            stroke="#F5F7FA"
            strokeWidth="2.5"
          />

          {/* Interactive Turn Number Nodes */}
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
                  r="6.2"
                  fill={isCurrent ? HUD_VOLT : "#11131A"}
                  stroke={isCurrent ? "#08090D" : "#8E96AA"}
                  strokeWidth="1.4"
                />
                <text
                  x={tp.x}
                  y={tp.y + 2.5}
                  textAnchor="middle"
                  fill={isCurrent ? "#08090D" : "#F5F7FA"}
                  fontSize="6.8"
                  fontWeight="800"
                >
                  {tp.number}
                </text>
              </g>
            );
          })}

          {/* Opponent / Multiplayer Peer GPS Transponder Dots */}
          {(telemetry.peers ?? []).map((peer) => {
            const pSample = track.getSampleAtDistance(peer.trackDistanceM);
            const pSvg = carPoint(pSample.position.x, pSample.position.z);
            return (
              <g key={peer.peerId}>
                <circle
                  cx={pSvg.x}
                  cy={pSvg.y}
                  r="4.6"
                  fill={peer.teamColorHex}
                  stroke="#08090D"
                  strokeWidth="1.4"
                />
                <text
                  x={pSvg.x}
                  y={pSvg.y - 6.5}
                  textAnchor="middle"
                  fill={peer.teamColorHex}
                  fontSize="6.2"
                  fontWeight="800"
                >
                  {peer.driverCode}
                </text>
              </g>
            );
          })}

          {/* Live Player Car GPS Transponder Dot (Corsa Volt with dark core) */}
          <circle
            cx={carSvg.x}
            cy={carSvg.y}
            r="6.5"
            fill={HUD_VOLT}
            stroke="#08090D"
            strokeWidth="2"
          />
        </svg>

        {/* Sector Legend */}
        <div className="absolute right-2 bottom-1.5 left-2 flex items-center justify-between font-f1-mono text-[8.5px] font-bold text-[#8E96AA]">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: HUD_RED }} />
            SECTOR 1
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: HUD_CYAN }} />
            SECTOR 2
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-[1px]" style={{ backgroundColor: HUD_VOLT }} />
            SECTOR 3
          </span>
        </div>
      </div>

      {/* Elevation Profile Telemetry */}
      <div className="rounded border border-[#262B3D] bg-[#08090D] p-2">
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className="font-f1-mono text-[9px] font-bold tracking-wider text-[#8E96AA] uppercase">
            ELEVATION PROFILE
          </span>
          <span className="font-f1-mono text-[11px] font-bold text-[#F5F7FA]">
            {telemetry.trackElevationM >= 0 ? "+" : ""}
            {telemetry.trackElevationM.toFixed(1)}m
            <span className="ml-1 text-[9px] font-medium text-[#8E96AA]">Δ {elevation.span}m</span>
          </span>
        </div>
        <div className="mb-1 flex items-center justify-between font-f1-mono text-[8px] font-bold text-[#8E96AA]">
          <span>ALT {telemetry.altitudeM.toFixed(0)} M</span>
          <span>
            GRADE {telemetry.slopePercent >= 0 ? "+" : ""}
            {telemetry.slopePercent.toFixed(1)}%
          </span>
        </div>
        <svg viewBox="0 0 252 44" className="h-10 w-full overflow-visible">
          <defs>
            <linearGradient id="lcElevGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={HUD_RED} stopOpacity="0.38" />
              <stop offset="50%" stopColor={HUD_CYAN} stopOpacity="0.38" />
              <stop offset="100%" stopColor={HUD_VOLT} stopOpacity="0.38" />
            </linearGradient>
          </defs>
          <path d={elevationAreaPath} fill="url(#lcElevGrad)" />
          <path
            d={elevationPath}
            fill="none"
            stroke="#F5F7FA"
            strokeWidth="1.5"
          />
          <text x="4" y="13" fill="#8E96AA" fontSize="6.5" fontWeight="700">
            {elevation.sfLabel}
          </text>
          <text x={Math.min(elevation.low.x, 222)} y="41" fill="#8E96AA" fontSize="6.5" fontWeight="700">
            {elevation.low.label}
          </text>
          <text x={Math.min(Math.max(elevation.high.x - 12, 40), 222)} y="9" fill={HUD_VOLT} fontSize="6.5" fontWeight="700">
            {elevation.high.label}
          </text>
          <circle
            cx={elevProgressX}
            cy={elevProgressY}
            r="3.8"
            fill={HUD_VOLT}
            stroke="#08090D"
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </div>
  );
};
