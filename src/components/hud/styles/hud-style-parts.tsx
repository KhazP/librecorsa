"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import type { BuiltTrackData } from "@/lib/track-data";
import { HUD_CYAN, HUD_GREEN, HUD_PURPLE, HUD_RED, HUD_VOLT, HUD_YELLOW } from "../hud-format";

/** Circuit outline for the HUD maps, in a 0..1000 box (aspect kept) */
export interface HudMap {
  w: number;
  h: number;
  points: [number, number][];
  path: string;
  sectorPaths: [string, string, string];
  /** Lap length (m) and map units per metre, for placing cars by track distance and the zoomed local map */
  lengthM: number;
  unitsPerM: number;
}

export function buildHudMap(track: BuiltTrackData): HudMap {
  const samples = track.samples;
  const n = samples.length;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.position.x);
    maxX = Math.max(maxX, s.position.x);
    minZ = Math.min(minZ, s.position.z);
    maxZ = Math.max(maxZ, s.position.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const points = samples.map((s) => [((s.position.x - minX) / span) * 1000, ((s.position.z - minZ) / span) * 1000] as [number, number]);
  const toPath = (pts: [number, number][], close: boolean) =>
    pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("") + (close ? "Z" : "");
  const sectorPaths = [1, 2, 3].map((sec) => {
    const idx = samples.flatMap((s, i) => (s.sector === sec ? [i] : []));
    if (!idx.length) return "";
    // One sample of overlap so the sector lines join
    return toPath([...idx, (idx[idx.length - 1] + 1) % n].map((i) => points[i]), false);
  }) as [string, string, string];
  return {
    w: Math.round(((maxX - minX) / span) * 1000),
    h: Math.round(((maxZ - minZ) / span) * 1000),
    points,
    path: toPath(points, true),
    sectorPaths,
    lengthM: track.totalLength,
    unitsPerM: 1000 / span,
  };
}

/** Everything a HUD style gets each frame */
export interface HudDesignProps {
  t: CarTelemetry;
  /** Live delta to the best lap (s, − = faster); null without a best lap */
  deltaS: number | null;
  map: HudMap;
  compound?: TireCompound;
  /** Rev lights: first light → shift point (rpm) */
  revRange: [number, number];
  /** HUD size (each corner group scales about its own corner) */
  scale?: number;
  /** Short circuit code for the tower header */
  trackCode?: string;
  /** Wheel force meter, when the in-race HUD has one */
  ffb?: React.ReactNode;
  /** Live Tuner Multi-Function Display (MFD) */
  mfd?: React.ReactNode;
  /** The on-screen touch controls are up (their Menu / Cam sit top-left) */
  touch?: boolean;
  /** The running lap was cut (off the track at some point): its clock stays red until the next lap */
  lapInvalid?: boolean;
  /** Timing tower gaps: to the car ahead or to the leader */
  towerGaps?: "interval" | "leader";
  /** Circuit map: the whole lap, or zoomed in heading-up around the car */
  mapMode?: "full" | "local";
}

/** Rev light range of the car (the same as the classic speed cluster's) */
export function revRangeOf(t: CarTelemetry): [number, number] {
  return t.f12026?.carId === "amg-gt3" ? [6200, 7500] : [10_800, 14_600];
}

/** Scales a corner group of the HUD about that corner */
export const anchor = (scale: number | undefined, origin: string): React.CSSProperties | undefined =>
  !scale || scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: origin };

/** Racing Line frosted HUD sheet over the live scene; each panel adds its own radius and padding */
export const HUD_GLASS =
  "border border-white/[0.07] bg-[#08090D]/[0.74] shadow-[0_14px_40px_rgba(0,0,0,0.5)] backdrop-blur-[14px]";

/** Racing Line HUD label: mono 800, tracked, slate */
export const HUD_LBL = "font-f1-mono text-[9px] font-extrabold tracking-[0.18em] text-[#8E96AA] uppercase";

/**
 * Positions of `n` lights spread evenly along an arc (centre cx, cy; radius r; ±span/2 degrees
 * from straight up). Call at module scope: the layout is fixed, only the lit count changes.
 */
export function arcPoints(n: number, cx: number, cy: number, r: number, spanDeg: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = ((-spanDeg / 2 + (spanDeg * i) / Math.max(1, n - 1)) * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as [number, number];
  });
}

export const COMPOUND_COLORS: Record<TireCompound, string> = {
  soft: HUD_RED,
  medium: HUD_YELLOW,
  hard: "#F5F7FA",
  intermediate: "#3CCB4A",
  wet: "#2E7BFF",
};

export const SECTOR_COLORS = [HUD_CYAN, HUD_VOLT, "#FF6B8A"] as const;

/** Point on the map outline at a lap fraction */
export function mapPoint(map: HudMap, progress: number): [number, number] {
  const pts = map.points;
  const f = (((progress % 1) + 1) % 1) * pts.length;
  const i = Math.floor(f);
  const a = pts[i % pts.length];
  const b = pts[(i + 1) % pts.length];
  const u = f - i;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** Radius of the zoomed local map (m) */
const LOCAL_RADIUS_M = 360;

/** Direction of travel on the map at a lap fraction (radians, SVG axes), smoothed over a short look-ahead */
function mapHeading(map: HudMap, progress: number): number {
  // ±40 m around the car
  const look = 40 / Math.max(1, map.lengthM);
  const [ax, ay] = mapPoint(map, progress - look);
  const [bx, by] = mapPoint(map, progress + look);
  return Math.atan2(by - ay, bx - ax);
}

/** Circuit outline with the car and, in a race, the field placed by their track position */
export const MiniMap: React.FC<{
  map: HudMap;
  t: CarTelemetry;
  className?: string;
  /** Colour the outline by sector */
  sectors?: boolean;
  stroke?: number;
  outline?: string;
  rivals?: boolean;
  /** Zoomed heading-up map around the car instead of the whole circuit */
  local?: boolean;
}> = ({ map, t, className, sectors = false, stroke = 22, outline = "rgba(245,247,250,0.85)", rivals = true, local = false }) => {
  const [cx, cy] = mapPoint(map, t.trackProgress);
  const [sx, sy] = mapPoint(map, 0);
  const pad = 60;
  const lapS = (t.bestLapTimeMs ?? t.lastLapTimeMs ?? 95_000) / 1000;
  const me = t.race?.standings.find((s) => s.isPlayer);
  const clipId = `lc-map-${useId().replace(/:/g, "")}`;
  const L = map.lengthM || 1;
  const fullW = map.w + pad * 2;
  const r = LOCAL_RADIUS_M * map.unitsPerM;
  // Sizes are drawn for the full map; the zoomed one scales them so they read the same on screen
  const k = local ? (2 * r) / fullW : 1;
  const sw = local ? Math.max(stroke * k, 13 * map.unitsPerM) : stroke;
  const viewBox = local ? `${cx - r} ${cy - r} ${2 * r} ${2 * r}` : `${-pad} ${-pad} ${fullW} ${map.h + pad * 2}`;
  const rot = local ? -90 - (mapHeading(map, t.trackProgress) * 180) / Math.PI : 0;
  const spots =
    rivals && t.race && me
      ? t.race.standings
          .filter((e) => !e.isPlayer)
          .map((e) => ({
            key: e.driverCode,
            color: e.teamColorHex,
            p: e.trackS !== undefined ? e.trackS / L : t.trackProgress + (me.gapToLeaderS - e.gapToLeaderS) / lapS,
          }))
      : (t.peers ?? []).map((p) => ({ key: p.peerId, color: p.teamColorHex, p: p.trackDistanceM / L }));
  return (
    <svg viewBox={viewBox} className={className} aria-hidden>
      {local ? (
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r * 0.98} />
          </clipPath>
        </defs>
      ) : null}
      <g clipPath={local ? `url(#${clipId})` : undefined}>
        <g transform={local ? `rotate(${rot.toFixed(2)} ${cx} ${cy})` : undefined}>
          <path d={map.path} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={sw + 16 * k} strokeLinejoin="round" />
          {sectors ? (
            map.sectorPaths.map((d, i) => (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={SECTOR_COLORS[i]}
                strokeOpacity={i + 1 === t.currentSector ? 1 : 0.45}
                strokeWidth={sw}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))
          ) : (
            <path d={map.path} fill="none" stroke={outline} strokeWidth={sw} strokeLinejoin="round" />
          )}
          <rect x={sx - 6 * k} y={sy - 26 * k} width={12 * k} height={52 * k} fill="#F5F7FA" />
          {spots.map((e) => {
            const [x, y] = mapPoint(map, e.p);
            return <circle key={e.key} cx={x} cy={y} r={20 * k} fill={e.color} stroke="#08090D" strokeWidth={7 * k} />;
          })}
        </g>
      </g>
      {local ? <circle cx={cx} cy={cy} r={r * 0.98} fill="none" stroke="rgba(245,247,250,0.12)" strokeWidth={4 * k} /> : null}
      <circle cx={cx} cy={cy} r={46 * k} fill={HUD_VOLT} opacity={0.22} />
      {local ? (
        // Heading-up: the car is an arrow pointing up the screen
        <path
          d={`M ${cx} ${cy - 34 * k} L ${cx + 22 * k} ${cy + 24 * k} L ${cx} ${cy + 12 * k} L ${cx - 22 * k} ${cy + 24 * k} Z`}
          fill={HUD_VOLT}
          stroke="#08090D"
          strokeWidth={6 * k}
          strokeLinejoin="round"
        />
      ) : (
        <circle cx={cx} cy={cy} r={26} fill={HUD_VOLT} stroke="#08090D" strokeWidth={8} />
      )}
    </svg>
  );
};

/** Sector time colour: purple personal best, green faster than last best, yellow slower */
export function sectorColor(ms: number, best: number | null): string {
  if (!best || ms <= best + 0.5) return HUD_PURPLE;
  if (ms <= best + 150) return HUD_GREEN;
  return HUD_YELLOW;
}

/** The last completed sector, for a few seconds after it completes */
/**
 * True from the moment the car leaves the track until the next lap starts or the run restarts, like the
 * physics' own lap-valid flag: the running clock stays red for the rest of a cut lap, not only while off.
 */
export function useLapInvalid(t: CarTelemetry): boolean {
  // The lap and clock reading when the cut happened; a new lap or a clock that went back clears it
  const [cut, setCut] = useState<{ lap: number; atMs: number } | null>(null);
  const stale = cut !== null && (t.lapCount !== cut.lap || t.currentLapTimeMs < cut.atMs);
  // A physics that judges its own track limits reports the verdict: only a cut that gained time deletes the lap
  const judged = t.lapInvalid !== undefined && t.trackLimits !== undefined;
  if (!judged && t.offTrack && (cut === null || stale)) setCut({ lap: t.lapCount, atMs: t.currentLapTimeMs });
  else if (stale && !t.offTrack) setCut(null);
  if (judged) return Boolean(t.lapInvalid);
  return t.offTrack || (cut !== null && !stale);
}

export function useSectorFlash(t: CarTelemetry, holdMs = 3500): { sector: number; ms: number; color: string } | null {
  const [flash, setFlash] = useState<{ sector: number; ms: number; color: string } | null>(null);
  const prev = useRef({ sector: t.currentSector, lap: t.lapCount });
  useEffect(() => {
    const p = prev.current;
    if (p.sector === t.currentSector && p.lap === t.lapCount) return;
    const done = p.sector;
    const ms = t.lapCount !== p.lap ? (t.lastLapTimeMs ?? 0) : t.sectorTimesMs[done - 1];
    prev.current = { sector: t.currentSector, lap: t.lapCount };
    if (!ms) return;
    const best = t.lapCount !== p.lap ? t.bestLapTimeMs : t.bestSectorTimesMs[done - 1];
    setFlash({ sector: t.lapCount !== p.lap ? 0 : done, ms, color: sectorColor(ms, best) });
    const id = window.setTimeout(() => setFlash(null), holdMs);
    return () => window.clearTimeout(id);
  }, [t.currentSector, t.lapCount, t.lastLapTimeMs, t.sectorTimesMs, t.bestSectorTimesMs, t.bestLapTimeMs, holdMs]);
  return flash;
}

/** The corner just entered, for a couple of seconds */
export function useTurnCaption(t: CarTelemetry, holdMs = 2400): string | null {
  const [caption, setCaption] = useState<string | null>(null);
  const prev = useRef(t.currentTurnNumber);
  useEffect(() => {
    if (prev.current === t.currentTurnNumber) return;
    prev.current = t.currentTurnNumber;
    if (!t.currentTurnNumber) return;
    setCaption(`T${t.currentTurnNumber}${t.currentTurnName ? ` · ${t.currentTurnName}` : ""}`);
    const id = window.setTimeout(() => setCaption(null), holdMs);
    return () => window.clearTimeout(id);
  }, [t.currentTurnNumber, t.currentTurnName, holdMs]);
  return caption;
}

export const gearLabel = (g: number) => (g < 0 ? "R" : g === 0 ? "N" : String(g));

export const deltaColor = (d: number | null) => (d === null ? "#8E96AA" : d <= 0 ? HUD_GREEN : HUD_RED);

/** Gap ahead / behind the player in a race (s), null at the front / back */
export function raceNeighbours(t: CarTelemetry) {
  const st = t.race?.standings;
  if (!st) return null;
  const i = st.findIndex((e) => e.isPlayer);
  const me = st[i];
  const ahead = i > 0 ? st[i - 1] : null;
  const behind = i < st.length - 1 ? st[i + 1] : null;
  return {
    ahead: ahead ? { code: ahead.driverCode, color: ahead.teamColorHex, gap: me.gapToLeaderS - ahead.gapToLeaderS } : null,
    behind: behind ? { code: behind.driverCode, color: behind.teamColorHex, gap: behind.gapToLeaderS - me.gapToLeaderS } : null,
  };
}

export { HUD_CYAN, HUD_GREEN, HUD_PURPLE, HUD_RED, HUD_VOLT, HUD_YELLOW };
