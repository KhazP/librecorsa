"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Search, Star } from "lucide-react";
import { connectedPads } from "@/lib/input/device-input";
import type { ContentLibrary, LibraryKind } from "@/lib/settings/player-settings";
import { currentInputMode, useInputMode } from "./input-mode";
import { focusables, focusOnHover, useBackHandler, useMoveHandler, type Dir } from "./useFocusNav";
import { isMenuNavSuspended } from "./useMenuNav";
import { KeyCap, PadGlyph, PrimaryButton, PromptBar, Segmented } from "./menu-ui";

/** Favourites and recents handed down from the saved settings (absent: the browsers work without them) */
export interface LibraryProps {
  library: ContentLibrary;
  /** Stars / unstars an entry (a circuit venue passes all of its layout ids) */
  onToggleFavorite: (kind: LibraryKind, ids: readonly string[]) => void;
}

export interface BrowserFilter<T> {
  id: string;
  label: string;
  test: (item: T) => boolean;
}

/** A heading in the filter column and its categories (Library; then groups taken from the data) */
export interface BrowserFilterGroup<T> {
  label: string;
  filters: BrowserFilter<T>[];
}

export interface BrowserSort<T> {
  id: string;
  label: string;
  /** Sorted into headed groups by this key, in `groupOrder` (unknown keys after, A–Z) */
  groupBy?: (item: T) => string;
  groupOrder?: readonly string[];
  /** Order of the list (inside each group) */
  compare: (a: T, b: T) => number;
  /** Heading of the single group when there is no `groupBy` */
  heading?: string;
}

export interface BrowserAction {
  label: string;
  disabled?: boolean;
  run: () => void;
}

export interface ContentBrowserProps<T> {
  /** Accessible name ("Circuits") */
  label: string;
  /** Count wording: "11 of 11 venues" */
  noun: string;
  items: readonly T[];
  idOf: (item: T) => string;
  /** Everything a search may match (name, class, country…) */
  searchText: (item: T) => string;
  searchPlaceholder: string;
  filterGroups: BrowserFilterGroup<T>[];
  sorts: BrowserSort<T>[];
  /** Shown in the detail pane at first (the current car, the loaded circuit) */
  initialSelectedId?: string;
  isFavorite: (item: T) => boolean;
  onToggleFavorite?: (item: T) => void;
  /** The card's content; its top-right corner is left for the star */
  renderCard: (item: T, state: { selected: boolean }) => React.ReactNode;
  /** The detail pane's content above its buttons */
  renderDetail: (item: T) => React.ReactNode;
  /** The detail pane's main button (Load circuit, Drive this car) */
  primaryAction: (item: T) => BrowserAction;
  /** Ⓑ / Esc from the grid or the filters closes the browser; without it the screen's own Back runs */
  onClose?: () => void;
  /** Extra line under the grid */
  footnote?: React.ReactNode;
  /** Before the search field (a Back button) */
  toolbar?: React.ReactNode;
}

const ALL = "all";

/** Every word of the query appears in the item's text */
const matches = (text: string, words: string[]) => {
  const hay = text.toLowerCase();
  return words.every((w) => hay.includes(w));
};

const focusEl = (el: HTMLElement | null | undefined): boolean => {
  if (!el) return false;
  (el.focus as (o?: { preventScroll?: boolean; focusVisible?: boolean }) => void)({ preventScroll: true, focusVisible: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
};

const isTyping = (el: Element | null) =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(el.type));

/**
 * A content browser (Racing Line rule 6, "Lists grow"): search, sort, categories with live counts, a scrolling grid
 * of cards with sticky group headings, favourites, and a detail pane with the main action. Built to hold hundreds of
 * entries; the categories come from the caller's data.
 *
 * Input: the screen's useFocusNav moves the focus spatially, so the d-pad / arrows walk the grid in 2-D, step left
 * into the categories and right into the detail pane. Ⓐ / Enter on a card shows it in the detail pane and moves the
 * focus to its main action; Ⓑ / Esc in the detail pane returns to the card, then (with `onClose`) closes the browser.
 * Ⓧ / F stars the focused card, Ⓨ or / jumps to the search field.
 */
export function ContentBrowser<T>(props: ContentBrowserProps<T>) {
  const { items, idOf, sorts, filterGroups, onToggleFavorite, onClose, searchText } = props;
  const { mode, family } = useInputMode();
  const pad = mode === "pad";
  const [query, setQuery] = useState("");
  const [filterId, setFilterId] = useState(ALL);
  const [sortId, setSortId] = useState(sorts[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState<string | undefined>(props.initialSelectedId);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const filtersRef = useRef<HTMLElement | null>(null);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searched = useMemo(() => (words.length ? items.filter((i) => matches(searchText(i), words)) : items), [items, words, searchText]);
  const allFilters = filterGroups.flatMap((g) => g.filters);
  const filter = allFilters.find((f) => f.id === filterId) ?? allFilters[0];
  const visible = useMemo(() => (filter ? searched.filter(filter.test) : searched), [searched, filter]);
  const sort = sorts.find((s) => s.id === sortId) ?? sorts[0];

  const groups = useMemo(() => {
    const sorted = [...visible].sort(sort.compare);
    if (!sort.groupBy) return sorted.length ? [{ key: "all", label: sort.heading ?? "", items: sorted }] : [];
    const byKey = new Map<string, T[]>();
    for (const it of sorted) {
      const k = sort.groupBy(it);
      byKey.set(k, [...(byKey.get(k) ?? []), it]);
    }
    const order = sort.groupOrder ?? [];
    const keys = [...byKey.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
      return a.localeCompare(b);
    });
    return keys.map((k) => ({ key: k, label: k, items: byKey.get(k)! }));
  }, [visible, sort]);

  const selected = items.find((i) => idOf(i) === selectedId) ?? visible[0] ?? items[0];
  const selectedKey = selected ? idOf(selected) : undefined;
  const action = selected ? props.primaryAction(selected) : null;
  const selectedFav = selected ? props.isFavorite(selected) : false;

  const cardOf = (id: string | undefined) =>
    id ? gridRef.current?.querySelector<HTMLElement>(`[data-browser-item="${CSS.escape(id)}"]`) : null;

  /** The detail pane's main button, or its first control when that is disabled (already the active one) */
  const focusDetail = () => {
    const d = detailRef.current;
    if (!d) return;
    const main = d.querySelector<HTMLButtonElement>("[data-browser-primary] button");
    if (main && !main.disabled) focusEl(main);
    else focusEl(focusables(d)[0]);
  };

  const choose = (id: string) => {
    flushSync(() => setSelectedId(id));
    // A pointer clicks the button itself; a pad or the keyboard is taken to it
    if (currentInputMode() !== "pointer") return focusDetail();
    // On a phone the detail pane sits under the grid: show it
    const d = detailRef.current;
    const g = gridRef.current;
    if (d && g && d.getBoundingClientRect().top >= g.getBoundingClientRect().bottom - 1) d.scrollIntoView({ block: "nearest" }); // instant: a touch gesture would cancel a smooth scroll
  };

  const clearAll = () => {
    setQuery("");
    setFilterId(ALL);
  };

  // Ⓑ / Esc: detail → its card → close
  useBackHandler(() => {
    const root = rootRef.current;
    const active = document.activeElement;
    if (!root || !active || !root.contains(active)) return false;
    if (detailRef.current?.contains(active)) {
      if (!focusEl(cardOf(selectedKey))) focusEl(gridRef.current ? focusables(gridRef.current)[0] : null);
      return true;
    }
    if (onClose) {
      onClose();
      return true;
    }
    return false;
  });

  /** The filter column's entry: the open category */
  const focusFilters = () => {
    const nav = filtersRef.current;
    return focusEl(nav?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? (nav ? focusables(nav)[0] : null));
  };
  const focusGrid = () => focusEl(cardOf(selectedKey) ?? gridRef.current?.querySelector<HTMLElement>("[data-browser-item]"));

  /**
   * The d-pad / arrows on a card walk the grid by rows and columns (the nearest-box search would take a category or
   * the search field that overlaps the row); off the grid's edge: left = categories, right = detail, up = search.
   */
  useMoveHandler((dir: Dir) => {
    const grid = gridRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!grid || !active) return false;
    // From the category column (when it is a column) right goes back into the grid
    if (filtersRef.current?.contains(active)) {
      if (dir !== "right" || getComputedStyle(filtersRef.current).flexDirection !== "column") return false;
      return focusGrid() || false;
    }
    // In the detail pane left / right stay on their row (layout switch, liveries); off its left edge back to the card
    const detail = detailRef.current;
    if (detail?.contains(active) && (dir === "left" || dir === "right")) {
      const a = active.getBoundingClientRect();
      const ay = a.top + a.height / 2;
      const ax = a.left + a.width / 2;
      const next = focusables(detail)
        .filter((el) => el !== active)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.top <= ay && r.bottom >= ay && (dir === "right" ? r.left + r.width / 2 > ax + 2 : r.left + r.width / 2 < ax - 2))
        .sort((x, y) => Math.abs(x.r.left - a.left) - Math.abs(y.r.left - a.left))[0];
      if (next) return focusEl(next.el);
      return dir === "left" ? focusGrid() || focusFilters() || false : true;
    }
    // Up / down walk the pane's own controls; past its top the sort, past its bottom nowhere
    if (detail?.contains(active)) {
      const a = active.getBoundingClientRect();
      const ax = a.left + a.width / 2;
      const ahead = focusables(detail)
        .filter((el) => el !== active)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => (dir === "down" ? r.top >= a.bottom - 2 : r.bottom <= a.top + 2));
      if (ahead.length) {
        const edge = dir === "down" ? Math.min(...ahead.map(({ r }) => r.top)) : Math.max(...ahead.map(({ r }) => r.bottom));
        const row = ahead.filter(({ r }) => Math.abs((dir === "down" ? r.top : r.bottom) - edge) < 8);
        row.sort((x, y) => Math.abs(x.r.left + x.r.width / 2 - ax) - Math.abs(y.r.left + y.r.width / 2 - ax));
        return focusEl(row[0].el);
      }
      if (dir === "down") return true;
      // Stacked under the grid (phones): up returns to the card
      if (detail.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom - 1) return focusGrid() || true;
      return focusEl(rootRef.current?.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Sort"] [aria-checked="true"]') ?? searchRef.current);
    }
    if (!active.hasAttribute("data-browser-item") || !grid.contains(active)) return false;
    const a = active.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const others = Array.from(grid.querySelectorAll<HTMLElement>("[data-browser-item]"))
      .filter((c) => c !== active)
      .map((c) => ({ c, r: c.getBoundingClientRect() }));
    let target: HTMLElement | null = null;
    if (dir === "left" || dir === "right") {
      const row = others.filter(({ r }) => r.top < a.bottom - 4 && r.bottom > a.top + 4);
      const ahead = row
        .map(({ c, r }) => ({ c, d: dir === "right" ? r.left - a.left : a.left - r.left }))
        .filter((x) => x.d > 2)
        .sort((x, y) => x.d - y.d);
      target = ahead[0]?.c ?? null;
    } else {
      const ahead = others.filter(({ r }) => (dir === "down" ? r.top > a.top + 4 : r.top < a.top - 4));
      if (ahead.length) {
        const rowTop = dir === "down" ? Math.min(...ahead.map(({ r }) => r.top)) : Math.max(...ahead.map(({ r }) => r.top));
        const row = ahead.filter(({ r }) => Math.abs(r.top - rowTop) < 4);
        row.sort((x, y) => Math.abs(x.r.left + x.r.width / 2 - ax) - Math.abs(y.r.left + y.r.width / 2 - ax));
        target = row[0]?.c ?? null;
      }
    }
    if (target) return focusEl(target);
    if (dir === "left") return focusFilters() || false;
    if (dir === "right") {
      focusDetail();
      return true;
    }
    if (dir === "up") return focusEl(searchRef.current);
    // Below the last row: the detail pane where it is stacked under the grid (phones), else stay
    const d = detailRef.current;
    if (d && d.getBoundingClientRect().top >= grid.getBoundingClientRect().bottom - 1) focusDetail();
    return true;
  });

  // Ⓧ / F stars the focused card (or the one in the detail pane); Ⓨ / "/" goes to the search
  const live = useRef({ toggle: (_id: string | undefined) => {}, selectedKey });
  live.current = {
    selectedKey,
    toggle: (id) => {
      const item = id ? items.find((i) => idOf(i) === id) : undefined;
      if (item) onToggleFavorite?.(item);
    },
  };
  useEffect(() => {
    const inside = () => {
      const a = document.activeElement;
      return Boolean(a && rootRef.current?.contains(a));
    };
    const star = () => {
      const a = document.activeElement as HTMLElement | null;
      const card = a?.closest<HTMLElement>("[data-browser-item]")?.dataset.browserItem;
      live.current.toggle(card ?? (detailRef.current?.contains(a) ? live.current.selectedKey : undefined));
    };
    const toSearch = () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isMenuNavSuspended() || e.defaultPrevented || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      if (isTyping(e.target as Element | null) || !inside()) return;
      if (e.code === "KeyF") {
        e.preventDefault();
        star();
      } else if (e.code === "Slash") {
        e.preventDefault();
        toSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    // Controller Ⓧ (2) and Ⓨ (3), edges only
    let raf = 0;
    let prev: boolean[] | null = null;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const p = connectedPads().find((x) => x.mapping === "standard");
      if (!p) {
        prev = null;
        return;
      }
      const now = [Boolean(p.buttons[2]?.pressed), Boolean(p.buttons[3]?.pressed)];
      if (prev && !isMenuNavSuspended() && inside()) {
        if (now[0] && !prev[0] && !isTyping(document.activeElement)) star();
        if (now[1] && !prev[1]) toSearch();
      }
      prev = now;
    };
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
    };
  }, []);

  const countOf = (f: BrowserFilter<T>) => searched.reduce((n, i) => n + (f.test(i) ? 1 : 0), 0);
  const filtered = query.trim() !== "" || (filter && filter.id !== ALL);

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-3.5" role="region" aria-label={props.label}>
      {/* Search, count and sort */}
      <div className="flex flex-wrap items-center gap-2.5">
        {props.toolbar}
        <label className="flex h-11 min-w-[min(100%,220px)] flex-1 items-center gap-2.5 rounded-full border border-[#262B3D] bg-[#08090D]/80 pr-2 pl-4 transition-colors focus-within:border-[#CCFF00]">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-[#8E96AA]" strokeWidth={2.4} />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                focusEl(gridRef.current?.querySelector<HTMLElement>("[data-browser-item]"));
              } else if (e.key === "Escape" && query) {
                // First Esc clears the search; the next one leaves the field
                e.preventDefault();
                setQuery("");
              }
            }}
            aria-label={`Search ${props.label.toLowerCase()}`}
            placeholder={props.searchPlaceholder}
            autoComplete="off"
            spellCheck={false}
            className="h-10 min-w-0 flex-1 border-0 bg-transparent text-[15px] font-medium text-[#F5F7FA] outline-none placeholder:text-[#8E96AA] focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          <span className="hidden sm:inline-flex">{pad ? <PadGlyph button="y" family={family} /> : <KeyCap>/</KeyCap>}</span>
        </label>
        {sorts.length > 1 ? (
          <Segmented
            label="Sort"
            className="w-full shrink-0 sm:w-auto [&>button]:px-3.5 [&>button]:whitespace-nowrap"
            options={sorts.map((s) => ({ id: s.id, label: s.label }))}
            value={sort.id}
            onChange={setSortId}
          />
        ) : null}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-3.5 md:grid-cols-[176px_minmax(0,1fr)] lg:h-[max(360px,min(640px,calc(100dvh-420px)))] lg:grid-cols-[180px_minmax(0,1fr)_minmax(240px,280px)]">
        {/* Categories: a column on wide screens, a scrolling pill row on phones */}
        <nav
          ref={filtersRef}
          aria-label="Categories"
          data-nav-zone="browser-filters"
          data-nav-scroll
          className="-mx-1 flex min-h-0 gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0.5 md:overflow-x-visible md:overflow-y-auto md:px-0 md:pr-1 md:[scrollbar-width:thin]"
        >
          {filterGroups.map((g, gi) => (
            <div key={g.label} className="contents md:flex md:flex-col md:gap-0.5">
              <span className={`lc-lbl hidden px-3 pb-1.5 text-[10px] md:block ${gi ? "pt-3.5" : "pt-0.5"}`}>{g.label}</span>
              {g.filters.map((f) => {
                const on = f.id === filter?.id;
                const n = countOf(f);
                return (
                  <button
                    key={f.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setFilterId(f.id)}
                    onPointerEnter={focusOnHover}
                    className={`group flex min-h-[36px] shrink-0 cursor-pointer items-center gap-2.5 rounded-full px-3.5 text-left text-[14px] font-semibold whitespace-nowrap outline-none transition-[background-color,box-shadow,color] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:bg-[#CCFF00] focus:text-[#08090D] focus:shadow-[0_0_0_5px_rgba(204,255,0,0.12)] md:w-full md:min-h-[38px] md:px-3 ${
                      on
                        ? "bg-[#00E5FF]/10 text-[#F5F7FA] shadow-[inset_0_0_0_1px_rgba(0,229,255,0.45)]"
                        : `bg-transparent hover:bg-white/[0.04] ${n ? "text-[#C5CBD8]" : "text-[#8E96AA]"} max-md:shadow-[inset_0_0_0_1px_#262B3D]`
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{f.label}</span>
                    <span className={`lc-data text-[11px] group-focus:text-[#08090D] ${on ? "text-[#00E5FF]" : "text-[#8E96AA]"}`}>{n}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Grid */}
        <div
          ref={gridRef}
          data-nav-zone="browser-grid"
          data-nav-scroll
          aria-label={`${props.label}: ${visible.length} of ${items.length} ${props.noun}`}
          role="group"
          className="relative min-h-0 min-w-0 pr-1 lg:overflow-y-auto lg:[scrollbar-color:#3A4157_transparent] lg:[scrollbar-width:thin]"
        >
          {groups.length ? (
            groups.map((g) => (
              <section key={g.key} aria-label={g.label || undefined} className="mb-4 last:mb-1">
                {g.label ? (
                  <div className="sticky top-0 z-[2] -mx-0.5 mb-2 flex items-center gap-2.5 bg-[#08090D]/90 px-1.5 py-2 backdrop-blur-sm">
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#CCFF00]" />
                    <span className="lc-lbl text-[#F5F7FA]">{g.label}</span>
                    <span className="lc-data text-[11px] text-[#8E96AA]">{g.items.length}</span>
                    <span aria-hidden className="h-px flex-1 bg-[#262B3D]" />
                  </div>
                ) : null}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(168px,calc(50%-5px)),1fr))] gap-2.5">
                  {g.items.map((it) => {
                    const id = idOf(it);
                    const isSel = id === selectedKey;
                    const fav = props.isFavorite(it);
                    const main = props.primaryAction(it);
                    return (
                      <div key={id} className="relative min-w-0">
                        <button
                          type="button"
                          data-browser-item={id}
                          aria-pressed={isSel}
                          onPointerEnter={focusOnHover}
                          onFocus={() => {
                            // The d-pad and arrows show what they land on; the mouse only by clicking
                            if (currentInputMode() !== "pointer" && id !== selectedKey) setSelectedId(id);
                          }}
                          onClick={() => choose(id)}
                          onDoubleClick={() => (main.disabled ? undefined : main.run())}
                          className={`group flex h-full w-full min-w-0 cursor-pointer scroll-mt-12 scroll-mb-2 flex-col rounded-[18px] border bg-[#11131A] text-left text-[#F5F7FA] outline-none transition-[background-color,border-color,box-shadow] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] focus:border-[#CCFF00] focus:bg-[#1B1F2B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#CCFF00] ${
                            isSel ? "border-[#CCFF00] shadow-[inset_0_0_0_1px_#CCFF00,0_0_0_5px_rgba(204,255,0,0.1)]" : "border-[#262B3D] hover:border-[#3A4157]"
                          }`}
                        >
                          {props.renderCard(it, { selected: isSel })}
                        </button>
                        {/* A pointer shortcut: the d-pad stars with Ⓧ, so the focus skips it */}
                        {onToggleFavorite || fav ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            data-nav-skip
                            aria-label={fav ? "Remove from favourites" : "Add to favourites"}
                            aria-pressed={fav}
                            disabled={!onToggleFavorite}
                            onClick={() => onToggleFavorite?.(it)}
                            className={`absolute top-2 right-2 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-[#08090D]/80 transition-colors disabled:cursor-default ${
                              fav ? "text-[#FFB300]" : "text-[#8E96AA] hover:text-[#F5F7FA]"
                            }`}
                          >
                            <Star aria-hidden className="h-3.5 w-3.5" strokeWidth={2.4} fill={fav ? "currentColor" : "none"} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))
          ) : (
            <div className="flex flex-col items-start gap-3 px-1 py-6">
              <p className="m-0 text-[14px] leading-relaxed text-[#C5CBD8]">
                {words.length ? `Nothing matches “${query.trim()}”` : `No ${props.noun} here yet`}
                {filter && filter.id !== ALL ? ` in ${filter.label}` : ""}.
                {filter?.id === "fav" && !words.length && onToggleFavorite ? " Star one from its card or the detail pane." : ""}
              </p>
              {filtered ? (
                <button
                  type="button"
                  onClick={clearAll}
                  onPointerEnter={focusOnHover}
                  className="inline-flex h-10 cursor-pointer items-center rounded-full border border-[#262B3D] bg-[#1B1F2B]/80 px-4 text-[13px] font-bold text-[#F5F7FA] transition-colors hover:border-[#3A4157]"
                >
                  Clear search and filters
                </button>
              ) : null}
            </div>
          )}
          {props.footnote}
        </div>

        {/* Detail */}
        <aside
          ref={detailRef}
          aria-label="Details"
          data-nav-zone="browser-detail"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[18px] border border-[#262B3D] bg-[#11131A] md:col-span-2 lg:col-span-1"
        >
          {selected && action ? (
            <>
              <div data-nav-scroll className="flex min-h-0 flex-1 flex-col gap-3.5 p-4 lg:overflow-y-auto lg:[scrollbar-width:thin]">
                {props.renderDetail(selected)}
              </div>
              <div className="flex shrink-0 flex-col gap-2 border-t border-[#262B3D] p-3">
                <div data-browser-primary className="flex flex-col [&>button]:w-full [&>button]:justify-center">
                  <PrimaryButton
                    onClick={action.run}
                    disabled={action.disabled}
                    prompt={action.disabled ? undefined : pad ? <PadGlyph button="a" family={family} /> : "ENTER"}
                  >
                    {action.label}
                  </PrimaryButton>
                </div>
                {onToggleFavorite ? (
                  <button
                    type="button"
                    aria-pressed={selectedFav}
                    onClick={() => onToggleFavorite(selected)}
                    onPointerEnter={focusOnHover}
                    className="inline-flex h-10 w-full shrink-0 cursor-pointer items-center justify-center gap-2.5 rounded-full border border-[#262B3D] bg-[#1B1F2B]/80 px-4 text-[#F5F7FA] transition-colors hover:border-[#3A4157] hover:bg-[#262B3D]"
                  >
                    {pad ? <PadGlyph button="x" family={family} /> : <KeyCap>F</KeyCap>}
                    <Star
                      aria-hidden
                      className={`h-4 w-4 ${selectedFav ? "text-[#FFB300]" : "text-[#8E96AA]"}`}
                      strokeWidth={2.4}
                      fill={selectedFav ? "currentColor" : "none"}
                    />
                    <span className="lc-title text-[14px]">{selectedFav ? "Favourite" : "Add to favourites"}</span>
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="m-0 p-4 text-[14px] text-[#8E96AA]">Pick a card to see it here.</p>
          )}
        </aside>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="lc-data text-[12px] text-[#8E96AA]">
          {visible.length} OF {items.length} {props.noun.toUpperCase()}
        </span>
        <PromptBar
          className="gap-x-4"
          prompts={[
            { action: "select", label: "Details" },
            ...(onToggleFavorite ? [{ action: "select" as const, key: "F", pad: "x" as const, label: "Favourite" }] : []),
            { action: "select", key: "/", pad: "y", label: "Search" },
          ]}
        />
      </div>
    </div>
  );
}
