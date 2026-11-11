"use client";

import React, { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { boardLabel, driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { challengeConditionsLabel, timeLeftLabel, type WeeklyChallenge } from "@/lib/net/weekly-challenge";
import { formatLapTime } from "@/components/hud/hud-format";
import { focusOnHover } from "@/components/menu/useFocusNav";

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

const CARD = "flex min-w-0 flex-col gap-3.5 rounded-[22px] border border-[#262B3D] bg-[#08090D]/60 p-[18px] text-[#F5F7FA]";
const CHIP =
  "inline-flex h-7 shrink-0 items-center rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.06em] whitespace-nowrap text-[#C5CBD8] shadow-[inset_0_0_0_1px_#262B3D]";

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
  }, [loadBoard, boardVersion, challenge.id]);

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
    <div className="grid items-start gap-[22px] grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]">
      <section className={CARD} aria-label="This week">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="lc-title text-[26px] leading-tight">{trackName}</span>
            <span className="text-[15px] font-semibold text-[#C5CBD8]">{carTitle}</span>
          </div>
          <span className={CHIP}>{timeLeftLabel(challenge.endsMs, now)} left</span>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Rules">
          {rules.map((r) => (
            <span key={r} className={CHIP}>
              {r === "Full" || r === "Standard" || r === "Casual" ? `${r} realism` : r}
            </span>
          ))}
        </div>
        <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">
          Same circuit, car and settings for everyone, until Monday. Flying laps: leave the track and the lap is deleted,
          and the next one too if it was before the line. Your best lap goes on the week&apos;s board by itself.
          {hasRaces && available ? " To race others this week, open Multiplayer." : ""}
        </p>
        {available ? (
          <button
            type="button"
            onClick={onDrive}
            onPointerEnter={focusOnHover}
            className="inline-flex h-14 cursor-pointer items-center justify-center gap-3 rounded-full border-0 bg-[#CCFF00] text-[#08090D] shadow-[0_0_0_5px_rgba(204,255,0,0.12),0_14px_34px_rgba(204,255,0,0.2)] transition-colors hover:bg-[#d9ff33]"
          >
            <Play aria-hidden className="h-[18px] w-[18px]" fill="currentColor" strokeWidth={0} />
            <span className="lc-disp text-[22px]">Drive the challenge</span>
          </button>
        ) : (
          <p className="m-0 rounded-[14px] border border-[#FFB300]/40 bg-[#FFB300]/[0.08] px-3.5 py-2.5 text-[13px] font-semibold text-[#FFB300]">
            This copy of the game doesn&apos;t have this week&apos;s circuit or car. Play it on librecorsa.org.
          </p>
        )}
      </section>

      <section className={CARD} aria-label="This week's times">
        <div className="flex items-center justify-between gap-2">
          <span className="lc-lbl">This week&apos;s times</span>
          {board ? <span className="text-[12px] text-[#8E96AA]">{board.total === 1 ? "1 driver" : `${board.total} drivers`}</span> : null}
        </div>
        {me ? (
          <div className="flex flex-col rounded-[14px] border border-[#CCFF00]/30 bg-[#CCFF00]/[0.05] px-3.5 py-2.5">
            <span className="text-[14px] font-bold">
              You are <span className="lc-data text-[#CCFF00]">P{me.rank}</span> of {board?.total ?? me.rank}
              <span className="lc-data ml-2 text-[#C5CBD8]">{formatLapTime(me.entry.lapTimeMs)}</span>
            </span>
            <span className="text-[12px] text-[#8E96AA]">
              {me.rank === 1
                ? "Fastest this week"
                : aboveMs !== null
                  ? `${((me.entry.lapTimeMs - aboveMs) / 1000).toFixed(3)} s behind ${ahead && ahead.lapTimeMs === aboveMs ? ahead.name : `P${me.rank - 1}`}`
                  : ""}
            </span>
          </div>
        ) : null}
        {state.loading && !board ? (
          <p className="m-0 text-[13px] text-[#8E96AA]">Loading this week&apos;s times…</p>
        ) : state.error && !board ? (
          <p role="alert" className="m-0 text-[13px] text-[#FF2A3C]">
            Couldn&apos;t load this week&apos;s times. Check your connection.
          </p>
        ) : !board || board.entries.length === 0 ? (
          <p className="m-0 text-[13px] text-[#8E96AA]">No times yet this week. Yours can be the first.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
            {board.entries.map((e, i) => {
              const mine = myKey !== "" && driverNameKey(e.name) === myKey;
              return (
                <li
                  key={e.id ?? `${e.code}-${i}`}
                  aria-current={mine ? "true" : undefined}
                  className={`grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] px-3 py-2 ${
                    mine ? "bg-[#CCFF00]/[0.07] shadow-[inset_0_0_0_1px_rgba(204,255,0,0.35)]" : ""
                  }`}
                >
                  <span className={`lc-data text-[14px] ${mine ? "text-[#CCFF00]" : "text-[#8E96AA]"}`}>{i + 1}</span>
                  <span className="truncate text-[14px] font-bold">
                    <span className="font-f1-mono tracking-[0.1em]">{e.code}</span> · {e.name}
                    {mine ? <span className="font-normal text-[#8E96AA]"> (you)</span> : null}
                  </span>
                  <span className="lc-data text-[15px]">{formatLapTime(e.lapTimeMs)}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
};
