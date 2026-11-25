import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { rendererName } from "./gpu-health";

export type AnyRenderer = THREE.WebGLRenderer | WebGPURenderer;

export interface WebGPUBundle {
  webgpu: typeof import("three/webgpu");
  tsl: typeof import("three/tsl");
  SkyMesh: typeof import("three/examples/jsm/objects/SkyMesh.js").SkyMesh;
  bloom: typeof import("three/examples/jsm/tsl/display/BloomNode.js").bloom;
}

let activeWebGPUMode = false;
let loadedBundle: WebGPUBundle | null = null;

export function isWebGPUMode(): boolean {
  return activeWebGPUMode;
}

export function isWebGPURenderer(renderer: AnyRenderer | null | undefined): renderer is WebGPURenderer {
  return Boolean(renderer && "isWebGPURenderer" in renderer && renderer.isWebGPURenderer);
}

export function getWebGPUBundle(): WebGPUBundle {
  if (!loadedBundle) {
    throw new Error("WebGPU/TSL bundle accessed before WebGPU initialization.");
  }
  return loadedBundle;
}

export interface CreatedSimRenderer {
  renderer: AnyRenderer;
  backend: "webgpu" | "webgl2";
  gpuName: string | null;
  onDeviceLost?: (cb: () => void) => void;
}

export function createWebGLRendererSync(options: { reversedDepthBuffer?: boolean } = {}): CreatedSimRenderer {
  activeWebGPUMode = false;
  const glRenderer = new THREE.WebGLRenderer({
    // MSAA happens in the post-processing composer's half-float target instead
    antialias: false,
    stencil: false,
    powerPreference: "high-performance",
    // Float precision across the 0.12 m .. 5.5 km depth range (kerbs, lines and decals stop z-fighting at
    // distance). three falls back to the standard buffer without EXT_clip_control; ?depth=standard forces it.
    reversedDepthBuffer: options.reversedDepthBuffer ?? true,
  });
  return {
    renderer: glRenderer,
    backend: "webgl2",
    gpuName: rendererName(glRenderer.getContext()),
  };
}

const WEBGPU_INIT_TIMEOUT_MS = 5000;

/**
 * Creates and initializes the simulation renderer. WebGL2 is the default; `?renderer=webgpu` dynamically imports
 * `three/webgpu` and `three/tsl`, awaits `init()` with a timeout, verifies `backend.isWebGPUBackend`, and falls back
 * to `THREE.WebGLRenderer` if WebGPU initialization fails, times out, or drops to Three's WebGL backend.
 */
export async function createSimRenderer(options: {
  reversedDepthBuffer?: boolean;
  forceWebGL?: boolean;
  timeoutMs?: number;
} = {}): Promise<CreatedSimRenderer> {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const wantWebGPU = !options.forceWebGL && params?.get("renderer") === "webgpu";
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);

  if (!wantWebGPU || !hasWebGPU) {
    return createWebGLRendererSync(options);
  }

  let gpuRenderer: WebGPURenderer | null = null;
  try {
    const [webgpu, tsl, skyMod, bloomMod] = await Promise.all([
      import("three/webgpu"),
      import("three/tsl"),
      import("three/examples/jsm/objects/SkyMesh.js"),
      import("three/examples/jsm/tsl/display/BloomNode.js"),
    ]);

    gpuRenderer = new webgpu.WebGPURenderer({
      antialias: false,
      stencil: false,
      powerPreference: "high-performance",
      reversedDepthBuffer: false,
    });

    const timeoutMs = options.timeoutMs ?? WEBGPU_INIT_TIMEOUT_MS;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gpuRenderer.init(),
        new Promise<never>((_, reject) => {
          timerId = setTimeout(() => reject(new Error(`WebGPU init timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }

    const backend = gpuRenderer.backend as { isWebGPUBackend?: boolean; device?: GPUDevice } | undefined;
    if (!backend?.isWebGPUBackend) {
      throw new Error("WebGPURenderer did not initialize a WebGPU backend (fell back to WebGLBackend)");
    }

    let gpuName: string | null = null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      const info = (adapter as { info?: { description?: string; device?: string; vendor?: string } } | null)?.info;
      gpuName = info?.description || info?.device || info?.vendor || null;
    } catch {
      gpuName = null;
    }

    loadedBundle = {
      webgpu,
      tsl,
      SkyMesh: skyMod.SkyMesh,
      bloom: bloomMod.bloom,
    };
    activeWebGPUMode = true;

    const device = backend.device;
    const onDeviceLost = device
      ? (cb: () => void) => {
          void device.lost.then(() => cb());
        }
      : undefined;

    return {
      renderer: gpuRenderer,
      backend: "webgpu",
      gpuName,
      onDeviceLost,
    };
  } catch (err) {
    console.warn("[gpu] WebGPU initialization failed, falling back to WebGL2:", err);
    try {
      gpuRenderer?.dispose();
    } catch {
      // ignore disposal failure on partially initialized renderer
    }
    activeWebGPUMode = false;
    loadedBundle = null;
    return createWebGLRendererSync(options);
  }
}
