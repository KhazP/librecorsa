import { isSafeModPath, modFileUrl } from "./mod-manifest";

/**
 * A package's files name each other by paths in the package ("track.glb", "scenery/trees.glb"); the game loads files
 * by URL (`/tracks/<id>/<id>.glb`). These turn the first into the second, so the loaders need nothing of their own.
 */

/** Files a track data file may name in its `metadata.mesh` */
const ASSET_FILE = /\.(glb|gltf|bin|json|webp|png|jpe?g|ktx2|ogg|wav|mp3)$/i;

/**
 * A path in the package as its URL. A file named any other way (an absolute URL, a path on the site) is refused: a
 * mod circuit loads only its own files, all of them in the content hash online rooms compare, and none from elsewhere
 */
export function resolveModPath(packageId: string, value: string): string {
  if (!ASSET_FILE.test(value)) return value;
  if (!isSafeModPath(value)) throw new Error(`"${value}": a mod circuit names its files by their path in the package`);
  return modFileUrl(packageId, value);
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
 * package's folder. Only `metadata.mesh` names files; the rest of the data is left as it is (and not copied). Throws
 * when it names a file outside the package (the circuit doesn't load, and the game stays on the one it had).
 */
export function resolveModTrackUrls<T extends { metadata: object }>(raw: T, packageId: string): T {
  const metadata = raw.metadata as { mesh?: unknown };
  if (!metadata.mesh) return raw;
  return { ...raw, metadata: { ...raw.metadata, mesh: resolveDeep(packageId, metadata.mesh) } };
}
