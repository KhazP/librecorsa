"use client";

import { useEffect, useRef, useState } from "react";
import type { RaceStatus } from "@/types/f1";
import { loadRaceHistory, recordFromResults, saveRaceRecord, type RaceKind, type RaceRecord } from "@/lib/sim/race-history";

/**
 * Keeps the race on track in the browser's race history as soon as the player has a result, saved again as it firms
 * up (one record per run on track), and returns the saved races, newest first. `kind` null: not a race.
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
  const key = me && results ? JSON.stringify([runId, meta.kind, final, results.length, me.position, me.finishTimeS, me.dnf, me.gridPosition, me.bestLapMs, me.penaltyS]) : null;

  useEffect(() => {
    if (!key || !results || !meta.kind) return;
    let cur = current.current;
    if (!cur || cur.run !== runId || cur.kind !== meta.kind) {
      const atMs = Date.now();
      cur = { run: runId, kind: meta.kind, id: `${atMs.toString(36)}-${runId ?? 0}`, atMs };
      current.current = cur;
    }
    const record = recordFromResults(results, final, { id: cur.id, atMs: cur.atMs, trackId: meta.trackId, carId: meta.carId, kind: meta.kind });
    if (record) setHistory(saveRaceRecord(record));
    // Saved on a change of `key` alone (the results array is new every frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return history;
}
