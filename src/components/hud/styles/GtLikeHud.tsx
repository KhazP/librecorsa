"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStandingEntry, TireCompound } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { ClassTag } from "@/components/ui/badges/ClassTag";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { anyCarById, carById, type CarId } from "@/lib/cars/car-registry";
import { useUnits } from "@/lib/settings/ui-prefs";
import { speedIn } from "@/lib/settings/units";
import {
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_INFO,
  HUD_LOSS,
  HUD_RED,
  HUD_SHIFT,
  HUD_THROTTLE,
  LAP_MARK_COLOR,
  aidsActive,
  atShiftPoint,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSpeed,
  lapMark,
  sectorDone,
  sessionWord,
  speedUnit,
  tyreHeatColor,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { pedalLayers } from "../PedalBars";
import { driverLabel, formatClock, fuelLapsLeft, sessionBestLapMs } from "../third-party-data";
import { revLights, useFuelPerLap, useLapHistory, useSessionClock, useStartFuel } from "./third-party-parts";
import {
  AeroBadge,
  anchor,
  formatOnce,
  gearLabel,
  HUD_GLASS,
  HUD_LBL,
  InvalidTag,
  LapMarkGlyph,
  MiniMap,
  raceNeighbours,
  type HudDesignProps,
} from "./hud-style-parts";
import {
  TopDownCar,
  arcPath,
  brakeNow,
  carClassCode,
  fastestLap,
  onFinalLap,
  polar,
  useGearHint,
  useTimingEvent,
  type TimingEvent,
} from "./game-style-parts";

/**
 * GT-Like: the race screen laid out the way a road-racing game lays it out, in LibreCorsa's visual language.
 * Top-left framed position/lap plate over a windowed running order with a protruding gap-to-leader tag and fastest-lap
 * footer; top-centre segmented lap timer flashing sectors and laps with Best/PB and gap blocks; top-right circuit map
 * over chalk-badged lap history; bottom-left chassis silhouette with four vertical tread/heat bars and session clock;
 * bottom-centre twin analog dials (speed + fuel, rpm + battery/boost) flanking an arched digital speed/gear core with
 * suggested corner gear and vertical brake/throttle bars; bottom-right MFD and car identity plate.
 */

const EDGE = "clamp(14px,2.2vw,24px)";

/** Running order's longest list: past it, the top three and a window round the player */
const TOWER_ROWS = 8;
/** Laps listed under the map */
const LAPS_SHOWN = 5;

type Words = ReturnType<typeof useGtWords>;

function useGtWords() {
  const tx = useTranslations("hudStyles.gtLike");
  return useMemo(
    () => ({
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position, total })),
      lap: tx("lap"),
      lapOf: formatOnce((lap: number, total: number) => tx("lapOf", { lap, total })),
      finalLap: tx("finalLap"),
      outLap: tx("outLap"),
      sessionLap: formatOnce((session: string, kind: string, lap: number) => tx("sessionLap", { session, kind, lap })),
      lapTimer: tx("lapTimer"),
      best: tx("best"),
      pb: tx("pb"),
      sector: formatOnce((sector: number) => tx("sector", { sector })),
      lapShort: tx("lapShort"),
      leader: tx("leader"),
      toAhead: tx("toAhead"),
      toBehind: tx("toBehind"),
      gapToLeader: tx("gapToLeader"),
      fastestLap: tx("fastestLap"),
      fastestLapShort: tx("fastestLapShort"),
      runningOrder: tx("runningOrder"),
      lapTimes: tx("lapTimes"),
      lapRow: formatOnce((lap: number) => tx("lapRow", { lap })),
      invalidLap: tx("invalidLap"),
      circuit: tx("circuit"),
      total: tx("total"),
      tyres: tx("tyres"),
      tyre: formatOnce((corner: string, tread: number, temp: number) => tx("tyre", { corner, tread, temp })),
      corners: [tx("cornerFL"), tx("cornerFR"), tx("cornerRL"), tx("cornerRR")] as const,
      brake: tx("brake"),
      throttle: tx("throttle"),
      suggestedGear: formatOnce((gear: string) => tx("suggestedGear", { gear })),
      ahead: tx("ahead"),
      behind: tx("behind"),
      fuel: tx("fuel"),
      boost: tx("boost"),
      battery: tx("battery"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      rpmUnit: tx("rpmUnit"),
      rpm: tx("rpm"),
      speedometer: tx("speedometer"),
      tachometer: tx("tachometer"),
      out: tx("out"),
      tc: tx("tc"),
      abs: tx("abs"),
      car: tx("car"),
    }),
    [tx],
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: framed position / lap plate and windowed running order                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Briefly pulses the position box when the player gains a place */
function usePositionGainFlash(pos: number | undefined): boolean {
  const prev = useRef<number | undefined>(pos);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (pos !== undefined && prev.current !== undefined && pos < prev.current) {
      setFlash(true);
      const id = window.setTimeout(() => setFlash(false), 450);
      prev.current = pos;
      return () => window.clearTimeout(id);
    }
    prev.current = pos;
  }, [pos]);
  return flash;
}

const PositionPlate: React.FC<{ t: CarTelemetry; w: Words; lapInvalid: boolean }> = ({ t, w, lapInvalid }) => {
  const race = t.race;
  const final = onFinalLap(t);
  const gained = usePositionGainFlash(race?.phase === "racing" ? race.position : undefined);

  if (!race) {
    const kind = getActivePointToPoint() ? "run" : "lap";
    return (
      <section aria-label={w.lapTimer} className={`flex h-11 items-center gap-2.5 rounded-lc-tile px-3.5 ${HUD_GLASS}`}>
        <span className="lc-disp truncate text-[17px] leading-none text-lc-chalk">
          {t.outLap ? w.outLap : w.sessionLap(sessionWord(t), kind, Math.max(1, t.lapCount))}
        </span>
        {lapInvalid ? <InvalidTag /> : null}
      </section>
    );
  }

  return (
    <section
      aria-label={w.positionOf(race.position, race.fieldSize)}
      className={`flex h-[60px] items-center gap-2.5 rounded-lc-tile px-2.5 ${HUD_GLASS}`}
    >
      {/* Framed square position cell */}
      <div
        className={`flex size-[44px] shrink-0 items-center justify-center rounded-lc-nub border transition-colors duration-200 ease-lc ${
          gained ? "border-lc-chalk bg-lc-chalk text-lc-void" : "border-lc-chalk/55 bg-lc-well/80 text-lc-chalk"
        }`}
      >
        <span className="lc-disp text-[31px] leading-none tracking-[-0.02em]">{race.position}</span>
      </div>

      {/* Out of how many */}
      <span className="lc-data text-[16px] leading-none text-lc-fog">/{race.fieldSize}</span>

      <span aria-hidden className="mx-1 h-8 w-px bg-white/12" />

      {/* The lap, its label beside it (never above), and the final-lap tag on the same line */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex items-baseline gap-1.5">
          {/* On the last lap the tag says which lap it is */}
          {final ? null : <span className={HUD_LBL}>{w.lap}</span>}
          <span className="lc-data text-[17px] leading-none text-lc-chalk">
            {race.lap}
            {race.totalLaps ? <span className="text-lc-slate">/{race.totalLaps}</span> : null}
          </span>
        </span>
        {final ? (
          <Badge tone="bad" variant="solid" size="hud" icon="chequered" className="w-fit">
            {w.finalLap}
          </Badge>
        ) : null}
      </div>
    </section>
  );
};

/**
 * Windowed running order: everyone up to eight cars; past that the top three, a break, then the two cars ahead of the
 * player and the rest of the eight behind (more ahead near the back)
 */
function towerRows(standings: readonly RaceStandingEntry[]): (RaceStandingEntry | "break")[] {
  if (standings.length <= TOWER_ROWS) return [...standings];
  const me = Math.max(0, standings.findIndex((e) => e.isPlayer));
  if (me < TOWER_ROWS - 1) return standings.slice(0, TOWER_ROWS);
  const span = TOWER_ROWS - 3;
  const start = Math.min(Math.max(3, me - 2), standings.length - span);
  return [...standings.slice(0, 3), "break", ...standings.slice(start, start + span)];
}

const GapLine: React.FC<{ gap: number; ahead: boolean; title: string }> = ({ gap, ahead, title }) => (
  <div title={title} className="flex h-[18px] items-center justify-end gap-1 rounded-lc-nub bg-white/[0.04] px-2">
    <Trend direction={ahead ? "up" : "down"} size={8} label={title} />
    <span className="lc-data text-[10px] leading-none text-lc-fog">
      {ahead ? "+" : "\u2212"}
      {formatGap(gap, true)}
    </span>
  </div>
);

const RunningOrder: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const race = t.race;
  if (!race || race.phase === "lights") return null;
  const rows = towerRows(race.standings);
  const near = raceNeighbours(t);
  const me = race.standings.find((e) => e.isPlayer);
  const fastest = fastestLap(t);

  return (
    <div className="flex flex-col gap-1.5">
      <section aria-label={w.runningOrder} className={`flex flex-col gap-0.5 rounded-lc-tile p-1 ${HUD_GLASS}`}>
        {rows.map((e, i) => {
          if (e === "break") return <div key={`break-${i}`} aria-hidden className="mx-1.5 my-0.5 h-px bg-white/20" />;
          const pos = race.standings.indexOf(e) + 1;
          const prev = rows[i - 1];
          const next = rows[i + 1];
          const aheadOfMe = !e.isPlayer && next !== undefined && next !== "break" && next.isPlayer;
          const behindMe = !e.isPlayer && prev !== undefined && prev !== "break" && prev.isPlayer;
          const showLeaderGapTab = e.isPlayer && me && pos > 1;

          return (
            <React.Fragment key={e.driverCode}>
              {behindMe && near?.behind ? <GapLine gap={near.behind.gap} ahead={false} title={w.toBehind} /> : null}
              <div
                className={`relative flex h-[26px] items-center gap-1.5 rounded-lc-nub pr-2 pl-0.5 ${
                  e.isPlayer ? "bg-lc-volt text-lc-void" : "bg-white/[0.025] text-lc-chalk"
                } ${e.retired ? "opacity-45" : ""}`}
              >
                {/* Framed position square */}
                <span
                  className={`lc-data flex h-[22px] w-[24px] shrink-0 items-center justify-center rounded-lc-nub border text-[11px] leading-none ${
                    e.isPlayer ? "border-lc-void/30 bg-lc-void/12 text-lc-void" : "border-white/18 bg-lc-well/80 text-lc-fog"
                  }`}
                >
                  {pos}
                </span>
                <span
                  aria-hidden
                  className="h-3.5 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }}
                />
                <span className="lc-data min-w-0 flex-1 truncate text-[12px] tracking-[0.04em]">{driverLabel(e)}</span>
                {e.retired ? (
                  <Badge tone="neutral" size="hud">
                    {w.out}
                  </Badge>
                ) : e.finished ? (
                  <Icon name="chequered" size="xs" className="size-3.5" />
                ) : e.isPlayer && pos === 1 ? (
                  <span className="lc-hud-lbl text-lc-void/75">{w.leader}</span>
                ) : e.compound ? (
                  <CompoundGlyph compound={e.compound} size={14} />
                ) : null}

                {/* Protruding gap-to-leader tab beside the player's own row */}
                {showLeaderGapTab ? (
                  <span
                    title={w.gapToLeader}
                    className="lc-data absolute top-0 left-full ml-1.5 inline-flex h-full items-center rounded-lc-nub bg-lc-loss px-2 text-[11px] leading-none whitespace-nowrap text-lc-void shadow-lc-pop"
                  >
                    +{formatGap(me.gapToLeaderS, true)}
                  </span>
                ) : null}
              </div>
              {aheadOfMe && near?.ahead ? <GapLine gap={near.ahead.gap} ahead title={w.toAhead} /> : null}
            </React.Fragment>
          );
        })}
      </section>

      {/* Fastest lap card underneath the running order */}
      {fastest ? (
        <div
          title={w.fastestLap}
          className={`flex flex-col overflow-hidden rounded-lc-tile ${HUD_GLASS}`}
        >
          <div className="flex h-[26px] items-center gap-1.5 px-1.5">
            <span className="lc-data flex h-[20px] w-[24px] shrink-0 items-center justify-center rounded-lc-nub bg-lc-best/20 text-[10px] text-lc-best-ink">
              {w.fastestLapShort}
            </span>
            <span className="lc-data min-w-0 flex-1 truncate text-[12px] text-lc-chalk">{driverLabel(fastest.entry)}</span>
            <Icon name="time" size="xs" className="mr-0.5 size-3.5 text-lc-best-ink" />
          </div>
          <div className="flex h-[22px] items-center justify-end bg-lc-best px-2.5 text-lc-void">
            <span className="lc-data text-[12px] leading-none">{formatLapTime(fastest.ms)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top centre: three-block segmented lap timer                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Seconds the "Final lap" call stays over the timer once the last lap starts */
const FINAL_LAP_CALL_MS = 4000;

function useFinalLapCall(t: CarTelemetry): boolean {
  const final = onFinalLap(t);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!final) {
      setShown(false);
      return;
    }
    setShown(true);
    const id = window.setTimeout(() => setShown(false), FINAL_LAP_CALL_MS);
    return () => window.clearTimeout(id);
  }, [final]);
  return shown;
}

/** The lap's three sectors as tight pips inside the left slot when no event is flashing */
const SectorPips: React.FC<{ t: CarTelemetry }> = ({ t }) => (
  <span className={`flex h-full w-full items-center justify-center gap-1 rounded-lc-nub px-2 ${HUD_GLASS}`} aria-hidden>
    {[0, 1, 2].map((i) => {
      const done = sectorDone(t, i);
      const mark = done ? lapMark(t.sectorTimesMs[i], t.bestSectorTimesMs[i], !t.race) : null;
      const active = i + 1 === t.currentSector;
      return (
        <span
          key={i}
          className="h-1.5 flex-1 rounded-full"
          style={{ backgroundColor: mark ? LAP_MARK_COLOR[mark] : active ? "var(--color-lc-chalk)" : "var(--color-lc-line)" }}
        />
      );
    })}
  </span>
);

/**
 * Three crisp aligned blocks: left status (Best / PB / sector / cut / sector pips), centre running clock that never
 * moves, right gap or live delta block.
 */
const LapTimer: React.FC<{
  t: CarTelemetry;
  deltaS: number | null;
  lapInvalid: boolean;
  showDelta: boolean;
  event: TimingEvent | null;
  w: Words;
}> = ({ t, deltaS, lapInvalid, showDelta, event, w }) => {
  const eventColor = event ? LAP_MARK_COLOR[event.mark] : undefined;
  return (
    <div role="timer" aria-label={w.lapTimer} className="flex h-[42px] items-stretch gap-1">
      {/* Left slot: fixed width so the centre clock stays anchored */}
      <span className="flex w-[76px] shrink-0 items-stretch">
        {event ? (
          event.mark !== "slower" ? (
            <span
              className="lc-disp flex h-full w-full items-center justify-center gap-1 rounded-lc-nub text-[13px] text-lc-void shadow-lc-pop"
              style={{ backgroundColor: eventColor }}
            >
              <Icon name="time" size="xs" className="size-3.5" />
              {event.mark === "best" ? w.best : w.pb}
            </span>
          ) : (
            <span className={`lc-disp flex h-full w-full items-center justify-center rounded-lc-nub text-[13px] text-lc-chalk ${HUD_GLASS}`}>
              {event.sector ? w.sector(event.sector) : w.lapShort}
            </span>
          )
        ) : lapInvalid ? (
          <span className="flex h-full w-full items-center justify-center rounded-lc-nub bg-lc-loss shadow-lc-pop">
            <InvalidTag className="bg-transparent" />
          </span>
        ) : (
          <SectorPips t={t} />
        )}
      </span>

      {/* Centre clock block */}
      <span className={`flex w-[166px] shrink-0 items-center justify-center rounded-lc-row px-3 ${HUD_GLASS}`}>
        <span
          className={`lc-data text-[27px] leading-none tracking-[0.02em] ${
            event ? "text-lc-chalk" : lapInvalid ? "text-lc-loss" : "text-lc-chalk"
          }`}
        >
          {event ? formatLapTime(event.ms) : formatLapClock(t)}
        </span>
      </span>

      {/* Right slot: event gap or live delta */}
      <span className="flex w-[86px] shrink-0 items-stretch">
        {event ? (
          event.gapMs !== null ? (
            <span
              className="lc-data flex h-full w-full items-center justify-center gap-1 rounded-lc-nub px-2 text-[14px] text-lc-void shadow-lc-pop"
              style={{ backgroundColor: eventColor }}
            >
              <Trend direction={event.gapMs <= 0 ? "up" : "down"} size={8} />
              {formatDeltaFit(event.gapMs / 1000)}
            </span>
          ) : null
        ) : showDelta && deltaS !== null ? (
          <span
            className={`lc-data flex h-full w-full items-center justify-center gap-1 rounded-lc-nub px-2 text-[14px] text-lc-void shadow-lc-pop ${
              deltaS <= 0 ? "bg-lc-gain" : "bg-lc-loss"
            }`}
          >
            <Trend direction={deltaS <= 0 ? "up" : "down"} size={8} />
            {formatDeltaFit(deltaS)}
          </span>
        ) : null}
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: circuit map and chalk-badged lap history                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

const LapList: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const laps = useLapHistory(LAPS_SHOWN);
  const sessionBest = sessionBestLapMs(t);
  const myBest = t.bestLapTimeMs;
  if (!laps.length) return null;

  return (
    <section aria-label={w.lapTimes} className="flex flex-col gap-1">
      {laps.map((l) => {
        const best = l.valid && sessionBest !== null && l.ms <= sessionBest + 0.5;
        const pb = l.valid && !best && myBest !== null && l.ms <= myBest + 0.5;
        const rowTone = !l.valid
          ? "border-lc-loss/60 bg-lc-void/86 text-lc-loss-ink shadow-lc-pop backdrop-blur-[8px] in-data-[phone-hud]:backdrop-blur-none"
          : best
            ? "border-transparent bg-lc-best text-lc-void shadow-lc-pop"
            : pb
              ? "border-lc-gain/60 bg-lc-void/86 text-lc-gain shadow-lc-pop backdrop-blur-[8px] in-data-[phone-hud]:backdrop-blur-none"
              : `${HUD_GLASS} text-lc-chalk`;
        return (
          <div key={l.lap} className="flex h-[24px] items-stretch gap-1">
            <span
              className="lc-data flex w-7 shrink-0 items-center justify-center rounded-lc-nub bg-lc-chalk text-[11px] leading-none text-lc-void shadow-lc-pop"
              title={w.lapRow(l.lap)}
            >
              {l.lap}
            </span>
            <div className={`flex flex-1 items-center justify-between rounded-lc-nub border px-2.5 ${rowTone}`}>
              <span className="lc-data text-[12px] leading-none">{formatLapTime(l.ms)}</span>
              {!l.valid ? (
                <span title={w.invalidLap} className="inline-flex text-lc-loss-ink">
                  <Icon name="trackLimits" size="xs" className="size-3.5" />
                </span>
              ) : best ? (
                <Trend direction="up" size={8} label={w.best} />
              ) : pb ? (
                <LapMarkGlyph mark="pb" />
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom left: chassis silhouette with vertical tread/heat bars & session clock                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Vertical tread-bar anchors (FL, FR, RL, RR) in the 120 × 104 tyre widget box */
const TYRE_BAR_AT: readonly [number, number][] = [
  [10, 12],
  [98, 12],
  [10, 62],
  [98, 62],
];

const treadColor = (tread: number) => (tread < 25 ? HUD_LOSS : tread < 45 ? HUD_CAUTION : "var(--color-lc-chalk)");

const TyreCard: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words }> = ({ t, compound, w }) => {
  const damage = t.race?.damage ?? t.practiceDamage;
  const openWheel = carClassCode(t) === "openWheel";
  const label = t.tireWearPct
    .map((wear, i) => w.tyre(w.corners[i], Math.round(100 - wear), Math.round(t.tireTempsC[i])))
    .join(", ");
  const minTread = Math.round(100 - Math.max(...t.tireWearPct));

  return (
    <section aria-label={w.tyres} className={`flex flex-col gap-1.5 rounded-lc-tile px-2.5 pt-2 pb-2 ${HUD_GLASS}`}>
      <svg viewBox="0 0 120 104" className="h-[92px] w-[108px]" role="img" aria-label={label}>
        {/* Precision top-down car silhouette centred between the four vertical tread bars */}
        <g transform="translate(60 52) scale(0.62) translate(-50 -72)">
          <TopDownCar openWheel={openWheel} damage={damage} t={t} showWheels={false} />
        </g>

        {/* Four vertical tyre tread gauges with temperature frame */}
        {TYRE_BAR_AT.map(([x, y], i) => {
          const tread = Math.max(0, Math.min(100, 100 - t.tireWearPct[i]));
          const heat = tyreHeatColor(t.tireTempsC[i], t.tireOptimalTempC);
          const barH = 28;
          const fillH = (barH * tread) / 100;
          return (
            <g key={i}>
              {/* Outer temperature halo frame */}
              <rect x={x - 1.5} y={y - 1.5} width={15} height={barH + 3} rx={3.5} fill="var(--color-lc-void)" fillOpacity={0.75} stroke={heat} strokeWidth={1.8} />
              {/* Depleted wear well underneath (crimson reveals as tread drops) */}
              <rect x={x + 1} y={y + 1} width={10} height={barH - 2} rx={1.5} fill={HUD_LOSS} fillOpacity={0.42} />
              {/* Remaining tread rising from bottom */}
              {fillH > 0.5 ? (
                <rect
                  x={x + 1}
                  y={y + 1 + (barH - 2) * (1 - tread / 100)}
                  width={10}
                  height={(barH - 2) * (tread / 100)}
                  rx={1.5}
                  fill={treadColor(tread)}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="flex items-center justify-between border-t border-white/8 pt-1.5">
        <CompoundGlyph compound={compound} size={18} />
        <span className={`lc-data text-[11px] leading-none ${minTread < 25 ? "text-lc-loss" : minTread < 45 ? "text-lc-caution" : "text-lc-fog"}`}>
          {minTread}%
        </span>
      </div>
    </section>
  );
};

const SessionClock: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const seconds = useSessionClock();
  const aids = aidsActive(t);
  return (
    <div className={`flex h-8 items-center gap-2.5 rounded-lc-row px-3 ${HUD_GLASS}`}>
      <span className="flex items-baseline gap-1.5">
        <span className={HUD_LBL}>{w.total}</span>
        <span className="lc-data text-[14px] leading-none text-lc-chalk">{formatClock(seconds)}</span>
      </span>
      {/* Compact aid indicators appear here when the outer analog dials hide on narrower screens */}
      <span className="flex items-center gap-2 border-l border-white/10 pl-2.5 xl:hidden">
        <span title={w.tc} className={`inline-flex ${aids.tc ? "text-lc-caution" : "text-lc-dim"}`}>
          <Icon name="tractionControl" size="xs" className="size-3.5" />
        </span>
        <span title={w.abs} className={`inline-flex ${aids.abs ? "text-lc-caution" : "text-lc-dim"}`}>
          <Icon name="abs" size="xs" className="size-3.5" />
        </span>
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom centre: sculpted twin-analog + raised digital instrument cluster                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Dials sweep 270°, from bottom-left (−135°) round to bottom-right (+135°) */
const DIAL_FROM = -135;
const DIAL_TO = 135;
const DIAL = 200;
const DC = DIAL / 2;

const dialAngle = (fraction: number) => DIAL_FROM + (DIAL_TO - DIAL_FROM) * Math.min(1, Math.max(0, fraction));

/** Precision tapered needle polygon from counterweight tail to tip */
function needlePoints(angleDeg: number, tipR: number, tailR: number, baseHalfW = 2.6, tipHalfW = 0.7): string {
  const a = (angleDeg * Math.PI) / 180;
  const sinA = Math.sin(a);
  const cosA = Math.cos(a);
  // Perpendicular vector
  const px = cosA;
  const py = sinA;
  const tx = DC + tipR * sinA;
  const ty = DC - tipR * cosA;
  const bx = DC - tailR * sinA;
  const by = DC + tailR * cosA;
  return [
    `${(tx + px * tipHalfW).toFixed(2)},${(ty + py * tipHalfW).toFixed(2)}`,
    `${(bx + px * baseHalfW).toFixed(2)},${(by + py * baseHalfW).toFixed(2)}`,
    `${(bx - px * baseHalfW).toFixed(2)},${(by - py * baseHalfW).toFixed(2)}`,
    `${(tx - px * tipHalfW).toFixed(2)},${(ty - py * tipHalfW).toFixed(2)}`,
  ].join(" ");
}

/** Sub-gauge cleanly nestled in the lower quadrant of a dial: clean arc + inset digital well */
const SubGauge: React.FC<{
  fraction: number;
  color: string;
  label: string;
  value?: string;
}> = ({ fraction, color, label, value }) => {
  const cy = 152;
  const r = 27;
  const from = -68;
  const to = 68;
  const clamped = Math.min(1, Math.max(0, fraction));
  const at = from + (to - from) * clamped;
  return (
    <g>
      <path d={arcPath(DC, cy, r, from, to)} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.14} strokeWidth={3.8} strokeLinecap="round" />
      {clamped > 0.008 ? (
        <path d={arcPath(DC, cy, r, from, at)} fill="none" stroke={color} strokeWidth={3.8} strokeLinecap="round" />
      ) : null}
      <text
        x={DC}
        y={cy - 8}
        textAnchor="middle"
        className="lc-hud-lbl"
        fontSize={9}
        style={{ letterSpacing: "0.06em" }}
        fill="var(--color-lc-slate)"
      >
        {label}
      </text>
      {value ? (
        <g>
          <rect
            x={DC - 32}
            y={cy - 2}
            width={64}
            height={17}
            rx={4}
            fill="var(--color-lc-well)"
            stroke="var(--color-lc-line)"
            strokeWidth={1}
          />
          <text x={DC} y={cy + 10} textAnchor="middle" className="lc-data" fontSize={9.5} fill="var(--color-lc-chalk)">
            {value}
          </text>
        </g>
      ) : null}
    </g>
  );
};

/**
 * Precision motorsport analog dial: illuminated outer sweep arc, quarter-graduated ticks, non-colliding tabular
 * numerals, optional redline zone, tapered needle, and lower sub-gauge.
 */
const AnalogDial: React.FC<{
  value: number;
  max: number;
  step: number;
  tickLabel: (v: number) => string;
  redFrom?: number;
  sweepColor: string;
  needleColor: string;
  unit: string;
  label: string;
  children?: React.ReactNode;
}> = ({ value, max, step, tickLabel, redFrom, sweepColor, needleColor, unit, label, children }) => {
  const frac = Math.min(1, Math.max(0, value / Math.max(1e-6, max)));
  const needle = dialAngle(frac);
  const ticks: number[] = [];
  const subStep = step / 4;
  for (let v = 0; v <= max + 1e-6; v += subStep) ticks.push(v);

  return (
    <div className={`relative size-[178px] shrink-0 rounded-full ${HUD_GLASS}`}>
      <svg viewBox={`0 0 ${DIAL} ${DIAL}`} className="absolute inset-0 size-full" role="img" aria-label={label}>
        {/* Subtle machined inner bezel */}
        <circle cx={DC} cy={DC} r={96} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.08} strokeWidth={1} />
        <circle cx={DC} cy={DC} r={91} fill="none" stroke="var(--color-lc-void)" strokeOpacity={0.6} strokeWidth={6} />

        {/* Outer sweep track */}
        <path d={arcPath(DC, DC, 91, DIAL_FROM, DIAL_TO)} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.1} strokeWidth={4.5} strokeLinecap="butt" />

        {/* Redline band along outer rim */}
        {redFrom !== undefined && redFrom < max ? (
          <path d={arcPath(DC, DC, 91, dialAngle(redFrom / max), DIAL_TO)} fill="none" stroke={HUD_RED} strokeOpacity={0.85} strokeWidth={5} strokeLinecap="butt" />
        ) : null}

        {/* Illuminated live value sweep arc */}
        {frac > 0.004 ? (
          <path d={arcPath(DC, DC, 91, DIAL_FROM, needle)} fill="none" stroke={sweepColor} strokeWidth={4.5} strokeLinecap="butt" />
        ) : null}

        {/* Quarter-graduated radial ticks + major numerals */}
        {ticks.map((v, i) => {
          const major = i % 4 === 0;
          const half = i % 4 === 2;
          const a = dialAngle(v / max);
          const inRed = redFrom !== undefined && v >= redFrom - 1e-3;
          const r0 = major ? 76 : half ? 79.5 : 82;
          const r1 = 86;
          const [x0, y0] = polar(DC, DC, r0, a);
          const [x1, y1] = polar(DC, DC, r1, a);
          const extreme = Math.abs(a) > 125;
          const [tx, ty] = polar(DC, DC, extreme ? 65 : 62, a);
          return (
            <g key={i}>
              <line
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                stroke={inRed ? HUD_RED : "var(--color-lc-chalk)"}
                strokeOpacity={major ? (inRed ? 1 : 0.88) : half ? 0.45 : 0.22}
                strokeWidth={major ? 2 : half ? 1.25 : 0.85}
                strokeLinecap="round"
              />
              {major ? (
                <text
                  x={tx}
                  y={ty + 3.5}
                  textAnchor="middle"
                  className="lc-data"
                  fontSize={10.5}
                  fill={inRed ? HUD_RED : "var(--color-lc-fog)"}
                >
                  {tickLabel(v)}
                </text>
              ) : null}
            </g>
          );
        })}

        {/* Unit caption */}
        <text x={DC} y={DC - 24} textAnchor="middle" className="lc-hud-lbl" fontSize={9} fill="var(--color-lc-slate)">
          {unit}
        </text>

        {/* Sub-gauge in lower quadrant */}
        {children}

        {/* Tapered precision needle & machined center cap */}
        <polygon points={needlePoints(needle, 83, 14)} fill={needleColor} />
        <circle cx={DC} cy={DC} r={9.5} fill="var(--color-lc-carbon)" stroke="var(--color-lc-keyline)" strokeWidth={1.2} />
        <circle cx={DC} cy={DC} r={4.2} fill={needleColor} />
      </svg>
    </div>
  );
};

/** Circular assist warning lamp tucked at the lower edge of each outer dial */
const AssistLamp: React.FC<{ active: boolean; icon: "abs" | "tractionControl"; label: string }> = ({ active, icon, label }) => (
  <span
    title={label}
    aria-label={label}
    className={`inline-flex size-6 items-center justify-center rounded-full border transition-colors duration-200 ease-lc ${
      active
        ? "border-lc-caution bg-lc-caution text-lc-void shadow-lc-pop"
        : "border-white/10 bg-lc-void/80 text-lc-dim"
    }`}
  >
    <Icon name={icon} size="xs" className="size-3.5" />
  </span>
);

/** Curved arched rev-bar strip with live steering micro-pip over the digital speed/gear readout */
const REV_SEGMENTS = 24;

const RevArch: React.FC<{ rpm: number; revRange: [number, number]; steer: number }> = ({ rpm, revRange, steer }) => {
  const lights = revLights(rpm, revRange, REV_SEGMENTS);
  const clampedSteer = Math.max(-1, Math.min(1, steer));
  const steerX = 116 + clampedSteer * 96;
  const steerY = 5.5 + clampedSteer * clampedSteer * 6.5;

  return (
    <svg viewBox="0 0 232 28" className="h-[26px] w-[228px]" aria-hidden>
      {/* Subtle steering horizon tick + live steering dot */}
      <circle cx={116} cy={5.5} r={2} fill="var(--color-lc-chalk)" fillOpacity={0.28} />
      <circle cx={steerX} cy={steerY} r={2.4} fill="var(--color-lc-chalk)" fillOpacity={0.92} />

      {/* Arched 24-segment precision tachometer bar */}
      {Array.from({ length: REV_SEGMENTS }, (_, i) => {
        const u = (i + 0.5) / REV_SEGMENTS;
        const x = 6 + u * 220;
        const y = 22 - Math.sin(u * Math.PI) * 9.5;
        const tilt = (u - 0.5) * 24;
        const lit = lights.on(i);
        return (
          <rect
            key={i}
            x={x - 3.3}
            y={y - 3.6}
            width={6.6}
            height={7.2}
            rx={1.4}
            transform={`rotate(${tilt.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})`}
            fill={lit ? lights.color(i) : "var(--color-lc-chalk)"}
            fillOpacity={lit ? 1 : 0.12}
          />
        );
      })}
    </svg>
  );
};

/** Vertical brake / throttle bar flanking the lower channel between the twin dials */
const VerticalPedalGauge: React.FC<{
  demand: number;
  output: number;
  color: string;
  active: boolean;
  label: string;
  shortTag: string;
}> = ({ demand, output, color, active, label, shortTag }) => {
  const cut = Math.max(0, demand - output);
  const pct = Math.round(output * 100);
  return (
    <div
      className={`flex w-[26px] flex-col items-center gap-1 rounded-lc-nub px-1 pt-1 pb-1 ${HUD_GLASS}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title={label}
    >
      <div className="relative h-[46px] w-[10px] overflow-hidden rounded-sm bg-lc-well">
        <span
          className="absolute inset-x-0 bottom-0 origin-bottom"
          style={{ height: `${output * 100}%`, backgroundColor: color }}
        />
        {cut > 0.005 ? (
          <span
            className="absolute inset-x-0"
            style={{
              bottom: `${output * 100}%`,
              height: `${cut * 100}%`,
              backgroundColor: HUD_CAUTION,
            }}
          />
        ) : null}
      </div>
      <span className={`lc-hud-lbl leading-none tracking-[0.06em] ${active ? "text-lc-caution" : "text-lc-fog"}`}>
        {shortTag}
      </span>
    </div>
  );
};

/** Whether the car has shown a turbo's boost this run (a normally aspirated car reads zero throughout) */
function useHasTurbo(t: CarTelemetry): boolean {
  const run = `${t.runId ?? 0}:${t.f12026?.carId ?? ""}`;
  const [seen, setSeen] = useState({ run, turbo: false });
  const spooled = Math.abs(t.turboBoostBar) > 0.05;
  useEffect(() => {
    if (seen.run !== run) setSeen({ run, turbo: spooled });
    else if (spooled && !seen.turbo) setSeen({ run, turbo: true });
  }, [run, spooled, seen]);
  return seen.run === run && seen.turbo;
}

const Cluster: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: Words }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const [, revFull] = revRange;
  const shift = atShiftPoint(t.rpm, revFull);
  const hint = useGearHint(t, revFull);
  const startFuel = useStartFuel();
  const perLap = useFuelPerLap();
  const hasTurbo = useHasTurbo(t);
  const hasErs = t.f12026?.hasErs ?? false;
  const aero = aeroReadout(t);
  const showAero = (t.f12026?.hasDrs ?? false) && t.overtakingRules !== "none";
  const p = pedalLayers(t);

  // Speedometer scale: 6 to 9 crisp major ticks in either unit
  const cls = carClassCode(t);
  const classTop = cls === "openWheel" || cls === "proto" ? 360 : cls === "gt3" ? 320 : 280;
  const top = speedIn(Math.max(classTop, t.allTimeTopSpeedKmh * 1.04, t.speedKmh), units.speed);
  const speedStep = units.speed === "mph" ? 30 : 40;
  const speedMax = Math.ceil(top / speedStep) * speedStep;
  const speedNow = speedIn(t.speedKmh, units.speed);

  // Tachometer scale in thousands, a step past the shift point
  const rpmMax = Math.max(4, Math.ceil((revFull * 1.1) / 1000)) * 1000;
  const rpmStep = rpmMax > 10000 ? 2000 : 1000;
  const inRedline = t.rpm >= revFull * 0.96;

  const fuelFraction = startFuel > 0 ? t.fuelKg / startFuel : 0;
  const fuelLeft = fuelLapsLeft(t.fuelKg, perLap);

  return (
    <div className="flex items-end justify-center">
      {/* Left analog speedometer + ABS lamp (hidden below xl so 1024px stays unobstructed) */}
      <div className="relative mr-[-4px] hidden xl:block">
        <AnalogDial
          value={speedNow}
          max={speedMax}
          step={speedStep}
          tickLabel={(v) => String(Math.round(v))}
          sweepColor="var(--color-lc-chalk)"
          needleColor="var(--color-lc-chalk)"
          unit={speedUnit(units)}
          label={w.speedometer}
        >
          {t.fuelKg > 0 ? (
            <SubGauge
              fraction={fuelFraction}
              color={fuelFraction < 0.12 ? HUD_LOSS : "var(--color-lc-chalk)"}
              label={w.fuel}
              value={fuelLeft !== null ? w.fuelLaps(fuelLeft.toFixed(1)) : `${t.fuelKg.toFixed(1)} kg`}
            />
          ) : null}
        </AnalogDial>
        <div className="absolute right-1.5 bottom-0">
          <AssistLamp active={p.absActive} icon="abs" label={w.abs} />
        </div>
      </div>

      {/* Centre column: raised digital speed/gear core over vertical brake & throttle bars */}
      <div className="z-10 flex w-[252px] flex-col items-center">
        <div data-hud-avoid className={`flex w-full flex-col items-center rounded-lc-tile px-3 pt-1.5 pb-2 ${HUD_GLASS}`}>
          <RevArch rpm={t.rpm} revRange={revRange} steer={p.steer} />

          {/* Split digital speed | divider | Volt gear tile + suggested corner gear */}
          <div className="mt-1 flex w-full items-center">
            <div className="flex w-[104px] flex-col items-end pr-3">
              <span className="lc-data text-[40px] leading-[0.88] tracking-[-0.03em] text-lc-chalk">
                {formatSpeed(t.speedKmh, units)}
              </span>
              <span className={`${HUD_LBL} mt-1`}>{speedUnit(units)}</span>
            </div>

            <span aria-hidden className="h-[48px] w-px shrink-0 bg-white/18" />

            <div className="flex flex-1 items-center justify-center gap-2 pl-3">
              <span
                className={`flex size-[52px] shrink-0 items-center justify-center rounded-lc-row text-lc-void transition-colors duration-75 ${
                  shift ? "bg-lc-cyan" : "bg-lc-volt"
                }`}
              >
                <span className="lc-disp text-[38px] leading-none">{gearLabel(t.gear)}</span>
              </span>

              {/* Suggested corner gear slot (fixed footprint so layout never jumps) */}
              {hint !== null ? (
                <span
                  role="img"
                  aria-label={w.suggestedGear(gearLabel(hint))}
                  title={w.suggestedGear(gearLabel(hint))}
                  className="flex h-[40px] w-[34px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-lc-nub bg-lc-loss text-lc-void shadow-lc-pop"
                >
                  <Icon name="shiftDown" size="xs" className="size-3" />
                  <span className="lc-disp text-[19px] leading-none">{gearLabel(hint)}</span>
                </span>
              ) : (
                <span
                  aria-hidden
                  className="flex h-[40px] w-[34px] shrink-0 items-center justify-center rounded-lc-nub border border-white/8 bg-lc-well/75"
                >
                  <Icon name="shiftDown" size="xs" className="size-3.5 text-lc-dim opacity-35" />
                </span>
              )}
            </div>
          </div>

          {/* Sleek bottom status row inside digital unit */}
          <div className="mt-1.5 flex h-[22px] w-full items-center justify-center gap-2 border-t border-white/8 pt-1.5">
            {showAero ? <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} /> : null}
            {hasErs ? (
              <Badge tone={t.mgukPowerKw > 5 ? "info" : t.mgukPowerKw < -5 ? "good" : "neutral"} size="hud" icon="ers">
                {Math.round(t.ersBatteryPercent)}%
              </Badge>
            ) : !showAero ? (
              <span className="lc-data text-[11px] leading-none text-lc-fog">
                {Math.round(t.rpm)} <span className="text-lc-slate">{w.rpm}</span>
              </span>
            ) : null}
          </div>
        </div>

        {/* Lower channel between the dials: vertical brake & throttle bars with open road between them */}
        <div className="flex h-[68px] w-full items-end justify-between px-4 pt-1.5">
          <VerticalPedalGauge
            demand={p.brake}
            output={p.brakeOut}
            color={HUD_BRAKE}
            active={p.absActive}
            label={w.brake}
            shortTag="BRK"
          />
          <VerticalPedalGauge
            demand={p.throttle}
            output={p.throttleOut}
            color={HUD_THROTTLE}
            active={p.tcActive}
            label={w.throttle}
            shortTag="THR"
          />
        </div>
      </div>

      {/* Right analog tachometer + TC lamp (hidden below xl) */}
      <div className="relative ml-[-4px] hidden xl:block">
        <AnalogDial
          value={t.rpm}
          max={rpmMax}
          step={rpmStep}
          tickLabel={(v) => String(Math.round(v / 1000))}
          redFrom={revFull}
          sweepColor={shift ? HUD_SHIFT : inRedline ? HUD_RED : "var(--color-lc-chalk)"}
          needleColor={shift ? HUD_SHIFT : inRedline ? HUD_RED : "var(--color-lc-chalk)"}
          unit={w.rpmUnit}
          label={w.tachometer}
        >
          {hasErs ? (
            <SubGauge
              fraction={t.ersBatteryPercent / 100}
              color={t.ersBatteryPercent < 15 ? HUD_LOSS : HUD_INFO}
              label={w.battery}
              value={`${Math.round(t.ersBatteryPercent)}%`}
            />
          ) : hasTurbo ? (
            <SubGauge
              fraction={(t.turboBoostBar + 1) / 3.5}
              color={HUD_INFO}
              label={w.boost}
              value={`${t.turboBoostBar >= 0 ? "+" : "\u2212"}${Math.abs(t.turboBoostBar).toFixed(2)} b`}
            />
          ) : (
            <g>
              <rect
                x={DC - 33}
                y={153}
                width={66}
                height={17}
                rx={4}
                fill="var(--color-lc-well)"
                stroke="var(--color-lc-line)"
                strokeWidth={1}
              />
              <text x={DC} y={165} textAnchor="middle" className="lc-data" fontSize={9.5} fill="var(--color-lc-fog)">
                {Math.round(t.rpm)}
              </text>
            </g>
          )}
        </AnalogDial>
        <div className="absolute bottom-0 left-1.5">
          <AssistLamp active={p.tcActive} icon="tractionControl" label={w.tc} />
        </div>
      </div>
    </div>
  );
};

/** The car ahead (or, when leading, behind) and the gap, tucked cleanly above the cluster */
const NeighbourTag: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const near = t.race && t.race.phase === "racing" ? raceNeighbours(t) : null;
  const car = near?.ahead ?? near?.behind ?? null;
  if (!near || !car) return null;
  const ahead = car === near.ahead;
  return (
    <div className={`inline-flex h-6 items-center gap-1.5 rounded-lc-nub px-2.5 ${HUD_GLASS}`} title={ahead ? w.toAhead : w.toBehind}>
      <Trend direction={ahead ? "up" : "down"} size={8} label={ahead ? w.ahead : w.behind} />
      <span aria-hidden className="h-3 w-[3px] rounded-full" style={{ backgroundColor: car.color }} />
      <span className="lc-data text-[11px] tracking-[0.08em] text-lc-chalk">{car.code}</span>
      <span className="lc-data text-[11px] text-lc-fog">
        {ahead ? "\u2212" : "+"}
        {formatGap(car.gap, true)}
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom right: car identity plate                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

const CarCard: React.FC<{ t: CarTelemetry; carId: CarId; w: Words }> = ({ t, carId, w }) => {
  const car = anyCarById(carId) ?? carById(carId);
  return (
    <section aria-label={w.car} className={`flex max-w-[244px] flex-col gap-1 rounded-lc-tile px-3 py-2 ${HUD_GLASS}`}>
      <span className="flex items-center gap-2">
        <ClassTag carClass={carClassCode(t)} variant="solid" size="hud" />
        <span className="truncate text-[11px] font-medium text-lc-slate">{car.sub}</span>
      </span>
      <span className="lc-disp truncate text-[16px] leading-tight text-lc-chalk">{car.title}</span>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const GtLikeHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  map,
  compound = "soft",
  revRange,
  scale,
  mfd,
  ffb,
  lapInvalid,
  mapMode,
  leftExtra,
  rightExtra,
  showDeltaBar,
  topInset,
  carId,
}) => {
  const w = useGtWords();
  const event = useTimingEvent(t);
  const finalCall = useFinalLapCall(t);
  const lights = t.race?.phase === "lights";
  const brake = brakeNow(t);

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: framed position/lap plate and windowed running order */}
      <div className="absolute flex w-[232px] flex-col gap-2" style={{ top: EDGE, left: EDGE, ...anchor(scale, "top left") }}>
        <PositionPlate t={t} w={w} lapInvalid={lapInvalid} />
        <RunningOrder t={t} w={w} />
        {leftExtra}
      </div>

      {/* Top centre: three-block segmented lap timer (under virtual mirror when active) */}
      {!lights ? (
        <div
          className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1"
          style={{ top: topInset ?? 16, ...anchor(scale, "top center") }}
        >
          {finalCall ? (
            <Badge tone="bad" variant="solid" size="md" icon="chequered">
              {w.finalLap}
            </Badge>
          ) : null}
          <LapTimer t={t} deltaS={deltaS} lapInvalid={lapInvalid} showDelta={showDeltaBar !== false} event={event} w={w} />
        </div>
      ) : null}

      {/* Top right: circuit map and chalk-badged lap history */}
      <div className="absolute hidden w-[228px] flex-col gap-2 md:flex" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
        <section aria-label={w.circuit} className={`rounded-lc-tile px-3 py-2.5 ${HUD_GLASS}`}>
          <MiniMap map={map} t={t} local={mapMode === "local"} className={`block w-full ${mapMode === "local" ? "h-[168px]" : "h-[132px]"}`} stroke={20} />
        </section>
        <LapList t={t} w={w} />
        {rightExtra}
      </div>

      {/* Mid-screen: crisp braking-point cue */}
      {brake && !lights ? (
        <div className="absolute top-[46%] left-1/2 -translate-x-1/2 -translate-y-1/2" style={anchor(scale, "center")}>
          <div className="inline-flex h-9 items-center gap-2 rounded-lc-nub bg-lc-loss px-4 text-lc-void shadow-lc-pop">
            <Icon name="brake" size="sm" />
            <span className="lc-disp text-[18px] leading-none tracking-[0.1em]">{w.brake}</span>
          </div>
        </div>
      ) : null}

      {/* Bottom left: chassis + vertical tyre gauges and session clock */}
      <div className="absolute flex flex-col items-start gap-2" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
        {ffb}
        <div className="hidden sm:block">
          <TyreCard t={t} compound={compound as TireCompound} w={w} />
        </div>
        <SessionClock t={t} w={w} />
      </div>

      {/* Bottom centre: neighbour tag over the sculpted twin-dial cockpit cluster */}
      <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5" style={{ bottom: EDGE, ...anchor(scale, "bottom center") }}>
        <NeighbourTag t={t} w={w} />
        <Cluster t={t} revRange={revRange} w={w} />
      </div>

      {/* Bottom right: MFD over car identity plate */}
      <div className="absolute hidden flex-col items-end gap-2 lg:flex" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
        {mfd}
        {carId ? (
          <div className="hidden xl:block">
            <CarCard t={t} carId={carId} w={w} />
          </div>
        ) : null}
      </div>
    </div>
  );
};
