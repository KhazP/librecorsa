"use client";

import React, { useMemo, useSyncExternalStore } from "react";
import { useTranslations } from "use-intl/react";
import type { CarTelemetry, LiveTunerState, TireCompound } from "@/types/f1";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import { getActivePointToPoint } from "@/lib/track-data";
import { useUiZoom } from "@/lib/ui-zoom";
import { useUnits } from "@/lib/settings/ui-prefs";
import { temperatureIn } from "@/lib/settings/units";
import { Icon } from "@/components/ui/icons/Icon";
import { Trend } from "@/components/ui/icons/Trend";
import { CompoundGlyph } from "@/components/ui/badges/CompoundBadge";
import { COMPOUNDS } from "@/components/ui/badges/compounds";
import {
  HUD_BRAKE,
  HUD_CAUTION,
  HUD_INFO,
  HUD_LOSS,
  HUD_SHIFT,
  HUD_THROTTLE,
  LAP_MARK_COLOR,
  aidsActive,
  atShiftPoint,
  brakeGlowColor,
  formatDeltaFit,
  formatGap,
  formatLapClock,
  formatLapTime,
  formatPressurePsi,
  formatSectorTime,
  formatSpeed,
  formatTemp,
  lapClockMs,
  lapMark,
  pressureUnit,
  sectorDone,
  sessionWord,
  speedUnit,
  tyreHeatColor,
} from "../hud-format";
import { aeroReadout } from "../aero-label";
import { ersButtons } from "../ers-buttons";
import { pedalLayers } from "../PedalBars";
import {
  SURFACE_WORD,
  dayClock,
  driverLabel,
  formatClock,
  fuelLapsLeft,
  predictedLapMs,
  relativeCars,
  sessionBestLapMs,
  trackSurfaceState,
} from "../third-party-data";
import { useFuelPerLap, useSessionClock } from "./third-party-parts";
import { arcPath, onFinalLap, useErsState, type ErsState } from "./game-style-parts";
import { TracksideRadar } from "./TracksideRadar";
import { LapMarkGlyph, MiniMap, anchor, formatOnce, gearLabel, type HudDesignProps, type HudStyleOptions } from "./hud-style-parts";
import { onUiViewportChange, uiViewportWidth } from "@/lib/display/ui-frame";

/**
 * Trackside: almost no panels. The readouts sit on the scene in the four corners, with a 12-degree slanted tag only
 * where a surface is needed. Top left the position, the lap clock and the live delta, best / last / predicted and a
 * sector strip, the bare circuit line under them; top centre a thin session strip; top right track limits and the
 * weather; bottom left the cars round the player on the road; bottom centre the radar; bottom right the tyres, the
 * fuel and an open 270-degree rev dial with the battery as its inner arc, the electronics under it.
 */
export const TRACKSIDE_STYLE: HudStyleOptions = {
  // The radar: 150 px above the edge
  bottomClearance: 184,
  ownsBottomLeft: true,
  mfdFolded: true,
  // The session strip: 32 px and a gap
  topClearance: 42,
  // The session strip hides while the lights are up
  topClearanceInLights: 0,
  ownDeltaBar: true,
  ownRadar: true,
};

const EDGE = "clamp(14px,2.2cqw,24px)";

/** Bare type over the scene: a tight dark edge and a soft halo, no blur of the scene itself */
const SH = "[text-shadow:0_0_2px_rgb(0_0_0/0.9),0_1px_2px_rgb(0_0_0/0.95),0_0_10px_rgb(0_0_0/0.75)]";
/** Ink on a light plate takes no shadow */
const NO_SH = "[text-shadow:none]";
/**
 * A soft scrim behind a corner group: an ellipse centred just outside the group's own corner, so against the screen's
 * corner only a quarter of it shows, and a group the player has moved fades out on every side. It moves and scales
 * with the group. Each class is written out in full: Tailwind reads class names from the source text.
 */
const SCRIM = "isolate before:pointer-events-none before:absolute before:-z-10 before:content-['']";
const SCRIM_TL = `${SCRIM} before:-top-[340px] before:-left-[800px] before:h-[600px] before:w-[1520px] before:bg-[radial-gradient(ellipse_closest-side,color-mix(in_srgb,var(--color-lc-void)_58%,transparent),transparent_70%)]`;
const SCRIM_TR = `${SCRIM} before:-top-[260px] before:-right-[660px] before:h-[440px] before:w-[1240px] before:bg-[radial-gradient(ellipse_closest-side,color-mix(in_srgb,var(--color-lc-void)_58%,transparent),transparent_70%)]`;
const SCRIM_BL = `${SCRIM} before:-bottom-[420px] before:-left-[740px] before:h-[760px] before:w-[1400px] before:bg-[radial-gradient(ellipse_closest-side,color-mix(in_srgb,var(--color-lc-void)_58%,transparent),transparent_70%)]`;
const SCRIM_BR = `${SCRIM} before:-right-[940px] before:-bottom-[500px] before:h-[920px] before:w-[1800px] before:bg-[radial-gradient(ellipse_closest-side,color-mix(in_srgb,var(--color-lc-void)_58%,transparent),transparent_70%)]`;

/** The dials of the live tuner (TunerMfdPanel) stop here on every car: TC and ABS at 12, the engine map at 5 */
const TC_STEPS = 12;
const ABS_STEPS = 12;
const ENGINE_MAPS = 5;

type Words = ReturnType<typeof useTracksideWords>;

function useTracksideWords() {
  const tx = useTranslations("hudStyles.trackside");
  const txRadar = useTranslations("hud.proximityRadar");
  return useMemo(
    () => ({
      radarClose: formatOnce((count: number, side: "both" | "left" | "right" | "none") => txRadar("carsClose", { count, side })),
      radarClear: txRadar("clear"),
      timing: tx("timing"),
      positionOf: formatOnce((position: number, total: number) => tx("positionOf", { position, total })),
      best: tx("best"),
      last: tx("last"),
      predicted: tx("predicted"),
      invalid: tx("invalid"),
      sessionBest: tx("sessionBest"),
      sector: [tx("sector", { sector: 1 }), tx("sector", { sector: 2 }), tx("sector", { sector: 3 })] as const,
      session: tx("session"),
      race: tx("race"),
      lap: formatOnce((lap: number) => tx("lap", { lap })),
      lapOf: formatOnce((lap: number, total: number) => tx("lapOf", { lap, total })),
      run: formatOnce((lap: number) => tx("run", { lap })),
      outLap: tx("outLap"),
      green: tx("green"),
      yellow: tx("yellow"),
      doubleYellow: tx("doubleYellow"),
      vsc: tx("vsc"),
      vscEnding: tx("vscEnding"),
      finalLap: tx("finalLap"),
      finished: tx("finished"),
      conditions: tx("conditions"),
      trackLimits: tx("trackLimits"),
      strikes: formatOnce((count: number, total: number) => tx("strikes", { count, total })),
      penalty: formatOnce((seconds: number) => tx("penalty", { seconds })),
      air: tx("air"),
      track: tx("track"),
      rain: tx("rain"),
      heavyRain: tx("heavyRain"),
      headlights: tx("headlights"),
      circuit: tx("circuit"),
      relative: tx("relative"),
      gapToYou: tx("gapToYou"),
      yourWay: tx("yourWay"),
      against: tx("against"),
      steady: tx("steady"),
      lapsUp: formatOnce((laps: number) => tx("lapsUp", { laps })),
      lapsDown: formatOnce((laps: number) => tx("lapsDown", { laps })),
      tyres: tx("tyres"),
      treadLeft: formatOnce((pct: number) => tx("treadLeft", { pct })),
      puncture: tx("puncture"),
      fuel: tx("fuel"),
      fuelLaps: formatOnce((laps: string) => tx("fuelLaps", { laps })),
      fuelMargin: tx("fuelMargin"),
      dial: tx("dial"),
      rpm: tx("rpm"),
      battery: formatOnce((pct: number) => tx("battery", { pct })),
      boost: tx("boost"),
      lowGrip: tx("lowGrip"),
      overtakeOn: tx("overtakeOn"),
      overtakeReady: tx("overtakeReady"),
      overtakeLocked: tx("overtakeLocked"),
      ers: {
        deploy: tx("ers.deploy"),
        clipped: tx("ers.clipped"),
        superclip: tx("ers.superclip"),
        braking: tx("ers.braking"),
        liftCoast: tx("ers.liftCoast"),
        trickle: tx("ers.trickle"),
      } satisfies Partial<Record<ErsState, string>>,
      electronics: tx("electronics"),
      tc: tx("tc"),
      abs: tx("abs"),
      map: tx("map"),
      bias: tx("bias"),
      off: tx("off"),
      tcTitle: tx("tcTitle"),
      absTitle: tx("absTitle"),
      mapTitle: tx("mapTitle"),
      biasTitle: tx("biasTitle"),
    }),
    [tx, txRadar],
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The window: this layout is drawn for a 1600 x 900 canvas or more, and steps down a little on a smaller one          */
/* ------------------------------------------------------------------------------------------------------------------ */

// The window, or the centre screen of three
const subscribeView = onUiViewportChange;
/** Width and height in one number, so a resize re-renders once */
const viewKey = () => Math.round(uiViewportWidth()) * 100_000 + window.innerHeight;
const serverViewKey = () => 1920 * 100_000 + 1080;

/**
 * How the layout fits the window: `fit` shrinks every group on a window under 1600 x 900 (to 0.8 at 1280 x 720), and
 * `wide` says the bottom edge has room for the tyres beside the fuel (else they stack), `narrow` that the top edge has
 * no room for the delta beside the clock (a large HUD size on a small window). The HUD keeps to a 2.4:1 frame.
 */
function useWindowFit(scale: number): { fit: number; wide: boolean; narrow: boolean } {
  const key = useSyncExternalStore(subscribeView, viewKey, serverViewKey);
  const zoom = useUiZoom();
  const vh = key % 100_000;
  const frameW = Math.min(Math.floor(key / 100_000), vh * 2.4);
  const fit = Math.round(Math.max(0.8, Math.min(1, frameW / zoom / 1600, vh / zoom / 900)) * 100) / 100;
  const canvasW = frameW / (scale * fit);
  return { fit, wide: canvasW >= 1800, narrow: canvasW < 1500 };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The slanted tag                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

const TAG_TONE = {
  chalk: `bg-lc-chalk text-lc-void ${NO_SH}`,
  dark: "bg-lc-void/86 text-lc-chalk",
  gain: `bg-lc-gain text-lc-void ${NO_SH}`,
  loss: `bg-lc-loss text-lc-void ${NO_SH}`,
  info: `bg-lc-info text-lc-void ${NO_SH}`,
  infoLine: "bg-lc-void/86 text-lc-info",
  dim: "bg-lc-void/86 text-lc-slate",
} as const;

/** A 12-degree slanted plate with upright tracked caps on it: the one surface this layout has */
const Tag: React.FC<{ tone?: keyof typeof TAG_TONE; className?: string; title?: string; children: React.ReactNode }> = ({
  tone = "dark",
  className = "",
  title,
  children,
}) => (
  <span title={title} className={`inline-block shrink-0 -skew-x-12 px-[9px] py-1 leading-none ${TAG_TONE[tone]} ${className}`}>
    <span className="lc-data inline-flex skew-x-12 items-center gap-1 text-[11px] font-extrabold tracking-[0.12em] whitespace-nowrap uppercase">{children}</span>
  </span>
);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top left: position, lap clock and delta; best, last and predicted; the sector strip                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A coloured time is small type in a hue over the scene: it sits on the dark plate, joined to its tag. A chalk one is bare */
const ON_PLATE = "-ml-2.5 -skew-x-12 bg-lc-void/86 px-2 py-[3px]";

const Timing: React.FC<{ t: CarTelemetry; deltaS: number | null; lapInvalid: boolean; showDelta: boolean; narrow: boolean; w: Words }> = ({
  t,
  deltaS,
  lapInvalid,
  showDelta,
  narrow,
  w,
}) => {
  const race = t.race;
  const sessionBest = sessionBestLapMs(t);
  const bestIsSession = t.bestLapTimeMs !== null && sessionBest !== null && t.bestLapTimeMs <= sessionBest + 0.5;
  const predicted = predictedLapMs(t.bestLapTimeMs, deltaS);
  // The running sector's clock: the lap's time less the sectors already done
  let doneMs = 0;
  for (let i = 0; i < 3; i++) if (sectorDone(t, i)) doneMs += t.sectorTimesMs[i];
  const runningMs = Math.max(0, lapClockMs(t) - doneMs);

  return (
    <section aria-label={w.timing} className="flex flex-col items-start">
      <div className="flex items-center">
        {race ? (
          <>
            <span
              aria-label={w.positionOf(race.position, race.fieldSize)}
              className={`ml-1.5 grid h-[62px] w-[84px] -skew-x-12 place-items-center bg-lc-volt text-lc-void ${NO_SH}`}
            >
              <b className="lc-disp skew-x-12 text-[50px] leading-none">{race.position}</b>
            </span>
            <span aria-hidden className="lc-data mr-[30px] ml-2.5 text-[22px] font-semibold text-lc-fog">
              / {race.fieldSize}
            </span>
          </>
        ) : null}
        <span className={`lc-data text-[54px] leading-none font-semibold tracking-[-0.03em] whitespace-nowrap ${race ? "" : "ml-1"} ${lapInvalid ? "text-lc-loss" : "text-lc-chalk"}`}>
          {formatLapClock(t)}
        </span>
        {lapInvalid ? (
          <span className={`ml-[18px] -skew-x-12 bg-lc-loss px-[13px] py-[7px] leading-none text-lc-void ${NO_SH}`}>
            <span className="lc-data inline-flex skew-x-12 items-center gap-1.5 text-[15px] font-extrabold tracking-[0.1em] uppercase">
              <Icon name="trackLimits" size="xs" className="size-4" />
              {w.invalid}
            </span>
          </span>
        ) : showDelta && deltaS !== null && !narrow ? (
          <span className={`ml-[18px] -skew-x-12 px-[13px] py-[7px] leading-none text-lc-void ${NO_SH} ${deltaS <= 0 ? "bg-lc-gain" : "bg-lc-loss"}`}>
            <span className="lc-data inline-block skew-x-12 text-[22px] font-extrabold whitespace-nowrap">{formatDeltaFit(deltaS)}</span>
          </span>
        ) : null}
      </div>

      <div className="mt-3.5 ml-2 flex items-center gap-2.5">
        <Tag tone="chalk">{w.best}</Tag>
        <span className={`mr-4 leading-none ${t.bestLapTimeMs && bestIsSession ? ON_PLATE : ""}`}>
          <span
            className={`lc-data inline-flex items-center gap-1 text-[19px] leading-none font-semibold ${t.bestLapTimeMs && bestIsSession ? "skew-x-12 text-lc-best" : "text-lc-chalk"}`}
          >
            {formatLapTime(t.bestLapTimeMs)}
            {t.bestLapTimeMs && bestIsSession ? <Trend direction="up" size={10} label={w.sessionBest} /> : null}
          </span>
        </span>
        <Tag>{w.last}</Tag>
        <span className={`mr-4 leading-none ${t.lastLapValid === false ? ON_PLATE : ""}`}>
          <span className={`lc-data inline-block text-[19px] leading-none font-semibold ${t.lastLapValid === false ? "skew-x-12 text-lc-loss" : "text-lc-chalk"}`}>
            {formatLapTime(t.lastLapTimeMs)}
          </span>
        </span>
        {narrow && showDelta && deltaS !== null && !lapInvalid ? (
          // No room beside the clock: the delta takes the predicted lap's place
          <span className={`-skew-x-12 px-2.5 py-1 leading-none text-lc-void ${NO_SH} ${deltaS <= 0 ? "bg-lc-gain" : "bg-lc-loss"}`}>
            <span className="lc-data inline-block skew-x-12 text-[19px] font-extrabold whitespace-nowrap">{formatDeltaFit(deltaS)}</span>
          </span>
        ) : predicted !== null && deltaS !== null ? (
          <>
            <Tag>{w.predicted}</Tag>
            <span className={`leading-none ${ON_PLATE}`}>
              <span className={`lc-data inline-flex skew-x-12 items-center gap-1 text-[19px] leading-none font-semibold ${deltaS <= 0 ? "text-lc-gain" : "text-lc-loss"}`}>
                {formatLapTime(predicted)}
                <Trend direction={deltaS <= 0 ? "up" : "down"} size={10} />
              </span>
            </span>
          </>
        ) : null}
      </div>

      <div className="mt-3.5 ml-1 flex gap-1">
        {[0, 1, 2].map((i) => {
          const done = sectorDone(t, i);
          const mark = done ? lapMark(t.sectorTimesMs[i], t.bestSectorTimesMs[i], !race) : null;
          const active = !t.outLap && i + 1 === t.currentSector;
          const best = t.bestSectorTimesMs[i];
          // The running sector fills towards the driver's best for it
          const fill = active && best ? Math.min(1, runningMs / best) : 0;
          return (
            <div key={i} className="w-[150px] -skew-x-12 bg-lc-void/82">
              <span aria-hidden className="relative block h-[5px] overflow-hidden bg-lc-titanium" style={mark ? { backgroundColor: LAP_MARK_COLOR[mark] } : undefined}>
                {active ? <span className="absolute inset-0 origin-left bg-lc-chalk" style={{ transform: `scaleX(${fill.toFixed(3)})` }} /> : null}
              </span>
              <p
                className={`lc-data flex skew-x-12 items-baseline gap-[9px] px-3 pt-1.5 pb-[7px] text-[15px] leading-none ${done || active ? "text-lc-chalk" : "text-lc-slate"}`}
                style={mark ? { color: LAP_MARK_COLOR[mark] } : undefined}
              >
                <span className="text-[11px] tracking-[0.14em]">{w.sector[i]}</span>
                {done ? formatSectorTime(t.sectorTimesMs[i]) : active && runningMs > 0 ? formatSectorTime(runningMs) : null}
                {mark ? <LapMarkGlyph mark={mark} className="self-center text-[11px]" /> : null}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top centre: the session strip                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

const SessionStrip: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const race = t.race;
  const onTrackS = useSessionClock();
  // Qualifying counts its clock down; everything else counts the time on track up
  const clock = formatClock(t.qualifying ? t.qualifying.remainingS : onTrackS);
  let flag: string | null = null;
  let tone = "text-lc-gain";
  let rule = "bg-lc-gain";
  if (race) {
    if (race.phase === "finished") {
      flag = w.finished;
      tone = "text-lc-chalk";
      rule = "bg-lc-chalk";
    } else if (race.vsc) {
      flag = race.vsc.phase === "ending" ? w.vscEnding : w.vsc;
      tone = "text-lc-caution";
      rule = "bg-lc-caution";
    } else if (race.yellow) {
      flag = race.doubleYellow ? w.doubleYellow : w.yellow;
      tone = "text-lc-caution";
      rule = "bg-lc-caution";
    } else if (onFinalLap(t)) {
      flag = w.finalLap;
      tone = "text-lc-chalk";
      rule = "bg-lc-chalk";
    } else {
      flag = w.green;
    }
  } else {
    rule = "bg-lc-slate";
  }
  const lapNo = Math.max(1, t.lapCount);
  const lap = race
    ? race.totalLaps
      ? w.lapOf(race.lap, race.totalLaps)
      : w.lap(race.lap)
    : t.outLap
      ? w.outLap
      : getActivePointToPoint()
        ? w.run(lapNo)
        : w.lap(lapNo);
  return (
    <section aria-label={w.session} className="lc-data flex h-8 items-center gap-3.5 bg-lc-void/82 px-[18px] text-[15px] whitespace-nowrap text-lc-chalk">
      <span>{clock}</span>
      <i aria-hidden className={`block h-[18px] w-[5px] -skew-x-12 ${rule}`} />
      <b className="lc-disp text-[16px] leading-none tracking-[0.04em]">{race ? w.race : sessionWord(t)}</b>
      {flag ? (
        <span className={`inline-flex items-center gap-1 text-[11px] font-extrabold tracking-[0.14em] uppercase ${tone}`}>
          {race?.phase === "finished" || onFinalLap(t) ? <Icon name="chequered" size="xs" className="size-3.5" /> : null}
          {flag}
        </span>
      ) : null}
      <i aria-hidden className={`block h-[18px] w-[5px] -skew-x-12 ${rule}`} />
      <span className="uppercase">{lap}</span>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Top right: track limits and the weather                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** More strikes than this per penalty are counted in figures only */
const PIPS_MAX = 6;

const Conditions: React.FC<{ t: CarTelemetry; weather: WeatherHudState | null | undefined; w: Words }> = ({ t, weather, w }) => {
  const units = useUnits();
  const limits = t.trackLimits && t.trackLimits.strikesPerPenalty > 0 ? t.trackLimits : null;
  if (!limits && !weather) return null;
  return (
    <section aria-label={w.conditions} className="flex flex-col items-end gap-[11px]">
      {limits ? (
        <div className="flex items-center gap-2.5" aria-label={`${w.trackLimits}: ${w.strikes(limits.warnings, limits.strikesPerPenalty)}`}>
          <Tag>{w.trackLimits}</Tag>
          <span aria-hidden className={`lc-data text-[18px] leading-none font-semibold ${limits.warnings > 0 ? "text-lc-chalk" : "text-lc-fog"}`}>
            {limits.warnings} / {limits.strikesPerPenalty}
          </span>
          {limits.strikesPerPenalty <= PIPS_MAX ? (
            <span aria-hidden className="flex gap-1">
              {Array.from({ length: limits.strikesPerPenalty }, (_, i) => (
                <i
                  key={i}
                  className={`block size-3 -skew-x-12 border-[1.5px] ${i < limits.warnings ? "border-lc-caution bg-lc-caution" : "border-lc-fog bg-lc-void/80"}`}
                />
              ))}
            </span>
          ) : null}
          {limits.penaltyS > 0 ? <Tag tone="loss">{w.penalty(limits.penaltyS)}</Tag> : null}
        </div>
      ) : null}
      {weather ? (
        <div className="flex items-center gap-2.5">
          {weather.timeMoving ? <span className="lc-data text-[15px] leading-none font-semibold text-lc-chalk">{dayClock(weather.clockH)}</span> : null}
          {weather.headlightsOn || weather.headlightFlash ? (
            <Tag title={w.headlights}>
              <span className="inline-flex text-lc-gain">
                <Icon name="headlights" size="xs" label={w.headlights} className="size-3" />
              </span>
            </Tag>
          ) : null}
          {weather.rain > 0.05 ? (
            <Tag tone={weather.rain > 0.5 ? "info" : "infoLine"}>
              <Icon name={weather.rain > 0.5 ? "weatherStorm" : "weatherRain"} size="xs" className="size-3" />
              {weather.rain > 0.5 ? w.heavyRain : w.rain}
            </Tag>
          ) : null}
          <Tag>{SURFACE_WORD[trackSurfaceState(weather.waterMm)]}</Tag>
          <span className="lc-data inline-flex items-baseline text-[18px] leading-none font-semibold text-lc-chalk">
            {formatTemp(weather.airC, units)}
            <small className="mr-3 ml-[5px] text-[11px] font-bold tracking-[0.18em] text-lc-fog uppercase">{w.air}</small>
            {formatTemp(weather.trackC, units)}
            <small className="ml-[5px] text-[11px] font-bold tracking-[0.18em] text-lc-fog uppercase">{w.track}</small>
          </span>
        </div>
      ) : null}
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom left: the cars round the player on the road                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A gap change smaller than this reads as steady (s), as the split gaps have it */
const STEADY_S = 0.05;

const Relative: React.FC<{ t: CarTelemetry; lengthM: number; w: Words }> = ({ t, lengthM, w }) => {
  const race = t.race;
  if (!race) return null;
  const cars = relativeCars(t, lengthM, 3);
  if (cars.length < 2) return null;
  const splits = race.splits;
  const me = race.standings.find((e) => e.isPlayer);
  const onGrid = race.phase === "lights";
  return (
    <section aria-label={w.relative} className="w-[470px]">
      {cars.map((car) => {
        const e = car.entry;
        const pos = race.standings.indexOf(e) + 1;
        // The cars directly ahead and behind in the order have a measured split and its trend; the rest an estimate
        const split =
          car.lapsAhead !== 0 || e.isPlayer
            ? null
            : splits?.ahead?.driverCode === e.driverCode
              ? { side: "ahead" as const, s: splits.ahead }
              : splits?.behind?.driverCode === e.driverCode
                ? { side: "behind" as const, s: splits.behind }
                : null;
        // On the player's lap the gap is the race's own (the split, else the gaps to the leader), so every readout of
        // it agrees; a car a lap up or down is placed by the road between the two
        const gap = split ? (split.side === "ahead" ? split.s.gapS : -split.s.gapS) : car.lapsAhead === 0 && me ? me.gapToLeaderS - e.gapToLeaderS : car.gapS;
        const change = split?.s.changeS;
        const moving = change !== undefined && Math.abs(change) >= STEADY_S;
        // Ahead: closing is good; behind: pulling away is good
        const good = moving && (split?.side === "ahead" ? (change as number) < 0 : (change as number) > 0);
        return (
          <div
            key={e.driverCode}
            className="mt-[3px] grid h-[34px] grid-cols-[38px_1fr_8px_96px_74px] items-center bg-linear-to-r from-lc-void/88 via-lc-void/75 via-78% to-lc-void/0"
          >
            <span className={`ml-[3px] grid size-[34px] -skew-x-12 place-items-center text-lc-void ${NO_SH} ${e.isPlayer ? "bg-lc-volt" : "bg-lc-chalk"}`}>
              <b className="lc-data skew-x-12 text-[16px] font-extrabold">{pos > 0 ? pos : ""}</b>
            </span>
            <span className={`truncate pl-3 text-[17px] leading-none font-semibold ${e.isPlayer ? "text-lc-volt" : "text-lc-chalk"}`}>{driverLabel(e)}</span>
            <span aria-hidden className="h-6" style={{ backgroundColor: e.teamColorHex }} />
            <span className="lc-data text-right text-[17px] leading-none text-lc-chalk" title={e.isPlayer ? undefined : w.gapToYou}>
              {e.isPlayer || onGrid ? null : `${gap >= 0 ? "+" : "−"}${formatGap(gap, true)}`}
            </span>
            <span className={`lc-data flex items-center justify-end gap-[5px] text-[14px] leading-none ${moving ? (good ? "text-lc-gain" : "text-lc-loss") : "text-lc-slate"}`}>
              {car.lapsAhead !== 0 ? (
                <span className="text-lc-info">{car.lapsAhead > 0 ? w.lapsUp(car.lapsAhead) : w.lapsDown(-car.lapsAhead)}</span>
              ) : change !== undefined && !onGrid ? (
                <>
                  <Trend direction={moving ? (good ? "up" : "down") : "level"} size={10} label={moving ? (good ? w.yourWay : w.against) : w.steady} />
                  {Math.abs(change).toFixed(2)}
                </>
              ) : null}
            </span>
          </div>
        );
      })}
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Bottom right: tyres, fuel, the rev dial and the electronics                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Where each tyre block, its pressure, brake disc and brake temperature sit in the 228 x 196 box (FL, FR, RL, RR) */
const TYRE_AT: readonly { side: "left" | "right"; top: number; psiTop: number }[] = [
  { side: "left", top: 22, psiTop: 0 },
  { side: "right", top: 22, psiTop: 0 },
  { side: "left", top: 112, psiTop: 179 },
  { side: "right", top: 112, psiTop: 179 },
];

const Tyres: React.FC<{ t: CarTelemetry; compound: TireCompound; w: Words }> = ({ t, compound, w }) => {
  const units = useUnits();
  const damage = t.race?.damage ?? t.practiceDamage;
  const window = t.tireOptimalTempC ?? ([85, 105] as const);
  const tread = Math.round(Math.max(0, 100 - Math.max(...t.tireWearPct)));
  const psiUnit = pressureUnit(units);
  return (
    <section aria-label={w.tyres} className="relative h-[196px] w-[228px]">
      {TYRE_AT.map((at, i) => {
        const temp = t.tireTempsC[i];
        // The damage lists its corners FR, FL, RR, RL; the tyres go FL, FR, RL, RR
        const punctured = Boolean(damage?.punctured[i ^ 1]);
        // Block colour is the tread temperature against the compound's window; the ink follows the block
        const lightInk = punctured || temp > window[1] + 15 || temp < window[0] - 25;
        const psi = t.tirePressuresPsi?.[i];
        return (
          <React.Fragment key={i}>
            {psi !== undefined ? (
              <span className="lc-data absolute w-[74px] text-center text-[14px] leading-none text-lc-chalk" style={{ [at.side]: 8, top: at.psiTop }}>
                {formatPressurePsi(psi, units)}
                <small className="ml-0.5 text-[10px] text-lc-fog uppercase">{psiUnit}</small>
              </span>
            ) : null}
            <span
              title={punctured ? w.puncture : undefined}
              className={`lc-data absolute grid h-[62px] w-[38px] place-items-center text-[14px] font-extrabold shadow-[0_2px_6px_rgb(0_0_0/0.7)] ${lightInk ? "text-lc-chalk" : `text-lc-void ${NO_SH}`}`}
              style={{ [at.side]: 26, top: at.top, backgroundColor: punctured ? HUD_LOSS : tyreHeatColor(temp, window) }}
            >
              {punctured ? <Icon name="warning" size="xs" label={w.puncture} className="size-4" /> : Math.round(temperatureIn(temp, units.temperature))}
            </span>
            <i
              aria-hidden
              className="absolute block h-10 w-1.5 shadow-[0_1px_4px_rgb(0_0_0/0.7)]"
              style={{ [at.side]: 72, top: at.top + 11, backgroundColor: brakeGlowColor(t.brakeTempsC[i]) }}
            />
            <span className="lc-data absolute text-[11px] leading-none text-lc-fog" style={{ [at.side]: 83, top: at.top + 22 }}>
              {Math.round(temperatureIn(t.brakeTempsC[i], units.temperature))}
            </span>
          </React.Fragment>
        );
      })}
      <div className="lc-data absolute inset-x-0 top-[86px] flex items-center justify-center gap-[7px] text-[12px] leading-none font-extrabold tracking-[0.1em] text-lc-chalk uppercase">
        <CompoundGlyph compound={compound} size={18} decorative />
        {COMPOUNDS[compound].name}
        <span className="tracking-[0.04em] text-lc-fog" title={w.treadLeft(tread)}>
          {tread}%
        </span>
      </div>
    </section>
  );
};

const Fuel: React.FC<{ t: CarTelemetry; w: Words }> = ({ t, w }) => {
  const perLap = useFuelPerLap();
  if (!(t.fuelKg > 0.01)) return null;
  const laps = fuelLapsLeft(t.fuelKg, perLap);
  const race = t.race;
  // Laps of fuel over what the race still asks for (− = short), once a lap's use has been measured
  const toRun = race?.totalLaps && race.phase === "racing" ? Math.max(0, race.totalLaps - (race.lap - 1 + t.trackProgress)) : null;
  const margin = laps !== null && toRun !== null ? laps - toRun : null;
  return (
    <section aria-label={w.fuel} className="flex flex-col items-end text-right">
      <Tag>{w.fuel}</Tag>
      <span className="lc-data mt-2 block text-[26px] leading-none font-semibold text-lc-chalk">
        {t.fuelKg.toFixed(1)}
        <small className="ml-1 text-[12px] font-semibold text-lc-fog uppercase">kg</small>
      </span>
      {laps !== null ? (
        <span className="lc-data mt-1.5 text-[17px] leading-none font-semibold whitespace-nowrap text-lc-chalk">
          {w.fuelLaps(laps.toFixed(1))}
          {margin !== null ? (
            <span className={`ml-2 ${margin >= 0 ? "text-lc-gain" : "text-lc-loss"}`} title={w.fuelMargin}>
              {margin >= 0 ? "+" : "−"}
              {Math.abs(margin).toFixed(1)}
            </span>
          ) : null}
        </span>
      ) : null}
    </section>
  );
};

/* The dial: 270 degrees, open at the bottom; the revs outside, the battery inside */
const DIAL = 320;
const DIAL_C = DIAL / 2;
const REV_R = 140;
const ERS_R = 122;
/** The shift point sits here on the dial; past it the scale is the red zone */
const SHIFT_AT = 0.9;
const REV_ARC = arcPath(DIAL_C, DIAL_C, REV_R, -135, 135);
const RED_ARC = arcPath(DIAL_C, DIAL_C, REV_R, -135 + 270 * SHIFT_AT, 135);
const ERS_ARC = arcPath(DIAL_C, DIAL_C, ERS_R, -135, 135);

/** "11 480": the thousands set apart, as a rev counter reads */
const rpmText = (rpm: number): string => {
  const r = Math.max(0, Math.round(rpm));
  return r >= 1000 ? `${Math.floor(r / 1000)} ${String(r % 1000).padStart(3, "0")}` : String(r);
};

/** What the hybrid is doing, in one short line under the battery's charge: the driver's own extra power first */
function ersLine(t: CarTelemetry, state: ErsState, w: Words): { text: string; tone: string } | null {
  const ctl = ersButtons(t);
  if (ctl.overtake === "on" || ctl.overtake === "auto") return { text: w.overtakeOn, tone: "text-lc-info" };
  if (ctl.boostOn) return { text: w.boost, tone: "text-lc-info" };
  if (ctl.lowGrip) return { text: w.lowGrip, tone: "text-lc-fog" };
  if (state === "deploy") return { text: w.ers.deploy, tone: "text-lc-info" };
  if (state === "clipped") return { text: w.ers.clipped, tone: "text-lc-caution" };
  if (state === "superclip" || state === "braking" || state === "liftCoast" || state === "trickle") return { text: w.ers[state], tone: "text-lc-gain" };
  if (ctl.overtake === "available") return { text: w.overtakeReady, tone: "text-lc-info" };
  if (ctl.overtake === "locked" || ctl.boostLocked) return { text: w.overtakeLocked, tone: "text-lc-fog" };
  return null;
}

const Dial: React.FC<{ t: CarTelemetry; revRange: [number, number]; w: Words }> = ({ t, revRange, w }) => {
  const units = useUnits();
  const revFull = revRange[1];
  const shift = atShiftPoint(t.rpm, revFull);
  const revPct = Math.min(100, Math.max(0, (t.rpm / Math.max(1, revFull)) * SHIFT_AT * 100));
  // A car that does not report its channels is taken to have both, as the shared speed cluster does
  const hasErs = t.f12026?.hasErs ?? true;
  const state = useErsState(t);
  const soc = Math.min(100, Math.max(0, t.ersBatteryPercent));
  const socColor = soc < 10 ? HUD_LOSS : soc < 20 ? HUD_CAUTION : HUD_INFO;
  const line = hasErs ? ersLine(t, state, w) : null;
  const aero = aeroReadout(t);
  const showAero = (t.f12026?.hasDrs ?? true) && t.overtakingRules !== "none";
  const pedals = pedalLayers(t);
  return (
    <section aria-label={w.dial} data-hud-avoid className="relative size-[320px]">
      <svg viewBox={`0 0 ${DIAL} ${DIAL}`} fill="none" className="absolute inset-0 size-full" aria-hidden>
        <path d={REV_ARC} stroke="var(--color-lc-void)" strokeOpacity={0.72} strokeWidth={16} />
        <path d={REV_ARC} stroke="var(--color-lc-chalk)" strokeOpacity={0.28} strokeWidth={10} />
        <path d={RED_ARC} stroke="var(--color-lc-crimson)" strokeWidth={10} />
        <path d={REV_ARC} stroke={shift ? HUD_SHIFT : "var(--color-lc-chalk)"} strokeWidth={10} pathLength={100} strokeDasharray={`${revPct.toFixed(1)} 100`} />
        {hasErs ? (
          <>
            <path d={ERS_ARC} stroke="var(--color-lc-void)" strokeOpacity={0.6} strokeWidth={5} />
            <path d={ERS_ARC} stroke={socColor} strokeWidth={5} pathLength={100} strokeDasharray={`${soc.toFixed(1)} 100`} />
          </>
        ) : null}
      </svg>

      {hasErs ? (
        <div className="absolute inset-x-0 top-[58px] flex flex-col items-center gap-1.5 text-center leading-none">
          <span className="lc-data text-[14px] leading-none" style={{ color: socColor }}>
            {w.battery(Math.round(soc))}
          </span>
          {line ? <span className={`lc-data text-[11px] leading-none tracking-[0.16em] uppercase ${line.tone}`}>{line.text}</span> : null}
        </div>
      ) : null}

      <div className={`absolute top-[106px] left-[62px] grid h-[122px] w-[104px] -skew-x-12 place-items-center text-lc-void ${NO_SH} ${shift ? "bg-lc-cyan" : "bg-lc-volt"}`}>
        <b className="lc-disp -mt-[3px] skew-x-12 text-[108px] leading-none">{gearLabel(t.gear)}</b>
      </div>

      <div className="absolute top-[114px] left-[180px] flex flex-col">
        <span className="lc-data text-[11px] leading-none font-bold tracking-[0.18em] text-lc-fog uppercase">{speedUnit(units)}</span>
        <span className="lc-data mt-0.5 text-[58px] leading-[0.95] font-semibold tracking-[-0.04em] text-lc-chalk">{formatSpeed(t.speedKmh, units)}</span>
      </div>
      <div className="absolute top-[202px] left-[182px] flex items-baseline gap-1.5">
        <span className="lc-data text-[17px] leading-none font-semibold text-lc-chalk">{rpmText(t.rpm)}</span>
        <span className="lc-data text-[11px] leading-none font-bold tracking-[0.18em] text-lc-fog uppercase">{w.rpm}</span>
      </div>

      {showAero ? (
        <div className="absolute inset-x-0 top-[242px] flex justify-center">
          <Tag tone={aero.open ? "info" : aero.armed || aero.queued ? "infoLine" : "dim"}>{aero.label}</Tag>
        </div>
      ) : null}

      <div aria-hidden className="absolute inset-x-[92px] bottom-7 grid gap-1">
        <i className="relative block h-1.5 -skew-x-12 overflow-hidden bg-lc-void/80">
          <span className="absolute inset-0 origin-left" style={{ backgroundColor: HUD_THROTTLE, transform: `scaleX(${pedals.throttleOut.toFixed(3)})` }} />
        </i>
        <i className="relative block h-1.5 -skew-x-12 overflow-hidden bg-lc-void/80">
          <span className="absolute inset-0 origin-left" style={{ backgroundColor: HUD_BRAKE, transform: `scaleX(${pedals.brakeOut.toFixed(3)})` }} />
        </i>
      </div>
    </section>
  );
};

/** One dial of the electronics: its name, its level and, where the tuner's dial has steps, how many */
const Level: React.FC<{ name: string; title: string; value: string; of?: string; active?: boolean }> = ({ name, title, value, of, active = false }) => (
  <span title={title} className={`flex items-baseline gap-[5px] ${active ? "text-lc-caution" : "text-lc-chalk"}`}>
    <small className={`lc-data text-[11px] font-semibold uppercase ${active ? "" : "text-lc-slate"}`}>{name}</small>
    <span className="lc-data text-[16px] leading-none uppercase">{value}</span>
    {of ? <small className="lc-data text-[11px] font-semibold text-lc-slate">{of}</small> : null}
  </span>
);

const Electronics: React.FC<{ t: CarTelemetry; tuner: LiveTunerState; w: Words }> = ({ t, tuner, w }) => {
  const aids = aidsActive(t);
  const tcOn = tuner.tcLevel > 0;
  const absOn = tuner.absAllowed && tuner.absLevel > 0;
  return (
    <section aria-label={w.electronics} className="h-[34px] w-[320px] -skew-x-12 bg-lc-void/86">
      <div className="flex h-full skew-x-12 items-center justify-around px-1.5">
        <Level name={w.tc} title={w.tcTitle} value={tcOn ? String(tuner.tcLevel) : w.off} of={tcOn ? `/${TC_STEPS}` : undefined} active={aids.tc} />
        <Level name={w.abs} title={w.absTitle} value={absOn ? String(tuner.absLevel) : w.off} of={absOn ? `/${ABS_STEPS}` : undefined} active={aids.abs} />
        <Level name={w.map} title={w.mapTitle} value={String(tuner.engineMap)} of={`/${ENGINE_MAPS}`} />
        <Level name={w.bias} title={w.biasTitle} value={tuner.brakeBiasPct.toFixed(1)} of="%" />
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------------------------ */

export const TracksideHud: React.FC<HudDesignProps> = ({
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
  mapMode,
  leftExtra,
  weather,
  showDeltaBar,
  showRadar,
}) => {
  const w = useTracksideWords();
  const { fit, wide, narrow } = useWindowFit(scale ?? 1);
  const s = (scale ?? 1) * fit;
  const lights = t.race?.phase === "lights";
  const local = mapMode === "local";
  const showRelative = Boolean(t.race && t.race.standings.length > 1);

  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      {/* Top left: timing, the bare circuit line, then the shared extras (split gaps, damage, the lap board) */}
      <div className={`absolute flex flex-col items-start ${SH} ${SCRIM_TL}`} style={{ top: EDGE, left: EDGE, ...anchor(s, "top left") }}>
        <Timing t={t} deltaS={deltaS} lapInvalid={lapInvalid} showDelta={showDeltaBar !== false} narrow={narrow} w={w} />
        <div role="img" aria-label={w.circuit} className="mt-5 -ml-1.5 hidden md:block">
          <MiniMap map={map} t={t} local={local} stroke={20} className={`block h-[184px] ${local ? "w-[184px]" : "w-[270px]"}`} />
        </div>
        {leftExtra ? <div className={`mt-3 flex w-[240px] flex-col gap-2 ${NO_SH}`}>{leftExtra}</div> : null}
      </div>

      {/* Top centre: the session strip (under the virtual mirror when it is up); the start lights take its place */}
      {!lights ? (
        <div className="absolute left-1/2 hidden -translate-x-1/2 lg:block" style={{ top: topInset ?? EDGE, ...anchor(s, "top center") }}>
          <SessionStrip t={t} w={w} />
        </div>
      ) : null}

      {/* Top right: track limits and the weather, the MFD and the engineering channels under them */}
      <div className={`absolute flex flex-col items-end gap-3 ${SH} ${SCRIM_TR}`} style={{ top: EDGE, right: EDGE, ...anchor(s, "top right") }}>
        <Conditions t={t} weather={weather} w={w} />
        {mfd ? <div className={NO_SH}>{mfd}</div> : null}
        {channels ? <div className={NO_SH}>{channels}</div> : null}
      </div>

      {/* Bottom left: the cars round the player on the road */}
      {showRelative || ffb ? (
        <div
          className={`absolute flex flex-col items-start gap-2 ${SH} ${showRelative ? SCRIM_BL : ""}`}
          style={{ bottom: EDGE, left: EDGE, ...anchor(s, "bottom left") }}
        >
          {ffb ? <div className={NO_SH}>{ffb}</div> : null}
          <div className="hidden md:block">
            <Relative t={t} lengthM={map.lengthM} w={w} />
          </div>
        </div>
      ) : null}

      {/* Bottom centre: the radar, only while a car is close */}
      {showRadar !== false && t.radar?.length ? (
        <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: EDGE, ...anchor(s, "bottom center") }}>
          <TracksideRadar blips={t.radar} closeLabel={w.radarClose} clearLabel={w.radarClear} />
        </div>
      ) : null}

      {/* Bottom right: tyres and fuel beside the dial (stacked where the window is narrower), the electronics under it */}
      <div className={`absolute flex items-end ${wide ? "gap-7" : "gap-4"} ${SH} ${SCRIM_BR}`} style={{ bottom: EDGE, right: EDGE, ...anchor(s, "bottom right") }}>
        <div className={`hidden items-end lg:flex ${wide ? "flex-row gap-6" : "flex-col gap-5"}`}>
          <Tyres t={t} compound={compound as TireCompound} w={w} />
          <Fuel t={t} w={w} />
        </div>
        <div className="flex flex-col gap-2">
          <Dial t={t} revRange={revRange} w={w} />
          {t.liveTuner ? <Electronics t={t} tuner={t.liveTuner} w={w} /> : null}
        </div>
      </div>
    </div>
  );
};
