import type { CarDefinition } from "@/lib/cars/car-registry";
import { REPO_URL } from "@/lib/site";
import type { TrackInfo } from "@/lib/track-registry";

/** Where a car's or circuit's 3D model comes from, as its Source chip shows it (CREDITS.md has the full notes) */
export interface ModelSource {
  title: string;
  author: string;
  /** The model's page */
  url: string;
  /** The author's own site */
  authorUrl?: string;
  license: string;
  licenseUrl?: string;
  note?: string;
}

/** RISE Motordrome: the project's own circuit, with two trackside tree models */
const RISE_SOURCE: ModelSource = {
  title: "RISE Motordrome",
  author: "LibreCorsa",
  url: `${REPO_URL}/tree/main/scripts/rwanda-official`,
  license: "CC BY-NC-SA 4.0",
  licenseUrl: `${REPO_URL}/blob/main/public/tracks/rwanda_official/LICENSE.md`,
  note: "Built for LibreCorsa. Its trees are the acacia by evolveduk and the shrub by Natural_Disbuster, both CC BY 4.0.",
};

export const carModelSource = (car: Pick<CarDefinition, "credit" | "modelSource">): ModelSource => {
  const { title, author, url, license, licenseUrl, note } = car.modelSource ?? car.credit;
  return { title, author, url, license, licenseUrl, note };
};

/** A circuit's model source; null for one with no credit that isn't the project's own */
export const trackModelSource = (track: Pick<TrackInfo, "credit" | "quality">): ModelSource | null => {
  if (!track.credit) return track.quality === "original" ? RISE_SOURCE : null;
  const { title, author, authorUrl, url, license, licenseUrl, note } = track.credit;
  return { title, author, authorUrl, url, license, licenseUrl, note };
};
