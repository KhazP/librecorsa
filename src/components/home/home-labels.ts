import { useMemo } from "react";
import { useTranslations } from "use-intl/react";
import type { CarClassId } from "@/lib/cars/car-registry";
import type { CircuitType } from "@/lib/track-registry";
import type { HomeData, HomeQualityTexts } from "./home-data";

/**
 * The home page's data with the game's words in the player's language. page.tsx builds the data on the server, where
 * the registries' words are English (the page can't import the registries: they carry the game's sound and track
 * code), so the grades, course kinds and car classes are named again here from the message files.
 */
export function useLocalizedHome(data: HomeData): HomeData {
  const t = useTranslations("game");
  return useMemo(() => {
    const quality: HomeQualityTexts = {
      circuits: {
        original: { badge: t("circuitQuality.originalBadge"), filterLabel: t("circuitQuality.original"), description: t("circuitQuality.originalDetail") },
        sim: { badge: t("circuitQuality.simBadge"), filterLabel: t("circuitQuality.sim"), description: t("circuitQuality.simDetail") },
        sketchfab: { badge: t("circuitQuality.scanBadge"), filterLabel: t("circuitQuality.scan"), description: t("circuitQuality.scanDetail") },
      },
      cars: {
        own: { badge: t("carQuality.ownBadge"), filterLabel: t("carQuality.own"), description: t("carQuality.ownDetail") },
        shared: { badge: t("carQuality.sharedBadge"), filterLabel: t("carQuality.shared"), description: t("carQuality.sharedDetail") },
        era: { badge: t("carQuality.eraBadge"), filterLabel: t("carQuality.era"), description: t("carQuality.eraDetail") },
      },
    };
    const type: Record<CircuitType, string> = {
      permanent: t("circuitType.permanent"),
      street: t("circuitType.street"),
      oval: t("circuitType.oval"),
      hillclimb: t("circuitType.hillclimb"),
    };
    // GT3 is the class's name in every language (car-registry CAR_CLASSES)
    const carClass: Record<CarClassId, string> = {
      f1: t("carClass.f1"),
      gt3: "GT3",
      proto: t("carClass.proto"),
      classic: t("carClass.classic"),
      road: t("carClass.road"),
    };
    return {
      ...data,
      qualityText: quality,
      venues: data.venues.map((v) => ({ ...v, types: v.typeIds.map((id) => type[id]) })),
      cars: data.cars.map((c) => ({ ...c, classTitle: carClass[c.classId] })),
    };
  }, [data, t]);
}
