"use client";

/*
 * Weekly Challenge Hall of Fame (issue #129): completed (and in-progress) weekly podiums grouped by event and physics
 * version (V1 and V2 preserved side by side), plus the most decorated drivers tally. Free of the simulator, so both
 * ChallengePanel (in-game) and HomeBoards (home page) render it.
 */
import React, { useEffect, useState } from "react";
import { fetchHallOfFame, physicsName, type HallOfFameAnswer, type HallOfFameEvent, type PodiumPlace } from "@/lib/net/awards";
import { driverNameKey } from "@/lib/net/board-client";
import { formatLapTime } from "@/components/hud/hud-format";
import { Card, EmptyState, Segmented } from "@/components/ui";
import { Badge, type BadgeToneProp, type BadgeVariant } from "@/components/ui/Badge";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { Icon } from "@/components/ui/icons";
import type { IconName } from "@/components/ui/icons/registry";
import { BoardError, BoardSkeleton } from "./board-table";

export interface HallOfFameProps {
  /** Human-readable circuit name for a track id */
  circuitName?: (trackId: string) => string;
  /** Human-readable car name for a vehicle model id */
  carName?: (vehicle: string) => string;
  /** Highlight this driver's rows when present */
  driverName?: string;
  /** Reload trigger when a new lap is submitted */
  refreshKey?: number;
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

export const HallOfFame: React.FC<HallOfFameProps> = ({ circuitName, carName, driverName = "", refreshKey = 0 }) => {
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
  const formatCar = (id: string) => (id ? (carName ? carName(id) : humanize(id)) : "");

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
  if (!data || data.events.length === 0) {
    return (
      <Card title="Hall of Fame" bodyClassName="gap-3">
        <EmptyState icon={<Icon name="challenge" size="lg" />}>
          No weekly podiums yet.
        </EmptyState>
      </Card>
    );
  }

  const versions = [...new Set(data.events.map((e) => e.physics))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const activeFilter = physicsFilter === "all" || versions.includes(physicsFilter) ? physicsFilter : "all";
  const visibleEvents = activeFilter === "all" ? data.events : data.events.filter((e) => e.physics === activeFilter);

  return (
    <div className="flex flex-col gap-3">
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
            carLabel={formatCar(e.vehicle)}
            myKey={myKey}
          />
        ))}
      </Card>
    </div>
  );
};
