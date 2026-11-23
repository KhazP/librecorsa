/**
 * The service worker that keeps downloaded circuits, cars and sounds (public/sw.js), run as it is against a stand-in
 * server and Cache Storage: a kept file is served after a 304 and never downloaded again, across pages and across a
 * new worker (a deploy); a file changed under the same name is downloaded and replaces the kept one; offline, a slow
 * server or a server error serves the kept copy; a 404 drops it; the kept files stay within the budget, least
 * recently used first, and files idle too long go; the earlier worker's per-build caches are deleted. Also its other
 * two jobs: imported mod packages served from their own cache and never swept, and the shell (the game's pages and
 * scripts) kept per build for offline play, a page served from it only when the server doesn't answer.
 *
 *   npx tsx scripts/verify-asset-cache.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(76)} ${detail}`);
  if (!ok) failed++;
}

const ORIGIN = "https://librecorsa.test";
const SOURCE = readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
const DAY = 24 * 3600 * 1000;
const KB = 1024;

/** Marks a response the way a same-origin fetch does (a constructed one is "default") */
const basic = (res: Response): Response => Object.defineProperty(res, "type", { value: "basic" });

// --- A stand-in for the site: ETag/304, X-File-Size, brotli-style bodies with no Content-Length ---

interface HostedFile {
  body: Uint8Array;
  etag?: string;
  lastModified?: string;
  headers?: Record<string, string>;
}
interface Served {
  path: string;
  status: number;
  conditional: string | null;
  /** Body bytes the client read */
  sent: number;
}

class Site {
  files = new Map<string, HostedFile>();
  log: Served[] = [];
  hung: Request[] = [];
  mode: "up" | "offline" | "hang" | "error" | "ignore-conditions" = "up";

  put(p: string, size: number, seed: number, extra: Partial<HostedFile> = {}): void {
    const body = new Uint8Array(size).map((_, i) => (i * 31 + seed) & 255);
    this.files.set(p, { body, etag: `W/"${p}-${seed}"`, headers: { "Content-Encoding": "br", "X-File-Size": String(size) }, ...extra });
  }

  fetch = async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const p = new URL(req.url).pathname;
    if (this.mode === "offline") throw new TypeError("Failed to fetch");
    if (this.mode === "hang") {
      // Held, as a browser holds a request in flight: Node follows the caller's abort signal only while it is reachable
      this.hung.push(req);
      return new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    const entry: Served = { path: p, status: 0, conditional: req.headers.get("if-none-match") ?? req.headers.get("if-modified-since"), sent: 0 };
    this.log.push(entry);
    const file = this.files.get(p);
    if (this.mode === "error") return basic(new Response("oops", { status: (entry.status = 503) }));
    if (!file) return basic(new Response("not here", { status: (entry.status = 404), headers: { "Cache-Control": "no-store" } }));
    const headers = new Headers({ "Cache-Control": "public, max-age=0, must-revalidate", ...file.headers });
    if (file.etag) headers.set("ETag", file.etag);
    if (file.lastModified) headers.set("Last-Modified", file.lastModified);
    const strip = (e: string) => e.replace(/^W\//, "");
    const inm = req.headers.get("if-none-match");
    if (this.mode !== "ignore-conditions" && inm && file.etag && strip(inm) === strip(file.etag)) {
      return basic(new Response(null, { status: (entry.status = 304), headers: { ETag: strip(file.etag) } }));
    }
    const ims = req.headers.get("if-modified-since");
    if (this.mode !== "ignore-conditions" && !inm && ims && ims === file.lastModified) {
      return basic(new Response(null, { status: (entry.status = 304) }));
    }
    entry.status = 200;
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= file.body.length) return c.close();
        const chunk = file.body.slice(at, at + 16 * KB);
        at += chunk.length;
        entry.sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    return basic(new Response(body, { status: 200, headers }));
  };

  /** Requests and body bytes since `from` (an index into the log) */
  since(from: number): { requests: number; bytes: number; statuses: number[] } {
    const part = this.log.slice(from);
    return { requests: part.length, bytes: part.reduce((s, e) => s + e.sent, 0), statuses: part.map((e) => e.status) };
  }
}

// --- A stand-in Cache Storage with a quota ---

interface Stored {
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}
/** The Cache API matches a URL without its fragment */
const keyOf = (r: Request | string) => (typeof r === "string" ? r : r.url).replace(/#.*$/, "");

class FakeCache {
  entries = new Map<string, Stored>();
  /** Lookups made, to see how much work the clean-up does */
  matches = 0;
  constructor(private storage: FakeStorage) {}
  async match(r: Request | string, opts?: { ignoreSearch?: boolean }): Promise<Response | undefined> {
    this.matches++;
    const url = keyOf(r);
    const s = this.entries.get(opts?.ignoreSearch ? url.replace(/\?.*$/, "") : url);
    return s ? new Response(s.body.length || s.status === 200 ? s.body.slice() : null, { status: s.status, headers: s.headers }) : undefined;
  }
  async put(r: Request | string, res: Response): Promise<void> {
    const body = new Uint8Array(await res.arrayBuffer());
    const key = keyOf(r);
    const others = this.storage.used() - (this.entries.get(key)?.body.length ?? 0);
    if (others + body.length > this.storage.hardLimit) throw new DOMException("full", "QuotaExceededError");
    this.entries.set(key, { status: res.status, headers: [...res.headers], body });
  }
  async delete(r: Request | string): Promise<boolean> {
    return this.entries.delete(keyOf(r));
  }
  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((u) => new Request(u));
  }
}

class FakeStorage {
  caches = new Map<string, FakeCache>();
  /** Where a write fails (the browser's real limit) */
  hardLimit = Infinity;
  /** What navigator.storage.estimate() reports */
  quota = 100 * 1024 * KB;
  async open(name: string): Promise<FakeCache> {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(this));
    return this.caches.get(name)!;
  }
  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
  used(): number {
    let n = 0;
    for (const c of this.caches.values()) for (const s of c.entries.values()) n += s.body.length;
    return n;
  }
  /** The kept files' URLs (paths) */
  kept(): string[] {
    return [...(this.caches.get("librecorsa-files-v1")?.entries.keys() ?? [])].map((u) => new URL(u).pathname).sort();
  }
  record(p: string): { used: number; size: number } | null {
    const s = this.caches.get("librecorsa-files-v1-used")?.entries.get(ORIGIN + p);
    return s ? JSON.parse(new TextDecoder().decode(s.body)) : null;
  }
}

// --- The worker ---

const clock = { now: Date.UTC(2026, 10, 15) };

interface Worker {
  fire(type: string, event: object): void;
  get(p: string, opts?: { client?: string; init?: RequestInit; origin?: string; navigate?: boolean; destination?: string }): Promise<{ intercepted: boolean; res?: Response; body?: Uint8Array }>;
  /** A page's message to the worker; resolves when the work it started is done */
  message(data: unknown): Promise<void>;
}

function startWorker(site: Site, storage: FakeStorage): Worker {
  const listeners = new Map<string, ((e: object) => void)[]>();
  const self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, fn: (e: object) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const navigator = { storage: { estimate: async () => ({ quota: storage.quota, usage: storage.used() }) } };
  const fakeDate = { now: () => clock.now };
  // The check's timeout, shortened
  const fastTimeout = (fn: () => void, ms: number) => setTimeout(fn, Math.min(ms, 30));
  new Function("self", "caches", "fetch", "navigator", "Date", "setTimeout", SOURCE)(self, storage, site.fetch, navigator, fakeDate, fastTimeout);
  const fire = (type: string, event: object) => (listeners.get(type) ?? []).forEach((fn) => fn(event));
  return {
    fire,
    async message(data) {
      const work: Promise<unknown>[] = [];
      fire("message", { data, waitUntil: (w: Promise<unknown>) => work.push(w) });
      await Promise.all(work);
    },
    async get(p, { client = "page", init, origin = ORIGIN, navigate = false, destination } = {}) {
      let answer: Promise<Response> | null = null;
      const later: Promise<unknown>[] = [];
      const request = new Request(origin + p, init);
      // A page load: Node won't construct a navigate-mode request
      if (navigate) Object.defineProperty(request, "mode", { value: "navigate" });
      if (destination) Object.defineProperty(request, "destination", { value: destination });
      fire("fetch", {
        request,
        clientId: client,
        respondWith: (r: Promise<Response>) => (answer = Promise.resolve(r)),
        waitUntil: (w: Promise<unknown>) => later.push(w),
      });
      if (!answer) return { intercepted: false };
      const res: Response = await answer;
      const body = new Uint8Array(await res.arrayBuffer());
      await Promise.all(later);
      return { intercepted: true, res, body };
    },
  };
}

const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

async function main() {
  const site = new Site();
  const storage = new FakeStorage();
  const GLB = "/tracks/spa/spa.glb";
  const DATA = "/tracks/spa/track_data.json";
  site.put(GLB, 300 * KB, 1);
  site.put(DATA, 40 * KB, 2, { headers: { "Content-Encoding": "gzip" } });
  // The earlier worker's cache for one build
  await (await storage.open("librecorsa-assets-0123456789ab")).put(`${ORIGIN}${GLB}`, new Response(new Uint8Array(10)));

  let sw = startWorker(site, storage);
  sw.fire("activate", { waitUntil: () => {} });

  // --- What the worker leaves alone ---
  check("A HEAD request is left to the network", !(await sw.get(GLB, { init: { method: "HEAD" } })).intercepted);
  check("A byte range is left to the network", !(await sw.get(GLB, { init: { headers: { Range: "bytes=0-99" } } })).intercepted);
  check("A URL with a query string is left to the network", !(await sw.get(`${GLB}?v=2`)).intercepted);
  check("Another origin is left to the network", !(await sw.get(GLB, { origin: "https://example.com" })).intercepted);
  check("API calls and page data are left to the network", !(await sw.get("/api/laps")).intercepted && !(await sw.get("/play.txt")).intercepted);
  check("A no-store request is left to the network", !(await sw.get(GLB, { init: { cache: "no-store" } })).intercepted);

  // --- First download ---
  let mark = site.log.length;
  let r = await sw.get(GLB, { client: "page1" });
  let s = site.since(mark);
  check("First visit: downloaded once, in full", same(r.body, site.files.get(GLB)!.body) && s.requests === 1 && s.bytes === 300 * KB, JSON.stringify(s));
  check("It is kept, with its size on record", storage.kept().includes(GLB) && storage.record(GLB)?.size === 300 * KB, JSON.stringify(storage.record(GLB)));
  check("The earlier worker's per-build cache is deleted", !storage.caches.has("librecorsa-assets-0123456789ab"));
  r = await sw.get(DATA, { client: "page1" });
  check("A gzip-sent file with no stated size is counted as it is kept", storage.record(DATA)?.size === 40 * KB, JSON.stringify(storage.record(DATA)));

  // --- The same page asks again ---
  mark = site.log.length;
  r = await sw.get(GLB, { client: "page1" });
  check("Same page again: served from the kept copy without asking", same(r.body, site.files.get(GLB)!.body) && site.since(mark).requests === 0);

  // --- A new page (a reload) ---
  mark = site.log.length;
  r = await sw.get(GLB, { client: "page2" });
  s = site.since(mark);
  check("A new page asks once with the kept ETag and gets a 304", s.requests === 1 && s.statuses[0] === 304 && site.log[mark].conditional === `W/"${GLB}-1"`, JSON.stringify(s));
  check("It is served the kept copy (no body sent)", same(r.body, site.files.get(GLB)!.body) && s.bytes === 0);
  check("The kept copy still says its full size for the loading bar", r.res?.headers.get("x-file-size") === String(300 * KB));

  // --- A deploy: a new worker, its memory empty, the same storage ---
  sw = startWorker(site, storage);
  sw.fire("install", {});
  sw.fire("activate", { waitUntil: () => {} });
  check("A new worker keeps the files", storage.kept().join() === [DATA, GLB].sort().join());
  mark = site.log.length;
  r = await sw.get(GLB, { client: "page3" });
  const d = await sw.get(DATA, { client: "page3" });
  s = site.since(mark);
  check("After a deploy: both files 304, nothing downloaded again", s.statuses.join() === "304,304" && s.bytes === 0, JSON.stringify(s));
  check("And served whole", same(r.body, site.files.get(GLB)!.body) && same(d.body, site.files.get(DATA)!.body));

  // --- The clean-up runs at most hourly, across workers too ---
  await (await storage.open("librecorsa-assets-fedcba987654")).put(`${ORIGIN}${GLB}`, new Response(new Uint8Array(10)));
  sw = startWorker(site, storage);
  await sw.get(GLB, { client: "page3b" });
  check("Within the hour a new worker doesn't run the clean-up again", storage.caches.has("librecorsa-assets-fedcba987654"));
  clock.now += 2 * 3600_000;
  sw = startWorker(site, storage);
  await sw.get(GLB, { client: "page3c" });
  check("An hour on, the next worker does", !storage.caches.has("librecorsa-assets-fedcba987654"));

  // --- A file replaced under the same name ---
  site.put(DATA, 44 * KB, 3, { headers: { "Content-Encoding": "gzip" } });
  mark = site.log.length;
  r = await sw.get(DATA, { client: "page4" });
  s = site.since(mark);
  check("A file changed in place is downloaded fresh", s.statuses.join() === "200" && same(r.body, site.files.get(DATA)!.body), JSON.stringify(s));
  mark = site.log.length;
  r = await sw.get(DATA, { client: "page5" });
  s = site.since(mark);
  check("And kept in place of the old one (next page: 304 on the new ETag)", s.statuses.join() === "304" && site.log[mark].conditional === `W/"${DATA}-3"` && same(r.body, site.files.get(DATA)!.body));
  check("Its record has the new size", storage.record(DATA)?.size === 44 * KB);

  // --- A server that ignores the condition ---
  site.mode = "ignore-conditions";
  mark = site.log.length;
  r = await sw.get(GLB, { client: "page6" });
  s = site.since(mark);
  check("A 200 with the same ETag: the body is cut off, the kept copy served", same(r.body, site.files.get(GLB)!.body) && s.bytes < 300 * KB, JSON.stringify(s));
  site.mode = "up";

  // --- Offline, slow, broken ---
  site.mode = "offline";
  r = await sw.get(GLB, { client: "page7" });
  check("Offline: the kept copy", r.res?.status === 200 && same(r.body, site.files.get(GLB)!.body));
  site.mode = "hang";
  r = await sw.get(DATA, { client: "page7" });
  check("No answer in time: the kept copy", r.res?.status === 200 && same(r.body, site.files.get(DATA)!.body));
  site.mode = "error";
  r = await sw.get(GLB, { client: "page8" });
  check("A server error: the kept copy", r.res?.status === 200 && same(r.body, site.files.get(GLB)!.body));
  site.mode = "up";

  // --- A file taken off the site ---
  site.files.delete(DATA);
  r = await sw.get(DATA, { client: "page9" });
  check("A 404 is passed on, and the kept copy and its record dropped", r.res?.status === 404 && !storage.kept().includes(DATA) && !storage.record(DATA));

  // --- Files that are not kept ---
  site.put("/cars/x/a.ogg", 8 * KB, 4, { etag: undefined, headers: {} });
  await sw.get("/cars/x/a.ogg", { client: "page10" });
  check("A file with no ETag or Last-Modified is served but not kept", !storage.kept().includes("/cars/x/a.ogg"));
  site.put("/cars/x/b.ogg", 8 * KB, 5, { headers: { "Cache-Control": "no-store" } });
  await sw.get("/cars/x/b.ogg", { client: "page10" });
  check("A no-store answer is not kept", !storage.kept().includes("/cars/x/b.ogg"));
  site.put("/cars/x/c.ogg", 8 * KB, 6, { etag: undefined, lastModified: "Sun, 15 Nov 2026 08:00:00 GMT", headers: { "Content-Length": String(8 * KB) } });
  await sw.get("/cars/x/c.ogg", { client: "page10" });
  mark = site.log.length;
  await sw.get("/cars/x/c.ogg", { client: "page11" });
  check("Last-Modified alone works as the check (304)", storage.kept().includes("/cars/x/c.ogg") && site.since(mark).statuses.join() === "304");

  // --- The KTX2 transcoder: a static file (no X-File-Size) that a phone fetches with every circuit ---
  const WASM = "/basis/basis_transcoder.wasm";
  site.put(WASM, 64 * KB, 7, { etag: '"wasm-7"', headers: { "Content-Encoding": "br" } });
  await sw.get(WASM, { client: "page12" });
  mark = site.log.length;
  r = await sw.get(WASM, { client: "page13" });
  check("The KTX2 transcoder is kept and checked like a circuit file (304)", storage.kept().includes(WASM) && site.since(mark).statuses.join() === "304" && same(r.body, site.files.get(WASM)!.body));
  check("Other files under /basis/ are left to the network", !(await sw.get("/basis/other.js")).intercepted);

  // --- The budget: least recently used first ---
  const fresh = new Site();
  const box = new FakeStorage();
  box.quota = 2 * 1024 * KB; // budget: half of it, 1 MB
  sw = startWorker(fresh, box);
  for (const [i, name] of ["a", "b", "c", "d", "e"].entries()) fresh.put(`/tracks/${name}/${name}.glb`, 300 * KB, 10 + i);
  for (const name of ["a", "b", "c"]) {
    clock.now += 20 * 60_000;
    await sw.get(`/tracks/${name}/${name}.glb`, { client: `p-${name}` });
  }
  check("Up to the budget everything is kept", box.kept().length === 3);
  clock.now += 20 * 60_000;
  await sw.get("/tracks/a/a.glb", { client: "p-again" });
  clock.now += 20 * 60_000;
  await sw.get("/tracks/d/d.glb", { client: "p-d" });
  check("Past it, the least recently used goes (b; a was used again)", box.kept().join() === "/tracks/a/a.glb,/tracks/c/c.glb,/tracks/d/d.glb", box.kept().join());
  clock.now += 20 * 60_000;
  // A size the server doesn't state: made room for once it is written
  fresh.put("/tracks/e/e.glb", 300 * KB, 14, { headers: { "Content-Encoding": "br" } });
  await sw.get("/tracks/e/e.glb", { client: "p-e" });
  check("Then c, also for a file whose size is only known once kept", box.kept().join() === "/tracks/a/a.glb,/tracks/d/d.glb,/tracks/e/e.glb", box.kept().join());

  // --- Several downloads at once in a new worker: one clean-up pass, not one each ---
  const busy = new FakeStorage();
  const busySite = new Site();
  const names = Array.from({ length: 30 }, (_, i) => `/cars/k/s${i}.ogg`);
  names.forEach((n, i) => busySite.put(n, 2 * KB, 100 + i, { headers: { "Content-Length": String(2 * KB) } }));
  sw = startWorker(busySite, busy);
  for (const n of names.slice(0, 20)) await sw.get(n, { client: "warm" });
  sw = startWorker(busySite, busy); // within the hour: its first look finds the clean-up not due
  const used = await busy.open("librecorsa-files-v1-used");
  const before = used.matches;
  await Promise.all(names.slice(20).map((n) => sw.get(n, { client: "burst" })));
  const lookups = used.matches - before;
  check("Ten downloads at once: one clean-up pass over the records", busy.kept().length === 30 && lookups <= 25, `${lookups} record lookups for 20 kept files`);

  // --- Idle files go ---
  clock.now += 46 * DAY;
  fresh.put("/tracks/z/z.glb", 10 * KB, 20);
  sw = startWorker(fresh, box);
  await sw.get("/tracks/z/z.glb", { client: "p-z" });
  check("Files unused for 45 days are dropped when the worker starts", box.kept().join() === "/tracks/z/z.glb", box.kept().join());

  // --- Out of space on a write ---
  const tight = new FakeStorage();
  const tightSite = new Site();
  sw = startWorker(tightSite, tight);
  tight.hardLimit = 700 * KB; // the browser stops below the budget the estimate gave
  tightSite.put("/tracks/f/f.glb", 300 * KB, 30);
  tightSite.put("/tracks/g/g.glb", 300 * KB, 31);
  tightSite.put("/tracks/h/h.glb", 300 * KB, 32, { headers: { "Content-Encoding": "br" } });
  await sw.get("/tracks/f/f.glb", { client: "q" });
  clock.now += 20 * 60_000;
  await sw.get("/tracks/g/g.glb", { client: "q" });
  clock.now += 20 * 60_000;
  r = await sw.get("/tracks/h/h.glb", { client: "q" });
  check("A write that runs out of space still serves the file", same(r.body, tightSite.files.get("/tracks/h/h.glb")!.body));
  check("And frees the least recently used for next time", tight.kept().join() === "/tracks/g/g.glb", tight.kept().join());
  await sw.get("/tracks/h/h.glb", { client: "q2" });
  check("So the next visit keeps it", tight.kept().join() === "/tracks/g/g.glb,/tracks/h/h.glb", tight.kept().join());

  // --- A record lost: the clean-up gives the file one ---
  await (await tight.open("librecorsa-files-v1-used")).delete(`${ORIGIN}/tracks/g/g.glb`);
  clock.now += 2 * 3600_000;
  sw = startWorker(tightSite, tight);
  await sw.get("/tracks/h/h.glb", { client: "q3" });
  check("A kept file without a record gets one, sized from its headers", tight.record("/tracks/g/g.glb")?.size === 300 * KB, JSON.stringify(tight.record("/tracks/g/g.glb")));

  await modChecks();
  await shellChecks();

  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll asset cache checks passed");
}

const enc = (text: string) => new TextEncoder().encode(text);
const host = (site: Site, p: string, text: string, etag: string) => site.files.set(p, { body: enc(text), etag, headers: { "Content-Type": "text/html" } });
const textOf = (r: { body?: Uint8Array }) => (r.body ? new TextDecoder().decode(r.body) : "");

/** Imported mod packages: their own cache, never swept */
async function modChecks(): Promise<void> {
  const site = new Site();
  const box = new FakeStorage();
  box.quota = 2 * 1024 * KB; // a 1 MB budget for kept files
  const sw = startWorker(site, box);
  const MOD_GLB = "/mods/jdoe.pack/ring/ring.glb";
  await (await box.open("librecorsa-mods-v1")).put(ORIGIN + MOD_GLB, new Response(new Uint8Array(900 * KB).fill(7), { headers: { "X-File-Size": String(900 * KB) } }));
  let mark = site.log.length;
  let r = await sw.get(MOD_GLB);
  check("An imported mod's file comes from its own cache, the server never asked", r.intercepted && r.body?.length === 900 * KB && site.since(mark).requests === 0);
  r = await sw.get(MOD_GLB, { init: { headers: { Range: "bytes=0-9" } } });
  check("Even for a byte range (the server hasn't got it)", r.intercepted && r.body?.length === 900 * KB);
  host(site, "/mods/_index.json", '{"format":1,"packages":[]}', '"idx"');
  mark = site.log.length;
  r = await sw.get("/mods/_index.json");
  check("A /mods/ file not imported comes from the server (public/mods/, the launcher)", r.res?.status === 200 && site.since(mark).requests === 1);
  for (const [i, name] of ["a", "b", "c", "d"].entries()) {
    site.put(`/tracks/${name}/${name}.glb`, 300 * KB, 40 + i);
    clock.now += 20 * 60_000;
    await sw.get(`/tracks/${name}/${name}.glb`, { client: `m-${name}` });
  }
  check("Circuit files past the budget are swept", box.kept().length < 4, box.kept().join());
  clock.now += 46 * DAY;
  site.put("/tracks/e/e.glb", 10 * KB, 50);
  await startWorker(site, box).get("/tracks/e/e.glb", { client: "m-e" });
  check("But the sweep (budget or 45 idle days) never touches an imported mod", !!(await (await box.open("librecorsa-mods-v1")).match(ORIGIN + MOD_GLB)));
}

/** The shell: the game's pages and scripts, per build, for offline play */
async function shellChecks(): Promise<void> {
  const site = new Site();
  const box = new FakeStorage();
  let sw = startWorker(site, box);
  const manifest = (build: string, files: string[]) => host(site, "/offline-manifest.json", JSON.stringify({ build, files }), `"${build}"`);
  host(site, "/", "<html>home v1</html>", '"h1"');
  host(site, "/play", "<html>play v1</html>", '"p1"');
  host(site, "/_next/static/chunks/a.js", "console.log('a')", '"a"');
  manifest("b1", ["/", "/play", "/_next/static/chunks/a.js"]);

  site.mode = "offline";
  const offlineFirst = await sw.get("/play", { navigate: true }).catch(() => null);
  check("Offline before any shell: the page fails as it would without the worker", offlineFirst === null);
  site.mode = "up";

  let mark = site.log.length;
  let r = await sw.get("/play", { navigate: true });
  check("Online, a page always comes from the server", textOf(r) === "<html>play v1</html>" && site.since(mark).requests === 1);

  await sw.message({ type: "librecorsa:sync-shell" });
  const shell = box.caches.get("librecorsa-shell-b1");
  check("A sync keeps every file the build lists, and marks the shell whole", !!shell && shell.entries.size === 4, `${shell?.entries.size} entries`);

  site.mode = "offline";
  r = await sw.get("/play", { navigate: true });
  check("Offline, a page comes from the shell", textOf(r) === "<html>play v1</html>");
  r = await sw.get("/play.html", { navigate: true });
  const root = await sw.get("/", { navigate: true });
  check("Its .html and the home page too", textOf(r) === "<html>play v1</html>" && textOf(root) === "<html>home v1</html>");
  r = await sw.get("/_next/static/chunks/a.js");
  check("And the scripts it names", textOf(r) === "console.log('a')");
  r = await sw.get("/_next/static/chunks/a.js?dpl=abc");
  check("A script asked for with a query (a deployment id) is the same file, offline too", textOf(r) === "console.log('a')");
  r = await sw.get("/_next/static/chunks/a.js#params=%5B%5D", { destination: "worker" });
  check("A worker's script is served as a new response, so the worker keeps its URL's #params", textOf(r) === "console.log('a')" && !!r.res && r.res.url === "");
  site.mode = "error";
  r = await sw.get("/play", { navigate: true });
  check("A server error serves the shell's page", textOf(r) === "<html>play v1</html>");
  site.mode = "up";

  mark = site.log.length;
  r = await sw.get("/_next/static/chunks/a.js");
  check("A hashed script comes from the shell even online, the server not asked", textOf(r) === "console.log('a')" && site.since(mark).requests === 0);

  // A deploy: new pages, one new script, one kept
  host(site, "/play", "<html>play v2</html>", '"p2"');
  host(site, "/_next/static/chunks/b.js", "console.log('b')", '"b"');
  manifest("b2", ["/", "/play", "/_next/static/chunks/a.js", "/_next/static/chunks/b.js"]);
  mark = site.log.length;
  await sw.message({ type: "librecorsa:sync-shell" });
  const fetched = site.log.slice(mark).map((e) => e.path);
  check("The next build's shell copies the scripts it shares, downloading only what's new", !fetched.includes("/_next/static/chunks/a.js") && fetched.includes("/_next/static/chunks/b.js") && fetched.includes("/play"), fetched.join(", "));
  check("And the older shell goes once the new one is whole", box.caches.has("librecorsa-shell-b2") && !box.caches.has("librecorsa-shell-b1"));
  mark = site.log.length;
  await sw.message({ type: "librecorsa:sync-shell" });
  check("A sync with the shell current downloads nothing but the list", site.since(mark).requests === 1);

  // A download cut short: the last whole shell stays
  manifest("b3", ["/", "/play", "/_next/static/chunks/missing.js"]);
  await sw.message({ type: "librecorsa:sync-shell" });
  sw = startWorker(site, box);
  site.mode = "offline";
  r = await sw.get("/play", { navigate: true });
  check("A sync cut short leaves the last whole shell serving", textOf(r) === "<html>play v2</html>" && box.caches.has("librecorsa-shell-b2"));
  site.mode = "up";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
