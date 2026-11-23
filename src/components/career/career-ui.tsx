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
import { Meter, Segmented, SettingRow, Stepper, Well, cx } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { PositionBadge, PlayerTag } from "@/components/ui/badges";
import { Icon, Trend } from "@/components/ui/icons";

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
  <Well className={cx("flex min-w-0 flex-col gap-1 px-3 py-2.5", className)}>
    <span className="lc-lbl truncate">{label}</span>
    <span className="lc-data truncate text-[18px] leading-tight text-lc-chalk phone:text-[15px]">{value}</span>
    {sub ? <span className="lc-hint truncate">{sub}</span> : null}
  </Well>
);

/** Reusable Race Settings controls (pre-season card and mid-season modal). */
export const RaceSettingsFields: React.FC<{
  series: CareerSeries;
  race: RaceSettings;
  started: boolean;
  onChange: (patch: Partial<RaceSettings>) => void;
}> = ({ series, race, started, onChange }) => {
  const tx = useTranslations("menu.career");
  const maxGrid = Math.min(12, series.grid);
  const stops = series.stops?.[race.raceLength] ?? 0;

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
  const aiLabel = (lvl: AiLevel) => {
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
  };
  const damageLabel = (d: DamageLevel) => {
    switch (d) {
      case "off":
        return tx("damageOff");
      case "reduced":
        return tx("damageReduced");
      case "full":
        return tx("damageFull");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <SettingRow
        label={tx("raceLength")}
        hint={stops > 0 ? tx("raceLengthStopsHint", { stops }) : tx("raceLengthHint")}
      >
        <Segmented
          size="sm"
          options={RACE_LENGTHS.map((id) => ({ id, label: lengthLabel(id) }))}
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
          options={AI_LEVELS.map((id) => ({ id, label: aiLabel(id) }))}
          value={race.aiLevel}
          onChange={(aiLevel) => onChange({ aiLevel })}
        />
      </SettingRow>
      <SettingRow label={tx("damage")}>
        <Segmented
          size="sm"
          options={DAMAGE_LEVELS.map((id) => ({ id, label: damageLabel(id) }))}
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
      <SettingRow label={tx("qualifying")} hint={tx("qualifyingHint")}>
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

/** Renders a bonus objective row with semantic badge and progress meter/readout. */
export const ObjectiveRow: React.FC<{ objective: BonusObjective; season: SeasonState }> = ({ objective, season }) => {
  const tx = useTranslations("menu.career");
  const prog = objectiveProgress(objective, season);
  const title = tx(`objective.${objective.kind}`, { target: objective.target });

  const statusBadge = prog.done ? (
    <Badge tone="good" size="sm" icon="success">
      {tx("objectiveDone")}
    </Badge>
  ) : prog.failed ? (
    <Badge tone="bad" size="sm" icon="error">
      {tx("objectiveFailed")}
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
        ratio = prog.done ? 1 : Math.max(0.1, (season.race.gridSize - prog.value + 1) / Math.max(1, season.race.gridSize - objective.target + 1));
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
    <Well className="flex min-w-0 flex-col gap-2 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className={cx("min-w-0 text-[14px] leading-snug font-medium", prog.done ? "text-lc-chalk" : "text-lc-fog")}>
          {title}
        </span>
        {statusBadge}
      </div>
      {ratio !== null ? (
        <Meter
          stacked
          label={detail}
          value={ratio}
          detail=""
          tone={prog.done ? "good" : prog.failed ? "bad" : "info"}
        />
      ) : (
        <span className="lc-hint">{detail}</span>
      )}
    </Well>
  );
};

/** Championship standings table with promotion cut line, player volt highlight, and optional rank change column. */
export const StandingsTable: React.FC<{
  rows: readonly StandingRow[];
  before?: readonly StandingRow[];
  promotion: number;
  rivals: readonly CareerRival[];
  playerName: string;
  playerCode: string;
  compact?: boolean;
}> = ({ rows, before, promotion, rivals, playerName, playerCode, compact }) => {
  const tx = useTranslations("menu.career");
  const format = useFormatter();
  const beforePos = React.useMemo(() => {
    if (!before) return null;
    return new Map(before.map((r, i) => [r.who, i + 1]));
  }, [before]);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div
        className={cx(
          "grid items-center gap-2 px-2.5 pb-1 text-lc-slate",
          beforePos
            ? "grid-cols-[2.75rem_3rem_minmax(0,1fr)_3rem_3.5rem] phone:grid-cols-[2.5rem_2.75rem_minmax(0,1fr)_2.5rem_3rem]"
            : "grid-cols-[2.75rem_minmax(0,1fr)_3.25rem_3.75rem] phone:grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_3.25rem]",
        )}
      >
        <span className="lc-lbl">{tx("colPos")}</span>
        {beforePos ? <span className="lc-lbl text-center">{tx("colChange")}</span> : null}
        <span className="lc-lbl">{tx("colDriver")}</span>
        <span className="lc-lbl text-end">{tx("colWins")}</span>
        <span className="lc-lbl text-end">{tx("colPoints")}</span>
      </div>

      {rows.map((row, idx) => {
        const pos = idx + 1;
        const driver = driverDisplay(rivals, row.who, playerName, playerCode);
        const prev = beforePos?.get(row.who);
        const delta = prev !== undefined ? prev - pos : 0;
        const showCut = pos === promotion && pos < rows.length;

        return (
          <React.Fragment key={row.who}>
            <div
              className={cx(
                "grid items-center gap-2 rounded-lc-row px-2.5",
                compact ? "min-h-9 py-1" : "min-h-10 py-1.5",
                beforePos
                  ? "grid-cols-[2.75rem_3rem_minmax(0,1fr)_3rem_3.5rem] phone:grid-cols-[2.5rem_2.75rem_minmax(0,1fr)_2.5rem_3rem]"
                  : "grid-cols-[2.75rem_minmax(0,1fr)_3.25rem_3.75rem] phone:grid-cols-[2.5rem_minmax(0,1fr)_2.5rem_3.25rem]",
                driver.isPlayer
                  ? "bg-lc-volt text-lc-void"
                  : idx % 2 === 0
                    ? "bg-lc-well/80 text-lc-chalk"
                    : "bg-transparent text-lc-chalk",
              )}
            >
              <div>
                <PositionBadge
                  position={pos}
                  player={driver.isPlayer}
                  size="sm"
                  variant={driver.isPlayer ? "solid" : undefined}
                  className={driver.isPlayer ? "bg-lc-void! text-lc-volt!" : undefined}
                />
              </div>

              {beforePos ? (
                <div className="flex items-center justify-center gap-1">
                  <Trend
                    direction={delta > 0 ? "up" : delta < 0 ? "down" : "level"}
                    colored={!driver.isPlayer}
                    label={
                      delta > 0
                        ? tx("placesGainedAria", { count: delta })
                        : delta < 0
                          ? tx("placesLostAria", { count: Math.abs(delta) })
                          : tx("placesSameAria")
                    }
                  />
                  <span
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

              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden
                  className={cx("h-4 w-1 shrink-0 rounded-full", driver.isPlayer ? "bg-lc-void" : "bg-lc-slate")}
                  style={driver.color ? { backgroundColor: driver.color } : undefined}
                />
                <span
                  className={cx(
                    "lc-mono shrink-0 text-[12px] font-bold tracking-[0.04em]",
                    driver.isPlayer ? "text-lc-void" : "text-lc-slate",
                  )}
                >
                  {driver.code}
                </span>
                <span className={cx("min-w-0 truncate text-[14px] font-semibold", driver.isPlayer ? "text-lc-void" : "text-lc-chalk")}>
                  {driver.name}
                </span>
                {driver.isPlayer && !compact ? (
                  <PlayerTag size="sm" className="border-lc-void/30 bg-lc-void text-lc-volt phone:hidden" />
                ) : null}
              </div>

              <span className={cx("lc-data text-end text-[13px]", driver.isPlayer ? "text-lc-void" : "text-lc-fog")}>
                {row.wins}
              </span>
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
