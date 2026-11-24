"use client";

import React, { useEffect, useRef, useState } from "react";
import type { CarTelemetry, PlayerDamageStatus, RaceStandingEntry } from "@/types/f1";
import type { CarClassCode } from "@/components/ui/badges/class-colors";
import { CLASSIC_CAR_IDS, HUD_CAUTION, HUD_LOSS, PROTO_CAR_IDS, ROAD_CAR_IDS, lapMark, tyreHeatColor, type LapMark } from "../hud-format";
import { sessionBestLapMs } from "../third-party-data";

/**
 * Readings the GT-Like and F1-Like layouts share: a completed sector or lap held for a moment with its gap to the best
 * it was racing, the gear to be in on the way into a corner, what the energy store is doing, the car's class and who
 * holds the fastest lap. The game's own layouts, drawn in the game's own look.
 */

/** A sector or lap just completed, as the layouts' lap timers flash it */
export interface TimingEvent {
  /** 1–3 for a sector, 0 for the lap */
  sector: number;
  ms: number;
  /** Against the best this sector or lap had before it was driven (ms, − = quicker); null with no best yet */
  gapMs: number | null;
  /** Session best, personal best or slower (`lapMark`) */
  mark: LapMark;
  /** A new one each time, so a repeat of the same reading still shows */
  id: number;
}

/**
 * The sector or lap the car has just completed, for `holdMs` after it completes, compared with the best it had before
 * this one was driven (the bests in the frame the line was crossed may already hold the new time). The out-lap's lines
 * and a restart are not completions. A lap is marked against the session's best (the field's in a race), a sector
 * against the player's own, since nobody else's sectors are known.
 */
export function useTimingEvent(t: CarTelemetry, holdMs = 3000): TimingEvent | null {
  const runId = t.runId ?? 0;
  const [event, setEvent] = useState<TimingEvent | null>(null);
  const prev = useRef({
    sector: t.currentSector,
    lap: t.lapCount,
    runId,
    outLap: Boolean(t.outLap),
    bestSectors: [...t.bestSectorTimesMs] as (number | null)[],
    bestLap: t.bestLapTimeMs,
    sessionBest: sessionBestLapMs(t),
    id: 0,
  });
  useEffect(() => {
    const p = prev.current;
    const edge = p.sector !== t.currentSector || p.lap !== t.lapCount || p.runId !== runId;
    const next = {
      sector: t.currentSector,
      lap: t.lapCount,
      runId,
      outLap: Boolean(t.outLap),
      bestSectors: [...t.bestSectorTimesMs] as (number | null)[],
      bestLap: t.bestLapTimeMs,
      sessionBest: sessionBestLapMs(t),
      id: p.id,
    };
    if (!edge) {
      // The bests are followed between edges, so an edge compares with the ones from before it
      prev.current = next;
      return;
    }
    prev.current = { ...next, id: p.id + 1 };
    if (p.runId !== runId) {
      setEvent(null);
      return;
    }
    if (p.outLap) return;
    const lapDone = t.lapCount !== p.lap;
    const ms = lapDone ? (t.lastLapTimeMs ?? 0) : t.sectorTimesMs[p.sector - 1];
    if (!ms) return;
    const before = lapDone ? p.bestLap : p.bestSectors[p.sector - 1];
    // A sector with nothing to compare it with (the first lap's) isn't called out; a first lap still shows its time
    if (!lapDone && !(before && before > 0)) return;
    const gapMs = before && before > 0 ? ms - before : null;
    const solo = !t.race;
    // A lap at or under the session's best (the field's) is the session best; at the player's own, a personal best
    const mark: LapMark = lapDone
      ? p.sessionBest && ms <= p.sessionBest + 0.5
        ? "best"
        : lapMark(ms, before, false) === "slower"
          ? "slower"
          : solo
            ? "best"
            : "pb"
      : lapMark(ms, before, solo);
    setEvent({ sector: lapDone ? 0 : p.sector, ms, gapMs, mark, id: p.id + 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.currentSector, t.lapCount, runId, t.outLap, t.lastLapTimeMs, t.sectorTimesMs, t.bestSectorTimesMs, t.bestLapTimeMs, t.race]);
  useEffect(() => {
    if (!event) return;
    const id = window.setTimeout(() => setEvent(null), holdMs);
    return () => window.clearTimeout(id);
  }, [event, holdMs]);
  return event;
}

/** How hard the car must be braking for the hint to count as a corner approach */
const APPROACH_URGENCY = 0.35;
/** The share of the shift point a suggested gear may reach at the target speed */
const GEAR_TOP_SHARE = 0.94;

/**
 * The gear to be in on the way into a corner, as a road-racing game hints it beside the gear: the lowest gear whose
 * reach (the shift point at its ratio) still covers the speed the racing line wants here. The ratios are learned from
 * the car itself (engine rpm per km/h in each gear with the clutch in and the tyres gripping), so a gear only counts
 * once it has been driven; the hint waits until the gear under it is known too, so it never suggests a gear too high.
 * It only counts down through an approach and clears once the car is back on the throttle. Null when there is
 * nothing to suggest, or the suggestion is the gear already in.
 */
export function useGearHint(t: CarTelemetry, revFull: number): number | null {
  const ratios = useRef(new Map<number, number>());
  const carRef = useRef(t.f12026?.carId ?? "");
  const lowest = useRef<number | null>(null);
  const [hint, setHint] = useState<number | null>(null);
  useEffect(() => {
    const car = t.f12026?.carId ?? "";
    if (car !== carRef.current) {
      carRef.current = car;
      ratios.current.clear();
      lowest.current = null;
    }
    const gripping = Math.max(...t.tireSlipRatio) < 0.3;
    if (t.gear >= 1 && t.speedKmh > 25 && t.clutch > 0.95 && gripping && t.rpm > 0) {
      const r = t.rpm / t.speedKmh;
      const old = ratios.current.get(t.gear);
      ratios.current.set(t.gear, old === undefined ? r : old + (r - old) * 0.08);
    }
    const target = t.targetCornerSpeedKmh;
    const approaching = !t.aiAutopilot && t.gear >= 2 && target > 0 && (t.brakingUrgency >= APPROACH_URGENCY || (t.brake > 0.25 && target < t.speedKmh - 8));
    if (approaching) {
      let pick: number | null = null;
      for (let g = 1; g <= t.gear; g++) {
        const r = ratios.current.get(g);
        if (r === undefined) continue;
        if ((revFull * GEAR_TOP_SHARE) / r >= target) {
          // The gear under it must be known as well, or a lower gear might cover the speed too
          if (g === 1 || ratios.current.has(g - 1)) pick = g;
          break;
        }
      }
      if (pick !== null) lowest.current = lowest.current === null ? pick : Math.min(lowest.current, pick);
    } else if (t.throttle > 0.5 || t.speedKmh < 20) {
      // Back on the throttle (or stopped): this corner is done
      lowest.current = null;
    }
    const shown = lowest.current !== null && lowest.current < t.gear ? lowest.current : null;
    setHint((h) => (h === shown ? h : shown));
  }, [
    t.f12026?.carId,
    t.gear,
    t.speedKmh,
    t.clutch,
    t.rpm,
    t.tireSlipRatio,
    t.targetCornerSpeedKmh,
    t.brakingUrgency,
    t.brake,
    t.throttle,
    t.aiAutopilot,
    revFull,
  ]);
  return hint;
}

/** The racing line wants the brakes on now: the braking point has been reached at this speed */
export function brakeNow(t: Pick<CarTelemetry, "brakingUrgency" | "aiAutopilot" | "speedKmh" | "brake">): boolean {
  return !t.aiAutopilot && t.brakingUrgency >= 0.95 && t.speedKmh > 40 && t.brake < 0.5;
}

/**
 * What the hybrid's energy store is doing, read the way 2026 energy data names it: deploying, clipped (flat out with
 * the deployment tapered away), super clip (harvesting flat out), harvesting under braking, lift and coast, a trickle
 * charge on part throttle, or neutral; Overtake or Boost while the driver's own extra power is on.
 */
export type ErsState = "boost" | "overtake" | "deploy" | "clipped" | "superclip" | "braking" | "liftCoast" | "trickle" | "neutral";

/** Below this the MGU-K counts as idle (kW) */
const ERS_IDLE_KW = 6;

export function ersStateOf(
  t: Pick<
    CarTelemetry,
    "mgukPowerKw" | "throttle" | "brake" | "speedKmh" | "manualOverrideActive" | "overtakingRules" | "overtakeAvailable" | "ersBoostActive" | "overtakeInUse"
  >,
): ErsState {
  const kw = t.mgukPowerKw;
  if (kw > ERS_IDLE_KW) {
    if (t.ersBoostActive !== undefined) {
      if (t.overtakeInUse) return "overtake";
      if (t.ersBoostActive) return "boost";
      return "deploy";
    }
    if (t.manualOverrideActive && !(t.overtakingRules === "straight-mode-2026" && t.overtakeAvailable === false)) return "overtake";
    return "deploy";
  }
  if (kw < -ERS_IDLE_KW) {
    if (t.brake > 0.08) return "braking";
    if (t.throttle >= 0.95) return "superclip";
    if (t.throttle < 0.08) return "liftCoast";
    return "trickle";
  }
  if (t.throttle >= 0.95 && t.speedKmh > 150) return "clipped";
  return "neutral";
}

/** The energy state held for a moment, so a single frame between two states doesn't flicker the word */
export function useErsState(t: CarTelemetry, holdMs = 220): ErsState {
  const raw = ersStateOf(t);
  const [shown, setShown] = useState<ErsState>(raw);
  useEffect(() => {
    if (raw === shown) return;
    const id = window.setTimeout(() => setShown(raw), holdMs);
    return () => window.clearTimeout(id);
  }, [raw, shown, holdMs]);
  return shown;
}

/** The player's car class, as the class tags name it */
export function carClassCode(t: Pick<CarTelemetry, "f12026">): CarClassCode {
  const id = t.f12026?.carId ?? "";
  if (id === "amg-gt3" || id.includes("gt3")) return "gt3";
  if (ROAD_CAR_IDS.has(id)) return "road";
  if (PROTO_CAR_IDS.has(id)) return "proto";
  if (CLASSIC_CAR_IDS.has(id)) return "classic";
  return "openWheel";
}

/** Who holds the race's fastest lap, and the time; null before anyone has one */
export function fastestLap(t: Pick<CarTelemetry, "race">): { entry: RaceStandingEntry; ms: number } | null {
  let best: { entry: RaceStandingEntry; ms: number } | null = null;
  for (const e of t.race?.standings ?? []) {
    if (e.bestLapMs && e.bestLapMs > 0 && (best === null || e.bestLapMs < best.ms)) best = { entry: e, ms: e.bestLapMs };
  }
  return best;
}

/** The race is on its last lap */
export function onFinalLap(t: Pick<CarTelemetry, "race">): boolean {
  const r = t.race;
  return Boolean(r && r.phase === "racing" && r.totalLaps && r.lap >= r.totalLaps);
}

/** A point on a circle (centre cx, cy; radius r) at `deg` clockwise from straight up */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

/** An SVG arc path from `fromDeg` to `toDeg` (clockwise from straight up) */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${toDeg >= fromDeg ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Damage zone fill: titanium when clean, caution amber when worn, loss crimson when heavy */
export function damageZoneColor(level: number): string {
  return level >= 0.4 ? HUD_LOSS : level >= 0.1 ? HUD_CAUTION : "var(--color-lc-titanium)";
}

/** Damage zone stroke: subtle chalk edge when clean, lit semantic edge when damaged */
function damageEdgeColor(level: number): { stroke: string; strokeOpacity: number } {
  if (level >= 0.4) return { stroke: HUD_LOSS, strokeOpacity: 0.9 };
  if (level >= 0.1) return { stroke: HUD_CAUTION, strokeOpacity: 0.85 };
  return { stroke: "var(--color-lc-chalk)", strokeOpacity: 0.32 };
}

/**
 * Top-down vector silhouette of an open-wheel car or a closed-cockpit coupe in a 100 × 144 coordinate space,
 * centred at (50, 72). Each aero/body zone and suspension corner reflects live damage, and the optional four wheels
 * carry live tyre temperature and puncture state.
 */
export const TopDownCar: React.FC<{
  openWheel: boolean;
  damage?: PlayerDamageStatus;
  t?: Pick<CarTelemetry, "tireTempsC" | "tireOptimalTempC">;
  showWheels?: boolean;
}> = ({ openWheel, damage, t, showWheels = true }) => {
  const front = damage?.front ?? 0;
  const rear = damage?.rear ?? 0;
  const left = damage?.left ?? 0;
  const right = damage?.right ?? 0;
  const susp = damage?.suspension ?? [0, 0, 0, 0];
  const baseEdge = { stroke: "var(--color-lc-chalk)", strokeOpacity: 0.32, strokeWidth: 0.9 };

  const wheel = (x: number, y: number, w: number, h: number, i: number) => {
    const punctured = Boolean(damage?.punctured[i]);
    const fill = punctured ? HUD_LOSS : t ? tyreHeatColor(t.tireTempsC[i], t.tireOptimalTempC) : "var(--color-lc-titanium)";
    return (
      <g key={i}>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={3}
          fill={fill}
          stroke={punctured ? "var(--color-lc-chalk)" : "var(--color-lc-void)"}
          strokeWidth={punctured ? 1.1 : 1.2}
          strokeDasharray={punctured ? "2 1.5" : undefined}
        />
        <line
          x1={x + w / 2}
          y1={y + 3}
          x2={x + w / 2}
          y2={y + h - 3}
          stroke="var(--color-lc-void)"
          strokeOpacity={0.22}
          strokeWidth={1.2}
        />
      </g>
    );
  };

  if (openWheel) {
    const suspStroke = (i: number) => ({
      stroke: susp[i] >= 0.4 ? HUD_LOSS : susp[i] >= 0.1 ? HUD_CAUTION : "var(--color-lc-chalk)",
      strokeOpacity: susp[i] >= 0.1 ? 0.95 : 0.42,
      strokeWidth: 1.5,
      strokeLinecap: "round" as const,
    });
    return (
      <g>
        {/* Front suspension wishbones */}
        <path d="M44 30 L28 33 M43 41 L28 38" fill="none" {...suspStroke(0)} />
        <path d="M56 30 L72 33 M57 41 L72 38" fill="none" {...suspStroke(1)} />
        {/* Rear suspension wishbones */}
        <path d="M40 105 L28 106 M42 114 L28 113" fill="none" {...suspStroke(2)} />
        <path d="M60 105 L72 106 M58 114 L72 113" fill="none" {...suspStroke(3)} />

        {/* Swept multi-element front wing and endplates */}
        <path d="M21 15 Q50 6 79 15 L81 21 Q50 15 19 21 Z" fill={damageZoneColor(front)} {...damageEdgeColor(front)} strokeWidth={0.95} />
        <path d="M24 18.5 Q50 12.5 76 18.5" fill="none" stroke="var(--color-lc-void)" strokeOpacity={0.45} strokeWidth={0.9} />
        <rect x={18} y={13} width={3} height={10} rx={1} fill={damageZoneColor(front)} {...damageEdgeColor(front)} strokeWidth={0.8} />
        <rect x={79} y={13} width={3} height={10} rx={1} fill={damageZoneColor(front)} {...damageEdgeColor(front)} strokeWidth={0.8} />

        {/* Underfloor & coke-bottle chassis */}
        <path
          d="M42 46 L58 46 L68 56 L70 92 L62 113 L56 121 L44 121 L38 113 L30 92 L32 56 Z"
          fill="var(--color-lc-carbon)"
          {...baseEdge}
        />

        {/* Sculpted left & right sidepods */}
        <path
          d="M32 56 Q37 51 43 56 L42 97 Q36 99 31 89 Z"
          fill={damageZoneColor(left)}
          {...damageEdgeColor(left)}
          strokeWidth={0.9}
        />
        <path
          d="M68 56 Q63 51 57 56 L58 97 Q64 99 69 89 Z"
          fill={damageZoneColor(right)}
          {...damageEdgeColor(right)}
          strokeWidth={0.9}
        />

        {/* Tapered nosecone & bulkhead */}
        <path
          d="M46.5 11 Q50 8.5 53.5 11 L57 50 L43 50 Z"
          fill={damageZoneColor(front * 0.75)}
          {...damageEdgeColor(front * 0.75)}
          strokeWidth={0.9}
        />

        {/* Cockpit surround, halo hoop & airbox spine */}
        <path d="M44 53 Q50 50 56 53 L55 75 Q50 78 45 75 Z" fill="var(--color-lc-void)" stroke="var(--color-lc-chalk)" strokeOpacity={0.25} strokeWidth={0.8} />
        <path d="M45.5 69 Q45.5 55.5 50 53.5 Q54.5 55.5 54.5 69 M50 53.5 L50 47.5" fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.75} strokeWidth={1.6} strokeLinecap="round" />
        <path d="M46 77 L54 77 L52 116 L48 116 Z" fill="var(--color-lc-titanium)" {...baseEdge} />
        <line x1={50} y1={79} x2={50} y2={116} stroke="var(--color-lc-chalk)" strokeOpacity={0.28} strokeWidth={0.8} />

        {/* Dual-element rear wing & endplates */}
        <path d="M26 124 L74 124 L74 134 L26 134 Z" fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.95} />
        <line x1={28} y1={129} x2={72} y2={129} stroke="var(--color-lc-void)" strokeOpacity={0.45} strokeWidth={0.9} />
        <rect x={23} y={121} width={3} height={15} rx={1} fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.8} />
        <rect x={74} y={121} width={3} height={15} rx={1} fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.8} />

        {showWheels ? (
          <>
            {wheel(17, 25, 11, 21, 0)}
            {wheel(72, 25, 11, 21, 1)}
            {wheel(15, 97, 13, 24, 2)}
            {wheel(72, 97, 13, 24, 3)}
          </>
        ) : null}
      </g>
    );
  }

  return (
    <g>
      {/* Wide-body GT / closed-cockpit silhouette */}
      <path
        d="M30 14 Q50 7 70 14 Q77 20 78 34 L77 52 L75 94 L78 108 Q77 126 70 131 Q50 136 30 131 Q23 126 22 108 L25 94 L23 52 L22 34 Q23 20 30 14 Z"
        fill="var(--color-lc-carbon)"
        {...baseEdge}
      />
      {/* Front splitter & nose */}
      <path d="M27 16 Q50 8 73 16 L76 26 Q50 21 24 26 Z" fill={damageZoneColor(front)} {...damageEdgeColor(front)} strokeWidth={0.95} />
      {/* Bonnet vents */}
      <path d="M38 29 L45 29 L44 38 L37 38 Z M55 29 L62 29 L63 38 L56 38 Z" fill="var(--color-lc-void)" fillOpacity={0.55} />
      {/* Side sills & mirrors */}
      <path d="M23 50 L29 53 L29 91 L23 94 Z" fill={damageZoneColor(left)} {...damageEdgeColor(left)} strokeWidth={0.85} />
      <path d="M24 47 L17 49 L17 52.5 L24 52 Z" fill={damageZoneColor(left)} {...damageEdgeColor(left)} strokeWidth={0.75} />
      <path d="M77 50 L71 53 L71 91 L77 94 Z" fill={damageZoneColor(right)} {...damageEdgeColor(right)} strokeWidth={0.85} />
      <path d="M76 47 L83 49 L83 52.5 L76 52 Z" fill={damageZoneColor(right)} {...damageEdgeColor(right)} strokeWidth={0.75} />
      {/* Windshield, roof & rear glass */}
      <path d="M31 44 Q50 38 69 44 L64 58 Q50 55 36 58 Z" fill="var(--color-lc-void)" fillOpacity={0.85} stroke="var(--color-lc-chalk)" strokeOpacity={0.22} strokeWidth={0.7} />
      <path d="M36 58 Q50 56 64 58 L62 86 Q50 88 38 86 Z" fill="var(--color-lc-titanium)" stroke="var(--color-lc-chalk)" strokeOpacity={0.22} strokeWidth={0.7} />
      <path d="M38 86 Q50 88 62 86 L65 106 Q50 109 35 106 Z" fill="var(--color-lc-void)" fillOpacity={0.78} stroke="var(--color-lc-chalk)" strokeOpacity={0.18} strokeWidth={0.7} />
      {/* Rear bumper & GT wing */}
      <path d="M26 116 Q50 120 74 116 L71 130 Q50 135 29 130 Z" fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.9} />
      <rect x={21} y={123} width={58} height={7} rx={1.5} fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.9} />
      <rect x={19} y={121} width={2.5} height={11} rx={1} fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.75} />
      <rect x={78.5} y={121} width={2.5} height={11} rx={1} fill={damageZoneColor(rear)} {...damageEdgeColor(rear)} strokeWidth={0.75} />

      {showWheels ? (
        <>
          {wheel(17, 26, 9.5, 21, 0)}
          {wheel(73.5, 26, 9.5, 21, 1)}
          {wheel(17, 97, 9.5, 22, 2)}
          {wheel(73.5, 97, 9.5, 22, 3)}
        </>
      ) : null}
    </g>
  );
};
