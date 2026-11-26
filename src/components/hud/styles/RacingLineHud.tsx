"use client";

import React, { useId, useMemo } from "react";
import { getActivePointToPoint } from "@/lib/track-data";
import type { CarTelemetry, RaceStandingEntry, RadarBlip, TireCompound } from "@/types/f1";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { Trend } from "@/components/ui/icons/Trend";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  HUD_BEST,
  HUD_BRAKE,
  HUD_SHIFT,
  HUD_THROTTLE,
  LAP_MARK_COLOR,
  NO_TIME,
  aidsActive,
  atShiftPoint,
  formatDelta,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  lapClockMs,
  lapMark,
  sectorDone,
  sessionWord,
  speedUnit,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { pedalLayers } from "../PedalBars";
import {
  RADAR_CAR_L,
  RADAR_CAR_W,
  SURFACE_WORD,
  driverLabel,
  evaluateRadar,
  formatClock,
  fuelLapsLeft,
  predictedLapMs,
  referenceLapS,
  sessionBestLapMs,
  trackSurfaceState,
} from "../third-party-data";
import { revLights, useFuelPerLap, useSessionClock } from "./third-party-parts";
import {
  LapMarkGlyph,
  MiniMap,
  anchor,
  deltaColor,
  gearLabel,
  mapPoint,
  raceNeighbours,
  type HudDesignProps,
  type HudMap,
  type HudStyleOptions,
} from "./hud-style-parts";
import { onFinalLap, useErsState, type ErsState } from "./game-style-parts";
import {
  CUT_BL,
  CUT_BR,
  HAIR,
  LBL,
  LBL_INK,
  NONE,
  PLATE,
  SLANT,
  TAG,
  UNSLANT,
  useRacingLineScale,
  useRacingLineWords,
  type EnergyWord,
  type Words,
} from "./racing-line-parts";
import { PagedBox } from "./racing-line-pages";

/**
 * Racing line: hard plates with one 45 degree cut and the logo's 12 degree slant. Top left the position tile with the
 * lap and the flag over the cars round the player; top centre the delta strip with the predicted lap; top right the
 * lap clock over a sector strip, and a bare circuit map coloured by how each sector went; bottom centre the speed,
 * gear and energy cluster under its rev lights, the electronics and fuel below it and the radar beside it; bottom
 * right one paged box (racing-line-pages.tsx) under the MFD.
 */

/**
 * The cluster stands 200 px off the bottom and the delta strip ends 102 px from the top; the radar sits beside the
 * cluster and the delta strip is the layout's own
 */
export const RACING_LINE_STYLE: HudStyleOptions = {
  bottomClearance: 212,
  ownsBottomLeft: true,
  mfdFolded: true,
  topClearance: 94,
  // The delta strip is the whole top-centre group: hidden in the lights, and with the player's Delta bar off
  topClearanceInLights: 0,
  topClearanceWithoutDelta: 0,
  ownDeltaBar: true,
  ownRadar: true,
};

/** The gap between the groups and the window (32 px at 1080p) */
const EDGE = "clamp(16px,1.67cqw,40px)";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: position, lap and flag over the cars round the player                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Rows in the race block: the player and two either side */
const TOWER_ROWS = 5;
/** A split that moved less than this over the trend window reads as steady (s), as the split gaps have it */
const STEADY_S = 0.05;

/** Where the five rows start: the player in the middle, held inside the field */
function towerStart(standings: readonly RaceStandingEntry[]): number {
  const me = Math.max(0, standings.findIndex((e) => e.isPlayer));
  return Math.max(0, Math.min(me - Math.floor(TOWER_ROWS / 2), standings.length - TOWER_ROWS));
}

interface Flag {
  word: string;
  tone: string;
  icon?: IconName;
}

/** What the flag block says: the grid, a caution, the last lap, the finish, or green */
function flagOf(t: CarTelemetry, w: Words): Flag | null {
  const race = t.race;
  if (!race) return null;
  if (race.phase === "lights") return { word: w.flag.grid, tone: "bg-lc-chalk text-lc-void" };
  if (race.phase === "finished") return { word: w.flag.finished, tone: "bg-lc-chalk text-lc-void", icon: "chequered" };
  if (race.vsc) return { word: race.vsc.phase === "ending" ? w.flag.vscEnding : w.flag.vsc, tone: "bg-lc-amber text-lc-void", icon: "warning" };
  if (race.yellow) return { word: race.doubleYellow ? w.flag.doubleYellow : w.flag.yellow, tone: "bg-lc-amber text-lc-void", icon: "warning" };
  if (race.blueFlag) return { word: w.flag.blue, tone: "bg-lc-azure text-lc-void" };
  if (onFinalLap(t)) return { word: w.flag.finalLap, tone: "bg-lc-chalk text-lc-void", icon: "chequered" };
  return { word: w.flag.green, tone: "bg-lc-green text-lc-void" };
}

const RaceHead: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const race = t.race;
  const flag = flagOf(t, w);
  const lapNo = Math.max(1, t.lapCount);
  return (
    <div className="mb-[3px] flex h-[46px]">
      {race ? (
        <div className={`ml-[5px] flex items-center bg-lc-volt px-[18px] text-lc-void ${SLANT}`} aria-label={w.positionOf(race.position, race.fieldSize)}>
          <b aria-hidden className={`lc-disp text-[32px] leading-none ${UNSLANT}`}>
            {w.position(race.position)}
          </b>
        </div>
      ) : (
        <div className={`ml-[5px] flex items-center bg-lc-volt px-[16px] text-lc-void ${SLANT}`}>
          <b className={`lc-disp text-[20px] leading-none whitespace-nowrap ${UNSLANT}`}>{sessionWord(t)}</b>
        </div>
      )}
      <div className={`-ml-px flex min-w-0 flex-1 items-center gap-[14px] px-4 ${flag ? "" : "mr-[5px]"} ${PLATE} ${SLANT}`}>
        {race ? <span className={`lc-mono text-[13px] font-bold whitespace-nowrap text-lc-slate ${UNSLANT}`}>{w.fieldOf(race.fieldSize)}</span> : null}
        <span className={`lc-mono text-[13px] font-bold whitespace-nowrap text-lc-slate uppercase ${UNSLANT}`}>
          {race ? (
            race.totalLaps ? (
              w.lapOf(Math.max(1, race.lap), race.totalLaps)
            ) : (
              w.lap(Math.max(1, race.lap))
            )
          ) : t.outLap ? (
            <b className="text-[17px] font-bold text-lc-chalk">{w.outLap}</b>
          ) : getActivePointToPoint() ? (
            w.run(lapNo)
          ) : (
            w.lap(lapNo)
          )}
        </span>
      </div>
      {flag ? (
        <div className={`mr-[5px] flex items-center px-4 ${flag.tone} ${SLANT}`}>
          <span className={`inline-flex items-center gap-1.5 ${TAG} ${UNSLANT}`}>
            {flag.icon ? <Icon name={flag.icon} size="xs" className="size-3.5" /> : null}
            {flag.word}
          </span>
        </div>
      ) : null}
    </div>
  );
};

const RaceRow: React.FC<{
  e: RaceStandingEntry;
  pos: number;
  /** To the player (s, + = this car is ahead); null for the player and on the grid */
  gapS: number | null;
  /** How the split to a car directly ahead or behind moved (s, + = growing) */
  changeS?: number;
  w: Words;
}> = ({ e, pos, gapS, changeS, w }) => {
  const ahead = gapS !== null && gapS > 0;
  const moving = changeS !== undefined && Math.abs(changeS) >= STEADY_S;
  // Ahead: the gap falling is good; behind: the gap rising is good
  const good = moving && (ahead ? (changeS as number) < 0 : (changeS as number) > 0);
  return (
    <li
      className={`grid h-[33px] grid-cols-[38px_4px_1fr_22px_86px_70px] items-center border-t first:border-t-0 ${HAIR} ${
        e.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
      } ${e.retired ? "opacity-50" : ""}`}
    >
      <span className="lc-data text-center text-[15px] leading-none">{pos}</span>
      <i aria-hidden className="block h-[19px]" style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }} />
      <span className="flex min-w-0 items-center gap-2 pr-2 pl-[11px]">
        <span className="truncate text-[16px] leading-[1.15] font-semibold">{driverLabel(e)}</span>
        {e.penaltyS ? (
          <span className={`lc-data shrink-0 px-1 py-[2px] text-[11px] leading-none ${e.isPlayer ? "bg-lc-void text-lc-volt" : "bg-lc-caution text-lc-void"}`}>
            {w.penalty(e.penaltyS)}
          </span>
        ) : null}
      </span>
      {e.compound ? <CompoundGlyph compound={e.compound} size={18} /> : <span />}
      <span className="lc-data flex items-center justify-end text-[16px] leading-none">
        {e.retired ? (
          <span className={TAG}>{w.out}</span>
        ) : e.finished ? (
          <Icon name="chequered" size="xs" className="size-4" />
        ) : gapS === null ? null : (
          `${ahead ? "+" : "−"}${formatGap(gapS, true)}`
        )}
      </span>
      <span
        className={`lc-data flex items-center justify-end gap-[5px] pr-[14px] text-[12px] leading-none ${
          changeS === undefined ? "" : moving ? (good ? "text-lc-gain" : "text-lc-loss") : "text-lc-slate"
        }`}
      >
        {changeS === undefined ? null : (
          <>
            <Trend direction={moving ? (good ? "up" : "down") : "level"} size={10} label={moving ? (good ? w.closing : w.losing) : w.steady} />
            {Math.abs(changeS).toFixed(2)}
          </>
        )}
      </span>
    </li>
  );
};

/** The strip under the rows: the track, the track-limits count and the time on track */
const RaceFoot: React.FC<{ t: CarTelemetry; w: Words; weather?: WeatherHudState | null; bare: boolean }> = ({ t, w, weather, bare }) => {
  const units = useUnits();
  const clock = useSessionClock();
  const limits = t.trackLimits;
  const value = "lc-data ml-[5px] text-[12px] tracking-normal";
  return (
    <div className={`flex h-[30px] items-center gap-4 pr-[30px] pl-[14px] ${bare ? "" : `border-t ${HAIR}`}`}>
      {weather ? (
        <span className={`${LBL} inline-flex items-center`} title={w.weather}>
          {SURFACE_WORD[trackSurfaceState(weather.waterMm)]}
          <span className={`${value} text-lc-chalk`}>
            {formatTemp(weather.airC, units)} / {formatTemp(weather.trackC, units)}
          </span>
          {weather.rain > 0.05 ? (
            <span className={`ml-[6px] inline-flex ${weather.rain > 0.5 ? "text-lc-info" : "text-lc-fog"}`}>
              <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" label={w.rain} className="size-3.5" />
            </span>
          ) : null}
        </span>
      ) : null}
      {limits ? (
        <span className={`${LBL} inline-flex items-center`}>
          {w.limits}
          <span className={`${value} ${limits.warnings > 0 ? "text-lc-caution" : "text-lc-chalk"}`}>
            {limits.warnings} / {limits.strikesPerPenalty}
          </span>
          {limits.penaltyS > 0 ? <span className="lc-data ml-[6px] bg-lc-loss px-1 py-[2px] text-[11px] tracking-normal text-lc-void">{w.penalty(limits.penaltyS)}</span> : null}
        </span>
      ) : null}
      <span className={`${LBL} inline-flex items-center`}>
        {w.time}
        <span className={`${value} text-lc-chalk`}>{formatClock(clock)}</span>
      </span>
    </div>
  );
};

const RaceBlock: React.FC<{ t: CarTelemetry; w: Words; weather?: WeatherHudState | null }> = ({ t, w, weather }) => {
  const race = t.race;
  const me = race?.standings.find((e) => e.isPlayer);
  const near = raceNeighbours(t);
  const grid = race?.phase === "lights";
  const start = race ? towerStart(race.standings) : 0;
  return (
    <section aria-label={race ? w.race : w.session}>
      <RaceHead t={t} w={w} />
      <div className={`${PLATE} ${CUT_BR}`}>
        {race && me ? (
          <ol>
            {race.standings.slice(start, start + TOWER_ROWS).map((e, i) => {
              const ahead = near?.ahead && near.ahead.code === e.driverCode ? near.ahead : null;
              const behind = near?.behind && near.behind.code === e.driverCode ? near.behind : null;
              const gapS = e.isPlayer || grid ? null : ahead ? ahead.gap : behind ? -behind.gap : me.gapToLeaderS - e.gapToLeaderS;
              const split = ahead ? race.splits?.ahead : behind ? race.splits?.behind : undefined;
              return (
                <RaceRow
                  key={e.driverCode}
                  e={e}
                  pos={start + i + 1}
                  gapS={gapS}
                  changeS={!grid && split?.driverCode === e.driverCode ? split.changeS : undefined}
                  w={w}
                />
              );
            })}
          </ol>
        ) : null}
        <RaceFoot t={t} w={w} weather={weather} bare={!(race && me)} />
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top centre: the live delta on a ±1 s strip, its figure and the lap it predicts                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The words either side of the delta figure, on the scene: chalk, 11 px */
const SIDE_LBL = "lc-mono text-[11px] leading-none font-bold tracking-[0.16em] whitespace-nowrap text-lc-chalk uppercase";

const DeltaStrip: React.FC<{ t: CarTelemetry; deltaS: number | null; w: Words }> = ({ t, deltaS, w }) => {
  const has = deltaS !== null;
  const d = deltaS ?? 0;
  const frac = Math.min(1, Math.abs(d));
  const pred = predictedLapMs(t.bestLapTimeMs, deltaS);
  return (
    <div className="w-[500px]">
      <div
        role="meter"
        aria-label={w.delta}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={has ? Math.max(-1, Math.min(1, d)) : 0}
        aria-valuetext={has ? formatDelta(d) : NO_TIME}
        className={`relative h-[18px] ${PLATE} ${SLANT}`}
      >
        {/* Each half grows from the centre line: gained to the left, lost to the right */}
        <span className="absolute inset-y-[3px] right-1/2 w-1/2 origin-right bg-lc-gain" style={{ transform: `scaleX(${has && d <= 0 ? frac : 0})` }} />
        <span className="absolute inset-y-[3px] left-1/2 w-1/2 origin-left bg-lc-loss" style={{ transform: `scaleX(${has && d > 0 ? frac : 0})` }} />
        <span className="absolute inset-y-[5px] left-1/4 w-px bg-white/25" />
        <span className="absolute inset-y-[5px] left-3/4 w-px bg-white/25" />
        <span className="absolute -inset-y-1 left-1/2 -ml-px w-[2px] bg-lc-chalk" />
      </div>
      <div className="mt-[7px] grid grid-cols-[1fr_auto_1fr] items-center">
        <span className={`${SIDE_LBL} hud-text-shadow justify-self-end pr-4`}>{w.deltaBest}</span>
        <span className={`px-[18px] pt-[5px] pb-[6px] ${PLATE} ${SLANT}`}>
          <span className={`lc-mono block text-[34px] leading-none font-semibold tracking-[-0.02em] ${UNSLANT}`} style={{ color: deltaColor(deltaS) }}>
            {has ? formatDeltaFit(d) : NO_TIME}
          </span>
        </span>
        <span className="hud-text-shadow flex items-baseline gap-2 pl-4">
          {pred !== null ? (
            <>
              <span className={SIDE_LBL}>{w.pred}</span>
              <span className="lc-data text-[17px] leading-none text-lc-chalk">{formatLapTime(pred)}</span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: the lap clock over a sector strip, and the last and best laps                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const SECTORS = [0, 1, 2] as const;

const TimingPlate: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean; w: Words }> = ({ t, deltaS, lapInvalid, w }) => {
  const solo = !t.race;
  const sessionBest = sessionBestLapMs(t);
  const holdsBest = Boolean(t.bestLapTimeMs) && sessionBest !== null && (t.bestLapTimeMs as number) <= sessionBest + 0.5;
  // The running sector's own time: the lap clock less the sectors already done
  const clockMs = lapClockMs(t);
  const doneMs = t.sectorTimesMs.reduce((sum, ms, i) => (sectorDone(t, i) ? sum + ms : sum), 0);
  const allBefore = SECTORS.every((i) => i + 1 >= t.currentSector || sectorDone(t, i));
  const runningMs = !t.outLap && clockMs > 0 && allBefore ? clockMs - doneMs : null;
  return (
    <section aria-label={w.timing} className={`w-[340px] ${PLATE} ${CUT_BL}`}>
      <div className="px-4 pt-[13px] pb-3">
        <div className="mb-2 flex h-[12px] items-center justify-between">
          <span className={LBL}>{w.lapTime}</span>
          {lapInvalid ? (
            <span className={`inline-flex items-center gap-1 bg-lc-loss px-1.5 py-[3px] text-lc-void ${TAG}`}>
              <Icon name="trackLimits" size="xs" className="size-3" />
              {w.invalid}
            </span>
          ) : t.outLap ? (
            <span className={LBL}>{w.outLap}</span>
          ) : deltaS !== null && deltaS < 0 ? (
            <span className={`${LBL_INK} inline-flex items-center gap-1 text-lc-gain`}>
              <Trend direction="up" size={9} />
              {w.onPb}
            </span>
          ) : null}
        </div>
        <span className={`lc-mono block text-[44px] leading-[0.92] font-semibold tracking-[-0.02em] ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>
          {formatLapClock(t)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-[3px] px-4">
        {SECTORS.map((i) => {
          const done = sectorDone(t, i);
          const mark = done ? lapMark(t.sectorTimesMs[i], t.bestSectorTimesMs[i], solo) : null;
          const current = !t.outLap && i + 1 === t.currentSector;
          const best = t.bestSectorTimesMs[i];
          // How far through the sector the car is, against its best time through it
          const through = current && runningMs !== null && best ? Math.min(1, runningMs / best) : 0;
          return (
            <div key={i} className="min-w-0">
              <span aria-hidden className="relative block h-[6px] bg-lc-titanium" style={mark ? { backgroundColor: LAP_MARK_COLOR[mark] } : undefined}>
                {current ? <span className="absolute inset-0 origin-left bg-lc-fog" style={{ transform: `scaleX(${through})` }} /> : null}
              </span>
              <p
                className={`lc-data mt-[7px] flex items-baseline gap-[6px] text-[14px] leading-none ${current ? "text-lc-chalk" : "text-lc-dim"}`}
                style={mark ? { color: LAP_MARK_COLOR[mark] } : undefined}
              >
                <span className={`text-[10px] font-extrabold tracking-[0.12em] ${mark ? "" : "text-lc-slate"}`}>{w.sectors[i]}</span>
                {done ? formatSectorTime(t.sectorTimesMs[i]) : current && runningMs !== null ? formatSectorTime(runningMs) : NO_TIME}
                {mark ? <LapMarkGlyph mark={mark} className="self-center text-[10px]" /> : null}
              </p>
            </div>
          );
        })}
      </div>
      <div className={`mt-3 grid grid-cols-2 border-t ${HAIR}`}>
        <div className={`flex items-baseline justify-between border-r px-4 pt-[10px] pb-[13px] ${HAIR}`}>
          <span className={LBL}>{w.last}</span>
          <span className={`lc-mono text-[17px] leading-none font-semibold ${t.lastLapValid === false ? "text-lc-loss line-through" : "text-lc-chalk"}`}>
            {formatLapTime(t.lastLapTimeMs)}
          </span>
        </div>
        <div className="flex items-baseline justify-between px-4 pt-[10px] pb-[13px]">
          <span className={LBL}>{w.best}</span>
          <span
            className="lc-mono inline-flex items-baseline gap-1 text-[17px] leading-none font-semibold text-lc-chalk"
            style={holdsBest ? { color: HUD_BEST } : undefined}
          >
            {holdsBest ? <Icon name="time" size="xs" label={w.sessionBest} className="size-3 self-center" /> : null}
            {formatLapTime(t.bestLapTimeMs)}
          </span>
        </div>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Under it: the bare circuit, each completed sector in the colour of its time, the field as numbered dots             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The box the whole circuit is fitted into (px), and the room round it for the dots */
const MAP_W = 300;
const MAP_H = 204;
const MAP_PAD = 14;
const LINE_PX = 3.5;

/** Ink that reads on a team colour: void on a light one, chalk on a dark one */
function inkOn(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "var(--color-lc-void)";
  const n = Number.parseInt(m[1], 16);
  const luma = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luma > 110 ? "var(--color-lc-void)" : "var(--color-lc-chalk)";
}

const CircuitMap: React.FC<{ map: HudMap; t: CarTelemetry; local: boolean; w: Words }> = ({ map, t, local, w }) => {
  // The fit and the start line belong to the circuit, not the frame
  const fit = useMemo(() => {
    const k = Math.min((MAP_W - MAP_PAD * 2) / Math.max(1, map.w), (MAP_H - MAP_PAD * 2) / Math.max(1, map.h));
    const at = ([x, y]: [number, number]): [number, number] => [MAP_PAD + x * k, MAP_PAD + y * k];
    const look = 30 / Math.max(1, map.lengthM);
    const [ax, ay] = at(mapPoint(map, -look));
    const [bx, by] = at(mapPoint(map, look));
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const [sx, sy] = at(mapPoint(map, 0));
    // The start line, square to the road
    const nx = (-(by - ay) / len) * 7;
    const ny = ((bx - ax) / len) * 7;
    return { k, at, w: Math.ceil(map.w * k + MAP_PAD * 2), h: Math.ceil(map.h * k + MAP_PAD * 2), line: [sx - nx, sy - ny, sx + nx, sy + ny] as const };
  }, [map]);

  if (local) {
    return (
      <div role="img" aria-label={w.circuit}>
        <MiniMap map={map} t={t} local className="block size-[204px]" stroke={30} />
      </div>
    );
  }

  const race = t.race;
  const solo = !race;
  const L = map.lengthM || 1;
  const me = race?.standings.find((e) => e.isPlayer);
  const start = race ? towerStart(race.standings) : 0;
  const lapS = referenceLapS(t);
  const [px, py] = fit.at(mapPoint(map, t.trackProgress));
  return (
    <svg role="img" aria-label={w.circuit} width={fit.w} height={fit.h} viewBox={`0 0 ${fit.w} ${fit.h}`} fill="none" className="block">
      <g transform={`translate(${MAP_PAD} ${MAP_PAD}) scale(${fit.k})`} strokeLinejoin="round" strokeLinecap="round">
        <path d={map.path} stroke="var(--color-lc-void)" strokeOpacity={0.7} strokeWidth={10} vectorEffect="non-scaling-stroke" />
        <path d={map.path} stroke="var(--color-lc-chalk)" strokeWidth={LINE_PX} vectorEffect="non-scaling-stroke" />
        {SECTORS.map((i) =>
          sectorDone(t, i) ? (
            <path
              key={i}
              d={map.sectorPaths[i]}
              stroke={LAP_MARK_COLOR[lapMark(t.sectorTimesMs[i], t.bestSectorTimesMs[i], solo)]}
              strokeWidth={LINE_PX}
              vectorEffect="non-scaling-stroke"
            />
          ) : null,
        )}
      </g>
      <line x1={fit.line[0]} y1={fit.line[1]} x2={fit.line[2]} y2={fit.line[3]} stroke="var(--color-lc-void)" strokeWidth={7} />
      <line x1={fit.line[0]} y1={fit.line[1]} x2={fit.line[2]} y2={fit.line[3]} stroke="var(--color-lc-chalk)" strokeWidth={4} />
      {race && me
        ? race.standings.map((e, i) => {
            if (e.isPlayer) return null;
            const p = e.trackS !== undefined ? e.trackS / L : t.trackProgress + (me.gapToLeaderS - e.gapToLeaderS) / lapS;
            const [x, y] = fit.at(mapPoint(map, p));
            // The cars in the race block carry their position; the rest of the field are plain dots
            const numbered = i >= start && i < start + TOWER_ROWS;
            return (
              <g key={e.driverCode} opacity={e.retired ? 0.5 : 1}>
                <circle cx={x} cy={y} r={numbered ? 8 : 6} fill={e.teamColorHex} stroke="var(--color-lc-void)" strokeWidth={2} />
                {numbered ? (
                  <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="central" className="lc-mono" fontSize={9} fontWeight={800} fill={inkOn(e.teamColorHex)}>
                    {i + 1}
                  </text>
                ) : null}
              </g>
            );
          })
        : (t.peers ?? []).map((p) => {
            const [x, y] = fit.at(mapPoint(map, p.trackDistanceM / L));
            return <circle key={p.peerId} cx={x} cy={y} r={6} fill={p.teamColorHex} stroke="var(--color-lc-void)" strokeWidth={2} />;
          })}
      <circle cx={px} cy={py} r={10} fill="var(--color-lc-volt)" stroke="var(--color-lc-void)" strokeWidth={2.5} />
      {race ? (
        <text x={px} y={py + 0.5} textAnchor="middle" dominantBaseline="central" className="lc-mono" fontSize={11} fontWeight={800} fill="var(--color-lc-void)">
          {race.position}
        </text>
      ) : null}
    </svg>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom centre: rev lights, speed, gear and energy, and the electronics and fuel under them                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const REV_LIGHTS = 15;
const CUT_TL_22 = "[clip-path:polygon(22px_0,100%_0,100%_100%,0_100%,0_22px)]";
const CUT_BR_22 = "[clip-path:polygon(0_0,100%_0,100%_calc(100%_-_22px),calc(100%_-_22px)_100%,0_100%)]";

/** What the energy line says: the driver's Overtake and Boost first, then what the store is doing */
function energyWord(t: CarTelemetry, state: ErsState): EnergyWord {
  const ctl = ersButtons(t);
  if (ctl.overtake === "on") return "overtakeOn";
  if (ctl.overtake === "auto") return "overtakeAuto";
  if (ctl.lowGrip) return "lowGrip";
  if (state === "boost" || state === "overtake") return state;
  if (ctl.overtake === "available") return "overtakeReady";
  if (state !== "neutral") return state;
  if (ctl.overtake === "locked" || ctl.boostLocked) return "overtakeLocked";
  return "neutral";
}

const ENERGY_TONE: Record<EnergyWord, string> = {
  overtakeOn: "text-lc-info",
  overtakeAuto: "text-lc-info",
  overtakeReady: "text-lc-info",
  overtakeLocked: "text-lc-slate",
  lowGrip: "text-lc-caution",
  boost: "text-lc-info",
  overtake: "text-lc-info",
  deploy: "text-lc-info",
  clipped: "text-lc-caution",
  superclip: "text-lc-gain",
  braking: "text-lc-gain",
  liftCoast: "text-lc-gain",
  trickle: "text-lc-gain",
  neutral: "text-lc-slate",
};

/** One pedal: what the electronics let through, over what the driver asked for (the part an aid cut shows as caution) */
const Pedal: React.FC<{ label: string; demand: number; out: number; color: string }> = ({ label, demand, out, color }) => (
  <span
    role="meter"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(demand * 100)}
    className="relative block h-[62px] w-[9px] overflow-hidden bg-lc-titanium"
  >
    <span className="absolute inset-0 origin-bottom bg-lc-caution" style={{ transform: `scaleY(${demand})` }} />
    <span className="absolute inset-0 origin-bottom" style={{ transform: `scaleY(${out})`, backgroundColor: color }} />
  </span>
);

/** The flaps: filled while open, outlined while armed, quiet while shut */
const AeroTag: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const aero = aeroReadout(t);
  return (
    <span
      className={`px-1.5 py-[3px] ${TAG} ${
        aero.open ? "bg-lc-info text-lc-void" : aero.armed || aero.queued ? "text-lc-info inset-ring inset-ring-lc-info" : "bg-white/8 text-lc-slate"
      }`}
    >
      {aero.label}
    </span>
  );
};

/** A dial of the row under the cluster: its label (a caution block while the aid is cutting in) and its setting */
const Dial: React.FC<{ label?: string; value: string; unit?: string; active?: boolean }> = ({ label, value, unit, active = false }) => (
  <span className="flex items-center gap-[9px]">
    {label ? <span className={active ? `${LBL_INK} bg-lc-caution px-1 py-[3px] text-lc-void` : LBL}>{label}</span> : null}
    <span className="lc-data text-[18px] leading-none whitespace-nowrap text-lc-chalk uppercase">
      {value}
      {unit ? <span className={`${LBL} ml-1`}>{unit}</span> : null}
    </span>
  </span>
);

const Cluster: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: Words }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const revFull = revRange[1];
  const shift = atShiftPoint(t.rpm, revFull);
  const lights = revLights(t.rpm, revRange, REV_LIGHTS);
  const pedals = pedalLayers(t);
  const ers = useErsState(t);
  const perLap = useFuelPerLap();
  // As the shell reads them: a car without the channels is the LC26, which has both
  const hasErs = t.f12026?.hasErs ?? true;
  const showAero = (!t.f12026 || t.f12026.hasDrs) && t.overtakingRules !== "none";
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  const fuelLaps = fuelLapsLeft(t.fuelKg, perLap);
  const gear = gearLabel(t.gear);
  const mode = tuner?.ersMode;
  const energy = energyWord(t, ers);
  const soc = Math.min(1, Math.max(0, t.ersBatteryPercent / 100));
  return (
    <>
      <div aria-hidden className="mb-[7px] grid grid-cols-15 gap-1 px-[74px]">
        {Array.from({ length: REV_LIGHTS }, (_, i) => {
          const on = lights.on(i);
          const color = lights.color(i);
          return (
            <span
              key={i}
              className={`block h-[10px] ${SLANT} ${on ? "" : "bg-lc-void/80"}`}
              style={on ? { backgroundColor: color, boxShadow: `0 0 10px color-mix(in srgb, ${color} 65%, transparent)` } : undefined}
            />
          );
        })}
      </div>
      <div className="grid h-[108px] grid-cols-[1fr_128px_1fr]">
        <div className={`flex items-center justify-end gap-[18px] pr-7 ${PLATE} ${CUT_TL_22}`}>
          <span className="mr-auto ml-[30px] flex gap-[5px]">
            <Pedal label={w.brake} demand={pedals.brake} out={pedals.brakeOut} color={HUD_BRAKE} />
            <Pedal label={w.throttle} demand={pedals.throttle} out={pedals.throttleOut} color={HUD_THROTTLE} />
          </span>
          <span className="text-right">
            <span className="lc-mono block text-[66px] leading-[0.9] font-semibold tracking-[-0.04em] text-lc-chalk">{formatSpeed(t.speedKmh, units)}</span>
            <span className={`${LBL} mt-[7px] block`}>{speedUnit(units)}</span>
          </span>
        </div>
        <div
          aria-label={w.gear(gear)}
          className={`relative z-10 -mx-[11px] grid place-items-center text-lc-void ${SLANT} ${shift ? "" : "bg-lc-volt"}`}
          style={shift ? { backgroundColor: HUD_SHIFT } : undefined}
        >
          <b aria-hidden className={`lc-disp -mt-0.5 text-[98px] leading-none ${UNSLANT}`}>
            {gear}
          </b>
        </div>
        <div className={`flex flex-col justify-center pr-[30px] pl-8 ${PLATE} ${CUT_BR_22}`}>
          {hasErs ? (
            <>
              <div className="flex items-baseline justify-between">
                <span className="flex items-center gap-2 self-center">
                  <span className={`${LBL_INK} text-lc-info`}>{w.ers}</span>
                  {showAero ? <AeroTag t={t} /> : null}
                </span>
                <span className="lc-mono text-[40px] leading-none font-semibold tracking-[-0.02em] text-lc-chalk">
                  {Math.round(t.ersBatteryPercent)}
                  <small className="ml-0.5 text-[15px] text-lc-slate">%</small>
                </span>
              </div>
              <span aria-hidden className="relative mt-[9px] mb-2 block h-[6px] overflow-hidden bg-lc-titanium">
                <span
                  className={`absolute inset-0 origin-left ${soc < 0.1 ? "bg-lc-loss" : soc < 0.2 ? "bg-lc-caution" : "bg-lc-info"}`}
                  style={{ transform: `scaleX(${soc})` }}
                />
              </span>
              <div className="flex h-[10px] justify-between gap-2">
                <span className={LBL}>{mode ? (w.ersModes[mode] ?? w.ersModes[mode.slice(0, 3).toUpperCase()] ?? mode) : ""}</span>
                <span className={`${LBL_INK} ${ENERGY_TONE[energy]}`}>{w.energy[energy]}</span>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <span className="flex items-center gap-2 self-center">
                  <span className={LBL}>{w.rpm}</span>
                  {showAero ? <AeroTag t={t} /> : null}
                </span>
                <span className="lc-mono text-[34px] leading-none font-semibold tracking-[-0.02em] text-lc-chalk">{Math.round(t.rpm)}</span>
              </div>
              <span aria-hidden className="relative mt-[11px] mb-2 block h-[6px] overflow-hidden bg-lc-titanium">
                <span
                  className={`absolute inset-0 origin-left ${shift ? "" : "bg-lc-chalk"}`}
                  style={{ transform: `scaleX(${Math.min(1, Math.max(0, t.rpm / Math.max(1, revFull)))})`, ...(shift ? { backgroundColor: HUD_SHIFT } : null) }}
                />
              </span>
              <div className="flex h-[10px] justify-between gap-2">
                <span className={LBL}>
                  {w.top}
                  <span className="ml-[5px] text-lc-chalk">
                    {formatSpeed(t.topSpeedThisLapKmh, units)} {speedUnit(units)}
                  </span>
                </span>
                {shift ? (
                  <span className={LBL_INK} style={{ color: HUD_SHIFT }}>
                    {w.shift}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
      <div role="group" aria-label={w.electronics} className="mt-[3px] grid h-10 grid-cols-[1fr_1fr_1.25fr] gap-[3px]">
        <div className={`${PLATE} ${SLANT}`}>
          <div className={`flex h-full items-center justify-center gap-[17px] ${UNSLANT}`}>
            <Dial label={w.tc} value={tuner ? (tuner.tcLevel > 0 ? String(tuner.tcLevel) : w.off) : NONE} active={aids.tc} />
            <Dial label={w.abs} value={tuner ? (tuner.absAllowed && tuner.absLevel > 0 ? String(tuner.absLevel) : w.off) : NONE} active={aids.abs} />
          </div>
        </div>
        <div className={`${PLATE} ${SLANT}`}>
          <div className={`flex h-full items-center justify-center gap-[17px] ${UNSLANT}`}>
            <Dial label={w.bias} value={tuner ? tuner.brakeBiasPct.toFixed(1) : NONE} />
            <Dial label={w.map} value={tuner ? String(tuner.engineMap) : NONE} />
          </div>
        </div>
        <div className={`${PLATE} ${SLANT}`}>
          <div className={`flex h-full items-center justify-center gap-[13px] ${UNSLANT}`}>
            <Dial label={w.fuel} value={t.fuelKg > 0.01 ? t.fuelKg.toFixed(1) : NONE} unit={w.kg} />
            <Dial value={fuelLaps === null ? NONE : fuelLaps.toFixed(1)} unit={w.laps} />
          </div>
        </div>
      </div>
    </>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Beside the cluster: the cars alongside, seen from above; nothing while the road round the car is clear              */
/* ------------------------------------------------------------------------------------------------------------------ */

const RADAR_PX = 140;
/** Metres from the car to the radar's edge: the cars alongside and just ahead or behind */
const RADAR_RANGE_M = 9.5;

const Radar: React.FC<{ blips: RadarBlip[] | undefined; w: Words }> = ({ blips, w }) => {
  const id = `lc-rl-radar-${useId().replace(/:/g, "")}`;
  const seen = evaluateRadar(blips ?? []);
  // Only the cars inside the disc show it
  const near = seen.blips.filter((b) => Math.abs(b.blip.x) < RADAR_RANGE_M && Math.abs(b.blip.z) < RADAR_RANGE_M + RADAR_CAR_L / 2);
  const opacity = near.reduce((max, b) => Math.max(max, b.opacity), 0);
  const R = RADAR_RANGE_M;
  const side = (car: (typeof near)[number] | null, dir: -1 | 1) =>
    car && near.includes(car) ? (
      <line
        x1={dir * (RADAR_CAR_W / 2 + 0.3)}
        x2={dir * (RADAR_CAR_W / 2 + 0.3)}
        y1={-RADAR_CAR_L / 2 - 0.5}
        y2={RADAR_CAR_L / 2 + 0.5}
        stroke={car.overlapLevel === 2 ? "var(--color-lc-loss)" : "var(--color-lc-caution)"}
        strokeWidth={0.6}
      />
    ) : null;
  return (
    <div
      role="img"
      aria-label={w.radar}
      aria-hidden={near.length === 0}
      className="absolute right-full bottom-1 mr-[34px] transition-opacity duration-150 ease-out"
      style={{ opacity }}
    >
      <svg width={RADAR_PX} height={RADAR_PX} viewBox={`${-R} ${-R} ${R * 2} ${R * 2}`} fill="none" className="block">
        <defs>
          <radialGradient id={id}>
            <stop offset="0" stopColor="var(--color-lc-void)" stopOpacity={0.8} />
            <stop offset="0.72" stopColor="var(--color-lc-void)" stopOpacity={0.62} />
            <stop offset="1" stopColor="var(--color-lc-void)" stopOpacity={0} />
          </radialGradient>
          <clipPath id={`${id}-clip`}>
            <circle r={R * 0.94} />
          </clipPath>
        </defs>
        <circle r={R} fill={`url(#${id})`} />
        <path d={`M0 ${-R * 0.76}V${R * 0.76}M${-R * 0.76} 0H${R * 0.76}`} stroke="var(--color-lc-chalk)" strokeOpacity={0.14} strokeWidth={0.15} />
        <g clipPath={`url(#${id}-clip)`}>
          {near.map(({ blip: b, opacity: seenAs }, i) => (
            <rect
              key={i}
              x={-RADAR_CAR_W / 2}
              y={-RADAR_CAR_L / 2}
              width={RADAR_CAR_W}
              height={RADAR_CAR_L}
              fill={b.color}
              fillOpacity={Math.max(0.3, seenAs)}
              stroke="var(--color-lc-void)"
              strokeWidth={0.22}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          ))}
          <rect x={-RADAR_CAR_W / 2} y={-RADAR_CAR_L / 2} width={RADAR_CAR_W} height={RADAR_CAR_L} fill="var(--color-lc-volt)" />
          {/* A bar on the side a car is alongside: caution, or loss once the cars overlap fully */}
          {side(seen.leftCar, -1)}
          {side(seen.rightCar, 1)}
        </g>
      </svg>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const RacingLineHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  ffb,
  mfd,
  channels,
  topInset,
  lapInvalid,
  towerGaps,
  mapMode,
  weather,
  leftExtra,
  showDeltaBar,
  showRadar,
}) => {
  const w = useRacingLineWords();
  // The HUD size, held to what the window has room for
  const s = useRacingLineScale(scale);
  const lights = t.race?.phase === "lights";
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: position, lap and flag over the cars round the player; split gaps, damage and the board under it */}
      <div className="absolute flex w-[424px] flex-col gap-2" style={{ top: EDGE, left: EDGE, ...anchor(s, "top left") }}>
        <RaceBlock t={t} w={w} weather={weather} />
        {leftExtra}
      </div>

      {/* Top centre: the delta strip (the start lights have the place while they are on) */}
      {showDeltaBar !== false && !lights ? (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: topInset ?? EDGE, ...anchor(s, "top center") }}>
          <DeltaStrip t={t} deltaS={deltaS} w={w} />
        </div>
      ) : null}

      {/* Top right: lap timing over the bare circuit map */}
      <div className="absolute flex flex-col items-end" style={{ top: EDGE, right: EDGE, ...anchor(s, "top right") }}>
        <TimingPlate t={t} deltaS={deltaS} lapInvalid={lapInvalid} w={w} />
        <div className="mt-[17px] mr-1">
          <CircuitMap map={map} t={t} local={mapMode === "local"} w={w} />
        </div>
      </div>

      {/* Bottom left: the wheel force meter and the engineering channels, when they are on */}
      {ffb || channels ? (
        <div className="absolute flex flex-col items-start gap-2" style={{ bottom: EDGE, left: EDGE, ...anchor(s, "bottom left") }}>
          {ffb}
          {channels}
        </div>
      ) : null}

      {/* Bottom centre: the cluster, with the radar beside it while a car is close */}
      <div className="absolute left-1/2 w-[640px] -translate-x-1/2" style={{ bottom: EDGE, ...anchor(s, "bottom center") }}>
        {showRadar !== false && !lights ? <Radar blips={t.radar} w={w} /> : null}
        <div role="group" aria-label={w.cluster} data-hud-avoid>
          <Cluster t={t} revRange={revRange} w={w} />
        </div>
      </div>

      {/* Bottom right: the MFD (the live tuner) over the paged box */}
      <div className="absolute flex flex-col items-end gap-2" style={{ bottom: EDGE, right: EDGE, ...anchor(s, "bottom right") }}>
        {mfd}
        <PagedBox t={t} compound={compound as TireCompound} w={w} towerGaps={towerGaps} />
      </div>
    </div>
  );
};
