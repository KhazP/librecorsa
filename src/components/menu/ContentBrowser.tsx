"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, EmptyState, IconButton, MediaTile, Select, TextField, type MediaTileProps } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { KeyCap, PadGlyph, PromptBar } from "@/components/ui/prompts";
import { connectedPads } from "@/lib/input/device-input";
import type { ContentLibrary, LibraryKind } from "@/lib/settings/player-settings";
import { currentInputMode, useInputMode } from "./input-mode";
import { focusables, useBackHandler, useMoveHandler, type Dir } from "./useFocusNav";
import { isMenuNavSuspended, padKey } from "./useMenuNav";

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

/**
 * A filter and its categories (Library; then groups taken from the data), drawn as one `Select`. One category is
 * picked per group and the groups narrow the list together (Germany + Hill climb + one modder). A group without an
 * `all` filter offers "Any"; picking the `all` filter lets every group's pick go.
 */
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
  /**
   * A small divider inside each group for each run of this key (a car class's years), in the order `compare` puts
   * them: it should keep a key's items together
   */
  subGroupBy?: (item: T) => string;
  /** Order of the list (inside each group) */
  compare: (a: T, b: T) => number;
  /** Heading of the single group when there is no `groupBy` */
  heading?: string;
}

export interface BrowserAction {
  label: string;
  disabled?: boolean;
  /** Already the one in use (the loaded circuit, the car driven): shown as a status with a check, not a button */
  current?: boolean;
  run: () => void;
}

/** What a card shows: the parts of a `MediaTile` */
export type BrowserCard = Pick<MediaTileProps, "media" | "title" | "meta" | "badges" | "overlay" | "aspect">;

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
  /** The card's picture, title, line of facts and badges (drawn as the kit's `MediaTile`, the star in its corner) */
  renderCard: (item: T, state: { selected: boolean }) => BrowserCard;
  /** The detail pane's content above its buttons */
  renderDetail: (item: T) => React.ReactNode;
  /** The detail pane's main button (Load circuit, Choose car) */
  primaryAction: (item: T) => BrowserAction;
  /** Ⓑ / Esc from the grid or the filters closes the browser; without it the screen's own Back runs */
  onClose?: () => void;
  /** Extra line under the grid */
  footnote?: React.ReactNode;
  /** Before the search field (a Back button) */
  toolbar?: React.ReactNode;
}

const ALL = "all";
const ANY = "any";

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

/** A labelled field of the filter bar (the label names one control: a field label, not a heading) */
const Field: React.FC<{ label: string; htmlFor: string; children: React.ReactNode; className?: string }> = ({ label, htmlFor, children, className }) => (
  <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
    <label htmlFor={htmlFor} className="lc-field-label">
      {label}
    </label>
    {children}
  </div>
);

/**
 * A content browser (Racing Line rule 6, "Lists grow"): search, filters and sort in one bar, a scrolling wall of
 * picture tiles with group headings, favourites, and a detail pane with the main action. Built to hold hundreds of
 * entries; the categories come from the caller's data.
 *
 * Input: the screen's useFocusNav moves the focus spatially, so the d-pad / arrows walk the wall in 2-D, step up into
 * the filter bar and right into the detail pane. Ⓐ / Enter on a card shows it in the detail pane and moves the focus
 * to its main action; Ⓑ / Esc in the detail pane returns to the card, then (with `onClose`) closes the browser.
 * Ⓧ / F stars the focused card, Ⓨ or / jumps to the search field.
 */
export function ContentBrowser<T>(props: ContentBrowserProps<T>) {
  const { items, idOf, sorts, filterGroups, onToggleFavorite, onClose, searchText } = props;
  const { mode, family } = useInputMode();
  const pad = mode === "pad";
  const baseId = useId();
  const [query, setQuery] = useState("");
  /** The picked category of each group, by the group's label */
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [sortId, setSortId] = useState(sorts[0]?.id ?? "");
  const [selectedId, setSelectedId] = useState<string | undefined>(props.initialSelectedId);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searched = useMemo(() => (words.length ? items.filter((i) => matches(searchText(i), words)) : items), [items, words, searchText]);
  /**
   * Each group's picked category: a pick whose category is gone (they come from the data) counts as none, and the
   * group with the `all` filter falls back to it
   */
  const pickOf = (g: BrowserFilterGroup<T>): BrowserFilter<T> | undefined =>
    g.filters.find((f) => f.id === picks[g.label]) ?? g.filters.find((f) => f.id === ALL);
  /** The picks that narrow the list (`all` does not) */
  const narrowing = filterGroups.flatMap((g) => {
    const f = pickOf(g);
    return f && f.id !== ALL ? [{ group: g.label, filter: f }] : [];
  });
  const narrowKey = narrowing.map((n) => n.filter.id).join("|");
  const visible = useMemo(
    () => (narrowing.length ? searched.filter((i) => narrowing.every((n) => n.filter.test(i))) : searched),
    // `narrowing` is rebuilt each render: its picks are in `narrowKey`, their tests in `filterGroups`
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searched, narrowKey, filterGroups]
  );
  const sort = sorts.find((s) => s.id === sortId) ?? sorts[0];

  const groups = useMemo(() => {
    const sorted = [...visible].sort(sort.compare);
    /** A group's items in runs of `subGroupBy` (one unlabelled run without it) */
    const runsOf = (list: T[]) => {
      const sub = sort.subGroupBy;
      if (!sub) return [{ key: "", items: list }];
      const runs: { key: string; items: T[] }[] = [];
      for (const it of list) {
        const k = sub(it);
        const last = runs[runs.length - 1];
        if (last && last.key === k) last.items.push(it);
        else runs.push({ key: k, items: [it] });
      }
      return runs;
    };
    if (!sort.groupBy) return sorted.length ? [{ key: "all", label: sort.heading ?? "", items: sorted, runs: runsOf(sorted) }] : [];
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
    return keys.map((k) => ({ key: k, label: k, items: byKey.get(k)!, runs: runsOf(byKey.get(k)!) }));
  }, [visible, sort]);

  // The detail pane shows a card that is in the list: the chosen one, else the first. Nothing matches the search or
  // categories: it empties too, rather than offering a hidden card's action
  const selected = visible.find((i) => idOf(i) === selectedId) ?? visible[0];
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
    setPicks({});
  };
  /** Picks a category: `all` lets every group's pick go, "Any" this group's */
  const pick = (g: BrowserFilterGroup<T>, id: string) =>
    setPicks((p) => {
      if (id === ALL) return {};
      const next = { ...p };
      if (id === ANY) delete next[g.label];
      else next[g.label] = id;
      return next;
    });

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

  const focusGrid = () => focusEl(cardOf(selectedKey) ?? gridRef.current?.querySelector<HTMLElement>("[data-browser-item]"));

  /**
   * The d-pad / arrows on a card walk the grid by rows and columns; off the grid's edge: right = detail, up = the
   * filter bar (the navigation's own search finds the nearest field).
   */
  useMoveHandler((dir: Dir) => {
    const grid = gridRef.current;
    const active = document.activeElement as HTMLElement | null;
    if (!grid || !active) return false;
    // In the detail pane left / right stay on their row (layout switch, liveries); off its left edge back to the card
    const detail = detailRef.current;
    if (detail?.contains(active) && (dir === "left" || dir === "right")) {
      // A segmented row moves its own choice
      if (active.closest('[role="radiogroup"]')) return false;
      const a = active.getBoundingClientRect();
      const ay = a.top + a.height / 2;
      const ax = a.left + a.width / 2;
      const next = focusables(detail)
        .filter((el) => el !== active)
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.top <= ay && r.bottom >= ay && (dir === "right" ? r.left + r.width / 2 > ax + 2 : r.left + r.width / 2 < ax - 2))
        .sort((x, y) => Math.abs(x.r.left - a.left) - Math.abs(y.r.left - a.left))[0];
      if (next) return focusEl(next.el);
      return dir === "left" ? focusGrid() || false : true;
    }
    // Up / down walk the pane's own controls; past its top the filter bar, past its bottom nowhere
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
      return false;
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
    if (dir === "left") return true;
    if (dir === "right") {
      focusDetail();
      return true;
    }
    if (dir === "up") return false;
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
    // Controller Ⓧ (2) and Ⓨ (3), edges only, from the pad the menus follow (a new first pad starts a new baseline)
    let raf = 0;
    let prev: boolean[] | null = null;
    let prevPad: string | null = null;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      const p = connectedPads().find((x) => x.mapping === "standard");
      if (!p) {
        prev = null;
        prevPad = null;
        return;
      }
      if (padKey(p) !== prevPad) {
        prev = null;
        prevPad = padKey(p);
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

  /** How many entries a category would show with the other groups' picks kept */
  const countOf = (g: BrowserFilterGroup<T>, f: BrowserFilter<T>) => {
    const others = narrowing.filter((n) => n.group !== g.label);
    return searched.reduce((n, i) => n + (f.test(i) && others.every((o) => o.filter.test(i)) ? 1 : 0), 0);
  };
  const filtered = query.trim() !== "" || narrowing.length > 0;
  const narrowLabels = narrowing.map((n) => n.filter.label);
  // A group with one category narrows nothing worth a control
  const shownGroups = filterGroups.filter((g) => g.filters.length > 1 || g.filters.some((f) => f.id === ALL));

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-4" role="region" aria-label={props.label}>
      {/* Search, filters and sort */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2.5" data-nav-zone="browser-filters">
        {props.toolbar ? <div className="flex items-end self-stretch">{props.toolbar}</div> : null}
        <div className="min-w-[min(100%,220px)] flex-1">
        <TextField
          {...({ ref: searchRef } as object)}
          label="Search"
          type="search"
          value={query}
          onChange={setQuery}
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
          placeholder={props.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          icon={<Icon name="search" />}
          trailing={<span className="hidden sm:inline-flex">{pad ? <PadGlyph button="y" family={family} /> : <KeyCap>/</KeyCap>}</span>}
          className="[&_input::-webkit-search-cancel-button]:hidden"
        />
        </div>
        {shownGroups.map((g, gi) => {
          const hasAll = g.filters.some((f) => f.id === ALL);
          const current = picks[g.label] && g.filters.some((f) => f.id === picks[g.label]) ? picks[g.label] : hasAll ? ALL : ANY;
          const fieldId = `${baseId}-filter-${gi}`;
          return (
            <Field key={g.label} label={g.label} htmlFor={fieldId}>
              <Select
                id={fieldId}
                aria-label={g.label}
                value={current}
                onChange={(id) => pick(g, id)}
                options={[
                  ...(hasAll ? [] : [{ id: ANY, label: `Any ${g.label.toLowerCase()}` }]),
                  ...g.filters.map((f) => {
                    const n = countOf(g, f);
                    return { id: f.id, label: f.label, detail: `${n} ${props.noun}` };
                  }),
                ]}
              />
            </Field>
          );
        })}
        {sorts.length > 1 ? (
          <Field label="Sort" htmlFor={`${baseId}-sort`}>
            <Select
              id={`${baseId}-sort`}
              aria-label="Sort"
              value={sort.id}
              onChange={setSortId}
              options={sorts.map((s) => ({ id: s.id, label: s.label }))}
            />
          </Field>
        ) : null}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-4 lg:h-[max(380px,min(760px,calc(100dvh-300px)))] lg:grid-cols-[minmax(0,1fr)_minmax(280px,320px)] xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* The wall */}
        <div
          ref={gridRef}
          data-nav-zone="browser-grid"
          data-nav-scroll
          aria-label={`${props.label}: ${visible.length} of ${items.length} ${props.noun}`}
          role="group"
          className="relative min-h-0 min-w-0 lg:-mr-1 lg:overflow-y-auto lg:pr-1 lg:[scrollbar-width:thin]"
        >
          {groups.length ? (
            groups.map((g) => (
              <section key={g.key} aria-label={g.label || undefined} className="mb-5 last:mb-1">
                {g.label ? (
                  <h3 className="m-0 mb-2.5 flex items-baseline gap-2.5">
                    <span className="lc-h3">{g.label}</span>
                    <span className="lc-mono text-[12px] text-lc-slate">{g.items.length}</span>
                  </h3>
                ) : null}
                {g.runs.map((run, ri) => (
                  <div key={`${run.key}#${ri}`} role={run.key ? "group" : undefined} aria-label={run.key || undefined} className="mb-3 last:mb-0">
                    {run.key ? <p className="lc-mono m-0 mb-2 text-[12px] text-lc-fog">{run.key}</p> : null}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(200px,calc(50%-6px)),1fr))] gap-3">
                      {run.items.map((it) => {
                        const id = idOf(it);
                        const isSel = id === selectedKey;
                        const fav = props.isFavorite(it);
                        const main = props.primaryAction(it);
                        const card = props.renderCard(it, { selected: isSel });
                        return (
                          <MediaTile
                            key={id}
                            {...card}
                            // The card in the detail pane is lit white; the cursor is volt
                            chosen={isSel}
                            aria-pressed={isSel}
                            // Entering the browser starts on the card it shows (the loaded circuit, the current car)
                            navDefault={isSel}
                            onSelect={() => choose(id)}
                            className="scroll-mt-12 scroll-mb-2"
                            controlProps={{
                              "data-browser-item": id,
                              onFocus: () => {
                                // The d-pad and arrows show what they land on; the mouse only by clicking
                                if (currentInputMode() !== "pointer" && id !== selectedKey) setSelectedId(id);
                              },
                              onDoubleClick: () => (main.disabled ? undefined : main.run()),
                            }}
                            action={
                              // A pointer shortcut: the d-pad stars with Ⓧ, so the focus skips it
                              onToggleFavorite || fav ? (
                                <IconButton
                                  size="sm"
                                  variant="secondary"
                                  tabIndex={-1}
                                  data-nav-skip=""
                                  aria-label={fav ? "Remove from favourites" : "Add to favourites"}
                                  aria-pressed={fav}
                                  disabled={!onToggleFavorite}
                                  onClick={() => onToggleFavorite?.(it)}
                                  icon={<Icon name={fav ? "favouriteOn" : "favourite"} />}
                                />
                              ) : undefined
                            }
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            ))
          ) : (
            <EmptyState
              icon={<Icon name={filtered ? "search" : "browse"} />}
              action={
                filtered ? (
                  <Button size="sm" variant="secondary" onClick={clearAll}>
                    Clear search and filters
                  </Button>
                ) : undefined
              }
            >
              {words.length ? `Nothing matches "${query.trim()}"` : `No ${props.noun} here yet`}
              {narrowLabels.length ? ` in ${narrowLabels.join(", ")}` : ""}.
              {narrowing.length === 1 && narrowing[0].filter.id === "fav" && !words.length && onToggleFavorite
                ? " Star one from its card or the detail pane."
                : ""}
            </EmptyState>
          )}
          {props.footnote}
        </div>

        {/* Detail */}
        <aside
          ref={detailRef}
          aria-label="Details"
          data-nav-zone="browser-detail"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lc-card border border-white/7 bg-lc-carbon/80"
        >
          {selected && action ? (
            <>
              <div data-nav-scroll className="flex min-h-0 flex-1 flex-col gap-4 p-4.5 [&>*]:shrink-0 phone:p-3.5 lg:overflow-y-auto lg:[scrollbar-width:thin]">
                {props.renderDetail(selected)}
              </div>
              <div className="flex shrink-0 items-center gap-2 border-t border-lc-line p-3">
                <div data-browser-primary className="flex min-w-0 flex-1 flex-col">
                  {action.current ? (
                    <div className="inline-flex h-13 items-center justify-center gap-2.5 rounded-full bg-lc-titanium text-lc-fog phone:h-11">
                      <Icon name="check" className="text-lc-chalk" />
                      <span className="lc-title text-[16px]">{action.label}</span>
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      size="lg"
                      block
                      onClick={action.run}
                      disabled={action.disabled}
                      prompt={action.disabled ? undefined : pad ? <PadGlyph button="a" family={family} /> : <KeyCap tone="ink">Enter</KeyCap>}
                    >
                      {action.label}
                    </Button>
                  )}
                </div>
                {onToggleFavorite ? (
                  // Its key (F / Ⓧ) is in the prompts under the browser
                  <IconButton
                    variant="secondary"
                    aria-pressed={selectedFav}
                    aria-label={selectedFav ? "Remove from favourites" : "Add to favourites"}
                    title={selectedFav ? "Favourite" : "Add to favourites"}
                    onClick={() => onToggleFavorite(selected)}
                    icon={<Icon name={selectedFav ? "favouriteOn" : "favourite"} />}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <p className="lc-body m-0 p-4.5">Pick a card to see it here.</p>
          )}
        </aside>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="lc-hint tabular-nums" aria-live="polite">
          {visible.length} of {items.length} {props.noun}
        </span>
        <span className="contents phone:hidden">
        <PromptBar
          rule={false}
          prompts={[
            { action: "select", label: "Details" },
            ...(onToggleFavorite ? [{ action: "select" as const, key: "F", pad: "x" as const, label: "Favourite" }] : []),
            { action: "select", key: "/", pad: "y", label: "Search" },
          ]}
        />
        </span>
      </div>
    </div>
  );
}
