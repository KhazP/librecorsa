"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl/react";
import { focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { Icon } from "@/components/ui/icons/Icon";
import { CHOSEN_PILL, CURSOR_PILL, cx, HOVER_PILL, MOTION, PRESSED_PILL, uiZoomOf } from "@/components/ui/styles";
import type { HomeLivery } from "./home-data";

export interface CarLiveryPickerProps {
  carTitle: string;
  liveries: readonly HomeLivery[];
  /** Currently active livery / skin id (or `"custom"` for saved F1 custom paint) */
  value: string;
  /** CSS swatch background when `value === "custom"` */
  customSwatch?: string;
  /** Fallback car picture if a livery thumbnail fails to load */
  fallbackThumb?: string | null;
  /** Whether this car is the currently selected car */
  chosen: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (liveryId: string) => void;
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
const EST_ROW_H = 52;
const EST_CHROME_H = 44;

const LiveryRowThumb: React.FC<{ src: string | null; fallbackSrc?: string | null; swatch: string }> = ({
  src,
  fallbackSrc,
  swatch,
}) => {
  const [failed, setFailed] = useState(false);
  const imgSrc = !failed ? (src ?? fallbackSrc ?? null) : null;
  return (
    <span className="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lc-nub bg-lc-well/90 p-0.5">
      {imgSrc ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imgSrc}
          alt=""
          width={128}
          height={72}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span aria-hidden className="h-4 w-9 rounded-full inset-ring inset-ring-white/20" style={{ background: swatch }} />
      )}
    </span>
  );
};

/**
 * Compact livery badge and viewport-aware popover anchored along the bottom of a car card's picture frame.
 * Matches `VenueLayoutPicker`: shows how many liveries a car has before pressing, updates in place to the active
 * livery once chosen without shifting any grid row, and opens a scrollable list with mini thumbnails and swatches.
 */
export const CarLiveryPicker: React.FC<CarLiveryPickerProps> = ({
  carTitle,
  liveries,
  value,
  customSwatch,
  fallbackThumb,
  chosen,
  open,
  onOpenChange,
  onSelect,
}) => {
  const tx = useTranslations("home.liveryPicker");
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const isCustom = value === "custom";
  const foundIndex = liveries.findIndex((l) => l.id === value);
  const currentIndex = foundIndex >= 0 ? foundIndex : 0;
  const current = liveries[currentIndex] ?? liveries[0];

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
    const card = t.closest<HTMLElement>("[data-car-card]");
    const anchor = card ? card.getBoundingClientRect() : r;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(anchor.width, 280), 348, vw - 2 * MARGIN);
    const needed = Math.min(MAX_POPOVER_H, liveries.length * EST_ROW_H + EST_CHROME_H) * zoom;
    const below = vh - r.bottom - MARGIN;
    const above = r.top - MARGIN;
    const up = below < needed && above > below;
    setPlace({
      left: Math.max(MARGIN, Math.min(anchor.left, vw - width - MARGIN)) / zoom,
      top: up ? undefined : (r.bottom + GAP) / zoom,
      bottom: up ? (vh - r.top + GAP) / zoom : undefined,
      width: width / zoom,
      maxHeight: Math.max(140, Math.min(MAX_POPOVER_H, (up ? above : below) - GAP)) / zoom,
      up,
      zoomed: zoom !== 1,
    });
  }, [liveries.length]);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      // Clicking the same chosen car's primary tile button toggles via its own onClick instead of close+reopen
      if (chosen && target instanceof Element) {
        const card = triggerRef.current?.closest("[data-car-card]");
        const tileBtn = card?.querySelector("[data-car-tile-btn]");
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

  const activeName = isCustom ? tx("custom") : current.name;
  const activeSwatch = isCustom && customSwatch ? customSwatch : current.swatch;

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
            ? isCustom
              ? tx("chosenCustom", { car: carTitle, count: liveries.length })
              : tx("chosen", { car: carTitle, livery: current.name, index: String(currentIndex + 1), count: String(liveries.length) })
            : tx("closed", { car: carTitle, count: liveries.length })
        }
        // Spatial arrows/D-pad skip unselected cars' pills so browsing stays one press per card; Tab, click and tap always work
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
        {chosen ? (
          <>
            <span
              aria-hidden
              className="h-2.5 w-4 shrink-0 rounded-full inset-ring inset-ring-white/25"
              style={{ background: activeSwatch }}
            />
            <span className="min-w-0 truncate">{activeName}</span>
            {!isCustom ? (
              <span className="lc-mono shrink-0 text-[11px] font-semibold text-lc-slate group-focus:text-lc-void/70">
                {currentIndex + 1}/{liveries.length}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <Icon
              name="livery"
              size="xs"
              className={cx(
                "shrink-0",
                open ? "text-lc-chalk group-focus:text-lc-void" : "text-lc-slate group-hover:text-lc-chalk group-focus:text-lc-void",
              )}
            />
            <span className="min-w-0 truncate">{tx("count", { count: liveries.length })}</span>
          </>
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
              aria-label={tx("list", { car: carTitle })}
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
                <span className="min-w-0 truncate">{carTitle}</span>
                <span className="shrink-0 text-lc-fog">{tx("count", { count: liveries.length })}</span>
              </span>
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1.5">
                {liveries.map((liv, idx) => {
                  const isSelected = chosen && !isCustom && liv.id === value;
                  const showGroup = liv.group && liv.group !== liveries[idx - 1]?.group;
                  return (
                    <React.Fragment key={liv.id}>
                      {showGroup ? (
                        <span
                          aria-hidden
                          className={cx(
                            "lc-lbl shrink-0 px-2 pb-1",
                            idx > 0 ? "mt-1.5 border-t border-lc-line/60 pt-2" : "pt-0.5",
                          )}
                        >
                          {liv.group}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        data-nav-default={isSelected ? "" : undefined}
                        tabIndex={-1}
                        onPointerEnter={focusOnHover}
                        onClick={() => choose(liv.id)}
                        className={cx(
                          "group flex w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-lc-nub px-2 py-1.5 text-start pointer-coarse:min-h-12",
                          MOTION,
                          isSelected ? CHOSEN_PILL : cx("text-lc-fog", HOVER_PILL),
                          PRESSED_PILL,
                          CURSOR_PILL,
                        )}
                      >
                        <LiveryRowThumb src={liv.thumb} fallbackSrc={fallbackThumb} swatch={liv.swatch} />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              aria-hidden
                              className="h-2.5 w-3.5 shrink-0 rounded-full inset-ring inset-ring-white/20"
                              style={{ background: liv.swatch }}
                            />
                            <span className="min-w-0 truncate text-[13px] leading-tight font-semibold" title={liv.name}>
                              {liv.name}
                            </span>
                          </span>
                          {liv.detail ? (
                            <span className="truncate text-[11px] leading-snug text-lc-slate group-focus:text-lc-void/70">
                              {liv.detail}
                            </span>
                          ) : null}
                        </span>
                        {isSelected ? <Icon name="check" className="shrink-0" /> : null}
                      </button>
                    </React.Fragment>
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
