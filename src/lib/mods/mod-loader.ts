import { withBasePath } from "@/lib/base-path";
import { registerModTracks, type ModOrigin, type TrackInfo } from "@/lib/track-registry";
import { modDefinitions, registerModContent } from "@/lib/mods/mod-content";
import { isModPackageId, isSha256Hex, modContentId, modFileUrl, validateModManifest, type ModManifest } from "./mod-manifest";
import { disabledPackages, FOLDER_INDEX_PATH, modsStorageAvailable, readInstalled, readInstalledManifest } from "./mod-store";

/**
 * Reads the installed mod packages once per page and adds their content to the game's lists before the menus mount
 * (TrackGate waits for it). Two places hold packages:
 * - "browser": imported in the Mods panel, kept in the browser (mod-store.ts)
 * - "folder": files beside the game, listed in `/mods/_index.json`: `public/mods/` in a clone (`npm run mods:index`
 *   writes the list), the launcher's `mods/` folder
 * A package in both is the browser's copy. A package that fails its checks is listed with its problems and adds nothing.
 */

export type ModSourceKind = "browser" | "folder";

export interface LoadedPackage {
  id: string;
  name: string;
  version: string;
  source: ModSourceKind;
  enabled: boolean;
  /** Content hash, when known (always for a browser package; a folder index may state it) */
  hash?: string;
  bytes?: number;
  manifest?: ModManifest;
  /** Why it adds nothing: its manifest's problems, or that it couldn't be read */
  errors?: string[];
}

export interface ModsState {
  packages: LoadedPackage[];
}

let loading: Promise<ModsState> | null = null;
let state: ModsState = { packages: [] };

/** The packages read at the last load (empty before one) */
export const modsState = (): ModsState => state;

interface FolderEntry {
  id: string;
  hash?: string;
}

async function readFolderIndex(): Promise<FolderEntry[]> {
  try {
    const res = await fetch(withBasePath(FOLDER_INDEX_PATH), { cache: "no-cache" });
    if (!res.ok) return [];
    const index = (await res.json()) as { packages?: unknown };
    if (!Array.isArray(index.packages)) return [];
    return index.packages
      .filter((p): p is FolderEntry => !!p && isModPackageId((p as FolderEntry).id))
      .map((p) => ({ id: p.id, hash: isSha256Hex(p.hash) ? p.hash : undefined }));
  } catch {
    // No folder of packages beside this copy of the game (the usual case on the website)
    return [];
  }
}

async function readFolderManifest(id: string): Promise<unknown> {
  const res = await fetch(withBasePath(modFileUrl(id, "mod.json")), { cache: "no-cache" });
  if (!res.ok) throw new Error(`mod.json: HTTP ${res.status}`);
  return res.json();
}

/** The circuits a package adds, as the track registry lists them */
export function modTrackInfos(m: ModManifest, origin: ModOrigin): TrackInfo[] {
  return (m.tracks ?? []).map((t) => ({
    id: modContentId(m.id, t.id),
    name: t.name,
    layout: t.layout,
    country: t.country,
    city: t.city,
    lengthM: t.lengthM,
    turns: t.turns,
    direction: t.direction,
    type: t.type,
    dataUrl: modFileUrl(m.id, t.data),
    quality: "mod",
    defaultTimeOfDay: t.defaultTimeOfDay,
    credit: {
      title: `${t.name} (${m.name})`,
      author: (t.credit ?? m.credit).author,
      authorUrl: (t.credit ?? m.credit).authorUrl,
      url: (t.credit ?? m.credit).url ?? (t.credit ?? m.credit).authorUrl ?? "",
      license: (t.credit ?? m.credit).license,
      licenseUrl: (t.credit ?? m.credit).licenseUrl ?? "",
      note: (t.credit ?? m.credit).note,
    },
    mod: origin,
  }));
}

async function load(): Promise<ModsState> {
  const [local, folder] = await Promise.all([modsStorageAvailable() ? readInstalled() : Promise.resolve([]), readFolderIndex()]);
  const off = disabledPackages();
  const known = modDefinitions();
  const packages: LoadedPackage[] = [];
  const seen = new Set<string>();
  const entries = [
    ...local.map((p) => ({ id: p.id, hash: p.hash, bytes: p.bytes, name: p.name, version: p.version, source: "browser" as const })),
    ...folder.map((p) => ({ id: p.id, hash: p.hash, bytes: undefined, name: p.id, version: "", source: "folder" as const })),
  ];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const pkg: LoadedPackage = { id: e.id, name: e.name, version: e.version, source: e.source, enabled: !off.has(e.id), hash: e.hash, bytes: e.bytes };
    try {
      const raw = e.source === "browser" ? await readInstalledManifest(e.id) : await readFolderManifest(e.id);
      const checked = validateModManifest(raw, known);
      if (!checked.ok) pkg.errors = checked.errors;
      else if (checked.manifest.id !== e.id) pkg.errors = [`mod.json names the package "${checked.manifest.id}", but it is installed as "${e.id}"`];
      else {
        pkg.manifest = checked.manifest;
        pkg.name = checked.manifest.name;
        pkg.version = checked.manifest.version;
      }
    } catch (err) {
      pkg.errors = [err instanceof Error ? err.message : String(err)];
    }
    packages.push(pkg);
  }

  const tracks: TrackInfo[] = [];
  const active = packages.filter((p): p is LoadedPackage & { manifest: ModManifest } => p.enabled && !!p.manifest);
  for (const p of active) {
    const origin: ModOrigin = { packageId: p.id, packageName: p.name, version: p.version, hash: p.hash };
    tracks.push(...modTrackInfos(p.manifest, origin));
  }
  registerModTracks(tracks);
  registerModContent(active.map((p) => ({ manifest: p.manifest, origin: { packageId: p.id, packageName: p.name, version: p.version, hash: p.hash } })));
  state = { packages };
  return state;
}

/**
 * Reads the installed packages and adds what they hold, once per page (later calls get the same answer). It never
 * rejects: a package that can't be read is listed with its problem, and the game starts without it.
 */
export function loadMods(): Promise<ModsState> {
  if (typeof window === "undefined") return Promise.resolve(state);
  loading ??= load().catch((err) => {
    console.warn("Mods could not be read:", err);
    return state;
  });
  return loading;
}
