"use client";

import React from "react";
import { getActivePointToPoint } from "@/lib/track-data";
import type { CarTelemetry, RaceStandingEntry, TireCompound } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { revLedBand, type RevLedBand } from "@/lib/sim/rev-range";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  lapClockMs,
  lapMark,
  sectorDone,
  sessionWord,
  speedUnit,
  type LapMark,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { pedalLayers } from "../PedalBars";
import { driverLabel, evaluateRadar, formatClock, idealLapMs, relativeCars, sessionBestLapMs } from "../third-party-data";
import { revLights, useSessionClock } from "./third-party-parts";
import { anchor, gearLabel, raceNeighbours, type HudDesignProps, type HudStyleOptions } from "./hud-style-parts";
import { onFinalLap } from "./game-style-parts";
import { PitWallDetail } from "./PitWallPages";
import { BOX, COLS, EDGE, GapTrend, HAIR, HEAD, LBL, NONE, NUM, NUMB, TAG, lbl, formatRpm, useLapStartBests, usePitWallFit, usePitWallWords, type PitWallFit, type PitWallWords } from "./PitWallParts";

/**
 * Pit wall: the race read off tables, as a timing screen shows it. No gauges and no map.
 * Top left the lap timing box (position, lap, flag; current, last, best and optimal lap; the sectors against the best;
 * the cars ahead and behind with their gaps and how they move; track limits and the clock). Top centre the delta to
 * the best lap as a bar from the centre, and under it the spotter's call while a car is alongside. Bottom left the
 * relative (the cars nearest on the road) over a compact speed, gear, rpm, pedals and steering block. Bottom right one
 * paged box (order or laps, fuel, tyres, car, damage) with the fuel, energy and electronics lines on every page, and
 * the live tuner above it.
 */
export const PIT_WALL_STYLE: HudStyleOptions = {
  // Nothing of the layout's own sits at the bottom centre
  bottomClearance: 16,
  ownsBottomLeft: true,
  mfdFolded: true,
  // The delta bar (46 px) and the spotter's call under it (12 + 30 px), from 32 px down
  topClearance: 112,
  // Nothing at the top centre on the grid
  topClearanceInLights: 0,
  ownDeltaBar: true,
  ownRadar: true,
  // The paged box has a damage page, and its tab shows the damage on every page
  ownDamage: true,
  // The lap-timing box carries the cars ahead and behind with their gaps and trend
  ownSplits: true,
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: lap timing                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The flag plate's ink and fill: a flag's own colour is its identity */
const FLAG_PLATE = {
  green: "bg-lc-green text-lc-void",
  caution: "bg-lc-amber text-lc-void",
  blue: "bg-lc-cyan text-lc-void",
  chalk: "bg-lc-chalk text-lc-void",
  plain: "bg-lc-titanium text-lc-chalk",
} as const;

function flagOf(t: CarTelemetry, w: PitWallWords): { word: string; plate: string; chequered?: boolean } | null {
  const race = t.race;
  if (!race) return t.outLap ? { word: w.outLap, plate: FLAG_PLATE.plain } : null;
  if (race.phase === "finished") return { word: w.flag.finished, plate: FLAG_PLATE.chalk, chequered: true };
  if (race.phase === "lights") return { word: w.flag.grid, plate: FLAG_PLATE.plain };
  if (race.vsc) return { word: race.vsc.phase === "ending" ? w.flag.vscEnding : w.flag.vsc, plate: FLAG_PLATE.caution };
  if (race.doubleYellow) return { word: w.flag.doubleYellow, plate: FLAG_PLATE.caution };
  if (race.yellow) return { word: w.flag.yellow, plate: FLAG_PLATE.caution };
  if (race.blueFlag) return { word: w.flag.blue, plate: FLAG_PLATE.blue };
  if (onFinalLap(t)) return { word: w.flag.finalLap, plate: FLAG_PLATE.chalk };
  return { word: w.flag.green, plate: FLAG_PLATE.green };
}

/** A label and its reading on one line of the timing box */
const Line: React.FC<{ label: string; big?: boolean; children: React.ReactNode }> = ({ label, big = false, children }) => (
  <div className={`flex items-center justify-between gap-2 px-3 ${big ? "h-10" : "h-[27px]"} ${HAIR}`}>
    <span className={LBL}>{label}</span>
    <span className={`${NUM} inline-flex items-center gap-2 ${big ? "text-[26px] tracking-[-0.02em]" : "text-[15px]"}`}>{children}</span>
  </div>
);

const MARK_TEXT: Record<LapMark, string> = { best: "text-lc-best", pb: "text-lc-gain", slower: "text-lc-caution" };

interface SectorRead {
  /** Done this lap, being driven now, or still to come */
  state: "done" | "live" | "todo";
  ms: number;
  /** Against the best the sector had when the lap started (s); null without one */
  deltaS: number | null;
  mark: LapMark | null;
}

function sectorReads(t: CarTelemetry, startBests: readonly (number | null)[]): SectorRead[] {
  let doneMs = 0;
  let allDone = true;
  return [0, 1, 2].map((i): SectorRead => {
    if (sectorDone(t, i)) {
      const ms = t.sectorTimesMs[i];
      doneMs += ms;
      const best = startBests[i];
      return { state: "done", ms, deltaS: best && best > 0 ? (ms - best) / 1000 : null, mark: lapMark(ms, best, !t.race) };
    }
    const live = !t.outLap && i + 1 === t.currentSector && allDone;
    allDone = false;
    // The running sector's time is what the lap clock has over the sectors already done
    return { state: live ? "live" : "todo", ms: live ? Math.max(0, lapClockMs(t) - doneMs) : 0, deltaS: null, mark: null };
  });
}

const LapTiming: React.FC<{ t: CarTelemetry; lapInvalid: boolean; fit: PitWallFit; w: PitWallWords }> = ({ t, lapInvalid, fit, w }) => {
  const race = t.race;
  const sessionS = useSessionClock();
  const startBests = useLapStartBests(t);
  const flag = flagOf(t, w);
  const sessionBest = sessionBestLapMs(t);
  const best = t.bestLapTimeMs;
  const holdsBest = best !== null && best > 0 && sessionBest !== null && best <= sessionBest + 0.5;
  const sectors = sectorReads(t, startBests);
  const near = race ? raceNeighbours(t) : null;
  const racing = race?.phase === "racing";
  const splits = racing ? race?.splits : undefined;
  const limits = t.trackLimits;
  const struck = limits ? (limits.ladder ? limits.ladder.points > 0 : limits.warnings > 0) : false;
  const lapNo = Math.max(1, race ? race.lap : t.lapCount);

  return (
    <section aria-label={w.region.lapTiming} className={`w-[344px] ${BOX}`}>
      {/* Position, lap and flag */}
      <div className="flex h-[54px] items-stretch border-b border-lc-line">
        {race ? (
          <div className="flex shrink-0 items-center bg-lc-volt px-3.5 text-lc-void" role="img" aria-label={w.positionOf(race.position, race.fieldSize)}>
            <span className="lc-disp text-[34px] leading-none">{w.positionShort(race.position)}</span>
          </div>
        ) : (
          <div className="flex shrink-0 items-center bg-lc-titanium px-3.5">
            <span className="lc-disp text-[19px] leading-none">{sessionWord(t)}</span>
          </div>
        )}
        <div className="lc-mono flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-3.5 text-[17px] leading-none font-bold whitespace-nowrap">
          {/* "of 8" in its own language's direction ("من 8" reads right to left), kept to the left edge; the lap line
              stays left to right, so 4 / 5 never turns into 5 / 4 */}
          {race ? <span dir="auto" className="self-start">{w.ofField(race.fieldSize)}</span> : null}
          <span className="uppercase">
            {race?.totalLaps ? w.lapOf(lapNo, race.totalLaps) : !race && getActivePointToPoint() ? w.run(lapNo) : w.lap(lapNo)}
          </span>
        </div>
        {flag ? (
          <div
            className={`lc-mono flex max-w-[112px] shrink-0 items-center justify-center gap-1.5 px-3 text-center text-[11px] leading-[1.2] font-extrabold tracking-[0.14em] uppercase ${flag.plate}`}
          >
            {flag.chequered ? <Icon name="chequered" size="xs" /> : null}
            {flag.word}
          </div>
        ) : null}
      </div>

      {/* The lap being driven, and the laps to beat */}
      <Line label={w.current} big>
        {lapInvalid ? (
          <span className={`${TAG} bg-lc-loss text-lc-void`}>
            <Icon name="trackLimits" size="xs" className="size-3" />
            {w.invalid}
          </span>
        ) : null}
        <span className={lapInvalid ? "text-lc-loss" : ""}>{formatLapClock(t)}</span>
      </Line>
      <Line label={w.last}>
        {t.lastLapValid === false && t.lastLapTimeMs ? <Icon name="trackLimits" size="xs" label={w.invalid} className="size-3.5 text-lc-loss" /> : null}
        <span className={t.lastLapValid === false && t.lastLapTimeMs ? "text-lc-loss" : ""}>{formatLapTime(t.lastLapTimeMs)}</span>
      </Line>
      <Line label={w.best}>
        {holdsBest ? <Icon name="time" size="xs" label={w.sessionBest} className="size-3.5 text-lc-best" /> : null}
        <span className={best ? (holdsBest ? "text-lc-best" : "text-lc-gain") : ""}>{formatLapTime(best)}</span>
      </Line>
      <Line label={w.optimal}>{formatLapTime(idealLapMs(t))}</Line>

      {/* Sectors: the time, and how it compares with the best the sector had when the lap started */}
      {fit.short ? (
        <div className={`grid h-[27px] grid-cols-3 items-center px-3 ${HAIR}`}>
          {sectors.map((s, i) => (
            <span key={i} className="flex items-baseline gap-2">
              <span className={s.state === "todo" ? LBL : lbl("text-lc-chalk")}>{w.sectorShort[i]}</span>
              <span className={`${NUM} text-[14px] ${s.mark ? MARK_TEXT[s.mark] : s.state === "todo" ? "text-lc-dim" : ""}`}>
                {s.state === "todo" ? "--.---" : formatSectorTime(s.ms)}
              </span>
            </span>
          ))}
        </div>
      ) : (
        <>
          <div className={`grid h-[22px] grid-cols-[44px_1fr_78px_76px] items-center gap-x-2 px-3 ${COLS} ${HAIR}`}>
            <span className={LBL}>{w.sector}</span>
            <span />
            <span className={`${LBL} text-right`}>{w.time}</span>
            <span className={`${LBL} text-right`}>{w.deltaBest}</span>
          </div>
          {sectors.map((s, i) => {
            const tone = s.mark ? MARK_TEXT[s.mark] : "";
            return (
              <div key={i} className={`grid h-[25px] grid-cols-[44px_1fr_78px_76px] items-center gap-x-2 px-3 ${HAIR}`}>
                <span className={s.state === "todo" ? LBL : lbl("text-lc-chalk")}>{w.sectorShort[i]}</span>
                <span className={`lc-mono text-right text-[10px] leading-none font-extrabold tracking-[0.12em] uppercase ${tone}`}>
                  {s.mark === "best" ? w.markBest : s.mark === "pb" ? w.markPb : ""}
                </span>
                <span className={`${NUM} text-right text-[14px] ${s.state === "todo" ? "text-lc-dim" : tone}`}>
                  {s.state === "todo" ? "--.---" : formatSectorTime(s.ms)}
                </span>
                <span className={`${NUM} text-right text-[14px] ${s.state === "done" ? tone : "text-lc-slate"}`}>
                  {s.state === "live" ? w.live : s.deltaS !== null ? formatDeltaFit(s.deltaS) : ""}
                </span>
              </div>
            );
          })}
        </>
      )}

      {/* The cars directly ahead and behind in the order */}
      {race
        ? (["ahead", "behind"] as const).map((side) => {
            const car = near?.[side] ?? null;
            const split = splits?.[side];
            return (
              <div key={side} className={`grid h-[27px] grid-cols-[62px_14px_1fr_70px_66px] items-center px-3 ${HAIR}`}>
                <span className={LBL}>{side === "ahead" ? w.ahead : w.behind}</span>
                {car ? <i aria-hidden className="block h-[15px] w-1" style={{ backgroundColor: car.color }} /> : <span />}
                <span className={`lc-mono text-[14px] leading-none font-bold tracking-[0.04em] ${car ? "" : "text-lc-dim"}`}>{car ? car.code : NONE}</span>
                <span className={`${NUMB} text-right text-[15px]`}>{car && racing ? formatGap(car.gap, true) : ""}</span>
                <GapTrend changeS={car && split && split.driverCode === car.code ? split.changeS : undefined} side={side} w={w} />
              </div>
            );
          })
        : null}

      {/* Track limits and the clock */}
      <div className="grid h-[27px] grid-cols-[62px_1fr_auto_66px] items-center gap-x-2 px-3">
        <span className={LBL}>{w.limits}</span>
        <span className="flex items-center gap-2">
          <span className={`lc-mono text-[14px] leading-none font-bold tracking-[0.04em] ${limits ? (struck ? "text-lc-caution" : "") : "text-lc-dim"}`}>
            {limits ? (limits.ladder ? `${limits.ladder.points} / ${limits.ladder.pointsAllowed}` : `${limits.warnings} / ${limits.strikesPerPenalty}`) : NONE}
          </span>
          {limits && limits.penaltyS > 0 ? (
            <span className={`${TAG} bg-lc-loss text-lc-void`}>
              <Icon name="penalty" size="xs" className="size-3" />
              {w.penalty(limits.penaltyS)}
            </span>
          ) : null}
        </span>
        <span className={`${LBL} text-right`}>{t.qualifying ? w.timeLeft : w.time}</span>
        <span className={`${NUM} text-right text-[15px]`}>{formatClock(t.qualifying ? t.qualifying.remainingS : sessionS)}</span>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top centre: delta to the best lap, and the spotter                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The bar is full at this much either way (s) */
const DELTA_FULL_S = 1;

const DeltaBar: React.FC<{ deltaS: number | null; narrow: boolean; w: PitWallWords }> = ({ deltaS, narrow, w }) => {
  const known = deltaS !== null && Number.isFinite(deltaS);
  const share = known ? Math.min(1, Math.abs(deltaS) / DELTA_FULL_S) : 0;
  const gain = known && deltaS <= 0;
  return (
    <section
      aria-label={w.region.delta}
      className={`grid h-[46px] items-center ${narrow ? "w-[380px] grid-cols-[78px_1fr_116px]" : "w-[500px] grid-cols-[92px_1fr_128px]"} ${BOX}`}
    >
      <span className={`${LBL} pl-3.5`}>{w.deltaBest}</span>
      <div className="relative h-3 bg-lc-titanium" aria-hidden>
        <span className="absolute inset-y-0 left-1/4 w-px bg-white/18" />
        <span className="absolute inset-y-0 left-3/4 w-px bg-white/18" />
        {/* Faster grows to the left of the centre, slower to the right */}
        {share > 0.002 ? (
          <span
            className={`absolute inset-y-0 w-1/2 ${gain ? "left-0 origin-right bg-lc-gain" : "left-1/2 origin-left bg-lc-loss"}`}
            style={{ transform: `scaleX(${share.toFixed(3)})` }}
          />
        ) : null}
        <span className="absolute -top-[5px] left-1/2 h-[22px] w-0.5 -translate-x-1/2 bg-lc-chalk" />
      </div>
      <span className={`${NUM} pr-3.5 text-right text-[26px] tracking-[-0.02em] ${known ? (gain ? "text-lc-gain" : "text-lc-loss") : "text-lc-slate"}`}>
        {known ? formatDeltaFit(deltaS) : "--.---"}
      </span>
    </section>
  );
};

const Pointer: React.FC<{ left?: boolean }> = ({ left = false }) => (
  <svg width={9} height={12} viewBox="0 0 9 12" aria-hidden className={`shrink-0 ${left ? "-scale-x-100" : ""}`}>
    <path d="M0 0 9 6 0 12Z" fill="currentColor" />
  </svg>
);

/**
 * The spotter's call: a car alongside, on which side. Solid while it overlaps the player's car, outlined while it is
 * coming alongside. Read off the same radar blips and thresholds as the shared proximity radar.
 */
const Spotter: React.FC<{ t: CarTelemetry; w: PitWallWords }> = ({ t, w }) => {
  const blips = t.radar;
  if (!blips || blips.length === 0) return null;
  const { leftCar, rightCar } = evaluateRadar(blips);
  if (!leftCar && !rightCar) return null;
  const close = Math.max(leftCar?.overlapLevel ?? 0, rightCar?.overlapLevel ?? 0) >= 2;
  return (
    <div
      role="status"
      aria-label={w.region.spotter}
      className={`lc-mono flex h-[30px] items-center gap-2.5 border px-3.5 text-[13px] leading-none font-extrabold tracking-[0.16em] whitespace-nowrap uppercase ${
        close ? "border-lc-caution bg-lc-caution text-lc-void" : "border-lc-caution bg-lc-void/93 text-lc-caution"
      }`}
    >
      {leftCar ? <Pointer left /> : null}
      {leftCar && rightCar ? w.carBoth : leftCar ? w.carLeft : w.carRight}
      {rightCar ? <Pointer /> : null}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom left: the relative, and the speed block under it                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

interface RelativeRow {
  e: RaceStandingEntry;
  pos: number;
  /** Time to the car (s): + ahead of the player, − behind; null on the player's own row and before the start */
  gapS: number | null;
  /** Laps the car is up (+) or down (−) on the player */
  laps: number;
  /** The car directly ahead or behind in the order: the only two whose gap has a trend */
  side: "ahead" | "behind" | null;
  changeS: number | undefined;
}

/**
 * The cars nearest the player on the road, `count` rows with the player as near the middle as the field allows. A car
 * on the player's lap shows the timed gap (the split gap for the two neighbours, so it agrees with the timing box);
 * a car a lap up or down shows the time to it on the road.
 */
function relativeRows(t: CarTelemetry, lengthM: number, count: number): RelativeRow[] {
  const race = t.race;
  if (!race) return [];
  const cars = relativeCars(t, lengthM, count - 1);
  const meAt = cars.findIndex((c) => c.entry.isPlayer);
  if (meAt < 0) return [];
  const me = cars[meAt].entry;
  const start = Math.max(0, Math.min(meAt - Math.floor((count - 1) / 2), cars.length - count));
  const near = raceNeighbours(t);
  const racing = race.phase === "racing";
  return cars.slice(start, start + count).map((c): RelativeRow => {
    const e = c.entry;
    const pos = race.standings.indexOf(e) + 1;
    if (e.isPlayer) return { e, pos, gapS: null, laps: 0, side: null, changeS: undefined };
    const side = near?.ahead?.code === e.driverCode ? "ahead" : near?.behind?.code === e.driverCode ? "behind" : null;
    const split = side ? race.splits?.[side] : undefined;
    let gapS: number | null = null;
    if (racing) {
      if (c.lapsAhead !== 0) gapS = c.gapS;
      else if (side === "ahead" && near?.ahead) gapS = near.ahead.gap;
      else if (side === "behind" && near?.behind) gapS = -near.behind.gap;
      else gapS = me.gapToLeaderS - e.gapToLeaderS;
    }
    return { e, pos, gapS, laps: c.lapsAhead, side, changeS: racing && split && split.driverCode === e.driverCode ? split.changeS : undefined };
  });
}

const REL_COLS = "grid grid-cols-[34px_10px_1fr_26px_84px_62px] items-center";

const Relative: React.FC<{ t: CarTelemetry; lengthM: number; compound: TireCompound; rows: number; w: PitWallWords }> = ({ t, lengthM, compound, rows, w }) => {
  const list = relativeRows(t, lengthM, rows);
  if (list.length === 0) return null;
  return (
    <div role="table" aria-label={w.region.relative}>
      <div className={`flex h-[30px] items-center pr-2.5 pl-3 ${HEAD}`}>
        <b className="lc-disp text-[15px] leading-none">{w.relative}</b>
      </div>
      {list.map(({ e, pos, gapS, laps, side, changeS }) => {
        const tyre = e.isPlayer ? (e.compound ?? compound) : e.compound;
        return (
          <div key={e.driverCode} role="row" className={`${REL_COLS} h-7 ${HAIR} ${e.isPlayer ? "bg-lc-volt text-lc-void" : ""}`}>
            <span className={`${NUMB} text-center text-[14px] ${e.isPlayer ? "" : "text-lc-fog"}`}>{pos}</span>
            <i aria-hidden className="block h-[15px] w-1" style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }} />
            <span className="flex min-w-0 items-center gap-1.5 pr-1">
              <span className="truncate text-[15px] leading-none font-semibold">{driverLabel(e)}</span>
              {laps !== 0 ? (
                <span className={`${TAG} ${laps > 0 ? "bg-lc-info text-lc-void" : "bg-lc-titanium text-lc-fog"}`}>{laps > 0 ? w.lapsUp(laps) : w.lapsDown(-laps)}</span>
              ) : null}
              {e.penaltyS ? <span className={`${TAG} ${e.isPlayer ? "bg-lc-void text-lc-volt" : "bg-lc-loss text-lc-void"}`}>{w.penalty(e.penaltyS)}</span> : null}
            </span>
            <span className="flex justify-center">{tyre ? <CompoundGlyph compound={tyre} size={18} /> : null}</span>
            <span className={`${NUMB} text-right text-[15px]`} title={gapS === null ? undefined : w.gapToYou}>
              {gapS === null ? "" : `${gapS >= 0 ? "+" : "−"}${formatGap(gapS, true)}`}
            </span>
            {side ? <GapTrend changeS={changeS} side={side} w={w} className="pr-2.5" /> : <span />}
          </div>
        );
      })}
    </div>
  );
};

const REV_COUNT = 24;
const REV_BAND_BG: Record<RevLedBand, string> = { green: "bg-lc-green", yellow: "bg-lc-amber", red: "bg-lc-crimson", shift: "bg-lc-cyan" };
/** Each rev light's lit colour: the bands the wheel and every other layout share */
const REV_LIT: readonly string[] = Array.from({ length: REV_COUNT }, (_, i) => REV_BAND_BG[revLedBand(i, REV_COUNT)]);

/** One pedal: what the electronics let through as the solid fill, what they cut on top in the caution colour */
const Pedal: React.FC<{ label: string; short: string; demand: number; output?: number; fill: string; cut?: boolean }> = ({
  label,
  short,
  demand,
  output = demand,
  fill,
  cut = false,
}) => (
  <span className="flex flex-col items-center gap-1">
    <span
      className="relative block h-[50px] w-3 overflow-hidden bg-lc-titanium"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(output * 100)}
    >
      {cut && demand - output > 0.005 ? <span className="absolute inset-0 origin-bottom bg-lc-caution" style={{ transform: `scaleY(${demand.toFixed(3)})` }} /> : null}
      <span className={`absolute inset-0 origin-bottom ${fill}`} style={{ transform: `scaleY(${output.toFixed(3)})` }} />
    </span>
    <span aria-hidden className={`lc-mono text-[9px] leading-none font-extrabold ${cut ? "text-lc-caution" : "text-lc-slate"}`}>
      {short}
    </span>
  </span>
);

/** Speed, gear, rpm, pedals and steering: the numbers a driver glances at, as one compact row */
const DriverBlock: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: PitWallWords }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const lights = revLights(t.rpm, revRange, REV_COUNT);
  const p = pedalLayers(t);
  const aero = aeroReadout(t);
  const showAero = (t.f12026?.hasDrs ?? false) && t.overtakingRules !== "none";
  return (
    <div role="group" aria-label={w.region.driver}>
      <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5 px-2.5 pt-2" aria-hidden>
        {REV_LIT.map((lit, i) => (
          <i key={i} className={`block h-2 ${lights.atShift ? "bg-lc-cyan" : lights.on(i) ? lit : "bg-lc-titanium"}`} />
        ))}
      </div>
      <div className="grid grid-cols-[62px_1fr_auto_auto] items-center gap-3.5 px-2.5 pt-2 pb-2.5">
        <div className={`grid h-[66px] w-[62px] place-items-center text-lc-void ${lights.atShift ? "bg-lc-cyan" : "bg-lc-volt"}`} title={lights.atShift ? w.shift : undefined}>
          <b className="lc-disp text-[56px] leading-none">{gearLabel(t.gear)}</b>
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`${NUM} text-[40px] tracking-[-0.03em]`}>{formatSpeed(t.speedKmh, units)}</span>
            <span className={LBL}>{speedUnit(units)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className={`${NUM} text-[13px] text-lc-fog`}>{formatRpm(t.rpm)}</span>
            <span className={LBL}>{w.rpm}</span>
            {showAero ? (
              <span
                className={`${TAG} ml-auto border ${
                  aero.open ? "border-lc-info bg-lc-info text-lc-void" : aero.armed || aero.queued ? "border-lc-info text-lc-info" : "border-lc-line text-lc-slate"
                }`}
              >
                <Icon name={aero.open ? "drsOpen" : "drsClosed"} size="xs" className="size-3" />
                {aero.label}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex h-[66px] items-end gap-[5px]">
          <Pedal label={w.pedal.clutch} short={w.pedal.clutchShort} demand={p.clutch} fill="bg-lc-azure" />
          <Pedal label={w.pedal.brake} short={w.pedal.brakeShort} demand={p.brake} output={p.brakeOut} fill="bg-(--lc-sem-brake)" cut={p.absActive} />
          <Pedal label={w.pedal.throttle} short={w.pedal.throttleShort} demand={p.throttle} output={p.throttleOut} fill="bg-(--lc-sem-throttle)" cut={p.tcActive} />
        </div>
        <svg width={58} height={58} viewBox="0 0 58 58" fill="none" role="img" aria-label={w.steering} className="text-lc-fog">
          <g transform={`rotate(${(p.steer * 270).toFixed(1)} 29 29)`}>
            <circle cx={29} cy={29} r={24} stroke="currentColor" strokeWidth={5} />
            <path d="M6 29H52M29 29V52" stroke="currentColor" strokeWidth={5} />
            <rect x={26} y={2} width={6} height={7} className="fill-lc-volt" />
          </g>
        </svg>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const PitWallHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  mfd,
  channels,
  ffb,
  topInset,
  lapInvalid,
  towerGaps,
  leftExtra,
  rightExtra,
  showDeltaBar,
  showRadar,
}) => {
  const w = usePitWallWords();
  const fit = usePitWallFit(scale);
  const lights = t.race?.phase === "lights";
  const showDelta = showDeltaBar !== false && !lights;
  const showSpotter = showRadar !== false && !lights;
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: lap timing */}
      <div className="absolute flex flex-col items-start gap-2" style={{ top: EDGE, left: EDGE, ...anchor(scale, "top left") }}>
        <LapTiming t={t} lapInvalid={lapInvalid} fit={fit} w={w} />
        {leftExtra}
      </div>

      {/* Top centre: the delta bar and the spotter's call; clear for the start lights on the grid */}
      {showDelta || showSpotter ? (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ top: topInset ?? EDGE }}>
          <div className="flex flex-col items-center gap-3" style={anchor(scale, "top center")}>
            {showDelta ? <DeltaBar deltaS={deltaS} narrow={fit.narrow} w={w} /> : null}
            {showSpotter ? <Spotter t={t} w={w} /> : null}
          </div>
        </div>
      ) : null}

      {/* Top right: the weather */}
      {rightExtra ? (
        <div className="absolute flex flex-col items-end gap-2" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
          {rightExtra}
        </div>
      ) : null}

      {/* Bottom left: the relative over the speed block */}
      <div className="absolute flex flex-col items-start gap-2" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
        {ffb}
        <div data-hud-avoid className={`w-[430px] ${BOX}`}>
          {fit.tiny ? null : <Relative t={t} lengthM={map.lengthM} compound={compound} rows={fit.short ? 5 : 7} w={w} />}
          <DriverBlock t={t} revRange={revRange} w={w} />
        </div>
      </div>

      {/* Bottom right: the live tuner over the paged box */}
      <div className="absolute flex flex-col items-end gap-2" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
        {mfd}
        {channels}
        <PitWallDetail t={t} lengthM={map.lengthM} compound={compound} towerGaps={towerGaps} w={w} />
      </div>
    </div>
  );
};
