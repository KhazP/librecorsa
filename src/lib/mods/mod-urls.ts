import { isSafeModPath, modFileUrl } from "./mod-manifest";

/**
 * A package's files name each other by paths in the package ("track.glb", "scenery/trees.glb"); the game loads files
 * by URL (`/tracks/<id>/<id>.glb`). These turn the first into the second, so the loaders need nothing of their own.
 */

/** Files a track data file may name in its `metadata.mesh`: models, self-contained (a .gltf could name files anywhere) */
const ASSET_FILE = /\.glb$/i;

/**
 * A path in the package as its URL. Anything else (an absolute URL, `data:`, a path on the site, a query or a fragment,
 * another package's file) is refused: a mod circuit loads only its own files, all of them in the content hash online
 * rooms compare, and none from elsewhere
 */
export function resolveModPath(packageId: string, value: unknown): string {
  if (typeof value !== "string" || !isSafeModPath(value) || !ASSET_FILE.test(value)) {
    throw new Error(`${JSON.stringify(value)}: a mod circuit names its model and scenery by their path in the package (a .glb file)`);
  }
  return modFileUrl(packageId, value);
}

/**
 * A package's track data with the files its `metadata.mesh` names (`url`, the model, and `scenery`) as URLs under the
 * package's folder; the mesh's other strings are names of parts inside the model, left as they are. Throws when it
 * names a file outside the package (the circuit doesn't load, and the game stays on the one it had).
 */
export function resolveModTrackUrls<T extends { metadata?: object }>(raw: T, packageId: string): T {
  const metadata = raw.metadata as { mesh?: { url?: unknown; scenery?: unknown } } | undefined;
  const mesh = metadata?.mesh;
  if (!mesh || typeof mesh !== "object") return raw;
  const resolved: Record<string, unknown> = { ...mesh };
  if (mesh.url !== undefined) resolved.url = resolveModPath(packageId, mesh.url);
  if (mesh.scenery !== undefined) {
    if (!Array.isArray(mesh.scenery)) throw new Error("metadata.mesh.scenery: must be a list of paths in the package");
    resolved.scenery = mesh.scenery.map((f) => resolveModPath(packageId, f));
  }
  return { ...raw, metadata: { ...metadata, mesh: resolved } };
}
