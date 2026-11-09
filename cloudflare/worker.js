/**
 * librecorsa.org Worker. Static files from ./out are served before this runs; it only sees POST /__migrate and
 * requests with no static file behind them.
 *
 * Cloudflare's asset store takes files up to 25 MiB. CI moves anything bigger (large circuit GLBs) into the
 * librecorsa-assets R2 bucket under the same path, and this serves it from there, so the game fetches it
 * from the usual same-origin URL. Anything not in the bucket either gets the site's 404 page.
 *
 * Workers caching is on (wrangler.jsonc): Cloudflare keeps those files at the edge, tiered, and answers repeat and
 * byte-range requests without running this or reading R2. Each deploy is a fresh cache (the Worker version is part of
 * the key), and CI uploads to R2 before it deploys, so a re-uploaded file is never served stale. Browsers still check
 * the ETag before reusing their copy.
 *
 * The game used to live at https://khazp.github.io/librecorsa/, and browsers keep saved data per origin, so
 * settings, garage setups, ghost laps and the leaderboard driver key stayed behind there. The redirect page
 * that now sits at the old address (cloudflare/old-site-redirect.html) gathers that data and POSTs it here as a
 * top-level form submission. This answers with a page that writes it into librecorsa.org's storage, keeping
 * anything already saved here, then continues to the page the player asked for.
 *
 * Only POSTs from the old origin are accepted, and only the game's own keys are imported.
 */

const OLD_ORIGIN = "https://khazp.github.io";
// localStorage keys the game writes (bugesera.* settings/track/car/driver key, lc.* garage and MFD, librecorsa.* AI learning)
const KEY_PREFIXES = ["bugesera.", "lc.", "librecorsa."];
const MAX_PAYLOAD_CHARS = 60 * 1024 * 1024;
const MAX_LAPS = 2000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__migrate") return migrate(request);
    if (request.method === "GET" || request.method === "HEAD") {
      const large = await fromBucket(request, env, url);
      if (large) return large;
    }
    return notFound(env, url);
  },
};

async function notFound(env, url) {
  const page = await env.ASSETS.fetch(new URL("/404.html", url));
  const headers = new Headers(page.headers);
  // Not kept at the edge: a path that 404s now may be a file the next upload adds
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  return new Response(page.body, { status: 404, headers });
}

/** A file CI moved to R2, with ETag revalidation and byte ranges; null when the bucket has no such file */
async function fromBucket(request, env, url) {
  let key;
  try {
    key = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!key || key.endsWith("/")) return null;

  const object =
    request.method === "HEAD"
      ? await env.LARGE_ASSETS.head(key)
      : await env.LARGE_ASSETS.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // Browsers: same policy as the static files, cache but check the ETag before reuse. The edge keeps it until the next
  // deploy (a new Worker version starts an empty cache); Cloudflare reads this header and strips it
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("Cloudflare-CDN-Cache-Control", "public, max-age=31536000");

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(object.size));
    return new Response(null, { headers });
  }
  // A failed precondition (If-None-Match matched) comes back without a body
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });

  if (object.range && request.headers.has("Range")) {
    const offset = object.range.offset ?? (object.range.suffix != null ? object.size - object.range.suffix : 0);
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

function home(to = "/") {
  return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
}

/** A same-site path to continue to; anything else (absolute or protocol-relative URLs) falls back to the home page */
function safePath(value) {
  if (typeof value !== "string" || value.length > 4096) return "/";
  // Resolve it the way a browser would (the URL parser drops tabs and newlines, and reads "\\" as "/"), and keep it
  // only if it stays on this origin: "/\t/evil.example" would otherwise pass a prefix check and land off-site
  const base = "https://same-origin.invalid";
  let url;
  try {
    url = new URL(value, base);
  } catch {
    return "/";
  }
  if (url.origin !== base || !value.startsWith("/")) return "/";
  return url.pathname + url.search + url.hash;
}

/** The parts of the posted payload worth importing: string values under the game's keys and keyed lap records */
function cleanPayload(raw) {
  const out = { local: {}, laps: [] };
  if (typeof raw !== "string" || raw.length > MAX_PAYLOAD_CHARS) return out;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (data && typeof data.local === "object" && data.local) {
    for (const [key, value] of Object.entries(data.local)) {
      if (typeof value === "string" && KEY_PREFIXES.some((p) => key.startsWith(p))) out.local[key] = value;
    }
  }
  if (Array.isArray(data?.laps)) {
    for (const entry of data.laps.slice(0, MAX_LAPS)) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object") {
        out.laps.push(entry);
      }
    }
  }
  return out;
}

/** JSON that is safe inside a <script> element */
const scriptJson = (value) =>
  JSON.stringify(value).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

async function migrate(request) {
  if (request.method !== "POST") return home();
  let form;
  try {
    form = await request.formData();
  } catch {
    return home();
  }
  // Only the old site may hand over a destination; anything else goes home
  if (request.headers.get("Origin") !== OLD_ORIGIN) return home();
  const to = safePath(form.get("to"));
  const payload = cleanPayload(form.get("payload"));

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>LibreCorsa</title>
<style>html,body{margin:0;height:100%;background:#07070c;color:#c9c9d4;font:14px system-ui,sans-serif;display:grid;place-items:center}</style>
</head><body><p>Bringing your settings and laps over…</p>
<script id="lc-data" type="application/json">${scriptJson({ ...payload, to })}</script>
<script>
(function () {
  var d = JSON.parse(document.getElementById("lc-data").textContent);
  var done = false;
  function go() { if (!done) { done = true; location.replace(d.to); } }
  setTimeout(go, 8000);
  try {
    Object.keys(d.local).forEach(function (k) { if (localStorage.getItem(k) === null) localStorage.setItem(k, d.local[k]); });
  } catch (e) {}
  if (!d.laps.length || typeof indexedDB === "undefined") return go();
  try {
    // Same database the game opens (src/lib/sim/ghost-store.ts); a lap already saved here is kept
    var req = indexedDB.open("bugesera-laps", 1);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains("bestLaps")) req.result.createObjectStore("bestLaps");
    };
    req.onerror = go;
    req.onblocked = go;
    req.onsuccess = function () {
      var db = req.result;
      try {
        var tx = db.transaction("bestLaps", "readwrite");
        var store = tx.objectStore("bestLaps");
        d.laps.forEach(function (entry) {
          var c = store.count(entry[0]);
          c.onsuccess = function () { if (c.result === 0) store.put(entry[1], entry[0]); };
        });
        tx.oncomplete = function () { db.close(); go(); };
        tx.onerror = tx.onabort = function () { db.close(); go(); };
      } catch (e) { go(); }
    };
  } catch (e) { go(); }
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
