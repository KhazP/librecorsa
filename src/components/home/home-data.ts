import type { LapOutline } from "@/lib/home/lap-outline";
import type { ModelSource } from "@/lib/model-source";
import type { VehicleModelId } from "@/types/f1";
import type { BadgeTone, PaletteColor } from "@/components/ui/Badge";
// Types only: the registries' values stay out of the home page's bundle (page.tsx reads them on the server)
import type { CarClassId, CarQuality } from "@/lib/cars/car-registry";
import type { CircuitQuality, CircuitType } from "@/lib/track-registry";

/**
 * A circuit's or car's grade in the game's words (`CIRCUIT_QUALITY_META` / `CAR_QUALITY_META`), which page.tsx reads
 * on the server through `homeQualityText` (src/lib/home/quality.ts) and hands to the page
 */
export interface HomeQualityText {
  /** The badge ("ORIGINAL", "SIM GRADE", "SCAN", "OWN PHYSICS", "SHARED PHYSICS") */
  badge: string;
  /** The filter option ("LibreCorsa originals", "Own physics") */
  filterLabel: string;
  /** What it means, on hover */
  description: string;
}
export interface HomeQualityTexts {
  circuits: Record<CircuitQuality, HomeQualityText>;
  cars: Record<CarQuality, HomeQualityText>;
}

/** The game's badge tones by grade (menu-content-ui.tsx `CIRCUIT_TONE` / `CAR_TONE`): an original circuit is information, not volt */
export const CIRCUIT_QUALITY_TONE: Record<CircuitQuality, Exclude<BadgeTone, "player">> = { original: "info", sim: "good", sketchfab: "warn" };
export const CAR_QUALITY_TONE: Record<CarQuality, Exclude<BadgeTone, "player">> = { own: "good", shared: "warn", era: "neutral" };

/** What the home page is built with: the game's own lists, read when the page is built */
export interface HomeLayout {
  id: string;
  layout: string;
  lengthM: number;
  turns: number;
  /** Where its model comes from, as the game grades it (track-registry `quality`) */
  quality: CircuitQuality;
  /** null when the outlines file has none for it (`npm run home-outlines`) */
  outline: LapOutline | null;
}

/** Responsive scenic backdrop for a venue's home Drive tile (`npm run venue-heroes`) */
export interface HomeVenueHero {
  src: string;
  srcSet: string;
}

export interface HomeVenue {
  /** Primary layout id (folder name under `public/tracks/`) */
  id: string;
  name: string;
  country: string;
  /** The kinds of course its layouts are ("Permanent", "Hill climb"), for the Circuits filters */
  types: string[];
  /** The same kinds as ids, so the page can name them in the player's language (useLocalizedHome) */
  typeIds: CircuitType[];
  /** Who made its model (its credited author, or LibreCorsa), for the Circuits filters */
  modders: string[];
  layouts: HomeLayout[];
  /** Scenic golden-hour still for the Drive tile; null when this copy has none */
  hero: HomeVenueHero | null;
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
  /** Its class as an id, so the page can name it in the player's language (useLocalizedHome) */
  classId: CarClassId;
  year: number;
  /** Whether its physics are its own, as the game grades it (car-registry `quality`) */
  quality: CarQuality;
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
  /** The game's words for each circuit and car grade (`homeQualityText()`) */
  qualityText: HomeQualityTexts;
  /**
   * The newest few. The Press & media card folds one piece posted on several platforms ("AppMunchies on Instagram",
   * "… on YouTube") into one row (`groupCoverage`), so pass enough for three rows after that
   */
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

/** What is in the game, in the press page's words: each a label and a line (home.hub.facts in the messages) */
export const GAME_FACTS = ["physics", "racing", "controls", "platforms", "conditions", "price"] as const;
