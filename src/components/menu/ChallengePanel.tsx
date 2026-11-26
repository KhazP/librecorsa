"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { anyCarById, anyCarForVehicle, type CarDefinition, type CarId } from "@/lib/cars/car-registry";
import { carBoardTag } from "@/lib/cars/board-tag";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { TRACKS, getTrackInfo, venueHeroUrl, venueOf } from "@/lib/track-registry";
import { withBasePath } from "@/lib/base-path";
import { driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { boardChoiceOf, boardChoices, currentBoardBase } from "@/lib/sim/lap-types";
import {
  challengeById,
  challengeConditionsLabel,
  isPermanentChallenge,
  timeLeftLabel,
  type TimeTrialEvent,
} from "@/lib/net/weekly-challenge";
import { formatLapTime } from "@/components/hud/hud-format";
import { CarThumb } from "@/components/menu/CarBrowser";
import { CarClassTag } from "@/components/menu/menu-content-ui";
import { TrackOutline, useCircuitOutline } from "@/components/menu/circuit-outline";
import { HallOfFame } from "@/components/board/HallOfFame";
import { DriverProfileModal } from "@/components/board/DriverProfileModal";
import { LapConditionBadges } from "@/components/board/LapConditionBadges";
import { BoardError, BoardSkeleton, BoardTable, MyPlace } from "@/components/hud/LeaderboardPanel";
import { Button, Card, EmptyState, Modal, Select, TextField } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Icon } from "@/components/ui/icons";
import { cx } from "@/components/ui/styles";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import { formatCount } from "@/lib/net/board-client";
import { sanitizeDriverName } from "@/lib/settings/player-settings";

export interface ChallengeTrialItem {
  event: TimeTrialEvent;
  /** Display title for this event ("Weekly Time Trial" or "Middle Gear Lap Board") */
  title: string;
  /** Optional subtitle/tagline shown on the event card */
  tagline?: string;
  trackName: string;
  carTitle: string;
  /** This copy of the game has this trial's circuit and car */
  available: boolean;
  /**
   * Reads this trial's board of base revision `version` (lap-types.ts `BoardChoice`) with the player's place on it;
   * null when it can't be read
   */
  loadBoard: (version: number) => Promise<RemoteBoard | null>;
  /** Sets the game up to this trial's rules and goes out on track */
  onDrive: () => void;
  /** Races on this trial's circuit and car run on this site (entered from Multiplayer) */
  hasRaces?: boolean;
}

export interface ChallengePanelProps {
  /** Active online time trials (Weekly Time Trial + permanent events like Middle Gear Lap Board) */
  trials: readonly ChallengeTrialItem[];
  /** Changes when a board may have changed (a lap went up) */
  boardVersion: number;
  driverName: string;
  /** True while the player still only has an auto-generated default name */
  driverNameGenerated?: boolean;
  /** Claims / updates the driver name (returns an error string if rejected, or null on success) */
  onRenameDriver?: (name: string) => Promise<string | null>;
  /** Explicitly keeps the current auto-generated name so the prompt does not repeat */
  onConfirmDriverName?: () => void;
  /** Jumps to a record's board in the Lap Times panel when tapped in the FL popover / Hall of Fame */
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}

const formatCircuitName = (id: string): string => {
  const t = TRACKS.find((x) => x.id === id);
  if (!t) return id.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const layouts = venueOf(id)?.layouts.length ?? 1;
  return layouts > 1 && t.layout ? `${t.name} · ${t.layout}` : t.name;
};

const formatCarName = (vehicle: string, eventId?: string): string => {
  const namedCar = eventId ? challengeById(eventId)?.car : undefined;
  if (namedCar) {
    const title = anyCarById(namedCar as CarId)?.title;
    if (title) return title;
  }
  if (isVehicleModelId(vehicle)) {
    return anyCarForVehicle(vehicle)?.title ?? carBoardTag(vehicle).label;
  }
  return vehicle;
};

const resolveTrialCar = (event: TimeTrialEvent): CarDefinition | undefined => {
  if (event.car) {
    const byId = anyCarById(event.car as CarId);
    if (byId) return byId;
  }
  return anyCarForVehicle(event.vehicle);
};

/** Compact GT7-style event banner card for selecting between active Online Time Trials */
const TrialEventCard: React.FC<{
  trial: ChallengeTrialItem;
  selected: boolean;
  summary: RemoteBoard | null;
  now: number;
  onSelect: () => void;
}> = ({ trial, selected, summary, now, onSelect }) => {
  const tx = useTranslations("menu.challenge");
  const { event } = trial;
  const permanent = isPermanentChallenge(event);
  const track = TRACKS.find((t) => t.id === event.trackId);
  const venue = venueOf(event.trackId);
  const car = resolveTrialCar(event);
  const outline = useCircuitOutline(track, true, true);
  const [heroFailed, setHeroFailed] = useState(false);

  const leader = summary?.entries[0] ?? null;
  const me = summary?.me ?? null;

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cx(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-lc-card border text-start transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-lc-volt focus-visible:ring-offset-2 focus-visible:ring-offset-lc-void",
        selected
          ? permanent
            ? "border-[#F5C542]/85 bg-lc-carbon shadow-[0_0_0_1px_rgba(245,197,66,0.35),0_12px_32px_rgba(0,0,0,0.45)]"
            : "border-lc-volt bg-lc-carbon shadow-[0_0_0_1px_rgba(204,255,0,0.3),0_12px_32px_rgba(0,0,0,0.45)]"
          : "border-lc-line bg-lc-carbon/85 hover:border-lc-keyline hover:bg-lc-carbon"
      )}
    >
      {/* Top accent stripe */}
      <span
        aria-hidden
        className={cx(
          "h-1 w-full transition-opacity",
          permanent
            ? "bg-linear-to-r from-[#F5C542] via-amber-400 to-[#D98A4E]"
            : "bg-linear-to-r from-lc-volt via-lc-info to-lc-cyan",
          selected ? "opacity-100" : "opacity-40 group-hover:opacity-75"
        )}
      />

      {/* Visual hero backdrop */}
      <div className="relative flex min-h-[156px] flex-1 flex-col justify-between overflow-hidden px-4 pt-3.5 pb-3 sm:px-5">
        {venue && !heroFailed ? (
          <img
            src={withBasePath(venueHeroUrl(venue.id, 960))}
            alt=""
            aria-hidden
            onError={() => setHeroFailed(true)}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center opacity-30 transition duration-500 group-hover:scale-[1.03] group-hover:opacity-40"
          />
        ) : null}
        <div
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0",
            permanent
              ? "bg-linear-to-r from-lc-void/96 via-lc-void/86 to-amber-950/35"
              : "bg-linear-to-r from-lc-void/96 via-lc-void/86 to-sky-950/35"
          )}
        />

        {/* Top status badges */}
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {permanent ? (
              <>
                <Badge size="sm" variant="solid" tone={{ color: "amber" }} icon="challenge">
                  {tx("permanentBadge")}
                </Badge>
                {event.fixedSetup ? (
                  <Badge size="sm" variant="outline" icon="locked">
                    {tx("fixedSetupBadge")}
                  </Badge>
                ) : null}
              </>
            ) : (
              <>
                <Badge size="sm" variant="solid" tone="info" icon="time">
                  {tx("weeklyBadge")}
                </Badge>
                <Badge size="sm" variant="outline" icon="time">
                  {tx("timeLeft", { timeLeft: timeLeftLabel(event.endsMs, now) })}
                </Badge>
              </>
            )}
          </div>
          {!permanent ? <span className="lc-mono text-[11px] tracking-wider text-lc-slate uppercase">{event.id}</span> : null}
        </div>

        {/* Title + artwork composition */}
        <div className="relative z-10 mt-2.5 flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cx(
                "text-[11px] font-bold tracking-[0.12em] uppercase",
                permanent ? "text-[#F5C542]" : "text-lc-volt"
              )}
            >
              {trial.title}
            </span>
            <h3 className="lc-h3 m-0 line-clamp-2 text-[18px] leading-tight text-lc-chalk">{trial.trackName}</h3>
            <p className="m-0 truncate text-[14px] font-semibold text-lc-fog">{trial.carTitle}</p>
            {trial.tagline ? <p className="m-0 mt-0.5 truncate text-[12px] text-lc-slate">{trial.tagline}</p> : null}
          </div>

          <div className="relative hidden h-[82px] w-[138px] shrink-0 sm:block">
            {outline ? (
              <TrackOutline
                map={outline}
                thin
                className="pointer-events-none absolute -top-2 right-0 h-[68px] w-[90px] opacity-35 transition group-hover:opacity-55"
              />
            ) : null}
            {car ? (
              <div className="relative h-full w-full">
                <CarThumb car={car} className="drop-shadow-[0_6px_12px_rgba(0,0,0,0.65)]" />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Live telemetry footer strip */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-lc-line/80 bg-lc-well/85 px-4 py-2 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {me ? (
            <>
              {permanent && me.rank === 1 ? (
                <Badge size="sm" variant="solid" tone={{ color: "chalk" }} icon="helmet" className="px-1.5">
                  STIG
                </Badge>
              ) : null}
              <span className="lc-data text-[13px] font-semibold text-lc-volt">P{me.rank}</span>
              <span className="lc-mono text-[13px] text-lc-chalk">{formatLapTime(me.entry.lapTimeMs)}</span>
            </>
          ) : (
            <span className="text-[12px] text-lc-slate">{tx("noTimeSet")}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[12px] text-lc-fog">
          {leader ? (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="text-[11px] font-semibold tracking-wider text-lc-slate uppercase">{tx("leaderShort")}</span>
              <span className="lc-mono font-semibold text-lc-chalk">{formatLapTime(leader.lapTimeMs)}</span>
            </span>
          ) : null}
          {summary ? (
            <span className="lc-mono text-lc-slate">{tx("drivers", { total: summary.total, count: formatCount(summary.total) })}</span>
          ) : null}
        </div>
      </div>
    </button>
  );
};

const PODIUM_SLOTS = [
  { place: 1, tag: "P1", icon: "challenge" as const, tone: { color: "amber" as const }, variant: "soft" as const },
  { place: 2, tag: "P2", icon: "medal" as const, tone: { color: "chalk" as const }, variant: "soft" as const },
  { place: 3, tag: "P3", icon: "medal" as const, tone: { color: "amber" as const }, variant: "outline" as const },
];

/** Compact P1 / P2 / P3 podium preview for the rotating weekly challenge (matching Hall of Fame medals) */
const WeeklyPodiumStrip: React.FC<{ board: RemoteBoard | null; myKey: string }> = ({ board, myKey }) => {
  const tx = useTranslations("menu.challenge");
  const top3 = board?.entries.slice(0, 3) ?? [];

  return (
    <div className="flex flex-col gap-2 rounded-lc-tile border border-lc-line bg-lc-well/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="lc-row-label flex items-center gap-1.5">
          <Icon name="podium" size="sm" className="text-lc-fog" />
          {tx("podiumStanding")}
        </span>
        <span className="text-[11px] text-lc-slate">{tx("podiumRewardsHint")}</span>
      </div>
      {top3.length === 0 ? (
        <p className="lc-hint m-0">{tx("podiumEmpty")}</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {PODIUM_SLOTS.map((slot, idx) => {
            const entry = top3[idx];
            const mine = Boolean(entry && myKey && driverNameKey(entry.name) === myKey);
            return (
              <div
                key={slot.place}
                className={cx(
                  "flex min-w-0 flex-col gap-0.5 rounded-lc-row border px-2.5 py-2",
                  mine ? "border-lc-volt/60 bg-lc-volt/10" : "border-lc-line/80 bg-lc-carbon/70"
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <Badge size="sm" tone={slot.tone} variant={slot.variant} icon={slot.icon} className="px-1.5">
                    {slot.tag}
                  </Badge>
                </div>
                {entry ? (
                  <>
                    <span className={cx("mt-0.5 truncate text-[12px] font-semibold", mine ? "text-lc-volt" : "text-lc-chalk")}>
                      {entry.name}
                    </span>
                    <span className={cx("lc-mono text-[12px]", idx === 0 ? "text-lc-best-ink" : "text-lc-fog")}>
                      {formatLapTime(entry.lapTimeMs)}
                    </span>
                  </>
                ) : (
                  <span className="lc-mono mt-1 text-[12px] text-lc-slate">—</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Live record-holder card for Middle Gear Lap Board's "The Stig" badge */
const StigHolderStrip: React.FC<{ board: RemoteBoard | null; myKey: string }> = ({ board, myKey }) => {
  const tx = useTranslations("menu.challenge");
  const leader = board?.entries[0] ?? null;
  const isMe = Boolean(leader && myKey && driverNameKey(leader.name) === myKey);

  return (
    <div
      className={cx(
        "flex flex-col gap-2 rounded-lc-tile border p-3",
        isMe ? "border-lc-volt/65 bg-lc-volt/10" : "border-lc-line bg-lc-well/60"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge size="sm" variant="solid" tone={{ color: "chalk" }} icon="helmet">
          {tx("stigAward")}
        </Badge>
        <span className="text-[11px] text-lc-slate">{tx("stigHolderHint")}</span>
      </div>
      {leader ? (
        <div className="flex items-center justify-between gap-3 rounded-lc-row border border-lc-line/80 bg-lc-carbon/75 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="lc-data text-[12px] font-bold text-lc-best-ink">{tx("stigPlace")}</span>
            <span className={cx("truncate text-[14px] font-semibold", isMe ? "text-lc-volt" : "text-lc-chalk")}>{leader.name}</span>
          </div>
          <span className="lc-mono shrink-0 text-[14px] font-semibold text-lc-best-ink">{formatLapTime(leader.lapTimeMs)}</span>
        </div>
      ) : (
        <p className="lc-hint m-0">{tx("stigEmpty")}</p>
      )}
    </div>
  );
};

type ChallengeTab = "week" | "hof";

/**
 * GT7 Sport Mode-inspired Online Time Trials panel:
 * side-by-side active event cards (Weekly Time Trial + permanent Middle Gear Lap Board),
 * Gold/Silver/Bronze pace targets relative to P1, structured event regulations, live ranking board,
 * and the Hall of Fame of completed weeks.
 */
export const ChallengePanel: React.FC<ChallengePanelProps> = ({
  trials,
  boardVersion,
  driverName,
  driverNameGenerated = false,
  onRenameDriver,
  onConfirmDriverName,
  onOpenBoard,
}) => {
  const tx = useTranslations("menu.challenge");
  const units = useUnits();
  const [tab, setTab] = useState<ChallengeTab>("week");
  const [selectedId, setSelectedId] = useState<string>(() => trials[0]?.event.id ?? "");
  const [profileDriver, setProfileDriver] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<{ mode: "drive"; trial: ChallengeTrialItem } | { mode: "edit" } | null>(null);
  const [nameDraft, setNameDraft] = useState(driverName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Selected trial falls back to the first if the week rolled over while open
  const selected = trials.find((t) => t.event.id === selectedId) ?? trials[0];

  // Preload current-revision summary boards for all active trials so every event banner shows live P1 + player standing
  const [summaries, setSummaries] = useState<Record<string, RemoteBoard | null>>({});
  const trialIdsKey = trials.map((t) => t.event.id).join("|");
  useEffect(() => {
    let live = true;
    for (const item of trials) {
      const base = currentBoardBase(item.event.trackId);
      void item.loadBoard(base).then((board) => {
        if (!live) return;
        setSummaries((prev) => ({ ...prev, [item.event.id]: board ?? prev[item.event.id] ?? null }));
      });
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trialIdsKey, boardVersion, driverName]);

  const openNamePrompt = (target: { mode: "drive"; trial: ChallengeTrialItem } | { mode: "edit" }) => {
    setNameDraft(driverName);
    setNameError(null);
    setNameSaving(false);
    setNameModal(target);
  };

  const handleDriveClick = (trial: ChallengeTrialItem) => {
    if (driverNameGenerated && (onRenameDriver || onConfirmDriverName)) {
      openNamePrompt({ mode: "drive", trial });
      return;
    }
    trial.onDrive();
  };

  const handleKeepName = () => {
    const driveTrial = nameModal?.mode === "drive" ? nameModal.trial : null;
    onConfirmDriverName?.();
    setNameModal(null);
    driveTrial?.onDrive();
  };

  const handleSaveName = async () => {
    const driveTrial = nameModal?.mode === "drive" ? nameModal.trial : null;
    const cleaned = sanitizeDriverName(nameDraft);
    if (cleaned === driverName || !onRenameDriver) {
      handleKeepName();
      return;
    }
    setNameSaving(true);
    setNameError(null);
    const problem = await onRenameDriver(nameDraft);
    setNameSaving(false);
    if (problem !== null) {
      setNameError(problem);
      return;
    }
    setNameModal(null);
    driveTrial?.onDrive();
  };

  const [reload, setReload] = useState(0);
  // Physics version picked for the selected trial (resets when switching trials)
  const [boardPickByEvent, setBoardPickByEvent] = useState<Record<string, string>>({});
  const selectedEventId = selected?.event.id ?? "";
  const selectedTrackId = selected?.event.trackId ?? "";
  const choices = selected ? boardChoices(selectedTrackId) : [];
  const choice = selected ? boardChoiceOf(selectedTrackId, boardPickByEvent[selectedEventId] ?? null) : null;
  const older = choice ? !choice.current : false;
  const version = choice?.base ?? 0;
  const versionName = choice?.label ?? "";

  const [state, setState] = useState<{ eventId: string; of: number; board: RemoteBoard | null; loading: boolean; error: boolean }>({
    eventId: selectedEventId,
    of: version,
    board: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void selected.loadBoard(version).then((board) => {
      if (!live) return;
      setState((s) => ({
        eventId: selected.event.id,
        of: version,
        board: board ?? (s.eventId === selected.event.id && s.of === version ? s.board : null),
        loading: false,
        error: board === null,
      }));
      if (board && choice?.current) {
        setSummaries((prev) => ({ ...prev, [selected.event.id]: board }));
      }
    });
    return () => {
      live = false;
    };
  }, [selected, boardVersion, reload, version, choice?.current]);

  const selectedTrackInfo = selected ? getTrackInfo(selected.event.trackId) : undefined;
  const selectedOutline = useCircuitOutline(selectedTrackInfo, Boolean(selected), true);
  const selectedCar = selected ? resolveTrialCar(selected.event) : undefined;

  if (!selected || !choice) return null;

  const isPermanent = isPermanentChallenge(selected.event);
  // Use preloaded current-revision summary immediately when switching between trials so there is no blank flicker
  const matchedStateBoard = state.eventId === selected.event.id && state.of === version ? state.board : null;
  const board = matchedStateBoard ?? (choice.current ? (summaries[selected.event.id] ?? null) : null);
  const loading = (state.loading || state.eventId !== selected.event.id || state.of !== version) && !board;
  const myKey = driverNameKey(driverName);
  const me = board?.me ?? null;
  const ahead = me && me.rank >= 2 ? (board?.entries[me.rank - 2] ?? null) : null;
  const aboveMs = me && me.rank >= 2 ? (me.aboveMs ?? ahead?.lapTimeMs ?? null) : null;

  const trackLength = selectedTrackInfo
    ? `${distanceIn(selectedTrackInfo.lengthM / 1000, units.speed).toFixed(2)}\u00a0${DISTANCE_LABEL[units.speed]}`
    : null;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Header row: Time trials / Hall of Fame toggle + compact Driver identity */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Segmented
          aria-label={tx("view")}
          size="sm"
          value={tab}
          onChange={setTab}
          options={[
            { id: "week", label: tx("timeTrials") },
            { id: "hof", label: tx("hallOfFame") },
          ]}
        />
        {driverName ? (
          <div className="flex items-center gap-2 rounded-lc-row border border-lc-line bg-lc-well/65 py-1 ps-3 pe-1.5">
            <span className="max-w-[14rem] truncate text-[12px] text-lc-fog">
              {tx.rich("postingAs", {
                name: driverName,
                b: (chunks) => <span className="font-semibold text-lc-chalk">{chunks}</span>,
              })}
            </span>
            {onRenameDriver ? (
              <Button size="sm" variant="ghost" onClick={() => openNamePrompt({ mode: "edit" })}>
                {tx("changeName")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {tab === "hof" ? (
        <HallOfFame
          circuitName={formatCircuitName}
          carName={formatCarName}
          driverName={driverName}
          refreshKey={boardVersion}
          onOpenBoard={onOpenBoard}
        />
      ) : (
        <div className="flex flex-col gap-3.5">
          {/* GT7-style side-by-side Active Event Cards */}
          <div
            role="group"
            aria-label={tx("selectTrial")}
            className={cx("grid grid-cols-1 gap-3", trials.length > 1 && "md:grid-cols-2")}
          >
            {trials.map((item) => (
              <TrialEventCard
                key={item.event.id}
                trial={item}
                selected={item.event.id === selected.event.id}
                summary={summaries[item.event.id] ?? null}
                now={now}
                onSelect={() => setSelectedId(item.event.id)}
              />
            ))}
          </div>

          {/* Selected Event Detail Stage: Briefing & Pace Targets (left) + Live Ranking Board (right) */}
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1.02fr)_minmax(0,1fr)]">
            <Card
              title={selected.title}
              description={`${selected.trackName} · ${selected.carTitle}`}
              action={
                isPermanentChallenge(selected.event) ? (
                  <Badge icon="challenge" tone={{ color: "amber" }} variant="soft">
                    {tx("alwaysOpen")}
                  </Badge>
                ) : (
                  <Badge icon="time" variant="outline">
                    {tx("timeLeft", { timeLeft: timeLeftLabel(selected.event.endsMs, now) })}
                  </Badge>
                )
              }
              bodyClassName="gap-3.5"
            >
              {/* Circuit & Car visual telemetry strip */}
              <div className="flex items-center justify-between gap-3 rounded-lc-tile border border-lc-line bg-lc-well/60 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {selectedOutline ? (
                    <TrackOutline map={selectedOutline} sectors className="h-[60px] w-[78px] shrink-0" />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14px] font-semibold text-lc-chalk">{selected.trackName}</span>
                    {selectedTrackInfo ? (
                      <span className="lc-hint truncate">
                        {[selectedTrackInfo.country, trackLength, tx("turns", { count: selectedTrackInfo.turns })].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                    {selectedCar ? (
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        <CarClassTag car={selectedCar} size="sm" />
                        <span className="min-w-0 truncate text-[12px] text-lc-fog">{selectedCar.sub}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
                {selectedCar ? (
                  <div className="relative hidden h-[58px] w-[104px] shrink-0 sm:block">
                    <CarThumb car={selectedCar} />
                  </div>
                ) : null}
              </div>

              {/* Weekly P1/P2/P3 podium standing or Middle Gear "The Stig" record holder */}
              {isPermanent ? <StigHolderStrip board={board} myKey={myKey} /> : <WeeklyPodiumStrip board={board} myKey={myKey} />}

              {/* Event Regulations */}
              <div className="flex flex-col gap-2 rounded-lc-tile border border-lc-line bg-lc-well/40 px-3.5 py-3">
                <span className="lc-row-label">{tx("regulations")}</span>
                <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-[13px]">
                  <dt className="text-lc-slate">{tx("regConditions")}</dt>
                  <dd className="lc-mono m-0 text-end text-lc-chalk">{challengeConditionsLabel(selected.event.vehicle)}</dd>

                  <dt className="text-lc-slate">{tx("regSetup")}</dt>
                  <dd className="m-0 text-end font-medium text-lc-chalk">
                    {isPermanentChallenge(selected.event) && selected.event.fixedSetup ? tx("regSetupFixed") : tx("regSetupOpen")}
                  </dd>

                  <dt className="text-lc-slate">{tx("regAssists")}</dt>
                  <dd className="m-0 flex justify-end">
                    <div className="flex flex-wrap justify-end gap-1.5" aria-label={tx("rules")}>
                      <LapConditionBadges assists={selected.event.assists} realism={selected.event.realism} />
                    </div>
                  </dd>

                  <dt className="text-lc-slate">{tx("regFormat")}</dt>
                  <dd className="m-0 text-end text-lc-fog">{tx("regFormatValue")}</dd>
                </dl>
                <p className="lc-hint m-0 border-t border-lc-line/70 pt-2">
                  {isPermanent
                    ? tx("aboutPermanent")
                    : selected.hasRaces && selected.available
                      ? tx("aboutWithRaces")
                      : tx("about")}
                </p>
              </div>

              {/* Primary Enter CTA */}
              {selected.available ? (
                <Button variant="primary" size="lg" block icon={<Icon name="drive" />} onClick={() => handleDriveClick(selected)}>
                  {isPermanent ? tx("driveMiddleGear") : tx("enterTrial")}
                </Button>
              ) : (
                <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-caution">
                  <Icon name="warning" className="mt-0.5" />
                  {tx("unavailable")}
                </p>
              )}
            </Card>

            {/* Live Ranking Board Card */}
            <Card
              title={isPermanent ? selected.title : tx("times")}
              action={board ? <Badge variant="outline">{tx("drivers", { total: board.total, count: formatCount(board.total) })}</Badge> : null}
              bodyClassName="gap-3"
            >
              {choices.length <= 2 ? (
                <Segmented
                  aria-label={tx("physicsVersion")}
                  size="sm"
                  value={choice.id}
                  onChange={(id) => setBoardPickByEvent((prev) => ({ ...prev, [selected.event.id]: id }))}
                  options={choices}
                  className="self-start"
                />
              ) : (
                <Select
                  aria-label={tx("physicsVersion")}
                  className="w-64 max-w-full self-start"
                  value={choice.id}
                  onChange={(id) => setBoardPickByEvent((prev) => ({ ...prev, [selected.event.id]: id }))}
                  options={choices}
                />
              )}
              {me ? (
                <MyPlace
                  rank={me.rank}
                  total={board?.total ?? me.rank}
                  lapMs={me.entry.lapTimeMs}
                  detail={
                    me.rank === 1
                      ? isPermanent
                        ? tx("fastestPermanent")
                        : tx("fastest")
                      : aboveMs !== null
                        ? ahead && ahead.lapTimeMs === aboveMs
                          ? tx("behindDriver", { gap: ((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3), driver: ahead.name })
                          : tx("behindPlace", { gap: ((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3), place: String(me.rank - 1) })
                        : ""
                  }
                />
              ) : null}
              {loading && !board ? (
                <BoardSkeleton label={tx("loadingTrialTimes")} />
              ) : state.error && !board ? (
                <BoardError onRetry={() => setReload((n) => n + 1)}>{tx("loadFailed")}</BoardError>
              ) : !board || board.entries.length === 0 ? (
                <EmptyState icon={<Icon name="challenge" />}>
                  {older ? tx("noTimesVersion", { version: versionName }) : tx("noTimes")}
                </EmptyState>
              ) : (
                <BoardTable
                  label={older ? tx("tableLabelVersion", { version: versionName }) : tx("tableLabel")}
                  badgeContext={{ scope: "vehicle", vehicle: selected.event.vehicle }}
                  circuitName={formatCircuitName}
                  onOpenRecordBoard={onOpenBoard}
                  onSelectDriver={setProfileDriver}
                  rows={board.entries.map((e, i) => ({
                    key: e.id ?? `${e.code}-${i}`,
                    rank: i + 1,
                    code: e.code,
                    title: e.name,
                    input: e.conditions?.input,
                    lapMs: e.lapTimeMs,
                    fastest: i === 0,
                    mine: myKey !== "" && driverNameKey(e.name) === myKey,
                  }))}
                />
              )}
            </Card>
          </div>
        </div>
      )}

      <DriverProfileModal
        driverName={profileDriver}
        onClose={() => setProfileDriver(null)}
        isMe={Boolean(profileDriver && myKey !== "" && driverNameKey(profileDriver) === myKey)}
        circuitName={formatCircuitName}
        carTag={carBoardTag}
        onOpenBoard={onOpenBoard}
      />

      <Modal
        open={nameModal !== null}
        onClose={() => {
          if (!nameSaving) setNameModal(null);
        }}
        title={tx("namePrompt.title")}
        size="md"
      >
        <p className="lc-body m-0 text-lc-fog">{tx("namePrompt.bodyTrial")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSaveName();
          }}
          className="flex flex-col gap-4"
        >
          <TextField
            label={tx("namePrompt.label")}
            hint={tx("namePrompt.hint")}
            maxLength={16}
            autoComplete="nickname"
            spellCheck={false}
            autoFocus
            value={nameDraft}
            disabled={nameSaving}
            error={nameError ?? undefined}
            onChange={(v) => {
              setNameDraft(v);
              setNameError(null);
            }}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {nameModal?.mode === "drive" && sanitizeDriverName(nameDraft) !== driverName ? (
              <Button type="button" variant="secondary" disabled={nameSaving} onClick={handleKeepName}>
                {tx("namePrompt.keepAndDrive")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled={nameSaving} onClick={() => setNameModal(null)}>
                {tx("namePrompt.cancel")}
              </Button>
            )}
            <Button type="submit" variant="primary" loading={nameSaving}>
              {nameSaving
                ? tx("namePrompt.saving")
                : nameModal?.mode === "drive"
                  ? sanitizeDriverName(nameDraft) === driverName
                    ? tx("namePrompt.keepAndDrive")
                    : tx("namePrompt.saveAndDrive")
                  : tx("namePrompt.save")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
