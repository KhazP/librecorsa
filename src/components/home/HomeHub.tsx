"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currentInputMode, useInputMode } from "@/components/menu/input-mode";
import { focusables, focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { LayoutChoice } from "@/components/LayoutChoice";
import { SourceChip } from "@/components/SourceChip";
import { Button, EmptyState, MediaTile, Select, Tabs } from "@/components/ui";
import { Icon } from "@/components/ui/icons";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { KeyCap, PadGlyph, PromptBar, type Prompt } from "@/components/ui/prompts";
import { CURSOR_TILE, cx, MOTION } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";
import { useSavedInterfaceSettings, useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn, SPEED_LABEL, speedIn } from "@/lib/settings/units";
import { SITE_DESCRIPTION } from "@/lib/site";
import { useStoreBuild } from "@/lib/use-store-build";
import { FeaturedBadges } from "./FeaturedBadges";
import { SupportButton } from "@/components/SupportButton";
import { day, GAME_FACTS, GRADE_NOTES, type HomeData, type HomeLayout, type HomeVenue, type WhatsNewDay } from "./home-data";
import { CarThumb, GradeBadge, GradeLegend, OutlineThumb } from "./home-ui";
import { LapMap } from "./LapMap";
import { HomeLapTimes } from "./HomeLapTimes";
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

type Tab = "home" | "circuits" | "cars" | "laps" | "whats-new" | "about";
const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "circuits", label: "Circuits" },
  { id: "cars", label: "Cars" },
  { id: "laps", label: "Lap times" },
  { id: "whats-new", label: "What's new" },
  { id: "about", label: "About" },
];

/** The What's new feed the visitor last opened (its fingerprint), so a new or updated day lights the tab again */
const WHATS_NEW_SEEN_KEY = "librecorsa.whatsNewSeen";

/** A short fingerprint of the patch notes: any new or updated day changes it */
function whatsNewFingerprint(days: readonly WhatsNewDay[]): string {
  if (days.length === 0) return "";
  const input = days.map((d) => `${d.date}:${d.lastSha}`).join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The cyan dot after "What's new" while it holds notes the visitor has not opened (colour is not alone: it is named) */
const UNREAD_DOT = (
  <>
    <span aria-hidden className="relative inline-flex size-2 shrink-0">
      <span className="lc-ping absolute inset-0 rounded-full bg-lc-cyan motion-reduce:hidden" />
      <span className="relative size-2 rounded-full bg-lc-cyan" />
    </span>
    <span className="sr-only"> (unread updates)</span>
  </>
);

/** Letters in a name's longest word: a heading can't wrap inside one */
const longestWord = (name: string) => Math.max(0, ...name.split(/\s+/).map((w) => w.length));

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
/**
 * The Circuits and Cars walls: tiles at least 280 px or 17 % of the screen wide, so they grow with a wide screen
 * (four across at 1280 to 1440 px, five at 1920 px and up) instead of turning into more, smaller tiles; one across on
 * a phone
 */
const WALL = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,max(280px,17vw)),1fr))]";
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
  const storeBuild = useStoreBuild();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const driveRef = useRef<HTMLAnchorElement | null>(null);
  /** Set when a section is opened from the controller or keys: the cursor moves into it once it has rendered */
  const focusOnOpen = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);
  /** The Lap times board is on screen (the prompt bar then names its page keys) */
  const [boardShown, setBoardShown] = useState(false);
  /** Every layout for the board's circuit picker, named with its layout where a venue has more than one */
  const boardCircuits = useMemo(
    () =>
      data.venues
        .flatMap((v) => v.layouts.map((l) => ({ id: l.id, label: v.layouts.length > 1 ? `${v.name} · ${l.layout}` : v.name })))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [data.venues],
  );

  /** What's new holds notes this visitor has not opened yet */
  const [unseenUpdates, setUnseenUpdates] = useState(false);
  const whatsNewToken = useMemo(() => whatsNewFingerprint(data.whatsNew), [data.whatsNew]);
  useEffect(() => {
    if (!whatsNewToken) return;
    try {
      setUnseenUpdates(localStorage.getItem(WHATS_NEW_SEEN_KEY) !== whatsNewToken);
    } catch {
      setUnseenUpdates(true);
    }
  }, [whatsNewToken]);
  // Opening the section marks this feed read
  useEffect(() => {
    if (tab !== "whats-new" || !whatsNewToken) return;
    setUnseenUpdates(false);
    try {
      localStorage.setItem(WHATS_NEW_SEEN_KEY, whatsNewToken);
    } catch {
      // Storage unavailable: the dot stays off for this visit
    }
  }, [tab, whatsNewToken]);
  const tabs = useMemo(() => TABS.map((t) => (t.id === "whats-new" && unseenUpdates ? { ...t, badge: UNREAD_DOT } : t)), [unseenUpdates]);

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
  // The lap times' pages turn with the triggers (Z / C) while the board is on the Lap times section
  const pagePrompt: Prompt[] = tab === "laps" && boardShown ? [{ action: "pages", label: "Lap times page" }] : [];
  const prompts: Prompt[] = pad
    ? [
        { action: "move", label: "Move" },
        { action: "select", label: "Select" },
        ...(tab !== "home" ? [{ action: "back", label: "Back" } as const] : []),
        { action: "tabs", label: "Switch section" },
        ...pagePrompt,
        { action: "start", label: "Drive" },
      ]
    : [
        { action: "tabs", label: "Switch section" },
        ...pagePrompt,
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

        <header className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-3 pt-[max(1rem,env(safe-area-inset-top))] pb-4 sm:gap-x-6 ${GUTTER}`}>
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
              tabs={tabs}
              value={tab}
              onChange={(id) => go(id)}
              aria-label="Sections"
              panelId={PANEL_ID}
              size="sm"
              prevPrompt={pad ? <PadGlyph button="lb" family={family} /> : <KeyCap>Q</KeyCap>}
              nextPrompt={pad ? <PadGlyph button="rb" family={family} /> : <KeyCap>E</KeyCap>}
              className="max-lg:order-last max-lg:w-full max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]"
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
              <div className="grid gap-3 lg:h-full lg:min-h-[620px] lg:grid-cols-12 lg:grid-rows-2">
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
                    {/* A long word ("MOTORDROME", "INTERNATIONAL") steps down with the window on the grid layout, so it stays clear of the map */}
                    <span className={cx("lc-h2", longestWord(venue.name) >= 10 && "lg:text-[clamp(24px,2.4vw,34px)]")}>{venue.name}</span>
                    <span className="lc-body">{layout.layout}</span>
                    {/* The badge shares the distance's line, so a two-line name still leaves room on a short screen */}
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <span className="lc-mono text-[13px] text-lc-slate">{lengthOf(layout)}</span>
                      <GradeBadge grade={layout.grade} size="sm" title={GRADE_NOTES.circuits[layout.grade]} />
                    </span>
                    {layout.outline?.kmh.length ? (
                      <span className="mt-1 flex items-baseline gap-1.5">
                        <span ref={speedRef} className="lc-data inline-block min-w-[3ch] text-right text-[34px] leading-none">
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
                  <span aria-hidden className="flex min-h-0 flex-1 flex-col overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-1rem),transparent)]">
                    {data.coverage.slice(0, 3).map((a) => (
                      <span key={a.url} className="flex min-w-0 flex-col gap-0.5 border-t border-lc-line py-2.5">
                        <span className="truncate text-[13px] font-semibold text-lc-chalk">{a.outlet}</span>
                        <span className="lc-hint line-clamp-2">{a.title}</span>
                      </span>
                    ))}
                  </span>
                  <span aria-hidden className={`${MORE} mt-auto shrink-0`}>
                    Coverage and press kit
                    <Icon name="next" />
                  </span>
                </a>
              </div>
            ) : null}

            {/* The online board of every car, loaded when the section is opened; it starts on the hub's circuit */}
            {tab === "laps" ? (
              <HomeLapTimes
                circuits={boardCircuits}
                circuit={layout.id}
                carTags={data.boardCars}
                carChoices={data.boardCarChoices}
                carTitles={data.carTitles}
                scrollRoot={panelRef}
                onShown={setBoardShown}
              />
            ) : null}

            {/* Day-by-day patch notes, newest first. On a wide screen a day's notes run in two or three columns, so the
                lines keep a reading length and the feed still fills the width */}
            {tab === "whats-new" ? (
              <div className="flex max-w-[880px] flex-col xl:max-w-[1800px]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-4">
                  <p className="lc-body m-0 text-lc-slate">Day-by-day summary of every change to LibreCorsa.</p>
                  <a href={`${data.repoUrl}/commits/main`} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`inline-flex items-center gap-1 ${TEXT_LINK}`}>
                    Full commit log on GitHub
                    <Icon name="externalLink" />
                  </a>
                </div>
                {data.whatsNew.length === 0 ? (
                  <EmptyState icon={<Icon name="info" size="lg" />}>No patch notes yet.</EmptyState>
                ) : (
                  <ol className="m-0 flex list-none flex-col p-0">
                    {data.whatsNew.map((entry, index) => (
                      <li key={entry.date} className="grid gap-x-8 gap-y-2 border-t border-lc-line py-5 last:border-b sm:grid-cols-[150px_minmax(0,1fr)]">
                        <div className="flex items-baseline justify-between gap-3 sm:flex-col sm:items-start sm:justify-start sm:gap-1.5">
                          <span className="lc-data text-[14px] text-lc-chalk">{day(entry.date)}</span>
                          <a
                            href={
                              entry.commits === 1
                                ? `${data.repoUrl}/commit/${entry.lastSha.slice(0, 7)}`
                                : `${data.repoUrl}/commits/main/?since=${entry.date}&until=${entry.date}`
                            }
                            target="_blank"
                            rel="noopener"
                            onPointerEnter={focusOnHover}
                            data-nav-default={index === 0 ? "" : undefined}
                            className="inline-flex items-center gap-1 rounded-full text-[12px] text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk focus-visible:text-lc-chalk pointer-coarse:min-h-11"
                          >
                            <span className="lc-data">
                              {entry.commits} {entry.commits === 1 ? "commit" : "commits"}
                            </span>
                            <Icon name="externalLink" size="sm" />
                          </a>
                        </div>
                        <div className="flex min-w-0 flex-col gap-2">
                          <h2 className="lc-title m-0 text-[17px] leading-snug text-lc-chalk">{entry.title}</h2>
                          <ul className="m-0 -mb-1.5 list-none p-0 xl:columns-[26rem] xl:gap-x-10">
                            {entry.items.map((item) => (
                              <li key={item} className="relative break-inside-avoid pb-1.5 pl-4 text-[14px] leading-relaxed text-lc-fog">
                                <span aria-hidden className="absolute top-[9px] left-0 size-1 rounded-full bg-lc-slate" />
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
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
                <div className={WALL}>
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
                          <LayoutChoice
                            aria-label={`${v.name} layout`}
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
                <div className={WALL}>
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
                  <p className="m-0 max-w-[34ch] text-[clamp(22px,1.5vw,30px)] leading-[1.4] font-medium text-lc-chalk">
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
                  {/* Who made the circuits and cars, those who take donations first, each with their link */}
                  {data.modders.length ? (
                    <section aria-labelledby="the-modders" className="flex flex-col gap-4 pt-2">
                      <h2 id="the-modders" className="lc-h2">
                        The modders
                      </h2>
                      <p className="lc-body m-0 max-w-[60ch] text-[16px] leading-[1.6]">
                        The circuits and cars are their work, used with their permission. If you enjoy one, you can thank
                        its maker directly.
                      </p>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {data.modders.map((m) => (
                          <li key={m.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-lc-line py-3 last:border-b">
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <a href={m.url} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`self-start inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
                                {m.name}
                              </a>
                              <span className="lc-hint text-[13px]">{m.works.join(", ")}</span>
                            </span>
                            <SupportButton support={m.support} maker={m.name} variant="secondary" />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
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
                      // Not in the Android app (store-mode.ts)
                      ...(storeBuild ? [] : [["Buy me a coffee", data.supportUrl]]),
                    ].map(([label, href]) => (
                      <a key={label} href={href} onPointerEnter={focusOnHover} className={`inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
                        {label}
                      </a>
                    ))}
                  </div>
                  <FeaturedBadges className="pt-2" />
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
          <span title={`${venue.name}, ${car.title}`} className="max-w-[34%] truncate text-[13px] font-semibold text-lc-slate max-md:hidden">
            {venue.name}, {car.title}
          </span>
        </footer>
      </div>
    </>
  );
};
