import { isSafeModPath, modFileUrl } from "./mod-manifest";

/**
 * A package's files name each other by paths in the package ("track.glb", "scenery/trees.glb"); the game loads files
 * by URL (`/tracks/<id>/<id>.glb`). These turn the first into the second, so the loaders need nothing of their own.
 */

/** Files a track data file may name in its `metadata.mesh` */
const ASSET_FILE = /\.(glb|gltf|bin|json|webp|png|jpe?g|ktx2|ogg|wav|mp3)$/i;

/** A path in the package as its URL; an absolute URL or one that isn't a safe package path stays as it is */
export function resolveModPath(packageId: string, value: string): string {
  return isSafeModPath(value) && ASSET_FILE.test(value) ? modFileUrl(packageId, value) : value;
}

function resolveDeep(packageId: string, value: unknown): unknown {
  if (typeof value === "string") return resolveModPath(packageId, value);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(packageId, v));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDeep(packageId, v)]));
  }
  return value;
}

/**
 * A package's track data with the files its `metadata.mesh` names (the model, its scenery) as URLs under the
 * package's folder. Only `metadata.mesh` names files; the rest of the data is left as it is (and not copied).
 */
export function resolveModTrackUrls<T extends { metadata: object }>(raw: T, packageId: string): T {
  const metadata = raw.metadata as { mesh?: unknown };
  if (!metadata.mesh) return raw;
  return { ...raw, metadata: { ...raw.metadata, mesh: resolveDeep(packageId, metadata.mesh) } };
}
