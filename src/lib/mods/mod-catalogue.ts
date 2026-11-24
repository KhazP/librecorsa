import { withBasePath } from "@/lib/base-path";
import { isModPackageId, isSha256Hex, MODS_PATH } from "./mod-manifest";
import { Sha256 } from "./sha256-stream";
import { ZIP_MAX_TOTAL_BYTES } from "./zip-reader";

/**
 * A catalogue of mod packages to download: a JSON file that lists packed packages (`npm run mod -- catalogue` writes
 * one), each with where its zip is, its size and SHA-256, and its content hash. The Mods panel lists them and installs
 * one in a click (src/components/menu/ModCatalogue.tsx); docs/modding.md describes the format for modders and hosts.
 *
 * The game reads two places, only when the Mods panel opens, never at start:
 * - this copy's own (`/mods/_catalogue/catalogue.json`): the launcher serves it from its mods folder, a clone from
 *   `public/mods/`, any other host from that path
 * - the one the build names (`NEXT_PUBLIC_MOD_CATALOGUE_URL`), when it names one
 * Neither answering is the usual case, and the panel then says nothing about a catalogue.
 *
 * A catalogue is checked as strictly as a manifest: an entry that breaks a rule is dropped (the console says why),
 * and the others are listed. A package is installed only when its zip has exactly the size and SHA-256 the catalogue
 * states, and holds the package and content the catalogue says (mod-store.ts `installPackage`'s `expected`).
 */

/** The catalogue format this build reads */
export const CATALOGUE_FORMAT = 1;
/** This copy's own catalogue, under the site's base path. `_catalogue` is a name no package id can take */
export const CATALOGUE_DIR = `${MODS_PATH}/_catalogue`;
export const CATALOGUE_PATH = `${CATALOGUE_DIR}/catalogue.json`;
/** The most packages one catalogue lists; any past this are dropped */
export const CATALOGUE_MAX_PACKAGES = 500;
/** The largest catalogue file read */
export const CATALOGUE_MAX_BYTES = 1024 * 1024;
/** How long the panel waits for a catalogue before going on without it */
export const CATALOGUE_TIMEOUT_MS = 6000;
/** The largest zip a catalogue may offer: what an import takes (zip-reader.ts) */
export const CATALOGUE_MAX_ZIP_BYTES = ZIP_MAX_TOTAL_BYTES;

/** The catalogue this build names: an https:// address, or a path on the game's own site */
export const CONFIGURED_CATALOGUE = (process.env.NEXT_PUBLIC_MOD_CATALOGUE_URL ?? "").trim();

/** A package a catalogue offers, its links resolved and checked */
export interface CatalogueEntry {
  /** The package's id (`author.name`), as its mod.json names it */
  id: string;
  name: string;
  version: string;
  description?: string;
  author: string;
  license: string;
  licenseUrl?: string;
  /** Its zip, as an absolute URL */
  url: string;
  /** The zip's size (bytes) */
  bytes: number;
  /** The zip's SHA-256, lowercase hex */
  sha256: string;
  /** The package's content hash (mod-manifest.ts `packageHash`), what an installed copy is compared by */
  hash: string;
  circuits?: number;
  cars?: number;
  liveries?: number;
  /** A picture of it, as an absolute URL */
  preview?: string;
}

export interface ParsedCatalogue {
  packages: CatalogueEntry[];
  /** Why entries were dropped, or the whole catalogue refused */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A link in a catalogue as an absolute URL, or null when the game may not follow it. A relative link is read against
 * the catalogue's own address, so a catalogue and its zips can sit in one folder anywhere. What it leads to must be
 * https://, or on the game's own site (the launcher serves http://127.0.0.1). No user name or password in it. Where
 * a fetch of it ends up after redirects is held to the same rules (`landedSafely`).
 */
export function catalogueLink(value: unknown, base: string, pageOrigin: string): string | null {
  // Whitespace, control characters and backslashes are refused rather than read the lenient way a browser reads them
  if (typeof value !== "string" || value.length === 0 || value.length > 1000 || /[\s\p{Cc}\\]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  return url.protocol === "http:" && url.origin === pageOrigin ? url.href : null;
}

/**
 * Whether a response came from an address the game may read: a fetch follows redirects, and on the launcher's http
 * page nothing stops one from an https address to plain http, where anyone on the way could change the answer. A
 * response with no address (a test's) is taken as from the one asked for.
 */
export function landedSafely(res: Response, pageOrigin: string): boolean {
  return !res.url || catalogueLink(res.url, res.url, pageOrigin) !== null;
}

/** A catalogue to read, and whether the build names it (one it names is expected to answer; this copy's own may not be there) */
export interface CatalogueSource {
  url: string;
  named: boolean;
}

/**
 * The catalogues this copy reads, as absolute URLs: its own, then the one the build names (`configured`), once each.
 * A configured value that is neither an https:// address nor a path on the site is left out, with a warning.
 */
export function catalogueSources(configured: string, pageUrl: string): CatalogueSource[] {
  const origin = new URL(pageUrl).origin;
  const own = catalogueLink(withBasePath(CATALOGUE_PATH), pageUrl, origin);
  const sources: CatalogueSource[] = own ? [{ url: own, named: false }] : [];
  if (!configured) return sources;
  let named: string | null = null;
  if (/^https:\/\//i.test(configured)) named = catalogueLink(configured, pageUrl, origin);
  // A path on the site, under its base path (`//host/…` would leave it)
  else if (configured.startsWith("/") && !configured.startsWith("//")) named = catalogueLink(withBasePath(configured), pageUrl, origin);
  if (!named) {
    console.warn(`NEXT_PUBLIC_MOD_CATALOGUE_URL: "${configured}" is neither an https:// address nor a path on this site`);
    return sources;
  }
  const same = sources.find((src) => src.url === named);
  if (same) same.named = true;
  else sources.push({ url: named, named: true });
  return sources;
}

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : null);

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000 ? v : null);

/**
 * Checks a parsed catalogue. `url` is where it was read from (its relative links are read against it) and
 * `pageOrigin` the game's own origin. The whole catalogue is refused when it isn't format 1; otherwise each entry that
 * breaks a rule is dropped, with a problem naming it and why, and so is a second entry for one package id.
 */
export function parseCatalogue(raw: unknown, url: string, pageOrigin: string): ParsedCatalogue {
  const problems: string[] = [];
  if (!isRecord(raw)) return { packages: [], problems: ["the catalogue must be a JSON object"] };
  if (raw.format !== CATALOGUE_FORMAT) return { packages: [], problems: [`format: must be ${CATALOGUE_FORMAT} (this game reads catalogue format ${CATALOGUE_FORMAT})`] };
  if (!Array.isArray(raw.packages)) return { packages: [], problems: ["packages: must be a list"] };
  if (raw.packages.length > CATALOGUE_MAX_PACKAGES) problems.push(`packages: only the first ${CATALOGUE_MAX_PACKAGES} are read`);
  const packages: CatalogueEntry[] = [];
  const seen = new Set<string>();
  raw.packages.slice(0, CATALOGUE_MAX_PACKAGES).forEach((v, i) => {
    const where = `packages[${i}]`;
    if (!isRecord(v)) return void problems.push(`${where}: must be an object`);
    const wrong: string[] = [];
    const required = <T>(key: string, value: T | null | undefined, rule: string): T | undefined => {
      if (value === null || value === undefined) wrong.push(`${key} ${rule}`);
      return value ?? undefined;
    };
    // Absent is fine; present, it keeps the rule
    const optional = <T>(key: string, value: T | null | undefined, rule: string): T | undefined => (v[key] === undefined ? undefined : required(key, value, rule));
    const TEXT = (max: number) => `must be text of at most ${max} characters`;
    const LINK = "must be an https:// address, or a link on the game's own site";
    const COUNT = "must be a whole number from 0 to 1000";
    const id = required("id", isModPackageId(v.id) ? v.id : null, 'must be a package id ("author.name")');
    const entry = {
      id: id ?? "",
      name: required("name", text(v.name, 80), TEXT(80)) ?? "",
      version: required("version", text(v.version, 32), TEXT(32)) ?? "",
      description: optional("description", text(v.description, 1000), TEXT(1000)),
      author: required("author", text(v.author, 80), TEXT(80)) ?? "",
      license: required("license", text(v.license, 120), TEXT(120)) ?? "",
      licenseUrl: optional("licenseUrl", typeof v.licenseUrl === "string" && /^https:\/\//i.test(v.licenseUrl) ? catalogueLink(v.licenseUrl, url, pageOrigin) : null, "must be an https:// address"),
      url: required("url", catalogueLink(v.url, url, pageOrigin), LINK) ?? "",
      bytes:
        required(
          "bytes",
          typeof v.bytes === "number" && Number.isInteger(v.bytes) && v.bytes > 0 && v.bytes <= CATALOGUE_MAX_ZIP_BYTES ? v.bytes : null,
          `must be the zip's size in bytes (at most ${CATALOGUE_MAX_ZIP_BYTES})`,
        ) ?? 0,
      sha256: required("sha256", isSha256Hex(v.sha256) ? v.sha256 : null, "must be the zip's SHA-256 in lowercase hex") ?? "",
      hash: required("hash", isSha256Hex(v.hash) ? v.hash : null, "must be the package's content hash in lowercase hex") ?? "",
      circuits: optional("circuits", count(v.circuits), COUNT),
      cars: optional("cars", count(v.cars), COUNT),
      liveries: optional("liveries", count(v.liveries), COUNT),
      preview: optional("preview", catalogueLink(v.preview, url, pageOrigin), LINK),
    } satisfies CatalogueEntry;
    if (wrong.length) return void problems.push(`${where}${id ? ` (${id})` : ""}: ${wrong.join("; ")}`);
    if (seen.has(entry.id)) return void problems.push(`${where} (${entry.id}): listed twice; the first is kept`);
    seen.add(entry.id);
    packages.push(stripUndefined(entry));
  });
  return { packages, problems };
}

const stripUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** What reading one catalogue gave */
export type CatalogueRead =
  | { state: "ok"; catalogue: ParsedCatalogue }
  /** Nothing there: not found, not a catalogue, or one this game can't read */
  | { state: "absent" }
  /** No answer: offline, the host down, or no answer in time */
  | { state: "unreachable" };

/** The body of a response as text, refused past `max` bytes */
async function readCapped(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length")) > max || !res.body) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Reads one catalogue, within CATALOGUE_TIMEOUT_MS, and checks it; a problem with it goes to the console */
export async function readCatalogue(
  url: string,
  pageOrigin: string,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogueRead> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  opts.signal?.addEventListener("abort", stop);
  const timer = setTimeout(stop, opts.timeoutMs ?? CATALOGUE_TIMEOUT_MS);
  try {
    const res = await (opts.fetch ?? fetch)(url, { cache: "no-cache", signal: abort.signal, headers: { Accept: "application/json" } });
    if (!landedSafely(res, pageOrigin)) {
      void res.body?.cancel().catch(() => {});
      console.warn(`Mod catalogue ${url}: redirected to ${res.url}, which isn't https:// or this site: not read`);
      return { state: "absent" };
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { state: "absent" };
    }
    const body = await readCapped(res, CATALOGUE_MAX_BYTES);
    if (body === null) {
      console.warn(`Mod catalogue ${url}: larger than ${CATALOGUE_MAX_BYTES} bytes, not read`);
      return { state: "absent" };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      // A host that answers every path with a page (a single-page app's fallback) has no catalogue here
      return { state: "absent" };
    }
    const catalogue = parseCatalogue(raw, res.url || url, pageOrigin);
    if (catalogue.problems.length) console.warn(`Mod catalogue ${url}:\n  ${catalogue.problems.join("\n  ")}`);
    return { state: "ok", catalogue };
  } catch {
    return { state: "unreachable" };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
}

/** What the Mods panel lists: every package the catalogues offer, and whether the build's own catalogue is out of reach */
export interface CatalogueListing {
  packages: CatalogueEntry[];
  /** The catalogue the build names couldn't be reached (offline, most likely), so the list may be missing some */
  unreachable: boolean;
}

/**
 * Reads every catalogue this copy has (`catalogueSources`) at once. A package in more than one is listed once, from
 * the first: this copy's own catalogue comes before the one the build names.
 */
export async function loadCatalogues(
  configured: string = CONFIGURED_CATALOGUE,
  opts: { pageUrl?: string; signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogueListing> {
  const pageUrl = opts.pageUrl ?? window.location.href;
  const origin = new URL(pageUrl).origin;
  const sources = catalogueSources(configured, pageUrl);
  const reads = await Promise.all(sources.map((src) => readCatalogue(src.url, origin, opts)));
  const packages: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const read of reads) {
    if (read.state !== "ok") continue;
    for (const p of read.catalogue.packages) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      packages.push(p);
    }
  }
  // Only the catalogue the build names is expected to answer: this copy's own is usually not there at all
  const unreachable = reads.some((r, i) => r.state === "unreachable" && sources[i].named);
  return { packages, unreachable };
}

/** Where a catalogue's package stands against what is installed */
export type CatalogueStatus = { kind: "get" } | { kind: "installed" } | { kind: "update"; installedVersion: string };

/**
 * `installed`: the installed packages (mod-loader.ts `readPackages`). Installed means the same content; a package
 * whose content hash isn't known (a mods folder that doesn't list it) is taken by its version.
 */
export function catalogueStatus(
  entry: Pick<CatalogueEntry, "id" | "hash" | "version">,
  installed: readonly { id: string; hash?: string; version: string }[],
): CatalogueStatus {
  const mine = installed.find((p) => p.id === entry.id);
  if (!mine) return { kind: "get" };
  const same = mine.hash ? mine.hash === entry.hash : mine.version === entry.version;
  return same ? { kind: "installed" } : { kind: "update", installedVersion: mine.version };
}

/** Why a download failed, for the panel to say in the player's language */
export type DownloadFailure =
  /** The browser is offline */
  | "offline"
  /** The connection failed or broke off */
  | "network"
  /** The server answered with an error (`status`) */
  | "http"
  /** A redirect led to an address that isn't https:// or the game's own site */
  | "insecure"
  /** It isn't the size the catalogue states */
  | "size"
  /** Its SHA-256 isn't the one the catalogue states */
  | "checksum"
  /** The player cancelled it */
  | "aborted";

export class DownloadError extends Error {
  constructor(
    readonly failure: DownloadFailure,
    readonly status?: number,
  ) {
    super(`download failed: ${failure}${status ? ` (HTTP ${status})` : ""}`);
  }
}

/** Pieces of a download are gathered into a Blob this large at a time, which a browser may keep on disk */
const BLOB_PART_BYTES = 8 * 1024 * 1024;

/**
 * Downloads a package's zip, streamed, hashing each piece as it arrives: it must be exactly `entry.bytes` long, and
 * its SHA-256 `entry.sha256`, or it is refused with a `DownloadError`. One a redirect took off https:// (or the game's
 * own site, `pageOrigin`) is refused before it is read. `onProgress` hears the bytes so far. Never kept by the service
 * worker or the browser's cache: the zip is wanted once, to install.
 */
export async function downloadPackage(
  entry: Pick<CatalogueEntry, "url" | "bytes" | "sha256">,
  opts: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void; fetch?: typeof fetch; pageOrigin?: string } = {},
): Promise<Blob> {
  const offline = () => typeof navigator !== "undefined" && navigator.onLine === false;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(entry.url, { cache: "no-store", signal: opts.signal });
  } catch {
    throw new DownloadError(opts.signal?.aborted ? "aborted" : offline() ? "offline" : "network");
  }
  const pageOrigin = opts.pageOrigin ?? (typeof window !== "undefined" ? window.location.origin : "");
  if (!landedSafely(res, pageOrigin)) {
    void res.body?.cancel().catch(() => {});
    throw new DownloadError("insecure");
  }
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => {});
    throw new DownloadError("http", res.status);
  }
  const stated = Number(res.headers.get("content-length"));
  if (!res.headers.get("content-encoding") && stated > 0 && stated !== entry.bytes) {
    void res.body.cancel().catch(() => {});
    throw new DownloadError("size");
  }
  const reader = res.body.getReader();
  const hash = new Sha256();
  const parts: Blob[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      // More than stated: stopped before a hostile or changed file can fill memory
      if (received > entry.bytes) throw new DownloadError("size");
      hash.update(value);
      pending.push(value);
      pendingBytes += value.byteLength;
      if (pendingBytes >= BLOB_PART_BYTES) {
        parts.push(new Blob(pending as Uint8Array<ArrayBuffer>[]));
        pending = [];
        pendingBytes = 0;
      }
      opts.onProgress?.(received, entry.bytes);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof DownloadError) throw err;
    throw new DownloadError(opts.signal?.aborted ? "aborted" : offline() ? "offline" : "network");
  }
  if (received !== entry.bytes) throw new DownloadError("size");
  if (hash.digestHex() !== entry.sha256) throw new DownloadError("checksum");
  return new Blob([...parts, new Blob(pending as Uint8Array<ArrayBuffer>[])], { type: "application/zip" });
}
