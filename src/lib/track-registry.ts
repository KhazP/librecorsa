/**
 * Circuits the simulator offers, as listed in public/tracks/index.json: RISE Motordrome (built for LibreCorsa,
 * scripts/rwanda-official), hand-built sim circuits (scripts/tracks/port_ac_track.py) and community scans
 * (scripts/tracks/build_track.py), each written to public/tracks/<id>/. The default circuit ships inside the bundle
 * (track-data.ts imports its JSON); the others' track data is fetched when the player picks one.
 */
import trackIndex from "../../public/tracks/index.json";
import { text as tx } from "@/lib/text";
import { withBasePath } from "@/lib/base-path";
import { trackListed } from "@/lib/hosted-content";
import { DEFAULT_TRACK_ID, setActiveTrack, type RawTrackJson } from "@/lib/track-data";
import { TIME_OF_DAY_PRESETS, type TimeOfDayId } from "@/lib/sim/weather";

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
  /** More on where the model comes from, shown with its source */
  note?: string;
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
    get badge() { return tx("game.circuitQuality.originalBadge"); },
    get filterLabel() { return tx("game.circuitQuality.original"); },
    color: "#CCFF00",
    variant: "solid",
    get description() { return tx("game.circuitQuality.originalDetail"); },
  },
  sim: {
    get badge() { return tx("game.circuitQuality.simBadge"); },
    get filterLabel() { return tx("game.circuitQuality.sim"); },
    color: "#00E676",
    variant: "soft",
    get description() { return tx("game.circuitQuality.simDetail"); },
  },
  sketchfab: {
    get badge() { return tx("game.circuitQuality.scanBadge"); },
    get filterLabel() { return tx("game.circuitQuality.scan"); },
    color: "#FFB300",
    variant: "soft",
    get description() { return tx("game.circuitQuality.scanDetail"); },
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
  /**
   * The time of day a session starts at here until the player picks one: "night" for a circuit raced under lights.
   * Read through `trackDefaultTimeOfDay`, which checks it.
   */
  defaultTimeOfDay?: TimeOfDayId;
  /**
   * Left out of every list (circuit browser, home page, lap board picker, credits) unless the page's link names it
   * (`?track=<id>`), e.g. a new circuit its modder tries on the live site before it is listed. It still loads by id
   * everywhere: a stored choice, a room's circuit, a board.
   */
  unlisted?: boolean;
}

/** "hillclimb": a road from a start line to a finish line somewhere else, driven as one timed run */
export type CircuitType = "permanent" | "street" | "oval" | "hillclimb";
export const CIRCUIT_TYPES: readonly CircuitType[] = ["permanent", "street", "oval", "hillclimb"];
export const CIRCUIT_TYPE_LABELS: Record<CircuitType, string> = {
  get permanent() { return tx("game.circuitType.permanent"); },
  get street() { return tx("game.circuitType.street"); },
  get oval() { return tx("game.circuitType.oval"); },
  get hillclimb() { return tx("game.circuitType.hillclimb"); },
};

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
  Croatia: "Europe",
  Australia: "Oceania",
  "New Zealand": "Oceania",
};

/** A circuit's region; a country missing from the map lands in "Other" until it is added */
export const circuitRegion = (t: Pick<TrackInfo, "country">): CircuitRegion => COUNTRY_REGION[t.country] ?? "Other";

/** Permanent, street, oval or hill climb: the index's own field, else an oval or street layout named as such */
export const circuitType = (t: TrackInfo): CircuitType =>
  t.type ?? (/\boval\b/i.test(t.layout) ? "oval" : /\bstreet\b/i.test(`${t.name} ${t.layout}`) ? "street" : "permanent");

/** Who made a circuit's model, for the circuit browser's Modder filter: its credited author, else LibreCorsa itself */
export const LIBRECORSA_MODDER = "LibreCorsa";
export const circuitModder = (t: Pick<TrackInfo, "credit">): string => t.credit?.author ?? LIBRECORSA_MODDER;

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

/**
 * On librecorsa.org every circuit; in a clone of the repository only the ones it carries (`hosted-content.ts`).
 * Unlisted ones included: an id resolves wherever it comes from, and only the lists leave them out (`LISTED_TRACKS`).
 */
export const TRACKS: TrackInfo[] = (trackIndex as TrackInfo[]).filter((t) => trackListed(t.id));

/** `?track=<id>`: the circuit a link opens. Read in the browser only, so the static pages (home) list without it */
export const LINKED_TRACK_ID: string | null = (() => {
  try {
    return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("track");
  } catch {
    return null;
  }
})();

/** The circuits a list offers: every one but the unlisted, except an unlisted one this page's link names */
export const listedTracks = (tracks: readonly TrackInfo[], linkedId: string | null): TrackInfo[] =>
  tracks.filter((t) => !t.unlisted || t.id === linkedId);

/** What the circuit browser, the home page, the lap board picker and the credits show */
export const LISTED_TRACKS: readonly TrackInfo[] = listedTracks(TRACKS, LINKED_TRACK_ID);

/** The listed circuits grouped by venue (same name and country), in index order */
export const CIRCUIT_VENUES: readonly CircuitVenue[] = LISTED_TRACKS.reduce<CircuitVenue[]>((venues, t) => {
  const venue = venues.find((v) => v.name === t.name && v.country === t.country);
  if (venue) venue.layouts.push(t);
  else venues.push({ id: t.id, name: t.name, country: t.country, city: t.city, region: circuitRegion(t), layouts: [t] });
  return venues;
}, []);

export const venueOf = (trackId: string): CircuitVenue | undefined => CIRCUIT_VENUES.find((v) => v.layouts.some((l) => l.id === trackId));

/** Responsive widths written by `npm run venue-heroes` beside each venue's primary track folder */
export const VENUE_HERO_WIDTHS = [960, 1600] as const;
export type VenueHeroWidth = (typeof VENUE_HERO_WIDTHS)[number];

/** Pre-rendered scenic hero still for a venue's home Drive tile (`/tracks/<venueId>/hero-<width>.webp`) */
export const venueHeroUrl = (venueId: string, width: VenueHeroWidth = 1600): string => `/tracks/${venueId}/hero-${width}.webp`;

const TRACK_STORAGE_KEY = "bugesera.track";

export function getTrackInfo(id: string): TrackInfo {
  const info = TRACKS.find((t) => t.id === id);
  if (info) return info;
  console.warn(`Unknown circuit "${id}", using ${TRACKS[0].id}`);
  return TRACKS[0];
}

/** A circuit's own starting time of day (index.json `defaultTimeOfDay`); undefined for most, and for an unknown value */
export function trackDefaultTimeOfDay(id: string): TimeOfDayId | undefined {
  const value = TRACKS.find((t) => t.id === id)?.defaultTimeOfDay;
  return value !== undefined && TIME_OF_DAY_PRESETS.includes(value) ? value : undefined;
}

/** Whether this page has opened its `?track=` circuit already */
let linkOpened = false;

/**
 * The circuit to open: `?track=` in the URL the first time, else the one picked last time, else the default. The link
 * opens its circuit once and leaves the address: the game remounting on a return from the home page, or a reload,
 * keeps the circuit the player has picked since (activateTrack stores it).
 */
export function loadStoredTrackId(): string {
  if (!linkOpened && LINKED_TRACK_ID && TRACKS.some((t) => t.id === LINKED_TRACK_ID)) {
    linkOpened = true;
    // Stored now, before it loads: a second call (development's doubled effects, an early remount) opens it too
    storeTrackId(LINKED_TRACK_ID);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("track");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // An address that can't be rewritten: a reload opens the linked circuit again
    }
    return LINKED_TRACK_ID;
  }
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
