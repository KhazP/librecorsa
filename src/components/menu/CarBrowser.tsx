"use client";

import React, { useState } from "react";
import type { LiveryConfig } from "@/types/f1";
import { LIVERIES } from "@/lib/track-data";
import {
  CAR_QUALITY_META,
  CARS,
  carClass,
  carClassesInUse,
  carClassYear,
  carQualityMeta,
  carThumbUrl,
  compareCarsByClassAndYear,
  carTakesLivery,
  FACTORY_LIVERY_NOTE,
  PHYSICS_CHECK,
  type CarDefinition,
  type CarId,
  type CarQuality,
} from "@/lib/cars/car-registry";
import { carPhysics, carTakesPhysicsSwitch, F1_MOD_PHYSICS_OPTIONS, useF1ModPhysics } from "@/lib/cars/f1-mod-physics";
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { CarPhysicsSwitch } from "./CarPicker";
import { withBasePath } from "@/lib/base-path";
import { CarQualityBadge, CarSkinPicker, Chip, LiveryPicker } from "./menu-ui";

const byName = (a: CarDefinition, b: CarDefinition) => a.title.localeCompare(b.title);
const QUALITIES: readonly CarQuality[] = ["own", "shared", "era"];

/** A car's own vehicle model, for the cars without the physics switch (the GT3s say theirs in their sub line) */
const physicsLabel = (car: CarDefinition) =>
  car.classId === "f1" ? F1_MOD_PHYSICS_OPTIONS.find((o) => o.id === car.physics)?.title : undefined;

/**
 * The car's picture (`npm run car-thumbs`); a copy without the file (a clone, for a hosted car) shows nothing here and
 * the card keeps its text. A car that takes liveries is pictured in the default one.
 */
const CarThumb: React.FC<{ car: CarDefinition; className?: string }> = ({ car, className = "" }) => {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // A plain img: a static file the export serves as is (next/image would need a loader for it)
    <img
      src={withBasePath(carThumbUrl(car.id))}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      className={`pointer-events-none object-contain select-none ${className}`}
    />
  );
};

const Spec: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
  <div className="flex items-baseline justify-between gap-3 border-t border-white/[0.07] py-2">
    <span className="lc-lbl">{k}</span>
    <span className="min-w-0 text-right text-[13px] font-semibold text-[#F5F7FA]">{children}</span>
  </div>
);

/**
 * Every car in the game, from the car registry: its classes become the categories (a new class shows up on its own),
 * each split by year, newest first, with favourites and recently driven. Opened from the Engineer's Garage.
 */
export const CarBrowser: React.FC<{
  carId: CarId;
  onChangeCar: (car: CarId) => void;
  selectedLivery: LiveryConfig;
  onChangeLivery: (livery: LiveryConfig) => void;
  library?: LibraryProps;
  /** Back to where the browser was opened from */
  onClose?: () => void;
  /** Before the search field (the Back button) */
  toolbar?: React.ReactNode;
  /** The car cannot change now (an online race): the detail pane says why instead of offering Choose car */
  lockedReason?: string;
}> = ({ carId, onChangeCar, selectedLivery, onChangeLivery, library, onClose, toolbar, lockedReason }) => {
  const classes = carClassesInUse();
  const modPhysics = useF1ModPhysics();
  const qualities = QUALITIES.filter((q) => CARS.some((c) => c.quality === q));
  const favs = library?.library.favorites.cars ?? [];
  const recent = library?.library.recent.cars ?? [];
  const recentRank = (c: CarDefinition) => {
    const i = recent.indexOf(c.id);
    return i < 0 ? Infinity : i;
  };

  const filterGroups: BrowserFilterGroup<CarDefinition>[] = [
    {
      label: "Library",
      filters: [
        { id: "all", label: "All cars", test: () => true },
        { id: "fav", label: "Favourites", test: (c) => favs.includes(c.id) },
        { id: "recent", label: "Recently driven", test: (c) => recent.includes(c.id) },
      ],
    },
    { label: "Class", filters: classes.map((k) => ({ id: `class:${k.id}`, label: k.title, test: (c: CarDefinition) => c.classId === k.id })) },
    {
      label: "Physics",
      filters: qualities.map((q) => ({ id: `quality:${q}`, label: CAR_QUALITY_META[q].filterLabel, test: (c: CarDefinition) => c.quality === q })),
    },
  ];

  const sorts: BrowserSort<CarDefinition>[] = [
    {
      id: "class",
      label: "Class",
      groupBy: (c) => carClass(c.classId).title,
      groupOrder: classes.map((k) => k.title),
      subGroupBy: (c) => String(c.year),
      compare: compareCarsByClassAndYear,
    },
    {
      id: "quality",
      label: "Physics",
      groupBy: (c) => carQualityMeta(c).filterLabel,
      groupOrder: qualities.map((q) => CAR_QUALITY_META[q].filterLabel),
      compare: compareCarsByClassAndYear,
    },
    { id: "name", label: "A–Z", heading: "A–Z", compare: byName },
    { id: "recent", label: "Recent", heading: "Recently driven first", compare: (a, b) => recentRank(a) - recentRank(b) || compareCarsByClassAndYear(a, b) },
  ];

  return (
    <ContentBrowser<CarDefinition>
      label="Cars"
      noun="cars"
      items={CARS}
      idOf={(c) => c.id}
      searchText={(c) => {
        const k = carClass(c.classId);
        const q = carQualityMeta(c);
        return `${c.title} ${c.sub} ${c.badge} ${c.year} ${k.title} ${k.sub} ${q.badge} ${q.filterLabel} ${c.credit.author}`;
      }}
      searchPlaceholder="Search cars, classes, years"
      filterGroups={filterGroups}
      sorts={sorts}
      initialSelectedId={carId}
      isFavorite={(c) => favs.includes(c.id)}
      onToggleFavorite={library ? (c) => library.onToggleFavorite("cars", [c.id]) : undefined}
      onClose={onClose}
      toolbar={toolbar}
      renderCard={(c) => (
        <span className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-[17px] phone:flex-row phone:items-stretch phone:gap-0">
          <span className="relative flex min-h-[58px] flex-col justify-end border-b border-[#262B3D] bg-[#1B1F2B]/70 px-3 pt-9 pb-2 phone:w-[132px] phone:shrink-0 phone:border-r phone:border-b-0 phone:px-2 phone:pt-8">
            {/* Clear of the favourite star in the corner */}
            <span className="absolute top-2.5 right-10 left-3 flex phone:right-2 phone:left-2">
              <Chip size="sm" className="max-w-full overflow-hidden">
                <span className="truncate">{carClassYear(c)}</span>
              </Chip>
            </span>
            <CarThumb car={c} className="-mt-2 h-[84px] w-full phone:h-[64px]" />
            <span className="lc-data ml-auto text-[11px] tracking-[0.12em] text-[#C5CBD8] phone:hidden">{c.badge}</span>
          </span>
          <span className="flex min-w-0 flex-col gap-1 px-3 pt-0.5 pb-3 phone:flex-1 phone:justify-center phone:py-2.5 phone:pr-9">
            <span className="lc-disp text-[17px] leading-[1.05] [overflow-wrap:anywhere] hyphens-auto">{c.title}</span>
            <span className="line-clamp-2 text-[12px] leading-snug text-[#8E96AA]">{c.sub}</span>
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <CarQualityBadge car={c} size="xs" />
              {c.id === carId ? (
                <Chip color="#F5F7FA" size="sm">
                  Current
                </Chip>
              ) : null}
            </span>
          </span>
        </span>
      )}
      renderDetail={(c) => {
        const k = carClass(c.classId);
        const own = physicsLabel(c);
        const q = carQualityMeta(c);
        return (
          <>
            <CarThumb car={c} className="-mx-1 -mt-1 h-auto w-[calc(100%+0.5rem)] max-w-none" />
            <div className="flex flex-wrap items-center gap-1.5">
              <CarQualityBadge car={c} />
              <Chip>{carClassYear(c)}</Chip>
              <span className="lc-data text-[11px] tracking-[0.12em] text-[#C5CBD8]">{c.badge}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="lc-disp text-[26px]">{c.title}</span>
              <span className="text-[13px] text-[#C5CBD8]">{c.sub}</span>
            </div>
            <div>
              <Spec k="Class">
                {k.title} · {k.sub}
              </Spec>
              <Spec k="Year">{c.year}</Spec>
              {own && !carTakesPhysicsSwitch(c.id) ? <Spec k="Physics">{own}</Spec> : null}
            </div>
            {carTakesPhysicsSwitch(c.id) ? <CarPhysicsSwitch color="#CCFF00" /> : null}
            <div className="flex flex-col gap-1 rounded-[10px] border border-[#262B3D] bg-[#08090D]/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.08em] uppercase" style={{ color: q.color }}>
                  {q.filterLabel}
                </span>
                <span className="text-[11px] font-semibold text-[#C5CBD8]">
                  {c.credit.label ?? "Model by"}{" "}
                  <a
                    href={c.credit.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-[#4A5268] underline-offset-2 hover:text-[#F5F7FA]"
                  >
                    {c.credit.author}
                  </a>
                </span>
              </div>
              <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">
                {q.description} {PHYSICS_CHECK[carPhysics(c.id, modPhysics)]}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <span className="lc-lbl">Livery</span>
              {carTakesLivery(c.id) ? (
                <LiveryPicker liveries={LIVERIES} value={selectedLivery} onChange={onChangeLivery} surface="#11131A" />
              ) : c.skins?.length ? (
                <CarSkinPicker carId={c.id} surface="#11131A" />
              ) : (
                <p className="m-0 text-[12px] text-[#8E96AA]">{FACTORY_LIVERY_NOTE}</p>
              )}
            </div>
          </>
        );
      }}
      footnote={
        <p className="m-0 mx-1 mt-1 text-[12px] leading-relaxed text-[#8E96AA]">
          {qualities.map((q) => (
            <React.Fragment key={q}>
              <strong style={{ color: CAR_QUALITY_META[q].color }}>{CAR_QUALITY_META[q].filterLabel}:</strong> {CAR_QUALITY_META[q].description}{" "}
            </React.Fragment>
          ))}
        </p>
      }
      primaryAction={(c) =>
        c.id === carId
          ? { label: "Current car", disabled: true, current: true, run: () => {} }
          : lockedReason
            ? { label: lockedReason, disabled: true, run: () => {} }
            : {
              label: "Choose car",
              run: () => {
                onChangeCar(c.id);
                onClose?.();
              },
            }
      }
    />
  );
};
