"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NowPlaying } from "@/lib/audio/bgm-controller";
import { Icon } from "@/components/ui/icons/Icon";

/** How long each track's card stays, and its slide out at the end (ms) */
const SHOW_MS = 4000;
const LEAVE_MS = 220;
/** How often the card looks again for a clear spot while it shows (a screen opened under it) */
const RECHECK_MS = 400;
/** Its margin from the screen's edges (px) */
const EDGE = 16;

/** Where the card may sit, tried in this order; start and end follow the language's direction */
type Spot = "top-end" | "top-center" | "bottom-center" | "bottom-start" | "bottom-end";
const SPOTS: readonly Spot[] = ["top-end", "top-center", "bottom-center", "bottom-start", "bottom-end"];

const TOP = "top-[max(1rem,env(safe-area-inset-top))]";
const BOTTOM = "bottom-[max(1rem,env(safe-area-inset-bottom))]";
const SPOT_CLASS: Record<Spot, string> = {
  "top-end": `${TOP} end-[max(1rem,env(safe-area-inset-right))] justify-end`,
  "top-center": `${TOP} inset-x-0 mx-auto justify-center`,
  "bottom-center": `${BOTTOM} inset-x-0 mx-auto justify-center`,
  "bottom-start": `${BOTTOM} start-[max(1rem,env(safe-area-inset-left))] justify-start`,
  "bottom-end": `${BOTTOM} end-[max(1rem,env(safe-area-inset-right))] justify-end`,
};

/** Everything the player can press or read as a control: the card never sits over one */
const CONTROLS =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="slider"], [role="switch"], [role="link"], [data-toast-avoid]';

/** The first spot whose box, for a card this size, covers no control on the screen; null when every one would */
function clearSpot(card: HTMLElement): Spot | null {
  const { width: w, height: h } = card.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rtl = getComputedStyle(card).direction === "rtl";
  const x = { start: rtl ? vw - EDGE - w : EDGE, end: rtl ? EDGE : vw - EDGE - w, center: (vw - w) / 2 };
  const box = (spot: Spot) => {
    const [v, hz] = spot.split("-") as ["top" | "bottom", "start" | "end" | "center"];
    const top = v === "top" ? EDGE : vh - EDGE - h;
    return { left: x[hz], right: x[hz] + w, top, bottom: top + h };
  };
  const controls: DOMRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (card.contains(el)) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) controls.push(r);
  }
  const free = (spot: Spot) => {
    const b = box(spot);
    // A few pixels of breathing room around each control
    return !controls.some((r) => r.right > b.left - 4 && r.left < b.right + 4 && r.bottom > b.top - 4 && r.top < b.bottom + 4);
  };
  return SPOTS.find(free) ?? null;
}

/**
 * The music's new track for four seconds: the title, and the composer under it. Each track once (a track picked up
 * again after the grid or a circuit change keeps its announcement); on every screen, over the menus too. It sits top
 * right (top left right to left) unless a control is there, then at the first clear spot along the screen's top and
 * bottom edges; where every spot would cover a control (and in Career), the track goes unannounced.
 */
export function NowPlayingToast({ nowPlaying }: { nowPlaying: NowPlaying | null }) {
  const [shown, setShown] = useState<NowPlaying | null>(null);
  const [leaving, setLeaving] = useState(false);
  // undefined while the card is measured (drawn hidden), null when no spot is clear
  const [spot, setSpot] = useState<Spot | null | undefined>(undefined);
  const lastSeq = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!nowPlaying || nowPlaying.seq <= lastSeq.current) return;
    lastSeq.current = nowPlaying.seq;
    setShown(nowPlaying);
    setLeaving(false);
    setSpot(undefined);
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

  // Placed before it is painted, and again while it shows: a screen opened under it can bring controls where it sits
  useLayoutEffect(() => {
    if (shownSeq === undefined) return;
    const place = () => {
      const card = cardRef.current;
      if (card) setSpot(clearSpot(card));
    };
    place();
    const id = window.setInterval(place, RECHECK_MS);
    window.addEventListener("resize", place);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", place);
    };
  }, [shownSeq]);

  const at = spot ?? "top-end";
  const bottom = at.startsWith("bottom");
  // It slides in from the edge it sits against
  const from = bottom ? "0px, 16px" : at === "top-center" ? "0px, -16px" : "var(--lc-np-end), 0px";

  return (
    <div
      aria-live="polite"
      className={`pointer-events-none fixed z-(--z-lc-results) flex w-max max-w-[min(360px,calc(100%-2rem))] ${SPOT_CLASS[at]} in-data-[career-open]:hidden`}
    >
      {shown ? (
        <div
          ref={cardRef}
          key={shown.seq}
          style={{ "--lc-np-from": from } as React.CSSProperties}
          className={`${leaving ? "lc-np-out" : "lc-np-in"} ${spot ? "" : "invisible"} flex min-w-0 items-center gap-3 rounded-lc-tile border border-white/10 bg-lc-carbon/95 py-2 pe-4 ps-3 shadow-lc-pop`}
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
