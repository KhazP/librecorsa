import * as THREE from "three";
import type { VehicleModelId } from "@/types/f1";

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
  ctx.filter = "blur(14px)";
  ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
  const m = 30;
  ctx.beginPath();
  ctx.roundRect(m, m * 0.8, size - 2 * m, size - 1.6 * m, 18);
  ctx.fill();
  texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

/** Footprint (length, width in m) of each car model, a little larger than its floor */
const FOOTPRINT: Record<"f1" | "gt3", [number, number]> = { f1: [6.4, 2.6], gt3: [5.6, 2.7] };

/**
 * Adds the contact shadow under a car rig whose root sits at ground level (`SimulatorCar.worldPosition`), facing
 * along its +Z. Returns the shadow mesh (removed with the rig).
 */
export function addContactShadow(root: THREE.Object3D, vehicle: VehicleModelId | undefined): THREE.Mesh | null {
  const map = shadowTexture();
  if (!map) return null;
  const [len, wid] = FOOTPRINT[vehicle === "amg-gt3" ? "gt3" : "f1"];
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(wid, len),
    new THREE.MeshBasicMaterial({
      map,
      color: 0x000000,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: false,
    })
  );
  mesh.name = "ContactShadow";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.012;
  mesh.renderOrder = -1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  root.add(mesh);
  return mesh;
}
