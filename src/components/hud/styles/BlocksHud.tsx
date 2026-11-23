"use client";

/*
 * Blocks: a HUD layout derived from C1XTZ's HUD app, https://github.com/C1XTZ/ac-rennsporthud
 * Copyright (C) C1XTZ. This file is derived from GPL-3.0 work and stays under the GNU General Public License v3
 * (GPL-3.0); section 13 of the GPL v3 lets it be combined with LibreCorsa's AGPL-3.0 code, and the combined game is
 * under the AGPL-3.0. The licence text and notice are in THIRD_PARTY_NOTICES.md.
 *
 * Modified 16 November 2026 for LibreCorsa: rewritten from Lua to React/TypeScript, reading LibreCorsa's telemetry,
 * with the source's look kept (flat black blocks at its opacities, square corners, bold white type, its sizes) and:
 * - kept: the leaderboard (position, driver, lap, last, best, interval), the sector bar with its flag row, the delta
 *   block (delta to best, predicted lap, the centre bar), the position / laps / session-clock blocks, the current lap
 *   time with best / last / ideal and the lap history with sectors, the essentials (rpm bar, speed, gear, rpm), the
 *   inputs (force feedback, clutch, brake, throttle, ABS / TC / brake bias / boost cells), fuel and tyres;
 * - mapped: car numbers to the team colour, ABS / TC modes to the live tuner's levels, the turbo cell to ERS on a
 *   hybrid, the session timer to the time on track this run, fuel in kg;
 * - added: the 2026 cars' ERS and aero state under the essentials, native weather blocks top-right, a square proximity
 *   radar block, and track-limits / penalty states on the flag row;
 * - dropped: the logo and the decoration strip, the steering-wheel pictures and the icon set, car names, the pit-lane
 *   speed row (no pit lane here), turn indicators, the settings window and the updater.
 */

import React, { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, RaceStandingEntry } from "@/types/f1";
import { useUnits } from "@/lib/settings/ui-prefs";
import {
  aidsActive,
  brakeGlowColor,
  formatDelta,
  formatDeltaFit,
  formatPressurePsi,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  HUD_BEST,
  HUD_CAUTION,
  HUD_GAIN,
  HUD_INFO,
  HUD_LOSS,
  lapMark,
  NO_TIME,
  pressureUnit,
  sectorDone,
  speedUnit,
  tyreHeatColor,
  sessionWord,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { pedalLayers } from "../PedalBars";
import { cornerData } from "../TyreBrakeWidget";
import { type WeatherHudState } from "../WeatherBadge";
import { anchor, formatOnce, gearLabel, liveMessage, type HudDesignProps } from "./hud-style-parts";
import { REV_BAND_COLOR, revLights, useFuelPerLap, useLapHistory, useSessionClock, useStartFuel } from "./third-party-parts";
import {
  dayClock,
  driverLabel,
  evaluateRadar,
  fuelLapsLeft,
  HEADLIGHT_WORD,
  headlightState,
  idealLapMs,
  leaderboardWindow,
  predictedLapMs,
  RADAR_CAR_L,
  RADAR_CAR_W,
  RADAR_VIEW_RANGE_M,
  sessionBestLapMs,
  SURFACE_WORD,
  trackSurfaceState,
  type LapRecord,
} from "../third-party-data";
import { revLedBand } from "@/lib/sim/rev-range";
import palette from "./blocks.module.css";

/** The corner groups' distance from the screen edge (the game's other layouts use the same) */
const EDGE = "clamp(14px,2.2vw,24px)";
/** The touch controls' pause and camera buttons reach this far down the top-left */
const TOUCH_TOP = 68;
/** The delta bar's full width is this many seconds, as in the source (on a ^0.3 curve) */
const DELTA_BAR_S = 10;

const BLOCK = "bg-(--blk-block)";
const HEAD = "bg-(--blk-head)";
const LABEL = "text-[13px] leading-none font-black uppercase";

/** The Blocks layout's words in the current language, resolved once per language */
function useBlocksWords() {
  const tx = useTranslations("hudStyles.blocks");
  return useMemo(
    () => ({
      out: tx("out"),
      finished: tx("finished"),
      leader: tx("leader"),
      lapsDown: formatOnce((count: number) => tx("lapsDown", { count })),
      leaderboard: tx("leaderboard"),
      headPos: tx("headPos"),
      headName: tx("headName"),
      headLap: tx("headLap"),
      headLast: tx("headLast"),
      headBest: tx("headBest"),
      headGap: tx("headGap"),
      headInterval: tx("headInterval"),
      you: tx("you"),
      sectors: tx("sectors"),
      raceFinished: tx("raceFinished"),
      vsc: liveMessage(["delta"], (marks) => tx("vsc", marks)),
      vscEnding: liveMessage(["delta"], (marks) => tx("vscEnding", marks)),
      doubleYellow: tx("doubleYellow"),
      yellowFlag: tx("yellowFlag"),
      offTrackStrikes: formatOnce((warnings: string, limit: number) => tx("offTrackStrikes", { warnings, limit: String(limit) })),
      offTrack: tx("offTrack"),
      lapDeleted: tx("lapDeleted"),
      blueFlag: formatOnce((warn: boolean, driver: string) => tx(warn ? "blueFlagYield" : "blueFlagLetThrough", { driver })),
      lastLap: tx("lastLap"),
      deltaAria: tx("deltaAria"),
      deltaBest: tx("deltaBest"),
      predicted: tx("predicted"),
      position: tx("position"),
      laps: tx("laps"),
      race: tx("race"),
      lapTiming: tx("lapTiming"),
      currentTime: tx("currentTime"),
      invalid: tx("invalid"),
      best: tx("best"),
      last: tx("last"),
      ideal: tx("ideal"),
      lapHistory: tx("lapHistory"),
      historyLap: tx("historyLap"),
      historyTime: tx("historyTime"),
      historyDeltaBest: tx("historyDeltaBest"),
      essentials: tx("essentials"),
      forceFeedback: tx("forceFeedback"),
      clutch: tx("clutch"),
      brake: tx("brake"),
      throttle: tx("throttle"),
      inputs: tx("inputs"),
      aidOff: tx("aidOff"),
      brakeBias: tx("brakeBias"),
      turbo: tx("turbo"),
      fuel: tx("fuel"),
      fuelRemaining: tx("fuelRemaining"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      tyres: tx("tyres"),
      weather: tx("weather"),
      rain: formatOnce((pct: number) => tx("rain", { pct: String(pct) })),
      air: tx("air"),
      track: tx("track"),
      surface: tx("surface"),
      lights: tx("lights"),
      radar: tx("radar"),
    }),
    [tx],
  );
}

/** A lap time as the source writes it, mm:ss.mmm with the minutes padded; dashes without a time */
function lapClock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return "--:--.---";
  const whole = Math.floor(ms);
  const min = Math.floor(whole / 60_000);
  const sec = Math.floor((whole % 60_000) / 1000);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(whole % 1000).padStart(3, "0")}`;
}

/** The session clock as hh:mm:ss */
function hms(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, "0");

/**
 * A completed sector's fill, as the source colours its sector bar: the best (the player's own best: purple on your
 * own, green in a race, as the game marks a personal best), green when faster than the lap before, red when slower
 */
function sectorFill(ms: number, best: number | null | undefined, previous: number | null | undefined, solo: boolean): string {
  const mark = lapMark(ms, best, solo);
  if (mark !== "slower") return mark === "best" ? HUD_BEST : HUD_GAIN;
  if (previous === null || previous === undefined) return HUD_CAUTION;
  return ms > previous + 0.5 ? HUD_LOSS : HUD_GAIN;
}

// ---- Leaderboard (race, top-left)

const Leaderboard: React.FC<{ t: CarTelemetry; gaps: "interval" | "leader" }> = ({ t, gaps }) => {
  const race = t.race!;
  const standings = race.standings;
  const rows = leaderboardWindow(standings, 12);
  const best = sessionBestLapMs(t);
  const leaderLap = standings[0]?.lap ?? 0;
  const w = useBlocksWords();
  const gapText = (e: RaceStandingEntry, pos: number): string => {
    if (e.retired) return w.out;
    if (e.finished) return w.finished;
    if (pos === 1) return w.leader;
    const lapsDown = leaderLap - e.lap;
    if (gaps === "leader" && lapsDown >= 1 && e.gapToLeaderS > 60) return w.lapsDown(lapsDown);
    const s = gaps === "leader" ? e.gapToLeaderS : (e.intervalS ?? 0);
    return `+${s.toFixed(3)}`;
  };
  return (
    <section aria-label={w.leaderboard} className={`${BLOCK} text-[13px] leading-none font-bold`}>
      <div className={`flex h-5 items-center ${HEAD} pr-2 pl-2.5`}>
        <span className="w-6.5 shrink-0">{w.headPos}</span>
        <span className="w-[66px] shrink-0 pl-2.5">{w.headName}</span>
        <span className="w-7 shrink-0 text-right">{w.headLap}</span>
        <span className="hidden w-[76px] shrink-0 text-right xl:block">{w.headLast}</span>
        <span className="hidden w-[76px] shrink-0 text-right xl:block">{w.headBest}</span>
        <span className="w-[72px] shrink-0 text-right">{gaps === "leader" ? w.headGap : w.headInterval}</span>
      </div>
      {rows.map((e, i) => {
        const pos = standings.indexOf(e) + 1;
        const fastest = best !== null && e.bestLapMs === best;
        return (
          <div key={e.driverCode + (e.name ?? "") + pos} className={`relative flex h-5 items-center pr-2 pl-2.5 ${i >= 9 ? "compact:hidden" : ""}`}>
            {e.isPlayer ? <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-(--blk-player)" /> : null}
            <span className="w-6.5 shrink-0">{pos}</span>
            <span className="flex w-[66px] shrink-0 items-center gap-1.5">
              {/* The team colour stands in for the source's car number */}
              <span aria-hidden className="h-3 w-1 shrink-0" style={{ backgroundColor: e.teamColorHex }} />
              <span className="truncate">{driverLabel(e, w.you)}</span>
            </span>
            <span className="w-7 shrink-0 text-right">{e.lap}</span>
            <span className="hidden w-[76px] shrink-0 text-right xl:block">{lapClock(e.lastLapMs)}</span>
            <span className="hidden w-[76px] shrink-0 text-right xl:block" style={fastest ? { color: HUD_BEST } : undefined}>
              {lapClock(e.bestLapMs)}
            </span>
            <span className="w-[72px] shrink-0 text-right">{gapText(e, pos)}</span>
          </div>
        );
      })}
    </section>
  );
};

// ---- Sectors, the flag row and the delta (top-centre)

const SectorBar: React.FC<{ t: CarTelemetry; laps: LapRecord[] }> = ({ t, laps }) => {
  // Just over the line, the lap that ended keeps its colours a moment, as in the source
  const lastLap = t.currentSector === 1 && t.currentLapTimeMs < 4000 && laps.length > 0 ? laps[0] : null;
  const previous = lastLap ? laps[1] : laps[0];
  const solo = !t.race;
  const w = useBlocksWords();
  return (
    <div className="flex" role="group" aria-label={w.sectors}>
      {[0, 1, 2].map((i) => {
        // This lap's done sectors only: the out-lap from the grid starts in sector 3 with no S1 or S2 of its own
        const ms = lastLap ? lastLap.sectorsMs[i] : sectorDone(t, i) ? t.sectorTimesMs[i] : null;
        const fill = ms ? sectorFill(ms, t.bestSectorTimesMs[i], previous?.sectorsMs[i], solo) : null;
        const current = !lastLap && i + 1 === t.currentSector;
        return (
          <div
            key={i}
            className={`relative flex h-5 w-[110px] items-center justify-center gap-2 text-[13px] leading-none font-black xl:w-[150px] ${fill ? "text-lc-void" : BLOCK}`}
            style={fill ? { backgroundColor: fill } : undefined}
          >
            <span>S{i + 1}</span>
            {ms ? <span className="font-bold">{formatSectorTime(ms)}</span> : null}
            {current ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 bg-(--blk-fill)" /> : null}
          </div>
        );
      })}
    </div>
  );
};

/**
 * The flag row under the sectors: a yellow flag, the track limits, a blue flag, the last lap, the race finished (empty
 * otherwise). Race control's standing flag pill stays off under this layout, so the blue flag shows here
 */
const FlagRow: React.FC<{ t: CarTelemetry; lapInvalid: boolean }> = ({ t, lapInvalid }) => {
  const race = t.race;
  const tl = t.trackLimits;
  const w = useBlocksWords();
  if (tl?.pending?.stage === "give_back") return null;
  const row =
    race?.phase === "finished"
      ? { text: w.raceFinished, cls: "bg-(--blk-flag-black) text-(--blk-ink)" }
      : race?.vsc
        ? {
            text: (race.vsc.phase === "ending" ? w.vscEnding : w.vsc)({
              delta: `${race.vsc.deltaS >= 0 ? "+" : "−"}${Math.abs(race.vsc.deltaS).toFixed(2)}`,
            }),
            cls: race.vsc.deltaS < -0.5 ? "bg-(--blk-player) text-(--blk-ink)" : "bg-(--blk-flag-yellow) text-(--blk-ink-on)",
          }
      : race?.yellow
        ? { text: race.doubleYellow ? w.doubleYellow : w.yellowFlag, cls: "bg-(--blk-flag-yellow) text-(--blk-ink-on)" }
        : t.offTrack || tl?.message?.kind === "lap_invalid" || (lapInvalid && t.currentLapTimeMs < 6000)
          ? {
              text: t.offTrack
                ? race && tl && tl.strikesPerPenalty > 0
                  ? w.offTrackStrikes(tl.ladder?.scoring === "weighted_pts" ? tl.warnings.toFixed(2) : String(tl.warnings), tl.strikesPerPenalty)
                  : w.offTrack
                : w.lapDeleted,
              cls: "bg-(--blk-player) text-(--blk-ink)",
            }
          : race?.blueFlag
            ? {
                text: w.blueFlag(Boolean(race.blueFlagWarn), race.blueFlag),
                cls: "bg-(--blk-flag-blue) text-(--blk-ink-on)",
              }
            : race?.totalLaps && race.lap === race.totalLaps && race.phase === "racing"
              ? { text: w.lastLap, cls: "bg-(--blk-flag-white) text-(--blk-ink-on)" }
              : null;
  if (!row) return null;
  return (
    <div role="status" className={`flex h-5 items-center justify-center text-[13px] leading-none font-black uppercase ${row.cls}`}>
      {row.text}
    </div>
  );
};

const DeltaBlock: React.FC<{ t: CarTelemetry; deltaS: number | null }> = ({ t, deltaS }) => {
  const has = deltaS !== null && Number.isFinite(deltaS);
  const color = !has ? undefined : deltaS > 0.0005 ? HUD_LOSS : deltaS < -0.0005 ? HUD_GAIN : undefined;
  const k = has ? Math.min(1, Math.abs(deltaS) / DELTA_BAR_S) ** 0.3 : 0;
  const w = useBlocksWords();
  return (
    <section aria-label={w.deltaAria} className="w-[190px] text-[14px] leading-none font-black lg:w-[250px]">
      <div className="flex h-6 items-center justify-between bg-(--blk-soft) px-3.5">
        <span>{w.deltaBest}</span>
        <span style={{ color }}>{has ? formatDeltaFit(deltaS) : NO_TIME}</span>
      </div>
      <div className="flex h-5.5 items-center justify-between bg-(--blk-soft) px-3.5">
        <span>{w.predicted}</span>
        <span>{lapClock(predictedLapMs(t.bestLapTimeMs, deltaS))}</span>
      </div>
      <div className="relative h-4 bg-(--blk-deep)" aria-hidden>
        {k > 0 ? (
          <span
            className="absolute inset-y-0"
            style={{ backgroundColor: color ?? "var(--blk-fill)", width: `${k * 50}%`, ...(deltaS! > 0 ? { left: "50%" } : { right: "50%" }) }}
          />
        ) : null}
      </div>
    </section>
  );
};

// ---- Session blocks (top-right)

/** A session block: its label top-left, its value large under it */
const SessionBlock: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({ label, className = "", children }) => (
  <div className={`flex h-16 flex-col justify-between ${BLOCK} px-2 pt-1.5 pb-1 ${className}`}>
    <span className={LABEL}>{label}</span>
    <span className="text-[34px] leading-none font-bold whitespace-nowrap">{children}</span>
  </div>
);

const SessionBlocks: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const race = t.race;
  const clock = useSessionClock();
  const w = useBlocksWords();
  return (
    <div className="flex items-start gap-3.5">
      {race ? (
        <SessionBlock label={w.position} className="min-w-[105px]">
          {pad2(race.position)}
          <span className="text-[18px]">/{pad2(race.fieldSize || race.standings.length)}</span>
        </SessionBlock>
      ) : null}
      <SessionBlock label={w.laps} className="hidden min-w-[60px] md:flex">
        {pad2(race ? race.lap : Math.max(1, t.lapCount))}
        {race?.totalLaps ? <span className="text-[18px]">/{pad2(race.totalLaps)}</span> : null}
      </SessionBlock>
      <SessionBlock label={race ? w.race : sessionWord(t)} className="hidden min-w-[164px] xl:flex">
        {hms(clock)}
      </SessionBlock>
    </div>
  );
};

// ---- Timing (bottom-left; top-right with the touch controls up)

const Timing: React.FC<{ t: CarTelemetry; lapInvalid: boolean }> = ({ t, lapInvalid }) => {
  const w = useBlocksWords();
  const stats: [string, string, number | null, boolean][] = [
    ["best", w.best, t.bestLapTimeMs, true],
    ["last", w.last, t.lastLapTimeMs, false],
    ["ideal", w.ideal, idealLapMs(t), false],
  ];
  return (
    <section aria-label={w.lapTiming} className="flex flex-col gap-1.5">
      <div className={`flex w-[211px] flex-col gap-0.5 ${BLOCK} px-1.5 pt-1.5 pb-1`}>
        <span className={`flex justify-between ${LABEL}`}>
          {w.currentTime}
          {lapInvalid ? <span style={{ color: HUD_LOSS }}>{w.invalid}</span> : null}
        </span>
        <span className="text-[40px] leading-none font-bold" style={lapInvalid ? { color: HUD_LOSS } : undefined}>
          {/* Held at zero on the out-lap, where no lap is timed yet */}
          {t.outLap ? "00:00.000" : lapClock(t.currentLapTimeMs)}
        </span>
      </div>
      <div className="w-[150px] text-[13px] leading-none font-bold">
        {stats.map(([id, label, ms, best]) => (
          <div key={id} className="flex h-5">
            <span
              className={`flex w-[55px] items-center px-1.5 font-black uppercase ${best && ms ? "text-lc-void" : HEAD}`}
              style={best && ms ? { backgroundColor: HUD_BEST } : undefined}
            >
              {label}
            </span>
            <span className={`flex flex-1 items-center px-1.5 ${BLOCK}`}>{lapClock(ms)}</span>
          </div>
        ))}
      </div>
    </section>
  );
};

const LapHistory: React.FC<{ t: CarTelemetry; laps: LapRecord[] }> = ({ t, laps }) => {
  const best = t.bestLapTimeMs;
  const cols = "grid grid-cols-[34px_76px_74px_repeat(3,56px)] items-center px-1.5";
  const w = useBlocksWords();
  return (
    <section aria-label={w.lapHistory} className="text-[13px] leading-none font-bold">
      <div className={`${cols} h-5 ${HEAD}`}>
        <span className="text-center">{w.historyLap}</span>
        <span>{w.historyTime}</span>
        <span>{w.historyDeltaBest}</span>
        <span>S1</span>
        <span>S2</span>
        <span>S3</span>
      </div>
      {laps.slice(0, 5).map((l) => {
        const d = best && l.ms !== best ? (l.ms - best) / 1000 : null;
        return (
          <div key={l.lap} className={`${cols} h-5 ${BLOCK}`}>
            <span className="text-center">{l.lap}</span>
            <span style={l.valid ? undefined : { color: HUD_LOSS }}>{lapClock(l.ms)}</span>
            <span>{d === null ? "" : formatDelta(d)}</span>
            {l.sectorsMs.map((s, i) => (
              <span key={i}>{s ? formatSectorTime(s) : "--.---"}</span>
            ))}
          </div>
        );
      })}
    </section>
  );
};

// ---- Essentials (bottom-centre)

const Essentials: React.FC<{ t: CarTelemetry; revRange: [number, number] }> = ({ t, revRange }) => {
  const units = useUnits();
  const lights = revLights(t.rpm, revRange, 20);
  const fill = Math.max(0, Math.min(1, t.rpm / revRange[1]));
  const barColor = lights.atShift
    ? lights.color(0)
    : lights.lit > 0 && revLedBand(lights.lit - 1, 20) !== "green"
      ? REV_BAND_COLOR[revLedBand(lights.lit - 1, 20)]
      : "var(--blk-fill)";
  const aero = aeroReadout(t);
  const hasErs = t.f12026?.hasErs ?? t.liveTuner?.hasErs ?? false;
  const strip = hasErs || t.overtakingRules === "drs-rear" || t.overtakingRules === "straight-mode-2026";
  const w = useBlocksWords();
  return (
    <section aria-label={w.essentials} className={`w-[325px] ${BLOCK}`}>
      <div className="relative h-4.5 bg-(--blk-block)" aria-hidden>
        <span className="absolute inset-y-0 left-0" style={{ width: `${fill * 100}%`, backgroundColor: barColor }} />
      </div>
      <div className="grid h-[92px] grid-cols-[1fr_4px_92px_4px_1fr] items-center">
        <span className="flex flex-col items-end gap-1 pr-3.5 leading-none">
          <span className="text-[34px] font-bold">{formatSpeed(t.speedKmh, units)}</span>
          <span className="text-[14px] font-black uppercase">{speedUnit(units)}</span>
        </span>
        <span aria-hidden className="h-[72px] bg-(--blk-fill)" />
        <span className="text-center text-[64px] leading-none font-bold" style={lights.atShift ? { color: lights.color(0) } : undefined}>
          {gearLabel(t.gear)}
        </span>
        <span aria-hidden className="h-[72px] bg-(--blk-fill)" />
        <span className="flex flex-col items-start gap-1 pl-3.5 leading-none">
          <span className="text-[34px] font-bold">{Math.round(t.rpm)}</span>
          <span className="text-[14px] font-black">RPM</span>
        </span>
      </div>
      {strip ? (
        <div className="flex h-5 items-center gap-2 bg-(--blk-deep) px-2.5 text-[11px] leading-none font-black uppercase">
          {hasErs ? (
            <>
              <span>ERS</span>
              <span className="relative h-1.5 flex-1 bg-(--blk-block)">
                <span className="absolute inset-y-0 left-0" style={{ width: `${t.ersBatteryPercent}%`, backgroundColor: HUD_INFO }} />
              </span>
              <span className="w-8 text-right">{Math.round(t.ersBatteryPercent)}%</span>
            </>
          ) : (
            <span className="flex-1" />
          )}
          {t.overtakingRules !== "none" ? (
            <span
              className={`flex h-3.5 items-center px-1.5 ${aero.open ? "text-lc-void" : aero.armed || aero.queued ? "" : "text-(--blk-ink-dim)"}`}
              style={aero.open ? { backgroundColor: HUD_INFO } : aero.armed || aero.queued ? { boxShadow: `inset 0 0 0 1px ${HUD_INFO}` } : undefined}
            >
              {aero.label}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
};

// ---- Inputs, fuel and tyres (bottom-right)

/** A pedal bar: white fill from the left, its label centred, inverting to black where the fill passes under it */
const PedalBar: React.FC<{ label: string; value: number; color?: string }> = ({ label, value, color = "var(--blk-fill)" }) => {
  const pct = `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
  return (
    <div className={`relative h-[18px] ${BLOCK} text-[12px] leading-none font-bold uppercase`}>
      <span className="absolute inset-0 flex items-center justify-center">{label}</span>
      <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: pct, backgroundColor: color }}>
        <span className="flex h-full w-[200px] items-center justify-center text-(--blk-ink-on)">{label}</span>
      </span>
    </div>
  );
};

const Inputs: React.FC<{ t: CarTelemetry; ffb: boolean }> = ({ t, ffb }) => {
  const p = pedalLayers(t);
  const aids = aidsActive(t);
  const tuner = t.liveTuner;
  const w = useBlocksWords();
  const level = (n: number | undefined) => (n === undefined ? "--" : n === 0 ? w.aidOff : `${n}/12`);
  const hasErs = t.f12026?.hasErs ?? tuner?.hasErs ?? false;
  // A hybrid's battery where the source shows the turbo's boost (gauge, over the atmosphere's 1 bar: 0.00 without a turbo)
  const fourth: [string, string] = hasErs
    ? ["ERS", `${Math.round(t.ersBatteryPercent)}%`]
    : [w.turbo, Math.max(0, t.turboBoostBar - 1).toFixed(2)];
  const cells: [string, string, boolean][] = [
    ["ABS", level(tuner?.absLevel), aids.abs],
    [w.brakeBias, tuner ? `${Math.round(tuner.brakeBiasPct)}%` : "--", false],
    ["TC", level(tuner?.tcLevel), aids.tc],
    [fourth[0], fourth[1], false],
  ];
  return (
    <section aria-label={w.inputs} className="flex w-[200px] flex-col">
      <div className="relative h-4 bg-(--blk-head)" aria-hidden>
        <span className="absolute inset-y-0 w-1.5 bg-(--blk-fill)" style={{ left: `calc(${((p.steer + 1) / 2) * 100}% - ${((p.steer + 1) / 2) * 6}px)` }} />
      </div>
      {ffb ? <PedalBar label={w.forceFeedback} value={p.ffb} color={p.ffbClip ? HUD_LOSS : undefined} /> : null}
      <PedalBar label={w.clutch} value={p.clutch} />
      <PedalBar label={w.brake} value={p.brake} />
      <PedalBar label={w.throttle} value={p.throttle} />
      <div className={`grid grid-cols-[45px_55px_45px_55px] ${BLOCK} text-[11px] leading-none font-black`}>
        {cells.map(([label, value, active], i) => (
          <React.Fragment key={i}>
            <span
              className={`flex h-[17px] items-center justify-center ${active ? "" : "bg-(--blk-block)"}`}
              style={active ? { backgroundColor: "var(--blk-active)" } : undefined}
            >
              {label}
            </span>
            <span className="flex h-[17px] items-center justify-center font-bold">{value}</span>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
};

const Fuel: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const perLap = useFuelPerLap();
  const startKg = Math.max(useStartFuel(), t.fuelKg);
  const fraction = startKg > 0 ? t.fuelKg / startKg : 0;
  const laps = fuelLapsLeft(t.fuelKg, perLap);
  const w = useBlocksWords();
  return (
    <section aria-label={w.fuel} className="flex w-[150px] flex-col">
      <div className="relative h-4 bg-(--blk-deep)" aria-hidden>
        <span className="absolute inset-y-0 left-0 bg-(--blk-active)" style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%` }} />
      </div>
      <div className={`flex h-[54px] flex-col justify-between ${BLOCK} px-1.5 pt-1.5 pb-1`}>
        <span className="text-[11px] leading-none font-black uppercase">{w.fuelRemaining}</span>
        <span className="flex items-baseline justify-between gap-1 leading-none">
          <span className="text-[24px] font-bold">
            {t.fuelKg.toFixed(1)}
            <span className="ml-1 text-[12px] font-black">kg</span>
          </span>
          {laps !== null ? <span className="text-[11px] font-bold">{w.fuelLaps(laps.toFixed(1))}</span> : null}
        </span>
      </div>
    </section>
  );
};

/** One wheel: pressure over a tyre drawn as its three tread bands in their heat colours, the brake inboard, the wear outboard */
const Wheel: React.FC<{ t: CarTelemetry; i: number }> = ({ t, i }) => {
  const units = useUnits();
  const c = cornerData(t, i);
  const left = i % 2 === 0;
  const wear = (
    <span className="relative h-[31px] w-1.5 bg-(--blk-deep)" aria-hidden>
      <span className="absolute inset-x-0 bottom-0 bg-(--blk-fill)" style={{ height: `${c.life}%` }} />
    </span>
  );
  const brake = <span aria-hidden className="h-5 w-[3px]" style={{ backgroundColor: brakeGlowColor(c.brake) }} />;
  return (
    <div className="flex h-[74px] flex-col items-center justify-center gap-1">
      <span className="text-[11px] leading-none font-bold">
        {c.psi !== null ? `${formatPressurePsi(c.psi, units)} ${pressureUnit(units)}` : NO_TIME}
      </span>
      <span className="flex items-center gap-1.5">
        {left ? wear : brake}
        <span className="flex h-10 gap-px">
          {c.bands.map((b, k) => (
            <span key={k} className="w-1.5" style={{ backgroundColor: tyreHeatColor(b, t.tireOptimalTempC) }} />
          ))}
        </span>
        {left ? brake : wear}
      </span>
    </div>
  );
};

const Tyres: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const units = useUnits();
  const temps = (i: number) => (cornerData(t, i).bands.map((b) => formatTemp(b, units).replace("°", "")) as string[]);
  const w = useBlocksWords();
  return (
    <section aria-label={w.tyres} className={`w-[164px] ${BLOCK}`}>
      <div className="grid grid-cols-2">
        <Wheel t={t} i={0} />
        <Wheel t={t} i={1} />
      </div>
      <div className={`${HEAD} py-0.5 text-[11px] leading-[14px] font-black`}>
        {[
          [0, 1],
          [2, 3],
        ].map(([a, b]) => (
          <div key={a} className="grid grid-cols-6 text-center">
            {[...temps(a), ...temps(b)].map((v, k) => (
              <span key={k}>{v}</span>
            ))}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2">
        <Wheel t={t} i={2} />
        <Wheel t={t} i={3} />
      </div>
    </section>
  );
};

const WeatherBlocks: React.FC<{ weather: WeatherHudState }> = ({ weather }) => {
  const units = useUnits();
  const surface = trackSurfaceState(weather.waterMm);
  const lights = headlightState(weather);
  const w = useBlocksWords();
  return (
    <section aria-label={w.weather} className="w-[196px] text-[12px] leading-none font-bold">
      <div className={`flex h-5 items-center justify-between px-2 ${HEAD} uppercase`}>
        <span>{w.weather}</span>
        <span>{weather.rain > 0.05 ? w.rain(Math.round(weather.rain * 100)) : weather.timeMoving ? dayClock(weather.clockH) : SURFACE_WORD[surface]}</span>
      </div>
      <div className={`grid ${lights ? "grid-cols-4" : "grid-cols-3"} gap-1 px-2 py-1.5 ${BLOCK}`}>
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-black text-(--blk-ink-dim) uppercase">{w.air}</span>
          <span>{formatTemp(weather.airC, units)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-black text-(--blk-ink-dim) uppercase">{w.track}</span>
          <span>{formatTemp(weather.trackC, units)}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[9px] font-black text-(--blk-ink-dim) uppercase">{w.surface}</span>
          <span style={{ color: surface === "dry" ? undefined : surface === "damp" ? "var(--blk-flag-yellow)" : HUD_INFO }}>
            {SURFACE_WORD[surface]}
          </span>
        </div>
        {lights ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-black text-(--blk-ink-dim) uppercase">{w.lights}</span>
            <span
              className="uppercase"
              style={{ color: lights === "flash" ? "var(--blk-flag-yellow)" : lights === "off" ? "var(--blk-ink-dim)" : undefined }}
            >
              {HEADLIGHT_WORD[lights]}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
};

const BlocksRadar: React.FC<{ t: CarTelemetry }> = ({ t }) => {
  const w = useBlocksWords();
  const { blips, leftCar, rightCar, opacity } = evaluateRadar(t.radar ?? []);
  if (opacity <= 0.01) return null;
  const range = RADAR_VIEW_RANGE_M;
  return (
    <div
      className="pointer-events-none absolute top-[53%] left-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-150 ease-out"
      style={{ width: 148, height: 148, opacity }}
    >
      <div className={`relative size-full ${BLOCK}`}>
        {leftCar ? (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1.5"
            style={{
              backgroundColor: leftCar.overlapLevel === 2 ? "var(--blk-player)" : "var(--blk-flag-yellow)",
              opacity: Math.max(0.65, leftCar.opacity),
            }}
          />
        ) : null}
        {rightCar ? (
          <span
            aria-hidden
            className="absolute inset-y-0 right-0 w-1.5"
            style={{
              backgroundColor: rightCar.overlapLevel === 2 ? "var(--blk-player)" : "var(--blk-flag-yellow)",
              opacity: Math.max(0.65, rightCar.opacity),
            }}
          />
        ) : null}
        <svg viewBox={`${-range} ${-range} ${range * 2} ${range * 2}`} className="block size-full" role="img" aria-label={w.radar}>
          <circle r={8} fill="none" stroke="var(--blk-ink)" strokeOpacity={0.18} strokeWidth={0.35} />
          <circle r={16} fill="none" stroke="var(--blk-ink)" strokeOpacity={0.12} strokeWidth={0.35} />
          <line x1={0} y1={-range} x2={0} y2={range} stroke="var(--blk-ink)" strokeOpacity={0.12} strokeWidth={0.25} />
          <line x1={-range} y1={0} x2={range} y2={0} stroke="var(--blk-ink)" strokeOpacity={0.12} strokeWidth={0.25} />
          {blips.map(({ blip: b, opacity: carOp, overlapLevel }, i) => (
            <rect
              key={i}
              x={-RADAR_CAR_W / 2}
              y={-RADAR_CAR_L / 2}
              width={RADAR_CAR_W}
              height={RADAR_CAR_L}
              fill={overlapLevel === 2 ? HUD_LOSS : overlapLevel === 1 ? HUD_CAUTION : b.color}
              fillOpacity={Math.max(0.35, carOp)}
              stroke="var(--blk-ink-on)"
              strokeWidth={0.35}
              transform={`translate(${b.x.toFixed(2)} ${(-b.z).toFixed(2)}) rotate(${((b.yaw * 180) / Math.PI).toFixed(1)})`}
            />
          ))}
          <rect
            x={-RADAR_CAR_W / 2}
            y={-RADAR_CAR_L / 2}
            width={RADAR_CAR_W}
            height={RADAR_CAR_L}
            fill="var(--blk-active)"
            stroke="var(--blk-ink-on)"
            strokeWidth={0.35}
          />
        </svg>
      </div>
    </div>
  );
};

/**
 * Blocks: flat black blocks with square corners and bold white type. The leaderboard top-left, the sector bar and
 * the delta top-centre, position / laps / the session clock top-right, the lap timing and history bottom-left, speed,
 * gear and rpm bottom-centre, and the inputs, fuel and tyres bottom-right. With the touch controls up (a tablet) the
 * bottom corners are the pads': the timing moves under the session blocks and the essentials rise above the pads.
 */
export const BlocksHud: React.FC<HudDesignProps> = ({
  t,
  deltaS,
  revRange,
  scale,
  ffb,
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
  const race = t.race;
  const laps = useLapHistory(6);
  const hasFuel = t.fuelKg > 0;

  return (
    <div className={`pointer-events-none absolute inset-0 select-none ${palette.palette}`}>
      {/* Top-left: the leaderboard in a race */}
      <div className="absolute flex flex-col items-start gap-2" style={{ top: touch ? TOUCH_TOP : EDGE, left: EDGE, ...anchor(scale, "top left") }}>
        {race ? <Leaderboard t={t} gaps={towerGaps} /> : null}
        {leftExtra ? <div className="w-[264px]">{leftExtra}</div> : null}
      </div>

      {/* Top-centre: the sector bar with its flag row, the delta under it */}
      <div className="absolute left-1/2 -translate-x-1/2" style={{ top: topInset ?? EDGE }}>
        <div className="flex flex-col items-center gap-1.5" style={anchor(scale, "top center")}>
          <div className="flex flex-col">
            <SectorBar t={t} laps={laps} />
            <FlagRow t={t} lapInvalid={lapInvalid} />
          </div>
          {showDeltaBar !== false ? <DeltaBlock t={t} deltaS={deltaS} /> : null}
        </div>
      </div>

      {/* Top-right: position, laps, the session clock; the lap timing joins them with the touch controls up */}
      <div className="absolute flex flex-col items-end gap-2" style={{ top: EDGE, right: EDGE, ...anchor(scale, "top right") }}>
        <SessionBlocks t={t} />
        {weather ? <WeatherBlocks weather={weather} /> : null}
        {touch ? <Timing t={t} lapInvalid={lapInvalid} /> : null}
        {rightExtra}
      </div>

      {showRadar !== false ? <BlocksRadar t={t} /> : null}

      {/* Bottom-left: the lap timing and the lap history (the steering pad's place with the touch controls up) */}
      {touch ? null : (
        <div
          data-hud-floor
          data-hud-avoid
          className="absolute hidden flex-col items-start gap-6 md:flex"
          style={{ bottom: EDGE, left: EDGE, ...anchor(scale, "bottom left") }}
        >
          <Timing t={t} lapInvalid={lapInvalid} />
          {laps.length > 0 ? (
            <div className="hidden xl:block">
              <LapHistory t={t} laps={laps} />
            </div>
          ) : null}
        </div>
      )}

      {/* Bottom-centre: rpm bar, speed, gear, rpm; with the touch controls up, above the steering pad until the screen
          is wide enough for the two to sit side by side */}
      <div
        data-hud-avoid
        className={`absolute left-1/2 -translate-x-1/2 ${touch ? "bottom-[176px] min-[1180px]:bottom-[clamp(14px,2.2vw,24px)]" : "bottom-[clamp(14px,2.2vw,24px)]"}`}
      >
        <div style={anchor(scale, "bottom center")}>
          <Essentials t={t} revRange={revRange} />
        </div>
      </div>

      {/* Bottom-right: the MFD over the inputs, fuel and tyres (the pedals' place with the touch controls up) */}
      {touch ? null : (
        <div data-hud-avoid className="absolute flex flex-col items-end gap-3" style={{ bottom: EDGE, right: EDGE, ...anchor(scale, "bottom right") }}>
          {mfd ? <div className="hidden lg:block">{mfd}</div> : null}
          <div className="hidden items-end gap-3 lg:flex">
            <Inputs t={t} ffb={Boolean(ffb)} />
            {hasFuel ? (
              <div className="hidden xl:block">
                <Fuel t={t} />
              </div>
            ) : null}
            <div className="hidden 2xl:block">
              <Tyres t={t} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
