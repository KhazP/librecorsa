"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import { anyCarById, anyCarForVehicle, type CarId } from "@/lib/cars/car-registry";
import { carBoardTag } from "@/lib/cars/board-tag";
import { isVehicleModelId, type VehicleModelId } from "@/types/f1";
import { TRACKS, venueOf } from "@/lib/track-registry";
import { driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { boardChoiceOf, boardChoices } from "@/lib/sim/lap-types";
import { challengeById, challengeConditionsLabel, timeLeftLabel, type WeeklyChallenge } from "@/lib/net/weekly-challenge";
import { HallOfFame } from "@/components/board/HallOfFame";
import { DriverProfileModal } from "@/components/board/DriverProfileModal";
import { LapConditionBadges } from "@/components/board/LapConditionBadges";
import { BoardError, BoardSkeleton, BoardTable, MyPlace } from "@/components/hud/LeaderboardPanel";
import { Button, Card, EmptyState, Modal, Select, TextField } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Icon } from "@/components/ui/icons";
import { formatCount } from "@/lib/net/board-client";
import { sanitizeDriverName } from "@/lib/settings/player-settings";

export interface ChallengePanelProps {
  challenge: WeeklyChallenge;
  trackName: string;
  carTitle: string;
  /** This copy of the game has the week's circuit and car */
  available: boolean;
  /**
   * Reads the week's board of base revision `version` (lap-types.ts `BoardChoice`) with the player's place on it; null
   * when it can't be read
   */
  loadBoard: (version: number) => Promise<RemoteBoard | null>;
  /** Changes when the board may have changed (a lap went up) */
  boardVersion: number;
  driverName: string;
  /** True while the player still only has an auto-generated default name */
  driverNameGenerated?: boolean;
  /** Claims / updates the driver name (returns an error string if rejected, or null on success) */
  onRenameDriver?: (name: string) => Promise<string | null>;
  /** Explicitly keeps the current auto-generated name so the prompt does not repeat */
  onConfirmDriverName?: () => void;
  /** Sets the game up to the week's rules and goes out on track */
  onDrive: () => void;
  /** Races on the week's circuit and car run on this site (they are entered from Multiplayer) */
  hasRaces?: boolean;
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

type ChallengeTab = "week" | "hof";

/**
 * This week's challenge: its circuit, car and rules, the button that sets them up, and its board, under the physics
 * driven now or an older version's laps kept as they were, plus the Hall of Fame of completed weeks.
 */
export const ChallengePanel: React.FC<ChallengePanelProps> = ({
  challenge,
  trackName,
  carTitle,
  available,
  loadBoard,
  boardVersion,
  driverName,
  driverNameGenerated = false,
  onRenameDriver,
  onConfirmDriverName,
  onDrive,
  hasRaces = false,
  onOpenBoard,
}) => {
  const tx = useTranslations("menu.challenge");
  const [tab, setTab] = useState<ChallengeTab>("week");
  const [profileDriver, setProfileDriver] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<"drive" | "edit" | null>(null);
  const [nameDraft, setNameDraft] = useState(driverName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaving, setNameSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const openNamePrompt = (mode: "drive" | "edit") => {
    setNameDraft(driverName);
    setNameError(null);
    setNameSaving(false);
    setNameModal(mode);
  };

  const handleDriveClick = () => {
    if (driverNameGenerated && (onRenameDriver || onConfirmDriverName)) {
      openNamePrompt("drive");
      return;
    }
    onDrive();
  };

  const handleKeepName = () => {
    const proceed = nameModal === "drive";
    onConfirmDriverName?.();
    setNameModal(null);
    if (proceed) onDrive();
  };

  const handleSaveName = async () => {
    const proceed = nameModal === "drive";
    const cleaned = sanitizeDriverName(nameDraft);
    if (cleaned === driverName) {
      handleKeepName();
      return;
    }
    if (!onRenameDriver) {
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
    if (proceed) onDrive();
  };

  const [reload, setReload] = useState(0);
  // The board picked (lap-types.ts `BoardChoice`): the one laps go on now, or one kept from before an update
  const choices = boardChoices(challenge.trackId);
  const [boardPick, setBoardPick] = useState<string | null>(null);
  const choice = boardChoiceOf(challenge.trackId, boardPick);
  const older = !choice.current;
  const version = choice.base;
  const versionName = choice.label;
  // The board read, and under which physics version: another version's is never shown under this one's picker
  const [state, setState] = useState<{ of: number; board: RemoteBoard | null; loading: boolean; error: boolean }>({ of: version, board: null, loading: true, error: false });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void loadBoard(version).then((board) => {
      if (live) setState((s) => ({ of: version, board: board ?? (s.of === version ? s.board : null), loading: false, error: board === null }));
    });
    return () => {
      live = false;
    };
  }, [loadBoard, boardVersion, challenge.id, reload, version]);

  const board = state.of === version ? state.board : null;
  const loading = state.loading || state.of !== version;
  const myKey = driverNameKey(driverName);
  const me = board?.me ?? null;
  const ahead = me && me.rank >= 2 ? (board?.entries[me.rank - 2] ?? null) : null;
  // The time of the place above, when the board lists only the places further up
  const aboveMs = me && me.rank >= 2 ? (me.aboveMs ?? ahead?.lapTimeMs ?? null) : null;

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        aria-label={tx("view")}
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { id: "week", label: tx("thisWeek") },
          { id: "hof", label: tx("hallOfFame") },
        ]}
        className="self-start"
      />
      {tab === "hof" ? (
        <HallOfFame
          circuitName={formatCircuitName}
          carName={formatCarName}
          driverName={driverName}
          refreshKey={boardVersion}
          onOpenBoard={onOpenBoard}
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-start gap-3">
          <Card
            title={trackName}
            description={carTitle}
            action={
              <Badge icon="time" variant="outline">
                {tx("timeLeft", { timeLeft: timeLeftLabel(challenge.endsMs, now) })}
              </Badge>
            }
            bodyClassName="gap-3.5"
          >
            <div className="flex flex-wrap items-center gap-1.5" aria-label={tx("rules")}>
              <LapConditionBadges assists={challenge.assists} realism={challenge.realism} />
              <span className="lc-mono text-[12px] text-lc-fog">{challengeConditionsLabel(challenge.vehicle)}</span>
            </div>
            <p className="lc-hint m-0">{hasRaces && available ? tx("aboutWithRaces") : tx("about")}</p>
            {driverName ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lc-row border border-lc-line bg-lc-well/60 px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-lc-fog">
                  {tx.rich("postingAs", {
                    name: driverName,
                    b: (chunks) => <span className="font-semibold text-lc-chalk">{chunks}</span>,
                  })}
                </span>
                {onRenameDriver ? (
                  <Button size="sm" variant="ghost" onClick={() => openNamePrompt("edit")}>
                    {tx("changeName")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {available ? (
              <Button variant="primary" size="lg" block icon={<Icon name="drive" />} onClick={handleDriveClick}>
                {tx("drive")}
              </Button>
            ) : (
              <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-caution">
                <Icon name="warning" className="mt-0.5" />
                {tx("unavailable")}
              </p>
            )}
          </Card>

          <Card
            title={tx("times")}
            action={board ? <Badge variant="outline">{tx("drivers", { total: board.total, count: formatCount(board.total) })}</Badge> : null}
            bodyClassName="gap-3"
          >
            {choices.length <= 2 ? (
              <Segmented aria-label={tx("physicsVersion")} size="sm" value={choice.id} onChange={setBoardPick} options={choices} className="self-start" />
            ) : (
              <Select aria-label={tx("physicsVersion")} className="w-64 max-w-full self-start" value={choice.id} onChange={setBoardPick} options={choices} />
            )}
            {me ? (
              <MyPlace
                rank={me.rank}
                total={board?.total ?? me.rank}
                lapMs={me.entry.lapTimeMs}
                detail={
                  me.rank === 1
                    ? tx("fastest")
                    : aboveMs !== null
                      ? ahead && ahead.lapTimeMs === aboveMs
                        ? tx("behindDriver", { gap: ((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3), driver: ahead.name })
                        : tx("behindPlace", { gap: ((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3), place: String(me.rank - 1) })
                      : ""
                }
              />
            ) : null}
            {loading && !board ? (
              <BoardSkeleton label={tx("loadingTimes")} />
            ) : state.error && !board ? (
              <BoardError onRetry={() => setReload((n) => n + 1)}>{tx("loadFailed")}</BoardError>
            ) : !board || board.entries.length === 0 ? (
              <EmptyState icon={<Icon name="challenge" />}>
                {older ? tx("noTimesVersion", { version: versionName }) : tx("noTimes")}
              </EmptyState>
            ) : (
              <BoardTable
                label={older ? tx("tableLabelVersion", { version: versionName }) : tx("tableLabel")}
                badgeContext={{ scope: "vehicle", vehicle: challenge.vehicle }}
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
        <p className="lc-body m-0 text-lc-fog">{tx("namePrompt.body")}</p>
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
            {nameModal === "drive" && sanitizeDriverName(nameDraft) !== driverName ? (
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
                : nameModal === "drive"
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
