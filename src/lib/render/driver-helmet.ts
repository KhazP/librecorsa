import * as THREE from "three";
import { moveToDriverHeadLayer } from "./layers";
import { applyPaintFinish, SATIN_PAINT } from "./paint-finish";

/**
 * The driver's helmet for a car body without a driver of its own (the 2026 Prototype's): an aero shell in the livery's
 * primary colour, a secondary band and chin, an accent stripe over the crown, a mirrored visor and the HANS collar.
 * Plain geometry with no lettering. Centred on its origin: +X left, +Y up, +Z forward.
 *
 * It sits on the driver-head layer, so the cockpit view leaves it out while it still shadows the cockpit.
 */
export interface DriverHelmet {
  group: THREE.Group;
  setColours: (primary: string, secondary: string, accent: string) => void;
  dispose: () => void;
}

/** Shell radii (m): a little narrower than long, like a race helmet */
const R = 0.134;
const SCALE = new THREE.Vector3(0.95, 1.0, 1.1);

export function createDriverHelmet(): DriverHelmet {
  const group = new THREE.Group();
  group.name = "DRIVER_HELMET";
  const paint = (hex: number) => {
    const m = new THREE.MeshPhysicalMaterial({ color: hex });
    applyPaintFinish(m, SATIN_PAINT);
    return m;
  };
  const primary = paint(0x00a1de);
  const secondary = paint(0x0f172a);
  const accent = paint(0xfad201);
  const visorMat = new THREE.MeshPhysicalMaterial({
    color: 0x101418,
    metalness: 0.9,
    roughness: 0.06,
    clearcoat: 1,
  });
  const collarMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 });
  const geometries: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, scaled = true) => {
    geometries.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    if (scaled) mesh.scale.copy(SCALE);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Shell, open at the neck
  add(new THREE.SphereGeometry(R, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.78), primary);
  // Accent stripe front to back over the crown
  add(new THREE.SphereGeometry(R * 1.004, 8, 24, Math.PI * 0.5 - 0.09, 0.18, 0, Math.PI * 0.62), accent);
  // Band around the lower shell and the chin bar
  add(new THREE.SphereGeometry(R * 1.003, 32, 6, 0, Math.PI * 2, Math.PI * 0.6, Math.PI * 0.16), secondary);
  // Visor: a window on +Z (phi = pi / 2 faces +Z in three's sphere)
  add(new THREE.SphereGeometry(R * 1.008, 24, 10, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.19), visorMat);
  // HANS collar on the shoulders
  const collar = add(new THREE.TorusGeometry(0.105, 0.03, 10, 28, Math.PI * 1.4), collarMat, false);
  collar.rotation.set(Math.PI / 2, 0, Math.PI * 0.8);
  collar.position.set(0, -0.125, -0.02);

  moveToDriverHeadLayer(group);

  return {
    group,
    setColours: (p, s, a) => {
      primary.color.set(p);
      secondary.color.set(s);
      accent.color.set(a);
    },
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of [primary, secondary, accent, visorMat, collarMat]) m.dispose();
      group.removeFromParent();
    },
  };
}
