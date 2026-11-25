"use client";

import React, { useId } from "react";
import type { RadarBlip } from "@/types/f1";
import { RADAR_CAR_L, RADAR_CAR_W, evaluateRadar } from "../third-party-data";


/** Half the radar's view (m): close in, so the cars alongside read large; one further off shows at the rim */
const RADAR_RANGE_M = 12;

/**
 * The warning arc beyond a car alongside: outside its far flank, leaning towards where the car sits (ahead or behind).
 * `dir` is −1 on the left, 1 on the right.
 */
function radarArc(dir: -1 | 1, x: number, z: number): string {
  const r = Math.min(RADAR_RANGE_M * 0.8, Math.max(4, Math.abs(x) + RADAR_CAR_W / 2 + 1.5));
  const mid = Math.atan2(z, Math.max(2.5, Math.abs(x))) * 0.5;
  const half = (38 * Math.PI) / 180;
  const at = (a: number) => `${(dir * r * Math.cos(a)).toFixed(2)} ${(-r * Math.sin(a)).toFixed(2)}`;
  return `M${at(mid - half)}A${r.toFixed(2)} ${r.toFixed(2)} 0 0 ${dir === 1 ? 0 : 1} ${at(mid + half)}`;
}

/**
 * Trackside's radar: the shared radar's reading (`evaluateRadar`: which cars count, how they fade, who is alongside)
 * drawn close in, with each car in its own colour and the warning arc outside it. Invisible in clear air.
 */
export const TracksideRadar: React.FC<{
  blips: RadarBlip[] | undefined;
  /** Its spoken name with cars near ("2 cars close, left") and without */
  closeLabel: (count: number, side: "both" | "left" | "right" | "none") => string;
  clearLabel: string;
}> = ({ blips: raw, closeLabel, clearLabel }) => {
  const { blips, leftCar, rightCar, opacity } = evaluateRadar(raw ?? []);
  const id = `lc-ts-radar-${useId().replace(/:/g, "")}`;
  const side = leftCar && rightCar ? "both" : leftCar ? "left" : rightCar ? "right" : "none";
  const arc = (dir: -1 | 1, car: NonNullable<typeof leftCar>) => (
    // Alongside: caution with a little overlap, loss (and thicker) with the cars fully overlapped
    <path
      d={radarArc(dir, car.blip.x, car.blip.z)}
      fill="none"
      stroke={car.overlapLevel === 2 ? "var(--color-lc-loss)" : "var(--color-lc-caution)"}
      strokeWidth={car.overlapLevel === 2 ? 1 : 0.75}
    />
  );
  return (
    <div
      role="img"
      aria-label={blips.length ? closeLabel(blips.length, side) : clearLabel}
      aria-hidden={blips.length === 0}
      className="size-[150px] transition-opacity duration-150 ease-out"
      style={{ opacity }}
    >
      <svg viewBox={`${-RADAR_RANGE_M} ${-RADAR_RANGE_M} ${RADAR_RANGE_M * 2} ${RADAR_RANGE_M * 2}`} className="size-full">
        <defs>
          <radialGradient id={id}>
            <stop offset="0" stopColor="var(--color-lc-void)" stopOpacity={0.78} />
            <stop offset="0.75" stopColor="var(--color-lc-void)" stopOpacity={0.6} />
            <stop offset="1" stopColor="var(--color-lc-void)" stopOpacity={0} />
          </radialGradient>
          <clipPath id={`${id}-clip`}>
            <circle r={RADAR_RANGE_M * 0.94} />
          </clipPath>
        </defs>
        <circle r={RADAR_RANGE_M} fill={`url(#${id})`} />
        <path d={`M0 ${-RADAR_RANGE_M * 0.76}V${RADAR_RANGE_M * 0.76}M${-RADAR_RANGE_M * 0.76} 0H${RADAR_RANGE_M * 0.76}`} stroke="var(--color-lc-chalk)" strokeOpacity={0.14} strokeWidth={0.16} />
        <g clipPath={`url(#${id}-clip)`}>
          {blips.map(({ blip: b, opacity: carOpacity }, i) => (
            <rect
              key={i}
              x={-RADAR_CAR_W / 2}
              y={-RADAR_CAR_L / 2}
              width={RADAR_CAR_W}
              height={RADAR_CAR_L}
              fill={b.color}
              fillOpacity={Math.max(0.3, carOpacity)}
              stroke="var(--color-lc-void)"
              strokeWidth={0.24}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          ))}
          {leftCar ? arc(-1, leftCar) : null}
          {rightCar ? arc(1, rightCar) : null}
        </g>
        <rect x={-RADAR_CAR_W / 2} y={-RADAR_CAR_L / 2} width={RADAR_CAR_W} height={RADAR_CAR_L} fill="var(--color-lc-volt)" />
      </svg>
    </div>
  );
};
