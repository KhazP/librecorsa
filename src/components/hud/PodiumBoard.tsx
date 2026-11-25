"use client";

import React, { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "use-intl/react";
import type { RaceStatus } from "@/types/f1";
import type { ShowContext, ShowDriver } from "@/lib/show/show-context";
import { podiumBoard, type BoardChampionship, type BoardEntry, type BoardGap, type PodiumBoardData } from "@/lib/show/podium-board";
import { PODIUM_BOARD_S } from "@/lib/render/podium-shot";
import { seriesById } from "@/lib/career/ladder";
import { seriesName } from "@/components/career/career-ui";
import { PlayerTag } from "@/components/ui/badges";
import { Icon, Trend } from "@/components/ui/icons";
import { KeyCap } from "@/components/ui/prompts";
import { formatLapTime } from "./hud-format";
import { DriverSilhouette, SceneBug } from "./pre-race/show-parts";

/**
 * The full-screen podium after an offline AI race (render/podium-shot.ts puts it up after the podium shot, over the
 * circuit from the air): P2 | P1 | P3 as the pre-race show's driver cards on their steps, P4 to P10 in a tower beside
 * them, the race's fastest lap and, in a career round, what the round did to the championship. Up to half a minute;
 * the Close button, a tap anywhere, any key or a pad button (the last two in the drive) closes it for the table.
 */
export const PodiumBoard: React.FC<{
  race: RaceStatus;
  context: ShowContext | null;
  trackName: string;
  /** Seconds the board has been up (its countdown rail) */
  timeS: () => number;
  onClose: () => void;
}> = ({ race, context, trackName, timeS, onClose }) => {
  const tx = useTranslations("hud.podiumBoard");
  const txShow = useTranslations("hud.preRace");
  const txCareer = useTranslations("menu.career");
  const board = useMemo(() => podiumBoard(race.results, Boolean(race.resultsFinal), context), [race.results, race.resultsFinal, context]);
  // Without a board (a top three that did not all finish clean) the screen still closes as ever
  const byPlace = (p: number) => board?.podium.find((e) => e.position === p) ?? null;
  const series = context ? seriesById(context.seriesId) : null;
  const round = context ? txShow("roundOf", { round: context.roundIndex + 1, rounds: context.rounds }) : null;
  const secondary = context ? [series ? seriesName(series, txCareer) : null, round].filter(Boolean).join(" · ") : race.totalLaps ? txShow("laps", { count: race.totalLaps }) : null;

  return (
    <div
      className="lc-ui-zoom pointer-events-auto fixed inset-0 z-(--z-lc-results) cursor-pointer overflow-hidden bg-linear-to-b from-lc-void/70 via-lc-void/30 via-40% to-lc-void/90 text-lc-chalk select-none"
      role="dialog"
      aria-label={tx("label")}
      // On the click, not the press: the table must not appear under a finger still down and take the tap
      onClick={onClose}
    >
      <div className="absolute inset-0 flex flex-col gap-3 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[max(4.25rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:gap-4 sm:pt-6 sm:pr-10 sm:pl-10 short:gap-2 short:pt-2.5 short:pb-[max(3.4rem,env(safe-area-inset-bottom))]">
        <SceneBug primary={trackName} secondary={secondary} />

        {board ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 lg:flex-row lg:items-end lg:gap-8 short:flex-row short:items-end short:gap-3">
              <div className="flex w-full min-w-0 flex-col items-center gap-3 lg:flex-1 short:flex-1 short:gap-2">
                {/* P2 | P1 | P3 on their steps */}
                <div className="flex w-full max-w-[860px] min-w-0 items-end justify-center gap-2 sm:gap-3 short:max-w-[460px]">
                  {[2, 1, 3].map((p, i) => {
                    const e = byPlace(p);
                    return e ? (
                      <PodiumCard key={p} entry={e} mirror={i === 2} delayMs={p === 1 ? 120 : p === 2 ? 320 : 480} />
                    ) : (
                      <span key={p} aria-hidden className="min-w-0 flex-1" />
                    );
                  })}
                </div>
                {/* Beside the tower on a wide or short screen: under the podium */}
                <BoardExtras board={board} display="hidden lg:flex short:flex" />
              </div>
              {board.rest.length > 0 ? <ClassificationTower rows={board.rest} playerApart={board.playerApart} /> : null}
            </div>
            {/* Under the tower on a phone held upright */}
            <BoardExtras board={board} display="flex lg:hidden short:hidden" />
          </>
        ) : null}
      </div>

      <div className="absolute right-[max(1rem,env(safe-area-inset-right))] bottom-[max(0.85rem,env(safe-area-inset-bottom))] z-20 flex items-center gap-2 sm:right-10">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-lc-volt px-4 text-[13px] font-bold text-lc-void shadow-lc-pop transition-colors duration-200 ease-lc hover:bg-lc-volt-hi sm:h-9"
        >
          {tx("close")}
          <KeyCap tone="ink" className="hidden sm:inline-flex">
            {tx("keyEsc")}
          </KeyCap>
        </button>
      </div>
      <BoardCountdown timeS={timeS} />
    </div>
  );
};

/** The fastest lap and (career) the championship line; `display` says where this copy shows */
const BoardExtras: React.FC<{ board: PodiumBoardData; display: string }> = ({ board, display }) =>
  board.fastest || board.championship ? (
    <div className={`${display} flex-wrap items-stretch justify-center gap-2 sm:gap-3 short:gap-1.5`}>
      {board.fastest ? <FastestLapBar driver={board.fastest.driver} ms={board.fastest.ms} /> : null}
      {board.championship ? <ChampionshipBar c={board.championship} /> : null}
    </div>
  ) : null;

/** First name (fog) and LAST NAME, or the whole name on one line when the last word is a number (a handle) */
function nameParts(d: ShowDriver): { first: string; main: string } {
  const numericLast = Boolean(d.first) && /^\d+$/.test(d.last);
  return numericLast ? { first: "", main: `${d.first} ${d.last}` } : { first: d.first, main: d.last };
}

/** The row's time or gap, as the results table words it */
function useGapText(): (g: BoardGap) => string {
  const tr = useTranslations("hud.raceResults");
  return (g) => {
    switch (g.kind) {
      case "time":
        return formatLapTime(Math.round(g.s * 1000));
      case "gap":
        return `+${g.s.toFixed(3)}`;
      case "laps":
        return tr("lapsDown", { count: g.count });
      case "running":
        return tr("running");
      case "dnf":
        return tr("dnf");
      case "dsq":
        return tr("dsq");
    }
  };
}

/** A retirement is a loss, a car still running is information, a lapped car is quieter, the rest is plain */
const gapTone = (g: BoardGap): string =>
  g.kind === "dnf" || g.kind === "dsq" ? "text-lc-loss" : g.kind === "running" ? "text-lc-info" : g.kind === "laps" ? "text-lc-fog" : "text-lc-chalk";

const STEP_HEIGHT: Record<number, string> = {
  1: "h-16 sm:h-24 short:h-9",
  2: "h-11 sm:h-16 short:h-6",
  3: "h-7 sm:h-10 short:h-4",
};
const PODIUM_TEXT: Record<number, string> = { 1: "text-lc-podium-gold", 2: "text-lc-podium-silver", 3: "text-lc-podium-bronze" };

/** One of the top three: the pre-race show's driver card (black silhouette in the driver's colour) on its step */
const PodiumCard: React.FC<{ entry: BoardEntry; mirror: boolean; delayMs: number }> = ({ entry, mirror, delayMs }) => {
  const tx = useTranslations("hud.podiumBoard");
  const gapText = useGapText();
  const { driver: d, position } = entry;
  const winner = position === 1;
  const accent = d.isPlayer ? "var(--color-lc-volt)" : d.color;
  const { first, main } = nameParts(d);
  return (
    <div className={`flex min-w-0 flex-1 flex-col ${winner ? "max-w-[290px]" : "max-w-[250px]"}`}>
      <article
        className={`lc-show-in relative flex flex-col overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] bg-lc-void/94 shadow-lc-sheet ${
          d.isPlayer ? "ring-1 ring-lc-volt/70" : ""
        }`}
        style={{ animationDelay: `${delayMs}ms`, borderTopColor: accent, borderRightColor: accent }}
        aria-label={tx("place", { position, name: [d.first, d.last].filter(Boolean).join(" ") })}
      >
        <div className="relative overflow-hidden bg-lc-carbon/90">
          {/* The driver's colour as a halftone wash: data */}
          <div
            aria-hidden
            className="absolute inset-0 opacity-70"
            style={{
              backgroundImage: `radial-gradient(circle, ${d.color} 1.25px, transparent 1.7px), linear-gradient(155deg, ${d.color}, transparent 76%)`,
              backgroundSize: "7px 7px, 100% 100%",
            }}
          />
          <div aria-hidden className="lc-show-stripes absolute inset-0 opacity-60" />
          <span
            aria-hidden
            className="lc-disp pointer-events-none absolute -right-1 bottom-0 text-[64px] leading-none text-lc-chalk/8 sm:text-[110px] short:text-[48px]"
          >
            {d.number ?? position}
          </span>
          <div aria-hidden className="absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-lc-void to-transparent" />
          <div className="relative flex items-start justify-between">
            <span
              className={`lc-disp px-2 py-1 text-[20px] leading-none sm:px-3 sm:py-1.5 sm:text-[36px] short:px-1.5 short:py-0.5 short:text-[16px] ${
                d.isPlayer || winner ? "bg-lc-volt text-lc-void" : "bg-lc-void/92 text-lc-chalk"
              }`}
            >
              {tx("position", { position })}
            </span>
            {d.number !== null ? (
              <span className="lc-disp hud-text-shadow pt-1.5 pr-2 text-[15px] leading-none text-lc-chalk sm:pt-2 sm:pr-3 sm:text-[24px] short:pt-1 short:text-[13px]">
                {d.number}
              </span>
            ) : null}
          </div>
          <DriverSilhouette
            color={d.color}
            mirror={mirror}
            className={`relative mx-auto -mt-1 block w-auto ${
              winner ? "h-[12vh] max-h-[200px] min-h-[76px] sm:h-[22vh]" : "h-[10vh] max-h-[170px] min-h-[64px] sm:h-[18vh]"
            } short:h-[20vh] short:max-h-[86px] short:min-h-[52px]`}
          />
        </div>
        <div className="relative flex flex-col gap-1 border-t-[3px] bg-lc-void px-2 pt-1.5 pb-2 sm:px-3.5 sm:pt-2.5 sm:pb-2.5 short:gap-0.5 short:px-2 short:py-1" style={{ borderColor: accent }}>
          <div className="flex min-h-[30px] items-stretch gap-1.5 sm:min-h-[46px] sm:gap-2.5 short:min-h-[24px]">
            {/* The driver's colour: data */}
            <span aria-hidden className="w-1 shrink-0 sm:w-1.5" style={{ backgroundColor: accent }} />
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              {first ? <div className="truncate text-[11px] leading-tight font-semibold text-lc-fog sm:text-[14px] short:hidden">{first}</div> : null}
              <div className={`lc-disp truncate text-[14px] leading-[1.05] sm:text-[24px] short:text-[14px] ${d.isPlayer ? "text-lc-volt" : "text-lc-chalk"}`}>
                {main}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-1 border-t border-lc-line/80 pt-1 sm:pt-1.5 short:pt-0.5">
            {d.isPlayer ? (
              <PlayerTag size="sm" />
            ) : (
              <span className="lc-mono text-[11px] font-extrabold tracking-[0.12em] text-lc-slate sm:text-[13px]">{d.code}</span>
            )}
            <span className={`lc-mono rounded-lc-nub bg-lc-carbon px-1.5 py-0.5 text-[11px] font-bold sm:px-2 sm:text-[13px] ${gapTone(entry.gap)}`}>
              {gapText(entry.gap)}
            </span>
          </div>
        </div>
      </article>
      {/* The step */}
      <div
        aria-hidden
        className={`lc-grow flex items-start justify-center border-t-2 bg-lc-carbon/92 pt-1 ${STEP_HEIGHT[position] ?? ""} ${
          d.isPlayer ? "border-lc-volt" : "border-lc-line"
        }`}
        style={{ animationDelay: `${delayMs}ms` }}
      >
        <span className={`lc-disp text-[18px] leading-none sm:text-[34px] short:hidden ${PODIUM_TEXT[position] ?? "text-lc-fog"}`}>{position}</span>
      </div>
    </div>
  );
};

/** P4 to P10 (and the player further back, apart): the pre-race show's standings tower */
const ClassificationTower: React.FC<{ rows: readonly BoardEntry[]; playerApart: boolean }> = ({ rows, playerApart }) => {
  const tx = useTranslations("hud.podiumBoard");
  const gapText = useGapText();
  return (
    <section
      className="lc-show-from-right w-full max-w-[430px] shrink-0 overflow-hidden rounded-tr-lc-card border-t-[3px] border-r-[3px] border-lc-volt bg-lc-void/94 shadow-lc-sheet lg:w-[380px] short:w-[300px]"
      style={{ animationDelay: "560ms" }}
      aria-label={tx("classification")}
    >
      <ol className="divide-y divide-lc-line/60">
        {rows.map((e, i) => {
          const d = e.driver;
          const { first, main } = nameParts(d);
          const apart = playerApart && i === rows.length - 1;
          return (
            <li
              key={`${e.position}-${d.code}`}
              className={`flex items-center gap-2 px-3 py-1.5 text-[13px] sm:gap-2.5 sm:px-3.5 sm:py-2 sm:text-[14px] short:py-1 short:text-[12px] ${
                d.isPlayer ? "bg-lc-volt text-lc-void" : "text-lc-chalk"
              } ${apart ? "border-t-2 border-t-lc-line" : ""}`}
            >
              <span className={`lc-mono w-7 text-center text-[13px] font-extrabold sm:text-[14px] ${d.isPlayer ? "text-lc-void" : "text-lc-fog"}`}>{e.position}</span>
              {/* The driver's colour: data */}
              <span aria-hidden className={`h-4 w-1.5 shrink-0 sm:h-5 ${d.isPlayer ? "ring-1 ring-lc-void/50" : ""}`} style={{ backgroundColor: d.color }} />
              <span className="min-w-0 flex-1 truncate">
                {first ? <span className={d.isPlayer ? "font-semibold text-lc-void/85" : "font-normal text-lc-fog"}>{first} </span> : null}
                <span className={`font-extrabold ${first ? "uppercase" : ""} ${d.isPlayer ? "text-lc-void" : "text-lc-chalk"}`}>{main}</span>
              </span>
              <span className={`lc-mono shrink-0 text-[12px] font-bold sm:text-[13px] ${d.isPlayer ? "text-lc-void" : gapTone(e.gap)}`}>{gapText(e.gap)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
};

const BAR = "lc-show-wipe lc-show-chamfer-sm inline-flex max-w-full items-stretch overflow-hidden border-t-2 bg-lc-void/92 shadow-lc-pop";
const CELL = "lc-mono inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-bold tracking-[0.04em] sm:px-3.5 sm:text-[14px] short:px-2.5 short:py-1 short:text-[12px]";

/** The race's fastest lap: who, and the time in the best colour (beside the lap-time mark and its word) */
const FastestLapBar: React.FC<{ driver: ShowDriver; ms: number }> = ({ driver, ms }) => {
  const tr = useTranslations("hud.raceResults");
  const name = [driver.first, driver.last].filter(Boolean).join(" ");
  return (
    <div className={`${BAR} border-lc-best`} style={{ animationDelay: "720ms" }}>
      <span className={`${CELL} bg-lc-best/15 text-lc-best-ink`}>
        <Icon name="lapTimes" size="xs" />
        {tr("fastestLap")}
      </span>
      <span className={`${CELL} min-w-0 border-l border-lc-line/85 ${driver.isPlayer ? "text-lc-volt" : "text-lc-chalk"}`}>
        {/* The driver's colour: data */}
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: driver.color }} />
        <span className="truncate">{name}</span>
      </span>
      <span className={`${CELL} border-l border-lc-line/85 text-lc-best`}>{formatLapTime(ms)}</span>
    </div>
  );
};

/** Career rounds: the points the round brought and where it leaves the player in the championship */
const ChampionshipBar: React.FC<{ c: BoardChampionship }> = ({ c }) => {
  const tx = useTranslations("hud.podiumBoard");
  const moved = c.position !== null && c.was !== null ? c.was - c.position : null;
  return (
    <div className={`${BAR} border-lc-volt`} style={{ animationDelay: "840ms" }}>
      <span className={`${CELL} bg-lc-volt font-extrabold whitespace-nowrap text-lc-void`}>{c.points > 0 ? tx("pointsScored", { count: c.points }) : tx("noPoints")}</span>
      {c.position !== null ? (
        <span className={`${CELL} border-l border-lc-line/85 text-lc-chalk`}>
          {tx("championshipPlace", { position: c.position })}
          {moved !== null && moved !== 0 ? (
            <span className={`inline-flex items-center gap-1 ${moved > 0 ? "text-lc-gain" : "text-lc-loss"}`}>
              <Trend direction={moved > 0 ? "up" : "down"} />
              {Math.abs(moved)}
              <span className="sr-only">{moved > 0 ? tx("placesUp", { count: moved }) : tx("placesDown", { count: -moved })}</span>
            </span>
          ) : null}
        </span>
      ) : null}
      <span className={`${CELL} border-l border-lc-line/85 text-lc-fog`}>{tx("pointsTotal", { count: c.total })}</span>
    </div>
  );
};

/** Thin rail along the bottom edge, filling as the board's half-minute runs out */
const BoardCountdown: React.FC<{ timeS: () => number }> = ({ timeS }) => {
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, timeS() / PODIUM_BOARD_S)})`;
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [timeS]);
  return (
    <div aria-hidden className="absolute inset-x-0 bottom-0 z-20 h-0.5 bg-lc-line/60">
      <div ref={bar} className="h-full origin-left bg-lc-volt" style={{ transform: "scaleX(0)" }} />
    </div>
  );
};
