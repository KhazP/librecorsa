"use client";

import React, { useEffect, useState } from "react";
import { fetchSiteStats, formatCount, type SiteStats } from "@/lib/net/board-client";
import { StatusDot } from "@/components/ui/Badge";

/** The title screen reads the numbers again this often while it is up (the server keeps them half a minute) */
const REFRESH_MS = 60_000;

/**
 * The title screen's line beside the logo: "LIVE · 23 driving now · 4,812 drivers", the live count first. Tabs in
 * view right now (cloudflare/api/presence.ts) and drivers to date (cloudflare/api/stats.ts), as the server says them.
 * A part that is off shows nothing; with the online side off or out of reach, the line is not there at all. It never
 * shows a number the server did not send.
 */
export const LiveLine: React.FC<{ className?: string }> = ({ className = "" }) => {
  const [stats, setStats] = useState<SiteStats | null>(null);
  useEffect(() => {
    let live = true;
    const read = () =>
      void fetchSiteStats()
        .catch(() => null)
        .then((s) => {
          // A failed read hides the line: an older number is never shown as if it were live
          if (live) setStats(s);
        });
    read();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "hidden") read();
    }, REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (!stats) return null;
  const parts: React.ReactNode[] = [];
  if (stats.live !== null) {
    parts.push(
      <span key="now" className="inline-flex items-center gap-1.5">
        <StatusDot tone="good" />
        <span className="font-bold text-lc-chalk">{formatCount(stats.live)}</span> online
      </span>,
    );
  }
  if (stats.drivers !== null) {
    parts.push(
      <span key="drivers">
        <span className="font-bold text-lc-chalk">{formatCount(stats.drivers)}</span> {stats.drivers === 1 ? "driver" : "drivers"}
      </span>,
    );
  }
  return (
    <p className={`lc-mono m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-lc-fog ${className}`}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span aria-hidden className="text-lc-dim">·</span> : null}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
};
