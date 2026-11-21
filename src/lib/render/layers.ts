import type * as THREE from "three";

/**
 * Render layer of the driver's helmet. The main camera leaves it out in the cockpit view (the eye point sits
 * inside the helmet), while the sun's shadow camera always includes it, so the head still shadows the cockpit
 * and the halo. The mirror cameras keep their default layers and never see it.
 */
export const DRIVER_HEAD_LAYER = 8;

/**
 * Render layer of shadow-only stand-ins: geometry the sun's shadow camera draws and no view or mirror camera does
 * (the instanced trees' middle distance casts with its lighter level's crowns; scenery-instances.ts).
 */
export const SHADOW_PROXY_LAYER = 9;

/**
 * Render layer of driving aids drawn on the world (the racing line): the view camera draws them, the cars' reflection
 * probe and the mirrors do not, so the bright line is never reflected in the bodywork
 */
export const OVERLAY_LAYER = 10;

/**
 * Render layer of close-range detail seen by the main view camera only (tyre contact wedges, opponent brake drums,
 * cockpit harness and driver figure). The sun's shadow camera, car reflection probe and mirrors leave it out.
 */
export const DETAIL_LAYER = 11;

/** Puts `root` and everything under it on the driver-head layer only (three's layers are not inherited) */
export function moveToDriverHeadLayer(root: THREE.Object3D): void {
  root.traverse((obj) => obj.layers.set(DRIVER_HEAD_LAYER));
}

/** Puts `root` and everything under it on the view-only detail layer (three's layers are not inherited) */
export function moveToDetailLayer(root: THREE.Object3D): void {
  root.traverse((obj) => obj.layers.set(DETAIL_LAYER));
}
