import * as THREE from "three";
import { patchShader } from "./shader-patch";

/**
 * Objects drifting over a converted circuit: the hot-air balloons and the blimp of an Assetto Corsa mod's
 * `DYNAMIC_OBJECT_n` (scripts/tracks/port_ac_track.py, `driftingObjects`). The converter draws each at its centre and
 * tags its vertices with a slot (the `_DRIFT` attribute: (slot + 0.5) / DRIFT_SLOTS); the mesh node's `drift` extras
 * give each slot's ranges as the mod sets them.
 *
 * They move as Assetto Corsa moves them: each starts at a random offset within ±`range` of its centre and goes in a
 * straight line for the whole session at `velBase` plus a random ±`velRange` (m, m/s, per axis). A session here is a
 * circuit load. The random values come from a fixed seed per slot, so every load starts the same way.
 *
 * The offset is added in the vertex shader from one uniform array per mesh: no matrix updates, and a fleet of balloons
 * over one atlas stays one draw call. They cast no shadow (the converter sets `castShadow: false`), and they are
 * never culled, as they drift without bound.
 */

/** Slots in the table (scripts/tracks/port_ac_track.py DRIFT_SLOTS) */
export const DRIFT_SLOTS = 32;

interface DriftSpec {
  slot: number;
  range: number[];
  velBase: number[];
  velRange: number[];
}

export interface DriftingObjects {
  /** How many objects drift */
  readonly count: number;
  /** Moves them to `seconds` (any clock; the first call is the session's start) */
  update(seconds: number): void;
}

/** mulberry32: a small seeded generator in [0, 1) */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isSpec(s: unknown): s is DriftSpec {
  const d = s as DriftSpec;
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  return (
    !!d &&
    Number.isInteger(d.slot) &&
    d.slot >= 0 &&
    d.slot < DRIFT_SLOTS &&
    vec(d.range) &&
    vec(d.velBase) &&
    vec(d.velRange)
  );
}

/** Start offset and velocity of one slot, as Assetto Corsa draws them */
function slotMotion(spec: DriftSpec): { start: THREE.Vector3; vel: THREE.Vector3 } {
  const rand = seeded(0x9e3779b9 ^ Math.imul(spec.slot + 1, 0x85ebca6b));
  const pm = () => rand() * 2 - 1;
  const start = new THREE.Vector3(spec.range[0] * pm(), spec.range[1] * pm(), spec.range[2] * pm());
  const vel = new THREE.Vector3(
    spec.velBase[0] + spec.velRange[0] * pm(),
    spec.velBase[1] + spec.velRange[1] * pm(),
    spec.velBase[2] + spec.velRange[2] * pm()
  );
  return { start, vel };
}

const VERTEX_PATCHES = [
  ["#include <common>", `#include <common>\nattribute float _drift;\nuniform vec3 uDriftOffset[${DRIFT_SLOTS}];`],
  [
    "#include <begin_vertex>",
    `#include <begin_vertex>\n\ttransformed += uDriftOffset[int(clamp(_drift * ${DRIFT_SLOTS}.0, 0.0, ${DRIFT_SLOTS - 1}.0))];`,
  ],
] as const;

/**
 * Finds the drifting objects under a loaded circuit and patches their materials; null when it has none. Call it once
 * the circuit's materials are final (after scene-builder's material pass), then `update` every frame.
 */
export function attachDriftingObjects(root: THREE.Object3D): DriftingObjects | null {
  const motion = new Map<number, { start: THREE.Vector3; vel: THREE.Vector3 }>();
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const list = obj.userData?.drift;
    if (!Array.isArray(list)) return;
    for (const s of list) if (isSpec(s)) motion.set(s.slot, slotMotion(s));
    obj.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry.getAttribute("_drift")) meshes.push(mesh);
    });
  });
  if (!meshes.length || !motion.size) return null;

  root.updateMatrixWorld(true);
  const slots = [...motion.entries()];
  const world = new THREE.Vector3();
  const tables: { offsets: THREE.Vector3[]; toLocal: THREE.Matrix3 }[] = [];
  // A material is patched in place unless another mesh draws with it too (its program would read a missing `_drift`
  // as 0 and move with slot 0): then the mesh gets a copy
  const users = new Map<THREE.Material, number>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) users.set(m, (users.get(m) ?? 0) + 1);
  });
  for (const mesh of meshes) {
    // The offset is in metres; the mesh's own space is the quantized one under its node's scale
    const toLocal = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).invert();
    const offsets = Array.from({ length: DRIFT_SLOTS }, () => new THREE.Vector3());
    tables.push({ offsets, toLocal });
    const uniform = { value: offsets };
    const own = (mat: THREE.Material) => {
      const prev = mat.onBeforeCompile;
      const prevKey = mat.customProgramCacheKey();
      let m = mat;
      if ((users.get(mat) ?? 0) > 1) {
        m = mat.clone();
        // MeshStandardMaterial.copy() resets the defines (scene-builder's rough-diffuse conversion sets its own)
        const defines = (mat as THREE.MeshStandardMaterial).defines;
        if (defines) (m as THREE.MeshStandardMaterial).defines = { ...defines };
        m.userData = { ...mat.userData };
      }
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);
        shader.uniforms.uDriftOffset = uniform;
        shader.vertexShader = patchShader(shader.vertexShader, VERTEX_PATCHES, "drifting-objects");
      };
      m.customProgramCacheKey = () => `${prevKey}|drift-v1`;
      m.needsUpdate = true;
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
  }

  let t0: number | null = null;
  return {
    count: motion.size,
    update(seconds: number) {
      if (!Number.isFinite(seconds)) return;
      if (t0 === null) t0 = seconds;
      const t = seconds - t0;
      for (const { offsets, toLocal } of tables) {
        for (const [slot, { start, vel }] of slots) {
          world.copy(vel).multiplyScalar(t).add(start);
          offsets[slot].copy(world).applyMatrix3(toLocal);
        }
      }
    },
  };
}
