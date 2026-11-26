"use client";

import React from "react";
import { pictureSize, screenRig, type ScreenSettings } from "@/lib/display/screen-layout";

/**
 * The player's screens seen from above, drawn from the same geometry the views are: each screen's picture, its frame,
 * and the wedge of the world it shows from the eye. A wedge that meets its neighbour at a frame is a seam the world
 * runs straight across.
 */
export function ScreensDiagram({ screens, aspect, label }: { screens: ScreenSettings; aspect: number; label: string }) {
  const triple = screens.mode === "triple";
  const rig = screenRig(screens, aspect);
  const { w } = pictureSize(screens.diagonalIn, aspect);
  const D = rig.distance;
  const b = rig.bezel;
  const a = rig.angle;
  const c = Math.cos(a);
  const s = Math.sin(a);

  // Horizontal plane: x across, z toward the eye (the eye at the origin, the centre screen at z = -D)
  type P = [number, number];
  const centre: [P, P] = [[-w / 2, -D], [w / 2, -D]];
  const right: [P, P] = [
    [w / 2 + b + b * c, -D + b * s],
    [w / 2 + b + (b + w) * c, -D + (b + w) * s],
  ];
  const left: [P, P] = [
    [-right[1][0], right[1][1]],
    [-right[0][0], right[0][1]],
  ];
  const frames: Array<[P, P]> = triple
    ? [
        [[w / 2, -D], [w / 2 + b, -D]],
        [[w / 2 + b, -D], right[0]],
        [[-w / 2, -D], [-w / 2 - b, -D]],
        [[-w / 2 - b, -D], left[1]],
      ]
    : [];
  const pictures = triple ? [left, centre, right] : [centre];
  const pts = [[0, 0] as P, ...pictures.flat()];
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minZ = Math.min(...pts.map((p) => p[1]));
  const maxZ = Math.max(...pts.map((p) => p[1]));
  const pad = Math.max(maxX - minX, maxZ - minZ) * 0.08;
  // SVG y grows downward: the screens (negative z) at the top, the eye at the bottom
  const vb = [minX - pad, minZ - pad, maxX - minX + 2 * pad, maxZ - minZ + 2 * pad];
  const unit = Math.max(vb[2], vb[3]) / 100;
  const pt = (p: P) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={vb.map((v) => v.toFixed(4)).join(" ")}
      className="block h-auto max-h-56 w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      {pictures.map((pic, i) => (
        <polygon
          key={`wedge-${i}`}
          points={`0,0 ${pt(pic[0])} ${pt(pic[1])}`}
          className={i === (triple ? 1 : 0) ? "fill-lc-info/20" : "fill-lc-info/10"}
        />
      ))}
      {pictures.map((pic, i) => (
        <g key={`rays-${i}`} className="stroke-lc-info/45" strokeWidth={unit * 0.35}>
          <line x1={0} y1={0} x2={pic[0][0]} y2={pic[0][1]} />
          <line x1={0} y1={0} x2={pic[1][0]} y2={pic[1][1]} />
        </g>
      ))}
      {frames.map((f, i) => (
        <line key={`frame-${i}`} x1={f[0][0]} y1={f[0][1]} x2={f[1][0]} y2={f[1][1]} className="stroke-lc-slate" strokeWidth={unit * 1.6} />
      ))}
      {pictures.map((pic, i) => (
        <line
          key={`pic-${i}`}
          x1={pic[0][0]}
          y1={pic[0][1]}
          x2={pic[1][0]}
          y2={pic[1][1]}
          className="stroke-lc-chalk"
          strokeWidth={unit * 1.6}
          strokeLinecap="butt"
        />
      ))}
      <circle cx={0} cy={0} r={unit * 1.8} className="fill-lc-chalk" />
    </svg>
  );
}
