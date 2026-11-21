import * as THREE from "three";
import type { CarLodJob, CarLodResult } from "./car-lod-worker";

/**
 * Runtime LOD1 generator and switcher for opponent cars (`>= 45 m` from the player).
 *
 * Each eligible high-poly indexed mesh (`>= 800` tris) is simplified once per shared `BufferGeometry` in a background
 * Web Worker running `MeshoptSimplifier` (0 ms main-thread stalls). The resulting LOD1 `BufferGeometry` shares the
 * exact same vertex attribute buffers (position, normal, uv, tangent, color, `_occlusion`) and swaps ONLY the compact
 * index buffer, so extra VRAM is negligible (~10-20 KB per mesh) and liveries / carbon weave / vertex occlusion / tyre
 * deformation shaders work unchanged.
 *
 * All opponent rigs cloned from the same template share one cached LOD1 `BufferGeometry` per mesh, and the worker
 * automatically terminates after 15 s of idle time to return its WASM heap.
 */

const MIN_TRIS_FOR_LOD = 800;
const DEFAULT_BODY_RATIO = 0.22;
const DEFAULT_TYRE_RATIO = 0.30;
const DEFAULT_TARGET_ERROR = 0.035;
const WORKER_IDLE_MS = 15_000;

export interface OpponentLodOptions {
  /** Close-range sub-pixel meshes hidden entirely at LOD1 (uprights, driver, harness, mirror glass, interior, exhaust) */
  microMeshes?: readonly THREE.Object3D[];
  /** Target triangle ratio for bodywork / wings / rims (default 0.22) */
  bodyRatio?: number;
  /** Target triangle ratio for tyre meshes (default 0.30) */
  tyreRatio?: number;
}

export interface OpponentLodController {
  /** Switch between LOD0 (full detail) and LOD1 (simplified meshes + micro-meshes hidden). Allocation-free. */
  setLod(lod: 0 | 1): void;
  /** Restore LOD0 geometry bindings so disposal sees original template references cleanly */
  dispose(): void;
}

interface PendingJob {
  resolve: (indices: Uint16Array | Uint32Array | null) => void;
}

let lodWorker: Worker | null = null;
let workerFailed = false;
let nextJobId = 1;
const pendingJobs = new Map<number, PendingJob>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** One cached LOD1 promise per source BufferGeometry + target ratio (shared across all 11 opponents) */
const lod1Cache = new WeakMap<THREE.BufferGeometry, Map<number, Promise<THREE.BufferGeometry | null>>>();

function workersSupported(): boolean {
  return typeof window !== "undefined" && typeof Worker !== "undefined";
}

function scheduleWorkerShutdown(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pendingJobs.size > 0 || !lodWorker) return;
    lodWorker.terminate();
    lodWorker = null;
  }, WORKER_IDLE_MS);
}

function getLodWorker(): Worker | null {
  if (workerFailed || !workersSupported()) return null;
  if (lodWorker) return lodWorker;
  try {
    const worker = new Worker(new URL("./car-lod-worker.ts", import.meta.url), {
      type: "module",
      name: "librecorsa-car-lod",
    });
    worker.onmessage = (ev: MessageEvent<CarLodResult>) => {
      const job = pendingJobs.get(ev.data.id);
      pendingJobs.delete(ev.data.id);
      job?.resolve(ev.data.indices);
      if (pendingJobs.size === 0) scheduleWorkerShutdown();
    };
    worker.onerror = () => {
      workerFailed = true;
      worker.terminate();
      if (lodWorker === worker) lodWorker = null;
      for (const job of pendingJobs.values()) job.resolve(null);
      pendingJobs.clear();
    };
    lodWorker = worker;
    return worker;
  } catch {
    workerFailed = true;
    return null;
  }
}

/** Extracts plain Float32 vertex positions (safe for meshopt interleaved / normalized / Float16 attributes) */
function extractPositions(pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = pos.getX(i);
    out[i * 3 + 1] = pos.getY(i);
    out[i * 3 + 2] = pos.getZ(i);
  }
  return out;
}

/** Extracts a fresh Uint32 index copy safe to transfer to the worker without detaching the source geometry */
function extractIndices(index: THREE.BufferAttribute): Uint32Array {
  const out = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) out[i] = index.getX(i);
  return out;
}

/** Builds a BufferGeometry sharing `src`'s vertex attributes with a compacted LOD1 index buffer */
function shareAttributesWithIndex(
  src: THREE.BufferGeometry,
  indices: Uint16Array | Uint32Array
): THREE.BufferGeometry {
  const lod1 = new THREE.BufferGeometry();
  lod1.name = src.name ? `${src.name}_LOD1` : "Car_LOD1";
  for (const [key, attr] of Object.entries(src.attributes)) {
    lod1.setAttribute(key, attr);
  }
  lod1.setIndex(new THREE.BufferAttribute(indices, 1));
  if (src.boundingBox) lod1.boundingBox = src.boundingBox.clone();
  else lod1.computeBoundingBox();
  if (src.boundingSphere) lod1.boundingSphere = src.boundingSphere.clone();
  else lod1.computeBoundingSphere();
  return lod1;
}

function getOrBuildLod1Geometry(
  src: THREE.BufferGeometry,
  ratio: number
): Promise<THREE.BufferGeometry | null> {
  const ratioKey = Math.round(ratio * 100);
  let byRatio = lod1Cache.get(src);
  if (!byRatio) {
    byRatio = new Map();
    lod1Cache.set(src, byRatio);
  }
  const cached = byRatio.get(ratioKey);
  if (cached) return cached;

  const index = src.index;
  const pos = src.getAttribute("position") as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  const tris = index ? Math.floor(index.count / 3) : 0;
  if (
    !index ||
    !pos ||
    tris < MIN_TRIS_FOR_LOD ||
    src.groups.length > 0 ||
    Object.keys(src.morphAttributes).length > 0 ||
    src.drawRange.start !== 0 ||
    src.drawRange.count < index.count
  ) {
    const none = Promise.resolve(null);
    byRatio.set(ratioKey, none);
    return none;
  }

  const worker = getLodWorker();
  if (!worker) {
    const none = Promise.resolve(null);
    byRatio.set(ratioKey, none);
    return none;
  }

  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  const positions = extractPositions(pos);
  const indices = extractIndices(index);
  const targetIndexCount = Math.max(90, Math.floor(tris * ratio)) * 3;
  const id = nextJobId++;

  const promise = new Promise<THREE.BufferGeometry | null>((resolve) => {
    pendingJobs.set(id, {
      resolve: (outIndices) => {
        resolve(outIndices ? shareAttributesWithIndex(src, outIndices) : null);
      },
    });
    const job: CarLodJob = {
      id,
      positions,
      indices,
      targetIndexCount,
      targetError: DEFAULT_TARGET_ERROR,
    };
    try {
      worker.postMessage(job, [positions.buffer, indices.buffer]);
    } catch {
      pendingJobs.delete(id);
      resolve(null);
    }
  });

  byRatio.set(ratioKey, promise);
  return promise;
}

interface TrackedSlot {
  mesh: THREE.Mesh;
  lod0: THREE.BufferGeometry;
  lod1: THREE.BufferGeometry | null;
}

/**
 * Attaches an asynchronous LOD1 controller to an opponent car's mesh roots. Simplification jobs run once per shared
 * geometry in a background worker and activate automatically on any car currently at `lod === 1`.
 */
export function createOpponentLodController(
  roots: readonly THREE.Object3D[],
  options: OpponentLodOptions = {}
): OpponentLodController {
  const bodyRatio = options.bodyRatio ?? DEFAULT_BODY_RATIO;
  const tyreRatio = options.tyreRatio ?? DEFAULT_TYRE_RATIO;
  const microList = options.microMeshes ? [...options.microMeshes] : [];
  const microSet = new Set<THREE.Object3D>(microList);

  const isInsideMicro = (obj: THREE.Object3D): boolean => {
    for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
      if (microSet.has(o)) return true;
    }
    return false;
  };

  const slots: TrackedSlot[] = [];
  let currentLod: 0 | 1 = 0;
  let disposed = false;

  for (const root of roots) {
    root.traverse((obj) => {
      if (isInsideMicro(obj)) return;
      const mesh = obj as THREE.Mesh;
      if (
        !mesh.isMesh ||
        (mesh as THREE.SkinnedMesh).isSkinnedMesh ||
        (mesh as THREE.InstancedMesh).isInstancedMesh ||
        !mesh.geometry ||
        !mesh.visible
      ) {
        return;
      }
      const geom = mesh.geometry;
      const tris = geom.index ? Math.floor(geom.index.count / 3) : 0;
      if (tris < MIN_TRIS_FOR_LOD) return;

      const slot: TrackedSlot = { mesh, lod0: geom, lod1: null };
      slots.push(slot);
      const ratio = mesh.name.endsWith("_TYRE") ? tyreRatio : bodyRatio;
      void getOrBuildLod1Geometry(geom, ratio).then((lod1) => {
        if (disposed || !lod1) return;
        slot.lod1 = lod1;
        if (currentLod === 1 && slot.mesh.geometry === slot.lod0) {
          slot.mesh.geometry = lod1;
        }
      });
    });
  }

  return {
    setLod(lod: 0 | 1): void {
      if (disposed || lod === currentLod) return;
      currentLod = lod;
      const showMicro = lod === 0;
      for (const obj of microList) obj.visible = showMicro;
      if (lod === 1) {
        for (const s of slots) {
          if (s.lod1 && s.mesh.geometry === s.lod0) s.mesh.geometry = s.lod1;
        }
      } else {
        for (const s of slots) {
          if (s.lod1 && s.mesh.geometry === s.lod1) s.mesh.geometry = s.lod0;
        }
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const s of slots) {
        if (s.lod1 && s.mesh.geometry === s.lod1) s.mesh.geometry = s.lod0;
      }
    },
  };
}
