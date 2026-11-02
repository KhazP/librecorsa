import type * as THREE from "three";

/**
 * Render layer of the driver's helmet. The main camera leaves it out in the cockpit view (the eye point sits
 * inside the helmet), while the sun's shadow camera always includes it, so the head still shadows the cockpit
 * and the halo. The mirror cameras keep their default layers and never see it.
 */
export const DRIVER_HEAD_LAYER = 8;

/** Puts `root` and everything under it on the driver-head layer only (three's layers are not inherited) */
export function moveToDriverHeadLayer(root: THREE.Object3D): void {
  root.traverse((obj) => obj.layers.set(DRIVER_HEAD_LAYER));
}
