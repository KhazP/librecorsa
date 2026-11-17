"use client";

import React, { useEffect, useState } from "react";
import { boardLabel, driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { boardChoiceOf, boardChoices, PHYSICS_VERSION } from "@/lib/sim/lap-types";
import { challengeConditionsLabel, timeLeftLabel, type WeeklyChallenge } from "@/lib/net/weekly-challenge";
import { BoardError, BoardSkeleton, BoardTable, MyPlace } from "@/components/hud/LeaderboardPanel";
import { Button, Card, EmptyState, Select } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Icon } from "@/components/ui/icons";
import { formatCount } from "@/lib/net/board-client";

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
  /** Sets the game up to the week's rules and goes out on track */
  onDrive: () => void;
  /** Races on the week's circuit and car run on this site (they are entered from Multiplayer) */
  hasRaces?: boolean;
}

/**
 * This week's challenge: its circuit, car and rules, the button that sets them up, and its board, under the physics
 * driven now or an older version's laps kept as they were
 */
export const ChallengePanel: React.FC<ChallengePanelProps> = ({
  challenge,
  trackName,
  carTitle,
  available,
  loadBoard,
  boardVersion,
  driverName,
  onDrive,
  hasRaces = false,
}) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
  // Assists and realism, then the fixed conditions: "Dry track · Soft tyres · Low fuel"
  const rules = [
    ...boardLabel({ assists: challenge.assists, realism: challenge.realism, surface: "dry" }).split(" · ").slice(0, 2),
    ...challengeConditionsLabel(challenge.vehicle).split(" · "),
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-start gap-3">
      <Card
        title={trackName}
        description={carTitle}
        action={
          <Badge icon="time" variant="outline">
            {timeLeftLabel(challenge.endsMs, now)} left
          </Badge>
        }
        bodyClassName="gap-3.5"
      >
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Rules">
          {rules.map((r) => (
            <li key={r}>
              <Badge>{r === "Full" || r === "Standard" || r === "Casual" ? `${r} realism` : r}</Badge>
            </li>
          ))}
        </ul>
        <p className="lc-body m-0">
          Same circuit, car and settings for everyone, until Monday. Flying laps: leave the track and the lap is deleted,
          and the next one too if it was before the line. Your best lap goes on the week&apos;s board by itself.
          {hasRaces && available ? " To race others this week, open Multiplayer." : ""}
        </p>
        {available ? (
          <Button variant="primary" size="lg" block icon={<Icon name="drive" />} onClick={onDrive}>
            Drive the challenge
          </Button>
        ) : (
          <p className="m-0 flex items-start gap-2 text-[14px] leading-snug font-medium text-lc-caution">
            <Icon name="warning" className="mt-0.5" />
            This copy of the game doesn&apos;t have this week&apos;s circuit or car. Play it on librecorsa.org.
          </p>
        )}
      </Card>

      <Card
        title="This week's times"
        action={board ? <Badge variant="outline">{board.total === 1 ? "1 driver" : `${formatCount(board.total)} drivers`}</Badge> : null}
        bodyClassName="gap-3"
      >
        {choices.length <= 2 ? (
          <Segmented aria-label="Physics version" size="sm" value={choice.id} onChange={setBoardPick} options={choices} className="self-start" />
        ) : (
          <Select aria-label="Physics version" className="w-64 max-w-full self-start" value={choice.id} onChange={setBoardPick} options={choices} />
        )}
        {older ? (
          <p className="lc-hint m-0">
            {choice.physics !== PHYSICS_VERSION ? "I kept these laps from before the physics update." : "I kept these laps from before I changed this circuit."}
          </p>
        ) : null}
        {me ? (
          <MyPlace
            rank={me.rank}
            total={board?.total ?? me.rank}
            lapMs={me.entry.lapTimeMs}
            detail={
              me.rank === 1
                ? "Fastest this week"
                : aboveMs !== null
                  ? `${((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3)} s behind ${ahead && ahead.lapTimeMs === aboveMs ? ahead.name : `P${me.rank - 1}`}`
                  : ""
            }
          />
        ) : null}
        {loading && !board ? (
          <BoardSkeleton label="Loading this week's times" />
        ) : state.error && !board ? (
          <BoardError onRetry={() => setReload((n) => n + 1)}>Couldn&apos;t load this week&apos;s times. Check your connection.</BoardError>
        ) : !board || board.entries.length === 0 ? (
          <EmptyState icon={<Icon name="challenge" />}>
            {older ? `No times this week on ${versionName}.` : "No times yet this week. Drive the challenge and yours can be the first."}
          </EmptyState>
        ) : (
          <BoardTable
            label={older ? `This week's times, ${versionName}` : "This week's times"}
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
  );
};
