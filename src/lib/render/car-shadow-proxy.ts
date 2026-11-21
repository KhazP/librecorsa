import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { VehicleModelId } from "@/types/f1";
import { SHADOW_PROXY_LAYER } from "./layers";

/**
 * One-draw shadow stand-ins for opponent cars (`SHADOW_PROXY_LAYER`, already enabled on `sunLight.shadow.camera.layers`).
 *
 * Opponent rigs otherwise cast shadows with all ~60 detailed sub-meshes (~200k triangles each) into both sun shadow
 * cascades, turning a 12-car grid into 1,000+ shadow draws and 3-4M shadow triangles per frame. Replacing an opponent's
 * mesh shadow casting with one ~160-triangle hull+wheels silhouette collapses opponent shadow cost to 1 draw per visible
 * car per cascade while keeping grounded car shadows on the road.
 *
 * `shadowSide = THREE.BackSide` on a closed proxy avoids front-face self-shadowing onto the opponent's own curved
 * visual bodywork while casting full shadows onto the track and neighbouring cars.
 */

type ProxyKind = "f1" | "gt3" | "road" | "proto" | "lmdh" | "classic";

const geometries = new Map<ProxyKind, THREE.BufferGeometry>();
let material: THREE.MeshBasicMaterial | null = null;

function proxyKindFor(vehicle: VehicleModelId | undefined): ProxyKind {
  if (vehicle === "amg-gt3") return "gt3";
  if (vehicle === "liana" || vehicle === "vw-scirocco-gtx") return "road";
  if (vehicle === "mtr-496r") return "proto";
  if (vehicle === "lc-lmdh") return "lmdh";
  if (
    vehicle === "nissan-r33-jgtc" ||
    vehicle === "nissan-r32-jtcc" ||
    vehicle === "bmw-m1-procar" ||
    vehicle === "chaparral-2d" ||
    vehicle === "chaparral-2d-67" ||
    vehicle === "porsche-934-rsr"
  ) {
    return "classic";
  }
  return "f1";
}

/** Closed box centred at (x, y, z) with full dimensions (w, h, l) in car rig axes (+X left, +Y up, +Z nose) */
function boxPart(w: number, h: number, l: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y, z);
  return g;
}

/** Low-poly wheel cylinder aligned along X (axle), resting on y = 0 */
function wheelPart(radius: number, width: number, x: number, z: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, width, 8, 1);
  g.rotateZ(Math.PI / 2);
  g.translate(x, radius, z);
  return g;
}

function buildProxyGeometry(kind: ProxyKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === "f1") {
    // 2026 F1 silhouette: wheelbase 3.40 m (front axle +1.86, rear -1.54), tyres R=0.349
    parts.push(
      // Low floor & plank
      boxPart(1.48, 0.12, 3.3, 0, 0.14, -0.15),
      // Sidepods (slightly inset from curved outer bodywork)
      boxPart(1.36, 0.36, 2.0, 0, 0.36, -0.35),
      // Tapered nose & survival cell
      boxPart(0.56, 0.32, 2.15, 0, 0.36, 1.35),
      // Roll hoop, engine cover & shark fin
      boxPart(0.54, 0.5, 2.15, 0, 0.68, -0.6),
      // Front wing
      boxPart(1.76, 0.1, 0.45, 0, 0.16, 2.55),
      // Rear wing
      boxPart(0.94, 0.24, 0.32, 0, 0.82, -2.05),
      // Four wheels
      wheelPart(0.34, 0.30, 0.80, 1.86),
      wheelPart(0.34, 0.30, -0.80, 1.86),
      wheelPart(0.34, 0.39, 0.80, -1.54),
      wheelPart(0.34, 0.39, -0.80, -1.54),
    );
  } else {
    // Closed-wheel silhouettes dimensioned per vehicle class
    const spec: Record<
      Exclude<ProxyKind, "f1">,
      {
        bodyW: number;
        bodyH: number;
        bodyL: number;
        bodyY: number;
        cabinW: number;
        cabinH: number;
        cabinL: number;
        cabinY: number;
        cabinZ: number;
        wingW: number;
        wingY: number;
        wingZ: number;
        wheelR: number;
        wheelW: number;
        halfTrack: number;
        frontZ: number;
        rearZ: number;
      }
    > = {
      gt3: {
        bodyW: 1.9, bodyH: 0.56, bodyL: 4.55, bodyY: 0.42,
        cabinW: 1.38, cabinH: 0.46, cabinL: 2.0, cabinY: 0.9, cabinZ: -0.22,
        wingW: 1.78, wingY: 1.06, wingZ: -2.18,
        wheelR: 0.34, wheelW: 0.31, halfTrack: 0.86, frontZ: 1.37, rearZ: -1.28,
      },
      lmdh: {
        bodyW: 1.9, bodyH: 0.48, bodyL: 4.9, bodyY: 0.36,
        cabinW: 1.08, cabinH: 0.44, cabinL: 2.1, cabinY: 0.8, cabinZ: -0.1,
        wingW: 1.86, wingY: 0.96, wingZ: -2.25,
        wheelR: 0.34, wheelW: 0.32, halfTrack: 0.86, frontZ: 1.58, rearZ: -1.52,
      },
      proto: {
        bodyW: 1.78, bodyH: 0.46, bodyL: 4.5, bodyY: 0.34,
        cabinW: 1.04, cabinH: 0.4, cabinL: 1.85, cabinY: 0.74, cabinZ: -0.12,
        wingW: 1.7, wingY: 0.92, wingZ: -2.05,
        wheelR: 0.32, wheelW: 0.28, halfTrack: 0.8, frontZ: 1.38, rearZ: -1.32,
      },
      classic: {
        bodyW: 1.76, bodyH: 0.56, bodyL: 4.35, bodyY: 0.44,
        cabinW: 1.3, cabinH: 0.46, cabinL: 1.9, cabinY: 0.92, cabinZ: -0.18,
        wingW: 1.56, wingY: 0.98, wingZ: -2.0,
        wheelR: 0.32, wheelW: 0.27, halfTrack: 0.78, frontZ: 1.28, rearZ: -1.24,
      },
      road: {
        bodyW: 1.66, bodyH: 0.62, bodyL: 4.15, bodyY: 0.48,
        cabinW: 1.32, cabinH: 0.54, cabinL: 2.05, cabinY: 1.04, cabinZ: -0.12,
        wingW: 0, wingY: 0, wingZ: 0,
        wheelR: 0.31, wheelW: 0.21, halfTrack: 0.74, frontZ: 1.26, rearZ: -1.22,
      },
    };
    const s = spec[kind];
    parts.push(
      boxPart(s.bodyW, s.bodyH, s.bodyL, 0, s.bodyY, 0),
      boxPart(s.cabinW, s.cabinH, s.cabinL, 0, s.cabinY, s.cabinZ),
      wheelPart(s.wheelR, s.wheelW, s.halfTrack, s.frontZ),
      wheelPart(s.wheelR, s.wheelW, -s.halfTrack, s.frontZ),
      wheelPart(s.wheelR, s.wheelW, s.halfTrack, s.rearZ),
      wheelPart(s.wheelR, s.wheelW, -s.halfTrack, s.rearZ),
    );
    if (s.wingW > 0) parts.push(boxPart(s.wingW, 0.08, 0.3, 0, s.wingY, s.wingZ));
  }

  // Strip UVs and normals: the shadow pass only reads `position`
  const positionOnly = parts.map((g) => {
    const nonIdx = g.index ? g.toNonIndexed() : g;
    nonIdx.deleteAttribute("normal");
    nonIdx.deleteAttribute("uv");
    if (nonIdx !== g) g.dispose();
    return nonIdx;
  });
  const merged = mergeGeometries(positionOnly, false);
  for (const g of positionOnly) g.dispose();
  if (!merged) throw new Error(`car-shadow-proxy: failed to merge ${kind} silhouette`);
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Adds a 1-draw shadow-only silhouette to an opponent car rig on `SHADOW_PROXY_LAYER`.
 * Invisible to the view, probe, and mirror cameras; seen only by the sun's cascaded shadow map.
 */
export function addCarShadowProxy(root: THREE.Object3D, vehicle: VehicleModelId | undefined): THREE.Mesh {
  const kind = proxyKindFor(vehicle);
  let geometry = geometries.get(kind);
  if (!geometry) {
    geometry = buildProxyGeometry(kind);
    geometries.set(kind, geometry);
  }
  material ??= new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    shadowSide: THREE.BackSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "CarShadowProxy";
  mesh.layers.set(SHADOW_PROXY_LAYER);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = true;
  root.add(mesh);
  return mesh;
}

/** Disables shadow casting on every mesh in `root` (except any `SHADOW_PROXY_LAYER` proxy) */
export function disableCarCastShadow(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.name === "CarShadowProxy") return;
    mesh.castShadow = false;
  });
}
