"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl/react";
import { focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { Icon } from "@/components/ui/icons/Icon";
import { CHOSEN_PILL, CURSOR_PILL, cx, HOVER_PILL, MOTION, PRESSED_PILL, uiZoomOf } from "@/components/ui/styles";
import type { HomeLayout } from "./home-data";
import { OutlineThumb } from "./home-ui";

export interface LayoutBestLap {
  text: string;
  forCurrentCar: boolean;
  legacyPhysics: boolean;
}

export interface VenueLayoutPickerProps {
  venueName: string;
  layouts: readonly HomeLayout[];
  /** Currently active or remembered layout id for this venue */
  value: string;
  /** Whether this venue is the currently selected circuit */
  chosen: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Formats a layout's length and turns in the player's units */
  lengthOf: (layout: HomeLayout) => string;
  /** Optional personal-best summary for each layout */
  bestLapOf?: (layoutId: string) => LayoutBestLap | null;
  onSelect: (layoutId: string) => void;
}

interface Place {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  up: boolean;
  zoomed: boolean;
}

const GAP = 8;
const MARGIN = 12;
const MAX_POPOVER_H = 380;
const EST_ROW_H = 56;
const EST_CHROME_H = 40;

/**
 * Compact layout badge and viewport-aware popover anchored along the bottom of a circuit card's picture frame.
 * Shows how many layouts a venue has before the player presses it, updates in place to the active layout once chosen
 * without shifting any grid row, and opens a rich list with mini track outlines, distances and personal bests.
 */
export const VenueLayoutPicker: React.FC<VenueLayoutPickerProps> = ({
  venueName,
  layouts,
  value,
  chosen,
  open,
  onOpenChange,
  lengthOf,
  bestLapOf,
  onSelect,
}) => {
  const tx = useTranslations("home.layoutPicker");
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const currentIndex = Math.max(
    0,
    layouts.findIndex((l) => l.id === value),
  );
  const current = layouts[currentIndex] ?? layouts[0];

  const close = useCallback(
    (refocus = true) => {
      onOpenChange(false);
      if (refocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [onOpenChange],
  );

  const measure = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const zoom = uiZoomOf(t);
    const r = t.getBoundingClientRect();
    const card = t.closest<HTMLElement>("[data-venue-card]");
    const anchor = card ? card.getBoundingClientRect() : r;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(anchor.width, 280), 348, vw - 2 * MARGIN);
    const needed = Math.min(MAX_POPOVER_H, layouts.length * EST_ROW_H + EST_CHROME_H) * zoom;
    const below = vh - r.bottom - MARGIN;
    const above = r.top - MARGIN;
    const up = below < needed && above > below;
    setPlace({
      left: Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN)) / zoom,
      top: up ? undefined : (r.bottom + GAP) / zoom,
      bottom: up ? (vh - r.top + GAP) / zoom : undefined,
      width: width / zoom,
      maxHeight: Math.max(120, Math.min(MAX_POPOVER_H, (up ? above : below) - GAP)) / zoom,
      up,
      zoomed: zoom !== 1,
    });
  }, [layouts.length]);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // Clicking the same chosen venue's primary tile button toggles via its own onClick instead of close+reopen
      if (chosen && target instanceof Element) {
        const card = triggerRef.current?.closest("[data-venue-card]");
        const tileBtn = card?.querySelector("[data-venue-tile-btn]");
        if (tileBtn && tileBtn.contains(target)) return;
      }
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      } else if (e.key === "Tab") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, chosen, close, measure]);

  // The open list owns arrow/D-pad focus while visible; B / Esc returns focus to the trigger
  useFocusNav(listRef, { enabled: open && place !== null, onBack: () => close() });

  const choose = (id: string) => {
    onSelect(id);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={
          chosen
            ? tx("chosen", { venue: venueName, layout: current.layout, index: String(currentIndex + 1), count: String(layouts.length) })
            : tx("closed", { venue: venueName, count: layouts.length })
        }
        // Spatial arrows/D-pad skip unselected venues' pills so browsing stays one press per card; Tab, click and tap always work
        data-nav-skip={chosen ? undefined : ""}
        onPointerEnter={focusOnHover}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) {
            e.preventDefault();
            onOpenChange(true);
          }
        }}
        className={cx(
          "pointer-events-auto group inline-flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lc-nub px-2.5 text-start text-[12px] leading-none font-semibold select-none pointer-coarse:h-9",
          chosen || open
            ? "bg-lc-titanium text-lc-chalk inset-ring inset-ring-lc-keyline hover:bg-lc-line"
            : "bg-lc-carbon/90 text-lc-fog inset-ring inset-ring-lc-line backdrop-blur-xs hover:bg-lc-titanium hover:text-lc-chalk hover:inset-ring-lc-keyline",
          MOTION,
          PRESSED_PILL,
          CURSOR_PILL,
        )}
      >
        <Icon
          name="trackCircuit"
          size="xs"
          className={cx(
            "shrink-0",
            chosen || open ? "text-lc-chalk group-focus:text-lc-void" : "text-lc-slate group-hover:text-lc-chalk group-focus:text-lc-void",
          )}
        />
        {chosen ? (
          <>
            <span className="min-w-0 truncate">{current.layout}</span>
            <span className="lc-mono shrink-0 text-[11px] font-semibold text-lc-slate group-focus:text-lc-void/70">
              {currentIndex + 1}/{layouts.length}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate">{tx("count", { count: layouts.length })}</span>
        )}
        <Icon
          name="expand"
          size="xs"
          className={cx(
            "shrink-0 transition-transform duration-200 ease-lc motion-reduce:transition-none",
            open ? "rotate-180" : undefined,
          )}
        />
      </button>

      {open && place && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={tx("list", { venue: venueName })}
              className={cx(
                "lc-pop-in fixed z-(--z-lc-notice) flex flex-col overflow-hidden rounded-lc-tile border border-white/10 bg-lc-carbon shadow-lc-pop",
                place.up ? "origin-bottom-left" : "origin-top-left",
                place.zoomed ? "lc-ui-zoom" : undefined,
              )}
              style={{
                left: place.left,
                top: place.top,
                bottom: place.bottom,
                width: place.width,
                maxHeight: place.maxHeight,
              }}
            >
              <span
                aria-hidden
                className="lc-lbl flex shrink-0 items-center justify-between gap-2 border-b border-lc-line/70 px-3 py-2"
              >
                <span className="min-w-0 truncate">{venueName}</span>
                <span className="shrink-0 text-lc-fog">{tx("count", { count: layouts.length })}</span>
              </span>
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">
                {layouts.map((l) => {
                  const isSelected = chosen && l.id === value;
                  const pb = bestLapOf?.(l.id) ?? null;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-nav-default={isSelected ? "" : undefined}
                      tabIndex={-1}
                      onPointerEnter={focusOnHover}
                      onClick={() => choose(l.id)}
                      className={cx(
                        "group flex w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-lc-nub px-2 py-2 text-start pointer-coarse:min-h-12",
                        MOTION,
                        isSelected ? CHOSEN_PILL : cx("text-lc-fog", HOVER_PILL),
                        PRESSED_PILL,
                        CURSOR_PILL,
                      )}
                    >
                      <span className="flex h-9 w-13 shrink-0 items-center justify-center rounded-lc-nub bg-lc-well/90 p-1">
                        <OutlineThumb
                          outline={l.outline}
                          className={cx(
                            "h-full w-full",
                            isSelected ? "text-lc-chalk" : "text-lc-slate group-hover:text-lc-fog group-focus:text-lc-chalk",
                          )}
                        />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[13px] leading-tight font-semibold" title={l.layout}>
                          {l.layout}
                        </span>
                        <span className="lc-mono flex min-w-0 items-center gap-1.5 text-[11px] leading-snug text-lc-slate group-focus:text-lc-void/70">
                          <span className="truncate">{lengthOf(l)}</span>
                          {pb ? (
                            <>
                              <span aria-hidden>·</span>
                              <span
                                className={cx(
                                  "shrink-0 font-semibold",
                                  pb.forCurrentCar && !pb.legacyPhysics
                                    ? "text-lc-best group-focus:text-lc-void"
                                    : "text-lc-fog group-focus:text-lc-void/80",
                                )}
                              >
                                {pb.text}
                              </span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {isSelected ? <Icon name="check" className="shrink-0" /> : null}
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};
