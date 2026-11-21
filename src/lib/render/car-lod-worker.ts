/**
 * Dedicated Web Worker running meshoptimizer's WASM edge-collapse simplifier off the main thread so opponent car LOD1
 * index buffers are built with 0 ms frame blocking.
 */
import { MeshoptSimplifier } from "meshoptimizer/simplifier";

export interface CarLodJob {
  id: number;
  positions: Float32Array;
  indices: Uint32Array;
  targetIndexCount: number;
  targetError: number;
}

export interface CarLodResult {
  id: number;
  /** Compacted index array (Uint16Array when max index fits in 16 bits, else Uint32Array), or null if no meaningful gain */
  indices: Uint16Array | Uint32Array | null;
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<CarLodJob>) => void) | null;
  postMessage(message: CarLodResult, transfer?: Transferable[]): void;
};

let readyPromise: Promise<void> | null = null;

workerScope.onmessage = async (ev: MessageEvent<CarLodJob>) => {
  const { id, positions, indices, targetIndexCount, targetError } = ev.data;
  try {
    if (!MeshoptSimplifier.supported) {
      workerScope.postMessage({ id, indices: null });
      return;
    }
    readyPromise ??= MeshoptSimplifier.ready;
    await readyPromise;

    const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, targetError, []);
    // Skip storing LOD1 when simplification did not cut at least 15% of triangles
    if (!simplified || simplified.length === 0 || simplified.length >= indices.length * 0.85) {
      workerScope.postMessage({ id, indices: null });
      return;
    }

    let maxIdx = 0;
    for (let i = 0; i < simplified.length; i++) {
      if (simplified[i] > maxIdx) maxIdx = simplified[i];
    }
    const out = maxIdx <= 65535 ? new Uint16Array(simplified) : new Uint32Array(simplified);
    workerScope.postMessage({ id, indices: out }, [out.buffer]);
  } catch {
    workerScope.postMessage({ id, indices: null });
  }
};
