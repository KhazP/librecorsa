"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
import { currentInputMode, useInputMode } from "@/components/menu/input-mode";
import { focusables, focusOnHover, useFocusNav } from "@/components/menu/useFocusNav";
import { SourceChip } from "@/components/SourceChip";
import { Button, EmptyState, MediaTile, Select, Tabs } from "@/components/ui";
import { CarLiveryPicker } from "./CarLiveryPicker";
import { VenueLayoutPicker } from "./VenueLayoutPicker";
import { Icon } from "@/components/ui/icons";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { KeyCap, PadGlyph, PromptBar, type Prompt } from "@/components/ui/prompts";
import { keyLabel } from "@/lib/input/bindings";
import { useKeyLayout } from "@/lib/input/use-key-layout";
import { CURSOR_TILE, cx, MOTION } from "@/components/ui/styles";
import { withBasePath } from "@/lib/base-path";
import { useSavedInterfaceSettings, useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn, SPEED_LABEL, speedIn } from "@/lib/settings/units";
import { AUTHOR_LINKS, DOCS_URL, REPO_URL, SITE_DESCRIPTION } from "@/lib/site";
import { CODE_CONTRIBUTORS } from "@/lib/contributors";
import { useStoreBuild } from "@/lib/use-store-build";
import { FeaturedBadges } from "./FeaturedBadges";
import { SupportButton } from "@/components/SupportButton";
import { day, GAME_FACTS, type HomeCar, type HomeData, type HomeLayout, type HomeQualityTexts, type HomeVenue } from "./home-data";
import { useLocalizedHome } from "./home-labels";
import { CarQualityTag, carQualityText, CarThumb, CircuitQualityTag, OutlineThumb } from "./home-ui";
import { groupCoverage } from "@/lib/home/coverage";
import { markWhatsNewSeen, whatsNewFingerprint, whatsNewUnseen } from "@/lib/whats-new-seen";
import { preloadVenueHero, VenueHero } from "./VenueHero";
import { LapMap } from "./LapMap";
import { HomeDownloads } from "./HomeDownloads";
import { RELEASE_LINKS } from "@/lib/downloads";
import { HomeLapTimes } from "./HomeLapTimes";
import { bestLapForCircuit } from "@/lib/sim/ghost-store";
import { useBestLapSummaries } from "@/lib/sim/use-best-laps";
import { formatLapTime } from "@/components/hud/hud-format";
import type { CustomLiveryColors } from "@/types/f1";
import { PLAY_HREF, rememberCarSkin, rememberF1Livery, rememberPicks, storedPicks } from "./play";
import { TEXT_LINK } from "./SitePage";

/*
 * The home page, laid out like a console racer's home hub. Sections across the top (Q / E, or a controller's
 * bumpers), big picture tiles underneath: Drive takes most of the screen, the circuit's lap runs in its own tile, the
 * car and the press sit beside it. Circuits and Cars are walls of picture tiles to pick from, each with the game's own
 * badge (Original, Sim grade or Scan; Own or Shared physics); Drive stays in the corner of every section and opens the
 * game (/play) on the picks.
 *
 * A controller or the keyboard drives it like the game's own menus (useFocusNav): the D-pad, stick or arrows move a
 * volt cursor between tiles and cards, A / Enter picks, B / Esc goes back to Home, LB / RB or Q / E switch sections
 * and Start drives.
 */

type Tab = "home" | "circuits" | "cars" | "laps" | "whats-new" | "download" | "about";
/** The sections, each with its label's key (home.hub.tabs in the messages) */
const TABS = [
  { id: "home", key: "home" },
  { id: "circuits", key: "circuits" },
  { id: "cars", key: "cars" },
  { id: "laps", key: "laps" },
  { id: "whats-new", key: "whatsNew" },
  { id: "download", key: "download" },
  { id: "about", key: "about" },
] as const satisfies readonly { id: Tab; key: string }[];

/** The cyan dot after "What's new" while it holds notes the visitor has not opened (colour is not alone: it is named) */
const UNREAD_DOT = (name: string) => (
  <>
    <span aria-hidden className="inline-flex size-1.5 shrink-0 rounded-full bg-lc-cyan" />
    <span className="sr-only"> {name}</span>
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
  "group relative overflow-hidden rounded-lc-card border-[1.5px] border-lc-line bg-lc-carbon text-start text-lc-chalk no-underline hover:border-lc-keyline",
  MOTION,
  CURSOR_TILE,
);
/** A tile's way on ("Change circuit") */
const MORE = "inline-flex items-center gap-1 text-[13px] font-semibold text-lc-fog transition-colors duration-200 group-hover:text-lc-chalk group-focus:text-lc-chalk";
/** The titles of the smaller Home tiles */
const TILE_TITLE = "lc-disp text-[22px] leading-[1.05]";
/**
 * A tile that holds more than one link (Press & media): the cursor's edge and halo, and the lit way on, follow its
 * stretched main link (`data-card-link`) instead of the tile itself
 */
const LINK_CARD_CURSOR =
  "has-[[data-card-link]:focus]:border-lc-volt has-[[data-card-link]:focus]:inset-ring has-[[data-card-link]:focus]:inset-ring-lc-volt has-[[data-card-link]:focus]:shadow-lc-focus";
const LINK_CARD_MORE = "group-has-[[data-card-link]:focus]:text-lc-chalk";
/**
 * The Circuits and Cars walls: tiles at least 280 px or 17 % of the screen wide, so they grow with a wide screen
 * (four across at 1280 to 1440 px, five at 1920 px and up) instead of turning into more, smaller tiles; one across on
 * a phone
 */
const WALL = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,max(280px,17vw)),1fr))]";
/** The page's panel id, which the tabs control and the skip link lands on */
const PANEL_ID = "home-panel";

/** The Circuits filters: one pick each, narrowing the wall together (named in home.hub.venueFilters) */
type VenueFilterKey = "type" | "country" | "modder";
const VENUE_FILTERS: readonly { key: VenueFilterKey; of: (v: HomeVenue) => readonly string[] }[] = [
  { key: "type", of: (v) => v.types },
  { key: "country", of: (v) => [v.country] },
  { key: "modder", of: (v) => v.modders },
];
const NO_VENUE_FILTERS: Record<VenueFilterKey, string> = { type: "", country: "", modder: "" };

/**
 * The Cars filters: one pick each, narrowing the wall together (named in home.hub.carFilters). Physics is the game's
 * car browser filter, in its words
 */
type CarFilterKey = "class" | "physics" | "modder";
const CAR_FILTERS: readonly { key: CarFilterKey; of: (c: HomeCar, text: HomeQualityTexts) => string }[] = [
  { key: "class", of: (c) => c.classTitle },
  { key: "physics", of: (c, text) => carQualityText(c, text).filterLabel },
  { key: "modder", of: (c) => c.source.author },
];
const NO_CAR_FILTERS: Record<CarFilterKey, string> = { class: "", physics: "", modder: "" };

/** The prompt bar's links: TEXT_LINK in slate, so they stay as quiet as the bar's own words */
const BAR_LINK =
  "text-lc-slate underline decoration-lc-keyline decoration-1 underline-offset-4 transition-colors duration-200 ease-lc hover:text-lc-chalk hover:decoration-lc-chalk";

export const HomeHub: React.FC<{ data: HomeData }> = ({ data: built }) => {
  // The Q / E caps name physical keys as printed on this keyboard
  useKeyLayout();
  const data = useLocalizedHome(built);
  const tx = useTranslations("home.hub");
  const td = useTranslations("home.downloads");
  const tm = useTranslations("menu.title");
  const tc = useTranslations("common");
  const [tab, setTab] = useState<Tab>("home");
  const [layoutId, setLayoutId] = useState(data.defaultTrackId);
  const [carId, setCarId] = useState(data.defaultCarId);
  const { mode, family } = useInputMode();
  const pad = mode === "pad";
  useSavedInterfaceSettings();
  const units = useUnits();
  const bestLaps = useBestLapSummaries();
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
  /** The Press & media card's three rows, one per piece (its platforms folded into one row) */
  const pressRows = useMemo(() => groupCoverage(data.coverage).slice(0, 3), [data.coverage]);

  /** What's new holds notes this visitor has not opened yet */
  const [unseenUpdates, setUnseenUpdates] = useState(false);
  const whatsNewToken = useMemo(() => whatsNewFingerprint(data.whatsNew), [data.whatsNew]);
  useEffect(() => {
    if (whatsNewToken) setUnseenUpdates(whatsNewUnseen(whatsNewToken));
  }, [whatsNewToken]);
  // A link to a section by its id (/#whats-new, as the RSS feed's items link) opens that section
  useEffect(() => {
    const openFromHash = () => {
      const id = window.location.hash.slice(1);
      const named = TABS.find((t) => t.id === id);
      if (named) setTab(named.id);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);
  // Opening the section marks this feed read
  useEffect(() => {
    if (tab !== "whats-new" || !whatsNewToken) return;
    setUnseenUpdates(false);
    markWhatsNewSeen(whatsNewToken);
  }, [tab, whatsNewToken]);
  const tabs = useMemo(
    () =>
      TABS.map(({ id, key }) => ({
        id: id as Tab,
        label: tx(`tabs.${key}`),
        ...(id === "whats-new" && unseenUpdates ? { badge: UNREAD_DOT(tx("unread")) } : {}),
      })),
    [unseenUpdates, tx],
  );

  // A returning player's last circuit, car and liveries (the page is built with the defaults)
  const [f1LiveryId, setF1LiveryId] = useState<string | null>(null);
  const [customLivery, setCustomLivery] = useState<CustomLiveryColors | null>(null);
  const [carSkins, setCarSkins] = useState<Record<string, string>>({});
  useEffect(() => {
    const { trackId, carId: stored, f1LiveryId: savedF1, customLivery: savedCustom, carSkins: savedSkins } = storedPicks();
    if (trackId && data.venues.some((v) => v.layouts.some((l) => l.id === trackId))) setLayoutId(trackId);
    if (stored && data.cars.some((c) => c.id === stored)) setCarId(stored);
    if (savedF1) setF1LiveryId(savedF1);
    if (savedCustom) setCustomLivery(savedCustom);
    if (Object.keys(savedSkins).length) setCarSkins(savedSkins);
  }, [data.venues, data.cars]);

  const [venueFilters, setVenueFilters] = useState(NO_VENUE_FILTERS);
  const [carFilters, setCarFilters] = useState(NO_CAR_FILTERS);
  /** Which venue's layout popover is open on the Circuits wall (at most one at a time) */
  const [openLayoutsFor, setOpenLayoutsFor] = useState<string | null>(null);
  /** Which car's livery popover is open on the Cars wall (at most one at a time) */
  const [openLiveriesFor, setOpenLiveriesFor] = useState<string | null>(null);
  /** Last layout picked per venue, so switching away and back keeps the player's choice */
  const [venueLayoutMemory, setVenueLayoutMemory] = useState<Record<string, string>>({});
  /** The venues the filters leave, `except` one of them (for that filter's own options and their counts) */
  const venuesWith = (except?: VenueFilterKey) =>
    data.venues.filter((v) => VENUE_FILTERS.every((f) => f.key === except || !venueFilters[f.key] || f.of(v).includes(venueFilters[f.key])));
  const shownVenues = venuesWith();
  const venuesFiltered = VENUE_FILTERS.some((f) => venueFilters[f.key]);
  /** The cars the filters leave, `except` one of them (for that filter's own options and their counts) */
  const carsWith = (except?: CarFilterKey) =>
    data.cars.filter((c) => CAR_FILTERS.every((f) => f.key === except || !carFilters[f.key] || f.of(c, data.qualityText) === carFilters[f.key]));
  const shownCars = carsWith();
  const carsFiltered = CAR_FILTERS.some((f) => carFilters[f.key]);

  const venue = data.venues.find((v) => v.layouts.some((l) => l.id === layoutId)) ?? data.venues[0];
  const layout = venue.layouts.find((l) => l.id === layoutId) ?? venue.layouts[0];
  const car = data.cars.find((c) => c.id === carId) ?? data.cars[0];
  const picks = { trackId: layout.id, carId: car.id };

  // Keep per-venue layout memory seeded from restored/default picks so switching venues and back restores it
  useEffect(() => {
    setVenueLayoutMemory((m) => (m[venue.name] === layout.id ? m : { ...m, [venue.name]: layout.id }));
  }, [venue.name, layout.id]);

  // Warm the selected venue's hero while picking on another tab so returning to Home paints it immediately
  useEffect(() => {
    if (tab !== "home") preloadVenueHero(venue.hero);
  }, [tab, venue.hero]);
  /** A layout's length and corners, in the player's units */
  const lengthOf = (l: HomeLayout) =>
    tx("length", { distance: distanceIn(l.lengthM / 1000, units.speed).toFixed(2), unit: DISTANCE_LABEL[units.speed], turns: l.turns });

  const activeLiveryIdOf = (c: HomeCar): string => {
    if (c.liveryStore === "settings") {
      if (f1LiveryId === "custom") return "custom";
      if (f1LiveryId && c.liveries.some((l) => l.id === f1LiveryId)) return f1LiveryId;
      return c.liveries[0]?.id ?? "";
    }
    if (c.liveryStore === "skin") {
      const saved = carSkins[c.id];
      if (saved && c.liveries.some((l) => l.id === saved)) return saved;
      return c.liveries[0]?.id ?? "";
    }
    return "";
  };
  const activeThumbOf = (c: HomeCar): string | null => {
    const lid = activeLiveryIdOf(c);
    if (!lid || lid === "custom") return c.thumb;
    return c.liveries.find((l) => l.id === lid)?.thumb ?? c.thumb;
  };
  const selectCarLivery = (c: HomeCar, liveryId: string) => {
    setCarId(c.id);
    if (c.liveryStore === "settings") {
      setF1LiveryId(liveryId);
      rememberF1Livery(liveryId);
    } else if (c.liveryStore === "skin") {
      setCarSkins((prev) => ({ ...prev, [c.id]: liveryId }));
      rememberCarSkin(c.id, liveryId);
    }
  };

  const go = useCallback((next: Tab, moveCursor = false) => {
    focusOnOpen.current = moveCursor && currentInputMode() !== "pointer";
    setOpenLayoutsFor(null);
    setOpenLiveriesFor(null);
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
  const pagePrompt: Prompt[] = tab === "laps" && boardShown ? [{ action: "pages", label: tx("prompts.page") }] : [];
  const prompts: Prompt[] = pad
    ? [
        { action: "move", label: tx("prompts.move") },
        { action: "select", label: tx("prompts.select") },
        ...(tab !== "home" ? [{ action: "back", label: tx("prompts.back") } as const] : []),
        { action: "tabs", label: tx("prompts.switchSection") },
        ...pagePrompt,
        { action: "start", label: tx("prompts.drive") },
      ]
    : [
        { action: "tabs", label: tx("prompts.switchSection") },
        ...pagePrompt,
        { action: "start", label: tx("prompts.drive"), key: "Enter" },
      ];

  return (
    <>
      <div className="sr-only focus-within:not-sr-only focus-within:fixed focus-within:top-3 focus-within:start-3 focus-within:z-(--z-lc-notice)">
        <Button href={`#${PANEL_ID}`} native variant="secondary" size="sm">
          {tx("skip")}
        </Button>
      </div>
      <div ref={rootRef} className="flex h-dvh flex-col bg-lc-void text-lc-chalk">
        {/* Read by screen readers and search engines */}
        <h1 className="sr-only">{tx("heading")}</h1>
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
              aria-label={tx("sections")}
              panelId={PANEL_ID}
              size="sm"
              prevPrompt={pad ? <PadGlyph button="lb" family={family} /> : <KeyCap>{keyLabel("KeyQ")}</KeyCap>}
              nextPrompt={pad ? <PadGlyph button="rb" family={family} /> : <KeyCap>{keyLabel("KeyE")}</KeyCap>}
              className="max-lg:order-last max-lg:w-full"
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
            className="ms-auto"
          >
            {tx("drive")}
          </Button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {/* pt-2: room for the cursor's ring round the top row, which the scrolling box would clip */}
          <div
            ref={panelRef}
            id={PANEL_ID}
            role="tabpanel"
            aria-label={tabs.find((t) => t.id === tab)?.label}
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
                  aria-label={tx("driveTile.label", { venue: venue.name, layout: layout.layout, car: car.title })}
                  className={`${TILE} flex min-h-[300px] lg:col-span-7 lg:row-span-2`}
                >
                  <VenueHero venueId={venue.id} hero={venue.hero} />
                  {/* A scrim under the words, so they read over any frame of the picture */}
                  <span aria-hidden className="absolute inset-0 bg-linear-to-t from-lc-void/95 via-lc-void/40 via-45% to-transparent to-70%" />
                  <span className="relative mt-auto flex w-full flex-col gap-3 p-6 sm:p-8">
                    <span className="lc-disp text-[clamp(52px,7.4vw,112px)]">{tx("driveTile.title")}</span>
                    <span className="flex items-center gap-2 text-[15px] font-semibold text-lc-fog">
                      <Icon name="drive" className="text-lc-chalk" />
                      {tx("driveTile.detail", { venue: venue.name, layout: layout.layout, car: car.title })}
                    </span>
                  </span>
                </a>

                <button
                  type="button"
                  onClick={() => go("circuits")}
                  onPointerEnter={focusOnHover}
                  aria-label={tx("circuitTile.label", { venue: venue.name, layout: layout.layout })}
                  className={`${TILE} flex min-h-[230px] cursor-pointer p-6 lg:col-span-5`}
                >
                  <span className="relative z-10 flex max-w-[52%] flex-col items-start gap-2">
                    {/* A long word ("MOTORDROME", "INTERNATIONAL") steps down with the window on the grid layout, so it stays clear of the map */}
                    <span className={cx("lc-h2", longestWord(venue.name) >= 10 && "lg:text-[clamp(24px,2.4vw,34px)]")}>{venue.name}</span>
                    <span className="lc-body">{layout.layout}</span>
                    {/* The badge shares the distance's line, so a two-line name still leaves room on a short screen */}
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                      <span className="lc-mono text-[13px] text-lc-slate">{lengthOf(layout)}</span>
                      <CircuitQualityTag layout={layout} text={data.qualityText} size="sm" />
                    </span>
                    <span className={`${MORE} mt-auto pt-3`}>
                      {tx("circuitTile.more")}
                      <Icon name="next" />
                    </span>
                  </span>
                  {layout.outline ? (
                    // The map hugs its drawing (its viewBox's shape), so the speed sits right under the lap it follows
                    <span className="absolute inset-y-3 end-3 flex w-[50%] flex-col items-center justify-center gap-2">
                      <LapMap
                        key={layout.id}
                        outline={layout.outline}
                        speedRef={speedRef}
                        label={tx("circuitTile.map", { venue: venue.name, layout: layout.layout })}
                        className="block h-auto min-h-0 w-full shrink"
                      />
                      {/* The racing line's speed where the dot is (the dot laps at 4x, so not its speed on screen);
                          parked on the start line under reduced motion. Only the number changes: LapMap writes it */}
                      {layout.outline.kmh.length ? (
                        <span className="flex shrink-0 flex-wrap items-baseline justify-center gap-x-1.5 text-center text-[12px] font-medium text-lc-slate">
                          <span className="flex items-baseline gap-1">
                            <span ref={speedRef} className="lc-data inline-block min-w-[3ch] text-end text-[20px] leading-none text-lc-chalk">
                              {Math.round(speedIn(layout.outline.kmh[0], units.speed))}
                            </span>
                            {SPEED_LABEL[units.speed]}
                          </span>
                          <span>{tx("circuitTile.onLine")}</span>
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </button>

                <button
                  type="button"
                  onClick={() => go("cars")}
                  onPointerEnter={focusOnHover}
                  aria-label={tx("carTile.label", { car: car.title })}
                  className={`${TILE} flex min-h-[230px] cursor-pointer flex-col gap-3 p-5 lg:col-span-3`}
                >
                  <span className="flex min-h-0 flex-1 items-center justify-center">
                    <CarThumb key={car.id} src={activeThumbOf(car)} fallbackSrc={car.thumb} eager className="h-auto max-h-full w-full object-contain" />
                  </span>
                  <span className="flex flex-col items-start gap-1.5">
                    <span className={TILE_TITLE}>{car.title}</span>
                    <span className="lc-body text-lc-slate">{tx("classYear", { class: car.classTitle, year: String(car.year) })}</span>
                    <CarQualityTag car={car} text={data.qualityText} size="sm" className="mt-0.5" />
                    <span className={`${MORE} pt-2`}>
                      {tx("carTile.more")}
                      <Icon name="next" />
                    </span>
                  </span>
                </button>

                {/* The whole card opens /press: a link stretched under the words is the cursor's one stop, and the card
                    wears its cursor. A piece posted on several platforms is one row with a link to each, which Tab
                    reaches and the arrows and the pad pass over (as a tile's source chip) */}
                <div className={cx(TILE, LINK_CARD_CURSOR, "flex min-h-[230px] flex-col gap-3 p-5 lg:col-span-2")}>
                  <a
                    href={withBasePath("/press")}
                    onPointerEnter={focusOnHover}
                    data-card-link=""
                    aria-label={tx("press.label", { count: data.coverageCount, n: String(data.coverageCount) })}
                    className="absolute inset-0 rounded-[inherit] outline-none focus:shadow-none"
                  />
                  <span aria-hidden className="pointer-events-none flex flex-col gap-1">
                    <span className={TILE_TITLE}>{tx("press.title")}</span>
                    <span className="lc-hint text-[13px]">{tx("press.count", { count: data.coverageCount, n: String(data.coverageCount) })}</span>
                  </span>
                  <span className="pointer-events-none flex min-h-0 flex-1 flex-col overflow-hidden [mask-image:linear-gradient(to_bottom,#000_calc(100%-1rem),transparent)]">
                    {pressRows.map((row) => (
                      <span key={row.key} className="flex min-w-0 flex-col gap-0.5 border-t border-lc-line py-2.5">
                        <span className="truncate text-[13px] font-semibold text-lc-chalk">{row.outlet}</span>
                        <span className="lc-hint line-clamp-2">{row.title}</span>
                        {row.platforms.length ? (
                          <span data-nav-skip="" className="flex flex-wrap gap-x-3 pt-0.5">
                            {row.platforms.map((p) => (
                              <a
                                key={p.url}
                                href={p.url}
                                target="_blank"
                                rel="noopener"
                                aria-label={tx("press.onPlatform", { outlet: row.outlet, platform: p.name })}
                                className={cx(
                                  "pointer-events-auto inline-flex items-center rounded-lc-nub text-[12px] focus-visible:outline-offset-[-2px] pointer-coarse:min-h-11 pointer-coarse:min-w-11",
                                  TEXT_LINK,
                                )}
                              >
                                {p.name}
                              </a>
                            ))}
                          </span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                  <span aria-hidden className={cx(MORE, LINK_CARD_MORE, "pointer-events-none mt-auto shrink-0")}>
                    {tx("press.more")}
                    <Icon name="next" />
                  </span>
                </div>
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
                  <p className="lc-body m-0 text-lc-slate">{tx("whatsNew.intro")}</p>
                  <a href={`${data.repoUrl}/commits/main`} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`inline-flex items-center gap-1 ${TEXT_LINK}`}>
                    {tx("whatsNew.commitLog")}
                    <Icon name="externalLink" />
                  </a>
                </div>
                {data.whatsNew.length === 0 ? (
                  <EmptyState icon={<Icon name="info" size="lg" />}>{tx("whatsNew.empty")}</EmptyState>
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
                            className="inline-flex items-center gap-1 rounded-lc-nub text-[12px] text-lc-slate no-underline transition-colors duration-200 hover:text-lc-chalk focus-visible:text-lc-chalk pointer-coarse:min-h-11"
                          >
                            <span className="lc-data">{tx("whatsNew.commits", { count: entry.commits })}</span>
                            <Icon name="externalLink" size="sm" />
                          </a>
                        </div>
                        <div className="flex min-w-0 flex-col gap-2">
                          <h2 className="lc-title m-0 text-[17px] leading-snug text-lc-chalk">{entry.title}</h2>
                          <ul className="m-0 -mb-1.5 list-none p-0 xl:columns-[26rem] xl:gap-x-10">
                            {entry.items.map((item) => (
                              <li key={item} className="relative break-inside-avoid pb-1.5 ps-4 text-[14px] leading-relaxed text-lc-fog">
                                <span aria-hidden className="absolute top-[9px] start-0 size-1 rounded-full bg-lc-slate" />
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
                <div role="group" aria-label={tx("circuits.filter")} className="flex flex-wrap items-center gap-2">
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
                        aria-label={tx(`venueFilters.${f.key}.label`)}
                        value={picked}
                        onChange={(v) => setVenueFilters((cur) => ({ ...cur, [f.key]: v }))}
                        options={[
                          { id: "", label: tx(`venueFilters.${f.key}.all`) },
                          ...options.map((o) => ({ id: o, label: tx("filterOption", { option: o, count: String(countOf(o)) }) })),
                        ]}
                      />
                    );
                  })}
                  {venuesFiltered ? (
                    <Button variant="ghost" size="sm" icon={<Icon name="reset" />} onClick={() => setVenueFilters(NO_VENUE_FILTERS)}>
                      {tx("clearFilters")}
                    </Button>
                  ) : null}
                  {/* Mounted from the start, so the first change of filter is announced */}
                  <p role="status" className="lc-data m-0 ms-auto text-[12px] font-medium text-lc-slate">
                    {venuesFiltered ? tx("circuits.shown", { shown: String(shownVenues.length), total: String(data.venues.length) }) : ""}
                  </p>
                </div>
                {shownVenues.length ? null : (
                  <EmptyState
                    icon={<Icon name="filter" />}
                    action={
                      <Button size="sm" onClick={() => setVenueFilters(NO_VENUE_FILTERS)}>
                        {tx("clearFilters")}
                      </Button>
                    }
                  >
                    {tx("circuits.empty")}
                  </EmptyState>
                )}
                <div className={WALL}>
                  {shownVenues.map((v) => {
                    const on = v === venue;
                    const multi = v.layouts.length > 1;
                    const shown = on ? layout : (v.layouts.find((l) => l.id === venueLayoutMemory[v.name]) ?? v.layouts[0]);
                    const pb = bestLapForCircuit(bestLaps, shown.id, car.vehicle);
                    const pbCarLabel = pb ? (data.boardCars[pb.vehicle]?.label ?? pb.vehicle) : "";
                    return (
                      <div key={v.name} data-venue-card={v.name} className="min-w-0">
                        <MediaTile
                          className="h-full"
                          controlProps={{ "data-venue-tile-btn": "" }}
                          onSelect={() => {
                            if (on && multi) {
                              setOpenLayoutsFor((cur) => (cur === v.name ? null : v.name));
                              return;
                            }
                            setOpenLayoutsFor(null);
                            setLayoutId(shown.id);
                          }}
                          aria-pressed={on}
                          chosen={on}
                          navDefault={on}
                          media={
                            <OutlineThumb
                              outline={shown.outline}
                              className={cx("p-4 pt-10", multi ? "pb-10" : undefined, on ? "text-lc-chalk" : "text-lc-slate")}
                            />
                          }
                          overlay={<CircuitQualityTag layout={shown} text={data.qualityText} size="sm" />}
                          title={v.name}
                          meta={
                            <>
                              <span className={pb ? "block truncate" : "block"}>
                                {v.country} <span aria-hidden>·</span> <span className="lc-mono">{lengthOf(shown)}</span>
                              </span>
                              {pb ? (
                                <span className="mt-0.5 flex items-center gap-1.5 text-[12px]">
                                  <Icon
                                    name="lapTimes"
                                    label={tx("circuits.personalBest")}
                                    size="xs"
                                    className={pb.forCurrentCar && !pb.legacyPhysics ? "text-lc-best" : "text-lc-slate"}
                                  />
                                  <span
                                    className={cx(
                                      "lc-mono font-semibold",
                                      pb.legacyPhysics ? "text-lc-fog" : pb.forCurrentCar ? "text-lc-chalk" : "text-lc-fog",
                                    )}
                                  >
                                    {formatLapTime(pb.lapTimeMs)}
                                  </span>
                                  {pb.legacyPhysics ? (
                                    <span className="truncate text-[11px] text-lc-slate">
                                      {pb.forCurrentCar ? tx("circuits.oldPhysics") : tx("circuits.carOldPhysics", { car: pbCarLabel })}
                                    </span>
                                  ) : !pb.forCurrentCar ? (
                                    <span className="truncate text-[11px] text-lc-slate">{pbCarLabel}</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </>
                          }
                          action={v.source ? <SourceChip source={v.source} /> : undefined}
                          mediaFooter={
                            multi ? (
                              <VenueLayoutPicker
                                venueName={v.name}
                                layouts={v.layouts}
                                value={shown.id}
                                chosen={on}
                                open={openLayoutsFor === v.name}
                                onOpenChange={(next) => setOpenLayoutsFor(next ? v.name : null)}
                                lengthOf={lengthOf}
                                bestLapOf={(id) => {
                                  const lpb = bestLapForCircuit(bestLaps, id, car.vehicle);
                                  return lpb
                                    ? {
                                        text: formatLapTime(lpb.lapTimeMs),
                                        forCurrentCar: lpb.forCurrentCar,
                                        legacyPhysics: lpb.legacyPhysics,
                                      }
                                    : null;
                                }}
                                onSelect={(id) => {
                                  setVenueLayoutMemory((m) => ({ ...m, [v.name]: id }));
                                  setLayoutId(id);
                                }}
                              />
                            ) : undefined
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {tab === "cars" ? (
              <div className="flex flex-col gap-5">
                <div role="group" aria-label={tx("cars.filter")} className="flex flex-wrap items-center gap-2">
                  {CAR_FILTERS.map((f) => {
                    const pool = carsWith(f.key);
                    const all = [...new Set(data.cars.map((c) => f.of(c, data.qualityText)).filter(Boolean))];
                    if (f.key === "modder") all.sort((a, b) => a.localeCompare(b));
                    // A filter with one option narrows nothing
                    if (all.length < 2) return null;
                    const picked = carFilters[f.key];
                    const countOf = (o: string) => pool.filter((c) => f.of(c, data.qualityText) === o).length;
                    const options = all.filter((o) => o === picked || countOf(o) > 0);
                    return (
                      <Select
                        key={f.key}
                        aria-label={tx(`carFilters.${f.key}.label`)}
                        value={picked}
                        onChange={(v) => {
                          setOpenLiveriesFor(null);
                          setCarFilters((cur) => ({ ...cur, [f.key]: v }));
                        }}
                        options={[
                          { id: "", label: tx(`carFilters.${f.key}.all`) },
                          ...options.map((o) => ({ id: o, label: tx("filterOption", { option: o, count: String(countOf(o)) }) })),
                        ]}
                      />
                    );
                  })}
                  {carsFiltered ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Icon name="reset" />}
                      onClick={() => {
                        setOpenLiveriesFor(null);
                        setCarFilters(NO_CAR_FILTERS);
                      }}
                    >
                      {tx("clearFilters")}
                    </Button>
                  ) : null}
                  {/* Mounted from the start, so the first change of filter is announced */}
                  <p role="status" className="lc-data m-0 ms-auto text-[12px] font-medium text-lc-slate">
                    {carsFiltered ? tx("cars.shown", { shown: String(shownCars.length), total: String(data.cars.length) }) : ""}
                  </p>
                </div>
                {shownCars.length ? null : (
                  <EmptyState
                    icon={<Icon name="filter" />}
                    action={
                      <Button size="sm" onClick={() => setCarFilters(NO_CAR_FILTERS)}>
                        {tx("clearFilters")}
                      </Button>
                    }
                  >
                    {tx("cars.empty")}
                  </EmptyState>
                )}
                <div className={WALL}>
                  {shownCars.map((c) => {
                    const on = c === car;
                    const multi = c.liveries.length > 1;
                    const activeLiveryId = activeLiveryIdOf(c);
                    const customSwatch = customLivery
                      ? `linear-gradient(130deg, ${customLivery.primary} 0 52%, ${customLivery.accent} 52% 64%, ${customLivery.secondary} 64% 100%)`
                      : undefined;
                    return (
                      <div key={c.id} data-car-card={c.id} className="min-w-0">
                        <MediaTile
                          className="h-full"
                          controlProps={{ "data-car-tile-btn": "" }}
                          onSelect={() => {
                            if (on && multi) {
                              setOpenLiveriesFor((cur) => (cur === c.id ? null : c.id));
                              return;
                            }
                            setOpenLiveriesFor(null);
                            setCarId(c.id);
                          }}
                          aria-pressed={on}
                          chosen={on}
                          navDefault={on}
                          media={
                            <CarThumb
                              src={activeThumbOf(c)}
                              fallbackSrc={c.thumb}
                              className={cx("object-contain p-2.5 pt-8", multi ? "pb-9" : undefined)}
                            />
                          }
                          overlay={<CarQualityTag car={c} text={data.qualityText} size="sm" />}
                          title={c.title}
                          meta={tx("classYear", { class: c.classTitle, year: String(c.year) })}
                          action={<SourceChip source={c.source} />}
                          mediaFooter={
                            multi ? (
                              <CarLiveryPicker
                                carTitle={c.title}
                                liveries={c.liveries}
                                value={activeLiveryId}
                                customSwatch={customSwatch}
                                fallbackThumb={c.thumb}
                                chosen={on}
                                open={openLiveriesFor === c.id}
                                onOpenChange={(next) => setOpenLiveriesFor(next ? c.id : null)}
                                onSelect={(id) => selectCarLivery(c, id)}
                              />
                            ) : undefined
                          }
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {tab === "download" ? <HomeDownloads variant="hub" /> : null}

            {tab === "about" ? (
              <div className="grid gap-x-16 gap-y-12 pt-4 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
                <div className="flex min-w-0 flex-col gap-8">
                  <p className="m-0 max-w-[34ch] text-[clamp(22px,1.5vw,30px)] leading-[1.4] font-medium text-lc-chalk">
                    {tx("about.lead")}
                  </p>
                  <dl className="m-0 flex flex-col">
                    {GAME_FACTS.map((fact) => (
                      <div key={fact} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 border-t border-lc-line py-3.5 max-sm:grid-cols-1 max-sm:gap-y-1">
                        <dt className="lc-lbl pt-0.5">{tx(`facts.${fact}.label`)}</dt>
                        <dd className="lc-body m-0 text-[15px] text-lc-chalk">{tx(`facts.${fact}.text`)}</dd>
                      </div>
                    ))}
                  </dl>
                  <section aria-labelledby="add-your-mod" className="flex flex-col gap-4 pt-2">
                    <h2 id="add-your-mod" className="lc-h2">
                      {tx("about.addMod")}
                    </h2>
                    <p className="lc-body m-0 max-w-[60ch] text-[16px] leading-[1.6]">
                      {tx.rich("about.addModText", {
                        email: data.contactEmail,
                        mail: (chunks) => (
                          <a href={`mailto:${data.contactEmail}`} translate="no" className={TEXT_LINK}>
                            {chunks}
                          </a>
                        ),
                      })}
                    </p>
                  </section>
                  {/* Who made the circuits and cars, those who take donations first, each with their link */}
                  {data.modders.length ? (
                    <section aria-labelledby="the-modders" className="flex flex-col gap-4 pt-2">
                      <h2 id="the-modders" className="lc-h2">
                        {tx("about.modders")}
                      </h2>
                      <p className="lc-body m-0 max-w-[60ch] text-[16px] leading-[1.6]">{tx("about.moddersText")}</p>
                      <ul className="m-0 flex list-none flex-col p-0">
                        {data.modders.map((m) => (
                          <li key={m.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-lc-line py-3 last:border-b">
                            <span className="flex min-w-0 flex-col gap-0.5">
                              {storeBuild && m.support && m.url === m.support.url ? (
                                <span className="self-start text-lc-chalk">{m.name}</span>
                              ) : (
                                <span className="flex flex-wrap items-baseline gap-x-2">
                                  <a href={m.url} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`self-start inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
                                    {m.name}
                                  </a>
                                  {!m.support && m.url.includes("overtake.gg/members/") ? (
                                    <a href={m.url} target="_blank" rel="noopener" className="lc-hint text-[12px] underline decoration-lc-keyline underline-offset-2 hover:text-lc-chalk">
                                      {m.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                                    </a>
                                  ) : null}
                                </span>
                              )}
                              <span className="lc-hint text-[13px]">{m.works.join(", ")}</span>
                            </span>
                            <SupportButton support={m.support} maker={m.name} variant="secondary" />
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {/* The people whose pull requests are in the game, each linking to their GitHub and their pull requests */}
                  <section aria-labelledby="code-contributors" className="flex flex-col gap-4 pt-2">
                    <h2 id="code-contributors" className="lc-h2">
                      {tx("about.contributors")}
                    </h2>
                    <p className="lc-body m-0 max-w-[60ch] text-[16px] leading-[1.6]">{tx("about.contributorsText")}</p>
                    <ul className="m-0 flex list-none flex-col p-0">
                      {CODE_CONTRIBUTORS.map((c) => (
                        <li key={c.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-lc-line py-3 last:border-b">
                          <a href={c.url} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
                            {c.name}
                          </a>
                          <span className="lc-hint flex flex-wrap gap-x-3 text-[13px]">
                            {c.pulls.map((n) => (
                              <a key={n} href={`${REPO_URL}/pull/${n}`} target="_blank" rel="noopener" onPointerEnter={focusOnHover} className={`inline-flex items-center tabular-nums pointer-coarse:min-h-11 ${TEXT_LINK}`}>
                                #{n}
                              </a>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
                <section aria-labelledby="press-and-media" className="flex min-w-0 flex-col gap-5">
                  <h2 id="press-and-media" className="lc-h2">
                    {tx("press.title")}
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
                          <span className="sr-only">{tc("newTab")}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-x-6 gap-y-3 text-[14px]">
                    {[
                      [tx("about.links.download"), withBasePath("/download")],
                      [tx("about.links.press"), withBasePath("/press")],
                      [tx("about.links.stats"), withBasePath("/stats")],
                      [tx("about.links.docs"), DOCS_URL],
                      [tx("about.links.privacy"), withBasePath("/privacy")],
                      ["GitHub", data.repoUrl],
                      // Not in the Android app (store-mode.ts)
                      ...(storeBuild ? [] : [[tx("about.links.support"), data.supportUrl]]),
                      ...AUTHOR_LINKS.map(({ label, href }) => [label, href]),
                    ].map(([label, href]) => (
                      <a key={href} href={href} onPointerEnter={focusOnHover} className={`inline-flex items-center pointer-coarse:min-h-11 ${TEXT_LINK}`}>
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
          {/* SignPath Foundation's terms want the words "Code signing policy" on the home page. The arrows and the pad
              pass over these; Tab reaches them. GitHub and the policy open in a new tab */}
          <div data-nav-skip="" className="flex shrink-0 items-center gap-x-5 text-[13px] font-semibold max-md:hidden">
            {(
              [
                ["GitHub", data.repoUrl, true],
                [td("signingPolicy"), RELEASE_LINKS.codeSigningPolicyUrl, true],
                [tm("stats"), withBasePath("/stats"), false],
                [tm("privacy"), withBasePath("/privacy"), false],
                [tm("press"), withBasePath("/press"), false],
              ] as const
            ).map(([label, href, external]) => (
              <a key={href} href={href} {...(external ? { target: "_blank", rel: "noopener" } : {})} className={BAR_LINK}>
                {label}
                {external ? <span className="sr-only"> {tc("newTab")}</span> : null}
              </a>
            ))}
          </div>
          <span title={tx("footer", { venue: venue.name, car: car.title })} className="max-w-[34%] truncate text-[13px] font-semibold text-lc-slate max-md:hidden">
            {tx("footer", { venue: venue.name, car: car.title })}
          </span>
        </footer>
      </div>
    </>
  );
};
