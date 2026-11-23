"use client";

import React, { useEffect, useRef, useState } from "react";
import type { NowPlaying } from "@/lib/audio/bgm-controller";
import { Icon } from "@/components/ui/icons/Icon";

/** How long each track's card stays, and its slide out at the end (ms) */
const SHOW_MS = 4000;
const LEAVE_MS = 220;

/**
 * The music's new track, top right for four seconds: the title, and the composer under it. Each track once (a track
 * picked up again after the grid or a circuit change keeps its announcement); on every screen, over the menus too.
 */
export function NowPlayingToast({ nowPlaying }: { nowPlaying: NowPlaying | null }) {
  const [shown, setShown] = useState<NowPlaying | null>(null);
  const [leaving, setLeaving] = useState(false);
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!nowPlaying || nowPlaying.seq <= lastSeq.current) return;
    lastSeq.current = nowPlaying.seq;
    setShown(nowPlaying);
    setLeaving(false);
  }, [nowPlaying]);

  // The card's timers run per announcement: the music going quiet, or a track picked up again, within the four seconds
  // leaves them running (only a newer track restarts them)
  const shownSeq = shown?.seq;
  useEffect(() => {
    if (shownSeq === undefined) return;
    const leave = window.setTimeout(() => setLeaving(true), SHOW_MS - LEAVE_MS);
    const gone = window.setTimeout(() => setShown(null), SHOW_MS);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(gone);
    };
  }, [shownSeq]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed top-[max(1rem,env(safe-area-inset-top))] right-[max(1rem,env(safe-area-inset-right))] z-(--z-lc-results) flex max-w-[min(360px,calc(100%-2rem))] justify-end"
    >
      {shown ? (
        <div
          key={shown.seq}
          className={`${leaving ? "lc-np-out" : "lc-np-in"} flex min-w-0 items-center gap-3 rounded-lc-tile border border-white/10 bg-lc-carbon/95 py-2 pe-4 ps-3 shadow-lc-pop`}
        >
          <span aria-hidden className="inline-flex shrink-0 text-lc-fog">
            <Icon name="music" size="md" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[14px] leading-snug font-semibold text-lc-chalk">{shown.title}</span>
            <span className="truncate text-[13px] leading-snug text-lc-slate">{shown.composer}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
