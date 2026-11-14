"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { CarTelemetry, TireCompound } from "@/types/f1";
import { inDeadZone, type BuiltTrackData, type PointToPointDef } from "@/lib/track-data";
import { Badge, type BadgeSize } from "@/components/ui/Badge";
import { CHOSEN_PILL, cx, DISABLED, HOVER_PILL, MOTION, PRESSED_PILL } from "@/components/ui/styles";
import { Trend } from "@/components/ui/icons/Trend";
import {
  HUD_CYAN,
  HUD_GAIN,
  HUD_GLASS,
  HUD_GREEN,
  HUD_LBL,
  HUD_LOSS,
  HUD_PINK,
  HUD_PURPLE,
  HUD_RED,
  HUD_SLATE,
  HUD_VOLT,
  HUD_YELLOW,
  formatDelta,
  LAP_MARK_COLOR,
  LAP_MARK_WORD,
  NO_TIME,
  lapMark,
  revRangeFor,
  sectorTimeColor,
  type LapMark,
} from "../hud-format";

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

/** What an outline needs: the centreline samples (x / z, sector) and the lap length. A built track has them; so does a raw `track_data.json` mapped over */
export interface HudMapSource {
  samples: readonly { position: { x: number; z: number }; sector: number }[];
  totalLengthM: BuiltTrackData["totalLengthM"];
  /** A point-to-point course (a hill climb): its map is its road, without the stretch that closes its loop */
  pointToPoint?: PointToPointDef;
}

export function buildHudMap(track: HudMapSource): HudMap {
  const samples = track.samples;
  const n = samples.length;
  const p2p = track.pointToPoint;
  // The samples drawn, in driving order: a point-to-point course's road from its start (before the start line) to its
  // end past the finish; a circuit's whole lap. Every sample keeps its point: cars are placed by lap fraction
  const startI = p2p ? Math.ceil((p2p.startS / track.totalLengthM) * n) % n : 0;
  const order = Array.from({ length: n }, (_, k) => (startI + k) % n).filter(
    (i) => !p2p || !inDeadZone(p2p, (i / n) * track.totalLengthM)
  );
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const i of order) {
    const s = samples[i];
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
    // Each run of the sector in driving order, with one sample of overlap so the sector lines join
    const runs: number[][] = [];
    order.forEach((i, k) => {
      if (samples[i].sector !== sec) return;
      const prev = k > 0 && samples[order[k - 1]].sector === sec;
      if (!prev) runs.push([]);
      runs[runs.length - 1].push(i);
      const next = order[k + 1] ?? (p2p ? undefined : order[0]);
      if (next !== undefined && samples[next].sector !== sec) runs[runs.length - 1].push(next);
    });
    return runs.map((r) => toPath(r.map((i) => points[i]), false)).join("");
  }) as [string, string, string];
  return {
    w: Math.round(((maxX - minX) / span) * 1000),
    h: Math.round(((maxZ - minZ) / span) * 1000),
    points,
    path: toPath(order.map((i) => points[i]), !p2p),
    sectorPaths,
    lengthM: track.totalLengthM,
    unitsPerM: 1000 / span,
  };
}

/** Everything a HUD style gets each frame */
export interface HudDesignProps {
  /** Shown under the top-left group (split gaps): keeps the middle of the screen clear */
  leftExtra?: React.ReactNode;
  /** Shown under the top-right group (weather) */
  rightExtra?: React.ReactNode;
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
  /** The running lap was cut (`useLapInvalid`, the one reading every style shows): its clock stays red until the next lap */
  lapInvalid: boolean;
  /** Timing tower gaps: to the car ahead or to the leader */
  towerGaps?: "interval" | "leader";
  /** Circuit map: the whole lap, or zoomed in heading-up around the car */
  mapMode?: "full" | "local";
}

/** Rev light range of the car (the same as the classic speed cluster's) */
export function revRangeOf(t: CarTelemetry): [number, number] {
  return revRangeFor(t.f12026?.carId);
}

/** Scales a corner group of the HUD about that corner */
export const anchor = (scale: number | undefined, origin: string): React.CSSProperties | undefined =>
  !scale || scale === 1 ? undefined : { transform: `scale(${scale})`, transformOrigin: origin };

/** The one HUD glass and the one HUD label (hud-format), for the styles that import them from here */
export { HUD_GLASS, HUD_LBL };

/*
 * The HUD's own small controls (MFD page tabs and fold buttons, the tuner's strips and round buttons, the replay
 * speeds): drawn smaller than the kit's parts and driven by the D-pad, so they are built here once from the kit's
 * recipes (ui/styles.ts) and every one of them uses these. The cursor shows for the keyboard and the pad only, so a
 * click with the mouse never leaves a volt tab behind over the driving view.
 */
/** The cursor: the volt fill with void ink and the halo (focus-visible, and any focus with a pad) */
const HUD_CURSOR = cx(
  "outline-none focus-visible:outline-none",
  "focus-visible:bg-lc-volt focus-visible:text-lc-void focus-visible:inset-ring-transparent focus-visible:shadow-lc-focus",
  "in-data-[input=pad]:focus:bg-lc-volt in-data-[input=pad]:focus:text-lc-void in-data-[input=pad]:focus:inset-ring-transparent",
);
/** On a touch screen the hit area grows to 44 px round a drawing as small as 24 px */
const HUD_HIT = "relative pointer-coarse:before:absolute pointer-coarse:before:-inset-2.5 pointer-coarse:before:content-['']";
/** Every HUD control: hover, pressed, cursor, disabled and the touch hit area */
export const HUD_CONTROL = cx("cursor-pointer", MOTION, HOVER_PILL, PRESSED_PILL, HUD_CURSOR, DISABLED, HUD_HIT);
/** The option a HUD control is on (chalk on line with a lit hairline, never volt) */
export const HUD_CHOSEN = CHOSEN_PILL;
/** An option it is not on */
export const HUD_IDLE = "text-lc-slate";

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

export { COMPOUND_COLORS } from "../hud-format";

/** Sector colours on the circuit maps (docs/DESIGN.md §2): identity, not state */
export const SECTOR_COLORS = [HUD_CYAN, HUD_VOLT, HUD_PINK] as const;

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
}> = ({ map, t, className, sectors = false, stroke = 22, outline = "var(--color-lc-chalk)", rivals = true, local = false }) => {
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
          <path d={map.path} fill="none" stroke="var(--color-lc-void)" strokeOpacity={0.6} strokeWidth={sw + 16 * k} strokeLinejoin="round" />
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
            <path d={map.path} fill="none" stroke={outline} strokeOpacity={0.85} strokeWidth={sw} strokeLinejoin="round" />
          )}
          <rect x={sx - 6 * k} y={sy - 26 * k} width={12 * k} height={52 * k} fill="var(--color-lc-chalk)" />
          {spots.map((e) => {
            const [x, y] = mapPoint(map, e.p);
            return <circle key={e.key} cx={x} cy={y} r={20 * k} fill={e.color} stroke="var(--color-lc-void)" strokeWidth={7 * k} />;
          })}
        </g>
      </g>
      {local ? <circle cx={cx} cy={cy} r={r * 0.98} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.12} strokeWidth={4 * k} /> : null}
      <circle cx={cx} cy={cy} r={46 * k} fill={HUD_VOLT} opacity={0.22} />
      {/* A chalk ring keeps the player's volt dot apart from sector 2's volt line */}
      {local ? null : <circle cx={cx} cy={cy} r={36} fill="none" stroke="var(--color-lc-chalk)" strokeWidth={6} />}
      {local ? (
        // Heading-up: the car is an arrow pointing up the screen
        <path
          d={`M ${cx} ${cy - 34 * k} L ${cx + 22 * k} ${cy + 24 * k} L ${cx} ${cy + 12 * k} L ${cx - 22 * k} ${cy + 24 * k} Z`}
          fill={HUD_VOLT}
          stroke="var(--color-lc-void)"
          strokeWidth={6 * k}
          strokeLinejoin="round"
        />
      ) : (
        <circle cx={cx} cy={cy} r={26} fill={HUD_VOLT} stroke="var(--color-lc-void)" strokeWidth={8} />
      )}
    </svg>
  );
};

/** Sector time colour (see `lapMark`): purple the session best, green a personal best, amber slower */
export const sectorColor = sectorTimeColor;

/**
 * The sign that goes with a sector or lap colour, so the colour is never alone: an up arrow for a best, a down arrow
 * for slower. Sizes with the text beside it.
 */
export const LapMarkGlyph: React.FC<{ mark: LapMark; className?: string }> = ({ mark, className = "" }) => (
  <span className={`inline-flex shrink-0 ${className}`} style={{ color: LAP_MARK_COLOR[mark] }}>
    <Trend direction={mark === "slower" ? "down" : "up"} label={LAP_MARK_WORD[mark]} />
  </span>
);

/** The running lap was cut: the word beside the crimson clock, in every style */
export const InvalidTag: React.FC<{ className?: string }> = ({ className = "" }) => (
  <Badge tone="bad" variant="solid" size="hud" icon="trackLimits" className={className}>
    Invalid
  </Badge>
);

export { lapMark, type LapMark };

/**
 * True from the moment the car leaves the track until the next lap starts or the run restarts, like the
 * physics' own lap-valid flag: the running clock stays red for the rest of a cut lap, not only while off.
 * A physics that judges its own track limits reports the verdict instead, and then no cut is kept at all.
 */
export function useLapInvalid(t: CarTelemetry): boolean {
  // The run, lap and clock reading when the cut happened; a new run, a new lap or a clock that went back clears it
  const [cut, setCut] = useState<{ runId: number; lap: number; atMs: number } | null>(null);
  const runId = t.runId ?? 0;
  const stale = cut !== null && (runId !== cut.runId || t.lapCount !== cut.lap || t.currentLapTimeMs < cut.atMs);
  // A physics that judges its own track limits reports the verdict: only a cut that gained time deletes the lap
  const judged = t.lapInvalid !== undefined && t.trackLimits !== undefined;
  // Updated in an effect, not during render; the value below never depends on the update having landed
  useEffect(() => {
    if (judged) {
      if (cut !== null) setCut(null);
    } else if (t.offTrack && (cut === null || stale)) {
      setCut({ runId, lap: t.lapCount, atMs: t.currentLapTimeMs });
    } else if (stale) {
      setCut(null);
    }
  }, [judged, t.offTrack, cut, stale, runId, t.lapCount, t.currentLapTimeMs]);
  if (judged) return Boolean(t.lapInvalid);
  return t.offTrack || (cut !== null && !stale);
}

/** The last completed sector (or lap), for a few seconds after it completes; a new run clears it */
export function useSectorFlash(t: CarTelemetry, holdMs = 3500): { sector: number; ms: number; color: string; mark: LapMark } | null {
  const [flash, setFlash] = useState<{ sector: number; ms: number; color: string; mark: LapMark } | null>(null);
  const runId = t.runId ?? 0;
  const prev = useRef({ sector: t.currentSector, lap: t.lapCount, runId });
  // Edges only set the flash; its timer belongs to the flash itself, so a frame that changes a dependency without an
  // edge can no longer cancel it
  useEffect(() => {
    const p = prev.current;
    if (p.sector === t.currentSector && p.lap === t.lapCount && p.runId === runId) return;
    prev.current = { sector: t.currentSector, lap: t.lapCount, runId };
    if (p.runId !== runId) {
      // A restart is not a completed sector
      setFlash(null);
      return;
    }
    const done = p.sector;
    const ms = t.lapCount !== p.lap ? (t.lastLapTimeMs ?? 0) : t.sectorTimesMs[done - 1];
    if (!ms) return;
    const best = t.lapCount !== p.lap ? t.bestLapTimeMs : t.bestSectorTimesMs[done - 1];
    const mark = lapMark(ms, best, !t.race);
    setFlash({ sector: t.lapCount !== p.lap ? 0 : done, ms, color: LAP_MARK_COLOR[mark], mark });
  }, [t.currentSector, t.lapCount, runId, t.lastLapTimeMs, t.sectorTimesMs, t.bestSectorTimesMs, t.bestLapTimeMs, t.race]);
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), holdMs);
    return () => window.clearTimeout(id);
  }, [flash, holdMs]);
  return flash;
}

export const gearLabel = (g: number) => (g < 0 ? "R" : g === 0 ? "N" : String(g));

/** Live delta colour: gaining or level, losing, or slate without a reference lap (semantic, so the palette applies) */
export const deltaColor = (d: number | null) => (d === null ? HUD_SLATE : d <= 0 ? HUD_GAIN : HUD_LOSS);

/** Gap ahead / behind the player in a race (s), null at the front / back */
export function raceNeighbours(t: CarTelemetry) {
  const st = t.race?.standings;
  if (!st) return null;
  const i = st.findIndex((e) => e.isPlayer);
  if (i < 0) return null;
  const me = st[i];
  const ahead = i > 0 ? st[i - 1] : null;
  const behind = i < st.length - 1 ? st[i + 1] : null;
  return {
    ahead: ahead ? { code: ahead.driverCode, color: ahead.teamColorHex, gap: me.gapToLeaderS - ahead.gapToLeaderS } : null,
    behind: behind ? { code: behind.driverCode, color: behind.teamColorHex, gap: behind.gapToLeaderS - me.gapToLeaderS } : null,
  };
}

export { HUD_CYAN, HUD_GREEN, HUD_PURPLE, HUD_RED, HUD_VOLT, HUD_YELLOW };

/** The flaps' state as a HUD badge: info filled while open, outlined while armed, neutral shut */
export const AeroBadge: React.FC<{ open: boolean; armed: boolean; label: string; size?: BadgeSize; className?: string }> = ({
  open,
  armed,
  label,
  size = "hud",
  className = "",
}) => (
  <Badge
    tone={open || armed ? "info" : "neutral"}
    variant={open ? "solid" : armed ? "outline" : "soft"}
    size={size}
    icon={open ? "drsOpen" : "drsClosed"}
    className={`w-fit ${className}`}
  >
    {label}
  </Badge>
);

/**
 * A big live delta read-out for the tiles and dash cells: the arrow and the signed time (clamped to ±99.999), in the
 * current colour, so the tile or cell decides the tone. Placeholder without a reference lap.
 */
export const DeltaReadout: React.FC<{ deltaS: number | null; className?: string }> = ({ deltaS, className = "" }) => {
  if (deltaS === null) return <span className={`lc-data leading-none whitespace-nowrap ${className}`}>{NO_TIME}</span>;
  const text = formatDelta(Math.max(-99.999, Math.min(99.999, deltaS)));
  const level = text.startsWith("\u00b1");
  return (
    <span className={`lc-data inline-flex items-center gap-1 leading-none whitespace-nowrap ${className}`}>
      <Trend direction={level ? "level" : deltaS < 0 ? "up" : "down"} size="0.6em" />
      {text}
    </span>
  );
};
