"use client";

import React, { useState } from "react";
import type { LiveryConfig } from "@/types/f1";
import { LIVERIES } from "@/lib/track-data";
import {
  CAR_QUALITY_META,
  CARS,
  carClass,
  carClassesInUse,
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
import { Disclosure, Skeleton } from "@/components/ui";
import { StateBadge } from "@/components/ui/badges/StateBadge";
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { CarPhysicsSwitch } from "./CarPicker";
import { withBasePath } from "@/lib/base-path";
import { CarClassTag, CarQualityBadge, CarSkinPicker, LiveryPicker } from "./menu-content-ui";
import { SourceChip } from "@/components/SourceChip";
import { carModelSource } from "@/lib/model-source";

const byName = (a: CarDefinition, b: CarDefinition) => a.title.localeCompare(b.title);
const QUALITIES: readonly CarQuality[] = ["own", "shared", "era"];

/** A car's own vehicle model, for the cars without the physics switch (the GT3s say theirs in their sub line) */
const physicsLabel = (car: CarDefinition) =>
  car.classId === "f1" ? F1_MOD_PHYSICS_OPTIONS.find((o) => o.id === car.physics)?.title : undefined;

/**
 * The car's picture (`npm run car-thumbs`), a titanium block while it loads; a copy without the file (a clone, for a
 * hosted car) keeps the block. A car that takes liveries is pictured in the default one.
 */
export const CarThumb: React.FC<{ car: CarDefinition; className?: string }> = ({ car, className = "" }) => {
  const [state, setState] = useState<"loading" | "done" | "failed">("loading");
  return (
    <>
      {state !== "done" ? <Skeleton className={`absolute inset-3 ${state === "failed" ? "[animation:none]" : ""}`} /> : null}
      {state === "failed" ? null : (
        // A plain img: a static file the export serves as is (next/image would need a loader for it)
        <img
          src={withBasePath(carThumbUrl(car.id))}
          alt={car.title}
          width={640}
          height={360}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState("done")}
          onError={() => setState("failed")}
          className={`pointer-events-none relative object-contain select-none ${state === "done" ? "" : "opacity-0"} ${className}`}
        />
      )}
    </>
  );
};

/**
 * Every car in the game, from the car registry: its classes become the categories (a new class shows up on its own),
 * each split by year, newest first, with favourites and recently driven. Opened from the title menu's Car entry.
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
      label: "Show",
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
    { id: "name", label: "A to Z", heading: "A to Z", compare: byName },
    { id: "recent", label: "Recently driven", heading: "Recently driven first", compare: (a, b) => recentRank(a) - recentRank(b) || compareCarsByClassAndYear(a, b) },
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
      searchPlaceholder="Cars, classes, years"
      filterGroups={filterGroups}
      sorts={sorts}
      initialSelectedId={carId}
      isFavorite={(c) => favs.includes(c.id)}
      onToggleFavorite={library ? (c) => library.onToggleFavorite("cars", [c.id]) : undefined}
      onClose={onClose}
      toolbar={toolbar}
      renderCard={(c) => ({
        media: <CarThumb car={c} className="p-2.5 pt-9" />,
        title: c.title,
        meta: `${carClass(c.classId).title}, ${c.year}`,
        badges: (
          <>
            <CarClassTag car={c} />
            <CarQualityBadge car={c} size="sm" />
          </>
        ),
        overlay: c.id === carId ? <StateBadge state="inUse" size="sm" /> : undefined,
      })}
      renderDetail={(c) => {
        const own = physicsLabel(c);
        const q = carQualityMeta(c);
        return (
          <>
            <span className="relative -mx-1 -mt-1 block aspect-video overflow-hidden rounded-lc-tile bg-lc-well [&>img]:size-full">
              <CarThumb car={c} className="p-2" />
            </span>
            <div className="flex flex-col gap-1.5">
              <h3 className="lc-h3 m-0 [overflow-wrap:anywhere]">{c.title}</h3>
              <p className="lc-body m-0">
                {c.sub}
                {own && !carTakesPhysicsSwitch(c.id) ? `, ${own} physics` : ""}
              </p>
              <span className="mt-1 flex flex-wrap gap-1.5">
                <CarClassTag car={c} />
                <CarQualityBadge car={c} size="sm" />
              </span>
            </div>
            {carTakesPhysicsSwitch(c.id) ? <CarPhysicsSwitch /> : null}
            {carTakesLivery(c.id) ? (
              <LiveryPicker liveries={LIVERIES} value={selectedLivery} onChange={onChangeLivery} surface="var(--color-lc-carbon)" />
            ) : c.skins?.length ? (
              <CarSkinPicker carId={c.id} surface="var(--color-lc-carbon)" />
            ) : (
              <p className="lc-hint m-0">{FACTORY_LIVERY_NOTE}</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="lc-hint">
                {c.credit.label ?? "Model by"}{" "}
                <a
                  href={c.credit.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-lc-fog underline decoration-lc-keyline underline-offset-2 hover:text-lc-chalk"
                >
                  {c.credit.author}
                </a>
                {c.tyreCredit ? (
                  <>
                    , tyres by{" "}
                    <a
                      href={c.tyreCredit.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-lc-fog underline decoration-lc-keyline underline-offset-2 hover:text-lc-chalk"
                    >
                      {c.tyreCredit.author}
                    </a>
                  </>
                ) : null}
              </span>
              <SourceChip source={carModelSource(c)} />
            </div>
            <Disclosure moreLabel="About the physics" lessLabel="Less">
              <p className="lc-hint m-0 pb-1">
                {q.description} {PHYSICS_CHECK[carPhysics(c.id, modPhysics)]}
              </p>
            </Disclosure>
          </>
        );
      }}
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
