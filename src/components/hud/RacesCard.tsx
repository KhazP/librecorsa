"use client";

import React, { useEffect, useState } from "react";
import { countdownLabel, nextRaceSlot } from "@/lib/net/race-schedule";
import { fetchDriverRecord, fetchWeekRaceResults, type DriverRecord, type WeekStanding } from "@/lib/net/race-results";
import { challengeAt } from "@/lib/net/weekly-challenge";
import type { ScheduledRaceStatus } from "@/lib/sim/multiplayer-sync";
import { focusOnHover } from "@/components/menu/useFocusNav";

export interface RacesCardProps {
  /** The circuit and car every race of this week is on */
  trackName: string;
  carTitle: string;
  /** Seconds between races */
  slotS: number;
  laps: number;
  /** This player's entry in the next one */
  entry: ScheduledRaceStatus;
  /** Who is in the race this player entered */
  entrants: { id: string; name: string; code: string; me: boolean }[];
  /** The name the player races under: their record is shown by it */
  driverName?: string;
  onJoin: () => void;
  onLeave: () => void;
}

const CARD = "flex min-w-0 flex-col gap-3.5 rounded-[22px] border border-[#262B3D] bg-[#08090D]/60 p-[18px] text-[#F5F7FA]";
const CHIP =
  "inline-flex h-7 shrink-0 items-center rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.06em] whitespace-nowrap text-[#C5CBD8] shadow-[inset_0_0_0_1px_#262B3D]";

/** The scheduled races: where they are, when the next one starts, the button to enter it, and who else has */
export const RacesCard: React.FC<RacesCardProps> = ({ trackName, carTitle, slotS, laps, entry, entrants, driverName, onJoin, onLeave }) => {
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
  const results = useRaceResults(driverName, entry.state);

  return (
    <section className={CARD} aria-label="Races">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="lc-lbl text-[#00E5FF]">Open races</span>
        <span className={CHIP}>
          {laps} laps · every {every}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="lc-title text-[20px] leading-tight">{trackName}</span>
        <span className="text-[14px] font-semibold text-[#C5CBD8]">{carTitle}</span>
      </div>
      <div className="flex items-baseline gap-3" aria-live="off">
        <span className="lc-data text-[40px] leading-none tabular-nums">{racing ? "GO" : countdownLabel(startsMs, now)}</span>
        <span className="text-[14px] font-semibold text-[#C5CBD8]">
          {racing ? "Your race is under way" : entered ? "until your race" : "until the next race"}
        </span>
      </div>
      {results ? <RaceResultsLines standings={results.standings} record={results.record} /> : null}
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
            Anyone can join. Everyone races the same car with the weekly challenge&apos;s settings, and your best challenge
            lap this week sets your grid place.
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

/** The week's top drivers and the player's own record, read again when the player's entry changes (after a race) */
function useRaceResults(driverName: string | undefined, entryState: ScheduledRaceStatus["state"]) {
  const [results, setResults] = useState<{ standings: WeekStanding[]; record: DriverRecord | null } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([fetchWeekRaceResults(challengeAt(Date.now()).id), driverName ? fetchDriverRecord(driverName) : Promise.resolve(null)]).then(
      ([week, record]) => {
        if (live) setResults(week ? { standings: week.standings, record } : null);
      }
    );
    return () => {
      live = false;
    };
  }, [driverName, entryState]);
  return results;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** This week's top five by wins then podiums, and the player's record in one line */
const RaceResultsLines: React.FC<{ standings: WeekStanding[]; record: DriverRecord | null }> = ({ standings, record }) => (
  <div className="flex flex-col gap-1.5">
    <span className="lc-lbl text-[#8E96AA]">This week</span>
    {standings.length === 0 ? (
      <p className="m-0 text-[13px] text-[#8E96AA]">No race results yet.</p>
    ) : (
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0" aria-label="This week's top drivers">
        {standings.slice(0, 5).map((s, i) => (
          <li key={`${s.name}-${i}`} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate font-semibold">
              <span className="font-f1-mono text-[#8E96AA] tabular-nums">{i + 1}</span> {s.name}
            </span>
            <span className="shrink-0 font-f1-mono text-[12px] text-[#C5CBD8] tabular-nums">
              {plural(s.wins, "win", "wins")} · {plural(s.podiums, "podium", "podiums")}
            </span>
          </li>
        ))}
      </ol>
    )}
    {record && record.starts > 0 ? (
      <p className="m-0 text-[13px] text-[#C5CBD8]">
        You: {plural(record.starts, "race", "races")} · {plural(record.wins, "win", "wins")} · {plural(record.podiums, "podium", "podiums")}
        {record.bestFinish !== null ? ` · best P${record.bestFinish}` : ""}
      </p>
    ) : null}
  </div>
);
