"use client";

/*
 * Hall of Fame (issue #129): live Fastest Lap record holders (overall and per car class, on contested boards),
 * plus completed (and in-progress) weekly challenge podiums grouped by event and physics version (V1 and V2
 * preserved side by side) and the most decorated weekly drivers tally. Free of the simulator, so both
 * ChallengePanel (in-game) and HomeBoards (home page) render it.
 */
import React, { useEffect, useState } from "react";
import {
  fetchHallOfFame,
  physicsName,
  type BadgeContext,
  type DriverBadge,
  type HallOfFameAnswer,
  type HallOfFameEvent,
  type HallOfFameRecordHolders,
  type PodiumPlace,
  type RecordHolder,
} from "@/lib/net/awards";
import {
  VEHICLE_CLASS_IDS,
  VEHICLE_CLASS_META,
  vehicleDisplayName,
  type VehicleClassId,
} from "@/lib/cars/vehicle-class";
import { driverNameKey } from "@/lib/net/board-client";
import type { VehicleModelId } from "@/types/f1";
import { formatLapTime } from "@/components/hud/hud-format";
import { Card, EmptyState, Segmented } from "@/components/ui";
import { Badge, StatusDot, badgeToneClass, type BadgeToneProp, type BadgeVariant } from "@/components/ui/Badge";
import { DriverBadges } from "@/components/ui/DriverBadges";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { Icon } from "@/components/ui/icons";
import type { IconName } from "@/components/ui/icons/registry";
import { cx } from "@/components/ui/styles";
import { BoardError, BoardSkeleton } from "./board-table";

export interface HallOfFameProps {
  /** Human-readable circuit name for a track id */
  circuitName?: (trackId: string) => string;
  /** Human-readable car name for a vehicle model id (and optional week id when a week names a specific car) */
  carName?: (vehicle: string, eventId?: string) => string;
  /** Highlight this driver's rows when present */
  driverName?: string;
  /** Reload trigger when a new lap is submitted */
  refreshKey?: number;
  /** Opens a track & car board when a driver's record is tapped inside the FL popover */
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}

const humanize = (id: string): string => id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const MEDAL_STYLE: Record<1 | 2 | 3, { label: string; short: string; icon: IconName; tone: BadgeToneProp; variant: BadgeVariant }> = {
  1: { label: "Gold", short: "1st", icon: "challenge", tone: { color: "amber" }, variant: "soft" },
  2: { label: "Silver", short: "2nd", icon: "medal", tone: { color: "chalk" }, variant: "soft" },
  3: { label: "Bronze", short: "3rd", icon: "medal", tone: { color: "amber" }, variant: "outline" },
};

const PodiumRow: React.FC<{ place: PodiumPlace; mine: boolean }> = ({ place, mine }) => {
  const m = MEDAL_STYLE[place.place];
  return (
    <li
      className={`flex items-center justify-between gap-2 rounded-lc-row px-2.5 py-1.5 ${
        mine ? "bg-lc-volt/10 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : "bg-white/[0.02]"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Badge size="sm" tone={m.tone} variant={m.variant} icon={m.icon} aria-label={`${m.label} (${m.short})`}>
          {m.short}
        </Badge>
        <span dir="auto" className={`truncate text-[14px] font-semibold ${mine ? "text-lc-volt" : "text-lc-chalk"}`} title={place.name}>
          {place.name}
        </span>
      </span>
      {place.lapTimeMs !== null ? (
        <span className="lc-mono shrink-0 text-[13px] font-bold text-lc-fog">{formatLapTime(place.lapTimeMs)}</span>
      ) : null}
    </li>
  );
};

const EventBlock: React.FC<{
  event: HallOfFameEvent;
  circuitLabel: string;
  carLabel: string;
  myKey: string;
}> = ({ event, circuitLabel, carLabel, myKey }) => (
  <div className="flex flex-col gap-2 rounded-lc-tile border border-white/7 bg-lc-void/40 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="lc-mono text-[13px] font-bold text-lc-chalk">{event.event}</span>
        {circuitLabel ? <span className="text-[14px] font-semibold text-lc-chalk">{circuitLabel}</span> : null}
        {carLabel ? <span className="text-[13px] text-lc-fog">{carLabel}</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Badge size="sm" tone={event.physics === "v2" ? "info" : "neutral"} variant="outline">
          Physics {physicsName(event.physics)}
        </Badge>
        {event.current ? (
          <Badge size="sm" tone="good" variant="soft">
            In progress
          </Badge>
        ) : null}
      </div>
    </div>
    <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label={`${event.event} Physics ${physicsName(event.physics)} podium`}>
      {event.podium.map((p) => (
        <PodiumRow key={`${p.place}-${p.nameKey}`} place={p} mine={myKey !== "" && p.nameKey === myKey} />
      ))}
    </ol>
  </div>
);

function holderSummary(h: RecordHolder): string {
  return h.byVehicle
    .slice(0, 3)
    .map((v) => `${vehicleDisplayName(v.vehicle)} ×${v.count}`)
    .join(" · ");
}

const RecordHoldersCard: React.FC<{
  recordHolders: HallOfFameRecordHolders;
  myKey: string;
  formatCircuit: (id: string) => string;
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}> = ({ recordHolders, myKey, formatCircuit, onOpenBoard }) => {
  const [selectedClass, setSelectedClass] = useState<"all" | VehicleClassId>("all");
  const availableClasses = VEHICLE_CLASS_IDS.filter((c) => (recordHolders.byClass[c]?.length ?? 0) > 0);
  const activeClass: "all" | VehicleClassId =
    selectedClass === "all" || availableClasses.includes(selectedClass) ? selectedClass : "all";
  const holders = activeClass === "all" ? recordHolders.overall : (recordHolders.byClass[activeClass] ?? []);
  const badgeContext: BadgeContext = activeClass === "all" ? { scope: "all" } : { scope: "class", classId: activeClass };

  return (
    <Card
      title="Fastest Lap record holders"
      description={`Current P1 on contested boards (${recordHolders.minDrivers}+ drivers). Tap a badge to inspect or challenge.`}
      bodyClassName="gap-3"
    >
      {availableClasses.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter record holders by car class">
          <button
            type="button"
            aria-pressed={activeClass === "all"}
            onClick={() => setSelectedClass("all")}
            className={cx(
              "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lc-nub border px-2.5 text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:outline-none",
              activeClass === "all"
                ? "border-white/15 bg-white/12 text-lc-chalk"
                : "border-white/7 bg-lc-void/40 text-lc-fog hover:border-white/12 hover:text-lc-chalk",
            )}
          >
            All classes
          </button>
          {availableClasses.map((classId) => {
            const meta = VEHICLE_CLASS_META[classId];
            const active = activeClass === classId;
            return (
              <button
                key={classId}
                type="button"
                aria-pressed={active}
                onClick={() => setSelectedClass(classId)}
                className={cx(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lc-nub border px-2.5 text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:outline-none",
                  active
                    ? badgeToneClass({ color: meta.color }, "soft")
                    : "border-white/7 bg-lc-void/40 text-lc-fog hover:border-white/12 hover:text-lc-chalk",
                  active ? "border-current/35" : undefined,
                )}
              >
                <StatusDot tone={{ color: meta.color }} />
                {meta.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <ol
        className="m-0 flex list-none flex-col divide-y divide-white/5 p-0"
        aria-label={activeClass === "all" ? "Fastest Lap record holders" : `${VEHICLE_CLASS_META[activeClass].label} Fastest Lap record holders`}
      >
        {holders.map((h, i) => {
          const mine = myKey !== "" && h.nameKey === myKey;
          const syntheticBadges: DriverBadge[] = [{ type: "track_record", count: h.count, boards: h.boards }];
          const summary = holderSummary(h);
          return (
            <li
              key={h.nameKey}
              className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-2 py-2 ${
                mine ? "rounded-lc-row bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <PositionBadge position={i + 1} player={mine} size="sm" className="min-w-10" />
                <span className="flex min-w-0 flex-col">
                  <span dir="auto" className={`truncate text-[14px] font-semibold ${mine ? "text-lc-volt" : "text-lc-chalk"}`} title={h.name}>
                    {h.name}
                  </span>
                  {summary ? (
                    <span className="lc-hint truncate" title={summary}>
                      {summary}
                    </span>
                  ) : null}
                </span>
              </span>
              <DriverBadges
                badges={syntheticBadges}
                compact
                context={badgeContext}
                driverName={h.name}
                circuitName={formatCircuit}
                onOpenBoard={onOpenBoard}
              />
            </li>
          );
        })}
      </ol>
    </Card>
  );
};

export const HallOfFame: React.FC<HallOfFameProps> = ({ circuitName, carName, driverName = "", refreshKey = 0, onOpenBoard }) => {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ data: HallOfFameAnswer | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false,
  });
  const [physicsFilter, setPhysicsFilter] = useState<string>("all");

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: false }));
    void fetchHallOfFame().then((data) => {
      if (!live) return;
      setState({ data, loading: false, error: data === null });
    });
    return () => {
      live = false;
    };
  }, [reload, refreshKey]);

  const myKey = driverName ? driverNameKey(driverName) : "";
  const formatCircuit = (id: string) => (id ? (circuitName ? circuitName(id) : humanize(id)) : "");
  const formatCar = (id: string, eventId?: string) => (id ? (carName ? carName(id, eventId) : humanize(id)) : "");

  if (state.loading && !state.data) {
    return (
      <Card title="Hall of Fame" bodyClassName="gap-3">
        <BoardSkeleton rows={4} label="Loading Hall of Fame" />
      </Card>
    );
  }

  if (state.error && !state.data) {
    return (
      <Card title="Hall of Fame" bodyClassName="gap-3">
        <BoardError onRetry={() => setReload((n) => n + 1)}>Couldn&apos;t load the Hall of Fame. Check your connection.</BoardError>
      </Card>
    );
  }

  const data = state.data;
  const hasRecords = Boolean(data && data.recordHolders.overall.length > 0);
  const hasEvents = Boolean(data && data.events.length > 0);
  if (!data || (!hasEvents && !hasRecords)) {
    return (
      <Card title="Hall of Fame" bodyClassName="gap-3">
        <EmptyState icon={<Icon name="challenge" size="lg" />}>
          No records or weekly podiums yet.
        </EmptyState>
      </Card>
    );
  }

  const versions = [...new Set(data.events.map((e) => e.physics))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const activeFilter = physicsFilter === "all" || versions.includes(physicsFilter) ? physicsFilter : "all";
  const visibleEvents = activeFilter === "all" ? data.events : data.events.filter((e) => e.physics === activeFilter);

  return (
    <div className="flex flex-col gap-3">
      {hasRecords ? (
        <RecordHoldersCard
          recordHolders={data.recordHolders}
          myKey={myKey}
          formatCircuit={formatCircuit}
          onOpenBoard={onOpenBoard}
        />
      ) : null}

      {data.mostDecorated.length > 0 ? (
        <Card title="Most decorated" bodyClassName="gap-2">
          <ol className="m-0 flex list-none flex-col divide-y divide-white/5 p-0" aria-label="Most decorated drivers">
            {data.mostDecorated.map((d, i) => {
              const mine = myKey !== "" && d.nameKey === myKey;
              return (
                <li
                  key={d.nameKey}
                  className={`flex flex-wrap items-center justify-between gap-2 px-2 py-2 ${
                    mine ? "rounded-lc-row bg-lc-volt/8 shadow-[inset_2px_0_0_var(--color-lc-volt)]" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <PositionBadge position={i + 1} player={mine} size="sm" className="min-w-10" />
                    <span dir="auto" className={`truncate text-[14px] font-semibold ${mine ? "text-lc-volt" : "text-lc-chalk"}`} title={d.name}>
                      {d.name}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {d.gold > 0 ? (
                      <Badge size="sm" tone={{ color: "amber" }} variant="soft" icon="challenge" aria-label={`${d.gold} Gold`}>
                        {d.gold}
                      </Badge>
                    ) : null}
                    {d.silver > 0 ? (
                      <Badge size="sm" tone={{ color: "chalk" }} variant="soft" icon="medal" aria-label={`${d.silver} Silver`}>
                        {d.silver}
                      </Badge>
                    ) : null}
                    {d.bronze > 0 ? (
                      <Badge size="sm" tone={{ color: "amber" }} variant="outline" icon="medal" aria-label={`${d.bronze} Bronze`}>
                        {d.bronze}
                      </Badge>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      ) : null}

      {hasEvents ? (
        <Card
          title="Weekly podiums"
          action={
            versions.length > 1 ? (
              <Segmented
                aria-label="Physics version filter"
                size="sm"
                value={activeFilter}
                onChange={setPhysicsFilter}
                options={[
                  { id: "all", label: "All" },
                  ...versions.map((v) => ({ id: v, label: `Physics ${physicsName(v)}` })),
                ]}
              />
            ) : null
          }
          bodyClassName="gap-2.5"
        >
          {visibleEvents.map((e) => (
            <EventBlock
              key={`${e.event}-${e.physics}`}
              event={e}
              circuitLabel={formatCircuit(e.trackId)}
              carLabel={formatCar(e.vehicle, e.event)}
              myKey={myKey}
            />
          ))}
        </Card>
      ) : null}
    </div>
  );
};
