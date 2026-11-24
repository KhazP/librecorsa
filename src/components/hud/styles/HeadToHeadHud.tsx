"use client";

/*
 * Head to Head: a recreation of the look and layout of emilioSp's h2h dashboards
 * (https://github.com/emilioSp/h2h-iracing, MIT licence, Copyright (c) 2026 Emilio Spatola; the licence text is in
 * THIRD_PARTY_NOTICES.md), drawn from LibreCorsa's own telemetry. No source code, fonts or images are copied: the
 * cards, colours, type and grids follow the source's dashboards.
 *
 * Kept: the head-to-head stack (the car ahead, the player's band with the gap and last-lap delta to each neighbour,
 * the car behind, "Race leader" / "Last place" when there is none, and the 8 s yellow pulse of a new lap time); the car
 * telemetry cells (ABS, TC, brake bias, with the source's lit background while an aid acts); the spotter (left / right
 * overlap bars, only while a car is alongside); the fuel dashboard's level, use per lap and laps left.
 * Mapped: the pit limiter cell (no pit lane limiter here) to fuel on fuel cars and to the battery on hybrids; the
 * session-best delta in practice to the live delta against the best lap; gear, speed and rev lights added to the
 * telemetry cells in the same style, since this layout is the whole HUD.
 * Dropped: licence class and rating, the weather and traffic dashboards (weather comes from the game's own panel), the
 * fuel-to-add margins (no pit stops), the welcome pages.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStandingEntry } from "@/types/f1";
import { Icon } from "@/components/ui/icons/Icon";
import type { IconName } from "@/components/ui/icons/registry";
import { useUnits } from "@/lib/settings/ui-prefs";
import { aidsActive, formatSpeed, formatTemp, HUD_GAIN, HUD_INFO, HUD_LOSS, HUD_SHIFT, speedUnit } from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { type WeatherHudState } from "../WeatherBadge";
import {
  dayClock,
  fuelLapsLeft,
  HEADLIGHT_WORD,
  headlightState,
  referenceLapS,
  SURFACE_WORD,
  trackSurfaceState,
} from "../third-party-data";
import { anchor, formatOnce, gearLabel, type HudDesignProps } from "./hud-style-parts";
import { revLights, useFuelPerLap } from "./third-party-parts";
import palette from "./h2h.module.css";

/** The Head to Head layout's words in the current language, resolved once per language */
function useH2hWords() {
  const tx = useTranslations("hudStyles.h2h");
  return useMemo(
    () => ({
      notAvailable: tx("notAvailable"),
      best: tx("best"),
      last: tx("last"),
      gap: tx("gap"),
      deltaLap: tx("deltaLap"),
      raceLeader: tx("raceLeader"),
      lastPlace: tx("lastPlace"),
      you: tx("you"),
      lapPlace: formatOnce((lap: number) => tx("lapPlace", { lap: String(lap) })),
      runningLap: tx("runningLap"),
      runningInvalid: tx("runningInvalid"),
      delta: tx("delta"),
      brakeBias: tx("brakeBias"),
      fuel: tx("fuel"),
      aidOff: tx("aidOff"),
      gear: tx("gear"),
      car: tx("car"),
      fuelPanel: tx("fuelPanel"),
      fuelLevel: tx("fuelLevel"),
      remaining: tx("remaining"),
      perLap: tx("perLap"),
      laps: tx("laps"),
      atFlag: tx("atFlag"),
      alongside: formatOnce((side: "both" | "left" | "right") => tx("alongside", { side })),
      left: tx("left"),
      right: tx("right"),
      weather: tx("weather"),
      air: tx("air"),
      track: tx("track"),
      surface: tx("surface"),
      rain: tx("rain"),
      time: tx("time"),
      timeFixed: tx("timeFixed"),
      lights: tx("lights"),
      liveDelta: tx("liveDelta"),
      barInvalid: tx("barInvalid"),
      barDelta: tx("barDelta"),
      headToHead: tx("headToHead"),
      lapCard: tx("lapCard"),
    }),
    [tx],
  );
}
type H2hWords = ReturnType<typeof useH2hWords>;

/* ---- The source's number formats */

/** MM:SS.mmm, the source's lap time (two-digit minutes), dashes without a time */
function lapTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return "--:--.---";
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const milli = Math.floor(ms % 1000);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

/** A gap: seconds to a tenth, a lap time over a minute, whole laps when a lap or more (`none` without one) */
function gapText(gapS: number | null, lapS: number, none: string): string {
  if (gapS === null || !Number.isFinite(gapS)) return none;
  const g = Math.abs(gapS);
  if (g >= lapS) return `${Math.floor(g / lapS)}L`;
  if (g > 60) return lapTime(g * 1000);
  return `${g.toFixed(1)}s`;
}

/** A lap-time difference, signed to the hundredth ("−0.66s"): − is the player quicker (`none` without one) */
function deltaText(d: number | null, none: string): string {
  if (d === null || !Number.isFinite(d)) return none;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "";
  return `${sign}${Math.abs(d).toFixed(2)}s`;
}

/** Gaining (the player quicker), losing, or nothing to compare */
const deltaColor = (d: number | null) => (d === null || !Number.isFinite(d) ? "var(--tp-dim)" : d < 0 ? HUD_GAIN : HUD_LOSS);

/** The source shows a driver's surname: a multiplayer name's last word, else the three-letter code */
function shortName(e: Pick<RaceStandingEntry, "name" | "driverCode">): string {
  const parts = e.name?.trim().split(/\s+/) ?? [];
  return parts.length ? parts[parts.length - 1] : e.driverCode;
}

/** True for 8 s after `key` changes to a new value (the source's pulse on a new lap time); never on mount */
function usePulse(key: number | string | null | undefined, ms = 8000): boolean {
  const [on, setOn] = useState(false);
  const prev = useRef(key);
  useEffect(() => {
    if (prev.current === key) return;
    prev.current = key;
    if (key === null || key === undefined || (typeof key === "number" && key <= 0)) {
      setOn(false);
      return;
    }
    setOn(true);
    const id = window.setTimeout(() => setOn(false), ms);
    return () => window.clearTimeout(id);
  }, [key, ms]);
  return on;
}

/* ---- Head to head */

/** A dim, tracked caption under a value */
const Caption: React.FC<{ children: string }> = ({ children }) => (
  <span className="text-[9px] leading-none font-bold tracking-[0.2em] text-(--tp-dim) uppercase xl:text-[10px]">{children}</span>
);

/** A big number with its caption under it */
const Stat: React.FC<{
  value: string;
  caption: string;
  color?: string;
  pulse?: boolean;
  align?: "center" | "end";
  className?: string;
}> = ({ value, caption, color, pulse = false, align = "center", className = "" }) => (
  <div className={`grid content-center gap-1 ${align === "end" ? "justify-items-end pr-2.5 xl:pr-1" : "justify-items-center"} ${className}`}>
    <span
      className={`text-[14px] leading-none font-bold whitespace-nowrap xl:text-[20px] ${pulse ? "animate-pulse" : ""}`}
      style={{ color: pulse ? "var(--tp-yellow)" : (color ?? "var(--tp-white)") }}
    >
      {value}
    </span>
    <Caption>{caption}</Caption>
  </div>
);

/** Name and place on the left, best and last lap on the right (the source's driver grid) */
const DriverInfo: React.FC<{
  name: string;
  place: string;
  bestMs: number | null | undefined;
  lastMs: number | null | undefined;
  w: H2hWords;
}> = ({ name, place, bestMs, lastMs, w }) => {
  const bestPulse = usePulse(bestMs);
  const lastPulse = usePulse(lastMs);
  return (
    <div className={`grid h-full ${COLS} grid-rows-2`}>
      <span className="flex min-w-0 items-center pl-2.5 text-[14px] leading-none font-bold xl:pl-3.5 xl:text-[19px] text-(--tp-white)">
        <span className="truncate">{name}</span>
      </span>
      <Stat value={lapTime(bestMs)} caption={w.best} pulse={bestPulse} className="row-span-2" />
      <Stat value={lapTime(lastMs)} caption={w.last} pulse={lastPulse} className="row-span-2" />
      <span className="flex items-center pl-2.5 text-[13px] leading-none font-bold xl:pl-3.5 xl:text-[17px] text-(--tp-white)">{place}</span>
    </div>
  );
};

/** The gap to a neighbour (under the best lap) and the last-lap delta to it (under the last lap) */
const GapRow: React.FC<{ gapS: number | null; deltaS: number | null; lapS: number; w: H2hWords }> = ({ gapS, deltaS, lapS, w }) => {
  const deltaPulse = usePulse(deltaS === null ? null : String(Math.round(deltaS * 1000)));
  return (
    <div className={`grid h-full ${COLS}`}>
      <span />
      <Stat value={gapText(gapS, lapS, w.notAvailable)} caption={w.gap} color={gapS === null ? "var(--tp-dim)" : "var(--tp-yellow)"} align="end" />
      <span className={deltaPulse ? "animate-pulse" : undefined}>
        <Stat value={deltaText(deltaS, w.notAvailable)} caption={w.deltaLap} color={deltaColor(deltaS)} className="h-full" />
      </span>
    </div>
  );
};

/** "Race leader" / "Last place": the card where there is no car */
const Placeholder: React.FC<{ children: string }> = ({ children }) => (
  <div className="grid h-full place-items-center text-[12px] tracking-[0.25em] xl:text-[15px] text-(--tp-dim) uppercase">{children}</div>
);

/** Last-lap delta between the player and another car (s): − the player was quicker */
const lapDelta = (mineMs: number | null | undefined, theirsMs: number | null | undefined): number | null =>
  mineMs && theirsMs && mineMs > 1000 && theirsMs > 1000 ? (mineMs - theirsMs) / 1000 : null;

const CARD = "h-13 border-(--tp-border) bg-(--tp-card-a) xl:h-16";

/** The best and last lap columns: narrower below 1280 px, where the stack must leave the top centre clear */
const COLS = "grid-cols-[minmax(0,1fr)_5rem_5rem] xl:grid-cols-[minmax(0,1fr)_7.75rem_7.75rem]";

/** The race: the car ahead, the player's band between its gaps, the car behind */
const RaceStack: React.FC<{ t: CarTelemetry; w: H2hWords }> = ({ t, w }) => {
  const standings = t.race?.standings ?? [];
  const i = standings.findIndex((e) => e.isPlayer);
  const me = i >= 0 ? standings[i] : null;
  const ahead = i > 0 ? standings[i - 1] : null;
  const behind = i >= 0 && i < standings.length - 1 ? standings[i + 1] : null;
  const lapS = referenceLapS(t);
  // The player's own lap times are the telemetry's (the race row may lag a frame behind)
  const myLast = t.lastLapTimeMs ?? me?.lastLapMs;
  const myBest = t.bestLapTimeMs ?? me?.bestLapMs;
  // The split gap (time at the same point of the track) where the race has one for that car, as the game's split
  // panel shows it; else the difference of the gaps to the leader
  const splits = t.race?.splits;
  const gapAhead =
    me && ahead ? (splits?.ahead?.driverCode === ahead.driverCode ? splits.ahead.gapS : me.gapToLeaderS - ahead.gapToLeaderS) : null;
  const gapBehind =
    me && behind ? (splits?.behind?.driverCode === behind.driverCode ? splits.behind.gapS : behind.gapToLeaderS - me.gapToLeaderS) : null;
  const aheadKey = "a:" + (ahead ? ahead.driverCode + (ahead.name ?? "") : "");
  const behindKey = "b:" + (behind ? behind.driverCode + (behind.name ?? "") : "");
  return (
    <>
      <div className={`${CARD} border-b`}>
        {ahead ? (
          <DriverInfo key={aheadKey} name={shortName(ahead)} place={`P${i}`} bestMs={ahead.bestLapMs} lastMs={ahead.lastLapMs} w={w} />
        ) : (
          <Placeholder>{w.raceLeader}</Placeholder>
        )}
      </div>
      <div className="grid h-28 grid-rows-[1fr_2fr_1fr] xl:h-34 border-y border-(--tp-border-player) bg-(--tp-player-a) py-1">
        <GapRow key={aheadKey} gapS={gapAhead} deltaS={ahead ? lapDelta(myLast, ahead.lastLapMs) : null} lapS={lapS} w={w} />
        <DriverInfo key="me" name={me ? shortName(me) : w.you} place={`P${t.race?.position ?? i + 1}`} bestMs={myBest} lastMs={myLast} w={w} />
        <GapRow key={behindKey} gapS={gapBehind} deltaS={behind ? lapDelta(myLast, behind.lastLapMs) : null} lapS={lapS} w={w} />
      </div>
      <div className={`${CARD} border-t`}>
        {behind ? (
          <DriverInfo key={behindKey} name={shortName(behind)} place={`P${i + 2}`} bestMs={behind.bestLapMs} lastMs={behind.lastLapMs} w={w} />
        ) : (
          <Placeholder>{w.lastPlace}</Placeholder>
        )}
      </div>
    </>
  );
};

/** Practice: the player's band alone, with the running lap and the live delta to the best lap */
const PracticeBand: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean; w: H2hWords }> = ({ t, deltaS, lapInvalid, w }) => {
  // Not held at ±99.99: "+123.40s" fits the column a lap time ("--:--.---") fits
  const deltaShown = deltaS !== null && Number.isFinite(deltaS) ? deltaS : null;
  return (
    <div className="grid h-22 grid-rows-[2fr_1fr] xl:h-26 border-y border-(--tp-border-player) bg-(--tp-player-a) py-1">
      <DriverInfo name={w.you} place={w.lapPlace(Math.max(1, t.lapCount))} bestMs={t.bestLapTimeMs} lastMs={t.lastLapTimeMs} w={w} />
      <div className={`grid h-full ${COLS}`}>
        <span />
        <Stat
          value={t.outLap ? "00:00.000" : lapTime(t.currentLapTimeMs)}
          caption={lapInvalid ? w.runningInvalid : w.runningLap}
          color={lapInvalid ? HUD_LOSS : undefined}
          align="end"
        />
        <Stat value={deltaText(deltaShown, w.notAvailable)} caption={w.delta} color={deltaColor(deltaShown)} />
      </div>
    </div>
  );
};

/* ---- Car telemetry */

type CellTone = "red" | "blue" | "yellow" | "white";
const TONE_COLOR: Record<CellTone, string> = {
  red: "var(--tp-red)",
  blue: "var(--tp-blue)",
  yellow: "var(--tp-yellow)",
  white: "var(--tp-white)",
};
const TONE_ACTIVE: Partial<Record<CellTone, string>> = { red: palette.activeRed, blue: palette.activeBlue, yellow: palette.activeYellow };

interface Cell {
  key: string;
  label: string;
  icon: IconName;
  value: React.ReactNode;
  tone: CellTone;
  active?: boolean;
  blink?: boolean;
}

/** Icon and tracked label over a big value, lit while its aid acts (the source's metric cell) */
const MetricCell: React.FC<{ cell: Cell }> = ({ cell }) => {
  const color = TONE_COLOR[cell.tone];
  return (
    <div
      className={`grid min-h-0 flex-1 place-items-center content-center gap-1 border border-(--tp-border) px-2 py-1.5 ${
        cell.active ? TONE_ACTIVE[cell.tone] ?? "" : ""
      } ${cell.active && cell.blink ? "animate-pulse" : ""}`}
      style={{ color }}
    >
      <span className="flex items-center gap-1.5">
        <Icon name={cell.icon} size="xs" />
        <span className="text-[13px] leading-none font-bold tracking-[0.25em] uppercase">{cell.label}</span>
      </span>
      <span className="text-[24px] leading-none font-black whitespace-nowrap">{cell.value}</span>
    </div>
  );
};

/** A small unit after a value, as the source's fuel figures carry it */
const Unit: React.FC<{ children: string }> = ({ children }) => <span className="ml-0.5 text-[11px] font-bold text-(--tp-dim)">{children}</span>;

const REV_LIGHTS = 15;

/** The telemetry cells round the gear: ABS and brake bias left, TC and fuel (or battery) right, rev lights on top */
const CarCells: React.FC<{ t: CarTelemetry; revRange: [number, number]; fuelPerLap: number | null }> = ({ t, revRange, fuelPerLap }) => {
  const units = useUnits();
  const tuner = t.liveTuner;
  const aids = aidsActive(t);
  const hasErs = t.f12026?.hasErs ?? tuner?.hasErs ?? false;
  const ersCtl = ersButtons(t);
  const extraPower = ersCtl.boostOn || ersCtl.overtake === "on" || ersCtl.overtake === "auto";
  const aero = aeroReadout(t);
  const showAero = t.overtakingRules !== undefined && t.overtakingRules !== "none";
  const revs = revLights(t.rpm, revRange, REV_LIGHTS);
  const lapsLeft = fuelLapsLeft(t.fuelKg, fuelPerLap);
  const w = useH2hWords();

  const left: Cell[] = tuner
    ? [
        { key: "abs", label: "ABS", icon: "abs", value: tuner.absLevel > 0 ? tuner.absLevel : w.aidOff, tone: "red", active: aids.abs },
        { key: "bb", label: w.brakeBias, icon: "brake", value: `${tuner.brakeBiasPct.toFixed(1)}%`, tone: "white" },
      ]
    : [];
  const right: Cell[] = [
    ...(tuner
      ? [{ key: "tc", label: "TC", icon: "tractionControl", value: tuner.tcLevel > 0 ? tuner.tcLevel : w.aidOff, tone: "blue", active: aids.tc } satisfies Cell]
      : []),
    // The source's pit limiter cell: the battery on a hybrid, the fuel on a car that burns it (lit and pulsing under
    // two laps left, as the limiter's cell is while it is on)
    ...(hasErs
      ? [{ key: "ers", label: "ERS", icon: "ers", value: `${Math.round(t.ersBatteryPercent)}%`, tone: "yellow", active: extraPower } satisfies Cell]
      : t.fuelKg > 0
        ? [
            {
              key: "fuel",
              label: w.fuel,
              icon: "fuel",
              value: (
                <>
                  {t.fuelKg.toFixed(1)}
                  <Unit>kg</Unit>
                </>
              ),
              tone: "yellow",
              active: lapsLeft !== null && lapsLeft < 2,
              blink: true,
            } satisfies Cell,
          ]
        : []),
  ];

  return (
    <section aria-label={w.car} className="w-fit border border-(--tp-border) bg-(--tp-bg-a)">
      {/* Rev lights: green, yellow, red, then all in the shift colour at the shift point */}
      <div className="flex gap-0.75 px-2 pt-2 pb-1" aria-hidden>
        {Array.from({ length: REV_LIGHTS }, (_, i) => (
          <span key={i} className="h-1.25 flex-1" style={{ backgroundColor: revs.on(i) ? revs.color(i) : "var(--tp-border)" }} />
        ))}
      </div>
      <div className="flex h-36">
        {left.length ? (
          <div className="flex w-33 flex-col">
            {left.map((c) => (
              <MetricCell key={c.key} cell={c} />
            ))}
          </div>
        ) : null}
        {/* Gear and speed, in the cells' type */}
        <div
          className="grid w-34 place-items-center content-center gap-1 border border-(--tp-border) text-(--tp-white)"
          style={revs.atShift ? { color: HUD_SHIFT } : undefined}
        >
          <span className="text-[13px] leading-none font-bold tracking-[0.25em] uppercase">{w.gear}</span>
          <span className="text-[56px] leading-[0.9] font-black">{gearLabel(t.gear)}</span>
          <span className="flex items-baseline gap-1 text-(--tp-white)">
            <span className="text-[22px] leading-none font-black">{formatSpeed(t.speedKmh, units)}</span>
            <span className="text-[11px] font-bold text-(--tp-dim)">{speedUnit(units)}</span>
          </span>
          {showAero ? (
            <span
              className="text-[10px] leading-none font-bold tracking-[0.15em]"
              style={{ color: aero.open || aero.armed ? HUD_INFO : "var(--tp-dim)" }}
            >
              {aero.label}
            </span>
          ) : null}
        </div>
        {right.length ? (
          <div className="flex w-33 flex-col">
            {right.map((c) => (
              <MetricCell key={c.key} cell={c} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
};

/* ---- Fuel */

/** hh:mm:ss, the fuel dashboard's time left */
function clock(s: number): string {
  const w = Math.max(0, Math.floor(s));
  return `${String(Math.floor(w / 3600)).padStart(2, "0")}:${String(Math.floor((w % 3600) / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

/** A fuel figure's heading: icon and tracked caps */
const Head: React.FC<{ icon: IconName; children: string }> = ({ icon, children }) => (
  <span className="flex items-center gap-1.5 text-[11px] leading-none tracking-[0.2em] text-(--tp-white)/80 uppercase">
    <Icon name={icon} size="xs" />
    {children}
  </span>
);

/** The fuel dashboard's top rows: level and time left, use per lap and laps left (fuel cars only) */
const FuelPanel: React.FC<{ t: CarTelemetry; fuelPerLap: number | null }> = ({ t, fuelPerLap }) => {
  const lapsLeft = fuelLapsLeft(t.fuelKg, fuelPerLap);
  const remainingS = lapsLeft !== null ? lapsLeft * referenceLapS(t) : null;
  const race = t.race;
  const lapsToGo = race?.totalLaps ? Math.max(0, race.totalLaps - race.lap + 1) : null;
  // Fuel left at the flag at the measured use: what the source's margins add up to without a pit stop
  const atFlag = lapsToGo !== null && fuelPerLap !== null ? t.fuelKg - lapsToGo * fuelPerLap : null;
  const w = useH2hWords();
  return (
    <section aria-label={w.fuelPanel} className="w-72 border border-(--tp-border) bg-(--tp-bg-a) text-(--tp-white)">
      <div className="grid grid-cols-2 border-b border-(--tp-border) bg-(--tp-bg-a)">
        <div className="grid justify-items-center gap-1.5 px-2 py-2.5">
          <Head icon="fuel">{w.fuelLevel}</Head>
          <span className="text-[26px] leading-none font-black">
            {t.fuelKg.toFixed(1)}
            <Unit>kg</Unit>
          </span>
        </div>
        <div className="grid justify-items-center gap-1.5 px-2 py-2.5">
          <Head icon="time">{w.remaining}</Head>
          <span className="text-[18px] leading-none font-bold">{remainingS !== null ? clock(remainingS) : "--:--:--"}</span>
        </div>
      </div>
      <div className={`grid ${atFlag !== null ? "grid-cols-3" : "grid-cols-2"} bg-(--tp-card-a)`}>
        <div className="grid justify-items-center gap-1.5 px-2 py-2.5">
          <Head icon="restart">{w.perLap}</Head>
          <span className="text-[20px] leading-none font-black">
            {fuelPerLap !== null ? fuelPerLap.toFixed(2) : "-.--"}
            <Unit>kg</Unit>
          </span>
        </div>
        <div className="grid justify-items-center gap-1.5 px-2 py-2.5">
          <Head icon="flyingLap">{w.laps}</Head>
          <span className="text-[20px] leading-none font-black">{lapsLeft !== null ? lapsLeft.toFixed(1) : "-.-"}</span>
        </div>
        {atFlag !== null ? (
          <div className="grid justify-items-center gap-1.5 px-2 py-2.5">
            <Head icon="chequered">{w.atFlag}</Head>
            <span className="text-[20px] leading-none font-black" style={{ color: atFlag >= 0 ? HUD_GAIN : HUD_LOSS }}>
              {atFlag >= 0 ? "" : "−"}
              {Math.abs(atFlag).toFixed(1)}
              <Unit>kg</Unit>
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

/* ---- Spotter */

/** The player's car length (m), the same as the proximity radar's */
const CAR_L = 5.2;

/** Where a car alongside overlaps the player's length, from the rear (0 %) to the nose (100 %), per side */
function spotterSides(t: CarTelemetry): { left: [number, number] | null; right: [number, number] | null } {
  let left: [number, number] | null = null;
  let right: [number, number] | null = null;
  for (const b of t.radar ?? []) {
    const ax = Math.abs(b.x);
    if (ax < 0.9 || ax > 4.5 || Math.abs(b.z) >= CAR_L) continue;
    const from = Math.max(-CAR_L / 2, b.z - CAR_L / 2);
    const to = Math.min(CAR_L / 2, b.z + CAR_L / 2);
    const seg: [number, number] = [((from + CAR_L / 2) / CAR_L) * 100, ((to + CAR_L / 2) / CAR_L) * 100];
    const merge = (s: [number, number] | null): [number, number] => (s ? [Math.min(s[0], seg[0]), Math.max(s[1], seg[1])] : seg);
    if (b.x < 0) left = merge(left);
    else right = merge(right);
  }
  return { left, right };
}

const SpotterSide: React.FC<{ label: string; seg: [number, number] | null }> = ({ label, seg }) => (
  <div className="flex flex-col items-center gap-3">
    <span
      className={`rounded-full border px-3 py-1 text-[12px] leading-none font-bold ${
        seg ? "border-(--tp-yellow) bg-(--tp-yellow) text-(--tp-bg)" : "border-white/10 bg-(--tp-card-a) text-(--tp-dim)"
      }`}
    >
      {label}
    </span>
    <span className="relative h-28 w-3.5 rounded-full border border-white/10 bg-black/80">
      {seg ? (
        <span className="absolute inset-x-0 rounded-full bg-(--tp-yellow)" style={{ bottom: `${seg[0]}%`, height: `${seg[1] - seg[0]}%` }} />
      ) : null}
    </span>
  </div>
);

/** Left and right overlap bars, only while a car is alongside */
const Spotter: React.FC<{ t: CarTelemetry; top?: number }> = ({ t, top }) => {
  const w = useH2hWords();
  const { left, right } = spotterSides(t);
  if (!left && !right) return null;
  return (
    <div
      role="status"
      aria-label={w.alongside(left && right ? "both" : left ? "left" : "right")}
      className={`absolute left-1/2 flex -translate-x-1/2 gap-[min(46vw,560px)] ${top === undefined ? "top-[18%]" : ""}`}
      style={top === undefined ? undefined : { top }}
    >
      <SpotterSide label={w.left} seg={left} />
      <SpotterSide label={w.right} seg={right} />
    </div>
  );
};

/* ---- Weather & race delta */

const WeatherCard: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const units = useUnits();
  const surface = trackSurfaceState(weather.waterMm);
  const rainIcon = weather.rain > 0.5 ? "weatherStorm" : weather.rain > 0.05 ? "weatherRain" : "weatherClear";
  const lights = headlightState(weather);
  const w = useH2hWords();
  return (
    <section aria-label={w.weather} className="w-[236px] border border-(--tp-border) bg-(--tp-bg-a) text-(--tp-white)">
      <div className="grid grid-cols-2 border-b border-(--tp-border)">
        <div className="grid justify-items-center gap-1 px-2 py-2">
          <Head icon={rainIcon}>{w.air}</Head>
          <span className="text-[16px] leading-none font-bold">{formatTemp(weather.airC, units)}</span>
        </div>
        <div className="grid justify-items-center gap-1 border-l border-(--tp-border) px-2 py-2">
          <Head icon="conditions">{w.track}</Head>
          <span className="text-[16px] leading-none font-bold">{formatTemp(weather.trackC, units)}</span>
        </div>
      </div>
      <div className={`grid ${lights ? "grid-cols-3" : "grid-cols-2"} bg-(--tp-card-a)`}>
        <div className="grid justify-items-center gap-1 px-2 py-1.5">
          <span className="text-[10px] leading-none tracking-[0.15em] text-(--tp-dim) uppercase">{w.surface}</span>
          <span
            className="text-[12px] leading-none font-bold uppercase"
            style={{ color: surface === "dry" ? "var(--tp-white)" : surface === "damp" ? "var(--tp-yellow)" : HUD_INFO }}
          >
            {SURFACE_WORD[surface]}
          </span>
        </div>
        <div className="grid justify-items-center gap-1 border-l border-(--tp-border) px-2 py-1.5">
          <span className="text-[10px] leading-none tracking-[0.15em] text-(--tp-dim) uppercase">
            {weather.rain > 0.05 ? w.rain : w.time}
          </span>
          <span className="text-[12px] leading-none font-bold">
            {weather.rain > 0.05 ? `${Math.round(weather.rain * 100)}%` : weather.timeMoving ? dayClock(weather.clockH) : w.timeFixed}
          </span>
        </div>
        {lights ? (
          <div className="grid justify-items-center gap-1 border-l border-(--tp-border) px-2 py-1.5">
            <span className="text-[10px] leading-none tracking-[0.15em] text-(--tp-dim) uppercase">{w.lights}</span>
            <span
              className="text-[12px] leading-none font-bold uppercase"
              style={{ color: lights === "flash" ? "var(--tp-yellow)" : lights === "off" ? "var(--tp-dim)" : "var(--tp-white)" }}
            >
              {HEADLIGHT_WORD[lights]}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

const H2hDeltaBar: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean }> = ({ t, deltaS, lapInvalid }) => {
  const has = deltaS !== null && Number.isFinite(deltaS);
  const gain = has && deltaS < 0;
  const frac = has ? Math.min(1, Math.abs(deltaS)) * 50 : 0;
  const w = useH2hWords();
  return (
    <section
      aria-label={w.liveDelta}
      className="flex w-[228px] flex-col gap-1.5 border border-(--tp-border) bg-(--tp-bg-a) px-2.5 py-1.5 text-(--tp-white)"
    >
      <div className="flex items-baseline justify-between gap-2 text-[12px] leading-none font-bold">
        <span className="tracking-[0.12em] text-(--tp-dim) uppercase">{lapInvalid ? w.barInvalid : w.barDelta}</span>
        <span style={{ color: lapInvalid ? HUD_LOSS : deltaColor(deltaS) }}>{deltaText(deltaS, w.notAvailable)}</span>
        <span className="text-(--tp-dim)">{lapTime(t.bestLapTimeMs)}</span>
      </div>
      <div className="relative h-1.5 overflow-hidden border border-(--tp-border) bg-(--tp-card-a)" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-(--tp-border)" />
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

/* ---- The layout */

const EDGE = "clamp(14px,2.2vw,24px)";

/**
 * Head to Head: the cars either side of the player in a race, as a stack of cards top-left (the car ahead, the
 * player's band with the gap and last-lap delta to each, the car behind); in practice the player's band with the
 * running lap and the live delta. The car's cells (ABS, TC, brake bias, fuel or battery round the gear) sit low in
 * the centre, the fuel figures bottom-left, and the spotter's bars come up only while a car is alongside.
 */
export const HeadToHeadHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  revRange,
  scale,
  mfd,
  touch,
  topInset,
  lapInvalid,
  leftExtra,
  rightExtra,
  weather,
  showDeltaBar,
  showRadar,
}) => {
  const fuelPerLap = useFuelPerLap();
  const w = useH2hWords();
  const race = t.race;
  const showRaceDelta = Boolean(race) && showDeltaBar !== false;
  // With the touch controls up their pause and camera buttons take the top-left, the pads both bottom corners
  const top = touch ? "68px" : EDGE;
  return (
    <div className={`${palette.palette} pointer-events-none absolute inset-0 select-none`}>
      <div className="absolute flex w-[264px] flex-col gap-2 xl:w-[420px]" style={{ top, left: EDGE, ...anchor(scale, "top left") }}>
        <section aria-label={race ? w.headToHead : w.lapCard} className="flex flex-col text-(--tp-white)">
          {race ? <RaceStack t={t} w={w} /> : <PracticeBand t={t} deltaS={deltaS} lapInvalid={lapInvalid} w={w} />}
        </section>
        {leftExtra}
      </div>

      {showRaceDelta ? (
        <div
          className="absolute left-1/2 hidden -translate-x-1/2 md:block"
          style={{ top: topInset ?? EDGE, ...anchor(scale, "top center") }}
        >
          <H2hDeltaBar t={t} deltaS={deltaS} lapInvalid={lapInvalid} />
        </div>
      ) : null}

      {weather || rightExtra ? (
        <div className="absolute hidden w-[236px] flex-col items-end gap-2 md:flex" style={{ top, right: EDGE, ...anchor(scale, "top right") }}>
          {weather ? <WeatherCard weather={weather} /> : null}
          {rightExtra}
        </div>
      ) : null}

      {showRadar !== false ? (
        <Spotter t={t} top={topInset !== undefined ? topInset + (showRaceDelta ? 52 : 0) : undefined} />
      ) : null}

      {/* Fuel bottom-left on cars that burn it, from a laptop up; the steering pad has the corner on a tablet */}
      {!touch && t.fuelKg > 0 ? (
        <div data-hud-floor data-hud-avoid className="absolute hidden lg:block" style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}>
          <FuelPanel t={t} fuelPerLap={fuelPerLap} />
        </div>
      ) : null}

      {mfd && !touch ? (
        <div className="absolute hidden lg:block" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
          {mfd}
        </div>
      ) : null}

      {/* The car's cells: low in the centre, above the pads with the touch controls up */}
      <div
        data-hud-avoid
        className="absolute left-1/2 -translate-x-1/2"
        style={{ bottom: touch ? 176 : EDGE, ...anchor(scale, "bottom center") }}
      >
        <CarCells t={t} revRange={revRange} fuelPerLap={fuelPerLap} />
      </div>
    </div>
  );
};
