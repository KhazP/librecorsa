import type { HomeQualityText, HomeQualityTexts } from "@/components/home/home-data";
import { CAR_QUALITY_META, type CarQualityMeta } from "@/lib/cars/car-registry";
import { CIRCUIT_QUALITY_META, type CircuitQualityMeta } from "@/lib/track-registry";

/**
 * The game's words for each circuit and car grade, for the home page. Called by src/app/page.tsx on the server only:
 * the registries carry the game's sound and track code, which a client component must not pull in.
 */

const textOf = ({ badge, filterLabel, description }: CircuitQualityMeta | CarQualityMeta): HomeQualityText => ({
  badge,
  filterLabel,
  description,
});

const mapText = <K extends string>(meta: Record<K, CircuitQualityMeta | CarQualityMeta>): Record<K, HomeQualityText> =>
  Object.fromEntries(Object.entries<CircuitQualityMeta | CarQualityMeta>(meta).map(([k, m]) => [k, textOf(m)])) as Record<K, HomeQualityText>;

export const homeQualityText = (): HomeQualityTexts => ({
  circuits: mapText(CIRCUIT_QUALITY_META),
  cars: mapText(CAR_QUALITY_META),
});
