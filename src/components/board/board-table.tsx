"use client";

/*
 * The board table: one drawing of a timing list for the lap times, the online board and the weekly challenge. Free of
 * the simulator, so the home page's board can use it too.
 */
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { DriverBadges } from "@/components/ui/DriverBadges";
import { Skeleton } from "@/components/ui/Skeleton";
import { PlayerTag } from "@/components/ui/badges/PlayerTag";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { formatLapTime, formatSectorTime } from "@/components/hud/hud-format";
import { fetchBadges, type DriverBadge } from "@/lib/net/awards";
import type { LapInput } from "@/lib/sim/lap-types";
import { InputIcon } from "./InputIcon";
import { driverNameKey, formatCount } from "@/lib/net/board-client";

export interface BoardRow {
  key: string;
  rank: number;
  /** The car (your laps) or the driver's name (a board) */
  title: string;
  /** The driver's three-letter code, before the name */
  code?: string;
  /** What the lap was driven with: an icon after the name */
  input?: LapInput;
  /** Beside the title: the car a lap was driven in, on a board of every car */
  tag?: React.ReactNode;
  /** One line under the title: when, and how the lap was driven */
  detail?: string;
  /** Full date for the detail's tooltip */
  detailTitle?: string;
  /** A line under the detail that needs the player's eye (a best lap that isn't on the online board) */
  note?: React.ReactNode;
  lapMs: number;
  /** The fastest lap of the list: best colour and an underline (colour is not alone) */
  fastest?: boolean;
  sectorsMs?: readonly number[];
  /** Which of the three sectors is the fastest of its column */
  bestSectors?: readonly boolean[];
  /** The player's own row */
  mine?: boolean;
  /** Pre-fetched badges for this driver (when omitted on a driver board, fetched in a batch automatically) */
  badges?: readonly DriverBadge[];
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
export const BoardTable: React.FC<{
  label: string;
  rows: readonly BoardRow[];
  nameHeader?: string;
  footer?: React.ReactNode;
  /** A newer page is on its way: the rows shown stay, dimmed, and say so */
  stale?: boolean;
  /** Whether to batch-fetch and render driver badges beside driver names (defaults to true for Driver boards) */
  showBadges?: boolean;
}> = ({ label, rows, nameHeader = "Driver", footer, stale = false, showBadges = nameHeader === "Driver" }) => {
  const sectors = rows.some((r) => r.sectorsMs?.length);
  const actions = rows.some((r) => r.action);
  const [fetchedBadges, setFetchedBadges] = useState<Record<string, DriverBadge[]>>({});
  const namesKey = showBadges ? rows.filter((r) => r.badges === undefined).map((r) => driverNameKey(r.title)).join("\n") : "";
  useEffect(() => {
    if (!namesKey) return;
    let live = true;
    void fetchBadges(namesKey.split("\n")).then((map) => {
      if (live) setFetchedBadges(map);
    });
    return () => {
      live = false;
    };
  }, [namesKey]);
  return (
    <div className="@container min-w-0">
      <table
        className={`w-full border-collapse transition-opacity duration-200 ease-lc ${stale ? "opacity-55" : ""}`}
        aria-label={label}
        aria-busy={stale || undefined}
      >
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
            <React.Fragment key={r.key}>
              <tr
                aria-current={r.mine ? "true" : undefined}
                className={`h-13 ${r.note ? "" : "border-b border-white/5 last:border-b-0"} ${r.mine ? "bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""}`}
              >
                <td className="px-2">
                  <PositionBadge position={r.rank} player={r.mine} size="sm" className="min-w-10" />
                </td>
                <td className="max-w-0 px-2 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {/* The code gives way to the name in a narrow list (a phone) */}
                    {r.code ? <span className="lc-mono hidden w-8 shrink-0 text-[12px] font-bold tracking-[0.08em] text-lc-slate @sm:inline">{r.code.slice(0, 3)}</span> : null}
                    <span dir="auto" className="truncate text-[14px] font-semibold text-lc-chalk" title={r.title}>
                      {r.title}
                    </span>
                    <InputIcon input={r.input} className="text-lc-fog" />
                    {showBadges ? <DriverBadges badges={r.badges ?? fetchedBadges[driverNameKey(r.title)] ?? []} compact /> : null}
                    {r.mine ? <PlayerTag size="sm" /> : null}
                  </span>
                  {r.tag || r.detail ? (
                    <span className="flex min-w-0 items-center gap-2">
                      {r.tag ? <span className="flex shrink-0">{r.tag}</span> : null}
                      {r.detail ? (
                        <span className="lc-hint block min-w-0 truncate" title={r.detailTitle ?? r.detail}>
                          {r.detail}
                        </span>
                      ) : null}
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
              {/* The note gets a line of its own under the row, wide enough to read on a phone */}
              {r.note ? (
                <tr className="border-b border-white/5 last:border-b-0">
                  <td />
                  <td colSpan={2 + (sectors ? 3 : 0) + (actions ? 1 : 0)} className="px-2 pb-2 text-[12px] leading-[1.4]">
                    {r.note}
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
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
          You are P{formatCount(rank)} of {formatCount(total)}
          <span className="lc-mono ml-2 font-bold text-lc-fog">{formatLapTime(lapMs)}</span>
        </span>
        {detail ? <span className="lc-hint truncate">{detail}</span> : null}
      </span>
    </span>
    {action}
  </div>
);
