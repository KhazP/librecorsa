"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
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
  const tx = useTranslations("hud.racesCard");
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

  const countdown = {
    big: (chunks: React.ReactNode) => <span className="lc-mono text-[44px] leading-none font-bold">{chunks}</span>,
    small: (chunks: React.ReactNode) => <span className="lc-body">{chunks}</span>,
  };

  return (
    <Card title={trackName} description={tx("description", { car: carTitle, laps, interval: every })} bodyClassName="gap-4" aria-label={tx("region")}>
      <div className="flex items-baseline gap-3" aria-live="off">
        {racing
          ? tx.rich("racing", countdown)
          : tx.rich(entered ? "toStart" : "toNextRace", { ...countdown, time: countdownLabel(startsMs, now) })}
      </div>

      {entered ? (
        <>
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={tx("entrants")}>
            {entrants.map((e) => (
              <li key={e.id}>
                <Badge tone={e.me ? "player" : "neutral"} variant={e.me ? "outline" : "soft"}>
                  {e.code} · {e.name}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="lc-hint m-0">{tx(alone ? "enteredAlone" : "entered")}</p>
          <Button variant="secondary" className="self-start" onClick={onLeave}>
            {tx("leave")}
          </Button>
        </>
      ) : (
        <>
          {waiting ? <WaitingLine waiting={waiting} /> : null}
          <Button variant="primary" block loading={entry.state === "joining"} onClick={onJoin}>
            {tx("join")}
          </Button>
          <p className="lc-hint m-0">{tx("rules")}</p>
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
  const tx = useTranslations("hud.racesCard");
  const shown = w.names.slice(0, 3);
  const more = w.waiting - shown.length;
  const values = {
    count: w.waiting,
    names: shown.join(", "),
    more,
    b: (chunks: React.ReactNode) => <span className="font-semibold text-lc-chalk">{chunks}</span>,
  };
  return (
    <p className="m-0 flex items-center gap-2.5 text-[14px] leading-snug" aria-live="polite">
      <StatusDot tone={w.waiting > 0 ? "good" : "neutral"} />
      {w.waiting === 0 ? (
        <span className="text-lc-slate">{tx("nobodyWaiting")}</span>
      ) : (
        <span className="min-w-0 text-lc-fog">
          {tx.rich(shown.length === 0 ? "waiting" : more > 0 ? "waitingNamesMore" : "waitingNames", values)}
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

/** This week's top five by wins then podiums, and the player's record in one line */
const RaceResultsLines: React.FC<{ standings: WeekStanding[]; record: DriverRecord | null }> = ({ standings, record }) => {
  const tx = useTranslations("hud.racesCard");
  return (
    <div className="flex flex-col gap-2 border-t border-lc-line pt-4">
      {standings.length === 0 ? null : (
        <>
        <h4 className="lc-row-label m-0">{tx("topDrivers")}</h4>
        <ol className="m-0 flex list-none flex-col p-0">
          {standings.slice(0, 5).map((s, i) => (
            <li key={`${s.name}-${i}`} className="flex h-9 items-center justify-between gap-3 border-b border-white/5 last:border-b-0">
              <span className="flex min-w-0 items-center gap-2.5">
                <PositionBadge position={i + 1} size="sm" className="min-w-10" />
                <span className="truncate text-[14px] font-semibold" title={s.name}>{s.name}</span>
              </span>
              <span className="lc-mono shrink-0 text-[12px] font-bold text-lc-fog">
                {tx("winsPodiums", { wins: s.wins, podiums: s.podiums })}
              </span>
            </li>
          ))}
        </ol>
        </>
      )}
      {record && record.starts > 0 ? (
        <p className="lc-hint m-0">
          {record.bestFinish !== null
            ? tx("recordBest", { starts: record.starts, wins: record.wins, podiums: record.podiums, best: record.bestFinish })
            : tx("record", { starts: record.starts, wins: record.wins, podiums: record.podiums })}
        </p>
      ) : null}
    </div>
  );
};
