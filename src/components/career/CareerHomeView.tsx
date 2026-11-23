"use client";

import React, { useState } from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import {
  CAREER_DISCIPLINES,
  seriesAvailable,
  seriesById,
  seriesContent,
  startingSeries,
  type CareerContent,
  type CareerDisciplineId,
} from "@/lib/career/ladder";
import { nextRound, type CareerRun } from "@/lib/career/career-state";
import { Card, ConfirmDialog, IconButton, MediaTile, OptionTile, OptionTileGroup } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";
import { CareerCircuitOutline, SeriesCarThumb, coverCarForRun, seriesName, trackLabel } from "./career-ui";

export const CareerHomeView: React.FC<{
  runs: readonly CareerRun[];
  content: CareerContent;
  onOpenRun: (run: CareerRun) => void;
  onStartCareer: (discipline: CareerDisciplineId, seriesId: string) => void;
  onDeleteRun: (id: string) => void;
}> = ({ runs, content, onOpenRun, onStartCareer, onDeleteRun }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const [discipline, setDiscipline] = useState<CareerDisciplineId>("road");
  const [confirmDelete, setConfirmDelete] = useState<CareerRun | null>(null);

  const activeRuns = runs.filter((r) => r.status === "active");
  const finishedRuns = runs.filter((r) => r.status !== "active");
  const starters = startingSeries(discipline);

  const runSeriesTitle = (run: CareerRun): string => {
    if (run.season) {
      const s = seriesById(run.season.seriesId);
      if (s) return seriesName(s, tx);
    }
    if (run.choices.length > 0) {
      const s = seriesById(run.choices[0]);
      if (s) return tx("chooseNextTitle");
    }
    if (run.history.length > 0) {
      const s = seriesById(run.history[run.history.length - 1].seriesId);
      if (s) return seriesName(s, tx);
    }
    return tx(`discipline.${run.discipline}`);
  };

  const runProgressLine = (run: CareerRun): string => {
    const seasonNum = run.history.length + 1;
    if (!run.season) {
      return tx("seasonNextSeries", { season: seasonNum });
    }
    if (!run.season.started) {
      return tx("seasonPreseason", { season: seasonNum });
    }
    const idx = nextRound(run.season);
    const total = run.season.settings.circuits.length;
    const roundNum = idx === null ? total : idx + 1;
    return tx("seasonRound", { season: seasonNum, round: roundNum, total });
  };

  return (
    <div className="flex min-w-0 flex-col gap-5 short:gap-3" data-nav-zone="career-home">
      {activeRuns.length > 0 ? (
        <Card title={tx("activeCareers")} bodyClassName="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {activeRuns.map((run, index) => {
            const firstChoiceSeries = run.choices[0] ? seriesById(run.choices[0]) : undefined;
            const carId = coverCarForRun(run, firstChoiceSeries);
            const title = runSeriesTitle(run);
            return (
              <MediaTile
                key={run.id}
                navDefault={index === 0}
                media={<SeriesCarThumb carId={carId} />}
                title={title}
                meta={runProgressLine(run)}
                overlay={
                  <Badge tone="neutral" variant="solid" size="sm">
                    {tx(`discipline.${run.discipline}`)}
                  </Badge>
                }
                badges={
                  <>
                    <Badge tone="info" size="sm">
                      {tx("careerScoreShort", { score: format.number(run.score) })}
                    </Badge>
                    {run.season && !run.season.started ? (
                      <Badge tone="warn" size="sm">
                        {tx("preseasonBadge")}
                      </Badge>
                    ) : null}
                  </>
                }
                action={
                  <IconButton
                    size="sm"
                    variant="secondary"
                    aria-label={tx("deleteCareer")}
                    icon={<Icon name="delete" />}
                    onClick={() => setConfirmDelete(run)}
                  />
                }
                onSelect={() => onOpenRun(run)}
              />
            );
          })}
        </Card>
      ) : null}

      <Card title={tx("startCareer")} description={tx("startCareerDesc")} bodyClassName="flex flex-col gap-4">
        <OptionTileGroup columns={2} aria-label={tx("chooseDiscipline")}>
          {CAREER_DISCIPLINES.map((d) => (
            <OptionTile
              key={d}
              checked={discipline === d}
              navDefault={activeRuns.length === 0 && d === discipline}
              title={tx(`discipline.${d}`)}
              description={tx(`disciplineDesc.${d}`)}
              onSelect={() => setDiscipline(d)}
            />
          ))}
        </OptionTileGroup>

        <div
          role="group"
          aria-label={tx("chooseStartingSeries")}
          className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {starters.map((series) => {
            const available = seriesAvailable(series, content);
            const sc = seriesContent(series, content);
            const carId = sc.cars[0] ?? series.cars[0];
            const leadTrackId = sc.calendar[0] ?? series.calendar[0];
            const leadCircuitNames = Array.from(
              new Set(sc.calendar.slice(0, 4).map((id) => trackLabel(id).name)),
            )
              .slice(0, 3)
              .join(", ");
            return (
              <MediaTile
                key={series.id}
                disabled={!available}
                media={
                  <span className="relative block size-full">
                    <SeriesCarThumb carId={carId} />
                    {leadTrackId ? (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute end-2 bottom-2 flex items-center justify-center rounded-lc-nub border border-white/10 bg-lc-void/75 px-2 py-1 backdrop-blur-xs"
                      >
                        <CareerCircuitOutline
                          trackId={leadTrackId}
                          className="h-10 w-16"
                          strokeClassName="stroke-lc-chalk/90"
                        />
                      </span>
                    ) : null}
                  </span>
                }
                title={seriesName(series, tx)}
                meta={
                  available
                    ? tx("starterCircuitsMeta", {
                        circuits: leadCircuitNames,
                        rounds: sc.calendar.length,
                      })
                    : tx("unavailableSeries")
                }
                overlay={
                  series.region ? (
                    <Badge tone="neutral" variant="solid" size="sm">
                      {tx(`region.${series.region}`)}
                    </Badge>
                  ) : null
                }
                badges={
                  available ? (
                    <>
                      <Badge tone="good" size="sm" icon="race">
                        {tx("topN", { place: series.promoteTop })}
                      </Badge>
                      <Badge tone="neutral" size="sm">
                        {tx("carsCount", { count: series.grid })}
                      </Badge>
                    </>
                  ) : (
                    <Badge tone="neutral" size="sm" icon="locked">
                      {tx("ladderUnavailable")}
                    </Badge>
                  )
                }
                onSelect={() => onStartCareer(discipline, series.id)}
              />
            );
          })}
        </div>
      </Card>

      {finishedRuns.length > 0 ? (
        <Card title={tx("finishedCareers")} bodyClassName="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {finishedRuns.map((run) => {
            const carId = coverCarForRun(run);
            const complete = run.status === "complete";
            return (
              <MediaTile
                key={run.id}
                media={<SeriesCarThumb carId={carId} />}
                title={runSeriesTitle(run)}
                meta={tx("seasonsCount", { count: run.history.length })}
                overlay={
                  <Badge tone={complete ? "best" : "bad"} variant="solid" size="sm" icon={complete ? "challenge" : "error"}>
                    {complete ? tx("statusComplete") : tx("statusOver")}
                  </Badge>
                }
                badges={
                  <>
                    <Badge tone="neutral" size="sm">
                      {tx(`discipline.${run.discipline}`)}
                    </Badge>
                    <Badge tone="info" size="sm">
                      {tx("careerScoreShort", { score: format.number(run.score) })}
                    </Badge>
                  </>
                }
                action={
                  <IconButton
                    size="sm"
                    variant="secondary"
                    aria-label={tx("deleteCareer")}
                    icon={<Icon name="delete" />}
                    onClick={() => setConfirmDelete(run)}
                  />
                }
                onSelect={() => onOpenRun(run)}
              />
            );
          })}
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmDelete !== null}
        tone="danger"
        icon={<Icon name="delete" />}
        title={tx("deleteCareerTitle")}
        confirmLabel={tx("deleteConfirm")}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) onDeleteRun(confirmDelete.id);
          setConfirmDelete(null);
        }}
      >
        {confirmDelete ? tx("deleteCareerBody", { series: runSeriesTitle(confirmDelete) }) : null}
      </ConfirmDialog>
    </div>
  );
};
