import { BUILT_IN_CAR_IDS, carById, registerModCars, type BuiltInCarId, type CarDefinition, type CarSkin } from "@/lib/cars/car-registry";
import { VEHICLE_MODELS } from "@/lib/cars/vehicle-models";
import type { ModOrigin } from "@/lib/track-registry";
import { VEHICLE_MODEL_IDS, type VehicleModelId } from "@/types/f1";
import { modContentId, modDirUrl, modFileUrl, type ModCar, type ModCredit, type ModManifest, type ModSkin } from "./mod-manifest";

/**
 * Turns a package's cars and liveries into the car registry's entries. Circuits go through mod-loader.ts
 * (`modTrackInfos`); everything the car registry needs is here, so the loader stays free of car code.
 */

/** What a package may name: the game's own cars (for liveries and sounds) and vehicle models (for cars) */
export const modDefinitions = (): { cars: ReadonlySet<string>; vehicles: ReadonlySet<string> } => ({
  cars: BUILT_IN_CAR_IDS,
  vehicles: new Set(VEHICLE_MODEL_IDS),
});

const carCredit = (c: ModCredit, title: string) => ({
  title,
  author: c.author,
  url: c.url ?? c.authorUrl ?? "",
  authorUrl: c.authorUrl,
  license: c.license,
  licenseUrl: c.licenseUrl ?? c.url ?? "",
  note: c.note,
});

/** A package livery as the registry lists it: `mod:<package>/<id>`, its files in the package */
export function modSkin(packageId: string, s: ModSkin, origin: ModOrigin, dirBase = "skins"): CarSkin {
  return {
    id: modContentId(packageId, s.id),
    name: s.name,
    swatch: s.swatch,
    files: s.files,
    variant: s.variant,
    baseUrl: modDirUrl(packageId, s.dir ?? `${dirBase}/${s.id}`).replace(/\/$/, ""),
    mod: origin,
  };
}

/** A package car as the registry lists it, or null when its physics are a file (mod physics need the sim's own path) */
export function modCarDefinition(m: ModManifest, c: ModCar, origin: ModOrigin): CarDefinition | null {
  if (typeof c.physics !== "string") return null;
  const physics = c.physics as VehicleModelId;
  const id = modContentId(m.id, c.id) as CarDefinition["id"];
  const model = VEHICLE_MODELS[physics];
  const sound =
    "car" in c.sound
      ? carById(c.sound.car as BuiltInCarId).sound
      : {
          id,
          assetDir: modDirUrl(m.id, c.sound.dir),
          limiterRpm: c.sound.limiterRpm,
          // The bank sweeps its range on the vehicle model's own limiter
          physicsLimiterRpm: model.limiterRpm,
        };
  const skins = c.skins?.map((s) => modSkin(m.id, s, origin, `${c.model.slice(0, c.model.lastIndexOf("/") + 1)}skins`.replace(/^\//, "")));
  return {
    id,
    classId: c.classId,
    title: c.title,
    sub: c.sub,
    badge: c.badge,
    quality: "mod",
    credit: carCredit(c.credit ?? m.credit, `${c.title} (${m.name})`),
    physics,
    year: c.year,
    modelUrl: modFileUrl(m.id, c.model),
    bodyPlan: c.bodyPlan,
    // The first livery is the paint the model was made in
    skins: skins?.length ? skins : undefined,
    sound,
    mod: origin,
  };
}

/** Adds the enabled packages' cars and liveries to the car registry, in place of those added before */
export function registerModContent(packages: readonly { manifest: ModManifest; origin: ModOrigin }[]): void {
  const cars: CarDefinition[] = [];
  const skins = new Map<string, CarSkin[]>();
  for (const { manifest, origin } of packages) {
    for (const c of manifest.cars ?? []) {
      const def = modCarDefinition(manifest, c, origin);
      if (def) cars.push(def);
    }
    for (const s of manifest.skins ?? []) {
      skins.set(s.car, [...(skins.get(s.car) ?? []), modSkin(manifest.id, s, origin)]);
    }
  }
  registerModCars(cars, skins);
}
