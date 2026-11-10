import * as THREE from 'three';
import { getActiveSurfaceTable, getActiveTrackMetadata } from '@/lib/track-data';
import { TrackColliderQuery, TrackWallQuery, type TrackColliderBuffers, type TrackWallBuffers } from './f12026-car/TrackColliderQuery';

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
