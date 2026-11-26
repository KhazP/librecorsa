"use client";

import React from "react";
import { useFormatter, useTranslations } from "use-intl/react";
import circuitOutlinesJson from "@/lib/home/circuit-outlines.json";
import { anyCarById, carById, type CarId } from "@/lib/cars/car-registry";
import { getTrackInfo } from "@/lib/track-registry";
import { DAMAGE_LEVELS, type DamageLevel } from "@/lib/sim/car-damage";
import { QUALIFYING_MINUTES, type QualifyingMinutes } from "@/lib/sim/qualifying";
import {
  AI_LEVELS,
  RACE_LENGTHS,
  aiSkillFor,
  seriesById,
  seriesOf,
  type AiLevel,
  type CareerSeries,
  type RaceLength,
} from "@/lib/career/ladder";
import {
  objectiveProgress,
  raceMultiplier,
  type BonusObjective,
  type CareerRun,
  type RaceSettings,
  type SeasonState,
  type StandingRow,
} from "@/lib/career/career-state";
import { rivalCode, type CareerRival } from "@/lib/career/rivals";
import { CarThumb } from "@/components/menu/CarBrowser";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { Meter, Segmented, SettingRow, Stepper, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge, PlayerTag } from "@/components/ui/badges";
import { Icon, Trend } from "@/components/ui/icons";
import { CURSOR_TILE, IDLE_TILE, MOTION } from "@/components/ui/styles";

type CircuitOutlineEntry = { w: number; h: number; d: string };
const CIRCUIT_OUTLINES = circuitOutlinesJson as Record<string, CircuitOutlineEntry | undefined>;

export type CareerTx = ReturnType<typeof useTranslations<"menu.career">>;

/** Static circuit outline from circuit-outlines.json; renders nothing when a track has no outline. */
export const CareerCircuitOutline: React.FC<{
  trackId: string;
  strokeClassName?: string;
  className?: string;
  label?: string;
}> = ({ trackId, strokeClassName = "stroke-lc-chalk", className = "", label }) => {
  const entry = CIRCUIT_OUTLINES[trackId];
  if (!entry) return null;
  const pad = Math.max(entry.w, entry.h) * 0.08;
  const vb = `${-pad} ${-pad} ${entry.w + pad * 2} ${entry.h + pad * 2}`;
  const sw = Math.max(entry.w, entry.h) * 0.026;
  return (
    <svg
      viewBox={vb}
      fill="none"
      focusable="false"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      className={cx("select-none", className)}
    >
      <path
        d={entry.d}
        strokeWidth={sw * 1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-lc-void/70"
      />
      <path
        d={entry.d}
        strokeWidth={sw}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={strokeClassName}
      />
    </svg>
  );
};

/** Car render thumbnail resolved safely from either active or full registry. */
export const SeriesCarThumb: React.FC<{ carId: CarId; className?: string }> = ({ carId, className = "" }) => {
  const car = anyCarById(carId) ?? carById(carId);
  return <CarThumb car={car} className={cx("size-full object-contain", className)} />;
};

export function carTitle(carId: CarId): string {
  return (anyCarById(carId) ?? carById(carId)).title;
}

export function trackLabel(trackId: string): { name: string; layout: string; full: string; lengthM: number; country: string } {
  const info = getTrackInfo(trackId);
  const showLayout = Boolean(info.layout && info.layout.toLowerCase() !== info.name.toLowerCase());
  return {
    name: info.name,
    layout: showLayout ? info.layout : "",
    full: showLayout ? `${info.name} · ${info.layout}` : info.name,
    lengthM: info.lengthM,
    country: info.country,
  };
}

/** Localised series name with its region combined through `seriesWithRegion`. */
export function seriesName(series: CareerSeries, tx: CareerTx): string {
  const base = tx(`series.${series.family}`);
  if (!series.region) return base;
  return tx("seriesWithRegion", { series: base, region: tx(`region.${series.region}`) });
}

export function raceLengthLabel(l: RaceLength, tx: CareerTx): string {
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
}

export function aiLevelLabel(lvl: AiLevel, tx: CareerTx): string {
  switch (lvl) {
    case "low":
      return tx("aiLevelLow");
    case "medium":
      return tx("aiLevelMedium");
    case "high":
      return tx("aiLevelHigh");
    case "expert":
      return tx("aiLevelExpert");
  }
}

export function damageLevelLabel(d: DamageLevel, tx: CareerTx): string {
  switch (d) {
    case "off":
      return tx("damageOff");
    case "reduced":
      return tx("damageReduced");
    case "full":
      return tx("damageFull");
  }
}

export interface DriverDisplay {
  who: string;
  isPlayer: boolean;
  name: string;
  code: string;
  color: string | null;
  number: number | null;
}

export function driverDisplay(
  rivals: readonly CareerRival[],
  who: string,
  playerName: string,
  playerCode: string,
): DriverDisplay {
  if (who === "me") {
    return {
      who,
      isPlayer: true,
      name: playerName,
      code: playerCode.toUpperCase(),
      color: null,
      number: null,
    };
  }
  const rival = rivals.find((r) => r.id === who);
  if (!rival) {
    return { who, isPlayer: false, name: who, code: who.slice(0, 3).toUpperCase(), color: null, number: null };
  }
  return {
    who,
    isPlayer: false,
    name: `${rival.first} ${rival.last}`,
    code: rivalCode(rival, playerCode),
    color: rival.color,
    number: rival.number,
  };
}

/** Small inset stat well used in heroes and summary grids. */
export const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}> = ({ label, value, sub, className }) => (
  <Well className={cx("flex min-w-0 flex-col gap-1 px-3 py-2.5 short:gap-0.5 short:px-2.5 short:py-1.5", className)}>
    <span className="lc-lbl truncate">{label}</span>
    <span className="lc-data truncate text-[18px] leading-tight text-lc-chalk phone:text-[15px] short:text-[15px]">
      {/* Isolated by its own first letter: "+8,096", "23×" and "P3" read left to right in Arabic too, a word in its own way */}
      <bdi>{value}</bdi>
    </span>
    {sub ? <span className="lc-hint truncate">{sub}</span> : null}
  </Well>
);

/** Reusable Race Settings controls (pre-season card and mid-season modal). */
export const RaceSettingsFields: React.FC<{
  series: CareerSeries;
  race: RaceSettings;
  started: boolean;
  warnQualifyingOff?: boolean;
  onChange: (patch: Partial<RaceSettings>) => void;
}> = ({ series, race, started, warnQualifyingOff, onChange }) => {
  const tx = useTranslations("menu.career");
  const maxGrid = Math.min(12, series.grid);
  const stops = series.stops?.[race.raceLength] ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <SettingRow
        label={tx("raceLength")}
        hint={stops > 0 ? tx("raceLengthStopsHint", { stops }) : tx("raceLengthHint")}
      >
        <Segmented
          size="sm"
          options={RACE_LENGTHS.map((id) => ({ id, label: raceLengthLabel(id, tx) }))}
          value={race.raceLength}
          onChange={(raceLength) => onChange({ raceLength })}
        />
      </SettingRow>
      <SettingRow
        label={tx("aiLevel")}
        hint={tx("aiSkillHint", { skill: aiSkillFor(series, race.aiLevel) })}
      >
        <Segmented
          size="sm"
          options={AI_LEVELS.map((id) => ({ id, label: aiLevelLabel(id, tx) }))}
          value={race.aiLevel}
          onChange={(aiLevel) => onChange({ aiLevel })}
        />
      </SettingRow>
      <SettingRow label={tx("damage")}>
        <Segmented
          size="sm"
          options={DAMAGE_LEVELS.map((id) => ({ id, label: damageLevelLabel(id, tx) }))}
          value={race.damage}
          onChange={(damage) => onChange({ damage })}
        />
      </SettingRow>
      <SettingRow
        label={tx("gridSize")}
        hint={tx("gridSizeHint")}
        disabled={started}
        disabledReason={started ? tx("gridSizeLocked") : undefined}
      >
        <Stepper
          min={4}
          max={maxGrid}
          value={race.gridSize}
          onChange={(gridSize) => onChange({ gridSize })}
        />
      </SettingRow>
      <SettingRow
        label={tx("qualifying")}
        hint={warnQualifyingOff ? tx("qualifyingOffObjectiveWarn") : tx("qualifyingHint")}
      >
        <Segmented
          size="sm"
          options={QUALIFYING_MINUTES.map((m) => ({
            id: String(m),
            label: m === 0 ? tx("qualifyingOff") : tx("qualifyingMinutes", { minutes: m }),
          }))}
          value={String(race.qualifying)}
          onChange={(v) => onChange({ qualifying: Number(v) as QualifyingMinutes })}
        />
      </SettingRow>
    </div>
  );
};

/** Renders a bonus objective row with semantic badge, on-pace state, round-flip highlight, and progress meter. */
export const ObjectiveRow: React.FC<{
  objective: BonusObjective;
  season: SeasonState;
  delta?: "done" | "failed" | null;
}> = ({ objective, season, delta }) => {
  const tx = useTranslations("menu.career");
  const prog = objectiveProgress(objective, season);
  const title = tx(`objective.${objective.kind}`, { target: objective.target });

  const statusBadge = prog.done ? (
    <Badge tone="good" variant="solid" size="sm" icon="success">
      {delta === "done" ? tx("objectiveJustDone") : tx("objectiveDone")}
    </Badge>
  ) : prog.failed ? (
    <Badge tone="bad" size="sm" icon="error">
      {delta === "failed" ? tx("objectiveJustFailed") : tx("objectiveFailed")}
    </Badge>
  ) : prog.onPace ? (
    <Badge tone="info" size="sm" icon="check">
      {tx("objectiveOnPace")}
    </Badge>
  ) : (
    <Badge tone="neutral" size="sm">
      {tx("objectiveOpen")}
    </Badge>
  );

  let detail = tx("objectiveNotStarted");
  let ratio: number | null = null;
  if (prog.value !== null) {
    switch (objective.kind) {
      case "poleThreat":
      case "podiumThreat":
        detail = tx("objectiveValPlace", { value: prog.value });
        ratio = prog.done
          ? 1
          : Math.max(0.1, (season.race.gridSize - prog.value + 1) / Math.max(1, season.race.gridSize - objective.target + 1));
        break;
      case "qualifyPro":
      case "consistent":
        detail = tx("objectiveValAvg", { value: prog.value });
        ratio = prog.value <= objective.target ? 1 : Math.max(0.1, objective.target / prog.value);
        break;
      case "cleanRacer":
      case "leadTheCharge":
      case "fastestLap":
        detail = tx("objectiveValCount", { value: prog.value, target: objective.target });
        ratio = Math.min(1, prog.value / Math.max(1, objective.target));
        break;
      case "putInTheWork":
        detail = tx("objectiveValPct", { value: prog.value });
        ratio = Math.min(1, prog.value / Math.max(1, objective.target));
        break;
    }
  }

  return (
    <Well
      className={cx(
        "flex min-w-0 flex-col gap-2 px-3.5 py-2.5",
        delta === "done"
          ? "border-lc-gain/60 bg-lc-gain/8"
          : delta === "failed"
            ? "border-lc-loss/60 bg-lc-loss/8"
            : undefined,
      )}
    >
      {/* The badge keeps its words on one line and goes under a title it would squeeze below 10 rem */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className={cx("min-w-0 flex-[1_1_10rem] text-[14px] leading-snug font-medium", prog.done ? "text-lc-chalk" : "text-lc-fog")}>
          {title}
        </span>
        <span className="inline-flex shrink-0 whitespace-nowrap">{statusBadge}</span>
      </div>
      {ratio !== null ? (
        <Meter
          stacked
          label={detail}
          value={ratio}
          detail=""
          tone={prog.done ? "good" : prog.failed ? "bad" : prog.onPace ? "info" : "neutral"}
        />
      ) : (
        <span className="lc-hint">{detail}</span>
      )}
    </Well>
  );
};

/** Championship standings table with promotion cut line, player volt highlight, optional rank move, and optional round points. */
export const StandingsTable: React.FC<{
  rows: readonly StandingRow[];
  before?: readonly StandingRow[];
  roundPoints?: ReadonlyMap<string, number>;
  promotion: number;
  rivals: readonly CareerRival[];
  playerName: string;
  playerCode: string;
  compact?: boolean;
  showWins?: boolean;
}> = ({ rows, before, roundPoints, promotion, rivals, playerName, playerCode, compact, showWins }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const unranked = rows.length > 0 && rows.every((r) => r.starts === 0);
  const beforePos = React.useMemo(() => {
    // Before the season's first round nobody has a place to move from
    if (!before || before.every((r) => r.starts === 0)) return null;
    return new Map(before.map((r, i) => [r.who, i + 1]));
  }, [before]);

  const hasMove = Boolean(beforePos);
  const hasRoundPts = Boolean(roundPoints && roundPoints.size > 0);
  const hasWins = showWins ?? !compact;

  const gridCols = React.useMemo(() => {
    if (hasMove && hasRoundPts && !hasWins) {
      return "grid-cols-[2.5rem_2.75rem_minmax(0,1fr)_2.75rem_3rem] phone:grid-cols-[2.25rem_2.5rem_minmax(0,1fr)_2.5rem_2.75rem]";
    }
    if (!hasMove && hasRoundPts && !hasWins) {
      return "grid-cols-[2.5rem_minmax(0,1fr)_2.75rem_3rem] phone:grid-cols-[2.25rem_minmax(0,1fr)_2.5rem_2.75rem]";
    }
    if (hasMove && hasWins) {
      return "grid-cols-[2.75rem_3rem_minmax(0,1fr)_2.75rem_3.25rem] phone:grid-cols-[2.5rem_2.75rem_minmax(0,1fr)_2.25rem_3rem]";
    }
    if (!hasMove && hasWins) {
      return "grid-cols-[2.75rem_minmax(0,1fr)_3.25rem_3.75rem] phone:grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_3.25rem]";
    }
    if (hasMove) {
      return "grid-cols-[2.5rem_2.75rem_minmax(0,1fr)_3.25rem] phone:grid-cols-[2.25rem_2.5rem_minmax(0,1fr)_3rem]";
    }
    return "grid-cols-[2.5rem_minmax(0,1fr)_3.25rem] phone:grid-cols-[2.25rem_minmax(0,1fr)_3rem]";
  }, [hasMove, hasRoundPts, hasWins]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cx("grid items-center gap-2 px-2.5 pb-1 text-lc-slate", gridCols)}>
        {/* The number columns are narrow: a longer heading ("Victoires") sits against the column's end and runs back
            over the driver column's free space, never into the next heading */}
        <span className="lc-lbl">{tx("colPos")}</span>
        {hasMove ? <span className="lc-lbl justify-self-center whitespace-nowrap">{tx("colChange")}</span> : null}
        <span className="lc-lbl">{tx("colDriver")}</span>
        {hasWins ? <span className="lc-lbl justify-self-end whitespace-nowrap">{tx("colWins")}</span> : null}
        {hasRoundPts ? <span className="lc-lbl justify-self-end whitespace-nowrap">{tx("colRoundPoints")}</span> : null}
        <span className="lc-lbl justify-self-end whitespace-nowrap">{tx("colPoints")}</span>
      </div>

      {rows.map((row, idx) => {
        const pos = idx + 1;
        const driver = driverDisplay(rivals, row.who, playerName, playerCode);
        const prev = beforePos?.get(row.who);
        const delta = prev !== undefined ? prev - pos : 0;
        const roundPts = roundPoints?.get(row.who);
        const showCut = !unranked && pos === promotion && pos < rows.length;

        return (
          <React.Fragment key={row.who}>
            <div
              className={cx(
                "grid items-center gap-2 rounded-lc-row px-2.5",
                compact ? "min-h-9 py-1" : "min-h-10 py-1.5",
                gridCols,
                driver.isPlayer
                  ? "bg-lc-volt text-lc-void"
                  : idx % 2 === 0
                    ? "bg-lc-well/80 text-lc-chalk"
                    : "bg-transparent text-lc-chalk",
              )}
            >
              <div>
                {unranked ? (
                  <span
                    className={cx(
                      "lc-mono inline-flex w-7 justify-center text-[12px] font-bold",
                      driver.isPlayer ? "text-lc-void" : "text-lc-slate",
                    )}
                  >
                    {tx("unranked")}
                  </span>
                ) : (
                  <PositionBadge
                    position={pos}
                    player={driver.isPlayer}
                    size="sm"
                    variant={driver.isPlayer ? "solid" : undefined}
                    className={driver.isPlayer ? "bg-lc-void! text-lc-volt!" : undefined}
                  />
                )}
              </div>

              {hasMove ? (
                <div className="flex items-center justify-center gap-0.5">
                  {/* No move is the 0 alone: the level glyph beside it read as a dash ("— 0") */}
                  {delta !== 0 ? (
                    <Trend
                      direction={delta > 0 ? "up" : "down"}
                      colored={!driver.isPlayer}
                      label={delta > 0 ? tx("placesGainedAria", { count: delta }) : tx("placesLostAria", { count: Math.abs(delta) })}
                    />
                  ) : (
                    <span className="sr-only">{tx("placesSameAria")}</span>
                  )}
                  <span
                    aria-hidden={delta === 0 ? true : undefined}
                    className={cx(
                      "lc-mono text-[12px] font-bold",
                      driver.isPlayer
                        ? "text-lc-void"
                        : delta > 0
                          ? "text-lc-gain"
                          : delta < 0
                            ? "text-lc-loss"
                            : "text-lc-slate",
                    )}
                  >
                    {delta > 0
                      ? tx("placesGained", { count: delta })
                      : delta < 0
                        ? tx("placesLost", { count: Math.abs(delta) })
                        : tx("placesSame")}
                  </span>
                </div>
              ) : null}

              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className={cx("h-4 w-1 shrink-0 rounded-full", driver.isPlayer ? "bg-lc-void" : "bg-lc-slate")}
                  style={driver.color ? { backgroundColor: driver.color } : undefined}
                />
                {!compact ? (
                  <span
                    className={cx(
                      "lc-mono shrink-0 text-[12px] font-bold tracking-[0.04em]",
                      driver.isPlayer ? "text-lc-void" : "text-lc-slate",
                    )}
                  >
                    {driver.code}
                  </span>
                ) : null}
                <span
                  className={cx(
                    "min-w-0 text-[14px] leading-tight font-semibold",
                    compact ? "break-words" : "truncate",
                    driver.isPlayer ? "text-lc-void" : "text-lc-chalk",
                  )}
                >
                  {driver.name}
                </span>
                {driver.number !== null ? (
                  <span
                    className={cx(
                      "lc-mono shrink-0 text-[11px] font-semibold",
                      driver.isPlayer ? "text-lc-void/80" : "text-lc-slate",
                    )}
                  >
                    #{driver.number}
                  </span>
                ) : null}
                {driver.isPlayer && !compact ? (
                  <PlayerTag size="sm" className="border-lc-void/30 bg-lc-void text-lc-volt phone:hidden" />
                ) : null}
              </div>

              {hasWins ? (
                <span className={cx("lc-data text-end text-[13px]", driver.isPlayer ? "text-lc-void" : "text-lc-fog")}>
                  {row.wins}
                </span>
              ) : null}

              {hasRoundPts ? (
                <span
                  className={cx(
                    "lc-mono text-end text-[12px] font-bold",
                    driver.isPlayer
                      ? "text-lc-void"
                      : roundPts && roundPts > 0
                        ? "text-lc-gain"
                        : "text-lc-slate",
                  )}
                >
                  {roundPts && roundPts > 0 ? <bdi>+{roundPts}</bdi> : tx("unranked")}
                </span>
              ) : null}

              <span className={cx("lc-data text-end text-[14px]", driver.isPlayer ? "text-lc-void" : "text-lc-chalk")}>
                {format.number(row.points)}
              </span>
            </div>

            {showCut ? (
              <div className="my-1 flex items-center gap-2.5 px-1" role="separator" aria-label={tx("promotionCutLine", { place: promotion })}>
                <span aria-hidden className="h-px flex-1 border-t border-dashed border-lc-gain/70" />
                <span className="lc-chip-text inline-flex shrink-0 items-center gap-1 text-lc-gain">
                  <Icon name="shiftUp" size="xs" />
                  {tx("promotionCutLine", { place: promotion })}
                </span>
                <span aria-hidden className="h-px flex-1 border-t border-dashed border-lc-gain/70" />
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/** Compact career progress strip shown on the Season hub; clicking opens the Ladder tab. */
export const CareerPathStrip: React.FC<{
  run: CareerRun;
  currentSeries: CareerSeries;
  onOpenLadder: () => void;
}> = ({ run, currentSeries, onOpenLadder }) => {
  const tx = useTranslations("menu.career");

  const doneSeries = React.useMemo(() => {
    const seen = new Set<string>();
    const list: CareerSeries[] = [];
    for (const h of run.history) {
      if (!h.promoted || h.seriesId === currentSeries.id || seen.has(h.seriesId)) continue;
      const s = seriesById(h.seriesId);
      if (s) {
        seen.add(h.seriesId);
        list.push(s);
      }
    }
    return list;
  }, [run.history, currentSeries.id]);

  const maxTier = React.useMemo(
    () => seriesOf(run.discipline).reduce((m, s) => Math.max(m, s.tier), 0),
    [run.discipline],
  );
  const tiersLeft = Math.max(0, maxTier - currentSeries.tier);

  // Follow single-path next series for the remaining tail; if branching, show the remaining tier count
  const linearNext = React.useMemo(() => {
    const tail: CareerSeries[] = [];
    let cur: CareerSeries | undefined = currentSeries;
    while (cur && cur.next.length === 1) {
      const next = seriesById(cur.next[0]);
      if (!next) break;
      tail.push(next);
      cur = next;
    }
    return tail;
  }, [currentSeries]);

  const remainingAfterTail = Math.max(0, tiersLeft - linearNext.length);

  return (
    <button
      type="button"
      aria-label={tx("careerPathLabel")}
      data-own-ring=""
      onPointerEnter={focusOnHover}
      onClick={onOpenLadder}
      className={cx(
        "group flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-lc-row border-[1.5px] px-3.5 py-2 text-start short:hidden",
        MOTION,
        IDLE_TILE,
        CURSOR_TILE,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        {doneSeries.map((s) => (
          <React.Fragment key={s.id}>
            <span className="inline-flex items-center gap-1 text-[12px] font-medium text-lc-fog">
              <Icon name="check" size="xs" className="text-lc-gain" />
              <span className="whitespace-nowrap">{seriesName(s, tx)}</span>
            </span>
            <Icon name="next" size="xs" className="text-lc-dim" />
          </React.Fragment>
        ))}

        <span className="inline-flex items-center gap-1.5 rounded-lc-nub bg-lc-info/15 px-2 py-0.5 text-[12px] font-semibold text-lc-chalk">
          <span aria-hidden className="size-1.5 rounded-full bg-lc-info" />
          <span className="whitespace-nowrap">{seriesName(currentSeries, tx)}</span>
        </span>

        {currentSeries.final ? (
          <span className="lc-mono ms-1 text-[11px] font-semibold text-lc-slate">
            {tx("careerPathFinal")}
          </span>
        ) : (
          <>
            {linearNext.map((s) => (
              <React.Fragment key={s.id}>
                <Icon name="next" size="xs" className="text-lc-dim" />
                <span className="whitespace-nowrap text-[12px] text-lc-slate">{seriesName(s, tx)}</span>
              </React.Fragment>
            ))}
            {remainingAfterTail > 0 ? (
              <>
                <Icon name="next" size="xs" className="text-lc-dim" />
                <span className="lc-mono whitespace-nowrap text-[11px] font-semibold text-lc-slate">
                  {tx("careerPathRemaining", { count: remainingAfterTail })}
                </span>
              </>
            ) : null}
          </>
        )}
      </div>

      <span className="lc-mono inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-lc-slate group-hover:text-lc-chalk group-focus:text-lc-chalk">
        {tx("careerPathOpenLadder")}
        <Icon name="next" size="xs" />
      </span>
    </button>
  );
};

/** Format score multiplier pill for headers and Race Settings cards. */
export const MultiplierBadge: React.FC<{ race: RaceSettings }> = ({ race }) => {
  const tx = useTranslations("menu.career");
  return (
    <Badge tone="info" size="md" icon="overtake">
      {tx("multiplierBadge", { mult: raceMultiplier(race) })}
    </Badge>
  );
};

/** Pick a representative car id for a career run (current season, first choice, or last season). */
export function coverCarForRun(run: CareerRun, fallbackSeries?: CareerSeries): CarId {
  if (run.season) return run.season.settings.car;
  if (run.history.length > 0) return run.history[run.history.length - 1].car;
  return fallbackSeries?.cars[0] ?? "liana";
}
