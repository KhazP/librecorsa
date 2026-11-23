"use client";

/*
 * RaceVision layout: a recreation of the look and layout of RaceVision's overlays (standings, relative, the inputs
 * pill and the input graph) for LibreCorsa's own telemetry.
 *
 * Source: https://github.com/mpavich2/RaceVision by mpavich2. Its licence is MIT; the repository's LICENSE reads
 * "Copyright (c) 2015-present Electron React Boilerplate" (the full text is in THIRD_PARTY_NOTICES.md). No code, font,
 * icon or image is copied: the layout is redrawn with the game's kit (Geist Mono for the source's JetBrains Mono, our
 * own ABS ring for its icon) and its colours live in racevision.module.css.
 *
 * Kept: black overlay windows; the standings with the white position box, the class stripe (here the team colour),
 * centred names, gap, best and last laps (purple session best, green personal best); the relative with grey rounded
 * rows, the player in gold and cars a lap up or down in pink or blue; the inputs pill (gear dial, ten shift lights,
 * speed and rpm, the ABS light); the input graph's filled throttle and brake.
 * Mapped: car numbers to driver codes, the class to the car's class, incidents to track-limit strikes, the fuel
 * footer to fuel on board and the laps it lasts, the shift light's blink to the game's shift colour. Added to the
 * pill: the delta, ERS and the aero state where the car has them, and a TC light. Practice lists the laps driven.
 * Dropped: iRating, licence and safety rating, strength of field, the FPS meter, the track map, the app logo.
 */

import React, { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import { upper } from "@/i18n/runtime";
import type { CarTelemetry, RaceStandingEntry } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { tokenColor } from "@/components/ui/token-color";
import { useUnits } from "@/lib/settings/ui-prefs";
import { aidsActive, CLASSIC_CAR_IDS, formatDeltaFit, formatGap, formatLapTime, formatSpeed, formatTemp, HUD_BEST, HUD_CAUTION, HUD_GAIN, HUD_INFO, HUD_LOSS, HUD_SHIFT, HUD_SLATE, NO_TIME, PROTO_CAR_IDS, ROAD_CAR_IDS, sessionWord, speedUnit } from "../hud-format";
import { aeroReadout } from "../aero-label";
import { useHudModeRef } from "../hud-mode";
import { type WeatherHudState } from "../WeatherBadge";
import {
  dayClock,
  driverLabel,
  evaluateRadar,
  formatClock,
  fuelLapsLeft,
  HEADLIGHT_WORD,
  headlightState,
  leaderboardWindow,
  RADAR_CAR_L,
  RADAR_CAR_W,
  RADAR_VIEW_RANGE_M,
  relativeCars,
  sessionBestLapMs,
  SURFACE_WORD,
  trackSurfaceState,
} from "../third-party-data";
import { revLights, useFuelPerLap, useLapHistory, useSessionClock } from "./third-party-parts";
import { anchor, formatOnce, gearLabel, type HudDesignProps } from "./hud-style-parts";
import palette from "./racevision.module.css";

/** A lap time as the source prints it: minutes padded to two digits ("01:23.312"), dashes without one */
const lapTime = (ms: number | null | undefined) => {
  const s = formatLapTime(ms);
  return s.startsWith("-") ? "--:--.---" : /^\d:/.test(s) ? `0${s}` : s;
};

/** The car's class for the standings' class pill, from the car profile the channels report */
function carClass(carId: string | undefined): "field" | "gt3" | "road" | "proto" | "classic" | "formula" {
  if (!carId) return "field";
  if (carId.includes("gt3")) return "gt3";
  if (ROAD_CAR_IDS.has(carId)) return "road";
  if (PROTO_CAR_IDS.has(carId)) return "proto";
  if (CLASSIC_CAR_IDS.has(carId)) return "classic";
  return "formula";
}

/** The RaceVision layout's words in the current language, resolved once per language */
function useRaceVisionWords() {
  const tx = useTranslations("hudStyles.raceVision");
  return useMemo(
    () => ({
      /** The class pill: GT3 is the class's own name */
      carClass: {
        field: tx("classField"),
        gt3: "GT3",
        road: tx("classRoad"),
        proto: tx("classProto"),
        classic: tx("classClassic"),
        formula: tx("classFormula"),
      },
      standings: tx("standings"),
      laps: tx("laps"),
      race: tx("race"),
      sessionTime: formatOnce((time: string) => tx("sessionTime", { time })),
      cars: tx("cars"),
      out: tx("out"),
      finished: tx("finished"),
      invalid: tx("invalid"),
      invalidShort: tx("invalidShort"),
      relative: tx("relative"),
      strikes: tx("strikes"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      raceLaps: formatOnce((lap: number, total: number) =>
        total ? tx("raceLapsOfTotal", { lap: String(lap), total: String(total) }) : tx("raceLaps", { lap: String(lap) }),
      ),
      aidWorking: formatOnce((aid: string) => tx("aidWorking", { aid })),
      inputs: tx("inputs"),
      shiftLights: formatOnce((lit: number, total: number) => tx("shiftLights", { lit: String(lit), total: String(total) })),
      delta: tx("delta"),
      aero: tx("aero"),
      open: tx("open"),
      queued: tx("queued"),
      armed: tx("armed"),
      shut: tx("shut"),
      inputGraph: tx("inputGraph"),
      weather: tx("weather"),
      air: tx("air"),
      track: tx("track"),
      surface: tx("surface"),
      rain: tx("rain"),
      lights: tx("lights"),
      radar: tx("radar"),
    }),
    [tx],
  );
}
type RaceVisionWords = ReturnType<typeof useRaceVisionWords>;

/** A media query as live state (read on the client; false while prerendered) */
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The panel the source draws every overlay window on */
const PANEL = "bg-(--tp-panel) text-(--tp-text)";

/** The white position box at the start of a row (gold for the player) */
const PosBox: React.FC<{ children: React.ReactNode; user?: boolean }> = ({ children, user }) => (
  <span className={`flex h-full w-8 shrink-0 items-center justify-center rounded-l-lg text-(--tp-ink) ${user ? "bg-(--tp-user)" : "bg-(--tp-box)"}`}>
    {children}
  </span>
);

/** A slanted pill of the class header (the source's clip-path parallelogram) */
const ClassPill: React.FC<{ children: React.ReactNode; side: "left" | "right" }> = ({ children, side }) => (
  <span
    className={`inline-flex items-center gap-1.5 bg-(--tp-class) py-px font-black text-(--tp-ink) italic ${side === "left" ? "pr-4 pl-2" : "pr-1.5 pl-4"}`}
    style={{ clipPath: side === "left" ? "polygon(0 0, 92% 0, 100% 100%, 0 100%)" : "polygon(10% 0, 100% 0, 100% 100%, 0 100%)" }}
  >
    {children}
  </span>
);

/** Colour of a best-lap cell: the session's fastest purple */
const bestColor = (ms: number | null | undefined, sessionBest: number | null) =>
  ms && sessionBest && Math.abs(ms - sessionBest) < 0.5 ? HUD_BEST : undefined;
/** Colour of a last-lap cell: the session's fastest purple, the driver's own best green */
const lastColor = (ms: number | null | undefined, own: number | null | undefined, sessionBest: number | null) =>
  !ms ? undefined : sessionBest && Math.abs(ms - sessionBest) < 0.5 ? HUD_BEST : own && Math.abs(ms - own) < 0.5 ? HUD_GAIN : undefined;

/** One standings row: position, stripe, name, gap, best and last */
const StandingRow: React.FC<{
  e: RaceStandingEntry;
  pos: number;
  gaps: "interval" | "leader";
  sessionBest: number | null;
  narrow: boolean;
  w: RaceVisionWords;
}> = ({ e, pos, gaps, sessionBest, narrow, w }) => {
  const gapS = gaps === "leader" ? e.gapToLeaderS : e.intervalS;
  const gap = e.retired ? w.out : e.finished ? w.finished : pos === 1 || gapS === undefined ? "-" : formatGap(gapS);
  return (
    <div className="flex h-6 items-stretch">
      <PosBox user={e.isPlayer}>{pos}</PosBox>
      <span aria-hidden className="w-1.5 shrink-0" style={{ backgroundColor: e.teamColorHex }} />
      <span
        className={`min-w-0 flex-1 self-center truncate px-2 text-center ${e.retired ? "text-(--tp-dim)" : e.isPlayer ? "text-(--tp-user)" : ""}`}
      >
        {driverLabel(e)}
      </span>
      <span className="w-12 shrink-0 self-center text-center">{gap}</span>
      <span className="w-20 shrink-0 self-center text-right" style={{ color: bestColor(e.bestLapMs, sessionBest) }}>
        {lapTime(e.bestLapMs)}
      </span>
      {narrow ? null : (
        <span className="w-20 shrink-0 self-center pl-1 text-right" style={{ color: lastColor(e.lastLapMs, e.bestLapMs, sessionBest) }}>
          {lapTime(e.lastLapMs)}
        </span>
      )}
    </div>
  );
};

/** Standings in a race; in practice, the same table of the laps driven, the running lap on top */
const Standings: React.FC<{
  t: CarTelemetry;
  deltaS: number | null;
  lapInvalid: boolean;
  gaps: "interval" | "leader";
  short: boolean;
  narrow: boolean;
}> = ({ t, deltaS, lapInvalid, gaps, short, narrow }) => {
  const race = t.race;
  const laps = useLapHistory(10);
  const clock = useSessionClock();
  const sessionBest = sessionBestLapMs(t);
  const w = useRaceVisionWords();
  const cls = w.carClass[carClass(t.f12026?.carId)];
  const field = race ? race.standings.length : 1 + (t.peers?.length ?? 0);
  const rows = race ? leaderboardWindow(race.standings, short ? 7 : 12) : [];
  const bestMs = t.bestLapTimeMs;
  return (
    <section aria-label={race ? w.standings : w.laps} className={`${PANEL} flex flex-col gap-1.5 p-2`}>
      <div className="flex items-center justify-between gap-3 px-0.5 font-black">
        <span className="truncate">
          {race ? w.race : upper(sessionWord(t))}
          <span className="pl-2">{race ? `L${race.lap}${race.totalLaps ? `/${race.totalLaps}` : ""}` : `L${Math.max(1, t.lapCount)}`}</span>
        </span>
        {/* The session's running time, where the source shows its clock */}
        <span className="inline-flex shrink-0 items-center gap-1" aria-label={w.sessionTime(formatClock(clock))}>
          <Icon name="time" size="xs" />
          {formatClock(clock)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <ClassPill side="left">{cls}</ClassPill>
        <ClassPill side="right">
          <Icon name="helmet" size="xs" label={w.cars} />
          {field}
        </ClassPill>
      </div>
      {race ? (
        <div className="flex flex-col gap-0.5">
          {rows.map((e) => (
            <StandingRow key={e.driverCode + (e.name ?? "")} e={e} pos={race.standings.indexOf(e) + 1} gaps={gaps} sessionBest={sessionBest} narrow={narrow} w={w} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {/* The running lap: gold, the live delta beside it */}
          <div className="flex h-6 items-stretch">
            <PosBox user>{Math.max(1, t.lapCount)}</PosBox>
            <span aria-hidden className="w-1.5 shrink-0 bg-(--tp-user)" />
            <span className="flex-1 self-center px-2 text-center" style={{ color: lapInvalid ? HUD_LOSS : "var(--tp-user)" }}>
              {/* Held at zero on the out-lap, where no lap is timed yet */}
              {lapInvalid ? w.invalid : t.outLap ? "00:00.000" : lapTime(t.currentLapTimeMs)}
            </span>
            <span className="w-20 shrink-0 self-center text-right" style={{ color: deltaS === null ? HUD_SLATE : deltaS <= 0 ? HUD_GAIN : HUD_LOSS }}>
              {deltaS === null ? NO_TIME : formatDeltaFit(deltaS)}
            </span>
          </div>
          {laps.slice(0, short ? 4 : 8).map((l) => {
            const best = bestMs !== null && l.valid && Math.abs(l.ms - bestMs) < 0.5;
            return (
              <div key={l.lap} className="flex h-6 items-stretch">
                <PosBox>{l.lap}</PosBox>
                <span aria-hidden className="w-1.5 shrink-0" style={{ backgroundColor: best ? HUD_BEST : "var(--tp-dim)" }} />
                <span className={`flex-1 self-center px-2 text-center ${l.valid ? "" : "text-(--tp-dim) line-through"}`} style={{ color: best ? HUD_BEST : undefined }}>
                  {lapTime(l.ms)}
                </span>
                <span className="w-20 shrink-0 self-center text-right">
                  {!l.valid ? w.invalidShort : best || bestMs === null ? "-" : `+${((l.ms - bestMs) / 1000).toFixed(3)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

/** The relative: the cars around the player on the road, gaps in seconds, the fuel underneath */
const Relative: React.FC<{ t: CarTelemetry; lengthM: number }> = ({ t, lengthM }) => {
  const race = t.race;
  const perLap = useFuelPerLap();
  const w = useRaceVisionWords();
  if (!race) return null;
  const cars = relativeCars(t, lengthM, 3);
  const fuelLaps = fuelLapsLeft(t.fuelKg, perLap);
  const strikes = t.trackLimits?.totalStrikes ?? 0;
  return (
    <section aria-label={w.relative} className={`${PANEL} flex w-[340px] flex-col gap-1.5 py-2`}>
      <div className="flex items-center justify-between px-2.5 font-black">
        <span>
          L{race.lap}
          {race.totalLaps ? `/${race.totalLaps}` : ""}
        </span>
        <span>
          P{race.position}/{race.standings.length}
        </span>
        <span title={w.strikes}>{strikes}x</span>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        {cars.map((c, i) => {
          const e = c.entry;
          const tone = e.isPlayer ? "var(--tp-user)" : c.lapsAhead > 0 ? "var(--tp-lapping)" : c.lapsAhead < 0 ? "var(--tp-lapped)" : undefined;
          return (
            <div key={e.driverCode + (e.name ?? "")} className={`flex h-6 items-stretch rounded-lg ${i % 2 === 1 ? "bg-(--tp-row)" : ""}`}>
              <PosBox user={e.isPlayer}>{race.standings.indexOf(e) + 1}</PosBox>
              <span aria-hidden className="w-1.5 shrink-0" style={{ backgroundColor: e.teamColorHex }} />
              <span className="min-w-0 flex-1 self-center truncate px-2 text-center" style={{ color: tone }}>
                {driverLabel(e)}
              </span>
              <span className="w-16 shrink-0 self-center pr-2.5 text-right" style={{ color: tone }}>
                {c.gapS.toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
      {t.fuelKg > 0 ? (
        <div className="flex items-center justify-between px-2.5">
          <span>{fuelLaps !== null ? w.fuelLaps(fuelLaps.toFixed(1)) : w.raceLaps(race.lap, race.totalLaps ?? 0)}</span>
          <span className="inline-flex items-center gap-1.5">
            <Icon name="fuel" size="xs" />
            {t.fuelKg.toFixed(1)} kg
          </span>
        </div>
      ) : null}
    </section>
  );
};

/** The source's ABS light, redrawn: a ring with the letters and a bracket either side; lit while the aid works */
const AidRing: React.FC<{ label: string; active: boolean; w: RaceVisionWords }> = ({ label, active, w }) => (
  <svg viewBox="0 0 40 28" className="h-7 w-10 shrink-0" role="img" aria-label={active ? w.aidWorking(label) : label}>
    <g fill="none" stroke={active ? HUD_CAUTION : "var(--tp-text)"} strokeWidth={2.4} strokeLinecap="round">
      <circle cx={20} cy={14} r={9.5} />
      <path d="M6.5 5.5 A12.5 12.5 0 0 0 6.5 22.5 M33.5 5.5 A12.5 12.5 0 0 1 33.5 22.5" />
    </g>
    <text x={20} y={16.6} textAnchor="middle" fontSize={label.length > 2 ? 7.2 : 8.5} fontWeight={900} fill={active ? HUD_CAUTION : "var(--tp-text)"}>
      {label}
    </text>
  </svg>
);

/** A label over a value, as the pill's MPH and RPM cells */
const Cell: React.FC<{ label: string; children: React.ReactNode; color?: string; className?: string }> = ({ label, children, color, className = "" }) => (
  <span className={`flex min-w-11 flex-col items-center leading-tight ${className}`}>
    <span className="text-[11px]">{label}</span>
    <span className="text-[14px] whitespace-nowrap" style={{ color }}>
      {children}
    </span>
  </span>
);

const LIGHTS = 10;
/** The pill's height at 100 % (h-16): the race notices start under it (`topClearance` in F1TelemetryHud) */
const PILL_H = 64;

/** The inputs pill: gear dial, shift lights, speed, rpm, delta (and ERS, aero), the TC and ABS lights */
const InputsPill: React.FC<{ t: CarTelemetry; deltaS: number | null; revRange: [number, number]; narrow: boolean; showDeltaBar?: boolean }> = ({
  t,
  deltaS,
  revRange,
  narrow,
  showDeltaBar = true,
}) => {
  const units = useUnits();
  const lights = revLights(t.rpm, revRange, LIGHTS);
  const aids = aidsActive(t);
  const tuner = t.liveTuner;
  const hasErs = t.f12026?.hasErs ?? tuner?.hasErs ?? false;
  const aero = aeroReadout(t);
  const hasAero = t.overtakingRules !== undefined && t.overtakingRules !== "none" && (!t.f12026 || t.f12026.hasDrs);
  const hasAbs = (tuner?.absLevel ?? 0) > 0;
  const hasTc = (tuner?.tcLevel ?? 0) > 0;
  const w = useRaceVisionWords();
  return (
    <section aria-label={w.inputs} className={`${PANEL} flex h-16 items-center gap-3 rounded-full p-1 pr-4`}>
      <span
        className="flex size-14 shrink-0 items-center justify-center rounded-full border-[5px] border-(--tp-gear-ring) bg-(--tp-gear) text-[30px] leading-none"
        style={{ color: lights.atShift ? HUD_SHIFT : undefined }}
      >
        {gearLabel(t.gear)}
      </span>
      <span className="flex flex-col gap-1">
        <span className="flex items-center gap-1" aria-label={w.shiftLights(lights.atShift ? LIGHTS : lights.lit, LIGHTS)}>
          {Array.from({ length: LIGHTS }, (_, i) => (
            <span key={i} className="size-3 rounded-full" style={{ backgroundColor: lights.on(i) ? lights.color(i) : "var(--tp-light-off)" }} />
          ))}
        </span>
        <span className="flex items-start justify-around gap-2">
          <Cell label={speedUnit(units).toUpperCase()}>{formatSpeed(t.speedKmh, units)}</Cell>
          {narrow ? null : <Cell label="RPM">{Math.round(t.rpm)}</Cell>}
          {showDeltaBar ? (
            <Cell label={w.delta} color={deltaS === null ? HUD_SLATE : deltaS <= 0 ? HUD_GAIN : HUD_LOSS}>
              {deltaS === null ? NO_TIME : formatDeltaFit(deltaS)}
            </Cell>
          ) : null}
          {hasErs ? (
            <Cell label="ERS" color={t.mgukPowerKw > 0 ? HUD_INFO : undefined}>
              {Math.round(t.ersBatteryPercent)}%
            </Cell>
          ) : null}
        </span>
      </span>
      {hasAero ? (
        <Cell label={aero.straightMode ? w.aero : "DRS"} color={aero.open ? HUD_INFO : aero.armed || aero.queued ? undefined : HUD_SLATE}>
          {aero.open ? w.open : aero.queued ? w.queued : aero.armed ? w.armed : w.shut}
        </Cell>
      ) : null}
      {hasTc ? <AidRing label="TC" active={aids.tc} w={w} /> : null}
      {hasAbs ? <AidRing label="ABS" active={aids.abs} w={w} /> : null}
    </section>
  );
};

/** Trace window (s), as the source's streaming chart */
const GRAPH_S = 3;
const GRAPH_W = 300;
const GRAPH_H = 88;
const RING = 256;

/** The input graph: throttle and brake as filled areas over the last three seconds, newest at the right */
const InputGraph: React.FC<{ throttle: number; brake: number }> = ({ throttle, brake }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ring = useRef({ t: new Float64Array(RING), th: new Float32Array(RING), br: new Float32Array(RING), head: 0, count: 0 });
  const mode = useHudModeRef();
  const w = useRaceVisionWords();

  // A point whenever an input changes; between changes the graph holds the last value
  useEffect(() => {
    const r = ring.current;
    r.t[r.head] = performance.now();
    r.th[r.head] = throttle;
    r.br[r.head] = brake;
    r.head = (r.head + 1) % RING;
    r.count = Math.min(RING, r.count + 1);
  }, [throttle, brake]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      // Paused or in a replay the HUD is hidden: nothing to draw
      if (mode.current === "hidden") return;
      const dpr = window.devicePixelRatio || 1;
      const pxW = Math.round(GRAPH_W * dpr);
      const pxH = Math.round(GRAPH_H * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
      const r = ring.current;
      if (r.count === 0) return;
      const now = performance.now();
      const start = now - GRAPH_S * 1000;
      const x = (ms: number) => Math.max(0, ((ms - start) / (GRAPH_S * 1000)) * GRAPH_W);
      const bottom = GRAPH_H - 1;
      const y = (v: number) => bottom - Math.max(0, Math.min(1, v)) * (GRAPH_H - 4);
      // Oldest to newest; the first point before the window is carried in at its left edge
      const first = Math.max(0, r.count - RING);
      const order: number[] = [];
      for (let k = first; k < r.count; k++) order.push((r.head - r.count + k + RING) % RING);
      let from = 0;
      while (from < order.length - 1 && r.t[order[from + 1]] < start) from++;
      const pts = order.slice(from);
      const area = (values: Float32Array, color: string) => {
        ctx.beginPath();
        ctx.moveTo(x(r.t[pts[0]]), bottom);
        for (let k = 0; k < pts.length; k++) {
          const i = pts[k];
          const xi = x(r.t[i]);
          // Steps hold the value until the next sample, as the input did
          if (k > 0) ctx.lineTo(xi, y(values[pts[k - 1]]));
          ctx.lineTo(xi, y(values[i]));
        }
        const last = values[pts[pts.length - 1]];
        ctx.lineTo(GRAPH_W, y(last));
        ctx.lineTo(GRAPH_W, bottom);
        ctx.closePath();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(x(r.t[pts[0]]), y(values[pts[0]]));
        for (let k = 1; k < pts.length; k++) {
          ctx.lineTo(x(r.t[pts[k]]), y(values[pts[k - 1]]));
          ctx.lineTo(x(r.t[pts[k]]), y(values[pts[k]]));
        }
        ctx.lineTo(GRAPH_W, y(last));
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.stroke();
      };
      // Brake under throttle, as the source stacks its datasets
      area(r.br, tokenColor("brake"));
      area(r.th, tokenColor("throttle"));
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  return (
    <section aria-label={w.inputGraph} className={`${PANEL} p-1`}>
      <canvas ref={canvasRef} aria-hidden className="block" style={{ width: GRAPH_W, height: GRAPH_H }} />
    </section>
  );
};

/** Top-right weather strip in RaceVision's black strip + sharp monospace cell style */
const WeatherStrip: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const units = useUnits();
  const surface = trackSurfaceState(weather.waterMm);
  const surfaceColor = surface === "dry" ? undefined : surface === "damp" ? "var(--tp-user)" : HUD_INFO;
  const lights = headlightState(weather);
  const w = useRaceVisionWords();
  return (
    <section aria-label={w.weather} className={`${PANEL} flex items-center gap-3 border border-white/15 px-3 py-1.5 uppercase`}>
      {weather.timeMoving ? (
        <span className="text-[12px] text-(--tp-user) tabular-nums">{dayClock(weather.clockH)}</span>
      ) : null}
      <Cell label={w.air}>{formatTemp(weather.airC, units)}</Cell>
      <Cell label={w.track}>{formatTemp(weather.trackC, units)}</Cell>
      <Cell label={w.surface} color={surfaceColor}>
        {SURFACE_WORD[surface]}
      </Cell>
      {weather.rain > 0.05 ? (
        <Cell label={w.rain} color={HUD_INFO}>
          {`${Math.round(weather.rain * 100)}%`}
        </Cell>
      ) : null}
      {lights ? (
        <Cell label={w.lights} color={lights === "flash" ? "var(--tp-user)" : lights === "off" ? "rgba(255,255,255,0.45)" : undefined}>
          {HEADLIGHT_WORD[lights]}
        </Cell>
      ) : null}
    </section>
  );
};

/** Crisp black square proximity radar matching RaceVision's telemetry aesthetic */
const RaceVisionRadar: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const w = useRaceVisionWords();
  const { blips, leftCar, rightCar, opacity } = evaluateRadar(t.radar ?? []);
  if (opacity <= 0.01) return null;
  const range = RADAR_VIEW_RANGE_M;
  return (
    <div
      className="pointer-events-none absolute top-[53%] left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ease-out"
      style={{ width: 148, height: 148, opacity }}
    >
      <div className={`${PANEL} relative size-full border border-white/20`}>
        {leftCar ? (
          <span
            aria-hidden
            className="absolute inset-y-2 left-0 w-1"
            style={{ backgroundColor: leftCar.overlapLevel === 2 ? HUD_LOSS : "var(--tp-user)", opacity: Math.max(0.6, leftCar.opacity) }}
          />
        ) : null}
        {rightCar ? (
          <span
            aria-hidden
            className="absolute inset-y-2 right-0 w-1"
            style={{ backgroundColor: rightCar.overlapLevel === 2 ? HUD_LOSS : "var(--tp-user)", opacity: Math.max(0.6, rightCar.opacity) }}
          />
        ) : null}
        <svg viewBox={`${-range} ${-range} ${range * 2} ${range * 2}`} className="block size-full" role="img" aria-label={w.radar}>
          <circle r={8} fill="none" stroke="var(--tp-dim)" strokeOpacity={0.35} strokeWidth={0.3} />
          <circle r={16} fill="none" stroke="var(--tp-dim)" strokeOpacity={0.2} strokeWidth={0.3} />
          <line x1={0} y1={-range} x2={0} y2={range} stroke="var(--tp-dim)" strokeOpacity={0.18} strokeWidth={0.25} />
          <line x1={-range} y1={0} x2={range} y2={0} stroke="var(--tp-dim)" strokeOpacity={0.18} strokeWidth={0.25} />
          {blips.map(({ blip: b, opacity: carOp, overlapLevel }, i) => (
            <rect
              key={i}
              x={-RADAR_CAR_W / 2}
              y={-RADAR_CAR_L / 2}
              width={RADAR_CAR_W}
              height={RADAR_CAR_L}
              fill={overlapLevel === 2 ? HUD_LOSS : overlapLevel === 1 ? HUD_CAUTION : b.color}
              fillOpacity={Math.max(0.35, carOp)}
              stroke="var(--tp-ink)"
              strokeWidth={0.35}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          ))}
          <rect
            x={-RADAR_CAR_W / 2}
            y={-RADAR_CAR_L / 2}
            width={RADAR_CAR_W}
            height={RADAR_CAR_L}
            fill="var(--tp-user)"
            stroke="var(--tp-ink)"
            strokeWidth={0.35}
          />
        </svg>
      </div>
    </div>
  );
};

/**
 * RaceVision: standings top-left, the inputs pill top-centre, the input graph bottom-left and the relative with the
 * MFD bottom-right, in black windows and bold mono. A window under 1024 px wide keeps the standings and moves the pill
 * to the bottom centre (the top is the standings' and the weather's). With the touch controls up (a tablet) the bottom
 * corners are the pads': the relative moves up under the top-right group and the graph steps aside.
 */
export const RaceVisionHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  revRange,
  scale,
  mfd,
  touch,
  topInset,
  lapInvalid,
  towerGaps = "interval",
  leftExtra,
  rightExtra,
  weather,
  showDeltaBar,
  showRadar,
}) => {
  // Short windows list fewer rows; narrow ones drop the last-lap column and the pill's secondary cells; small ones
  // move the pill to the bottom
  const short = useMedia("(max-height: 600px)");
  const narrow = useMedia("(max-width: 1535px)");
  const wide = useMedia("(min-width: 1024px)");
  const roomy = useMedia("(min-width: 1280px)");
  const edge = "clamp(14px,2.2vw,24px)";
  const pill = <InputsPill t={t} deltaS={deltaS} revRange={revRange} narrow={narrow} showDeltaBar={showDeltaBar} />;
  const pillTop = topInset ?? 16;
  // Between 1024 and 1280 px the top-right group would run into the pill: it starts under it instead
  const rightTop = wide && !roomy ? `${pillTop + Math.round(PILL_H * (scale ?? 1)) + 12}px` : edge;
  return (
    <div className={`${palette.palette} pointer-events-none absolute inset-0 select-none lc-mono text-[13px] font-extrabold`}>
      {/* Top-left: standings (under the touch pause and camera buttons, and clear of the pill, when they are up) */}
      <div
        className="absolute flex w-[400px] flex-col gap-2 max-2xl:w-[300px]"
        style={{ top: touch ? 92 : edge, left: edge, ...anchor(scale, "top left") }}
      >
        <Standings t={t} deltaS={deltaS} lapInvalid={lapInvalid} gaps={towerGaps} short={short} narrow={narrow} />
        {leftExtra}
      </div>

      {wide ? (
        // Top-centre: the inputs pill (under the virtual mirror when it is up)
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{ top: topInset !== undefined ? `calc(${topInset}px - env(safe-area-inset-top, 0px))` : pillTop }}
        >
          <div style={anchor(scale, "top center")}>{pill}</div>
        </div>
      ) : (
        <div data-hud-avoid className="absolute left-1/2 -translate-x-1/2" style={{ bottom: edge }}>
          <div style={anchor(scale, "bottom center")}>{pill}</div>
        </div>
      )}

      {/* Top-right: weather; with the touch pads up, the relative moves here from the bottom-right */}
      <div className="absolute flex flex-col items-end gap-2" style={{ top: rightTop, right: edge, ...anchor(scale, "top right") }}>
        {weather ? <WeatherStrip weather={weather} /> : rightExtra}
        {touch ? (
          <div className="hidden lg:block">
            <Relative t={t} lengthM={map.lengthM} />
          </div>
        ) : null}
      </div>

      {showRadar ? <RaceVisionRadar t={t} /> : null}

      {touch ? null : (
        <>
          {/* Bottom-left: the input graph */}
          <div data-hud-floor data-hud-avoid className="absolute hidden lg:block short:hidden" style={{ bottom: edge, left: edge, ...anchor(scale, "bottom left") }}>
            <InputGraph throttle={t.throttle} brake={t.brake} />
          </div>

          {/* Bottom-right: the MFD on top (folding it moves nothing under it), the relative under it */}
          <div data-hud-avoid className="absolute flex flex-col items-end gap-2" style={{ bottom: edge, right: edge, ...anchor(scale, "bottom right") }}>
            {mfd ? <div className="hidden lg:block">{mfd}</div> : null}
            <div className="hidden lg:block">
              <Relative t={t} lengthM={map.lengthM} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};
