"use client";

import { useEffect, useState } from "react";
import { fetchPopular, type PopularRanks } from "./board-client";

/** One read per page load, shared by every browser that asks; a failed read is tried again by the next one */
let pending: Promise<PopularRanks | null> | null = null;
let known: PopularRanks | null = null;

/**
 * The circuits and cars driven most this past month (cloudflare/api/stats.ts), for the browsers' Most driven sort.
 * Null until read, and with the online side off or out of reach: the sort is then not offered.
 */
export function usePopularRanks(): PopularRanks | null {
  const [ranks, setRanks] = useState<PopularRanks | null>(known);
  useEffect(() => {
    if (known) return;
    let live = true;
    pending ??= fetchPopular()
      .catch(() => null)
      .then((r) => {
        known = r;
        if (!r) pending = null;
        return r;
      });
    void pending.then((r) => {
      if (live) setRanks(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return ranks;
}

/** Where `id` stands in a ranked list: 0 for the most driven, Infinity when it isn't ranked */
export function popularRank(ids: readonly string[], id: string): number {
  const i = ids.indexOf(id);
  return i < 0 ? Infinity : i;
}
