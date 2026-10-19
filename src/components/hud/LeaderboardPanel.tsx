"use client";

import React, { useMemo, useRef } from "react";
import { Download, RotateCw } from "lucide-react";
import type { LeaderboardEntry } from "@/lib/sim/lap-types";
import { formatLapTime } from "./hud-format";

/**
 * A card of the panel: a frosted card in the pause menu, the darker inset card inside the title menu's
 * panel sheet (`.lc-title-frame`)
 */
const CARD =
  "flex min-w-0 flex-col gap-2.5 rounded-[24px] border border-white/[0.07] bg-[#0D0F15]/[0.82] p-[18px] text-[#F5F7FA] [.lc-title-frame_&]:rounded-[22px] [.lc-title-frame_&]:border-[#262B3D] [.lc-title-frame_&]:bg-[#08090D]/60";
/** Toolbar pill */
const BUTTON =
  "inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-full border border-[#262B3D] bg-[#08090D]/60 px-3.5 text-[13px] font-bold text-[#C5CBD8] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#262B3D] disabled:hover:text-[#C5CBD8]";
/** Small in-row pill (race ghost, driver key) */
const SMALL_BUTTON =
  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-[#262B3D] bg-transparent px-2.5 text-[12px] font-bold whitespace-nowrap text-[#C5CBD8] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00]";

const CardHeader: React.FC<{ label: string; color: string; children?: React.ReactNode }> = ({ label, color, children }) => (
  <div className="flex items-center gap-2">
    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
    <span className="lc-lbl">{label}</span>
    {children}
  </div>
);

/** One ranked lap: position, code, name over car and date, lap time and an optional ghost race button */
const LeaderRow: React.FC<{
  index: number;
  entry: LeaderboardEntry;
  vehicleLabel: (id: string) => string;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
  highlight?: boolean;
}> = ({ index, entry, vehicleLabel, onRaceGhost, highlight }) => (
  <li
    className={`grid min-h-[52px] items-center gap-x-2.5 rounded-[14px] px-3 py-1.5 transition-colors ${
      onRaceGhost ? "grid-cols-[22px_40px_minmax(0,1fr)_auto] sm:grid-cols-[26px_44px_minmax(0,1fr)_auto_auto]" : "grid-cols-[22px_40px_minmax(0,1fr)_auto] sm:grid-cols-[26px_44px_minmax(0,1fr)_auto]"
    } ${highlight ? "bg-[#CCFF00]/[0.06]" : "hover:bg-white/[0.04]"}`}
  >
    <span className={`lc-data text-[16px] ${index === 0 ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>{index + 1}</span>
    <span className="font-f1-mono text-[12px] font-extrabold tracking-[0.1em] text-[#F5F7FA]">{entry.code}</span>
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-[14px] font-bold text-[#F5F7FA] uppercase">{entry.name}</span>
      <span className="truncate text-[12px] text-[#8E96AA]" title={new Date(entry.recordedAt).toLocaleString()}>
        {vehicleLabel(entry.vehicle)} · {new Date(entry.recordedAt).toLocaleDateString()}
      </span>
    </span>
    <span className="lc-data text-[16px] text-[#F5F7FA] sm:text-[17px]">{formatLapTime(entry.lapTimeMs)}</span>
    {onRaceGhost ? (
      <button
        type="button"
        onClick={() => onRaceGhost(entry)}
        className={`${SMALL_BUTTON} h-[30px] col-span-full mt-1 justify-self-end sm:col-span-1 sm:mt-0`}
      >
        Race ghost
      </button>
    ) : null}
  </li>
);

export interface LeaderboardPanelProps {
  trackName: string;
  vehicleLabel: (id: string) => string;
  local: LeaderboardEntry[];
  remote: LeaderboardEntry[];
  remoteEnabled: boolean;
  loading: boolean;
  onRefresh: () => void;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
  onImportGhost?: (file: File) => void;
  onExportBest?: () => void;
  /** Driver key (claims the name on the online board): export to a file, import from one, and the last result */
  onExportDriverKey?: () => void;
  onImportDriverKey?: (file: File) => void;
  driverKeyNotice?: string | null;
}

/** Personal bests and online times for one track, with refresh, ghost import / export and ghost racing */
export const LeaderboardPanel: React.FC<LeaderboardPanelProps> = ({
  trackName,
  vehicleLabel,
  local,
  remote,
  remoteEnabled,
  loading,
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

  // Fastest first, whatever order the caller passed
  const localSorted = useMemo(() => [...local].sort((a, b) => a.lapTimeMs - b.lapTimeMs), [local]);
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
          <span className="lc-lbl text-[#CCFF00]">Leaderboard</span>
          <span className="lc-title text-[24px] leading-none">{trackName}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRefresh} disabled={loading} className={BUTTON}>
            <RotateCw aria-hidden className={`h-[15px] w-[15px] ${loading ? "animate-spin" : ""}`} strokeWidth={2.2} />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          {onImportGhost ? (
            <>
              <button type="button" onClick={() => fileRef.current?.click()} className={BUTTON}>
                Import ghost file…
              </button>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
            </>
          ) : null}
          {onExportBest ? (
            <button type="button" onClick={onExportBest} className={BUTTON}>
              <Download aria-hidden className="h-[15px] w-[15px]" strokeWidth={2.2} />
              Export my best
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-start gap-4 [.lc-title-frame_&]:gap-5">
        {/* Local personal bests */}
        <section className={CARD} aria-label="Your personal bests">
          <CardHeader label="Your personal bests" color="#CCFF00" />
          {localSorted.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">No laps recorded on this track yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {localSorted.map((e, i) => (
                <LeaderRow key={`${e.recordedAt}-${i}`} index={i} entry={e} vehicleLabel={vehicleLabel} highlight={i === 0} />
              ))}
            </ol>
          )}
        </section>

        {/* Online times */}
        <section className={CARD} aria-label="Online">
          <CardHeader label="Online" color="#00E5FF">
            {loading && remoteEnabled ? (
              <span className="lc-breathe ml-auto font-f1-mono text-[10px] font-extrabold tracking-[0.12em] text-[#00E5FF]">
                LOADING…
              </span>
            ) : null}
          </CardHeader>
          {!remoteEnabled ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">
              Online times are not available in this build. Your own best laps are listed above.
            </p>
          ) : loading && remoteSorted.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">Loading online times…</p>
          ) : remoteSorted.length === 0 ? (
            <p className="m-0 px-1 py-2 text-[13px] text-[#8E96AA]">No online times for this track yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
              {remoteSorted.map((e, i) => (
                <LeaderRow
                  key={e.id ?? `${e.code}-${e.recordedAt}-${i}`}
                  index={i}
                  entry={e}
                  vehicleLabel={vehicleLabel}
                  onRaceGhost={onRaceGhost}
                />
              ))}
            </ol>
          )}
          {remoteEnabled && (onExportDriverKey || onImportDriverKey) ? (
            <div className="mt-1.5 flex flex-col gap-2.5 border-t border-[#262B3D] pt-3.5">
              <p className="m-0 text-[12px] leading-relaxed text-[#8E96AA]">
                <span className="font-f1-mono font-extrabold tracking-[0.1em] text-[#F5F7FA]">DRIVER KEY</span> · Your first
                upload claims your name, and this browser keeps the key to it. Export the key to race under the same name on
                another browser or device, and keep the file private.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {onExportDriverKey ? (
                  <button type="button" onClick={onExportDriverKey} className={`${SMALL_BUTTON} h-9`}>
                    Export key
                  </button>
                ) : null}
                {onImportDriverKey ? (
                  <>
                    <button type="button" onClick={() => keyFileRef.current?.click()} className={`${SMALL_BUTTON} h-9`}>
                      Import key…
                    </button>
                    <input
                      ref={keyFileRef}
                      type="file"
                      accept="application/json,.json"
                      className="hidden"
                      onChange={handleKeyFile}
                    />
                  </>
                ) : null}
                {driverKeyNotice ? <span className="text-[12px] text-[#F5F7FA]">{driverKeyNotice}</span> : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
