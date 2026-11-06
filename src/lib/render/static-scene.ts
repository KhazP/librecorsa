import * as THREE from "three";

/**
 * Per-frame CPU savings for scene content (a CPU profile of a GT3 race had three.js' shader-program lookups among its
 * largest costs).
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
