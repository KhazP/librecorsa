import * as THREE from "three";
import { withBasePath } from "@/lib/base-path";

/**
 * The project's own textures for materials on a circuit's own geometry that came with a track pack's images
 * (public/tracks/<id>/scenery/textures/, drawn by scripts/rwanda-textures.mjs to each original's size and layout).
 * The circuit GLB is not changed: once it is loaded, each listed material's map is swapped for the new image with
 * the old one's sampler settings. If the manifest or an image fails to load, that material keeps its original.
 */

interface TextureManifest {
  textures: { material: string; file: string; width: number; height: number; alpha: boolean }[];
}

/** Material name → its new texture, or null when the manifest is missing or fails to load */
export async function loadSceneryTextures(manifestUrl: string): Promise<Map<string, THREE.Texture> | null> {
  try {
    const res = await fetch(withBasePath(manifestUrl));
    if (!res.ok) throw new Error(`${res.status}`);
    const manifest = (await res.json()) as TextureManifest;
    const dir = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
    const loader = new THREE.TextureLoader();
    const entries = await Promise.all(
      manifest.textures.map(async (t) => {
        try {
          return [t.material, await loader.loadAsync(withBasePath(dir + t.file))] as const;
        } catch (err) {
          console.warn(`[scenery] ${t.file} did not load; ${t.material} keeps its own texture:`, err);
          return null;
        }
      })
    );
    const map = new Map<string, THREE.Texture>();
    for (const e of entries) if (e) map.set(e[0], e[1]);
    return map;
  } catch (err) {
    console.warn(`[scenery] ${manifestUrl} did not load; the circuit keeps its own textures:`, err);
    return null;
  }
}

/** Puts each new texture on the materials of that name under `root`, keeping the old map's sampler settings */
export function applySceneryTextures(root: THREE.Object3D, textures: Map<string, THREE.Texture>): number {
  const done = new Set<THREE.Material>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const std = mat as THREE.MeshStandardMaterial;
      const next = textures.get(mat.name);
      if (!next || done.has(mat) || !std.map) continue;
      done.add(mat);
      const old = std.map;
      const tex = next.clone();
      tex.flipY = old.flipY; // glTF images are not flipped
      tex.colorSpace = old.colorSpace;
      tex.wrapS = old.wrapS;
      tex.wrapT = old.wrapT;
      tex.repeat.copy(old.repeat);
      tex.offset.copy(old.offset);
      tex.center.copy(old.center);
      tex.rotation = old.rotation;
      tex.channel = old.channel;
      tex.anisotropy = old.anisotropy;
      tex.magFilter = old.magFilter;
      tex.minFilter = old.minFilter;
      tex.needsUpdate = true;
      std.map = tex;
      std.needsUpdate = true;
    }
  });
  return done.size;
}
