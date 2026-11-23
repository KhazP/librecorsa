"use client";

import React, { useMemo, useRef, useState } from "react";
import { useTranslations } from "use-intl/react";
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
import { SettingRow, Skeleton } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/icons/Icon";
import { cx } from "@/components/ui/styles";
import { StateBadge } from "@/components/ui/badges/StateBadge";
import { useUnits } from "@/lib/settings/ui-prefs";
import { DISTANCE_LABEL, distanceIn } from "@/lib/settings/units";
import type { UnitSettings } from "@/lib/settings/player-settings";
import type { VehicleModelId } from "@/types/f1";
import { bestLapForCircuit, bestLapsByVehicleForCircuit } from "@/lib/sim/ghost-store";
import { useBestLapSummaries } from "@/lib/sim/use-best-laps";
import { formatLapTime } from "@/components/hud/hud-format";
import { formatCount } from "@/lib/net/board-client";
import { popularRank, usePopularRanks } from "@/lib/net/use-popular";
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { TrackOutline, useCircuitOutline, useNearView } from "./circuit-outline";
import { selectDetailPbs, useCircuitBoardRanks, type DetailPbEntry } from "./circuit-board-rank";
import { carBoardTag, TrackQualityBadge } from "./menu-content-ui";
import { LayoutChoice } from "@/components/LayoutChoice";
import { SourceChip } from "@/components/SourceChip";
import { trackModelSource } from "@/lib/model-source";

const lengthOf = (t: TrackInfo, units: UnitSettings) => `${distanceIn(t.lengthM / 1000, units.speed).toFixed(2)} ${DISTANCE_LABEL[units.speed]}`;
/** The registry's direction as a word: anticlockwise, clockwise, or its own text */
const dirKind = (d: string) => (/counter|anti/i.test(d) ? "anticlockwise" : /clock/i.test(d) ? "clockwise" : null);
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
  const tx = useTranslations("menu.circuitBrowser");
  return (
    <span ref={ref} className="absolute inset-0 flex items-center justify-center p-4 pt-9">
      {map ? (
        <TrackOutline map={map} thin className="h-full max-w-full" label={tx("outline", { circuit: track.name })} />
      ) : map === undefined ? (
        <Skeleton className={cx("h-3/5 w-3/5", !near && "[animation:none]")} />
      ) : <Icon name="trackCircuit" size="lg" className="text-lc-slate" />}
    </span>
  );
};

const DetailOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const map = useCircuitOutline(track, true, true);
  const tx = useTranslations("menu.circuitBrowser");
  return (
    <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lc-tile bg-lc-well p-3">
      {map ? (
        <TrackOutline map={map} thin className="h-full w-full" label={`${track.name}, ${track.layout}`} />
      ) : map === null ? (
        <span className="lc-hint">{tx("outlineOffline")}</span>
      ) : (
        <Skeleton className="h-3/5 w-3/5" />
      )}
    </div>
  );
};

const DetailPersonalBests: React.FC<{
  trackId: string;
  entries: readonly DetailPbEntry[];
  vehicleModel?: VehicleModelId;
  driverName?: string;
  boardVersion?: number;
}> = ({ trackId, entries, vehicleModel, driverName, boardVersion }) => {
  const tx = useTranslations("menu.circuitBrowser");
  const ranks = useCircuitBoardRanks(trackId, entries, driverName, boardVersion);
  return (
    <SettingRow label={tx("personalBest")} stacked>
      <div className="flex w-full flex-col gap-1">
        {entries.map((entry) => {
          const isCur = vehicleModel != null && entry.vehicle === vehicleModel;
          const rank = entry.legacyPhysics ? undefined : ranks[entry.vehicle];
          return (
            <div key={entry.vehicle} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[13px]">
              <span className={cx("min-w-0 truncate", isCur ? "font-semibold text-lc-chalk" : "text-lc-fog")}>
                {carBoardTag(entry.vehicle).label}
                {entry.legacyPhysics ? <span className="ms-1.5 text-[11px] font-normal text-lc-slate">{tx("oldPhysicsTag")}</span> : null}
              </span>
              <span className="ms-auto inline-flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5">
                <span
                  className={cx(
                    "lc-mono inline-flex items-center gap-1.5 font-semibold whitespace-nowrap",
                    entry.legacyPhysics ? "text-lc-fog" : isCur ? "text-lc-best" : "text-lc-chalk",
                  )}
                >
                  {isCur && !entry.legacyPhysics ? <Icon name="lapTimes" label={tx("pbIcon")} size="xs" /> : null}
                  {formatLapTime(entry.lapTimeMs)}
                </span>
                {rank ? (
                  <span className="lc-mono whitespace-nowrap text-[12px] text-lc-slate" title={tx("boardRankTitle")}>
                    {tx.rich("boardRank", {
                      pos: formatCount(rank.pos),
                      total: formatCount(rank.total),
                      b: (chunks) => <span className="font-semibold text-lc-fog">{chunks}</span>,
                    })}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </SettingRow>
  );
};

/**
 * The circuit browser of the title menu's Circuit panel: venues by region, type and the player's favourites and
 * recents, with every layout of a venue on one card (a switch in the detail pane picks the layout to load).
 */
export const CircuitBrowser: React.FC<{
  /** The loaded circuit */
  trackId: string;
  /** Currently chosen car physics model (its personal best is preferred on every circuit card) */
  vehicleModel?: VehicleModelId;
  /** The player's driver name, to look up their online board position beside each detail-panel PB */
  driverName?: string;
  /** Bumps when a lap upload or rename settles, so newly posted PBs can refresh their board rank */
  boardVersion?: number;
  /** Switches circuit (reloads the scene); settles when the load fails (on success the menu is replaced) */
  onSelect?: (id: string) => void | Promise<void>;
  library?: LibraryProps;
  /** The venues to list (default every venue in the registry) */
  venues?: readonly CircuitVenue[];
}> = ({ trackId, vehicleModel, driverName, boardVersion, onSelect, library, venues = CIRCUIT_VENUES }) => {
  const units = useUnits();
  const tx = useTranslations("menu.circuitBrowser");
  const bestLaps = useBestLapSummaries();
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
  const popular = usePopularRanks();
  /** A venue stands where its most-driven layout does */
  const popularOf = (v: CircuitVenue) => (popular ? Math.min(...v.layouts.map((l) => popularRank(popular.circuits, l.id))) : Infinity);
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
        id: "show",
        label: tx("show"),
        filters: [
          { id: "all", label: tx("showAll"), test: () => true },
          { id: "fav", label: tx("showFavourites"), test: (v) => v.layouts.some((l) => favs.includes(l.id)) },
          { id: "recent", label: tx("showRecent"), test: (v) => v.layouts.some((l) => recent.includes(l.id)) },
          ...(venues.some(isOriginal) ? [{ id: "original", label: CIRCUIT_QUALITY_META.original.filterLabel, test: isOriginal }] : []),
        ],
      },
    ];
    // A group with one category narrows nothing: it is left out
    if (qualities.length > 1) {
      groups.push({
        id: "quality",
        label: tx("qualityFilter"),
        anyLabel: tx("anyQuality"),
        filters: qualities.map((q) => ({
          id: `quality:${q}`,
          label: CIRCUIT_QUALITY_META[q].filterLabel,
          test: (v: CircuitVenue) => hasQuality(v, q),
        })),
      });
    }
    if (types.length > 1) {
      groups.push({
        id: "type",
        label: tx("typeFilter"),
        anyLabel: tx("anyType"),
        filters: types.map((t) => ({ id: `type:${t}`, label: CIRCUIT_TYPE_LABELS[t], test: (v: CircuitVenue) => typesOf(v).has(t) })),
      });
    }
    if (countries.length > 1) {
      groups.push({
        id: "location",
        label: tx("locationFilter"),
        anyLabel: tx("anyLocation"),
        filters: countries.map((c) => ({ id: `country:${c}`, label: c, test: (v: CircuitVenue) => v.country === c })),
      });
    }
    if (modders.length > 1) {
      groups.push({
        id: "modder",
        label: tx("modderFilter"),
        anyLabel: tx("anyModder"),
        filters: modders.map((m) => ({ id: `modder:${m}`, label: m, test: (v: CircuitVenue) => moddersOf(v).has(m) })),
      });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venues, favs, recent, qualities, tx]);

  const sorts: BrowserSort<CircuitVenue>[] = [
    { id: "region", label: tx("sortRegion"), groupBy: (v) => v.region, groupOrder: CIRCUIT_REGIONS, compare: byName },
    {
      id: "quality",
      label: tx("sortQuality"),
      groupBy: (v) => circuitQualityMeta(shownLayout(v)).filterLabel,
      groupOrder: [
        CIRCUIT_QUALITY_META.sim.filterLabel,
        CIRCUIT_QUALITY_META.original.filterLabel,
        CIRCUIT_QUALITY_META.sketchfab.filterLabel,
      ],
      compare: byName,
    },
    { id: "name", label: tx("sortName"), heading: tx("headingName"), compare: byName },
    {
      id: "length",
      label: tx("sortLength"),
      heading: tx("headingLength"),
      compare: (a, b) => Math.max(...b.layouts.map((l) => l.lengthM)) - Math.max(...a.layouts.map((l) => l.lengthM)),
    },
    // Offered once the ranks are read: with the online side off there is nothing to sort by
    ...(popular
      ? [{ id: "popular", label: tx("sortPopular"), heading: tx("headingPopular", { days: popular.days }), compare: (a: CircuitVenue, b: CircuitVenue) => popularOf(a) - popularOf(b) || byName(a, b) }]
      : []),
    { id: "recent", label: tx("sortRecent"), heading: tx("headingRecent"), compare: (a, b) => recentRank(a) - recentRank(b) || byName(a, b) },
  ];

  const activeVenue = venues.find((v) => v.layouts.some((l) => l.id === trackId));

  return (
    <ContentBrowser<CircuitVenue>
      label={tx("label")}
      kind="venues"
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
      searchPlaceholder={tx("searchPlaceholder")}
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
        const pb = bestLapForCircuit(bestLaps, t.id, vehicleModel);
        return {
          media: <CardOutline track={t} />,
          title: v.name,
          meta: (
            <>
              <span className={pb ? "block truncate" : "block"}>
                {v.country}, {lengthOf(t, units)}
              </span>
              {pb ? (
                <span className="mt-0.5 flex items-center gap-1.5 text-[12px]">
                  <Icon
                    name="lapTimes"
                    label={tx("pbIcon")}
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
                      {pb.forCurrentCar ? tx("oldPhysics") : tx("carOldPhysics", { car: carBoardTag(pb.vehicle).label })}
                    </span>
                  ) : !pb.forCurrentCar ? (
                    <span className="truncate text-[11px] text-lc-slate">{carBoardTag(pb.vehicle).label}</span>
                  ) : null}
                </span>
              ) : null}
            </>
          ),
          badges: (
            <>
              <TrackQualityBadge track={t} size="sm" />
              {circuitType(t) === "hillclimb" ? (
                <Badge size="sm" icon="trackHillClimb">
                  {tx("hillClimb")}
                </Badge>
              ) : null}
              {v.layouts.length > 1 ? <Badge size="sm">{tx("layouts", { count: v.layouts.length })}</Badge> : null}
            </>
          ),
          overlay: v.layouts.some((l) => l.id === trackId) ? <StateBadge state="inUse" size="sm" /> : undefined,
        };
      }}
      renderDetail={(v) => {
        const t = shownLayout(v);
        const active = t.id === trackId;
        const source = trackModelSource(t);
        const hill = circuitType(t) === "hillclimb";
        const layoutOptions = v.layouts.map((l) => ({ id: l.id, label: l.layout }));
        const circuitPbs = selectDetailPbs(bestLapsByVehicleForCircuit(bestLaps, t.id), vehicleModel);
        return (
          <>
            <DetailOutline track={t} />
            <div className="flex flex-col gap-1.5">
              <h3 className="lc-h3 m-0 [overflow-wrap:anywhere]">{v.name}</h3>
              <p className="lc-body m-0">
                {[v.layouts.length > 1 ? null : t.layout, placeOf(v.city, v.country)].filter(Boolean).join(", ")}
              </p>
              <p className="lc-hint m-0">
                {(() => {
                  const kind = dirKind(t.direction);
                  const facts = { length: lengthOf(t, units), turns: t.turns, direction: kind ? tx(kind) : t.direction.toLowerCase() };
                  return active && BASE_ALTITUDE_M > 0
                    ? tx("factsAltitude", { ...facts, altitude: Math.round(BASE_ALTITUDE_M).toLocaleString("en-US") })
                    : tx("facts", facts);
                })()}
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
            {circuitPbs.length > 0 ? (
              <DetailPersonalBests
                trackId={t.id}
                entries={circuitPbs}
                vehicleModel={vehicleModel}
                driverName={driverName}
                boardVersion={boardVersion}
              />
            ) : null}
            {v.layouts.length > 1 ? (
              <SettingRow label={tx("layout")} stacked>
                <LayoutChoice options={layoutOptions} value={t.id} onChange={(id) => setLayoutOf((m) => ({ ...m, [v.id]: id }))} />
              </SettingRow>
            ) : null}
            {hill ? (
              <p className="lc-hint m-0">{tx("pointToPoint")}</p>
            ) : null}
            {/* "Circuit by Alp Yalay [Source]", as the pause menu says it, at the pane's foot against the main action
                when the pane has room */}
            {source ? (
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="lc-hint min-w-0">
                  {tx.rich("circuitBy", { author: source.author, name: (chunks) => <span className="text-lc-fog">{chunks}</span> })}
                </span>
                <SourceChip source={source} />
              </div>
            ) : null}
          </>
        );
      }}
      primaryAction={(v) => {
        const t = shownLayout(v);
        if (t.id === trackId) return { label: tx("active"), disabled: true, current: true, run: () => {} };
        if (loadingId === t.id) return { label: tx("loading", { circuit: v.name }), disabled: true, run: () => {} };
        return { label: tx("load"), disabled: !onSelect || loadingId !== null, run: () => load(t.id) };
      }}
    />
  );
};
