"use client";

import React, { useMemo } from "react";
import type { CarTelemetry } from "@/types/f1";
import { type BuiltTrackData, DEFAULT_TRACK_ID, inDeadZone, TURN_METADATA } from "@/lib/track-data";
import { getTrackInfo } from "@/lib/track-registry";

/** Elevation profile size (SVG units): the profile, its viewBox and the progress dot all use it */
const ELEV_W = 252;
const ELEV_H = 44;
import { HUD_CYAN, HUD_GLASS, HUD_LBL, HUD_PINK, HUD_VOLT, HUD_WELL } from "./hud/hud-format";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn, HEIGHT_LABEL, heightIn } from "@/lib/settings/units";

/**
 * Turn numbers drawn in the SVG: the 280 × 200 view is drawn 150 px tall (0.75 px per unit), so 12 units are 9 px on
 * screen, the HUD's floor
 */
const MAP_FONT = 12;
/** Labels under the elevation profile: the HUD label, tracked tighter so three fit on one line */
const ELEV_LBL = `${HUD_LBL} tracking-[0.06em]`;

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
  const trackInfo = getTrackInfo(track.id ?? DEFAULT_TRACK_ID);
  const units = useUnits();

  const {
    svgData,
    carPoint,
    turnPoints,
    startFinishPoint,
    elevationPath,
    elevationAreaPath,
    elevation,
    profileLengthM,
  } = useMemo(() => {
    // A point-to-point course (a hill climb): its road only, without the stretch that closes its loop; the elevation
    // profile runs from the start line to the end of the road
    const p2p = track.pointToPoint;
    const samples = p2p ? track.samples.filter((s) => !inDeadZone(p2p, s.s)) : track.samples;
    const profiled = p2p ? samples.filter((s) => s.s <= p2p.endS) : samples;
    const profileLengthM = p2p ? p2p.endS : track.totalLengthM;
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
      // An open road's ends are not joined
      if (p2p && Math.abs(s1.s - s0.s) > 30) continue;
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

    const elevW = ELEV_W;
    const elevH = ELEV_H;
    let low = profiled[0];
    let high = profiled[0];
    for (const s of profiled) {
      if (s.position.y < low.position.y) low = s;
      if (s.position.y > high.position.y) high = s;
    }
    const yMin = low.position.y;
    const ySpan = Math.max(1, high.position.y - yMin);
    const toElevY = (y: number) => elevH - ((y - yMin) / ySpan) * (elevH - 8) - 4;
    const toElevX = (s: number) => (s / profileLengthM) * elevW;
    const turnAt = (s: (typeof samples)[number]) => (s.turnNumber ? `T${s.turnNumber} ` : "");
    const elevPts: string[] = [];
    for (let i = 0; i < profiled.length; i += 6) {
      const s = profiled[i];
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
        // Heights in metres here; written in the player's unit where they are shown
        sf: { word: p2p ? "Start" : "S/F", m: track.getSampleAtDistance(0).position.y - yMin },
        low: { x: toElevX(low.s), turn: turnAt(low) },
        high: { x: toElevX(high.s), turn: turnAt(high), m: ySpan },
      },
      profileLengthM,
    };
  }, [track]);

  const currentSample = track.getSampleAtDistance(telemetry.trackDistanceM);
  const carSvg = carPoint(currentSample.position.x, currentSample.position.z);
  const elevProgressX = Math.min(1, telemetry.trackDistanceM / profileLengthM) * ELEV_W;
  const elevProgressY = elevation.toY(telemetry.trackElevationM);

  // Elevation extremes, in lap order for the label row under the profile
  const lowFirst = elevation.low.x <= elevation.high.x;
  // Heights and altitude in metres, or feet with the mph units
  const hUnit = HEIGHT_LABEL[units.speed];
  const height = (m: number, digits = 0) => `${heightIn(m, units.speed).toFixed(digits)} ${hUnit}`;
  const lowMark = <span className={ELEV_LBL}>{`${elevation.low.turn}+0 ${hUnit}`}</span>;
  const highMark = <span className={`${ELEV_LBL} text-lc-chalk`}>{`${elevation.high.turn}+${height(elevation.high.m)}`}</span>;

  return (
    <section
      aria-label="Circuit map"
      className={`flex w-72.5 flex-col rounded-lc-card p-3.5 text-lc-chalk select-none ${HUD_GLASS}`}
    >
      {/* Circuit name, country, length and turns */}
      <div className="min-w-0">
        <div className="lc-title line-clamp-2 text-[14px] leading-tight">{trackInfo.name}</div>
        <p className={`${HUD_LBL} mt-0.5`}>
          {trackInfo.country} · {distanceIn((track.pointToPoint?.finishS ?? track.totalLengthM) / 1000, units.speed).toFixed(2)}{" "}
          {DISTANCE_LABEL[units.speed]} · {TURN_METADATA.length} turns
        </p>
      </div>

      {/* Circuit map: sector 1 cyan, sector 2 volt, sector 3 pink */}
      <svg viewBox="0 0 280 200" className="mt-2 block h-[150px] w-full" role="img" aria-label={`Circuit map${telemetry.currentTurnNumber ? `; you are at turn ${telemetry.currentTurnNumber}` : ""}`}>
        {/* Track ribbon */}
        <path
          d={`${svgData.s1} ${svgData.s2} ${svgData.s3}`}
          fill="none"
          stroke="var(--color-lc-titanium)"
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
          stroke="var(--color-lc-chalk)"
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
                r={isCurrent ? 10.4 : 9.6}
                fill={isCurrent ? HUD_VOLT : "var(--color-lc-carbon)"}
                stroke={isCurrent ? "var(--color-lc-void)" : "var(--color-lc-dim)"}
                strokeWidth={isCurrent ? 1.4 : 1}
              />
              <text
                x={tp.x}
                y={tp.y + 4.2}
                textAnchor="middle"
                fill={isCurrent ? "var(--color-lc-void)" : "var(--color-lc-chalk)"}
                fontSize={MAP_FONT}
                fontWeight="800"
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
              >
                {tp.number}
              </text>
            </g>
          );
        })}

        {/* Opponents and multiplayer peers, with a void halo round their codes so they read over the turns */}
        {(telemetry.peers ?? []).map((peer) => {
          const pSample = track.getSampleAtDistance(peer.trackDistanceM);
          const pSvg = carPoint(pSample.position.x, pSample.position.z);
          return (
            <g key={peer.peerId}>
              <circle cx={pSvg.x} cy={pSvg.y} r="4.6" fill={peer.teamColorHex} stroke="var(--color-lc-void)" strokeWidth="1.4" />
              <text
                x={pSvg.x}
                y={pSvg.y - 7.5}
                textAnchor="middle"
                fill={peer.teamColorHex}
                stroke="var(--color-lc-void)"
                strokeWidth={2.4}
                paintOrder="stroke"
                fontSize={MAP_FONT}
                fontWeight="800"
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
              >
                {peer.driverCode}
              </text>
            </g>
          );
        })}

        {/* You */}
        <circle cx={carSvg.x} cy={carSvg.y} r="6" fill={HUD_VOLT} stroke="var(--color-lc-void)" strokeWidth="2.4" />
      </svg>

      {/* Sector legend */}
      <div className="mt-1.5 flex gap-3">
        {SECTOR_LEGEND.map(([label, color]) => (
          <span key={label} className={`${HUD_LBL} inline-flex items-center gap-1.25`}>
            <span className="size-2 rounded-xs" style={{ backgroundColor: color }} />
            {label}
          </span>
        ))}
      </div>

      {/* Elevation profile */}
      <div className={`mt-2.5 rounded-lc-row p-2.5 ${HUD_WELL}`}>
        <div className="flex items-center justify-between gap-2">
          <span className={HUD_LBL}>Elevation</span>
          <span className="lc-data text-[12px] text-lc-chalk">
            {telemetry.trackElevationM >= 0 ? "+" : ""}
            {height(telemetry.trackElevationM, 1)}
            <span className="ml-1 text-lc-slate">Δ {height(elevation.span)}</span>
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between">
          <span className={ELEV_LBL}>Alt {height(telemetry.altitudeM)}</span>
          <span className={ELEV_LBL}>
            GRADE {telemetry.slopePercent >= 0 ? "+" : ""}
            {telemetry.slopePercent.toFixed(1)}%
          </span>
        </div>
        <svg viewBox={`0 0 ${ELEV_W} ${ELEV_H}`} className="mt-1.5 block h-11 w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="lcElevGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-lc-chalk)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--color-lc-chalk)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <path d={elevationAreaPath} fill="url(#lcElevGrad)" />
          <path d={elevationPath} fill="none" stroke="var(--color-lc-chalk)" strokeWidth="1.5" />
          <circle cx={elevProgressX} cy={elevProgressY} r="4" fill={HUD_VOLT} />
        </svg>
        <div className="mt-0.5 flex items-center justify-between">
          <span className={ELEV_LBL}>{`${elevation.sf.word} ${height(elevation.sf.m)}`}</span>
          {lowFirst ? lowMark : highMark}
          {lowFirst ? highMark : lowMark}
        </div>
      </div>
    </section>
  );
};
