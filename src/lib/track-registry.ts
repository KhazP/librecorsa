/**
 * Circuits the simulator offers. Rwanda ships inside the bundle (track-data.ts imports its JSON); the others are
 * hand-crafted sim circuits or converted from Sketchfab scans into public/tracks/<id>/ and listed in
 * public/tracks/index.json. Their track data is fetched when the player picks one.
 */
import trackIndex from "../../public/tracks/index.json";
import { withBasePath } from "@/lib/base-path";
import { RWANDA_TARGET_LENGTH_M, RWANDA_TURN_METADATA, setActiveTrack, type RawTrackJson } from "@/lib/track-data";

export interface TrackCredit {
  title: string;
  author: string;
  url: string;
  short?: string;
  license: string;
  licenseUrl: string;
}

/**
 * Quality / provenance tier of a circuit:
 * - "original": built specifically for LibreCorsa (Rwanda)
 * - "sim": hand-crafted sim-grade circuit (dedicated physical road/kerb/barrier meshes, surface physics, grooves, trees)
 * - "sketchfab": auto-converted from a Sketchfab 3D model (auto-traced road/kerbs/walls; mediocre/rough fidelity)
 */
export type CircuitQuality = "original" | "sim" | "sketchfab";

export interface CircuitQualityMeta {
  id: CircuitQuality;
  /** Compact badge text on cards and next to track names */
  badge: string;
  /** Short pill label in headers / inline tags */
  shortBadge: string;
  /** Filter / category label in the browser */
  filterLabel: string;
  /** Accent colour */
  color: string;
  /** Chip variant */
  variant: "solid" | "soft" | "outline";
  /** Explanation shown in the circuit detail pane */
  description: string;
}

export const CIRCUIT_QUALITY_META: Record<CircuitQuality, CircuitQualityMeta> = {
  original: {
    id: "original",
    badge: "ORIGINAL · SIM",
    shortBadge: "ORIGINAL",
    filterLabel: "LibreCorsa originals",
    color: "#CCFF00",
    variant: "solid",
    description: "Built for LibreCorsa with custom physics surfaces, kerbs, elevation and trackside scenery.",
  },
  sim: {
    id: "sim",
    badge: "SIM GRADE",
    shortBadge: "SIM GRADE",
    filterLabel: "Sim-grade (High quality)",
    color: "#00E676",
    variant: "soft",
    description:
      "Hand-crafted sim circuit with dedicated physical road, kerb and barrier meshes, surface physics, 3D trees and dynamic tyre grooves.",
  },
  sketchfab: {
    id: "sketchfab",
    badge: "SKETCHFAB · MEDIOCRE",
    shortBadge: "SKETCHFAB · LOW",
    filterLabel: "Sketchfab (Mediocre)",
    color: "#FFB300",
    variant: "soft",
    description:
      "Auto-converted from a Sketchfab 3D model. Road, kerbs, run-off and barriers are detected automatically from the mesh — mediocre surface & visual quality.",
  },
};

export interface TrackInfo {
  id: string;
  name: string;
  layout: string;
  country: string;
  city: string;
  lengthM: number;
  turns: number;
  direction: string;
  /** Track data JSON (relative to the base path); none for the bundled Rwanda layout */
  dataUrl?: string;
  /** Model attribution (CC BY 4.0 scans or AC track mods) */
  credit?: TrackCredit;
  /** Kind of venue, when the index states it; otherwise `circuitType` reads it from the name and layout */
  type?: CircuitType;
  /** Quality / provenance tier; inferred from id/credit when omitted */
  quality?: CircuitQuality;
}

export type CircuitType = "permanent" | "street" | "oval";
export const CIRCUIT_TYPE_LABELS: Record<CircuitType, string> = { permanent: "Permanent", street: "Street", oval: "Oval" };

/** Quality tier of a track: explicit field, bundled Rwanda original, Sketchfab scan URL, or hand-crafted sim circuit */
export const circuitQuality = (t: Pick<TrackInfo, "id" | "quality" | "credit">): CircuitQuality => {
  if (t.quality) return t.quality;
  if (t.id === RWANDA_TRACK_ID) return "original";
  const url = `${t.credit?.url ?? ""} ${t.credit?.short ?? ""}`.toLowerCase();
  if (url.includes("sketchfab.com") || url.includes("skfb.ly")) return "sketchfab";
  return "sim";
};

export const circuitQualityMeta = (t: Pick<TrackInfo, "id" | "quality" | "credit">): CircuitQualityMeta =>
  CIRCUIT_QUALITY_META[circuitQuality(t)];

/** Where a circuit is, for the circuit browser's region filter (from its country) */
export type CircuitRegion = "Africa" | "Americas" | "Asia" | "Europe" | "Middle East" | "Oceania" | "Other";
export const CIRCUIT_REGIONS: readonly CircuitRegion[] = ["Africa", "Americas", "Asia", "Europe", "Middle East", "Oceania", "Other"];

const COUNTRY_REGION: Record<string, CircuitRegion> = {
  Rwanda: "Africa",
  "South Africa": "Africa",
  Morocco: "Africa",
  Kenya: "Africa",
  "United States": "Americas",
  Canada: "Americas",
  Mexico: "Americas",
  Brazil: "Americas",
  Argentina: "Americas",
  Japan: "Asia",
  China: "Asia",
  Malaysia: "Asia",
  Singapore: "Asia",
  "South Korea": "Asia",
  India: "Asia",
  Indonesia: "Asia",
  Thailand: "Asia",
  Vietnam: "Asia",
  Azerbaijan: "Asia",
  "United Arab Emirates": "Middle East",
  Bahrain: "Middle East",
  "Saudi Arabia": "Middle East",
  Qatar: "Middle East",
  Turkey: "Europe",
  "United Kingdom": "Europe",
  Italy: "Europe",
  Belgium: "Europe",
  Germany: "Europe",
  France: "Europe",
  Spain: "Europe",
  Portugal: "Europe",
  Monaco: "Europe",
  Austria: "Europe",
  Hungary: "Europe",
  Netherlands: "Europe",
  Russia: "Europe",
  Australia: "Oceania",
  "New Zealand": "Oceania",
};

/** A circuit's region; a country missing from the map lands in "Other" until it is added */
export const circuitRegion = (t: Pick<TrackInfo, "country">): CircuitRegion => COUNTRY_REGION[t.country] ?? "Other";

/** Permanent, street or oval: the index's own field, else an oval or street layout named as such */
export const circuitType = (t: TrackInfo): CircuitType =>
  t.type ?? (/\boval\b/i.test(t.layout) ? "oval" : /\bstreet\b/i.test(`${t.name} ${t.layout}`) ? "street" : "permanent");

/** One venue in the circuit browser: its layouts (Daytona's oval and road course) share a card */
export interface CircuitVenue {
  /** The first layout's id */
  id: string;
  name: string;
  country: string;
  city: string;
  region: CircuitRegion;
  layouts: TrackInfo[];
}

export const RWANDA_TRACK_ID = "rwanda";

export const TRACKS: TrackInfo[] = [
  {
    id: RWANDA_TRACK_ID,
    name: "Rwanda International Circuit",
    layout: "2026 concept layout",
    country: "Rwanda",
    city: "Bugesera",
    lengthM: RWANDA_TARGET_LENGTH_M,
    turns: RWANDA_TURN_METADATA.length,
    direction: "clockwise",
  },
  ...(trackIndex as TrackInfo[]),
];

/** The circuits grouped by venue (same name and country), in index order */
export const CIRCUIT_VENUES: readonly CircuitVenue[] = TRACKS.reduce<CircuitVenue[]>((venues, t) => {
  const venue = venues.find((v) => v.name === t.name && v.country === t.country);
  if (venue) venue.layouts.push(t);
  else venues.push({ id: t.id, name: t.name, country: t.country, city: t.city, region: circuitRegion(t), layouts: [t] });
  return venues;
}, []);

export const venueOf = (trackId: string): CircuitVenue | undefined => CIRCUIT_VENUES.find((v) => v.layouts.some((l) => l.id === trackId));

const TRACK_STORAGE_KEY = "bugesera.track";

export function getTrackInfo(id: string): TrackInfo {
  const info = TRACKS.find((t) => t.id === id);
  if (info) return info;
  console.warn(`Unknown circuit "${id}", using ${TRACKS[0].id}`);
  return TRACKS[0];
}

/** The circuit picked last time (or Rwanda) */
export function loadStoredTrackId(): string {
  try {
    const id = localStorage.getItem(TRACK_STORAGE_KEY);
    if (id && TRACKS.some((t) => t.id === id)) return id;
  } catch {
    // Storage unavailable
  }
  return RWANDA_TRACK_ID;
}

function storeTrackId(id: string): void {
  try {
    localStorage.setItem(TRACK_STORAGE_KEY, id);
  } catch {
    // Storage unavailable: the choice lasts for this session only
  }
}

let activateGen = 0;

/**
 * Fetches (when needed) and activates a circuit; resolves once `setActiveTrack` has run. A call overtaken by a later
 * one rejects instead of activating: the active track is global, and a slow fetch must not replace a newer choice.
 */
export async function activateTrack(id: string): Promise<TrackInfo> {
  if (!TRACKS.some((t) => t.id === id)) throw new Error(`Unknown circuit "${id}"`);
  const gen = ++activateGen;
  const info = getTrackInfo(id);
  if (!info.dataUrl) {
    setActiveTrack(RWANDA_TRACK_ID);
  } else {
    const res = await fetch(withBasePath(info.dataUrl));
    if (!res.ok) throw new Error(`Track data ${info.dataUrl}: HTTP ${res.status}`);
    const raw = (await res.json()) as RawTrackJson;
    if (gen !== activateGen) throw new Error(`Circuit "${id}" was superseded by a later choice`);
    setActiveTrack(info.id, raw);
  }
  storeTrackId(info.id);
  return info;
}
