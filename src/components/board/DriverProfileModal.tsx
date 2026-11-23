"use client";

/*
 * Driver profile modal (GitHub #170): opened when clicking a driver name on a lap board. Shows the driver's name,
 * badges, Bayesian-shrunk rating, circuits/boards counts, open race record, and per-circuit best laps across current
 * boards in the same timing-table style as OnlineBoard. Free of the simulator so the home page can load it too.
 */
import React, { useEffect, useMemo, useState } from "react";
import type { VehicleModelId } from "@/types/f1";
import { fetchBadges, type DriverBadge } from "@/lib/net/awards";
import { driverNameKey, formatCount } from "@/lib/net/board-client";
import { fetchDriverProfile, lapBoardPercentile, type DriverProfile, type DriverProfileLap } from "@/lib/net/driver-profile";
import { fetchDriverRecord, type DriverRecord } from "@/lib/net/race-results";
import { formatLapTime, formatSectorTime } from "@/components/hud/hud-format";
import { Badge, type PaletteColor } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/Button";
import { DriverBadges } from "@/components/ui/DriverBadges";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Segmented } from "@/components/ui/Segmented";
import { Skeleton } from "@/components/ui/Skeleton";
import { Card, Well } from "@/components/ui/Surface";
import { PlayerTag } from "@/components/ui/badges/PlayerTag";
import { PositionBadge } from "@/components/ui/badges/PositionBadge";
import { Icon } from "@/components/ui/icons/Icon";
import { InputIcon } from "./InputIcon";
import { LapConditionBadges } from "./LapConditionBadges";
import { BoardError, BoardSkeleton } from "./board-table";

export interface ProfileCarTag {
  label: string;
  color: PaletteColor;
}

export interface DriverProfileModalProps {
  /** Driver display name to inspect; null keeps the modal closed */
  driverName: string | null;
  onClose: () => void;
  /** True when the opened driver is the local player */
  isMe?: boolean;
  /** Human-readable circuit name for a track id */
  circuitName: (trackId: string) => string;
  /** Short name and class colour for a vehicle model */
  carTag: (vehicle: VehicleModelId) => ProfileCarTag;
  /** Badges already fetched by the board, to avoid initial pop-in */
  initialBadges?: readonly DriverBadge[];
  /** Jumps to a lap's circuit & car board when clicked inside the profile */
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}

type SortMode = "rank" | "circuit" | "recent";

const TH = "lc-lbl px-2 pb-2 text-left font-semibold whitespace-nowrap";
const SECTOR = "hidden text-right @2xl:table-cell";

export interface DriverProfileBodyProps {
  profile: DriverProfile | null;
  record: DriverRecord | null;
  loading: boolean;
  error: boolean;
  circuitName: (trackId: string) => string;
  carTag: (vehicle: VehicleModelId) => ProfileCarTag;
  onRetry: () => void;
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}

/**
 * Pure body of the driver profile modal (exported separately so headless checks can render every state without a DOM
 * portal). No eyebrow headers: stat tiles lead with the figure and explain it underneath.
 */
export const DriverProfileBody: React.FC<DriverProfileBodyProps> = ({
  profile,
  record,
  loading,
  error,
  circuitName,
  carTag,
  onRetry,
  onOpenBoard,
}) => {
  const [sort, setSort] = useState<SortMode>("rank");

  const sortedLaps = useMemo<DriverProfileLap[]>(() => {
    if (!profile) return [];
    const list = [...profile.laps];
    if (sort === "circuit") {
      list.sort(
        (a, b) =>
          circuitName(a.trackId).localeCompare(circuitName(b.trackId)) ||
          a.position - b.position ||
          a.lapTimeMs - b.lapTimeMs,
      );
    } else if (sort === "recent") {
      list.sort((a, b) => b.recordedAt - a.recordedAt || a.position - b.position);
    } else {
      list.sort(
        (a, b) =>
          lapBoardPercentile(b.position, b.boardSize) - lapBoardPercentile(a.position, a.boardSize) ||
          a.position - b.position ||
          b.boardSize - a.boardSize ||
          circuitName(a.trackId).localeCompare(circuitName(b.trackId)),
      );
    }
    return list;
  }, [profile, sort, circuitName]);

  if (loading && !profile) {
    return (
      <>
        <div role="status" aria-busy="true" aria-label="Loading driver stats" className="grid grid-cols-3 gap-2.5 phone:gap-2">
          {[0, 1, 2].map((i) => (
            <Well key={i} className="flex flex-col gap-2 px-4 py-3 phone:px-3 phone:py-2.5">
              <Skeleton shape="line" className="h-7 w-16" />
              <Skeleton shape="line" className="h-3 w-14" />
            </Well>
          ))}
        </div>
        <Card title="Best laps" bodyClassName="gap-2">
          <BoardSkeleton rows={5} label="Loading best laps" />
        </Card>
      </>
    );
  }

  if (error && !profile) {
    return (
      <Card title="Driver stats">
        <BoardError onRetry={onRetry}>Couldn&apos;t load this driver&apos;s profile.</BoardError>
      </Card>
    );
  }

  if (!profile) return null;

  return (
    <>
      {error ? (
        <p role="alert" className="m-0 flex items-center gap-2 text-[13px] font-medium text-lc-caution">
          <Icon name="warning" />
          Refresh failed. Showing cached stats.
        </p>
      ) : null}

      {/* Headline figures: value first, plain sentence-case label below */}
      <div className="grid grid-cols-3 gap-2.5 phone:gap-2">
        <Well
          className="flex min-w-0 flex-col gap-1 px-4 py-3 phone:px-3 phone:py-2.5"
          title="Average percentile across circuits, weighted toward 50 when few circuits are driven"
        >
          <span className="lc-data text-[28px] leading-none text-lc-chalk phone:text-[22px]">
            {profile.rating !== null ? profile.rating.toFixed(1) : "—"}
            {profile.rating !== null ? <span className="sr-only"> out of 100</span> : null}
          </span>
          <span className="lc-hint truncate">Rating</span>
        </Well>
        <Well className="flex min-w-0 flex-col gap-1 px-4 py-3 phone:px-3 phone:py-2.5">
          <span className="lc-data text-[28px] leading-none text-lc-chalk phone:text-[22px]">
            {formatCount(profile.circuitsDriven)}
          </span>
          <span className="lc-hint truncate">{profile.circuitsDriven === 1 ? "Circuit" : "Circuits"}</span>
        </Well>
        <Well className="flex min-w-0 flex-col gap-1 px-4 py-3 phone:px-3 phone:py-2.5">
          <span className="lc-data text-[28px] leading-none text-lc-chalk phone:text-[22px]">
            {formatCount(profile.boardsEntered)}
          </span>
          <span className="lc-hint truncate">{profile.boardsEntered === 1 ? "Board" : "Boards"}</span>
        </Well>
      </div>

      {/* Open races record from /api/drivers/record */}
      {record !== null ? (
        <Card title="Open races" bodyClassName="gap-2.5">
          {record.starts === 0 ? (
            <p className="lc-hint m-0">No finished open races yet.</p>
          ) : (
            <div className="grid grid-cols-4 gap-2.5 phone:grid-cols-2 phone:gap-2">
              <Well className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5 phone:px-3">
                <span className="lc-data text-[20px] leading-none text-lc-chalk">{formatCount(record.starts)}</span>
                <span className="lc-hint truncate">{record.starts === 1 ? "Race" : "Races"}</span>
              </Well>
              <Well className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5 phone:px-3">
                <span className="lc-data text-[20px] leading-none text-lc-chalk">{formatCount(record.wins)}</span>
                <span className="lc-hint truncate">{record.wins === 1 ? "Win" : "Wins"}</span>
              </Well>
              <Well className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5 phone:px-3">
                <span className="lc-data text-[20px] leading-none text-lc-chalk">{formatCount(record.podiums)}</span>
                <span className="lc-hint truncate">{record.podiums === 1 ? "Podium" : "Podiums"}</span>
              </Well>
              <Well className="flex min-w-0 flex-col gap-1 px-3.5 py-2.5 phone:px-3">
                <span className="lc-data text-[20px] leading-none text-lc-chalk">
                  {record.bestFinish !== null ? `P${formatCount(record.bestFinish)}` : "—"}
                </span>
                <span className="lc-hint truncate">Best finish</span>
              </Well>
            </div>
          )}
        </Card>
      ) : null}

      {/* Per-circuit best laps */}
      <Card
        title="Best laps"
        description={
          profile.laps.length > 0
            ? "Current physics boards, all assists and conditions. Rating weights few circuits toward 50."
            : undefined
        }
        action={
          profile.laps.length > 1 ? (
            <Segmented
              aria-label="Sort best laps"
              size="sm"
              value={sort}
              onChange={setSort}
              options={[
                { id: "rank", label: "Best rank" },
                { id: "circuit", label: "Circuit" },
                { id: "recent", label: "Recent" },
              ]}
            />
          ) : undefined
        }
        bodyClassName="gap-2"
      >
        {sortedLaps.length === 0 ? (
          <EmptyState icon={<Icon name="lapTimes" />}>No laps on the current boards yet.</EmptyState>
        ) : (
          <div className="@container min-w-0">
            <table className="w-full border-collapse" aria-label={`${profile.name}'s best laps`}>
              <thead>
                <tr className="border-b border-lc-line">
                  <th scope="col" className={`${TH} w-24 phone:w-16`}>
                    Pos
                  </th>
                  <th scope="col" className={`${TH} w-full`}>
                    Circuit
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Lap
                  </th>
                  <th scope="col" className={`${TH} ${SECTOR}`}>
                    S1
                  </th>
                  <th scope="col" className={`${TH} ${SECTOR}`}>
                    S2
                  </th>
                  <th scope="col" className={`${TH} ${SECTOR}`}>
                    S3
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedLaps.map((lap) => {
                  const trackLabel = circuitName(lap.trackId);
                  const tag = carTag(lap.vehicle);
                  const fastest = lap.position === 1;
                  return (
                    <tr key={`${lap.trackId}-${lap.vehicle}-${lap.id}`} className="h-13 border-b border-white/5 last:border-b-0">
                      <td className="px-2 py-1.5">
                        <span className="flex flex-col items-start gap-0.5 @sm:flex-row @sm:items-center @sm:gap-1.5">
                          <PositionBadge position={lap.position} size="sm" className="min-w-10" />
                          <span className="lc-mono text-[11px] text-lc-slate whitespace-nowrap">
                            of {formatCount(lap.boardSize)}
                          </span>
                        </span>
                      </td>
                      <td className="max-w-0 px-2 py-1.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {onOpenBoard ? (
                            <button
                              type="button"
                              onClick={() => onOpenBoard(lap.trackId, lap.vehicle)}
                              title={`Open ${trackLabel} (${tag.label}) board`}
                              className="min-w-0 cursor-pointer truncate rounded-lc-nub border-0 bg-transparent px-1 -mx-1 py-0.5 text-left text-[14px] font-semibold text-lc-chalk decoration-lc-slate/70 underline-offset-4 transition-colors duration-150 ease-lc hover:underline"
                            >
                              {trackLabel}
                            </button>
                          ) : (
                            <span className="min-w-0 truncate text-[14px] font-semibold text-lc-chalk" title={trackLabel}>
                              {trackLabel}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                          <Badge tone={{ color: tag.color }} size="sm" className="max-w-[9.5rem] truncate">
                            {tag.label}
                          </Badge>
                          <InputIcon input={lap.conditions.input} className="text-lc-fog" />
                          <LapConditionBadges
                            assists={lap.conditions.assists}
                            realism={lap.conditions.realism}
                            surface={lap.conditions.surface}
                          />
                          <span className="lc-hint hidden @md:inline" title={new Date(lap.recordedAt).toLocaleString()}>
                            {new Date(lap.recordedAt).toLocaleDateString()}
                          </span>
                        </span>
                      </td>
                      <td className="px-2 text-right">
                        <span
                          className={`lc-mono text-[15px] font-bold whitespace-nowrap phone:text-[14px] ${
                            fastest ? "text-lc-best underline decoration-2 underline-offset-4" : "text-lc-chalk"
                          }`}
                          title={fastest ? "Fastest on this board" : undefined}
                        >
                          {formatLapTime(lap.lapTimeMs)}
                          {fastest ? <span className="sr-only"> (fastest)</span> : null}
                        </span>
                      </td>
                      {[0, 1, 2].map((k) => (
                        <td key={k} className={`px-2 ${SECTOR}`}>
                          {lap.sectorTimesMs[k] > 0 ? (
                            <span className="lc-mono text-[13px] font-bold whitespace-nowrap text-lc-fog">
                              {formatSectorTime(lap.sectorTimesMs[k])}
                            </span>
                          ) : null}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
};

export const DriverProfileModal: React.FC<DriverProfileModalProps> = ({
  driverName,
  onClose,
  isMe = false,
  circuitName,
  carTag,
  initialBadges,
  onOpenBoard,
}) => {
  const open = Boolean(driverName && driverName.trim());
  const targetKey = driverName ? driverNameKey(driverName) : "";
  const [refresh, setRefresh] = useState<{ key: string; seq: number }>({ key: "", seq: 0 });
  const reload = refresh.key === targetKey ? refresh.seq : 0;
  const triggerRefresh = () => setRefresh((r) => ({ key: targetKey, seq: r.key === targetKey ? r.seq + 1 : 1 }));
  const [state, setState] = useState<{
    key: string;
    reload: number;
    profile: DriverProfile | null;
    record: DriverRecord | null;
    badges: DriverBadge[];
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open || !driverName) return;
    let live = true;
    const fresh = reload > 0;
    void Promise.all([
      fetchDriverProfile(driverName, { fresh }).catch(() => null),
      fetchDriverRecord(driverName).catch(() => null),
      fetchBadges([driverName]).catch((): Record<string, DriverBadge[]> => ({})),
    ]).then(([profile, record, badgeMap]) => {
      if (!live) return;
      const driverBadges = Object.hasOwn(badgeMap, targetKey) ? badgeMap[targetKey] : [];
      setState((prev) => {
        const sameDriver = prev && prev.key === targetKey;
        return {
          key: targetKey,
          reload,
          profile: profile ?? (sameDriver ? prev.profile : null),
          record: record ?? (sameDriver ? prev.record : null),
          badges: driverBadges.length > 0 ? driverBadges : sameDriver ? prev.badges : [],
          error: profile === null,
        };
      });
    });
    return () => {
      live = false;
    };
  }, [open, driverName, targetKey, reload]);

  const same = state !== null && state.key === targetKey;
  const settled = same && state.reload === reload;
  const loading = open && !settled;
  const profile = same ? state.profile : null;
  const record = same ? state.record : null;
  const error = settled && Boolean(state?.error);
  const badges = same && state.badges.length > 0 ? state.badges : (initialBadges ?? []);
  const displayName = profile && profile.boardsEntered > 0 ? profile.name : (driverName?.trim() ?? "");
  const code = profile?.code ?? null;

  const handleOpenBoard = onOpenBoard
    ? (trackId: string, vehicle: VehicleModelId) => {
        onOpenBoard(trackId, vehicle);
        onClose();
      }
    : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      ariaLabel={displayName ? `${displayName} driver profile` : "Driver profile"}
      titleClassName="text-[24px] leading-tight font-bold text-lc-chalk phone:text-[20px]"
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          {code ? (
            <span className="lc-mono shrink-0 text-[14px] font-bold tracking-[0.08em] text-lc-slate">{code.slice(0, 3)}</span>
          ) : null}
          <span dir="auto" className="min-w-0 truncate" title={displayName}>
            {displayName}
          </span>
          {isMe ? <PlayerTag size="sm" /> : null}
        </span>
      }
      subtitle={
        badges.length > 0 ? (
          <DriverBadges
            badges={badges}
            context={{ scope: "all" }}
            driverName={displayName}
            circuitName={circuitName}
            onOpenBoard={handleOpenBoard}
          />
        ) : undefined
      }
      headerAction={
        <IconButton
          size="sm"
          variant="ghost"
          icon={<Icon name="refresh" />}
          aria-label="Refresh driver profile"
          title="Refresh"
          disabled={loading}
          aria-busy={loading || undefined}
          onClick={triggerRefresh}
        />
      }
    >
      <DriverProfileBody
        profile={profile}
        record={record}
        loading={loading}
        error={error}
        circuitName={circuitName}
        carTag={carTag}
        onRetry={triggerRefresh}
        onOpenBoard={handleOpenBoard}
      />
    </Modal>
  );
};
