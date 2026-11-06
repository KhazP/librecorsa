import * as THREE from "three";

/** A world-space box `[minX, minY, minZ, maxX, maxY, maxZ]` (m) of scan geometry to leave out (track data `mesh.cutBoxes`) */
export type SceneryCutBox = readonly [number, number, number, number, number, number];

/**
 * Whether a scan mesh is drawn only in materials the track data leaves out (`mesh.cutMaterials`): a structure the scan
 * draws in its own material, which no box can separate from the road it dips into
 */
export function isCutMaterialMesh(mesh: THREE.Mesh, materials: ReadonlySet<string>): boolean {
  if (!materials.size) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.every((m) => materials.has(m.name));
}

/**
 * Drops the triangles of a scan mesh whose world-space centroid lies in any of the boxes: for structures a circuit
 * scan places on the racing line (Yas Marina's gantry and bollard row between T2 and T3). Returns the
 * number of triangles removed; the mesh is left untouched when none are.
 */
export function cutSceneryBoxes(mesh: THREE.Mesh, boxes: readonly SceneryCutBox[]): number {
  if (!boxes.length) return 0;
  const geom = mesh.geometry;
  const pos = geom.attributes.position as THREE.BufferAttribute | undefined;
  if (!pos) return 0;
  mesh.updateWorldMatrix(true, false);
  const world = new THREE.Box3().copy((geom.boundingBox ?? (geom.computeBoundingBox(), geom.boundingBox!))).applyMatrix4(mesh.matrixWorld);
  const hit = boxes.filter(
    (b) => world.min.x <= b[3] && world.max.x >= b[0] && world.min.y <= b[4] && world.max.y >= b[1] && world.min.z <= b[5] && world.max.z >= b[2]
  );
  if (!hit.length) return 0;

  const index = geom.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const vertex = (k: number) => (index ? index.getX(k) : k);
  const a = new THREE.Vector3();
  const c = new THREE.Vector3();
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < triCount; t++) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(a.fromBufferAttribute(pos, vertex(3 * t + k)));
    c.multiplyScalar(1 / 3).applyMatrix4(mesh.matrixWorld);
    if (hit.some((b) => c.x >= b[0] && c.x <= b[3] && c.y >= b[1] && c.y <= b[4] && c.z >= b[2] && c.z <= b[5])) {
      removed++;
      continue;
    }
    kept.push(vertex(3 * t), vertex(3 * t + 1), vertex(3 * t + 2));
  }
  if (!removed) return 0;
  // Groups index the old triangle list; the scans' meshes carry one material each, so they are dropped
  geom.clearGroups();
  geom.setIndex(kept);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return removed;
}
