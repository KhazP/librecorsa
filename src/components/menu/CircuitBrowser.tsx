"use client";

import React, { useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { SECTOR_COLORS } from "@/components/hud/styles/hud-style-parts";
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
import { ContentBrowser, type BrowserFilterGroup, type BrowserSort, type LibraryProps } from "./ContentBrowser";
import { TrackOutline, useCircuitOutline, useNearView } from "./circuit-outline";
import { Chip, Segmented, TrackQualityBadge } from "./menu-ui";
import { SourceChip } from "@/components/SourceChip";
import { trackModelSource } from "@/lib/model-source";

const km = (t: TrackInfo) => (t.lengthM / 1000).toFixed(2);
const dirShort = (d: string) => (/counter|anti/i.test(d) ? "CCW" : /clock/i.test(d) ? "CW" : d);
const hasQuality = (v: CircuitVenue, q: CircuitQuality) => v.layouts.some((l) => l.quality === q);
const isOriginal = (v: CircuitVenue) => hasQuality(v, "original");
const placeOf = (city: string, country: string) => (city && city !== country ? `${city}, ${country}` : country);
/** A–Z, with LibreCorsa's own circuits first */
const byModder = (a: string, b: string) => Number(b === LIBRECORSA_MODDER) - Number(a === LIBRECORSA_MODDER) || a.localeCompare(b);

/** Card thumbnail: the layout's real outline once it is loaded (cards load theirs as they scroll near the view) */
const CardOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useNearView(ref);
  const map = useCircuitOutline(track, near);
  return (
    <div ref={ref} className="flex h-[78px] items-center justify-center phone:h-[60px]">
      {map ? (
        <TrackOutline map={map} thin className="h-full max-w-full" />
      ) : (
        <span aria-hidden className={`h-1.5 w-10 rounded-full bg-[#1B1F2B] ${map === undefined ? "animate-pulse" : ""}`} />
      )}
    </div>
  );
};

const DetailOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const map = useCircuitOutline(track, true, true);
  return (
    <div className="relative flex aspect-[16/10] max-h-[168px] items-center justify-center rounded-[12px] bg-[#08090D]/60 p-1 pb-6">
      {map ? (
        <TrackOutline map={map} sectors className="h-full w-full" label={`${track.name} · ${track.layout} by sector`} />
      ) : (
        <span className="text-[12px] text-[#8E96AA]">{map === null ? "Outline unavailable offline" : "Loading outline…"}</span>
      )}
      <span aria-hidden className="absolute right-2.5 bottom-2 flex gap-2.5">
        {SECTOR_COLORS.map((c, i) => (
          <span key={c} className="inline-flex items-center gap-1 font-f1-mono text-[10px] font-extrabold" style={{ color: c }}>
            <span className="h-1 w-2.5 rounded-full" style={{ background: c }} />S{i + 1}
          </span>
        ))}
      </span>
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
}> = ({ trackId, onSelect, library }) => {
  const venues = CIRCUIT_VENUES;
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

  /** The graded kinds this copy lists a circuit of, for the Quality filters and the footnote */
  const qualities = useMemo(() => (["sim", "sketchfab"] as const).filter((q) => venues.some((v) => hasQuality(v, q))), [venues]);

  const filterGroups = useMemo<BrowserFilterGroup<CircuitVenue>[]>(() => {
    const countries = [...new Set(venues.map((v) => v.country))].sort((a, b) => a.localeCompare(b));
    const types = CIRCUIT_TYPES.filter((t) => venues.some((v) => typesOf(v).has(t)));
    const modders = [...new Set(venues.flatMap((v) => [...moddersOf(v)]))].sort(byModder);
    const groups: BrowserFilterGroup<CircuitVenue>[] = [
      {
        label: "Library",
        filters: [
          { id: "all", label: "All circuits", test: () => true },
          { id: "fav", label: "Favourites", test: (v) => v.layouts.some((l) => favs.includes(l.id)) },
          { id: "recent", label: "Recently driven", test: (v) => v.layouts.some((l) => recent.includes(l.id)) },
          ...(venues.some(isOriginal) ? [{ id: "original", label: CIRCUIT_QUALITY_META.original.filterLabel, test: isOriginal }] : []),
        ],
      },
      {
        label: "Quality",
        filters: qualities.map((q) => ({
          id: `quality:${q}`,
          label: CIRCUIT_QUALITY_META[q].filterLabel,
          test: (v: CircuitVenue) => hasQuality(v, q),
        })),
      },
    ];
    // A group with one category narrows nothing: it is left out
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
    { id: "name", label: "A–Z", heading: "A–Z", compare: byName },
    {
      id: "length",
      label: "Length",
      heading: "Longest first",
      compare: (a, b) => Math.max(...b.layouts.map((l) => l.lengthM)) - Math.max(...a.layouts.map((l) => l.lengthM)),
    },
    { id: "recent", label: "Recent", heading: "Recently driven first", compare: (a, b) => recentRank(a) - recentRank(b) || byName(a, b) },
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
      searchPlaceholder="Search circuits, countries, layouts"
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
        const active = v.layouts.some((l) => l.id === trackId);
        return (
          <span className="flex min-w-0 flex-col gap-1.5 px-3.5 pt-3 pb-3.5 phone:flex-row phone:items-center phone:gap-3 phone:px-3 phone:py-2.5">
            <span className="flex min-h-7 flex-wrap items-center gap-1.5 pr-6 phone:hidden">
              <TrackQualityBadge track={t} size="xs" />
            </span>
            <span className="phone:w-[76px] phone:shrink-0">
              <CardOutline track={t} />
            </span>
            <span className="flex min-w-0 flex-col gap-1.5 phone:flex-1 phone:gap-1 phone:pr-7">
            <span className="hidden phone:flex">
              <TrackQualityBadge track={t} size="xs" />
            </span>
            <span className="lc-disp text-[16px] leading-[1.05] [overflow-wrap:anywhere] hyphens-auto">{v.name}</span>
            <span className="truncate text-[12px] text-[#8E96AA]">{placeOf(v.city, v.country)}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="lc-data text-[11px] whitespace-nowrap text-[#C5CBD8]">
                {km(t)} KM · {t.turns} TURNS
              </span>
              <span className="flex-1" />
              {v.layouts.length > 1 ? (
                <Chip color="#00E5FF" variant="soft" size="sm">
                  {v.layouts.length} layouts
                </Chip>
              ) : null}
              {active ? (
                <Chip color="#F5F7FA" size="sm">
                  Active
                </Chip>
              ) : null}
            </span>
            </span>
          </span>
        );
      }}
      renderDetail={(v) => {
        const t = shownLayout(v);
        const active = t.id === trackId;
        const qMeta = circuitQualityMeta(t);
        const source = trackModelSource(t);
        const stats: [string, string][] = [
          ["Km", km(t)],
          ["Turns", String(t.turns)],
          ["Dir", dirShort(t.direction)],
        ];
        return (
          <>
            <div className="flex flex-col gap-2">
              <span className="flex">
                <TrackQualityBadge track={t} />
              </span>
              <span className="lc-disp text-[21px] leading-[1.05] [overflow-wrap:anywhere]">{v.name}</span>
              <span className="text-[13px] leading-snug text-[#C5CBD8]">
                {[v.layouts.length > 1 ? null : t.layout, placeOf(v.city, v.country), ...[...typesOf(v)].map((ty) => CIRCUIT_TYPE_LABELS[ty])]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            {v.layouts.length > 1 ? (
              <Segmented
                label={`${v.name} layout`}
                className="flex-wrap gap-1 rounded-[22px] [&>button]:min-h-[36px] [&>button]:flex-[1_0_auto] [&>button]:px-3 [&>button]:text-[13px]"
                options={v.layouts.map((l) => ({ id: l.id, label: l.layout }))}
                value={t.id}
                onChange={(id) => setLayoutOf((m) => ({ ...m, [v.id]: id }))}
              />
            ) : null}
            <dl className="m-0 grid grid-cols-3 gap-1.5">
              {stats.map(([k, val]) => (
                <div key={k} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-[#08090D]/60 px-2.5 py-2">
                  <dt className="lc-lbl">{k}</dt>
                  <dd className="lc-data m-0 truncate text-[15px] text-[#F5F7FA]">{val}</dd>
                </div>
              ))}
            </dl>
            <DetailOutline track={t} />
            <div className="flex flex-col gap-1 rounded-[10px] border border-[#262B3D] bg-[#08090D]/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-f1-mono text-[11px] font-extrabold tracking-[0.08em] uppercase" style={{ color: qMeta.color }}>
                  {qMeta.badge}
                </span>
                {t.credit?.author ? <span className="text-[11px] font-semibold text-[#C5CBD8]">By {t.credit.author}</span> : null}
                {source ? <SourceChip source={source} /> : null}
              </div>
              <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">{qMeta.description}</p>
            </div>
            {active && BASE_ALTITUDE_M > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <span className="lc-lbl">Altitude</span>
                <span className="lc-data text-[13px]">{Math.round(BASE_ALTITUDE_M).toLocaleString("en-US")} m</span>
              </div>
            ) : null}
            <p className="m-0 flex items-start gap-2 text-[12px] leading-normal text-[#8E96AA]">
              <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#00E5FF]" strokeWidth={2} />
              {circuitType(t) === "hillclimb"
                ? "A hill climb is one timed run from the start line to the finish, one car at a time: no AI or online races. Loading it reloads the scene."
                : "Loading a circuit reloads the scene. Online, everyone in the room picks the same one."}
            </p>
          </>
        );
      }}
      primaryAction={(v) => {
        const t = shownLayout(v);
        if (t.id === trackId) return { label: "Active circuit", disabled: true, current: true, run: () => {} };
        if (loadingId === t.id) return { label: `Loading ${v.name}…`, disabled: true, run: () => {} };
        return { label: "Load circuit", disabled: !onSelect || loadingId !== null, run: () => load(t.id) };
      }}
      footnote={
        <p className="m-0 mx-1 mt-1 text-[12px] leading-relaxed text-[#8E96AA]">
          {qualities.map((q) => (
            <React.Fragment key={q}>
              <strong style={{ color: CIRCUIT_QUALITY_META[q].color }}>{CIRCUIT_QUALITY_META[q].filterLabel}:</strong>{" "}
              {CIRCUIT_QUALITY_META[q].description}{" "}
            </React.Fragment>
          ))}
        </p>
      }
    />
  );
};
