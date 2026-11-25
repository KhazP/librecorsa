import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { rendererName } from "./gpu-health";

export type AnyRenderer = THREE.WebGLRenderer | WebGPURenderer;

let activeWebGPUMode = false;

export function isWebGPUMode(): boolean {
  return activeWebGPUMode;
}

export function isWebGPURenderer(renderer: AnyRenderer | null | undefined): renderer is WebGPURenderer {
  return Boolean(renderer && "isWebGPURenderer" in renderer && renderer.isWebGPURenderer);
}

export interface SyncSimRenderer {
  renderer: AnyRenderer;
  backend: "webgpu" | "webgl2";
  initPromise: Promise<void>;
  getGpuName: () => Promise<string | null>;
}

/**
 * Synchronously constructs the simulation renderer (defaulting to WebGL2; opts into WebGPURenderer
 * when `?renderer=webgpu` or `forceWebGPU` is set and `navigator.gpu` is available) and returns an
 * `initPromise` that completes backend initialization.
 */
export function createSimRendererSync(options: {
  reversedDepthBuffer?: boolean;
  forceWebGPU?: boolean;
  forceWebGL?: boolean;
} = {}): SyncSimRenderer {
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const wantWebGPU = !options.forceWebGL && (Boolean(options.forceWebGPU) || params?.get("renderer") === "webgpu");
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu);

  if (wantWebGPU && hasWebGPU) {
    activeWebGPUMode = true;
    const gpuRenderer = new WebGPURenderer({
      antialias: false,
      stencil: false,
      powerPreference: "high-performance",
      reversedDepthBuffer: false,
    });
    const initPromise = gpuRenderer.init().then(() => {});
    const getGpuName = async (): Promise<string | null> => {
      try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        const info = (adapter as { info?: { description?: string; device?: string; vendor?: string } } | null)?.info;
        return info?.description || info?.device || info?.vendor || "WebGPU Adapter";
      } catch {
        return "WebGPU Adapter";
      }
    };
    return {
      renderer: gpuRenderer,
      backend: "webgpu",
      initPromise,
      getGpuName,
    };
  }

  activeWebGPUMode = false;
  const glRenderer = new THREE.WebGLRenderer({
    antialias: false,
    stencil: false,
    powerPreference: "high-performance",
    reversedDepthBuffer: options.reversedDepthBuffer ?? true,
  });
  return {
    renderer: glRenderer,
    backend: "webgl2",
    initPromise: Promise.resolve(),
    getGpuName: async () => rendererName(glRenderer.getContext()),
  };
}
