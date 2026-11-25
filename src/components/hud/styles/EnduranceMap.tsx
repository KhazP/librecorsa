"use client";

import React, { useId } from "react";
import type { CarTelemetry } from "@/types/f1";
import { mapPoint, type HudMap } from "./hud-style-parts";
import { inkOn } from "./EnduranceWords";

/**
 * The Endurance layout's circuit map: a bare chalk line on the scene with every car a dot in its team colour carrying
 * its race position, the player's larger and volt. No plate under it. Zoomed and heading-up when the map setting says so.
 */

/** The box the whole circuit is fitted into, and the side of the zoomed map (px at 100 %) */
const BOX_W = 300;
const BOX_H = 180;
const LOCAL_SIDE = 170;
/** Room round the outline for the dots (map units) */
const PAD = 64;
/** Radius of the zoomed map (m) */
const LOCAL_RADIUS_M = 360;

interface Dot {
  key: string;
  /** Lap fraction */
  p: number;
  color: string;
  /** Race position, or null for a car outside a race (no number) */
  pos: number | null;
}

/** The line itself: drawn once per circuit and size, not with every frame */
const Outline = React.memo(function Outline({ d, u, start }: { d: string; u: number; start: [number, number] }) {
  return (
    <>
      <path d={d} fill="none" stroke="var(--color-lc-void)" strokeOpacity={0.72} strokeWidth={9 * u} strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke="var(--color-lc-chalk)" strokeWidth={3.25 * u} strokeLinejoin="round" strokeLinecap="round" />
      <rect x={start[0] - 1.75 * u} y={start[1] - 7 * u} width={3.5 * u} height={14 * u} fill="var(--color-lc-chalk)" stroke="var(--color-lc-void)" strokeWidth={u} />
    </>
  );
});

export const EnduranceMap: React.FC<{ map: HudMap; t: CarTelemetry; local?: boolean; label: string }> = ({ map, t, local = false, label }) => {
  const clipId = `lc-endurance-map-${useId().replace(/:/g, "")}`;
  const L = map.lengthM || 1;
  const standings = t.race?.standings;
  const meIndex = standings ? standings.findIndex((e) => e.isPlayer) : -1;
  const me = standings && meIndex >= 0 ? standings[meIndex] : null;
  const lapS = (t.bestLapTimeMs ?? t.lastLapTimeMs ?? 95_000) / 1000;
  const [cx, cy] = mapPoint(map, t.trackProgress);

  // The field from the back to the front, so the leaders' dots lie on top
  const dots: Dot[] = [];
  if (standings && me) {
    for (let i = standings.length - 1; i >= 0; i--) {
      const e = standings[i];
      if (e.isPlayer || e.retired) continue;
      dots.push({
        key: e.driverCode,
        color: e.teamColorHex,
        pos: i + 1,
        p: e.trackS !== undefined ? e.trackS / L : t.trackProgress + (me.gapToLeaderS - e.gapToLeaderS) / lapS,
      });
    }
  } else {
    for (const p of t.peers ?? []) dots.push({ key: p.peerId, color: p.teamColorHex, pos: null, p: p.trackDistanceM / L });
  }

  // Map units per pixel, so a dot and its number are the same size on every circuit
  const vbW = map.w + PAD * 2;
  const vbH = map.h + PAD * 2;
  const r = LOCAL_RADIUS_M * map.unitsPerM;
  const fit = Math.min(BOX_W / vbW, BOX_H / vbH);
  const u = local ? (2 * r) / LOCAL_SIDE : 1 / fit;
  const width = local ? LOCAL_SIDE : Math.round(vbW * fit);
  const height = local ? LOCAL_SIDE : Math.round(vbH * fit);

  // Heading-up: the line turns under the car; the dots are turned by hand so their numbers stay upright
  let cos = 1;
  let sin = 0;
  let rotDeg = 0;
  if (local) {
    const look = 40 / L;
    const [ax, ay] = mapPoint(map, t.trackProgress - look);
    const [bx, by] = mapPoint(map, t.trackProgress + look);
    rotDeg = -90 - (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
    cos = Math.cos((rotDeg * Math.PI) / 180);
    sin = Math.sin((rotDeg * Math.PI) / 180);
  }
  const place = (p: number): [number, number] => {
    const [x, y] = mapPoint(map, p);
    if (!local) return [x, y];
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };

  const myPos = me ? meIndex + 1 : null;
  return (
    <svg
      viewBox={local ? `${cx - r} ${cy - r} ${2 * r} ${2 * r}` : `${-PAD} ${-PAD} ${vbW} ${vbH}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className="block"
    >
      {local ? (
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r * 0.98} />
          </clipPath>
        </defs>
      ) : null}
      <g clipPath={local ? `url(#${clipId})` : undefined}>
        <g transform={local ? `rotate(${rotDeg.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})` : undefined}>
          <Outline d={map.path} u={u} start={map.points[0]} />
        </g>
        {dots.map((d) => {
          const [x, y] = place(d.p);
          return (
            <g key={d.key}>
              <circle cx={x} cy={y} r={(d.pos === null ? 5.5 : 8) * u} fill={d.color} stroke="var(--color-lc-void)" strokeWidth={2 * u} />
              {d.pos !== null ? (
                <text x={x} y={y} textAnchor="middle" dominantBaseline="central" className="lc-data" fontSize={(d.pos > 9 ? 8.5 : 9.5) * u} fill={inkOn(d.color)}>
                  {d.pos}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
      {local ? <circle cx={cx} cy={cy} r={r * 0.98} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.3} strokeWidth={1.5 * u} /> : null}
      {/* The player: larger, volt, on top */}
      <circle cx={cx} cy={cy} r={(myPos === null ? 8 : 10.5) * u} fill="var(--color-lc-volt)" stroke="var(--color-lc-void)" strokeWidth={2.5 * u} />
      {myPos !== null ? (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" className="lc-data" fontSize={(myPos > 9 ? 10 : 11.5) * u} fill="var(--color-lc-void)">
          {myPos}
        </text>
      ) : null}
    </svg>
  );
};
