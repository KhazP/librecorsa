import type { LapOutline } from "@/lib/home/lap-outline";
import type { ModelSource } from "@/lib/model-source";
import type { VehicleModelId } from "@/types/f1";
import type { PaletteColor } from "@/components/ui/Badge";

/**
 * How far a circuit or car can be trusted, in the two kinds the home page shows (from the registries' `quality`):
 * - "sim": a circuit built for LibreCorsa or hand-built for sims, with its own surfaces; a car on physics built for it
 * - "model": a circuit converted from a community 3D model; a car's 3D body driving on another car's physics
 */
export type HomeGrade = "sim" | "model";

/** The tones the game's own quality badges use: sim grade green, a converted model amber (the wrappers in menu-content-ui.tsx) */
export const GRADE_BADGES: Record<HomeGrade, { label: string; tone: "good" | "warn" }> = {
  sim: { label: "Sim grade", tone: "good" },
  model: { label: "3D model", tone: "warn" },
};

/** The legend above the circuit and car cards, and each badge's hover text */
export const GRADE_NOTES: Record<"circuits" | "cars", Record<HomeGrade, string>> = {
  circuits: {
    sim: "Hand-built road, kerbs and barriers, each with its own grip.",
    model: "Converted from a 3D model of the venue, so details can differ from the real one.",
  },
  cars: {
    sim: "Physics built for this car.",
    model: "This car's body, driving on another car's physics.",
  },
};

/** What the home page is built with: the game's own lists, read when the page is built */
export interface HomeLayout {
  id: string;
  layout: string;
  lengthM: number;
  turns: number;
  grade: HomeGrade;
  /** null when the outlines file has none for it (`npm run home-outlines`) */
  outline: LapOutline | null;
}

export interface HomeVenue {
  name: string;
  country: string;
  /** The kinds of course its layouts are ("Permanent", "Hill climb"), for the Circuits filters */
  types: string[];
  /** Who made its model (its credited author, or LibreCorsa), for the Circuits filters */
  modders: string[];
  layouts: HomeLayout[];
  /** Where its model comes from (its layouts share one); null when there is no source to show */
  source: ModelSource | null;
}

export interface HomeLivery {
  id: string;
  name: string;
  /** Optional team or subtitle */
  detail?: string;
  /** Optional collection heading (e.g. LibreCorsa, 2026 Grid, Retro) */
  group?: string;
  /** CSS colour or gradient for the swatch pill */
  swatch: string;
  /** Pre-rendered car picture wearing this livery, or null when unavailable */
  thumb: string | null;
}

export interface HomeCar {
  id: string;
  /** Shared physics / leaderboard model id */
  vehicle: VehicleModelId;
  title: string;
  classTitle: string;
  year: number;
  grade: HomeGrade;
  /** null when this copy of the game has no picture of it */
  thumb: string | null;
  /** Where this car persists its chosen livery: player settings (`liveryId`) or per-car skins (`librecorsa.carSkins`) */
  liveryStore?: "settings" | "skin";
  /** Liveries or mod skins available for this car (empty when a car keeps a single factory paint) */
  liveries: HomeLivery[];
  /** Where its 3D body comes from */
  source: ModelSource;
}

export interface HomeCoverage {
  outlet: string;
  title: string;
  url: string;
  /** YYYY-MM-DD */
  date: string;
}

export interface WhatsNewDay {
  /** Calendar date in Europe/Istanbul: YYYY-MM-DD */
  date: string;
  /** Short plain-English headline for the day (no trailing period, no emoji) */
  title: string;
  /** Player-facing patch-note bullets summarizing that day's work */
  items: string[];
  /** Number of non-merge commits on that day (excluding whats-new.json itself) */
  commits: number;
  /** Full 40-character SHA of the newest commit included in this day's summary */
  lastSha: string;
}

export interface HomeData {
  defaultTrackId: string;
  defaultCarId: string;
  venues: HomeVenue[];
  cars: HomeCar[];
  /** The newest few */
  coverage: HomeCoverage[];
  /** How many articles and videos the press page lists in all */
  coverageCount: number;
  /** Where to write to me, e.g. with a mod */
  contactEmail: string;
  repoUrl: string;
  supportUrl: string;
  /** Who made the circuits and cars, those who take donations first (modders.ts) */
  modders: import("@/lib/modders").ModderWork[];
  /** Each car's short name and class colour, for the rows of the online board of every car (the Lap times section) */
  boardCars: Partial<Record<VehicleModelId, { label: string; color: PaletteColor }>>;
  /** The cars the Lap times board can be narrowed to, one per board (cars that drive the same share one), in menu order */
  boardCarChoices: { id: VehicleModelId; label: string; detail?: string }[];
  /** Car names by car id, for the weekly challenge's weeks (preview cars included: a week may run one) */
  carTitles: Record<string, string>;
  /** The What's new section's patch notes, newest day first */
  whatsNew: WhatsNewDay[];
}


const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-11-09 → 9 Nov 2026 */
export const day = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** What is in the game, in the press page's words */
export const GAME_FACTS: readonly [label: string, text: string][] = [
  ["Physics", "Simulated 500 times a second, with tyre temperatures, active aero and hybrid power"],
  ["Racing", "Hot laps, races against AI, multiplayer rooms and online lap times"],
  ["Controls", "Keyboard, gamepad, touch or a force-feedback wheel"],
  ["Plays on", "Any modern browser: computer, phone or tablet"],
  ["Conditions", "Your choice of weather and time of day"],
  ["Price", "Free. No account and no ads; tips are optional and unlock nothing"],
];
