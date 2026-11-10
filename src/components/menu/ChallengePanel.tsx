"use client";

import React, { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { boardLabel, driverNameKey, type RemoteBoard } from "@/lib/net/leaderboard";
import { countdownLabel, nextRaceSlot } from "@/lib/net/race-schedule";
import { timeLeftLabel, type WeeklyChallenge } from "@/lib/net/weekly-challenge";
import type { ScheduledRaceStatus } from "@/lib/sim/multiplayer-sync";
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
  /** The week's scheduled races (only where they run) */
  races?: {
    /** Seconds between races */
    slotS: number;
    laps: number;
    /** This player's entry in the next one */
    entry: ScheduledRaceStatus;
    /** Who is in the race this player entered */
    entrants: { id: string; name: string; code: string; me: boolean }[];
    onJoin: () => void;
    onLeave: () => void;
  };
}

/** The scheduled races: when the next one starts, the button to enter it, and who else has */
const RacesCard: React.FC<NonNullable<ChallengePanelProps["races"]>> = ({ slotS, laps, entry, entrants, onJoin, onLeave }) => {
  // The countdown ticks every second
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const entered = entry.state === "joined" && entry.startsMs !== null;
  const startsMs = entered && entry.startsMs !== null ? entry.startsMs : nextRaceSlot(now, slotS).startsMs;
  const every = slotS % 60 === 0 ? `${slotS / 60} minutes` : `${slotS} seconds`;
  const racing = entered && now >= startsMs;

  return (
    <section className={CARD} aria-label="Races">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="lc-lbl text-[#00E5FF]">Races</span>
        <span className={CHIP}>
          {laps} laps · every {every}
        </span>
      </div>
      <div className="flex items-baseline gap-3" aria-live="off">
        <span className="lc-data text-[40px] leading-none tabular-nums">{racing ? "GO" : countdownLabel(startsMs, now)}</span>
        <span className="text-[14px] font-semibold text-[#C5CBD8]">
          {racing ? "Your race is under way" : entered ? "until your race" : "until the next race"}
        </span>
      </div>
      {entered ? (
        <>
          <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">
            You&apos;re in. Stay here or go out and practise: the race starts by itself, with this week&apos;s fastest on pole.
            {entrants.length <= 1 ? " If nobody else joins, you race the AI." : ""}
          </p>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="In this race">
            {entrants.map((e) => (
              <li key={e.id} className={`${CHIP} ${e.me ? "!text-[#CCFF00] !shadow-[inset_0_0_0_1px_rgba(204,255,0,0.45)]" : ""}`}>
                {e.code} · {e.name}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onLeave}
            onPointerEnter={focusOnHover}
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center self-start rounded-full border border-[#262B3D] bg-[#1B1F2B] px-4 text-[14px] font-bold text-[#F5F7FA] hover:border-[#3A4157] hover:bg-[#262B3D]"
          >
            Leave the race
          </button>
        </>
      ) : (
        <>
          <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">
            Everyone who joins races together on this week&apos;s circuit and car, to its rules. Your best lap this week sets
            your grid place.
          </p>
          <button
            type="button"
            onClick={onJoin}
            disabled={entry.state === "joining"}
            onPointerEnter={focusOnHover}
            className="inline-flex h-12 cursor-pointer items-center justify-center rounded-full border-0 bg-[#00E5FF] px-5 text-[15px] font-bold text-[#08090D] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {entry.state === "joining" ? "Joining…" : "Join the next race"}
          </button>
          {entry.state === "error" && entry.text ? (
            <p role="alert" className="m-0 text-[13px] font-semibold text-[#FFB300]">
              {entry.text}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
};

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
  races,
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
  const rules = boardLabel({ assists: challenge.assists, realism: challenge.realism, surface: "dry" }).split(" · ");

  return (
    <div className="grid items-start gap-[22px] grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))]">
      <section className={CARD} aria-label="This week">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="lc-lbl text-[#CCFF00]">This week</span>
          <span className={CHIP}>{timeLeftLabel(challenge.endsMs, now)} left</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="lc-title text-[26px] leading-tight">{trackName}</span>
          <span className="text-[15px] font-semibold text-[#C5CBD8]">{carTitle}</span>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Rules">
          {rules.map((r) => (
            <span key={r} className={CHIP}>
              {r === "Dry" ? "Dry track" : r === "Full" || r === "Standard" || r === "Casual" ? `${r} realism` : r}
            </span>
          ))}
        </div>
        <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">
          Same circuit, car and settings for everyone, until Monday. Every lap you finish to these rules counts, and your
          best one goes on the week&apos;s board by itself.
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

      {races && available ? <RacesCard {...races} /> : null}

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
              {me.rank === 1 ? "Fastest this week" : ahead ? `${((me.entry.lapTimeMs - ahead.lapTimeMs) / 1000).toFixed(3)} s behind ${ahead.name}` : ""}
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
