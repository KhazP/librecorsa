"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Flag, RotateCw } from "lucide-react";
import type { LeaderboardEntry } from "@/lib/sim/lap-types";
import { boardLabel } from "@/lib/net/leaderboard";
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

/** One ranked lap of the online board: position, code, name over car and date, lap time and the ghost */
const OnlineRow: React.FC<{
  index: number;
  entry: LeaderboardEntry;
  vehicleLabel: (id: string) => string;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
}> = ({ index, entry, vehicleLabel, onRaceGhost }) => (
  <li className={`${ROW_GRID} min-h-[52px] rounded-[12px] px-3 py-1.5 hover:bg-white/[0.04]`}>
    <span className="lc-data text-[15px] text-[#8E96AA]">{index + 1}</span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-[14px] font-bold text-[#F5F7FA]">
        <span className="font-f1-mono tracking-[0.1em]">{entry.code}</span> · {entry.name}
      </span>
      <span className="truncate text-[12px] text-[#8E96AA]">
        {vehicleLabel(entry.vehicle)} · {new Date(entry.recordedAt).toLocaleDateString()}
      </span>
    </span>
    <span className="text-right">
      <Timed ms={entry.lapTimeMs} best={index === 0} lap />
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

export interface LeaderboardPanelProps {
  trackName: string;
  /** The loaded circuit (laps on it can be raced as a ghost) */
  trackId?: string;
  /** A circuit's name, for the circuit switcher */
  trackNameOf?: (id: string) => string;
  vehicleLabel: (id: string) => string;
  /** This car's laps on this circuit, on the board being driven */
  local: LeaderboardEntry[];
  /** Every personal best saved in this browser, any circuit and car: lets the panel switch circuit and car */
  loadAllLocal?: () => Promise<LeaderboardEntry[]>;
  remote: LeaderboardEntry[];
  remoteEnabled: boolean;
  /** Assists, realism and surface of the online board shown ("No assists · Full · Dry") */
  remoteBoardLabel?: string;
  loading: boolean;
  /** The last fetch of the online board failed (the times shown, if any, are older ones) */
  error?: boolean;
  onRefresh: () => void;
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
  remote,
  remoteEnabled,
  remoteBoardLabel,
  loading,
  error = false,
  onRefresh,
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
    const ids = [...new Set(onCircuit.map((e) => e.vehicle))];
    return [
      { id: ALL_CARS, label: "All cars", count: onCircuit.length },
      ...ids.map((id) => ({ id: id as string, label: vehicleLabel(id), count: onCircuit.filter((e) => e.vehicle === id).length })),
    ];
  }, [onCircuit, vehicleLabel]);
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

  const remoteSorted = useMemo(() => [...remote].sort((a, b) => a.lapTimeMs - b.lapTimeMs), [remote]);

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
          <span className="lc-lbl text-[#CCFF00]">Lap times</span>
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
          {remoteEnabled ? (
            <button type="button" onClick={onRefresh} disabled={loading} onPointerEnter={focusOnHover} className={BUTTON}>
              <RotateCw aria-hidden className={`h-[15px] w-[15px] ${loading ? "animate-spin" : ""}`} strokeWidth={2.2} />
              {loading ? "Refreshing…" : "Refresh online"}
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
            {remoteBoardLabel ? (
              <span className="truncate text-[12px] text-[#8E96AA]" title="Laps are ranked against laps driven with the same assists, realism and surface">
                {remoteBoardLabel}
              </span>
            ) : null}
            {loading ? (
              <span className="lc-breathe ml-auto font-f1-mono text-[11px] font-extrabold tracking-[0.12em] text-[#00E5FF]">LOADING…</span>
            ) : null}
          </CardHeader>
          {loading && remoteSorted.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">Loading online times…</p>
          ) : error && remoteSorted.length === 0 ? (
            <p role="alert" className="m-0 px-1 py-2 text-[13px] text-[#FF2A3C]">
              Couldn&apos;t load the online times. Check your connection and press Refresh online.
            </p>
          ) : remoteSorted.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">No online times for this circuit and car yet.</p>
          ) : (
            <>
              {error && !loading ? (
                <p role="alert" className="m-0 px-1 pb-1 text-[12px] text-[#FFB300]">
                  Couldn&apos;t refresh. These are the last times loaded.
                </p>
              ) : null}
              <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
                {remoteSorted.map((e, i) => (
                  <OnlineRow key={e.id ?? `${e.code}-${e.recordedAt}-${i}`} index={i} entry={e} vehicleLabel={vehicleLabel} onRaceGhost={onRaceGhost} />
                ))}
              </ol>
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
