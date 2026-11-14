"use client";

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons/Icon";
import { focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { useRowControl, type ControlA11yProps } from "./SettingRow";
import { CHOSEN_PILL, CURSOR_PILL, cx, DISABLED, HOVER_PILL, MOTION, PRESSED_PILL, uiZoomOf } from "./styles";

export interface SelectOption<T extends string> {
  id: T;
  label: string;
  /** One short line under the label in the list */
  detail?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> extends ControlA11yProps {
  options: readonly SelectOption<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Shown when the value matches no option */
  placeholder?: string;
  forceCursor?: boolean;
  /** Width of the trigger (default 12 rem) */
  className?: string;
}

interface Place {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
  zoomed: boolean;
}

const GAP = 6;
const MARGIN = 12;

/**
 * A row control showing the current value and a chevron. It opens a list in a popover (a portal, so no card clips
 * it): up / down or the D-pad move, Enter / A chooses, Esc / B closes without changing, and the focus goes back to the
 * control. The open list runs its own navigation, so the screen below takes no input meanwhile.
 */
export function Select<T extends string>({
  options,
  value,
  onChange,
  placeholder = "Choose",
  forceCursor,
  className,
  ...a11yProps
}: SelectProps<T>) {
  const { disabled, navDefault, a11y, id } = useRowControl(a11yProps);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const valueId = useId();
  const current = options.find((o) => o.id === value);
  const valueText = current?.label ?? placeholder;

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const measure = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const zoom = uiZoomOf(t);
    const r = t.getBoundingClientRect();
    const vh = window.innerHeight;
    const below = vh - r.bottom - MARGIN;
    const above = r.top - MARGIN;
    const up = below < 240 && above > below;
    setPlace({
      left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - Math.max(r.width, 224) - MARGIN)) / zoom,
      top: up ? undefined : (r.bottom + GAP) / zoom,
      bottom: up ? (vh - r.top + GAP) / zoom : undefined,
      width: Math.max(r.width, 224) / zoom,
      maxHeight: Math.min(360, (up ? above : below) - GAP) / zoom,
      zoomed: zoom !== 1,
    });
  }, []);

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (listRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    // Esc closes the list and nothing else (in a race, Esc is also the pause key): caught before any other listener
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
  }, [open, close, measure]);

  // The open list is a screen of its own: the D-pad moves in it, A chooses, B closes
  useFocusNav(listRef, { enabled: open && place !== null, onBack: () => close() });

  const choose = (o: SelectOption<T>) => {
    if (o.disabled) return;
    if (o.id !== value) onChange(o.id);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        {...a11y}
        // The name says the value too: the row's label (or the given name) and then what it is set to
        aria-label={a11y["aria-label"] ? `${a11y["aria-label"]}: ${valueText}` : undefined}
        aria-labelledby={a11y["aria-labelledby"] ? `${a11y["aria-labelledby"]} ${valueId}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-nav-default={navDefault ? "" : undefined}
        data-cursor={forceCursor ? "" : undefined}
        onPointerEnter={focusOnHover}
        onClick={() => {
          if (!disabled) setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey && !disabled) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          "group inline-flex h-10 w-48 max-w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-full pr-3 pl-4 text-left",
          "bg-lc-titanium text-lc-chalk inset-ring inset-ring-lc-line hover:bg-lc-line hover:inset-ring-lc-keyline",
          "pointer-coarse:h-11 phone:w-full",
          open ? "bg-lc-line inset-ring-lc-keyline" : undefined,
          MOTION,
          DISABLED,
          PRESSED_PILL,
          CURSOR_PILL,
          className,
        )}
      >
        <span
          id={valueId}
          title={valueText}
          className={cx(
            "min-w-0 truncate text-[14px] font-semibold",
            // A placeholder under the cursor takes the volt pill's ink, not slate on volt
            current ? undefined : "text-lc-slate group-focus:text-lc-void/70 group-data-cursor:text-lc-void/70",
          )}
        >
          {valueText}
        </span>
        <Icon
          name="expand"
          className={cx("transition-transform duration-200 ease-lc", open ? "rotate-180" : undefined)}
        />
      </button>
      {open && place && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={a11y["aria-labelledby"] ?? id}
              aria-label={a11y["aria-label"]}
              className={cx(
                "fixed z-(--z-lc-notice) flex flex-col gap-0.5 overflow-y-auto overscroll-contain rounded-lc-tile border border-white/7 bg-lc-carbon p-1.5 shadow-lc-pop",
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
              {options.map((o) => {
                const chosen = o.id === value;
                return (
                  <button
                    key={o.id}
                    type="button"
                    role="option"
                    aria-selected={chosen}
                    aria-disabled={o.disabled || undefined}
                    tabIndex={-1}
                    onPointerEnter={focusOnHover}
                    onClick={() => choose(o)}
                    className={cx(
                      "group flex min-h-10 w-full shrink-0 cursor-pointer items-center gap-3 rounded-lc-nub px-3 py-2 text-left pointer-coarse:min-h-11",
                      MOTION,
                      DISABLED,
                      chosen ? CHOSEN_PILL : cx("text-lc-fog", HOVER_PILL),
                      PRESSED_PILL,
                      CURSOR_PILL,
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] font-semibold" title={o.label}>
                        {o.label}
                      </span>
                      {o.detail ? (
                        <span className="truncate text-[12px] leading-snug text-lc-slate group-focus:text-lc-void/70">
                          {o.detail}
                        </span>
                      ) : null}
                    </span>
                    {chosen ? <Icon name="check" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
