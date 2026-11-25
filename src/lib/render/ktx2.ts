import type * as THREE from "three";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import type { AnyRenderer } from "./webgpu-renderer";
import type { GLTFLoaderPlugin, GLTFParser } from "three/examples/jsm/loaders/GLTFLoader.js";
import { withBasePath } from "@/lib/base-path";
import { isTouchDevice } from "@/lib/input/touch-input";

/**
 * GPU-compressed circuit textures for phones: KTX2 files with Basis Universal data (scripts/ktx2-track-textures.mjs),
 * which the GPU keeps compressed. A WebP texture takes 4 bytes per texel on the GPU; ETC1S transcodes to ETC2 at half a
 * byte (one with alpha) and UASTC to ASTC at one, which is most of a circuit's memory on a phone.
 *
 * Phones and tablets only: the same test that starts them on Medium graphics (a coarse primary pointer,
 * touch-input.ts). Desktops keep the WebP files: they have the memory, and their GPU formats (BC1-7) would need the
 * textures' sizes in multiples of 4. The transcoder targets ETC2 and ASTC only; a device with neither loads WebP.
 *
 * The transcoder (public/basis/, the copy that ships with three) runs in workers, which hold a WebAssembly heap that
 * never shrinks: a circuit load acquires the loader, and the last release frees the workers once its textures are in.
 * Each new loader first transcodes a 4 x 4 texture (ktx2Ready): a transcoder that can't start (a corrupt or blocked
 * .wasm aborts its worker, and the textures would never arrive) sends that load and every later one to WebP.
 *
 * `?ktx2=off` loads the WebP files; `?ktx2=on` loads KTX2 on any device with ETC2 or ASTC (a desktop, for testing);
 * `?ktx2=etc` or `astc` does that with one format only.
 */

type Ktx2Mode = "auto" | "on" | "off" | "etc" | "astc";

let renderer: AnyRenderer | null = null;
let loader: KTX2Loader | null = null;
let ready: Promise<void> | null = null;
let users = 0;
/** The transcoder failed its probe once: this page loads WebP from then on */
let transcoderFailed = false;

/** A 4 x 4 ETC1S texture, transcoded once per loader before a circuit's textures are trusted to arrive */
const PROBE_KTX2 = "q0tUWCAyMLsNChoKAAAAAAEAAAAEAAAABAAAAAAAAAAAAAAAAQAAAAEAAAABAAAAaAAAACwAAACUAAAAJAAAALgAAAAAAAAAgQAAAAAAAAA5AQAAAAAAAAEAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAIAKACjAQIAAwMAAAgAAAAAAAAAAAA/AAAAAAAAAAAA/////x8AAABLVFh3cml0ZXIAQmFzaXMgVW5pdmVyc2FsIDIuNTAAAAEAAQApAAAABQAAACsAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAABwAQAAAAAAAACBJgIAAAAAABAnAgAJgAAAAAAABAFwAwAAAAAAAAyCPxVrQoAAMFEAAAAAAAA8l8tAJgAAAAAAABACAATAAIAAAAAiAHABAAAAAAAAAIIAAA=";
/** How long the probe may take once the transcoder has downloaded (ms) */
const PROBE_MS = 5_000;

function probe(next: KTX2Loader): Promise<void> {
  const bytes = Uint8Array.from(atob(PROBE_KTX2), (c) => c.charCodeAt(0));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the KTX2 transcoder did not answer")), PROBE_MS);
    next.parse(
      bytes.buffer,
      (texture) => {
        clearTimeout(timer);
        texture.dispose();
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** The renderer whose GPU formats the transcoder targets (the drive session's) */
export function setKtx2Renderer(next: AnyRenderer | null): void {
  renderer = next;
}

function ktx2Mode(): Ktx2Mode {
  if (typeof window === "undefined") return "off";
  const value = new URLSearchParams(window.location.search).get("ktx2");
  return value === "off" || value === "on" || value === "etc" || value === "astc" ? value : "auto";
}

/**
 * The KTX2 loader for a circuit load, or null when this device should load the WebP files: not a phone or tablet
 * (unless `?ktx2=on`), no renderer yet, `?ktx2=off`, a transcoder that failed before, or neither ETC2 nor ASTC.
 * Starts fetching the transcoder at once, alongside the model. Pair with releaseKtx2Loader.
 */
export function acquireKtx2Loader(): KTX2Loader | null {
  const mode = ktx2Mode();
  if (!renderer || mode === "off" || transcoderFailed) return null;
  if (mode === "auto" && !isTouchDevice()) return null;
  if (!loader) {
    const next = new KTX2Loader().setTranscoderPath(withBasePath("/basis/")).detectSupport(renderer);
    const config = next.workerConfig;
    // ETC2 and ASTC only: they take any texture size, which the converter keeps
    config.bptcSupported = config.dxtSupported = config.etc1Supported = config.pvrtcSupported = false;
    if (mode === "etc") config.astcSupported = false;
    if (mode === "astc") config.etc2Supported = false;
    if (!config.astcSupported && !config.etc2Supported) return null;
    ready = next.init().then(() => probe(next));
    ready.catch((err) => {
      // A loader released before its probe answered was disposed, not broken
      if (loader !== next) return;
      transcoderFailed = true;
      console.warn("KTX2 textures are off for this page:", err);
    });
    loader = next;
  }
  users++;
  return loader;
}

/** Ends an acquireKtx2Loader; the last one frees the transcoder's workers */
export function releaseKtx2Loader(): void {
  if (users === 0) return;
  users--;
  if (users === 0 && loader) {
    loader.dispose();
    loader = null;
    ready = null;
  }
}

/**
 * Settles once the current loader's transcoder has transcoded the probe; rejects if it can't. A load that depends on
 * the transcoder waits for it alongside its own, so a transcoder that never answers fails the load instead of leaving
 * it waiting.
 */
export function ktx2Ready(): Promise<void> {
  return ready ?? Promise.reject(new Error("no KTX2 loader"));
}

/** The KTX2 loader while a circuit load holds it (gltf-loader.ts gives it to every GLTFLoader) */
export function activeKtx2Loader(): KTX2Loader | null {
  return loader;
}

/**
 * Fails a model's load when one of its KTX2 textures didn't load. GLTFLoader turns a texture that fails into a
 * missing one (null) and loads the model without it; a circuit that loses its textures this way should load its WebP
 * model instead. Only textures the load asked for are checked: an unused one is never loaded.
 */
export function ktx2TextureCheck(parser: GLTFParser): GLTFLoaderPlugin {
  return {
    name: "LC_ktx2_texture_check",
    afterRoot: async () => {
      const json = parser.json as { images?: { mimeType?: string }[]; textures?: { extensions?: Record<string, { source?: number }> }[] };
      const cache = (parser as unknown as { cache: { get(key: string): Promise<unknown> | undefined } }).cache;
      const pending: Promise<unknown>[] = [];
      (json.textures ?? []).forEach((tex, i) => {
        const image = tex.extensions?.KHR_texture_basisu?.source;
        if (image === undefined || json.images?.[image]?.mimeType !== "image/ktx2") return;
        const texture = cache.get(`texture:${i}`);
        if (texture) pending.push(texture);
      });
      if (!pending.length) return;
      const failed = (await Promise.all(pending)).filter((t) => !t).length;
      if (failed) throw new Error(`${failed} of ${pending.length} KTX2 textures did not load`);
    },
  };
}

const NO_TEXELS = new Uint8Array(0);

/** Called by three once a texture is on the GPU: the texture lets go of its transcoded copy */
function releaseTexels(texture: THREE.Texture): void {
  const t = texture as THREE.CompressedTexture;
  // New mip objects: a clone of this texture (another sampler) still holds the old ones until its own upload
  t.mipmaps = t.mipmaps.map((m) => ({ width: m.width, height: m.height, data: NO_TEXELS })) as typeof t.mipmaps;
  t.onUpdate = null;
}

/**
 * Lets a model's KTX2 textures drop their transcoded data once the GPU has it. three keeps a compressed texture's mip
 * data in memory after the upload, which on a phone is the tab's own memory (Monaco: about 110 MB in the iOS
 * simulator's Safari) on top of the GPU's copy. Only a lost and restored WebGL context would need the data again; the
 * game doesn't restore a lost context, so such a texture would stay black until the circuit is loaded again.
 */
export function ktx2ReleaseTexels(): GLTFLoaderPlugin {
  return {
    name: "LC_ktx2_release_texels",
    afterRoot: async (result) => {
      for (const scene of result.scenes) {
        scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            for (const v of Object.values(m)) {
              const t = v as THREE.CompressedTexture | null;
              if (t?.isCompressedTexture && t.userData.mimeType === "image/ktx2") t.onUpdate = releaseTexels;
            }
          }
        });
      }
    },
  };
}
