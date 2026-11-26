"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NowPlaying } from "@/lib/audio/bgm-controller";
import { Icon } from "@/components/ui/icons/Icon";
import { uiFrame } from "@/lib/display/ui-frame";

/** How long each track's card stays, and its slide out at the end (ms) */
const SHOW_MS = 4000;
const LEAVE_MS = 220;
/** How often the card looks again for a clear spot while it shows (a screen opened under it) */
const RECHECK_MS = 400;
/** Its least margin from the screen's edges (px); a notch or home indicator's safe area can make it more */
const EDGE = 16;

/** Where the card may sit, tried in this order; start and end follow the language's direction */
type Spot = "top-end" | "top-center" | "bottom-center" | "bottom-start" | "bottom-end";
const SPOTS: readonly Spot[] = ["top-end", "top-center", "bottom-center", "bottom-start", "bottom-end"];

const TOP = "top-[max(1rem,env(safe-area-inset-top))]";
const BOTTOM = "bottom-[max(1rem,env(safe-area-inset-bottom))]";
const SPOT_CLASS: Record<Spot, string> = {
  "top-end": `${TOP} end-[max(1rem,env(safe-area-inset-right))] rtl:end-[max(1rem,env(safe-area-inset-left))] justify-end`,
  "top-center": `${TOP} inset-x-0 mx-auto justify-center`,
  "bottom-center": `${BOTTOM} inset-x-0 mx-auto justify-center`,
  "bottom-start": `${BOTTOM} start-[max(1rem,env(safe-area-inset-left))] rtl:start-[max(1rem,env(safe-area-inset-right))] justify-start`,
  "bottom-end": `${BOTTOM} end-[max(1rem,env(safe-area-inset-right))] rtl:end-[max(1rem,env(safe-area-inset-left))] justify-end`,
};

/** Everything the player can press or read as a control: the card never sits over one */
const CONTROLS =
  'button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="slider"], [role="switch"], [role="link"], [data-toast-avoid]';

/** The in-race HUD (F1TelemetryHud's root): its plates and readouts count as things the card must not cover */
const HUD_ROOT = "[data-hud-root]";
/** A HUD element at least this share of the screen is a frame or wrapper, not a plate */
const HUD_WRAPPER_SHARE = 0.35;

/** Whether a HUD element is something drawn: a filled, bordered or shadowed plate, its own text, or an image */
function drawn(el: Element, cs: CSSStyleDeclaration): boolean {
  if (el instanceof SVGSVGElement || el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) return true;
  if (cs.backgroundImage !== "none" || cs.boxShadow !== "none") return true;
  if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") return true;
  if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopColor !== "rgba(0, 0, 0, 0)") return true;
  for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  return false;
}

/** The boxes of everything the in-race HUD draws on the screen now (none outside a drive) */
function hudPlates(): DOMRect[] {
  const plates: DOMRect[] = [];
  const screen = window.innerWidth * window.innerHeight;
  for (const root of document.querySelectorAll<HTMLElement>(HUD_ROOT)) {
    for (const el of root.querySelectorAll<HTMLElement | SVGSVGElement>("*")) {
      // Inside an SVG only the svg itself counts
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.width * r.height > screen * HUD_WRAPPER_SHARE) continue;
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (drawn(el, getComputedStyle(el))) plates.push(r);
    }
  }
  return plates;
}

/** The screen's safe-area insets (a notch, the home indicator), as the CSS above reads them */
function safeInsets(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const inset = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  return inset;
}

/** The first spot whose box, for a card this size, covers no control on the screen; null when every one would */
function clearSpot(card: HTMLElement): Spot | null {
  const { width: w, height: h } = card.getBoundingClientRect();
  // The card places itself in the window, or in the centre screen of three (the controls' boxes are in window pixels)
  const frame = uiFrame();
  const x0 = frame?.x ?? 0;
  const vw = frame?.w ?? window.innerWidth;
  const vh = window.innerHeight;
  const rtl = getComputedStyle(card).direction === "rtl";
  const inset = safeInsets();
  const left = x0 + Math.max(EDGE, inset.left);
  const right = Math.max(EDGE, inset.right);
  const x = { start: rtl ? x0 + vw - right - w : left, end: rtl ? left : x0 + vw - right - w, center: x0 + (vw - w) / 2 };
  const box = (spot: Spot) => {
    const [v, hz] = spot.split("-") as ["top" | "bottom", "start" | "end" | "center"];
    const top = v === "top" ? Math.max(EDGE, inset.top) : vh - Math.max(EDGE, inset.bottom) - h;
    return { left: x[hz], right: x[hz] + w, top, bottom: top + h };
  };
  const controls: DOMRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(CONTROLS)) {
    if (card.contains(el)) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) controls.push(r);
  }
  // In a drive the HUD's plates too (the timing panel, the speed pod, the start lights)
  controls.push(...hudPlates());
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
 * right (top left right to left) unless a control or, in a drive, a HUD plate is there, then at the first clear spot
 * along the screen's top and bottom edges; where every spot would cover one (and in Career), the track goes unannounced.
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
