/**
 * Circuits the simulator offers. Rwanda ships inside the bundle (track-data.ts imports its JSON); the others are
 * converted from Sketchfab scans by scripts/tracks/build_track.py, which writes public/tracks/<id>/ and keeps
 * public/tracks/index.json (this list) up to date. Their track data is fetched when the player picks one.
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
  /** Model attribution (CC BY 4.0 scans) */
  credit?: TrackCredit;
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
