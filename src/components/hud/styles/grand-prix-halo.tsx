"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { upper } from "@/i18n/runtime";
import type { CarTelemetry } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { SPEED_LABEL, speedIn } from "@/lib/settings/units";
import {
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_GAIN,
  HUD_INFO,
  HUD_LOSS,
  HUD_RED,
  HUD_THROTTLE,
  cornerLabel,
  formatDeltaFit,
  formatLapTime,
  formatSpeed,
  speedUnit,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { gearLabel } from "./hud-style-parts";
import palette from "./grand-prix.module.css";

/*
 * The Grand Prix layout's halo cluster: one glass band laid along the halo's hoop in the TV pod camera. From the left: a
 * bubble with the car ahead and the player, the delta and the corner, the battery column (Recharge) and the throttle
 * column (Deploy) round the speed dial, the active-aero bubble, and the gears along the arc over the rev line.
 *
 * Everything is drawn in one frame of 1400 × 600 units (the part from 60, 130 to 1340, 590 is shown). The band runs
 * between two circles that are nearly concentric, so it is deepest in the middle where the dial sits; every position
 * along it is an angle round the arc's centre and a fraction across the band (0 its lower edge, 1 its upper edge).
 */

/** The arc's centre: angles along the band are measured round it, from straight up */
const A = { x: 700, y: 1142 } as const;
/** The radius that turns a frame x into an angle */
const ARC_R = 820;
/** The band's upper and lower edges */
const TOP_EDGE = { x: 700, y: 944.286, r: 792.286 } as const;
const LOW_EDGE = { x: 700, y: 1288.744, r: 920.744 } as const;
/** Inset of a bubble inside the band */
const INSET = 9;
/** The speed dial */
const DIAL = { x: 700, y: 256, r: 90 } as const;
/** The thin hoop line over the band, and how far out it reaches */
const HOOP = { x: 700, y: 944.286, r: 807 } as const;
const VIEW = "60 130 1280 460";

const GEAR_ROW = ["N", "1", "2", "3", "4", "5", "6", "7", "8"] as const;
const SEGMENTS = 10;

type Pt = readonly [number, number];
type Circle = { readonly x: number; readonly y: number; readonly r: number };

/** The angle (radians, + to the right) of a frame x along the arc */
const angleAt = (x: number) => Math.asin(Math.max(-1, Math.min(1, (x - A.x) / ARC_R)));

/** Distance from the arc's centre to a circle along the direction `theta` (both circles enclose the centre) */
function reach(c: Circle, theta: number): number {
  const ux = Math.sin(theta);
  const uy = -Math.cos(theta);
  const dx = A.x - c.x;
  const dy = A.y - c.y;
  const b = ux * dx + uy * dy;
  const cc = dx * dx + dy * dy - c.r * c.r;
  return -b + Math.sqrt(Math.max(0, b * b - cc));
}

/** The point at `theta` and fraction `f` across the band, `inset` in from both edges */
function at(theta: number, f: number, inset = INSET): Pt {
  const lo = reach(LOW_EDGE, theta) + inset;
  const hi = reach(TOP_EDGE, theta) - inset;
  const r = lo + (hi - lo) * f;
  return [A.x + r * Math.sin(theta), A.y - r * Math.cos(theta)];
}

const p2 = ([x, y]: Pt) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * A bubble along the band from frame x `x1` to `x2`, between fractions `f0` and `f1`, its sides square to the arc and
 * its corners rounded by `rc`
 */
function bubble(x1: number, x2: number, f0: number, f1: number, rc: number, inset = INSET): string {
  const t1 = angleAt(x1);
  const t2 = angleAt(x2);
  const TL = at(t1, f1, inset);
  const TR = at(t2, f1, inset);
  const BR = at(t2, f0, inset);
  const BL = at(t1, f0, inset);
  const rTop = dist([A.x, A.y], TR);
  const rLow = dist([A.x, A.y], BR);
  const dTop = rc / rTop;
  const dLow = rc / rLow;
  const side = dist(TR, BR);
  const df = Math.min(0.45, rc / Math.max(1, side)) * (f1 - f0);
  const steps = Math.max(4, Math.ceil(((t2 - t1) * 180) / Math.PI / 0.8));
  const along = (a: number, b: number, f: number) =>
    Array.from({ length: steps + 1 }, (_, k) => `L${p2(at(a + ((b - a) * k) / steps, f, inset))}`).join("");
  return [
    `M${p2(at(t1 + dTop, f1, inset))}`,
    along(t1 + dTop, t2 - dTop, f1),
    `Q${p2(TR)} ${p2(at(t2, f1 - df, inset))}`,
    `L${p2(at(t2, f0 + df, inset))}`,
    `Q${p2(BR)} ${p2(at(t2 - dLow, f0, inset))}`,
    along(t2 - dLow, t1 + dLow, f0),
    `Q${p2(BL)} ${p2(at(t1, f0 + df, inset))}`,
    `L${p2(at(t1, f1 - df, inset))}`,
    `Q${p2(TL)} ${p2(at(t1 + dTop, f1, inset))}`,
    "Z",
  ].join("");
}

/** A line along the band at fraction `f`, left to right (text runs along it) */
function line(x1: number, x2: number, f: number, inset = INSET): string {
  const t1 = angleAt(x1);
  const t2 = angleAt(x2);
  const steps = Math.max(4, Math.ceil(((t2 - t1) * 180) / Math.PI / 0.8));
  return Array.from({ length: steps + 1 }, (_, k) => `${k ? "L" : "M"}${p2(at(t1 + ((t2 - t1) * k) / steps, f, inset))}`).join("");
}

/** A point on a circle at `deg` (0 to the right, clockwise on screen) */
const onCircle = (c: Circle, r: number, deg: number): Pt => [c.x + r * Math.cos((deg * Math.PI) / 180), c.y + r * Math.sin((deg * Math.PI) / 180)];

/** A ring sector round the dial from `a1` to `a2` degrees, between radii `r1` and `r2` */
function sector(r1: number, r2: number, a1: number, a2: number): string {
  const large = Math.abs(a2 - a1) > 180 ? 1 : 0;
  return `M${p2(onCircle(DIAL, r2, a1))}A${r2} ${r2} 0 ${large} 1 ${p2(onCircle(DIAL, r2, a2))}L${p2(onCircle(DIAL, r1, a2))}A${r1} ${r1} 0 ${large} 0 ${p2(
    onCircle(DIAL, r1, a1),
  )}Z`;
}

/* The band's fixed drawing, built once */
const BAND = bubble(94, 1306, 0, 1, 34, 0);
const HOOP_ARC = (() => {
  const a = HOOP;
  const x1 = 83;
  const x2 = 1317;
  const y = (x: number) => a.y - Math.sqrt(a.r * a.r - (x - a.x) ** 2);
  return { d: `M${x1} ${y(x1).toFixed(1)}A${a.r} ${a.r} 0 0 1 ${x2} ${y(x2).toFixed(1)}`, ends: [[x1, y(x1)], [x2, y(x2)]] as Pt[] };
})();
const NAMES = bubble(110, 408, 0, 1, 26);
/** The hoop from its top out to each end, for the Straight Mode light */
const HOOP_HALVES = [83, 1317].map((end) => {
  const y = (x: number) => HOOP.y - Math.sqrt(HOOP.r * HOOP.r - (x - HOOP.x) ** 2);
  return `M${HOOP.x} ${y(HOOP.x).toFixed(1)}A${HOOP.r} ${HOOP.r} 0 0 ${end < HOOP.x ? 0 : 1} ${end} ${y(end).toFixed(1)}`;
}) as [string, string];
/** The dial's ring from straight up, clockwise, for the Overtake light */
const DIAL_RING = `M${DIAL.x} ${DIAL.y - DIAL.r}A${DIAL.r} ${DIAL.r} 0 1 1 ${DIAL.x - 0.01} ${DIAL.y - DIAL.r}`;
const NAMES_PLAYER = bubble(126, 392, 0.05, 0.53, 18, INSET + 2);
const DELTA = bubble(416, 510, 0, 1, 22);
const AERO = bubble(884, 993, 0, 1, 22);
const GEARS = bubble(1001, 1290, 0, 1, 26);
const LINES = {
  ahead: line(110, 408, 0.74),
  player: line(126, 392, 0.27),
  deltaLabel: line(416, 510, 0.76),
  gearsLabel: line(1040, 1220, 0.85),
  rpmLabel: line(1060, 1230, 0.13),
  rpm: [1024, 1258] as const,
};
/** The rev line's points, with how far along it each is */
const RPM_PTS: { p: Pt; u: number }[] = (() => {
  const t1 = angleAt(LINES.rpm[0]);
  const t2 = angleAt(LINES.rpm[1]);
  return Array.from({ length: 41 }, (_, k) => ({ p: at(t1 + ((t2 - t1) * k) / 40, 0.3), u: k / 40 }));
})();
/** Where each gear sits along the arc, and its tilt */
const GEAR_PTS = GEAR_ROW.map((g, i) => {
  const t = angleAt(1020 + (i * (1262 - 1020)) / (GEAR_ROW.length - 1));
  return { g, p: at(t, 0.56), deg: (t * 180) / Math.PI };
});
/** The two columns round the dial: the battery on the left (round 180°), the throttle on the right (round 0°) */
const COLUMN_SPAN = 25;
const COLUMN_R = [115, 141] as const;
const STRIP_R = [94, 111] as const;
const columnSegments = (side: -1 | 1, grow = 0) =>
  Array.from({ length: SEGMENTS }, (_, k) => {
    // Filled from the bottom up
    const base = side < 0 ? 180 - COLUMN_SPAN : COLUMN_SPAN;
    const top = side < 0 ? 180 + COLUMN_SPAN : -COLUMN_SPAN;
    const a1 = base + ((top - base) * (k + 0.14)) / SEGMENTS;
    const a2 = base + ((top - base) * (k + 0.86)) / SEGMENTS;
    return sector(COLUMN_R[0] - grow, COLUMN_R[1] + grow, Math.min(a1, a2) - grow / 2, Math.max(a1, a2) + grow / 2);
  });
const LEFT_SEGMENTS = columnSegments(-1);
const RIGHT_SEGMENTS = columnSegments(1);
const LEFT_GLOW = columnSegments(-1, 2);
const RIGHT_GLOW = columnSegments(1, 2);
const LEFT_FRAME = sector(STRIP_R[0] - 4, COLUMN_R[1] + 5, 180 - COLUMN_SPAN - 5, 180 + COLUMN_SPAN + 5);
const RIGHT_FRAME = sector(STRIP_R[0] - 4, COLUMN_R[1] + 5, -COLUMN_SPAN - 5, COLUMN_SPAN + 5);
const LEFT_STRIP = sector(STRIP_R[0], STRIP_R[1], 180 - COLUMN_SPAN, 180 + COLUMN_SPAN);
const RIGHT_STRIP = sector(STRIP_R[0], STRIP_R[1], -COLUMN_SPAN, COLUMN_SPAN);
/** Letters stacked down a column's strip */
const stripLetters = (word: string, side: -1 | 1) => {
  const letters = [...word];
  const span = Math.min(2 * COLUMN_SPAN - 2, letters.length * 6.6);
  return letters.map((ch, i) => {
    const u = letters.length === 1 ? 0.5 : i / (letters.length - 1);
    // Top to bottom: the left strip from 180 + span/2 (upper) round to 180 − span/2 … on screen the upper is the smaller y
    const deg = side < 0 ? 180 + span / 2 - span * u : -span / 2 + span * u;
    const [x, y] = onCircle(DIAL, (STRIP_R[0] + STRIP_R[1]) / 2, deg);
    return { ch, x, y };
  });
};
const DIAL_TICKS = Array.from({ length: 60 }, (_, i) => {
  const a = i * 6;
  return { a: onCircle(DIAL, 80, a), b: onCircle(DIAL, i % 5 === 0 ? 86 : 84, a) };
});

function useHaloWords() {
  const tx = useTranslations("hudStyles.grandPrix");
  return useMemo(
    () => ({
      recharge: tx("recharge"),
      deploy: tx("deploy"),
      brake: tx("brake"),
      throttle: tx("throttle"),
      boost: tx("boost"),
      overtake: tx("overtake"),
      drsOpen: tx("drsOpen"),
      activeAero: tx("activeAero"),
      gears: tx("gears"),
      delta: tx("delta"),
      straight: tx("straight"),
      youName: tx("youName"),
      rpmScale: tx("rpmScale"),
      vsc: tx("vsc"),
      slowDown: tx("slowDown"),
      giveBack: tx("giveBack"),
      straightCall: tx("straightCall"),
      overtakeCall: tx("overtakeCall"),
      fastestCall: tx("fastestCall"),
    }),
    [tx],
  );
}

const CHALK = "var(--color-lc-chalk)";
const VOID = "var(--color-lc-void)";
const SLATE = "var(--color-lc-slate)";
const VOLT = "var(--color-lc-volt)";

/** A word set along a line of the band, centred on it */
const ArcText: React.FC<{ id: string; d: string; children: React.ReactNode; size: number; fill: string; className: string; spacing?: number }> = ({
  id,
  d,
  children,
  size,
  fill,
  className,
  spacing = 0,
}) => (
  <>
    <path id={id} d={d} fill="none" />
    <text className={className} fill={fill} style={{ fontSize: size, letterSpacing: spacing }}>
      <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
        {children}
      </textPath>
    </text>
  </>
);

export interface HaloClusterProps {
  t: CarTelemetry;
  /** Live delta to the best lap (s, − = faster); null without one */
  deltaS: number | null;
  revRange: [number, number];
  /** A car without ERS draws its brake in the left column and no battery, Boost or Overtake */
  hasErs: boolean;
  scale?: number;
}

/**
 * The halo cluster. Its edge takes the state's colour, as a TV graphic's does: caution under a virtual safety car or a
 * yellow flag, gain while Overtake or Boost is on, info while the active aero is open; otherwise the glass's hairline.
 */
export const HaloCluster: React.FC<HaloClusterProps> = ({ t, deltaS, revRange, hasErs, scale }) => {
  const w = useHaloWords();
  const units = useUnits();
  const uid = useId().replace(/:/g, "");
  const race = t.race;
  const [, revFull] = revRange;

  // States: use the shared 2026 / legacy ERS button state so Boost and Overtake stay independent.
  // In Practice/Quali Overtake is always on by rule (so its pill stays idle instead of blinking nonstop),
  // and holding Space/Boost lights BOOST rather than OVERTAKE.
  const aero = aeroReadout(t);
  const ersCtl = ersButtons(t);
  const boostOn = hasErs && ersCtl.boostOn;
  const overtakeOn = hasErs && (ersCtl.overtake === "on" || ersCtl.overtake === "auto");
  const overtakeArmed = hasErs && ersCtl.overtake === "available";
  const overtakeEarned = overtakeArmed || overtakeOn;
  const extraOn = boostOn || overtakeOn;
  const vsc = race?.vsc ?? null;
  const yellow = !vsc && Boolean(race?.yellow);
  // The band's colour: a virtual safety car (and, blinking, a yellow flag) first, then the extra power, then the wing
  const accent = vsc ? HUD_CAUTION : extraOn ? HUD_GAIN : aero.open ? HUD_INFO : null;
  const edge = accent ?? CHALK;
  const edgeOpacity = accent ? 0.95 : 0.2;
  const flash = useHaloFlash(t, aero.open, overtakeEarned);

  // Energy and pedals
  const soc = Math.max(0, Math.min(1, t.ersBatteryPercent / 100));
  const harvesting = hasErs && t.mgukPowerKw < -5;
  const deploying = hasErs && t.mgukPowerKw > 5;
  const leftValue = hasErs ? soc : Math.max(0, Math.min(1, t.brake));
  const leftColor = hasErs ? HUD_INFO : HUD_BRAKE;
  const leftLit = hasErs ? harvesting : t.brake > 0.05;
  const throttle = Math.max(0, Math.min(1, t.throttle));
  const rightValue = hasErs ? Math.max(0, Math.min(1, t.mgukPowerKw / 350)) : throttle;
  const rightLit = hasErs ? deploying : throttle > 0.05;
  const leftOn = Math.round(leftValue * SEGMENTS);
  const rightOn = Math.round(rightValue * SEGMENTS);

  // Speed in the player's unit, and in the other one beneath it
  const other = units.speed === "kmh" ? "mph" : "kmh";
  const speed = formatSpeed(t.speedKmh, units);
  const otherSpeed = String(Math.round(speedIn(t.speedKmh, other)));

  // Revs along the gear bubble, full at the limit: amber past 84 % of it, crimson past 92 %
  const rpmFrac = Math.max(0, Math.min(1, t.rpm / Math.max(1, revFull)));
  const rpmColor = rpmFrac > 0.92 ? HUD_RED : rpmFrac > 0.84 ? HUD_CAUTION : CHALK;
  const rpmPath = (() => {
    const pts = RPM_PTS.filter((p) => p.u <= rpmFrac);
    if (pts.length < 2) return null;
    return pts.map((p, i) => `${i ? "L" : "M"}${p2(p.p)}`).join("");
  })();

  // Names: the car ahead over the player
  const me = race?.standings.find((e) => e.isPlayer);
  const pos = race?.position ?? null;
  const ahead = race && pos && pos > 1 ? race.standings[pos - 2] : null;
  const myName = upper(me ? me.name?.trim() || me.driverCode : w.youName);
  const aheadName = ahead ? upper(ahead.name?.trim() || ahead.driverCode) : null;

  // The corner the car is in
  const corner = cornerLabel(t.currentTurnNumber, t.currentTurnName);

  const gear = gearLabel(t.gear);
  const gearSlot = t.gear < 0 ? 0 : Math.min(GEAR_ROW.length - 1, Math.max(0, t.gear));
  const left = stripLetters(hasErs ? w.recharge : w.brake, -1);
  const right = stripLetters(hasErs ? w.deploy : w.throttle, 1);

  return (
    <div className={palette.haloAnchor} style={scale && scale !== 1 ? { transform: `translateX(-50%) scale(${scale})` } : undefined}>
      {vsc ? <HaloDirector t={t} vsc={vsc} giveBack={Boolean(race?.giveBack)} w={w} /> : null}
      {flash ? <HaloCall key={flash.id} kind={flash.kind} lapMs={t.bestLapTimeMs} w={w} /> : null}
      <svg viewBox={VIEW} className={palette.haloSvg} aria-hidden>
        {/* The hoop over the band */}
        <path d={HOOP_ARC.d} fill="none" stroke={CHALK} strokeOpacity={0.4} strokeWidth={2} />
        {HOOP_ARC.ends.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={5} fill={CHALK} fillOpacity={0.6} />
        ))}

        {/* The glass band */}
        <path d={BAND} fill={VOID} fillOpacity={0.82} stroke={edge} strokeOpacity={accent ? 0.7 : 0.14} strokeWidth={2.5} />

        {/* Names: the car ahead, and the player in volt */}
        <path d={NAMES} fill={CHALK} fillOpacity={0.05} stroke={edge} strokeOpacity={edgeOpacity} strokeWidth={2} />
        {aheadName && pos ? (
          <ArcText id={`${uid}-ahead`} d={LINES.ahead} size={24} fill={CHALK} className="lc-disp" spacing={1}>
            {pos - 1}
            {" "}
            {aheadName}
          </ArcText>
        ) : null}
        <path d={NAMES_PLAYER} fill={VOLT} />
        <ArcText id={`${uid}-me`} d={LINES.player} size={31} fill={VOID} className="lc-disp" spacing={1}>
          {pos ? `${pos} ` : ""}
          {myName}
        </ArcText>

        {/* Delta and the corner */}
        <path d={DELTA} fill={CHALK} fillOpacity={0.05} stroke={edge} strokeOpacity={edgeOpacity} strokeWidth={2} />
        <ArcText id={`${uid}-dl`} d={LINES.deltaLabel} size={17} fill={SLATE} className="lc-disp" spacing={1}>
          {w.delta}
        </ArcText>
        <HaloDelta deltaS={deltaS} uid={uid} corner={corner?.short ?? w.straight} />

        {/* The columns round the dial: battery (or brake) on the left, MGU-K deploy (or throttle) on the right */}
        <path d={LEFT_FRAME} fill={VOID} fillOpacity={0.55} stroke={CHALK} strokeOpacity={0.12} strokeWidth={1.5} strokeLinejoin="round" />
        <path d={RIGHT_FRAME} fill={VOID} fillOpacity={0.55} stroke={CHALK} strokeOpacity={0.12} strokeWidth={1.5} strokeLinejoin="round" />
        <path d={LEFT_STRIP} fill={leftColor} fillOpacity={leftLit ? 0.9 : 0.28} />
        <path d={RIGHT_STRIP} fill={HUD_THROTTLE} fillOpacity={rightLit ? 0.9 : 0.28} />
        {left.map(({ ch, x, y }, i) => (
          <text key={`l${i}`} x={x} y={y + 4.5} textAnchor="middle" className="lc-disp" fill={leftLit ? VOID : CHALK} style={{ fontSize: 14 }}>
            {ch}
          </text>
        ))}
        {right.map(({ ch, x, y }, i) => (
          <text key={`r${i}`} x={x} y={y + 4.5} textAnchor="middle" className="lc-disp" fill={rightLit ? VOID : CHALK} style={{ fontSize: 14 }}>
            {ch}
          </text>
        ))}
        {/* A lit column glows round its filled segments */}
        {leftLit ? LEFT_GLOW.slice(0, leftOn).map((d, k) => <path key={`lg${k}`} d={d} fill={leftColor} fillOpacity={0.25} />) : null}
        {rightLit ? RIGHT_GLOW.slice(0, rightOn).map((d, k) => <path key={`rg${k}`} d={d} fill={HUD_THROTTLE} fillOpacity={0.25} />) : null}
        {LEFT_SEGMENTS.map((d, k) => (
          <path key={`ls${k}`} d={d} fill={k < leftOn ? leftColor : CHALK} fillOpacity={k < leftOn ? (leftLit ? 1 : 0.62) : 0.08} />
        ))}
        {RIGHT_SEGMENTS.map((d, k) => (
          <path key={`rs${k}`} d={d} fill={k < rightOn ? HUD_THROTTLE : CHALK} fillOpacity={k < rightOn ? (rightLit ? 1 : 0.62) : 0.08} />
        ))}

        {/* Brake and throttle, lit while pressed */}
        <g transform="rotate(-13 566 358)">
          <rect x={526} y={344} width={80} height={28} rx={8} fill={t.brake > 0.05 ? HUD_BRAKE : VOID} fillOpacity={t.brake > 0.05 ? 1 : 0.7} stroke={HUD_BRAKE} strokeOpacity={0.6} strokeWidth={1.5} />
          <text x={566} y={364} textAnchor="middle" className="lc-disp" fill={t.brake > 0.05 ? VOID : CHALK} style={{ fontSize: 15 }}>
            {w.brake}
          </text>
        </g>
        <g transform="rotate(13 834 358)">
          <rect x={788} y={344} width={92} height={28} rx={8} fill={throttle > 0.05 ? HUD_THROTTLE : VOID} fillOpacity={throttle > 0.05 ? 1 : 0.7} stroke={HUD_THROTTLE} strokeOpacity={0.6} strokeWidth={1.5} />
          <text x={834} y={364} textAnchor="middle" className="lc-disp" fill={throttle > 0.05 ? VOID : CHALK} style={{ fontSize: 15 }}>
            {w.throttle}
          </text>
        </g>

        {/* The speed dial */}
        <circle cx={DIAL.x} cy={DIAL.y} r={DIAL.r} fill={VOID} fillOpacity={0.94} stroke={accent ?? CHALK} strokeOpacity={accent ? 1 : 0.45} strokeWidth={4} />
        {DIAL_TICKS.map(({ a, b }, i) => (
          <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={CHALK} strokeOpacity={i % 5 === 0 ? 0.3 : 0.12} strokeWidth={1.4} />
        ))}
        <text x={DIAL.x} y={196} textAnchor="middle" className="lc-data" fill={SLATE} style={{ fontSize: 15, letterSpacing: 2 }}>
          {upper(speedUnit(units))}
        </text>
        <text x={DIAL.x} y={234} textAnchor="middle" className="lc-data" fill={CHALK} style={{ fontSize: 46, letterSpacing: -1 }}>
          {speed}
        </text>
        {hasErs ? (
          <>
            {/* Boost over Overtake, as the car's own wheel shows them: independent pills; Overtake blinks once earned in a race */}
            <rect x={654} y={240} width={92} height={17} rx={5} fill={boostOn ? HUD_GAIN : CHALK} fillOpacity={boostOn ? 1 : 0.12} />
            <text x={700} y={253} textAnchor="middle" className="lc-disp" fill={boostOn ? VOID : SLATE} style={{ fontSize: 13 }}>
              {w.boost}
            </text>
            <g className={overtakeArmed ? palette.haloBlink : undefined}>
              <rect
                x={634}
                y={261}
                width={132}
                height={23}
                rx={7}
                fill={overtakeOn ? HUD_GAIN : VOID}
                stroke={overtakeOn || overtakeArmed ? HUD_GAIN : CHALK}
                strokeOpacity={overtakeOn || overtakeArmed ? 1 : 0.25}
                strokeWidth={1.5}
              />
              <text x={700} y={278} textAnchor="middle" className="lc-disp" fill={overtakeOn ? VOID : overtakeArmed ? HUD_GAIN : SLATE} style={{ fontSize: 15 }}>
                {w.overtake}
              </text>
            </g>
          </>
        ) : aero.open ? (
          <>
            <rect x={634} y={258} width={132} height={23} rx={7} fill={HUD_INFO} />
            <text x={700} y={275} textAnchor="middle" className="lc-disp" fill={VOID} style={{ fontSize: 15 }}>
              {w.drsOpen}
            </text>
          </>
        ) : (
          <line x1={650} y1={266} x2={750} y2={266} stroke={CHALK} strokeOpacity={0.12} strokeWidth={1.5} />
        )}
        <text x={DIAL.x} y={314} textAnchor="middle" className="lc-data" fill={CHALK} fillOpacity={0.85} style={{ fontSize: 30 }}>
          {otherSpeed}
        </text>
        <text x={DIAL.x} y={331} textAnchor="middle" className="lc-data" fill={SLATE} style={{ fontSize: 13, letterSpacing: 2 }}>
          {upper(SPEED_LABEL[other])}
        </text>
        {/* The battery under the dial */}
        {hasErs ? (
          <g>
            <rect x={666} y={339} width={68} height={22} rx={7} fill={VOID} stroke={CHALK} strokeOpacity={0.65} strokeWidth={1.6} />
            <rect x={669} y={342} width={Math.max(0, 62 * soc)} height={16} rx={5} fill={deploying ? HUD_GAIN : HUD_INFO} />
            <path d="M703 343 L694 351.5 L700 351.5 L697 358 L706 349 L700 349 Z" fill={CHALK} />
          </g>
        ) : null}

        {/* Active aero: the flap lines lie flat when shut and part when open */}
        <g className={aero.armed && !aero.open ? palette.haloBlink : undefined}>
          <path
            d={AERO}
            fill={aero.open ? HUD_INFO : CHALK}
            fillOpacity={aero.open ? 0.95 : 0.05}
            stroke={aero.open || aero.armed ? HUD_INFO : edge}
            strokeOpacity={aero.open || aero.armed ? 1 : edgeOpacity}
            strokeWidth={2}
          />
        </g>
        <HaloAero open={aero.open} label={w.activeAero} uid={uid} />

        {/* Gears along the arc over the rev line */}
        <path d={GEARS} fill={CHALK} fillOpacity={0.05} stroke={edge} strokeOpacity={edgeOpacity} strokeWidth={2} />
        <ArcText id={`${uid}-gl`} d={LINES.gearsLabel} size={17} fill={SLATE} className="lc-disp" spacing={1}>
          {w.gears}
        </ArcText>
        {GEAR_PTS.map(({ g, p, deg }, i) => {
          const on = i === gearSlot;
          return (
            <g key={g} transform={`translate(${p2(p)}) rotate(${deg.toFixed(1)})`}>
              {on ? <rect x={-19} y={-21} width={38} height={40} rx={8} fill={VOLT} /> : null}
              <text y={10} textAnchor="middle" className="lc-disp" fill={on ? VOID : CHALK} fillOpacity={on ? 1 : 0.8} style={{ fontSize: on ? 32 : 27 }}>
                {on ? (t.gear < 0 ? "R" : gear) : g}
              </text>
            </g>
          );
        })}
        <path d={RPM_PTS.map((p, i) => `${i ? "L" : "M"}${p2(p.p)}`).join("")} fill="none" stroke={CHALK} strokeOpacity={0.14} strokeWidth={5} strokeLinecap="round" />
        {rpmPath ? <path d={rpmPath} fill="none" stroke={rpmColor} strokeWidth={5} strokeLinecap="round" /> : null}
        <text x={RPM_PTS[0].p[0] - 14} y={RPM_PTS[0].p[1] - 2} textAnchor="middle" className="lc-data" fill={SLATE} style={{ fontSize: 14 }}>
          0
        </text>
        <text x={RPM_PTS[RPM_PTS.length - 1].p[0] + 10} y={RPM_PTS[RPM_PTS.length - 1].p[1] + 20} textAnchor="middle" className="lc-data" fill={SLATE} style={{ fontSize: 14 }}>
          {Math.round(revFull / 1000)}
        </text>
        <ArcText id={`${uid}-rl`} d={LINES.rpmLabel} size={14} fill={SLATE} className="lc-data" spacing={1.5}>
          {w.rpmScale}
        </ArcText>
        {/* A call's light: along the hoop for Straight Mode, round the dial for Overtake, round the names for a fastest lap */}
        {flash?.kind === "sm" ? (
          <g key={flash.id} className={palette.haloRun} fill="none" stroke={HUD_INFO} strokeWidth={5} strokeLinecap="round">
            <path d={HOOP_HALVES[0]} pathLength={1} strokeDasharray="0.24 1.3" />
            <path d={HOOP_HALVES[1]} pathLength={1} strokeDasharray="0.24 1.3" />
          </g>
        ) : flash?.kind === "ovt" ? (
          <path key={flash.id} className={palette.haloDraw} d={DIAL_RING} pathLength={1} strokeDasharray="1 1" fill="none" stroke={HUD_GAIN} strokeWidth={7} strokeLinecap="round" />
        ) : flash?.kind === "fastest" ? (
          <path key={flash.id} className={palette.haloRunLong} d={NAMES} pathLength={1} strokeDasharray="0.3 1.4" fill="none" stroke="var(--color-lc-best)" strokeWidth={5} strokeLinecap="round" />
        ) : null}

        {/* A yellow flag blinks the band's edges amber over their own colour */}
        {yellow ? (
          <g className={palette.haloBlinkSlow} fill="none" stroke={HUD_CAUTION} strokeWidth={2.5}>
            <path d={BAND} />
            <path d={NAMES} />
            <path d={DELTA} />
            <path d={AERO} />
            <path d={GEARS} />
            <circle cx={DIAL.x} cy={DIAL.y} r={DIAL.r} strokeWidth={4} />
          </g>
        ) : null}
      </svg>
    </div>
  );
};

const DELTA_VALUE = line(416, 510, 0.42);
const DELTA_CORNER = line(416, 510, 0.14);

/** The live delta (− gaining, + losing) over the corner the car is in */
const HaloDelta: React.FC<{ deltaS: number | null; uid: string; corner: string }> = ({ deltaS, uid, corner }) => (
  <>
    <ArcText
      id={`${uid}-dv`}
      d={DELTA_VALUE}
      size={24}
      fill={deltaS === null ? SLATE : deltaS <= 0 ? HUD_GAIN : HUD_LOSS}
      className="lc-data"
    >
      {deltaS === null ? "--" : formatDeltaFit(deltaS, 2)}
    </ArcText>
    <ArcText id={`${uid}-dc`} d={DELTA_CORNER} size={16} fill={SLATE} className="lc-disp" spacing={1}>
      {corner}
    </ArcText>
  </>
);

const AERO_TOP = line(884, 993, 0.8);
const AERO_MID = line(884, 993, 0.64);
const FLAP_SHUT = line(904, 973, 0.4);
const FLAP_OPEN = line(904, 973, 0.46);
const MAINPLANE = line(904, 973, 0.28);

/** The active-aero bubble's words and its two flap lines */
const HaloAero: React.FC<{ open: boolean; label: string; uid: string }> = ({ open, label, uid }) => {
  const words = label.split(/\s+/);
  const ink = open ? VOID : CHALK;
  return (
    <g>
      <ArcText id={`${uid}-a1`} d={AERO_TOP} size={19} fill={ink} className="lc-disp">
        {words[0]}
      </ArcText>
      {words[1] ? (
        <ArcText id={`${uid}-a2`} d={AERO_MID} size={19} fill={ink} className="lc-disp">
          {words.slice(1).join(" ")}
        </ArcText>
      ) : null}
      {/* Flat and close together when shut; the upper one lifts away when open */}
      <path d={open ? FLAP_OPEN : FLAP_SHUT} fill="none" stroke={ink} strokeWidth={4} strokeLinecap="round" transform={open ? "rotate(-9 938 330)" : undefined} />
      <path d={MAINPLANE} fill="none" stroke={ink} strokeWidth={4} strokeLinecap="round" />
    </g>
  );
};

type HaloWords = ReturnType<typeof useHaloWords>;
type FlashKind = "sm" | "ovt" | "fastest";
/** How long each call stays (ms) */
const FLASH_MS: Record<FlashKind, number> = { sm: 1700, ovt: 1900, fastest: 2600 };

/**
 * The halo's calls, each for a moment: Straight Mode when the wing opens for a straight, Overtake when it is earned, the
 * fastest lap when the player's lap becomes the race's fastest (not the first fastest lap set). A restart clears them.
 */
function useHaloFlash(t: CarTelemetry, aeroOpen: boolean, armed: boolean): { kind: FlashKind; id: number } | null {
  const runId = t.runId ?? 0;
  let fastest = 0;
  for (const e of t.race?.standings ?? []) if (e.bestLapMs && e.bestLapMs > 0 && (!fastest || e.bestLapMs < fastest)) fastest = e.bestLapMs;
  const mine = t.bestLapTimeMs ?? 0;
  const prev = useRef({ runId, aeroOpen, armed, fastest, id: 0 });
  const [flash, setFlash] = useState<{ kind: FlashKind; id: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    let kind: FlashKind | null = null;
    if (p.runId === runId) {
      if (fastest > 0 && fastest !== p.fastest && p.fastest > 0 && mine > 0 && Math.abs(mine - fastest) < 0.5) kind = "fastest";
      else if (armed && !p.armed) kind = "ovt";
      else if (aeroOpen && !p.aeroOpen) kind = "sm";
    }
    prev.current = { runId, aeroOpen, armed, fastest, id: p.id + (kind ? 1 : 0) };
    if (p.runId !== runId) setFlash(null);
    else if (kind) setFlash({ kind, id: p.id + 1 });
  }, [runId, aeroOpen, armed, fastest, mine]);
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), FLASH_MS[flash.kind]);
    return () => window.clearTimeout(id);
  }, [flash]);
  return flash;
}

/**
 * Where each call's tag rises from, as a share of the shown frame: over the Active Aero bubble, over the dial, over the
 * names bubble (each the frame point it stands on: x, and just over the hoop line there)
 */
const CALL_AT: Record<FlashKind, { left: string; top: string }> = {
  sm: { left: `${((938 - 60) / 1280) * 100}%`, top: `${((166 - 130) / 460) * 100}%` },
  ovt: { left: `${((700 - 60) / 1280) * 100}%`, top: "0%" },
  fastest: { left: `${((259 - 60) / 1280) * 100}%`, top: `${((262 - 130) / 460) * 100}%` },
};

/** A call's tag, rising from the part it is about: the game's notice pill, its colour the call's own */
const HaloCall: React.FC<{ kind: FlashKind; lapMs: number | null; w: HaloWords }> = ({ kind, lapMs, w }) => (
  <div
    role="status"
    className={`${palette.haloCall} absolute z-10 inline-flex h-11 items-center gap-2.5 rounded-lc-row border border-white/10 bg-lc-void/84 pr-4 pl-1.5 whitespace-nowrap shadow-lc-pop`}
    style={{ ...CALL_AT[kind], animationDuration: `${FLASH_MS[kind]}ms` }}
  >
    <Badge
      tone={kind === "sm" ? "info" : kind === "ovt" ? "good" : "best"}
      variant="solid"
      size="lg"
      icon={kind === "sm" ? "drsOpen" : kind === "ovt" ? "overtake" : "time"}
      className="h-8 px-2"
    />
    <span className="lc-disp text-[17px] text-lc-chalk">{kind === "sm" ? w.straightCall : kind === "ovt" ? w.overtakeCall : w.fastestCall}</span>
    {kind === "fastest" ? <span className="lc-data text-[16px] text-lc-best">{formatLapTime(lapMs)}</span> : null}
  </div>
);

/**
 * Race control's chip over the band under a virtual safety car: the car's speed over the target speed here, crimson
 * once more than 2 km/h over it, with a blinking line to slow down, or to give back a place taken under it
 */
const HaloDirector: React.FC<{ t: CarTelemetry; vsc: NonNullable<NonNullable<CarTelemetry["race"]>["vsc"]>; giveBack: boolean; w: HaloWords }> = ({
  t,
  vsc,
  giveBack,
  w,
}) => {
  const units = useUnits();
  const over = t.speedKmh > vsc.speedKmh + 2;
  const extra = over ? w.slowDown : giveBack ? w.giveBack : null;
  return (
    <div className="absolute bottom-full left-1/2 mb-1 flex -translate-x-1/2 flex-col items-center gap-1 rounded-lc-row border border-white/10 bg-lc-void/84 p-1 shadow-lc-pop">
      <div className="flex items-center gap-2 pr-2.5">
        <Badge tone="warn" variant="solid" size="md">
          {w.vsc}
        </Badge>
        <span className="lc-data text-[14px] whitespace-nowrap text-lc-chalk">
          <span style={{ color: over ? HUD_LOSS : undefined }}>{formatSpeed(t.speedKmh, units)}</span>
          <span className="text-lc-slate">{" / "}</span>
          {formatSpeed(vsc.speedKmh, units)} {speedUnit(units)}
        </span>
      </div>
      {extra ? <span className={`${palette.haloBlink} lc-title px-2 pb-0.5 text-[12px] text-lc-loss`}>{extra}</span> : null}
    </div>
  );
};
