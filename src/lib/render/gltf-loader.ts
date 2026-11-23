import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder as ThreeMeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { activeKtx2Loader, ktx2ReleaseTexels, ktx2TextureCheck } from "@/lib/render/ktx2";

type DecodeArgs = Parameters<typeof ThreeMeshoptDecoder.decodeGltfBufferAsync>;

/** Worker threads stop after this long with nothing to decode, so their memory goes back between loads (ms) */
const WORKER_IDLE_MS = 15_000;
/** How long the workers get to answer their first decode before the main thread does it instead (ms) */
const WORKER_PROBE_MS = 5_000;
/**
 * Four vertices of four bytes (1..16), meshopt-encoded: the decode every worker start is checked with. A worker that
 * cannot start (a blocked blob: URL, no WebAssembly in workers) would otherwise leave the load waiting forever
 */
const PROBE_SOURCE = [
  160, 1, 63, 0, 0, 0, 8, 8, 8, 1, 63, 0, 0, 0, 8, 8, 8, 1, 63, 0, 0, 0, 8, 8, 8, 1, 63, 0, 0, 0, 8, 8, 8, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4,
];

/** 2 to 4 decode threads: half the cores, leaving the main thread and the simulation worker theirs */
function workerCount(): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  return Math.min(4, Math.max(2, Math.floor(cores / 2)));
}

/** Whether this runtime can run the decoder's workers (a browser; Node scripts decode on their own thread) */
const workersAvailable = () =>
  typeof window !== "undefined" && typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL?.createObjectURL === "function";

/** Resolves true once the workers answered the probe decode correctly; false sends every decode to the main thread */
let workersReady: Promise<boolean> | null = null;
/** The workers failed their probe once: this page decodes on the main thread from then on, without trying again */
let workersFailed = false;
let pending = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function startWorkers(): Promise<boolean> {
  if (workersReady) return workersReady;
  workersReady = (async () => {
    try {
      ThreeMeshoptDecoder.useWorkers(workerCount());
      const probe = ThreeMeshoptDecoder.decodeGltfBufferAsync(4, 4, new Uint8Array(PROBE_SOURCE), "ATTRIBUTES", "NONE");
      const out = await Promise.race([probe, new Promise<null>((resolve) => setTimeout(() => resolve(null), WORKER_PROBE_MS))]);
      if (out && out.length === 16 && out.every((b, i) => b === i + 1)) return true;
      console.warn("Model decoding stays on the main thread: its worker threads did not answer");
    } catch (err) {
      console.warn("Model decoding stays on the main thread:", err);
    }
    workersFailed = true;
    ThreeMeshoptDecoder.useWorkers(0);
    return false;
  })();
  return workersReady;
}

/** After a quiet spell the workers stop (their WebAssembly memory with them); the next model starts them again */
function scheduleIdleStop(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending > 0 || !workersReady) return;
    const ready = workersReady;
    workersReady = null;
    void ready.then((ok) => {
      // A load that started meanwhile keeps them
      if (ok && pending === 0 && workersReady === null) ThreeMeshoptDecoder.useWorkers(0);
    });
  }, WORKER_IDLE_MS);
}

/**
 * three's meshopt decoder, decoding on worker threads in the browser: a circuit holds hundreds to thousands of
 * compressed buffers, which took 18-82 ms of the main thread to decode on a fast desktop (a few times that on a
 * phone); with the workers the main thread spends 3-14 ms handing them over. The workers start with the first model
 * and stop when no model has loaded for a while; where they can't run, the decoder works as before.
 */
export const MeshoptDecoder: typeof ThreeMeshoptDecoder = {
  ...ThreeMeshoptDecoder,
  async decodeGltfBufferAsync(...args: DecodeArgs): Promise<Uint8Array> {
    if (workersFailed || !workersAvailable()) return ThreeMeshoptDecoder.decodeGltfBufferAsync(...args);
    pending++;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      // Without workers three decodes on this thread (useWorkers(0) above), with the same result
      await startWorkers();
      return await ThreeMeshoptDecoder.decodeGltfBufferAsync(...args);
    } finally {
      if (--pending === 0) scheduleIdleStop();
    }
  },
};

/**
 * A GLTFLoader that also reads meshopt-compressed files: the Pages deploy compresses the car models
 * (scripts/cars/compress-car-glb.mjs) while the repository keeps them raw, so the same loader has to take both.
 * While a circuit load holds the KTX2 loader (ktx2.ts) it also reads KTX2 textures, and a KTX2 texture that fails
 * fails the whole load. KTX2 textures let go of their transcoded data once they are on the GPU.
 */
export function createGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(ktx2TextureCheck).register(ktx2ReleaseTexels);
  const ktx2 = activeKtx2Loader();
  if (ktx2) loader.setKTX2Loader(ktx2);
  return loader;
}
