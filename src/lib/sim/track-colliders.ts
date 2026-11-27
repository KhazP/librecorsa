import * as THREE from 'three';
import { getActiveSurfaceTable, getActiveTrackData, getActiveTrackMetadata } from '@/lib/track-data';
import {
  createGroundHit,
  pitLaneWallExcluder,
  TrackColliderQuery,
  TrackWallQuery,
  type PitLaneWallMask,
  type RoadFacing,
  type TrackColliderBuffers,
  type TrackWallBuffers,
} from './f12026-car/TrackColliderQuery';
import { applyDrawnSurfaceRules } from './drawn-surfaces';

export interface TrackColliders {
  /** Null when the GLB has no `Track_Collider_Road`: the cars stay on the track samples' ground */
  ground: TrackColliderQuery | null;
  walls: TrackWallQuery;
  /** The circuit's surfaces were fitted to its road (`metadata.mesh.conformSurfaces`); the scene fits its road too */
  conformSurfaces: boolean;
}

const cache = new WeakMap<THREE.Object3D, TrackColliders>();

/**
 * A face at (x, z) faces the road when its normal points from it toward the active circuit's centreline, within 60°:
 * a drawn block's end, square to the road, would push a car pressed into it back along the road a metre at a step
 */
export const roadFacing: RoadFacing = (x, z, nx, nz) => {
  const { sample, lateralOffset } = getActiveTrackData(1200).projectWorldToTrack(x, z);
  const b = sample.binormal;
  const bl = Math.hypot(b.x, b.z) || 1;
  return (-Math.sign(lateralOffset) * (nx * b.x + nz * b.z)) / bl > 0.5;
};

/**
 * Bridges any ground-collider holes along a circuit's pit lane (e.g. where `Track_Surface_Runoff` was clipped by a
 * barrier step-out at Watkins Glen pit entry/exit). Only emits quads over spans where the existing collider has no
 * ground, linearly interpolating height from the real ground on both sides (seated 1 cm under the real surface at the
 * ends so it never protrudes over existing asphalt). Returns null when the pit lane is already fully grounded.
 */
function buildPitLaneGapBridge(
  ground: TrackColliderQuery,
  pitLane: (PitLaneWallMask & { readonly py: ArrayLike<number>; readonly corridorM: number }) | null | undefined
): THREE.Mesh | null {
  if (!pitLane || pitLane.px.length < 2) return null;
  const { px, py, pz, cum, leaveM, rejoinM } = pitLane;
  const n = px.length;
  const startM = Math.max(0, leaveM - 10);
  const endM = Math.min(cum[n - 1], rejoinM + 10);
  const idxs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cum[i] >= startM - 2 && cum[i] <= endM + 2) idxs.push(i);
  }
  const mCount = idxs.length;
  if (mCount < 2) return null;

  const hit = createGroundHit();
  const heights = new Float64Array(mCount);
  const missing = new Uint8Array(mCount);
  let holeCount = 0;
  for (let k = 0; k < mCount; k++) {
    const i = idxs[k];
    if (ground.query(px[i], pz[i], py[i] + 3, hit)) {
      heights[k] = hit.height;
    } else {
      missing[k] = 1;
      holeCount++;
    }
  }
  if (holeCount === 0) return null;

  // Fill each missing height by interpolating from the nearest grounded pit samples before and after
  for (let k = 0; k < mCount; k++) {
    if (!missing[k]) continue;
    let prev = k - 1;
    while (prev >= 0 && missing[prev]) prev--;
    let next = k + 1;
    while (next < mCount && missing[next]) next++;
    if (prev >= 0 && next < mCount) {
      const u = (cum[idxs[k]] - cum[idxs[prev]]) / Math.max(1e-6, cum[idxs[next]] - cum[idxs[prev]]);
      heights[k] = heights[prev] + (heights[next] - heights[prev]) * u;
    } else if (prev >= 0) {
      heights[k] = heights[prev] + (py[idxs[k]] - py[idxs[prev]]);
    } else if (next < mCount) {
      heights[k] = heights[next] + (py[idxs[k]] - py[idxs[next]]);
    } else {
      heights[k] = py[idxs[k]];
    }
  }

  // Emit bridge quads covering each missing segment plus 1 grounded sample overlap on both ends
  const halfW = Math.max(4.5, Math.min(6.5, pitLane.corridorM));
  const pos: number[] = [];
  for (let k = 0; k + 1 < mCount; k++) {
    const nearHole =
      missing[k] ||
      missing[k + 1] ||
      (k > 0 && missing[k - 1]) ||
      (k + 2 < mCount && missing[k + 2]);
    if (!nearHole) continue;
    const i0 = idxs[k];
    const i1 = idxs[k + 1];
    const tx = px[i1] - px[i0];
    const tz = pz[i1] - pz[i0];
    const len = Math.hypot(tx, tz) || 1;
    // Right normal in XZ
    const rx = -tz / len;
    const rz = tx / len;
    const y0 = heights[k] - (missing[k] ? 0 : 0.015);
    const y1 = heights[k + 1] - (missing[k + 1] ? 0 : 0.015);
    const aLx = px[i0] - rx * halfW;
    const aLz = pz[i0] - rz * halfW;
    const aRx = px[i0] + rx * halfW;
    const aRz = pz[i0] + rz * halfW;
    const bLx = px[i1] - rx * halfW;
    const bLz = pz[i1] - rz * halfW;
    const bRx = px[i1] + rx * halfW;
    const bRz = pz[i1] + rz * halfW;
    pos.push(aLx, y0, aLz, bLx, y1, bLz, bRx, y1, bRz);
    pos.push(aLx, y0, aLz, bRx, y1, bRz, aRx, y0, aRz);
  }
  if (pos.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geom);
  mesh.name = 'Track_Surface_Pitlane_Bridge';
  mesh.visible = false;
  mesh.userData = { surface: 'pitlane' };
  return mesh;
}

/**
 * The active circuit's ground and barrier colliders for its loaded track root, built once and shared by the scene,
 * every car model and the AI field
 */
export function trackColliders(root: THREE.Object3D): TrackColliders {
  let colliders = cache.get(root);
  if (!colliders) {
    const mesh = getActiveTrackMetadata().mesh;
    const conformSurfaces = mesh?.conformSurfaces === true;
    const track = getActiveTrackData(1200);
    // A GLB without a road collider (none of the shipped circuits) leaves the cars on the track samples' ground
    let ground = root.getObjectByName('Track_Collider_Road')
      ? TrackColliderQuery.fromTrackRoot(root, getActiveSurfaceTable(), {
          conformSurfaces,
          // Where the circuit's drawn surfaces say what its physics got wrong (drawn-surfaces.ts)
          prepare: (r) => applyDrawnSurfaceRules(r, track, mesh?.roadMaterials, undefined, getActiveSurfaceTable()),
        })
      : null;
    if (ground && track.pitLane) {
      const bridge = buildPitLaneGapBridge(ground, track.pitLane);
      if (bridge) {
        root.add(bridge);
        ground = TrackColliderQuery.fromTrackRoot(root, getActiveSurfaceTable(), {
          // Already conformed and prepared above; rebuild spatial grid with the pit-lane gap bridge included
          conformSurfaces,
          skipConformPass: true,
        });
        root.remove(bridge);
      }
    }
    colliders = {
      ground,
      walls: TrackWallQuery.fromTrackRoot(root, mesh?.barrierMeshes, roadFacing, pitLaneWallExcluder(track.pitLane)),
      conformSurfaces,
    };
    cache.set(root, colliders);
  }
  return colliders;
}

/** A circuit's colliders as plain data, to hand to another thread (`trackRootFromColliderData` rebuilds them there) */
export interface TrackColliderData {
  ground: TrackColliderBuffers | null;
  walls: TrackWallBuffers;
  conformSurfaces: boolean;
}

export function trackColliderData(root: THREE.Object3D): TrackColliderData {
  const { ground, walls, conformSurfaces } = trackColliders(root);
  return { ground: ground ? ground.toBuffers() : null, walls: walls.toBuffers(), conformSurfaces };
}

/**
 * A stand-in for the track's mesh where there is none (the simulation worker): cars attach to it as they do to the
 * loaded track root, and drive on the colliders rebuilt from `data`
 */
export function trackRootFromColliderData(data: TrackColliderData): THREE.Object3D {
  const root = new THREE.Object3D();
  cache.set(root, {
    ground: data.ground ? TrackColliderQuery.fromBuffers(data.ground) : null,
    walls: TrackWallQuery.fromBuffers(data.walls),
    conformSurfaces: data.conformSurfaces,
  });
  return root;
}
