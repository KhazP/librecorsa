"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import type { PreRaceShowUi, ShowGridRow } from "@/lib/render/pre-race-show";
import { WHEEL_DIVE_S } from "@/lib/render/pre-race-show";
import { gridPairs, type ShowScene } from "@/lib/show/show-timeline";
import { hasStandings, showDriver, type ShowContext, type ShowDriver } from "@/lib/show/show-context";
import { getActiveTrackData, TURN_METADATA } from "@/lib/track-data";
import type { TrackInfo } from "@/lib/track-registry";
import { TIME_OF_DAY_LABELS, WEATHER_LABELS } from "@/lib/sim/weather";
import { seriesById } from "@/lib/career/ladder";
import { anyCarById, CAR_CLASSES, type CarId } from "@/lib/cars/car-registry";
import { carTitle, seriesName } from "@/components/career/career-ui";
import { COMPOUNDS, type Compound } from "@/components/ui/badges/compounds";
import { PlayerTag } from "@/components/ui/badges";
import { KeyCap, PadGlyph } from "@/components/ui/prompts";
import { useInputMode } from "@/components/menu/input-mode";
import { useUnits } from "@/lib/settings/ui-prefs";
import { formatLapTime, formatSpeed, formatTemp, speedUnit } from "@/components/hud/hud-format";
import type { WeatherHudState } from "@/components/hud/WeatherBadge";
import type { TireCompound } from "@/types/f1";
import { CircuitStage } from "./CircuitStage";
import { DriverSilhouette, InfoBar, SceneBug, TyreArt, type InfoBarItem } from "./show-parts";

/**
 * The career's pre-race show on screen (render/pre-race-show.ts runs it and films the scenes):
 * 1:1 F1 broadcast opener layout and motion grammar rendered in LibreCorsa's "Racing Line" colour language
 * (`lc-volt`, `lc-void`/`lc-carbon`, `lc-chalk`, Chakra Petch italic display + Geist Mono tabular telemetry).
 */
export const PreRaceShow: React.FC<{
  ui: PreRaceShowUi;
  timeS: () => number;
  /** On a graphic (a press of Space or a pad button) */
  onNext: () => void;
  /** Straight to the start card (two presses) */
  onSkip: () => void;
  onStart: () => void;
  weather: WeatherHudState | null | undefined;
  compound: TireCompound;
  trackInfo: TrackInfo;
}> = ({ ui, timeS, onNext, onSkip, onStart, weather, compound, trackInfo }) => {
  const tx = useTranslations("hud.preRace");
  const input = useInputMode();
  const pad = input.mode === "pad" ? input.family : null;
  const timeline = ui.timeline;
  const scene = timeline && ui.sceneIndex >= 0 ? timeline.scenes[ui.sceneIndex] : null;
  const prevScene = timeline && ui.sceneIndex > 0 ? timeline.scenes[ui.sceneIndex - 1] : null;
  const ctx = ui.context;
  const still = usePrefersReducedMotion();
  if (!timeline || !scene) return null;
  const opaque = scene.id === "title" || scene.id === "circuit";
  const key = `${ui.epoch}-${ui.sceneIndex}`;
  const fromDive = prevScene?.id === "tyres";
  const seamlessOpening = prevScene?.id === "title" && scene.id === "circuit";
  const showCut = !still && ui.sceneIndex > 0 && !fromDive && !seamlessOpening;
  const lightCut = prevScene?.id === "gridPair" && scene.id === "gridPair";

  return (
    <div
      className={`lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-results) overflow-hidden text-lc-chalk select-none ${
        opaque ? "bg-lc-void" : "bg-linear-to-b from-lc-void/50 via-transparent via-45% to-lc-void/84"
      }`}
      role="dialog"
      aria-label={tx("label")}
    >
      {opaque ? <OpeningStage key={ui.epoch} timeS={timeS} still={still} /> : null}
      <div
        key={key}
        className="absolute inset-0 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(4.5rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:pt-6 sm:pr-10 sm:pl-10 short:pt-3 short:pb-[max(3.6rem,env(safe-area-inset-bottom))]"
      >
        {scene.id === "title" ? <TitleCard ctx={ctx} trackInfo={trackInfo} /> : null}
        {scene.id === "circuit" ? <CircuitFacts ctx={ctx} trackInfo={trackInfo} /> : null}
        {scene.id === "aerial" ? <AerialCards ctx={ctx} trackInfo={trackInfo} weather={weather} scene={scene} /> : null}
        {scene.id === "tyres" ? <TyreCards compound={compound} scene={scene} still={still} /> : null}
        {scene.id === "gridIntro" ? <GridIntro ctx={ctx} trackInfo={trackInfo} /> : null}
        {scene.id === "gridPair" ? <GridPair ctx={ctx} grid={ui.grid} pair={ui.pair ?? 0} /> : null}
        {scene.id === "field" ? <FieldCard ctx={ctx} /> : null}
        {scene.id === "car" ? <CarCard ctx={ctx} trackInfo={trackInfo} /> : null}
        {scene.id === "ready" ? <ReadyCard ctx={ctx} trackInfo={trackInfo} kind={ui.kind} compound={compound} onStart={onStart} /> : null}
      </div>

      {/* Emerge from black after wheel dive, or high-speed F1 multi-blade wipe between broadcast scenes */}
      {!still && fromDive ? <div key={`reveal-${key}`} aria-hidden className="lc-show-from-black pointer-events-none fixed inset-0 z-10 bg-lc-void" /> : null}
      {showCut ? <SceneCut key={`cut-${key}`} light={lightCut} /> : null}

      {scene.id !== "ready" ? (
        <div className="absolute right-[max(1rem,env(safe-area-inset-right))] bottom-[max(0.85rem,env(safe-area-inset-bottom))] z-20 flex items-center gap-2 sm:right-10">
          {/* One press: the next graphic. Two quick presses skip the show to its start card, which the doubled key says */}
          <button type="button" onClick={onNext} className={SHOW_BUTTON}>
            {tx("next")}
            <span className="hidden items-center gap-1 sm:inline-flex">
              {pad ? <PadGlyph button="a" family={pad} /> : <KeyCap>{tx("keySpace")}</KeyCap>}
            </span>
          </button>
          <button type="button" onClick={onSkip} title={tx("skipHint")} className={SHOW_BUTTON}>
            {tx("skip")}
            <span className="hidden items-center gap-1 sm:inline-flex" aria-label={tx("skipHint")}>
              {pad ? (
                <>
                  <PadGlyph button="a" family={pad} />
                  <PadGlyph button="a" family={pad} />
                </>
              ) : (
                <>
                  <KeyCap>{tx("keySpace")}</KeyCap>
                  <KeyCap>{tx("keySpace")}</KeyCap>
                </>
              )}
            </span>
          </button>
          <button
            type="button"
            onClick={onStart}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-lc-volt px-3.5 text-[13px] font-bold text-lc-void shadow-lc-pop transition-colors duration-200 ease-lc hover:bg-lc-volt-hi sm:h-9"
          >
            {tx("start")}
            {/* A pad starts from the start card: Enter is the keyboard's way straight in */}
            {pad ? null : (
              <KeyCap tone="ink" className="hidden sm:inline-flex">
                {tx("keyEnter")}
              </KeyCap>
            )}
          </button>
        </div>
      ) : null}
      <ShowProgress timeS={timeS} readyAtS={timeline.readyAtS} hidden={scene.id === "ready"} />
    </div>
  );
};

/** The show's secondary buttons over the picture (Next, Skip) */
const SHOW_BUTTON =
  "inline-flex h-10 items-center gap-2 rounded-full border border-lc-keyline bg-lc-void/85 px-3.5 text-[13px] font-semibold text-lc-fog backdrop-blur-sm transition-colors duration-200 ease-lc hover:border-lc-chalk/40 hover:text-lc-chalk sm:h-9";

/** High-speed F1-style multi-blade diagonal broadcast wipe (volt + chalk + void) */
const SceneCut: React.FC<{ light: boolean }> = ({ light }) => (
  <div aria-hidden className="pointer-events-none fixed inset-0 z-10 overflow-hidden">
    <div className={`${light ? "lc-show-cut-light" : "lc-show-cut"} flex h-full w-full items-stretch justify-center`}>
      {light ? (
        <>
          <span className="h-full w-3 bg-lc-volt sm:w-4" />
          <span className="h-full w-1 bg-lc-chalk/85" />
        </>
      ) : (
        <>
          <span className="h-full w-4 bg-lc-volt sm:w-6" />
          <span className="h-full w-1.5 bg-lc-chalk" />
          <span className="h-full w-[26cqw] max-w-[300px] bg-lc-void/95" />
          <span className="h-full w-2 bg-lc-volt/75" />
        </>
      )}
    </div>
  </div>
);

function usePrefersReducedMotion(): boolean {
  const [still, setStill] = React.useState(false);
  useEffect(() => {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (!mq) return;
    const read = () => setStill(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return still;
}

/** Thin progress rail along the bottom edge */
const ShowProgress: React.FC<{ timeS: () => number; readyAtS: number; hidden: boolean }> = ({ timeS, readyAtS, hidden }) => {
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, timeS() / Math.max(1, readyAtS))})`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [timeS, readyAtS]);
  if (hidden) return null;
  return (
    <div aria-hidden className="absolute inset-x-0 bottom-0 z-20 h-0.5 bg-lc-line/60">
      <div ref={bar} className="h-full origin-left bg-lc-volt" style={{ transform: "scaleX(0)" }} />
    </div>
  );
};

/** Studio void with subtle diagonal broadcast speedlines + 3D holographic circuit stage */
const OpeningStage: React.FC<{ timeS: () => number; still: boolean }> = ({ timeS, still }) => {
  const tx = useTranslations("hud.preRace");
  const track = getActiveTrackData();
  const sectorLabels = useMemo<[string, string, string]>(
    () => [tx("sector", { n: 1 }), tx("sector", { n: 2 }), tx("sector", { n: 3 })],
    [tx]
  );
  return (
    <>
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_55%_42%,var(--color-lc-carbon),var(--color-lc-void)_72%)]"
      />
      <div aria-hidden className="lc-show-stripes pointer-events-none absolute inset-0 opacity-75" />
      <CircuitStage
        samples={track.samples}
        totalLengthM={track.totalLengthM}
        turns={TURN_METADATA}
        closed={!track.pointToPoint}
        sectorLabels={sectorLabels}
        timeS={timeS}
        still={still}
      />
    </>
  );
};

/** The series and the round (or the test day), in the player's language */
function useRoundLine(ctx: ShowContext | null): string | null {
  const tx = useTranslations("hud.preRace");
  const txCareer = useTranslations("menu.career");
  if (!ctx) return null;
  const series = seriesById(ctx.seriesId);
  const round = ctx.test ? tx("testDay") : tx("roundOf", { round: ctx.roundIndex + 1, rounds: ctx.rounds });
  return series ? `${seriesName(series, txCareer)} · ${round}` : round;
}

const placeOf = (t: TrackInfo) => [t.city, t.country].filter(Boolean).join(", ");

/** Scene 1: F1 Grand Prix Title Opener with volt corner-bracket frame and split volt/dark event ribbon */
const TitleCard: React.FC<{ ctx: ShowContext | null; trackInfo: TrackInfo }> = ({ ctx, trackInfo }) => {
  const tx = useTranslations("hud.preRace");
  const txCareer = useTranslations("menu.career");
  const roundLine = useRoundLine(ctx);
  // A test day: "Test day" over its series, then its car at the circuit
  const test = ctx?.test;
  const testSeries = test ? seriesById(ctx.seriesId) : undefined;
  const round = test ? (testSeries ? seriesName(testSeries, txCareer) : null) : roundLine;
  const subtitle = test
    ? `${carTitle(test.car as CarId)} · ${trackInfo.name}`
    : [trackInfo.layout, placeOf(trackInfo)].filter(Boolean).join(" · ");
  return (
    <div className="flex h-full flex-col justify-end pb-[4vh] short:pb-1">
      <div className="max-w-[920px] rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt pt-4 pr-5 sm:pt-5 sm:pr-8 short:pt-2.5">
        <div className="flex items-stretch gap-5 pl-2 sm:gap-7 sm:pl-3">
          <span aria-hidden className="lc-show-rise w-2.5 shrink-0 -skew-x-12 bg-lc-volt sm:w-3.5" />
          <h1 className="lc-show-title-wipe lc-disp min-w-0 pl-1 text-[36px] leading-[0.92] break-words sm:text-[82px] short:text-[34px]">
            {test ? tx("testDay") : trackInfo.name}
          </h1>
        </div>
        <div className="mt-3 flex flex-wrap items-stretch gap-y-1.5 sm:mt-4 short:mt-2">
          {round ? (
            <span
              className="lc-show-wipe lc-mono inline-flex items-center bg-lc-volt px-3.5 py-1.5 text-[12px] font-extrabold tracking-[0.06em] text-lc-void uppercase sm:px-4 sm:text-[14px] short:py-1"
              style={{ animationDelay: "200ms" }}
            >
              {round}
            </span>
          ) : null}
          {subtitle ? (
            <span
              className="lc-show-wipe inline-flex items-center border-y border-r border-lc-chalk/14 bg-lc-carbon/92 px-3.5 py-1.5 text-[13px] font-semibold text-lc-chalk sm:px-4 sm:text-[16px] short:py-1 short:text-[12px]"
              style={{ animationDelay: "320ms" }}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
};

/** Length and rise: in km and m, or miles and feet with miles per hour */
function useDistances() {
  const units = useUnits();
  const format = useFormatter();
  const tx = useTranslations("hud.preRace");
  const imperial = units.speed === "mph";
  return {
    length: (m: number) =>
      imperial
        ? tx("lengthMi", { value: format.number(m / 1609.344, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) })
        : tx("lengthKm", { value: format.number(m / 1000, { maximumFractionDigits: 2, minimumFractionDigits: 2 }) }),
    rise: (m: number) => (imperial ? tx("riseFt", { value: Math.round(m * 3.28084) }) : tx("riseM", { value: Math.round(m) })),
  };
}

function useElevationM(): number {
  return useMemo(() => {
    const samples = getActiveTrackData().samples;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of samples) {
      lo = Math.min(lo, s.position.y);
      hi = Math.max(hi, s.position.y);
    }
    return Number.isFinite(hi - lo) ? hi - lo : 0;
  }, []);
}

/** The race's terms on one line: laps, stops, qualifying (a test day's: its target lap, once known) */
function useTermsLine(ctx: ShowContext | null): string[] {
  const tx = useTranslations("hud.preRace");
  if (!ctx) return [];
  if (ctx.test) return ctx.test.targetMs ? [tx("targetLap", { time: formatLapTime(ctx.test.targetMs) })] : [];
  return [
    tx("laps", { count: ctx.laps }),
    ctx.pitStops > 0 ? tx("stops", { count: ctx.pitStops }) : tx("noStops"),
    ctx.qualifyingMin > 0 ? tx("qualifyingMin", { minutes: ctx.qualifyingMin }) : tx("gridByPace"),
  ];
}

/** Scene 2: F1 Circuit Breakdown Dock alongside the rotating 3D holographic circuit */
const CircuitFacts: React.FC<{ ctx: ShowContext | null; trackInfo: TrackInfo }> = ({ ctx, trackInfo }) => {
  const tx = useTranslations("hud.preRace");
  const d = useDistances();
  const rise = useElevationM();
  const round = useRoundLine(ctx);
  const terms = useTermsLine(ctx);
  const specs = [
    d.length(trackInfo.lengthM),
    tx("turns", { count: trackInfo.turns }),
    rise >= 2 ? d.rise(rise) : null,
    ...terms,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <SceneBug primary={trackInfo.name} accent={round} />
      <section
        className="lc-show-from-left lc-show-stripes w-full max-w-[500px] overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/92 shadow-lc-sheet backdrop-blur-sm short:max-w-[400px]"
        style={{ animationDelay: "700ms" }}
      >
        <div className="flex flex-col gap-0.5 border-b border-lc-line/90 px-4 py-2.5 sm:px-5 sm:py-3 short:py-1.5">
          <h2 className="lc-disp text-[20px] leading-tight text-lc-chalk sm:text-[24px] short:text-[17px]">
            {trackInfo.name}
          </h2>
          {placeOf(trackInfo) ? <span className="lc-mono text-[12px] font-bold text-lc-fog">{placeOf(trackInfo)}</span> : null}
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-lc-line/70 sm:grid-cols-3">
          {specs.map((spec, i) => (
            <div
              key={i}
              className="lc-show-in flex items-center px-3.5 py-2.5 sm:px-4 sm:py-3 short:px-3 short:py-1.5"
              style={{ animationDelay: `${1050 + i * 160}ms` }}
            >
              <span
                className={`lc-mono text-[13px] font-bold tracking-[0.02em] sm:text-[15px] short:text-[12px] ${
                  i < 2 ? "text-lc-volt" : "text-lc-chalk"
                }`}
              >
                {spec}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

/** Scene 3: Aerial shots with F1 multi-cell Weather Ribbon & Championship Standings Tower */
const AerialCards: React.FC<{ ctx: ShowContext | null; trackInfo: TrackInfo; weather: WeatherHudState | null | undefined; scene: ShowScene }> = ({
  ctx,
  trackInfo,
  weather,
  scene,
}) => {
  const tx = useTranslations("hud.preRace");
  const units = useUnits();
  const sky = ctx ? `${WEATHER_LABELS[ctx.weather].label} · ${TIME_OF_DAY_LABELS[ctx.timeOfDay]}` : null;
  const wet = weather ? weather.rain > 0.05 || weather.waterMm > 0.3 : false;
  const items: InfoBarItem[] = weather
    ? [
        sky,
        tx("air", { value: formatTemp(weather.airC, units, true) }),
        tx("track", { value: formatTemp(weather.trackC, units, true) }),
        weather.windSpeedMs !== undefined
          ? tx("wind", {
              value: `${formatSpeed(weather.windSpeedMs * 3.6, units)} ${speedUnit(units)}`,
              direction: weather.windDirection ?? "",
            })
          : null,
        weather.humidityPct !== undefined ? tx("humidity", { value: Math.round(weather.humidityPct) }) : null,
        {
          text: wet ? tx("wetTrack") : tx("dryTrack"),
          tone: wet ? "info" : "chalk",
          dot: wet ? "var(--color-lc-info)" : "var(--color-lc-volt)",
        },
      ]
    : [sky];
  const standingsDelay = ((scene.endS - scene.startS) * 0.4) * 1000;
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <SceneBug primary={trackInfo.name} secondary={placeOf(trackInfo)} />
      <div className="flex flex-col items-start gap-2.5 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <InfoBar items={items} leadVolt style={{ animationDelay: "320ms" }} />
        {hasStandings(ctx) && ctx ? <StandingsCard ctx={ctx} delayMs={standingsDelay} /> : null}
      </div>
    </div>
  );
};

const PODIUM_POS_COLOR = ["text-lc-podium-gold", "text-lc-podium-silver", "text-lc-podium-bronze"] as const;

/** F1 Championship Standings Tower: volt top-right corner bracket, First/SURNAME rows, volt player row */
const StandingsCard: React.FC<{ ctx: ShowContext; delayMs: number }> = ({ ctx, delayMs }) => {
  const tx = useTranslations("hud.preRace");
  const rows = ctx.standings.filter((s, i) => i < 5 || s.isPlayer);
  return (
    <section
      className="lc-show-from-right lc-show-stripes w-full max-w-[372px] shrink-0 overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/94 shadow-lc-sheet backdrop-blur-sm short:max-w-[310px]"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <div className="flex items-center justify-between border-b border-lc-line px-4 py-2.5 short:py-1.5">
        <h2 className="lc-disp text-[20px] leading-none text-lc-chalk sm:text-[22px] short:text-[17px]">{tx("championship")}</h2>
        <span aria-hidden className="h-1.5 w-8 -skew-x-14 bg-lc-volt" />
      </div>
      <ol className="divide-y divide-lc-line/60">
        {rows.map((s) => {
          const d = showDriver(ctx, s.code, "var(--color-lc-slate)", s.isPlayer);
          const posClass = s.isPlayer ? "text-lc-void" : (PODIUM_POS_COLOR[s.position - 1] ?? "text-lc-fog");
          const numericLast = Boolean(d.first) && /^\d+$/.test(d.last);
          return (
            <li
              key={s.code}
              className={`flex items-center gap-2.5 px-3.5 py-2 text-[13px] sm:text-[14px] short:py-1 short:text-[12px] ${
                s.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
              }`}
            >
              <span className={`lc-mono w-6 text-center text-[14px] font-extrabold ${posClass}`}>{s.position}</span>
              {/* Driver colour bar: data */}
              <span
                aria-hidden
                className={`h-5 w-1.5 shrink-0 ${s.isPlayer ? "ring-1 ring-lc-void/50" : ""}`}
                style={{ backgroundColor: d.color }}
              />
              <span className="min-w-0 flex-1 truncate">
                {!numericLast && d.first ? (
                  <>
                    <span className={s.isPlayer ? "font-semibold text-lc-void/85" : "font-normal text-lc-fog"}>{d.first} </span>
                    <span className={`font-extrabold uppercase ${s.isPlayer ? "text-lc-void" : "text-lc-chalk"}`}>{d.last}</span>
                  </>
                ) : (
                  <span className={`font-extrabold ${s.isPlayer ? "text-lc-void" : "text-lc-chalk"}`}>{fullName(d)}</span>
                )}
              </span>
              <span
                className={`lc-mono shrink-0 rounded-lc-nub px-2 py-0.5 text-[12px] font-extrabold ${
                  s.isPlayer ? "bg-lc-void/15 text-lc-void" : "bg-lc-carbon text-lc-chalk"
                }`}
              >
                {tx("points", { count: s.points })}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const fullName = (d: ShowDriver) => [d.first, d.last].filter(Boolean).join(" ");

const DRY: readonly Compound[] = ["soft", "medium", "hard"];
const WET: readonly Compound[] = ["intermediate", "wet"];

const COMPOUND_BAR: Record<Compound, string> = {
  soft: "bg-lc-crimson",
  medium: "bg-lc-amber",
  hard: "bg-lc-chalk",
  intermediate: "bg-lc-green",
  wet: "bg-lc-cyan",
};

/** Scene 4: F1 Tyre Allocation Broadcast Dock + wheel-hub dive blackout */
const TyreCards: React.FC<{ compound: TireCompound; scene: ShowScene; still: boolean }> = ({ compound, scene, still }) => {
  const tx = useTranslations("hud.preRace");
  const diveAtMs = Math.max(0, scene.endS - scene.startS - WHEEL_DIVE_S) * 1000;
  const fadeCardsAtMs = Math.max(0, diveAtMs - 140);

  const tile = (c: Compound, i: number, small: boolean) => {
    const on = c === compound;
    return (
      <div
        key={c}
        className={`lc-show-in relative flex flex-col items-center justify-between overflow-hidden px-3 pt-3 pb-3.5 sm:px-5 sm:pt-4 sm:pb-4 short:px-2.5 short:py-2 ${
          on ? "bg-lc-volt/12 ring-2 ring-inset ring-lc-volt" : "bg-transparent"
        }`}
        style={{ animationDelay: `${220 + i * 160}ms` }}
      >
        <TyreArt
          compound={c}
          className={
            small
              ? "size-12 sm:size-18 short:size-11"
              : "size-16 sm:size-30 short:size-14"
          }
        />
        <div className="mt-2 flex flex-col items-center gap-1 short:mt-1">
          <span className={`lc-disp leading-none text-lc-chalk ${small ? "text-[13px] sm:text-[15px]" : "text-[15px] sm:text-[20px] short:text-[13px]"}`}>
            {COMPOUNDS[c].name}
          </span>
          {on ? (
            <span className="lc-mono rounded-lc-nub bg-lc-volt px-2 py-0.5 text-[11px] font-extrabold tracking-[0.06em] text-lc-void uppercase">
              {tx("startingOn")}
            </span>
          ) : null}
        </div>
        <span aria-hidden className={`absolute inset-x-0 bottom-0 h-1.5 ${COMPOUND_BAR[c]}`} />
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col justify-end">
      <div
        className={`flex max-w-full flex-col items-start ${still ? "" : "lc-show-tyres-out"}`}
        style={still ? undefined : { animationDelay: `${fadeCardsAtMs}ms` }}
      >
        <section className="lc-show-wipe lc-show-stripes max-w-full overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/92 shadow-lc-sheet backdrop-blur-sm">
          <div className="flex items-center justify-between gap-4 border-b border-lc-line px-4 py-2 sm:px-5 sm:py-2.5 short:py-1.5">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-5 w-1.5 -skew-x-14 bg-lc-volt sm:h-6" />
              <h2 className="lc-disp text-[22px] leading-none text-lc-chalk sm:text-[32px] short:text-[20px]">{tx("tyres")}</h2>
            </div>
            <span className="lc-mono hidden text-[12px] font-bold text-lc-fog sm:inline">{tx("alsoAvailable")}</span>
          </div>

          <div className="flex flex-col divide-y divide-lc-line/80 sm:flex-row sm:items-stretch sm:divide-x sm:divide-y-0 short:flex-row short:items-stretch short:divide-x short:divide-y-0">
            <div className="grid grid-cols-3 divide-x divide-lc-line/70">{DRY.map((c, i) => tile(c, i, false))}</div>
            <div className="flex flex-col bg-lc-carbon/60">
              <div className="grid flex-1 grid-cols-2 divide-x divide-lc-line/70">{WET.map((c, i) => tile(c, i + 3, true))}</div>
              <span className="lc-mono border-t border-lc-line/70 px-3 py-1 text-center text-[11px] font-bold text-lc-fog sm:hidden">
                {tx("alsoAvailable")}
              </span>
            </div>
          </div>
        </section>
      </div>

      {/* Dive into the front wheel hub */}
      {still ? null : (
        <div aria-hidden className="lc-show-dive pointer-events-none fixed inset-0 z-10 bg-lc-void" style={{ animationDelay: `${diveAtMs}ms` }} />
      )}
    </div>
  );
};

/** Scene 5: Iconic F1 Full-Width "STARTING GRID" Broadcast Slam over the grid wide shot */
const GridIntro: React.FC<{ ctx: ShowContext | null; trackInfo: TrackInfo }> = ({ ctx, trackInfo }) => {
  const tx = useTranslations("hud.preRace");
  const terms = useTermsLine(ctx);
  return (
    <div className="relative flex h-full flex-col items-center justify-end pb-[4vh] text-center short:pb-1">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 h-[44vh] bg-linear-to-t from-lc-void/94 via-lc-void/60 to-transparent"
      />
      <div className="relative flex w-full max-w-[920px] flex-col items-center gap-2.5 sm:gap-3.5 short:gap-1.5">
        <div className="flex w-full items-center justify-center gap-3 sm:gap-5">
          <span aria-hidden className="lc-show-rule h-1 flex-1 max-w-[120px] -skew-x-14 bg-lc-volt" />
          <h2 className="lc-show-title-wipe lc-disp text-[44px] leading-[0.88] text-lc-chalk sm:text-[92px] short:text-[36px] hud-text-shadow">
            {tx("startingGrid")}
          </h2>
          <span aria-hidden className="lc-show-rule h-1 flex-1 max-w-[120px] -skew-x-14 bg-lc-volt" />
        </div>
        <InfoBar
          leadVolt
          items={[trackInfo.city || trackInfo.name, ...terms]}
          style={{ animationDelay: "260ms" }}
        />
      </div>
    </div>
  );
};

/** Scene 6: 1:1 F1 Starting Grid Pair — tall architectural driver cards flanking the two real grid cars */
const GridPair: React.FC<{ ctx: ShowContext | null; grid: readonly ShowGridRow[]; pair: number }> = ({ ctx, grid, pair }) => {
  const places = gridPairs(grid.map((_, i) => i))[pair] ?? [];
  return (
    <div className="flex h-full items-end justify-between gap-2.5 sm:gap-4">
      {places.map((place, i) => (
        <DriverCard key={place} ctx={ctx} row={grid[place]} position={place + 1} fromLeft={i === 0} />
      ))}
    </div>
  );
};

const DriverCard: React.FC<{ ctx: ShowContext | null; row: ShowGridRow; position: number; fromLeft: boolean }> = ({
  ctx,
  row,
  position,
  fromLeft,
}) => {
  const tx = useTranslations("hud.preRace");
  const d = showDriver(ctx, row.code, row.color, row.isPlayer);
  const colour = d.color || row.color;
  const accentColour = row.isPlayer ? "var(--color-lc-volt)" : colour;
  const numericLast = Boolean(d.first) && /^\d+$/.test(d.last);
  const firstLine = numericLast ? "" : d.first;
  const primaryName = numericLast ? `${d.first} ${d.last}` : d.last;
  const isPole = position === 1;

  return (
    <article
      className={`${fromLeft ? "lc-show-from-left" : "lc-show-from-right"} relative flex w-[calc(50%-0.32rem)] max-w-[274px] flex-col overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] bg-lc-void/94 shadow-lc-sheet sm:w-[276px] lg:w-[306px] short:w-[224px] ${
        row.isPlayer ? "border-lc-volt ring-1 ring-lc-volt/70" : "border-lc-chalk/18"
      }`}
      style={{
        animationDelay: fromLeft ? "0ms" : "120ms",
        borderTopColor: accentColour,
        borderRightColor: row.isPlayer ? "var(--color-lc-volt)" : colour,
      }}
    >
      {/* Top portrait bay: F1 halftone + angled colour beam + massive ghosted race number + black driver silhouette */}
      <div className="relative overflow-hidden bg-lc-carbon/90">
        <div
          aria-hidden
          className="absolute inset-0 opacity-70"
          style={{
            backgroundImage: `radial-gradient(circle, ${colour} 1.25px, transparent 1.7px), linear-gradient(155deg, ${colour}, transparent 76%)`,
            backgroundSize: "7px 7px, 100% 100%",
          }}
        />
        <div aria-hidden className="lc-show-stripes absolute inset-0 opacity-60" />
        {/* Massive ghosted watermark number / position behind silhouette (classic F1 broadcast depth) */}
        <span
          aria-hidden
          className="lc-disp pointer-events-none absolute -right-2 bottom-1 text-[86px] leading-none text-lc-chalk/8 sm:text-[120px] short:text-[64px]"
        >
          {d.number !== null ? d.number : position}
        </span>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-14 bg-linear-to-t from-lc-void to-transparent" />

        {/* F1 Top Header Strip: bold position block + race number + POLE tag */}
        <div className="relative flex items-start justify-between">
          <div
            className={`inline-flex items-center px-3 py-1.5 sm:px-3.5 sm:py-2 short:px-2.5 short:py-1 ${
              row.isPlayer || isPole ? "bg-lc-volt text-lc-void" : "bg-lc-void/92 text-lc-chalk"
            }`}
          >
            <span className="lc-disp text-[30px] leading-none sm:text-[44px] short:text-[24px]">{tx("place", { position })}</span>
          </div>
          <div className="flex flex-col items-end gap-1 pt-2 pr-3 sm:pt-2.5 sm:pr-4 short:pt-1.5 short:pr-2.5">
            {d.number !== null ? (
              <span className="lc-disp text-[20px] leading-none text-lc-chalk sm:text-[28px] short:text-[16px] hud-text-shadow">
                {d.number}
              </span>
            ) : null}
            {isPole ? (
              <span className="lc-mono rounded-lc-nub bg-lc-volt px-2 py-0.5 text-[11px] font-extrabold tracking-[0.06em] text-lc-void uppercase">
                {tx("pole")}
              </span>
            ) : null}
          </div>
        </div>

        {/* Pure BLACK racing driver silhouette (helmet, visor, HANS collar, shoulders) facing inward toward the grid cars */}
        <DriverSilhouette
          color={colour}
          mirror={!fromLeft}
          className="relative mx-auto -mt-2 block h-[19vh] max-h-[196px] min-h-[106px] w-auto short:h-[26vh] short:max-h-[100px] short:min-h-[78px]"
        />
      </div>

      {/* Bottom F1 Driver Nameplate Block */}
      <div className="relative flex flex-col border-t-[3px] bg-lc-void px-3 pt-2.5 pb-2.5 sm:px-4 sm:pt-3 sm:pb-3 short:px-2.5 short:py-1.5" style={{ borderColor: accentColour }}>
        <div className="flex min-h-[40px] items-stretch gap-2.5 sm:min-h-[52px] short:min-h-[34px]">
          <span aria-hidden className="w-1.5 shrink-0" style={{ backgroundColor: accentColour }} />
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            {firstLine ? (
              <div className="truncate text-[13px] font-semibold leading-tight text-lc-fog sm:text-[15px] short:text-[12px]">{firstLine}</div>
            ) : null}
            <div
              className={`lc-disp truncate text-[18px] leading-[1.02] sm:text-[30px] short:text-[18px] ${
                row.isPlayer ? "text-lc-volt" : "text-lc-chalk"
              }`}
            >
              {primaryName}
            </div>
          </div>
        </div>

        {/* Bottom Telemetry Strip: code / YOU + qualifying time */}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-lc-line/80 pt-1.5 short:mt-1 short:pt-1">
          {row.isPlayer ? (
            <PlayerTag size="sm" />
          ) : (
            <span className="lc-mono text-[12px] font-extrabold tracking-[0.14em] text-lc-slate sm:text-[13px]">{d.code}</span>
          )}
          {row.lapMs ? (
            <span className="lc-mono rounded-lc-nub bg-lc-carbon px-2 py-0.5 text-[12px] font-bold text-lc-chalk sm:text-[13px]">
              {formatLapTime(row.lapMs)}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
};

/** Test day: the season's car on its card (its class and year, weight, balance, drive, rev limit) as the camera circles it */
const CarCard: React.FC<{ ctx: ShowContext | null; trackInfo: TrackInfo }> = ({ ctx, trackInfo }) => {
  const tx = useTranslations("hud.preRace");
  const format = useFormatter();
  const units = useUnits();
  const round = useRoundLine(ctx);
  const test = ctx?.test;
  if (!test) return null;
  const car = anyCarById(test.car as CarId);
  const carClass = car ? CAR_CLASSES.find((c) => c.id === car.classId)?.title : undefined;
  const imperial = units.speed === "mph";
  const specs = [
    test.massKg !== null
      ? imperial
        ? tx("weightLb", { value: format.number(Math.round(test.massKg * 2.20462)) })
        : tx("weightKg", { value: format.number(test.massKg) })
      : null,
    test.frontPct !== null ? tx("frontWeight", { value: format.number(test.frontPct, { maximumFractionDigits: 1 }) }) : null,
    test.drivetrain ? tx(`drivetrain.${test.drivetrain}`) : null,
    test.limiterRpm !== null ? tx("revLimit", { value: format.number(test.limiterRpm) }) : null,
  ].filter((x): x is string => Boolean(x));
  const target = test.targetMs ? tx("targetLap", { time: formatLapTime(test.targetMs) }) : null;

  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <SceneBug primary={trackInfo.name} accent={round} />
      <section className="lc-show-from-left lc-show-stripes w-full max-w-[520px] overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/92 shadow-lc-sheet backdrop-blur-sm short:max-w-[420px]">
        <div className="flex items-stretch gap-3 border-b border-lc-line/90 px-4 py-2.5 sm:px-5 sm:py-3 short:py-1.5">
          <span aria-hidden className="w-1.5 shrink-0 -skew-x-14 bg-lc-volt" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className="lc-disp truncate text-[24px] leading-tight text-lc-chalk sm:text-[32px] short:text-[20px]">
              {carTitle(test.car as CarId)}
            </h2>
            {carClass || car ? (
              <span className="lc-mono text-[12px] font-bold text-lc-fog sm:text-[13px]">
                {[carClass, car?.year].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-lc-line/70">
          {specs.map((spec, i) => (
            <div
              key={i}
              className="lc-show-in flex items-center px-3.5 py-2.5 sm:px-4 sm:py-3 short:px-3 short:py-1.5"
              style={{ animationDelay: `${450 + i * 160}ms` }}
            >
              <span className="lc-mono text-[13px] font-bold tracking-[0.02em] text-lc-chalk sm:text-[15px] short:text-[12px]">{spec}</span>
            </div>
          ))}
        </div>
        {target ? (
          <div
            className="lc-show-in flex items-center gap-2.5 border-t border-lc-line/90 bg-lc-volt/10 px-4 py-2.5 sm:px-5 short:py-1.5"
            style={{ animationDelay: `${450 + specs.length * 160}ms` }}
          >
            <span aria-hidden className="size-2 shrink-0 rounded-full bg-lc-volt" />
            <span className="lc-mono text-[14px] font-extrabold text-lc-volt sm:text-[16px] short:text-[13px]">{target}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
};

/** Scene 7a: Qualifying Entry List Board (F1 bracketed broadcast dock) */
const FieldCard: React.FC<{ ctx: ShowContext | null }> = ({ ctx }) => {
  const tx = useTranslations("hud.preRace");
  const drivers = useMemo(() => {
    if (!ctx) return [];
    const all = Object.values(ctx.drivers);
    if (hasStandings(ctx)) {
      const at = new Map(ctx.standings.map((s, i) => [s.code, i]));
      return all.sort((a, b) => (at.get(a.code) ?? 99) - (at.get(b.code) ?? 99));
    }
    return all.sort((a, b) => (a.isPlayer ? -1 : b.isPlayer ? 1 : (a.number ?? 999) - (b.number ?? 999)));
  }, [ctx]);
  return (
    <div className="flex h-full flex-col justify-end">
      <section className="lc-show-wipe lc-show-stripes overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/92 shadow-lc-sheet backdrop-blur-sm">
        <div className="flex items-center gap-3 border-b border-lc-line px-4 py-2 sm:px-5 sm:py-2.5 short:py-1.5">
          <span aria-hidden className="h-5 w-1.5 -skew-x-14 bg-lc-volt sm:h-6" />
          <h2 className="lc-disp text-[22px] leading-none text-lc-chalk sm:text-[32px] short:text-[20px]">{tx("field")}</h2>
        </div>
        <ul className="grid grid-cols-2 divide-x divide-y divide-lc-line/65 sm:grid-cols-3 lg:grid-cols-4 short:grid-cols-4">
          {drivers.map((d, i) => {
            const numericLast = Boolean(d.first) && /^\d+$/.test(d.last);
            return (
              <li
                key={d.code}
                className={`lc-show-in flex min-w-0 items-center gap-2.5 px-3 py-2.5 sm:px-4 short:px-2.5 short:py-1.5 ${
                  d.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
                }`}
                style={{ animationDelay: `${160 + i * 75}ms` }}
              >
                {/* Driver colour bar: data */}
                <span
                  aria-hidden
                  className={`h-6 w-1.5 shrink-0 short:h-4 ${d.isPlayer ? "ring-1 ring-lc-void/50" : ""}`}
                  style={{ backgroundColor: d.color }}
                />
                {d.number !== null ? (
                  <span className={`lc-mono shrink-0 text-[13px] font-extrabold sm:text-[14px] ${d.isPlayer ? "text-lc-void" : "text-lc-fog"}`}>
                    {d.number}
                  </span>
                ) : d.isPlayer ? (
                  <span className="lc-mono shrink-0 rounded-lc-nub bg-lc-void px-1.5 py-0.5 text-[11px] font-extrabold text-lc-volt">
                    {d.code}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[13px] sm:text-[14px]">
                  {!numericLast && d.first ? (
                    <>
                      <span className={d.isPlayer ? "font-semibold text-lc-void/85" : "text-lc-fog"}>{d.first} </span>
                      <span className="font-extrabold uppercase">{d.last}</span>
                    </>
                  ) : (
                    <span className="font-extrabold">{fullName(d) || d.code}</span>
                  )}
                </span>
                {!d.isPlayer ? (
                  <span className="lc-mono hidden shrink-0 text-[11px] font-bold tracking-[0.08em] text-lc-slate sm:inline">{d.code}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
};

/** Scene 7b: Final F1 Session Launch Card (waits for player input) */
const ReadyCard: React.FC<{
  ctx: ShowContext | null;
  trackInfo: TrackInfo;
  kind: PreRaceShowUi["kind"];
  compound: TireCompound;
  onStart: () => void;
}> = ({ ctx, trackInfo, kind, compound, onStart }) => {
  const tx = useTranslations("hud.preRace");
  const round = useRoundLine(ctx);
  const terms = useTermsLine(ctx);
  const qualifying = kind === "qualifying";
  const test = kind === "test";
  // Not focused on arrival: a Space that skipped here would let go on the button and start the session (Enter starts)
  const compInfo = COMPOUNDS[compound];
  const compItem: InfoBarItem = { text: compInfo.name, dot: `var(--color-lc-${compInfo.color})`, tone: "chalk" };

  return (
    <div className="relative flex h-full flex-col items-center justify-end pb-[4vh] text-center short:pb-1">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 h-[48vh] bg-linear-to-t from-lc-void/95 via-lc-void/65 to-transparent"
      />
      <div className="relative flex w-full max-w-[980px] flex-col items-center gap-3 sm:gap-4 short:gap-1.5">
        <div className="flex w-full items-center justify-center gap-3 sm:gap-5">
          <span aria-hidden className="lc-show-rule h-1 w-8 shrink-0 -skew-x-14 bg-lc-volt sm:w-16" />
          <h2 className="lc-show-title-wipe lc-disp text-[36px] leading-[0.9] text-balance break-words sm:text-[70px] short:text-[30px] hud-text-shadow">
            {trackInfo.name}
          </h2>
          <span aria-hidden className="lc-show-rule h-1 w-8 shrink-0 -skew-x-14 bg-lc-volt sm:w-16" />
        </div>
        <InfoBar
          leadVolt
          items={
            qualifying
              ? [round, ctx ? tx("qualifyingMin", { minutes: ctx.qualifyingMin }) : null, compItem]
              : test
                ? [round, ...terms, compItem]
                : [round, ...terms.slice(0, 2), compItem]
          }
          style={{ animationDelay: "180ms" }}
        />
        <button
          type="button"
          onClick={onStart}
          className="lc-show-in mt-1 inline-flex h-13 items-center gap-3 rounded-full bg-lc-volt px-8 text-[16px] font-bold text-lc-void shadow-lc-pop transition-colors duration-200 ease-lc hover:bg-lc-volt-hi focus-visible:shadow-lc-focus focus-visible:outline-none sm:mt-2 sm:h-14 sm:px-9 sm:text-[18px] short:h-11 short:px-6 short:text-[15px]"
          style={{ animationDelay: "300ms" }}
        >
          {qualifying ? tx("startQualifying") : test ? tx("go") : tx("startRace")}
          <KeyCap tone="ink" className="hidden sm:inline-flex">
            {tx("keyEnter")}
          </KeyCap>
        </button>
      </div>
    </div>
  );
};
