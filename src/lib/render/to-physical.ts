import * as THREE from "three";

/**
 * A MeshPhysicalMaterial copy of a glTF standard (or physical) material: every field three.js copies, so nothing
 * is lost by keeping a hand-written field list in step. The source is left alone (it may be shared); userData is a
 * shallow copy, not three's JSON round trip, so non-JSON entries survive.
 */
export function toPhysical(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const dst = new THREE.MeshPhysicalMaterial();
  if ((src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    dst.copy(src as THREE.MeshPhysicalMaterial);
  } else {
    THREE.MeshStandardMaterial.prototype.copy.call(dst, src);
    // MeshStandardMaterial.copy() resets the defines to STANDARD only
    dst.defines = { STANDARD: "", PHYSICAL: "" };
  }
  dst.userData = { ...src.userData };
  return dst;
}
