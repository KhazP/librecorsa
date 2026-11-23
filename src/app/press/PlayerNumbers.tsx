"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Skeleton } from "@/components/ui";
import { TEXT_LINK } from "@/components/home/SitePage";
import { fetchSiteTotals, formatCount, type SiteTotals } from "@/lib/net/board-client";
import { onlineUrl } from "@/lib/net/online-config";
import { CARD, day } from "./press-ui";

/**
 * The press page's numbers, read from the usage totals when the page opens (cloudflare/api/stats.ts): hours and laps
 * driven, drivers and countries. The page is built ahead of time, so they can't be baked in. A failed read says so
 * instead of showing an old number.
 */
export function PlayerNumbers() {
  const [totals, setTotals] = useState<SiteTotals | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSiteTotals()
      .catch(() => null)
      .then((t) => {
        if (live) setTotals(t);
      });
    return () => {
      live = false;
    };
  }, []);

  // A copy of the game without an online side (a clone, a fork) has no totals to read
  if (totals === null && !onlineUrl("/stats/totals")) return <p className="lc-hint m-0 text-[14px]">This copy of the game has no online side, so there are no numbers to show.</p>;
  if (totals === null) return <p className="lc-hint m-0 text-[14px]">The numbers can’t be read right now. Try again in a moment.</p>;

  const tiles: [string, string][] = totals
    ? [
        [formatCount(totals.hours), "Hours driven"],
        [formatCount(totals.laps), "Laps driven"],
        ...(totals.drivers !== null ? [[formatCount(totals.drivers), "Drivers on the lap boards"] as [string, string]] : []),
        [formatCount(totals.countries), "Countries"],
      ]
    : [];

  return (
    <div className="flex flex-col gap-3" aria-busy={totals === undefined}>
      <dl className="m-0 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {totals
          ? tiles.map(([value, label]) => (
              <div key={label} className={`${CARD} flex flex-col-reverse justify-end gap-1.5 p-4.5 sm:p-5`}>
                <dt className="lc-row-label m-0 text-[14px]">{label}</dt>
                <dd className="lc-data m-0 text-[30px] leading-none text-lc-chalk">{value}</dd>
              </div>
            ))
          : Array.from({ length: 4 }, (_, i) => (
              <div key={i} className={`${CARD} flex flex-col gap-2.5 p-4.5 sm:p-5`}>
                <Skeleton className="h-[30px] w-24" />
                <Skeleton className="h-3.5 w-28" />
              </div>
            ))}
      </dl>
      <p className="lc-hint m-0 text-[13px]">
        {totals
          ? `Hours, laps and countries are counted since ${day(totals.since)} from anonymous daily totals; drivers are every name with a lap on the boards. Updated hourly. `
          : "Reading the totals… "}
        <Link href="/privacy#online" className={TEXT_LINK}>
          How they’re counted
        </Link>
      </p>
    </div>
  );
}
