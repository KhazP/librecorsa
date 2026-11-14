"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { currentInputMode, useInputMode } from "@/components/menu/input-mode";
import { focusables, focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { SourceChip } from "@/components/SourceChip";
import { Button, EmptyState, MediaTile, Segmented, Select, Tabs } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { KeyCap, PadGlyph, PromptBar, type Prompt } from "@/components/ui/prompts";
import { CURSOR_TILE, cx, MOTION } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";
import { useSavedInterfaceSettings, useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn, SPEED_LABEL, speedIn } from "@/lib/settings/units";
import { SITE_DESCRIPTION } from "@/lib/site";
import { day, GAME_FACTS, GRADE_NOTES, type HomeData, type HomeLayout, type HomeVenue } from "./home-data";
import { CarThumb, GradeBadge, GradeLegend, OutlineThumb } from "./home-ui";
import { LapMap } from "./LapMap";
import { PLAY_HREF, rememberPicks, storedPicks } from "./play";
import { TEXT_LINK } from "./SitePage";

/*
 * The home page, laid out like a console racer's home hub. Sections across the top (Q / E, or a controller's
 * bumpers), big picture tiles underneath: Drive takes most of the screen, the circuit's lap runs in its own tile, the
 * car and the press sit beside it. Circuits and Cars are walls of picture tiles to pick from, each marked sim grade or
 * 3D model; Drive stays in the corner of every section and opens the game (/play) on the picks.
 *
 * A controller or the keyboard drives it like the game's own menus (useFocusNav): the D-pad, stick or arrows move a
 * volt cursor between tiles and cards, A / Enter picks, B / Esc goes back to Home, LB / RB or Q / E switch sections
 * and Start drives.
 */

type Tab = "home" | "circuits" | "cars" | "about";
const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "circuits", label: "Circuits" },
  { id: "cars", label: "Cars" },
  { id: "about", label: "About" },
];

const GUTTER =
  "pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))]";
/**
 * A tile of the Home section: the card surface, its edge lighting under the pointer, the volt edge and halo under the
 * cursor (the kit's tile cursor)
 */
const TILE = cx(
  "group relative overflow-hidden rounded-lc-card border-[1.5px] border-lc-line bg-lc-carbon text-left text-lc-chalk no-underline hover:border-lc-keyline",
  MOTION,
  CURSOR_TILE,
);
/** A tile's way on ("Change circuit") */
const MORE = "inline-flex items-center gap-1 text-[13px] font-semibold text-lc-fog transition-colors duration-200 group-hover:text-lc-chalk group-focus:text-lc-chalk";
/** The titles of the smaller Home tiles */
const TILE_TITLE = "lc-disp text-[22px] leading-[1.05]";
/** The page's panel id, which the tabs control and the skip link lands on */
const PANEL_ID = "home-panel";

/** The Circuits filters: one pick each, narrowing the wall together */
type VenueFilterKey = "type" | "country" | "modder";
const VENUE_FILTERS: readonly { key: VenueFilterKey; all: string; label: string; of: (v: HomeVenue) => readonly string[] }[] = [
  { key: "type", all: "All types", label: "Type", of: (v) => v.types },
  { key: "country", all: "All locations", label: "Location", of: (v) => [v.country] },
  { key: "modder", all: "All modders", label: "Modder", of: (v) => v.modders },
];
const NO_VENUE_FILTERS: Record<VenueFilterKey, string> = { type: "", country: "", modder: "" };

export const HomeHub: React.FC<{ data: HomeData }> = ({ data }) => {
  const [tab, setTab] = useState<Tab>("home");
  const [layoutId, setLayoutId] = useState(data.defaultTrackId);
  const [carId, setCarId] = useState(data.defaultCarId);
  const { mode, family } = useInputMode();
  const pad = mode === "pad";
  useSavedInterfaceSettings();
  const units = useUnits();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const driveRef = useRef<HTMLAnchorElement | null>(null);
  /** Set when a section is opened from the controller or keys: the cursor moves into it once it has rendered */
  const focusOnOpen = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);

  // A returning player's last circuit and car (the page is built with the defaults)
  useEffect(() => {
    const { trackId, carId: stored } = storedPicks();
    if (trackId && data.venues.some((v) => v.layouts.some((l) => l.id === trackId))) setLayoutId(trackId);
    if (stored && data.cars.some((c) => c.id === stored)) setCarId(stored);
  }, [data.venues, data.cars]);

  const [venueFilters, setVenueFilters] = useState(NO_VENUE_FILTERS);
  /** The venues the filters leave, `except` one of them (for that filter's own options and their counts) */
  const venuesWith = (except?: VenueFilterKey) =>
    data.venues.filter((v) => VENUE_FILTERS.every((f) => f.key === except || !venueFilters[f.key] || f.of(v).includes(venueFilters[f.key])));
  const shownVenues = venuesWith();
  const venuesFiltered = VENUE_FILTERS.some((f) => venueFilters[f.key]);

  const venue = data.venues.find((v) => v.layouts.some((l) => l.id === layoutId)) ?? data.venues[0];
  const layout = venue.layouts.find((l) => l.id === layoutId) ?? venue.layouts[0];
  const car = data.cars.find((c) => c.id === carId) ?? data.cars[0];
  const picks = { trackId: layout.id, carId: car.id };
  /** A layout's length and corners, in the player's units */
  const lengthOf = (l: HomeLayout) =>
    `${distanceIn(l.lengthM / 1000, units.speed).toFixed(2)} ${DISTANCE_LABEL[units.speed]}, ${l.turns} turns`;

  const go = useCallback((next: Tab, moveCursor = false) => {
    focusOnOpen.current = moveCursor && currentInputMode() !== "pointer";
    setTab(next);
    panelRef.current?.scrollTo({ top: 0 });
  }, []);
  const cycle = useCallback(
    (by: 1 | -1) => {
      const at = TABS.findIndex((t) => t.id === tab);
      go(TABS[(at + by + TABS.length) % TABS.length].id, true);
    },
    [tab, go]
  );

  // A section opened from the controller or keys starts on what is in use there (Drive, the circuit, the car)
  useEffect(() => {
    if (!focusOnOpen.current) return;
    focusOnOpen.current = false;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusables(panel);
    const el = items.find((x) => x.hasAttribute("data-nav-default")) ?? items[0];
    if (!el) return;
    (el.focus as (o?: object) => void)({ preventScroll: true, focusVisible: true });
    el.scrollIntoView({ block: "nearest" });
  }, [tab]);

  // Enter with nothing focused is Drive (with a control focused, Enter presses that control)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      e.preventDefault();
      driveRef.current?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useFocusNav(rootRef, {
    onPrevTab: () => cycle(-1),
    onNextTab: () => cycle(1),
    onStart: () => driveRef.current?.click(),
    onBack: () => {
      if (tab !== "home") go("home", true);
    },
    // Nothing is focused until the controller or the keys are used: a mouse visitor sees no cursor
    autoFocus: false,
  });

  /** The prompts along the bottom: the controller's buttons once one is used, else the keys */
  const prompts: Prompt[] = pad
    ? [
        { action: "move", label: "Move" },
        { action: "select", label: "Select" },
        ...(tab !== "home" ? [{ action: "back", label: "Back" } as const] : []),
        { action: "tabs", label: "Switch section" },
        { action: "start", label: "Drive" },
      ]
    : [
        { action: "tabs", label: "Switch section" },
        { action: "start", label: "Drive", key: "Enter" },
      ];

  return (
    <>
      <div className="sr-only focus-within:not-sr-only focus-within:fixed focus-within:top-3 focus-within:left-3 focus-within:z-(--z-lc-notice)">
        <Button href={`#${PANEL_ID}`} native variant="secondary" size="sm">
          Skip to content
        </Button>
      </div>
      <div ref={rootRef} className="flex h-dvh flex-col bg-lc-void text-lc-chalk">
        {/* Read by screen readers and search engines */}
        <h1 className="sr-only">LibreCorsa: free open-source racing simulator in your browser</h1>
        <p className="sr-only">{SITE_DESCRIPTION}</p>

        <header className={`flex shrink-0 flex-wrap items-center gap-x-4 gap-y-3 pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:gap-x-6 ${GUTTER}`}>
          <LibreCorsaLogo variant="compact" size="sm" />
          {/* A pointer click picks a tab without leaving the cursor's volt on it (Drive keeps the one volt fill); keys
              and a pad keep the cursor where they put it. `contents` keeps the strip a child of the header's row. */}
          <div
            className="contents"
            onClick={(e) => {
              if (e.detail > 0 && (e.target as Element).closest('[role="tab"]')) (document.activeElement as HTMLElement | null)?.blur();
            }}
          >
            <Tabs
              tabs={TABS}
              value={tab}
              onChange={(id) => go(id)}
              aria-label="Sections"
              panelId={PANEL_ID}
              size="sm"
              prevPrompt={pad ? <PadGlyph button="lb" family={family} /> : <KeyCap>Q</KeyCap>}
              nextPrompt={pad ? <PadGlyph button="rb" family={family} /> : <KeyCap>E</KeyCap>}
              className="max-md:order-last max-md:w-full"
            />
          </div>
          {/* Beside the logo on a phone too: the tabs take the row under them */}
          <Button
            ref={driveRef}
            href={PLAY_HREF}
            native
            variant="primary"
            size="lg"
            icon={<Icon name="drive" />}
            onClick={() => rememberPicks(picks)}
            className="ml-auto"
          >
            Drive
          </Button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {/* pt-2: room for the cursor's ring round the top row, which the scrolling box would clip */}
          <div
            ref={panelRef}
            id={PANEL_ID}
            role="tabpanel"
            aria-label={TABS.find((t) => t.id === tab)?.label}
            tabIndex={-1}
            data-nav-scroll
            className={`min-h-0 flex-1 overflow-y-auto overscroll-contain pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none max-lg:pb-24 ${GUTTER}`}
          >
            {tab === "home" ? (
              <div className="grid gap-3 lg:h-full lg:min-h-[520px] lg:grid-cols-12 lg:grid-rows-2">
                <a
                  href={PLAY_HREF}
                  onClick={() => rememberPicks(picks)}
                  onPointerEnter={focusOnHover}
                  data-nav-default
                  aria-label={`Drive: ${venue.name}, ${layout.layout}, in the ${car.title}`}
                  className={`${TILE} flex min-h-[300px] lg:col-span-7 lg:row-span-2`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={withBasePath("/home/hero-1600.webp")}
                    srcSet={[960, 1600, 2560].map((w) => `${withBasePath(`/home/hero-${w}.webp`)} ${w}w`).join(", ")}
                    sizes="(min-width: 64rem) 58vw, 100vw"
                    alt=""
                    fetchPriority="high"
                    className="absolute inset-0 h-full w-full object-cover object-[62%_50%] transition-transform duration-500 ease-lc group-hover:scale-[1.02] motion-reduce:transition-none"
                  />
                  {/* A scrim under the words, so they read over any frame of the picture */}
                  <span aria-hidden className="absolute inset-0 bg-linear-to-t from-lc-void/95 via-lc-void/40 via-45% to-transparent to-70%" />
                  <span className="relative mt-auto flex w-full flex-col gap-3 p-6 sm:p-8">
                    <span className="lc-disp text-[clamp(52px,7.4vw,112px)]">Drive</span>
                    <span className="flex items-center gap-2 text-[15px] font-semibold text-lc-fog">
                      <Icon name="drive" className="text-lc-chalk" />
                      {venue.name}, {layout.layout}. {car.title}.
                    </span>
                  </span>
                </a>

                <button
                  type="button"
                  onClick={() => go("circuits")}
                  onPointerEnter={focusOnHover}
                  aria-label={`Change circuit: ${venue.name}, ${layout.layout}`}
                  className={`${TILE} flex min-h-[230px] cursor-pointer p-6 lg:col-span-5`}
                >
                  <span className="relative z-10 flex max-w-[52%] flex-col items-start gap-2">
                    <span className="lc-h2">{venue.name}</span>
                    <span className="lc-body">{layout.layout}</span>
                    {/* The badge shares the distance's line, so a two-line name still leaves room on a short screen */}
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <span className="lc-mono text-[13px] text-lc-slate">{lengthOf(layout)}</span>
                      <GradeBadge grade={layout.grade} size="sm" title={GRADE_NOTES.circuits[layout.grade]} />
                    </span>
                    {layout.outline?.kmh.length ? (
                      <span className="mt-1 flex items-baseline gap-1.5">
                        <span ref={speedRef} className="lc-data text-[34px] leading-none">
                          {Math.round(speedIn(layout.outline.kmh[0], units.speed))}
                        </span>
                        <span className="text-[12px] font-semibold text-lc-slate">{SPEED_LABEL[units.speed]}</span>
                      </span>
                    ) : null}
                    <span className={`${MORE} mt-auto pt-3`}>
                      Change circuit
                      <Icon name="next" />
                    </span>
                  </span>
                  {layout.outline ? (
                    <LapMap
                      key={layout.id}
                      outline={layout.outline}
                      speedRef={speedRef}
                      label={`Map of ${venue.name}, ${layout.layout}`}
                      className="absolute inset-y-3 right-3 h-[calc(100%-1.5rem)] w-[50%]"
                    />
                  ) : null}
                </button>

                <button
                  type="button"
                  onClick={() => go("cars")}
                  onPointerEnter={focusOnHover}
                  aria-label={`Change car: ${car.title}`}
                  className={`${TILE} flex min-h-[230px] cursor-pointer flex-col gap-3 p-5 lg:col-span-3`}
                >
                  <span className="flex min-h-0 flex-1 items-center justify-center">
                    <CarThumb key={car.id} src={car.thumb} eager className="h-auto max-h-full w-full object-contain" />
                  </span>
                  <span className="flex flex-col items-start gap-1.5">
                    <span className={TILE_TITLE}>{car.title}</span>
                    <span className="lc-body text-lc-slate">
                      {car.classTitle}, {car.year}
                    </span>
                    <GradeBadge grade={car.grade} size="sm" title={GRADE_NOTES.cars[car.grade]} className="mt-0.5" />
                    <span className={`${MORE} pt-2`}>
                      Change car
                      <Icon name="next" />
                    </span>
                  </span>
                </button>

                <a
                  href={withBasePath("/press")}
                  onPointerEnter={focusOnHover}
                  aria-label={`Press & media: ${data.coverageCount} articles and videos, and the press kit`}
                  className={`${TILE} flex min-h-[230px] flex-col gap-3 p-5 lg:col-span-2`}
                >
                  <span className="flex flex-col gap-1">
                    <span className={TILE_TITLE}>Press & media</span>
                    <span className="lc-hint text-[13px]">{data.coverageCount} articles and videos so far</span>
                  </span>
                  <span aria-hidden className="flex flex-col">
                    {data.coverage.slice(0, 3).map((a) => (
                      <span key={a.url} className="flex min-w-0 flex-col gap-0.5 border-t border-lc-line py-2.5">
                        <span className="truncate text-[13px] font-semibold text-lc-chalk">{a.outlet}</span>
                        <span className="lc-hint line-clamp-2">{a.title}</span>
                      </span>
                    ))}
                  </span>
                  <span aria-hidden className={`${MORE} mt-auto`}>
                    Coverage and press kit
                    <Icon name="next" />
                  </span>
                </a>
              </div>
            ) : null}

            {tab === "circuits" ? (
              <div className="flex flex-col gap-5">
                <GradeLegend of="circuits" shown={data.venues.flatMap((v) => v.layouts.map((l) => l.grade))} />
                <div role="group" aria-label="Filter circuits" className="flex flex-wrap items-center gap-2">
                  {VENUE_FILTERS.map((f) => {
                    const pool = venuesWith(f.key);
                    const all = [...new Set(data.venues.flatMap((v) => f.of(v)))].sort((a, b) => a.localeCompare(b));
                    // A filter with one option narrows nothing
                    if (all.length < 2) return null;
                    const picked = venueFilters[f.key];
                    const countOf = (o: string) => pool.filter((v) => f.of(v).includes(o)).length;
                    // Only what the other filters leave a circuit for (and the pick itself)
                    const options = all.filter((o) => o === picked || countOf(o) > 0);
                    return (
                      <Select
                        key={f.key}
                        aria-label={f.label}
                        value={picked}
                        onChange={(v) => setVenueFilters((cur) => ({ ...cur, [f.key]: v }))}
                        options={[{ id: "", label: f.all }, ...options.map((o) => ({ id: o, label: `${o} (${countOf(o)})` }))]}
                      />
                    );
                  })}
                  {venuesFiltered ? (
                    <Button variant="ghost" size="sm" icon={<Icon name="reset" />} onClick={() => setVenueFilters(NO_VENUE_FILTERS)}>
                      Clear filters
                    </Button>
                  ) : null}
                  {/* Mounted from the start, so the first change of filter is announced */}
                  <p role="status" className="lc-data m-0 ml-auto text-[12px] font-medium text-lc-slate">
                    {venuesFiltered ? `${shownVenues.length} of ${data.venues.length} circuits` : ""}
                  </p>
                </div>
                {shownVenues.length ? null : (
                  <EmptyState
                    icon={<Icon name="filter" />}
                    action={
                      <Button size="sm" onClick={() => setVenueFilters(NO_VENUE_FILTERS)}>
                        Clear filters
                      </Button>
                    }
                  >
                    No circuit matches these filters.
                  </EmptyState>
                )}
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
                  {shownVenues.map((v) => {
                    const on = v === venue;
                    const shown = on ? layout : v.layouts[0];
                    return (
                      <div key={v.name} className="flex min-w-0 flex-col gap-2">
                        <MediaTile
                          onSelect={() => setLayoutId(v.layouts[0].id)}
                          aria-pressed={on}
                          chosen={on}
                          navDefault={on}
                          media={<OutlineThumb outline={shown.outline} className={`p-4 pt-10 ${on ? "text-lc-chalk" : "text-lc-slate"}`} />}
                          overlay={<GradeBadge grade={shown.grade} size="sm" title={GRADE_NOTES.circuits[shown.grade]} />}
                          title={v.name}
                          meta={
                            <>
                              {v.country} <span aria-hidden>·</span> <span className="lc-mono">{lengthOf(shown)}</span>
                            </>
                          }
                          action={v.source ? <SourceChip source={v.source} /> : undefined}
                        />
                        {on && v.layouts.length > 1 ? (
                          <Segmented
                            aria-label={`${v.name} layout`}
                            size="sm"
                            fill
                            value={layout.id}
                            onChange={setLayoutId}
                            options={v.layouts.map((l) => ({ id: l.id, label: l.layout }))}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {tab === "cars" ? (
              <div className="flex flex-col gap-5">
                <GradeLegend of="cars" shown={data.cars.map((c) => c.grade)} />
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
                  {data.cars.map((c) => {
                    const on = c === car;
                    return (
                      <MediaTile
                        key={c.id}
                        onSelect={() => setCarId(c.id)}
                        aria-pressed={on}
                        chosen={on}
                        navDefault={on}
                        media={<CarThumb src={c.thumb} className="object-contain p-2.5 pt-8" />}
                        overlay={<GradeBadge grade={c.grade} size="sm" title={GRADE_NOTES.cars[c.grade]} />}
                        title={c.title}
                        meta={`${c.classTitle}, ${c.year}`}
                        action={<SourceChip source={c.source} />}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}

            {tab === "about" ? (
              <div className="grid gap-x-16 gap-y-12 pt-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
                <div className="flex min-w-0 flex-col gap-8">
                  <p className="m-0 max-w-[34ch] text-[22px] leading-[1.4] font-medium text-lc-chalk">
                    LibreCorsa is a free, open-source racing simulator that runs in your browser. I make it on my own.
                  </p>
                  <dl className="m-0 flex flex-col">
                    {GAME_FACTS.map(([label, text]) => (
                      <div key={label} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 border-t border-lc-line py-3.5 max-sm:grid-cols-1 max-sm:gap-y-1">
                        <dt className="lc-lbl pt-0.5">{label}</dt>
                        <dd className="lc-body m-0 text-[15px] text-lc-chalk">{text}</dd>
                      </div>
                    ))}
                  </dl>
                  <section aria-labelledby="add-your-mod" className="flex flex-col gap-4 pt-2">
                    <h2 id="add-your-mod" className="lc-h2">
                      Add your mod
                    </h2>
                    <p className="lc-body m-0 max-w-[60ch] text-[16px] leading-[1.6]">
                      Made a car or track mod and want to see it in LibreCorsa? Email me at{" "}
                      <a href={`mailto:${data.contactEmail}`} translate="no" className={TEXT_LINK}>
                        {data.contactEmail}
                      </a>{" "}
                      with a link to it. Every modder gets credited by name in the game.
                    </p>
                  </section>
                </div>
                <section aria-labelledby="press-and-media" className="flex min-w-0 flex-col gap-5">
                  <h2 id="press-and-media" className="lc-h2">
                    Press & media
                  </h2>
                  <ul className="m-0 flex list-none flex-col p-0">
                    {data.coverage.map((a) => (
                      <li key={a.url} className="border-t border-lc-line last:border-b">
                        <a
                          href={a.url}
                          target="_blank"
                          rel="noopener"
                          onPointerEnter={focusOnHover}
                          className="group flex items-start justify-between gap-4 rounded-lc-nub py-3.5 text-lc-chalk no-underline"
                        >
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="text-[15px] leading-snug font-semibold text-lc-fog transition-colors duration-200 group-hover:text-lc-chalk">
                              {a.title}
                            </span>
                            <span className="lc-hint text-[13px]">
                              {a.outlet} <span aria-hidden>·</span> <span className="lc-mono">{day(a.date)}</span>
                            </span>
                          </span>
                          <Icon name="externalLink" className="mt-0.5 text-lc-slate transition-colors duration-200 group-hover:text-lc-chalk" />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-x-6 gap-y-3 text-[14px]">
                    {[
                      ["All coverage and the press kit", withBasePath("/press")],
                      ["Privacy", withBasePath("/privacy")],
                      ["GitHub", data.repoUrl],
                      ["Buy me a coffee", data.supportUrl],
                    ].map(([label, href]) => (
                      <a key={label} href={href} onPointerEnter={focusOnHover} className={TEXT_LINK}>
                        {label}
                      </a>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </main>

        {/* The prompt bar: the controller's buttons once one is used (on any screen), else the keys */}
        <footer
          className={`flex shrink-0 items-center justify-between gap-4 border-t border-lc-line pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] ${pad ? "" : "max-lg:hidden pointer-coarse:hidden"} ${GUTTER}`}
        >
          <PromptBar prompts={prompts} rule={false} />
          <span className="max-w-[34%] truncate text-[13px] font-semibold text-lc-slate max-md:hidden">
            {venue.name}, {car.title}
          </span>
        </footer>
      </div>
    </>
  );
};
