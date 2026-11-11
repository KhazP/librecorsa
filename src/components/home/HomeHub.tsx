"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronRight, Play } from "lucide-react";
import { LibreCorsaLogo } from "@/components/ui/LibreCorsaLogo";
import { withBasePath } from "@/lib/base-path";
import { SITE_DESCRIPTION } from "@/lib/site";
import { day, GAME_FACTS, GRADE_NOTES, km, type HomeData } from "./home-data";
import { CarThumb, GradeBadge, GradeLegend, OutlineThumb, Prompt, KeyCap } from "./home-ui";
import { LapMap } from "./LapMap";
import { PLAY_HREF, rememberPicks, storedPicks } from "./play";
import { PlayLink } from "./PlayLink";
import { usePadButtons } from "./usePadButtons";

/*
 * The home page, laid out like a console racer's home hub. Sections across the top (Q / E, or a controller's
 * bumpers), big picture tiles underneath: Drive takes most of the screen, the circuit's lap runs in its own tile, the
 * car and the press sit beside it. Circuits and Cars are card walls to pick from, each card marked sim grade or 3D
 * model; Drive stays in the corner of every section and opens the game (/play) on the picks.
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
/** The option a setting is on: white, never volt (docs/DESIGN.md §6) */
const CHOSEN_PILL = "bg-[#262B3D] text-[#F5F7FA] shadow-[inset_0_0_0_1px_rgba(245,247,250,0.28)]";
/** A tile gives a little when pressed and lights its edge under the pointer */
const TILE =
  "group relative overflow-hidden rounded-[26px] border border-[#262B3D] bg-[#0D0F15] text-left text-[#F5F7FA] no-underline transition-[transform,border-color] duration-150 ease-out hover:border-[#3A4157] active:scale-[0.99] motion-reduce:active:scale-100";
const MORE = "inline-flex items-center gap-1 text-[13px] font-semibold text-[#C5CBD8] group-hover:text-[#F5F7FA]";
const CARD_ON = "border-[1.5px] border-[#F5F7FA]/60";
const CARD_OFF = "border border-[#262B3D] hover:border-[#3A4157]";

const ChosenMark: React.FC = () => (
  <span className="absolute top-2.5 right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#F5F7FA] text-[#08090D]">
    <Check aria-hidden className="h-3.5 w-3.5" strokeWidth={3.5} />
  </span>
);

export const HomeHub: React.FC<{ data: HomeData }> = ({ data }) => {
  const [tab, setTab] = useState<Tab>("home");
  const [layoutId, setLayoutId] = useState(data.defaultTrackId);
  const [carId, setCarId] = useState(data.defaultCarId);
  const driveRef = useRef<HTMLAnchorElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const speedRef = useRef<HTMLSpanElement | null>(null);

  // A returning player's last circuit and car (the page is built with the defaults)
  useEffect(() => {
    const { trackId, carId: stored } = storedPicks();
    if (trackId && data.venues.some((v) => v.layouts.some((l) => l.id === trackId))) setLayoutId(trackId);
    if (stored && data.cars.some((c) => c.id === stored)) setCarId(stored);
  }, [data.venues, data.cars]);

  const venue = data.venues.find((v) => v.layouts.some((l) => l.id === layoutId)) ?? data.venues[0];
  const layout = venue.layouts.find((l) => l.id === layoutId) ?? venue.layouts[0];
  const car = data.cars.find((c) => c.id === carId) ?? data.cars[0];
  const picks = { trackId: layout.id, carId: car.id };

  const go = useCallback((next: Tab) => {
    setTab(next);
    panelRef.current?.scrollTo({ top: 0 });
  }, []);
  const cycle = useCallback(
    (by: 1 | -1) => {
      const at = TABS.findIndex((t) => t.id === tab);
      go(TABS[(at + by + TABS.length) % TABS.length].id);
    },
    [tab, go]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "q") cycle(-1);
      else if (key === "e") cycle(1);
      // Enter is Drive unless the focus is on a control of its own
      else if (e.key === "Enter" && (document.activeElement === document.body || document.activeElement === null)) driveRef.current?.click();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cycle]);

  usePadButtons({ lb: () => cycle(-1), rb: () => cycle(1), start: () => driveRef.current?.click() });

  return (
    <main className="flex h-dvh flex-col bg-[#08090D] text-[#F5F7FA]">
      {/* Read by screen readers and search engines */}
      <h1 className="sr-only">LibreCorsa: free open-source racing simulator in your browser</h1>
      <p className="sr-only">{SITE_DESCRIPTION}</p>

      <header className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-3 sm:gap-x-6 pt-[max(1rem,env(safe-area-inset-top))] pb-4 ${GUTTER}`}>
        <LibreCorsaLogo variant="compact" size="sm" />
        <div className="flex items-center gap-2 max-md:order-last max-md:w-full">
          <span className="inline-flex pointer-coarse:hidden">
            <KeyCap>Q</KeyCap>
          </span>
          <div role="tablist" aria-label="Sections" className="flex gap-1 rounded-full border border-[#262B3D] bg-[#08090D] p-1 max-md:flex-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                onClick={() => go(t.id)}
                className={`lc-title h-9 cursor-pointer rounded-full border-0 px-4 text-[15px] transition-colors duration-150 ease-out max-md:flex-1 max-md:px-2 ${
                  t.id === tab ? CHOSEN_PILL : "bg-transparent text-[#8E96AA] hover:text-[#F5F7FA]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="inline-flex pointer-coarse:hidden">
            <KeyCap>E</KeyCap>
          </span>
        </div>
        {/* Beside the logo on a phone too: the tabs take the row under them */}
        <PlayLink ref={driveRef} label="Drive" picks={picks} className="ml-auto max-sm:px-5" />
      </header>

      <div ref={panelRef} role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className={`min-h-0 flex-1 overflow-y-auto pb-4 max-lg:pb-24 ${GUTTER}`}>
        {tab === "home" ? (
          <div className="grid gap-4 lg:h-full lg:min-h-[520px] lg:grid-cols-12 lg:grid-rows-2">
            <a href={PLAY_HREF} onClick={() => rememberPicks(picks)} className={`${TILE} flex min-h-[320px] lg:col-span-7 lg:row-span-2`}>
              <img
                src={withBasePath("/home/hero-1600.webp")}
                srcSet={[960, 1600, 2560].map((w) => `${withBasePath(`/home/hero-${w}.webp`)} ${w}w`).join(", ")}
                sizes="(min-width: 64rem) 58vw, 100vw"
                alt=""
                className="absolute inset-0 h-full w-full object-cover object-[62%_50%] transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none"
              />
              <span aria-hidden className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,9,13,0.94)_0%,rgba(8,9,13,0.4)_42%,rgba(8,9,13,0)_68%)]" />
              <span className="relative mt-auto flex w-full items-end justify-between gap-5 p-6 sm:p-8">
                <span className="flex min-w-0 flex-col gap-2.5">
                  <span className="lc-disp text-[clamp(52px,7.4vw,112px)]">Drive</span>
                  <span className="text-[15px] font-semibold text-[#C5CBD8]">
                    {venue.name}, {layout.layout}. {car.title}.
                  </span>
                </span>
                <span className="inline-flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-full bg-[#CCFF00] text-[#08090D]">
                  <Play aria-hidden className="ml-0.5 h-6 w-6" fill="currentColor" strokeWidth={0} />
                </span>
              </span>
            </a>

            <button type="button" onClick={() => go("circuits")} className={`${TILE} flex min-h-[230px] cursor-pointer p-6 lg:col-span-5`}>
              <span className="relative z-10 flex max-w-[52%] flex-col items-start gap-2">
                <span className="lc-disp text-[clamp(22px,2.2vw,32px)]">{venue.name}</span>
                <span className="text-[14px] text-[#C5CBD8]">{layout.layout}</span>
                {/* The badge shares the distance's line, so a two-line name still leaves room on a short screen */}
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                  <span className="lc-data text-[13px] text-[#8E96AA]">
                    {km(layout)} km, {layout.turns} turns
                  </span>
                  <GradeBadge grade={layout.grade} title={GRADE_NOTES.circuits[layout.grade]} />
                </span>
                {layout.outline?.kmh.length ? (
                  <span className="mt-1 flex items-baseline gap-1.5">
                    <span ref={speedRef} className="lc-data text-[34px] leading-none">
                      {layout.outline.kmh[0]}
                    </span>
                    <span className="text-[12px] font-semibold text-[#8E96AA]">km/h</span>
                  </span>
                ) : null}
                <span className={`${MORE} mt-auto pt-3`}>
                  Change circuit
                  <ChevronRight aria-hidden className="h-4 w-4" strokeWidth={2.4} />
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

            <button type="button" onClick={() => go("cars")} className={`${TILE} flex min-h-[230px] cursor-pointer flex-col p-5 lg:col-span-3`}>
              <span className="flex min-h-0 flex-1 items-center justify-center">
                <CarThumb key={car.id} src={car.thumb} className="max-h-full w-full object-contain" />
              </span>
              <span className="flex flex-col items-start gap-1.5">
                <span className="lc-disp text-[22px]">{car.title}</span>
                <span className="text-[13px] text-[#8E96AA]">
                  {car.classTitle}, {car.year}
                </span>
                <GradeBadge grade={car.grade} title={GRADE_NOTES.cars[car.grade]} className="mt-0.5" />
                <span className={`${MORE} pt-2`}>
                  Change car
                  <ChevronRight aria-hidden className="h-4 w-4" strokeWidth={2.4} />
                </span>
              </span>
            </button>

            <a href={withBasePath("/press")} className={`${TILE} flex min-h-[230px] flex-col gap-3 p-5 lg:col-span-2`}>
              <span className="lc-disp text-[22px]">In the press</span>
              <span className="flex flex-col gap-1.5 text-[13px] leading-snug text-[#C5CBD8]">
                {data.coverage.slice(0, 4).map((a) => (
                  <span key={a.url} className="truncate">
                    {a.outlet}
                  </span>
                ))}
              </span>
              <span className={`${MORE} mt-auto`}>
                Read it
                <ChevronRight aria-hidden className="h-4 w-4" strokeWidth={2.4} />
              </span>
            </a>
          </div>
        ) : null}

        {tab === "circuits" ? (
          <>
            <GradeLegend of="circuits" />
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
              {data.venues.map((v) => {
                const on = v === venue;
                const shown = on ? layout : v.layouts[0];
                return (
                  <div key={v.name} className={`flex flex-col overflow-hidden rounded-[18px] bg-[#11131A] transition-colors duration-150 ease-out ${on ? CARD_ON : CARD_OFF}`}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setLayoutId(v.layouts[0].id)}
                      className="flex cursor-pointer flex-col border-0 bg-transparent p-0 text-left text-[#F5F7FA] transition-transform duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100"
                    >
                      <span className="relative block aspect-[16/10] w-full bg-[#0B0D12]">
                        <OutlineThumb outline={shown.outline} className={`absolute inset-0 h-full w-full p-3 pt-9 ${on ? "text-[#F5F7FA]" : "text-[#8E96AA]"}`} />
                        <GradeBadge grade={shown.grade} title={GRADE_NOTES.circuits[shown.grade]} className="absolute top-2.5 left-2.5" />
                        {on ? <ChosenMark /> : null}
                      </span>
                      <span className="flex flex-col gap-1 px-4 pt-3 pb-3.5">
                        <span className="lc-title text-[16px] leading-[1.15]">{v.name}</span>
                        <span className="text-[13px] text-[#8E96AA]">{v.country}</span>
                        <span className="lc-data text-[12px] text-[#C5CBD8]">
                          {km(shown)} km, {shown.turns} turns
                        </span>
                      </span>
                    </button>
                    {on && v.layouts.length > 1 ? (
                      <div role="group" aria-label="Layout" className="flex flex-wrap gap-1 border-t border-[#262B3D] p-2">
                        {v.layouts.map((l) => (
                          <button
                            key={l.id}
                            type="button"
                            aria-pressed={l === layout}
                            onClick={() => setLayoutId(l.id)}
                            className={`h-8 cursor-pointer rounded-full border-0 px-3 text-[12px] font-semibold transition-colors duration-150 ease-out ${
                              l === layout ? CHOSEN_PILL : "bg-transparent text-[#C5CBD8] hover:text-[#F5F7FA]"
                            }`}
                          >
                            {l.layout}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {tab === "cars" ? (
          <>
            <GradeLegend of="cars" />
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">
              {data.cars.map((c) => {
                const on = c === car;
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCarId(c.id)}
                    className={`relative flex cursor-pointer flex-col overflow-hidden rounded-[18px] bg-[#11131A] p-0 text-left text-[#F5F7FA] transition-[transform,border-color] duration-150 ease-out active:scale-[0.98] motion-reduce:active:scale-100 ${
                      on ? CARD_ON : CARD_OFF
                    }`}
                  >
                    <span className="block aspect-[16/9] w-full bg-[#0B0D12] pt-7">
                      <CarThumb src={c.thumb} className="h-full w-full object-contain p-2.5" />
                    </span>
                    <GradeBadge grade={c.grade} title={GRADE_NOTES.cars[c.grade]} className="absolute top-2.5 left-2.5" />
                    {on ? <ChosenMark /> : null}
                    <span className="flex flex-col gap-1 px-4 pt-3 pb-3.5">
                      <span className="lc-title text-[16px] leading-[1.15]">{c.title}</span>
                      <span className="text-[13px] text-[#8E96AA]">
                        {c.classTitle}, {c.year}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}

        {tab === "about" ? (
          <div className="grid gap-x-14 gap-y-10 pt-2 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
            <div className="flex min-w-0 flex-col gap-7">
              <p className="m-0 max-w-[560px] text-[19px] leading-relaxed text-[#F5F7FA]">
                LibreCorsa is a free, open-source racing simulator that runs in your browser. I make it on my own.
              </p>
              <dl className="m-0 flex flex-col">
                {GAME_FACTS.map(([label, text]) => (
                  <div key={label} className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-5 border-t border-[#262B3D] py-3.5">
                    <dt className="text-[14px] text-[#8E96AA]">{label}</dt>
                    <dd className="m-0 text-[15px] leading-snug text-[#F5F7FA]">{text}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="flex min-w-0 flex-col gap-6">
              <h2 className="lc-disp m-0 text-[28px]">In the press</h2>
              <ul className="m-0 flex list-none flex-col p-0">
                {data.coverage.map((a) => (
                  <li key={a.url} className="border-t border-[#262B3D] last:border-b">
                    <a href={a.url} target="_blank" rel="noopener" className="group flex items-start justify-between gap-4 py-3.5 text-[#F5F7FA] no-underline">
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="lc-title text-[15px]">{a.outlet}</span>
                        <span className="text-[14px] leading-snug text-[#C5CBD8] group-hover:text-[#F5F7FA]">{a.title}</span>
                        <span className="lc-data text-[12px] font-semibold text-[#8E96AA]">{day(a.date)}</span>
                      </span>
                      <ArrowUpRight aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[#8E96AA] group-hover:text-[#F5F7FA]" strokeWidth={2.2} />
                    </a>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-[14px] font-semibold">
                {[
                  ["All coverage and the press kit", withBasePath("/press")],
                  ["Privacy", withBasePath("/privacy")],
                  ["GitHub", data.repoUrl],
                  ["Buy me a coffee", data.supportUrl],
                ].map(([label, href]) => (
                  <a key={label} href={href} className="text-[#C5CBD8] underline decoration-[#3A4157] underline-offset-4 hover:text-[#F5F7FA] hover:decoration-[#F5F7FA]">
                    {label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <footer className={`flex shrink-0 items-center justify-between gap-4 border-t border-[#262B3D]/70 pt-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] max-lg:hidden pointer-coarse:hidden ${GUTTER}`}>
        <span className="flex items-center gap-x-[22px]">
          <Prompt keys={["Q", "E"]}>Switch section</Prompt>
          <Prompt keys={["ENTER"]}>Drive</Prompt>
        </span>
        <span className="max-w-[34%] truncate text-[13px] font-semibold text-[#8E96AA]">
          {venue.name}, {car.title}
        </span>
      </footer>
    </main>
  );
};
