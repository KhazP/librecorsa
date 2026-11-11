"use client";

import React, { useEffect, useState } from "react";
import { countdownLabel, nextRaceSlot } from "@/lib/net/race-schedule";
import { fetchDriverRecord, fetchRaceWaiting, fetchWeekRaceResults, type DriverRecord, type RaceWaiting, type WeekStanding } from "@/lib/net/race-results";
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

const CARD = "flex min-w-0 flex-col gap-4 rounded-[22px] border border-[#262B3D] bg-[#08090D]/60 p-5 text-[#F5F7FA]";
const CHIP =
  "inline-flex h-7 shrink-0 items-center rounded-full px-3 font-f1-mono text-[11px] font-extrabold tracking-[0.06em] whitespace-nowrap text-[#C5CBD8] shadow-[inset_0_0_0_1px_#262B3D]";
/** How often the card asks who is waiting, while the player is not in the race */
const WAITING_POLL_MS = 15_000;

/** The scheduled races: where they are, when the next one starts, who is waiting for it, and the button to join */
export const RacesCard: React.FC<RacesCardProps> = ({ trackName, carTitle, slotS, laps, entry, entrants, driverName, onJoin, onLeave }) => {
  // The countdown ticks every second
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const entered = entry.state === "joined" && entry.startsMs !== null;
  const startsMs = entered && entry.startsMs !== null ? entry.startsMs : nextRaceSlot(now, slotS).startsMs;
  const every = slotS % 60 === 0 ? `${slotS / 60} min` : `${slotS} s`;
  const racing = entered && now >= startsMs;
  const results = useRaceResults(driverName, entry.state);
  // In the race, its lobby lists everyone; outside it, the race server is asked
  const waiting = useRaceWaiting(!entered, startsMs);
  const alone = entered && entrants.length <= 1;

  return (
    <section className={CARD} aria-label="Races">
      <div className="flex flex-col gap-1">
        <h3 className="lc-title m-0 min-w-0 text-[20px] leading-tight">{trackName}</h3>
        <span className="text-[14px] font-semibold text-[#C5CBD8]">
          {carTitle} · {laps} laps · every {every}
        </span>
      </div>

      <div className="flex items-baseline gap-3" aria-live="off">
        <span className="lc-data text-[44px] leading-none tabular-nums">{racing ? "GO" : countdownLabel(startsMs, now)}</span>
        <span className="text-[14px] font-semibold text-[#C5CBD8]">{racing ? "under way" : entered ? "until your race" : "until the next race"}</span>
      </div>

      {entered ? (
        <>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="In this race">
            {entrants.map((e) => (
              <li key={e.id} className={`${CHIP} ${e.me ? "!text-[#CCFF00] !shadow-[inset_0_0_0_1px_rgba(204,255,0,0.45)]" : ""}`}>
                {e.code} · {e.name}
              </li>
            ))}
          </ul>
          <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">
            You&apos;re in. It starts on its own{alone ? ", against the AI if nobody else joins" : ""}.
          </p>
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
          {waiting ? <WaitingLine waiting={waiting} /> : null}
          <button
            type="button"
            onClick={onJoin}
            disabled={entry.state === "joining"}
            onPointerEnter={focusOnHover}
            className="inline-flex h-12 cursor-pointer items-center justify-center rounded-full border-0 bg-[#00E5FF] px-5 text-[15px] font-bold text-[#08090D] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {entry.state === "joining" ? "Joining…" : "Join the next race"}
          </button>
          <p className="m-0 text-[13px] leading-snug text-[#8E96AA]">Same car for everyone. Your best challenge lap this week sets your grid slot.</p>
          {entry.state === "error" && entry.text ? (
            <p role="alert" className="m-0 text-[13px] font-semibold text-[#FFB300]">
              {entry.text}
            </p>
          ) : null}
        </>
      )}

      {results && (results.standings.length > 0 || (results.record?.starts ?? 0) > 0) ? (
        <RaceResultsLines standings={results.standings} record={results.record} />
      ) : null}
    </section>
  );
};

/** "2 drivers waiting: Al, Bea", or that nobody is yet */
const WaitingLine: React.FC<{ waiting: RaceWaiting }> = ({ waiting: w }) => {
  const shown = w.names.slice(0, 3);
  const more = w.waiting - shown.length;
  return (
    <p className="m-0 flex items-center gap-2.5 text-[14px] leading-snug" aria-live="polite">
      <span className="relative inline-flex h-2 w-2 shrink-0">
        {w.waiting > 0 ? <span className="lc-ping absolute inset-0 rounded-full bg-[#00E676]" /> : null}
        <span className={`relative h-2 w-2 rounded-full ${w.waiting > 0 ? "bg-[#00E676]" : "bg-[#3A4157]"}`} />
      </span>
      {w.waiting === 0 ? (
        <span className="text-[#8E96AA]">Nobody waiting yet</span>
      ) : (
        <span className="min-w-0 text-[#C5CBD8]">
          <span className="font-semibold text-[#F5F7FA]">{plural(w.waiting, "driver", "drivers")} waiting</span>
          {shown.length > 0 ? `: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : ""}
        </span>
      )}
    </p>
  );
};

/** Who is waiting for the next race, asked again every few seconds while `active` and when the race changes */
function useRaceWaiting(active: boolean, startsMs: number): RaceWaiting | null {
  const [waiting, setWaiting] = useState<RaceWaiting | null>(null);
  useEffect(() => {
    if (!active) return setWaiting(null);
    let live = true;
    const ask = () =>
      void fetchRaceWaiting().then((w) => {
        if (live) setWaiting(w);
      });
    ask();
    const id = window.setInterval(ask, WAITING_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [active, startsMs]);
  return waiting;
}

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
  <div className="flex flex-col gap-1.5 border-t border-[#262B3D] pt-4">
    <h4 className="m-0 text-[14px] font-semibold text-[#F5F7FA]">This week&apos;s top drivers</h4>
    {standings.length === 0 ? null : (
      <ol className="m-0 flex list-none flex-col gap-0.5 p-0">
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
