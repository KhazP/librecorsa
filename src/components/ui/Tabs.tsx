"use client";

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CHOSEN_PILL, CURSOR_PILL, cx, HOVER_PILL, MOTION, PRESSED_PILL } from "./styles";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** The full name, as a tooltip, when `label` is a short form of it */
  title?: string;
  /** Icon before the label (16 px); give every tab one or none, so widths hold as the choice moves */
  icon?: React.ReactNode;
  /** A count or state after the label */
  badge?: React.ReactNode;
}

export interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible name of the strip */
  "aria-label": string;
  /** `data-nav-zone` of the strip, so two strips can share a screen (default "tabs") */
  navZone?: string;
  /** Shoulder prompts at the ends (LB / RB, Q / E), passed in as nodes; hidden on touch screens */
  prevPrompt?: React.ReactNode;
  nextPrompt?: React.ReactNode;
  /** The id of the panel the tabs control */
  panelId?: string;
  /** `md` 40 px, `sm` 36 */
  size?: "md" | "sm";
  /** Forces the cursor onto a tab (the kit's state sheets) */
  forceCursorOn?: T;
  /**
   * Many tabs in a narrow pane: the strip wraps onto a second row instead of scrolling sideways, so no tab sits out
   * of sight. Left / right still walk the tabs in order.
   */
  wrap?: boolean;
  /**
   * Many tabs in a wide pane: the strip takes the pane's width and the tabs share it, with tighter padding, so they
   * stay on one row. If they still do not fit, the strip scrolls sideways as usual.
   */
  fill?: boolean;
  /**
   * A long strip that should stay on one row (the pause menu's sections): the tabs share the pane's width on the
   * least padding, and their icons drop while the labels would not fit beside them. Past that it scrolls, as usual.
   */
  squeeze?: boolean;
  /** A click on the current tab calls `onChange` again (a screen that brings its panel into view on a click) */
  reselect?: boolean;
  className?: string;
}

/** The tab one step from `value` (wrapping), for a screen's LB / RB or Q / E */
export function adjacentTab<T extends string>(tabs: readonly { id: T }[], value: T, dir: 1 | -1): T {
  const i = tabs.findIndex((t) => t.id === value);
  return tabs[(i + dir + tabs.length) % tabs.length].id;
}

/** How far the faded ends of a scrolling strip reach */
const EDGE_FADE = "1.75rem";

/** A mask that fades whichever ends of the strip have tabs scrolled past them */
const edgeMask = (start: boolean, end: boolean) =>
  `linear-gradient(to right, transparent, black ${start ? EDGE_FADE : "0px"}, black calc(100% - ${end ? EDGE_FADE : "0px"}), transparent)`;

/**
 * The tab strip: a pill track, the current tab chosen (white), the cursor volt. A tab is chosen as the cursor lands on
 * it (keys, D-pad), or by a click; the screen's shoulder buttons switch tabs through `adjacentTab`. Hovering does not
 * move the cursor here, since that would switch the page under the pointer. A strip too long for its pane scrolls
 * sideways, its cut ends fading out so it shows there is more.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  navZone = "tabs",
  prevPrompt,
  nextPrompt,
  panelId,
  size = "md",
  forceCursorOn,
  wrap,
  fill,
  squeeze,
  reselect,
  className,
  ...aria
}: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const pointing = useRef(false);
  const base = useId();
  const shared = fill || squeeze;

  // Squeezed: the icons go while the labels alone would not fit beside them. A new set of tabs is measured afresh, with
  // its icons; `iconsNeed` is the strip's width with them, taken when they went
  const tabsKey = tabs.map((t) => `${t.id}:${t.label}`).join("|");
  const [iconsOff, setIconsOff] = useState(false);
  const [measured, setMeasured] = useState(tabsKey);
  if (measured !== tabsKey) {
    setMeasured(tabsKey);
    setIconsOff(false);
  }
  const iconsNeed = useRef(0);
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const check = () => {
      const over = list.scrollWidth > list.clientWidth + 1;
      if (squeeze && !iconsOff && over && tabs.some((t) => t.icon)) {
        iconsNeed.current = list.scrollWidth;
        setIconsOff(true);
        return;
      }
      if (squeeze && iconsOff && list.clientWidth >= iconsNeed.current) {
        setIconsOff(false);
        return;
      }
      // The ends that have tabs past them fade (a strip that wraps never scrolls)
      // Right to left, scrollLeft runs from 0 down to negative: its size is the distance from the start either way
      const scrolled = Math.abs(list.scrollLeft);
      const start = !wrap && over && scrolled > 1;
      const end = !wrap && over && scrolled < list.scrollWidth - list.clientWidth - 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(list);
    list.addEventListener("scroll", check, { passive: true });
    // Measured before the display font arrived, the widths are the fallback's
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) check();
    });
    return () => {
      live = false;
      ro.disconnect();
      list.removeEventListener("scroll", check);
    };
    // `tabs` itself is a new array on most renders: its key says when the strip changed
  }, [squeeze, iconsOff, wrap, tabsKey]);

  // Switched from outside (shoulder buttons) while the cursor is in the strip: the cursor follows the choice
  useEffect(() => {
    const list = listRef.current;
    const active = document.activeElement;
    if (!list || !active || !list.contains(active)) return;
    const tab = list.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(value)}"]`);
    if (tab && tab !== active) tab.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  const onFocus = (id: T) => (e: React.FocusEvent<HTMLButtonElement>) => {
    if (id === value) return;
    const from = e.relatedTarget as Node | null;
    // Moving along the strip, or a click: choose it. Entering the strip from elsewhere: land on the current tab, so a
    // stale remembered tab never switches the page back
    if (pointing.current || (from && listRef.current?.contains(from))) {
      onChange(id);
      return;
    }
    const current = listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(value)}"]`);
    if (current) current.focus({ preventScroll: true });
    else onChange(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Right to left the list runs the other way on screen, so the arrows step the other way through it
    const ahead = getComputedStyle(e.currentTarget).direction === "rtl" ? -1 : 1;
    const keys: Record<string, number> = { ArrowLeft: -ahead, ArrowRight: ahead, Home: -Infinity, End: Infinity };
    const d = keys[e.key];
    if (d === undefined) return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = d === -Infinity ? 0 : d === Infinity ? buttons.length - 1 : i + d;
    // Past either end the menu navigation carries on (to a prompt-free neighbour, or nowhere)
    if (i < 0 || next < 0 || next >= buttons.length) return;
    e.preventDefault();
    buttons[next].focus({ preventScroll: true });
  };

  return (
    <div className={cx("flex min-w-0 items-center gap-2", className)} data-nav-zone={navZone}>
      {prevPrompt ? <span className="inline-flex shrink-0 pointer-coarse:hidden">{prevPrompt}</span> : null}
      <div
        ref={listRef}
        role="tablist"
        {...aria}
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          pointing.current = true;
        }}
        onPointerUp={() => {
          pointing.current = false;
        }}
        onPointerLeave={() => {
          pointing.current = false;
        }}
        className={cx(
          "flex min-w-0 gap-1 bg-lc-void/85 p-1 inset-ring inset-ring-lc-line",
          wrap ? "flex-wrap rounded-lc-card" : "overflow-x-auto rounded-full [scrollbar-width:none]",
          shared ? "w-full" : undefined,
        )}
        style={edges.start || edges.end ? { maskImage: edgeMask(edges.start, edges.end), WebkitMaskImage: edgeMask(edges.start, edges.end) } : undefined}
      >
        {tabs.map((t) => {
          const chosen = t.id === value;
          const icon = t.icon && !iconsOff ? t.icon : null;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${base}-${t.id}`}
              data-tab-id={t.id}
              title={t.title}
              aria-selected={chosen}
              aria-controls={panelId}
              tabIndex={chosen ? 0 : -1}
              data-nav-default={chosen ? "" : undefined}
              data-cursor={forceCursorOn === t.id ? "" : undefined}
              onFocus={onFocus(t.id)}
              onClick={() => {
                if (reselect || !chosen) onChange(t.id);
              }}
              className={cx(
                "group lc-title inline-flex shrink-0 cursor-pointer items-center rounded-full whitespace-nowrap",
                squeeze ? "flex-1 justify-center gap-1.5 px-2" : fill ? "flex-1 justify-center gap-2 px-3" : "gap-2 px-4",
                // A tab the cursor scrolls to stops clear of the strip's faded end
                wrap ? undefined : "scroll-mx-7",
                "pointer-coarse:min-h-11 [&_svg]:size-4 [&_svg]:shrink-0",
                size === "md" ? "min-h-10 text-[15px]" : "min-h-9 text-[14px]",
                MOTION,
                chosen ? CHOSEN_PILL : cx("text-lc-slate", HOVER_PILL),
                PRESSED_PILL,
                CURSOR_PILL,
              )}
            >
              {icon ? (
                <span aria-hidden className={cx("inline-flex", chosen ? undefined : "opacity-70 group-focus:opacity-100")}>
                  {icon}
                </span>
              ) : null}
              {t.label}
              {/* `relative` keeps a badge's screen-reader text (an absolutely placed span) inside the strip's scroll
                  clip; without it the text sits past the strip's end and widens the page on a phone */}
              {t.badge ? <span className="relative inline-flex not-italic">{t.badge}</span> : null}
            </button>
          );
        })}
      </div>
      {nextPrompt ? <span className="inline-flex shrink-0 pointer-coarse:hidden">{nextPrompt}</span> : null}
    </div>
  );
}
