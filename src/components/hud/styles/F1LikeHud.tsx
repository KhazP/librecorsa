"use client";

import { getActivePointToPoint } from "@/lib/track-data";
import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStandingEntry, TireCompound } from "@/types/f1";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { PenaltyBadge } from "@/components/ui/badges/PenaltyBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  HUD_BEST,
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_GAIN,
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
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { pedalLayers } from "../PedalBars";
import { driverLabel, fuelLapsLeft, sessionBestLapMs } from "../third-party-data";
import { revLights, useFuelPerLap, useStartFuel } from "./third-party-parts";
import { AeroBadge, anchor, formatOnce, gearLabel, HUD_GLASS, HUD_LBL, InvalidTag, MiniMap, raceNeighbours, type HudDesignProps } from "./hud-style-parts";
import { TopDownCar, arcPath, carClassCode, fastestLap, onFinalLap, polar, useErsState, useGearHint, type ErsState } from "./game-style-parts";

/**
 * F1-Like: the race screen laid out the way a Formula game lays it out, in LibreCorsa's visual language.
 * Top-left five-row relative running order with top accent rule and race-state strip; top-right three-sector timing
 * card with position, lap clock, best/last rows and full-bleed delta bar (top centre left open for race control);
 * bottom-left sector-coloured circuit map; bottom-centre unified sculpted twin-ring + gear-bridge dial with battery
 * flow, rev pips, Volt gear, energy-store state, Overtake/Aero dock and speed/RPM/pedal ring; bottom-right precision
 * top-down car damage diagram flanked by four radial tyre-life rings.
 */

const EDGE = "clamp(14px,2.2vw,24px)";
/** Rows in the running order: the player and two either side */
const TOWER_ROWS = 5;

type Words = ReturnType<typeof useF1Words>;

function useF1Words() {
  const tx = useTranslations("hudStyles.f1Like");
  const txCluster = useTranslations("hud.speedCluster");
  return useMemo(
    () => ({
      boost: txCluster("boost"),
      lowGrip: txCluster("lowGrip"),
      overtakeAuto: txCluster("overtakeAuto"),
      runningOrder: tx("runningOrder"),
      lapOf: formatOnce((lap: number, total: number) => tx("lapOf", { lap, total })),
      lap: formatOnce((lap: number) => tx("lap", { lap })),
      sessionLap: formatOnce((session: string, kind: string, lap: number) => tx("sessionLap", { session, kind, lap })),
      outLap: tx("outLap"),
      finalLap: tx("finalLap"),
      chequered: tx("chequered"),
      vsc: tx("vsc"),
      vscEnding: tx("vscEnding"),
      yellow: tx("yellow"),
      gapToYou: tx("gapToYou"),
      fastestLap: tx("fastestLap"),
      out: tx("out"),
      timing: tx("timing"),
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position, total })),
      best: tx("best"),
      last: tx("last"),
      delta: tx("delta"),
      sector: formatOnce((sector: number) => tx("sector", { sector })),
      brake: tx("brake"),
      throttle: tx("throttle"),
      circuit: tx("circuit"),
      dial: tx("dial"),
      battery: tx("battery"),
      fuel: tx("fuel"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      rpm: tx("rpm"),
      overtake: tx("overtake"),
      overtakeReady: tx("overtakeReady"),
      overtakeOn: tx("overtakeOn"),
      overtakeLocked: tx("overtakeLocked"),
      ers: {
        boost: txCluster("boost"),
        overtake: tx("ers.overtake"),
        deploy: tx("ers.deploy"),
        clipped: tx("ers.clipped"),
        superclip: tx("ers.superclip"),
        braking: tx("ers.braking"),
        liftCoast: tx("ers.liftCoast"),
        trickle: tx("ers.trickle"),
        neutral: tx("ers.neutral"),
      } satisfies Record<ErsState, string>,
      shiftUp: tx("shiftUp"),
      suggestedGear: formatOnce((gear: string) => tx("suggestedGear", { gear })),
      tc: tx("tc"),
      abs: tx("abs"),
      carStatus: tx("carStatus"),
      tyre: formatOnce((corner: string, tread: number, temp: number) => tx("tyre", { corner, tread, temp })),
      corners: [tx("cornerFL"), tx("cornerFR"), tx("cornerRL"), tx("cornerRR")] as const,
      damage: formatOnce((pct: number) => tx("damage", { pct })),
      noDamage: tx("noDamage"),
    }),
    [tx, txCluster],
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: running order tower with top accent rule and flush relative rows                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Five rows with the player in the middle, clamped inside the field */
function windowRows<T extends { isPlayer: boolean }>(standings: readonly T[]): { e: T; pos: number }[] {
  const me = Math.max(0, standings.findIndex((e) => e.isPlayer));
  const start = Math.max(0, Math.min(me - Math.floor(TOWER_ROWS / 2), standings.length - TOWER_ROWS));
  return standings.slice(start, start + TOWER_ROWS).map((e, i) => ({ e, pos: start + i + 1 }));
}

/**
 * Each car's gap to the player (− ahead of you, + behind): the split gap for immediate neighbours where available,
 * otherwise the difference of gaps to the leader.
 */
function gapToPlayer(t: CarTelemetry, e: RaceStandingEntry, me: RaceStandingEntry): number {
  const near = raceNeighbours(t);
  if (near?.ahead && near.ahead.code === e.driverCode) return -near.ahead.gap;
  if (near?.behind && near.behind.code === e.driverCode) return near.behind.gap;
  return e.gapToLeaderS - me.gapToLeaderS;
}

/** Flush race-state strip directly beneath the lap header */
const RaceState: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const race = t.race;
  if (!race) return null;
  if (race.phase === "finished") {
    return (
      <div className="flex h-8 items-center gap-2 bg-lc-chalk px-3 text-lc-void">
        <Icon name="chequered" size="xs" className="size-4" />
        <span className="lc-disp text-[13px] tracking-[0.06em]">{w.chequered}</span>
      </div>
    );
  }
  if (race.vsc) {
    return (
      <div className="flex h-8 items-center gap-2 bg-lc-caution px-3 text-lc-void">
        <Icon name="warning" size="xs" className="size-4" />
        <span className="lc-disp flex-1 text-[13px] tracking-[0.04em]">{race.vsc.phase === "ending" ? w.vscEnding : w.vsc}</span>
        <span className="lc-data text-[12px]">{formatDeltaFit(race.vsc.deltaS, 1)}</span>
      </div>
    );
  }
  if (race.yellow) {
    return (
      <div className="flex h-8 items-center gap-2 bg-lc-caution px-3 text-lc-void">
        <Icon name="warning" size="xs" className="size-4" />
        <span className="lc-disp text-[13px] tracking-[0.06em]">{w.yellow}</span>
      </div>
    );
  }
  if (onFinalLap(t)) {
    return (
      <div className="flex h-7 items-center gap-2 border-y border-white/12 bg-white/8 px-3 text-lc-chalk">
        <Icon name="chequered" size="xs" className="size-3.5" />
        <span className="lc-disp text-[12px] tracking-[0.08em]">{w.finalLap}</span>
      </div>
    );
  }
  return null;
};

const Tower: React.FC<{ t: CarTelemetry; w: Words; lapInvalid: boolean }> = ({ t, w, lapInvalid }) => {
  const race = t.race;
  if (!race) {
    const kind = getActivePointToPoint() ? "run" : "lap";
    return (
      <section aria-label={w.timing} className={`flex h-10 items-center gap-2.5 overflow-hidden rounded-lc-tile px-3.5 ${HUD_GLASS}`}>
        <span className="lc-disp truncate text-[16px] leading-none text-lc-chalk">
          {t.outLap ? w.outLap : w.sessionLap(sessionWord(t), kind, Math.max(1, t.lapCount))}
        </span>
        {lapInvalid ? <InvalidTag /> : null}
      </section>
    );
  }

  const me = race.standings.find((e) => e.isPlayer);
  const fastest = fastestLap(t);
  const progress = race.totalLaps ? Math.min(1, Math.max(0, (race.lap - 1 + t.trackProgress) / race.totalLaps)) : null;
  const caution = Boolean(race.vsc || race.yellow);

  return (
    <section aria-label={w.runningOrder} className={`overflow-hidden rounded-lc-tile ${HUD_GLASS}`}>
      {/* Top broadcast accent rule */}
      <div aria-hidden className={`h-[2.5px] w-full ${caution ? "bg-lc-caution" : "bg-lc-chalk/75"}`} />

      {/* Centred lap header + race progress hairline */}
      <div className="relative flex h-9.5 items-center justify-center px-3">
        <span className="lc-disp text-[17px] leading-none tracking-[0.04em] text-lc-chalk">
          {race.totalLaps ? w.lapOf(race.lap, race.totalLaps) : w.lap(race.lap)}
        </span>
        {progress !== null ? (
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-white/8">
            <span className="block h-full bg-lc-chalk/65" style={{ width: `${progress * 100}%` }} />
          </span>
        ) : null}
      </div>

      <RaceState t={t} w={w} />

      {/* Five flush rows centred on the player */}
      {race.phase !== "lights" && me ? (
        <div className="flex flex-col divide-y divide-white/[0.06]">
          {windowRows(race.standings).map(({ e, pos }) => {
            const gap = e.isPlayer ? null : gapToPlayer(t, e, me);
            const holdsFastest = fastest?.entry.driverCode === e.driverCode;
            const rowClass = e.isPlayer
              ? "bg-lc-volt text-lc-void"
              : holdsFastest
                ? "bg-lc-best/18 text-lc-chalk"
                : "text-lc-chalk";
            return (
              <div
                key={e.driverCode}
                className={`flex h-[30px] items-center gap-2 pr-2.5 pl-2 ${rowClass} ${e.retired ? "opacity-45" : ""}`}
              >
                <span className={`lc-data w-5 text-right text-[12px] ${e.isPlayer ? "text-lc-void" : "text-lc-fog"}`}>{pos}</span>
                <span
                  aria-hidden
                  className="h-4 w-[3px] shrink-0 rounded-full"
                  style={{ backgroundColor: e.isPlayer ? "var(--color-lc-void)" : e.teamColorHex }}
                />
                <span className="lc-disp min-w-0 flex-1 truncate text-[13px] tracking-[0.04em]">{driverLabel(e)}</span>
                {holdsFastest ? (
                  <span title={w.fastestLap} className={`inline-flex shrink-0 ${e.isPlayer ? "text-lc-void" : "text-lc-best-ink"}`}>
                    <Icon name="time" size="xs" className="size-3.5" />
                  </span>
                ) : null}
                {e.penaltyS ? <PenaltyBadge penalty={{ kind: "time", seconds: e.penaltyS }} size="hud" /> : null}
                {e.compound ? <CompoundGlyph compound={e.compound} size={15} /> : null}
                <span
                  className={`lc-data w-[56px] text-right text-[12px] ${e.isPlayer ? "text-lc-void/45" : ""}`}
                  title={gap === null ? undefined : w.gapToYou}
                >
                  {e.retired ? (
                    w.out
                  ) : e.finished ? (
                    <Icon name="chequered" size="xs" className="ml-auto size-3.5" />
                  ) : gap === null ? (
                    "-.---"
                  ) : (
                    `${gap < 0 ? "\u2212" : "+"}${formatGap(gap, true)}`
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: three-sector header, position/clock, and full-bleed timing rows                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const TimingCard: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean; showDelta: boolean; w: Words }> = ({
  t,
  deltaS,
  lapInvalid,
  showDelta,
  w,
}) => {
  const race = t.race;
  const sessionBest = sessionBestLapMs(t);
  const myBestIsSession = t.bestLapTimeMs !== null && sessionBest !== null && t.bestLapTimeMs <= sessionBest + 0.5;

  return (
    <section aria-label={w.timing} className={`overflow-hidden rounded-lc-tile ${HUD_GLASS}`}>
      {/* Three-column S1 | S2 | S3 sector header bar */}
      <div className="grid grid-cols-3 divide-x divide-white/8 border-b border-white/8 bg-lc-well/55">
        {[0, 1, 2].map((i) => {
          const done = sectorDone(t, i);
          const mark = done ? lapMark(t.sectorTimesMs[i], t.bestSectorTimesMs[i], !race) : null;
          const active = i + 1 === t.currentSector;
          const barColor = mark ? LAP_MARK_COLOR[mark] : active ? "var(--color-lc-chalk)" : "var(--color-lc-line)";
          return (
            <div key={i} className="flex flex-col items-center">
              <span className={`${HUD_LBL} py-1 leading-none ${active || done ? "text-lc-chalk" : "text-lc-slate"}`}>
                {w.sector(i + 1)}
              </span>
              <span aria-hidden className="h-[3px] w-full" style={{ backgroundColor: barColor }} />
            </div>
          );
        })}
      </div>

      {/* Position + running lap clock */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        {race ? (
          <span className="flex items-baseline gap-0.5" aria-label={w.positionOf(race.position, race.fieldSize)}>
            <span className="lc-disp text-[32px] leading-none text-lc-chalk">{race.position}</span>
            <span className="lc-data text-[13px] text-lc-slate">/{race.fieldSize}</span>
          </span>
        ) : lapInvalid ? (
          <InvalidTag />
        ) : (
          <span className={HUD_LBL}>{w.timing}</span>
        )}
        <span className={`lc-data text-[24px] leading-none tracking-[-0.01em] ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>
          {formatLapClock(t)}
        </span>
      </div>

      {/* Invalid-lap banner in race mode (keeps position + clock uncrowded) */}
      {race && lapInvalid ? (
        <div className="flex h-6 items-center justify-end bg-lc-loss/18 px-3">
          <InvalidTag />
        </div>
      ) : null}

      {/* Horizontal accent divider under clock */}
      <div aria-hidden className={`h-[2px] w-full ${lapInvalid ? "bg-lc-loss" : "bg-white/14"}`} />

      {/* Timing rows: BEST, LAST (practice), and full-bleed DELTA bar */}
      <div className="flex flex-col divide-y divide-white/[0.06]">
        <div className="flex h-8 items-center justify-between px-3">
          <span className={HUD_LBL}>{w.best}</span>
          <span
            className="lc-data inline-flex items-center gap-1.5 text-[14px] text-lc-chalk"
            style={t.bestLapTimeMs && myBestIsSession ? { color: HUD_BEST } : undefined}
          >
            {t.bestLapTimeMs && myBestIsSession ? <Icon name="time" size="xs" className="size-3.5" /> : null}
            {formatLapTime(t.bestLapTimeMs)}
          </span>
        </div>

        {!race ? (
          <div className="flex h-8 items-center justify-between px-3">
            <span className={HUD_LBL}>{w.last}</span>
            <span className="lc-data text-[14px] text-lc-chalk" style={t.lastLapValid === false ? { color: HUD_LOSS } : undefined}>
              {formatLapTime(t.lastLapTimeMs)}
            </span>
          </div>
        ) : null}

        {showDelta && deltaS !== null ? (
          <div
            className={`flex h-9 items-center justify-between px-3 text-lc-void ${deltaS <= 0 ? "bg-lc-gain" : "bg-lc-loss"}`}
          >
            <span className={`${HUD_LBL} inline-flex items-center gap-1.5 text-lc-void/80`}>
              <Icon name="time" size="xs" className="size-3.5" />
              {w.delta}
            </span>
            <span className="lc-data inline-flex items-center gap-1 text-[16px] leading-none tracking-[-0.01em]">
              <Trend direction={deltaS <= 0 ? "up" : "down"} size={9} />
              {formatDeltaFit(deltaS)}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom centre: unified sculpted twin-ring + gear-bridge cockpit dial                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const DIAL_W = 386;
const DIAL_H = 128;
const LCX = 60;
const RCX = 326;
const CY = 64;
const RING_FROM = -140;
const RING_TO = 140;
const ringAngle = (f: number) => RING_FROM + (RING_TO - RING_FROM) * Math.min(1, Math.max(0, f));

/** Single unified sculpted backing silhouette: left pod + raised rev-LED bridge + right pod */
const UNIFIED_DIAL_PATH =
  "M 91.94 18 Q 108 5 124 5 L 262 5 Q 278 5 294.06 18 A 56 56 0 1 1 294.06 110 Q 278 123 262 123 L 124 123 Q 108 123 91.94 110 A 56 56 0 1 1 91.94 18 Z";

const PIPS = 15;
const RPM_TICKS = 9;
const BATT_NOTCHES = [0.25, 0.5, 0.75] as const;

/** Boost / Overtake power pill in the centre bridge's bottom dock */
const PowerButton: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const hasErs = t.f12026?.hasErs ?? false;
  if (!hasErs) return null;
  const ersCtl = ersButtons(t);
  if (t.ersBoostActive !== undefined) {
    const ot = ersCtl.overtake;
    const overtakeOn = ot === "on" || ot === "auto";
    // Show active Boost in any session (including races with Overtake locked/available and Low Grip) when Overtake itself isn't active
    if (ersCtl.boostOn && !overtakeOn) {
      return (
        <Badge tone="info" variant="solid" size="hud" icon="overtake" title={ersCtl.lowGrip ? w.lowGrip : w.boost}>
          {w.boost}
        </Badge>
      );
    }
    // In a race (or Low Grip), show Overtake status (keep badge text short for the 154 px centre bridge; detail goes in title)
    if (ot !== null) {
      const locked = ot === "locked" || ot === "lowGrip";
      const title = ot === "lowGrip" ? w.lowGrip : ot === "auto" ? w.overtakeAuto : overtakeOn ? w.overtakeOn : locked ? w.overtakeLocked : w.overtakeReady;
      return (
        <Badge tone={locked ? "neutral" : "info"} variant={overtakeOn ? "solid" : locked ? "soft" : "outline"} size="hud" icon="overtake" title={title}>
          {w.overtake}
        </Badge>
      );
    }
    return (
      <Badge tone="info" variant="outline" size="hud" icon="overtake" title={w.boost}>
        {w.boost}
      </Badge>
    );
  }
  const locked = ersCtl.boostLocked;
  const on = ersCtl.boostOn;
  const label = on ? w.overtakeOn : locked ? w.overtakeLocked : w.overtake;
  return (
    <Badge tone={locked ? "neutral" : "info"} variant={on ? "solid" : locked ? "soft" : "outline"} size="hud" icon="overtake" title={label}>
      {w.overtake}
    </Badge>
  );
};

/** Semantic text colour for the 2026 ERS operating state */
function ersTextClass(state: ErsState): string {
  if (state === "boost" || state === "overtake" || state === "deploy") return "text-lc-info";
  if (state === "braking" || state === "liftCoast" || state === "superclip" || state === "trickle") return "text-lc-gain";
  if (state === "clipped") return "text-lc-caution";
  return "text-lc-slate";
}

const UnifiedDial: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: Words }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const [, revFull] = revRange;
  const shift = atShiftPoint(t.rpm, revFull);
  const lights = revLights(t.rpm, revRange, PIPS);
  const hint = useGearHint(t, revFull);
  const ers = useErsState(t);
  const hasErs = t.f12026?.hasErs ?? false;
  const aero = aeroReadout(t);
  const showAero = (t.f12026?.hasDrs ?? false) && t.overtakingRules !== "none";
  const aids = aidsActive(t);
  const startFuel = useStartFuel();
  const perLap = useFuelPerLap();
  const pedals = pedalLayers(t);

  // Left pod readings: Battery SOC + MGU-K power flow, or Fuel fraction on non-ERS cars
  const soc = Math.min(1, Math.max(0, t.ersBatteryPercent / 100));
  const flow = Math.max(-1, Math.min(1, t.mgukPowerKw / 350));
  const battColor = soc < 0.1 ? HUD_LOSS : soc < 0.2 ? HUD_CAUTION : HUD_INFO;
  const fuelFrac = startFuel > 0 ? Math.min(1, Math.max(0, t.fuelKg / startFuel)) : 0;
  const fuelLeft = fuelLapsLeft(t.fuelKg, perLap);

  // Right pod readings: RPM sweep
  const rpmFrac = Math.min(1, Math.max(0, t.rpm / Math.max(1, revFull)));
  const rpmBand = shift
    ? HUD_SHIFT
    : rpmFrac >= 0.92
      ? HUD_RED
      : rpmFrac >= 0.82
        ? HUD_CAUTION
        : "var(--color-lc-chalk)";

  return (
    <div
      role="group"
      aria-label={w.dial}
      data-hud-avoid
      className="relative h-[128px] w-[386px] drop-shadow-xl"
    >
      {/* Unified sculpted housing + precision circular gauges */}
      <svg viewBox={`0 0 ${DIAL_W} ${DIAL_H}`} className="absolute inset-0 size-full" aria-hidden>
        {/* Sculpted dark-glass chassis */}
        <path
          d={UNIFIED_DIAL_PATH}
          fill="var(--color-lc-void)"
          fillOpacity={0.86}
          stroke="var(--color-lc-chalk)"
          strokeOpacity={0.14}
          strokeWidth={1.1}
          strokeLinejoin="round"
        />

        {/* Subtle circular machined pod bezels */}
        <circle cx={LCX} cy={CY} r={53} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.07} strokeWidth={1} />
        <circle cx={RCX} cy={CY} r={53} fill="none" stroke="var(--color-lc-chalk)" strokeOpacity={0.07} strokeWidth={1} />

        {/* ---- LEFT POD: Battery SOC + MGU-K flow (or Fuel on GT3) ---- */}
        <path
          d={arcPath(LCX, CY, 46, RING_FROM, RING_TO)}
          fill="none"
          stroke="var(--color-lc-chalk)"
          strokeOpacity={0.1}
          strokeWidth={7}
          strokeLinecap="round"
        />
        {hasErs ? (
          <>
            {soc > 0.005 ? (
              <path
                d={arcPath(LCX, CY, 46, RING_FROM, ringAngle(soc))}
                fill="none"
                stroke={battColor}
                strokeWidth={7}
                strokeLinecap="round"
              />
            ) : null}
            {/* Quarter-charge calibration ticks */}
            {BATT_NOTCHES.map((n) => {
              const a = ringAngle(n);
              const [x0, y0] = polar(LCX, CY, 42.2, a);
              const [x1, y1] = polar(LCX, CY, 49.8, a);
              return <line key={n} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--color-lc-void)" strokeWidth={1.6} />;
            })}
            {/* Inner MGU-K deploy / harvest power-flow arc */}
            <path
              d={arcPath(LCX, CY, 37, RING_FROM, RING_TO)}
              fill="none"
              stroke="var(--color-lc-chalk)"
              strokeOpacity={0.08}
              strokeWidth={2.5}
              strokeLinecap="round"
            />
            {Math.abs(flow) > 0.02 ? (
              <path
                d={flow > 0 ? arcPath(LCX, CY, 37, 0, flow * 140) : arcPath(LCX, CY, 37, flow * 140, 0)}
                fill="none"
                stroke={flow > 0 ? HUD_INFO : HUD_GAIN}
                strokeWidth={2.8}
                strokeLinecap="round"
              />
            ) : null}
          </>
        ) : (
          <>
            {fuelFrac > 0.005 ? (
              <path
                d={arcPath(LCX, CY, 46, RING_FROM, ringAngle(fuelFrac))}
                fill="none"
                stroke={fuelFrac < 0.12 ? HUD_LOSS : "var(--color-lc-chalk)"}
                strokeWidth={7}
                strokeLinecap="round"
              />
            ) : null}
            {BATT_NOTCHES.map((n) => {
              const a = ringAngle(n);
              const [x0, y0] = polar(LCX, CY, 42.2, a);
              const [x1, y1] = polar(LCX, CY, 49.8, a);
              return <line key={n} x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--color-lc-void)" strokeWidth={1.6} />;
            })}
          </>
        )}

        {/* ---- RIGHT POD: RPM ring + calibration ticks + lower brake/throttle micro-bars ---- */}
        <path
          d={arcPath(RCX, CY, 46, RING_FROM, RING_TO)}
          fill="none"
          stroke="var(--color-lc-chalk)"
          strokeOpacity={0.1}
          strokeWidth={6.5}
          strokeLinecap="round"
        />
        {rpmFrac > 0.005 ? (
          <path
            d={arcPath(RCX, CY, 46, RING_FROM, ringAngle(rpmFrac))}
            fill="none"
            stroke={rpmBand}
            strokeWidth={6.5}
            strokeLinecap="round"
          />
        ) : null}
        {/* Subtle inner RPM ticks */}
        {Array.from({ length: RPM_TICKS }, (_, i) => {
          const a = ringAngle(i / (RPM_TICKS - 1));
          const [x0, y0] = polar(RCX, CY, 38.5, a);
          const [x1, y1] = polar(RCX, CY, 41.2, a);
          return (
            <line
              key={i}
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
              stroke="var(--color-lc-chalk)"
              strokeOpacity={i >= RPM_TICKS - 2 ? 0.5 : 0.22}
              strokeWidth={1.1}
              strokeLinecap="round"
            />
          );
        })}

        {/* Mirrored Brake (left) and Throttle (right) micro-bars tucked at 6 o'clock of right ring */}
        <rect x={302} y={106} width={22} height={4} rx={2} fill="var(--color-lc-chalk)" fillOpacity={0.1} />
        {pedals.brakeOut > 0.01 ? (
          <rect
            x={324 - 22 * pedals.brakeOut}
            y={106}
            width={22 * pedals.brakeOut}
            height={4}
            rx={2}
            fill={HUD_BRAKE}
          />
        ) : null}
        <rect x={328} y={106} width={22} height={4} rx={2} fill="var(--color-lc-chalk)" fillOpacity={0.1} />
        {pedals.throttleOut > 0.01 ? (
          <rect x={328} y={106} width={22 * pedals.throttleOut} height={4} rx={2} fill={HUD_THROTTLE} />
        ) : null}
      </svg>

      {/* ---- LEFT POD TEXT OVERLAY ---- */}
      <div className="absolute top-[16px] left-[12px] flex size-[96px] flex-col items-center justify-center">
        {hasErs ? (
          <>
            <span className={HUD_LBL}>{w.battery}</span>
            <span className="lc-data mt-0.5 text-[24px] leading-none tracking-[-0.02em] text-lc-chalk">
              {Math.round(t.ersBatteryPercent)}%
            </span>
          </>
        ) : (
          <>
            <span className={HUD_LBL}>{w.fuel}</span>
            <span className="lc-data mt-0.5 text-[21px] leading-none tracking-[-0.02em] text-lc-chalk">{t.fuelKg.toFixed(1)}</span>
            <span className={`${HUD_LBL} mt-1`}>{fuelLeft !== null ? w.fuelLaps(fuelLeft.toFixed(1)) : "kg"}</span>
          </>
        )}
      </div>

      {/* 6 o'clock ERS / Fuel status orb on left pod */}
      <div
        className={`absolute top-[100px] left-[50px] flex size-5 items-center justify-center rounded-full border bg-lc-well ${
          hasErs
            ? flow > 0.02
              ? "border-lc-info/70 text-lc-info"
              : flow < -0.02
                ? "border-lc-gain/70 text-lc-gain"
                : "border-white/14 text-lc-dim"
            : fuelFrac < 0.12
              ? "border-lc-loss/80 text-lc-loss"
              : "border-white/14 text-lc-slate"
        }`}
      >
        <Icon name={hasErs ? "ers" : "fuel"} size="xs" className="size-3" />
      </div>

      {/* ---- CENTRE BRIDGE: Rev pips, Gear tile, ERS state + flow bar, Overtake / Aero dock ---- */}
      <div className="absolute inset-y-[6px] left-[116px] flex w-[154px] flex-col items-center justify-between py-1.5">
        {/* 15 precision rev-LED pips */}
        <div className="flex items-center gap-[3.5px] rounded-full border border-white/6 bg-lc-well/80 px-2 py-1" aria-hidden>
          {Array.from({ length: PIPS }, (_, i) => (
            <span
              key={i}
              className="size-[5px] rounded-full"
              style={{
                backgroundColor: lights.on(i) ? lights.color(i) : "var(--color-lc-chalk)",
                opacity: lights.on(i) ? 1 : 0.14,
              }}
            />
          ))}
        </div>

        {/* Gear hero with corner-hint & shift-up flanks */}
        <div className="flex items-center justify-center gap-2">
          <span className="flex w-7 justify-end">
            {hint !== null ? (
              <span title={w.suggestedGear(gearLabel(hint))} className="flex flex-col items-center text-lc-loss">
                <Icon name="shiftDown" size="xs" className="size-3" />
                <span className="lc-disp text-[15px] leading-none">{gearLabel(hint)}</span>
              </span>
            ) : null}
          </span>
          <span
            className={`flex size-[44px] shrink-0 items-center justify-center rounded-lc-row text-lc-void transition-colors duration-75 ${
              shift ? "bg-lc-cyan" : "bg-lc-volt"
            }`}
          >
            <span className="lc-disp text-[34px] leading-none">{gearLabel(t.gear)}</span>
          </span>
          <span className="flex w-7 justify-start">
            {shift ? (
              <span title={w.shiftUp} className="inline-flex" style={{ color: HUD_SHIFT }}>
                <Icon name="shiftUp" size="xs" className="size-4.5" />
              </span>
            ) : null}
          </span>
        </div>

        {/* ERS operating mode + centre-zero flow bar (or TC/ABS lamps on GT3) */}
        {hasErs ? (
          <div className="flex w-[124px] flex-col items-center gap-1">
            <span className={`lc-title text-[10px] leading-none tracking-[0.08em] ${ersTextClass(ers)}`}>{w.ers[ers]}</span>
            <span aria-hidden className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/10">
              <span className="absolute inset-y-0 left-1/2 w-px bg-white/30" />
              {Math.abs(flow) > 0.02 ? (
                <span
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    left: flow > 0 ? "50%" : `${50 + flow * 50}%`,
                    width: `${Math.abs(flow) * 50}%`,
                    backgroundColor: flow > 0 ? HUD_INFO : HUD_GAIN,
                  }}
                />
              ) : null}
            </span>
          </div>
        ) : (
          <span className="flex h-4 items-center gap-3">
            <span title={w.tc} className={`inline-flex items-center gap-1 ${aids.tc ? "text-lc-caution" : "text-lc-dim"}`}>
              <Icon name="tractionControl" size="xs" className="size-3.5" />
            </span>
            <span title={w.abs} className={`inline-flex items-center gap-1 ${aids.abs ? "text-lc-caution" : "text-lc-dim"}`}>
              <Icon name="abs" size="xs" className="size-3.5" />
            </span>
          </span>
        )}

        {/* Integrated bottom Overtake / Aero dock */}
        {showAero || hasErs ? (
          <div className="flex items-center justify-center gap-1.5">
            <PowerButton t={t} w={w} />
            {showAero ? <AeroBadge open={aero.open} armed={aero.armed} label={aero.label} /> : null}
          </div>
        ) : (
          <span className="h-4" aria-hidden />
        )}
      </div>

      {/* ---- RIGHT POD TEXT OVERLAY ---- */}
      <div className="absolute top-[15px] right-[12px] flex size-[96px] flex-col items-center justify-center">
        <span className={HUD_LBL}>{speedUnit(units)}</span>
        <span className="lc-data mt-0.5 text-[29px] leading-[0.95] tracking-[-0.03em] text-lc-chalk">
          {formatSpeed(t.speedKmh, units)}
        </span>
        <span className="lc-data mt-1 text-[10px] leading-none text-lc-fog">
          {Math.round(t.rpm)} <span className="text-lc-slate">{w.rpm}</span>
        </span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom right: CAD-style top-down car status & radial tyre-life rings                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Where each tyre's radial life ring sits round the car (FL, FR, RL, RR) in the 216 × 146 box */
const RING_AT: readonly [number, number, number][] = [
  [30, 38, 66],
  [186, 38, 150],
  [30, 108, 64],
  [186, 108, 152],
];
const TYRE_R = 22;

const CarStatus: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words }> = ({ t, compound, w }) => {
  const damage = t.race?.damage ?? t.practiceDamage;
  const overall = damage ? Math.round(damage.overall * 100) : 0;
  const openWheel = carClassCode(t) === "openWheel";
  const label = t.tireWearPct
    .map((wear, i) => w.tyre(w.corners[i], Math.round(100 - wear), Math.round(t.tireTempsC[i])))
    .join(", ");

  return (
    <section aria-label={w.carStatus} className={`flex w-[228px] flex-col gap-1 rounded-lc-tile px-2.5 pt-2 pb-2 ${HUD_GLASS}`}>
      <svg viewBox="0 0 216 146" className="w-full" role="img" aria-label={label}>
        {/* High-precision top-down car diagram */}
        <g transform="translate(108 73) scale(0.95) translate(-50 -72)">
          <TopDownCar openWheel={openWheel} damage={damage} t={t} showWheels />
        </g>

        {/* Four corner radial tyre-life rings with subtle leader ticks */}
        {RING_AT.map(([x, y, tickTo], i) => {
          const tread = Math.max(0, Math.min(100, 100 - t.tireWearPct[i]));
          const punctured = Boolean(damage?.punctured[i]);
          const ringColor = punctured || tread < 25 ? HUD_LOSS : tread < 55 ? HUD_CAUTION : "var(--color-lc-chalk)";
          const leftSide = i % 2 === 0;
          const tickStart = leftSide ? x + TYRE_R + 3 : x - TYRE_R - 3;
          return (
            <g key={i}>
              {/* Thin leader tick from ring toward axle */}
              <line
                x1={tickStart}
                y1={y}
                x2={tickTo}
                y2={y}
                stroke="var(--color-lc-chalk)"
                strokeOpacity={0.18}
                strokeWidth={1}
              />
              <circle
                cx={x}
                cy={y}
                r={TYRE_R}
                fill="var(--color-lc-void)"
                fillOpacity={0.72}
                stroke={punctured ? HUD_LOSS : "var(--color-lc-chalk)"}
                strokeOpacity={punctured ? 0.8 : 0.12}
                strokeDasharray={punctured ? "4 3" : undefined}
                strokeWidth={3.5}
              />
              {tread > 0.5 && !punctured ? (
                <path
                  d={arcPath(x, y, TYRE_R, 0, Math.min(359.9, (tread / 100) * 360))}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth={3.5}
                  strokeLinecap="round"
                />
              ) : null}
              <text
                x={x}
                y={y + 4}
                textAnchor="middle"
                className="lc-data"
                fontSize={11.5}
                fill={punctured ? HUD_LOSS : "var(--color-lc-chalk)"}
              >
                {punctured ? "0%" : `${Math.round(tread)}%`}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Clean compound + damage footer */}
      <div className="flex items-center justify-between gap-2 border-t border-white/8 pt-1.5 px-0.5">
        <CompoundGlyph compound={compound} size={18} />
        {overall > 0 ? (
          <Badge tone={overall >= 40 ? "bad" : "warn"} variant="solid" size="hud" icon="damage">
            {w.damage(overall)}
          </Badge>
        ) : (
          <span className={HUD_LBL}>{w.noDamage}</span>
        )}
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const F1LikeHud: React.FC<HudDesignProps> = ({
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
}) => {
  const w = useF1Words();
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: five-row relative running order */}
      <div className="absolute flex w-[264px] flex-col gap-2" style={{ top: EDGE, left: EDGE, ...anchor(scale, "top left") }}>
        <Tower t={t} w={w} lapInvalid={lapInvalid} />
        {leftExtra}
      </div>

      {/* Top right: three-sector timing card */}
      <div className="absolute flex w-[258px] flex-col gap-2" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
        <TimingCard t={t} deltaS={deltaS} lapInvalid={lapInvalid} showDelta={showDeltaBar !== false} w={w} />
        {rightExtra}
      </div>

      {/* Bottom left: sector-coloured circuit map */}
      <div className="absolute flex flex-col items-start gap-2" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
        {ffb}
        <section aria-label={w.circuit} className={`hidden w-[228px] rounded-lc-tile px-3 py-2 md:block ${HUD_GLASS}`}>
          <MiniMap
            map={map}
            t={t}
            sectors
            local={mapMode === "local"}
            className={`block w-full ${mapMode === "local" ? "h-[168px]" : "h-[132px]"}`}
            stroke={22}
          />
        </section>
      </div>

      {/* Bottom centre: unified sculpted twin-ring + gear-bridge dial */}
      <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: EDGE, ...anchor(scale, "bottom center") }}>
        <UnifiedDial t={t} revRange={revRange} w={w} />
      </div>

      {/* Bottom right: MFD over CAD car-status panel */}
      <div className="absolute hidden flex-col items-end gap-2 lg:flex" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
        {mfd}
        <div>
          <CarStatus t={t} compound={compound as TireCompound} w={w} />
        </div>
      </div>
    </div>
  );
};
