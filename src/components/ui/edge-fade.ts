import type React from "react";

/** How far the faded ends of a scrolling strip reach */
const EDGE_FADE = "1.75rem";

/** Which ends of a sideways-scrolling strip have items scrolled past them (and the strip's direction) */
export interface StripEdges {
  start: boolean;
  end: boolean;
  rtl: boolean;
}

export const NO_EDGES: StripEdges = { start: false, end: false, rtl: false };

/** Measures a strip: right to left, scrollLeft runs from 0 down to negative, so its size is the distance from the start */
export function stripEdges(list: HTMLElement): StripEdges {
  const over = list.scrollWidth > list.clientWidth + 1;
  const scrolled = Math.abs(list.scrollLeft);
  return {
    start: over && scrolled > 1,
    end: over && scrolled < list.scrollWidth - list.clientWidth - 1,
    rtl: getComputedStyle(list).direction === "rtl",
  };
}

export const sameEdges = (a: StripEdges, b: StripEdges) => a.start === b.start && a.end === b.end && a.rtl === b.rtl;

/** The mask that fades whichever ends have items past them: the start is the right end right to left */
export function edgeFadeStyle({ start, end, rtl }: StripEdges): React.CSSProperties | undefined {
  if (!start && !end) return undefined;
  const mask = `linear-gradient(to ${rtl ? "left" : "right"}, transparent, black ${start ? EDGE_FADE : "0px"}, black calc(100% - ${end ? EDGE_FADE : "0px"}), transparent)`;
  return { maskImage: mask, WebkitMaskImage: mask };
}
