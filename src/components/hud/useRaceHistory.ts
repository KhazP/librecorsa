"use client";

import { useEffect, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";
import { loadRaceHistory, recordFromResults, saveRaceRecord, type RaceKind, type RaceRecord } from "@/lib/sim/race-history";
import { recordRaceResult } from "@/lib/sim/driver-stats";
import { accountActions } from "@/lib/account/account-store";

/**
 * Keeps the race on track in the browser's race history as soon as the player has a result, saved again as it firms
 * up (one record per race, from the result appearing until it goes), and in the driver's totals (driver-stats.ts, by
 * the same record), and returns the saved races, newest first. `kind` null: not a race.
 */
export function useRaceHistory(
  race: RaceStatus | undefined,
  runId: number | undefined,
  meta: { trackId: string; carId: string; kind: RaceKind | null }
): RaceRecord[] {
  const [history, setHistory] = useState<RaceRecord[]>([]);
  // Read after mount: the page is prerendered without storage
  useEffect(() => setHistory(loadRaceHistory()), []);

  /** This race's record id and when the player took the flag, per run on track */
  const current = useRef<{ run: number | undefined; kind: RaceKind | null; id: string; atMs: number } | null>(null);
  const results = meta.kind ? race?.results : undefined;
  const me = results?.find((r) => r.isPlayer);
  const final = race?.resultsFinal === true;
  // What a saved record depends on: it is saved again only when this changes
  // The player set the race's fastest lap (a tie counts)
  const fastestLap =
    me?.bestLapMs != null && results ? results.every((r) => r.bestLapMs == null || r.bestLapMs >= (me.bestLapMs as number)) : false;
  const key = me && results ? JSON.stringify([meta.kind, final, results.length, me.position, me.finishTimeS, me.dnf, me.gridPosition, me.bestLapMs, me.penaltyS, fastestLap]) : null;

  useEffect(() => {
    // No result on track any more (a restart, a new race, leaving it): the next result is another race
    if (!key || !results || !meta.kind) {
      if (!key) current.current = null;
      return;
    }
    let cur = current.current;
    if (!cur || cur.kind !== meta.kind) {
      const atMs = Date.now();
      cur = { run: runId, kind: meta.kind, id: `${atMs.toString(36)}-${runId ?? 0}`, atMs };
      current.current = cur;
    }
    const record = recordFromResults(results, final, { id: cur.id, atMs: cur.atMs, trackId: meta.trackId, carId: meta.carId, kind: meta.kind });
    if (record) {
      setHistory(saveRaceRecord(record));
      recordRaceResult(record, fastestLap);
      accountActions.pushSoon();
    }
    // Saved on a change of `key` alone (the results array is new every frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return history;
}
