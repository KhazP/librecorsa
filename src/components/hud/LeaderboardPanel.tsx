"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { lapPhysicsVersion, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { boardLabel, driverNameKey, type BoardFilter, type RemoteBoard } from "@/lib/net/leaderboard";
import { Button, Card, IconButton, Disclosure, EmptyState, Segmented, Select, SettingRow, Skeleton, Toggle } from "@/components/ui";
import { PlayerTag, PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";
import { formatDelta, formatLapTime, formatSectorTime } from "./hud-format";

/* ---------------------------------------------------------------------------------------------------------------
 * The board table: one drawing of a timing list for the lap times, the online board and the weekly challenge
 * ------------------------------------------------------------------------------------------------------------- */

export interface BoardRow {
  key: string;
  rank: number;
  /** The car (your laps) or the driver's name (a board) */
  title: string;
  /** The driver's three-letter code, before the name */
  code?: string;
  /** One line under the title: when, and how the lap was driven */
  detail?: string;
  /** Full date for the detail's tooltip */
  detailTitle?: string;
  lapMs: number;
  /** The fastest lap of the list: best colour and an underline (colour is not alone) */
  fastest?: boolean;
  sectorsMs?: readonly number[];
  /** Which of the three sectors is the fastest of its column */
  bestSectors?: readonly boolean[];
  /** The player's own row */
  mine?: boolean;
  /** An action at the end of the row (race this lap's ghost) */
  action?: React.ReactNode;
}

/** A time, the best of its column in the best colour with an underline, and said so to a screen reader */
const Timed: React.FC<{ ms: number; best: boolean; lap?: boolean }> = ({ ms, best, lap }) => (
  <span
    className={`lc-mono font-bold whitespace-nowrap ${lap ? "text-[15px]" : "text-[13px]"} ${
      best ? "text-lc-best underline decoration-2 underline-offset-4" : lap ? "text-lc-chalk" : "text-lc-fog"
    }`}
    title={best ? "Fastest here" : undefined}
  >
    {lap ? formatLapTime(ms) : formatSectorTime(ms)}
    {best ? <span className="sr-only"> (fastest)</span> : null}
  </span>
);

const TH = "lc-lbl px-2 pb-2 text-left font-semibold whitespace-nowrap";
/** Sector columns show only where the list has room for them */
const SECTOR = "hidden text-right @2xl:table-cell";

/** Laps as a timing list: place, who or what, lap time, the three sectors where there is room, and an action */
export const BoardTable: React.FC<{ label: string; rows: readonly BoardRow[]; nameHeader?: string; footer?: React.ReactNode }> = ({
  label,
  rows,
  nameHeader = "Driver",
  footer,
}) => {
  const sectors = rows.some((r) => r.sectorsMs?.length);
  const actions = rows.some((r) => r.action);
  return (
    <div className="@container min-w-0">
      <table className="w-full border-collapse" aria-label={label}>
        <thead>
          <tr className="border-b border-lc-line">
            <th scope="col" className={`${TH} w-14`}>
              Pos
            </th>
            <th scope="col" className={`${TH} w-full`}>
              {nameHeader}
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Lap
            </th>
            {sectors
              ? ["S1", "S2", "S3"].map((s) => (
                  <th key={s} scope="col" className={`${TH} ${SECTOR}`}>
                    {s}
                  </th>
                ))
              : null}
            {actions ? (
              <th scope="col" className="p-0">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              aria-current={r.mine ? "true" : undefined}
              className={`h-13 border-b border-white/5 last:border-b-0 ${r.mine ? "bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""}`}
            >
              <td className="px-2">
                <PositionBadge position={r.rank} player={r.mine} size="sm" className="min-w-10" />
              </td>
              <td className="max-w-0 px-2 py-1.5">
                <span className="flex min-w-0 items-center gap-2">
                  {r.code ? <span className="lc-mono w-8 shrink-0 text-[12px] font-bold tracking-[0.08em] text-lc-slate">{r.code}</span> : null}
                  <span className="truncate text-[14px] font-semibold text-lc-chalk">{r.title}</span>
                  {r.mine ? <PlayerTag size="sm" /> : null}
                </span>
                {r.detail ? (
                  <span className="lc-hint block truncate" title={r.detailTitle}>
                    {r.detail}
                  </span>
                ) : null}
              </td>
              <td className="px-2 text-right">
                <Timed ms={r.lapMs} best={Boolean(r.fastest)} lap />
              </td>
              {sectors
                ? [0, 1, 2].map((k) => (
                    <td key={k} className={`px-2 ${SECTOR}`}>
                      {r.sectorsMs?.[k] ? <Timed ms={r.sectorsMs[k]} best={Boolean(r.bestSectors?.[k])} /> : null}
                    </td>
                  ))
                : null}
              {actions ? <td className="py-1.5 pl-2 text-right whitespace-nowrap">{r.action}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {footer}
    </div>
  );
};

/** Rows standing in for a list that is loading, at the rows' own height */
export const BoardSkeleton: React.FC<{ rows?: number; label: string }> = ({ rows = 5, label }) => (
  <div role="status" aria-busy="true" aria-label={label} className="flex flex-col">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex h-13 items-center gap-3 border-b border-white/5 px-2 last:border-b-0">
        <Skeleton shape="line" className="h-5 w-10" />
        <Skeleton shape="line" className="w-2/5" />
        <Skeleton shape="line" className="ml-auto w-20" />
      </div>
    ))}
  </div>
);

/** A list that could not be read: what went wrong, in the loss colour on the card itself, and a way to try again */
export const BoardError: React.FC<{ children: React.ReactNode; onRetry?: () => void }> = ({ children, onRetry }) => (
  <div role="alert" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 py-2">
    <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-loss">
      <Icon name="error" className="mt-0.5" />
      {children}
    </p>
    {onRetry ? (
      <Button size="sm" variant="secondary" icon={<Icon name="refresh" />} onClick={onRetry}>
        Try again
      </Button>
    ) : null}
  </div>
);

/** The player's own place on a board, in their colour */
export const MyPlace: React.FC<{ rank: number; total: number; lapMs: number; detail: string; action?: React.ReactNode }> = ({
  rank,
  total,
  lapMs,
  detail,
  action,
}) => (
  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lc-row border border-lc-volt/35 bg-lc-volt/5 px-3.5 py-2.5">
    <span className="flex min-w-0 items-center gap-3">
      <PositionBadge position={rank} player />
      <span className="flex min-w-0 flex-col">
        <span className="text-[14px] font-semibold text-lc-chalk">
          You are P{rank} of {total}
          <span className="lc-mono ml-2 font-bold text-lc-fog">{formatLapTime(lapMs)}</span>
        </span>
        {detail ? <span className="lc-hint truncate">{detail}</span> : null}
      </span>
    </span>
    {action}
  </div>
);

/** "0.214 s behind Ana" */
const behind = (ms: number, aheadMs: number, who: string) => `${((ms - aheadMs) / 1000).toFixed(3)} s behind ${who}`;

/** The button that races a lap's ghost: a round icon button in a row, a worded one on its own */
const RaceGhost: React.FC<{ onClick: () => void; label?: string; of?: string }> = ({ onClick, label, of }) =>
  label ? (
    <Button size="sm" variant="secondary" icon={<Icon name="ghost" />} onClick={onClick}>
      {label}
    </Button>
  ) : (
    <IconButton size="sm" variant="secondary" icon={<Icon name="ghost" />} aria-label={`Race the ghost of ${of}`} title="Race ghost" onClick={onClick} />
  );

export interface LeaderboardPanelProps {
  trackName: string;
  /** The loaded circuit (laps on it can be raced as a ghost) */
  trackId?: string;
  /** A circuit's name, for the circuit switcher */
  trackNameOf?: (id: string) => string;
  vehicleLabel: (id: string) => string;
  /** This car's best laps on this circuit, saved in this browser */
  local: LeaderboardEntry[];
  /** Every personal best saved in this browser, any circuit and car: lets the panel switch circuit and car */
  loadAllLocal?: () => Promise<LeaderboardEntry[]>;
  /** This site has an online board */
  remoteEnabled: boolean;
  /** Reads one online board (a circuit and car, optionally only laps driven a certain way); null when it can't be read */
  loadRemote?: (trackId: string, vehicle: VehicleModelId, filter: BoardFilter, physics: number) => Promise<RemoteBoard | null>;
  /** Changes when the online board may have changed (a lap went up): it is read again */
  boardVersion?: number;
  /** The car being driven: the online board shown until another car is picked */
  vehicle?: string;
  /** The player's name, to mark their row */
  driverName?: string;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
  onImportGhost?: (file: File) => void;
  onExportBest?: () => void;
  /** Driver key (claims the name on the online board): export to a file, import from one, and the last result */
  onExportDriverKey?: () => void;
  onImportDriverKey?: (file: File) => void;
  driverKeyNotice?: string | null;
}

const ALL_CARS = "all";
const CURRENT = "current";

/**
 * Lap times as a timing list: the player's best laps by circuit and car, with sector splits (the fastest of each
 * column marked), the best sectors put together, and a ghost to race; the online board under it when there is one.
 */
export const LeaderboardPanel: React.FC<LeaderboardPanelProps> = ({
  trackName,
  trackId,
  trackNameOf,
  vehicleLabel,
  local,
  loadAllLocal,
  remoteEnabled,
  loadRemote,
  boardVersion = 0,
  vehicle,
  driverName = "",
  onRaceGhost,
  onImportGhost,
  onExportBest,
  onExportDriverKey,
  onImportDriverKey,
  driverKeyNotice = null,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const keyFileRef = useRef<HTMLInputElement | null>(null);

  // Every saved best, reloaded when this circuit's list changes (a new lap was saved)
  const [allLocal, setAllLocal] = useState<LeaderboardEntry[] | null>(null);
  useEffect(() => {
    if (!loadAllLocal) return;
    let live = true;
    loadAllLocal()
      .then((laps) => {
        if (live) setAllLocal(laps);
      })
      .catch(() => {
        if (live) setAllLocal(null);
      });
    return () => {
      live = false;
    };
  }, [loadAllLocal, local]);

  const here = trackId ?? local[0]?.trackId ?? "";
  const [circuit, setCircuit] = useState(here);
  const [car, setCar] = useState<string>(ALL_CARS);
  const pool = allLocal ?? local;
  const nameOf = (id: string) => (id === here ? trackName : (trackNameOf?.(id) ?? id));

  const circuits = useMemo(() => {
    const ids = [...new Set(pool.map((e) => e.trackId))];
    if (here && !ids.includes(here)) ids.push(here);
    return ids
      .map((id) => ({ id, label: id === here ? trackName : (trackNameOf?.(id) ?? id), count: pool.filter((e) => e.trackId === id).length }))
      .sort((a, b) => (a.id === here ? -1 : b.id === here ? 1 : a.label.localeCompare(b.label)));
  }, [pool, here, trackName, trackNameOf]);

  const onCircuit = useMemo(() => pool.filter((e) => e.trackId === circuit), [pool, circuit]);
  const cars = useMemo(() => {
    const ids: string[] = [...new Set(onCircuit.map((e) => e.vehicle))];
    // The car being driven can always be picked on its own circuit (for its online board), laps or not
    if (vehicle && circuit === here && !ids.includes(vehicle)) ids.push(vehicle);
    return [
      { id: ALL_CARS, label: "All cars", count: onCircuit.length },
      ...ids.map((id) => ({ id, label: vehicleLabel(id), count: onCircuit.filter((e) => e.vehicle === id).length })),
    ];
  }, [onCircuit, vehicleLabel, vehicle, circuit, here]);
  const carShown = cars.some((c) => c.id === car) ? car : ALL_CARS;

  // Fastest first, whatever order the caller passed
  const rows = useMemo(
    () => onCircuit.filter((e) => carShown === ALL_CARS || e.vehicle === carShown).sort((a, b) => a.lapTimeMs - b.lapTimeMs),
    [onCircuit, carShown],
  );
  const bestSector = [0, 1, 2].map((i) => {
    const times = rows.map((r) => r.sectorTimesMs[i]).filter((t) => t > 0);
    return times.length ? Math.min(...times) : 0;
  });
  const theoretical = bestSector.every((t) => t > 0) ? bestSector[0] + bestSector[1] + bestSector[2] : 0;
  const bestLap = rows[0]?.lapTimeMs ?? 0;
  const toFind = theoretical && bestLap ? (theoretical - bestLap) / 1000 : 0;

  // ---- The online board: follows the circuit and car picked above (with "All cars", the car being driven)
  const onlineCar = carShown !== ALL_CARS ? carShown : (vehicle ?? rows[0]?.vehicle ?? "");
  const [noAssists, setNoAssists] = useState(false);
  const [fullRealism, setFullRealism] = useState(false);
  const [wetOnly, setWetOnly] = useState(false);
  // The revision this car is driven under now: its current board (the Prototype has its own, `lapPhysicsVersion`)
  const currentPhysics = lapPhysicsVersion(isVehicleModelId(onlineCar) ? onlineCar : undefined);
  const [physics, setPhysics] = useState(currentPhysics);
  const [reload, setReload] = useState(0);
  /** `key`: the circuit, car and filters `board` was read for (a board is never shown under another's heading) */
  const [online, setOnline] = useState<{ key: string; board: RemoteBoard | null; loading: boolean; error: boolean }>({
    key: "",
    board: null,
    loading: false,
    error: false,
  });
  const boardKey = `${circuit}|${onlineCar}|${noAssists}|${fullRealism}|${wetOnly}|${physics}`;
  // Another circuit or car starts on the current physics again
  useEffect(() => setPhysics(currentPhysics), [circuit, onlineCar, currentPhysics]);
  useEffect(() => {
    if (!remoteEnabled || !loadRemote || !circuit || !isVehicleModelId(onlineCar)) {
      setOnline({ key: "", board: null, loading: false, error: false });
      return;
    }
    let live = true;
    setOnline((o) => ({ ...o, loading: true }));
    const filter: BoardFilter = {};
    if (noAssists) filter.assists = "pro";
    if (fullRealism) filter.realism = "full";
    if (wetOnly) filter.surface = "wet";
    void loadRemote(circuit, onlineCar, filter, physics).then((board) => {
      if (!live) return;
      // On a failed refresh of the same board the times already shown stay (marked as older)
      setOnline((o) => ({ key: boardKey, board: board ?? (o.key === boardKey ? o.board : null), loading: false, error: board === null }));
    });
    return () => {
      live = false;
    };
    // boardKey stands for the circuit, car, filters and physics
  }, [remoteEnabled, loadRemote, boardKey, boardVersion, reload]);
  const shown = online.key === boardKey ? online.board : null;
  const myKey = driverNameKey(driverName);
  const me = shown?.me ?? null;
  // The driver just ahead, when they are among the rows fetched
  const ahead = me && me.rank >= 2 ? (shown?.entries[me.rank - 2] ?? null) : null;
  const leader = shown?.entries[0] ?? null;
  const olderPhysics = (shown?.physics ?? []).filter((v) => v !== currentPhysics);
  const filtersOn = [noAssists, fullRealism, wetOnly].filter(Boolean).length;
  const versions = [...new Set([...olderPhysics, ...(physics !== currentPhysics ? [physics] : [])])];
  const clearFilters = () => {
    setNoAssists(false);
    setFullRealism(false);
    setWetOnly(false);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear so picking the same file again still fires onChange
    e.target.value = "";
    if (file && onImportGhost) onImportGhost(file);
  };
  const handleKeyFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file && onImportDriverKey) onImportDriverKey(file);
  };

  const localRows: BoardRow[] = rows.map((e, i) => {
    const board = e.conditions ? boardLabel(e.conditions) : null;
    return {
      key: `${e.trackId}-${e.vehicle}-${e.recordedAt}-${i}`,
      rank: i + 1,
      title: vehicleLabel(e.vehicle),
      detail: `${new Date(e.recordedAt).toLocaleDateString()}${board ? ` · ${board}` : ""}`,
      detailTitle: new Date(e.recordedAt).toLocaleString(),
      lapMs: e.lapTimeMs,
      fastest: i === 0 && rows.length > 1,
      sectorsMs: e.sectorTimesMs,
      bestSectors: e.sectorTimesMs.map((s, k) => s > 0 && s === bestSector[k] && rows.length > 1),
      action: Boolean(onRaceGhost) && e.trackId === here ? <RaceGhost of={`your ${vehicleLabel(e.vehicle)} lap`} onClick={() => onRaceGhost?.(e)} /> : undefined,
    };
  });

  const onlineRows: BoardRow[] = (shown?.entries ?? []).map((e, i) => ({
    key: e.id ?? `${e.code}-${e.recordedAt}-${i}`,
    rank: i + 1,
    code: e.code,
    title: e.name,
    detail: `${e.conditions ? `${boardLabel(e.conditions)} · ` : ""}${new Date(e.recordedAt).toLocaleDateString()}`,
    lapMs: e.lapTimeMs,
    fastest: i === 0,
    sectorsMs: e.sectorTimesMs,
    mine: myKey !== "" && driverNameKey(e.name) === myKey,
    action: onRaceGhost && circuit === here ? <RaceGhost of={`${e.name}'s lap`} onClick={() => onRaceGhost(e)} /> : undefined,
  }));

  return (
    <div className="flex flex-col gap-3 text-lc-chalk">
      {/* Toolbar: the sheet around the panel already names it, and the card below names the circuit */}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="flex flex-wrap gap-2">
          {onImportGhost ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
                Import ghost file
              </Button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
            </>
          ) : null}
          {onExportBest ? (
            <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={onExportBest}>
              Export my best
            </Button>
          ) : null}
        </div>
      </div>

      {circuits.length > 1 || cars.length > 2 ? (
        <div className="flex flex-col">
          {circuits.length > 1 ? (
            <SettingRow label="Circuit">
              <Select
                className="w-64 max-w-full"
                value={circuit}
                onChange={setCircuit}
                options={circuits.map((c) => ({ id: c.id, label: c.label, detail: c.count === 1 ? "1 lap" : `${c.count} laps` }))}
              />
            </SettingRow>
          ) : null}
          {cars.length > 2 ? (
            <SettingRow label="Car">
              <Select
                className="w-64 max-w-full"
                value={carShown}
                onChange={setCar}
                options={cars.map((c) => ({ id: c.id, label: c.label, detail: c.count === 1 ? "1 lap" : `${c.count} laps` }))}
              />
            </SettingRow>
          ) : null}
        </div>
      ) : null}

      {/* Your laps */}
      <Card title="Your best laps" description={nameOf(circuit)}>
        {rows.length === 0 ? (
          <EmptyState icon={<Icon name="lapTimes" />}>
            No laps on {nameOf(circuit)} yet. Your best lap with each car is saved here as soon as you finish one.
          </EmptyState>
        ) : (
          <BoardTable
            label={`Best laps on ${nameOf(circuit)}`}
            nameHeader="Car"
            rows={localRows}
            footer={
              theoretical && rows.length > 1 ? (
                <div className="mt-1 flex items-center justify-between gap-4 rounded-lc-row bg-white/3 px-2 py-2.5">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[14px] font-semibold text-lc-chalk">Best sectors together</span>
                    <span className="lc-hint">
                      {toFind < 0 ? `${formatDelta(toFind)} s left to find` : "Your best lap already has every best sector"}
                    </span>
                  </span>
                  <span className="lc-mono text-[15px] font-bold text-lc-fog">{formatLapTime(theoretical)}</span>
                </div>
              ) : null
            }
          />
        )}
      </Card>

      {/* Online times */}
      {remoteEnabled ? (
        <Card
          title="Online times"
          description={`${onlineCar ? `${vehicleLabel(onlineCar)} · ` : ""}${nameOf(circuit)}`}
          bodyClassName="gap-3"
          action={
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="refresh" />}
              loading={online.loading}
              aria-label="Refresh online times"
              onClick={() => setReload((n) => n + 1)}
            >
              Refresh
            </Button>
          }
        >
          <Disclosure moreLabel={filtersOn ? `Filters · ${filtersOn} on` : "Filters"} lessLabel="Hide filters">
            <SettingRow label="No assists" hint="Only laps driven without driving aids">
              <Toggle checked={noAssists} onChange={setNoAssists} />
            </SettingRow>
            <SettingRow label="Full realism" hint="Only laps driven on full realism">
              <Toggle checked={fullRealism} onChange={setFullRealism} />
            </SettingRow>
            <SettingRow label="Wet laps" hint="Only laps driven on a wet track">
              <Toggle checked={wetOnly} onChange={setWetOnly} />
            </SettingRow>
            {versions.length > 0 ? (
              <SettingRow label="Physics version" hint="Laps from an older version of the physics are kept on their own board">
                {versions.length + 1 <= 5 ? (
                  <Segmented
                    size="sm"
                    value={physics === currentPhysics ? CURRENT : String(physics)}
                    onChange={(id) => setPhysics(id === CURRENT ? currentPhysics : Number(id))}
                    options={[{ id: CURRENT, label: "Current" }, ...versions.map((v) => ({ id: String(v), label: `v${v}` }))]}
                  />
                ) : (
                  <Select
                    value={physics === currentPhysics ? CURRENT : String(physics)}
                    onChange={(id) => setPhysics(id === CURRENT ? currentPhysics : Number(id))}
                    options={[{ id: CURRENT, label: "Current" }, ...versions.map((v) => ({ id: String(v), label: `Older laps (v${v})` }))]}
                  />
                )}
              </SettingRow>
            ) : null}
          </Disclosure>

          {/* Where the player stands */}
          {me ? (
            <MyPlace
              rank={me.rank}
              total={shown?.total ?? me.rank}
              lapMs={me.entry.lapTimeMs}
              detail={
                me.rank === 1
                  ? "Fastest on this board"
                  : ahead
                    ? behind(me.entry.lapTimeMs, ahead.lapTimeMs, ahead.name)
                    : leader
                      ? `${((me.entry.lapTimeMs - leader.lapTimeMs) / 1000).toFixed(3)} s off the fastest lap`
                      : ""
              }
              action={ahead && onRaceGhost && circuit === here ? <RaceGhost onClick={() => onRaceGhost(ahead)} label="Race the ghost ahead" /> : undefined}
            />
          ) : null}

          {online.loading && !shown ? (
            <BoardSkeleton label="Loading online times" />
          ) : online.error && !shown ? (
            <BoardError onRetry={() => setReload((n) => n + 1)}>Couldn&apos;t load the online times. Check your connection.</BoardError>
          ) : !shown || shown.entries.length === 0 ? (
            <EmptyState
              icon={<Icon name={filtersOn ? "filter" : "online"} />}
              action={
                filtersOn ? (
                  <Button size="sm" variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            >
              {filtersOn
                ? "No online laps like that here yet. Clear the filters to see every lap."
                : "No online times for this circuit and car yet. Finish a lap and yours can be the first."}
            </EmptyState>
          ) : (
            <>
              {online.error && !online.loading ? (
                <p role="alert" className="m-0 flex items-center gap-2 text-[13px] font-medium text-lc-caution">
                  <Icon name="warning" />
                  Couldn&apos;t refresh. These are the last times loaded.
                </p>
              ) : null}
              <BoardTable
                label={`Online times on ${nameOf(circuit)}`}
                rows={onlineRows}
                footer={
                  shown.total > shown.entries.length ? (
                    <p className="lc-hint m-0 px-2 pt-2">
                      The fastest {shown.entries.length} of {shown.total} drivers.
                    </p>
                  ) : null
                }
              />
            </>
          )}
          {onExportDriverKey || onImportDriverKey ? (
            <div className="mt-1 flex flex-col gap-2.5 border-t border-lc-line pt-3.5">
              <h4 className="lc-row-label m-0">Driver key</h4>
              <p className="lc-hint m-0 max-w-[62ch]">
                Your first upload claims your name, and this browser keeps the key to it. Export the key to race under the same
                name on another browser or device, and keep the file private.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {onExportDriverKey ? (
                  <Button size="sm" variant="secondary" icon={<Icon name="download" />} onClick={onExportDriverKey}>
                    Export key
                  </Button>
                ) : null}
                {onImportDriverKey ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => keyFileRef.current?.click()}>
                      Import key
                    </Button>
                    <input ref={keyFileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleKeyFile} />
                  </>
                ) : null}
                {driverKeyNotice ? (
                  <span role="status" className="text-[13px] text-lc-chalk">
                    {driverKeyNotice}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </Card>
      ) : (
        <p className="lc-hint m-0 px-1">Online times are off in this version: these are the laps saved in this browser.</p>
      )}
    </div>
  );
};
