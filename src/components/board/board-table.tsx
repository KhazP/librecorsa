"use client";

/*
 * The board table: one drawing of a timing list for the lap times, the online board and the weekly challenge. Free of
 * the simulator, so the home page's board can use it too.
 */
import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { Button } from "@/components/ui/Button";
import { BadgeLegend, DriverBadges } from "@/components/ui/DriverBadges";
import { Skeleton } from "@/components/ui/Skeleton";
import { PlayerTag } from "@/components/ui/badges/PlayerTag";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { formatLapTime, formatSectorTime } from "@/components/hud/hud-format";
import { fetchBadges, type BadgeContext, type DriverBadge } from "@/lib/net/awards";
import type { LapInput } from "@/lib/sim/lap-types";
import type { VehicleModelId } from "@/types/f1";
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
  /** Prominent condition pills (realism, assists, wet) on the row's second line */
  meta?: React.ReactNode;
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
const Timed: React.FC<{ ms: number; best: boolean; lap?: boolean }> = ({ ms, best, lap }) => {
  const tx = useTranslations("board.table");
  return (
    <span
      className={`lc-mono font-bold whitespace-nowrap ${lap ? "text-[15px]" : "text-[13px]"} ${
        best ? "text-lc-best underline decoration-2 underline-offset-4" : lap ? "text-lc-chalk" : "text-lc-fog"
      }`}
      title={best ? tx("fastestHere") : undefined}
    >
      {lap ? formatLapTime(ms) : formatSectorTime(ms)}
      {best ? <span className="sr-only"> {tx("fastest")}</span> : null}
    </span>
  );
};

const TH = "lc-lbl px-2 pb-2 text-start font-semibold whitespace-nowrap";
/** Sector columns show only where the list has room for them */
const SECTOR = "hidden text-end @2xl:table-cell";

/** The badges of a list of drivers, fetched in one batch each time the names change, by name key */
export function useDriverBadges(names: readonly string[]): Record<string, DriverBadge[]> {
  const [fetched, setFetched] = useState<Record<string, DriverBadge[]>>({});
  const namesKey = names.map(driverNameKey).join("\n");
  useEffect(() => {
    if (!namesKey) return;
    let live = true;
    void fetchBadges(namesKey.split("\n")).then((map) => {
      if (live) setFetched(map);
    });
    return () => {
      live = false;
    };
  }, [namesKey]);
  return fetched;
}

/** One driver's badges from a `useDriverBadges` answer */
export const badgesFor = (fetched: Record<string, DriverBadge[]>, name: string): DriverBadge[] => {
  const key = driverNameKey(name);
  return Object.hasOwn(fetched, key) ? fetched[key] : [];
};

/** Laps as a timing list: place, who or what, lap time, the three sectors where there is room, and an action */
export const BoardTable: React.FC<{
  label: string;
  rows: readonly BoardRow[];
  /** The name column's heading (default "Driver", a board of drivers, which shows their badges) */
  nameHeader?: string;
  footer?: React.ReactNode;
  /** A newer page is on its way: the rows shown stay, dimmed, and say so */
  stale?: boolean;
  /** Whether to batch-fetch and render driver badges beside driver names (defaults to true for Driver boards) */
  showBadges?: boolean;
  /** Board scope for Fastest Lap badges (narrows FL pills to the active car or class) */
  badgeContext?: BadgeContext;
  /** Resolves circuit ids inside the Fastest Lap popover */
  circuitName?: (trackId: string) => string;
  /** Opens a record's board when tapped inside a driver's Fastest Lap popover */
  onOpenRecordBoard?: (trackId: string, vehicle: VehicleModelId) => void;
  /** Opens a driver's profile modal when their name is clicked */
  onSelectDriver?: (name: string) => void;
  /** The key to the badges under the list; off where the caller shows it elsewhere (the online board's filter row) */
  legend?: boolean;
}> = ({
  label,
  rows,
  nameHeader,
  footer,
  stale = false,
  showBadges = nameHeader === undefined,
  badgeContext,
  circuitName,
  onOpenRecordBoard,
  onSelectDriver,
  legend = true,
}) => {
  const tx = useTranslations("board.table");
  const sectors = rows.some((r) => r.sectorsMs?.length);
  const actions = rows.some((r) => r.action);
  const fetchedBadges = useDriverBadges(showBadges ? rows.filter((r) => r.badges === undefined).map((r) => r.title) : []);
  const badgesOf = (r: BoardRow): readonly DriverBadge[] => r.badges ?? badgesFor(fetchedBadges, r.title);
  const shownBadges = showBadges && legend ? rows.flatMap(badgesOf) : [];
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
              {tx("pos")}
            </th>
            <th scope="col" className={`${TH} w-full`}>
              {nameHeader ?? tx("driver")}
            </th>
            <th scope="col" className={`${TH} text-end`}>
              {tx("lap")}
            </th>
            {sectors
              ? [1, 2, 3].map((s) => (
                  <th key={s} scope="col" className={`${TH} ${SECTOR}`}>
                    {tx("sector", { n: String(s) })}
                  </th>
                ))
              : null}
            {actions ? (
              <th scope="col" className="p-0">
                <span className="sr-only">{tx("actions")}</span>
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
                    {onSelectDriver ? (
                      <button
                        type="button"
                        dir="auto"
                        onClick={() => onSelectDriver(r.title)}
                        title={tx("viewProfile", { name: r.title })}
                        aria-haspopup="dialog"
                        className="min-w-0 cursor-pointer truncate rounded-lc-nub border-0 bg-transparent px-1 -mx-1 py-1.5 text-start text-[14px] font-semibold text-lc-chalk decoration-lc-slate/70 underline-offset-4 transition-colors duration-150 ease-lc hover:underline pointer-coarse:py-2.5"
                      >
                        {r.title}
                      </button>
                    ) : (
                      <span dir="auto" className="truncate text-[14px] font-semibold text-lc-chalk" title={r.title}>
                        {r.title}
                      </span>
                    )}
                    <InputIcon input={r.input} className="text-lc-fog" />
                    {showBadges ? (
                      <DriverBadges
                        badges={badgesOf(r)}
                        compact
                        context={badgeContext}
                        driverName={r.title}
                        circuitName={circuitName}
                        onOpenBoard={onOpenRecordBoard}
                      />
                    ) : null}
                    {r.mine ? <PlayerTag size="sm" /> : null}
                  </span>
                  {r.tag || r.meta || r.detail ? (
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                      {r.tag ? <span className="flex shrink-0">{r.tag}</span> : null}
                      {r.meta ? <span className="flex shrink-0 flex-wrap items-center gap-1">{r.meta}</span> : null}
                      {r.detail ? (
                        <span className="lc-hint block min-w-0 truncate" title={r.detailTitle ?? r.detail}>
                          {r.detail}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 text-end">
                  <Timed ms={r.lapMs} best={Boolean(r.fastest)} lap />
                </td>
                {sectors
                  ? [0, 1, 2].map((k) => (
                      <td key={k} className={`px-2 ${SECTOR}`}>
                        {r.sectorsMs?.[k] ? <Timed ms={r.sectorsMs[k]} best={Boolean(r.bestSectors?.[k])} /> : null}
                      </td>
                    ))
                  : null}
                {actions ? <td className="py-1.5 ps-2 text-end whitespace-nowrap">{r.action}</td> : null}
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
      <BadgeLegend badges={shownBadges} context={badgeContext} className="px-2 pt-3 pb-1" />
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
        <Skeleton shape="line" className="ms-auto w-20" />
      </div>
    ))}
  </div>
);

/** A list that could not be read: what went wrong, in the loss colour on the card itself, and a way to try again */
export const BoardError: React.FC<{ children: React.ReactNode; onRetry?: () => void }> = ({ children, onRetry }) => {
  const tx = useTranslations("board.table");
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 py-2">
      <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-loss">
        <Icon name="error" className="mt-0.5" />
        {children}
      </p>
      {onRetry ? (
        <Button size="sm" variant="secondary" icon={<Icon name="refresh" />} onClick={onRetry}>
          {tx("tryAgain")}
        </Button>
      ) : null}
    </div>
  );
};

/** The player's own place on a board, in their colour */
export const MyPlace: React.FC<{ rank: number; total: number; lapMs: number; detail: string; action?: React.ReactNode }> = ({
  rank,
  total,
  lapMs,
  detail,
  action,
}) => {
  const tx = useTranslations("board.table");
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lc-row border border-lc-volt/35 bg-lc-volt/5 px-3.5 py-2.5">
      <span className="flex min-w-0 items-center gap-3">
        <PositionBadge position={rank} player />
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-semibold text-lc-chalk">
            {tx("myPlace", { rank: formatCount(rank), total: formatCount(total) })}
            <span className="lc-mono ms-2 font-bold text-lc-fog">{formatLapTime(lapMs)}</span>
          </span>
          {detail ? <span className="lc-hint truncate">{detail}</span> : null}
        </span>
      </span>
      {action}
    </div>
  );
};
