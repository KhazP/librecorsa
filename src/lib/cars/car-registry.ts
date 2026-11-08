import type { VehicleModelId } from "@/types/f1";
import {
  BMW_M4_GT3_SOUND,
  F2004_SOUND,
  F1_2026_SOUND,
  R25_SOUND,
  RB8_SOUND,
  RB22_SOUND,
  SF26_SOUND,
  SF71H_SOUND,
  W17_SOUND,
  type CarSoundSource,
} from "@/lib/sim/CarAudio";
import { AMG_GT3_SOUND } from "@/lib/sim/gt3/AmgGt3Sim";
import { SUZUKI_LIANA_SOUND } from "@/lib/sim/road/SuzukiLianaSim";
import { overtakingRulesForSeason, type OvertakingRules } from "@/lib/sim/overtaking-rules";

/**
 * The cars in the picker, grouped by class and then by year, newest first. A car is a body and a sound on one of the
 * vehicle models (`VehicleModelId`): setups, telemetry, lap records and leaderboards stay keyed by that model, so a
 * new car only needs its GLB (`public/cars/<id>/model/`), its sound bank (`public/cars/<id>/audio/`) and an entry
 * here with its class and year.
 * The first car of each vehicle model keeps the model's id, so saved choices and `?car=` links still resolve.
 */
export type CarId =
  | "vf26"
  | "f12026-car"
  | "sf26"
  | "w17"
  | "rb22"
  | "sf71h"
  | "rb8"
  | "r25"
  | "f2004"
  | "amg-gt3"
  | "amg-gt3-evo"
  | "bmw-m4-gt3"
  | "liana";

/**
 * The kinds of car, one menu category each; a car's year groups it within its class. Class ids live only in code
 * and the menus' state (saved choices are `CarId`s, an online room's rule is `CarClassRule`), so they can be renamed.
 */
export type CarClassId = "f1" | "gt3" | "road";

export interface CarClass {
  id: CarClassId;
  title: string;
  sub: string;
  color: string;
}

/**
 * Whether a car's physics belong to the car you see, the car-side counterpart of a circuit's `CircuitQuality`:
 * - "own": its vehicle model was built for this car (the F1 2026 Prototype and Rigid-Body, the Mercedes-AMG GT3s,
 *   the Suzuki Liana)
 * - "shared": a ported body on another car's model of the same class and era (the 2026 team cars, the BMW)
 * - "era": a ported body from an earlier season on the 2026 model
 * The F1 physics switch doesn't change it: a ported F1 car borrows its physics under either model.
 */
export type CarQuality = "own" | "shared" | "era";

export interface CarQualityMeta {
  /** Badge on cards and next to car names */
  badge: string;
  /** Filter and group label in the car browser */
  filterLabel: string;
  color: string;
  variant: "solid" | "soft" | "outline";
  /** Shown in the car detail pane, the browser's footnote and on hover */
  description: string;
}

export const CAR_QUALITY_META: Record<CarQuality, CarQualityMeta> = {
  own: {
    badge: "OWN PHYSICS",
    filterLabel: "Own physics",
    color: "#00E676",
    variant: "soft",
    description: "Drives on physics built for this car.",
  },
  shared: {
    badge: "SHARED PHYSICS",
    filterLabel: "Shared physics",
    color: "#FFB300",
    variant: "soft",
    description: "Drives on the physics of another car from the same class and era, so it handles like that car rather than its own.",
  },
  era: {
    badge: "2026 PHYSICS",
    filterLabel: "Older cars",
    color: "#FF6B8A",
    variant: "soft",
    description: "Drives on 2026 physics, so it handles like a 2026 car rather than the way it did in its own season.",
  },
};

/**
 * How far each vehicle model has been checked, shown with a car's grade. Keyed by the model the car drives on now,
 * so a ported F1 car follows the physics switch.
 */
export const PHYSICS_CHECK: Record<VehicleModelId, string> = {
  "amg-gt3": "Its physics are checked against a real GT3 Evo's telemetry.",
  vf26: "Its physics are checked against the reference data they were built from.",
  "f12026-car": "Its physics are checked against the range a 2026 F1 car should fall in.",
  liana: "Its physics come from an Assetto Corsa mod of this car and are checked against its Top Gear lap there.",
};

/** Who made a car's 3D body (CREDITS.md has the full notes) */
export interface CarCredit {
  title: string;
  author: string;
  url: string;
  license: string;
  licenseUrl: string;
}

const CC_BY = { license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" } as const;
const CC_BY_NC_SA = { license: "CC BY-NC-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/" } as const;

/** The F1 2026 Prototype and Rigid-Body's own body (`public/amr26/model/amr26.glb`) */
const DEX_F1_2026: CarCredit = { title: "AM26 - F1 25/F1 2026 DLC", author: "DeX", url: "https://skfb.ly/pKNCK", ...CC_BY };

const daveLove = (title: string, url: string): CarCredit => ({ title, author: "Dave Love SketchFab", url, ...CC_BY });

export interface CarDefinition {
  id: CarId;
  classId: CarClassId;
  title: string;
  sub: string;
  /** Short name on chips (not the grade: that's `quality`) */
  badge: string;
  /** Whether its physics belong to it */
  quality: CarQuality;
  /** Its 3D body's author */
  credit: CarCredit;
  /** The vehicle model that drives it */
  physics: VehicleModelId;
  /**
   * The car's year: the season it raced in, or the model year of a road car. The menus group a class's cars by it,
   * newest first. For an F1 car it also sets the overtaking aids (`carOvertakingRules`): 2026 on, Straight Mode in
   * every DRS zone plus Overtake Mode; 2011 to 2025, rear-flap DRS by the 1 s rule; before 2011, no DRS. Other
   * classes never get them, whatever their year.
   */
  year: number;
  /** A ported GLB on the generic rig (`ported-car-model.ts`); absent: the vehicle model's own car */
  modelUrl?: string;
  sound: CarSoundSource;
}

export const CAR_CLASSES: readonly CarClass[] = [
  { id: "f1", title: "F1", sub: "Open-wheel · DRS / active aero", color: "#CCFF00" },
  { id: "gt3", title: "GT3", sub: "Closed-wheel · ABS / TC", color: "#00E5FF" },
  { id: "road", title: "Road cars", sub: "Road-legal · street tyres", color: "#FF8A3D" },
];

export const CARS: readonly CarDefinition[] = [
  {
    id: "vf26",
    classId: "f1",
    title: "F1 2026 Prototype",
    sub: "Curvilinear 2026 model · active aero",
    badge: "F1 2026",
    quality: "own",
    credit: DEX_F1_2026,
    physics: "vf26",
    year: 2026,
    sound: F1_2026_SOUND,
  },
  {
    id: "f12026-car",
    classId: "f1",
    title: "F1 2026 Rigid-Body",
    sub: "6-DOF rigid-body · track colliders · DRS",
    badge: "6-DOF",
    quality: "own",
    credit: DEX_F1_2026,
    physics: "f12026-car",
    year: 2026,
    sound: F1_2026_SOUND,
  },
  {
    id: "sf26",
    classId: "f1",
    title: "SF-26",
    sub: "2026 car",
    badge: "SF-26",
    quality: "shared",
    credit: daveLove("2026 Ferrari SF-26", "https://sketchfab.com/3d-models/2026-ferrari-sf-26-e5ca6cecdc42449283f4bed27360f2a7"),
    physics: "f12026-car",
    year: 2026,
    modelUrl: "/cars/sf26/model/sf26.glb",
    sound: SF26_SOUND,
  },
  {
    id: "w17",
    classId: "f1",
    title: "W17",
    sub: "2026 car",
    badge: "W17",
    quality: "shared",
    credit: daveLove("2026 Mercedes W17", "https://sketchfab.com/3d-models/2026-mercedes-w17-b806f1e70aa343219e7158169549b97b"),
    physics: "f12026-car",
    year: 2026,
    modelUrl: "/cars/w17/model/w17.glb",
    sound: W17_SOUND,
  },
  {
    id: "rb22",
    classId: "f1",
    title: "RB22",
    sub: "2026 car",
    badge: "RB22",
    quality: "shared",
    credit: daveLove("2026 Redbull RB22", "https://sketchfab.com/3d-models/2026-redbull-rb22-0a3d24a58e0549d591a5a48c22eec383"),
    physics: "f12026-car",
    year: 2026,
    modelUrl: "/cars/rb22/model/rb22.glb",
    sound: RB22_SOUND,
  },
  {
    id: "sf71h",
    classId: "f1",
    title: "SF71H",
    sub: "2018 car",
    badge: "SF71H",
    quality: "era",
    credit: daveLove("2018 Ferrari SF71H", "https://sketchfab.com/3d-models/2018-ferrari-sf71h-e54b896bd21f478f8309eecf3726700e"),
    physics: "f12026-car",
    year: 2018,
    modelUrl: "/cars/sf71h/model/sf71h.glb",
    sound: SF71H_SOUND,
  },
  {
    id: "rb8",
    classId: "f1",
    title: "RB8",
    sub: "2012 car",
    badge: "RB8",
    quality: "era",
    credit: daveLove("2012 Red Bull RB8", "https://sketchfab.com/3d-models/2012-red-bull-rb8-b74446dcd93a49879546d756e3093b3f"),
    physics: "f12026-car",
    year: 2012,
    modelUrl: "/cars/rb8/model/rb8.glb",
    sound: RB8_SOUND,
  },
  {
    id: "r25",
    classId: "f1",
    title: "R25",
    sub: "2005 car",
    badge: "R25",
    quality: "era",
    credit: daveLove("2005 Renault R25", "https://sketchfab.com/3d-models/2005-renault-r25-0d58fe125f5b41a2b8482576723120c4"),
    physics: "f12026-car",
    year: 2005,
    modelUrl: "/cars/r25/model/r25.glb",
    sound: R25_SOUND,
  },
  {
    id: "f2004",
    classId: "f1",
    title: "F2004",
    sub: "2004 car",
    badge: "F2004",
    quality: "era",
    credit: daveLove("2004 Ferrari F2004", "https://sketchfab.com/3d-models/2004-ferrari-f2004-bedade52e6f4415e90e656817c5701f8"),
    physics: "f12026-car",
    year: 2004,
    modelUrl: "/cars/f2004/model/f2004.glb",
    sound: F2004_SOUND,
  },
  {
    id: "amg-gt3",
    classId: "gt3",
    title: "Mercedes-AMG GT3",
    sub: "GT3 Pro · 6.2L V8 · Multi-stage ABS / TC",
    badge: "GT3 PRO",
    quality: "own",
    credit: { title: "2020 Mercedes-Benz AMG GT3", author: "Ddiaz Design", url: "https://skfb.ly/pOTPL", ...CC_BY_NC_SA },
    physics: "amg-gt3",
    year: 2020,
    sound: AMG_GT3_SOUND,
  },
  {
    id: "amg-gt3-evo",
    classId: "gt3",
    title: "Mercedes-AMG GT3 Evo",
    sub: "GT3 Evo · AMG GT3 physics · ABS / TC",
    badge: "GT3 EVO",
    quality: "own",
    credit: {
      title: "Mercedes-AMG GT3 Red Bull Racing",
      author: "VTX",
      url: "https://sketchfab.com/3d-models/mercedes-amg-gt3-red-bull-racing-035f061cb6624effbc483d5f9b5ecaba",
      ...CC_BY_NC_SA,
    },
    physics: "amg-gt3",
    // The model's title gives no year: the Evo's homologation year
    year: 2020,
    modelUrl: "/cars/amg-gt3-evo/model/amg-gt3-evo.glb",
    sound: AMG_GT3_SOUND,
  },
  {
    id: "bmw-m4-gt3",
    classId: "gt3",
    title: "BMW M4 GT3 Evo",
    sub: "G82 GT3 Evo · AMG GT3 physics · ABS / TC",
    badge: "M4 GT3",
    quality: "shared",
    credit: {
      title: "2025 BMW M4 GT3 EVO G82",
      author: "Ddiaz Design",
      url: "https://sketchfab.com/3d-models/2025-bmw-m4-gt3-evo-g82-113f83dd87064697a5ec2511d280b9d5",
      ...CC_BY_NC_SA,
    },
    physics: "amg-gt3",
    year: 2025,
    modelUrl: "/cars/bmw-m4-gt3/model/bmw-m4-gt3.glb",
    sound: BMW_M4_GT3_SOUND,
  },
  {
    id: "liana",
    classId: "road",
    title: "Suzuki Liana 1.6",
    sub: "2002 · 1.6 L four · front-wheel drive",
    badge: "LIANA",
    quality: "own",
    // An Assetto Corsa car whose author can't be traced; its physics are alekabul's rework (CREDITS.md)
    credit: {
      title: "Suzuki Liana",
      author: "Unknown",
      url: "http://assetto-db.com/car/suzuki_liana",
      license: "Freeware mod",
      licenseUrl: "http://assetto-db.com/car/suzuki_liana",
    },
    physics: "liana",
    year: 2002,
    modelUrl: "/cars/liana/model/liana.glb",
    sound: SUZUKI_LIANA_SOUND,
  },
];

const BY_ID = new Map<string, CarDefinition>(CARS.map((c) => [c.id, c]));

export const isCarId = (value: unknown): value is CarId => typeof value === "string" && BY_ID.has(value);

export const carById = (id: CarId): CarDefinition => {
  const car = BY_ID.get(id);
  if (car) return car;
  // Typed ids make this a stale save or a removed car; say so rather than quietly driving another one
  console.warn(`Unknown car "${id}", using ${CARS[0].id}`);
  return CARS[0];
};

export const carQualityMeta = (car: Pick<CarDefinition, "quality">): CarQualityMeta => CAR_QUALITY_META[car.quality];

export const carClass = (id: CarClassId): CarClass => CAR_CLASSES.find((c) => c.id === id) ?? CAR_CLASSES[0];

/** A car's class and year, as its chip reads: "F1 · 2018", "Road cars · 2002" */
export const carClassYear = (car: Pick<CarDefinition, "classId" | "year">): string =>
  `${carClass(car.classId).title} · ${car.year}`;

/**
 * The overtaking aids a car races with: an F1 car's by its year (`overtakingRulesForSeason`), none for any other
 * class (absent: its vehicle model keeps its flaps shut, as a GT3 or road car always has).
 */
export const carOvertakingRules = (car: Pick<CarDefinition, "classId" | "year">): OvertakingRules | undefined =>
  car.classId === "f1" ? overtakingRulesForSeason(car.year) : undefined;

const CLASS_ORDER = new Map<CarClassId, number>(CAR_CLASSES.map((k, i) => [k.id, i]));
const REGISTRY_ORDER = new Map<CarId, number>(CARS.map((c, i) => [c.id, i]));

/** The menus' order: by class, then newest first, then as listed here */
export const compareCarsByClassAndYear = (a: CarDefinition, b: CarDefinition): number =>
  (CLASS_ORDER.get(a.classId) ?? 0) - (CLASS_ORDER.get(b.classId) ?? 0) ||
  b.year - a.year ||
  (REGISTRY_ORDER.get(a.id) ?? 0) - (REGISTRY_ORDER.get(b.id) ?? 0);

/**
 * Whether the livery picker repaints this car. Ported cars (`modelUrl`) keep the paint their GLB was authored
 * with; the menus show "Factory livery" for them instead of the swatches.
 */
export const carTakesLivery = (id: CarId): boolean => !carById(id).modelUrl;

/** Shown in place of the livery swatches for a car that keeps its own paint */
export const FACTORY_LIVERY_NOTE = "Factory livery: this car keeps its original paint.";

/** The classes that have cars, in picker order */
export const carClassesInUse = (): CarClass[] => CAR_CLASSES.filter((k) => CARS.some((c) => c.classId === k.id));

/** A class's cars in registry order */
export const carsInClass = (id: CarClassId): CarDefinition[] => CARS.filter((c) => c.classId === id);

/** A class's cars by year, newest first (registry order within a year), for the year headings in the menus */
export const carsByYear = (id: CarClassId): { year: number; cars: CarDefinition[] }[] => {
  const groups = new Map<number, CarDefinition[]>();
  for (const car of carsInClass(id)) groups.set(car.year, [...(groups.get(car.year) ?? []), car]);
  return [...groups.entries()].sort(([a], [b]) => b - a).map(([year, cars]) => ({ year, cars }));
};

/** The car that stands for a vehicle model (its first car), e.g. for a leaderboard entry or a class rule */
export const carForVehicle = (vehicle: VehicleModelId): CarDefinition =>
  CARS.find((c) => c.physics === vehicle) ?? CARS[0];
