"use client";

import { useEffect, useState } from "react";
import { listBestLapSummaries, subscribeBestLaps, type BestLapSummary } from "./ghost-store";

const EMPTY: readonly BestLapSummary[] = [];

/**
 * Live list of local personal-best lap summaries from IndexedDB.
 * Safe for both `/play` menus and the lightweight `/` HomeHub (zero Three.js imports)
 * and updates automatically whenever a new PB is recorded or deleted.
 */
export function useBestLapSummaries(): readonly BestLapSummary[] {
  const [summaries, setSummaries] = useState<readonly BestLapSummary[]>(EMPTY);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void listBestLapSummaries().then((list) => {
        if (alive) setSummaries(list);
      });
    };
    load();
    const unsub = subscribeBestLaps(load);
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  return summaries;
}
