"use client";

import React, { useMemo, useRef } from "react";
import type { LeaderboardEntry } from "@/lib/sim/lap-types";
import { formatLapTime } from "./hud-format";

const CARD =
  "f1-panel f1-corner-tr min-w-0 rounded-lg border border-[#262B3D] bg-[#11131A] p-4 text-[#F5F7FA]";
const HEADER =
  "mb-2.5 flex items-center gap-2 font-f1-mono text-[11px] font-bold tracking-[0.16em] text-[#8E96AA]";
const BUTTON =
  "cursor-pointer rounded border border-[#262B3D] bg-[#08090D] px-3 py-1.5 font-f1-mono text-[11px] font-bold uppercase text-[#8E96AA] transition-colors hover:border-[#CCFF00] hover:text-[#CCFF00] disabled:cursor-not-allowed disabled:opacity-40";

/** One ranked lap: position, code, name over car, lap time, date and an optional ghost race button */
const LeaderRow: React.FC<{
  index: number;
  entry: LeaderboardEntry;
  vehicleLabel: (id: string) => string;
  onRaceGhost?: (entry: LeaderboardEntry) => void;
}> = ({ index, entry, vehicleLabel, onRaceGhost }) => (
  <li className="flex items-center gap-3 py-1.5 font-f1-mono text-[12px]">
    <span
      className={`hud-num w-6 text-right text-[15px] ${index === 0 ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}
    >
      {index + 1}
    </span>
    <span className="hud-num w-10 text-[14px] tracking-wider text-[#F5F7FA]">{entry.code}</span>
    <span className="min-w-0 flex-1">
      <span className="block truncate font-f1-italic text-[13px] text-[#F5F7FA] uppercase">{entry.name}</span>
      <span className="block truncate text-[11px] text-[#8E96AA]">{vehicleLabel(entry.vehicle)}</span>
    </span>
    <span className="hud-num text-[15px] text-[#F5F7FA] tabular-nums">{formatLapTime(entry.lapTimeMs)}</span>
    <span
      className="w-[72px] text-right text-[11px] text-[#8E96AA]"
      title={new Date(entry.recordedAt).toLocaleString()}
    >
      {new Date(entry.recordedAt).toLocaleDateString()}
    </span>
    {onRaceGhost ? (
      <button type="button" onClick={() => onRaceGhost(entry)} className={BUTTON}>
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
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Fastest first, whatever order the caller passed
  const localSorted = useMemo(() => [...local].sort((a, b) => a.lapTimeMs - b.lapTimeMs), [local]);
  const remoteSorted = useMemo(() => [...remote].sort((a, b) => a.lapTimeMs - b.lapTimeMs), [remote]);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear so picking the same file again still fires onChange
    e.target.value = "";
    if (file && onImportGhost) onImportGhost(file);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="font-f1-mono text-[11px] font-bold tracking-[0.22em] text-[#CCFF00]">LEADERBOARD</div>
          <div className="font-f1-italic text-2xl leading-none text-[#F5F7FA] uppercase">{trackName}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRefresh} disabled={loading} className={BUTTON}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          {onImportGhost ? (
            <>
              <button type="button" onClick={() => fileRef.current?.click()} className={BUTTON}>
                Import ghost file…
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleFile}
              />
            </>
          ) : null}
          {onExportBest ? (
            <button type="button" onClick={onExportBest} className={BUTTON}>
              Export my best
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Local personal bests */}
        <section className={CARD}>
          <div className={HEADER}>
            <span className="h-2.5 w-1 rounded-full bg-[#CCFF00]" />
            YOUR PERSONAL BESTS
          </div>
          {localSorted.length === 0 ? (
            <p className="py-2 font-f1-mono text-[12px] text-[#8E96AA]">No laps recorded on this track yet.</p>
          ) : (
            <ol className="divide-y divide-[#262B3D]/60">
              {localSorted.map((e, i) => (
                <LeaderRow
                  key={`${e.recordedAt}-${i}`}
                  index={i}
                  entry={e}
                  vehicleLabel={vehicleLabel}
                />
              ))}
            </ol>
          )}
        </section>

        {/* Online times */}
        <section className={CARD}>
          <div className={HEADER}>
            <span className="h-2.5 w-1 rounded-full bg-[#00E5FF]" />
            ONLINE
            {loading && remoteEnabled ? <span className="ml-auto text-[#00E5FF]">LOADING…</span> : null}
          </div>
          {!remoteEnabled ? (
            <p className="py-2 font-f1-mono text-[12px] text-[#8E96AA]">
              Online times are not available in this build. Your own best laps are listed above.
            </p>
          ) : loading && remoteSorted.length === 0 ? (
            <p className="py-2 font-f1-mono text-[12px] text-[#8E96AA]">Loading online times…</p>
          ) : remoteSorted.length === 0 ? (
            <p className="py-2 font-f1-mono text-[12px] text-[#8E96AA]">No online times for this track yet.</p>
          ) : (
            <ol className="divide-y divide-[#262B3D]/60">
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
        </section>
      </div>
    </div>
  );
};
