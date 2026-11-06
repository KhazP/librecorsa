"use client";

import React from "react";
import type { LiveryConfig } from "@/types/f1";
import { LIVERIES } from "@/lib/track-data";
import {
  CARS,
  carClass,
  carClassesInUse,
  carTakesLivery,
  FACTORY_LIVERY_NOTE,
  type CarDefinition,
  type CarId,
} from "@/lib/cars/car-registry";
import { carTakesPhysicsSwitch, F1_MOD_PHYSICS_OPTIONS } from "@/lib/cars/f1-mod-physics";
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { CarPhysicsSwitch } from "./CarPicker";
import { Chip } from "./menu-ui";
import { focusOnHover } from "./useFocusNav";

const ORDER = new Map(CARS.map((c, i) => [c.id, i]));
const byRegistry = (a: CarDefinition, b: CarDefinition) => (ORDER.get(a.id) ?? 0) - (ORDER.get(b.id) ?? 0);
const byName = (a: CarDefinition, b: CarDefinition) => a.title.localeCompare(b.title);

/** A car's own vehicle model, for the cars without the physics switch (the GT3s say theirs in their sub line) */
const physicsLabel = (car: CarDefinition) =>
  car.classId === "f1-2026" ? F1_MOD_PHYSICS_OPTIONS.find((o) => o.id === car.physics)?.title : undefined;

const Spec: React.FC<{ k: string; children: React.ReactNode }> = ({ k, children }) => (
  <div className="flex items-baseline justify-between gap-3 border-t border-white/[0.07] py-2">
    <span className="lc-lbl text-[10px]">{k}</span>
    <span className="min-w-0 text-right text-[13px] font-semibold text-[#F5F7FA]">{children}</span>
  </div>
);

/**
 * Every car in the game, from the car registry: its classes become the categories (a new class shows up on its own),
 * with favourites and recently driven. Opened from the Engineer's Garage.
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
}> = ({ carId, onChangeCar, selectedLivery, onChangeLivery, library, onClose, toolbar }) => {
  const classes = carClassesInUse();
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
  ];

  const sorts: BrowserSort<CarDefinition>[] = [
    { id: "class", label: "Class", groupBy: (c) => carClass(c.classId).title, groupOrder: classes.map((k) => k.title), compare: byRegistry },
    { id: "name", label: "A–Z", heading: "A–Z", compare: byName },
    { id: "recent", label: "Recent", heading: "Recently driven first", compare: (a, b) => recentRank(a) - recentRank(b) || byRegistry(a, b) },
  ];

  return (
    <ContentBrowser<CarDefinition>
      label="Cars"
      noun="cars"
      items={CARS}
      idOf={(c) => c.id}
      searchText={(c) => {
        const k = carClass(c.classId);
        return `${c.title} ${c.sub} ${c.badge} ${k.title} ${k.sub}`;
      }}
      searchPlaceholder="Search cars, classes"
      filterGroups={filterGroups}
      sorts={sorts}
      initialSelectedId={carId}
      isFavorite={(c) => favs.includes(c.id)}
      onToggleFavorite={library ? (c) => library.onToggleFavorite("cars", [c.id]) : undefined}
      onClose={onClose}
      toolbar={toolbar}
      renderCard={(c) => {
        const k = carClass(c.classId);
        return (
          <span className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden rounded-[17px]">
            <span className="relative flex h-[58px] items-end border-b border-[#262B3D] bg-[#1B1F2B]/70 px-3 pb-2">
              <span className="absolute top-2.5 left-3">
                <Chip className="h-[22px] px-2 text-[10px]">{k.title}</Chip>
              </span>
              <span className="lc-data ml-auto text-[11px] tracking-[0.12em] text-[#C5CBD8]">{c.badge}</span>
            </span>
            <span className="flex min-w-0 flex-col gap-1 px-3 pt-0.5 pb-3">
              <span className="lc-disp text-[17px] leading-[1.05]">{c.title}</span>
              <span className="line-clamp-2 text-[12px] leading-snug text-[#8E96AA]">{c.sub}</span>
              {c.id === carId ? (
                <span className="mt-0.5">
                  <Chip color="#CCFF00" variant="soft" className="h-[22px] px-2 text-[10px]">
                    Current
                  </Chip>
                </span>
              ) : null}
            </span>
          </span>
        );
      }}
      renderDetail={(c) => {
        const k = carClass(c.classId);
        const own = physicsLabel(c);
        return (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip>{k.title}</Chip>
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
              {own && !carTakesPhysicsSwitch(c.id) ? <Spec k="Physics">{own}</Spec> : null}
            </div>
            {carTakesPhysicsSwitch(c.id) ? <CarPhysicsSwitch color="#CCFF00" /> : null}
            <div className="flex flex-col gap-2">
              <span className="lc-lbl text-[10px]">Livery</span>
              {carTakesLivery(c.id) ? (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Livery">
                  {LIVERIES.map((liv) => {
                    const on = selectedLivery.id === liv.id;
                    return (
                      <button
                        key={liv.id}
                        type="button"
                        aria-pressed={on}
                        aria-label={liv.name}
                        title={`${liv.name} · ${liv.team}`}
                        onClick={() => onChangeLivery(liv)}
                        onPointerEnter={focusOnHover}
                        className={`h-[22px] w-9 cursor-pointer rounded-full transition-[box-shadow] ${
                          on ? "shadow-[0_0_0_2px_#11131A,0_0_0_4px_#CCFF00]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)] hover:shadow-[0_0_0_1px_#8E96AA]"
                        }`}
                        style={{ background: `linear-gradient(90deg, ${liv.primary} 0 50%, ${liv.secondary} 50% 100%)` }}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="m-0 text-[12px] text-[#8E96AA]">{FACTORY_LIVERY_NOTE}</p>
              )}
            </div>
          </>
        );
      }}
      primaryAction={(c) =>
        c.id === carId
          ? { label: "Current car", disabled: true, run: () => {} }
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
