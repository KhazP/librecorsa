"use client";

/*
 * The boards of the home page's Lap times section, loaded once the online side says its boards are on
 * (HomeLapTimes.tsx): every lap on a circuit, narrowed to one car if picked, or the weekly challenge's, this week's
 * or any week's before it back to the first. A challenge week's circuit and car follow from the clock alone
 * (weekly-challenge.ts), so the weeks are worked out here and each read from its own board.
 */
import React, { useEffect, useState } from "react";
import { useTranslations } from "use-intl/react";
import type { VehicleModelId } from "@/types/f1";
import { ALL_CARS, type BoardCar } from "@/lib/net/board-client";
import {
  MIDDLE_GEAR_CHALLENGE,
  challengeAt,
  challengeById,
  challengeConditionsLabel,
  challengesSoFar,
  isPermanentChallenge,
  timeLeftLabel,
  type TimeTrialEvent,
  type WeeklyChallenge,
} from "@/lib/net/weekly-challenge";
import { HallOfFame } from "@/components/board/HallOfFame";
import { LapConditionBadges } from "@/components/board/LapConditionBadges";
import { OnlineBoard, type BoardCarTag } from "@/components/board/OnlineBoard";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";

export interface HomeBoardsProps {
  circuits: readonly { id: string; label: string }[];
  /** The circuit of the open board */
  circuit: string;
  onCircuitChange: (id: string) => void;
  carTag: (vehicle: VehicleModelId) => BoardCarTag;
  /** The cars the open board can be narrowed to */
  carChoices: readonly { id: VehicleModelId; label: string; detail?: string }[];
  /** Car names by car id, for the challenge weeks */
  carTitles: Readonly<Record<string, string>>;
}

type View = "laps" | "challenge" | "hof";

/** "9 Nov" */
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "9–15 Nov", "30 Nov – 6 Dec": a week, Monday to Sunday */
function weekSpan(w: WeeklyChallenge): string {
  const first = new Date(w.startsMs);
  const last = new Date(w.endsMs - 1);
  return first.getUTCMonth() === last.getUTCMonth() ? `${first.getUTCDate()}–${dayOf(w.endsMs - 1)}` : `${dayOf(w.startsMs)} – ${dayOf(w.endsMs - 1)}`;
}

export const HomeBoards: React.FC<HomeBoardsProps> = ({ circuits, circuit, onCircuitChange, carTag, carChoices, carTitles }) => {
  const tx = useTranslations("home.boards");
  const [view, setView] = useState<View>("laps");
  const [car, setCar] = useState<BoardCar>(ALL_CARS);

  // The clock the weeks go by: read again each minute, so a week that ends while the page is open moves on
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (view !== "challenge") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [view]);
  // A clock set before the first week still shows the week it says
  const so = challengesSoFar(now);
  const weeks = so.length > 0 ? so : [challengeAt(now)];
  const allEvents: readonly TimeTrialEvent[] = [weeks[0], MIDDLE_GEAR_CHALLENGE, ...weeks.slice(1)];
  /** The time trial picked; none, this week (which stays the pick when the week turns) */
  const [eventPick, setEventPick] = useState<string | null>(null);
  const activeEvent = allEvents.find((e) => e.id === eventPick) ?? weeks[0];
  const permanent = isPermanentChallenge(activeEvent);
  const thisWeek = !permanent && activeEvent.id === weeks[0].id;

  const circuitName = (id: string) => circuits.find((c) => c.id === id)?.label ?? id;
  const carName = (e: TimeTrialEvent) => carTitles[e.car ?? e.vehicle] ?? carTag(e.vehicle).label;
  const openRecordBoard = (trackId: string, vehicle: VehicleModelId) => {
    onCircuitChange(trackId);
    setCar(vehicle);
    setView("laps");
  };

  const switcher = (
    <Segmented
      aria-label={tx("board")}
      value={view}
      onChange={setView}
      options={[
        { id: "laps", label: tx("allLaps") },
        { id: "challenge", label: tx("timeTrials") },
        { id: "hof", label: tx("hallOfFame") },
      ]}
      className="self-start phone:self-stretch"
      fill
    />
  );

  if (view === "laps") {
    return (
      <div className="flex flex-col gap-3">
        {switcher}
        <OnlineBoard
          title={tx("lapTimesTitle")}
          headingAs="h2"
          circuits={circuits}
          circuit={circuit}
          onCircuitChange={onCircuitChange}
          carPicker={{ cars: carChoices, value: car, onChange: setCar }}
          carTag={carTag}
        />
      </div>
    );
  }

  if (view === "hof") {
    return (
      <div className="flex flex-col gap-3">
        {switcher}
        <HallOfFame
          circuitName={circuitName}
          carName={(v, eventId) => {
            const namedCar = eventId ? challengeById(eventId)?.car : undefined;
            if (namedCar && carTitles[namedCar]) return carTitles[namedCar];
            return carTitles[v] ?? carChoices.find((c) => c.id === v)?.label ?? v;
          }}
          onOpenBoard={openRecordBoard}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {switcher}
      <OnlineBoard
        title={tx("timeTrialsTitle")}
        headingAs="h2"
        circuits={circuits}
        circuit={activeEvent.trackId}
        onCircuitChange={() => {}}
        event={{ id: activeEvent.id, vehicle: activeEvent.vehicle, carLabel: carName(activeEvent), ended: !permanent && !thisWeek }}
        picker={
          <Select
            aria-label={tx("trialPicker")}
            className="w-80 max-w-full"
            value={activeEvent.id}
            onChange={(id) => setEventPick(id === weeks[0].id ? null : id)}
            options={allEvents.map((ev) => {
              if (isPermanentChallenge(ev)) {
                return {
                  id: ev.id,
                  label: tx("middleGearOption", { circuit: circuitName(ev.trackId) }),
                  detail: carName(ev),
                };
              }
              const isCurrent = ev.id === weeks[0].id;
              return {
                id: ev.id,
                label: isCurrent
                  ? tx("thisWeek", { circuit: circuitName(ev.trackId) })
                  : tx("pastWeek", { dates: weekSpan(ev), circuit: circuitName(ev.trackId) }),
                detail: carName(ev),
              };
            })}
          />
        }
        intro={
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="lc-body m-0">
                <span className="font-semibold text-lc-chalk">{circuitName(activeEvent.trackId)}</span>
                <span className="text-lc-fog"> · {carName(activeEvent)}</span>
              </p>
              {permanent ? (
                <Badge size="sm" icon="locked" tone={{ color: "amber" }} variant="soft">
                  {tx("permanent")}
                </Badge>
              ) : (
                <Badge size="sm" icon="time" variant="outline">
                  {thisWeek ? tx("timeLeft", { timeLeft: timeLeftLabel(activeEvent.endsMs, now) }) : tx("ran", { dates: weekSpan(activeEvent) })}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5" aria-label={tx("rules")}>
              <LapConditionBadges assists={activeEvent.assists} realism={activeEvent.realism} />
              <span className="lc-mono text-[12px] text-lc-slate">{challengeConditionsLabel(activeEvent.vehicle)}</span>
            </div>
          </div>
        }
        emptyText={permanent ? tx("emptyPermanent") : thisWeek ? tx("emptyThisWeek") : tx("emptyPastWeek")}
        carTag={carTag}
        onOpenRecordBoard={openRecordBoard}
      />
    </div>
  );
};
