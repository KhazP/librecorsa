"use client";

/*
 * irDashies layout: a recreation of the look and layout of irDashies by tariknz
 * (https://github.com/tariknz/irdashies), MIT licence, Copyright (c) 2024 Tarik Alani. See THIRD_PARTY_NOTICES.md.
 *
 * Its overlays are redrawn here for LibreCorsa's own telemetry; no code, font, icon or image of the project ships.
 * Kept: the slate panels and bars, the standings table (class-colour bar and number box, the player's row in amber,
 * lapped / lapping cars in blue / red, last and best laps in the best colours), the lap timer (running lap, predicted
 * lap with its delta, session best and last lap, lap history), the frameless track map with the field on it, the
 * shift-light pill with its RPM box, and the input widget (trace, clutch / brake / throttle bars with their numbers,
 * gear and speed, a turning steering wheel).
 * Mapped: the car-number box shows the driver's three-letter code; the header's session time is the time on track;
 * the footer's weather becomes the fuel and the laps it lasts (the weather has its own panel); the car-systems widget
 * becomes small cells for TC / ABS, the battery and the flaps, or the fuel.
 * Dropped: ratings, licence classes, incidents, strength of field, flags, car-maker logos, tyre-compound icons, oil
 * and water temperatures (not simulated), Lato (the game's own Geist instead).
 */

import React, { useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStandingEntry } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  aidsActive,
  formatDelta,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  HUD_BEST,
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_GAIN,
  HUD_INFO,
  HUD_LOSS,
  HUD_THROTTLE,
  lapMark,
  LAP_MARK_COLOR,
  NO_TIME,
  sectorDone,
  speedUnit,
} from "../hud-format";
import { InputTrace } from "../InputTrace";
import { pedalLayers } from "../PedalBars";
import { aeroReadout } from "../aero-label";
import { type WeatherHudState } from "../WeatherBadge";
import {
  dayClock,
  evaluateRadar,
  formatClock,
  fuelLapsLeft,
  HEADLIGHT_WORD,
  headlightState,
  leaderboardWindow,
  predictedLapMs,
  RADAR_CAR_L,
  RADAR_CAR_W,
  RADAR_VIEW_RANGE_M,
  radarSideArcPath,
  sessionBestLapMs,
  SURFACE_WORD,
  trackSurfaceState,
} from "../third-party-data";
import { anchor, deltaColor, formatOnce, gearLabel, InvalidTag, MiniMap, type HudDesignProps } from "./hud-style-parts";
import { revLights, useFuelPerLap, useLapHistory, useSessionClock } from "./third-party-parts";
import palette from "./irdashies.module.css";

/** A short window (a landscape tablet or a small laptop window): the standings and the lap history show fewer rows */
const SHORT_QUERY = "(max-height: 600px)";
function subscribeShort(onChange: () => void) {
  const mq = window.matchMedia(SHORT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function useShortScreen(): boolean {
  return useSyncExternalStore(subscribeShort, () => window.matchMedia(SHORT_QUERY).matches, () => false);
}

/** The irDashies layout's words in the current language, resolved once per language */
function useIrDashiesWords() {
  const tx = useTranslations("hudStyles.irDashies");
  return useMemo(
    () => ({
      standings: tx("standings"),
      race: tx("race"),
      out: tx("out"),
      finished: tx("finished"),
      lapTimer: tx("lapTimer"),
      sessionBest: tx("sessionBest"),
      lastLap: tx("lastLap"),
      historyLap: formatOnce((lap: number) => tx("historyLap", { lap: String(lap) })),
      shiftLights: formatOnce((lit: number, total: number) => tx("shiftLights", { lit: String(lit), total: String(total) })),
      aidOff: tx("aidOff"),
      fuel: tx("fuel"),
      inputs: tx("inputs"),
      weather: tx("weather"),
      trackConditions: tx("trackConditions"),
      air: tx("air"),
      trackTemp: tx("trackTemp"),
      lights: tx("lights"),
      liveDelta: tx("liveDelta"),
      radar: tx("radar"),
    }),
    [tx],
  );
}

/** The session bar over and under the standings (slate-900) */
const BAR = "flex h-7 items-center justify-between gap-3 rounded-sm bg-(--tp-bar) px-2.5 text-[12px] tabular-nums text-(--tp-text-soft)";
/** A value cell inside a panel */
const CELL = "rounded-sm bg-(--tp-cell)";

/* ---------------------------------------------------------------- Standings (race) */

/** A row's lap colour: purple the session's best, green the driver's own best */
function lapColor(ms: number | null | undefined, ownBest: number | null | undefined, sessionBest: number | null): string | undefined {
  if (!ms) return undefined;
  if (sessionBest !== null && ms <= sessionBest) return HUD_BEST;
  if (ownBest && ms <= ownBest) return HUD_GAIN;
  return undefined;
}

const StandingsRow: React.FC<{
  e: RaceStandingEntry;
  pos: number;
  me: RaceStandingEntry | undefined;
  lengthM: number;
  gaps: "interval" | "leader";
  sessionBest: number | null;
  /** The row's words for a retired and a finished car */
  out: string;
  finished: string;
}> = ({ e, pos, me, lengthM, gaps, sessionBest, out, finished }) => {
  // A car a lap or more down on the player reads blue, a lap or more up red (the player's own row is amber)
  const lapsUp =
    !e.isPlayer && me && e.raceDistM !== undefined && me.raceDistM !== undefined && lengthM > 0
      ? (e.raceDistM - me.raceDistM) / lengthM
      : 0;
  const tone = e.isPlayer ? "text-(--tp-player)" : lapsUp <= -1 ? "text-(--tp-lapped)" : lapsUp >= 1 ? "text-(--tp-lapping)" : "";
  const gap = gaps === "leader" ? (pos === 1 ? null : e.gapToLeaderS) : (e.intervalS ?? null);
  return (
    <div
      className={`grid h-6.5 grid-cols-[24px_4px_44px_minmax(52px,1fr)_68px] lg:grid-cols-[24px_4px_44px_minmax(52px,1fr)_68px_68px] items-center gap-x-1.5 text-[13px] tabular-nums ${
        e.isPlayer ? "bg-(--tp-player-bg)" : "odd:bg-(--tp-row-a) even:bg-(--tp-row-b)"
      } ${e.retired ? "opacity-50" : ""} ${tone}`}
    >
      <span
        className={`flex h-full items-center justify-center font-semibold ${e.isPlayer ? "bg-(--tp-player) text-(--tp-bar)" : ""}`}
      >
        {pos}
      </span>
      {/* The class bar and number box, in the car's team colour */}
      <span className="h-full" style={{ backgroundColor: e.teamColorHex }} />
      <span
        className="flex h-full items-center justify-center text-[12px] font-bold text-(--tp-text)"
        style={{ backgroundColor: `color-mix(in srgb, ${e.teamColorHex} 45%, transparent)` }}
      >
        {e.driverCode}
      </span>
      <span className="truncate text-right">
        {e.retired ? out : e.finished ? <Icon name="chequered" size="xs" label={finished} className="inline size-3.5" /> : gap === null ? "-" : formatGap(gap)}
      </span>
      <span className="hidden text-right lg:inline" style={{ color: lapColor(e.lastLapMs, e.bestLapMs, sessionBest) }}>
        {formatLapTime(e.lastLapMs)}
      </span>
      <span className="pr-1.5 text-right" style={{ color: e.bestLapMs && sessionBest !== null && e.bestLapMs <= sessionBest ? HUD_BEST : undefined }}>
        {formatLapTime(e.bestLapMs)}
      </span>
    </div>
  );
};

const Standings: React.FC<{ t: CarTelemetry; lengthM: number; gaps: "interval" | "leader"; weather?: WeatherHudState | null }> = ({
  t,
  lengthM,
  gaps,
  weather,
}) => {
  const race = t.race!;
  const units = useUnits();
  const short = useShortScreen();
  const clock = useSessionClock();
  const perLap = useFuelPerLap();
  const lapsLeft = fuelLapsLeft(t.fuelKg, perLap);
  const sessionBest = sessionBestLapMs(t);
  const me = race.standings.find((e) => e.isPlayer);
  const rows = leaderboardWindow(race.standings, short ? 6 : 10);
  const surface = weather ? SURFACE_WORD[trackSurfaceState(weather.waterMm)] : null;
  const w = useIrDashiesWords();
  return (
    <section aria-label={w.standings} className="w-[244px] lg:w-[330px] rounded-md bg-(--tp-panel) p-1.5 text-(--tp-text)">
      <div className={BAR}>
        <span className="font-semibold text-(--tp-text)">{w.race}</span>
        <span>{formatClock(clock)}</span>
        <span>
          L{race.lap}
          {race.totalLaps ? ` / ${race.totalLaps}` : ""}
        </span>
        <span>
          {race.position} / {race.standings.length}
        </span>
      </div>
      <div className="mt-1.5 flex flex-col overflow-hidden rounded-sm">
        {rows.map((e) => (
          <StandingsRow
            key={e.driverCode + (e.name ?? "")}
            e={e}
            pos={race.standings.indexOf(e) + 1}
            me={me}
            lengthM={lengthM}
            gaps={gaps}
            sessionBest={sessionBest}
            out={w.out}
            finished={w.finished}
          />
        ))}
      </div>
      {weather || t.fuelKg > 0 ? (
        <div className={`${BAR} mt-1.5`}>
          {weather ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
              <Icon
                name={weather.rain > 0.5 ? "weatherStorm" : weather.rain > 0.05 ? "weatherRain" : "weatherClear"}
                size="xs"
                className="size-3.5 shrink-0 text-(--tp-text-dim)"
              />
              <span>
                {formatTemp(weather.airC, units)}/{formatTemp(weather.trackC, units)}
              </span>
              {surface ? <span className="text-(--tp-text-dim)">{surface}</span> : null}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="fuel" size="xs" className="size-3.5 text-(--tp-text-dim)" />
              {t.fuelKg.toFixed(1)} kg
            </span>
          )}
          {t.fuelKg > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1">
              {weather ? `${t.fuelKg.toFixed(1)}kg · ` : ""}
              {lapsLeft !== null ? `${lapsLeft.toFixed(1)}L` : "--"}
            </span>
          ) : weather?.timeMoving ? (
            <span className="shrink-0">{dayClock(weather.clockH)}</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

/* ---------------------------------------------------------------- Lap timer (practice) */

const LapCell: React.FC<{ label: string; ms: number | null; color?: string }> = ({ label, ms, color }) => (
  <div className="flex flex-1 flex-col items-center gap-0.5 py-1.5">
    <span className="text-[10px] font-semibold tracking-[0.06em] text-(--tp-text-soft) uppercase">{label}</span>
    <span className="text-[15px] tabular-nums" style={{ color }}>
      {formatLapTime(ms)}
    </span>
  </div>
);

const LapTimer: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean }> = ({ t, deltaS, lapInvalid }) => {
  const laps = useLapHistory(8);
  const short = useShortScreen();
  const best = t.bestLapTimeMs;
  const predicted = predictedLapMs(best, deltaS);
  const lastMark = t.lastLapTimeMs ? lapMark(t.lastLapTimeMs, best) : null;
  const w = useIrDashiesWords();
  return (
    <section aria-label={w.lapTimer} className="w-[244px] lg:w-[300px] rounded-md bg-(--tp-panel) p-2 text-(--tp-text)">
      <div className="flex flex-col gap-0.5">
        {/* The running lap */}
        <div className="relative flex min-h-13 items-center justify-center rounded-sm bg-(--tp-bar)">
          <Icon name="time" size="md" className="absolute left-2.5 text-(--tp-text-soft)" />
          <span className="text-[28px] tabular-nums" style={{ color: lapInvalid ? HUD_LOSS : undefined }}>
            {formatLapClock(t)}
          </span>
          {lapInvalid ? <InvalidTag className="absolute right-2" /> : null}
        </div>
        {/* The lap this one is on course for, and the live delta to the best */}
        <div className={`relative flex min-h-10 items-center justify-center ${CELL}`}>
          <Icon name="racingLine" size="sm" className="absolute left-3 text-(--tp-text-soft)" />
          <span className="text-[18px] tabular-nums">{formatLapTime(predicted)}</span>
          <span className="absolute right-2.5 text-[13px] tabular-nums" style={{ color: deltaColor(deltaS) }}>
            {deltaS === null ? NO_TIME : formatDeltaFit(deltaS)}
          </span>
        </div>
        {/* Sectors of the running lap */}
        <div className="grid grid-cols-3 gap-0.5">
          {[0, 1, 2].map((i) => {
            // This lap's timed sectors only (none on the out-lap from the grid, which starts in sector 3)
            const done = sectorDone(t, i);
            const ms = t.sectorTimesMs[i];
            const mark = done ? lapMark(ms, t.bestSectorTimesMs[i]) : null;
            return (
              <div
                key={i}
                className={`flex h-6.5 items-center justify-between px-2 text-[12px] tabular-nums ${CELL} ${
                  i + 1 === t.currentSector ? "text-(--tp-text)" : "text-(--tp-text-dim)"
                }`}
              >
                <span className="text-[10px] font-semibold">S{i + 1}</span>
                <span style={{ color: mark ? LAP_MARK_COLOR[mark] : undefined }}>{done ? formatSectorTime(ms) : NO_TIME}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-0.5 flex gap-1">
          <LapCell label={w.sessionBest} ms={best} color={best ? HUD_BEST : undefined} />
          <LapCell label={w.lastLap} ms={t.lastLapTimeMs} color={lastMark ? LAP_MARK_COLOR[lastMark] : undefined} />
        </div>
        {/* Lap history, newest first: the gap to the best lap and the time */}
        {laps.slice(0, short ? 2 : 5).map((l) => {
          const d = best ? (l.ms - best) / 1000 : null;
          const isBest = best !== null && l.ms <= best;
          return (
            <div
              key={`${l.lap}-${l.ms}`}
              className={`grid h-8 grid-cols-[1fr_1fr_1fr] items-center px-2.5 text-[14px] tabular-nums ${CELL} ${l.valid ? "" : "text-(--tp-text-dim) line-through"}`}
            >
              <span className="font-semibold">{w.historyLap(l.lap)}</span>
              <span className="text-center" style={{ color: !l.valid || isBest || d === null ? undefined : d > 0 ? HUD_LOSS : HUD_GAIN }}>
                {isBest || d === null ? "---" : formatDelta(d).replace(/(\.\d\d)\d$/, "$1")}
              </span>
              <span className="text-right" style={{ color: l.valid && isBest ? HUD_BEST : undefined }}>
                {formatLapTime(l.ms)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
};

/* ---------------------------------------------------------------- Shift lights and inputs */

const LEDS = 10;

const ShiftLights: React.FC<{ t: CarTelemetry; revRange: [number, number] }> = ({ t, revRange }) => {
  const rev = revLights(t.rpm, revRange, LEDS);
  const w = useIrDashiesWords();
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex gap-1.5 rounded-full bg-(--tp-panel) px-2.5 py-1.5"
        role="img"
        aria-label={w.shiftLights(rev.atShift ? LEDS : rev.lit, LEDS)}
      >
        {Array.from({ length: LEDS }, (_, i) => {
          const on = rev.on(i);
          return (
            <span
              key={i}
              className="size-4.5 rounded-full border border-(--tp-led-rim)"
              style={on ? { backgroundColor: rev.color(i), boxShadow: `0 0 8px ${rev.color(i)}` } : { backgroundColor: "var(--tp-led-off)" }}
            />
          );
        })}
      </div>
      <div className="flex h-8 min-w-[104px] items-center justify-center gap-1 rounded-lg bg-(--tp-panel) px-3 lc-data text-[18px] text-(--tp-text)">
        {Math.round(t.rpm).toLocaleString("en-US")}
        <span className="text-[11px] text-(--tp-text-dim)">RPM</span>
      </div>
    </div>
  );
};

/** One pedal: its number on top, the bar filling from the bottom (the brake turns caution while ABS works) */
const PedalBar: React.FC<{ value: number; color: string }> = ({ value, color }) => (
  <div className="flex w-4 flex-col items-center gap-0.5">
    <span className={`text-[10px] tabular-nums ${value > 0.005 ? "text-(--tp-text)" : "text-(--tp-text-dim)"}`}>{Math.round(value * 100)}</span>
    <span className="relative h-14 w-full overflow-hidden bg-(--tp-cell)">
      <span className="absolute inset-x-0 bottom-0 h-full origin-bottom" style={{ transform: `scaleY(${value})`, backgroundColor: color }} />
    </span>
  </div>
);

/** The steering wheel, turned with the car's steering (a rim, three spokes and the top marker) */
const SteeringWheel: React.FC<{ steering: number }> = ({ steering }) => (
  <svg viewBox="-26 -26 52 52" className="size-14 shrink-0" aria-hidden>
    <g transform={`rotate(${(Math.max(-1, Math.min(1, steering)) * 270).toFixed(1)})`}>
      <circle r={21} fill="none" stroke="var(--tp-text)" strokeWidth={4.5} />
      <path d="M-19 2 L-7 4 M19 2 L7 4 M0 8 L0 19" stroke="var(--tp-text)" strokeWidth={4.5} strokeLinecap="round" />
      <circle r={7.5} fill="none" stroke="var(--tp-text)" strokeWidth={3.5} />
      <rect x={-2.2} y={-25} width={4.4} height={6.5} rx={1} fill="var(--tp-marker)" />
    </g>
  </svg>
);

/** A small value cell beside the inputs: TC, ABS, battery, flaps, fuel, delta */
const Chip: React.FC<{ label: React.ReactNode; value?: React.ReactNode; color?: string; active?: boolean; wide?: boolean }> = ({ label, value, color, active, wide }) => (
  <span className={`flex h-5.5 items-center gap-1.5 px-1.5 text-[11px] tabular-nums ${wide ? "col-span-2" : ""} ${value === undefined ? "justify-center" : "justify-between"} ${CELL}`}>
    <span className={`font-semibold ${active ? "" : "text-(--tp-text-dim)"}`} style={active ? { color: HUD_CAUTION } : undefined}>
      {label}
    </span>
    {value !== undefined ? (
      <span className="whitespace-nowrap text-(--tp-text)" style={color ? { color } : undefined}>
        {value}
      </span>
    ) : null}
  </span>
);

const Inputs: React.FC<{ t: CarTelemetry; deltaS: number | null; trace: boolean }> = ({ t, deltaS, trace }) => {
  const units = useUnits();
  const p = pedalLayers(t);
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  const hasErs = t.f12026?.hasErs ?? t.liveTuner?.hasErs ?? false;
  const aero = aeroReadout(t);
  const flaps = aero.open || t.f12026?.hasDrs === true;
  const w = useIrDashiesWords();
  const chips: React.ReactNode[] = [];
  if (t.race) {
    chips.push(
      <Chip key="d" label="Δ" value={deltaS === null ? NO_TIME : formatDeltaFit(deltaS)} color={deltaColor(deltaS)} />,
    );
  }
  if (tuner) {
    chips.push(<Chip key="tc" label="TC" value={tuner.tcLevel > 0 ? tuner.tcLevel : w.aidOff} active={aids.tc} />);
    chips.push(<Chip key="abs" label="ABS" value={tuner.absLevel > 0 ? tuner.absLevel : w.aidOff} active={aids.abs} />);
  }
  if (hasErs) chips.push(<Chip key="ers" label="ERS" value={`${Math.round(t.ersBatteryPercent)}%`} color={t.mgukPowerKw > 0 ? HUD_INFO : undefined} />);
  // The flaps as the car's era names them (DRS ARMED, X-MODE), across both columns
  if (flaps) {
    chips.push(
      <Chip key="aero" wide label={<span style={{ color: aero.open || aero.armed ? HUD_INFO : "var(--tp-text-soft)" }}>{aero.label}</span>} />,
    );
  }
  if (!hasErs && t.fuelKg > 0) chips.push(<Chip key="fuel" wide label={w.fuel} value={`${t.fuelKg.toFixed(1)} kg`} />);

  return (
    <section aria-label={w.inputs} className="flex items-end gap-3 rounded-md bg-(--tp-panel) p-2 text-(--tp-text)">
      {/* The shared trace, flattened into this panel; the steering pad's tablet layout leaves it out */}
      {trace ? (
        <div className={`${palette.trace} compact:hidden`}>
          <InputTrace
            sample={{
              throttle: t.throttle,
              brake: t.brake,
              steering: t.steering,
              steerInput: t.steerInput,
              throttleOut: p.throttleOut,
              brakeOut: p.brakeOut,
              ffbClip: p.ffbClip,
            }}
            steerLockDeg={t.steerLockDeg}
            width={200}
            aside={<></>}
            frameless
          />
        </div>
      ) : null}
      <div className="flex items-end gap-1">
        <PedalBar value={p.clutch} color="var(--tp-clutch)" />
        <PedalBar value={p.brake} color={p.absActive ? HUD_CAUTION : HUD_BRAKE} />
        <PedalBar value={p.throttle} color={HUD_THROTTLE} />
      </div>
      <div className="flex w-14 flex-col items-center self-center">
        <span className="lc-data text-[36px] leading-none">{gearLabel(t.gear)}</span>
        <span className="mt-1 text-[18px] leading-none font-semibold tabular-nums">{formatSpeed(t.speedKmh, units)}</span>
        <span className="text-[10px] text-(--tp-text-dim)">{speedUnit(units)}</span>
      </div>
      <SteeringWheel steering={t.steering} />
      {chips.length ? <div className="hidden w-[150px] grid-cols-2 gap-1 self-center sm:grid">{chips}</div> : null}
    </section>
  );
};

/* ---------------------------------------------------------------- The layout */

/* ---------------------------------------------------------------- Native Weather, Delta Bar & Radar */

const IrDashiesWeatherPanel: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const units = useUnits();
  const surface = SURFACE_WORD[trackSurfaceState(weather.waterMm)];
  const rainIcon = weather.rain > 0.5 ? "weatherStorm" : weather.rain > 0.05 ? "weatherRain" : "weatherClear";
  const lights = headlightState(weather);
  const w = useIrDashiesWords();
  return (
    <section aria-label={w.weather} className="rounded-md bg-(--tp-panel) p-1.5 text-(--tp-text)">
      <div className={BAR}>
        <span className="inline-flex items-center gap-1.5 font-semibold text-(--tp-text)">
          <Icon name={rainIcon} size="xs" className="size-3.5 text-(--tp-text-soft)" />
          {surface}
        </span>
        <span>{weather.timeMoving ? dayClock(weather.clockH) : w.trackConditions}</span>
      </div>
      <div className={`mt-1 grid ${lights ? "grid-cols-3" : "grid-cols-2"} gap-1 text-center`}>
        <div className={`flex flex-col py-1 ${CELL}`}>
          <span className="text-[9px] font-semibold text-(--tp-text-dim) uppercase">{w.air}</span>
          <span className="text-[13px] font-semibold tabular-nums">{formatTemp(weather.airC, units)}</span>
        </div>
        <div className={`flex flex-col py-1 ${CELL}`}>
          <span className="text-[9px] font-semibold text-(--tp-text-dim) uppercase">{w.trackTemp}</span>
          <span className="text-[13px] font-semibold tabular-nums">{formatTemp(weather.trackC, units)}</span>
        </div>
        {lights ? (
          <div className={`flex flex-col py-1 ${CELL}`}>
            <span className="text-[9px] font-semibold text-(--tp-text-dim) uppercase">{w.lights}</span>
            <span
              className="text-[13px] font-semibold"
              style={{ color: lights === "flash" ? HUD_INFO : lights === "off" ? "var(--tp-text-dim)" : undefined }}
            >
              {HEADLIGHT_WORD[lights]}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

const IrDashiesDeltaBar: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean }> = ({ t, deltaS, lapInvalid }) => {
  const predicted = predictedLapMs(t.bestLapTimeMs, deltaS);
  const has = deltaS !== null && Number.isFinite(deltaS);
  const gain = has && deltaS <= 0;
  const frac = has ? Math.min(1, Math.abs(deltaS)) * 50 : 0;
  const w = useIrDashiesWords();
  return (
    <section
      aria-label={w.liveDelta}
      className="flex w-[228px] flex-col gap-1.5 rounded-md bg-(--tp-panel) px-2.5 py-1.5 text-(--tp-text)"
    >
      <div className="flex items-baseline justify-between gap-2 text-[13px] leading-none tabular-nums">
        <span className="font-semibold" style={{ color: lapInvalid ? HUD_LOSS : deltaColor(deltaS) }}>
          {has ? formatDeltaFit(deltaS) : NO_TIME}
        </span>
        {lapInvalid ? (
          <InvalidTag />
        ) : (
          <span className="text-[12px] text-(--tp-text-soft)">{formatLapTime(predicted ?? t.bestLapTimeMs)}</span>
        )}
      </div>
      <div className="relative h-2 overflow-hidden rounded-sm bg-(--tp-bar)" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/30" />
        {has ? (
          <span
            className="absolute inset-y-0"
            style={{
              left: gain ? `${50 - frac}%` : "50%",
              width: `${frac}%`,
              backgroundColor: gain ? HUD_GAIN : HUD_LOSS,
            }}
          />
        ) : null}
      </div>
    </section>
  );
};

const IrDashiesRadar: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const w = useIrDashiesWords();
  const { blips, leftCar, rightCar, opacity } = evaluateRadar(t.radar ?? []);
  if (opacity <= 0.01) return null;
  const range = RADAR_VIEW_RANGE_M;
  return (
    <div
      className="pointer-events-none absolute top-[53%] left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ease-out"
      style={{ width: 148, height: 148, opacity }}
    >
      <svg
        viewBox={`${-range} ${-range} ${range * 2} ${range * 2}`}
        className="size-full overflow-hidden rounded-full border border-white/10 bg-(--tp-panel) shadow-lg"
        role="img"
        aria-label={w.radar}
      >
        <circle r={8} fill="none" stroke="var(--tp-text-dim)" strokeOpacity={0.28} strokeWidth={0.3} />
        <circle r={16} fill="none" stroke="var(--tp-text-dim)" strokeOpacity={0.18} strokeWidth={0.3} />
        <line x1={0} y1={-range} x2={0} y2={range} stroke="var(--tp-text-dim)" strokeOpacity={0.14} strokeWidth={0.25} />
        <line x1={-range} y1={0} x2={range} y2={0} stroke="var(--tp-text-dim)" strokeOpacity={0.14} strokeWidth={0.25} />
        {leftCar ? (
          <path
            d={radarSideArcPath(-1, leftCar)}
            fill="none"
            stroke={leftCar.overlapLevel === 2 ? HUD_LOSS : HUD_CAUTION}
            strokeOpacity={Math.max(0.6, leftCar.opacity)}
            strokeWidth={leftCar.overlapLevel === 2 ? 2.1 : 1.5}
            strokeLinecap="round"
          />
        ) : null}
        {rightCar ? (
          <path
            d={radarSideArcPath(1, rightCar)}
            fill="none"
            stroke={rightCar.overlapLevel === 2 ? HUD_LOSS : HUD_CAUTION}
            strokeOpacity={Math.max(0.6, rightCar.opacity)}
            strokeWidth={rightCar.overlapLevel === 2 ? 2.1 : 1.5}
            strokeLinecap="round"
          />
        ) : null}
        {blips.map(({ blip: b, opacity: carOp, overlapLevel }, i) => (
          <rect
            key={i}
            x={-RADAR_CAR_W / 2}
            y={-RADAR_CAR_L / 2}
            width={RADAR_CAR_W}
            height={RADAR_CAR_L}
            rx={0.5}
            fill={overlapLevel === 2 ? HUD_LOSS : overlapLevel === 1 ? HUD_CAUTION : b.color}
            fillOpacity={Math.max(0.3, carOp)}
            stroke="var(--tp-bar)"
            strokeWidth={0.3}
            transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
          />
        ))}
        <rect
          x={-RADAR_CAR_W / 2}
          y={-RADAR_CAR_L / 2}
          width={RADAR_CAR_W}
          height={RADAR_CAR_L}
          rx={0.5}
          fill="var(--tp-player)"
          stroke="var(--tp-bar)"
          strokeWidth={0.35}
        />
      </svg>
    </div>
  );
};

/**
 * irDashies: standings (race) or the lap timer (practice) top-left, the frameless track map top-right, and the
 * shift-light pill over the input widget at the bottom centre
 */
export const IrDashiesHud: React.FC<HudDesignProps> = ({
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
  mapMode,
  leftExtra,
  rightExtra,
  weather,
  showDeltaBar,
  showRadar,
}) => (
  <div className={`pointer-events-none absolute inset-0 select-none ${palette.palette}`}>
    {/* With the touch controls up (a tablet), the standings start under their pause and camera buttons */}
    <div
      className="absolute top-[clamp(14px,2.2vw,24px)] left-[clamp(14px,2.2vw,24px)] flex flex-col items-start gap-2"
      style={{ ...(touch ? { top: 68 } : null), ...anchor(scale, "top left") }}
    >
      {t.race ? <Standings t={t} lengthM={map.lengthM} gaps={towerGaps} weather={weather} /> : <LapTimer t={t} deltaS={deltaS} lapInvalid={lapInvalid} />}
      {leftExtra ? <div className="w-[244px] lg:w-[300px]">{leftExtra}</div> : null}
    </div>

    {showDeltaBar ? (
      <div
        className="absolute left-1/2 hidden -translate-x-1/2 md:block"
        style={{ top: topInset ?? "clamp(14px,2.2vw,24px)", ...anchor(scale, "top center") }}
      >
        <IrDashiesDeltaBar t={t} deltaS={deltaS} lapInvalid={lapInvalid} />
      </div>
    ) : null}

    <div className="absolute top-[clamp(14px,2.2vw,24px)] right-[clamp(14px,2.2vw,24px)] hidden w-[210px] md:block" style={anchor(scale, "top right")}>
      <MiniMap map={map} t={t} local={mapMode === "local"} className="block h-[150px] w-full drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]" stroke={20} />
      {!t.race && weather ? (
        <div className="mt-2">
          <IrDashiesWeatherPanel weather={weather} />
        </div>
      ) : null}
      {rightExtra ? <div className="mt-2">{rightExtra}</div> : null}
    </div>

    {showRadar ? <IrDashiesRadar t={t} /> : null}

    {mfd ? (
      <div className="absolute right-[clamp(14px,2.2vw,24px)] bottom-[clamp(14px,2.2vw,24px)] hidden lg:block" style={anchor(scale, "bottom right")}>
        {mfd}
      </div>
    ) : null}

    {/* Bottom centre; on a tablet with the touch controls, lifted over the steering pad and the pedals, and narrower */}
    <div
      data-hud-avoid
      className="absolute bottom-[clamp(14px,2.2vw,24px)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2"
      style={{ ...(touch ? { bottom: 170 } : null), ...anchor(scale, "bottom center") }}
    >
      <ShiftLights t={t} revRange={revRange} />
      <Inputs t={t} deltaS={deltaS} trace={!touch} />
    </div>
  </div>
);
