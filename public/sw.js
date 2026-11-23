/*
 * Keeps the circuits, cars, textures and sounds a player has downloaded (tens of MB each), across deploys. Registered
 * by src/lib/service-worker.ts in production builds only. It also does two other jobs, each with its own cache:
 * - The game's pages and scripts for offline play ("the shell", below the files' code): a page always comes from the
 *   server when there is one, and from the shell only when there isn't.
 * - Mod packages the player imported (src/lib/mods/mod-store.ts), answered under /mods/ from the cache the page
 *   writes them to. Nothing here ever deletes them: only the player's Remove does.
 *
 * Most of these files keep their name when they change: a circuit's GLB and track_data.json, a layout's file, car
 * models and sounds get replaced in place on R2. So a kept copy is only used once the server says it is current: the
 * first time a page asks for a file, this asks the server with the copy's ETag. A 304 (a few hundred bytes) serves the
 * copy; a 200 is a new file, which is served and kept in its place. The page then uses that copy until it closes. The
 * answer always comes from what the server has now, so it doesn't matter which build's worker answers (the previous
 * build's worker can still control the first page after a deploy).
 *
 * The check asks the plain URL, so it gets Cloudflare's edge copy. A re-uploaded file reaches the edge at the next
 * deploy (cloudflare/worker.js), and a player gets it then, like a player without this worker.
 *
 * Offline, or with no answer within CHECK_TIMEOUT_MS, the kept copy is served. A file the server no longer has (404)
 * is dropped. Files unused for MAX_IDLE_MS are dropped, and once the kept files pass the budget (MAX_BYTES, or
 * QUOTA_SHARE of the site's storage quota if that is smaller) the least recently used go first.
 *
 * scripts/verify/verify-asset-cache.ts runs this file against a stand-in server and cache.
 */

/** The kept files, one per URL */
const FILES = "librecorsa-files-v1";
/** When each kept file was last used and its size, as one small record per URL, so a file is never rewritten to note a use */
const USED = "librecorsa-files-v1-used";
/** The earlier worker's caches, one per build (`librecorsa-assets-<build>`): deleted */
const LEGACY_PREFIX = "librecorsa-assets-";
/** Folders (under the site's base path) of hosted files: models, textures, sounds, track data */
const ASSET_PATH = /\/(tracks|cars|lc26|gt3|audio)\/[^?#]+\.(glb|gltf|bin|webp|png|jpg|jpeg|ktx2|ogg|wav|mp3|json)$/i;
/** The KTX2 texture transcoder (src/lib/render/ktx2.ts), which a phone fetches with every circuit: kept and checked the same way */
const TRANSCODER_PATH = /\/basis\/basis_transcoder\.(js|wasm)$/;
/** The site's base path, where this file is served (`/` or `/<base>/`) */
const BASE = self.location.pathname.replace(/[^/]*$/, "");
/** Imported mod packages (src/lib/mods/mod-store.ts `MODS_CACHE`), by URL */
const MODS = "librecorsa-mods-v1";
/** The shell: one cache per build (`librecorsa-shell-<build>`), the previous build's deleted once the next is whole */
const SHELL_PREFIX = "librecorsa-shell-";
/** What the build lists for the shell (scripts/build-offline-manifest.mjs) */
const SHELL_MANIFEST = `${self.location.origin}${BASE}offline-manifest.json`;
/** The record in a shell cache that says every file of its build is in it */
const SHELL_COMPLETE = "__librecorsa-shell-complete";
/** How long a page waits for the server before the shell's copy is served */
const PAGE_TIMEOUT_MS = 8000;

/** How long a check may wait for the server's answer before the kept copy is served */
const CHECK_TIMEOUT_MS = 6000;
/** A file not used for this long is dropped (a circuit taken out of the game goes this way) */
const MAX_IDLE_MS = 45 * 24 * 3600 * 1000;
/** The most the kept files may take */
const MAX_BYTES = 1024 * 1024 * 1024;
/** And at most this share of the storage quota the browser gives the site */
const QUOTA_SHARE = 0.5;
/** The clean-up runs at most this often (the time of the last one is kept with the records), and when a write nears the budget */
const SWEEP_EVERY_MS = 3600 * 1000;
/** A use is noted when the last one is older than this */
const TOUCH_EVERY_MS = 10 * 60 * 1000;
/** The record that holds when the clean-up last ran */
const SWEPT = `${self.location.origin}/__librecorsa-files-swept`;

/** `<page> <url>` for each file a page has had checked (lost when the browser stops this worker, which only means one more check) */
const checked = new Set();
let lastSweepCheck = -Infinity;
let sweeping = Promise.resolve();
/** The kept files' size at the last clean-up plus what was written since, and the budget then (unknown until one runs) */
let keptBytes = null;
let keptLimit = MAX_BYTES;
/** Each URL's record changes, one after another */
const recordChain = new Map();

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// A page asks for the shell to be brought up to its build (src/lib/service-worker.ts), once per load
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "librecorsa:sync-shell") event.waitUntil(syncShell());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Imported mods: their own cache first, then the server (`public/mods/`, the launcher's folder)
  if (url.pathname.startsWith(`${BASE}mods/`)) {
    event.respondWith(serveMod(req, url));
    return;
  }
  if (req.mode === "navigate") {
    event.respondWith(servePage(req, url));
    return;
  }
  // Next's scripts and styles never change under the same name: the shell's copy, else the server
  if (url.pathname.startsWith(`${BASE}_next/static/`)) {
    event.respondWith(serveStatic(req));
    return;
  }
  if (req.headers.has("range") || req.cache === "no-store" || req.cache === "reload") return;
  // A query string asks past the edge copy: that request is left to the network as it is
  if (url.search || !(ASSET_PATH.test(url.pathname) || TRANSCODER_PATH.test(url.pathname))) return;
  // The work after the answer (keeping a download, noting a use, the clean-up) is collected while serving it
  const later = [];
  const answer = serve(event, url.origin + url.pathname, later);
  event.respondWith(answer);
  const settle = () => Promise.all(later).catch(() => {});
  event.waitUntil(answer.then(settle, settle));
});

async function serveMod(req, url) {
  try {
    const kept = await (await caches.open(MODS)).match(url.origin + url.pathname);
    if (kept) return kept;
  } catch {
    // No cache to read: the server's copy, if it has one
  }
  return fetch(req);
}

async function serve(event, key, later) {
  if (Date.now() - lastSweepCheck >= SWEEP_EVERY_MS) {
    lastSweepCheck = Date.now();
    later.push(sweep(0, "", { ifDue: true }));
  }
  const seen = event.clientId ? `${event.clientId} ${key}` : "";
  const files = await caches.open(FILES);
  const kept = await files.match(key);
  // Downloaded past the browser's own cache: a copy from there would keep the headers of when it was stored (an older
  // server's, without X-File-Size for the loading bar), and the file would sit on disk twice
  if (!kept || !validator(kept)) return keep(later, files, key, await fetch(event.request, { cache: "no-store" }), !!kept, seen);

  if (seen && checked.has(seen)) {
    later.push(touch(key));
    return kept;
  }
  let res;
  try {
    res = await check(key, kept);
  } catch {
    // Offline, or no answer in time: the kept copy, and this page doesn't wait on this file again
    remember(seen);
    later.push(touch(key));
    return kept;
  }
  if (res.status === 304 || (res.status === 200 && sameVersion(res, kept))) {
    // A server that ignored the condition sends the whole file again: only its first bytes are read
    if (res.status === 200) res.body?.cancel().catch(() => {});
    remember(seen);
    later.push(touch(key));
    return kept;
  }
  if (res.status === 404 || res.status === 410) {
    later.push(drop(key));
    return res;
  }
  if (res.status !== 200 || res.type !== "basic") {
    // A server error: the kept copy
    res.body?.cancel().catch(() => {});
    return kept;
  }
  // A new file under the same name
  return keep(later, files, key, res, true, seen);
}

/** Asks the server whether the kept copy is current: a 304 when it is */
async function check(key, kept) {
  const headers = new Headers();
  const etag = kept.headers.get("etag");
  if (etag) headers.set("If-None-Match", etag);
  else headers.set("If-Modified-Since", kept.headers.get("last-modified"));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  try {
    // no-store: the 304 comes back here (not a copy from the browser's own cache), and a new file isn't kept twice
    return await fetch(new Request(key, { headers, cache: "no-store", credentials: "same-origin", signal: abort.signal }));
  } finally {
    // Only the wait for the answer is timed: a new file's body takes what it takes
    clearTimeout(timer);
  }
}

/** Serves a download and keeps it as it arrives (`replacing`: the copy kept under this name is out of date) */
function keep(later, files, key, res, replacing, seen) {
  const keepIt = keepable(res);
  const copy = keepIt ? res.clone() : null;
  const tally = keepIt ? res.clone() : null;
  later.push(
    (async () => {
      if (replacing) await files.delete(key);
      if (keepIt) await store(files, key, copy, tally, seen);
    })()
  );
  return res;
}

async function store(files, key, copy, tally, seen) {
  const counted = countBytes(tally);
  const declared = declaredSize(copy);
  try {
    // A size known up front makes room before the write
    if (declared && !roomFor(declared)) await sweep(declared, key, {});
    await files.put(key, copy);
  } catch (err) {
    // Out of space: whatever room it takes is made for next time (the page has its copy already)
    if (err && err.name === "QuotaExceededError") await sweep(declared || (await counted), key, { force: true });
    return;
  }
  const size = await counted;
  await updateRecord(key, size);
  remember(seen);
  if (keptBytes !== null) keptBytes += size;
  if (!roomFor(0)) await sweep(0, key, {});
}

/** Whether `need` more bytes fit the budget, going by the last clean-up (false when none has run in this worker) */
function roomFor(need) {
  return keptBytes !== null && keptBytes + need <= keptLimit;
}

/** A whole, successful same-origin response that can be checked later (an ETag or Last-Modified) */
function keepable(res) {
  if (res.status !== 200 || res.type !== "basic" || !validator(res)) return false;
  return !/no-store/i.test(res.headers.get("cache-control") || "");
}

function validator(res) {
  return res.headers.get("etag") || res.headers.get("last-modified");
}

/** Whether a 200 is the same version as the kept copy (weak and strong forms of one ETag are the same) */
function sameVersion(res, kept) {
  const a = res.headers.get("etag");
  const b = kept.headers.get("etag");
  if (a && b) return a.replace(/^W\//, "") === b.replace(/^W\//, "");
  const m = res.headers.get("last-modified");
  return !a && !b && !!m && m === kept.headers.get("last-modified");
}

/** The decoded size the server states: X-File-Size, or Content-Length on a body sent as it is */
function declaredSize(res) {
  const stated = Number(res.headers.get("x-file-size"));
  if (stated > 0) return stated;
  if (res.headers.get("content-encoding")) return 0;
  return Number(res.headers.get("content-length")) || 0;
}

async function countBytes(res) {
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return n;
      n += value.byteLength;
    }
  } catch {
    return n;
  }
}

function remember(seen) {
  if (!seen) return;
  if (checked.size > 5000) checked.clear();
  checked.add(seen);
}

// --- Records: when each file was last used, and its size ---

function recordResponse(record) {
  return new Response(JSON.stringify(record), { headers: { "Content-Type": "application/json" } });
}

async function readRecord(used, key) {
  try {
    const r = await used.match(key);
    if (!r) return null;
    const record = await r.json();
    return typeof record.used === "number" && typeof record.size === "number" ? record : null;
  } catch {
    return null;
  }
}

/**
 * Notes a use of a kept file, with its size when it was just written (`size`). A use alone is noted only on a file
 * that has a record (the clean-up gives one to a file without) and at most every TOUCH_EVERY_MS.
 */
function updateRecord(key, size) {
  const run = async () => {
    const used = await caches.open(USED);
    const now = Date.now();
    if (size === undefined) {
      const record = await readRecord(used, key);
      if (!record || now - record.used < TOUCH_EVERY_MS) return;
      size = record.size;
    }
    await used.put(key, recordResponse({ used: now, size }));
  };
  const next = (recordChain.get(key) || Promise.resolve()).then(run).catch(() => {});
  recordChain.set(key, next);
  next.then(() => {
    if (recordChain.get(key) === next) recordChain.delete(key);
  });
  return next;
}

function touch(key) {
  return updateRecord(key, undefined);
}

async function drop(key) {
  const files = await caches.open(FILES);
  const used = await caches.open(USED);
  await files.delete(key);
  await used.delete(key);
}

// --- Clean-up ---

/** The most the kept files may take now */
async function budget() {
  try {
    const { quota } = await navigator.storage.estimate();
    if (quota > 0) return Math.min(MAX_BYTES, quota * QUOTA_SHARE);
  } catch {
    // No estimate in this browser
  }
  return MAX_BYTES;
}

/**
 * One clean-up at a time. `need` bytes are about to be written for `keepKey`, which is never dropped. `force` frees
 * that much whatever the budget says (a write just ran out of space); `ifDue` skips it when one ran in the last
 * SWEEP_EVERY_MS.
 */
function sweep(need, keepKey, { force = false, ifDue = false }) {
  sweeping = sweeping.then(() => runSweep(need, keepKey, force, ifDue)).catch(() => {});
  return sweeping;
}

async function runSweep(need, keepKey, force, ifDue) {
  // Several downloads that queued a clean-up before the first one ran: the first one may have made room for all
  if (!force && !ifDue && roomFor(need)) return;
  const used = await caches.open(USED);
  const now = Date.now();
  if (ifDue) {
    const last = await readRecord(used, SWEPT);
    if (last && now - last.used < SWEEP_EVERY_MS) return;
  }
  for (const name of await caches.keys()) {
    if (name.startsWith(LEGACY_PREFIX)) await caches.delete(name);
  }
  const files = await caches.open(FILES);
  const urls = new Set((await files.keys()).map((r) => r.url));
  for (const r of await used.keys()) {
    if (r.url !== SWEPT && !urls.has(r.url)) await used.delete(r);
  }
  const entries = [];
  for (const url of urls) {
    let record = await readRecord(used, url);
    if (!record) {
      // Kept without a record (its write was cut off): counted from now
      const kept = await files.match(url);
      if (!kept) continue;
      record = { used: now, size: declaredSize(kept) || (await kept.blob()).size };
      await used.put(url, recordResponse(record));
    }
    entries.push({ url, used: record.used, size: record.size });
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  keptLimit = await budget();
  const limit = force ? Math.min(keptLimit, total) : keptLimit;
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (e.url === keepKey) continue;
    if (now - e.used <= MAX_IDLE_MS && total + need <= limit) break;
    await files.delete(e.url);
    await used.delete(e.url);
    total -= e.size;
  }
  keptBytes = total;
  await used.put(SWEPT, recordResponse({ used: now, size: 0 }));
}

// --- The shell: the game's pages and scripts, for offline play ---

/** `completeShell`'s answer while this worker runs (a sync resets it): every page and script asks */
let shellName;

/**
 * The newest whole shell cache's name, or null (none yet: the first visit, a download cut short, or no Cache Storage to
 * read). Never rejects: a page or script is then fetched as if there were no shell
 */
async function completeShell() {
  if (shellName === undefined) shellName = findCompleteShell().catch(() => (shellName = undefined, null));
  return shellName;
}

async function findCompleteShell() {
  let best = null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(SHELL_PREFIX)) continue;
    const cache = await caches.open(name);
    const mark = await cache.match(`${self.location.origin}/${SHELL_COMPLETE}`);
    if (!mark) continue;
    const { at } = await mark.json().catch(() => ({ at: 0 }));
    if (!best || at > best.at) best = { name, at };
  }
  return best ? best.name : null;
}

/**
 * A page's shell copy: `/play`, `/play/` and `/play.html` are one page, as are `/` and `/index.html`. Made anonymous,
 * so the page keeps the address it was opened at (`/play?mods=off`, a room link), not the one it was kept under
 */
async function shellPage(url) {
  try {
    const name = await completeShell();
    if (!name) return null;
    const cache = await caches.open(name);
    const root = BASE.replace(/\/+$/, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const forms = path === root || path === "/" || path === `${root}/index.html` ? [BASE, `${BASE}index.html`] : [path, `${path}.html`, path.replace(/\.html$/, "")];
    for (const form of forms) {
      const hit = await cache.match(self.location.origin + form, { ignoreVary: true });
      if (hit) return anonymous(hit);
    }
  } catch {
    // No Cache Storage to read: no shell
  }
  return null;
}

/** Lets a response nobody will read go, so its connection isn't held open */
const discard = (res) => void res?.body?.cancel().catch(() => {});

/** The server's page when it answers; the shell's when it doesn't, or not within PAGE_TIMEOUT_MS */
async function servePage(req, url) {
  const network = fetch(req);
  // Raced, never aborted: a navigation's own request is passed on as it is (its redirect handling included)
  network.catch(() => {});
  let timer;
  const slow = new Promise((resolve) => (timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS)));
  try {
    const res = await Promise.race([network, slow]);
    if (res === null) {
      const copy = await shellPage(url);
      if (!copy) return await network;
      // The server's answer, when it comes, isn't needed
      network.then(discard, () => {});
      return copy;
    }
    // A server error with a shell copy at hand: the copy
    if (res.status >= 500) {
      const copy = await shellPage(url);
      if (copy) {
        discard(res);
        return copy;
      }
    }
    return res;
  } catch (err) {
    const copy = await shellPage(url);
    if (copy) return copy;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A response made here, with no URL of its own: a worker started from it keeps the URL it was asked for, fragment and
 * query included. Turbopack's worker bootstrap reads its config from there (`#params=`); a kept or fetched response
 * carries the URL it was stored or fetched under, without them, and the worker would start without its config.
 */
const anonymous = (res) => {
  // Its body is already decoded: it no longer is what these described
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

async function serveStatic(req) {
  const worker = req.destination === "worker" || req.destination === "sharedworker";
  try {
    const name = await completeShell();
    if (name) {
      // Next may add a query to its script URLs (a deployment id): the file is the same. Looked up by its address
      // alone, as the sync stored it (a header the request carries and a Vary names would miss it)
      const url = new URL(req.url);
      const hit = await (await caches.open(name)).match(url.origin + url.pathname, { ignoreSearch: true, ignoreVary: true });
      if (hit) return worker || url.search ? anonymous(hit) : hit;
    }
  } catch {
    // No Cache Storage to read: the server's copy
  }
  const res = await fetch(req);
  return worker && res.ok ? anonymous(res) : res;
}

let syncing = null;

/**
 * Brings the shell up to the build the server lists: every file of it in a new cache (a file the last build had
 * under the same name, a hashed script, is copied over rather than downloaded again), then the older caches go. A
 * download cut short leaves the last whole shell in use, and the next page load carries on where it stopped.
 */
function syncShell() {
  syncing = syncing || runSync().catch(() => {}).finally(() => (syncing = null));
  return syncing;
}

/** The build the server lists now, or null (no manifest: `next dev`, an older deploy) */
async function listedShell() {
  const res = await fetch(SHELL_MANIFEST, { cache: "no-store" });
  if (!res.ok) return null;
  const manifest = await res.json();
  return manifest && typeof manifest.build === "string" && Array.isArray(manifest.files) ? manifest : null;
}

async function runSync() {
  const manifest = await listedShell();
  if (!manifest) return;
  const name = SHELL_PREFIX + manifest.build;
  const current = await completeShell();
  if (current === name) return;
  // A build that never finished downloading (the player went offline, a deploy came first) is of no use now
  for (const other of await caches.keys()) {
    if (other.startsWith(SHELL_PREFIX) && other !== name && other !== current) await caches.delete(other);
  }
  try {
    await fillShell(name, current, manifest);
  } catch (err) {
    // Out of space: this build's files go (the last whole shell stays), and the next load tries again
    if (err && err.name === "QuotaExceededError") await caches.delete(name);
    throw err;
  }
}

async function fillShell(name, current, manifest) {
  const cache = await caches.open(name);
  const previous = current ? await caches.open(current) : null;
  for (const file of manifest.files) {
    if (typeof file !== "string" || !file.startsWith("/")) continue;
    const url = self.location.origin + BASE + file.slice(1);
    if (await cache.match(url)) continue;
    // Hashed files are the same file under the same name; pages change with every build
    const reuse = previous && file.startsWith("/_next/static/") ? await previous.match(url) : null;
    if (reuse) {
      await cache.put(url, reuse);
      continue;
    }
    // A script may come from the browser's own cache (the page just loaded it); a page is checked with the server
    const got = await fetch(url, { cache: file.startsWith("/_next/static/") ? "default" : "no-cache", credentials: "same-origin" });
    if (!got.ok || got.type !== "basic") throw new Error(`${file}: HTTP ${got.status}`);
    // A page the server redirected to can't answer a navigation as it is: kept as a response of its own
    await cache.put(url, got.redirected ? anonymous(got) : got);
  }
  // A deploy while this ran may have sent the new build's pages with the old build's scripts: whole only if not
  const now = await listedShell();
  if (!now || now.build !== manifest.build) {
    // Gone, so a later sync of this build (a deploy rolled back) never builds on the other build's pages
    await caches.delete(name);
    throw new Error("the build changed while its shell downloaded");
  }
  await cache.put(`${self.location.origin}/${SHELL_COMPLETE}`, new Response(JSON.stringify({ at: Date.now() }), { headers: { "Content-Type": "application/json" } }));
  shellName = Promise.resolve(name);
  for (const other of await caches.keys()) {
    if (other.startsWith(SHELL_PREFIX) && other !== name) await caches.delete(other);
  }
}
