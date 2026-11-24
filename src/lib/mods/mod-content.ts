import { anyCarById, BUILT_IN_CAR_IDS, carById, registerModCars, type BuiltInCarId, type CarDefinition, type CarSkin } from "@/lib/cars/car-registry";
import { VEHICLE_MODELS } from "@/lib/cars/vehicle-models";
import type { ModOrigin } from "@/lib/track-registry";
import { VEHICLE_MODEL_IDS, type VehicleModelId } from "@/types/f1";
import { modContentId, modDirUrl, modFileUrl, modSkinDir, type ModCar, type ModCredit, type ModKnownIds, type ModManifest, type ModSkin } from "./mod-manifest";
import { modSimProfile, type ModPhysicsResult } from "./mod-physics";
import type { CarSimProfile } from "@/lib/sim/f12026-car/F12026CarSim";

/**
 * Turns a package's cars and liveries into the car registry's entries. Circuits go through mod-loader.ts
 * (`modTrackInfos`); everything the car registry needs is here, so the loader stays free of car code.
 */

/**
 * What a package may name: the game's own cars (for sounds), those with liveries (for liveries), vehicle models (for
 * cars), and the models a physics file can change (those the game's car simulation runs on a profile)
 */
export const modDefinitions = (): Required<ModKnownIds> => ({
  cars: BUILT_IN_CAR_IDS,
  skinCars: new Set([...BUILT_IN_CAR_IDS].filter((id) => anyCarById(id as BuiltInCarId)?.skins?.length)),
  vehicles: new Set(VEHICLE_MODEL_IDS),
  physicsBases: new Set(VEHICLE_MODEL_IDS.filter((v) => VEHICLE_MODELS[v].simProfile)),
});

/** A mod car's own physics: the base model's profile with its physics file's changes (mod-physics.ts) */
export function modCarProfile(m: ModManifest, c: ModCar, file: unknown, hash: string | undefined): ModPhysicsResult {
  const physics = c.physics;
  if (typeof physics === "string") return { ok: false, errors: [`${c.id}: has no physics file`] };
  const base = VEHICLE_MODELS[physics.base as VehicleModelId]?.simProfile;
  if (!base) return { ok: false, errors: [`${c.id}: ${physics.base} can't take a physics file`] };
  // Plans and guides are kept per profile id: each car and each version of the package gets its own
  const id = `${modContentId(m.id, c.id)}@${hash ? hash.slice(0, 12) : m.version}`;
  const result = modSimProfile(base, file, id, c.bodyPlan);
  return result.ok ? result : { ok: false, errors: result.errors.map((e) => `${physics.file}: ${e}`) };
}

const carCredit = (c: ModCredit, title: string) => ({
  title,
  author: c.author,
  url: c.url ?? c.authorUrl ?? "",
  authorUrl: c.authorUrl,
  license: c.license,
  licenseUrl: c.licenseUrl ?? c.url ?? "",
  note: c.note,
});

/** A package livery as the registry lists it: `mod:<package>/<id>`, its files in the package (`car`: the mod car it is for) */
export function modSkin(packageId: string, s: ModSkin, origin: ModOrigin, car?: ModCar): CarSkin {
  return {
    id: modContentId(packageId, s.id),
    name: s.name,
    swatch: s.swatch,
    files: s.files,
    variant: s.variant,
    baseUrl: modDirUrl(packageId, modSkinDir(s, car)).replace(/\/$/, ""),
    mod: origin,
  };
}

/**
 * A package car as the registry lists it. A car with its own physics needs its profile (`modCarProfile`); without one
 * (its file missing or refused) it is left out: null
 */
export function modCarDefinition(m: ModManifest, c: ModCar, origin: ModOrigin, simProfile?: CarSimProfile): CarDefinition | null {
  if (typeof c.physics !== "string" && !simProfile) return null;
  const physics = (typeof c.physics === "string" ? c.physics : c.physics.base) as VehicleModelId;
  const id = modContentId(m.id, c.id) as CarDefinition["id"];
  const model = VEHICLE_MODELS[physics];
  // The limiter the car's engine really has: its physics file's, else its vehicle model's
  const physicsLimiterRpm = simProfile?.config.gearbox.gears.redline_rpm ?? model.limiterRpm;
  // Either bank sweeps its range on that limiter. A game car's is found in a clone too (where only the prototype is listed)
  const sound =
    "car" in c.sound
      ? { ...(anyCarById(c.sound.car as BuiltInCarId) ?? carById(c.sound.car as BuiltInCarId)).sound, physicsLimiterRpm }
      : { id, assetDir: modDirUrl(m.id, c.sound.dir), limiterRpm: c.sound.limiterRpm, physicsLimiterRpm };
  const skins = c.skins?.map((s) => modSkin(m.id, s, origin, c));
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
    ...(simProfile ? { simProfile } : {}),
  };
}

/**
 * Adds the enabled packages' cars and liveries to the car registry, in place of those added before. `profiles`: the
 * own physics of the cars that have them, by car id within the package
 */
export function registerModContent(
  packages: readonly { manifest: ModManifest; origin: ModOrigin; profiles?: ReadonlyMap<string, CarSimProfile> }[],
): void {
  const cars: CarDefinition[] = [];
  const skins = new Map<string, CarSkin[]>();
  for (const { manifest, origin, profiles } of packages) {
    for (const c of manifest.cars ?? []) {
      const def = modCarDefinition(manifest, c, origin, profiles?.get(c.id));
      if (def) cars.push(def);
    }
    for (const s of manifest.skins ?? []) {
      skins.set(s.car, [...(skins.get(s.car) ?? []), modSkin(manifest.id, s, origin)]);
    }
  }
  registerModCars(cars, skins);
}
