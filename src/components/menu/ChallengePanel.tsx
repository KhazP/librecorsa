"use client";

import React, { useEffect, useState } from "react";
import { boardLabel, driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { challengeConditionsLabel, timeLeftLabel, type WeeklyChallenge } from "@/lib/net/weekly-challenge";
import { BoardError, BoardSkeleton, BoardTable, MyPlace } from "@/components/hud/LeaderboardPanel";
import { Button, Card, EmptyState } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons";

export interface ChallengePanelProps {
  challenge: WeeklyChallenge;
  trackName: string;
  carTitle: string;
  /** This copy of the game has the week's circuit and car */
  available: boolean;
  /** Reads the week's board with the player's place on it; null when it can't be read */
  loadBoard: () => Promise<RemoteBoard | null>;
  /** Changes when the board may have changed (a lap went up) */
  boardVersion: number;
  driverName: string;
  /** Sets the game up to the week's rules and goes out on track */
  onDrive: () => void;
  /** Races on the week's circuit and car run on this site (they are entered from Multiplayer) */
  hasRaces?: boolean;
}

/** This week's challenge: its circuit, car and rules, the button that sets them up, and its board */
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
  const [state, setState] = useState<{ board: RemoteBoard | null; loading: boolean; error: boolean }>({ board: null, loading: true, error: false });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void loadBoard().then((board) => {
      if (live) setState((s) => ({ board: board ?? s.board, loading: false, error: board === null }));
    });
    return () => {
      live = false;
    };
  }, [loadBoard, boardVersion, challenge.id, reload]);

  const { board } = state;
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
        action={board ? <Badge variant="outline">{board.total === 1 ? "1 driver" : `${board.total} drivers`}</Badge> : null}
        bodyClassName="gap-3"
      >
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
        {state.loading && !board ? (
          <BoardSkeleton label="Loading this week's times" />
        ) : state.error && !board ? (
          <BoardError onRetry={() => setReload((n) => n + 1)}>Couldn&apos;t load this week&apos;s times. Check your connection.</BoardError>
        ) : !board || board.entries.length === 0 ? (
          <EmptyState icon={<Icon name="challenge" />}>No times yet this week. Drive the challenge and yours can be the first.</EmptyState>
        ) : (
          <BoardTable
            label="This week's times"
            rows={board.entries.map((e, i) => ({
              key: e.id ?? `${e.code}-${i}`,
              rank: i + 1,
              code: e.code,
              title: e.name,
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
