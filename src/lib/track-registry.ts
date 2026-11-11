/**
 * Circuits the simulator offers, as listed in public/tracks/index.json: RISE Motordrome (built for LibreCorsa,
 * scripts/rwanda-official), hand-built sim circuits (scripts/tracks/port_ac_track.py) and community scans
 * (scripts/tracks/build_track.py), each written to public/tracks/<id>/. The default circuit ships inside the bundle
 * (track-data.ts imports its JSON); the others' track data is fetched when the player picks one.
 */
import trackIndex from "../../public/tracks/index.json";
import { withBasePath } from "@/lib/base-path";
import { trackListed } from "@/lib/hosted-content";
import { DEFAULT_TRACK_ID, setActiveTrack, type RawTrackJson } from "@/lib/track-data";

export { DEFAULT_TRACK_ID };

export interface TrackCredit {
  title: string;
  author: string;
  /** The author's own site, linked from their name in the credits */
  authorUrl?: string;
  url: string;
  short?: string;
  license: string;
  licenseUrl: string;
}

/**
 * Where a circuit's model comes from, which sets how far its surfaces can be trusted:
 * - "original": built for LibreCorsa (RISE Motordrome)
 * - "sim": a hand-built sim circuit (an Assetto Corsa track) with its own road, kerb and barrier meshes
 * - "sketchfab": a community 3D model converted automatically, its road, kerbs and barriers traced from the mesh
 */
export type CircuitQuality = "original" | "sim" | "sketchfab";

export interface CircuitQualityMeta {
  /** Badge on cards and next to track names */
  badge: string;
  /** Filter and group label in the circuit browser */
  filterLabel: string;
  color: string;
  variant: "solid" | "soft" | "outline";
  /** Shown in the circuit detail pane and the browser's footnote */
  description: string;
}

export const CIRCUIT_QUALITY_META: Record<CircuitQuality, CircuitQualityMeta> = {
  original: {
    badge: "ORIGINAL",
    filterLabel: "LibreCorsa originals",
    color: "#CCFF00",
    variant: "solid",
    description: "Built for LibreCorsa with its own surfaces, kerbs, elevation and trackside scenery.",
  },
  sim: {
    badge: "SIM GRADE",
    filterLabel: "Sim-grade circuits",
    color: "#00E676",
    variant: "soft",
    description: "A hand-built sim circuit, with its own road, kerb and barrier meshes and surface physics.",
  },
  sketchfab: {
    badge: "SCAN",
    filterLabel: "Converted scans",
    color: "#FFB300",
    variant: "soft",
    description:
      "Converted automatically from a community 3D model: the road, kerbs, run-off and barriers are traced from the mesh, so details can differ from the real venue.",
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
  /** Track data JSON (relative to the base path); the default circuit's is also in the bundle */
  dataUrl?: string;
  /** Model attribution (CC BY 4.0 scans or AC track mods) */
  credit?: TrackCredit;
  /** Kind of venue, when the index states it; otherwise `circuitType` reads it from the name and layout */
  type?: CircuitType;
  /** Where its model comes from (index.json) */
  quality: CircuitQuality;
}

export type CircuitType = "permanent" | "street" | "oval";
export const CIRCUIT_TYPE_LABELS: Record<CircuitType, string> = { permanent: "Permanent", street: "Street", oval: "Oval" };

export const circuitQualityMeta = (t: Pick<TrackInfo, "quality">): CircuitQualityMeta => CIRCUIT_QUALITY_META[t.quality];

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

/** On librecorsa.org every circuit; in a clone of the repository only the ones it carries (`hosted-content.ts`) */
export const TRACKS: TrackInfo[] = (trackIndex as TrackInfo[]).filter((t) => trackListed(t.id));

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

/** The circuit picked last time (or the default) */
export function loadStoredTrackId(): string {
  try {
    const id = localStorage.getItem(TRACK_STORAGE_KEY);
    if (id && TRACKS.some((t) => t.id === id)) return id;
  } catch {
    // Storage unavailable
  }
  return DEFAULT_TRACK_ID;
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
 * That holds even when the later call fails: TrackGate keeps only its latest pick's result too, so an older pick
 * landing afterwards would leave the global out of step with the circuit on screen. A failed call never changes the
 * active track (`setActiveTrack` reads all of the data before it switches anything), so after one, the active track
 * is still the last one activated (`ACTIVE_TRACK_ID`): the circuit to fall back to.
 */
export async function activateTrack(id: string): Promise<TrackInfo> {
  if (!TRACKS.some((t) => t.id === id)) throw new Error(`Unknown circuit "${id}"`);
  const gen = ++activateGen;
  const info = getTrackInfo(id);
  if (info.id === DEFAULT_TRACK_ID || !info.dataUrl) {
    // In the bundle already
    setActiveTrack(DEFAULT_TRACK_ID);
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
