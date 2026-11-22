"use client";

/*
 * The online board of a circuit, a page at a time: the one panel the title menu, the pause menu and the home page show.
 * The circuit picker sits top right and the circuit's totals under the heading. "My car" is the car being driven
 * (absent on the home page, which picks a car from a list instead), "All cars" every driver once with their fastest
 * lap in any car. A weekly challenge's board (`event`) is shown the same way, on its fixed circuit and car. Twenty places a page;
 * the pager at the foot turns pages with the pointer, LT / RT or Z / C (registered with the screen's own navigation),
 * and Jump to me goes to the page with the player's row. Physics V2 (New) or Physics V1 picks the board read: the one
 * laps go on now, or an older one kept as it was (lap-types.ts `boardChoices`: each physics version, and a circuit's
 * boards from before it started again on its own). Free of the simulator, so the home page loads it on its own.
 */
import React, { useEffect, useRef, useState } from "react";
import type { VehicleModelId } from "@/types/f1";
import { boardChoiceOf, boardChoices, PHYSICS_VERSION, physicsVersionLabel, revisionOnBoard, type LeaderboardEntry } from "@/lib/sim/lap-types";
import {
  ALL_CARS,
  BOARD_FILTER_PREFS_KEY,
  BOARD_PAGE_SIZE,
  boardLabel,
  driverNameKey,
  fetchBoardPage,
  fetchCircuitTotals,
  formatCount,
  loadBoardFilterPrefs,
  saveBoardFilterPrefs,
  type BoardCar,
  type BoardFilter,
  type BoardFilterPrefs,
  type BoardPage,
  type CircuitTotals,
} from "@/lib/net/board-client";
import { usePageHandler } from "@/components/menu/useFocusNav";
import { Badge, type PaletteColor } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { SettingRow } from "@/components/ui/SettingRow";
import { Skeleton } from "@/components/ui/Skeleton";
import { Toggle } from "@/components/ui/Toggle";
import { Icon } from "@/components/ui/icons/Icon";
import { BoardError, BoardSkeleton, BoardTable, MyPlace, type BoardRow } from "./board-table";

/** A car on a row of every car's board: its short name, in its class colour */
export interface BoardCarTag {
  label: string;
  color: PaletteColor;
}

export interface OnlineBoardProps {
  /** The heading: "Online times" in the game, "Lap times" on the home page */
  title: string;
  /** The heading's level in the page's outline */
  headingAs?: "h2" | "h3";
  /** The circuits the picker offers, in order */
  circuits: readonly { id: string; label: string }[];
  circuit: string;
  onCircuitChange: (id: string) => void;
  /** The car being driven: its board is "My car"; absent (the home page), every car's board or `carPicker`'s */
  myCar?: { vehicle: VehicleModelId; label: string };
  /** Without `myCar`: the cars the board can be narrowed to (each car's own board), and the one picked */
  carPicker?: { cars: readonly { id: VehicleModelId; label: string; detail?: string }[]; value: BoardCar; onChange: (car: BoardCar) => void };
  /**
   * A weekly challenge's board instead of the open one: its week (the event id) and the car it is driven in. The
   * circuit and car are fixed and the filters hidden, as the week's rules already are one. A week that has `ended`,
   * with no laps on the revision the car is driven under now, is read on the newest revision it has laps under (the
   * week still running keeps to today's, as the game's challenge panel does).
   */
  event?: { id: string; vehicle: VehicleModelId; carLabel: string; ended?: boolean };
  /** In place of the circuit picker top right (the challenge's week picker) */
  picker?: React.ReactNode;
  /** Under the heading, in place of the board choice (the challenge's circuit, car and rules) */
  intro?: React.ReactNode;
  /** Said when the board has no laps at all, in place of the default line */
  emptyText?: string;
  /** A car's short name and class colour, for the rows of every car's board */
  carTag: (vehicle: VehicleModelId) => BoardCarTag;
  /** The player's name: marks their row and finds their place */
  driverName?: string;
  /** Changes when the board may have changed (a lap went up): it is read again */
  boardVersion?: number;
  /** Races a lap's ghost; offered on `ghostCircuit` only (the circuit loaded) */
  onRaceGhost?: (entry: LeaderboardEntry) => void;
  /** Applies the car setup saved with a lap (offered on rows with `hasSetup` matching the player's car) */
  onApplySetup?: (entry: LeaderboardEntry) => Promise<void> | void;
  ghostCircuit?: string;
  /** At the foot of the card, under the pager (the driver key) */
  footer?: React.ReactNode;
  /**
   * The board shown (lap-types.ts `BoardChoice.id`), when the caller keeps it (Lap times, whose best laps follow it);
   * without it the board keeps its own, starting on the one laps go on now
   */
  boardChoice?: string;
  onBoardChoiceChange?: (id: string) => void;
  className?: string;
}

type Scope = "mine" | "all";

/** "312 drivers" */
const driversLine = (n: number) => `${formatCount(n)} ${n === 1 ? "driver" : "drivers"}`;

/** "1,204 laps · 312 drivers" */
const totalsLine = (t: CircuitTotals) => `${formatCount(t.laps)} ${t.laps === 1 ? "lap" : "laps"} · ${driversLine(t.drivers)}`;

/** "0.214 s behind Ana" */
const behind = (ms: number, aheadMs: number, who: string) => `${((ms - aheadMs) / 1000).toFixed(3)} s behind \u2068${who}\u2069`;

/** The button that races a lap's ghost: a round icon button in a row, a worded one on its own */
const RaceGhost: React.FC<{ onClick: () => void; label?: string; of?: string }> = ({ onClick, label, of }) =>
  label ? (
    <Button size="sm" variant="secondary" icon={<Icon name="ghost" />} onClick={onClick}>
      {label}
    </Button>
  ) : (
    <IconButton size="sm" variant="secondary" icon={<Icon name="ghost" />} aria-label={`Race the ghost of ${of}`} title="Race ghost" onClick={onClick} />
  );

/** The button that applies the car setup saved with a lap */
const ApplySetup: React.FC<{ onClick: () => void; of: string; loading?: boolean }> = ({ onClick, of, loading }) => (
  <IconButton
    size="sm"
    variant="secondary"
    icon={<Icon name="garage" />}
    aria-label={`Apply setup from ${of}`}
    title="Apply setup"
    disabled={loading}
    aria-busy={loading || undefined}
    onClick={onClick}
  />
);

export const OnlineBoard: React.FC<OnlineBoardProps> = ({
  title,
  headingAs: Heading = "h3",
  circuits,
  circuit,
  onCircuitChange,
  myCar,
  carPicker,
  event,
  picker,
  intro,
  emptyText,
  carTag,
  driverName = "",
  boardVersion = 0,
  onRaceGhost,
  onApplySetup,
  ghostCircuit,
  footer,
  boardChoice,
  onBoardChoiceChange,
  className = "",
}) => {
  const rootRef = useRef<HTMLElement | null>(null);
  const headingId = React.useId();
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  const [scopeChosen, setScope] = useState<Scope>("mine");
  const scope: Scope = myCar ? scopeChosen : "all";
  // Without a car being driven, the car picked from the list (every car's board until one is)
  const picked: BoardCar = carPicker?.cars.some((c) => c.id === carPicker.value) ? carPicker.value : ALL_CARS;
  const car: BoardCar = event ? event.vehicle : myCar ? (scope === "mine" ? myCar.vehicle : ALL_CARS) : picked;
  const eventId = event?.id ?? "";

  // Filters (none on a challenge's board: its rules are fixed); choices persist in localStorage
  const [filterPrefs, setFilterPrefs] = useState<BoardFilterPrefs>(() => loadBoardFilterPrefs());
  const filterDirtyRef = useRef(false);
  const updateFilterPref = (patch: Partial<BoardFilterPrefs>) => {
    filterDirtyRef.current = true;
    setFilterPrefs((prev) => ({ ...prev, ...patch }));
  };
  useEffect(() => {
    if (!filterDirtyRef.current) return;
    filterDirtyRef.current = false;
    saveBoardFilterPrefs(filterPrefs);
  }, [filterPrefs]);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === BOARD_FILTER_PREFS_KEY || e.key === null) {
        filterDirtyRef.current = false;
        setFilterPrefs(loadBoardFilterPrefs());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const noAssists = !event && filterPrefs.noAssists;
  const fullRealism = !event && filterPrefs.fullRealism;
  const wetOnly = !event && filterPrefs.wetOnly;

  // The board read: the caller's pick, else the one picked here, else the one laps go on now; a pick is held by its id
  // and found again on each circuit. A challenge week that ended with no laps on the current board but laps on an older
  // one (the physics changed since that week) opens on the newest of those, unless a board was picked on that week's
  const choices = boardChoices(circuit);
  /** The board a pick was made on: the car's, or the car's in that challenge week */
  const boardOf = `${car}|${eventId}`;
  const [boardPick, setBoardPick] = useState<{ id: string; on: string } | null>(null);
  const [autoOlder, setAutoOlder] = useState<{ of: string; id: string } | null>(null);
  const pickedHere = boardPick?.on === boardOf;
  const autoHere = boardChoice === undefined && autoOlder?.of === boardOf && !pickedHere ? autoOlder.id : null;
  const choice = boardChoiceOf(circuit, autoHere ?? boardChoice ?? boardPick?.id);
  const older = !choice.current;
  /** The board's base revision (every car's board is read by it) */
  const version = choice.base;
  const pickBoard = (id: string) => {
    setBoardPick({ id, on: boardOf });
    onBoardChoiceChange?.(id);
  };
  /** The car's revision on that board */
  const physics = car === ALL_CARS ? 0 : revisionOnBoard(version, car);
  const filtersOn = [noAssists, fullRealism, wetOnly].filter(Boolean).length;

  // The board shown: another circuit, car, week, filter or board starts on its first page again
  const base = `${circuit}|${car}|${physics}|${version}|${eventId}|${noAssists}|${fullRealism}|${wetOnly}`;
  const [paging, setPaging] = useState({ base, page: 1 });
  const page = paging.base === base ? paging.page : 1;
  const [reload, setReload] = useState(0);
  const name = driverName.trim();
  const key = `${base}|${page}|${name}|${boardVersion}|${reload}`;

  /**
   * The last answer read, for which board and page (a board is never shown under another's heading), and whether the
   * last read failed (then the page already shown stays, marked as older)
   */
  const [read, setRead] = useState<{ key: string; base: string; page: number; board: BoardPage | null; error: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    const filter: BoardFilter = {};
    if (noAssists) filter.assists = "pro";
    if (fullRealism) filter.realism = "full";
    if (wetOnly) filter.surface = "wet";
    void fetchBoardPage(circuit, car, {
      filter,
      physics: car === ALL_CARS ? undefined : physics,
      version,
      event: eventId || undefined,
      offset: (page - 1) * BOARD_PAGE_SIZE,
      limit: BOARD_PAGE_SIZE,
      name: name || undefined,
      // The place just above the player's, for the gap and the ghost ahead, whatever page is shown
      near: name ? 1 : undefined,
    })
      .catch(() => null)
      .then((board) => {
        if (!live) return;
        // An ended challenge week with no laps on the current board but laps on an older one: the newest of those, read
        // before anything is shown (never over a board picked on that week's)
        if (event?.ended && boardChoice === undefined && !pickedHere && !older && board && board.total === 0) {
          const kept = choices.find((c) => !c.current && board.physics.includes(revisionOnBoard(c.base, event.vehicle)));
          if (kept) {
            setAutoOlder({ of: boardOf, id: kept.id });
            return;
          }
        }
        // A failed refresh of the same page keeps the times already shown
        setRead((prev) => ({
          key,
          base,
          page,
          board: board ?? (prev && prev.base === base && prev.page === page ? prev.board : null),
          error: board === null,
        }));
      });
    return () => {
      live = false;
    };
    // `key` stands for the circuit, car, week, board, filters, page, name and refreshes
  }, [key]);

  /**
   * The circuit's totals: its laps and its board's drivers, with no filter (read again when a lap went up). A
   * challenge week has no totals of its own: its line is the page's count of drivers.
   */
  const totalsOf = event ? "" : `${circuit}|${car}|${physics}|${version}`;
  const [totals, setTotals] = useState<{ of: string; totals: CircuitTotals | null } | null>(null);
  useEffect(() => {
    if (!totalsOf) return;
    let live = true;
    void fetchCircuitTotals(circuit, car, car === ALL_CARS ? undefined : physics, version)
      .catch(() => null)
      .then((t) => {
        if (live) setTotals((prev) => ({ of: totalsOf, totals: t ?? (prev?.of === totalsOf ? prev.totals : null) }));
      });
    return () => {
      live = false;
    };
  }, [totalsOf, boardVersion]);

  const settled = read?.key === key;
  const shown = read && read.base === base ? read.board : null;
  const loading = !settled;
  const failed = settled && Boolean(read?.error);
  const stale = Boolean(shown) && loading;
  const total = shown?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / BOARD_PAGE_SIZE));
  const me = shown?.me ?? null;
  const myPage = me ? Math.ceil(me.pos / BOARD_PAGE_SIZE) : null;
  const myKey = driverNameKey(name);
  const shownTotals = totals?.of === totalsOf ? totals.totals : null;
  const totalsText = event ? (shown ? driversLine(total) : null) : shownTotals ? totalsLine(shownTotals) : null;
  const totalsLoading = event ? !shown && !failed : totals?.of !== totalsOf;

  // The board shrank under the page shown (drivers renamed or lapsed since): back to its last page
  useEffect(() => {
    if (settled && shown && shown.total > 0 && page > pages) setPaging({ base, page: pages });
  }, [settled, shown, page, pages, base]);

  const goTo = (next: number) => {
    const to = Math.min(pages, Math.max(1, next));
    if (to !== page) setPaging({ base, page: to });
  };
  // LT / RT, Z / C: the page before and after, with the screen's own navigation
  usePageHandler(rootRef, (step) => {
    if (pages <= 1) return false;
    const to = page + step;
    if (to < 1 || to > pages) return true;
    goTo(to);
    return true;
  });

  const clearFilters = () => {
    updateFilterPref({ noAssists: false, fullRealism: false, wetOnly: false });
  };

  const ghostsHere = Boolean(onRaceGhost) && circuit === ghostCircuit;
  const applySetup = (entry: LeaderboardEntry, rowKey: string) => {
    if (!onApplySetup || applyingKey) return;
    setApplyingKey(rowKey);
    void Promise.resolve(onApplySetup(entry)).finally(() => setApplyingKey(null));
  };
  const offset = shown?.offset ?? (page - 1) * BOARD_PAGE_SIZE;
  const rows: BoardRow[] = (shown?.entries ?? []).map((e, i) => {
    const pos = offset + i + 1;
    const tag = car === ALL_CARS ? carTag(e.vehicle) : null;
    const rowKey = e.id ?? `${e.code}-${e.recordedAt}-${pos}`;
    const canApply = Boolean(onApplySetup && e.hasSetup && (!myCar || e.vehicle === myCar.vehicle));
    const setupBtn = canApply ? (
      <ApplySetup of={`${e.name}'s lap`} loading={applyingKey === rowKey} onClick={() => applySetup(e, rowKey)} />
    ) : null;
    const ghostBtn = ghostsHere ? <RaceGhost of={`${e.name}'s lap`} onClick={() => onRaceGhost?.(e)} /> : null;
    return {
      key: rowKey,
      rank: pos,
      code: e.code,
      title: e.name,
      input: e.conditions?.input,
      tag: tag ? (
        <Badge tone={{ color: tag.color }} size="sm" className="max-w-[9rem] truncate">
          {tag.label}
        </Badge>
      ) : undefined,
      // A challenge's laps were all driven to its rules: only the day
      detail: `${e.conditions && !event ? `${boardLabel(e.conditions)} · ` : ""}${new Date(e.recordedAt).toLocaleDateString()}`,
      lapMs: e.lapTimeMs,
      fastest: pos === 1,
      sectorsMs: e.sectorTimesMs,
      mine: myKey !== "" && driverNameKey(e.name) === myKey,
      action:
        setupBtn || ghostBtn ? (
          <span className="inline-flex items-center gap-1.5">
            {setupBtn}
            {ghostBtn}
          </span>
        ) : undefined,
    };
  });

  // The place above the player's: from the rows round their place, wherever the page is
  const ahead = me && shown?.near && me.pos > 1 ? (shown.near.entries[me.pos - 1 - shown.near.pos] ?? null) : null;
  const circuitName = circuits.find((c) => c.id === circuit)?.label ?? circuit;
  /** The older board's name ("Physics V1") */
  const versionName = choice.label;
  const carName = event
    ? event.carLabel
    : car === ALL_CARS
      ? "All cars"
      : (myCar?.label ?? carPicker?.cars.find((c) => c.id === car)?.label ?? car);
  const boardName = `${carName} · ${circuitName}${event ? ` · ${event.id}` : ""}${older ? ` · ${versionName}` : ""}`;

  return (
    <section
      ref={rootRef}
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col gap-3.5 rounded-lc-card border border-white/7 bg-lc-carbon/80 p-4.5 text-lc-chalk phone:p-3.5 ${className}`}
    >
      {/* The heading with the circuit's totals under it; the circuit picker (or the week's) top right */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Heading id={headingId} className="lc-h3 m-0 min-w-0">
            {title}
          </Heading>
          <p className="lc-mono m-0 flex h-[18px] items-center text-[13px] text-lc-fog" aria-live="polite">
            {totalsText ?? (totalsLoading ? <Skeleton shape="line" className="h-3 w-40" /> : null)}
          </p>
        </div>
        {picker ?? <Select aria-label="Circuit" className="w-80 max-w-full" value={circuit} onChange={onCircuitChange} options={circuits} />}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
        {intro ? (
          intro
        ) : myCar ? (
          <Segmented
            aria-label="Board"
            size="sm"
            value={scope}
            onChange={(next) => setScope(next)}
            options={[
              { id: "mine", label: "My car", "aria-label": `My car: ${myCar.label}` },
              { id: "all", label: "All cars" },
            ]}
          />
        ) : carPicker ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
            <Select
              aria-label="Car"
              className="w-72 max-w-full"
              value={car}
              onChange={carPicker.onChange}
              options={[{ id: ALL_CARS, label: "All cars" }, ...carPicker.cars]}
            />
            {car === ALL_CARS ? <span className="lc-hint">Fastest lap per driver</span> : null}
          </div>
        ) : (
          <span className="lc-hint">Fastest lap per driver</span>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {choices.length <= 2 ? (
            <Segmented aria-label="Physics version" size="sm" value={choice.id} onChange={pickBoard} options={choices} />
          ) : (
            <Select aria-label="Physics version" className="w-64 max-w-full" value={choice.id} onChange={pickBoard} options={choices} />
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="refresh" />}
            loading={loading && Boolean(shown)}
            aria-label="Refresh online times"
            onClick={() => setReload((n) => n + 1)}
          >
            Refresh
          </Button>
        </div>
      </div>

      {older ? (
        <p className="lc-hint m-0">
          {choice.physics !== PHYSICS_VERSION ? "Archived physics version." : "Previous circuit revision."} New laps post to{" "}
          {physicsVersionLabel(PHYSICS_VERSION, { short: true })}.
        </p>
      ) : null}

      {event ? null : (
        <Disclosure moreLabel={filtersOn ? `Filters · ${filtersOn} on` : "Filters"} lessLabel="Hide filters">
          <SettingRow label="No assists">
            <Toggle checked={noAssists} onChange={(v) => updateFilterPref({ noAssists: v })} />
          </SettingRow>
          <SettingRow label="Full realism">
            <Toggle checked={fullRealism} onChange={(v) => updateFilterPref({ fullRealism: v })} />
          </SettingRow>
          <SettingRow label="Wet laps">
            <Toggle checked={wetOnly} onChange={(v) => updateFilterPref({ wetOnly: v })} />
          </SettingRow>
        </Disclosure>
      )}

      {/* Where the player stands */}
      {me ? (
        <MyPlace
          rank={me.pos}
          total={total}
          lapMs={me.entry.lapTimeMs}
          detail={me.pos === 1 ? "Fastest on this board" : ahead ? behind(me.entry.lapTimeMs, ahead.lapTimeMs, ahead.name) : ""}
          action={ahead && ghostsHere ? <RaceGhost onClick={() => onRaceGhost?.(ahead)} label="Race the ghost ahead" /> : undefined}
        />
      ) : null}

      {!shown && !failed ? (
        <BoardSkeleton rows={6} label="Loading online times…" />
      ) : !shown ? (
        <BoardError onRetry={() => setReload((n) => n + 1)}>Couldn&apos;t load online times.</BoardError>
      ) : shown.entries.length === 0 && total === 0 ? (
        <EmptyState
          icon={<Icon name={filtersOn ? "filter" : event ? "challenge" : "online"} />}
          action={
            filtersOn ? (
              <Button size="sm" variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        >
          {older
            ? filtersOn
              ? `No matching laps on ${versionName}.`
              : `No laps on ${versionName}.`
            : filtersOn
              ? "No laps match these filters."
              : emptyText
                ? emptyText
                : car === ALL_CARS
                  ? `No online times on ${circuitName} yet.`
                  : "No online times for this circuit and car yet."}
        </EmptyState>
      ) : (
        <>
          {failed ? (
            <p role="alert" className="m-0 flex items-center gap-2 text-[13px] font-medium text-lc-caution">
              <Icon name="warning" />
              Refresh failed. Showing cached times.
            </p>
          ) : null}
          <BoardTable label={`Online times, ${boardName}, page ${page} of ${pages}`} rows={rows} stale={stale} />
        </>
      )}

      {/* The pager: the page before and after, where it is, and the page with the player's row */}
      {shown && pages > 1 ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t border-lc-line pt-3">
          <div className="flex items-center gap-2">
            <IconButton
              size="sm"
              variant="secondary"
              icon={<Icon name="previous" />}
              aria-label="Previous page"
              aria-disabled={page <= 1 || undefined}
              onClick={() => goTo(page - 1)}
            />
            <span className="lc-mono min-w-[9.5rem] text-center text-[13px] text-lc-fog" aria-live="polite">
              Page <span className="font-bold text-lc-chalk">{formatCount(page)}</span> of {formatCount(pages)}
            </span>
            <IconButton
              size="sm"
              variant="secondary"
              icon={<Icon name="next" />}
              aria-label="Next page"
              aria-disabled={page >= pages || undefined}
              onClick={() => goTo(page + 1)}
            />
          </div>
          {myPage !== null ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="profile" />}
              disabledReason={myPage === page ? "Your row is on this page" : undefined}
              onClick={() => goTo(myPage)}
            >
              Jump to me
            </Button>
          ) : null}
        </nav>
      ) : null}

      {footer}
    </section>
  );
};
