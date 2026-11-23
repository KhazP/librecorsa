import type { VehicleModelId } from "@/types/f1";

/**
 * The shape of body a vehicle model wears, for what is drawn by shape rather than from the model: the contact shadow's
 * footprint (render/contact-shadow.ts) and the opponents' shadow stand-ins (render/car-shadow-proxy.ts). Typed over
 * VehicleModelId, so a new model fails to compile until it has one.
 */
export type BodyKind = "f1" | "gt3" | "road" | "proto" | "lmdh" | "classic";

export const BODY_KIND: Readonly<Record<VehicleModelId, BodyKind>> = {
  lc26: "f1",
  "f12026-car": "f1",
  "amg-gt3": "gt3",
  liana: "road",
  "vw-scirocco-gtx": "road",
  "mtr-496r": "proto",
  "lc-lmdh": "lmdh",
  "nissan-r33-jgtc": "classic",
  "nissan-r32-jtcc": "classic",
  "bmw-m1-procar": "classic",
  "chaparral-2d": "classic",
  "chaparral-2d-67": "classic",
  "porsche-934-rsr": "classic",
};

/** A model's body kind; an open-wheeler's when the model isn't known (a peer's car from a newer build) */
export const bodyKindOf = (vehicle: VehicleModelId | undefined): BodyKind => (vehicle && BODY_KIND[vehicle]) || "f1";
