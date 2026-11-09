"use client";

import React, { useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { SECTOR_COLORS } from "@/components/hud/styles/hud-style-parts";
import { BASE_ALTITUDE_M } from "@/lib/track-data";
import {
  CIRCUIT_QUALITY_META,
  CIRCUIT_REGIONS,
  CIRCUIT_TYPE_LABELS,
  CIRCUIT_VENUES,
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

const km = (t: TrackInfo) => (t.lengthM / 1000).toFixed(2);
const dirShort = (d: string) => (/counter|anti/i.test(d) ? "CCW" : /clock/i.test(d) ? "CW" : d);
const hasQuality = (v: CircuitVenue, q: CircuitQuality) => v.layouts.some((l) => l.quality === q);
const isOriginal = (v: CircuitVenue) => hasQuality(v, "original");
const placeOf = (city: string, country: string) => (city && city !== country ? `${city}, ${country}` : country);
const TYPES: readonly CircuitType[] = ["permanent", "street", "oval"];

/** Card thumbnail: the layout's real outline once it is loaded (cards load theirs as they scroll near the view) */
const CardOutline: React.FC<{ track: TrackInfo }> = ({ track }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useNearView(ref);
  const map = useCircuitOutline(track, near);
  return (
    <div ref={ref} className="flex h-[78px] items-center justify-center">
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="lc-lbl text-[10px]">Layout</span>
        <span className="flex gap-2.5">
          {SECTOR_COLORS.map((c, i) => (
            <span key={c} className="inline-flex items-center gap-1 font-f1-mono text-[10px] font-extrabold" style={{ color: c }}>
              <span className="h-1 w-2.5 rounded-full" style={{ background: c }} />S{i + 1}
            </span>
          ))}
        </span>
      </div>
      <div className="flex aspect-[16/10] max-h-[130px] items-center justify-center rounded-[12px] bg-[#08090D]/60 p-1">
        {map ? (
          <TrackOutline map={map} sectors className="h-full w-full" label={`${track.name} · ${track.layout} by sector`} />
        ) : (
          <span className="text-[12px] text-[#8E96AA]">{map === null ? "Outline unavailable offline" : "Loading outline…"}</span>
        )}
      </div>
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
  const typesOf = (v: CircuitVenue) => new Set(v.layouts.map(circuitType));

  const filterGroups = useMemo<BrowserFilterGroup<CircuitVenue>[]>(() => {
    const regions = CIRCUIT_REGIONS.filter((r) => venues.some((v) => v.region === r));
    const types = TYPES.filter((t) => venues.some((v) => typesOf(v).has(t)));
    const groups: BrowserFilterGroup<CircuitVenue>[] = [
      {
        label: "Library",
        filters: [
          { id: "all", label: "All circuits", test: () => true },
          { id: "fav", label: "Favourites", test: (v) => v.layouts.some((l) => favs.includes(l.id)) },
          { id: "recent", label: "Recently raced", test: (v) => v.layouts.some((l) => recent.includes(l.id)) },
          ...(venues.some(isOriginal) ? [{ id: "original", label: CIRCUIT_QUALITY_META.original.filterLabel, test: isOriginal }] : []),
        ],
      },
      {
        label: "Quality",
        filters: (["sim", "sketchfab"] as const).map((q) => ({
          id: `quality:${q}`,
          label: CIRCUIT_QUALITY_META[q].filterLabel,
          test: (v: CircuitVenue) => hasQuality(v, q),
        })),
      },
      { label: "Region", filters: regions.map((r) => ({ id: `region:${r}`, label: r, test: (v: CircuitVenue) => v.region === r })) },
    ];
    if (types.length > 1) {
      groups.push({
        label: "Type",
        filters: types.map((t) => ({ id: `type:${t}`, label: CIRCUIT_TYPE_LABELS[t], test: (v: CircuitVenue) => typesOf(v).has(t) })),
      });
    }
    return groups;
  }, [venues, favs, recent]);

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
    { id: "recent", label: "Recent", heading: "Recently raced first", compare: (a, b) => recentRank(a) - recentRank(b) || byName(a, b) },
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
            return [l.layout, CIRCUIT_TYPE_LABELS[circuitType(l)], l.credit?.author ?? "", q.badge, q.filterLabel];
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
          <span className="flex min-w-0 flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
            <span className="flex min-h-7 flex-wrap items-center gap-1.5 pr-6">
              <TrackQualityBadge track={t} size="xs" />
            </span>
            <CardOutline track={t} />
            <span className="lc-disp text-[16px] leading-[1.05]">{v.name}</span>
            <span className="truncate text-[12px] text-[#8E96AA]">{placeOf(v.city, v.country)}</span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <span className="lc-data text-[11px] whitespace-nowrap text-[#C5CBD8]">
                {km(t)} KM · {t.turns} T
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
        );
      }}
      renderDetail={(v) => {
        const t = shownLayout(v);
        const active = t.id === trackId;
        const qMeta = circuitQualityMeta(t);
        const stats: [string, string][] = [
          ["Km", km(t)],
          ["Turns", String(t.turns)],
          ["Dir", dirShort(t.direction)],
        ];
        return (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              <TrackQualityBadge track={t} />
              <Chip>{v.region}</Chip>
              {[...typesOf(v)].map((ty) => (
                <Chip key={ty}>{CIRCUIT_TYPE_LABELS[ty]}</Chip>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="lc-disp text-[24px]">{v.name}</span>
              <span className="text-[13px] text-[#C5CBD8]">
                {t.layout} · {placeOf(v.city, v.country)}
              </span>
            </div>
            {v.layouts.length > 1 ? (
              <div className="flex flex-col gap-2">
                <span className="lc-lbl text-[10px]">{v.layouts.length} layouts</span>
                <Segmented
                  label={`${v.name} layout`}
                  className="[&>button]:min-h-[36px] [&>button]:px-2 [&>button]:text-[13px]"
                  options={v.layouts.map((l) => ({ id: l.id, label: l.layout }))}
                  value={t.id}
                  onChange={(id) => setLayoutOf((m) => ({ ...m, [v.id]: id }))}
                />
              </div>
            ) : null}
            <dl className="m-0 grid grid-cols-3 gap-1.5">
              {stats.map(([k, val]) => (
                <div key={k} className="flex min-w-0 flex-col gap-0.5 rounded-[10px] bg-[#08090D]/60 px-2.5 py-2">
                  <dt className="lc-lbl text-[9px]">{k}</dt>
                  <dd className="lc-data m-0 truncate text-[15px] text-[#F5F7FA]">{val}</dd>
                </div>
              ))}
            </dl>
            <p className="m-0 flex items-start gap-2 text-[12px] leading-normal text-[#C5CBD8]">
              <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-[#00E5FF]" strokeWidth={2} />
              Loading a circuit reloads the scene. Online, everyone in the room picks the same one.
            </p>
            <DetailOutline track={t} />
            <div className="flex flex-col gap-1 rounded-[10px] border border-[#262B3D] bg-[#08090D]/60 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-f1-mono text-[10px] font-extrabold tracking-[0.08em] uppercase" style={{ color: qMeta.color }}>
                  {qMeta.filterLabel}
                </span>
                {t.credit?.author ? <span className="text-[11px] font-semibold text-[#C5CBD8]">By {t.credit.author}</span> : null}
              </div>
              <p className="m-0 text-[12px] leading-snug text-[#8E96AA]">{qMeta.description}</p>
            </div>
            {active && BASE_ALTITUDE_M > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <span className="lc-lbl text-[10px]">Altitude</span>
                <span className="lc-data text-[13px]">{Math.round(BASE_ALTITUDE_M).toLocaleString("en-US")} m</span>
              </div>
            ) : null}
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
          {(["sim", "sketchfab"] as const).map((q) => (
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
