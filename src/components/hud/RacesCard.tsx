"use client";

import React, { useEffect, useState } from "react";
import { countdownLabel, nextRaceSlot } from "@/lib/net/race-schedule";
import { fetchDriverRecord, fetchRaceWaiting, fetchWeekRaceResults, type DriverRecord, type RaceWaiting, type WeekStanding } from "@/lib/net/race-results";
import { challengeAt } from "@/lib/net/weekly-challenge";
import type { ScheduledRaceStatus } from "@/lib/sim/multiplayer-sync";
import { Button, Card } from "@/components/ui";
import { Badge, StatusDot } from "@/components/ui/Badge";
import { PositionBadge } from "@/components/ui/badges";
import { Icon } from "@/components/ui/icons";

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
    <Card title={trackName} description={`${carTitle} · ${laps} laps · every ${every}`} bodyClassName="gap-4" aria-label="Races">
      <div className="flex items-baseline gap-3" aria-live="off">
        <span className="lc-mono text-[44px] leading-none font-bold">{racing ? "Go" : countdownLabel(startsMs, now)}</span>
        <span className="lc-body">{racing ? "under way" : entered ? "until your race" : "until the next race"}</span>
      </div>

      {entered ? (
        <>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="In this race">
            {entrants.map((e) => (
              <li key={e.id}>
                <Badge tone={e.me ? "player" : "neutral"} variant={e.me ? "outline" : "soft"}>
                  {e.code} · {e.name}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="lc-hint m-0">You&apos;re in. It starts on its own{alone ? ", against the AI if nobody else joins" : ""}.</p>
          <Button variant="secondary" className="self-start" onClick={onLeave}>
            Leave the race
          </Button>
        </>
      ) : (
        <>
          {waiting ? <WaitingLine waiting={waiting} /> : null}
          <Button variant="primary" block loading={entry.state === "joining"} onClick={onJoin}>
            Join the next race
          </Button>
          <p className="lc-hint m-0">Same car for everyone. Your best challenge lap this week sets your grid slot.</p>
          {entry.state === "error" && entry.text ? (
            <p role="alert" className="m-0 flex items-start gap-2 text-[13px] leading-snug font-medium text-lc-loss">
              <Icon name="error" size="xs" className="mt-0.5" />
              {entry.text}
            </p>
          ) : null}
        </>
      )}

      {results && (results.standings.length > 0 || (results.record?.starts ?? 0) > 0) ? (
        <RaceResultsLines standings={results.standings} record={results.record} />
      ) : null}
    </Card>
  );
};

/** "2 drivers waiting: Al, Bea", or that nobody is yet */
const WaitingLine: React.FC<{ waiting: RaceWaiting }> = ({ waiting: w }) => {
  const shown = w.names.slice(0, 3);
  const more = w.waiting - shown.length;
  return (
    <p className="m-0 flex items-center gap-2.5 text-[14px] leading-snug" aria-live="polite">
      <StatusDot tone={w.waiting > 0 ? "good" : "neutral"} live={w.waiting > 0} />
      {w.waiting === 0 ? (
        <span className="text-lc-slate">Nobody waiting yet</span>
      ) : (
        <span className="min-w-0 text-lc-fog">
          <span className="font-semibold text-lc-chalk">{plural(w.waiting, "driver", "drivers")} waiting</span>
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
  <div className="flex flex-col gap-2 border-t border-lc-line pt-4">
    <h4 className="lc-row-label m-0">This week&apos;s top drivers</h4>
    {standings.length === 0 ? null : (
      <ol className="m-0 flex list-none flex-col p-0">
        {standings.slice(0, 5).map((s, i) => (
          <li key={`${s.name}-${i}`} className="flex h-9 items-center justify-between gap-3 border-b border-white/5 last:border-b-0">
            <span className="flex min-w-0 items-center gap-2.5">
              <PositionBadge position={i + 1} size="sm" className="min-w-10" />
              <span className="truncate text-[14px] font-semibold">{s.name}</span>
            </span>
            <span className="lc-mono shrink-0 text-[12px] font-bold text-lc-fog">
              {plural(s.wins, "win", "wins")} · {plural(s.podiums, "podium", "podiums")}
            </span>
          </li>
        ))}
      </ol>
    )}
    {record && record.starts > 0 ? (
      <p className="lc-hint m-0">
        You: {plural(record.starts, "race", "races")} · {plural(record.wins, "win", "wins")} · {plural(record.podiums, "podium", "podiums")}
        {record.bestFinish !== null ? ` · best P${record.bestFinish}` : ""}
      </p>
    ) : null}
  </div>
);
