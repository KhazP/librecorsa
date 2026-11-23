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
  type RaceLength,
} from "@/lib/career/ladder";
import { MAX_ATTEMPTS, type CareerRun, type RaceSettings } from "@/lib/career/career-state";
import type { CareerSummary } from "./career-screen-types";
import { useFocusNav, focusOnHover } from "@/components/menu/useFocusNav";
import { Button, Card, Modal, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { CHOSEN_TILE, CURSOR_TILE, IDLE_TILE, MOTION } from "@/components/ui/styles";
import {
  CareerCircuitOutline,
  MultiplierBadge,
  RaceSettingsFields,
  SeriesCarThumb,
  StandingsTable,
  StatTile,
  carTitle,
  driverDisplay,
  seriesName,
  trackLabel,
} from "./career-ui";

// ---- Race Summary Modal (from summaries queue)

export const RaceSummaryModal: React.FC<{
  summary: Extract<CareerSummary, { kind: "race" }>;
  run: CareerRun | undefined;
  playerName: string;
  playerCode: string;
  onContinue: () => void;
}> = ({ summary, run, playerName, playerCode, onContinue }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const series = seriesById(summary.seriesId);
  const track = trackLabel(summary.result.trackId);
  const { result, parts } = summary;

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
          <Badge tone="neutral" size="sm">
            {tx("roundOf", { round: summary.roundIndex + 1, total: summary.rounds })}
          </Badge>
          {series ? <span className="lc-hint">{seriesName(series, tx)}</span> : null}
          {track.layout ? <span className="lc-hint">{track.layout}</span> : null}
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="primary" size="md" onClick={onContinue} data-nav-default="">
            {tx("continue")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lc-tile border border-lc-line bg-lc-well p-4">
        <div className="flex flex-wrap items-center gap-3">
          {result.dnf ? (
            <Badge tone="bad" variant="solid" size="lg">
              {tx("raceSummaryDnf")}
            </Badge>
          ) : (
            <PositionBadge position={result.position} player size="lg" />
          )}
          <div className="flex flex-col gap-0.5">
            <span className="lc-h3 text-lc-chalk">
              {tx("schedulePoints", { points: result.points })}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="lc-hint">{tx("raceSummaryStarted", { grid: result.grid })}</span>
              {result.lapsLed > 0 ? (
                <span className="lc-hint">{tx("raceSummaryLapsLed", { count: result.lapsLed })}</span>
              ) : null}
              {result.fastestLap ? (
                <Badge tone="best" size="sm" icon="lapTimes">
                  {tx("raceSummaryFastestLap")}
                </Badge>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="lc-lbl">{tx("scoreTotal")}</span>
          <span className="lc-data text-[24px] leading-none text-lc-volt">
            {format.number(parts.score)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
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
                {format.number(parts.total)} × {parts.mult}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="lc-row-label">{tx("scoreTotal")}</span>
              <span className="lc-data text-[18px] text-lc-volt">{format.number(parts.score)}</span>
            </div>
          </div>
        </Card>

        <Card title={tx("standingsAfterTitle")}>
          <StandingsTable
            rows={summary.after}
            before={summary.before}
            promotion={summary.promotion}
            rivals={run?.rivals ?? []}
            playerName={playerName}
            playerCode={playerCode}
            compact
          />
        </Card>
      </div>
    </Modal>
  );
};

// ---- Season Summary Modal (from summaries queue)

export const SeasonSummaryModal: React.FC<{
  summary: Extract<CareerSummary, { kind: "season" }>;
  run: CareerRun | undefined;
  playerName: string;
  playerCode: string;
  onContinue: () => void;
}> = ({ summary, run, playerName, playerCode, onContinue }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const { record, outcome, alongside, parts } = summary.end;
  const series = seriesById(record.seriesId);

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

  const scoreLines: { label: string; value: number }[] = [
    { label: tx("seasonScoreRaces"), value: parts.races },
    { label: tx("seasonScoreChampionship"), value: parts.championship },
    { label: tx("seasonScorePoints"), value: parts.points },
    { label: tx("seasonScoreObjectives"), value: parts.objectives },
    ...(parts.firstClear > 0 ? [{ label: tx("seasonScoreFirstClear"), value: parts.firstClear }] : []),
    { label: tx("seasonScoreMulligans"), value: parts.mulligans },
  ];

  const promotedDrivers = alongside.map((id) => driverDisplay(run?.rivals ?? [], id, playerName, playerCode));

  return (
    <Modal
      open
      onClose={onContinue}
      size="lg"
      title={tx(`seasonOutcome.${outcome}`)}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={outcomeTone} icon={outcomeIcon} size="md">
            {series ? seriesName(series, tx) : record.seriesId}
          </Badge>
          <span className="lc-hint">{tx("attemptBadge", { attempt: record.attempt, max: MAX_ATTEMPTS })}</span>
          <span className="lc-hint">{carTitle(record.car)}</span>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-3">
          <Button variant="primary" size="md" onClick={onContinue} data-nav-default="">
            {tx("continue")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label={tx("colPos")} value={`P${record.position}`} />
        <StatTile label={tx("colPoints")} value={format.number(record.points)} />
        <StatTile label={tx("statWins")} value={record.wins} />
        <StatTile label={tx("statPodiums")} value={record.podiums} />
        <StatTile label={tx("statObjectives")} value={`${record.objectivesDone}/${record.objectivesTotal}`} />
        <StatTile label={tx("statScore")} value={format.number(record.score)} />
      </div>

      <div className={cx("grid grid-cols-1 gap-4", promotedDrivers.length > 0 ? "lg:grid-cols-2" : undefined)}>
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
              <span className="lc-data text-lc-fog">× {parts.mult}</span>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="lc-row-label">{tx("seasonScoreTotal")}</span>
              <span className="lc-data text-[20px] text-lc-volt">{format.number(parts.score)}</span>
            </div>
          </div>
        </Card>

        {promotedDrivers.length > 0 ? (
          <Card title={tx("promotedAlongsideTitle")} description={tx("promotedAlongsideDesc")}>
            <div className="flex flex-col gap-1.5">
              {promotedDrivers.map((d) => (
                <Well key={d.who} className="flex items-center gap-2.5 px-3 py-2">
                  <span
                    aria-hidden
                    className="h-4 w-1 shrink-0 rounded-full bg-lc-slate"
                    style={d.color ? { backgroundColor: d.color } : undefined}
                  />
                  <span className="lc-mono text-[12px] font-bold text-lc-slate">{d.code}</span>
                  <span className="min-w-0 truncate text-[14px] font-semibold text-lc-chalk">{d.name}</span>
                </Well>
              ))}
            </div>
          </Card>
        ) : null}
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="lc-body">{tx("circuitPickerSubtitle", { needed })}</span>
          <Badge tone={exact ? "good" : "warn"} size="sm">
            {tx("circuitPickerCount", { selected: selected.length, needed })}
          </Badge>
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
                "group relative flex min-h-24 flex-col gap-2 rounded-lc-tile border-[1.5px] p-3 text-start",
                full ? "cursor-not-allowed opacity-45" : "cursor-pointer",
                MOTION,
                chosen ? CHOSEN_TILE : IDLE_TILE,
                CURSOR_TILE,
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-[14px] font-semibold text-lc-chalk">{info.name}</span>
                  <span className="lc-hint truncate">{info.layout || info.country}</span>
                </div>
                {chosen ? (
                  <Badge tone="good" variant="solid" size="sm">
                    {tx("roundTag", { round: idx + 1 })}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="lc-mono text-[12px] text-lc-slate">{(info.lengthM / 1000).toFixed(2)} km</span>
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
  onChange: (patch: Partial<RaceSettings>) => void;
  onClose: () => void;
}> = ({ open, series, race, onChange, onClose }) => {
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
          <Button variant="primary" size="md" onClick={onClose}>
            {tx("continue")}
          </Button>
        </div>
      }
    >
      <RaceSettingsFields series={series} race={race} started onChange={onChange} />
    </Modal>
  );
};

// ---- Series Detail Modal (from Ladder)

export const SeriesDetailModal: React.FC<{
  series: CareerSeries | null;
  content: CareerContent;
  canChoose: boolean;
  onChoose: (seriesId: string) => void;
  onClose: () => void;
}> = ({ series, content, canChoose, onChoose, onClose }) => {
  const tx = useTranslations("menu.career");

  const resolved = useMemo(() => (series ? seriesContent(series, content) : null), [series, content]);

  if (!series || !resolved) return null;

  const lengthLabel = (l: RaceLength) => {
    switch (l) {
      case "short":
        return tx("lengthShort");
      case "medium":
        return tx("lengthMedium");
      case "long":
        return tx("lengthLong");
      case "full":
        return tx("lengthFull");
    }
  };

  const pitRules = RACE_LENGTHS.filter((l) => (series.stops?.[l] ?? 0) > 0).map((l) => ({
    length: lengthLabel(l),
    stops: series.stops![l]!,
  }));

  const nextNames = series.next
    .map((id) => seriesById(id))
    .filter((s): s is CareerSeries => Boolean(s))
    .map((s) => seriesName(s, tx));

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
              {tx("raceThisSeries")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label={tx("statGrid")} value={tx("carsCount", { count: series.grid })} />
        <StatTile label={tx("statPromotion")} value={tx("topN", { place: series.promoteTop })} />
        <StatTile label={tx("statDistance")} value={tx("kmValue", { km: series.raceKm })} />
        <StatTile label={tx("statRounds")} value={resolved.calendar.length} />
      </div>

      <Card title={tx("seriesDetailCars")}>
        <div className={cx("grid grid-cols-1 gap-3", series.cars.length > 1 ? "sm:grid-cols-2" : undefined)}>
          {series.cars.map((carId) => (
            <Well key={carId} className="flex items-center gap-3 p-3">
              <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lc-nub bg-lc-carbon">
                <SeriesCarThumb carId={carId} />
              </div>
              <span className="lc-row-label min-w-0 truncate">{carTitle(carId)}</span>
            </Well>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <span className="lc-mono shrink-0 text-[12px] text-lc-slate">{(info.lengthM / 1000).toFixed(2)} km</span>
                </div>
              );
            })}
          </div>
        </Card>

        <div className="flex flex-col gap-4">
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
    </Modal>
  );
};
