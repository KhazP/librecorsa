import * as THREE from "three";

/**
 * Per-frame CPU savings for scene content that does not move or change (a CPU profile of a GT3 race had three.js'
 * matrix updates and shader-program lookups among its largest costs).
 */

/**
 * Draws a transparent double-sided material in one pass. three.js otherwise renders it twice (back faces, then front)
 * and flags the material for a program rebuild before each, so every draw re-ran its shader-program lookup: the GT3's
 * glass, calliper badges and grilles (shared by every GT3 in a race) and the scans' blended decals were most of the
 * ~200 lookups a frame. The cost is the back faces' sort order within one object, which glass and decals don't show.
 */
export function singlePassTransparency(material: THREE.Material): void {
  if (material.transparent && material.side === THREE.DoubleSide) material.forceSinglePass = true;
}

/**
 * Fixes the transforms of a subtree that never moves (the circuit, its scenery) at their current values and takes it
 * out of the per-frame matrix update: three.js otherwise recomputes every object's world matrix on every render call
 * (the main view, the reflection probe, the mirrors). Call again after adding or moving anything inside it.
 */
export function freezeStaticTransforms(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    obj.matrixAutoUpdate = false;
  });
  root.matrixWorldAutoUpdate = false;
}
