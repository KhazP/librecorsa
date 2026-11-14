"use client";

import React, { useMemo, useRef, useState } from "react";
import { BASE_ALTITUDE_M } from "@/lib/track-data";
import {
  CIRCUIT_QUALITY_META,
  CIRCUIT_REGIONS,
  CIRCUIT_TYPE_LABELS,
  CIRCUIT_TYPES,
  CIRCUIT_VENUES,
  LIBRECORSA_MODDER,
  circuitModder,
  circuitQualityMeta,
  circuitType,
  type CircuitQuality,
  type CircuitType,
  type CircuitVenue,
  type TrackInfo,
} from "@/lib/track-registry";
import { Disclosure, Segmented, Select, SettingRow, Skeleton } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { StateBadge } from "@/components/ui/badges/StateBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import type { UnitSettings } from "@/lib/settings/player-settings";
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { TrackOutline, useCircuitOutline, useNearView } from "./circuit-outline";
import { TrackQualityBadge } from "./menu-content-ui";
import { SourceChip } from "@/components/SourceChip";
import { trackModelSource } from "@/lib/model-source";

const lengthOf = (t: TrackInfo, units: UnitSettings) => `${distanceIn(t.lengthM / 1000, units.speed).toFixed(2)} ${DISTANCE_LABEL[units.speed]}`;
const dirWord = (d: string) => (/counter|anti/i.test(d) ? "anticlockwise" : /clock/i.test(d) ? "clockwise" : d.toLowerCase());
const hasQuality = (v: CircuitVenue, q: CircuitQuality) => v.layouts.some((l) => l.quality === q);
const isOriginal = (v: CircuitVenue) => hasQuality(v, "original");
const placeOf = (city: string, country: string) => (city && city !== country ? `${city}, ${country}` : country);
/** A–Z, with LibreCorsa's own circuits first */
const byModder = (a: string, b: string) => Number(b === LIBRECORSA_MODDER) - Number(a === LIBRECORSA_MODDER) || a.localeCompare(b);

/** Card picture: the layout's real outline once it is loaded (cards load theirs as they scroll near the view) */
const CardOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const ref = useRef<HTMLSpanElement | null>(null);
  const near = useNearView(ref);
  const map = useCircuitOutline(track, near);
  return (
    <span ref={ref} className="absolute inset-0 flex items-center justify-center p-4 pt-9">
      {map ? (
        <TrackOutline map={map} thin className="h-full max-w-full" label={`${track.name} outline`} />
      ) : map === undefined ? (
        <Skeleton className="h-3/5 w-3/5" />
      ) : null}
    </span>
  );
};

const DetailOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const map = useCircuitOutline(track, true, true);
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lc-tile bg-lc-well p-3">
      {map ? (
        <TrackOutline map={map} thin className="h-full w-full" label={`${track.name}, ${track.layout}`} />
      ) : map === null ? (
        <span className="lc-hint">The outline needs a connection</span>
      ) : (
        <Skeleton className="h-3/5 w-3/5" />
      )}
    </div>
  );
};

/**
 * The circuit browser of the title menu's Circuit panel: venues by region, type and the player's favourites and
 * recents, with every layout of a venue on one card (a switch in the detail pane picks the layout to load).
 */
export const CircuitBrowser: React.FC<{
  /** The loaded circuit */
  trackId: string;
  /** Switches circuit (reloads the scene); settles when the load fails (on success the menu is replaced) */
  onSelect?: (id: string) => void | Promise<void>;
  library?: LibraryProps;
  /** The venues to list (default every venue in the registry) */
  venues?: readonly CircuitVenue[];
}> = ({ trackId, onSelect, library, venues = CIRCUIT_VENUES }) => {
  const units = useUnits();
  // The layout being loaded: its button says so until the scene reloads (or the load fails and it is offered again)
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const load = (id: string) => {
    if (!onSelect || loadingId) return;
    setLoadingId(id);
    void Promise.resolve(onSelect(id)).finally(() => setLoadingId(null));
  };
  // The layout each venue shows: the loaded one where it is that venue's, else its first
  const [layoutOf, setLayoutOf] = useState<Record<string, string>>({});
  const shownLayout = (v: CircuitVenue): TrackInfo =>
    v.layouts.find((l) => l.id === layoutOf[v.id]) ?? v.layouts.find((l) => l.id === trackId) ?? v.layouts[0];

  const favs = library?.library.favorites.circuits ?? [];
  const recent = library?.library.recent.circuits ?? [];
  const isFavorite = (v: CircuitVenue) => v.layouts.some((l) => favs.includes(l.id));
  const recentRank = (v: CircuitVenue) => {
    const ranks = v.layouts.map((l) => recent.indexOf(l.id)).filter((i) => i >= 0);
    return ranks.length ? Math.min(...ranks) : Infinity;
  };
  const byName = (a: CircuitVenue, b: CircuitVenue) => a.name.localeCompare(b.name);
  const typesOf = (v: CircuitVenue): Set<CircuitType> => new Set(v.layouts.map(circuitType));
  const moddersOf = (v: CircuitVenue) => new Set(v.layouts.map(circuitModder));

  /** The graded kinds this copy lists a circuit of, for the Quality filter */
  const qualities = useMemo(() => (["sim", "sketchfab"] as const).filter((q) => venues.some((v) => hasQuality(v, q))), [venues]);

  const filterGroups = useMemo<BrowserFilterGroup<CircuitVenue>[]>(() => {
    const countries = [...new Set(venues.map((v) => v.country))].sort((a, b) => a.localeCompare(b));
    const types = CIRCUIT_TYPES.filter((t) => venues.some((v) => typesOf(v).has(t)));
    const modders = [...new Set(venues.flatMap((v) => [...moddersOf(v)]))].sort(byModder);
    const groups: BrowserFilterGroup<CircuitVenue>[] = [
      {
        label: "Show",
        filters: [
          { id: "all", label: "All circuits", test: () => true },
          { id: "fav", label: "Favourites", test: (v) => v.layouts.some((l) => favs.includes(l.id)) },
          { id: "recent", label: "Recently driven", test: (v) => v.layouts.some((l) => recent.includes(l.id)) },
          ...(venues.some(isOriginal) ? [{ id: "original", label: CIRCUIT_QUALITY_META.original.filterLabel, test: isOriginal }] : []),
        ],
      },
    ];
    // A group with one category narrows nothing: it is left out
    if (qualities.length > 1) {
      groups.push({
        label: "Quality",
        filters: qualities.map((q) => ({
          id: `quality:${q}`,
          label: CIRCUIT_QUALITY_META[q].filterLabel,
          test: (v: CircuitVenue) => hasQuality(v, q),
        })),
      });
    }
    if (types.length > 1) {
      groups.push({
        label: "Type",
        filters: types.map((t) => ({ id: `type:${t}`, label: CIRCUIT_TYPE_LABELS[t], test: (v: CircuitVenue) => typesOf(v).has(t) })),
      });
    }
    if (countries.length > 1) {
      groups.push({
        label: "Location",
        filters: countries.map((c) => ({ id: `country:${c}`, label: c, test: (v: CircuitVenue) => v.country === c })),
      });
    }
    if (modders.length > 1) {
      groups.push({
        label: "Modder",
        filters: modders.map((m) => ({ id: `modder:${m}`, label: m, test: (v: CircuitVenue) => moddersOf(v).has(m) })),
      });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venues, favs, recent, qualities]);

  const sorts: BrowserSort<CircuitVenue>[] = [
    { id: "region", label: "Region", groupBy: (v) => v.region, groupOrder: CIRCUIT_REGIONS, compare: byName },
    {
      id: "quality",
      label: "Quality",
      groupBy: (v) => circuitQualityMeta(shownLayout(v)).filterLabel,
      groupOrder: [
        CIRCUIT_QUALITY_META.sim.filterLabel,
        CIRCUIT_QUALITY_META.original.filterLabel,
        CIRCUIT_QUALITY_META.sketchfab.filterLabel,
      ],
      compare: byName,
    },
    { id: "name", label: "A to Z", heading: "A to Z", compare: byName },
    {
      id: "length",
      label: "Length",
      heading: "Longest first",
      compare: (a, b) => Math.max(...b.layouts.map((l) => l.lengthM)) - Math.max(...a.layouts.map((l) => l.lengthM)),
    },
    { id: "recent", label: "Recently driven", heading: "Recently driven first", compare: (a, b) => recentRank(a) - recentRank(b) || byName(a, b) },
  ];

  const activeVenue = venues.find((v) => v.layouts.some((l) => l.id === trackId));

  return (
    <ContentBrowser<CircuitVenue>
      label="Circuits"
      noun="venues"
      items={venues}
      idOf={(v) => v.id}
      searchText={(v) =>
        [
          v.name,
          v.city,
          v.country,
          v.region,
          ...v.layouts.flatMap((l) => {
            const q = circuitQualityMeta(l);
            return [l.layout, CIRCUIT_TYPE_LABELS[circuitType(l)], circuitModder(l), q.badge, q.filterLabel];
          }),
        ].join(" ")
      }
      searchPlaceholder="Circuits, countries, layouts"
      filterGroups={filterGroups}
      sorts={sorts}
      initialSelectedId={activeVenue?.id}
      isFavorite={isFavorite}
      onToggleFavorite={
        library
          ? (v) => {
              const first = shownLayout(v).id;
              library.onToggleFavorite("circuits", [first, ...v.layouts.map((l) => l.id).filter((id) => id !== first)]);
            }
          : undefined
      }
      renderCard={(v) => {
        const t = shownLayout(v);
        return {
          media: <CardOutline track={t} />,
          title: v.name,
          meta: (
            <>
              {v.country}, {lengthOf(t, units)}
            </>
          ),
          badges: (
            <>
              <TrackQualityBadge track={t} size="sm" />
              {circuitType(t) === "hillclimb" ? (
                <Badge size="sm" icon="trackHillClimb">
                  Hill climb
                </Badge>
              ) : null}
              {v.layouts.length > 1 ? <Badge size="sm">{v.layouts.length} layouts</Badge> : null}
            </>
          ),
          overlay: v.layouts.some((l) => l.id === trackId) ? <StateBadge state="inUse" size="sm" /> : undefined,
        };
      }}
      renderDetail={(v) => {
        const t = shownLayout(v);
        const active = t.id === trackId;
        const qMeta = circuitQualityMeta(t);
        const source = trackModelSource(t);
        const hill = circuitType(t) === "hillclimb";
        const layoutOptions = v.layouts.map((l) => ({ id: l.id, label: l.layout }));
        return (
          <>
            <DetailOutline track={t} />
            <div className="flex flex-col gap-1.5">
              <h3 className="lc-h3 m-0 [overflow-wrap:anywhere]">{v.name}</h3>
              <p className="lc-body m-0">
                {[v.layouts.length > 1 ? null : t.layout, placeOf(v.city, v.country)].filter(Boolean).join(", ")}
              </p>
              <p className="lc-hint m-0">
                {lengthOf(t, units)}, {t.turns} turns, {dirWord(t.direction)}
                {active && BASE_ALTITUDE_M > 0 ? (
                  <>
                    , {Math.round(BASE_ALTITUDE_M).toLocaleString("en-US")} m above sea level
                  </>
                ) : null}
              </p>
              <span className="mt-1 flex flex-wrap gap-1.5">
                <TrackQualityBadge track={t} size="sm" />
                {[...typesOf(v)].map((ty) => (
                  <Badge key={ty} size="sm" icon={ty === "hillclimb" ? "trackHillClimb" : "trackCircuit"}>
                    {CIRCUIT_TYPE_LABELS[ty]}
                  </Badge>
                ))}
              </span>
            </div>
            {v.layouts.length > 1 ? (
              <SettingRow label="Layout" stacked>
                {layoutOptions.length <= 3 ? (
                  <Segmented fill size="sm" options={layoutOptions} value={t.id} onChange={(id) => setLayoutOf((m) => ({ ...m, [v.id]: id }))} />
                ) : (
                  <Select options={layoutOptions} value={t.id} onChange={(id) => setLayoutOf((m) => ({ ...m, [v.id]: id }))} />
                )}
              </SettingRow>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {t.credit?.author ? <span className="lc-hint">By {t.credit.author}</span> : <span />}
              {source ? <SourceChip source={source} /> : null}
            </div>
            <p className="lc-hint m-0">
              {hill
                ? "A hill climb is one timed run from the start line to the finish, one car at a time: no AI or online races. Loading it reloads the scene."
                : "Loading a circuit reloads the scene. Online, everyone in the room picks the same one."}
            </p>
            <Disclosure moreLabel="What the grade means" lessLabel="Less">
              <p className="lc-hint m-0 pb-1">{qMeta.description}</p>
            </Disclosure>
          </>
        );
      }}
      primaryAction={(v) => {
        const t = shownLayout(v);
        if (t.id === trackId) return { label: "Active circuit", disabled: true, current: true, run: () => {} };
        if (loadingId === t.id) return { label: `Loading ${v.name}`, disabled: true, run: () => {} };
        return { label: "Load circuit", disabled: !onSelect || loadingId !== null, run: () => load(t.id) };
      }}
    />
  );
};
