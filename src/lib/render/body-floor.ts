import * as THREE from "three";
import type { CarPhysicsConfig } from "@/lib/sim/f12026-car/F12026CarConfig";

/**
 * The vehicle model's floor underside at rest in the car frame (the rig's axes: origin on the road under the CG, +Z
 * forward): its height at the front and rear axles, where the aero reads its ride heights (the ride-height map's
 * pickups, else the floor plane). The car frame pitches with the body, so a car whose static rake comes from its
 * target ride heights has a level floor here.
 */
export interface StaticFloor {
  frontAxleZ: number;
  rearAxleZ: number;
  frontY: number;
  rearY: number;
}

export function staticFloorOf(config: Pick<CarPhysicsConfig, "chassis" | "aero">): StaticFloor {
  const { wheelbase, frontWeightFraction, cgHeight } = config.chassis;
  const { rhMap, floorOffsetY } = config.aero;
  return {
    frontAxleZ: wheelbase * (1 - frontWeightFraction),
    rearAxleZ: -wheelbase * frontWeightFraction,
    frontY: cgHeight + (rhMap?.frontPickupY ?? floorOffsetY),
    rearY: cgHeight + (rhMap?.rearPickupY ?? floorOffsetY),
  };
}

/** Faces this close to level (|normal.y|, ≈26°) are floor candidates */
const LEVEL_NORMAL_Y = 0.9;
/**
 * The drawn floor is the lowest this much level area between the axles (m²): a fifth of a plank, so a strake,
 * fence or duct edge lower than the floor does not set it
 */
export const FLOOR_AREA_M2 = 0.1;
/** Level faces are split into pieces of about this area (m²), so a long raked panel counts at the height of each part */
const PIECE_M2 = 0.002;
const MAX_SPLIT = 16;

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * How far (m) a drawn body's floor sits above the vehicle model's (`floor`, at rest): the height over the physics
 * floor line of the lowest `FLOOR_AREA_M2` of near-level faces under `body` between the drawn axles (`frontAxleZ`,
 * `rearAxleZ`), all in the car frame through `toCar` (world → car frame). Lowering the body by this puts its floor on
 * the one the physics drives on; negative raises it. Null when the body has less level area than that between its
 * axles.
 */
export function bodyFloorClearance(
  body: THREE.Object3D,
  toCar: THREE.Matrix4,
  frontAxleZ: number,
  rearAxleZ: number,
  floor: StaticFloor
): number | null {
  const slope = (floor.frontY - floor.rearY) / (floor.frontAxleZ - floor.rearAxleZ);
  const floorY = (z: number) => floor.rearY + slope * (z - floor.rearAxleZ);
  const gaps: number[] = [];
  const areas: number[] = [];

  body.updateWorldMatrix(true, true);
  body.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) return;
    _m.multiplyMatrices(toCar, mesh.matrixWorld);
    const p = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      p[3 * i] = _v.x;
      p[3 * i + 1] = _v.y;
      p[3 * i + 2] = _v.z;
    }
    const index = mesh.geometry.index;
    const tris = index ? index.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const a = 3 * (index ? index.getX(3 * t) : 3 * t);
      const b = 3 * (index ? index.getX(3 * t + 1) : 3 * t + 1);
      const c = 3 * (index ? index.getX(3 * t + 2) : 3 * t + 2);
      const z0 = p[a + 2], z1 = p[b + 2], z2 = p[c + 2];
      if (Math.max(z0, z1, z2) < rearAxleZ || Math.min(z0, z1, z2) > frontAxleZ) continue;
      // Normal (unnormalised: twice the area) from the edges
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = z1 - z0;
      const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = z2 - z0;
      const nx = uy * wz - uz * wy;
      const ny = uz * wx - ux * wz;
      const nz = ux * wy - uy * wx;
      const n = Math.hypot(nx, ny, nz);
      if (n === 0 || Math.abs(ny) < LEVEL_NORMAL_Y * n) continue;
      // Height over the physics floor is linear on the face: split it into k² equal pieces, each at its centroid
      const g0 = p[a + 1] - floorY(z0);
      const g1 = p[b + 1] - floorY(z1);
      const g2 = p[c + 1] - floorY(z2);
      const flat = 0.5 * Math.abs(ny);
      const k = Math.min(MAX_SPLIT, Math.max(1, Math.ceil(Math.sqrt(flat / PIECE_M2))));
      const piece = flat / (k * k);
      const add = (s: number, r: number) => {
        const z = z0 + (z1 - z0) * s + (z2 - z0) * r;
        if (z > frontAxleZ || z < rearAxleZ) return;
        gaps.push(g0 + (g1 - g0) * s + (g2 - g0) * r);
        areas.push(piece);
      };
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k - i; j++) {
          add((i + 1 / 3) / k, (j + 1 / 3) / k);
          if (j < k - i - 1) add((i + 2 / 3) / k, (j + 2 / 3) / k);
        }
      }
    }
  });

  const order = gaps.map((_, i) => i).sort((i, j) => gaps[i] - gaps[j]);
  let area = 0;
  for (const i of order) {
    area += areas[i];
    if (area >= FLOOR_AREA_M2) return gaps[i];
  }
  return null;
}
