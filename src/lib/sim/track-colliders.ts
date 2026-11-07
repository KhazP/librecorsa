import type * as THREE from 'three';
import { getActiveSurfaceTable, getActiveTrackMetadata } from '@/lib/track-data';
import { TrackColliderQuery, TrackWallQuery } from './f12026-car/TrackColliderQuery';

export interface TrackColliders {
  /** Null when the GLB has no `Track_Collider_Road`: the cars stay on the track samples' ground */
  ground: TrackColliderQuery | null;
  walls: TrackWallQuery;
  /** The circuit's surfaces were fitted to its road (`metadata.mesh.conformSurfaces`); the scene fits its road too */
  conformSurfaces: boolean;
}

const cache = new WeakMap<THREE.Object3D, TrackColliders>();

/**
 * The active circuit's ground and barrier colliders for its loaded track root, built once and shared by the scene,
 * every car model and the AI field
 */
export function trackColliders(root: THREE.Object3D): TrackColliders {
  let colliders = cache.get(root);
  if (!colliders) {
    const conformSurfaces = getActiveTrackMetadata().mesh?.conformSurfaces === true;
    // A GLB without a road collider (none of the shipped circuits) leaves the cars on the track samples' ground
    const ground = root.getObjectByName('Track_Collider_Road')
      ? TrackColliderQuery.fromTrackRoot(root, getActiveSurfaceTable(), { conformSurfaces })
      : null;
    colliders = { ground, walls: TrackWallQuery.fromTrackRoot(root), conformSurfaces };
    cache.set(root, colliders);
  }
  return colliders;
}
