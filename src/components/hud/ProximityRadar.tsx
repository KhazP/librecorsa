"use client";

import React from "react";
import type { RadarBlip } from "@/types/f1";

/** Outer detection threshold (m) and inner full-opacity threshold (m) */
const DISTANCE_THRESHOLD_M = 30.0;
const OPACITY_THRESHOLD_M = 8.0;
/** Viewport radius (m) rendered in the radar SVG */
const VIEW_RANGE_M = 25.0;
/** Front fade-out cone (deg): cars directly ahead fade out so the forward sightline stays uncluttered */
const FRONT_FADE_ARC_DEG = 90.0;
const FRONT_FADE_SPAN_DEG = 10.0;
/** Footprint drawn for every car (m) */
const CAR_W = 2.0;
const CAR_L = 5.2;
/** Two-stage longitudinal overlap thresholds: 1.2x car length (caution) and 0.8x car length (critical) */
const OVERLAP_LEVEL1_Z = CAR_L * 1.2;
const OVERLAP_LEVEL2_Z = CAR_L * 0.8;
const OVERLAP_MAX_X = 8.0;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface EvaluatedBlip {
  blip: RadarBlip;
  alphaZ: number;
  alphaAngle: number;
  opacity: number;
  overlapLevel: 0 | 1 | 2;
}

/**
 * Top-down spatial proximity radar that stays transparent in clear air, fades in per-car based on longitudinal
 * distance and a 90° forward sightline exclusion cone, and projects dynamic two-stage (yellow / orange) overlap
 * arcs that track the lateral gap and longitudinal bearing of cars alongside.
 */
export const ProximityRadar: React.FC<{ blips: RadarBlip[] | undefined; size?: number }> = ({ blips, size = 168 }) => {
  const evaluated: EvaluatedBlip[] = [];
  for (const b of blips ?? []) {
    const dist = Math.hypot(b.x, b.z);
    if (dist > DISTANCE_THRESHOLD_M) continue;
    const effDist = Math.max(Math.abs(b.z), dist * 0.75);
    const alphaZ = clamp01(1.0 - (effDist - OPACITY_THRESHOLD_M) / (DISTANCE_THRESHOLD_M - OPACITY_THRESHOLD_M));
    // Angle from straight ahead (+z = 0°, ±x = 90°, -z = 180°)
    const angleDeg = Math.abs((Math.atan2(b.x, b.z) * 180) / Math.PI);
    const alphaAngle = clamp01(
      (angleDeg - FRONT_FADE_ARC_DEG * 0.5 + FRONT_FADE_SPAN_DEG * 0.5) / FRONT_FADE_SPAN_DEG
    );
    const opacity = alphaZ * alphaAngle;
    if (opacity <= 0.01) continue;

    let overlapLevel: 0 | 1 | 2 = 0;
    if (Math.abs(b.x) < OVERLAP_MAX_X) {
      if (Math.abs(b.z) < OVERLAP_LEVEL2_Z) {
        overlapLevel = 2;
      } else if (Math.abs(b.z) < OVERLAP_LEVEL1_Z) {
        overlapLevel = 1;
      }
    }
    evaluated.push({ blip: b, alphaZ, alphaAngle, opacity, overlapLevel });
  }

  const maxOpacity = evaluated.reduce((m, c) => Math.max(m, c.opacity), 0);

  const pickSide = (s: 1 | -1) => {
    const candidates = evaluated.filter((c) => Math.sign(c.blip.x) === s && c.overlapLevel > 0);
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => b.overlapLevel - a.overlapLevel || Math.abs(a.blip.x) - Math.abs(b.blip.x)
    );
    return candidates[0];
  };

  const leftCar = pickSide(-1);
  const rightCar = pickSide(1);

  const renderSideArc = (s: 1 | -1, target: EvaluatedBlip) => {
    const color = target.overlapLevel === 2 ? "#FF6000" : "#FFD700";
    const absX = Math.abs(target.blip.x);
    const r = Math.max(3.0, Math.min(8.2, absX));
    // Shift arc center toward rival longitudinal offset so the warning bar tracks their nose/tail
    const baseAngle = s === 1 ? 0 : Math.PI;
    const bearingShift = Math.atan2(target.blip.z, Math.max(2.5, absX)) * 0.45;
    const centerAngle = baseAngle + s * bearingShift;
    const halfSpan = (35 * Math.PI) / 180;
    const a0 = centerAngle - halfSpan;
    const a1 = centerAngle + halfSpan;
    const p = (a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(-Math.sin(a) * r).toFixed(2)}`;
    return (
      <path
        d={`M ${p(a0)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 0 ${p(a1)}`}
        fill="none"
        stroke={color}
        strokeOpacity={Math.max(0.55, target.opacity)}
        strokeWidth={target.overlapLevel === 2 ? 2.1 : 1.6}
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 1.4px ${color})` }}
      />
    );
  };

  return (
    <div
      className="pointer-events-none transition-opacity duration-150 ease-out"
      style={{ width: size, height: size, opacity: maxOpacity }}
      aria-hidden={evaluated.length === 0}
      role="img"
      aria-label={
        evaluated.length
          ? `${evaluated.length} car${evaluated.length > 1 ? "s" : ""} close by${leftCar ? ", one alongside on the left" : ""}${rightCar ? ", one alongside on the right" : ""}`
          : "Radar clear"
      }
    >
      <svg viewBox={`${-VIEW_RANGE_M} ${-VIEW_RANGE_M} ${VIEW_RANGE_M * 2} ${VIEW_RANGE_M * 2}`} className="h-full w-full">
        <defs>
          <radialGradient id="lc-radar-bg">
            <stop offset="0%" stopColor="rgba(8,9,13,0.58)" />
            <stop offset="100%" stopColor="rgba(8,9,13,0)" />
          </radialGradient>
        </defs>
        <circle r={VIEW_RANGE_M} fill="url(#lc-radar-bg)" />
        <circle r={8} fill="none" stroke="rgba(245,247,250,0.14)" strokeWidth={0.25} />
        <circle r={16} fill="none" stroke="rgba(245,247,250,0.08)" strokeWidth={0.25} />
        <line x1={0} y1={-VIEW_RANGE_M} x2={0} y2={VIEW_RANGE_M} stroke="rgba(245,247,250,0.06)" strokeWidth={0.25} />
        <line x1={-VIEW_RANGE_M} y1={0} x2={VIEW_RANGE_M} y2={0} stroke="rgba(245,247,250,0.06)" strokeWidth={0.25} />
        {leftCar ? renderSideArc(-1, leftCar) : null}
        {rightCar ? renderSideArc(1, rightCar) : null}
        {evaluated.map(({ blip: b, opacity: carOp, overlapLevel }, i) => {
          const fill = overlapLevel === 2 ? "#FF6000" : overlapLevel === 1 ? "#FFD700" : b.color;
          return (
            <rect
              key={i}
              x={-CAR_W / 2}
              y={-CAR_L / 2}
              width={CAR_W}
              height={CAR_L}
              rx={0.6}
              fill={fill}
              fillOpacity={Math.max(0.25, carOp)}
              stroke="#08090D"
              strokeOpacity={Math.max(0.35, carOp)}
              strokeWidth={0.35}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          );
        })}
        {/* The player's car */}
        <rect x={-CAR_W / 2} y={-CAR_L / 2} width={CAR_W} height={CAR_L} rx={0.6} fill="#CCFF00" stroke="#08090D" strokeWidth={0.35} />
      </svg>
    </div>
  );
};

