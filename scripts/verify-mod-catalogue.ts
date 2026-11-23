/**
 * Mod catalogues (src/lib/mods/mod-catalogue.ts): the format's checks and the links a catalogue may hold, where the
 * game reads catalogues from, reading one (missing, too big, unreachable, slow), a package's status against what is
 * installed, the streamed download and its size and SHA-256 checks, and an install refused when the download isn't
 * the package and content its catalogue lists.
 *
 *   npx tsx scripts/verify-mod-catalogue.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOGUE_MAX_BYTES,
  CATALOGUE_MAX_PACKAGES,
  catalogueLink,
  catalogueSources,
  catalogueStatus,
  downloadPackage,
  DownloadError,
  loadCatalogues,
  parseCatalogue,
  readCatalogue,
  type CatalogueEntry,
} from "../src/lib/mods/mod-catalogue";
import { Sha256 } from "../src/lib/mods/sha256-stream";
import { modDefinitions } from "../src/lib/mods/mod-content";
import { installPackage, readInstalled, zipSource } from "../src/lib/mods/mod-store";
import { checkPackage, hashFolder } from "./mods/lib/package-check";
import { zipPackage } from "./mods/lib/zip-writer";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failed++;
}

const SITE = "https://librecorsa.test";
const LAUNCHER = "http://127.0.0.1:47600";
const CDN = "https://packs.example.org";
const HEX = (c: string) => c.repeat(64);
const tmp = mkdtempSync(join(tmpdir(), "mod-catalogue-"));

/** A catalogue entry as a host writes one, valid unless changed */
const entry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "jdoe.blue-gt",
  name: "Blue GT",
  version: "1.0.0",
  description: "A blue livery.",
  author: "J. Doe",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  url: "jdoe.blue-gt.zip",
  bytes: 1234,
  sha256: HEX("a"),
  hash: HEX("b"),
  liveries: 1,
  ...extra,
});

/** Builds a small package folder: one livery for one of the game's cars */
function makePackage(dir: string, version: string, paint: string): string {
  mkdirSync(join(dir, "skins", "blue"), { recursive: true });
  writeFileSync(
    join(dir, "mod.json"),
    JSON.stringify({
      format: 1,
      id: "jdoe.blue-gt",
      name: "Blue GT",
      version,
      credit: { author: "J. Doe", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
      skins: [{ car: "amg-gt3", id: "blue", name: "#7 Blue", swatch: ["#1040c0", "#ffffff"] }],
    }),
  );
  writeFileSync(join(dir, "skins", "blue", "paint.png"), paint);
  return dir;
}

/** A response served in pieces, as a network sends one, counting what was read */
function served(body: Uint8Array, init: { status?: number; headers?: Record<string, string>; piece?: number } = {}): { res: Response; sent: () => number } {
  let at = 0;
  const piece = init.piece ?? 1000;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= body.length) return c.close();
      c.enqueue(body.slice(at, at + piece));
      at += piece;
    },
  });
  return { res: new Response(stream, { status: init.status ?? 200, headers: init.headers }), sent: () => Math.min(at, body.length) };
}

async function main(): Promise<void> {
  // --- SHA-256 a piece at a time ---
  let same = true;
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
    const data = new Uint8Array(n).map((_, i) => (i * 131 + n) & 255);
    const h = new Sha256();
    for (let at = 0, step = 1; at < n; at += step, step = (step * 7) % 97 + 1) h.update(data.subarray(at, at + step));
    if (h.digestHex() !== createHash("sha256").update(data).digest("hex")) same = false;
  }
  check("SHA-256 a piece at a time is the platform's SHA-256, whatever the pieces", same);

  // --- Links ---
  const own = `${SITE}/mods/_catalogue/catalogue.json`;
  check("A relative link is read against the catalogue's own address", catalogueLink("x.zip", own, SITE) === `${SITE}/mods/_catalogue/x.zip`);
  check("An https:// link on another host is followed", catalogueLink(`${CDN}/x.zip`, own, SITE) === `${CDN}/x.zip`);
  check("A path on the launcher (http, same site) is followed", catalogueLink("/mods/_catalogue/x.zip", `${LAUNCHER}/mods/_catalogue/catalogue.json`, LAUNCHER) === `${LAUNCHER}/mods/_catalogue/x.zip`);
  check("http:// on another host is refused", catalogueLink("http://packs.example.org/x.zip", own, SITE) === null);
  check("…even from a catalogue on the launcher (http)", catalogueLink("http://evil.example/x.zip", `${LAUNCHER}/c.json`, LAUNCHER) === null);
  check("A relative link from an http catalogue elsewhere stays refused", catalogueLink("x.zip", "http://evil.example/c.json", SITE) === null);
  check(
    "data:, blob:, javascript: and file: are refused",
    ["data:application/zip;base64,AAAA", `blob:${SITE}/1234`, "javascript:alert(1)", "file:///etc/passwd"].every((v) => catalogueLink(v, own, SITE) === null),
  );
  check("A name and password in a link are refused", catalogueLink("https://user:pass@packs.example.org/x.zip", own, SITE) === null);
  check("Whitespace, control characters and backslashes are refused", [" x.zip", "x .zip", "x\t.zip", "\\\\evil\\x.zip", "x\u0000.zip"].every((v) => catalogueLink(v, own, SITE) === null));
  check("A protocol-relative link leaves an http site's origin: refused", catalogueLink("//evil.example/x.zip", `${LAUNCHER}/c.json`, LAUNCHER) === null);
  check("Not a string, empty, or longer than 1000: refused", [undefined, 3, "", `https://a.example/${"x".repeat(1000)}`].every((v) => catalogueLink(v, own, SITE) === null));

  // --- Where catalogues are read from ---
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  const page = `${SITE}/play`;
  let sources = catalogueSources("", page);
  check("No setting: this copy's own catalogue only", sources.length === 1 && sources[0].url === own && !sources[0].named, JSON.stringify(sources));
  sources = catalogueSources(`${CDN}/catalogue.json`, page);
  check("A setting adds the catalogue it names, after this copy's own", sources.length === 2 && sources[1].url === `${CDN}/catalogue.json` && sources[1].named);
  sources = catalogueSources("/packs/catalogue.json", page);
  check("A path in the setting is on the game's site", sources[1]?.url === `${SITE}/packs/catalogue.json`);
  sources = catalogueSources("/mods/_catalogue/catalogue.json", page);
  check("A setting naming this copy's own catalogue reads it once, as named", sources.length === 1 && sources[0].named);
  const before = warnings.length;
  check(
    "An http://, protocol-relative or relative setting is left out, with a warning",
    ["http://packs.example.org/c.json", "//packs.example.org/c.json", "packs/c.json", "ftp://x/c.json"].every((v) => catalogueSources(v, page).length === 1) && warnings.length - before === 4,
  );
  console.warn = warn;

  // --- The format ---
  let parsed = parseCatalogue({ format: 1, packages: [entry()] }, own, SITE);
  const first = parsed.packages[0];
  check("A valid entry is kept, its zip's link made absolute", parsed.packages.length === 1 && parsed.problems.length === 0 && first.url === `${SITE}/mods/_catalogue/jdoe.blue-gt.zip`, parsed.problems.join("; "));
  check("Its fields are as written, counts left out when absent", first.name === "Blue GT" && first.liveries === 1 && !("circuits" in first) && !("preview" in first));
  check("Keys the format doesn't know are ignored", parseCatalogue({ format: 1, packages: [entry({ rating: 5 })] }, own, SITE).packages.length === 1);
  check("Another format is refused whole", parseCatalogue({ format: 2, packages: [entry()] }, own, SITE).packages.length === 0);
  check(
    "Not an object, or packages not a list: nothing read",
    [null, [], "catalogue", { format: 1 }, { format: 1, packages: {} }].every((raw) => {
      const p = parseCatalogue(raw, own, SITE);
      return p.packages.length === 0 && p.problems.length === 1;
    }),
  );
  const broken: [string, Record<string, unknown>][] = [
    ["an id that isn't author.name", { id: "Blue GT" }],
    ["no name", { name: undefined }],
    ["a name past 80 characters", { name: "x".repeat(81) }],
    ["a version past 32 characters", { version: "1".repeat(33) }],
    ["no author", { author: "" }],
    ["no licence", { license: undefined }],
    ["an http:// licence link", { licenseUrl: "http://creativecommons.org/" }],
    ["a licence link that isn't https://, even on the game's site", { licenseUrl: "/licence.txt" }],
    ["no zip link", { url: undefined }],
    ["an http:// zip on another host", { url: "http://packs.example.org/x.zip" }],
    ["a zip of no size", { bytes: 0 }],
    ["a zip past 2 GB", { bytes: 2 * 1024 ** 3 + 1 }],
    ["a size that isn't whole", { bytes: 12.5 }],
    ["a SHA-256 in capitals", { sha256: HEX("A") }],
    ["a SHA-256 too short", { sha256: "abc" }],
    ["no content hash", { hash: undefined }],
    ["a negative count", { circuits: -1 }],
    ["a count that isn't a number", { cars: "2" }],
    ["a preview on an http:// host", { preview: "http://packs.example.org/x.webp" }],
    ["a description past 1000 characters", { description: "x".repeat(1001) }],
  ];
  for (const [what, change] of broken) {
    const p = parseCatalogue({ format: 1, packages: [entry(change), entry({ id: "jdoe.other" })] }, own, SITE);
    check(`An entry with ${what} is dropped, the others kept`, p.packages.length === 1 && p.packages[0].id === "jdoe.other" && p.problems.length === 1 && p.problems[0].startsWith("packages[0]"), p.problems.join("; "));
  }
  parsed = parseCatalogue({ format: 1, packages: [entry(), entry({ name: "Second" }), "x"] }, own, SITE);
  check("A second entry for one package is dropped (the first kept), and so is a non-object", parsed.packages.length === 1 && parsed.packages[0].name === "Blue GT" && parsed.problems.length === 2);
  parsed = parseCatalogue({ format: 1, packages: Array.from({ length: CATALOGUE_MAX_PACKAGES + 5 }, (_, i) => entry({ id: `jdoe.p${i}` })) }, own, SITE);
  check(`Only the first ${CATALOGUE_MAX_PACKAGES} entries are read`, parsed.packages.length === CATALOGUE_MAX_PACKAGES && parsed.problems.length === 1);
  check("A problem names the entry and every rule it broke", parseCatalogue({ format: 1, packages: [entry({ bytes: -1, sha256: "x" })] }, own, SITE).problems[0] === "packages[0] (jdoe.blue-gt): bytes must be the zip's size in bytes (at most 2147483648); sha256 must be the zip's SHA-256 in lowercase hex");

  // --- Reading one ---
  const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", ...headers } });
  const fetchOf = (answer: (url: string) => Response | Promise<Response>) => (async (input: RequestInfo | URL) => answer(String(input))) as typeof fetch;
  console.warn = () => {};
  let read = await readCatalogue(own, SITE, { fetch: fetchOf(() => json({ format: 1, packages: [entry()] })) });
  check("A catalogue that answers is read and checked", read.state === "ok" && read.catalogue.packages.length === 1);
  read = await readCatalogue(own, SITE, { fetch: fetchOf(() => new Response("<h1>Not found</h1>", { status: 404 })) });
  check("A 404 is no catalogue", read.state === "absent");
  read = await readCatalogue(own, SITE, { fetch: fetchOf(() => new Response("<!doctype html><title>app</title>")) });
  check("A page in its place (a host's fallback) is no catalogue", read.state === "absent");
  read = await readCatalogue(own, SITE, { fetch: fetchOf(() => json({ format: 1, packages: [] }, { "Content-Length": String(CATALOGUE_MAX_BYTES + 1) })) });
  check("One that says it is past 1 MB isn't read", read.state === "absent");
  const huge = served(new TextEncoder().encode(`{"format":1,"packages":[],"pad":"${"x".repeat(CATALOGUE_MAX_BYTES)}"}`), { piece: 64 * 1024 });
  read = await readCatalogue(own, SITE, { fetch: fetchOf(() => huge.res) });
  check("One past 1 MB with no stated size is cut off at 1 MB", read.state === "absent" && huge.sent() <= CATALOGUE_MAX_BYTES + 64 * 1024, `${huge.sent()} bytes read`);
  read = await readCatalogue(own, SITE, {
    fetch: fetchOf(() => {
      throw new TypeError("Failed to fetch");
    }),
  });
  check("No connection: unreachable", read.state === "unreachable");
  const started = Date.now();
  read = await readCatalogue(own, SITE, {
    timeoutMs: 50,
    fetch: (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch,
  });
  check("No answer in time: unreachable, given up at the timeout", read.state === "unreachable" && Date.now() - started < 2000);
  const redirected = json({ format: 1, packages: [entry()] });
  Object.defineProperty(redirected, "url", { value: `${CDN}/v2/catalogue.json` });
  read = await readCatalogue(`${CDN}/catalogue.json`, SITE, { fetch: fetchOf(() => redirected) });
  check("Links are read against where a redirect led", read.state === "ok" && read.catalogue.packages[0].url === `${CDN}/v2/jdoe.blue-gt.zip`);

  // --- Every catalogue at once ---
  const both = await loadCatalogues(`${CDN}/catalogue.json`, {
    pageUrl: page,
    fetch: fetchOf((url) =>
      url === own
        ? json({ format: 1, packages: [entry({ name: "From this copy" })] })
        : json({ format: 1, packages: [entry({ name: "From the CDN" }), entry({ id: "jdoe.track" })] }),
    ),
  });
  check("Packages from both catalogues, one in both listed from this copy's own", both.packages.map((p) => `${p.id}:${p.name}`).join() === "jdoe.blue-gt:From this copy,jdoe.track:Blue GT" && !both.unreachable);
  const offline = await loadCatalogues(`${CDN}/catalogue.json`, {
    pageUrl: page,
    fetch: fetchOf((url) => {
      if (url === own) return new Response("", { status: 404 });
      throw new TypeError("Failed to fetch");
    }),
  });
  check("The named catalogue out of reach: said so", offline.packages.length === 0 && offline.unreachable);
  const noneHere = await loadCatalogues("", {
    pageUrl: page,
    fetch: fetchOf(() => {
      throw new TypeError("Failed to fetch");
    }),
  });
  check("This copy's own out of reach, none named: nothing to say", noneHere.packages.length === 0 && !noneHere.unreachable);
  console.warn = warn;

  // --- Status against what is installed ---
  const offered = { id: "jdoe.blue-gt", hash: HEX("b"), version: "1.1" };
  check("Not installed: Get", catalogueStatus(offered, [{ id: "jdoe.other", hash: HEX("b"), version: "1.1" }]).kind === "get");
  check("The same content installed: Installed", catalogueStatus(offered, [{ id: "jdoe.blue-gt", hash: HEX("b"), version: "1.0" }]).kind === "installed");
  const update = catalogueStatus(offered, [{ id: "jdoe.blue-gt", hash: HEX("c"), version: "1.0" }]);
  check("Other content under the id: Update, naming the installed version", update.kind === "update" && update.installedVersion === "1.0");
  check("A folder package with no hash listed goes by its version", catalogueStatus(offered, [{ id: "jdoe.blue-gt", version: "1.1" }]).kind === "installed" && catalogueStatus(offered, [{ id: "jdoe.blue-gt", version: "1.0" }]).kind === "update");

  // --- The download ---
  const zipBytes = new Uint8Array(50_000).map((_, i) => (i * 7) & 255);
  const zipSha = createHash("sha256").update(zipBytes).digest("hex");
  const zipEntry = { url: `${CDN}/x.zip`, bytes: zipBytes.length, sha256: zipSha };
  const progress: number[] = [];
  let blob = await downloadPackage(zipEntry, { fetch: fetchOf(() => served(zipBytes).res), onProgress: (n) => progress.push(n) });
  check("A download is read whole, its progress heard piece by piece", blob.size === zipBytes.length && progress.length === 50 && progress.at(-1) === zipBytes.length);
  check("And it is the bytes served", Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(zipBytes)));
  const failure = async (e: Partial<typeof zipEntry>, answer: () => Response | Promise<Response>, signal?: AbortSignal): Promise<DownloadError | null> => {
    try {
      await downloadPackage({ ...zipEntry, ...e }, { fetch: fetchOf(answer), signal });
      return null;
    } catch (err) {
      return err instanceof DownloadError ? err : null;
    }
  };
  check("Another SHA-256: refused as a checksum failure", (await failure({ sha256: HEX("0") }, () => served(zipBytes).res))?.failure === "checksum");
  const long = served(new Uint8Array(500_000));
  check("Longer than stated: refused as soon as it passes the size", (await failure({}, () => long.res))?.failure === "size" && long.sent() < 60_000, `${long.sent()} bytes read`);
  check("Shorter than stated: refused", (await failure({}, () => served(zipBytes.slice(0, 1000)).res))?.failure === "size");
  check("A stated length that isn't the size: refused before reading", (await failure({}, () => served(zipBytes, { headers: { "Content-Length": "10" } }).res))?.failure === "size");
  const http = await failure({}, () => new Response("gone", { status: 404 }));
  check("A server error: refused, with its status", http?.failure === "http" && http.status === 404);
  check("No connection: a network failure", (await failure({}, () => Promise.reject(new TypeError("Failed to fetch"))))?.failure === "network");
  const onLine = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
  Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
  check("No connection while offline: said so", (await failure({}, () => Promise.reject(new TypeError("Failed to fetch"))))?.failure === "offline");
  if (onLine) Object.defineProperty(globalThis.navigator, "onLine", onLine);
  else delete (globalThis.navigator as { onLine?: boolean }).onLine;
  const cancel = new AbortController();
  let pieces = 0;
  const cancelled = await failure(
    {},
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (++pieces === 5) cancel.abort();
            if (cancel.signal.aborted) return c.error(new DOMException("aborted", "AbortError"));
            c.enqueue(new Uint8Array(1000));
          },
        }),
      ),
    cancel.signal,
  );
  check("Cancelled part way: an abort, not an error to show", cancelled?.failure === "aborted");

  // --- Install: only the package and content the catalogue lists ---
  const store = memoryCaches();
  Object.assign(globalThis, { caches: store, window: { location: { origin: SITE, href: page } } });
  const v1 = makePackage(join(tmp, "v1", "jdoe.blue-gt"), "1.0.0", "paint-one");
  const v2 = makePackage(join(tmp, "v2", "jdoe.blue-gt"), "2.0.0", "paint-two");
  const zipOf = (dir: string) => new Blob([new Uint8Array(zipPackage(dir, checkPackage(dir).files))]);
  const hashOf = (dir: string) => hashFolder(dir, checkPackage(dir).files);
  const known = modDefinitions();
  let result = await installPackage(await zipSource(zipOf(v1)), known, { id: "jdoe.blue-gt", hash: await hashOf(v1) });
  let installed = await readInstalled();
  check("The package the catalogue lists, with its content: installed", result.ok && installed[0]?.version === "1.0.0" && installed[0].hash === (await hashOf(v1)), result.ok ? "" : result.errors.join("; "));
  result = await installPackage(await zipSource(zipOf(v2)), known, { id: "jdoe.blue-gt", hash: await hashOf(v1) });
  installed = await readInstalled();
  const paint = await store.read(`${SITE}/mods/jdoe.blue-gt/skins/blue/paint.png`);
  check("Other content than listed: refused, the installed version untouched", !result.ok && /content hash differs/.test(result.errors[0]) && installed[0]?.version === "1.0.0" && paint === "paint-one", result.ok ? "" : result.errors.join("; "));
  check("Nothing left aside from the refused one", !(await store.keys()).some((u) => u.includes("_staging")));
  result = await installPackage(await zipSource(zipOf(v2)), known, { id: "jdoe.other", hash: await hashOf(v2) });
  check("Another package than listed: refused by its id", !result.ok && /holds the package "jdoe.blue-gt", not "jdoe.other"/.test(result.errors[0]));
  result = await installPackage(await zipSource(zipOf(v2)), known, { id: "jdoe.blue-gt", hash: await hashOf(v2) });
  installed = await readInstalled();
  check("The listed update: installed in the old one's place", result.ok && result.replaced && installed.length === 1 && installed[0].version === "2.0.0");
  check("Its status is then Installed", catalogueStatus({ id: "jdoe.blue-gt", hash: await hashOf(v2), version: "2.0.0" }, installed).kind === "installed");
  // The whole way: a package's zip downloaded, checked and installed
  const packed = new Uint8Array(await zipOf(v1).arrayBuffer());
  blob = await downloadPackage({ url: `${CDN}/v1.zip`, bytes: packed.length, sha256: createHash("sha256").update(packed).digest("hex") }, { fetch: fetchOf(() => served(packed).res) });
  result = await installPackage(await zipSource(blob), known, { id: "jdoe.blue-gt", hash: await hashOf(v1) });
  check("A package's zip downloaded and checked installs from what was read", result.ok && (await readInstalled())[0]?.version === "1.0.0");

  rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll mod catalogue checks passed");
}

/** Cache Storage in memory: what mod-store.ts uses of it */
function memoryCaches() {
  const caches = new Map<string, Map<string, { body: Uint8Array; headers: [string, string][] }>>();
  const open = (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const c = caches.get(name)!;
    const key = (r: RequestInfo | URL) => (r instanceof Request ? r.url : String(r));
    return {
      async match(r: RequestInfo | URL) {
        const s = c.get(key(r));
        return s ? new Response(s.body.slice(), { headers: s.headers }) : undefined;
      },
      async put(r: RequestInfo | URL, res: Response) {
        c.set(key(r), { body: new Uint8Array(await res.arrayBuffer()), headers: [...res.headers] });
      },
      async delete(r: RequestInfo | URL) {
        return c.delete(key(r));
      },
      async keys() {
        return [...c.keys()].map((u) => new Request(u));
      },
    };
  };
  return {
    open: async (name: string) => open(name),
    async read(url: string) {
      const res = await open("librecorsa-mods-v1").match(url);
      return res ? res.text() : null;
    },
    async keys() {
      return [...(caches.get("librecorsa-mods-v1")?.keys() ?? [])];
    },
  };
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
