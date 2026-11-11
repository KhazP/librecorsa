"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Flag, RotateCw } from "lucide-react";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { lapPhysicsVersion, type LeaderboardEntry } from "@/lib/sim/lap-types";
import { boardLabel, driverNameKey, type BoardFilter, type RemoteBoard } from "@/lib/net/leaderboard";
import { CHOSEN_PILL, CURSOR_PILL } from "@/components/menu/menu-ui";
import { focusOnHover } from "@/components/menu/useFocusNav";
import { formatDelta, formatLapTime, formatSectorTime, HUD_PURPLE } from "./hud-format";

/**
 * A card of the panel: a frosted card in the pause menu, the darker inset card inside the title menu's
 * panel sheet (`.lc-title-frame`)
 */
const CARD =
  "flex min-w-0 flex-col gap-3 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/[0.82] p-[18px] text-[#F5F7FA] [.lc-title-frame_&]:rounded-[22px] [.lc-title-frame_&]:border-[#262B3D] [.lc-title-frame_&]:bg-[#08090D]/60";
/** Toolbar pill */
const BUTTON = `inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-full border border-[#262B3D] bg-[#08090D]/60 px-3.5 text-[13px] font-bold text-[#C5CBD8] transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-[#3A4157] hover:text-[#F5F7FA] disabled:cursor-not-allowed disabled:opacity-40 ${CURSOR_PILL} focus:border-transparent`;
/** Small in-row pill (race ghost, driver key) */
const SMALL_BUTTON = `inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[#262B3D] bg-transparent px-2.5 text-[12px] font-bold whitespace-nowrap text-[#C5CBD8] transition-[background-color,border-color,box-shadow,color] duration-200 hover:border-[#3A4157] hover:text-[#F5F7FA] ${CURSOR_PILL} focus:border-transparent`;

/** Position, car (and when), lap, three sectors, an action: the timing tower's columns */
const ROW_GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[32px_minmax(0,1fr)_88px_62px_62px_62px_minmax(96px,auto)]";
const SECTOR_CELL = "hidden text-right sm:block";

const CardHeader: React.FC<{ label: string; color: string; children?: React.ReactNode }> = ({ label, color, children }) => (
  <div className="flex items-center gap-2">
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
    <span className="lc-lbl">{label}</span>
    {children}
  </div>
);

/** A row of radio pills (circuit, car): white for the one picked, volt for the cursor */
function ChoiceRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="lc-lbl">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.id)}
              onPointerEnter={focusOnHover}
              className={`group inline-flex min-h-[36px] cursor-pointer items-center gap-2 rounded-full px-3.5 text-[13px] font-bold whitespace-nowrap transition-[background-color,box-shadow,color] duration-200 ${CURSOR_PILL} ${
                on ? CHOSEN_PILL : "text-[#C5CBD8] shadow-[inset_0_0_0_1px_#262B3D] hover:text-[#F5F7FA]"
              }`}
            >
              {o.label}
              {o.count !== undefined ? <span className="lc-data text-[11px] text-[#8E96AA] group-focus:text-[#08090D]">{o.count}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A time that is the fastest of its column: purple with a purple bar under it (colour is never alone) */
const Timed: React.FC<{ ms: number; best: boolean; lap?: boolean }> = ({ ms, best, lap }) => (
  <span
    className={`lc-data inline-block ${lap ? "text-[16px] sm:text-[17px]" : "text-[13px]"} ${best ? "" : lap ? "text-[#F5F7FA]" : "text-[#C5CBD8]"}`}
    style={best ? { color: HUD_PURPLE, boxShadow: `inset 0 -2px 0 ${HUD_PURPLE}` } : undefined}
    title={best ? "Fastest here" : undefined}
  >
    {lap ? formatLapTime(ms) : formatSectorTime(ms)}
  </span>
);

/** One driver of the online board: place, code and name over what the lap was driven with, lap time and the ghost */
const OnlineRow: React.FC<{
  rank: number;
  entry: LeaderboardEntry;
  fastest: boolean;
  mine: boolean;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
}> = ({ rank, entry, fastest, mine, onRaceGhost }) => (
  <li
    aria-current={mine ? "true" : undefined}
    className={`${ROW_GRID} min-h-[52px] rounded-[12px] px-3 py-1.5 ${
      mine ? "bg-[#CCFF00]/[0.07] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.35)]" : "hover:bg-white/[0.04]"
    }`}
  >
    <span className={`lc-data text-[15px] ${mine ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>{rank}</span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-[14px] font-bold text-[#F5F7FA]">
        <span className="font-f1-mono tracking-[0.1em]">{entry.code}</span> · {entry.name}
        {mine ? <span className="font-normal text-[#8E96AA]"> (you)</span> : null}
      </span>
      <span className="truncate text-[12px] text-[#8E96AA]">
        {entry.conditions ? `${boardLabel(entry.conditions)} · ` : ""}
        {new Date(entry.recordedAt).toLocaleDateString()}
      </span>
    </span>
    <span className="text-right">
      <Timed ms={entry.lapTimeMs} best={fastest} lap />
    </span>
    {entry.sectorTimesMs.map((s, i) => (
      <span key={i} className={SECTOR_CELL}>
        <Timed ms={s} best={false} />
      </span>
    ))}
    <span className="col-span-full flex justify-end sm:col-span-1">
      {onRaceGhost ? (
        <button type="button" onClick={() => onRaceGhost(entry)} onPointerEnter={focusOnHover} className={`${SMALL_BUTTON} h-[30px]`}>
          <Flag aria-hidden className="h-3.5 w-3.5" strokeWidth={2.4} />
          Race ghost
        </button>
      ) : null}
    </span>
  </li>
);

/** A pill that narrows the online board when on ("No assists") */
const FilterToggle: React.FC<{ label: string; on: boolean; onChange: (on: boolean) => void }> = ({ label, on, onChange }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={() => onChange(!on)}
    onPointerEnter={focusOnHover}
    className={`inline-flex min-h-[32px] cursor-pointer items-center rounded-full px-3 text-[12px] font-bold whitespace-nowrap transition-[background-color,box-shadow,color] duration-200 ${CURSOR_PILL} ${
      on ? CHOSEN_PILL : "text-[#C5CBD8] shadow-[inset_0_0_0_1px_#262B3D] hover:text-[#F5F7FA]"
    }`}
  >
    {label}
  </button>
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

/**
 * Lap times as a timing tower: the player's best laps by circuit and car, with sector splits (the fastest of each
 * column purple), the best sectors put together, and a ghost to race; the online board under it when there is one.
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
  const filtered = noAssists || fullRealism || wetOnly;

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

  return (
    <div className="flex flex-col gap-4 text-[#F5F7FA]">
      {/* Toolbar (the title menu's sheet already shows the leaderboard heading) */}
      <div className="flex flex-wrap items-end justify-between gap-3 [.lc-title-frame_&]:justify-end">
        <div className="flex min-w-0 flex-col gap-1.5 [.lc-title-frame_&]:hidden">
          <span className="lc-title text-[24px] leading-none">{nameOf(circuit)}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {onImportGhost ? (
            <>
              <button type="button" onClick={() => fileRef.current?.click()} onPointerEnter={focusOnHover} className={BUTTON}>
                Import ghost file…
              </button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
            </>
          ) : null}
          {onExportBest ? (
            <button type="button" onClick={onExportBest} onPointerEnter={focusOnHover} className={BUTTON}>
              <Download aria-hidden className="h-[15px] w-[15px]" strokeWidth={2.2} />
              Export my best
            </button>
          ) : null}
        </div>
      </div>

      {circuits.length > 1 || cars.length > 2 ? (
        <div className="flex flex-col gap-3">
          {circuits.length > 1 ? <ChoiceRow label="Circuit" options={circuits} value={circuit} onChange={setCircuit} /> : null}
          {cars.length > 2 ? <ChoiceRow label="Car" options={cars} value={carShown} onChange={setCar} /> : null}
        </div>
      ) : null}

      {/* Your laps: the timing tower */}
      <section className={CARD} aria-label="Your best laps">
        <CardHeader label="Your best laps" color="#CCFF00">
          <span className="truncate text-[12px] text-[#8E96AA]">{nameOf(circuit)}</span>
        </CardHeader>
        {rows.length === 0 ? (
          <p className="m-0 px-1 py-2 text-[14px] leading-relaxed text-[#C5CBD8]">
            No laps on {nameOf(circuit)} yet. Your best lap with each car is saved here as soon as you finish one.
          </p>
        ) : (
          <div className="overflow-hidden rounded-[14px] border border-[#262B3D]" role="table" aria-label={`Best laps on ${nameOf(circuit)}`}>
            {/* The timing tower's white cap */}
            <div role="row" className={`${ROW_GRID} bg-[#F5F7FA] px-3 py-2 font-f1-mono text-[11px] font-extrabold tracking-[0.14em] text-[#08090D] uppercase`}>
              <span role="columnheader">Pos</span>
              <span role="columnheader">Car</span>
              <span role="columnheader" className="text-right">
                Lap
              </span>
              {["S1", "S2", "S3"].map((s) => (
                <span key={s} role="columnheader" className={SECTOR_CELL}>
                  {s}
                </span>
              ))}
              <span role="columnheader" className="hidden sm:block" />
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {rows.map((e, i) => {
                const raceable = Boolean(onRaceGhost) && e.trackId === here;
                const board = e.conditions ? boardLabel(e.conditions) : null;
                return (
                  <li
                    key={`${e.trackId}-${e.vehicle}-${e.recordedAt}-${i}`}
                    role="row"
                    className={`${ROW_GRID} min-h-[54px] border-t border-[#262B3D] px-3 py-1.5 first:border-t-0 hover:bg-white/[0.03]`}
                  >
                    <span role="cell" className={`lc-data text-[15px] ${i === 0 ? "text-[#F5F7FA]" : "text-[#8E96AA]"}`}>
                      {i + 1}
                    </span>
                    <span role="cell" className="flex min-w-0 flex-col">
                      <span className="truncate text-[14px] font-bold text-[#F5F7FA]">{vehicleLabel(e.vehicle)}</span>
                      <span className="truncate text-[12px] text-[#8E96AA]" title={new Date(e.recordedAt).toLocaleString()}>
                        {new Date(e.recordedAt).toLocaleDateString()}
                        {board ? ` · ${board}` : ""}
                      </span>
                    </span>
                    <span role="cell" className="text-right">
                      <Timed ms={e.lapTimeMs} best={i === 0} lap />
                    </span>
                    {e.sectorTimesMs.map((s, k) => (
                      <span key={k} role="cell" className={SECTOR_CELL}>
                        <Timed ms={s} best={s > 0 && s === bestSector[k] && rows.length > 1} />
                      </span>
                    ))}
                    <span role="cell" className="col-span-full flex justify-end sm:col-span-1">
                      {raceable ? (
                        <button type="button" onClick={() => onRaceGhost?.(e)} onPointerEnter={focusOnHover} className={`${SMALL_BUTTON} h-[30px]`}>
                          <Flag aria-hidden className="h-3.5 w-3.5" strokeWidth={2.4} />
                          Race ghost
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>
            {theoretical && rows.length > 1 ? (
              <div className={`${ROW_GRID} border-t border-[#262B3D] bg-[#08090D]/60 px-3 py-2.5`}>
                <span aria-hidden />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-bold text-[#F5F7FA]">Best sectors together</span>
                  <span className="truncate text-[12px] text-[#8E96AA]">
                    {toFind < 0 ? `${formatDelta(toFind)} s left to find` : "Your best lap already has every best sector"}
                  </span>
                </span>
                <span className="lc-data text-right text-[15px] text-[#C5CBD8]">{formatLapTime(theoretical)}</span>
                {bestSector.map((s, k) => (
                  <span key={k} className={`${SECTOR_CELL} lc-data text-[13px] text-[#8E96AA]`}>
                    {formatSectorTime(s)}
                  </span>
                ))}
                <span className="hidden sm:block" />
              </div>
            ) : null}
          </div>
        )}
        {rows.length > 1 ? (
          <p className="m-0 px-1 text-[12px] text-[#8E96AA]">
            <span className="font-bold" style={{ color: HUD_PURPLE }}>
              Underlined purple
            </span>{" "}
            is the fastest lap and the fastest of each sector here.
          </p>
        ) : null}
      </section>

      {/* Online times */}
      {remoteEnabled ? (
        <section className={CARD} aria-label="Online">
          <CardHeader label="Online" color="#00E5FF">
            <span className="min-w-0 truncate text-[12px] text-[#8E96AA]">
              {onlineCar ? `${vehicleLabel(onlineCar)} · ` : ""}
              {nameOf(circuit)}
            </span>
            <button
              type="button"
              onClick={() => setReload((n) => n + 1)}
              disabled={online.loading}
              onPointerEnter={focusOnHover}
              aria-label="Refresh online times"
              className={`${SMALL_BUTTON} ml-auto h-[30px]`}
            >
              <RotateCw aria-hidden className={`h-3.5 w-3.5 ${online.loading ? "animate-spin" : ""}`} strokeWidth={2.2} />
              {online.loading ? "Loading…" : "Refresh"}
            </button>
          </CardHeader>

          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show only">
            <span className="lc-lbl mr-1">Only</span>
            <FilterToggle label="No assists" on={noAssists} onChange={setNoAssists} />
            <FilterToggle label="Full realism" on={fullRealism} onChange={setFullRealism} />
            <FilterToggle label="Wet laps" on={wetOnly} onChange={setWetOnly} />
            {olderPhysics.length > 0 || physics !== currentPhysics ? (
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <FilterToggle label="Current version" on={physics === currentPhysics} onChange={() => setPhysics(currentPhysics)} />
                {[...new Set([...olderPhysics, ...(physics !== currentPhysics ? [physics] : [])])].map((v) => (
                  <FilterToggle key={v} label={`Older laps (v${v})`} on={physics === v} onChange={() => setPhysics(v)} />
                ))}
              </span>
            ) : null}
          </div>

          {/* Where the player stands */}
          {me ? (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[14px] border border-[#CCFF00]/30 bg-[#CCFF00]/[0.05] px-3.5 py-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] font-bold text-[#F5F7FA]">
                  You are <span className="lc-data text-[#CCFF00]">P{me.rank}</span> of {shown?.total ?? me.rank}
                  <span className="lc-data ml-2 text-[#C5CBD8]">{formatLapTime(me.entry.lapTimeMs)}</span>
                </span>
                <span className="truncate text-[12px] text-[#8E96AA]">
                  {me.rank === 1
                    ? "Fastest on this board"
                    : ahead
                      ? `${((me.entry.lapTimeMs - ahead.lapTimeMs) / 1000).toFixed(3)} s behind ${ahead.name}`
                      : leader
                        ? `${((me.entry.lapTimeMs - leader.lapTimeMs) / 1000).toFixed(3)} s off the fastest lap`
                        : ""}
                </span>
              </span>
              {ahead && onRaceGhost && circuit === here ? (
                <button type="button" onClick={() => onRaceGhost(ahead)} onPointerEnter={focusOnHover} className={`${SMALL_BUTTON} h-9`}>
                  <Flag aria-hidden className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Race the ghost ahead
                </button>
              ) : null}
            </div>
          ) : null}

          {online.loading && !shown ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">Loading online times…</p>
          ) : online.error && !shown ? (
            <p role="alert" className="m-0 px-1 py-2 text-[13px] text-[#FF2A3C]">
              Couldn&apos;t load the online times. Check your connection and press Refresh.
            </p>
          ) : !shown || shown.entries.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">
              {filtered ? "No online laps like that here yet. Turn a filter off to see every lap." : "No online times for this circuit and car yet. Yours can be the first."}
            </p>
          ) : (
            <>
              {online.error && !online.loading ? (
                <p role="alert" className="m-0 px-1 pb-1 text-[12px] text-[#FFB300]">
                  Couldn&apos;t refresh. These are the last times loaded.
                </p>
              ) : null}
              <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
                {shown.entries.map((e, i) => (
                  <OnlineRow
                    key={e.id ?? `${e.code}-${e.recordedAt}-${i}`}
                    rank={i + 1}
                    entry={e}
                    fastest={i === 0}
                    mine={myKey !== "" && driverNameKey(e.name) === myKey}
                    onRaceGhost={circuit === here ? onRaceGhost : undefined}
                  />
                ))}
              </ol>
              {shown.total > shown.entries.length ? (
                <p className="m-0 px-1 text-[12px] text-[#8E96AA]">
                  The fastest {shown.entries.length} of {shown.total} drivers.
                </p>
              ) : null}
            </>
          )}
          {onExportDriverKey || onImportDriverKey ? (
            <div className="mt-1.5 flex flex-col gap-2.5 border-t border-[#262B3D] pt-3.5">
              <p className="m-0 text-[12px] leading-relaxed text-[#8E96AA]">
                <span className="font-f1-mono font-extrabold tracking-[0.1em] text-[#F5F7FA]">DRIVER KEY</span> · Your first
                upload claims your name, and this browser keeps the key to it. Export the key to race under the same name on
                another browser or device, and keep the file private.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {onExportDriverKey ? (
                  <button type="button" onClick={onExportDriverKey} onPointerEnter={focusOnHover} className={`${SMALL_BUTTON} h-9`}>
                    Export key
                  </button>
                ) : null}
                {onImportDriverKey ? (
                  <>
                    <button type="button" onClick={() => keyFileRef.current?.click()} onPointerEnter={focusOnHover} className={`${SMALL_BUTTON} h-9`}>
                      Import key…
                    </button>
                    <input ref={keyFileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleKeyFile} />
                  </>
                ) : null}
                {driverKeyNotice ? <span className="text-[12px] text-[#F5F7FA]">{driverKeyNotice}</span> : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : (
        <p className="m-0 px-1 text-[13px] text-[#8E96AA]">Online times are off in this version: these are the laps saved in this browser.</p>
      )}
    </div>
  );
};
