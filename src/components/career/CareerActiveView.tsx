"use client";

import React, { useMemo, useState } from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import {
  SEASON_LENGTHS,
  lapsFor,
  roundsFor,
  seriesById,
  seriesContent,
  stopsFor,
  type CareerContent,
  type CareerSeries,
  type SeasonLength,
} from "@/lib/career/ladder";
import {
  MAX_ATTEMPTS,
  MAX_MULLIGANS,
  mulliganBonus,
  nextRound,
  objectiveProgress,
  promotionPlaces,
  raceMultiplier,
  raceScore,
  seasonStandings,
  type CareerRun,
  type RaceSettings,
  type SeasonRecord,
  type SeasonSettings,
  type SeasonState,
} from "@/lib/career/career-state";
import type { CareerSummary } from "./career-screen-types";
import { focusOnHover } from "@/components/menu/useFocusNav";
import {
  Button,
  Card,
  EmptyState,
  MediaTile,
  Meter,
  OptionTile,
  OptionTileGroup,
  Segmented,
  SettingRow,
  Stepper,
  Well,
  cx,
} from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { CURSOR_TILE, IDLE_TILE, MOTION } from "@/components/ui/styles";
import {
  CareerCircuitOutline,
  CareerPathStrip,
  MultiplierBadge,
  ObjectiveRow,
  RaceSettingsFields,
  SeriesCarThumb,
  StandingsTable,
  StatTile,
  carTitle,
  driverDisplay,
  seriesName,
  trackLabel,
} from "./career-ui";
import {
  CircuitPickerModal,
  ObjectivesRevealModal,
  RaceSettingsModal,
  RaceSummaryModal,
  SeasonArchiveModal,
  StartSeasonConfirmModal,
  SwitchSeriesModal,
} from "./CareerModals";
import { CareerLadderView } from "./CareerLadderView";
import { TestDayCard } from "./TestDayCard";

export type CareerTab = "season" | "ladder" | "history";

export const CareerActiveView: React.FC<{
  run: CareerRun;
  tab: CareerTab;
  content: CareerContent;
  playerName: string;
  playerCode: string;
  objectivesReveal?: boolean;
  onDismissObjectivesReveal?: () => void;
  onUpdateSeasonSettings: (patch: Partial<SeasonSettings>) => void;
  onUpdateRaceSettings: (patch: Partial<RaceSettings>) => void;
  onStartSeason: () => void;
  onChooseSeries: (seriesId: string) => void;
  onRaceNext: () => void;
  onTestDay: () => void;
  onGoToTab: (tab: CareerTab) => void;
  onBackToHome: () => void;
}> = ({
  run,
  tab,
  content,
  playerName,
  playerCode,
  objectivesReveal,
  onDismissObjectivesReveal,
  onUpdateSeasonSettings,
  onUpdateRaceSettings,
  onStartSeason,
  onChooseSeries,
  onRaceNext,
  onTestDay,
  onGoToTab,
  onBackToHome,
}) => {
  if (tab === "ladder") {
    return (
      <CareerLadderView
        run={run}
        content={content}
        playerName={playerName}
        playerCode={playerCode}
        onChooseSeries={(seriesId) => {
          onChooseSeries(seriesId);
          onGoToTab("season");
        }}
      />
    );
  }
  if (tab === "history") {
    return <CareerHistoryTab run={run} playerName={playerName} playerCode={playerCode} />;
  }
  return (
    <CareerSeasonTab
      run={run}
      content={content}
      playerName={playerName}
      playerCode={playerCode}
      objectivesReveal={objectivesReveal}
      onDismissObjectivesReveal={onDismissObjectivesReveal}
      onUpdateSeasonSettings={onUpdateSeasonSettings}
      onUpdateRaceSettings={onUpdateRaceSettings}
      onStartSeason={onStartSeason}
      onChooseSeries={onChooseSeries}
      onRaceNext={onRaceNext}
      onTestDay={onTestDay}
      onGoToTab={onGoToTab}
      onBackToHome={onBackToHome}
    />
  );
};

// ---- Season Tab

const CareerSeasonTab: React.FC<{
  run: CareerRun;
  content: CareerContent;
  playerName: string;
  playerCode: string;
  objectivesReveal?: boolean;
  onDismissObjectivesReveal?: () => void;
  onUpdateSeasonSettings: (patch: Partial<SeasonSettings>) => void;
  onUpdateRaceSettings: (patch: Partial<RaceSettings>) => void;
  onStartSeason: () => void;
  onChooseSeries: (seriesId: string) => void;
  onRaceNext: () => void;
  onTestDay: () => void;
  onGoToTab: (tab: CareerTab) => void;
  onBackToHome: () => void;
}> = ({
  run,
  content,
  playerName,
  playerCode,
  objectivesReveal,
  onDismissObjectivesReveal,
  onUpdateSeasonSettings,
  onUpdateRaceSettings,
  onStartSeason,
  onChooseSeries,
  onRaceNext,
  onTestDay,
  onGoToTab,
  onBackToHome,
}) => {
  if (run.season) {
    const series = seriesById(run.season.seriesId);
    if (!series) return null;
    if (!run.season.started) {
      return (
        <PreSeasonView
          run={run}
          season={run.season}
          series={series}
          content={content}
          onUpdateSeasonSettings={onUpdateSeasonSettings}
          onUpdateRaceSettings={onUpdateRaceSettings}
          onStartSeason={onStartSeason}
          onChooseSeries={onChooseSeries}
          onTestDay={onTestDay}
          onOpenLadder={() => onGoToTab("ladder")}
        />
      );
    }
    return (
      <>
        <ActiveSeasonView
          run={run}
          season={run.season}
          series={series}
          playerName={playerName}
          playerCode={playerCode}
          onUpdateRaceSettings={onUpdateRaceSettings}
          onRaceNext={onRaceNext}
          onTestDay={onTestDay}
          onOpenLadder={() => onGoToTab("ladder")}
        />
        <ObjectivesRevealModal
          open={Boolean(objectivesReveal && run.season.objectives.length > 0)}
          series={series}
          season={run.season}
          onContinue={() => onDismissObjectivesReveal?.()}
        />
      </>
    );
  }

  if (run.choices.length > 0) {
    return <ChooseNextSeriesView run={run} content={content} onChooseSeries={onChooseSeries} />;
  }

  return <CareerEndView run={run} onGoToTab={onGoToTab} onBackToHome={onBackToHome} />;
};

// ---- Pre-season

const PreSeasonView: React.FC<{
  run: CareerRun;
  season: SeasonState;
  series: CareerSeries;
  content: CareerContent;
  onUpdateSeasonSettings: (patch: Partial<SeasonSettings>) => void;
  onUpdateRaceSettings: (patch: Partial<RaceSettings>) => void;
  onStartSeason: () => void;
  onChooseSeries: (seriesId: string) => void;
  onTestDay: () => void;
  onOpenLadder: () => void;
}> = ({
  run,
  season,
  series,
  content,
  onUpdateSeasonSettings,
  onUpdateRaceSettings,
  onStartSeason,
  onChooseSeries,
  onTestDay,
  onOpenLadder,
}) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const [confirmStart, setConfirmStart] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

  const avail = useMemo(() => seriesContent(series, content), [series, content]);
  const promo = promotionPlaces(series, season.race.gridSize);
  const requiredStops = series.stops?.[season.race.raceLength] ?? 0;
  const seasonNum = run.history.length + 1;
  const neededRounds = roundsFor(season.settings.length, avail.calendar.length);
  const liveMulliganBonus = mulliganBonus(season.settings.mulligans);
  const canSwitchSeries = run.choices.filter((id) => id !== season.seriesId).length > 0;

  const lengthLabel = (len: SeasonLength) => {
    const label =
      len === "short"
        ? tx("lengthShort")
        : len === "medium"
          ? tx("lengthMedium")
          : len === "long"
            ? tx("lengthLong")
            : tx("lengthFull");
    return tx("lengthWithRounds", { label, rounds: roundsFor(len, avail.calendar.length) });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 short:gap-2.5">
      <CareerPathStrip run={run} currentSeries={series} onOpenLadder={onOpenLadder} />

      {/* Series Hero */}
      <section className="lc-glass relative overflow-hidden rounded-lc-card p-5 phone:p-4 short:p-3">
        <div className="grid grid-cols-1 items-center gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.95fr)] short:gap-3">
          <div className="flex min-w-0 flex-col gap-3.5 short:gap-2">
            <div className="flex flex-col gap-1.5 short:gap-1">
              <h2 className="lc-h2 m-0 text-lc-chalk short:text-[22px]">{seriesName(series, tx)}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <span className="lc-body">{carTitle(season.settings.car)}</span>
                <Badge tone="warn" size="sm">
                  {tx("preseasonBadge")}
                </Badge>
                <Badge tone="neutral" size="sm">
                  {tx("seasonNumber", { season: seasonNum })}
                </Badge>
                {season.attempt > 1 ? (
                  <Badge tone="bad" size="sm">
                    {tx("attemptBadge", { attempt: season.attempt, max: MAX_ATTEMPTS })}
                  </Badge>
                ) : null}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 short:gap-2">
              <StatTile label={tx("statRounds")} value={season.settings.circuits.length} />
              <StatTile label={tx("statPromotion")} value={tx("topN", { place: promo })} />
              <StatTile label={tx("statPitStops")} value={tx("stopsCount", { count: requiredStops })} />
              <StatTile label={tx("statGrid")} value={tx("carsCount", { count: season.race.gridSize })} />
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-1 short:pt-0">
              <Button
                variant="primary"
                size="lg"
                icon={<Icon name="race" />}
                onClick={() => setConfirmStart(true)}
                data-nav-default=""
              >
                {tx("startSeason")}
              </Button>
              {canSwitchSeries ? (
                <Button variant="ghost" size="md" icon={<Icon name="browse" />} onClick={() => setSwitchOpen(true)}>
                  {tx("switchSeries")}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="relative aspect-video w-full overflow-hidden rounded-lc-tile border border-lc-line bg-lc-well p-3 short:hidden">
            <SeriesCarThumb carId={season.settings.car} />
          </div>
        </div>
      </section>

      {/* The pre-season test: optional, before Round 1 */}
      <TestDayCard season={season} onTestDay={onTestDay} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 short:gap-3">
        {/* Season settings */}
        <Card title={tx("seasonSettings")}>
          {avail.cars.length > 1 ? (
            <SettingRow label={tx("car")} hint={tx("carHint")} stacked>
              <OptionTileGroup columns={2} aria-label={tx("car")} className="w-full">
                {avail.cars.map((carId) => (
                  <OptionTile
                    key={carId}
                    checked={season.settings.car === carId}
                    title={carTitle(carId)}
                    media={
                      <span className="relative block aspect-video w-full overflow-hidden rounded-lc-nub bg-lc-well p-2">
                        <SeriesCarThumb carId={carId} />
                      </span>
                    }
                    onSelect={() => onUpdateSeasonSettings({ car: carId })}
                  />
                ))}
              </OptionTileGroup>
            </SettingRow>
          ) : null}

          <SettingRow label={tx("seasonLength")} hint={tx("seasonLengthHint")} stacked>
            <Segmented
              size="sm"
              fill
              options={SEASON_LENGTHS.map((id) => ({ id, label: lengthLabel(id) }))}
              value={season.settings.length}
              onChange={(length) => onUpdateSeasonSettings({ length })}
            />
          </SettingRow>

          <SettingRow
            label={tx("circuits")}
            hint={tx("circuitsHint", { count: season.settings.circuits.length })}
            stacked
          >
            <div className="flex w-full flex-col gap-2.5">
              <div className="flex flex-wrap gap-1.5">
                {season.settings.circuits.map((trackId, idx) => (
                  <Badge key={trackId} tone="neutral" size="md">
                    {tx("roundTag", { round: idx + 1 })} · {trackLabel(trackId).name}
                  </Badge>
                ))}
              </div>
              <div>
                <Button variant="secondary" size="sm" icon={<Icon name="circuit" />} onClick={() => setPickerOpen(true)}>
                  {tx("pickCircuits")}
                </Button>
              </div>
            </div>
          </SettingRow>

          <SettingRow label={tx("mulligans")} hint={tx("mulligansHint")}>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge tone={liveMulliganBonus > 0 ? "good" : "neutral"} size="sm">
                {liveMulliganBonus > 0
                  ? tx("mulliganBonusBadge", { bonus: format.number(liveMulliganBonus) })
                  : tx("mulliganBonusNone")}
              </Badge>
              <Stepper
                min={0}
                max={MAX_MULLIGANS}
                value={season.settings.mulligans}
                onChange={(mulligans) => onUpdateSeasonSettings({ mulligans })}
              />
            </div>
          </SettingRow>
        </Card>

        {/* Race settings */}
        <Card title={tx("raceSettings")} action={<MultiplierBadge race={season.race} />}>
          <RaceSettingsFields series={series} race={season.race} started={false} onChange={onUpdateRaceSettings} />
        </Card>
      </div>

      <CircuitPickerModal
        open={pickerOpen}
        available={avail.calendar}
        initial={season.settings.circuits}
        needed={neededRounds}
        onApply={(circuits) => onUpdateSeasonSettings({ circuits })}
        onClose={() => setPickerOpen(false)}
      />

      <StartSeasonConfirmModal
        open={confirmStart}
        series={series}
        season={season}
        onCancel={() => setConfirmStart(false)}
        onConfirm={() => {
          setConfirmStart(false);
          onStartSeason();
        }}
      />

      {canSwitchSeries ? (
        <SwitchSeriesModal
          open={switchOpen}
          choices={run.choices}
          currentSeriesId={season.seriesId}
          content={content}
          onSelect={onChooseSeries}
          onClose={() => setSwitchOpen(false)}
        />
      ) : null}
    </div>
  );
};

// ---- Active (Started) Season

const ActiveSeasonView: React.FC<{
  run: CareerRun;
  season: SeasonState;
  series: CareerSeries;
  playerName: string;
  playerCode: string;
  onUpdateRaceSettings: (patch: Partial<RaceSettings>) => void;
  onRaceNext: () => void;
  onTestDay: () => void;
  onOpenLadder: () => void;
}> = ({ run, season, series, playerName, playerCode, onUpdateRaceSettings, onRaceNext, onTestDay, onOpenLadder }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const [raceSettingsOpen, setRaceSettingsOpen] = useState(false);
  const [inspectRoundIdx, setInspectRoundIdx] = useState<number | null>(null);

  const standings = useMemo(() => seasonStandings(season), [season]);
  const promo = promotionPlaces(series, season.race.gridSize);
  const myIndex = standings.findIndex((r) => r.who === "me");
  const myPlace = myIndex >= 0 ? myIndex + 1 : season.race.gridSize;
  const myRow = standings[myIndex];
  const anyRaced = season.rounds.some((r) => r !== null);
  const onPace = myPlace <= promo;

  const nextIdx = nextRound(season);
  const totalRounds = season.settings.circuits.length;
  const racedCount = season.rounds.filter((r) => r !== null).length;
  const nextTrackId = nextIdx !== null ? season.settings.circuits[nextIdx] : season.settings.circuits[totalRounds - 1];
  const nextTrack = trackLabel(nextTrackId);
  const nextLaps = lapsFor(series, season.race.raceLength, nextTrack.lengthM);
  const nextStops = stopsFor(series, season.race.raceLength, nextLaps);
  const mulligansLeft = Math.max(0, season.settings.mulligans - season.mulligansUsed);

  const warnQualifyingOff = useMemo(
    () =>
      season.race.qualifying === 0 &&
      season.objectives.some((o) => {
        if (o.kind !== "poleThreat" && o.kind !== "qualifyPro") return false;
        const p = objectiveProgress(o, season);
        return !p.done && !p.failed;
      }),
    [season],
  );

  // Build read-only RaceSummary when inspecting a past schedule round
  const inspectedRoundSummary = useMemo<Extract<CareerSummary, { kind: "race" }> | null>(() => {
    if (inspectRoundIdx === null) return null;
    const res = season.rounds[inspectRoundIdx];
    if (!res) return null;
    const before =
      inspectRoundIdx > 0
        ? seasonStandings({
            ...season,
            rounds: season.rounds.map((r, i) => (i < inspectRoundIdx ? r : null)),
          })
        : [];
    const after = seasonStandings({
      ...season,
      rounds: season.rounds.map((r, i) => (i <= inspectRoundIdx ? r : null)),
    });
    return {
      kind: "race",
      runId: run.id,
      seriesId: season.seriesId,
      roundIndex: inspectRoundIdx,
      rounds: totalRounds,
      result: res,
      parts: raceScore(res, season.race.gridSize, season.race),
      before,
      after,
      promotion: promo,
    };
  }, [inspectRoundIdx, season, run.id, totalRounds, promo]);

  // Gap to promotion cut
  let cutNote: string | null = null;
  if (anyRaced && myRow) {
    if (onPace) {
      const firstOut = standings[promo];
      if (firstOut) {
        const margin = myRow.points - firstOut.points;
        cutNote = margin > 0 ? tx("promotionSafeMargin", { points: margin }) : tx("promotionTied", { place: promo });
      }
    } else {
      const cutDriver = standings[promo - 1];
      if (cutDriver) {
        const deficit = cutDriver.points - myRow.points;
        cutNote = deficit > 0 ? tx("promotionPointsNeeded", { points: deficit, place: promo }) : tx("promotionTied", { place: promo });
      }
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-5 short:gap-2.5">
      <CareerPathStrip run={run} currentSeries={series} onOpenLadder={onOpenLadder} />

      {/* Top Row: Next Race Hero + Promotion Fight */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.55fr)_minmax(290px,0.9fr)] short:gap-2.5">
        {/* Next Race Hero */}
        <section className="lc-glass relative flex min-w-0 flex-col justify-between gap-4 overflow-hidden rounded-lc-card p-5 phone:p-4 short:gap-2 short:p-3">
          <div className="flex flex-col gap-3 short:gap-2">
            <div className="flex flex-col gap-1.5 short:gap-1">
              <h2 className="lc-h2 m-0 text-lc-chalk short:text-[22px]">{nextTrack.name}</h2>
              <div className="flex flex-wrap items-center gap-2 short:gap-1.5">
                <Badge tone="info" size="sm">
                  {tx("roundOf", { round: (nextIdx ?? totalRounds - 1) + 1, total: totalRounds })}
                </Badge>
                <Badge tone="neutral" size="sm">
                  {seriesName(series, tx)}
                </Badge>
                <span className="lc-body short:text-[13px]">
                  {nextTrack.layout ? `${nextTrack.layout} · ${carTitle(season.settings.car)}` : carTitle(season.settings.car)}
                </span>
                {season.settings.mulligans > 0 ? (
                  <Badge tone={mulligansLeft > 0 ? "neutral" : "warn"} size="sm">
                    {tx("mulligansLeft", { left: mulligansLeft, total: season.settings.mulligans })}
                  </Badge>
                ) : null}
              </div>
            </div>

            {/* Circuit outline + Car render side-by-side showcase */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] short:gap-2">
              <Well className="relative flex aspect-video items-center justify-center overflow-hidden p-4 short:aspect-auto short:h-16 short:p-2">
                <CareerCircuitOutline
                  trackId={nextTrackId}
                  className="max-h-full max-w-full"
                  strokeClassName="stroke-lc-chalk"
                  label={nextTrack.name}
                />
                <span className="lc-mono absolute bottom-2 end-2.5 text-[11px] font-bold text-lc-slate short:bottom-1 short:end-2">
                  <bdi>{(nextTrack.lengthM / 1000).toFixed(2)} km</bdi>
                </span>
              </Well>
              <Well className="relative aspect-video overflow-hidden p-3 short:aspect-auto short:h-16 short:p-1.5">
                <SeriesCarThumb carId={season.settings.car} />
              </Well>
            </div>

            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 short:gap-2">
              <StatTile label={tx("statLaps")} value={nextLaps} />
              <StatTile label={tx("statPitStops")} value={tx("stopsCount", { count: nextStops })} />
              <StatTile
                label={tx("statQualifying")}
                value={
                  season.race.qualifying === 0
                    ? tx("qualifyingOff")
                    : tx("qualifyingMinutes", { minutes: season.race.qualifying })
                }
              />
              <StatTile label={tx("statMultiplier")} value={`${raceMultiplier(season.race)}×`} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1 short:gap-2 short:pt-0">
            {nextIdx !== null ? (
              <Button
                variant="primary"
                size="lg"
                icon={<Icon name="race" />}
                onClick={onRaceNext}
                data-nav-default=""
              >
                {tx("raceRound", { round: nextIdx + 1 })}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="md"
              icon={<Icon name="options" />}
              onClick={() => setRaceSettingsOpen(true)}
            >
              {tx("raceSettings")}
            </Button>
          </div>
        </section>

        {/* Promotion Fight Card */}
        <Card
          title={tx("promotionTitle")}
          action={
            anyRaced ? (
              <Badge tone={onPace ? "good" : "warn"} size="md" icon={onPace ? "success" : "warning"}>
                {onPace ? tx("promotionOnPace") : tx("promotionAtRisk")}
              </Badge>
            ) : (
              <Badge tone="info" size="md">
                {tx("promotionBeforeStart")}
              </Badge>
            )
          }
          bodyClassName="flex flex-1 flex-col justify-between gap-3.5"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {anyRaced ? (
                <PositionBadge position={myPlace} player size="lg" />
              ) : (
                <Badge tone="neutral" size="lg" className="lc-mono">
                  {tx("unranked")}
                </Badge>
              )}
              <div className="flex flex-col gap-0.5">
                <span className="lc-row-label">{tx("promotionTarget", { place: promo })}</span>
                <span className="lc-hint">
                  {cutNote ?? tx("historyPoints", { points: format.number(myRow?.points ?? 0) })}
                </span>
              </div>
            </div>
            <div className="text-end">
              <span className="lc-data text-[20px] text-lc-chalk">{format.number(myRow?.points ?? 0)}</span>
              <span className="lc-lbl block">{tx("colPoints")}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <StatTile label={tx("statWins")} value={myRow?.wins ?? 0} />
            <StatTile label={tx("statPodiums")} value={myRow?.podiums ?? 0} />
          </div>

          <Well className="flex flex-col gap-2 px-3.5 py-2.5">
            <Meter
              stacked
              label={tx("promotionProgress", { raced: racedCount, total: totalRounds })}
              value={totalRounds > 0 ? racedCount / totalRounds : 0}
              detail={`${racedCount}/${totalRounds}`}
              tone={!anyRaced ? "info" : onPace ? "good" : "warn"}
            />
          </Well>

          <Well className="flex flex-col gap-2 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="lc-field-label">{tx("attemptBadge", { attempt: season.attempt, max: MAX_ATTEMPTS })}</span>
              <div className="flex items-center gap-1.5" aria-hidden>
                {Array.from({ length: MAX_ATTEMPTS }, (_, i) => {
                  const n = i + 1;
                  const used = n < season.attempt;
                  const current = n === season.attempt;
                  return (
                    <span
                      key={n}
                      className={cx(
                        "h-2.5 w-6 rounded-full border",
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
            <span className="lc-hint">{tx("promotionAttemptsHint", { max: MAX_ATTEMPTS })}</span>
          </Well>
        </Card>
      </div>

      {/* Main Body: Standings + Objectives & Schedule */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] short:gap-3">
        <Card title={tx("standingsTitle")}>
          <StandingsTable
            rows={standings}
            promotion={promo}
            rivals={run.rivals}
            playerName={playerName}
            playerCode={playerCode}
          />
        </Card>

        <div className="flex min-w-0 flex-col gap-5 short:gap-3">
          {nextIdx !== null ? <TestDayCard season={season} onTestDay={onTestDay} compact /> : null}

          <Card title={tx("objectivesTitle")} bodyClassName="flex flex-col gap-2">
            {season.objectives.map((obj) => (
              <ObjectiveRow key={obj.kind} objective={obj} season={season} />
            ))}
          </Card>

          <Card title={tx("scheduleTitle")} bodyClassName="flex flex-col gap-1.5">
            {season.settings.circuits.map((trackId, idx) => {
              const res = season.rounds[idx];
              const isNext = idx === nextIdx;
              const info = trackLabel(trackId);
              const winnerLine = res?.lines.find((l) => l.position === 1);
              const winnerCode = winnerLine
                ? driverDisplay(run.rivals, winnerLine.who, playerName, playerCode).code
                : null;

              if (res) {
                return (
                  <button
                    key={`${trackId}-${idx}`}
                    type="button"
                    data-own-ring=""
                    onPointerEnter={focusOnHover}
                    onClick={() => setInspectRoundIdx(idx)}
                    className={cx(
                      "group flex min-h-11 w-full cursor-pointer items-center justify-between gap-2.5 rounded-lc-row border-[1.5px] px-3 py-2 text-start",
                      MOTION,
                      IDLE_TILE,
                      CURSOR_TILE,
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="lc-mono w-7 shrink-0 text-[12px] font-bold text-lc-slate">
                        {tx("roundTag", { round: idx + 1 })}
                      </span>
                      <CareerCircuitOutline
                        trackId={trackId}
                        className="h-6 w-10 shrink-0 phone:hidden"
                        strokeClassName="stroke-lc-slate"
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-[14px] font-semibold text-lc-chalk">{info.name}</span>
                        <span className="lc-hint truncate">
                          {winnerCode ? tx("scheduleWinner", { code: winnerCode }) : info.layout}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {res.dnf ? (
                        <Badge tone="bad" size="sm">
                          {tx("scheduleDnf")}
                        </Badge>
                      ) : (
                        <PositionBadge position={res.position} size="sm" />
                      )}
                      <span className="lc-data text-[13px] text-lc-fog">
                        {tx("schedulePoints", { points: res.points })}
                      </span>
                      <Icon name="next" size="xs" className="text-lc-slate group-hover:text-lc-chalk group-focus:text-lc-chalk" />
                    </div>
                  </button>
                );
              }

              return (
                <div
                  key={`${trackId}-${idx}`}
                  className={cx(
                    "flex min-h-11 items-center justify-between gap-2.5 rounded-lc-row border px-3 py-2",
                    isNext
                      ? "border-lc-chalk/40 bg-lc-titanium/80"
                      : "border-lc-line/70 bg-lc-well/70",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="lc-mono w-7 shrink-0 text-[12px] font-bold text-lc-slate">
                      {tx("roundTag", { round: idx + 1 })}
                    </span>
                    <CareerCircuitOutline
                      trackId={trackId}
                      className="h-6 w-10 shrink-0 phone:hidden"
                      strokeClassName={isNext ? "stroke-lc-chalk" : "stroke-lc-slate"}
                    />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-[14px] font-semibold text-lc-chalk">{info.name}</span>
                      {info.layout ? <span className="lc-hint truncate">{info.layout}</span> : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isNext ? (
                      <Badge tone="info" size="sm">
                        {tx("scheduleNext")}
                      </Badge>
                    ) : (
                      <span className="lc-hint">{tx("scheduleUpcoming")}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        </div>
      </div>

      <RaceSettingsModal
        open={raceSettingsOpen}
        series={series}
        race={season.race}
        warnQualifyingOff={warnQualifyingOff}
        onChange={onUpdateRaceSettings}
        onClose={() => setRaceSettingsOpen(false)}
      />

      {inspectedRoundSummary ? (
        <RaceSummaryModal
          summary={inspectedRoundSummary}
          run={run}
          playerName={playerName}
          playerCode={playerCode}
          seasonOverride={season}
          readOnly
          onContinue={() => setInspectRoundIdx(null)}
        />
      ) : null}
    </div>
  );
};

// ---- Between seasons: Choose next series

const ChooseNextSeriesView: React.FC<{
  run: CareerRun;
  content: CareerContent;
  onChooseSeries: (seriesId: string) => void;
}> = ({ run, content, onChooseSeries }) => {
  const tx = useTranslations("menu.career");
  const choices = run.choices
    .map((id) => seriesById(id))
    .filter((s): s is CareerSeries => Boolean(s));

  return (
    <Card
      title={tx("chooseNextTitle")}
      description={tx("chooseNextDesc")}
      bodyClassName="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {choices.map((series, idx) => {
        const sc = seriesContent(series, content);
        const carId = sc.cars[0] ?? series.cars[0];
        const anyStops = Object.values(series.stops ?? {}).some((n) => (n ?? 0) > 0);
        return (
          <MediaTile
            key={series.id}
            navDefault={idx === 0}
            media={<SeriesCarThumb carId={carId} />}
            title={seriesName(series, tx)}
            meta={tx("seriesPreviewMeta", {
              rounds: sc.calendar.length,
              promote: series.promoteTop,
              grid: series.grid,
            })}
            overlay={
              <Badge tone="info" variant="solid" size="sm">
                {tx("tierHeading", { tier: series.tier + 1 })}
              </Badge>
            }
            badges={
              <>
                <Badge tone="good" size="sm" icon="race">
                  {tx("topN", { place: series.promoteTop })}
                </Badge>
                {anyStops ? (
                  <Badge tone="warn" size="sm" icon="pitLane">
                    {tx("statPitStops")}
                  </Badge>
                ) : null}
              </>
            }
            onSelect={() => onChooseSeries(series.id)}
          />
        );
      })}
    </Card>
  );
};

// ---- Career Complete / Over

const CareerEndView: React.FC<{
  run: CareerRun;
  onGoToTab: (tab: CareerTab) => void;
  onBackToHome: () => void;
}> = ({ run, onGoToTab, onBackToHome }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const complete = run.status === "complete";
  const wins = run.history.reduce((a, h) => a + h.wins, 0);
  const podiums = run.history.reduce((a, h) => a + h.podiums, 0);
  const promotions = run.history.filter((h) => h.promoted).length;

  return (
    <section className="lc-glass flex flex-col gap-5 rounded-lc-card p-6 phone:p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h2 className="lc-h2 m-0 text-lc-chalk">
            {complete ? tx("careerCompleteTitle") : tx("careerOverTitle")}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={complete ? "best" : "bad"} variant="solid" size="md" icon={complete ? "challenge" : "error"}>
              {complete ? tx("statusComplete") : tx("statusOver")}
            </Badge>
            <Badge tone="neutral" size="md">
              {tx(`discipline.${run.discipline}`)}
            </Badge>
          </div>
          <p className="lc-body m-0 max-w-[58ch]">
            {complete
              ? tx("careerCompleteBody", { discipline: tx(`discipline.${run.discipline}`) })
              : tx("careerOverBody", { max: MAX_ATTEMPTS })}
          </p>
        </div>

        <Well className="flex flex-col items-end gap-0.5 px-5 py-3">
          <span className="lc-lbl">{tx("careerScore")}</span>
          <span className="lc-data text-[28px] leading-none text-lc-volt">{format.number(run.score)}</span>
        </Well>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label={tx("statSeasons")} value={run.history.length} />
        <StatTile label={tx("statPromotions")} value={promotions} />
        <StatTile label={tx("statWins")} value={wins} />
        <StatTile label={tx("statPodiums")} value={podiums} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="md" icon={<Icon name="back" />} onClick={onBackToHome} data-nav-default="">
          {tx("backToCareers")}
        </Button>
        <Button variant="secondary" size="md" onClick={() => onGoToTab("history")}>
          {tx("tabHistory")}
        </Button>
        <Button variant="ghost" size="md" onClick={() => onGoToTab("ladder")}>
          {tx("tabLadder")}
        </Button>
      </div>
    </section>
  );
};

// ---- History Tab

const CareerHistoryTab: React.FC<{
  run: CareerRun;
  playerName: string;
  playerCode: string;
}> = ({ run, playerName, playerCode }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const [inspecting, setInspecting] = useState<{ record: SeasonRecord; seasonNumber: number } | null>(null);

  const totalWins = run.history.reduce((a, h) => a + h.wins, 0);
  const totalPodiums = run.history.reduce((a, h) => a + h.podiums, 0);
  const totalPromotions = run.history.filter((h) => h.promoted).length;
  const totalRaces = run.history.reduce((a, h) => a + h.rounds, 0);

  return (
    <div className="flex min-w-0 flex-col gap-5 short:gap-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
        <StatTile label={tx("statSeasons")} value={run.history.length} />
        <StatTile label={tx("historyStatRaces")} value={totalRaces} />
        <StatTile label={tx("statPromotions")} value={totalPromotions} />
        <StatTile label={tx("statWins")} value={totalWins} />
        <StatTile label={tx("statPodiums")} value={totalPodiums} />
      </div>

      <Card title={tx("historyTitle")} bodyClassName="flex flex-col gap-2.5">
        {run.history.length === 0 ? (
          <EmptyState icon={<Icon name="challenge" />}>{tx("historyEmpty")}</EmptyState>
        ) : (
          [...run.history].reverse().map((record, revIdx) => {
            const seasonNum = run.history.length - revIdx;
            const series = seriesById(record.seriesId);
            const title = series ? seriesName(series, tx) : record.seriesId;
            return (
              <button
                key={`${record.seriesId}-${record.endedAt}-${seasonNum}`}
                type="button"
                aria-label={tx("historyRowAria", { series: title, season: seasonNum, place: record.position })}
                data-own-ring=""
                data-nav-default={revIdx === 0 ? "" : undefined}
                onPointerEnter={focusOnHover}
                onClick={() => setInspecting({ record, seasonNumber: seasonNum })}
                className={cx(
                  "group flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 rounded-lc-row border-[1.5px] px-4 py-3 text-start",
                  MOTION,
                  IDLE_TILE,
                  CURSOR_TILE,
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <PositionBadge position={record.position} size="md" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="lc-row-label truncate">{title}</span>
                      <Badge tone={record.promoted ? "good" : "bad"} size="sm" icon={record.promoted ? "success" : "error"}>
                        {record.promoted ? tx("historyPromoted") : tx("historyMissed")}
                      </Badge>
                    </div>
                    <span className="lc-hint">
                      {tx("seasonNumber", { season: seasonNum })} · {tx("attemptBadge", { attempt: record.attempt, max: MAX_ATTEMPTS })} · {carTitle(record.car)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span className="lc-data text-[13px] text-lc-chalk">
                    {tx("historyPoints", { points: format.number(record.points) })}
                  </span>
                  <span className="lc-mono text-[12px] text-lc-fog">
                    {tx("historyWinsPodiums", { wins: record.wins, podiums: record.podiums })}
                  </span>
                  <span className="lc-mono text-[12px] text-lc-fog">
                    {tx("historyObjectives", { done: record.objectivesDone, total: record.objectivesTotal })}
                  </span>
                  <span className="lc-mono text-[12px] text-lc-slate">
                    {tx("historyMulligans", { count: record.mulligansUsed })}
                  </span>
                  <Badge tone="info" size="md">
                    {format.number(record.score)}
                  </Badge>
                  <Icon name="next" size="sm" className="text-lc-slate group-hover:text-lc-chalk group-focus:text-lc-chalk" />
                </div>
              </button>
            );
          })
        )}
      </Card>

      {inspecting ? (
        <SeasonArchiveModal
          record={inspecting.record}
          seasonNumber={inspecting.seasonNumber}
          run={run}
          playerName={playerName}
          playerCode={playerCode}
          onClose={() => setInspecting(null)}
        />
      ) : null}
    </div>
  );
};
