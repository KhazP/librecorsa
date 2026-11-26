"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFormatter, useTranslations } from "use-intl/react";
import {
  RACE_LENGTHS,
  seriesById,
  seriesContent,
  type CareerContent,
  type CareerSeries,
} from "@/lib/career/ladder";
import {
  MAX_ATTEMPTS,
  mulliganBonus,
  nextRound,
  objectiveProgress,
  promotionPlaces,
  raceMultiplierParts,
  seasonStandings,
  type CareerRun,
  type RaceSettings,
  type SeasonRecord,
  type SeasonScoreParts,
  type SeasonState,
} from "@/lib/career/career-state";
import type { CareerSummary } from "./career-screen-types";
import { useFocusNav, focusOnHover } from "@/components/menu/useFocusNav";
import { Button, Card, MediaTile, Modal, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { CHOSEN_TILE, CURSOR_TILE, IDLE_TILE, MOTION } from "@/components/ui/styles";
import {
  CareerCircuitOutline,
  MultiplierBadge,
  ObjectiveRow,
  RaceSettingsFields,
  SeriesCarThumb,
  StandingsTable,
  StatTile,
  aiLevelLabel,
  carTitle,
  damageLevelLabel,
  driverDisplay,
  raceLengthLabel,
  seriesName,
  trackLabel,
} from "./career-ui";

// ---- Helpers for round & season snapshots

/** Reconstructs a season snapshot up to `roundIndex` (inclusive) for objective & multiplier context. */
function resolveSeasonContext(
  summary: Extract<CareerSummary, { kind: "race" }>,
  run: CareerRun | undefined,
  seasonOverride?: SeasonState,
): SeasonState | null {
  if (seasonOverride && seasonOverride.seriesId === summary.seriesId) return seasonOverride;
  if (run?.season && run.season.seriesId === summary.seriesId && run.season.started) {
    return run.season;
  }
  // If the final round just ended the season, reconstruct from the latest archived record for that series
  if (run) {
    for (let i = run.history.length - 1; i >= 0; i--) {
      const rec = run.history[i];
      if (rec.seriesId === summary.seriesId && rec.archive) {
        return {
          seriesId: rec.seriesId,
          attempt: rec.attempt,
          started: true,
          settings: {
            length: "medium",
            circuits: rec.archive.circuits,
            mulligans: 0,
            car: rec.car,
          },
          race: rec.archive.race,
          grid: rec.archive.standings.filter((r) => r.who !== "me").map((r) => r.who),
          rounds: rec.archive.rounds,
          mulligansUsed: rec.mulligansUsed,
          objectives: rec.archive.objectives.map((o) => ({ kind: o.kind, target: o.target })),
          carried: [],
        };
      }
    }
  }
  return null;
}

function seasonUpToRound(season: SeasonState, upToInclusive: number, totalRounds: number): SeasonState {
  const len = Math.max(totalRounds, season.rounds.length);
  const rounds = Array.from({ length: len }, (_, i) => (i <= upToInclusive ? (season.rounds[i] ?? null) : null));
  return { ...season, rounds };
}

// ---- Race Summary Modal (live post-race debrief & read-only schedule round review)

export const RaceSummaryModal: React.FC<{
  summary: Extract<CareerSummary, { kind: "race" }>;
  run: CareerRun | undefined;
  playerName: string;
  playerCode: string;
  onContinue: () => void;
  readOnly?: boolean;
  seasonOverride?: SeasonState;
}> = ({ summary, run, playerName, playerCode, onContinue, readOnly, seasonOverride }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const series = seriesById(summary.seriesId);
  const track = trackLabel(summary.result.trackId);
  const { result, parts } = summary;
  const rivals = run?.rivals ?? [];

  const seasonCtx = useMemo(
    () => resolveSeasonContext(summary, run, seasonOverride),
    [summary, run, seasonOverride],
  );

  const currSeason = useMemo(
    () => (seasonCtx ? seasonUpToRound(seasonCtx, summary.roundIndex, summary.rounds) : null),
    [seasonCtx, summary.roundIndex, summary.rounds],
  );
  const prevSeason = useMemo(
    () => (seasonCtx ? seasonUpToRound(seasonCtx, summary.roundIndex - 1, summary.rounds) : null),
    [seasonCtx, summary.roundIndex, summary.rounds],
  );

  // Championship position and promotion gap after this round
  const myAfterIdx = summary.after.findIndex((r) => r.who === "me");
  const myAfterPlace = myAfterIdx >= 0 ? myAfterIdx + 1 : summary.after.length;
  const myAfterRow = myAfterIdx >= 0 ? summary.after[myAfterIdx] : undefined;
  const onPace = myAfterPlace <= summary.promotion;

  let cutNote = "";
  if (myAfterRow) {
    if (onPace) {
      const firstOut = summary.after[summary.promotion];
      if (firstOut) {
        const margin = myAfterRow.points - firstOut.points;
        cutNote = margin > 0 ? tx("promotionSafeMargin", { points: margin }) : tx("promotionTied", { place: summary.promotion });
      } else {
        cutNote = tx("promotionOnPace");
      }
    } else {
      const cutDriver = summary.after[summary.promotion - 1];
      if (cutDriver) {
        const deficit = cutDriver.points - myAfterRow.points;
        cutNote = deficit > 0 ? tx("promotionPointsNeeded", { points: deficit, place: summary.promotion }) : tx("promotionTied", { place: summary.promotion });
      } else {
        cutNote = tx("promotionAtRisk");
      }
    }
  }

  // Round points per driver for Standings Battle
  const roundPoints = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of result.lines) map.set(line.who, line.points);
    return map;
  }, [result.lines]);

  // Race podium (P1-P3) plus the player if they finished outside P3
  const sortedLines = useMemo(
    () => [...result.lines].sort((a, b) => a.position - b.position),
    [result.lines],
  );
  const podiumLines = sortedLines.slice(0, 3);
  const playerOutsidePodium =
    podiumLines.every((l) => l.who !== "me") ? sortedLines.find((l) => l.who === "me") : undefined;

  const multParts = seasonCtx ? raceMultiplierParts(seasonCtx.race) : null;

  const breakdownRows: { label: string; value: number }[] = [
    { label: tx("scoreFinish"), value: parts.finish },
    { label: tx("scoreGrid"), value: parts.grid },
    { label: tx("scoreLed"), value: parts.led },
    { label: tx("scoreCompleted"), value: parts.completed },
    { label: tx("scoreClean"), value: parts.clean },
    { label: tx("scorePodium"), value: parts.podium },
  ];

  return (
    <Modal
      open
      onClose={onContinue}
      size="lg"
      title={track.name}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info" size="sm">
            {tx("roundOf", { round: summary.roundIndex + 1, total: summary.rounds })}
          </Badge>
          {series ? <span className="lc-hint">{seriesName(series, tx)}</span> : null}
          {track.layout ? <span className="lc-hint">{track.layout}</span> : null}
          {result.fastestLap ? (
            <Badge tone="best" size="sm" icon="lapTimes">
              {tx("raceSummaryFastestLap")}
            </Badge>
          ) : null}
          {result.lapsLed > 0 ? (
            <Badge tone="neutral" size="sm">
              {tx("raceSummaryLapsLed", { count: result.lapsLed })}
            </Badge>
          ) : null}
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="primary" size="md" onClick={onContinue} data-nav-default="">
            {readOnly ? tx("close") : tx("continue")}
          </Button>
        </div>
      }
    >
      {/* 4-tile KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile
          label={tx("raceSummaryFinish")}
          value={result.dnf ? tx("raceSummaryDnf") : `P${result.position}`}
          sub={tx("raceSummaryStarted", { grid: result.grid })}
        />
        <StatTile
          label={tx("raceSummaryChampionship")}
          value={`P${myAfterPlace}`}
          sub={cutNote || (onPace ? tx("promotionOnPace") : tx("promotionAtRisk"))}
        />
        <StatTile
          label={tx("raceSummaryPoints")}
          value={tx("schedulePoints", { points: result.points })}
          sub={myAfterRow ? tx("raceSummarySeasonPoints", { points: format.number(myAfterRow.points) }) : undefined}
        />
        <StatTile
          label={tx("scoreTotal")}
          value={`+${format.number(parts.score)}`}
          // The season's race scores so far: the career total only grows when a season ends
          sub={currSeason ? tx("raceSummarySeasonTotal", { score: format.number(currSeason.rounds.reduce((a, r) => a + (r?.score ?? 0), 0)) }) : undefined}
        />
      </div>

      {/* Race podium strip */}
      {podiumLines.length > 0 ? (
        <Well className="flex flex-col gap-2 px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="lc-lbl">{tx("raceSummaryPodiumTitle")}</span>
            {playerOutsidePodium ? (
              <span className="lc-lbl">{tx("raceSummaryYourFinish")}</span>
            ) : null}
          </div>
          <div
            className={cx(
              "grid grid-cols-1 gap-2",
              playerOutsidePodium ? "sm:grid-cols-4" : "sm:grid-cols-3",
            )}
          >
            {podiumLines.map((line) => {
              const d = driverDisplay(rivals, line.who, playerName, playerCode);
              return (
                <div
                  key={line.who}
                  className={cx(
                    "flex min-w-0 items-center justify-between gap-2 rounded-lc-nub border px-2.5 py-1.5",
                    d.isPlayer
                      ? "border-lc-volt/60 bg-lc-volt text-lc-void"
                      : "border-lc-line bg-lc-carbon/90 text-lc-chalk",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <PositionBadge
                      position={line.position}
                      player={d.isPlayer}
                      size="sm"
                      variant={d.isPlayer ? "solid" : undefined}
                      className={d.isPlayer ? "bg-lc-void! text-lc-volt!" : undefined}
                    />
                    <span className="min-w-0 truncate text-[13px] font-semibold">{d.name}</span>
                  </div>
                  <span className={cx("lc-mono shrink-0 text-[12px] font-bold", d.isPlayer ? "text-lc-void" : "text-lc-fog")}>
                    <bdi>+{line.points}</bdi>
                  </span>
                </div>
              );
            })}
            {playerOutsidePodium ? (
              <div className="flex min-w-0 items-center justify-between gap-2 rounded-lc-nub border border-lc-volt/60 bg-lc-volt px-2.5 py-1.5 text-lc-void">
                <div className="flex min-w-0 items-center gap-2">
                  {playerOutsidePodium.dnf ? (
                    <Badge tone="bad" variant="solid" size="sm">
                      {tx("raceSummaryDnf")}
                    </Badge>
                  ) : (
                    <PositionBadge
                      position={playerOutsidePodium.position}
                      player
                      size="sm"
                      variant="solid"
                      className="bg-lc-void! text-lc-volt!"
                    />
                  )}
                  <span className="min-w-0 truncate text-[13px] font-semibold">{playerName}</span>
                </div>
                <span className="lc-mono shrink-0 text-[12px] font-bold">
                  <bdi>+{playerOutsidePodium.points}</bdi>
                </span>
              </div>
            ) : null}
          </div>
        </Well>
      ) : null}

      {/* Two balanced debrief columns */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Left: Standings Battle + Itemised Race Score */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card title={tx("standingsAfterTitle")}>
            <StandingsTable
              rows={summary.after}
              before={summary.roundIndex > 0 ? summary.before : undefined}
              roundPoints={roundPoints}
              promotion={summary.promotion}
              rivals={rivals}
              playerName={playerName}
              playerCode={playerCode}
              compact
              showWins={false}
            />
          </Card>

          <Card title={tx("raceScoreTitle")}>
            <div className="flex flex-col gap-1.5">
              {breakdownRows.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-2 py-0.5 text-[14px]">
                  <span className="text-lc-fog">{item.label}</span>
                  <span className="lc-data text-lc-chalk">{format.number(item.value)}</span>
                </div>
              ))}
              <div className="my-1 border-t border-lc-line" />
              <div className="flex items-center justify-between gap-2 text-[14px]">
                <span className="text-lc-slate">{tx("scoreSubtotal", { mult: parts.mult })}</span>
                <span className="lc-data text-lc-fog">
                  <bdi>
                    {format.number(parts.total)} × {parts.mult}
                  </bdi>
                </span>
              </div>
              {multParts && seasonCtx ? (
                <span className="lc-hint">
                  {tx("raceSummaryMultiplierBreakdown", {
                    ai: aiLevelLabel(seasonCtx.race.aiLevel, tx),
                    aiPts: multParts.ai,
                    damage: damageLevelLabel(seasonCtx.race.damage, tx),
                    damagePts: multParts.damage,
                    length: raceLengthLabel(seasonCtx.race.raceLength, tx),
                    lengthPts: multParts.length,
                    total: multParts.total,
                  })}
                </span>
              ) : null}
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="lc-row-label">{tx("scoreTotal")}</span>
                <span className="lc-data text-[18px] text-lc-volt">{format.number(parts.score)}</span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right: Promotion Fight + Bonus Objectives */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title={tx("promotionTitle")}
            action={
              <Badge tone={onPace ? "good" : "warn"} size="sm" icon={onPace ? "success" : "warning"}>
                {onPace ? tx("promotionOnPace") : tx("promotionAtRisk")}
              </Badge>
            }
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <PositionBadge position={myAfterPlace} player size="md" />
                <div className="flex flex-col gap-0.5">
                  <span className="lc-row-label">{tx("promotionTarget", { place: summary.promotion })}</span>
                  {cutNote ? <span className="lc-hint">{cutNote}</span> : null}
                </div>
              </div>
            </div>
            {seasonCtx ? (
              <div className="flex items-center justify-between gap-2 pt-2">
                <span className="lc-hint">{tx("attemptBadge", { attempt: seasonCtx.attempt, max: MAX_ATTEMPTS })}</span>
                <div className="flex items-center gap-1.5" aria-hidden>
                  {Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
                    const n = i + 1;
                    const used = n < seasonCtx.attempt;
                    const current = n === seasonCtx.attempt;
                    return (
                      <span
                        key={n}
                        className={cx(
                          "h-2 w-5 rounded-full border",
                          used
                            ? "border-lc-loss/60 bg-lc-loss"
                            : current
                              ? "border-lc-chalk bg-lc-chalk"
                              : "border-lc-keyline bg-lc-titanium",
                        )}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
          </Card>

          {currSeason && currSeason.objectives.length > 0 ? (
            <Card title={tx("objectivesTitle")} bodyClassName="flex flex-col gap-2">
              {currSeason.objectives.map((obj) => {
                const afterProg = objectiveProgress(obj, currSeason);
                const beforeProg = prevSeason ? objectiveProgress(obj, prevSeason) : null;
                const delta =
                  beforeProg && !beforeProg.done && afterProg.done
                    ? "done"
                    : beforeProg && !beforeProg.failed && afterProg.failed
                      ? "failed"
                      : null;
                return <ObjectiveRow key={obj.kind} objective={obj} season={currSeason} delta={delta} />;
              })}
            </Card>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

// ---- Season Summary Modal (live season end & archived History season drill-down)

type SeasonOutcomeKind = "promoted" | "complete" | "retry" | "over";

const SeasonDebriefModal: React.FC<{
  record: SeasonRecord;
  outcome: SeasonOutcomeKind;
  parts: SeasonScoreParts | null;
  alongside: readonly string[];
  run: CareerRun | undefined;
  playerName: string;
  playerCode: string;
  seasonNumber?: number;
  isArchive?: boolean;
  onContinue: () => void;
}> = ({
  record,
  outcome,
  parts,
  alongside,
  run,
  playerName,
  playerCode,
  seasonNumber,
  isArchive,
  onContinue,
}) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const series = seriesById(record.seriesId);
  const archive = record.archive;
  const rivals = run?.rivals ?? [];

  const outcomeTone =
    outcome === "complete" ? "best" : outcome === "promoted" ? "good" : outcome === "retry" ? "warn" : "bad";
  const outcomeIcon =
    outcome === "complete"
      ? "challenge"
      : outcome === "promoted"
        ? "success"
        : outcome === "retry"
          ? "restart"
          : "error";

  const seriesLabel = series ? seriesName(series, tx) : record.seriesId;
  const disciplineLabel = series ? tx(`discipline.${series.discipline}`) : run ? tx(`discipline.${run.discipline}`) : "";

  const heroLine = (() => {
    if (outcome === "complete") {
      return tx("seasonHeroComplete", {
        place: record.position,
        series: seriesLabel,
        discipline: disciplineLabel,
      });
    }
    if (outcome === "promoted") {
      const nextTier = (series?.tier ?? 0) + 2;
      return tx("seasonHeroPromoted", {
        place: record.position,
        series: seriesLabel,
        tier: nextTier,
      });
    }
    if (outcome === "over") {
      return tx("seasonHeroOver", {
        place: record.position,
        series: seriesLabel,
        max: MAX_ATTEMPTS,
      });
    }
    if (isArchive) {
      return tx("seasonHeroMissed", {
        place: record.position,
        series: seriesLabel,
      });
    }
    return tx("seasonHeroRetry", {
      place: record.position,
      series: seriesLabel,
      attempt: Math.min(MAX_ATTEMPTS, record.attempt + 1),
      max: MAX_ATTEMPTS,
    });
  })();

  const scoreLines: { label: string; value: number }[] = parts
    ? [
        { label: tx("seasonScoreRaces"), value: parts.races },
        { label: tx("seasonScoreChampionship"), value: parts.championship },
        { label: tx("seasonScorePoints"), value: parts.points },
        { label: tx("seasonScoreObjectives"), value: parts.objectives },
        ...(parts.firstClear > 0 ? [{ label: tx("seasonScoreFirstClear"), value: parts.firstClear }] : []),
        { label: tx("seasonScoreMulligans"), value: parts.mulligans },
      ]
    : [];

  // Only show "Promoted alongside you" when the season actually resulted in a promotion
  const promotedDrivers =
    outcome === "promoted"
      ? alongside.map((id) => {
          const d = driverDisplay(rivals, id, playerName, playerCode);
          const rankIdx = archive?.standings.findIndex((s) => s.who === id) ?? -1;
          return { ...d, rank: rankIdx >= 0 ? rankIdx + 1 : null };
        })
      : [];

  const promoCut = series && archive ? promotionPlaces(series, archive.race.gridSize) : (series?.promoteTop ?? 3);

  return (
    <Modal
      open
      onClose={onContinue}
      size="lg"
      title={isArchive ? seriesLabel : tx(`seasonOutcome.${outcome}`)}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={outcomeTone} icon={outcomeIcon} size="md">
            {isArchive ? tx(`seasonOutcome.${outcome}`) : seriesLabel}
          </Badge>
          {seasonNumber !== undefined ? (
            <Badge tone="neutral" size="sm">
              {tx("seasonNumber", { season: seasonNumber })}
            </Badge>
          ) : null}
          <span className="lc-hint">{tx("attemptBadge", { attempt: record.attempt, max: MAX_ATTEMPTS })}</span>
          <span className="lc-hint">{carTitle(record.car)}</span>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="primary" size="md" onClick={onContinue} data-nav-default="">
            {isArchive ? tx("close") : tx("continue")}
          </Button>
        </div>
      }
    >
      {/* Hero payoff band */}
      <Well className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lc-nub border border-lc-line bg-lc-carbon p-1.5 sm:w-40">
            <SeriesCarThumb carId={record.car} />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="lc-body m-0 text-lc-chalk">{heroLine}</p>
            <span className="lc-hint">
              {tx("roundsCount", { count: record.rounds })} · {tx("historyMulligans", { count: record.mulligansUsed })}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-0.5 sm:items-end">
          <span className="lc-lbl">{tx("seasonScoreTotal")}</span>
          <span className="lc-data text-[26px] leading-none text-lc-volt">{format.number(record.score)}</span>
        </div>
      </Well>

      {/* Compact KPI row */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={tx("colPos")} value={`P${record.position}`} />
        <StatTile label={tx("colPoints")} value={format.number(record.points)} />
        <StatTile label={tx("statWins")} value={record.wins} />
        <StatTile label={tx("statPodiums")} value={record.podiums} />
        <StatTile label={tx("statObjectives")} value={`${record.objectivesDone}/${record.objectivesTotal}`} />
        <StatTile label={tx("mulligans")} value={record.mulligansUsed} />
      </div>

      {/* Season races log (when archived) */}
      {archive && archive.rounds.length > 0 ? (
        <Card title={tx("seasonRacesTitle")}>
          <div className="flex flex-col gap-1">
            <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_5.5rem_3rem_4.25rem] items-center gap-2 px-2.5 pb-1 text-lc-slate phone:grid-cols-[3.25rem_minmax(0,1fr)_4.5rem_2.75rem_3.75rem]">
              <span className="lc-lbl">{tx("seasonColRound")}</span>
              <span className="lc-lbl">{tx("seasonColCircuit")}</span>
              <span className="lc-lbl text-center">{tx("seasonColGridFinish")}</span>
              <span className="lc-lbl text-end">{tx("colPoints")}</span>
              <span className="lc-lbl text-end">{tx("seasonColScore")}</span>
            </div>
            {archive.circuits.map((trackId, idx) => {
              const r = archive.rounds[idx];
              const info = trackLabel(trackId);
              return (
                <div
                  key={`${trackId}-${idx}`}
                  className={cx(
                    "grid grid-cols-[3.5rem_minmax(0,1fr)_5.5rem_3rem_4.25rem] items-center gap-2 rounded-lc-row px-2.5 py-1.5 phone:grid-cols-[3.25rem_minmax(0,1fr)_4.5rem_2.75rem_3.75rem]",
                    idx % 2 === 0 ? "bg-lc-well/80" : "bg-transparent",
                  )}
                >
                  <span className="lc-mono text-[12px] font-bold text-lc-slate">
                    {tx("roundTag", { round: idx + 1 })}
                  </span>
                  <span className="min-w-0 truncate text-[13px] font-semibold text-lc-chalk">{info.name}</span>
                  <div className="flex items-center justify-center gap-1">
                    {r ? (
                      <>
                        <span className="lc-mono text-[12px] text-lc-slate">P{r.grid}</span>
                        <Icon name="next" size="xs" className="text-lc-dim" />
                        {r.dnf ? (
                          <Badge tone="bad" size="sm">
                            {tx("scheduleDnf")}
                          </Badge>
                        ) : (
                          <PositionBadge position={r.position} size="sm" />
                        )}
                      </>
                    ) : (
                      <span className="lc-mono text-[12px] text-lc-slate">{tx("unranked")}</span>
                    )}
                  </div>
                  <span className="lc-data text-end text-[13px] text-lc-fog">
                    {r ? <bdi>+{r.points}</bdi> : tx("unranked")}
                  </span>
                  <span className="lc-data text-end text-[13px] text-lc-chalk">
                    {r ? format.number(r.score) : tx("unranked")}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {/* Objectives + Score breakdown */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title={tx("seasonObjectivesTitle")}>
            {archive && archive.objectives.length > 0 ? (
              <div className="flex flex-col gap-2">
                {archive.objectives.map((obj) => (
                  <Well key={obj.kind} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className={cx("min-w-0 text-[13px] font-medium", obj.done ? "text-lc-chalk" : "text-lc-slate")}>
                      {tx(`objective.${obj.kind}`, { target: obj.target })}
                    </span>
                    <Badge
                      tone={obj.done ? "good" : "bad"}
                      variant={obj.done ? "solid" : "soft"}
                      size="sm"
                      icon={obj.done ? "success" : "error"}
                    >
                      {obj.done ? tx("objectiveDone") : tx("objectiveFailed")}
                    </Badge>
                  </Well>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="lc-row-label">
                  <bdi>
                    {record.objectivesDone} / {record.objectivesTotal}
                  </bdi>
                </span>
                <p className="lc-hint m-0">{tx("seasonArchiveUnavailable")}</p>
              </div>
            )}
          </Card>

          {promotedDrivers.length > 0 ? (
            <Card title={tx("promotedAlongsideTitle")} description={tx("promotedAlongsideDesc")}>
              <div className="flex flex-col gap-1.5">
                {promotedDrivers.map((d) => (
                  <Well key={d.who} className="flex items-center justify-between gap-2.5 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden
                        className="h-4 w-1 shrink-0 rounded-full bg-lc-slate"
                        style={d.color ? { backgroundColor: d.color } : undefined}
                      />
                      {d.rank !== null ? <PositionBadge position={d.rank} size="sm" /> : null}
                      <span className="min-w-0 truncate text-[14px] font-semibold text-lc-chalk">{d.name}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {d.number !== null ? (
                        <span className="lc-mono text-[12px] text-lc-slate">#{d.number}</span>
                      ) : null}
                      <span className="lc-mono text-[12px] font-bold text-lc-fog">{d.code}</span>
                    </div>
                  </Well>
                ))}
              </div>
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          {parts ? (
            <Card title={tx("seasonScoreTitle")}>
              <div className="flex flex-col gap-1.5">
                {scoreLines.map((line) => (
                  <div key={line.label} className="flex items-center justify-between gap-2 py-0.5 text-[14px]">
                    <span className="text-lc-fog">{line.label}</span>
                    <span className="lc-data text-lc-chalk">{format.number(line.value)}</span>
                  </div>
                ))}
                <div className="my-1 border-t border-lc-line" />
                <div className="flex items-center justify-between gap-2 text-[14px]">
                  <span className="text-lc-slate">{tx("seasonScoreMult")}</span>
                  <span className="lc-data text-lc-fog">
                    <bdi>× {parts.mult}</bdi>
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="lc-row-label">{tx("seasonScoreTotal")}</span>
                  <span className="lc-data text-[20px] text-lc-volt">{format.number(parts.score)}</span>
                </div>
              </div>
            </Card>
          ) : (
            <Card title={tx("seasonScoreTitle")}>
              <div className="flex items-center justify-between gap-2">
                <span className="lc-row-label">{tx("seasonScoreTotal")}</span>
                <span className="lc-data text-[20px] text-lc-volt">{format.number(record.score)}</span>
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* Final standings (when archived) */}
      {archive && archive.standings.length > 0 ? (
        <Card title={tx("seasonFinalStandingsTitle")}>
          <StandingsTable
            rows={archive.standings}
            promotion={promoCut}
            rivals={rivals}
            playerName={playerName}
            playerCode={playerCode}
            compact
            showWins
          />
        </Card>
      ) : null}
    </Modal>
  );
};

export const SeasonSummaryModal: React.FC<{
  summary: Extract<CareerSummary, { kind: "season" }>;
  run: CareerRun | undefined;
  playerName: string;
  playerCode: string;
  onContinue: () => void;
}> = ({ summary, run, playerName, playerCode, onContinue }) => (
  <SeasonDebriefModal
    record={summary.end.record}
    outcome={summary.end.outcome}
    parts={summary.end.parts}
    alongside={summary.end.alongside}
    run={run}
    playerName={playerName}
    playerCode={playerCode}
    onContinue={onContinue}
  />
);

export const SeasonArchiveModal: React.FC<{
  record: SeasonRecord;
  seasonNumber: number;
  run: CareerRun;
  playerName: string;
  playerCode: string;
  onClose: () => void;
}> = ({ record, seasonNumber, run, playerName, playerCode, onClose }) => {
  const series = seriesById(record.seriesId);
  const outcome: SeasonOutcomeKind = record.promoted
    ? series?.final
      ? "complete"
      : "promoted"
    : record.attempt >= MAX_ATTEMPTS
      ? "over"
      : "retry";

  return (
    <SeasonDebriefModal
      record={record}
      outcome={outcome}
      parts={record.archive?.parts ?? null}
      alongside={record.archive?.alongside ?? []}
      run={run}
      playerName={playerName}
      playerCode={playerCode}
      seasonNumber={seasonNumber}
      isArchive
      onContinue={onClose}
    />
  );
};

// ---- Start Season Confirmation Modal (lists everything that locks)

export const StartSeasonConfirmModal: React.FC<{
  open: boolean;
  series: CareerSeries;
  season: SeasonState;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, series, season, onConfirm, onCancel }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const promo = promotionPlaces(series, season.race.gridSize);
  const bonus = mulliganBonus(season.settings.mulligans);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      size="md"
      title={tx("startSeasonTitle")}
      subtitle={<span className="lc-hint">{seriesName(series, tx)}</span>}
      footer={
        <div className="flex items-center justify-end gap-2.5">
          <Button variant="ghost" size="md" onClick={onCancel}>
            {tx("close")}
          </Button>
          <Button variant="primary" size="md" icon={<Icon name="race" />} onClick={onConfirm} data-nav-default="">
            {tx("startSeasonConfirm")}
          </Button>
        </div>
      }
    >
      <p className="lc-body m-0">{tx("startSeasonLocksTitle")}</p>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Well className="flex items-center gap-3 p-3 sm:col-span-2">
          <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lc-nub bg-lc-carbon p-1">
            <SeriesCarThumb carId={season.settings.car} />
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="lc-lbl">{tx("car")}</span>
            <span className="lc-row-label truncate">{carTitle(season.settings.car)}</span>
          </div>
        </Well>

        <Well className="flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:col-span-2">
          <span className="lc-lbl">{tx("statRounds")}</span>
          <span className="lc-data text-[18px] leading-tight text-lc-chalk">
            {tx("roundsCount", { count: season.settings.circuits.length })}
          </span>
          <span className="lc-hint">
            {season.settings.circuits.map((id) => trackLabel(id).name).join(", ")}
          </span>
        </Well>
        <StatTile
          label={tx("statPromotion")}
          value={tx("topN", { place: promo })}
          sub={tx("carsCount", { count: season.race.gridSize })}
        />
        <StatTile
          label={tx("mulligans")}
          value={season.settings.mulligans}
          sub={bonus > 0 ? tx("mulliganBonusBadge", { bonus: format.number(bonus) }) : tx("mulliganBonusNone")}
        />
      </div>

      <p className="lc-hint m-0">{tx("startSeasonNote")}</p>
    </Modal>
  );
};

// ---- Season Objectives Reveal Modal (shown immediately after starting a season)

export const ObjectivesRevealModal: React.FC<{
  open: boolean;
  series: CareerSeries;
  season: SeasonState;
  onContinue: () => void;
}> = ({ open, series, season, onContinue }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const promo = promotionPlaces(series, season.race.gridSize);

  return (
    <Modal
      open={open}
      onClose={onContinue}
      size="md"
      title={tx("objectivesRevealTitle")}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="info" size="sm">
            {seriesName(series, tx)}
          </Badge>
          <span className="lc-hint">{carTitle(season.settings.car)}</span>
          <span className="lc-hint">{tx("roundsCount", { count: season.settings.circuits.length })}</span>
        </div>
      }
      footer={
        <div className="flex items-center justify-end">
          <Button variant="primary" size="md" icon={<Icon name="race" />} onClick={onContinue} data-nav-default="">
            {tx("objectivesRevealContinue")}
          </Button>
        </div>
      }
    >
      <p className="lc-body m-0">{tx("objectivesRevealDesc")}</p>

      <Well className="flex items-center justify-between gap-3 border-lc-gain/40 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Icon name="race" size="md" className="text-lc-gain" />
          <div className="flex flex-col gap-0.5">
            <span className="lc-lbl">{tx("statPromotion")}</span>
            <span className="lc-row-label">{tx("promotionTarget", { place: promo })}</span>
          </div>
        </div>
        <Badge tone="good" size="md">
          {tx("topN", { place: promo })}
        </Badge>
      </Well>

      <div className="flex flex-col gap-2">
        {season.objectives.map((obj) => (
          <Well key={obj.kind} className="flex items-center justify-between gap-3 px-4 py-3">
            <span className="text-[14px] font-medium text-lc-chalk">
              {tx(`objective.${obj.kind}`, { target: obj.target })}
            </span>
            <Badge tone="info" size="sm">
              {tx("objectivesRevealBonus", { points: format.number(2000) })}
            </Badge>
          </Well>
        ))}
      </div>
    </Modal>
  );
};

// ---- Pre-season Switch Series Modal

export const SwitchSeriesModal: React.FC<{
  open: boolean;
  choices: readonly string[];
  currentSeriesId: string;
  content: CareerContent;
  onSelect: (seriesId: string) => void;
  onClose: () => void;
}> = ({ open, choices, currentSeriesId, content, onSelect, onClose }) => {
  const tx = useTranslations("menu.career");
  const seriesList = choices.map((id) => seriesById(id)).filter((s): s is CareerSeries => Boolean(s));

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={tx("switchSeriesTitle")}
      subtitle={<span className="lc-body">{tx("switchSeriesDesc")}</span>}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" size="md" onClick={onClose}>
            {tx("close")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {seriesList.map((series) => {
          const sc = seriesContent(series, content);
          const carId = sc.cars[0] ?? series.cars[0];
          const isCurrent = series.id === currentSeriesId;
          const leadTrackId = sc.calendar[0] ?? series.calendar[0];
          return (
            <MediaTile
              key={series.id}
              chosen={isCurrent}
              navDefault={!isCurrent}
              media={
                <span className="relative block size-full">
                  <SeriesCarThumb carId={carId} />
                  {leadTrackId ? (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute end-2 bottom-2 flex items-center justify-center rounded-lc-nub border border-white/10 bg-lc-void/75 px-2 py-1"
                    >
                      <CareerCircuitOutline trackId={leadTrackId} className="h-9 w-14" strokeClassName="stroke-lc-chalk/85" />
                    </span>
                  ) : null}
                </span>
              }
              title={seriesName(series, tx)}
              meta={tx("seriesPreviewMeta", {
                rounds: sc.calendar.length,
                promote: series.promoteTop,
                grid: series.grid,
              })}
              overlay={
                isCurrent ? (
                  <Badge tone="info" variant="solid" size="sm">
                    {tx("ladderCurrent")}
                  </Badge>
                ) : (
                  <Badge tone="neutral" variant="solid" size="sm">
                    {tx("ladderOpen")}
                  </Badge>
                )
              }
              onSelect={() => {
                if (!isCurrent) onSelect(series.id);
                onClose();
              }}
            />
          );
        })}
      </div>
    </Modal>
  );
};

// ---- Unfinished Round Dialog (ConfirmDialog-style choice)

export const UnfinishedRoundDialog: React.FC<{
  mulligansLeft: number;
  onResolve: (useMulligan: boolean) => void;
}> = ({ mulligansLeft, onResolve }) => {
  const tx = useTranslations("menu.career");
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const canMulligan = mulligansLeft > 0;

  useFocusNav(sheetRef, { enabled: true, autoFocus: false });

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      sheetRef.current?.querySelector<HTMLElement>("[data-nav-default]")?.focus({ preventScroll: true }),
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Require an explicit choice so a stray Esc does not silently retire or spend a mulligan
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.key !== "Tab") return;
      e.stopImmediatePropagation();
      const items = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === items.length - 1 ? 0 : i + 1;
      e.preventDefault();
      items[next].focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-(--z-lc-notice) flex items-center justify-center bg-lc-void/72 p-4 backdrop-blur-[6px]">
      <div
        ref={sheetRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="lc-glass lc-ui-zoom lc-toast-in flex w-full max-w-[32rem] [backdrop-filter:none] flex-col gap-4 rounded-lc-sheet p-6 text-lc-chalk shadow-lc-sheet phone:p-5"
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className={cx("mt-px inline-flex shrink-0 [&_svg]:size-6", canMulligan ? "text-lc-caution" : "text-lc-crimson")}>
            <Icon name="warning" />
          </span>
          <div className="flex min-w-0 flex-col gap-2">
            <h2 id={titleId} className="lc-h3 text-[20px]">
              {tx("unfinishedTitle")}
            </h2>
            <p id={bodyId} className="lc-body m-0">
              {canMulligan ? tx("unfinishedBodyWithMulligans") : tx("unfinishedBodyNoMulligans")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
          <Button
            variant="danger"
            size="md"
            onClick={() => onResolve(false)}
            data-nav-default={canMulligan ? undefined : ""}
          >
            {tx("retireRound")}
          </Button>
          {canMulligan ? (
            <Button
              variant="primary"
              size="md"
              onClick={() => onResolve(true)}
              data-nav-default=""
            >
              {tx("useMulligan", { count: mulligansLeft })}
            </Button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
};

// ---- Pre-season Circuit Picker Modal

export const CircuitPickerModal: React.FC<{
  open: boolean;
  available: readonly string[];
  initial: readonly string[];
  needed: number;
  onApply: (circuits: string[]) => void;
  onClose: () => void;
}> = ({ open, available, initial, needed, onApply, onClose }) => {
  const tx = useTranslations("menu.career");
  const [selected, setSelected] = useState<string[]>([...initial]);

  useEffect(() => {
    if (open) setSelected([...initial]);
  }, [open, initial]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= needed) return prev;
      return [...prev, id];
    });
  };

  const exact = selected.length === needed;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={tx("circuitPickerTitle")}
      subtitle={
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="lc-body">{tx("circuitPickerSubtitle", { needed })}</span>
            <Badge tone={exact ? "good" : "warn"} size="sm">
              {tx("circuitPickerCount", { selected: selected.length, needed })}
            </Badge>
          </div>
          {exact ? <span className="lc-hint">{tx("circuitPickerFullHint")}</span> : null}
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" size="sm" icon={<Icon name="reset" />} onClick={() => setSelected(available.slice(0, needed))}>
            {tx("circuitPickerReset")}
          </Button>
          <Button
            variant="primary"
            size="md"
            disabledReason={exact ? undefined : tx("circuitPickerNeedExact", { needed })}
            onClick={() => {
              onApply(selected);
              onClose();
            }}
            data-nav-default=""
          >
            {tx("circuitPickerApply")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {available.map((trackId) => {
          const idx = selected.indexOf(trackId);
          const chosen = idx >= 0;
          const info = trackLabel(trackId);
          const full = !chosen && selected.length >= needed;
          return (
            <button
              key={trackId}
              type="button"
              aria-pressed={chosen}
              aria-disabled={full || undefined}
              data-own-ring=""
              onPointerEnter={focusOnHover}
              onClick={() => {
                if (!full) toggle(trackId);
              }}
              className={cx(
                "group relative flex min-h-26 flex-col gap-2 rounded-lc-tile border-[1.5px] p-3 text-start",
                full ? "cursor-not-allowed opacity-45" : "cursor-pointer",
                MOTION,
                chosen ? CHOSEN_TILE : IDLE_TILE,
                CURSOR_TILE,
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14px] leading-snug font-semibold text-lc-chalk">{info.name}</span>
                  <span className="lc-hint">{info.layout || info.country}</span>
                </div>
                {chosen ? (
                  <Badge tone="good" variant="solid" size="sm">
                    {tx("roundTag", { round: idx + 1 })}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="lc-mono text-[12px] text-lc-slate"><bdi>{(info.lengthM / 1000).toFixed(2)} km</bdi></span>
                <CareerCircuitOutline trackId={trackId} className="h-9 w-16 shrink-0" strokeClassName={chosen ? "stroke-lc-chalk" : "stroke-lc-slate"} />
              </div>
            </button>
          );
        })}
      </div>
    </Modal>
  );
};

// ---- Mid-season Race Settings Modal

export const RaceSettingsModal: React.FC<{
  open: boolean;
  series: CareerSeries;
  race: RaceSettings;
  warnQualifyingOff?: boolean;
  onChange: (patch: Partial<RaceSettings>) => void;
  onClose: () => void;
}> = ({ open, series, race, warnQualifyingOff, onChange, onClose }) => {
  const tx = useTranslations("menu.career");
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      title={tx("raceSettingsModalTitle")}
      headerAction={<MultiplierBadge race={race} />}
      footer={
        <div className="flex justify-end">
          <Button variant="primary" size="md" onClick={onClose} data-nav-default="">
            {tx("continue")}
          </Button>
        </div>
      }
    >
      <RaceSettingsFields
        series={series}
        race={race}
        started
        warnQualifyingOff={warnQualifyingOff}
        onChange={onChange}
      />
    </Modal>
  );
};

// ---- Series Detail Content (shared by Ladder docked side drawer and mobile Modal)

export const SeriesDetailContent: React.FC<{
  series: CareerSeries;
  content: CareerContent;
  run: CareerRun;
  compact?: boolean;
  onOpenRecord?: (record: SeasonRecord, seasonNumber: number) => void;
}> = ({ series, content, run, compact, onOpenRecord }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();

  const resolved = useMemo(() => seriesContent(series, content), [series, content]);

  const isCurrent = run.season?.seriesId === series.id;
  const liveSeason = isCurrent ? run.season : null;

  // Find the player's latest (preferring promoted) completed record for this series
  const historyMatch = useMemo(() => {
    let best: { record: SeasonRecord; seasonNumber: number } | null = null;
    run.history.forEach((rec, idx) => {
      if (rec.seriesId !== series.id) return;
      if (!best || (rec.promoted && !best.record.promoted) || rec.endedAt >= best.record.endedAt) {
        best = { record: rec, seasonNumber: idx + 1 };
      }
    });
    return best as { record: SeasonRecord; seasonNumber: number } | null;
  }, [run.history, series.id]);

  const liveStats = useMemo(() => {
    if (!liveSeason) return null;
    const total = liveSeason.settings.circuits.length;
    const raced = liveSeason.rounds.filter((r) => r !== null).length;
    const nextIdx = nextRound(liveSeason);
    const mulligansLeft = Math.max(0, liveSeason.settings.mulligans - liveSeason.mulligansUsed);
    if (!liveSeason.started) {
      return {
        started: false as const,
        total,
        raced: 0,
        nextIdx: null,
        mulligansLeft,
        mulligansTotal: liveSeason.settings.mulligans,
        attempt: liveSeason.attempt,
        promo: promotionPlaces(series, liveSeason.race.gridSize),
      };
    }
    const standings = seasonStandings(liveSeason);
    const myIdx = standings.findIndex((r) => r.who === "me");
    const myPlace = myIdx >= 0 ? myIdx + 1 : liveSeason.race.gridSize;
    const promo = promotionPlaces(series, liveSeason.race.gridSize);
    return {
      started: true as const,
      anyRaced: raced > 0,
      myPlace,
      onPace: myPlace <= promo,
      total,
      raced,
      nextIdx,
      mulligansLeft,
      mulligansTotal: liveSeason.settings.mulligans,
      attempt: liveSeason.attempt,
      promo,
    };
  }, [liveSeason, series]);

  const pitRules = RACE_LENGTHS.filter((l) => (series.stops?.[l] ?? 0) > 0).map((l) => ({
    length: raceLengthLabel(l, tx),
    stops: series.stops![l]!,
  }));

  const nextNames = series.next
    .map((id) => seriesById(id))
    .filter((s): s is CareerSeries => Boolean(s))
    .map((s) => seriesName(s, tx));

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {/* Live season status when inspecting current series */}
      {liveSeason && liveStats ? (
        <Card
          title={tx("ladderLiveSeason")}
          action={
            liveStats.started ? (
              liveStats.anyRaced ? (
                <Badge tone={liveStats.onPace ? "good" : "warn"} size="sm" icon={liveStats.onPace ? "success" : "warning"}>
                  {liveStats.onPace ? tx("promotionOnPace") : tx("promotionAtRisk")}
                </Badge>
              ) : (
                <Badge tone="info" size="sm">
                  {tx("promotionBeforeStart")}
                </Badge>
              )
            ) : (
              <Badge tone="warn" size="sm">
                {tx("preseasonBadge")}
              </Badge>
            )
          }
          bodyClassName="flex flex-col gap-2.5"
        >
          <div className="grid grid-cols-2 gap-2">
            <StatTile
              label={tx("ladderCurrentPlace")}
              value={liveStats.started && liveStats.anyRaced ? `P${liveStats.myPlace}` : tx("unranked")}
              sub={tx("topN", { place: liveStats.promo })}
            />
            <StatTile
              label={tx("ladderRound")}
              value={liveStats.started ? `${liveStats.raced}/${liveStats.total}` : tx("preseasonBadge")}
              sub={tx("attemptBadge", { attempt: liveStats.attempt, max: MAX_ATTEMPTS })}
            />
          </div>

          <Well className="flex items-center justify-between gap-2 px-3 py-2">
            <span className="lc-hint">{tx("ladderMulligans")}</span>
            <div className="flex items-center gap-1.5">
              <span className="lc-mono text-[12px] font-bold text-lc-chalk">
                {liveStats.mulligansLeft}/{liveStats.mulligansTotal}
              </span>
              {liveStats.mulligansTotal > 0 ? (
                <div className="flex items-center gap-1" aria-hidden>
                  {Array.from({ length: liveStats.mulligansTotal }, (_, i) => (
                    <span
                      key={i}
                      className={cx(
                        "size-2 rounded-full",
                        i < liveStats.mulligansLeft ? "bg-lc-chalk" : "bg-lc-line",
                      )}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </Well>
        </Card>
      ) : null}

      {/* Completed record when inspecting a done series */}
      {!liveSeason && historyMatch ? (
        <Card
          title={tx("ladderYourRecord")}
          action={
            <Badge
              tone={historyMatch.record.promoted ? "good" : "bad"}
              size="sm"
              icon={historyMatch.record.promoted ? "success" : "error"}
            >
              {historyMatch.record.promoted ? tx("historyPromoted") : tx("historyMissed")}
            </Badge>
          }
          bodyClassName="flex flex-col gap-2.5"
        >
          <div className="grid grid-cols-2 gap-2">
            <StatTile
              label={tx("colPos")}
              value={`P${historyMatch.record.position}`}
              sub={tx("historyPoints", { points: format.number(historyMatch.record.points) })}
            />
            <StatTile
              label={tx("statScore")}
              value={format.number(historyMatch.record.score)}
              sub={tx("historyWinsPodiums", {
                wins: historyMatch.record.wins,
                podiums: historyMatch.record.podiums,
              })}
            />
          </div>
          <Well className="flex items-center gap-2.5 px-3 py-2">
            <div className="relative aspect-video w-16 shrink-0 overflow-hidden rounded-lc-nub bg-lc-carbon">
              <SeriesCarThumb carId={historyMatch.record.car} />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-semibold text-lc-chalk">{carTitle(historyMatch.record.car)}</span>
              <span className="lc-hint">
                {tx("seasonNumber", { season: historyMatch.seasonNumber })} · {tx("historyObjectives", { done: historyMatch.record.objectivesDone, total: historyMatch.record.objectivesTotal })}
              </span>
            </div>
          </Well>
          {onOpenRecord ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="next" />}
              onClick={() => onOpenRecord(historyMatch.record, historyMatch.seasonNumber)}
            >
              {tx("ladderViewSummary")}
            </Button>
          ) : null}
        </Card>
      ) : null}

      {/* Series specs */}
      <div className={cx("grid grid-cols-2 gap-2", compact ? undefined : "sm:grid-cols-4")}>
        <StatTile label={tx("statGrid")} value={tx("carsCount", { count: series.grid })} />
        <StatTile label={tx("statPromotion")} value={tx("topN", { place: series.promoteTop })} />
        <StatTile label={tx("statDistance")} value={tx("kmValue", { km: series.raceKm })} />
        <StatTile label={tx("statRounds")} value={resolved.calendar.length} />
      </div>

      <Card title={tx("seriesDetailCars")}>
        <div className={cx("grid grid-cols-1 gap-2.5", !compact && series.cars.length > 1 ? "sm:grid-cols-2" : undefined)}>
          {series.cars.map((carId) => (
            <Well key={carId} className="flex items-center gap-3 p-2.5">
              <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lc-nub bg-lc-carbon">
                <SeriesCarThumb carId={carId} />
              </div>
              <span className="lc-row-label min-w-0 truncate text-[14px]">{carTitle(carId)}</span>
            </Well>
          ))}
        </div>
      </Card>

      <div className={cx("grid grid-cols-1 gap-3.5", compact ? undefined : "sm:grid-cols-2")}>
        <Card title={tx("seriesDetailCalendar")}>
          <div className="flex flex-col gap-1.5">
            {resolved.calendar.map((trackId, idx) => {
              const info = trackLabel(trackId);
              return (
                <div key={trackId} className="flex items-center justify-between gap-2 py-0.5 text-[13px]">
                  <span className="min-w-0 truncate text-lc-chalk">
                    <span className="lc-mono me-2 text-lc-slate">{idx + 1}.</span>
                    {info.full}
                  </span>
                  <span className="lc-mono shrink-0 text-[12px] text-lc-slate"><bdi>{(info.lengthM / 1000).toFixed(2)} km</bdi></span>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="flex flex-col gap-3.5">
          <Card title={tx("seriesDetailPitRules")}>
            {pitRules.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {pitRules.map((p) => (
                  <Badge key={p.length} tone="warn" size="md" icon="pitLane">
                    {p.length}: {tx("stopsCount", { count: p.stops })}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="lc-body m-0">{tx("seriesDetailPitNone")}</p>
            )}
          </Card>

          <Card title={tx("seriesDetailNext")}>
            {series.final || nextNames.length === 0 ? (
              <p className="lc-body m-0">{tx("seriesDetailFinal")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {nextNames.map((n) => (
                  <Badge key={n} tone="info" size="md">
                    {n}
                  </Badge>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

// ---- Series Detail Modal (used on phones / narrow screens from Ladder)

export const SeriesDetailModal: React.FC<{
  series: CareerSeries | null;
  content: CareerContent;
  run: CareerRun;
  canChoose: boolean;
  isSwitch: boolean;
  onChoose: (seriesId: string) => void;
  onOpenRecord?: (record: SeasonRecord, seasonNumber: number) => void;
  onClose: () => void;
}> = ({ series, content, run, canChoose, isSwitch, onChoose, onOpenRecord, onClose }) => {
  const tx = useTranslations("menu.career");

  if (!series) return null;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={seriesName(series, tx)}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" size="sm">
            {tx(`discipline.${series.discipline}`)}
          </Badge>
          <Badge tone="info" size="sm">
            {tx("tierHeading", { tier: series.tier + 1 })}
          </Badge>
        </div>
      }
      footer={
        canChoose ? (
          <div className="flex items-center justify-end gap-3">
            <Button variant="ghost" size="md" onClick={onClose}>
              {tx("close")}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<Icon name="race" />}
              onClick={() => {
                onChoose(series.id);
                onClose();
              }}
              data-nav-default=""
            >
              {isSwitch ? tx("ladderSwitchSeries") : tx("raceThisSeries")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <SeriesDetailContent
        series={series}
        content={content}
        run={run}
        onOpenRecord={onOpenRecord}
      />
    </Modal>
  );
};
