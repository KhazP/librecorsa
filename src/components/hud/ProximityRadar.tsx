"use client";

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { RadarBlip } from "@/types/f1";
import {
  evaluateRadar,
  RADAR_CAR_L as CAR_L,
  RADAR_CAR_W as CAR_W,
  RADAR_VIEW_RANGE_M as VIEW_RANGE_M,
  radarSideArcPath,
  type EvaluatedRadarBlip,
} from "./third-party-data";

/**
 * Top-down spatial proximity radar that stays transparent in clear air, fades in per-car based on longitudinal
 * distance and a 90° forward sightline exclusion cone, and projects dynamic two-stage (yellow / orange) overlap
 * arcs that track the lateral gap and longitudinal bearing of cars alongside.
 */
export const ProximityRadar: React.FC<{ blips: RadarBlip[] | undefined; size?: number; forceVisible?: boolean }> = ({
  blips,
  size = 168,
  forceVisible = false,
}) => {
  const { blips: evaluated, leftCar, rightCar, opacity: maxOpacity } = evaluateRadar(blips ?? []);
  const tx = useTranslations("hud.proximityRadar");
  // The radar draws every frame; its spoken name changes only with the count and the sides
  const count = evaluated.length;
  const side = leftCar && rightCar ? "both" : leftCar ? "left" : rightCar ? "right" : "none";
  const label = useMemo(() => (count ? tx("carsClose", { count, side }) : tx("clear")), [tx, count, side]);

  const renderSideArc = (s: 1 | -1, target: EvaluatedRadarBlip) => {
    // Alongside: caution when overlapping a little, loss when the cars overlap fully (the arc also thickens)
    const color = target.overlapLevel === 2 ? "var(--color-lc-loss)" : "var(--color-lc-caution)";
    return (
      <path
        d={radarSideArcPath(s, target)}
        fill="none"
        stroke={color}
        strokeOpacity={Math.max(0.55, target.opacity)}
        strokeWidth={target.overlapLevel === 2 ? 2.1 : 1.6}
        strokeLinecap="round"
      />
    );
  };

  return (
    <div
      className="pointer-events-none transition-opacity duration-150 ease-out"
      style={{ width: size, height: size, opacity: forceVisible ? Math.max(0.9, maxOpacity) : maxOpacity }}
      aria-hidden={evaluated.length === 0}
      role="img"
      aria-label={label}
    >
      <svg viewBox={`${-VIEW_RANGE_M} ${-VIEW_RANGE_M} ${VIEW_RANGE_M * 2} ${VIEW_RANGE_M * 2}`} className="h-full w-full">
        <defs>
          <radialGradient id="lc-radar-bg">
            <stop offset="0%" stopColor="var(--color-lc-void)" stopOpacity={0.58} />
            <stop offset="100%" stopColor="var(--color-lc-void)" stopOpacity={0} />
          </radialGradient>
        </defs>
        <circle r={VIEW_RANGE_M} fill="url(#lc-radar-bg)" />
        <circle r={8} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.14} strokeWidth={0.25} />
        <circle r={16} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.08} strokeWidth={0.25} />
        <line x1={0} y1={-VIEW_RANGE_M} x2={0} y2={VIEW_RANGE_M} stroke="var(--color-lc-chalk)" strokeOpacity={0.06} strokeWidth={0.25} />
        <line x1={-VIEW_RANGE_M} y1={0} x2={VIEW_RANGE_M} y2={0} stroke="var(--color-lc-chalk)" strokeOpacity={0.06} strokeWidth={0.25} />
        {leftCar ? renderSideArc(-1, leftCar) : null}
        {rightCar ? renderSideArc(1, rightCar) : null}
        {evaluated.map(({ blip: b, opacity: carOp, overlapLevel }, i) => {
          const fill = overlapLevel === 2 ? "var(--color-lc-loss)" : overlapLevel === 1 ? "var(--color-lc-caution)" : b.color;
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
              stroke="var(--color-lc-void)"
              strokeOpacity={Math.max(0.35, carOp)}
              strokeWidth={0.35}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          );
        })}
        {/* The player's car */}
        <rect x={-CAR_W / 2} y={-CAR_L / 2} width={CAR_W} height={CAR_L} rx={0.6} fill="var(--color-lc-volt)" stroke="var(--color-lc-void)" strokeWidth={0.35} />
      </svg>
    </div>
  );
};

