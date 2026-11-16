import type { CarDefinition } from "@/lib/cars/car-registry";
import { supportOf, type SupportLink } from "@/lib/modder-support";
import { REPO_URL, SUPPORT_URL } from "@/lib/site";
import type { TrackInfo } from "@/lib/track-registry";

/**
 * Where a car's or circuit's 3D model comes from, as its Source chip shows it (CREDITS.md has the full notes), in the
 * order the panel shows it: the modder's support page, then their circuit or car, then everything else.
 */
export interface ModelSource {
  /** The modder's work: the mod, circuit or car they made */
  title: string;
  author: string;
  /** The work's page */
  url: string;
  /** The author's own page */
  authorUrl?: string;
  license: string;
  licenseUrl?: string;
  note?: string;
  /** The modder's support page (modder-support.ts), first in the panel */
  support?: SupportLink;
  /** Where the 3D model itself comes from, when the modder's work is something else (the Liana's physics) */
  model?: { title: string; author: string; url: string; license: string; licenseUrl?: string };
}

/** RISE Motordrome: the project's own circuit, also released for Assetto Corsa on OverTake, with two trackside tree models */
const RISE_SOURCE: ModelSource = {
  title: "RISE Motordrome",
  author: "Alp Yalay",
  authorUrl: "https://www.overtake.gg/members/khazmeister.1006084/",
  url: "https://www.overtake.gg/downloads/rise-motordrome-bugesera-rwanda.88890/",
  license: "CC BY-NC-SA 4.0",
  licenseUrl: `${REPO_URL}/blob/main/public/tracks/rwanda_official/LICENSE.md`,
  note: "Built for LibreCorsa (scripts/rwanda-official in the repository). Its trees are the acacia by evolveduk and the shrub by Natural_Disbuster, both CC BY 4.0.",
  support: { url: SUPPORT_URL, via: "Buy Me a Coffee" },
};

/** A car's source: the credited modder's work first, and the model's own origin after it when that is someone else's */
export const carModelSource = (car: Pick<CarDefinition, "credit" | "modelSource">): ModelSource => {
  const { title, author, authorUrl, url, license, licenseUrl } = car.credit;
  const model = car.modelSource;
  return {
    title,
    author,
    authorUrl,
    url,
    license,
    licenseUrl,
    note: model?.note ?? car.credit.note,
    support: supportOf(author),
    model: model ? { title: model.title, author: model.author, url: model.url, license: model.license, licenseUrl: model.licenseUrl } : undefined,
  };
};

/** A circuit's model source; null for one with no credit that isn't the project's own */
export const trackModelSource = (track: Pick<TrackInfo, "credit" | "quality">): ModelSource | null => {
  if (!track.credit) return track.quality === "original" ? RISE_SOURCE : null;
  const { title, author, authorUrl, url, license, licenseUrl, note } = track.credit;
  return { title, author, authorUrl, url, license, licenseUrl, note, support: supportOf(author) };
};
