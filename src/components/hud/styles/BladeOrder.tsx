"use client";

import React, { useId, useMemo } from "react";
import { getActivePointToPoint } from "@/lib/track-data";
import type { CarTelemetry, RaceStandingEntry, TireCompound } from "@/types/f1";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { FlagIcon, type FlagKind } from "@/components/ui/badges/FlagIcon";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { useUnits } from "@/lib/settings/ui-prefs";
import { HUD_VOLT, formatDeltaFit, formatGap, formatLapTime, formatTemp, raceState, sessionWord } from "../hud-format";
import { SURFACE_WORD, dayClock, driverLabel, leaderboardWindow, referenceLapS, trackSurfaceState } from "../third-party-data";
import { mapPoint, raceNeighbours, type HudMap } from "./hud-style-parts";
import { onFinalLap } from "./game-style-parts";
import { DEEP, HARD, LBL, LBL_TYPE, PLATE, type Words } from "./BladeParts";

/** The Blade layout's top left: the order window and, under it, the circuit as bare numbered dots */

/** Rows in the order window: the leader and four cars round the player */
const ORDER_ROWS = 5;
/** A gap that moved less than this over the trend window reads as steady (s), as the split gaps do */
const STEADY_S = 0.05;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: the order window                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the solid block in the order window's header says: the flag the player is under, from the race itself */
type FlagState = { flag: FlagKind; word: string; fill: string; note?: string };

function flagState(t: CarTelemetry, w: Words): FlagState | null {
  const race = t.race;
  if (!race || race.phase === "lights") return null;
  if (raceState(race).finished) return { flag: "chequered", word: w.flags.finish, fill: "bg-lc-chalk" };
  if (race.vsc) {
    return {
      flag: "yellow",
      word: race.vsc.phase === "ending" ? w.flags.vscEnding : w.flags.vsc,
      fill: "bg-lc-amber",
      note: formatDeltaFit(race.vsc.deltaS, 1),
    };
  }
  if (race.doubleYellow) return { flag: "doubleYellow", word: w.flags.doubleYellow, fill: "bg-lc-amber" };
  if (race.yellow) return { flag: "yellow", word: w.flags.yellow, fill: "bg-lc-amber" };
  if (race.blueFlag) return { flag: "blue", word: w.flags.blue, fill: "bg-lc-cyan" };
  // The player's own last lap (a lap down, the one after the leader's)
  if (onFinalLap(t)) return { flag: "chequered", word: w.flags.finalLap, fill: "bg-lc-chalk" };
  return { flag: "green", word: w.flags.green, fill: "bg-lc-green" };
}

const ROW_GRID = "grid grid-cols-[30px_5px_minmax(0,1fr)_22px_78px_94px] items-center";

const OrderHeader: React.FC<{ t: CarTelemetry; w: Words; lapInvalid: boolean }> = ({ t, w, lapInvalid }) => {
  const race = t.race;
  const flag = flagState(t, w);
  const counter = race
    ? race.phase === "lights"
      ? race.totalLaps
        ? w.raceLaps(race.totalLaps)
        : null
      : w.lap(Math.max(1, race.lap))
    : t.outLap
      ? w.outLap
      : (getActivePointToPoint() ? w.run : w.lap)(Math.max(1, t.lapCount));
  return (
    <div className={`flex h-9 items-stretch ${PLATE}`}>
      <div className="flex shrink-0 items-center border-r border-white/12 px-3.5">
        <span className="lc-disp text-[17px] leading-none tracking-[0.01em] whitespace-nowrap">{race ? w.race : sessionWord(t)}</span>
      </div>
      <div className="lc-mono flex min-w-0 flex-1 items-center gap-[7px] px-3.5 text-[16px] leading-none font-bold whitespace-nowrap uppercase">
        {/* On the grid the race's length is one phrase, read in its language's direction ("5 لفات") */}
        {race?.phase === "lights" ? <span dir="auto">{counter}</span> : counter}
        {race && race.phase !== "lights" && race.totalLaps ? <span className="text-[12px] font-semibold text-lc-slate">/ {race.totalLaps}</span> : null}
      </div>
      {flag ? (
        <div
          role="status"
          className={`lc-mono flex shrink-0 items-center gap-2 pr-3.5 pl-2 text-[11px] leading-none font-extrabold tracking-[0.14em] whitespace-nowrap text-lc-void uppercase ${flag.fill}`}
        >
          {/* The drawn flag on a void chip, so its cloth shows on a block of its own colour */}
          <span className="grid size-5 place-items-center bg-lc-void text-lc-chalk">
            <FlagIcon flag={flag.flag} size={16} />
          </span>
          {flag.word}
          {flag.note ? <span className="tracking-normal">{flag.note}</span> : null}
        </div>
      ) : !race && lapInvalid ? (
        <div
          role="status"
          className="lc-mono flex shrink-0 items-center gap-1.5 bg-lc-loss px-3.5 text-[11px] leading-none font-extrabold tracking-[0.14em] whitespace-nowrap text-lc-void uppercase"
        >
          <Icon name="trackLimits" size="xs" className="size-3.5" />
          {w.invalid}
        </div>
      ) : null}
    </div>
  );
};

const OrderRows: React.FC<{ t: CarTelemetry; w: Words; compound: TireCompound; gaps: "you" | "leader" }> = ({ t, w, compound, gaps }) => {
  const race = t.race;
  const me = race?.standings.find((e) => e.isPlayer);
  if (!race || !me) return null;
  const lights = race.phase === "lights";
  const near = raceNeighbours(t);
  const splits = race.splits;
  const rows = leaderboardWindow(race.standings, ORDER_ROWS);
  const posOf = (e: RaceStandingEntry) => race.standings.indexOf(e) + 1;
  // The leader is pinned: a break under it when the window starts further down the order
  const gapUnderLeader = rows.length > 1 && posOf(rows[1]) > 2;

  return (
    <>
      <div className={`${ROW_GRID} h-[22px] ${DEEP}`}>
        <span />
        <span />
        <span className="lc-mono pl-[11px] text-[10px] leading-none font-bold tracking-[0.16em] text-lc-slate uppercase">{w.cols.driver}</span>
        <span />
        <span
          className="lc-mono text-right text-[10px] leading-none font-bold tracking-[0.16em] text-lc-slate uppercase"
          title={gaps === "you" ? w.gapToYou : w.gapToLeader}
        >
          {gaps === "you" ? w.cols.int : w.cols.gap}
        </span>
        <span className="lc-mono pr-3 text-right text-[10px] leading-none font-bold tracking-[0.16em] text-lc-slate uppercase">{w.cols.last}</span>
      </div>
      {rows.map((e, i) => {
        const pos = posOf(e);
        // From the player: + a car ahead, − a car behind; the split gap for the two neighbours, so it agrees with theirs
        let gapText = "";
        let trend: "up" | "down" | null = null;
        if (e.retired) gapText = w.out;
        else if (lights || e.finished) gapText = "";
        else if (gaps === "leader") gapText = pos === 1 ? "" : `+${formatGap(e.gapToLeaderS, true)}`;
        else if (!e.isPlayer) {
          const ahead = near?.ahead?.code === e.driverCode;
          const behind = near?.behind?.code === e.driverCode;
          const g = ahead ? near.ahead!.gap : behind ? -near.behind!.gap : me.gapToLeaderS - e.gapToLeaderS;
          gapText = `${g >= 0 ? "+" : "−"}${formatGap(g, true)}`;
          const change = ahead ? splits?.ahead?.changeS : behind ? splits?.behind?.changeS : undefined;
          // Ahead: the gap falling is good news; behind: the gap growing is
          if (change !== undefined && Math.abs(change) >= STEADY_S) trend = (ahead ? change < 0 : change > 0) ? "up" : "down";
        }
        const tyre = e.compound ?? (e.isPlayer ? compound : undefined);
        return (
          <React.Fragment key={e.driverCode}>
            <div
              className={`${ROW_GRID} h-[30px] border-t border-white/5 ${e.isPlayer ? "bg-lc-volt text-lc-void" : PLATE} ${e.retired ? "opacity-55" : ""}`}
              aria-current={e.isPlayer ? "true" : undefined}
              aria-label={e.isPlayer ? w.positionOf(pos, race.fieldSize) : undefined}
            >
              <span
                className={`lc-mono grid h-[30px] place-items-center text-[14px] leading-none font-extrabold ${
                  e.isPlayer ? "bg-lc-void text-lc-volt" : "bg-lc-chalk text-lc-void"
                }`}
              >
                {pos}
              </span>
              <span aria-hidden className="h-[30px]" style={e.isPlayer ? undefined : { backgroundColor: e.teamColorHex }} />
              <span className="flex min-w-0 items-center gap-1.5 pl-[11px]">
                <span className="truncate text-[15px] leading-none font-semibold tracking-[0.01em]">{driverLabel(e)}</span>
                {e.penaltyS ? (
                  <span className={`inline-flex shrink-0 ${HARD}`}>
                    <PenaltyBadge penalty={{ kind: "time", seconds: e.penaltyS }} size="hud" variant={e.isPlayer ? "solid" : "soft"} />
                  </span>
                ) : null}
              </span>
              <span className="grid place-items-center">{tyre ? <CompoundGlyph compound={tyre} size={16} /> : null}</span>
              <span className="lc-mono inline-flex items-center justify-end gap-1 text-[14px] leading-none font-bold whitespace-nowrap uppercase">
                {e.finished && !e.retired ? <Icon name="chequered" size="xs" className="size-3.5" /> : null}
                {trend ? (
                  <Trend
                    direction={trend}
                    size={9}
                    label={trend === "up" ? w.closing : w.dropping}
                    className={e.isPlayer ? "" : trend === "up" ? "text-lc-gain" : "text-lc-loss"}
                  />
                ) : null}
                {gapText}
              </span>
              <span
                className={`lc-mono pr-3 text-right text-[14px] leading-none ${
                  e.lastLapMs ? (e.isPlayer ? "" : "text-lc-fog") : e.isPlayer ? "text-lc-void/45" : "text-lc-dim"
                }`}
              >
                {formatLapTime(e.lastLapMs)}
              </span>
            </div>
            {i === 0 && gapUnderLeader ? <div aria-hidden className={`h-[3px] ${DEEP}`} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
};

const OrderFooter: React.FC<{ t: CarTelemetry; w: Words; weather: WeatherHudState | null | undefined }> = ({ t, w, weather }) => {
  const units = useUnits();
  const limits = t.trackLimits;
  if (!weather && !limits) return null;
  // The strike cycle towards the next penalty, or a points ladder's meter towards its next step
  const count = limits ? limits.warnings : 0;
  const of = limits ? Math.max(1, limits.strikesPerPenalty) : 0;
  return (
    <div className={`flex h-[26px] items-center gap-3 border-t border-white/12 px-3 ${DEEP}`}>
      {weather ? (
        // The strike count keeps its room: on a crowded day (clock, rain, a penalty) a reading that does not fit wraps
        // out of sight whole, last first
        <div className="flex h-[26px] min-w-0 flex-1 flex-wrap items-center gap-x-3 overflow-hidden *:h-[26px]">
          {weather.timeMoving ? <span className="lc-mono inline-flex items-center text-[12px] leading-none font-bold tracking-[0.04em]">{dayClock(weather.clockH)}</span> : null}
          <span className={`${LBL_TYPE} inline-flex items-center gap-1.5 ${weather.rain > 0.05 ? "text-lc-info" : "text-lc-slate"}`}>
            {weather.rain > 0.05 ? <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" label={w.rain} className="size-3" /> : null}
            {SURFACE_WORD[trackSurfaceState(weather.waterMm)]}
          </span>
          <span className={`${LBL} inline-flex items-center gap-1.5`}>
            {w.air}
            <b className="text-[12px] tracking-[0.04em] text-lc-chalk">{formatTemp(weather.airC, units)}</b>
          </span>
          <span className={`${LBL} inline-flex items-center gap-1.5`}>
            {w.track}
            <b className="text-[12px] tracking-[0.04em] text-lc-chalk">{formatTemp(weather.trackC, units)}</b>
          </span>
        </div>
      ) : null}
      {limits ? (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5" aria-label={w.limitsSpoken(count, of)}>
          {limits.penaltyS > 0 ? <b className="lc-mono text-[12px] leading-none font-bold text-lc-loss">{w.penalty(limits.penaltyS)}</b> : null}
          <span className={`${LBL} inline-flex items-baseline gap-1.5`}>
            {w.limits}
            <b className={`text-[12px] tracking-[0.04em] ${count > 0 ? "text-lc-caution" : "text-lc-chalk"}`}>
              {count}/{of}
            </b>
          </span>
          {of <= 6 ? (
            <span aria-hidden className="ml-0.5 flex gap-[3px]">
              {Array.from({ length: of }, (_, i) => (
                <i key={i} className={`block size-2 ${i < count ? "bg-lc-caution" : "bg-lc-line"}`} />
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
};

/** The order window: header (session, lap, flag state), the leader and the cars round the player, footer (weather, limits) */
export const BladeOrder: React.FC<{
  t: CarTelemetry;
  w: Words;
  compound: TireCompound;
  lapInvalid: boolean;
  gaps: "you" | "leader";
  weather: WeatherHudState | null | undefined;
}> = ({ t, w, compound, lapInvalid, gaps, weather }) => (
  <section aria-label={t.race ? w.order : w.session} className="w-full text-lc-chalk">
    <OrderHeader t={t} w={w} lapInvalid={lapInvalid} />
    {t.race ? <OrderRows t={t} w={w} compound={compound} gaps={gaps} /> : null}
    <OrderFooter t={t} w={w} weather={weather} />
  </section>
);

/* ------------------------------------------------------------------------------------------------------------------ */
/* The circuit, straight on the scene: numbered dots, no card                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const MAP_PAD = 60;
const MAP_MAX_W = 300;
const MAP_MAX_H = 236;
const LOCAL_PX = 204;
/** Radius of the zoomed heading-up map (m) */
const LOCAL_RADIUS_M = 360;

const inkCache = new Map<string, boolean>();
/** Whether a team colour takes void ink (a light colour) or chalk */
function darkInkOn(color: string): boolean {
  let dark = inkCache.get(color);
  if (dark === undefined) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
    dark = !m || 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16) > 120;
    inkCache.set(color, dark);
  }
  return dark;
}

/** Direction of travel on the map at a lap fraction (radians, SVG axes), over ±40 m */
function mapHeading(map: HudMap, progress: number): number {
  const look = 40 / Math.max(1, map.lengthM);
  const [ax, ay] = mapPoint(map, progress - look);
  const [bx, by] = mapPoint(map, progress + look);
  return Math.atan2(by - ay, bx - ax);
}

export const BladeMap: React.FC<{ map: HudMap; t: CarTelemetry; local: boolean; label: string; className?: string }> = ({ map, t, local, label, className = "" }) => {
  const clipId = `lc-blade-map-${useId().replace(/:/g, "")}`;
  // The whole lap's box on screen: as wide as the order window's text, no taller than the map's own shape needs
  const full = useMemo(() => {
    const vbW = map.w + MAP_PAD * 2;
    const vbH = map.h + MAP_PAD * 2;
    const aspect = vbH / vbW;
    const wPx = MAP_MAX_W * aspect > MAP_MAX_H ? MAP_MAX_H / aspect : MAP_MAX_W;
    const start = mapPoint(map, 0);
    const a = mapHeading(map, 0) + Math.PI / 2;
    return { vbW, vbH, wPx, hPx: wPx * aspect, start, nx: Math.cos(a), ny: Math.sin(a) };
  }, [map]);

  const [cx, cy] = mapPoint(map, t.trackProgress);
  const r = LOCAL_RADIUS_M * map.unitsPerM;
  // Map units per screen pixel: sizes below are in pixels
  const u = local ? (2 * r) / LOCAL_PX : full.vbW / full.wPx;
  const rot = local ? -Math.PI / 2 - mapHeading(map, t.trackProgress) : 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // Heading-up, the cars are turned about the player with the road; their numbers stay upright
  const place = (p: number): [number, number] => {
    const [x, y] = mapPoint(map, p);
    return local ? [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos] : [x, y];
  };

  const L = map.lengthM || 1;
  const race = t.race;
  const me = race?.standings.find((e) => e.isPlayer);
  const lapS = referenceLapS(t);
  const cars: { key: string; color: string; p: number; n: number | null; dim: boolean }[] = [];
  if (race && me) {
    // Last to first, so the cars at the front are drawn over the ones behind
    for (let i = race.standings.length - 1; i >= 0; i--) {
      const e = race.standings[i];
      if (e.isPlayer) continue;
      cars.push({
        key: e.driverCode,
        color: e.teamColorHex,
        p: e.trackS !== undefined ? e.trackS / L : t.trackProgress + (me.gapToLeaderS - e.gapToLeaderS) / lapS,
        n: i + 1,
        dim: Boolean(e.retired),
      });
    }
  } else {
    for (const p of t.peers ?? []) cars.push({ key: p.peerId, color: p.teamColorHex, p: p.trackDistanceM / L, n: null, dim: false });
  }
  const myPos = race && me ? race.standings.indexOf(me) + 1 : null;
  const sfLen = 9 * u;

  return (
    // A box of its own round the drawing: the layout editor frames a group by its HTML children
    <div className={`shrink-0 ${className}`}>
    <svg
      role="img"
      aria-label={label}
      viewBox={local ? `${cx - r} ${cy - r} ${2 * r} ${2 * r}` : `${-MAP_PAD} ${-MAP_PAD} ${full.vbW} ${full.vbH}`}
      width={local ? LOCAL_PX : full.wPx}
      height={local ? LOCAL_PX : full.hPx}
      className="block overflow-visible"
    >
      {local ? (
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r * 0.98} />
          </clipPath>
        </defs>
      ) : null}
      <g clipPath={local ? `url(#${clipId})` : undefined}>
        <g transform={local ? `rotate(${((rot * 180) / Math.PI).toFixed(2)} ${cx} ${cy})` : undefined}>
          <path d={map.path} fill="none" stroke="var(--color-lc-void)" strokeOpacity={0.72} strokeWidth={11 * u} strokeLinejoin="round" strokeLinecap="round" />
          <path d={map.path} fill="none" stroke="var(--color-lc-chalk)" strokeWidth={4 * u} strokeLinejoin="round" strokeLinecap="round" />
          {/* The start line, across the road */}
          <line
            x1={full.start[0] - full.nx * sfLen}
            y1={full.start[1] - full.ny * sfLen}
            x2={full.start[0] + full.nx * sfLen}
            y2={full.start[1] + full.ny * sfLen}
            stroke="var(--color-lc-void)"
            strokeWidth={7 * u}
          />
          <line
            x1={full.start[0] - full.nx * sfLen}
            y1={full.start[1] - full.ny * sfLen}
            x2={full.start[0] + full.nx * sfLen}
            y2={full.start[1] + full.ny * sfLen}
            stroke="var(--color-lc-chalk)"
            strokeWidth={4 * u}
          />
        </g>
      </g>
      {local ? <circle cx={cx} cy={cy} r={r * 0.98} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.16} strokeWidth={1.5 * u} /> : null}
      {cars.map((c) => {
        const [x, y] = place(c.p);
        if (local && Math.hypot(x - cx, y - cy) > r * 0.9) return null;
        return (
          <g key={c.key} opacity={c.dim ? 0.45 : 1}>
            <circle cx={x} cy={y} r={(c.n === null ? 7 : 9.5) * u} fill={c.color} stroke="var(--color-lc-void)" strokeWidth={2 * u} />
            {c.n !== null ? (
              <text
                x={x}
                y={y}
                dy="0.03em"
                textAnchor="middle"
                dominantBaseline="central"
                className="lc-mono"
                fontWeight={800}
                fontSize={(c.n > 9 ? 9.5 : 10.5) * u}
                fill={darkInkOn(c.color) ? "var(--color-lc-void)" : "var(--color-lc-chalk)"}
              >
                {c.n}
              </text>
            ) : null}
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={12 * u} fill={HUD_VOLT} stroke="var(--color-lc-void)" strokeWidth={2.5 * u} />
      {myPos !== null ? (
        <text
          x={cx}
          y={cy}
          dy="0.03em"
          textAnchor="middle"
          dominantBaseline="central"
          className="lc-mono"
          fontWeight={800}
          fontSize={(myPos > 9 ? 11.5 : 13) * u}
          fill="var(--color-lc-void)"
        >
          {myPos}
        </text>
      ) : null}
    </svg>
    </div>
  );
};
