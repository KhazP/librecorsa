"use client";

import React, { useMemo } from "react";
import type { CarTelemetry } from "@/types/f1";
import { type BuiltTrackData, TURN_METADATA } from "@/lib/track-data";

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

    const tPts = TURN_METADATA.map(
      (tm) => {
        const idx = samples.findIndex((s) => s.turnNumber === tm.number);
        const s = idx >= 0 ? samples[idx] : track.getSampleAtDistance(tm.sApprox);
        const pt = toSvg(s.position.x, s.position.z);
        return {
          ...tm,
          x: pt.x,
          y: pt.y,
        };
      }
    );

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
    <div className="f1-panel f1-corner-tr flex flex-col gap-2 rounded-tl-md rounded-bl-md rounded-br-md p-3 text-white w-[284px] select-none">
      {/* Official F1.com Circuit Map Header */}
      <div className="flex items-start justify-between border-b border-white/10 pb-1.5">
        <div>
          <div className="font-f1-italic text-[13px] tracking-wider text-white uppercase leading-none">
            Bugesera
          </div>
          <p className="mt-1 font-f1-mono text-[9px] font-bold tracking-wide text-zinc-400">
            {(track.totalLengthM / 1000).toFixed(2)} KM · {TURN_METADATA.length} TURNS
          </p>
        </div>
        <span className="rounded-sm bg-[#E10600] px-1.5 py-0.5 font-f1-display text-[8px] font-black uppercase tracking-wider text-white">
          Fan
        </span>
      </div>

      {/* 2D SVG Circuit Map with Official F1 Sector Colors (S1 Red, S2 Cyan, S3 Yellow) */}
      <div className="relative h-[156px] w-full overflow-hidden rounded bg-[#0B0B10] border border-white/10">
        <svg viewBox="0 0 280 200" className="h-full w-full">
          {/* Track Outline Shadow */}
          <path
            d={`${svgData.s1} ${svgData.s2} ${svgData.s3}`}
            fill="none"
            stroke="#272732"
            strokeWidth="7.5"
            strokeLinecap="round"
          />
          {/* Sector 1: F1 Red (#E10600) */}
          <path
            d={svgData.s1}
            fill="none"
            stroke="#E10600"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
          {/* Sector 2: F1 Cyan (#00D2BE) */}
          <path
            d={svgData.s2}
            fill="none"
            stroke="#00D2BE"
            strokeWidth="3.6"
            strokeLinecap="round"
          />
          {/* Sector 3: F1 Gold (#FFD700) */}
          <path
            d={svgData.s3}
            fill="none"
            stroke="#FFD700"
            strokeWidth="3.6"
            strokeLinecap="round"
          />

          {/* Start/Finish Line Marker */}
          <line
            x1={startFinishPoint.x}
            y1={startFinishPoint.y - 6}
            x2={startFinishPoint.x}
            y2={startFinishPoint.y + 6}
            stroke="#ffffff"
            strokeWidth="2.5"
          />

          {/* Interactive Turn Number Nodes */}
          {turnPoints.map((tp) => (
            <g
              key={tp.number}
              className="cursor-pointer hover:opacity-100 opacity-95"
              onClick={() => onSelectTurn(tp.number)}
            >
              <circle
                cx={tp.x}
                cy={tp.y}
                r="6.2"
                fill="#15151E"
                stroke={
                  telemetry.currentTurnNumber === tp.number
                    ? "#E10600"
                    : "#ffffff"
                }
                strokeWidth="1.4"
              />
              <text
                x={tp.x}
                y={tp.y + 2.5}
                textAnchor="middle"
                fill="#ffffff"
                fontSize="6.8"
                fontWeight="800"
              >
                {tp.number}
              </text>
            </g>
          ))}

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
                  stroke="#0B0B10"
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

          {/* Live Player Car GPS Transponder Dot */}
          <circle
            cx={carSvg.x}
            cy={carSvg.y}
            r="6.5"
            fill="#E10600"
            stroke="#ffffff"
            strokeWidth="2"
          />
        </svg>

        {/* Sector Legend */}
        <div className="absolute bottom-1.5 left-2 right-2 flex items-center justify-between font-f1-mono text-[9px] font-bold text-zinc-300">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 bg-[#E10600]" />
            S1 SLING/ARENA
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 bg-[#00D2BE]" />
            S2 HILLS
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 bg-[#FFD700]" />
            S3 LAKE
          </span>
        </div>
      </div>

      {/* Elevation Profile Telemetry */}
      <div className="rounded bg-[#0B0B10] p-2 border border-white/10">
        <div className="mb-1 flex items-center justify-between text-[10px]">
          <span className="font-f1-mono text-[9px] font-bold uppercase tracking-wider text-zinc-400">
            Elevation
          </span>
          <span className="font-f1-mono text-[11px] font-bold text-white">
            {telemetry.trackElevationM >= 0 ? "+" : ""}
            {telemetry.trackElevationM.toFixed(1)}
            <span className="ml-1 text-[9px] font-medium text-zinc-500">Δ {elevation.span} m</span>
          </span>
        </div>
        <div className="mb-1 flex items-center justify-between font-f1-mono text-[8px] font-bold text-zinc-500">
          <span>ALT {telemetry.altitudeM.toFixed(0)} m</span>
          <span>
            GRADIENT {telemetry.slopePercent >= 0 ? "+" : ""}
            {telemetry.slopePercent.toFixed(1)}%
          </span>
        </div>
        <svg viewBox="0 0 252 44" className="h-10 w-full overflow-visible">
          <defs>
            <linearGradient id="f1ElevGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#E10600" stopOpacity="0.4" />
              <stop offset="50%" stopColor="#00D2BE" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#FFD700" stopOpacity="0.4" />
            </linearGradient>
          </defs>
          <path d={elevationAreaPath} fill="url(#f1ElevGrad)" />
          <path
            d={elevationPath}
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.6"
          />
          <text x="4" y="13" fill="#a1a1aa" fontSize="6.5" fontWeight="700">
            {elevation.sfLabel}
          </text>
          <text x={Math.min(elevation.low.x, 222)} y="41" fill="#a1a1aa" fontSize="6.5" fontWeight="700">
            {elevation.low.label}
          </text>
          <text x={Math.min(Math.max(elevation.high.x - 12, 40), 222)} y="9" fill="#FFD700" fontSize="6.5" fontWeight="700">
            {elevation.high.label}
          </text>
          <circle
            cx={elevProgressX}
            cy={elevProgressY}
            r="3.8"
            fill="#E10600"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </svg>
      </div>
    </div>
  );
};
