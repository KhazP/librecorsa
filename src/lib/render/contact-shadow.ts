import * as THREE from "three";
import type { VehicleModelId } from "@/types/f1";
import { seatCorner, type WheelSeating } from "./corner-rig";

/**
 * A soft dark footprint under a car, on every graphics preset: the sun's shadow map is too coarse to darken the road
 * right under the floor (and is off on Low), so cars look pasted onto the track. Racing games ground their cars the
 * same way, with a blurred "contact shadow" decal that moves with them. One texture for every car.
 */
let texture: THREE.CanvasTexture | null = null;

function shadowTexture(): THREE.CanvasTexture | null {
  if (texture) return texture;
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A rounded rectangle, blurred well into the margin: dark under the floor, gone by the edge of the quad
  const m = 30;
  // Typed as always present, but missing from canvases in older Safari
  if (typeof (ctx as { filter?: unknown }).filter === "string") {
    ctx.filter = "blur(14px)";
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.beginPath();
    ctx.roundRect(m, m * 0.8, size - 2 * m, size - 1.6 * m, 18);
    ctx.fill();
  } else {
    // No canvas filter (older Safari): build the falloff from stacked, growing, faint rounded rectangles instead
    const steps = 14;
    for (let i = steps; i >= 0; i--) {
      const grow = (i / steps) * 22 - 8;
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.85 / steps) * 1.15})`;
      ctx.beginPath();
      ctx.roundRect(m - grow, m * 0.8 - grow, size - 2 * m + 2 * grow, size - 1.6 * m + 2 * grow, 18 + Math.max(0, grow));
      ctx.fill();
    }
  }
  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const geometries = new Map<"f1" | "gt3" | "road", THREE.PlaneGeometry>();
let material: THREE.MeshBasicMaterial | null = null;

/** Footprint (length, width in m) of each car model, a little larger than its floor */
const FOOTPRINT: Record<"f1" | "gt3" | "road", [number, number]> = { f1: [6.4, 2.6], gt3: [5.6, 2.7], road: [5.1, 2.5] };

/** The shadow sits this far above the road under the car (m), clear of its z-fighting */
const LIFT_M = 0.012;

/**
 * Adds the contact shadow under a car rig, facing along its +Z, on the rig root's origin plane until
 * `seatContactShadow` puts it on the road. Returns the shadow mesh (removed with the rig).
 */
export function addContactShadow(root: THREE.Object3D, vehicle: VehicleModelId | undefined): THREE.Mesh | null {
  const map = shadowTexture();
  if (!map) return null;
  const kind = vehicle === "amg-gt3" ? "gt3" : vehicle === "liana" ? "road" : "f1";
  // One quad per car model and one material for all of them, rather than a fresh pair per rig
  let geometry = geometries.get(kind);
  if (!geometry) {
    const [len, wid] = FOOTPRINT[kind];
    geometry = new THREE.PlaneGeometry(wid, len);
    geometries.set(kind, geometry);
  }
  material ??= new THREE.MeshBasicMaterial({
    map,
    color: 0x000000,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ContactShadow";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = LIFT_M;
  mesh.renderOrder = -1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);
  root.userData.contactShadow = mesh;
  return mesh;
}

/**
 * Per frame: puts a rig's contact shadow on the road under the car's centre, as `updateCorners` does its wheels. The
 * rig root is the car frame, which on the rigid-body model rides on the sprung body (its CG less the static CG
 * height): it sinks 20-35 mm under the road with downforce and rises over kerbs, and a shadow left on it went under
 * the asphalt, so the car looked like it hovered. The physics' tyre contacts give the first estimate (their mean
 * height in the car frame), the car's ground the road itself. Without `wheels` (a remote player, the ghost) the
 * shadow stays on the root's origin plane.
 */
export function seatContactShadow(root: THREE.Object3D, wheels?: WheelSeating): void {
  const mesh = root.userData.contactShadow as THREE.Mesh | undefined;
  if (!mesh) return;
  let contactY = 0;
  const tyres = wheels?.tyres;
  if (tyres?.length) {
    let n = 0;
    for (const t of tyres) {
      if (!t.contactInCar) continue;
      contactY += t.contactInCar.y;
      n++;
    }
    if (n) contactY /= n;
  }
  const roadY = wheels ? seatCorner(wheels.ground, wheels.position, wheels.quaternion, 0, 0, contactY, true) : 0;
  mesh.position.y = roadY + LIFT_M;
}
