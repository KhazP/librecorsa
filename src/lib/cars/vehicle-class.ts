/**
 * Pure vehicle-model -> car-class metadata shared by the Cloudflare Worker, the home page, and in-game UI.
 * Kept strictly free of simulator, audio, Three.js, and React imports so Workers and SSR stay lightweight.
 */
import type { VehicleModelId } from "@/types/f1";

export type VehicleClassId = "f1" | "gt3" | "proto" | "classic" | "road";

export const VEHICLE_CLASS_IDS = ["f1", "gt3", "proto", "classic", "road"] as const satisfies readonly VehicleClassId[];

export const isVehicleClassId = (v: unknown): v is VehicleClassId =>
  typeof v === "string" && (VEHICLE_CLASS_IDS as readonly string[]).includes(v);

/** Palette token colour for each car class (matches src/components/ui/badges/class-colors.ts) */
export type VehicleClassColor = "pink" | "cyan" | "purple" | "lemon" | "amber";

export interface VehicleClassMeta {
  id: VehicleClassId;
  /** Short tag for compact FL badges ("F1", "GT3", "Proto", "Classic", "Road") */
  short: string;
  /** Readable class label for filters and section headers */
  label: string;
  color: VehicleClassColor;
}

export const VEHICLE_CLASS_META: Readonly<Record<VehicleClassId, VehicleClassMeta>> = {
  f1: { id: "f1", short: "F1", label: "Open-wheel", color: "pink" },
  gt3: { id: "gt3", short: "GT3", label: "GT3", color: "cyan" },
  proto: { id: "proto", short: "Proto", label: "Prototypes", color: "purple" },
  classic: { id: "classic", short: "Classic", label: "Classic", color: "lemon" },
  road: { id: "road", short: "Road", label: "Road", color: "amber" },
};

/** Typed over VehicleModelId so adding a new vehicle model fails to compile until its class is assigned */
export const VEHICLE_CLASS_OF: Readonly<Record<VehicleModelId, VehicleClassId>> = {
  lc26: "f1",
  "f12026-car": "f1",
  "amg-gt3": "gt3",
  "mtr-496r": "proto",
  "lc-lmdh": "proto",
  "nissan-r33-jgtc": "classic",
  "nissan-r32-jtcc": "classic",
  "bmw-m1-procar": "classic",
  "chaparral-2d": "classic",
  "chaparral-2d-67": "classic",
  "porsche-934-rsr": "classic",
  liana: "road",
  "vw-scirocco-gtx": "road",
};

/** Concise display name for each vehicle model, for badge tooltips, popovers and Hall of Fame */
export const VEHICLE_DISPLAY_NAME: Readonly<Record<VehicleModelId, string>> = {
  lc26: "Proto 26",
  "f12026-car": "F1 Teams",
  "amg-gt3": "GT3",
  "mtr-496r": "MTRacing 496R",
  "lc-lmdh": "LC-LMDH",
  "nissan-r33-jgtc": "Skyline R33 GT500",
  "nissan-r32-jtcc": "Skyline R32 Gr.A",
  "bmw-m1-procar": "BMW M1 Procar",
  "chaparral-2d": "Chaparral 2D '66",
  "chaparral-2d-67": "Chaparral 2D '67",
  "porsche-934-rsr": "Porsche 934 RSR",
  liana: "Suzuki Liana",
  "vw-scirocco-gtx": "VW Scirocco GTX",
};

export function vehicleClassOf(vehicle: string): VehicleClassId | null {
  return Object.prototype.hasOwnProperty.call(VEHICLE_CLASS_OF, vehicle)
    ? VEHICLE_CLASS_OF[vehicle as VehicleModelId]
    : null;
}

export function vehicleDisplayName(vehicle: string): string {
  return Object.prototype.hasOwnProperty.call(VEHICLE_DISPLAY_NAME, vehicle)
    ? VEHICLE_DISPLAY_NAME[vehicle as VehicleModelId]
    : vehicle;
}
