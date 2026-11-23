"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CAREER_SERIES, seriesById, type CareerContent } from "@/lib/career/ladder";
import {
  EMPTY_SAVE,
  chooseSeries,
  endSeason,
  newCareer,
  nextRound,
  promotionPlaces,
  racePlan,
  raceScore,
  recordRound,
  seasonStandings,
  startSeason,
  updateRaceSettings,
  updateSeasonSettings,
  withRun,
  type CareerRun,
  type CareerSave,
  type RaceOutcome,
  type SeasonEnd,
} from "@/lib/career/career-state";
import { getTrackInfo } from "@/lib/track-registry";
import { CareerScreen } from "@/components/career/CareerScreen";
import type { CareerSummary } from "@/components/career/career-screen-types";

const PLAYER_CODE = "YAL";
const PLAYER_NAME = "Alex Yalcin";

/** All tracks and cars referenced by the ladder so every series is inspectable in the dev kit. */
function makeKitContent(): CareerContent {
  const tracks = new Set<string>();
  const cars = new Set<string>();
  for (const s of CAREER_SERIES) {
    for (const t of s.calendar) tracks.add(t);
    for (const c of s.cars) cars.add(c);
  }
  return { tracks, cars };
}

const lapLengthM = (trackId: string) => getTrackInfo(trackId).lengthM || 4000;

/** Builds a deterministic race outcome for `plan` with the player finishing in `playerPos`. */
function simulateOutcome(
  plan: NonNullable<ReturnType<typeof racePlan>>,
  playerPos: number,
  gridPos: number,
  lapsLed: number,
  fastest: boolean,
  penaltyS = 0,
): RaceOutcome {
  const others = plan.drivers.map((d) => d.code);
  const clamped = Math.max(1, Math.min(others.length + 1, playerPos));
  const order: { code: string; isPlayer: boolean }[] = [];
  let aiIdx = 0;
  for (let p = 1; p <= others.length + 1; p++) {
    if (p === clamped) {
      order.push({ code: PLAYER_CODE, isPlayer: true });
    } else {
      order.push({ code: others[aiIdx++], isPlayer: false });
    }
  }
  return {
    laps: plan.laps,
    lapsLed,
    results: order.map((entry, i) => ({
      code: entry.code,
      isPlayer: entry.isPlayer,
      position: i + 1,
      gridPosition: entry.isPlayer ? gridPos : ((i + 2) % (others.length + 1)) + 1,
      lapsCompleted: plan.laps,
      bestLapMs: entry.isPlayer && fastest ? 88_420 : 89_100 + i * 310,
      penaltyS: entry.isPlayer ? penaltyS : 0,
    })),
  };
}

/** Plays every remaining round of a started season and closes it via `endSeason`. */
function finishSeason(
  run: CareerRun,
  content: CareerContent,
  positions: readonly number[],
): { run: CareerRun; end: SeasonEnd } {
  let cur = run;
  let r = 0;
  while (cur.season && nextRound(cur.season) !== null) {
    const plan = racePlan(cur, lapLengthM, PLAYER_CODE)!;
    const pos = positions[r % positions.length];
    cur = recordRound(cur, plan, simulateOutcome(plan, pos, Math.max(1, pos), pos === 1 ? Math.ceil(plan.laps / 2) : 0, pos === 1));
    r++;
  }
  const ended = endSeason(cur, content)!;
  return { run: ended.run, end: ended };
}

function buildSampleData() {
  const content = makeKitContent();

  // 1. Mid-season career: Road, promoted through Club Cup Europe -> Touring Cup Europe -> Classic GT -> now mid-season GT3 Europe
  let roadMid = newCareer("road", "clubCup_europe", content, 104729)!;
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 2 }, content);
  roadMid = updateRaceSettings(roadMid, { aiLevel: "high", raceLength: "medium", damage: "reduced", qualifying: 5 });
  roadMid = startSeason(roadMid);
  roadMid = finishSeason(roadMid, content, [1, 2, 1]).run;
  // Strip archive from the oldest season record so the kit demonstrates both archived and legacy history rows
  if (roadMid.history[0]) {
    const { archive: _omit, ...legacyRecord } = roadMid.history[0];
    roadMid = { ...roadMid, history: [legacyRecord, ...roadMid.history.slice(1)] };
  }

  roadMid = chooseSeries(roadMid, "touringCup_europe", content);
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 2 }, content);
  roadMid = startSeason(roadMid);
  const touringEnd = finishSeason(roadMid, content, [2, 1, 3]);
  roadMid = touringEnd.run;

  roadMid = chooseSeries(roadMid, "classicGt", content);
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 1, car: "nissan-r33-jgtc" }, content);
  roadMid = startSeason(roadMid);
  const classicEnd = finishSeason(roadMid, content, [3, 2, 1]).run;
  roadMid = classicEnd;

  roadMid = chooseSeries(roadMid, "gt3_europe", content);
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 1, car: "bmw-m4-gt3" }, content);
  roadMid = startSeason(roadMid);
  roadMid = finishSeason(roadMid, content, [2, 1, 2]).run;

  roadMid = chooseSeries(roadMid, "endurance", content);
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 1 }, content);
  roadMid = startSeason(roadMid);
  const enduranceEnd = finishSeason(roadMid, content, [1, 3, 2]);
  roadMid = enduranceEnd.run;

  roadMid = chooseSeries(roadMid, "grandPrix", content);
  roadMid = updateSeasonSettings(roadMid, { length: "short", mulligans: 2 }, content);
  roadMid = updateRaceSettings(roadMid, { aiLevel: "high", raceLength: "medium", damage: "reduced", qualifying: 10 });
  roadMid = startSeason(roadMid);

  // Record 2 rounds and capture the 2nd round's before/after for a sample Race Summary
  const p1 = racePlan(roadMid, lapLengthM, PLAYER_CODE)!;
  roadMid = recordRound(roadMid, p1, simulateOutcome(p1, 4, 5, 0, false, 0));

  const beforeR2 = seasonStandings(roadMid.season!);
  const p2 = racePlan(roadMid, lapLengthM, PLAYER_CODE)!;
  roadMid = recordRound(roadMid, p2, simulateOutcome(p2, 2, 3, 3, true, 0));
  const afterR2 = seasonStandings(roadMid.season!);
  const r2Result = roadMid.season!.rounds[p2.roundIndex]!;
  const gpSeries = seriesById(roadMid.season!.seriesId)!;
  const r2Parts = raceScore(r2Result, roadMid.season!.race.gridSize, roadMid.season!.race);

  const raceSummary: CareerSummary = {
    kind: "race",
    runId: roadMid.id,
    seriesId: roadMid.season!.seriesId,
    roundIndex: p2.roundIndex,
    rounds: roadMid.season!.settings.circuits.length,
    result: r2Result,
    parts: r2Parts,
    before: beforeR2,
    after: afterR2,
    promotion: promotionPlaces(gpSeries, roadMid.season!.race.gridSize),
  };

  const seasonSummary: CareerSummary = {
    kind: "season",
    runId: roadMid.id,
    end: {
      record: enduranceEnd.end.record,
      outcome: enduranceEnd.end.outcome,
      alongside: enduranceEnd.end.alongside,
      parts: enduranceEnd.end.parts,
    },
  };

  // 2. Pre-season career: Classic GT (promoted to a 2-car series in pre-season so car & calendar pickers show)
  let preSeason = newCareer("road", "clubCup_americas", content, 209441)!;
  preSeason = updateSeasonSettings(preSeason, { length: "short", mulligans: 3 }, content);
  preSeason = startSeason(preSeason);
  preSeason = finishSeason(preSeason, content, [2, 1, 2]).run;
  preSeason = chooseSeries(preSeason, "touringCup_americas", content);
  preSeason = updateSeasonSettings(preSeason, { length: "short", mulligans: 3 }, content);
  preSeason = startSeason(preSeason);
  preSeason = finishSeason(preSeason, content, [1, 3, 2]).run;
  preSeason = chooseSeries(preSeason, "classicGt", content);

  // 3. Complete career: Historic ladder cleared all the way through Can-Am Legends
  let complete = newCareer("historic", "procar", content, 314159)!;
  complete = updateSeasonSettings(complete, { length: "short", mulligans: 1 }, content);
  complete = updateRaceSettings(complete, { aiLevel: "expert", raceLength: "medium", damage: "full", qualifying: 5 });
  complete = startSeason(complete);
  complete = finishSeason(complete, content, [1, 1, 2]).run;

  complete = chooseSeries(complete, "group4", content);
  complete = updateSeasonSettings(complete, { length: "short", mulligans: 1 }, content);
  complete = startSeason(complete);
  complete = finishSeason(complete, content, [2, 1, 1]).run;

  complete = chooseSeries(complete, "canAm", content);
  complete = updateSeasonSettings(complete, { length: "short", mulligans: 0, car: "chaparral-2d-67" }, content);
  complete = startSeason(complete);
  complete = finishSeason(complete, content, [1, 2, 1]).run;

  let save: CareerSave = EMPTY_SAVE;
  save = withRun(save, preSeason);
  save = withRun(save, complete);
  save = withRun(save, roadMid); // activeId = mid-season career

  return {
    content,
    save,
    midId: roadMid.id,
    preSeasonId: preSeason.id,
    completeId: complete.id,
    summaries: [raceSummary, seasonSummary] as CareerSummary[],
  };
}

export const CareerKitClient: React.FC = () => {
  const params = useSearchParams();
  const initial = useMemo(() => buildSampleData(), []);
  const viewParam = params.get("view");
  const modalParam = params.get("modal");

  const [save, setSave] = useState<CareerSave>(() => {
    if (viewParam === "home") return { ...initial.save, activeId: null };
    if (viewParam === "preseason") return { ...initial.save, activeId: initial.preSeasonId };
    if (viewParam === "complete") return { ...initial.save, activeId: initial.completeId };
    return initial.save;
  });

  const [summaries, setSummaries] = useState<CareerSummary[]>(() => {
    if (modalParam === "none" || modalParam === "unfinished") return [];
    if (modalParam === "season") return [initial.summaries[1]];
    if (modalParam === "race") return [initial.summaries[0]];
    return initial.summaries;
  });

  const [unfinished, setUnfinished] = useState<{ runId: string } | null>(() =>
    modalParam === "unfinished" ? { runId: initial.midId } : null,
  );
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="h-dvh w-dvw bg-lc-void text-lc-chalk">
      {mounted ? (
        <CareerScreen
          save={save}
          content={initial.content}
          playerCode={PLAYER_CODE}
          playerName={PLAYER_NAME}
          onSave={setSave}
          onClose={() => {}}
          onRaceNext={() => {}}
          onTestDay={() => {}}
          summaries={summaries}
          onCloseSummary={() => setSummaries((s) => s.slice(1))}
          unfinished={unfinished}
          onResolveUnfinished={() => setUnfinished(null)}
        />
      ) : null}
    </div>
  );
};
