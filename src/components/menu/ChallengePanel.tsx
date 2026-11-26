"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { anyCarById, anyCarForVehicle, type CarDefinition, type CarId } from "@/lib/cars/car-registry";
import { carBoardTag } from "@/lib/cars/board-tag";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { TRACKS, getTrackInfo, venueHeroUrl, venueOf } from "@/lib/track-registry";
import { withBasePath } from "@/lib/base-path";
import { driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { boardChoiceOf, boardChoices } from "@/lib/sim/lap-types";
import {
  challengeById,
  challengeConditionsLabel,
  isPermanentChallenge,
  timeLeftLabel,
  type TimeTrialEvent,
} from "@/lib/net/weekly-challenge";
import { CarThumb } from "@/components/menu/CarBrowser";
import { CarClassTag } from "@/components/menu/menu-content-ui";
import { TrackOutline, useCircuitOutline } from "@/components/menu/circuit-outline";
import { HallOfFame } from "@/components/board/HallOfFame";
import { DriverProfileModal } from "@/components/board/DriverProfileModal";
import { LapConditionBadges } from "@/components/board/LapConditionBadges";
import { BoardError, BoardSkeleton, BoardTable, MyPlace } from "@/components/hud/LeaderboardPanel";
import { Button, EmptyState, Modal, Select, TextField } from "@/components/ui";
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
  /** Accessible title for this event ("Weekly" or "Middle Gear Lap Board") */
  title: string;
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

/**
 * One complete Time Trial column: GT7-inspired event hero banner + compact rules & CTA at the top,
 * with its own live ranking board directly underneath it so each event's leaderboard stays paired
 * with its car and circuit.
 */
const TrialColumn: React.FC<{
  trial: ChallengeTrialItem;
  boardVersion: number;
  driverName: string;
  now: number;
  onDrive: () => void;
  onSelectDriver: (name: string) => void;
  onOpenBoard?: (trackId: string, vehicle: VehicleModelId) => void;
}> = ({ trial, boardVersion, driverName, now, onDrive, onSelectDriver, onOpenBoard }) => {
  const tx = useTranslations("menu.challenge");
  const units = useUnits();
  const { event } = trial;
  const permanent = isPermanentChallenge(event);
  const trackInfo = getTrackInfo(event.trackId);
  const venue = venueOf(event.trackId);
  const car = resolveTrialCar(event);
  const outline = useCircuitOutline(trackInfo, true, true);
  const [heroFailed, setHeroFailed] = useState(false);

  const [reload, setReload] = useState(0);
  const choices = boardChoices(event.trackId);
  const [boardPick, setBoardPick] = useState<string | null>(null);
  const choice = boardChoiceOf(event.trackId, boardPick);
  const older = !choice.current;
  const version = choice.base;
  const versionName = choice.label;

  const [state, setState] = useState<{ of: number; board: RemoteBoard | null; loading: boolean; error: boolean }>({
    of: version,
    board: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void trial.loadBoard(version).then((board) => {
      if (!live) return;
      setState((s) => ({
        of: version,
        board: board ?? (s.of === version ? s.board : null),
        loading: false,
        error: board === null,
      }));
    });
    return () => {
      live = false;
    };
  }, [trial, boardVersion, event.id, reload, version]);

  const board = state.of === version ? state.board : null;
  const loading = state.loading || state.of !== version;
  const myKey = driverNameKey(driverName);
  const me = board?.me ?? null;
  const ahead = me && me.rank >= 2 ? (board?.entries[me.rank - 2] ?? null) : null;
  const aboveMs = me && me.rank >= 2 ? (me.aboveMs ?? ahead?.lapTimeMs ?? null) : null;

  const trackLength = `\u2066${distanceIn(trackInfo.lengthM / 1000, units.speed).toFixed(2)}\u00a0${DISTANCE_LABEL[units.speed]}\u2069`;

  return (
    <section
      aria-label={trial.title}
      className={cx(
        "flex min-w-0 flex-col overflow-hidden rounded-lc-card border bg-lc-carbon/95",
        permanent ? "border-[#F5C542]/45" : "border-lc-volt/40"
      )}
    >
      {/* Top accent stripe */}
      <span
        aria-hidden
        className={cx(
          "h-1 w-full",
          permanent
            ? "bg-linear-to-r from-[#F5C542] via-amber-400 to-[#D98A4E]"
            : "bg-linear-to-r from-lc-volt via-lc-info to-lc-cyan"
        )}
      />

      {/* Event Hero Header */}
      <div className="relative flex flex-col gap-3 overflow-hidden px-4 pt-3.5 pb-4 sm:px-5">
        {venue && !heroFailed ? (
          <img
            src={withBasePath(venueHeroUrl(venue.id, 960))}
            alt=""
            aria-hidden
            onError={() => setHeroFailed(true)}
            className="pointer-events-none absolute inset-0 h-full w-full object-cover object-center opacity-28"
          />
        ) : null}
        <div
          aria-hidden
          className={cx(
            "pointer-events-none absolute inset-0",
            permanent
              ? "bg-linear-to-b from-lc-void/85 via-lc-void/90 to-lc-carbon"
              : "bg-linear-to-b from-lc-void/85 via-lc-void/90 to-lc-carbon"
          )}
        />

        {/* Status pills */}
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {permanent ? (
              <>
                <Badge size="sm" variant="solid" tone={{ color: "amber" }} icon="challenge">
                  {tx("middleGearBadge")}
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
          {permanent ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-lc-fog" title={tx("stigBadgeTitle")}>
              <span>{tx("stigEarn")}</span>
              <Badge size="sm" variant="solid" tone={{ color: "chalk" }} icon="helmet">
                {/* Latin letters with dots: left to right, or a right-to-left page shows ".S.T.I.G" */}
                <bdi dir="ltr">{tx("stigBadge")}</bdi>
              </Badge>
            </span>
          ) : (
            <span dir="ltr" className="lc-mono text-[11px] tracking-wider text-lc-slate uppercase">
              {event.id}
            </span>
          )}
        </div>

        {/* Circuit & Car visual showcase (consistent height across side-by-side columns so both CTAs and boards align) */}
        <div className="relative z-10 flex min-h-[96px] items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h3 className="lc-h3 m-0 line-clamp-2 text-[20px] leading-tight text-lc-chalk">{trial.trackName}</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {car ? <CarClassTag car={car} size="sm" /> : null}
              <span className="truncate text-[14px] font-semibold text-lc-fog">{trial.carTitle}</span>
            </div>
            <p className="lc-hint m-0 truncate">
              {[trackInfo.country, trackLength, tx("turns", { count: trackInfo.turns })].filter(Boolean).join(" · ")}
            </p>
          </div>

          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            {outline ? <TrackOutline map={outline} sectors className="h-[62px] w-[76px] shrink-0 opacity-90" /> : null}
            {car ? (
              <div className="relative h-[74px] w-[124px] shrink-0">
                <CarThumb car={car} className="drop-shadow-[0_6px_14px_rgba(0,0,0,0.75)]" />
              </div>
            ) : null}
          </div>
        </div>

        {/* Rules */}
        <div className="relative z-10 flex flex-wrap items-center gap-1.5" aria-label={tx("rules")}>
          <LapConditionBadges assists={event.assists} realism={event.realism} />
          <span className="lc-mono text-[12px] text-lc-fog">{challengeConditionsLabel(event.vehicle)}</span>
        </div>

        {/* Primary CTA */}
        <div className="relative z-10">
          {trial.available ? (
            <Button variant="primary" size="lg" block icon={<Icon name="drive" />} onClick={onDrive}>
              {tx("driveShort")}
            </Button>
          ) : (
            <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-caution">
              <Icon name="warning" className="mt-0.5" />
              {tx("unavailable")}
            </p>
          )}
        </div>
      </div>

      {/* Live Ranking Board directly beneath its own event card */}
      <div className="flex flex-1 flex-col gap-3 border-t border-lc-line bg-lc-well/35 px-4 pt-3.5 pb-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {choices.length <= 2 ? (
            <Segmented aria-label={tx("physicsVersion")} size="sm" value={choice.id} onChange={setBoardPick} options={choices} />
          ) : (
            <Select aria-label={tx("physicsVersion")} className="w-52 max-w-full" value={choice.id} onChange={setBoardPick} options={choices} />
          )}
          {board ? <Badge size="sm" variant="outline">{tx("drivers", { total: board.total, count: formatCount(board.total) })}</Badge> : null}
        </div>

        {me ? (
          <MyPlace
            rank={me.rank}
            total={board?.total ?? me.rank}
            lapMs={me.entry.lapTimeMs}
            detail={
              me.rank === 1
                ? permanent
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
            badgeContext={{ scope: "vehicle", vehicle: event.vehicle }}
            circuitName={formatCircuitName}
            onOpenRecordBoard={onOpenBoard}
            onSelectDriver={onSelectDriver}
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
      </div>
    </section>
  );
};

type ChallengeTab = "week" | "hof";

/**
 * Online Time Trials panel: side-by-side active event columns (Weekly Time Trial on the left,
 * permanent Middle Gear Lap Board on the right), each with its hero artwork, rules, Drive CTA,
 * and live ranking board directly underneath it, plus the Hall of Fame tab.
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
  const [tab, setTab] = useState<ChallengeTab>("week");
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

  if (trials.length === 0) return null;
  const myKey = driverNameKey(driverName);

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
        <div className={cx("grid grid-cols-1 items-start gap-4", trials.length > 1 && "xl:grid-cols-2")}>
          {trials.map((trial) => (
            <TrialColumn
              key={trial.event.id}
              trial={trial}
              boardVersion={boardVersion}
              driverName={driverName}
              now={now}
              onDrive={() => handleDriveClick(trial)}
              onSelectDriver={setProfileDriver}
              onOpenBoard={onOpenBoard}
            />
          ))}
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
