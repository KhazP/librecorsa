"use client";

import React from "react";
import type { CarTelemetry, RaceStandingEntry, RaceStatus, TireCompound } from "@/types/f1";
import { getActivePointToPoint } from "@/lib/track-data";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { useUnits } from "@/lib/settings/ui-prefs";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { formatDeltaFit, formatGap, formatLapClock, formatLapTime, formatSpeed, formatTemp, lapMark, sectorDone, sessionWord, speedUnit } from "../hud-format";
import {
  HEADLIGHT_WORD,
  SURFACE_WORD,
  dayClock,
  driverLabel,
  formatClock,
  headlightState,
  leaderboardWindow,
  sessionBestLapMs,
  trackSurfaceState,
} from "../third-party-data";
import { useDisplayLap, useSessionClock } from "./third-party-parts";
import { anchor, type HudDesignProps, type HudStyleOptions } from "./hud-style-parts";
import { fastestLap, onFinalLap } from "./game-style-parts";
import { EDGE, HAIR, LBL, PLATE, TAG, inkOn, useEnduranceWords, type EnduranceWords } from "./EnduranceWords";
import { EnduranceMap } from "./EnduranceMap";
import { EndurancePages } from "./EndurancePages";
import { EnduranceDial } from "./EnduranceDial";

/**
 * Endurance: the race read the way a long-distance racing sim lays it out, in hard plates. Top left the running order
 * (position on the team colour, gap, last lap, the player's row volt) with the numbered-dot map under it; top right a
 * timing column whose live delta is the one loud plate; bottom left one page at a time (tyres first); bottom right a
 * round dial beside the car from above, with fuel and energy as two bars in words and the electronics under them.
 * The top and bottom centre stay empty: the start lights, the notices and the radar have them.
 */
export const ENDURANCE_STYLE: HudStyleOptions = {
  // Nothing of the layout sits at the bottom centre: the optional input trace goes straight to the edge
  bottomClearance: 16,
  ownsBottomLeft: true,
  mfdFolded: true,
  // The live delta is the timing column's plate (it follows the Delta bar setting), the damage is on the car drawing
  ownDeltaBar: true,
  ownDamage: true,
};

/** Rows of the order on a full-size window, and on a small one (under 1024 × 768) */
const ORDER_ROWS = 10;
const ORDER_ROWS_COMPACT = 5;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: the order                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The flag state in the order's header: quiet under green, a solid block once the driver has to do something */
const FlagState: React.FC<{ t: CarTelemetry; race: RaceStatus; w: EnduranceWords }> = ({ t, race, w }) => {
  const f = w.flag;
  const block = (word: string, cls: string, icon?: "chequered" | "warning") => (
    <span className={`lc-mono flex h-5 shrink-0 items-center gap-1.5 px-1.5 text-[11px] leading-none font-extrabold tracking-[0.08em] whitespace-nowrap uppercase ${cls}`}>
      {icon ? <Icon name={icon} size="xs" className="size-3" /> : null}
      {word}
    </span>
  );
  if (race.phase === "finished") return block(f.finished, "bg-lc-chalk text-lc-void", "chequered");
  if (race.phase === "lights") return block(f.grid, "bg-lc-titanium text-lc-fog");
  if (race.vsc) return block(race.vsc.phase === "ending" ? f.vscEnding : f.vsc, "bg-lc-amber text-lc-void", "warning");
  if (race.yellow) return block(race.doubleYellow ? f.doubleYellow : f.yellow, "bg-lc-amber text-lc-void", "warning");
  if (race.blueFlag) return block(f.blue, "bg-lc-cyan text-lc-void");
  if (onFinalLap(t)) return block(f.finalLap, "bg-lc-chalk text-lc-void", "chequered");
  return (
    <span className="lc-mono flex shrink-0 items-center gap-1.5 text-[11px] leading-none font-extrabold tracking-[0.14em] whitespace-nowrap text-lc-green uppercase">
      <span aria-hidden className="block h-2.5 w-3.5 bg-lc-green" />
      {f.green}
    </span>
  );
};

const ROW = "grid h-[28px] grid-cols-[38px_minmax(0,1fr)_auto_22px_72px_98px] items-center";

const OrderRow: React.FC<{
  e: RaceStandingEntry;
  pos: number;
  gap: string;
  fastest: boolean;
  /** Left out on a small window, where the order is the leader and the cars round the player */
  compactHidden: boolean;
  /** The row above is not the place above: a rule marks the jump */
  jump: boolean;
  w: EnduranceWords;
}> = ({ e, pos, gap, fastest, compactHidden, jump, w }) => {
  const name = driverLabel(e);
  // The lap just driven is the race's fastest
  const purple = fastest && Boolean(e.lastLapMs) && e.lastLapMs === e.bestLapMs;
  return (
    <li
      aria-label={w.row(pos, name)}
      className={`${ROW} border-b last:border-b-0 ${HAIR} ${e.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"} ${e.retired ? "opacity-50" : ""} ${
        compactHidden ? "compact:hidden" : ""
      } ${jump ? "border-t-2 border-t-lc-slate" : ""}`}
    >
      <span
        className="lc-data ml-2 grid h-5 place-items-center text-[12px] leading-none"
        style={e.isPlayer ? { backgroundColor: "var(--color-lc-void)", color: "var(--color-lc-volt)" } : { backgroundColor: e.teamColorHex, color: inkOn(e.teamColorHex) }}
      >
        {pos}
      </span>
      <span className="truncate pl-2.5 text-[14px] leading-none font-semibold">{name}</span>
      <span className="flex items-center gap-1.5 pr-1.5">
        {e.penaltyS ? (
          <span title={w.penaltyTitle(e.penaltyS)} className={`${TAG} ${e.isPlayer ? "bg-lc-void text-lc-caution" : "bg-lc-caution text-lc-void"}`}>
            {w.penalty(e.penaltyS)}
          </span>
        ) : null}
        {e.finished ? <Icon name="chequered" size="xs" label={w.finished} className="size-3.5" /> : null}
      </span>
      {e.compound ? <CompoundGlyph compound={e.compound} size={16} /> : <span />}
      <span className="lc-data text-right text-[13px] leading-none">{gap}</span>
      <span
        className={`lc-mono flex items-center justify-end gap-1 pr-3 text-[13px] leading-none ${e.isPlayer ? "" : purple ? "text-lc-best" : "text-lc-fog"}`}
        title={fastest ? w.fastestLap : undefined}
      >
        {fastest ? <Icon name="time" size="xs" label={w.fastestLap} className={`size-3 ${e.isPlayer ? "" : "text-lc-best"}`} /> : null}
        {e.lastLapMs ? formatLapTime(e.lastLapMs) : ""}
      </span>
    </li>
  );
};

const Order: React.FC<{ t: CarTelemetry; gaps: "interval" | "leader"; w: EnduranceWords }> = ({ t, gaps, w }) => {
  const clock = useSessionClock();
  const lap = useDisplayLap(t);
  const race = t.race;
  const head = "flex h-[38px] items-center justify-between gap-2.5 px-3.5 whitespace-nowrap";
  if (!race) {
    return (
      <section aria-label={w.session} className={`border-t-[3px] border-lc-chalk ${PLATE}`}>
        <div className={head}>
          <span className="lc-disp min-w-0 truncate text-[18px] leading-none text-lc-chalk">{sessionWord(t)}</span>
          <span className="lc-data text-[14px] leading-none text-lc-chalk uppercase">{t.outLap ? w.outLap : getActivePointToPoint() ? w.run(lap) : w.lap(lap)}</span>
          <span className="lc-data ml-auto text-[14px] leading-none text-lc-fog">{formatClock(clock)}</span>
        </div>
      </section>
    );
  }
  const standings = race.standings;
  const grid = race.phase === "lights";
  const shown = leaderboardWindow(standings, ORDER_ROWS);
  const compact = shown.length > ORDER_ROWS_COMPACT ? new Set(leaderboardWindow(standings, ORDER_ROWS_COMPACT)) : null;
  const fastest = grid ? null : fastestLap(t);
  let prevPos = 0;
  return (
    <section aria-label={w.order} className={`border-t-[3px] border-lc-chalk ${PLATE}`}>
      <div className={`${head} border-b ${HAIR}`}>
        <span className="lc-disp min-w-0 truncate text-[18px] leading-none text-lc-chalk">{w.race}</span>
        <span className="lc-data text-[14px] leading-none text-lc-chalk uppercase">{race.totalLaps ? w.lapOf(Math.max(1, race.lap), race.totalLaps) : w.lap(Math.max(1, race.lap))}</span>
        <FlagState t={t} race={race} w={w} />
        <span className="lc-data text-[14px] leading-none text-lc-fog">{formatClock(clock)}</span>
      </div>
      <ol>
        {shown.map((e) => {
          const i = standings.indexOf(e);
          const pos = i + 1;
          const jump = prevPos > 0 && pos !== prevPos + 1;
          prevPos = pos;
          const gap = e.retired
            ? e.dq
              ? w.disqualified
              : w.out
            : grid
              ? ""
              : i === 0
                ? gaps === "leader"
                  ? w.leader
                  : w.interval
                : `+${formatGap(gaps === "leader" ? e.gapToLeaderS : (e.intervalS ?? e.gapToLeaderS - standings[i - 1].gapToLeaderS), true)}`;
          return (
            <OrderRow
              key={e.driverCode}
              e={e}
              pos={pos}
              gap={gap}
              fastest={fastest?.entry === e}
              compactHidden={compact !== null && !compact.has(e)}
              jump={jump}
              w={w}
            />
          );
        })}
      </ol>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: timing                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

const KV = `flex h-[30px] items-center justify-between gap-3 border-b px-3.5 ${HAIR}`;

/** Air and track, the surface, and what else the weather is doing; the track limits count beside it */
const Conditions: React.FC<{ t: CarTelemetry; weather: WeatherHudState | null | undefined; w: EnduranceWords }> = ({ t, weather, w }) => {
  const units = useUnits();
  const tl = t.trackLimits;
  const count = tl ? (tl.ladder ? tl.ladder.points : tl.warnings) : 0;
  const of = tl ? (tl.ladder ? tl.ladder.pointsAllowed : tl.strikesPerPenalty) : 0;
  const limits =
    tl && of > 0 ? (
      <span className={`${LBL} ml-auto flex items-baseline gap-1.5`}>
        {w.limits}
        <span className={`lc-data text-[13px] tracking-normal ${count > 0 ? "text-lc-caution" : "text-lc-chalk"}`}>{w.limitsOf(count, of)}</span>
      </span>
    ) : null;
  if (!weather && !limits) return null;
  const lights = weather ? headlightState(weather) : null;
  const wind = weather && weather.windSpeedMs !== undefined && weather.windSpeedMs >= 0.5 ? weather : null;
  const more = weather && (weather.timeMoving || weather.rain > 0.05 || wind || lights);
  return (
    <>
      <div className="flex h-[30px] items-center gap-3 px-3.5">
        {weather ? (
          <span role="group" aria-label={w.weather} className={`${LBL} flex items-baseline gap-1.5`}>
            {SURFACE_WORD[trackSurfaceState(weather.waterMm)]}
            <span className="lc-data text-[13px] tracking-normal text-lc-chalk" title={w.airTrack(formatTemp(weather.airC, units), formatTemp(weather.trackC, units))}>
              {formatTemp(weather.airC, units)} / {formatTemp(weather.trackC, units)}
            </span>
          </span>
        ) : null}
        {limits}
      </div>
      {weather && more ? (
        <div className={`flex h-[26px] items-center gap-3 border-t px-3.5 ${HAIR}`}>
          {weather.timeMoving ? <span className="lc-data text-[12px] leading-none text-lc-chalk">{dayClock(weather.clockH)}</span> : null}
          {weather.rain > 0.05 ? (
            <span className={`${LBL} flex items-center gap-1 ${weather.rain > 0.5 ? "text-lc-info" : "text-lc-fog"}`}>
              <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" className="size-3" />
              {weather.rain > 0.5 ? w.heavyRain : w.rain}
            </span>
          ) : null}
          {wind ? (
            <span className={`${LBL} flex items-baseline gap-1`}>
              {wind.windDirection ?? ""}
              <span className="lc-data text-[11px] tracking-normal text-lc-fog normal-case">
                {formatSpeed((wind.windSpeedMs ?? 0) * 3.6, units)} {speedUnit(units)}
              </span>
            </span>
          ) : null}
          {lights ? (
            <span className={`${LBL} ml-auto flex items-center gap-1 ${lights === "off" ? "" : "text-lc-gain"}`}>
              <Icon name="headlights" size="xs" className="size-3.5" />
              {HEADLIGHT_WORD[lights]}
            </span>
          ) : null}
        </div>
      ) : null}
    </>
  );
};

const Timing: React.FC<{
  t: CarTelemetry;
  deltaS: number | null;
  lapInvalid: boolean;
  showDelta: boolean;
  weather: WeatherHudState | null | undefined;
  w: EnduranceWords;
}> = ({ t, deltaS, lapInvalid, showDelta, weather, w }) => {
  const solo = !t.race;
  const sessionBest = sessionBestLapMs(t);
  const bestIsSession = t.bestLapTimeMs !== null && sessionBest !== null && t.bestLapTimeMs <= sessionBest + 0.5;
  const value = "lc-mono text-[16px] leading-none font-semibold";
  const level = deltaS !== null && formatDeltaFit(deltaS).startsWith("±");
  return (
    <section aria-label={w.timing} className={`border-t-[3px] border-lc-chalk ${PLATE}`}>
      <div className={KV}>
        <span className={LBL}>{w.last}</span>
        <span className={`${value} flex items-center gap-2 ${t.lastLapValid === false ? "text-lc-loss" : "text-lc-chalk"}`}>
          {t.lastLapValid === false && t.lastLapTimeMs ? <span className={`${TAG} bg-lc-loss text-lc-void`}>{w.lapCut}</span> : null}
          {formatLapTime(t.lastLapTimeMs)}
        </span>
      </div>
      <div className={KV}>
        <span className={LBL}>{w.best}</span>
        <span className={`${value} flex items-center gap-1.5 ${t.bestLapTimeMs && bestIsSession ? "text-lc-best" : "text-lc-chalk"}`}>
          {t.bestLapTimeMs && bestIsSession ? <Icon name="time" size="xs" className="size-3.5" /> : null}
          {formatLapTime(t.bestLapTimeMs)}
        </span>
      </div>
      <div className={`flex h-[46px] items-center justify-between gap-3 border-b px-3.5 ${HAIR}`}>
        <span className="flex flex-col items-start gap-1.5">
          <span className={LBL}>{w.current}</span>
          {lapInvalid ? <span className={`${TAG} bg-lc-loss text-lc-void`}>{w.invalid}</span> : null}
        </span>
        <span className={`lc-mono text-[30px] leading-none font-semibold tracking-[-0.02em] ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>{formatLapClock(t)}</span>
      </div>
      <div className="grid grid-cols-3 gap-[2px] px-3.5 py-2">
        {[0, 1, 2].map((i) => {
          const done = sectorDone(t, i);
          const ms = t.sectorTimesMs[i];
          const best = t.bestSectorTimesMs[i];
          const mark = done ? lapMark(ms, best, solo) : null;
          const active = !t.outLap && i + 1 === t.currentSector;
          const cls =
            mark === "best"
              ? "bg-lc-best text-lc-chalk"
              : mark === "pb"
                ? "bg-lc-gain text-lc-void"
                : mark === "slower"
                  ? "bg-lc-caution text-lc-void"
                  : active
                    ? "bg-lc-titanium text-lc-chalk shadow-[inset_0_-2px_0_var(--color-lc-chalk)]"
                    : "bg-lc-titanium text-lc-fog";
          return (
            <span key={i} className={`lc-mono grid h-[22px] place-items-center text-[11px] leading-none font-extrabold tracking-[0.08em] whitespace-nowrap uppercase ${cls}`}>
              {mark === "best"
                ? `${w.sectors[i]} ${w.markBest}`
                : mark === "pb"
                  ? `${w.sectors[i]} ${w.markPb}`
                  : mark === "slower" && best
                    ? `${w.sectors[i]} +${Math.min(99.99, (ms - best) / 1000).toFixed(2)}`
                    : w.sectors[i]}
            </span>
          );
        })}
      </div>
      {showDelta && deltaS !== null ? (
        <div className={`flex h-[50px] items-center justify-between gap-3 px-3.5 text-lc-void ${deltaS <= 0 ? "bg-lc-gain" : "bg-lc-loss"}`}>
          <span className={`${LBL} flex items-center gap-1.5 text-lc-void`}>
            <Trend direction={level ? "level" : deltaS < 0 ? "up" : "down"} size={10} />
            <span className="flex flex-col gap-1">
              <span>{w.vsBest}</span>
              <span>{level ? w.level : deltaS < 0 ? w.faster : w.slower}</span>
            </span>
          </span>
          <span className="lc-data text-[32px] leading-none tracking-[-0.02em]">{formatDeltaFit(deltaS)}</span>
        </div>
      ) : null}
      <Conditions t={t} weather={weather} w={w} />
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const EnduranceHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  mfd,
  channels,
  ffb,
  lapInvalid,
  towerGaps = "leader",
  mapMode,
  weather,
  leftExtra,
  showDeltaBar,
}) => {
  const w = useEnduranceWords();
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: the order, what the shared layer adds to it (split gaps, the lap board), the map */}
      <div className="absolute flex w-[388px] flex-col items-stretch gap-2" style={{ top: EDGE, left: EDGE, ...anchor(scale, "top left") }}>
        <Order t={t} gaps={towerGaps} w={w} />
        {leftExtra}
        <div className="hidden pt-1 pl-1 sm:block">
          <EnduranceMap map={map} t={t} local={mapMode === "local"} label={w.map} />
        </div>
      </div>

      {/* Top right: timing, with the conditions in its last row (the plate shows the weather itself) */}
      <div className="absolute w-[292px]" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
        <Timing t={t} deltaS={deltaS} lapInvalid={lapInvalid} showDelta={showDeltaBar !== false} weather={weather} w={w} />
      </div>

      {/* Bottom left: the live tuner (folded to its strip) over the pages */}
      <div className="absolute flex flex-col items-start gap-2" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
        {mfd}
        <EndurancePages t={t} compound={compound as TireCompound} lengthM={map.lengthM} w={w} />
      </div>

      {/* Bottom right: dial, car, fuel and energy, electronics */}
      <div className="absolute flex flex-col items-end gap-2" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
        {ffb}
        {channels}
        <EnduranceDial t={t} revRange={revRange} w={w} />
      </div>
    </div>
  );
};
