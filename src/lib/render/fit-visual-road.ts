import * as THREE from "three";
import { createGroundHit, type GroundQuery } from "@/lib/sim/f12026-car/TrackColliderQuery";

/**
 * The nearest `userData[key]` on `obj` or its ancestors below `root`: glTF node extras land on the node, and the
 * meshes under it inherit nothing
 */
export function inheritedTag<T = unknown>(obj: THREE.Object3D, key: string, root?: THREE.Object3D): T | undefined {
  for (let node: THREE.Object3D | null = obj; node && node !== root; node = node.parent) {
    const v = node.userData?.[key];
    if (v !== undefined && v !== null && v !== false) return v as T;
  }
  return undefined;
}

/** How far above or below the fitted ground a visual vertex may be and still belong to the road (m) */
const FIT_WINDOW_M = 0.32;
/** Decals and grooves sit this far above the road they are laid on (m) */
const OVERLAY_LIFT_M = 0.002;

const fitted = new WeakSet<THREE.Object3D>();

/**
 * Lays a converted circuit's visual road (`Track_Model`) onto its fitted ground, so the drawn road follows the
 * colliders across crests and compressions and the wheels sit on what the player sees. Grass is left as modelled.
 */
export function fitVisualRoad(root: THREE.Object3D, ground: GroundQuery): void {
  if (fitted.has(root)) return;
  fitted.add(root);
  const tm = root.getObjectByName("Track_Model");
  if (!tm) return;
  root.updateMatrixWorld(true);
  const hit = createGroundHit();
  const inv = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const seen = new Set<THREE.BufferGeometry>();
  tm.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.geometry || seen.has(o.geometry)) return;
    seen.add(o.geometry);
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    const lift = inheritedTag(o, "decal", root) || inheritedTag(o, "groove", root) ? OVERLAY_LIFT_M : 0;
    inv.copy(o.matrixWorld).invert();
    let dirty = false;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (!ground.query(v.x, v.z, v.y + FIT_WINDOW_M, hit) || hit.surface === "grass" || !(Math.abs(v.y - hit.height) < FIT_WINDOW_M)) continue;
      v.y = hit.height + lift;
      v.applyMatrix4(inv);
      pos.setXYZ(i, v.x, v.y, v.z);
      dirty = true;
    }
    if (dirty) pos.needsUpdate = true;
  });
}
