"use client";

import React, { useEffect, useRef } from "react";
import { focusZone, useMoveHandler } from "@/components/menu/useFocusNav";
import { CHOSEN_PILL, CURSOR_PILL, cx, GROUP_CURSOR_INK, HOVER_PILL, MOTION, PRESSED_PILL } from "./styles";

export interface NavListItem<T extends string> {
  id: T;
  label: string;
  /** Icon on the left (20 px) */
  icon?: React.ReactNode;
  /** A number after the label (settings changed, items inside) */
  count?: number;
  /** Accessible meaning of the count ("3 changed") */
  countLabel?: string;
  /** A state badge after the label, in place of the count */
  badge?: React.ReactNode;
}

export interface NavListProps<T extends string> {
  items: readonly NavListItem<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label": string;
  /** `data-nav-zone` of the list (default "nav") */
  navZone?: string;
  /** `data-nav-zone` of the pane beside it: right enters it */
  paneZone?: string;
  /** The id of the pane the list controls */
  panelId?: string;
  forceCursorOn?: T;
  className?: string;
}

/** The nearest ancestor of `el` holding the named zone, to look the pane up from the list */
function zoneRoot(el: Element | null, zone: string): Element | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (p.querySelector(`[data-nav-zone="${CSS.escape(zone)}"]`)) return p;
  }
  return null;
}

/**
 * The left column of a settings-style screen: categories with an icon, a label and a count or state. Up / down move
 * and choose; right enters the pane. The current category is chosen (white), the cursor volt. Hovering does not move
 * the cursor, since that would switch the pane under the pointer. On phones it turns into a row that scrolls sideways.
 */
export function NavList<T extends string>({
  items,
  value,
  onChange,
  navZone = "nav",
  paneZone,
  panelId,
  forceCursorOn,
  className,
  ...aria
}: NavListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const pointing = useRef(false);

  const inList = () => {
    const a = document.activeElement;
    return Boolean(a && listRef.current?.contains(a));
  };
  const enterPane = (): boolean => {
    if (!paneZone || !inList()) return false;
    return focusZone(zoneRoot(listRef.current, paneZone), paneZone);
  };
  // The D-pad's right goes into the pane at its default row, not to whatever happens to sit nearest
  useMoveHandler((dir) => (dir === "right" ? enterPane() : false));

  // Chosen from outside (a shoulder button), or a tap whose focus came late: the cursor follows the choice
  useEffect(() => {
    const list = listRef.current;
    const active = document.activeElement;
    if (!list || !active || !list.contains(active)) return;
    const item = list.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(value)}"]`);
    if (item && item !== active) item.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [value]);

  const onFocus = (id: T) => (e: React.FocusEvent<HTMLButtonElement>) => {
    if (id === value) return;
    const from = e.relatedTarget as Node | null;
    if (pointing.current || (from && listRef.current?.contains(from))) {
      onChange(id);
      return;
    }
    const current = listRef.current?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(value)}"]`);
    if (current) current.focus({ preventScroll: true });
    else onChange(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      if (enterPane()) e.preventDefault();
      return;
    }
    const keys: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, Home: -Infinity, End: Infinity };
    const d = keys[e.key];
    if (d === undefined) return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = d === -Infinity ? 0 : d === Infinity ? buttons.length - 1 : i + d;
    if (i < 0 || next < 0 || next >= buttons.length) return;
    e.preventDefault();
    buttons[next].focus({ preventScroll: true });
    buttons[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-orientation="vertical"
      {...aria}
      data-nav-zone={navZone}
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
        "flex min-w-0 flex-col gap-1",
        "phone:flex-row phone:overflow-x-auto phone:[scrollbar-width:none]",
        className,
      )}
    >
      {items.map((it) => {
        const chosen = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            data-nav-id={it.id}
            aria-selected={chosen}
            aria-controls={panelId}
            tabIndex={chosen ? 0 : -1}
            data-nav-default={chosen ? "" : undefined}
            data-cursor={forceCursorOn === it.id ? "" : undefined}
            onFocus={onFocus(it.id)}
            onClick={() => {
              if (!chosen) onChange(it.id);
            }}
            className={cx(
              "group flex min-h-12 w-full min-w-0 cursor-pointer items-center gap-3 rounded-lc-row px-3.5 text-left",
              "phone:min-h-11 phone:w-auto phone:shrink-0 phone:rounded-full phone:px-4",
              "[&_svg]:size-5 [&_svg]:shrink-0",
              MOTION,
              chosen ? CHOSEN_PILL : cx("text-lc-slate", HOVER_PILL),
              PRESSED_PILL,
              CURSOR_PILL,
            )}
          >
            {it.icon ? (
              <span
                aria-hidden
                className={cx("inline-flex", chosen ? "text-lc-chalk" : "text-lc-slate group-hover:text-lc-fog", GROUP_CURSOR_INK)}
              >
                {it.icon}
              </span>
            ) : null}
            <span className="lc-title min-w-0 flex-1 truncate text-[16px] leading-tight phone:flex-none phone:text-[15px]">
              {it.label}
            </span>
            {it.badge ? (
              <span className="inline-flex shrink-0">{it.badge}</span>
            ) : it.count ? (
              <span
                className={cx(
                  "lc-chip-text inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 tabular-nums",
                  "bg-lc-titanium text-lc-fog group-focus:bg-lc-void/15 group-focus:text-lc-void group-data-cursor:bg-lc-void/15 group-data-cursor:text-lc-void",
                )}
              >
                <span aria-hidden={it.countLabel ? true : undefined}>{it.count}</span>
                {it.countLabel ? <span className="sr-only">{it.countLabel}</span> : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
